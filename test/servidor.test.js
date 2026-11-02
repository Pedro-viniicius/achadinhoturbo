// Testes do servidor HTTP: login, sessão, Host/Origin, token da extensão, cabeçalhos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';

const HOST = 'disparador.exemplo.com.br';
const SENHA = 'senha-de-teste-123';

function subir({ publicHost = HOST, panelPassword = SENHA, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-srv-')) } = {}) {
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  const app = buildApp({ db, wa, links, scheduler, publicHost, panelPassword });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      ok({ db, dir, port, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) });
    });
  });
}

/** Requisição crua (permite trocar o Host, o que o fetch não deixa). */
function req(port, caminho, { method = 'GET', headers = {}, body, host } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { host: host || `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, headers: res.headers, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
const cookieDe = (res) => String(res.headers['set-cookie']?.[0] || '');
const sidDe = (res) => cookieDe(res).split(';')[0];
const login = async (port, senha = SENHA, host) => req(port, '/api/login', { method: 'POST', body: { senha }, host });

test('sem login: API 401, páginas redirecionam, exceções continuam abertas', async () => {
  const s = await subir();
  try {
    assert.equal((await req(s.port, '/api/state')).status, 401);
    const home = await req(s.port, '/');
    assert.equal(home.status, 302); assert.equal(home.headers.location, '/login.html');
    assert.equal((await req(s.port, '/index.html')).status, 302);
    assert.equal((await req(s.port, '/app.js')).status, 302);
    assert.equal((await req(s.port, '/login.html')).status, 200);
    assert.equal((await req(s.port, '/style.css')).status, 200);
    const hz = await req(s.port, '/healthz');
    assert.equal(hz.status, 200); assert.deepEqual(hz.json, { ok: true });
  } finally { await s.fechar(); }
});

test('senha errada dá 401 e bloqueia depois de 5 tentativas; senha certa abre sessão com cookie seguro', async () => {
  const s = await subir();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login(s.port, 'errada')).status, 401);
    const bloqueado = await login(s.port, SENHA);
    assert.equal(bloqueado.status, 429, 'bloqueado mesmo com a senha certa');
    assert.match(bloqueado.json.erro, /Muitas tentativas/);
  } finally { await s.fechar(); }

  const s2 = await subir();
  try {
    const ok = await login(s2.port);
    assert.equal(ok.status, 200);
    const c = cookieDe(ok);
    assert.match(c, /^sid=[a-f0-9]{64};/); assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/); assert.match(c, /Secure/);
    const st = await req(s2.port, '/api/state', { headers: { cookie: sidDe(ok) } });
    assert.equal(st.status, 200);
    assert.equal(st.json.endereco_publico, `https://${HOST}`); assert.equal(st.json.auth, true);
    assert.equal((await req(s2.port, '/', { headers: { cookie: sidDe(ok) } })).status, 200, 'index.html com sessão');
    // logout encerra a sessão
    const out = await req(s2.port, '/api/logout', { method: 'POST', headers: { cookie: sidDe(ok) } });
    assert.equal(out.status, 200);
    assert.equal((await req(s2.port, '/api/state', { headers: { cookie: sidDe(ok) } })).status, 401);
  } finally { await s2.fechar(); }
});

test('sessão sobrevive a reinício (fica no SQLite)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-srv-'));
  const s = await subir({ dir });
  const sid = sidDe(await login(s.port));
  await s.fechar();
  const s2 = await subir({ dir });
  try {
    assert.equal((await req(s2.port, '/api/state', { headers: { cookie: sid } })).status, 200);
  } finally { await s2.fechar(); }
});

test('Host e Origin: domínio público e localhost passam; falsos dão 403', async () => {
  const s = await subir();
  try {
    const sid = sidDe(await login(s.port));
    const post = (o) => req(s.port, '/api/tags', { method: 'POST', body: { name: 'etq' + Math.random().toString(36).slice(2, 7) }, headers: { cookie: sid, ...(o.origin ? { origin: o.origin } : {}) }, host: o.host });
    assert.equal((await post({ host: HOST, origin: `https://${HOST}` })).status, 200, 'origem https do domínio público');
    assert.equal((await post({ host: `127.0.0.1:${s.port}`, origin: `http://127.0.0.1:${s.port}` })).status, 200, 'origem local');
    assert.equal((await post({ host: HOST, origin: 'https://site-malicioso.com' })).status, 403, 'origem falsa');
    assert.equal((await post({ host: HOST, origin: `http://${HOST}` })).status, 403, 'http no domínio público não vale');
    assert.equal((await post({ host: 'outro.dominio.com' })).status, 403, 'host falso');
    assert.equal((await req(s.port, '/api/state', { headers: { cookie: sid }, host: 'outro.dominio.com' })).status, 403);
  } finally { await s.fechar(); }
});

