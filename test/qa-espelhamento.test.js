// QA do grupo A do plano espelhamento-amazon (etapas 1 a 5), rodadas 1 e 2.
// Testes exploratórios além dos arquivos dos devs: formatos de link não previstos, textos de origem fora das
// fixtures, listas de bloqueio hostis, máscara de dados pessoais, tipos de mensagem do Baileys não previstos,
// colchetes aninhados/linhas só com colchetes no template e a prova de que nada aqui acessa a rede (CA10).
// Q1, Q3 e Q4 (achados da rodada 1) foram corrigidos na rodada 2 e viraram testes normais.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createWhatsApp, textoDaMensagem, MAX_TEXTO_RECEBIDO } from '../src/whatsapp.js';
import { extrairAsin, resolverLink, LinkNaoResolvido, ofertaDoItem, createAmazon } from '../src/amazon.js';
import { lerOfertaDoTexto, extrairUrls, palavraBloqueada, normalizar, FIXTURES, FIXTURES_ESPERADO } from '../src/oferta-texto.js';
import { mascararPessoais } from '../src/privacidade.js';
import { renderTemplate, TEMPLATE_AMAZON } from '../src/template.js';

// ---------------------------------------------------------------------------------------- rede bloqueada
const fetchOriginal = globalThis.fetch;
let chamadasRede = 0;
test.before(() => { globalThis.fetch = async () => { chamadasRede++; throw new Error('rede proibida no teste'); }; });
test.after(() => { globalThis.fetch = fetchOriginal; });

// pastas temporárias apagadas no fim do arquivo
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-espelho-')); pastas.push(p); return p; };
const ASIN = 'B0FG2MD49G';
const GRUPO = '120363000000000001@g.us';
const PESSOA = '5511988887777@s.whatsapp.net';
const semUrls = ({ urls, ...resto }) => resto;
const capturarErro = async (fn) => { try { await fn(); } catch (e) { return e; } assert.fail('deveria ter lançado'); };
const redirecionar = (status, location) => new Response(null, { status, headers: location ? { location } : {} });
function fetchFalso(handler) {
  const chamadas = [];
  const f = async (url, init = {}) => { chamadas.push({ url: String(url), init }); return handler(String(url), init, chamadas.length); };
  f.chamadas = chamadas;
  return f;
}

// ================================================================================ amazon.js (CA1, CA2, CA7)
test('QA amazon: extrairAsin com formatos reais não listados no plano (ref=, /-/en/, ASIN= maiúsculo, caminho duplo)', () => {
  assert.equal(extrairAsin('https://www.amazon.com.br/dp/B0FG2MD49G/ref=cm_sw_r_apan_dp_x'), ASIN, 'ref= depois do ASIN');
  assert.equal(extrairAsin('https://www.amazon.com.br/-/en/dp/B0FG2MD49G'), ASIN, 'prefixo de idioma');
  assert.equal(extrairAsin('https://www.amazon.com.br/gp/offer-listing?ASIN=B0FG2MD49G'), ASIN, 'ASIN= em maiúsculas');
  assert.equal(extrairAsin('https://www.amazon.com.br/dp/B0FG2MD49G?ASIN=B0AAAAAAAA'), ASIN, 'o caminho vale mais que a query');
  // Formatos que o plano não cobre e hoje dão null (o resolvedor acaba em "nao_produto" ou "invalido"): contrato documentado.
  assert.equal(extrairAsin('https://www.amazon.com.br/product-reviews/B0FG2MD49G'), null, 'página de avaliações não é produto');
  assert.equal(extrairAsin('https://www.amazon.com.br/dp//B0FG2MD49G'), null, 'barra dupla');
  assert.equal(extrairAsin('https://www.amazon.com.br/s?k=B0FG2MD49G'), null, 'ASIN como busca não é link de produto');
  assert.equal(extrairAsin('https://www.amazon.de/dp/B0FG2MD49G'), null, 'outro marketplace');
  assert.equal(extrairAsin('https://www.amazon.com.mx/dp/B0FG2MD49G'), null, 'amazon.com.mx não casa com amazon.com');
  assert.equal(extrairAsin(`https://www.amazon.com.br/dp/${ASIN}​`), null, 'espaço de largura zero colado no fim (cópia do WhatsApp)');
});

