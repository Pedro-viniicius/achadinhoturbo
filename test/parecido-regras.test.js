// Produto igual ou parecido no Disparo automático, de ponta a ponta (plano nao-repetir-produto-parecido, etapa 3;
// CA1 a CA8): agendador real (createScheduler), WhatsApp simulado, links em modo simulado, verificador real com a
// loja falsa (conferirProduto injetado) e, para o catálogo, o cliente real do Etiqueta (createCatalogo) com um fetch
// falso em memória. O relógio é falso (só o Date): "3 h depois" e "25 h depois" são exatos. Nenhuma loja nem o
// WhatsApp reais são chamados.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createScheduler } from '../src/scheduler.js';
import { createLinkService } from '../src/links.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createVerificador } from '../src/verificador.js';
import { createCatalogo, filtroDe } from '../src/catalogo.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { createAmazon } from '../src/amazon.js';
import { FRASE_MAIS_BARATA } from '../src/parecido.js';
import { LINHA_ULTIMO_ENVIO } from '../src/template.js';
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
const tmp = (nome = 'pareg') => { const p = fs.mkdtempSync(path.join(os.tmpdir(), `${nome}-`)); pastas.push(p); return p; };

const HORA = 3600000;
const dia = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // 10/11/2026, horário local
const AGORA = dia(10, 14);
const idDe = (url) => /MLB-?(\d+)/.exec(String(url))?.[1] ?? null;

// Produtos de teste (3 ou mais palavras significativas; A e B são parecidas: 6 de 7 palavras em comum)
const A = 'Fone de Ouvido Bluetooth JBL Tune 510BT Preto';
const B = 'Fone de Ouvido Bluetooth JBL Tune 510BT Branco';
const C = 'Tênis Corrida Masculino Nike Revolution 7';
const D = 'Liquidificador Philco 900W 3 Velocidades';
const linha = (n, titulo, preco) => `https://produto.mercadolivre.com.br/MLB-${1000000 + n}-x | ${titulo} | ${String(preco).replace('.', ',')}`;

/**
 * Agendador. `loja`: id do MLB (só os dígitos) → { price, disponivel }; o que não estiver lá lança. `eventos` guarda,
 * em ordem, cada conferência e cada pedido de link. `verificar: false` = sem o verificador.
 */
function montar(t, { agora = AGORA, loja = {}, verificar = false, verificadorFalso = null, catalogo = null, catalogoItens = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: agora }); // antes do agendador: o ritmo guarda o Date.now
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
      if (!r) throw new Error('loja fora do ar (falsa)');
      return r;
    },
  };
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const verificador = verificadorFalso ?? (verificar ? createVerificador({ db, ml: mlLoja, amazon }) : null);
  const extra = {};
  if (catalogo) { extra.catalogo = catalogo; extra.catalogoItens = catalogoItens || createCatalogoItens({ db, wa, links, amazon }); }
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador, ...extra });
  for (const [jid, nome] of [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  }
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  return { db, wa, links, scheduler, eventos, amazon };
}

/** Template com o corpo dado. → id */
const template = (db, body) => Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run(`T${Math.random()}`, body, Date.now()).lastInsertRowid);
const CORPO = '*{TITULO_PRODUTO}*\n{PRECO_PRODUTO}\n{LINK}';

