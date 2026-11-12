// QA da entrega 2 de "Rodar sozinho" (Mercado Livre que se recupera), por cima do que o `dev` já provou em
// test/links-central.test.js e test/ml-recupera.test.js. Aqui entram os pontos que o QA quis ver derrubados:
//  - ponta a ponta SEM falsos no meio: serviço de links real + agendador real + verificador real, com a extensão
//    simulada só do outro lado do poll/submit (CA2.1, CA2.3, CA2.4, CA2.6);
//  - o teste da espera é de UM pedido só, mesmo com duas regras ao mesmo tempo;
//  - `falhasMl` (contador por regra e oferta: separado entre regras, zera ao sair, vence em 7 dias);
//  - bordas da queda de preço (CA2.11: 50% exato, centavos, R$ 0,00, queda_pct de 1 a 99) e a guarda da fila (CA2.12);
//  - migração do `falha_link` em bancos de antes da entrega 1, de antes da 2 e já migrados (CA2.17);
//  - versões da extensão (CA2.16) e os bugs achados na rodada 1 (Q1, Q2), corrigidos na rodada 2.
// Nenhum teste chama Mercado Livre, Etiqueta nem WhatsApp reais: fetch global proibido, WhatsApp simulado.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSetting, getSetting, MARCA_MIGRACAO_E2, textoMigracaoE2 } from '../src/db.js';
import { createScheduler, FALHAS_DA_OFERTA } from '../src/scheduler.js';
import { createLinkService, VERSAO_EXTENSAO, TESTE_ESPERA_MIN, FALHAS_PARA_ESPERA } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { createEnvios } from '../src/envios.js';
import { paraCandidato, quedaDePreco, motivosDeRevisao, QUEDA_REVISAO_PCT } from '../src/catalogo.js';
import { createVerificador, PAUSA_DESCARTADA_H } from '../src/verificador.js';
import { salvar as salvarRastreio } from '../src/rastreio.js';

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
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ml-recupera-')); pastas.push(p); return p; };

const MIN = 60000;
const HORA = 3600000;
const DIA = 24 * HORA;
const dia = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // novembro/2026, horário local
const idDe = (url) => /MLB-?(\d+)/.exec(String(url))?.[1] ?? null;
const n = (id) => Number(id) - 4000000000;
const TITULOS = ['Panela Pressão Elétrica Mondial', 'Cadeira Gamer Reclinável Azul', 'Mochila Notebook Executiva Couro', 'Aspirador Robô Inteligente Wifi',
  'Smartwatch Esportivo Prova Água', 'Luminária Mesa Articulada Led', 'Toalha Banho Algodão Egípcio', 'Kit Ferramentas Maleta Completa',
  'Fritadeira Elétrica Digital Forno', 'Tênis Corrida Amortecimento Leve', 'Violão Acústico Cordas Aço Iniciante', 'Impressora Multifuncional Tanque Tinta'];
const titulo = (i) => TITULOS[i - 1];
const mlb = (i) => `MLB${4000000000 + i}`;
const oferta = (i, { preco = 100 } = {}) => ({
  id: i, loja: 'ml', titulo: titulo(i), preco, preco_antigo: preco * 1.5, desconto_pct: 33, categoria: 'Casa', item_id: mlb(i), link: 'https://meli.la/TerCeiro1',
});

// Respostas da extensão (src/links.js submit)
const SEM_RESPOSTA = { ok: false, error: 'a Central de Afiliados do Mercado Livre não respondeu a tempo', tipo: 'sem_resposta' };
const lido = (price) => ({ ok: true, data: { estado: 'lido', ofertas: [{ nome: true, price, availability: 'https://schema.org/InStock' }] } });
const linkOk = (job) => ({ ok: true, link: `https://meli.la/Ok${job.id}x` });

/**
 * Extensão simulada sobre o serviço real: cada pedido do poll vai a `ext.responder(job)`. `jobs` é o que ela recebeu.
 * Anuncia produto_ml e a versão (`versao`). Para a qualquer momento (`parar()`), para simular o Chrome fechado.
 */
async function extensao(t, links, responder, { versao = VERSAO_EXTENSAO } = {}) {
  const ext = { jobs: [], responder, parou: false };
  const laco = (async () => {
    while (!ext.parou) {
      const job = await links.poll(15, { recursos: 'produto_ml', versao });
      if (job) { ext.jobs.push(job); links.submit(job.id, ext.responder(job)); }
    }
  })();
  ext.parar = async () => { ext.parou = true; await laco; };
  t.after(ext.parar);
  while (!links.status().online) await new Promise((ok) => { setTimeout(ok, 2); });
  ext.tipos = () => ext.jobs.map((j) => j.type);
  ext.limpar = () => { ext.jobs.length = 0; };
  ext.de = (tipo) => ext.jobs.filter((j) => j.type === tipo);
  return ext;
}

/**
 * Leva o relógio falso a `quando` (ms) e espera a extensão simulada falar de novo: o serviço de links só a considera
 * conectada se o último poll for de menos de 45 s (no relógio falso). Sem isto o "nenhum pedido" passaria de graça.
 */
async function irPara(t, links, quando) {
  t.mock.timers.setTime(quando);
  while (!links.status().online) await new Promise((ok) => { setTimeout(ok, 2); });
}

/** Agendador real + verificador real + serviço de links real (o `links` vem de fora, para o teste reabrir o mesmo banco). */
function montar(t, { ofertas, links, db, dir, verificador = true, grupos = [['111@g.us', 'Achadinhos']] }) {
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const estado = { ofertas };
  const fonte = {
    async candidatos(cfg, ctx) { return estado.ofertas.map(paraCandidato).filter((c) => c && !ctx.tratada(c, cfg.ordem)); },
    avancar() {},
  };
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const v = verificador === true ? createVerificador({ db, links }) : verificador; // `agora` do verificador: Date.now (Date falso do teste)
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador: v, catalogo: fonte, catalogoItens });
  for (const [jid, nome] of grupos) db.prepare('INSERT OR IGNORE INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  if (!db.prepare("SELECT 1 FROM tags WHERE name = 'etiquetaA'").get()) db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const logs = (id) => db.prepare('SELECT level, offer_title, message FROM log WHERE rule_id IS ? ORDER BY id').all(id).map((l) => ({ ...l }));
  const saiu = () => wa.simulated.map((m) => m.text.split('\n')[0].replace(/^\*|\*$/g, ''));
  return { db, dir, wa, links, scheduler, estado, catalogoItens, logs, saiu, verificador: v };
}

