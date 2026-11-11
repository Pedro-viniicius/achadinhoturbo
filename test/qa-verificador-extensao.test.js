// QA do verificador, entrega 2 (docs/produto/planos/verificador-ml-extensao.md, CA1 a CA8): o ML conferido pela
// extensão do Chrome. Os devs cobriram cada peça (test/ml-extensao, extensao-produto, links-produto, verificador,
// verificador-ml-extensao); este arquivo passa pelas bordas que ficam entre as peças:
//   A. a fila (src/links.js) com relógio injetado: extensão que some com o produto entregue, duas extensões, muitos
//      produtos com um link urgente, teto de 120/h em janela móvel, pausa e retomada, timers sem vazamento, resposta
//      do tipo errado;
//   B. o JSON-LD: o leitor do servidor (conferirProduto) e o caminho da extensão (ofertasDoHtml → lerProdutoDaExtensao)
//      têm de dar a mesma resposta (diferencial com semente fixa); catálogo sem pdp_filters, URL com '#', ProductGroup
//      e Product juntos, variante sem offers, mais de 30 variantes;
//   C. ponta a ponta (criarServicos com verificar: true, links em `extension`, extensão simulada por HTTP) com o
//      servidor sem leitura própria, sem HTML/URL/segredo em log e sem nível `erro` por descarte.
// Nenhum teste chama loja real: o fetch global é bloqueado e contado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService, PRAZO_PRODUTO_MS, LIMITE_PRODUTO_HORA, PAUSA_VERIFICACAO_MIN, PAUSAS_VERIFICACAO_MIN } from '../src/links.js';
import { createVerificador, CAUSAS } from '../src/verificador.js';
import { paraCandidato } from '../src/catalogo.js';
import { amostraHub } from '../src/afiliados.js';
import * as mlReal from '../src/ml.js';

// ------------------------------------------------------------------------------------------- sem rede nenhuma
const fetchOriginal = globalThis.fetch;
let acessosRede = 0;
const redeProibida = async () => { acessosRede++; throw new Error('rede proibida no teste'); };
globalThis.fetch = redeProibida;
after(() => { globalThis.fetch = fetchOriginal; });

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-vext-')); pastas.push(p); return p; };

// ---------------------------------------------------- as funções puras da extensão (extraídas pelos marcadores)
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTE = fs.readFileSync(path.join(RAIZ, 'extension', 'background.js'), 'utf8');
const INI = FONTE.indexOf('// ---- Mercado Livre produto: funções puras (início) ----');
const FIM = FONTE.indexOf('// ---- Mercado Livre produto: funções puras (fim) ----');
assert.ok(INI > 0 && FIM > INI, 'não achei os marcadores do trecho do produto do ML em extension/background.js');
const X = (() => {
  const ctx = vm.createContext({ URL, TextDecoder });
  vm.runInContext(`${FONTE.slice(INI, FIM)};globalThis.__x = { urlProdutoML, estadoDaResposta, corpoDaPaginaML, ofertasDoHtml };`, ctx);
  return ctx.__x;
})();
const plano = (v) => JSON.parse(JSON.stringify(v)); // objetos do vm têm outro protótipo
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ----------------------------------------------------------------------------------------------- fixtures
const ML = 'https://www.mercadolivre.com.br';
const EM_ESTOQUE = 'https://schema.org/InStock';
const ESGOTADO = 'https://schema.org/OutOfStock';
const SEGREDO = 'SEGREDO-DA-PAGINA-LOGADA';
const ITEM_A = 'MLB5257531512';
const ITEM_B = 'MLB5257443218';
const ITEM_C = 'MLB5257000001';
const URL_ITEM_A = `https://produto.mercadolivre.com.br/MLB-${ITEM_A.slice(3)}-fritadeira-_JM`;
const URL_CAT = `${ML}/fritadeira-boa/p/MLB15142194`;
const URL_CAT_A = `${URL_CAT}?pdp_filters=item_id:${ITEM_A}`;
const URL_CAT_B = `${URL_CAT}?pdp_filters=item_id:${ITEM_B}`;
const RECURSO = { recursos: 'produto_ml' };
const MIN = 60 * 1000;

const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const variante = (sku, price, availability = EM_ESTOQUE, extra = {}) => ({
  '@type': 'Product', ...(sku !== undefined ? { sku } : {}), name: `Fritadeira ${sku ?? 'sem sku'}`,
  offers: { '@type': 'Offer', price, priceCurrency: 'BRL', availability }, ...extra,
});
const grupo = (variantes, extra = {}) => ({ '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Fritadeira Boa', hasVariant: variantes, ...extra });
const produto = (price, availability = EM_ESTOQUE, extra = {}) => ({ '@context': 'https://schema.org', '@type': 'Product', name: 'Fone Bom', offers: { '@type': 'Offer', price, availability }, ...extra });
const pagina = (...blocos) => `<html><head><title>${SEGREDO}</title>
<script id="__NORDIC_RENDERING_CTX__">{"offers":{"type":"Offer","price":999.99,"availability":"${EM_ESTOQUE}"}}</script>
${blocos.map((b) => (typeof b === 'string' ? b : ld(b))).join('\n')}</head><body><a href="/minha-conta">${SEGREDO}</a></body></html>`;

/** O que a extensão devolve para a página (as funções puras de verdade) → { price, disponivel } | { bloqueado } | null, como o servidor lê. */
const viaExtensao = (html, url) => mlReal.lerProdutoDaExtensao({ estado: 'lido', ofertas: plano(X.ofertasDoHtml(html)) }, { url });
/** O leitor do servidor (o que o modo direct faz) sobre o mesmo HTML. */
const viaServidor = (html, url) => mlReal.conferirProduto(url, { fetchJson: async () => { throw new Error('HTTP 403'); }, fetchText: async () => html });

// ======================================================================================================= A. fila

const relogio = (inicio = 1_700_000_000_000) => { const r = { t: inicio, agora: () => r.t }; return r; };
const LIDO = { estado: 'lido', ofertas: [{ nome: true, price: 89.9, availability: EM_ESTOQUE }] };

/** Serviço no modo extension com uma extensão nova on-line (um poll que anunciou o recurso e voltou). */
async function comExtensaoNova(opcoes = {}) {
  const links = createLinkService({ getMode: () => 'extension', ...opcoes });
  assert.equal(await links.poll(0, RECURSO), null);
  return links;
}
const pendente = async (p) => {
  const marca = Symbol('pendente');
  return (await Promise.race([p, new Promise((ok) => setImmediate(() => ok(marca)))])) === marca;
};
const urlProduto = (n) => `https://produto.mercadolivre.com.br/MLB-${3_000_000_000 + n}`;

test('A1 CA5: 30 produtos na fila e um link urgente: o link, a lista e o link da Shopee saem antes de qualquer produto que espera', async () => {
  const links = await comExtensaoNova();
  const produtos = Array.from({ length: 30 }, (_, i) => links.requestProduto({ url: urlProduto(i) }));
  const emAndamento = await links.poll(0, RECURSO);
  assert.equal(emAndamento.type, 'produto_ml'); assert.equal(emAndamento.url, urlProduto(0));
  assert.equal(links.status().pending, 29, 'os outros 29 produtos esperam');

  const link1 = links.requestLink({ url: URL_ITEM_A, tag: 'a' });
  const ofertas = links.requestOffers({ paginas: [{}] });
  const shopee = links.requestLinkShopee({ url: 'https://shopee.com.br/produto-i.123.456' });
  const link2 = links.requestLink({ url: URL_ITEM_A, tag: 'b' });
  assert.equal(links.status().pending, 33);

  // a extensão termina o produto 0 e pede o próximo: tudo o que não é produto vem primeiro, na ordem de chegada
  assert.equal(links.submit(emAndamento.id, { ok: true, data: LIDO }), true);
  assert.deepEqual(await produtos[0], { price: 89.9, disponivel: true });
  const tipos = [];
  for (let i = 0; i < 4; i++) {
    const j = await links.poll(0, RECURSO); tipos.push(j.type);
    if (j.type === 'link') links.submit(j.id, { ok: true, link: `https://meli.la/Qa${j.id}` });
    else if (j.type === 'ofertas') links.submit(j.id, { ok: false, error: 'x' });
    else if (j.type === 'link_shopee') links.submit(j.id, { ok: false, error: 'x' });
  }
  assert.deepEqual(tipos, ['link', 'ofertas', 'link_shopee', 'link']);
  await Promise.allSettled([link1, ofertas, shopee, link2]);
  // depois, os produtos seguem em ordem
  const seguinte = await links.poll(0, RECURSO);
  assert.equal(seguinte.type, 'produto_ml'); assert.equal(seguinte.url, urlProduto(1));
  links.submit(seguinte.id, { ok: true, data: LIDO });
});

test('A2 CA5: o link pedido com o produto parado na extensão espera só esse produto, e o estouro do produto não leva os outros junto', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const links = createLinkService({ getMode: () => 'extension' });
  const p0 = links.poll(0, RECURSO); t.mock.timers.tick(0); await p0;
  const a = links.requestProduto({ url: urlProduto(1) });
  const em = await links.poll(0, RECURSO); assert.equal(em.url, urlProduto(1));
  t.mock.timers.tick(10_000); // o produto 1 já está há 10 s na extensão
  const b = links.requestProduto({ url: urlProduto(2) });
  const link = links.requestLink({ url: URL_ITEM_A, tag: 'x' });
  t.mock.timers.tick(8_000); // 18 s: o produto 1 estoura
  assert.deepEqual(await a, { falha: 'tempo' });
  assert.equal(await pendente(b), true, 'o produto 2 ainda tem 10 s');
  assert.equal(await pendente(link), true, 'o link segue esperando a extensão');
  // a extensão volta: o link vem na frente do produto 2, mesmo tendo sido pedido depois
  const prox = await links.poll(0, RECURSO);
  assert.equal(prox.type, 'link');
  links.submit(prox.id, { ok: true, link: 'https://meli.la/Zzz' });
  assert.deepEqual(await link, 'https://meli.la/Zzz');
  const prox2 = await links.poll(0, RECURSO); assert.equal(prox2.url, urlProduto(2));
  links.submit(prox2.id, { ok: true, data: LIDO });
  assert.deepEqual(await b, { price: 89.9, disponivel: true });
});

