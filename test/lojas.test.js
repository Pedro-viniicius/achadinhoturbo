import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATAFORMAS, identificar, LojaNaoConectada, lerProduto, linkAfiliado, linkAfiliadoShopeeRastreado, previaDoLink, imagemPermitida,
  SUBID_PELA_EXTENSAO, SubIdIndisponivel,
  RE_ENDERECO_CATALOGO, RE_CAMINHO_TOKEN, ENDERECO_CATALOGO_PADRAO, PARECE_TOKEN, ARQUIVO_TOKEN, caminhoDoArquivoDoToken,
} from '../src/lojas.js';
import { createLinkService, LIMITE_SHOPEE_ATINGIDO } from '../src/links.js';
import { createAmazon, ErroAmazon, LinkNaoResolvido, HOSTS_AMAZON, MENSAGENS_AMAZON } from '../src/amazon.js';
import { createShopee, ErroShopee, LinkShopeeNaoResolvido, HOSTS_SHOPEE, MENSAGENS_SHOPEE, URL_API, RE_ID_AFILIADO } from '../src/shopee.js';
import { createMagalu, ErroMagalu, LinkMagaluNaoResolvido, HOSTS_MAGALU, LINK_MAGALU, MENSAGENS_MAGALU, RE_LOJA_MAGALU } from '../src/magalu.js';

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

test('lojas: registro com as 6 plataformas, campos da tela Conexões e ML, Amazon, Shopee, Magalu e Catálogo implementados', () => {
  const lista = Object.values(PLATAFORMAS);
  assert.deepEqual(lista.map((p) => p.id), ['mercadolivre', 'amazon', 'shopee', 'magalu', 'facebook', 'catalogo']);
  assert.deepEqual(lista.filter((p) => p.implementada).map((p) => p.id), ['mercadolivre', 'amazon', 'shopee', 'magalu', 'catalogo']);
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
      'https://www.magazineluiza.com.br/fone/p/123/', 'https://divulgador.magalu.com/abc', 'https://magalu.com/x', 'https://www.magalu.com/x',
      'https://maga.lu/Ab12', 'https://x.maga.lu/Ab12', 'https://magazineluiza.onelink.me/AbCd/xyz', 'https://go.magazineluiza.onelink.me/x',
      'https://m.magazineluiza.com.br/x', 'HTTPS://WWW.MAGAZINELUIZA.COM.BR/x'],
    facebook: ['https://www.facebook.com/minhapagina', 'https://facebook.com/x', 'https://m.facebook.com/x', 'https://fb.com/x', 'https://fb.me/x'],
  };
  for (const [id, urls] of Object.entries(casos)) {
    for (const u of urls) assert.equal(identificar(u)?.id, id, u);
  }
  assert.deepEqual(identificar(URL_ML), { id: 'mercadolivre', nome: 'Mercado Livre', implementada: true });
  assert.deepEqual(identificar('https://amzn.to/3xYz'), { id: 'amazon', nome: 'Amazon', implementada: true });
  assert.deepEqual(identificar('https://link.amazon/aBc12XyZ'), { id: 'amazon', nome: 'Amazon', implementada: true });
  assert.deepEqual(identificar('https://shp.ee/abc'), { id: 'shopee', nome: 'Shopee', implementada: true });
  for (const u of ['https://maga.lu/x', 'https://magazineluiza.onelink.me/x', 'https://www.magazinevoce.com.br/x', 'https://magalu.com/x']) {
    assert.deepEqual(identificar(u), { id: 'magalu', nome: 'Magalu', implementada: true }, u);
  }
});

