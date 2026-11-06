// QA da integração da Magalu (plano integracao-magalu; rodada 1). Complementa test/magalu.test.js, test/magalu-painel.test.js e os
// casos da Magalu em envios/lojas/conexoes/remetentes: aqui ficam o que os testes do dev não amarram.
//   A. Varredura do link montado (CA2/CA3): hosts parecidos, caminhos hostis e propriedades (nunca a loja de outro parceiro,
//      utm ou fragmento; idempotente; sempre casa LINK_MAGALU).
//   B. SSRF do resolvedor de link curto (CA6): Location para IP, localhost, userinfo, protocolo relativo e host parecido nunca
//      é pedido; nenhum fetch fora do primeiro salto.
//   C. De ponta a ponta com a fiação REAL (criarServicos + buildApp) e o painel real (public/disparos.js num vm) falando com o
//      servidor de verdade: Identificar → veredito → Disparar → Histórico (CA1, CA4, CA5, CA9).
//   D. Envio agendado (CA5): loja adulterada no banco, `implementada:false` de volta, loja trocada.
//   E. Remetente (CA7/CA9): link curto `magalu.com` com query, link da loja do sócio que não é produto, o que fica no banco.
//   F. Regressões de Amazon, Shopee, ML e Facebook no Identificar (CA8) e a documentação (CA10).
// Nenhum teste acessa a rede: o fetch global é trocado por um que falha e conta; o último teste prova que ninguém o chamou.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createEnvios } from '../src/envios.js';
import { createRemetentes } from '../src/remetentes.js';
import { createMagalu, extrairProdutoMagalu, montarLinkMagalu, LinkMagaluNaoResolvido, ErroMagalu, LINK_MAGALU } from '../src/magalu.js';
import * as lojasPadrao from '../src/lojas.js';
import { identificar, LojaNaoConectada } from '../src/lojas.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qamag-')); pastas.push(p); return p; };

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lerArquivo = (...partes) => fs.readFileSync(path.join(RAIZ, ...partes), 'utf8');
const SENHA = 'senha-de-teste-123';
const LOJA_DONO = 'lojadodono';
const LOJA_OUTRO = 'lojadooutro';
const IMG = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';

// ====================================================================================== A. varredura do link montado

const HOSTS_PRODUTO = ['www.magazineluiza.com.br', 'magazineluiza.com.br', 'm.magazineluiza.com.br', 'WWW.MAGAZINELUIZA.COM.BR',
  'www.magazinevoce.com.br', `magazinevoce.com.br`];
const CAMINHOS = ['/fone-bom/p/abc123/', '/p/abc123/', '/fone-bom/p/ABC123/Audio/Fones/', '/fone-bom/p/abc123', '/fone/p/abc1234567890abcdef/te/ga15/',
  '/fone/p/abc123/a/b/c/', '/fone/p/abc12/', '/fone/p/abc-123/', '/fone_bom/p/abc123/', '/fone/p/abc123/../x/', '/fone//p/abc123/', '/fone/p/abc123/%2e%2e/',
  '/fone%20bom/p/abc123/', '/busca/fone/', '/', '', '/p/', '/fone/P/abc123/', '/a/b/p/abc123/'];
const QUERIES = ['', '?seller_id=magazineluiza', '?seller_id=a%20b', '?seller_id=x&utm_source=zap', '?utm_source=zap&seller_id=ok_1', '?seller_id=%2e%2e&x=1',
  `?parceiro=${LOJA_OUTRO}`, '?u=https://evil.example/x', '?seller_id=' + 'a'.repeat(61), '?seller_id=a&seller_id=b'];
const FRAGMENTOS = ['', '#topo', '#https://evil.example'];

/** Todas as combinações (host × caminho × query × fragmento), cada uma com a loja do link colado quando é do magazinevoce. */
function* combinacoes() {
  for (const host of HOSTS_PRODUTO) {
    for (const caminho of CAMINHOS) {
      for (const query of QUERIES) {
        for (const frag of FRAGMENTOS) {
          const parceiro = /magazinevoce/i.test(host);
          yield `https://${host}${parceiro ? `/${LOJA_OUTRO}` : ''}${caminho}${query}${frag}`;
        }
      }
    }
  }
}

test('CA3: varredura: tudo o que vira link casa LINK_MAGALU, leva a loja salva e nunca a de outro parceiro, utm, fragmento nem o link colado', () => {
  let montados = 0; let recusados = 0;
  for (const url of combinacoes()) {
    let link = null;
    try { link = montarLinkMagalu(url, 'MinhaLoja_1'); } catch (e) {
      assert.ok(e instanceof LinkMagaluNaoResolvido, `${url}: erro inesperado ${e?.name}`);
      assert.equal(e.causa, 'invalido');
      assert.equal(extrairProdutoMagalu(url), null, `recusado pelo montar, aceito pelo extrair: ${url}`);
      recusados++; continue;
    }
    montados++;
    assert.match(link, LINK_MAGALU, url);
    assert.ok(link.startsWith('https://www.magazinevoce.com.br/MinhaLoja_1/'), `${url} → ${link}`);
    for (const proibido of [LOJA_OUTRO, 'utm_', '#', 'evil', 'parceiro', '%', '..', '//www.magazineluiza']) assert.ok(!link.slice(8).includes(proibido), `vazou "${proibido}": ${url} → ${link}`);
    // idempotência: montar de novo a partir do que saiu, com outra loja, dá o mesmo caminho (nada se acumula)
    assert.equal(montarLinkMagalu(link, 'outra-loja').replace('/outra-loja/', '/MinhaLoja_1/'), link, url);
    const p = extrairProdutoMagalu(url);
    assert.equal(p.lojaDoLink, /magazinevoce/i.test(url) ? LOJA_OUTRO : null, url);
    assert.ok(!Object.hasOwn(p, 'caminho'), 'o campo interno `caminho` não vaza no objeto público');
  }
  assert.ok(montados > 200 && recusados > 200, `a varredura exercitou os dois lados (${montados} montados, ${recusados} recusados)`);
});

test('CA3: um seller_id válido segue (o primeiro, se repetido); inválido, longo ou codificado cai sem derrubar o link', () => {
  const base = 'https://www.magazineluiza.com.br/fone/p/abc123/';
  const monta = (q) => montarLinkMagalu(`${base}${q}`, LOJA_DONO);
  assert.equal(monta('?seller_id=magazineluiza'), `https://www.magazinevoce.com.br/${LOJA_DONO}/fone/p/abc123/?seller_id=magazineluiza`);
  assert.equal(monta('?seller_id=a&seller_id=b'), `https://www.magazinevoce.com.br/${LOJA_DONO}/fone/p/abc123/?seller_id=a`);
  for (const q of ['?seller_id=a%20b', `?seller_id=${'a'.repeat(61)}`, '?seller_id=', '?seller_id=%2e%2e', '?seller_id=a/b', '?seller_id=a&utm=x']) {
    const esperado = q === '?seller_id=a&utm=x' ? '?seller_id=a' : '';
    assert.equal(monta(q), `https://www.magazinevoce.com.br/${LOJA_DONO}/fone/p/abc123/${esperado}`, q);
  }
});

