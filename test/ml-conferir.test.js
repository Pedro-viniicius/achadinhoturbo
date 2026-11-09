// Verificador de preço e estoque, etapa 1 (docs/produto/planos/verificador-preco-estoque.md): o leitor do Mercado
// Livre informa o estoque (`disponivel`), ganha conferirProduto (sempre lê a loja) e a lista de links marca o preço
// digitado (`digitado`). As páginas e as respostas da API são fixtures sintéticas: nenhum teste acessa o Mercado Livre.
// O fetch global fica bloqueado; só os testes do leitor de página o trocam, por um falso, e o devolvem bloqueado.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProductHtml, parseListLines, resolveOffer, searchOffers, conferirProduto, MAX_PAGINA,
} from '../src/ml.js';

let acessosRede = 0;
const redeBloqueada = async () => { acessosRede++; throw new Error('rede proibida no teste'); };
globalThis.fetch = redeBloqueada;
afterEach(() => { globalThis.fetch = redeBloqueada; });

const IMAGEM = 'https://http2.mlstatic.com/D_NQ_NP_000000-MLA00000000000_000000-O.webp';
const URL_ANUNCIO = 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM';
const URL_CATALOGO = 'https://www.mercadolivre.com.br/fone-bom/p/MLB55555555';
const URL_META = 'https://meli.la/1AbCdEf';

