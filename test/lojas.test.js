import test from 'node:test';
import assert from 'node:assert/strict';
import { PLATAFORMAS, identificar, LojaNaoConectada, lerProduto, linkAfiliado, previaDoLink, imagemPermitida } from '../src/lojas.js';
import { createLinkService } from '../src/links.js';
import { createAmazon, ErroAmazon, LinkNaoResolvido, HOSTS_AMAZON, MENSAGENS_AMAZON } from '../src/amazon.js';

const IMG = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';
const URL_ML = 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM';

/** Stub do módulo ml: guarda as chamadas e devolve uma oferta pronta, sem rede. */
function mlFalso(extra = {}) {
  const chamadas = [];
  return {
    chamadas,
    async resolveOffer(cand) {
      chamadas.push(cand);
      return { key: cand.key, url: cand.url, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 0, freeShipping: true, image: IMG, ...extra };
    },
  };
}

/** Troca o fetch global por um que falha e conta, para provar que nada acessou a rede. */
async function semRede(fn) {
  const original = globalThis.fetch; let chamadas = 0;
  globalThis.fetch = async () => { chamadas++; throw new Error('rede proibida no teste'); };
  try { await fn(); } finally { globalThis.fetch = original; }
  return chamadas;
}

test('lojas: registro com as 5 plataformas, campos da tela Conexões e ML e Amazon implementados', () => {
  const lista = Object.values(PLATAFORMAS);
  assert.deepEqual(lista.map((p) => p.id), ['mercadolivre', 'amazon', 'shopee', 'magalu', 'facebook']);
  assert.deepEqual(lista.filter((p) => p.implementada).map((p) => p.id), ['mercadolivre', 'amazon']);
  const campos = Object.fromEntries(lista.map((p) => [p.id, p.campos.map((c) => `${c.nome}:${c.tipo}`)]));
  assert.deepEqual(campos, {
    mercadolivre: ['etiqueta:texto'],
    amazon: ['tag:texto', 'credencial_id:segredo', 'credencial_secret:segredo', 'credencial_versao:texto'],
    shopee: ['app_id:texto', 'chave:segredo'], magalu: ['loja:texto'], facebook: [],
  });
  for (const p of lista) {
    assert.ok(p.nome && p.descricao && p.hosts.length, `${p.id} sem nome, descrição ou hosts`);
    for (const c of p.campos) {
      assert.ok(c.rotulo && c.ajuda && Number.isInteger(c.max) && c.max > 0, `${p.id}.${c.nome} incompleto`);
      assert.match(c.padrao, /^\^.*\$$/, `${p.id}.${c.nome}: padrão precisa de ^ e $`);
      assert.doesNotThrow(() => new RegExp(c.padrao));
    }
  }
  const re = (id, nome) => new RegExp(PLATAFORMAS[id].campos.find((c) => c.nome === nome).padrao);
  assert.ok(re('amazon', 'tag').test('seunome-20') && !re('amazon', 'tag').test('com espaço'));
  assert.ok(re('amazon', 'credencial_id').test('amzn1.application-oa2-client.0123abcd') && !re('amazon', 'credencial_id').test('curto'));
  assert.ok(!re('amazon', 'credencial_id').test('id com espaço 123'));
  assert.ok(re('amazon', 'credencial_secret').test('Segr3do!#$%&*') && !re('amazon', 'credencial_secret').test('com espaço no meio'));
  for (const v of ['3.1', '3.2', '3.3']) assert.ok(re('amazon', 'credencial_versao').test(v), v);
  for (const v of ['3.0', '3.4', '2.1', '3.10', '31', '']) assert.ok(!re('amazon', 'credencial_versao').test(v), v);
  assert.ok(re('shopee', 'app_id').test('11312345678') && !re('shopee', 'app_id').test('abc'));
  assert.ok(re('mercadolivre', 'etiqueta').test('minha_etiqueta') && !re('mercadolivre', 'etiqueta').test('a b'));
  // id vindo da requisição não acha propriedade herdada, e o registro não muda em tempo de execução
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(PLATAFORMAS[id], undefined, id);
  assert.throws(() => { PLATAFORMAS.amazon.implementada = false; }, TypeError);
  assert.throws(() => { PLATAFORMAS.amazon.hosts.push('evil.com'); }, TypeError);
  assert.throws(() => { PLATAFORMAS.shopee.hosts.push('evil.com'); }, TypeError);
});

