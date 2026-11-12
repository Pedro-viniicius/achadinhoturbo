// Template: pedaço opcional `[ … ]`, regra da linha, TEMPLATE_AMAZON e SAMPLE_OFFER_AMAZON (CA8).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderTemplate, offerValues, brl, PLACEHOLDERS, TEMPLATE_AMAZON, SAMPLE_OFFER, SAMPLE_OFFER_AMAZON, horaPrecoDerrubaOLink,
  LINHA_ULTIMO_ENVIO, SAMPLE_PRECO_ULTIMO_ENVIO, comLinhaUltimoEnvio, campoDerrubaOLink,
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

// ---- {HORA_PRECO} (verificador de preço, CA5) ----
const em = (h, m) => new Date(2026, 5, 3, h, m, 7).getTime(); // hora local, o mesmo critério do código

test('CA5: {HORA_PRECO} está em PLACEHOLDERS e mostra a hora local da conferência em HHhMM', () => {
  assert.ok(PLACEHOLDERS.includes('HORA_PRECO'));
  assert.equal(offerValues({ ...minima, vistoEm: em(14, 5) }).HORA_PRECO, '14h05');
  assert.equal(offerValues({ ...minima, vistoEm: em(0, 0) }).HORA_PRECO, '00h00');
  assert.equal(offerValues({ ...minima, vistoEm: em(23, 59) }).HORA_PRECO, '23h59');
  assert.equal(renderTemplate('🕒 Preço de {HORA_PRECO}\n{LINK}', { ...minima, vistoEm: em(14, 5) }),
    '🕒 Preço de 14h05\nhttps://meli.la/a');
});

test('CA5: sem `vistoEm` (ou inválido) {HORA_PRECO} fica vazio e a linha some', () => {
  for (const vistoEm of [undefined, null, '', 'ontem', NaN, Infinity, 1e20]) {
    const o = { ...minima, vistoEm };
    assert.equal(offerValues(o).HORA_PRECO, '', String(vistoEm));
    assert.equal(renderTemplate('A\n🕒 Preço de {HORA_PRECO}\n{LINK}', o), 'A\nhttps://meli.la/a', String(vistoEm));
  }
});

test('CA5: {HORA_PRECO} dentro de [ ] some só o trecho; a linha continua', () => {
  const tpl = '🔥 Por *{PRECO_PRODUTO}*[ (visto às {HORA_PRECO})]\n{LINK}';
  assert.equal(renderTemplate(tpl, { ...minima, vistoEm: em(9, 3) }), '🔥 Por *R$ 80,00* (visto às 09h03)\nhttps://meli.la/a');
  assert.equal(renderTemplate(tpl, minima), '🔥 Por *R$ 80,00*\nhttps://meli.la/a');
});

test('CA5: as duas amostras trazem `vistoEm` às 14h32', () => {
  assert.equal(offerValues(SAMPLE_OFFER).HORA_PRECO, '14h32');
  assert.equal(offerValues(SAMPLE_OFFER_AMAZON).HORA_PRECO, '14h32');
  assert.ok(renderTemplate('{HORA_PRECO}\n{LINK}', SAMPLE_OFFER).startsWith('14h32\n'));
});

test('Q2: horaPrecoDerrubaOLink acusa o {HORA_PRECO} que, sem conferência, levaria o {LINK} junto; e só ele', () => {
  const some = (tpl) => !renderTemplate(tpl, { ...minima, vistoEm: null }).includes('https://meli.la/a');
  for (const tpl of ['Preço visto às {HORA_PRECO}: {LINK}', '[Visto às {HORA_PRECO}: {LINK}]', '[{LINK}] às {HORA_PRECO}', '{LINK} {HORA_PRECO}', 'a\n{HORA_PRECO}[ x {CUPOM}] {LINK}']) {
    assert.equal(horaPrecoDerrubaOLink(tpl), true, tpl);
    assert.ok(some(tpl), `o renderizador confirma que o link some: ${tpl}`);
  }
  for (const tpl of ['{LINK}\n[🕒 Preço visto às {HORA_PRECO}]', '[🕒 {HORA_PRECO}] {LINK}', '{HORA_PRECO}\n{LINK}', '[a {HORA_PRECO}][ b {CUPOM}] {LINK}', '{LINK}', '', undefined]) {
    assert.equal(horaPrecoDerrubaOLink(tpl), false, String(tpl));
  }
  assert.ok(!some('[🕒 {HORA_PRECO}] {LINK}'), 'e o formato seguro mantém o link');
});

