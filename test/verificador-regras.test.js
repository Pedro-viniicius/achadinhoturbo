// Verificador de preço e estoque no Disparo automático (plano verificador-preco-estoque, etapa 7; CA1 a CA5):
// agendador real (createScheduler) com o verificador real (createVerificador), WhatsApp simulado, links em modo
// simulado e a Central de Afiliados de exemplo (amostraHub). A loja é falsa: o `ml` do verificador é injetado
// (conferirProduto devolve o que o teste pede) e o fetch global lança e é contado. Nenhuma loja real é chamada.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSetting } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createVerificador, PAUSA_DESCARTADA_H } from '../src/verificador.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { paraCandidato, createCatalogo } from '../src/catalogo.js';

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
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-regra-')); pastas.push(p); return p; };

const idDe = (url) => /MLB-?(\d+)/.exec(String(url))?.[1] ?? null;
const HORA = 3600000;
const dia = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // 02/11/2026 (segunda), horário local

/**
 * Agendador com o verificador. `loja`: id do MLB (só os dígitos) → { price, disponivel } | 'falha' (a leitura lança).
 * O que não estiver em `loja` lança também. `eventos` guarda, em ordem, cada conferência e cada pedido de link.
 * `comVerificador: false` = como hoje (sem a injeção). `catalogo`: ofertas no formato do Etiqueta (fonte "catalogo").
 * `releitura`: ASIN → resposta de catalogo.confirmarPreco (ou função asin → resposta); cada pedido entra em `eventos`
 * como 'reler <ASIN>'. Sem ela, o verificador não tem o cliente do Etiqueta (a releitura falha como 'o Etiqueta não
 * respondeu'). `confirmador`: o cliente do Etiqueta inteiro (ex.: o createCatalogo real), no lugar de `releitura`.
 * `amazonApi`: o cliente da Amazon que o verificador vê (ex.: com a API ligada); o agendador segue com o de só a tag.
 * `ctxs` guarda o contexto de cada leitura da lista do catálogo.
 */
function montar({ loja = {}, comVerificador = true, catalogo = null, releitura = null, confirmador = null, amazonApi = null } = {}) {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const eventos = [];
  const pedirLink = links.requestLink;
  links.requestLink = async (p) => { eventos.push(`link ${idDe(p.url)}`); return pedirLink(p); };
  const mlLoja = {
    async conferirProduto(url) {
      const id = idDe(url); eventos.push(`conferir ${id}`);
      const r = loja[id];
      if (!r || r === 'falha') throw new Error('loja fora do ar (falsa)');
      return r;
    },
  };
  const conexaoAmazon = { tag: 'achadinho-20' }; // tag salva, sem ID e segredo: a API da Amazon não está ligada
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => conexaoAmazon });
  const etiqueta = confirmador ?? (releitura ? {
    async confirmarPreco(asin) {
      eventos.push(`reler ${asin}`);
      const r = typeof releitura === 'function' ? releitura(asin) : releitura[asin];
      return r ?? { resultado: 'falha', causa: 'nao_encontrado' };
    },
  } : null);
  const verificador = comVerificador ? createVerificador({ db, ml: mlLoja, amazon: amazonApi ?? amazon, catalogo: etiqueta }) : null;
  const extra = {};
  const ctxs = [];
  if (catalogo) {
    extra.catalogo = {
      candidatos: async (cfg, ctx) => { ctxs.push(ctx); return catalogo.map(paraCandidato).filter((c) => c && !ctx.tratada(c, cfg.ordem)); },
    };
    extra.catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  }
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador, ...extra });
  for (const [jid, nome] of [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  }
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  return { db, wa, links, scheduler, eventos, amazon, verificador, ctxs };
}

/** Template com a hora do preço numa linha só dela e num trecho opcional. → id */
const templateComHora = (db) => Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)')
  .run('Com hora', '*{TITULO_PRODUTO}*\n{PRECO_PRODUTO}[ (preço das {HORA_PRECO})]\nConferido às {HORA_PRECO}\n{LINK}', Date.now()).lastInsertRowid);

/** Regra da Central de Afiliados (amostraHub no modo simulado: MLB9000001 a MLB9000005, nessa ordem). */
const regraCentral = (db, { per = 2, grupos = ['111@g.us'], template = 1 } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id,
  template_id, group_jids, source_type, source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES ('Central', 1, 1, ?, ?, 'afiliados', ?, ?, 60, '00:00', '23:59', 7, 0, ?)`)
  .run(template, JSON.stringify(grupos), JSON.stringify({ categoria: 'MLB1574', paginas: 1 }), per, Date.now()).lastInsertRowid);

/** Regra da "Lista de links" (linhas com preço = digitadas à mão). */
const regraLista = (db, itens, { per = 3 } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids,
  source_type, source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES ('Lista', 1, 1, 1, ?, 'list', ?, ?, 60, '00:00', '23:59', 7, 0, ?)`)
  .run(JSON.stringify(['111@g.us']), JSON.stringify({ items: itens.join('\n') }), per, Date.now()).lastInsertRowid);