test('extensão: sem token 401, token certo passa sem login, bloqueio por tentativas', async () => {
  const s = await subir();
  try {
    assert.equal((await req(s.port, '/api/ext/poll')).status, 401);
    assert.equal((await req(s.port, '/api/ext/poll', { headers: { 'x-token': 'errado' } })).status, 401);
    const token = s.db.prepare("SELECT value FROM settings WHERE key = 'ext_token'").get().value;
    const r = await req(s.port, '/api/ext/result', { method: 'POST', body: { id: 999, ok: true, link: 'https://meli.la/x' }, headers: { 'x-token': token }, host: 'qualquer.host' });
    assert.equal(r.status, 200, 'rota da extensão não checa Host nem sessão');
    assert.deepEqual(r.json, { ok: false }, 'pedido 999 não existe');
    for (let i = 0; i < 20; i++) await req(s.port, '/api/ext/result', { method: 'POST', body: {}, headers: { 'x-token': 'x' } });
    assert.equal((await req(s.port, '/api/ext/result', { method: 'POST', body: {}, headers: { 'x-token': token } })).status, 429, 'IP bloqueado após 20 tokens inválidos');
  } finally { await s.fechar(); }
});

test('cabeçalhos de segurança; HSTS só atrás de HTTPS', async () => {
  const s = await subir();
  try {
    const h = (await req(s.port, '/healthz')).headers;
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['x-frame-options'], 'DENY');
    assert.equal(h['referrer-policy'], 'no-referrer');
    assert.equal(h['x-powered-by'], undefined);
    assert.equal(h['strict-transport-security'], undefined, 'sem HSTS em http puro');
    const hs = (await req(s.port, '/healthz', { headers: { 'x-forwarded-proto': 'https' } })).headers;
    assert.match(hs['strict-transport-security'], /max-age=\d+/);
  } finally { await s.fechar(); }
});

test('sem senha configurada e sem domínio público, o painel local continua aberto', async () => {
  const s = await subir({ publicHost: '', panelPassword: '' });
  try {
    const st = await req(s.port, '/api/state');
    assert.equal(st.status, 200); assert.equal(st.json.auth, false);
    assert.equal(st.json.endereco_publico, `http://127.0.0.1:${process.env.PORT || 3737}`);
  } finally { await s.fechar(); }
});

test('API: regra aceita até 5 fontes, valida cada uma e devolve sources; mais de 5 dá erro', async () => {
  const s = await subir();
  try {
    const sid = sidDe(await login(s.port));
    const h = { cookie: sid, origin: `http://127.0.0.1:${s.port}` };
    s.db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('t', Date.now());
    const base = { name: 'R', tag_id: 1, template_id: 1, group_jids: [] };
    const lista = (n) => ({ type: 'list', config: { items: `https://x/MLB-${n}-a` } });
    const ok = await req(s.port, '/api/rules', { method: 'POST', body: { ...base, sources: [lista(1), { type: 'afiliados', config: { categorias: ['MLB1574'] } }, { type: 'search', config: { query: 'air fryer' } }] }, headers: h });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const r = (await req(s.port, '/api/rules', { headers: h })).json[0];
    assert.equal(r.sources.length, 3); assert.equal(r.source_type, 'list', 'a primeira fonte vira a fonte principal, para compatibilidade');
    assert.deepEqual(r.sources[1], { type: 'afiliados', config: { categorias: ['MLB1574'] }, tag_id: null });
    assert.equal((await req(s.port, '/api/rules', { method: 'POST', body: { ...base, sources: [1, 2, 3, 4, 5, 6].map(lista) }, headers: h })).status, 400, 'seis fontes');
    assert.equal((await req(s.port, '/api/rules', { method: 'POST', body: { ...base, sources: [lista(1), { type: 'list', config: { items: 'sem url' } }] }, headers: h })).status, 400, 'lista vazia');
    assert.equal((await req(s.port, '/api/rules', { method: 'POST', body: { ...base, sources: [{ type: 'search', config: {} }] }, headers: h })).status, 400, 'busca sem palavra');
    // formato antigo continua aceito
    assert.equal((await req(s.port, '/api/rules', { method: 'POST', body: { ...base, source_type: 'afiliados', source_config: { paginas: 2 } }, headers: h })).status, 200);
    assert.deepEqual((await req(s.port, '/api/rules', { headers: h })).json[1].sources, [{ type: 'afiliados', config: { paginas: 2 }, tag_id: null }]);
  } finally { await s.fechar(); }
});
