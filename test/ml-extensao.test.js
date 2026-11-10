// Verificador, entrega 2, etapa 1 (docs/produto/planos/verificador-ml-extensao.md): `lerProdutoDaExtensao` valida a
// resposta de um pedido `produto_ml` da extensão do Chrome (entrada externa) e aplica as regras de hoje (esgotado só
// pelo enum do JSON-LD, sem preço = sem conferência). Também a página de catálogo do Mercado Livre, cujo JSON-LD é um
// ProductGroup com as ofertas em `hasVariant` (estrutura colhida numa página real em 09/11/2026): vale a variante de
// `sku` igual ao anúncio do link, nunca a de outro anúncio. Fixtures sintéticas; o fetch global fica bloqueado.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lerProdutoDaExtensao, itemDoAnuncio, parseProductHtml, conferirProduto, resolveOffer, urlProdutoML,
  MAX_OFERTAS_EXTENSAO, MAX_VARIANTES_EXTENSAO,
} from '../src/ml.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };
test.after(() => assert.equal(acessosRede, 0, 'nenhum teste acessa a rede'));

const IMAGEM = 'https://http2.mlstatic.com/D_NQ_NP_000000-MLA00000000000_000000-O.webp';
const ITEM_220 = 'MLB5257531512';
const ITEM_110 = 'MLB5257443218';
const URL_ANUNCIO_220 = `https://produto.mercadolivre.com.br/MLB-${ITEM_220.slice(3)}-fritadeira-boa-_JM`;
const URL_CATALOGO = 'https://www.mercadolivre.com.br/fritadeira-boa/p/MLB15142194';
const URL_CATALOGO_110 = `${URL_CATALOGO}?pdp_filters=item_id:${ITEM_110}`;
const EM_ESTOQUE = 'https://schema.org/InStock';
const ESGOTADO = 'https://schema.org/OutOfStock';

const lido = (...ofertas) => ({ estado: 'lido', ofertas });
const oferta = (extra = {}) => ({ nome: true, price: 89.9, availability: EM_ESTOQUE, ...extra });

// ---------------------------------------------------------------- lerProdutoDaExtensao: Product

test('extensão: oferta InStock com preço → preço e à venda', () => {
  assert.deepEqual(lerProdutoDaExtensao(lido(oferta())), { price: 89.9, disponivel: true });
  assert.deepEqual(lerProdutoDaExtensao(lido(oferta({ availability: 'InStock' }))), { price: 89.9, disponivel: true });
});

test('extensão: OutOfStock sem preço → esgotado sem preço; SoldOut e Discontinued também', () => {
  assert.deepEqual(lerProdutoDaExtensao(lido({ nome: true, availability: ESGOTADO })), { price: null, disponivel: false });
  assert.deepEqual(lerProdutoDaExtensao(lido({ nome: true, price: null, availability: ESGOTADO })), { price: null, disponivel: false });
  for (const v of ['SoldOut', 'https://schema.org/Discontinued', 'http://schema.org/SoldOut']) {
    assert.equal(lerProdutoDaExtensao(lido(oferta({ availability: v }))).disponivel, false, v);
  }
});

test('extensão: estoque fora do enum, ausente ou nulo nunca vira esgotado (sem resposta)', () => {
  for (const v of ['PreOrder', 'esgotado', 'out of stock', '', null, undefined]) {
    const o = oferta({ availability: v });
    if (v === undefined) delete o.availability;
    assert.deepEqual(lerProdutoDaExtensao(lido(o)), { price: 89.9, disponivel: null }, String(v));
  }
});