// ------------------------------------------------------------------- {PRECO_ULTIMO_ENVIO} ("Baixou de … para …")
test('baixou: {PRECO_ULTIMO_ENVIO} vem logo depois de {PRECO_PRODUTO} em PLACEHOLDERS e a linha fixa é a do plano (CA1)', () => {
  const i = PLACEHOLDERS.indexOf('PRECO_PRODUTO');
  assert.equal(PLACEHOLDERS[i + 1], 'PRECO_ULTIMO_ENVIO');
  assert.equal(LINHA_ULTIMO_ENVIO, '[📉 Baixou de ~{PRECO_ULTIMO_ENVIO}~ para *{PRECO_PRODUTO}*]');
  assert.equal(SAMPLE_PRECO_ULTIMO_ENVIO, 99.9);
});

test('baixou: com queda a linha aparece com o preço anterior riscado e o atual em negrito', () => {
  const o = { ...minima, precoUltimoEnvio: 99.9 };
  assert.equal(offerValues(o).PRECO_ULTIMO_ENVIO, 'R$ 99,90');
  assert.equal(renderTemplate(`🔥 Por *{PRECO_PRODUTO}*\n${LINHA_ULTIMO_ENVIO}\n{LINK}`, o),
    '🔥 Por *R$ 80,00*\n📉 Baixou de ~R$ 99,90~ para *R$ 80,00*\nhttps://meli.la/a');
  // a prévia de Templates: oferta de exemplo (89,90) contra o último envio de exemplo (99,90)
  assert.ok(renderTemplate(LINHA_ULTIMO_ENVIO, { ...SAMPLE_OFFER, precoUltimoEnvio: SAMPLE_PRECO_ULTIMO_ENVIO })
    .includes('Baixou de ~R$ 99,90~ para *R$ 89,90*'));
});

test('baixou: sem queda (ausente, igual, menor, nulo, lixo ou preço atual inválido) o campo fica vazio e a linha some', () => {
  const tpl = `🔥 Por *{PRECO_PRODUTO}*\n${LINHA_ULTIMO_ENVIO}\n{LINK}`;
  const sem = '🔥 Por *R$ 80,00*\nhttps://meli.la/a';
  for (const v of [undefined, null, '', 80, 79.99, 0, -5, NaN, Infinity, 'abc']) {
    const o = { ...minima, precoUltimoEnvio: v };
    assert.equal(offerValues(o).PRECO_ULTIMO_ENVIO, '', String(v));
    assert.equal(renderTemplate(tpl, o), sem, String(v));
  }
  // preço atual ausente ou zero: não há "para quanto", o campo não aparece
  for (const price of [undefined, null, 0]) assert.equal(offerValues({ ...minima, price, precoUltimoEnvio: 99.9 }).PRECO_ULTIMO_ENVIO, '', String(price));
  // sem o campo na oferta o texto é igual ao de antes
  assert.equal(renderTemplate(tpl, minima), sem);
});

