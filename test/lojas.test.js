import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATAFORMAS, identificar, LojaNaoConectada, lerProduto, linkAfiliado, previaDoLink, imagemPermitida,
  RE_ENDERECO_CATALOGO, RE_CAMINHO_TOKEN, ENDERECO_CATALOGO_PADRAO, PARECE_TOKEN, ARQUIVO_TOKEN, caminhoDoArquivoDoToken,
} from '../src/lojas.js';
import { createLinkService } from '../src/links.js';
import { createAmazon, ErroAmazon, LinkNaoResolvido, HOSTS_AMAZON, MENSAGENS_AMAZON } from '../src/amazon.js';
import { createShopee, ErroShopee, LinkShopeeNaoResolvido, HOSTS_SHOPEE, MENSAGENS_SHOPEE, URL_API, RE_ID_AFILIADO } from '../src/shopee.js';

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

// Rede bloqueada no arquivo inteiro (etapa 1 da Shopee): o último teste prova que o fetch global nunca foi chamado.
const fetchOriginal = globalThis.fetch;
let chamadasGlobais = 0;
test.before(() => { globalThis.fetch = async () => { chamadasGlobais++; throw new Error('rede proibida no teste'); }; });
test.after(() => { globalThis.fetch = fetchOriginal; });

/** Troca o fetch global por um que falha e conta, para provar que nada acessou a rede. */
async function semRede(fn) {
  const original = globalThis.fetch; let chamadas = 0;
  globalThis.fetch = async () => { chamadas++; throw new Error('rede proibida no teste'); };
  try { await fn(); } finally { globalThis.fetch = original; }
  return chamadas;
}