test('extensão: a primeira oferta sem nome é pulada no preço, mas o estoque dela conta se a escolhida não informa', () => {
  assert.deepEqual(lerProdutoDaExtensao(lido(oferta({ nome: false, price: 10 }), oferta({ price: 20 }))), { price: 20, disponivel: true });
  assert.deepEqual(
    lerProdutoDaExtensao(lido(oferta({ nome: false, price: 10, availability: ESGOTADO }), oferta({ price: 20, availability: null }))),
    { price: 20, disponivel: false },
  );
  // o estoque da escolhida vale mais que o primeiro informado
  assert.deepEqual(
    lerProdutoDaExtensao(lido(oferta({ nome: false, price: 10 }), oferta({ price: 20, availability: ESGOTADO }))),
    { price: 20, disponivel: false },
  );
  // sem nenhuma oferta com nome e preço: sem preço; o estoque é o primeiro informado
  assert.deepEqual(lerProdutoDaExtensao(lido(oferta({ nome: false }), oferta({ price: 0, availability: ESGOTADO }))), { price: null, disponivel: true });
});

test('extensão: preço em texto passa pelo num ("89.90", "R$ 1.234,56"); zero, vazio e texto sem número são "sem preço"', () => {
  assert.equal(lerProdutoDaExtensao(lido(oferta({ price: '89.90' }))).price, 89.9);
  assert.equal(lerProdutoDaExtensao(lido(oferta({ price: 'R$ 1.234,56' }))).price, 1234.56);
  assert.equal(lerProdutoDaExtensao(lido(oferta({ price: 10_000_000 }))).price, 10_000_000);
  for (const p of [0, '0', '', 'abc', null]) {
    assert.deepEqual(lerProdutoDaExtensao(lido(oferta({ price: p }))), { price: null, disponivel: true }, String(p));
  }
});

test('extensão: estado verificacao → bloqueado; lista vazia → sem conferência', () => {
  assert.deepEqual(lerProdutoDaExtensao({ estado: 'verificacao' }), { bloqueado: true });
  assert.deepEqual(lerProdutoDaExtensao(lido()), { price: null, disponivel: null });
  assert.equal(lerProdutoDaExtensao(lido(...Array.from({ length: MAX_OFERTAS_EXTENSAO }, () => oferta()))).price, 89.9, 'o teto ainda vale');
});

test('extensão: formato fora do contrato → null (resposta inteira recusada)', () => {
  const invalidos = {
    'null': null,
    'texto': 'lido',
    'array': [oferta()],
    'sem estado': { ofertas: [oferta()] },
    'estado estranho': { estado: 'ok', ofertas: [oferta()] },
    'lido sem ofertas': { estado: 'lido' },
    'ofertas que não são lista': { estado: 'lido', ofertas: { 0: oferta() } },
    '6 ofertas': lido(...Array.from({ length: MAX_OFERTAS_EXTENSAO + 1 }, () => oferta())),
    'verificacao com ofertas': { estado: 'verificacao', ofertas: [] },
    'chave a mais (html)': { ...lido(oferta()), html: '<html>' },
    'chave a mais na oferta (url)': lido(oferta({ url: 'https://www.mercadolivre.com.br/x' })),
    'sku numa oferta de Product': lido(oferta({ sku: ITEM_220 })),
    'oferta nula': lido(null),
    'oferta texto': lido('oferta'),
    'oferta array': lido([oferta()]),
    'nome texto': lido(oferta({ nome: 'Fone Bom' })),
    'nome ausente': lido({ price: 10 }),
    'price objeto': lido(oferta({ price: { valor: 10 } })),
    'price array': lido(oferta({ price: [10] })),
    'price booleano': lido(oferta({ price: true })),
    'price negativo': lido(oferta({ price: -1 })),
    'price texto negativo': lido(oferta({ price: '-5' })),
    'price acima do teto': lido(oferta({ price: 10_000_001 })),
    'price 1e21 (o num leria "121")': lido(oferta({ price: 1e21 })),
    'price texto acima do teto': lido(oferta({ price: '99999999' })),
    'price texto longo': lido(oferta({ price: '1'.padStart(31, ' ') })),
    'availability gigante': lido(oferta({ availability: `https://schema.org/InStock${'x'.repeat(100)}` })),
    'availability número': lido(oferta({ availability: 1 })),
    '__proto__ vindo do JSON': JSON.parse('{"estado":"lido","ofertas":[],"__proto__":{"x":1}}'),
  };
  for (const [nome, data] of Object.entries(invalidos)) assert.equal(lerProdutoDaExtensao(data), null, nome);
  assert.equal(lerProdutoDaExtensao(), null, 'sem data');
});