test('lojas: identificar reconhece cada loja pelo host e pelo encurtador', () => {
  const casos = {
    mercadolivre: [URL_ML, 'https://meli.la/2AbCdEf', 'https://www.mercadolivre.com.br/p/MLB555555', 'https://mercadolivre.com.br/ofertas',
      'https://lista.mercadolivre.com.br/fone', 'HTTPS://WWW.MERCADOLIVRE.COM.BR/X', `  ${URL_ML}  `],
    amazon: ['https://amzn.to/3xYz', 'https://www.amazon.com.br/dp/B0ABC12345', 'https://amazon.com.br/x', 'https://a.co/d/abc',
      'https://link.amazon/aBc12XyZ', 'https://LINK.AMAZON/x', 'https://amzn.com/B0ABC12345', 'https://www.amazon.com/dp/B0ABC12345',
      'https://www.amazon.com.br/Roteador-Mesh/dp/B0FG2MD49G?tag=outro-20&crid=X'],
    shopee: ['https://s.shopee.com.br/AbC123', 'https://shp.ee/abc', 'https://shope.ee/abc', 'https://shopee.com.br/Fone-i.123.456'],
    magalu: ['https://www.magazinevoce.com.br/magazineminhaloja/p/123/', 'https://magazinevoce.com.br/x',
      'https://www.magazineluiza.com.br/fone/p/123/', 'https://divulgador.magalu.com/abc'],
    facebook: ['https://www.facebook.com/minhapagina', 'https://facebook.com/x', 'https://m.facebook.com/x', 'https://fb.com/x', 'https://fb.me/x'],
  };
  for (const [id, urls] of Object.entries(casos)) {
    for (const u of urls) assert.equal(identificar(u)?.id, id, u);
  }
  assert.deepEqual(identificar(URL_ML), { id: 'mercadolivre', nome: 'Mercado Livre', implementada: true });
  assert.deepEqual(identificar('https://amzn.to/3xYz'), { id: 'amazon', nome: 'Amazon', implementada: true });
  assert.deepEqual(identificar('https://link.amazon/aBc12XyZ'), { id: 'amazon', nome: 'Amazon', implementada: true });
});

test('lojas: todo host que identificar dá como Amazon é um host que o resolvedor de amazon.js aceita seguir', () => {
  const aceito = (h) => HOSTS_AMAZON.some((x) => h === x || h.endsWith(`.${x}`));
  for (const h of PLATAFORMAS.amazon.hosts) assert.ok(aceito(h), h);
  for (const h of HOSTS_AMAZON) assert.equal(identificar(`https://${h}/x`)?.id, 'amazon', h);
});

test('lojas: host falso é recusado (só host exato ou subdomínio com ponto)', () => {
  const falsos = [
    'https://mercadolivre.com.br.evil.com/MLB-1234567890', 'https://evilmercadolivre.com.br/MLB-1234567890',
    'https://meli.la.evil.com/abc', 'https://notmeli.la/abc', 'https://amazon.com.br.example.com/dp/X',
    'https://fakeamazon.com.br/dp/X', 'https://shopee.com.br-promo.com/x', 'https://evil.com/?u=https://mercadolivre.com.br/MLB-1',
    'https://evil.com/mercadolivre.com.br', 'https://evil.com#meli.la', 'https://mercadolivre.com.br@evil.com/MLB-1',
    'https://mercadolivre.com.br%2Eevil.com/', 'https://example.com/', 'http://127.0.0.1/', 'http://[::1]/',
    'https://link.amazon.evil.com/x', 'https://evillink.amazon/x', 'https://amzn.com.evil.com/x', 'https://notamzn.com/x',
    'https://evil.com/?u=https://link.amazon/x',
  ];
  for (const u of falsos) assert.equal(identificar(u), null, u);
});

