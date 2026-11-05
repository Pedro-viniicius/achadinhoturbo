import { addLog, parseRule, getSetting } from './db.js';
import { renderTemplate } from './template.js';
import * as mlDefault from './ml.js';
import { imagemPermitida } from './lojas.js';
import { motivosDeRevisao, precisaEtiqueta } from './catalogo.js';
import { createEnvios } from './envios.js';
import { createAvisos } from './avisos.js';
import { createEspelho } from './espelho.js';
import { createRemetentes } from './remetentes.js';
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
 * Remetentes (src/remetentes.js, plano envio-pelo-socio D9): o ouvinte privado do WhatsApp (ligado em src/server.js)
 * entrega a remetentes.receber(); o tick responde às mensagens já decididas e decide os itens recebidos logo depois
 * do espelho, e o que sai vai pela mesma fila de envios.
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
  // idem para a mensagem privada de um remetente cadastrado (receber) e para cada envio que ela cria
  const remetentes = createRemetentes({ db, wa, envios, acordar });

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
      for (let i = 0; i < picked.length; i++) {
        const offer = picked[i]; const etq = tagDaFonte(offer);
        let link;
        if (offer.catalogo) {
          // revisão em vez de envio (D5): Shopee, preço suspeito ou falha do link deste item
          let motivos = offer.motivos; let detalhe = '';
          if (!motivos.length) {
            const r = await linkDoCatalogo(offer, etq);
            if (r.espera) { esperar(exec, r.espera); continue; }
            if (r.link) link = r.link;
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
          try { link = await links.requestLink({ url: offer.url, tag: etq.name }); } catch (e) {
            log(rule, { level: 'erro', offer_title: offer.title, message: 'Link de afiliado não gerado: ' + e.message });
            summary.errors++; continue;
          }
        }
        const text = renderTemplate(tpl.body, { ...offer, link }, tplOpts());
        summary.offers++; let okCount = 0;
        // foto só do CDN da loja da oferta (D9, CA5); as fontes antigas são do Mercado Livre
        const fotoOk = rule.send_image && imagemPermitida(offer.plataforma || 'mercadolivre', offer.image);
        const comoSaiu = offer.catalogo && offer.loja === 'amazon' ? 'Enviado pela Amazon, com a sua tag' : `Enviado com a etiqueta ${etq.name}`;
        for (let g = 0; g < groups.length; g++) {
          try {
            if (fotoOk) {
              try { await wa.sendImage(groups[g].jid, offer.image, text); } catch { await wa.sendText(groups[g].jid, text); }
            } else await wa.sendText(groups[g].jid, text);
            okCount++; summary.messages++;
            log(rule, { level: 'ok', group_name: groups[g].name, offer_title: offer.title, message: `${comoSaiu}${picked.some((p) => p.source_index !== offer.source_index) ? ` (fonte ${(offer.source_index ?? 0) + 1})` : ''}` });
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
  /**
   * Remetentes (D9): primeiro as respostas às mensagens cujos envios terminaram, depois a decisão dos itens recebidos
   * (cada "enviar" grava um envio pendente e acorda o tick). Passos separados: a falha de um não impede o outro. Sem a
   * mensagem do erro no console (semDetalhe): a de uma biblioteca pode trazer o número do remetente.
   */
  async function passoRemetentes() {
    await passo('remetentes (respostas)', semDetalhe(() => remetentes.responderPendentes()));
    await passo('remetentes', semDetalhe(() => remetentes.processarPendentes()));
  }

  // Ordem: envios vencidos → espelho → remetentes → avisos → regras, com espelho, remetentes e envios de novo depois
  // de cada regra (um agendado, uma oferta espelhada ou um link de remetente espera no máximo a regra em andamento).
  async function tick() {
    if (ticking) return; ticking = true; acordado = false;
    try {
      await recuperacao; // o primeiro tick espera o recuperar() do start()
      await passoEnvios();
      await passo('espelho (fila)', semDetalhe(() => espelho.expirarFila())); // 'na_fila' esquecido → 'expirado'
      await passoEspelho();
      await passoRemetentes();
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
        await passoRemetentes();
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
    runRule, previewOffers, tick, acordar, envios, avisos, amazon, shopee, espelho, remetentes, catalogo, catalogoItens,
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
