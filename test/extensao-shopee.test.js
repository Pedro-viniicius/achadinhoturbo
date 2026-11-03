// Extensão do Chrome, pedido `link_shopee` (etapa 3 do plano integracao-shopee): o link de afiliado da Shopee sai
// do "Link personalizado" do portal, com a sessão do dono, e só `link` (s.shopee.com.br) e `longo` voltam ao painel.
// Duas partes: (1) as funções puras do extension/background.js, extraídas por marcadores e rodadas num `vm`;
// (2) o background.js inteiro num `vm` com `chrome.*` e `fetch` falsos (painel e portal), para o laço do pedido.
// Nenhuma rede: o portal e o painel são simulados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTE = fs.readFileSync(path.join(RAIZ, 'extension', 'background.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(RAIZ, 'extension', 'manifest.json'), 'utf8'));

const INI = FONTE.indexOf('// ---- Shopee: funções puras (início) ----');
const FIM = FONTE.indexOf('// ---- Shopee: funções puras (fim) ----');
assert.ok(INI > 0 && FIM > INI, 'não achei os marcadores do trecho da Shopee em extension/background.js');
const TRECHO = FONTE.slice(INI, FIM);

const PORTAL = 'https://affiliate.shopee.com.br';
const PRODUTO = 'https://shopee.com.br/Apple-Iphone-11-128GB-Local-Set-i.52377417.6309028319';
const CSRF = 'csrf-segredo-0123456789';
const SEM_SESSAO = /não há sessão de afiliado da Shopee neste Chrome/;
const plano = (v) => JSON.parse(JSON.stringify(v)); // objetos do vm têm outro protótipo

function puras(extra = {}) {
  const ctx = vm.createContext({ URL, AbortSignal, ...extra });
  vm.runInContext(`${TRECHO};globalThis.__x = { urlProdutoShopee, corpoLinkShopee, longoShopee, interpretarShopee, chamarPortalShopee, SHOPEE_TIPO_PROGRAMA, SHOPEE_SEM_SESSAO, SHOPEE_FORMATO };`, ctx);
  return ctx.__x;
}
const X = puras();

const respostaGql = (item) => JSON.stringify({ data: { batchCustomLink: [item] } });
const ITEM_OK = { shortLink: 'https://s.shopee.com.br/9fMB7wrS3r', longLink: 'https://shopee.com.br/x-i.1.2?utm_source=an_98765432101&utm_medium=affiliates', failCode: 0 };

// ---------------- funções puras ----------------

test('urlProdutoShopee: só o endereço de produto em https://shopee.com.br/, sem parâmetros', () => {
  assert.equal(X.urlProdutoShopee(PRODUTO), PRODUTO);
  assert.equal(X.urlProdutoShopee('https://shopee.com.br/product/52377417/6309028319'), 'https://shopee.com.br/product/52377417/6309028319');
  for (const ruim of [
    'http://shopee.com.br/x-i.1.2', 'https://s.shopee.com.br/abc', 'https://affiliate.shopee.com.br/x',
    'https://shopee.com.br.evil.com/x', 'https://evil.com/shopee.com.br/x', 'https://shopee.com.br:8443/x',
    'https://u:p@shopee.com.br/x', 'https://shopee.com.br/x?utm_source=an_1', 'https://shopee.com.br/x#y',
    'https://SHOPEE.com.br/x', 'https://shopee.com.br/a b', 'https:\\\\shopee.com.br\\x', 'javascript:alert(1)',
    `https://shopee.com.br/${'a'.repeat(2048)}`, '', null, undefined, 42, { href: PRODUTO },
  ]) assert.equal(X.urlProdutoShopee(ruim), null, String(ruim).slice(0, 60));
});

test('corpoLinkShopee: o mesmo corpo do Link personalizado, sem Sub_ids, com a URL escapada pelo JSON', () => {
  assert.deepEqual(JSON.parse(X.corpoLinkShopee(PRODUTO)), {
    operationName: 'batchGetCustomLink',
    query: 'query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){ batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){ shortLink longLink failCode } }',
    variables: { linkParams: [{ originalLink: PRODUTO }], sourceCaller: 'CUSTOM_LINK_CALLER' },
  });
  const estranho = 'https://shopee.com.br/a"}],"x":{"y":"z';
  assert.equal(JSON.parse(X.corpoLinkShopee(estranho)).variables.linkParams[0].originalLink, estranho);
});

