// Rodar sozinho, entrega 2, etapa 1 (docs/produto/planos/rodar-sozinho-entrega2.md, Decisão 1 a 3; ADR-015): o estado
// da Central de Afiliados no serviço de links (src/links.js). Falhas seguidas, espera depois de 3, teste pelo próximo
// pedido real a cada 5 min, persistência em `settings.ml_central`, linhas de abrir e fechar a espera no Histórico,
// `ErroLinkML` com a classe e a causa da falha, prazo de 45 s, versão da extensão (`x-versao`) e `produtoDisponivel()`.
// Sem rede: a "extensão" é o próprio teste chamando poll/submit, ou as rotas HTTP com um token de teste.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  createLinkService, ErroLinkML, FALHAS_PARA_ESPERA, TESTE_ESPERA_MIN, PRAZO_LINK_MS, VERSAO_EXTENSAO, RECUSAS_DEFINITIVAS,
  TIPOS_ERRO_EXTENSAO, CAUSAS_CENTRAL, MAX_DETALHE, classificarFalhaLink, lerVersao, textoEsperaAberta, textoEsperaFechada,
  LIMITE_PRODUTO_HORA,
} from '../src/links.js';
import { openDb, setSetting, getSetting } from '../src/db.js';
import { buildApp, criarServicos } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };
test.after(() => assert.equal(acessosRede, 0, 'nenhum teste acessa a rede'));

const MIN = 60 * 1000;
const URL_ML = 'https://produto.mercadolivre.com.br/MLB-5257531512-fritadeira-boa-_JM';
const MELI = 'https://meli.la/2AbCdEf';
const RECURSO = { recursos: 'produto_ml', versao: '1.6.0' };
const LIDO = { estado: 'lido', ofertas: [{ nome: true, price: 89.9, availability: 'https://schema.org/InStock' }] };
const SEM_RESPOSTA = { ok: false, error: 'a Central de Afiliados do Mercado Livre não respondeu a tempo', tipo: 'sem_resposta' };
const PAUSADO = { ok: false, error: 'The article must be active, status: paused (etiqueta "minha")', tipo: 'recusa' };

const pastas = [];
test.after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });

/** Promessa que nunca rejeita sem tratamento: devolve { valor } ou { erro }. */
const resultado = (p) => p.then((valor) => ({ valor }), (erro) => ({ erro }));

/** Relógio manual (agora) do estado da Central. */
function relogio(inicio = 1_786_000_000_000) {
  const r = { t: inicio, agora: () => r.t };
  return r;
}

function banco() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-central-')); pastas.push(dir);
  return openDb(dir);
}

/** Linhas do Histórico gravadas pelo serviço de links (sem regra). */
const linhas = (db) => db.prepare('SELECT level, message FROM log ORDER BY id').all().map((l) => ({ ...l }));

/** Serviço no modo extension, com a extensão "on-line" (um poll curto que termina vazio). */
async function servico(opcoes = {}) {
  const links = createLinkService({ getMode: () => 'extension', ...opcoes });
  assert.equal(await links.poll(0, RECURSO), null);
  return links;
}

/** A extensão pega o próximo pedido e responde; devolve o pedido visto e o resultado de quem pediu. */
async function comExtensao(links, pedir, resposta) {
  const proximo = links.poll(2000, RECURSO);
  const r = resultado(pedir());
  const job = await proximo;
  assert.ok(job, 'a extensão recebeu um pedido');
  assert.equal(links.submit(job.id, resposta), true);
  return { job, ...(await r) };
}

const pedirLink = (links) => () => links.requestLink({ url: URL_ML, tag: 'minha', timeoutMs: 5000 });

/** O pedido é recusado na hora, sem chegar à extensão (o poll curto termina vazio). */
async function semPedido(links, pedir) {
  const proximo = links.poll(30, RECURSO);
  const r = await resultado(pedir());
  assert.equal(await proximo, null, 'nada foi entregue à extensão');
  assert.equal(links.status().pending, 0, 'nada ficou na fila');
  return r;
}

/** `n` falhas passageiras seguidas do link (a Central não respondeu). */
async function falhar(links, n, resposta = SEM_RESPOSTA) {
  for (let i = 0; i < n; i++) {
    const { erro } = await comExtensao(links, pedirLink(links), resposta);
    assert.ok(erro instanceof ErroLinkML);
  }
}

test('central: constantes do plano (D3, Decisão 1 a 3)', () => {
  assert.deepEqual([FALHAS_PARA_ESPERA, TESTE_ESPERA_MIN, PRAZO_LINK_MS, VERSAO_EXTENSAO, MAX_DETALHE], [3, 5, 45000, '1.6.0', 160]);
  assert.deepEqual([...TIPOS_ERRO_EXTENSAO], ['recusa', 'sessao', 'sem_resposta', 'aba', 'http', 'formato']);
  assert.ok(Object.isFrozen(TIPOS_ERRO_EXTENSAO) && Object.isFrozen(RECUSAS_DEFINITIVAS) && Object.isFrozen(CAUSAS_CENTRAL));
  assert.deepEqual(RECUSAS_DEFINITIVAS.map((r) => r.causa), ['anuncio_inativo']);
  assert.deepEqual(CAUSAS_CENTRAL, {
    central_sem_resposta: 'a Central de Afiliados não respondeu',
    central_aba: 'não deu para abrir a Central de Afiliados no Chrome',
    central_login: 'a Central de Afiliados pediu login',
    anuncio_inativo: 'o anúncio está pausado ou inativo',
    recusa_ml: 'o Mercado Livre recusou gerar o link',
  });
});

