// Fonte "catalogo": registro do que foi tratado e fila de revisão (plano fonte-catalogo-etiqueta, etapa 2; CA1, CA4,
// CA7; decisões P4, P5 e P6 do dono). createCatalogoItens direto, com a fila de envios real (createEnvios), o
// WhatsApp em dryRun (o que "sai" fica em wa.simulated), links em modo trocável e a Amazon de verdade sem
// credencial (montarLink não usa rede). O fetch global fica bloqueado e o último teste prova que ninguém o chamou.
// Produto igual ou parecido no "Enviar" (plano nao-repetir-produto-parecido, etapa 5): bloco "produto parecido".
// As rotas são montadas num Express mínimo (a ligação ao server.js é a etapa 5), com o soDono real de src/auth.js.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { openDb, getSetting, MARCA_MIGRACAO_E1, textoMigracaoE1, MARCA_MIGRACAO_E2, textoMigracaoE2 } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createEnvios } from '../src/envios.js';
import { createAmazon } from '../src/amazon.js';
import { soDono } from '../src/auth.js';
import { createCatalogoItens, montarRotas, ErroCatalogoItem, TETO_REVISAO, MOTIVOS, lerChave, precoSuspeito } from '../src/catalogo-itens.js';
import { validarAjustesOferta, lerPrecoDigitado, lerTextoCurto, ErroEspelho } from '../src/espelho.js';
import * as rastreio from '../src/rastreio.js';
import { FRASE_MAIS_BARATA, textoConflito, textoPassou } from '../src/parecido.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-cat-')); pastas.push(p); return p; };

const DIA = 86400000;
const TAG = 'pedro-20';
const ASIN = 'B0FG2MD49G';
const IMG_ML = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';
const IMG_AMAZON = 'https://m.media-amazon.com/images/I/71abcDEF.jpg';
const IMG_SHOPEE = 'https://down-br.img.susercontent.com/file/br-11134207-abc.jpg';
const LINK_SHOPEE_OK = 'https://s.shopee.com.br/7AbCdEfG';
const JA_TRATADA = 'Esta oferta já foi tratada.';
const PRECO_SUSPEITO = 'Corrija o preço ou apague o preço antigo para enviar.';

/** Candidatos como src/catalogo.js (paraCandidato) entrega. */
const ML = (n = 1234567890, extra = {}) => ({ key: `MLB${n}`, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: true, coupon: null, image: IMG_ML, categoria: 'Eletrônicos', tag_id: null, source_index: 0, ...extra });
const AMZ = (asin = ASIN, extra = {}) => ({ key: `ASIN:${asin}`, title: 'Roteador Mesh', price: 1310.05, oldPrice: 1999, discountPct: 34, sold: null, freeShipping: false, coupon: 'MESH10', image: IMG_AMAZON, categoria: 'Informática', tag_id: null, source_index: 0, ...extra });
const SHP = (item = '22334455', extra = {}) => ({ key: `SHOPEE:111.${item}`, title: 'Perfume Floral', price: 59.9, oldPrice: null, discountPct: 30, sold: 50, freeShipping: true, coupon: null, image: IMG_SHOPEE, link: LINK_SHOPEE_OK, categoria: 'Perfumes', tag_id: null, source_index: 0, ...extra });

/**
 * Banco com 2 grupos e 2 etiquetas, WhatsApp simulado, links no modo `estado.modo`, Amazon com a tag `conexao.tag`.
 * `shopee`: cliente da Shopee da fila de envios (os links com Sub_id do rastreio).
 */
function montar({ modo = 'fake', tag = TAG, comAmazon = true, shopee = null } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  for (const [jid, nome] of [['111@g.us', 'Achadinhos'], ['222@g.us', 'Tech']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  for (const nome of ['etiquetaA', 'etiquetaB']) db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run(nome);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const estado = { modo };
  const links = createLinkService({ getMode: () => estado.modo });
  const conexao = { tag };
  const amazon = comAmazon ? createAmazon({ db, fetch: globalThis.fetch, esperar: async () => {}, lerConexao: () => conexao }) : null;
  const envios = createEnvios({ db, wa, links, ml: null, fast: true, dir, amazon, shopee });
  const relogio = { t: Date.now() };
  const acordou = { n: 0 };
  const itens = createCatalogoItens({ db, wa, links, amazon, envios, acordar: () => { acordou.n++; }, agora: () => relogio.t });
  const tplAmazon = db.prepare("SELECT id FROM templates WHERE name = 'Amazon'").get().id;
  const s = {
    dir, db, wa, links, estado, conexao, amazon, envios, relogio, acordou, itens, tplAmazon,
    /** Regra no banco (como o server.js grava) → objeto com o id (o que o agendador passa). */
    regra(extra = {}) {
      const r = { name: 'Perfumes do catálogo', tag_id: 1, template_id: 1, group_jids: ['111@g.us', '222@g.us'], dedupe_days: 7, send_image: 1, ...extra };
      const id = Number(db.prepare(`INSERT INTO rules (name, tag_id, template_id, group_jids, dedupe_days, send_image, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(r.name, r.tag_id, r.template_id, JSON.stringify(r.group_jids), r.dedupe_days, r.send_image, Date.now()).lastInsertRowid);
      return { id, name: r.name, dedupe_days: r.dedupe_days };
    },
    /** Item na revisão → id */
    revisao(regra, c, motivos) {
      assert.equal(itens.registrar(regra, c, 'revisao', motivos), true);
      return db.prepare('SELECT id FROM catalogo_itens WHERE rule_id = ? AND chave = ?').get(regra.id, c.key).id;
    },
    item: (id) => { const l = db.prepare('SELECT * FROM catalogo_itens WHERE id = ?').get(id); return l ? { ...l, oferta: JSON.parse(l.oferta), motivos: JSON.parse(l.motivos) } : null; },
    envio: (id) => { const e = db.prepare('SELECT * FROM envios WHERE id = ?').get(id); return e ? { ...e, payload: JSON.parse(e.payload), group_jids: JSON.parse(e.group_jids) } : null; },
    contar: (sql, ...a) => db.prepare(sql).get(...a).n,
    enviados: () => wa.simulated.filter((m) => m.jid !== 'status@broadcast'),
    logs: () => db.prepare('SELECT rule_id, rule_name, level, group_name, offer_title, message FROM log ORDER BY id').all().map((l) => ({ ...l })),
  };
  return s;
}

/** O erro esperado de enviar/descartar: status e mensagem fixa. */
async function recusa(p, status, mensagem) {
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof ErroCatalogoItem, `esperava ErroCatalogoItem, veio ${e?.name}: ${e?.message}`);
    assert.deepEqual([e.status, e.message], [status, mensagem]);
    return true;
  });
}

// ------------------------------------------------------------------------------------------------ chave e preço

test('lerChave: ML, Amazon e Shopee viram loja e URL remontada; o resto é recusado', () => {
  assert.deepEqual(lerChave('MLB123'), { loja: 'ml', url: 'https://produto.mercadolivre.com.br/MLB-123' });
  assert.deepEqual(lerChave(`ASIN:${ASIN}`), { loja: 'amazon', url: `https://www.amazon.com.br/dp/${ASIN}`, asin: ASIN });
  assert.deepEqual(lerChave('SHOPEE:111.222'), { loja: 'shopee', url: 'https://shopee.com.br/product/111/222', shopId: '111', itemId: '222' });
  for (const k of ['MLB', 'MLB12a', 'mlb123', 'MLA123', 'ASIN:b0fg2md49g', 'ASIN:B0FG2MD49', 'SHOPEE:111', 'SHOPEE:1.2.3', 'https://produto.mercadolivre.com.br/MLB-1', '', null, 42, ` MLB1`]) {
    assert.equal(lerChave(k), null, String(k));
  }
});

test('CA7 precoSuspeito: desconto ≥ 100% ou preço antigo ≥ 10× o preço', () => {
  assert.equal(precoSuspeito({ price: 10, oldPrice: 100, discountPct: 90 }), true, '10× exato');
  assert.equal(precoSuspeito({ price: 10, oldPrice: 99.99, discountPct: 90 }), false);
  assert.equal(precoSuspeito({ price: 10, oldPrice: null, discountPct: 100 }), true);
  assert.equal(precoSuspeito({ price: 10, oldPrice: null, discountPct: 99 }), false);
  assert.equal(precoSuspeito({ price: 10, oldPrice: null, discountPct: null }), false);
  // `falha_link` e `nao_conferido` ficam só para ler itens antigos (migrações de src/db.js); `queda_preco` e
  // `falhas_repetidas` são da entrega 2 do rodar-sozinho
  assert.deepEqual([...MOTIVOS], ['shopee', 'desconto_100', 'preco_antigo', 'falha_link', 'nao_conferido', 'queda_preco', 'falhas_repetidas'], 'os nomes da spec e dos planos');
});

test('rodar-sozinho E2: os motivos queda_preco e falhas_repetidas são aceitos, vão à revisão e voltam na listagem', () => {
  const s = montar();
  const regra = s.regra();
  const a = s.revisao(regra, ML(7), ['queda_preco']);
  const b = s.revisao(regra, ML(8), ['falhas_repetidas', 'desconto_100']);
  assert.deepEqual([s.item(a).motivos, s.item(b).motivos], [['queda_preco'], ['falhas_repetidas', 'desconto_100']]);
  const l = s.itens.listar({ status: 'revisao' });
  assert.deepEqual(l.itens.map((i) => i.motivos).sort(), [['falhas_repetidas', 'desconto_100'], ['queda_preco']]);
  assert.equal(s.itens.registrar(regra, ML(9), 'revisao', ['motivo_inventado']), false, 'motivo fora da lista continua recusado');
});

test('rodar-sozinho E2 (CA2.11): a queda em % do item de queda_preco é guardada e volta como queda_pct (só de 1 a 99, só com o motivo)', () => {
  const s = montar();
  const regra = s.regra();
  const casos = [[1, ['queda_preco'], 60, 60], [2, ['queda_preco', 'preco_antigo'], 99, 99], [3, ['queda_preco'], 50, 50],
    [4, ['queda_preco'], 100, null], [5, ['queda_preco'], 0, null], [6, ['queda_preco'], 12.5, null], [7, ['queda_preco'], '60', null],
    [8, ['queda_preco'], undefined, null], [9, ['desconto_100'], 60, null]];
  for (const [n, motivos, quedaPct] of casos) assert.equal(s.itens.registrar(regra, ML(n), 'revisao', motivos, { quedaPct }), true);
  const porChave = Object.fromEntries(s.itens.listar().itens.map((i) => [i.oferta.link.match(/MLB-(\d+)/)[1], i]));
  for (const [n, , , esperado] of casos) {
    if (esperado == null) assert.equal(Object.hasOwn(porChave[n], 'queda_pct'), false, `item ${n}: sem queda_pct`);
    else assert.equal(porChave[n].queda_pct, esperado, `item ${n}`);
  }
  // fora da faixa nem é gravado
  for (const k of ['MLB4', 'MLB5', 'MLB6', 'MLB7', 'MLB9']) assert.equal(s.db.prepare("SELECT json_type(oferta, '$.queda_pct') AS t FROM catalogo_itens WHERE chave = ?").get(k).t, null, k);
  // valor gravado à mão fora da faixa também não sai; nem num item sem o motivo queda_preco
  s.db.prepare("UPDATE catalogo_itens SET oferta = json_set(oferta, '$.queda_pct', 150) WHERE chave = 'MLB1'").run();
  s.db.prepare("UPDATE catalogo_itens SET oferta = json_set(oferta, '$.queda_pct', 60) WHERE chave = 'MLB9'").run();
  const depois = s.itens.listar().itens;
  assert.equal(Object.hasOwn(depois.find((i) => i.oferta.link.endsWith('MLB-1')), 'queda_pct'), false);
  assert.equal(Object.hasOwn(depois.find((i) => i.oferta.link.endsWith('MLB-9')), 'queda_pct'), false);
});

test('rodar-sozinho E2 (CA2.2): o descarte pela recusa do Mercado Livre guarda recusada_ml em descartado_por e volta na listagem', () => {
  const s = montar();
  const regra = s.regra();
  assert.equal(s.itens.registrar(regra, ML(1), 'descartado', [], { descartadoPor: 'recusada_ml' }), true);
  assert.equal(s.itens.registrar(regra, ML(2), 'enviado', [], { descartadoPor: 'recusada_ml' }), true, 'só o descarte leva o motivo');
  const porChave = Object.fromEntries(s.itens.listar().itens.map((i) => [i.oferta.link.match(/MLB-(\d+)/)[1], i.descartado_por]));
  assert.deepEqual(porChave, { 1: 'recusada_ml', 2: undefined });
});

// ------------------------------------------------------------------------------------------------ tratada (D6)

test('CA1/D6 tratada: em "Novidades" (atualizacao) qualquer registro ou envio bloqueia para sempre, mesmo com dedupe 0', () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 0 });
  const nov = 'atualizacao';
  assert.equal(s.itens.tratada(regra, ML(1), nov), false);
  assert.equal(s.itens.registrar(regra, ML(1), 'enviado'), true);
  assert.equal(s.itens.tratada(regra, ML(1), nov), true, 'enviado sozinho');
  assert.equal(s.itens.tratada(regra, ML(1), 'relevancia'), false, 'nas outras ordens, dedupe 0 = repete');
  // só em sent_offers (enviada por outra fonte da mesma regra), há muito tempo
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (?,?,?)').run(regra.id, 'MLB2', s.relogio.t - 400 * DIA);
  assert.equal(s.itens.tratada(regra, ML(2), nov), true);
  // a mesma chave em outra regra não conta
  const outra = s.regra({ name: 'Outra' });
  assert.equal(s.itens.tratada(outra, ML(1), nov), false);
  // candidato sem chave válida: tratado (não há o que fazer com ele)
  assert.equal(s.itens.tratada(regra, { key: 'xyz' }, nov), true);
  assert.equal(s.itens.tratada({ id: 'x' }, ML(1), nov), true);
});

test('CA1/D6 tratada nas outras ordens: revisão e descarte bloqueiam; o envio vale pela janela de "dias sem repetir"', () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  const ord = 'desconto';
  s.revisao(regra, SHP('1'), ['shopee']);
  assert.equal(s.itens.tratada(regra, SHP('1'), ord), true, 'em revisão');
  assert.equal(s.itens.registrar(regra, ML(3), 'descartado'), true);
  assert.equal(s.itens.tratada(regra, ML(3), ord), true, 'descartada');

  // enviada: conta pelo sent_offers dentro da janela
  assert.equal(s.itens.registrar(regra, ML(4), 'enviado'), true);
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (?,?,?)').run(regra.id, 'MLB4', s.relogio.t - 6 * DIA);
  assert.equal(s.itens.tratada(regra, ML(4), ord), true, 'dentro de 7 dias');
  s.relogio.t += 2 * DIA;
  assert.equal(s.itens.tratada(regra, ML(4), ord), false, 'passou da janela: pode sair de novo');
  assert.equal(s.itens.tratada(regra, ML(4), 'atualizacao'), true, 'em Novidades, nunca');

  // a regra com dedupe 0 repete o que foi enviado, mas não o que espera revisão
  const zero = s.regra({ name: 'Zero', dedupe_days: 0 });
  s.itens.registrar(zero, ML(5), 'enviado');
  s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at) VALUES (?,?,?)').run(zero.id, 'MLB5', s.relogio.t);
  assert.equal(s.itens.tratada(zero, ML(5), ord), false);
  s.revisao(zero, ML(6, { discountPct: 100 }), ['desconto_100']);
  assert.equal(s.itens.tratada(zero, ML(6), ord), true);
});