test('lojas: URL inválida, sem esquema ou fora de http/https devolve null', () => {
  const invalidos = [
    'javascript:alert(1)', 'javascript://mercadolivre.com.br/%0aalert(1)', 'data:text/html,<b>meli.la</b>',
    'ftp://mercadolivre.com.br/x', 'file:///etc/passwd', 'mercadolivre.com.br/MLB-1234567890', '//mercadolivre.com.br/x',
    'https://', '', '   ', 'não é link', null, undefined, 123, {}, ['https://meli.la/x'],
    `https://meli.la/${'a'.repeat(5000)}`,
  ];
  for (const u of invalidos) assert.equal(identificar(u), null, String(u).slice(0, 60));
});

test('lojas: identificar e as recusas não acessam a rede', async () => {
  const ml = mlFalso();
  const chamadas = await semRede(async () => {
    identificar(URL_ML); identificar('https://amzn.to/x'); identificar('https://evil.com/');
    await assert.rejects(previaDoLink('https://example.com/pagina', { ml }));
    await assert.rejects(previaDoLink('https://amzn.to/x', { ml }), /só funciona com links do Mercado Livre/);
    await assert.rejects(lerProduto('shopee', 'https://shp.ee/x', { ml }), LojaNaoConectada);
    await assert.rejects(lerProduto('amazon', 'https://amzn.to/x', { ml }), /Serviço da Amazon indisponível/);
  });
  assert.equal(chamadas, 0);
  assert.equal(ml.chamadas.length, 0);
});

test('lojas: lerProduto do ML chama resolveOffer (injetado) e devolve a oferta', async () => {
  const ml = mlFalso();
  const oferta = await lerProduto('mercadolivre', `  ${URL_ML} `, { ml });
  assert.deepEqual(ml.chamadas, [{ key: 'MLB1234567890', url: URL_ML }]);
  assert.equal(oferta.title, 'Fone Bom');
  assert.equal(oferta.price, 89.9);
  assert.equal(oferta.image, IMG);
  assert.equal(oferta.url, URL_ML);
  // imagem fora do CDN do ML não segue adiante (o envio baixaria essa URL no servidor)
  for (const img of ['https://evil.com/x.jpg', 'http://http2.mlstatic.com/x.jpg', 'https://mlstatic.com.evil.com/x.jpg']) {
    assert.equal((await lerProduto('mercadolivre', URL_ML, { ml: mlFalso({ image: img }) })).image, null, img);
  }
});

test('lojas: lerProduto recusa loja desconhecida e link de outra loja sem chamar o ML', async () => {
  const ml = mlFalso();
  for (const id of ['constructor', '__proto__', 'x', undefined]) {
    await assert.rejects(lerProduto(id, URL_ML, { ml }), /Loja desconhecida/);
  }
  await assert.rejects(lerProduto('mercadolivre', 'https://amzn.to/x', { ml }), /não é da loja Mercado Livre/);
  await assert.rejects(lerProduto('mercadolivre', 'https://mercadolivre.com.br.evil.com/MLB-1234567890', { ml }), /não é da loja/);
  await assert.rejects(lerProduto('mercadolivre', 'javascript:alert(1)', { ml }), /não é da loja/);
  assert.equal(ml.chamadas.length, 0);
});

test('lojas: Shopee, Magalu e Facebook lançam LojaNaoConectada com o nome na mensagem', async () => {
  const ml = mlFalso();
  const links = { chamadas: 0, async requestLink() { this.chamadas++; return 'https://meli.la/x'; } };
  const err = await lerProduto('shopee', 'https://s.shopee.com.br/x', { ml }).catch((e) => e);
  assert.ok(err instanceof LojaNaoConectada && err instanceof Error);
  assert.equal(err.message, 'Shopee identificada, mas ainda não está conectada. Configure em Conexões.');
  assert.deepEqual(err.loja, { id: 'shopee', nome: 'Shopee', implementada: false });
  const outras = { shopee: ['Shopee', 'https://s.shopee.com.br/x'], magalu: ['Magalu', 'https://www.magazinevoce.com.br/x'], facebook: ['Facebook', 'https://fb.com/x'] };
  for (const [id, [nome, url]] of Object.entries(outras)) {
    await assert.rejects(lerProduto(id, url, { ml }), (e) => e instanceof LojaNaoConectada && e.message.startsWith(nome) && e.loja.id === id);
    await assert.rejects(linkAfiliado(id, { url, tag: 'seunome-20' }, { links }), (e) => e instanceof LojaNaoConectada && e.loja.id === id);
  }
  assert.equal(ml.chamadas.length, 0);
  assert.equal(links.chamadas, 0);
});

