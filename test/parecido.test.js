// Produto igual ou parecido (plano nao-repetir-produto-parecido, etapa 2; CA1 a CA6): o módulo puro `src/parecido.js`.
// Sem rede, sem WhatsApp, sem o banco do projeto: `lerEnviados` roda numa tabela própria em memória. Os relógios são
// fixos e montados com componentes locais (`new Date(a, m, d, h, min)`), para valerem em qualquer fuso.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  LIMIAR_PARECIDO, HORAS_ENTRE_PARECIDOS, PALAVRAS_PARECIDO, MIN_PALAVRAS, FRASE_MAIS_BARATA, DESCONTO_MINIMO_MAIS_BARATA,
  palavras, comparar, centavos, maisBarataOBastante, tituloParaGuardar, lerEnviados, criarTrava, comFraseMaisBarata,
  textoConflito, textoPassou, textoConferencia, textoNaoMaisBarata,
} from '../src/parecido.js';

const H = 3600000;
const D = 24 * H;
const AGORA = new Date(2026, 10, 10, 12, 0).getTime();

const SHAMPOO = 'Shampoo Lola Cosmetics Meu Cacho 500ml';
const CONDICIONADOR = 'Condicionador Lola Cosmetics Minha Vida 500ml';
const AREIA_FINA = 'Areia Higiênica Pipicat Fina 4kg';
const AREIA_MISTA = 'Areia Higiênica Pipicat Mista 4kg';
// a mesma sequência de palavras de AREIA_FINA (o "mesmo" produto com outro código), escrita de outros jeitos
const AREIA_FINA_2 = 'AREIA HIGIÊNICA PIPICAT FINA (4KG)';
const AREIA_FINA_3 = 'Areia Higienica Pipicat Fina 4kg Oferta';

/** Linha de `sent_offers` como `lerEnviados` devolve. */
const envio = (offer_key, title, price_cents, sent_at) => ({ offer_key, title, price_cents, sent_at });
const trava = (enviados, dedupeDias = 7, extra = {}) => criarTrava({ enviados, agora: AGORA, dedupeDias, ...extra });

// ------------------------------------------------------------------------------------------ constantes e palavras
test('as constantes são as do plano (D1, D2, D7, D11)', () => {
  assert.equal(DESCONTO_MINIMO_MAIS_BARATA, 5);
  assert.equal(LIMIAR_PARECIDO, 0.75);
  assert.equal(HORAS_ENTRE_PARECIDOS, 24);
  assert.equal(PALAVRAS_PARECIDO, 8);
  assert.equal(MIN_PALAVRAS, 3);
  assert.equal(FRASE_MAIS_BARATA, '🔎 Nossa busca achou esta oportunidade ainda melhor, caso você ainda não tenha aproveitado a primeira.');
});

test('palavras: minúsculas, sem acento, pontuação vira espaço, sai palavra de 1 letra e as vazias', () => {
  assert.deepEqual(palavras('  AREIA Higiênica, Pipicat!!! Fina — 4Kg  '), ['areia', 'higienica', 'pipicat', 'fina', '4kg']);
  assert.deepEqual(palavras('La Roche-Posay Cicaplast B5+ 40 ml'), ['la', 'roche', 'posay', 'cicaplast', 'b5', '40', 'ml']);
  assert.deepEqual(palavras('Kit 3 Fraldas de Algodão para Bebê com Frete Grátis'), ['kit', 'fraldas', 'algodao', 'bebe']);
  assert.deepEqual(palavras('Original Oferta Promoção Novo Nova Envio Imediato Premium Top Lançamento sem por no na em ou e'), []);
  assert.deepEqual(palavras(''), []);
  for (const ruim of [null, undefined, 12, {}, ['a b c']]) assert.deepEqual(palavras(ruim), []);
});

// ------------------------------------------------------------------------------------------------------- comparar
test('comparar: shampoo × condicionador da mesma marca dá 50% e não é parecido (CA3)', () => {
  assert.equal(comparar(SHAMPOO, CONDICIONADOR), null);
});

test('comparar: areia fina × mista é parecido (80%)', () => {
  assert.equal(comparar(AREIA_FINA, AREIA_MISTA), 'parecido');
});

test('comparar: kit × unidade do mesmo produto é parecido', () => {
  assert.equal(comparar('Kit 3 Shampoo Anticaspa Clear Men 400ml', 'Shampoo Anticaspa Clear Men 400ml'), 'parecido');
});

test('comparar: o mesmo Cicaplast com códigos diferentes — mesma sequência é "mesmo", reordenado e com sobra é parecido', () => {
  assert.equal(comparar('La Roche-Posay Cicaplast Baume B5 40ml', 'LA ROCHE POSAY CICAPLAST BAUME B5 - 40ml!'), 'mesmo');
  assert.equal(
    comparar('Pomada Cicaplast Baume B5 La Roche-Posay 40ml', 'Cicaplast Baume B5 Pomada Reparadora La Roche-Posay 40ml'),
    'parecido',
  );
});