const regraCatalogo = (db, { per = 1, nome = 'Catálogo', dedupe = 7 } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id,
  group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES (?, 1, 1, 1, ?, 'list', '{}', ?, ?, 60, '00:00', '23:59', ?, 0, ?)`)
  .run(nome, JSON.stringify(['111@g.us']), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['ml'] } }]), per, dedupe, Date.now()).lastInsertRowid);
const itens = (db, id) => db.prepare('SELECT chave, status, motivos FROM catalogo_itens WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l, motivos: JSON.parse(l.motivos) }));
const mensagens = (s, id) => s.logs(id).map((l) => l.message);
const linhaDe = (s, id, i) => s.logs(id).filter((l) => l.offer_title === titulo(i)).map((l) => l.message);
const geral = (db) => db.prepare('SELECT level, message FROM log WHERE rule_id IS NULL ORDER BY id').all().map((l) => ({ ...l }));

const SEGUNDA = ' É a 2ª vez que falha; na 3ª ela vai para a revisão.';
const PULADA_LINK = 'Pulada: não deu para gerar o link de afiliado (a Central de Afiliados não respondeu). Tenta de novo no próximo envio.';

// ======================================================================================================== ponta a ponta

test('CA2.1/CA2.4/CA2.6 ponta a ponta (links + agendador + verificador reais): 3 falhas abrem a espera; ela não deixa passar NENHUM link nem produto_ml; depois de 5 min passa um só pedido; o reinício mantém a espera; a Central volta e as ofertas saem sozinhas', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const dir = tmp(); const db = openDb(dir);
  const novoServico = () => createLinkService({ getMode: () => 'extension', db, agora: () => Date.now() });
  let links = novoServico();
  const central = { responde: false };
  let ext = await extensao(t, links, (job) => (job.type === 'produto_ml' ? lido(100) : central.responde ? linkOk(job) : SEM_RESPOSTA));
  const montarCom = (l) => montar(t, { ofertas: [1, 2, 3, 4, 5, 6].map((i) => oferta(i)), links: l, db, dir });
  let s = montarCom(links);
  const id = regraCatalogo(db, { per: 2 });
  assert.equal(links.status().central.estado, 'sem_teste');

  // 1ª execução: as três primeiras falham (cada uma conta 1 para a oferta), a Central abre a espera, o resto nem é tentado
  const r1 = await s.scheduler.runRule(id);
  assert.deepEqual([r1.offers, r1.puladas, r1.revisao, r1.errors], [0, 3, 0, 0]);
  assert.deepEqual(ext.tipos(), ['produto_ml', 'link', 'produto_ml', 'link', 'produto_ml', 'link'], 'as outras três esperam sem pedido');
  let c = links.status().central;
  assert.deepEqual([c.estado, c.falhasSeguidas], ['em_espera', FALHAS_PARA_ESPERA]);
  assert.equal(c.emEsperaDesde, Date.now());
  assert.equal(c.proximoTesteEm, Date.now() + TESTE_ESPERA_MIN * MIN);
  assert.equal(links.status().online, true, 'a extensão segue conectada: o problema é a Central');
  const abriuEm = Date.now();

  // dentro dos 5 min: várias execuções e nenhum pedido de nenhum tipo chega à extensão
  ext.limpar();
  for (const passo of [1, 60, 2 * MIN, 2 * MIN - 1000]) {
    await irPara(t, links, Date.now() + passo);
    await s.scheduler.runRule(id);
  }
  assert.deepEqual(ext.jobs, [], 'durante a espera: nem link nem produto_ml');
  assert.ok(Date.now() - abriuEm < TESTE_ESPERA_MIN * MIN, 'ainda dentro dos 5 min');
  assert.ok(links.status().online, 'e a extensão estava conectada: a espera, não a extensão fora, é que segurou o ML');
  const espera = mensagens(s, id).filter((m) => /esperando/.test(m));
  assert.ok(espera.length >= 4 && espera.every((m) => /a Central de Afiliados não está respondendo/.test(m) && !/extensão do Chrome conectar/.test(m)), espera.join(' | '));
  assert.equal(links.central().estado, 'em_espera');
  assert.equal(await links.requestProduto({ url: 'https://produto.mercadolivre.com.br/MLB-4000000001' }).then((r) => r.falha), undefined, 'a leitura de produto fora do agendador não é bloqueada pela espera (neutra, plano Decisão 1)');
  ext.limpar();

  // passados os 5 min com a Central ainda fora: UM teste só (a candidata: conferência + um link), a espera é empurrada
  await irPara(t, links, abriuEm + TESTE_ESPERA_MIN * MIN);
  const r2 = await s.scheduler.runRule(id);
  assert.equal(ext.de('link').length, 1, 'um pedido de link só é o teste');
  assert.ok(ext.de('produto_ml').length <= 1, 'e no máximo uma conferência (da candidata de teste)');
  assert.deepEqual([r2.offers, r2.revisao, r2.errors], [0, 0, 0]);
  c = links.status().central;
  assert.equal(c.estado, 'em_espera');
  assert.equal(c.proximoTesteEm, Date.now() + TESTE_ESPERA_MIN * MIN, 'a falha do teste empurra o próximo para 5 min depois');
  assert.equal(c.falhasSeguidas, FALHAS_PARA_ESPERA + 1);
  assert.deepEqual(geral(db).map((l) => l.level), ['aviso'], 'a espera só gravou a linha de abrir; o teste que falha não grava linha geral nem erro');

  // reinício no meio da espera (serviço novo e agendador novo sobre o mesmo banco): mesma espera, mesmo horário de teste
  const proximo = c.proximoTesteEm;
  await ext.parar();
  links = novoServico();
  assert.deepEqual([links.central().estado, links.central().proximoTesteEm, links.central().emEsperaDesde], ['em_espera', proximo, abriuEm]);
  assert.equal(links.status().online, false, 'o serviço novo ainda não ouviu a extensão');
  ext = await extensao(t, links, (job) => (job.type === 'produto_ml' ? lido(100) : central.responde ? linkOk(job) : SEM_RESPOSTA));
  s = montarCom(links);
  await irPara(t, links, proximo - 1000);
  await s.scheduler.runRule(id);
  assert.deepEqual(ext.jobs, [], 'um segundo antes do teste, depois do reinício: nenhum pedido');

  // a Central volta; o teste liberado fecha a espera e as ofertas saem na mesma execução, sem ação do dono
  central.responde = true;
  await irPara(t, links, proximo);
  const r3 = await s.scheduler.runRule(id);
  assert.equal(r3.offers, 2);
  assert.equal(links.central().estado, 'respondendo');
  assert.equal(links.central().falhasSeguidas, 0);
  assert.equal(s.saiu().length, 2);
  const niveis = geral(db);
  assert.deepEqual(niveis.map((l) => l.level), ['aviso', 'info'], 'uma linha ao abrir, uma ao fechar; nada de erro');
  assert.match(niveis[1].message, /^Mercado Livre voltou: a Central de Afiliados respondeu ao teste \(esteve em espera por \d+ min\)/);
  assert.ok(!db.prepare("SELECT 1 FROM log WHERE level = 'erro'").get(), 'nenhuma linha erro (que alerta no WhatsApp) em todo o ciclo');
  assert.deepEqual(db.prepare('SELECT status FROM catalogo_itens WHERE rule_id = ? AND status = ?').all(id, 'revisao'), [], 'a Central fora nunca mandou oferta à revisão');
  // o contador de falhas de cada uma das 3 primeiras não chegou a 3 por causa da Central (D2): nada foi à revisão, e a 1ª saiu
  assert.ok(s.saiu().includes(titulo(1)) || s.saiu().includes(titulo(2)));
});

test('CA2.4 teste da espera é de UM pedido só: duas regras ao mesmo tempo com o teste liberado geram um único link à extensão', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const dir = tmp(); const db = openDb(dir);
  const links = createLinkService({ getMode: () => 'extension', db, agora: () => Date.now() });
  const central = { responde: false };
  const ext = await extensao(t, links, (job) => (job.type === 'produto_ml' ? lido(100) : central.responde ? linkOk(job) : SEM_RESPOSTA));
  const s = montar(t, { ofertas: [1, 2, 3, 4, 5, 6].map((i) => oferta(i)), links, db, dir });
  const a = regraCatalogo(db, { per: 1, nome: 'A' }); const b = regraCatalogo(db, { per: 1, nome: 'B' });
  for (let k = 0; k < FALHAS_PARA_ESPERA; k++) await links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-9', tag: 'etiquetaA' }).catch(() => {});
  assert.equal(links.central().estado, 'em_espera');
  await irPara(t, links, Date.now() + TESTE_ESPERA_MIN * MIN);
  assert.equal(links.central().testeLiberado, true);
  ext.limpar();
  const [ra, rb] = await Promise.all([s.scheduler.runRule(a), s.scheduler.runRule(b)]);
  assert.equal(ext.de('link').length, 1, 'dois pedidos ao mesmo tempo nunca são dois testes');
  assert.deepEqual([ra.errors, rb.errors], [0, 0]);
  assert.equal(links.central().estado, 'em_espera', 'a Central ainda fora: o teste falhou');
  assert.ok(!db.prepare("SELECT 1 FROM log WHERE level = 'erro'").get());
  assert.deepEqual(itens(db, a).concat(itens(db, b)), [], 'a perdedora do teste espera; não vai à revisão');
  void central;
});

test('CA2.4 a extensão que cai com a espera aberta: nada muda no estado da Central (desconectada não gasta o teste) e, ao voltar, o teste ainda é o próximo pedido', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const dir = tmp(); const db = openDb(dir);
  const links = createLinkService({ getMode: () => 'extension', db, agora: () => Date.now() });
  let ext = await extensao(t, links, () => SEM_RESPOSTA);
  for (let k = 0; k < FALHAS_PARA_ESPERA; k++) await links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-9', tag: 'etiquetaA' }).catch(() => {});
  const antes = links.central();
  await ext.parar();
  t.mock.timers.setTime(Date.now() + TESTE_ESPERA_MIN * MIN + 60000); // o teste estaria liberado, mas a extensão sumiu (45 s sem poll)
  assert.equal(links.status().online, false);
  const e = await links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-9', tag: 'etiquetaA' }).catch((x) => x);
  assert.equal(e.classe, 'desconectada');
  assert.deepEqual([links.central().proximoTesteEm, links.central().falhasSeguidas], [antes.proximoTesteEm, antes.falhasSeguidas], 'extensão fora não gasta o teste nem conta falha');
  ext = await extensao(t, links, linkOk);
  assert.equal((await links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-9', tag: 'etiquetaA' })).startsWith('https://meli.la/'), true);
  assert.equal(links.central().estado, 'respondendo');
  void ext;
});

// ======================================================================================================== grupos de etiquetas diferentes (R1)

test('R1 ponta a ponta com grupos de etiquetas diferentes: a candidata de teste que falha fica 6 h fora e o teste seguinte usa outra, nas duas ordens dos grupos', async (t) => {
  for (const ordem of [['111@g.us', '222@g.us'], ['222@g.us', '111@g.us']]) {
    await t.test(ordem.join(' → '), async (st) => {
      st.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
      const dir = tmp(); const db = openDb(dir);
      const links = createLinkService({ getMode: () => 'extension', db, agora: () => Date.now() });
      const central = { responde: false };
      const ext = await extensao(st, links, (job) => (job.type === 'produto_ml' ? lido(100) : central.responde ? linkOk(job) : SEM_RESPOSTA));
      const s = montar(st, { ofertas: [1, 2, 3, 4, 5, 6].map((i) => oferta(i)), links, db, dir, grupos: [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']] });
      db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaB', Date.now());
      salvarRastreio(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaB' });
      const id = Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
        VALUES ('Misto', 1, 1, 1, ?, 'list', '{}', ?, 1, 60, '00:00', '23:59', 7, 0, ?)`)
        .run(JSON.stringify(ordem), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['ml'] } }]), Date.now()).lastInsertRowid);
      // a Central cai: com 1 oferta por execução e 2 códigos por oferta, a espera abre dentro da 2ª oferta
      await s.scheduler.runRule(id);
      assert.equal(links.central().estado, 'em_espera');
      const abriu = Date.now();
      // teste liberado: a candidata é uma oferta; os outros códigos dela são recusados sem pedido
      await irPara(st, links, abriu + TESTE_ESPERA_MIN * MIN);
      ext.limpar();
      const r = await s.scheduler.runRule(id);
      assert.equal(ext.de('link').length, 1, 'um pedido de link só: o teste');
      assert.equal(r.revisao, 0);
      const candidata = n(idDe(ext.de('link')[0].url));
      assert.ok(linhaDe(s, id, candidata).some((m) => m.includes(`Fica ${PAUSA_DESCARTADA_H} h fora da escolha`)), `candidata ${candidata}: ${s.logs(id).map((l) => l.message).join(' | ')}`);
      assert.deepEqual(itens(db, id).filter((i) => i.status === 'revisao'), []);
      // o teste seguinte usa OUTRA oferta
      await irPara(st, links, Date.now() + TESTE_ESPERA_MIN * MIN);
      ext.limpar();
      await s.scheduler.runRule(id);
      const outra = n(idDe(ext.de('link')[0].url));
      assert.notEqual(outra, candidata, 'a veneno não segura o teste seguinte');
      // a Central volta: as ofertas saem (menos a que está em pausa de 6 h)
      central.responde = true;
      await irPara(st, links, Date.now() + TESTE_ESPERA_MIN * MIN);
      await s.scheduler.runRule(id);
      assert.equal(links.central().estado, 'respondendo');
      assert.ok(s.wa.simulated.length >= 1);
      assert.ok(!s.saiu().includes(titulo(candidata)), 'a candidata que falhou no teste segue 6 h fora');
      assert.ok(!db.prepare("SELECT 1 FROM log WHERE level = 'erro'").get());
    });
  }
});

