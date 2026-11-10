// Verificador, entrega 2, etapa 3 (docs/produto/planos/verificador-ml-extensao.md, D2, D4, D6 e D7): o pedido
// `produto_ml` na fila da extensão (src/links.js). `requestProduto` nunca rejeita e devolve `{ price, disponivel }` ou
// `{ falha }`; links e lista passam na frente do produto que espera; só a extensão que anuncia o recurso no poll
// (x-recursos) recebe o pedido; pausa de 30 min depois da verificação e teto de 120 por hora. Sem rede: a "extensão"
// é o próprio teste chamando poll/submit, ou as rotas HTTP com um token de teste.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createLinkService, PRAZO_PRODUTO_MS, LIMITE_PRODUTO_HORA, PAUSA_VERIFICACAO_MIN, PAUSAS_VERIFICACAO_MIN } from '../src/links.js';
import { openDb, setSetting, getSetting } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };
test.after(() => assert.equal(acessosRede, 0, 'nenhum teste acessa a rede'));

const URL_ANUNCIO = 'https://produto.mercadolivre.com.br/MLB-5257531512-fritadeira-boa-_JM';
const ITEM_110 = 'MLB5257443218';
const URL_CATALOGO_110 = `https://www.mercadolivre.com.br/fritadeira-boa/p/MLB15142194?pdp_filters=item_id:${ITEM_110}`;
const EM_ESTOQUE = 'https://schema.org/InStock';
const ESGOTADO = 'https://schema.org/OutOfStock';
const LIDO = { estado: 'lido', ofertas: [{ nome: true, price: 89.9, availability: EM_ESTOQUE }] };
const RECURSO = { recursos: 'produto_ml' };
const MIN = 60 * 1000;

/** Relógio manual (agora) da pausa e da janela do teto. */
function relogio(inicio = 1_700_000_000_000) {
  const r = { t: inicio, agora: () => r.t };
  return r;
}

/** Serviço no modo extension com a extensão nova já "on-line" (um poll com o recurso, sem pedido na fila). */
async function comExtensaoNova(opcoes = {}) {
  const links = createLinkService({ getMode: () => 'extension', ...opcoes });
  assert.equal(await links.poll(0, RECURSO), null);
  return links;
}

/** A extensão pega o próximo pedido (anunciando o recurso) e responde; devolve o pedido visto. */
async function atender(links, resposta) {
  const job = await links.poll(2000, RECURSO);
  assert.ok(job, 'a extensão recebeu um pedido');
  assert.equal(links.submit(job.id, resposta), true);
  return job;
}

/** Promessa ainda pendente? (uma volta do event loop) */
const pendente = async (p) => {
  const marca = Symbol('pendente');
  return (await Promise.race([p, new Promise((ok) => setImmediate(() => ok(marca)))])) === marca;
};

test('produto: constantes do plano (D3, D7)', () => {
  assert.deepEqual([PRAZO_PRODUTO_MS, LIMITE_PRODUTO_HORA, PAUSA_VERIFICACAO_MIN], [18000, 120, 30]);
  assert.deepEqual([...PAUSAS_VERIFICACAO_MIN], [30, 120, 360], 'S2: 30 min, 2 h, 6 h');
  assert.ok(Object.isFrozen(PAUSAS_VERIFICACAO_MIN));
});

test('produto: o pedido vai à extensão como { id, type: produto_ml, url } e volta { price, disponivel }', async () => {
  const links = await comExtensaoNova();
  const r = links.requestProduto({ url: URL_ANUNCIO });
  const job = await atender(links, { ok: true, data: LIDO });
  assert.deepEqual(job, { id: job.id, type: 'produto_ml', url: URL_ANUNCIO }, 'só o endereço vai no pedido');
  assert.deepEqual(await r, { price: 89.9, disponivel: true });
  assert.equal(links.status().pending, 0);
  // esgotado sem preço também passa como está; e a forma curta requestProduto(url)
  const r2 = links.requestProduto(URL_ANUNCIO);
  await atender(links, { ok: true, data: { estado: 'lido', ofertas: [{ nome: true, price: null, availability: ESGOTADO }] } });
  assert.deepEqual(await r2, { price: null, disponivel: false });
});

