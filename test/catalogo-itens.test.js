// Fonte "catalogo": registro do que foi tratado e fila de revisão (plano fonte-catalogo-etiqueta, etapa 2; CA1, CA4,
// CA7; decisões P4, P5 e P6 do dono). createCatalogoItens direto, com a fila de envios real (createEnvios), o
// WhatsApp em dryRun (o que "sai" fica em wa.simulated), links em modo trocável e a Amazon de verdade sem
// credencial (montarLink não usa rede). O fetch global fica bloqueado e o último teste prova que ninguém o chamou.
// As rotas são montadas num Express mínimo (a ligação ao server.js é a etapa 5), com o soDono real de src/auth.js.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { openDb } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createEnvios } from '../src/envios.js';
import { createAmazon } from '../src/amazon.js';
import { soDono } from '../src/auth.js';
import { createCatalogoItens, montarRotas, ErroCatalogoItem, TETO_REVISAO, MOTIVOS, lerChave, precoSuspeito } from '../src/catalogo-itens.js';
import { validarAjustesOferta, lerPrecoDigitado, lerTextoCurto, ErroEspelho } from '../src/espelho.js';
import * as rastreio from '../src/rastreio.js';

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
  assert.deepEqual([...MOTIVOS], ['shopee', 'desconto_100', 'preco_antigo', 'falha_link', 'nao_conferido'], 'os nomes da spec e do plano do verificador');
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
    envio_id: null, envio_status: null, pode_reenviar: false, criado_em: s.relogio.t - 30, decidido_em: null,
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
  assert.equal(s.itens.tratada(regra, SHP('1'), 'relevancia'), false, 'nas outras ordens a regra pode trazer de novo');
  assert.equal(s.itens.tratada(regra, SHP('1'), 'atualizacao'), true, 'em Novidades, o caminho é o "Enviar de novo"');
  assert.throws(() => s.itens.descartar(id), { status: 409, message: JA_TRATADA });

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
  // enviada sozinha pela regra (sem envio da fila): nunca reenvia
  assert.equal(s.itens.registrar(regra, SHP('3'), 'enviado'), true);
  const idC = s.db.prepare("SELECT id FROM catalogo_itens WHERE chave = 'SHOPEE:111.3'").get().id;
  assert.equal(daLista(s, idC).pode_reenviar, false);
  await recusa(s.itens.enviar(idC, {}), 409, JA_TRATADA);
  // o envio que falhou foi apagado pela retenção: não se sabe mais, não reenvia
  s.db.prepare('DELETE FROM envios WHERE id = ?').run(rB.envio_id);
  assert.equal(daLista(s, idB).pode_reenviar, false);
  await recusa(s.itens.enviar(idB, {}), 409, JA_TRATADA);
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

test('nenhum acesso à rede nos testes deste arquivo', () => {
  assert.equal(acessosRede, 0);
});
