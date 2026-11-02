import { addLog, parseRule, getSetting } from './db.js';
import { renderTemplate } from './template.js';
import * as mlDefault from './ml.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (s) => Math.round(s * 1000 * (0.7 + Math.random() * 0.6));
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

export function createScheduler({ db, wa, links, ml = mlDefault, fast = false }) {
  const running = new Set();
  let timer = null; let ticking = false;

  const getRule = (id) => parseRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(id));
  const delays = () => fast ? { group: 0, offer: 0 } : {
    group: Number(getSetting(db, 'delay_group_s', 6)),
    offer: Number(getSetting(db, 'delay_offer_s', 30)),
  };
  const log = (rule, o) => addLog(db, { rule, ...o });

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
      for (let i = 0; i < picked.length; i++) {
        const offer = picked[i];
        let link;
        try { link = await links.requestLink({ url: offer.url, tag: tag.name }); } catch (e) {
          log(rule, { level: 'erro', offer_title: offer.title, message: 'Link de afiliado não gerado: ' + e.message });
          summary.errors++; continue;
        }
        const text = renderTemplate(tpl.body, { ...offer, link });
        summary.offers++; let okCount = 0;
        for (let g = 0; g < groups.length; g++) {
          try {
            if (rule.send_image && offer.image) {
              try { await wa.sendImage(groups[g].jid, offer.image, text); } catch { await wa.sendText(groups[g].jid, text); }
            } else await wa.sendText(groups[g].jid, text);
            okCount++; summary.messages++;
            log(rule, { level: 'ok', group_name: groups[g].name, offer_title: offer.title, message: `Enviado com a etiqueta ${tag.name}` });
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
    return picked.map((o) => ({ ...o, text: tpl ? renderTemplate(tpl.body, { ...o, link: 'https://meli.la/(gerado no envio)' }) : '' }));
  }

  async function tick() {
    if (ticking) return; ticking = true;
    try {
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
      }
    } catch (e) { console.error('[agendador]', e); } finally { ticking = false; }
  }

  return {
    runRule, previewOffers, tick,
    start() { if (!timer) { timer = setInterval(tick, 15000); setTimeout(tick, 2000); } },
    stop() { clearInterval(timer); timer = null; },
    isRunning: (id) => running.has(id),
  };
}