test('central: classificação da falha pelo tipo (extensão 1.6.0) e pelo texto (extensão antiga)', () => {
  const casos = [
    // recusa definitiva: só pela lista, com ou sem tipo
    ['The article must be active, status: paused (etiqueta "x")', 'recusa', 'recusa', 'anuncio_inativo'],
    ['item status: closed', undefined, 'recusa', 'anuncio_inativo'],
    ['Status:   INACTIVE', 'http', 'recusa', 'anuncio_inativo'],
    ['the item must be active', undefined, 'recusa', 'anuncio_inativo'],
    // recusa que não casa com a lista (D6): falha da oferta
    ['Invalid tag', 'recusa', 'passageira', 'recusa_ml'],
    ['o Mercado Livre recusou o link (etiqueta "x")', undefined, 'passageira', 'recusa_ml'],
    ['status: active', 'recusa', 'passageira', 'recusa_ml'],
    // tipo da extensão nova
    ['qualquer coisa', 'sessao', 'passageira', 'central_login'],
    ['Could not establish connection. Receiving end does not exist.', 'aba', 'passageira', 'central_aba'],
    ['qualquer coisa', 'sem_resposta', 'passageira', 'central_sem_resposta'],
    ['a Central de Afiliados respondeu HTTP 502', 'http', 'passageira', 'central_sem_resposta'],
    ['a Central de Afiliados respondeu algo que não é JSON', 'formato', 'passageira', 'central_sem_resposta'],
    // textos da extensão 1.5.0
    ['não há sessão de afiliado neste Chrome. Entre na sua conta da Central de Afiliados do Mercado Livre', undefined, 'passageira', 'central_login'],
    ['não consegui abrir a Central de Afiliados', undefined, 'passageira', 'central_aba'],
    ['a Central de Afiliados do Mercado Livre não respondeu a tempo. A extensão recarrega a aba e tenta de novo no próximo pedido', undefined, 'passageira', 'central_sem_resposta'],
    ['resposta sem link (etiqueta "x")', undefined, 'passageira', 'central_sem_resposta'],
    ['a Central de Afiliados respondeu HTTP 500', undefined, 'passageira', 'central_sem_resposta'],
    ['', undefined, 'passageira', 'central_sem_resposta'],
    [undefined, undefined, 'passageira', 'central_sem_resposta'],
    // tipo fora da lista fechada é ignorado: vale o texto
    ['não há sessão de afiliado neste Chrome', 'xss<script>', 'passageira', 'central_login'],
    ['qualquer', { toString: () => 'sessao' }, 'passageira', 'central_sem_resposta'],
  ];
  for (const [texto, tipo, classe, causa] of casos) {
    assert.deepEqual(classificarFalhaLink(texto, tipo), { classe, causa }, `${texto} / ${String(tipo)}`);
  }
  // a lista de ofertas nunca é "recusa definitiva"
  assert.deepEqual(classificarFalhaLink('must be active', 'recusa', { recusaPossivel: false }), { classe: 'passageira', causa: 'central_sem_resposta' });
});

test('CA2.1: falha passageira sai como ErroLinkML passageira, com a causa e o detalhe limpo; a mensagem é a de antes', async () => {
  const links = await servico();
  const { erro } = await comExtensao(links, pedirLink(links), { ok: false, error: 'não há sessão de afiliado neste Chrome', tipo: 'sessao' });
  assert.ok(erro instanceof ErroLinkML && erro instanceof Error);
  assert.deepEqual([erro.name, erro.classe, erro.causa, erro.detalhe, erro.message],
    ['ErroLinkML', 'passageira', 'central_login', 'não há sessão de afiliado neste Chrome', 'não há sessão de afiliado neste Chrome']);
  // link fora de meli.la: falha passageira (a Central ou a extensão devolveu lixo)
  const lixo = await comExtensao(links, pedirLink(links), { ok: true, link: 'https://golpe.example/x' });
  assert.deepEqual([lixo.erro.classe, lixo.erro.causa], ['passageira', 'central_sem_resposta']);
  assert.match(lixo.erro.message, /não é meli\.la; recusado/);
  // um link certo zera a contagem (senão a 3ª falha abriria a espera e as seguintes nem chegariam à extensão)
  await comExtensao(links, pedirLink(links), { ok: true, link: MELI });
  // detalhe: sem caracteres de controle nem de formatação, cortado em 160 com reticências; a mensagem segue com 300
  const sujo = `linha1\nlinha2\u0000\u202Etrocado\u200B ${'x'.repeat(400)}`;
  const longo = await comExtensao(links, pedirLink(links), { ok: false, error: sujo, tipo: 'http' });
  assert.equal(longo.erro.detalhe.length, MAX_DETALHE);
  assert.ok(longo.erro.detalhe.endsWith('…'));
  assert.match(longo.erro.detalhe, /^linha1 linha2 trocado x+…$/);
  assert.equal(longo.erro.message.length, 300);
  // par substituto não é partido no corte
  const emoji = await comExtensao(links, pedirLink(links), { ok: false, error: `${'a'.repeat(158)}😀😀`, tipo: 'http' });
  assert.equal(emoji.erro.detalhe, `${'a'.repeat(158)}…`);
  assert.equal(links.central().ultimoErro, emoji.erro.detalhe, 'o último erro é o detalhe limpo');
});