test('S2 recusa não definitiva do ML: a Central respondeu — três seguidas não abrem a espera e uma, com a espera aberta, a fecha; a oferta é que falha', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const dir = tmp(); const db = openDb(dir);
  const links = createLinkService({ getMode: () => 'extension', db, agora: () => Date.now() });
  const resp = { atual: { ok: false, error: 'Error: etiqueta inválida (etiqueta "etiquetaA")', tipo: 'recusa' } };
  const ext = await extensao(t, links, () => resp.atual);
  const pedir = () => links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-9', tag: 'etiquetaA' }).catch((e) => e);
  for (let k = 0; k < 4; k++) { const e = await pedir(); assert.equal(e.causa, 'recusa_ml'); assert.equal(e.classe, 'passageira', 'segue passageira para a oferta (D6)'); }
  assert.deepEqual([links.central().estado, links.central().falhasSeguidas], ['sem_teste', 0], 'a Central respondeu: nada de espera, nada de falha acumulada (e ainda sem link gerado)');
  // com a espera aberta por falhas de verdade, a recusa que chega no teste a fecha
  resp.atual = SEM_RESPOSTA;
  for (let k = 0; k < FALHAS_PARA_ESPERA; k++) await pedir();
  assert.equal(links.central().estado, 'em_espera');
  await irPara(t, links, Date.now() + TESTE_ESPERA_MIN * MIN);
  resp.atual = { ok: false, error: 'Error: etiqueta inválida (etiqueta "etiquetaA")', tipo: 'recusa' };
  await pedir();
  assert.equal(links.central().estado, 'respondendo');
  assert.equal(geral(db).at(-1).level, 'info');
  void ext;
});