test('produto: a URL do pedido escolhe a variante do ProductGroup (lerProdutoDaExtensao recebe o url)', async () => {
  const links = await comExtensaoNova();
  const grupo = {
    estado: 'lido',
    ofertas: [{ nome: true, variantes: [
      { sku: 'MLB5257531512', nome: true, price: 220, availability: EM_ESTOQUE },
      { sku: ITEM_110, nome: true, price: 110, availability: ESGOTADO },
    ] }],
  };
  const r = links.requestProduto({ url: URL_CATALOGO_110 });
  const job = await atender(links, { ok: true, data: grupo });
  assert.equal(job.url, URL_CATALOGO_110);
  assert.deepEqual(await r, { price: 110, disponivel: false }, 'a variante do anúncio do link, nunca a primeira');
});

test('produto: endereço fora de *.mercadolivre.com.br (ou não canônico) → erro, sem pedido; o # sai do pedido', async () => {
  const links = await comExtensaoNova();
  const ruins = [
    undefined, null, '', 42, { href: URL_ANUNCIO },
    'http://produto.mercadolivre.com.br/MLB-5257531512',
    'https://produto.mercadolibre.com/MLB-5257531512',
    'https://meli.la/2AbCdEf',
    'https://mercadolivre.com.br.evil.example/MLB-5257531512',
    'https://evilmercadolivre.com.br/MLB-5257531512',
    'https://produto.mercadolivre.com.br:8443/MLB-5257531512',
    'https://user:x@produto.mercadolivre.com.br/MLB-5257531512',
    `https://produto.mercadolivre.com.br/${'a'.repeat(2048)}`,
    'javascript:alert(1)',
    'nao é url',
  ];
  for (const url of ruins) {
    assert.deepEqual(await links.requestProduto({ url }), { falha: 'erro' }, String(url).slice(0, 60));
  }
  assert.equal(links.status().pending, 0, 'nenhum pedido entrou na fila');
  const r = links.requestProduto({ url: `${URL_ANUNCIO}#polycard_client=recommendations` });
  const job = await atender(links, { ok: true, data: LIDO });
  assert.equal(job.url, URL_ANUNCIO);
  assert.deepEqual(await r, { price: 89.9, disponivel: true });
});

test('produto: extensão off-line → desconectada, sem fila', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'desconectada' });
  assert.equal(links.status().pending, 0);
  assert.equal(await links.poll(0, RECURSO), null, 'nada ficou esperando a extensão');
});

test('produto: poll sem o recurso (extensão 1.4.2), nome desconhecido ou cabeçalho de 500 caracteres → antiga, sem fila', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  const anuncios = [undefined, '', 'xyz', 'produto_mlx', 'link, ofertas', ['produto_ml'], `produto_ml,${'x'.repeat(489)}`];
  assert.equal(anuncios.at(-1).length, 500);
  for (const recursos of anuncios) {
    assert.equal(await links.poll(0, { recursos }), null);
    assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'antiga' }, String(recursos).slice(0, 30));
    assert.equal(links.status().pending, 0);
  }
  assert.equal(await links.poll(0), null, 'poll sem opções = sem recursos');
  assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'antiga' });
  // nome desconhecido ao lado do conhecido não atrapalha; 200 caracteres ainda valem
  for (const recursos of ['xyz, produto_ml', ` produto_ml${' '.repeat(189)}`]) {
    assert.ok(recursos.length <= 200);
    assert.equal(await links.poll(0, { recursos }), null);
    const r = links.requestProduto({ url: URL_ANUNCIO });
    await atender(links, { ok: true, data: LIDO });
    assert.deepEqual(await r, { price: 89.9, disponivel: true }, recursos.trim());
  }
});