/** Regra da "Lista de links" (linha com preço = preço digitado). */
const regraLista = (db, itens, { per = 3, dedupe = 7, tpl = template(db, CORPO), imagem = 0 } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled,
  tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES ('Lista', 1, 1, ?, ?, 'list', ?, ?, 60, '00:00', '23:59', ?, ?, ?)`)
  .run(tpl, JSON.stringify(['111@g.us']), JSON.stringify({ items: itens.join('\n') }), per, dedupe, imagem, Date.now()).lastInsertRowid);

/** Regra de catálogo (uma fonte, `config`). */
const regraCatalogo = (db, { cfg = { ordem: 'relevancia' }, per = 3, dedupe = 7, tpl = template(db, CORPO), imagem = 0 } = {}) => Number(db.prepare(`INSERT INTO rules (name,
  enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days,
  send_image, created_at) VALUES ('Catálogo', 1, 1, ?, ?, 'list', '{}', ?, ?, 60, '00:00', '23:59', ?, ?, ?)`)
  .run(tpl, JSON.stringify(['111@g.us']), JSON.stringify([{ type: 'catalogo', tag_id: null, config: cfg }]), per, dedupe, imagem, Date.now()).lastInsertRowid);

/** Linha de `sent_offers` como se a regra tivesse enviado: `preco` em centavos (null = sem preço guardado). */
const semear = (db, ruleId, { key, titulo, preco = null, em }) => db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)')
  .run(ruleId, key, em, titulo, preco);

const logs = (db, id) => db.prepare('SELECT level, group_name, offer_title, message FROM log WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l }));
// as linhas da trava; a contagem das candidatas que ficaram de fora (plano rodar-sozinho-entrega1, B5) fica de fora como a "Sem ofertas"
const infos = (db, id) => logs(db, id).filter((l) => l.level === 'info' && l.message !== 'Sem ofertas novas dentro dos filtros desta vez.' && !l.message.startsWith('Antes da escolha, '));
const enviadas = (db, id) => db.prepare('SELECT offer_key, title, price_cents FROM sent_offers WHERE rule_id = ? ORDER BY id').all(id).map((l) => ({ ...l }));
const textos = (wa) => wa.simulated.map((m) => m.text);
// a frase "Saíram X de Y" (aviso, plano rodar-sozinho-entrega1, B5) é da execução que saiu com menos que o pedido, não da trava
const semAlerta = (db, id) => assert.deepEqual(logs(db, id).filter((l) => (l.level === 'erro' || l.level === 'aviso') && !l.message.startsWith('Saíram ')), [], 'só linhas info');
/** CA6: as linhas novas não trazem grupo, número nem JID. */
const semDadoPessoal = (linhas) => {
  for (const l of linhas) {
    assert.equal(l.group_name, null, 'sem nome de grupo');
    assert.doesNotMatch(l.message, /@|Achadinhos|Tech|\d{8,}/, 'sem JID, nome de grupo nem número');
  }
};

// ----------------------------------------------------------------------------------------------- CA1: mesmo título

test('CA1: o mesmo título com outra chave não sai; a regra tenta a próxima (CA3) e a linha info diz por quê', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, A, 49.9), linha(2, C, 199.9)], { per: 1 });
  semear(s.db, id, { key: 'MLB999', titulo: A, preco: 4990, em: dia(8, 9, 2) });

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [1, 1, 0]);
  assert.deepEqual(enviadas(s.db, id).map((e) => e.offer_key), ['MLB999', 'MLB1000002'], 'só a diferente foi enviada');
  assert.ok(textos(s.wa)[0].startsWith('*Tênis Corrida'), 'sem a frase: não é a mais barata');
  assert.equal(textos(s.wa).some((x) => x.includes(FRASE_MAIS_BARATA)), false);
  assert.deepEqual(infos(s.db, id).map((l) => [l.level, l.offer_title, l.message]), [[
    'info', A, `Pulada: o mesmo produto saiu por este disparo às 09:02 de 08/11 por R$ 49,90, com outro código ("${A}"). Só sai de novo se estiver pelo menos 5% mais barato.`,
  ]]);
  semDadoPessoal(infos(s.db, id));
  semAlerta(s.db, id);
});

test('CA1: com "dias sem repetir" = 0 a trava entre rodadas fica desligada; a chave exata segue como hoje (CA8)', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, A, 49.9)], { per: 1, dedupe: 0 });
  semear(s.db, id, { key: 'MLB999', titulo: A, preco: 4990, em: dia(10, 13) });

  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1, 'o mesmo título, outra chave, sai: a janela é 0');
  assert.equal(infos(s.db, id).length, 0);
  // e a mesma chave repete como sempre com dedupe 0
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 1, 'dedupe 0 repete a mesma chave (wasSent não bloqueia)');
  assert.equal(s.wa.simulated.length, 2);
});

test('CA8: a mesma chave dentro da janela continua barrada só por wasSent, sem linha da trava', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, A, 49.9)], { per: 1 });
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 4990, em: dia(10, 13) });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 0);
  assert.deepEqual(logs(s.db, id).map((l) => l.message), ['Sem ofertas novas dentro dos filtros desta vez.']);
});

// ----------------------------------------------------------------------------------------------- CA2: mesma rodada

for (const dedupe of [7, 0]) {
  test(`CA2/CA3: parecidos na mesma rodada nunca saem, nem o mais barato (dedupe_days = ${dedupe}); a próxima candidata sai`, async (t) => {
    const s = montar(t);
    const id = regraLista(s.db, [linha(1, A, 59.9), linha(2, B, 29.9), linha(3, C, 199.9), linha(4, D, 99.9)], { per: 3, dedupe });

    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages, r.errors], [3, 3, 0]);
    assert.deepEqual(enviadas(s.db, id).map((e) => e.offer_key), ['MLB1000001', 'MLB1000003', 'MLB1000004']);
    assert.deepEqual(infos(s.db, id).map((l) => [l.offer_title, l.message]), [[B, `Pulada: parecida com "${A}", que foi escolhida neste mesmo envio.`]]);
    assert.equal(textos(s.wa).some((x) => x.includes(FRASE_MAIS_BARATA)), false, 'a mais barata da mesma rodada não leva a frase');
    semDadoPessoal(infos(s.db, id));
    semAlerta(s.db, id);
  });
}

test('CA3: produtos diferentes da mesma marca saem juntos; título com 2 palavras nunca é comparado', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [
    linha(1, 'Shampoo Lola Cachos Hidratante 300ml', 39.9), linha(2, 'Condicionador Lola Reconstrução Intensa 250ml', 41.9),
    linha(3, 'Fone Bom', 20), linha(4, 'Fone Bom', 19), // 2 palavras: nunca comparado
  ], { per: 4 });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [4, 4]);
  assert.deepEqual(infos(s.db, id), []);
});

// ------------------------------------------------------------------------------------------- CA2: entre rodadas

test('CA2: parecida há 3 h espera (24 h); 25 h depois sai, sem a frase', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(2, B, 49.9)], { per: 1 });
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 4990, em: AGORA - 3 * HORA });

  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 0);
  assert.deepEqual(infos(s.db, id).map((l) => [l.offer_title, l.message]), [[B,
    `Pulada: parecida com "${A}", que saiu por este disparo às 11:00 por R$ 49,90. Ofertas parecidas esperam 24 h.`]]);
  assert.equal(s.wa.simulated.length, 0);

  t.mock.timers.setTime(AGORA + 22 * HORA); // 25 h depois do envio da A
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 1, 'passadas as 24 h, a parecida sai');
  assert.equal(textos(s.wa)[0].includes(FRASE_MAIS_BARATA), false);
  assert.ok(textos(s.wa)[0].startsWith('*Fone de Ouvido Bluetooth JBL Tune 510BT Branco*'));
});

test('CA2: com "dias sem repetir" = 2 dias, a parecida espera só as 24 h (não os 2 dias)', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(2, B, 49.9)], { per: 1, dedupe: 2 });
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 4990, em: AGORA - 26 * HORA });
  assert.equal((await s.scheduler.runRule(id)).offers, 1, 'há 26 h: fora da espera de 24 h, mesmo dentro da janela de 2 dias');
});

test('CA2 (D10): parecida bem mais barata também espera as 24 h (3 h barra); 25 h depois sai, sem a frase e sem "Saiu como…"', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(2, B, 10)], { per: 1 });
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 4990, em: AGORA - 3 * HORA });

  assert.equal((await s.scheduler.runRule(id)).offers, 0, 'R$ 10,00 contra R$ 49,90: parecida não tem exceção de preço');
  assert.deepEqual(infos(s.db, id).map((l) => [l.offer_title, l.message]), [[B,
    `Pulada: parecida com "${A}", que saiu por este disparo às 11:00 por R$ 49,90. Ofertas parecidas esperam 24 h.`]]);
  assert.equal(s.wa.simulated.length, 0);

  t.mock.timers.setTime(AGORA + 22 * HORA); // 25 h depois do envio da A
  assert.equal((await s.scheduler.runRule(id)).offers, 1);
  assert.equal(textos(s.wa)[0].includes(FRASE_MAIS_BARATA), false, 'a parecida que sai depois das 24 h não leva a frase');
  assert.ok(textos(s.wa)[0].startsWith(`*${B}*`));
  assert.equal(infos(s.db, id).length, 1, 'sem a linha "Saiu como oportunidade melhor"');
});

// --------------------------------------------------------------------------------------------- CA4/CA5: mais barata

for (const [nome, corpo, comeco] of [
  ['template com título', CORPO, '*Fone de Ouvido Bluetooth JBL Tune 510BT Preto*'],
  ['template só com o link', '{LINK}', 'https://meli.la/'],
]) {
  test(`CA4/CA5/CA6: o mesmo título 5% mais barato (no limite) sai com a frase, linha em branco e o texto de sempre (${nome})`, async (t) => {
    const s = montar(t);
    const tpl = template(s.db, corpo);
    // 95% de 49,90 = 47,405: R$ 47,40 é o maior preço que passa
    const id = regraLista(s.db, [linha(2, A, 47.4), linha(3, C, 199.9)], { per: 2, tpl });
    semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 4990, em: AGORA - 3 * HORA });

    const r = await s.scheduler.runRule(id);
    assert.deepEqual([r.offers, r.messages, r.errors], [2, 2, 0]);
    const [barata, outra] = textos(s.wa);
    assert.ok(barata.startsWith(`${FRASE_MAIS_BARATA}\n\n${comeco}`), 'frase, linha em branco e o texto');
    assert.equal(outra.includes(FRASE_MAIS_BARATA), false, 'nenhuma outra mensagem leva a frase');
    assert.equal(barata.split(FRASE_MAIS_BARATA).length, 2, 'a frase aparece uma vez');
    assert.deepEqual(infos(s.db, id).map((l) => [l.offer_title, l.message]), [[A,
      `Saiu como oportunidade melhor: o mesmo produto saiu às 11:00 por R$ 49,90 ("${A}"); agora por R$ 47,40.`]]);
    assert.deepEqual(enviadas(s.db, id).slice(1), [
      { offer_key: 'MLB1000002', title: A, price_cents: 4740 }, { offer_key: 'MLB1000003', title: C, price_cents: 19990 },
    ], 'título e preço em centavos gravados');
    semDadoPessoal(infos(s.db, id));
    semAlerta(s.db, id);
  });
}

test('CA4: o mesmo título com outra chave e preço bem menor também sai com a frase', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(2, A, 44.9)], { per: 1 });
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 4990, em: dia(8, 9, 2) });
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1);
  assert.ok(textos(s.wa)[0].startsWith(`${FRASE_MAIS_BARATA}\n\n*${A}*`));
  assert.equal(infos(s.db, id)[0].message, `Saiu como oportunidade melhor: o mesmo produto saiu às 09:02 de 08/11 por R$ 49,90 ("${A}"); agora por R$ 44,90.`);
});

test('CA4: menos de 5% abaixo, igual ou maior barra; vale o mínimo entre os envios do mesmo título; anterior sem preço barra', async (t) => {
  // histórico: o mesmo título três vezes, com 59,90, 49,90 e 54,90; a candidata só sai com até R$ 47,40 (95% de 49,90)
  for (const [preco, sai] of [[49.9, false], [49.89, false], [47.41, false], [60, false], [47.4, true]]) {
    await t.test(`preço ${preco}`, async (st) => {
      const s = montar(st);
      const id = regraLista(s.db, [linha(9, A, preco)], { per: 1 });
      semear(s.db, id, { key: 'MLB1', titulo: A, preco: 5990, em: AGORA - 5 * HORA });
      semear(s.db, id, { key: 'MLB2', titulo: `${A} Original`, preco: 4990, em: AGORA - 4 * HORA }); // "original" não conta
      semear(s.db, id, { key: 'MLB3', titulo: `${A} Oferta`, preco: 5490, em: AGORA - 3 * HORA });
      const r = await s.scheduler.runRule(id);
      assert.equal(r.offers, sai ? 1 : 0);
      if (sai) assert.match(infos(s.db, id)[0].message, /^Saiu como oportunidade melhor: o mesmo produto saiu às 10:00 por R\$ 49,90 \(".* Original"\); agora por R\$ 47,40\.$/, 'cita a do mínimo');
      else assert.match(infos(s.db, id)[0].message, /^Pulada: o mesmo produto saiu por este disparo às 10:00 por R\$ 49,90, com outro código \(".* Original"\)\. Só sai de novo se estiver pelo menos 5% mais barato\.$/, 'cita a do mínimo');
    });
  }
  await t.test('anterior sem preço guardado: barra, mesmo com a candidata baratíssima', async (st) => {
    const s = montar(st);
    const id = regraLista(s.db, [linha(9, A, 1)], { per: 1 });
    semear(s.db, id, { key: 'MLB1', titulo: A, preco: null, em: AGORA - 3 * HORA });
    assert.equal((await s.scheduler.runRule(id)).offers, 0);
    assert.equal(infos(s.db, id)[0].message, `Pulada: o mesmo produto saiu por este disparo às 11:00 sem preço guardado para comparar, com outro código ("${A}"). Só sai de novo se estiver pelo menos 5% mais barato.`);
  });
});

test('CA4 (D10): o mesmo título bem mais barato, com uma parecida nas últimas 24 h, barra citando a parecida; passadas as 24 h sai com a frase', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(2, A, 10)], { per: 1 });
  semear(s.db, id, { key: 'MLB1', titulo: A, preco: 9990, em: dia(8, 9, 2) });
  semear(s.db, id, { key: 'MLB3', titulo: B, preco: 9990, em: AGORA - 3 * HORA });

  assert.equal((await s.scheduler.runRule(id)).offers, 0);
  assert.deepEqual(infos(s.db, id).map((l) => [l.offer_title, l.message]), [[A,
    `Pulada: parecida com "${B}", que saiu por este disparo às 11:00 por R$ 99,90. Ofertas parecidas esperam 24 h.`]]);

  t.mock.timers.setTime(AGORA + 22 * HORA); // a B ficou com 25 h: só o mesmo título conta, e ele libera
  assert.equal((await s.scheduler.runRule(id)).offers, 1);
  assert.ok(textos(s.wa)[0].startsWith(`${FRASE_MAIS_BARATA}\n\n*${A}*`));
  assert.equal(infos(s.db, id).at(-1).message, `Saiu como oportunidade melhor: o mesmo produto saiu às 09:02 de 08/11 por R$ 99,90 ("${A}"); agora por R$ 10,00.`);
});

// --------------------------------------------------------------------------- regra 8: conferência na loja

/** Regra da Central de Afiliados (amostraHub, modo simulado): MLB9000001 = "Kit 10 Potes Herméticos de Vidro", R$ 69,90. */
const regraCentral = (db, { per = 1, tpl = template(db, CORPO) } = {}) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id,
  template_id, group_jids, source_type, source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
  VALUES ('Central', 1, 1, ?, ?, 'afiliados', ?, ?, 60, '00:00', '23:59', 7, 0, ?)`)
  .run(tpl, JSON.stringify(['111@g.us']), JSON.stringify({ categoria: 'MLB1574', paginas: 1 }), per, Date.now()).lastInsertRowid);
