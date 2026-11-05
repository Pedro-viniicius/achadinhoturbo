// Testes do servidor HTTP: login, sessão, Host/Origin, token da extensão, cabeçalhos e a Amazon e a Shopee ligadas.
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
import { IMAGEM_SHOPEE, URL_API as URL_API_SHOPEE } from '../src/shopee.js';
import { ERROS_FONTE } from '../src/catalogo.js';
import { RESPOSTAS } from '../src/remetentes.js';

const HOST = 'disparador.exemplo.com.br';
const SENHA = 'senha-de-teste-123';
// pastas temporárias apagadas no fim do arquivo
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-srv-')); pastas.push(p); return p; };

/** fetch padrão dos clientes da Amazon e da Shopee nos testes: nenhuma chamada sai para a rede. */
const redeProibida = async () => { throw new Error('rede proibida no teste'); };

/**
 * Sobe pelo mesmo caminho do main de src/server.js: criarServicos (Amazon, Shopee e agendador) e buildApp.
 * `modoLink`: o modo do serviço de links ('fake' por padrão; 'extension' para a volta da extensão). `ml`: leitor do
 * Mercado Livre falso (padrão: o de src/ml.js).
 */
function subir({ publicHost = HOST, panelPassword = SENHA, dir = tmp(), fetch = redeProibida, modoLink = 'fake', ml } = {}) {
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => modoLink });
  const { amazon, shopee, catalogo, catalogoItens, scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch, ...(ml ? { ml } : {}) });
  const app = buildApp({ db, wa, links, scheduler, amazon, shopee, catalogo, catalogoItens, publicHost, panelPassword, ...(ml ? { ml } : {}) });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      ok({ db, dir, port, wa, links, amazon, shopee, catalogo, catalogoItens, scheduler, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) });
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

// ---------- Shopee ligada no servidor (plano integracao-shopee, etapa 8; CA4, CA6, CA7) ----------
const ID_AF_SHOPEE = '98765432101';
const APP_ID_SHOPEE = '123456789';
const CHAVE_SHOPEE = 'Senha-Api-SECRETA-q1w2e3';
const SHOP = '52377417';
const ITEM = '6309028319';
const ITEM_FOTO_DE_FORA = '6309028320';
const URL_PRODUTO_SHOPEE = `https://shopee.com.br/Fone-Bom-Sem-Fio-i.${SHOP}.${ITEM}`;
const IMG_SHOPEE = 'https://down-br.img.susercontent.com/file/br-11134207-7r98o-abc123';

/**
 * fetch falso da Open API da Shopee: productOfferV2 devolve o nó do itemId pedido (o ITEM_FOTO_DE_FORA vem com a foto
 * fora do CDN; a busca do "Testar" devolve o ITEM). Guarda o cabeçalho Authorization de cada chamada.
 */