test('comparar: marcas diferentes e mesma marca com produtos diferentes não são parecidos (CA3)', () => {
  assert.equal(comparar('Fone Bluetooth JBL Tune 510BT', 'Fone Bluetooth Philips TAH1108'), null);
  assert.equal(comparar('Perfume Natura Ekos Frescor Maracujá 150ml', 'Sabonete Natura Ekos Castanha 90g'), null);
  assert.equal(comparar('Tênis Nike Air Max Preto 42', 'Camiseta Nike Dri Fit Azul M'), null);
});

test('comparar: com menos de 3 palavras significativas nunca compara, nem o idêntico (CA3)', () => {
  assert.equal(comparar('Fone Bom', 'Fone Bom'), null);
  assert.equal(comparar('Perfume Floral', 'Perfume Floral Feminino'), null);
  assert.equal(comparar('Fone Bom de', 'Fone Bom de'), null); // "de" é vazia: sobram 2
  assert.equal(comparar('Fone Bom Barato Original', 'Fone Bom'), null);
  assert.equal(comparar('', 'a b c d'), null);
  assert.equal(comparar(null, undefined), null);
});

test('comparar: só as 8 primeiras palavras entram no grau; a sequência completa decide o "mesmo"', () => {
  const base = 'um dois tres quatro cinco seis sete oito';
  assert.equal(comparar(`${base} nove dez`, `${base} onze doze treze`), 'parecido');
  assert.equal(comparar(`${base} nove`, `${base} nove`), 'mesmo');
  assert.equal(comparar(`${base} nove`, `${base} dez`), 'parecido');
  // fora das 8 primeiras não ajuda: 6 de 8 = 75% passa; 5 de 8 não
  assert.equal(comparar('aa bb cc dd ee ff gg hh', 'aa bb cc dd ee ff xx yy'), 'parecido');
  assert.equal(comparar('aa bb cc dd ee ff gg hh', 'aa bb cc dd ee xx yy zz'), null);
  assert.equal(comparar('aa bb cc dd ee ff gg hh ii jj', 'xx yy zz ww vv uu tt ss ii jj'), null);
  // o que passa da 8ª palavra não atrapalha: 6 de 8 = 75%, ainda que 6 de 10 não fosse
  assert.equal(comparar('aa bb cc dd ee ff gg hh ii jj', 'aa bb cc dd ee ff xx yy zz ww'), 'parecido');
});

test('comparar: o limiar é inclusivo e pode ser trocado', () => {
  assert.equal(comparar('aa bb cc dd', 'aa bb cc zz'), 'parecido'); // 3 de 4 = 0,75 exato
  assert.equal(comparar('aa bb cc dd', 'aa bb zz yy'), null);
  assert.equal(comparar('aa bb cc dd', 'aa bb zz yy', { limiar: 0.5 }), 'parecido');
  assert.equal(comparar('aa bb cc dd', 'aa bb cc zz', { limiar: 0.9 }), null);
});

test('comparar: usa o menor dos dois conjuntos como base', () => {
  // 3 palavras dentro de um título de 5: 3/3 = 100%
  assert.equal(comparar('Areia Pipicat Fina', 'Areia Pipicat Fina Higiênica 4kg'), 'parecido');
  assert.equal(comparar('Areia Pipicat Fina Higiênica 4kg', 'Areia Pipicat Fina'), 'parecido');
});

// ---------------------------------------------------------------------------------------------------- centavos
test('centavos: reais em centavos inteiros, sem erro de ponto flutuante; o resto vira null', () => {
  assert.equal(centavos(49.9), 4990);
  assert.equal(centavos(0.1 + 0.2), 30);
  assert.equal(centavos(0.01), 1);
  assert.equal(centavos('59.90'), 5990);
  for (const ruim of [0, -1, 0.004, NaN, Infinity, '', '  ', 'abc', null, undefined, true, {}, []]) {
    assert.equal(centavos(ruim), null, String(ruim));
  }
});

test('tituloParaGuardar: espaços colapsados, até 200 caracteres, vazio ou não-texto vira null', () => {
  assert.equal(tituloParaGuardar('  Fone   Bom \n Barato  '), 'Fone Bom Barato');
  assert.equal(tituloParaGuardar('x'.repeat(300)).length, 200);
  assert.equal(tituloParaGuardar(`${'a '.repeat(150)}`).length <= 200, true);
  for (const ruim of ['', '   \n', null, undefined, 5, {}]) assert.equal(tituloParaGuardar(ruim), null);
  // não corta um emoji ao meio
  const cortado = tituloParaGuardar(`${'x'.repeat(199)}😀`);
  assert.equal(cortado, 'x'.repeat(199));
});