/** Página de produto com JSON-LD. `oferta: null` tira o `offers`; `disponibilidade` vai em offers.availability. */
function paginaJsonLd({ preco = '199.90', disponibilidade, oferta = {} } = {}) {
  const offers = oferta === null ? undefined : {
    '@type': 'Offer', priceCurrency: 'BRL',
    ...(preco != null ? { price: preco } : {}),
    ...(disponibilidade !== undefined ? { availability: disponibilidade } : {}),
    ...oferta,
  };
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: 'Fone Bom', image: IMAGEM, ...(offers ? { offers } : {}) };
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>"original_price":299.9</body></html>`;
}

/** Vitrine social do afiliado (para onde o meli.la leva): só og:*, sem JSON-LD nem estoque. */
const paginaSocial = () => `<html><head>
<meta property="og:title" content="Fone Bom - R$ 189,90"/>
<meta property="og:image" content="${IMAGEM}"/>
</head><body></body></html>`;

/** Resposta da API /items/:id. */
const itemApi = (extra = {}) => ({
  id: 'MLB1234567890', title: 'Fone Bom', price: 199.9, original_price: 299.9, permalink: URL_ANUNCIO,
  status: 'active', available_quantity: 7, sold_quantity: 10, shipping: { free_shipping: true }, ...extra,
});

/** Leitores falsos que registram o que foi pedido. */
function leitores({ api, pagina } = {}) {
  const pedidos = { api: [], pagina: [] };
  return {
    pedidos,
    fetchJson: async (u) => { pedidos.api.push(u); if (api instanceof Error) throw api; return typeof api === 'function' ? api(u) : api; },
    fetchText: async (u) => { pedidos.pagina.push(u); if (pagina instanceof Error) throw pagina; return typeof pagina === 'function' ? pagina(u) : pagina; },
  };
}

// ---------------------------------------------------------------- parseProductHtml: disponivel só por enum

test('parseProductHtml: JSON-LD InStock dá disponivel true; OutOfStock, SoldOut e Discontinued dão false', () => {
  assert.deepEqual(parseProductHtml(paginaJsonLd({ disponibilidade: 'https://schema.org/InStock' })),
    { title: 'Fone Bom', price: 199.9, oldPrice: 299.9, image: IMAGEM, disponivel: true });
  for (const v of ['https://schema.org/OutOfStock', 'http://schema.org/SoldOut', 'Discontinued', ' https://www.schema.org/OutOfStock ']) {
    assert.equal(parseProductHtml(paginaJsonLd({ disponibilidade: v })).disponivel, false, v);
  }
  for (const v of ['http://schema.org/InStock', 'LimitedAvailability', 'https://schema.org/OnlineOnly']) {
    assert.equal(parseProductHtml(paginaJsonLd({ disponibilidade: v })).disponivel, true, v);
  }
});

test('parseProductHtml: availability ausente, fora da lista ou que não é texto não informa estoque (nunca vira esgotado)', () => {
  const casos = [undefined, null, '', 'PreOrder', 'https://schema.org/BackOrder', 'esgotado', 'OutOfStockAgora',
    'https://evil.example.com/OutOfStock', 'javascript:OutOfStock', 0, false, ['OutOfStock'], { '@id': 'https://schema.org/OutOfStock' }];
  for (const v of casos) {
    const p = parseProductHtml(paginaJsonLd({ disponibilidade: v }));
    assert.equal(p.price, 199.9, JSON.stringify(v));
    assert.ok(!('disponivel' in p), `sem disponivel para ${JSON.stringify(v)}`);
  }
});

test('parseProductHtml: JSON-LD sem offers continua sem dados (null), e a página social não informa estoque', () => {
  assert.equal(parseProductHtml(paginaJsonLd({ oferta: null })), null);
  assert.deepEqual(parseProductHtml(paginaSocial()), { title: 'Fone Bom', price: 189.9, oldPrice: null, image: IMAGEM });
});

// ---------------------------------------------------------------- conferirProduto: API

test('conferirProduto: API com anúncio ativo dá preço e disponivel true, sem ler a página', async () => {
  const l = leitores({ api: itemApi(), pagina: new Error('não devia ler a página') });
  assert.deepEqual(await conferirProduto(URL_ANUNCIO, l), { price: 199.9, disponivel: true });
  assert.deepEqual(l.pedidos.api, ['https://api.mercadolibre.com/items/MLB1234567890']);
  assert.equal(l.pedidos.pagina.length, 0);
});

test('conferirProduto: API com anúncio pausado, encerrado ou sem estoque dá disponivel false', async () => {
  for (const extra of [{ status: 'paused' }, { status: 'closed' }, { available_quantity: 0 }, { status: 'paused', price: null }]) {
    const l = leitores({ api: itemApi(extra), pagina: new Error('não devia ler a página') });
    const r = await conferirProduto(URL_ANUNCIO, l);
    assert.equal(r.disponivel, false, JSON.stringify(extra));
    assert.equal(r.price, extra.price === null ? null : 199.9);
    assert.equal(l.pedidos.pagina.length, 0, 'esgotado pela API não precisa da página');
  }
});

test('conferirProduto: API sem status nem quantidade não informa estoque', async () => {
  const l = leitores({ api: itemApi({ status: undefined, available_quantity: undefined }) });
  assert.deepEqual(await conferirProduto(URL_ANUNCIO, l), { price: 199.9, disponivel: null });
});

test('conferirProduto: API recusada cai para a página (JSON-LD)', async () => {
  const l = leitores({ api: new Error('HTTP 403'), pagina: paginaJsonLd({ preco: '210.00', disponibilidade: 'https://schema.org/OutOfStock' }) });
  assert.deepEqual(await conferirProduto(URL_ANUNCIO, l), { price: 210, disponivel: false });
  assert.equal(l.pedidos.api.length, 1);
  assert.deepEqual(l.pedidos.pagina, [URL_ANUNCIO]);
});

test('conferirProduto: API ativa sem preço lê a página e mantém o estoque da API se a página não disser', async () => {
  const l = leitores({ api: itemApi({ price: 'grátis' }), pagina: paginaSocial() });
  assert.deepEqual(await conferirProduto(URL_ANUNCIO, l), { price: 189.9, disponivel: true });
});

test('conferirProduto: API que devolve lixo (null, texto) cai para a página', async () => {
  for (const api of [null, 'oi', 42]) {
    const l = leitores({ api, pagina: paginaJsonLd({ disponibilidade: 'https://schema.org/InStock' }) });
    assert.deepEqual(await conferirProduto(URL_ANUNCIO, l), { price: 199.9, disponivel: true }, JSON.stringify(api));
  }
});

// ---------------------------------------------------------------- conferirProduto: página

test('conferirProduto: página de catálogo (/p/) não usa a API', async () => {
  const l = leitores({ api: new Error('não devia usar a API'), pagina: paginaJsonLd({ disponibilidade: 'https://schema.org/InStock' }) });
  assert.deepEqual(await conferirProduto(URL_CATALOGO, l), { price: 199.9, disponivel: true });
  assert.equal(l.pedidos.api.length, 0);
});

test('conferirProduto: meli.la lido pela página social dá o preço, sem estoque', async () => {
  const l = leitores({ api: new Error('não devia usar a API'), pagina: paginaSocial() });
  assert.deepEqual(await conferirProduto(URL_META, l), { price: 189.9, disponivel: null });
  assert.equal(l.pedidos.api.length, 0);
});

test('conferirProduto: JSON-LD sem offers ou página sem dados dá preço null e estoque null', async () => {
  for (const pagina of [paginaJsonLd({ oferta: null }), '<html><title>Entre na sua conta</title></html>', '']) {
    const l = leitores({ api: new Error('HTTP 403'), pagina });
    assert.deepEqual(await conferirProduto(URL_ANUNCIO, l), { price: null, disponivel: null });
  }
});

test('conferirProduto: anúncio esgotado sem preço no JSON-LD ainda dá disponivel false', async () => {
  const pagina = paginaJsonLd({ preco: null, disponibilidade: 'https://schema.org/SoldOut' });
  assert.equal(parseProductHtml(pagina), null, 'parseProductHtml segue exigindo preço');
  const l = leitores({ api: new Error('HTTP 403'), pagina });
  assert.deepEqual(await conferirProduto(URL_ANUNCIO, l), { price: null, disponivel: false });
});

test('conferirProduto: sempre lê a loja (sem o atalho dos dados conhecidos)', async () => {
  let preco = 199.9;
  const l = leitores({ api: () => itemApi({ price: preco }) });
  assert.equal((await conferirProduto(URL_ANUNCIO, l)).price, 199.9);
  preco = 249.9;
  assert.equal((await conferirProduto(URL_ANUNCIO, l)).price, 249.9);
  assert.equal(l.pedidos.api.length, 2);
});

test('conferirProduto: API e página fora do ar lança, sem a URL na mensagem', async () => {
  const l = leitores({ api: new Error('HTTP 500'), pagina: new Error('HTTP 503') });
  await assert.rejects(conferirProduto(URL_ANUNCIO, l), (e) => e.message === 'HTTP 503' && !e.message.includes('mercadolivre'));
});

test('conferirProduto: endereço de fora do Mercado Livre é recusado antes de qualquer leitura', async () => {
  const antes = acessosRede;
  const ruins = [
    'https://evil.example.com/MLB-1234567890-x', 'https://mercadolivre.com.br.evil.com/MLB-1234567890-x',
    'https://evilmercadolivre.com.br/MLB-1234567890', 'ftp://produto.mercadolivre.com.br/MLB-1234567890',
    'javascript:alert(1)//mercadolivre.com.br', 'produto.mercadolivre.com.br/MLB-1234567890', '', null, undefined, 42,
  ];
  for (const url of ruins) {
    const l = leitores({ api: itemApi(), pagina: paginaJsonLd() });
    await assert.rejects(conferirProduto(url, l), { message: 'endereço fora do Mercado Livre' }, String(url));
    assert.deepEqual(l.pedidos, { api: [], pagina: [] }, String(url));
  }
  await assert.rejects(conferirProduto('https://evil.example.com/MLB-1234567890-x'), { message: 'endereço fora do Mercado Livre' });
  assert.equal(acessosRede, antes, 'o leitor padrão também não foi à rede');
});

// ---------------------------------------------------------------- leitor de página padrão (fetch falso)

/** fetch falso: cada URL devolve uma Response; registra a ordem dos pedidos. */
function fetchFalso(rotas) {
  const pedidos = [];
  globalThis.fetch = async (u, init) => {
    pedidos.push(String(u));
    assert.equal(init?.redirect, 'manual', 'o leitor segue os saltos ele mesmo');
    const r = rotas[String(u)];
    if (!r) throw new Error(`rede proibida no teste: ${new URL(String(u)).host}`);
    return r();
  };
  return pedidos;
}

test('leitor de página: segue redirecionamento para o Mercado Livre e lê o estoque', async () => {
  const pedidos = fetchFalso({
    [URL_META]: () => new Response(null, { status: 301, headers: { location: URL_CATALOGO } }),
    [URL_CATALOGO]: () => new Response(paginaJsonLd({ disponibilidade: 'https://schema.org/OutOfStock' }), { status: 200 }),
  });
  assert.deepEqual(await conferirProduto(URL_META), { price: 199.9, disponivel: false });
  assert.deepEqual(pedidos, [URL_META, URL_CATALOGO]);
});

test('leitor de página: redirecionamento para fora do Mercado Livre é recusado sem acessar o outro site', async () => {
  const pedidos = fetchFalso({
    [URL_META]: () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/p/MLB1' } }),
  });
  await assert.rejects(conferirProduto(URL_META), { message: 'endereço fora do Mercado Livre' });
  assert.deepEqual(pedidos, [URL_META]);
});

test('leitor de página: página acima de MAX_PAGINA é recusada', async () => {
  fetchFalso({
    [URL_CATALOGO]: () => new Response('x', { status: 200, headers: { 'content-length': String(MAX_PAGINA + 1) } }),
  });
  await assert.rejects(conferirProduto(URL_CATALOGO), { message: 'página grande demais' });
});

test('S3: http vira https (a Lista de links aceita os dois); porta, usuário e senha, ou outro esquema, são recusados', async () => {
  // http://… (e :80/:443 explícitos, que o URL já tira) é lido pelo https; a API recebe o mesmo anúncio
  for (const url of ['http://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM', 'http://produto.mercadolivre.com.br:80/MLB-1234567890-fone-bom-_JM', 'https://produto.mercadolivre.com.br:443/MLB-1234567890-fone-bom-_JM']) {
    const l = leitores({ api: new Error('API fora'), pagina: paginaJsonLd() });
    assert.deepEqual(await conferirProduto(url, l), { price: 199.9, disponivel: null }, url);
    assert.deepEqual(l.pedidos.pagina, [URL_ANUNCIO], url);
  }
  for (const url of ['https://produto.mercadolivre.com.br:8443/MLB-1234567890-x', 'http://produto.mercadolivre.com.br:8080/MLB-1234567890-x',
    'https://user:senha@produto.mercadolivre.com.br/MLB-1234567890-x', 'https://user@produto.mercadolivre.com.br/MLB-1234567890-x', 'ws://produto.mercadolivre.com.br/MLB-1234567890']) {
    const l = leitores({ api: itemApi(), pagina: paginaJsonLd() });
    await assert.rejects(conferirProduto(url, l), { message: 'endereço fora do Mercado Livre' }, url);
    assert.deepEqual(l.pedidos, { api: [], pagina: [] }, url);
  }
});

test('S3: cada salto do leitor de página é https, sem porta e do Mercado Livre (http no salto é subido para https)', async () => {
  const pedidos = fetchFalso({
    [URL_META]: () => new Response(null, { status: 302, headers: { location: 'http://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM' } }),
    [URL_ANUNCIO]: () => new Response(paginaJsonLd(), { status: 200 }),
  });
  assert.deepEqual(await conferirProduto(URL_META), { price: 199.9, disponivel: null });
  assert.deepEqual(pedidos, [URL_META, URL_ANUNCIO], 'o salto http foi pedido por https');
  for (const salto of ['https://produto.mercadolivre.com.br:8443/MLB-1234567890-x', 'https://u:p@produto.mercadolivre.com.br/MLB-1234567890-x', 'ftp://produto.mercadolivre.com.br/x']) {
    const p = fetchFalso({ [URL_META]: () => new Response(null, { status: 302, headers: { location: salto } }) });
    await assert.rejects(conferirProduto(URL_META), { message: 'endereço fora do Mercado Livre' }, salto);
    assert.deepEqual(p, [URL_META], `${salto}: nada foi pedido a ele`);
  }
});

test('S3: a API pública é lida sem seguir redirecionamento e com teto de bytes', async () => {
  const chamadas = [];
  globalThis.fetch = async (u, init) => {
    chamadas.push({ u: String(u), redirect: init?.redirect });
    return new Response(JSON.stringify(itemApi()), { status: 200 });
  };
  assert.deepEqual(await conferirProduto(URL_ANUNCIO), { price: 199.9, disponivel: true });
  assert.deepEqual(chamadas, [{ u: 'https://api.mercadolibre.com/items/MLB1234567890', redirect: 'error' }]);
  // resposta enorme da API (declarada ou não): a leitura da API falha e cai na página, que não está disponível aqui
  const enorme = JSON.stringify({ ...itemApi(), lixo: 'x'.repeat(MAX_PAGINA + 10) });
  globalThis.fetch = async (u) => (String(u).startsWith('https://api.') ? new Response(enorme, { status: 200 }) : (() => { throw new Error('sem rede'); })());
  await assert.rejects(conferirProduto(URL_ANUNCIO), { message: 'sem rede' });
});

test('leitor de página: resposta de erro lança com o código HTTP', async () => {
  fetchFalso({ [URL_CATALOGO]: () => new Response('não', { status: 403 }) });
  await assert.rejects(conferirProduto(URL_CATALOGO), { message: 'HTTP 403' });
});

// ---------------------------------------------------------------- resolveOffer e busca seguem iguais

test('resolveOffer não devolve disponivel (nem da API nem da página)', async () => {
  const api = await resolveOffer({ key: 'MLB1234567890', url: URL_ANUNCIO }, { fetchJson: async () => itemApi({ status: 'paused' }) });
  assert.ok(!('disponivel' in api));
  assert.deepEqual([api.price, api.oldPrice, api.discountPct, api.sold, api.freeShipping], [199.9, 299.9, 33, 10, true]);

  const pag = await resolveOffer({ key: 'k', url: URL_CATALOGO }, {
    fetchText: async () => paginaJsonLd({ disponibilidade: 'https://schema.org/OutOfStock' }),
  });
  assert.deepEqual(pag, {
    sold: 0, freeShipping: false, title: 'Fone Bom', price: 199.9, oldPrice: 299.9, image: IMAGEM,
    key: 'k', url: URL_CATALOGO, coupon: null, discountPct: 33,
  });
});

test('searchOffers não devolve disponivel', async () => {
  const r = await searchOffers({ query: 'fone' }, { fetchJson: async () => ({ results: [itemApi({ available_quantity: 0 })] }) });
  assert.equal(r.length, 1);
  assert.ok(!('disponivel' in r[0]));
  assert.equal(r[0].price, 199.9);
});

// ---------------------------------------------------------------- digitado

test('parseListLines marca digitado só na linha que traz preço', () => {
  const l = parseListLines(`${URL_ANUNCIO} | Fone Bom | 89,90 | 149,90
