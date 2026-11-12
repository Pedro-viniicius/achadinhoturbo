// Rodar sozinho, entrega 2, etapa 6 (docs/produto/planos/rodar-sozinho-entrega2.md, Decisão 4; D2, D6, D8): o agendador
// com o Mercado Livre que se recupera. A Central em espera segura o ML na escolha e na leitura (sem pedido à extensão),
// a candidata de teste não conta e fica 6 h fora, a falha passageira (link ou conferência que não respondeu/demorou) é
// pulada e contada por oferta (no máximo 1 por execução), a 3ª vai à revisão com `falhas_repetidas` (fonte antiga: 6 h
// fora), a recusa definitiva descarta, e o orçamento de 120 s para de repor vagas.
// Agendador real, WhatsApp simulado, catálogo falso (ofertas no formato do Etiqueta). O serviço de links é o real no
// modo da extensão (o próprio teste faz o papel da extensão, por poll/submit) ou um dublê com o estado da Central na mão.
// Nenhum teste chama Mercado Livre, Etiqueta nem WhatsApp reais.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createScheduler, FALHAS_DA_OFERTA, ORCAMENTO_FALHAS_S } from '../src/scheduler.js';
import { createLinkService, ErroLinkML, FALHAS_PARA_ESPERA, TESTE_ESPERA_MIN } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { paraCandidato } from '../src/catalogo.js';
import { createVerificador, PAUSA_DESCARTADA_H } from '../src/verificador.js';
import { salvar as salvarRastreio } from '../src/rastreio.js';
import * as mlReal from '../src/ml.js';

// ------------------------------------------------------------------------------------------- sem rede nenhuma
const fetchOriginal = globalThis.fetch;
let chamadasDeRede = 0;
test.before(() => { globalThis.fetch = async () => { chamadasDeRede++; throw new Error('rede proibida no teste'); }; });
test.after(() => {
  globalThis.fetch = fetchOriginal;
  assert.equal(chamadasDeRede, 0, 'nenhum pedido de rede');
});

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-recupera-')); pastas.push(p); return p; };

const MIN = 60000;
const HORA = 3600000;
const dia = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // novembro/2026, horário local
const idDe = (url) => /MLB-?(\d+)/.exec(String(url))?.[1] ?? null;
const n = (id) => Number(id) - 4000000000; // MLB4000000003 → 3
const TITULOS = ['Panela Pressão Elétrica Mondial', 'Cadeira Gamer Reclinável Azul', 'Mochila Notebook Executiva Couro', 'Aspirador Robô Inteligente Wifi',
  'Smartwatch Esportivo Prova Água', 'Luminária Mesa Articulada Led', 'Toalha Banho Algodão Egípcio', 'Kit Ferramentas Maleta Completa'];
const titulo = (i) => TITULOS[i - 1];
const mlb = (i) => `MLB${4000000000 + i}`;
/** Oferta do ML no formato do Etiqueta. */
const oferta = (i, { preco = 100 } = {}) => ({
  id: i, loja: 'ml', titulo: titulo(i), preco, preco_antigo: 150, desconto_pct: 33, categoria: 'Casa', item_id: mlb(i), link: 'https://meli.la/TerCeiro1',
});

// Respostas da extensão (src/links.js submit)
const SEM_RESPOSTA = { ok: false, error: 'a Central de Afiliados do Mercado Livre não respondeu a tempo', tipo: 'sem_resposta' };
const PAUSADO = { ok: false, error: 'The article must be active, status: paused (etiqueta "etiquetaA")', tipo: 'recusa' };
const LIDO = { ok: true, data: { estado: 'lido', ofertas: [{ nome: true, price: 89.9, availability: 'https://schema.org/InStock' }] } };
const linkOk = (job) => ({ ok: true, link: `https://meli.la/Ok${job.id}x` });

const PULADA_LINK = 'Pulada: não deu para gerar o link de afiliado (a Central de Afiliados não respondeu).';
const SEGUNDA = ' É a 2ª vez que falha; na 3ª ela vai para a revisão.';

/** Relógio manual do estado da Central (agora() do serviço de links). */
function relogio(inicio = Date.now()) {
  const r = { t: inicio, agora: () => r.t, avancar: (ms) => { r.t += ms; } };
  return r;
}

/**
 * Extensão simulada sobre o serviço real: cada pedido que chega pelo poll vai a `responder(job)` (que pode trocar no
 * meio do teste: `ext.responder = …`). `jobs`: o que ela recebeu. Anuncia produto_ml e a versão 1.6.0.
 */
async function extensao(t, links, responder) {
  const ext = { jobs: [], responder, parar: false };
  const laco = (async () => {
    while (!ext.parar) {
      const job = await links.poll(15, { recursos: 'produto_ml', versao: '1.6.0' });
      if (job) { ext.jobs.push(job); links.submit(job.id, ext.responder(job)); }
    }
  })();
  t.after(async () => { ext.parar = true; await laco; });
  while (!links.status().online) await new Promise((ok) => { setTimeout(ok, 2); });
  ext.tipos = () => ext.jobs.map((j) => j.type);
  ext.limpar = () => { ext.jobs.length = 0; };
  return ext;
}

/**
 * Dublê do serviço de links no modo da extensão, sempre on-line: `estado.central` é o que central() devolve (estado e
 * testeLiberado) e `estado.link(p, id)` decide cada pedido de link (devolve o link ou lança). `estado.pedidos`: 'tag id'.
 */
function linksDuble() {
  const base = createLinkService({ getMode: () => 'fake' });
  const estado = { central: { estado: 'respondendo', testeLiberado: false }, pedidos: [], link: (p) => `https://meli.la/Ok${estado.pedidos.length}x` };
  Object.assign(base, {
    modo: () => 'extension',
    status: () => ({ online: true, central: { ...estado.central } }),
    central: () => ({ ...estado.central }),
    async requestLink(p) { const id = idDe(p.url); estado.pedidos.push(`${p.tag} ${n(id)}`); return estado.link(p, n(id)); },
  });
  return { links: base, estado };
}
const passageira = (causa = 'central_sem_resposta') => new ErroLinkML('a extensão não respondeu a tempo', { classe: 'passageira', causa, detalhe: 'x' });

/**
 * Agendador com o catálogo falso. `links`: o serviço a usar (o real do teste ou o dublê). `verificador`: o objeto a
 * injetar (null = sem). `dataDir`/`db`: para reabrir o mesmo banco ("reinício").
 */
function montar(t, { ofertas, links, verificador = null, db = null, dir = null, grupos = [['111@g.us', 'Achadinhos']], ml = null } = {}) {
  dir ??= tmp(); db ??= openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const estado = { ofertas, leituras: 0, utilizaveis: [] };
  const fonte = {
    async candidatos(cfg, ctx) {
      estado.leituras++;
      const lista = estado.ofertas.map(paraCandidato).filter((c) => c && !ctx.tratada(c, cfg.ordem));
      // o que o predicado do agendador diz de cada uma (só as utilizáveis contam para o alvo da leitura)
      estado.utilizaveis.push(lista.map((c) => ctx.utilizavel?.(c)));
      return lista;
    },
    avancar() {},
  };
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador, catalogo: fonte, catalogoItens, ...(ml ? { ml } : {}) });
  // o mesmo banco pode vir de antes (reinício): grupos e etiqueta só uma vez
  for (const [jid, nome] of grupos) db.prepare('INSERT OR IGNORE INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  if (!db.prepare("SELECT 1 FROM tags WHERE name = 'etiquetaA'").get()) db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const logs = (id) => db.prepare('SELECT level, offer_title, message FROM log WHERE rule_id IS ? ORDER BY id').all(id).map((l) => ({ ...l }));
  const saiu = () => wa.simulated.map((m) => m.text.split('\n')[0].replace(/^\*|\*$/g, ''));
  return { db, dir, wa, links, scheduler, estado, catalogoItens, logs, saiu };
}

