// Testes de src/shopee.js (plano integracao-shopee, etapa 1; CA1, CA2, CA4, CA6, CA7 e CA8).
// Tudo com fetch injetado (fetchFalso): o fetch global fica bloqueado no arquivo inteiro e o último teste
// prova que ele nunca foi chamado.
import test from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  extrairIds, afiliadoDoLongLink, ofertaDoNo, createShopee, ErroShopee, LinkShopeeNaoResolvido,
  HOSTS_SHOPEE, IMAGEM_SHOPEE, LINK_SHOPEE, URL_API, MENSAGENS_SHOPEE, FRASES_TESTE_SHOPEE, RE_ID_AFILIADO,
} from '../src/shopee.js';

// ------------------------------------------------------------------------------------------- rede bloqueada
const fetchOriginal = globalThis.fetch;
let chamadasGlobais = 0;
test.before(() => { globalThis.fetch = async () => { chamadasGlobais++; throw new Error('rede proibida no teste'); }; });
test.after(() => { globalThis.fetch = fetchOriginal; });

// ------------------------------------------------------------------------------------------------ dados
const APP_ID = '123456789';
const CHAVE = 'Senha-Api-SECRETA-q1w2e3';
const ID_AFILIADO = '98765432101';
const SHOP = '52377417';
const ITEM = '6309028319';
const URL_PRODUTO = `https://shopee.com.br/Apple-Iphone-11-128GB-Local-Set-i.${SHOP}.${ITEM}`;
const CURTO = 'https://s.shopee.com.br/9fMB7wrS3r';
const IMG = 'https://down-br.img.susercontent.com/file/br-11134207-7r98o-abc123';
const T0 = 1_700_000_000_500; // ms; o timestamp da assinatura é em segundos (1700000000)

function json(status, corpo, headers = {}) {
  return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const redirecionar = (status, location) => new Response(null, { status, headers: location ? { location } : {} });

/** fetch falso: guarda { url, init } de cada chamada e responde pelo handler. */
function fetchFalso(handler) {
  const chamadas = [];
  const f = async (url, init = {}) => { chamadas.push({ url: String(url), init }); return handler(String(url), init, chamadas.length); };
  f.chamadas = chamadas;
  return f;
}

function relogio(inicio = T0) {
  const r = { t: inicio };
  r.agora = () => r.t;
  return r;
}

const conexao = (extra = {}) => ({ id_afiliado: ID_AFILIADO, app_id: APP_ID, chave: CHAVE, ...extra });

function noApi(extra = {}) {
  return {
    itemId: Number(ITEM), productName: '  Apple iPhone 11\n128GB   Local Set ', priceMin: '1299.90', priceMax: '1499.00',
    priceDiscountRate: 15, sales: 1234, ratingStar: '4.83', imageUrl: IMG, shopName: 'Loja Oficial', ...extra,
  };
}

/** Handler da API: devolve o nó pedido em productOfferV2 e um shortLink em generateShortLink. */
function apiOk({ nos = null, link = CURTO } = {}) {
  return (url, init) => {
    assert.equal(url, URL_API);
    const { query } = JSON.parse(init.body);
    if (query.startsWith('mutation')) return json(200, { data: { generateShortLink: { shortLink: link } } });
    return json(200, { data: { productOfferV2: { nodes: nos ?? [noApi()], pageInfo: { page: 1, limit: 1, hasNextPage: false } } } });
  };
}
const erroApi = (code, status = 200) => () => json(status, { errors: [{ message: `erro ${code} com ${CHAVE}`, extensions: { code, message: 'x' } }], data: null });

const capturarErro = async (fn) => { try { await fn(); } catch (e) { return e; } assert.fail('deveria ter lançado'); };

// ------------------------------------------------------------------------------------------ extrairIds
test('shopee: extrairIds lê os formatos de produto, com e sem parâmetros, e devolve o endereço sem query (CA1)', () => {
  const slug = `/Apple-Iphone-11-128GB-Local-Set-i.${SHOP}.${ITEM}`;
  const casos = [
    [URL_PRODUTO, URL_PRODUTO],
    [`${URL_PRODUTO}?sp_atk=abc&xptdk=def&utm_source=an_999`, URL_PRODUTO],
    [`${URL_PRODUTO}#detalhes`, URL_PRODUTO],
    [`${URL_PRODUTO}/`, `${URL_PRODUTO}/`],
    [`http://shopee.com.br${slug}`, URL_PRODUTO],
    [`HTTPS://SHOPEE.COM.BR${slug}`, URL_PRODUTO],
    [`shopee.com.br${slug}?x=1`, URL_PRODUTO],
    [`  ${URL_PRODUTO}  `, URL_PRODUTO],
    [`https://www.shopee.com.br${slug}`, URL_PRODUTO],
    [`https://shopee.com.br/product/${SHOP}/${ITEM}`, `https://shopee.com.br/product/${SHOP}/${ITEM}`],
    [`https://shopee.com.br/product/${SHOP}/${ITEM}/?smtt=0.0.9`, `https://shopee.com.br/product/${SHOP}/${ITEM}/`],
    [`https://shopee.com.br/universal-link/product/${SHOP}/${ITEM}?deep_and_deferred=1`, `https://shopee.com.br/universal-link/product/${SHOP}/${ITEM}`],
  ];
  for (const [url, urlProduto] of casos) {
    assert.deepEqual(extrairIds(url), { shopId: SHOP, itemId: ITEM, urlProduto }, url);
  }
  // zeros à esquerda saem dos ids (GraphQL não aceita Int com zero à esquerda)
  assert.deepEqual(extrairIds('https://shopee.com.br/x-i.007.0042'), { shopId: '7', itemId: '42', urlProduto: 'https://shopee.com.br/x-i.007.0042' });
});

test('shopee: extrairIds recusa encurtador, host falso, ids inválidos e o que não é link (CA1)', () => {
  const falsos = [
    CURTO, 'https://s.shopee.com.br/product/1/2', `https://s.shopee.com.br/x-i.${SHOP}.${ITEM}`, // código do encurtador nunca é produto
    `https://shp.ee/x-i.${SHOP}.${ITEM}`, `https://shope.ee/product/${SHOP}/${ITEM}`,
    `https://shopee.com.br.evil.com/x-i.${SHOP}.${ITEM}`, `https://evilshopee.com.br/x-i.${SHOP}.${ITEM}`,
    `https://evil.com/shopee.com.br/x-i.${SHOP}.${ITEM}`, `https://evil.com/?u=https://shopee.com.br/x-i.${SHOP}.${ITEM}`,
    `https://user:senha@shopee.com.br/x-i.${SHOP}.${ITEM}`, `ftp://shopee.com.br/x-i.${SHOP}.${ITEM}`,
    `javascript:alert(1)//shopee.com.br/x-i.${SHOP}.${ITEM}`,
    'https://shopee.com.br/x-i.123', 'https://shopee.com.br/x-i.a.b', `https://shopee.com.br/x-i.${'1'.repeat(21)}.2`,
    'https://shopee.com.br/x-i.0.0', 'https://shopee.com.br/x-i.1.2/mais', 'https://shopee.com.br/product/1', 'https://shopee.com.br/product/a/2',
    'https://shopee.com.br/xproduct/1/2', 'https://shopee.com.br/', 'https://shopee.com.br/search?keyword=fone',
    `https://shopee.com.br/x?u=-i.${SHOP}.${ITEM}`, 'https://shopee.com.br/x#-i.1.2',
    `https://shopee.com.br/x-i.1.2?pad=${'a'.repeat(2100)}`,
    '', '   ', 'texto', null, undefined, 42, {}, [URL_PRODUTO],
  ];
  for (const url of falsos) assert.equal(extrairIds(url), null, String(url).slice(0, 80));
});

// ------------------------------------------------------------------------------------------ resolver
test('shopee: resolver segue o link curto só com GET, sem ler o corpo, e chega aos ids sem a query (CA1)', async () => {
  const cancelados = [];
  const comCorpo = (status, location) => {
    const i = cancelados.push(false) - 1;
    const body = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('<html>…</html>')); }, cancel() { cancelados[i] = true; } });
    return new Response(body, { status, headers: { location } });
  };
  const f = fetchFalso((url, init, n) => {
    if (n === 1) { assert.equal(url, 'https://shp.ee/abc123'); return comCorpo(301, CURTO); }
    if (n === 2) { assert.equal(url, CURTO); return comCorpo(302, `${URL_PRODUTO}?utm_source=an_${ID_AFILIADO}&utm_medium=affiliates&utm_term=xyz`); }
    return assert.fail('salto a mais');
  });
  const shopee = createShopee({ fetch: f, lerConexao: () => ({}) });
  const ids = await shopee.resolver('shp.ee/abc123');
  assert.deepEqual(ids, { shopId: SHOP, itemId: ITEM, urlProduto: URL_PRODUTO });
  assert.equal(f.chamadas.length, 2);
  for (const { init } of f.chamadas) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body, undefined);
  }
  assert.deepEqual(cancelados, [true, true], 'corpo cancelado sem leitura');
  // link de produto: sem rede
  const nunca = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  assert.deepEqual(await createShopee({ fetch: nunca }).resolver(`${URL_PRODUTO}?x=1`), { shopId: SHOP, itemId: ITEM, urlProduto: URL_PRODUTO });
  assert.equal(nunca.chamadas.length, 0);
  // Location relativo e http (vira https), e /product/ no destino
  const g = fetchFalso((url, init, n) => {
    if (n === 1) { assert.equal(url, 'https://s.shopee.com.br/rel'); return redirecionar(302, '/outro'); }
    if (n === 2) { assert.equal(url, 'https://s.shopee.com.br/outro'); return redirecionar(302, `http://shopee.com.br/product/${SHOP}/${ITEM}?a=b`); }
    return assert.fail('salto a mais');
  });
  assert.deepEqual(await createShopee({ fetch: g }).resolver('http://s.shopee.com.br/rel'),
    { shopId: SHOP, itemId: ITEM, urlProduto: `https://shopee.com.br/product/${SHOP}/${ITEM}` });
});

