// Verificador de preço e estoque, etapa 5 (docs/produto/planos/verificador-preco-estoque.md; CA1–CA4, CA6, CA7):
// decidir (pura) e createVerificador().conferir com leitores falsos por loja. As leituras "de verdade" usam o
// conferirProduto do ML com fixtures injetadas e os clientes reais da Amazon e da Shopee sem credencial ou com um
// fetch falso. O fetch global fica bloqueado e o último teste prova que ninguém o chamou.
// Entrega 2 (docs/produto/planos/verificador-ml-extensao.md, etapa 4; CA1–CA4, CA6, CA8): no modo de link
// 'extension', o ML é lido só pela extensão (links.requestProduto falso), com as falhas nomeadas virando CAUSAS.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSetting } from '../src/db.js';
import {
  decidir, createVerificador, OfertaDescartada, MOTIVOS_VERIFICADOR, CAUSAS,
  LIMITE_PADRAO_PCT, LIMITE_MAX_PCT, FRESCOR_MIN, TEMPO_MAX_MS, PAUSA_DESCARTADA_H, RESERVA_AMAZON_H, PAUSA_RELEITURA_MIN, reservaValida,
} from '../src/verificador.js';
import { conferirProduto } from '../src/ml.js';
import { createAmazon, ErroAmazon } from '../src/amazon.js';
import { createShopee, ErroShopee, URL_API } from '../src/shopee.js';
import { renderTemplate } from '../src/template.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const novoDb = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-verif-')); pastas.push(p); return openDb(p); };

const MIN = 60 * 1000;
const T0 = 1_786_000_000_000;
const URL_ML = 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM';
const ASIN = 'B0FG2MD49G';
const SHOP = '52377417';
const ITEM = '6309028319';