// ---------------------------------------------------------------- itemDoAnuncio

test('itemDoAnuncio: MLB do anúncio, item_id do pdp_filters na página de catálogo; catálogo sem filtro → null', () => {
  assert.equal(itemDoAnuncio(URL_ANUNCIO_220), ITEM_220);
  assert.equal(itemDoAnuncio(`https://produto.mercadolivre.com.br/${ITEM_220}`), ITEM_220);
  assert.equal(itemDoAnuncio(URL_CATALOGO_110), ITEM_110);
  assert.equal(itemDoAnuncio(`${URL_CATALOGO}?pdp_filters=item_id%3A${ITEM_110}`), ITEM_110, 'filtro codificado');
  assert.equal(itemDoAnuncio(`${URL_CATALOGO}?pdp_filters=category:MLB1234567|item_id:${ITEM_110}`), ITEM_110);
  assert.equal(itemDoAnuncio(URL_CATALOGO), null, 'o MLB do /p/ é do catálogo');
  assert.equal(itemDoAnuncio(`${URL_CATALOGO}?pdp_filters=xitem_id:${ITEM_110}`), null);
  assert.equal(itemDoAnuncio(`https://produto.mercadolivre.com.br/fone?origem=${ITEM_220}`), null, 'MLB só no caminho');
  for (const u of ['https://meli.la/1AbCdEf', 'não é url', '', null, undefined]) assert.equal(itemDoAnuncio(u), null, String(u));
});

// ---------------------------------------------------------------- ProductGroup (página de catálogo)

const variante = (sku, price, availability = EM_ESTOQUE, extra = {}) => ({
  '@type': 'Product', ...(sku !== undefined ? { sku } : {}), name: `Fritadeira Boa ${price} MX31`,
  offers: { '@type': 'Offer', price, priceCurrency: 'BRL', availability }, ...extra,
});

/** JSON-LD de um ProductGroup como o da página real: sem `offers` no topo, ofertas em `hasVariant`. */
const grupoLd = (variantes) => ({
  '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Fritadeira Boa', model: 'MX31',
  brand: { '@type': 'Brand', name: 'Boa' }, description: 'Fritadeira.', image: IMAGEM,
  aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.8, reviewCount: 120 }, review: [], hasVariant: variantes,
});

/** Página de catálogo com o ProductGroup e o bloco __NORDIC_RENDERING_CTX__ (que não deve ser lido). */
const paginaGrupo = (variantes) => `<html><head>
<script id="__NORDIC_RENDERING_CTX__">{"offers":{"type":"Offer","price":999.99,"availability":"https://schema.org/InStock"}}</script>
<script type="application/ld+json">${JSON.stringify(grupoLd(variantes))}</script>
</head><body></body></html>`;

/** O mesmo grupo no formato da resposta da extensão (contrato da etapa 2). */
const grupoExtensao = (variantes) => ({
  nome: true,
  variantes: variantes.map((v) => ({ sku: v.sku ?? null, nome: !!v.name, price: v.offers.price, availability: v.offers.availability })),
});

const DUAS = [variante(ITEM_220, 154.99), variante(ITEM_110, 159, ESGOTADO)];
const semApi = { fetchJson: async () => { throw new Error('HTTP 403'); } };

test('ProductGroup: a variante de sku igual ao anúncio do link vale, no HTML e na extensão', async () => {
  const html = paginaGrupo(DUAS);
  const casos = [
    [URL_ANUNCIO_220, { price: 154.99, disponivel: true }],
    [URL_CATALOGO_110, { price: 159, disponivel: false }],
    [`https://www.mercadolivre.com.br/fritadeira-boa/p/MLB15142194?pdp_filters=item_id:${ITEM_220}`, { price: 154.99, disponivel: true }],
  ];
  for (const [url, esperado] of casos) {
    assert.deepEqual(await conferirProduto(url, { ...semApi, fetchText: async () => html }), esperado, `HTML ${url}`);
    assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(DUAS)), { url }), esperado, `extensão ${url}`);
  }
  assert.deepEqual(parseProductHtml(html, { url: URL_ANUNCIO_220 }), {
    title: `Fritadeira Boa 154.99 MX31`, price: 154.99, oldPrice: null, image: IMAGEM, disponivel: true,
  }, 'nome da variante e imagem do grupo; o __NORDIC_RENDERING_CTX__ não é lido');
});