const POTES = 'Kit 10 Potes Herméticos de Vidro';
// 95% de R$ 74,00 = R$ 70,30: com o anterior a 74,00, os 69,90 da Central passam na escolha
const PRECO_POTES_ANTES = 7400;

test('regra 8: o verificador sobe o preço (4%) acima do mínimo → pulada, sem link e sem envio; a vaga vai à próxima candidata', async (t) => {
  const s = montar(t, { verificar: true, loja: { 9000001: { price: 72.5, disponivel: true }, 9000002: { price: 29.9, disponivel: true } } });
  const id = regraCentral(s.db, { per: 1 });
  semear(s.db, id, { key: 'MLB9999', titulo: POTES, preco: PRECO_POTES_ANTES, em: AGORA - 3 * HORA }); // 69,90 ≤ 70,30: passa na escolha

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors, r.descartadas, r.puladas], [1, 1, 0, 0, 1]);
  assert.deepEqual(s.eventos, ['conferir 9000001', 'conferir 9000002', 'link 9000002'], 'a dos potes foi conferida e não pediu link; a vaga foi reposta (rodar-sozinho CA1.7)');
  assert.equal(s.wa.simulated.length, 1);
  assert.equal(textos(s.wa)[0].includes(POTES), false, 'os potes não saíram');
  assert.deepEqual(enviadas(s.db, id).map((e) => e.offer_key), ['MLB9999', 'MLB9000002'], 'os potes não entram em sent_offers');
  assert.deepEqual(infos(s.db, id).map((l) => [l.offer_title, l.message]), [[POTES,
    `Pulada: na conferência o preço ficou em R$ 72,50, que não é pelo menos 5% menor que o de "${POTES}" (R$ 74,00, às 11:00).`]]);
  semDadoPessoal(infos(s.db, id));
  semAlerta(s.db, id);
});

test('regra 8: conferido ainda abaixo do mínimo, sai com a frase e o preço da loja; sem a marca, o preço não é comparado', async (t) => {
  const s = montar(t, { verificar: true, loja: { 9000001: { price: 69, disponivel: true }, 9000002: { price: 31, disponivel: true } } });
  const id = regraCentral(s.db, { per: 2 });
  semear(s.db, id, { key: 'MLB9999', titulo: POTES, preco: PRECO_POTES_ANTES, em: AGORA - 3 * HORA });

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [2, 2]);
  const [barata, outra] = textos(s.wa);
  assert.ok(barata.startsWith(`${FRASE_MAIS_BARATA}\n\n*${POTES}*\nR$ 69,00`), 'preço conferido na mensagem');
  assert.equal(outra.includes(FRASE_MAIS_BARATA), false, 'a de outro produto sai como sempre (o preço dela subiu e não importa)');
  assert.deepEqual(infos(s.db, id).map((l) => l.message), [`Saiu como oportunidade melhor: o mesmo produto saiu às 11:00 por R$ 74,00 ("${POTES}"); agora por R$ 69,00.`]);
  assert.equal(enviadas(s.db, id)[1].price_cents, 6900, 'grava o preço conferido, não o da escolha');
});

test('regra 8 (D11): limite exato dos 5% na conferência: R$ 70,30 contra R$ 74,00 sai com a frase; R$ 70,31 é pulada', async (t) => {
  for (const [preco, sai] of [[70.3, true], [70.31, false]]) {
    await t.test(`conferido ${preco}`, async (st) => {
      const s = montar(st, { verificar: true, loja: { 9000001: { price: preco, disponivel: true } } });
      const id = regraCentral(s.db, { per: 1 });
      semear(s.db, id, { key: 'MLB9999', titulo: POTES, preco: PRECO_POTES_ANTES, em: AGORA - 3 * HORA });
      const r = await s.scheduler.runRule(id);
      assert.equal(r.messages, 1, 'a pulada dá a vaga à próxima candidata (rodar-sozinho CA1.7)');
      if (sai) {
        assert.ok(textos(s.wa)[0].startsWith(`${FRASE_MAIS_BARATA}\n\n*${POTES}*\nR$ 70,30`));
        assert.equal(infos(s.db, id).at(-1).message, `Saiu como oportunidade melhor: o mesmo produto saiu às 11:00 por R$ 74,00 ("${POTES}"); agora por R$ 70,30.`);
      } else {
        assert.equal(textos(s.wa)[0].includes(POTES), false, 'os potes não saem');
        assert.equal(s.eventos[0], 'conferir 9000001');
        assert.equal(s.eventos.includes('link 9000001'), false, 'sem link para os potes');
        assert.equal(infos(s.db, id).at(-1).message, `Pulada: na conferência o preço ficou em R$ 70,31, que não é pelo menos 5% menor que o de "${POTES}" (R$ 74,00, às 11:00).`);
      }
    });
  }
});

test('regra 8: a marca interna da trava não chega ao verificador, e a frase vale mesmo com a oferta devolvida por ele', async (t) => {
  const recebidas = [];
  const verificadorFalso = { conferir: async (o) => { recebidas.push(Object.keys(o)); return { acao: 'enviar', oferta: { ...o, price: 68.5 } }; } };
  const s = montar(t, { verificadorFalso });
  const id = regraCentral(s.db, { per: 1 });
  semear(s.db, id, { key: 'MLB9999', titulo: POTES, preco: PRECO_POTES_ANTES, em: AGORA - 3 * HORA });
  assert.equal((await s.scheduler.runRule(id)).messages, 1);
  assert.equal(recebidas.length, 1);
  assert.equal(recebidas[0].includes('maisBarata'), false, 'o verificador não vê a marca');
  assert.ok(textos(s.wa)[0].startsWith(`${FRASE_MAIS_BARATA}\n\n*${POTES}*\nR$ 68,50`), 'a marca ficou em picked[i], não na oferta devolvida');
});

test('regra 8 (S2/Q2): a oferta liberada que volta da conferência sem preço legível é pulada, sem frase e sem linha com preço vazio', async (t) => {
  const verificadorFalso = { async conferir(o) { const { price: _p, ...semPreco } = o; return { acao: 'enviar', oferta: semPreco }; } };
  const s = montar(t, { verificadorFalso });
  const id = regraLista(s.db, [linha(2, A, 49.9)], { per: 1 }); // 49,90 contra 59,90: liberada na escolha
  semear(s.db, id, { key: 'MLB1', titulo: A, preco: 5990, em: AGORA - 3 * HORA });
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [0, 0, 0]);
  assert.equal(s.wa.simulated.length, 0, 'não sai, nem sem a frase');
  assert.deepEqual(s.eventos, [], 'nem pede link');
  assert.equal(enviadas(s.db, id).length, 1, 'nada novo em sent_offers');
  assert.deepEqual(infos(s.db, id), [], 'sem "Saiu como…" e sem "Pulada: na conferência o preço ficou em ," (sem preço)');
  semAlerta(s.db, id);
});

test('CA7: "Enviar agora" (execução manual) aplica a mesma trava', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(2, B, 49.9)], { per: 1 });
  semear(s.db, id, { key: 'MLB1', titulo: A, preco: 4990, em: AGORA - 3 * HORA });
  const r = await s.scheduler.runRule(id, { manual: true });
  assert.equal(r.offers, 0);
  assert.match(infos(s.db, id)[0].message, /^Pulada: parecida com/);
});

// ------------------------------------------------------------------------------------ "Ver ofertas" (prévia)

test('Ver ofertas: mostra a frase na mais barata e as puladas ficam de fora; não grava nem loga nada', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(2, B, 10), linha(3, A, 80), linha(5, A, 47.4), linha(4, C, 199.9)], { per: 2 });
  semear(s.db, id, { key: 'MLB1', titulo: A, preco: 4990, em: AGORA - 3 * HORA });
  const antes = JSON.stringify([s.db.prepare('SELECT * FROM log').all(), s.db.prepare('SELECT * FROM sent_offers').all()]);

  const previa = await s.scheduler.previewOffers(id);
  assert.deepEqual(previa.map((o) => o.key), ['MLB1000005', 'MLB1000004'], 'a 2 (parecida, mesmo mais barata) e a 3 (mesmo título, mais cara) ficam de fora');
  assert.ok(previa[0].text.startsWith(`${FRASE_MAIS_BARATA}\n\n*${A}*`));
  assert.equal(previa[1].text.includes(FRASE_MAIS_BARATA), false);
  // R7/S3: a marca da trava é interna; o painel vê só a frase no texto
  for (const o of previa) assert.equal(Object.hasOwn(o, 'maisBarata'), false, 'a prévia não devolve o campo interno');
  assert.equal(JSON.stringify([s.db.prepare('SELECT * FROM log').all(), s.db.prepare('SELECT * FROM sent_offers').all()]), antes, 'a prévia não grava');
  assert.equal(s.wa.simulated.length, 0);
});