test('QA amazon: resolverLink com Location relativo "..", Location para "javascript:", resposta sem headers e status 0', async () => {
  // Location relativo com ".." resolvido contra a URL atual (num host de produto, onde o caminho pode trazer o ASIN).
  const f = fetchFalso((url, init, n) => (n === 1 ? redirecionar(301, '../x/dp/B0FG2MD49G') : assert.fail('salto a mais')));
  assert.equal((await resolverLink('https://www.amazon.com.br/stores/a/b', { fetch: f, cache: new Map() })).asin, ASIN);
  // Location relativo num encurtador continua no encurtador: o código nunca é ASIN, então segue o próximo salto.
  const f2 = fetchFalso((url, init, n) => (n === 1 ? redirecionar(301, '/dp/B0FG2MD49G') : redirecionar(302, `https://www.amazon.com.br/dp/${ASIN}`)));
  assert.equal((await resolverLink('https://amzn.to/a/b', { fetch: f2, cache: new Map() })).asin, ASIN);
  assert.equal(f2.chamadas[1].url, 'https://amzn.to/dp/B0FG2MD49G');

  for (const location of ['javascript:alert(1)', 'data:text/html,oi', '//golpe.com/dp/B0FG2MD49G', 'https://amzn.to:8443/x']) {
    const g = fetchFalso(() => redirecionar(302, location));
    const e = await capturarErro(() => resolverLink('https://amzn.to/abc', { fetch: g, cache: new Map() }));
    assert.ok(e instanceof LinkNaoResolvido, location);
    assert.equal(g.chamadas.length, 1, `não seguiu ${location}`);
  }
  // amzn.to:443 é a porta padrão: a URL normaliza e perde a porta, então é seguida (só porta explícita diferente é recusada).
  const porta = fetchFalso((url, init, n) => (n === 1 ? redirecionar(302, 'https://amzn.to:443/x') : redirecionar(302, `https://www.amazon.com.br/dp/${ASIN}`)));
  assert.equal((await resolverLink('https://amzn.to/abc', { fetch: porta, cache: new Map() })).asin, ASIN);
  assert.equal(porta.chamadas[1].url, 'https://amzn.to/x');
  const h = fetchFalso(() => ({ status: 0 }));
  assert.equal((await capturarErro(() => resolverLink('https://amzn.to/zero', { fetch: h, cache: new Map() }))).causa, 'invalido');
  const i = fetchFalso(() => ({ status: 301, headers: {} }));
  assert.equal((await capturarErro(() => resolverLink('https://amzn.to/semget', { fetch: i, cache: new Map() }))).causa, 'invalido');
});

test('QA amazon: cadeia que passa pela amazon.com (EUA) sem ASIN e termina na .com.br; nao_produto fica em cache, invalido não', async () => {
  const f = fetchFalso((url, init, n) => {
    if (n === 1) return redirecionar(302, 'https://www.amazon.com/gp/r.html?C=1&R=https://www.amazon.com.br/dp/B0FG2MD49G');
    if (n === 2) return redirecionar(302, 'https://www.amazon.com.br/Roteador/dp/B0FG2MD49G?tag=terceiro-20');
    return assert.fail('salto a mais');
  });
  const r = await resolverLink('https://a.co/d/xyz', { fetch: f, cache: new Map() });
  assert.deepEqual(r, { asin: ASIN, urlFinal: 'https://www.amazon.com.br/Roteador/dp/B0FG2MD49G' });

  const cache = new Map();
  const busca = fetchFalso(() => new Response('<html>', { status: 200 }));
  await capturarErro(() => resolverLink('https://www.amazon.com.br/s?k=x', { fetch: busca, cache }));
  await capturarErro(() => resolverLink('https://www.amazon.com.br/s?k=x', { fetch: busca, cache }));
  assert.equal(busca.chamadas.length, 1, 'nao_produto vem do cache na 2ª vez');
  const quebrado = fetchFalso(() => new Response('x', { status: 503 }));
  await capturarErro(() => resolverLink('https://amzn.to/quebrado', { fetch: quebrado, cache }));
  await capturarErro(() => resolverLink('https://amzn.to/quebrado', { fetch: quebrado, cache }));
  assert.equal(quebrado.chamadas.length, 2, 'invalido não fica em cache (tenta de novo)');
});

