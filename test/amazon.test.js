// Testes de src/amazon.js (plano espelhamento-amazon, etapa 3; CA1, CA2, CA3, CA7 e CA10; correções R4, R7/Q10, S4, Q12, S6 e a falha passageira fora do cache negativo).
// Tudo com fetch injetado (fetchFalso): o fetch global fica bloqueado no arquivo inteiro e o último teste
// prova que ele nunca foi chamado.
import test from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import {
  extrairAsin, resolverLink, LinkNaoResolvido, ErroAmazon, IMAGEM_AMAZON, createAmazon, ofertaDoItem,
  URL_GET_ITEMS, URL_TOKEN, RECURSOS, ASIN_TESTE, MENSAGENS_AMAZON, HOSTS_AMAZON,
} from '../src/amazon.js';

// ------------------------------------------------------------------------------------------- rede bloqueada
const fetchOriginal = globalThis.fetch;
let chamadasGlobais = 0;
test.before(() => { globalThis.fetch = async () => { chamadasGlobais++; throw new Error('rede proibida no teste'); }; });
test.after(() => { globalThis.fetch = fetchOriginal; });

// ------------------------------------------------------------------------------------------------ dados
const ID = 'amzn1.application-oa2-client.IDSECRETO0123456789';
const SECRET = 'SEGREDO-Super-Secreto-xyz789!';
const TOKEN = 'Atza|TOKEN-ULTRA-SECRETO-abc123';
const TAG = 'dono-20';
const ASIN = 'B0FG2MD49G';
const IMG = 'https://m.media-amazon.com/images/I/71abcDEF12L._AC_SL1500_.jpg';
const SEGREDOS = [ID, SECRET, TOKEN, 'IDSECRETO', 'Super-Secreto', 'ULTRA-SECRETO'];

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

function bancoCom({ config = {}, segredos = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE conexoes (plataforma TEXT PRIMARY KEY, config TEXT NOT NULL DEFAULT '{}', segredos TEXT NOT NULL DEFAULT '{}', updated_at INTEGER)");
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos) VALUES ('amazon', ?, ?)").run(JSON.stringify(config), JSON.stringify(segredos));
  return db;
}
const completo = (extra = {}) => bancoCom({ config: { tag: TAG, credencial_versao: '3.1', ...extra.config }, segredos: { credencial_id: ID, credencial_secret: SECRET, ...extra.segredos } });
function trocar(db, { config, segredos }) {
  if (config) db.prepare("UPDATE conexoes SET config = ? WHERE plataforma = 'amazon'").run(JSON.stringify(config));
  if (segredos) db.prepare("UPDATE conexoes SET segredos = ? WHERE plataforma = 'amazon'").run(JSON.stringify(segredos));
}

function relogio(inicio = 1_700_000_000_000) {
  const r = { t: inicio, esperas: [] };
  r.agora = () => r.t;
  r.esperar = async (ms) => { r.esperas.push(ms); r.t += ms; };
  return r;
}

function itemApi(asin = ASIN, extra = {}) {
  return {
    asin, detailPageURL: `https://www.amazon.com.br/dp/${asin}?tag=OUTRA-20&linkCode=ogi`,
    itemInfo: { title: { displayValue: '  Roteador Mesh TP-Link Deco BE22,  Wi-Fi 7  ' } },
    images: { primary: { large: { url: IMG, height: 500, width: 500 } } },
    offersV2: { listings: [
      { isBuyBoxWinner: false, price: { money: { amount: 1500, currency: 'BRL' } }, availability: { type: 'IN_STOCK' } },
      { isBuyBoxWinner: true, condition: { value: 'New' }, availability: { type: 'IN_STOCK' },
        price: { money: { amount: 1310.05, currency: 'BRL' }, savingBasis: { money: { amount: 1999, currency: 'BRL' }, savingBasisType: 'LIST_PRICE' },
          savings: { money: { amount: 688.95 }, percentage: 34 } } },
    ] },
    ...extra,
  };
}

/** Handler padrão: token OK e GetItems devolvendo os ASINs pedidos (exceto os de `ausentes`). */
function apiOk({ ausentes = [], expires = 3600, comErros = false } = {}) {
  return (url, init) => {
    if (url.endsWith('/auth/o2/token')) return json(200, { access_token: TOKEN, token_type: 'bearer', expires_in: expires });
    if (url === URL_GET_ITEMS) {
      const { itemIds } = JSON.parse(init.body);
      const items = itemIds.filter((a) => !ausentes.includes(a)).map((a) => itemApi(a));
      const corpo = { itemsResult: { items } };
      if (comErros) corpo.errors = ausentes.map((a) => ({ code: 'ItemNotAccessible', message: `The ItemId ${a} is not accessible through the Creators API.` }));
      return json(200, corpo);
    }
    throw new Error(`url inesperada: ${url}`);
  };
}

const capturarErro = async (fn) => { try { await fn(); } catch (e) { return e; } assert.fail('deveria ter lançado'); };

// ------------------------------------------------------------------------------------------ extrairAsin
test('amazon: extrairAsin lê todos os formatos de link de produto, com e sem parâmetros e sem distinguir caixa', () => {
  const casos = [
    'https://www.amazon.com.br/dp/B0FG2MD49G',
    'https://www.amazon.com.br/dp/B0FG2MD49G/',
    'https://www.amazon.com.br/dp/b0fg2md49g?th=1',
    'https://www.amazon.com.br/Roteador-TP-Link-Deco-BE22/dp/B0FG2MD49G?tag=terceiro-20&crid=2X&dib=eyJ&sr=8-1&qid=1730&linkId=abc&ascsubtag=x',
    'https://amazon.com.br/Roteador/dp/B0FG2MD49G/ref=sr_1_1?keywords=deco',
    'HTTPS://WWW.AMAZON.COM.BR/DP/B0FG2MD49G',
    'http://www.amazon.com.br/dp/B0FG2MD49G',
    'www.amazon.com.br/dp/B0FG2MD49G',
    'amazon.com.br/dp/B0FG2MD49G?psc=1',
    'https://www.amazon.com.br/gp/product/B0FG2MD49G?pf_rd_r=1',
    'https://www.amazon.com.br/gp/aw/d/B0FG2MD49G',
    'https://www.amazon.com.br/exec/obidos/ASIN/B0FG2MD49G',
    'https://www.amazon.com.br/gp/offer-listing?asin=B0FG2MD49G',
    'https://www.amazon.com/dp/B0FG2MD49G',
    'https://smile.amazon.com/Algo/dp/B0FG2MD49G',
    '  https://www.amazon.com.br/dp/B0FG2MD49G#detalhes  ',
  ];
  for (const url of casos) assert.equal(extrairAsin(url), ASIN, url);
  assert.equal(extrairAsin('https://www.amazon.com.br/dp/8535914846'), '8535914846'); // ASIN de livro (ISBN-10)
});

test('amazon: extrairAsin recusa falsos e nunca trata o código de encurtador como ASIN', () => {
  const falsos = [
    'https://link.amazon/B0FG2MD49G',          // código do link.amazon não é ASIN
    'https://link.amazon/dp/B0FG2MD49G',
    'https://amzn.to/B0FG2MD49G',
    'https://amzn.to/3XyZaBcD12',
    'https://amzn.com/B0FG2MD49G',
    'https://a.co/d/B0FG2MD49G',
    'https://www.amazon.com.br.golpe.com/dp/B0FG2MD49G',
    'https://golpe.com/www.amazon.com.br/dp/B0FG2MD49G',
    'https://notamazon.com.br/dp/B0FG2MD49G',
    'https://amazon.com.br@golpe.com/dp/B0FG2MD49G',
    'https://user:senha@www.amazon.com.br/dp/B0FG2MD49G',
    'https://www.amazon.com.br/dp/B0FG2MD49',    // 9 caracteres
    'https://www.amazon.com.br/dp/B0FG2MD49GX',  // 11 caracteres
    'https://www.amazon.com.br/dp/B0FG2MD-9G',
    'https://www.amazon.com.br/s?k=roteador',
    'https://www.amazon.com.br/',
    'https://www.amazon.com.br/xdp/B0FG2MD49G',
    'ftp://www.amazon.com.br/dp/B0FG2MD49G',
    'javascript:alert(1)//www.amazon.com.br/dp/B0FG2MD49G',
    `https://www.amazon.com.br/dp/B0FG2MD49G?x=${'a'.repeat(2100)}`,
    '', '   ', 'texto qualquer', null, undefined, 42, {},
  ];
  for (const url of falsos) assert.equal(extrairAsin(url), null, String(url).slice(0, 80));
});

// ------------------------------------------------------------------------------------------ resolverLink
test('amazon: resolverLink com ASIN na URL devolve sem rede e sem os parâmetros de terceiro', async () => {
  const f = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  const r = await resolverLink('https://www.amazon.com.br/Roteador-Deco/dp/b0fg2md49g?tag=terceiro-20&crid=ABC&linkId=9', { fetch: f, cache: new Map() });
  assert.deepEqual(r, { asin: ASIN, urlFinal: 'https://www.amazon.com.br/Roteador-Deco/dp/b0fg2md49g' });
  assert.equal(f.chamadas.length, 0);
});