test('CA2: identificar() reconhece os hosts da Magalu e os subdomínios; host parecido, userinfo e ponto final não', () => {
  const sim = ['https://www.magazineluiza.com.br/x', 'https://magazineluiza.com.br/x', 'https://m.magazineluiza.com.br/x', 'https://www.magazinevoce.com.br/loja/',
    'https://magalu.com/x', 'https://www.magalu.com/x', 'https://divulgador.magalu.com/x', 'https://maga.lu/AbC', 'https://www.maga.lu/AbC',
    'https://magazineluiza.onelink.me/AbC/xyz', 'https://x.magazineluiza.onelink.me/AbC', 'HTTPS://MAGAZINELUIZA.COM.BR/X', 'http://maga.lu/x'];
  for (const u of sim) assert.deepEqual(identificar(u), { id: 'magalu', nome: 'Magalu', implementada: true }, u);
  const nao = ['https://magazineluiza.com.br.evil.com/x', 'https://xmagalu.com/', 'https://magalu.com.evil.com/', 'https://evilmaga.lu/', 'https://maga.lu.evil.com/',
    'https://onelink.me/AbC', 'https://evil.onelink.me/AbC', 'https://magazineluiza.com/x', 'https://magazinevoce.com/x', 'https://magalu.com@evil.com/',
    'https://evil.com#@magalu.com', 'https://evil.com/?u=https://maga.lu/x', 'https://magazineluiza.com.br./x', 'https://magazine-luiza.com.br/x',
    'https://magazineluiza.com.br%2eevil.com/x', 'https://magalu.com.br/x', 'ftp://maga.lu/x', 'javascript:alert(1)', ''];
  for (const u of nao) assert.notEqual(identificar(u)?.id, 'magalu', u);
  // as outras lojas seguem sendo outras lojas
  assert.equal(identificar('https://www.amazon.com.br/dp/B0ABC12345').id, 'amazon');
  assert.equal(identificar('https://shopee.com.br/x-i.1.2').id, 'shopee');
  assert.equal(identificar('https://meli.la/2AbC').id, 'mercadolivre');
  assert.deepEqual(identificar('https://www.facebook.com/marketplace/item/1/'), { id: 'facebook', nome: 'Facebook', implementada: false });
});

// ====================================================================================== B. SSRF do resolvedor

/** fetch falso que registra tudo e responde 302 com o Location dado para o link curto de cada caso. */
function fetchComSalto(destinoPorUrl) {
  const chamadas = [];
  const f = async (url) => {
    const u = String(url);
    chamadas.push(u);
    if (Object.hasOwn(destinoPorUrl, u)) return new Response(null, { status: 302, headers: { location: destinoPorUrl[u] } });
    throw new Error('rede não prevista no teste');
  };
  f.chamadas = chamadas;
  return f;
}

test('CA6: Location para IP, localhost, userinfo, protocolo relativo, porta e host parecido nunca é pedido: invalido, com um GET só', async () => {
  const destinos = ['http://127.0.0.1/p/abc123/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:3737/api', 'https://[::1]/x', 'http://0x7f000001/x',
    'https://magalu.com@evil.example/p/abc123/', '//evil.example/fone/p/abc123/', 'https://xmagalu.com/fone/p/abc123/', 'https://magazineluiza.com.br.evil.example/fone/p/abc123/',
    'https://www.magazinevoce.com.br:8443/loja/fone/p/abc123/', 'https://user:senha@www.magazinevoce.com.br/loja/fone/p/abc123/', 'file:///etc/passwd',
    'javascript:alert(1)'];
  for (const destino of destinos) {
    const f = fetchComSalto({ 'https://maga.lu/Curto1': destino });
    const m = createMagalu({ fetch: f });
    await assert.rejects(m.resolver('https://maga.lu/Curto1'), (e) => e instanceof LinkMagaluNaoResolvido && e.causa === 'invalido' && !e.message.includes('evil') && !e.message.includes('127.0.0.1'), destino);
    assert.deepEqual(f.chamadas, ['https://maga.lu/Curto1'], `${destino}: nada além do link curto foi pedido`);
  }
});

test('CA6: o Location que o parser normaliza para outra página da Magalu segue, mas só entre hosts da Magalu e nunca o produto', async () => {
  // `%2e%2e` vira `..` no parser de URL: o destino real é uma página sem produto num host da Magalu (permitido); o fetch só vai a hosts da lista
  const f = fetchComSalto({ 'https://maga.lu/Curto1': 'https://www.magazinevoce.com.br/loja/fone/p/abc123/%2e%2e/' });
  const m = createMagalu({ fetch: f });
  await assert.rejects(m.resolver('https://maga.lu/Curto1'), (e) => e instanceof LinkMagaluNaoResolvido && e.causa === 'invalido');
  for (const u of f.chamadas) assert.ok(['maga.lu', 'www.magazinevoce.com.br'].includes(new URL(u).hostname), u);
  assert.ok(!f.chamadas.some((u) => /abc123/.test(u)), 'a página do produto nunca é pedida');
});

test('CA6: entrada com porta, credenciais ou host de fora nunca chega ao fetch; maga.lu em maiúsculas e sem esquema resolve', async () => {
  const f = fetchComSalto({ 'https://maga.lu/Curto1': `https://www.magazinevoce.com.br/${LOJA_OUTRO}/fone/p/abc123/?utm_source=x#y` });
  const m = createMagalu({ fetch: f });
  for (const url of ['https://maga.lu:8443/x', 'https://u:p@maga.lu/x', 'https://evil.example/x', 'ftp://maga.lu/x', '', null, undefined, 42, {}, 'https://maga.lu/' + 'a'.repeat(2100)]) {
    await assert.rejects(m.resolver(url), (e) => e instanceof LinkMagaluNaoResolvido && e.causa === 'invalido', String(url).slice(0, 40));
  }
  assert.deepEqual(f.chamadas, []);
  for (const url of ['maga.lu/Curto1', 'HTTPS://MAGA.LU/Curto1', ' https://maga.lu/Curto1 ']) {
    const p = await m.resolver(url);
    assert.deepEqual(p, { codigo: 'abc123', urlProduto: 'https://www.magazineluiza.com.br/fone/p/abc123/', sellerId: null, lojaDoLink: LOJA_OUTRO }, url);
  }
  assert.deepEqual(f.chamadas, ['https://maga.lu/Curto1'], 'o cache do cliente: o mesmo curto foi pedido uma vez só');
});

test('CA6: pedidos simultâneos do mesmo link curto dividem um só GET', async () => {
  let abrir; const portao = new Promise((r) => { abrir = r; });
  const chamadas = [];
  const f = async (url) => { chamadas.push(String(url)); await portao; return new Response(null, { status: 302, headers: { location: `https://www.magazinevoce.com.br/${LOJA_OUTRO}/fone/p/abc123/` } }); };
  const m = createMagalu({ fetch: f });
  const todos = Promise.all(Array.from({ length: 5 }, () => m.resolver('https://maga.lu/Simultaneo')));
  await new Promise((r) => setImmediate(r));
  abrir();
  const r = await todos;
  assert.equal(chamadas.length, 1);
  assert.ok(r.every((p) => p.codigo === 'abc123'));
});

test('CA6/CA9: o fetch que lança com o link e a loja na mensagem vira só a frase fixa de invalido', async () => {
  const f = async (url) => { throw new TypeError(`boom ${url} ${LOJA_OUTRO}`); };
  const m = createMagalu({ fetch: f });
  await assert.rejects(m.resolver('https://maga.lu/Boom1'), (e) => e instanceof LinkMagaluNaoResolvido && e.causa === 'invalido'
    && e.message === new LinkMagaluNaoResolvido('invalido').message && !e.message.includes('maga.lu') && !JSON.stringify(e).includes('Boom1'));
});

test('CA3/CA9: ErroMagalu e LinkMagaluNaoResolvido: mensagem fixa, sem a loja nem o link, também em montarLinkMagalu com loja hostil', () => {
  for (const loja of [undefined, null, '', ' ', 'x', 'loja/../x', 'loja com espaço', '<script>', 'a'.repeat(61), 42, ['ab'], { toString: () => 'abcd' }]) {
    assert.throws(() => montarLinkMagalu('https://www.magazineluiza.com.br/fone/p/abc123/', loja), (e) => e instanceof ErroMagalu && e.tipo === 'sem_loja'
      && !e.message.includes('script') && !e.message.includes('loja'.repeat(2)), String(loja));
  }
  // a loja é aparada: o espaço em volta não vira outra loja nem entra no link
  assert.equal(montarLinkMagalu('https://www.magazineluiza.com.br/fone/p/abc123/', '  minhaloja\n'), 'https://www.magazinevoce.com.br/minhaloja/fone/p/abc123/');
});

// ====================================================================================== C. ponta a ponta (fiação real + painel real)

const LINK_CURTO = 'https://maga.lu/AbC123';
const LINK_CURTO_FALHA = 'https://magazineluiza.onelink.me/Falha1';
const URL_DO_OUTRO = `https://www.magazinevoce.com.br/${LOJA_OUTRO}/fone-bom/p/ABC123/audio/fones/?seller_id=magazineluiza&utm_source=parceiro#topo`;
const LINK_DO_DONO = (loja = LOJA_DONO) => `https://www.magazinevoce.com.br/${loja}/fone-bom/p/abc123/audio/fones/?seller_id=magazineluiza`;