const regraCatalogo = (db, { per = 1, dedupe = 7, grupos = ['111@g.us'] } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id,
  group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES ('Catálogo', 1, 1, 1, ?, 'list', '{}', ?, ?, 60, '00:00', '23:59', ?, 0, ?)`)
  .run(JSON.stringify(grupos), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['ml'] } }]), per, dedupe, Date.now()).lastInsertRowid);
/** Regra da "Lista de links" (fonte antiga): linhas com preço digitado, MLB-400000000i. */
const regraLista = (db, ids, { per = 1, grupos = ['111@g.us'] } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type,
  source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES ('Lista', 1, 1, 1, ?, 'list', ?, ?, 60, '00:00', '23:59', 7, 0, ?)`)
  .run(JSON.stringify(grupos), JSON.stringify({ items: ids.map((i) => `https://produto.mercadolivre.com.br/MLB-${4000000000 + i}-x | ${titulo(i)} | 50`).join('\n') }), per, Date.now()).lastInsertRowid);
const itens = (db, id) => db.prepare('SELECT chave, status, motivos FROM catalogo_itens WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l, motivos: JSON.parse(l.motivos) }));
const enviadas = (db, id) => db.prepare('SELECT offer_key FROM sent_offers WHERE rule_id = ? ORDER BY id').all(id).map((l) => l.offer_key);
const mensagens = (s, id) => s.logs(id).map((l) => l.message);
const sairam = (s, id) => mensagens(s, id).filter((m) => m.startsWith('Saíram '));
const linhaDe = (s, id, i) => s.logs(id).filter((l) => l.offer_title === titulo(i)).map((l) => l.message);

/** Verificador falso: `decisoes` = número da oferta → resposta do conferir; o resto sai como veio. `pausa`: a leitura do ML em pausa. */
function verificadorFalso(decisoes = {}) {
  const v = {
    conferidas: [],
    ativo: () => true,
    async conferir(o) {
      const i = n(idDe(o.url) ?? o.key.slice(3)); v.conferidas.push(i);
      const d = typeof decisoes === 'function' ? decisoes(i) : decisoes[i];
      return d ?? { acao: 'enviar', oferta: o, sufixo: null };
    },
    semConfirmacaoAgora: () => false,
    pausa: null, // a leitura do ML em pausa (CA2.13): null | 'ml_verificacao' | 'limite_hora' | 'extensao_antiga'
    pausaDaLeituraMl: () => v.pausa,
  };
  return v;
}
const naoConferido = (causa) => ({ acao: 'descartar', motivo: 'nao_conferido', causa, texto: 'x' });

// ======================================================================================================== CA2.1

test('CA2.1: timeout do link pula, repõe a vaga e não cria catalogo_itens', async (t) => {
  const { links, estado } = linksDuble();
  estado.link = (p, i) => { if (i === 1) throw passageira(); return `https://meli.la/Ok${i}x`; };
  const s = montar(t, { ofertas: [oferta(1), oferta(2)], links });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.puladas, r.revisao, r.descartadas, r.errors], [1, 1, 0, 0, 0]);
  assert.deepEqual(s.saiu(), [titulo(2)], 'a vaga foi para a 2ª');
  assert.deepEqual(itens(s.db, id), [{ chave: mlb(2), status: 'enviado', motivos: [] }], 'a que falhou não vira item do Catálogo');
  assert.deepEqual(enviadas(s.db, id), [mlb(2)]);
  assert.deepEqual(s.logs(id).filter((l) => l.offer_title === titulo(1)), [
    { level: 'aviso', offer_title: titulo(1), message: `${PULADA_LINK} Tenta de novo no próximo envio.` },
  ], 'uma linha aviso (nunca erro, que alerta no WhatsApp) e sem "revisão" na 1ª');
});

test('CA2.1: falha de conferência loja_fora/demorou pula sem revisão; a vaga vai à seguinte', async (t) => {
  const { links } = linksDuble();
  const v = verificadorFalso({ 1: naoConferido('loja_fora'), 2: naoConferido('demorou') });
  const s = montar(t, { ofertas: [oferta(1), oferta(2), oferta(3)], links, verificador: v });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.puladas, r.revisao], [1, 2, 0]);
  assert.deepEqual(s.saiu(), [titulo(3)]);
  assert.deepEqual(itens(s.db, id).map((i) => i.chave), [mlb(3)]);
  assert.deepEqual(linhaDe(s, id, 1), ['Pulada: não deu para conferir o preço (a loja não respondeu). O Mercado Livre não sai sem conferir; tenta de novo no próximo envio.']);
  assert.deepEqual(linhaDe(s, id, 2), ['Pulada: não deu para conferir o preço (a loja demorou demais). O Mercado Livre não sai sem conferir; tenta de novo no próximo envio.']);
});

test('CA2.1/CA2.3: conferência que falhou por causa que não é da oferta (extensão fora, leitura em pausa) pula sem contar', async (t) => {
  const { links } = linksDuble();
  const v = verificadorFalso({ 1: naoConferido('extensao_off'), 2: naoConferido('ml_verificacao') });
  const s = montar(t, { ofertas: [oferta(1), oferta(2)], links, verificador: v });
  const id = regraCatalogo(s.db, { per: 1 });
  for (let k = 0; k < FALHAS_DA_OFERTA + 1; k++) await s.scheduler.runRule(id);
  assert.deepEqual(itens(s.db, id), [], 'nenhuma foi à revisão');
  for (const i of [1, 2]) {
    const linhas = linhaDe(s, id, i);
    assert.equal(linhas.length, FALHAS_DA_OFERTA + 1);
    assert.ok(linhas.every((m) => m.startsWith('Pulada: não deu para conferir o preço') && !m.includes('2ª vez')), linhas.join(' | '));
  }
});

// ======================================================================================================== CA2.2

test('CA2.2: must be active, status: paused descarta com o motivo e não conta para a espera', async (t) => {
  const r0 = relogio();
  const dir = tmp(); const db = openDb(dir);
  const links = createLinkService({ getMode: () => 'extension', db, agora: r0.agora });
  const ext = await extensao(t, links, (job) => (idDe(job.url) === mlb(1).slice(3) ? PAUSADO : linkOk(job)));
  const s = montar(t, { ofertas: [oferta(1), oferta(2)], links, db, dir });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.descartadas, r.puladas, r.revisao], [1, 1, 0, 0]);
  assert.deepEqual(s.saiu(), [titulo(2)]);
  assert.deepEqual(itens(s.db, id).map((i) => [i.chave, i.status]), [[mlb(1), 'descartado'], [mlb(2), 'enviado']]);
  assert.equal(s.catalogoItens.listar({ status: 'descartado' }).itens[0].descartado_por, 'recusada_ml', 'a tela diz o porquê');
  assert.deepEqual(linhaDe(s, id, 1), ['Descartada: o Mercado Livre recusou gerar o link (o anúncio está pausado ou inativo).']);
  assert.equal(s.logs(id).find((l) => l.offer_title === titulo(1)).level, 'aviso');
  assert.deepEqual([links.central().estado, links.central().falhasSeguidas], ['respondendo', 0], 'a recusa é resposta da Central');
  assert.deepEqual(ext.tipos(), ['link', 'link']);

  // a descartada não volta na execução seguinte (o Catálogo a tem como tratada)
  ext.limpar();
  s.estado.ofertas.push(oferta(3));
  await s.scheduler.runRule(id);
  assert.deepEqual(ext.jobs.map((j) => n(idDe(j.url))), [3]);
});

test('CA2.2 (fonte antiga): a recusa definitiva descarta e deixa a oferta 6 h fora da escolha', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const { links, estado } = linksDuble();
  estado.link = (p, i) => {
    if (i === 1) throw new ErroLinkML('The article must be active, status: paused', { classe: 'recusa', causa: 'anuncio_inativo', detalhe: 'x' });
    return `https://meli.la/Ok${i}x`;
  };
  const s = montar(t, { ofertas: [], links });
  const id = regraLista(s.db, [1, 2], { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.descartadas, r.errors], [1, 1, 0]);
  assert.deepEqual(linhaDe(s, id, 1), ['Descartada: o Mercado Livre recusou gerar o link (o anúncio está pausado ou inativo).']);
  t.mock.timers.setTime(Date.now() + PAUSA_DESCARTADA_H * HORA - MIN);
  estado.pedidos.length = 0;
  await s.scheduler.runRule(id);
  assert.deepEqual(estado.pedidos, [], 'dentro das 6 h a recusada não é escolhida (e a 2ª já saiu)');
});