https://produto.mercadolivre.com.br/MLB-2222222222-x | Só o título
https://produto.mercadolivre.com.br/MLB-3333333333-x
https://produto.mercadolivre.com.br/MLB-4444444444-x | | 10`);
  assert.equal(l.length, 4);
  assert.deepEqual(l.map((o) => o.digitado), [true, undefined, undefined, true]);
  assert.ok(!('digitado' in l[1]) && !('digitado' in l[2]));
  assert.equal(l[3].price, 10);
});

test('resolveOffer mantém digitado, com o atalho (título e preço) e lendo a página (só preço)', async () => {
  const [completo, soPreco, semPreco] = parseListLines(`${URL_ANUNCIO} | Fone Bom | 89,90
${URL_CATALOGO} | | 120
https://produto.mercadolivre.com.br/MLB-3333333333-x`);
  const r1 = await resolveOffer(completo, { fetchJson: redeBloqueada, fetchText: redeBloqueada });
  assert.equal(r1.digitado, true);
  assert.equal(r1.price, 89.9);

  const r2 = await resolveOffer(soPreco, { fetchText: async () => paginaJsonLd() });
  assert.equal(r2.digitado, true);
  assert.equal(r2.price, 120, 'o preço digitado vale mais que o da página');
  assert.equal(r2.title, 'Fone Bom');

  const r3 = await resolveOffer(semPreco, { fetchJson: async () => itemApi() });
  assert.ok(!('digitado' in r3));
});