/** fetch da Magalu: o curto leva ao produto na loja de outro parceiro; o outro leva para fora. Guarda tudo. */
function fetchMagalu() {
  const chamadas = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    chamadas.push({ url: u, metodo: init.method || 'GET', redirect: init.redirect });
    if (u === LINK_CURTO) return new Response(null, { status: 302, headers: { location: URL_DO_OUTRO } });
    if (u === LINK_CURTO_FALHA) return new Response(null, { status: 302, headers: { location: 'https://evil.example/fone-bom/p/abc123/' } });
    throw new Error('rede não prevista no teste');
  };
  f.chamadas = chamadas;
  return f;
}

function mlFalso() {
  return { async resolveOffer(c) { return { key: c.key, url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: true, image: IMG }; } };
}

function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const h = { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(partes).toString('utf8');
        let json = null; try { json = JSON.parse(txt); } catch { /* html */ }
        ok({ status: res.statusCode, headers: res.headers, json, txt });
      });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

/** O mesmo caminho do main de src/server.js: criarServicos (com o fetch falso da Magalu) + buildApp, já com a sessão aberta. */
async function subirReal({ loja = LOJA_DONO } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  db.prepare("INSERT INTO tags (name, created_at) VALUES ('etiquetaA', 1)").run();
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const ml = mlFalso();
  const fetchM = fetchMagalu();
  const { scheduler } = criarServicos({ db, wa, links, fast: true, dir, ml, fetch: fetchM });
  const app = buildApp({ db, wa, links, scheduler, panelPassword: SENHA, dataDir: dir, ml, publicHost: '' });
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const { port } = server.address();
  const entrou = await req(port, '/api/login', { method: 'POST', body: { senha: SENHA } });
  const h = { cookie: String(entrou.headers['set-cookie']?.[0] || '').split(';')[0], origin: `http://127.0.0.1:${port}` };
  const s = {
    db, wa, dir, port, scheduler, fetchM, links, headers: h,
    get: (c) => req(port, c, { headers: h }),
    post: (c, body = {}) => req(port, c, { method: 'POST', body, headers: h }),
    put: (c, body = {}) => req(port, c, { method: 'PUT', body, headers: h }),
    salvarLoja: (nome) => s.put('/api/conexoes/magalu', { campos: { loja: nome } }),
    fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }),
  };
  if (loja) { const r = await s.salvarLoja(loja); assert.equal(r.status, 200, r.txt); }
  return s;
}

const statusDe = (db, id) => db.prepare('SELECT status FROM envios WHERE id = ?').get(id)?.status;
async function terminar(db, id, ms = 4000) {
  const t0 = Date.now();
  while (['pendente', 'enviando'].includes(statusDe(db, id))) {
    if (Date.now() - t0 > ms) throw new Error(`o envio ${id} não terminou`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return statusDe(db, id);
}
const capturarConsole = (t) => ['error', 'warn', 'log', 'info'].map((m) => t.mock.method(console, m, () => {}));
const textoDoConsole = (espias) => espias.flatMap((e) => e.mock.calls.map((c) => c.arguments.map(String).join(' '))).join('\n');

// ---- o painel real (public/disparos.js) num vm, com a rede apontada para o servidor de verdade
function el(extra = {}) {
  const classes = new Set(); const attrs = new Map();
  return {
    value: '', checked: false, disabled: false, hidden: false, _t: '', _html: '', className: '', placeholder: '', src: '', tabIndex: 0,
    dataset: {}, style: {}, isConnected: true, parentNode: null, focado: 0, filhos: [],
    classes, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle(c, on) { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); } },
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute(k) { if (k === 'style') this.style = {}; attrs.delete(k); },
    focus() { this.focado++; }, click() {}, scrollIntoView() {}, closest: () => null, insertBefore() {}, remove() {},
    appendChild(f) { this.filhos.push(f); return f; },
    insertAdjacentHTML(_onde, h) { this._html += h; },
    get textContent() { return this._t; }, set textContent(v) { this._t = String(v); this._html = ''; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); if (v === '') this.filhos = []; },
    ...extra,
  };
}
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Abre a página do Disparo manual com `fetch` indo ao servidor real (cookie e Origin da sessão). */
async function abrirPainel(s, { grupos = ['111@g.us'] } = {}) {
  const mapa = new Map(); const campos = new Map(); const erros = [];
  const $ = (sel) => { if (!mapa.has(sel)) mapa.set(sel, el()); return mapa.get(sel); };
  const sessao = (await s.get('/api/templates'));
  const templates = Array.isArray(sessao.json) ? sessao.json : [{ id: 1, name: 'Padrão', body: '{TITULO} {LINK}' }];
  const fetchPainel = async (url, opts = {}) => {
    const metodo = opts.method || 'GET';
    const corpo = typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    const r = await req(s.port, url, { method: metodo, body: corpo, headers: s.headers });
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json };
  };
  const S = { templates, tags: [{ id: 1, name: 'etiquetaA' }], groups: [], st: { whatsapp: { status: 'open' }, extensao: { online: false }, ajustes: { link_mode: 'extension' }, simulacao: false } };
  const ctx = {
    console, setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; }, clearTimeout, Number, String, Math, Date, JSON, Array, Object, RegExp, URL, Intl, Promise, Symbol, Error, Set, Map,
    document: {
      createElement: () => el({ elements: { namedItem: (n) => { if (!campos.has(n)) campos.set(n, el()); return campos.get(n); } } }),
      getElementById: () => null, activeElement: null, body: el(),
    },
    $, $$: () => [], esc, zap: (x) => String(x), REQ: '*', q: (c) => `[?${c}]`, opcoes: () => '', aviso() {},
    mostrarErros: (_f, lista) => { erros.push(...lista); return lista.length > 0; },
    S, seletorGrupos: () => ({ html: '', ligar() {}, marcados: () => grupos }),
    location: { hash: '#teste', replace() {} }, confirm: () => true, FileReader: class {},
    fetch: fetchPainel,
  };
  vm.createContext(ctx);
  vm.runInContext(`${lerArquivo('public', 'disparos.js')}\n;globalThis.__x = { paginaDisparoManual, dispMagaluVeredito };`, ctx);
  ctx.__x.paginaDisparoManual();
  $('#dm-tpl').value = String(templates[0].id);
  return {
    $, campos, erros, S,
    async identificar(url) { $('#dm-url').value = url; await $('#dm-identificar').onclick(); },
    digitar(nome, valor) { const c = campos.get(nome); c.value = valor; c.oninput?.(); },
    disparar: () => $('#dm-disparar').onclick(),
  };
}

/** O painel com a sessão do cliente de teste (o `fetch` do vm manda o mesmo cookie e Origin). */
const comPainel = (s) => abrirPainel(s);