test('amazon: resolverLink segue a cadeia 301/302 do link.amazon só com GET e chega ao ASIN limpo', async () => {
  const cancelados = [];
  const comCorpo = (status, location) => {
    const i = cancelados.push(false) - 1;
    const body = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('<html>…</html>')); }, cancel() { cancelados[i] = true; } });
    return new Response(body, { status, headers: { location } });
  };
  const final = 'https://www.amazon.com.br/Roteador-Mesh-TP-Link-Deco-BE22/dp/B0FG2MD49G?tag=terceiro-20&crid=2XYZ&dib=eyJ2&dib_tag=se&keywords=deco&qid=1730&sr=8-1&linkCode=sl1&linkId=abc&ascsubtag=xyz';
  const f = fetchFalso((url, init, n) => {
    assert.equal(init.method, 'GET');
    if (n === 1) { assert.equal(url, 'https://link.amazon/aB3xYz9Q'); return comCorpo(301, 'https://amzn.to/4hJkLmN'); }
    if (n === 2) { assert.equal(url, 'https://amzn.to/4hJkLmN'); return comCorpo(302, final); }
    return assert.fail('salto a mais');
  });
  const r = await resolverLink('https://link.amazon/aB3xYz9Q', { fetch: f, cache: new Map() });
  assert.deepEqual(r, { asin: ASIN, urlFinal: 'https://www.amazon.com.br/Roteador-Mesh-TP-Link-Deco-BE22/dp/B0FG2MD49G' });
  assert.doesNotMatch(JSON.stringify(r), /terceiro|crid|dib|qid|sr=|linkId|ascsubtag|tag=/);
  assert.equal(f.chamadas.length, 2, 'parou no primeiro Location com ASIN');
  for (const { init } of f.chamadas) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.match(init.headers['User-Agent'], /^Mozilla\/5\.0 .+Chrome\//);
    assert.equal(init.headers['Accept-Language'], 'pt-BR');
    assert.equal(init.body, undefined);
  }
  assert.deepEqual(cancelados, [true, true], 'corpo cancelado sem leitura');
});

test('amazon: resolverLink aceita Location relativo, link sem esquema e http (vira https)', async () => {
  const f = fetchFalso((url, init, n) => {
    if (n === 1) { assert.equal(url, 'https://amzn.to/xyz'); return redirecionar(301, '/d/abc'); }
    if (n === 2) { assert.equal(url, 'https://amzn.to/d/abc'); return redirecionar(302, 'http://www.amazon.com.br/gp/product/B0FG2MD49G?tag=x-20'); }
    return assert.fail('salto a mais');
  });
  assert.deepEqual(await resolverLink('amzn.to/xyz', { fetch: f, cache: new Map() }),
    { asin: ASIN, urlFinal: 'https://www.amazon.com.br/gp/product/B0FG2MD49G' });
  const g = fetchFalso((url) => { assert.equal(url, 'https://a.co/d/7Kx'); return redirecionar(301, 'https://www.amazon.com.br/dp/B0FG2MD49G'); });
  assert.equal((await resolverLink('http://a.co/d/7Kx', { fetch: g, cache: new Map() })).asin, ASIN);
  const h = fetchFalso((url) => { assert.equal(url, 'https://amzn.com/abc'); return redirecionar(308, 'https://www.amazon.com/dp/B0FG2MD49G'); });
  assert.equal((await resolverLink('HTTPS://AMZN.COM/abc', { fetch: h, cache: new Map() })).asin, ASIN);
});

test('amazon: resolverLink recusa host fora da lista (na entrada e no Location) sem acessar esse host', async () => {
  const nunca = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  for (const url of ['https://golpe.com/dp/B0FG2MD49G', 'https://bit.ly/abc', 'https://127.0.0.1/x', 'https://[::1]/x',
    'https://amzn.to:8443/x', 'https://link.amazon.golpe.com/x', 'file:///etc/passwd', 'https://user:pw@amzn.to/x', '', null]) {
    const e = await capturarErro(() => resolverLink(url, { fetch: nunca, cache: new Map() }));
    assert.ok(e instanceof LinkNaoResolvido, String(url));
    assert.equal(e.causa, 'invalido');
    assert.equal(e.codigo, 'invalido');
  }
  assert.equal(nunca.chamadas.length, 0);
  for (const destino of ['https://golpe.com/dp/B0FG2MD49G', 'https://169.254.169.254/latest/meta-data', 'https://amzn.to:8080/x', 'gopher://amzn.to/x']) {
    const f = fetchFalso(() => redirecionar(302, destino));
    const e = await capturarErro(() => resolverLink('https://amzn.to/abc', { fetch: f, cache: new Map() }));
    assert.equal(e.causa, 'invalido', destino);
    assert.equal(f.chamadas.length, 1, `não seguiu para ${destino}`);
    assert.ok(!e.message.includes('golpe') && !e.message.includes('amzn'), 'mensagem sem URL');
  }
});

test('amazon: resolverLink para em 5 saltos, e resposta 3xx sem Location é inválida', async () => {
  const f = fetchFalso((url, init, n) => redirecionar(301, `https://amzn.to/salto${n}`));
  const e = await capturarErro(() => resolverLink('https://amzn.to/inicio', { fetch: f, cache: new Map() }));
  assert.equal(e.causa, 'invalido');
  assert.equal(f.chamadas.length, 5);

  // 5º salto ainda chega ao ASIN
  const g = fetchFalso((url, init, n) => redirecionar(302, n < 5 ? `https://amzn.to/s${n}` : 'https://www.amazon.com.br/dp/B0FG2MD49G'));
  assert.equal((await resolverLink('https://amzn.to/ok', { fetch: g, cache: new Map() })).asin, ASIN);
  assert.equal(g.chamadas.length, 5);

  const h = fetchFalso(() => redirecionar(302, null));
  assert.equal((await capturarErro(() => resolverLink('https://link.amazon/semloc', { fetch: h, cache: new Map() }))).causa, 'invalido');
});

test('amazon: resolverLink: página da Amazon sem ASIN é "nao_produto"; erro, 404, 200 no encurtador e timeout são "invalido"', async () => {
  const busca = fetchFalso((url, init, n) => (n === 1 ? redirecionar(301, 'https://www.amazon.com.br/s?k=roteador&tag=terceiro-20') : new Response('<html>', { status: 200 })));
  const e1 = await capturarErro(() => resolverLink('https://amzn.to/busca', { fetch: busca, cache: new Map() }));
  assert.ok(e1 instanceof LinkNaoResolvido);
  assert.equal(e1.causa, 'nao_produto');
  assert.equal(e1.message, 'Este link da Amazon não leva a um produto.');

  const loja = fetchFalso(() => new Response(null, { status: 200 }));
  assert.equal((await capturarErro(() => resolverLink('https://www.amazon.com.br/stores/Marca/page/123', { fetch: loja, cache: new Map() }))).causa, 'nao_produto');

  const casos = [
    () => new Response('nada', { status: 404 }),                         // o que o HEAD faria
    () => new Response('<meta http-equiv="refresh">', { status: 200 }),  // encurtador que só devolve HTML
    () => new Response('erro', { status: 503 }),
    () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
    () => { throw new TypeError('fetch failed'); },
    () => ({ status: 302, headers: { get: () => 'https://exemplo.invalido:99999/' } }),
  ];
  for (const handler of casos) {
    const f = fetchFalso(handler);
    const e = await capturarErro(() => resolverLink('https://link.amazon/xyz', { fetch: f, cache: new Map() }));
    assert.ok(e instanceof LinkNaoResolvido);
    assert.equal(e.causa, 'invalido');
    assert.equal(e.message, 'Não consegui abrir este link da Amazon.');
  }
});

test('amazon: resolverLink guarda o resultado em cache por 1 h', async () => {
  const cache = new Map(); const rel = relogio();
  const f = fetchFalso(() => redirecionar(301, 'https://www.amazon.com.br/x/dp/B0FG2MD49G?tag=t-20'));
  const opts = { fetch: f, cache, agora: rel.agora };
  await resolverLink('https://amzn.to/cache', opts);
  await resolverLink('https://amzn.to/cache', opts);
  assert.equal(f.chamadas.length, 1);
  rel.t += 60 * 60 * 1000 + 1;
  await resolverLink('https://amzn.to/cache', opts);
  assert.equal(f.chamadas.length, 2);
});

// ------------------------------------------------------------------ link.amazon → amzlinks.in → amazon.com.br
// Bug de campo: https://link.amazon/B0boeV5q0 responde 302 para https://amzlinks.in/B0boeV5q0, que responde 302 para o
// link longo do produto. amzlinks.in não é host da Amazon (HOSTS_AMAZON não muda): vale só como salto intermediário.
const URL_LINK_AMAZON = 'https://link.amazon/B0boeV5q0';
const URL_AMZLINKS = 'https://amzlinks.in/B0boeV5q0';
const ASIN_IPHONE = 'B0HJB1C68N';
const LONGO_IPHONE = `https://www.amazon.com.br/Apple-iPhone-Pro-Max-256/dp/${ASIN_IPHONE}?__mk_pt_BR=%C3%85M%C3%85%C5%BD%C3%95%C3%91&tag=desejodemen01-20&linkId=abc123&ascsubtag=xyz&btn_ref=ref1`;

