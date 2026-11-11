// Verificador de preço e estoque, etapa 6 (docs/produto/planos/verificador-preco-estoque.md; CA1–CA5): a fila de
// envios (src/envios.js) confere a oferta no preparar('oferta'), depois das checagens sem rede e antes de pedir o link.
// Disparo manual (agora e agendado) pelo criar; espelho, catálogo, remetente e Shopee com o payload gravado direto,
// como os módulos gravam. O verificador é o de verdade (src/verificador.js) com leitores falsos por loja e um espião
// em volta do conferir; WhatsApp simulado, links meli.la/fake-… com espião no requestLink e o fetch global bloqueado
// (o último teste prova que ninguém o chamou).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSetting } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createEnvios, SEM_CONFERENCIA_AGENDADO } from '../src/envios.js';
import { createMagalu } from '../src/magalu.js';
import { createEspelho } from '../src/espelho.js';
import { createVerificador, MOTIVOS_VERIFICADOR } from '../src/verificador.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-verif-env-')); pastas.push(p); return p; };

const MIN = 60 * 1000;
// 14h32 no fuso local: o {HORA_PRECO} usa a hora local, então o texto é "14h32" em qualquer TZ
const T_1432 = new Date(2026, 0, 15, 14, 32).getTime();
const URL_ML = 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM';
const URL_ML_PRODUTO = 'https://produto.mercadolivre.com.br/MLB-1234567890';
const IMG = 'https://http2.mlstatic.com/D_NQ_NP_123-O.jpg';
const ASIN = 'B0FG2MD49G';
const URL_AMAZON = `https://www.amazon.com.br/dp/${ASIN}`;
const SHOP = '52377417';
const ITEM = '6309028319';
const G1 = '111@g.us';
const G2 = '222@g.us';
const CORPO = '{TITULO_PRODUTO}\nPor {PRECO_PRODUTO}[ (de {PRECO_ANTIGO})][ {DESCONTO_PRODUTO} OFF]\n[🕒 Preço visto às {HORA_PRECO}]\n{LINK}';

/** ml falso: a leitura do Disparo manual (resolveOffer) e a conferência (conferirProduto), sem rede. */
function mlFalso() {
  const estado = { leitura: { price: 89.9, disponivel: true }, falha: null };
  const conferencias = [];
  return {
    estado, conferencias,
    async resolveOffer(c) {
      return { key: c.key, url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: true, image: IMG };
    },
    async conferirProduto(url) {
      conferencias.push(url);
      if (estado.falha) throw estado.falha;
      return { ...estado.leitura };
    },
  };
}

/** Cliente da Amazon falso: tag salva, ASIN resolvido sem rede; `leitura` é o que a leitura `fresco` (a conferência) vê. */
function amazonFalso() {
  const estado = {
    item: { title: 'Fone Bluetooth XYZ', price: 99.9, oldPrice: 199.9, discountPct: 50, disponivel: true, image: null },
    leitura: null,
  };
  const leituras = [];
  return {
    estado, leituras,
    configurado: () => true,
    montarLink: (asin, { tag } = {}) => `https://www.amazon.com.br/dp/${asin}?tag=${tag || 'minhatag-20'}`,
    async resolver() { return { asin: ASIN }; },
    async lerItem(asin, opcoes = {}) {
      leituras.push({ asin, fresco: opcoes.fresco === true });
      return { ...(opcoes.fresco === true && estado.leitura ? estado.leitura : estado.item) };
    },
  };
}

/** Cliente da Shopee falso: API útil; a conferência lê só o preço. */
function shopeeFalso() {
  const estado = { leitura: { title: 'Capinha', price: 50, discountPct: 10 } };
  const leituras = [];
  return {
    estado, leituras,
    apiUtil: () => true,
    async lerItem(shopId, itemId, opcoes = {}) { leituras.push({ shopId, itemId, fresco: opcoes.fresco === true }); return { ...estado.leitura }; },
  };
}

/**
 * Banco, WhatsApp simulado, links falsos (com espião no requestLink), dois grupos, duas etiquetas, o template com
 * {HORA_PRECO} e a fila com o verificador de verdade (leitores falsos) e um espião no conferir. `verificar: false` = sem
 * verificador (D9). `agora`: o relógio do verificador (a hora da conferência).
 */
