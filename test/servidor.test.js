// Testes do servidor HTTP: login, sessão, Host/Origin, token da extensão, cabeçalhos e a Amazon ligada.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';

const HOST = 'disparador.exemplo.com.br';
const SENHA = 'senha-de-teste-123';
// pastas temporárias apagadas no fim do arquivo
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-srv-')); pastas.push(p); return p; };

/** fetch padrão do cliente da Amazon nos testes: nenhuma chamada sai para a rede. */
const redeProibida = async () => { throw new Error('rede proibida no teste'); };

/** Sobe pelo mesmo caminho do main de src/server.js: criarServicos (Amazon + agendador) e buildApp. */
function subir({ publicHost = HOST, panelPassword = SENHA, dir = tmp(), fetch = redeProibida } = {}) {
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const { amazon, scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch });
  const app = buildApp({ db, wa, links, scheduler, amazon, publicHost, panelPassword });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      ok({ db, dir, port, amazon, scheduler, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) });
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
  const dir = tmp();
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
    assert.deepEqual(r.sources[1], { type: 'afiliados', config: { busca: '', categorias: ['MLB1574'], ordem: 'relevance', paginas: 3, mais_vendidos: false, ganhos_extras: false }, tag_id: null }, 'configuração normalizada no servidor');
    assert.equal((await req(s.port, '/api/rules', { method: 'POST', body: { ...base, sources: [1, 2, 3, 4, 5, 6].map(lista) }, headers: h })).status, 400, 'seis fontes');
    assert.equal((await req(s.port, '/api/rules', { method: 'POST', body: { ...base, sources: [lista(1), { type: 'list', config: { items: 'sem url' } }] }, headers: h })).status, 400, 'lista vazia');
    assert.equal((await req(s.port, '/api/rules', { method: 'POST', body: { ...base, sources: [{ type: 'search', config: {} }] }, headers: h })).status, 400, 'busca sem palavra');
    // formato antigo continua aceito
    assert.equal((await req(s.port, '/api/rules', { method: 'POST', body: { ...base, source_type: 'afiliados', source_config: { paginas: 2 } }, headers: h })).status, 200);
    assert.deepEqual((await req(s.port, '/api/rules', { headers: h })).json[1].sources, [{ type: 'afiliados', config: { busca: '', categorias: [], ordem: 'relevance', paginas: 2, mais_vendidos: false, ganhos_extras: false }, tag_id: null }]);
  } finally { await s.fechar(); }
});

test('Amazon ligada (criarServicos): Identificar com link da Amazon traz o produto, e Conexões usa o mesmo cliente da fila', async () => {
  const ASINS = ['B0FG2MD49G', 'B0ABCDEF12'];
  const chamadas = [];
  const resposta = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const u = String(url); chamadas.push(u);
    if (u === 'https://api.amazon.com/auth/o2/token') return resposta(200, { access_token: 'token-teste', token_type: 'bearer', expires_in: 3600 });
    if (u === 'https://creatorsapi.amazon/catalog/v1/getItems') {
      return resposta(200, { itemsResult: { items: JSON.parse(init.body).itemIds.map((asin) => ({
        asin, itemInfo: { title: { displayValue: `Produto ${asin}` } }, images: { primary: { large: { url: 'https://m.media-amazon.com/images/I/71abc.jpg' } } },
        offersV2: { listings: [{ isBuyBoxWinner: true, price: { money: { amount: 100 } } }] },
      })) } });
    }
    throw new Error('rede não prevista no teste');
  };
  const s = await subir({ publicHost: '', panelPassword: '', fetch });
  try {
    assert.equal(s.scheduler.amazon, s.amazon, 'o agendador (fila de envios) recebeu o cliente criado pelo servidor');
    const origin = `http://127.0.0.1:${s.port}`;
    const salvar = (campos) => req(s.port, '/api/conexoes/amazon', { method: 'PUT', headers: { origin }, body: { campos } });
    const identificar = (asin) => req(s.port, '/api/disparo/identificar', { method: 'POST', headers: { origin }, body: { url: `https://www.amazon.com.br/dp/${asin}` } });
    const tokens = () => chamadas.filter((u) => u.endsWith('/auth/o2/token')).length;

    assert.equal((await salvar({ tag: 'pedro-20', credencial_id: 'credencial-id-0001', credencial_secret: 'segredo-super-secreto-123', credencial_versao: '3.1' })).status, 200);
    let r = await identificar(ASINS[0]);
    assert.equal(r.status, 200, `identificar respondeu ${r.status}: ${r.json?.erro}`);
    assert.doesNotMatch(r.txt, /não está disponível neste servidor/);
    assert.equal(r.json.editavel, true);
    assert.equal(r.json.causa, null);
    assert.equal(r.json.produto.title, `Produto ${ASINS[0]}`);
    assert.equal(tokens(), 1);

    // salvar a conexão invalida o token do cliente único: o próximo Identificar (fila de envios) pede outro
    assert.equal((await salvar({ tag: 'pedro-20' })).status, 200);
    r = await identificar(ASINS[1]);
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.produto.title, `Produto ${ASINS[1]}`);
    assert.equal(tokens(), 2, 'Conexões e a fila de envios usam o mesmo cliente da Amazon');
    assert.ok(!r.txt.includes('segredo-super-secreto-123') && !r.txt.includes('token-teste'));
  } finally { await s.fechar(); }
});