/** link.amazon → amzlinks.in → produto, como o curl real mostrou (o produto responde 200). */
const cadeiaAmzlinks = (estado = {}) => fetchFalso((url) => {
  if (url === URL_LINK_AMAZON) return redirecionar(302, URL_AMZLINKS);
  if (url === URL_AMZLINKS) return redirecionar(302, estado.destino ?? LONGO_IPHONE);
  if (url.startsWith('https://www.amazon.com.br/')) return new Response('<html>', { status: 200 });
  return assert.fail(`rede não prevista: ${url}`);
});

test('amazon: resolverLink segue link.amazon → amzlinks.in → produto e devolve o ASIN com a URL sem query', async () => {
  const f = cadeiaAmzlinks();
  const r = await resolverLink(URL_LINK_AMAZON, { fetch: f, cache: null });
  assert.deepEqual(r, { asin: ASIN_IPHONE, urlFinal: `https://www.amazon.com.br/Apple-iPhone-Pro-Max-256/dp/${ASIN_IPHONE}` });
  assert.doesNotMatch(JSON.stringify(r), /desejodemen|linkId|ascsubtag|btn_ref|__mk_pt_BR|tag=/);
  assert.deepEqual(f.chamadas.map((c) => c.url), [URL_LINK_AMAZON, URL_AMZLINKS], 'só dois GETs; parou no Location com ASIN');
  for (const { init } of f.chamadas) { assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); }
});

test('amazon: resolverLink aceita amzlinks.in vindo de outro encurtador (amzn.to), recusa subdomínio dele sem buscá-lo e cacheia o resultado', async () => {
  const f = fetchFalso((url, init, n) => (n === 1 ? redirecionar(301, 'https://amzlinks.in/abc') : redirecionar(302, LONGO_IPHONE)));
  assert.equal((await resolverLink('https://amzn.to/abc', { fetch: f, cache: new Map() })).asin, ASIN_IPHONE);
  assert.deepEqual(f.chamadas.map((c) => c.url), ['https://amzn.to/abc', 'https://amzlinks.in/abc']);

  // S1: amzlinks.in é de terceiro; só o host exato vale como salto. Subdomínio é 'invalido' e nunca é buscado.
  for (const destino of ['https://x.amzlinks.in/abc', 'https://a.b.amzlinks.in/abc', 'https://X.AMZLINKS.IN/abc']) {
    const s = fetchFalso((url, init, n) => (n === 1 ? redirecionar(301, destino) : redirecionar(302, LONGO_IPHONE)));
    const e = await capturarErro(() => resolverLink('https://amzn.to/abc', { fetch: s, cache: null }));
    assert.ok(e instanceof LinkNaoResolvido, destino);
    assert.equal(e.causa, 'invalido', destino);
    assert.deepEqual(s.chamadas.map((c) => c.url), ['https://amzn.to/abc'], `não buscou ${destino}`);
  }

  const cache = new Map();
  const g = cadeiaAmzlinks();
  await resolverLink(URL_LINK_AMAZON, { fetch: g, cache });
  await resolverLink(URL_LINK_AMAZON, { fetch: g, cache });
  assert.equal(g.chamadas.length, 2, 'a segunda chamada saiu do cache');
});

test('amazon: amzlinks.in colado direto continua inválido, sem nenhuma chamada de rede (só vale como salto)', async () => {
  const nunca = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  for (const url of [URL_AMZLINKS, 'amzlinks.in/B0boeV5q0', 'http://amzlinks.in/x', 'https://x.amzlinks.in/x']) {
    const e = await capturarErro(() => resolverLink(url, { fetch: nunca, cache: null }));
    assert.ok(e instanceof LinkNaoResolvido, url);
    assert.equal(e.causa, 'invalido', url);
  }
  assert.equal(nunca.chamadas.length, 0);
  assert.equal(extrairAsin(URL_AMZLINKS), null);
});

test('amazon: salto em amzlinks.in que vai para fora, para http:// ou para porta explícita é inválido e o destino nunca é buscado', async () => {
  for (const destino of ['https://evil.example/x', 'https://amzlinks.in.evil.example/x', 'https://amzlinks.in:8443/x',
    'http://evil.example/dp/B0HJB1C68N', 'https://169.254.169.254/latest/meta-data', 'gopher://amzlinks.in/x']) {
    const f = fetchFalso((url) => (url === URL_LINK_AMAZON ? redirecionar(302, URL_AMZLINKS) : redirecionar(302, destino)));
    const e = await capturarErro(() => resolverLink(URL_LINK_AMAZON, { fetch: f, cache: null }));
    assert.ok(e instanceof LinkNaoResolvido, destino);
    assert.equal(e.causa, 'invalido', destino);
    assert.deepEqual(f.chamadas.map((c) => c.url), [URL_LINK_AMAZON, URL_AMZLINKS], `foi até o salto e parou, sem buscar ${destino}`);
  }
});

test('amazon: amzlinks.in sem Location, em 200 ou fora do ar é inválido (nunca nao_produto); 5xx não entra no cache', async () => {
  const casos = [() => redirecionar(302, null), () => new Response('<html>', { status: 200 }), () => new Response('x', { status: 404 }),
    () => new Response('erro', { status: 503 }), () => { throw new TypeError('fetch failed'); }];
  for (const handler of casos) {
    const f = fetchFalso((url) => (url === URL_LINK_AMAZON ? redirecionar(302, URL_AMZLINKS) : handler()));
    const e = await capturarErro(() => resolverLink(URL_LINK_AMAZON, { fetch: f, cache: null }));
    assert.equal(e.causa, 'invalido');
    assert.equal(f.chamadas.length, 2, 'o salto em amzlinks.in foi tentado');
  }
  const cache = new Map(); let ok = false;
  const f = fetchFalso((url) => (url === URL_LINK_AMAZON ? redirecionar(302, URL_AMZLINKS) : ok ? redirecionar(302, LONGO_IPHONE) : new Response('erro', { status: 503 })));
  await capturarErro(() => resolverLink(URL_LINK_AMAZON, { fetch: f, cache }));
  ok = true;
  assert.equal((await resolverLink(URL_LINK_AMAZON, { fetch: f, cache })).asin, ASIN_IPHONE, 'a falha passageira não ficou guardada');
});

test('amazon: o limite de 5 saltos vale contando o salto em amzlinks.in', async () => {
  const loop = fetchFalso((url, init, n) => redirecionar(301, `https://amzlinks.in/s${n}`));
  const e = await capturarErro(() => resolverLink('https://link.amazon/inicio', { fetch: loop, cache: null }));
  assert.equal(e.causa, 'invalido');
  assert.equal(loop.chamadas.length, 5);

  const g = fetchFalso((url, init, n) => redirecionar(302, n < 5 ? `https://amzlinks.in/s${n}` : LONGO_IPHONE));
  assert.equal((await resolverLink('https://link.amazon/ok', { fetch: g, cache: null })).asin, ASIN_IPHONE);
  assert.equal(g.chamadas.length, 5);
});

test('amazon: a lista de hosts da Amazon não ganhou amzlinks.in (ele é só salto)', () => {
  assert.ok(!HOSTS_AMAZON.some((h) => h.includes('amzlinks')));
  assert.deepEqual([...HOSTS_AMAZON], ['link.amazon', 'amzn.to', 'amzn.com', 'a.co', 'amazon.com.br', 'amazon.com']);
});

test('amazon: createAmazon.resolver (o que lojas e envios usam) atravessa o amzlinks.in', async () => {
  const f = cadeiaAmzlinks();
  const amazon = createAmazon({ db: completo(), fetch: f, esperar: async () => {} });
  assert.deepEqual(await amazon.resolver(URL_LINK_AMAZON), { asin: ASIN_IPHONE, urlFinal: `https://www.amazon.com.br/Apple-iPhone-Pro-Max-256/dp/${ASIN_IPHONE}` });
});

