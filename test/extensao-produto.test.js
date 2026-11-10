// Extensão do Chrome, pedido `produto_ml` (verificador, entrega 2, etapa 2 de docs/produto/planos/verificador-ml-extensao.md):
// a extensão lê o preço e o estoque de um produto do Mercado Livre com um fetch do service worker, com a sessão do
// navegador, e devolve só o resumo do JSON-LD ({ estado, ofertas }) que `lerProdutoDaExtensao` (src/ml.js) valida.
// Duas partes: (1) as funções puras do extension/background.js, extraídas pelos marcadores e rodadas num `vm`;
// (2) o background.js inteiro num `vm` com `chrome.*`, `fetch`, `setTimeout`, `AbortSignal.timeout` e `Date` falsos,
// presos a um relógio virtual (`avancar(ms)`). Nenhuma rede: o painel, a Central e as páginas do ML são simulados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { lerProdutoDaExtensao } from '../src/ml.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTE = fs.readFileSync(path.join(RAIZ, 'extension', 'background.js'), 'utf8');

const INI = FONTE.indexOf('// ---- Mercado Livre produto: funções puras (início) ----');
const FIM = FONTE.indexOf('// ---- Mercado Livre produto: funções puras (fim) ----');
assert.ok(INI > 0 && FIM > INI, 'não achei os marcadores do trecho do produto do ML em extension/background.js');
const TRECHO = FONTE.slice(INI, FIM);

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };
test.after(() => assert.equal(acessosRede, 0, 'nenhum teste acessa a rede'));

const plano = (v) => JSON.parse(JSON.stringify(v)); // objetos do vm têm outro protótipo
const X = (() => {
  // sem fetch, chrome nem setTimeout: o trecho puro não pode depender deles
  const ctx = vm.createContext({ URL, TextDecoder });
  vm.runInContext(`${TRECHO};globalThis.__x = { urlProdutoML, estadoDaResposta, corpoDaPaginaML, ofertasDoHtml, MAX_PAGINA_ML, PRODUTO_GRANDE };`, ctx);
  return ctx.__x;
})();

const ML = 'https://www.mercadolivre.com.br';
const CENTRAL = `${ML}/afiliados/hub?is_affiliate=true`;
const SERVIDOR = 'http://127.0.0.1:3737';
const LINK_OK = 'https://meli.la/2abcDEF';
const EM_ESTOQUE = 'https://schema.org/InStock';
const ESGOTADO = 'https://schema.org/OutOfStock';
// Evidência real (Chrome logado do dono, 09/11/2026): o anúncio redireciona para a página de catálogo com o item em
// pdp_filters, que responde 200 com um único JSON-LD ProductGroup e as ofertas em hasVariant.
const ITEM_220 = 'MLB5257531512';
const ITEM_110 = 'MLB5257443218';
const URL_ANUNCIO = `https://produto.mercadolivre.com.br/MLB-${ITEM_220.slice(3)}`;
const URL_FINAL = `${ML}/fritadeira-boa/p/MLB15142194?pdp_filters=item_id:${ITEM_220}`;
const VERIFICACAO = `${ML}/gz/account-verification?go=${encodeURIComponent(URL_ANUNCIO)}`;
const SEGREDO_PAGINA = 'SEGREDO-DA-PAGINA-LOGADA'; // o que só existe no HTML: nunca pode sair da extensão

const variante = (sku, price, availability = EM_ESTOQUE) => ({
  '@type': 'Product', sku, name: `Fritadeira Boa ${price} MX31`,
  offers: { '@type': 'Offer', price, priceCurrency: 'BRL', availability },
});
const grupoLd = (variantes) => ({
  '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Fritadeira Boa', model: 'MX31',
  brand: { '@type': 'Brand', name: 'Boa' }, description: 'Fritadeira.', hasVariant: variantes,
});
const ld = (obj) => `<script type="application/ld+json">${typeof obj === 'string' ? obj : JSON.stringify(obj)}</script>`;
const pagina = (...blocos) => `<html><head><title>${SEGREDO_PAGINA}</title>
<script id="__NORDIC_RENDERING_CTX__">{"offers":{"type":"Offer","price":999.99,"availability":"${EM_ESTOQUE}"}}</script>
${blocos.join('\n')}</head><body><a href="/minha-conta">${SEGREDO_PAGINA}</a></body></html>`;
const PAGINA_REAL = pagina(ld(grupoLd([variante(ITEM_220, 154.99), variante(ITEM_110, 159)])));
const produtoLd = (price, availability = EM_ESTOQUE, extra = {}) => ({ '@type': 'Product', name: 'Fone', offers: { '@type': 'Offer', price, availability }, ...extra });