test('CA2.1: o prazo do link é de 45 s; o pedido sai da fila e a resposta atrasada é ignorada', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const links = createLinkService({ getMode: () => 'extension' });
  const fim = links.poll(0, RECURSO); t.mock.timers.tick(0);
  assert.equal(await fim, null);
  const r = resultado(links.requestLink({ url: URL_ML, tag: 'minha' }));
  const job = await links.poll(0, RECURSO);
  assert.equal(job.type, 'link');
  t.mock.timers.tick(PRAZO_LINK_MS - 1);
  assert.equal(links.central().falhasSeguidas, 0, 'ainda espera em 44,999 s');
  t.mock.timers.tick(1);
  const { erro } = await r;
  assert.ok(erro instanceof ErroLinkML);
  assert.deepEqual([erro.classe, erro.causa, erro.tempo, erro.message], ['passageira', 'central_sem_resposta', true, 'a extensão não respondeu a tempo']);
  assert.equal(links.submit(job.id, { ok: true, link: MELI }), false, 'a resposta depois do prazo não vale');
  assert.equal(links.central().falhasSeguidas, 1, 'o pedido entregue que não voltou conta');
});

test('central (caso de 10/11): poll vivo e três pedidos entregues sem resposta abrem a espera; a extensão segue conectada', async () => {
  const links = await servico();
  for (let i = 0; i < 3; i++) {
    const proximo = links.poll(2000, RECURSO);
    const r = resultado(links.requestLink({ url: URL_ML, tag: 'minha', timeoutMs: 5 }));
    assert.equal((await proximo).type, 'link', 'entregue');
    assert.equal((await r).erro.tempo, true);
  }
  const st = links.status();
  assert.deepEqual([st.online, st.central.estado, st.central.ultimoErro], [true, 'em_espera', 'a extensão não respondeu a tempo']);
});

test('central: pedido que expira sem ter sido entregue à extensão não conta (nenhum pedido saiu)', async () => {
  const links = await servico();
  for (let i = 0; i < 5; i++) {
    const { erro } = await resultado(links.requestLink({ url: URL_ML, tag: 'minha', timeoutMs: 5 }));
    assert.deepEqual([erro.classe, erro.causa], ['passageira', 'central_sem_resposta'], 'on-line: falha passageira da oferta');
  }
  assert.equal(links.central().falhasSeguidas, 0);
  assert.equal(links.central().estado, 'sem_teste');
});

test('CA2.2: recusa definitiva (anúncio pausado) sai como recusa, não conta para a espera e fecha a espera aberta', async () => {
  const db = banco();
  const rel = relogio();
  const links = await servico({ db, agora: rel.agora });
  await falhar(links, 2);
  const { erro } = await comExtensao(links, pedirLink(links), PAUSADO);
  assert.deepEqual([erro.classe, erro.causa], ['recusa', 'anuncio_inativo']);
  assert.match(erro.detalhe, /must be active, status: paused/);
  assert.equal(links.central().falhasSeguidas, 0, 'a Central respondeu: a contagem zera');
  assert.equal(links.central().ultimoOkEm, 0, 'recusa não é link gerado');
  // abre a espera e libera o teste: a recusa no teste fecha a espera
  await falhar(links, 3);
  assert.equal(links.central().estado, 'em_espera');
  rel.t += TESTE_ESPERA_MIN * MIN;
  const teste = await comExtensao(links, pedirLink(links), { ok: false, error: 'Item status: closed' });
  assert.equal(teste.erro.classe, 'recusa');
  const c = links.central();
  assert.deepEqual([c.estado, c.falhasSeguidas, c.emEsperaDesde, c.proximoTesteEm], ['respondendo', 0, null, null]);
  assert.deepEqual(linhas(db).map((l) => l.level), ['aviso', 'info'], 'abriu e fechou');
  assert.match(linhas(db)[1].message, /^Mercado Livre voltou: /);
  db.close();
});

test('CA2.2/D6/S2: recusa que não casa com a lista é falha da OFERTA (passageira, recusa_ml), mas a Central respondeu: zera a contagem e fecha a espera', async () => {
  const db = banco();
  const rel = relogio();
  const links = await servico({ db, agora: rel.agora });
  // pelo tipo da extensão 1.6.0 e pelo texto da antiga: nenhuma das duas conta para a espera
  for (const resposta of [{ ok: false, error: 'Invalid tag (etiqueta "x")', tipo: 'recusa' }, { ok: false, error: 'Erro qualquer do ML (etiqueta "x")' }]) {
    await falhar(links, 2);
    const { erro } = await comExtensao(links, pedirLink(links), resposta);
    assert.deepEqual([erro.classe, erro.causa], ['passageira', 'recusa_ml'], 'o agendador conta para a oferta (D6)');
    assert.equal(links.central().falhasSeguidas, 0, 'a Central respondeu: a contagem zera');
  }
  // três recusas seguidas não abrem a espera
  await falhar(links, 3, { ok: false, error: 'Invalid tag (etiqueta "x")', tipo: 'recusa' });
  assert.equal(links.central().estado, 'respondendo');
  assert.equal(links.central().ultimoOkEm, 0, 'recusa não é link gerado');
  // a espera aberta fecha com a recusa no teste (linha info), sem gravar ultimoOkEm
  await falhar(links, 3);
  assert.equal(links.central().estado, 'em_espera');
  rel.t += TESTE_ESPERA_MIN * MIN;
  const teste = await comExtensao(links, pedirLink(links), { ok: false, error: 'Invalid tag', tipo: 'recusa' });
  assert.deepEqual([teste.erro.classe, teste.erro.causa], ['passageira', 'recusa_ml']);
  const c = links.central();
  assert.deepEqual([c.estado, c.falhasSeguidas, c.emEsperaDesde, c.proximoTesteEm, c.ultimoOkEm], ['respondendo', 0, null, null, 0]);
  assert.deepEqual(linhas(db).map((l) => l.level), ['aviso', 'info'], 'abriu e fechou');
  // a lista de ofertas nunca é recusa: o mesmo texto conta como falha da Central
  const pedirLista = () => links.requestOffers({ paginas: [{}], timeoutMs: 5000 });
  const lista = await comExtensao(links, pedirLista, { ok: false, error: 'Invalid tag (etiqueta "x")', tipo: 'recusa' });
  assert.deepEqual([lista.erro.classe, lista.erro.causa], ['passageira', 'central_sem_resposta']);
  assert.equal(links.central().falhasSeguidas, 1);
  db.close();
});