test('CA2.2/D6: recusa que não está na lista conta como falha da oferta (pulada, e na 3ª vai à revisão)', async (t) => {
  const { links, estado } = linksDuble();
  estado.link = () => { throw new ErroLinkML('Error: etiqueta inválida (etiqueta "etiquetaA")', { classe: 'passageira', causa: 'recusa_ml', detalhe: 'x' }); };
  const s = montar(t, { ofertas: [oferta(1)], links });
  const id = regraCatalogo(s.db, { per: 1 });
  for (let k = 0; k < FALHAS_DA_OFERTA; k++) await s.scheduler.runRule(id);
  assert.deepEqual(linhaDe(s, id, 1), [
    'Pulada: não deu para gerar o link de afiliado (o Mercado Livre recusou gerar o link). Tenta de novo no próximo envio.',
    `Pulada: não deu para gerar o link de afiliado (o Mercado Livre recusou gerar o link). Tenta de novo no próximo envio.${SEGUNDA}`,
    'Separada para revisão: o link falhou em 3 envios seguidos (o Mercado Livre recusou gerar o link). Abra a oferta em Histórico > Catálogo, confira e envie à mão.',
  ]);
  assert.deepEqual(itens(s.db, id), [{ chave: mlb(1), status: 'revisao', motivos: ['falhas_repetidas'] }]);
});

// ======================================================================================================== CA2.3