// ------------------------------------------------------------------------------------------ createAmazon
test('amazon: token OAuth e GetItems com URL, cabeçalhos e corpo do contrato; parser do offersV2', async () => {
  const db = completo(); const rel = relogio();
  const f = fetchFalso(apiOk());
  const amazon = createAmazon({ db, fetch: f, agora: rel.agora, esperar: rel.esperar });
  const oferta = await amazon.lerItem('b0fg2md49g');

  assert.equal(f.chamadas.length, 2);
  const [tok, get] = f.chamadas;
  assert.equal(tok.url, 'https://api.amazon.com/auth/o2/token');
  assert.equal(tok.init.method, 'POST');
  assert.deepEqual(tok.init.headers, { 'Content-Type': 'application/json', Accept: 'application/json' });
  assert.deepEqual(JSON.parse(tok.init.body), { grant_type: 'client_credentials', client_id: ID, client_secret: SECRET, scope: 'creatorsapi::default' });
  assert.ok(tok.init.signal instanceof AbortSignal);

  assert.equal(get.url, 'https://creatorsapi.amazon/catalog/v1/getItems');
  assert.equal(get.init.method, 'POST');
  assert.deepEqual(get.init.headers, { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'x-marketplace': 'www.amazon.com.br' });
  assert.deepEqual(JSON.parse(get.init.body), {
    itemIds: [ASIN], itemIdType: 'ASIN', marketplace: 'www.amazon.com.br', partnerTag: TAG,
    languagesOfPreference: ['pt_BR'], condition: 'New',
    resources: ['itemInfo.title', 'images.primary.large', 'offersV2.listings.price', 'offersV2.listings.availability',
      'offersV2.listings.condition', 'offersV2.listings.isBuyBoxWinner'],
  });
  assert.deepEqual(RECURSOS, JSON.parse(get.init.body).resources);
  assert.ok(get.init.signal instanceof AbortSignal);

  assert.deepEqual(oferta, {
    key: `ASIN:${ASIN}`, asin: ASIN, title: 'Roteador Mesh TP-Link Deco BE22, Wi-Fi 7',
    price: 1310.05, oldPrice: 1999, discountPct: 34, image: IMG,
    sold: null, freeShipping: false, coupon: null, disponivel: true,
  });
  assert.ok(!JSON.stringify(oferta).includes('detailPageURL') && !JSON.stringify(oferta).includes('OUTRA-20'), 'detailPageURL não é usado');
  assert.deepEqual(amazon.situacao(), { acesso: 'ok', verificado_em: rel.t, motivo: null });
});

test('amazon: endpoint do token pela versão da credencial (3.1 NA, 3.2 EU, 3.3 FE; inválida → 3.1)', async () => {
  for (const [versao, url] of [['3.1', URL_TOKEN['3.1']], ['3.2', 'https://api.amazon.co.uk/auth/o2/token'],
    ['3.3', 'https://api.amazon.co.jp/auth/o2/token'], ['9.9', 'https://api.amazon.com/auth/o2/token'], [undefined, 'https://api.amazon.com/auth/o2/token']]) {
    const f = fetchFalso(apiOk()); const rel = relogio();
    const amazon = createAmazon({ db: completo({ config: { credencial_versao: versao } }), fetch: f, agora: rel.agora, esperar: rel.esperar });
    await amazon.lerItem(ASIN);
    assert.equal(f.chamadas[0].url, url, String(versao));
  }
});

test('amazon: token em cache até expires_in − 60 s; renovado ao invalidar, ao vencer e ao trocar a credencial', async () => {
  const db = completo(); const rel = relogio();
  const f = fetchFalso(apiOk({ expires: 3600 }));
  const amazon = createAmazon({ db, fetch: f, agora: rel.agora, esperar: rel.esperar });
  const tokens = () => f.chamadas.filter((c) => c.url.endsWith('/auth/o2/token')).length;

  await amazon.lerItens(['B000000001']);
  await amazon.lerItens(['B000000002']);
  assert.equal(tokens(), 1, 'reaproveita o token');

  rel.t += (3600 - 60) * 1000;
  await amazon.lerItens(['B000000003']);
  assert.equal(tokens(), 2, 'renova perto de vencer');

  amazon.invalidarToken();
  await amazon.lerItens(['B000000004']);
  assert.equal(tokens(), 3, 'invalidarToken força um novo');

  trocar(db, { segredos: { credencial_id: `${ID}X`, credencial_secret: SECRET } });
  await amazon.lerItens(['B000000005']);
  assert.equal(tokens(), 4, 'credencial nova, token novo');
  assert.equal(JSON.parse(f.chamadas.at(-2).init.body).client_id, `${ID}X`, 'credencial lida na hora da chamada');

  // Pedidos simultâneos dividem o mesmo pedido de token.
  amazon.invalidarToken();
  await Promise.all([amazon.lerItens(['B000000006']), amazon.lerItens(['B000000007'])]);
  assert.equal(tokens(), 5);
});

test('amazon: 401 no GetItems invalida o token e tenta uma vez; 401 de novo é credenciais_invalidas', async () => {
  const rel = relogio(); let gets = 0;
  const f = fetchFalso((url, init) => {
    if (url.endsWith('/auth/o2/token')) return json(200, { access_token: TOKEN, expires_in: 3600 });
    gets++;
    return gets === 1 ? json(401, { type: 'UnauthorizedException', reason: 'TokenExpired' }) : apiOk()(url, init);
  });
  const amazon = createAmazon({ db: completo(), fetch: f, agora: rel.agora, esperar: rel.esperar });
  assert.equal((await amazon.lerItem(ASIN)).price, 1310.05);
  assert.deepEqual(f.chamadas.map((c) => c.url.split('/')[2]), ['api.amazon.com', 'creatorsapi.amazon', 'api.amazon.com', 'creatorsapi.amazon']);

  const g = fetchFalso((url) => (url.endsWith('/auth/o2/token') ? json(200, { access_token: TOKEN, expires_in: 3600 }) : json(401, { reason: 'InvalidToken' })));
  const amazon2 = createAmazon({ db: completo(), fetch: g, agora: rel.agora, esperar: rel.esperar });
  const e = await capturarErro(() => amazon2.lerItem(ASIN));
  assert.ok(e instanceof ErroAmazon);
  assert.equal(e.codigo, 'credenciais_invalidas');
  assert.equal(e.tipo, 'credenciais_invalidas');
  assert.equal(g.chamadas.length, 4, 'só uma nova tentativa');
  assert.equal(amazon2.situacao().acesso, 'credenciais_invalidas');
});

test('amazon: mapa de erros da API e do token, com situação atualizada', async () => {
  const tokenOk = (url) => url.endsWith('/auth/o2/token') && json(200, { access_token: TOKEN, expires_in: 3600 });
  const casos = [
    [() => json(403, { type: 'AccessDeniedException', reason: 'AssociateNotEligible', message: 'not eligible' }), 'sem_acesso', 'sem_acesso'],
    [() => json(400, { type: 'ValidationException', reason: 'InvalidPartnerTag' }), 'tag_invalida', 'tag_invalida'],
    [() => json(400, { errors: [{ code: 'InvalidAssociate' }] }), 'tag_invalida', 'tag_invalida'],
    [() => json(400, { type: 'ValidationException', reason: 'FieldValidationFailed' }), 'indisponivel', 'indisponivel'],
    [() => json(429, { type: 'ThrottleException' }, { 'retry-after': '30' }), 'cota', 'cota', 30],
    [() => json(429, { type: 'ThrottleException', retryAfterSeconds: 7 }), 'cota', 'cota', 7],
    [() => json(500, { type: 'InternalServerException' }), 'indisponivel', 'indisponivel'],
    [() => new Response('<html>bad gateway</html>', { status: 502 }), 'indisponivel', 'indisponivel'],
    [() => json(404, { type: 'NotFound' }), 'nao_encontrado', 'indisponivel'],
    [() => { throw new TypeError('getaddrinfo ENOTFOUND creatorsapi.amazon'); }, 'indisponivel', 'indisponivel'],
    [() => new Response('não é json', { status: 200 }), null, 'ok'],
  ];
  for (const [resposta, tipo, acesso, retry] of casos) {
    const rel = relogio();
    const f = fetchFalso((url) => tokenOk(url) || resposta());
    const amazon = createAmazon({ db: completo(), fetch: f, agora: rel.agora, esperar: rel.esperar });
    if (tipo == null) { assert.equal(await amazon.lerItem(ASIN), null); }
    else {
      const e = await capturarErro(() => amazon.lerItem(ASIN));
      assert.ok(e instanceof ErroAmazon, tipo);
      assert.equal(e.codigo, tipo);
      assert.equal(e.message, MENSAGENS_AMAZON[tipo]);
      if (retry != null) assert.equal(e.retryAfterSeconds, retry);
    }
    const s = amazon.situacao();
    assert.equal(s.acesso, acesso, tipo);
    assert.equal(s.verificado_em, rel.t);
  }

  // 404 ResourceNotFound: todos os itens falharam, mas a chamada foi autorizada.
  const rel = relogio();
  const f = fetchFalso((url) => tokenOk(url) || json(404, { type: 'ResourceNotFoundException', message: 'No items found' }));
  const amazon = createAmazon({ db: completo(), fetch: f, agora: rel.agora, esperar: rel.esperar });
  assert.deepEqual(await amazon.lerItens([ASIN, 'B000000001']), { [ASIN]: null, B000000001: null });
  assert.equal(amazon.situacao().acesso, 'ok');

  // Erros no token.
  for (const [resp, tipo] of [[() => json(401, { error: 'invalid_client' }), 'credenciais_invalidas'],
    [() => json(400, { error: 'invalid_client', error_description: 'Client authentication failed' }), 'credenciais_invalidas'],
    [() => json(429, { error: 'too_many_requests' }, { 'Retry-After': '12' }), 'cota'],
    [() => json(500, {}), 'indisponivel'], [() => json(200, { token_type: 'bearer' }), 'indisponivel'],
    [() => { throw new DOMException('timeout', 'TimeoutError'); }, 'indisponivel']]) {
    const r2 = relogio();
    const g = fetchFalso(resp);
    const a2 = createAmazon({ db: completo(), fetch: g, agora: r2.agora, esperar: r2.esperar });
    const e = await capturarErro(() => a2.lerItem(ASIN));
    assert.equal(e.codigo, tipo);
    assert.equal(g.chamadas.length, 1, 'não chama o GetItems sem token');
    if (tipo === 'cota') assert.equal(e.retryAfterSeconds, 12);
  }
});