// ------------------------------------------------------------------------------------------------ lerEnviados
test('lerEnviados: só da regra, só depois de `desde`, só com título, do mais antigo ao mais novo', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sent_offers (id INTEGER PRIMARY KEY, rule_id INTEGER, offer_key TEXT, sent_at INTEGER, title TEXT, price_cents INTEGER)');
  const ins = db.prepare('INSERT INTO sent_offers (rule_id, offer_key, sent_at, title, price_cents) VALUES (?,?,?,?,?)');
  ins.run(1, 'c', 3000, 'Terceiro Título Aqui', 3000);
  ins.run(1, 'a', 1000, 'Primeiro Título Aqui', 1000);
  ins.run(1, 'b', 2000, 'Segundo Título Aqui', null);
  ins.run(1, 'sem-titulo', 2500, null, 500);
  ins.run(1, 'velho', 100, 'Velho Título Aqui', 100);
  ins.run(1, 'limite', 500, 'No Limite Exato', 100);
  ins.run(2, 'outra-regra', 2000, 'Outra Regra Título', 200);
  const linhas = lerEnviados(db, 1, 500);
  assert.deepEqual(linhas.map((l) => l.offer_key), ['a', 'b', 'c']);
  assert.deepEqual({ ...linhas[0] }, { offer_key: 'a', title: 'Primeiro Título Aqui', price_cents: 1000, sent_at: 1000 });
  assert.equal(linhas[1].price_cents, null);
  assert.deepEqual(lerEnviados(db, 3, 0), []);
  // devolve objetos comuns (os do node:sqlite têm protótipo nulo)
  assert.equal(Object.getPrototypeOf(linhas[0]), Object.prototype);
  db.close();
});

// ------------------------------------------------------------------------------------------ trava: janelas (CA1, CA2)
test('trava: mesmo título com outra chave dentro de dedupe_days é barrado como "mesmo" (CA1)', () => {
  const t = trava([envio('K1', 'La Roche-Posay Cicaplast Baume B5 40ml', 4990, AGORA - 2 * D)], 7);
  const r = t.avaliar({ key: 'K2', title: 'LA ROCHE POSAY Cicaplast Baume B5 - 40ml', price: 49.9 });
  assert.equal(r.acao, 'barrar');
  assert.equal(r.tipo, 'mesmo');
  assert.deepEqual(r.anterior, { title: 'La Roche-Posay Cicaplast Baume B5 40ml', preco: 4990, sent_at: AGORA - 2 * D });
});

test('trava: o mesmo título só vale dentro de dedupe_days; depois dele sai', () => {
  const enviados = [envio('K1', AREIA_FINA, 4990, AGORA - 4 * D)];
  assert.equal(trava(enviados, 3).avaliar({ key: 'K2', title: AREIA_FINA, price: 49.9 }), null);
  assert.equal(trava(enviados, 5).avaliar({ key: 'K2', title: AREIA_FINA, price: 49.9 }).tipo, 'mesmo');
  assert.equal(trava(enviados, 7).avaliar({ key: 'K2', title: AREIA_FINA, price: 49.9 }).tipo, 'mesmo');
});

test('trava: parecido espera 24 h (23 h barra, 25 h passa), mesmo com dedupe_days maior (CA2)', () => {
  for (const dias of [3, 7]) {
    const a23 = trava([envio('K1', AREIA_FINA, 4990, AGORA - 23 * H)], dias).avaliar({ key: 'K2', title: AREIA_MISTA, price: 49.9 });
    assert.equal(a23.acao, 'barrar');
    assert.equal(a23.tipo, 'parecido');
    const a25 = trava([envio('K1', AREIA_FINA, 4990, AGORA - 25 * H)], dias).avaliar({ key: 'K2', title: AREIA_MISTA, price: 49.9 });
    assert.equal(a25, null, `dedupe_days ${dias}`);
  }
});

test('trava: a espera do parecido nunca passa da janela da regra (dedupe_days menor que 1 dia)', () => {
  const enviados = [envio('K1', AREIA_FINA, 4990, AGORA - 13 * H)];
  assert.equal(trava(enviados, 0.5).avaliar({ key: 'K2', title: AREIA_MISTA, price: 49.9 }), null); // janela de 12 h
  assert.equal(trava(enviados, 1).avaliar({ key: 'K2', title: AREIA_MISTA, price: 49.9 }).tipo, 'parecido');
});

test('trava: mesmo título com 25 h e dedupe_days 3 ainda é barrado (a janela do mesmo é dedupe_days)', () => {
  const r = trava([envio('K1', AREIA_FINA, 4990, AGORA - 25 * H)], 3).avaliar({ key: 'K2', title: AREIA_FINA, price: 49.9 });
  assert.equal(r.tipo, 'mesmo');
});