test('lojas: registro com as 6 plataformas, campos da tela Conexões e ML, Amazon, Shopee e Catálogo implementados', () => {
  const lista = Object.values(PLATAFORMAS);
  assert.deepEqual(lista.map((p) => p.id), ['mercadolivre', 'amazon', 'shopee', 'magalu', 'facebook', 'catalogo']);
  assert.deepEqual(lista.filter((p) => p.implementada).map((p) => p.id), ['mercadolivre', 'amazon', 'shopee', 'catalogo']);
  const campos = Object.fromEntries(lista.map((p) => [p.id, p.campos.map((c) => `${c.nome}:${c.tipo}`)]));
  assert.deepEqual(campos, {
    mercadolivre: ['etiqueta:texto'],
    amazon: ['tag:texto', 'credencial_id:segredo', 'credencial_secret:segredo', 'credencial_versao:texto'],
    shopee: ['id_afiliado:texto', 'app_id:texto', 'chave:segredo'], magalu: ['loja:texto'], facebook: [],
    catalogo: ['endereco:texto', 'caminho_token:texto'],
  });
  for (const p of lista) {
    // o Catálogo é fonte de ofertas, não loja: nenhum link é dele (hosts vazio)
    assert.ok(p.nome && p.descricao && (p.id === 'catalogo' ? p.hosts.length === 0 : p.hosts.length), `${p.id} sem nome, descrição ou hosts`);
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
  for (const v of ['98765432101', '12345', '1'.repeat(20)]) assert.ok(re('shopee', 'id_afiliado').test(v), v);
  for (const v of ['1234', '1'.repeat(21), 'seunome-20', '183 288', 'an_98765432101', '']) assert.ok(!re('shopee', 'id_afiliado').test(v), v);
  assert.deepEqual(PLATAFORMAS.shopee.campos.map((c) => c.rotulo), ['ID de afiliado', 'AppID', 'Senha da API']);
  assert.ok(re('shopee', 'chave').test('Senha!#$%&*1') && !re('shopee', 'chave').test('curta') && !re('shopee', 'chave').test('com espaço no meio'));
  assert.ok(re('mercadolivre', 'etiqueta').test('minha_etiqueta') && !re('mercadolivre', 'etiqueta').test('a b'));
  // id vindo da requisição não acha propriedade herdada, e o registro não muda em tempo de execução
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(PLATAFORMAS[id], undefined, id);
  assert.throws(() => { PLATAFORMAS.amazon.implementada = false; }, TypeError);
  assert.throws(() => { PLATAFORMAS.amazon.hosts.push('evil.com'); }, TypeError);
  assert.throws(() => { PLATAFORMAS.shopee.hosts.push('evil.com'); }, TypeError);
  assert.throws(() => { PLATAFORMAS.catalogo.hosts.push('evil.com'); }, TypeError);
});

test('lojas Catálogo (CA2, CA8): nome da spec, sem segredo, endereço só deste computador e caminho (não o token)', () => {
  const p = PLATAFORMAS.catalogo;
  assert.equal(p.nome, 'Catálogo do Etiqueta');
  assert.deepEqual(p.hosts, []);
  assert.ok(p.campos.every((c) => c.tipo === 'texto'), 'nenhum segredo: o token fica no arquivo do dono');
  const re = (nome) => new RegExp(p.campos.find((c) => c.nome === nome).padrao);
  assert.equal(re('endereco').source, RE_ENDERECO_CATALOGO.source, 'o campo usa a regra exportada');
  assert.equal(re('caminho_token').source, RE_CAMINHO_TOKEN.source);
  assert.equal(ENDERECO_CATALOGO_PADRAO, 'http://127.0.0.1:8765', 'o Etiqueta só escuta em 127.0.0.1 (localhost pode virar ::1)');
  for (const v of ['http://localhost:8765', 'http://127.0.0.1:8765', 'http://localhost:1', 'http://127.0.0.1:65535', ENDERECO_CATALOGO_PADRAO]) {
    assert.ok(re('endereco').test(v), v);
  }
  for (const v of ['https://localhost:8765', 'http://localhost', 'http://localhost:', 'http://localhost:8765/', 'http://localhost:8765/api',
    'http://localhost:8765?x=1', 'http://user:senha@localhost:8765', 'http://localhost.evil.com:8765', 'http://127.0.0.2:8765',
    'http://[::1]:8765', 'http://0.0.0.0:8765', 'http://192.168.0.10:8765', 'http://LOCALHOST:8765', 'http://localhost:0',
    'http://localhost:65536', 'http://localhost:99999', 'http://localhost:08765', 'localhost:8765', ' http://localhost:8765', '']) {
    assert.ok(!re('endereco').test(v), v);
  }
  for (const v of ['/home/ufla/Documentos/mensagensParaEnviar/api_token.txt', '~/Documentos/x/api_token.txt', '/a', '~/a',
    '/pasta com espaço/ç/token.txt', '/' + 'a'.repeat(500)]) {
    assert.ok(re('caminho_token').test(v), v.slice(0, 40));
  }
  for (const v of ['api_token.txt', 'Documentos/api_token.txt', '~api_token.txt', '/', '~/', 'C:\\token.txt', '/a\nb', '/a\u0000b',
    '/a\u007fb', '/a\tb', '/' + 'a'.repeat(501), 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCD']) {
    assert.ok(!re('caminho_token').test(v), JSON.stringify(v).slice(0, 40));
  }
  const max = Object.fromEntries(p.campos.map((c) => [c.nome, c.max]));
  assert.deepEqual(max, { endereco: 40, caminho_token: 500 });
});

test('lojas Catálogo (S1, R9): o arquivo do token é só o api_token.txt; PARECE_TOKEN é a regra única do token colado', () => {
  assert.equal(ARQUIVO_TOKEN, 'api_token.txt');
  for (const v of ['/home/u/Documentos/mensagensParaEnviar/api_token.txt', '~/api_token.txt', '/api_token.txt', '/pasta com espaço/api_token.txt']) {
    assert.equal(caminhoDoArquivoDoToken(v), true, v);
  }
  for (const v of ['api_token.txt', '/home/u/token.txt', '/home/u/api_token.txt/', '/home/u/xapi_token.txt', '/home/u/api_token.txt.bak',
    '/home/u/API_TOKEN.TXT', '/home/u/data/wa_auth/creds.json', '', null, 42]) {
    assert.equal(caminhoDoArquivoDoToken(v), false, String(v));
  }
  for (const v of ['a'.repeat(32), `/${'a'.repeat(32)}`, `~/${'a'.repeat(32)}`]) assert.ok(PARECE_TOKEN.test(v), v);
  for (const v of ['a'.repeat(31), '/home/u/api_token.txt']) assert.ok(!PARECE_TOKEN.test(v), v);
});

test('lojas Catálogo: nenhum link é do Catálogo; ler, gerar link e foto recusam a "loja" catalogo sem rede', async () => {
  const chamadas = await semRede(async () => {
    for (const url of ['http://localhost:8765', 'http://127.0.0.1:8765/api/v1/ofertas', URL_ML, 'https://amzn.to/x', 'https://s.shopee.com.br/x']) {
      assert.notEqual(identificar(url)?.id, 'catalogo', url);
    }
    assert.equal(identificar('http://localhost:8765'), null, 'endereço do Etiqueta não é link de loja');
    const ml = mlFalso();
    await assert.rejects(lerProduto('catalogo', 'http://localhost:8765/x', { ml }), /não é da loja Catálogo do Etiqueta/);
    await assert.rejects(lerProduto('catalogo', URL_ML, { ml }), /não é da loja Catálogo do Etiqueta/);
    await assert.rejects(linkAfiliado('catalogo', { url: URL_ML, tag: 'etq' }, { links: { requestLink: async () => 'https://meli.la/x' } }), /não é da loja/);
    assert.equal(ml.chamadas.length, 0);
    assert.equal(imagemPermitida('catalogo', IMG), false);
  });
  assert.equal(chamadas, 0);
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
  assert.deepEqual(identificar('https://shp.ee/abc'), { id: 'shopee', nome: 'Shopee', implementada: true });
});

test('lojas: todo host que identificar dá como Shopee é um host que o resolvedor de shopee.js aceita seguir', () => {
  const aceito = (h) => HOSTS_SHOPEE.some((x) => h === x || h.endsWith(`.${x}`));
  for (const h of PLATAFORMAS.shopee.hosts) assert.ok(aceito(h), h);
  for (const h of HOSTS_SHOPEE) assert.equal(identificar(`https://${h}/x`)?.id, 'shopee', h);
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
    await assert.rejects(lerProduto('magalu', 'https://www.magazinevoce.com.br/x', { ml }), LojaNaoConectada);
    await assert.rejects(lerProduto('shopee', 'https://shp.ee/x', { ml }), /Serviço da Shopee indisponível/);
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

test('lojas: Magalu e Facebook lançam LojaNaoConectada com o nome na mensagem', async () => {
  const ml = mlFalso();
  const links = { chamadas: 0, async requestLink() { this.chamadas++; return 'https://meli.la/x'; } };
  const err = await lerProduto('magalu', 'https://www.magazinevoce.com.br/x', { ml }).catch((e) => e);
  assert.ok(err instanceof LojaNaoConectada && err instanceof Error);
  assert.equal(err.message, 'Magalu identificada, mas ainda não está conectada. Configure em Conexões.');
  assert.deepEqual(err.loja, { id: 'magalu', nome: 'Magalu', implementada: false });
  const outras = { magalu: ['Magalu', 'https://www.magazinevoce.com.br/x'], facebook: ['Facebook', 'https://fb.com/x'] };
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

// ------------------------------------------------------------------ Shopee (plano integracao-shopee, etapa 1)

const SHOP = '52377417';
const ITEM = '6309028319';
const URL_SHOPEE = `https://shopee.com.br/Apple-Iphone-11-128GB-Local-Set-i.${SHOP}.${ITEM}`;
const CURTO = 'https://s.shopee.com.br/9fMB7wrS3r';
const IMG_SHOPEE = 'https://down-br.img.susercontent.com/file/br-11134207-abc';
const ID_AFILIADO = '98765432101';
const SENHA_API = 'Senha-Api-SECRETA-q1w2e3';
const longoDe = (id) => `${URL_SHOPEE}?utm_campaign=-&utm_medium=affiliates&utm_source=an_${id}&utm_term=dxyz`;

/** Stub de createShopee: guarda as chamadas; cada método responde pelo que o teste mandar. */
function shopeeFalso({ ids = { shopId: SHOP, itemId: ITEM, urlProduto: URL_SHOPEE }, oferta = {}, erroItem = null, erroLink = null,
  apiUtil = false, link = 'https://s.shopee.com.br/ApiLink1', erroGerar = null } = {}) {
  const chamadas = { resolver: [], lerItem: [], gerarLink: [] };
  return {
    chamadas,
    async resolver(url) { chamadas.resolver.push(url); if (erroLink) throw erroLink; return ids; },
    async lerItem(s, i) {
      chamadas.lerItem.push([s, i]);
      if (erroItem) throw erroItem;
      if (oferta === null) return null;
      return { key: `SHOPEE:${s}.${i}`, shopId: s, itemId: i, title: 'iPhone 11', price: 1299.9, oldPrice: null, discountPct: 15, sold: 10,
        image: IMG_SHOPEE, freeShipping: false, coupon: null, extra: { loja_nome: 'Loja', nota: 4.8, preco_max: 1499 }, ...oferta };
    },
    apiUtil: () => apiUtil,
    async gerarLink(u) { chamadas.gerarLink.push(u); if (erroGerar) throw erroGerar; return link; },
  };
}

/** Stub do serviço de links com requestLinkShopee (a etapa 2 implementa o real). */
function linksShopee({ link = CURTO, longo = longoDe(ID_AFILIADO), erro = null } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async requestLinkShopee(arg) { chamadas.push(arg); if (erro) throw erro; return { link, longo }; },
    async requestLink() { throw new Error('não é para o ML'); },
  };
}

test('lojas Shopee: lerProduto lê ids do link (sem rede) ou do resolvedor e devolve key SHOPEE:<shop>.<item> (CA1, CA2)', async () => {
  const shopee = shopeeFalso();
  let oferta;
  const rede = await semRede(async () => { oferta = await lerProduto('shopee', ` ${URL_SHOPEE}?sp_atk=x&utm_source=an_1 `, { shopee, ml: mlFalso() }); });
  assert.equal(rede, 0);
  assert.deepEqual(shopee.chamadas.resolver, [], 'link de produto não passa pelo resolvedor');
  assert.deepEqual(shopee.chamadas.lerItem, [[SHOP, ITEM]]);
  assert.equal(oferta.key, `SHOPEE:${SHOP}.${ITEM}`);
  assert.equal(oferta.shopId, SHOP); assert.equal(oferta.itemId, ITEM);
  assert.equal(oferta.urlProduto, URL_SHOPEE, 'sem a query do link colado');
  assert.equal(oferta.title, 'iPhone 11'); assert.equal(oferta.price, 1299.9); assert.equal(oferta.discountPct, 15);
  assert.equal(oferta.oldPrice, null); assert.equal(oferta.image, IMG_SHOPEE);
  assert.deepEqual(oferta.extra, { loja_nome: 'Loja', nota: 4.8, preco_max: 1499 });

  // encurtador: passa pelo resolvedor; o resultado é refeito a partir do urlProduto
  const curto = shopeeFalso();
  assert.equal((await lerProduto('shopee', CURTO, { shopee: curto })).itemId, ITEM);
  assert.deepEqual(curto.chamadas.resolver, [CURTO]);
  // resolvedor que devolve algo que não é endereço de produto da Shopee não chega à API
  for (const ids of [{ shopId: SHOP, itemId: ITEM, urlProduto: 'https://evil.com/x-i.1.2' }, { shopId: '1', itemId: '2' }, null]) {
    const torto = shopeeFalso({ ids });
    await assert.rejects(lerProduto('shopee', CURTO, { shopee: torto }), (e) => e instanceof LinkShopeeNaoResolvido && e.causa === 'invalido');
    assert.equal(torto.chamadas.lerItem.length, 0);
  }
  const naoProduto = shopeeFalso({ erroLink: new LinkShopeeNaoResolvido('nao_produto') });
  await assert.rejects(lerProduto('shopee', CURTO, { shopee: naoProduto }), (e) => e.causa === 'nao_produto');
  // serviço ausente e link de outra loja
  await assert.rejects(lerProduto('shopee', URL_SHOPEE, {}), /Serviço da Shopee indisponível/);
  await assert.rejects(lerProduto('shopee', CURTO, { shopee: { lerItem() {} } }), /Serviço da Shopee indisponível/);
  await assert.rejects(lerProduto('shopee', 'https://shopee.com.br.evil.com/x-i.1.2', { shopee: shopeeFalso() }), /não é da loja Shopee/);
});

test('lojas Shopee: foto fora do CDN da Shopee vira null; imagemPermitida(shopee) (CA7)', async () => {
  const fora = ['https://evil.com/x.jpg', 'http://down-br.img.susercontent.com/file/x', 'https://susercontent.com.evil.com/x', IMG, IMG_AMZ,
    'file:///etc/passwd', null, 42, ''];
  for (const img of fora) {
    assert.equal((await lerProduto('shopee', URL_SHOPEE, { shopee: shopeeFalso({ oferta: { image: img } }) })).image, null, String(img));
    assert.equal(imagemPermitida('shopee', img), false, String(img));
  }
  for (const img of [IMG_SHOPEE, 'https://cf.shopee.com.br/file/abc']) {
    assert.equal(imagemPermitida('shopee', img), true, img);
    assert.equal(imagemPermitida('amazon', img), false);
    assert.equal(imagemPermitida('mercadolivre', img), false);
  }
});

test('lojas Shopee: erro da API vira ErroShopee novo com os ids; nao_encontrado quando não há produto', async () => {
  for (const tipo of ['sem_credenciais', 'credencial_recusada', 'conta_restrita', 'sem_acesso', 'cota', 'indisponivel']) {
    const original = new ErroShopee(tipo, { status: 200, codigoApi: 10035 });
    const e = await lerProduto('shopee', URL_SHOPEE, { shopee: shopeeFalso({ erroItem: original }) }).catch((x) => x);
    assert.ok(e instanceof ErroShopee, tipo);
    assert.equal(e.tipo, tipo); assert.equal(e.message, MENSAGENS_SHOPEE[tipo]); assert.equal(e.codigoApi, 10035);
    assert.deepEqual(e.ids, { shopId: SHOP, itemId: ITEM, urlProduto: URL_SHOPEE });
    assert.notEqual(e, original); assert.equal(original.ids, undefined);
  }
  const nulo = await lerProduto('shopee', URL_SHOPEE, { shopee: shopeeFalso({ oferta: null }) }).catch((x) => x);
  assert.ok(nulo instanceof ErroShopee); assert.equal(nulo.tipo, 'nao_encontrado'); assert.equal(nulo.ids.itemId, ITEM);
  const cru = await lerProduto('shopee', URL_SHOPEE, { shopee: shopeeFalso({ erroItem: new Error(`falhou com ${SENHA_API}`) }) }).catch((x) => x);
  assert.ok(cru instanceof ErroShopee); assert.equal(cru.tipo, 'indisponivel');
  assert.ok(!`${cru.message} ${cru.stack}`.includes(SENHA_API));
});

test('lojas Shopee: linkAfiliado pela API quando útil, sem extensão e a partir do endereço sem parâmetros (CA4)', async () => {
  const shopee = shopeeFalso({ apiUtil: true });
  const links = linksShopee();
  const rede = await semRede(async () => {
    const link = await linkAfiliado('shopee', { url: `${URL_SHOPEE}?utm_source=an_999&x=1`, tag: 'ignorada' }, { shopee, links, idAfiliado: ID_AFILIADO });
    assert.equal(link, 'https://s.shopee.com.br/ApiLink1');
  });
  assert.equal(rede, 0);
  assert.deepEqual(shopee.chamadas.gerarLink, [URL_SHOPEE]);
  assert.equal(links.chamadas.length, 0, 'API útil: a extensão não é chamada');
  // urlProduto (o do payload) tem preferência sobre url
  await linkAfiliado('shopee', { url: CURTO, urlProduto: URL_SHOPEE }, { shopee, links, idAfiliado: ID_AFILIADO });
  assert.deepEqual(shopee.chamadas.resolver, [], 'urlProduto já resolvido: nada de resolver');
});

test('lojas Shopee: linkAfiliado pela extensão sem API e como reserva quando a API falha; confere o an_<ID> (CA4)', async () => {
  // sem API útil: direto para a extensão, com o endereço sem parâmetros (link curto resolvido antes)
  const semApi = shopeeFalso({ apiUtil: false });
  const links = linksShopee();
  assert.equal(await linkAfiliado('shopee', { url: CURTO }, { shopee: semApi, links, idAfiliado: ` ${ID_AFILIADO} ` }), CURTO);
  assert.deepEqual(links.chamadas, [{ url: URL_SHOPEE }]);
  assert.deepEqual(semApi.chamadas.gerarLink, []);
  assert.deepEqual(semApi.chamadas.resolver, [CURTO]);
  // sem serviço da Shopee nenhum, link de produto: a extensão basta
  assert.equal(await linkAfiliado('shopee', { url: URL_SHOPEE }, { links: linksShopee(), idAfiliado: ID_AFILIADO }), CURTO);

  // API falha (qualquer erro): cai para a extensão
  for (const erroGerar of [new ErroShopee('sem_acesso'), new ErroShopee('indisponivel'), new Error('x')]) {
    const falha = shopeeFalso({ apiUtil: true, erroGerar });
    const l = linksShopee();
    assert.equal(await linkAfiliado('shopee', { url: URL_SHOPEE }, { shopee: falha, links: l, idAfiliado: ID_AFILIADO }), CURTO);
    assert.equal(falha.chamadas.gerarLink.length, 1); assert.equal(l.chamadas.length, 1);
  }
  // longLink sem an_ não tem como conferir: aceita (premissa do plano)
  assert.equal(await linkAfiliado('shopee', { url: URL_SHOPEE }, { links: linksShopee({ longo: null }), idAfiliado: ID_AFILIADO }), CURTO);
  assert.equal(await linkAfiliado('shopee', { url: URL_SHOPEE }, { links: linksShopee({ longo: URL_SHOPEE }), idAfiliado: ID_AFILIADO }), CURTO);

  // Chrome em outra conta: recusa com a frase da spec (4 últimos dígitos do ID salvo)
  for (const longo of [longoDe('99999999999'), `${longoDe(ID_AFILIADO)}&utm_source=an_123`]) {
    const e = await linkAfiliado('shopee', { url: URL_SHOPEE }, { links: linksShopee({ longo }), idAfiliado: ID_AFILIADO }).catch((x) => x);
    assert.ok(e instanceof ErroShopee, longo); assert.equal(e.tipo, 'outra_conta');
    assert.equal(e.message, 'O Chrome está logado em outra conta de afiliado da Shopee. Entre na conta do ID …2101 e tente de novo.');
  }
  // erro da extensão segue adiante; link que não é s.shopee.com.br nunca sai
  await assert.rejects(linkAfiliado('shopee', { url: URL_SHOPEE }, { links: linksShopee({ erro: new Error('não há sessão de afiliado da Shopee neste Chrome') }), idAfiliado: ID_AFILIADO }),
    /não há sessão de afiliado/);
  for (const link of ['https://meli.la/abc', 'https://s.shopee.com.br.evil.com/abc', `${CURTO}?x=1`, null, URL_SHOPEE]) {
    const e = await linkAfiliado('shopee', { url: URL_SHOPEE }, { links: linksShopee({ link }), idAfiliado: ID_AFILIADO }).catch((x) => x);
    assert.ok(e instanceof ErroShopee, String(link)); assert.equal(e.tipo, 'link_falhou');
  }
  await assert.rejects(linkAfiliado('shopee', { url: URL_SHOPEE }, { idAfiliado: ID_AFILIADO }), /Serviço de links indisponível/);
});

test('lojas Shopee: linkAfiliado sem ID de afiliado salvo falha com sem_id antes de qualquer chamada', async () => {
  const shopee = shopeeFalso({ apiUtil: true });
  const links = linksShopee();
  const rede = await semRede(async () => {
    for (const idAfiliado of [undefined, '', '   ', '1234', 'seunome-20', 98765432101]) {
      const e = await linkAfiliado('shopee', { url: CURTO }, { shopee, links, idAfiliado }).catch((x) => x);
      assert.ok(e instanceof ErroShopee, String(idAfiliado)); assert.equal(e.tipo, 'sem_id');
      assert.equal(e.message, 'Falta o ID de afiliado da Shopee em Conexões.');
    }
  });
  assert.equal(rede, 0);
  assert.deepEqual(shopee.chamadas, { resolver: [], lerItem: [], gerarLink: [] });
  assert.equal(links.chamadas.length, 0);
  await assert.rejects(linkAfiliado('shopee', { url: 'https://evil.com/x-i.1.2' }, { links, idAfiliado: ID_AFILIADO }), /não é da loja Shopee/);
  await assert.rejects(linkAfiliado('shopee', {}, { links, idAfiliado: ID_AFILIADO }), /não é da loja Shopee/);
});

test('lojas Shopee: ponta a ponta com createShopee (fetch falso): link curto resolvido, dados e link pela API', async () => {
  const conexao = { id_afiliado: ID_AFILIADO, app_id: '123456789', chave: SENHA_API };
  const f = fetchFalso((url) => {
    if (url === CURTO) return new Response(null, { status: 302, headers: { location: `${URL_SHOPEE}?utm_source=an_${ID_AFILIADO}` } });
    throw new Error(`rede inesperada: ${url}`);
  });
  // a API responde por um fetch próprio (o fetchFalso deste arquivo não vê o corpo)
  const api = async (url, init) => {
    if (url !== URL_API) return f(url, init);
    const { query } = JSON.parse(init.body);
    if (query.startsWith('mutation')) return Response.json({ data: { generateShortLink: { shortLink: 'https://s.shopee.com.br/ApiOk42' } } });
    return Response.json({ data: { productOfferV2: { nodes: [{ itemId: Number(ITEM), productName: 'iPhone 11', priceMin: '1299.90', priceMax: '1299.90',
      priceDiscountRate: 0, sales: 5, ratingStar: '4.9', imageUrl: IMG_SHOPEE, shopName: 'Loja' }] } } });
  };
  const shopee = createShopee({ fetch: api, lerConexao: () => conexao });
  const links = linksShopee();
  const rede = await semRede(async () => {
    const oferta = await lerProduto('shopee', CURTO, { shopee });
    assert.equal(oferta.title, 'iPhone 11'); assert.equal(oferta.price, 1299.9); assert.equal(oferta.discountPct, 0);
    assert.equal(oferta.image, IMG_SHOPEE); assert.equal(oferta.urlProduto, URL_SHOPEE);
    assert.equal(shopee.apiUtil(), true);
    assert.equal(await linkAfiliado('shopee', { urlProduto: oferta.urlProduto }, { shopee, links, idAfiliado: ID_AFILIADO }), 'https://s.shopee.com.br/ApiOk42');
  });
  assert.equal(rede, 0);
  assert.deepEqual(f.chamadas.map((c) => [c.metodo, c.url]), [['GET', CURTO]]);
  assert.equal(links.chamadas.length, 0);
  // conta sem acesso (10035): dados com erro e link pela extensão
  const semAcesso = createShopee({ fetch: async () => Response.json({ errors: [{ extensions: { code: 10035 } }] }), lerConexao: () => conexao });
  const e = await lerProduto('shopee', URL_SHOPEE, { shopee: semAcesso }).catch((x) => x);
  assert.equal(e.tipo, 'sem_acesso'); assert.equal(e.ids.urlProduto, URL_SHOPEE);
  assert.equal(semAcesso.apiUtil(), false);
  assert.equal(await linkAfiliado('shopee', { urlProduto: URL_SHOPEE }, { shopee: semAcesso, links, idAfiliado: ID_AFILIADO }), CURTO);
  assert.deepEqual(links.chamadas, [{ url: URL_SHOPEE }]);
});

test('lojas Shopee: previaDoLink continua só do Mercado Livre', async () => {
  const ml = mlFalso();
  await assert.rejects(previaDoLink(URL_SHOPEE, { ml }), /só funciona com links do Mercado Livre/);
  assert.equal(ml.chamadas.length, 0);
});

test('S2: o link da Shopee (da API ou da extensão) é guardado por produto e ID por 7 dias e não é gerado de novo a cada disparo', async () => {
  const rel = { t: 1_700_000_000_000 };
  const conexao = { id_afiliado: ID_AFILIADO, app_id: '123456789', chave: SENHA_API };
  let acesso = 'ok';
  let n = 0;
  const mutacoes = [];
  const api = async (url, init) => {
    assert.equal(url, URL_API);
    mutacoes.push(JSON.parse(init.body).query);
    if (acesso !== 'ok') return Response.json({ errors: [{ extensions: { code: 10035 } }] });
    return Response.json({ data: { generateShortLink: { shortLink: `https://s.shopee.com.br/Api${++n}x` } } });
  };
  const shopee = createShopee({ fetch: api, agora: () => rel.t, lerConexao: () => conexao });
  const links = linksShopee();
  const gerar = (u = URL_SHOPEE, id = ID_AFILIADO, l = links) => linkAfiliado('shopee', { urlProduto: u }, { shopee, links: l, idAfiliado: id });

  // pela API: o segundo disparo do mesmo produto (inclusive em outro formato de endereço) não chama a API
  assert.equal(await gerar(), 'https://s.shopee.com.br/Api1x');
  assert.equal(await gerar(), 'https://s.shopee.com.br/Api1x');
  assert.equal(await gerar(`https://shopee.com.br/product/${SHOP}/${ITEM}`), 'https://s.shopee.com.br/Api1x');
  assert.equal(mutacoes.length, 1);
  // outro produto e outro ID de afiliado geram o próprio link
  assert.equal(await gerar(`https://shopee.com.br/outro-i.${SHOP}.123`), 'https://s.shopee.com.br/Api2x');
  assert.equal(await gerar(URL_SHOPEE, '18328801340'), 'https://s.shopee.com.br/Api3x');
  assert.equal(mutacoes.length, 3);
  assert.equal(await gerar(), 'https://s.shopee.com.br/Api1x', 'o do ID anterior continua guardado para ele');
  // passados 7 dias, gera de novo
  rel.t += 7 * 24 * 3600 * 1000;
  assert.equal(await gerar(), 'https://s.shopee.com.br/Api4x');
  // salvar a conexão (invalidar) esquece
  shopee.invalidar();
  assert.equal(await gerar(), 'https://s.shopee.com.br/Api5x');
  assert.equal(mutacoes.length, 5);
  assert.equal(links.chamadas.length, 0, 'API útil: a extensão nunca foi chamada');

  // pela extensão (API sem acesso): o link também fica guardado e a extensão é chamada uma vez
  acesso = 'sem_acesso';
  shopee.invalidar();
  await assert.rejects(shopee.gerarLink(URL_SHOPEE)); // a API diz 10035: apiUtil passa a ser false
  assert.equal(shopee.apiUtil(), false);
  const ext = linksShopee({ link: CURTO });
  assert.equal(await gerar(URL_SHOPEE, ID_AFILIADO, ext), CURTO);
  assert.equal(await gerar(URL_SHOPEE, ID_AFILIADO, ext), CURTO);
  assert.deepEqual(ext.chamadas, [{ url: URL_SHOPEE }]);
  assert.equal(mutacoes.length, 6, 'nem a API foi tentada de novo');

  // extensão sem longLink, ou com longLink sem an_: o link sai, mas não é guardado (a conta não foi conferida)
  for (const longo of [null, URL_SHOPEE, `${URL_SHOPEE}?utm_source=outro&utm_medium=affiliates`]) {
    shopee.invalidar();
    await assert.rejects(shopee.gerarLink(URL_SHOPEE));
    const semProva = linksShopee({ link: CURTO, longo });
    assert.equal(await gerar(URL_SHOPEE, ID_AFILIADO, semProva), CURTO, String(longo));
    assert.equal(await gerar(URL_SHOPEE, ID_AFILIADO, semProva), CURTO);
    assert.equal(semProva.chamadas.length, 2, `${longo}: dois disparos, dois pedidos à extensão`);
    assert.equal(shopee.linkGuardado(URL_SHOPEE, ID_AFILIADO), null);
  }
  // com o longLink do dono: um pedido só
  shopee.invalidar();
  await assert.rejects(shopee.gerarLink(URL_SHOPEE));
  const comProva = linksShopee({ link: CURTO, longo: longoDe(ID_AFILIADO) });
  await gerar(URL_SHOPEE, ID_AFILIADO, comProva); await gerar(URL_SHOPEE, ID_AFILIADO, comProva);
  assert.equal(comProva.chamadas.length, 1);

  // o que não passou nas conferências não é guardado: outra conta e link fora do formato pedem de novo
  shopee.invalidar();
  await assert.rejects(shopee.gerarLink(URL_SHOPEE));
  const outra = linksShopee({ longo: longoDe('99999999999') });
  for (let i = 0; i < 2; i++) assert.equal((await gerar(URL_SHOPEE, ID_AFILIADO, outra).catch((e) => e)).tipo, 'outra_conta');
  assert.equal(outra.chamadas.length, 2);
  const torto = linksShopee({ link: 'https://meli.la/abc' });
  for (let i = 0; i < 2; i++) assert.equal((await gerar(URL_SHOPEE, ID_AFILIADO, torto).catch((e) => e)).tipo, 'link_falhou');
  assert.equal(torto.chamadas.length, 2);
  assert.equal(shopee.linkGuardado(URL_SHOPEE, ID_AFILIADO), null);

  // um linkGuardado que devolva algo fora de s.shopee.com.br nunca sai: gera de novo
  const adulterado = { ...shopeeFalso({ apiUtil: true }), linkGuardado: () => 'https://evil.example/x', guardarLink: () => true };
  assert.equal(await linkAfiliado('shopee', { urlProduto: URL_SHOPEE }, { shopee: adulterado, links, idAfiliado: ID_AFILIADO }), 'https://s.shopee.com.br/ApiLink1');
  assert.equal(adulterado.chamadas.gerarLink.length, 1);
  // sem ID válido, nem olha o guardado (sem_id antes de tudo)
  assert.equal((await gerar(URL_SHOPEE, '1234').catch((e) => e)).tipo, 'sem_id');
});

test('R5: o padrão do ID de afiliado da tela Conexões é o RE_ID_AFILIADO de shopee.js', () => {
  const campo = PLATAFORMAS.shopee.campos.find((c) => c.nome === 'id_afiliado');
  assert.equal(campo.padrao, RE_ID_AFILIADO.source);
  assert.equal(campo.padrao, '^[0-9]{5,20}$');
});

test('lojas: o fetch global nunca foi chamado (CA8)', () => {
  assert.equal(chamadasGlobais, 0);
});