/** Response com o endereço final (depois dos redirecionamentos), como a do fetch de verdade. */
function resposta(corpo, { status = 200, url = URL_FINAL, headers } = {}) {
  const r = new Response(corpo, { status, headers });
  Object.defineProperty(r, 'url', { value: url });
  return r;
}

// ---------------------------------------------------------------- funções puras

test('urlProdutoML: só anúncio ou catálogo em www./produto.mercadolivre.com.br, sem porta, credenciais nem #, só pdp_filters=item_id na query, na forma que o painel manda (S1)', () => {
  for (const bom of [
    URL_ANUNCIO, URL_FINAL, `https://produto.mercadolivre.com.br/MLB-1234567-fone-_JM`, `${ML}/p/MLB15142194`,
    `${ML}/MLB1234567`, `https://produto.mercadolivre.com.br/MLB-1234567?pdp_filters=item_id:MLB1234567`,
  ]) assert.equal(X.urlProdutoML(bom), bom, bom);
  // outras páginas do Mercado Livre (a extensão busca com a sessão do dono) e query fora do contrato
  for (const ruim of [
    'https://mercadolivre.com.br/MLB-1234567', 'https://myaccount.mercadolivre.com.br/MLB-1234567', 'https://lista.mercadolivre.com.br/p/MLB1',
    `${ML}/jms/mlb/lgz/logout`, `${ML}/perfil`, `${ML}/carrinho`, `${ML}/`, `${ML}/gz/account-verification`, `${ML}/social/p/MLB123`,
    `${ML}/%73ocial/p/MLB123`, `${ML}/social/MLB-1234567`, `${ML}/a/b/p/MLB15142194`, `${ML}/MLB-123456-%2F..%2Fjms%2Flogout`, `${ML}/a%2F..%2Fb/p/MLB123`, `${ML}/p/MLB15142194/s`, `${ML}/p/MLB15142194x`,
    `${ML}/MLB-12345`, `${ML}/MLB-1234567/logout`, `${ML}/MLB-123456789012345678901`, `${ML}/p/MLB1?pdp_filters=item_id%3AMLB2`,
    `${ML}/p/MLB15142194?pdp_filters=item_id%3AMLB5257531512`, `${ML}/p/MLB15142194?pdp_filters=category:MLB1648`,
    `${ML}/p/MLB15142194?pdp_filters=item_id:MLB5257531512,category:MLB1`, `${ML}/p/MLB15142194?pdp_filters=item_id:MLB5257531512&x=1`,
    `${ML}/p/MLB15142194?pdp_filters=item_id:MLB5257531512&pdp_filters=item_id:MLB5257531512`, `${ML}/MLB-1234567?matt_tool=1`, `${ML}/MLB-1234567?`,
    `${ML}/p/MLB15142194?pdp_filters=item_id:mlb5257531512`,
  ]) assert.equal(X.urlProdutoML(ruim), null, ruim);
  for (const ruim of [
    'http://produto.mercadolivre.com.br/MLB-1', 'https://produto.mercadolibre.com/MLB-1', 'https://www.mercadolibre.com.ar/p/MLB1',
    'https://mercadolivre.com.br.evil.com/x', 'https://evilmercadolivre.com.br/x', 'https://evil.com/www.mercadolivre.com.br/x',
    'https://meli.la/1AbCdEf', 'https://www.mercadolivre.com.br:8443/x', 'https://u:p@www.mercadolivre.com.br/x',
    'https://www.mercadolivre.com.br/x#y', 'https://www.mercadolivre.com.br/x#', 'https://WWW.mercadolivre.com.br/x',
    'https://www.mercadolivre.com.br/a b', 'https:\\\\www.mercadolivre.com.br\\x', 'https://www.mercadolivre.com.br',
    'https://www.mercadolivre.com.br./x', 'javascript:alert(1)', `${ML}/${'a'.repeat(2048)}`, '', null, undefined, 42, { href: URL_FINAL },
  ]) assert.equal(X.urlProdutoML(ruim), null, String(ruim).slice(0, 60));
});