test('A3 CA4: a extensão some no meio (poll para com o produto entregue): "tempo" em 18 s, o verificador sai com "demorou", sem erro; depois, off-line', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const erros = []; t.mock.method(console, 'error', (...a) => erros.push(a.join(' ')));
  const links = createLinkService({ getMode: () => 'extension', agora: () => Date.now() });
  const p0 = links.poll(0, RECURSO); t.mock.timers.tick(0); await p0;
  const db = openDb(tmp());
  const verificador = createVerificador({ db, links, ml: { conferirProduto: async () => { throw new Error('o servidor não lê o ML'); } } });
  const oferta = { loja: 'mercadolivre', url: URL_ITEM_A, price: 100, title: 'Fone' };

  const conferindo = verificador.conferir(oferta, { lidoEm: Date.now() });
  await new Promise((ok) => setImmediate(ok)); // o verificador chega a requestProduto depois de alguns microtasks
  const entregue = await links.poll(0, RECURSO);
  assert.equal(entregue.type, 'produto_ml', 'a extensão pegou o produto e morreu: nunca responde');
  t.mock.timers.tick(PRAZO_PRODUTO_MS);
  const r = await conferindo;
  assert.equal(r.acao, 'enviar', 'dados de agora: sai sem conferir');
  assert.equal(r.conferido, false);
  assert.equal(r.sufixo, ` · preço não conferido (${CAUSAS.demorou})`);
  assert.equal(links.status().pending, 0);

  // 46 s sem poll desde a última vez que ela falou: off-line, sem pedido na fila
  t.mock.timers.tick(30_000);
  const off = await verificador.conferir(oferta, { lidoEm: Date.now() });
  assert.equal(off.sufixo, ` · preço não conferido (${CAUSAS.extensao_off})`);
  assert.equal(links.status().pending, 0, 'off-line não põe nada na fila');
  // dados velhos + extensão sumida: não sai, e o motivo é a causa
  const velha = await verificador.conferir(oferta, { lidoEm: Date.now() - 31 * MIN });
  assert.deepEqual([velha.acao, velha.motivo, velha.texto], ['descartar', 'nao_conferido', `Descartada: não deu para conferir o preço (${CAUSAS.extensao_off})`]);
  assert.equal(links.submit(entregue.id, { ok: true, data: LIDO }), false, 'a resposta que chega tarde é ignorada');
  assert.deepEqual(erros, [], 'nada no console (nem URL) por causa da extensão que sumiu');
  db.close();
});

test('A4 CA7: duas extensões (1.4.2 e 1.5.0) no mesmo painel: a antiga nunca recebe o produto_ml, em qualquer ordem de poll', async () => {
  for (const ordem of ['nova-primeiro', 'antiga-primeiro']) {
    const links = createLinkService({ getMode: () => 'extension' });
    const antigaVe = []; const novaVe = [];
    const pollAntiga = () => links.poll(300, {}).then((j) => { if (j) antigaVe.push(j); return j; });
    const pollNova = () => links.poll(300, RECURSO).then((j) => { if (j) novaVe.push(j); return j; });
    const esperas = ordem === 'nova-primeiro' ? [pollNova(), pollAntiga()] : [pollAntiga(), pollNova()];
    // o produto pedido com as duas esperando: só a nova pode ficar com ele
    const r = links.requestProduto({ url: urlProduto(1) });
    const link = links.requestLink({ url: URL_ITEM_A, tag: 'x' });
    await Promise.all(esperas);
    for (const j of [...antigaVe, ...novaVe]) {
      if (j.type === 'link') links.submit(j.id, { ok: true, link: 'https://meli.la/OkOk' });
      if (j.type === 'produto_ml') links.submit(j.id, { ok: true, data: LIDO });
    }
    assert.ok(antigaVe.every((j) => j.type !== 'produto_ml'), `${ordem}: a 1.4.2 não pode receber produto_ml`);
    await link;
    const res = await r; // some pelo prazo ou lê, conforme a ordem; o que importa é que a antiga nunca recebeu
    assert.ok(res.falha === undefined || ['antiga', 'tempo'].includes(res.falha), `${ordem}: ${JSON.stringify(res)}`);
  }
});

// Com a 1.5.0 em espera e uma 1.4.2 que dá poll DEPOIS, o último poll não anuncia o recurso, mas a 1.5.0 que espera sim
// (achado Q1, corrigido: requestProduto olha também os polls em espera).
test('A5 CA4: a 1.5.0 em espera e uma 1.4.2 que dá poll depois: o produto ainda vai à 1.5.0', async () => {
  const links = createLinkService({ getMode: () => 'extension' });
  const nova = links.poll(300, RECURSO);
  const antiga = links.poll(300, {});
  const r = await links.requestProduto({ url: urlProduto(1), timeoutMs: 100 });
  const j = await nova;
  if (j?.type === 'produto_ml') links.submit(j.id, { ok: true, data: LIDO });
  await antiga;
  assert.notEqual(r.falha, 'antiga', 'havia uma extensão com o recurso esperando');
});

test('A6 CA6: teto de 120 por hora em janela móvel: 120 entram, o 121º é "limite" sem ir à fila; as vagas voltam conforme os pedidos envelhecem', async () => {
  const rel = relogio();
  const links = await comExtensaoNova({ agora: rel.agora });
  const atender = async () => { const j = await links.poll(0, RECURSO); assert.equal(j.type, 'produto_ml'); links.submit(j.id, { ok: true, data: LIDO }); };
  const pedir = async (n) => { const p = links.requestProduto({ url: urlProduto(n) }); await atender(); return p; };
  for (let i = 0; i < 100; i++) assert.deepEqual(await pedir(i), { price: 89.9, disponivel: true });
  rel.t += 30 * MIN;
  for (let i = 100; i < 120; i++) assert.deepEqual(await pedir(i), { price: 89.9, disponivel: true });
  rel.t += 29 * MIN + 59_000; // 59:59 desde os 100 primeiros
  assert.deepEqual(await links.requestProduto({ url: urlProduto(999) }), { falha: 'limite' });
  assert.equal(links.status().pending, 0, 'o excedente nem entra na fila');
  rel.t += 1000; // 1 h exata: os 100 primeiros saem da janela
  for (let i = 0; i < 100; i++) assert.deepEqual(await pedir(1000 + i), { price: 89.9, disponivel: true }, `vaga ${i + 1}`);
  assert.deepEqual(await links.requestProduto({ url: urlProduto(2000) }), { falha: 'limite' }, 'os 20 da meia hora ainda contam: 120 de novo');
});

test('A7 CA6: 200 pedidos de uma vez: exatamente 120 vão à extensão e 80 viram "limite"', async () => {
  const rel = relogio();
  const links = await comExtensaoNova({ agora: rel.agora });
  const todos = Array.from({ length: 200 }, (_, i) => links.requestProduto({ url: urlProduto(i), timeoutMs: 60_000 }));
  assert.equal(links.status().pending, LIMITE_PRODUTO_HORA);
  let entregues = 0;
  for (;;) {
    const j = await links.poll(0, RECURSO); if (!j) break;
    entregues++; links.submit(j.id, { ok: true, data: LIDO });
  }
  const res = await Promise.all(todos);
  assert.equal(entregues, 120);
  assert.equal(res.filter((r) => r.falha === 'limite').length, 80);
  assert.equal(res.filter((r) => r.price === 89.9).length, 120);
});

test('A8 CA3/S2: pausa de 30 min: 29:59 ainda pausa, 30:00 volta; a verificação seguinte (sem leitura no meio) pausa 2 h; links e lista não são tocados pela pausa', async () => {
  const rel = relogio();
  const links = await comExtensaoNova({ agora: rel.agora });
  const bloquear = async () => {
    const p = links.requestProduto({ url: urlProduto(1) });
    const j = await links.poll(0, RECURSO);
    links.submit(j.id, { ok: true, data: { estado: 'verificacao' } });
    return p;
  };
  assert.deepEqual(await bloquear(), { falha: 'verificacao' });
  const naFila = links.status().pending;
  rel.t += PAUSA_VERIFICACAO_MIN * MIN - 1000;
  assert.deepEqual(await links.requestProduto({ url: urlProduto(2) }), { falha: 'verificacao' }, '29:59');
  assert.equal(links.status().pending, naFila, 'na pausa nada vai à extensão');
  // o link do ML segue normalmente durante a pausa
  const link = links.requestLink({ url: URL_ITEM_A, tag: 'x' });
  const jl = await links.poll(0, RECURSO); assert.equal(jl.type, 'link');
  links.submit(jl.id, { ok: true, link: 'https://meli.la/Pausa' });
  assert.equal(await link, 'https://meli.la/Pausa');
  rel.t += 1000; // 30:00
  const volta = links.requestProduto({ url: urlProduto(3) });
  const jv = await links.poll(0, RECURSO); assert.equal(jv.type, 'produto_ml', 'a pausa acabou');
  // o ML pede verificação de novo, sem leitura bem-sucedida no meio: o degrau seguinte, 2 h a partir de agora (S2)
  links.submit(jv.id, { ok: true, data: { estado: 'verificacao' } });
  assert.deepEqual(await volta, { falha: 'verificacao' });
  assert.equal(PAUSAS_VERIFICACAO_MIN[1], 120);
  rel.t += 120 * MIN - 1000;
  assert.equal(await links.poll(0, RECURSO), null);
  assert.deepEqual(await links.requestProduto({ url: urlProduto(4) }), { falha: 'verificacao' }, '1:59:59');
  rel.t += 1000;
  const livre = links.requestProduto({ url: urlProduto(5) });
  const jf = await links.poll(0, RECURSO); assert.equal(jf.type, 'produto_ml');
  links.submit(jf.id, { ok: true, data: LIDO });
  assert.deepEqual(await livre, { price: 89.9, disponivel: true });
});