test('QA amazon: ofertaDoItem com percentage sem savingBasis, percentage absurda, listings vazio e isBuyBoxWinner como string', () => {
  // Q9: a API pode mandar savings.percentage sem savingBasis; o item sai com desconto e sem preço antigo
  // (o template mostra "(34% OFF)" sem a linha "De"). Comportamento atual documentado; decisão do PO.
  const semBase = ofertaDoItem({ asin: ASIN, offersV2: { listings: [{ price: { money: { amount: 100 }, savings: { percentage: 34 } } }] } });
  assert.deepEqual([semBase.price, semBase.oldPrice, semBase.discountPct], [100, null, 34]);
  assert.ok(renderTemplate(TEMPLATE_AMAZON, { ...semBase, title: 'x', link: 'l' }).includes('(34% OFF)'));
  assert.ok(!renderTemplate(TEMPLATE_AMAZON, { ...semBase, title: 'x', link: 'l' }).includes('De '));

  for (const pct of [150, 0, -5, 'abc', null]) {
    const o = ofertaDoItem({ asin: ASIN, offersV2: { listings: [{ price: { money: { amount: 100 }, savingBasis: { money: { amount: 200 } }, savings: { percentage: pct } } }] } });
    assert.equal(o.discountPct, 50, `percentage ${pct} cai no cálculo`);
  }
  const vazio = ofertaDoItem({ asin: ASIN, offersV2: { listings: [] }, itemInfo: { title: { displayValue: 'Só título' } } });
  assert.deepEqual([vazio.title, vazio.price, vazio.disponivel], ['Só título', null, null]);
  const stringTrue = ofertaDoItem({ asin: ASIN, offersV2: { listings: [{ price: { money: { amount: 10 } } }, { isBuyBoxWinner: 'true', price: { money: { amount: 20 } } }] } });
  assert.equal(stringTrue.price, 10, 'só isBuyBoxWinner === true conta; senão o primeiro');
  assert.equal(ofertaDoItem({ asin: ASIN, itemInfo: { title: { displayValue: 'A'.repeat(700) } } }).title.length, 200, 'título cortado em 200 (R6)');
});

test('QA amazon: lerItens simultâneos do mesmo ASIN dividem um só GetItems (Q12 corrigido) e o cache vale depois', async () => {
  const db = (() => {
    const d = new DatabaseSync(':memory:');
    d.exec("CREATE TABLE conexoes (plataforma TEXT PRIMARY KEY, config TEXT NOT NULL DEFAULT '{}', segredos TEXT NOT NULL DEFAULT '{}', updated_at INTEGER)");
    d.prepare("INSERT INTO conexoes (plataforma, config, segredos) VALUES ('amazon', ?, ?)").run(JSON.stringify({ tag: 'dono-20' }), JSON.stringify({ credencial_id: 'id12345678', credencial_secret: 'segredo12345' }));
    return d;
  })();
  let t = 1_700_000_000_000;
  const f = fetchFalso((url) => (url.endsWith('/auth/o2/token')
    ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
    : new Response(JSON.stringify({ itemsResult: { items: [{ asin: ASIN, itemInfo: { title: { displayValue: 'T' } } }] } }), { status: 200 })));
  const amazon = createAmazon({ db, fetch: f, agora: () => t, esperar: async (ms) => { t += ms; } });
  await Promise.all([amazon.lerItem(ASIN), amazon.lerItem(ASIN)]);
  const gets = () => f.chamadas.filter((c) => c.url.endsWith('/getItems')).length;
  assert.equal(gets(), 1, 'Q12 (corrigido na rodada 1): pedidos em voo do mesmo ASIN dividem um só GetItems');
  await amazon.lerItem(ASIN);
  assert.equal(gets(), 1, 'depois, cache');
});