// ------------------------------------------------------------------------------------------------ registrar

test('registrar: loja e URL saem da chave, foto só do CDN da loja, campos com tipo e tamanho; upsert', () => {
  const s = montar();
  const regra = s.regra();
  const c = ML(77, { url: 'https://evil.example/x', loja: 'shopee', asin: 'XXXXXXXXXX', image: 'https://evil.example/f.jpg', title: `  Fone\n  ${'x'.repeat(300)}`, discountPct: 250, sold: -3, link: LINK_SHOPEE_OK, coupon: 7, extra: 'lixo' });
  assert.equal(s.itens.registrar(regra, c, 'enviado'), true);
  const l = s.db.prepare('SELECT * FROM catalogo_itens').get();
  assert.deepEqual([l.rule_id, l.chave, l.loja, l.status, l.motivos, l.envio_id, l.criado_em, l.decidido_em], [regra.id, 'MLB77', 'ml', 'enviado', '[]', null, s.relogio.t, s.relogio.t]);
  const o = JSON.parse(l.oferta);
  assert.deepEqual(Object.keys(o).sort(), ['categoria', 'coupon', 'discountPct', 'freeShipping', 'image', 'oldPrice', 'price', 'sold', 'source_index', 'tag_id', 'title', 'url']);
  assert.equal(o.url, 'https://produto.mercadolivre.com.br/MLB-77', 'URL remontada da chave');
  assert.equal(o.image, null, 'foto fora do CDN do ML');
  assert.equal(o.title.length, 200);
  assert.equal(o.title.startsWith('Fone x'), true);
  assert.deepEqual([o.discountPct, o.sold, o.coupon], [100, null, null]);

  const a = AMZ(ASIN, { image: IMG_ML }); // foto do ML numa oferta da Amazon: fora
  s.itens.registrar(regra, a, 'enviado');
  const oa = JSON.parse(s.db.prepare("SELECT oferta FROM catalogo_itens WHERE chave = ?").get(a.key).oferta);
  assert.deepEqual([oa.url, oa.asin, oa.image, oa.link], [`https://www.amazon.com.br/dp/${ASIN}`, ASIN, null, undefined]);
  s.itens.registrar(regra, SHP('9'), 'enviado');
  const os2 = JSON.parse(s.db.prepare("SELECT oferta FROM catalogo_itens WHERE chave = 'SHOPEE:111.9'").get().oferta);
  assert.deepEqual([os2.image, os2.link], [IMG_SHOPEE, LINK_SHOPEE_OK]);

  // upsert: a mesma chave na mesma regra atualiza a linha (não cria outra)
  s.relogio.t += 1000;
  assert.equal(s.itens.registrar(regra, { ...c, title: 'Fone Novo' }, 'descartado'), true);
  assert.equal(s.contar("SELECT COUNT(*) AS n FROM catalogo_itens WHERE chave = 'MLB77'"), 1);
  const l2 = s.item(l.id);
  assert.deepEqual([l2.status, l2.oferta.title, l2.decidido_em], ['descartado', 'Fone Novo', s.relogio.t]);
});

test('registrar: o que não fecha não grava; revisão exige motivo da lista; item em revisão nunca é sobrescrito', () => {
  const s = montar();
  const regra = s.regra();
  assert.equal(s.itens.registrar(regra, ML(1, { title: '  ' }), 'enviado'), false, 'sem título');
  assert.equal(s.itens.registrar(regra, ML(1, { price: 0 }), 'enviado'), false, 'preço zero');
  assert.equal(s.itens.registrar(regra, ML(1, { price: 'abc' }), 'enviado'), false);
  assert.equal(s.itens.registrar(regra, ML(1, { price: true }), 'enviado'), false, 'preço que não é número');
  assert.equal(s.itens.registrar(regra, { ...ML(1), key: 'MLA1' }, 'enviado'), false, 'chave de fora');
  assert.equal(s.itens.registrar(regra, ML(1), 'processando'), false, 'status fora da lista');
  assert.equal(s.itens.registrar({ id: 0 }, ML(1), 'enviado'), false);
  assert.equal(s.itens.registrar(null, ML(1), 'enviado'), false);
  assert.equal(s.itens.registrar(regra, ML(1), 'revisao', []), false, 'revisão sem motivo');
  assert.equal(s.itens.registrar(regra, ML(1), 'revisao', ['ml_sem_extensao']), false, 'motivo que não existe');
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM catalogo_itens'), 0);

  const id = s.revisao(regra, ML(1, { discountPct: 100 }), ['desconto_100', 'inventado', 'desconto_100', 'preco_antigo']);
  assert.deepEqual(s.item(id).motivos, ['desconto_100', 'preco_antigo'], 'só os motivos da lista, sem repetir');
  assert.equal(s.item(id).decidido_em, null);
  assert.equal(s.itens.registrar(regra, ML(1), 'enviado'), false, 'quem decide o item em revisão é o Dono');
  assert.equal(s.itens.registrar(regra, ML(1), 'revisao', ['falha_link']), false);
  assert.deepEqual([s.item(id).status, s.item(id).motivos], ['revisao', ['desconto_100', 'preco_antigo']]);
});

test('CA4 verificador: o motivo nao_conferido é aceito, vai à revisão e volta na listagem com o motivo', () => {
  const s = montar();
  const regra = s.regra();
  assert.equal(s.itens.registrar(regra, ML(7), 'revisao', ['nao_conferido']), true);
  const id = s.revisao(regra, ML(8), ['nao_conferido', 'desconto_100']);
  assert.deepEqual([s.item(id).status, s.item(id).motivos], ['revisao', ['nao_conferido', 'desconto_100']]);
  const l = s.itens.listar({ status: 'revisao' });
  assert.equal(l.itens.length, 2);
  assert.ok(l.itens.every((i) => i.motivos.includes('nao_conferido')), JSON.stringify(l.itens.map((i) => i.motivos)));
});

test('R2 verificador: o descarte do verificador guarda o motivo e a listagem o devolve; o descarte comum e o da revisão, não', () => {
  const s = montar();
  const regra = s.regra();
  assert.equal(s.itens.registrar(regra, ML(1), 'descartado', [], { descartadoPor: 'esgotado' }), true);
  assert.equal(s.itens.registrar(regra, ML(2), 'descartado', [], { descartadoPor: 'preco_subiu' }), true);
  assert.equal(s.itens.registrar(regra, ML(3), 'descartado'), true);
  assert.equal(s.itens.registrar(regra, ML(4), 'descartado', [], { descartadoPor: 'nao_conferido' }), true, 'nao_conferido vai à revisão, nunca descarta: não vale como motivo');
  assert.equal(s.itens.registrar(regra, ML(5), 'descartado', [], { descartadoPor: 'constructor' }), true);
  assert.equal(s.itens.registrar(regra, ML(6), 'enviado', [], { descartadoPor: 'esgotado' }), true, 'só o descarte leva o motivo');
  const idRev = s.revisao(regra, ML(7), ['shopee']);
  s.itens.descartar(idRev, {});
  const porChave = Object.fromEntries(s.itens.listar().itens.map((i) => [i.oferta.link.match(/MLB-(\d+)/)[1], i.descartado_por]));
  assert.deepEqual(porChave, { 1: 'esgotado', 2: 'preco_subiu', 3: undefined, 4: undefined, 5: undefined, 6: undefined, 7: undefined });
});

test('CA1.4 (rodar sozinho): indisponivel e outro_produto, descartes novos do verificador, ficam em descartado_por e voltam na listagem', () => {
  const s = montar();
  const regra = s.regra();
  assert.equal(s.itens.registrar(regra, AMZ('B0AAAAAAA1'), 'descartado', [], { descartadoPor: 'indisponivel' }), true);
  assert.equal(s.itens.registrar(regra, AMZ('B0AAAAAAA2'), 'descartado', [], { descartadoPor: 'outro_produto' }), true);
  assert.equal(s.itens.registrar(regra, AMZ('B0AAAAAAA3'), 'enviado', [], { descartadoPor: 'indisponivel' }), true, 'só o descarte leva o motivo');
  const gravado = (asin) => s.item(s.db.prepare('SELECT id FROM catalogo_itens WHERE chave = ?').get(`ASIN:${asin}`).id);
  assert.deepEqual([gravado('B0AAAAAAA1').oferta.descartado_por, gravado('B0AAAAAAA1').status], ['indisponivel', 'descartado']);
  assert.deepEqual([gravado('B0AAAAAAA2').oferta.descartado_por, gravado('B0AAAAAAA2').status], ['outro_produto', 'descartado']);
  assert.equal(Object.hasOwn(gravado('B0AAAAAAA3').oferta, 'descartado_por'), false);
  const porChave = Object.fromEntries(s.itens.listar().itens.map((i) => [i.oferta.link.match(/\/dp\/(\w+)/)[1], i.descartado_por]));
  assert.deepEqual(porChave, { B0AAAAAAA1: 'indisponivel', B0AAAAAAA2: 'outro_produto', B0AAAAAAA3: undefined });
  // descartado da regra: não volta naquela regra (P3 do plano)
  assert.equal(s.itens.tratada(regra, AMZ('B0AAAAAAA1'), 'desconto'), true);
});

// --------------------------------------------------------------------- migração do nao_conferido (CA1.10)
/**
 * Banco "da versão anterior": aberto pela versão nova (o esquema é o mesmo), mas sem a marca da migração, com os itens
 * gravados como o registrar de antes gravava. Fecha o banco: quem testa reabre com openDb (é aí que a migração roda).
 * `marcas`: as migrações que ainda não rodaram (as outras ficam marcadas, como num banco que já passou por elas).
 */
function bancoAntesDaMigracao(montarItens, marcas = [MARCA_MIGRACAO_E1]) {
  const dir = tmp();
  const db = openDb(dir);
  for (const m of marcas) db.prepare('DELETE FROM settings WHERE key = ?').run(m);
  db.prepare('DELETE FROM log').run();
  const regra = (nome) => ({ id: Number(db.prepare("INSERT INTO rules (name, group_jids, created_at) VALUES (?, '[]', 1)").run(nome).lastInsertRowid), name: nome });
  const itens = createCatalogoItens({ db, agora: () => 1_000 });
  const cru = (r, chave, status, motivos) => db.prepare(`INSERT INTO catalogo_itens (rule_id, chave, loja, status, motivos, oferta, criado_em, decidido_em)
    VALUES (?, ?, 'ml', ?, ?, '{"title":"Fone","price":10}', 1, NULL)`).run(r.id, chave, status, motivos);
  montarItens({ db, itens, regra, cru });
  db.close();
  return dir;
}
const linhasItens = (db) => db.prepare('SELECT rule_id, chave, status, motivos FROM catalogo_itens ORDER BY id').all().map((l) => ({ ...l }));
const linhasLog = (db) => db.prepare('SELECT rule_id, rule_name, level, group_name, offer_title, message FROM log ORDER BY id').all().map((l) => ({ ...l }));

test('CA1.10: a migração tira da revisão só os itens com motivos exatamente ["nao_conferido"], uma vez, e grava a contagem no Histórico', () => {
  const dir = bancoAntesDaMigracao(({ itens, regra, cru }) => {
    const r1 = regra('Regra 1'); const r2 = regra('Regra 2');
    assert.equal(itens.registrar(r1, ML(1), 'revisao', ['nao_conferido']), true);            // sai
    assert.equal(itens.registrar(r2, ML(1), 'revisao', ['nao_conferido']), true);            // sai (outra regra, mesma chave)
    assert.equal(itens.registrar(r2, AMZ(), 'revisao', ['nao_conferido']), true);            // sai
    assert.equal(itens.registrar(r1, ML(2), 'revisao', ['nao_conferido', 'desconto_100']), true);
    assert.equal(itens.registrar(r1, ML(3), 'revisao', ['falha_link']), true);
    assert.equal(itens.registrar(r1, SHP(), 'revisao', ['shopee']), true);
    cru(r1, 'MLB4', 'revisao', '["nao_conferido","outro"]');
    cru(r1, 'MLB5', 'revisao', '["outro","nao_conferido"]');
    cru(r1, 'MLB6', 'descartado', '["nao_conferido"]');
    cru(r1, 'MLB7', 'enviado', '["nao_conferido"]');
    cru(r1, 'MLB8', 'revisao', '[]');
  });
  const ficam = [
    { rule_id: 1, chave: 'MLB2', status: 'revisao', motivos: '["nao_conferido","desconto_100"]' },
    { rule_id: 1, chave: 'MLB3', status: 'revisao', motivos: '["falha_link"]' },
    { rule_id: 1, chave: 'SHOPEE:111.22334455', status: 'revisao', motivos: '["shopee"]' },
    { rule_id: 1, chave: 'MLB4', status: 'revisao', motivos: '["nao_conferido","outro"]' },
    { rule_id: 1, chave: 'MLB5', status: 'revisao', motivos: '["outro","nao_conferido"]' },
    { rule_id: 1, chave: 'MLB6', status: 'descartado', motivos: '["nao_conferido"]' },
    { rule_id: 1, chave: 'MLB7', status: 'enviado', motivos: '["nao_conferido"]' },
    { rule_id: 1, chave: 'MLB8', status: 'revisao', motivos: '[]' },
  ];

  let db = openDb(dir);
  assert.deepEqual(linhasItens(db), ficam, 'saíram só os três "só nao_conferido" em revisão');
  assert.equal(getSetting(db, MARCA_MIGRACAO_E1), '1');
  const linha = { rule_id: null, rule_name: null, level: 'info', group_name: null, offer_title: null, message: textoMigracaoE1(3) };
  assert.deepEqual(linhasLog(db), [linha], 'uma linha info, sem regra nem oferta');
  assert.match(linha.message, /\b3 ofertas\b/, 'a contagem vai no texto');

  // roda uma vez só: um item novo "só nao_conferido" (código de antes, rollback) não sai na próxima abertura
  createCatalogoItens({ db }).registrar({ id: 1, name: 'Regra 1' }, ML(9), 'revisao', ['nao_conferido']);
  db.close();
  db = openDb(dir);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE chave = 'MLB9' AND status = 'revisao'").get().n, 1, 'segunda abertura não apaga');
  assert.equal(linhasLog(db).length, 1, 'nem grava outra linha');
  db.close();
});