test('produto: a extensão que não anunciou o recurso nunca recebe o produto_ml, mesmo esperando antes', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  const antiga = links.poll(300);              // 1.4.2 esperando primeiro
  const nova = links.poll(2000, RECURSO);      // 1.5.0 esperando depois
  const r = links.requestProduto({ url: URL_ANUNCIO });
  const job = await nova;
  assert.equal(job.type, 'produto_ml');
  assert.equal(await pendente(antiga), true);
  links.submit(job.id, { ok: true, data: LIDO });
  assert.deepEqual(await r, { price: 89.9, disponivel: true });
  assert.equal(await antiga, null, 'a antiga só recebe o fim do long-poll');
});

test('produto: link e lista pedidos depois saem antes do produto que espera; produtos entre si em ordem', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  assert.equal(await links.poll(0, RECURSO), null);
  const p1 = links.requestProduto({ url: URL_ANUNCIO });
  const p2 = links.requestProduto({ url: URL_CATALOGO_110 });
  const link = links.requestLink({ url: URL_ANUNCIO, tag: 'etq', timeoutMs: 5000 });
  const shopee = links.requestLinkShopee({ url: 'https://shopee.com.br/x-i.1.2', timeoutMs: 5000 });
  const lista = links.requestOffers({ paginas: [], timeoutMs: 5000 });
  assert.equal(links.status().pending, 5);
  const vistos = [];
  for (let i = 0; i < 5; i++) {
    const job = await links.poll(2000, RECURSO);
    vistos.push(job.type === 'produto_ml' ? `produto ${job.url}` : job.type);
    links.submit(job.id, { ok: false, error: 'teste' });
  }
  assert.deepEqual(vistos, ['link', 'link_shopee', 'ofertas', `produto ${URL_ANUNCIO}`, `produto ${URL_CATALOGO_110}`]);
  await Promise.allSettled([link, shopee, lista]);
  assert.deepEqual([await p1, await p2], [{ falha: 'erro' }, { falha: 'erro' }]);
});

test('produto: link pedido com o produto já na extensão espera só ele (a fila não tem outro produto na frente)', async () => {
  const links = await comExtensaoNova();
  const p = links.requestProduto({ url: URL_ANUNCIO });
  const naExtensao = await links.poll(2000, RECURSO);
  assert.equal(naExtensao.type, 'produto_ml');
  const link = links.requestLink({ url: URL_ANUNCIO, tag: 'etq', timeoutMs: 5000 });
  const proximo = await links.poll(2000, RECURSO);
  assert.equal(proximo.type, 'link');
  links.submit(proximo.id, { ok: true, link: 'https://meli.la/AbcDef1' });
  assert.equal(await link, 'https://meli.la/AbcDef1');
  links.submit(naExtensao.id, { ok: true, data: LIDO });
  assert.deepEqual(await p, { price: 89.9, disponivel: true });
});

test('produto: sem resposta em 18 s → tempo, e o pedido sai da fila (a resposta atrasada é ignorada)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const links = createLinkService({ getMode: () => 'extension' });
  const fimDoPoll = links.poll(0, RECURSO); t.mock.timers.tick(0);
  assert.equal(await fimDoPoll, null);
  const r = links.requestProduto({ url: URL_ANUNCIO });
  assert.equal(links.status().pending, 1);
  t.mock.timers.tick(PRAZO_PRODUTO_MS - 1);
  assert.equal(await pendente(r), true, 'ainda espera em 17,999 s');
  t.mock.timers.tick(1);
  assert.deepEqual(await r, { falha: 'tempo' });
  assert.equal(links.status().pending, 0, 'o pedido saiu da fila');
  // entregue e sem resposta: também tempo; a resposta depois do prazo não vale
  const r2 = links.requestProduto({ url: URL_ANUNCIO, timeoutMs: 5000 });
  const job = await links.poll(0, RECURSO);
  assert.equal(job.type, 'produto_ml');
  t.mock.timers.tick(5000);
  assert.deepEqual(await r2, { falha: 'tempo' });
  assert.equal(links.submit(job.id, { ok: true, data: LIDO }), false);
});