test('shopee: resolver só segue hosts da Shopee, sem porta nem credenciais, e para em 5 saltos (CA1, SSRF)', async () => {
  const nunca = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  const shopee = createShopee({ fetch: nunca });
  for (const url of ['https://evil.com/x-i.1.2', 'https://bit.ly/abc', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://s.shopee.com.br:8443/x',
    'https://s.shopee.com.br.evil.com/x', 'https://user:pw@shp.ee/x', 'file:///etc/passwd', 'https://amzn.to/x', '', null]) {
    const e = await capturarErro(() => shopee.resolver(url));
    assert.ok(e instanceof LinkShopeeNaoResolvido, String(url));
    assert.equal(e.causa, 'invalido');
  }
  assert.equal(nunca.chamadas.length, 0);
  for (const destino of ['https://evil.com/x-i.1.2', 'https://169.254.169.254/latest/meta-data', 'https://shopee.com.br:8080/x-i.1.2',
    'gopher://shopee.com.br/x-i.1.2', 'https://shopee.com.br.evil.com/x-i.1.2']) {
    const f = fetchFalso(() => redirecionar(302, destino));
    const e = await capturarErro(() => createShopee({ fetch: f }).resolver(CURTO));
    assert.equal(e.causa, 'invalido', destino);
    assert.equal(f.chamadas.length, 1, `não seguiu para ${destino}`);
    assert.ok(!e.message.includes('evil') && !e.message.includes('s.shopee'), 'mensagem sem URL');
  }
  const loop = fetchFalso((url, init, n) => redirecionar(301, `https://s.shopee.com.br/salto${n}`));
  assert.equal((await capturarErro(() => createShopee({ fetch: loop }).resolver(CURTO))).causa, 'invalido');
  assert.equal(loop.chamadas.length, 5);
});

test('shopee: resolver não aceita amzlinks.in como salto (o salto extra é só da Amazon) nem como entrada', async () => {
  const nunca = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  assert.equal((await capturarErro(() => createShopee({ fetch: nunca }).resolver('https://amzlinks.in/abc'))).causa, 'invalido');
  assert.equal(nunca.chamadas.length, 0);
  const f = fetchFalso(() => redirecionar(302, 'https://amzlinks.in/abc'));
  assert.equal((await capturarErro(() => createShopee({ fetch: f }).resolver(CURTO))).causa, 'invalido');
  assert.equal(f.chamadas.length, 1, 'não seguiu para amzlinks.in');
});