test('lojas: linkAfiliado do ML usa requestLink com a URL e a etiqueta', async () => {
  const chamadas = [];
  const links = { async requestLink(arg) { chamadas.push(arg); return 'https://meli.la/AbC123'; } };
  assert.equal(await linkAfiliado('mercadolivre', { url: ` ${URL_ML}`, tag: 'minha_etiqueta' }, { links }), 'https://meli.la/AbC123');
  assert.deepEqual(chamadas, [{ url: URL_ML, tag: 'minha_etiqueta' }]);
  // com o serviço real em modo simulado (sem extensão e sem rede)
  const fake = createLinkService({ getMode: () => 'fake' });
  assert.match(await linkAfiliado('mercadolivre', { url: 'https://meli.la/2AbCdEf', tag: 'promo' }, { links: fake }), /^https:\/\/meli\.la\/fake-promo-\d+$/);
  for (const tag of ['', '   ', undefined, 42]) {
    await assert.rejects(linkAfiliado('mercadolivre', { url: URL_ML, tag }, { links }), /Escolha uma etiqueta/);
  }
  await assert.rejects(linkAfiliado('mercadolivre', { url: 'https://evil.com/x', tag: 'promo' }, { links }), /não é da loja/);
  assert.equal(chamadas.length, 1);
});

test('lojas: previaDoLink só do ML, com imagem só do mlstatic', async () => {
  const ml = mlFalso();
  assert.deepEqual(await previaDoLink(URL_ML, { ml }), { title: 'Fone Bom', description: 'R$ 89,90', image: IMG });
  assert.equal(ml.chamadas.length, 1);
  for (const img of ['https://evil.com/x.jpg', 'http://http2.mlstatic.com/x.jpg', 'https://mlstatic.com.evil.com/x.jpg', 'file:///etc/passwd', null]) {
    assert.equal((await previaDoLink(URL_ML, { ml: mlFalso({ image: img }) })).image, null, String(img));
  }
  const semPreco = await previaDoLink('https://meli.la/2AbCdEf', { ml: mlFalso({ price: null }) });
  assert.ok(!('description' in semPreco));
  const outro = mlFalso();
  // a Amazon está integrada, mas a prévia de link do WhatsApp continua só do ML
  await assert.rejects(previaDoLink('https://www.amazon.com.br/dp/B0ABC12345', { ml: outro }), /só funciona com links do Mercado Livre/);
  for (const u of ['https://example.com/noticia', 'javascript:alert(1)', 'https://mercadolivre.com.br.evil.com/x', '']) {
    await assert.rejects(previaDoLink(u, { ml: outro }), /só funciona com links do Mercado Livre/, u);
  }
  assert.equal(outro.chamadas.length, 0);
});

// ------------------------------------------------------------------ Amazon (plano espelhamento-amazon, etapa 7)

const ASIN = 'B0FG2MD49G';
const IMG_AMZ = 'https://m.media-amazon.com/images/I/71abcDEF12L._AC_SL1500_.jpg';
const URL_LONGA = `https://www.amazon.com.br/Roteador-Mesh-TP-Link-Deco-BE22/dp/${ASIN}/ref=sr_1_3?crid=2X9&dib=eyJ2&sr=8-3&qid=1730000000&linkId=abc&ascsubtag=xyz&tag=terceiro-20`;
const ID_CRED = 'amzn1.application-oa2-client.IDSECRETO0123456789';
const SEGREDO_CRED = 'SEGREDO-Super-Secreto-xyz789!';