test('A9 CA3: a verificação resolve só os produtos que esperam: o link e a lista que estavam na fila continuam esperando a extensão', async () => {
  const links = await comExtensaoNova();
  const p0 = links.requestProduto({ url: urlProduto(0) });
  const emAndamento = await links.poll(0, RECURSO);
  const espera = Array.from({ length: 15 }, (_, i) => links.requestProduto({ url: urlProduto(i + 1) }));
  const link = links.requestLink({ url: URL_ITEM_A, tag: 'x' });
  const ofertas = links.requestOffers({ paginas: [{}] });
  links.submit(emAndamento.id, { ok: true, data: { estado: 'verificacao' } });
  assert.deepEqual(await p0, { falha: 'verificacao' });
  assert.deepEqual(await Promise.all(espera), Array(15).fill({ falha: 'verificacao' }));
  assert.equal(links.status().pending, 2, 'sobraram só o link e a lista');
  assert.equal(await pendente(link), true); assert.equal(await pendente(ofertas), true);
  const a = await links.poll(0, RECURSO); const b = await links.poll(0, RECURSO);
  assert.deepEqual([a.type, b.type], ['link', 'ofertas']);
  links.submit(a.id, { ok: true, link: 'https://meli.la/Vivo' });
  links.submit(b.id, { ok: false, error: 'fim' });
  assert.equal(await link, 'https://meli.la/Vivo'); await assert.rejects(ofertas);
});

test('A10 CA4: resposta do tipo errado: produto respondido só com link, link respondido com dados de produto, id repetido e id inexistente', async () => {
  const links = await comExtensaoNova();
  const antes = links.status();
  const p = links.requestProduto({ url: urlProduto(1) });
  const jp = await links.poll(0, RECURSO);
  assert.equal(links.submit(jp.id, { ok: true, link: 'https://meli.la/Errado' }), true);
  assert.deepEqual(await p, { falha: 'erro' }, 'produto sem data');
  assert.equal(links.submit(jp.id, { ok: true, data: LIDO }), false, 'id repetido');
  assert.equal(links.submit(987654, { ok: true, data: LIDO }), false, 'id inexistente');

  const l = links.requestLink({ url: URL_ITEM_A, tag: 'x' });
  const jl = await links.poll(0, RECURSO);
  links.submit(jl.id, { ok: true, data: LIDO }); // dados de produto para um pedido de link
  await assert.rejects(l, /sem link/);
  const depois = links.status();
  assert.equal(depois.lastOkAt, antes.lastOkAt, 'o pedido de produto não marcou o selo de Conexões');
});

test('A11 timers: 150 pedidos de produto (lidos, erro, verificação e tempo) não deixam timer de 18 s para trás', async () => {
  const rel = relogio();
  const links = await comExtensaoNova({ agora: rel.agora });
  const contar = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const base = contar();
  for (let i = 0; i < 100; i++) {
    const p = links.requestProduto({ url: urlProduto(i), timeoutMs: 60_000 });
    const j = await links.poll(0, RECURSO);
    const resp = [{ ok: true, data: LIDO }, { ok: false, error: 'x' }, { ok: true, data: { lixo: 1 } }, { ok: true, data: LIDO }][i % 4];
    links.submit(j.id, resp);
    await p;
  }
  assert.equal(contar(), base, 'nenhum Timeout sobrou');
  // 30 pedidos que a verificação resolve por tabela: também sem timer
  const lote = Array.from({ length: 30 }, (_, i) => links.requestProduto({ url: urlProduto(i), timeoutMs: 60_000 }));
  const j = await links.poll(0, RECURSO);
  links.submit(j.id, { ok: true, data: { estado: 'verificacao' } });
  await Promise.all(lote);
  assert.equal(contar(), base, 'a limpeza da fila na verificação também limpou os timers');
});

test('A12 CA7: x-recursos hostil: maiúsculas, vazio, repetido e injeção não ligam nada; o nome certo no meio de uma lista liga', async () => {
  const antigas = ['PRODUTO_ML', '', 'produto_ml_extra', 'produto_ml;x', '__proto__', 'constructor', ' ', undefined, null, 5, ['produto_ml'], 'x'.repeat(201) + ',produto_ml'];
  for (const h of antigas) {
    const links = createLinkService({ getMode: () => 'extension' });
    await links.poll(0, { recursos: h });
    assert.deepEqual(await links.requestProduto({ url: urlProduto(1) }), { falha: 'antiga' }, `cabeçalho ${JSON.stringify(h)}`);
    assert.equal(links.status().pending, 0);
  }
  const links = createLinkService({ getMode: () => 'extension' });
  await links.poll(0, { recursos: 'link_novo, produto_ml ,__proto__' });
  const p = links.requestProduto({ url: urlProduto(1) });
  const j = await links.poll(0, { recursos: 'link_novo, produto_ml ,__proto__' });
  assert.equal(j.type, 'produto_ml');
  links.submit(j.id, { ok: true, data: LIDO });
  assert.deepEqual(await p, { price: 89.9, disponivel: true });
});

test('A13 CA7: a URL que vai à extensão: mercadolibre.com, host com ponto a mais, userinfo, porta, http, // e # não passam; o # sai e a extensão aceita o que sobra', async () => {
  const links = await comExtensaoNova();
  const recusadas = [
    'https://www.mercadolibre.com.br/MLB-123456789', 'https://mercadolivre.com.br.evil.com/MLB-123456789', 'https://evilmercadolivre.com.br/x',
    'https://www.mercadolivre.com.br@evil.com/x', 'https://user:pw@www.mercadolivre.com.br/x', 'https://www.mercadolivre.com.br:8443/x',
    'http://www.mercadolivre.com.br/x', 'https://meli.la/AbCdE', 'javascript:alert(1)', '', null, undefined, 42, {},
    `https://www.mercadolivre.com.br/${'a'.repeat(2100)}`,
    // S1: a barra invertida vira "/" e o caminho deixa de ser de produto; idem para qualquer página que não é anúncio/catálogo
    'https://www.mercadolivre.com.br\\@evil.com/x', 'https://www.mercadolivre.com.br\\@evil.com/MLB-1234567', 'https://www.mercadolivre.com.br/x',
  ];
  for (const u of recusadas) {
    assert.deepEqual(await links.requestProduto({ url: u }), { falha: 'erro' }, String(u).slice(0, 60));
    assert.equal(links.status().pending, 0, `sem pedido para ${String(u).slice(0, 40)}`);
  }
  const p = links.requestProduto({ url: `${URL_CAT_A}#polycard_client=affiliates&wid=${ITEM_B}` });
  const j = await links.poll(0, RECURSO);
  assert.equal(j.url, URL_CAT_A, 'o # saiu');
  assert.equal(X.urlProdutoML(j.url), j.url, 'e a extensão aceita exatamente o que o servidor mandou');
  links.submit(j.id, { ok: true, data: LIDO });
  await p;
});

test('A14 CA7/S1: toda URL que o servidor manda é aceita como está pela extensão (acentos, espaços, %zz, ? vazio, pdp_filters), e o pedido leva só origin + caminho + pdp_filters=item_id', async () => {
  const links = await comExtensaoNova();
  const urls = [
    ['https://www.mercadolivre.com.br/camiseta-ação/p/MLB123?x=á é&y=\'"`|[]{}<>', 'https://www.mercadolivre.com.br/camiseta-a%C3%A7%C3%A3o/p/MLB123'],
    ['https://WWW.MercadoLivre.com.br/MLB-123456789-x?a=%zz&b=%E0%A4%A&c=%2f', 'https://www.mercadolivre.com.br/MLB-123456789-x'],
    ['https://produto.mercadolivre.com.br/MLB-123456789-x_JM?matt_tool=1&a=a b', 'https://produto.mercadolivre.com.br/MLB-123456789-x_JM'],
    ['https://www.mercadolivre.com.br/p/MLB1?pdp_filters=item_id:MLB123,category:MLB1', 'https://www.mercadolivre.com.br/p/MLB1'],
    ['https://www.mercadolivre.com.br/p/MLB1?wid=1&pdp_filters=item_id%3AMLB5257531512', 'https://www.mercadolivre.com.br/p/MLB1?pdp_filters=item_id:MLB5257531512'],
    ['https://www.mercadolivre.com.br/a/../p/./MLB15142194?', 'https://www.mercadolivre.com.br/p/MLB15142194'],
    ['https://ｗｗｗ.mercadolivre.com.br/MLB-1234567', 'https://www.mercadolivre.com.br/MLB-1234567'],
    ['https://www.mercadolivre.com.br/MLB-1234567-x\ty\nz', 'https://www.mercadolivre.com.br/MLB-1234567-xyz'],
    ['https://www.mercadolivre.com.br:443/MLB-1234567', 'https://www.mercadolivre.com.br/MLB-1234567'],
    ['https://www.mercadolivre.com.br/MLB-1234567?a=1&&b=2#', 'https://www.mercadolivre.com.br/MLB-1234567'],
  ];
  for (const [u, esperado] of urls) {
    const p = links.requestProduto({ url: u });
    const j = await links.poll(0, RECURSO);
    assert.equal(j.type, 'produto_ml', u);
    assert.equal(j.url, esperado, u);
    assert.equal(X.urlProdutoML(j.url), j.url, `a extensão recusaria o que o servidor mandou: ${j.url}`);
    links.submit(j.id, { ok: true, data: LIDO });
    assert.deepEqual(await p, { price: 89.9, disponivel: true });
  }
  // e o que o servidor nunca manda (query a mais, # e outra página), a extensão também recusa
  for (const u of [`${URL_CAT}?pdp_filters=item_id:${ITEM_A}&x=1`, `${URL_CAT_A}#x`, `${URL_CAT}?`, `${ML}/x`, `${ML}/jms/mlb/lgz/logout`]) assert.equal(X.urlProdutoML(u), null, u);
});

// ============================================================================================= B. o JSON-LD

test('B1 CA7/R1: catálogo /p/ sem pdp_filters e com várias variantes (uma esgotada, outras à venda): nem preço nem estoque de nenhuma delas, só "várias versões"', () => {
  const html = pagina(grupo([variante(ITEM_A, 154.99, ESGOTADO), variante(ITEM_B, 159), variante(ITEM_C, 99)]));
  for (const url of [URL_CAT, `${URL_CAT}?wid=${ITEM_B}`, `${URL_CAT}?pdp_filters=category:MLB1648`, `${URL_CAT}#pdp_filters=item_id:${ITEM_B}`, `${URL_CAT}?foo=item_id:${ITEM_B}`]) {
    assert.deepEqual(viaExtensao(html, url), { price: null, disponivel: null, varias: true }, url);
  }
  // com o filtro, a variante certa e só ela, inclusive o esgotado dela
  assert.deepEqual(viaExtensao(html, URL_CAT_A), { price: 154.99, disponivel: false });
  assert.deepEqual(viaExtensao(html, URL_CAT_B), { price: 159, disponivel: true });
});