test('estadoDaResposta: verificação por endereço final (segmento /gz/, account-verification, captcha; outro host) ou HTTP 403/429', () => {
  assert.deepEqual(plano(X.estadoDaResposta(200, URL_FINAL)), { ler: true });
  assert.deepEqual(plano(X.estadoDaResposta(204, URL_FINAL)), { ler: true });
  for (const [status, url] of [
    [200, VERIFICACAO], [200, `${ML}/gz/qualquer`], [200, 'https://www.mercadolivre.com.br/account-verification'],
    [200, 'https://www.mercadolivre.com.br/CAPTCHA/desafio'], [200, 'https://captcha.mercadolivre.com.br/x'], [200, `${ML}/x/gz`],
    [200, 'https://www.mercadolibre.com/jms/mlb/lgz/login'], [200, 'http://www.mercadolivre.com.br/x'], [200, ''], [200, undefined],
    [403, URL_FINAL], [429, URL_FINAL], [500, VERIFICACAO],
  ]) assert.deepEqual(plano(X.estadoDaResposta(status, url)), { estado: 'verificacao' }, `${status} ${url}`);
  // só host e caminho contam, por rótulo/segmento inteiro: a query e o slug de um produto nunca são a verificação (S1)
  for (const url of [`${ML}/x?captcha=1`, `${ML}/p/MLB1?go=/gz/account-verification`, `${ML}/teclado-anti-captcha-usb/p/MLB123456789`,
    'https://produto.mercadolivre.com.br/MLB-123456789-capa-account-verification-_JM', `${ML}/gzip/p/MLB1`, `${ML}/p/MLB1#captcha`]) {
    assert.deepEqual(plano(X.estadoDaResposta(200, url)), { ler: true }, url);
  }
  assert.deepEqual(plano(X.estadoDaResposta(500, URL_FINAL)), { erro: 'a página do produto respondeu HTTP 500' });
  assert.deepEqual(plano(X.estadoDaResposta(404, URL_FINAL)), { erro: 'a página do produto respondeu HTTP 404' });
  assert.deepEqual(plano(X.estadoDaResposta(301, URL_FINAL)), { erro: 'a página do produto respondeu HTTP 301' });
});

test('ofertasDoHtml: a página real (ProductGroup com hasVariant) vira as variantes, e o servidor escolhe a do anúncio', () => {
  const ofertas = plano(X.ofertasDoHtml(PAGINA_REAL));
  assert.deepEqual(ofertas, [{
    nome: true,
    variantes: [
      { sku: ITEM_220, nome: true, price: 154.99, availability: EM_ESTOQUE },
      { sku: ITEM_110, nome: true, price: 159, availability: EM_ESTOQUE },
    ],
  }]);
  const data = { estado: 'lido', ofertas };
  assert.deepEqual(lerProdutoDaExtensao(data, { url: URL_ANUNCIO }), { price: 154.99, disponivel: true });
  assert.deepEqual(lerProdutoDaExtensao(data, { url: `${ML}/fritadeira-boa/p/MLB15142194?pdp_filters=item_id:${ITEM_110}` }), { price: 159, disponivel: true });
  assert.ok(!JSON.stringify(ofertas).includes('999.99'), 'o __NORDIC_RENDERING_CTX__ não é lido');
});

test('ofertasDoHtml: Product vira { nome, price, availability } (sem sku); lowPrice, preço em texto e @graph', () => {
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(ld(produtoLd(89.9))))), [{ nome: true, price: 89.9, availability: EM_ESTOQUE }]);
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(ld({ '@type': 'Product', offers: [{ lowPrice: 12, availability: ESGOTADO }, { price: 99 }] })))),
    [{ nome: false, price: 12, availability: ESGOTADO }], 'primeira oferta, lowPrice e produto sem nome');
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(ld(produtoLd('89.90'))))), [{ nome: true, price: '89.90', availability: EM_ESTOQUE }]);
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(ld({ '@type': 'Product', name: 'Sem oferta' })))), [{ nome: true, price: null, availability: null }]);
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'BreadcrumbList' }, produtoLd(10)] })))),
    [{ nome: true, price: 10, availability: EM_ESTOQUE }]);
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(ld([{ '@type': 'Organization' }, { '@type': ['Thing', 'Product'], name: 'x', offers: { price: 5 } }])))),
    [{ nome: true, price: 5, availability: null }], '@type em lista e JSON-LD em array');
});