test('CA1.10: textos da contagem (1, várias, nenhuma) sem "Separada para revisão"; banco novo marca sem linha; com catálogo e nada a tirar, a linha diz que nada saiu', () => {
  assert.equal(textoMigracaoE1(1), 'Revisão do Catálogo: 1 oferta que esperava revisão só porque não deu para conferir o preço saiu da fila. Ela volta se o catálogo a trouxer de novo.');
  assert.equal(textoMigracaoE1(12), 'Revisão do Catálogo: 12 ofertas que esperavam revisão só porque não deu para conferir o preço saíram da fila. Elas voltam se o catálogo as trouxer de novo.');
  assert.equal(textoMigracaoE1(0), 'Revisão do Catálogo: nenhuma oferta esperava revisão só porque não deu para conferir o preço.');
  for (const n of [0, 1, 12]) assert.doesNotMatch(textoMigracaoE1(n), /Separada para revisão|nao_conferido/);

  // instalação nova: marca na hora (nunca roda depois) e não suja o Histórico
  const novo = openDb(tmp());
  assert.equal(getSetting(novo, MARCA_MIGRACAO_E1), '1');
  assert.deepEqual(linhasLog(novo), []);
  novo.close();

  // catálogo em uso, sem nenhum "só nao_conferido": a linha diz que nada saiu (o dono confere depois do merge)
  const dir = bancoAntesDaMigracao(({ itens, regra }) => { assert.equal(itens.registrar(regra('R'), ML(1), 'revisao', ['shopee']), true); });
  const db = openDb(dir);
  assert.equal(linhasItens(db).length, 1);
  assert.deepEqual(linhasLog(db).map((l) => [l.level, l.message]), [['info', textoMigracaoE1(0)]]);
  db.close();
});

test('CA1.10: falha no meio da migração desfaz tudo (nada apagado, sem marca, sem linha), não derruba o openDb nem vaza a mensagem do banco; a próxima abertura migra', (t) => {
  const dir = bancoAntesDaMigracao(({ db, itens, regra }) => {
    assert.equal(itens.registrar(regra('R'), ML(1), 'revisao', ['nao_conferido']), true);
    // falha no último passo (a linha do Histórico), depois do DELETE e da marca: os dois precisam ser desfeitos
    db.exec("CREATE TRIGGER falha_no_log BEFORE INSERT ON log BEGIN SELECT RAISE(ABORT, 'dado 5511999990000'); END");
  });
  const erros = [];
  t.mock.method(console, 'error', (...a) => { erros.push(a.map(String).join(' ')); });
  let db = openDb(dir);
  assert.equal(linhasItens(db).length, 1, 'nada apagado');
  assert.equal(getSetting(db, MARCA_MIGRACAO_E1), null, 'sem marca: tenta de novo na próxima abertura');
  assert.deepEqual(linhasLog(db), []);
  assert.equal(erros.length, 1);
  assert.doesNotMatch(erros[0], /5511999990000/, 'a mensagem do banco não vai ao console');
  db.exec('DROP TRIGGER falha_no_log');
  db.close();
  db = openDb(dir);
  assert.equal(linhasItens(db).length, 0);
  assert.equal(getSetting(db, MARCA_MIGRACAO_E1), '1');
  assert.deepEqual(linhasLog(db).map((l) => l.message), [textoMigracaoE1(1)]);
  db.close();
});

// --------------------------------------------------------------------- migração do falha_link (CA2.17)

test('CA2.17: a migração tira da revisão só os itens com motivos exatamente ["falha_link"], uma vez, e grava a contagem no Histórico', () => {
  const dir = bancoAntesDaMigracao(({ itens, regra, cru }) => {
    const r1 = regra('Regra 1'); const r2 = regra('Regra 2');
    assert.equal(itens.registrar(r1, ML(1), 'revisao', ['falha_link']), true);                // sai
    assert.equal(itens.registrar(r2, ML(1), 'revisao', ['falha_link']), true);                // sai (outra regra, mesma chave)
    assert.equal(itens.registrar(r2, ML(2), 'revisao', ['falha_link']), true);                // sai
    assert.equal(itens.registrar(r1, ML(3), 'revisao', ['falha_link', 'desconto_100']), true);
    assert.equal(itens.registrar(r1, ML(4), 'revisao', ['nao_conferido']), true);              // a E1 já rodou neste banco
    assert.equal(itens.registrar(r1, ML(5), 'revisao', ['falhas_repetidas']), true);
    cru(r1, 'MLB6', 'revisao', '["falha_link","outro"]');
    cru(r1, 'MLB7', 'revisao', '["outro","falha_link"]');
    cru(r1, 'MLB8', 'descartado', '["falha_link"]');
    cru(r1, 'MLB9', 'enviado', '["falha_link"]');
    cru(r1, 'MLB10', 'revisao', '[ "falha_link" ]');                                             // não é o JSON do registrar: fica
    cru(r1, 'MLB11', 'revisao', '[]');
  }, [MARCA_MIGRACAO_E2]);
  const ficam = [
    { rule_id: 1, chave: 'MLB3', status: 'revisao', motivos: '["falha_link","desconto_100"]' },
    { rule_id: 1, chave: 'MLB4', status: 'revisao', motivos: '["nao_conferido"]' },
    { rule_id: 1, chave: 'MLB5', status: 'revisao', motivos: '["falhas_repetidas"]' },
    { rule_id: 1, chave: 'MLB6', status: 'revisao', motivos: '["falha_link","outro"]' },
    { rule_id: 1, chave: 'MLB7', status: 'revisao', motivos: '["outro","falha_link"]' },
    { rule_id: 1, chave: 'MLB8', status: 'descartado', motivos: '["falha_link"]' },
    { rule_id: 1, chave: 'MLB9', status: 'enviado', motivos: '["falha_link"]' },
    { rule_id: 1, chave: 'MLB10', status: 'revisao', motivos: '[ "falha_link" ]' },
    { rule_id: 1, chave: 'MLB11', status: 'revisao', motivos: '[]' },
  ];

  let db = openDb(dir);
  assert.deepEqual(linhasItens(db), ficam, 'saíram só os três "só falha_link" em revisão');
  assert.equal(getSetting(db, MARCA_MIGRACAO_E2), '1');
  assert.equal(MARCA_MIGRACAO_E2, 'migracao_e2_falha_link');
  const linha = { rule_id: null, rule_name: null, level: 'info', group_name: null, offer_title: null, message: textoMigracaoE2(3) };
  assert.deepEqual(linhasLog(db), [linha], 'uma linha info, sem regra nem oferta (a E1 não roda de novo)');
  assert.match(linha.message, /\b3 ofertas\b/, 'a contagem vai no texto');
  assert.ok(MOTIVOS.includes('falha_link'), 'o motivo continua legível nas linhas que ficaram');
  assert.deepEqual(createCatalogoItens({ db }).listar({ status: 'revisao' }).itens.find((i) => i.motivos.includes('desconto_100')).motivos, ['falha_link', 'desconto_100']);

  // roda uma vez só: um item novo "só falha_link" (código de antes, rollback) não sai na próxima abertura
  createCatalogoItens({ db }).registrar({ id: 1, name: 'Regra 1' }, ML(12), 'revisao', ['falha_link']);
  db.close();
  db = openDb(dir);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE chave = 'MLB12' AND status = 'revisao'").get().n, 1, 'segunda abertura não apaga');
  assert.equal(linhasLog(db).length, 1, 'nem grava outra linha');
  db.close();
});

test('CA2.17: textos da contagem (1, várias, nenhuma) como na spec; banco novo marca sem linha; com catálogo e nada a tirar, a linha diz que nada saiu', () => {
  assert.equal(textoMigracaoE2(1), 'Revisão do Catálogo: 1 oferta que esperava revisão só porque o link não foi gerado saiu da fila. Ela volta se o catálogo a trouxer de novo.');
  assert.equal(textoMigracaoE2(28), 'Revisão do Catálogo: 28 ofertas que esperavam revisão só porque o link não foi gerado saíram da fila. Elas voltam se o catálogo as trouxer de novo.');
  assert.equal(textoMigracaoE2(0), 'Revisão do Catálogo: nenhuma oferta esperava revisão só porque o link não foi gerado.');
  for (const n of [0, 1, 28]) assert.doesNotMatch(textoMigracaoE2(n), /Separada para revisão|falha_link/);

  const novo = openDb(tmp());
  assert.equal(getSetting(novo, MARCA_MIGRACAO_E2), '1');
  assert.deepEqual(linhasLog(novo), []);
  novo.close();

  const dir = bancoAntesDaMigracao(({ itens, regra }) => { assert.equal(itens.registrar(regra('R'), ML(1), 'revisao', ['shopee']), true); }, [MARCA_MIGRACAO_E2]);
  const db = openDb(dir);
  assert.equal(linhasItens(db).length, 1);
  assert.deepEqual(linhasLog(db).map((l) => [l.level, l.message]), [['info', textoMigracaoE2(0)]]);
  db.close();

  // banco sem catálogo em uso: marca sem linha
  const vazio = bancoAntesDaMigracao(() => {}, [MARCA_MIGRACAO_E2]);
  const dbv = openDb(vazio);
  assert.equal(getSetting(dbv, MARCA_MIGRACAO_E2), '1');
  assert.deepEqual(linhasLog(dbv), []);
  dbv.close();
});

test('CA2.17: banco de antes da entrega 1 passa pelas duas migrações na mesma abertura, cada uma com a sua linha, na ordem', () => {
  const dir = bancoAntesDaMigracao(({ itens, regra }) => {
    const r = regra('R');
    assert.equal(itens.registrar(r, ML(1), 'revisao', ['nao_conferido']), true);
    assert.equal(itens.registrar(r, ML(2), 'revisao', ['falha_link']), true);
    assert.equal(itens.registrar(r, ML(3), 'revisao', ['falha_link']), true);
    assert.equal(itens.registrar(r, ML(4), 'revisao', ['shopee']), true);
  }, [MARCA_MIGRACAO_E1, MARCA_MIGRACAO_E2]);
  const db = openDb(dir);
  assert.deepEqual(linhasItens(db).map((l) => l.chave), ['MLB4']);
  assert.deepEqual(linhasLog(db).map((l) => l.message), [textoMigracaoE1(1), textoMigracaoE2(2)]);
  assert.deepEqual([getSetting(db, MARCA_MIGRACAO_E1), getSetting(db, MARCA_MIGRACAO_E2)], ['1', '1']);
  db.close();
});

test('CA2.17: falha no meio da migração desfaz tudo (nada apagado, sem marca, sem linha), não derruba o openDb nem vaza a mensagem do banco; a próxima abertura migra', (t) => {
  const dir = bancoAntesDaMigracao(({ db, itens, regra }) => {
    assert.equal(itens.registrar(regra('R'), ML(1), 'revisao', ['falha_link']), true);
    db.exec("CREATE TRIGGER falha_no_log BEFORE INSERT ON log BEGIN SELECT RAISE(ABORT, 'dado 5511999990000'); END");
  }, [MARCA_MIGRACAO_E2]);
  const erros = [];
  t.mock.method(console, 'error', (...a) => { erros.push(a.map(String).join(' ')); });
  let db = openDb(dir);
  assert.equal(linhasItens(db).length, 1, 'nada apagado');
  assert.equal(getSetting(db, MARCA_MIGRACAO_E2), null, 'sem marca: tenta de novo na próxima abertura');
  assert.deepEqual(linhasLog(db), []);
  assert.equal(erros.length, 1);
  assert.doesNotMatch(erros[0], /5511999990000/, 'a mensagem do banco não vai ao console');
  db.exec('DROP TRIGGER falha_no_log');
  db.close();
  db = openDb(dir);
  assert.equal(linhasItens(db).length, 0);
  assert.equal(getSetting(db, MARCA_MIGRACAO_E2), '1');
  assert.deepEqual(linhasLog(db).map((l) => l.message), [textoMigracaoE2(1)]);
  db.close();
});

test('P5: teto de 50 pendentes por regra; a 51ª não entra; contar e listar dizem quantas e se a fila está cheia', () => {
  const s = montar();
  const regra = s.regra();
  const outra = s.regra({ name: 'Outra' });
  assert.equal(TETO_REVISAO, 50);
  for (let i = 1; i <= 49; i++) s.revisao(regra, SHP(String(i)), ['shopee']);
  assert.equal(s.itens.revisaoCheia(regra.id), false);
  assert.deepEqual(s.itens.contar().regras, [{ rule_id: regra.id, regra: 'Perfumes do catálogo', para_revisar: 49, cheia: false }]);
  s.revisao(regra, SHP('50'), ['shopee']);
  assert.equal(s.itens.revisaoCheia(regra.id), true);
  assert.equal(s.itens.registrar(regra, SHP('51'), 'revisao', ['shopee']), false, 'a 51ª espera sem entrar');
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM catalogo_itens WHERE rule_id = ?', regra.id), 50);
  assert.equal(s.itens.registrar(regra, ML(1), 'enviado'), true, 'o teto só vale para a revisão');
  // outra regra tem a própria fila
  assert.equal(s.itens.registrar(outra, SHP('51'), 'revisao', ['shopee']), true);
  assert.equal(s.itens.revisaoCheia(outra.id), false);

  assert.deepEqual(s.itens.contar(), {
    para_revisar: 51, teto_revisao: 50,
    regras: [{ rule_id: regra.id, regra: 'Perfumes do catálogo', para_revisar: 50, cheia: true }, { rule_id: outra.id, regra: 'Outra', para_revisar: 1, cheia: false }],
  });
  const l = s.itens.listar({ regra: String(regra.id), status: 'revisao', limite: '200' });
  assert.equal(l.itens.length, 50);
  assert.deepEqual(l.regras, [{ rule_id: regra.id, regra: 'Perfumes do catálogo', para_revisar: 50, cheia: true }]);
  assert.deepEqual([l.para_revisar, l.teto_revisao, l.contadores_24h.para_revisar], [51, 50, 50]);

  // descartar uma abre vaga
  s.itens.descartar(l.itens[0].id);
  assert.equal(s.itens.revisaoCheia(regra.id), false);
  assert.equal(s.itens.registrar(regra, SHP('51'), 'revisao', ['shopee']), true);
});

// ------------------------------------------------------------------------------------------------ listar

