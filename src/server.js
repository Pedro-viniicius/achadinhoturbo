import express from 'express';
import path from 'node:path';
import { DATA_DIR, PORT, DRY_RUN, FAST, ROOT, PUBLIC_HOST, PANEL_PASSWORD } from './config.js';
import { openDb, getSetting, setSetting, parseRule, nz } from './db.js';
import { createAuth, createLimiter, parseCookies, safeEqual, SESSION_MS } from './auth.js';
import { createWhatsApp } from './whatsapp.js';
import { createLinkService } from './links.js';
import { createScheduler } from './scheduler.js';
import { renderTemplate, SAMPLE_OFFER, PLACEHOLDERS } from './template.js';
import { CATEGORIAS, ORDENS, POR_PAGINA } from './afiliados.js';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
// Páginas e rotas que funcionam sem login.
const PUBLIC_PATHS = new Set(['/login.html', '/style.css', '/healthz', '/favicon.ico', '/api/login']);

export function buildApp({ db, wa, links, scheduler, publicHost = PUBLIC_HOST, panelPassword = PANEL_PASSWORD }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Nginx na frente: req.ip e req.secure vêm do X-Forwarded-*
  app.use(express.json({ limit: '5mb' })); // a lista da Central de Afiliados vem pela extensão

  const auth = createAuth({ db, password: panelPassword });
  const loginLimiter = createLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
  const extLimiter = createLimiter({ max: 20, windowMs: 15 * 60 * 1000 });
  const enderecoPublico = publicHost ? `https://${publicHost}` : `http://127.0.0.1:${PORT}`;
  app.locals.auth = auth;

  // ---------- cabeçalhos de segurança ----------
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  });

  // ---------- Host e Origin ----------
  // O painel só atende o próprio computador ou o domínio público, e só quem veio da própria página.
  // (Evita que um site qualquer aberto no seu navegador mande comandos para cá.)
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/ext/')) return next(); // a extensão usa token
    const host = String(req.headers.host || '').toLowerCase();
    const local = LOCAL_HOST.test(host);
    if (!local && !(publicHost && host === publicHost)) return res.status(403).json({ erro: 'Host não permitido' });
    const origin = req.headers.origin;
    if (origin) {
      const ok = new Set();
      if (local) ok.add(`http://${host}`);
      if (publicHost) ok.add(`https://${publicHost}`);
      if (!ok.has(origin)) return res.status(403).json({ erro: 'Origem não permitida' });
    }
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---------- extensão do Chrome (autenticada por token; fora do login) ----------
  const extAuth = (req, res, next) => {
    const ip = req.ip;
    if (extLimiter.blocked(ip)) return res.status(429).json({ erro: 'Muitas tentativas com token inválido' });
    if (!safeEqual(req.headers['x-token'], getSetting(db, 'ext_token'))) { extLimiter.fail(ip); return res.status(401).json({ erro: 'Token inválido' }); }
    extLimiter.reset(ip);
    next();
  };
  // Long-poll: manda os cabeçalhos na hora (a extensão já sabe que está conectada)
  // e só depois o corpo, quando chegar um pedido ou der 20 s.
  app.get('/api/ext/poll', extAuth, async (req, res) => {
    res.status(200).type('application/json').flushHeaders();
    res.end(JSON.stringify({ job: await links.poll(20000) }));
  });
  app.post('/api/ext/result', extAuth, (req, res) => {
    const ok = links.submit(Number(req.body.id), { ok: !!req.body.ok, link: req.body.link, data: req.body.data, error: req.body.error });
    res.json({ ok });
  });

  // ---------- login ----------
  const cookieOpts = (req) => ({ httpOnly: true, sameSite: 'strict', secure: req.secure || !!publicHost, path: '/' });
  app.post('/api/login', (req, res) => {
    if (!auth.enabled()) return res.json({ ok: true });
    const ip = req.ip;
    if (loginLimiter.blocked(ip)) {
      const s = loginLimiter.retryAfterS(ip);
      return res.status(429).json({ erro: `Muitas tentativas. Tente de novo em ${Math.ceil(s / 60)} min.` });
    }
    const sid = auth.login(String(req.body?.senha ?? ''), ip);
    if (!sid) { loginLimiter.fail(ip); return res.status(401).json({ erro: 'Senha incorreta' }); }
    loginLimiter.reset(ip);
    res.cookie('sid', sid, { ...cookieOpts(req), maxAge: SESSION_MS });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    auth.logout(parseCookies(req.headers.cookie).sid);
    res.clearCookie('sid', cookieOpts(req));
    res.json({ ok: true });
  });

  // ---------- exige sessão em tudo o que vem abaixo (painel e API) ----------
  app.use((req, res, next) => {
    if (!auth.enabled() || PUBLIC_PATHS.has(req.path)) return next();
    if (auth.sessionFrom(parseCookies(req.headers.cookie).sid)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'Faça login para continuar' });
    res.redirect(302, '/login.html');
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
    endereco_publico: enderecoPublico, auth: auth.enabled(),
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

  return app;
}

// ---------- inicialização ----------
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('server.js')) {
  const db = openDb(DATA_DIR);
  const wa = createWhatsApp({ db, dir: DATA_DIR, dryRun: DRY_RUN });
  const links = createLinkService({ getMode: () => (DRY_RUN ? 'fake' : getSetting(db, 'link_mode', 'extension')) });
  const scheduler = createScheduler({ db, wa, links, fast: FAST });
  const app = buildApp({ db, wa, links, scheduler });

  if (!app.locals.auth.enabled()) {
    if (PUBLIC_HOST) {
      console.error('ERRO: PUBLIC_HOST está definido mas o painel não tem senha. Defina PANEL_PASSWORD (ou rode npm run senha) antes de expor o painel.');
      process.exit(1);
    }
    console.warn('AVISO: painel sem senha (só localhost). Para proteger, defina PANEL_PASSWORD ou rode: npm run senha');
  }

  if (DRY_RUN) wa.connect();
  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`\nDisparador ML rodando em http://localhost:${PORT}${PUBLIC_HOST ? ` (público: https://${PUBLIC_HOST})` : ''}${DRY_RUN ? '  (MODO SIMULAÇÃO: nada é enviado de verdade)' : ''}\n`);
    wa.autoStart();
    scheduler.start();
  });

  // Encerramento limpo (systemd manda SIGTERM): para o agendador, fecha o servidor e o banco.
  let encerrando = false;
  const encerrar = (sinal) => {
    if (encerrando) return; encerrando = true;
    console.log(`\nRecebi ${sinal}: encerrando…`);
    scheduler.stop();
    server.close(() => { try { db.close(); } catch { /* já fechado */ } process.exit(0); });
    server.closeAllConnections?.(); // derruba long-polls abertos
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => encerrar('SIGTERM'));
  process.on('SIGINT', () => encerrar('SIGINT'));
}