test('lojas: os hosts da Magalu são exatamente os de magalu.js, que o resolvedor aceita seguir (CA2)', () => {
  assert.deepEqual(PLATAFORMAS.magalu.hosts, [...HOSTS_MAGALU]);
  for (const h of HOSTS_MAGALU) assert.equal(identificar(`https://${h}/x`)?.id, 'magalu', h);
  for (const u of ['https://magazineluiza.com.br.evil.com/x', 'https://xmagalu.com/x', 'https://magalu.com.evil.com/x', 'https://notmaga.lu/x',
    'https://maga.lu.evil.com/x', 'https://magazineluiza.onelink.me.evil.com/x', 'https://evil.onelink.me/x', 'https://onelink.me/x',
    'https://xmagazinevoce.com.br/x', 'https://magazineluiza.com/x', 'https://evil.com/?u=https://maga.lu/x', 'https://maga.lu@evil.com/x']) {
    assert.equal(identificar(u), null, u);
  }
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
    await assert.rejects(lerProduto('magalu', 'https://www.magazinevoce.com.br/x', { ml }), (e) => e instanceof LinkMagaluNaoResolvido && e.causa === 'invalido');
    await assert.rejects(lerProduto('magalu', 'https://maga.lu/x', { ml }), (e) => e instanceof LinkMagaluNaoResolvido && e.causa === 'invalido');
    await assert.rejects(lerProduto('facebook', 'https://fb.com/x', { ml }), LojaNaoConectada);
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

test('lojas: Facebook (a única loja não implementada) lança LojaNaoConectada com o nome na mensagem', async () => {
  const ml = mlFalso();
  const links = { chamadas: 0, async requestLink() { this.chamadas++; return 'https://meli.la/x'; } };
  const err = await lerProduto('facebook', 'https://fb.com/x', { ml }).catch((e) => e);
  assert.ok(err instanceof LojaNaoConectada && err instanceof Error);
  assert.equal(err.message, 'Facebook identificada, mas ainda não está conectada. Configure em Conexões.');
  assert.deepEqual(err.loja, { id: 'facebook', nome: 'Facebook', implementada: false });
  await assert.rejects(linkAfiliado('facebook', { url: 'https://fb.com/x', tag: 'seunome-20' }, { links }), (e) => e instanceof LojaNaoConectada && e.loja.id === 'facebook');
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
  const argsGerarLink = []; // todos os argumentos de cada gerarLink (Sub_id)
  return {
    chamadas,
    argsGerarLink,
    async resolver(url) { chamadas.resolver.push(url); if (erroLink) throw erroLink; return ids; },
    async lerItem(s, i) {
      chamadas.lerItem.push([s, i]);
      if (erroItem) throw erroItem;
      if (oferta === null) return null;
      return { key: `SHOPEE:${s}.${i}`, shopId: s, itemId: i, title: 'iPhone 11', price: 1299.9, oldPrice: null, discountPct: 15, sold: 10,
        image: IMG_SHOPEE, freeShipping: false, coupon: null, extra: { loja_nome: 'Loja', nota: 4.8, preco_max: 1499 }, ...oferta };
    },
    apiUtil: () => apiUtil,
    async gerarLink(...a) { chamadas.gerarLink.push(a[0]); argsGerarLink.push(a); if (erroGerar) throw erroGerar; return link; },
  };
}

/** Stub do serviço de links com requestLinkShopee (a etapa 2 implementa o real). */
function linksShopee({ link = CURTO, longo = longoDe(ID_AFILIADO), erro = null, aplicado } = {}) {
  const chamadas = [];
  return {
    chamadas,
    // `aplicado` indefinido = o serviço de antes do Sub_id (a resposta nem tem o campo)
    async requestLinkShopee(arg) { chamadas.push(arg); if (erro) throw erro; return aplicado === undefined ? { link, longo } : { link, longo, subIdAplicado: aplicado }; },
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

// ------------------------------------------------------------------ Sub_id (plano dashboard-ganhos, etapa 5)

/** Stub com o cache por Sub_id do contrato de shopee.js (linkGuardado/guardarLink com subId), guardando as chamadas. */
function shopeeComCache(op = {}) {
  const s = shopeeFalso(op);
  const mapa = new Map();
  const chave = (u, id, sub) => `${u}|${id}|${sub || ''}`;
  s.chamadas.linkGuardado = []; s.chamadas.guardarLink = [];
  s.linkGuardado = (...a) => { s.chamadas.linkGuardado.push(a); return mapa.get(chave(...a)) ?? null; };
  s.guardarLink = (...a) => { s.chamadas.guardarLink.push(a); mapa.set(chave(a[0], a[1], a[3]), a[2]); return true; };
  return s;
}
/** Liga o pedido de Sub_id à extensão de forma explícita (o padrão, SUBID_PELA_EXTENSAO, também é ligado desde o P4). */
const EXT = Object.freeze({ subIdPelaExtensao: true });
const SUBIDS_RUINS = ['g-1', 'g_1', 'g 1', 'ção', 'a'.repeat(31), 'g1\n', 7, true, {}, ['g1']];

test('Sub_id (CA2): linkAfiliadoShopeeRastreado pela API manda { subId } e devolve { link, sub_id }', async () => {
  const shopee = shopeeFalso({ apiUtil: true });
  const links = linksShopee();
  const rede = await semRede(async () => {
    assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee, links, idAfiliado: ID_AFILIADO, subId: 'g1' }),
      { link: 'https://s.shopee.com.br/ApiLink1', sub_id: 'g1' });
  });
  assert.equal(rede, 0);
  assert.deepEqual(shopee.argsGerarLink, [[URL_SHOPEE, { subId: 'g1' }]]);
  assert.equal(links.chamadas.length, 0);
  // sem Sub_id: a mesma chamada de hoje (só o endereço) e sub_id null
  for (const subId of [undefined, null, '']) {
    const sh = shopeeFalso({ apiUtil: true });
    assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: sh, links, idAfiliado: ID_AFILIADO, subId }),
      { link: 'https://s.shopee.com.br/ApiLink1', sub_id: null }, String(subId));
    assert.deepEqual(sh.argsGerarLink, [[URL_SHOPEE]]);
  }
});

test('Sub_id (CA2, CA9): pela extensão (sinalizador ligado), sub_id só quando ela diz que aplicou; senão o link de afiliado sai com sub_id null', async () => {
  const semApi = () => shopeeFalso({ apiUtil: false });
  // extensão antiga (sem o campo) e extensão nova com o campo vazio: link de afiliado, sem Sub_id
  for (const aplicado of [undefined, false]) {
    const links = linksShopee({ aplicado });
    assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: semApi(), links, idAfiliado: ID_AFILIADO, subId: 'g1', ...EXT }),
      { link: CURTO, sub_id: null }, String(aplicado));
    assert.deepEqual(links.chamadas, [{ url: URL_SHOPEE, subId: 'g1' }]);
  }
  // a extensão aplicou
  const links = linksShopee({ aplicado: true });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: semApi(), links, idAfiliado: ID_AFILIADO, subId: 'g1', ...EXT }), { link: CURTO, sub_id: 'g1' });
  // sem Sub_id pedido, a extensão não pode "aplicar": sub_id null, pedido igual ao de hoje
  const semSub = linksShopee({ aplicado: true });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: semApi(), links: semSub, idAfiliado: ID_AFILIADO }), { link: CURTO, sub_id: null });
  assert.deepEqual(semSub.chamadas, [{ url: URL_SHOPEE }]);
  // API falhou com Sub_id: a extensão recebe o mesmo Sub_id
  const falha = shopeeFalso({ apiUtil: true, erroGerar: new ErroShopee('indisponivel') });
  const reserva = linksShopee({ aplicado: true });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: falha, links: reserva, idAfiliado: ID_AFILIADO, subId: 'b7', ...EXT }), { link: CURTO, sub_id: 'b7' });
  assert.deepEqual(reserva.chamadas, [{ url: URL_SHOPEE, subId: 'b7' }]);
});