test('B2 CA7: URL com "#": o fragmento nunca escolhe a variante, e o filtro do query antes do # vale', () => {
  const html = pagina(grupo([variante(ITEM_A, 154.99), variante(ITEM_B, 159)]));
  assert.deepEqual(viaExtensao(html, `${URL_CAT_B}#reco_item_pos=0&pdp_filters=item_id:${ITEM_A}`), { price: 159, disponivel: true });
  // o fragmento não diz o anúncio: vale o resumo das versões (as duas à venda → a mais barata, marcada `varias`, que o
  // verificador nunca toma como o preço do anúncio)
  assert.deepEqual(viaExtensao(html, `${URL_CAT}#item_id:${ITEM_A}`), { price: 154.99, disponivel: true, varias: true });
  assert.equal(mlReal.itemDoAnuncio(`${URL_ITEM_A}#wid=${ITEM_B}`), ITEM_A, 'o fragmento não troca o anúncio do caminho');
});

test('B3 CA2/CA7: ProductGroup e Product juntos: no mesmo bloco (@graph) o grupo manda; um Product em outro bloco só entra se o grupo não deu variante', () => {
  const recomendado = produto(10, EM_ESTOQUE, { name: 'Outro produto recomendado' });
  const mesmoBloco = pagina({ '@context': 'https://schema.org', '@graph': [recomendado, grupo([variante(ITEM_A, 154.99), variante(ITEM_B, 159)])] });
  assert.deepEqual(viaExtensao(mesmoBloco, URL_CAT_B), { price: 159, disponivel: true });
  assert.deepEqual(viaExtensao(mesmoBloco, URL_CAT), { price: 154.99, disponivel: true, varias: true }, 'sem item, o Product do mesmo bloco não vale no lugar do grupo: só o resumo das versões');
  // blocos separados: o Product vem antes do grupo → o preço dele vale (ordem da página; igual ao servidor)
  const separados = pagina(recomendado, grupo([variante(ITEM_A, 154.99)]));
  assert.equal(viaExtensao(separados, URL_CAT_A).price, 10, 'comportamento herdado: o primeiro bloco com nome e preço');
});

test('B4 CA2: variante do anúncio sem offers (ou sem price) não informa nada: nunca vale o preço nem o estoque de outra variante', () => {
  const semOffers = { '@type': 'Product', sku: ITEM_A, name: 'Fritadeira A' };
  const html = pagina(grupo([semOffers, variante(ITEM_B, 159, ESGOTADO)]));
  assert.deepEqual(viaExtensao(html, URL_CAT_A), { price: null, disponivel: null });
  assert.deepEqual(viaExtensao(html, URL_CAT_B), { price: 159, disponivel: false });
  const semPreco = { '@type': 'Product', sku: ITEM_A, name: 'A', offers: { '@type': 'Offer', availability: EM_ESTOQUE } };
  assert.deepEqual(viaExtensao(pagina(grupo([semPreco, variante(ITEM_B, 5)])), URL_CAT_A), { price: null, disponivel: true });
  // offers como lista vazia e como null
  for (const offers of [[], null, 'texto', 7]) {
    const v = { '@type': 'Product', sku: ITEM_A, name: 'A', offers };
    assert.deepEqual(viaExtensao(pagina(grupo([v, variante(ITEM_B, 5)])), URL_CAT_A), { price: null, disponivel: null }, JSON.stringify(offers));
  }
});

test('B5 CA7: mais de 30 variantes: a extensão corta em 30 (o anúncio na 31ª posição não é lido e dá "sem preço", nunca o de outra variante)', () => {
  const muitas = Array.from({ length: 40 }, (_, i) => variante(`MLB${5000000000 + i}`, 100 + i));
  const html = pagina(grupo(muitas));
  const noLimite = `${URL_CAT}?pdp_filters=item_id:MLB${5000000000 + 29}`;
  const alem = `${URL_CAT}?pdp_filters=item_id:MLB${5000000000 + 30}`;
  assert.deepEqual(viaExtensao(html, noLimite), { price: 129, disponivel: true });
  assert.deepEqual(viaExtensao(html, alem), { price: null, disponivel: null });
  // o servidor (modo direct) lê as 40: a diferença é só de alcance, documentada como lacuna
  return viaServidor(html, alem).then((r) => assert.deepEqual(r, { price: 130, disponivel: true }));
});

test('B6 CA7: variantes repetidas (mesmo sku duas vezes) e sku fora de MLB: vale a primeira com o sku; sku que não é MLB nunca casa', () => {
  const html = pagina(grupo([variante(ITEM_A, 154.99), variante(ITEM_A, 1.99), variante('12345', 7), variante(undefined, 8)]));
  assert.equal(viaExtensao(html, URL_CAT_A).price, 154.99);
  assert.deepEqual(viaExtensao(html, `${URL_CAT}?pdp_filters=item_id:MLB1234567`), { price: null, disponivel: null });
});

test('B7 CA2: esgotado só com o enum: PreOrder, BackOrder, texto livre e "out of stock" não descartam; OutOfStock, SoldOut e Discontinued (também em http e sem prefixo) descartam', () => {
  const pagina1 = (av) => pagina(produto(100, av));
  for (const av of ['https://schema.org/PreOrder', 'https://schema.org/BackOrder', 'esgotado', 'out of stock', 'https://schema.org/OutOfStockish', '', 5, null, { x: 1 }]) {
    assert.equal(viaExtensao(pagina1(av), URL_ITEM_A).disponivel, null, JSON.stringify(av));
    assert.equal(viaExtensao(pagina1(av), URL_ITEM_A).price, 100);
  }
  for (const av of ['https://schema.org/OutOfStock', 'http://schema.org/SoldOut', 'Discontinued', 'https://www.schema.org/OutOfStock', ' OutOfStock ']) {
    assert.equal(viaExtensao(pagina1(av), URL_ITEM_A).disponivel, false, av);
  }
});

test('B8 CA7: bloco com </script> dentro de texto, comentário HTML, JSON quebrado e BOM: nada quebra e o próximo bloco bom ainda vale', () => {
  const html = pagina('<script type="application/ld+json">{"@type":"Product","name":"x",</script>',
    '<script type="application/ld+json">﻿{"@type":"Product","name":"BOM","offers":{"price":50}}</script>',
    '<!-- <script type="application/ld+json">{"@type":"Product","name":"c","offers":{"price":1}}</script> -->',
    produto(77));
  const r = viaExtensao(html, URL_ITEM_A);
  assert.ok(r && typeof r.price === 'number' && r.price > 0, JSON.stringify(r)); // BOM faz o JSON.parse falhar: vale o do comentário ou o 77, nunca erro
  assert.notEqual(r, null);
});

/** Gerador pseudoaleatório com semente fixa (mulberry32). */
function aleatorio(semente) {
  let a = semente >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('B9 CA2: diferencial: o caminho da extensão (ofertasDoHtml → lerProdutoDaExtensao) dá a mesma resposta que o leitor do servidor em 600 páginas aleatórias (semente fixa)', async () => {
  const rnd = aleatorio(20261109);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const SKUS = [ITEM_A, ITEM_B, ITEM_C, 'MLB-5257531512', 'mlb5257531512', '12345', 'MLB9', undefined, null];
  const PRECOS = [10, 89.9, '89.90', '1299', 'R$ 1.234,56', 0, '0', '', null, undefined, 'grátis', 1e3, 50.5, '99,90'];
  const AVS = [EM_ESTOQUE, ESGOTADO, 'https://schema.org/PreOrder', 'LimitedAvailability', 'Discontinued', null, undefined, 'x'];
  const oferta = () => (rnd() < 0.12 ? undefined : { '@type': 'Offer', price: pick(PRECOS), availability: pick(AVS) });
  const prod = (sku) => { const p = { '@type': 'Product', name: rnd() < 0.85 ? `P${Math.floor(rnd() * 99)}` : undefined, sku, offers: oferta() }; return p; };
  const bloco = () => {
    const k = rnd();
    if (k < 0.3) return ld({ '@context': 'https://schema.org', ...prod(pick(SKUS)) });
    if (k < 0.55) return ld(grupo(Array.from({ length: 1 + Math.floor(rnd() * 7) }, () => prod(pick(SKUS))), { name: rnd() < 0.8 ? 'G' : undefined }));
    if (k < 0.7) return ld({ '@context': 'https://schema.org', '@graph': [prod(pick(SKUS)), grupo([prod(pick(SKUS)), prod(pick(SKUS))])] });
    if (k < 0.8) return ld({ '@type': 'BreadcrumbList', itemListElement: [] });
    if (k < 0.9) return '<script type="application/ld+json">{ não é json</script>';
    return '<script type="application/json">{"price":1}</script>';
  };
  const urls = [URL_ITEM_A, URL_CAT, URL_CAT_A, URL_CAT_B, `${URL_CAT}?pdp_filters=item_id:${ITEM_C}`, 'https://produto.mercadolivre.com.br/MLB-5257443218'];
  const divergencias = []; const cobertura = {};
  for (let i = 0; i < 600; i++) {
    const html = pagina(...Array.from({ length: Math.floor(rnd() * 5) }, bloco));
    const url = pick(urls);
    const s = await viaServidor(html, url);
    const e = viaExtensao(html, url);
    if (e === null) { divergencias.push({ i, motivo: 'extensão recusou a página', servidor: s }); continue; }
    cobertura[`${s.price != null ? 'preco' : 'sem-preco'}/${s.disponivel}`] = (cobertura[`${s.price != null ? 'preco' : 'sem-preco'}/${s.disponivel}`] ?? 0) + 1;
    if (s.price !== e.price || s.disponivel !== e.disponivel || (s.varias === true) !== (e.varias === true)) divergencias.push({ i, url, servidor: s, extensao: e, html: html.slice(html.indexOf('</script>') + 9, -60) });
  }
  assert.deepEqual(divergencias.slice(0, 3), [], `${divergencias.length} páginas dão respostas diferentes`);
  // o corpus é variado de verdade: todas as combinações de resultado aparecem
  for (const k of ['preco/true', 'preco/false', 'preco/null', 'sem-preco/true', 'sem-preco/false', 'sem-preco/null']) assert.ok(cobertura[k] >= 10, `${k}: ${JSON.stringify(cobertura)}`);
});

// ====================================================================================== C. ponta a ponta

const G1 = '111@g.us';
const CORPO = '{TITULO_PRODUTO}\nPor {PRECO_PRODUTO}[ (de {PRECO_ANTIGO})]\n[🕒 Preço visto às {HORA_PRECO}]\n{LINK}';

function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

/** Sobe como o main (criarServicos com verificador, links em `extension`, relógio dos links injetado). */
function subir({ rel = relogio(Date.now()), modo = 'extension', simulado = false, dir = tmp() } = {}) {
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ db, getMode: () => modo, agora: rel.agora }); // como o main: a pausa e o teto ficam no banco
  const leituras = [];
  const ml = {
    ...mlReal,
    async resolveOffer(c) { return { key: c.key, url: c.url, title: 'Fone Bom', price: 100, oldPrice: 300, discountPct: 66, sold: 10, freeShipping: false, image: null }; },
    async conferirProduto(url) { leituras.push(url); throw new Error('o servidor não pode ler o ML no modo extensão'); },
  };
  const servicos = criarServicos({ db, wa, links, fast: true, dir, ml, fetch: redeProibida, verificar: true, simulado });
  const app = buildApp({ db, wa, links, scheduler: servicos.scheduler, ml, publicHost: '', panelPassword: '' });
  // reinício do serviço sobre a mesma pasta: o banco já tem grupo, etiqueta e template
  if (!db.prepare('SELECT 1 FROM groups WHERE jid = ?').get(G1)) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(G1, 'Achadinhos', 10, Date.now());
  const tag = db.prepare("SELECT id FROM tags WHERE name = 'etiquetaA'").get()?.id ?? Number(db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run('etiquetaA').lastInsertRowid);
  const tpl = db.prepare("SELECT id FROM templates WHERE name = 'Com hora'").get()?.id ?? Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Com hora', CORPO, Date.now()).lastInsertRowid);
  const token = getSetting(db, 'ext_token');
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      ok({
        db, port, wa, links, ml, leituras, servicos, rel, scheduler: servicos.scheduler, verificador: servicos.verificador, token, tag, tpl,
        origin: `http://127.0.0.1:${port}`,
        fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }),
      });
    });
  });
}

