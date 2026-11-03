// Template: pedaço opcional `[ … ]`, regra da linha, TEMPLATE_AMAZON e SAMPLE_OFFER_AMAZON (CA8).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderTemplate, offerValues, brl, PLACEHOLDERS, TEMPLATE_AMAZON, SAMPLE_OFFER, SAMPLE_OFFER_AMAZON,
} from '../src/template.js';

// Oferta mínima: tem título, preço e link; não tem preço antigo, desconto, vendas, frete nem cupom.
const minima = { title: 'Fone X', price: 80, link: 'https://meli.la/a' };
const completa = { ...minima, oldPrice: 100, coupon: 'CUPOM10', freeShipping: true, sold: 15 };

// Texto do template "Padrão" como era antes da etapa 1 do plano (sem colchetes).
const PADRAO_ANTIGO = [
  '*{TITULO_PRODUTO}*',
  '',
  '😱 De ~{PRECO_ANTIGO}~',
  '🔥 Por *{PRECO_PRODUTO}* ({DESCONTO_PRODUTO} OFF)',
  '⭐ {NUMERO_VENDAS}',
  '🚚 {FRETE}',
  '🎟️ Cupom: *{CUPOM}*',
  '',
  '🛒 Compre aqui: {LINK}',
].join('\n');

// Saída capturada de renderTemplate(PADRAO_ANTIGO, SAMPLE_OFFER) antes desta etapa.
const SAIDA_PADRAO_ANTES = '*Fone de Ouvido Bluetooth TWS com Cancelamento de Ruído*\n\n😱 De ~R$ 149,90~\n🔥 Por *R$ 89,90* (40% OFF)\n⭐ +2 mil vendidos\n🚚 Frete grátis\n\n🛒 Compre aqui: https://meli.la/2AbCdEf';

test('pedaço opcional: desconto vazio some só o pedaço [ ({DESCONTO_PRODUTO} OFF)] e a linha continua', () => {
  const t = '🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]';
  assert.equal(renderTemplate(t, minima), '🔥 Por *R$ 80,00*');
  assert.equal(renderTemplate(t, completa), '🔥 Por *R$ 80,00* (20% OFF)');
});

test('pedaço opcional: some quando qualquer placeholder dentro dele está vazio; vários pedaços na mesma linha', () => {
  const t = '{PRECO_PRODUTO}[ de {PRECO_ANTIGO} ({DESCONTO_PRODUTO} OFF)][ · cupom {CUPOM}][ · {FRETE}]';
  assert.equal(renderTemplate(t, minima), 'R$ 80,00');
  assert.equal(renderTemplate(t, { ...minima, coupon: 'A1' }), 'R$ 80,00 · cupom A1');
  assert.equal(renderTemplate(t, completa), 'R$ 80,00 de R$ 100,00 (20% OFF) · cupom CUPOM10 · Frete grátis');
  // desconto informado mas sem preço antigo: o pedaço que depende dos dois some inteiro
  assert.equal(renderTemplate(t, { ...minima, discountPct: 10 }), 'R$ 80,00');
});

test('placeholder vazio fora do colchete apaga a linha inteira, mesmo com pedaço opcional preenchido', () => {
  const t = 'A\nCupom: {CUPOM}[ ({DESCONTO_PRODUTO} OFF)]\nB';
  assert.equal(renderTemplate(t, { ...minima, oldPrice: 100 }), 'A\nB');
  // o mesmo template com cupom fica
  assert.equal(renderTemplate(t, completa), 'A\nCupom: CUPOM10 (20% OFF)\nB');
});

test('colchete sem placeholder fica como está (inclusive com placeholder desconhecido dentro)', () => {
  assert.equal(renderTemplate('[OFERTA] {TITULO_PRODUTO}', minima), '[OFERTA] Fone X');
  assert.equal(renderTemplate('[] {TITULO_PRODUTO}', minima), '[] Fone X');
  assert.equal(renderTemplate('[{FOO}] {TITULO_PRODUTO}', minima), '[{FOO}] Fone X');
  // placeholder desconhecido não some e não apaga a linha
  assert.equal(renderTemplate('{FOO} {TITULO_PRODUTO}', minima), '{FOO} Fone X');
});

test('[ ou ] soltos ficam; sem aninhamento, só o colchete interno é opcional', () => {
  assert.equal(renderTemplate('[ {TITULO_PRODUTO}', minima), '[ Fone X');
  assert.equal(renderTemplate('{TITULO_PRODUTO} ]', minima), 'Fone X ]');
  assert.equal(renderTemplate('[ {TITULO_PRODUTO}[ {CUPOM}]', minima), '[ Fone X');
  assert.equal(renderTemplate('[ {TITULO_PRODUTO}[ {CUPOM}]', completa), '[ Fone X CUPOM10');
  // `[` solto com placeholder vazio fora de colchete fechado: a regra da linha continua valendo
  assert.equal(renderTemplate('A\n[ Cupom {CUPOM}\nB', minima), 'A\nB');
});