/** Stub de createAmazon: guarda as chamadas; resolver e lerItem respondem pelo que o teste mandar. */
function amazonFalso({ asin = ASIN, oferta = {}, erroItem = null, erroLink = null } = {}) {
  const chamadas = { resolver: [], lerItem: [], montarLink: [] };
  return {
    chamadas,
    async resolver(url) { chamadas.resolver.push(url); if (erroLink) throw erroLink; return { asin, urlFinal: `https://www.amazon.com.br/dp/${asin}` }; },
    async lerItem(a) {
      chamadas.lerItem.push(a);
      if (erroItem) throw erroItem;
      if (oferta === null) return null;
      return { key: `ASIN:${a}`, asin: a, title: 'Roteador Mesh', price: 1310.05, oldPrice: 1999, discountPct: 34, image: IMG_AMZ,
        sold: null, freeShipping: false, coupon: null, disponivel: true, ...oferta };
    },
    montarLink(a) { chamadas.montarLink.push(a); return `https://www.amazon.com.br/dp/${a}?tag=dono-20`; },
  };
}

/** fetch falso (o do createAmazon): guarda as URLs e responde pelo handler. */
function fetchFalso(handler) {
  const chamadas = [];
  const f = async (url, init = {}) => { chamadas.push({ url: String(url), metodo: init.method }); return handler(String(url)); };
  f.chamadas = chamadas;
  return f;
}
const redirecionar = (location) => new Response(null, { status: 301, headers: { location } });

test('lojas Amazon: lerProduto chama o stub (resolver + lerItem) e devolve key ASIN:<asin>, sem o ML e sem rede', async () => {
  const ml = mlFalso();
  const amazon = amazonFalso();
  let oferta;
  const rede = await semRede(async () => { oferta = await lerProduto('amazon', `  https://link.amazon/aBc12XyZ `, { ml, amazon }); });
  assert.equal(rede, 0);
  assert.deepEqual(amazon.chamadas.resolver, ['https://link.amazon/aBc12XyZ'], 'resolve a URL sem espaços');
  assert.deepEqual(amazon.chamadas.lerItem, [ASIN]);
  assert.equal(ml.chamadas.length, 0, 'link da Amazon nunca vai ao Mercado Livre');
  assert.equal(oferta.key, `ASIN:${ASIN}`);
  assert.equal(oferta.asin, ASIN);
  assert.equal(oferta.title, 'Roteador Mesh');
  assert.equal(oferta.price, 1310.05);
  assert.equal(oferta.oldPrice, 1999);
  assert.equal(oferta.image, IMG_AMZ);
  // a chave sai do ASIN resolvido, não do que o stub devolveu
  const outra = await lerProduto('amazon', URL_LONGA, { amazon: amazonFalso({ oferta: { key: 'MLB123', asin: 'XXXXXXXXXX' } }) });
  assert.equal(outra.key, `ASIN:${ASIN}`); assert.equal(outra.asin, ASIN);
});

test('lojas Amazon: imagem fora do CDN da Amazon vira null (inclusive a do Mercado Livre)', async () => {
  const fora = ['https://evil.com/x.jpg', 'http://m.media-amazon.com/images/I/x.jpg', 'https://media-amazon.com.evil.com/x.jpg',
    'https://evilmedia-amazon.com/x.jpg', IMG, 'file:///etc/passwd', 'javascript:alert(1)', null, 42, '',
    'https://images-amazon.com/x.jpg']; // domínio raiz: a CSP do painel só libera subdomínios (R8)
  for (const img of fora) {
    assert.equal((await lerProduto('amazon', URL_LONGA, { amazon: amazonFalso({ oferta: { image: img } }) })).image, null, String(img));
  }
  for (const img of [IMG_AMZ, 'https://images-na.ssl-images-amazon.com/images/I/x.jpg', 'https://ecx.images-amazon.com/x.jpg']) {
    assert.equal((await lerProduto('amazon', URL_LONGA, { amazon: amazonFalso({ oferta: { image: img } }) })).image, img, img);
  }
});