test('interpretarShopee: link curto e longLink; failCode 0, "0" ou ausente valem', () => {
  for (const failCode of [0, '0', undefined, null]) {
    const v = plano(X.interpretarShopee({ status: 200, texto: respostaGql({ ...ITEM_OK, failCode }) }));
    assert.deepEqual(v, { link: ITEM_OK.shortLink, longo: ITEM_OK.longLink }, String(failCode));
  }
  // longLink fora da Shopee (ou ausente) é descartado sem recusar o link curto
  for (const longLink of ['https://evil.com/?utm_source=an_1', 'http://shopee.com.br/x', 'https://shopee.com.br:444/x', undefined, 7]) {
    assert.deepEqual(plano(X.interpretarShopee({ status: 200, texto: respostaGql({ ...ITEM_OK, longLink }) })), { link: ITEM_OK.shortLink, longo: null });
  }
});

test('interpretarShopee: failCode diferente de 0 vira erro com o código', () => {
  assert.equal(X.interpretarShopee({ status: 200, texto: respostaGql({ shortLink: '', longLink: '', failCode: 3 }) }).erro, 'a Shopee recusou o link (código 3)');
  assert.equal(X.interpretarShopee({ status: 200, texto: respostaGql({ ...ITEM_OK, failCode: '17' }) }).erro, 'a Shopee recusou o link (código 17)');
  // código que não é número: sem eco do valor
  assert.equal(X.interpretarShopee({ status: 200, texto: respostaGql({ ...ITEM_OK, failCode: '<script>' }) }).erro, 'a Shopee recusou o link');
});

test('interpretarShopee: resposta fora do formato vira erro genérico, sem nada do corpo', () => {
  const SEGREDO = 'texto-do-portal-que-nao-pode-vazar';
  for (const texto of [
    `<html>${SEGREDO}</html>`, '', 'null', '[]', JSON.stringify({ data: null, errors: [{ message: SEGREDO }] }),
    JSON.stringify({ data: { batchCustomLink: [] } }), JSON.stringify({ data: { batchCustomLink: {} } }),
    respostaGql({ ...ITEM_OK, shortLink: 'https://meli.la/abc123' }), respostaGql({ ...ITEM_OK, shortLink: 'http://s.shopee.com.br/abc' }),
    respostaGql({ ...ITEM_OK, shortLink: 'https://s.shopee.com.br.evil.com/abc' }), respostaGql({ ...ITEM_OK, shortLink: `https://s.shopee.com.br/${SEGREDO}?x=1` }),
    respostaGql({ ...ITEM_OK, shortLink: undefined }),
  ]) {
    const v = X.interpretarShopee({ status: 200, texto });
    assert.equal(v.erro, X.SHOPEE_FORMATO, texto.slice(0, 80));
    assert.ok(!JSON.stringify(v).includes(SEGREDO));
  }
  const http = X.interpretarShopee({ status: 500, texto: `{"message":"${SEGREDO}"}` });
  assert.equal(http.erro, 'o portal de afiliados da Shopee respondeu HTTP 500');
  for (const res of [{ status: 0 }, null, undefined, 'x']) {
    assert.equal(X.interpretarShopee(res).erro, 'não consegui falar com o portal de afiliados da Shopee');
  }
});

test('interpretarShopee: sessão ausente ou vencida pede recarregar (sem virar erro)', () => {
  for (const res of [
    { semSessao: true }, { status: 401, texto: '' }, { status: 403, texto: 'x' },
    { status: 200, texto: JSON.stringify({ data: null, errors: [{ message: 'x', extensions: { code: 'UNAUTHENTICATED' } }] }) },
    { status: 200, texto: JSON.stringify({ errors: [{ message: 'User not logged in' }] }) },
    { status: 400, texto: JSON.stringify({ errors: [{ extensions: { code: 401 } }] }) },
    { status: 200, texto: JSON.stringify({ code: 'NOT_LOGIN' }) },
  ]) assert.deepEqual(plano(X.interpretarShopee(res)), { semSessao: true }, JSON.stringify(res));
});