test('produto: ok:false, data inválido ou fora do contrato → erro; lastError e lastOkAt intactos', async () => {
  const links = await comExtensaoNova();
  // um link do ML deixa o estado do selo de Conexões conhecido
  const lk = links.requestLink({ url: URL_ANUNCIO, tag: 'etq', timeoutMs: 5000 });
  const jl = await links.poll(2000, RECURSO);
  links.submit(jl.id, { ok: true, link: 'https://meli.la/AbcDef1' });
  await lk;
  const lkErro = links.requestLink({ url: URL_ANUNCIO, tag: 'etq', timeoutMs: 5000 }).catch((e) => e);
  const je = await links.poll(2000, RECURSO);
  links.submit(je.id, { ok: false, error: 'a Central caiu' });
  await lkErro;
  const antes = links.status();
  assert.equal(antes.lastError, 'a Central caiu'); assert.ok(antes.lastOkAt > 0);
  const respostas = [
    { ok: false, error: 'a página do produto respondeu HTTP 500' },
    { ok: false },
    { ok: true },
    { ok: true, data: null },
    { ok: true, data: [] },
    { ok: true, data: '<html>' },
    { ok: true, data: { estado: 'outro' } },
    { ok: true, data: { estado: 'lido', ofertas: Array.from({ length: 6 }, () => LIDO.ofertas[0]) } },
    { ok: true, data: { estado: 'lido', ofertas: [{ nome: true, price: { v: 1 }, availability: EM_ESTOQUE }] } },
    { ok: true, data: { estado: 'lido', ofertas: [{ nome: true, price: 10, availability: 'x'.repeat(5000) }] } },
    { ok: false, data: LIDO }, // ok:false manda, mesmo com dados
  ];
  for (const resposta of respostas) {
    const r = links.requestProduto({ url: URL_ANUNCIO });
    await atender(links, resposta);
    assert.deepEqual(await r, { falha: 'erro' }, JSON.stringify(resposta).slice(0, 80));
  }
  const r = links.requestProduto({ url: URL_ANUNCIO });
  await atender(links, { ok: true, data: LIDO });
  await r;
  const depois = links.status();
  assert.equal(depois.lastError, 'a Central caiu', 'o produto não mexe no erro do link');
  assert.equal(depois.lastOkAt, antes.lastOkAt, 'nem no último link certo');
  assert.deepEqual([depois.shopeeLastError, depois.shopeeLastOkAt], ['', 0]);
});

test('produto: verificação → 30 min sem pedido à extensão; os produtos na fila saem como verificacao; depois volta', async () => {
  const r0 = relogio();
  const links = await comExtensaoNova({ agora: r0.agora });
  const p1 = links.requestProduto({ url: URL_ANUNCIO });
  const p2 = links.requestProduto({ url: URL_CATALOGO_110 }); // ainda na fila quando chega o bloqueio
  const link = links.requestLink({ url: URL_ANUNCIO, tag: 'etq', timeoutMs: 5000 });
  const jLink = await links.poll(2000, RECURSO);
  assert.equal(jLink.type, 'link');
  const j1 = await links.poll(2000, RECURSO);
  assert.equal(j1.url, URL_ANUNCIO);
  links.submit(j1.id, { ok: true, data: { estado: 'verificacao' } });
  assert.deepEqual(await p1, { falha: 'verificacao' });
  assert.deepEqual(await p2, { falha: 'verificacao' }, 'o que esperava na fila não vai mais à extensão');
  const st = links.status();
  assert.deepEqual([st.pending, st.lastError, st.lastOkAt], [0, '', 0], 'a verificação não mexe no selo de Conexões');
  links.submit(jLink.id, { ok: true, link: 'https://meli.la/AbcDef1' });
  assert.equal(await link, 'https://meli.la/AbcDef1', 'os links seguem');
  r0.t += PAUSA_VERIFICACAO_MIN * MIN - 1;
  assert.equal(await links.poll(0, RECURSO), null);
  assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'verificacao' }, '29,99 min: ainda em pausa');
  assert.equal(links.status().pending, 0);
  r0.t += 1;
  const p3 = links.requestProduto({ url: URL_ANUNCIO });
  await atender(links, { ok: true, data: LIDO });
  assert.deepEqual(await p3, { price: 89.9, disponivel: true }, '30 min depois, volta');
});