test('CA1/CA4/CA5: do cartão ao Histórico com a fiação real: salvar a loja, Identificar (curto), o painel libera, Disparar, grupo recebe o link do dono, Histórico', async (t) => {
  const espias = capturarConsole(t);
  const s = await subirReal({ loja: null });
  try {
    // CA1: sem nome, "Falta configurar"; com nome válido, "Configurada" (pronta); o recusado não ecoa
    const antes = (await s.get('/api/conexoes')).json.find((p) => p.id === 'magalu');
    assert.deepEqual([antes.implementada, antes.estado], [true, 'falta_configurar']);
    const ruim = await s.salvarLoja('https://www.magazinevoce.com.br/outra');
    assert.equal(ruim.status, 400); assert.ok(!ruim.txt.includes('https://') && !ruim.txt.includes('/outra'), 'sem eco do valor recusado');
    const painel = await comPainel(s);

    // sem loja salva: o painel bloqueia, com o motivo e sem o texto (o servidor devolve texto:null), e não quebra
    await painel.identificar(URL_DO_OUTRO);
    assert.equal(painel.$('#dm-disparar').disabled, true);
    assert.equal(painel.$('#dm-motivo').textContent, 'Cadastre o nome da loja da Magalu em Conexões.');
    assert.match(painel.$('#dm-prod').innerHTML, /Cadastre em Conexões\./);
    assert.doesNotMatch(painel.$('#dm-prod').innerHTML, new RegExp(LOJA_OUTRO), 'a loja do outro parceiro nunca aparece');

    const salvo = await s.salvarLoja(`  ${LOJA_DONO} `);
    assert.deepEqual([salvo.status, salvo.json.estado, salvo.json.config], [200, 'pronta', { loja: LOJA_DONO }]);

    // com a loja, link curto: o servidor segue o redirecionamento (um GET) e o painel libera o Disparar
    await painel.identificar(LINK_CURTO);
    assert.deepEqual(s.fetchM.chamadas, [{ url: LINK_CURTO, metodo: 'GET', redirect: 'manual' }]);
    assert.equal(painel.$('#dm-disparar').disabled, false, painel.$('#dm-motivo').textContent);
    assert.match(painel.$('#dm-prod').innerHTML, /A Magalu não deixa o painel ler o produto/);
    assert.match(painel.$('#dm-prod').innerHTML, /outra loja de parceiro/, 'o curto levou à página da loja de outro parceiro');
    assert.doesNotMatch(painel.$('#dm-prod').innerHTML, new RegExp(LOJA_OUTRO));
    assert.equal(painel.$('#dm-pv').innerHTML.includes(LINK_DO_DONO()), true, `a prévia leva o link real do dono: ${painel.$('#dm-pv').innerHTML}`);
    assert.ok(!painel.$('#dm-pv').innerHTML.includes(LOJA_OUTRO));
    assert.match(painel.$('[data-etq-txt]').innerHTML, new RegExp(`sua loja de parceiro, ${LOJA_DONO} `));

    // Disparar sem título: a frase de sempre e nada gravado; com título e preço, sai
    await painel.disparar();
    assert.deepEqual(painel.erros.map((e) => e.msg), ['Preencha o título da oferta.']);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0);
    painel.erros.length = 0;
    painel.digitar('title', 'Fone Bom'); painel.digitar('price', '89,90');
    await painel.disparar();
    assert.deepEqual(painel.erros, []);
    const envio = s.db.prepare('SELECT id, payload FROM envios').get();
    assert.equal(await terminar(s.db, envio.id), 'concluido');
    const [m] = s.wa.simulated;
    assert.equal(m.tipo, 'text');
    assert.ok(m.text.includes(LINK_DO_DONO()), m.text);
    for (const x of [LOJA_OUTRO, 'utm_source', '#topo', 'maga.lu']) assert.ok(!m.text.includes(x), `o texto levou "${x}": ${m.text}`);
    const payload = JSON.parse(envio.payload);
    assert.equal(payload.url, 'https://www.magazineluiza.com.br/fone-bom/p/abc123/audio/fones/?seller_id=magazineluiza');
    assert.ok(!JSON.stringify(payload).includes(LOJA_OUTRO) && !JSON.stringify(payload).includes(LOJA_DONO), 'o payload não guarda loja nenhuma');

    const hist = await s.get('/api/envios?tipo=oferta');
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.json.linhas.map((l) => [l.titulo, l.loja, l.status]), [['Fone Bom', 'Magalu', 'enviado']]);
    const log = s.db.prepare("SELECT message FROM log WHERE rule_name = 'Disparo manual'").all().map((l) => l.message);
    assert.deepEqual(log, ['Enviado pela Magalu, com a sua loja de parceiro']);

    // CA9: nada no console nem no log leva link ou loja
    const todoLog = JSON.stringify(s.db.prepare('SELECT * FROM log').all());
    for (const x of [LOJA_DONO, LOJA_OUTRO, 'magazinevoce', 'magazineluiza', 'maga.lu', 'abc123']) {
      assert.ok(!todoLog.includes(x), `log levou "${x}"`);
      assert.ok(!textoDoConsole(espias).includes(x), `console levou "${x}"`);
    }
  } finally { await s.fechar(); }
});

test('CA4: Identificar real: invalido, nao_produto, outra_loja sem loja salva, loja do banco mexida: o servidor decide e o painel obedece; sem rede', async () => {
  const s = await subirReal({ loja: null });
  try {
    const painel = await comPainel(s);
    const casos = [
      [LINK_CURTO_FALHA, 'invalido', /Não reconheci este link da Magalu/],
      ['https://www.magazineluiza.com.br/busca/fone/', 'nao_produto', /não leva a um produto específico/],
      [`https://www.magazinevoce.com.br/${LOJA_OUTRO}/`, 'nao_produto', /não leva a um produto específico/],
      [`https://www.magazinevoce.com.br/${LOJA_OUTRO}/busca/fone/?utm_source=x`, 'nao_produto', /não leva a um produto específico/],
      [`https://www.magazinevoce.com.br/${LOJA_OUTRO}/categoria/celulares/`, 'nao_produto', /não leva a um produto específico/],
      ['https://magalu.com:8443/x', 'invalido', /Não reconheci este link da Magalu/],
    ];
    for (const [url, causa, texto] of casos) {
      const r = await s.post('/api/disparo/identificar', { url, template_id: 1 });
      assert.equal(r.status, 200, r.txt);
      assert.deepEqual([r.json.causa, r.json.produto, r.json.pode_disparar, r.json.texto, r.json.editavel], [causa, null, false, null, true], url);
      assert.ok(!r.txt.includes(LOJA_OUTRO), `a resposta de ${url} levou a loja do outro`);
      await painel.identificar(url);
      assert.equal(painel.$('#dm-disparar').disabled, true, url);
      assert.match(painel.$('#dm-prod').innerHTML, texto, url);
      assert.doesNotMatch(painel.$('#dm-prod').innerHTML, new RegExp(LOJA_OUTRO), url);
    }
    assert.deepEqual([...new Set(s.fetchM.chamadas.map((c) => c.url))], [LINK_CURTO_FALHA], 'só o link curto (que falhou) foi pedido; busca e vitrine nunca');
    assert.equal(s.fetchM.chamadas.length, 1, 'o cache de invalido do cliente: o POST e o painel pedem uma vez só');

    // o link de produto sem loja salva: causa_link sem_loja, outra_loja false (sem loja salva não há com o que comparar: o
    // link pode ser da própria loja do dono, ainda não cadastrada; R4), e a loja dele nunca na resposta
    const sem = await s.post('/api/disparo/identificar', { url: URL_DO_OUTRO, template_id: 1 });
    assert.deepEqual([sem.json.causa_link, sem.json.outra_loja, sem.json.pode_disparar, sem.json.texto, sem.json.loja_parceiro], ['sem_loja', false, false, null, null]);
    assert.ok(!sem.txt.includes(LOJA_OUTRO) && !sem.txt.includes('utm_source'));

    // o valor da loja mexido direto no banco (fora da regex) é tratado como sem loja
    for (const config of [{ loja: 'a/../b' }, { loja: 'x' }, { loja: ['abcd'] }, { loja: 12345 }, { loja: `${LOJA_DONO}\u0000x` }, 'lixo', null]) {
      s.db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('magalu', ?, '{}', 1) ON CONFLICT(plataforma) DO UPDATE SET config = excluded.config").run(typeof config === 'string' ? config : JSON.stringify(config));
      const r = await s.post('/api/disparo/identificar', { url: URL_DO_OUTRO, template_id: 1 });
      assert.equal(r.status, 200, r.txt);
      assert.deepEqual([r.json.causa_link, r.json.pode_disparar, r.json.loja_parceiro], ['sem_loja', false, null], JSON.stringify(config));
      const criar = await s.post('/api/envios', { tipo: 'oferta', url: URL_DO_OUTRO, template_id: 1, group_jids: ['111@g.us'], quando: 'agora', ajustes: { title: 'Fone' } });
      assert.equal(criar.status, 400, JSON.stringify(config));
      assert.match(criar.json.erro, /^Falta o nome da sua loja de parceiro da Magalu/);
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0);
    assert.equal(s.wa.simulated.length, 0);
  } finally { await s.fechar(); }
});

