// Correções da revisão de segurança (S1–S11): privacidade, validação do que a extensão devolve,
// limites de taxa e de corpo, erros sem stack, CSP, sessão com hash, backup fora do git.
import test, { after } from 'node:test';
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
import { MENSAGENS_CSV } from '../src/csv.js';
import { MENSAGENS_IMPORTADOR } from '../src/importador.js';
import { MENSAGENS_GANHOS } from '../src/ganhos.js';

// pastas temporárias apagadas no fim do arquivo
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-seg-')); pastas.push(p); return p; };
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
function subir({ publicHost = 'painel.exemplo.com', panelPassword = 'senha-de-teste-123', modoLink = 'fake' } = {}) {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => modoLink });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  const app = buildApp({ db, wa, links, scheduler, publicHost, panelPassword });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at, invite_code) VALUES (?,?,?,?,?)').run('g1@g.us', 'Casa', 5, Date.now(), 'ABCDEFGHIJKL');
  db.prepare("INSERT INTO links (name, slug, group_jids, created_at) VALUES ('L', 'l', '[\"g1@g.us\"]', 1)").run();
  return new Promise((ok) => { const server = app.listen(0, '127.0.0.1', () => ok({ db, links, port: server.address().port, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) })); });
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

test('backup: destino padrão fica em data/backups (ignorado pelo git) e o .gitignore cobre backups, tar.gz, .gpg e .env', () => {
  const gi = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  for (const linha of ['data/', 'backups/', '*.tar.gz', '*.gpg', '.env', '.env.*', '!.env.example']) assert.ok(gi.split('\n').includes(linha), linha);
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

// ---------- rastreio por grupo (plano dashboard-ganhos, etapa 6; CA11, P2: só Dono, inclusive GET) ----------
test('rastreio: Operador recebe 403 em GET/PUT das associações e na cobertura; sem login 401; outra origem 403; nada gravado', async () => {
  const s = await subir();
  try {
    const sid = (await login(s.port)).headers['set-cookie'][0].split(';')[0];
    const h = { cookie: sid, origin: `http://127.0.0.1:${s.port}` };
    s.db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (1, 'B1', 1)").run();
    const corpo = { loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: 'casa-20' };
    const rotas = [['GET', '/api/rastreio/codigos'], ['PUT', '/api/rastreio/codigos', corpo], ['GET', '/api/rastreio/cobertura?periodo=30d']];
    for (const [method, caminho, body] of rotas) {
      assert.equal((await req(s.port, caminho, { method, headers: h, body })).status, 200, `Dono: ${method} ${caminho}`);
    }
    s.db.prepare('DELETE FROM rastreio_codigos').run();
    s.db.prepare("UPDATE users SET papel = 'operador'").run(); // o papel é relido a cada requisição
    const outra = { ...corpo, codigo: 'outra-20' };
    for (const [method, caminho, body] of rotas) {
      const r = await req(s.port, caminho, { method, headers: h, body: body && outra });
      assert.deepEqual([r.status, r.json], [403, { erro: 'Só o Dono pode fazer isso.' }], `Operador: ${method} ${caminho}`);
      assert.equal((await req(s.port, caminho, { method, headers: { origin: h.origin }, body: body && outra })).status, 401, `sem login: ${method} ${caminho}`);
      assert.equal((await req(s.port, caminho, { method, headers: { ...h, origin: 'https://outro-site.com' }, body: body && outra })).status, 403, `outra origem: ${method} ${caminho}`);
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM rastreio_codigos').get().n, 0, 'nenhuma associação gravada sem ser o Dono');
  } finally { await s.fechar(); }
});

// CA11 pelas rotas de blocos e etiquetas (achados S1/R1/Q1 da rodada 1): apagar o bloco ou trocar os grupos dele
// mexe nas associações tanto quanto o PUT de /api/rastreio/codigos
const FRASE_APAGAR_BLOCO = 'Este bloco tem códigos de rastreio. Só o Dono pode apagá-lo.';
const FRASE_GRUPOS_BLOCO = 'Este bloco tem códigos de rastreio. Só o Dono pode mudar os grupos dele.';
const FRASE_ETIQUETA = 'Esta etiqueta é código de rastreio de um grupo ou bloco. Tire a associação antes de apagá-la.';
async function painelComBloco(s) {
  const sid = (await login(s.port)).headers['set-cookie'][0].split(';')[0];
  const h = { cookie: sid, origin: `http://127.0.0.1:${s.port}` };
  s.db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('g2@g.us', 'Tech', 5, Date.now());
  s.db.prepare("INSERT INTO tags (id, name, created_at) VALUES (1, 'casa', 1)").run();
  s.db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (1, 'B1', 1)").run();
  s.db.prepare("INSERT INTO block_groups (block_id, jid) VALUES (1, 'g1@g.us')").run();
  const n = (tabela) => s.db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n;
  const gruposDoBloco = () => s.db.prepare('SELECT jid FROM block_groups WHERE block_id = 1 ORDER BY jid').all().map((r) => r.jid);
  const papel = (p) => s.db.prepare('UPDATE users SET papel = ?').run(p);
  return { h, n, gruposDoBloco, papel, pedir: (caminho, method, body) => req(s.port, caminho, { method, headers: h, body }) };
}

test('rastreio (CA11): bloco com código — Operador não apaga nem troca os grupos (403, a associação fica); nome e etiqueta livres; o Dono pode', async () => {
  const s = await subir();
  try {
    const p = await painelComBloco(s);
    s.db.prepare("INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo, criado_em, atualizado_em) VALUES ('amazon', 'bloco', '1', 'casa-20', 1, 1)").run();
    p.papel('operador');

    let r = await p.pedir('/api/blocks/1', 'DELETE');
    assert.deepEqual([r.status, r.json], [403, { erro: FRASE_APAGAR_BLOCO }]);
    // id escrito de outro jeito não escapa da checagem (o SQLite acharia o bloco 1 com '01', '1e0', '+1'…)
    for (const id of ['01', '1e0', '%2B1', '1.0', '%201', '0x1']) {
      r = await p.pedir(`/api/blocks/${id}`, 'DELETE');
      assert.notEqual(r.status, 500, id);
      assert.deepEqual([id, p.n('blocks'), p.n('block_groups'), p.n('rastreio_codigos')], [id, 1, 1, 1], `DELETE ${id}: o bloco e a associação ficam`);
    }

    r = await p.pedir('/api/blocks/1', 'PUT', { name: 'B1 novo', tag_id: 1, note: 'x', group_jids: ['g1@g.us', 'g1@g.us'] });
    assert.equal(r.status, 200, `nome, etiqueta e nota continuam livres: ${r.txt}`);
    assert.deepEqual({ ...s.db.prepare('SELECT name, tag_id FROM blocks WHERE id = 1').get() }, { name: 'B1 novo', tag_id: 1 });
    for (const corpo of [{ name: 'Outro', group_jids: ['g1@g.us', 'g2@g.us'] }, { name: 'Outro', group_jids: [] }, { name: 'Outro' }, { name: 'Outro', group_jids: ['g2@g.us'] }]) {
      r = await p.pedir('/api/blocks/1', 'PUT', corpo);
      assert.deepEqual([r.status, r.json], [403, { erro: FRASE_GRUPOS_BLOCO }], JSON.stringify(corpo));
    }
    for (const id of ['01', '1e0', '%2B1', '1.0']) {
      r = await p.pedir(`/api/blocks/${id}`, 'PUT', { name: 'Outro', group_jids: ['g2@g.us'] });
      assert.notEqual(r.status, 200, `PUT ${id}`);
    }
    assert.deepEqual(p.gruposDoBloco(), ['g1@g.us'], 'os grupos do bloco não mudaram');
    assert.equal(s.db.prepare('SELECT name FROM blocks WHERE id = 1').get().name, 'B1 novo', 'o PUT recusado não grava nada');
    assert.equal(p.n('rastreio_codigos'), 1);

    p.papel('dono');
    r = await p.pedir('/api/blocks/1', 'PUT', { name: 'B1', group_jids: ['g1@g.us', 'g2@g.us'] });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(p.gruposDoBloco(), ['g1@g.us', 'g2@g.us']);
    r = await p.pedir('/api/blocks/1', 'DELETE');
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([p.n('blocks'), p.n('block_groups'), p.n('rastreio_codigos')], [0, 0, 0], 'bloco, grupos e associações saem juntos');
  } finally { await s.fechar(); }
});

test('rastreio (CA11): bloco sem código — o Operador continua criando, trocando grupos e apagando como hoje', async () => {
  const s = await subir();
  try {
    const p = await painelComBloco(s);
    // associação de outro bloco e de grupo não travam este
    s.db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (2, 'B2', 1)").run();
    s.db.prepare("INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo, criado_em, atualizado_em) VALUES ('amazon', 'bloco', '2', 'b2-20', 1, 1), ('amazon', 'grupo', 'g1@g.us', 'g1-20', 1, 1)").run();
    p.papel('operador');
    let r = await p.pedir('/api/blocks/1', 'PUT', { name: 'B1', group_jids: ['g1@g.us', 'g2@g.us'] });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(p.gruposDoBloco(), ['g1@g.us', 'g2@g.us']);
    r = await p.pedir('/api/blocks', 'POST', { name: 'Novo', group_jids: ['g2@g.us'] });
    assert.equal(r.status, 200, r.txt);
    r = await p.pedir('/api/blocks/1', 'DELETE');
    assert.equal(r.status, 200, r.txt);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE id = 1').get().n, 0);
    assert.equal(p.n('rastreio_codigos'), 2, 'as associações dos outros alvos ficam');
    r = await p.pedir('/api/tags/1', 'DELETE');
    assert.equal(r.status, 200, `etiqueta sem associação continua apagável: ${r.txt}`);
  } finally { await s.fechar(); }
});

test('rastreio (CA11): etiqueta que é código de rastreio do Mercado Livre não se apaga (frase fixa); só o nome no ML conta', async () => {
  const s = await subir();
  try {
    const p = await painelComBloco(s);
    s.db.prepare("INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo, criado_em, atualizado_em) VALUES ('mercadolivre', 'grupo', 'g1@g.us', 'casa', 1, 1)").run();
    for (const papel of ['dono', 'operador']) {
      p.papel(papel);
      const r = await p.pedir('/api/tags/1', 'DELETE');
      assert.deepEqual([papel, r.status, r.json], [papel, 400, { erro: FRASE_ETIQUETA }]);
    }
    assert.equal(p.n('tags'), 1, 'a etiqueta ficou');
    // o mesmo texto como código de outra loja não é a etiqueta
    s.db.prepare("UPDATE rastreio_codigos SET loja = 'amazon'").run();
    p.papel('dono');
    const r = await p.pedir('/api/tags/1', 'DELETE');
    assert.equal(r.status, 200, r.txt);
    assert.equal(p.n('tags'), 0);
  } finally { await s.fechar(); }
});

test('extensão: POST /api/ext/result repassa sub_id_aplicado ao serviço de links (só o true literal vale)', async () => {
  const s = await subir({ modoLink: 'extension' });
  try {
    const token = getSetting(s.db, 'ext_token');
    await s.links.poll(0); // extensão "on-line"
    const responder = async (sub_id_aplicado) => {
      const pedido = s.links.requestLinkShopee({ url: 'https://shopee.com.br/produto-i.1.2', subId: 'g1', timeoutMs: 3000 });
      const job = await s.links.poll(1000);
      assert.deepEqual([job?.type, job?.subId], ['link_shopee', 'g1']);
      const r = await req(s.port, '/api/ext/result', { method: 'POST', headers: { 'x-token': token }, body: { id: job.id, ok: true, link: 'https://s.shopee.com.br/AbC123', sub_id_aplicado } });
      assert.deepEqual([r.status, r.json], [200, { ok: true }]);
      return (await pedido).subIdAplicado;
    };
    assert.equal(await responder(true), true, 'a extensão aplicou o Sub_id');
    assert.equal(await responder('true'), false, 'texto não vale');
    assert.equal(await responder(undefined), false, 'extensão antiga (sem o campo)');
  } finally { await s.fechar(); }
});

// ---------- ganhos (plano dashboard-ganhos, etapa 16; CA5, CA11, P2: tudo só do Dono, inclusive GET) ----------
const csvGanhos = (...l) => Buffer.from(l.join('\r\n') + '\r\n', 'utf8');
// Shopee inventada, com colunas de comprador: nada disto pode voltar em resposta nenhuma
const PESSOAIS_GANHOS = ['Fulana de Teste', '90000-0001', 'Rua Inventada', '2610PEDIDOSEG'];
const CSV_SHOPEE_SEG = csvGanhos(
  'ID do pedido,Status do pedido,Hora do pedido,ID do item,Nome do item,Qtd,Valor de compra(R$),Comissão total do item(R$),Sub_id1,Nome do comprador,Telefone do comprador,Endereço de entrega',
  '2610PEDIDOSEG1,Pendente,2026-10-05 10:00:00,2,Garrafa inventada,1,"50,00","3,00",g1,Fulana de Teste,(31) 90000-0001,Rua Inventada 123');
const GASTO_SEG = { alvo_tipo: 'grupo', alvo: 'g1@g.us', inicio: '2026-10-01', fim: '2026-10-31', valor_centavos: 1500, nota: 'Meta Ads' };
const Q_OUT = 'periodo=custom&de=2026-10-01&ate=2026-10-31';
/** POST do arquivo cru, como o painel manda (corpo text/csv; outro tipo pelo `tipo`). */
const enviarCsv = (port, caminho, corpo, headers = {}, tipo = 'text/csv') =>
  req(port, caminho, { method: 'POST', raw: corpo, headers: { 'content-type': tipo, ...headers } });
const semEco = (r, rotulo) => { for (const p of [...PESSOAIS_GANHOS, 'Garrafa']) assert.ok(!r.txt.includes(p), `${rotulo}: ecoou ${p}`); };

test('ganhos (CA11): todas as rotas B montadas no buildApp — Operador 403 (inclusive GET), sem login 401, outra origem 403, nada gravado; o Dono usa', async () => {
  const s = await subir();
  try {
    const sid = (await login(s.port)).headers['set-cookie'][0].split(';')[0];
    const h = { cookie: sid, origin: `http://127.0.0.1:${s.port}` };
    const n = () => ['importacoes', 'comissoes', 'cliques_loja', 'gastos_anuncio'].map((t) => s.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    // [método, caminho, corpo JSON | arquivo CSV]
    const rotas = [
      ['POST', '/api/ganhos/importar?loja=shopee&previa=1', CSV_SHOPEE_SEG],
      ['POST', '/api/ganhos/importar?loja=shopee', CSV_SHOPEE_SEG],
      ['GET', '/api/ganhos/importacoes'],
      ['GET', `/api/ganhos?${Q_OUT}`],
      ['GET', `/api/ganhos?${Q_OUT}&por=bloco`],
      ['GET', '/api/ganhos/gastos'],
      ['POST', '/api/ganhos/gastos', GASTO_SEG],
      ['DELETE', '/api/ganhos/gastos/1'],
      ['DELETE', '/api/ganhos/importacoes/1'],
    ];
    const pedir = (method, caminho, corpo, headers) => (Buffer.isBuffer(corpo)
      ? enviarCsv(s.port, caminho, corpo, headers)
      : req(s.port, caminho, { method, headers, body: corpo }));

    s.db.prepare("UPDATE users SET papel = 'operador'").run(); // o papel é relido a cada requisição
    for (const [method, caminho, corpo] of rotas) {
      const op = await pedir(method, caminho, corpo, h);
      assert.deepEqual([op.status, op.json], [403, { erro: 'Só o Dono pode fazer isso.' }], `Operador: ${method} ${caminho}`);
      const anon = await pedir(method, caminho, corpo, { origin: h.origin });
      assert.deepEqual([anon.status, anon.json], [401, { erro: 'Faça login para continuar' }], `sem login: ${method} ${caminho}`);
      const fora = await pedir(method, caminho, corpo, { ...h, origin: 'https://outro-site.com' });
      assert.deepEqual([fora.status, fora.json], [403, { erro: 'Origem não permitida' }], `outra origem: ${method} ${caminho}`);
      for (const r of [op, anon, fora]) semEco(r, `${method} ${caminho}`);
    }
    assert.deepEqual(n(), [0, 0, 0, 0], 'nada importado nem gasto gravado sem ser o Dono');

    s.db.prepare("UPDATE users SET papel = 'dono'").run();
    for (const [method, caminho, corpo] of rotas) {
      const r = await pedir(method, caminho, corpo, h);
      assert.equal(r.status, 200, `Dono: ${method} ${caminho}: ${r.txt}`);
      semEco(r, `Dono: ${method} ${caminho}`);
    }
    assert.deepEqual(n(), [0, 0, 0, 0], 'o Dono importou, lançou o gasto e apagou os dois');
  } finally { await s.fechar(); }
});

test('ganhos (CA5, CA11): upload pelo servidor de verdade — application/json 415 (mesmo acima de 100 kB), 6 MB 413, corpo do Operador recusado antes de ser lido; sem eco do arquivo', async () => {
  const s = await subir();
  try {
    const sid = (await login(s.port)).headers['set-cookie'][0].split(';')[0];
    const h = { cookie: sid, origin: `http://127.0.0.1:${s.port}` };
    const caminho = '/api/ganhos/importar?loja=shopee';
    const casos = [
      // o parser JSON global não pode responder no lugar do importador (400/413 em vez de 415)
      ['CSV com application/json', CSV_SHOPEE_SEG, 'application/json', 415, MENSAGENS_CSV.tipo],
      ['JSON válido com application/json', Buffer.from('{"nome":"Fulana de Teste"}'), 'application/json', 415, MENSAGENS_CSV.tipo],
      ['JSON acima de 100 kB', Buffer.from(JSON.stringify({ a: 'Fulana de Teste '.repeat(10_000) })), 'application/json', 415, MENSAGENS_CSV.tipo],
      ['formulário', Buffer.from('nome=Fulana+de+Teste'), 'application/x-www-form-urlencoded', 415, MENSAGENS_CSV.tipo],
      ['XLSX', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('Fulana de Teste')]), 'text/csv', 415, MENSAGENS_CSV.excel],
      ['6 MB', Buffer.concat([CSV_SHOPEE_SEG, Buffer.alloc(6 * 1024 * 1024, 'a')]), 'text/csv', 413, MENSAGENS_CSV.tamanho],
      ['só colunas de comprador', csvGanhos('Nome do comprador,Telefone do comprador', 'Fulana de Teste,(31) 90000-0001'), 'text/csv', 400, MENSAGENS_IMPORTADOR.semComissao],
      ['byte NUL', Buffer.from('Data,Comissão\n2026-10-05,Fulana de Teste\u0000'), 'text/plain', 400, MENSAGENS_CSV.binario],
    ];
    for (const [rotulo, corpo, tipo, status, erro] of casos) {
      const r = await enviarCsv(s.port, caminho, corpo, h, tipo);
      assert.deepEqual([r.status, r.json], [status, { erro }], rotulo);
      semEco(r, rotulo);
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM importacoes').get().n, 0, 'nenhuma recusa gravou importação');

    // text/csv com charset e text/plain passam pelos parsers globais intactos
    let r = await enviarCsv(s.port, `${caminho}&previa=1`, CSV_SHOPEE_SEG, h, 'text/csv; charset=utf-8');
    assert.deepEqual([r.status, r.json?.previa, r.json?.novas], [200, true, 1], r.txt);
    r = await enviarCsv(s.port, caminho, CSV_SHOPEE_SEG, h, 'text/plain');
    assert.deepEqual([r.status, r.json?.novas], [200, 1], r.txt);
    semEco(r, 'importação gravada');

    // 6 MB de quem não é o Dono: recusado pelo papel/sessão, não pelo tamanho (o corpo nem é lido)
    const grande = Buffer.alloc(6 * 1024 * 1024, 'a');
    s.db.prepare("UPDATE users SET papel = 'operador'").run();
    assert.equal((await enviarCsv(s.port, caminho, grande, h)).status, 403, 'Operador com 6 MB');
    assert.equal((await enviarCsv(s.port, caminho, grande, { origin: h.origin })).status, 401, 'sem login com 6 MB');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM importacoes').get().n, 1);
  } finally { await s.fechar(); }
});

test('ganhos: bloco apagado (DELETE /api/blocks/:id) e grupo que sumiu não quebram a página — aparecem com nome null', async () => {
  const s = await subir();
  try {
    const sid = (await login(s.port)).headers['set-cookie'][0].split(';')[0];
    const h = { cookie: sid, origin: `http://127.0.0.1:${s.port}` };
    s.db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('g2@g.us', 'Tech', 5, Date.now());
    let r = await req(s.port, '/api/blocks', { method: 'POST', headers: h, body: { name: 'B1', group_jids: ['g2@g.us'] } });
    assert.equal(r.status, 200, r.txt);
    const bloco = Number(r.json.id);
    // histórico de envios rastreados (fica depois de apagar o bloco): Amazon do bloco e do grupo g1
    const envio = s.db.prepare(`INSERT INTO rastreio_envios (ts, jid, loja, origem, link, codigo, nivel, bloco_id, esperado)
      VALUES (?, ?, 'amazon', 'regra', 'https://www.amazon.com.br/dp/B0TESTE001', ?, ?, ?, 1)`);
    const ts = new Date(2026, 9, 2, 12).getTime();
    envio.run(ts, 'g2@g.us', 'turbob1-20', 'bloco', bloco);
    envio.run(ts, 'g1@g.us', 'casa-20', 'grupo', null);
    const amazon = csvGanhos('Category,Name,ASIN,Tracking ID,Date Shipped,Items Shipped,Revenue,Ad Fees',
      'Casa,Fone inventado,B0TESTE001,turbob1-20,2026-10-09,1,"100,00","4,00"',
      'Casa,Panela inventada,B0TESTE002,casa-20,2026-10-10,1,"80,00","5,00"');
    r = await enviarCsv(s.port, '/api/ganhos/importar?loja=amazon', amazon, h);
    assert.deepEqual([r.status, r.json?.novas], [200, 2], r.txt);
    for (const g of [{ ...GASTO_SEG, alvo_tipo: 'bloco', alvo: String(bloco) }, GASTO_SEG]) {
      r = await req(s.port, '/api/ganhos/gastos', { method: 'POST', headers: h, body: g });
      assert.equal(r.status, 200, r.txt);
    }

    r = await req(s.port, `/api/blocks/${bloco}`, { method: 'DELETE', headers: h });
    assert.equal(r.status, 200, r.txt);
    s.db.prepare("DELETE FROM groups WHERE jid = 'g1@g.us'").run(); // o WhatsApp não lista mais o grupo (src/whatsapp.js)

    r = await req(s.port, `/api/ganhos?${Q_OUT}&por=bloco`, { headers: h });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(r.json.linhas.map((l) => [l.bloco_id, l.nome, l.comissao, l.grupos]), [[bloco, null, 400, 0]], 'bloco apagado: nome null, a comissão fica');
    r = await req(s.port, `/api/ganhos?${Q_OUT}&por=grupo`, { headers: h });
    assert.equal(r.status, 200, r.txt);
    const g1 = r.json.linhas.find((l) => l.jid === 'g1@g.us');
    assert.deepEqual([g1?.nome, g1?.comissao, g1?.blocos], [null, 500, []], 'grupo que sumiu: nome null');
    assert.equal(r.json.total.comissao, 900);
    for (const por of ['loja', 'oferta', 'dia']) assert.equal((await req(s.port, `/api/ganhos?${Q_OUT}&por=${por}`, { headers: h })).status, 200, por);
    r = await req(s.port, '/api/ganhos/gastos', { headers: h });
    assert.deepEqual([r.status, r.json.gastos.map((g) => g.nome_alvo)], [200, [null, null]], 'gastos de alvo apagado: nome null');
    r = await req(s.port, `/api/ganhos?${Q_OUT}&bloco=${bloco}`, { headers: h });
    assert.deepEqual([r.status, r.json], [404, { erro: MENSAGENS_GANHOS.bloco }], 'filtro por bloco apagado: frase fixa, não 500');
  } finally { await s.fechar(); }
});

// S1/Q3 da rodada 1: blocks.id sem AUTOINCREMENT seria reaproveitado e o bloco novo herdaria comissão e gasto do apagado
test('ganhos (S1/Q3): bloco novo nunca reaproveita o id de um apagado — não herda comissão nem gasto, nem depois de limpo o histórico', async () => {
  const s = await subir();
  try {
    const sid = (await login(s.port)).headers['set-cookie'][0].split(';')[0];
    const h = { cookie: sid, origin: `http://127.0.0.1:${s.port}` };
    const criar = async (name) => {
      const r = await req(s.port, '/api/blocks', { method: 'POST', headers: h, body: { name, group_jids: ['g1@g.us'] } });
      assert.equal(r.status, 200, r.txt);
      return r.json.id;
    };
    const apagar = async (id) => assert.equal((await req(s.port, `/api/blocks/${id}`, { method: 'DELETE', headers: h })).status, 200);
    const b1 = await criar('B1'); const b2 = await criar('B2');
    assert.ok(Number.isInteger(b1) && b2 > b1, `ids ${b1}, ${b2}`);
    // B2 (o de maior id) com envio rastreado, comissão atribuída e gasto
    s.db.prepare(`INSERT INTO rastreio_envios (ts, jid, loja, origem, link, codigo, nivel, bloco_id, esperado)
      VALUES (?, 'g1@g.us', 'amazon', 'regra', 'https://www.amazon.com.br/dp/B0TESTE001', 'turbob2-20', 'bloco', ?, 1)`).run(new Date(2026, 9, 2, 12).getTime(), b2);
    let r = await enviarCsv(s.port, '/api/ganhos/importar?loja=amazon', csvGanhos('Name,ASIN,Tracking ID,Date Shipped,Items Shipped,Revenue,Ad Fees',
      'Fone inventado,B0TESTE001,turbob2-20,2026-10-09,1,"100,00","4,00"'), h);
    assert.deepEqual([r.status, r.json?.novas], [200, 1], r.txt);
    r = await req(s.port, '/api/ganhos/gastos', { method: 'POST', headers: h, body: { ...GASTO_SEG, alvo_tipo: 'bloco', alvo: String(b2), valor_centavos: 3100 } });
    assert.equal(r.status, 200, r.txt);
    await apagar(b2);

    const b3 = await criar('B3');
    assert.ok(b3 > b2, `o bloco novo (${b3}) não reaproveita o id do apagado (${b2})`);
    r = await req(s.port, `/api/ganhos?${Q_OUT}&por=bloco`, { headers: h });
    assert.equal(r.status, 200, r.txt);
    const linha = (id) => r.json.linhas.find((l) => l.bloco_id === id);
    assert.deepEqual([linha(b3)?.nome, linha(b3)?.comissao, linha(b3)?.gasto], ['B3', 0, null], 'B3 nasce sem comissão nem gasto');
    assert.deepEqual([linha(b2)?.nome, linha(b2)?.comissao, linha(b2)?.gasto], [null, 400, 3100], 'o histórico fica no id do apagado');
    r = await req(s.port, '/api/ganhos/gastos', { headers: h });
    assert.ok(!r.json.gastos.some((g) => g.alvo === String(b3)), 'a lista de gastos não mostra gasto no bloco novo');

    // sem rastro nenhum do apagado (histórico e gastos limpos): o id continua não voltando
    s.db.exec('DELETE FROM rastreio_envios; DELETE FROM gastos_anuncio');
    await apagar(b3);
    const b4 = await criar('B4');
    assert.ok(b4 > b3, `depois de limpo o histórico: ${b4} > ${b3}`);
    // banco anterior a esta correção (sem 'ultimo_bloco_id'): o envio de um bloco apagado também conta
    s.db.prepare("DELETE FROM settings WHERE key = 'ultimo_bloco_id'").run();
    s.db.prepare(`INSERT INTO rastreio_envios (ts, jid, loja, origem, link, codigo, nivel, bloco_id, esperado)
      VALUES (1, 'g1@g.us', 'amazon', 'regra', 'https://www.amazon.com.br/dp/B0TESTE001', 'velho-20', 'bloco', ?, 1)`).run(b4 + 10);
    assert.equal(await criar('B5'), b4 + 11, 'passa do maior bloco_id do histórico');
    s.db.prepare("INSERT INTO gastos_anuncio (alvo_tipo, alvo, inicio, fim, valor_centavos, criado_em) VALUES ('bloco', ?, '2026-10-01', '2026-10-31', 100, 1)").run(String(b4 + 20));
    assert.equal(await criar('B6'), b4 + 21, 'passa do maior bloco com gasto');
  } finally { await s.fechar(); }
});

test('ganhos (S1/CA11): bloco com gasto com anúncio — Operador não apaga nem troca os grupos (403, frase fixa); nome livre; o Dono pode', async () => {
  const s = await subir();
  try {
    const p = await painelComBloco(s);
    // gasto de outro bloco e de grupo não travam este; o dele trava
    s.db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (2, 'B2', 1)").run();
    const gasto = s.db.prepare("INSERT INTO gastos_anuncio (alvo_tipo, alvo, inicio, fim, valor_centavos, criado_em) VALUES (?, ?, '2026-10-01', '2026-10-31', 100, 1)");
    gasto.run('bloco', '2'); gasto.run('grupo', 'g1@g.us');
    p.papel('operador');
    let r = await p.pedir('/api/blocks/1', 'PUT', { name: 'B1', group_jids: ['g1@g.us', 'g2@g.us'] });
    assert.equal(r.status, 200, `sem gasto próprio, o Operador regrupa: ${r.txt}`);
    r = await p.pedir('/api/blocks/1', 'PUT', { name: 'B1', group_jids: ['g1@g.us'] });
    assert.equal(r.status, 200, r.txt);

    gasto.run('bloco', '1');
    r = await p.pedir('/api/blocks/1', 'DELETE');
    assert.deepEqual([r.status, r.json], [403, { erro: MENSAGENS_GANHOS.bloco_apagar }]);
    for (const id of ['01', '1e0', '%2B1', '1.0']) {
      r = await p.pedir(`/api/blocks/${id}`, 'DELETE');
      assert.notEqual(r.status, 500, id);
    }
    assert.deepEqual([p.n('blocks'), p.n('block_groups'), p.n('gastos_anuncio')], [2, 1, 3], 'o bloco, os grupos e os gastos ficam');
    for (const corpo of [{ name: 'Outro', group_jids: ['g1@g.us', 'g2@g.us'] }, { name: 'Outro', group_jids: [] }, { name: 'Outro' }]) {
      r = await p.pedir('/api/blocks/1', 'PUT', corpo);
      assert.deepEqual([r.status, r.json], [403, { erro: MENSAGENS_GANHOS.bloco_grupos }], JSON.stringify(corpo));
    }
    assert.deepEqual(p.gruposDoBloco(), ['g1@g.us']);
    r = await p.pedir('/api/blocks/1', 'PUT', { name: 'B1 novo', tag_id: 1, note: 'x', group_jids: ['g1@g.us'] });
    assert.equal(r.status, 200, `nome, etiqueta e nota continuam livres: ${r.txt}`);
    // com código e gasto, vale a frase do código (como antes)
    s.db.prepare("INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo, criado_em, atualizado_em) VALUES ('amazon', 'bloco', '1', 'casa-20', 1, 1)").run();
    r = await p.pedir('/api/blocks/1', 'DELETE');
    assert.deepEqual([r.status, r.json], [403, { erro: FRASE_APAGAR_BLOCO }]);
    s.db.prepare('DELETE FROM rastreio_codigos').run();

    p.papel('dono');
    r = await p.pedir('/api/blocks/1', 'PUT', { name: 'B1', group_jids: ['g1@g.us', 'g2@g.us'] });
    assert.equal(r.status, 200, r.txt);
    r = await p.pedir('/api/blocks/1', 'DELETE');
    assert.equal(r.status, 200, r.txt);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE id = 1').get().n, 0);
    assert.equal(p.n('gastos_anuncio'), 3, 'o gasto do bloco apagado fica (aparece com nome null)');
  } finally { await s.fechar(); }
});