const regraCatalogo = (db) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
  sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES ('Catálogo', 1, 1, 1, ?, 'list', '{}', ?, 5, 60, '00:00', '23:59', 7, 0, ?)`)
  .run(JSON.stringify(['111@g.us']), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }]), Date.now()).lastInsertRowid);

const logs = (db, id) => db.prepare('SELECT level, group_name, offer_title, message FROM log WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l }));
const enviadas = (db, id) => db.prepare('SELECT offer_key FROM sent_offers WHERE rule_id = ? ORDER BY id').all(id).map((l) => l.offer_key);
const titulos = (wa) => wa.simulated.map((m) => m.text.split('\n')[0]);
const semErro = (db, id) => assert.deepEqual(logs(db, id).filter((l) => l.level === 'erro'), [], 'nada do verificador com nível erro (D8)');

// ---------------------------------------------------------------------------------------------- CA1, CA3, CA5

test('CA1/CA5: a Central confere cada oferta antes do link; conferida sai com {HORA_PRECO} e sem sufixo', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 14, 32) });
  const s = montar({ loja: { 9000001: { price: 69.9, disponivel: true }, 9000002: { price: 29.9, disponivel: null } } });
  const id = regraCentral(s.db, { template: templateComHora(s.db), grupos: ['111@g.us', '222@g.us'] });

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.descartadas], [2, 4, 0, 0]);
  assert.deepEqual(s.eventos, ['conferir 9000001', 'link 9000001', 'conferir 9000002', 'link 9000002'], 'a conferência vem antes do link');
  for (const m of s.wa.simulated) {
    assert.match(m.text, /\(preço das 14h32\)/, 'trecho opcional preenchido');
    assert.match(m.text, /\nConferido às 14h32\n/, 'linha da hora');
  }
  assert.ok(s.wa.simulated[0].text.includes('R$ 69,90'));
  const oks = logs(s.db, id).filter((l) => l.level === 'ok');
  assert.equal(oks.length, 4);
  for (const l of oks) assert.equal(l.message, 'Enviado com a etiqueta etiquetaA', 'sem sufixo: o preço é o mesmo');
  assert.deepEqual(enviadas(s.db, id), ['MLB9000001', 'MLB9000002']);
  semErro(s.db, id);
});

test('CA3: preço que caiu, ou subiu dentro do limite, sai com o preço da loja; o Histórico ganha o sufixo', async () => {
  const s = montar({ loja: { 9000001: { price: 59.9, disponivel: true }, 9000002: { price: 31.39, disponivel: true } } });
  const id = regraCentral(s.db);
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.descartadas], [2, 2, 0]);
  const [a, b] = s.wa.simulated.map((m) => m.text);
  assert.ok(a.includes('R$ 59,90') && !a.includes('R$ 69,90'), 'preço novo no texto');
  assert.ok(b.includes('R$ 31,39'), '+4,98%: dentro de 5%');
  const oks = logs(s.db, id).filter((l) => l.level === 'ok').map((l) => l.message);
  assert.deepEqual(oks, [
    'Enviado com a etiqueta etiquetaA · preço atualizado de R$ 69,90 para R$ 59,90',
    'Enviado com a etiqueta etiquetaA · preço atualizado de R$ 29,90 para R$ 31,39',
  ]);
});

// ------------------------------------------------------------------------------------------------- CA2, CA3, D6

// a vaga da descartada é reposta pela próxima candidata (plano rodar-sozinho-entrega1, CA1.7; antes, D6 não repunha)
test('CA2/CA3/D6: esgotada e mais cara não saem nem pedem link; a vaga vai às próximas; uma linha aviso por oferta', async () => {
  const s = montar({ loja: { 9000001: { price: 69.9, disponivel: false }, 9000002: { price: 39.9, disponivel: true }, 9000003: { price: 299.9, disponivel: true }, 9000004: { price: 59.9, disponivel: true }, 9000005: { price: 89.9, disponivel: true } } });
  const id = regraCentral(s.db, { per: 3, grupos: ['111@g.us', '222@g.us'] });

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.descartadas], [3, 6, 0, 2]);
  assert.deepEqual(s.eventos, ['conferir 9000001', 'conferir 9000002', 'conferir 9000003', 'link 9000003', 'conferir 9000004', 'link 9000004', 'conferir 9000005', 'link 9000005'], 'descartada não pede link');
  assert.deepEqual(titulos(s.wa), ['*Air Fryer 4L Antiaderente*', '*Air Fryer 4L Antiaderente*', '*Garrafa Térmica Inox 1L*', '*Garrafa Térmica Inox 1L*', '*Jogo de Toalhas 4 Peças*', '*Jogo de Toalhas 4 Peças*'], 'as descartadas são repostas pela 4ª e 5ª');
  const avisos = logs(s.db, id).filter((l) => l.level === 'aviso');
  assert.deepEqual(avisos, [
    { level: 'aviso', group_name: null, offer_title: 'Kit 10 Potes Herméticos de Vidro', message: 'Descartada: esgotado na loja' },
    { level: 'aviso', group_name: null, offer_title: 'Organizador de Gaveta Dobrável', message: 'Descartada: preço subiu de R$ 29,90 para R$ 39,90 (+33%, o limite é 5%)' },
  ]);
  assert.deepEqual(enviadas(s.db, id), ['MLB9000003', 'MLB9000004', 'MLB9000005'], 'descartada não entra em sent_offers');
  semErro(s.db, id);
});

test('D6: a descartada fica 6 h fora da escolha da regra (sem nova leitura da loja); depois volta', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 10, 0) });
  const s = montar({ loja: { 9000001: { price: 69.9, disponivel: false }, 9000002: { price: 29.9, disponivel: true }, 9000003: { price: 299.9, disponivel: true } } });
  const id = regraCentral(s.db, { per: 1 });
  const outra = regraCentral(s.db, { per: 1 });

  await s.scheduler.runRule(id);
  assert.deepEqual(s.eventos, ['conferir 9000001', 'conferir 9000002', 'link 9000002'], '1ª execução: a 1ª escolhida estava esgotada e a vaga foi para a próxima');
  s.eventos.length = 0;

  t.mock.timers.setTime(dia(2, 10, 0) + PAUSA_DESCARTADA_H * HORA - 60000);
  await s.scheduler.runRule(id);
  assert.deepEqual(s.eventos, ['conferir 9000003', 'link 9000003'], 'a esgotada nem é lida de novo antes de 6 h');
  assert.deepEqual(enviadas(s.db, id), ['MLB9000002', 'MLB9000003']);

  // a pausa é da regra: outra regra escolhe a mesma oferta e a confere
  s.eventos.length = 0;
  await s.scheduler.runRule(outra);
  assert.deepEqual(s.eventos.slice(0, 1), ['conferir 9000001'], 'outra regra confere a oferta de novo');

  s.eventos.length = 0;
  t.mock.timers.setTime(dia(2, 10, 0) + PAUSA_DESCARTADA_H * HORA + 1000);
  await s.scheduler.runRule(id);
  assert.deepEqual(s.eventos.slice(0, 1), ['conferir 9000001'], 'depois de 6 h ela volta à escolha (e segue esgotada)');
  assert.deepEqual(s.eventos.slice(1), ['conferir 9000004', 'link 9000004'], 'e a vaga vai à próxima que a regra ainda não enviou');
});

// ------------------------------------------------------------------------------------------------------- CA4

test('CA4: Central sem conferência (dados da escolha, frescos) sai com " · preço não conferido (<causa>)" e sem {HORA_PRECO}', async () => {
  const s = montar({ loja: { 9000001: 'falha', 9000002: { price: null, disponivel: true } } });
  const id = regraCentral(s.db, { template: templateComHora(s.db), grupos: ['111@g.us', '222@g.us'] });

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.descartadas], [2, 4, 0, 0]);
  for (const m of s.wa.simulated) {
    assert.ok(!m.text.includes('Conferido às') && !m.text.includes('preço das'), 'sem conferência: a linha e o trecho somem');
  }
  const oks = logs(s.db, id).filter((l) => l.level === 'ok');
  assert.deepEqual(oks.map((l) => [l.group_name, l.message]), [
    ['Achadinhos', 'Enviado com a etiqueta etiquetaA · preço não conferido (a loja não respondeu)'],
    ['Tech', 'Enviado com a etiqueta etiquetaA · preço não conferido (a loja não respondeu)'],
    ['Achadinhos', 'Enviado com a etiqueta etiquetaA · preço não conferido (a página não trouxe o preço)'],
    ['Tech', 'Enviado com a etiqueta etiquetaA · preço não conferido (a página não trouxe o preço)'],
  ]);
  semErro(s.db, id);
});

const ITEM_FONE = 'https://produto.mercadolivre.com.br/MLB-1000001-a | Fone A | 50 | 100';
const ITEM_MOUSE = 'https://produto.mercadolivre.com.br/MLB-1000002-b | Mouse B | 30 | 40';

test('CA4: lista com preço digitado (idade desconhecida) sem conferência não sai; conferida sai com o preço digitado', async () => {
  const s = montar({ loja: { 1000001: 'falha', 1000002: { price: 30.5, disponivel: true } } });
  const id = regraLista(s.db, [ITEM_FONE, ITEM_MOUSE]);

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.descartadas], [1, 1, 0, 1]);
  assert.deepEqual(s.eventos, ['conferir 1000001', 'conferir 1000002', 'link 1000002'], 'a lista velha não pede link');
  assert.deepEqual(logs(s.db, id).filter((l) => l.level === 'aviso').map((l) => [l.offer_title, l.message]), [
    ['Fone A', 'Descartada: não deu para conferir o preço (a loja não respondeu)'],
    // a regra pediu 3 (rodar-sozinho CA1.8)
    [null, 'Saíram 1 de 3 ofertas; 1 descartada (loja sem resposta e dados antigos); não havia mais ofertas novas dentro dos filtros.'],
  ]);
  assert.ok(s.wa.simulated[0].text.includes('R$ 30,00'), 'preço digitado à mão é mantido (CA3)');
  assert.equal(logs(s.db, id).find((l) => l.level === 'ok').message, 'Enviado com a etiqueta etiquetaA');
  assert.deepEqual(enviadas(s.db, id), ['MLB1000002']);
  semErro(s.db, id);
});

// sem conferência o catálogo deixou de ir à revisão: a oferta é pulada, sem catalogo_itens, e pode voltar na execução
// seguinte (plano rodar-sozinho-entrega1, B6; CA1.5 e CA1.11). A Amazon sem API e sem o cliente do Etiqueta cai na
// reserva, que não vale sem a data do preço
test('CA4/CA2: catálogo sem conferência é pulado (sem revisão); esgotado é descartado e não volta; conferido sai', async () => {
  const of = (i, loja, mais = {}) => ({
    id: i, loja, titulo: `Produto ${i}`, preco: 100, preco_antigo: 150, desconto_pct: 33, categoria: 'Casa',
    ...(loja === 'amazon' ? { item_id: `B0${String(i).padStart(8, '0')}`, link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20' } : { item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/TerCeiro1' }),
    ...mais,
  });
  const s = montar({
    catalogo: [of(1, 'ml'), of(2, 'ml'), of(3, 'amazon'), of(4, 'ml')],
    loja: { 4000000001: 'falha', 4000000002: { price: 100, disponivel: false }, 4000000004: { price: 95, disponivel: true } },
  });
  const id = regraCatalogo(s.db);

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.revisao, r.descartadas, r.puladas], [1, 1, 0, 0, 1, 2]);
  const itens = s.db.prepare('SELECT chave, status, motivos FROM catalogo_itens WHERE rule_id = ? ORDER BY id').all(id).map((l) => [l.chave, l.status, JSON.parse(l.motivos)]);
  assert.deepEqual(itens, [
    ['MLB4000000002', 'descartado', []],
    ['MLB4000000004', 'enviado', []],
  ], 'as puladas não entram em catalogo_itens');
  // R2: o item descartado guarda por que (a tela do Histórico do catálogo mostra "Descartada: esgotado na loja")
  assert.deepEqual(s.db.prepare("SELECT chave, json_extract(oferta, '$.descartado_por') AS por FROM catalogo_itens WHERE rule_id = ? ORDER BY id").all(id).map((l) => [l.chave, l.por]),
    [['MLB4000000002', 'esgotado'], ['MLB4000000004', null]]);
  assert.deepEqual(s.eventos.filter((e) => e.startsWith('link')), ['link 4000000004'], 'só a conferida pede link');
  assert.deepEqual(logs(s.db, id).filter((l) => l.level === 'aviso').map((l) => [l.offer_title, l.message]), [
    ['Produto 1', 'Pulada: não deu para conferir o preço (a loja não respondeu). O Mercado Livre não sai sem conferir; tenta de novo no próximo envio.'],
    ['Produto 2', 'Descartada: esgotado na loja'],
    ['Produto 3', 'Pulada: não deu para conferir o preço agora (o Etiqueta não respondeu) e a oferta não diz quando o preço foi visto. Tenta de novo no próximo envio.'],
    [null, 'Saíram 1 de 5 ofertas; 2 puladas (preço sem conferência), 1 descartada (esgotada na loja); não havia mais ofertas novas dentro dos filtros.'],
  ]);
  assert.deepEqual(titulos(s.wa), ['*Produto 4*']);
  assert.ok(s.wa.simulated[0].text.includes('R$ 95,00') && !s.wa.simulated[0].text.includes('R$ 100,00'), 'sai com o preço conferido');
  assert.equal(logs(s.db, id).find((l) => l.level === 'ok').message, 'Enviado com a etiqueta etiquetaA · preço atualizado de R$ 100,00 para R$ 95,00');
  assert.deepEqual(enviadas(s.db, id), ['MLB4000000004'], 'as puladas não entram em sent_offers');
  semErro(s.db, id);

  // a descartada conta como tratada: a próxima execução não a confere de novo. A pulada do ML volta a ser conferida; a
  // Amazon sem data do preço fica fora da escolha enquanto a releitura está pausada (semConfirmacaoAgora)
  s.eventos.length = 0;
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 0);
  assert.deepEqual(s.eventos, ['conferir 4000000001'], 'só a pulada do ML é lida de novo');
});

// --------------------------------------------------------------------------------------------- grade (CA7 da grade)

// a vaga da descartada é reposta (plano rodar-sozinho-entrega1, CA1.7): a frase só sai quando falta oferta (CA1.8)
test('grade: a descartada pelo verificador é reposta; a frase "saíram N de M" cita as descartadas quando falta', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 10, 0) });
  const s = montar({ loja: { 9000001: { price: 69.9, disponivel: false }, 9000002: { price: 29.9, disponivel: true }, 9000003: { price: 299.9, disponivel: true }, 9000004: { price: 59.9, disponivel: true }, 9000005: { price: 89.9, disponivel: true } } });
  const id = regraCentral(s.db, { per: 1 });
  s.db.prepare('UPDATE rules SET grade = ?, next_run_at = ? WHERE id = ?').run(JSON.stringify({
    dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '10:00', qtd: 3, template_id: null }, { hora: '11:00', qtd: 8, template_id: null }],
  }), dia(2, 10, 0), id);
  const avisoDaGrade = () => s.db.prepare("SELECT message FROM log WHERE rule_id = ? AND level = 'aviso' AND message LIKE 'Horário%' ORDER BY id DESC").get(id)?.message;

  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 3, 'a 4ª ocupou a vaga da esgotada');
  assert.equal(avisoDaGrade(), undefined, 'saíram as 3: sem a frase');

  // 11:00 pede 8: sobra 1 nova (a esgotada está em pausa), e o motivo da falta aparece
  t.mock.timers.setTime(dia(2, 11, 0));
  s.eventos.length = 0;
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 4);
  assert.equal(avisoDaGrade(), 'Horário 11:00: saíram 1 de 8 ofertas; não havia mais ofertas novas dentro dos filtros.');
});

test('grade: descartadas e falta de ofertas na mesma frase', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 10, 0) });
  const s = montar({ loja: { 9000001: { price: 69.9, disponivel: false }, 9000002: { price: 29.9, disponivel: false }, 9000003: { price: 299.9, disponivel: true }, 9000004: { price: 59.9, disponivel: true }, 9000005: { price: 89.9, disponivel: true } } });
  const id = regraCentral(s.db, { per: 1 });
  s.db.prepare('UPDATE rules SET grade = ?, next_run_at = ? WHERE id = ?').run(JSON.stringify({
    dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '10:00', qtd: 8, template_id: null }],
  }), dia(2, 10, 0), id);
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 3);
  const msg = s.db.prepare("SELECT message FROM log WHERE rule_id = ? AND message LIKE 'Horário%'").get(id).message;
  assert.equal(msg, 'Horário 10:00: saíram 3 de 8 ofertas; 2 descartadas (esgotada na loja); não havia mais ofertas novas dentro dos filtros.');
});

// ------------------------------------------------- releitura da Amazon e pulada (plano rodar-sozinho-entrega1, B6)
// O catálogo manda o preço visto pelo Etiqueta (preco_em) e a releitura vai ao cliente falso do Etiqueta (`releitura`
// do montar). A API da Amazon não está ligada (só a tag). Relógio falso ligado ANTES do montar: o verificador guarda o
// Date.now de quando é criado.

const p2 = (n) => String(n).padStart(2, '0');
/** ms → 'AAAA-MM-DDTHH:MM:SS' em hora local (o preco_em do Etiqueta). */
const precoEmTexto = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
const asinDe = (i) => `B0${String(i).padStart(8, '0')}`;
/** Oferta do Etiqueta. `precoEm`: ms (vira o texto do contrato), texto cru, ou ausente (undefined). */
const doEtiqueta = (i, loja, { preco = 100, precoEm } = {}) => ({
  id: i, loja, titulo: `Produto ${i}`, preco, preco_antigo: 150, desconto_pct: 33, categoria: 'Casa',
  ...(loja === 'amazon' ? { item_id: asinDe(i), link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20' } : { item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/TerCeiro1' }),
  ...(precoEm === undefined ? {} : { preco_em: typeof precoEm === 'number' ? precoEmTexto(precoEm) : precoEm }),
});
const confirmado = (preco, precoEm) => ({ resultado: 'confirmado', preco, precoAntigo: 150, descontoPct: null, precoEm });
const falhou = (causa) => ({ resultado: 'falha', causa });
const itensDe = (db, id) => db.prepare("SELECT chave, status, json_extract(oferta, '$.descartado_por') AS por FROM catalogo_itens WHERE rule_id = ? ORDER BY id").all(id).map((l) => [l.chave, l.status, l.por]);
const avisosDe = (db, id) => logs(db, id).filter((l) => l.level === 'aviso').map((l) => [l.offer_title, l.message]);
const oksDe = (db, id) => logs(db, id).filter((l) => l.level === 'ok').map((l) => [l.offer_title, l.message]);

test('CA1.3: catálogo Amazon confirmada na hora sai sem passar pela revisão', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 14, 40) });
  // preço da lista visto há mais de um dia: a releitura confirma na hora, com outro preço
  const s = montar({ catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(1, 9, 0) })], releitura: { [asinDe(1)]: confirmado(95, dia(2, 14, 39)) } });
  const id = regraCatalogo(s.db);

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.revisao, r.descartadas, r.puladas], [1, 1, 0, 0, 0, 0]);
  assert.deepEqual(s.eventos, [`reler ${asinDe(1)}`], 'uma releitura, só do produto escolhido');
  assert.ok(s.wa.simulated[0].text.includes('R$ 95,00') && !s.wa.simulated[0].text.includes('R$ 100,00'), 'sai com o preço lido');
  assert.match(s.wa.simulated[0].text, /amazon\.com\.br\/dp\/B000000001\?tag=achadinho-20/, 'link com a tag de Conexões');
  assert.deepEqual(oksDe(s.db, id), [['Produto 1', 'Enviado pela Amazon, com a sua tag · preço atualizado de R$ 100,00 para R$ 95,00']]);
  assert.deepEqual(itensDe(s.db, id), [['ASIN:B000000001', 'enviado', null]], 'nada na revisão');
  assert.deepEqual(enviadas(s.db, id), ['ASIN:B000000001']);
  assert.ok(!logs(s.db, id).some((l) => /revisão|Pulada/.test(l.message)));
  semErro(s.db, id);
});

test('CA1.4: descartes da releitura vão ao Histórico e a catalogo_itens com descartado_por', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 14, 0) });
  const agora = dia(2, 14, 0);
  const s = montar({
    catalogo: [1, 2, 3].map((i) => doEtiqueta(i, 'amazon', { precoEm: agora - HORA })),
    releitura: { [asinDe(1)]: { resultado: 'sem_preco' }, [asinDe(2)]: { resultado: 'outro_produto' }, [asinDe(3)]: confirmado(120, agora) },
  });
  const id = regraCatalogo(s.db);

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.revisao, r.descartadas, r.puladas], [0, 0, 0, 0, 3, 0]);
  assert.deepEqual(itensDe(s.db, id), [
    ['ASIN:B000000001', 'descartado', 'indisponivel'],
    ['ASIN:B000000002', 'descartado', 'outro_produto'],
    ['ASIN:B000000003', 'descartado', 'preco_subiu'],
  ]);
  assert.deepEqual(avisosDe(s.db, id), [
    ['Produto 1', 'Descartada: indisponível na loja (a página não mostra preço nem estoque)'],
    ['Produto 2', 'Descartada: a página da loja abriu outro produto (o código não confere com a oferta)'],
    ['Produto 3', 'Descartada: preço subiu de R$ 100,00 para R$ 120,00 (+20%, o limite é 5%)'],
    [null, 'Saíram 0 de 5 ofertas; 3 descartadas (1 indisponível na loja, 1 outro produto na página, 1 preço subiu); não havia mais ofertas novas dentro dos filtros.'],
  ]);
  assert.deepEqual(enviadas(s.db, id), []);
  assert.equal(s.wa.simulated.length, 0);
  semErro(s.db, id);

  // descartada no catálogo não volta naquela regra: nenhuma releitura na execução seguinte
  s.eventos.length = 0;
  await s.scheduler.runRule(id);
  assert.deepEqual(s.eventos, []);
});

test('CA1.5: a oferta que saiu do Etiqueta pula, mesmo com o preço dentro da reserva, e a frase não promete nova tentativa', async (t) => {
  const agora = dia(2, 14, 0);
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const s = montar({ catalogo: [doEtiqueta(1, 'amazon', { precoEm: agora - 60 * 60000 })], releitura: { [asinDe(1)]: falhou('nao_encontrado') } });
  const id = regraCatalogo(s.db);
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.revisao, r.descartadas, r.puladas], [0, 0, 0, 0, 0, 1]);
  assert.deepEqual(avisosDe(s.db, id), [
    ['Produto 1', 'Pulada: a oferta saiu do Etiqueta e o preço não pôde ser conferido. Ela só volta se o catálogo a trouxer de novo.'],
    [null, 'Saíram 0 de 5 ofertas; 1 pulada (preço sem conferência); não havia mais ofertas novas dentro dos filtros.'],
  ]);
  assert.deepEqual(enviadas(s.db, id), []);
  assert.equal(s.wa.simulated.length, 0);
});

test('CA1.5: reserva vencida pula: sem revisão e sem sent_offers', async (t) => {
  const agora = dia(2, 14, 0);
  // bloqueado e falha de rede são falhas da página DESTA oferta (achados Q1/R2): ela fica 6 h fora da escolha da regra
  const casos = [
    { nome: 'mais de 6 h', precoEm: dia(2, 7, 59), falha: 'bloqueado', texto: 'Pulada: o preço visto às 07:59 tem mais de 6 h e não deu para conferir agora (a Amazon bloqueou a leitura). Fica 6 h fora da escolha desta regra.' },
    { nome: 'de ontem', precoEm: dia(1, 22, 10), falha: 'fora_do_ar', texto: 'Pulada: o preço visto às 22:10 de 01/11 tem mais de 6 h e não deu para conferir agora (o Etiqueta não respondeu). Tenta de novo no próximo envio.' },
    { nome: 'sem preco_em', precoEm: undefined, falha: 'falha_rede', texto: 'Pulada: não deu para conferir o preço agora (a loja não respondeu) e a oferta não diz quando o preço foi visto. Fica 6 h fora da escolha desta regra.' },
    { nome: 'data inválida', precoEm: '2026-02-30T10:00:00', falha: 'freio', texto: 'Pulada: não deu para conferir o preço agora (o Etiqueta estava ocupado com outra leitura da Amazon) e a oferta não diz quando o preço foi visto. Tenta de novo no próximo envio.' },
    { nome: '6 min no futuro', precoEm: agora + 6 * 60000, falha: 'resposta_inesperada', texto: 'Pulada: não deu para conferir o preço agora (o Etiqueta não respondeu) e a oferta não diz quando o preço foi visto. Tenta de novo no próximo envio.' },
  ];
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  for (const caso of casos) {
    t.mock.timers.setTime(agora);
    const s = montar({ catalogo: [doEtiqueta(1, 'amazon', { precoEm: caso.precoEm })], releitura: { [asinDe(1)]: falhou(caso.falha) } });
    const id = regraCatalogo(s.db);
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages, r.errors, r.revisao, r.descartadas, r.puladas], [0, 0, 0, 0, 0, 1], caso.nome);
    assert.equal(r.porLoja.amazon.pulada, 1, caso.nome);
    assert.deepEqual(s.eventos, [`reler ${asinDe(1)}`], caso.nome);
    assert.deepEqual(avisosDe(s.db, id), [
      ['Produto 1', caso.texto],
      [null, 'Saíram 0 de 5 ofertas; 1 pulada (preço sem conferência); não havia mais ofertas novas dentro dos filtros.'],
    ], caso.nome);
    assert.deepEqual(itensDe(s.db, id), [], `${caso.nome}: nada em catalogo_itens (nem revisão)`);
    assert.deepEqual(enviadas(s.db, id), [], `${caso.nome}: nada em sent_offers`);
    assert.equal(s.wa.simulated.length, 0, caso.nome);
    assert.ok(!logs(s.db, id).some((l) => /revisão/.test(l.message)), `${caso.nome}: a palavra revisão não aparece`);
    semErro(s.db, id);
    if (caso.nome === 'de ontem') {
      // pode voltar depois: durante a pausa da releitura (10 min) ela fica fora da escolha sem chamar o Etiqueta; depois,
      // é relida de novo (não ficou registrada como tratada)
      s.eventos.length = 0;
      t.mock.timers.setTime(agora + 9 * 60000);
      await s.scheduler.runRule(id);
      assert.deepEqual(s.eventos, [], 'pausa da releitura: sem nova chamada');
      t.mock.timers.setTime(agora + 11 * 60000);
      await s.scheduler.runRule(id);
      assert.deepEqual(s.eventos, [`reler ${asinDe(1)}`], 'depois da pausa a oferta volta e é relida');
    }
    if (caso.nome === 'mais de 6 h') {
      // a falha foi da página desta oferta: passada a pausa da releitura, ela segue fora da escolha até as 6 h
      s.eventos.length = 0;
      t.mock.timers.setTime(agora + 11 * 60000);
      await s.scheduler.runRule(id);
      assert.deepEqual(s.eventos, [], 'em pausa de 6 h na regra: sem nova chamada');
      t.mock.timers.setTime(agora + PAUSA_DESCARTADA_H * HORA + 60000);
      await s.scheduler.runRule(id);
      assert.deepEqual(s.eventos, [`reler ${asinDe(1)}`], 'depois das 6 h a oferta volta e é relida');
    }
  }
});

test('CA1.6: {HORA_PRECO} da mensagem é a hora do preço', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 14, 40) });
  const s = montar({
    catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 8, 0) }), doEtiqueta(2, 'amazon', { precoEm: dia(2, 10, 15) })],
    // a 1ª é confirmada na hora (o Etiqueta carimba 14:39:30, a hora da releitura); a 2ª falha e sai pela reserva (preço visto às 10:15)
    releitura: { [asinDe(1)]: confirmado(100, dia(2, 14, 39) + 30000), [asinDe(2)]: falhou('bloqueado') },
  });
  const id = regraCatalogo(s.db);
  s.db.prepare('UPDATE rules SET template_id = ? WHERE id = ?').run(templateComHora(s.db), id);

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [2, 2]);
  const [a, b] = s.wa.simulated.map((m) => m.text);
  assert.match(a, /\(preço das 14h39\)/); assert.match(a, /\nConferido às 14h39\n/);
  assert.match(b, /\(preço das 10h15\)/); assert.match(b, /\nConferido às 10h15\n/);
  for (const m of [a, b]) assert.ok(!m.includes('14h40'), 'nunca a hora do envio');
  assert.deepEqual(oksDe(s.db, id), [
    ['Produto 1', 'Enviado pela Amazon, com a sua tag'],
    ['Produto 2', 'Enviado pela Amazon, com a sua tag · preço visto às 10:15, não conferido agora (a Amazon bloqueou a leitura)'],
  ]);
  semErro(s.db, id);
});

/**
 * Etiqueta falso atrás do cliente REAL (createCatalogo), com o freio da releitura como o do Etiqueta (servidor.py,
 * FreioReleitura): 429 `intervalo` a menos de 3 s do início da leitura anterior. Cada leitura leva 0,4 s. O relógio é o
 * Date falso do teste: a leitura e a espera do freio o avançam (ninguém dorme de verdade). `precos`: ASIN → preço lido.
 */
function etiquetaComFreio(t, precos) {
  const dir = tmp();
  const caminho = path.join(dir, 'api_token.txt');
  const token = 'tkFALSO_freio_0123456789_abcdefghijklmnop';
  fs.writeFileSync(caminho, `${token}\n`, { mode: 0o600 });
  const p2 = (n) => String(n).padStart(2, '0');
  const texto = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
  const chamadas = []; const esperas = [];
  let inicio = -Infinity;
  const json = (status, corpo, headers = {}) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetchFalso = async (url, init = {}) => {
    const asin = /amazon\/([A-Z0-9]{10})\/confirmar-preco$/.exec(new URL(String(url)).pathname)?.[1];
    if (!asin || init.headers?.Authorization !== `Bearer ${token}`) return json(404, { error: 'x' });
    const agora = Date.now();
    if (agora - inicio < 3000) {
      const s = Math.max(1, Math.ceil((inicio + 3000 - agora) / 1000));
      chamadas.push(`${asin} freio(intervalo)`);
      return json(429, { versao: 1, resultado: 'freio', motivo: 'intervalo', tentar_em_s: s }, { 'retry-after': String(s) });
    }
    inicio = agora;
    t.mock.timers.setTime(agora + 400); // a leitura da página
    chamadas.push(`${asin} confirmado 200`);
    return json(200, { versao: 1, resultado: 'confirmado', preco: precos[asin], preco_antigo: 150, desconto_pct: null, preco_em: texto(Date.now()) });
  };
  const catalogo = createCatalogo({
    db: null, fetch: fetchFalso, lerConexao: () => ({ endereco: 'http://127.0.0.1:8765', caminho_token: caminho }),
    esperar: async (ms) => { esperas.push(ms); t.mock.timers.setTime(Date.now() + ms); },
  });
  return { catalogo, chamadas, esperas };
}

test('R1 (regressão): a Amazon que cai fora não faz a próxima levar o 429 do intervalo — a reposta é relida e sai, também na regra seguinte', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 14, 0) });
  const velho = dia(2, 4, 0); // 10 h antes: sem reserva, só sai se for relida
  const e = etiquetaComFreio(t, { [asinDe(1)]: 120, [asinDe(2)]: 100, [asinDe(3)]: 100, [asinDe(4)]: 100 });
  const s = montar({ catalogo: [1, 2, 3].map((i) => doEtiqueta(i, 'amazon', { precoEm: velho })), confirmador: e.catalogo });
  const id = regraCatalogo(s.db);

  const r = await s.scheduler.runRule(id);
  assert.deepEqual(e.chamadas, [
    'B000000001 confirmado 200', 'B000000002 freio(intervalo)', 'B000000002 confirmado 200', 'B000000003 freio(intervalo)', 'B000000003 confirmado 200',
  ]);
  assert.deepEqual(e.esperas, [3000, 3000], 'esperou o tentar_em_s dentro da fila');
  assert.deepEqual([r.offers, r.descartadas, r.puladas], [2, 1, 0]);
  assert.deepEqual(titulos(s.wa), ['*Produto 2*', '*Produto 3*']);
  assert.deepEqual(avisosDe(s.db, id), [
    ['Produto 1', 'Descartada: preço subiu de R$ 100,00 para R$ 120,00 (+20%, o limite é 5%)'],
    [null, 'Saíram 2 de 5 ofertas; 1 descartada (preço subiu); não havia mais ofertas novas dentro dos filtros.'],
  ]);
  assert.ok(!logs(s.db, id).some((l) => /limite de conferências por hora/.test(l.message)), 'nunca a causa falsa do teto');
  // a regra seguinte do mesmo tick, logo depois: a releitura não ficou pausada e a 1ª Amazon dela é relida
  const outra = Number(s.db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run,
    interval_min, window_start, window_end, dedupe_days, send_image, created_at) VALUES ('B', 1, 1, 1, ?, 'list', '{}', ?, 1, 60, '00:00', '23:59', 7, 0, ?)`)
    .run(JSON.stringify(['111@g.us']), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia' } }]), Date.now()).lastInsertRowid);
  e.chamadas.length = 0;
  const r2 = await s.scheduler.runRule(outra);
  // a 1ª da regra B começa menos de 3 s depois da última leitura da regra A: espera e é relida (e cai, mais cara); a reposta também
  assert.deepEqual(e.chamadas, ['B000000001 freio(intervalo)', 'B000000001 confirmado 200', 'B000000002 freio(intervalo)', 'B000000002 confirmado 200']);
  assert.deepEqual([r2.offers, r2.descartadas, r2.puladas], [1, 1, 0]);
  semErro(s.db, id); semErro(s.db, outra);
});