test('CA2.3: 3ª falha em execuções diferentes vai à revisão com falhas_repetidas; os dois pedidos de link que falham na mesma execução (associada e padrão) contam uma', async (t) => {
  const { links, estado } = linksDuble();
  estado.link = () => { throw passageira(); };
  // o grupo 222 tem etiqueta própria: dois pedidos de link por execução (a associada e, ao falhar, a padrão)
  const s = montar(t, { ofertas: [oferta(1)], links, grupos: [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']] });
  s.db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaB', Date.now());
  salvarRastreio(s.db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaB' });
  const id = regraCatalogo(s.db, { per: 1, grupos: ['111@g.us', '222@g.us'] });

  const r1 = await s.scheduler.runRule(id);
  assert.deepEqual(estado.pedidos, ['etiquetaA 1', 'etiquetaB 1'], 'duas falhas nesta execução');
  assert.deepEqual([r1.puladas, r1.revisao], [1, 0]);
  const r2 = await s.scheduler.runRule(id);
  assert.deepEqual([r2.puladas, r2.revisao], [1, 0]);
  assert.equal(estado.pedidos.length, 4);
  assert.deepEqual(itens(s.db, id), [], 'duas execuções: ainda não vai à revisão (as duas falhas da 1ª contaram uma)');
  const r3 = await s.scheduler.runRule(id);
  assert.deepEqual([r3.offers, r3.puladas, r3.revisao], [0, 0, 1]);
  assert.deepEqual(itens(s.db, id), [{ chave: mlb(1), status: 'revisao', motivos: ['falhas_repetidas'] }]);
  assert.deepEqual(linhaDe(s, id, 1), [
    `${PULADA_LINK} Tenta de novo no próximo envio.`,
    `${PULADA_LINK} Tenta de novo no próximo envio.${SEGUNDA}`,
    'Separada para revisão: o link falhou em 3 envios seguidos (a Central de Afiliados não respondeu). Abra a oferta em Histórico > Catálogo, confira e envie à mão.',
  ]);
  assert.deepEqual(sairam(s, id).at(-1), 'Saíram 0 de 1 oferta; 1 separada para revisão; não havia mais ofertas novas dentro dos filtros.');
  assert.equal(s.wa.simulated.length, 0);
  // na revisão ela não é escolhida de novo
  await s.scheduler.runRule(id);
  assert.equal(estado.pedidos.length, 6);
});

test('CA2.3: falhas de link e de conferência somam para a mesma oferta; a 3ª de conferência tem a frase dela', async (t) => {
  const { links, estado } = linksDuble();
  let vez = 0;
  estado.link = () => { throw passageira(); };
  const v = verificadorFalso((i) => (i === 1 && vez++ !== 0 ? naoConferido('demorou') : undefined)); // 1ª: link; 2ª e 3ª: conferência
  const s = montar(t, { ofertas: [oferta(1)], links, verificador: v });
  const id = regraCatalogo(s.db, { per: 1 });
  for (let k = 0; k < FALHAS_DA_OFERTA; k++) await s.scheduler.runRule(id);
  assert.deepEqual(linhaDe(s, id, 1), [
    `${PULADA_LINK} Tenta de novo no próximo envio.`,
    `Pulada: não deu para conferir o preço (a loja demorou demais). O Mercado Livre não sai sem conferir; tenta de novo no próximo envio.${SEGUNDA}`,
    'Separada para revisão: a conferência do preço falhou em 3 envios seguidos (a loja demorou demais). Abra a oferta em Histórico > Catálogo, confira o preço na loja e envie à mão.',
  ]);
  assert.deepEqual(itens(s.db, id), [{ chave: mlb(1), status: 'revisao', motivos: ['falhas_repetidas'] }]);
});

test('CA2.3: a oferta que sai zera a contagem (falha, falha, sai, falha → a última é a 1ª de novo)', async (t) => {
  const { links, estado } = linksDuble();
  const roteiro = ['falha', 'falha', 'ok', 'falha'];
  estado.link = (p, i) => { if (roteiro[estado.pedidos.length - 1] === 'falha') throw passageira(); return `https://meli.la/Ok${i}x`; };
  const s = montar(t, { ofertas: [oferta(1)], links });
  const id = regraCatalogo(s.db, { per: 1, dedupe: 0 }); // dias sem repetir 0: a que saiu volta a ser escolhida
  for (let k = 0; k < roteiro.length; k++) await s.scheduler.runRule(id);
  assert.equal(s.wa.simulated.length, 1);
  const puladas = linhaDe(s, id, 1).filter((m) => m.startsWith('Pulada'));
  assert.deepEqual(puladas, [`${PULADA_LINK} Tenta de novo no próximo envio.`, `${PULADA_LINK} Tenta de novo no próximo envio.${SEGUNDA}`, `${PULADA_LINK} Tenta de novo no próximo envio.`]);
  assert.deepEqual(itens(s.db, id).map((i) => i.status), ['enviado']);
});

test('CA2.3 (fonte antiga): a 3ª falha deixa a oferta 6 h fora da escolha, sem revisão; a linha de erro antiga não aparece', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const { links, estado } = linksDuble();
  estado.link = () => { throw passageira(); };
  const s = montar(t, { ofertas: [], links });
  const id = regraLista(s.db, [1], { per: 1 });
  for (let k = 0; k < FALHAS_DA_OFERTA; k++) { await s.scheduler.runRule(id); t.mock.timers.setTime(Date.now() + HORA); }
  assert.deepEqual(linhaDe(s, id, 1), [
    `${PULADA_LINK} Tenta de novo no próximo envio.`,
    `${PULADA_LINK} Tenta de novo no próximo envio. É a 2ª vez que falha; na 3ª ela fica 6 h fora da escolha desta regra.`,
    `${PULADA_LINK} Falhou em 3 envios seguidos: fica 6 h fora da escolha desta regra.`,
  ]);
  assert.ok(s.logs(id).every((l) => l.level !== 'erro'), 'nenhuma linha erro (que alerta no WhatsApp)');
  assert.deepEqual(sairam(s, id).at(-1), 'Saíram 0 de 1 oferta; 1 pulada (Central sem resposta); não havia mais ofertas novas dentro dos filtros.');
  assert.equal(estado.pedidos.length, 3);
  await s.scheduler.runRule(id); // 1 h depois da 3ª: dentro das 6 h
  assert.equal(estado.pedidos.length, 3, 'fora da escolha');
  t.mock.timers.setTime(Date.now() + PAUSA_DESCARTADA_H * HORA);
  await s.scheduler.runRule(id);
  assert.equal(estado.pedidos.length, 4, 'passadas as 6 h ela volta, contando do zero');
  assert.equal(linhaDe(s, id, 1).at(-1), `${PULADA_LINK} Tenta de novo no próximo envio.`);
});

// ======================================================================================================== CA2.4

test('CA2.4: as 3 falhas abrem a espera (1 para cada oferta); com ela aberta, nenhum pedido à extensão; reinício mantém a espera; a Central volta e as ofertas saem sem ação do dono', async (t) => {
  const r0 = relogio();
  const dir = tmp(); const db = openDb(dir);
  const novoServico = () => createLinkService({ getMode: () => 'extension', db, agora: r0.agora });
  let links = novoServico();
  const responder = { atual: () => SEM_RESPOSTA };
  // a extensão: link pelo `responder`; produto_ml (a conferência do verificador real) sempre lido
  const resposta = (job) => (job.type === 'produto_ml' ? LIDO : responder.atual(job));
  let ext = await extensao(t, links, resposta);
  const montarCom = (l) => montar(t, { ofertas: [1, 2, 3, 4, 5].map((i) => oferta(i)), links: l, db, dir, verificador: createVerificador({ db, links: l }) });
  let s = montarCom(links);
  const id = regraCatalogo(db, { per: 2 });

  // 1ª execução: as três primeiras falham (cada uma conta 1), a espera abre e as outras duas esperam
  const r1 = await s.scheduler.runRule(id);
  assert.deepEqual([r1.offers, r1.puladas, r1.revisao], [0, 3, 0], 'as outras duas esperam já na escolha (não são escolhidas)');
  assert.equal(links.central().estado, 'em_espera');
  assert.deepEqual(ext.tipos(), ['produto_ml', 'link', 'produto_ml', 'link', 'produto_ml', 'link'], 'três ofertas, cada uma com a conferência e o link');
  for (const i of [1, 2, 3]) assert.deepEqual(linhaDe(s, id, i), [`${PULADA_LINK} Tenta de novo no próximo envio.`]);
  assert.deepEqual(s.logs(null).map((l) => [l.level, l.message]), [['aviso',
    `Mercado Livre em espera: a Central de Afiliados não respondeu ${FALHAS_PARA_ESPERA} vezes seguidas. As ofertas do Mercado Livre esperam e o programa testa de novo em ${TESTE_ESPERA_MIN} min.`]]);
  assert.ok(mensagens(s, id).includes(`Catálogo do Etiqueta: 2 ofertas do Mercado Livre esperando: a Central de Afiliados não está respondendo. O programa testa de novo a cada ${TESTE_ESPERA_MIN} min e elas saem sozinhas quando ela voltar.`), mensagens(s, id).join(' | '));
  assert.deepEqual(itens(db, id), []);

  // 2ª execução, ainda na espera: nem conferência nem link chegam à extensão
  ext.limpar();
  const r2 = await s.scheduler.runRule(id);
  assert.deepEqual(ext.jobs, [], 'nenhum pedido link/produto_ml à extensão');
  assert.deepEqual([r2.offers, r2.puladas], [0, 0]);
  assert.ok(mensagens(s, id).at(-1).startsWith('Catálogo do Etiqueta: 5 ofertas do Mercado Livre esperando: a Central'), mensagens(s, id).join(' | '));

  // reinício (serviço de links e agendador novos, o mesmo banco): a espera continua
  ext.parar = true;
  links = novoServico();
  assert.equal(links.central().estado, 'em_espera');
  ext = await extensao(t, links, resposta);
  s = montarCom(links);
  r0.avancar(TESTE_ESPERA_MIN * MIN - 1000);
  await s.scheduler.runRule(id);
  assert.deepEqual(ext.jobs, [], 'depois do reinício, ainda sem pedido');

  // a Central volta; passado o teste, a execução seguinte manda sem ação do dono
  responder.atual = linkOk;
  r0.avancar(1000);
  const r4 = await s.scheduler.runRule(id);
  assert.deepEqual([r4.offers, r4.puladas], [2, 0]);
  assert.deepEqual(s.saiu(), [titulo(1), titulo(2)], 'a 1ª (a do teste) também sai: a falha de antes não a tirou da escolha');
  assert.equal(links.central().estado, 'respondendo');
  assert.ok(s.logs(null).at(-1).message.startsWith('Mercado Livre voltou: a Central de Afiliados respondeu ao teste'));
  assert.equal(s.logs(null).at(-1).level, 'info');
});

test('CA2.4/D2: as 3 falhas que abrem a espera contam, 1 para cada oferta (sem reinício no meio)', async (t) => {
  const r0 = relogio();
  const dir = tmp(); const db = openDb(dir);
  const links = createLinkService({ getMode: () => 'extension', db, agora: r0.agora });
  const ext = await extensao(t, links, () => SEM_RESPOSTA);
  const s = montar(t, { ofertas: [1, 2, 3, 4].map((i) => oferta(i)), links, db, dir });
  const id = regraCatalogo(db, { per: 2 });
  await s.scheduler.runRule(id);
  assert.equal(links.central().estado, 'em_espera');
  // a Central volta, menos para a 3ª; o teste (a 1ª) fecha a espera e a 2ª sai junto
  r0.avancar(TESTE_ESPERA_MIN * MIN);
  ext.responder = (job) => (idDe(job.url) === mlb(3).slice(3) ? SEM_RESPOSTA : linkOk(job));
  await s.scheduler.runRule(id);
  assert.deepEqual(s.saiu(), [titulo(1), titulo(2)]);
  await s.scheduler.runRule(id);
  assert.deepEqual(linhaDe(s, id, 3), [`${PULADA_LINK} Tenta de novo no próximo envio.`, `${PULADA_LINK} Tenta de novo no próximo envio.${SEGUNDA}`],
    'a falha que ajudou a abrir a espera contou: esta é a 2ª dela');
  assert.deepEqual(s.saiu(), [titulo(1), titulo(2), titulo(4)]);
});

test('CA2.4/D2: a candidata de teste que falha não conta e fica 6 h fora; a do teste seguinte é outra (veneno não segura o teste)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const { links, estado } = linksDuble();
  estado.central = { estado: 'em_espera', testeLiberado: true };
  // a Central só falha a oferta 1 ("veneno"); a falha re-arma a espera, o link certo a fecha
  estado.link = (p, i) => {
    if (i === 1) { estado.central = { estado: 'em_espera', testeLiberado: false }; throw passageira(); }
    estado.central = { estado: 'respondendo', testeLiberado: false };
    return `https://meli.la/Ok${i}x`;
  };
  const s = montar(t, { ofertas: [oferta(1), oferta(2), oferta(3)], links });
  const id = regraCatalogo(s.db, { per: 2 });
  const r1 = await s.scheduler.runRule(id);
  assert.deepEqual(estado.pedidos, ['etiquetaA 1'], 'só o teste foi pedido; as outras esperam');
  assert.deepEqual([r1.offers, r1.puladas], [0, 1], 'as outras esperam já na escolha');
  assert.deepEqual(linhaDe(s, id, 1), [`${PULADA_LINK} Fica 6 h fora da escolha desta regra.`]);
  assert.deepEqual(sairam(s, id), ['Saíram 0 de 2 ofertas; 1 pulada (Central sem resposta); não havia mais ofertas novas dentro dos filtros.']);
  assert.ok(mensagens(s, id).some((m) => m.startsWith('Catálogo do Etiqueta: 2 ofertas do Mercado Livre esperando: a Central')));

  // 5 min depois: o teste é da 2ª (a 1ª está fora); a Central responde e as que esperavam saem
  estado.central = { estado: 'em_espera', testeLiberado: true };
  t.mock.timers.setTime(Date.now() + 5 * MIN);
  const r2 = await s.scheduler.runRule(id);
  assert.deepEqual(estado.pedidos, ['etiquetaA 1', 'etiquetaA 2', 'etiquetaA 3']);
  assert.equal(r2.offers, 2);
  assert.deepEqual(s.saiu(), [titulo(2), titulo(3)]);

  // passadas as 6 h, a 1ª volta e falha fora da espera: é a 1ª falha dela (a do teste não contou)
  t.mock.timers.setTime(Date.now() + PAUSA_DESCARTADA_H * HORA);
  await s.scheduler.runRule(id);
  assert.deepEqual(linhaDe(s, id, 1).at(-1), `${PULADA_LINK} Tenta de novo no próximo envio.`);
  assert.deepEqual(itens(s.db, id).filter((i) => i.status === 'revisao'), []);
});

test('CA2.4: descarte antes do link não gasta o teste — a candidata seguinte, na mesma execução, é o teste e fecha a espera', async (t) => {
  const r0 = relogio();
  const dir = tmp(); const db = openDb(dir);
  const links = createLinkService({ getMode: () => 'extension', db, agora: r0.agora });
  const ext = await extensao(t, links, () => SEM_RESPOSTA);
  for (let k = 0; k < FALHAS_PARA_ESPERA; k++) await links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-1', tag: 'etiquetaA' }).catch(() => {});
  assert.equal(links.central().estado, 'em_espera');
  r0.avancar(TESTE_ESPERA_MIN * MIN);
  ext.responder = linkOk; ext.limpar();
  const v = verificadorFalso({ 1: { acao: 'descartar', motivo: 'esgotado', texto: 'Descartada: esgotado na loja' } });
  const s = montar(t, { ofertas: [oferta(1), oferta(2)], links, db, dir, verificador: v });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.descartadas], [1, 1]);
  assert.deepEqual(ext.jobs.map((j) => [j.type, n(idDe(j.url))]), [['link', 2]], 'o link da 2ª foi o teste');
  assert.equal(links.central().estado, 'respondendo');
  assert.deepEqual(s.saiu(), [titulo(2)]);
});