/** Textos que o verificador pode produzir: só frases fixas, CAUSAS e preços em R$. */
const R = 'R\\$ \\d{1,3}(?:\\.\\d{3})*,\\d{2}';
const CAUSA = `(?:${Object.values(CAUSAS).map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
const TEXTO_PERMITIDO = new RegExp(`^(?:Descartada: esgotado na loja|Descartada: preço subiu de ${R} para ${R} \\(\\+\\d+(?:,\\d{1,2})?%, o limite é \\d{1,2}%\\)|Descartada: não deu para conferir o preço \\(${CAUSA}\\)|Descartada: indisponível na loja \\(a página não mostra preço nem estoque\\)|Descartada: a página da loja abriu outro produto \\(o código não confere com a oferta\\))$`);
const HORA_VISTA = '\\d{2}:\\d{2}(?: de \\d{2}/\\d{2})?';
const SUFIXO_PERMITIDO = new RegExp(`^ · (?:preço não conferido \\(${CAUSA}\\)|preço atualizado de ${R} para ${R}|preço visto às ${HORA_VISTA}, não conferido agora \\(${CAUSA}\\))$`);
function textosLimpos(r) {
  if (r.acao === 'descartar') assert.match(r.texto, TEXTO_PERMITIDO);
  else if (r.sufixo != null) assert.match(r.sufixo, SUFIXO_PERMITIDO);
}

/** Leitor que falha se for chamado (prova que a loja não foi lida). */
const proibido = (nome) => async () => { throw new Error(`${nome} não devia ser chamado`); };

/** Leitores falsos que contam as chamadas. */
function mlFalso(resposta) {
  const chamadas = [];
  return { chamadas, conferirProduto: async (url, ...resto) => { chamadas.push([url, ...resto]); return typeof resposta === 'function' ? resposta(url) : resposta; } };
}
function amazonFalsa(resposta, { configurado = true } = {}) {
  const chamadas = [];
  return { chamadas, configurado: () => configurado, lerItem: async (...args) => { chamadas.push(args); return typeof resposta === 'function' ? resposta(...args) : resposta; } };
}
function shopeeFalsa(resposta, { util = true } = {}) {
  const chamadas = [];
  return { chamadas, configurado: () => util, apiUtil: () => util, lerItem: async (...args) => { chamadas.push(args); return typeof resposta === 'function' ? resposta(...args) : resposta; } };
}

const ofertaMl = (extra = {}) => ({ loja: 'mercadolivre', url: URL_ML, key: 'MLB1234567890', title: 'Fone Bom', price: 100, oldPrice: 150, discountPct: 33, ...extra });

// ---------------------------------------------------------------------------------------------- constantes
test('verificador: constantes e frases fixas do contrato', () => {
  assert.deepEqual(
    [LIMITE_PADRAO_PCT, LIMITE_MAX_PCT, FRESCOR_MIN, TEMPO_MAX_MS, PAUSA_DESCARTADA_H, RESERVA_AMAZON_H, PAUSA_RELEITURA_MIN],
    [5, 50, 30, 20000, 6, 6, 10],
  );
  assert.deepEqual({ ...MOTIVOS_VERIFICADOR }, {
    esgotado: 'Descartada: esgotado na loja',
    preco_subiu: 'Descartada: preço subiu',
    nao_conferido: 'Descartada: não deu para conferir o preço',
    indisponivel: 'Descartada: indisponível na loja',
    outro_produto: 'Descartada: a página da loja abriu outro produto',
  });
  assert.ok(Object.isFrozen(MOTIVOS_VERIFICADOR) && Object.isFrozen(CAUSAS));
  for (const frase of ['a loja não respondeu', 'a API da Amazon não está ligada', 'a Magalu não deixa ler a página',
    'a Shopee não devolveu o produto', 'a página não trouxe o preço', 'a loja demorou demais']) {
    assert.ok(Object.values(CAUSAS).includes(frase), frase);
  }
  // entrega 2 (D8): as causas da leitura pela extensão do Chrome
  assert.deepEqual(
    [CAUSAS.extensao_off, CAUSAS.extensao_antiga, CAUSAS.ml_verificacao, CAUSAS.limite_hora],
    ['a extensão do Chrome não está conectada', 'a extensão do Chrome precisa ser recarregada',
      'o Mercado Livre pediu verificação no navegador', 'o limite de conferências por hora foi atingido'],
  );
  // achado R1: catálogo de várias versões e o link não diz qual
  assert.equal(CAUSAS.varias_versoes, 'o produto tem várias versões e o link não diz qual');
  // rodar sozinho, entrega 1: a releitura da Amazon pelo Etiqueta
  assert.deepEqual(
    [CAUSAS.etiqueta_fora, CAUSAS.etiqueta_bloqueio, CAUSAS.etiqueta_sem_oferta],
    ['o Etiqueta não respondeu', 'a Amazon bloqueou a leitura', 'a oferta saiu do Etiqueta'],
  );
  assert.equal(CAUSAS.amazon_sem_api, 'a API da Amazon não está ligada', 'o Disparo manual ainda a usa');
});

test('verificador: OfertaDescartada leva motivo e texto; motivo desconhecido vira nao_conferido', () => {
  const e = new OfertaDescartada('esgotado', 'Descartada: esgotado na loja');
  assert.ok(e instanceof Error);
  assert.deepEqual([e.name, e.motivo, e.texto, e.message], ['OfertaDescartada', 'esgotado', 'Descartada: esgotado na loja', 'Descartada: esgotado na loja']);
  const x = new OfertaDescartada('constructor');
  assert.deepEqual([x.motivo, x.texto], ['nao_conferido', MOTIVOS_VERIFICADOR.nao_conferido]);
});

// ---------------------------------------------------------------------------------------------- decidir
const base = { referencia: 100, precoOferta: 100, limitePct: 5, lidoEm: T0, agora: T0 };

test('decidir: esgotado descarta, com ou sem preço lido (CA2)', () => {
  for (const leitura of [{ price: 90, disponivel: false }, { price: null, disponivel: false }]) {
    const r = decidir({ ...base, leitura });
    assert.deepEqual(r, { acao: 'descartar', motivo: 'esgotado', texto: 'Descartada: esgotado na loja' });
  }
});

test('decidir: preço acima do limite descarta com os dois preços; até o limite sai (CA3)', () => {
  const r = decidir({ ...base, referencia: 89.9, precoOferta: 89.9, leitura: { price: 99.9, disponivel: true } });
  assert.deepEqual(r, { acao: 'descartar', motivo: 'preco_subiu', texto: 'Descartada: preço subiu de R$ 89,90 para R$ 99,90 (+11%, o limite é 5%)' });
  // 89,90 × 1,05 = 94,395: em centavos, 94,39 está dentro e 94,40 passa
  assert.equal(decidir({ ...base, referencia: 89.9, precoOferta: 89.9, leitura: { price: 94.39, disponivel: true } }).acao, 'enviar');
  assert.equal(decidir({ ...base, referencia: 89.9, precoOferta: 89.9, leitura: { price: 94.4, disponivel: true } }).acao, 'descartar');
  // exatamente no limite sai, com o preço novo
  const dentro = decidir({ ...base, leitura: { price: 105, disponivel: true } });
  assert.deepEqual(dentro, { acao: 'enviar', conferido: true, precoNovo: 105, sufixo: ' · preço atualizado de R$ 100,00 para R$ 105,00' });
  // um centavo acima: o texto nunca mostra uma alta igual ao limite
  assert.equal(decidir({ ...base, leitura: { price: 105.01, disponivel: true } }).texto,
    'Descartada: preço subiu de R$ 100,00 para R$ 105,01 (+5,01%, o limite é 5%)');
  assert.equal(decidir({ ...base, leitura: { price: 105.4, disponivel: true } }).texto,
    'Descartada: preço subiu de R$ 100,00 para R$ 105,40 (+5,4%, o limite é 5%)');
  assert.equal(decidir({ ...base, referencia: 1000, precoOferta: 1000, leitura: { price: 1050.01, disponivel: true } }).texto,
    'Descartada: preço subiu de R$ 1.000,00 para R$ 1.050,01 (+5,01%, o limite é 5%)');
});

test('decidir: limite 0 descarta qualquer alta; o limite fora de 0 a 50 vira o padrão 5 (CA3, CA7)', () => {
  const zero = { ...base, referencia: 89.9, precoOferta: 89.9, limitePct: 0 };
  assert.equal(decidir({ ...zero, leitura: { price: 89.91 } }).texto, 'Descartada: preço subiu de R$ 89,90 para R$ 89,91 (+0,01%, o limite é 0%)');
  assert.deepEqual(decidir({ ...zero, leitura: { price: 89.9 } }), { acao: 'enviar', conferido: true, precoNovo: null, sufixo: null });
  assert.equal(decidir({ ...base, limitePct: 50, leitura: { price: 150 } }).acao, 'enviar');
  assert.match(decidir({ ...base, limitePct: 50, leitura: { price: 150.01 } }).texto, /o limite é 50%/);
  for (const limitePct of [51, -1, 2.5, '10', null, undefined, Number.NaN]) {
    assert.equal(decidir({ ...base, limitePct, leitura: { price: 105 } }).acao, 'enviar', String(limitePct));
    assert.match(decidir({ ...base, limitePct, leitura: { price: 105.01 } }).texto, /o limite é 5%\)$/, String(limitePct));
  }
});

test('decidir: preço que caiu sai com o preço atual; igual sai sem sufixo (CA3)', () => {
  assert.deepEqual(decidir({ ...base, leitura: { price: 89.9, disponivel: true } }),
    { acao: 'enviar', conferido: true, precoNovo: 89.9, sufixo: ' · preço atualizado de R$ 100,00 para R$ 89,90' });
  assert.deepEqual(decidir({ ...base, leitura: { price: 100, disponivel: null } }),
    { acao: 'enviar', conferido: true, precoNovo: null, sufixo: null });
});

test('decidir: preço digitado à mão é mantido, mas a alta acima do limite ainda descarta (CA3)', () => {
  // digitado diferente da referência (preco_loja do payload): mantém
  assert.deepEqual(decidir({ ...base, precoOferta: 79.9, leitura: { price: 95 } }), { acao: 'enviar', conferido: true, precoNovo: null, sufixo: null });
  // digitado igual à referência (lista de links, sem preco_loja): a marca `digitado` mantém
  assert.deepEqual(decidir({ ...base, digitado: true, leitura: { price: 95 } }), { acao: 'enviar', conferido: true, precoNovo: null, sufixo: null });
  assert.equal(decidir({ ...base, digitado: true, leitura: { price: 120 } }).motivo, 'preco_subiu');
});

test('decidir: sem referência (oferta sem preço) confere sem comparar (CA3)', () => {
  for (const referencia of [null, undefined, 0, -5, Number.NaN, '100']) {
    assert.deepEqual(decidir({ ...base, referencia, precoOferta: null, leitura: { price: 999, disponivel: true } }),
      { acao: 'enviar', conferido: true, precoNovo: null, sufixo: null }, String(referencia));
  }
});

test('decidir: sem conferência, dados de até 30 min saem com o sufixo; 31 min, futuro ou idade desconhecida descartam (CA4)', () => {
  const sem = { ...base, leitura: { causa: 'loja_fora' } };
  for (const idade of [0, 29 * MIN, 30 * MIN, -30 * 1000]) {
    assert.deepEqual(decidir({ ...sem, lidoEm: T0 - idade }),
      { acao: 'enviar', conferido: false, precoNovo: null, sufixo: ' · preço não conferido (a loja não respondeu)' }, String(idade));
  }
  for (const lidoEm of [T0 - 31 * MIN, T0 - 30 * MIN - 1, T0 + 2 * MIN, null, undefined, '2026-11-09 10:00:00', Number.NaN]) {
    assert.deepEqual(decidir({ ...sem, lidoEm }),
      { acao: 'descartar', motivo: 'nao_conferido', texto: 'Descartada: não deu para conferir o preço (a loja não respondeu)', causa: 'loja_fora' }, String(lidoEm));
  }
});

test('decidir: leitura sem preço é sem conferência ("a página não trouxe o preço"); causa desconhecida vira "a loja não respondeu"', () => {
  for (const leitura of [{ price: null, disponivel: true }, { price: 0 }, { price: '99,90' }, { price: Number.POSITIVE_INFINITY }, {}]) {
    assert.equal(decidir({ ...base, lidoEm: null, leitura }).texto, 'Descartada: não deu para conferir o preço (a página não trouxe o preço)');
  }
  for (const leitura of [null, undefined]) {
    assert.equal(decidir({ ...base, lidoEm: null, leitura }).texto, 'Descartada: não deu para conferir o preço (a página não trouxe o preço)');
  }
  assert.equal(decidir({ ...base, lidoEm: null, leitura: { causa: '<b>x</b>' } }).texto, 'Descartada: não deu para conferir o preço (a loja não respondeu)');
  assert.equal(decidir({ ...base, lidoEm: null, leitura: { causa: 'toString' } }).texto, 'Descartada: não deu para conferir o preço (a loja não respondeu)');
  assert.equal(decidir({ ...base, lidoEm: null, leitura: { causa: 'demorou' } }).texto, 'Descartada: não deu para conferir o preço (a loja demorou demais)');
});

test('decidir (R1): várias versões e o link não diz qual: esgotado e o menor preço acima do limite descartam; o resto é sem conferência, nunca "conferido"', () => {
  const v = (extra) => ({ varias: true, ...extra });
  assert.equal(decidir({ ...base, leitura: v({ price: null, disponivel: false }) }).motivo, 'esgotado');
  assert.equal(decidir({ ...base, leitura: v({ price: 120, disponivel: true }) }).texto, 'Descartada: preço subiu de R$ 100,00 para R$ 120,00 (+20%, o limite é 5%)');
  const causa = 'o produto tem várias versões e o link não diz qual';
  // até o limite, igual ou mais barato: não dá para saber o preço do anúncio
  for (const price of [105, 100, 80]) {
    assert.deepEqual(decidir({ ...base, leitura: v({ price, disponivel: true }) }), { acao: 'enviar', conferido: false, precoNovo: null, sufixo: ` · preço não conferido (${causa})` }, String(price));
    assert.deepEqual(decidir({ ...base, lidoEm: T0 - 31 * MIN, leitura: v({ price, disponivel: true }) }), { acao: 'descartar', motivo: 'nao_conferido', texto: `Descartada: não deu para conferir o preço (${causa})`, causa: 'varias_versoes' });
  }
  // sem preço (versões misturadas), e sem referência para comparar: idem; a causa da leitura não vale mais que `varias`
  assert.equal(decidir({ ...base, leitura: v({ price: null, disponivel: null, causa: 'sem_preco' }) }).sufixo, ` · preço não conferido (${causa})`);
  assert.equal(decidir({ ...base, referencia: null, leitura: v({ price: 90, disponivel: true }) }).sufixo, ` · preço não conferido (${causa})`);
  // só o true literal liga
  for (const varias of ['true', 1, {}]) assert.equal(decidir({ ...base, leitura: { price: 100, disponivel: true, varias } }).conferido, true, JSON.stringify(varias));
});

// ---------------------------------------------------------------------------------------------- conferir
test('conferir (ML): lê pelo conferirProduto e sai com o preço novo, o desconto recalculado e o vistoEm (CA1, CA3)', async () => {
  const ml = mlFalso({ price: 90, disponivel: true });
  const v = createVerificador({ db: novoDb(), ml, amazon: amazonFalsa(proibido('amazon')), shopee: shopeeFalsa(proibido('shopee')), agora: () => T0 });
  const entrada = ofertaMl({ vistoEm: 1 });
  const r = await v.conferir(entrada, { lidoEm: null });
  assert.deepEqual(ml.chamadas, [[URL_ML]]);
  assert.equal(r.acao, 'enviar');
  assert.equal(r.conferido, true);
  assert.equal(r.sufixo, ' · preço atualizado de R$ 100,00 para R$ 90,00');
  assert.deepEqual([r.oferta.price, r.oferta.oldPrice, r.oferta.discountPct, r.oferta.vistoEm], [90, 150, 40, T0]);
  assert.equal(entrada.price, 100, 'a oferta de entrada não muda');
  assert.equal(entrada.vistoEm, 1);
  // o preço antigo que ficou menor que o atual sai da oferta (e o desconto vai a 0)
  const r2 = await createVerificador({ db: novoDb(), ml: mlFalso({ price: 104, disponivel: true }), agora: () => T0 })
    .conferir(ofertaMl({ oldPrice: 102, discountPct: 2 }));
  assert.deepEqual([r2.oferta.price, r2.oferta.oldPrice, r2.oferta.discountPct], [104, null, 0]);
  // a hora do preço vai ao template ({HORA_PRECO})
  const hora = new Date(2026, 0, 15, 14, 32).getTime();
  const r3 = await createVerificador({ db: novoDb(), ml: mlFalso({ price: 100, disponivel: true }), agora: () => hora }).conferir(ofertaMl());
  assert.equal(renderTemplate('Preço visto às {HORA_PRECO}', { ...r3.oferta, link: 'x' }), 'Preço visto às 14h32');
});

test('conferir (ML): esgotado (com ou sem preço) descarta; "Catálogo" com loja ml também é lido (CA1, CA2)', async () => {
  for (const resposta of [{ price: 100, disponivel: false }, { price: null, disponivel: false }]) {
    const v = createVerificador({ db: novoDb(), ml: mlFalso(resposta), agora: () => T0 });
    assert.deepEqual(await v.conferir(ofertaMl(), { lidoEm: T0 }), { acao: 'descartar', motivo: 'esgotado', texto: 'Descartada: esgotado na loja' });
  }
  const ml = mlFalso({ price: 100, disponivel: true });
  const r = await createVerificador({ db: novoDb(), ml, agora: () => T0 }).conferir(ofertaMl({ loja: 'ml' }));
  assert.equal(ml.chamadas.length, 1);
  assert.equal(r.conferido, true);
});

test('conferir (ML): exceção do leitor é "a loja não respondeu"; no console só a loja e o e.name (CA4)', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const segredo = `${URL_ML}?tracking=abc`;
  const ml = { conferirProduto: async () => { const e = new TypeError(`falhou ${segredo} <html>corpo</html>`); throw e; } };
  const v = createVerificador({ db: novoDb(), ml, agora: () => T0 });
  const velho = await v.conferir(ofertaMl(), { lidoEm: T0 - 31 * MIN });
  assert.deepEqual(velho, { acao: 'descartar', motivo: 'nao_conferido', texto: 'Descartada: não deu para conferir o preço (a loja não respondeu)', causa: 'loja_fora' });
  const fresco = await v.conferir(ofertaMl({ vistoEm: 5 }), { lidoEm: T0 - 10 * MIN });
  assert.equal(fresco.acao, 'enviar');
  assert.equal(fresco.conferido, false);
  assert.equal(fresco.sufixo, ' · preço não conferido (a loja não respondeu)');
  assert.equal(fresco.oferta.price, 100);
  assert.equal('vistoEm' in fresco.oferta, false, 'sem conferência não há hora do preço');
  assert.equal(log.mock.callCount(), 2);
  for (const c of log.mock.calls) {
    const linha = c.arguments.map(String).join(' ');
    assert.equal(linha, '[verificador] conferência sem resposta (mercadolivre): TypeError');
    assert.ok(!linha.includes('mercadolivre.com.br') && !linha.includes('corpo'));
  }
  // leitor que lança de forma síncrona e "erro" que não é Error
  const sincrono = createVerificador({ db: novoDb(), ml: { conferirProduto: () => { throw 'texto solto'; } }, agora: () => T0 });
  assert.equal((await sincrono.conferir(ofertaMl())).motivo, 'nao_conferido');
  assert.equal(log.mock.calls.at(-1).arguments.map(String).join(' '), '[verificador] conferência sem resposta (mercadolivre): erro');
});

test('conferir (ML): o conferirProduto real com fixtures (API pausada → esgotado; página sem preço → sem conferência) (CA1, CA2, CA6)', async () => {
  const comFixtures = (fetchJson, fetchText) => ({ conferirProduto: (url) => conferirProduto(url, { fetchJson, fetchText }) });
  const pausado = comFixtures(async () => ({ id: 'MLB1234567890', title: 'Fone', price: 100, status: 'paused', available_quantity: 3 }), proibido('página'));
  assert.equal((await createVerificador({ db: novoDb(), ml: pausado, agora: () => T0 }).conferir(ofertaMl())).motivo, 'esgotado');
  const subiu = comFixtures(async () => ({ id: 'MLB1234567890', title: 'Fone', price: 120, status: 'active', available_quantity: 3 }), proibido('página'));
  assert.equal((await createVerificador({ db: novoDb(), ml: subiu, agora: () => T0 }).conferir(ofertaMl())).texto,
    'Descartada: preço subiu de R$ 100,00 para R$ 120,00 (+20%, o limite é 5%)');
  const semPreco = comFixtures(async () => { throw new Error('API 403'); }, async () => '<html><head><title>x</title></head></html>');
  assert.equal((await createVerificador({ db: novoDb(), ml: semPreco, agora: () => T0 }).conferir(ofertaMl(), { lidoEm: null })).texto,
    'Descartada: não deu para conferir o preço (a página não trouxe o preço)');
});

test('conferir (Amazon): lê pela API com fresco, pelo asin ou pela chave ASIN:, e respeita o estoque (CA1, CA2)', async () => {
  const amazon = amazonFalsa({ asin: ASIN, price: 95, oldPrice: 120, discountPct: 21, disponivel: true });
  const v = createVerificador({ db: novoDb(), amazon, agora: () => T0 });
  const r = await v.conferir({ loja: 'amazon', asin: ASIN, price: 100, oldPrice: 120, discountPct: 17 });
  assert.deepEqual(amazon.chamadas, [[ASIN, { fresco: true }]]);
  assert.deepEqual([r.acao, r.conferido, r.oferta.price, r.oferta.oldPrice, r.oferta.discountPct, r.oferta.vistoEm], ['enviar', true, 95, 120, 21, T0]);
  await v.conferir({ loja: 'amazon', key: `ASIN:${ASIN}`, url: `https://www.amazon.com.br/dp/${ASIN}`, price: 95 });
  assert.deepEqual(amazon.chamadas[1], [ASIN, { fresco: true }], 'ASIN da chave do Catálogo');
  const esgotada = createVerificador({ db: novoDb(), amazon: amazonFalsa({ price: 95, disponivel: false }), agora: () => T0 });
  assert.equal((await esgotada.conferir({ loja: 'amazon', asin: ASIN, price: 100 })).motivo, 'esgotado');
  // item que a API não devolveu (ou sem preço): sem conferência
  for (const resposta of [null, { price: null, disponivel: true }]) {
    const sem = createVerificador({ db: novoDb(), amazon: amazonFalsa(resposta), agora: () => T0 });
    assert.equal((await sem.conferir({ loja: 'amazon', asin: ASIN, price: 100 })).texto, 'Descartada: não deu para conferir o preço (a página não trouxe o preço)');
  }
  // sem ASIN algum: não chama a API
  const semAsin = amazonFalsa(proibido('lerItem'));
  assert.equal((await createVerificador({ db: novoDb(), amazon: semAsin, agora: () => T0 }).conferir({ loja: 'amazon', price: 100 })).motivo, 'nao_conferido');
  assert.equal(semAsin.chamadas.length, 0);
});

