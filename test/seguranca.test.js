// Correções da revisão de segurança (S1–S11): privacidade, validação do que a extensão devolve,
// limites de taxa e de corpo, erros sem stack, CSP, sessão com hash, backup fora do git.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, getSetting } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService, LINK_MELI } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import { pseudonimo, migrarPseudonimos, limparAntigos, apagarParticipante, chaveIp } from '../src/privacidade.js';
import { validarPaginas, amostraHub } from '../src/afiliados.js';
import { parseListLines, hostPermitido, IMAGEM_PERMITIDA, parseProductHtml } from '../src/ml.js';
import { periodRange, dayOf } from '../src/analytics.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'disp-seg-'));
const D = 86400000;

test('pseudonimização: estável, não reversível, idempotente; migração converte o que já existia; IPv6 por /64', () => {
  const db = openDb(tmp());
  const a = pseudonimo(db, '5511999999999@s.whatsapp.net');
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.equal(pseudonimo(db, '5511999999999:7@s.whatsapp.net'), a, 'sufixo de dispositivo não muda a pessoa');
  assert.equal(pseudonimo(db, a), a, 'pseudônimo não é re-hasheado');
  assert.notEqual(pseudonimo(db, '5511888888888@s.whatsapp.net'), a);
  assert.notEqual(pseudonimo(openDb(tmp()), '5511999999999@s.whatsapp.net'), a, 'chave é por instalação');
  db.prepare("INSERT INTO group_events (ts, jid, participant, action, by_link, actor) VALUES (1, 'g@g.us', '5511999999999@s.whatsapp.net', 'add', 0, '5511777777777@s.whatsapp.net')").run();
  db.prepare("INSERT INTO group_reads (jid, participant, day, ts) VALUES ('g@g.us', '5511999999999@s.whatsapp.net', '2026-11-02', 1)").run();
  assert.equal(migrarPseudonimos(db), 2);
  const ev = db.prepare('SELECT participant, actor FROM group_events').get();
  assert.equal(ev.participant, a); assert.equal(ev.actor, pseudonimo(db, '5511777777777@s.whatsapp.net'));
  assert.equal(db.prepare('SELECT participant FROM group_reads').get().participant, a);
  assert.equal(migrarPseudonimos(db), 0, 'roda uma vez só');
  // banco já migrado (flag setada) ainda recebe a limpeza de resíduos: IP de clique e telefones em propostas antigas
  db.prepare("INSERT INTO links (slug, name, mode, created_at) VALUES ('x', 'x', 'fill', 1)").run();
  db.prepare("INSERT INTO link_clicks (link_id, ts, ip_hash) VALUES (1, 1, 'abc')").run();
  db.prepare("INSERT INTO group_proposals (link_id, name, detail, created_at) VALUES (1, 'x', ?, 1)").run(JSON.stringify({ admins_adicionados: ['5511999999999@s.whatsapp.net'], admins_nao_adicionados: [] }));
  assert.equal(migrarPseudonimos(db), 2, 'limpeza roda mesmo com a flag');
  assert.equal(db.prepare('SELECT ip_hash FROM link_clicks').get().ip_hash, null);
  assert.deepEqual(JSON.parse(db.prepare('SELECT detail FROM group_proposals').get().detail), { admins_adicionados: 1, admins_nao_adicionados: 0 });
  assert.equal(migrarPseudonimos(db), 0, 'limpeza é idempotente');
  assert.equal(chaveIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(chaveIp('::ffff:10.0.0.1'), '10.0.0.1');
});

test('whatsapp grava pseudônimos quando recebe a função; retenção apaga o antigo; exclusão por titular', () => {
  const dir = tmp(); const db = openDb(dir);
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('g@g.us', 'G', 10, Date.now());
  const wa = createWhatsApp({ db, dir, dryRun: true, pseudo: (id) => pseudonimo(db, id) });
  wa._onParticipants({ id: 'g@g.us', author: '5511999999999@s.whatsapp.net', participants: [{ id: '5511999999999@s.whatsapp.net' }], action: 'add' });
  const row = db.prepare('SELECT participant FROM group_events').get();
  assert.match(row.participant, /^[a-f0-9]{32}$/); assert.ok(!row.participant.includes('5511'));
  const now = Date.now();
  db.prepare("INSERT INTO group_events (ts, jid, participant, action) VALUES (?, 'g@g.us', 'velho', 'add')").run(now - 100 * D);
  db.prepare("INSERT INTO group_reads (jid, participant, day, ts) VALUES ('g@g.us', 'velho', '2026-01-01', ?)").run(now - 100 * D);
  db.prepare("INSERT INTO link_clicks (ts, link_id, jid) VALUES (?, 1, 'g@g.us')").run(now - 100 * D);
  db.prepare("INSERT INTO sessions (id, created_at, expires_at, ip) VALUES ('s', 1, ?, '')").run(now - 1);
  const r = limparAntigos(db, 90, now);
  assert.deepEqual([r.eventos, r.leituras, r.cliques, r.sessoes], [1, 1, 1, 1]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_events').get().n, 1, 'o recente fica');
  assert.deepEqual(limparAntigos(db, 0, now).eventos, undefined, '0 = não apaga eventos');
  assert.equal(apagarParticipante(db, '5511999999999').eventos, 1, 'apaga pelo número');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM group_events').get().n, 0);
});

test('extensão: só link meli.la no modo extensão; lista validada (host, tamanhos); modo fake continua livre', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  assert.ok(LINK_MELI.test('https://meli.la/2AbCdEf')); assert.ok(!LINK_MELI.test('https://meli.la.evil.com/x')); assert.ok(!LINK_MELI.test('http://meli.la/x'));
  // link malicioso é recusado
  const lastPoll = () => links.poll(500);
  const p1 = links.requestLink({ url: 'u', tag: 't' }).catch((e) => e.message); // sem poll antes: offline
  assert.match(await p1, /não está conectada/);
  const ext = (async () => { const job = await lastPoll(); links.submit(job.id, { ok: true, link: 'https://golpe.example/x' }); })();
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(links.requestLink({ url: 'u', tag: 't' }), /não é meli\.la/);
  await ext;
  // lista: cartões fora do Mercado Livre e com campos estranhos são descartados; a resposta não-lista é recusada
  const bom = amostraHub();
  const ruim = JSON.parse(JSON.stringify(bom));
  ruim[0].polycard_client_model.polycards[0].metadata.url = 'https://phishing.example/produto';
  ruim[0].polycard_client_model.polycards[1].components.find((c) => c.id === 'title').title.text = 'x'.repeat(301);
  ruim[0].polycard_client_model.polycards[2].pictures.pictures[0].id = '../../etc/passwd';
  ruim[0].polycard_client_model.polycard_context.url_prefix = 'javascript:';
  const v = validarPaginas(ruim);
  assert.equal(v.ok, true); assert.equal(v.paginas[0].polycard_client_model.polycards.length, 2);
  assert.equal(v.paginas[0].polycard_client_model.polycard_context.url_prefix, 'https://');
  assert.equal(validarPaginas({}).ok, false); assert.equal(validarPaginas(Array(31).fill({})).ok, false);
  assert.equal(validarPaginas(bom).paginas[0].polycard_client_model.polycards.length, 5);
  // modo fake: aceita qualquer http(s)
  const fake = createLinkService({ getMode: () => 'fake' });
  assert.match(await fake.requestLink({ url: 'u', tag: 't' }), /^https:\/\/meli\.la\/fake-/);
});

test('fontes: lista só aceita links do Mercado Livre; imagem só do mlstatic; período personalizado limitado a 366 dias', () => {
  const l = parseListLines('https://produto.mercadolivre.com.br/MLB-1234567890-a | A | 10\nhttps://evil.example/MLB-1234567891-b | B | 10\nhttps://meli.la/abc | C | 5\nhttps://www.mercadolibre.com/x | D | 5');
  assert.deepEqual(l.map((o) => o.title), ['A', 'C', 'D']);
  assert.ok(hostPermitido('https://www.mercadolivre.com.br/p/MLB1')); assert.ok(!hostPermitido('https://mercadolivre.com.br.evil.com/'));
  assert.ok(IMAGEM_PERMITIDA.test('https://http2.mlstatic.com/D_NQ_NP_2X_1-F.jpg')); assert.ok(!IMAGEM_PERMITIDA.test('http://169.254.169.254/latest'));
  const p = parseProductHtml('<script type="application/ld+json">{"@type":"Product","name":"X","image":"http://127.0.0.1:3737/api/state","offers":{"price":10}}</script>');
  assert.equal(p.image, null, 'imagem fora do CDN é descartada');
  const now = new Date(2026, 10, 2).getTime();
  const r = periodRange('custom', now, { de: '2000-01-01', ate: '2026-11-02' });
  assert.ok((r.ate - r.de) <= 366 * D + D);
  assert.equal(dayOf(periodRange('custom', now, { de: 'lixo', ate: 'lixo' }).de), '2026-11-02');
});

// ---------- servidor ----------
function subir({ publicHost = 'painel.exemplo.com', panelPassword = 'senha-de-teste-123' } = {}) {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  const app = buildApp({ db, wa, links, scheduler, publicHost, panelPassword });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at, invite_code) VALUES (?,?,?,?,?)').run('g1@g.us', 'Casa', 5, Date.now(), 'ABCDEFGHIJKL');
  db.prepare("INSERT INTO links (name, slug, group_jids, created_at) VALUES ('L', 'l', '[\"g1@g.us\"]', 1)").run();
  return new Promise((ok) => { const server = app.listen(0, '127.0.0.1', () => ok({ db, port: server.address().port, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) })); });
}
function req(port, caminho, { method = 'GET', headers = {}, body, raw } = {}) {
  return new Promise((ok, err) => {
    const data = raw != null ? raw : body != null ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: { ...(data != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, headers: res.headers, json, txt }); });
    });
    r.on('error', err); if (data != null) r.write(data); r.end();
  });
}
const login = (port, senha = 'senha-de-teste-123', headers = {}) => req(port, '/api/login', { method: 'POST', body: { senha }, headers });