test('shopee: resolver: página da Shopee sem produto é nao_produto; 200 no encurtador, 404, 5xx e rede são invalido (CA1)', async () => {
  const busca = fetchFalso((url, init, n) => (n === 1 ? redirecionar(302, 'https://shopee.com.br/search?keyword=fone') : new Response('<html>', { status: 200 })));
  const e1 = await capturarErro(() => createShopee({ fetch: busca }).resolver(CURTO));
  assert.ok(e1 instanceof LinkShopeeNaoResolvido);
  assert.equal(e1.causa, 'nao_produto');
  assert.equal(e1.message, 'Este link da Shopee não leva a um produto.');
  const loja = fetchFalso(() => new Response(null, { status: 200 }));
  assert.equal((await capturarErro(() => createShopee({ fetch: loja }).resolver('https://shopee.com.br/lojaoficial'))).causa, 'nao_produto');

  for (const handler of [
    () => new Response('<html>página do encurtador</html>', { status: 200 }), // s.shopee.com.br sem 30x: não lemos HTML
    () => new Response('nada', { status: 404 }),
    () => new Response('erro', { status: 503 }),
    () => { throw new TypeError('fetch failed'); },
    () => redirecionar(302, null),
  ]) {
    const e = await capturarErro(() => createShopee({ fetch: fetchFalso(handler) }).resolver(CURTO));
    assert.ok(e instanceof LinkShopeeNaoResolvido);
    assert.equal(e.causa, 'invalido');
    assert.equal(e.message, 'Não consegui abrir este link da Shopee.');
  }
});

test('shopee: resolver guarda em cache por instância (1 h) e não guarda a falha passageira', async () => {
  const rel = relogio();
  const f = fetchFalso(() => redirecionar(302, URL_PRODUTO));
  const a = createShopee({ fetch: f, agora: rel.agora });
  await a.resolver(CURTO); await a.resolver(CURTO);
  assert.equal(f.chamadas.length, 1);
  rel.t += 60 * 60 * 1000 + 1;
  await a.resolver(CURTO);
  assert.equal(f.chamadas.length, 2);
  const b = createShopee({ fetch: f, agora: rel.agora });
  await b.resolver(CURTO);
  assert.equal(f.chamadas.length, 3, 'outra instância tem o próprio cache');

  let caiu = true;
  const g = fetchFalso(() => (caiu ? new Response('x', { status: 502 }) : redirecionar(302, URL_PRODUTO)));
  const c = createShopee({ fetch: g, agora: rel.agora });
  await capturarErro(() => c.resolver(CURTO));
  caiu = false;
  assert.equal((await c.resolver(CURTO)).itemId, ITEM);
});

// ------------------------------------------------------------------------------------- assinatura e API
test('shopee: Authorization exato para payload e timestamp conhecidos (vetor fixo, calculado à parte) (CA8)', async () => {
  const rel = relogio();
  const f = fetchFalso(apiOk());
  const shopee = createShopee({ fetch: f, agora: rel.agora, lerConexao: () => conexao() });
  await shopee.lerItem(SHOP, ITEM);
  assert.equal(f.chamadas.length, 1);
  const { url, init } = f.chamadas[0];
  assert.equal(url, 'https://open-api.affiliate.shopee.com.br/graphql');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.headers['Content-Type'], 'application/json');
  const corpo = '{"query":"query{productOfferV2(itemId:6309028319,shopId:52377417,limit:1){nodes{itemId productName priceMin priceMax priceDiscountRate sales ratingStar imageUrl shopName}}}"}';
  assert.equal(init.body, corpo, 'payload exato');
  // sha256(AppId + Timestamp + Payload + Senha), calculado fora do módulo (sha256sum) e conferido com o crypto
  const esperado = 'dc46b72f96cf91cf8d087e2ac85059ee01cda3473e417bfae6fd2433c5f6263a';
  assert.equal(createHash('sha256').update(`${APP_ID}1700000000${corpo}${CHAVE}`).digest('hex'), esperado);
  assert.equal(init.headers.Authorization, `SHA256 Credential=${APP_ID}, Timestamp=1700000000, Signature=${esperado}`);
  // o timestamp acompanha o relógio a cada chamada
  rel.t += 16 * 60 * 1000;
  await shopee.lerItem(SHOP, '1');
  assert.match(f.chamadas[1].init.headers.Authorization, /, Timestamp=1700000960, Signature=[0-9a-f]{64}$/);
});

test('shopee: lerItem consulta productOfferV2 só com ids validados e devolve a oferta do nó (CA2)', async () => {
  const f = fetchFalso(apiOk());
  const shopee = createShopee({ fetch: f, agora: relogio().agora, lerConexao: () => conexao() });
  const oferta = await shopee.lerItem(SHOP, Number(ITEM));
  assert.deepEqual(oferta, {
    key: `SHOPEE:${SHOP}.${ITEM}`, shopId: SHOP, itemId: ITEM,
    title: 'Apple iPhone 11 128GB Local Set', price: 1299.9, oldPrice: null, discountPct: 15, sold: 1234,
    image: IMG, freeShipping: false, coupon: null,
    extra: { loja_nome: 'Loja Oficial', nota: 4.8, preco_max: 1499 },
  });
  // ids que não são dígitos nunca chegam à consulta
  for (const [s, i] of [['1) { x }', ITEM], [SHOP, '1,shopId:2'], [SHOP, ''], [null, ITEM], [SHOP, 1.5], [SHOP, -3], ['0', ITEM], [SHOP, '1'.repeat(21)]]) {
    assert.equal(await shopee.lerItem(s, i), null, `${s} ${i}`);
  }
  assert.equal(f.chamadas.length, 1);
});

test('shopee: lerItem sem o nó do item pedido devolve null (nao_encontrado) e guarda em cache', async () => {
  for (const nos of [[], [noApi({ itemId: 999 })], [{ itemId: null }]]) {
    const f = fetchFalso(apiOk({ nos }));
    const shopee = createShopee({ fetch: f, agora: relogio().agora, lerConexao: () => conexao() });
    assert.equal(await shopee.lerItem(SHOP, ITEM), null, JSON.stringify(nos));
    assert.equal(await shopee.lerItem(SHOP, ITEM), null);
    assert.equal(f.chamadas.length, 1, 'o null também fica em cache');
    assert.equal(shopee.situacao().acesso, 'ok', 'a chamada foi aceita');
  }
  // itemId em texto também casa
  const g = fetchFalso(apiOk({ nos: [noApi({ itemId: ITEM })] }));
  assert.equal((await createShopee({ fetch: g, lerConexao: () => conexao() }).lerItem(SHOP, ITEM)).itemId, ITEM);
});