test('conferir (Amazon): o preço antigo que a leitura traz (R7) vale mais que o gravado; sem ele, vale o gravado', async () => {
  // preço caiu para 95; o "de" gravado era 120 e a Amazon agora diz 130
  const v = createVerificador({ db: novoDb(), amazon: amazonFalsa({ price: 95, oldPrice: 130, disponivel: true }), agora: () => T0 });
  const r = await v.conferir({ loja: 'amazon', asin: ASIN, price: 100, oldPrice: 120, discountPct: 17 });
  assert.deepEqual([r.oferta.price, r.oferta.oldPrice, r.oferta.discountPct], [95, 130, 27]);
  // a Amazon sem "de" agora: fica o gravado (a conta continua pelo preço antigo)
  const semDe = createVerificador({ db: novoDb(), amazon: amazonFalsa({ price: 95, oldPrice: null, disponivel: true }), agora: () => T0 });
  const r2 = await semDe.conferir({ loja: 'amazon', asin: ASIN, price: 100, oldPrice: 120, discountPct: 17 });
  assert.deepEqual([r2.oferta.price, r2.oferta.oldPrice, r2.oferta.discountPct], [95, 120, 21]);
  // sem "de" gravado e com o da leitura: o "de" da leitura aparece
  const r3 = await v.conferir({ loja: 'amazon', asin: ASIN, price: 100, oldPrice: null, discountPct: 0 });
  assert.deepEqual([r3.oferta.oldPrice, r3.oferta.discountPct], [130, 27]);
  // preço antigo da leitura abaixo do atual não vira "de"
  const menor = createVerificador({ db: novoDb(), amazon: amazonFalsa({ price: 95, oldPrice: 90, disponivel: true }), agora: () => T0 });
  assert.equal((await menor.conferir({ loja: 'amazon', asin: ASIN, price: 100, oldPrice: null })).oferta.oldPrice, null);
});

test('podeConferir: Magalu nunca; ML sempre; Amazon e Shopee só com a API ligada; simulado confere tudo menos a Magalu', () => {
  const ligado = createVerificador({ db: novoDb(), amazon: amazonFalsa(null), shopee: shopeeFalsa(null) });
  assert.deepEqual(['mercadolivre', 'ml', 'amazon', 'shopee', 'magalu', 'outra', undefined].map((l) => ligado.podeConferir(l)),
    [true, true, true, true, false, false, false]);
  const sem = createVerificador({ db: novoDb(), amazon: amazonFalsa(null, { configurado: false }), shopee: shopeeFalsa(null, { util: false }) });
  assert.deepEqual(['mercadolivre', 'amazon', 'shopee', 'magalu'].map((l) => sem.podeConferir(l)), [true, false, false, false]);
  assert.deepEqual(['amazon', 'shopee'].map((l) => createVerificador({ db: novoDb() }).podeConferir(l)), [false, false], 'sem cliente');
  const simulado = createVerificador({ db: novoDb(), simulado: true });
  assert.deepEqual(['mercadolivre', 'amazon', 'shopee', 'magalu'].map((l) => simulado.podeConferir(l)), [true, true, true, false]);
});

test('conferir (Amazon): sem API (sem cliente, não configurada ou recusada) e falha da API (CA4)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const oferta = { loja: 'amazon', asin: ASIN, price: 100 };
  const texto = 'Descartada: não deu para conferir o preço (a API da Amazon não está ligada)';
  assert.equal((await createVerificador({ db: novoDb(), amazon: null, agora: () => T0 }).conferir(oferta)).texto, texto);
  const desligada = amazonFalsa(proibido('lerItem'), { configurado: false });
  assert.equal((await createVerificador({ db: novoDb(), amazon: desligada, agora: () => T0 }).conferir(oferta)).texto, texto);
  assert.equal(desligada.chamadas.length, 0, 'não configurada: nenhuma chamada');
  for (const tipo of ['sem_credenciais', 'sem_tag', 'credenciais_invalidas', 'sem_acesso', 'tag_invalida']) {
    const v = createVerificador({ db: novoDb(), amazon: amazonFalsa(() => { throw new ErroAmazon(tipo); }), agora: () => T0 });
    assert.equal((await v.conferir(oferta)).texto, texto, tipo);
  }
  for (const tipo of ['cota', 'indisponivel', 'nao_encontrado']) {
    const v = createVerificador({ db: novoDb(), amazon: amazonFalsa(() => { throw new ErroAmazon(tipo); }), agora: () => T0 });
    assert.equal((await v.conferir(oferta)).texto, 'Descartada: não deu para conferir o preço (a loja não respondeu)', tipo);
  }
  // fresco: com dados de até 30 min, sai sem a hora do preço
  const fresca = await createVerificador({ db: novoDb(), amazon: null, agora: () => T0 }).conferir(oferta, { lidoEm: T0 - MIN });
  assert.deepEqual([fresca.acao, fresca.conferido, fresca.sufixo], ['enviar', false, ' · preço não conferido (a API da Amazon não está ligada)']);
});

test('conferir (Amazon): o cliente real sem credencial não vai à rede (CA4, CA6)', async () => {
  const db = novoDb();
  const antes = acessosRede;
  const amazon = createAmazon({ db, fetch: proibido('fetch da Amazon') });
  const r = await createVerificador({ db, amazon, agora: () => T0 }).conferir({ loja: 'amazon', asin: ASIN, price: 100 });
  assert.equal(r.texto, 'Descartada: não deu para conferir o preço (a API da Amazon não está ligada)');
  assert.equal(acessosRede, antes);
});

test('conferir (Shopee): só o preço, com fresco, ids de shopId/itemId, shop_id/item_id ou da chave (CA1)', async () => {
  const shopee = shopeeFalsa({ price: 80, disponivel: false, discountPct: 20, oldPrice: null });
  const v = createVerificador({ db: novoDb(), shopee, agora: () => T0 });
  const r = await v.conferir({ loja: 'shopee', shopId: SHOP, itemId: ITEM, price: 100, oldPrice: null, discountPct: 15 });
  assert.deepEqual(shopee.chamadas[0], [SHOP, ITEM, { fresco: true }]);
  // `disponivel` da Shopee é ignorado (a API não traz estoque); sem preço antigo, o desconto é o da leitura
  assert.deepEqual([r.acao, r.oferta.price, r.oferta.oldPrice, r.oferta.discountPct, r.oferta.vistoEm], ['enviar', 80, null, 20, T0]);
  await v.conferir({ loja: 'shopee', shop_id: SHOP, item_id: ITEM, price: 80 });
  await v.conferir({ loja: 'shopee', key: `SHOPEE:${SHOP}.${ITEM}`, url: 'https://s.shopee.com.br/abc123', price: 80 });
  await v.conferir({ loja: 'shopee', shopId: Number(SHOP), itemId: Number(ITEM), price: 80 });
  assert.deepEqual(shopee.chamadas.slice(1), [[SHOP, ITEM, { fresco: true }], [SHOP, ITEM, { fresco: true }], [SHOP, ITEM, { fresco: true }]]);
  // desconto fora de 1 a 99 na leitura: 0
  const r2 = await createVerificador({ db: novoDb(), shopee: shopeeFalsa({ price: 90, discountPct: 150 }), agora: () => T0 })
    .conferir({ loja: 'shopee', shopId: SHOP, itemId: ITEM, price: 100, discountPct: 15 });
  assert.equal(r2.oferta.discountPct, 0);
});

test('conferir (Shopee): produto não devolvido, sem API, cota e ids ausentes (CA4)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const oferta = { loja: 'shopee', shopId: SHOP, itemId: ITEM, price: 100 };
  const nao = (causa) => `Descartada: não deu para conferir o preço (${causa})`;
  assert.equal((await createVerificador({ db: novoDb(), shopee: shopeeFalsa(null), agora: () => T0 }).conferir(oferta)).texto, nao('a Shopee não devolveu o produto'));
  const semApi = shopeeFalsa(proibido('lerItem'), { util: false });
  assert.equal((await createVerificador({ db: novoDb(), shopee: semApi, agora: () => T0 }).conferir(oferta)).texto, nao('a API da Shopee não está ligada'));
  assert.equal(semApi.chamadas.length, 0);
  assert.equal((await createVerificador({ db: novoDb(), shopee: null, agora: () => T0 }).conferir(oferta)).texto, nao('a API da Shopee não está ligada'));
  const cota = createVerificador({ db: novoDb(), shopee: shopeeFalsa(() => { throw new ErroShopee('cota'); }), agora: () => T0 });
  assert.equal((await cota.conferir(oferta)).texto, nao('a loja não respondeu'));
  const recusada = createVerificador({ db: novoDb(), shopee: shopeeFalsa(() => { throw new ErroShopee('credencial_recusada'); }), agora: () => T0 });
  assert.equal((await recusada.conferir(oferta)).texto, nao('a API da Shopee não está ligada'));
  const semIds = shopeeFalsa(proibido('lerItem'));
  assert.equal((await createVerificador({ db: novoDb(), shopee: semIds, agora: () => T0 }).conferir({ loja: 'shopee', key: 'SHOPEE:abc', price: 100 })).texto, nao('a Shopee não devolveu o produto'));
  assert.equal(semIds.chamadas.length, 0);
});