test('amazon: sem credenciais ou sem tag falha antes da rede', async () => {
  const f = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  const semCred = createAmazon({ db: bancoCom({ config: { tag: TAG } }), fetch: f });
  assert.equal((await capturarErro(() => semCred.lerItem(ASIN))).codigo, 'sem_credenciais');
  assert.equal(semCred.configurado(), false);
  assert.equal(semCred.situacao().acesso, 'nao_configurada');

  const semTag = createAmazon({ db: bancoCom({ segredos: { credencial_id: ID, credencial_secret: SECRET } }), fetch: f });
  assert.equal((await capturarErro(() => semTag.lerItem(ASIN))).codigo, 'sem_tag');
  assert.equal(semTag.configurado(), false);
  assert.equal((await capturarErro(() => semTag.montarLink(ASIN))).codigo, 'sem_tag');

  const tagRuim = createAmazon({ db: completo({ config: { tag: 'tag com espaço&x=1' } }), fetch: f });
  assert.equal((await capturarErro(() => tagRuim.lerItem(ASIN))).codigo, 'sem_tag');

  const semLinha = createAmazon({ db: (() => { const d = bancoCom(); d.exec('DELETE FROM conexoes'); return d; })(), fetch: f });
  assert.equal((await capturarErro(() => semLinha.lerItem(ASIN))).codigo, 'sem_credenciais');

  assert.equal(await createAmazon({ db: completo(), fetch: f }).lerItem('nao-e-asin'), null, 'ASIN inválido não vai à rede');
  assert.deepEqual(await createAmazon({ db: completo(), fetch: f }).lerItens(['x', null, 3]), {});
  assert.equal(f.chamadas.length, 0);
  assert.equal(createAmazon({ db: completo(), fetch: f }).configurado(), true);
});

test('amazon: lerConexao injetado substitui a leitura do banco (contrato para a etapa 7)', async () => {
  const rel = relogio(); const f = fetchFalso(apiOk());
  const amazon = createAmazon({ fetch: f, agora: rel.agora, esperar: rel.esperar,
    lerConexao: () => ({ tag: 'outra-21', credencial_id: ID, credencial_secret: SECRET, credencial_versao: '3.1' }) });
  await amazon.lerItem(ASIN);
  assert.equal(JSON.parse(f.chamadas[1].init.body).partnerTag, 'outra-21');
  assert.equal(amazon.montarLink(ASIN), `https://www.amazon.com.br/dp/${ASIN}?tag=outra-21`);
});

test('amazon: item em errors[] ou ausente de items vira null; lotes de 10 ASINs', async () => {
  const rel = relogio();
  const f = fetchFalso(apiOk({ ausentes: ['B000000002'], comErros: true }));
  const amazon = createAmazon({ db: completo(), fetch: f, agora: rel.agora, esperar: rel.esperar });
  const unicos = Array.from({ length: 12 }, (_, i) => `B0000000${String(i).padStart(2, '0')}`);
  const res = await amazon.lerItens([...unicos, unicos[1].toLowerCase(), 'invalido']);
  assert.deepEqual(Object.keys(res).sort(), [...unicos].sort());
  assert.equal(res.B000000002, null);
  assert.equal(res.B000000001.title, 'Roteador Mesh TP-Link Deco BE22, Wi-Fi 7');
  const gets = f.chamadas.filter((c) => c.url === URL_GET_ITEMS).map((c) => JSON.parse(c.init.body).itemIds.length);
  assert.deepEqual(gets, [10, 2]);
});

test('amazon: no máximo 1 chamada por segundo ao GetItems', async () => {
  const rel = relogio();
  const f = fetchFalso(apiOk());
  const amazon = createAmazon({ db: completo(), fetch: f, agora: rel.agora, esperar: rel.esperar });
  await Promise.all([amazon.lerItem('B000000001'), amazon.lerItem('B000000002'), amazon.lerItem('B000000003')]);
  const gets = f.chamadas.filter((c) => c.url === URL_GET_ITEMS).length;
  assert.equal(gets, 3);
  assert.deepEqual(rel.esperas, [1000, 1000], 'a 2ª e a 3ª esperam 1 s cada');
  rel.t += 5000;
  await amazon.lerItem('B000000004');
  assert.equal(rel.esperas.length, 2, 'depois de 1 s parado não espera');
});

test('amazon: cache de itens por 15 min (inclusive o null)', async () => {
  const rel = relogio();
  const f = fetchFalso(apiOk({ ausentes: ['B000000009'] }));
  const amazon = createAmazon({ db: completo(), fetch: f, agora: rel.agora, esperar: rel.esperar });
  const gets = () => f.chamadas.filter((c) => c.url === URL_GET_ITEMS).length;
  const a = await amazon.lerItem(ASIN);
  a.title = 'mexido pelo chamador';
  assert.equal((await amazon.lerItem(ASIN)).title, 'Roteador Mesh TP-Link Deco BE22, Wi-Fi 7', 'cópia, não o objeto do cache');
  assert.equal(await amazon.lerItem('B000000009'), null);
  assert.equal(await amazon.lerItem('B000000009'), null);
  assert.equal(gets(), 2);
  rel.t += 15 * 60 * 1000;
  await amazon.lerItem(ASIN);
  assert.equal(gets(), 3);
});

test('amazon: parser tolerante do offersV2', () => {
  const base = itemApi();
  assert.equal(ofertaDoItem({ ...base, images: { primary: { large: { url: 'https://golpe.com/x.jpg' } } } }).image, null);
  assert.equal(ofertaDoItem({ ...base, images: { primary: { large: { url: 'http://m.media-amazon.com/x.jpg' } } } }).image, null);
  assert.equal(ofertaDoItem({ ...base, images: { primary: { large: { url: 'https://images-na.ssl-images-amazon.com/images/I/x.jpg' } } } }).image,
    'https://images-na.ssl-images-amazon.com/images/I/x.jpg');
  assert.ok(IMAGEM_AMAZON.test('https://m.media-amazon.com/images/I/x.jpg'));
  assert.ok(!IMAGEM_AMAZON.test('https://media-amazon.com.golpe.com/x.jpg'));
  // R8: só subdomínio, como a CSP do painel (https://*.media-amazon.com e afins); o domínio raiz não passa
  for (const raiz of ['https://media-amazon.com/images/I/x.jpg', 'https://ssl-images-amazon.com/x.jpg', 'https://images-amazon.com/x.jpg', 'https://.media-amazon.com/x.jpg']) {
    assert.ok(!IMAGEM_AMAZON.test(raiz), raiz);
    assert.equal(ofertaDoItem({ ...base, images: { primary: { large: { url: raiz } } } }).image, null, raiz);
  }
  for (const sub of ['https://ecx.images-amazon.com/images/I/x.jpg', 'https://a.b.media-amazon.com/x.jpg']) assert.ok(IMAGEM_AMAZON.test(sub), sub);

  const semBuyBox = ofertaDoItem({ asin: 'b0aaaaaaaa', offersV2: { listings: [{ price: { money: { amount: '99.9' } } }, { price: { money: { amount: 50 } } }] } });
  assert.deepEqual(semBuyBox, { key: 'ASIN:B0AAAAAAAA', asin: 'B0AAAAAAAA', title: null, price: 99.9, oldPrice: null, discountPct: 0,
    image: null, sold: null, freeShipping: false, coupon: null, disponivel: null });

  const semPct = ofertaDoItem({ asin: ASIN, offersV2: { listings: [{ price: { money: { amount: 75 }, savingBasis: { money: { amount: 100 } } } }] } });
  assert.equal(semPct.oldPrice, 100);
  assert.equal(semPct.discountPct, 25);

  const baseMenor = ofertaDoItem({ asin: ASIN, offersV2: { listings: [{ price: { money: { amount: 100 }, savingBasis: { money: { amount: 90 } } } }] } });
  assert.equal(baseMenor.oldPrice, null, 'nenhum preço antigo inventado');
  assert.equal(baseMenor.discountPct, 0);

  const esgotado = ofertaDoItem({ asin: ASIN, offersV2: { listings: [{ availability: { type: 'OUT_OF_STOCK' }, price: { money: { amount: 0 } } }] } });
  assert.equal(esgotado.disponivel, false);
  assert.equal(esgotado.price, null);

  for (const lixo of [null, {}, { offersV2: { listings: 'x' } }, { itemInfo: { title: { displayValue: 42 } } }]) {
    const o = ofertaDoItem(lixo);
    assert.equal(o.price, null);
    assert.equal(o.title, null);
  }
});

