import test from 'node:test';
import assert from 'node:assert/strict';
import { PLATAFORMAS, identificar, LojaNaoConectada, lerProduto, linkAfiliado, previaDoLink } from '../src/lojas.js';
import { createLinkService } from '../src/links.js';

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

test('lojas: registro com as 5 plataformas, campos da tela Conexões e só o ML implementado', () => {
  const lista = Object.values(PLATAFORMAS);
  assert.deepEqual(lista.map((p) => p.id), ['mercadolivre', 'amazon', 'shopee', 'magalu', 'facebook']);
  assert.deepEqual(lista.filter((p) => p.implementada).map((p) => p.id), ['mercadolivre']);
  const campos = Object.fromEntries(lista.map((p) => [p.id, p.campos.map((c) => `${c.nome}:${c.tipo}`)]));
  assert.deepEqual(campos, {
    mercadolivre: ['etiqueta:texto'], amazon: ['tag:texto'], shopee: ['app_id:texto', 'chave:segredo'],
    magalu: ['loja:texto'], facebook: [],
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
  assert.ok(re('shopee', 'app_id').test('11312345678') && !re('shopee', 'app_id').test('abc'));
  assert.ok(re('mercadolivre', 'etiqueta').test('minha_etiqueta') && !re('mercadolivre', 'etiqueta').test('a b'));
  // id vindo da requisição não acha propriedade herdada, e o registro não muda em tempo de execução
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(PLATAFORMAS[id], undefined, id);
  assert.throws(() => { PLATAFORMAS.amazon.implementada = true; }, TypeError);
  assert.throws(() => { PLATAFORMAS.shopee.hosts.push('evil.com'); }, TypeError);
});

test('lojas: identificar reconhece cada loja pelo host e pelo encurtador', () => {
  const casos = {
    mercadolivre: [URL_ML, 'https://meli.la/2AbCdEf', 'https://www.mercadolivre.com.br/p/MLB555555', 'https://mercadolivre.com.br/ofertas',
      'https://lista.mercadolivre.com.br/fone', 'HTTPS://WWW.MERCADOLIVRE.COM.BR/X', `  ${URL_ML}  `],
    amazon: ['https://amzn.to/3xYz', 'https://www.amazon.com.br/dp/B0ABC12345', 'https://amazon.com.br/x', 'https://a.co/d/abc'],
    shopee: ['https://s.shopee.com.br/AbC123', 'https://shp.ee/abc', 'https://shope.ee/abc', 'https://shopee.com.br/Fone-i.123.456'],
    magalu: ['https://www.magazinevoce.com.br/magazineminhaloja/p/123/', 'https://magazinevoce.com.br/x',
      'https://www.magazineluiza.com.br/fone/p/123/', 'https://divulgador.magalu.com/abc'],
    facebook: ['https://www.facebook.com/minhapagina', 'https://facebook.com/x', 'https://m.facebook.com/x', 'https://fb.com/x', 'https://fb.me/x'],
  };
  for (const [id, urls] of Object.entries(casos)) {
    for (const u of urls) assert.equal(identificar(u)?.id, id, u);
  }
  assert.deepEqual(identificar(URL_ML), { id: 'mercadolivre', nome: 'Mercado Livre', implementada: true });
  assert.deepEqual(identificar('https://amzn.to/3xYz'), { id: 'amazon', nome: 'Amazon', implementada: false });
});

test('lojas: host falso é recusado (só host exato ou subdomínio com ponto)', () => {
  const falsos = [
    'https://mercadolivre.com.br.evil.com/MLB-1234567890', 'https://evilmercadolivre.com.br/MLB-1234567890',
    'https://meli.la.evil.com/abc', 'https://notmeli.la/abc', 'https://amazon.com.br.example.com/dp/X',
    'https://fakeamazon.com.br/dp/X', 'https://shopee.com.br-promo.com/x', 'https://evil.com/?u=https://mercadolivre.com.br/MLB-1',
    'https://evil.com/mercadolivre.com.br', 'https://evil.com#meli.la', 'https://mercadolivre.com.br@evil.com/MLB-1',
    'https://mercadolivre.com.br%2Eevil.com/', 'https://example.com/', 'http://127.0.0.1/', 'http://[::1]/',
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
    await assert.rejects(previaDoLink('https://amzn.to/x', { ml }), LojaNaoConectada);
    await assert.rejects(lerProduto('shopee', 'https://shp.ee/x', { ml }), LojaNaoConectada);
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

test('lojas: Amazon e as outras lojas lançam LojaNaoConectada com o nome na mensagem', async () => {
  const ml = mlFalso();
  const links = { chamadas: 0, async requestLink() { this.chamadas++; return 'https://meli.la/x'; } };
  const err = await lerProduto('amazon', 'https://amzn.to/3xYz', { ml }).catch((e) => e);
  assert.ok(err instanceof LojaNaoConectada && err instanceof Error);
  assert.match(err.message, /Amazon/);
  assert.equal(err.message, 'Amazon identificada, mas ainda não está conectada. Configure em Conexões.');
  assert.deepEqual(err.loja, { id: 'amazon', nome: 'Amazon', implementada: false });
  const outras = { shopee: ['Shopee', 'https://s.shopee.com.br/x'], magalu: ['Magalu', 'https://www.magazinevoce.com.br/x'], facebook: ['Facebook', 'https://fb.com/x'] };
  for (const [id, [nome, url]] of Object.entries(outras)) {
    await assert.rejects(lerProduto(id, url, { ml }), (e) => e instanceof LojaNaoConectada && e.message.startsWith(nome) && e.loja.id === id);
  }
  await assert.rejects(linkAfiliado('amazon', { url: 'https://amzn.to/3xYz', tag: 'seunome-20' }, { links }),
    (e) => e instanceof LojaNaoConectada && /Amazon/.test(e.message));
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
  await assert.rejects(previaDoLink('https://www.amazon.com.br/dp/B0ABC12345', { ml: outro }), (e) => e instanceof LojaNaoConectada && /Amazon/.test(e.message));
  for (const u of ['https://example.com/noticia', 'javascript:alert(1)', 'https://mercadolivre.com.br.evil.com/x', '']) {
    await assert.rejects(previaDoLink(u, { ml: outro }), /só funciona com links do Mercado Livre/, u);
  }
  assert.equal(outro.chamadas.length, 0);
});