test('Sub_id: outra_conta e link_falhou continuam valendo com Sub_id (nunca link comum)', async () => {
  for (const longo of [longoDe('99999999999'), `${longoDe(ID_AFILIADO)}&utm_source=an_123`]) {
    const e = await linkAfiliadoShopeeRastreado(URL_SHOPEE, { links: linksShopee({ longo, aplicado: true }), idAfiliado: ID_AFILIADO, subId: 'g1', ...EXT }).catch((x) => x);
    assert.ok(e instanceof ErroShopee, longo); assert.equal(e.tipo, 'outra_conta');
  }
  for (const link of ['https://meli.la/abc', URL_SHOPEE, null]) {
    const e = await linkAfiliadoShopeeRastreado(URL_SHOPEE, { links: linksShopee({ link, aplicado: true }), idAfiliado: ID_AFILIADO, subId: 'g1', ...EXT }).catch((x) => x);
    assert.ok(e instanceof ErroShopee, String(link)); assert.equal(e.tipo, 'link_falhou');
  }
  const api = shopeeFalso({ apiUtil: true, link: 'https://evil.example/x' });
  const e = await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: api, links: linksShopee({ link: 'https://meli.la/x' }), idAfiliado: ID_AFILIADO, subId: 'g1' }).catch((x) => x);
  assert.equal(e.tipo, 'link_falhou');
  assert.equal((await linkAfiliadoShopeeRastreado(URL_SHOPEE, { links: linksShopee(), idAfiliado: '12', subId: 'g1' }).catch((x) => x)).tipo, 'sem_id');
  await assert.rejects(linkAfiliadoShopeeRastreado('https://evil.com/x-i.1.2', { links: linksShopee(), idAfiliado: ID_AFILIADO, subId: 'g1' }), /não é da loja Shopee/);
});

test('Sub_id (D4): Sub_id inválido não sai de lojas.js; vale o link padrão, com sub_id null', async () => {
  for (const subId of SUBIDS_RUINS) {
    const api = shopeeFalso({ apiUtil: true });
    assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: api, links: linksShopee(), idAfiliado: ID_AFILIADO, subId }),
      { link: 'https://s.shopee.com.br/ApiLink1', sub_id: null }, String(subId));
    assert.deepEqual(api.argsGerarLink, [[URL_SHOPEE]]);
    const ext = linksShopee({ aplicado: true });
    assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso(), links: ext, idAfiliado: ID_AFILIADO, subId }), { link: CURTO, sub_id: null });
    assert.deepEqual(ext.chamadas, [{ url: URL_SHOPEE }]);
  }
});

test('Sub_id (S2): link guardado por Sub_id; o que a extensão não aplicou vale como link padrão, nunca como o do Sub_id', async () => {
  // pela API: guarda com o Sub_id e o segundo pedido do mesmo Sub_id não chama a API
  const api = shopeeComCache({ apiUtil: true });
  const links = linksShopee();
  const r1 = await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: api, links, idAfiliado: ID_AFILIADO, subId: 'g1' });
  const r2 = await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: api, links, idAfiliado: ID_AFILIADO, subId: 'g1' });
  assert.deepEqual([r1, r2], [{ link: 'https://s.shopee.com.br/ApiLink1', sub_id: 'g1' }, { link: 'https://s.shopee.com.br/ApiLink1', sub_id: 'g1' }]);
  assert.equal(api.chamadas.gerarLink.length, 1);
  assert.deepEqual(api.chamadas.guardarLink, [[URL_SHOPEE, ID_AFILIADO, 'https://s.shopee.com.br/ApiLink1', 'g1']]);
  assert.deepEqual(api.chamadas.linkGuardado, [[URL_SHOPEE, ID_AFILIADO, 'g1'], [URL_SHOPEE, ID_AFILIADO, 'g1']]);
  // sem Sub_id: as chamadas de hoje (sem o 4º/3º argumento)
  await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: api, links, idAfiliado: ID_AFILIADO });
  assert.deepEqual(api.chamadas.linkGuardado.at(-1), [URL_SHOPEE, ID_AFILIADO]);
  assert.deepEqual(api.chamadas.guardarLink.at(-1), [URL_SHOPEE, ID_AFILIADO, 'https://s.shopee.com.br/ApiLink1']);
  assert.equal(api.chamadas.gerarLink.length, 2, 'o padrão não reaproveita o link do Sub_id');

  // pela extensão sem aplicar (an_ conferido): guarda como padrão, não como g1
  const ext = shopeeComCache();
  const naoAplica = linksShopee({ aplicado: false });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: ext, links: naoAplica, idAfiliado: ID_AFILIADO, subId: 'g1', ...EXT }), { link: CURTO, sub_id: null });
  assert.deepEqual(ext.chamadas.guardarLink, [[URL_SHOPEE, ID_AFILIADO, CURTO]]);
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: ext, links: naoAplica, idAfiliado: ID_AFILIADO }), { link: CURTO, sub_id: null });
  assert.equal(naoAplica.chamadas.length, 1, 'o padrão veio do guardado');
  await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: ext, links: naoAplica, idAfiliado: ID_AFILIADO, subId: 'g1', ...EXT });
  assert.equal(naoAplica.chamadas.length, 2, 'g1 não ficou guardado: pede de novo');

  // pela extensão aplicando (an_ conferido): guarda com o Sub_id
  const ext2 = shopeeComCache();
  const aplica = linksShopee({ aplicado: true });
  await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: ext2, links: aplica, idAfiliado: ID_AFILIADO, subId: 'g1', ...EXT });
  assert.deepEqual(ext2.chamadas.guardarLink, [[URL_SHOPEE, ID_AFILIADO, CURTO, 'g1']]);
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: ext2, links: aplica, idAfiliado: ID_AFILIADO, subId: 'g1', ...EXT }), { link: CURTO, sub_id: 'g1' });
  assert.equal(aplica.chamadas.length, 1);

  // aplicado mas sem prova da conta (longLink sem an_): sai com o Sub_id, não é guardado
  const ext3 = shopeeComCache();
  const semProva = linksShopee({ aplicado: true, longo: null });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: ext3, links: semProva, idAfiliado: ID_AFILIADO, subId: 'g1', ...EXT }), { link: CURTO, sub_id: 'g1' });
  assert.deepEqual(ext3.chamadas.guardarLink, []);

  // guardado adulterado (fora de s.shopee.com.br) nunca sai
  const adulterado = { ...shopeeFalso({ apiUtil: true }), linkGuardado: () => 'https://evil.example/x', guardarLink: () => true };
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: adulterado, links, idAfiliado: ID_AFILIADO, subId: 'g1' }),
    { link: 'https://s.shopee.com.br/ApiLink1', sub_id: 'g1' });
});