test('CA2.4: três falhas seguidas abrem a espera (linha aviso); com ela aberta, link e lista são recusados na hora, sem pedido', async () => {
  const db = banco();
  const rel = relogio();
  const links = await servico({ db, agora: rel.agora });
  await falhar(links, 2);
  assert.equal(links.central().estado, 'falhando');
  assert.deepEqual(linhas(db), [], 'duas falhas: nenhuma linha');
  rel.t += 1000;
  await falhar(links, 1);
  const c = links.central();
  assert.deepEqual([c.estado, c.falhasSeguidas, c.emEsperaDesde, c.proximoTesteEm, c.testeLiberado],
    ['em_espera', 3, rel.t, rel.t + 5 * MIN, false]);
  assert.deepEqual(linhas(db), [{ level: 'aviso', message: textoEsperaAberta('central_sem_resposta') }]);
  assert.equal(textoEsperaAberta('central_sem_resposta'),
    'Mercado Livre em espera: a Central de Afiliados não respondeu 3 vezes seguidas. As ofertas do Mercado Livre esperam e o programa testa de novo em 5 min.');
  // as outras causas ficam entre parênteses (achado D6: só a "sem resposta" repetia o sujeito); causa desconhecida → sem resposta
  assert.equal(textoEsperaAberta('central_login'),
    'Mercado Livre em espera: a Central de Afiliados falhou 3 vezes seguidas (a Central de Afiliados pediu login). As ofertas do Mercado Livre esperam e o programa testa de novo em 5 min.');
  assert.match(textoEsperaAberta('central_aba'), /falhou 3 vezes seguidas \(não deu para abrir a Central de Afiliados no Chrome\)\. /);
  for (const outra of [undefined, 'toString', 'qualquer']) assert.equal(textoEsperaAberta(outra), textoEsperaAberta('central_sem_resposta'));
  // link e lista: recusa na hora, classe espera, nada na fila
  for (const pedir of [pedirLink(links), () => links.requestOffers({ paginas: [{}], timeoutMs: 5000 })]) {
    const { erro, valor } = await semPedido(links, pedir);
    assert.equal(valor, undefined, 'nunca devolve um link (nem o endereço comum)');
    assert.ok(erro instanceof ErroLinkML);
    assert.deepEqual([erro.classe, erro.causa, erro.detalhe], ['espera', 'central_sem_resposta', '']);
    assert.match(erro.message, /Mercado Livre está em espera/);
  }
  rel.t += 5 * MIN - 1001;
  await semPedido(links, pedirLink(links));
  assert.equal(links.central().falhasSeguidas, 3, 'a recusa da espera não conta');
  assert.equal(linhas(db).length, 1, 'uma linha por mudança, não por pedido');
  db.close();
});

test('CA2.4: teste liberado depois de 5 min: um só pedido passa; a falha no teste empurra o próximo e não grava linha', async () => {
  const db = banco();
  const rel = relogio();
  const links = await servico({ db, agora: rel.agora });
  await falhar(links, 3);
  const aberta = rel.t;
  rel.t += 5 * MIN;
  assert.equal(links.central().testeLiberado, true);
  assert.equal(links.central().testeLiberado, true, 'central() não gasta o teste');
  // o primeiro pedido é o teste; o segundo, ao mesmo tempo, é recusado na hora
  const proximo = links.poll(2000, RECURSO);
  const teste = resultado(pedirLink(links)());
  const outro = await resultado(pedirLink(links)());
  assert.equal(outro.erro.classe, 'espera');
  const job = await proximo;
  assert.equal(job.type, 'link');
  assert.equal(links.status().pending, 0, 'só o teste foi à extensão');
  assert.equal(links.central().proximoTesteEm, rel.t + 5 * MIN, 'o teste empurra o próximo');
  assert.equal(createLinkService({ getMode: () => 'extension', db, agora: rel.agora }).central().testeLiberado, false,
    'o teste gasto é gravado: um reinício agora não libera outro');
  rel.t += 30 * 1000;
  links.submit(job.id, SEM_RESPOSTA);
  assert.equal((await teste).erro.classe, 'passageira');
  const c = links.central();
  assert.deepEqual([c.estado, c.falhasSeguidas, c.emEsperaDesde, c.proximoTesteEm], ['em_espera', 4, aberta, rel.t + 5 * MIN], 'a falha empurra o teste');
  assert.equal(linhas(db).length, 1, 'teste que falha não grava linha');
  // teste liberado com a extensão fora: desconectada, sem gastar o teste
  rel.t += 5 * MIN;
  const fora = createLinkService({ getMode: () => 'extension', db, agora: rel.agora });
  const { erro } = await resultado(pedirLink(fora)());
  assert.deepEqual([erro.classe, erro.causa], ['desconectada', 'extensao_off']);
  assert.match(erro.message, /não está conectada/);
  assert.equal(fora.central().testeLiberado, true, 'o teste continua liberado');
  db.close();
});

