import express from 'express';
import path from 'node:path';
import { DATA_DIR, PORT, DRY_RUN, FAST, ROOT } from './config.js';
import { openDb, getSetting, setSetting, parseRule, nz, addLog } from './db.js';
import { createWhatsApp } from './whatsapp.js';
import { createLinkService } from './links.js';
import { createScheduler } from './scheduler.js';
import { renderTemplate, SAMPLE_OFFER, PLACEHOLDERS } from './template.js';
import { CATEGORIAS, ORDENS, POR_PAGINA } from './afiliados.js';

export function buildApp({ db, wa, links, scheduler }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' })); // a lista da Central de Afiliados vem pela extensão

  // Proteção: o painel só atende o próprio computador, e só quem veio da própria página.
  // (Evita que um site qualquer aberto no seu navegador mande comandos para cá.)
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/ext/')) return next(); // a extensão usa token
    const host = String(req.headers.host || '');
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return res.status(403).json({ erro: 'Host não permitido' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return res.status(403).json({ erro: 'Origem não permitida' });
    next();
  });
  app.use(express.static(path.join(ROOT, 'public')));

  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req, res) ?? { ok: true }); } catch (e) { res.status(400).json({ erro: e.message }); }
  };
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  // ---------- estado geral ----------
  app.get('/api/state', wrap(() => ({
    whatsapp: wa.state(), extensao: links.status(), simulacao: DRY_RUN,
    ajustes: {
      delay_group_s: Number(getSetting(db, 'delay_group_s', 6)),
      delay_offer_s: Number(getSetting(db, 'delay_offer_s', 30)),
      link_mode: getSetting(db, 'link_mode', 'extension'),
    },
    ext_token: getSetting(db, 'ext_token'), porta: PORT,
    placeholders: PLACEHOLDERS,
    afiliados: { categorias: CATEGORIAS, ordens: ORDENS, por_pagina: POR_PAGINA },
  })));

  app.put('/api/ajustes', wrap((req) => {
    const { delay_group_s, delay_offer_s, link_mode } = req.body;
    if (delay_group_s != null) setSetting(db, 'delay_group_s', Math.max(2, Number(delay_group_s) || 6));
    if (delay_offer_s != null) setSetting(db, 'delay_offer_s', Math.max(5, Number(delay_offer_s) || 30));
    if (link_mode != null) {
      if (!['extension', 'direct'].includes(link_mode)) throw new Error('Modo de link inválido');
      setSetting(db, 'link_mode', link_mode);
    }
  }));

  // ---------- WhatsApp ----------
  app.post('/api/wa/connect', wrap(async () => { await wa.connect(); }));
  app.post('/api/wa/logout', wrap(async () => { await wa.logout(); }));
  app.post('/api/wa/sync-groups', wrap(async () => { await wa.syncGroups(); }));
  app.get('/api/groups', wrap(() => all('SELECT * FROM groups ORDER BY name COLLATE NOCASE')));

  // ---------- etiquetas ----------
  app.get('/api/tags', wrap(() => all('SELECT * FROM tags ORDER BY name COLLATE NOCASE')));
  app.post('/api/tags', wrap((req) => {
    const name = String(req.body.name || '').trim();
    if (!/^[\w.-]{2,60}$/.test(name)) throw new Error('A etiqueta deve ter 2 a 60 caracteres: letras, números, ponto, hífen ou _ (sem espaços).');
    if (one('SELECT 1 FROM tags WHERE name = ?', name)) throw new Error('Essa etiqueta já está cadastrada.');
    db.prepare('INSERT INTO tags (name, note, created_at) VALUES (?,?,?)').run(name, String(req.body.note || ''), Date.now());
  }));
  app.delete('/api/tags/:id', wrap((req) => {
    const used = one('SELECT name FROM rules WHERE tag_id = ? LIMIT 1', req.params.id);
    if (used) throw new Error(`A regra "${used.name}" usa esta etiqueta. Troque a etiqueta dela antes.`);
    db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  }));

  // ---------- templates ----------
  const checkTemplate = (b) => {
    if (!String(b.name || '').trim()) throw new Error('Dê um nome ao template.');
    if (!String(b.body || '').includes('{LINK}')) throw new Error('O template precisa ter {LINK}, senão a mensagem sai sem o link de afiliado.');
  };
  app.get('/api/templates', wrap(() => all('SELECT * FROM templates ORDER BY id')));
  app.post('/api/templates', wrap((req) => {
    checkTemplate(req.body);
    return { id: db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run(req.body.name.trim(), req.body.body, Date.now()).lastInsertRowid };
  }));
  app.put('/api/templates/:id', wrap((req) => {
    checkTemplate(req.body);
    db.prepare('UPDATE templates SET name = ?, body = ? WHERE id = ?').run(req.body.name.trim(), req.body.body, req.params.id);
  }));
  app.delete('/api/templates/:id', wrap((req) => {
    const used = one('SELECT name FROM rules WHERE template_id = ? LIMIT 1', req.params.id);
    if (used) throw new Error(`A regra "${used.name}" usa este template.`);
    if (one('SELECT COUNT(*) AS n FROM templates').n <= 1) throw new Error('Mantenha ao menos um template.');
    db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  }));
  app.post('/api/templates/preview', wrap((req) => ({ texto: renderTemplate(String(req.body.body || ''), { ...SAMPLE_OFFER, ...(req.body.amostra || {}) }) })));

  // ---------- regras ----------
  const ruleFromBody = (b) => {
    const n = (v, d) => (v === '' || v == null ? d : Number(v));
    const hhmm = (v, d) => (/^\d{1,2}:\d{2}$/.test(v || '') ? v : d);
    if (!String(b.name || '').trim()) throw new Error('Dê um nome à regra.');
    const interval = n(b.interval_min, 60); const perRun = n(b.per_run, 3);
    if (!(interval >= 1)) throw new Error('O intervalo mínimo é 1 minuto.');
    if (!(perRun >= 1 && perRun <= 20)) throw new Error('Ofertas por envio: de 1 a 20.');
    return [
      b.name.trim(), b.enabled === false ? 0 : 1, nz(b.tag_id), nz(b.template_id),
      JSON.stringify(Array.isArray(b.group_jids) ? b.group_jids : []),
      ['afiliados', 'search'].includes(b.source_type) ? b.source_type : 'list', JSON.stringify(b.source_config || {}),
      nz(n(b.min_price, null)), nz(n(b.max_price, null)), nz(n(b.min_discount, null)),
      perRun, interval, hhmm(b.window_start, '08:00'), hhmm(b.window_end, '22:00'),
      n(b.dedupe_days, 7), b.send_image === false ? 0 : 1,
    ];
  };
  const COLS = 'name, enabled, tag_id, template_id, group_jids, source_type, source_config, min_price, max_price, min_discount, per_run, interval_min, window_start, window_end, dedupe_days, send_image';
  app.get('/api/rules', wrap(() => all('SELECT * FROM rules ORDER BY id').map((r) => ({ ...parseRule(r), em_andamento: scheduler.isRunning(r.id) }))));
  app.post('/api/rules', wrap((req) => {
    const v = ruleFromBody(req.body);
    return { id: db.prepare(`INSERT INTO rules (${COLS}, created_at) VALUES (${v.map(() => '?').join(',')}, ?)`).run(...v, Date.now()).lastInsertRowid };
  }));
  app.put('/api/rules/:id', wrap((req) => {
    const v = ruleFromBody(req.body);
    db.prepare(`UPDATE rules SET ${COLS.split(', ').map((c) => c + ' = ?').join(', ')}, next_run_at = NULL WHERE id = ?`).run(...v, req.params.id);
  }));
  app.post('/api/rules/:id/enabled', wrap((req) => {
    db.prepare('UPDATE rules SET enabled = ?, next_run_at = NULL WHERE id = ?').run(req.body.enabled ? 1 : 0, req.params.id);
  }));
  app.delete('/api/rules/:id', wrap((req) => {
    db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM sent_offers WHERE rule_id = ?').run(req.params.id);
  }));
  app.post('/api/rules/:id/run', wrap((req) => { scheduler.runRule(Number(req.params.id), { manual: true }).catch(() => {}); return { iniciado: true }; }));
  app.get('/api/rules/:id/offers', wrap((req) => scheduler.previewOffers(Number(req.params.id))));
  app.post('/api/rules/:id/reset-sent', wrap((req) => { db.prepare('DELETE FROM sent_offers WHERE rule_id = ?').run(req.params.id); }));

  // ---------- histórico ----------
  app.get('/api/log', wrap((req) => {
    const only = req.query.nivel;
    const lim = Math.min(Number(req.query.limite) || 200, 1000);
    return only ? all('SELECT * FROM log WHERE level = ? ORDER BY id DESC LIMIT ?', only, lim) : all('SELECT * FROM log ORDER BY id DESC LIMIT ?', lim);
  }));
  app.get('/api/simulados', wrap(() => wa.simulated.slice(-50)));

  // ---------- extensão do Chrome (autenticada por token) ----------
  const extAuth = (req, res, next) => {
    if (req.headers['x-token'] !== getSetting(db, 'ext_token')) return res.status(401).json({ erro: 'Token inválido' });
    next();
  };
  // Long-poll: manda os cabeçalhos na hora (a extensão já sabe que está conectada)
  // e só depois o corpo, quando chegar um pedido de link ou der 20 s.
  app.get('/api/ext/poll', extAuth, async (req, res) => {
    res.status(200).type('application/json').flushHeaders();
    res.end(JSON.stringify({ job: await links.poll(20000) }));
  });
  app.post('/api/ext/result', extAuth, (req, res) => {
    const ok = links.submit(Number(req.body.id), { ok: !!req.body.ok, link: req.body.link, data: req.body.data, error: req.body.error });
    res.json({ ok });
  });

  return app;
}

// ---------- inicialização ----------
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('server.js')) {
  const db = openDb(DATA_DIR);
  const wa = createWhatsApp({ db, dir: DATA_DIR, dryRun: DRY_RUN });
  const links = createLinkService({ getMode: () => (DRY_RUN ? 'fake' : getSetting(db, 'link_mode', 'extension')) });
  const scheduler = createScheduler({ db, wa, links, fast: FAST });
  const app = buildApp({ db, wa, links, scheduler });
  if (DRY_RUN) wa.connect();
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`\nDisparador ML rodando em http://localhost:${PORT}${DRY_RUN ? '  (MODO SIMULAÇÃO: nada é enviado de verdade)' : ''}\n`);
    wa.autoStart();
    scheduler.start();
  });
}