test('produto: o 121º pedido da hora → limite, sem pedido; off-line, antiga e pausa não contam; a janela anda', async () => {
  const r0 = relogio();
  const links = createLinkService({ getMode: () => 'extension', agora: r0.agora });
  for (let i = 0; i < 3; i++) assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'desconectada' });
  assert.equal(await links.poll(0), null);
  for (let i = 0; i < 3; i++) assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'antiga' });
  assert.equal(await links.poll(0, RECURSO), null);
  // 1º pedido: verificação (conta), e 10 durante a pausa (não contam)
  const p1 = links.requestProduto({ url: URL_ANUNCIO });
  await atender(links, { ok: true, data: { estado: 'verificacao' } });
  assert.deepEqual(await p1, { falha: 'verificacao' });
  for (let i = 0; i < 10; i++) assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'verificacao' });
  r0.t += PAUSA_VERIFICACAO_MIN * MIN;
  // mais 119 cabem na hora (todos na fila de uma vez); o seguinte não
  const pedidos = Array.from({ length: LIMITE_PRODUTO_HORA - 1 }, () => links.requestProduto({ url: URL_ANUNCIO }));
  assert.equal(links.status().pending, LIMITE_PRODUTO_HORA - 1);
  assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'limite' });
  assert.equal(links.status().pending, LIMITE_PRODUTO_HORA - 1, 'o 121º não entrou na fila');
  for (let i = 0; i < pedidos.length; i++) await atender(links, { ok: true, data: LIDO });
  for (const p of pedidos) assert.deepEqual(await p, { price: 89.9, disponivel: true });
  // a janela é de 1 h desde o 1º pedido (que foi 30 min antes dos outros)
  r0.t += 30 * MIN - 1;
  assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'limite' });
  r0.t += 1;
  const p = links.requestProduto({ url: URL_ANUNCIO });
  await atender(links, { ok: true, data: LIDO });
  assert.deepEqual(await p, { price: 89.9, disponivel: true }, 'saiu o 1º da janela: cabe um');
  assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'limite' });
});

test('produto: o link do ML e a lista seguem iguais com o recurso anunciado (sem mudar o que a extensão recebe)', async () => {
  const links = await comExtensaoNova();
  const lk = links.requestLink({ url: URL_ANUNCIO, tag: 'etq', timeoutMs: 5000 });
  const job = await links.poll(2000, RECURSO);
  assert.deepEqual(job, { id: job.id, type: 'link', url: URL_ANUNCIO, tag: 'etq' });
  links.submit(job.id, { ok: true, link: 'https://meli.la/AbcDef1' });
  assert.equal(await lk, 'https://meli.la/AbcDef1');
});

/** Pede um produto, a extensão responde `data` e devolve o resultado. */
async function produtoCom(links, data) {
  const p = links.requestProduto({ url: URL_ANUNCIO });
  await atender(links, { ok: true, data });
  return p;
}
const VERIFICACAO = { estado: 'verificacao' };

test('produto (S2): verificações seguidas alongam a pausa (30 min → 2 h → 6 h, e 6 h de novo); uma leitura volta aos 30 min', async () => {
  const r0 = relogio();
  const links = await comExtensaoNova({ agora: r0.agora });
  const emPausaPor = async (min) => {
    r0.t += min * MIN - 1;
    assert.equal(await links.poll(0, RECURSO), null); // a extensão segue on-line
    assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'verificacao' }, `${min} min menos 1 ms`);
    r0.t += 1;
  };
  for (const min of [30, 120, 360, 360]) {
    assert.deepEqual(await produtoCom(links, VERIFICACAO), { falha: 'verificacao' });
    await emPausaPor(min);
  }
  // a leitura bem-sucedida zera o degrau: a próxima verificação é de 30 min
  assert.deepEqual(await produtoCom(links, LIDO), { price: 89.9, disponivel: true });
  assert.deepEqual(await produtoCom(links, VERIFICACAO), { falha: 'verificacao' });
  await emPausaPor(30);
  // ok:false e resposta fora do contrato não são leitura: o degrau segue (2 h)
  assert.deepEqual(await produtoCom(links, { lixo: 1 }), { falha: 'erro' });
  assert.deepEqual(await produtoCom(links, VERIFICACAO), { falha: 'verificacao' });
  await emPausaPor(120);
});