// ============================================================================ oferta-texto.js (CA3, CA5)
test('QA oferta-texto: variações de preço fora das fixtures ("R$" sem espaço, mesma linha, seta, CRLF, ponto decimal, parcelas)', () => {
  const o = (t) => semUrls(lerOfertaDoTexto(t));
  assert.deepEqual([o('Fone JBL\nDe R$1.999,00\nPor R$1.310,05').oldPrice, o('Fone JBL\nDe R$1.999,00\nPor R$1.310,05').price], [1999, 1310.05]);
  assert.deepEqual([o('Fone\nDe R$ 100 por R$ 80').oldPrice, o('Fone\nDe R$ 100 por R$ 80').price], [100, 80], 'De e Por na mesma linha');
  assert.deepEqual([o('Fone\n~R$ 100~ → R$ 80').oldPrice, o('Fone\n~R$ 100~ → R$ 80').price], [100, 80], 'riscado + seta');
  assert.equal(o('Fone JBL\r\nPor R$ 80\r\n').title, 'Fone JBL', 'CRLF');
  assert.equal(o('Fone\nPor R$ 1310.05').price, 1310.05, 'ponto como decimal');
  assert.equal(o('Fone\nPor R$ 1.310').price, 1310, 'ponto como milhar');
  assert.deepEqual([o('Fone\nPor R$ 99,90 ou 12x de R$ 10,00').price, o('Fone\nPor R$ 99,90 ou 12x de R$ 10,00').oldPrice], [99.9, null], 'parcela não vira preço');
  assert.deepEqual([o('Fone\nPor R$ 99,90 em 3x sem juros de R$ 33,30').price, o('Fone\nPor R$ 99,90 em 3x sem juros de R$ 33,30').oldPrice], [99.9, null], '"sem juros de R$" não vira De');
  assert.equal(o('Fone\nPor US$ 50').price, null, 'moeda estrangeira não é preço');
  assert.deepEqual([o('Fone\nR$ 100 R$ 80 R$ 120').price, o('Fone\nR$ 100 R$ 80 R$ 120').oldPrice], [80, 120], 'três soltos: menor e maior');
  assert.deepEqual(o('🔥🔥🔥\n💥💥'), { title: null, price: null, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: null }, 'só emoji');
  const grande = `${'Linha de enfeite sem preço\n'.repeat(5000)}Fone\nPor R$ 10`;
  const inicio = Date.now();
  assert.equal(lerOfertaDoTexto(grande).price, 10);
  assert.ok(Date.now() - inicio < 1000, 'texto de 5.000 linhas em menos de 1 s');
});

test('QA oferta-texto (Q1): preço solto maior depois do "Por" não pode virar preço antigo ("ou R$ 90 no cartão")', () => {
  for (const texto of ['Fone\nPor R$ 80 à vista ou R$ 90 no cartão', 'Fone\nPor R$ 80\nR$ 90 parcelado em 10x', 'Fone\nPor R$ 80\nFrete R$ 95 para o Norte']) {
    const o = lerOfertaDoTexto(texto);
    assert.equal(o.price, 80, texto);
    assert.equal(o.oldPrice, null, `${texto} → inventou De R$ ${o.oldPrice}`);
  }
});

test('QA oferta-texto (Q2): mensagem com dois produtos devolve os dados do primeiro para todas as URLs (contrato atual, risco na etapa 11)', () => {
  const texto = 'Fone A\nPor R$ 50\nhttps://amzn.to/a\n\nFone B\nPor R$ 80\nhttps://amzn.to/b';
  const o = lerOfertaDoTexto(texto);
  assert.deepEqual(o.urls, ['https://amzn.to/a', 'https://amzn.to/b']);
  assert.equal(o.title, 'Fone A');
  assert.equal(o.price, 50);
  // Nada no objeto diz que havia dois "Por": a etapa 11 criará dois itens com título e preço do produto A.
  assert.ok(!('ambigua' in o) && !('precos' in o), 'sem sinal de ambiguidade para quem consome');
});

test('QA oferta-texto (Q4): "Cupom exclusivo: DESEJO10" e "cupom novo ABC123" devem achar o código depois da palavra de enfeite', () => {
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\nCupom exclusivo: DESEJO10').coupon, 'DESEJO10');
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\ncupom novo ABC123').coupon, 'ABC123');
});

test('QA oferta-texto: falsos positivos documentados (faixa "40-60%", "sem frete grátis", "pague 2 compras", chamada como título)', () => {
  // Q5, Q6, Q15 e Q14: comportamento atual, severidade baixa. Se o dev ajustar, inverter as asserções.
  assert.equal(lerOfertaDoTexto('Umidificador\nPor R$ 50\numidade entre 40-60%').discountPct, 60, 'Q5: "-60%" de uma faixa vira desconto');
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\nSem frete grátis').freeShipping, true, 'Q6: negação não é lida');
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\nFrete gratuito').freeShipping, false, 'Q6: "gratuito" não é lido');
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\nLeve 3 pague 2 compras').sold, 2, 'Q15');
  assert.equal(lerOfertaDoTexto('🔥 OFERTA RELÂMPAGO 🔥\nFone JBL\nPor R$ 80').title, 'OFERTA RELÂMPAGO', 'Q14: chamada na 1ª linha vira título');
});