test('shopee: cache de itens por 15 min, cópia por chamador e pedidos simultâneos numa chamada só', async () => {
  const rel = relogio();
  const f = fetchFalso(apiOk());
  const shopee = createShopee({ fetch: f, agora: rel.agora, lerConexao: () => conexao() });
  const a = await shopee.lerItem(SHOP, ITEM);
  a.title = 'mexido'; a.extra.loja_nome = 'mexida';
  const b = await shopee.lerItem(SHOP, ITEM);
  assert.equal(b.title, 'Apple iPhone 11 128GB Local Set');
  assert.equal(b.extra.loja_nome, 'Loja Oficial');
  assert.equal(f.chamadas.length, 1);
  rel.t += 15 * 60 * 1000 + 1;
  await shopee.lerItem(SHOP, ITEM);
  assert.equal(f.chamadas.length, 2);
  shopee.invalidar();
  await shopee.lerItem(SHOP, ITEM);
  assert.equal(f.chamadas.length, 3, 'invalidar esquece o cache de itens');

  let liberar;
  const portao = new Promise((ok) => { liberar = ok; });
  const g = fetchFalso(async (url, init) => { await portao; return apiOk()(url, init); });
  const c = createShopee({ fetch: g, agora: rel.agora, lerConexao: () => conexao() });
  const pedidos = [1, 2, 3].map(() => c.lerItem(SHOP, ITEM));
  liberar();
  const r = await Promise.all(pedidos);
  assert.equal(g.chamadas.length, 1);
  assert.notEqual(r[0], r[1]);
  // a falha não fica em cache
  let falhar = true;
  const h = fetchFalso((url, init) => (falhar ? json(500, {}) : apiOk()(url, init)));
  const d = createShopee({ fetch: h, agora: rel.agora, lerConexao: () => conexao() });
  assert.equal((await capturarErro(() => d.lerItem(SHOP, ITEM))).tipo, 'indisponivel');
  falhar = false;
  assert.equal((await d.lerItem(SHOP, ITEM)).itemId, ITEM);
});

test('shopee: parser do nó: preço em texto, desconto 1–99, foto só do CDN, nota 0–5, campos ausentes (CA2, CA7)', () => {
  const ids = { shopId: SHOP, itemId: ITEM };
  const o = (extra) => ofertaDoNo(noApi(extra), ids);
  assert.equal(o({ priceMin: '19.90' }).price, 19.9);
  assert.equal(o({ priceMin: 19.9 }).price, 19.9);
  for (const p of ['', '0', '-1', 'abc', null, true, '19,90']) assert.equal(o({ priceMin: p }).price, null, String(p));
  const descontos = [[0, 0], [1, 1], [15, 15], ['12', 12], [12.6, 13], [99, 99], [100, 0], [150, 0], [-5, 0], [null, 0], ['', 0], ['x', 0], [0.4, 0]];
  for (const [v, esperado] of descontos) assert.equal(o({ priceDiscountRate: v }).discountPct, esperado, String(v));
  assert.equal(o({}).oldPrice, null, 'nunca deriva preço antigo');
  for (const [v, esperado] of [[0, 0], ['1200', 1200], [10.7, 10], [-1, null], [null, null], ['', null], ['muitos', null]]) {
    assert.equal(o({ sales: v }).sold, esperado, String(v));
  }
  for (const [v, esperado] of [['4.83', 4.8], [5, 5], [0, 0], [5.1, null], [-1, null], [null, null]]) {
    assert.equal(o({ ratingStar: v }).extra.nota, esperado, String(v));
  }
  const fora = ['https://evil.com/x.jpg', 'http://down-br.img.susercontent.com/file/x', 'https://susercontent.com.evil.com/x',
    'https://evilsusercontent.com/x', 'https://susercontent.com/x', 'https://cf.shopee.com.br.evil.com/x', 'https://http2.mlstatic.com/x.jpg',
    'javascript:alert(1)', `https://cf.shopee.com.br/file/${'a'.repeat(2100)}`, null, 42];
  for (const img of fora) assert.equal(o({ imageUrl: img }).image, null, String(img).slice(0, 60));
  for (const img of [IMG, 'https://cf.shopee.com.br/file/abc', 'https://CF.SHOPEE.COM.BR/file/abc']) assert.equal(o({ imageUrl: img }).image, img);
  assert.equal(o({ productName: 'palavra '.repeat(60) }).title.length <= 200, true);
  assert.ok(!o({ productName: 'palavra '.repeat(60) }).title.endsWith(' '));
  assert.equal(o({ shopName: 'L'.repeat(100) }).extra.loja_nome.length, 80);
  assert.equal(o({ priceMax: '0' }).extra.preco_max, null);
  const vazio = ofertaDoNo(null, ids);
  assert.deepEqual(vazio, {
    key: `SHOPEE:${SHOP}.${ITEM}`, shopId: SHOP, itemId: ITEM, title: null, price: null, oldPrice: null, discountPct: 0, sold: null,
    image: null, freeShipping: false, coupon: null, extra: { loja_nome: null, nota: null, preco_max: null },
  });
});

test('shopee: cada código de erro da API vira o tipo certo, com mensagem fixa e situação atualizada', async () => {
  const casos = [
    [erroApi(10020), 'credencial_recusada', 'credencial_recusada'],
    [erroApi(10030), 'cota', 'cota'],
    [erroApi(10031), 'conta_restrita', 'conta_restrita'],
    [erroApi(10032), 'conta_restrita', 'conta_restrita'],
    [erroApi(10033), 'conta_restrita', 'conta_restrita'],
    [erroApi(10034), 'conta_restrita', 'conta_restrita'],
    [erroApi(11002), 'conta_restrita', 'conta_restrita'],
    [erroApi(10035), 'sem_acesso', 'sem_acesso'],
    [erroApi(11000), 'indisponivel', 'indisponivel'],
    [erroApi(11001), 'indisponivel', 'indisponivel'],
    [erroApi(99999), 'indisponivel', 'indisponivel'],          // código desconhecido
    [erroApi('10035'), 'sem_acesso', 'sem_acesso'],            // código em texto
    [erroApi(10035, 403), 'sem_acesso', 'sem_acesso'],         // código com HTTP de erro
    [() => json(200, { errors: [{ code: 10020, message: 'x' }] }), 'credencial_recusada', 'credencial_recusada'], // sem extensions
    [() => json(200, { errors: [{ message: 'sem código' }] }), 'indisponivel', 'indisponivel'],
    [() => json(429, {}), 'cota', 'cota'],
    [() => json(429, { errors: [{ extensions: { code: 10020 } }] }), 'cota', 'cota'],
    [() => json(500, {}), 'indisponivel', 'indisponivel'],
    [() => json(503, { data: { productOfferV2: { nodes: [] } } }), 'indisponivel', 'indisponivel'],
    [() => new Response('<html>não é json', { status: 200 }), 'indisponivel', 'indisponivel'],
    [() => json(200, { data: null }), 'indisponivel', 'indisponivel'],
    [() => json(200, { data: { productOfferV2: null } }), 'indisponivel', 'indisponivel'],
    [() => json(200, [1, 2]), 'indisponivel', 'indisponivel'],
    [() => { throw new TypeError('fetch failed'); }, 'indisponivel', 'indisponivel'],
    [() => { throw new DOMException('tempo esgotado', 'TimeoutError'); }, 'indisponivel', 'indisponivel'],
  ];
  for (const [handler, tipo, acesso] of casos) {
    const f = fetchFalso(handler);
    const shopee = createShopee({ fetch: f, agora: relogio().agora, lerConexao: () => conexao() });
    const e = await capturarErro(() => shopee.lerItem(SHOP, ITEM));
    assert.ok(e instanceof ErroShopee, tipo);
    assert.equal(e.tipo, tipo); assert.equal(e.codigo, tipo);
    assert.equal(e.message, MENSAGENS_SHOPEE[tipo]);
    assert.equal(shopee.situacao().acesso, acesso, tipo);
    assert.equal(f.chamadas.length, 1, 'sem nova tentativa');
  }
  assert.equal((await capturarErro(() => createShopee({ fetch: fetchFalso(erroApi(10035)), lerConexao: () => conexao() }).lerItem(SHOP, ITEM))).codigoApi, 10035);
  // a API não segue redirecionamento: o fetch real lança com redirect:'error'
  const r = fetchFalso((url, init) => { if (init.redirect === 'error') throw new TypeError('unexpected redirect'); return assert.fail('sem redirect:error'); });
  assert.equal((await capturarErro(() => createShopee({ fetch: r, lerConexao: () => conexao() }).lerItem(SHOP, ITEM))).tipo, 'indisponivel');
});