/**
 * A extensão simulada: poll e resposta por HTTP, como a de verdade. `paginas`: (url pedida) → { status, url, html }
 * (padrão: uma página de produto de R$ 100 em estoque). `recursos` null = a 1.4.2.
 */
function extensao(s, { recursos = 'produto_ml', paginas = null, laco: comLaco = true } = {}) {
  const cab = { 'x-token': s.token, ...(recursos ? { 'x-recursos': recursos } : {}) };
  const vistos = []; const devolvidos = [];
  let parar = false;
  const paginaDe = paginas ?? ((url) => ({ status: 200, url, html: pagina(produto(100)) }));
  const pollUma = async () => (await req(s.port, '/api/ext/poll', { headers: cab })).json?.job ?? null;
  async function resposta(job) {
    if (job.type === 'link') return { ok: true, link: `https://meli.la/Qa${job.id}` };
    if (job.type !== 'produto_ml') return { ok: false, error: 'pedido desconhecido' };
    const url = X.urlProdutoML(job.url);
    if (!url) return { ok: false, error: 'endereço de produto do Mercado Livre recusado pela extensão' };
    const pg = paginaDe(url);
    const r = new Response(pg.html, { status: pg.status });
    Object.defineProperty(r, 'url', { value: pg.url });
    const v = X.estadoDaResposta(r.status, r.url);
    if (v.erro) return { ok: false, error: v.erro };
    if (!v.ler) return { ok: true, data: { estado: 'verificacao' } };
    return { ok: true, data: { estado: 'lido', ofertas: plano(X.ofertasDoHtml(await X.corpoDaPaginaML(r))) } };
  }
  async function responder(job) {
    const r = await resposta(job);
    devolvidos.push(plano({ tipo: job.type, ...r }));
    const ret = await req(s.port, '/api/ext/result', { method: 'POST', headers: { 'x-token': s.token }, body: { id: job.id, ...r } });
    assert.deepEqual([ret.status, ret.json], [200, { ok: true }]);
  }
  const laco = !comLaco ? null : (async () => {
    while (!parar) { const job = await pollUma(); if (!job) continue; vistos.push(job); await responder(job); }
  })().catch(() => {});
  return {
    vistos, devolvidos, pollUma, responder, tipos: () => vistos.map((j) => j.type),
    async parar() {
      parar = true;
      if (!laco) return;
      s.links.requestLink({ url: URL_ITEM_A, tag: 'x', timeoutMs: 1000 }).catch(() => {});
      await laco;
    },
  };
}

async function ligada(s) {
  const t0 = Date.now();
  while (s.links.status().lastPollAt < t0 - 5 || !s.links.status().online) {
    assert.ok(Date.now() - t0 < 3000, 'a extensão simulada não fez poll');
    await esperar(5);
  }
}

/** Roda `corpo` com o servidor e a extensão no ar; o console.error é capturado e conferido no fim (nada de HTML, URL ou segredo). */
async function comExtensao(t, opcoes, corpo) {
  const consoleErros = [];
  t.mock.method(console, 'error', (...a) => consoleErros.push(a.map(String).join(' ')));
  const s = await subir(opcoes);
  const ext = extensao(s, opcoes);
  try {
    if (opcoes.laco !== false) await ligada(s); // sem laço, quem faz o primeiro poll é o teste
    await corpo(s, ext);
    semVazamento(s, consoleErros);
  } finally {
    await ext.parar();
    await s.fechar();
  }
}

const VAZOU = /SEGREDO-DA-PAGINA|mercadolivre\.com\.br|account-verification|<script|ld\+json|pdp_filters|https?:\/\//i;
/** Nenhum texto do Histórico, do banco de envios nem do console tem HTML, endereço ou o segredo da página. */
function semVazamento(s, consoleErros) {
  const linhas = s.db.prepare('SELECT rule_name, level, group_name, offer_title, message FROM log').all().map((l) => ({ ...l }));
  for (const l of linhas) {
    for (const campo of ['message', 'group_name', 'rule_name']) assert.doesNotMatch(String(l[campo] ?? ''), VAZOU, `log (${campo}): ${l[campo]}`);
  }
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT resultado FROM envios').all()), VAZOU, 'resultado dos envios');
  for (const c of consoleErros) assert.doesNotMatch(c, VAZOU, `console: ${c}`);
}

const logs = (s) => s.db.prepare('SELECT rule_name, level, group_name, offer_title, message FROM log ORDER BY id').all().map((l) => ({ ...l }));
const envio = (s, id) => ({ ...s.db.prepare('SELECT * FROM envios WHERE id = ?').get(id) });

async function disparar(s, url, { quando = 'agora' } = {}) {
  const r = await req(s.port, '/api/envios', { method: 'POST', headers: { origin: s.origin },
    body: { tipo: 'oferta', url, tag_id: s.tag, template_id: s.tpl, group_jids: [G1], quando } });
  assert.equal(r.status, 200, r.txt);
  const t0 = Date.now();
  while (['pendente', 'enviando'].includes(envio(s, r.json.id).status)) {
    assert.ok(Date.now() - t0 < 5000, 'o envio não terminou');
    await esperar(5);
  }
  return { id: r.json.id, ...envio(s, r.json.id) };
}

test('C1 CA1/CA2/R1: catálogo /p/ sem pdp_filters com variante esgotada e outra à venda: o envio não é descartado, sai "sem conferir" (várias versões) e sem {HORA_PRECO}', async (t) => {
  const html = pagina(grupo([variante(ITEM_A, 154.99, ESGOTADO), variante(ITEM_B, 159), variante(ITEM_C, 99)]));
  await comExtensao(t, { paginas: (url) => ({ status: 200, url, html }) }, async (s, ext) => {
    const r = await disparar(s, URL_CAT);
    assert.equal(r.status, 'concluido', r.resultado);
    assert.deepEqual(ext.tipos(), ['produto_ml', 'link']);
    assert.deepEqual(s.leituras, []);
    assert.doesNotMatch(s.wa.simulated[0].text, /Preço visto/);
    assert.deepEqual(logs(s).map((l) => [l.level, l.message]), [['ok', `Enviado com a etiqueta etiquetaA · preço não conferido (${CAUSAS.varias_versoes})`]]);
  });
});

test('C2 CA1/CA2: o item do anúncio esgotado dentro do catálogo descarta com aviso (nunca erro) e o outro item do mesmo catálogo segue à venda', async (t) => {
  const html = pagina(grupo([variante(ITEM_A, 100, ESGOTADO), variante(ITEM_B, 100)]));
  await comExtensao(t, { paginas: (url) => ({ status: 200, url, html }) }, async (s, ext) => {
    const a = await disparar(s, URL_CAT_A);
    assert.equal(resultadoDe(s, a.id).descartado, 'esgotado');
    const b = await disparar(s, URL_CAT_B);
    assert.equal(b.status, 'concluido', b.resultado);
    assert.deepEqual(logs(s).map((l) => l.level), ['aviso', 'ok'], 'nenhum nível erro');
    assert.equal(s.wa.simulated.length, 1);
    assert.deepEqual(ext.tipos(), ['produto_ml', 'produto_ml', 'link']);
  });
});
const resultadoDe = (s, id) => JSON.parse(envio(s, id).resultado);

