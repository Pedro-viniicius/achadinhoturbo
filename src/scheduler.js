import { addLog, parseRule, getSetting } from './db.js';
import { renderTemplate } from './template.js';
import * as mlDefault from './ml.js';
import { imagemPermitida } from './lojas.js';
import { motivosDeRevisao, precisaEtiqueta } from './catalogo.js';
import { createEnvios } from './envios.js';
import { createAvisos } from './avisos.js';
import { createEspelho } from './espelho.js';
import { agrupar, registrar as registrarRastreio } from './rastreio.js';
import { sleep, jitter } from './util.js';

// Pausas entre mensagens: moram em ./util.js (src/envios.js usa o mesmo ritmo anti-bloqueio); reexportadas aqui.
export { sleep, jitter };

// Fonte "catalogo" (plano fonte-catalogo-etiqueta, etapa 4)
const LOJAS_CATALOGO = new Set(['ml', 'amazon', 'shopee']);
const SONDA_ASIN = 'B000000000'; // montarLink com um ASIN de sonda diz se há tag da Amazon salva, sem rede
const LINK_ML_PREVIA = 'https://meli.la/(gerado no envio)';
/** Motivos de revisão (src/catalogo-itens.js MOTIVOS) no Histórico. */
const TEXTO_MOTIVO = {
  shopee: 'Shopee, confirme o link', desconto_100: 'desconto de 100%, confira o preço',
  preco_antigo: 'preço antigo muito alto, confira o preço', falha_link: 'não consegui gerar o link',
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

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

/** O horário de funcionamento pode virar a noite (ex.: 20:00 até 02:00). */
export function inWindow(ts, start, end) {
  const d = new Date(ts); const m = d.getHours() * 60 + d.getMinutes();
  const s = toMin(start); const e = toMin(end);
  if (s === e) return true;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** Se `ts` cai fora do horário, devolve o próximo início de janela. */
export function alignToWindow(ts, start, end) {
  if (inWindow(ts, start, end)) return ts;
  const d = new Date(ts); const s = toMin(start);
  d.setHours(Math.floor(s / 60), s % 60, 0, 0);
  if (d.getTime() <= ts) d.setDate(d.getDate() + 1);
  return d.getTime();
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
 */
export function createScheduler({ db, wa, links, ml = mlDefault, fast = false, dir = null, amazon = null, shopee = null, catalogo = null, catalogoItens = null }) {
  const running = new Set();
  let timer = null; let primeiro = null; let ticking = false; let recuperacao = null;
  let acordado = false; // um "agora" chegou com o tick em andamento: ele passa nos envios de novo antes de terminar
  // O "agora" não envia por conta própria: grava pendente e acorda o tick, que manda um envio de cada vez (S14)
  const envios = createEnvios({ db, wa, links, ml, fast, dir, acordar, amazon, shopee });
  const avisos = createAvisos({ db, wa });
  // receber() (ouvinte do WhatsApp) e cada envio que o espelho cria chamam acordar(): a oferta sai neste tick
  const espelho = createEspelho({ db, wa, amazon, envios, acordar });

  const getRule = (id) => parseRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(id));
  const delays = () => fast ? { group: 0, offer: 0 } : {
    group: Number(getSetting(db, 'delay_group_s', 6)),
    offer: Number(getSetting(db, 'delay_offer_s', 30)),
  };
  const log = (rule, o) => addLog(db, { rule, ...o });
  const tplOpts = () => ({ tituloMax: Number(getSetting(db, 'titulo_max', 60)) });

  function wasSent(rule, key) {
    if (!rule.dedupe_days) return false;
    const since = Date.now() - rule.dedupe_days * 86400000;
    return !!db.prepare('SELECT 1 FROM sent_offers WHERE rule_id = ? AND offer_key = ? AND sent_at > ? LIMIT 1').get(rule.id, key, since);
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
   */
  async function pickOffers(rule, want, exec = novaExecucao(), { previa = false } = {}) {
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
        picked.push({ ...c, catalogo: true, motivos });
        continue;
      }
      if (tried >= maxTries) continue;
      if (wasSent(rule, c.key)) continue;
      tried++;
      let offer;
      try { offer = await ml.resolveOffer(c); } catch (e) {
        log(rule, { level: 'aviso', offer_title: c.title || c.url, message: 'Oferta pulada: ' + e.message });
        continue;
      }
      const why = ml.rejectReason(offer, rule);
      if (why) continue;
      picked.push(offer);
    }
    return picked;
  }

  async function runRule(id, { manual = false } = {}) {
    const rule = getRule(id);
    if (!rule) throw new Error('Regra não encontrada');
    if (running.has(id)) return { skipped: 'já está em andamento' };
    running.add(id);
    const summary = { offers: 0, messages: 0, errors: 0, revisao: 0 };
    const exec = novaExecucao();
    let retrySoon = false;
    try {
      liberarFalhosDoCatalogo(); // envio aprovado sem nenhum grupo ok não conta no "dias sem repetir" (R3)
      if (!wa.isReady()) {
        log(rule, { level: 'erro', message: 'WhatsApp desconectado: nada foi enviado.' });
        retrySoon = true; summary.errors++; return summary;
      }
      const tag = rule.tag_id && db.prepare('SELECT * FROM tags WHERE id = ?').get(rule.tag_id);
      const tpl = rule.template_id && db.prepare('SELECT * FROM templates WHERE id = ?').get(rule.template_id);
      const groups = rule.group_jids
        .map((jid) => db.prepare('SELECT * FROM groups WHERE jid = ?').get(jid)).filter(Boolean);
      // etiqueta do ML só se alguma fonte pode trazer oferta do ML (D8, CA6)
      const problem = !tag && precisaEtiqueta(rule.sources) ? 'escolha uma etiqueta' : !tpl ? 'escolha um template' : !groups.length ? 'escolha ao menos um grupo' : null;
      if (problem) { log(rule, { level: 'erro', message: `Regra incompleta: ${problem}.` }); summary.errors++; return summary; }

      let picked;
      try { picked = await pickOffers(rule, rule.per_run, exec); } catch (e) {
        log(rule, { level: 'erro', message: 'Não consegui buscar ofertas: ' + e.message }); summary.errors++; return summary;
      }
      if (!picked.length) { log(rule, { level: 'info', message: 'Sem ofertas novas dentro dos filtros desta vez.' }); return summary; }

      const d = delays();
      const tagDaFonte = (o) => (o.tag_id && db.prepare('SELECT * FROM tags WHERE id = ?').get(o.tag_id)) || tag;
      const jids = groups.map((g) => g.jid);
      for (let i = 0; i < picked.length; i++) {
        const offer = picked[i]; const etq = tagDaFonte(offer);
        let gerados; // um link por código de rastreio distinto (linksPorCodigo)
        if (offer.catalogo) {
          // revisão em vez de envio (D5): Shopee, preço suspeito ou falha do link deste item (nenhum grupo com link)
          let motivos = offer.motivos; let detalhe = '';
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
          const text = textoDe(destino.link);
          try {
            if (fotoOk) {
              try { await wa.sendImage(groups[g].jid, offer.image, text); } catch { await wa.sendText(groups[g].jid, text); }
            } else await wa.sendText(groups[g].jid, text);
            okCount++; summary.messages++;
            log(rule, { level: 'ok', group_name: groups[g].name, offer_title: offer.title, message: `${comoSaiu(offer, destino)}${daFonte}` });
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
        if (i < picked.length - 1) await sleep(jitter(d.offer));
      }
      return summary;
    } finally {
      fecharCatalogo(rule, exec); // avisos de espera e cursor do catálogo, no fim (nunca na pré-visualização)
      const now = Date.now();
      const next = retrySoon ? now + 60000 : alignToWindow(now + rule.interval_min * 60000, rule.window_start, rule.window_end);
      db.prepare('UPDATE rules SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(now, next, id);
      running.delete(id);
    }
  }

  async function previewOffers(id) {
    const rule = getRule(id);
    if (!rule) throw new Error('Regra não encontrada');
    const tpl = rule.template_id && db.prepare('SELECT * FROM templates WHERE id = ?').get(rule.template_id);
    // execução própria e descartada: nada vai a catalogo_itens, catalogo_cursores, sent_offers nem ao log do
    // catálogo; Novidades sem cursor pronto não lê (a regra mostra primeira_leitura na fonte, em GET /api/rules)
    const picked = await pickOffers(rule, rule.per_run, novaExecucao(), { previa: true });
    const nome = (id) => db.prepare('SELECT name FROM tags WHERE id = ?').get(id)?.name;
    const linkPrevia = (o) => (!o.catalogo || o.loja === 'ml' ? LINK_ML_PREVIA
      : o.loja === 'amazon' ? `https://www.amazon.com.br/dp/${o.asin}?tag=•••` : o.link);
    return picked.map((o) => {
      const motivos = o.catalogo ? o.motivos : [];
      const etiqueta = o.catalogo && o.loja !== 'ml' ? null : nome(o.tag_id) || nome(rule.tag_id) || null;
      // revisao/motivos: a oferta iria à revisão em vez de sair (o painel mostra "Esperaria revisão" e o motivo)
      return { ...o, etiqueta, fonte: (o.source_index ?? 0) + 1, revisao: motivos.length > 0, motivos, text: tpl ? renderTemplate(tpl.body, { ...o, link: linkPrevia(o) }, tplOpts()) : '' };
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

  // Ordem: envios vencidos → espelho → avisos → regras, com espelho e envios de novo depois de cada regra
  // (um agendado ou uma oferta espelhada espera no máximo a regra em andamento, não todas).
  async function tick() {
    if (ticking) return; ticking = true; acordado = false;
    try {
      await recuperacao; // o primeiro tick espera o recuperar() do start()
      await passoEnvios();
      await passo('espelho (fila)', semDetalhe(() => espelho.expirarFila())); // 'na_fila' esquecido → 'expirado'
      await passoEspelho();
      await passo('avisos', () => avisos.tick());
      const rules = db.prepare('SELECT * FROM rules WHERE enabled = 1').all().map(parseRule);
      for (const r of rules) {
        const now = Date.now();
        if (running.has(r.id) || (r.next_run_at && r.next_run_at > now)) continue;
        if (!inWindow(now, r.window_start, r.window_end)) {
          db.prepare('UPDATE rules SET next_run_at = ? WHERE id = ?').run(alignToWindow(now, r.window_start, r.window_end), r.id);
          continue;
        }
        if (!wa.isReady()) continue;
        await runRule(r.id);
        await passoEspelho();
        await passoEnvios();
      }
      // "agora" criado (ou mensagem espelhada recebida) depois da última passada: sai neste tick, não no próximo
      // (até 15 s depois). O espelho vem antes dos envios: o envio que ele criar sai na mesma volta.
      while (acordado) { acordado = false; await passoEspelho(); await passoEnvios(); }
    } catch (e) { console.error('[agendador]', e); } finally { ticking = false; }
  }

  return {
    // acordar: o "Enviar" aprovado na revisão do catálogo (src/catalogo-itens.js) pede o tick já
    runRule, previewOffers, tick, acordar, envios, avisos, amazon, shopee, espelho, catalogo, catalogoItens,
    start() {
      if (timer) return;
      // o que ficou 'enviando' (envios) ou 'processando' (espelho) quando o serviço caiu volta antes do primeiro tick
      recuperacao = Promise.all([passo('recuperar', () => envios.recuperar()), passo('espelho (recuperar)', semDetalhe(() => espelho.recuperar()))]);
      timer = setInterval(tick, 15000); primeiro = setTimeout(tick, 2000);
    },
    stop() { clearInterval(timer); clearTimeout(primeiro); timer = null; primeiro = null; },
    isRunning: (id) => running.has(id),
  };
}