test('trava: dedupe_days 0 (ou inválido) desliga a parte entre rodadas', () => {
  const enviados = [envio('K1', AREIA_FINA, 4990, AGORA - 1 * H)];
  for (const dias of [0, -1, null, undefined, NaN]) {
    const t = criarTrava({ enviados, agora: AGORA, dedupeDias: dias });
    assert.equal(t.avaliar({ key: 'K2', title: AREIA_FINA, price: 10 }), null, String(dias));
    assert.equal(t.avaliar({ key: 'K3', title: AREIA_MISTA, price: 10 }), null, String(dias));
  }
});

test('trava: a mesma chave nunca conta (reenvio do mesmo item e `wasSent` cuidam dela)', () => {
  const t = trava([envio('K1', AREIA_FINA, 4990, AGORA - 1 * H)], 7);
  assert.equal(t.avaliar({ key: 'K1', title: AREIA_FINA, price: 49.9 }), null);
  assert.equal(t.avaliar({ key: 'K1', title: AREIA_MISTA, price: 49.9 }), null);
  // a chave comparada como texto
  assert.equal(trava([envio('123', AREIA_FINA, 4990, AGORA - H)], 7).avaliar({ key: 123, title: AREIA_FINA, price: 1 }), null);
});

test('trava: produtos diferentes da mesma marca passam (CA3); título curto nunca é comparado', () => {
  const t = trava([envio('K1', CONDICIONADOR, 4990, AGORA - 1 * H), envio('K9', 'Fone Bom', 1000, AGORA - H)], 7);
  assert.equal(t.avaliar({ key: 'K2', title: SHAMPOO, price: 49.9 }), null);
  assert.equal(t.avaliar({ key: 'K3', title: 'Fone Bom', price: 10 }), null);
  assert.equal(t.avaliar({ key: 'K4', title: '', price: 10 }), null);
  assert.equal(t.avaliar({ key: 'K5' }), null);
  assert.equal(t.avaliar(), null);
});

test('trava: de outra regra ou sem título nem entram (linhas ruins são ignoradas)', () => {
  const t = trava([null, envio('K1', null, 4990, AGORA - H), envio('K2', 'Fone', 100, AGORA - H)], 7);
  assert.equal(t.avaliar({ key: 'K3', title: AREIA_FINA, price: 1 }), null);
  assert.equal(criarTrava({ agora: AGORA, dedupeDias: 7 }).avaliar({ key: 'K3', title: AREIA_FINA, price: 1 }), null);
});

// ---------------------------------------------------------------------------------------------- trava: preço (CA4)
test('maisBarataOBastante: pelo menos 5% abaixo, só com centavos inteiros (D11)', () => {
  assert.equal(maisBarataOBastante(9500, 10000), true); // R$ 100,00 → R$ 95,00 libera
  assert.equal(maisBarataOBastante(9501, 10000), false); // R$ 95,01 barra
  assert.equal(maisBarataOBastante(1, 10000), true);
  assert.equal(maisBarataOBastante(10000, 10000), false);
  assert.equal(maisBarataOBastante(12000, 10000), false);
  // 95% de 49,90 = 47,405: 47,40 libera, 47,41 barra (sem arredondar o limite)
  assert.equal(maisBarataOBastante(4740, 4990), true);
  assert.equal(maisBarataOBastante(4741, 4990), false);
  // desconhecido ou inválido, de qualquer lado, barra
  for (const ruim of [null, undefined, 0, -1, 47.4, NaN, '4740', Infinity]) {
    assert.equal(maisBarataOBastante(ruim, 4990), false, `novo ${String(ruim)}`);
    assert.equal(maisBarataOBastante(4740, ruim), false, `anterior ${String(ruim)}`);
  }
  // S1: inteiro fora da faixa exata (acima de 2^53) também barra, de qualquer lado; o maior exato ainda vale
  for (const enorme of [2 ** 60, Number.MAX_SAFE_INTEGER + 1, -Infinity, Number.MAX_VALUE]) {
    assert.equal(maisBarataOBastante(4740, enorme), false, `anterior ${String(enorme)}`);
    assert.equal(maisBarataOBastante(enorme, 4990), false, `novo ${String(enorme)}`);
  }
  assert.equal(maisBarataOBastante(4740, Number.MAX_SAFE_INTEGER), true);
});

test('trava: o mesmo título com outra chave e pelo menos 5% mais barato é liberado e cita a anterior (CA4)', () => {
  const t = trava([envio('K1', AREIA_FINA, 5990, AGORA - 2 * D)], 7);
  const r = t.avaliar({ key: 'K2', title: AREIA_FINA_2, price: 55 });
  assert.deepEqual(r, { acao: 'liberar', anterior: { title: AREIA_FINA, preco: 5990, sent_at: AGORA - 2 * D } });
});