test('produto (S2): a verificação de um pedido que já estava na extensão, com a pausa ligada, não sobe o degrau nem estica a pausa', async () => {
  const r0 = relogio();
  const links = await comExtensaoNova({ agora: r0.agora });
  const a = links.requestProduto({ url: URL_ANUNCIO });
  const b = links.requestProduto({ url: URL_CATALOGO_110 });
  const ja = await links.poll(0, RECURSO); const jb = await links.poll(0, RECURSO); // as duas já na extensão (duas abas)
  links.submit(ja.id, { ok: true, data: VERIFICACAO });
  r0.t += 10 * MIN;
  links.submit(jb.id, { ok: true, data: VERIFICACAO });
  assert.deepEqual([await a, await b], [{ falha: 'verificacao' }, { falha: 'verificacao' }]);
  r0.t += 20 * MIN; // 30 min da primeira
  assert.equal(await links.poll(0, RECURSO), null);
  const c = links.requestProduto({ url: URL_ANUNCIO });
  await atender(links, { ok: true, data: VERIFICACAO });
  assert.deepEqual(await c, { falha: 'verificacao' });
  r0.t += 120 * MIN - 1; // o segundo degrau (2 h), não o terceiro
  assert.equal(await links.poll(0, RECURSO), null);
  assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'verificacao' });
  r0.t += 1;
  assert.deepEqual(await produtoCom(links, LIDO), { price: 89.9, disponivel: true });
});

test('produto (S2): com db, a pausa, o degrau e a janela do teto sobrevivem a um serviço novo sobre o mesmo banco', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-produto-db-')); pastas.push(dir);
  const db = openDb(dir);
  const r0 = relogio();
  const a = await comExtensaoNova({ agora: r0.agora, db });
  assert.deepEqual(await produtoCom(a, VERIFICACAO), { falha: 'verificacao' });
  // o serviço reinicia 10 min depois: ainda em pausa, sem pedido à extensão
  r0.t += 10 * MIN;
  const b = await comExtensaoNova({ agora: r0.agora, db });
  assert.deepEqual(await b.requestProduto({ url: URL_ANUNCIO }), { falha: 'verificacao' });
  assert.equal(b.status().pending, 0);
  r0.t += 20 * MIN; // fim dos 30 min: a próxima verificação é do segundo degrau (2 h), também depois de outro reinício
  assert.deepEqual(await produtoCom(b, VERIFICACAO), { falha: 'verificacao' });
  const c = await comExtensaoNova({ agora: r0.agora, db });
  r0.t += 120 * MIN - 1;
  assert.equal(await c.poll(0, RECURSO), null);
  assert.deepEqual(await c.requestProduto({ url: URL_ANUNCIO }), { falha: 'verificacao' });
  r0.t += 1;
  // teto: 119 pedidos lidos aqui (com o da verificação de 2 h atrás fora da janela) e 1 noutro serviço = 120
  for (let i = 0; i < LIMITE_PRODUTO_HORA - 1; i++) assert.deepEqual(await produtoCom(c, LIDO), { price: 89.9, disponivel: true });
  const d = await comExtensaoNova({ agora: r0.agora, db });
  assert.deepEqual(await produtoCom(d, LIDO), { price: 89.9, disponivel: true });
  const e = await comExtensaoNova({ agora: r0.agora, db });
  assert.deepEqual(await e.requestProduto({ url: URL_ANUNCIO }), { falha: 'limite' }, 'o 121º da hora, depois de dois reinícios');
  r0.t += 60 * MIN;
  const f = await comExtensaoNova({ agora: r0.agora, db });
  assert.deepEqual(await produtoCom(f, LIDO), { price: 89.9, disponivel: true }, 'a hora virou');
  // a leitura também zerou o degrau gravado
  assert.deepEqual(JSON.parse(getSetting(db, 'ml_produto_pausa')).nivel, 0);
  db.close();
});