test('shopee: corpo acima de 2 MiB é recusado sem ser lido inteiro', async () => {
  const PEDACO = 256 * 1024;
  const s = { lidos: 0, cancelado: false };
  const body = new ReadableStream({ pull(c) { s.lidos++; c.enqueue(new Uint8Array(PEDACO).fill(0x61)); }, cancel() { s.cancelado = true; } }, { highWaterMark: 0 });
  const shopee = createShopee({ fetch: fetchFalso(() => new Response(body, { status: 200 })), lerConexao: () => conexao() });
  assert.equal((await capturarErro(() => shopee.lerItem(SHOP, ITEM))).tipo, 'indisponivel');
  assert.ok(s.lidos <= (2 * 1024 * 1024) / PEDACO + 2, `leu ${s.lidos} pedaços`);
  assert.equal(s.cancelado, true);
  const declarado = createShopee({ fetch: fetchFalso(() => json(200, { data: {} }, { 'content-length': String(50 * 1024 * 1024) })), lerConexao: () => conexao() });
  assert.equal((await capturarErro(() => declarado.lerItem(SHOP, ITEM))).tipo, 'indisponivel');
});

test('shopee: sem AppID ou sem Senha não chama a rede (sem_credenciais); credenciais do banco ou injetadas', async () => {
  const nunca = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  for (const c of [{}, { app_id: APP_ID }, { chave: CHAVE }, { app_id: 'abc', chave: CHAVE }, { app_id: APP_ID, chave: '   ' }, conexao({ app_id: `${APP_ID}\r\nX: y` })]) {
    const shopee = createShopee({ fetch: nunca, lerConexao: () => c });
    const e = await capturarErro(() => shopee.lerItem(SHOP, ITEM));
    assert.equal(e.tipo, 'sem_credenciais', JSON.stringify(c));
    assert.equal((await capturarErro(() => shopee.gerarLink(URL_PRODUTO))).tipo, 'sem_credenciais');
    assert.equal(shopee.configurado(), false);
    assert.equal(shopee.apiUtil(), false);
    assert.deepEqual(shopee.situacao(), { acesso: 'nao_configurada', verificado_em: null, motivo: MENSAGENS_SHOPEE.sem_credenciais });
    assert.deepEqual(await shopee.testar(), { ok: false, resultado: 'nao_configurada', mensagem: FRASES_TESTE_SHOPEE.nao_configurada, campos: [] });
  }
  assert.equal(nunca.chamadas.length, 0);

  // padrão: lê a linha 'shopee' de conexoes a cada chamada
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE conexoes (plataforma TEXT PRIMARY KEY, config TEXT NOT NULL DEFAULT '{}', segredos TEXT NOT NULL DEFAULT '{}', updated_at INTEGER)");
  const f = fetchFalso(apiOk());
  const doBanco = createShopee({ db, fetch: f });
  assert.equal(doBanco.configurado(), false);
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos) VALUES ('shopee', ?, ?)").run(JSON.stringify({ app_id: APP_ID, id_afiliado: ID_AFILIADO }), JSON.stringify({ chave: CHAVE }));
  assert.equal(doBanco.configurado(), true);
  await doBanco.lerItem(SHOP, ITEM);
  assert.match(f.chamadas[0].init.headers.Authorization, new RegExp(`^SHA256 Credential=${APP_ID}, `));
});

test('shopee: gerarLink manda generateShortLink com o endereço do produto sem parâmetros e só aceita s.shopee.com.br (CA4)', async () => {
  const f = fetchFalso(apiOk());
  const shopee = createShopee({ fetch: f, agora: relogio().agora, lerConexao: () => conexao() });
  assert.equal(await shopee.gerarLink(`${URL_PRODUTO}?utm_source=an_999&x="}){y}`), CURTO);
  assert.equal(JSON.parse(f.chamadas[0].init.body).query, `mutation{generateShortLink(input:{originUrl:"${URL_PRODUTO}"}){shortLink}}`);
  assert.equal(shopee.situacao().acesso, 'ok');
  // endereço que não é de produto: nem chama a API
  for (const u of [CURTO, 'https://evil.com/x-i.1.2', 'https://shopee.com.br/search?k=1', null]) {
    assert.ok((await capturarErro(() => shopee.gerarLink(u))) instanceof LinkShopeeNaoResolvido, String(u));
  }
  assert.equal(f.chamadas.length, 1);
  for (const link of ['https://meli.la/abc', 'https://s.shopee.com.br.evil.com/abc', 'http://s.shopee.com.br/abc', `${CURTO}?x=1`, '', null, 42]) {
    const g = fetchFalso(apiOk({ link }));
    const e = await capturarErro(() => createShopee({ fetch: g, lerConexao: () => conexao() }).gerarLink(URL_PRODUTO));
    assert.ok(e instanceof ErroShopee, String(link)); assert.equal(e.tipo, 'indisponivel');
  }
  assert.equal((await capturarErro(() => createShopee({ fetch: fetchFalso(erroApi(10035)), lerConexao: () => conexao() }).gerarLink(URL_PRODUTO))).tipo, 'sem_acesso');
});