test('trava: limite exato dos 5% (R$ 100,00 → 95,00 libera; 95,01 barra), sem erro de arredondamento', () => {
  const t = trava([envio('K1', AREIA_FINA, 10000, AGORA - 3 * H)], 7);
  const fina = (price) => t.avaliar({ key: 'K2', title: AREIA_FINA_2, price });
  assert.equal(fina(95).acao, 'liberar');
  assert.equal(fina('95.00').acao, 'liberar');
  assert.equal(fina(94.5 + 0.5).acao, 'liberar');
  for (const price of [95.01, 99.99, 100, 120]) {
    const r = fina(price);
    assert.equal(r.acao, 'barrar', String(price));
    assert.equal(r.tipo, 'mesmo');
    assert.equal(r.anterior.preco, 10000);
  }
  // 95% de 49,90 = 47,405: 47,40 (mesmo vindo de conta com ponto flutuante) libera, 47,41 barra
  const t2 = trava([envio('K1', AREIA_FINA, 4990, AGORA - 3 * H)], 7);
  assert.equal(t2.avaliar({ key: 'K2', title: AREIA_FINA, price: 47.3 + 0.1 }).acao, 'liberar');
  assert.equal(t2.avaliar({ key: 'K2', title: AREIA_FINA, price: 47.41 }).acao, 'barrar');
  assert.equal(t2.avaliar({ key: 'K2', title: AREIA_FINA, price: 49.89 }).acao, 'barrar'); // um centavo a menos não basta
  assert.equal(t2.avaliar({ key: 'K2', title: AREIA_FINA, price: 49.5 + 0.4 }).acao, 'barrar');
});

test('trava: parecida (título não igual) não tem exceção de preço: barra em 3 h, mesmo baratíssima; em 25 h sai (CA2, D10)', () => {
  for (const price of [1, 10, 47.4, 49.89, 49.9, 80]) {
    const r = trava([envio('K1', AREIA_FINA, 4990, AGORA - 3 * H)], 7).avaliar({ key: 'K2', title: AREIA_MISTA, price });
    assert.deepEqual(r, { acao: 'barrar', tipo: 'parecido', anterior: { title: AREIA_FINA, preco: 4990, sent_at: AGORA - 3 * H } }, String(price));
  }
  assert.equal(trava([envio('K1', AREIA_FINA, 4990, AGORA - 25 * H)], 7).avaliar({ key: 'K2', title: AREIA_MISTA, price: 10 }), null);
});

test('trava: o mesmo título mais barato com uma parecida nas últimas 24 h barra, citando a parecida (CA4, D10)', () => {
  const enviados = [envio('K1', AREIA_FINA, 9990, AGORA - 2 * D), envio('K2', AREIA_MISTA, 9990, AGORA - 3 * H)];
  const r = trava(enviados, 7).avaliar({ key: 'K3', title: AREIA_FINA, price: 10 });
  assert.deepEqual(r, { acao: 'barrar', tipo: 'parecido', anterior: { title: AREIA_MISTA, preco: 9990, sent_at: AGORA - 3 * H } });
  // a parecida de 30 h atrás já não conta: só o mesmo título fica, e ele libera
  const depois = [envio('K1', AREIA_FINA, 9990, AGORA - 2 * D), envio('K2', AREIA_MISTA, 1000, AGORA - 30 * H)];
  const livre = trava(depois, 7).avaliar({ key: 'K3', title: AREIA_FINA, price: 10 });
  assert.equal(livre.acao, 'liberar');
  assert.equal(livre.anterior.title, AREIA_FINA);
});

test('trava: preço desconhecido, de qualquer lado, barra', () => {
  const comPreco = trava([envio('K1', AREIA_FINA, 4990, AGORA - 3 * H)], 7);
  for (const price of [null, undefined, 0, -5, NaN, '', 'abc']) {
    const r = comPreco.avaliar({ key: 'K2', title: AREIA_FINA_2, price });
    assert.equal(r.acao, 'barrar', String(price));
    assert.equal(r.tipo, 'mesmo');
    assert.equal(r.anterior.preco, 4990);
  }
  const semPreco = trava([envio('K1', AREIA_FINA, null, AGORA - 3 * H)], 7);
  const r = semPreco.avaliar({ key: 'K2', title: AREIA_FINA_2, price: 1 });
  assert.equal(r.acao, 'barrar');
  assert.equal(r.anterior.preco, null);
  for (const zero of [0, -3]) {
    assert.equal(trava([envio('K1', AREIA_FINA, zero, AGORA - 3 * H)], 7).avaliar({ key: 'K2', title: AREIA_FINA_2, price: 1 }).anterior.preco, null);
  }
});