test('R4: com a API da Amazon ligada não há reserva — a pulada não fala da idade do preço visto', async (t) => {
  const agora = dia(2, 14, 0);
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const amazonApi = { configurado: () => true, lerItem: async () => { throw new Error('API fora do ar (falsa)'); } };
  const s = montar({ catalogo: [doEtiqueta(1, 'amazon', { precoEm: dia(2, 4, 0) })], releitura: { [asinDe(1)]: confirmado(100, agora) }, amazonApi });
  const id = regraCatalogo(s.db);
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.puladas], [0, 1]);
  assert.deepEqual(s.eventos, [], 'com a API ligada o Etiqueta não é chamado');
  assert.deepEqual(avisosDe(s.db, id)[0], ['Produto 1', 'Pulada: não deu para conferir o preço agora (a loja não respondeu). Tenta de novo no próximo envio.']);
  assert.ok(!logs(s.db, id).some((l) => /preço visto às|não diz quando o preço foi visto/.test(l.message)));
});

test('S1: o preço da releitura passa de novo pela guarda do preço suspeito — 1,99 "de 199" e 0,001 vão à revisão, nunca ao WhatsApp', async (t) => {
  const agora = dia(2, 14, 0);
  t.mock.timers.enable({ apis: ['Date'], now: agora });
  const s = montar({
    catalogo: [1, 2, 3].map((i) => doEtiqueta(i, 'amazon', { precoEm: dia(2, 4, 0) })),
    releitura: {
      // o leitor do Etiqueta pegou a parcela no lugar do preço; e um preço quase zero (desconto de 100%)
      [asinDe(1)]: { resultado: 'confirmado', preco: 1.99, precoAntigo: 199, descontoPct: null, precoEm: agora - 30000 },
      [asinDe(2)]: { resultado: 'confirmado', preco: 0.001, precoAntigo: 150, descontoPct: null, precoEm: agora - 30000 },
      [asinDe(3)]: confirmado(100, agora - 30000),
    },
  });
  const id = regraCatalogo(s.db);
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.revisao, r.descartadas, r.puladas], [1, 2, 0, 0]);
  assert.deepEqual(titulos(s.wa), ['*Produto 3*'], 'só a de preço normal sai');
  assert.deepEqual(enviadas(s.db, id), ['ASIN:B000000003'], 'nenhuma das suspeitas em sent_offers');
  const naRevisao = s.db.prepare("SELECT chave, motivos, json_extract(oferta, '$.price') AS price, json_extract(oferta, '$.oldPrice') AS antigo FROM catalogo_itens WHERE rule_id = ? AND status = 'revisao' ORDER BY id").all(id).map((l) => ({ ...l }));
  assert.deepEqual(naRevisao, [
    // gravada com o preço conferido; desde a entrega 2 (CA2.11) a queda em relação ao preço da lista (100) também é motivo
    { chave: 'ASIN:B000000001', motivos: '["preco_antigo","queda_preco"]', price: 1.99, antigo: 199 },
    { chave: 'ASIN:B000000002', motivos: '["desconto_100","queda_preco"]', price: 0, antigo: 150 },
  ]);
  assert.deepEqual(avisosDe(s.db, id).slice(0, 2), [
    ['Produto 1', 'Separada para revisão: preço antigo muito alto, confira o preço e o preço está 98% abaixo do preço da lista (o limite é 50%), confira o preço.'],
    ['Produto 2', 'Separada para revisão: desconto de 100%, confira o preço e o preço está 100% abaixo do preço da lista (o limite é 50%), confira o preço.'],
  ]);
  semErro(s.db, id);
});

