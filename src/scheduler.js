import path from 'node:path';
import { addLog, parseRule, getSetting } from './db.js';
import { renderTemplate } from './template.js';
import * as mlDefault from './ml.js';
import { imagemPermitida } from './lojas.js';
import { motivosDeRevisao, precisaEtiqueta } from './catalogo.js';
import { createEnvios } from './envios.js';
import { createAvisos } from './avisos.js';
import { createEspelho } from './espelho.js';
import { agrupar, registrar as registrarRastreio } from './rastreio.js';
import { createRemetentes } from './remetentes.js';
import { createRotinas } from './rotinas.js';
import { createRitmo, pausaGrupoGravada, pausaOfertaGravada } from './ritmo.js';
import { proximoHorario, horarioDe, resolverVencido, proximoEnvio, qtdDaLinha, templateDaLinha } from './grade.js';
import { sleep, jitter, inWindow, alignToWindow } from './util.js';
import { PAUSA_DESCARTADA_H, MOTIVOS_VERIFICADOR, CAUSAS } from './verificador.js';

// Pausas entre mensagens e horário de funcionamento: moram em ./util.js (src/envios.js usa o mesmo ritmo anti-bloqueio);
// reexportados aqui.
export { sleep, jitter, inWindow, alignToWindow };

// Fonte "catalogo" (plano fonte-catalogo-etiqueta, etapa 4)
const LOJAS_CATALOGO = new Set(['ml', 'amazon', 'shopee']);
const SONDA_ASIN = 'B000000000'; // montarLink com um ASIN de sonda diz se há tag da Amazon salva, sem rede
const LINK_ML_PREVIA = 'https://meli.la/(gerado no envio)';
/** Motivos de revisão (src/catalogo-itens.js MOTIVOS) no Histórico. */
const TEXTO_MOTIVO = {
  shopee: 'Shopee, confirme o link', desconto_100: 'desconto de 100%, confira o preço',
  preco_antigo: 'preço antigo muito alto, confira o preço', falha_link: 'não consegui gerar o link',
  nao_conferido: 'não deu para conferir o preço',
};
/** Por que ofertas do catálogo esperam (não vão à revisão nem contam como enviadas): aviso a cada execução. */
const TEXTO_ESPERA = {
  ml_direto: 'do Mercado Livre esperando: os links estão no modo direto, sem comissão. Volte ao modo da extensão em Ajustes.',
  ml_extensao: 'do Mercado Livre esperando a extensão do Chrome conectar.',
  etiqueta: 'do Mercado Livre esperando: escolha uma etiqueta na regra.',
  amazon: 'da Amazon esperando: falta a tag de associado em Conexões → Amazon.',
  revisao_cheia: 'esperando: a revisão desta regra está cheia. Revise ou descarte as ofertas pendentes.',
};
const qtdOfertas = (n) => `${n} ${n === 1 ? 'oferta' : 'ofertas'}`;
// Verificador (plano verificador-preco-estoque, D6): a oferta descartada fica fora da escolha da regra por um tempo
const PAUSA_DESCARTADA_MS = PAUSA_DESCARTADA_H * 3600000;