test('listar: filtros, link para conferir por loja, grupos da regra na revisão, contadores das últimas 24 h', () => {
  const s = montar();
  const regra = s.regra();
  const idS = s.revisao(regra, SHP('1'), ['shopee']);
  s.relogio.t += 10;
  const idA = s.revisao(regra, AMZ(ASIN, { oldPrice: 20000 }), ['preco_antigo']);
  s.relogio.t += 10;
  s.itens.registrar(regra, ML(5), 'enviado');
  s.relogio.t += 10;
  s.itens.registrar(regra, ML(6), 'descartado');
  // descartada há mais de 24 h: fora do contador, mas na lista
  s.relogio.t -= 2 * DIA; s.itens.registrar(regra, ML(7), 'descartado'); s.relogio.t += 2 * DIA;

  const tudo = s.itens.listar();
  assert.deepEqual(tudo.itens.map((i) => [i.loja, i.status]), [['ml', 'descartado'], ['ml', 'enviado'], ['amazon', 'revisao'], ['shopee', 'revisao'], ['ml', 'descartado']]);
  assert.deepEqual(tudo.contadores_24h, { enviadas: 1, descartadas: 1, para_revisar: 2 });
  const shp = tudo.itens.find((i) => i.id === idS);
  assert.deepEqual({ ...shp, oferta: { ...shp.oferta }, grupos: shp.grupos.map((g) => ({ ...g })) }, {
    id: idS, rule_id: regra.id, regra: 'Perfumes do catálogo', loja: 'shopee', status: 'revisao', motivos: ['shopee'],
    oferta: { title: 'Perfume Floral', price: 59.9, oldPrice: null, discountPct: 30, sold: 50, freeShipping: true, coupon: null, image: IMG_SHOPEE, categoria: 'Perfumes', link: LINK_SHOPEE_OK },
    grupos: [{ nome: 'Achadinhos', ok: null, erro: null }, { nome: 'Tech', ok: null, erro: null }],
    envio_id: null, envio_status: null, pode_reenviar: false, ultimo_envio_falhou: false, ultimo_envio_erros: [], criado_em: s.relogio.t - 30, decidido_em: null,
  });
  assert.equal(tudo.itens.find((i) => i.id === idA).oferta.link, `https://www.amazon.com.br/dp/${ASIN}`, 'Amazon sem tag');
  assert.equal(tudo.itens.find((i) => i.status === 'enviado').oferta.link, 'https://produto.mercadolivre.com.br/MLB-5', 'ML: página do produto');
  assert.deepEqual(tudo.itens.find((i) => i.status === 'enviado').grupos, [], 'enviada sozinha: sem envio da fila');

  assert.deepEqual(s.itens.listar({ status: 'revisao' }).itens.map((i) => i.id), [idA, idS]);
  assert.equal(s.itens.listar({ status: 'enviado' }).itens.length, 1);
  assert.equal(s.itens.listar({ status: 'todos', limite: '2' }).itens.length, 2);
  assert.equal(s.itens.listar({ regra: '999' }).itens.length, 0);
  assert.throws(() => s.itens.listar({ status: 'na_fila' }), { status: 400, message: 'Filtro inválido: use revisao, enviado, descartado ou todos.' });
  assert.throws(() => s.itens.listar({ regra: 'abc' }), { status: 404, message: 'Regra não encontrada.' });

  // regra apagada: o item continua listado, sem nome
  s.db.prepare('DELETE FROM rules WHERE id = ?').run(regra.id);
  assert.equal(s.itens.listar().itens[0].regra, null);
});

// ------------------------------------------------------------------------------------------------ enviar (CA4)

test('CA4: payload de cada loja passa no preparar: ML com a etiqueta da fonte, Amazon com a tag de Conexões, Shopee com o link do catálogo', async () => {
  const s = montar();
  const regra = s.regra();
  const idM = s.revisao(regra, ML(1234567890, { tag_id: 2, discountPct: 100 }), ['desconto_100', 'falha_link']);
  const idA = s.revisao(regra, AMZ(), ['preco_antigo']);
  const idS = s.revisao(regra, SHP('1'), ['shopee']);

  const rM = await s.itens.enviar(idM, { ajustes: { price: '89,90', oldPrice: '149,90' } }, { userId: 7 });
  const rA = await s.itens.enviar(idA, {});
  const rS = await s.itens.enviar(idS, { ajustes: { title: 'Perfume Floral 100ml' } });
  assert.equal(s.acordou.n, 3, 'cada envio acorda o agendador');

  const eM = s.envio(rM.envio_id);
  assert.deepEqual([eM.tipo, eM.quando, eM.status, eM.user_id, eM.group_jids], ['oferta', 'agora', 'pendente', 7, ['111@g.us', '222@g.us']]);
  assert.deepEqual([eM.payload.loja, eM.payload.url, eM.payload.tag_id, eM.payload.etiqueta], ['mercadolivre', 'https://produto.mercadolivre.com.br/MLB-1234567890', 2, 'etiquetaB']);
  assert.deepEqual(eM.payload.origem, { tipo: 'catalogo', rule_id: regra.id, nome: 'Perfumes do catálogo' });
  assert.equal(eM.payload.offer.discountPct, 40, 'o 100% informado não sai: refeito dos preços');
  const eA = s.envio(rA.envio_id);
  assert.deepEqual([eA.payload.loja, eA.payload.asin, eA.payload.tag_id, eA.payload.etiqueta, eA.payload.url], ['amazon', ASIN, null, null, `https://www.amazon.com.br/dp/${ASIN}`]);
  const eS = s.envio(rS.envio_id);
  assert.deepEqual([eS.payload.loja, eS.payload.link_afiliado, eS.payload.shop_id, eS.payload.item_id], ['shopee', LINK_SHOPEE_OK, '111', '1']);

  for (const id of [rM.envio_id, rA.envio_id, rS.envio_id]) await s.envios.runEnvio(id);
  assert.deepEqual([rM, rA, rS].map((r) => s.envio(r.envio_id).status), ['concluido', 'concluido', 'concluido']);
  const msgs = s.enviados();
  assert.equal(msgs.length, 6);
  const de = (jid, i) => msgs.filter((m) => m.jid === jid)[i];
  assert.match(de('111@g.us', 0).text, /Compre aqui: https:\/\/meli\.la\/fake-etiquetaB-\d+$/);
  assert.match(de('111@g.us', 0).text, /^\*Fone Bom\*/);
  assert.equal(de('111@g.us', 0).image, IMG_ML);
  assert.match(de('111@g.us', 1).text, new RegExp(`Compre aqui: https://www\\.amazon\\.com\\.br/dp/${ASIN}\\?tag=${TAG}$`));
  assert.match(de('111@g.us', 1).text, /Cupom: \*MESH10\*/);
  assert.equal(de('111@g.us', 1).image, IMG_AMAZON);
  assert.match(de('111@g.us', 2).text, new RegExp(`^\\*Perfume Floral 100ml\\*[\\s\\S]*Compre aqui: ${LINK_SHOPEE_OK}$`));
  assert.match(de('111@g.us', 2).text, /\(30% OFF\)/, 'o desconto informado (1–99%) vale com os preços intactos');

  // item enviado com o envio, chave em sent_offers, log como "Catálogo: <regra>"
  for (const [id, r] of [[idM, rM], [idA, rA], [idS, rS]]) {
    const it = s.item(id);
    assert.deepEqual([it.status, it.envio_id, it.decidido_em], ['enviado', r.envio_id, s.relogio.t]);
  }
  assert.equal(s.item(idS).oferta.title, 'Perfume Floral 100ml', 'a lista mostra a oferta como saiu');
  assert.deepEqual(s.db.prepare('SELECT offer_key FROM sent_offers WHERE rule_id = ? ORDER BY id').all(regra.id).map((r) => r.offer_key), ['MLB1234567890', `ASIN:${ASIN}`, 'SHOPEE:111.1']);
  const logs = s.logs().filter((l) => l.level === 'ok');
  assert.equal(logs.length, 6);
  for (const l of logs) assert.deepEqual([l.rule_id, l.rule_name], [null, 'Catálogo: Perfumes do catálogo']);
  assert.deepEqual(logs.filter((l) => l.group_name === 'Tech').map((l) => l.message),
    ['Enviado com a etiqueta etiquetaB', 'Enviado com a tag de associado da Amazon', 'Enviado com o link de afiliado da Shopee']);

  // listar mostra o envio com o resultado por grupo
  const l = s.itens.listar({ status: 'enviado' }).itens.find((i) => i.id === idA);
  assert.deepEqual([l.envio_id, l.envio_status, l.grupos.map((g) => ({ ...g }))], [rA.envio_id, 'concluido', [{ nome: 'Achadinhos', ok: true, erro: null }, { nome: 'Tech', ok: true, erro: null }]]);
});

test('ajustes: sem foto, foto enviada pelo painel, frete e cupom; image e link nunca vêm do navegador', async () => {
  const s = montar();
  const regra = s.regra({ send_image: 0 });
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsSAAALEgHS3X78AAAADUlEQVQImWNgYPhfDwACggF/NGwuCgAAAABJRU5ErkJggg==', 'base64');
  const up = await s.envios.gravarFoto(PNG, 'png');
  const idS = s.revisao(regra, SHP('1'), ['shopee']);
  const r = await s.itens.enviar(idS, { ajustes: { sem_foto: true, coupon: 'FLOR5', freeShipping: false, image: 'https://evil.example/x.jpg', link: 'https://evil.example/' } });
  const p = s.envio(r.envio_id).payload;
  assert.deepEqual([p.enviar_foto, p.offer.image, p.offer.coupon, p.offer.freeShipping, p.link_afiliado], [false, null, 'FLOR5', false, LINK_SHOPEE_OK]);

  const idA = s.revisao(regra, AMZ(), ['preco_antigo']);
  await recusa(s.itens.enviar(idA, { ajustes: { upload: 'x.png' } }), 400, 'Escolha a foto de novo.');
  await recusa(s.itens.enviar(idA, { ajustes: { upload: `${'a'.repeat(32)}.png` } }), 400, 'A foto não foi encontrada. Envie de novo.');
  await recusa(s.itens.enviar(idA, { ajustes: { price: 'abc' } }), 400, 'Preço atual inválido: use só números, como 89,90.');
  await recusa(s.itens.enviar(idA, { ajustes: { title: '' } }), 400, 'Preencha o título do produto.');
  await recusa(s.itens.enviar(idA, { ajustes: { price: null } }), 400, 'Preencha o preço atual.');
  await recusa(s.itens.enviar(idA, { ajustes: [] }), 400, 'Dados da oferta inválidos.');
  await recusa(s.itens.enviar(idA, { ajustes: { freeShipping: 'sim' } }), 400, 'Frete grátis: marque ou desmarque.');
  await recusa(s.itens.enviar(idA, { ajustes: { upload: up, sem_foto: true } }), 400, 'Escolha entre trocar a foto e enviar sem foto.');
  const r2 = await s.itens.enviar(idA, { ajustes: { upload: up } });
  const p2 = s.envio(r2.envio_id).payload;
  assert.deepEqual([p2.enviar_foto, p2.upload, p2.offer.image], [true, up, null], 'a foto do painel vai por upload, a da loja sai');
});

test('CA7/P4: preço suspeito depois dos ajustes recusa com frase fixa; corrigido à mão, sai', async () => {
  const s = montar();
  const regra = s.regra();
  const idA = s.revisao(regra, AMZ(ASIN, { price: 10, oldPrice: 100, discountPct: 90 }), ['preco_antigo']);
  await recusa(s.itens.enviar(idA, {}), 400, PRECO_SUSPEITO);
  await recusa(s.itens.enviar(idA, { ajustes: { title: 'Outro título' } }), 400, PRECO_SUSPEITO);
  await recusa(s.itens.enviar(idA, { ajustes: { price: '10,00', oldPrice: '150,00' } }), 400, PRECO_SUSPEITO);
  assert.equal(s.item(idA).status, 'revisao');
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 0, 'nada gravado');
  // apagar o preço antigo: sai sem "de/por" e sem desconto
  const r = await s.itens.enviar(idA, { ajustes: { oldPrice: null } });
  const o = s.envio(r.envio_id).payload.offer;
  assert.deepEqual([o.price, o.oldPrice, o.discountPct], [10, null, null]);

  // preço antigo corrigido (menos de 10×)
  const idB = s.revisao(regra, AMZ('B000000001', { price: 1, oldPrice: 1000, discountPct: 100 }), ['desconto_100', 'preco_antigo']);
  const rB = await s.itens.enviar(idB, { ajustes: { price: '400', oldPrice: '1.000,00' } });
  assert.deepEqual([s.envio(rB.envio_id).payload.offer.oldPrice, s.envio(rB.envio_id).payload.offer.discountPct], [1000, 60]);

  // 100% informado sem preço antigo: a mensagem nunca leva "100%"
  const idC = s.revisao(regra, SHP('5', { discountPct: 100 }), ['shopee', 'desconto_100']);
  const rC = await s.itens.enviar(idC, {});
  await s.envios.runEnvio(rC.envio_id);
  assert.equal(s.envio(rC.envio_id).payload.offer.discountPct, null);
  assert.ok(s.enviados().every((m) => !/100%/.test(m.text)));
});

test('CA4: Shopee com link fora de LINK_SHOPEE é recusada sem gravar nada', async () => {
  const s = montar();
  const regra = s.regra();
  for (const [n, link] of [['1', 'https://shopee.com.br/produto-i.111.1'], ['2', 'http://s.shopee.com.br/7AbCdEfG'], ['3', 'https://s.shopee.com.br.evil.example/7AbCdEfG'],
    ['4', 'https://s.shopee.com.br/7AbCdEfG?x=1'], ['5', null], ['6', 'https://meli.la/abc']]) {
    const id = s.revisao(regra, SHP(n, { link }), ['shopee']);
    await recusa(s.itens.enviar(id, {}), 400, 'O link da Shopee desta oferta está fora do esperado. Descarte a oferta.');
    assert.equal(s.item(id).status, 'revisao');
  }
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 0);
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM sent_offers'), 0);
});

test('CA4: ML em modo direto (link comum) é recusado; extensão desligada também; nada é gravado', async () => {
  const s = montar({ modo: 'direct' });
  const regra = s.regra();
  const id = s.revisao(regra, ML(1), ['falha_link']);
  await recusa(s.itens.enviar(id, {}), 400, 'Os links do Mercado Livre estão no modo direto, sem comissão: ofertas do catálogo não saem assim. Volte ao modo da extensão em Ajustes.');
  s.estado.modo = 'extension';
  await recusa(s.itens.enviar(id, {}), 400, 'A extensão do Chrome não está conectada: abra o Chrome com a extensão para gerar o link de afiliado.');
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 0);
  assert.equal(s.item(id).status, 'revisao');
  // etiqueta apagada (a da fonte e a da regra)
  s.estado.modo = 'fake';
  s.db.exec('DELETE FROM tags');
  await recusa(s.itens.enviar(id, {}), 400, 'A etiqueta desta oferta foi apagada. Escolha uma etiqueta na regra.');
  // a Amazon e a Shopee não dependem do modo do ML
  s.estado.modo = 'direct';
  const idS = s.revisao(regra, SHP('1'), ['shopee']);
  assert.ok((await s.itens.enviar(idS, {})).envio_id);
});

test('CA4: modo do ML mudou para direto depois da revisão: o preparar recusa e nada sai', async () => {
  const s = montar();
  const regra = s.regra();
  const id = s.revisao(regra, ML(1), ['falha_link']);
  const { envio_id } = await s.itens.enviar(id, {});
  s.estado.modo = 'direct';
  await s.envios.runEnvio(envio_id);
  assert.equal(s.envio(envio_id).status, 'erro');
  assert.equal(s.enviados().length, 0);
  assert.deepEqual(s.db.prepare('SELECT erro FROM envio_resultados WHERE envio_id = ?').all(envio_id).map((r) => r.erro),
    ['link de afiliado não gerado: os links do Mercado Livre estão no modo direto (sem comissão)', 'link de afiliado não gerado: os links do Mercado Livre estão no modo direto (sem comissão)']);
  const l = s.itens.listar().itens[0];
  assert.deepEqual([l.envio_status, l.grupos.map((g) => g.ok)], ['erro', [false, false]]);
});