// ----------------------------------------------------------------------------------------------- catálogo

const TOKEN = `tkFALSO_${randomBytes(30).toString('base64url')}`;
const asin = (i) => `B0${String(i).padStart(8, '0')}`;
function oferta(i, titulo, preco, loja = 'amazon', mais = {}) {
  const base = {
    id: i, loja, categoria: 'Casa', busca: '', titulo, preco, preco_antigo: preco * 2, desconto_pct: 50, vendas: 10, avaliacao: 4.5,
    num_avaliacoes: 3, frete_gratis: true, cupom: '', criado_em: '2026-11-03T12:00:00', atualizado_em: '2026-11-03T12:00:00', genero: 'sem',
  };
  if (loja === 'amazon') Object.assign(base, { item_id: asin(i), link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20', imagem: `https://m.media-amazon.com/images/I/${i}.jpg` });
  if (loja === 'ml') Object.assign(base, { item_id: `MLB${4000000000 + i}`, link: 'https://meli.la/TerCeiro1', imagem: `https://http2.mlstatic.com/D_${i}.jpg` });
  if (loja === 'shopee') Object.assign(base, { item_id: `123.${i}`, link: `https://s.shopee.com.br/Ab${i}cd`, imagem: `https://down-br.img.susercontent.com/file/${i}`, preco_antigo: null, desconto_pct: 0 });
  base.chave = `${loja}:${base.item_id}`;
  return { ...base, ...mais };
}

/** Cliente real do Etiqueta com um fetch em memória (mesma regra de cursor do servidor falso de test/catalogo-regras.test.js). */
function etiquetaFalsa(db, estado) {
  const caminho = path.join(tmp('pareg-token'), 'api_token.txt');
  fs.writeFileSync(caminho, `${TOKEN}\n`, { mode: 0o600 });
  const fetchFalso = async (url, init = {}) => {
    const u = new URL(String(url));
    // releitura da Amazon pelo Etiqueta (rodar-sozinho-entrega1): `estado.releitura[asin]` = preço lido agora na página
    const relida = /^\/api\/v1\/amazon\/([A-Z0-9]{10})\/confirmar-preco$/.exec(u.pathname);
    if (init.method === 'POST' && relida) {
      const preco = estado.releitura?.[relida[1]];
      if (preco == null) return new Response('{}', { status: 404 });
      const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
      const precoEm = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
      return new Response(JSON.stringify({ versao: 1, resultado: 'confirmado', preco, preco_antigo: null, desconto_pct: null, preco_em: precoEm }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    const limite = Number(u.searchParams.get('limite') ?? 50);
    const ordem = u.searchParams.get('ordem') ?? 'atualizacao';
    const cursor = u.searchParams.get('cursor');
    const m = cursor == null ? [null, '0'] : (ordem === 'atualizacao' ? /^c(\d+)$/ : /^(\d+)$/).exec(cursor);
    if (!m) return new Response('{}', { status: 400 });
    const inicio = Number(m[1]);
    const lojas = u.searchParams.getAll('loja');
    const todas = lojas.length ? estado.ofertas.filter((o) => lojas.includes(o.loja)) : estado.ofertas;
    const pagina = todas.slice(inicio, inicio + limite);
    const fim = inicio + pagina.length;
    const proximo = ordem === 'atualizacao' ? (pagina.length ? `c${fim}` : null) : (fim < todas.length ? String(fim) : null);
    return new Response(JSON.stringify({ versao: 1, ofertas: pagina, proximo, total: todas.length }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
  return createCatalogo({ db, fetch: fetchFalso, lerConexao: () => ({ endereco: 'http://127.0.0.1:9', caminho_token: caminho }), timeoutMs: 3000 });
}

/** Agendador com o catálogo real (`estado.ofertas` troca as ofertas entre as execuções). `ml`: troca o módulo do ML. */
function montarCatalogo(t, { ofertas = [], ...opcoes } = {}) {
  const estado = { ofertas, releitura: opcoes.releitura ?? null };
  // o catálogo precisa do banco do agendador: cria o agendador, depois liga o catálogo no mesmo banco
  const dir = tmp('pareg-cat'); const db = openDb(dir);
  t.mock.timers.enable({ apis: ['Date'], now: opcoes.agora ?? AGORA });
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const eventos = [];
  const pedirLink = links.requestLink;
  links.requestLink = async (p) => { eventos.push(`link ${idDe(p.url)}`); return pedirLink(p); };
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida (Amazon)'); }, esperar: async () => {}, lerConexao: () => ({ tag: 'achadinho-20' }) });
  const loja = opcoes.loja ?? {};
  const catalogo = etiquetaFalsa(db, estado);
  // `releitura`: o verificador relê a Amazon do catálogo pelo Etiqueta (estado.releitura), como em src/server.js
  const verificador = opcoes.verificar ? createVerificador({ db, amazon, ml: { async conferirProduto(url) { eventos.push(`conferir ${idDe(url)}`); const r = loja[idDe(url)]; if (!r) throw new Error('fora'); return r; } }, ...(opcoes.releitura ? { catalogo } : {}) }) : null;
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const scheduler = createScheduler({ db, wa, links, fast: true, amazon, verificador, catalogo, catalogoItens, ...(opcoes.ml ? { ml: opcoes.ml } : {}) });
  db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run('111@g.us', 'Achadinhos', 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  return { db, wa, links, scheduler, estado, eventos, catalogoItens };
}

test('catálogo: o mesmo título 5% mais barato sai com a frase na legenda da foto; o mais caro fica de fora e o item não é gravado', async (t) => {
  const s = montarCatalogo(t, { ofertas: [oferta(1, A, 80), oferta(2, A, 47.4), oferta(3, C, 199.9)] });
  const id = regraCatalogo(s.db, { per: 3, imagem: 1 });
  semear(s.db, id, { key: `ASIN:${asin(9)}`, titulo: A, preco: 4990, em: AGORA - 3 * HORA });

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [2, 2, 0]);
  const [barata, outra] = s.wa.simulated;
  assert.equal(barata.tipo, 'image', 'com foto');
  assert.ok(barata.text.startsWith(`${FRASE_MAIS_BARATA}\n\n*${A}*`), 'a frase na legenda');
  assert.equal(outra.tipo, 'image');
  assert.equal(outra.text.includes(FRASE_MAIS_BARATA), false);
  assert.deepEqual(enviadas(s.db, id).slice(1).map((e) => [e.offer_key, e.price_cents]), [[`ASIN:${asin(2)}`, 4740], [`ASIN:${asin(3)}`, 19990]]);
  const status = s.db.prepare('SELECT chave, status FROM catalogo_itens WHERE rule_id = ? ORDER BY id').all(id).map((l) => [l.chave, l.status]);
  assert.deepEqual(status, [[`ASIN:${asin(2)}`, 'enviado'], [`ASIN:${asin(3)}`, 'enviado']], 'a barrada não vira item');
  assert.deepEqual(infos(s.db, id).map((l) => [l.offer_title, l.message.slice(0, 22)]), [[A, 'Pulada: o mesmo produt'], [A, 'Saiu como oportunidade']]);
  semDadoPessoal(infos(s.db, id));
  semAlerta(s.db, id);
});

test('catálogo: verificador sobe o preço acima do mínimo → pulada, sem link nem item; Ver ofertas mostra a frase', async (t) => {
  // 47,00 contra 50,00 passa na escolha (até 47,50); a loja diz 49,00 (+4%, dentro do limite do verificador)
  const s = montarCatalogo(t, { verificar: true, loja: { 4000000001: { price: 49, disponivel: true } }, ofertas: [oferta(1, A, 47, 'ml')] });
  const id = regraCatalogo(s.db, { per: 1 });
  semear(s.db, id, { key: 'MLB4000000009', titulo: A, preco: 5000, em: AGORA - 3 * HORA });

  const previa = await s.scheduler.previewOffers(id);
  assert.ok(previa[0].text.startsWith(FRASE_MAIS_BARATA), 'a prévia não confere na loja: mostra a frase');

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [0, 0]);
  assert.deepEqual(s.eventos, ['conferir 4000000001'], 'conferiu, mas não pediu link');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM catalogo_itens').get().n, 0, 'nada registrado no Catálogo');
  assert.equal(infos(s.db, id).at(-1).message, `Pulada: na conferência o preço ficou em R$ 49,00, que não é pelo menos 5% menor que o de "${A}" (R$ 50,00, às 11:00).`);
});

test('catálogo: a oferta que vai à revisão (Shopee) não leva a marca da mais barata', async (t) => {
  const s = montarCatalogo(t, { ofertas: [oferta(1, A, 10, 'shopee')] });
  const id = regraCatalogo(s.db, { per: 1 });
  semear(s.db, id, { key: 'ASIN:B000000009', titulo: A, preco: 4990, em: AGORA - 3 * HORA });
  const [o] = await s.scheduler.previewOffers(id);
  assert.equal(o.revisao, true);
  assert.equal(o.maisBarata, undefined, 'o "Enviar" decide de novo');
  assert.equal(o.text.includes(FRASE_MAIS_BARATA), false);
  const r = await s.scheduler.runRule(id);
  assert.equal(r.revisao, 1);
  assert.equal(s.wa.simulated.length, 0);
});

test('catálogo (Novidades): a barrada não prende o cursor; as outras seguem', async (t) => {
  const s = montarCatalogo(t, { ofertas: [oferta(1, D, 10), oferta(2, D, 11), oferta(3, D, 12)] });
  const cfg = { lojas: ['amazon'] }; // ordem padrão: atualizacao (Novidades)
  const id = regraCatalogo(s.db, { cfg, per: 5 });
  const cursor = () => s.db.prepare('SELECT cursor, pronto FROM catalogo_cursores WHERE rule_id = ? AND filtro = ?').get(id, filtroDe(cfg));

  assert.equal((await s.scheduler.runRule(id)).offers, 0, 'a primeira leitura não despeja o catálogo antigo');
  assert.equal(cursor().cursor, 'c3');
  s.estado.ofertas.push(oferta(4, B, 49.9), oferta(5, A, 59.9), oferta(6, C, 99));
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 2, 'a 5 é parecida com a 4, na mesma rodada');
  assert.deepEqual(infos(s.db, id).map((l) => l.message), [`Pulada: parecida com "${B}", que foi escolhida neste mesmo envio.`]);
  // R1: a pulada da mesma rodada não conta como tratada: o cursor fica na página e a próxima execução a avalia de novo
  assert.equal(cursor().cursor, 'c3', 'a pulada da rodada segura o cursor');
  assert.equal((await s.scheduler.runRule(id)).offers, 0, 'a 4 saiu de fato: agora a 5 é barrada por ela');
  assert.equal(infos(s.db, id).at(-1).message,
    `Pulada: parecida com "${B}", que saiu por este disparo às 14:00 por R$ 49,90. Ofertas parecidas esperam 24 h.`);
  assert.equal(cursor().cursor, 'c6', 'barrada por um envio anterior: o cursor passa dela');
  assert.equal((await s.scheduler.runRule(id)).offers, 0);
  assert.equal(infos(s.db, id).length, 2, 'nada de novo: a 5 não volta mais');
});

test('catálogo (Novidades), R1: a escolhida da rodada esgota na loja; a parecida sai na mesma execução (a que caiu não barra, rodar-sozinho CA1.12)', async (t) => {
  const loja = { 4000000004: { price: 49.9, disponivel: false }, 4000000005: { price: 59.9, disponivel: true } };
  const s = montarCatalogo(t, { verificar: true, loja, ofertas: [oferta(1, D, 10, 'ml')] });
  const cfg = { lojas: ['ml'] };
  const id = regraCatalogo(s.db, { cfg, per: 2 }); // 2 por envio: a 5 é avaliada (e pulada) na mesma rodada da 4
  assert.equal((await s.scheduler.runRule(id)).offers, 0, 'a primeira leitura só marca o ponto de partida');
  s.estado.ofertas.push(oferta(4, B, 49.9, 'ml'), oferta(5, A, 59.9, 'ml'));

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.descartadas], [1, 1, 1], 'a 4 (escolhida) esgotou na conferência e a 5 ocupou a vaga');
  assert.deepEqual(infos(s.db, id).filter((l) => l.message.startsWith('Pulada')), [], 'a 4 foi devolvida antes da próxima escolha: a 5 não é barrada');
  assert.ok(s.wa.simulated[0].text.startsWith(`*${A}*`), 'sem a frase: nada parecido saiu antes');
  assert.deepEqual(enviadas(s.db, id).map((e) => e.title), [A]);

  t.mock.timers.setTime(AGORA + 60 * 60000);
  assert.equal((await s.scheduler.runRule(id)).offers, 0, 'a 4 descartada não volta e a 5 já saiu');
});

// --------------------------------------------------------------------- R4/S1: uma linha "Pulada" por conflito

test('R4/S1: fora das Novidades, a mesma candidata barrada pelo mesmo motivo deixa uma linha só; outra anterior é linha nova', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(2, B, 55), linha(3, C, 199.9)], { per: 1 });
  semear(s.db, id, { key: 'MLB1', titulo: A, preco: 5000, em: AGORA - HORA });
  const puladas = () => infos(s.db, id).filter((l) => l.message.startsWith('Pulada'));

  for (let i = 0; i < 6; i++) { await s.scheduler.runRule(id); t.mock.timers.setTime(Date.now() + HORA); }
  assert.deepEqual(puladas().map((l) => [l.offer_title, l.message.slice(0, 26)]), [[B, `Pulada: parecida com "${A.slice(0, 4)}`]], '6 execuções, 1 linha');
  assert.equal(s.wa.simulated.length, 1, 'só a C saiu (e uma vez: wasSent)');

  // conflito novo: outra parecida, mais barata, saiu depois; a B passa a ser barrada por ela
  semear(s.db, id, { key: 'MLB7', titulo: `${A} Azul`, preco: 4500, em: Date.now() - 60000 });
  for (let i = 0; i < 3; i++) { await s.scheduler.runRule(id); t.mock.timers.setTime(Date.now() + HORA); }
  assert.equal(puladas().length, 2, 'uma linha para o conflito novo, e só uma');
  assert.match(puladas()[1].message, /^Pulada: parecida com ".* Azul", que saiu por este disparo às .* por R\$ 45,00\./);
});

test('R4/S1: o mesmo título com outra chave fica barrado pelos dias da regra com uma linha só (e cada candidata tem a sua)', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(2, A, 55), linha(3, A, 56), linha(4, C, 199.9)], { per: 1 });
  semear(s.db, id, { key: 'MLB1', titulo: A, preco: 5000, em: AGORA - HORA });
  for (let i = 0; i < 48; i++) { await s.scheduler.runRule(id); t.mock.timers.setTime(Date.now() + HORA); }
  const mesmo = infos(s.db, id).filter((l) => l.message.startsWith('Pulada: o mesmo produto'));
  assert.equal(mesmo.length, 2, 'em 2 dias, uma linha por candidata (as duas chaves)');
});