// Grade de horários (plano grade-de-disparos, D3 e D4): textos do Histórico
const pad2 = (n) => String(n).padStart(2, '0');
const horaDe = (ts) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const mesmoDia = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
/** "10:00" se for no dia de `agora`; senão "10:00 de 03/11". */
const quandoDe = (ts, agora) => {
  if (mesmoDia(ts, agora)) return horaDe(ts);
  const d = new Date(ts);
  return `${horaDe(ts)} de ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
};
const MOTIVO_PULADO = 'o programa estava desligado, o WhatsApp desconectado ou outro envio demorou.';

// Proteção do número (plano anti-banimento, etapa 4): textos do Histórico, todos 'aviso' (nunca 'erro', que alerta)
const textoAdiadoSilencio = (s, ate) => `Horário de silêncio (${s.de} às ${s.ate}): disparo adiado para as ${horaDe(ate)}.`;
const textoPuladoSilencio = (horario) => `Horário ${horaDe(horario)} pulado: horário de silêncio.`;
/** "Enviar agora" barrado antes de começar: o silêncio (frase do plano) ou o teto já cheio. */
const textoEnviarAgoraBarrado = (r) => (r.motivo === 'silencio'
  ? `Enviar agora não saiu: horário de silêncio até ${horaDe(r.ate)}.`
  : `Enviar agora não saiu: limite de ${r.limite} mensagens por hora atingido; há vaga a partir das ${horaDe(r.ate)}.`);
/** Fim da frase "saíram x de y ofertas" de um horário da grade interrompido pela proteção. */
const motivoDaParada = (r) => (r.motivo === 'silencio' ? 'começou o horário de silêncio' : `o limite de ${r.limite} mensagens por hora encheu`);
/**
 * Aviso de horário perdido (CA6): um ou vários pulados e o que vem em seguida. `saiAgora`: o horário seguinte já
 * venceu e vai sair neste tick (com o WhatsApp fora, ele só fica marcado como o próximo).
 */
function textoPulados(pulados, { seguinte, saiAgora }, agora) {
  const quais = pulados.length === 1 ? `Horário ${quandoDe(pulados[0], agora)} pulado`
    : `${pulados.length} horários pulados (${quandoDe(pulados[0], agora)} a ${quandoDe(pulados.at(-1), agora)})`;
  const depois = seguinte == null ? '' : saiAgora ? ` O das ${horaDe(seguinte)} sai agora.` : ` Próximo: ${quandoDe(seguinte, agora)}.`;
  return `${quais}: ${MOTIVO_PULADO}${depois}`;
}

/**
 * Agendador único: regras, envios avulsos (F1/F2), espelhamento da Amazon e avisos (F3) passam pelo mesmo tick,
 * para não dobrar a taxa de mensagens. `dir` é a pasta de dados (fotos dos envios). `amazon`: o cliente único de
 * src/amazon.js (createAmazon, criado em src/server.js); sem ele, a fila de envios recusa oferta da Amazon e o
 * espelho marca os itens com o motivo. `shopee`: o cliente único de src/shopee.js (createShopee, também criado em
 * src/server.js), só para a fila de envios (o espelho não trata a Shopee); sem ele, a fila recusa oferta da Shopee.
 * O espelho só decide: o que ele manda sair vai pela fila de envios.
 * `catalogo` e `catalogoItens`: o cliente do Etiqueta (src/catalogo.js, createCatalogo) e o registro do que cada
 * regra já tratou com a fila de revisão (src/catalogo-itens.js, createCatalogoItens), criados em src/server.js; sem
 * os dois, a fonte "catalogo" das regras falha como indisponível (as outras fontes seguem).
 * Remetentes (src/remetentes.js, plano envio-pelo-socio D9): o ouvinte privado do WhatsApp (ligado em src/server.js)
 * entrega a remetentes.receber(); o tick responde às mensagens já decididas e decide os itens recebidos logo depois
 * do espelho, e o que sai vai pela mesma fila de envios.
 * Grupo vivo (src/rotinas.js, plano grade-de-disparos D7): no horário, cada rotina ligada grava uma ocorrência 'agora'
 * na mesma fila de envios e acorda o tick; o passo das rotinas roda antes das regras e depois de cada regra.
 * `verificador` (src/verificador.js, createVerificador; plano verificador-preco-estoque D1 e D9): confere preço e
 * estoque de cada oferta da regra logo antes de gerar o link, e vai também à fila de envios. null = nada é conferido.
 */
export function createScheduler({ db, wa: waBruto, links, ml = mlDefault, fast = false, dir = null, amazon = null, shopee = null, magalu = null, catalogo = null, catalogoItens = null, verificador = null, ritmo = null }) {
  // Proteção do número (plano anti-banimento, ADR-012): todo módulo daqui recebe o `wa` embrulhado, que conta cada
  // mensagem no teto e espera a pausa mínima entre quaisquer duas (regra, fila, avisos, resposta ao remetente). Teto e
  // silêncio são perguntados (ritmo.liberado) só por quem manda a grupos: as regras (aqui) e a fila (envios.js).
  ritmo ??= createRitmo({ db, fast });
  const wa = ritmo.embrulhar(waBruto);
  const running = new Set();
  let timer = null; let primeiro = null; let ticking = false; let recuperacao = null;
  let acordado = false; // um "agora" chegou com o tick em andamento: ele passa nos envios de novo antes de terminar
  // O "agora" não envia por conta própria: grava pendente e acorda o tick, que manda um envio de cada vez (S14)
  const envios = createEnvios({ db, wa, links, ml, fast, dir, acordar, amazon, shopee, magalu, verificador, ritmo });
  const avisos = createAvisos({ db, wa, estadoBackup: dir && path.join(dir, 'backup-estado.json') });
  // receber() (ouvinte do WhatsApp) e cada envio que o espelho cria chamam acordar(): a oferta sai neste tick
  const espelho = createEspelho({ db, wa, amazon, envios, acordar });
  // idem para a mensagem privada de um remetente cadastrado (receber) e para cada envio que ela cria
  const remetentes = createRemetentes({ db, wa, envios, acordar });
  // rotinas do Grupo vivo: a ocorrência vencida grava um envio 'agora' e acorda o tick (sai no laço "acordado")
  // o "Enviar agora" do Grupo vivo é recusado no horário de silêncio (achado R2): a rotina pergunta ao mesmo ritmo
  const rotinas = createRotinas({ db, wa, envios, acordar, silencio: (now) => ritmo.silencio(now) });

  const getRule = (id) => parseRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(id));
  // presas entre o mínimo e o máximo da proteção também na leitura (achado S2): valor gravado à mão não vale
  const delays = () => fast ? { group: 0, offer: 0 } : {
    group: pausaGrupoGravada(getSetting(db, 'delay_group_s', 6)),
    offer: pausaOfertaGravada(getSetting(db, 'delay_offer_s', 30)),
  };
  const log = (rule, o) => addLog(db, { rule, ...o });
  // avisarLimite (src/ritmo.js) entrega a linha já pronta ({ rule, level, message }), não o par (rule, o) de log()
  const logLinha = (linha) => addLog(db, linha);
  const tplOpts = () => ({ tituloMax: Number(getSetting(db, 'titulo_max', 60)) });

  function wasSent(rule, key) {
    if (!rule.dedupe_days) return false;
    const since = Date.now() - rule.dedupe_days * 86400000;
    return !!db.prepare('SELECT 1 FROM sent_offers WHERE rule_id = ? AND offer_key = ? AND sent_at > ? LIMIT 1').get(rule.id, key, since);
  }

  // ---------- verificador de preço e estoque (plano verificador-preco-estoque, D1, D3, D6 a D8)
  // Ofertas descartadas pelo verificador: "regra\0chave" → até quando ficam fora da escolha da regra (só em memória)
  const descartadas = new Map();
  const chavePausa = (rule, key) => `${rule.id}\0${key}`;
  function pausada(rule, key) {
    const ate = descartadas.get(chavePausa(rule, key));
    if (ate == null) return false;
    if (ate > Date.now()) return true;
    descartadas.delete(chavePausa(rule, key));
    return false;
  }
  function pausar(rule, key) {
    const agora = Date.now();
    for (const [k, ate] of descartadas) if (ate <= agora) descartadas.delete(k); // sem crescer para sempre
    descartadas.set(chavePausa(rule, key), agora + PAUSA_DESCARTADA_MS);
  }

  /**
   * Confere a oferta da regra logo antes do link (D1). As fontes antigas são do Mercado Livre; o catálogo manda a
   * própria loja. Sem verificador → enviar como veio. Nunca lança: um descarte não para as outras ofertas (D6).
   * → { acao: 'enviar', oferta, sufixo } | { acao: 'descartar', motivo, texto }
   */
  async function conferirDaRegra(offer) {
    if (!verificador) return { acao: 'enviar', oferta: offer, sufixo: null };
    try {
      const { lidoEm = null, ...oferta } = offer;
      const r = await verificador.conferir(offer.catalogo ? oferta : { ...oferta, loja: 'mercadolivre' }, { lidoEm });
      if (r?.acao === 'enviar' && r.oferta && typeof r.oferta === 'object') return { acao: 'enviar', oferta: r.oferta, sufixo: typeof r.sufixo === 'string' && r.sufixo ? r.sufixo : null };
      if (r?.acao === 'descartar' && Object.hasOwn(MOTIVOS_VERIFICADOR, r.motivo)) {
        return { acao: 'descartar', motivo: r.motivo, texto: typeof r.texto === 'string' && r.texto ? r.texto : MOTIVOS_VERIFICADOR[r.motivo] };
      }
    } catch (e) { console.error('[agendador] verificador:', e?.name || 'erro'); }
    // resposta fora do contrato (o conferir nunca lança): sem conferência, não sai (D3)
    return { acao: 'descartar', motivo: 'nao_conferido', texto: `${MOTIVOS_VERIFICADOR.nao_conferido} (${CAUSAS.loja_fora})` };
  }

  // ---------- fonte "catalogo" (D4 a D9 do plano fonte-catalogo-etiqueta)
  const fonteCatalogo = catalogo && catalogoItens ? catalogo : null;
  const fontesDa = (rule) => (rule.sources?.length ? rule.sources : [{ type: rule.source_type }]);
  const doCatalogo = (rule, c) => fontesDa(rule)[c.source_index ?? 0]?.type === 'catalogo';

  function temTagAmazon() {
    if (typeof amazon?.montarLink !== 'function') return false;
    try { amazon.montarLink(SONDA_ASIN); return true; } catch { return false; }
  }

  /** O Mercado Livre gera link de afiliado agora? null = sim; senão o motivo da espera (modo direto = link comum, CA4). */
  function esperaDoMl() {
    const modo = links?.modo?.();
    if (modo === 'fake') return null;
    if (modo === 'extension') return links.status?.().online ? null : 'ml_extensao';
    return 'ml_direto';
  }

  /** Loja da oferta do catálogo indisponível agora (espera, sem revisão)? A Shopee sai só pela revisão: nunca espera. */
  const esperaDaLoja = (c) => (c.loja === 'ml' ? esperaDoMl() : c.loja === 'amazon' && !temTagAmazon() ? 'amazon' : null);

  /**
   * Link de afiliado de uma oferta do catálogo (D4): ML gerado de novo pela extensão com a etiqueta (nunca o do
   * Etiqueta); Amazon remontada com a tag de Conexões. → { link } | { espera } (loja indisponível) | { falha }.
   */
  async function linkDoCatalogo(offer, etq) {
    if (offer.loja === 'amazon') {
      if (!temTagAmazon()) return { espera: 'amazon' };
      try { return { link: amazon.montarLink(offer.asin) }; } catch { return { falha: 'link da Amazon inválido' }; }
    }
    if (offer.loja !== 'ml') return { falha: 'loja sem link automático' };
    const antes = esperaDoMl();
    if (antes) return { espera: antes };
    if (!etq) return { espera: 'etiqueta' };
    try { return { link: await links.requestLink({ url: offer.url, tag: etq.name }) }; } catch (e) {
      const depois = esperaDoMl(); // a extensão caiu no meio: espera, não vai à revisão (P8)
      return depois ? { espera: depois } : { falha: e?.message || 'erro' };
    }
  }

  // ---------- rastreio por grupo (plano dashboard-ganhos, etapa 8: D1, D4, D6; CA1, CA3, CA4, CA9)
  /** Loja da oferta no rastreio (src/rastreio.js): as fontes antigas são do Mercado Livre; null = sem link automático. */
  const lojaDaOferta = (o) => (!o.catalogo || o.loja === 'ml' ? 'mercadolivre' : o.loja === 'amazon' ? 'amazon' : null);
  const tagDoLink = (link) => { try { return new URL(link).searchParams.get('tag'); } catch { return null; } };
  const ATRIBUIDO = new Set(['grupo', 'bloco']);

  /**
   * Link de afiliado de um código: ML pela extensão com a etiqueta `codigo` (catálogo: as mesmas esperas de
   * linkDoCatalogo); Amazon do catálogo montada do ASIN com a tag de Conexões (`padrao`) ou com o ID de
   * rastreamento `codigo`, que precisa casar com o formato da tag (nunca sai sem tag, CA3).
   * → { link } | { espera } | { falha } (a falha da Amazon não repete o código recusado).
   */
  async function linkDoCodigo(offer, etq, codigo, padrao) {
    if (offer.catalogo && offer.loja === 'amazon') {
      if (padrao) return linkDoCatalogo(offer, etq);
      try { return { link: amazon.montarLink(offer.asin, { tag: codigo }) }; } catch { return { falha: 'ID de rastreamento da Amazon recusado' }; }
    }
    if (offer.catalogo) return linkDoCatalogo(offer, codigo ? { name: codigo } : null);
    if (!codigo) return { falha: 'escolha uma etiqueta' }; // nunca pede link sem etiqueta
    try { return { link: await links.requestLink({ url: offer.url, tag: codigo }) }; } catch (e) { return { falha: e.message }; }
  }

  /**
   * Links de uma oferta, um por código de rastreio distinto entre os grupos (D1), na ordem do primeiro grupo de
   * cada código. A associação do grupo/bloco vence a etiqueta da regra e a da fonte (P1). Sem associação: um
   * pedido só, como antes (CA9). Código associado que falha → o link padrão de hoje, com esperado=1 e motivo
   * 'falha_link' (D4: nunca link comum); o padrão que falha deixa sem link só os grupos que dependem dele.
   * → { espera } | { porJid: Map(jid → destino), algum, falha, avisos }, destino = { link, codigo, nivel,
   * bloco_id, esperado, motivo } ou { falha } (sem link). `falha`: a do padrão (ou a primeira), para quando
   * nenhum grupo tem link.
   */
  async function linksPorCodigo(offer, etq, jids) {
    const loja = lojaDaOferta(offer);
    const codigoPadrao = loja === 'mercadolivre' ? etq?.name ?? null : null; // Amazon: a tag sai do link montado
    const soPadrao = [{ codigo: codigoPadrao, nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null, jids }];
    let entradas = soPadrao;
    if (loja) {
      // falha do banco no rastreio não segura o envio: sai como sem associação (só o código no console)
      try { entradas = agrupar(db, { loja, jids, padrao: codigoPadrao }); } catch (e) { console.error('[agendador] rastreio (códigos):', e?.code || e?.name || 'erro'); }
    }
    // reaproveita o link pelo código (duas entradas podem ter o mesmo); a tag de Conexões da Amazon tem chave própria
    const gerados = new Map();
    const gerar = async (codigo, padrao) => {
      const chave = loja === 'amazon' ? (padrao ? null : `id:${codigo}`) : codigo;
      if (!gerados.has(chave)) gerados.set(chave, await linkDoCodigo(offer, etq, codigo, padrao));
      return gerados.get(chave);
    };
    const porJid = new Map(); const avisos = []; let primeira = null; let algum = false;
    for (const e of entradas) {
      let destino = { codigo: e.codigo, nivel: e.nivel, bloco_id: e.bloco_id, esperado: e.esperado, motivo: e.motivo };
      let r = await gerar(e.codigo, !ATRIBUIDO.has(e.nivel));
      if (r.espera) return { espera: r.espera };
      if (!r.link && ATRIBUIDO.has(e.nivel)) {
        const falhou = r.falha;
        r = await gerar(codigoPadrao, true);
        if (r.espera) return { espera: r.espera };
        destino = { codigo: codigoPadrao, nivel: 'padrao', bloco_id: null, esperado: 1, motivo: 'falha_link' };
        if (r.link) {
          avisos.push(loja === 'amazon'
            ? `Rastreio: o ID de rastreamento do ${e.nivel} foi recusado; ${e.jids.length === 1 ? 'o grupo recebeu' : 'os grupos receberam'} o link com a sua tag.`
            : `Rastreio: a etiqueta ${e.codigo} não gerou o link (${falhou}); ${e.jids.length === 1 ? 'o grupo recebeu' : 'os grupos receberam'} o da etiqueta ${codigoPadrao}.`);
        }
      }
      if (r.link) {
        algum = true;
        if (loja === 'amazon' && destino.nivel === 'padrao') destino.codigo = tagDoLink(r.link);
        for (const jid of e.jids) porJid.set(jid, { ...destino, link: r.link });
      } else {
        primeira ??= r.falha;
        for (const jid of e.jids) porJid.set(jid, { falha: r.falha });
      }
    }
    const chavePadrao = loja === 'amazon' ? null : codigoPadrao;
    return { porJid, algum, avisos, falha: gerados.get(chavePadrao)?.falha ?? primeira };
  }

  /** Linha de rastreio_envios do grupo que recebeu (D6, CA1). Nunca lança: o envio já saiu (no console só o código). */
  function registrarEnvio(rule, offer, jid, destino) {
    const loja = lojaDaOferta(offer);
    if (!loja) return;
    try {
      registrarRastreio(db, {
        jid, loja, origem: 'regra', rule_id: rule.id, oferta_chave: offer.key, link: destino.link, codigo: destino.codigo,
        nivel: destino.nivel, bloco_id: destino.bloco_id, esperado: destino.esperado, motivo: destino.motivo,
      });
    } catch (e) { console.error('[agendador] rastreio (registro):', e?.code || e?.name || 'erro'); }
  }

  /** Como o link saiu, no Histórico. Da Amazon nunca vai a tag nem o ID de rastreamento. */
  function comoSaiu(offer, destino) {
    if (offer.catalogo && offer.loja === 'amazon') {
      return ATRIBUIDO.has(destino.nivel) ? `Enviado pela Amazon, com o ID de rastreamento do ${destino.nivel}` : 'Enviado pela Amazon, com a sua tag';
    }
    return `Enviado com a etiqueta ${destino.codigo}`;
  }

  /**
   * Estado de uma execução: o que o catálogo leu (para o cursor), o que os filtros da regra recusaram, o que esperou
   * e as chaves que cada fonte trouxe (vistas: o catálogo conta a de outra fonte como tratada, R11).
   */
  const novaExecucao = () => ({ paginas: new Map(), recusadas: new Set(), esperando: new Map(), vistas: new Set() });
  // a regra apagada no meio da execução não grava nada do catálogo: o id pode ser reaproveitado por uma regra nova
  const regraExiste = (id) => !!db.prepare('SELECT 1 FROM rules WHERE id = ?').get(id);
  const esperar = (exec, motivo) => exec.esperando.set(motivo, (exec.esperando.get(motivo) || 0) + 1);

  /**
   * Fim da execução de uma regra com catálogo: um aviso por motivo de espera e o cursor de cada fonte "Novidades"
   * (avancar: as recusadas pelos filtros contam como tratadas). Nunca lança: o finally do runRule segue.
   */
  function fecharCatalogo(rule, exec) {
    try {
      for (const [motivo, n] of exec.esperando) {
        log(rule, { level: 'aviso', message: `Catálogo do Etiqueta: ${qtdOfertas(n)} ${TEXTO_ESPERA[motivo]}` });
      }
    } catch (e) { console.error('[agendador] catálogo (aviso):', e?.code || e?.name || 'erro'); }
    if (!fonteCatalogo || !exec.paginas.size) return;
    try {
      fonteCatalogo.avancar(rule.id, exec.paginas, (c, modo) => exec.recusadas.has(c.key) || catalogoItens.tratada(rule, c, modo));
    } catch (e) {
      // só o código: erro do banco pode trazer valores da query
      console.error('[agendador] catálogo (cursor):', e?.code || e?.name || 'erro');
      try { log(rule, { level: 'erro', message: 'Catálogo do Etiqueta: não consegui guardar até onde a regra leu; a próxima execução relê as mesmas ofertas.' }); } catch { /* banco fora */ }
    }
  }

  /**
   * A regra usaria esta oferta do catálogo agora? Os mesmos filtros do pickOffers: loja conhecida, filtros de preço e
   * desconto da regra, loja disponível (sem espera) e, se ela iria à revisão, revisão com vaga. Só as utilizáveis
   * contam para o alvo da leitura do catálogo (Q4, Q5): as que seriam recusadas ou esperariam não prendem a leitura
   * nas primeiras páginas. A revisão cheia é lida uma vez por execução (nada é registrado durante a escolha).
   */
  function utilizavelNa(rule) {
    let cheia = null;
    return (c) => {
      if (!LOJAS_CATALOGO.has(c?.loja) || ml.rejectReason(c, rule) || esperaDaLoja(c)) return false;
      if (!motivosDeRevisao(c).length) return true;
      cheia ??= catalogoItens.revisaoCheia(rule.id);
      return !cheia;
    };
  }

  /**
   * Escolhe as próximas ofertas da regra (sem enviar nada nem gravar no banco). `exec` (novaExecucao) recebe o que
   * o catálogo leu, as recusadas pelos filtros e as que esperam. Oferta do catálogo: já vem completa (sem
   * resolveOffer) e sem as tratadas, não conta em maxTries; sai com `catalogo: true` e `motivos` de revisão.
   * `previa`: pré-visualização (o catálogo não faz a primeira leitura até o fim nem escreve avisos, S3).
   * Cada oferta sai com `lidoEm` (D7, a idade dos dados para a regra do frescor do verificador): o instante de antes da
   * leitura das fontes; null no catálogo e na lista com preço digitado (idade desconhecida). A descartada pelo
   * verificador há menos de PAUSA_DESCARTADA_H fica fora da escolha (D6).
   */
  async function pickOffers(rule, want, exec = novaExecucao(), { previa = false } = {}) {
    const lidoEm = Date.now();
    const cands = await ml.candidates(rule, {
      links, onWarn: (m) => log(rule, { level: 'aviso', message: m }),
      catalogo: fonteCatalogo, quer: want, paginas: exec.paginas, vistas: exec.vistas, previa,
      tratada: (c, modo) => catalogoItens.tratada(rule, c, modo),
      utilizavel: fonteCatalogo ? utilizavelNa(rule) : undefined,
    });
    const picked = []; let tried = 0; const maxTries = Math.max(want * 8, 10);
    for (const c of cands) {
      if (picked.length >= want) break;
      if (doCatalogo(rule, c)) {
        if (!LOJAS_CATALOGO.has(c.loja)) continue;
        if (ml.rejectReason(c, rule)) { exec.recusadas.add(c.key); continue; }
        const espera = esperaDaLoja(c);
        if (espera) { esperar(exec, espera); continue; }
        const motivos = motivosDeRevisao(c);
        if (motivos.length && catalogoItens.revisaoCheia(rule.id)) { esperar(exec, 'revisao_cheia'); continue; }
        picked.push({ ...c, catalogo: true, motivos, lidoEm: null });
        continue;
      }
      if (tried >= maxTries) continue;
      if (wasSent(rule, c.key)) continue;
      if (pausada(rule, c.key)) continue;
      tried++;
      let offer;
      try { offer = await ml.resolveOffer(c); } catch (e) {
        log(rule, { level: 'aviso', offer_title: c.title || c.url, message: 'Oferta pulada: ' + e.message });
        continue;
      }
      const why = ml.rejectReason(offer, rule);
      if (why) continue;
      picked.push({ ...offer, lidoEm: offer.digitado === true ? null : lidoEm });
    }
    return picked;
  }

  /**
   * Linha da grade que vale para esta execução (D4): a do horário executado pelo tick ou, sem ele ("Enviar agora" e
   * prévia), a do próximo envio, na mesma conta do cartão (proximoEnvio, src/grade.js). null = regra sem grade ou
   * horário sem linha (vale per_run e o template da regra).
   */
  function linhaDaGrade(rule, horario, agora) {
    if (!rule.grade) return null;
    return horarioDe(rule.grade, horario ?? proximoEnvio(rule.grade, rule.next_run_at, agora));
  }

  /** Ofertas da execução: a qtd da linha (qtdDaLinha, a mesma conta do cartão) ou per_run. */
  const qtdDa = (rule, linha) => qtdDaLinha(linha, rule.per_run);

  /** Template da execução: o da linha da grade, se existir; senão o da regra. `sumiu`: a linha pedia um que não existe mais. */
  function templateDa(rule, linha) {
    const daRegra = rule.template_id && db.prepare('SELECT * FROM templates WHERE id = ?').get(rule.template_id);
    const idDaLinha = templateDaLinha(linha);
    if (idDaLinha == null) return { tpl: daRegra, sumiu: false };
    const daLinha = db.prepare('SELECT * FROM templates WHERE id = ?').get(idDaLinha);
    return daLinha ? { tpl: daLinha, sumiu: false } : { tpl: daRegra, sumiu: true };
  }

  /**
   * A regra está, no banco, em "horários marcados" (a mesma leitura de parseRule: grade ilegível = intervalo). Serve a
   * quem tem uma cópia velha dela (o fim de uma execução pelo intervalo, a lista do tick). Nunca lança.
   */
  const comGradeAgora = (id) => { try { return !!getRule(id)?.grade; } catch { return false; } };

  /** Grupos da regra que ainda existem (os mesmos a que a execução manda). */
  const gruposDa = (rule) => (rule.group_jids || []).map((jid) => db.prepare('SELECT * FROM groups WHERE jid = ?').get(jid)).filter(Boolean);
  /**
   * Proteção do número: a próxima oferta da regra pode sair agora? Pede uma vaga por grupo (o ritmo prende o pedido
   * entre 1 e o teto, ou seja, min(grupos, limite)): a oferta vai a todos os grupos ou espera inteira.
   */
  const liberadoPara = (nGrupos, now = Date.now()) => ritmo.liberado(now, { precisa: nGrupos });
  /** O horário marcado `horario` cai no silêncio, ou o silêncio vale agora: nada da grade sai (P4, é pulado). */
  const noSilencio = (horario, now) => ritmo.silencio(now).agora || ritmo.silencio(horario).agora;

  /**
   * Próximo next_run_at de uma regra por intervalo parada pela proteção: no silêncio, o fim dele alinhado ao
   * "Funciona das/até" da regra (os dois limites se somam); no teto, quando a janela abre as vagas (libera_em).
   */
  const depoisDaParada = (rule, r, now) => (r.motivo === 'silencio'
    ? alignToWindow(r.ate ?? now + 60000, rule.window_start, rule.window_end)
    : r.ate ?? now + 60000);

  /**
   * `horario` (regra com grade, vindo do tick): o horário da grade que esta execução cumpre. `manual` ("Enviar agora"):
   * numa regra com grade, usa a linha do próximo horário e não mexe em next_run_at (CA8).
   * Teto (achados S1/Q1/Q2): a execução separa as vagas no ritmo (vaga().pedir, síncrono) antes do "Enviar agora", de
   * cada oferta e de cada grupo; a oferta que fica sem vaga no meio para nos grupos que faltam, e a execução para ali.
   * `aoBarrar(lib)`: chamado, ANTES do primeiro await, quando o "Enviar agora" é barrado (a rota responde 409).
   */
  async function runRule(id, { manual = false, horario = null, aoBarrar = null } = {}) {
    const rule = getRule(id);
    if (!rule) throw new Error('Regra não encontrada');
    if (running.has(id)) return { skipped: 'já está em andamento' };
    const vaga = ritmo.vaga();
    if (manual) {
      // "Enviar agora" respeita silêncio e teto: barrado antes de começar, não lê as fontes nem mexe no next_run_at.
      // Aprovado, as vagas da 1ª oferta ficam separadas: outro "Enviar agora" ou o tick não passam por elas.
      const lib = vaga.pedir(Date.now(), { precisa: gruposDa(rule).length });
      if (!lib.ok) {
        log(rule, { level: 'aviso', message: textoEnviarAgoraBarrado(lib) });
        if (lib.motivo === 'limite') ritmo.avisarLimite(logLinha, lib);
        aoBarrar?.(lib);
        return { offers: 0, messages: 0, errors: 0, revisao: 0, descartadas: 0, parou: lib.motivo };
      }
    }
    // se algo lançar antes do try, as vagas separadas do "Enviar agora" voltam ao teto (R7)
    const antesDoTry = (f) => { try { return f(); } catch (e) { vaga.soltar(); throw e; } };
    const linha = antesDoTry(() => linhaDaGrade(rule, horario, Date.now()));
    // começo dos avisos da grade: o horário cumprido ou, no "Enviar agora", o horário cuja linha foi usada
    const prefixo = horario != null ? `Horário ${horaDe(horario)}: `
      : linha ? `Enviar agora (como no horário das ${linha.hora}): ` : '';
    running.add(id);
    const summary = { offers: 0, messages: 0, errors: 0, revisao: 0, descartadas: 0 };
    const exec = antesDoTry(() => novaExecucao());
    let retrySoon = false;
    let parada = null; // a proteção do número parou a execução no meio: { motivo, ate, limite? } de ritmo.liberado
    try {
      liberarFalhosDoCatalogo(); // envio aprovado sem nenhum grupo ok não conta no "dias sem repetir" (R3)
      if (!wa.isReady()) {
        log(rule, { level: 'erro', message: 'WhatsApp desconectado: nada foi enviado.' });
        retrySoon = true; summary.errors++; return summary;
      }
      const tag = rule.tag_id && db.prepare('SELECT * FROM tags WHERE id = ?').get(rule.tag_id);
      const { tpl, sumiu } = templateDa(rule, linha);
      if (sumiu) {
        log(rule, { level: 'aviso', message: `${prefixo}o template escolhido para este horário não existe mais. As ofertas saíram com o template da regra.` });
      }
      const groups = gruposDa(rule);
      // etiqueta do ML só se alguma fonte pode trazer oferta do ML (D8, CA6)
      const problem = !tag && precisaEtiqueta(rule.sources) ? 'escolha uma etiqueta' : !tpl ? 'escolha um template' : !groups.length ? 'escolha ao menos um grupo' : null;
      if (problem) { log(rule, { level: 'erro', message: `Regra incompleta: ${problem}.` }); summary.errors++; return summary; }

      const want = qtdDa(rule, linha);
      let picked;
      try { picked = await pickOffers(rule, want, exec); } catch (e) {
        log(rule, { level: 'erro', message: 'Não consegui buscar ofertas: ' + e.message }); summary.errors++; return summary;
      }
      if (!picked.length) { log(rule, { level: 'info', message: 'Sem ofertas novas dentro dos filtros desta vez.' }); return summary; }

      const d = delays();
      const tagDaFonte = (o) => (o.tag_id && db.prepare('SELECT * FROM tags WHERE id = ?').get(o.tag_id)) || tag;
      const jids = groups.map((g) => g.jid);
      // descarte do verificador (D8): uma linha 'aviso' por oferta, nunca 'erro'; a oferta não é reposta (D6)
      const descartar = (o, c) => { summary.descartadas++; log(rule, { level: 'aviso', offer_title: o.title, message: c.texto }); };
      for (let i = 0; i < picked.length; i++) {
        // proteção do número antes de cada oferta (nem conferência nem link): sem vaga para os grupos (até o teto), ou
        // com o silêncio começando, a execução para aqui e o resto não sai (a regra por intervalo volta quando liberar).
        // As vagas ficam separadas durante a conferência e o link: quem chega depois já as vê ocupadas
        const lib = vaga.pedir(Date.now(), { precisa: groups.length });
        if (!lib.ok) { parada = lib; summary.parou = lib.motivo; break; }
        let offer = picked[i]; const etq = tagDaFonte(offer);
        let gerados; // um link por código de rastreio distinto (linksPorCodigo)
        let sufixo = ''; // do verificador, na linha 'ok' de cada grupo (D8)
        if (offer.catalogo) {
          // revisão em vez de envio (D5): Shopee, preço suspeito ou falha do link deste item (nenhum grupo com link)
          let motivos = offer.motivos; let detalhe = '';
          if (!motivos.length) {
            // conferência antes do link (D1): sem conferência vai à revisão; esgotada ou mais cara, descartada (D6)
            const c = await conferirDaRegra(offer);
            if (c.acao === 'enviar') {
              offer = c.oferta; sufixo = c.sufixo ?? '';
              // o preço conferido pode ter saído dos filtros da regra (Q4): como no pickOffers, é só "fora dos filtros". Nada é
              // registrado no Catálogo (sem aviso de descarte, sem link): em `exec.recusadas` o cursor das Novidades avança
              // por ela e não fica preso, e em outras ordens ela pode voltar a valer se o preço cair
              if (ml.rejectReason(offer, rule)) { exec.recusadas.add(picked[i].key); continue; }
            } else if (c.motivo === 'nao_conferido') {
              motivos = ['nao_conferido'];
              detalhe = c.texto.startsWith(MOTIVOS_VERIFICADOR.nao_conferido) ? c.texto.slice(MOTIVOS_VERIFICADOR.nao_conferido.length) : '';
            } else {
              if (!regraExiste(rule.id)) continue;
              catalogoItens.registrar(rule, offer, 'descartado', [], { descartadoPor: c.motivo });
              descartar(offer, c); continue;
            }
          }
          if (!motivos.length) {
            const r = await linksPorCodigo(offer, etq, jids);
            if (r.espera) { esperar(exec, r.espera); continue; }
            if (r.algum) gerados = r;
            else { motivos = ['falha_link']; detalhe = ` (${r.falha})`; }
          }
          if (motivos.length) {
            if (!regraExiste(rule.id)) continue;
            if (catalogoItens.registrar(rule, offer, 'revisao', motivos)) {
              summary.revisao++;
              log(rule, { level: 'aviso', offer_title: offer.title, message: `Separada para revisão: ${motivos.map((m) => TEXTO_MOTIVO[m] || m).join(' e ')}${detalhe}.` });
            } else esperar(exec, 'revisao_cheia');
            continue;
          }
        } else {
          // conferência antes do link (D1): a descartada fica PAUSA_DESCARTADA_H fora da escolha desta regra (D6)
          const c = await conferirDaRegra(offer);
          if (c.acao === 'descartar') { pausar(rule, offer.key); descartar(offer, c); continue; }
          offer = c.oferta; sufixo = c.sufixo ?? '';
          // o preço conferido pode ter saído dos filtros da regra (preço máximo, desconto mínimo): como no pickOffers, é só
          // "fora dos filtros", sem aviso de descarte e sem link (não é reposta nesta execução)
          if (verificador && ml.rejectReason(offer, rule)) continue;
          gerados = await linksPorCodigo(offer, etq, jids);
          if (!gerados.algum) {
            log(rule, { level: 'erro', offer_title: offer.title, message: 'Link de afiliado não gerado: ' + gerados.falha });
            summary.errors++; continue;
          }
        }
        const textos = new Map(); // um texto por link
        const textoDe = (link) => {
          if (!textos.has(link)) textos.set(link, renderTemplate(tpl.body, { ...offer, link }, tplOpts()));
          return textos.get(link);
        };
        summary.offers++; let okCount = 0;
        for (const aviso of gerados.avisos) log(rule, { level: 'aviso', offer_title: offer.title, message: aviso });
        // foto só do CDN da loja da oferta (D9, CA5); as fontes antigas são do Mercado Livre
        const fotoOk = rule.send_image && imagemPermitida(offer.plataforma || 'mercadolivre', offer.image);
        const daFonte = picked.some((p) => p.source_index !== offer.source_index) ? ` (fonte ${(offer.source_index ?? 0) + 1})` : '';
        for (let g = 0; g < groups.length; g++) {
          const destino = gerados.porJid.get(groups[g].jid);
          if (!destino?.link) {
            // o link padrão falhou e este grupo depende dele: os grupos com link próprio seguem
            summary.errors++;
            log(rule, { level: 'erro', group_name: groups[g].name, offer_title: offer.title, message: 'Link de afiliado não gerado: ' + destino?.falha });
            continue;
          }
          // uma vaga por grupo (Q1): com mais grupos que o teto, a oferta para no grupo que não tem mais vaga. O silêncio
          // só é conferido por oferta (acima): a oferta começada vai aos grupos que o teto deixar
          const vez = vaga.pedir(Date.now(), { precisa: 1, ignorarSilencio: true });
          if (!vez.ok) { parada = vez; summary.parou = vez.motivo; break; }
          const text = textoDe(destino.link);
          try {
            if (fotoOk) {
              try { await wa.sendImage(groups[g].jid, offer.image, text); } catch { await wa.sendText(groups[g].jid, text); }
            } else await wa.sendText(groups[g].jid, text);
            vaga.usar(); // a saída já conta em wa_saidas
            okCount++; summary.messages++;
            log(rule, { level: 'ok', group_name: groups[g].name, offer_title: offer.title, message: `${comoSaiu(offer, destino)}${daFonte}${sufixo}` });
            registrarEnvio(rule, offer, groups[g].jid, destino);
          } catch (e) {
            summary.errors++;
            log(rule, { level: 'erro', group_name: groups[g].name, offer_title: offer.title, message: 'Falha no envio: ' + e.message });
          }
          if (g < groups.length - 1) await sleep(jitter(d.group));
        }
        if (okCount && !(offer.catalogo && !regraExiste(rule.id))) {
          db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (?,?,?)').run(rule.id, offer.key, Date.now());
          if (offer.catalogo) catalogoItens.registrar(rule, offer, 'enviado');
        }
        vaga.soltar(); // a pausa entre ofertas não segura vagas: a próxima oferta pede de novo
        if (parada) break;
        if (i < picked.length - 1) await sleep(jitter(d.offer));
      }
      if (parada) {
        if (parada.motivo === 'limite') ritmo.avisarLimite(logLinha, parada); // uma linha por vez que o teto enche (CA3)
        if (rule.grade) {
          // o horário da grade se encerra com o que saiu, como quando faltam ofertas (CA7 da grade): nada acumula
          const frase = `aíram ${summary.offers} de ${want} ofertas; ${motivoDaParada(parada)}.`;
          log(rule, { level: 'aviso', message: prefixo ? `${prefixo}s${frase}` : `S${frase}` });
        } else if (parada.motivo === 'silencio') {
          log(rule, { level: 'aviso', message: textoAdiadoSilencio(ritmo.silencio(Date.now()), depoisDaParada(rule, parada, Date.now())) });
        }
        return summary;
      }
      // faltaram ofertas no horário da grade (CA7): sai o que houver, sem acumular para o próximo; as descartadas pelo
      // verificador não são repostas (D6) e entram na frase
      if (rule.grade && (picked.length < want || summary.descartadas)) {
        const n = summary.descartadas;
        const frase = !n ? `aíram ${summary.offers} de ${want} ofertas; não havia mais ofertas novas dentro dos filtros.`
          : `aíram ${summary.offers} de ${want} ofertas; ${n} ${n === 1 ? 'descartada' : 'descartadas'} na conferência de preço e estoque${picked.length < want ? ' e não havia mais ofertas novas dentro dos filtros' : ''}.`;
        log(rule, { level: 'aviso', message: prefixo ? `${prefixo}s${frase}` : `S${frase}` });
      }
      return summary;
    } finally {
      vaga.soltar(); // as vagas separadas e não usadas (oferta pulada, falha do envio) voltam ao teto
      fecharCatalogo(rule, exec); // avisos de espera e cursor do catálogo, no fim (nunca na pré-visualização)
      const now = Date.now();
      if (rule.grade) fecharGrade(rule, { manual, horario, retrySoon }, now);
      else if (comGradeAgora(id)) {
        // salva em "horários marcados" durante esta execução pelo intervalo (o PUT zerou o next_run_at): o próximo do
        // intervalo não fica gravado, e o tick calcula o próximo horário pela grade nova
        db.prepare('UPDATE rules SET last_run_at = ? WHERE id = ?').run(now, id);
      } else {
        // parada pela proteção: volta quando o silêncio acabar ou o teto abrir vaga, não depois do intervalo inteiro
        const next = retrySoon ? now + 60000 : parada ? depoisDaParada(rule, parada, now)
          : alignToWindow(now + rule.interval_min * 60000, rule.window_start, rule.window_end);
        db.prepare('UPDATE rules SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(now, next, id);
      }
      running.delete(id);
    }
  }

  /**
   * Fim da execução de uma regra com grade (D4). "Enviar agora" e WhatsApp fora mantêm o next_run_at (o horário
   * vencido fica para o tick, que o pula depois de 30 min). Fora isso, o próximo é o horário seguinte ao executado,
   * mesmo que já tenha passado: o tick resolve (D3). Só troca se ninguém mexeu no meio: a regra salva durante a
   * execução fica com next_run_at NULL e o tick calcula com a grade nova.
   */
  function fecharGrade(rule, { manual, horario, retrySoon }, now) {
    db.prepare('UPDATE rules SET last_run_at = ? WHERE id = ?').run(now, rule.id);
    if (manual || retrySoon) return;
    db.prepare('UPDATE rules SET next_run_at = ? WHERE id = ? AND next_run_at IS ?')
      .run(proximoHorario(rule.grade, horario ?? now), rule.id, rule.next_run_at);
  }

  /**
   * Passo do tick para uma regra com grade (D3). `pronto`: o WhatsApp está conectado (só muda a frase do aviso: o
   * tick é quem não executa sem ele). Devolve o horário a executar agora, ou null. next_run_at NULL grava o
   * próximo horário sem enviar; horário vencido passa por resolverVencido (só o mais recente, até 30 min de atraso),
   * com um aviso no Histórico para os pulados. A janela "Funciona das/até" nunca vale aqui.
   */
  function horarioVencido(r, now, pronto) {
    const regra = getRule(r.id); // a lista do tick pode estar velha (a regra salva enquanto outra rodava)
    if (!regra?.enabled || !regra.grade) return null;
    const grava = (next) => db.prepare('UPDATE rules SET next_run_at = ? WHERE id = ? AND next_run_at IS ?').run(next, regra.id, regra.next_run_at);
    // sem horário, ou com um que não é da grade (grade editada à mão, sobra de outro ritmo): grava o próximo sem enviar,
    // como o cartão anuncia (proximoEnvio)
    if (regra.next_run_at == null || !horarioDe(regra.grade, regra.next_run_at)) {
      const next = proximoHorario(regra.grade, now);
      if (next !== regra.next_run_at) grava(next);
      return null;
    }
    if (regra.next_run_at > now) return null;
    const res = resolverVencido((h) => proximoHorario(regra.grade, h), regra.next_run_at, now);
    // o que vai sair fica gravado: com o WhatsApp fora, ele espera (e vence) como qualquer horário
    const next = res.executar ?? res.proximo;
    if (res.pulados.length) {
      // "sai agora" só se ele vai mesmo sair: o que cai no silêncio é pulado logo depois (pularNoSilencio)
      const saiAgora = pronto && res.executar != null && !noSilencio(res.executar, now);
      log(regra, { level: 'aviso', message: textoPulados(res.pulados, { seguinte: next, saiAgora }, now) });
    }
    if (next !== regra.next_run_at) grava(next);
    return res.executar;
  }

  /**
   * Horário da grade que venceu no silêncio (ou com o silêncio valendo agora): pulado com aviso, e o próximo horário
   * da grade fica gravado (P4). Só se ninguém mexeu no next_run_at no meio (a mesma trava do fecharGrade).
   */
  function pularNoSilencio(id, horario) {
    const regra = getRule(id);
    if (!regra?.grade) return;
    const r = db.prepare('UPDATE rules SET next_run_at = ? WHERE id = ? AND next_run_at IS ?').run(proximoHorario(regra.grade, horario), id, horario);
    if (r.changes) log(regra, { level: 'aviso', message: textoPuladoSilencio(horario) });
  }

  /**
   * Teto da proteção no tick (regras com grade ou por intervalo): sem vaga para todos os grupos da regra, ela não roda
   * e o next_run_at fica como está (a grade continua sujeita à tolerância de 30 min). Uma linha por vez que o teto
   * enche (avisarLimite), nunca uma por regra nem por tick.
   */
  function semVaga(rule, now) {
    const lib = liberadoPara(gruposDa(rule).length, now);
    if (lib.ok) return false;
    if (lib.motivo === 'limite') ritmo.avisarLimite(logLinha, lib);
    return true;
  }

  /**
   * POST /api/rules/:id/run (achado R4): começa a execução manual em segundo plano e diz já se ela foi barrada pelo
   * silêncio ou pelo teto. O barrado é decidido no trecho síncrono de runRule (antes do primeiro await), então o
   * `aoBarrar` já rodou quando runRule devolve a promise. → { iniciado: true } ou { barrado: frase do Histórico }
   */
  function enviarAgora(id) {
    let barrado = null;
    runRule(id, { manual: true, aoBarrar: (lib) => { barrado = lib; } }).catch(() => {});
    return barrado ? { barrado: textoEnviarAgoraBarrado(barrado) } : { iniciado: true };
  }

  async function previewOffers(id) {
    const rule = getRule(id);
    if (!rule) throw new Error('Regra não encontrada');
    // com grade: a quantidade e o template do próximo horário (CA8), sem aviso no Histórico
    const linha = linhaDaGrade(rule, null, Date.now());
    const { tpl } = templateDa(rule, linha);
    // execução própria e descartada: nada vai a catalogo_itens, catalogo_cursores, sent_offers nem ao log do
    // catálogo; Novidades sem cursor pronto não lê (a regra mostra primeira_leitura na fonte, em GET /api/rules)
    const picked = await pickOffers(rule, qtdDa(rule, linha), novaExecucao(), { previa: true });
    const nome = (id) => db.prepare('SELECT name FROM tags WHERE id = ?').get(id)?.name;
    const linkPrevia = (o) => (!o.catalogo || o.loja === 'ml' ? LINK_ML_PREVIA
      : o.loja === 'amazon' ? `https://www.amazon.com.br/dp/${o.asin}?tag=•••` : o.link);
    return picked.map((o) => {
      const motivos = o.catalogo ? o.motivos : [];
      const etiqueta = o.catalogo && o.loja !== 'ml' ? null : nome(o.tag_id) || nome(rule.tag_id) || null;
      // revisao/motivos: a oferta iria à revisão em vez de sair (o painel mostra "Esperaria revisão" e o motivo)
      // a prévia não confere na loja: {HORA_PRECO} sai com a hora de agora (no envio, a da conferência), como nas outras prévias
      return { ...o, etiqueta, fonte: (o.source_index ?? 0) + 1, revisao: motivos.length > 0, motivos, text: tpl ? renderTemplate(tpl.body, { ...o, link: linkPrevia(o), vistoEm: Date.now() }, tplOpts()) : '' };
    });
  }

  /** Envios e avisos chamados pelo tick: se falharem, registra e segue, para nunca travar as regras. */
  async function passo(nome, fn) {
    try { await fn(); } catch (e) { console.error(`[agendador] ${nome}:`, e?.message || e); }
  }

  /** R3 (src/catalogo-itens.js liberarFalhos): nunca lança; no console só o código do erro (o do banco traz valores). */
  function liberarFalhosDoCatalogo() {
    if (typeof catalogoItens?.liberarFalhos !== 'function') return;
    try { catalogoItens.liberarFalhos(); } catch (e) { console.error('[agendador] catálogo (envios sem grupo ok):', e?.code || e?.name || 'erro'); }
  }
  /** Passada da fila de envios e, logo depois, a reserva dos envios do catálogo que terminaram sem grupo ok. */
  async function passoEnvios() {
    await passo('envios', () => envios.processarPendentes());
    liberarFalhosDoCatalogo();
  }

  /** Pede um tick já, sem esperar. Se um tick está rodando, ele mesmo passa nos envios antes de terminar. */
  function acordar() {
    acordado = true;
    tick().catch((e) => console.error('[agendador]', e?.message || e));
  }

  /**
   * Passos do espelho: a falha vai ao console só pelo código/nome, nunca pela mensagem (erro do banco pode trazer
   * valores da query, e o espelho lida com texto de grupos de terceiros).
   */
  const semDetalhe = (fn) => async () => { try { return await fn(); } catch (e) { throw new Error(e?.code || e?.name || 'erro'); } };
  /** Espelho: decide os itens recebidos (cada decisão "enviar" grava um envio pendente e acorda o tick). */
  const passoEspelho = () => passo('espelho', semDetalhe(() => espelho.processarPendentes()));
  /**
   * Remetentes (D9): primeiro as respostas às mensagens cujos envios terminaram, depois a decisão dos itens recebidos
   * (cada "enviar" grava um envio pendente e acorda o tick). Passos separados: a falha de um não impede o outro. Sem a
   * mensagem do erro no console (semDetalhe): a de uma biblioteca pode trazer o número do remetente.
   */
  async function passoRemetentes() {
    await passo('remetentes (respostas)', semDetalhe(() => remetentes.responderPendentes()));
    await passo('remetentes', semDetalhe(() => remetentes.processarPendentes()));
  }
  /**
   * Grupo vivo (D7): grava as ocorrências das rotinas vencidas (cada uma vira um envio 'agora' e acorda o tick). Sem a
   * mensagem do erro no console (semDetalhe): a do banco pode trazer o texto da rotina.
   */
  const passoRotinas = () => passo('grupo vivo', semDetalhe(() => rotinas.processarPendentes()));

  // Ordem: envios vencidos → espelho → remetentes → avisos → rotinas → regras, com espelho, remetentes, rotinas e envios
  // de novo depois de cada regra (um agendado, uma oferta espelhada, um link de remetente ou uma rotina do Grupo vivo
  // espera no máximo a regra em andamento).
  async function tick() {
    if (ticking) return; ticking = true; acordado = false;
    try {
      await recuperacao; // o primeiro tick espera o recuperar() do start()
      await passoEnvios();
      await passo('espelho (fila)', semDetalhe(() => espelho.expirarFila())); // 'na_fila' esquecido → 'expirado'
      await passoEspelho();
      await passoRemetentes();
      await passo('avisos', () => avisos.tick());
      await passoRotinas();
      const rules = db.prepare('SELECT * FROM rules WHERE enabled = 1').all().map(parseRule);
      for (const r of rules) {
        const now = Date.now();
        // a lista pode estar velha: a regra salva em "horários marcados" enquanto outra rodava já vai pela grade
        if (r.grade || comGradeAgora(r.id)) {
          // regra com grade (D3): pelos horários marcados, sem a janela
          if (running.has(r.id)) continue;
          const pronto = wa.isReady();
          const horario = horarioVencido(r, now, pronto);
          if (horario == null) continue;
          // hora marcada no silêncio é pulada, mesmo com o WhatsApp fora (P4): não "sai quando acabar"
          if (noSilencio(horario, now)) { pularNoSilencio(r.id, horario); continue; }
          if (!pronto || semVaga(r, now)) continue;
          await runRule(r.id, { horario });
          await passoEspelho();
          await passoRemetentes();
          await passoRotinas();
          await passoEnvios();
          continue;
        }
        if (running.has(r.id) || (r.next_run_at && r.next_run_at > now)) continue;
        if (!inWindow(now, r.window_start, r.window_end)) {
          db.prepare('UPDATE rules SET next_run_at = ? WHERE id = ?').run(alignToWindow(now, r.window_start, r.window_end), r.id);
          continue;
        }
        // silêncio global: a regra por intervalo é adiada para o fim dele, alinhado ao "Funciona das/até" dela (uma
        // linha por silêncio: com o next_run_at no futuro, os ticks seguintes nem chegam aqui)
        const sil = ritmo.silencio(now);
        if (sil.agora) {
          const next = alignToWindow(sil.ate_ts, r.window_start, r.window_end);
          db.prepare('UPDATE rules SET next_run_at = ? WHERE id = ?').run(next, r.id);
          log(r, { level: 'aviso', message: textoAdiadoSilencio(sil, next) });
          continue;
        }
        if (!wa.isReady() || semVaga(r, now)) continue;
        await runRule(r.id);
        await passoEspelho();
        await passoRemetentes();
        await passoRotinas();
        await passoEnvios();
      }
      // "agora" criado (ou mensagem espelhada ou de remetente recebida) depois da última passada: sai neste tick, não
      // no próximo (até 15 s depois). Espelho e remetentes vêm antes dos envios: o envio que eles criarem sai na mesma
      // volta. A resposta ao remetente sai no passo dos remetentes seguinte: a próxima volta deste laço (o envio criado
      // acorda o tick de novo) ou o próximo tick.
      while (acordado) { acordado = false; await passoEspelho(); await passoRemetentes(); await passoEnvios(); }
    } catch (e) { console.error('[agendador]', e); } finally { ticking = false; }
  }

  return {
    // acordar: o "Enviar" aprovado na revisão do catálogo (src/catalogo-itens.js) pede o tick já
    runRule, enviarAgora, previewOffers, tick, acordar, envios, avisos, amazon, shopee, espelho, remetentes, rotinas, catalogo, catalogoItens,
    // proteção do número: `ritmo` (uso do teto e silêncio para o /state) e o `wa` embrulhado, o mesmo dos módulos daqui;
    // quem manda mensagem fora do agendador usa este `wa`, para contar no teto e respeitar a pausa mínima
    ritmo, wa,
    start() {
      if (timer) return;
      // o que ficou 'enviando' (envios) ou 'processando' (espelho e remetentes) quando o serviço caiu volta antes do
      // primeiro tick
      recuperacao = Promise.all([
        passo('recuperar', () => envios.recuperar()),
        passo('espelho (recuperar)', semDetalhe(() => espelho.recuperar())),
        passo('remetentes (recuperar)', semDetalhe(() => remetentes.recuperar())),
      ]);
      timer = setInterval(tick, 15000); primeiro = setTimeout(tick, 2000);
    },
    stop() { clearInterval(timer); clearTimeout(primeiro); timer = null; primeiro = null; },
    isRunning: (id) => running.has(id),
  };
}