function montar({ verificar = true, agora = Date.now } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const pedidosDeLink = [];
  const requestLink = links.requestLink;
  links.requestLink = async (o) => { pedidosDeLink.push(o.url); return requestLink(o); };
  const ml = mlFalso(); const amazon = amazonFalso(); const shopee = shopeeFalso();
  const conferencias = [];
  let verificador = null;
  if (verificar) {
    const real = createVerificador({ db, ml, amazon, shopee, agora });
    verificador = { ...real, async conferir(oferta, opcoes) { conferencias.push({ oferta, opcoes }); return real.conferir(oferta, opcoes); } };
  }
  const envios = createEnvios({ db, wa, links, ml, fast: true, dir, acordar: () => {}, amazon, shopee, verificador });
  for (const [jid, nome] of [[G1, 'Achadinhos'], [G2, 'Tech']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  }
  for (const nome of ['etiquetaA', 'etiquetaB']) db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run(nome);
  const tplCriado = Date.now();
  const tpl = Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Com hora', CORPO, tplCriado).lastInsertRowid);
  return { dir, db, wa, links, ml, amazon, shopee, envios, verificador, conferencias, pedidosDeLink, tpl, tplCriado };
}

/** Disparo manual pelo criar ("agora", que fica pendente: o acordar dos testes não faz nada). → id */
async function criar(s, extra = {}) {
  return (await s.envios.criar({ tipo: 'oferta', url: URL_ML, tag_id: 2, template_id: s.tpl, group_jids: [G1, G2], quando: 'agora', ...extra })).id;
}

/** Envio gravado direto, como o espelho, o catálogo e o remetente gravam. `criadoHa`: idade dos dados, em ms. → id */
function gravar(s, payload, { jids = [G1], criadoHa = 0 } = {}) {
  const agora = Date.now();
  return Number(s.db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
    VALUES ('oferta', ?, ?, 'agora', 'pendente', ?, ?)`).run(JSON.stringify(payload), JSON.stringify(jids), agora, agora - criadoHa).lastInsertRowid);
}

const envio = (s, id) => ({ ...s.db.prepare('SELECT * FROM envios WHERE id = ?').get(id) });
const payloadDe = (s, id) => JSON.parse(envio(s, id).payload);
const resultadoDe = (s, id) => JSON.parse(envio(s, id).resultado);
const resultadosDe = (s, id) => s.db.prepare('SELECT jid, group_name, ok, erro FROM envio_resultados WHERE envio_id = ? ORDER BY id').all(id).map((r) => ({ ...r }));
const logs = (s) => s.db.prepare('SELECT rule_name, level, group_name, offer_title, message FROM log ORDER BY id').all().map((r) => ({ ...r }));
const niveis = (s) => logs(s).map((l) => l.level);

test('CA1/CA5: Disparo manual "agora" (ML) é conferido uma vez antes do link: sai com a hora da conferência em {HORA_PRECO}; preco_loja gravado ao criar', async () => {
  const s = montar({ agora: () => T_1432 });
  const id = await criar(s);
  const p = payloadDe(s, id);
  assert.deepEqual([p.preco_loja, p.offer.price], [89.9, 89.9], 'preco_loja = o preço que a loja devolveu ao criar');
  assert.equal(s.ml.conferencias.length, 0, 'criar não confere: só o envio');

  await s.envios.processarPendentes();
  assert.equal(envio(s, id).status, 'concluido');
  assert.deepEqual(s.ml.conferencias, [URL_ML], 'uma conferência por envio, não por grupo, no endereço gravado');
  assert.equal(s.conferencias.length, 1);
  const [{ oferta, opcoes }] = s.conferencias;
  assert.deepEqual([oferta.loja, oferta.url, oferta.price, oferta.title], ['mercadolivre', URL_ML, 89.9, 'Fone Bom']);
  assert.deepEqual(opcoes, { lidoEm: envio(s, id).created_at, referencia: 89.9 }, 'lidoEm = envios.created_at; referência = preco_loja');

  assert.equal(s.wa.simulated.length, 2);
  for (const m of s.wa.simulated) {
    assert.match(m.text, /Preço visto às 14h32/);
    assert.match(m.text, /Por R\$ 89,90 \(de R\$ 149,90\) 40% OFF/);
    assert.match(m.text, /https:\/\/meli\.la\/fake-etiquetaB-\d+/);
  }
  assert.deepEqual(logs(s).map((l) => [l.level, l.group_name, l.message]),
    [['ok', 'Achadinhos', 'Enviado com a etiqueta etiquetaB'], ['ok', 'Tech', 'Enviado com a etiqueta etiquetaB']], 'conferido sem mudança: sem sufixo');
  const painel = await s.envios.painel('oferta');
  assert.equal(painel.linhas.length, 2);
  assert.ok(painel.linhas.every((l) => !Object.hasOwn(l, 'descartado')), 'linha enviada não tem o campo descartado');
  assert.ok(s.pedidosDeLink.length >= 1);
});

test('CA2: esgotado na loja não sai: nenhum link pedido, um aviso no Histórico, o motivo em cada grupo, resultado.descartado e o campo no painel; nada como erro', async () => {
  const s = montar();
  s.ml.estado.leitura = { price: 89.9, disponivel: false };
  const id = await criar(s);
  await s.envios.processarPendentes();

  assert.equal(envio(s, id).status, 'erro', 'sem status novo: o descartado termina em erro (D11)');
  assert.deepEqual(resultadoDe(s, id), { ok: 0, erro: 2, motivo: MOTIVOS_VERIFICADOR.esgotado, descartado: 'esgotado' });
  assert.deepEqual(resultadosDe(s, id), [
    { jid: G1, group_name: 'Achadinhos', ok: 0, erro: 'Descartada: esgotado na loja' },
    { jid: G2, group_name: 'Tech', ok: 0, erro: 'Descartada: esgotado na loja' },
  ]);
  assert.deepEqual(logs(s), [{ rule_name: 'Disparo manual', level: 'aviso', group_name: null, offer_title: 'Fone Bom', message: 'Descartada: esgotado na loja' }],
    'uma linha aviso por oferta; nenhuma erro (o erro vira aviso por WhatsApp)');
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(s.pedidosDeLink, [], 'a descartada não pede link');

  const painel = await s.envios.painel('oferta');
  assert.deepEqual(painel.linhas.map((l) => [l.grupo, l.status, l.erro, l.descartado]).sort(),
    [['Achadinhos', 'erro', 'Descartada: esgotado na loja', 'esgotado'], ['Tech', 'erro', 'Descartada: esgotado na loja', 'esgotado']]);
  assert.equal(painel.contadores.com_erro, 2);
});

test('CA3: acima do limite é descartado com os dois preços; dentro dele sai com o preço atual e o desconto recalculado; o que caiu sai mais barato; o limite vem de Ajustes', async () => {
  const s = montar();
  const rodar = async (price) => {
    s.ml.estado.leitura = { price, disponivel: true };
    const id = await criar(s, { group_jids: [G1] });
    await s.envios.processarPendentes();
    return id;
  };

  const subiu = await rodar(99.9);
  const texto = 'Descartada: preço subiu de R$ 89,90 para R$ 99,90 (+11%, o limite é 5%)';
  assert.deepEqual(resultadoDe(s, subiu), { ok: 0, erro: 1, motivo: texto, descartado: 'preco_subiu' });
  assert.deepEqual(logs(s).at(-1), { rule_name: 'Disparo manual', level: 'aviso', group_name: null, offer_title: 'Fone Bom', message: texto });
  assert.equal(s.wa.simulated.length, 0);
  assert.deepEqual(s.pedidosDeLink, []);

  const dentro = await rodar(92);
  assert.equal(envio(s, dentro).status, 'concluido');
  assert.match(s.wa.simulated.at(-1).text, /Por R\$ 92,00 \(de R\$ 149,90\) 39% OFF/, 'preço atual e desconto recalculado pelo preço antigo');
  assert.doesNotMatch(s.wa.simulated.at(-1).text, /89,90/);
  assert.equal(logs(s).at(-1).message, 'Enviado com a etiqueta etiquetaB · preço atualizado de R$ 89,90 para R$ 92,00');

  const caiu = await rodar(79.9);
  assert.equal(envio(s, caiu).status, 'concluido');
  assert.match(s.wa.simulated.at(-1).text, /Por R\$ 79,90 \(de R\$ 149,90\) 47% OFF/);
  assert.equal(logs(s).at(-1).message, 'Enviado com a etiqueta etiquetaB · preço atualizado de R$ 89,90 para R$ 79,90');

  setSetting(s.db, 'verificador_limite_pct', '15');
  const comLimite = await rodar(99.9);
  assert.equal(envio(s, comLimite).status, 'concluido', '+11% cabe no limite de 15%');
  assert.match(s.wa.simulated.at(-1).text, /Por R\$ 99,90 \(de R\$ 149,90\) 33% OFF/);
  assert.ok(!niveis(s).includes('erro'));
});

test('CA3: preço digitado no Disparo manual da Amazon é mantido; a referência é o preço da API (preco_loja); a conferência lê a API com fresco', async () => {
  const s = montar({ agora: () => T_1432 });
  const id = await criar(s, { url: URL_AMAZON, tag_id: undefined, group_jids: [G1], ajustes: { price: '79,90' } });
  const p = payloadDe(s, id);
  assert.deepEqual([p.preco_loja, p.offer.price, p.offer.oldPrice], [99.9, 79.9, 199.9], 'preco_loja é o da API, antes do ajuste do painel');
  assert.deepEqual(s.amazon.leituras, [{ asin: ASIN, fresco: false }], 'criar lê pelo cache (sem fresco)');

  s.amazon.estado.leitura = { ...s.amazon.estado.item, price: 102 };
  await s.envios.processarPendentes();
  assert.equal(envio(s, id).status, 'concluido');
  assert.deepEqual(s.amazon.leituras.at(-1), { asin: ASIN, fresco: true }, 'a conferência pula o cache');
  const texto = s.wa.simulated.at(-1).text;
  assert.match(texto, /Por R\$ 79,90 \(de R\$ 199,90\) 60% OFF/, 'o preço digitado fica');
  assert.match(texto, /Preço visto às 14h32/);
  assert.match(texto, new RegExp(`https://www\\.amazon\\.com\\.br/dp/${ASIN}\\?tag=minhatag-20`));
  assert.equal(logs(s).at(-1).message, 'Enviado com a tag de associado da Amazon');

  const outro = await criar(s, { url: URL_AMAZON, tag_id: undefined, group_jids: [G1], ajustes: { price: '79,90' } });
  s.amazon.estado.leitura = { ...s.amazon.estado.item, price: 110 };
  await s.envios.processarPendentes();
  assert.deepEqual(resultadoDe(s, outro), {
    ok: 0, erro: 1, motivo: 'Descartada: preço subiu de R$ 99,90 para R$ 110,00 (+10%, o limite é 5%)', descartado: 'preco_subiu',
  }, 'a alta é medida contra o preço da loja, não contra o digitado');
  assert.ok(!niveis(s).includes('erro'));
});

test('CA4: sem conferência (a loja não respondeu): o "agora" sai com o aviso na linha ok e sem a hora; o agendado com dados de mais de 30 min não sai', async (t) => {
  const espiao = t.mock.method(console, 'error', () => {});
  const s = montar();
  s.ml.estado.falha = new Error(`ECONNRESET ao abrir ${URL_ML}`);

  const agora = await criar(s, { group_jids: [G1] });
  await s.envios.processarPendentes();
  assert.equal(envio(s, agora).status, 'concluido');
  const texto = s.wa.simulated.at(-1).text;
  assert.doesNotMatch(texto, /Preço visto/, 'sem conferência, {HORA_PRECO} vazio e o trecho entre [ ] some');
  assert.match(texto, /Por R\$ 89,90/);
  assert.equal(logs(s).at(-1).message, 'Enviado com a etiqueta etiquetaB · preço não conferido (a loja não respondeu)');

  // o agendado: dados lidos ao criar, 29 min antes do envio (sai) e 31 min antes (não sai)
  const envelhecer = (id, ms) => s.db.prepare("UPDATE envios SET quando = 'agendado', created_at = created_at - ? WHERE id = ?").run(ms, id);
  const recente = await criar(s, { group_jids: [G1] });
  envelhecer(recente, 29 * MIN);
  await s.envios.processarPendentes();
  assert.equal(envio(s, recente).status, 'concluido');

  const velho = await criar(s, { group_jids: [G1] });
  envelhecer(velho, 31 * MIN);
  const enviadas = s.wa.simulated.length;
  await s.envios.processarPendentes();
  const motivo = 'Descartada: não deu para conferir o preço (a loja não respondeu)';
  assert.deepEqual(resultadoDe(s, velho), { ok: 0, erro: 1, motivo, descartado: 'nao_conferido' });
  assert.equal(s.wa.simulated.length, enviadas);
  assert.deepEqual(logs(s).at(-1), { rule_name: 'Disparo manual', level: 'aviso', group_name: null, offer_title: 'Fone Bom', message: motivo });
  assert.ok(!niveis(s).includes('erro'), 'nada do verificador vai ao Histórico como erro');
  const consoleTexto = espiao.mock.calls.map((c) => c.arguments.map(String).join(' ')).join('\n');
  assert.ok(!consoleTexto.includes('mercadolivre.com.br') && !consoleTexto.includes('ECONNRESET'), 'o console não leva a URL nem a mensagem do erro');
});

test('CA1: espelho (Amazon), catálogo (ML), remetente (ML) e Shopee passam pelo verificador com a idade do envio; sem preco_loja, a referência é o preço da oferta', async () => {
  const s = montar({ agora: () => T_1432 });
  const comum = { tag_id: null, etiqueta: null, template_id: s.tpl, template_criado_em: s.tplCriado, fonte_dados: 'api', enviar_foto: false };
  const oferta = (key, title, price, extra = {}) => ({ key, title, price, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: null, image: null, ...extra });

  // espelho: o payload de src/espelho.js (gravarEnvio), sem preco_loja; a Amazon diz que esgotou
  s.amazon.estado.leitura = { ...s.amazon.estado.item, disponivel: false };
  const espelho = gravar(s, {
    ...comum, url: URL_AMAZON, loja: 'amazon', asin: ASIN, origem: { tipo: 'espelho', espelho_id: 3, nome: 'Amazon → Achadinhos' },
    offer: oferta(`ASIN:${ASIN}`, 'Fone Bluetooth XYZ', 99.9, { oldPrice: 199.9, discountPct: 50 }),
  }, { criadoHa: 5 * MIN });
  await s.envios.runEnvio(espelho);
  let c = s.conferencias.at(-1);
  assert.deepEqual([c.oferta.loja, c.oferta.asin, c.oferta.key, c.opcoes.referencia, c.opcoes.lidoEm], ['amazon', ASIN, `ASIN:${ASIN}`, undefined, envio(s, espelho).created_at]);
  assert.deepEqual(resultadoDe(s, espelho), { ok: 0, erro: 1, motivo: 'Descartada: esgotado na loja', descartado: 'esgotado' });
  assert.deepEqual(logs(s).at(-1), { rule_name: 'Espelho: Amazon → Achadinhos', level: 'aviso', group_name: null, offer_title: 'Fone Bluetooth XYZ', message: 'Descartada: esgotado na loja' });

  // catálogo: o payload de src/catalogo-itens.js, sem preco_loja; a referência é o preço da oferta (100)
  s.ml.estado.leitura = { price: 120, disponivel: true };
  const catalogo = gravar(s, {
    ...comum, url: URL_ML_PRODUTO, loja: 'mercadolivre', tag_id: 1, etiqueta: 'etiquetaA', fonte_dados: 'manual',
    origem: { tipo: 'catalogo', rule_id: 4, nome: 'Perfumes' }, offer: oferta('MLB1234567890', 'Perfume Bom', 100),
  }, { criadoHa: 2 * MIN });
  await s.envios.runEnvio(catalogo);
  c = s.conferencias.at(-1);
  assert.deepEqual([c.oferta.loja, c.oferta.url, c.opcoes.lidoEm], ['mercadolivre', URL_ML_PRODUTO, envio(s, catalogo).created_at]);
  assert.deepEqual(resultadoDe(s, catalogo), {
    ok: 0, erro: 1, motivo: 'Descartada: preço subiu de R$ 100,00 para R$ 120,00 (+20%, o limite é 5%)', descartado: 'preco_subiu',
  });
  assert.equal(logs(s).at(-1).rule_name, 'Catálogo: Perfumes');

  // remetente: o payload do montarOferta (com preco_loja); o preço caiu
  s.ml.estado.leitura = { price: 85, disponivel: true };
  const remetente = gravar(s, {
    ...comum, url: URL_ML_PRODUTO, loja: 'mercadolivre', tag_id: 2, etiqueta: 'etiquetaB', fonte_dados: 'api',
    origem: { tipo: 'remetente', remetente_id: 1, nome: 'Sócio' }, preco_loja: 89.9, offer: oferta('MLB1234567890', 'Fone Bom', 89.9),
  });
  await s.envios.runEnvio(remetente);
  assert.equal(s.conferencias.at(-1).opcoes.referencia, 89.9);
  assert.equal(envio(s, remetente).status, 'concluido');
  assert.match(s.wa.simulated.at(-1).text, /Por R\$ 85,00\n🕒 Preço visto às 14h32/);
  assert.deepEqual(logs(s).at(-1), {
    rule_name: 'Remetente: Sócio', level: 'ok', group_name: 'Achadinhos', offer_title: 'Fone Bom',
    message: 'Enviado com a etiqueta etiquetaB · preço atualizado de R$ 89,90 para R$ 85,00',
  });

  // Shopee: ids do payload (shop_id/item_id), só o preço conferido, o link guardado ao criar
  s.shopee.estado.leitura = { title: 'Capinha', price: 49, discountPct: 12 };
  const shopee = gravar(s, {
    ...comum, url: `https://shopee.com.br/Capinha-i.${SHOP}.${ITEM}`, loja: 'shopee', shop_id: SHOP, item_id: ITEM,
    link_afiliado: 'https://s.shopee.com.br/AbC123', origem: { tipo: 'manual' }, preco_loja: 50, offer: oferta(`SHOPEE:${SHOP}.${ITEM}`, 'Capinha', 50),
  });
  await s.envios.runEnvio(shopee);
  assert.deepEqual(s.shopee.leituras, [{ shopId: SHOP, itemId: ITEM, fresco: true }]);
  assert.equal(envio(s, shopee).status, 'concluido');
  assert.match(s.wa.simulated.at(-1).text, /Por R\$ 49,00 12% OFF\n🕒 Preço visto às 14h32\nhttps:\/\/s\.shopee\.com\.br\/AbC123/);
  assert.equal(logs(s).at(-1).message, 'Enviado com o link de afiliado da Shopee · preço atualizado de R$ 50,00 para R$ 49,00');

  assert.ok(!niveis(s).includes('erro'));
  assert.equal(s.pedidosDeLink.length, 1, 'só o remetente pediu link (o espelho e o catálogo foram descartados antes)');
});

test('retomada: quem já recebeu na ocorrência fica ok; a descartada barra só os grupos que faltavam, e só eles levam o campo descartado no painel', async () => {
  const s = montar();
  s.ml.estado.leitura = { price: 89.9, disponivel: false };
  const id = await criar(s);
  const { next_run_at: ocorrencia } = envio(s, id);
  s.db.prepare('INSERT INTO envio_resultados (envio_id, ocorrencia, ts, jid, group_name, ok, erro) VALUES (?,?,?,?,?,1,NULL)').run(id, ocorrencia, Date.now() - 1000, G1, 'Achadinhos');
  await s.envios.processarPendentes();
  assert.deepEqual(resultadoDe(s, id), { ok: 1, erro: 1, motivo: 'Descartada: esgotado na loja', descartado: 'esgotado' });
  assert.equal(s.wa.simulated.length, 0, 'o grupo que já recebeu não recebe de novo');
  const linhas = (await s.envios.painel('oferta')).linhas.map((l) => ({ grupo: l.grupo, status: l.status, descartado: l.descartado ?? null }));
  assert.deepEqual(linhas.sort((a, b) => a.grupo.localeCompare(b.grupo)), [
    { grupo: 'Achadinhos', status: 'enviado', descartado: null },
    { grupo: 'Tech', status: 'erro', descartado: 'esgotado' },
  ]);
});

test('D9: sem verificador, a fila é a de antes: nada é conferido, preco_loja não é gravado e {HORA_PRECO} fica vazio', async () => {
  const s = montar({ verificar: false });
  s.ml.estado.leitura = { price: 89.9, disponivel: false };
  const id = await criar(s, { group_jids: [G1] });
  assert.ok(!Object.hasOwn(payloadDe(s, id), 'preco_loja'));
  await s.envios.processarPendentes();
  assert.equal(envio(s, id).status, 'concluido');
  assert.deepEqual(s.ml.conferencias, []);
  assert.doesNotMatch(s.wa.simulated.at(-1).text, /Preço visto/);
  assert.deepEqual(resultadoDe(s, id), { ok: 1, erro: 0 });
  assert.equal(logs(s).at(-1).message, 'Enviado com a etiqueta etiquetaB');
});

test('Ajustes: com o verificador desligado, a oferta sai como foi gravada, sem ler a loja, sem a hora e sem sufixo', async () => {
  const s = montar({ agora: () => T_1432 });
  setSetting(s.db, 'verificador_ativo', '0');
  s.ml.estado.leitura = { price: 120, disponivel: false };
  const id = await criar(s, { group_jids: [G1] });
  await s.envios.processarPendentes();
  assert.equal(envio(s, id).status, 'concluido');
  assert.deepEqual(s.ml.conferencias, []);
  assert.match(s.wa.simulated.at(-1).text, /Por R\$ 89,90/);
  assert.doesNotMatch(s.wa.simulated.at(-1).text, /Preço visto/);
  assert.equal(logs(s).at(-1).message, 'Enviado com a etiqueta etiquetaB');
});

test('prévias: o Identificar (ML e Amazon) e o Testar do espelho mostram {HORA_PRECO} com a hora de agora, sem conferir na loja', async () => {
  const s = montar();
  const hora = /Preço visto às \d{2}h\d{2}/;
  const ml = await s.envios.identificar({ url: URL_ML, template_id: s.tpl });
  assert.match(ml.texto, hora);
  const amazon = await s.envios.identificar({ url: URL_AMAZON, template_id: s.tpl });
  assert.match(amazon.texto, hora);

  const espelho = createEspelho({ db: s.db, wa: s.wa, amazon: s.amazon, envios: s.envios, agora: () => T_1432 });
  const regra = espelho.criar({ nome: 'Amazon → Tech', origem_jids: [G1], destino_jids: [G2], template_id: s.tpl }).id;
  const r = await espelho.testar(regra, { texto: `Olha que oferta ${URL_AMAZON}` });
  assert.match(r.texto, /Preço visto às 14h32/);

  assert.deepEqual([s.conferencias, s.ml.conferencias], [[], []], 'prévia não confere');
  assert.ok(s.amazon.leituras.every((l) => !l.fresco), 'prévia não lê a Amazon com fresco');
});

test('R1: com o verificador ligado, agendar para mais de 25 min uma loja sem conferência de preço é recusado; o resto segue', async (t) => {
  const BASE = new Date(2026, 0, 15, 12, 0).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  const URL_MAGALU = 'https://www.magazineluiza.com.br/fone-bom/p/abc123/audio/fones/?seller_id=magazineluiza';
  const frase = 'Esta loja não tem conferência de preço: agende para até 25 min ou envie agora.';
  assert.equal(SEM_CONFERENCIA_AGENDADO, frase);
  const montarComMagalu = (opcoes) => {
    const s = montar(opcoes);
    s.db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('magalu', ?, '{}', ?)").run(JSON.stringify({ loja: 'minhaloja' }), 1);
    s.envios = createEnvios({ db: s.db, wa: s.wa, links: s.links, ml: s.ml, fast: true, dir: s.dir, acordar: () => {}, amazon: s.amazon, shopee: s.shopee, magalu: createMagalu({ fetch: globalThis.fetch }), verificador: s.verificador });
    return s;
  };
  const total = (s) => s.db.prepare('SELECT COUNT(*) n FROM envios').get().n;
  const agendar = (s, url, hhmm) => s.envios.criar({ tipo: 'oferta', url, tag_id: 2, template_id: s.tpl, group_jids: [G1], quando: 'agendado', agendar_hhmm: hhmm, ...(url === URL_MAGALU ? { ajustes: { title: 'Fone Bom' } } : {}) });

  const s = montarComMagalu();
  // Magalu nunca é conferida: até 25 min (inclusive; 30 de frescor menos 5 de margem) passa; 26 min ou mais, não, e nada é gravado
  await agendar(s, URL_MAGALU, '12:25');
  const antes = total(s);
  for (const hhmm of ['12:26', '12:31', '15:00']) {
    await assert.rejects(agendar(s, URL_MAGALU, hhmm), (e) => e.message === frase, hhmm);
  }
  assert.equal(total(s), antes, 'a recusa vem antes de gravar');
  // "agora" e o ML (que confere na hora do envio) agendado para longe passam
  await s.envios.criar({ tipo: 'oferta', url: URL_MAGALU, tag_id: 2, template_id: s.tpl, group_jids: [G1], quando: 'agora', ajustes: { title: 'Fone Bom' } });
  await agendar(s, URL_ML, '15:00');
  // Amazon sem a API ligada: sem conferência; com ela, passa
  await agendar(s, URL_AMAZON, '15:00');
  s.amazon.configurado = () => false;
  await assert.rejects(agendar(s, URL_AMAZON, '15:00'), (e) => e.message === frase);
  await agendar(s, URL_AMAZON, '12:20');
  s.amazon.configurado = () => true;
  // verificador desligado em Ajustes: nada é conferido, então nada é recusado
  setSetting(s.db, 'verificador_ativo', '0');
  await agendar(s, URL_MAGALU, '15:00');
  // sem verificador (D9), idem
  await agendar(montarComMagalu({ verificar: false }), URL_MAGALU, '15:00');
});

test('R1: o Identificar marca sem_conferencia só nas lojas sem conferência e com o verificador ligado', async () => {
  const URL_MAGALU = 'https://www.magazineluiza.com.br/fone-bom/p/abc123/audio/fones/?seller_id=magazineluiza';
  const montarI = (opcoes) => {
    const s = montar(opcoes);
    s.db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('magalu', ?, '{}', ?)").run(JSON.stringify({ loja: 'minhaloja' }), 1);
    s.envios = createEnvios({ db: s.db, wa: s.wa, links: s.links, ml: s.ml, fast: true, dir: s.dir, acordar: () => {}, amazon: s.amazon, shopee: s.shopee, magalu: createMagalu({ fetch: globalThis.fetch }), verificador: s.verificador });
    return s;
  };
  const s = montarI();
  const chave = async (url) => Object.hasOwn(await s.envios.identificar({ url, template_id: s.tpl }), 'sem_conferencia');
  assert.deepEqual([await chave(URL_MAGALU), await chave(URL_ML), await chave(URL_AMAZON)], [true, false, false]);
  assert.equal((await s.envios.identificar({ url: URL_MAGALU, template_id: s.tpl })).sem_conferencia, true);
  s.amazon.configurado = () => false;
  assert.equal(await chave(URL_AMAZON), true, 'Amazon sem a API');
  s.amazon.configurado = () => true;
  setSetting(s.db, 'verificador_ativo', '0');
  assert.deepEqual([await chave(URL_MAGALU), await chave(URL_AMAZON)], [false, false], 'verificador desligado');
  const sem = montarI({ verificar: false });
  assert.equal(Object.hasOwn(await sem.envios.identificar({ url: URL_MAGALU, template_id: sem.tpl }), 'sem_conferencia'), false, 'sem verificador');
});

test('CA2.12: preço suspeito que veio da conferência descarta o envio antes do link e da mensagem; preço digitado pelo dono sai; com o verificador desligado nada muda', async (t) => {
  const MOTIVO = 'Descartada: preço suspeito';
  assert.equal(MOTIVOS_VERIFICADOR.preco_suspeito, MOTIVO);
  const comum = (s) => ({ tag_id: 2, etiqueta: 'etiquetaB', template_id: s.tpl, template_criado_em: s.tplCriado, enviar_foto: false });
  const ml = (price) => ({
    ...{ url: URL_ML_PRODUTO, loja: 'mercadolivre', preco_loja: 89.9 },
    offer: { key: 'MLB1234567890', title: 'Fone Bom', price, oldPrice: 149.9, discountPct: 40, sold: null, freeShipping: false, coupon: null, image: null },
  });

  await t.test('ML (Disparo manual agendado/agora): a leitura baixa o preço a 1/10 do antigo → descartado, sem link e sem mensagem', async () => {
    const s = montar();
    s.ml.estado.leitura = { price: 8.99, disponivel: true };
    const id = gravar(s, { ...comum(s), ...ml(89.9) });
    await s.envios.processarPendentes();
    assert.equal(envio(s, id).status, 'erro');
    assert.deepEqual(resultadoDe(s, id), { ok: 0, erro: 1, motivo: MOTIVO, descartado: 'preco_suspeito' });
    assert.deepEqual(resultadosDe(s, id), [{ jid: G1, group_name: 'Achadinhos', ok: 0, erro: MOTIVO }]);
    assert.deepEqual(s.pedidosDeLink, [], 'nenhum pedido de link');
    assert.equal(s.wa.simulated.length, 0, 'nenhuma mensagem');
    assert.deepEqual(logs(s), [{ rule_name: 'Disparo manual', level: 'aviso', group_name: null, offer_title: 'Fone Bom', message: MOTIVO }]);
    assert.ok(!niveis(s).includes('erro'));
    const painel = await s.envios.painel('oferta');
    assert.deepEqual(painel.linhas.map((l) => [l.status, l.erro, l.descartado]), [['erro', MOTIVO, 'preco_suspeito']]);
  });

  await t.test('Amazon pelo criar, preço digitado pelo dono: a guarda não vale, o texto sai com o preço digitado', async () => {
    const s = montar({ agora: () => T_1432 });
    const id = await criar(s, { url: URL_AMAZON, tag_id: undefined, group_jids: [G1], ajustes: { price: '5,00' } });
    assert.deepEqual([payloadDe(s, id).preco_loja, payloadDe(s, id).offer.price, payloadDe(s, id).offer.oldPrice], [99.9, 5, 199.9], '10x o preço: pareceria suspeito');
    s.amazon.estado.leitura = { ...s.amazon.estado.item };
    await s.envios.processarPendentes();
    assert.equal(envio(s, id).status, 'concluido');
    assert.match(s.wa.simulated.at(-1).text, /Por R\$ 5,00 \(de R\$ 199,90\)/);
    assert.deepEqual(niveis(s), ['ok']);
  });

  await t.test('Amazon pelo criar sem digitar: a leitura cai a menos de 1/10 do preço antigo → descartado', async () => {
    const s = montar({ agora: () => T_1432 });
    const id = await criar(s, { url: URL_AMAZON, tag_id: undefined, group_jids: [G1] });
    s.amazon.estado.leitura = { ...s.amazon.estado.item, price: 9.99, oldPrice: 199.9 };
    await s.envios.processarPendentes();
    assert.deepEqual(resultadoDe(s, id), { ok: 0, erro: 1, motivo: MOTIVO, descartado: 'preco_suspeito' });
    assert.equal(s.wa.simulated.length, 0);
    assert.deepEqual(s.pedidosDeLink, []);
  });

  await t.test('preço digitado em outra origem (ML gravado com preço diferente do da loja) sai mesmo parecendo suspeito', async () => {
    const s = montar();
    s.ml.estado.leitura = { price: 89.9, disponivel: true };
    const id = gravar(s, { ...comum(s), ...ml(8.99) });
    await s.envios.processarPendentes();
    assert.equal(envio(s, id).status, 'concluido');
    assert.match(s.wa.simulated.at(-1).text, /Por R\$ 8,99 \(de R\$ 149,90\)/);
    assert.deepEqual(niveis(s), ['ok']);
  });

  await t.test('preço que a conferência trocou mas que não é suspeito (queda normal) sai', async () => {
    const s = montar();
    s.ml.estado.leitura = { price: 79.9, disponivel: true };
    const id = gravar(s, { ...comum(s), ...ml(89.9) });
    await s.envios.processarPendentes();
    assert.equal(envio(s, id).status, 'concluido');
    assert.match(s.wa.simulated.at(-1).text, /Por R\$ 79,90/);
  });

  await t.test('verificador desligado (Ajustes) ou ausente: nada muda, a oferta sai como foi gravada', async () => {
    const s = montar();
    setSetting(s.db, 'verificador_ativo', '0');
    s.ml.estado.leitura = { price: 8.99, disponivel: true };
    const id = gravar(s, { ...comum(s), ...ml(89.9) });
    await s.envios.processarPendentes();
    assert.equal(envio(s, id).status, 'concluido');
    assert.match(s.wa.simulated.at(-1).text, /Por R\$ 89,90/);

    const sem = montar({ verificar: false });
    const gravado = { ...comum(sem), ...ml(8.99) };
    delete gravado.preco_loja;
    const id2 = gravar(sem, gravado);
    await sem.envios.processarPendentes();
    assert.equal(envio(sem, id2).status, 'concluido');
    assert.match(sem.wa.simulated.at(-1).text, /Por R\$ 8,99/);
  });
});

test('CA6: nenhum teste deste arquivo acessou a rede', () => {
  assert.equal(acessosRede, 0);
});
