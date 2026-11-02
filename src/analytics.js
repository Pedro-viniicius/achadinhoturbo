// Números da Visão Geral, calculados a partir dos eventos de grupo (entradas/saídas),
// das leituras das suas mensagens e dos cliques nos links do rotacionador.

const DAY = 86400000;

export function dayOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
const endOfDay = (ts) => startOfDay(ts) + DAY - 1;
const parseDay = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

/** 'hoje' | 'ontem' | '7d' | '30d' | 'mes' | 'mes_passado' | custom {de:'YYYY-MM-DD', ate:'YYYY-MM-DD'} */
export function periodRange(periodo, now = Date.now(), custom = {}) {
  const sod = startOfDay(now);
  switch (periodo) {
    case 'ontem': return { de: sod - DAY, ate: sod - 1 };
    case '7d': return { de: sod - 6 * DAY, ate: endOfDay(now) };
    case '30d': return { de: sod - 29 * DAY, ate: endOfDay(now) };
    case 'mes': { const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0); return { de: d.getTime(), ate: endOfDay(now) }; }
    case 'mes_passado': {
      const fim = new Date(now); fim.setDate(0); // último dia do mês passado
      const ini = new Date(fim); ini.setDate(1); ini.setHours(0, 0, 0, 0);
      return { de: ini.getTime(), ate: endOfDay(fim.getTime()) };
    }
    case 'custom': {
      const de = custom.de ? parseDay(custom.de) : sod; const ate = custom.ate ? endOfDay(parseDay(custom.ate)) : endOfDay(now);
      return de <= ate ? { de, ate } : { de: ate - DAY + 1, ate };
    }
    default: return { de: sod, ate: endOfDay(now) };
  }
}

function inClause(col, jids) {
  if (!jids) return { sql: '', params: [] };
  if (!jids.length) return { sql: ' AND 0', params: [] };
  return { sql: ` AND ${col} IN (${jids.map(() => '?').join(',')})`, params: jids };
}
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Métricas de um período. `jids` = null para todos os grupos, ou a lista de um bloco. */
export function overview(db, { de, ate, jids = null, now = Date.now() }) {
  const f = inClause('a.jid', jids); const fr = inClause('r.jid', jids); const fg = inClause('g.jid', jids);
  const fc = inClause('c.jid', jids); const fl = inClause('l.jid', jids);

  const entradas = db.prepare(`SELECT a.jid, a.participant, a.ts, a.by_link,
      (SELECT MIN(r.ts) FROM group_events r WHERE r.jid = a.jid AND r.participant = a.participant AND r.action = 'remove' AND r.ts > a.ts) AS left_ts
    FROM group_events a WHERE a.action = 'add' AND a.ts BETWEEN ? AND ?${f.sql} ORDER BY a.ts`).all(de, ate, ...f.params);
  const saidas = db.prepare(`SELECT r.jid, r.participant, r.ts, r.actor,
      (SELECT MAX(a.ts) FROM group_events a WHERE a.jid = r.jid AND a.participant = r.participant AND a.action = 'add' AND a.ts < r.ts) AS entered_ts
    FROM group_events r WHERE r.action = 'remove' AND r.ts BETWEEN ? AND ?${fr.sql} ORDER BY r.ts`).all(de, ate, ...fr.params);
  const cliques = db.prepare(`SELECT COUNT(*) AS n FROM link_clicks c WHERE c.ts BETWEEN ? AND ?${fc.sql}`).get(de, ate, ...fc.params).n;
  const abriram = db.prepare(`SELECT COUNT(DISTINCT l.participant) AS n FROM group_reads l WHERE l.ts BETWEEN ? AND ?${fl.sql}`).get(de, ate, ...fl.params).n;
  const grupos = db.prepare(`SELECT g.* FROM groups g WHERE 1${fg.sql} ORDER BY g.name COLLATE NOCASE`).all(...fg.params);
  const membros = grupos.reduce((s, g) => s + (g.size || 0), 0);

  const mesmoDia = (a, b) => dayOf(a) === dayOf(b);
  const entradasMesmoDia = entradas.filter((e) => e.left_ts && mesmoDia(e.ts, e.left_ts)).length;
  const entradas7d = entradas.filter((e) => e.left_ts && e.left_ts - e.ts <= 7 * DAY).length;
  const saidasMesmoDia = saidas.filter((s) => s.entered_ts && mesmoDia(s.entered_ts, s.ts)).length;
  const tempos = saidas.filter((s) => s.entered_ts).map((s) => s.ts - s.entered_ts);

  // Quem ainda está: pessoas que vimos entrar (qualquer data) e não vimos sair.
  const ativos = db.prepare(`SELECT a.ts FROM group_events a WHERE a.action = 'add'${f.sql}
    AND NOT EXISTS (SELECT 1 FROM group_events r WHERE r.jid = a.jid AND r.participant = a.participant AND r.action = 'remove' AND r.ts > a.ts)`).all(...f.params);
  const primeiroEvento = db.prepare(`SELECT MIN(a.ts) AS t FROM group_events a WHERE 1${f.sql}`).get(...f.params).t;

  // Série: por hora quando o período cabe num dia, senão por dia.
  const porHora = ate - de < DAY;
  const chave = (ts) => (porHora ? new Date(ts).getHours() : dayOf(ts));
  const serieMap = new Map();
  if (porHora) for (let h = 0; h < 24; h++) serieMap.set(h, { k: h, entradas: 0, saidas: 0, saidas_mesmo_dia: 0 });
  else for (let t = startOfDay(de); t <= ate; t += DAY) serieMap.set(dayOf(t), { k: dayOf(t), entradas: 0, saidas: 0, saidas_mesmo_dia: 0 });
  for (const e of entradas) { const b = serieMap.get(chave(e.ts)); if (b) b.entradas++; }
  for (const s of saidas) { const b = serieMap.get(chave(s.ts)); if (b) { b.saidas++; if (s.entered_ts && mesmoDia(s.entered_ts, s.ts)) b.saidas_mesmo_dia++; } }

  const porGrupo = grupos.map((g) => {
    const ent = entradas.filter((e) => e.jid === g.jid); const sai = saidas.filter((s) => s.jid === g.jid);
    const ab = db.prepare('SELECT COUNT(DISTINCT participant) AS n FROM group_reads WHERE jid = ? AND ts BETWEEN ? AND ?').get(g.jid, de, ate).n;
    return {
      jid: g.jid, name: g.name, membros: g.size || 0, abriram: ab, abriram_pct: pct(ab, g.size || 0),
      entradas: ent.length, pelo_link: ent.filter((e) => e.by_link).length, adicionados: ent.filter((e) => !e.by_link).length,
      saidas: sai.length, mesmo_dia: sai.filter((s) => s.entered_ts && mesmoDia(s.entered_ts, s.ts)).length,
    };
  });

  const eventos = db.prepare(`SELECT e.ts, e.jid, e.participant, e.action, e.by_link, e.actor, g.name AS group_name
    FROM group_events e LEFT JOIN groups g ON g.jid = e.jid WHERE e.ts BETWEEN ? AND ?${inClause('e.jid', jids).sql} ORDER BY e.ts DESC LIMIT 200`).all(de, ate, ...(jids || []));

  const anteriorRange = { de: de - (ate - de + 1), ate: de - 1 };
  return {
    periodo: { de, ate, por_hora: porHora },
    membros, grupos: grupos.length,
    cliques, entradas: entradas.length, entradas_link: entradas.filter((e) => e.by_link).length,
    entradas_add: entradas.filter((e) => !e.by_link).length,
    saidas: saidas.length, saidas_mesmo_dia: saidasMesmoDia, saldo: entradas.length - saidas.length,
    tempo_medio_min: tempos.length ? Math.round(avg(tempos) / 60000) : null, saidas_com_entrada: tempos.length,
    permanencia_atual_min: ativos.length ? Math.round(avg(ativos.map((a) => now - a.ts)) / 60000) : null, ativos: ativos.length,
    desde: primeiroEvento,
    abriram, abriram_pct: pct(abriram, membros),
    evasao: {
      entrou_dia: { pct: pct(entradasMesmoDia, entradas.length), n: entradasMesmoDia, de: entradas.length, fechado: ate < now },
      em_7d: { pct: pct(entradas7d, entradas.length), n: entradas7d, de: entradas.length, fechado: now - ate > 7 * DAY },
      total_dia: { pct: pct(saidas.length, membros + saidas.length), n: saidas.length, de: membros + saidas.length },
    },
    serie: [...serieMap.values()], por_grupo: porGrupo, eventos, anterior: anteriorRange,
  };
}