test('lojas: imagemPermitida só aceita o CDN da própria loja', () => {
  assert.equal(imagemPermitida('mercadolivre', IMG), true);
  assert.equal(imagemPermitida('amazon', IMG_AMZ), true);
  assert.equal(imagemPermitida('amazon', IMG), false, 'foto do ML não passa como Amazon');
  assert.equal(imagemPermitida('mercadolivre', IMG_AMZ), false, 'foto da Amazon não passa como ML');
  for (const loja of ['shopee', 'magalu', 'facebook', 'constructor', '__proto__', undefined, null, 1]) {
    assert.equal(imagemPermitida(loja, IMG), false, String(loja));
    assert.equal(imagemPermitida(loja, IMG_AMZ), false, String(loja));
  }
  for (const v of [null, undefined, '', 42, {}, `https://m.media-amazon.com/${'a'.repeat(5000)}`]) {
    assert.equal(imagemPermitida('amazon', v), false, String(v).slice(0, 40));
  }
});

test('lojas Amazon: lerProduto repassa LinkNaoResolvido e devolve ErroAmazon com o ASIN, sem a mensagem crua', async () => {
  await assert.rejects(lerProduto('amazon', URL_LONGA, {}), /Serviço da Amazon indisponível/);
  await assert.rejects(lerProduto('amazon', URL_LONGA, { amazon: { resolver() {} } }), /Serviço da Amazon indisponível/);
  await assert.rejects(lerProduto('amazon', 'https://amazon.com.br.evil.com/dp/B0FG2MD49G', { amazon: amazonFalso() }), /não é da loja Amazon/);

  const naoProduto = amazonFalso({ erroLink: new LinkNaoResolvido('nao_produto') });
  await assert.rejects(lerProduto('amazon', 'https://amzn.to/lista', { amazon: naoProduto }), (e) => e instanceof LinkNaoResolvido && e.causa === 'nao_produto');
  assert.equal(naoProduto.chamadas.lerItem.length, 0, 'sem ASIN não consulta a API');
  // resolver que devolve ASIN inválido não chega à API
  const torto = amazonFalso({ asin: '../../x' });
  await assert.rejects(lerProduto('amazon', 'https://amzn.to/x', { amazon: torto }), (e) => e instanceof LinkNaoResolvido && e.causa === 'invalido');
  assert.equal(torto.chamadas.lerItem.length, 0);

  for (const tipo of ['sem_credenciais', 'sem_tag', 'credenciais_invalidas', 'sem_acesso', 'tag_invalida', 'cota', 'indisponivel']) {
    const original = new ErroAmazon(tipo, { status: 403, retryAfterSeconds: 7 });
    const e = await lerProduto('amazon', URL_LONGA, { amazon: amazonFalso({ erroItem: original }) }).catch((x) => x);
    assert.ok(e instanceof ErroAmazon, tipo);
    assert.equal(e.tipo, tipo); assert.equal(e.asin, ASIN); assert.equal(e.message, MENSAGENS_AMAZON[tipo]);
    assert.equal(e.retryAfterSeconds, 7);
    assert.notEqual(e, original, 'erro novo: o mesmo objeto pode estar com outro chamador (GetItems em lote)');
    assert.equal(original.asin, undefined);
  }
  const nulo = await lerProduto('amazon', URL_LONGA, { amazon: amazonFalso({ oferta: null }) }).catch((x) => x);
  assert.ok(nulo instanceof ErroAmazon); assert.equal(nulo.tipo, 'nao_encontrado'); assert.equal(nulo.asin, ASIN);
  // erro inesperado (com um segredo na mensagem) vira 'indisponivel' com a frase fixa
  const cru = await lerProduto('amazon', URL_LONGA, { amazon: amazonFalso({ erroItem: new Error(`falhou com ${SEGREDO_CRED}`) }) }).catch((x) => x);
  assert.ok(cru instanceof ErroAmazon); assert.equal(cru.tipo, 'indisponivel');
  assert.ok(!cru.message.includes(SEGREDO_CRED) && !String(cru.stack).includes(SEGREDO_CRED));
});