test('CA2.4: o teste que dá certo fecha a espera (linha info com o tempo) e as ofertas voltam sem ação', async () => {
  const db = banco();
  const rel = relogio();
  const links = await servico({ db, agora: rel.agora });
  await falhar(links, 3);
  rel.t += 80 * MIN;
  const { valor } = await comExtensao(links, pedirLink(links), { ok: true, link: MELI });
  assert.equal(valor, MELI);
  const c = links.central();
  assert.deepEqual([c.estado, c.falhasSeguidas, c.emEsperaDesde, c.proximoTesteEm, c.ultimoOkEm], ['respondendo', 0, null, null, rel.t]);
  assert.deepEqual(linhas(db).at(-1), { level: 'info', message: textoEsperaFechada(80 * MIN) });
  assert.equal(textoEsperaFechada(80 * MIN),
    'Mercado Livre voltou: a Central de Afiliados respondeu ao teste (esteve em espera por 1 h 20 min). As ofertas do Mercado Livre saem no próximo envio.');
  assert.match(textoEsperaFechada(25 * MIN), /por 25 min\)/);
  assert.match(textoEsperaFechada(2 * 60 * MIN), /por 2 h\)/);
  assert.match(textoEsperaFechada(20 * 1000), /por menos de 1 min\)/);
  assert.ok(linhas(db).every((l) => l.level !== 'erro'), 'nunca erro (erro dispara aviso no WhatsApp)');
  // o pedido seguinte vai direto
  const depois = await comExtensao(links, pedirLink(links), { ok: true, link: 'https://meli.la/OutroLk' });
  assert.equal(depois.valor, 'https://meli.la/OutroLk');
  db.close();
});

test('CA2.4: a lista de ofertas conta e fecha como o link', async () => {
  const links = await servico();
  const pedirLista = () => links.requestOffers({ paginas: [{}], timeoutMs: 5000 });
  for (let i = 0; i < 2; i++) {
    const { erro } = await comExtensao(links, pedirLista, { ok: false, error: 'a Central de Afiliados mudou o formato da lista', tipo: 'formato' });
    assert.deepEqual([erro.classe, erro.causa], ['passageira', 'central_sem_resposta']);
  }
  const lixo = await comExtensao(links, pedirLista, { ok: true, data: 'não é lista' });
  assert.equal(lixo.erro.classe, 'passageira');
  assert.equal(links.central().estado, 'em_espera');
});

test('central: só o produto_ml que estourou o prazo conta; o erro da página é neutro (R2/Q1); lido não fecha a espera; verificação, desconectada e antiga são neutras', async () => {
  const rel = relogio();
  const links = await servico({ agora: rel.agora });
  const produto = async (resposta) => {
    const r = links.requestProduto({ url: URL_ML });
    const job = await links.poll(2000, RECURSO);
    assert.equal(job.type, 'produto_ml');
    links.submit(job.id, resposta);
    return r;
  };
  // a página do produto não passa pela Central: erro dela (404 de anúncio que saiu, 500, página grande, rede) ou resposta
  // fora do formato não conta, nem três seguidas
  for (const resposta of [{ ok: false, error: 'a página do produto respondeu HTTP 404' }, { ok: false, error: 'a página do produto respondeu HTTP 500' },
    { ok: false, error: 'a página do produto é grande demais' }, { ok: false }, { ok: true, data: { estado: 'outro' } }]) {
    assert.deepEqual(await produto(resposta), { falha: 'erro' });
  }
  assert.deepEqual([links.central().falhasSeguidas, links.central().estado, links.central().ultimoErro], [0, 'sem_teste', ''], 'erro da página é neutro');
  await falhar(links, 1);
  assert.deepEqual(await produto({ ok: false, error: 'a página do produto respondeu HTTP 404' }), { falha: 'erro' });
  assert.equal(links.central().falhasSeguidas, 1, 'o erro da página também não zera a contagem');
  assert.deepEqual(await produto({ ok: true, data: LIDO }), { price: 89.9, disponivel: true });
  assert.equal(links.central().falhasSeguidas, 1, 'produto lido é neutro');
  // tempo (entregue e sem resposta)
  const r = links.requestProduto({ url: URL_ML, timeoutMs: 5 });
  assert.equal((await links.poll(2000, RECURSO)).type, 'produto_ml');
  assert.deepEqual(await r, { falha: 'tempo' });
  assert.equal(links.central().falhasSeguidas, 2);
  // verificação: neutra
  assert.deepEqual(await produto({ ok: true, data: { estado: 'verificacao' } }), { falha: 'verificacao' });
  assert.equal(links.central().falhasSeguidas, 2);
  // a 3ª (link) abre a espera; um produto lido com a espera aberta não fecha
  await falhar(links, 1);
  assert.equal(links.central().estado, 'em_espera');
  rel.t += 31 * MIN; // fim da pausa da verificação
  await links.poll(0, RECURSO);
  assert.deepEqual(await produto({ ok: true, data: LIDO }), { price: 89.9, disponivel: true });
  assert.equal(links.central().estado, 'em_espera', 'produto_ml ok com createLink falhando não fecha a espera');
  // desconectada e antiga: sem pedido, sem contar
  const antes = links.central().falhasSeguidas;
  const off = createLinkService({ getMode: () => 'extension', agora: rel.agora });
  assert.deepEqual(await off.requestProduto({ url: URL_ML }), { falha: 'desconectada' });
  await links.poll(0, {});
  assert.deepEqual(await links.requestProduto({ url: URL_ML }), { falha: 'antiga' });
  assert.equal(links.central().falhasSeguidas, antes);
});