test('ofertasDoHtml: preço e estoque fora do contrato viram null (nunca recusam a página inteira no servidor)', () => {
  // [texto JSON do price, o que a extensão manda]: número fora da faixa, infinito, texto longo ou outro tipo → null
  const casos = [
    ['-1', null], ['10000001', null], ['1e999', null], [JSON.stringify('1'.repeat(31)), null], ['{"valor":1}', null], ['true', null],
    ['0', 0], ['10000000', 10_000_000], [JSON.stringify('1'.repeat(30)), '1'.repeat(30)],
  ];
  for (const [texto, esperado] of casos) {
    const [o] = plano(X.ofertasDoHtml(pagina(ld(`{"@type":"Product","name":"x","offers":{"price":${texto},"availability":"${EM_ESTOQUE}"}}`))));
    assert.equal(o.price, esperado, texto.slice(0, 40));
  }
  for (const [entrada, esperado] of [['x'.repeat(100), 'x'.repeat(100)], ['x'.repeat(101), null], [{ '@id': EM_ESTOQUE }, null], [1, null]]) {
    const [o] = plano(X.ofertasDoHtml(pagina(ld({ '@type': 'Product', name: 'x', offers: { price: 1, availability: entrada } }))));
    assert.equal(o.availability, esperado, JSON.stringify(entrada).slice(0, 20));
  }
  // o servidor aceita tudo o que a extensão produz
  const html = pagina(...['-1', '1e999', JSON.stringify('1'.repeat(31)), '{"a":1}', '"x"'].map((p, i) => ld(`{"@type":"Product","name":"n","offers":{"price":${p},"availability":${JSON.stringify(i === 4 ? 'y'.repeat(101) : EM_ESTOQUE)}}}`)));
  const ofertas = plano(X.ofertasDoHtml(html));
  assert.equal(ofertas.length, 5);
  assert.notEqual(lerProdutoDaExtensao({ estado: 'lido', ofertas }), null, JSON.stringify(ofertas));
});

test('ofertasDoHtml: ProductGroup tem prioridade no bloco; sem variante objeto o bloco é pulado; sku longo vira null; 30 variantes', () => {
  // grupo e Product no mesmo bloco: vale o grupo, mesmo que o Product venha antes
  const mistura = { '@graph': [produtoLd(1), grupoLd([variante(ITEM_220, 2)])] };
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(ld(mistura)))), [{ nome: true, variantes: [{ sku: ITEM_220, nome: true, price: 2, availability: EM_ESTOQUE }] }]);
  // grupo sem variante objeto: nenhum item do bloco (nem o Product ao lado), o próximo bloco conta
  for (const hasVariant of [undefined, [], ['MLB1', 3, null, [variante(ITEM_220, 2)]], 'x']) {
    const g = { '@graph': [produtoLd(1), { ...grupoLd([]), hasVariant }] };
    assert.deepEqual(plano(X.ofertasDoHtml(pagina(ld(g), ld(produtoLd(7))))), [{ nome: true, price: 7, availability: EM_ESTOQUE }], JSON.stringify(hasVariant));
  }
  // variante única (objeto, não lista), sem nome, com sku longo ou não texto
  const v = { '@type': 'Product', sku: 'M'.repeat(31), offers: { price: 3 } };
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(ld({ ...grupoLd([]), name: '', hasVariant: v })))),
    [{ nome: false, variantes: [{ sku: null, nome: false, price: 3, availability: null }] }]);
  const [{ variantes: [vNum] }] = plano(X.ofertasDoHtml(pagina(ld(grupoLd([{ sku: 5257531512, name: 'x', offers: { price: 3 } }])))));
  assert.equal(vNum.sku, null);
  const [{ variantes: [vMax] }] = plano(X.ofertasDoHtml(pagina(ld(grupoLd([variante('M'.repeat(30), 3)])))));
  assert.equal(vMax.sku, 'M'.repeat(30));
  // 31 variantes → as 30 primeiras, e o servidor aceita
  const muitas = Array.from({ length: 31 }, (_, i) => variante(`MLB${1000000 + i}`, i + 1));
  const ofertas = plano(X.ofertasDoHtml(pagina(ld(grupoLd(muitas)))));
  assert.equal(ofertas[0].variantes.length, 30);
  assert.equal(ofertas[0].variantes.at(-1).sku, 'MLB1000029');
  assert.deepEqual(lerProdutoDaExtensao({ estado: 'lido', ofertas }, { url: `${ML}/x/p/MLB9?pdp_filters=item_id:MLB1000029` }), { price: 30, disponivel: true });
});