test('conferir (Shopee): o cliente real com fresco relê a API mesmo com o cache válido (CA1, CA6)', async () => {
  const estado = { preco: '100.00' };
  const chamadas = [];
  const f = async (url, init) => {
    chamadas.push(url);
    assert.equal(url, URL_API);
    const no = { itemId: Number(ITEM), productName: 'Fone', priceMin: estado.preco, priceDiscountRate: 10 };
    return new Response(JSON.stringify({ data: { productOfferV2: { nodes: [no] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const shopee = createShopee({ fetch: f, agora: () => T0, lerConexao: () => ({ id_afiliado: '98765432101', app_id: '123456789', chave: 'chave-de-teste' }) });
  assert.equal((await shopee.lerItem(SHOP, ITEM)).price, 100, 'cache aquecido');
  estado.preco = '109.90';
  const r = await createVerificador({ db: novoDb(), shopee, agora: () => T0 }).conferir({ loja: 'shopee', shopId: SHOP, itemId: ITEM, price: 100 });
  assert.equal(chamadas.length, 2, 'a conferência foi à API');
  assert.equal(r.texto, 'Descartada: preço subiu de R$ 100,00 para R$ 109,90 (+10%, o limite é 5%)');
});

test('conferir (Magalu): nunca lê; até 30 min sai sem conferir, mais velha descarta (CA1, CA4)', async () => {
  const leitores = { ml: mlFalso(proibido('ml')), amazon: amazonFalsa(proibido('amazon')), shopee: shopeeFalsa(proibido('shopee')) };
  const v = createVerificador({ db: novoDb(), ...leitores, agora: () => T0 });
  const oferta = { loja: 'magalu', url: 'https://www.magazinevoce.com.br/loja/p/123/', price: 100, vistoEm: 9 };
  const nova = await v.conferir(oferta, { lidoEm: T0 - 5 * MIN });
  assert.deepEqual([nova.acao, nova.conferido, nova.sufixo, 'vistoEm' in nova.oferta], ['enviar', false, ' · preço não conferido (a Magalu não deixa ler a página)', false]);
  assert.deepEqual(await v.conferir(oferta, { lidoEm: T0 - 31 * MIN }),
    { acao: 'descartar', motivo: 'nao_conferido', texto: 'Descartada: não deu para conferir o preço (a Magalu não deixa ler a página)', causa: 'magalu' });
  assert.deepEqual([leitores.ml.chamadas.length, leitores.amazon.chamadas.length, leitores.shopee.chamadas.length], [0, 0, 0]);
});

test('conferir: loja desconhecida ou oferta inválida não lança e não sai sem dados frescos', async () => {
  const v = createVerificador({ db: novoDb(), ml: mlFalso(proibido('ml')), agora: () => T0 });
  assert.equal((await v.conferir({ loja: 'outra', price: 10 })).texto, 'Descartada: não deu para conferir o preço (a loja não respondeu)');
  assert.equal((await v.conferir({ loja: 'outra', price: 10 }, { lidoEm: T0 })).acao, 'enviar');
  for (const oferta of [null, undefined, 'x', 42]) {
    assert.deepEqual(await v.conferir(oferta), { acao: 'descartar', motivo: 'nao_conferido', texto: 'Descartada: não deu para conferir o preço (a loja não respondeu)', causa: 'loja_fora' });
  }
});

test('conferir: a leitura leva no máximo 20 s; a promessa perdedora não deixa rejeição sem tratamento (CA4)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const soltas = [];
  const pegar = (e) => soltas.push(e);
  process.on('unhandledRejection', pegar);
  t.after(() => process.off('unhandledRejection', pegar));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejeitar;
  const ml = { conferirProduto: () => new Promise((_, rej) => { rejeitar = rej; }) };
  const v = createVerificador({ db: novoDb(), ml, agora: () => T0 });
  let pronto = null;
  const p = v.conferir(ofertaMl(), { lidoEm: T0 - MIN }).then((r) => { pronto = r; return r; });
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(TEMPO_MAX_MS - 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(pronto, null, 'antes de 20 s ainda espera a loja');
  t.mock.timers.tick(1);
  const r = await p;
  assert.deepEqual([r.acao, r.conferido, r.sufixo], ['enviar', false, ' · preço não conferido (a loja demorou demais)']);
  // a loja falha depois de perder a corrida
  rejeitar(new Error('tarde demais'));
  await new Promise((r2) => setImmediate(r2));
  await new Promise((r2) => setImmediate(r2));
  assert.deepEqual(soltas, []);
  // dados velhos: a demora descarta
  const v2 = createVerificador({ db: novoDb(), ml: { conferirProduto: () => new Promise(() => {}) }, agora: () => T0, tempoMaxMs: 500 });
  const p2 = v2.conferir(ofertaMl(), { lidoEm: null });
  await new Promise((r2) => setImmediate(r2));
  t.mock.timers.tick(500);
  assert.equal((await p2).texto, 'Descartada: não deu para conferir o preço (a loja demorou demais)');
});

test('conferir: o timer do prazo é limpo quando a loja responde antes', async (t) => {
  const limpos = t.mock.method(globalThis, 'clearTimeout');
  const v = createVerificador({ db: novoDb(), ml: mlFalso({ price: 100, disponivel: true }), agora: () => T0 });
  const r = await v.conferir(ofertaMl());
  assert.equal(r.conferido, true);
  assert.equal(limpos.mock.callCount(), 1);
  assert.ok(limpos.mock.calls[0].arguments[0] != null);
});

// ---------------------------------------------------------------------------------- Ajustes, desligado, simulado
test('verificador: ativo() e limitePct() leem os Ajustes (ausente = ligado e 5; fora de 0 a 50 = 5) (CA7)', () => {
  const db = novoDb();
  const v = createVerificador({ db });
  assert.equal(v.ativo(), true);
  assert.equal(v.limitePct(), 5);
  setSetting(db, 'verificador_ativo', '0');
  assert.equal(v.ativo(), false);
  setSetting(db, 'verificador_ativo', '1');
  assert.equal(v.ativo(), true);
  for (const [valor, esperado] of [['0', 0], ['10', 10], ['50', 50], ['51', 5], ['-1', 5], ['x', 5], ['2.5', 5], ['', 5], ['100', 5]]) {
    setSetting(db, 'verificador_limite_pct', valor);
    assert.equal(v.limitePct(), esperado, valor);
  }
  const semDb = createVerificador({});
  assert.deepEqual([semDb.ativo(), semDb.limitePct()], [true, 5]);
});

test('conferir: o limite dos Ajustes vale na decisão (CA3, CA7)', async () => {
  const db = novoDb();
  setSetting(db, 'verificador_limite_pct', '10');
  const v = createVerificador({ db, ml: mlFalso({ price: 108, disponivel: true }), agora: () => T0 });
  assert.equal((await v.conferir(ofertaMl())).acao, 'enviar');
  setSetting(db, 'verificador_limite_pct', '0');
  assert.equal((await v.conferir(ofertaMl())).texto, 'Descartada: preço subiu de R$ 100,00 para R$ 108,00 (+8%, o limite é 0%)');
});

test('conferir: a referência (preco_loja) vale no lugar do preço da oferta; preço digitado é mantido (CA3)', async () => {
  const v = createVerificador({ db: novoDb(), ml: mlFalso({ price: 95, disponivel: true }), agora: () => T0 });
  const digitado = await v.conferir(ofertaMl({ price: 79.9 }), { referencia: 100 });
  assert.deepEqual([digitado.acao, digitado.oferta.price, digitado.sufixo, digitado.oferta.vistoEm], ['enviar', 79.9, null, T0]);
  assert.equal((await v.conferir(ofertaMl({ price: 79.9 }), { referencia: 90 })).texto, 'Descartada: preço subiu de R$ 90,00 para R$ 95,00 (+6%, o limite é 5%)');
  const lista = await v.conferir(ofertaMl({ price: 100, digitado: true }));
  assert.deepEqual([lista.oferta.price, lista.sufixo], [100, null]);
});

test('conferir: desligado não lê a loja e sai sem vistoEm nem sufixo (CA7)', async () => {
  const db = novoDb();
  setSetting(db, 'verificador_ativo', '0');
  const leitores = { ml: mlFalso(proibido('ml')), amazon: amazonFalsa(proibido('amazon')), shopee: shopeeFalsa(proibido('shopee')) };
  const v = createVerificador({ db, ...leitores, agora: () => T0 });
  for (const oferta of [ofertaMl({ vistoEm: 123 }), { loja: 'amazon', asin: ASIN, price: 1 }, { loja: 'shopee', shopId: SHOP, itemId: ITEM }, { loja: 'magalu' }]) {
    const r = await v.conferir(oferta, { lidoEm: null });
    assert.deepEqual([r.acao, r.conferido, r.sufixo, 'vistoEm' in r.oferta], ['enviar', false, null, false]);
  }
  assert.deepEqual([leitores.ml.chamadas.length, leitores.amazon.chamadas.length, leitores.shopee.chamadas.length], [0, 0, 0]);
});

test('conferir: simulado (DRY_RUN) confirma sem ler a loja; a Magalu segue sem conferência (CA7)', async () => {
  const leitores = { ml: mlFalso(proibido('ml')), amazon: amazonFalsa(proibido('amazon')), shopee: shopeeFalsa(proibido('shopee')) };
  const v = createVerificador({ db: novoDb(), ...leitores, simulado: true, agora: () => T0 });
  for (const oferta of [ofertaMl(), { loja: 'amazon', asin: ASIN, price: 50 }, { loja: 'shopee', shopId: SHOP, itemId: ITEM, price: 30 }]) {
    const r = await v.conferir(oferta, { lidoEm: null });
    assert.deepEqual([r.acao, r.conferido, r.sufixo, r.oferta.vistoEm, r.oferta.price], ['enviar', true, null, T0, oferta.price]);
  }
  assert.deepEqual([leitores.ml.chamadas.length, leitores.amazon.chamadas.length, leitores.shopee.chamadas.length], [0, 0, 0]);
  assert.equal((await v.conferir({ loja: 'magalu', price: 10 }, { lidoEm: null })).motivo, 'nao_conferido');
});

test('conferir: falha inesperada (banco quebrado) não lança e segue a regra do frescor', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const db = { prepare: () => { throw new Error('SQLITE_CORRUPT com parâmetros secretos'); } };
  const v = createVerificador({ db, ml: mlFalso(proibido('ml')), agora: () => T0 });
  assert.equal((await v.conferir(ofertaMl(), { lidoEm: null })).motivo, 'nao_conferido');
  const r = await v.conferir(ofertaMl({ vistoEm: 3 }), { lidoEm: T0 });
  assert.deepEqual([r.acao, r.conferido, r.sufixo, 'vistoEm' in r.oferta], ['enviar', false, ' · preço não conferido (a loja não respondeu)', false]);
  for (const c of log.mock.calls) assert.equal(c.arguments.map(String).join(' '), '[verificador] falha inesperada: Error');
});

test('verificador: textos e sufixos são só frases fixas, CAUSAS e preços (nada vindo da loja)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const respostas = [
    { price: '<script>alert(1)</script>', disponivel: 'nao' }, { price: 100, disponivel: 'OutOfStock' }, { price: 150, disponivel: true },
    { price: 50, disponivel: true, title: 'https://golpe.example' }, { price: 100, disponivel: false }, null, undefined, 'texto',
    { price: 1e9 }, { price: 0.01 },
  ];
  const casos = [];
  for (const resposta of respostas) {
    for (const lidoEm of [null, T0]) {
      const v = createVerificador({ db: novoDb(), ml: mlFalso(resposta), agora: () => T0 });
      casos.push(await v.conferir(ofertaMl(), { lidoEm }));
    }
  }
  const lancando = createVerificador({ db: novoDb(), ml: { conferirProduto: async () => { throw new Error(`erro em ${URL_ML}`); } }, agora: () => T0 });
  casos.push(await lancando.conferir(ofertaMl()), await lancando.conferir(ofertaMl(), { lidoEm: T0 }));
  for (const r of casos) {
    textosLimpos(r);
    const tudo = JSON.stringify([r.texto, r.sufixo]);
    assert.ok(!/script|golpe|mercadolivre|OutOfStock/.test(tudo), tudo);
  }
  assert.ok(casos.some((r) => r.acao === 'descartar') && casos.some((r) => r.sufixo));
  // a alta disponivel 'nao' (não booleano) não é esgotado
  const r = await createVerificador({ db: novoDb(), ml: mlFalso({ price: 100, disponivel: 'nao' }), agora: () => T0 }).conferir(ofertaMl());
  assert.equal(r.acao, 'enviar');
});

// ---------------------------------------------------------------------------------- ML pela extensão (entrega 2)
/** links falso: modo de link e requestProduto que conta as chamadas (resposta fixa, função ou promessa). */
function linksFalso(resposta, { modo = 'extension' } = {}) {
  const chamadas = [];
  const l = {
    chamadas,
    modo: () => (typeof modo === 'function' ? modo() : modo),
    requestProduto: async (...args) => { chamadas.push(args); return typeof resposta === 'function' ? resposta(...args) : resposta; },
  };
  return l;
}

test('conferir (ML, extensão): no modo extension lê só pela extensão, nunca pelo servidor (CA1, D5, D9)', async () => {
  const links = linksFalso({ price: 90, disponivel: true });
  const ml = { conferirProduto: proibido('ml.conferirProduto') };
  const v = createVerificador({ db: novoDb(), ml, links, amazon: amazonFalsa(proibido('amazon')), shopee: shopeeFalsa(proibido('shopee')), agora: () => T0 });
  const r = await v.conferir(ofertaMl({ vistoEm: 1 }), { lidoEm: null });
  assert.deepEqual(links.chamadas, [[{ url: URL_ML }]]);
  assert.deepEqual([r.acao, r.conferido, r.sufixo], ['enviar', true, ' · preço atualizado de R$ 100,00 para R$ 90,00']);
  assert.deepEqual([r.oferta.price, r.oferta.oldPrice, r.oferta.discountPct, r.oferta.vistoEm], [90, 150, 40, T0]);
  // a oferta do Catálogo (loja 'ml') e a URL de catálogo /p/ também vão à extensão; o anúncio que a oferta conhece
  // (a chave MLB…, o metadata.id da Central, ou o item_id do payload) vai como pdp_filters (R1)
  const url = 'https://www.mercadolivre.com.br/fone-bom/p/MLB12345678';
  const r2 = await v.conferir(ofertaMl({ loja: 'ml', url }));
  assert.equal(r2.conferido, true);
  assert.deepEqual(links.chamadas.at(-1), [{ url: `${url}?pdp_filters=item_id:MLB1234567890` }]);
  await v.conferir(ofertaMl({ url, key: undefined, item_id: 'MLB5257531512' }));
  assert.deepEqual(links.chamadas.at(-1), [{ url: `${url}?pdp_filters=item_id:MLB5257531512` }]);
  // sem anúncio (a chave é o próprio catálogo, ou o meli.la colado): só o catálogo; o rastreio de terceiro sai
  for (const key of ['MLB12345678', 'https://meli.la/1AbCdEf', undefined]) {
    await v.conferir(ofertaMl({ url: `${url}?matt_tool=1#polycard`, key }));
    assert.deepEqual(links.chamadas.at(-1), [{ url }], String(key));
  }
  // o resumo de várias versões chega ao decidir: o menor preço acima do limite descarta; senão, sem conferência
  const variasSubiu = createVerificador({ db: novoDb(), ml, links: linksFalso({ price: 130, disponivel: true, varias: true }), agora: () => T0 });
  assert.equal((await variasSubiu.conferir(ofertaMl({ url, key: undefined }))).motivo, 'preco_subiu');
  const variasOk = createVerificador({ db: novoDb(), ml, links: linksFalso({ price: 90, disponivel: true, varias: true }), agora: () => T0 });
  const rv = await variasOk.conferir(ofertaMl({ url, key: undefined }), { lidoEm: T0 });
  assert.deepEqual([rv.acao, rv.conferido, rv.sufixo, rv.oferta.price], ['enviar', false, ' · preço não conferido (o produto tem várias versões e o link não diz qual)', 100]);
  // preço acima do limite descarta como na leitura pelo servidor
  const subiu = createVerificador({ db: novoDb(), ml, links: linksFalso({ price: 120, disponivel: true }), agora: () => T0 });
  assert.equal((await subiu.conferir(ofertaMl())).texto, 'Descartada: preço subiu de R$ 100,00 para R$ 120,00 (+20%, o limite é 5%)');
  // o ML pela extensão segue "conferível" (a desconexão é passageira)
  assert.equal(v.podeConferir('mercadolivre'), true);
});

test('conferir (ML, extensão): esgotado só com disponivel false (com ou sem preço); sem preço é "a página não trouxe o preço" (CA2)', async () => {
  const ml = { conferirProduto: proibido('ml.conferirProduto') };
  for (const resposta of [{ price: null, disponivel: false }, { price: 100, disponivel: false }]) {
    const v = createVerificador({ db: novoDb(), ml, links: linksFalso(resposta), agora: () => T0 });
    assert.deepEqual(await v.conferir(ofertaMl(), { lidoEm: T0 }), { acao: 'descartar', motivo: 'esgotado', texto: 'Descartada: esgotado na loja' });
  }
  for (const resposta of [{ price: null, disponivel: true }, { price: null, disponivel: null }, { price: 0, disponivel: true }, {}]) {
    const v = createVerificador({ db: novoDb(), ml, links: linksFalso(resposta), agora: () => T0 });
    assert.equal((await v.conferir(ofertaMl(), { lidoEm: null })).texto, 'Descartada: não deu para conferir o preço (a página não trouxe o preço)', JSON.stringify(resposta));
    const fresco = await v.conferir(ofertaMl(), { lidoEm: T0 - 29 * MIN });
    assert.deepEqual([fresco.acao, fresco.conferido, fresco.sufixo], ['enviar', false, ' · preço não conferido (a página não trouxe o preço)']);
  }
  // disponivel que não é booleano não é esgotado
  const v = createVerificador({ db: novoDb(), ml, links: linksFalso({ price: 100, disponivel: 'OutOfStock' }), agora: () => T0 });
  assert.deepEqual([(await v.conferir(ofertaMl())).acao, (await v.conferir(ofertaMl())).conferido], ['enviar', true]);
});

test('conferir (ML, extensão): cada falha vira a sua causa, com a regra dos 30 min (29 sai, 31 descarta) (CA3, CA4, CA6, D8)', async () => {
  const ml = { conferirProduto: proibido('ml.conferirProduto') };
  const casos = [
    [{ falha: 'desconectada' }, 'a extensão do Chrome não está conectada'],
    [{ falha: 'antiga' }, 'a extensão do Chrome precisa ser recarregada'],
    [{ falha: 'verificacao' }, 'o Mercado Livre pediu verificação no navegador'],
    [{ falha: 'limite' }, 'o limite de conferências por hora foi atingido'],
    [{ falha: 'tempo' }, 'a loja demorou demais'],
    [{ falha: 'erro' }, 'a loja não respondeu'],
    // falha desconhecida, que não é texto, ou nome herdado do protótipo: "a loja não respondeu"
    [{ falha: 'xyz' }, 'a loja não respondeu'],
    [{ falha: 'toString' }, 'a loja não respondeu'],
    [{ falha: 'constructor' }, 'a loja não respondeu'],
    [{ falha: 1 }, 'a loja não respondeu'],
    [{ falha: ['antiga'] }, 'a loja não respondeu'],
    [{ falha: undefined, price: 100, disponivel: true }, 'a loja não respondeu'],
    // resposta fora do contrato (requestProduto nunca devolve isso): sem conferência
    [null, 'a loja não respondeu'],
    [undefined, 'a loja não respondeu'],
    ['texto', 'a loja não respondeu'],
  ];
  const chaveDe = (frase) => Object.keys(CAUSAS).find((k) => CAUSAS[k] === frase);
  for (const [resposta, causa] of casos) {
    const links = linksFalso(resposta);
    const v = createVerificador({ db: novoDb(), ml, links, agora: () => T0 });
    const nome = JSON.stringify(resposta) ?? String(resposta);
    const fresco = await v.conferir(ofertaMl({ vistoEm: 7 }), { lidoEm: T0 - 29 * MIN });
    assert.deepEqual([fresco.acao, fresco.conferido, fresco.sufixo, fresco.oferta.price, 'vistoEm' in fresco.oferta],
      ['enviar', false, ` · preço não conferido (${causa})`, 100, false], nome);
    assert.deepEqual(await v.conferir(ofertaMl(), { lidoEm: T0 - 31 * MIN }),
      { acao: 'descartar', motivo: 'nao_conferido', texto: `Descartada: não deu para conferir o preço (${causa})`, causa: chaveDe(causa) }, nome);
    assert.deepEqual(await v.conferir(ofertaMl(), { lidoEm: null }),
      { acao: 'descartar', motivo: 'nao_conferido', texto: `Descartada: não deu para conferir o preço (${causa})`, causa: chaveDe(causa) }, nome);
    assert.equal(links.chamadas.length, 3, nome);
  }
});

test('conferir (ML, extensão): URL que não é de anúncio ou catálogo do ML é "a loja não respondeu" sem pedido à extensão (D8, S1)', async () => {
  const links = linksFalso(proibido('requestProduto'));
  const v = createVerificador({ db: novoDb(), ml: { conferirProduto: proibido('ml.conferirProduto') }, links, agora: () => T0 });
  const fora = [
    'http://produto.mercadolivre.com.br/MLB-1234567890-fone-_JM', 'https://produto.mercadolibre.com/MLB-1', 'https://meli.la/abc123',
    'https://produto.mercadolivre.com.br.golpe.example/MLB-1', 'https://golpemercadolivre.com.br/MLB-1',
    'https://user@produto.mercadolivre.com.br/MLB-1', 'https://:senha@produto.mercadolivre.com.br/MLB-1',
    'https://produto.mercadolivre.com.br:8443/MLB-1',
    `https://produto.mercadolivre.com.br/MLB-1234567?x=${'a'.repeat(2048)}`, 'não é URL', '', undefined, null, 42,
    // S1: outras páginas do Mercado Livre (a extensão busca com a sessão do dono)
    'https://mercadolivre.com.br/MLB-1234567', 'https://www.mercadolivre.com.br/jms/mlb/lgz/logout', 'https://myaccount.mercadolivre.com.br/MLB-1234567',
    'https://www.mercadolivre.com.br/social/p/MLB123', 'https://www.mercadolivre.com.br/carrinho', 'https://produto.mercadolivre.com.br/MLB-1',
  ];
  for (const url of fora) {
    const r = await v.conferir(ofertaMl({ url }), { lidoEm: null });
    assert.equal(r.texto, 'Descartada: não deu para conferir o preço (a loja não respondeu)', String(url));
  }
  assert.equal(links.chamadas.length, 0);
  // anúncio e catálogo nos dois hosts de produto valem
  const ok = linksFalso({ price: 100, disponivel: true });
  const v2 = createVerificador({ db: novoDb(), ml: { conferirProduto: proibido('ml.conferirProduto') }, links: ok, agora: () => T0 });
  for (const url of ['https://www.mercadolivre.com.br/MLB-1234567', 'https://www.mercadolivre.com.br/x/p/MLB1', 'https://produto.mercadolivre.com.br/MLB-1234567-x-_JM']) {
    assert.equal((await v2.conferir(ofertaMl({ url }))).conferido, true, url);
  }
  assert.equal(ok.chamadas.length, 3);
});

test('conferir (ML): modo direct, fake ou sem links lê pelo conferirProduto e não pede à extensão (CA8)', async () => {
  for (const [nome, links] of [
    ['direct', linksFalso(proibido('requestProduto'), { modo: 'direct' })],
    ['fake', linksFalso(proibido('requestProduto'), { modo: 'fake' })],
    ['sem links', null],
    ['links sem modo()', { requestProduto: proibido('requestProduto') }],
  ]) {
    const ml = mlFalso({ price: 90, disponivel: true });
    const v = createVerificador({ db: novoDb(), ml, links, agora: () => T0 });
    const r = await v.conferir(ofertaMl());
    assert.deepEqual(ml.chamadas, [[URL_ML]], nome);
    assert.deepEqual([r.conferido, r.oferta.price], [true, 90], nome);
    if (links?.chamadas) assert.equal(links.chamadas.length, 0, nome);
  }
  // o modo é lido a cada conferência (o dono troca o modo de link em Ajustes sem reiniciar)
  let modo = 'direct';
  const ml = mlFalso({ price: 100, disponivel: true });
  const links = linksFalso({ falha: 'desconectada' }, { modo: () => modo });
  const v = createVerificador({ db: novoDb(), ml, links, agora: () => T0 });
  assert.equal((await v.conferir(ofertaMl())).conferido, true);
  modo = 'extension';
  assert.equal((await v.conferir(ofertaMl(), { lidoEm: T0 })).sufixo, ' · preço não conferido (a extensão do Chrome não está conectada)');
  assert.deepEqual([ml.chamadas.length, links.chamadas.length], [1, 1]);
});

test('conferir (ML, extensão): simulado e desligado não pedem à extensão (CA8)', async () => {
  const links = linksFalso(proibido('requestProduto'));
  const ml = { conferirProduto: proibido('ml.conferirProduto') };
  const simulado = await createVerificador({ db: novoDb(), ml, links, simulado: true, agora: () => T0 }).conferir(ofertaMl(), { lidoEm: null });
  assert.deepEqual([simulado.acao, simulado.conferido, simulado.oferta.vistoEm], ['enviar', true, T0]);
  const db = novoDb();
  setSetting(db, 'verificador_ativo', '0');
  const desligado = await createVerificador({ db, ml, links, agora: () => T0 }).conferir(ofertaMl(), { lidoEm: null });
  assert.deepEqual([desligado.acao, desligado.conferido, desligado.sufixo], ['enviar', false, null]);
  assert.equal(links.chamadas.length, 0);
});

test('conferir (ML, extensão): requestProduto que lança (fora do contrato) é "a loja não respondeu", sem ler pelo servidor e sem vazar a mensagem', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const links = linksFalso(() => { throw new Error(`falhou ${URL_ML} token=abc`); });
  const v = createVerificador({ db: novoDb(), ml: { conferirProduto: proibido('ml.conferirProduto') }, links, agora: () => T0 });
  assert.equal((await v.conferir(ofertaMl())).texto, 'Descartada: não deu para conferir o preço (a loja não respondeu)');
  // modo() que lança também não cai na leitura pelo servidor
  const quebrado = { modo: () => { throw new Error('getMode quebrou'); }, requestProduto: proibido('requestProduto') };
  const v2 = createVerificador({ db: novoDb(), ml: { conferirProduto: proibido('ml.conferirProduto') }, links: quebrado, agora: () => T0 });
  assert.equal((await v2.conferir(ofertaMl(), { lidoEm: T0 })).sufixo, ' · preço não conferido (a loja não respondeu)');
  assert.equal(log.mock.callCount(), 2);
  for (const c of log.mock.calls) assert.equal(c.arguments.map(String).join(' '), '[verificador] conferência sem resposta (mercadolivre): Error');
});

test('conferir (ML, extensão): pedido que não volta é cortado no prazo do verificador ("a loja demorou demais")', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const links = linksFalso(() => new Promise(() => {}));
  const v = createVerificador({ db: novoDb(), ml: { conferirProduto: proibido('ml.conferirProduto') }, links, agora: () => T0, tempoMaxMs: 500 });
  const p = v.conferir(ofertaMl(), { lidoEm: T0 - 29 * MIN });
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(500);
  assert.equal((await p).sufixo, ' · preço não conferido (a loja demorou demais)');
});

// ---------------------------------------------------------------------------------- Amazon: releitura pelo Etiqueta
// (docs/produto/planos/rodar-sozinho-entrega1.md, etapa B2; CA1.3 a CA1.6 e CA1.11). O `catalogo` chega injetado e aqui é
// um falso com o contrato de confirmarPreco: nenhum teste fala com o Etiqueta.
const HORA = 60 * MIN;
const ofertaAmazon = (extra = {}) => ({
  loja: 'amazon', key: `ASIN:${ASIN}`, url: `https://www.amazon.com.br/dp/${ASIN}`, title: 'Fone Bom', price: 100, oldPrice: 150, discountPct: 33, ...extra,
});
/** catalogo falso: `resposta` fixa ou função (asin) → resposta; conta as chamadas. */
function catalogoFalso(resposta) {
  const chamadas = [];
  return { chamadas, confirmarPreco: async (asin) => { chamadas.push(asin); return typeof resposta === 'function' ? resposta(asin) : resposta; } };
}
const confirmado = (extra = {}) => ({ resultado: 'confirmado', preco: 90, precoAntigo: 150, descontoPct: 40, precoEm: T0 - 40 * 1000, ...extra });
const falha = (causa) => ({ resultado: 'falha', causa });
/** Verificador da regra do Catálogo: Amazon sem API (cliente ausente) e o catálogo falso. */
const comReleitura = (catalogo, extra = {}) => createVerificador({ db: novoDb(), amazon: null, catalogo, agora: () => T0, ...extra });
const chaveDe = (frase) => Object.keys(CAUSAS).find((k) => CAUSAS[k] === frase);

test('releitura (CA1.3): confirmada, a Amazon sem API envia o preço lido, conferido, com a hora do preço do Etiqueta', async () => {
  const catalogo = catalogoFalso(confirmado());
  const v = comReleitura(catalogo);
  const entrada = ofertaAmazon({ vistoEm: 1 });
  const r = await v.conferir(entrada, { lidoEm: null, releitura: { precoEm: T0 - 5 * HORA } });
  assert.deepEqual(catalogo.chamadas, [ASIN]);
  assert.deepEqual([r.acao, r.conferido, r.sufixo], ['enviar', true, ' · preço atualizado de R$ 100,00 para R$ 90,00']);
  assert.deepEqual([r.oferta.price, r.oferta.oldPrice, r.oferta.discountPct], [90, 150, 40]);
  assert.equal(r.oferta.vistoEm, T0 - 40 * 1000, 'vistoEm é o preco_em da resposta, não o da reserva nem agora()');
  assert.equal(entrada.price, 100, 'a oferta de entrada não muda');
  assert.equal(entrada.vistoEm, 1);
  textosLimpos(r);
  // preço igual: sai como veio, sem sufixo, ainda conferido; o ASIN também vem do campo `asin`
  const igual = await comReleitura(catalogoFalso(confirmado({ preco: 100, precoAntigo: null, descontoPct: null })))
    .conferir({ loja: 'amazon', asin: ASIN, price: 100, oldPrice: 150, discountPct: 33 }, { releitura: { precoEm: null } });
  assert.deepEqual([igual.acao, igual.conferido, igual.sufixo, igual.oferta.price, igual.oferta.vistoEm], ['enviar', true, null, 100, T0 - 40 * 1000]);
  // o preço antigo que a leitura não traz fica o gravado; o desconto é a conta
  const semDe = await comReleitura(catalogoFalso(confirmado({ preco: 95, precoAntigo: null, descontoPct: null })))
    .conferir(ofertaAmazon(), { releitura: { precoEm: null } });
  assert.deepEqual([semDe.oferta.price, semDe.oferta.oldPrice, semDe.oferta.discountPct], [95, 150, 37]);
  // a hora do preço da mensagem é a do Etiqueta ({HORA_PRECO})
  const hora = new Date(2026, 0, 15, 14, 32).getTime();
  const v2 = createVerificador({ db: novoDb(), amazon: null, catalogo: catalogoFalso(confirmado({ precoEm: hora })), agora: () => hora + 30 * 1000 });
  const r2 = await v2.conferir(ofertaAmazon(), { releitura: { precoEm: null } });
  assert.equal(renderTemplate('Preço visto às {HORA_PRECO}', { ...r2.oferta, link: 'x' }), 'Preço visto às 14h32');
});

test('releitura (CA1.4): preço acima do limite descarta preco_subiu; sem_preco descarta indisponivel; outro_produto descarta outro_produto', async () => {
  const subiu = await comReleitura(catalogoFalso(confirmado({ preco: 120, precoAntigo: null, descontoPct: null }))).conferir(ofertaAmazon(), { releitura: { precoEm: T0 } });
  assert.deepEqual(subiu, { acao: 'descartar', motivo: 'preco_subiu', texto: 'Descartada: preço subiu de R$ 100,00 para R$ 120,00 (+20%, o limite é 5%)' });
  // até o limite sai; o limite dos Ajustes vale
  assert.equal((await comReleitura(catalogoFalso(confirmado({ preco: 105 }))).conferir(ofertaAmazon(), { releitura: { precoEm: null } })).acao, 'enviar');
  const db = novoDb();
  setSetting(db, 'verificador_limite_pct', '0');
  const zero = createVerificador({ db, amazon: null, catalogo: catalogoFalso(confirmado({ preco: 101 })), agora: () => T0 });
  assert.equal((await zero.conferir(ofertaAmazon(), { releitura: { precoEm: null } })).motivo, 'preco_subiu');
  // a referência (preco_loja) vale no lugar do preço da oferta
  const ref = await comReleitura(catalogoFalso(confirmado({ preco: 120 }))).conferir(ofertaAmazon({ price: 79.9 }), { referencia: 119, releitura: { precoEm: null } });
  assert.equal(ref.acao, 'enviar');
  const sem = await comReleitura(catalogoFalso({ resultado: 'sem_preco' })).conferir(ofertaAmazon(), { releitura: { precoEm: T0 } });
  assert.deepEqual(sem, { acao: 'descartar', motivo: 'indisponivel', texto: 'Descartada: indisponível na loja (a página não mostra preço nem estoque)' });
  const outro = await comReleitura(catalogoFalso({ resultado: 'outro_produto' })).conferir(ofertaAmazon(), { releitura: { precoEm: T0 } });
  assert.deepEqual(outro, { acao: 'descartar', motivo: 'outro_produto', texto: 'Descartada: a página da loja abriu outro produto (o código não confere com a oferta)' });
  for (const r of [subiu, sem, outro]) textosLimpos(r);
  // o motivo novo vira OfertaDescartada com a frase própria (a fila usa isto)
  assert.equal(new OfertaDescartada('indisponivel').texto, 'Descartada: indisponível na loja');
  assert.equal(new OfertaDescartada('outro_produto').motivo, 'outro_produto');
  // nem indisponível nem outro produto pausam a releitura: a página foi lida
  const c = catalogoFalso({ resultado: 'sem_preco' });
  const v = comReleitura(c);
  await v.conferir(ofertaAmazon(), { releitura: { precoEm: T0 } });
  await v.conferir(ofertaAmazon(), { releitura: { precoEm: T0 } });
  assert.equal(c.chamadas.length, 2);
});

test('reservaValida (CA1.5): até 6 h atrás e até 5 min no futuro, limites inclusivos; o resto não vale', () => {
  const ok = [0, 1, 5 * HORA + 59 * MIN, 6 * HORA, -5 * MIN, -MIN];
  const nao = [6 * HORA + 1, 6 * HORA + MIN, -5 * MIN - 1, -6 * MIN, 24 * HORA, null, undefined, '2026-11-11T09:40:00', Number.NaN,
    Number.POSITIVE_INFINITY, {}, [T0]];
  for (const idade of ok) assert.equal(reservaValida(T0 - idade, T0), true, String(idade));
  for (const x of nao) {
    const precoEm = typeof x === 'number' && Number.isFinite(x) && x !== null && Math.abs(x) < 1e9 ? T0 - x : x;
    assert.equal(reservaValida(precoEm, T0), false, String(x));
  }
  assert.equal(reservaValida(T0, Number.NaN), false);
  assert.equal(reservaValida(T0, undefined), false);
  assert.equal(reservaValida(T0, null), false);
});

test('releitura (CA1.5): falhou, o preço visto há 5h59 envia; 6h01, sem data, inválido e mais de 5 min no futuro não', async () => {
  const sufixo = (hhmm) => ` · preço visto às ${hhmm}, não conferido agora (o Etiqueta não respondeu)`;
  const agora = new Date(2026, 10, 11, 15, 0).getTime();
  const rodar = (precoEm) => createVerificador({ db: novoDb(), amazon: null, catalogo: catalogoFalso(falha('fora_do_ar')), agora: () => agora })
    .conferir(ofertaAmazon({ vistoEm: 3 }), { releitura: { precoEm } });
  const cedo = await rodar(agora - 5 * HORA - 59 * MIN); // 09:01 do mesmo dia
  assert.deepEqual([cedo.acao, cedo.conferido, cedo.sufixo], ['enviar', false, sufixo('09:01')]);
  assert.deepEqual([cedo.oferta.price, cedo.oferta.vistoEm], [100, agora - 5 * HORA - 59 * MIN]);
  textosLimpos(cedo);
  assert.equal((await rodar(agora - 6 * HORA)).acao, 'enviar', 'exatamente 6 h ainda vale');
  assert.equal((await rodar(agora + 5 * MIN)).acao, 'enviar', '5 min no futuro vale (relógios um pouco diferentes)');
  const naoVale = [agora - 6 * HORA - MIN, agora + 5 * MIN + 1, agora + HORA, null, undefined, Number.NaN, '09:00', {}, -1 / 0];
  for (const precoEm of naoVale) {
    const r = await rodar(precoEm);
    assert.deepEqual(r, { acao: 'descartar', motivo: 'nao_conferido', texto: 'Descartada: não deu para conferir o preço (o Etiqueta não respondeu)', causa: 'etiqueta_fora', pelaReleitura: true }, String(precoEm));
    textosLimpos(r);
  }
  // sem o objeto `releitura.precoEm` (chave ausente) também não há reserva
  const sem = await createVerificador({ db: novoDb(), amazon: null, catalogo: catalogoFalso(falha('fora_do_ar')), agora: () => agora }).conferir(ofertaAmazon(), { releitura: {} });
  assert.equal(sem.acao, 'descartar');
  // de outro dia: a hora vem com a data, como no Histórico (03:00 de hoje, preço visto às 23:50 de ontem)
  const tresDaManha = new Date(2026, 10, 11, 3, 0).getTime();
  const ontem = await createVerificador({ db: novoDb(), amazon: null, catalogo: catalogoFalso(falha('fora_do_ar')), agora: () => tresDaManha })
    .conferir(ofertaAmazon(), { releitura: { precoEm: new Date(2026, 10, 10, 23, 50).getTime() } });
  assert.equal(ontem.sufixo, sufixo('23:50 de 10/11'));
  textosLimpos(ontem);
});

test('releitura (CA1.6): vistoEm é o preco_em, na releitura e na reserva, nunca agora()', async () => {
  const agora = T0 + 7 * HORA;
  const aRel = createVerificador({ db: novoDb(), amazon: null, catalogo: catalogoFalso(confirmado({ precoEm: agora - MIN })), agora: () => agora });
  const rel = await aRel.conferir(ofertaAmazon({ vistoEm: agora }), { releitura: { precoEm: agora - 5 * HORA } });
  assert.equal(rel.oferta.vistoEm, agora - MIN);
  const aRes = createVerificador({ db: novoDb(), amazon: null, catalogo: catalogoFalso(falha('bloqueado')), agora: () => agora });
  const res = await aRes.conferir(ofertaAmazon({ vistoEm: agora }), { releitura: { precoEm: agora - 5 * HORA } });
  assert.equal(res.oferta.vistoEm, agora - 5 * HORA);
  assert.notEqual(res.oferta.vistoEm, agora);
  // um vistoEm que veio na oferta nunca sobra quando a oferta é descartada ou o preço não tem hora
  assert.equal((await comReleitura(catalogoFalso(confirmado({ precoEm: T0 - MIN }))).conferir(ofertaAmazon({ vistoEm: 5 }), { releitura: { precoEm: null } })).oferta.vistoEm, T0 - MIN);
});

test('releitura: cada falha do Etiqueta vira a sua causa, na reserva (sufixo) e no descarte (causa)', async () => {
  // bloqueado e falha_rede: o Etiqueta tentou ler a página desta oferta agora (o descarte leva `releu`, achados Q1/R2)
  const daPagina = new Set(['falha_rede', 'bloqueado']);
  const mapa = [
    ['falha_rede', 'a loja não respondeu'], ['freio', 'o Etiqueta estava ocupado com outra leitura da Amazon'],
    ['bloqueado', 'a Amazon bloqueou a leitura'], ['fora_do_ar', 'o Etiqueta não respondeu'],
    ['token_recusado', 'o Etiqueta não respondeu'], ['desligada', 'o Etiqueta não respondeu'],
    ['resposta_inesperada', 'o Etiqueta não respondeu'], ['nao_configurada', 'o Etiqueta não respondeu'],
    // causa desconhecida, herdada do protótipo ou sem ser texto: "o Etiqueta não respondeu"
    ['xyz', 'o Etiqueta não respondeu'], ['toString', 'o Etiqueta não respondeu'], [undefined, 'o Etiqueta não respondeu'], [7, 'o Etiqueta não respondeu'],
  ];
  for (const [causa, frase] of mapa) {
    const reserva = await comReleitura(catalogoFalso(falha(causa))).conferir(ofertaAmazon(), { releitura: { precoEm: T0 - HORA } });
    assert.deepEqual([reserva.acao, reserva.conferido, reserva.sufixo.endsWith(`(${frase})`)], ['enviar', false, true], String(causa));
    textosLimpos(reserva);
    const descarte = await comReleitura(catalogoFalso(falha(causa))).conferir(ofertaAmazon(), { releitura: { precoEm: T0 - 7 * HORA } });
    assert.deepEqual(descarte, {
      acao: 'descartar', motivo: 'nao_conferido', texto: `Descartada: não deu para conferir o preço (${frase})`, causa: chaveDe(frase), pelaReleitura: true,
      ...(daPagina.has(causa) ? { releu: true } : {}),
    }, String(causa));
    textosLimpos(descarte);
  }
});

test('releitura (R1): o freio do Etiqueta segue o motivo — intervalo e ocupado não pausam; teto, pausa e rodada pausam pelo tentar_em_s', async () => {
  const freio = (motivo, tentarEmS) => ({ resultado: 'falha', causa: 'freio', motivo, tentarEmS });
  const velha = { releitura: { precoEm: T0 - 7 * HORA } }; // sem reserva: o descarte mostra a causa
  const casos = [
    // [motivo, tentarEmS, causa, pausa em ms (0 = não pausa)]
    ['intervalo', 2, 'etiqueta_ocupado', 0],
    ['ocupado', 3, 'etiqueta_ocupado', 0],
    ['teto', 120, 'limite_hora', 120 * 1000],
    ['pausa', 600, 'etiqueta_bloqueio', 600 * 1000],
    ['rodada', 60, 'etiqueta_ocupado', 60 * 1000],
    ['teto', null, 'limite_hora', 10 * MIN], // sem tentar_em_s: os 10 min de sempre
    ['teto', 99999, 'limite_hora', HORA], // no máximo 1 h
    [null, 30, 'etiqueta_ocupado', 30 * 1000], // motivo fora do contrato: pausa, sem dizer "limite por hora"
    ['xyz', null, 'etiqueta_ocupado', 10 * MIN],
  ];
  for (const [motivo, tentarEmS, causa, pausa] of casos) {
    const nome = `${motivo} ${tentarEmS}`;
    let agora = T0;
    const catalogo = catalogoFalso(freio(motivo, tentarEmS));
    const v = createVerificador({ db: novoDb(), amazon: null, catalogo, agora: () => agora });
    const r = await v.conferir(ofertaAmazon(), velha);
    assert.deepEqual([r.acao, r.causa, r.releu], ['descartar', causa, undefined], nome);
    assert.equal(r.texto, `Descartada: não deu para conferir o preço (${CAUSAS[causa]})`, nome);
    if (!pausa) {
      // nada pausado: a Amazon seguinte vai ao Etiqueta na hora
      assert.equal(v.semConfirmacaoAgora({ loja: 'amazon', precoEm: null }), false, nome);
      await v.conferir(ofertaAmazon({ key: 'ASIN:B000000002' }), velha);
      assert.equal(catalogo.chamadas.length, 2, nome);
      continue;
    }
    agora = T0 + pausa - 1;
    await v.conferir(ofertaAmazon({ key: 'ASIN:B000000002' }), velha);
    assert.equal(catalogo.chamadas.length, 1, `${nome}: pausada até ${pausa} ms`);
    agora = T0 + pausa;
    await v.conferir(ofertaAmazon({ key: 'ASIN:B000000002' }), velha);
    assert.equal(catalogo.chamadas.length, 2, `${nome}: depois da pausa pergunta de novo`);
  }
  // só o teto diz "limite de conferências por hora"
  const naReserva = await comReleitura(catalogoFalso(freio('intervalo', 3))).conferir(ofertaAmazon(), { releitura: { precoEm: T0 - HORA } });
  assert.ok(naReserva.sufixo.endsWith('(o Etiqueta estava ocupado com outra leitura da Amazon)'), naReserva.sufixo);
});

test('releitura (Q1/R2): `releu` só quando o Etiqueta tentou ler a página desta oferta agora (bloqueado, falha de rede)', async (t) => {
  const velha = { releitura: { precoEm: T0 - 7 * HORA } };
  for (const causa of ['bloqueado', 'falha_rede']) {
    const r = await comReleitura(catalogoFalso(falha(causa))).conferir(ofertaAmazon(), velha);
    assert.deepEqual([r.acao, r.releu, r.pelaReleitura], ['descartar', true, true], causa);
  }
  for (const resposta of [falha('fora_do_ar'), falha('token_recusado'), falha('resposta_inesperada'), falha('nao_encontrado'),
    { resultado: 'falha', causa: 'freio', motivo: 'pausa', tentarEmS: 600 }, { resultado: 'falha', causa: 'freio', motivo: 'intervalo', tentarEmS: 3 }]) {
    const r = await comReleitura(catalogoFalso(resposta)).conferir(ofertaAmazon(), velha);
    assert.deepEqual([r.acao, 'releu' in r, r.pelaReleitura], ['descartar', false, true], JSON.stringify(resposta));
  }
  // com a releitura já pausada (por outra oferta) a falha não é desta oferta
  const v = comReleitura(catalogoFalso(falha('bloqueado')));
  await v.conferir(ofertaAmazon(), velha);
  const seguinte = await v.conferir(ofertaAmazon({ key: 'ASIN:B000000002' }), velha);
  assert.deepEqual([seguinte.causa, 'releu' in seguinte], ['etiqueta_bloqueio', false]);
  // a demora do verificador também não (a fila do Etiqueta pode estar ocupada por outra regra)
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lento = createVerificador({ db: novoDb(), amazon: null, catalogo: { confirmarPreco: () => new Promise(() => {}) }, agora: () => T0, tempoMaxMs: 50 });
  const p = lento.conferir(ofertaAmazon(), velha);
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(50);
  const demorou = await p;
  assert.deepEqual([demorou.causa, 'releu' in demorou], ['demorou', false]);
  // as outras lojas não trazem nenhum dos dois sinais
  const ml = await createVerificador({ db: novoDb(), ml: mlFalso(null), agora: () => T0 }).conferir(ofertaMl(), { lidoEm: null });
  assert.deepEqual([ml.acao, 'releu' in ml, 'pelaReleitura' in ml], ['descartar', false, false]);
});

test('releitura (S2): o preco_em de um confirmado precisa ser desta releitura — de 3 dias atrás ou de 2 dias no futuro é resposta fora do contrato', async () => {
  const prazo = 20000;
  const casos = [
    [T0 - 3 * 24 * HORA, false], [T0 + 2 * 24 * HORA, false],
    [T0 - prazo - MIN, true], [T0 - prazo - MIN - 1, false], // o prazo da conferência + 1 min, inclusivo
    [T0 + 5 * MIN, true], [T0 + 5 * MIN + 1, false], [T0, true],
  ];
  for (const [precoEm, vale] of casos) {
    const nome = String(precoEm - T0);
    const v = createVerificador({ db: novoDb(), amazon: null, catalogo: catalogoFalso(confirmado({ precoEm })), agora: () => T0, tempoMaxMs: prazo });
    // com a reserva valendo: sai pela reserva, com a causa "o Etiqueta não respondeu", nunca como conferida
    const r = await v.conferir(ofertaAmazon(), { releitura: { precoEm: T0 - HORA } });
    if (vale) assert.deepEqual([r.acao, r.conferido, r.oferta.vistoEm], ['enviar', true, precoEm], nome);
    else assert.deepEqual([r.acao, r.conferido, r.sufixo.endsWith('(o Etiqueta não respondeu)'), r.oferta.vistoEm], ['enviar', false, true, T0 - HORA], nome);
    // sem reserva: descartada sem conferência
    const sem = await createVerificador({ db: novoDb(), amazon: null, catalogo: catalogoFalso(confirmado({ precoEm })), agora: () => T0, tempoMaxMs: prazo })
      .conferir(ofertaAmazon(), { releitura: { precoEm: T0 - 7 * HORA } });
    assert.equal(sem.acao, vale ? 'enviar' : 'descartar', nome);
    if (!vale) assert.equal(sem.causa, 'etiqueta_fora', nome);
  }
});

test('releitura: nao_encontrado (a oferta saiu do Etiqueta) não tem reserva e não pausa a releitura', async () => {
  const catalogo = catalogoFalso(falha('nao_encontrado'));
  const v = comReleitura(catalogo);
  const r = await v.conferir(ofertaAmazon(), { releitura: { precoEm: T0 - MIN } });
  assert.deepEqual(r, { acao: 'descartar', motivo: 'nao_conferido', texto: 'Descartada: não deu para conferir o preço (a oferta saiu do Etiqueta)', causa: 'etiqueta_sem_oferta', pelaReleitura: true });
  textosLimpos(r);
  await v.conferir(ofertaAmazon({ key: 'ASIN:B000000002' }), { releitura: { precoEm: T0 - MIN } });
  assert.deepEqual(catalogo.chamadas, [ASIN, 'B000000002'], 'a segunda também foi ao Etiqueta');
  assert.equal(v.semConfirmacaoAgora({ loja: 'amazon', precoEm: null }), false);
});

test('releitura (foco 4): a falha pausa a releitura por 10 min; as Amazon seguintes vão à reserva sem chamar o Etiqueta', async () => {
  let agora = T0;
  const estado = { falhar: true };
  const catalogo = catalogoFalso(() => (estado.falhar ? falha('bloqueado') : confirmado({ precoEm: agora })));
  const v = createVerificador({ db: novoDb(), amazon: null, catalogo, agora: () => agora });
  const rel = { releitura: { precoEm: T0 - HORA } };
  const primeira = await v.conferir(ofertaAmazon(), rel);
  assert.deepEqual([primeira.acao, catalogo.chamadas.length], ['enviar', 1]);
  assert.ok(primeira.sufixo.endsWith('(a Amazon bloqueou a leitura)'));
  // pausada: a reserva sai com a causa da falha que pausou, e o Etiqueta não é chamado
  for (const asin of ['B000000002', 'B000000003']) {
    const r = await v.conferir(ofertaAmazon({ key: `ASIN:${asin}` }), rel);
    assert.equal(r.acao, 'enviar');
    assert.ok(r.sufixo.endsWith('(a Amazon bloqueou a leitura)'), r.sufixo);
  }
  const velha = await v.conferir(ofertaAmazon({ key: 'ASIN:B000000004' }), { releitura: { precoEm: T0 - 7 * HORA } });
  assert.deepEqual([velha.acao, velha.causa], ['descartar', 'etiqueta_bloqueio']);
  assert.equal(catalogo.chamadas.length, 1, 'nenhuma chamada durante a pausa');
  agora = T0 + 10 * MIN - 1;
  await v.conferir(ofertaAmazon(), rel);
  assert.equal(catalogo.chamadas.length, 1, 'um ms antes dos 10 min ainda está pausada');
  // passados os 10 min, pergunta de novo; com sucesso volta a conferir
  agora = T0 + 10 * MIN;
  estado.falhar = false;
  const volta = await v.conferir(ofertaAmazon(), rel);
  assert.equal(catalogo.chamadas.length, 2);
  assert.deepEqual([volta.acao, volta.conferido, volta.oferta.price], ['enviar', true, 90]);
  assert.equal(volta.oferta.vistoEm, agora);
  // a pausa não acabou de vez: sem nova falha, a seguinte também chama
  await v.conferir(ofertaAmazon(), rel);
  assert.equal(catalogo.chamadas.length, 3);
  // falha de novo: pausa mais 10 min a partir de agora
  estado.falhar = true;
  agora += MIN;
  await v.conferir(ofertaAmazon(), rel);
  assert.equal(catalogo.chamadas.length, 4);
  agora += 9 * MIN;
  await v.conferir(ofertaAmazon(), rel);
  assert.equal(catalogo.chamadas.length, 4, 'a nova pausa conta a partir da nova falha');
  agora += MIN;
  await v.conferir(ofertaAmazon(), rel);
  assert.equal(catalogo.chamadas.length, 5);
});

test('releitura: a pausa é de cada verificador e não vale para as outras lojas nem para quem não pede releitura', async () => {
  const catalogo = catalogoFalso(falha('fora_do_ar'));
  const ml = mlFalso({ price: 100, disponivel: true });
  const v = createVerificador({ db: novoDb(), ml, amazon: null, catalogo, agora: () => T0 });
  await v.conferir(ofertaAmazon(), { releitura: { precoEm: T0 } });
  assert.equal(v.semConfirmacaoAgora({ loja: 'amazon', precoEm: T0 - 7 * HORA }), true);
  // o ML segue sendo lido, e a Amazon sem `releitura` segue como antes (API não ligada)
  assert.equal((await v.conferir(ofertaMl(), { releitura: { precoEm: null } })).conferido, true);
  assert.equal(ml.chamadas.length, 1);
  assert.equal((await v.conferir(ofertaAmazon(), { lidoEm: null })).causa, 'amazon_sem_api');
  assert.equal(catalogo.chamadas.length, 1);
  assert.equal(comReleitura(catalogoFalso(falha('fora_do_ar'))).semConfirmacaoAgora({ loja: 'amazon', precoEm: null }), false, 'outro verificador não está pausado');
});

test('releitura: resposta fora do contrato, exceção, sem catálogo e demora viram falha, com a reserva; nunca lança nem vaza', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const fora = [null, undefined, 'texto', 42, {}, { resultado: 'xyz' }, { resultado: 'confirmado' }, { resultado: 'confirmado', preco: 90 },
    { resultado: 'confirmado', preco: 0, precoEm: T0 }, { resultado: 'confirmado', preco: '90', precoEm: T0 }, { resultado: 'confirmado', preco: 90, precoEm: 'agora' },
    { resultado: 'confirmado', preco: 90, precoEm: Number.NaN }, { resultado: 'confirmado', preco: Number.POSITIVE_INFINITY, precoEm: T0 }];
  for (const resposta of fora) {
    const r = await comReleitura(catalogoFalso(resposta)).conferir(ofertaAmazon(), { releitura: { precoEm: T0 - HORA } });
    assert.ok(r.acao === 'enviar' && r.conferido === false && r.oferta.price === 100 && r.sufixo.endsWith('(o Etiqueta não respondeu)'), JSON.stringify(resposta));
    textosLimpos(r);
  }
  // exceção (síncrona ou não): só o e.name no console
  for (const lancar of [() => { throw new TypeError(`falhou http://127.0.0.1:8765 token=abc ${ASIN}`); }, async () => { throw new TypeError('token=abc'); }]) {
    const v = comReleitura({ confirmarPreco: lancar });
    const r = await v.conferir(ofertaAmazon(), { releitura: { precoEm: T0 - 7 * HORA } });
    assert.deepEqual([r.acao, r.causa], ['descartar', 'etiqueta_fora']);
  }
  const linhas = log.mock.calls.map((c) => c.arguments.map(String).join(' '));
  assert.deepEqual([...new Set(linhas)], ['[verificador] releitura sem resposta (amazon): TypeError']);
  // sem catálogo, ou catálogo sem confirmarPreco
  for (const catalogo of [null, {}, { confirmarPreco: 'x' }]) {
    const r = await createVerificador({ db: novoDb(), amazon: null, catalogo, agora: () => T0 }).conferir(ofertaAmazon(), { releitura: { precoEm: T0 - HORA } });
    assert.deepEqual([r.acao, r.conferido], ['enviar', false]);
  }
});