// ---------------------------------------------------------------- JSON-LD: varredura linear (S1) e uma passada só

test('S1: milhares de <script sem fechamento não travam a leitura (linear, não quadrática)', { timeout: 30000 }, async () => {
  const MB2 = 2 * 1024 * 1024;
  const casos = {
    'sem ">" nem fechamento': '<script '.repeat(MB2 / 8),
    'com ">" só no fim': `${'<script '.repeat(MB2 / 8)}>`,
    'tag de ld+json sem fechamento': '<script type="application/ld+json">'.repeat(Math.floor(MB2 / 36)),
    'tags de 600 caracteres': `<script ${'a'.repeat(600)}>`.repeat(Math.floor(MB2 / 610)),
    'tags de ld+json abertas e fechadas, vazias': '<script type="application/ld+json"></script>'.repeat(Math.floor(MB2 / 44)),
  };
  for (const [nome, html] of Object.entries(casos)) {
    const t0 = performance.now();
    assert.equal(parseProductHtml(html), null, nome);
    const r = await conferirProduto(URL_ANUNCIO, { fetchJson: async () => { throw new Error('x'); }, fetchText: async () => html });
    const ms = performance.now() - t0;
    assert.deepEqual(r, { price: null, disponivel: null }, nome);
    assert.ok(ms < 200, `${nome}: ${ms.toFixed(0)} ms para duas leituras`);
  }
  // mais de 50 blocos: os primeiros valem, o resto não é lido
  const bloco = (n) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: `P${n}`, offers: { price: String(n) } })}</script>`;
  assert.equal(parseProductHtml(Array.from({ length: 60 }, (_, i) => (i < 55 ? '<script type="application/ld+json">{}</script>' : bloco(i))).join('')), null, 'o 56º bloco já passou do teto');
  assert.equal(parseProductHtml(Array.from({ length: 60 }, (_, i) => (i < 49 ? '<script type="application/ld+json">{}</script>' : bloco(i))).join('')).price, 49, 'o 50º ainda vale');
  // o produto de verdade no fim de uma página enorme de <script solto continua sendo achado
  const ruido = '<script '.repeat(1000);
  assert.equal(parseProductHtml(`${ruido}>${paginaJsonLd()}`).price, 199.9);
});

test('JSON-LD: várias tags e blocos — o produto com preço vale, o estoque é o do produto ou o primeiro que responder', async () => {
  const bloco = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  const semPreco = { '@type': 'Product', name: 'Fone Bom', offers: { '@type': 'Offer', availability: 'https://schema.org/OutOfStock' } };
  const comPreco = (availability) => ({ '@type': 'Product', name: 'Fone Bom', offers: { '@type': 'Offer', price: '90', ...(availability ? { availability } : {}) } });
  const lerCom = (html) => conferirProduto(URL_ANUNCIO, { fetchJson: async () => { throw new Error('x'); }, fetchText: async () => html });
  // produto esgotado sem preço antes do produto com preço: a página diz esgotado e o preço vem do segundo
  assert.deepEqual(await lerCom(`<script src="a.js"></script>${bloco(semPreco)}<script>var x = 1;</script>${bloco(comPreco())}`), { price: 90, disponivel: false });
  // o do produto com preço vale primeiro
  assert.deepEqual(await lerCom(`${bloco(semPreco)}${bloco(comPreco('https://schema.org/InStock'))}`), { price: 90, disponivel: true });
  // sem estoque em nenhum: nulo
  assert.deepEqual(await lerCom(bloco(comPreco())), { price: 90, disponivel: null });
  // bloco que não é JSON, tag de outro tipo, atributo antes do type e fechamento em maiúsculas
  assert.deepEqual(await lerCom(`<script type="application/ld+json">{quebrado</script><script type="text/javascript">1</script><SCRIPT id="x" TYPE='application/ld+json'>${JSON.stringify(comPreco())}</SCRIPT>`), { price: 90, disponivel: null });
});

test('nenhum teste deste arquivo chegou ao fetch global bloqueado', () => {
  assert.equal(acessosRede, 0);
});