test('shopee: LINK_SHOPEE só aceita https://s.shopee.com.br/<código>, sem porta, query nem outro host (CA4)', () => {
  for (const ok of [CURTO, 'https://s.shopee.com.br/abc', `https://s.shopee.com.br/${'a'.repeat(40)}`, 'https://s.shopee.com.br/A_b-9']) {
    assert.ok(LINK_SHOPEE.test(ok), ok);
  }
  for (const ruim of ['https://s.shopee.com.br.evil.com/abc', 'https://s.shopee.com.br:8443/abc', 'http://s.shopee.com.br/abc',
    'https://s.shopee.com.br/ab', `https://s.shopee.com.br/${'a'.repeat(41)}`, 'https://s.shopee.com.br/a/b', 'https://s.shopee.com.br/abc?x=1',
    'https://s.shopee.com.br/abc#x', 'https://shopee.com.br/abc', 'https://evil.com/s.shopee.com.br/abc', 'https://user@s.shopee.com.br/abc',
    ' https://s.shopee.com.br/abc', 'https://s.shopee.com.br/abc\n', 'https://meli.la/abc']) {
    assert.ok(!LINK_SHOPEE.test(ruim), ruim);
  }
});

test('shopee: afiliadoDoLongLink lê o an_<ID> do utm_source (CA4)', () => {
  const longo = `${URL_PRODUTO}?utm_campaign=-&utm_content=----&utm_medium=affiliates&utm_source=an_${ID_AFILIADO}&utm_term=dxyz`;
  assert.equal(afiliadoDoLongLink(longo), ID_AFILIADO);
  assert.equal(afiliadoDoLongLink(`${URL_PRODUTO}?UTM_SOURCE=AN_123`), '123');
  assert.equal(afiliadoDoLongLink(`${URL_PRODUTO}?utm_source=an_1&utm_source=an_1`), '1');
  assert.equal(afiliadoDoLongLink(`${URL_PRODUTO}?utm_source=an_1&utm_source=an_2`), 'varios', 'dois IDs nunca conferem');
  for (const v of [URL_PRODUTO, `${URL_PRODUTO}?utm_source=facebook`, `${URL_PRODUTO}?utm_source=an_`, `${URL_PRODUTO}?utm_source=an_12a`,
    `${URL_PRODUTO}?x=utm_source=an_1`, `${URL_PRODUTO}#utm_source=an_1`, null, '', 42, 'não é link']) {
    assert.equal(afiliadoDoLongLink(v), null, String(v));
  }
});

test('shopee: testar devolve o resultado e a frase da spec para cada caso, com os campos que vieram (CA5)', async () => {
  const f = fetchFalso(apiOk({ nos: [noApi({ imageUrl: null, ratingStar: '' })] }));
  const shopee = createShopee({ fetch: f, agora: relogio().agora, lerConexao: () => conexao() });
  const ok = await shopee.testar();
  assert.deepEqual(ok, { ok: true, resultado: 'ok', mensagem: 'Credenciais aceitas pela Shopee.',
    campos: ['itemId', 'productName', 'priceMin', 'priceMax', 'priceDiscountRate', 'sales', 'shopName'] });
  assert.equal(JSON.parse(f.chamadas[0].init.body).query,
    'query{productOfferV2(keyword:"celular",limit:1){nodes{itemId productName priceMin priceMax priceDiscountRate sales ratingStar imageUrl shopName}}}');
  assert.equal(shopee.situacao().acesso, 'ok');
  // sem nó: credencial aceita, nenhum campo
  assert.deepEqual((await createShopee({ fetch: fetchFalso(apiOk({ nos: [] })), lerConexao: () => conexao() }).testar()).campos, []);

  const casos = [
    [erroApi(10020), 'recusada'], [erroApi(10035), 'sem_acesso'], [erroApi(10031), 'conta_restrita'], [erroApi(11002), 'conta_restrita'],
    [erroApi(10030), 'cota'], [() => json(429, {}), 'cota'], [erroApi(11001), 'indisponivel'], [() => json(502, {}), 'indisponivel'],
    [() => { throw new Error(`falha com ${CHAVE}`); }, 'indisponivel'],
  ];
  for (const [handler, resultado] of casos) {
    const r = await createShopee({ fetch: fetchFalso(handler), lerConexao: () => conexao() }).testar();
    assert.deepEqual(r, { ok: false, resultado, mensagem: FRASES_TESTE_SHOPEE[resultado], campos: [] }, resultado);
  }
  assert.equal(FRASES_TESTE_SHOPEE.recusada, 'A Shopee não aceitou o AppID ou a Senha da API. Confira se copiou os dois por inteiro, sem espaços, se o aplicativo está ativo no painel de afiliados e se a data e a hora do computador estão certas.');
  assert.equal(FRASES_TESTE_SHOPEE.sem_id, 'Credenciais aceitas, mas falta o ID de afiliado.');
});

test('shopee: situacao e apiUtil seguem a última chamada e valem só para o mesmo AppID + Senha', async () => {
  const rel = relogio();
  const c = conexao();
  let resposta = erroApi(10035);
  const shopee = createShopee({ fetch: fetchFalso((u, i) => resposta(u, i)), agora: rel.agora, lerConexao: () => c });
  assert.deepEqual(shopee.situacao(), { acesso: 'desconhecido', verificado_em: null, motivo: null });
  assert.equal(shopee.configurado(), true);
  assert.equal(shopee.apiUtil(), true, 'sem verificação, a API ainda é tentada');
  await shopee.testar();
  assert.deepEqual(shopee.situacao(), { acesso: 'sem_acesso', verificado_em: T0, motivo: MENSAGENS_SHOPEE.sem_acesso });
  assert.equal(shopee.apiUtil(), false);
  for (const [code, usavel] of [[10020, false], [10033, false], [10030, true], [11000, true]]) {
    resposta = erroApi(code);
    await shopee.testar();
    assert.equal(shopee.apiUtil(), usavel, String(code));
  }
  resposta = apiOk();
  rel.t += 1000;
  await shopee.testar();
  assert.deepEqual(shopee.situacao(), { acesso: 'ok', verificado_em: T0 + 1000, motivo: null });
  assert.equal(shopee.apiUtil(), true);
  // outra senha: a verificação anterior não vale
  c.chave = 'Outra-Senha-123456';
  assert.equal(shopee.situacao().acesso, 'desconhecido');
  c.chave = CHAVE;
  assert.equal(shopee.situacao().acesso, 'ok');
  shopee.invalidar();
  assert.equal(shopee.situacao().acesso, 'desconhecido');
  // trocar só o ID de afiliado não muda a situação da API
  await shopee.testar();
  c.id_afiliado = '99999';
  assert.equal(shopee.situacao().acesso, 'ok');
});