test('QA oferta-texto: extrairUrls com markdown do WhatsApp em volta, acento no caminho, URL colada em texto e link em maiúsculas', () => {
  assert.deepEqual(extrairUrls('*https://amzn.to/abc*  ~www.amazon.com.br/dp/B0FG2MD49G?tag=x_~ (link.amazon/xyz).'),
    ['https://amzn.to/abc', 'https://www.amazon.com.br/dp/B0FG2MD49G?tag=x', 'https://link.amazon/xyz']);
  assert.deepEqual(extrairUrls('https://www.amazon.com.br/Título-Çedilha/dp/B0FG2MD49G'), ['https://www.amazon.com.br/Título-Çedilha/dp/B0FG2MD49G']);
  assert.deepEqual(extrairUrls('Compre:https://amzn.to/colado'), ['https://amzn.to/colado']);
  assert.deepEqual(extrairUrls('HTTPS://AMZN.TO/MAIUSC'), ['HTTPS://AMZN.TO/MAIUSC']);
  assert.deepEqual(extrairUrls('AMZN.TO/semesquema'), ['https://AMZN.TO/semesquema'], 'host sem esquema em maiúsculas também vale');
  assert.deepEqual(extrairUrls('mailto:x@amazon.com.br/y'), [], 'mailto não é link');
  assert.deepEqual(extrairUrls('https://'), [], 'esquema sem host');
});

test('QA oferta-texto: palavraBloqueada com lista hostil (regex, null, número, objeto), espaços múltiplos, zero-width e lista grande', () => {
  assert.equal(palavraBloqueada('produto usado', ['usad.*']), null, 'metacaractere é literal, não regex');
  assert.equal(palavraBloqueada('produto usad.* ok', ['usad.*']), 'usad.*', 'casa literalmente');
  assert.equal(palavraBloqueada('produto usado', ['[a-z]+', '(usado)', 'usado']), 'usado', 'itens com colchetes/parênteses não casam nem quebram');
  assert.equal(palavraBloqueada('produto usado', [null, 42, {}, [], 'usado']), 'usado', 'lixo na lista é ignorado');
  assert.equal(palavraBloqueada('semi   novo', ['semi novo']), 'semi novo', 'espaços múltiplos no texto');
  assert.equal(palavraBloqueada('semi novo', ['semi    novo']), 'semi    novo', 'espaços múltiplos na lista');
  assert.equal(palavraBloqueada('produto u​sado', ['usado']), null, 'zero-width dentro da palavra escapa (limitação conhecida)');
  assert.equal(palavraBloqueada('Produto Novo!', ['novo']), 'novo');
  assert.equal(palavraBloqueada('renovado', ['novo']), null, 'só início de palavra');
  assert.equal(palavraBloqueada('ÜSADO', ['usado']), 'usado');
  assert.equal(palavraBloqueada('produto usado', '["usado"]'), null, 'Q7: lista como string JSON não bloqueia nada (silencioso)');
  assert.equal(palavraBloqueada('produto usado', 'usado'), null, 'Q7: lista como string não bloqueia nada (silencioso)');
  const lista = Array.from({ length: 50 }, (_, i) => `palavra${i}-${'x'.repeat(50)}`);
  const texto = `${'a'.repeat(1000)} ${lista[49]}`;
  const inicio = Date.now();
  assert.equal(palavraBloqueada([texto, texto], lista), lista[49]);
  assert.ok(Date.now() - inicio < 500, '50 × 60 caracteres contra 2 KB em menos de 0,5 s');
  assert.equal(normalizar('Ç ß Ø ø'), 'c ß ø ø', 'normalizar: só diacríticos saem (ß e ø ficam)');
});