test('Sub_id: linkAfiliado da Shopee segue devolvendo só o link (texto), como hoje', async () => {
  const link = await linkAfiliado('shopee', { urlProduto: URL_SHOPEE }, { links: linksShopee({ aplicado: false }), idAfiliado: ID_AFILIADO });
  assert.equal(link, CURTO);
});

test('Sub_id ponta a ponta com createLinkService (extensão simulada): sub_id_aplicado vira sub_id; extensão antiga, null', async () => {
  for (const [resposta, esperado] of [
    [{ ok: true, link: CURTO, longo: longoDe(ID_AFILIADO), sub_id_aplicado: true }, { link: CURTO, sub_id: 'g1' }],
    [{ ok: true, link: CURTO, longo: longoDe(ID_AFILIADO), sub_id_aplicado: false }, { link: CURTO, sub_id: null }],
    [{ ok: true, link: CURTO, longo: longoDe(ID_AFILIADO) }, { link: CURTO, sub_id: null }],
  ]) {
    const links = createLinkService({ getMode: () => 'extension' });
    const proximo = links.poll(2000);
    const r = linkAfiliadoShopeeRastreado(URL_SHOPEE, { links, idAfiliado: ID_AFILIADO, subId: 'g1', ...EXT });
    const job = await proximo;
    assert.deepEqual({ ...job, id: 0 }, { id: 0, type: 'link_shopee', url: URL_SHOPEE, subId: 'g1' });
    links.submit(job.id, resposta);
    assert.deepEqual(await r, esperado, JSON.stringify(resposta));
  }
});

test('Sub_id (CA2, P4): SUBID_PELA_EXTENSAO ligado; com Sub_id e sem a API, o pedido vai à extensão com subId', async () => {
  assert.equal(SUBID_PELA_EXTENSAO, true, 'ligado: a extensão aplica o Sub_id em advancedLinkParams.subId1 (P4 capturado)');
  // sem API útil e sem o sinalizador explícito: o padrão pede à extensão com o Sub_id
  const aplica = linksShopee({ aplicado: true });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso({ apiUtil: false }), links: aplica, idAfiliado: ID_AFILIADO, subId: 'g1' }),
    { link: CURTO, sub_id: 'g1' });
  assert.deepEqual(aplica.chamadas, [{ url: URL_SHOPEE, subId: 'g1' }]);
  // a extensão não aplicou: o link de afiliado sem Sub_id, sub_id null (a falta vai para a cobertura em envios.js)
  const naoAplica = linksShopee({ aplicado: false });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso({ apiUtil: false }), links: naoAplica, idAfiliado: ID_AFILIADO, subId: 'g1' }),
    { link: CURTO, sub_id: null });
  assert.deepEqual(naoAplica.chamadas, [{ url: URL_SHOPEE, subId: 'g1' }]);
  // a API falhou com o Sub_id: a extensão é a reserva, com o mesmo Sub_id
  const falha = shopeeFalso({ apiUtil: true, erroGerar: new ErroShopee('indisponivel') });
  const reserva = linksShopee({ aplicado: true });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: falha, links: reserva, idAfiliado: ID_AFILIADO, subId: 'g1' }), { link: CURTO, sub_id: 'g1' });
  assert.deepEqual(reserva.chamadas, [{ url: URL_SHOPEE, subId: 'g1' }]);
  // a API útil continua na frente: nenhum pedido à extensão
  const api = shopeeFalso({ apiUtil: true });
  const semPedido = linksShopee({ aplicado: true });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: api, links: semPedido, idAfiliado: ID_AFILIADO, subId: 'g1' }),
    { link: 'https://s.shopee.com.br/ApiLink1', sub_id: 'g1' });
  assert.deepEqual(semPedido.chamadas, []);
});