test('foco 1: Etiqueta cai no meio da execução: as Amazon restantes vão à reserva sem nova chamada', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 14, 0) });
  const s = montar({
    catalogo: [
      doEtiqueta(1, 'amazon', { precoEm: dia(2, 13, 0) }), doEtiqueta(2, 'amazon', { precoEm: dia(2, 12, 0) }),
      doEtiqueta(3, 'amazon', { precoEm: dia(2, 4, 0) }), doEtiqueta(4, 'amazon', { precoEm: dia(2, 11, 0) }),
    ],
    // só as duas primeiras chegam ao Etiqueta; as outras respostas provariam uma chamada a mais
    releitura: { [asinDe(1)]: confirmado(100, dia(2, 13, 59)), [asinDe(2)]: falhou('fora_do_ar'), [asinDe(3)]: confirmado(100, dia(2, 14, 0)), [asinDe(4)]: confirmado(100, dia(2, 14, 0)) },
  });
  const id = regraCatalogo(s.db);

  const r = await s.scheduler.runRule(id);
  assert.deepEqual(s.eventos, [`reler ${asinDe(1)}`, `reler ${asinDe(2)}`], 'depois da 1ª falha, nenhuma releitura');
  assert.deepEqual([r.offers, r.messages, r.puladas, r.revisao, r.descartadas], [3, 3, 0, 0, 0]);
  assert.deepEqual(titulos(s.wa), ['*Produto 1*', '*Produto 2*', '*Produto 4*']);
  assert.deepEqual(oksDe(s.db, id), [
    ['Produto 1', 'Enviado pela Amazon, com a sua tag'],
    ['Produto 2', 'Enviado pela Amazon, com a sua tag · preço visto às 12:00, não conferido agora (o Etiqueta não respondeu)'],
    ['Produto 4', 'Enviado pela Amazon, com a sua tag · preço visto às 11:00, não conferido agora (o Etiqueta não respondeu)'],
  ]);
  // a de 10 h não tinha como sair: ficou fora da escolha, sem gastar tentativa e sem linha de pulada
  assert.ok(logs(s.db, id).some((l) => l.level === 'info' && l.message === 'Antes da escolha, 1 oferta ficou de fora: 1 da Amazon que não dá para conferir agora.'));
  assert.ok(!logs(s.db, id).some((l) => l.offer_title === 'Produto 3'));
  assert.deepEqual(enviadas(s.db, id), ['ASIN:B000000001', 'ASIN:B000000002', 'ASIN:B000000004']);
  semErro(s.db, id);
});