test('releitura: o Etiqueta que não responde é cortado no prazo do verificador ("a loja demorou demais") e vale a reserva', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const limpos = t.mock.method(globalThis, 'clearTimeout');
  const catalogo = { confirmarPreco: () => new Promise(() => {}) };
  const v = createVerificador({ db: novoDb(), amazon: null, catalogo, agora: () => T0, tempoMaxMs: 500 });
  const p = v.conferir(ofertaAmazon(), { releitura: { precoEm: T0 - HORA } });
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(499);
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(1);
  const r = await p;
  assert.deepEqual([r.acao, r.conferido, r.sufixo.endsWith('(a loja demorou demais)')], ['enviar', false, true]);
  assert.equal(limpos.mock.callCount(), 1, 'o timer do prazo é limpo');
  // a demora também pausa: a seguinte nem pergunta
  const seguinte = await v.conferir(ofertaAmazon({ key: 'ASIN:B000000002' }), { releitura: { precoEm: T0 - 7 * HORA } });
  assert.deepEqual([seguinte.acao, seguinte.causa], ['descartar', 'demorou']);
});

test('releitura (CA1.11): sem `releitura` nas opções a Amazon sem API segue como hoje; o Etiqueta não é chamado', async () => {
  const catalogo = catalogoFalso(proibido('confirmarPreco'));
  for (const opcoes of [{}, { lidoEm: null }, { lidoEm: null, releitura: null }, { releitura: undefined }, { releitura: false }, { releitura: 'sim' }]) {
    for (const amazon of [null, amazonFalsa(proibido('lerItem'), { configurado: false })]) {
      const v = createVerificador({ db: novoDb(), amazon, catalogo, agora: () => T0 });
      assert.deepEqual(await v.conferir(ofertaAmazon(), opcoes),
        { acao: 'descartar', motivo: 'nao_conferido', texto: 'Descartada: não deu para conferir o preço (a API da Amazon não está ligada)', causa: 'amazon_sem_api' }, JSON.stringify(opcoes));
    }
  }
  const fresca = await createVerificador({ db: novoDb(), amazon: null, catalogo, agora: () => T0 }).conferir(ofertaAmazon(), { lidoEm: T0 - MIN });
  assert.deepEqual([fresca.acao, fresca.sufixo], ['enviar', ' · preço não conferido (a API da Amazon não está ligada)']);
  assert.equal(catalogo.chamadas.length, 0);
});