test('R1: GET /api/log?tipo=automatico traz só as linhas das regras do Disparo automático (rule_id), com o mesmo limite e formato; sem tipo, tudo', async () => {
  const s = await subir({ publicHost: '', panelPassword: '' });
  try {
    const origin = `http://127.0.0.1:${s.port}`;
    const ins = s.db.prepare('INSERT INTO log (ts, rule_id, rule_name, level, group_name, offer_title, message) VALUES (?,?,?,?,?,?,?)');
    ins.run(1, 7, 'Regra ML', 'ok', 'Grupo A', 'Fone', 'Enviado com a etiqueta x');            // 1: regra
    ins.run(2, null, 'Avisos', 'info', null, null, 'Resumo enviado');                              // 2
    ins.run(3, null, 'Espelho: Amazon', 'ok', 'Origem', 'Roteador', 'Espelhada com dados da Amazon'); // 3
    ins.run(4, null, 'Disparo manual', 'erro', 'Grupo B', 'Mesa', 'Não enviado: perdeu o horário'); // 4: envio avulso
    ins.run(5, 7, 'Regra ML', 'erro', null, null, 'WhatsApp desconectado: nada foi enviado.');     // 5: regra
    ins.run(6, null, 'Equipe', 'info', null, null, 'Convite criado');                              // 6
    const ler = async (q) => { const r = await req(s.port, `/api/log${q}`, { headers: { origin } }); return r; };
    const ids = (r) => r.json.map((l) => l.id);

    let r = await ler('');
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), [6, 5, 4, 3, 2, 1], 'sem tipo: igual a hoje');
    assert.deepEqual(ids(await ler('?tipo=todos')), [6, 5, 4, 3, 2, 1]);
    assert.deepEqual(ids(await ler('?tipo=')), [6, 5, 4, 3, 2, 1]);
    r = await ler('?tipo=automatico');
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), [5, 1]);
    assert.deepEqual({ ...r.json[1] }, { id: 1, ts: 1, rule_id: 7, rule_name: 'Regra ML', level: 'ok', group_name: 'Grupo A', offer_title: 'Fone', message: 'Enviado com a etiqueta x' }, 'mesmo formato (a linha inteira)');
    assert.deepEqual(ids(await ler('?tipo=automatico&nivel=erro')), [5], 'combina com o nível');
    assert.deepEqual(ids(await ler('?nivel=erro')), [5, 4], 'o nível sozinho continua igual');
    assert.deepEqual(ids(await ler('?tipo=automatico&limite=1')), [5], 'mesmo LIMIT');
    for (const q of ['?tipo=espelho', '?tipo=automatico&tipo=todos']) {
      r = await ler(q);
      assert.deepEqual([r.status, r.json], [400, { erro: 'Filtro inválido: use automatico ou todos.' }], q);
    }
  } finally { await s.fechar(); }
});

test('S4/R7: "Apagar o que já passou do prazo" (POST /api/privacidade/limpar) também apaga os itens antigos do espelhamento, com a mesma regra da retenção do início', async () => {
  const s = await subir({ publicHost: '', panelPassword: '' });
  try {
    const origin = `http://127.0.0.1:${s.port}`;
    const DIA = 86400000; const agora = Date.now();
    s.db.prepare("INSERT INTO settings (key, value) VALUES ('retencao_dias', '30') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const esp = s.db.prepare("INSERT INTO espelhos (nome, enabled, origem_jids, destino_jids, template_id, dedupe_horas, created_at, updated_at) VALUES (?, 0, '[]', '[]', 1, ?, ?, ?)");
    const curta = Number(esp.run('curta', 24, agora, agora).lastInsertRowid);
    const longa = Number(esp.run('longa', 8760, agora, agora).lastInsertRowid);
    const ins = s.db.prepare("INSERT INTO espelho_itens (espelho_id, origem_jid, msg_id, ts, url, asin, texto_origem, status, decidido_em) VALUES (?, '1@g.us', ?, ?, 'https://www.amazon.com.br/dp/B000000001', 'B000000001', 'texto guardado', ?, ?)");
    const velho = agora - 60 * DIA;
    ins.run(curta, 'velho-descartado', velho, 'descartado', velho);   // apaga
    ins.run(curta, 'velho-enviado', velho, 'enviado', velho);         // fora das 24 h de "Horas sem repetir": apaga
    ins.run(longa, 'velho-dedupe', velho, 'enviado', velho);          // ainda conta para "Horas sem repetir" (1 ano): fica
    ins.run(curta, 'velho-fila', velho, 'na_fila', velho);            // ativo: fica
    ins.run(curta, 'recente', agora - DIA, 'descartado', agora - DIA); // dentro dos 30 dias: fica
    const r = await req(s.port, '/api/privacidade/limpar', { method: 'POST', headers: { origin } });
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.espelhamento, 2);
    assert.ok('sessoes' in r.json && 'eventos' in r.json, 'o resto da resposta continua igual');
    assert.deepEqual(s.db.prepare('SELECT msg_id FROM espelho_itens ORDER BY id').all().map((i) => i.msg_id), ['velho-dedupe', 'velho-fila', 'recente']);

    // retenção 0 (para sempre): nada do espelhamento sai
    s.db.prepare("UPDATE settings SET value = '0' WHERE key = 'retencao_dias'").run();
    const r0 = await req(s.port, '/api/privacidade/limpar', { method: 'POST', headers: { origin } });
    assert.deepEqual([r0.status, r0.json.espelhamento], [200, 0]);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM espelho_itens').get().n, 3);
  } finally { await s.fechar(); }
});