test('produto (S2): o que está gravado é dado de fora: lixo vira "sem pausa e janela vazia", e a pausa nunca passa de 6 h', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-produto-lixo-')); pastas.push(dir);
  const db = openDb(dir);
  const r0 = relogio();
  for (const [pausa, pedidos] of [['{', '['], ['null', '{}'], ['{"ate":"9e15","nivel":-1}', '"x"'], ['{"ate":-5,"nivel":9}', '[null,"1",1e300]'], ['[]', JSON.stringify([r0.t + MIN, r0.t - 61 * MIN])]]) {
    setSetting(db, 'ml_produto_pausa', pausa); setSetting(db, 'ml_produto_pedidos', pedidos);
    const l = await comExtensaoNova({ agora: r0.agora, db });
    assert.deepEqual(await produtoCom(l, VERIFICACAO), { falha: 'verificacao' }, `${pausa} ${pedidos}`);
    r0.t += 30 * MIN; // o degrau gravado inválido vira o primeiro: 30 min
    assert.equal(await l.poll(0, RECURSO), null);
    assert.deepEqual(await produtoCom(l, LIDO), { price: 89.9, disponivel: true }, `${pausa}: 30 min`);
  }
  // 120 pedidos "no futuro" (relógio que voltou): não contam na janela, nem prendem o teto
  setSetting(db, 'ml_produto_pausa', '{}'); setSetting(db, 'ml_produto_pedidos', JSON.stringify(Array(LIMITE_PRODUTO_HORA).fill(r0.t + 10 * MIN)));
  assert.deepEqual(await produtoCom(await comExtensaoNova({ agora: r0.agora, db }), LIDO), { price: 89.9, disponivel: true }, 'pedidos no futuro');
  // pausa gravada para daqui a 1 ano (relógio trocado, banco mexido): no máximo 6 h a partir de agora
  setSetting(db, 'ml_produto_pausa', JSON.stringify({ ate: r0.t + 365 * 24 * 60 * MIN, nivel: 2 }));
  const l = await comExtensaoNova({ agora: r0.agora, db });
  r0.t += 360 * MIN - 1;
  assert.equal(await l.poll(0, RECURSO), null);
  assert.deepEqual(await l.requestProduto({ url: URL_ANUNCIO }), { falha: 'verificacao' });
  const m = await comExtensaoNova({ agora: r0.agora, db });
  r0.t += 1;
  assert.equal(await m.poll(0, RECURSO), null);
  assert.deepEqual(await produtoCom(m, LIDO), { price: 89.9, disponivel: true });
  // um banco que falha ao gravar não derruba o pedido (só o console, sem valor)
  const erros = [];
  const original = console.error; console.error = (...x) => erros.push(x.join(' '));
  try {
    const quebrado = { prepare: () => { throw new Error(`SQLITE_FULL ${URL_ANUNCIO}`); } };
    const q = await comExtensaoNova({ agora: r0.agora, db: quebrado });
    assert.deepEqual(await produtoCom(q, LIDO), { price: 89.9, disponivel: true });
  } finally { console.error = original; }
  assert.ok(erros.length >= 1 && erros.every((x) => !x.includes('mercadolivre') && !x.includes('SQLITE')), erros.join('\n'));
  db.close();
});

test('produto (Q1): a extensão nova esperando e a antiga com o último poll: o produto vai à nova (não é "antiga")', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  const nova = links.poll(2000, RECURSO);
  const antiga = links.poll(2000, {});
  const p = links.requestProduto({ url: URL_ANUNCIO });
  const job = await nova;
  assert.equal(job.type, 'produto_ml');
  links.submit(job.id, { ok: true, data: LIDO });
  assert.deepEqual(await p, { price: 89.9, disponivel: true });
  assert.equal(await pendente(antiga), true, 'a antiga segue esperando (não recebeu o produto)');
  const lk = links.requestLink({ url: URL_ANUNCIO, tag: 'etq', timeoutMs: 1000 });
  const jl = await antiga; links.submit(jl.id, { ok: true, link: 'https://meli.la/AbcDef1' }); await lk;
  // sem nenhuma em espera com o recurso e o último poll da antiga: "antiga", sem fila
  assert.deepEqual(await links.requestProduto({ url: URL_ANUNCIO }), { falha: 'antiga' });
  assert.equal(links.status().pending, 0);
});