test('releitura (CA1.11): com a API da Amazon ligada, a releitura não é chamada e vale a leitura da API', async () => {
  const catalogo = catalogoFalso(proibido('confirmarPreco'));
  const amazon = amazonFalsa({ price: 95, oldPrice: 120, discountPct: 21, disponivel: true });
  const v = createVerificador({ db: novoDb(), amazon, catalogo, agora: () => T0 });
  const r = await v.conferir(ofertaAmazon(), { releitura: { precoEm: T0 - HORA } });
  assert.deepEqual([r.acao, r.conferido, r.oferta.price, r.oferta.vistoEm], ['enviar', true, 95, T0]);
  assert.deepEqual(amazon.chamadas, [[ASIN, { fresco: true }]]);
  assert.equal(catalogo.chamadas.length, 0);
  // com a API ligada nada fica sem confirmação
  assert.equal(v.semConfirmacaoAgora({ loja: 'amazon', precoEm: null }), false);
});

test('releitura (CA1.11): verificador desligado ou simulado e ofertas de outras lojas não chamam o Etiqueta', async () => {
  const catalogo = catalogoFalso(proibido('confirmarPreco'));
  const rel = { releitura: { precoEm: T0 - HORA } };
  const db = novoDb();
  setSetting(db, 'verificador_ativo', '0');
  const desligado = await createVerificador({ db, amazon: null, catalogo, agora: () => T0 }).conferir(ofertaAmazon({ vistoEm: 4 }), rel);
  assert.deepEqual([desligado.acao, desligado.conferido, desligado.sufixo, 'vistoEm' in desligado.oferta], ['enviar', false, null, false]);
  const simulado = await createVerificador({ db: novoDb(), amazon: null, catalogo, simulado: true, agora: () => T0 }).conferir(ofertaAmazon(), rel);
  assert.deepEqual([simulado.acao, simulado.conferido, simulado.oferta.vistoEm], ['enviar', true, T0]);
  const outras = createVerificador({
    db: novoDb(), ml: mlFalso({ price: 100, disponivel: true }), shopee: shopeeFalsa({ price: 100 }), catalogo, agora: () => T0,
  });
  assert.equal((await outras.conferir(ofertaMl(), rel)).conferido, true);
  assert.equal((await outras.conferir({ loja: 'shopee', shopId: SHOP, itemId: ITEM, price: 100 }, rel)).conferido, true);
  assert.equal((await outras.conferir({ loja: 'magalu', price: 100 }, { ...rel, lidoEm: null })).motivo, 'nao_conferido');
  assert.equal(catalogo.chamadas.length, 0);
});