// ======================================================================================= privacidade (CA11)
test('QA privacidade: mascararPessoais com CPF, CNPJ, cartão, pedido, CEP e menção; preserva data, ASIN alfanumérico e preço comum', () => {
  const m = mascararPessoais('CPF 123.456.789-09 ou 12345678909; CNPJ 12.345.678/0001-90; cartão 4111 1111 1111 1111; pedido 702-1234567-1234567; CEP 30130-010; @5531999998888');
  for (const proibido of ['123.456.789-09', '12345678909', '4111 1111', '1234567-1234567', '30130-010', '5531999998888']) assert.ok(!m.includes(proibido), proibido);
  assert.ok(m.includes('12.345.678') === false || m.includes('/0001-90') === false, 'CNPJ pelo menos parcialmente mascarado');
  assert.equal(mascararPessoais('02/11/2026 B0FG2MD49G R$ 1.310,05 34% OFF +200 compras'), '02/11/2026 B0FG2MD49G R$ 1.310,05 34% OFF +200 compras');
  // Q8: sequências numéricas legítimas também somem; a etapa 11 precisa extrair as URLs ANTES de mascarar.
  assert.equal(mascararPessoais('https://www.amazon.com.br/dp/8535914846'), 'https://www.amazon.com.br/dp/…', 'Q8: ASIN numérico (livro) some da URL');
  assert.equal(mascararPessoais('R$ 12.345.678,90'), 'R$ …,90', 'Q8: preço ≥ R$ 10 milhões (irrelevante na prática)');
  assert.ok(!mascararPessoais(FIXTURES.compreAquiNaLinha).includes('qid=1730000000'), 'Q8: qid de 10 dígitos some da URL da fixture');
  for (const [nome, texto] of Object.entries(FIXTURES)) {
    if (nome === 'compreAquiNaLinha') continue;
    assert.equal(mascararPessoais(texto), texto, `fixture ${nome} passa intacta`);
    assert.deepEqual(semUrls(lerOfertaDoTexto(mascararPessoais(texto))), FIXTURES_ESPERADO[nome]);
  }
});

// ====================================================================================== template.js (CA8)
test('QA template: colchetes aninhados, linha só com pedaço opcional, valores com colchetes/cifrão e placeholder literal no título', () => {
  const minima = { title: 'Fone', price: 10, link: 'l' };
  // Sem aninhamento (documentado): só o colchete interno é opcional; o externo fica literal e pode ficar esquisito.
  assert.equal(renderTemplate('[a [b {CUPOM}] c] {TITULO_PRODUTO}', minima), '[a  c] Fone');
  assert.equal(renderTemplate('[a [b {CUPOM}] c] {TITULO_PRODUTO}', { ...minima, coupon: 'C1' }), '[a b C1 c] Fone');
  // Colchetes vindos do VALOR da oferta não são interpretados nem substituídos de novo.
  assert.equal(renderTemplate('{TITULO_PRODUTO} [{CUPOM}]', { ...minima, title: 'Fone [X] $& {LINK}', coupon: '[C]' }), 'Fone [X] $& {LINK} [C]');
  assert.equal(renderTemplate('[] [{CUPOM}] [x]', minima), '[]  [x]');
  assert.equal(renderTemplate('{TITULO_PRODUTO}[ {CUPOM}][ {CUPOM}]', { ...minima, coupon: 'C' }), 'Fone C C', 'o mesmo placeholder em dois pedaços');
  assert.equal(renderTemplate('[{TITULO_PRODUTO}]\n{LINK}', minima), 'Fone\nl', 'linha inteira opcional com valor fica sem os colchetes');
});

test('QA template (Q3): linha composta só por pedaço opcional vazio deve sumir, não virar linha em branco', () => {
  const minima = { title: 'Fone', price: 10, link: 'l' };
  assert.equal(renderTemplate('A\n[🎟️ Cupom: {CUPOM}]\nB', minima), 'A\nB');
  assert.equal(renderTemplate('A\n[{FRETE}][ · {CUPOM}]\nB', minima), 'A\nB');
});

test('QA template: oferta curta (sem preço) e só link com o TEMPLATE_AMAZON; desconto do texto sem "De"', () => {
  assert.equal(renderTemplate(TEMPLATE_AMAZON, { title: 'Fone', price: null, link: 'l' }), '*Fone*\n\n🛒 Compre aqui: l');
  assert.equal(renderTemplate(TEMPLATE_AMAZON, { title: null, price: null, link: 'l' }), '🛒 Compre aqui: l');
  // O texto de origem trouxe "34% OFF" e nenhum "De": o desconto aparece e o "De" não é inventado (CA8 + referência do dono).
  const out = renderTemplate(TEMPLATE_AMAZON, { title: 'Fone', price: 10, link: 'l', discountPct: 34, oldPrice: null });
  assert.ok(out.includes('🔥 Por *R$ 10,00* (34% OFF)') && !out.includes('De '));
});