test('enviar: Amazon sem tag ou sem cliente, WhatsApp fora, regra sem grupos, sem template ou apagada recusam', async () => {
  const s = montar({ tag: '' });
  const regra = s.regra();
  const idA = s.revisao(regra, AMZ(), ['preco_antigo']);
  await recusa(s.itens.enviar(idA, {}), 400, 'Falta a tag de associado da Amazon. Cadastre em Conexões → Amazon antes de enviar.');
  s.conexao.tag = TAG;

  s.wa.isReady = () => false;
  await recusa(s.itens.enviar(idA, {}), 400, 'O WhatsApp está desconectado. Conecte o número antes de enviar.');
  s.wa.isReady = () => true;

  s.db.prepare("UPDATE rules SET group_jids = '[\"999@g.us\"]' WHERE id = ?").run(regra.id);
  await recusa(s.itens.enviar(idA, {}), 400, 'A regra desta oferta não tem grupos. Escolha ao menos um grupo na regra.');
  s.db.prepare("UPDATE rules SET group_jids = '[\"222@g.us\"]', template_id = 999 WHERE id = ?").run(regra.id);
  await recusa(s.itens.enviar(idA, {}), 400, 'O template desta regra foi apagado. Escolha outro na regra.');
  s.db.prepare('DELETE FROM rules WHERE id = ?').run(regra.id);
  await recusa(s.itens.enviar(idA, {}), 404, 'A regra desta oferta foi apagada.');
  await recusa(s.itens.enviar(999, {}), 404, 'Oferta não encontrada.');
  await recusa(s.itens.enviar('abc', {}), 404, 'Oferta não encontrada.');
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 0);

  const semAmazon = montar({ comAmazon: false });
  const r2 = semAmazon.regra();
  const id2 = semAmazon.revisao(r2, AMZ(), ['preco_antigo']);
  await recusa(semAmazon.itens.enviar(id2, {}), 400, 'A integração com a Amazon não está disponível neste servidor.');
});

test('trava: dois "Enviar" simultâneos geram um envio só; o segundo recebe 409', async () => {
  const s = montar();
  const regra = s.regra();
  const id = s.revisao(regra, SHP('1'), ['shopee']);
  const r = await Promise.allSettled([s.itens.enviar(id, { ajustes: { title: 'A' } }), s.itens.enviar(id, { ajustes: { title: 'B' } })]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  const erro = r.find((x) => x.status === 'rejected').reason;
  assert.deepEqual([erro.status, erro.message], [409, JA_TRATADA]);
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 1);
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM sent_offers'), 1);
  assert.equal(s.item(id).envio_id, r.find((x) => x.status === 'fulfilled').value.envio_id);
  // depois de enviado, enviar e descartar dão 409
  await recusa(s.itens.enviar(id, {}), 409, JA_TRATADA);
  assert.throws(() => s.itens.descartar(id), { status: 409, message: JA_TRATADA });
});

test('descartar: só da revisão, uma vez; vai ao log como "Catálogo: <regra>"', async () => {
  const s = montar();
  const regra = s.regra({ name: '  Perfumes   da  semana ' });
  const id = s.revisao(regra, SHP('1'), ['shopee']);
  s.relogio.t += 5;
  assert.deepEqual(s.itens.descartar(String(id)), { ok: true });
  assert.deepEqual([s.item(id).status, s.item(id).decidido_em, s.item(id).motivos], ['descartado', s.relogio.t, ['shopee']]);
  assert.throws(() => s.itens.descartar(id), { status: 409, message: JA_TRATADA });
  await recusa(s.itens.enviar(id, {}), 409, JA_TRATADA);
  assert.throws(() => s.itens.descartar(0), { status: 404, message: 'Oferta não encontrada.' });
  assert.throws(() => s.itens.descartar(12345), { status: 404, message: 'Oferta não encontrada.' });
  const enviado = s.itens.registrar(regra, ML(2), 'enviado') && s.db.prepare("SELECT id FROM catalogo_itens WHERE chave = 'MLB2'").get().id;
  assert.throws(() => s.itens.descartar(enviado), { status: 409 });
  assert.deepEqual(s.logs(), [{ rule_id: null, rule_name: 'Catálogo: Perfumes da semana', level: 'info', group_name: null, offer_title: 'Perfume Floral', message: 'Descartada na revisão' }]);
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 0);
});

// ------------------------------------------------------------------------------------------------ rotas (P6)

function req(port, caminho, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, err) => {
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const h = { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      const partes = []; res.on('data', (c) => partes.push(c));
      res.on('end', () => { const txt = Buffer.concat(partes).toString('utf8'); let json = null; try { json = JSON.parse(txt); } catch { /* */ } ok({ status: res.statusCode, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}

/** Express mínimo: o papel vem do cabeçalho x-papel (o login de verdade é do server.js); soDono é o de src/auth.js. */
async function subirRotas(s, { comSoDono = true, servico = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { const p = rq.headers['x-papel']; rq.user = p ? { id: p === 'dono' ? 1 : 2, papel: p } : null; next(); });
  const ctx = { db: s.db, ...(comSoDono ? { soDono: soDono({ enabled: () => true }) } : {}), ...(servico ? { catalogoItens: s.itens } : {}) };
  montarRotas(app, ctx);
  const server = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)); });
  const { port } = server.address();
  return {
    pedir: (caminho, papel, o = {}) => req(port, caminho, { ...o, headers: { ...(papel ? { 'x-papel': papel } : {}) } }),
    fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

test('P6 rotas: Operador vê a lista mas recebe 403 ao enviar e descartar; o Dono envia e descarta', async () => {
  const s = montar();
  const regra = s.regra();
  const id1 = s.revisao(regra, SHP('1'), ['shopee']);
  const id2 = s.revisao(regra, SHP('2'), ['shopee']);
  const h = await subirRotas(s);
  try {
    const lista = await h.pedir(`/api/catalogo/itens?regra=${regra.id}&status=revisao`, 'operador');
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.json.itens.map((i) => i.id).sort(), [id1, id2].sort());
    assert.deepEqual(lista.json.regras, [{ rule_id: regra.id, regra: 'Perfumes do catálogo', para_revisar: 2, cheia: false }]);

    for (const acao of ['enviar', 'descartar']) {
      const r = await h.pedir(`/api/catalogo/itens/${id1}/${acao}`, 'operador', { method: 'POST', body: {} });
      assert.deepEqual([r.status, r.json], [403, { erro: 'Só o Dono pode fazer isso.' }], acao);
    }
    const semLogin = await h.pedir(`/api/catalogo/itens/${id1}/enviar`, null, { method: 'POST', body: {} });
    assert.equal(semLogin.status, 401);
    assert.equal(s.item(id1).status, 'revisao');
    assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 0);

    const env = await h.pedir(`/api/catalogo/itens/${id1}/enviar`, 'dono', { method: 'POST', body: { ajustes: { title: 'Perfume Floral' } } });
    assert.equal(env.status, 200, env.txt);
    assert.deepEqual(Object.keys(env.json), ['envio_id']);
    assert.equal(s.envio(env.json.envio_id).user_id, 1);
    const de = await h.pedir(`/api/catalogo/itens/${id2}/descartar`, 'dono', { method: 'POST' });
    assert.deepEqual([de.status, de.json], [200, { ok: true }]);

    const dup = await h.pedir(`/api/catalogo/itens/${id1}/enviar`, 'dono', { method: 'POST', body: {} });
    assert.deepEqual([dup.status, dup.json], [409, { erro: JA_TRATADA }]);
    const nao = await h.pedir('/api/catalogo/itens/999/descartar', 'dono', { method: 'POST' });
    assert.deepEqual([nao.status, nao.json], [404, { erro: 'Oferta não encontrada.' }]);
    const filtro = await h.pedir('/api/catalogo/itens?status=xyz', 'operador');
    assert.equal(filtro.status, 400);
  } finally { await h.fechar(); }
});

test('rotas: dois POST "enviar" ao mesmo tempo geram um envio só (200 + 409)', async () => {
  const s = montar();
  const regra = s.regra();
  const id = s.revisao(regra, AMZ(), ['preco_antigo']);
  const h = await subirRotas(s);
  try {
    const caminho = `/api/catalogo/itens/${id}/enviar`;
    const r = await Promise.all([h.pedir(caminho, 'dono', { method: 'POST', body: {} }), h.pedir(caminho, 'dono', { method: 'POST', body: {} })]);
    assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
    assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 1);
  } finally { await h.fechar(); }
});

test('rotas: sem soDono no ctx ninguém envia (falha fechada); sem o serviço, 503; erro do banco não vaza', async (t) => {
  const s = montar();
  const regra = s.regra();
  const id = s.revisao(regra, SHP('1'), ['shopee']);
  const sem = await subirRotas(s, { comSoDono: false });
  try {
    const r = await sem.pedir(`/api/catalogo/itens/${id}/enviar`, 'dono', { method: 'POST', body: {} });
    assert.equal(r.status, 403);
    assert.equal(s.item(id).status, 'revisao');
  } finally { await sem.fechar(); }
  const semServico = await subirRotas(s, { servico: false });
  try {
    const r = await semServico.pedir('/api/catalogo/itens', 'dono');
    assert.deepEqual([r.status, r.json], [503, { erro: 'O catálogo não está disponível neste servidor.' }]);
  } finally { await semServico.fechar(); }

  const erros = t.mock.method(console, 'error', () => {});
  const h = await subirRotas(s);
  try {
    s.db.exec('DROP TABLE catalogo_itens');
    const r = await h.pedir('/api/catalogo/itens', 'dono');
    assert.deepEqual([r.status, r.json], [500, { erro: 'Não consegui concluir. Tente de novo.' }]);
    const doConsole = erros.mock.calls.map((c) => c.arguments.map(String).join(' ')).join('\n');
    assert.ok(!/catalogo_itens|SELECT/i.test(doConsole), 'o console não leva a mensagem do banco');
  } finally { await h.fechar(); }
});

// ------------------------------------------------------------------------------------- rodada 1 de correções

/** Faz todo envio do WhatsApp falhar (true) ou voltar ao normal (false). */
function quebrarWhatsApp(s, quebrar = true) {
  s.reais ??= { sendText: s.wa.sendText, sendImage: s.wa.sendImage };
  if (quebrar) {
    s.wa.sendText = async () => { throw new Error('socket caiu'); };
    s.wa.sendImage = async () => { throw new Error('socket caiu'); };
  } else Object.assign(s.wa, s.reais);
}
const reservas = (s, regra, chave) => s.contar('SELECT COUNT(*) AS n FROM sent_offers WHERE rule_id = ? AND offer_key = ?', regra.id, chave);
const daLista = (s, id) => s.itens.listar({ status: 'todos', limite: 200 }).itens.find((i) => i.id === id);

test('R3: envio aprovado que termina sem nenhum grupo ok não fica "queimado": sai do dedupe e pode ser enviado de novo', async () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  const id = s.revisao(regra, SHP('1'), ['shopee']);
  const chave = 'SHOPEE:111.1';
  quebrarWhatsApp(s);
  const r1 = await s.itens.enviar(id, { ajustes: { coupon: 'FLOR5' } });
  assert.equal(reservas(s, regra, chave), 1, 'reserva enquanto o envio está na fila');
  assert.equal(daLista(s, id).pode_reenviar, false, 'na fila: ainda não');
  assert.equal(s.itens.tratada(regra, SHP('1'), 'relevancia'), true);
  await s.envios.processarPendentes();
  assert.ok(['erro', 'concluido'].includes(s.envio(r1.envio_id).status), s.envio(r1.envio_id).status);
  assert.deepEqual([daLista(s, id).status, daLista(s, id).pode_reenviar], ['enviado', true]);

  assert.equal(s.itens.liberarFalhos(), 1);
  assert.equal(s.itens.liberarFalhos(), 0, 'idempotente');
  assert.equal(reservas(s, regra, chave), 0, 'não conta no "dias sem repetir"');
  // CA2.8 (rodar-sozinho E2): o item volta à revisão; quem decide é o Dono, e a regra não o traz em nenhuma ordem
  assert.deepEqual([daLista(s, id).status, daLista(s, id).pode_reenviar, daLista(s, id).ultimo_envio_falhou], ['revisao', false, true]);
  assert.equal(s.itens.tratada(regra, SHP('1'), 'relevancia'), true, 'em revisão: a regra não traz de novo');
  assert.equal(s.itens.tratada(regra, SHP('1'), 'atualizacao'), true, 'em Novidades, o caminho é o "Enviar" da revisão');

  // "Enviar de novo": mesma trava (dois juntos geram um envio só), mesmas regras de preço, a oferta ajustada fica
  quebrarWhatsApp(s, false);
  s.relogio.t = Date.now(); // a fila de envios usa o relógio de verdade
  await recusa(s.itens.enviar(id, { ajustes: { price: 1, oldPrice: 100 } }), 400, PRECO_SUSPEITO);
  const r = await Promise.allSettled([s.itens.enviar(id, {}), s.itens.enviar(id, {})]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.deepEqual([r.find((x) => x.status === 'rejected').reason.status, r.find((x) => x.status === 'rejected').reason.message], [409, JA_TRATADA]);
  const r2 = r.find((x) => x.status === 'fulfilled').value;
  assert.notEqual(r2.envio_id, r1.envio_id);
  assert.equal(s.envio(r2.envio_id).payload.offer.coupon, 'FLOR5', 'sai como foi ajustada na revisão');
  assert.equal(s.item(id).envio_id, r2.envio_id);
  assert.equal(reservas(s, regra, chave), 1, 'uma reserva só (a do envio novo)');
  await s.envios.processarPendentes();
  assert.equal(s.enviados().length, 2, 'saiu nos 2 grupos');
  assert.equal(daLista(s, id).pode_reenviar, false);
  assert.equal(s.itens.liberarFalhos(), 0, 'com grupo ok, a reserva fica');
  assert.equal(reservas(s, regra, chave), 1);
  await recusa(s.itens.enviar(id, {}), 409, JA_TRATADA);
});

test('R3: um grupo ok basta para valer como enviado; cancelado sem grupo ok libera; envio apagado pela retenção não', async () => {
  const s = montar();
  const regra = s.regra();
  // 1 de 2 grupos ok
  const idA = s.revisao(regra, SHP('1'), ['shopee']);
  const reais = { sendText: s.wa.sendText, sendImage: s.wa.sendImage };
  const soAchadinhos = (fn) => async (jid, ...a) => { if (jid === '222@g.us') throw new Error('removido do grupo'); return fn(jid, ...a); };
  s.wa.sendText = soAchadinhos(reais.sendText); s.wa.sendImage = soAchadinhos(reais.sendImage);
  await s.itens.enviar(idA, {});
  await s.envios.processarPendentes();
  Object.assign(s.wa, reais);
  assert.equal(daLista(s, idA).pode_reenviar, false);
  assert.equal(s.itens.liberarFalhos(), 0);
  // cancelado antes de sair
  const idB = s.revisao(regra, SHP('2'), ['shopee']);
  const rB = await s.itens.enviar(idB, {});
  await s.envios.cancelar(rB.envio_id);
  assert.equal(daLista(s, idB).pode_reenviar, true);
  assert.equal(s.itens.liberarFalhos(), 1);
  assert.equal(daLista(s, idB).status, 'revisao', 'cancelado sem grupo ok volta à revisão (CA2.8)');
  // enviada sozinha pela regra (sem envio da fila): nunca reenvia
  assert.equal(s.itens.registrar(regra, SHP('3'), 'enviado'), true);
  const idC = s.db.prepare("SELECT id FROM catalogo_itens WHERE chave = 'SHOPEE:111.3'").get().id;
  assert.equal(daLista(s, idC).pode_reenviar, false);
  assert.equal(s.itens.liberarFalhos(), 0, 'nem volta à revisão');
  await recusa(s.itens.enviar(idC, {}), 409, JA_TRATADA);
  // o envio que falhou foi apagado pela retenção antes do liberarFalhos: não se sabe mais, não reenvia nem volta
  const idD = s.revisao(regra, SHP('4'), ['shopee']);
  const rD = await s.itens.enviar(idD, {});
  await s.envios.cancelar(rD.envio_id);
  s.db.prepare('DELETE FROM envios WHERE id = ?').run(rD.envio_id);
  assert.deepEqual([daLista(s, idD).pode_reenviar, daLista(s, idD).ultimo_envio_falhou], [false, false]);
  assert.equal(s.itens.liberarFalhos(), 0);
  assert.equal(daLista(s, idD).status, 'enviado');
  await recusa(s.itens.enviar(idD, {}), 409, JA_TRATADA);
  // o item que já voltou à revisão segue na revisão quando a retenção apaga o envio antigo (só não sabe mais os erros)
  s.db.prepare('DELETE FROM envios WHERE id = ?').run(rB.envio_id);
  assert.deepEqual([daLista(s, idB).status, daLista(s, idB).ultimo_envio_falhou, daLista(s, idB).ultimo_envio_erros], ['revisao', false, []]);
});