test('Sub_id (CA9): extensão antiga (resposta sem sub_id_aplicado) → link de afiliado com sub_id null, sem erro', async () => {
  // stub do serviço de links de antes do Sub_id (a resposta nem tem o campo)
  const antigo = linksShopee();
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso({ apiUtil: false }), links: antigo, idAfiliado: ID_AFILIADO, subId: 'g1' }),
    { link: CURTO, sub_id: null });
  assert.deepEqual(antigo.chamadas, [{ url: URL_SHOPEE, subId: 'g1' }]);
  // ponta a ponta: o createLinkService com a extensão respondendo só { ok, link, longo }
  const links = createLinkService({ getMode: () => 'extension' });
  const proximo = links.poll(2000);
  const r = linkAfiliadoShopeeRastreado(URL_SHOPEE, { links, idAfiliado: ID_AFILIADO, subId: 'g1' });
  const job = await proximo;
  assert.deepEqual({ ...job, id: 0 }, { id: 0, type: 'link_shopee', url: URL_SHOPEE, subId: 'g1' });
  links.submit(job.id, { ok: true, link: CURTO, longo: longoDe(ID_AFILIADO) });
  assert.deepEqual(await r, { link: CURTO, sub_id: null });
  // guardado como o link padrão, nunca como o do Sub_id
  const cache = shopeeComCache();
  await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: cache, links: linksShopee(), idAfiliado: ID_AFILIADO, subId: 'g1' });
  assert.deepEqual(cache.chamadas.guardarLink, [[URL_SHOPEE, ID_AFILIADO, CURTO]]);
});

test('Sub_id (CA9): o pedido com Sub_id à extensão gasta vaga do teto por hora; esgotado → LIMITE_SHOPEE_ATINGIDO, sem ir à fila', async () => {
  const links = createLinkService({ getMode: () => 'extension', limiteShopeeHora: 1 });
  const proximo = links.poll(2000);
  const r = linkAfiliadoShopeeRastreado(URL_SHOPEE, { links, idAfiliado: ID_AFILIADO, subId: 'g1' });
  const job = await proximo;
  links.submit(job.id, { ok: true, link: CURTO, longo: longoDe(ID_AFILIADO), sub_id_aplicado: true });
  assert.deepEqual(await r, { link: CURTO, sub_id: 'g1' });
  await links.poll(1); // a extensão segue on-line
  await assert.rejects(linkAfiliadoShopeeRastreado(URL_SHOPEE, { links, idAfiliado: ID_AFILIADO, subId: 'g2' }), (e) => e.message === LIMITE_SHOPEE_ATINGIDO);
  assert.equal(links.status().pending, 0, 'o pedido recusado não foi para a fila');
});

test('Sub_id (economia do teto de 60/h): com subIdPelaExtensao desligado, nunca pede Sub_id à extensão; a API segue valendo', async () => {
  // sem API útil: recusa sem pedir nada à extensão; o motivo vai para a cobertura
  const links = linksShopee({ aplicado: true });
  const e = await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso({ apiUtil: false }), links, idAfiliado: ID_AFILIADO, subId: 'g1', subIdPelaExtensao: false }).catch((x) => x);
  assert.ok(e instanceof SubIdIndisponivel, `veio ${e?.name}`);
  assert.equal(e.motivo, 'subid_extensao_indisponivel');
  assert.doesNotMatch(e.message, /g1|98765432101/, 'a mensagem não carrega Sub_id nem ID');
  assert.deepEqual(links.chamadas, [], 'nenhum pedido à extensão');
  // a API falhou com o Sub_id: não cai na extensão com Sub_id; motivo de falha do link
  const falha = shopeeFalso({ apiUtil: true, erroGerar: new ErroShopee('indisponivel') });
  const e2 = await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: falha, links, idAfiliado: ID_AFILIADO, subId: 'g1', subIdPelaExtensao: false }).catch((x) => x);
  assert.ok(e2 instanceof SubIdIndisponivel);
  assert.equal(e2.motivo, 'falha_link');
  assert.deepEqual(links.chamadas, []);
  // o sinalizador só aceita o true literal
  for (const v of [false, 'true', 1, null]) {
    const e3 = await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso(), links, idAfiliado: ID_AFILIADO, subId: 'g1', subIdPelaExtensao: v }).catch((x) => x);
    assert.ok(e3 instanceof SubIdIndisponivel, String(v));
  }
  assert.deepEqual(links.chamadas, []);
  // a API útil aplica o Sub_id como antes
  const api = shopeeFalso({ apiUtil: true });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: api, links, idAfiliado: ID_AFILIADO, subId: 'g1', subIdPelaExtensao: false }),
    { link: 'https://s.shopee.com.br/ApiLink1', sub_id: 'g1' });
  assert.deepEqual(api.argsGerarLink, [[URL_SHOPEE, { subId: 'g1' }]]);
  // sem Sub_id (ou inválido), a extensão segue sendo a reserva do link padrão, como hoje
  for (const subId of [undefined, '', 'g-1']) {
    const ext = linksShopee();
    assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso(), links: ext, idAfiliado: ID_AFILIADO, subId, subIdPelaExtensao: false }), { link: CURTO, sub_id: null });
    assert.deepEqual(ext.chamadas, [{ url: URL_SHOPEE }]);
  }
  // o link com Sub_id já guardado (gerado antes pela API) sai sem pedido nenhum
  const guardado = shopeeComCache();
  guardado.guardarLink(URL_SHOPEE, ID_AFILIADO, 'https://s.shopee.com.br/Guardado1', 'g1');
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: guardado, links, idAfiliado: ID_AFILIADO, subId: 'g1', subIdPelaExtensao: false }),
    { link: 'https://s.shopee.com.br/Guardado1', sub_id: 'g1' });
  assert.deepEqual(links.chamadas, []);
});