// =================================================================================== db.js (etapa 1, CA8)
test('QA db: índice único de espelho_itens serve ao INSERT OR IGNORE da etapa 11 (changes 0 na repetição); msg_id nulo não deduplica', () => {
  const db = openDb(tmp());
  const { lastInsertRowid: esp } = db.prepare("INSERT INTO espelhos (nome, created_at) VALUES ('x', 1)").run();
  const ins = db.prepare('INSERT OR IGNORE INTO espelho_itens (espelho_id, origem_jid, msg_id, ts, url) VALUES (?, ?, ?, ?, ?)');
  assert.equal(ins.run(esp, 'o@g.us', 'M1', 1, 'https://amzn.to/a').changes, 1);
  assert.equal(ins.run(esp, 'o@g.us', 'M1', 2, 'https://amzn.to/a').changes, 0, 'repetição ignorada sem erro');
  // Atenção (nota para a etapa 11): com msg_id NULL o índice único não deduplica (NULL ≠ NULL no SQLite).
  assert.equal(ins.run(esp, 'o@g.us', null, 1, 'https://amzn.to/b').changes, 1);
  assert.equal(ins.run(esp, 'o@g.us', null, 1, 'https://amzn.to/b').changes, 1, 'msg_id nulo entra duas vezes');
  db.close();
});

// ============================================================================ whatsapp.js (CA9, CA11, CA10)
const recebida = (message, { id = 'MSG1', jid = GRUPO, fromMe = false, ts = 1793620000 } = {}) => ({
  key: { remoteJid: jid, fromMe, id, participant: PESSOA, participantPn: PESSOA },
  pushName: 'Maria da Silva', participant: PESSOA, messageTimestamp: ts, message,
});

test('QA whatsapp: textoDaMensagem com tipos do Baileys não previstos devolve "" (lista, botões, enquete, edição, figurinha, contato, local, áudio, interativa)', () => {
  const L = 'https://amzn.to/a';
  const tipos = [
    { listMessage: { description: L, title: L } }, { buttonsMessage: { contentText: L } }, { templateMessage: { hydratedTemplate: { hydratedContentText: L } } },
    { pollCreationMessageV3: { name: L } }, { pollCreationMessage: { name: L } }, { interactiveMessage: { body: { text: L } } },
    { editedMessage: { message: { protocolMessage: { editedMessage: { conversation: L } } } } }, { protocolMessage: { editedMessage: { conversation: L } } },
    { stickerMessage: {} }, { contactMessage: { displayName: L, vcard: L } }, { locationMessage: { comment: L } }, { audioMessage: {} },
    { groupInviteMessage: { caption: L } }, { productMessage: { product: { title: L } } }, { orderMessage: { message: L } },
    { senderKeyDistributionMessage: {} }, { messageContextInfo: {} }, { call: {} }, { extendedTextMessage: null }, { imageMessage: { caption: '' } },
    { imageMessage: { caption: 42 } }, { conversation: '' }, [], 'string', 7, true, () => L,
  ];
  for (const m of tipos) assert.equal(textoDaMensagem(m), '', JSON.stringify(m) ?? String(m));
  // Embrulho com 6 níveis passa do limite (5) e é ignorado; com 5 níveis é lido.
  const embrulhar = (n, dentro) => (n === 0 ? dentro : { ephemeralMessage: { message: embrulhar(n - 1, dentro) } });
  assert.equal(textoDaMensagem(embrulhar(5, { conversation: 'fundo' })), 'fundo');
  assert.equal(textoDaMensagem(embrulhar(6, { conversation: 'fundo' })), '');
  // Preferências entre campos presentes ao mesmo tempo.
  assert.equal(textoDaMensagem({ conversation: '', extendedTextMessage: { text: 'ext' } }), 'ext');
  assert.equal(textoDaMensagem({ conversation: 'conv', extendedTextMessage: { text: 'ext' } }), 'conv');
  assert.equal(textoDaMensagem({ extendedTextMessage: { text: '', matchedText: 'https://amzn.to/x' } }), 'https://amzn.to/x');
  assert.equal(textoDaMensagem({ documentMessage: { caption: 'doc https://amzn.to/a' } }), 'doc https://amzn.to/a', 'documento sem embrulho');
  assert.equal(textoDaMensagem(Object.assign(Object.create(null), { conversation: 'sem protótipo' })), 'sem protótipo');
  // Q11 (nota para a etapa 11): texto com link sem esquema + canonicalUrl da prévia → DOIS links do mesmo produto.
  const t = textoDaMensagem({ extendedTextMessage: { text: 'Veja amzn.to/abc', canonicalUrl: `https://www.amazon.com.br/dp/${ASIN}` } });
  assert.equal(extrairUrls(t).length, 2);
});