// ------------------------------------------------------------------- "Enviar" que falha volta à revisão (CA2.8)

test('CA2.8: "Enviar" que falha em todos os grupos volta à revisão sem reserva; o "Enviar" seguinte funciona', async () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  const id = s.revisao(regra, ML(4242), ['falhas_repetidas']);
  const antes = s.item(id);
  quebrarWhatsApp(s);
  const r1 = await s.itens.enviar(id, {});
  assert.equal(s.item(id).status, 'enviado');
  await s.envios.runEnvio(r1.envio_id);
  assert.equal(s.envio(r1.envio_id).status, 'erro');
  assert.equal(reservas(s, regra, 'MLB4242'), 1, 'antes do liberarFalhos a reserva ainda está lá');

  assert.equal(s.itens.liberarFalhos(), 1, 'um item voltou');
  const item = s.item(id);
  assert.deepEqual([item.status, item.decidido_em, item.envio_id, item.motivos], ['revisao', null, r1.envio_id, ['falhas_repetidas']],
    'revisão, sem decisão, com o envio que falhou e os mesmos motivos');
  assert.equal(item.criado_em, antes.criado_em);
  assert.equal(reservas(s, regra, 'MLB4242'), 0, 'a reserva saiu');
  assert.equal(s.itens.liberarFalhos(), 0, 'idempotente');

  // a lista: os grupos são os da regra (para onde o próximo "Enviar" vai) e os erros do último envio vêm à parte
  const l = daLista(s, id);
  assert.deepEqual([l.status, l.pode_reenviar, l.ultimo_envio_falhou, l.envio_id, l.envio_status], ['revisao', false, true, r1.envio_id, 'erro']);
  assert.deepEqual(l.grupos, [{ nome: 'Achadinhos', ok: null, erro: null }, { nome: 'Tech', ok: null, erro: null }]);
  assert.equal(l.ultimo_envio_erros.length, 2);
  assert.deepEqual(l.ultimo_envio_erros.map((e) => e.nome), ['Achadinhos', 'Tech']);
  assert.ok(l.ultimo_envio_erros.every((e) => typeof e.erro === 'string' && e.erro.length > 0), JSON.stringify(l.ultimo_envio_erros));
  assert.deepEqual(Object.keys(l.ultimo_envio_erros[0]).sort(), ['erro', 'nome']);
  const contadores = s.itens.listar().contadores_24h;
  assert.deepEqual([contadores.enviadas, contadores.para_revisar], [0, 1], 'não conta como enviada');

  // o "Enviar" seguinte funciona e sai nos dois grupos
  quebrarWhatsApp(s, false);
  s.relogio.t = Date.now();
  const r2 = await s.itens.enviar(id, {});
  assert.notEqual(r2.envio_id, r1.envio_id);
  assert.deepEqual([s.item(id).status, s.item(id).envio_id, s.item(id).decidido_em], ['enviado', r2.envio_id, s.relogio.t]);
  assert.equal(reservas(s, regra, 'MLB4242'), 1);
  await s.envios.runEnvio(r2.envio_id);
  assert.equal(s.enviados().length, 2);
  const depois = daLista(s, id);
  assert.deepEqual([depois.status, depois.ultimo_envio_falhou, depois.ultimo_envio_erros, depois.grupos.map((g) => g.ok)], ['enviado', false, [], [true, true]]);
  assert.equal(s.itens.liberarFalhos(), 0, 'com grupo ok o item fica enviado');
  assert.equal(s.item(id).status, 'enviado');
});

test('CA2.8: o item que voltou à revisão pode ser descartado; item em revisão sem envio não tem ultimo_envio_falhou', async () => {
  const s = montar();
  const regra = s.regra();
  const id = s.revisao(regra, SHP('1'), ['shopee']);
  assert.deepEqual([daLista(s, id).ultimo_envio_falhou, daLista(s, id).ultimo_envio_erros], [false, []]);
  const r = await s.itens.enviar(id, {});
  assert.deepEqual([daLista(s, id).ultimo_envio_falhou, daLista(s, id).ultimo_envio_erros], [false, []], 'na fila: ainda não falhou');
  await s.envios.cancelar(r.envio_id);
  assert.equal(s.itens.liberarFalhos(), 1);
  const l = daLista(s, id);
  assert.deepEqual([l.status, l.ultimo_envio_falhou], ['revisao', true]);
  assert.deepEqual(l.ultimo_envio_erros, [{ nome: 'Achadinhos', erro: 'o envio foi cancelado' }, { nome: 'Tech', erro: 'o envio foi cancelado' }]);
  assert.deepEqual(s.itens.descartar(id), { ok: true });
  assert.equal(s.item(id).status, 'descartado');
});

test('CA2.8: a volta à revisão e a saída da reserva são uma transação só (falha em qualquer passo desfaz os dois)', async (t) => {
  const s = montar();
  const regra = s.regra();
  const id = s.revisao(regra, SHP('1'), ['shopee']);
  const r = await s.itens.enviar(id, {});
  await s.envios.cancelar(r.envio_id);
  const decidido = s.item(id).decidido_em;
  // falha no último passo (a volta do item), depois de apagar a reserva
  s.db.exec("CREATE TRIGGER falha_item BEFORE UPDATE OF status ON catalogo_itens WHEN NEW.status = 'revisao' BEGIN SELECT RAISE(ABORT, 'falhou'); END");
  assert.throws(() => s.itens.liberarFalhos(), /falhou/);
  assert.deepEqual([s.item(id).status, s.item(id).decidido_em, reservas(s, regra, 'SHOPEE:111.1')], ['enviado', decidido, 1], 'nada mudou');
  s.db.exec('DROP TRIGGER falha_item');
  // falha ao apagar a reserva: o item não volta
  s.db.exec("CREATE TRIGGER falha_reserva BEFORE DELETE ON sent_offers BEGIN SELECT RAISE(ABORT, 'falhou'); END");
  assert.throws(() => s.itens.liberarFalhos(), /falhou/);
  assert.equal(s.item(id).status, 'enviado');
  s.db.exec('DROP TRIGGER falha_reserva');
  assert.doesNotThrow(() => s.db.exec('BEGIN IMMEDIATE; COMMIT'), 'nenhuma transação ficou aberta');
  assert.equal(s.itens.liberarFalhos(), 1);
  assert.deepEqual([s.item(id).status, reservas(s, regra, 'SHOPEE:111.1')], ['revisao', 0]);
});

test('CA2.8: "Enviar de novo" de um item enviado que falhou não recebe 409 quando o liberarFalhos o devolve à revisão no meio', async () => {
  const s = montar();
  const regra = s.regra();
  const id = s.revisao(regra, SHP('1'), ['shopee']);
  const r1 = await s.itens.enviar(id, {});
  await s.envios.cancelar(r1.envio_id);
  assert.equal(daLista(s, id).pode_reenviar, true, 'enviado, com o envio que falhou');
  // o "Enviar" espera os links com Sub_id da Shopee; nesse meio tempo o agendador passa e devolve o item à revisão
  let devolvidos = null;
  s.envios.linksRastreioShopee = async () => { devolvidos = s.itens.liberarFalhos(); return {}; };
  const r2 = await s.itens.enviar(id, {});
  assert.equal(devolvidos, 1);
  assert.notEqual(r2.envio_id, r1.envio_id);
  assert.deepEqual([s.item(id).status, s.item(id).envio_id], ['enviado', r2.envio_id]);
  assert.equal(reservas(s, regra, 'SHOPEE:111.1'), 1, 'uma reserva só (a do envio novo)');
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 2);
});

// ------------------------------------------------------------- "Enviar" com o Mercado Livre em espera (etapa 5)

const ML_EM_ESPERA = 'O Mercado Livre está em espera: a Central de Afiliados não está respondendo. O programa testa de novo sozinho; tente de novo quando ela voltar.';

test('E2 etapa 5: "Enviar" de oferta do ML com o Mercado Livre em espera recusa com frase fixa, sem pedido nem gravação', async () => {
  const s = montar({ modo: 'extension' });
  const regra = s.regra({ dedupe_days: 0 }); // vários "Fone Bom": sem a trava de parecidos
  const id = s.revisao(regra, ML(1), ['falhas_repetidas']);
  const pedidos = [];
  const estado = { central: { estado: 'em_espera', falhasSeguidas: 3, testeLiberado: false } };
  s.links.status = () => ({ online: true });
  s.links.central = () => estado.central;
  s.links.requestLink = async (...a) => { pedidos.push(a); return 'https://meli.la/xyz'; };
  s.links.requestProduto = async (...a) => { pedidos.push(a); return {}; };
  await recusa(s.itens.enviar(id, {}), 400, ML_EM_ESPERA);
  // o teste liberado não muda a resposta: o "Enviar" não é o teste da espera
  estado.central = { ...estado.central, testeLiberado: true };
  await recusa(s.itens.enviar(id, {}), 400, ML_EM_ESPERA);
  assert.deepEqual(pedidos, []);
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 0);
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM sent_offers'), 0);
  assert.deepEqual([s.item(id).status, s.item(id).decidido_em], ['revisao', null]);
  assert.equal(s.acordou.n, 0);

  // a Amazon e a Shopee não dependem da Central
  const idS = s.revisao(regra, SHP('1'), ['shopee']);
  assert.ok((await s.itens.enviar(idS, {})).envio_id);
  const idA = s.revisao(regra, AMZ(), ['preco_antigo']);
  assert.ok((await s.itens.enviar(idA, {})).envio_id);

  // os outros estados da Central deixam sair
  for (const e of ['respondendo', 'falhando', 'sem_teste']) {
    estado.central = { estado: e, testeLiberado: false };
    const idM = s.revisao(regra, ML(100 + e.length), ['falhas_repetidas']);
    assert.ok((await s.itens.enviar(idM, {})).envio_id, e);
  }
  assert.deepEqual(pedidos, [], 'o "Enviar" só grava o envio; o link é da fila');
});

test('E2 etapa 5: extensão desconectada e modo direto vêm antes da espera; serviço de links sem central() (ou que lança) não recusa', async (t) => {
  const s = montar({ modo: 'extension' });
  const regra = s.regra({ dedupe_days: 0 });
  const id = s.revisao(regra, ML(1), ['falhas_repetidas']);
  s.links.central = () => ({ estado: 'em_espera' });
  await recusa(s.itens.enviar(id, {}), 400, 'A extensão do Chrome não está conectada: abra o Chrome com a extensão para gerar o link de afiliado.');
  s.estado.modo = 'direct';
  await recusa(s.itens.enviar(id, {}), 400, 'Os links do Mercado Livre estão no modo direto, sem comissão: ofertas do catálogo não saem assim. Volte ao modo da extensão em Ajustes.');
  // modo de simulação: a espera também vale (é o estado que o serviço de links informa)
  s.estado.modo = 'fake';
  await recusa(s.itens.enviar(id, {}), 400, ML_EM_ESPERA);

  // serviço de links de antes da entrega 2: sem central(), o "Enviar" segue como antes
  s.links.central = undefined;
  const r = await s.itens.enviar(id, {});
  assert.ok(r.envio_id);

  // central() que lança não derruba o "Enviar" (a fila de envios ainda passa pela espera ao pedir o link)
  const erros = [];
  t.mock.method(console, 'error', (...a) => { erros.push(a.map(String).join(' ')); });
  const id2 = s.revisao(regra, ML(2), ['falhas_repetidas']);
  s.links.central = () => { throw new Error('estado 5511999990000'); };
  assert.ok((await s.itens.enviar(id2, {})).envio_id);
  assert.equal(erros.length, 1);
  assert.doesNotMatch(erros[0], /5511999990000/);
});

test('R5: no "Revisar oferta" o cupom vai até 100 caracteres (o do espelho segue 30)', async () => {
  const s = montar();
  const regra = s.regra();
  const id = s.revisao(regra, SHP('1'), ['shopee']);
  await recusa(s.itens.enviar(id, { ajustes: { coupon: 'C'.repeat(101) } }), 400, 'O cupom passa de 100 caracteres.');
  const r = await s.itens.enviar(id, { ajustes: { coupon: 'C'.repeat(100) } });
  assert.equal(s.envio(r.envio_id).payload.offer.coupon, 'C'.repeat(100));
});

test('R12: paginação de listar por antes=<ts>:<id> e proximo, na ordem da lista; parâmetro ruim é 400', () => {
  const s = montar();
  const regra = s.regra();
  const t0 = s.relogio.t;
  const ids = [];
  for (let i = 0; i < 5; i++) { s.relogio.t = t0 + (i < 3 ? 0 : i); ids.push(s.revisao(regra, ML(100 + i), ['falha_link'])); } // 3 com o mesmo instante
  const ordem = [ids[4], ids[3], ids[2], ids[1], ids[0]];
  const p1 = s.itens.listar({ limite: 2 });
  assert.deepEqual(p1.itens.map((i) => i.id), ordem.slice(0, 2));
  assert.equal(p1.proximo, `${t0 + 3}:${ids[3]}`);
  const p2 = s.itens.listar({ limite: 2, antes: p1.proximo });
  assert.deepEqual(p2.itens.map((i) => i.id), ordem.slice(2, 4), 'empate no instante: desempata pelo id');
  const p3 = s.itens.listar({ limite: 2, antes: p2.proximo });
  assert.deepEqual([p3.itens.map((i) => i.id), p3.proximo], [ordem.slice(4), null]);
  assert.equal(s.itens.listar({ limite: 5 }).proximo, null, 'cabe tudo: sem próxima');
  assert.equal(p2.contadores_24h.para_revisar, 5, 'os contadores não seguem a página');
  for (const ruim of ['x', '1:', ':1', '1:2:3', '-1:2', `${'9'.repeat(17)}:1`, ['1:2', '3:4']]) {
    assert.throws(() => s.itens.listar({ antes: ruim }), { status: 400, message: 'Paginação inválida: use antes=<instante>:<id>.' }, String(ruim));
  }
  assert.deepEqual(s.itens.listar({ antes: '' }).itens.length, 5, 'vazio = do começo');
});

