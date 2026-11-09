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
import { paraCandidato } from '../src/catalogo.js';

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
 */
function montar({ loja = {}, comVerificador = true, catalogo = null } = {}) {
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
  const verificador = comVerificador ? createVerificador({ db, ml: mlLoja, amazon }) : null;
  const extra = {};
  if (catalogo) {
    extra.catalogo = { candidatos: async (cfg, { tratada }) => catalogo.map(paraCandidato).filter((c) => c && !tratada(c, cfg.ordem)) };
    extra.catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  }
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador, ...extra });
  for (const [jid, nome] of [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  }
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  return { db, wa, links, scheduler, eventos, amazon };
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

test('CA2/CA3/D6: esgotada e mais cara não saem, não pedem link nem são repostas; uma linha aviso por oferta', async () => {
  const s = montar({ loja: { 9000001: { price: 69.9, disponivel: false }, 9000002: { price: 39.9, disponivel: true }, 9000003: { price: 299.9, disponivel: true } } });
  const id = regraCentral(s.db, { per: 3, grupos: ['111@g.us', '222@g.us'] });

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.descartadas], [1, 2, 0, 2]);
  assert.deepEqual(s.eventos, ['conferir 9000001', 'conferir 9000002', 'conferir 9000003', 'link 9000003'], 'descartada não pede link');
  assert.deepEqual(titulos(s.wa), ['*Air Fryer 4L Antiaderente*', '*Air Fryer 4L Antiaderente*'], 'as descartadas não são repostas pela 4ª e 5ª');
  const avisos = logs(s.db, id).filter((l) => l.level === 'aviso');
  assert.deepEqual(avisos, [
    { level: 'aviso', group_name: null, offer_title: 'Kit 10 Potes Herméticos de Vidro', message: 'Descartada: esgotado na loja' },
    { level: 'aviso', group_name: null, offer_title: 'Organizador de Gaveta Dobrável', message: 'Descartada: preço subiu de R$ 29,90 para R$ 39,90 (+33%, o limite é 5%)' },
  ]);
  assert.deepEqual(enviadas(s.db, id), ['MLB9000003'], 'descartada não entra em sent_offers');
  semErro(s.db, id);
});

test('D6: a descartada fica 6 h fora da escolha da regra (sem nova leitura da loja); depois volta', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 10, 0) });
  const s = montar({ loja: { 9000001: { price: 69.9, disponivel: false }, 9000002: { price: 29.9, disponivel: true }, 9000003: { price: 299.9, disponivel: true } } });
  const id = regraCentral(s.db, { per: 1 });
  const outra = regraCentral(s.db, { per: 1 });

  await s.scheduler.runRule(id);
  assert.deepEqual(s.wa.simulated.length, 0, '1ª execução: a única escolhida estava esgotada');
  s.eventos.length = 0;

  t.mock.timers.setTime(dia(2, 10, 0) + PAUSA_DESCARTADA_H * HORA - 60000);
  await s.scheduler.runRule(id);
  assert.deepEqual(s.eventos, ['conferir 9000002', 'link 9000002'], 'a esgotada nem é lida de novo antes de 6 h');
  assert.deepEqual(enviadas(s.db, id), ['MLB9000002']);

  // a pausa é da regra: outra regra escolhe a mesma oferta e a confere
  s.eventos.length = 0;
  await s.scheduler.runRule(outra);
  assert.deepEqual(s.eventos, ['conferir 9000001'], 'outra regra confere a oferta de novo');

  s.eventos.length = 0;
  t.mock.timers.setTime(dia(2, 10, 0) + PAUSA_DESCARTADA_H * HORA + 1000);
  await s.scheduler.runRule(id);
  assert.deepEqual(s.eventos, ['conferir 9000001'], 'depois de 6 h ela volta à escolha (e segue esgotada)');
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
  assert.deepEqual(logs(s.db, id).filter((l) => l.level === 'aviso').map((l) => [l.offer_title, l.message]),
    [['Fone A', 'Descartada: não deu para conferir o preço (a loja não respondeu)']]);
  assert.ok(s.wa.simulated[0].text.includes('R$ 30,00'), 'preço digitado à mão é mantido (CA3)');
  assert.equal(logs(s.db, id).find((l) => l.level === 'ok').message, 'Enviado com a etiqueta etiquetaA');
  assert.deepEqual(enviadas(s.db, id), ['MLB1000002']);
  semErro(s.db, id);
});