test('trava: um conflito sem preço entre vários barra e é o citado', () => {
  const t = trava([
    envio('K1', AREIA_FINA, 5990, AGORA - 5 * H),
    envio('K2', AREIA_FINA_2, null, AGORA - 4 * H),
  ], 7);
  const r = t.avaliar({ key: 'K3', title: AREIA_FINA_3, price: 10 });
  assert.equal(r.acao, 'barrar');
  assert.equal(r.anterior.preco, null);
  assert.equal(r.anterior.title, AREIA_FINA_2);
});

test('trava: com três envios do mesmo título na janela (59,90, 49,90, 54,90) só sai 5% abaixo de 49,90', () => {
  const t = trava([
    envio('K1', AREIA_FINA, 5990, AGORA - 10 * H),
    envio('K2', AREIA_FINA_2, 4990, AGORA - 8 * H),
    envio('K3', AREIA_FINA_3, 5490, AGORA - 6 * H),
  ], 7);
  const fina = (price) => t.avaliar({ key: 'K9', title: AREIA_FINA, price });
  assert.equal(fina(52).acao, 'barrar'); // 5% abaixo da última, mas não do mínimo
  assert.equal(fina(49.89).acao, 'barrar');
  const barrada = fina(47.41);
  assert.equal(barrada.acao, 'barrar');
  assert.equal(barrada.anterior.preco, 4990); // cita a do mínimo
  const livre = fina(47.4);
  assert.equal(livre.acao, 'liberar');
  assert.equal(livre.anterior.preco, 4990);
  assert.equal(livre.anterior.title, AREIA_FINA_2);
});

test('trava: empate no mínimo cita a anterior mais recente', () => {
  const t = trava([
    envio('K1', AREIA_FINA, 4990, AGORA - 10 * H),
    envio('K2', AREIA_FINA_2, 4990, AGORA - 3 * H),
    envio('K3', AREIA_FINA_3, 5990, AGORA - 1 * H),
  ], 7);
  const r = t.avaliar({ key: 'K9', title: AREIA_FINA, price: 40 });
  assert.equal(r.acao, 'liberar');
  assert.equal(r.anterior.sent_at, AGORA - 3 * H);
  assert.equal(t.avaliar({ key: 'K9', title: AREIA_FINA, price: 49.9 }).anterior.sent_at, AGORA - 3 * H);
});

test('trava: empate de preço e de hora cita a linha que vem por último (a de maior id)', () => {
  const t = trava([
    envio('K1', AREIA_FINA, 4990, AGORA - 3 * H),
    envio('K2', AREIA_FINA_2, 4990, AGORA - 3 * H),
  ], 7);
  assert.equal(t.avaliar({ key: 'K9', title: AREIA_FINA_3, price: 40 }).anterior.title, AREIA_FINA_2);
});

test('trava: só os conflitos da janela entram no mínimo (um envio do mesmo título de 8 dias atrás, mais barato, é ignorado)', () => {
  const t = trava([
    envio('K1', AREIA_FINA, 1000, AGORA - 8 * D), // fora da janela de 7 dias da regra
    envio('K2', AREIA_FINA_2, 5990, AGORA - 2 * H),
  ], 7);
  assert.equal(t.avaliar({ key: 'K9', title: AREIA_FINA, price: 50 }).acao, 'liberar');
});

// ------------------------------------------------------------------------------------- trava: mesma rodada (CA2)
test('trava: parecida na mesma rodada barra, mesmo a mais barata, em qualquer dedupe_days', () => {
  for (const dias of [0, 3, 7]) {
    const t = trava([], dias);
    t.acrescentar({ key: 'K1', title: AREIA_FINA });
    for (const price of [1, 49.9, 500, null]) {
      const r = t.avaliar({ key: 'K2', title: AREIA_MISTA, price });
      assert.deepEqual(r, { acao: 'barrar', tipo: 'rodada', anterior: { title: AREIA_FINA, preco: null, sent_at: null } }, `${dias}/${price}`);
    }
  }
});

test('trava: o mesmo título na mesma rodada também barra; a rodada vence a exceção do mais barato', () => {
  const t = trava([envio('K0', AREIA_FINA, 9990, AGORA - 2 * D)], 7);
  t.acrescentar({ key: 'K1', title: AREIA_FINA });
  assert.equal(t.avaliar({ key: 'K2', title: AREIA_FINA, price: 10 }).tipo, 'rodada');
});