test('R10: a listagem por regra e status usa o índice idx_cat_lista', () => {
  const s = montar();
  const plano = s.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM catalogo_itens i WHERE i.rule_id = ? AND i.status = ?
    ORDER BY COALESCE(i.decidido_em, i.criado_em) DESC, i.id DESC LIMIT 10`).all(1, 'revisao').map((l) => l.detail).join(' | ');
  assert.match(plano, /idx_cat_lista/);
  assert.doesNotMatch(plano, /TEMP B-TREE/, 'a ordem vem do índice');
});

test('R9: os validadores de ajustes do espelho, exportados, seguem iguais no espelho (ErroEspelho, cupom 30) e servem ao catálogo com o erro dele', async () => {
  const espelho = async (a, op) => { try { return await validarAjustesOferta(a, op); } catch (e) { return [e.constructor.name, e.status, e.message]; } };
  assert.deepEqual(await espelho({ coupon: 'C'.repeat(31) }), ['ErroEspelho', 400, 'O cupom passa de 30 caracteres.']);
  assert.deepEqual(await espelho({ price: '1.299,90', oldPrice: 'R$ 2.000', title: '  Fone   Bom ', coupon: '', freeShipping: true, sem_foto: true }),
    { price: 1299.9, oldPrice: 2000, title: 'Fone Bom', coupon: null, freeShipping: true, sem_foto: true });
  assert.deepEqual(await espelho({ upload: `${'a'.repeat(32)}.png` }), ['ErroEspelho', 400, 'A foto não foi encontrada. Envie de novo.'], 'sem lerFoto');
  assert.deepEqual(await espelho({ upload: `${'a'.repeat(32)}.png` }, { lerFoto: async () => true }), { upload: `${'a'.repeat(32)}.png` });
  assert.deepEqual(await espelho(null), {});
  assert.throws(() => lerPrecoDigitado('abc', 'Preço atual'), (e) => e instanceof ErroEspelho && e.message === 'Preço atual inválido: use só números, como 89,90.');
  assert.throws(() => lerTextoCurto(5, 'título', 10), (e) => e instanceof ErroEspelho && e.message === 'O título precisa ser texto.');
  const erro = (m) => new ErroCatalogoItem(400, m);
  assert.deepEqual(await espelho({ coupon: 'C'.repeat(101) }, { maxCupom: 100, erro }), ['ErroCatalogoItem', 400, 'O cupom passa de 100 caracteres.']);
});

// ------------------------------------------------------------------------------------------------ rastreio (dashboard-ganhos, etapa 7)

/** Shopee falsa com a API útil: um link por Sub_id, guardando cada gerarLink. */
function shopeeApi() {
  const chamadas = [];
  return {
    chamadas, apiUtil: () => true, linkGuardado: () => null, guardarLink: () => true,
    async gerarLink(u, op) { chamadas.push([u, op?.subId ?? null]); return op?.subId ? `https://s.shopee.com.br/Sub${op.subId}` : 'https://s.shopee.com.br/BaseDaApi'; },
  };
}
const rastreados = (db, envioId) => db.prepare(`SELECT jid, loja, origem, rule_id, envio_id, oferta_chave, link, codigo, nivel, bloco_id, esperado, motivo
  FROM rastreio_envios WHERE envio_id = ? ORDER BY id`).all(envioId).map((l) => ({ ...l }));

test('CA2/CA1: catálogo Shopee — base = link do Etiqueta; Sub_id do bloco gera links_rastreio no "Enviar"; uma linha de rastreio por grupo', async () => {
  const shopee = shopeeApi();
  const s = montar({ shopee });
  s.db.prepare("INSERT INTO conexoes (plataforma, config, segredos) VALUES ('shopee', ?, '{}')").run(JSON.stringify({ id_afiliado: '98765432101' }));
  s.db.prepare('INSERT INTO blocks (id, name, created_at) VALUES (1, ?, 1)').run('B1');
  s.db.prepare("INSERT INTO block_groups (block_id, jid) VALUES (1, '111@g.us')").run();
  rastreio.salvar(s.db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: '1', codigo: 'b1' });
  const regra = s.regra();
  const id = s.revisao(regra, SHP('1'), ['shopee']);
  const r = await s.itens.enviar(id, {});
  const p = s.envio(r.envio_id).payload;
  assert.equal(p.link_afiliado, LINK_SHOPEE_OK, 'o link do catálogo continua sendo o base');
  assert.deepEqual(p.links_rastreio, {
    '111@g.us': { link: 'https://s.shopee.com.br/Subb1', codigo: 'b1', nivel: 'bloco', bloco_id: 1, esperado: 1, motivo: null },
    '222@g.us': { link: LINK_SHOPEE_OK, codigo: null, nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null },
  });
  assert.deepEqual(shopee.chamadas, [['https://shopee.com.br/product/111/1', 'b1']], 'só o Sub_id foi pedido; o base é o do Etiqueta');
  await s.envios.runEnvio(r.envio_id);
  assert.deepEqual(s.enviados().map((m) => [m.jid, /Compre aqui: (\S+)$/.exec(m.text)?.[1]]), [['111@g.us', 'https://s.shopee.com.br/Subb1'], ['222@g.us', LINK_SHOPEE_OK]]);
  const comum = { loja: 'shopee', origem: 'catalogo', rule_id: regra.id, envio_id: r.envio_id, oferta_chave: 'SHOPEE:111.1' };
  assert.deepEqual(rastreados(s.db, r.envio_id), [
    { jid: '111@g.us', ...comum, link: 'https://s.shopee.com.br/Subb1', codigo: 'b1', nivel: 'bloco', bloco_id: 1, esperado: 1, motivo: null },
    { jid: '222@g.us', ...comum, link: LINK_SHOPEE_OK, codigo: null, nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null },
  ]);

  // CA9: sem associação, o payload é o de antes (sem links_rastreio) e nenhum link é pedido
  s.db.prepare('DELETE FROM rastreio_codigos').run();
  const id2 = s.revisao(regra, SHP('2'), ['shopee']);
  const r2 = await s.itens.enviar(id2, {});
  assert.equal(Object.hasOwn(s.envio(r2.envio_id).payload, 'links_rastreio'), false);
  assert.equal(shopee.chamadas.length, 1);
});

test('CA1/CA4: catálogo ML registra origem "catalogo" com a regra; a etiqueta associada ao grupo vence a da fonte (P1)', async () => {
  const s = montar();
  rastreio.salvar(s.db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaA' });
  const regra = s.regra();
  const id = s.revisao(regra, ML(1234567890, { tag_id: 2 }), ['falha_link']);
  const r = await s.itens.enviar(id, {});
  await s.envios.runEnvio(r.envio_id);
  assert.deepEqual(s.enviados().map((m) => [m.jid, /fake-(\w+)-/.exec(m.text)?.[1]]), [['111@g.us', 'etiquetaB'], ['222@g.us', 'etiquetaA']]);
  assert.deepEqual(rastreados(s.db, r.envio_id).map((l) => [l.jid, l.origem, l.rule_id, l.oferta_chave, l.codigo, l.nivel, l.esperado]), [
    ['111@g.us', 'catalogo', regra.id, 'MLB1234567890', 'etiquetaB', 'padrao', 0],
    ['222@g.us', 'catalogo', regra.id, 'MLB1234567890', 'etiquetaA', 'grupo', 1],
  ]);
});

test('catálogo Shopee com a fila de envios sem linksRastreioShopee (embrulho do servidor): sai com o base; a associação conta como não rastreada', async () => {
  const s = montar();
  s.db.prepare('INSERT INTO blocks (id, name, created_at) VALUES (1, ?, 1)').run('B1');
  s.db.prepare("INSERT INTO block_groups (block_id, jid) VALUES (1, '111@g.us')").run();
  rastreio.salvar(s.db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: '1', codigo: 'b1' });
  const itens = createCatalogoItens({ db: s.db, wa: s.wa, links: s.links, amazon: s.amazon, envios: { lerFoto: (u) => s.envios.lerFoto(u), processarPendentes: async () => 0 }, acordar: () => {}, agora: () => s.relogio.t });
  const regra = s.regra();
  assert.equal(itens.registrar(regra, SHP('1'), 'revisao', ['shopee']), true);
  const id = s.db.prepare('SELECT id FROM catalogo_itens WHERE rule_id = ?').get(regra.id).id;
  const r = await itens.enviar(id, {});
  assert.equal(Object.hasOwn(s.envio(r.envio_id).payload, 'links_rastreio'), false);
  await s.envios.runEnvio(r.envio_id);
  assert.ok(s.enviados().every((m) => m.text.endsWith(LINK_SHOPEE_OK)));
  assert.deepEqual(rastreados(s.db, r.envio_id).map((l) => [l.jid, l.nivel, l.esperado, l.motivo]), [['111@g.us', 'nenhum', 1, 'sem_link_rastreio'], ['222@g.us', 'padrao', 0, null]]);
});

// ------------------------------------------------------------------------------------------------ produto parecido
// Plano nao-repetir-produto-parecido, etapa 5 (CA4–CA8): o "Enviar" passa pela trava de src/parecido.js dentro da
// transação. Títulos com 3+ palavras significativas (os das fixtures acima têm 1 ou 2 e não entram na comparação).

const HORA = 3600000;
const AREIA_FINA = 'Areia Sanitária Pipicat Fina 12kg';
const AREIA_MISTA = 'Areia Sanitária Pipicat Mista 12kg';   // 4 de 5 palavras em comum com a fina: parecida
const RACAO = 'Ração Golden Gatos Castrados 10kg';          // nada em comum: outro produto
const AREIA_FINA_2 = 'AREIA SANITÁRIA PIPICAT FINA (12KG)';    // a mesma sequência da fina: o mesmo produto
const FRASE_INICIO = `${FRASE_MAIS_BARATA}\n\n`;

/** Envio anterior da regra em `sent_offers` (como a regra ou o "Enviar" gravam): `preco` em centavos, `ha` em ms. */
const jaSaiu = (s, regra, { key, title, preco, ha }) => s.db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)')
  .run(regra.id, key, s.relogio.t - ha, title, preco);
const naoEnviada = (s, anterior, tipo = 'parecido') => textoConflito({ acao: 'barrar', tipo, anterior }, s.relogio.t, { prefixo: 'Não enviada' });
/** Barrada: 409 com a frase, nada gravado (item na revisão, nenhum envio, reservas e Histórico iguais, fila quieta). */
async function barrada(s, id, corpo, mensagem) {
  const antes = { reservas: s.contar('SELECT COUNT(*) AS n FROM sent_offers'), logs: s.logs().length, acordou: s.acordou.n, oferta: s.item(id).oferta };
  await recusa(s.itens.enviar(id, corpo), 409, mensagem);
  assert.deepEqual([s.item(id).status, s.item(id).envio_id, s.item(id).decidido_em, s.item(id).oferta], ['revisao', null, null, antes.oferta]);
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 0);
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM sent_offers'), antes.reservas);
  assert.equal(s.logs().length, antes.logs);
  assert.equal(s.acordou.n, antes.acordou);
}
const reserva = (s, regra, chave) => ({ ...s.db.prepare('SELECT title, price_cents, sent_at FROM sent_offers WHERE rule_id = ? AND offer_key = ? ORDER BY id DESC').get(regra.id, chave) });

test('parecido CA2/CA4/CA6: parecida há 3 h com qualquer preço, ou o mesmo título com outra chave sem os 5% a menos, recebe 409 com o porquê e nada é gravado', async () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  jaSaiu(s, regra, { key: 'MLB1001', title: AREIA_FINA, preco: 4990, ha: 3 * HORA });
  const anterior = { title: AREIA_FINA, preco: 4990, sent_at: s.relogio.t - 3 * HORA };

  const igual = s.revisao(regra, ML(1002, { title: AREIA_MISTA, price: 49.9 }), ['falha_link']);
  const frase = naoEnviada(s, anterior);
  assert.match(frase, /^Não enviada: parecida com "Areia Sanitária Pipicat Fina 12kg", que saiu por este disparo às \d\d:\d\d( de \d\d\/\d\d)? por R\$ 49,90\. Ofertas parecidas esperam 24 h\.$/);
  await barrada(s, igual, {}, frase);

  const cara = s.revisao(regra, ML(1003, { title: AREIA_MISTA, price: 59.9 }), ['falha_link']);
  await barrada(s, cara, {}, frase);

  // D10: a parecida não tem exceção de preço, nem bem mais barata
  const barata = s.revisao(regra, ML(1009, { title: AREIA_MISTA, price: 19.9 }), ['falha_link']);
  await barrada(s, barata, {}, frase);

  const mesmo = s.revisao(regra, ML(1004, { title: AREIA_FINA, price: 49.9 }), ['falha_link']);
  const fraseMesmo = naoEnviada(s, anterior, 'mesmo');
  assert.match(fraseMesmo, /^Não enviada: o mesmo produto saiu por este disparo às .+ por R\$ 49,90, com outro código \("Areia Sanitária Pipicat Fina 12kg"\)\. Só sai de novo se estiver pelo menos 5% mais barato\.$/);
  await barrada(s, mesmo, {}, fraseMesmo);
  // R$ 47,41 não chega aos 5% de R$ 49,90 (o limite é R$ 47,40)
  const quase = s.revisao(regra, ML(1010, { title: AREIA_FINA_2, price: 47.41 }), ['falha_link']);
  await barrada(s, quase, {}, fraseMesmo);

  // pela rota: o 409 leva a frase (o painel fecha o diálogo e mostra a mensagem)
  const h = await subirRotas(s);
  try {
    const r = await h.pedir(`/api/catalogo/itens/${igual}/enviar`, 'dono', { method: 'POST', body: {} });
    assert.deepEqual([r.status, r.json], [409, { erro: frase }]);
  } finally { await h.fechar(); }

  // outro produto, mesmo com 3+ palavras, sai sem a marca (e a reserva guarda título e preço)
  const outro = s.revisao(regra, ML(1005, { title: RACAO, price: 120 }), ['falha_link']);
  const r = await s.itens.enviar(outro, {});
  assert.equal(Object.hasOwn(s.envio(r.envio_id).payload, 'mais_barata'), false);
  assert.deepEqual(reserva(s, regra, 'MLB1005'), { title: RACAO, price_cents: 12000, sent_at: s.relogio.t });
  assert.equal(s.logs().length, 0, 'nada no Histórico antes da fila');
});

