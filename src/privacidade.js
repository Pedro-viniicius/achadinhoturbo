// Privacidade (LGPD): pseudonimização dos participantes dos grupos e retenção dos dados.
//
// O WhatsApp entrega o número (ou LID) de quem entra, sai e lê. Para as métricas basta um
// identificador estável por pessoa, então guardamos HMAC-SHA256(chave local, id), não o número.
// A chave fica em `settings` e nunca sai do banco; sem ela não dá para voltar ao número.

import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';

const DIA = 86400000;
export const RETENCAO_PADRAO_DIAS = 90;
const bare = (j) => String(j || '').replace(/:\d+@/, '@');

export function chavePseudo(db) {
  let k = getSetting(db, 'pseudo_key');
  if (!k) { k = crypto.randomBytes(32).toString('hex'); setSetting(db, 'pseudo_key', k); }
  return k;
}

/** Id do participante -> pseudônimo de 32 hex. Idempotente: um pseudônimo não é re-hasheado. */
export function pseudonimo(db, id) {
  if (!id) return id;
  const s = bare(id);
  if (/^[a-f0-9]{32}$/.test(s)) return s;
  return crypto.createHmac('sha256', chavePseudo(db)).update(s).digest('hex').slice(0, 32);
}

/**
 * Apaga o que não deveria mais estar no banco, de forma idempotente: roda a cada start.
 * IPs de cliques (hoje gravados como NULL) e listas de telefones de admins em propostas antigas
 * (fica só a contagem). Devolve quantas linhas mudou.
 */
export function limparResiduos(db) {
  let n = db.prepare('UPDATE link_clicks SET ip_hash = NULL WHERE ip_hash IS NOT NULL').run().changes;
  for (const p of db.prepare("SELECT id, detail FROM group_proposals WHERE detail LIKE '%admins_%'").all()) {
    try {
      const d = JSON.parse(p.detail);
      if (!Array.isArray(d.admins_adicionados) && !Array.isArray(d.admins_nao_adicionados)) continue;
      const conta = (x) => (Array.isArray(x) ? x.length : x);
      db.prepare('UPDATE group_proposals SET detail = ? WHERE id = ?').run(JSON.stringify({ ...d, admins_adicionados: conta(d.admins_adicionados), admins_nao_adicionados: conta(d.admins_nao_adicionados) }), p.id);
      n++;
    } catch { /* detalhe não é JSON: deixa */ }
  }
  return n;
}

/** Converte, uma vez só, os números já gravados em pseudônimos; a limpeza de resíduos roda sempre. */
export function migrarPseudonimos(db) {
  const residuos = limparResiduos(db);
  if (getSetting(db, 'pseudo_migrated')) return residuos;
  let n = residuos;
  db.exec('BEGIN');
  try {
    const upd = db.prepare('UPDATE group_events SET participant = ?, actor = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, participant, actor FROM group_events').all()) {
      upd.run(pseudonimo(db, r.participant), r.actor ? pseudonimo(db, r.actor) : null, r.id); n++;
    }
    const reads = db.prepare('SELECT jid, participant, day, ts FROM group_reads').all();
    db.exec('DELETE FROM group_reads');
    const ins = db.prepare('INSERT OR IGNORE INTO group_reads (jid, participant, day, ts) VALUES (?,?,?,?)');
    for (const r of reads) { ins.run(r.jid, pseudonimo(db, r.participant), r.day, r.ts); n++; }
    setSetting(db, 'pseudo_migrated', '1');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

/** Apaga eventos, leituras e cliques mais velhos que `dias` e sessões vencidas. 0 = não apaga. */
export function limparAntigos(db, dias = RETENCAO_PADRAO_DIAS, now = Date.now()) {
  const out = { sessoes: db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now).changes };
  if (!(dias > 0)) return out;
  const corte = now - dias * DIA;
  out.eventos = db.prepare('DELETE FROM group_events WHERE ts < ?').run(corte).changes;
  out.leituras = db.prepare('DELETE FROM group_reads WHERE ts < ?').run(corte).changes;
  out.cliques = db.prepare('DELETE FROM link_clicks WHERE ts < ?').run(corte).changes;
  return out;
}

/** Exclusão por titular: apaga tudo de um participante (número, LID ou pseudônimo). */
export function apagarParticipante(db, id) {
  const s = String(id || '').trim();
  const p = pseudonimo(db, /@/.test(s) || /^[a-f0-9]{32}$/.test(s) ? s : s.replace(/\D/g, '') + '@s.whatsapp.net'); // número puro -> jid
  return {
    eventos: db.prepare('DELETE FROM group_events WHERE participant = ? OR actor = ?').run(p, p).changes,
    leituras: db.prepare('DELETE FROM group_reads WHERE participant = ?').run(p).changes,
  };
}

/** Chave de limite por IP: IPv6 agrupado por /64, para o freio não ser contornado trocando o sufixo. */
export function chaveIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (!s.includes(':')) return s;
  // expande o "::" antes de cortar, senão um prefixo com hextets zero deixaria parte do sufixo entrar na chave
  const [esq, dir = ''] = s.split('::');
  const a = esq ? esq.split(':') : []; const b = dir ? dir.split(':') : [];
  const cheio = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return cheio.slice(0, 4).map((h) => h.toLowerCase().replace(/^0+(?=\w)/, '')).join(':') + '::/64';
}