test('shopee: nenhuma mensagem, objeto devolvido ou saída de console contém a Senha nem a assinatura (CA6)', async () => {
  const saidas = [];
  const metodos = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const originais = Object.fromEntries(metodos.map((m) => [m, console[m]]));
  for (const m of metodos) console[m] = (...a) => saidas.push(util.format(...a));
  const assinaturas = [];
  const produzidos = [];
  const espiao = (handler) => fetchFalso((url, init, n) => {
    const m = /Signature=([0-9a-f]{64})$/.exec(init.headers?.Authorization ?? '');
    if (m) assinaturas.push(m[1]);
    return handler(url, init, n);
  });
  try {
    const respostas = [
      erroApi(10020), erroApi(10035), erroApi(10031), erroApi(11001), () => json(429, { echo: CHAVE }), () => json(500, { echo: CHAVE }),
      () => { throw new Error(`falha com ${CHAVE}`); }, () => new Response(`<html>${CHAVE}`, { status: 200 }), apiOk(),
      apiOk({ link: `https://evil.com/${CHAVE}` }),
    ];
    for (const resp of respostas) {
      const shopee = createShopee({ fetch: espiao(resp), agora: relogio().agora, lerConexao: () => conexao() });
      produzidos.push(await shopee.lerItem(SHOP, ITEM).catch((e) => e));
      produzidos.push(await shopee.gerarLink(URL_PRODUTO).catch((e) => e));
      produzidos.push(await shopee.testar(), shopee.situacao(), shopee, shopee.configurado(), shopee.apiUtil());
    }
    produzidos.push(await createShopee({ fetch: espiao(() => { throw new Error(CHAVE); }) }).resolver(`https://s.shopee.com.br/${CHAVE}`).catch((e) => e));
  } finally {
    for (const m of metodos) console[m] = originais[m];
  }
  assert.ok(assinaturas.length >= 20, 'as chamadas foram assinadas');
  assert.deepEqual(saidas, [], 'o módulo não escreve no console');
  const proibidos = [CHAVE, 'SECRETA', ...assinaturas];
  for (const p of produzidos) {
    const textos = [util.inspect(p, { depth: 10, showHidden: true, getters: true }), JSON.stringify(p) ?? ''];
    if (p instanceof Error) textos.push(String(p), p.stack ?? '', p.message, JSON.stringify(Object.getOwnPropertyNames(p).map((k) => p[k])));
    for (const t of textos) for (const s of proibidos) assert.ok(!t.includes(s), `vazou "${s.slice(0, 12)}…" em: ${t.slice(0, 200)}`);
  }
  const erros = produzidos.filter((p) => p instanceof ErroShopee);
  assert.ok(erros.length > 0);
  assert.ok(erros.every((e) => Object.values(MENSAGENS_SHOPEE).includes(e.message)));
});

test('shopee: erros com tipo desconhecido e frases fixas', () => {
  assert.equal(new ErroShopee('inventado').tipo, 'indisponivel');
  assert.equal(new LinkShopeeNaoResolvido('qualquer').causa, 'invalido');
  assert.equal(new ErroShopee('outra_conta', { final: '2101' }).message,
    'O Chrome está logado em outra conta de afiliado da Shopee. Entre na conta do ID …2101 e tente de novo.');
  assert.equal(new ErroShopee('outra_conta', { final: '<b>' }).message, MENSAGENS_SHOPEE.outra_conta, 'só 4 dígitos entram na frase');
  assert.equal(new ErroShopee('sem_acesso', { final: '2101' }).message, MENSAGENS_SHOPEE.sem_acesso);
  assert.ok(Object.isFrozen(HOSTS_SHOPEE) && Object.isFrozen(MENSAGENS_SHOPEE) && Object.isFrozen(FRASES_TESTE_SHOPEE));
  assert.deepEqual([...HOSTS_SHOPEE], ['shopee.com.br', 's.shopee.com.br', 'shp.ee', 'shope.ee']);
  assert.equal(IMAGEM_SHOPEE.flags, 'i');
});

// ------------------------------------------------------------------------------------ teto de rede (S3)
test('S3: no máximo 300 acessos à Shopee por hora no cliente; o seguinte é cota sem rede e sem mudar a situação', async () => {
  const rel = relogio();
  // a API devolve o nó do item pedido (cada lerItem é um item novo: nada vem do cache)
  const f = fetchFalso((url, init) => {
    const item = /itemId:(\d+)/.exec(JSON.parse(init.body).query)?.[1];
    return apiOk({ nos: item ? [noApi({ itemId: Number(item) })] : null })(url, init);
  });
  const shopee = createShopee({ fetch: f, agora: rel.agora, lerConexao: () => conexao() });
  for (let i = 1; i <= 300; i++) assert.equal((await shopee.lerItem(SHOP, String(i))).itemId, String(i));
  assert.equal(f.chamadas.length, 300);
  const e = await capturarErro(() => shopee.lerItem(SHOP, '301'));
  assert.ok(e instanceof ErroShopee); assert.equal(e.tipo, 'cota'); assert.equal(e.message, MENSAGENS_SHOPEE.cota);
  assert.equal(f.chamadas.length, 300, 'passado o teto, nada vai à rede');
  assert.equal(shopee.situacao().acesso, 'ok', 'o teto é do programa: a situação da conta não muda');
  assert.equal(shopee.apiUtil(), true);
  // o cache de itens continua servindo (não conta como acesso)
  assert.equal((await shopee.lerItem(SHOP, '7')).itemId, '7');
  // gerarLink e testar também param no teto
  assert.equal((await capturarErro(() => shopee.gerarLink(URL_PRODUTO))).tipo, 'cota');
  assert.deepEqual(await shopee.testar(), { ok: false, resultado: 'cota', mensagem: FRASES_TESTE_SHOPEE.cota, campos: [] });
  assert.equal(f.chamadas.length, 300);
  // a janela é de 1 h a partir de cada acesso
  rel.t += 60 * 60 * 1000;
  assert.equal(await shopee.gerarLink(URL_PRODUTO), CURTO);
  assert.equal(f.chamadas.length, 301);
});