test('rotacionador público: 1 clique por IP por hora, limite de 120/min, IP não vai para o banco', async () => {
  const s = await subir();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await req(s.port, '/g/l')).status, 302);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM link_clicks').get().n, 1, 'mesmo IP na mesma hora conta uma vez');
    assert.equal(s.db.prepare('SELECT ip_hash FROM link_clicks').get().ip_hash, null);
    assert.equal((await req(s.port, '/g/l', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 302);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM link_clicks').get().n, 2, 'outro IP conta');
    let ultimo;
    for (let i = 0; i < 125; i++) ultimo = await req(s.port, '/g/l', { headers: { 'x-forwarded-for': '198.51.100.7' } });
    assert.equal(ultimo.status, 429, 'passou de 120 no minuto');
  } finally { await s.fechar(); }
});

test('erros sem stack: JSON inválido -> 400 curto; corpo acima de 100 kB -> 413; cookie malformado não derruba; CSP presente', async () => {
  const s = await subir();
  try {
    const r = await req(s.port, '/api/login', { method: 'POST', raw: '{"senha":' });
    assert.equal(r.status, 400); assert.deepEqual(r.json, { erro: 'Requisição inválida' }); assert.ok(!r.txt.includes('at '), 'sem stack');
    const grande = await req(s.port, '/api/login', { method: 'POST', raw: JSON.stringify({ senha: 'a'.repeat(200000) }) });
    assert.equal(grande.status, 413); assert.deepEqual(grande.json, { erro: 'Corpo grande demais' });
    const c = await req(s.port, '/api/state', { headers: { cookie: 'sid=%E0%A4%A' } });
    assert.equal(c.status, 401, 'cookie quebrado = sem sessão, não 500');
    const h = (await req(s.port, '/healthz')).headers;
    assert.match(h['content-security-policy'], /default-src 'self'/); assert.match(h['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal((await req(s.port, '/login.js')).status, 200, 'script do login em arquivo próprio e público');
  } finally { await s.fechar(); }
});

test('login: limite global além do limite por IP; sessão guardada como hash; senha de ambiente curta é recusada', async () => {
  const s = await subir();
  try {
    let ultimo;
    for (let i = 0; i < 52; i++) ultimo = await login(s.port, 'errada', { 'x-forwarded-for': `203.0.113.${i}` });
    assert.equal(ultimo.status, 429, 'trocar o IP a cada tentativa não escapa do limite global');
  } finally { await s.fechar(); }
  const s2 = await subir();
  try {
    const ok = await login(s2.port);
    const sid = ok.headers['set-cookie'][0].split(';')[0].split('=')[1];
    const row = s2.db.prepare('SELECT id, last_seen FROM sessions').get();
    assert.notEqual(row.id, sid, 'no banco fica o hash, não o identificador');
    assert.equal(row.id.length, 64); assert.ok(row.last_seen > 0);
    assert.equal((await req(s2.port, '/api/state', { headers: { cookie: 'sid=' + sid } })).status, 200);
    // inatividade: sessão sem uso há 8 dias cai
    s2.db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - 8 * D);
    assert.equal((await req(s2.port, '/api/state', { headers: { cookie: 'sid=' + sid } })).status, 401);
  } finally { await s2.fechar(); }
  const dir = tmp(); const db = openDb(dir);
  assert.throws(() => buildApp({ db, wa: createWhatsApp({ db, dir, dryRun: true }), links: createLinkService({ getMode: () => 'fake' }), scheduler: { isRunning: () => false }, publicHost: 'x.com', panelPassword: 'curta' }), /8 caracteres/);
});

test('API: configuração de fonte só com chaves e tipos conhecidos; token da extensão pode ser trocado; limpeza manual', async () => {
  const s = await subir();
  try {
    const sid = (await login(s.port)).headers['set-cookie'][0].split(';')[0];
    const h = { cookie: sid, origin: `http://127.0.0.1:${s.port}` };
    s.db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('t', Date.now());
    const r = await req(s.port, '/api/rules', { method: 'POST', headers: h, body: { name: 'R', tag_id: 1, template_id: 1, group_jids: [], sources: [{ type: 'afiliados', config: { paginas: '"><img src=x onerror=alert(1)>', categorias: ['MLB1574', 'INVENTADA'], ordem: 'hack', busca: 'x'.repeat(500), extra: 'lixo' } }] } });
    assert.equal(r.status, 200);
    const cfg = (await req(s.port, '/api/rules', { headers: h })).json[0].sources[0].config;
    assert.deepEqual(cfg, { busca: 'x'.repeat(80), categorias: ['MLB1574'], ordem: 'relevance', paginas: 3, mais_vendidos: false, ganhos_extras: false });
    const antes = getSetting(s.db, 'ext_token');
    assert.equal((await req(s.port, '/api/ajustes/token', { method: 'POST', headers: h })).status, 200);
    assert.equal((await req(s.port, '/api/ajustes/token', { method: 'POST', headers: { ...h, origin: 'https://site-malicioso.com' } })).status, 403, 'rotação do token exige origem própria');
    const depois = getSetting(s.db, 'ext_token');
    assert.notEqual(antes, depois); assert.equal(depois.length, 48);
    assert.equal((await req(s.port, '/api/ext/result', { method: 'POST', body: {}, headers: { 'x-token': antes } })).status, 401, 'token antigo morreu');
    assert.equal((await req(s.port, '/api/ext/result', { method: 'POST', body: {}, headers: { 'x-token': depois } })).status, 200);
    const limpo = await req(s.port, '/api/privacidade/limpar', { method: 'POST', headers: h });
    assert.equal(limpo.status, 200); assert.ok('sessoes' in limpo.json);
    assert.equal((await req(s.port, '/api/ajustes', { method: 'PUT', headers: h, body: { retencao_dias: 30 } })).status, 200);
    assert.equal((await req(s.port, '/api/state', { headers: h })).json.ajustes.retencao_dias, 30);
  } finally { await s.fechar(); }
});

test('backup: destino padrão fica em data/backups (ignorado pelo git) e o .gitignore cobre backups, tar.gz e .env', () => {
  const gi = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  for (const linha of ['data/', 'backups/', '*.tar.gz', '.env', '.env.*', '!.env.example']) assert.ok(gi.split('\n').includes(linha), linha);
  const src = fs.readFileSync(new URL('../scripts/backup.js', import.meta.url), 'utf8');
  assert.ok(src.includes("path.join(DATA_DIR, 'backups')")); assert.ok(!src.includes("path.join(DATA_DIR, '..', 'backups')"));
});

test('S12: rajada simultânea não atravessa o freio; teto de 2 logins em andamento; IP com login recente não sofre o limite global; IPv6 comprimido', async () => {
  const s = await subir();
  try {
    const rajada = await Promise.all(Array.from({ length: 20 }, () => login(s.port, 'errada', { 'x-forwarded-for': '203.0.113.50' })));
    const c = rajada.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
    assert.ok((c[401] || 0) <= 5, `no máximo 5 palpites avaliados, veio ${JSON.stringify(c)}`);
    assert.equal((c[401] || 0) + (c[429] || 0), 20);
    // em ondas de 2 (dentro do teto): só a contagem ANTES do scrypt limita a exatamente 5 palpites; depois seriam 6
    let avaliados = 0;
    for (let onda = 0; onda < 4; onda++) {
      const rs = await Promise.all([0, 1].map(() => login(s.port, 'errada', { 'x-forwarded-for': '203.0.113.51' })));
      avaliados += rs.filter((r) => r.status === 401).length;
    }
    assert.equal(avaliados, 5, 'tentativa contada antes de verificar a senha');
    // dono: entra certo de um IP; depois 50 erros de terceiros não o trancam
    assert.equal((await login(s.port, 'senha-de-teste-123', { 'x-forwarded-for': '198.51.100.1' })).status, 200);
    for (let i = 0; i < 60; i++) await login(s.port, 'errada', { 'x-forwarded-for': `203.0.113.${100 + (i % 50)}` });
    assert.equal((await login(s.port, 'errada', { 'x-forwarded-for': '203.0.113.200' })).status, 429, 'terceiro: limite global ativo');
    assert.equal((await login(s.port, 'senha-de-teste-123', { 'x-forwarded-for': '198.51.100.1' })).status, 200, 'dono continua entrando');
  } finally { await s.fechar(); }
  assert.equal(chaveIp('2804:14c::aaaa:bbbb:cccc:dddd'), '2804:14c:0:0::/64');
  assert.equal(chaveIp('2804:14c:0:0:1111:2222:3333:4444'), '2804:14c:0:0::/64', 'mesmo /64, mesma chave');
  assert.notEqual(chaveIp('2804:14c::aaaa:bbbb:cccc:dddd'), chaveIp('2804:14c:0:1::1'));
});

test('extensão: corpo grande sem token é recusado antes de ser lido (401, não 413)', async () => {
  const s = await subir();
  try {
    const r = await req(s.port, '/api/ext/result', { method: 'POST', raw: '{"a":"' + 'x'.repeat(6_000_000) + '"}' /* acima dos 5 MB: na ordem errada daria 413 */, headers: { 'x-token': 'errado' } });
    assert.equal(r.status, 401);
  } finally { await s.fechar(); }
});
