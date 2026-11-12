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
import { criarTrava, lerEnviados, comparar, centavos, maisBarataOBastante, tituloParaGuardar, comFraseMaisBarata, precoDoUltimoEnvio, baixouDe, textoConflito, textoPassou, textoConferencia, HORAS_ENTRE_PARECIDOS } from './parecido.js';
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

  // ---------- produto igual ou parecido (plano nao-repetir-produto-parecido): uma linha "Pulada" por conflito
  // Fora das Novidades a mesma candidata volta a cada execução e seria pulada de novo pelo mesmo motivo (achados R4/S1):
  // "regra\0chave\0conflito" → até quando a linha não se repete (só em memória; um reinício loga de novo, uma vez).
  // O conflito é a anterior (tipo e sent_at): outra anterior, ou a mesma em outro tipo, é conflito novo e ganha linha.
  // Na mesma rodada não há sent_at: vale o título da escolhida, por HORAS_ENTRE_PARECIDOS.
  // A pulada na conferência (mais barata na escolha, mais cara na loja) usa o mesmo mapa, com o tipo 'conferencia'.
  const puladasLogadas = new Map();
  /** Tira as entradas vencidas (sem crescer para sempre): uma vez por execução da regra (achado R10). */
  function limparPuladasLogadas(agora) {
    for (const [k, ate] of puladasLogadas) if (ate <= agora) puladasLogadas.delete(k);
  }
  /** Linha 'info' de `offer_title` com `message`, só se o conflito `k` ainda não foi dito; ele fica dito até `ate`. */
  function logarUmaVez(rule, k, ate, offer_title, message, agora) {
    if (puladasLogadas.has(k)) return;
    puladasLogadas.set(k, Math.max(ate, agora + 1));
    log(rule, { level: 'info', offer_title, message });
  }
  // a anterior deixa de barrar quando a janela da regra ("dias sem repetir") vence
  const fimDaJanela = (rule, sentAt) => sentAt + (Number(rule.dedupe_days) || 0) * 86400000;
  function logarPuladaUmaVez(rule, p, agora) {
    const { tipo, anterior } = p.r;
    const rodada = tipo === 'rodada';
    const k = `${rule.id}\0${p.key}\0${tipo}\0${rodada ? anterior.title : anterior.sent_at}`;
    // a da rodada não tem envio: vale por HORAS_ENTRE_PARECIDOS
    const ate = rodada ? agora + HORAS_ENTRE_PARECIDOS * 3600000 : fimDaJanela(rule, anterior.sent_at);
    logarUmaVez(rule, k, ate, p.title, textoConflito(p.r, agora), agora);
  }

  // ---------- ofertas saindo agora (achados Q1 e R1): desde a escolha de cada uma (pickOffers, no mesmo ponto em que
  // entra na trava da rodada) até a gravação em sent_offers ou o fim da execução, as ofertas que a execução em
  // andamento de cada regra vai mandar. O "Enviar" do Catálogo as consulta dentro da transação (src/catalogo-itens.js,
  // usarEmEnvio): a regra só grava a reserva depois de mandar aos grupos. A prévia não entra aqui.
  // regra → (chave → { key, title }); só em memória, uma execução por regra de cada vez (running)
  const emEnvio = new Map();
  const tirarDoEnvio = (ruleId, key) => { emEnvio.get(ruleId)?.delete(key); };
  catalogoItens?.usarEmEnvio?.((ruleId) => [...(emEnvio.get(ruleId)?.values() ?? [])]);

  /**
   * Confere a oferta da regra logo antes do link (D1). As fontes antigas são do Mercado Livre; o catálogo manda a
   * própria loja. Sem verificador → enviar como veio. Nunca lança: um descarte não para as outras ofertas (D6).
   * → { acao: 'enviar', oferta, sufixo } | { acao: 'descartar', motivo, texto }
   */
  async function conferirDaRegra(offer) {
    if (!verificador) return { acao: 'enviar', oferta: offer, sufixo: null };
    try {
      const { lidoEm = null, maisBarata: _marca, ...oferta } = offer; // a marca da trava é interna: o verificador não a vê
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
   * e as chaves que cada fonte trouxe (vistas: o catálogo conta a de outra fonte como tratada, R11). `puladas`: as
   * ofertas barradas por já ter saído (ou estar saindo) uma igual ou parecida (src/parecido.js): { key, title, r } cada uma.
   */
  const novaExecucao = () => ({ paginas: new Map(), recusadas: new Set(), esperando: new Map(), vistas: new Set(), puladas: [] });
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
      if (!LOJAS_CATALOGO.has(c?.loja) || ml.rejectReason(c, rule) || esperaDaLoja(c) || pausada(rule, c.key)) return false;
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
   * verificador há menos de PAUSA_DESCARTADA_H fica fora da escolha (D6), como a pulada na conferência (achado Q5).
   * Produto igual ou parecido (plano nao-repetir-produto-parecido, regras 7 e 8): depois dos filtros e das esperas, a
   * oferta que repete o título de outra enviada pela regra, ou é parecida com ela, vai para `exec.puladas`, a não ser
   * que seja o mesmo título (nenhuma parecida nas últimas 24 h) e esteja pelo menos DESCONTO_MINIMO_MAIS_BARATA% abaixo
   * do menor preço dele na janela (D10/D11): então entra com `maisBarata` (a mensagem leva a frase) e o `runRule`
   * confere o preço de novo depois da conferência na loja. O catálogo que vai à revisão não leva a marca.
   * `saindo` (Map, só no runRule): recebe cada escolhida que vai sair (a que vai à revisão não) na hora em que é
   * escolhida, para o "Enviar" do Catálogo já vê-la durante as leituras que faltam (achado R1).
   */
  async function pickOffers(rule, want, exec = novaExecucao(), { previa = false, saindo = null } = {}) {
    const lidoEm = Date.now();
    const cands = await ml.candidates(rule, {
      links, onWarn: (m) => log(rule, { level: 'aviso', message: m }),
      catalogo: fonteCatalogo, quer: want, paginas: exec.paginas, vistas: exec.vistas, previa,
      tratada: (c, modo) => catalogoItens.tratada(rule, c, modo),
      utilizavel: fonteCatalogo ? utilizavelNa(rule) : undefined,
    });
    const picked = []; let tried = 0; const maxTries = Math.max(want * 8, 10);
    const agora = Date.now();
    // chave exata continua com wasSent/tratada; aqui só o título: o que a regra enviou na janela e o que já está escolhido
    const trava = criarTrava({
      enviados: rule.dedupe_days > 0 ? lerEnviados(db, rule.id, agora - rule.dedupe_days * 86400000) : [],
      agora, dedupeDias: rule.dedupe_days,
    });
    /** Barra (→ o resultado da trava, anotado em `exec.puladas`) ou libera (→ null); `marca` recebe a anterior quando é mais barata. */
    const barrada = (o, marca) => {
      const r = trava.avaliar({ key: o.key, title: o.title, price: o.price });
      if (r?.acao === 'barrar') { exec.puladas.push({ key: o.key, title: o.title, r }); return r; }
      if (r?.acao === 'liberar') marca.maisBarata = { title: r.anterior.title, preco: r.anterior.preco, sent_at: r.anterior.sent_at };
      return null;
    };
    for (const c of cands) {
      if (picked.length >= want) break;
      if (doCatalogo(rule, c)) {
        if (!LOJAS_CATALOGO.has(c.loja)) continue;
        if (ml.rejectReason(c, rule)) { exec.recusadas.add(c.key); continue; }
        // pulada na conferência há menos de PAUSA_DESCARTADA_H (achado Q5): fora da escolha, e o cursor passa por ela
        if (pausada(rule, c.key)) { exec.recusadas.add(c.key); continue; }
        const espera = esperaDaLoja(c);
        if (espera) { esperar(exec, espera); continue; }
        const marca = {};
        // barrada por um envio anterior: tratada como recusada, para o cursor das Novidades não ficar preso nela. A da
        // mesma rodada não (achado R1): se a escolhida não sair (esgotada, revisão, falha de link, teto), o cursor fica na
        // página e a próxima execução a avalia de novo, contra o que saiu de fato
        const b = barrada(c, marca);
        if (b) { if (b.tipo !== 'rodada') exec.recusadas.add(c.key); continue; }
        const motivos = motivosDeRevisao(c);
        if (motivos.length && catalogoItens.revisaoCheia(rule.id)) { esperar(exec, 'revisao_cheia'); continue; }
        // a que vai à revisão não leva a marca: o "Enviar" decide de novo
        picked.push({ ...c, catalogo: true, motivos, lidoEm: null, ...(motivos.length ? {} : marca) });
        trava.acrescentar({ key: c.key, title: c.title });
        if (!motivos.length) saindo?.set(c.key, { key: c.key, title: c.title });
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
      const marca = {};
      if (barrada(offer, marca)) continue;
      picked.push({ ...offer, lidoEm: offer.digitado === true ? null : lidoEm, ...marca });
      trava.acrescentar({ key: offer.key, title: offer.title });
      saindo?.set(offer.key, { key: offer.key, title: offer.title });
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
      // as que vão sair (a que vai à revisão do Catálogo não) entram em `emEnvio` já na escolha: o "Enviar" do Catálogo
      // as vê até a gravação (Q1), também durante as leituras da escolha que faltam (R1)
      emEnvio.set(rule.id, new Map());
      // o "Enviar" do Catálogo que passou durante a escolha (antes de a parecida dele ser escolhida) gravou a reserva
      // depois de a trava ler os enviados: cada oferta é conferida de novo contra o que entrou em sent_offers desde
      // aqui (R1). Pelo id, não pelo relógio: uma reserva no mesmo milissegundo do início também conta
      const ultimaReserva = Number(db.prepare('SELECT MAX(id) AS n FROM sent_offers').get()?.n) || 0;
      let picked;
      try { picked = await pickOffers(rule, want, exec, { saindo: emEnvio.get(rule.id) }); } catch (e) {
        log(rule, { level: 'erro', message: 'Não consegui buscar ofertas: ' + e.message }); summary.errors++; return summary;
      }
      const gravadas = new Set(); // os ids que esta execução gravou em sent_offers (não contam na conferência abaixo)
      /**
       * Reserva gravada por outro (o "Enviar" do Catálogo) desde o início da escolha que barra a oferta: a mesma chave
       * (→ { mesmaChave }) ou um título igual ou parecido (→ o resultado de barrar, para a linha do Histórico). Nunca
       * com a exceção do mais barato: as duas sairiam no mesmo horário (D12). → null se pode sair.
       */
      const reservadaDurante = (o) => {
        // `+rule_id`: só as linhas depois de `ultimaReserva` (pelo id), sem varrer o índice da regra inteira
        const novas = db.prepare('SELECT id, offer_key, title, price_cents, sent_at FROM sent_offers WHERE id > ? AND +rule_id = ? ORDER BY id').all(ultimaReserva, rule.id);
        for (const e of novas) {
          if (gravadas.has(Number(e.id))) continue;
          if (String(e.offer_key) === String(o.key)) return { mesmaChave: true };
          const tipo = comparar(o.title, e.title);
          if (tipo) return { acao: 'barrar', tipo, anterior: { title: e.title, preco: Number.isInteger(e.price_cents) && e.price_cents > 0 ? e.price_cents : null, sent_at: e.sent_at } };
        }
        return null;
      };
      // produto igual ou parecido já enviado (ou escolhido): uma linha por conflito, só 'info' (nunca alerta)
      limparPuladasLogadas(Date.now());
      for (const p of exec.puladas) logarPuladaUmaVez(rule, p, Date.now());
      if (!picked.length) { log(rule, { level: 'info', message: 'Sem ofertas novas dentro dos filtros desta vez.' }); return summary; }

      const d = delays();
      const tagDaFonte = (o) => (o.tag_id && db.prepare('SELECT * FROM tags WHERE id = ?').get(o.tag_id)) || tag;
      const jids = groups.map((g) => g.jid);
      // descarte do verificador (D8): uma linha 'aviso' por oferta, nunca 'erro'; a oferta não é reposta (D6)
      const descartar = (o, c) => { summary.descartadas++; log(rule, { level: 'aviso', offer_title: o.title, message: c.texto }); };
      for (let i = 0; i < picked.length; i++) {
        if (i > 0) tirarDoEnvio(rule.id, picked[i - 1].key); // a anterior saiu (já está em sent_offers) ou foi pulada
        const reservada = reservadaDurante(picked[i]);
        if (reservada) {
          // a reservada pelo Catálogo conta como tratada no cursor das Novidades, como a barrada na escolha
          if (picked[i].catalogo) exec.recusadas.add(picked[i].key);
          // a mesma chave já está na fila do Catálogo: sem linha, como a chave exata (wasSent/tratada)
          if (!reservada.mesmaChave) logarPuladaUmaVez(rule, { key: picked[i].key, title: picked[i].title, r: reservada }, Date.now());
          continue;
        }
        // proteção do número antes de cada oferta (nem conferência nem link): sem vaga para os grupos (até o teto), ou
        // com o silêncio começando, a execução para aqui e o resto não sai (a regra por intervalo volta quando liberar).
        // As vagas ficam separadas durante a conferência e o link: quem chega depois já as vê ocupadas
        const lib = vaga.pedir(Date.now(), { precisa: groups.length });
        if (!lib.ok) { parada = lib; summary.parou = lib.motivo; break; }
        let offer = picked[i]; const etq = tagDaFonte(offer);
        // a marca "mais barata" fica em picked[i]: a oferta que volta do verificador é outro objeto, sem ela
        const maisBarata = picked[i].maisBarata ?? null;
        // depois da conferência na loja o preço pode ter subido: sem ficar pelo menos DESCONTO_MINIMO_MAIS_BARATA% abaixo do
        // anterior, a frase não vale (regra 8, D11). Preço ilegível conta como não mais barata (achados S2/Q2); sem preço
        // não há o que dizer na linha
        const naoMaisBarata = (o) => !!maisBarata && !maisBarataOBastante(centavos(o.price), maisBarata.preco);
        // Fica PAUSA_DESCARTADA_H fora da escolha, como a descartada (achado Q5): a vaga da execução seguinte vai à próxima
        // candidata. A linha sai uma vez por conflito (a anterior), enquanto ela estiver na janela da regra
        const puladaNaConferencia = (o) => {
          const agora = Date.now();
          pausar(rule, picked[i].key);
          if (centavos(o.price) === null) return;
          const k = `${rule.id}\0${picked[i].key}\0conferencia\0${maisBarata.sent_at}`;
          logarUmaVez(rule, k, fimDaJanela(rule, maisBarata.sent_at), o.title, textoConferencia(maisBarata, o.price, agora), agora);
        };
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
              if (naoMaisBarata(offer)) { puladaNaConferencia(offer); exec.recusadas.add(picked[i].key); continue; }
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
          if (naoMaisBarata(offer)) { puladaNaConferencia(offer); continue; }
          gerados = await linksPorCodigo(offer, etq, jids);
          if (!gerados.algum) {
            log(rule, { level: 'erro', offer_title: offer.title, message: 'Link de afiliado não gerado: ' + gerados.falha });
            summary.errors++; continue;
          }
        }
        const textos = new Map(); // um texto por link
        // "Baixou de … para …": preço do último envio deste produto pela regra, só se o preço conferido está pelo menos 5%
        // abaixo (null = campo vazio e linha some). Uma busca por oferta, depois da conferência, antes de gravar o envio
        const precoUltimoEnvio = ultimoEnvio(rule, offer, picked[i].key);
        const textoDe = (link) => {
          if (!textos.has(link)) {
            const texto = renderTemplate(tpl.body, { ...offer, link, precoUltimoEnvio }, tplOpts());
            textos.set(link, maisBarata ? comFraseMaisBarata(texto) : texto); // CA5: só quem saiu por ser mais barata
          }
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
          gravadas.add(Number(db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)')
            .run(rule.id, offer.key, Date.now(), tituloParaGuardar(offer.title), centavos(offer.price)).lastInsertRowid));
          if (offer.catalogo) catalogoItens.registrar(rule, offer, 'enviado');
          if (maisBarata) log(rule, { level: 'info', offer_title: offer.title, message: textoPassou(maisBarata, offer.price, Date.now()) });
        }
        vaga.soltar(); // a pausa entre ofertas não segura vagas: a próxima oferta pede de novo
        tirarDoEnvio(rule.id, picked[i].key); // gravada em sent_offers (ou sem nenhum grupo ok): não está mais saindo
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
      emEnvio.delete(rule.id); // também em erro: nada fica "saindo agora" depois da execução
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

  /** `{PRECO_ULTIMO_ENVIO}` da oferta (reais) ou null: ver `baixouDe`. Nunca lança (a busca devolve null em erro). */
  const ultimoEnvio = (rule, o, key) => baixouDe(precoDoUltimoEnvio(db, rule.id, { key, title: o.title }, Date.now()), o.price);

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
    // a que sairia por ser mais barata mostra a frase (sem conferir na loja, o preço é o da escolha)
    const textoDaPrevia = (tpl, o, link) => {
      const texto = renderTemplate(tpl.body, { ...o, link, vistoEm: Date.now(), precoUltimoEnvio: ultimoEnvio(rule, o, o.key) }, tplOpts());
      return o.maisBarata ? comFraseMaisBarata(texto) : texto;
    };
    return picked.map((o) => {
      const motivos = o.catalogo ? o.motivos : [];
      const etiqueta = o.catalogo && o.loja !== 'ml' ? null : nome(o.tag_id) || nome(rule.tag_id) || null;
      // revisao/motivos: a oferta iria à revisão em vez de sair (o painel mostra "Esperaria revisão" e o motivo)
      // a prévia não confere na loja: {HORA_PRECO} sai com a hora de agora (no envio, a da conferência), como nas outras prévias
      // a marca da trava é interna (achados R7/S3): só a frase no texto diz que ela sairia como mais barata
      const { maisBarata: _marca, ...oferta } = o;
      return { ...oferta, etiqueta, fonte: (o.source_index ?? 0) + 1, revisao: motivos.length > 0, motivos, text: tpl ? textoDaPrevia(tpl, o, linkPrevia(o)) : '' };
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