// ---------------- o fetch que roda dentro da aba do portal ----------------

function portalFalso(op = {}) {
  const pedidos = [];
  const fetch = async (url, init = {}) => {
    pedidos.push({ url, ...init, headers: { ...(init.headers || {}) } });
    if (op.cair) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    if (u.origin !== PORTAL) throw new Error(`fetch fora do portal: ${url}`);
    if (u.pathname === '/api/v3/config/website') {
      if (op.config) return op.config();
      if (op.logado === false) return new Response('{"code":401}', { status: 401 });
      const headers = op.csrfNoCorpo ? {} : { 'csrf-token': CSRF };
      return new Response(JSON.stringify({ data: op.csrfNoCorpo ? { csrf_token: CSRF } : {} }), { status: 200, headers });
    }
    if (u.pathname === '/api/v3/gql' && u.search === '?q=batchCustomLink' && init.method === 'POST') {
      if (op.gql) return op.gql();
      return new Response(respostaGql(ITEM_OK), { status: 200, headers: { 'csrf-token': 'outro' } });
    }
    return new Response('', { status: 404 });
  };
  return { fetch, pedidos };
}

test('chamarPortalShopee: lê o csrf-token da config e manda CSRF-token no POST, com a sessão e sem seguir redirecionamento', async () => {
  const p = portalFalso();
  const f = puras({ fetch: p.fetch, location: new URL(`${PORTAL}/offer/custom_link`) });
  const corpo = f.corpoLinkShopee(PRODUTO);
  const res = plano(await f.chamarPortalShopee(corpo, f.SHOPEE_TIPO_PROGRAMA));
  assert.deepEqual(res, { status: 200, texto: respostaGql(ITEM_OK) });
  assert.equal(p.pedidos.length, 2);
  const [cfg, gql] = p.pedidos;
  assert.equal(cfg.url, `${PORTAL}/api/v3/config/website`);
  assert.equal(cfg.method, undefined); // GET
  assert.equal(cfg.credentials, 'include');
  assert.equal(cfg.redirect, 'manual');
  assert.equal(gql.url, `${PORTAL}/api/v3/gql?q=batchCustomLink`);
  assert.equal(gql.method, 'POST');
  assert.equal(gql.credentials, 'include');
  assert.equal(gql.redirect, 'manual');
  assert.equal(gql.body, corpo);
  assert.equal(gql.headers['content-type'], 'application/json');
  assert.equal(gql.headers['csrf-token'], CSRF);
  // o valor do programa ainda não foi extraído: vazio = o cabeçalho não vai
  assert.equal(f.SHOPEE_TIPO_PROGRAMA, '');
  assert.ok(!('affiliate-program-type' in gql.headers) && !('affiliate-program-type' in cfg.headers));
  // o token anti-CSRF não sai da aba
  assert.ok(!JSON.stringify(res).includes(CSRF));
});

test('chamarPortalShopee: com o tipo de programa preenchido, o cabeçalho vai nas duas chamadas', async () => {
  const p = portalFalso();
  const f = puras({ fetch: p.fetch, location: new URL(`${PORTAL}/offer/custom_link`) });
  await f.chamarPortalShopee(f.corpoLinkShopee(PRODUTO), 'tipo-x');
  assert.deepEqual(p.pedidos.map((r) => r.headers['affiliate-program-type']), ['tipo-x', 'tipo-x']);
});

test('chamarPortalShopee: sem o cabeçalho csrf-token, usa o csrf_token da configuração', async () => {
  const p = portalFalso({ csrfNoCorpo: true });
  const f = puras({ fetch: p.fetch, location: new URL(`${PORTAL}/dashboard`) });
  assert.equal((await f.chamarPortalShopee(f.corpoLinkShopee(PRODUTO), '')).status, 200);
  assert.equal(p.pedidos[1].headers['csrf-token'], CSRF);
});