test('foco 5: desligar no meio da execução pula o catálogo pedido com 72 h', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 14, 0) });
  const agora = dia(2, 14, 0);
  const s = montar({
    catalogo: [doEtiqueta(1, 'ml', { precoEm: agora - HORA }), doEtiqueta(2, 'ml', { precoEm: agora - 70 * HORA }), doEtiqueta(3, 'amazon', { precoEm: agora - 70 * HORA })],
    loja: { 4000000001: { price: 100, disponivel: true }, 4000000002: { price: 100, disponivel: true } },
    releitura: { [asinDe(3)]: confirmado(100, agora) },
  });
  const id = regraCatalogo(s.db);
  // o dono desliga o verificador enquanto a 1ª oferta (já conferida) pede o link
  const pedir = s.links.requestLink;
  s.links.requestLink = async (p) => { setSetting(s.db, 'verificador_ativo', '0'); return pedir(p); };

  const r = await s.scheduler.runRule(id);
  assert.equal(s.ctxs[0].conferenciaNaHora, true, 'a lista foi pedida com a idade larga');
  assert.deepEqual(s.eventos, ['conferir 4000000001', 'link 4000000001'], 'as restantes nem são lidas: nada sai sem conferência');
  assert.deepEqual([r.offers, r.messages, r.puladas, r.revisao, r.descartadas], [1, 1, 2, 0, 0]);
  assert.deepEqual(titulos(s.wa), ['*Produto 1*']);
  const desligado = 'Pulada: o verificador foi desligado durante este envio e o preço não foi conferido. Tenta de novo no próximo envio.';
  assert.deepEqual(avisosDe(s.db, id), [
    ['Produto 2', desligado],
    ['Produto 3', desligado],
    [null, 'Saíram 1 de 5 ofertas; 2 puladas (verificador desligado); não havia mais ofertas novas dentro dos filtros.'],
  ]);
  assert.deepEqual(itensDe(s.db, id), [['MLB4000000001', 'enviado', null]], 'as puladas não entram em catalogo_itens');
  assert.deepEqual(enviadas(s.db, id), ['MLB4000000001']);
  semErro(s.db, id);

  // a execução seguinte começa com o verificador desligado: a lista volta à validade de sempre (sem idade larga) e,
  // como hoje, o catálogo sai sem conferência e sem linha de pulada (CA1.11). O Etiqueta falso não filtra a idade
  s.links.requestLink = pedir;
  s.eventos.length = 0;
  const r2 = await s.scheduler.runRule(id);
  assert.equal(s.ctxs[1].conferenciaNaHora, false);
  assert.deepEqual([r2.offers, r2.puladas], [2, 0]);
  assert.deepEqual(s.eventos, ['link 4000000002'], 'desligado: nada é lido na loja nem no Etiqueta');
  assert.equal(logs(s.db, id).filter((l) => l.message === desligado).length, 2, 'nenhuma pulada nova');
});