function fetchShopee() {
  const chamadas = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    chamadas.push({ url: u, metodo: init.method || 'GET', autorizacao: init.headers?.Authorization ?? null });
    if (u !== URL_API_SHOPEE) throw new Error('rede não prevista no teste');
    const item = /itemId:(\d+)/.exec(JSON.parse(init.body).query)?.[1] ?? ITEM;
    const no = {
      itemId: Number(item), productName: 'Fone Bom Sem Fio', priceMin: '89.90', priceMax: '99.90', priceDiscountRate: 15, sales: 1234,
      ratingStar: '4.83', imageUrl: item === ITEM_FOTO_DE_FORA ? 'https://evil.example/foto.jpg' : IMG_SHOPEE, shopName: 'Loja Oficial',
    };
    return new Response(JSON.stringify({ data: { productOfferV2: { nodes: [no] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.chamadas = chamadas;
  return f;
}

/** Diretivas da CSP: { 'img-src': ["'self'", …], … }. */
const diretivasCsp = (csp) => Object.fromEntries(String(csp).split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

/** Alguma fonte `https://host` ou `https://*.sufixo` aceita a URL? (o curinga da CSP cobre um ou mais rótulos) */
function cspAceita(fontes, url) {
  const u = new URL(url);
  return u.protocol === 'https:' && !u.port && fontes.some((f) => {
    const m = /^https:\/\/(\*\.)?([a-z0-9.-]+)$/.exec(f);
    return !!m && (m[1] ? u.hostname.endsWith(`.${m[2]}`) : u.hostname === m[2]);
  });
}

test('CA7: a CSP img-src libera os hosts de IMAGEM_SHOPEE (e só eles a mais); nenhum connect-src novo', async () => {
  const s = await subir();
  try {
    const d = diretivasCsp((await req(s.port, '/healthz')).headers['content-security-policy']);
    assert.deepEqual(d['img-src'], ["'self'", 'data:', 'https://*.mlstatic.com', 'https://*.media-amazon.com', 'https://*.ssl-images-amazon.com',
      'https://*.images-amazon.com', 'https://*.susercontent.com', 'https://cf.shopee.com.br']);
    assert.deepEqual(d['connect-src'], ["'self'"]);
    assert.deepEqual(d['default-src'], ["'self'"]);
    // a CSP e a regex do servidor dizem a mesma coisa sobre as fotos da Shopee
    for (const url of [IMG_SHOPEE, 'https://cf.shopee.com.br/file/abc', 'https://a.b.susercontent.com/x']) {
      assert.ok(IMAGEM_SHOPEE.test(url), `regex: ${url}`); assert.ok(cspAceita(d['img-src'], url), `CSP: ${url}`);
    }
    for (const url of ['https://susercontent.com/x', 'https://susercontent.com.evil.com/x', 'https://cf.shopee.com.br.evil.com/x', 'https://shopee.com.br/x', 'https://evil.example/foto.jpg']) {
      assert.ok(!IMAGEM_SHOPEE.test(url), `regex: ${url}`); assert.ok(!cspAceita(d['img-src'], url), `CSP: ${url}`);
    }
  } finally { await s.fechar(); }
});

test('CA6/CA7: Shopee ligada (criarServicos): um cliente para a fila e Conexões; Identificar pela API; foto só do CDN; senha e assinatura fora das respostas', async () => {
  const fetch = fetchShopee();
  const s = await subir({ publicHost: '', panelPassword: '', fetch });
  try {
    assert.ok(s.shopee, 'criarServicos cria o cliente da Shopee');
    assert.equal(s.scheduler.shopee, s.shopee, 'o agendador (fila de envios) recebeu o cliente criado pelo servidor');
    const origin = `http://127.0.0.1:${s.port}`;
    const textos = []; // texto cru de toda resposta do painel neste teste
    const chamar = async (caminho, o = {}) => { const r = await req(s.port, caminho, { ...o, headers: { origin, ...(o.headers || {}) } }); textos.push(r.txt); return r; };
    const conexaoShopee = async () => (await chamar('/api/conexoes')).json.find((p) => p.id === 'shopee');
    const identificar = (url) => chamar('/api/disparo/identificar', { method: 'POST', body: { url } });

    let c = await conexaoShopee();
    assert.deepEqual([c.estado, c.extensao_online], ['falta_configurar', false]);
    const salvo = await chamar('/api/conexoes/shopee', { method: 'PUT', body: { campos: { id_afiliado: ID_AF_SHOPEE, app_id: APP_ID_SHOPEE, chave: CHAVE_SHOPEE } } });
    assert.equal(salvo.status, 200, salvo.txt);
    c = await conexaoShopee();
    assert.deepEqual([c.estado, c.situacao.acesso, c.config, c.segredos_salvos], ['pronta', 'desconhecido', { id_afiliado: ID_AF_SHOPEE, app_id: APP_ID_SHOPEE }, ['chave']]);
    assert.equal(fetch.chamadas.length, 0, 'salvar e listar não chamam a API');

    // Identificar: produto pela API, com a credencial lida pelo lerConexao do servidor (segredosDe)
    let r = await identificar(`${URL_PRODUTO_SHOPEE}?sp_atk=abc&utm_source=an_999`);
    assert.equal(r.status, 200, r.txt);
    assert.doesNotMatch(r.txt, /não está disponível neste servidor/);
    assert.deepEqual([r.json.loja.id, r.json.editavel, r.json.causa, r.json.link_via, r.json.causa_link, r.json.pode_disparar], ['shopee', true, null, 'api', null, true]);
    assert.deepEqual([r.json.produto.title, r.json.produto.price, r.json.produto.discountPct, r.json.produto.image], ['Fone Bom Sem Fio', 89.9, 15, IMG_SHOPEE]);
    assert.equal(fetch.chamadas.length, 1);
    const [chamada] = fetch.chamadas;
    assert.deepEqual([chamada.url, chamada.metodo], [URL_API_SHOPEE, 'POST']);
    assert.match(chamada.autorizacao, new RegExp(`^SHA256 Credential=${APP_ID_SHOPEE}, Timestamp=\\d+, Signature=[0-9a-f]{64}$`));

    // CA7: foto fora do CDN da Shopee vira null
    r = await identificar(`https://shopee.com.br/product/${SHOP}/${ITEM_FOTO_DE_FORA}`);
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.produto.title, r.json.produto.image], ['Fone Bom Sem Fio', null]);

    // Conexões vê a mesma situação da API que a fila de envios gravou (cliente único) e o Testar usa o mesmo cliente
    c = await conexaoShopee();
    assert.deepEqual([c.estado, c.situacao.acesso, c.extensao_online], ['conectada', 'ok', false]);
    const teste = await chamar('/api/conexoes/shopee/testar', { method: 'POST' });
    assert.equal(teste.status, 200, teste.txt);
    assert.deepEqual([teste.json.ok, teste.json.resultado], [true, 'ok']);
    assert.equal(fetch.chamadas.length, 3);

    // CA6: nenhuma resposta traz a Senha da API nem uma assinatura enviada
    const assinaturas = fetch.chamadas.map((x) => /Signature=([0-9a-f]{64})/.exec(x.autorizacao)[1]);
    for (const t of textos) {
      assert.ok(!t.includes(CHAVE_SHOPEE), 'vazou a Senha da API');
      for (const a of assinaturas) assert.ok(!t.includes(a), 'vazou a assinatura');
    }
  } finally { await s.fechar(); }
});

test('CA4: Shopee pela extensão de ponta a ponta: poll recebe link_shopee, result com link e longo; longo de outra conta recusa; o da conta do dono chega ao WhatsApp simulado', async () => {
  const s = await subir({ publicHost: '', panelPassword: '', modoLink: 'extension' });
  try {
    const origin = `http://127.0.0.1:${s.port}`;
    const token = s.db.prepare("SELECT value FROM settings WHERE key = 'ext_token'").get().value;
    s.db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
    // só o ID de afiliado: sem API, o link sai pela extensão
    const salvo = await req(s.port, '/api/conexoes/shopee', { method: 'PUT', headers: { origin }, body: { campos: { id_afiliado: ID_AF_SHOPEE } } });
    assert.equal(salvo.status, 200, salvo.txt);
    const corpo = { tipo: 'oferta', url: `${URL_PRODUTO_SHOPEE}?sp_atk=abc&xptdk=q`, template_id: 1, group_jids: ['111@g.us'], quando: 'agora', ajustes: { title: 'Fone à mão', price: '89,90' } };

    /**
     * Uma volta da extensão de verdade, por HTTP: long-poll em /api/ext/poll (marca a extensão on-line), o painel cria o
     * envio, o pedido chega no poll e a extensão responde em /api/ext/result com `resposta`. → resposta do POST /api/envios
     */
    const volta = async (resposta) => {
      const antes = Date.now();
      const poll = req(s.port, '/api/ext/poll', { headers: { 'x-token': token } });
      while (s.links.status().lastPollAt < antes) await new Promise((ok) => setTimeout(ok, 5));
      const criado = req(s.port, '/api/envios', { method: 'POST', headers: { origin }, body: corpo });
      // se o envio responder antes de o pedido chegar à extensão, falha já (sem esperar os 20 s do long-poll)
      const pedido = await Promise.race([poll, criado.then((x) => { throw new Error(`o envio respondeu sem pedir o link à extensão: ${x.status} ${x.txt}`); })]);
      assert.equal(pedido.status, 200);
      const { job } = pedido.json;
      assert.deepEqual([job.type, job.url], ['link_shopee', URL_PRODUTO_SHOPEE], 'a extensão recebe só o endereço do produto, sem parâmetros');
      const devolvido = await req(s.port, '/api/ext/result', { method: 'POST', headers: { 'x-token': token }, body: { id: job.id, ...resposta } });
      assert.deepEqual([devolvido.status, devolvido.json], [200, { ok: true }]);
      return criado;
    };

    // o longo chega ao servidor: um longLink de outra conta de afiliado recusa o envio, sem gravar nada
    const outra = await volta({ ok: true, link: 'https://s.shopee.com.br/ExtLink111', longo: `https://shopee.com.br/product/${SHOP}/${ITEM}?utm_source=an_99999999999&utm_medium=affiliates` });
    assert.deepEqual([outra.status, outra.json.erro], [400, 'O Chrome está logado em outra conta de afiliado da Shopee. Entre na conta do ID …2101 e tente de novo.']);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0, 'nada gravado');

    const LINK = 'https://s.shopee.com.br/ExtLink456';
    const r = await volta({ ok: true, link: LINK, longo: `https://shopee.com.br/product/${SHOP}/${ITEM}?utm_source=an_${ID_AF_SHOPEE}&utm_medium=affiliates&utm_term=xyz` });
    assert.equal(r.status, 200, r.txt);
    const t0 = Date.now(); const status = () => s.db.prepare('SELECT status FROM envios WHERE id = ?').get(r.json.id)?.status;
    while (['pendente', 'enviando'].includes(status())) {
      assert.ok(Date.now() - t0 < 3000, 'o envio não terminou');
      await new Promise((ok) => setTimeout(ok, 5));
    }
    assert.equal(status(), 'concluido');
    assert.equal(s.wa.simulated.length, 1);
    const [msg] = s.wa.simulated;
    assert.deepEqual([msg.tipo, msg.jid], ['text', '111@g.us'], 'sem API, sem foto: só texto');
    assert.match(msg.text, /Fone à mão/);
    assert.ok(msg.text.endsWith(LINK), msg.text);
    assert.doesNotMatch(msg.text, /utm_|an_|sp_atk/, 'nem o longLink nem os parâmetros do link colado vão para o grupo');
    const payload = JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(r.json.id).payload);
    assert.deepEqual([payload.loja, payload.url, payload.link_afiliado], ['shopee', URL_PRODUTO_SHOPEE, LINK]);
  } finally { await s.fechar(); }
});

// ---------------------------------------------------------------------------------------------
// Catálogo do Etiqueta ligado no servidor (plano fonte-catalogo-etiqueta, etapa 5; CA1, CA2, CA3, CA6, CA8).
// Nenhum teste fala com o Etiqueta real: um Etiqueta falso em porta aleatória de 127.0.0.1 e um token falso num
// arquivo temporário; o fetch dos clientes só alcança essa porta.

const TOKEN_FALSO = 'tokenFalsoDoTeste_0123456789abcdefABCDEF-xyz';
const CATEGORIAS_ETIQUETA = [
  { nome: 'Perfumes e Perfumaria', total: 120, lojas: { amazon: 70, ml: 30, shopee: 20 } },
  { nome: 'Casa <b>& Cozinha</b>', total: 45, lojas: { amazon: 0, ml: 45, shopee: 0 } },
];

/** Etiqueta falso (HTTP de verdade, 127.0.0.1, porta aleatória): só GET /api/v1/categorias com o Bearer esperado. */
async function etiquetaFalso() {
  const estado = { token: TOKEN_FALSO, pedidos: [] };
  const server = http.createServer((rq, rs) => {
    estado.pedidos.push({ url: rq.url, method: rq.method, headers: { ...rq.headers } });
    const json = (status, corpo) => { rs.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); rs.end(JSON.stringify(corpo)); };
    if (rq.headers.authorization !== `Bearer ${estado.token}`) return json(401, { error: 'token ausente ou inválido' });
    if (rq.method === 'GET' && rq.url === '/api/v1/categorias') return json(200, { versao: 1, categorias: CATEGORIAS_ETIQUETA, total: 165 });
    json(404, { error: 'rota não encontrada' });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const porta = server.address().port;
  const endereco = `http://127.0.0.1:${porta}`;
  // o fetch dos clientes (Amazon, Shopee, Catálogo) só alcança o Etiqueta falso
  const fetch = async (url, init) => {
    if (!String(url).startsWith(`${endereco}/`)) throw new Error('rede proibida no teste');
    return globalThis.fetch(url, init);
  };
  return { estado, endereco, fetch, fechar: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }) };
}

/** Token falso num arquivo temporário (nunca o arquivo real do Etiqueta). → caminho */
function arquivoDeToken(dir, conteudo = `${TOKEN_FALSO}\n`) {
  // o nome do arquivo do Etiqueta (S1), numa pasta própria dentro da pasta de dados do teste
  const caminho = path.join(fs.mkdtempSync(path.join(dir, 'etiqueta-')), 'api_token.txt');
  fs.writeFileSync(caminho, conteudo, { mode: 0o600 });
  return caminho;
}

/** Texto de todas as linhas de todas as tabelas do banco (para conferir que o token não foi gravado). */
function textoDoBanco(db) {
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  return tabelas.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

/** Regra com fonte catálogo pela API. → id */
async function criarRegraCatalogo(s, h, { nome = 'Catálogo', config = { lojas: ['amazon'], ordem: 'atualizacao' }, mais = {} } = {}) {
  const r = await req(s.port, '/api/rules', { method: 'POST', headers: h, body: { name: nome, enabled: false, template_id: 1, group_jids: [], sources: [{ type: 'catalogo', config }], ...mais } });
  assert.equal(r.status, 200, r.txt);
  return r.json.id;
}

const ITEM_AMAZON = { title: 'Perfume de teste', price: 99.9, oldPrice: 150, discountPct: 33, image: null, categoria: 'Perfumes e Perfumaria' };
const inserirItem = (db, ruleId, chave, status, { loja = 'amazon', motivos = '[]' } = {}) => Number(db.prepare(`INSERT INTO catalogo_itens (rule_id, chave, loja, status, motivos, oferta, criado_em)
  VALUES (?,?,?,?,?,?,?)`).run(ruleId, chave, loja, status, motivos, JSON.stringify(ITEM_AMAZON), Date.now()).lastInsertRowid);
const inserirCursor = (db, ruleId, filtro = 'f'.repeat(16), cursor = 'c200') => db.prepare('INSERT INTO catalogo_cursores (rule_id, filtro, cursor, pronto, atualizado_em) VALUES (?,?,?,1,?)').run(ruleId, filtro, cursor, Date.now());
const itensDe = (db, ruleId) => db.prepare('SELECT chave, status FROM catalogo_itens WHERE rule_id = ? ORDER BY chave').all(ruleId).map((l) => `${l.chave}:${l.status}`);
const cursoresDe = (db, ruleId) => db.prepare('SELECT COUNT(*) AS n FROM catalogo_cursores WHERE rule_id = ?').get(ruleId).n;

test('catálogo (CA1, CA6): regra aceita a fonte catalogo, normalizada no servidor; só Amazon/Shopee salva sem etiqueta', async () => {
  const s = await subir();
  try {
    const h = { cookie: sidDe(await login(s.port)), origin: `http://127.0.0.1:${s.port}` };
    const id = await criarRegraCatalogo(s, h, { config: { categorias: ['Perfumes e Perfumaria'], lojas: ['amazon', 'shopee'], q: ' air fryer ', desconto_min: '30', ordem: 'desconto', extra: 'ignorado' } });
    const regra = (await req(s.port, '/api/rules', { headers: h })).json.find((r) => r.id === id);
    assert.equal(regra.tag_id, null, 'sem etiqueta padrão: as fontes só trazem Amazon e Shopee');
    assert.equal(regra.source_type, 'catalogo');
    assert.deepEqual(regra.sources, [{ type: 'catalogo', config: { categorias: ['Perfumes e Perfumaria'], lojas: ['amazon', 'shopee'], q: 'air fryer', desconto_min: 30, ordem: 'desconto' }, tag_id: null }]);
    // vazio vira o padrão (todas as categorias e lojas, Novidades), junto com outras fontes
    const outra = await req(s.port, '/api/rules', { method: 'POST', headers: h, body: { name: 'Mista', tag_id: null, template_id: 1, sources: [{ type: 'search', config: { query: 'fone' } }, { type: 'catalogo', tag_id: 7 }] } });
    assert.equal(outra.status, 200, outra.txt);
    const mista = (await req(s.port, '/api/rules', { headers: h })).json.find((r) => r.id === outra.json.id);
    // Novidades ainda sem a primeira leitura: primeira_leitura (S3, só na listagem; não é gravado)
    assert.deepEqual(mista.sources[1], { type: 'catalogo', config: { categorias: [], lojas: [], q: '', desconto_min: null, ordem: 'atualizacao' }, tag_id: 7, primeira_leitura: true });
    assert.ok(!s.db.prepare('SELECT sources FROM rules WHERE id = ?').get(outra.json.id).sources.includes('primeira_leitura'));
  } finally { await s.fechar(); }
});

test('catálogo (CA2, CA8): fonte inválida dá 400 com a frase fixa de ERROS_FONTE, o campo e a fonte, sem repetir o valor recebido', async () => {
  const s = await subir();
  try {
    const h = { cookie: sidDe(await login(s.port)), origin: `http://127.0.0.1:${s.port}` };
    const MAU = '<img src=x onerror=alert(1)>';
    const casos = [
      ['categorias', { categorias: Array.from({ length: 21 }, (_, i) => `${MAU}${i}`) }],
      ['categoria', { categorias: [MAU, MAU] }],
      ['categoria', { categorias: [`${MAU}${'x'.repeat(200)}`] }],
      ['categoria', { categorias: MAU }],
      ['lojas', { lojas: [MAU] }],
      ['lojas', { lojas: ['amazon', 'amazon'] }],
      ['q', { q: Array.from({ length: 11 }, () => MAU).join(',') }],
      ['q', { q: `${MAU},,` }],
      ['desconto_min', { desconto_min: 100 }],
      ['desconto_min', { desconto_min: MAU }],
      ['ordem', { ordem: MAU }],
    ];
    for (const [campo, config] of casos) {
      const r = await req(s.port, '/api/rules', { method: 'POST', headers: h, body: { name: 'R', template_id: 1, sources: [{ type: 'search', config: { query: 'fone' } }, { type: 'catalogo', config }] } });
      assert.equal(r.status, 400, `${campo}: ${r.txt}`);
      assert.deepEqual(r.json, { erro: ERROS_FONTE[campo], campo, fonte: 2 }, `${campo}: ${JSON.stringify(config).slice(0, 60)}`);
      assert.ok(!r.txt.includes('onerror'), `${campo}: o valor recebido não volta na resposta`);
    }
    // PUT valida igual, e o formato antigo (source_type) também
    const id = await criarRegraCatalogo(s, h);
    const put = await req(s.port, `/api/rules/${id}`, { method: 'PUT', headers: h, body: { name: 'R', template_id: 1, sources: [{ type: 'catalogo', config: { ordem: 'qualquer' } }] } });
    assert.deepEqual([put.status, put.json], [400, { erro: ERROS_FONTE.ordem, campo: 'ordem', fonte: 1 }]);
    const antigo = await req(s.port, '/api/rules', { method: 'POST', headers: h, body: { name: 'R', template_id: 1, source_type: 'catalogo', source_config: { lojas: 'ml' } } });
    assert.deepEqual([antigo.status, antigo.json], [400, { erro: ERROS_FONTE.lojas, campo: 'lojas', fonte: 1 }]);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM rules').get().n, 1, 'nada gravado nas recusas');
    // erro das outras fontes continua sem campo
    const busca = await req(s.port, '/api/rules', { method: 'POST', headers: h, body: { name: 'R', template_id: 1, sources: [{ type: 'search', config: {} }] } });
    assert.deepEqual(busca.json, { erro: 'Fonte 1: a busca está sem a palavra-chave.' });
  } finally { await s.fechar(); }
});

test('catálogo (CA2, CA8): Testar pelo servidor real contra um Etiqueta falso; categorias e /api/state sem rede; o token não aparece em resposta, banco, URL nem console', async () => {
  const etq = await etiquetaFalso();
  const s = await subir({ fetch: etq.fetch });
  const saida = [];
  const escrever = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = function (c, ...a) { saida.push(String(c)); return escrever.out.call(this, c, ...a); };
  process.stderr.write = function (c, ...a) { saida.push(String(c)); return escrever.err.call(this, c, ...a); };
  const respostas = [];
  try {
    const h = { cookie: sidDe(await login(s.port)), origin: `http://127.0.0.1:${s.port}` };
    const chamar = async (caminho, op = {}) => { const r = await req(s.port, caminho, { ...op, headers: h }); respostas.push(`${caminho} ${r.txt}`); return r; };
    const caminho = arquivoDeToken(s.dir);

    // antes de configurar: nada de rede; estado nulo, sem categorias
    let st = (await chamar('/api/state')).json.catalogo;
    assert.deepEqual({ ...st, situacao: undefined }, { estado: 'falta_configurar', situacao: undefined, falha_desde: null, para_revisar: 0, teto_revisao: 50, regras: [], tag_amazon: false });
    assert.deepEqual((await chamar('/api/catalogo/categorias')).json, { categorias: [], total: 0, verificado_em: null, estado: 'falta_configurar' });

    const salvo = await chamar('/api/conexoes/catalogo', { method: 'PUT', body: { campos: { endereco: etq.endereco, caminho_token: caminho } } });
    assert.equal(salvo.status, 200, salvo.txt);
    assert.equal((await chamar('/api/catalogo/categorias')).json.estado, 'salva');
    assert.equal(etq.estado.pedidos.length, 0, 'salvar, /api/state e categorias não chamam o Etiqueta');

    // Testar: o cliente do servidor lê o token do arquivo e chama o Etiqueta falso
    const t = await chamar('/api/conexoes/catalogo/testar', { method: 'POST', body: {} });
    assert.equal(t.status, 200, t.txt);
    assert.deepEqual([t.json.ok, t.json.resultado, t.json.total, t.json.categorias], [true, 'ok', 165, CATEGORIAS_ETIQUETA]);
    assert.equal(etq.estado.pedidos.length, 1);
    const [pedido] = etq.estado.pedidos;
    assert.deepEqual([pedido.method, pedido.url], ['GET', '/api/v1/categorias']);
    assert.equal(pedido.headers.authorization, `Bearer ${TOKEN_FALSO}`);
    assert.equal(pedido.headers.origin, undefined, 'nunca manda Origin ao Etiqueta');
    assert.ok(!pedido.url.includes(TOKEN_FALSO), 'token fora da URL');

    const cats = (await chamar('/api/catalogo/categorias')).json;
    assert.deepEqual([cats.categorias, cats.total, cats.estado], [CATEGORIAS_ETIQUETA, 165, 'conectada']);
    assert.ok(Number.isFinite(cats.verificado_em));
    st = (await chamar('/api/state')).json.catalogo;
    assert.deepEqual([st.estado, st.situacao.resultado, st.falha_desde], ['conectada', 'ok', null]);
    assert.equal(etq.estado.pedidos.length, 1, 'categorias e /api/state leem a última verificação, sem chamar o Etiqueta');

    // token recusado: falha_desde aparece no /api/state (o mesmo cliente do Testar e do agendador)
    etq.estado.token = 'outroTokenQueOEtiquetaEspera_0123456789';
    const recusado = await chamar('/api/conexoes/catalogo/testar', { method: 'POST', body: {} });
    assert.deepEqual([recusado.json.ok, recusado.json.resultado], [false, 'token_recusado']);
    st = (await chamar('/api/state')).json.catalogo;
    assert.equal(st.estado, 'token_recusado');
    assert.ok(Number.isFinite(st.falha_desde), 'falha_desde para o chip "Catálogo indisponível"');
    assert.equal(st.falha_desde, s.catalogo.situacao().falha_desde, 'é o mesmo cliente criado por criarServicos');
    assert.deepEqual((await chamar('/api/catalogo/categorias')).json.categorias, CATEGORIAS_ETIQUETA, 'teste que falha mantém as categorias anteriores');

    // o resto do que o painel lê
    for (const c of ['/api/conexoes', '/api/catalogo/itens', '/api/rules', '/api/log', '/api/state']) assert.equal((await chamar(c)).status, 200, c);

    const tudo = respostas.join('\n');
    assert.ok(tudo.includes(caminho), 'o caminho do arquivo aparece (é do dono)');
    assert.ok(!tudo.includes(TOKEN_FALSO), 'o token não aparece em nenhuma resposta de /api');
    assert.ok(!textoDoBanco(s.db).includes(TOKEN_FALSO), 'o token não foi gravado no banco');
    assert.ok(!saida.join('').includes(TOKEN_FALSO), 'o token não foi para o console');
  } finally {
    process.stdout.write = escrever.out; process.stderr.write = escrever.err;
    await s.fechar(); await etq.fechar();
  }
});

test('catálogo (CA3): apagar a regra apaga os itens e os cursores dela (e só dela); id reaproveitado começa limpo; "Limpar já enviadas" apaga só os enviados', async () => {
  const s = await subir();
  try {
    const h = { cookie: sidDe(await login(s.port)), origin: `http://127.0.0.1:${s.port}` };
    const a = await criarRegraCatalogo(s, h, { nome: 'A' });
    const b = await criarRegraCatalogo(s, h, { nome: 'B' });
    for (const id of [a, b]) {
      inserirItem(s.db, id, 'ASIN:B0AAAAAAA1', 'enviado');
      inserirItem(s.db, id, 'ASIN:B0AAAAAAA2', 'revisao', { motivos: '["desconto_100"]' });
      inserirItem(s.db, id, 'ASIN:B0AAAAAAA3', 'descartado');
      inserirCursor(s.db, id);
      s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (?,?,?)').run(id, 'ASIN:B0AAAAAAA1', Date.now());
    }
    const st = (await req(s.port, '/api/state', { headers: h })).json.catalogo;
    assert.equal(st.para_revisar, 2);
    assert.deepEqual(st.regras, [{ rule_id: a, para_revisar: 1, cheia: false }, { rule_id: b, para_revisar: 1, cheia: false }]);

    assert.equal((await req(s.port, `/api/rules/${a}/reset-sent`, { method: 'POST', headers: h, body: {} })).status, 200);
    assert.deepEqual(itensDe(s.db, a), ['ASIN:B0AAAAAAA2:revisao', 'ASIN:B0AAAAAAA3:descartado'], 'revisão e descartadas ficam');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sent_offers WHERE rule_id = ?').get(a).n, 0);
    assert.equal(cursoresDe(s.db, a), 1, '"Limpar já enviadas" não mexe no cursor');
    assert.equal(itensDe(s.db, b).length, 3, 'a outra regra não muda');

    // apaga a regra de maior id: o SQLite devolve o mesmo id para a próxima regra
    assert.equal((await req(s.port, `/api/rules/${b}`, { method: 'DELETE', headers: h })).status, 200);
    assert.deepEqual([itensDe(s.db, b), cursoresDe(s.db, b)], [[], 0], 'itens e cursores da regra apagada somem');
    assert.deepEqual([itensDe(s.db, a).length, cursoresDe(s.db, a)], [2, 1], 'os da outra regra ficam');
    const nova = await criarRegraCatalogo(s, h, { nome: 'Nova' });
    assert.equal(nova, b, 'o id foi reaproveitado');
    assert.deepEqual([itensDe(s.db, nova), cursoresDe(s.db, nova)], [[], 0], 'a regra nova não herda nada');
    assert.equal((await req(s.port, '/api/state', { headers: h })).json.catalogo.para_revisar, 1);
  } finally { await s.fechar(); }
});

test('catálogo (CA3): "Reler do começo" põe cursor nulo pronto em cada fonte Novidades; 404 sem regra; 409 com a regra rodando', async () => {
  const s = await subir();
  try {
    const h = { cookie: sidDe(await login(s.port)), origin: `http://127.0.0.1:${s.port}` };
    const id = await criarRegraCatalogo(s, h, { config: { lojas: ['amazon'] } });
    inserirCursor(s.db, id, '0123456789abcdef', 'c400'); // cursor de um filtro antigo
    const primeira = async () => (await req(s.port, '/api/rules', { headers: h })).json.find((x) => x.id === id).sources[0].primeira_leitura;
    assert.equal(await primeira(), true, 'S3: o cursor do filtro atual ainda não está pronto');
    const r = await req(s.port, `/api/rules/${id}/catalogo/recomecar`, { method: 'POST', headers: h, body: {} });
    assert.deepEqual([r.status, r.json], [200, { ok: true, fontes: 1 }]);
    assert.equal(await primeira(), false, 'pronto: a prévia já lê');
    const cursores = s.db.prepare('SELECT cursor, pronto FROM catalogo_cursores WHERE rule_id = ?').all(id).map((l) => ({ ...l }));
    assert.deepEqual(cursores, [{ cursor: null, pronto: 1 }], 'varredura do zero, sem o cursor antigo');

    assert.deepEqual((await req(s.port, '/api/rules/999/catalogo/recomecar', { method: 'POST', headers: h, body: {} })).json, { erro: 'Regra não encontrada.' });
    assert.equal((await req(s.port, '/api/rules/abc/catalogo/recomecar', { method: 'POST', headers: h, body: {} })).status, 404);
    const isRunning = s.scheduler.isRunning;
    s.scheduler.isRunning = (x) => x === id;
    try {
      inserirCursor(s.db, id, 'fedcba9876543210', 'c10');
      const ocupada = await req(s.port, `/api/rules/${id}/catalogo/recomecar`, { method: 'POST', headers: h, body: {} });
      assert.deepEqual([ocupada.status, ocupada.json], [409, { erro: 'Esta regra está rodando agora. Espere terminar e tente de novo.' }]);
      assert.equal(cursoresDe(s.db, id), 2, 'nada mudou');
    } finally { s.scheduler.isRunning = isRunning; }
  } finally { await s.fechar(); }
});

test('catálogo (P6): Operador lê categorias, itens e /api/state, mas recebe 403 em Reler do começo, Enviar, Descartar e no Salvar/Testar do cartão', async () => {
  const s = await subir();
  try {
    const sid = sidDe(await login(s.port));
    const h = { cookie: sid, origin: `http://127.0.0.1:${s.port}` };
    const id = await criarRegraCatalogo(s, h);
    const item = inserirItem(s.db, id, 'ASIN:B0AAAAAAA9', 'revisao', { motivos: '["preco_antigo"]' });
    s.db.prepare("UPDATE users SET papel = 'operador'").run(); // o papel é relido a cada requisição
    assert.equal((await req(s.port, '/api/state', { headers: h })).json.usuario.papel, 'operador');

    for (const c of ['/api/catalogo/categorias', '/api/catalogo/itens', '/api/state']) assert.equal((await req(s.port, c, { headers: h })).status, 200, c);
    const escrita = [
      ['POST', `/api/rules/${id}/catalogo/recomecar`], ['POST', `/api/catalogo/itens/${item}/enviar`], ['POST', `/api/catalogo/itens/${item}/descartar`],
      ['PUT', '/api/conexoes/catalogo'], ['POST', '/api/conexoes/catalogo/testar'],
    ];
    for (const [method, caminho] of escrita) {
      const r = await req(s.port, caminho, { method, headers: h, body: { campos: { endereco: 'http://127.0.0.1:1' } } });
      assert.equal(r.status, 403, `${method} ${caminho}: ${r.txt}`);
    }
    assert.deepEqual(itensDe(s.db, id), ['ASIN:B0AAAAAAA9:revisao'], 'o item continua esperando o Dono');
    assert.equal(cursoresDe(s.db, id), 0);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM conexoes WHERE plataforma = 'catalogo'").get().n, 0);
  } finally { await s.fechar(); }
});

test('catálogo (CA1): o "Enviar" da revisão pelo servidor sai pela fila de envios do agendador (acordar) com a tag da Amazon; /api/state diz se a tag está salva', async () => {
  const s = await subir({ publicHost: '', panelPassword: '' });
  try {
    const h = { origin: `http://127.0.0.1:${s.port}` };
    s.db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
    const id = await criarRegraCatalogo(s, h, { mais: { group_jids: ['111@g.us'] } });
    const item = inserirItem(s.db, id, 'ASIN:B0FG2MD49G', 'revisao', { motivos: '["desconto_100"]' });
    assert.equal((await req(s.port, '/api/state', { headers: h })).json.catalogo.tag_amazon, false);
    const semTag = await req(s.port, `/api/catalogo/itens/${item}/enviar`, { method: 'POST', headers: h, body: {} });
    assert.equal(semTag.status, 400, 'sem a tag da Amazon, a revisão não envia');

    s.db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', ?, '{}', ?)").run(JSON.stringify({ tag: 'achadinho-20' }), Date.now());
    assert.equal((await req(s.port, '/api/state', { headers: h })).json.catalogo.tag_amazon, true);
    const r = await req(s.port, `/api/catalogo/itens/${item}/enviar`, { method: 'POST', headers: h, body: {} });
    assert.equal(r.status, 200, r.txt);
    const t0 = Date.now(); const status = () => s.db.prepare('SELECT status FROM envios WHERE id = ?').get(r.json.envio_id)?.status;
    while (['pendente', 'enviando'].includes(status())) {
      assert.ok(Date.now() - t0 < 3000, 'o envio não saiu (acordar não chegou ao agendador)');
      await new Promise((ok) => setTimeout(ok, 5));
    }
    assert.equal(status(), 'concluido');
    assert.equal(s.wa.simulated.length, 1);
    assert.match(s.wa.simulated[0].text, /https:\/\/www\.amazon\.com\.br\/dp\/B0FG2MD49G\?tag=achadinho-20/);
    assert.deepEqual(itensDe(s.db, id), ['ASIN:B0FG2MD49G:enviado']);
    const segundo = await req(s.port, `/api/catalogo/itens/${item}/enviar`, { method: 'POST', headers: h, body: {} });
    assert.deepEqual([segundo.status, segundo.json], [409, { erro: 'Esta oferta já foi tratada.' }]);
  } finally { await s.fechar(); }
});

// ---------- Remetente ligado no servidor (plano envio-pelo-socio, etapa 9; CA2, CA6, CA9, CA10) ----------
const NUMERO_REM = '5535987651234';
const PN_REM = `${NUMERO_REM}@s.whatsapp.net`;
const LID_REM = '207654321098765@lid';
const GRUPO_REM = '400@g.us';
const URL_ML_REM = 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM';

/** Leitor do Mercado Livre sem rede: a página de qualquer link traz o mesmo produto. Guarda as URLs lidas. */
function mlSemRede() {
  const lidos = [];
  return {
    lidos,
    async resolveOffer(c) {
      lidos.push(c.url);
      return { key: 'MLB1234567890', url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: 129.9, discountPct: null, sold: 1200,
        freeShipping: false, image: 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg' };
    },
  };
}

/** Grupo de destino, etiqueta e um remetente gravados direto (o cadastro tem os próprios testes). → id do remetente */
function cadastrarRemetente(db, extra = {}) {
  const agora = Date.now();
  if (!db.prepare('SELECT 1 FROM groups WHERE jid = ?').get(GRUPO_REM)) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(GRUPO_REM, 'Achadinhos do Sócio', 10, agora);
  }
  const tag = db.prepare("SELECT id FROM tags WHERE name = 'etiquetaA'").get()?.id
    ?? Number(db.prepare("INSERT INTO tags (name, created_at) VALUES ('etiquetaA', 1)").run().lastInsertRowid);
  const r = { nome: 'Sócio Pedro', jid: PN_REM, lid: LID_REM, enabled: 1, responder: 1, dedupe_horas: 24, ...extra };
  return Number(db.prepare(`INSERT INTO remetentes (nome, jid, lid, enabled, destino_jids, template_id, tag_id, enviar_foto, max_por_hora,
    dedupe_horas, responder, created_at, updated_at) VALUES (?,?,?,?,?,1,?,0,10,?,?,?,?)`)
    .run(r.nome, r.jid, r.lid, r.enabled, JSON.stringify([GRUPO_REM]), tag, r.dedupe_horas, r.responder, agora, agora).lastInsertRowid);
}

/** Mensagem privada como o Baileys entrega em messages.upsert (com pushName, que nunca deve passar adiante). */
const upsertPrivado = (texto, { id = 'PV1', jid = PN_REM } = {}) => ({ type: 'notify', messages: [{
  key: { remoteJid: jid, fromMe: false, id, addressingMode: jid.endsWith('@lid') ? 'lid' : 'pn' },
  pushName: 'Pedro', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: texto },
}] });

/** Espera a condição (até 3 s). */
async function ate(cond, msg) {
  const t0 = Date.now();
  while (!cond()) {
    assert.ok(Date.now() - t0 < 3000, msg);
    await new Promise((ok) => setTimeout(ok, 5));
  }
}

const itensRem = (db) => db.prepare('SELECT status, codigo, envio_id, msg_id FROM remetente_itens ORDER BY id').all().map((i) => ({ ...i }));

test('remetente (CA6): mensagem privada simulada (wa._onMensagens) de remetente cadastrado vira item, sai pela fila de envios do agendador e recebe a resposta', async () => {
  const ml = mlSemRede();
  const s = await subir({ publicHost: '', panelPassword: '', ml });
  try {
    assert.ok(s.scheduler.remetentes, 'o agendador cria e expõe o serviço dos remetentes');
    cadastrarRemetente(s.db);
    await s.wa._onMensagens(upsertPrivado(`Olha que oferta: ${URL_ML_REM}`, { id: 'MSG-CA6' }));
    const envio = () => s.db.prepare('SELECT * FROM envios ORDER BY id DESC LIMIT 1').get();
    await ate(() => envio()?.status === 'concluido', 'o envio do remetente não saiu pela fila (onPrivada → receber → acordar → tick)');
    assert.deepEqual(itensRem(s.db), [{ status: 'enviado', codigo: null, envio_id: envio().id, msg_id: 'MSG-CA6' }]);
    const payload = JSON.parse(envio().payload);
    assert.equal(payload.origem.tipo, 'remetente');
    assert.deepEqual(JSON.parse(envio().group_jids), [GRUPO_REM]);
    assert.deepEqual(ml.lidos, [URL_ML_REM]);
    const nosGrupos = s.wa.simulated.filter((m) => m.jid.endsWith('@g.us'));
    assert.equal(nosGrupos.length, 1);
    assert.equal(nosGrupos[0].jid, GRUPO_REM);
    assert.match(nosGrupos[0].text, /https:\/\/meli\.la\/fake-/, 'sai com o link do dono, não com o recebido');
    assert.ok(!nosGrupos[0].text.includes(URL_ML_REM));
    // a resposta (responderPendentes, no passo dos remetentes do tick seguinte) vai ao número cadastrado, com a frase fixa
    const respondeu = () => s.wa.simulated.some((m) => m.jid === PN_REM);
    for (const t0 = Date.now(); !respondeu() && Date.now() - t0 < 3000;) { await s.scheduler.tick(); await new Promise((ok) => setTimeout(ok, 5)); }
    assert.ok(respondeu(), 'a resposta ao remetente não saiu');
    assert.deepEqual(s.wa.simulated.filter((m) => m.jid === PN_REM).map((m) => m.text), [RESPOSTAS.enviadoTodos(1)]);
    const log = s.db.prepare('SELECT rule_name, level FROM log ORDER BY id').all().map((l) => ({ ...l }));
    assert.ok(log.some((l) => l.rule_name === 'Remetente: Sócio Pedro' && l.level === 'ok'), JSON.stringify(log));
    assert.ok(!JSON.stringify(log).includes(NUMERO_REM.slice(-8)), 'o número não vai ao log');
  } finally { await s.fechar(); }
});

test('remetente (CA6): mensagem que chega no meio do tick (depois do passo dos remetentes) sai no laço "acordado" do mesmo tick', async () => {
  const s = await subir({ publicHost: '', panelPassword: '', ml: mlSemRede() });
  try {
    cadastrarRemetente(s.db);
    const avisosTick = s.scheduler.avisos.tick;
    let chegou = false;
    s.scheduler.avisos.tick = async () => {
      if (!chegou) { chegou = true; await s.wa._onMensagens(upsertPrivado(URL_ML_REM, { id: 'MSG-MEIO' })); }
      return avisosTick();
    };
    await s.scheduler.tick();
    assert.ok(chegou, 'o passo dos avisos rodou');
    assert.deepEqual(itensRem(s.db).map((i) => i.status), ['enviado'], 'o item foi decidido no mesmo tick');
    assert.equal(s.db.prepare('SELECT status FROM envios').get()?.status, 'concluido', 'o envio saiu no mesmo tick');
    assert.equal(s.wa.simulated.filter((m) => m.jid === GRUPO_REM).length, 1);
    assert.deepEqual(s.wa.simulated.filter((m) => m.jid === PN_REM).map((m) => m.text), [RESPOSTAS.enviadoTodos(1)], 'e a resposta também');
  } finally { await s.fechar(); }
});

test('remetente (CA2): mensagem privada de número não cadastrado, de remetente desligado ou minha não gera item, envio, log nem resposta', async (t) => {
  const ml = mlSemRede();
  const s = await subir({ publicHost: '', panelPassword: '', ml });
  try {
    const saida = []; for (const n of ['log', 'info', 'warn', 'error']) t.mock.method(console, n, (...a) => saida.push(a.join(' ')));
    cadastrarRemetente(s.db, { nome: 'Desligado', jid: '5535911112222@s.whatsapp.net', lid: null, enabled: 0 });
    const logAntes = s.db.prepare('SELECT COUNT(*) AS n FROM log').get().n;
    await s.wa._onMensagens(upsertPrivado(URL_ML_REM, { id: 'X1', jid: '5511988887777@s.whatsapp.net' })); // não cadastrado
    await s.wa._onMensagens(upsertPrivado(URL_ML_REM, { id: 'X2', jid: '208888888888888@lid' }));          // LID desconhecido
    await s.wa._onMensagens(upsertPrivado(URL_ML_REM, { id: 'X3', jid: '5535911112222@s.whatsapp.net' })); // remetente desligado
    const minha = upsertPrivado(URL_ML_REM, { id: 'X4', jid: PN_REM }); minha.messages[0].key.fromMe = true;
    cadastrarRemetente(s.db);
    await s.wa._onMensagens(minha);                                                                         // fromMe
    await s.scheduler.tick();
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM remetente_itens').get().n, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM log').get().n, logAntes);
    assert.deepEqual(s.wa.simulated, []);
    assert.deepEqual(ml.lidos, [], 'nem a loja é consultada');
    assert.deepEqual(saida, [], 'silêncio total, inclusive no console');
  } finally { await s.fechar(); }
});