test('QA whatsapp: o ouvinte corta o texto em MAX_TEXTO_RECEBIDO (S1), mantém o link que cabe, aceita 1.000 mensagens num upsert, e ignora JIDs parecidos com grupo e fromMe como string', () => {
  const dir = tmp(); const db = openDb(dir);
  const recebidas = [];
  const wa = createWhatsApp({ db, dir, dryRun: true, onMensagem: (m) => recebidas.push(m) });
  const enorme = `${'x'.repeat(100_000)} https://amzn.to/a`;
  wa._onMensagens({ type: 'notify', messages: [recebida({ conversation: enorme }, { id: 'GRANDE' })] });
  assert.equal(recebidas[0].texto.length, MAX_TEXTO_RECEBIDO, 'S1 (CWE-400): o ouvinte corta em MAX_TEXTO_RECEBIDO; o corte em 1.000 para o banco é da etapa 11');
  // o corte não atrapalha a mensagem normal: link inteiro dentro do limite passa intacto e na mesma posição
  recebidas.length = 0;
  const cabe = `${'y'.repeat(MAX_TEXTO_RECEBIDO - 40)} https://amzn.to/abc123`;
  wa._onMensagens({ type: 'notify', messages: [recebida({ conversation: cabe }, { id: 'CABE' })] });
  assert.equal(recebidas[0].texto, cabe);
  assert.deepEqual(extrairUrls(recebidas[0].texto), ['https://amzn.to/abc123']);

  recebidas.length = 0;
  wa._onMensagens({ type: 'notify', messages: [
    recebida({ conversation: 'a' }, { id: 'A', jid: '123@g.us.golpe.com' }),
    recebida({ conversation: 'b' }, { id: 'B', jid: '123@G.US' }),
    recebida({ conversation: 'c' }, { id: 'C', jid: '@g.us' }),
    recebida({ conversation: 'd' }, { id: 'D', fromMe: 'true' }),
    recebida({ conversation: 'e' }, { id: 'E', fromMe: 1 }),
    { key: { remoteJid: GRUPO, id: 'F' }, message: { conversation: 'f' } },
  ] });
  assert.deepEqual(recebidas.map((r) => [r.msgId, r.fromMe]), [['C', false], ['D', false], ['E', false], ['F', false]], 'só terminação exata em @g.us; fromMe só com true booleano');

  recebidas.length = 0;
  const lote = Array.from({ length: 1000 }, (_, i) => recebida({ conversation: `m${i} https://amzn.to/${i}` }, { id: `L${i}` }));
  const inicio = Date.now();
  wa._onMensagens({ type: 'notify', messages: lote });
  assert.equal(recebidas.length, 1000);
  assert.ok(Date.now() - inicio < 1000);
  db.close();
});

test('QA whatsapp: a entrega é um objeto novo por mensagem, sem referência ao WAMessage, e o handler mexer nele não afeta o próximo', () => {
  const dir = tmp(); const db = openDb(dir);
  const vistas = [];
  const wa = createWhatsApp({ db, dir, dryRun: true, onMensagem: (m) => { vistas.push(m); m.texto = 'mexido'; m.extra = 1; } });
  const original = recebida({ conversation: 'oi https://amzn.to/a' }, { id: 'X' });
  wa._onMensagens({ type: 'notify', messages: [original, recebida({ conversation: 'dois' }, { id: 'Y' })] });
  assert.equal(original.message.conversation, 'oi https://amzn.to/a', 'o WAMessage não muda');
  assert.equal(vistas[1].texto, 'mexido', 'o handler recebeu e pôde alterar o seu objeto');
  assert.ok(vistas[0] !== vistas[1]);
  assert.equal(Object.getPrototypeOf(vistas[0]), Object.prototype);
  db.close();
});

// ================================================================================================== CA10
test('QA CA10: nada do grupo A chamou o fetch global (ouvinte, parser, template, extrairAsin e resolverLink direto)', async () => {
  assert.equal((await resolverLink(`https://www.amazon.com.br/dp/${ASIN}`)).asin, ASIN, 'ASIN na URL resolve sem rede mesmo com o fetch padrão');
  assert.equal(chamadasRede, 0);
});