// ======================================================================================================== falhasMl

/**
 * Extensão que falha só o link da oferta 1 (a "ruim", sempre à frente na lista) e lê tudo como R$ 100. As outras
 * (2 a 12) saem: cada link gerado zera a contagem da Central, então a espera NUNCA abre e o que se mede é só o
 * contador por oferta (`falhasMl`).
 */
function mundoFalhasMl(t, { ruins = new Set([1]), regras = ['Catálogo'] } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const dir = tmp(); const db = openDb(dir);
  const links = createLinkService({ getMode: () => 'extension', db, agora: () => Date.now() });
  const novoAgendador = () => montar(t, { ofertas: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => oferta(i)), links, db, dir });
  const ext = extensao(t, links, (job) => (job.type === 'produto_ml' ? lido(100) : ruins.has(n(idDe(job.url))) ? SEM_RESPOSTA : linkOk(job)));
  return { dir, db, links, ruins, ext, novoAgendador, regras: regras.map((nome) => regraCatalogo(db, { per: 1, nome })) };
}

test('CA2.3 falhasMl: duas regras com a mesma oferta contam separado (a 3ª de uma não leva a outra à revisão)', async (t) => {
  const m = mundoFalhasMl(t, { regras: ['A', 'B'] }); await m.ext;
  const s = m.novoAgendador(); const [A, B] = m.regras;
  await s.scheduler.runRule(A); // A: 1ª
  await s.scheduler.runRule(A); // A: 2ª
  assert.ok(linhaDe(s, A, 1).at(-1).endsWith(SEGUNDA), 'A está na 2ª falha');
  await s.scheduler.runRule(B); // B: 1ª (a mesma oferta, outra regra)
  assert.equal(linhaDe(s, B, 1).at(-1), PULADA_LINK, 'B é a 1ª falha dela: nenhuma menção à 2ª vez');
  assert.ok(!itens(m.db, B).some((i) => i.status === 'revisao'));
  await s.scheduler.runRule(A); // A: 3ª → revisão
  assert.deepEqual(itens(m.db, A).filter((i) => i.status === 'revisao'), [{ chave: mlb(1), status: 'revisao', motivos: ['falhas_repetidas'] }]);
  assert.ok(!itens(m.db, B).some((i) => i.status === 'revisao'), 'B segue sem item na revisão: a contagem é por regra');
  await s.scheduler.runRule(B); // B: 2ª
  assert.ok(linhaDe(s, B, 1).at(-1).endsWith(SEGUNDA));
  assert.equal(m.links.central().estado, 'respondendo', 'nenhuma espera: os links das outras zeram a contagem da Central');
});

test('CA2.3 falhasMl: a oferta que sai zera a contagem (duas falhas, sai, falha de novo = 1ª de novo)', async (t) => {
  const m = mundoFalhasMl(t); await m.ext;
  const s = m.novoAgendador(); const [id] = m.regras;
  await s.scheduler.runRule(id); await s.scheduler.runRule(id); // 2 falhas
  m.ruins.clear();
  await s.scheduler.runRule(id); // a 1 sai
  assert.ok(s.saiu().includes(titulo(1)));
  // some da lista de tratadas e volta a falhar: é a 1ª
  m.db.prepare("DELETE FROM catalogo_itens WHERE chave = ?").run(mlb(1));
  m.db.prepare("DELETE FROM sent_offers WHERE offer_key = ?").run(mlb(1));
  m.ruins.add(1);
  await s.scheduler.runRule(id);
  assert.equal(linhaDe(s, id, 1).at(-1), PULADA_LINK, 'a contagem tinha zerado quando ela saiu');
});

test('CA2.3 falhasMl: falhas com mais de 7 dias de intervalo não se somam (o mapa não guarda para sempre)', async (t) => {
  const m = mundoFalhasMl(t); await m.ext;
  const s = m.novoAgendador(); const [id] = m.regras;
  await s.scheduler.runRule(id); // 1ª
  await irPara(t, m.links, Date.now() + 6 * DIA);
  await s.scheduler.runRule(id); // 2ª (6 dias depois: ainda vale)
  assert.ok(linhaDe(s, id, 1).at(-1).endsWith(SEGUNDA));
  await irPara(t, m.links, Date.now() + 8 * DIA);
  await s.scheduler.runRule(id); // 8 dias depois da última: recomeça
  assert.equal(linhaDe(s, id, 1).at(-1), PULADA_LINK, 'a contagem velha foi esquecida');
  assert.ok(!itens(m.db, id).some((i) => i.status === 'revisao'));
});