test('CA2.4: o pedido recusado pela espera (o teste foi usado por outro pedido) ou pela extensão que caiu espera, sem contar nem linha "Pulada"', async (t) => {
  for (const [classe, texto] of [['espera', 'a Central de Afiliados não está respondendo'], ['desconectada', 'esperando a extensão do Chrome conectar']]) {
    await t.test(classe, async (tt) => {
      const { links, estado } = linksDuble();
      estado.link = () => {
        // o pedido não saiu: a espera fechou para ele (ou a extensão sumiu) na hora
        if (classe === 'espera') estado.central = { estado: 'em_espera', testeLiberado: false };
        else links.status = () => ({ online: false });
        throw new ErroLinkML('nenhum pedido saiu', { classe, causa: classe === 'espera' ? 'central_sem_resposta' : 'extensao_off' });
      };
      const s = montar(tt, { ofertas: [oferta(1)], links });
      const id = regraCatalogo(s.db, { per: 1 });
      const r = await s.scheduler.runRule(id);
      assert.deepEqual([r.offers, r.puladas, r.revisao], [0, 1, 0]);
      assert.deepEqual(linhaDe(s, id, 1), [], 'sem linha por oferta');
      assert.ok(mensagens(s, id).some((m) => m.startsWith('Catálogo do Etiqueta: 1 oferta do Mercado Livre') && m.includes(texto)), mensagens(s, id).join(' | '));
      // não contou: devolvida a Central, a falha seguinte é a 1ª dela
      estado.central = { estado: 'respondendo', testeLiberado: false };
      links.status = () => ({ online: true });
      estado.link = () => { throw passageira(); };
      await s.scheduler.runRule(id);
      assert.deepEqual(linhaDe(s, id, 1), [`${PULADA_LINK} Tenta de novo no próximo envio.`]);
    });
  }
});