test('chamarPortalShopee: não logado, redirecionado, fora do portal, config com erro e rede caída', async () => {
  const loc = new URL(`${PORTAL}/offer/custom_link`);
  const corpo = X.corpoLinkShopee(PRODUTO);
  // config 401: sessão, e o POST nem sai
  let p = portalFalso({ logado: false });
  assert.deepEqual(plano(await puras({ fetch: p.fetch, location: loc }).chamarPortalShopee(corpo, '')), { semSessao: true });
  assert.equal(p.pedidos.length, 1);
  // a API mandou para o login (redirect:'manual' → opaqueredirect)
  p = portalFalso({ config: () => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() }) });
  assert.deepEqual(plano(await puras({ fetch: p.fetch, location: loc }).chamarPortalShopee(corpo, '')), { semSessao: true });
  // POST 403
  p = portalFalso({ gql: () => new Response('', { status: 403 }) });
  assert.deepEqual(plano(await puras({ fetch: p.fetch, location: loc }).chamarPortalShopee(corpo, '')), { semSessao: true });
  // aba fora do portal: nenhuma chamada
  p = portalFalso();
  assert.deepEqual(plano(await puras({ fetch: p.fetch, location: new URL('https://shopee.com.br/buyer/login') }).chamarPortalShopee(corpo, '')), { semSessao: true });
  assert.equal(p.pedidos.length, 0);
  // config 500: devolve o status e não tenta o POST sem token
  p = portalFalso({ config: () => new Response('', { status: 500 }) });
  assert.deepEqual(plano(await puras({ fetch: p.fetch, location: loc }).chamarPortalShopee(corpo, '')), { status: 500, texto: '' });
  assert.equal(p.pedidos.length, 1);
  // rede caída
  p = portalFalso({ cair: true });
  assert.deepEqual(plano(await puras({ fetch: p.fetch, location: loc }).chamarPortalShopee(corpo, '')), { status: 0 });
});

// ---------------- o background.js inteiro, com chrome.* falso ----------------

/**
 * Sobe o background.js num vm. `jobs` = pedidos que o painel entrega no long-poll; quando acabam, o painel "fecha"
 * (o fetch do poll falha) e o laço termina. `portal` = opções do portalFalso. `aposLogin`: a Shopee manda a aba
 * deslogada para shopee.com.br (fora da permissão: o executeScript falha).
 */