test('central: produtoDisponivel() diz por que o produto_ml não sairia agora, sem pedido', async () => {
  const rel = relogio();
  const off = createLinkService({ getMode: () => 'extension', agora: rel.agora });
  assert.equal(off.produtoDisponivel(), 'desconectada');
  const links = await servico({ agora: rel.agora });
  assert.equal(links.produtoDisponivel(), null);
  await links.poll(0, {});
  assert.equal(links.produtoDisponivel(), 'antiga');
  await links.poll(0, RECURSO);
  // verificação: pausa de 30 min
  const r = links.requestProduto({ url: URL_ML });
  const job = await links.poll(2000, RECURSO);
  links.submit(job.id, { ok: true, data: { estado: 'verificacao' } });
  await r;
  assert.equal(links.produtoDisponivel(), 'verificacao');
  assert.equal(links.status().pending, 0);
  // limite por hora
  rel.t += 31 * MIN;
  for (let i = 0; i < LIMITE_PRODUTO_HORA - 1; i++) {
    const p = links.requestProduto({ url: URL_ML });
    const j = await links.poll(2000, RECURSO);
    links.submit(j.id, { ok: true, data: LIDO });
    await p;
  }
  assert.equal(links.produtoDisponivel(), 'limite');
  assert.deepEqual(await links.requestProduto({ url: URL_ML }), { falha: 'limite' });
  // nenhuma consulta foi à fila
  for (let i = 0; i < 3; i++) links.produtoDisponivel();
  assert.equal(links.status().pending, 0);
});

test('CA2.5: status() traz central (estado e horas), versao, versaoEsperada e desatualizada', async () => {
  const rel = relogio();
  const links = await servico({ agora: rel.agora });
  let st = links.status();
  assert.deepEqual(st.central, { estado: 'sem_teste', falhasSeguidas: 0, ultimoOkEm: 0, ultimoErroEm: 0, ultimoErro: '', emEsperaDesde: null, proximoTesteEm: null });
  assert.deepEqual([st.versao, st.versaoEsperada, st.desatualizada], ['1.6.0', '1.6.0', false]);
  await comExtensao(links, pedirLink(links), { ok: true, link: MELI });
  const ok = rel.t;
  assert.deepEqual([links.status().central.estado, links.status().central.ultimoOkEm], ['respondendo', ok]);
  rel.t += MIN;
  await falhar(links, 1);
  st = links.status();
  assert.deepEqual({ ...st.central }, {
    estado: 'falhando', falhasSeguidas: 1, ultimoOkEm: ok, ultimoErroEm: rel.t,
    ultimoErro: SEM_RESPOSTA.error, emEsperaDesde: null, proximoTesteEm: null,
  });
  assert.equal('testeLiberado' in st.central, false, 'testeLiberado só em central()');
  // os campos antigos continuam (o painel de hoje usa)
  assert.ok(st.lastOkAt > 0 && st.lastError === SEM_RESPOSTA.error && st.online === true && 'shopeeLastOkAt' in st);
  assert.deepEqual(links.central(), { ...st.central, testeLiberado: false });
});

test('CA2.16: sem x-versao ou com 1.5.0 → desatualizada; 1.6.0 ou mais nova → não; fora do formato vira null; off-line nunca', async () => {
  const casos = [
    [undefined, null, true], ['1.5.0', '1.5.0', true], ['1.5.9', '1.5.9', true], ['0.9.99', '0.9.99', true],
    ['1.6.0', '1.6.0', false], ['1.6.1', '1.6.1', false], ['1.10.0', '1.10.0', false], ['2.0.0', '2.0.0', false],
    ['1.6', null, true], ['1.6.0-beta', null, true], [' 1.6.0', null, true], ['1000.0.0', null, true], ['1.6.0\n', null, true],
    ['<b>1.6.0</b>', null, true], [160, null, true], [['1.6.0'], null, true], ['', null, true],
  ];
  for (const [versao, lida, desatualizada] of casos) {
    const links = createLinkService({ getMode: () => 'extension' });
    assert.equal(links.status().desatualizada, false, 'off-line: sem informação');
    assert.equal(await links.poll(0, { recursos: 'produto_ml', versao }), null);
    const st = links.status();
    assert.deepEqual([st.versao, st.versaoEsperada, st.desatualizada], [lida, '1.6.0', desatualizada], String(versao));
    assert.equal(lerVersao(versao), lida);
  }
  // o poll seguinte sem versão apaga a anterior
  const links = await servico();
  assert.equal(links.status().versao, '1.6.0');
  await links.poll(0, { recursos: 'produto_ml' });
  assert.deepEqual([links.status().versao, links.status().desatualizada], [null, true]);
});

test('CA2.6: último sucesso, último erro e a espera sobrevivem a um serviço novo sobre o mesmo banco', async () => {
  const db = banco();
  const rel = relogio();
  const a = await servico({ db, agora: rel.agora });
  await comExtensao(a, pedirLink(a), { ok: true, link: MELI });
  const ok = rel.t;
  rel.t += MIN;
  await falhar(a, 1, { ok: false, error: 'a Central de Afiliados respondeu HTTP 503', tipo: 'http' });
  const b = createLinkService({ getMode: () => 'extension', db, agora: rel.agora });
  assert.deepEqual({ ...b.status().central }, {
    estado: 'falhando', falhasSeguidas: 1, ultimoOkEm: ok, ultimoErroEm: rel.t,
    ultimoErro: 'a Central de Afiliados respondeu HTTP 503', emEsperaDesde: null, proximoTesteEm: null,
  });
  // reinício com a espera aberta: mantém a espera e o horário do teste
  await b.poll(0, RECURSO);
  await falhar(b, 2);
  const aberta = { ...b.central() };
  assert.equal(aberta.estado, 'em_espera');
  rel.t += 2 * MIN;
  const c = createLinkService({ getMode: () => 'extension', db, agora: rel.agora });
  assert.deepEqual(c.central(), aberta);
  await c.poll(0, RECURSO);
  await semPedido(c, pedirLink(c));
  rel.t += 3 * MIN;
  assert.equal(c.central().testeLiberado, true);
  assert.equal(JSON.parse(getSetting(db, 'ml_central')).emEsperaDesde, aberta.emEsperaDesde);
  // nada além do formato do plano vai para o banco
  assert.deepEqual(Object.keys(JSON.parse(getSetting(db, 'ml_central'))).sort(),
    ['emEsperaDesde', 'falhasSeguidas', 'proximoTesteEm', 'ultimoErro', 'ultimoErroEm', 'ultimoOkEm']);
  db.close();
});