test('ProductGroup: anúncio fora da lista de variantes, ou catálogo sem item com várias → sem conferência (nem o estoque de outra variante)', async () => {
  const html = paginaGrupo(DUAS);
  const fora = 'https://produto.mercadolivre.com.br/MLB-9999999999-outra-_JM';
  assert.deepEqual(await conferirProduto(fora, { ...semApi, fetchText: async () => html }), { price: null, disponivel: null }, 'HTML do anúncio fora');
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(DUAS)), { url: fora }), { price: null, disponivel: null }, 'extensão do anúncio fora');
  // sem item no link: o resumo das versões (uma esgotada e outra à venda → nada), marcado `varias` (R1)
  const nada = { price: null, disponivel: null, varias: true };
  assert.deepEqual(await conferirProduto(URL_CATALOGO, { ...semApi, fetchText: async () => html }), nada, 'HTML do catálogo sem item');
  for (const url of [URL_CATALOGO, undefined]) assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(DUAS)), { url }), nada, `extensão ${url}`);
  for (const url of [fora, URL_CATALOGO, undefined]) assert.equal(parseProductHtml(html, { url }), null, `parseProductHtml ${url}`);
  // variante sem sku não é a do anúncio quando há várias
  const semSku = [variante(undefined, 154.99), variante(ITEM_110, 159)];
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(semSku)), { url: URL_ANUNCIO_220 }), { price: null, disponivel: null });
  assert.deepEqual(await conferirProduto(URL_ANUNCIO_220, { ...semApi, fetchText: async () => paginaGrupo(semSku) }), { price: null, disponivel: null });
});

test('R1: catálogo sem item no link e com várias versões: todas esgotadas → esgotado; todas à venda → o menor preço; senão nada; sempre `varias` e nunca no resolveOffer', async () => {
  const casos = [
    [[variante(ITEM_220, 154.99, ESGOTADO), variante(ITEM_110, 159, 'SoldOut')], { price: null, disponivel: false, varias: true }],
    [[variante(ITEM_220, 159), variante(ITEM_110, '154,99'), variante('MLB5257000001', 170, 'LimitedAvailability')], { price: 154.99, disponivel: true, varias: true }],
    [[variante(ITEM_220, 159), variante(ITEM_110, 154.99, ESGOTADO)], { price: null, disponivel: null, varias: true }],
    [[variante(ITEM_220, 159), variante(ITEM_110, 154.99, 'https://schema.org/PreOrder')], { price: null, disponivel: null, varias: true }],
    [[variante(ITEM_220, 159), variante(ITEM_110, null)], { price: null, disponivel: null, varias: true }],
    [[variante(ITEM_220, 159), { '@type': 'Product', sku: ITEM_110, name: 'sem offers' }], { price: null, disponivel: null, varias: true }],
  ];
  for (const [vs, esperado] of casos) {
    const rotulo = JSON.stringify(vs.map((v) => [v.offers?.price, v.offers?.availability]));
    assert.deepEqual(await conferirProduto(URL_CATALOGO, { ...semApi, fetchText: async () => paginaGrupo(vs) }), esperado, `HTML ${rotulo}`);
    const ext = { nome: true, variantes: vs.map((v) => ({ sku: v.sku ?? null, nome: !!v.name, price: v.offers?.price ?? null, availability: v.offers?.availability ?? null })) };
    assert.deepEqual(lerProdutoDaExtensao(lido(ext), { url: URL_CATALOGO }), esperado, `extensão ${rotulo}`);
    assert.equal(parseProductHtml(paginaGrupo(vs), { url: URL_CATALOGO }), null, 'o resolveOffer nunca recebe o preço de uma versão');
  }
  // com o item no link, vale a variante dele (nunca o resumo)
  const aVenda = [variante(ITEM_220, 159), variante(ITEM_110, 154.99)];
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(aVenda)), { url: URL_CATALOGO_110 }), { price: 154.99, disponivel: true });
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(aVenda)), { url: `${URL_CATALOGO}?pdp_filters=item_id:MLB1111111111` }), { price: null, disponivel: null }, 'item fora da lista: nada, sem resumo');
  // um Product com preço em outro bloco vence o resumo (como antes, o primeiro bloco com nome e preço)
  const comProduto = lido(grupoExtensao(aVenda), oferta({ price: 70 }));
  assert.deepEqual(lerProdutoDaExtensao(comProduto, { url: URL_CATALOGO }), { price: 70, disponivel: true });
  // 30 variantes na resposta da extensão: a lista pode ter sido cortada (ela manda no máximo 30) → nada, nem o esgotado
  const trinta = Array.from({ length: MAX_VARIANTES_EXTENSAO }, (_, i) => variante(`MLB${5000000000 + i}`, 100 + i, ESGOTADO));
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(trinta)), { url: URL_CATALOGO }), { price: null, disponivel: null, varias: true });
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(trinta.slice(1))), { url: URL_CATALOGO }), { price: null, disponivel: false, varias: true });
});