async function rodarExtensao({ jobs, portal = {}, aposLogin = false, abas = [] }) {
  const p = portalFalso(portal);
  const resultados = []; const consoleUsado = []; const injecoes = []; const navegacoes = []; const criadas = [];
  const armazenado = { conf: { servidor: 'http://127.0.0.1:3737', token: 'tok-painel' }, st: {} };
  const ouvintes = new Set();
  const tabs = new Map(abas.map((t) => [t.id, { ...t }]));
  let seqAba = 100;
  let terminou; const fim = new Promise((ok) => { terminou = ok; });
  const fila = [...jobs];
  const carregar = (aba, url) => {
    aba.url = aposLogin && url.startsWith(PORTAL) ? 'https://shopee.com.br/buyer/login?next=x' : url;
    aba.status = 'complete';
    setTimeout(() => { for (const f of [...ouvintes]) f(aba.id, { status: 'complete' }); }, 0);
  };
  const chrome = {
    storage: {
      local: {
        get: async (k) => Object.fromEntries([k].flat().filter((c) => c in armazenado).map((c) => [c, structuredClone(armazenado[c])])),
        set: async (o) => { Object.assign(armazenado, structuredClone(o)); },
      },
      onChanged: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    permissions: { remove: async () => true },
    tabs: {
      onUpdated: { addListener: (f) => ouvintes.add(f), removeListener: (f) => ouvintes.delete(f) },
      // sem a permissão "tabs", só casa (e só mostra a url) o que está nos host_permissions
      query: async ({ url }) => [...tabs.values()].filter((t) => t.url?.startsWith(url.replace(/\*$/, ''))).map((t) => ({ ...t })),
      get: async (id) => { if (!tabs.has(id)) throw new Error('No tab'); return { id }; },
      create: async ({ url, active, pinned }) => {
        const aba = { id: ++seqAba, active, pinned }; tabs.set(aba.id, aba); criadas.push({ url, active, pinned }); carregar(aba, url); return { id: aba.id };
      },
      update: async (id, { url }) => { const aba = tabs.get(id); if (!aba) throw new Error('No tab'); navegacoes.push(url); carregar(aba, url); return { id }; },
    },
    scripting: {
      executeScript: async ({ target, world, func, args }) => {
        const aba = tabs.get(target.tabId);
        if (!aba) throw new Error('No tab with id');
        injecoes.push({ world, args });
        if (!aba.url.startsWith(PORTAL)) throw new Error('Cannot access contents of the page');
        ctx.location = new URL(aba.url);
        return [{ result: await func(...args) }];
      },
    },
  };
  const fetchGeral = async (url, init = {}) => {
    if (String(url).startsWith(PORTAL)) return p.fetch(url, init);
    const u = new URL(url);
    assert.equal(u.origin, 'http://127.0.0.1:3737', `fetch inesperado: ${url}`);
    assert.equal(init.headers['x-token'], 'tok-painel');
    if (u.pathname === '/api/ext/poll') {
      if (!fila.length) { setTimeout(terminou, 0); throw new TypeError('Failed to fetch'); }
      return new Response(JSON.stringify({ job: fila.shift() }), { status: 200 });
    }
    if (u.pathname === '/api/ext/result') { resultados.push(JSON.parse(init.body)); return new Response('{}'); }
    throw new Error(`rota inesperada: ${url}`);
  };
  const espiao = new Proxy({}, { get: (_, nome) => (...a) => consoleUsado.push([nome, ...a]) });
  const ctx = vm.createContext({
    chrome, fetch: fetchGeral, URL, Response, Headers, AbortSignal, structuredClone, console: espiao,
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; }, clearTimeout,
  });
  vm.runInContext(FONTE, ctx, { filename: 'background.js' });
  await fim;
  await new Promise((ok) => setTimeout(ok, 5));
  return { resultados, consoleUsado, injecoes, navegacoes, criadas, pedidosPortal: p.pedidos, armazenado };
}

test('extensão: link_shopee logado devolve só { id, ok, link, longo } e abre a aba do Link personalizado em segundo plano', async () => {
  const r = await rodarExtensao({ jobs: [{ id: 7, type: 'link_shopee', url: PRODUTO }] });
  assert.deepEqual(r.resultados, [{ id: 7, ok: true, link: ITEM_OK.shortLink, longo: ITEM_OK.longLink }]);
  assert.deepEqual(r.criadas, [{ url: `${PORTAL}/offer/custom_link`, active: false, pinned: true }]);
  assert.equal(r.injecoes.length, 1);
  assert.equal(r.injecoes[0].world, 'MAIN');
  assert.equal(JSON.parse(r.injecoes[0].args[0]).variables.linkParams[0].originalLink, PRODUTO);
  assert.equal(r.pedidosPortal.at(-1).headers['csrf-token'], CSRF);
  assert.deepEqual(r.consoleUsado, []);
  assert.ok(!JSON.stringify(r.resultados).includes(CSRF) && !JSON.stringify(r.armazenado).includes(CSRF));
});

test('extensão: usa a aba do portal que já estiver aberta', async () => {
  const r = await rodarExtensao({
    jobs: [{ id: 1, type: 'link_shopee', url: PRODUTO }],
    abas: [{ id: 5, url: `${PORTAL}/dashboard`, status: 'complete' }, { id: 6, url: `${PORTAL}/offer/custom_link`, status: 'complete' }],
  });
  assert.equal(r.resultados[0].ok, true);
  assert.deepEqual(r.criadas, []);
});