test('CA4: outra_loja só quando o link é de outra loja; a própria (qualquer caixa), o magazineluiza e o sem-loja não acusam', async () => {
  const s = await subirReal({ loja: 'MinhaLoja' });
  try {
    const quem = async (url) => (await s.post('/api/disparo/identificar', { url, template_id: 1 })).json.outra_loja;
    assert.equal(await quem('https://www.magazinevoce.com.br/minhaloja/fone/p/abc123/'), false, 'minúsculas do mesmo nome');
    assert.equal(await quem('https://www.magazinevoce.com.br/MINHALOJA/fone/p/abc123/'), false);
    assert.equal(await quem('https://www.magazinevoce.com.br/MinhaLoja/fone/p/abc123/'), false);
    assert.equal(await quem('https://www.magazineluiza.com.br/fone/p/abc123/'), false);
    assert.equal(await quem('https://www.magazinevoce.com.br/minhaloja2/fone/p/abc123/'), true, 'nome parecido não é o mesmo');
    assert.equal(await quem('https://www.magazinevoce.com.br/minhalo/fone/p/abc123/'), true);
    const r = await s.post('/api/disparo/identificar', { url: 'https://www.magazinevoce.com.br/minhaloja2/fone/p/abc123/', template_id: 1 });
    assert.ok(r.json.texto.includes('https://www.magazinevoce.com.br/MinhaLoja/fone/p/abc123/'), 'o link usa o nome salvo como foi salvo');
    assert.ok(!r.txt.includes('minhaloja2'));
  } finally { await s.fechar(); }
});

test('CA5: criar com a Magalu recusa sem gravar nada: sem título, título vazio ou só espaços, ajustes que tentam trazer link, imagem ou loja', async () => {
  const s = await subirReal();
  try {
    const corpo = (ajustes, extra = {}) => ({ tipo: 'oferta', url: URL_DO_OUTRO, template_id: 1, group_jids: ['111@g.us'], quando: 'agora', ajustes, ...extra });
    for (const ajustes of [undefined, {}, { title: '' }, { title: '   ' }, { price: 10 }]) {
      const r = await s.post('/api/envios', corpo(ajustes));
      assert.equal(r.status, 400, JSON.stringify(ajustes));
      assert.match(r.json.erro, /título/i, JSON.stringify(ajustes));
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0);
    // campos que o painel nunca manda e o servidor não pode obedecer
    const r = await s.post('/api/envios', corpo({ title: 'Fone', price: 50, link: 'https://evil.example/x', url: 'https://evil.example/y', loja: 'evil', image: 'https://evil.example/i.jpg', loja_parceiro: 'evil' },
      { loja: 'evil', link_afiliado: 'https://evil.example/z', codigo: 'zzz999', offer: { title: 'Falso', price: 1, image: 'https://evil.example/o.jpg' } }));
    assert.equal(r.status, 200, r.txt);
    assert.equal(await terminar(s.db, r.json.id), 'concluido');
    const [m] = s.wa.simulated;
    assert.ok(m.text.includes(LINK_DO_DONO()), m.text);
    assert.ok(!/evil|Falso/.test(m.text), m.text);
    const p = JSON.parse(s.db.prepare('SELECT payload FROM envios WHERE id = ?').get(r.json.id).payload);
    assert.ok(!JSON.stringify(p).includes('evil'), JSON.stringify(p));
    assert.equal(p.codigo, 'abc123'); assert.equal(p.offer.image, null);
  } finally { await s.fechar(); }
});

test('CA5: o mesmo envio disparado duas vezes não confunde: cada um sai uma vez com o link montado, sem repetir nem misturar', async () => {
  const s = await subirReal();
  try {
    const ids = [];
    for (const titulo of ['Fone A', 'Fone B']) {
      const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_DO_OUTRO, template_id: 1, group_jids: ['111@g.us', '222@g.us'], quando: 'agora', ajustes: { title: titulo } });
      assert.equal(r.status, 200, r.txt); ids.push(r.json.id);
    }
    for (const id of ids) assert.equal(await terminar(s.db, id), 'concluido');
    const textos = s.wa.simulated.map((m) => m.text);
    assert.equal(textos.length, 4);
    assert.equal(textos.filter((x) => x.includes('Fone A')).length, 2);
    assert.equal(textos.filter((x) => x.includes('Fone B')).length, 2);
    assert.ok(textos.every((x) => x.includes(LINK_DO_DONO())));
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM envio_resultados WHERE erro IS NOT NULL").get().n, 0);
  } finally { await s.fechar(); }
});


test('CA3: formas reais de endereço da Magalu (slug longo, código numérico, marketplace com "?&seller_id", Magazine Você com categoria) viram o link da loja', () => {
  const casos = [
    ['https://www.magazineluiza.com.br/smartphone-samsung-galaxy-a15-128gb-azul-escuro-4g-4gb-ram-67-cam-tripla-selfie-13mp/p/237456800/te/ga15/',
      'https://www.magazinevoce.com.br/minhaloja/smartphone-samsung-galaxy-a15-128gb-azul-escuro-4g-4gb-ram-67-cam-tripla-selfie-13mp/p/237456800/te/ga15/'],
    ['https://www.magazineluiza.com.br/fone-de-ouvido-bluetooth/p/dg7g6dd4f9/ca/foun/?&seller_id=smartbrasilstore&utm_source=google&utm_medium=cpc',
      'https://www.magazinevoce.com.br/minhaloja/fone-de-ouvido-bluetooth/p/dg7g6dd4f9/ca/foun/?seller_id=smartbrasilstore'],
    ['https://www.magazinevoce.com.br/magazinefulano/fone-bom/p/fg0gk2gb1d/ea/eapi/', 'https://www.magazinevoce.com.br/minhaloja/fone-bom/p/fg0gk2gb1d/ea/eapi/'],
    ['https://m.magazineluiza.com.br/p/237456800/', 'https://www.magazinevoce.com.br/minhaloja/p/237456800/'],
    ['  https://www.magazineluiza.com.br/fone-bom/p/abc123/?utm_source=whatsapp  ', 'https://www.magazinevoce.com.br/minhaloja/fone-bom/p/abc123/'],
  ];
  for (const [entrada, esperado] of casos) assert.equal(montarLinkMagalu(entrada, 'minhaloja'), esperado, entrada.slice(0, 80));
});

test('CA4: Identificar é repetível: três chamadas seguidas dão a mesma resposta (e o link curto não pede a rede de novo)', async () => {
  const s = await subirReal();
  try {
    const respostas = [];
    for (let i = 0; i < 3; i++) respostas.push((await s.post('/api/disparo/identificar', { url: LINK_CURTO, template_id: 1 })).txt);
    assert.equal(new Set(respostas).size, 1);
    assert.equal(s.fetchM.chamadas.length, 1, 'cache do cliente: um GET só');
    const json = JSON.parse(respostas[0]);
    assert.deepEqual([json.pode_disparar, json.outra_loja, json.causa, json.causa_link], [true, true, null, null]);
  } finally { await s.fechar(); }
});

test('CA1: PUT de Conexões da Magalu: campo desconhecido não é gravado, tipo errado é 400 sem eco, vazio apaga e repetir é idempotente', async () => {
  const s = await subirReal({ loja: null });
  try {
    const cfg = () => JSON.parse(s.db.prepare("SELECT config FROM conexoes WHERE plataforma = 'magalu'").get()?.config ?? '{}');
    for (let i = 0; i < 2; i++) {
      const r = await s.put('/api/conexoes/magalu', { campos: { loja: 'minhaloja', outro: 'x', segredo: 'sk-123' } });
      assert.deepEqual([r.status, r.json.estado], [200, 'pronta']);
      assert.deepEqual(cfg(), { loja: 'minhaloja' }, 'campo que não existe no registro nunca é gravado');
    }
    for (const loja of [['abcd'], { a: 'abcd' }, 'ab\u0000cd', 'ＭＩＮＨＡ', 'loja.com.br']) {
      const r = await s.put('/api/conexoes/magalu', { campos: { loja } });
      assert.equal(r.status, 400, JSON.stringify(loja));
      assert.ok(!r.txt.includes('loja.com') && !r.txt.includes('ＭＩＮ'), 'sem eco');
      assert.deepEqual(cfg(), { loja: 'minhaloja' }, 'o recusado não troca o salvo');
    }
    for (const vazio of ['', '   ', null]) {
      await s.put('/api/conexoes/magalu', { campos: { loja: 'minhaloja' } });
      const r = await s.put('/api/conexoes/magalu', { campos: { loja: vazio } });
      assert.deepEqual([r.status, r.json.estado, cfg()], [200, 'falta_configurar', {}], JSON.stringify(vazio));
    }
    assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM log').all()).includes('minhaloja'), 'o nome da loja não vai ao log');
  } finally { await s.fechar(); }
});