test('urlProdutoML (S1, servidor): só anúncio ou catálogo de www./produto.mercadolivre.com.br; leva origin + caminho e só o pdp_filters=item_id', () => {
  const CAT = 'https://www.mercadolivre.com.br/fritadeira-boa/p/MLB15142194';
  const iguais = [URL_ANUNCIO_220, CAT, URL_CATALOGO_110, 'https://www.mercadolivre.com.br/p/MLB15142194', 'https://www.mercadolivre.com.br/MLB5257531512'];
  for (const u of iguais) assert.equal(urlProdutoML(u), u, u);
  const limpos = [
    [`${URL_ANUNCIO_220}?matt_tool=123&matt_word=x#polycard`, URL_ANUNCIO_220],
    [`${CAT}?pdp_filters=item_id%3A${ITEM_110}&wid=MLB1`, `${CAT}?pdp_filters=item_id:${ITEM_110}`],
    [`${CAT}?pdp_filters=category:MLB1648`, CAT], [`${CAT}?pdp_filters=item_id:${ITEM_110},category:MLB1`, CAT],
    [`${CAT}?pdp_filters=item_id:${ITEM_110}&pdp_filters=item_id:${ITEM_220}`, CAT], [`${CAT}?pdp_filters=item_id:MLB12`, CAT],
    ['https://WWW.MercadoLivre.com.br:443/fritadeira-boa/p/MLB15142194?', CAT],
  ];
  for (const [de, para] of limpos) assert.equal(urlProdutoML(de), para, de);
  const fora = [
    'https://www.mercadolivre.com.br/jms/mlb/lgz/logout', 'https://www.mercadolivre.com.br/perfil', 'https://myaccount.mercadolivre.com.br/summary',
    'https://www.mercadolivre.com.br/', 'https://www.mercadolivre.com.br/carrinho', 'https://mercadopago.mercadolivre.com.br/checkout/pay?pref_id=1',
    'https://mercadolivre.com.br/MLB-1234567', 'https://lista.mercadolivre.com.br/MLB-1234567', 'https://www.mercadolivre.com.br/social/p/MLB123',
    'https://www.mercadolivre.com.br/%53ocial/MLB-1234567', 'https://www.mercadolivre.com.br/social/MLB-1234567', 'https://www.mercadolivre.com.br/a/b/p/MLB15142194', 'https://www.mercadolivre.com.br/MLB-123456-%2F..%2Fjms%2Flogout', 'https://www.mercadolivre.com.br/a%2F..%2Fb/p/MLB123',
    'https://www.mercadolivre.com.br/p/MLB15142194/s', 'https://www.mercadolivre.com.br/MLB-1234567/logout', 'https://www.mercadolivre.com.br/MLB-12345',
    'https://www.mercadolivre.com.br/gz/account-verification', 'https://www.mercadolibre.com/MLB-1234567', 'https://meli.la/AbCdE',
    'http://www.mercadolivre.com.br/MLB-1234567', 'https://www.mercadolivre.com.br:8443/MLB-1234567', 'https://u:p@www.mercadolivre.com.br/MLB-1234567',
    'https://www.mercadolivre.com.br/%E0%A4%A/p/MLB1', `https://www.mercadolivre.com.br/${'a'.repeat(2040)}/p/MLB1`, '', null, undefined, 42, {},
  ];
  for (const u of fora) assert.equal(urlProdutoML(u), null, String(u).slice(0, 80));
  // o anúncio que a oferta conhece (Central: metadata.id) vai como pdp_filters num catálogo sem filtro (R1)
  assert.equal(urlProdutoML(CAT, { item: ITEM_110 }), `${CAT}?pdp_filters=item_id:${ITEM_110}`);
  assert.equal(urlProdutoML(`${CAT}?pdp_filters=item_id:${ITEM_220}`, { item: ITEM_110 }), `${CAT}?pdp_filters=item_id:${ITEM_220}`, 'o filtro do link vale mais');
  for (const item of ['MLB15142194', 'MLB12', 'mlb5257443218', `${ITEM_110},x`, 5257443218, null]) assert.equal(urlProdutoML(CAT, { item }), CAT, String(item));
  assert.equal(urlProdutoML(URL_ANUNCIO_220, { item: ITEM_110 }), URL_ANUNCIO_220, 'anúncio: o caminho já diz o item');
});