test('R3/S2: reservaVagas — com Sub_id, a extensão só é chamada com mais vagas no teto da hora que a reserva; senão limite_shopee sem pedido. O link padrão e a API não passam por ela', async () => {
  const comVagas = (n, opcoes) => Object.assign(linksShopee(opcoes), { vagasShopee: () => n });
  // no limite da reserva: recusa sem pedido, com o motivo da cobertura
  const cheia = comVagas(11, { aplicado: true });
  const e = await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso(), links: cheia, idAfiliado: ID_AFILIADO, subId: 'g1', reservaVagas: 11 }).catch((x) => x);
  assert.ok(e instanceof SubIdIndisponivel, `veio ${e?.name}`);
  assert.equal(e.motivo, 'limite_shopee');
  assert.doesNotMatch(e.message, /g1|98765432101/, 'a mensagem não carrega Sub_id nem ID');
  assert.deepEqual(cheia.chamadas, [], 'nenhum pedido à extensão');
  // uma vaga acima da reserva: pede, com o Sub_id
  const livre = comVagas(12, { aplicado: true });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso(), links: livre, idAfiliado: ID_AFILIADO, subId: 'g1', reservaVagas: 11 }), { link: CURTO, sub_id: 'g1' });
  assert.deepEqual(livre.chamadas, [{ url: URL_SHOPEE, subId: 'g1' }]);
  // o link padrão (sem Sub_id) usa a reserva: é para ele que ela existe
  for (const subId of [undefined, '']) {
    const base = comVagas(1);
    assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso(), links: base, idAfiliado: ID_AFILIADO, subId, reservaVagas: 11 }), { link: CURTO, sub_id: null });
    assert.deepEqual(base.chamadas, [{ url: URL_SHOPEE }]);
    assert.equal(await linkAfiliado('shopee', { urlProduto: URL_SHOPEE }, { shopee: shopeeFalso(), links: comVagas(1), idAfiliado: ID_AFILIADO }), CURTO);
  }
  // a API útil gera o link com Sub_id sem olhar as vagas da extensão
  const api = shopeeFalso({ apiUtil: true });
  const semVaga = comVagas(0);
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: api, links: semVaga, idAfiliado: ID_AFILIADO, subId: 'g1', reservaVagas: 11 }), { link: 'https://s.shopee.com.br/ApiLink1', sub_id: 'g1' });
  assert.deepEqual(semVaga.chamadas, []);
  // o link com Sub_id já guardado também não
  const guardado = shopeeComCache();
  guardado.guardarLink(URL_SHOPEE, ID_AFILIADO, 'https://s.shopee.com.br/Guardado1', 'g1');
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: guardado, links: semVaga, idAfiliado: ID_AFILIADO, subId: 'g1', reservaVagas: 11 }), { link: 'https://s.shopee.com.br/Guardado1', sub_id: 'g1' });
  // sem reserva (o padrão) ou reserva inválida: como antes, só o teto do serviço de links vale
  for (const reservaVagas of [undefined, 0, -1, 1.5, '11', null, Infinity]) {
    const l = comVagas(0, { aplicado: true });
    assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso(), links: l, idAfiliado: ID_AFILIADO, subId: 'g1', reservaVagas }), { link: CURTO, sub_id: 'g1' }, String(reservaVagas));
    assert.equal(l.chamadas.length, 1);
  }
  // serviço de links sem vagasShopee: não dá para saber, pede como antes
  const antigo = linksShopee({ aplicado: true });
  assert.deepEqual(await linkAfiliadoShopeeRastreado(URL_SHOPEE, { shopee: shopeeFalso(), links: antigo, idAfiliado: ID_AFILIADO, subId: 'g1', reservaVagas: 11 }), { link: CURTO, sub_id: 'g1' });
  // com o serviço real: 12 de teto e reserva 11 → um Sub_id pedido, o 2º recusado, o padrão ainda sai
  const real = createLinkService({ getMode: () => 'extension', limiteShopeeHora: 12 });
  const proximo = real.poll(2000);
  const r = linkAfiliadoShopeeRastreado(URL_SHOPEE, { links: real, idAfiliado: ID_AFILIADO, subId: 'g1', reservaVagas: 11 });
  real.submit((await proximo).id, { ok: true, link: CURTO, sub_id_aplicado: true });
  assert.deepEqual(await r, { link: CURTO, sub_id: 'g1' });
  await real.poll(1);
  const e2 = await linkAfiliadoShopeeRastreado(URL_SHOPEE, { links: real, idAfiliado: ID_AFILIADO, subId: 'g2', reservaVagas: 11 }).catch((x) => x);
  assert.equal(e2?.motivo, 'limite_shopee');
  assert.equal(real.status().pending, 0);
  const proximo2 = real.poll(2000);
  const r2 = linkAfiliadoShopeeRastreado(URL_SHOPEE, { links: real, idAfiliado: ID_AFILIADO, reservaVagas: 11 });
  real.submit((await proximo2).id, { ok: true, link: CURTO });
  assert.deepEqual(await r2, { link: CURTO, sub_id: null });
  assert.equal(real.vagasShopee(), 10);
});

// ------------------------------------------------------------------------- Magalu (plano integracao-magalu, etapa 2)
const LOJA_MAGALU = 'magazineminhaloja';
const OUTRA_MAGALU = 'magazineoutroparceiro';
const COD_MAGALU = '237962600';
const CANON_MAGALU = `https://www.magazineluiza.com.br/smartphone-galaxy-a15/p/${COD_MAGALU}/te/ga15/`;
const LINK_DONO = `https://www.magazinevoce.com.br/${LOJA_MAGALU}/smartphone-galaxy-a15/p/${COD_MAGALU}/te/ga15/`;
const VAZIOS_MAGALU = { title: null, price: null, oldPrice: null, discountPct: null, sold: null, freeShipping: null, coupon: null, image: null };