test('amazon: título da oferta tem o mesmo teto do painel (200), cortado em fronteira de palavra (R6)', () => {
  const doTitulo = (t) => ofertaDoItem({ asin: ASIN, itemInfo: { title: { displayValue: t } } }).title;
  const palavras = Array.from({ length: 80 }, (_, i) => `palavra${i}`).join('  '); // espaços duplos viram um
  const t = doTitulo(palavras);
  assert.ok(t.length <= 200 && t.length > 180, `tamanho ${t.length}`);
  assert.ok(palavras.replace(/\s+/g, ' ').startsWith(t), 'prefixo do título original');
  assert.match(palavras.replace(/\s+/g, ' ').slice(t.length), /^ /, 'cortou numa fronteira de palavra');
  assert.equal(doTitulo('A'.repeat(200)), 'A'.repeat(200), '200 exatos ficam inteiros');
  assert.equal(doTitulo(`${'A'.repeat(199)} BBB`), 'A'.repeat(199), 'a palavra que passa de 200 sai inteira');
  assert.equal(doTitulo(`${'A'.repeat(200)} BBB`), 'A'.repeat(200), 'espaço logo depois do 200º: corte exato');
  assert.equal(doTitulo('X'.repeat(700)), 'X'.repeat(200), 'sem espaço: corte duro no teto');
  assert.equal(doTitulo('   '), null);
  assert.equal(doTitulo('Curto  e   bom'), 'Curto e bom');
});

test('amazon: montarLink limpo com a tag do dono (CA2)', () => {
  const amazon = createAmazon({ db: completo(), fetch: fetchFalso(() => assert.fail('sem rede')) });
  assert.equal(amazon.montarLink('b0fg2md49g'), 'https://www.amazon.com.br/dp/B0FG2MD49G?tag=dono-20');
  assert.equal(amazon.montarLink(` ${ASIN} `), 'https://www.amazon.com.br/dp/B0FG2MD49G?tag=dono-20');
  assert.throws(() => amazon.montarLink('B0FG2MD49G?tag=x'), LinkNaoResolvido);
  assert.throws(() => amazon.montarLink(null), LinkNaoResolvido);
});

test('amazon: fluxo do link.amazon da referência até o link limpo com a nossa tag', async () => {
  const rel = relogio();
  const f = fetchFalso((url, init) => {
    if (url === 'https://link.amazon/kR7pQ2') return redirecionar(301, 'https://www.amazon.com.br/Roteador-Mesh-TP-Link-Deco-BE22/dp/B0FG2MD49G?tag=terceiro-20&crid=1&dib=2&sr=8-1&qid=3&linkId=4&ascsubtag=5');
    return apiOk()(url, init);
  });
  const amazon = createAmazon({ db: completo(), fetch: f, agora: rel.agora, esperar: rel.esperar });
  const { asin } = await amazon.resolver('https://link.amazon/kR7pQ2');
  const link = amazon.montarLink(asin);
  assert.equal(link, 'https://www.amazon.com.br/dp/B0FG2MD49G?tag=dono-20');
  assert.equal(f.chamadas[0].init.method, 'GET');
  const oferta = await amazon.lerItem(asin);
  assert.equal(oferta.discountPct, 34);
});

test('amazon: testar devolve as frases da spec para cada resultado', async () => {
  const tokenOk = (url) => url.endsWith('/auth/o2/token') && json(200, { access_token: TOKEN, expires_in: 3600 });
  const rodar = async (db, handler) => {
    const rel = relogio(); const f = fetchFalso(handler);
    const amazon = createAmazon({ db, fetch: f, agora: rel.agora, esperar: rel.esperar });
    return { r: await amazon.testar(), f, amazon };
  };

  let { r, f, amazon } = await rodar(completo(), apiOk());
  assert.deepEqual(r, { ok: true, resultado: 'ok', mensagem: 'Credencial aceita pela Amazon.', campos: ['title', 'price', 'oldPrice', 'discountPct', 'image'] });
  assert.deepEqual(JSON.parse(f.chamadas[1].init.body).itemIds, [ASIN_TESTE]);
  assert.equal(amazon.situacao().acesso, 'ok');

  // testar não usa o cache de itens e pede token novo (prova a credencial agora).
  await amazon.testar();
  assert.equal(f.chamadas.length, 4);

  ({ r } = await rodar(completo(), (url) => tokenOk(url) || json(404, { type: 'ResourceNotFoundException' })));
  assert.deepEqual(r, { ok: true, resultado: 'ok', mensagem: 'Credencial aceita pela Amazon.', campos: [] });

  ({ r } = await rodar(completo(), () => json(401, { error: 'invalid_client' })));
  assert.deepEqual(r, { ok: false, resultado: 'recusada', mensagem: 'A Amazon não aceitou a credencial. Confira o ID e o segredo e se a credencial está ativa.', campos: [] });

  ({ r } = await rodar(completo(), (url) => tokenOk(url) || json(403, { reason: 'AssociateNotEligible' })));
  assert.deepEqual(r, { ok: false, resultado: 'sem_acesso', mensagem: 'A credencial é válida, mas a conta ainda não tem acesso à API. Confira se há vendas qualificadas nos últimos 30 dias.', campos: [] });

  ({ r } = await rodar(completo(), (url) => tokenOk(url) || json(400, { reason: 'InvalidPartnerTag' })));
  assert.deepEqual(r, { ok: false, resultado: 'tag_invalida', mensagem: 'A tag não pertence a esta credencial/loja.', campos: [] });

  for (const h of [(url) => tokenOk(url) || json(429, {}), (url) => tokenOk(url) || json(503, {}), () => { throw new TypeError('fetch failed'); }]) {
    ({ r } = await rodar(completo(), h));
    assert.deepEqual(r, { ok: false, resultado: 'indisponivel', mensagem: 'A Amazon não respondeu agora. Tente de novo em alguns minutos.', campos: [] });
  }

  // Sem tag: o teste pede só a credencial (spec).
  ({ r, f, amazon } = await rodar(bancoCom({ segredos: { credencial_id: ID, credencial_secret: SECRET } }), apiOk()));
  assert.equal(r.ok, true);
  assert.match(r.mensagem, /^Credencial aceita pela Amazon\./);
  assert.equal(f.chamadas.length, 1, 'só o token');
  assert.equal(amazon.situacao().acesso, 'desconhecido');

  ({ r, f } = await rodar(bancoCom({ config: { tag: TAG } }), () => assert.fail('sem rede')));
  assert.equal(r.ok, false);
  assert.equal(r.resultado, 'nao_configurada');
  assert.equal(f.chamadas.length, 0);
});

test('amazon: situacao começa desconhecida e volta a desconhecida quando a credencial muda', async () => {
  const db = completo(); const rel = relogio();
  const amazon = createAmazon({ db, fetch: fetchFalso(apiOk()), agora: rel.agora, esperar: rel.esperar });
  assert.deepEqual(amazon.situacao(), { acesso: 'desconhecido', verificado_em: null, motivo: null });
  await amazon.lerItem(ASIN);
  assert.equal(amazon.situacao().acesso, 'ok');
  trocar(db, { segredos: { credencial_id: ID, credencial_secret: `${SECRET}2` } });
  assert.deepEqual(amazon.situacao(), { acesso: 'desconhecido', verificado_em: null, motivo: null });
  trocar(db, { segredos: {} });
  assert.equal(amazon.situacao().acesso, 'nao_configurada');
});

// ------------------------------------------------------------------------------- correções da rodada 1
test('amazon: duas instâncias de createAmazon não dividem o cache de links; cacheLinks injetável (R4)', async () => {
  const url = 'https://link.amazon/2q3Xk9Z';
  const relA = relogio(); const relB = relogio();
  const fa = fetchFalso(() => redirecionar(301, 'https://www.amazon.com.br/dp/B0FG2MD49G'));
  const fb = fetchFalso(() => redirecionar(301, 'https://www.amazon.com.br/dp/B0AAAAAAAA'));
  const a = createAmazon({ db: completo(), fetch: fa, agora: relA.agora });
  const b = createAmazon({ db: completo(), fetch: fb, agora: relB.agora });
  assert.equal((await a.resolver(url)).asin, ASIN);
  assert.equal((await b.resolver(url)).asin, 'B0AAAAAAAA', 'a instância B não vê o que a A gravou');
  assert.equal(fa.chamadas.length, 1);
  assert.equal(fb.chamadas.length, 1);
  await a.resolver(url);
  assert.equal(fa.chamadas.length, 1, 'cada instância usa o próprio cache');

  const cacheLinks = new Map();
  const c = createAmazon({ db: completo(), fetch: fa, agora: relA.agora, cacheLinks });
  await c.resolver(url);
  assert.equal(cacheLinks.size, 1);
  assert.equal(fa.chamadas.length, 2);
  const semCache = createAmazon({ db: completo(), fetch: fa, agora: relA.agora, cacheLinks: null });
  await semCache.resolver(url); await semCache.resolver(url);
  assert.equal(fa.chamadas.length, 4, 'cacheLinks: null desliga o cache');
});

