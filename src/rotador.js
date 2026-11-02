// Rotacionador de links: um endereço público (/g/<slug>) que leva para o primeiro grupo da lista
// que ainda tem vaga. Modos: 'fill' (encher um por vez), 'alternate' (alternar entre até 3 com vaga)
// e 'reopen' (encher um por vez; o que lotou só volta a receber quando cair abaixo de um número).

export const MODOS = [
  { id: 'fill', name: 'Encher um grupo por vez', desc: 'O primeiro grupo enche, depois o segundo, e assim por diante.' },
  { id: 'alternate', name: 'Alternar entre grupos com vaga', desc: 'Divide os cliques entre os 3 primeiros grupos com vaga. Deixa o cruzamento clique → entrada mais preciso nos picos.' },
  { id: 'reopen', name: 'Encher e reabrir quando esvaziar', desc: 'Enche um grupo por vez. O grupo que lotou só volta a receber pessoas quando cair para o número de membros que você escolher.' },
];
export const LIMITE_MAX = 1024;

export function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function parseLink(row) {
  if (!row) return null;
  let group_jids = []; let state = {};
  try { group_jids = JSON.parse(row.group_jids || '[]'); } catch { /* vazio */ }
  try { state = JSON.parse(row.state || '{}'); } catch { /* vazio */ }
  return { ...row, enabled: !!row.enabled, group_jids, state: { closed: {}, rr: 0, ...state } };
}

/**
 * Escolhe o grupo de destino. `groupsByJid` = { jid: { size, invite_code } }.
 * Devolve { group, state } (state atualizado para gravar) ou { group: null } se todos lotaram.
 */
export function pickGroup(link, groupsByJid, now = Date.now()) {
  const limit = Math.min(Math.max(Number(link.limit_members) || 1000, 2), LIMITE_MAX);
  const state = { closed: {}, rr: 0, ...(link.state || {}) };
  const cands = (link.group_jids || []).map((jid) => groupsByJid[jid]).filter((g) => g && g.invite_code);
  const comVaga = (g) => (g.size || 0) < limit;

  if (link.mode === 'alternate') {
    const abertos = cands.filter(comVaga).slice(0, 3);
    if (!abertos.length) return { group: null, state };
    const idx = state.rr % abertos.length;
    return { group: abertos[idx], state: { ...state, rr: (idx + 1) % abertos.length } };
  }
  if (link.mode === 'reopen') {
    const reabre = Math.max(1, Number(link.reopen_below) || Math.floor(limit * 0.9));
    const closed = { ...state.closed };
    for (const g of cands) {
      if (closed[g.jid] && (g.size || 0) <= reabre) delete closed[g.jid];
      else if (!closed[g.jid] && (g.size || 0) >= limit) closed[g.jid] = now;
    }
    const g = cands.find((c) => !closed[c.jid] && comVaga(c)) || null;
    return { group: g, state: { ...state, closed } };
  }
  return { group: cands.find(comVaga) || null, state };
}

/** "Achadinhos #4" -> "Achadinhos #5"; "Grupo 12" -> "Grupo 13"; "Ofertas" -> "Ofertas #2". */
export function proximoNome(nome) {
  const m = String(nome || '').match(/^(.*?)(\d+)(\s*)$/);
  if (m) return `${m[1]}${String(Number(m[2]) + 1).padStart(m[2].length, '0')}${m[3]}`.trim();
  return `${String(nome || 'Grupo').trim()} #2`;
}

export const LOTACAO_PCT = 95;

/**
 * Para cada link com "criar próximo grupo" ligado, propõe um grupo novo quando algum grupo da lista
 * chega a 95% do limite e ainda não há proposta para ele. Só registra a proposta: quem cria é você, no painel.
 */
export function verificarLotacao(db, now = Date.now()) {
  const novas = [];
  const links = db.prepare('SELECT * FROM links WHERE enabled = 1 AND auto_next = 1').all().map(parseLink);
  for (const l of links) {
    const limit = Math.min(Math.max(Number(l.limit_members) || 1000, 2), LIMITE_MAX);
    for (const jid of l.group_jids) {
      const g = db.prepare('SELECT jid, name, size FROM groups WHERE jid = ?').get(jid);
      if (!g || (g.size || 0) < Math.ceil((limit * LOTACAO_PCT) / 100)) continue;
      if (db.prepare("SELECT 1 FROM group_proposals WHERE link_id = ? AND source_jid = ? AND status IN ('pending', 'created')").get(l.id, jid)) continue;
      const nome = proximoNome(g.name);
      const id = db.prepare('INSERT INTO group_proposals (link_id, source_jid, name, status, created_at) VALUES (?,?,?,?,?)').run(l.id, jid, nome, 'pending', now).lastInsertRowid;
      novas.push({ id, link_id: l.id, source_jid: jid, name: nome });
    }
  }
  return novas;
}

/** Encaixa o grupo novo logo depois do que lotou: no link, nos blocos e nas regras do grupo de origem. */
export function encaixarGrupoNovo(db, { linkId, sourceJid, newJid }) {
  const l = parseLink(db.prepare('SELECT * FROM links WHERE id = ?').get(linkId));
  if (l && !l.group_jids.includes(newJid)) {
    const i = l.group_jids.indexOf(sourceJid);
    l.group_jids.splice(i >= 0 ? i + 1 : l.group_jids.length, 0, newJid);
    db.prepare('UPDATE links SET group_jids = ? WHERE id = ?').run(JSON.stringify(l.group_jids), linkId);
  }
  for (const b of db.prepare('SELECT block_id FROM block_groups WHERE jid = ?').all(sourceJid)) {
    db.prepare('INSERT OR IGNORE INTO block_groups (block_id, jid) VALUES (?,?)').run(b.block_id, newJid);
  }
  for (const r of db.prepare('SELECT id, group_jids FROM rules').all()) {
    let jids = []; try { jids = JSON.parse(r.group_jids || '[]'); } catch { /* vazio */ }
    if (jids.includes(sourceJid) && !jids.includes(newJid)) {
      jids.push(newJid); db.prepare('UPDATE rules SET group_jids = ? WHERE id = ?').run(JSON.stringify(jids), r.id);
    }
  }
}

/** Situação de cada grupo do link, para mostrar no painel. */
export function statusDosGrupos(link, groupsByJid) {
  const limit = Math.min(Math.max(Number(link.limit_members) || 1000, 2), LIMITE_MAX);
  return (link.group_jids || []).map((jid) => {
    const g = groupsByJid[jid];
    const size = g?.size || 0;
    const situacao = !g ? 'removido' : !g.invite_code ? 'sem convite' : link.state?.closed?.[jid] ? 'fechado' : size >= limit ? 'lotado' : 'aberto';
    return { jid, name: g?.name || jid, size, limit, pct: Math.min(100, Math.round((size / limit) * 100)), situacao };
  });
}