test('releitura: Amazon sem ASIN nem chave não chama o Etiqueta e não vai pela reserva', async () => {
  const catalogo = catalogoFalso(proibido('confirmarPreco'));
  const r = await comReleitura(catalogo).conferir({ loja: 'amazon', price: 100, key: 'qualquer' }, { releitura: { precoEm: T0 } });
  assert.deepEqual(r, { acao: 'descartar', motivo: 'nao_conferido', texto: 'Descartada: não deu para conferir o preço (a página não trouxe o preço)', causa: 'sem_preco', pelaReleitura: true });
  assert.equal(catalogo.chamadas.length, 0);
});

test('semConfirmacaoAgora: só a Amazon sem API, com o verificador ligado, a releitura pausada e a reserva sem validade', async () => {
  let agora = T0;
  const db = novoDb();
  const v = createVerificador({ db, amazon: null, catalogo: catalogoFalso(falha('bloqueado')), agora: () => agora });
  const pergunta = (precoEm, loja = 'amazon') => v.semConfirmacaoAgora({ loja, precoEm });
  // sem pausa nada fica de fora: a releitura ainda pode confirmar
  assert.deepEqual([pergunta(null), pergunta(T0 - 7 * HORA), pergunta(T0 - HORA)], [false, false, false]);
  await v.conferir(ofertaAmazon(), { releitura: { precoEm: T0 } });
  assert.equal(pergunta(T0 - HORA), false, 'a reserva vale');
  assert.equal(pergunta(T0 - 6 * HORA), false, '6 h exatas ainda valem');
  for (const precoEm of [T0 - 6 * HORA - 1, null, undefined, 'x', Number.NaN, T0 + 6 * MIN]) assert.equal(pergunta(precoEm), true, String(precoEm));
  // outras lojas, sem loja e argumento ausente
  assert.deepEqual(['ml', 'mercadolivre', 'shopee', 'magalu', 'outra', null].map((l) => pergunta(null, l)), [false, false, false, false, false, false]);
  assert.equal(v.semConfirmacaoAgora({ precoEm: null }), false, 'sem loja');
  assert.equal(v.semConfirmacaoAgora(), false);
  // a pausa acaba em 10 min
  agora = T0 + 10 * MIN - 1;
  assert.equal(pergunta(null), true);
  agora = T0 + 10 * MIN;
  assert.equal(pergunta(null), false);
  // verificador desligado: nada fica de fora (a oferta sai sem conferência)
  agora = T0 + MIN;
  setSetting(db, 'verificador_ativo', '0');
  assert.equal(pergunta(null), false);
  setSetting(db, 'verificador_ativo', '1');
  assert.equal(pergunta(null), true);
  // simulado e API ligada não filtram
  const sim = createVerificador({ db: novoDb(), amazon: null, catalogo: catalogoFalso(falha('bloqueado')), simulado: true, agora: () => T0 });
  await sim.conferir(ofertaAmazon(), { releitura: { precoEm: T0 } });
  assert.equal(sim.semConfirmacaoAgora({ loja: 'amazon', precoEm: null }), false);
  // erro ao ler os Ajustes: na dúvida, não filtra
  const quebrado = createVerificador({ db: { prepare: () => { throw new Error('SQLITE_CORRUPT'); } }, amazon: null, agora: () => T0 });
  assert.equal(quebrado.semConfirmacaoAgora({ loja: 'amazon', precoEm: null }), false);
});