test('S3: os saltos do resolvedor de link curto contam no mesmo teto; barrado vira ErroShopee cota (não "link inválido")', async () => {
  const rel = relogio();
  const f = fetchFalso((url, init) => {
    if (url === URL_API) return apiOk()(url, init);
    if (url === 'https://shp.ee/a1') return redirecionar(301, CURTO);
    if (url === CURTO) return redirecionar(302, `${URL_PRODUTO}?utm_source=an_1`);
    if (url === 'https://shp.ee/a2') return redirecionar(302, URL_PRODUTO);
    return assert.fail(url);
  });
  const shopee = createShopee({ fetch: f, agora: rel.agora, lerConexao: () => conexao(), limiteHora: 4 });
  assert.equal((await shopee.resolver('https://shp.ee/a1')).itemId, ITEM); // 2 saltos
  assert.equal((await shopee.lerItem(SHOP, ITEM)).itemId, ITEM);          // 1 chamada à API
  assert.equal(f.chamadas.length, 3);
  // do cache do resolvedor e do link de produto: sem rede, não conta
  assert.equal((await shopee.resolver('https://shp.ee/a1')).itemId, ITEM);
  assert.equal((await shopee.resolver(URL_PRODUTO)).itemId, ITEM);
  assert.equal(f.chamadas.length, 3);
  // sobra 1: o link de 2 saltos passa no primeiro e é barrado no segundo
  const e = await capturarErro(() => shopee.resolver(`https://shp.ee/a1?x=1`));
  assert.ok(e instanceof ErroShopee, e?.name); assert.equal(e.tipo, 'cota');
  assert.equal(f.chamadas.length, 4);
  const e2 = await capturarErro(() => shopee.resolver('https://shp.ee/a2'));
  assert.equal(e2.tipo, 'cota'); assert.equal(f.chamadas.length, 4, 'sem vaga: nenhum salto');
  // o barrado não fica no cache como "inválido": passada a hora, o mesmo link resolve
  rel.t += 60 * 60 * 1000 + 1;
  assert.equal((await shopee.resolver('https://shp.ee/a2')).itemId, ITEM);
  // nao_produto continua sendo nao_produto, mesmo com o teto cheio
  const g = fetchFalso(() => new Response(null, { status: 200 }));
  const cheio = createShopee({ fetch: g, agora: rel.agora, limiteHora: 1 });
  assert.equal((await capturarErro(() => cheio.resolver('https://shopee.com.br/lojaoficial'))).causa, 'nao_produto');
  // limite inválido vale o padrão (300), nunca "sem limite"
  for (const limiteHora of [0, -5, 2.5, Infinity, '1', null]) {
    const h = fetchFalso(apiOk());
    const c = createShopee({ fetch: h, agora: relogio().agora, lerConexao: () => conexao(), limiteHora });
    for (let i = 0; i < 300; i++) await c.gerarLink(URL_PRODUTO);
    assert.equal((await capturarErro(() => c.gerarLink(URL_PRODUTO))).tipo, 'cota', String(limiteHora));
    assert.equal(h.chamadas.length, 300);
  }
});

// ----------------------------------------------------------------------------- links guardados (S2)
test('S2: linkGuardado/guardarLink: por produto e ID de afiliado, 7 dias, só s.shopee.com.br; invalidar esquece', () => {
  const rel = relogio();
  const shopee = createShopee({ fetch: fetchFalso(() => assert.fail('sem rede')), agora: rel.agora, lerConexao: () => conexao() });
  assert.equal(shopee.linkGuardado(URL_PRODUTO, ID_AFILIADO), null);
  assert.equal(shopee.guardarLink(`${URL_PRODUTO}?utm_source=an_1`, ID_AFILIADO, CURTO), true);
  // o mesmo produto em outro formato de endereço acha o link; outro produto e outro ID não
  for (const u of [URL_PRODUTO, `${URL_PRODUTO}/`, `https://shopee.com.br/product/${SHOP}/${ITEM}`, `https://shopee.com.br/outro-nome-i.${SHOP}.${ITEM}`]) {
    assert.equal(shopee.linkGuardado(u, ID_AFILIADO), CURTO, u);
  }
  assert.equal(shopee.linkGuardado(` ${URL_PRODUTO}`, ` ${ID_AFILIADO} `), CURTO);
  assert.equal(shopee.linkGuardado(`https://shopee.com.br/x-i.${SHOP}.1`, ID_AFILIADO), null, 'outro produto');
  assert.equal(shopee.linkGuardado(URL_PRODUTO, '18328801340'), null, 'outro ID de afiliado não acha o link do anterior');
  // entradas que não servem: nada guardado, nada achado
  for (const [u, id, link] of [[CURTO, ID_AFILIADO, CURTO], ['https://evil.com/x-i.1.2', ID_AFILIADO, CURTO], [URL_PRODUTO, '1234', CURTO],
    [URL_PRODUTO, 'seunome-20', CURTO], [URL_PRODUTO, 98765432101, CURTO], [URL_PRODUTO, '18328801341', 'https://meli.la/abc'],
    [URL_PRODUTO, '18328801341', `${CURTO}?x=1`], [URL_PRODUTO, '18328801341', null], [null, ID_AFILIADO, CURTO]]) {
    assert.equal(shopee.guardarLink(u, id, link), false, `${u} ${id} ${link}`);
    assert.equal(shopee.linkGuardado(u, id), u === URL_PRODUTO && id === ID_AFILIADO ? CURTO : null);
  }
  assert.equal(shopee.linkGuardado(URL_PRODUTO, '18328801341'), null);
  // guardar de novo troca o link e renova o prazo
  rel.t += 6 * 24 * 3600 * 1000;
  shopee.guardarLink(URL_PRODUTO, ID_AFILIADO, 'https://s.shopee.com.br/Novo123');
  rel.t += 6 * 24 * 3600 * 1000;
  assert.equal(shopee.linkGuardado(URL_PRODUTO, ID_AFILIADO), 'https://s.shopee.com.br/Novo123');
  rel.t += 24 * 3600 * 1000;
  assert.equal(shopee.linkGuardado(URL_PRODUTO, ID_AFILIADO), null, 'passados 7 dias, gera de novo');
  // salvar a conexão (invalidar) esquece todos
  shopee.guardarLink(URL_PRODUTO, ID_AFILIADO, CURTO);
  shopee.invalidar();
  assert.equal(shopee.linkGuardado(URL_PRODUTO, ID_AFILIADO), null);
  // outra instância (outro cliente) não vê os links desta
  shopee.guardarLink(URL_PRODUTO, ID_AFILIADO, CURTO);
  assert.equal(createShopee({ agora: rel.agora }).linkGuardado(URL_PRODUTO, ID_AFILIADO), null);
});

test('R5: RE_ID_AFILIADO é a fonte única do formato do ID de afiliado (5 a 20 dígitos)', () => {
  for (const ok of ['12345', '98765432101', '9'.repeat(20)]) assert.ok(RE_ID_AFILIADO.test(ok), ok);
  for (const ruim of ['1234', '9'.repeat(21), ' 12345', '12345a', 'seunome-20', '']) assert.ok(!RE_ID_AFILIADO.test(ruim), ruim);
});

test('shopee: o fetch global nunca foi chamado (CA8)', () => {
  assert.equal(chamadasGlobais, 0);
});