test('CA1.11: ML com falha passageira pula e nunca sai sem conferência', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 14, 0) });
  const agora = dia(2, 14, 0);
  const s = montar({
    // o preço do Etiqueta é de agora: mesmo fresco, o ML do catálogo não sai sem conferir
    catalogo: [1, 2, 3].map((i) => doEtiqueta(i, 'ml', { precoEm: agora })),
    loja: { 4000000001: 'falha', 4000000002: { price: null, disponivel: true }, 4000000003: { price: 100, disponivel: true } },
  });
  const id = regraCatalogo(s.db);

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.puladas, r.revisao, r.descartadas], [1, 1, 2, 0, 0]);
  assert.equal(r.porLoja.ml.pulada, 2);
  assert.deepEqual(titulos(s.wa), ['*Produto 3*']);
  assert.deepEqual(avisosDe(s.db, id), [
    ['Produto 1', 'Pulada: não deu para conferir o preço (a loja não respondeu). O Mercado Livre não sai sem conferir; tenta de novo no próximo envio.'],
    ['Produto 2', 'Pulada: não dá para saber o preço (a página não trouxe o preço). Fica 6 h fora da escolha desta regra.'],
    [null, 'Saíram 1 de 5 ofertas; 2 puladas (1 preço sem conferência, 1 sem como saber o preço); não havia mais ofertas novas dentro dos filtros.'],
  ]);
  assert.deepEqual(itensDe(s.db, id), [['MLB4000000003', 'enviado', null]]);
  assert.deepEqual(enviadas(s.db, id), ['MLB4000000003']);
  assert.deepEqual(oksDe(s.db, id), [['Produto 3', 'Enviado com a etiqueta etiquetaA']], 'nenhuma saiu "sem conferir"');
  semErro(s.db, id);

  // a falha passageira volta na execução seguinte; a sem preço fica PAUSA_DESCARTADA_H fora da escolha desta regra
  s.eventos.length = 0;
  t.mock.timers.setTime(agora + 60000);
  await s.scheduler.runRule(id);
  assert.deepEqual(s.eventos, ['conferir 4000000001']);
  s.eventos.length = 0;
  t.mock.timers.setTime(agora + PAUSA_DESCARTADA_H * HORA + 60000);
  await s.scheduler.runRule(id);
  assert.deepEqual(s.eventos, ['conferir 4000000001', 'conferir 4000000002'], 'depois da pausa a sem preço volta');
  assert.equal(s.wa.simulated.length, 1, 'nada saiu sem conferência');
});