test('ofertasDoHtml: bloco que não é JSON é pulado, outros scripts não contam, no máximo 5 itens e 50 blocos', () => {
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(ld('{não é json'), ld('null'), ld('"texto"'), ld({ '@type': 'Organization' }), ld(produtoLd(4))))),
    [{ nome: true, price: 4, availability: EM_ESTOQUE }]);
  assert.deepEqual(plano(X.ofertasDoHtml(`<script>${JSON.stringify(produtoLd(1))}</script><script type="text/json">${JSON.stringify(produtoLd(2))}</script>`)), []);
  assert.deepEqual(plano(X.ofertasDoHtml(`<script type='application/ld+json' nonce="x">${JSON.stringify(produtoLd(3))}</script>`)),
    [{ nome: true, price: 3, availability: EM_ESTOQUE }], 'aspas simples e outros atributos');
  // 60 blocos de produto → 5 itens, os primeiros
  const sessenta = Array.from({ length: 60 }, (_, i) => ld(produtoLd(i + 1)));
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(...sessenta))).map((o) => o.price), [1, 2, 3, 4, 5]);
  // 50 blocos sem produto e o produto no 51º → nada (a varredura para nos 50)
  const cinquentaVazios = Array.from({ length: 50 }, () => ld({ '@type': 'BreadcrumbList' }));
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(...cinquentaVazios, ld(produtoLd(9))))), []);
  assert.deepEqual(plano(X.ofertasDoHtml(pagina(...cinquentaVazios.slice(1), ld(produtoLd(9))))).map((o) => o.price), [9], 'o 50º ainda conta');
  for (const vazio of ['', null, undefined, '<html></html>', `<script type="application/ld+json">${JSON.stringify(produtoLd(1))}`]) {
    assert.deepEqual(plano(X.ofertasDoHtml(vazio)), [], String(vazio).slice(0, 30));
  }
});

test('ofertasDoHtml: varredura linear (milhares de <script sem fechamento não travam)', () => {
  const html = '<script '.repeat(250_000) + ld(produtoLd(1));
  const t0 = performance.now();
  X.ofertasDoHtml(html);
  assert.ok(performance.now() - t0 < 2000, `levou ${Math.round(performance.now() - t0)} ms`);
});

test('corpoDaPaginaML: teto de 3 MB pelo content-length e contando o que chega; abaixo dele, o texto inteiro (UTF-8)', async () => {
  assert.equal(X.MAX_PAGINA_ML, 3 * 1024 * 1024);
  assert.equal(await X.corpoDaPaginaML(resposta('preço ação')), 'preço ação');
  const grande = await X.corpoDaPaginaML(resposta('', { headers: { 'content-length': String(X.MAX_PAGINA_ML + 1) } })).then(() => null, (e) => e);
  assert.equal(grande?.message, X.PRODUTO_GRANDE);
  // sem content-length, em pedaços: passa de 3 MB no meio da leitura
  let entregues = 0; let cancelado = false;
  const fluxo = new ReadableStream({
    pull(c) { entregues++; c.enqueue(new Uint8Array(1024 * 1024).fill(97)); },
    cancel() { cancelado = true; },
  });
  const r = resposta(fluxo);
  const e = await X.corpoDaPaginaML(r).then(() => null, (x) => x);
  assert.equal(e?.message, X.PRODUTO_GRANDE);
  assert.ok(cancelado, 'a leitura é cancelada ao passar do teto');
  assert.ok(entregues <= 5, `leu ${entregues} MB`);
  const exato = 'a'.repeat(X.MAX_PAGINA_ML);
  assert.equal((await X.corpoDaPaginaML(resposta(exato))).length, X.MAX_PAGINA_ML, 'exatamente 3 MB passa');
  // multibyte partido entre pedaços
  const bytes = new TextEncoder().encode('ção');
  const partido = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 1)); c.enqueue(bytes.slice(1)); c.close(); } });
  assert.equal(await X.corpoDaPaginaML(resposta(partido)), 'ção');
});

// ---------------------------------------------------------------- o background.js inteiro, com relógio virtual

/**
 * Sobe o background.js com tudo falso e relógio virtual. `jobs`: o que o painel entrega no poll (fila vazia = o
 * painel "fecha" e o laço termina). `pagina(url, init, n)`: o que o fetch do Mercado Livre (fora da Central) devolve:
 * uma Response, 'pendurar' (só volta se o sinal abortar) ou 'surdo' (nunca volta, nem com o sinal).
 */