test('CA2.6: o que está gravado é dado de fora: lixo vira estado vazio, nada fica no futuro e o teste nunca passa de 5 min', async () => {
  const db = banco();
  const rel = relogio();
  const vazio = { estado: 'sem_teste', falhasSeguidas: 0, ultimoOkEm: 0, ultimoErroEm: 0, ultimoErro: '', emEsperaDesde: null, proximoTesteEm: null, testeLiberado: false };
  for (const lixo of ['{', 'null', '[]', '"x"', '{"falhasSeguidas":-1,"ultimoOkEm":"9","ultimoErro":7}',
    '{"falhasSeguidas":1.5,"ultimoOkEm":-3,"ultimoErroEm":null,"emEsperaDesde":"ontem","proximoTesteEm":1}']) {
    setSetting(db, 'ml_central', lixo);
    assert.deepEqual(createLinkService({ getMode: () => 'extension', db, agora: rel.agora }).central(), vazio, lixo);
  }
  // datas no futuro (relógio que voltou): viram agora; o teste fica no máximo 5 min à frente, gravado assim
  setSetting(db, 'ml_central', JSON.stringify({
    falhasSeguidas: 4, ultimoOkEm: rel.t + 9e9, ultimoErroEm: rel.t + 9e9, ultimoErro: `ruim\u0007${'y'.repeat(500)}`,
    emEsperaDesde: rel.t + 9e9, proximoTesteEm: rel.t + 365 * 24 * 60 * MIN,
  }));
  const l = createLinkService({ getMode: () => 'extension', db, agora: rel.agora });
  const c = l.central();
  assert.deepEqual([c.estado, c.falhasSeguidas, c.ultimoOkEm, c.ultimoErroEm, c.emEsperaDesde, c.proximoTesteEm],
    ['em_espera', 4, rel.t, rel.t, rel.t, rel.t + 5 * MIN]);
  assert.equal(c.ultimoErro.length, MAX_DETALHE);
  assert.match(c.ultimoErro, /^ruim y+…$/);
  assert.equal(JSON.parse(getSetting(db, 'ml_central')).proximoTesteEm, rel.t + 5 * MIN, 'o corte é gravado (reinícios não esticam)');
  // espera aberta sem horário de teste: o teste fica liberado; horário sem espera é descartado
  setSetting(db, 'ml_central', JSON.stringify({ falhasSeguidas: 3, emEsperaDesde: rel.t - MIN }));
  assert.equal(createLinkService({ getMode: () => 'extension', db, agora: rel.agora }).central().testeLiberado, true);
  setSetting(db, 'ml_central', JSON.stringify({ falhasSeguidas: 1, proximoTesteEm: rel.t + MIN }));
  assert.equal(createLinkService({ getMode: () => 'extension', db, agora: rel.agora }).central().proximoTesteEm, null);
  db.close();
});

test('central: banco que falha não derruba o pedido; o console não leva o erro do banco nem o texto da extensão', async () => {
  const erros = [];
  const original = console.error; console.error = (...x) => erros.push(x.join(' '));
  try {
    const quebrado = { prepare: () => { throw new Error(`SQLITE_FULL ${URL_ML}`); } };
    const links = await servico({ db: quebrado });
    await falhar(links, 3, { ok: false, error: 'fulano@exemplo.com caiu', tipo: 'sem_resposta' });
    assert.equal(links.central().estado, 'em_espera', 'a espera vale em memória');
  } finally { console.error = original; }
  assert.ok(erros.length >= 1);
  assert.ok(erros.every((x) => !x.includes('SQLITE') && !x.includes('mercadolivre') && !x.includes('fulano')), erros.join('\n'));
});

test('central: a linha de abrir a espera não leva o erro real (pode ter dado de fora); cada causa tem a sua frase', async () => {
  const db = banco();
  const links = await servico({ db });
  await falhar(links, 3, { ok: false, error: 'não há sessão para fulano@exemplo.com', tipo: 'sessao' });
  const [linha] = linhas(db);
  assert.equal(linha.message, textoEsperaAberta('central_login'));
  assert.ok(!linha.message.includes('fulano'));
  // cada causa com a sua frase entre parênteses; a "sem resposta" vira o próprio verbo (achado D6)
  for (const causa of Object.keys(CAUSAS_CENTRAL).filter((c) => c !== 'central_sem_resposta')) assert.ok(textoEsperaAberta(causa).includes(`(${CAUSAS_CENTRAL[causa]})`));
  assert.ok(textoEsperaAberta('central_sem_resposta').includes('a Central de Afiliados não respondeu 3 vezes seguidas.'));
  assert.equal(textoEsperaAberta('outra'), textoEsperaAberta('central_sem_resposta'));
  db.close();
});