test('CA1.11: fonte afiliados mantém a regra do frescor', async () => {
  // Central: sem releitura nas opções; sem conferência e com dados frescos, sai com o sufixo de sempre
  const s = montar({ loja: { 9000001: 'falha', 9000002: { price: 29.9, disponivel: true } } });
  const opcoes = [];
  const conferir = s.verificador.conferir;
  s.verificador.conferir = (oferta, o) => { opcoes.push(o); return conferir(oferta, o); };
  const id = regraCentral(s.db);
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.puladas, r.descartadas], [2, 0, 0]);
  assert.equal(opcoes.length, 2);
  for (const o of opcoes) {
    assert.equal(Object.hasOwn(o, 'releitura'), false, 'a releitura é só da regra do catálogo');
    assert.equal(typeof o.lidoEm, 'number', 'a idade dos dados vai como sempre');
  }
  assert.equal(oksDe(s.db, id)[0][1], 'Enviado com a etiqueta etiquetaA · preço não conferido (a loja não respondeu)');

  // lista com preço digitado (idade desconhecida): continua "Descartada", nunca "Pulada"
  const l = montar({ loja: { 1000001: 'falha', 1000002: { price: 30.5, disponivel: true } } });
  const lista = regraLista(l.db, [ITEM_FONE, ITEM_MOUSE]);
  const rl = await l.scheduler.runRule(lista);
  assert.deepEqual([rl.offers, rl.puladas, rl.descartadas], [1, 0, 1]);
  assert.deepEqual(avisosDe(l.db, lista)[0], ['Fone A', 'Descartada: não deu para conferir o preço (a loja não respondeu)']);
});