test('CA1: o cartão real (public/conexoes.js) com a resposta real do servidor: "Conferir minha loja" leva à loja salva e o selo é Configurada; adulterada no banco não gera link', async () => {
  const s = await subirReal({ loja: 'MinhaLoja-2' });
  try {
    const ctx = {
      console, Number, String, Array, Object, Math, Date, JSON, RegExp, Promise, Error,
      $: () => el(), $$: () => [], esc, q: (c) => `[?${c}]`, REQ: '*', S: {}, aviso() {}, tentar: (f) => f, dataHora: () => '06/11/2026 10:00', mostrarErros: () => false, api: async () => null,
    };
    vm.createContext(ctx);
    vm.runInContext(`${lerArquivo('public', 'conexoes.js')}\n;globalThis.__x = { cartaoConexao, cxMagaluHref, pillConexao };`, ctx);
    const doServidor = async () => (await s.get('/api/conexoes')).json.find((p) => p.id === 'magalu');
    const p = await doServidor();
    assert.equal(ctx.__x.cxMagaluHref(p), 'https://www.magazinevoce.com.br/MinhaLoja-2/');
    assert.deepEqual([...ctx.__x.pillConexao(p.estado, 'magalu')], ['pronta', 'Configurada']);
    const html = ctx.__x.cartaoConexao(p);
    assert.doesNotMatch(html, /Ainda não implementado/);
    assert.doesNotMatch(html, /MinhaLoja-2/, 'o valor só entra pelo DOM, nunca no HTML do cartão');
    // adulterada no banco: o servidor ainda devolve o texto, o painel não monta link
    s.db.prepare("UPDATE conexoes SET config = ? WHERE plataforma = 'magalu'").run(JSON.stringify({ loja: '"><script>alert(1)</script>' }));
    const ruim = await doServidor();
    assert.equal(ctx.__x.cxMagaluHref(ruim), '');
    assert.doesNotMatch(ctx.__x.cartaoConexao(ruim), /<script>alert/);
  } finally { await s.fechar(); }
});

// ====================================================================================== D. envio agendado

/** Grava o envio da Magalu direto (como `criar` gravaria) e o devolve; `quando` agendado e vencido. */
function gravarEnvioMagalu(s, { quando = 'agendado', url = 'https://www.magazineluiza.com.br/fone-bom/p/abc123/audio/fones/?seller_id=magazineluiza', codigo = 'abc123' } = {}) {
  const tpl = s.db.prepare('SELECT created_at FROM templates WHERE id = 1').get().created_at;
  const offer = { key: 'MAGALU:abc123', title: 'Fone Agendado', price: 99, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: null, image: null };
  return Number(s.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at) VALUES ('oferta', ?, ?, ?, 'pendente', ?, ?)`)
    .run(JSON.stringify({ url, loja: 'magalu', codigo, tag_id: null, etiqueta: null, template_id: 1, template_criado_em: tpl, origem: { tipo: 'manual' }, offer }),
      JSON.stringify(['111@g.us', '222@g.us']), quando, Date.now() - 1000, Date.now() - 2000).lastInsertRowid);
}
const erroDo = (db, id) => db.prepare('SELECT erro FROM envio_resultados WHERE envio_id = ?').get(id)?.erro;

test('CA5: agendado com a loja do banco adulterada na hora do envio: erro visível nos dois grupos, nada sai e a loja adulterada não vai ao log', async () => {
  const s = await subirReal();
  try {
    const adulteradas = [{ loja: 'a/../b' }, { loja: 'x' }, { loja: 'duas palavras' }, { loja: ['abcd'] }, { loja: 12345 }, { loja: 'a'.repeat(61) }, { loja: 'ok<script>' }, { loja: 'a?b=c' }, 'lixo-nao-json', null];
    for (const config of adulteradas) {
      s.db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('magalu', ?, '{}', 1) ON CONFLICT(plataforma) DO UPDATE SET config = excluded.config").run(typeof config === 'string' ? config : JSON.stringify(config));
      const id = gravarEnvioMagalu(s);
      await s.scheduler.tick();
      assert.equal(statusDe(s.db, id), 'erro', JSON.stringify(config));
      assert.match(erroDo(s.db, id), /^link de afiliado não gerado: Falta o nome da sua loja de parceiro da Magalu/, JSON.stringify(config));
    }
    assert.equal(s.wa.simulated.length, 0, 'nada saiu');
    const log = JSON.stringify(s.db.prepare('SELECT * FROM log').all());
    for (const x of ['script', 'a/../b', 'duas palavras', 'lixo-nao-json']) assert.ok(!log.includes(x), `log levou "${x}"`);
    // a loja volta ao normal: o mesmo caminho sai (o erro anterior era só da loja)
    await s.salvarLoja(LOJA_DONO);
    const bom = gravarEnvioMagalu(s);
    await s.scheduler.tick();
    assert.equal(statusDe(s.db, bom), 'concluido');
    assert.equal(s.wa.simulated.length, 2);
    assert.ok(s.wa.simulated.every((m) => m.text.includes(LINK_DO_DONO())));
  } finally { await s.fechar(); }
});

test('CA5: payload agendado adulterado (código, endereço, loja de outro parceiro, host de fora): só o endereço de produto gravado vale e a loja é a de Conexões', async () => {
  const s = await subirReal();
  try {
    const ruins = [{ codigo: 'zzz999' }, { codigo: null }, { codigo: '../../x' }, { url: 'https://evil.example/fone-bom/p/abc123/' }, { url: 'javascript:alert(1)' },
      { url: 'https://www.magazineluiza.com.br/busca/fone/' }, { url: `https://www.magazineluiza.com.br.evil.example/p/abc123/` }, { url: 42 }];
    for (const extra of ruins) {
      const id = gravarEnvioMagalu(s, extra);
      await s.scheduler.tick();
      assert.equal(statusDe(s.db, id), 'erro', JSON.stringify(extra));
      assert.match(erroDo(s.db, id), /^link de afiliado não gerado: /, JSON.stringify(extra));
    }
    assert.equal(s.wa.simulated.length, 0);
    // o endereço gravado pode ser o do magazinevoce de outro parceiro: sai com a loja de Conexões
    const id = gravarEnvioMagalu(s, { url: `https://www.magazinevoce.com.br/${LOJA_OUTRO}/fone-bom/p/abc123/audio/fones/?seller_id=magazineluiza&utm_source=x` });
    await s.scheduler.tick();
    assert.equal(statusDe(s.db, id), 'concluido');
    for (const m of s.wa.simulated) { assert.ok(m.text.includes(LINK_DO_DONO()), m.text); assert.ok(!m.text.includes(LOJA_OUTRO) && !m.text.includes('utm_source'), m.text); }
  } finally { await s.fechar(); }
});