test('baixou: TEMPLATE_AMAZON já traz a linha abaixo do "Por" e as amostras rendem igual a antes sem o campo', () => {
  const linhas = TEMPLATE_AMAZON.split('\n');
  const i = linhas.findIndex((l) => l.startsWith('🔥 Por'));
  assert.equal(linhas[i + 1], LINHA_ULTIMO_ENVIO);
  assert.ok(!linhas.slice(0, i + 1).some((l) => l.includes('{PRECO_ULTIMO_ENVIO}')));
  // sem `precoUltimoEnvio` o texto é o mesmo do teste anterior da Amazon (nenhuma linha em branco sobra)
  assert.ok(!renderTemplate(TEMPLATE_AMAZON, SAMPLE_OFFER_AMAZON, { tituloMax: 0 }).includes('Baixou'));
  assert.equal(
    renderTemplate(TEMPLATE_AMAZON, { ...SAMPLE_OFFER_AMAZON, precoUltimoEnvio: 1500 }, { tituloMax: 0 }),
    '*Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades*\n\n😱 De ~R$ 1.999,00~\n🔥 Por *R$ 1.310,05* (34% OFF)\n📉 Baixou de ~R$ 1.500,00~ para *R$ 1.310,05*\n🚚 Frete grátis\n🎟️ Cupom: *DESEJO10*\n\n🛒 Compre aqui: https://www.amazon.com.br/dp/B0FG2MD49G',
  );
  // o Padrão antigo e as duas amostras continuam como eram
  assert.equal(renderTemplate(PADRAO_ANTIGO, SAMPLE_OFFER), SAIDA_PADRAO_ANTES);
  const vals = offerValues(SAMPLE_OFFER);
  for (const k of PLACEHOLDERS) assert.equal(typeof vals[k], 'string', k);
});

test('comLinhaUltimoEnvio: insere logo abaixo da primeira linha com {PRECO_PRODUTO} sem {LINK}', () => {
  const corpo = '*{TITULO_PRODUTO}*\n\n😱 De ~{PRECO_ANTIGO}~\n🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]\n🚚 {FRETE}\n\n🛒 {LINK}';
  assert.equal(
    comLinhaUltimoEnvio(corpo),
    '*{TITULO_PRODUTO}*\n\n😱 De ~{PRECO_ANTIGO}~\n🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]\n[📉 Baixou de ~{PRECO_ULTIMO_ENVIO}~ para *{PRECO_PRODUTO}*]\n🚚 {FRETE}\n\n🛒 {LINK}',
  );
  // só uma vez: com a linha já posta, devolve null (e, repetindo sobre o resultado, também)
  const uma = comLinhaUltimoEnvio(corpo);
  assert.equal(comLinhaUltimoEnvio(uma), null);
  assert.equal(uma.split('{PRECO_ULTIMO_ENVIO}').length - 1, 1);
  // com mais de uma linha de preço, só a primeira ganha
  const duas = 'Por {PRECO_PRODUTO}\nOu {PRECO_PRODUTO} no pix\n{LINK}';
  assert.equal(comLinhaUltimoEnvio(duas), `Por {PRECO_PRODUTO}\n${LINHA_ULTIMO_ENVIO}\nOu {PRECO_PRODUTO} no pix\n{LINK}`);
});

test('comLinhaUltimoEnvio: pula a linha do preço que tem o {LINK} e usa a próxima; sem linha elegível, null', () => {
  assert.equal(
    comLinhaUltimoEnvio('Compre {PRECO_PRODUTO}: {LINK}\nPor *{PRECO_PRODUTO}*\nfim'),
    `Compre {PRECO_PRODUTO}: {LINK}\nPor *{PRECO_PRODUTO}*\n${LINHA_ULTIMO_ENVIO}\nfim`,
  );
  assert.equal(comLinhaUltimoEnvio('Por {PRECO_PRODUTO} {LINK}'), null); // só tem preço na linha do LINK
  assert.equal(comLinhaUltimoEnvio('*{TITULO_PRODUTO}*\n{LINK}'), null); // sem preço
  assert.equal(comLinhaUltimoEnvio(''), null);
  for (const nao of [undefined, null, 12, {}, ['{PRECO_PRODUTO}']]) assert.equal(comLinhaUltimoEnvio(nao), null);
});