/** Resumo do período anterior (para "ontem: N"). */
export function resumo(db, { de, ate, jids = null }) {
  const f = inClause('jid', jids);
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  return {
    cliques: n(`SELECT COUNT(*) AS n FROM link_clicks WHERE ts BETWEEN ? AND ?${f.sql}`, de, ate, ...f.params),
    entradas: n(`SELECT COUNT(*) AS n FROM group_events WHERE action = 'add' AND ts BETWEEN ? AND ?${f.sql}`, de, ate, ...f.params),
    saidas: n(`SELECT COUNT(*) AS n FROM group_events WHERE action = 'remove' AND ts BETWEEN ? AND ?${f.sql}`, de, ate, ...f.params),
    abriram: n(`SELECT COUNT(DISTINCT participant) AS n FROM group_reads WHERE ts BETWEEN ? AND ?${f.sql}`, de, ate, ...f.params),
  };
}

/** Evasão de um dia específico (entrou no dia e saiu no mesmo dia). */
export function evasaoDoDia(db, diaTs, jids = null) {
  const { de, ate } = { de: startOfDay(diaTs), ate: endOfDay(diaTs) };
  const f = inClause('a.jid', jids);
  const rows = db.prepare(`SELECT a.ts,
      (SELECT MIN(r.ts) FROM group_events r WHERE r.jid = a.jid AND r.participant = a.participant AND r.action = 'remove' AND r.ts > a.ts) AS left_ts
    FROM group_events a WHERE a.action = 'add' AND a.ts BETWEEN ? AND ?${f.sql}`).all(de, ate, ...f.params);
  const n = rows.filter((r) => r.left_ts && dayOf(r.left_ts) === dayOf(r.ts)).length;
  return { pct: pct(n, rows.length), n, de: rows.length, dia: dayOf(diaTs) };
}