function montar({ jobs = [], pagina: paginaML = () => resposta(PAGINA_REAL) } = {}) {
  let agora = 0;
  const timers = []; let seqTimer = 0;
  const setTimeoutV = (f, ms = 0, ...a) => { const id = ++seqTimer; timers.push({ id, em: agora + Number(ms || 0), f: () => f(...a) }); return id; };
  const clearTimeoutV = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const drenar = async () => { for (let i = 0; i < 3; i++) { await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 0)); } };
  async function avancar(ms) {
    const alvo = agora + ms;
    await drenar();
    for (let guarda = 0; guarda < 20000; guarda++) {
      const prox = timers.filter((t) => t.em <= alvo).sort((a, b) => a.em - b.em || a.id - b.id)[0];
      if (!prox) break;
      timers.splice(timers.indexOf(prox), 1);
      agora = Math.max(agora, prox.em);
      prox.f();
      await drenar();
    }
    agora = alvo;
    await drenar();
  }
  const AbortSignalV = {
    timeout: (ms) => { const c = new AbortController(); setTimeoutV(() => c.abort(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })), ms); return c.signal; },
  };
  class DataV extends Date {
    constructor(...a) { if (a.length) super(...a); else super(Date.UTC(2026, 10, 9, 12) + agora); }
    static now() { return Date.UTC(2026, 10, 9, 12) + agora; }
  }

  const resultados = []; const tempos = []; const polls = []; const pedidosML = []; const usoChrome = []; const consoleUsado = [];
  const armazenado = { conf: { servidor: SERVIDOR, token: 'tok-painel' }, st: {} };
  const fila = [...jobs];
  const abas = new Map([[5, { id: 5, url: CENTRAL, status: 'complete' }]]);
  const ouvintes = new Set();
  const registrar = (nome, f) => (...a) => { usoChrome.push(nome); return f(...a); };
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
      query: registrar('tabs.query', async () => [...abas.values()].map((t) => ({ ...t }))),
      get: registrar('tabs.get', async (id) => ({ ...abas.get(id) })),
      create: registrar('tabs.create', async () => { throw new Error('o teste não abre aba'); }),
      update: registrar('tabs.update', async (id, { url }) => {
        const aba = abas.get(id); aba.url = url;
        setTimeoutV(() => { for (const f of [...ouvintes]) f(id, { status: 'complete' }); }, 0);
        return { id };
      }),
    },
    scripting: {
      executeScript: registrar('scripting.executeScript', async ({ target, func, args }) => {
        ctx.location = new URL(abas.get(target.tabId).url);
        ctx.document = { querySelector: () => ({ content: 'csrf-da-pagina' }) };
        return [{ result: await func(...args) }];
      }),
    },
  };
  const fetchV = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin === SERVIDOR) {
      assert.equal(init.headers['x-token'], 'tok-painel');
      if (u.pathname === '/api/ext/poll') {
        polls.push({ ...init.headers });
        if (!fila.length) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ job: fila.shift() }), { status: 200 });
      }
      if (u.pathname === '/api/ext/result') { resultados.push(JSON.parse(init.body)); tempos.push(agora); return new Response('{}'); }
      throw new Error(`rota inesperada: ${url}`);
    }
    if (u.origin === ML && u.pathname.startsWith('/affiliate-program/')) {
      return new Response(JSON.stringify({ urls: [{ short_url: LINK_OK }] }), { status: 200 }); // a Central, pela aba
    }
    pedidosML.push({ url: String(url), init: { ...init, headers: init.headers }, em: agora });
    const r = paginaML(String(url), init, pedidosML.length);
    if (r === 'pendurar' || r === 'surdo') {
      return new Promise((_, rej) => {
        if (r === 'surdo') return;
        const s = init.signal;
        const abortou = () => rej(s.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (s?.aborted) abortou(); else s?.addEventListener?.('abort', abortou, { once: true });
      });
    }
    return r;
  };
  const espiao = new Proxy({}, { get: (_, nome) => (...a) => consoleUsado.push([nome, ...a]) });
  const ctx = vm.createContext({
    chrome, fetch: fetchV, URL, Response, Headers, AbortController, AbortSignal: AbortSignalV, TextDecoder, structuredClone,
    console: espiao, setTimeout: setTimeoutV, clearTimeout: clearTimeoutV, Date: DataV,
  });
  vm.runInContext(FONTE, ctx, { filename: 'background.js' });
  return { ctx, avancar, resultados, tempos, polls, pedidosML, usoChrome, consoleUsado, armazenado, get agora() { return agora; } };
}

const jobProduto = (id, url = URL_ANUNCIO) => ({ id, type: 'produto_ml', url });
const jobLink = (id) => ({ id, type: 'link', url: `${ML}/fone/p/MLB1`, tag: 'minhaetiqueta' });
const porId = (m, id) => m.resultados.filter((r) => r.id === id);