test('comLinhaUltimoEnvio: já tem o campo (em qualquer lugar) devolve null, sem mexer', () => {
  assert.equal(comLinhaUltimoEnvio('Por {PRECO_PRODUTO}\nera {PRECO_ULTIMO_ENVIO}'), null);
  assert.equal(comLinhaUltimoEnvio('{PRECO_ULTIMO_ENVIO} {PRECO_PRODUTO}'), null);
  assert.equal(comLinhaUltimoEnvio(TEMPLATE_AMAZON), null);
});

test('comLinhaUltimoEnvio: mantém \\r\\n do corpo, no meio e na última linha; só insere, o resto fica byte a byte', () => {
  const crlf = 'A\r\nPor *{PRECO_PRODUTO}*\r\n{LINK}';
  const r = comLinhaUltimoEnvio(crlf);
  assert.equal(r, `A\r\nPor *{PRECO_PRODUTO}*\r\n${LINHA_ULTIMO_ENVIO}\r\n{LINK}`);
  assert.ok(!/[^\r]\n/.test(r), 'nenhum \\n solto num corpo CRLF');
  assert.equal(r.replace(`${LINHA_ULTIMO_ENVIO}\r\n`, ''), crlf);
  // preço na última linha, sem quebra no fim
  assert.equal(comLinhaUltimoEnvio('{LINK}\r\nPor {PRECO_PRODUTO}'), `{LINK}\r\nPor {PRECO_PRODUTO}\r\n${LINHA_ULTIMO_ENVIO}`);
  assert.equal(comLinhaUltimoEnvio('{LINK}\nPor {PRECO_PRODUTO}'), `{LINK}\nPor {PRECO_PRODUTO}\n${LINHA_ULTIMO_ENVIO}`);
  // o corpo com a linha inserida renderiza igual ao de antes quando não há queda (sem sobra de linha em branco)
  const lf = '*{TITULO_PRODUTO}*\nPor *{PRECO_PRODUTO}*\n{LINK}';
  assert.equal(renderTemplate(comLinhaUltimoEnvio(lf), minima), renderTemplate(lf, minima));
});

test('campoDerrubaOLink: vale para os dois campos; horaPrecoDerrubaOLink continua igual por cima dele', () => {
  // o campo na linha do LINK, fora de [ ] ou no mesmo [ ] dele: derruba
  for (const campo of ['HORA_PRECO', 'PRECO_ULTIMO_ENVIO']) {
    for (const tpl of [`{${campo}} {LINK}`, `[x {${campo}}: {LINK}]`, `[{LINK}] {${campo}}`, `a\n{${campo}}[ y {CUPOM}] {LINK}`]) {
      assert.equal(campoDerrubaOLink(tpl, campo), true, `${campo}: ${tpl}`);
    }
    for (const tpl of [`{LINK}\n[x {${campo}}]`, `[x {${campo}}] {LINK}`, `{${campo}}\n{LINK}`, '{LINK}', '', undefined, null]) {
      assert.equal(campoDerrubaOLink(tpl, campo), false, `${campo}: ${tpl}`);
    }
  }
  // um campo não confunde com o outro
  assert.equal(campoDerrubaOLink('{HORA_PRECO} {LINK}', 'PRECO_ULTIMO_ENVIO'), false);
  assert.equal(campoDerrubaOLink('{PRECO_ULTIMO_ENVIO} {LINK}', 'HORA_PRECO'), false);
  assert.equal(horaPrecoDerrubaOLink('{HORA_PRECO} {LINK}'), true);
  assert.equal(horaPrecoDerrubaOLink('{PRECO_ULTIMO_ENVIO} {LINK}'), false);
  // a LINHA_ULTIMO_ENVIO é segura, e o renderizador confirma os dois lados
  assert.equal(campoDerrubaOLink(`Por {PRECO_PRODUTO}\n${LINHA_ULTIMO_ENVIO}\n{LINK}`, 'PRECO_ULTIMO_ENVIO'), false);
  const some = (tpl) => !renderTemplate(tpl, minima).includes('https://meli.la/a');
  assert.ok(some('{PRECO_ULTIMO_ENVIO} {LINK}'));
  assert.ok(!some(`${LINHA_ULTIMO_ENVIO}\n{LINK}`));
});