// Com a escolha preguiçosa (plano rodar-sozinho-entrega1, B5), só uma escolhida que saiu barra a da mesma rodada: a que
// cai fora é devolvida antes da próxima escolha. Com "dias sem repetir" = 0, a mesma escolhida sai a cada execução e
// barra a parecida de novo, sempre pelo mesmo conflito
test('R4/S1: a pulada da mesma rodada também é dita uma vez (dias = 0: a escolhida sai a cada execução)', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, A, 59.9), linha(2, B, 49.9)], { per: 2, dedupe: 0 });
  for (let i = 0; i < 3; i++) { await s.scheduler.runRule(id); t.mock.timers.setTime(Date.now() + HORA); }
  assert.deepEqual(textos(s.wa).map((x) => x.split('\n')[0]), [`*${A}*`, `*${A}*`, `*${A}*`]);
  const rodada = infos(s.db, id).filter((l) => l.message.endsWith('que foi escolhida neste mesmo envio.'));
  assert.deepEqual(rodada.map((l) => l.offer_title), [B], '3 execuções, 1 linha');
});

test('R4/S1 (rodar-sozinho CA1.12): a escolhida cujo link falha é devolvida; a parecida sai na mesma execução, sem linha de "mesmo envio"', async (t) => {
  const s = montar(t);
  const pedir = s.links.requestLink;
  s.links.requestLink = async (p) => { if (String(p.url).includes('MLB-1000001')) throw new Error('falha de teste'); return pedir(p); };
  const id = regraLista(s.db, [linha(1, A, 59.9), linha(2, B, 49.9)], { per: 2 });
  await s.scheduler.runRule(id);
  assert.deepEqual(textos(s.wa).map((x) => x.split('\n')[0]), [`*${B}*`]);
  assert.deepEqual(infos(s.db, id).filter((l) => l.message.startsWith('Pulada')), []);
});

// ------------------------------------------------------------------- achado Q1: "Enviar" do Catálogo no meio da execução
// A regra só grava a reserva em sent_offers depois de mandar aos grupos; até lá, o que ela escolheu está "saindo agora"
const IMG_ML = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';
const itemML = (n, title, price) => ({ key: `MLB${n}`, title, price, oldPrice: null, discountPct: null, sold: 10, freeShipping: true, coupon: null, image: IMG_ML, categoria: 'Casa', tag_id: null, source_index: 0 });
const naRevisao = (s, id, c) => {
  assert.equal(s.catalogoItens.registrar({ id, name: 'Lista', dedupe_days: 7 }, c, 'revisao', ['falha_link']), true);
  return s.db.prepare('SELECT id FROM catalogo_itens WHERE rule_id = ? AND chave = ?').get(id, c.key).id;
};
const tentar = (s, item) => s.catalogoItens.enviar(item, {}).then(() => 'enviou', (e) => `${e.status} ${e.message}`);
const saindoAgora = (titulo) => `409 Não enviada: parecida com "${titulo}", que está saindo agora por este disparo. Tente de novo em alguns minutos.`;
const D_PARECIDO = 'Liquidificador Philco 900W Velocidades Preto';