test('C4 CA3/CA6: pausa e retomada ponta a ponta com o relógio dos links: durante os 30 min nenhum produto_ml chega à extensão; no minuto 30 volta a conferir', async (t) => {
  const rel = relogio(Date.now());
  const paginas = (url) => (/MLB-3000000001/.test(url)
    ? { status: 200, url: `${ML}/gz/account-verification?go=1`, html: '' } : { status: 200, url, html: pagina(produto(100)) });
  await comExtensao(t, { rel, paginas }, async (s, ext) => {
    const verif = await disparar(s, 'https://produto.mercadolivre.com.br/MLB-3000000001');
    assert.equal(verif.status, 'concluido', verif.resultado);
    const vistos = () => ext.tipos().filter((x) => x === 'produto_ml').length;
    assert.equal(vistos(), 1);
    rel.t += 29 * MIN;
    const durante = await disparar(s, 'https://produto.mercadolivre.com.br/MLB-3000000002');
    assert.equal(durante.status, 'concluido');
    assert.equal(vistos(), 1, 'a extensão não foi incomodada durante a pausa');
    rel.t += 1 * MIN;
    const depois = await disparar(s, 'https://produto.mercadolivre.com.br/MLB-3000000002');
    assert.equal(depois.status, 'concluido');
    assert.equal(vistos(), 2, 'a conferência voltou');
    assert.deepEqual(logs(s).map((l) => [l.level, l.message]), [
      ['ok', `Enviado com a etiqueta etiquetaA · preço não conferido (${CAUSAS.ml_verificacao})`],
      ['ok', `Enviado com a etiqueta etiquetaA · preço não conferido (${CAUSAS.ml_verificacao})`],
      ['ok', 'Enviado com a etiqueta etiquetaA'],
    ]);
  });
});

test('C5 CA6: o 121º envio da hora sai "sem conferir" com a causa do limite, sem pedido à extensão, e com dados velhos não sai (nao_conferido)', async (t) => {
  const rel = relogio(Date.now());
  await comExtensao(t, { rel }, async (s, ext) => {
    const oferta = { loja: 'mercadolivre', url: URL_ITEM_A, price: 100, title: 'Fone' };
    for (let i = 0; i < LIMITE_PRODUTO_HORA; i++) {
      const r = await s.verificador.conferir(oferta, { lidoEm: Date.now() });
      assert.equal(r.conferido, true, `conferência ${i + 1}`);
    }
    assert.equal(ext.tipos().length, 120);
    const fresca = await s.verificador.conferir(oferta, { lidoEm: Date.now() });
    assert.equal(fresca.sufixo, ` · preço não conferido (${CAUSAS.limite_hora})`);
    const velha = await s.verificador.conferir(oferta, { lidoEm: Date.now() - 31 * MIN });
    assert.deepEqual([velha.acao, velha.motivo], ['descartar', 'nao_conferido']);
    assert.match(velha.texto, /o limite de conferências por hora foi atingido/);
    assert.equal(ext.tipos().length, 120, 'nenhum pedido a mais chegou à extensão');
    rel.t += 61 * MIN;
    assert.equal((await s.verificador.conferir(oferta, { lidoEm: Date.now() })).conferido, true, 'a hora virou');
  });
});

test('C6 CA5: 25 conferências simultâneas na fila e um link urgente: a extensão (que atende uma por vez) recebe o link logo depois do produto em andamento', async (t) => {
  await comExtensao(t, { laco: false }, async (s, ext) => {
    const primeiro = ext.pollUma(); // marca on-line com o recurso
    await ligada(s);
    const oferta = (n) => ({ loja: 'mercadolivre', url: urlProduto(n), price: 100, title: 'Fone' });
    const conferencias = Array.from({ length: 25 }, (_, i) => s.verificador.conferir(oferta(i), { lidoEm: Date.now() }));
    const j0 = await primeiro;
    assert.equal(j0.type, 'produto_ml');
    const link = s.links.requestLink({ url: URL_ITEM_A, tag: 'x', timeoutMs: 5000 });
    await ext.responder(j0); // o produto em andamento termina
    const j1 = await ext.pollUma();
    assert.equal(j1.type, 'link', 'o link vem antes dos 24 produtos que esperam');
    await ext.responder(j1);
    assert.match(await link, /^https:\/\/meli\.la\/Qa\d+$/);
    for (let i = 0; i < 24; i++) { const j = await ext.pollUma(); assert.equal(j.type, 'produto_ml'); await ext.responder(j); }
    const rs = await Promise.all(conferencias);
    assert.equal(rs.filter((r) => r.conferido === true).length, 25);
  });
});

test('C7 CA1/CA2: regra do Catálogo com ML: o conferido sai sozinho, a verificação manda o resto para a revisão sem tocar a extensão, e nada é erro', async (t) => {
  const paginas = (url) => (/MLB-2000000002/.test(url)
    ? { status: 200, url: `${ML}/gz/account-verification`, html: '' } : { status: 200, url, html: pagina(produto(100)) });
  await comExtensao(t, { paginas }, async (s, ext) => {
    const of = (n) => ({ id: n, loja: 'ml', titulo: `Produto ${n}`, preco: 100, preco_antigo: 300, desconto_pct: 66, categoria: 'Casa', item_id: `MLB${n}`, link: 'https://meli.la/TerCeiro1' });
    const lista = [of(5257531512), of(2000000002), of(2000000003)];
    s.servicos.catalogo.candidatos = async (cfg, { tratada }) => lista.map(paraCandidato).filter((c) => c && !tratada(c, cfg.ordem));
    const id = Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
      sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
      VALUES ('Catálogo', 1, ?, ?, ?, 'list', '{}', ?, 5, 60, '00:00', '23:59', 7, 0, ?)`)
      .run(s.tag, s.tpl, JSON.stringify([G1]), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }]), Date.now()).lastInsertRowid);
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages, r.errors, r.revisao, r.descartadas], [1, 1, 0, 2, 0]);
    const itens = s.db.prepare('SELECT chave, status, motivos FROM catalogo_itens WHERE rule_id = ? ORDER BY id').all(id).map((l) => [l.chave, l.status, JSON.parse(l.motivos)]);
    assert.deepEqual(itens, [['MLB5257531512', 'enviado', []], ['MLB2000000002', 'revisao', ['nao_conferido']], ['MLB2000000003', 'revisao', ['nao_conferido']]]);
    assert.deepEqual(ext.tipos(), ['produto_ml', 'link', 'produto_ml'], 'o terceiro item não pediu nada à extensão (pausa)');
    const linhas = logs(s).map((l) => [l.level, l.message]);
    assert.deepEqual(linhas, [
      ['ok', 'Enviado com a etiqueta etiquetaA'],
      ['aviso', `Separada para revisão: não deu para conferir o preço (${CAUSAS.ml_verificacao}).`],
      ['aviso', `Separada para revisão: não deu para conferir o preço (${CAUSAS.ml_verificacao}).`],
      // a regra pediu 5 (plano rodar-sozinho-entrega1, CA1.8)
      ['aviso', 'Saíram 1 de 5 ofertas; 2 separadas para revisão; não havia mais ofertas novas dentro dos filtros.'],
    ]);
    assert.ok(!linhas.some(([n]) => n === 'erro'));
  });
});

test('C8 CA4: regra do Catálogo com a extensão antiga: todos os itens do ML vão à revisão com "precisa ser recarregada", nenhum produto_ml é entregue', async (t) => {
  await comExtensao(t, { recursos: null }, async (s, ext) => {
    const of = (n) => ({ id: n, loja: 'ml', titulo: `Produto ${n}`, preco: 100, preco_antigo: 300, desconto_pct: 66, categoria: 'Casa', item_id: `MLB${n}`, link: 'https://meli.la/TerCeiro1' });
    const lista = [of(5257531512), of(2000000002)];
    s.servicos.catalogo.candidatos = async (cfg, { tratada }) => lista.map(paraCandidato).filter((c) => c && !tratada(c, cfg.ordem));
    const id = Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
      sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
      VALUES ('Catálogo', 1, ?, ?, ?, 'list', '{}', ?, 5, 60, '00:00', '23:59', 7, 0, ?)`)
      .run(s.tag, s.tpl, JSON.stringify([G1]), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }]), Date.now()).lastInsertRowid);
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.errors, r.revisao], [0, 0, 2]);
    assert.deepEqual(ext.tipos(), []);
    // a regra pediu 5 e nada saiu: a última linha é a frase "saíram" (plano rodar-sozinho-entrega1, CA1.8)
    assert.equal(logs(s).at(-1).message, 'Saíram 0 de 5 ofertas; 2 separadas para revisão; não havia mais ofertas novas dentro dos filtros.');
    for (const l of logs(s).slice(0, -1)) assert.equal(l.message, `Separada para revisão: não deu para conferir o preço (${CAUSAS.extensao_antiga}).`);
    assert.equal(logs(s).length, 3);
    assert.ok(!logs(s).some((l) => l.level === 'erro'));
  });
});

test('C9 CA7: resultado hostil pela rota HTTP (chaves a mais, __proto__, preço enorme, ofertas demais): vira "a loja não respondeu", sem erro e sem vazar o conteúdo', async (t) => {
  await comExtensao(t, { laco: false }, async (s, ext) => {
    const primeiro = ext.pollUma(); await ligada(s);
    const oferta = { loja: 'mercadolivre', url: URL_ITEM_A, price: 100, title: 'Fone' };
    const hostis = [
      JSON.parse('{"estado":"lido","ofertas":[],"__proto__":{"polluido":true}}'),
      { estado: 'lido', ofertas: [{ nome: true, price: 1e21, availability: EM_ESTOQUE }] },
      { estado: 'lido', ofertas: [{ nome: true, price: '99999999999999999999', availability: EM_ESTOQUE }] },
      { estado: 'lido', ofertas: Array(6).fill({ nome: true, price: 1 }) },
      { estado: 'lido', ofertas: [{ nome: true, price: 1, html: `<b>${SEGREDO}</b>` }] },
      { estado: 'lido', ofertas: [{ nome: true, price: 1 }], url: `${ML}/x` },
      { estado: 'verificado' },
      'texto', 42, null, [],
    ];
    let proximo = await primeiro;
    for (const h of hostis) {
      const c = s.verificador.conferir(oferta, { lidoEm: Date.now() });
      const job = proximo ?? await ext.pollUma();
      proximo = null;
      assert.equal(job.type, 'produto_ml');
      const ret = await req(s.port, '/api/ext/result', { method: 'POST', headers: { 'x-token': s.token }, body: { id: job.id, ok: true, data: h } });
      assert.deepEqual(ret.json, { ok: true });
      const r = await c;
      assert.equal(r.sufixo, ` · preço não conferido (${CAUSAS.loja_fora})`, JSON.stringify(h)?.slice(0, 80));
    }
    assert.equal({}.polluido, undefined, 'nenhum __proto__ poluiu Object.prototype');
  });
});