test('CA2.9: nenhum caminho de nova tentativa usa o modo direto nem aceita link fora de meli.la', async () => {
  const rel = relogio();
  const modos = [];
  const links = createLinkService({ getMode: () => { modos.push('extension'); return 'extension'; }, agora: rel.agora });
  await links.poll(0, RECURSO);
  await falhar(links, 3);
  // com a espera aberta: erro, nunca o endereço comum
  const { valor, erro } = await semPedido(links, pedirLink(links));
  assert.equal(valor, undefined);
  assert.equal(erro.classe, 'espera');
  // no teste, link fora de meli.la é recusado e conta como falha (a espera continua)
  rel.t += 5 * MIN;
  for (const link of ['https://produto.mercadolivre.com.br/MLB-1', 'http://meli.la/AbcDef1', 'https://meli.la.evil.com/AbcDef1', URL_ML]) {
    const r = await comExtensao(links, pedirLink(links), { ok: true, link });
    assert.equal(r.valor, undefined, link);
    assert.equal(r.erro.classe, 'passageira');
    assert.equal(links.central().estado, 'em_espera');
    rel.t += 5 * MIN;
  }
  assert.ok(modos.every((m) => m === 'extension'));
  // o modo fake e o direct não passam pela espera nem mexem no estado
  const fake = createLinkService({ getMode: () => 'fake' });
  assert.match(await fake.requestLink({ url: URL_ML, tag: 't' }), /^https:\/\/meli\.la\/fake-t-\d+$/);
  assert.equal(fake.central().estado, 'sem_teste');
});

// ---------------------------------------------------------------- rotas HTTP /api/ext/poll e /api/ext/result

const TOKEN_TESTE = 'token-de-teste-da-central';

function subir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-central-http-')); pastas.push(dir);
  const db = openDb(dir);
  setSetting(db, 'ext_token', TOKEN_TESTE); // token próprio do teste (o do banco novo é aleatório)
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'extension', db });
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
async function ligada(links, desde) {
  const t0 = Date.now();
  while (links.status().lastPollAt < desde) {
    assert.ok(Date.now() - t0 < 3000, 'o poll não chegou ao serviço');
    await esperar(2);
  }
}

/** Um pedido de link pela rota: poll com `cabecalhos`, resposta por /api/ext/result com `resposta`. */
async function rodada(s, cabecalhos, resposta) {
  await esperar(2); // o submit da rodada anterior também marca lastPollAt: este poll tem de ser o mais novo
  const antes = Date.now();
  const poll = pedir(s.port, 'GET', '/api/ext/poll', null, { 'x-token': TOKEN_TESTE, ...cabecalhos });
  await ligada(s.links, antes);
  const st = s.links.status();
  const r = resultado(s.links.requestLink({ url: URL_ML, tag: 'minha', timeoutMs: 5000 }));
  const { json } = await poll;
  assert.equal(json.job.type, 'link');
  const res = await pedir(s.port, 'POST', '/api/ext/result', { id: json.job.id, ...resposta }, { 'x-token': TOKEN_TESTE });
  assert.deepEqual(res.json, { ok: true });
  return { st, ...(await r) };
}

test('HTTP: o poll lê x-versao (só no formato N.N.N); o status mostra versao e desatualizada', async (t) => {
  const s = await subir(t);
  const nova = await rodada(s, { 'x-recursos': 'produto_ml', 'x-versao': '1.6.0' }, { ok: true, link: MELI });
  assert.deepEqual([nova.st.versao, nova.st.desatualizada], ['1.6.0', false]);
  assert.equal(nova.valor, MELI);
  const antiga = await rodada(s, { 'x-recursos': 'produto_ml' }, { ok: true, link: MELI });
  assert.deepEqual([antiga.st.versao, antiga.st.desatualizada], [null, true]);
  const torta = await rodada(s, { 'x-versao': '1.6.0; drop' }, { ok: true, link: MELI });
  assert.deepEqual([torta.st.versao, torta.st.desatualizada], [null, true]);
  // token errado: 401 e nada muda
  const negado = await pedir(s.port, 'GET', '/api/ext/poll', null, { 'x-token': 'errado', 'x-versao': '9.9.9' });
  assert.equal(negado.status, 401);
  assert.equal(s.links.status().versao, null);
});

test('HTTP: o result repassa o tipo só da lista fechada; fora dela vale o texto', async (t) => {
  const s = await subir(t);
  const vistos = [];
  const original = s.links.submit;
  s.links.submit = (id, r) => { vistos.push(r.tipo); return original(id, r); };
  const sessao = await rodada(s, { 'x-versao': '1.6.0' }, { ok: false, error: 'Failed to fetch', tipo: 'sessao' });
  assert.deepEqual([sessao.erro.classe, sessao.erro.causa], ['passageira', 'central_login']);
  for (const tipo of ['SESSAO', 'sessao ', { a: 1 }, ['sessao'], 7, 'constructor', '__proto__']) {
    const r = await rodada(s, { 'x-versao': '1.6.0' }, { ok: false, error: 'Failed to fetch', tipo });
    assert.equal(r.erro.causa, 'central_sem_resposta', JSON.stringify(tipo));
    await rodada(s, { 'x-versao': '1.6.0' }, { ok: true, link: MELI }); // zera a contagem: a espera não abre no meio
  }
  assert.equal(vistos.length, 15);
  assert.equal(vistos[0], 'sessao');
  assert.ok(vistos.slice(1).every((x) => x === undefined), 'tipo fora da lista não chega ao serviço');
  // o /api/state devolve links.status() (o estado da Central vem junto)
  await rodada(s, { 'x-versao': '1.6.0' }, { ok: false, error: 'Failed to fetch', tipo: 'aba' });
  const c = s.links.status().central;
  assert.deepEqual([c.estado, c.falhasSeguidas, c.ultimoErro], ['falhando', 1, 'Failed to fetch']);
});
