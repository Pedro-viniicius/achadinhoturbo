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