test('regressão: o template Padrão antigo com SAMPLE_OFFER produz exatamente o texto de hoje', () => {
  assert.equal(renderTemplate(PADRAO_ANTIGO, SAMPLE_OFFER), SAIDA_PADRAO_ANTES);
  // e o mesmo Padrão na sintaxe nova (etapa 1) dá o mesmo texto quando há desconto
  const padraoNovo = PADRAO_ANTIGO.replace('* ({DESCONTO_PRODUTO} OFF)', '*[ ({DESCONTO_PRODUTO} OFF)]');
  assert.equal(renderTemplate(padraoNovo, SAMPLE_OFFER), SAIDA_PADRAO_ANTES);
  // sem desconto: o antigo perde a linha do preço; o novo mantém o preço e perde só o "(NN% OFF)"
  const semDesconto = { ...SAMPLE_OFFER, oldPrice: null };
  assert.ok(!renderTemplate(PADRAO_ANTIGO, semDesconto).includes('Por *'));
  assert.ok(renderTemplate(padraoNovo, semDesconto).includes('🔥 Por *R$ 89,90*\n'));
});

test('TEMPLATE_AMAZON: tem {LINK}, usa a sintaxe nova e renderiza a amostra completa', () => {
  assert.ok(TEMPLATE_AMAZON.includes('{LINK}'));
  assert.ok(TEMPLATE_AMAZON.includes('[ ({DESCONTO_PRODUTO} OFF)]'));
  assert.equal(
    renderTemplate(TEMPLATE_AMAZON, SAMPLE_OFFER_AMAZON, { tituloMax: 0 }),
    '*Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades*\n\n😱 De ~R$ 1.999,00~\n🔥 Por *R$ 1.310,05* (34% OFF)\n🚚 Frete grátis\n🎟️ Cupom: *DESEJO10*\n\n🛒 Compre aqui: https://www.amazon.com.br/dp/B0FG2MD49G',
  );
});

test('TEMPLATE_AMAZON sem oldPrice: nenhuma linha "De" e só o "(NN% OFF)" some; sem cupom some a linha do cupom', () => {
  // amostra "Sem preço antigo e sem cupom" da spec: { oldPrice: null, discountPct: 0, coupon: '' }
  const parcial = { ...SAMPLE_OFFER_AMAZON, oldPrice: null, discountPct: 0, coupon: '' };
  const out = renderTemplate(TEMPLATE_AMAZON, parcial, { tituloMax: 0 });
  assert.equal(
    out,
    '*Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades*\n\n🔥 Por *R$ 1.310,05*\n🚚 Frete grátis\n\n🛒 Compre aqui: https://www.amazon.com.br/dp/B0FG2MD49G',
  );
  assert.ok(!out.includes('De ') && !out.includes('OFF') && !out.includes('Cupom'));
  // só sem oldPrice (discountPct não informado): também não inventa "De" nem desconto
  const soSemAntigo = { ...SAMPLE_OFFER_AMAZON, oldPrice: null, discountPct: undefined };
  const out2 = renderTemplate(TEMPLATE_AMAZON, soSemAntigo, { tituloMax: 0 });
  assert.ok(!out2.includes('De ') && !out2.includes('OFF') && out2.includes('🔥 Por *R$ 1.310,05*\n'));
});

test('SAMPLE_OFFER_AMAZON: formato da oferta do plano, com ASIN e link longo da Amazon', () => {
  assert.equal(SAMPLE_OFFER_AMAZON.asin, 'B0FG2MD49G');
  assert.equal(SAMPLE_OFFER_AMAZON.key, `ASIN:${SAMPLE_OFFER_AMAZON.asin}`);
  assert.match(SAMPLE_OFFER_AMAZON.link, /^https:\/\/www\.amazon\.com\.br\/dp\/[A-Z0-9]{10}$/);
  assert.ok(SAMPLE_OFFER_AMAZON.oldPrice > SAMPLE_OFFER_AMAZON.price);
  const vals = offerValues(SAMPLE_OFFER_AMAZON);
  for (const k of PLACEHOLDERS) assert.equal(typeof vals[k], 'string', k);
  assert.equal(vals.DESCONTO_PRODUTO, '34%');
  assert.equal(vals.NUMERO_VENDAS, '+200 vendidos');
});

test('R6/Q3: linha formada só por pedaço opcional vazio some (não vira linha em branco); linha em branco do template fica', () => {
  assert.equal(renderTemplate('A\n[🎟️ Cupom: {CUPOM}]\nB', minima), 'A\nB');
  assert.equal(renderTemplate('A\n[🎟️ Cupom: {CUPOM}]\nB', completa), 'A\n🎟️ Cupom: CUPOM10\nB');
  assert.equal(renderTemplate('A\n  [{FRETE}] [ · {CUPOM}]  \nB', minima), 'A\nB'); // sobram só espaços: some
  assert.equal(renderTemplate('A\n\n[{CUPOM}]\nB', minima), 'A\n\nB'); // a linha em branco original continua
  assert.equal(renderTemplate('A\n[sem placeholder]\nB', minima), 'A\n[sem placeholder]\nB');
});

test('R5: brl troca o NBSP do Intl por espaço comum (sem caractere invisível no fonte)', () => {
  assert.equal(brl(1310.05), 'R$ 1.310,05');
  assert.ok(!brl(10).includes(' '));
});
