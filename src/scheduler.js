import { addLog, parseRule, getSetting } from './db.js';
import { renderTemplate } from './template.js';
import * as mlDefault from './ml.js';
import { IMAGEM_PERMITIDA } from './ml.js';
import { createEnvios } from './envios.js';
import { createAvisos } from './avisos.js';
import { createEspelho } from './espelho.js';
import { sleep, jitter } from './util.js';

// Pausas entre mensagens: moram em ./util.js (src/envios.js usa o mesmo ritmo anti-bloqueio); reexportadas aqui.
export { sleep, jitter };
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
 */
export function createScheduler({ db, wa, links, ml = mlDefault, fast = false, dir = null, amazon = null, shopee = null }) {
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

  /** Escolhe as próximas ofertas da regra (sem enviar nada). */
  async function pickOffers(rule, want) {
    const cands = await ml.candidates(rule, { links, onWarn: (m) => log(rule, { level: 'aviso', message: m }) });
    const picked = []; let tried = 0; const maxTries = Math.max(want * 8, 10);
    for (const c of cands) {
      if (picked.length >= want || tried >= maxTries) break;
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
    const summary = { offers: 0, messages: 0, errors: 0 };
    let retrySoon = false;
    try {
      if (!wa.isReady()) {
        log(rule, { level: 'erro', message: 'WhatsApp desconectado: nada foi enviado.' });
        retrySoon = true; summary.errors++; return summary;
      }
      const tag = rule.tag_id && db.prepare('SELECT * FROM tags WHERE id = ?').get(rule.tag_id);
      const tpl = rule.template_id && db.prepare('SELECT * FROM templates WHERE id = ?').get(rule.template_id);
      const groups = rule.group_jids
        .map((jid) => db.prepare('SELECT * FROM groups WHERE jid = ?').get(jid)).filter(Boolean);
      const problem = !tag ? 'escolha uma etiqueta' : !tpl ? 'escolha um template' : !groups.length ? 'escolha ao menos um grupo' : null;
      if (problem) { log(rule, { level: 'erro', message: `Regra incompleta: ${problem}.` }); summary.errors++; return summary; }

      let picked;
      try { picked = await pickOffers(rule, rule.per_run); } catch (e) {
        log(rule, { level: 'erro', message: 'Não consegui buscar ofertas: ' + e.message }); summary.errors++; return summary;
      }
      if (!picked.length) { log(rule, { level: 'info', message: 'Sem ofertas novas dentro dos filtros desta vez.' }); return summary; }

      const d = delays();
      const tagDaFonte = (o) => (o.tag_id && db.prepare('SELECT * FROM tags WHERE id = ?').get(o.tag_id)) || tag;
      for (let i = 0; i < picked.length; i++) {
        const offer = picked[i]; const etq = tagDaFonte(offer);
        let link;
        try { link = await links.requestLink({ url: offer.url, tag: etq.name }); } catch (e) {
          log(rule, { level: 'erro', offer_title: offer.title, message: 'Link de afiliado não gerado: ' + e.message });
          summary.errors++; continue;
        }
        const text = renderTemplate(tpl.body, { ...offer, link }, tplOpts());
        summary.offers++; let okCount = 0;
        for (let g = 0; g < groups.length; g++) {
          try {
            if (rule.send_image && IMAGEM_PERMITIDA.test(offer.image || '')) {
              try { await wa.sendImage(groups[g].jid, offer.image, text); } catch { await wa.sendText(groups[g].jid, text); }
            } else await wa.sendText(groups[g].jid, text);
            okCount++; summary.messages++;
            log(rule, { level: 'ok', group_name: groups[g].name, offer_title: offer.title, message: `Enviado com a etiqueta ${etq.name}${picked.some((p) => p.source_index !== offer.source_index) ? ` (fonte ${(offer.source_index ?? 0) + 1})` : ''}` });
          } catch (e) {
            summary.errors++;
            log(rule, { level: 'erro', group_name: groups[g].name, offer_title: offer.title, message: 'Falha no envio: ' + e.message });
          }
          if (g < groups.length - 1) await sleep(jitter(d.group));
        }
        if (okCount) db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (?,?,?)').run(rule.id, offer.key, Date.now());
        if (i < picked.length - 1) await sleep(jitter(d.offer));
      }
      return summary;
    } finally {
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
    const picked = await pickOffers(rule, rule.per_run);
    const nome = (id) => db.prepare('SELECT name FROM tags WHERE id = ?').get(id)?.name;
    return picked.map((o) => ({ ...o, etiqueta: nome(o.tag_id) || nome(rule.tag_id) || null, fonte: (o.source_index ?? 0) + 1, text: tpl ? renderTemplate(tpl.body, { ...o, link: 'https://meli.la/(gerado no envio)' }, tplOpts()) : '' }));
  }

  /** Envios e avisos chamados pelo tick: se falharem, registra e segue, para nunca travar as regras. */
  async function passo(nome, fn) {
    try { await fn(); } catch (e) { console.error(`[agendador] ${nome}:`, e?.message || e); }
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
      await passo('envios', () => envios.processarPendentes());
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
        await passo('envios', () => envios.processarPendentes());
      }
      // "agora" criado (ou mensagem espelhada recebida) depois da última passada: sai neste tick, não no próximo
      // (até 15 s depois). O espelho vem antes dos envios: o envio que ele criar sai na mesma volta.
      while (acordado) { acordado = false; await passoEspelho(); await passo('envios', () => envios.processarPendentes()); }
    } catch (e) { console.error('[agendador]', e); } finally { ticking = false; }
  }

  return {
    runRule, previewOffers, tick, envios, avisos, amazon, shopee, espelho,
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