test('CA2.3 falhasMl: o reinício do agendador zera a contagem (premissa P1: no pior caso 2 tentativas a mais) e nunca manda oferta à revisão por isso', async (t) => {
  const m = mundoFalhasMl(t); await m.ext;
  let s = m.novoAgendador(); const [id] = m.regras;
  await s.scheduler.runRule(id); await s.scheduler.runRule(id);
  s = m.novoAgendador(); // agendador novo, mesmo banco
  await s.scheduler.runRule(id);
  assert.ok(!itens(m.db, id).some((i) => i.status === 'revisao'), 'depois do reinício a 3ª "só" é a 1ª');
  assert.equal(linhaDe(s, id, 1).at(-1), PULADA_LINK);
});

// ======================================================================================================== queda de preço

/** Roda uma regra do Catálogo com o ML lido (pela extensão simulada) a `conferido`; a lista traz R$ `lista`. */
async function comPrecoConferido(t, { lista, conferido }) {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const dir = tmp(); const db = openDb(dir);
  const links = createLinkService({ getMode: () => 'extension', db, agora: () => Date.now() });
  const ext = await extensao(t, links, (job) => (job.type === 'produto_ml' ? lido(conferido) : linkOk(job)));
  const s = montar(t, { ofertas: [oferta(1, { preco: lista })], links, db, dir });
  const id = regraCatalogo(db, { per: 1 });
  const r = await s.scheduler.runRule(id);
  const item = db.prepare('SELECT status, motivos, oferta FROM catalogo_itens WHERE rule_id = ?').get(id);
  s.id = id;
  return { r, s, id, ext, item: item && { status: item.status, motivos: JSON.parse(item.motivos), oferta: JSON.parse(item.oferta) } };
}

test('CA2.11 queda em centavos: 50,00% exatos vão à revisão com queda_preco e a % no item; 49,99% saem (100 → 50,00 × 50,01 e 199,90 → 99,95 × 99,96)', async (t) => {
  for (const [lista, conferido, vai] of [[100, 50, true], [100, 50.01, false], [199.9, 99.95, true], [199.9, 99.96, false], [100, 51, false], [100, 49, true], [100, 10, true]]) {
    await t.test(`${lista} → ${conferido}`, async (st) => {
      const { r, item, s } = await comPrecoConferido(st, { lista, conferido });
      if (vai) {
        assert.deepEqual([r.offers, r.revisao], [0, 1]);
        assert.equal(item.status, 'revisao');
        assert.ok(item.motivos.includes('queda_preco'), item.motivos.join());
        assert.equal(item.oferta.queda_pct, quedaDePreco(lista, conferido));
        assert.equal(item.oferta.price, conferido, 'a revisão mostra o preço conferido');
        assert.equal(s.wa.simulated.length, 0);
        // com 1 motivo a ação vem logo depois (", confira o preço."); com 2 ou mais, uma vez só no fim (". Confira o preço.", achado D1)
        assert.ok(mensagens(s, s.id).some((m) => m.startsWith('Separada para revisão: ') && m.includes(`o preço está ${item.oferta.queda_pct}% abaixo do preço da lista (o limite é ${QUEDA_REVISAO_PCT}%)`)
          && (item.motivos.length === 1 ? m.endsWith(', confira o preço.') : m.endsWith('. Confira o preço.'))), mensagens(s, s.id).join(' | '));
      } else {
        assert.deepEqual([r.offers, r.revisao], [1, 0]);
        assert.equal(item.status, 'enviado');
        assert.ok(s.wa.simulated[0].text.includes(String(conferido).replace('.', ',')), s.wa.simulated[0].text);
      }
    });
  }
});

test('CA2.11 quedaDePreco: o piso exato em centavos, sem erro de ponto flutuante, equivale à conta inteira (limite 50 = "conferido × 2 ≤ lista")', () => {
  assert.equal(QUEDA_REVISAO_PCT, 50);
  // semente fixa: LCG, sem Math.random
  let x = 123456789;
  const rnd = (m) => { x = (x * 1103515245 + 12345) % 2147483648; return x % m; };
  for (let k = 0; k < 4000; k++) {
    const lc = 1 + rnd(2000000); const cc = rnd(lc + 1); // centavos; conferido <= lista
    const q = quedaDePreco(lc / 100, cc / 100);
    assert.equal(q, Math.floor(((lc - cc) * 100) / lc), `${lc / 100} → ${cc / 100}`);
    assert.equal(q >= QUEDA_REVISAO_PCT, cc * 2 <= lc, `limite exato: ${lc / 100} → ${cc / 100} (queda ${q})`);
    assert.equal(motivosDeRevisao({ loja: 'ml', price: cc / 100, discountPct: 0 }, { precoLista: lc / 100 }).includes('queda_preco'), cc * 2 <= lc, `${lc / 100} → ${cc / 100}`);
  }
  assert.equal(quedaDePreco(100, 100), 0);
  assert.equal(quedaDePreco(100, 101), null, 'subiu: nada a medir');
  assert.equal(quedaDePreco(0, 0), null);
  assert.equal(quedaDePreco(100, 0), 100, 'conferido zero = queda de 100%');
  for (const ruim of [null, undefined, '', 'abc', NaN, {}, -1]) {
    assert.equal(quedaDePreco(ruim, 10), null, `lista ${String(ruim)}`);
    assert.equal(quedaDePreco(100, ruim), null, `conferido ${String(ruim)}`);
  }
});