test('ProductGroup: uma variante só vale sem item no link ou sem sku; com sku de outro anúncio, não', async () => {
  const uma = [variante(ITEM_220, 154.99)];
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(uma)), { url: URL_CATALOGO }), { price: 154.99, disponivel: true });
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(uma))), { price: 154.99, disponivel: true }, 'sem url');
  assert.equal(parseProductHtml(paginaGrupo(uma)).price, 154.99);
  const semSku = [variante(undefined, 154.99)];
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(semSku)), { url: URL_CATALOGO_110 }), { price: 154.99, disponivel: true });
  assert.deepEqual(await conferirProduto(URL_CATALOGO_110, { ...semApi, fetchText: async () => paginaGrupo(semSku) }), { price: 154.99, disponivel: true });
  // a única variante é de outro anúncio
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(uma)), { url: URL_CATALOGO_110 }), { price: null, disponivel: null });
  assert.deepEqual(await conferirProduto(URL_CATALOGO_110, { ...semApi, fetchText: async () => paginaGrupo(uma) }), { price: null, disponivel: null });
});

test('ProductGroup: sku com hífen ou minúsculo casa com o anúncio; sku que não é MLB não casa', () => {
  const url = URL_ANUNCIO_220;
  const com = (sku) => lerProdutoDaExtensao(lido(grupoExtensao([variante(ITEM_110, 159), variante(sku, 154.99)])), { url }).price;
  assert.equal(com('MLB-5257531512'), 154.99);
  assert.equal(com('mlb5257531512'), 154.99);
  assert.equal(com('5257531512'), null);
  assert.equal(com('MLB5257531512X'), null);
});

test('ProductGroup: variante esgotada sem preço é esgotado; nome do grupo cobre variante sem nome', () => {
  const v = [variante(ITEM_220, undefined, ESGOTADO), variante(ITEM_110, 159)];
  delete v[0].offers.price;
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(v)), { url: URL_ANUNCIO_220 }), { price: null, disponivel: false });
  const semNome = { nome: true, variantes: [{ sku: ITEM_220, nome: false, price: 154.99, availability: EM_ESTOQUE }] };
  assert.deepEqual(lerProdutoDaExtensao(lido(semNome), { url: URL_ANUNCIO_220 }), { price: 154.99, disponivel: true });
  const nenhumNome = { nome: false, variantes: [{ sku: ITEM_220, nome: false, price: 154.99, availability: EM_ESTOQUE }] };
  assert.deepEqual(lerProdutoDaExtensao(lido(nenhumNome), { url: URL_ANUNCIO_220 }), { price: null, disponivel: true });
  const v2 = variante(ITEM_220, 154.99); delete v2.name;
  assert.equal(parseProductHtml(paginaGrupo([v2]), { url: URL_ANUNCIO_220 }).title, 'Fritadeira Boa');
});

