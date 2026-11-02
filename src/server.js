import express from 'express';
import path from 'node:path';
import { DATA_DIR, PORT, DRY_RUN, FAST, ROOT, PUBLIC_HOST, PANEL_PASSWORD } from './config.js';
import { openDb, getSetting, setSetting, parseRule, nz, MAX_SOURCES } from './db.js';
import { createAuth, createLimiter, parseCookies, safeEqual, SESSION_MS } from './auth.js';
import { createWhatsApp } from './whatsapp.js';
import { createLinkService } from './links.js';
import { createScheduler } from './scheduler.js';
import { renderTemplate, SAMPLE_OFFER, PLACEHOLDERS } from './template.js';
import { CATEGORIAS, ORDENS, POR_PAGINA } from './afiliados.js';
import { overview, resumo, evasaoDoDia, periodRange, startOfDay } from './analytics.js';
import { MODOS, LIMITE_MAX, LOTACAO_PCT, slugify, parseLink, pickGroup, statusDosGrupos, verificarLotacao, encaixarGrupoNovo } from './rotador.js';
import { addLog } from './db.js';
import crypto from 'node:crypto';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
// Páginas e rotas que funcionam sem login.
const PUBLIC_PATHS = new Set(['/login.html', '/style.css', '/logo.svg', '/icon-192.png', '/healthz', '/favicon.ico', '/api/login']);

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

  // ---------- rotacionador: link público /g/<slug> (sem login; é o que as pessoas clicam) ----------
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const groupsByJid = () => Object.fromEntries(all('SELECT jid, name, size, invite_code FROM groups').map((g) => [g.jid, g]));
  app.get('/g/:slug', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const link = parseLink(one('SELECT * FROM links WHERE slug = ?', String(req.params.slug).toLowerCase()));
    if (!link || !link.enabled) return res.status(404).type('text/plain').send('Link não encontrado.');
    const { group, state } = pickGroup(link, groupsByJid());
    db.prepare('UPDATE links SET state = ? WHERE id = ?').run(JSON.stringify(state), link.id);
    if (!group) {
      if (link.fallback_url) return res.redirect(302, link.fallback_url);
      return res.status(503).type('text/html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Grupos lotados</title><p style="font:16px system-ui;padding:32px;text-align:center">Todos os grupos estão lotados no momento. Tente de novo mais tarde.</p>');
    }
    const ipHash = crypto.createHash('sha256').update(`${req.ip}|${new Date().toDateString()}`).digest('hex').slice(0, 16);
    db.prepare('INSERT INTO link_clicks (ts, link_id, jid, ip_hash) VALUES (?,?,?,?)').run(Date.now(), link.id, group.jid, ipHash);
    res.redirect(302, `https://chat.whatsapp.com/${group.invite_code}`);
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
    if (!auth.enabled() || PUBLIC_PATHS.has(req.path) || req.path.startsWith('/g/')) return next();
    if (auth.sessionFrom(parseCookies(req.headers.cookie).sid)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'Faça login para continuar' });
    res.redirect(302, '/login.html');
  });
  app.use(express.static(path.join(ROOT, 'public')));

  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req, res) ?? { ok: true }); } catch (e) { res.status(400).json({ erro: e.message }); }
  };
  // ---------- estado geral ----------
  app.get('/api/state', wrap(() => ({
    whatsapp: wa.state(), extensao: links.status(), simulacao: DRY_RUN,
    ajustes: {
      delay_group_s: Number(getSetting(db, 'delay_group_s', 6)),
      delay_offer_s: Number(getSetting(db, 'delay_offer_s', 30)),
      link_mode: getSetting(db, 'link_mode', 'extension'),
      titulo_max: Number(getSetting(db, 'titulo_max', 60)),
    },
    ext_token: getSetting(db, 'ext_token'), porta: PORT,
    endereco_publico: enderecoPublico, auth: auth.enabled(),
    placeholders: PLACEHOLDERS,
    afiliados: { categorias: CATEGORIAS, ordens: ORDENS, por_pagina: POR_PAGINA }, max_fontes: MAX_SOURCES,
    modos_link: MODOS, limite_max: LIMITE_MAX, lotacao_pct: LOTACAO_PCT,
    propostas_pendentes: one("SELECT COUNT(*) AS n FROM group_proposals WHERE status = 'pending'").n,
  })));

  app.put('/api/ajustes', wrap((req) => {
    const { delay_group_s, delay_offer_s, link_mode, titulo_max } = req.body;
    if (titulo_max != null) { const n = Number(titulo_max); if (!(n >= 0 && n <= 200)) throw new Error('Tamanho do título: de 0 (inteiro) a 200.'); setSetting(db, 'titulo_max', Math.round(n)); }
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
  app.get('/api/groups', wrap(() => all(`SELECT g.*, (SELECT json_group_array(block_id) FROM block_groups b WHERE b.jid = g.jid) AS blocks
    FROM groups g ORDER BY name COLLATE NOCASE`).map((g) => ({ ...g, is_admin: g.is_admin == null ? null : !!g.is_admin, blocks: JSON.parse(g.blocks || '[]') }))));
  app.post('/api/groups/:jid/invite', wrap(async (req) => ({ invite_code: await wa.fetchInvite(req.params.jid) })));
  app.put('/api/groups/:jid/invite', wrap((req) => {
    const m = String(req.body.url || '').trim().match(/(?:chat\.whatsapp\.com\/(?:invite\/)?)?([A-Za-z0-9_-]{10,})$/);
    if (!m) throw new Error('Cole o link completo, como https://chat.whatsapp.com/XXXXXXXX');
    if (!one('SELECT 1 FROM groups WHERE jid = ?', req.params.jid)) throw new Error('Grupo não encontrado.');
    db.prepare('UPDATE groups SET invite_code = ? WHERE jid = ?').run(m[1], req.params.jid);
    return { invite_code: m[1] };
  }));

  // ---------- blocos de análise ----------
  const blockFromBody = (b) => {
    const name = String(b.name || '').trim(); if (!name) throw new Error('Dê um nome ao bloco.');
    return { name, tag_id: nz(b.tag_id), note: String(b.note || ''), jids: Array.isArray(b.group_jids) ? [...new Set(b.group_jids)] : [] };
  };
  const saveBlockGroups = (id, jids) => {
    db.prepare('DELETE FROM block_groups WHERE block_id = ?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO block_groups (block_id, jid) VALUES (?,?)');
    for (const j of jids) ins.run(id, j);
  };
  app.get('/api/blocks', wrap(() => {
    const hoje = periodRange('hoje');
    return all('SELECT * FROM blocks ORDER BY name COLLATE NOCASE').map((b) => {
      const jids = all('SELECT jid FROM block_groups WHERE block_id = ?', b.id).map((r) => r.jid);
      const grupos = jids.length ? all(`SELECT jid, name, size FROM groups WHERE jid IN (${jids.map(() => '?').join(',')})`, ...jids) : [];
      return { ...b, group_jids: jids, grupos, membros: grupos.reduce((s, g) => s + (g.size || 0), 0), hoje: resumo(db, { ...hoje, jids }) };
    });
  }));
  app.post('/api/blocks', wrap((req) => {
    const b = blockFromBody(req.body);
    const id = db.prepare('INSERT INTO blocks (name, tag_id, note, created_at) VALUES (?,?,?,?)').run(b.name, b.tag_id, b.note, Date.now()).lastInsertRowid;
    saveBlockGroups(id, b.jids); return { id };
  }));
  app.put('/api/blocks/:id', wrap((req) => {
    const b = blockFromBody(req.body);
    db.prepare('UPDATE blocks SET name = ?, tag_id = ?, note = ? WHERE id = ?').run(b.name, b.tag_id, b.note, req.params.id);
    saveBlockGroups(Number(req.params.id), b.jids);
  }));
  app.delete('/api/blocks/:id', wrap((req) => {
    db.prepare('DELETE FROM blocks WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM block_groups WHERE block_id = ?').run(req.params.id);
  }));

  // ---------- visão geral ----------
  app.get('/api/overview', wrap((req) => {
    const q = req.query; const now = Date.now();
    const range = periodRange(String(q.periodo || 'hoje'), now, { de: q.de, ate: q.ate });
    const jids = q.bloco ? all('SELECT jid FROM block_groups WHERE block_id = ?', q.bloco).map((r) => r.jid) : null;
    const o = overview(db, { ...range, jids, now });
    o.anterior = { ...o.anterior, ...resumo(db, { ...o.anterior, jids }) };
    o.evasao.ontem = evasaoDoDia(db, startOfDay(now) - 86400000, jids);
    return o;
  }));

  // ---------- rotacionador: cadastro ----------
  const linkFromBody = (b, id = null) => {
    const name = String(b.name || '').trim(); if (!name) throw new Error('Dê um nome ao link.');
    const slug = slugify(b.slug || name); if (!slug) throw new Error('Endereço inválido: use letras e números.');
    if (one('SELECT id FROM links WHERE slug = ? AND id IS NOT ?', slug, id)) throw new Error('Já existe um link com esse endereço.');
    const mode = MODOS.some((m) => m.id === b.mode) ? b.mode : 'fill';
    const limit = Math.min(Math.max(Number(b.limit_members) || 1000, 2), LIMITE_MAX);
    const reopen = Math.min(Math.max(Number(b.reopen_below) || Math.floor(limit * 0.9), 1), limit - 1);
    const fallback = String(b.fallback_url || '').trim();
    if (fallback && !/^https?:\/\//i.test(fallback)) throw new Error('A URL reserva precisa começar com http:// ou https://');
    const jids = Array.isArray(b.group_jids) ? [...new Set(b.group_jids)] : [];
    if (!jids.length) throw new Error('Escolha ao menos um grupo.');
    return [name, slug, mode, fallback || null, limit, reopen, JSON.stringify(jids), b.auto_next ? 1 : 0];
  };
  const linkView = (row) => {
    const l = parseLink(row); const hoje = periodRange('hoje');
    return {
      ...l, auto_next: !!l.auto_next, url: `${enderecoPublico}/g/${l.slug}`, grupos: statusDosGrupos(l, groupsByJid()),
      cliques_total: one('SELECT COUNT(*) AS n FROM link_clicks WHERE link_id = ?', l.id).n,
      cliques_hoje: one('SELECT COUNT(*) AS n FROM link_clicks WHERE link_id = ? AND ts BETWEEN ? AND ?', l.id, hoje.de, hoje.ate).n,
    };
  };
  app.get('/api/links', wrap(() => all('SELECT * FROM links ORDER BY id').map(linkView)));
  app.post('/api/links', wrap((req) => {
    const v = linkFromBody(req.body);
    return { id: db.prepare('INSERT INTO links (name, slug, mode, fallback_url, limit_members, reopen_below, group_jids, auto_next, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(...v, Date.now()).lastInsertRowid };
  }));
  app.put('/api/links/:id', wrap((req) => {
    const v = linkFromBody(req.body, Number(req.params.id));
    db.prepare("UPDATE links SET name = ?, slug = ?, mode = ?, fallback_url = ?, limit_members = ?, reopen_below = ?, group_jids = ?, auto_next = ?, state = '{}' WHERE id = ?").run(...v, req.params.id);
  }));
  app.post('/api/links/:id/enabled', wrap((req) => { db.prepare('UPDATE links SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, req.params.id); }));
  app.delete('/api/links/:id', wrap((req) => {
    db.prepare('DELETE FROM links WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM link_clicks WHERE link_id = ?').run(req.params.id);
    db.prepare("DELETE FROM group_proposals WHERE link_id = ? AND status = 'pending'").run(req.params.id);
  }));

  // ---------- próximo grupo (proposta -> você confirma -> cria) ----------
  app.get('/api/proposals', wrap(() => {
    verificarLotacao(db);
    return all(`SELECT p.*, g.name AS source_name, g.size AS source_size, l.name AS link_name, l.limit_members
      FROM group_proposals p LEFT JOIN groups g ON g.jid = p.source_jid LEFT JOIN links l ON l.id = p.link_id
      WHERE p.status = 'pending' OR p.decided_at > ? ORDER BY p.status = 'pending' DESC, p.created_at DESC LIMIT 30`, Date.now() - 7 * 86400000)
      .map((p) => ({ ...p, detail: p.detail ? JSON.parse(p.detail) : null }));
  }));
  app.post('/api/proposals/:id/dismiss', wrap((req) => {
    db.prepare("UPDATE group_proposals SET status = 'dismissed', decided_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), req.params.id);
  }));
  app.post('/api/proposals/:id/create', wrap(async (req) => {
    const p = one("SELECT * FROM group_proposals WHERE id = ? AND status = 'pending'", req.params.id);
    if (!p) throw new Error('Proposta não encontrada ou já decidida.');
    const nome = String(req.body?.name || p.name).trim(); if (!nome) throw new Error('Dê um nome ao grupo.');
    let r;
    try { r = await wa.createNextGroup(p.source_jid, nome); } catch (e) {
      db.prepare("UPDATE group_proposals SET status = 'failed', detail = ?, decided_at = ? WHERE id = ?").run(JSON.stringify({ erro: e.message }), Date.now(), p.id);
      addLog(db, { level: 'erro', group_name: nome, message: 'Não consegui criar o próximo grupo: ' + e.message });
      throw e;
    }
    encaixarGrupoNovo(db, { linkId: p.link_id, sourceJid: p.source_jid, newJid: r.jid });
    db.prepare("UPDATE group_proposals SET status = 'created', created_jid = ?, name = ?, detail = ?, decided_at = ? WHERE id = ?").run(r.jid, nome, JSON.stringify(r), Date.now(), p.id);
    addLog(db, { level: 'ok', group_name: nome, message: `Grupo criado a partir de "${one('SELECT name FROM groups WHERE jid = ?', p.source_jid)?.name || p.source_jid}" e encaixado no link, nos blocos e nas regras.` });
    return r;
  }));

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
    const bloco = one('SELECT name FROM blocks WHERE tag_id = ? LIMIT 1', req.params.id);
    if (bloco) throw new Error(`O bloco "${bloco.name}" usa esta etiqueta. Troque a etiqueta dele antes.`);
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
  app.post('/api/templates/preview', wrap((req) => ({ texto: renderTemplate(String(req.body.body || ''), { ...SAMPLE_OFFER, ...(req.body.amostra || {}) }, { tituloMax: Number(getSetting(db, 'titulo_max', 60)) }) })));

  // ---------- regras ----------
  const ruleFromBody = (b) => {
    const n = (v, d) => (v === '' || v == null ? d : Number(v));
    const hhmm = (v, d) => (/^\d{1,2}:\d{2}$/.test(v || '') ? v : d);
    if (!String(b.name || '').trim()) throw new Error('Dê um nome à regra.');
    const interval = n(b.interval_min, 60); const perRun = n(b.per_run, 3);
    if (!(interval >= 1)) throw new Error('O intervalo mínimo é 1 minuto.');
    if (!(perRun >= 1 && perRun <= 20)) throw new Error('Ofertas por envio: de 1 a 20.');
    // fontes: lista nova (até 5) ou, nas regras antigas, source_type + source_config
    const tipo = (t) => (['afiliados', 'search'].includes(t) ? t : 'list');
    let sources = Array.isArray(b.sources) && b.sources.length
      ? b.sources.map((s) => ({ type: tipo(s?.type), config: s?.config && typeof s.config === 'object' ? s.config : {} }))
      : [{ type: tipo(b.source_type), config: b.source_config && typeof b.source_config === 'object' ? b.source_config : {} }];
    if (sources.length > MAX_SOURCES) throw new Error(`Uma regra aceita no máximo ${MAX_SOURCES} fontes.`);
    for (const [i, s] of sources.entries()) {
      if (s.type === 'search' && !String(s.config.query || '').trim()) throw new Error(`Fonte ${i + 1}: a busca está sem a palavra-chave.`);
      if (s.type === 'list' && !String(s.config.items || '').split('\n').some((l) => /^https?:/i.test(l.trim()))) throw new Error(`Fonte ${i + 1}: a lista de links está vazia.`);
    }
    return [
      b.name.trim(), b.enabled === false ? 0 : 1, nz(b.tag_id), nz(b.template_id),
      JSON.stringify(Array.isArray(b.group_jids) ? b.group_jids : []),
      sources[0].type, JSON.stringify(sources[0].config), JSON.stringify(sources),
      nz(n(b.min_price, null)), nz(n(b.max_price, null)), nz(n(b.min_discount, null)),
      perRun, interval, hhmm(b.window_start, '08:00'), hhmm(b.window_end, '22:00'),
      n(b.dedupe_days, 7), b.send_image === false ? 0 : 1,
    ];
  };
  const COLS = 'name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, min_price, max_price, min_discount, per_run, interval_min, window_start, window_end, dedupe_days, send_image';
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
    console.log(`\nachadinhoturbo rodando em http://localhost:${PORT}${PUBLIC_HOST ? ` (público: https://${PUBLIC_HOST})` : ''}${DRY_RUN ? '  (MODO SIMULAÇÃO: nada é enviado de verdade)' : ''}\n`);
    wa.autoStart();
    scheduler.start();
    setInterval(() => { try { verificarLotacao(db); } catch (e) { console.error('[lotação]', e.message); } }, 60000);
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
