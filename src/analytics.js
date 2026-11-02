// Números da Visão Geral, calculados a partir dos eventos de grupo (entradas/saídas),
// das leituras das suas mensagens e dos cliques nos links do rotacionador.

const DAY = 86400000;

// Virada do dia (`viradaMin`, minutos depois da meia-noite, 0 a 1439): o "dia de negócio" começa nesse horário.
// Com virada 02:00, uma entrada à 01:30 conta para o dia anterior. Padrão 0 = meia-noite (comportamento antigo).
const virada = (v) => { const n = Math.trunc(Number(v)); return n > 0 && n < 1440 ? n : 0; };
/** Data local em que começou o dia de negócio que contém `ts`, já no horário da virada. */
function inicioDoDia(ts, viradaMin) {
  const v = virada(viradaMin); const d = new Date(ts);
  if (d.getHours() * 60 + d.getMinutes() < v) d.setDate(d.getDate() - 1);
  d.setHours(Math.floor(v / 60), v % 60, 0, 0);
  return d;
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** 'YYYY-MM-DD' do dia de negócio de `ts`. */
export function dayOf(ts, viradaMin = 0) { return ymd(inicioDoDia(ts, viradaMin)); }
export function startOfDay(ts, viradaMin = 0) { return inicioDoDia(ts, viradaMin).getTime(); }
/** Início do dia de negócio `n` dias antes (ou depois, n < 0) pelo calendário: não escorrega numa troca de horário. */
const diasAntes = (inicio, n) => { const d = new Date(inicio); d.setDate(d.getDate() - n); return d.getTime(); };
const endOfDay = (ts, viradaMin = 0) => diasAntes(startOfDay(ts, viradaMin), -1) - 1;
const parseDay = (s, viradaMin = 0) => {
  const [y, m, d] = String(s).split('-').map(Number); const v = virada(viradaMin);
  return new Date(y, m - 1, d, Math.floor(v / 60), v % 60).getTime();
};

/** 'hoje' | 'ontem' | '7d' | '30d' | 'mes' | 'mes_passado' | custom {de:'YYYY-MM-DD', ate:'YYYY-MM-DD'}. Dias de negócio (viradaMin). */
export function periodRange(periodo, now = Date.now(), custom = {}, viradaMin = 0) {
  const v = virada(viradaMin);
  const sod = startOfDay(now, v); const fim = endOfDay(now, v);
  switch (periodo) {
    case 'ontem': return { de: diasAntes(sod, 1), ate: sod - 1 };
    case '7d': return { de: diasAntes(sod, 6), ate: fim };
    case '30d': return { de: diasAntes(sod, 29), ate: fim };
    case 'mes': { const d = new Date(sod); d.setDate(1); return { de: d.getTime(), ate: fim }; }
    case 'mes_passado': {
      const ult = new Date(sod); ult.setDate(0); // último dia do mês passado, no horário da virada
      const ini = new Date(ult); ini.setDate(1);
      return { de: ini.getTime(), ate: endOfDay(ult.getTime(), v) };
    }
    case 'custom': {
      let de = custom.de ? parseDay(custom.de, v) : sod; const ate = custom.ate ? endOfDay(parseDay(custom.ate, v), v) : fim;
      if (!Number.isFinite(de) || !Number.isFinite(ate)) return { de: sod, ate: fim };
      if (de > ate) de = ate - DAY + 1;
      if (ate - de > 366 * DAY) de = ate - 366 * DAY; // no máximo um ano, para a série não explodir
      return { de, ate };
    }
    default: return { de: sod, ate: fim };
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
export function overview(db, { de, ate, jids = null, now = Date.now(), viradaMin = 0 }) {
  const v = virada(viradaMin);
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

  const mesmoDia = (a, b) => dayOf(a, v) === dayOf(b, v);
  const entradasMesmoDia = entradas.filter((e) => e.left_ts && mesmoDia(e.ts, e.left_ts)).length;
  const entradas7d = entradas.filter((e) => e.left_ts && e.left_ts - e.ts <= 7 * DAY).length;
  const saidasMesmoDia = saidas.filter((s) => s.entered_ts && mesmoDia(s.entered_ts, s.ts)).length;
  const tempos = saidas.filter((s) => s.entered_ts).map((s) => s.ts - s.entered_ts);

  // Quem ainda está: pessoas que vimos entrar (qualquer data) e não vimos sair.
  const ativos = db.prepare(`SELECT a.ts FROM group_events a WHERE a.action = 'add'${f.sql}
    AND NOT EXISTS (SELECT 1 FROM group_events r WHERE r.jid = a.jid AND r.participant = a.participant AND r.action = 'remove' AND r.ts > a.ts)`).all(...f.params);
  const primeiroEvento = db.prepare(`SELECT MIN(a.ts) AS t FROM group_events a WHERE 1${f.sql}`).get(...f.params).t;

  // Série: por hora quando o período cabe num dia (começando na hora da virada), senão por dia de negócio.
  const porHora = ate - de < DAY;
  const chave = (ts) => (porHora ? new Date(ts).getHours() : dayOf(ts, v));
  const serieMap = new Map();
  if (porHora) for (let i = 0; i < 24; i++) { const h = (Math.floor(v / 60) + i) % 24; serieMap.set(h, { k: h, entradas: 0, saidas: 0, saidas_mesmo_dia: 0 }); }
  else for (let t = startOfDay(de, v); t <= ate; t = diasAntes(t, -1)) serieMap.set(dayOf(t, v), { k: dayOf(t, v), entradas: 0, saidas: 0, saidas_mesmo_dia: 0 });
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

/**
 * Contagens de um período (para "ontem: N" e o resumo diário). Recebe `de`/`ate` prontos: para um dia de negócio,
 * calcule-os com periodRange(…, viradaMin) ou passe `dia` (um ts dentro do dia) + `viradaMin`, que têm preferência.
 */
export function resumo(db, { de, ate, jids = null, dia = null, viradaMin = 0 }) {
  if (dia != null) { de = startOfDay(dia, viradaMin); ate = endOfDay(dia, viradaMin); }
  const f = inClause('jid', jids);
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  return {
    cliques: n(`SELECT COUNT(*) AS n FROM link_clicks WHERE ts BETWEEN ? AND ?${f.sql}`, de, ate, ...f.params),
    entradas: n(`SELECT COUNT(*) AS n FROM group_events WHERE action = 'add' AND ts BETWEEN ? AND ?${f.sql}`, de, ate, ...f.params),
    saidas: n(`SELECT COUNT(*) AS n FROM group_events WHERE action = 'remove' AND ts BETWEEN ? AND ?${f.sql}`, de, ate, ...f.params),
    abriram: n(`SELECT COUNT(DISTINCT participant) AS n FROM group_reads WHERE ts BETWEEN ? AND ?${f.sql}`, de, ate, ...f.params),
  };
}

/** Evasão de um dia de negócio (entrou no dia e saiu no mesmo dia). */
export function evasaoDoDia(db, diaTs, jids = null, viradaMin = 0) {
  const v = virada(viradaMin);
  const { de, ate } = { de: startOfDay(diaTs, v), ate: endOfDay(diaTs, v) };
  const f = inClause('a.jid', jids);
  const rows = db.prepare(`SELECT a.ts,
      (SELECT MIN(r.ts) FROM group_events r WHERE r.jid = a.jid AND r.participant = a.participant AND r.action = 'remove' AND r.ts > a.ts) AS left_ts
    FROM group_events a WHERE a.action = 'add' AND a.ts BETWEEN ? AND ?${f.sql}`).all(de, ate, ...f.params);
  const n = rows.filter((r) => r.left_ts && dayOf(r.left_ts, v) === dayOf(r.ts, v)).length;
  return { pct: pct(n, rows.length), n, de: rows.length, dia: dayOf(diaTs, v) };
}