test('CA2: linkAfiliado da Amazon é exatamente https://www.amazon.com.br/dp/<ASIN>?tag=<tag do dono>, sem slug nem rastreio de terceiro', async () => {
  const conexao = { tag: 'dono-20', credencial_id: ID_CRED, credencial_secret: SEGREDO_CRED, credencial_versao: '3.1' };
  const f = fetchFalso((url) => {
    if (url === 'https://amzn.to/3xYz') return redirecionar('https://link.amazon/aBc12XyZ');
    if (url === 'https://link.amazon/aBc12XyZ') return redirecionar(URL_LONGA);
    throw new Error(`rede inesperada: ${url}`);
  });
  const amazon = createAmazon({ fetch: f, lerConexao: () => conexao });
  const esperado = `https://www.amazon.com.br/dp/${ASIN}?tag=dono-20`;
  const rede = await semRede(async () => {
    // link longo: o ASIN sai do caminho, sem rede
    assert.equal(await linkAfiliado('amazon', { url: URL_LONGA, tag: 'ignorada-20' }, { amazon }), esperado);
    assert.equal(f.chamadas.length, 0);
    for (const u of [`https://amazon.com.br/gp/product/${ASIN.toLowerCase()}?psc=1`, `https://www.amazon.com.br/exec/obidos/ASIN/${ASIN}`, `https://www.amazon.com/dp/${ASIN}?tag=us-20`]) {
      assert.equal(await linkAfiliado('amazon', { url: u }, { amazon }), esperado, u);
    }
    // encurtador: segue os 301 só por GET até o ASIN
    assert.equal(await linkAfiliado('amazon', { url: 'https://amzn.to/3xYz' }, { amazon }), esperado);
    assert.deepEqual(f.chamadas.map((c) => [c.metodo, c.url]), [['GET', 'https://amzn.to/3xYz'], ['GET', 'https://link.amazon/aBc12XyZ']]);
    // ASIN já resolvido pelo servidor (payload do envio): nem o encurtador é seguido de novo
    assert.equal(await linkAfiliado('amazon', { url: 'https://a.co/d/xyz', asin: ASIN.toLowerCase() }, { amazon }), esperado);
    assert.equal(f.chamadas.length, 2);
  });
  assert.equal(rede, 0, 'fetch global nunca chamado');
  // a tag é a de Conexões na hora da chamada
  conexao.tag = 'nova-21';
  assert.equal(await linkAfiliado('amazon', { url: URL_LONGA }, { amazon }), `https://www.amazon.com.br/dp/${ASIN}?tag=nova-21`);
  // link que não é da Amazon e serviço ausente
  await assert.rejects(linkAfiliado('amazon', { url: URL_ML }, { amazon }), /não é da loja Amazon/);
  await assert.rejects(linkAfiliado('amazon', { url: URL_LONGA }, {}), /Serviço da Amazon indisponível/);
  await assert.rejects(linkAfiliado('amazon', { url: 'https://amzn.to/x' }, { amazon: { montarLink() { return 'x'; } } }), /Serviço da Amazon indisponível/);
});

test('CA7: linkAfiliado da Amazon sem tag falha com ErroAmazon sem_tag, sem rede e sem ID nem segredo na mensagem', async () => {
  const f = fetchFalso(() => { throw new Error('rede proibida'); });
  for (const tag of [undefined, '', 'tag inválida com espaço']) {
    const amazon = createAmazon({ fetch: f, lerConexao: () => ({ tag, credencial_id: ID_CRED, credencial_secret: SEGREDO_CRED }) });
    let e;
    const rede = await semRede(async () => { e = await linkAfiliado('amazon', { url: URL_LONGA, tag: 'outra-20' }, { amazon }).catch((x) => x); });
    assert.equal(rede, 0);
    assert.ok(e instanceof ErroAmazon, String(tag)); assert.equal(e.tipo, 'sem_tag');
    assert.equal(e.message, 'Falta a tag de associado da Amazon em Conexões.');
    const tudo = `${e.message} ${e.stack} ${JSON.stringify(e)}`;
    for (const s of [ID_CRED, SEGREDO_CRED, 'IDSECRETO', 'Super-Secreto']) assert.ok(!tudo.includes(s), s);
  }
  assert.equal(f.chamadas.length, 0);
});