test('trava: na rodada, produto diferente, título curto e a mesma chave não barram; título curto não é registrado', () => {
  const t = trava([], 0);
  t.acrescentar({ key: 'K1', title: AREIA_FINA });
  t.acrescentar({ key: 'K7', title: 'Fone Bom' });
  t.acrescentar({ key: 'K8' });
  t.acrescentar();
  assert.equal(t.avaliar({ key: 'K2', title: SHAMPOO, price: 1 }), null);
  assert.equal(t.avaliar({ key: 'K3', title: 'Fone Bom', price: 1 }), null);
  assert.equal(t.avaliar({ key: 'K1', title: AREIA_FINA, price: 1 }), null);
});

test('trava: as escolhidas de uma execução não vazam para outra trava', () => {
  const a = trava([], 7);
  a.acrescentar({ key: 'K1', title: AREIA_FINA });
  assert.equal(trava([], 7).avaliar({ key: 'K2', title: AREIA_MISTA, price: 1 }), null);
});

test('trava: limiar e horas são ajustáveis', () => {
  const enviados = [envio('K1', AREIA_FINA, 4990, AGORA - 30 * H)];
  assert.equal(trava(enviados, 7).avaliar({ key: 'K2', title: AREIA_MISTA, price: 60 }), null);
  assert.equal(trava(enviados, 7, { horas: 48 }).avaliar({ key: 'K2', title: AREIA_MISTA, price: 60 }).tipo, 'parecido');
  assert.equal(trava(enviados, 7, { horas: 48, limiar: 0.9 }).avaliar({ key: 'K2', title: AREIA_MISTA, price: 60 }), null);
});

// --------------------------------------------------------------------------------------------- frases (CA5, CA6)
test('comFraseMaisBarata: a frase, uma linha em branco e o texto (CA5)', () => {
  assert.equal(comFraseMaisBarata('Oferta\nR$ 49,90'), `${FRASE_MAIS_BARATA}\n\nOferta\nR$ 49,90`);
  assert.ok(comFraseMaisBarata('x').startsWith(`${FRASE_MAIS_BARATA}\n\n`));
  assert.equal(comFraseMaisBarata(''), `${FRASE_MAIS_BARATA}\n\n`);
  assert.equal(comFraseMaisBarata(null), `${FRASE_MAIS_BARATA}\n\n`);
});

const QUANDO_HOJE = new Date(2026, 10, 10, 9, 2).getTime();
const QUANDO_OUTRO_DIA = new Date(2026, 10, 8, 9, 2).getTime();

test('textoConflito: "mesmo", com hora de outro dia e preço (CA6)', () => {
  const r = { acao: 'barrar', tipo: 'mesmo', anterior: { title: 'Cicaplast Baume B5 40ml', preco: 4990, sent_at: QUANDO_OUTRO_DIA } };
  assert.equal(
    textoConflito(r, AGORA),
    'Pulada: o mesmo produto saiu por este disparo às 09:02 de 08/11 por R$ 49,90, com outro código ("Cicaplast Baume B5 40ml"). Só sai de novo se estiver pelo menos 5% mais barato.',
  );
});