test('CA5 (reversão do plano): se a Magalu voltar a `implementada:false`, o agendado já gravado falha visível no preparar e nada sai', async () => {
  const s = await subirReal();
  try {
    let desligada = false;
    // `lojas` injetado: a mesma implementação, com a Magalu "desintegrada" depois de o envio ser gravado
    const lojas = {
      ...lojasPadrao,
      identificar: (u) => { const l = lojasPadrao.identificar(u); return desligada && l?.id === 'magalu' ? { ...l, implementada: false } : l; },
      linkAfiliado: async (id, ...r) => {
        if (desligada && id === 'magalu') throw new LojaNaoConectada({ id: 'magalu', nome: 'Magalu', implementada: false });
        return lojasPadrao.linkAfiliado(id, ...r);
      },
    };
    const envios = createEnvios({ db: s.db, wa: s.wa, links: s.links, ml: mlFalso(), fast: true, dir: s.dir, lojas, magalu: createMagalu({ fetch: s.fetchM }) });
    const antes = gravarEnvioMagalu(s);
    desligada = true;
    const id = gravarEnvioMagalu(s);
    await envios.processarPendentes();
    assert.equal(statusDe(s.db, id), 'erro');
    assert.equal(statusDe(s.db, antes), 'erro', 'os dois já gravados falham: a reversão vale para o que estava na fila');
    assert.match(erroDo(s.db, id), /^link de afiliado não gerado: Magalu identificada, mas ainda não está conectada/);
    assert.equal(s.wa.simulated.length, 0);
    // e criar novo é recusado antes de gravar
    await assert.rejects(envios.criar({ tipo: 'oferta', url: URL_DO_OUTRO, template_id: 1, group_jids: ['111@g.us'], quando: 'agora', ajustes: { title: 'Fone' } }), /não está conectada/);
  } finally { await s.fechar(); }
});

// ====================================================================================== E. Remetente

const NUMERO = '5535999991234';
const PN = `${NUMERO}@s.whatsapp.net`;
const LOJA_SOCIO = 'lojadosocio';
const CURTO_COM_QUERY = `https://magalu.com/AbC123?pid=${LOJA_SOCIO}&af_xp=custom&utm_source=whats`;