test('amazon: a situação depende da tag e invalidarToken esquece a última verificação (R7/Q10)', async () => {
  const db = completo(); const rel = relogio();
  const f = fetchFalso((url, init) => {
    if (url.endsWith('/auth/o2/token')) return json(200, { access_token: TOKEN, expires_in: 3600 });
    if (JSON.parse(init.body).partnerTag === 'errada-20') return json(400, { errors: [{ code: 'InvalidPartnerTag' }] });
    return apiOk()(url, init);
  });
  const amazon = createAmazon({ db, fetch: f, agora: rel.agora, esperar: rel.esperar });
  const desconhecido = { acesso: 'desconhecido', verificado_em: null, motivo: null };

  await amazon.lerItem(ASIN);
  assert.equal(amazon.situacao().acesso, 'ok');
  trocar(db, { config: { tag: 'errada-20', credencial_versao: '3.1' } });
  assert.deepEqual(amazon.situacao(), desconhecido, 'tag trocada: o "ok" não vale mais');

  assert.equal((await amazon.testar()).resultado, 'tag_invalida');
  assert.equal(amazon.situacao().acesso, 'tag_invalida');
  trocar(db, { config: { tag: TAG, credencial_versao: '3.1' } });
  assert.deepEqual(amazon.situacao(), desconhecido, 'tag corrigida: sai de tag_invalida sem nova chamada');

  trocar(db, { config: { tag: 'errada-20', credencial_versao: '3.1' } });
  assert.equal(amazon.situacao().acesso, 'tag_invalida', 'volta a valer para a mesma tag');
  amazon.invalidarToken();
  assert.deepEqual(amazon.situacao(), desconhecido, 'invalidarToken zera a última verificação');

  // o token não depende da tag: trocar só a tag reaproveita o token em cache
  const tokens = () => f.chamadas.filter((c) => c.url.endsWith('/auth/o2/token')).length;
  trocar(db, { config: { tag: TAG, credencial_versao: '3.1' } });
  await amazon.lerItem('B0AAAAAAAA');
  const antes = tokens();
  trocar(db, { config: { tag: 'outra-20', credencial_versao: '3.1' } });
  await amazon.lerItem('B0BBBBBBBB');
  assert.equal(tokens(), antes);
});

test('amazon: token e GetItems não seguem redirecionamento (redirect:"error"); 3xx vira indisponivel sem segunda chamada (S4)', async () => {
  // 307 no token: o segredo nunca vai ao Location
  const rel1 = relogio();
  const f1 = fetchFalso(() => new Response(null, { status: 307, headers: { location: 'https://golpe.com/roubar' } }));
  const a1 = createAmazon({ db: completo(), fetch: f1, agora: rel1.agora, esperar: rel1.esperar });
  const e1 = await capturarErro(() => a1.lerItem(ASIN));
  assert.equal(e1.codigo, 'indisponivel');
  assert.equal(f1.chamadas.length, 1);
  assert.equal(f1.chamadas[0].init.redirect, 'error');
  assert.ok(f1.chamadas.every((c) => !c.url.includes('golpe')));

  // 308 no GetItems: o Bearer nunca vai ao Location
  const rel2 = relogio();
  const f2 = fetchFalso((url) => (url.endsWith('/auth/o2/token')
    ? json(200, { access_token: TOKEN, expires_in: 3600 })
    : new Response(null, { status: 308, headers: { location: 'https://golpe.com/roubar' } })));
  const a2 = createAmazon({ db: completo(), fetch: f2, agora: rel2.agora, esperar: rel2.esperar });
  assert.equal((await capturarErro(() => a2.lerItem(ASIN))).codigo, 'indisponivel');
  assert.deepEqual(f2.chamadas.map((c) => c.url), [URL_TOKEN['3.1'], URL_GET_ITEMS]);
  assert.ok(f2.chamadas.every((c) => c.init.redirect === 'error'));

  // como o fetch real se comporta com redirect:'error' (lança TypeError)
  const rel3 = relogio();
  const f3 = fetchFalso((url, init) => { if (init.redirect === 'error') throw new TypeError('fetch failed: unexpected redirect'); return assert.fail('sem redirect:error'); });
  const a3 = createAmazon({ db: completo(), fetch: f3, agora: rel3.agora, esperar: rel3.esperar });
  assert.equal((await capturarErro(() => a3.lerItem(ASIN))).codigo, 'indisponivel');
  assert.equal(f3.chamadas.length, 1);
});

test('amazon: corpo acima de 2 MiB é recusado sem ser lido inteiro (S4)', async () => {
  const PEDACO = 256 * 1024;
  const corpoSemFim = () => {
    const s = { lidos: 0, cancelado: false };
    s.body = new ReadableStream({
      pull(c) { s.lidos++; c.enqueue(new Uint8Array(PEDACO).fill(0x61)); },
      cancel() { s.cancelado = true; },
    }, { highWaterMark: 0 });
    return s;
  };

  // content-length declarado acima do teto: nem começa a ler
  const s1 = corpoSemFim();
  const rel1 = relogio();
  const f1 = fetchFalso(() => new Response(s1.body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(50 * 1024 * 1024) } }));
  const a1 = createAmazon({ db: completo(), fetch: f1, agora: rel1.agora, esperar: rel1.esperar });
  assert.equal((await capturarErro(() => a1.lerItem(ASIN))).codigo, 'indisponivel');
  assert.equal(s1.lidos, 0, 'não leu nada');
  assert.equal(s1.cancelado, true);

  // sem content-length: lê em stream e para logo depois do teto
  const s2 = corpoSemFim();
  const rel2 = relogio();
  const f2 = fetchFalso(() => new Response(s2.body, { status: 200 }));
  const a2 = createAmazon({ db: completo(), fetch: f2, agora: rel2.agora, esperar: rel2.esperar });
  assert.equal((await capturarErro(() => a2.lerItem(ASIN))).codigo, 'indisponivel');
  assert.ok(s2.lidos <= (2 * 1024 * 1024) / PEDACO + 2, `leu ${s2.lidos} pedaços`);
  assert.equal(s2.cancelado, true);

  // GetItems 200 com corpo grande demais não vira "todos null" em cache: é indisponivel
  const s3 = corpoSemFim();
  const rel3 = relogio();
  const f3 = fetchFalso((url) => (url.endsWith('/auth/o2/token') ? json(200, { access_token: TOKEN, expires_in: 3600 }) : new Response(s3.body, { status: 200 })));
  const a3 = createAmazon({ db: completo(), fetch: f3, agora: rel3.agora, esperar: rel3.esperar });
  assert.equal((await capturarErro(() => a3.lerItem(ASIN))).codigo, 'indisponivel');
  assert.equal(s3.cancelado, true);
  assert.equal(a3.situacao().acesso, 'indisponivel');

  // corpo normal sem content-length continua funcionando (stream lido até o fim)
  const rel4 = relogio();
  const f4 = fetchFalso(apiOk());
  const a4 = createAmazon({ db: completo(), fetch: f4, agora: rel4.agora, esperar: rel4.esperar });
  assert.equal((await a4.lerItem(ASIN)).price, 1310.05);
});

test('amazon: lerItem simultâneos do mesmo ASIN dividem um só GetItems, inclusive na falha (Q12)', async () => {
  const getItems = (f) => f.chamadas.filter((c) => c.url === URL_GET_ITEMS);
  const rel = relogio();
  const f = fetchFalso(apiOk());
  const amazon = createAmazon({ db: completo(), fetch: f, agora: rel.agora, esperar: rel.esperar });
  const [x, y] = await Promise.all([amazon.lerItem(ASIN), amazon.lerItem(ASIN)]);
  assert.equal(getItems(f).length, 1);
  assert.deepEqual(x, y);
  assert.notEqual(x, y, 'cada chamador recebe a própria cópia');
  x.title = 'mexido';
  assert.notEqual((await amazon.lerItem(ASIN)).title, 'mexido');

  // sobreposição parcial: o segundo pede só o ASIN que ainda não está em voo
  const rel2 = relogio();
  const g = fetchFalso(apiOk());
  const b = createAmazon({ db: completo(), fetch: g, agora: rel2.agora, esperar: rel2.esperar });
  const [r1, r2] = await Promise.all([b.lerItens(['B0AAAAAAAA']), b.lerItens(['B0AAAAAAAA', 'B0BBBBBBBB'])]);
  assert.deepEqual(getItems(g).map((c) => JSON.parse(c.init.body).itemIds), [['B0AAAAAAAA'], ['B0BBBBBBBB']]);
  assert.equal(r1.B0AAAAAAAA.asin, 'B0AAAAAAAA');
  assert.deepEqual(Object.keys(r2).sort(), ['B0AAAAAAAA', 'B0BBBBBBBB']);

  // falha compartilhada: os dois recebem o erro, e a próxima chamada tenta de novo
  const rel3 = relogio();
  let falhar = true;
  const h = fetchFalso((url, init) => (url === URL_GET_ITEMS && falhar ? json(500, {}) : apiOk()(url, init)));
  const c = createAmazon({ db: completo(), fetch: h, agora: rel3.agora, esperar: rel3.esperar });
  const res = await Promise.allSettled([c.lerItem(ASIN), c.lerItem(ASIN)]);
  assert.deepEqual(res.map((r) => r.status), ['rejected', 'rejected']);
  assert.ok(res.every((r) => r.reason.codigo === 'indisponivel'));
  assert.equal(getItems(h).length, 1);
  falhar = false;
  assert.equal((await c.lerItem(ASIN)).asin, ASIN);
  assert.equal(getItems(h).length, 2);
});