test('textoConflito: "parecido", com a hora de hoje; sem preço guardado; prefixo do Catálogo', () => {
  const r = { acao: 'barrar', tipo: 'parecido', anterior: { title: AREIA_FINA, preco: 4990, sent_at: QUANDO_HOJE } };
  assert.equal(
    textoConflito(r, AGORA),
    `Pulada: parecida com "${AREIA_FINA}", que saiu por este disparo às 09:02 por R$ 49,90. Ofertas parecidas esperam 24 h.`,
  );
  assert.equal(
    textoConflito(r, AGORA, { prefixo: 'Não enviada' }),
    `Não enviada: parecida com "${AREIA_FINA}", que saiu por este disparo às 09:02 por R$ 49,90. Ofertas parecidas esperam 24 h.`,
  );
  const sem = { acao: 'barrar', tipo: 'parecido', anterior: { title: AREIA_FINA, preco: null, sent_at: QUANDO_HOJE } };
  assert.equal(
    textoConflito(sem, AGORA),
    `Pulada: parecida com "${AREIA_FINA}", que saiu por este disparo às 09:02 sem preço guardado para comparar. Ofertas parecidas esperam 24 h.`,
  );
  const semMesmo = { acao: 'barrar', tipo: 'mesmo', anterior: { title: AREIA_FINA, preco: null, sent_at: QUANDO_OUTRO_DIA } };
  assert.match(textoConflito(semMesmo, AGORA, { prefixo: 'Não enviada' }), /^Não enviada: o mesmo produto saiu por este disparo às 09:02 de 08\/11 sem preço guardado para comparar, com outro código \(/);
});

test('textoConflito: saindo agora (achado Q1: o "Enviar" do Catálogo no meio de uma execução da regra)', () => {
  const r = { acao: 'barrar', tipo: 'saindo', anterior: { title: AREIA_FINA, preco: null, sent_at: null } };
  assert.equal(textoConflito(r, AGORA, { prefixo: 'Não enviada' }), `Não enviada: parecida com "${AREIA_FINA}", que está saindo agora por este disparo. Tente de novo em alguns minutos.`);
  const longo = 'Areia Sanitária Pipicat Fina 12kg Super Absorvente Controle de Odor Grãos Finos';
  assert.equal(textoConflito({ ...r, anterior: { ...r.anterior, title: longo } }, AGORA, { prefixo: 'Não enviada' }),
    `Não enviada: parecida com "${longo.slice(0, 59).trimEnd()}…", que está saindo agora por este disparo. Tente de novo em alguns minutos.`, 'título cortado em 60');
});

test('textoConflito: mesma rodada', () => {
  const r = { acao: 'barrar', tipo: 'rodada', anterior: { title: AREIA_FINA, preco: null, sent_at: null } };
  assert.equal(textoConflito(r, AGORA), `Pulada: parecida com "${AREIA_FINA}", que foi escolhida neste mesmo envio.`);
  assert.equal(textoConflito(r, AGORA, { prefixo: 'Não enviada' }), `Não enviada: parecida com "${AREIA_FINA}", que foi escolhida neste mesmo envio.`);
});

test('os títulos nas frases são cortados em 60 caracteres e ficam numa linha só', () => {
  const longo = `Areia Higiênica ${'Pipicat '.repeat(20)}`;
  const r = { acao: 'barrar', tipo: 'rodada', anterior: { title: `${longo}\nsegunda linha`, preco: null, sent_at: null } };
  const m = textoConflito(r, AGORA).match(/"(.*)"/s);
  assert.equal(m[1].length, 60);
  assert.ok(m[1].endsWith('…'));
  assert.ok(!m[1].includes('\n'));
  assert.equal(textoConflito({ ...r, anterior: { title: 'x'.repeat(60), preco: null, sent_at: null } }, AGORA).includes(`"${'x'.repeat(60)}"`), true);
  assert.match(textoPassou({ title: longo, preco: 5990, sent_at: QUANDO_HOJE }, 49.9, AGORA), /"[^"]{59}…"/);
});

test('textoPassou: preço anterior, hora e preço novo (CA6)', () => {
  assert.equal(
    textoPassou({ title: AREIA_FINA, preco: 5990, sent_at: QUANDO_HOJE }, 49.9, AGORA),
    `Saiu como oportunidade melhor: o mesmo produto saiu às 09:02 por R$ 59,90 ("${AREIA_FINA}"); agora por R$ 49,90.`,
  );
  assert.match(textoPassou({ title: AREIA_FINA, preco: 5990, sent_at: QUANDO_OUTRO_DIA }, 49.9, AGORA), /o mesmo produto saiu às 09:02 de 08\/11 por R\$ 59,90 \("/);
});

test('textoConferencia: o preço ficou em ... que não é pelo menos 5% menor que o da anterior', () => {
  assert.equal(
    textoConferencia({ title: AREIA_FINA, preco: 4990, sent_at: QUANDO_HOJE }, 52, AGORA),
    `Pulada: na conferência o preço ficou em R$ 52,00, que não é pelo menos 5% menor que o de "${AREIA_FINA}" (R$ 49,90, às 09:02).`,
  );
});

test('textoNaoMaisBarata: o descarte da fila do Catálogo, com o preço anterior em centavos', () => {
  assert.equal(
    textoNaoMaisBarata(52, 4990),
    'Descartada: preço subiu para R$ 52,00 e não está mais pelo menos 5% abaixo do da mesma oferta enviada antes (R$ 49,90)',
  );
});

test('as frases só levam título de produto e preço: sem número, JID nem nome de grupo (CA6)', () => {
  const textos = [
    textoConflito({ tipo: 'mesmo', anterior: { title: AREIA_FINA, preco: 4990, sent_at: QUANDO_HOJE } }, AGORA),
    textoConflito({ tipo: 'parecido', anterior: { title: AREIA_FINA, preco: null, sent_at: QUANDO_HOJE } }, AGORA, { prefixo: 'Não enviada' }),
    textoConflito({ tipo: 'rodada', anterior: { title: AREIA_FINA, preco: null, sent_at: null } }, AGORA),
    textoPassou({ title: AREIA_FINA, preco: 5990, sent_at: QUANDO_HOJE }, 49.9, AGORA),
    textoConferencia({ title: AREIA_FINA, preco: 4990, sent_at: QUANDO_HOJE }, 52, AGORA),
    textoNaoMaisBarata(52, 4990),
  ];
  for (const t of textos) {
    assert.ok(!/@|\d{8,}|undefined|NaN|\[object/.test(t), t);
  }
});