test('remetente (CA9): GET /api/remetentes com login responde 200 sem o número nem o LID; sem login 401; o Histórico também não traz o número', async () => {
  const s = await subir();
  try {
    cadastrarRemetente(s.db);
    assert.equal((await req(s.port, '/api/remetentes')).status, 401);
    const cookie = sidDe(await login(s.port));
    const r = await req(s.port, '/api/remetentes', { headers: { cookie } });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(r.json.remetentes.map((x) => x.nome), ['Sócio Pedro']);
    assert.equal(r.json.remetentes[0].numero, '+55 35 •••••-1234', 'só o número mascarado');
    for (const proibido of [NUMERO_REM, NUMERO_REM.slice(-8), PN_REM, LID_REM, LID_REM.split('@')[0], 'whatsapp.net', '@lid']) {
      assert.ok(!r.txt.includes(proibido), `a resposta traz ${proibido}`);
    }
    s.db.prepare("INSERT INTO remetente_itens (remetente_id, remetente_nome, msg_id, ts, url, loja, status, codigo, motivo, decidido_em) VALUES (?, 'Sócio Pedro', 'M1', ?, ?, 'mercadolivre', 'descartado', 'sem_dados', 'sem dados', ?)")
      .run(r.json.remetentes[0].id, Date.now(), URL_ML_REM, Date.now());
    const h = await req(s.port, '/api/remetentes/itens', { headers: { cookie } });
    assert.equal(h.status, 200, h.txt);
    assert.equal(h.json.length, 1);
    for (const proibido of [NUMERO_REM, NUMERO_REM.slice(-8), LID_REM.split('@')[0], 'whatsapp.net']) assert.ok(!h.txt.includes(proibido), `o Histórico traz ${proibido}`);
  } finally { await s.fechar(); }
});