test('amazon: resolverLink guarda "invalido" por 10 min e junta pedidos simultâneos da mesma URL (S6)', async () => {
  const cache = new Map(); const rel = relogio();
  const f = fetchFalso(() => new Response('nada', { status: 404 }));
  const opts = { fetch: f, cache, agora: rel.agora };
  assert.equal((await capturarErro(() => resolverLink('https://link.amazon/hostil', opts))).causa, 'invalido');
  assert.equal((await capturarErro(() => resolverLink('https://link.amazon/hostil', opts))).causa, 'invalido');
  assert.equal(f.chamadas.length, 1, 'o segundo veio do cache negativo');
  rel.t += 10 * 60 * 1000 + 1;
  await capturarErro(() => resolverLink('https://link.amazon/hostil', opts));
  assert.equal(f.chamadas.length, 2, 'o cache negativo dura só 10 min');

  // 25 pedidos simultâneos da mesma URL = um caminho de rede
  let liberar;
  const portao = new Promise((ok) => { liberar = ok; });
  const g = fetchFalso(async () => { await portao; return redirecionar(301, 'https://www.amazon.com.br/dp/B0FG2MD49G'); });
  const cache2 = new Map();
  const pedidos = Array.from({ length: 25 }, () => resolverLink('https://link.amazon/2q3Xk9Z', { fetch: g, cache: cache2, agora: rel.agora }));
  liberar();
  const resultados = await Promise.all(pedidos);
  assert.equal(g.chamadas.length, 1);
  assert.ok(resultados.every((r) => r.asin === ASIN));
  assert.notEqual(resultados[0], resultados[1], 'cada chamador recebe a própria cópia');

  // falha simultânea: cada chamador recebe o próprio erro
  const h = fetchFalso(async () => { throw new TypeError('fetch failed'); });
  const cache3 = new Map();
  const falhas = await Promise.allSettled([1, 2, 3].map(() => resolverLink('https://amzn.to/caiu', { fetch: h, cache: cache3, agora: rel.agora })));
  assert.equal(h.chamadas.length, 1);
  assert.ok(falhas.every((r) => r.status === 'rejected' && r.reason instanceof LinkNaoResolvido && r.reason.causa === 'invalido'));
  assert.notEqual(falhas[0].reason, falhas[1].reason);
});

test('amazon: falha passageira do resolverLink (rede, timeout, 5xx) não fica em cache; 4xx, 429 e host fora ficam (S6, QA rodada 1)', async () => {
  const rel = relogio();
  const passageiras = [
    ['rede', () => { throw new TypeError('fetch failed'); }],
    ['timeout', () => { throw new DOMException('tempo esgotado', 'TimeoutError'); }],
    ['500', () => new Response('x', { status: 500 })],
    ['503 no 2º salto', (url, init, n) => (n % 2 === 1 ? redirecionar(302, 'https://www.amazon.com.br/stores/x') : new Response('x', { status: 503 }))],
  ];
  for (const [nome, resp] of passageiras) {
    const cache = new Map();
    const f = fetchFalso(resp);
    const opts = { fetch: f, cache, agora: rel.agora };
    assert.equal((await capturarErro(() => resolverLink('https://amzn.to/caiu', opts))).causa, 'invalido', nome);
    const antes = f.chamadas.length;
    assert.equal((await capturarErro(() => resolverLink('https://amzn.to/caiu', opts))).causa, 'invalido', nome);
    assert.ok(f.chamadas.length > antes, `${nome}: tentou a rede de novo`);
    assert.equal(cache.size, 0, `${nome}: nada no cache`);
  }
  // Depois de uma falha passageira, o mesmo link volta a funcionar sem esperar os 10 min.
  let caiu = true;
  const g = fetchFalso(() => (caiu ? new Response('x', { status: 502 }) : redirecionar(301, `https://www.amazon.com.br/dp/${ASIN}`)));
  const cacheG = new Map();
  await capturarErro(() => resolverLink('https://amzn.to/volta', { fetch: g, cache: cacheG, agora: rel.agora }));
  caiu = false;
  assert.equal((await resolverLink('https://amzn.to/volta', { fetch: g, cache: cacheG, agora: rel.agora })).asin, ASIN);

  const definitivas = [
    ['404', () => new Response('x', { status: 404 })],
    ['429', () => new Response('x', { status: 429 })],
    ['host fora', () => redirecionar(302, 'https://golpe.com/dp/B0FG2MD49G')],
    ['3xx sem Location', () => redirecionar(302)],
  ];
  for (const [nome, resp] of definitivas) {
    const cache = new Map();
    const f = fetchFalso(resp);
    const opts = { fetch: f, cache, agora: rel.agora };
    await capturarErro(() => resolverLink('https://amzn.to/fixo', opts));
    await capturarErro(() => resolverLink('https://amzn.to/fixo', opts));
    assert.equal(f.chamadas.length, 1, `${nome}: o segundo veio do cache negativo`);
  }
});

// ---------------------------------------------------------------------------------------------- CA7
test('amazon: nenhuma mensagem de erro, log ou objeto devolvido contém ID, segredo ou token (CA7)', async () => {
  const saidas = [];
  const metodos = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const originais = Object.fromEntries(metodos.map((m) => [m, console[m]]));
  for (const m of metodos) console[m] = (...a) => saidas.push(util.format(...a));
  const produzidos = [];
  try {
    const respostasApi = [
      () => json(401, { message: `bad token ${TOKEN}` }), () => json(403, { message: `client ${ID} not eligible` }),
      () => json(400, { reason: 'InvalidPartnerTag', echo: SECRET }), () => json(429, { echo: TOKEN }),
      () => json(500, { echo: ID }), () => { throw new Error(`falha com ${TOKEN} e ${SECRET}`); },
      () => json(404, { type: 'NotFound', echo: ID }),
    ];
    for (const resp of respostasApi) {
      const rel = relogio();
      const f = fetchFalso((url) => (url.endsWith('/auth/o2/token') ? json(200, { access_token: TOKEN, expires_in: 3600 }) : resp()));
      const amazon = createAmazon({ db: completo(), fetch: f, agora: rel.agora, esperar: rel.esperar });
      produzidos.push(await capturarErro(() => amazon.lerItem(ASIN)));
      produzidos.push(await amazon.testar(), amazon.situacao(), amazon);
    }
    for (const resp of [() => json(401, { error: 'invalid_client', echo: SECRET }), () => { throw new Error(`token ${SECRET}`); }, () => json(200, { nada: ID })]) {
      const rel = relogio();
      const amazon = createAmazon({ db: completo(), fetch: fetchFalso(resp), agora: rel.agora, esperar: rel.esperar });
      produzidos.push(await capturarErro(() => amazon.lerItem(ASIN)), await amazon.testar(), amazon.situacao());
    }
    const rel = relogio();
    const ok = createAmazon({ db: completo(), fetch: fetchFalso(apiOk()), agora: rel.agora, esperar: rel.esperar });
    produzidos.push(await ok.lerItens([ASIN, 'B000000001']), await ok.testar(), ok.situacao(), ok, ok.montarLink(ASIN), ok.configurado());
    produzidos.push(await capturarErro(() => resolverLink(`https://amzn.to/${ID}`, { fetch: fetchFalso(() => { throw new Error(SECRET); }), cache: new Map() })));
  } finally {
    for (const m of metodos) console[m] = originais[m];
  }
  assert.deepEqual(saidas, [], 'o módulo não escreve no console');
  for (const p of produzidos) {
    const textos = [util.inspect(p, { depth: 10, showHidden: true, getters: true }), JSON.stringify(p) ?? ''];
    if (p instanceof Error) textos.push(String(p), p.stack ?? '', p.message, JSON.stringify(Object.getOwnPropertyNames(p).map((k) => p[k])));
    for (const t of textos) for (const s of SEGREDOS) assert.ok(!t.includes(s), `vazou "${s}" em: ${t.slice(0, 200)}`);
  }
  assert.ok(produzidos.filter((p) => p instanceof ErroAmazon).every((e) => Object.values(MENSAGENS_AMAZON).includes(e.message)));
});

test('amazon: hosts e constantes do contrato', () => {
  assert.deepEqual([...HOSTS_AMAZON], ['link.amazon', 'amzn.to', 'amzn.com', 'a.co', 'amazon.com.br', 'amazon.com']);
  assert.equal(URL_GET_ITEMS, 'https://creatorsapi.amazon/catalog/v1/getItems');
  assert.ok(Object.isFrozen(HOSTS_AMAZON) && Object.isFrozen(URL_TOKEN) && Object.isFrozen(MENSAGENS_AMAZON));
  const e = new ErroAmazon('inventado');
  assert.equal(e.codigo, 'indisponivel');
  assert.equal(new LinkNaoResolvido('qualquer').causa, 'invalido');
});

test('amazon: o fetch global nunca foi chamado (CA10)', () => {
  assert.equal(chamadasGlobais, 0);
});