test('parecido CA4/CA5/CA6: o mesmo título 5% abaixo do menor preço dele sai com a marca no payload, a frase na mensagem e, quando sai, a linha no Histórico', async () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  jaSaiu(s, regra, { key: 'MLB1001', title: AREIA_FINA, preco: 5990, ha: 5 * HORA });
  jaSaiu(s, regra, { key: 'MLB1006', title: AREIA_FINA_2, preco: 4990, ha: 3 * HORA });
  const doMinimo = { title: AREIA_FINA_2, preco: 4990, sent_at: s.relogio.t - 3 * HORA };

  // 5% abaixo de R$ 59,90 mas não da menor (R$ 49,90; limite R$ 47,40): barra citando a do mínimo
  const meio = s.revisao(regra, ML(1007, { title: AREIA_FINA, price: 54.9 }), ['falha_link']);
  await barrada(s, meio, {}, naoEnviada(s, doMinimo, 'mesmo'));
  const umCentavo = s.revisao(regra, ML(1011, { title: AREIA_FINA, price: 49.89 }), ['falha_link']);
  await barrada(s, umCentavo, {}, naoEnviada(s, doMinimo, 'mesmo'));

  const id = s.revisao(regra, ML(1002, { title: AREIA_FINA, price: 47.4 }), ['falha_link']);
  const r = await s.itens.enviar(id, {});
  const e = s.envio(r.envio_id);
  assert.deepEqual(e.payload.mais_barata, { preco_anterior: 4990 }, 'a marca da fila não muda (falha fechada)');
  assert.deepEqual(e.payload.parecida_anterior, { titulo: doMinimo.title, enviada_em: doMinimo.sent_at }, 'só para o texto do Histórico');
  assert.equal(e.payload.offer.price, 47.4);
  assert.deepEqual(reserva(s, regra, 'MLB1002'), { title: AREIA_FINA, price_cents: 4740, sent_at: s.relogio.t });
  assert.equal(s.item(id).status, 'enviado');
  assert.equal(s.acordou.n, 1);
  assert.deepEqual(s.logs(), [], 'R5/Q3: o clique não diz que saiu; quem diz é a fila, depois de mandar');

  // a fila (WhatsApp simulado) manda a mensagem com a frase na primeira linha, com a foto
  await s.envios.runEnvio(r.envio_id);
  assert.equal(s.envio(r.envio_id).status, 'concluido');
  const linhas = s.logs().filter((l) => l.level === 'info');
  assert.deepEqual(linhas, [{ rule_id: null, rule_name: 'Catálogo: Perfumes do catálogo', level: 'info', group_name: null, offer_title: AREIA_FINA,
    message: textoPassou(doMinimo, 47.4, Date.now()) }], 'uma linha só, depois dos dois grupos');
  assert.match(linhas[0].message, /^Saiu como oportunidade melhor: o mesmo produto saiu às \d\d:\d\d por R\$ 49,90 \("AREIA SANITÁRIA PIPICAT FINA \(12KG\)"\); agora por R\$ 47,40\.$/);
  assert.doesNotMatch(JSON.stringify(linhas), /@g\.us|@s\.whatsapp|Achadinhos|Tech/, 'sem JID nem nome de grupo');
  assert.deepEqual(s.logs().map((l) => l.level), ['ok', 'ok', 'info'], 'a linha vem depois das linhas de envio');
  const msgs = s.enviados();
  assert.equal(msgs.length, 2);
  for (const m of msgs) {
    assert.ok(m.text.startsWith(FRASE_INICIO), m.text);
    assert.match(m.text.slice(FRASE_INICIO.length), /^\*Areia Sanitária Pipicat Fina 12kg\*/);
    assert.equal(m.image, IMG_ML);
  }

  // sem foto (ajuste "sem foto"): a frase também vai no texto
  const semFoto = s.revisao(regra, ML(1008, { title: 'Areia Sanitária Pipicat Fina 12kg Original', price: 39.9 }), ['falha_link']);
  const r2 = await s.itens.enviar(semFoto, { ajustes: { sem_foto: true } });
  assert.deepEqual(s.envio(r2.envio_id).payload.mais_barata, { preco_anterior: 4740 }, 'a menor agora é a que acabou de sair');
  await s.envios.runEnvio(r2.envio_id);
  const novas = s.enviados().slice(2);
  assert.equal(novas.length, 2);
  for (const m of novas) { assert.ok(m.text.startsWith(FRASE_INICIO)); assert.equal(m.image, undefined); }
});

test('parecido CA4: anterior sem preço guardado barra (nada a comparar), mesmo com a candidata bem mais barata', async () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  jaSaiu(s, regra, { key: 'MLB1001', title: AREIA_FINA, preco: null, ha: 2 * HORA });
  const id = s.revisao(regra, ML(1002, { title: AREIA_FINA_2, price: 19.9 }), ['falha_link']);
  const frase = naoEnviada(s, { title: AREIA_FINA, preco: null, sent_at: s.relogio.t - 2 * HORA }, 'mesmo');
  assert.match(frase, /^Não enviada: o mesmo produto saiu por este disparo às .+ sem preço guardado para comparar, com outro código /);
  await barrada(s, id, {}, frase);
});

test('parecido CA4: o preço comparado é o ajustado no "Revisar oferta"', async () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  jaSaiu(s, regra, { key: 'MLB1001', title: AREIA_FINA, preco: 4990, ha: 3 * HORA });
  const anterior = { title: AREIA_FINA, preco: 4990, sent_at: s.relogio.t - 3 * HORA };
  // guardada mais barata, ajustada para mais cara: barra
  const subiu = s.revisao(regra, ML(1002, { title: AREIA_FINA_2, price: 39.9 }), ['falha_link']);
  await barrada(s, subiu, { ajustes: { price: '55,00' } }, naoEnviada(s, anterior, 'mesmo'));
  // título ajustado para outro produto: não é mais o mesmo
  const r0 = await s.itens.enviar(subiu, { ajustes: { title: RACAO, price: '55,00' } });
  assert.equal(Object.hasOwn(s.envio(r0.envio_id).payload, 'mais_barata'), false);
  // guardada mais cara, ajustada para mais barata: sai com a marca e o preço ajustado
  const caiu = s.revisao(regra, ML(1003, { title: AREIA_FINA_2, price: 59.9 }), ['falha_link']);
  const r = await s.itens.enviar(caiu, { ajustes: { price: '45,00' } });
  const e = s.envio(r.envio_id);
  assert.deepEqual([e.payload.mais_barata, e.payload.offer.price], [{ preco_anterior: 4990 }, 45]);
  assert.equal(reserva(s, regra, 'MLB1003').price_cents, 4500);
});

test('parecido CA2/CA8: 25 h depois a parecida sai sem frase; o mesmo título segue barrado até "dias sem repetir"; com 0 dias sai sem frase', async () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 3 });
  jaSaiu(s, regra, { key: 'MLB1001', title: AREIA_FINA, preco: 4990, ha: 25 * HORA });
  const parecida = s.revisao(regra, ML(1002, { title: AREIA_MISTA, price: 59.9 }), ['falha_link']);
  const r = await s.itens.enviar(parecida, {});
  assert.equal(Object.hasOwn(s.envio(r.envio_id).payload, 'mais_barata'), false);
  await s.envios.runEnvio(r.envio_id);
  assert.equal(s.enviados().length, 2);
  for (const m of s.enviados()) assert.ok(!m.text.includes(FRASE_MAIS_BARATA), 'nenhuma outra mensagem leva a frase');
  assert.equal(s.logs().some((l) => l.level === 'info'), false);

  // a parecida acabou de sair: barraria o mesmo título como parecida (D10). Mais 25 h, só o mesmo título conta
  s.relogio.t += 25 * HORA;
  const mesmo = s.revisao(regra, ML(1003, { title: AREIA_FINA, price: 59.9 }), ['falha_link']);
  await recusa(s.itens.enviar(mesmo, {}), 409, naoEnviada(s, { title: AREIA_FINA, preco: 4990, sent_at: s.relogio.t - 50 * HORA }, 'mesmo'));

  // "dias sem repetir" = 0: a trava entre rodadas fica desligada, como a da chave exata
  const zero = s.regra({ name: 'Sem janela', dedupe_days: 0 });
  jaSaiu(s, zero, { key: 'MLB1001', title: AREIA_FINA, preco: 4990, ha: 1 * HORA });
  const z = s.revisao(zero, ML(1003, { title: AREIA_FINA, price: 59.9 }), ['falha_link']);
  const rz = await s.itens.enviar(z, {});
  assert.equal(Object.hasOwn(s.envio(rz.envio_id).payload, 'mais_barata'), false);
  assert.deepEqual(reserva(s, zero, 'MLB1003'), { title: AREIA_FINA, price_cents: 5990, sent_at: s.relogio.t });
});

test('parecido: parecida de outra regra não barra', async () => {
  const s = montar();
  const outra = s.regra({ name: 'Pets', dedupe_days: 7 });
  const regra = s.regra({ dedupe_days: 7 });
  jaSaiu(s, outra, { key: 'MLB1001', title: AREIA_FINA, preco: 4990, ha: 1 * HORA });
  const id = s.revisao(regra, ML(1002, { title: AREIA_MISTA, price: 59.9 }), ['falha_link']);
  const r = await s.itens.enviar(id, {});
  assert.equal(Object.hasOwn(s.envio(r.envio_id).payload, 'mais_barata'), false);
});

test('parecido R3/CA8: o "Enviar de novo" do item que falhou não se barra na própria reserva', async () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  const id = s.revisao(regra, ML(1002, { title: AREIA_MISTA, price: 49.9 }), ['falha_link']);
  quebrarWhatsApp(s);
  const r1 = await s.itens.enviar(id, {});
  await s.envios.runEnvio(r1.envio_id);
  quebrarWhatsApp(s, false);
  assert.equal(daLista(s, id).pode_reenviar, true);
  assert.equal(reservas(s, regra, 'MLB1002'), 1, 'a reserva do envio que falhou ainda está lá (liberarFalhos não rodou)');
  s.relogio.t += HORA;
  const r2 = await s.itens.enviar(id, {});
  assert.equal(Object.hasOwn(s.envio(r2.envio_id).payload, 'mais_barata'), false);
  assert.equal(reservas(s, regra, 'MLB1002'), 1, 'uma reserva só (a do envio novo)');
  assert.deepEqual(reserva(s, regra, 'MLB1002'), { title: AREIA_MISTA, price_cents: 4990, sent_at: s.relogio.t });
});

test('parecido: dois "Enviar" de parecidas ao mesmo tempo, com o mesmo preço, geram um envio só; a outra recebe "Não enviada"', async () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  const a = s.revisao(regra, ML(1001, { title: AREIA_FINA, price: 49.9 }), ['falha_link']);
  const b = s.revisao(regra, ML(1002, { title: AREIA_MISTA, price: 49.9 }), ['falha_link']);
  const r = await Promise.allSettled([s.itens.enviar(a, {}), s.itens.enviar(b, {})]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  const erro = r.find((x) => x.status === 'rejected').reason;
  assert.equal(erro.status, 409);
  assert.match(erro.message, /^Não enviada: parecida com "Areia Sanitária Pipicat (Fina|Mista) 12kg", que saiu por este disparo às \d\d:\d\d por R\$ 49,90\./);
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM envios'), 1);
  assert.equal(s.contar('SELECT COUNT(*) AS n FROM sent_offers'), 1);
  assert.deepEqual([s.item(a).status, s.item(b).status].sort(), ['enviado', 'revisao']);
});

// Achado Q1: a execução da regra em andamento só grava a reserva depois de mandar aos grupos; o agendador entrega as
// ofertas que ela escolheu por usarEmEnvio e o "Enviar" as trata como a mesma rodada (barra sempre)
const saindoAgora = (titulo) => `Não enviada: parecida com "${titulo}", que está saindo agora por este disparo. Tente de novo em alguns minutos.`;

test('parecido Q1: parecida com uma oferta que a regra está mandando agora recebe 409, mesmo mais barata e com 0 dias; nada é gravado', async () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  const sem = s.regra({ name: 'Sem repetir', dedupe_days: 0 });
  const pedidos = [];
  s.itens.usarEmEnvio((ruleId) => { pedidos.push(ruleId); return ruleId === regra.id || ruleId === sem.id ? [{ key: 'MLB1001', title: AREIA_FINA }] : []; });
  // a mais barata não passa: a que está saindo não tem preço a comparar (como a escolhida da mesma rodada)
  const id = s.revisao(regra, ML(1002, { title: AREIA_MISTA, price: 19.9 }), ['falha_link']);
  await barrada(s, id, {}, saindoAgora(AREIA_FINA));
  assert.equal(saindoAgora(AREIA_FINA), naoEnviada(s, { title: AREIA_FINA, preco: null, sent_at: null }, 'saindo'), 'a frase é a de src/parecido.js');
  const idSem = s.revisao(sem, ML(1003, { title: AREIA_MISTA, price: 59.9 }), ['falha_link']);
  await barrada(s, idSem, {}, saindoAgora(AREIA_FINA));
  assert.deepEqual(pedidos, [regra.id, sem.id], 'consulta a lista da regra do item');
});

test('parecido Q1: com ofertas saindo agora, outro produto e o item de outra regra saem; o título ajustado vale; a mesma chave recebe 409', async () => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  const outra = s.regra({ name: 'Pets', dedupe_days: 7 });
  s.itens.usarEmEnvio((ruleId) => (ruleId === regra.id ? [{ key: 'MLB1001', title: AREIA_FINA }, { key: 'MLB1009', title: 'x' }, null, { key: 'MLB1008' }] : []));
  // a própria oferta que a regra está mandando (ponto "mesma chave" da seguranca): sairia duas vezes. Vale a chave, não o
  // título (aqui ajustado para outro produto); nada é gravado
  const mesma = s.revisao(regra, ML(1001, { title: RACAO, price: 89.9 }), ['falha_link']);
  await barrada(s, mesma, {}, saindoAgora(AREIA_FINA));
  assert.equal(reservas(s, regra, 'MLB1001'), 0);
  const racao = s.revisao(regra, ML(1004, { title: RACAO, price: 89.9 }), ['falha_link']);
  assert.ok((await s.itens.enviar(racao, {})).envio_id, 'outro produto sai');
  const deOutra = s.revisao(outra, ML(1002, { title: AREIA_MISTA, price: 49.9 }), ['falha_link']);
  assert.ok((await s.itens.enviar(deOutra, {})).envio_id, 'a lista é por regra');
  const ajustada = s.revisao(regra, ML(1005, { title: AREIA_MISTA, price: 49.9 }), ['falha_link']);
  assert.ok((await s.itens.enviar(ajustada, { ajustes: { title: RACAO } })).envio_id, 'o título ajustado não é parecido');
});

test('parecido Q1: a lista que lança ou fora do formato não derruba o "Enviar" (só o nome do erro no console); usarEmEnvio(null) desliga', async (t) => {
  const s = montar();
  const regra = s.regra({ dedupe_days: 7 });
  const erros = t.mock.method(console, 'error', () => {});
  s.itens.usarEmEnvio(() => { throw new Error('lista com Fulano 11 99999-0000'); });
  const a = s.revisao(regra, ML(1002, { title: AREIA_MISTA, price: 49.9 }), ['falha_link']);
  assert.ok((await s.itens.enviar(a, {})).envio_id);
  assert.deepEqual(erros.mock.calls.map((c) => c.arguments.join(' ')), ['[catalogo] ofertas em envio: Error']);
  s.itens.usarEmEnvio(() => 'não é lista');
  const b = s.revisao(regra, ML(1004, { title: RACAO, price: 89.9 }), ['falha_link']);
  assert.ok((await s.itens.enviar(b, {})).envio_id);
  const nova = s.regra({ name: 'Nova', dedupe_days: 7 });
  s.itens.usarEmEnvio(() => [{ key: 'MLB1001', title: AREIA_FINA }]);
  s.itens.usarEmEnvio(null);
  const c = s.revisao(nova, ML(1002, { title: AREIA_MISTA, price: 49.9 }), ['falha_link']);
  assert.ok((await s.itens.enviar(c, {})).envio_id, 'sem a lista, nada está saindo');
});

test('nenhum acesso à rede nos testes deste arquivo', () => {
  assert.equal(acessosRede, 0);
});