test('remetente (CA9): "Apagar o que já passou do prazo" (POST /api/privacidade/limpar) também apaga os itens antigos dos remetentes, com a regra da retenção', async () => {
  const s = await subir({ publicHost: '', panelPassword: '' });
  try {
    const origin = `http://127.0.0.1:${s.port}`;
    const DIA = 86400000; const agora = Date.now(); const velho = agora - 60 * DIA;
    s.db.prepare("INSERT INTO settings (key, value) VALUES ('retencao_dias', '30') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const curta = cadastrarRemetente(s.db);
    const longa = cadastrarRemetente(s.db, { nome: 'Longo', jid: '5535911113333@s.whatsapp.net', lid: null, dedupe_horas: 8760 });
    const ins = s.db.prepare("INSERT INTO remetente_itens (remetente_id, remetente_nome, msg_id, ts, url, loja, status, decidido_em) VALUES (?, 'x', ?, ?, '', 'mercadolivre', ?, ?)");
    ins.run(curta, 'velho-descartado', velho, 'descartado', velho);    // apaga
    ins.run(curta, 'velho-enviado', velho, 'enviado', velho);          // fora das 24 h de "Horas sem repetir": apaga
    ins.run(longa, 'velho-dedupe', velho, 'enviado', velho);           // ainda conta para "Horas sem repetir" (1 ano): fica
    ins.run(curta, 'velho-recebido', velho, 'recebido', null);         // ativo: fica
    ins.run(curta, 'recente', agora - DIA, 'descartado', agora - DIA); // dentro dos 30 dias: fica
    const r = await req(s.port, '/api/privacidade/limpar', { method: 'POST', headers: { origin } });
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.remetentes, 2);
    assert.equal(r.json.espelhamento, 0, 'o resto da resposta continua igual');
    assert.deepEqual(s.db.prepare('SELECT msg_id FROM remetente_itens ORDER BY id').all().map((i) => i.msg_id), ['velho-dedupe', 'velho-recebido', 'recente']);
    s.db.prepare("UPDATE settings SET value = '0' WHERE key = 'retencao_dias'").run();
    const r0 = await req(s.port, '/api/privacidade/limpar', { method: 'POST', headers: { origin } });
    assert.deepEqual([r0.status, r0.json.remetentes], [200, 0], 'retenção 0 (para sempre): nada sai');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM remetente_itens').get().n, 3);
  } finally { await s.fechar(); }
});