test('ProductGroup na extensão: variantes fora do contrato → null', () => {
  const v = { sku: ITEM_220, nome: true, price: 154.99, availability: EM_ESTOQUE };
  const invalidos = {
    'sem variantes': { nome: true, variantes: [] },
    'variantes demais': { nome: true, variantes: Array.from({ length: MAX_VARIANTES_EXTENSAO + 1 }, () => v) },
    'variantes não lista': { nome: true, variantes: v },
    'grupo sem nome': { variantes: [v] },
    'grupo com price': { nome: true, price: 1, variantes: [v] },
    'variante com chave a mais': { nome: true, variantes: [{ ...v, url: 'x' }] },
    'variante nula': { nome: true, variantes: [null] },
    'sku número': { nome: true, variantes: [{ ...v, sku: 5257531512 }] },
    'sku longo': { nome: true, variantes: [{ ...v, sku: `MLB${'1'.repeat(28)}` }] },
    'price da variante objeto': { nome: true, variantes: [{ ...v, price: {} }] },
    'availability da variante gigante': { nome: true, variantes: [{ ...v, availability: 'x'.repeat(101) }] },
  };
  for (const [nome, grupo] of Object.entries(invalidos)) assert.equal(lerProdutoDaExtensao(lido(grupo), { url: URL_ANUNCIO_220 }), null, nome);
  assert.equal(lerProdutoDaExtensao(lido({ nome: true, variantes: Array.from({ length: MAX_VARIANTES_EXTENSAO }, () => v) }), { url: URL_ANUNCIO_220 }).price, 154.99, 'o teto ainda vale');
});

test('ProductGroup no meio de outros blocos: o grupo sem variante do anúncio não informa; o Product seguinte vale', async () => {
  const produto = { '@type': 'Product', name: 'Outro', offers: { price: '50', availability: EM_ESTOQUE } };
  const html = `${paginaGrupo(DUAS)}<script type="application/ld+json">${JSON.stringify(produto)}</script>`;
  const fora = 'https://produto.mercadolivre.com.br/MLB-9999999999-outra-_JM';
  assert.deepEqual(await conferirProduto(fora, { ...semApi, fetchText: async () => html }), { price: 50, disponivel: true });
  assert.deepEqual(lerProdutoDaExtensao(lido(grupoExtensao(DUAS), oferta({ price: '50' })), { url: fora }), { price: 50, disponivel: true });
  // ProductGroup e Product no mesmo @graph: o grupo manda (o Product solto pode ser variante de outro anúncio)
  const graph = { '@context': 'https://schema.org', '@graph': [variante(ITEM_110, 159), grupoLd(DUAS)] };
  const html2 = `<script type="application/ld+json">${JSON.stringify(graph)}</script>`;
  assert.equal(parseProductHtml(html2, { url: URL_ANUNCIO_220 }).price, 154.99);
  assert.equal(parseProductHtml(html2, { url: fora }), null, 'sem a variante do anúncio, o Product solto do bloco não vale');
  // ProductGroup sem hasVariant: como antes, não informa nada
  assert.equal(parseProductHtml(`<script type="application/ld+json">${JSON.stringify({ '@type': 'ProductGroup', name: 'X', offers: { price: 10 } })}</script>`), null);
});

test('resolveOffer: link de catálogo com pdp_filters lê a variante do anúncio', async () => {
  const r = await resolveOffer({ key: ITEM_110, url: URL_CATALOGO_110 }, { ...semApi, fetchText: async () => paginaGrupo(DUAS) });
  assert.equal(r.price, 159);
  assert.equal(r.title, 'Fritadeira Boa 159 MX31');
  assert.ok(!('disponivel' in r), 'resolveOffer segue sem estoque');
});