test('CA2.11 queda_pct no item: 1 a 99 é guardado e volta na lista; 100 (R$ 0,00) e lixo não são; a oferta com preço 0 nem é registrada (preço obrigatório)', async (t) => {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true });
  const ci = createCatalogoItens({ db, wa, links: createLinkService({ getMode: () => 'fake' }) });
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', 1);
  db.prepare("INSERT INTO templates (name, body, created_at) VALUES ('t', '{TITULO_PRODUTO}', 1)").run();
  const id = regraCatalogo(db, {});
  const rule = { id };
  const of = (i, price) => ({ key: mlb(i), loja: 'ml', title: titulo(i), price, oldPrice: null, discountPct: null });
  const casos = [[1, 62, 62], [2, 99, 99], [3, 1, 1], [4, 100, undefined], [5, 0, undefined], [6, 49.5, undefined], [7, '70', undefined], [8, null, undefined]];
  for (const [i, pct] of casos) assert.equal(ci.registrar(rule, of(i, 50), 'revisao', ['queda_preco'], { quedaPct: pct }), true, `registra mesmo com queda_pct=${String(pct)}`);
  const lista = ci.listar({ regra: id, status: 'revisao' }).itens;
  for (const [i, , esperado] of casos) {
    const it = lista.find((x) => x.oferta.title === titulo(i));
    assert.equal(it.queda_pct, esperado, `queda_pct de ${titulo(i)}`);
    assert.deepEqual(it.motivos, ['queda_preco']);
  }
  // sem o motivo, a % não vai (e o motivo some sem lista): só quem tem queda_preco leva queda_pct
  assert.equal(ci.registrar(rule, of(9, 50), 'revisao', ['desconto_100'], { quedaPct: 70 }), true);
  assert.equal(ci.listar({ regra: id, status: 'revisao' }).itens.find((x) => x.oferta.title === titulo(9)).queda_pct, undefined);
  // preço 0 não é registrável (o Catálogo exige preço > 0): a queda de 100% nunca chega à revisão por esta porta
  assert.equal(ci.registrar(rule, of(10, 0), 'revisao', ['queda_preco'], { quedaPct: 100 }), false);
  void t;
});

test('CA2.11/borda: a leitura R$ 0,00 do ML nunca vira "queda de 100%": é preço não lido (pulada), sem revisão e sem a frase falsa "revisão cheia"', async (t) => {
  const { r, s, id, item } = await comPrecoConferido(t, { lista: 100, conferido: 0 });
  assert.equal(s.wa.simulated.length, 0, 'R$ 0,00 nunca sai');
  assert.equal(item, undefined, 'nada vai ao Catálogo');
  assert.deepEqual([r.offers, r.revisao, r.errors], [0, 0, 0]);
  const msgs = mensagens(s, id);
  assert.ok(!msgs.some((m) => /revisão desta regra está cheia|revisão cheia/.test(m)), msgs.join(' | '));
  assert.ok(msgs.some((m) => /^Pulada: não dá para saber o preço/.test(m)), msgs.join(' | '));
});

// ======================================================================================================== guarda da fila (CA2.12)

const G1 = '111@g.us';
const URL_ML = 'https://produto.mercadolivre.com.br/MLB-1234567890';
const CORPO = '{TITULO_PRODUTO}\nPor {PRECO_PRODUTO}[ (de {PRECO_ANTIGO})]\n{LINK}';