function montarRemetente({ loja = LOJA_DONO } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of [['200@g.us', 'Achadinhos Tech'], ['300@g.us', 'Tech Dois']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  db.prepare("INSERT INTO tags (name, created_at) VALUES ('etiquetaA', 1)").run();
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const chamadas = [];
  const fetchM = async (url) => {
    chamadas.push(String(url));
    if (String(url).startsWith('https://magalu.com/AbC123')) return new Response(null, { status: 302, headers: { location: `https://www.magazinevoce.com.br/${LOJA_SOCIO}/fone-bom/p/abc123/audio/fones/?seller_id=magazineluiza&utm_source=socio` } });
    throw new Error('rede não prevista no teste');
  };
  const envios = createEnvios({ db, wa, links, ml: mlFalso(), fast: true, dir, magalu: createMagalu({ fetch: fetchM }) });
  if (loja) db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('magalu', ?, '{}', ?)").run(JSON.stringify({ loja }), Date.now());
  const relogio = { t: Date.now() };
  const rem = createRemetentes({ db, wa, envios, acordar: () => {}, agora: () => relogio.t });
  db.prepare(`INSERT INTO remetentes (nome, jid, lid, enabled, destino_jids, template_id, tag_id, enviar_foto, max_por_hora, dedupe_horas, responder, created_at, updated_at)
    VALUES ('Sócio Pedro', ?, NULL, 1, ?, 1, NULL, 1, 10, 24, 1, 1, 1)`).run(PN, JSON.stringify(['200@g.us', '300@g.us']));
  let seq = 0;
  return {
    db, wa, rem, chamadas, relogio,
    msg: (texto) => rem.receber({ ids: [PN], texto, msgId: `MSG${++seq}`, ts: relogio.t }),
    async rodar() { await rem.processarPendentes(relogio.t); await envios.processarPendentes(relogio.t); await rem.responderPendentes(relogio.t); },
    itens: () => db.prepare('SELECT * FROM remetente_itens ORDER BY id').all().map((x) => ({ ...x })),
    envios: () => db.prepare('SELECT * FROM envios ORDER BY id').all().map((x) => ({ ...x, payload: JSON.parse(x.payload) })),
    nosGrupos: () => wa.simulated.filter((m) => m.jid.endsWith('@g.us')),
    tudo: () => ['log', 'envios', 'envio_resultados'].map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('\n'),
  };
}

test('CA7: link curto magalu.com com query do sócio: sai com a loja do dono, sem a query e sem a loja do sócio no payload, no log, no console nem nos grupos', async (t) => {
  const espias = capturarConsole(t);
  const s = montarRemetente();
  assert.equal(s.msg(`Fone Bom Sem Fio\nPor R$ 79,90\n${CURTO_COM_QUERY}`), 1);
  await s.rodar();
  const [item] = s.itens();
  assert.deepEqual([item.status, item.loja, item.chave], ['enviado', 'magalu', 'MAGALU:abc123']);
  assert.equal(s.nosGrupos().length, 2);
  for (const m of s.nosGrupos()) {
    assert.ok(m.text.includes(LINK_DO_DONO()), m.text);
    for (const x of [LOJA_SOCIO, 'utm_source', 'af_xp', 'pid=', 'magalu.com']) assert.ok(!m.text.includes(x), `o grupo recebeu "${x}": ${m.text}`);
  }
  const [e] = s.envios();
  assert.equal(e.payload.url, 'https://www.magazineluiza.com.br/fone-bom/p/abc123/audio/fones/?seller_id=magazineluiza');
  const resto = [s.tudo(), textoDoConsole(espias)].join('\n');
  for (const x of [LOJA_SOCIO, 'af_xp', 'utm_source']) assert.ok(!resto.includes(x), `vazou "${x}" em payload, log ou console`);
  // o item guarda o curto sem a query (Q1/S1/R3): é ele, sem o rastreio do sócio, que vai à rede
  assert.deepEqual(s.chamadas, ['https://magalu.com/AbC123'], 'só o curto (sem a query) foi pedido, uma vez');
});

test('CA7/LGPD (Q1): a loja de parceiro do sócio não fica em remetente_itens.url nem com link curto com query nem com link de busca da loja dele', async () => {
  const s = montarRemetente();
  s.msg(`Fone Bom Sem Fio\nPor R$ 79,90\n${CURTO_COM_QUERY}`);
  s.msg(`Olha a vitrine https://www.magazinevoce.com.br/${LOJA_SOCIO}/busca/fone/?utm_source=whats`);
  await s.rodar();
  const guardado = JSON.stringify(s.itens().map((i) => [i.url, i.chave, i.motivo]));
  assert.ok(!guardado.includes(LOJA_SOCIO), `guardou a loja do sócio: ${guardado}`);
  assert.ok(!guardado.includes('utm_source'), `guardou o rastreio dele: ${guardado}`);
});

test('CA7: link da loja do sócio que não é produto (vitrine, busca) é descartado link_invalido sem rede, sem payload e sem a loja dele no log, na resposta nem no console', async (t) => {
  const espias = capturarConsole(t);
  const s = montarRemetente();
  s.msg(`Olha a vitrine https://www.magazinevoce.com.br/${LOJA_SOCIO}/busca/fone/`);
  s.msg(`Olha https://www.magazineluiza.com.br/busca/fone/`);
  await s.rodar();
  assert.deepEqual(s.itens().map((i) => [i.status, i.codigo]), [['descartado', 'link_invalido'], ['descartado', 'link_invalido']]);
  assert.deepEqual(s.envios(), []);
  assert.deepEqual(s.chamadas, [], 'nenhuma rede');
  const respostas = s.wa.simulated.filter((m) => !m.jid.endsWith('@g.us')).map((m) => m.text);
  assert.deepEqual(respostas, ['Não reconheci esse link. Mande o link da página do produto.', 'Não reconheci esse link. Mande o link da página do produto.']);
  const resto = [s.tudo(), textoDoConsole(espias), respostas.join('\n')].join('\n');
  assert.ok(!resto.includes(LOJA_SOCIO), 'a loja do sócio vazou');
  assert.doesNotMatch(textoDoConsole(espias), /https?:|magazine/i);
});

test('CA7: sem loja salva, o link da Magalu do sócio vira erro/sem_loja_magalu antes da rede e a frase do cartão chega pelo listar()', async () => {
  const s = montarRemetente({ loja: null });
  s.msg(`Fone Bom Sem Fio\nPor R$ 79,90\n${CURTO_COM_QUERY}`);
  await s.rodar();
  const [item] = s.itens();
  assert.deepEqual([item.status, item.codigo], ['erro', 'sem_loja_magalu']);
  assert.deepEqual(s.chamadas, [], 'barrado antes da rede (o link curto nem é aberto)');
  assert.deepEqual(s.envios(), []);
  assert.equal(s.nosGrupos().length, 0);
});

test('CA7: duas mensagens do mesmo produto (curto com query e longo da loja do sócio) dentro de "horas sem repetir": a segunda é repetida e não sai de novo', async () => {
  const s = montarRemetente();
  s.msg(`Fone Bom Sem Fio\nPor R$ 79,90\n${CURTO_COM_QUERY}`);
  await s.rodar();
  s.msg(`Fone Bom Sem Fio\nPor R$ 79,90\nhttps://www.magazinevoce.com.br/${LOJA_SOCIO}/fone-bom/p/ABC123/audio/fones/?seller_id=magazineluiza`);
  await s.rodar();
  assert.deepEqual(s.itens().map((i) => [i.status, i.codigo]), [['enviado', null], ['duplicado', 'repetida']]);
  assert.equal(s.envios().length, 1);
  assert.equal(s.nosGrupos().length, 2);
});

// ====================================================================================== F. regressões e documentação

test('CA8: Amazon, Shopee, Mercado Livre e Facebook seguem como eram no Identificar real; a Magalu não muda o que as outras respondem', async () => {
  const s = await subirReal();
  try {
    const facebook = await s.post('/api/disparo/identificar', { url: 'https://www.facebook.com/marketplace/item/123456789/', template_id: 1 });
    assert.equal(facebook.status, 200);
    assert.deepEqual(facebook.json.loja, { id: 'facebook', nome: 'Facebook', implementada: false });
    assert.equal(facebook.json.motivo, 'Facebook identificada, mas ainda não está conectada. Configure em Conexões.');
    assert.deepEqual([facebook.json.produto, facebook.json.texto], [null, null]);
    const envioFb = await s.post('/api/envios', { tipo: 'oferta', url: 'https://www.facebook.com/marketplace/item/123456789/', template_id: 1, group_jids: ['111@g.us'], ajustes: { title: 'x' } });
    assert.equal(envioFb.status, 400);
    assert.match(envioFb.json.erro, /Facebook identificada, mas ainda não está conectada/);

    const ml = await s.post('/api/disparo/identificar', { url: 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM', template_id: 1, tag_id: 1 });
    assert.deepEqual([ml.json.loja.id, ml.json.editavel, ml.json.produto.title, ml.json.etiqueta?.name, 'causa_link' in ml.json, 'outra_loja' in ml.json], ['mercadolivre', false, 'Fone Bom', 'etiquetaA', false, false]);

    const amazon = await s.post('/api/disparo/identificar', { url: 'https://www.amazon.com.br/dp/B0ABC12345', template_id: 1 });
    assert.equal(amazon.status, 200, amazon.txt);
    assert.equal(amazon.json.loja.id, 'amazon');
    assert.equal(amazon.json.causa, 'sem_tag', 'sem a tag de Conexões, como antes');
    assert.equal('outra_loja' in amazon.json, false);

    const shopee = await s.post('/api/disparo/identificar', { url: 'https://shopee.com.br/Fone-Bom-i.52377417.6309028319', template_id: 1 });
    assert.equal(shopee.json.loja.id, 'shopee');
    assert.equal(shopee.json.causa_link, 'sem_id', 'sem o ID de afiliado, como antes');
    assert.equal('outra_loja' in shopee.json, false);
    assert.equal('loja_parceiro' in shopee.json, false);
    assert.equal(acessosRede, 0);
  } finally { await s.fechar(); }
});

test('CA8: "Disparar mensagem" com prévia de link da Magalu (curto ou longo) é recusado com a frase de sempre, sem rede e sem gravar', async () => {
  const s = await subirReal();
  try {
    for (const previa_url of ['https://www.magazineluiza.com.br/fone/p/abc123/', LINK_CURTO, URL_DO_OUTRO, 'https://magalu.com/x']) {
      const r = await s.post('/api/envios', { tipo: 'mensagem', texto: 'oi', imagem: 'previa', previa_url, group_jids: ['111@g.us'] });
      assert.equal(r.status, 400, previa_url);
      assert.equal(r.json.erro, 'A prévia do link só funciona com links do Mercado Livre.', previa_url);
      assert.ok(!r.txt.includes('magazine') && !r.txt.includes('maga.lu'), 'sem eco do link');
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0);
    assert.deepEqual(s.fetchM.chamadas, []);
  } finally { await s.fechar(); }
});

test('CA8: a Magalu continua fora de rastreio, ganhos e importador: loja=magalu é recusada (400) sem eco', async () => {
  const s = await subirReal();
  try {
    for (const caminho of ['/api/ganhos?loja=magalu', '/api/ganhos/importar?loja=magalu']) {
      const r = caminho.includes('importar')
        ? await req(s.port, caminho, { method: 'POST', headers: { ...s.headers, 'content-type': 'text/csv', 'content-length': 0 } })
        : await s.get(caminho);
      assert.ok([400, 401, 403, 415].includes(r.status), `${caminho}: ${r.status}`);
      assert.ok(!r.txt.includes('magalu'), `eco em ${caminho}`);
    }
    const ganhos = await s.get('/api/ganhos?loja=magalu');
    assert.equal(ganhos.status, 400, ganhos.txt);
  } finally { await s.fechar(); }
});

test('CA8: o envio da Magalu não grava rastreio por grupo nem usa a extensão (links continua sem acesso)', async () => {
  const s = await subirReal();
  try {
    s.links.modo = () => 'extension'; // sem a extensão conectada: a Magalu não depende dela
    const r = await s.post('/api/envios', { tipo: 'oferta', url: URL_DO_OUTRO, template_id: 1, group_jids: ['111@g.us', '222@g.us'], quando: 'agora', ajustes: { title: 'Fone Bom', price: '10' } });
    assert.equal(r.status, 200, r.txt);
    assert.equal(await terminar(s.db, r.json.id), 'concluido');
    for (const tabela of ['rastreio_envios', 'rastreio_codigos']) assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0, tabela);
    assert.equal(s.wa.simulated.length, 2);
  } finally { await s.fechar(); }
});

test('CA10: README, ajuda e Docs não dizem mais que a Magalu não envia nem que está "ainda não implementada"', () => {
  const arquivos = ['README.md', 'public/ajuda.js', 'public/docs.js', ...fs.readdirSync(path.join(RAIZ, 'public', 'docs')).filter((f) => f.endsWith('.js')).map((f) => `public/docs/${f}`)];
  const velhos = [
    /Magalu[^.\n]{0,80}(ainda não (está )?implementada|não está implementada|não envia|ainda não envia|não funciona)/i,
    /(ainda não implementada|não implementada)[^.\n]{0,60}Magalu/i,
    /Magalu (e|ou) (o )?Facebook[^.\n]{0,60}(ainda não|não)/i,
    /Facebook (e|ou) (a )?Magalu[^.\n]{0,60}(ainda não|não)/i,
    /Magalu e Facebook/,
    /Mercado Livre, Amazon e Shopee (enviam|funcionam)/,
  ];
  for (const arq of arquivos) {
    const texto = lerArquivo(...arq.split('/'));
    for (const re of velhos) assert.doesNotMatch(texto, re, `${arq} ainda tem texto antigo: ${texto.match(re)?.[0]}`);
  }
});

test('CA10: o painel não mostra "Ainda não implementado" para a Magalu: o cartão usa o ramo próprio (sem aviso genérico)', () => {
  const fonte = lerArquivo('public', 'conexoes.js');
  assert.match(fonte, /magalu/i);
  assert.equal(lojasPadrao.PLATAFORMAS.magalu.implementada, true);
  assert.doesNotMatch(lojasPadrao.PLATAFORMAS.magalu.descricao, /ainda não|não implementad/i);
});

test('Q2: a dica da etiqueta do Remetente (cadastro) cita só Amazon e Shopee; a Magalu também usa a configuração de Conexões', () => {
  const fonte = lerArquivo('public', 'remetentes.js');
  const dica = fonte.match(/etiquetaDica: '([^']*)'/)?.[1] ?? '';
  assert.match(dica, /Magalu/, `etiquetaDica: ${dica}`);
});

test('nenhum teste deste arquivo acessou a rede', () => {
  assert.equal(acessosRede, 0);
});