test('remetente (CA10): start() devolve os itens "processando" (o serviço caiu no meio) a "recebido" antes do primeiro tick, e o tick os envia', async () => {
  const s = await subir({ publicHost: '', panelPassword: '', ml: mlSemRede() });
  try {
    const id = cadastrarRemetente(s.db);
    s.db.prepare("INSERT INTO remetente_itens (remetente_id, remetente_nome, msg_id, ts, url, loja, chave, status) VALUES (?, 'Sócio Pedro', 'M-CAIU', ?, ?, 'mercadolivre', 'MLB1234567890', 'processando')")
      .run(id, Date.now(), URL_ML_REM);
    s.scheduler.start();
    s.scheduler.stop(); // sem o timer: o tick vem daqui
    assert.deepEqual(itensRem(s.db).map((i) => i.status), ['recebido']);
    await s.scheduler.tick();
    assert.deepEqual(itensRem(s.db).map((i) => i.status), ['enviado']);
    assert.equal(s.wa.simulated.filter((m) => m.jid === GRUPO_REM).length, 1, 'saiu uma vez só');
  } finally { s.scheduler.stop(); await s.fechar(); }
});

test('remetente (CA10): falha no passo dos remetentes não trava o tick e vai ao console só com o nome do erro', async (t) => {
  const s = await subir({ publicHost: '', panelPassword: '' });
  try {
    const saida = []; t.mock.method(console, 'error', (...a) => saida.push(a.join(' ')));
    const chamadas = [];
    const erro = () => { const e = new Error(`falhou com ${PN_REM}`); e.code = 'ERR_SQLITE_ERROR'; return e; };
    s.scheduler.remetentes.responderPendentes = async () => { chamadas.push('responder'); throw erro(); };
    s.scheduler.remetentes.processarPendentes = async () => { chamadas.push('processar'); throw erro(); };
    const avisosTick = s.scheduler.avisos.tick;
    s.scheduler.avisos.tick = async () => { chamadas.push('avisos'); return avisosTick(); };
    s.scheduler.remetentes.recuperar = () => { chamadas.push('recuperar'); throw erro(); };
    s.scheduler.start(); s.scheduler.stop();
    await s.scheduler.tick();
    assert.deepEqual(chamadas, ['recuperar', 'responder', 'processar', 'avisos'], 'a resposta que falha não impede a decisão, e o tick segue');
    assert.ok(saida.length >= 3 && saida.every((l) => l.startsWith('[agendador] remetentes')), saida.join('\n'));
    assert.ok(saida.every((l) => !l.includes(NUMERO_REM.slice(-8))), 'o número (mensagem do erro) não vai ao console');
    assert.ok(saida.some((l) => l.includes('ERR_SQLITE_ERROR')));
  } finally { s.scheduler.stop(); await s.fechar(); }
});