/** Cliente da Magalu falso: resolver devolve `resposta` (ou lança) e conta as chamadas. */
function magaluFalso(resposta) {
  const chamadas = [];
  return { chamadas, async resolver(url) { chamadas.push(url); if (resposta instanceof Error) throw resposta; return resposta; } };
}

test('lojas Magalu (CA1): registro com a descrição, a dica e a frase de recusa da spec; o padrão é RE_LOJA_MAGALU', () => {
  const p = PLATAFORMAS.magalu;
  assert.equal(p.implementada, true);
  assert.equal(p.descricao, 'Parceiro Magalu (Magazine Você): o link de afiliado sai com o nome da sua loja de parceiro. A Magalu não deixa o painel ler o produto: título, preço e foto você preenche no Disparo manual.');
  assert.equal(p.campos.length, 1);
  const c = p.campos[0];
  assert.equal(c.nome, 'loja'); assert.equal(c.rotulo, 'Nome da sua loja'); assert.equal(c.tipo, 'texto'); assert.equal(c.max, 60);
  assert.equal(c.padrao, RE_LOJA_MAGALU.source);
  assert.equal(c.padrao, '^[A-Za-z0-9_-]{2,60}$');
  assert.equal(c.ajuda, 'É o trecho que vem depois de magazinevoce.com.br/ no endereço da sua loja. Se o endereço é magazinevoce.com.br/minhaloja, escreva minhaloja. Só letras, números, hífen e _.');
  assert.equal(c.erro, 'Escreva só o nome da loja (o trecho depois de magazinevoce.com.br/), com letras, números, hífen ou _.');
});

test('lojas Magalu: lerProduto lê o produto do link sem rede e sem resolvedor; nada é lido da página (D3)', async () => {
  const magalu = magaluFalso(new Error('não devia resolver'));
  const chamadas = await semRede(async () => {
    assert.deepEqual(await lerProduto('magalu', `  ${CANON_MAGALU}?utm_source=zap&seller_id=lojaboa#x `, { magalu }), {
      key: `MAGALU:${COD_MAGALU}`, codigo: COD_MAGALU, urlProduto: `${CANON_MAGALU}?seller_id=lojaboa`, sellerId: 'lojaboa', lojaDoLink: null, ...VAZIOS_MAGALU,
    });
    // link da loja de outro parceiro: o endereço canônico não leva a loja dele; ela só volta em lojaDoLink
    const outro = await lerProduto('magalu', `https://www.magazinevoce.com.br/${OUTRA_MAGALU}/smartphone-galaxy-a15/p/${COD_MAGALU}/te/ga15/`);
    assert.deepEqual(outro, { key: `MAGALU:${COD_MAGALU}`, codigo: COD_MAGALU, urlProduto: CANON_MAGALU, sellerId: null, lojaDoLink: OUTRA_MAGALU, ...VAZIOS_MAGALU });
    assert.ok(!outro.urlProduto.includes(OUTRA_MAGALU));
  });
  assert.equal(chamadas, 0);
  assert.equal(magalu.chamadas.length, 0);
});

test('lojas Magalu (CA6): link curto passa pelo resolvedor injetado; o que ele devolve é conferido de novo', async () => {
  const bom = magaluFalso({ codigo: COD_MAGALU, urlProduto: CANON_MAGALU, sellerId: null, lojaDoLink: OUTRA_MAGALU });
  assert.deepEqual(await lerProduto('magalu', 'https://maga.lu/Ab12', { magalu: bom }),
    { key: `MAGALU:${COD_MAGALU}`, codigo: COD_MAGALU, urlProduto: CANON_MAGALU, sellerId: null, lojaDoLink: OUTRA_MAGALU, ...VAZIOS_MAGALU });
  assert.deepEqual(bom.chamadas, ['https://maga.lu/Ab12']);
  // resolvedor que devolve algo que não é produto da Magalu (ou campos adulterados): invalido, sem confiar nele
  for (const ruim of [null, {}, { urlProduto: 'https://evil.com/x/p/237962600/' }, { urlProduto: 'https://maga.lu/x' }, { urlProduto: 42 }]) {
    await assert.rejects(lerProduto('magalu', 'https://maga.lu/Ab12', { magalu: magaluFalso(ruim) }), (e) => e instanceof LinkMagaluNaoResolvido && e.causa === 'invalido', JSON.stringify(ruim));
  }
  const adulterado = await lerProduto('magalu', 'https://maga.lu/Ab12', {
    magalu: magaluFalso({ codigo: 'outro', urlProduto: CANON_MAGALU, sellerId: '<x>', lojaDoLink: 'loja ruim/../x' }),
  });
  assert.equal(adulterado.codigo, COD_MAGALU, 'o código vem do endereço refeito');
  assert.equal(adulterado.sellerId, null);
  assert.equal(adulterado.lojaDoLink, null);
  // a falha do resolvedor segue com a causa dele
  await assert.rejects(lerProduto('magalu', 'https://maga.lu/Ab12', { magalu: magaluFalso(new LinkMagaluNaoResolvido('nao_produto')) }),
    (e) => e instanceof LinkMagaluNaoResolvido && e.causa === 'nao_produto');
  // sem o cliente, o link curto é invalido sem rede
  assert.equal(await semRede(async () => {
    for (const url of ['https://maga.lu/Ab12', 'https://magazineluiza.onelink.me/AbCd/x', 'https://divulgador.magalu.com/q']) {
      await assert.rejects(lerProduto('magalu', url), (e) => e instanceof LinkMagaluNaoResolvido && e.causa === 'invalido', url);
    }
  }), 0);
});