// ------------------------------------------------------------------------------------------------------- D9

test('D9: sem o verificador (como hoje) e com ele desligado em Ajustes, nada é conferido nem ganha sufixo', async () => {
  for (const caso of ['sem injeção', 'desligado']) {
    const s = montar({ comVerificador: caso !== 'sem injeção', loja: {} });
    if (caso === 'desligado') setSetting(s.db, 'verificador_ativo', '0');
    const id = regraCentral(s.db, { template: templateComHora(s.db) });
    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages, r.descartadas], [2, 2, 0], caso);
    assert.deepEqual(s.eventos, ['link 9000001', 'link 9000002'], `${caso}: nenhuma leitura da loja`);
    for (const l of logs(s.db, id).filter((x) => x.level === 'ok')) assert.equal(l.message, 'Enviado com a etiqueta etiquetaA', caso);
    for (const m of s.wa.simulated) assert.ok(!m.text.includes('Conferido às'), `${caso}: sem {HORA_PRECO}`);
  }
});

test('D9: createScheduler repassa o verificador à fila de envios (Disparo manual confere no preparar)', async () => {
  const conferidas = [];
  const verificador = {
    ativo: () => true, limitePct: () => 5,
    async conferir(oferta) { conferidas.push(oferta.url); return { acao: 'descartar', motivo: 'esgotado', texto: 'Descartada: esgotado na loja' }; },
  };
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const ml = { async resolveOffer(c) { return { key: c.key, url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 0, freeShipping: false, image: null }; } };
  const scheduler = createScheduler({ db, wa, links, fast: true, dir, ml, verificador });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  const url = 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM';
  const { id } = await scheduler.envios.criar({ tipo: 'oferta', url, tag_id: 1, template_id: 1, group_jids: ['111@g.us'], quando: 'agora' });
  for (let i = 0; i < 200 && ['pendente', 'enviando'].includes(db.prepare('SELECT status FROM envios WHERE id = ?').get(id)?.status); i++) {
    await new Promise((ok) => setTimeout(ok, 10));
  }
  assert.ok(conferidas.length >= 1, 'a fila usou o verificador do agendador');
  assert.equal(wa.simulated.length, 0, 'descartada pela fila: nada saiu');
});