/** Fila de envios real com o verificador real lendo o ML por um leitor falso (`estado.leitura`). */
function montarFila(t) {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const estado = { leitura: { price: 89.9, disponivel: true } };
  const ml = { async resolveOffer(c) { return { key: c.key, url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40 }; }, async conferirProduto() { return { ...estado.leitura }; } };
  const verificador = createVerificador({ db, ml });
  const envios = createEnvios({ db, wa, links, ml, fast: true, dir, acordar: () => {}, verificador });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(G1, 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run('etiquetaA');
  // o envio guarda o created_at do template; um Date.now() próprio no gravar caía às vezes no milissegundo seguinte e a
  // fila recusava com "o template foi apagado" (teste instável: 2 em 20)
  const tplCriado = Date.now();
  const tpl = Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('t', CORPO, tplCriado).lastInsertRowid);
  const gravar = (offer, precoLoja) => {
    const payload = { url: URL_ML, loja: 'mercadolivre', preco_loja: precoLoja, tag_id: 1, etiqueta: 'etiquetaA', template_id: tpl, template_criado_em: tplCriado, enviar_foto: false,
      offer: { key: 'MLB1234567890', title: 'Fone Bom', sold: null, freeShipping: false, coupon: null, image: null, ...offer } };
    const agora = Date.now();
    return Number(db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at) VALUES ('oferta', ?, ?, 'agora', 'pendente', ?, ?)`)
      .run(JSON.stringify(payload), JSON.stringify([G1]), agora, agora).lastInsertRowid);
  };
  const resultado = (id) => { const e = db.prepare('SELECT status, resultado FROM envios WHERE id = ?').get(id); return { status: e.status, ...JSON.parse(e.resultado ?? 'null') }; };
  return { db, wa, envios, estado, gravar, resultado };
}

test('CA2.12 limite da guarda da fila (aceito pelo plano): só vale quando a conferência TROCA o preço — preço lido errado na criação e só confirmado depois sai', async (t) => {
  const s = montarFila(t);
  // "parcela no lugar do preço" lida já na criação (R$ 1,99 "de R$ 199,90"), e a conferência de agora lê o mesmo valor
  s.estado.leitura = { price: 1.99, disponivel: true };
  const id = s.gravar({ price: 1.99, oldPrice: 199.9, discountPct: 99 }, 1.99);
  await s.envios.processarPendentes();
  assert.equal(s.resultado(id).status, 'concluido', 'o preço igual não foi "trocado pela conferência": a guarda não age');
  assert.match(s.wa.simulated.at(-1).text, /Por R\$ 1,99 \(de R\$ 199,90\)/);
  // já a mesma oferta com a leitura de agora DIFERENTE (queda para a parcela) é barrada
  const s2 = montarFila(t);
  s2.estado.leitura = { price: 1.99, disponivel: true };
  const id2 = s2.gravar({ price: 89.9, oldPrice: 199.9, discountPct: 55 }, 89.9);
  await s2.envios.processarPendentes();
  assert.equal(s2.resultado(id2).descartado, 'preco_suspeito');
  assert.equal(s2.wa.simulated.length, 0);
});

test('CA2.12 a queda de 50% ou mais também é guarda da fila (como na fonte antiga e no Catálogo; achados R3/S1)', async (t) => {
  const s = montarFila(t);
  s.estado.leitura = { price: 35.9, disponivel: true }; // 89,90 → 35,90: queda de 60%, sem preço antigo suspeito
  const id = s.gravar({ price: 89.9, oldPrice: 149.9, discountPct: 40 }, 89.9);
  await s.envios.processarPendentes();
  assert.deepEqual([s.resultado(id).status, s.resultado(id).descartado], ['erro', 'preco_suspeito']);
  assert.equal(s.wa.simulated.length, 0, 'nada sai');
});

test('CA2.12 a fila com a leitura R$ 0,00 ou inválida nunca manda preço zero (preço lido ≤ 0 é "sem preço", não 100% de queda)', async (t) => {
  const s = montarFila(t);
  s.estado.leitura = { price: 0, disponivel: true };
  const id = s.gravar({ price: 89.9, oldPrice: 149.9, discountPct: 40 }, 89.9);
  await s.envios.processarPendentes();
  assert.ok(!/Por R\$ 0,00/.test(s.wa.simulated.at(-1)?.text ?? ''), 'R$ 0,00 não sai');
  void id;
});

// ======================================================================================================== migração (CA2.17)

/** Banco como o de uma instalação anterior: abre, apaga as marcas das migrações e grava itens em revisão. */
function bancoAntigo(dir, { marcas = [] } = {}) {
  const db = openDb(dir);
  for (const m of ['migracao_e1_nao_conferido', MARCA_MIGRACAO_E2]) if (!marcas.includes(m)) db.prepare('DELETE FROM settings WHERE key = ?').run(m);
  db.prepare("DELETE FROM log").run();
  return db;
}
const inserir = (db, { chave, status = 'revisao', motivos, regra = 1 }) => db.prepare(`INSERT INTO catalogo_itens (rule_id, chave, loja, status, motivos, oferta, envio_id, criado_em, decidido_em)
  VALUES (?, ?, 'ml', ?, ?, ?, NULL, 1, ?)`).run(regra, chave, status, JSON.stringify(motivos), JSON.stringify({ title: chave, price: 10 }), status === 'revisao' ? null : 2);
const chaves = (db) => db.prepare('SELECT chave, status FROM catalogo_itens ORDER BY id').all().map((l) => `${l.chave}:${l.status}`);

test('CA2.17 migração: tira da revisão só os itens com motivos exatamente ["falha_link"], uma vez, com a contagem no Histórico (banco de antes da entrega 1)', () => {
  const dir = tmp();
  let db = bancoAntigo(dir);
  inserir(db, { chave: 'MLB1', motivos: ['falha_link'] });
  inserir(db, { chave: 'MLB2', motivos: ['falha_link'] });
  inserir(db, { chave: 'MLB3', motivos: ['falha_link', 'preco_antigo'] }); // fica: tem outro motivo
  inserir(db, { chave: 'MLB4', motivos: ['preco_antigo', 'falha_link'] }); // fica (ordem diferente, mas ainda "mais de um")
  inserir(db, { chave: 'MLB5', motivos: ['nao_conferido'] }); // a migração da entrega 1 tira
  inserir(db, { chave: 'MLB6', motivos: ['falha_link'], status: 'enviado' }); // fica: já foi tratado
  inserir(db, { chave: 'MLB7', motivos: ['falha_link'], status: 'descartado' }); // fica
  inserir(db, { chave: 'MLB8', motivos: ['shopee'] }); // fica
  inserir(db, { chave: 'MLB9', motivos: ['falha_link'], regra: 2 }); // outra regra: também sai (a migração é do banco)
  db.close();
  db = openDb(dir);
  assert.deepEqual(chaves(db), ['MLB3:revisao', 'MLB4:revisao', 'MLB6:enviado', 'MLB7:descartado', 'MLB8:revisao']);
  const linhas = db.prepare("SELECT level, message FROM log ORDER BY id").all().map((l) => ({ ...l }));
  assert.ok(linhas.some((l) => l.level === 'info' && l.message === textoMigracaoE2(3)), linhas.map((l) => l.message).join(' | '));
  assert.equal(getSetting(db, MARCA_MIGRACAO_E2), '1');
  // uma vez só: um item novo com falha_link (Amazon sem padrão grava assim) NÃO é apagado na abertura seguinte
  inserir(db, { chave: 'ASIN:X', motivos: ['falha_link'] });
  const antesDoLog = db.prepare('SELECT COUNT(*) AS c FROM log').get().c;
  db.close();
  db = openDb(dir);
  assert.ok(chaves(db).includes('ASIN:X:revisao'), 'segunda abertura não apaga de novo');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM log').get().c, antesDoLog, 'e não repete a linha do Histórico');
  db.close();
});

test('CA2.17 migração em banco já na entrega 1 (marca da E1 presente): só a da E2 roda; em banco já migrado nada muda; banco sem catálogo não ganha linha', () => {
  const dir = tmp();
  let db = bancoAntigo(dir, { marcas: ['migracao_e1_nao_conferido'] });
  inserir(db, { chave: 'MLB1', motivos: ['nao_conferido'] }); // a E1 já passou: este fica (a migração da E1 não roda de novo)
  inserir(db, { chave: 'MLB2', motivos: ['falha_link'] });
  db.close();
  db = openDb(dir);
  assert.deepEqual(chaves(db), ['MLB1:revisao']);
  db.close();
  // singular e zero
  const dir2 = tmp();
  db = bancoAntigo(dir2);
  inserir(db, { chave: 'MLB1', motivos: ['falha_link'] });
  db.close();
  db = openDb(dir2);
  assert.ok(db.prepare("SELECT message FROM log WHERE level = 'info'").all().some((l) => l.message === textoMigracaoE2(1)));
  assert.match(textoMigracaoE2(1), /^Revisão do Catálogo: 1 oferta que esperava revisão só porque o link não foi gerado saiu da fila\./);
  assert.match(textoMigracaoE2(0), /nenhuma oferta esperava revisão só porque o link não foi gerado\.$/);
  db.close();
  // instalação nova (catálogo vazio): marca gravada, nenhuma linha
  const dir3 = tmp();
  db = openDb(dir3);
  assert.equal(getSetting(db, MARCA_MIGRACAO_E2), '1');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM log WHERE message LIKE 'Revisão do Catálogo:%'").get().c, 0);
  db.close();
});

test('CA2.17 migração: falha no meio não deixa marca nem apaga meia fila (tudo ou nada) e o programa sobe', () => {
  const dir = tmp();
  let db = bancoAntigo(dir);
  inserir(db, { chave: 'MLB1', motivos: ['falha_link'] });
  // gatilho que quebra o DELETE: simula o banco falhando no meio da transação
  db.exec("CREATE TRIGGER quebra BEFORE DELETE ON catalogo_itens BEGIN SELECT RAISE(ABORT, 'boom'); END");
  db.close();
  const erros = []; const antes = console.error; console.error = (...a) => erros.push(a.join(' '));
  try { db = openDb(dir); } finally { console.error = antes; }
  assert.deepEqual(chaves(db), ['MLB1:revisao'], 'o item continua na revisão');
  assert.equal(getSetting(db, MARCA_MIGRACAO_E2), null, 'sem marca: tenta de novo na próxima abertura');
  assert.ok(erros.some((e) => e.includes('não consegui tirar da revisão')), erros.join(' | '));
  assert.ok(!erros.join(' ').includes('boom'), 'a mensagem do banco não vai ao console');
  db.exec('DROP TRIGGER quebra');
  db.close();
  db = openDb(dir);
  assert.deepEqual(chaves(db), [], 'na próxima abertura, sem o defeito, sai');
  assert.equal(getSetting(db, MARCA_MIGRACAO_E2), '1');
  db.close();
});

// ======================================================================================================== versões (CA2.16)

test('CA2.16 versão da extensão compara número a número (1.10.0 é mais nova que 1.6.0; 1.5.99 é mais antiga; 1.6 e "1.6.0-beta" não valem como versão)', () => {
  const casos = [['1.6.0', false], ['1.6.1', false], ['1.10.0', false], ['2.0.0', false], ['999.999.999', false], ['1.5.99', true], ['1.5.0', true], ['0.9.9', true],
    ['01.6.0', false], ['1.6', true], ['1.6.0-beta', true], ['1.6.0.1', true], ['', true], [undefined, true], [null, true], ['1.6.x', true], [160, true]];
  for (const [v, antiga] of casos) {
    const links = createLinkService({ getMode: () => 'extension' });
    links.poll(1, { versao: v });
    assert.equal(links.status().desatualizada, antiga, `x-versao=${String(v)}`);
    assert.equal(links.status().versaoEsperada, VERSAO_EXTENSAO);
  }
  assert.equal(VERSAO_EXTENSAO, JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'extension', 'manifest.json'), 'utf8')).version, 'manifest e servidor na mesma versão');
});

// ======================================================================================================== docs (CA2.10)

test('CA2.10 o passo de recarregar a extensão (atualizar a pasta extension, chrome://extensions, seta circular, "Extensão desatualizada") está no cartão, na ajuda, nos Docs e no README, e a versão citada é a do manifest', () => {
  const raiz = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const ler = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');
  const versao = JSON.parse(ler('extension', 'manifest.json')).version;
  const lugares = { 'public/conexoes.js': ler('public', 'conexoes.js'), 'public/ajuda.js': ler('public', 'ajuda.js'), 'cap-referencia': ler('public', 'docs', 'cap-referencia.js'),
    'cap-conta': ler('public', 'docs', 'cap-conta.js'), 'cap-comecar': ler('public', 'docs', 'cap-comecar.js'), README: ler('README.md') };
  for (const [nome, txt] of Object.entries(lugares)) {
    assert.match(txt, /chrome:\/\/extensions/, `${nome}: o caminho do passo`);
    assert.match(txt, /seta circular/, `${nome}: o botão de recarregar`);
  }
  for (const nome of ['public/ajuda.js', 'cap-referencia', 'cap-conta', 'cap-comecar', 'README']) assert.ok(lugares[nome].includes(versao), `${nome} cita a versão ${versao}`);
  assert.match(lugares.README + lugares['cap-referencia'], /Extensão desatualizada/);
  assert.match(lugares['public/ajuda.js'], /Central sem resposta/);
  assert.equal(versao, VERSAO_EXTENSAO);
  assert.match(ler('extension', 'popup.html') + ler('extension', 'popup.js'), /versao/i, 'o popup mostra a versão do manifest');
});

// ======================================================================================================== bugs da rodada 1 (eram `todo`)

test('Q1 (baixo): HTTP 404 de UMA página de produto (anúncio que saiu do ar) não conta como falha da CENTRAL — três seguidas não abrem a espera "Central sem resposta"', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const dir = tmp(); const db = openDb(dir);
  const links = createLinkService({ getMode: () => 'extension', db, agora: () => Date.now() });
  await extensao(t, links, (job) => (job.type === 'produto_ml' ? { ok: false, error: 'a página do produto respondeu HTTP 404' } : linkOk(job)));
  const s = montar(t, { ofertas: [1, 2, 3, 4].map((i) => oferta(i)), links, db, dir });
  const id = regraCatalogo(db, { per: 1 });
  await s.scheduler.runRule(id);
  assert.notEqual(links.central().estado, 'em_espera', 'a Central de Afiliados não foi consultada: só páginas de produto devolveram 404');
});

test('Q2 (baixo): fonte "Central de Afiliados" na espera não grava linha `erro` por execução (alerta no WhatsApp), como as outras esperas', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(11, 14) });
  const dir = tmp(); const db = openDb(dir);
  const links = createLinkService({ getMode: () => 'extension', db, agora: () => Date.now() });
  const ext = await extensao(t, links, () => SEM_RESPOSTA);
  for (let k = 0; k < FALHAS_PARA_ESPERA; k++) await links.requestLink({ url: 'https://produto.mercadolivre.com.br/MLB-9', tag: 'etiquetaA' }).catch(() => {});
  const s = montar(t, { ofertas: [], links, db, dir });
  const id = Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('Central', 1, 1, 1, ?, 'afiliados', '{}', 1, 60, '00:00', '23:59', 7, 0, ?)`).run(JSON.stringify(['111@g.us']), Date.now()).lastInsertRowid);
  ext.limpar();
  const r = await s.scheduler.runRule(id);
  await s.scheduler.runRule(id);
  assert.deepEqual(ext.jobs, [], 'nenhum pedido à extensão (isto já vale)');
  assert.ok(!s.logs(id).some((l) => l.level === 'erro'), s.logs(id).map((l) => `${l.level}: ${l.message}`).join(' | '));
  assert.deepEqual(s.logs(id), [], 'nenhuma linha por execução: a da espera (sem regra) já está no Histórico');
  assert.equal(r.errors, 0);
  assert.equal(geral(db).filter((l) => l.message.startsWith('Mercado Livre em espera')).length, 1);
  // com outra fonte na regra, a Central em espera não vira "Fonte ignorada" a cada execução e a outra fonte segue
  const outra = Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('Duas fontes', 1, 1, 1, ?, 'list', '{}', ?, 1, 60, '00:00', '23:59', 7, 0, ?)`).run(JSON.stringify(['111@g.us']),
    JSON.stringify([{ type: 'afiliados', config: {} }, { type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-4000000001-x | Panela | 50' } }]), Date.now()).lastInsertRowid);
  const r2 = await s.scheduler.runRule(outra);
  assert.equal(r2.errors, 0);
  assert.ok(!s.logs(outra).some((l) => l.level === 'erro' || l.message.startsWith('Fonte ignorada')), s.logs(outra).map((l) => `${l.level}: ${l.message}`).join(' | '));
  assert.deepEqual(ext.jobs, [], 'a oferta da lista espera junto (o ML está em espera), sem pedido');
});