test('CA4/CA2: catálogo sem conferência vai à revisão (nao_conferido); esgotado é descartado e não volta; conferido sai', async () => {
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
  assert.deepEqual([r.offers, r.messages, r.errors, r.revisao, r.descartadas], [1, 1, 0, 2, 1]);
  const itens = s.db.prepare('SELECT chave, status, motivos FROM catalogo_itens WHERE rule_id = ? ORDER BY id').all(id).map((l) => [l.chave, l.status, JSON.parse(l.motivos)]);
  assert.deepEqual(itens, [
    ['MLB4000000001', 'revisao', ['nao_conferido']],
    ['MLB4000000002', 'descartado', []],
    ['ASIN:B000000003', 'revisao', ['nao_conferido']],
    ['MLB4000000004', 'enviado', []],
  ]);
  // R2: o item descartado guarda por que (a tela do Histórico do catálogo mostra "Descartada: esgotado na loja")
  assert.deepEqual(s.db.prepare("SELECT chave, json_extract(oferta, '$.descartado_por') AS por FROM catalogo_itens WHERE rule_id = ? ORDER BY id").all(id).map((l) => [l.chave, l.por]),
    [['MLB4000000001', null], ['MLB4000000002', 'esgotado'], ['ASIN:B000000003', null], ['MLB4000000004', null]]);
  assert.deepEqual(s.eventos.filter((e) => e.startsWith('link')), ['link 4000000004'], 'só a conferida pede link');
  assert.deepEqual(logs(s.db, id).filter((l) => l.level === 'aviso').map((l) => [l.offer_title, l.message]), [
    ['Produto 1', 'Separada para revisão: não deu para conferir o preço (a loja não respondeu).'],
    ['Produto 2', 'Descartada: esgotado na loja'],
    ['Produto 3', 'Separada para revisão: não deu para conferir o preço (a API da Amazon não está ligada).'],
  ]);
  assert.deepEqual(titulos(s.wa), ['*Produto 4*']);
  assert.ok(s.wa.simulated[0].text.includes('R$ 95,00') && !s.wa.simulated[0].text.includes('R$ 100,00'), 'sai com o preço conferido');
  assert.equal(logs(s.db, id).find((l) => l.level === 'ok').message, 'Enviado com a etiqueta etiquetaA · preço atualizado de R$ 100,00 para R$ 95,00');
  semErro(s.db, id);

  // a descartada conta como tratada: a próxima execução não a confere de novo
  s.eventos.length = 0;
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 0);
  assert.deepEqual(s.eventos, [], 'nenhuma releitura da descartada nem das que esperam revisão');
});

// --------------------------------------------------------------------------------------------- grade (CA7 da grade)

test('grade: a frase "saíram N de M" cita as descartadas pelo verificador (que não são repostas)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 10, 0) });
  const s = montar({ loja: { 9000001: { price: 69.9, disponivel: false }, 9000002: { price: 29.9, disponivel: true }, 9000003: { price: 299.9, disponivel: true }, 9000004: { price: 59.9, disponivel: true }, 9000005: { price: 89.9, disponivel: true } } });
  const id = regraCentral(s.db, { per: 1 });
  s.db.prepare('UPDATE rules SET grade = ?, next_run_at = ? WHERE id = ?').run(JSON.stringify({
    dias: [0, 1, 2, 3, 4, 5, 6], horarios: [{ hora: '10:00', qtd: 3, template_id: null }, { hora: '11:00', qtd: 8, template_id: null }],
  }), dia(2, 10, 0), id);
  const avisoDaGrade = () => s.db.prepare("SELECT message FROM log WHERE rule_id = ? AND level = 'aviso' AND message LIKE 'Horário%' ORDER BY id DESC").get(id)?.message;

  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 2);
  assert.equal(avisoDaGrade(), 'Horário 10:00: saíram 2 de 3 ofertas; 1 descartada na conferência de preço e estoque.');

  // 11:00 pede 8: sobram 2 novas (a esgotada está em pausa), e o motivo das duas faltas aparece
  t.mock.timers.setTime(dia(2, 11, 0));
  s.eventos.length = 0;
  await s.scheduler.tick();
  assert.equal(s.wa.simulated.length, 4);
  assert.equal(avisoDaGrade(), 'Horário 11:00: saíram 2 de 8 ofertas; não havia mais ofertas novas dentro dos filtros.');
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
  assert.equal(msg, 'Horário 10:00: saíram 3 de 8 ofertas; 2 descartadas na conferência de preço e estoque e não havia mais ofertas novas dentro dos filtros.');
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