test('C10 CA7: as duas extensões ao mesmo tempo por HTTP (1.4.2 e 1.5.0): a antiga nunca vê produto_ml, os links saem todos, e cada conferência lê ou diz "precisa ser recarregada"', async (t) => {
  await comExtensao(t, { recursos: 'produto_ml' }, async (s, nova) => {
    const antiga = extensao(s, { recursos: null });
    try {
      const oferta = (n) => ({ loja: 'mercadolivre', url: urlProduto(n), price: 100, title: 'Fone' });
      const conf = Array.from({ length: 10 }, (_, i) => s.verificador.conferir(oferta(i), { lidoEm: Date.now() }));
      const lks = Array.from({ length: 3 }, () => s.links.requestLink({ url: URL_ITEM_A, tag: 'x', timeoutMs: 8000 }));
      for (const l of await Promise.all(lks)) assert.match(l, /^https:\/\/meli\.la\/Qa\d+$/);
      const rs = await Promise.all(conf);
      assert.ok(antiga.vistos.every((j) => j.type !== 'produto_ml'), 'a 1.4.2 nunca recebe produto_ml');
      for (const r of rs) {
        assert.ok(r.conferido === true || r.sufixo === ` · preço não conferido (${CAUSAS.extensao_antiga})`, JSON.stringify(r.sufixo));
      }
      assert.equal(nova.vistos.filter((j) => j.type === 'produto_ml').length, rs.filter((r) => r.conferido).length, 'o que foi à 1.5.0 voltou lido');
    } finally {
      const a = antiga.parar();
      await a;
    }
  });
});

// ============================================================ CA8: direct, fake e simulação seguem como hoje

test('D1 CA8: modos direct e fake e a simulação: o ML é lido pelo conferirProduto (ou confirmado sem rede) e nunca pela extensão', async () => {
  const db = openDb(tmp());
  const oferta = { loja: 'mercadolivre', url: URL_ITEM_A, price: 100, title: 'Fone' };
  for (const modo of ['direct', 'fake']) {
    const lidas = []; let pedidos = 0;
    const links = { modo: () => modo, requestProduto: async () => { pedidos++; return { price: 1, disponivel: true }; } };
    const ml = { conferirProduto: async (u) => { lidas.push(u); return { price: 100, disponivel: true }; } };
    const r = await createVerificador({ db, ml, links }).conferir(oferta, { lidoEm: Date.now() });
    assert.equal(r.conferido, true, modo);
    assert.deepEqual([lidas, pedidos], [[URL_ITEM_A], 0], modo);
  }
  let pedidos = 0;
  const simulado = createVerificador({ db, simulado: true, links: { modo: () => 'extension', requestProduto: async () => { pedidos++; return { price: 1 }; } },
    ml: { conferirProduto: async () => { throw new Error('sem rede'); } } });
  const r = await simulado.conferir(oferta, { lidoEm: Date.now() });
  assert.deepEqual([r.acao, r.conferido, pedidos], ['enviar', true, 0], 'DRY_RUN: confirma sem rede e sem extensão');
  db.close();
});

test('D2 CA8: o main em DRY_RUN (links em fake, verificador simulado): o Disparo manual do ML sai conferido sem extensão e sem leitura do servidor', async () => {
  const s = await subir({ modo: 'fake', simulado: true });
  try {
    const r = await disparar(s, URL_ITEM_A);
    assert.equal(r.status, 'concluido', r.resultado);
    assert.deepEqual(s.leituras, [], 'a simulação não lê o ML');
    assert.equal(s.links.status().online, false, 'nenhuma extensão no ar');
    assert.match(s.wa.simulated[0].text, /Preço visto às \d{2}h\d{2}/, 'confirmado sem rede, com a hora');
    assert.deepEqual(logs(s).map((l) => [l.level, l.message]), [['ok', 'Enviado com a etiqueta etiquetaA']]);
  } finally { await s.fechar(); }
});


// ================================================================ achados do seguranca e do revisor (corrigidos na rodada 1)

test('S1a CA3: uma página de produto cujo endereço final só CONTÉM "captcha" (slug ou query) não é página de verificação', () => {
  const ok = [`${ML}/teclado-anti-captcha-usb/p/MLB123456789`, `https://produto.mercadolivre.com.br/MLB-123456789-leitor-captcha-_JM`, `${ML}/produto/p/MLB123456789?x=captcha`, `${ML}/produto/p/MLB123456789?a=/gz/b`];
  for (const u of ok) assert.deepEqual(plano(X.estadoDaResposta(200, u)), { ler: true }, u);
  // e a verificação de verdade, só pelo caminho, continua valendo
  for (const u of [`${ML}/gz/account-verification?go=x`, `${ML}/captcha/validate`, `${ML}/account-verification`]) assert.deepEqual(plano(X.estadoDaResposta(200, u)), { estado: 'verificacao' }, u);
});

test('S1b CA7: só endereço de ANÚNCIO ou de catálogo do ML vai à extensão com a sessão do dono (nada de /jms/…/logout, /perfil, subdomínio de conta, ?query à vontade)', async () => {
  const links = await comExtensaoNova();
  const fora = [`${ML}/jms/mlb/lgz/logout`, `${ML}/perfil`, `${ML}/gz/account-verification`, 'https://myaccount.mercadolivre.com.br/summary', 'https://www.mercadolivre.com.br/', `${ML}/carrinho`,
    'https://mercadopago.mercadolivre.com.br/checkout/pay?pref_id=1'];
  for (const u of fora) {
    assert.deepEqual(await links.requestProduto({ url: u, timeoutMs: 50 }), { falha: 'erro' }, `não deveria ir à extensão: ${u}`);
  }
});

test('S2a CA6/D7: a pausa de 30 min sobrevive a um reinício do serviço (o `node --watch-path=src` reinicia a cada mudança em src/)', async (t) => {
  const dir = tmp();
  const s1 = await subir({ dir });
  const e1 = extensao(s1, { paginas: (url) => ({ status: 200, url: `${ML}/gz/account-verification`, html: '' }) });
  await ligada(s1);
  const c1 = await s1.verificador.conferir({ loja: 'mercadolivre', url: URL_ITEM_A, price: 100, title: 'x' }, { lidoEm: Date.now() });
  assert.equal(c1.sufixo, ` · preço não conferido (${CAUSAS.ml_verificacao})`);
  await e1.parar(); await s1.fechar();
  // o serviço reinicia sobre a mesma pasta de dados, segundos depois
  const s2 = await subir({ dir });
  const e2 = extensao(s2);
  try {
    await ligada(s2);
    const c2 = await s2.verificador.conferir({ loja: 'mercadolivre', url: URL_ITEM_A, price: 100, title: 'x' }, { lidoEm: Date.now() });
    assert.equal(e2.tipos().filter((x) => x === 'produto_ml').length, 0, 'ainda em pausa: nenhum pedido à extensão');
    assert.equal(c2.sufixo, ` · preço não conferido (${CAUSAS.ml_verificacao})`);
  } finally { await e2.parar(); await s2.fechar(); }
});

test('S2b CA6/D7: o teto de 120 por hora também sobrevive ao reinício', async () => {
  const dir = tmp();
  const oferta = { loja: 'mercadolivre', url: URL_ITEM_A, price: 100, title: 'x' };
  const s1 = await subir({ dir }); const e1 = extensao(s1); await ligada(s1);
  for (let i = 0; i < LIMITE_PRODUTO_HORA; i++) await s1.verificador.conferir(oferta, { lidoEm: Date.now() });
  await e1.parar(); await s1.fechar();
  const s2 = await subir({ dir }); const e2 = extensao(s2);
  try {
    await ligada(s2);
    const r = await s2.verificador.conferir(oferta, { lidoEm: Date.now() });
    assert.equal(r.sufixo, ` · preço não conferido (${CAUSAS.limite_hora})`, 'a hora ainda não virou');
  } finally { await e2.parar(); await s2.fechar(); }
});

/** Uma página da Central como a de verdade: metadata.id é o anúncio, product_id e o endereço são do catálogo (/p/…). */
const paginaCentral = (cards) => [{ polycard_client_model: { polycard_context: { url_prefix: 'https://' }, polycards: cards.map(([id, catalogo, titulo, preco]) => ({
  metadata: { id, product_id: catalogo, url: `www.mercadolivre.com.br/produto-${catalogo}/p/${catalogo}`, type: 'product' },
  components: [{ id: 'title', type: 'title', title: { text: titulo } }, { id: 'price', type: 'price', price: { current_price: { value: preco } } }],
})) } }];