test('CA2.4 (fonte antiga): com a espera aberta a oferta da lista não é conferida nem pede link; o pedido recusado pela espera também não conta nem vira erro', async (t) => {
  const { links, estado } = linksDuble();
  estado.central = { estado: 'em_espera', testeLiberado: false };
  const v = verificadorFalso();
  const s = montar(t, { ofertas: [], links, verificador: v });
  const id = regraLista(s.db, [1, 2], { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([estado.pedidos, v.conferidas], [[], []], 'nenhum pedido à extensão');
  assert.deepEqual([r.offers, r.puladas, r.errors], [0, 2, 0]);
  assert.deepEqual(sairam(s, id), ['Saíram 0 de 1 oferta; 2 puladas (Mercado Livre em espera); não havia mais ofertas novas dentro dos filtros.']);
  assert.ok(s.logs(id).every((l) => l.offer_title === null && l.level !== 'erro'), 'sem linha por oferta (P2) e sem erro');

  // a espera fechou para o pedido no meio (o teste foi de outro): também espera, sem a linha de erro antiga
  estado.central = { estado: 'respondendo', testeLiberado: false };
  estado.link = () => { throw new ErroLinkML('nenhum pedido saiu', { classe: 'espera', causa: 'central_sem_resposta' }); };
  const r2 = await s.scheduler.runRule(id);
  assert.deepEqual([r2.offers, r2.puladas, r2.errors], [0, 2, 0]);
  assert.ok(s.logs(id).every((l) => l.level !== 'erro'));
  assert.equal(sairam(s, id).at(-1), 'Saíram 0 de 1 oferta; 2 puladas (Mercado Livre em espera); não havia mais ofertas novas dentro dos filtros.');
});

// ======================================================================================================== CA2.9

test('CA2.9: na espera, a etiqueta associada que falha cai na padrão; nunca link comum (o teste que falha deixa a oferta esperar, sem link)', async (t) => {
  // ordem dos pedidos = ordem do 1º grupo de cada código na regra: com o 222 primeiro, o teste é o da etiqueta associada
  const B_PRIMEIRO = ['222@g.us', '111@g.us']; const A_PRIMEIRO = ['111@g.us', '222@g.us'];
  for (const [caso, respostaB, ordem, esperado] of [
    ['a associada falha no teste: a padrão é recusada pela espera e nada sai', SEM_RESPOSTA, B_PRIMEIRO, { saiu: 0, tipos: ['link'], central: 'em_espera' }],
    ['a associada é recusada (anúncio) no teste: a Central respondeu, a padrão é pedida e os dois grupos recebem o link dela', PAUSADO, B_PRIMEIRO, { saiu: 2, tipos: ['link', 'link'], central: 'respondendo' }],
    ['a padrão é o teste e fecha a espera; a associada falha e o grupo dela recebe o link da padrão', SEM_RESPOSTA, A_PRIMEIRO, { saiu: 2, tipos: ['link', 'link'], central: 'falhando' }],
  ]) {
    await t.test(caso, async (tt) => {
      const r0 = relogio();
      const dir = tmp(); const db = openDb(dir);
      const links = createLinkService({ getMode: () => 'extension', db, agora: r0.agora });
      const ext = await extensao(tt, links, () => SEM_RESPOSTA);
      for (let k = 0; k < FALHAS_PARA_ESPERA; k++) await links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-1', tag: 'etiquetaA' }).catch(() => {});
      r0.avancar(TESTE_ESPERA_MIN * MIN);
      ext.limpar();
      ext.responder = (job) => (job.tag === 'etiquetaB' ? respostaB : { ok: true, link: 'https://meli.la/Padrao1' });
      const s = montar(tt, { ofertas: [oferta(1)], links, db, dir, grupos: [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']] });
      db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaB', Date.now());
      salvarRastreio(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaB' });
      const id = regraCatalogo(db, { per: 1, grupos: ordem });
      const r = await s.scheduler.runRule(id);
      assert.deepEqual(ext.tipos(), esperado.tipos);
      assert.equal(ext.jobs[0].tag, ordem === B_PRIMEIRO ? 'etiquetaB' : 'etiquetaA');
      assert.equal(s.wa.simulated.length, esperado.saiu);
      for (const m of s.wa.simulated) {
        assert.match(m.text, /https:\/\/meli\.la\/Padrao1/, 'o link da etiqueta padrão');
        assert.doesNotMatch(m.text, /mercadolivre\.com\.br/, 'nunca o link comum');
      }
      if (!esperado.saiu) {
        assert.deepEqual([r.offers, r.puladas], [0, 1]);
        assert.deepEqual(linhaDe(s, id, 1), [`${PULADA_LINK} Fica 6 h fora da escolha desta regra.`], 'a candidata de teste: não conta, 6 h fora');
      }
      assert.equal(links.central().estado, esperado.central);
    });
  }
});

// R1 (rodada 1): a oferta "veneno" com grupos de rastreio mistos (um grupo na etiqueta padrão, outro com a associada).
// O 1º pedido é o teste e falha; o pedido seguinte da MESMA oferta é recusado pela espera. Vale a falha dela: fica 6 h
// fora e o teste seguinte usa outra oferta, nas duas ordens dos grupos e também na fonte antiga.
const A_PRIMEIRO = ['111@g.us', '222@g.us']; const B_PRIMEIRO = ['222@g.us', '111@g.us'];
async function centralComVeneno(t) {
  const r0 = relogio();
  const dir = tmp(); const db = openDb(dir);
  const links = createLinkService({ getMode: () => 'extension', db, agora: r0.agora });
  const ext = await extensao(t, links, () => SEM_RESPOSTA);
  for (let k = 0; k < FALHAS_PARA_ESPERA; k++) await links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-9', tag: 'etiquetaA' }).catch(() => {});
  assert.equal(links.central().estado, 'em_espera');
  r0.avancar(TESTE_ESPERA_MIN * MIN);
  ext.limpar();
  // a Central só falha a oferta 1, com qualquer etiqueta
  ext.responder = (job) => (idDe(job.url) === mlb(1).slice(3) ? SEM_RESPOSTA : linkOk(job));
  const associar = (s) => {
    s.db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaB', Date.now());
    salvarRastreio(s.db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaB' });
  };
  return { r0, dir, db, links, ext, associar };
}
const GRUPOS_MISTOS = [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']];

test('R1: veneno com grupos mistos (catálogo), nas duas ordens: o teste que falha deixa a oferta 6 h fora e o teste seguinte usa outra', async (t) => {
  for (const [nome, ordem] of [['padrão antes da associada', A_PRIMEIRO], ['associada antes da padrão', B_PRIMEIRO]]) {
    await t.test(nome, async (tt) => {
      const c = await centralComVeneno(tt);
      const s = montar(tt, { ofertas: [oferta(1), oferta(2)], links: c.links, db: c.db, dir: c.dir, grupos: GRUPOS_MISTOS });
      c.associar(s);
      const id = regraCatalogo(c.db, { per: 1, grupos: ordem });
      const r1 = await s.scheduler.runRule(id);
      assert.deepEqual(c.ext.jobs.map((j) => [j.tag, n(idDe(j.url))]), [[ordem === A_PRIMEIRO ? 'etiquetaA' : 'etiquetaB', 1]], 'um pedido só: o teste');
      assert.deepEqual([r1.offers, r1.puladas], [0, 1]);
      assert.deepEqual(linhaDe(s, id, 1), [`${PULADA_LINK} Fica 6 h fora da escolha desta regra.`], 'a falha do teste, não a espera');
      assert.equal(c.links.central().estado, 'em_espera');
      // 5 min depois o teste é da 2ª: a Central responde, a espera fecha e ela sai
      c.ext.limpar();
      c.r0.avancar(TESTE_ESPERA_MIN * MIN);
      const r2 = await s.scheduler.runRule(id);
      assert.deepEqual([...new Set(c.ext.jobs.map((j) => n(idDe(j.url))))], [2], 'o teste seguinte usou outra oferta');
      assert.equal(r2.offers, 1);
      assert.deepEqual(s.saiu(), [titulo(2), titulo(2)]);
      assert.equal(c.links.central().estado, 'respondendo');
      assert.deepEqual(linhaDe(s, id, 1).length, 1, 'a 1ª não foi escolhida de novo');
    });
  }
});

test('R1/D2: fora do teste, a falha que abre a espera com grupos mistos conta para a oferta (2ª vez, não "esperando")', async (t) => {
  const { links, estado } = linksDuble();
  // a 1ª falha conta normalmente; na 2ª execução o pedido da padrão falha e "abre a espera": o da associada é recusado
  let execucao = 0;
  estado.link = (p) => {
    if (execucao === 2 && p.tag === 'etiquetaB') throw new ErroLinkML('nenhum pedido saiu', { classe: 'espera', causa: 'central_sem_resposta' });
    if (execucao === 2) estado.central = { estado: 'em_espera', testeLiberado: false };
    throw passageira();
  };
  const s = montar(t, { ofertas: [oferta(1)], links, grupos: GRUPOS_MISTOS });
  s.db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaB', Date.now());
  salvarRastreio(s.db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaB' });
  const id = regraCatalogo(s.db, { per: 1, grupos: A_PRIMEIRO });
  execucao = 1; await s.scheduler.runRule(id);
  execucao = 2; await s.scheduler.runRule(id);
  assert.deepEqual(linhaDe(s, id, 1), [`${PULADA_LINK} Tenta de novo no próximo envio.`, `${PULADA_LINK} Tenta de novo no próximo envio.${SEGUNDA}`]);
});

test('R1 (fonte antiga): veneno com grupos mistos, nas duas ordens: a falha do teste vale (6 h fora) e o teste seguinte usa outra oferta', async (t) => {
  for (const [nome, ordem] of [['padrão antes da associada', A_PRIMEIRO], ['associada antes da padrão', B_PRIMEIRO]]) {
    await t.test(nome, async (tt) => {
      const c = await centralComVeneno(tt);
      const s = montar(tt, { ofertas: [], links: c.links, db: c.db, dir: c.dir, grupos: GRUPOS_MISTOS });
      c.associar(s);
      const id = regraLista(c.db, [1, 2], { per: 1, grupos: ordem });
      const r1 = await s.scheduler.runRule(id);
      assert.deepEqual(c.ext.jobs.map((j) => n(idDe(j.url))), [1], 'um pedido só: o teste');
      // a 2ª é escolhida (a fonte antiga não espera na escolha) e pulada pela espera, sem pedido nem linha (P2)
      assert.deepEqual([r1.offers, r1.puladas, r1.errors], [0, 2, 0]);
      assert.deepEqual(linhaDe(s, id, 1), [`${PULADA_LINK} Fica 6 h fora da escolha desta regra.`]);
      assert.deepEqual(linhaDe(s, id, 2), []);
      c.ext.limpar();
      c.r0.avancar(TESTE_ESPERA_MIN * MIN);
      const r2 = await s.scheduler.runRule(id);
      assert.deepEqual([...new Set(c.ext.jobs.map((j) => n(idDe(j.url))))], [2], 'o teste seguinte usou outra oferta');
      assert.equal(r2.offers, 1);
      assert.equal(c.links.central().estado, 'respondendo');
    });
  }
});

test('S5: a linha "Rastreio: a etiqueta … não gerou o link" leva a frase fixa da causa, nunca o texto livre da extensão', async (t) => {
  const { links, estado } = linksDuble();
  estado.link = (p, i) => {
    if (p.tag === 'etiquetaB') throw new ErroLinkML('não há sessão para fulano@exemplo.com <script>', { classe: 'passageira', causa: 'central_login', detalhe: 'x' });
    return `https://meli.la/Ok${i}x`;
  };
  const s = montar(t, { ofertas: [oferta(1)], links, grupos: GRUPOS_MISTOS });
  s.db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaB', Date.now());
  salvarRastreio(s.db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaB' });
  const id = regraCatalogo(s.db, { per: 1, grupos: B_PRIMEIRO });
  await s.scheduler.runRule(id);
  const linha = mensagens(s, id).find((m) => m.startsWith('Rastreio: '));
  assert.equal(linha, 'Rastreio: a etiqueta etiquetaB não gerou o link (a Central de Afiliados pediu login); o grupo recebeu o da etiqueta etiquetaA.');
  assert.ok(!mensagens(s, id).some((m) => m.includes('fulano') || m.includes('<script>')));
});

test('R8 (entrega 2): a extensão que caiu entre os dois pedidos dá a frase dela na linha "Rastreio", não "a Central não respondeu"', async (t) => {
  const { links, estado } = linksDuble();
  // fonte antiga (sem espera na escolha): o pedido da associada é recusado com a extensão desconectada; o da padrão sai
  estado.link = (p, i) => {
    if (p.tag === 'etiquetaB') throw new ErroLinkML('A extensão do Chrome não está conectada.', { classe: 'desconectada', causa: 'extensao_off' });
    return `https://meli.la/Ok${i}x`;
  };
  const s = montar(t, { ofertas: [], links, grupos: GRUPOS_MISTOS });
  s.db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaB', Date.now());
  salvarRastreio(s.db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaB' });
  const id = regraLista(s.db, [1], { per: 1, grupos: B_PRIMEIRO });
  await s.scheduler.runRule(id);
  const linha = mensagens(s, id).find((m) => m.startsWith('Rastreio: '));
  assert.equal(linha, 'Rastreio: a etiqueta etiquetaB não gerou o link (a extensão do Chrome não está conectada); o grupo recebeu o da etiqueta etiquetaA.');
  assert.deepEqual(s.saiu(), [titulo(1), titulo(1)], 'os dois grupos receberam o link da etiqueta padrão');
});

// ======================================================================================================= CA2.14

test('CA2.14: passados 120 s em ofertas que caíram, a execução para de escolher com a frase do orçamento', async (t) => {
  for (const [passoMs, escolhidas] of [[45000, 3], [60000, 2], [59999, 3], [39000, 4]]) {
    await t.test(`${passoMs / 1000} s por falha → ${escolhidas} escolhidas`, async (tt) => {
      tt.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
      const { links, estado } = linksDuble();
      estado.link = () => { tt.mock.timers.setTime(Date.now() + passoMs); throw passageira(); };
      const s = montar(tt, { ofertas: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => oferta(i)), links });
      const id = regraCatalogo(s.db, { per: 3 }); // teto de escolhidas: 3 × 4 = 12
      const r = await s.scheduler.runRule(id);
      assert.equal(estado.pedidos.length, escolhidas);
      assert.equal(r.puladas, escolhidas);
      assert.deepEqual(sairam(s, id), [`Saíram 0 de 3 ofertas; ${escolhidas} puladas (Central sem resposta); o tempo para repor vagas acabou.`]);
    });
  }
  assert.equal(ORCAMENTO_FALHAS_S, 120);
});

test('CA2.14: o tempo das que saíram não conta; só o das que caíram fora', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const { links, estado } = linksDuble();
  estado.link = (p, i) => {
    t.mock.timers.setTime(Date.now() + (i === 1 ? 100000 : 45000));
    if (i === 1) return 'https://meli.la/Ok1x';
    throw passageira();
  };
  const s = montar(t, { ofertas: [1, 2, 3, 4, 5, 6].map((i) => oferta(i)), links });
  const id = regraCatalogo(s.db, { per: 5 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual(estado.pedidos, ['etiquetaA 1', 'etiquetaA 2', 'etiquetaA 3', 'etiquetaA 4'], '100 s da que saiu + 3 × 45 s das que caíram');
  assert.deepEqual([r.offers, r.puladas], [1, 3]);
  assert.deepEqual(sairam(s, id), ['Saíram 1 de 5 ofertas; 3 puladas (Central sem resposta); o tempo para repor vagas acabou.']);
});

test('CA2.14: com a vaga ainda livre, o orçamento esgotado não fura a proteção do número (nenhuma vaga fica presa)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const { links, estado } = linksDuble();
  estado.link = () => { t.mock.timers.setTime(Date.now() + 61000); throw passageira(); };
  const s = montar(t, { ofertas: [1, 2, 3].map((i) => oferta(i)), links });
  s.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('wa_limite_hora', '1')").run();
  const id = regraCatalogo(s.db, { per: 1 });
  await s.scheduler.runRule(id);
  assert.equal(estado.pedidos.length, 2);
  // a vaga separada para a oferta que caiu voltou ao teto: a execução seguinte manda a 3ª
  estado.link = (p, i) => `https://meli.la/Ok${i}x`;
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1);
});

// ============================================================================================ CA2.11 (etapa 9)

/** verificadorFalso cujo `conferir` devolve a oferta com o preço trocado (como o verificador real quando a loja mostra outro). */
function verificadorComPreco(precos) {
  const v = verificadorFalso();
  const conferir = v.conferir;
  v.conferir = async (o) => {
    const r = await conferir(o);
    const i = n(idDe(o.url) ?? o.key.slice(3));
    return precos[i] == null ? r : { acao: 'enviar', oferta: { ...o, price: precos[i] }, sufixo: null };
  };
  return v;
}

test('CA2.11: queda de 50% depois da conferência vai à revisão com queda_preco (e a % no item); 49% sai', async (t) => {
  const { links, estado } = linksDuble();
  // preço da lista 100: a 1ª é conferida a 50 (50%), a 2ª a 51 (49%)
  const v = verificadorComPreco({ 1: 50, 2: 51 });
  const s = montar(t, { ofertas: [oferta(1), oferta(2)], links, verificador: v });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao], [1, 1]);
  assert.deepEqual(s.saiu(), [titulo(2)]);
  assert.deepEqual(estado.pedidos, ['etiquetaA 2'], 'a que vai à revisão não pede link');
  assert.deepEqual(itens(s.db, id).map((i) => [i.chave, i.status, i.motivos]), [[mlb(1), 'revisao', ['queda_preco']], [mlb(2), 'enviado', []]]);
  assert.deepEqual(linhaDe(s, id, 1), ['Separada para revisão: o preço está 50% abaixo do preço da lista (o limite é 50%), confira o preço.']);
  const lista = s.catalogoItens.listar({ status: 'revisao' }).itens;
  assert.equal(lista[0].queda_pct, 50);
  assert.equal(lista[0].oferta.price, 50, 'gravada com o preço conferido');
});

test('CA2.11: sem conferência que troque o preço, nada muda (o preço da lista é o que vale)', async (t) => {
  const { links } = linksDuble();
  const s = montar(t, { ofertas: [oferta(1, { preco: 20 })], links, verificador: verificadorFalso() });
  const id = regraCatalogo(s.db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao], [1, 0]);
});

// ============================================================================================ CA2.12 (etapa 9)

/**
 * Fonte antiga (Lista de links) com preço lido da loja: o resolveOffer real, sem a marca `digitado` (como se a linha
 * não trouxesse preço e a página fosse lida). `digitadas`: ids que mantêm a marca (preço escrito à mão).
 */
const mlLido = (digitadas = new Set()) => ({
  ...mlReal,
  resolveOffer: async (c, d) => {
    const r = await mlReal.resolveOffer(c, d);
    if (digitadas.has(n(idDe(c.url)))) return r;
    const { digitado: _marca, ...lido } = r;
    return lido;
  },
});
/** Lista com preço e preço antigo (MLB-400000000i | título | preço | antigo). */
const regraListaCom = (db, linhas, { per = 1 } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type,
  source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES ('Lista', 1, 1, 1, ?, 'list', ?, ?, 60, '00:00', '23:59', 7, 0, ?)`)
  .run(JSON.stringify(['111@g.us']), JSON.stringify({ items: linhas.map(([i, preco, antigo]) => `https://produto.mercadolivre.com.br/MLB-${4000000000 + i}-x | ${titulo(i)} | ${preco}${antigo ? ` | ${antigo}` : ''}`).join('\n') }), per, Date.now()).lastInsertRowid);

test('CA2.12: fonte antiga com preço suspeito depois da conferência descarta e pausa 6 h; preço digitado à mão não passa pela guarda', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const { links, estado } = linksDuble();
  // 1: 100 → 50 (queda de 50%, o limite); 2: 100 → 55 com antigo 600 (10× ou mais); 3: 100 → 51 (49%, sai); 4: digitada, 100 → 10 (sai)
  const v = verificadorComPreco({ 1: 50, 2: 55, 3: 51, 4: 10 });
  const s = montar(t, { ofertas: [], links, verificador: v, ml: mlLido(new Set([4])) });
  const id = regraListaCom(s.db, [[1, 100], [2, 100, 600], [3, 100], [4, 100]], { per: 2 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.descartadas], [2, 2], mensagens(s, id).join(' | '));
  assert.deepEqual(s.saiu(), [titulo(3), titulo(4)]);
  assert.deepEqual(estado.pedidos, ['etiquetaA 3', 'etiquetaA 4'], 'a descartada não pede link');
  assert.deepEqual(linhaDe(s, id, 1), ['Descartada: preço suspeito (R$ 50,00 na loja, 50% abaixo do preço da lista). Fica 6 h fora da escolha desta regra.']);
  assert.deepEqual(linhaDe(s, id, 2), ['Descartada: preço suspeito (R$ 55,00 na loja, com o preço antigo 10 vezes maior ou mais). Fica 6 h fora da escolha desta regra.']);
  assert.ok(s.logs(id).filter((l) => l.message.startsWith('Descartada')).every((l) => l.level === 'aviso'));
  assert.deepEqual(sairam(s, id), []);
  // 6 h fora da escolha
  v.conferidas.length = 0;
  const r2 = await s.scheduler.runRule(id);
  assert.deepEqual([r2.offers, v.conferidas], [0, []], 'as descartadas não são escolhidas');
  assert.ok(mensagens(s, id).at(-1).includes('2 em pausa de 6 h'), mensagens(s, id).at(-1));
  t.mock.timers.setTime(Date.now() + PAUSA_DESCARTADA_H * HORA);
  await s.scheduler.runRule(id);
  assert.deepEqual(v.conferidas, [1, 2], 'passadas as 6 h, voltam a ser conferidas');
});

test('CA2.12: preço suspeito que NÃO veio da conferência (a loja confirmou o mesmo preço) não é barrado nas fontes antigas, como na fila', async (t) => {
  const { links } = linksDuble();
  const v = verificadorFalso();
  const s = montar(t, { ofertas: [], links, verificador: v, ml: mlLido() });
  const id = regraListaCom(s.db, [[1, 50, 1000]], { per: 1 }); // preço antigo 20× maior, preço confirmado
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([v.conferidas, r.offers, r.descartadas], [[1], 1, 0]);
});

test('CA2.12: o resumo "Saíram X de Y" conta o descarte por preço suspeito', async (t) => {
  const { links } = linksDuble();
  const s = montar(t, { ofertas: [], links, verificador: verificadorComPreco({ 1: 10 }), ml: mlLido() });
  const id = regraListaCom(s.db, [[1, 100]], { per: 1 });
  await s.scheduler.runRule(id);
  assert.deepEqual(sairam(s, id), ['Saíram 0 de 1 oferta; 1 descartada (preço suspeito); não havia mais ofertas novas dentro dos filtros.']);
});

// ============================================================================================ CA2.13 (etapa 9)

test('CA2.13: pausa de verificação — ML fora da escolha, nenhuma linha Pulada, contagem em "Antes da escolha"', async (t) => {
  for (const [causa, frase] of [['ml_verificacao', 'o Mercado Livre pediu verificação no navegador'], ['limite_hora', 'o limite de conferências por hora foi atingido'],
    ['extensao_antiga', 'a extensão do Chrome precisa ser recarregada']]) {
    await t.test(causa, async (tt) => {
      const { links, estado } = linksDuble();
      const v = verificadorFalso(); v.pausa = causa;
      const s = montar(tt, { ofertas: [1, 2, 3].map((i) => oferta(i)), links, verificador: v });
      const id = regraCatalogo(s.db, { per: 2 });
      const r = await s.scheduler.runRule(id);
      assert.deepEqual([r.offers, r.puladas, v.conferidas, estado.pedidos], [0, 0, [], []], 'sem gastar tentativa nem pedido');
      assert.ok(s.logs(id).every((l) => !l.message.startsWith('Pulada')), 'nenhuma linha Pulada');
      assert.deepEqual(mensagens(s, id), [`Antes da escolha, 3 ofertas ficaram de fora: 3 do Mercado Livre com a leitura em pausa (${frase}). Nenhuma sobrou.`]);
      assert.deepEqual(s.estado.utilizaveis.at(-1), [false, false, false], 'não contam para o alvo da leitura do catálogo');
      // a pausa acaba: na execução seguinte elas saem
      v.pausa = null;
      const r2 = await s.scheduler.runRule(id);
      assert.equal(r2.offers, 2);
    });
  }
});

test('CA2.13: singular, e junto com outras categorias da linha "Antes da escolha"', async (t) => {
  const { links } = linksDuble();
  const v = verificadorFalso(); v.pausa = 'ml_verificacao';
  const s = montar(t, { ofertas: [oferta(1), oferta(2, { preco: 900 })], links, verificador: v });
  const id = Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min,
    window_start, window_end, dedupe_days, send_image, max_price, created_at) VALUES ('C', 1, 1, 1, '["111@g.us"]', 'list', '{}', ?, 1, 60, '00:00', '23:59', 7, 0, 500, ?)`)
    .run(JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['ml'] } }]), Date.now()).lastInsertRowid);
  await s.scheduler.runRule(id);
  assert.deepEqual(mensagens(s, id), ['Antes da escolha, 2 ofertas ficaram de fora: 1 fora dos filtros da regra, 1 do Mercado Livre com a leitura em pausa (o Mercado Livre pediu verificação no navegador). Nenhuma sobrou.']);
});

test('CA2.13: a espera da Central vence a pausa — as ofertas esperam (linha da espera) e não entram em "Antes da escolha"', async (t) => {
  const { links, estado } = linksDuble();
  estado.central = { estado: 'em_espera', testeLiberado: false };
  const v = verificadorFalso(); v.pausa = 'ml_verificacao';
  const s = montar(t, { ofertas: [1, 2].map((i) => oferta(i)), links, verificador: v });
  const id = regraCatalogo(s.db, { per: 1 });
  await s.scheduler.runRule(id);
  const m = mensagens(s, id);
  assert.ok(m.every((x) => !x.includes('leitura em pausa')), m.join(' | '));
  assert.ok(m.includes(`Catálogo do Etiqueta: 2 ofertas do Mercado Livre esperando: a Central de Afiliados não está respondendo. O programa testa de novo a cada ${TESTE_ESPERA_MIN} min e elas saem sozinhas quando ela voltar.`), m.join(' | '));
});

test('CA2.13: resposta de pausa fora da lista (outra causa, texto qualquer) não tira o ML da escolha', async (t) => {
  for (const p of ['desconectada', 'loja_fora', 'constructor', 1]) {
    await t.test(String(p), async (tt) => {
      const { links } = linksDuble();
      const v = verificadorFalso(); v.pausa = p;
      const s = montar(tt, { ofertas: [oferta(1)], links, verificador: v });
      const id = regraCatalogo(s.db, { per: 1 });
      assert.equal((await s.scheduler.runRule(id)).offers, 1);
    });
  }
});

test('CA2.13: a prévia ("Ver ofertas") não muda com a pausa da leitura', async (t) => {
  const { links } = linksDuble();
  const v = verificadorFalso(); v.pausa = 'ml_verificacao';
  const s = montar(t, { ofertas: [1, 2].map((i) => oferta(i)), links, verificador: v });
  const id = regraCatalogo(s.db, { per: 2 });
  const previa = await s.scheduler.previewOffers(id);
  assert.equal(previa.length, 2);
});