// ---------------------------------------------------------------- rota HTTP /api/ext/poll

const TOKEN_TESTE = 'token-de-teste-da-etapa-3';
const pastas = [];
test.after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });

function subir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-produto-')); pastas.push(dir);
  const db = openDb(dir);
  setSetting(db, 'ext_token', TOKEN_TESTE); // token próprio do teste (o do banco novo é aleatório)
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'extension' });
  const { scheduler } = criarServicos({ db, wa, links, fast: true, dir, fetch: async () => { throw new Error('rede proibida no teste'); } });
  const app = buildApp({ db, wa, links, scheduler, publicHost: '', panelPassword: '' });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }));
      ok({ port: server.address().port, links });
    });
  });
}

function pedir(port, metodo, caminho, corpo, headers = {}) {
  return new Promise((ok, err) => {
    const data = corpo != null ? JSON.stringify(corpo) : null;
    const h = { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method: metodo, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* vazio */ } ok({ status: res.statusCode, json }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
/** Espera o poll HTTP chegar ao serviço (a extensão fica on-line), em vez de um tempo fixo (R3). */
async function ligada(links) {
  const t0 = Date.now();
  while (!links.status().online) {
    assert.ok(Date.now() - t0 < 3000, 'o poll não chegou ao serviço');
    await esperar(2);
  }
}

test('HTTP: o poll com x-recursos e o token certo recebe o produto_ml; o resultado volta por /api/ext/result', async (t) => {
  const s = await subir(t);
  // token errado com o cabeçalho: 401, e nada muda (continua desconectada)
  const negado = await pedir(s.port, 'GET', '/api/ext/poll', null, { 'x-token': 'errado', 'x-recursos': 'produto_ml' });
  assert.equal(negado.status, 401);
  assert.deepEqual(await s.links.requestProduto({ url: URL_ANUNCIO }), { falha: 'desconectada' });
  const poll = pedir(s.port, 'GET', '/api/ext/poll', null, { 'x-token': TOKEN_TESTE, 'x-recursos': 'produto_ml' });
  await ligada(s.links); // o poll registrado marca a extensão como on-line, com o recurso
  const r = s.links.requestProduto({ url: URL_ANUNCIO });
  const { status, json } = await poll;
  assert.equal(status, 200);
  assert.deepEqual(json.job, { id: json.job.id, type: 'produto_ml', url: URL_ANUNCIO });
  const res = await pedir(s.port, 'POST', '/api/ext/result', { id: json.job.id, ok: true, data: LIDO }, { 'x-token': TOKEN_TESTE });
  assert.deepEqual(res.json, { ok: true });
  assert.deepEqual(await r, { price: 89.9, disponivel: true });
});

test('HTTP: poll sem x-recursos (extensão 1.4.2) ou com cabeçalho de 500 caracteres → antiga, sem pedido', async (t) => {
  for (const extra of [{}, { 'x-recursos': `produto_ml,${'x'.repeat(489)}` }]) {
    const s = await subir(t); // um servidor por caso: on-line só depois do poll deste caso
    const poll = pedir(s.port, 'GET', '/api/ext/poll', null, { 'x-token': TOKEN_TESTE, ...extra });
    await ligada(s.links);
    assert.deepEqual(await s.links.requestProduto({ url: URL_ANUNCIO }), { falha: 'antiga' });
    // encerra o long-poll com um pedido de link (o que a 1.4.2 sabe atender)
    const lk = s.links.requestLink({ url: URL_ANUNCIO, tag: 'etq', timeoutMs: 5000 });
    const { json } = await poll;
    assert.equal(json.job.type, 'link');
    await pedir(s.port, 'POST', '/api/ext/result', { id: json.job.id, ok: true, link: 'https://meli.la/AbcDef1' }, { 'x-token': TOKEN_TESTE });
    assert.equal(await lk, 'https://meli.la/AbcDef1');
  }
});