test('extensão: deslogado, recarrega a aba uma vez e devolve a mensagem de sessão', async () => {
  const r = await rodarExtensao({ jobs: [{ id: 2, type: 'link_shopee', url: PRODUTO }], portal: { logado: false } });
  assert.equal(r.resultados.length, 1);
  assert.equal(r.resultados[0].ok, false);
  assert.match(r.resultados[0].error, SEM_SESSAO);
  assert.deepEqual(Object.keys(r.resultados[0]).sort(), ['error', 'id', 'ok']);
  assert.equal(r.injecoes.length, 2);
  assert.deepEqual(r.navegacoes, [`${PORTAL}/offer/custom_link`]);
  assert.ok(r.pedidosPortal.every((q) => q.method !== 'POST'), 'sem sessão, o POST não sai');
  assert.match(r.armazenado.st.ultimoErro, SEM_SESSAO);
});

test('extensão: a Shopee leva a aba ao login (fora da permissão): mensagem de sessão, sem empilhar abas', async () => {
  const r = await rodarExtensao({
    jobs: [{ id: 3, type: 'link_shopee', url: PRODUTO }, { id: 4, type: 'link_shopee', url: PRODUTO }], aposLogin: true,
  });
  assert.deepEqual(r.resultados.map((x) => [x.id, x.ok]), [[3, false], [4, false]]);
  for (const x of r.resultados) assert.match(x.error, SEM_SESSAO);
  assert.equal(r.criadas.length, 1, 'a segunda vez reaproveita a aba que a extensão abriu');
  assert.equal(r.pedidosPortal.length, 0);
});

test('extensão: failCode e resposta fora do formato voltam como erro, sem o corpo da resposta', async () => {
  let r = await rodarExtensao({
    jobs: [{ id: 8, type: 'link_shopee', url: PRODUTO }],
    portal: { gql: () => new Response(respostaGql({ shortLink: '', longLink: '', failCode: 5 }), { status: 200 }) },
  });
  assert.deepEqual(r.resultados, [{ id: 8, ok: false, error: 'a Shopee recusou o link (código 5)' }]);
  r = await rodarExtensao({
    jobs: [{ id: 9, type: 'link_shopee', url: PRODUTO }],
    portal: { gql: () => new Response(`{"data":{"x":"${CSRF}"}}`, { status: 200 }) },
  });
  assert.deepEqual(r.resultados, [{ id: 9, ok: false, error: 'o portal de afiliados da Shopee respondeu num formato inesperado' }]);
  assert.deepEqual(r.consoleUsado, []);
});

test('extensão: job com url fora de https://shopee.com.br/ é recusado sem tocar no portal', async () => {
  const r = await rodarExtensao({
    jobs: [
      { id: 10, type: 'link_shopee', url: 'https://evil.com/x' },
      { id: 11, type: 'link_shopee', url: 'https://shopee.com.br/x?utm_source=an_1' },
      { id: 12, type: 'link_shopee' },
    ],
  });
  assert.deepEqual(r.resultados.map((x) => [x.id, x.ok, x.error]), [
    [10, false, 'endereço de produto da Shopee recusado pela extensão'],
    [11, false, 'endereço de produto da Shopee recusado pela extensão'],
    [12, false, 'endereço de produto da Shopee recusado pela extensão'],
  ]);
  assert.equal(r.injecoes.length, 0);
  assert.deepEqual(r.criadas, []);
  assert.equal(r.pedidosPortal.length, 0);
});

test('manifest: permissão nova só para affiliate.shopee.com.br e versão 1.3.0', () => {
  assert.equal(MANIFEST.version, '1.3.0');
  assert.deepEqual(MANIFEST.permissions, ['storage', 'alarms', 'scripting']);
  assert.deepEqual(MANIFEST.host_permissions, ['https://*.mercadolivre.com.br/*', 'https://affiliate.shopee.com.br/*', 'http://127.0.0.1/*', 'http://localhost/*']);
  assert.deepEqual(MANIFEST.optional_host_permissions, ['https://*/*']);
});

test('background.js não escreve no console', () => {
  assert.doesNotMatch(FONTE, /\bconsole\.[A-Za-z]/);
});