test('lojas Magalu (CA6): ponta a ponta com createMagalu (fetch falso): 302 do curto vira o produto sem pedir a página', async () => {
  const chamadas = [];
  const fetch = async (url) => { chamadas.push(String(url)); return new Response(null, { status: 302, headers: { location: `https://www.magazinevoce.com.br/${OUTRA_MAGALU}/smartphone-galaxy-a15/p/${COD_MAGALU}/te/ga15/?utm_source=app` } }); };
  const magalu = createMagalu({ fetch });
  const p = await lerProduto('magalu', 'https://magazineluiza.onelink.me/AbCd/xyz', { magalu });
  assert.equal(p.urlProduto, CANON_MAGALU);
  assert.equal(p.lojaDoLink, OUTRA_MAGALU);
  assert.deepEqual(chamadas, ['https://magazineluiza.onelink.me/AbCd/xyz']);
  assert.equal(await linkAfiliado('magalu', { urlProduto: p.urlProduto }, { lojaParceiro: LOJA_MAGALU }), LINK_DONO);
});

test('lojas Magalu (CA3): linkAfiliado monta o link com a loja de Conexões, sem rede; nunca a loja do link colado, utm nem fragmento', async () => {
  const links = { chamadas: 0, async requestLink() { this.chamadas++; return 'https://meli.la/x'; } };
  const chamadas = await semRede(async () => {
    assert.equal(await linkAfiliado('magalu', { urlProduto: CANON_MAGALU }, { lojaParceiro: LOJA_MAGALU }), LINK_DONO);
    assert.equal(await linkAfiliado('magalu', { url: `https://www.magazinevoce.com.br/${OUTRA_MAGALU}/smartphone-galaxy-a15/p/${COD_MAGALU}/te/ga15/?utm_source=x#${OUTRA_MAGALU}`, tag: 'seunome-20' },
      { lojaParceiro: LOJA_MAGALU, links }), LINK_DONO);
    assert.equal(await linkAfiliado('magalu', { url: 'https://maga.lu/x', urlProduto: `${CANON_MAGALU}?seller_id=lojaboa&utm_medium=y` }, { lojaParceiro: LOJA_MAGALU }),
      `${LINK_DONO}?seller_id=lojaboa`);
    for (const l of [await linkAfiliado('magalu', { url: `https://magazinevoce.com.br/${OUTRA_MAGALU}/p/${COD_MAGALU}/` }, { lojaParceiro: LOJA_MAGALU })]) {
      assert.match(l, LINK_MAGALU);
      assert.ok(!l.includes(OUTRA_MAGALU), l);
    }
  });
  assert.equal(chamadas, 0);
  assert.equal(links.chamadas, 0, 'a etiqueta do ML não entra');
});

test('lojas Magalu: linkAfiliado sem loja válida é ErroMagalu sem_loja; link curto, de outra loja ou que não é produto é recusado sem rede', async () => {
  const chamadas = await semRede(async () => {
    for (const lojaParceiro of [undefined, null, '', 'a', 'minha loja', 'loja/../x', 42]) {
      await assert.rejects(linkAfiliado('magalu', { urlProduto: CANON_MAGALU }, { lojaParceiro }), (e) => {
        assert.ok(e instanceof ErroMagalu, String(lojaParceiro));
        assert.equal(e.tipo, 'sem_loja');
        assert.equal(e.message, MENSAGENS_MAGALU.sem_loja);
        return true;
      });
    }
    // o link curto é resolvido antes (lerProduto): aqui ele não vira link nem acessa a rede
    for (const url of ['https://maga.lu/Ab12', 'https://www.magazineluiza.com.br/', `https://www.magazineluiza.com.br/x/../p/${COD_MAGALU}/`]) {
      await assert.rejects(linkAfiliado('magalu', { url }, { lojaParceiro: LOJA_MAGALU }), (e) => e instanceof LinkMagaluNaoResolvido && e.causa === 'invalido', url);
    }
    for (const url of [`https://evil.com/x/p/${COD_MAGALU}/`, URL_ML, undefined]) {
      await assert.rejects(linkAfiliado('magalu', { url }, { lojaParceiro: LOJA_MAGALU }), /não é da loja Magalu/, String(url));
    }
  });
  assert.equal(chamadas, 0);
});

test('lojas Magalu (CA8): previaDoLink continua só do Mercado Livre e a Magalu segue sem foto permitida', async () => {
  const ml = mlFalso();
  for (const url of [CANON_MAGALU, 'https://maga.lu/x']) {
    await assert.rejects(previaDoLink(url, { ml }), (e) => !(e instanceof LojaNaoConectada) && /só funciona com links do Mercado Livre/.test(e.message));
  }
  assert.equal(ml.chamadas.length, 0);
  for (const img of ['https://a-static.mlcdn.com.br/x.jpg', 'https://www.magazineluiza.com.br/x.jpg', IMG]) assert.equal(imagemPermitida('magalu', img), false, img);
});

test('R5: o padrão do ID de afiliado da tela Conexões é o RE_ID_AFILIADO de shopee.js', () => {
  const campo = PLATAFORMAS.shopee.campos.find((c) => c.nome === 'id_afiliado');
  assert.equal(campo.padrao, RE_ID_AFILIADO.source);
  assert.equal(campo.padrao, '^[0-9]{5,20}$');
});

test('lojas: o fetch global nunca foi chamado (CA8)', () => {
  assert.equal(chamadasGlobais, 0);
});