test('laço: produto_ml lê com fetch do service worker (credentials include, follow, no-store, sinal, sem cabeçalho forjado) e devolve só { estado, ofertas }', async () => {
  const m = montar({ jobs: [jobProduto(1)] });
  await m.avancar(1000);
  assert.deepEqual(m.resultados, [{
    id: 1, ok: true,
    data: { estado: 'lido', ofertas: [{ nome: true, variantes: [
      { sku: ITEM_220, nome: true, price: 154.99, availability: EM_ESTOQUE },
      { sku: ITEM_110, nome: true, price: 159, availability: EM_ESTOQUE },
    ] }] },
  }]);
  assert.equal(m.pedidosML.length, 1);
  const { url, init } = m.pedidosML[0];
  assert.equal(url, URL_ANUNCIO);
  assert.equal(init.credentials, 'include');
  assert.equal(init.redirect, 'follow');
  assert.equal(init.cache, 'no-store', 'o preço não pode vir do cache HTTP do Chrome');
  assert.ok(init.signal, 'o fetch tem tempo limite');
  assert.equal(init.headers, undefined, 'nenhum cabeçalho forjado');
  assert.equal(init.method, undefined);
  assert.deepEqual(m.usoChrome, [], 'sem aba, sem navegar, sem injetar');
  const texto = JSON.stringify(m.resultados) + JSON.stringify(m.armazenado);
  for (const proibido of [SEGREDO_PAGINA, URL_FINAL, URL_ANUNCIO, 'MLB15142194', '<html', 'Fritadeira']) {
    assert.ok(!texto.includes(proibido), `vazou "${proibido}" para o painel ou o storage`);
  }
  assert.deepEqual(lerProdutoDaExtensao(m.resultados[0].data, { url: URL_ANUNCIO }), { price: 154.99, disponivel: true }, 'o servidor aceita');
  assert.deepEqual(m.consoleUsado, []);
});

test('laço: o poll anuncia x-recursos: produto_ml junto com o token', async () => {
  const m = montar({ jobs: [] });
  await m.avancar(10);
  assert.ok(m.polls.length >= 1);
  for (const h of m.polls) assert.deepEqual(plano(h), { 'x-token': 'tok-painel', 'x-recursos': 'produto_ml' });
});

test('laço: redirecionamento para /gz/account-verification → { estado: verificacao }, sem segunda chamada, sem aba nem storage do ML', async () => {
  for (const final of [VERIFICACAO, `${ML}/x/captcha`, 'https://www.mercadolibre.com/jms/mlb/lgz/login']) {
    const m = montar({ jobs: [jobProduto(1), jobProduto(2)], pagina: () => resposta(pagina(ld(produtoLd(10))), { url: final }) });
    await m.avancar(1000);
    assert.deepEqual(m.resultados, [{ id: 1, ok: true, data: { estado: 'verificacao' } }, { id: 2, ok: true, data: { estado: 'verificacao' } }], final);
    assert.equal(m.pedidosML.length, 2, 'um fetch por pedido, sem repetir');
    assert.deepEqual(m.usoChrome, []);
  }
});

test('laço: HTTP 403 e 429 → verificação; 500 → ok:false com o HTTP; nenhum repete', async () => {
  for (const status of [403, 429]) {
    const m = montar({ jobs: [jobProduto(1)], pagina: () => resposta(SEGREDO_PAGINA, { status }) });
    await m.avancar(1000);
    assert.deepEqual(m.resultados, [{ id: 1, ok: true, data: { estado: 'verificacao' } }], String(status));
    assert.equal(m.pedidosML.length, 1);
  }
  const m = montar({ jobs: [jobProduto(1)], pagina: () => resposta(SEGREDO_PAGINA, { status: 500 }) });
  await m.avancar(1000);
  assert.deepEqual(m.resultados, [{ id: 1, ok: false, error: 'a página do produto respondeu HTTP 500' }]);
  assert.equal(m.pedidosML.length, 1);
  assert.equal(m.armazenado.st.ultimoErro, 'a página do produto respondeu HTTP 500');
});

test('laço: endereço fora do contrato é recusado sem fetch (mercadolibre.com, porta, http, outro host)', async () => {
  const ruins = ['https://produto.mercadolibre.com/MLB-1', `https://www.mercadolivre.com.br:444/x`, 'http://produto.mercadolivre.com.br/MLB-1',
    'https://evil.com/x', 'https://meli.la/1AbCdEf', undefined];
  const m = montar({ jobs: ruins.map((url, i) => ({ id: i + 1, type: 'produto_ml', url })) }); // sem o padrão de jobProduto
  await m.avancar(1000);
  assert.deepEqual(m.resultados, ruins.map((_, i) => ({ id: i + 1, ok: false, error: 'endereço de produto do Mercado Livre recusado pela extensão' })));
  assert.equal(m.pedidosML.length, 0);
  assert.deepEqual(m.usoChrome, []);
});