test('releitura: textos e sufixos da Amazon são só frases fixas, CAUSAS, hora e preços (nada vindo do Etiqueta)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const respostas = [
    confirmado(), confirmado({ preco: 130 }), confirmado({ preco: 1 }), { resultado: 'sem_preco', mensagem: '<script>x</script>' },
    { resultado: 'outro_produto', url: 'https://golpe.example' }, falha('bloqueado'), falha('<b>x</b>'), { resultado: 'falha', causa: 'http://golpe.example' },
    null, 'texto <script>',
  ];
  const casos = [];
  for (const resposta of respostas) {
    for (const precoEm of [null, T0 - HORA, T0 - 7 * HORA]) {
      casos.push(await comReleitura(catalogoFalso(resposta)).conferir(ofertaAmazon(), { releitura: { precoEm } }));
    }
  }
  for (const r of casos) {
    textosLimpos(r);
    assert.ok(!/script|golpe|127\.0\.0\.1|<b>/.test(JSON.stringify([r.texto, r.sufixo, r.causa])), JSON.stringify(r));
  }
  assert.ok(casos.some((r) => r.acao === 'descartar') && casos.some((r) => r.sufixo?.includes('preço visto')));
});

test('verificador: nenhum teste acessou a rede (CA6)', () => {
  assert.equal(acessosRede, 0);
});