// Escolha preguiçosa (plano rodar-sozinho-entrega1, B5): a próxima só é escolhida quando a anterior saiu ou caiu fora,
// então não há mais "a que espera a vez" (a que ainda não foi escolhida não barra; se o "Enviar" passar antes, a regra
// pula a dela, testes R1 abaixo)
test('Q1: no meio da execução, a escolhida que está saindo barra o "Enviar" (mesmo mais barata); a que caiu fora não; depois vale sent_offers', async (t) => {
  const s = montarCatalogo(t);
  const pedir = s.links.requestLink;
  s.links.requestLink = async (p) => { if (String(p.url).includes('MLB-1000002')) throw new Error('falha de teste'); return pedir(p); };
  const id = regraLista(s.db, [linha(3, A, 50), linha(2, D, 120), linha(1, C, 199.9)], { per: 3 });
  const b = naRevisao(s, id, itemML(2000001, A, 40)); // o mesmo título, com outra chave
  const liq = naRevisao(s, id, itemML(2000002, D_PARECIDO, 99));
  const reais = s.wa.sendText;
  const durante = [];
  s.wa.sendText = async (...a) => {
    if (!durante.length) durante.push(await tentar(s, b)); // 1º envio (A): A está saindo
    else durante.push(await tentar(s, liq)); // 2º (C): a D caiu fora (link falhou) e foi devolvida: não está saindo
    return reais(...a);
  };
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages], [2, 2]);
  assert.deepEqual(durante, [saindoAgora(A), 'enviou']);
  s.wa.sendText = reais;
  assert.equal(await tentar(s, b), 'enviou', 'terminada a execução, a A está em sent_offers por R$ 50,00 e o item (R$ 40,00) está pelo menos 5% abaixo');
  const payload = JSON.parse(s.db.prepare("SELECT payload FROM envios WHERE payload LIKE '%MLB2000001%'").get().payload);
  assert.deepEqual(payload.mais_barata, { preco_anterior: 5000 });
});

test('Q1: a execução parada pelo teto no meio não deixa nada "saindo agora" (a que não saiu deixa de barrar)', async (t) => {
  const s = montarCatalogo(t);
  s.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('wa_limite_hora', '1');
  const id = regraLista(s.db, [linha(1, C, 199.9), linha(3, A, 50)], { per: 2 });
  const b = naRevisao(s, id, itemML(2000001, B, 50));
  // a A é escolhida depois que a C sai e para no teto antes da conferência (escolha preguiçosa, rodar-sozinho B5)
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.parou], [1, 'limite']);
  assert.deepEqual(s.db.prepare("SELECT message FROM log WHERE rule_id = ? AND message LIKE 'Saíram%'").all(id).map((l) => l.message),
    ['Saíram 1 de 2 ofertas; o limite de 1 mensagens por hora encheu.'], 'a A foi escolhida e parou no teto');
  assert.equal(await tentar(s, b), 'enviou', 'a A não saiu nem está saindo: a B passa');
});

// ------------------------------------------------------------- achado R1: "Enviar" do Catálogo durante a ESCOLHA
// A escolha lê os enviados e depois espera o resolveOffer de cada candidata da lista: o "Enviar" pode cair nesse meio
/**
 * Módulo do ML real com o resolveOffer embrulhado: `antes(cand)` roda (e é esperado) antes de cada leitura, no meio
 * da escolha da regra.
 */
const mlComEspera = (antes) => ({ ...mlReal, resolveOffer: async (c, deps) => { await antes(c); return mlReal.resolveOffer(c, deps); } });

// Com a escolha preguiçosa (rodar-sozinho B5), a escolhida sai antes de a próxima candidata ser lida: o "Enviar" que cai
// entre a escolha e o envio dela (conferência, link) é o que a "saindo agora" barra
test('R1: o "Enviar" entre a escolha e o envio (conferência, link) recebe 409 "saindo agora" para a parecida (ou o mesmo título mais barato) da escolhida; a regra manda a dela', async (t) => {
  const durante = [];
  const s = montarCatalogo(t);
  const id = regraLista(s.db, [linha(1, A, 50), linha(2, C, 199.9)], { per: 2 });
  const itens = [naRevisao(s, id, itemML(2000001, B, 50)), naRevisao(s, id, itemML(2000002, A, 40))];
  const pedir = s.links.requestLink;
  // a A já foi escolhida quando a regra pede o link dela
  s.links.requestLink = async (p) => { if (String(p.url).includes('MLB-1000001')) for (const i of itens) durante.push(await tentar(s, i)); return pedir(p); };
  const r = await s.scheduler.runRule(id);
  assert.deepEqual(durante, [saindoAgora(A), saindoAgora(A)]);
  assert.deepEqual([r.offers, r.messages], [2, 2]);
  assert.deepEqual(enviadas(s.db, id).map((e) => e.offer_key), ['MLB1000001', 'MLB1000002'], 'só as da regra');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 0, 'nenhum envio do Catálogo');
});

test('R1: o "Enviar" que passou no meio da escolha, antes da parecida ser escolhida, faz a regra pular a dela (igual, parecida ou a mesma chave), com 1 linha por conflito', async (t) => {
  for (const [nome, item, linhaEsperada] of [
    ['parecida', (n) => itemML(n, B, 50), `Pulada: parecida com "${B}", que saiu por este disparo às 14:00 por R$ 50,00. Ofertas parecidas esperam 24 h.`],
    ['o mesmo título, mais barato', (n) => itemML(n, A, 40), `Pulada: o mesmo produto saiu por este disparo às 14:00 por R$ 40,00, com outro código ("${A}"). Só sai de novo se estiver pelo menos 5% mais barato.`],
    // a da regra está 16% abaixo: entre rodadas sairia com a frase, mas nunca no mesmo horário que a do Catálogo (D12)
    ['o mesmo título, mais caro no Catálogo', (n) => itemML(n, A, 60), `Pulada: o mesmo produto saiu por este disparo às 14:00 por R$ 60,00, com outro código ("${A}"). Só sai de novo se estiver pelo menos 5% mais barato.`],
    ['a mesma chave', () => itemML(1000002, A, 50), null],
  ]) {
    await t.test(nome, async (tt) => {
      let s = null; let alvo = null; const durante = [];
      // o clique cai enquanto a regra lê a 2ª candidata (A): a C já foi escolhida, a A ainda não
      s = montarCatalogo(tt, { ml: mlComEspera(async (c) => { if (String(c.url).includes('MLB-1000002')) durante.push(await tentar(s, alvo)); }) });
      const id = regraLista(s.db, [linha(1, C, 199.9), linha(2, A, 50)], { per: 2 });
      alvo = naRevisao(s, id, item(2000001));
      const r = await s.scheduler.runRule(id);
      assert.deepEqual(durante, ['enviou'], 'nada parecido estava escolhido ainda');
      assert.deepEqual([r.offers, r.messages], [1, 1], 'só a C saiu pela regra');
      assert.ok(textos(s.wa).every((x) => !x.includes(`*${A}*`)), 'a A não saiu junto com a do Catálogo');
      const reservas = enviadas(s.db, id).map((e) => e.offer_key);
      assert.deepEqual(reservas.sort(), [item(2000001).key, 'MLB1000001'].sort(), 'a reserva do Catálogo e a da C');
      const linhas = infos(s.db, id).filter((l) => l.message.startsWith('Pulada'));
      assert.deepEqual(linhas.map((l) => [l.offer_title, l.message]), linhaEsperada ? [[A, linhaEsperada]] : [], 'a mesma chave pula sem linha, como a chave exata');
      semDadoPessoal(linhas);
      semAlerta(s.db, id);
      // o conflito é dito uma vez: a execução seguinte (mesma hora) barra a A pela trava normal e não repete a linha
      if (linhaEsperada) {
        await s.scheduler.runRule(id);
        assert.equal(infos(s.db, id).filter((l) => l.message.startsWith('Pulada')).length, 1);
      }
    });
  }
});

test('R1: a prévia ("Ver ofertas") não deixa nada "saindo agora": o "Enviar" no meio dela passa', async (t) => {
  let s = null; let alvo = null; const durante = [];
  s = montarCatalogo(t, { ml: mlComEspera(async (c) => { if (alvo && String(c.url).includes('MLB-1000002')) durante.push(await tentar(s, alvo)); }) });
  const id = regraLista(s.db, [linha(1, A, 50), linha(2, C, 199.9)], { per: 2 });
  alvo = naRevisao(s, id, itemML(2000001, B, 50));
  const previa = await s.scheduler.previewOffers(id);
  assert.equal(previa.length, 2);
  assert.deepEqual(durante, ['enviou']);
});

test('R1: a escolhida que vai à revisão do Catálogo (Shopee) não fica "saindo agora": o "Enviar" de uma parecida passa e ela é pulada, sem ir à revisão', async (t) => {
  const s = montarCatalogo(t, { ofertas: [oferta(1, C, 20, 'amazon'), oferta(2, A, 10, 'shopee')] });
  const id = regraCatalogo(s.db, { per: 2 });
  const item = naRevisao(s, id, itemML(2000001, B, 50));
  const reais = s.wa.sendText;
  let durante = null;
  s.wa.sendText = async (...a) => { durante = await tentar(s, item); return reais(...a); }; // a C sai; a A (Shopee) já foi escolhida
  const r = await s.scheduler.runRule(id);
  assert.equal(durante, 'enviou', 'a Shopee não sai por esta execução: quem a decide é o "Enviar" dela');
  // a do Catálogo foi reservada antes da vez da Shopee: como a barrada na escolha, ela não vai à revisão
  assert.deepEqual([r.offers, r.revisao], [1, 0]);
  assert.deepEqual(infos(s.db, id).filter((l) => l.message.startsWith('Pulada')).map((l) => [l.offer_title, l.message]), [
    [A, `Pulada: parecida com "${B}", que saiu por este disparo às 14:00 por R$ 50,00. Ofertas parecidas esperam 24 h.`],
  ]);
});