test('laço: página maior que 3 MB → ok:false, sem o corpo', async () => {
  const m = montar({
    jobs: [jobProduto(1), jobProduto(2)],
    pagina: (_, __, n) => (n === 1
      ? resposta('x', { headers: { 'content-length': String(4 * 1024 * 1024) } })
      : resposta(SEGREDO_PAGINA.repeat(Math.ceil((3 * 1024 * 1024 + 1) / SEGREDO_PAGINA.length)))),
  });
  await m.avancar(1000);
  const erro = 'a página do produto no Mercado Livre é grande demais';
  assert.deepEqual(m.resultados, [{ id: 1, ok: false, error: erro }, { id: 2, ok: false, error: erro }]);
});

test('laço: fetch que respeita o sinal desiste em 12 s; falha de rede tem frase própria; nada do erro original sai', async () => {
  const m = montar({ jobs: [jobProduto(1)], pagina: () => 'pendurar' });
  await m.avancar(30_000);
  assert.deepEqual(m.resultados, [{ id: 1, ok: false, error: 'a página do produto no Mercado Livre não respondeu a tempo' }]);
  assert.equal(m.tempos[0], 12_000);
  const r = montar({ jobs: [jobProduto(1)], pagina: () => { throw new TypeError(`Failed to fetch ${URL_FINAL}`); } });
  await r.avancar(1000);
  assert.deepEqual(r.resultados, [{ id: 1, ok: false, error: 'não consegui abrir a página do produto no Mercado Livre' }]);
});

test('laço: corpo que para no meio e estoura os 12 s → "não respondeu a tempo", sem o que já chegou', async () => {
  const m = montar({
    jobs: [jobProduto(1)],
    pagina: (_, init) => resposta(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(SEGREDO_PAGINA));
        init.signal.addEventListener('abort', () => c.error(init.signal.reason), { once: true });
      },
    })),
  });
  await m.avancar(30_000);
  assert.deepEqual(m.resultados, [{ id: 1, ok: false, error: 'a página do produto no Mercado Livre não respondeu a tempo' }]);
});

test('laço: TETO_PRODUTO de 15 s com o fetch surdo; não marca centralTravada (o link seguinte não recarrega a Central)', async () => {
  const m = montar({ jobs: [jobProduto(1), jobLink(2)], pagina: () => 'surdo' });
  await m.avancar(60_000);
  const [r1] = porId(m, 1);
  assert.deepEqual(r1, { id: 1, ok: false, error: 'a página do produto no Mercado Livre não respondeu a tempo' });
  assert.equal(m.tempos[m.resultados.indexOf(r1)], 15_000, 'o teto do pedido de produto é 15 s, abaixo dos 18 s do servidor');
  assert.deepEqual(porId(m, 2), [{ id: 2, ok: true, link: LINK_OK }]);
  assert.ok(!m.usoChrome.includes('tabs.update'), `a aba da Central foi recarregada: ${m.usoChrome.join(', ')}`);
});

test('laço: tipo desconhecido → ok:false "pedido desconhecido", sem executeScript nem fetch (nunca vira link sem etiqueta)', async () => {
  const m = montar({ jobs: [{ id: 1, type: 'xyz', url: `${ML}/fone/p/MLB1`, tag: 'minhaetiqueta' }, { id: 2, url: `${ML}/fone/p/MLB1`, tag: 'x' }, jobLink(3)] });
  await m.avancar(1000);
  assert.deepEqual(m.resultados.slice(0, 2), [
    { id: 1, ok: false, error: 'pedido desconhecido' },
    { id: 2, ok: false, error: 'pedido desconhecido' },
  ]);
  assert.deepEqual(porId(m, 3), [{ id: 3, ok: true, link: LINK_OK }], 'o link de verdade segue funcionando');
  assert.equal(m.usoChrome.filter((n) => n === 'scripting.executeScript').length, 1, 'só o pedido de link injeta na Central');
  assert.equal(m.pedidosML.length, 0);
});

test('background.js: o trecho do produto não usa chrome.* nem console, e a leitura não abre aba', () => {
  assert.doesNotMatch(TRECHO, /\bchrome\.[a-z]|\bconsole\.|\bfetch\(/);
  const ini = FONTE.indexOf('async function lerProdutoML(');
  const ler = FONTE.slice(ini, FONTE.indexOf('\n}\n', ini));
  assert.ok(ler.length > 100, 'não achei lerProdutoML');
  assert.doesNotMatch(ler, /\bchrome\.|executeScript|tabs\./);
});