test('R1 CA1/CA2: a regra da Central entrega /p/MLB… sem pdp_filters: com o anúncio no metadata.id a extensão lê a variante dele; sem ele, o resumo das versões só descarta (nunca confere)', async (t) => {
  const CAT_1 = 'MLB15142194'; const CAT_2 = 'MLB15142195'; const CAT_3 = 'MLB15142196';
  const html = {
    [CAT_1]: pagina(grupo([variante(ITEM_B, 71), variante(ITEM_A, 69.9)])),
    [CAT_2]: pagina(grupo([variante(ITEM_A, 69.9), variante(ITEM_B, 71)])),
    [CAT_3]: pagina(grupo([variante(ITEM_A, 150), variante(ITEM_B, 160)])),
  };
  const paginas = (url) => ({ status: 200, url, html: html[/\/p\/(MLB\d+)/.exec(url)?.[1]] ?? '' });
  await comExtensao(t, { paginas }, async (s, ext) => {
    // o anúncio do 1º é outro número (a Central dá o item); o 2º e o 3º têm só o número do catálogo, como a amostraHub
    s.links.requestOffers = async () => paginaCentral([[ITEM_A, CAT_1, 'Fritadeira A', 69.9], [CAT_2, CAT_2, 'Fritadeira B', 69.9], [CAT_3, CAT_3, 'Fritadeira C', 69.9]]);
    const id = Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run,
      interval_min, window_start, window_end, dedupe_days, send_image, created_at)
      VALUES ('Central', 1, ?, ?, ?, 'afiliados', ?, 3, 60, '00:00', '23:59', 7, 0, ?)`)
      .run(s.tag, s.tpl, JSON.stringify([G1]), JSON.stringify({ categoria: 'MLB1574', paginas: 1 }), Date.now()).lastInsertRowid);
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.messages, r.descartadas], [2, 1], JSON.stringify(r));
    const pedidos = ext.vistos.filter((x) => x.type === 'produto_ml').map((j) => j.url);
    assert.deepEqual(pedidos, [
      `${ML}/produto-${CAT_1}/p/${CAT_1}?pdp_filters=item_id:${ITEM_A}`, `${ML}/produto-${CAT_2}/p/${CAT_2}`, `${ML}/produto-${CAT_3}/p/${CAT_3}`,
    ], 'o anúncio da Central vai como pdp_filters; o número do próprio catálogo não');
    assert.match(s.wa.simulated[0].text, /Preço visto às \d{2}h\d{2}/, 'a 1ª, conferida de verdade pela variante do anúncio');
    assert.match(s.wa.simulated[0].text, /R\$ 69,90/, 'o preço da variante do anúncio (não o da outra, R$ 71)');
    assert.doesNotMatch(s.wa.simulated[1].text, /Preço visto/, 'a 2ª sai sem conferir');
    assert.deepEqual(logs(s).map((l) => [l.level, l.message.replace(/ · preço atualizado de R\$ [\d,.]+ para R\$ [\d,.]+$/, '')]), [
      ['ok', 'Enviado com a etiqueta etiquetaA'],
      ['ok', `Enviado com a etiqueta etiquetaA · preço não conferido (${CAUSAS.varias_versoes})`],
      ['aviso', 'Descartada: preço subiu de R$ 100,00 para R$ 150,00 (+50%, o limite é 5%)'],
      // a regra pediu 3 (plano rodar-sozinho-entrega1, CA1.8)
      ['aviso', 'Saíram 2 de 3 ofertas; 1 descartada (preço subiu); não havia mais ofertas novas dentro dos filtros.'],
    ]);
  });
});


// ===================================================== rodada 2: catálogo sem o anúncio no link (decisão sobre o R1)

/** Confere uma oferta do ML numa página de catálogo com `variantes`; devolve o resultado do verificador e os pedidos que a extensão viu. */
async function conferirCatalogo(t, variantes, { oferta = {}, url = URL_CAT, referencia } = {}) {
  let saida;
  await comExtensao(t, { paginas: (u) => ({ status: 200, url: u, html: pagina(grupo(variantes)) }) }, async (s, ext) => {
    const r = await s.verificador.conferir({ loja: 'mercadolivre', url, price: 100, title: 'Fritadeira', ...oferta }, { lidoEm: Date.now(), referencia });
    saida = { r, pedidos: ext.vistos.filter((j) => j.type === 'produto_ml').map((j) => j.url), leituras: s.leituras };
  });
  return saida;
}
const vs = (...precos) => precos.map((pr, i) => variante(`MLB${5000000100 + i}`, pr));

test('V1 R1: sem o anúncio no link e com todas as versões esgotadas → esgotado (descarta, não é "sem conferência")', async (t) => {
  const { r, leituras } = await conferirCatalogo(t, [variante(ITEM_A, 100, ESGOTADO), variante(ITEM_B, 100, 'SoldOut'), variante(ITEM_C, 100, 'Discontinued')]);
  assert.deepEqual([r.acao, r.motivo, r.texto], ['descartar', 'esgotado', 'Descartada: esgotado na loja']);
  assert.deepEqual(leituras, []);
});

test('V2 R1: todas à venda e a mais barata dentro do limite → sem conferência "várias versões"; nunca o preço de uma versão como o do anúncio (sem "preço atualizado", sem vistoEm)', async (t) => {
  const { r } = await conferirCatalogo(t, vs(90, 95, 99)); // oferta e referência: R$ 100
  assert.equal(r.acao, 'enviar');
  assert.equal(r.conferido, false);
  assert.equal(r.sufixo, ` · preço não conferido (${CAUSAS.varias_versoes})`);
  assert.equal(r.oferta.price, 100, 'o preço da oferta fica como veio');
  assert.equal('vistoEm' in r.oferta, false, 'sem {HORA_PRECO}');
  assert.equal(CAUSAS.varias_versoes, 'o produto tem várias versões e o link não diz qual');
});

test('V3 R1: a mais barata acima do limite descarta como "preço subiu", com o preço dela; no limite exato (5%) não descarta', async (t) => {
  const subiu = await conferirCatalogo(t, vs(110, 120, 130));
  assert.deepEqual([subiu.r.acao, subiu.r.motivo], ['descartar', 'preco_subiu']);
  assert.match(subiu.r.texto, /de R\$ 100,00 para R\$ 110,00 \(\+10%, o limite é 5%\)/);
  const limite = await conferirCatalogo(t, vs(105, 120));
  assert.deepEqual([limite.r.acao, limite.r.conferido, limite.r.sufixo], ['enviar', false, ` · preço não conferido (${CAUSAS.varias_versoes})`]);
  const passou = await conferirCatalogo(t, vs(105.01, 120));
  assert.equal(passou.r.motivo, 'preco_subiu');
});

test('V4 R1: uma versão esgotada e as outras à venda, ou uma sem offers: não descarta por esgotado nem por preço; sem conferência', async (t) => {
  const mista = await conferirCatalogo(t, [variante(ITEM_A, 100, ESGOTADO), variante(ITEM_B, 150), variante(ITEM_C, 160)]);
  assert.deepEqual([mista.r.acao, mista.r.conferido, mista.r.sufixo], ['enviar', false, ` · preço não conferido (${CAUSAS.varias_versoes})`], 'a 150 acima do limite não descarta: a esgotada é de outra versão e o resumo não diz o preço');
  const semOffers = await conferirCatalogo(t, [{ '@type': 'Product', sku: ITEM_A, name: 'A' }, variante(ITEM_B, 150)]);
  assert.deepEqual([semOffers.r.acao, semOffers.r.conferido], ['enviar', false]);
});

test('V5 R1: com 30 variantes a lista pode estar cortada: nem "todas esgotadas" vale como esgotado', async (t) => {
  const trinta = Array.from({ length: 30 }, (_, i) => variante(`MLB${5000000200 + i}`, 100, ESGOTADO));
  const { r } = await conferirCatalogo(t, trinta);
  assert.deepEqual([r.acao, r.conferido], ['enviar', false]);
  const vinteENove = Array.from({ length: 29 }, (_, i) => variante(`MLB${5000000200 + i}`, 100, ESGOTADO));
  assert.equal((await conferirCatalogo(t, vinteENove)).r.motivo, 'esgotado', 'com 29, a lista está inteira');
});

test('V6 R1: o anúncio da oferta (item_id ou key = MLB do anúncio) vai à extensão como pdp_filters e dá a variante dele; o MLB do próprio catálogo não vira filtro', async (t) => {
  const variantes = [variante(ITEM_A, 154.99), variante(ITEM_B, 100)];
  const comItem = await conferirCatalogo(t, variantes, { oferta: { key: ITEM_B } });
  assert.deepEqual(comItem.pedidos, [`${URL_CAT}?pdp_filters=item_id:${ITEM_B}`]);
  assert.equal(comItem.r.conferido, true); assert.equal(comItem.r.sufixo, null);
  const porItemId = await conferirCatalogo(t, variantes, { oferta: { item_id: ITEM_A, price: 154.99 } });
  assert.deepEqual(porItemId.pedidos, [`${URL_CAT}?pdp_filters=item_id:${ITEM_A}`]);
  assert.equal(porItemId.r.conferido, true);
  const doCatalogo = await conferirCatalogo(t, variantes, { oferta: { key: 'MLB15142194' } });
  assert.deepEqual(doCatalogo.pedidos, [URL_CAT], 'o número do catálogo não é um anúncio');
  assert.equal(doCatalogo.r.sufixo, ` · preço não conferido (${CAUSAS.varias_versoes})`);
  // o filtro que já está na URL manda mais que o item da oferta
  const filtrada = await conferirCatalogo(t, variantes, { url: `${URL_CAT}?pdp_filters=item_id:${ITEM_A}`, oferta: { key: ITEM_B, price: 154.99 } });
  assert.deepEqual(filtrada.pedidos, [`${URL_CAT}?pdp_filters=item_id:${ITEM_A}`]);
});

test('V7 R1: com o anúncio informado mas fora da página (esgotado e removido da lista), nunca o resumo das outras versões: "a página não trouxe o preço"', async (t) => {
  const { r } = await conferirCatalogo(t, vs(50, 60), { oferta: { key: ITEM_C } });
  assert.deepEqual([r.acao, r.conferido, r.sufixo], ['enviar', false, ` · preço não conferido (${CAUSAS.sem_preco})`]);
});

test('V8 R1: regra do Catálogo, item com anúncio cuja variante não está na página: vai à revisão (sem preço), sem erro e sem tomar o preço de outra versão', async (t) => {
  const html = pagina(grupo(vs(90, 95)));
  await comExtensao(t, { paginas: (u) => ({ status: 200, url: u, html }) }, async (s, ext) => {
    const of = { id: 5257531512, loja: 'ml', titulo: 'Produto X', preco: 100, preco_antigo: 300, desconto_pct: 66, categoria: 'Casa', item_id: 'MLB5257531512', link: 'https://meli.la/TerCeiro1' };
    s.servicos.catalogo.candidatos = async (cfg, { tratada }) => [of].map(paraCandidato).filter((c) => c && !tratada(c, cfg.ordem));
    const id = Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
      sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
      VALUES ('Catálogo', 1, ?, ?, ?, 'list', '{}', ?, 5, 60, '00:00', '23:59', 7, 0, ?)`)
      .run(s.tag, s.tpl, JSON.stringify([G1]), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }]), Date.now()).lastInsertRowid);
    const r = await s.scheduler.runRule(id);
    // o item do catálogo tem anúncio (MLB5257531512) e URL de anúncio: não há resumo; sem a variante dele na página, "sem preço" → revisão
    assert.deepEqual([r.offers, r.errors, r.revisao], [0, 0, 1]);
    assert.ok(!logs(s).some((l) => l.level === 'erro'));
  });
});