test('mesma chave (seguranca): o "Enviar de novo" de um envio que falhou, no meio da execução que escolheu a mesma oferta, recebe 409 "saindo agora"; ela sai uma vez', async (t) => {
  const s = montarCatalogo(t, { ofertas: [oferta(1, A, 50, 'ml')] });
  const id = regraCatalogo(s.db, { per: 1 }); // Relevância: o item 'enviado' cujo envio falhou volta a valer para a regra
  const pedir = s.links.requestLink;
  s.links.requestLink = async () => { throw new Error('falha de teste'); };
  assert.equal((await s.scheduler.runRule(id)).revisao, 1, 'o link falhou: foi à revisão');
  s.links.requestLink = pedir;
  const item = s.db.prepare('SELECT id, chave FROM catalogo_itens WHERE rule_id = ?').get(id);
  const { envio_id: envioId } = await s.catalogoItens.enviar(item.id, {});
  s.db.prepare("UPDATE envios SET status = 'erro' WHERE id = ?").run(envioId); // terminou sem nenhum grupo ok (R3)
  t.mock.timers.setTime(Date.now() + HORA);
  const reais = s.wa.sendText;
  let durante = null;
  s.wa.sendText = async (...a) => { durante = await tentar(s, item.id); return reais(...a); };
  const r = await s.scheduler.runRule(id);
  assert.equal(r.offers, 1, 'a regra mandou a oferta de novo (a reserva do envio que falhou saiu)');
  assert.equal(durante, saindoAgora(A));
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM envios').get().n, 1, 'nenhum envio novo do Catálogo');
  assert.deepEqual(enviadas(s.db, id).map((e) => e.offer_key), [item.chave], 'uma reserva só, a da regra');
});

// ------------------------------------------------------------------- achado Q5: pulada na conferência
test('Q5: a pulada na conferência fica 6 h fora da escolha, é dita uma vez por conflito e sai com a frase quando a loja volta a mais barata', async (t) => {
  const loja = { 9000001: { price: 72.5, disponivel: true } };
  const s = montar(t, { verificar: true, loja });
  const id = regraCentral(s.db, { per: 1 });
  semear(s.db, id, { key: 'MLB9999', titulo: POTES, preco: PRECO_POTES_ANTES, em: AGORA - HORA });
  const conferencias = () => s.eventos.filter((e) => e === 'conferir 9000001').length;
  const linhas = () => infos(s.db, id).filter((l) => l.message.startsWith('Pulada: na conferência'));
  for (let i = 0; i < 6; i++) { await s.scheduler.runRule(id); t.mock.timers.setTime(Date.now() + HORA); }
  assert.equal(conferencias(), 1, 'nas 5 execuções seguintes ela nem é escolhida');
  await s.scheduler.runRule(id); // 6 h depois: escolhida e conferida de novo, ainda mais cara
  assert.deepEqual([conferencias(), linhas().length], [2, 1], 'o mesmo conflito não ganha outra linha');
  assert.equal(s.wa.simulated.some((m) => m.text.includes(POTES)), false);
  for (let i = 0; i < 5; i++) { t.mock.timers.setTime(Date.now() + HORA); await s.scheduler.runRule(id); }
  assert.equal(conferencias(), 2, 'pausada de novo por 6 h');
  loja[9000001] = { price: 69, disponivel: true };
  t.mock.timers.setTime(Date.now() + HORA);
  await s.scheduler.runRule(id);
  const saiu = s.wa.simulated.filter((m) => m.text.includes(`*${POTES}*`));
  assert.equal(saiu.length, 1);
  assert.ok(saiu[0].text.startsWith(FRASE_MAIS_BARATA), 'mais barata de novo: sai com a frase');
  assert.equal(linhas().length, 1);
});

test('Q5: no catálogo (Relevância), a pulada na conferência fica fora da escolha e da conta da leitura; a vaga vai para a próxima', async (t) => {
  const s = montarCatalogo(t, { verificar: true, loja: { 4000000001: { price: 49, disponivel: true }, 4000000002: { price: 20, disponivel: true } }, ofertas: [oferta(1, A, 47, 'ml'), oferta(2, C, 20, 'ml')] });
  const id = regraCatalogo(s.db, { per: 1 });
  semear(s.db, id, { key: 'MLB4000000009', titulo: A, preco: 5000, em: AGORA - 3 * HORA });
  const r1 = await s.scheduler.runRule(id);
  // vaga reposta na mesma execução (plano rodar-sozinho-entrega1, CA1.7)
  assert.deepEqual([r1.offers, r1.puladas, s.wa.simulated.length], [1, 1, 1], 'a 1 foi pulada e a vaga foi para a próxima');
  assert.ok(s.wa.simulated[0].text.includes(`*${C}*`), 'a próxima candidata sai');
  t.mock.timers.setTime(Date.now() + HORA);
  const r2 = await s.scheduler.runRule(id);
  assert.equal(r2.offers, 0, 'a 1 segue fora da escolha e a 2 já saiu');
  assert.deepEqual(s.eventos.filter((e) => e.startsWith('conferir')), ['conferir 4000000001', 'conferir 4000000002'], 'a 1 não foi conferida de novo');
  assert.equal(infos(s.db, id).filter((l) => l.message.startsWith('Pulada: na conferência')).length, 1);
});

// ------------------------------------------------------------------ "Baixou de … para …" (plano baixou-de-para, etapa 5)

const DIAS = 24 * HORA;
const CORPO_BAIXOU = `*{TITULO_PRODUTO}*\n🔥 Por *{PRECO_PRODUTO}*\n${LINHA_ULTIMO_ENVIO}\n{LINK}`;
const LINHA_BAIXOU = (de, para) => `📉 Baixou de ~R$ ${de}~ para *R$ ${para}*`;
/** Regra da lista com o template que tem a linha. A mesma chave já passou do `dedupe_days` (7) nos casos de "8 dias". */
const regraBaixou = (db, itens, opcoes = {}) => regraLista(db, itens, { per: 1, tpl: template(db, CORPO_BAIXOU), ...opcoes });

test('baixou: a mesma chave 8 dias antes por R$ 299,00 e agora a R$ 252,00 sai com a linha "Baixou de"; o mesmo produto, sem a frase da mais barata', async (t) => {
  const s = montar(t);
  const id = regraBaixou(s.db, [linha(1, A, 252)]);
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 29900, em: AGORA - 8 * DIAS });

  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.offers, r.messages, r.errors], [1, 1, 0]);
  const [texto] = textos(s.wa);
  assert.match(texto, /^\*Fone de Ouvido Bluetooth JBL Tune 510BT Preto\*\n🔥 Por \*R\$ 252,00\*\n📉 Baixou de ~R\$ 299,00~ para \*R\$ 252,00\*\nhttps:\/\/meli\.la\/\S+$/);
  assert.equal(texto.includes(FRASE_MAIS_BARATA), false, 'mesma chave: a frase 🔎 é só da exceção do mais barato');
  assert.equal(enviadas(s.db, id).at(-1).price_cents, 25200, 'o envio grava o preço novo: o próximo "último envio"');
  semAlerta(s.db, id);
});

test('baixou: limite de 5% (R$ 300,00 → R$ 285,00 mostra; R$ 285,01 não); preço igual ou maior não mostra', async (t) => {
  for (const [antes, agora, mostra] of [[30000, 285, true], [30000, 285.01, false], [30000, 300, false], [30000, 320, false], [30000, 280, true]]) {
    await t.test(`${antes / 100} → ${agora}`, async (t2) => {
      const s = montar(t2);
      const id = regraBaixou(s.db, [linha(1, A, agora)]);
      semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: antes, em: AGORA - 8 * DIAS });
      assert.equal((await s.scheduler.runRule(id)).messages, 1);
      const [texto] = textos(s.wa);
      if (mostra) assert.ok(texto.includes(LINHA_BAIXOU('300,00', agora.toFixed(2).replace('.', ','))), texto);
      else {
        assert.doesNotMatch(texto, /Baixou|📉|\[|\]|~/, 'sem queda o trecho some inteiro');
        assert.match(texto, /^\*Fone[^\n]*\*\n🔥 Por \*R\$ [\d,]+\*\nhttps:\/\/meli\.la\/\S+$/, 'sem linha em branco no lugar');
      }
    });
  }
});

test('baixou: o mesmo título com outra chave conta; título parecido não; outra regra não; mais de 30 dias não; sem preço guardado não', async (t) => {
  const casos = [
    // [nome, semente (relativa à regra), mostra]
    ['título igual, outra chave (8 dias)', { key: 'MLB999', titulo: A, preco: 29900, em: AGORA - 8 * DIAS }, true],
    ['29 dias atrás ainda vale', { key: 'MLB1000001', titulo: A, preco: 29900, em: AGORA - 29 * DIAS }, true],
    ['31 dias atrás não vale', { key: 'MLB1000001', titulo: A, preco: 29900, em: AGORA - 31 * DIAS }, false],
    ['parecido (outro modelo da mesma família) não conta', { key: 'MLB998', titulo: B, preco: 29900, em: AGORA - 8 * DIAS }, false],
    ['último envio sem preço guardado não mostra', { key: 'MLB1000001', titulo: A, preco: null, em: AGORA - 8 * DIAS }, false],
    ['outra regra não conta', { key: 'MLB1000001', titulo: A, preco: 29900, em: AGORA - 8 * DIAS, outraRegra: true }, false],
  ];
  for (const [nome, semente, mostra] of casos) {
    await t.test(nome, async (t2) => {
      const s = montar(t2);
      const id = regraBaixou(s.db, [linha(1, A, 252)]);
      const outra = regraBaixou(s.db, [linha(7, D, 99)]);
      semear(s.db, semente.outraRegra ? outra : id, semente);
      assert.equal((await s.scheduler.runRule(id)).messages, 1);
      const [texto] = textos(s.wa);
      if (mostra) assert.ok(texto.includes(LINHA_BAIXOU('299,00', '252,00')), texto);
      else assert.doesNotMatch(texto, /Baixou|📉/, texto);
    });
  }
});

test('baixou: o envio mais recente do produto é a referência (não o mais barato nem o mais antigo)', async (t) => {
  const s = montar(t);
  const id = regraBaixou(s.db, [linha(1, A, 252)]);
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 40000, em: AGORA - 20 * DIAS });
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 29900, em: AGORA - 9 * DIAS });
  await s.scheduler.runRule(id);
  assert.ok(textos(s.wa)[0].includes(LINHA_BAIXOU('299,00', '252,00')));
});

test('baixou: a oferta liberada como "mais barata" sai com a frase 🔎 e com a linha 📉', async (t) => {
  const s = montar(t);
  const id = regraBaixou(s.db, [linha(2, A, 44.9)]);
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 4990, em: AGORA - 3 * HORA });
  assert.equal((await s.scheduler.runRule(id)).messages, 1);
  const [texto] = textos(s.wa);
  assert.ok(texto.startsWith(`${FRASE_MAIS_BARATA}\n\n*${A}*`), texto);
  assert.ok(texto.includes(LINHA_BAIXOU('49,90', '44,90')), texto);
});

test('baixou: o preço da MENSAGEM é o conferido na loja: sobe para fora dos 5% → sem linha; continua dentro → linha com o preço novo', async (t) => {
  const loja = { 9000001: { price: 71, disponivel: true } };
  const s = montar(t, { verificar: true, loja });
  const id = regraCentral(s.db, { per: 1, tpl: template(s.db, CORPO_BAIXOU) });
  // 69,90 na escolha e 74,00 antes: a 5,5%; conferida a 71,00 são só 4,05%
  semear(s.db, id, { key: 'MLB9000001', titulo: POTES, preco: 7400, em: AGORA - 8 * DIAS });
  assert.equal((await s.scheduler.runRule(id)).messages, 1);
  assert.doesNotMatch(textos(s.wa)[0], /Baixou|📉/, 'a conferência subiu o preço: sem a linha, e o envio sai');
  assert.ok(textos(s.wa)[0].includes('R$ 71,00'), 'mensagem com o preço conferido');

  t.mock.timers.setTime(AGORA + 8 * DIAS); // a mesma chave volta: o envio acima (R$ 71,00) é agora a referência
  loja[9000001] = { price: 67, disponivel: true };
  assert.equal((await s.scheduler.runRule(id)).messages, 1);
  assert.ok(textos(s.wa)[1].includes(LINHA_BAIXOU('71,00', '67,00')), textos(s.wa)[1]);
});

test('baixou: template sem o campo sai igual ao de antes (sem a linha) mesmo com queda', async (t) => {
  const s = montar(t);
  const id = regraLista(s.db, [linha(1, A, 252)], { per: 1 }); // CORPO padrão do arquivo
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 29900, em: AGORA - 8 * DIAS });
  await s.scheduler.runRule(id);
  assert.match(textos(s.wa)[0], /^\*Fone de Ouvido Bluetooth JBL Tune 510BT Preto\*\nR\$ 252,00\nhttps:\/\/meli\.la\/\S+$/);
});

test('baixou: "Ver ofertas" mostra a linha, sem devolver o campo interno, sem gravar nem logar', async (t) => {
  const s = montar(t);
  const id = regraBaixou(s.db, [linha(1, A, 252), linha(4, C, 199.9)], { per: 2 });
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 29900, em: AGORA - 8 * DIAS });
  const antes = JSON.stringify([s.db.prepare('SELECT * FROM log').all(), s.db.prepare('SELECT * FROM sent_offers').all()]);

  const previa = await s.scheduler.previewOffers(id);
  assert.deepEqual(previa.map((o) => o.key), ['MLB1000001', 'MLB1000004']);
  assert.ok(previa[0].text.includes(LINHA_BAIXOU('299,00', '252,00')), previa[0].text);
  assert.doesNotMatch(previa[1].text, /Baixou|📉/, 'o produto sem envio anterior fica sem a linha');
  for (const o of previa) assert.equal(Object.hasOwn(o, 'precoUltimoEnvio'), false, 'a prévia não devolve o campo interno');
  assert.equal(JSON.stringify([s.db.prepare('SELECT * FROM log').all(), s.db.prepare('SELECT * FROM sent_offers').all()]), antes, 'a prévia não grava');
  assert.equal(s.wa.simulated.length, 0);
});

test('baixou: "Enviar agora" (execução manual) também mostra a linha', async (t) => {
  const s = montar(t);
  const id = regraBaixou(s.db, [linha(1, A, 252)]);
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 29900, em: AGORA - 8 * DIAS });
  const r = await s.scheduler.runRule(id, { manual: true });
  assert.equal(r.messages, 1);
  assert.ok(textos(s.wa)[0].includes(LINHA_BAIXOU('299,00', '252,00')));
});

test('baixou: erro ao ler o histórico não derruba o envio: sai sem a linha, e o console só recebe o código', async (t) => {
  const s = montar(t);
  const id = regraBaixou(s.db, [linha(1, A, 252)]);
  semear(s.db, id, { key: 'MLB1000001', titulo: A, preco: 29900, em: AGORA - 8 * DIAS });
  // a trava lê `sent_offers` antes (com a mesma tabela): o gatilho só falha na busca do último envio (ela lê price_cents por último)
  const original = s.db.prepare.bind(s.db);
  const saida = [];
  t.mock.method(console, 'error', (...a) => saida.push(a.join(' ')));
  s.db.prepare = (sql) => {
    if (/SELECT offer_key, title, price_cents FROM sent_offers/.test(sql)) { const e = new Error('falhou com 5535999990000'); e.code = 'ERR_SQLITE_ERROR'; throw e; }
    return original(sql);
  };
  const r = await s.scheduler.runRule(id);
  assert.deepEqual([r.messages, r.errors], [1, 0]);
  assert.doesNotMatch(textos(s.wa)[0], /Baixou|📉/);
  assert.ok(saida.some((l) => l.includes('ERR_SQLITE_ERROR')), saida.join('|'));
  assert.ok(saida.every((l) => !l.includes('5535999990000')), 'a mensagem do erro não vai ao console');
});

// Junção da entrega 1 do "Rodar sozinho" com o "Baixou de … para …": a Amazon do catálogo é relida pelo Etiqueta na hora
// do envio, e a linha e a regra dos 5% usam o preço relido (o da mensagem), não o da lista
test('baixou + releitura da Amazon (rodar-sozinho E1): a linha usa o preço relido pelo Etiqueta, nos dois sentidos', async (t) => {
  // lista a R$ 280,00 (6,4% abaixo de R$ 299,00, mostraria); relida a R$ 252,00 → linha com R$ 252,00
  // lista a R$ 280,00; relida a R$ 290,00 (+3,6%, dentro do limite do verificador, mas só 3% abaixo de R$ 299,00) → sem linha
  for (const [relido, linhaEsperada] of [[252, LINHA_BAIXOU('299,00', '252,00')], [290, null]]) {
    await t.test(`relida a R$ ${relido}`, async (t2) => {
      const s = montarCatalogo(t2, { verificar: true, releitura: { [asin(1)]: relido }, ofertas: [oferta(1, A, 280)] });
      const id = regraCatalogo(s.db, { per: 1, tpl: template(s.db, CORPO_BAIXOU) });
      semear(s.db, id, { key: `ASIN:${asin(1)}`, titulo: A, preco: 29900, em: AGORA - 8 * DIAS });

      const r = await s.scheduler.runRule(id);
      assert.deepEqual([r.offers, r.messages, r.errors], [1, 1, 0]);
      const [texto] = textos(s.wa);
      const reais = `R$ ${relido},00`;
      assert.ok(texto.includes(`🔥 Por *${reais}*`), `a mensagem sai com o preço relido: ${texto}`);
      if (linhaEsperada) assert.ok(texto.includes(linhaEsperada), texto);
      else assert.doesNotMatch(texto, /Baixou|📉|R\$ 280/, texto);
      assert.equal(enviadas(s.db, id).at(-1).price_cents, relido * 100, 'o envio grava o preço relido: o próximo "último envio"');
    });
  }
});
