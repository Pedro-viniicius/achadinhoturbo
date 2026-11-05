// Etapa 4 do plano espelhamento-amazon: parser do texto da origem (CA3), palavras bloqueadas (CA5)
// e máscara de dados pessoais no texto guardado (CA11). Tudo puro: o fetch global nunca é chamado (CA10).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extrairUrls, lerOfertaDoTexto, lerPreco, mesclarOferta, normalizar, palavraBloqueada, temCaraDeLink,
  FIXTURES, FIXTURES_ESPERADO, HOSTS_AMAZON, MAX_URL, MAX_URLS, TITULO_MAX,
} from '../src/oferta-texto.js';
import { mascararPessoais } from '../src/privacidade.js';

const CAMPOS = ['title', 'price', 'oldPrice', 'discountPct', 'sold', 'freeShipping', 'coupon', 'urls'];
const ASIN = 'B0FG2MD49G';
const LINK_LONGO = `https://www.amazon.com.br/dp/${ASIN}`;
const TITULO = 'Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades';

/** Troca o fetch global por um que falha e conta, para provar que nada acessou a rede. */
function semRede(fn) {
  const original = globalThis.fetch; let chamadas = 0;
  globalThis.fetch = async () => { chamadas++; throw new Error('rede proibida no teste'); };
  try { fn(); } finally { globalThis.fetch = original; }
  return chamadas;
}

const semUrls = ({ urls, ...resto }) => resto;

// ---------- fixtures da referência (CA3) ----------

test('oferta-texto: as fixtures cobrem os seis casos da referência e o fetch global não é chamado', () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(), ['compreAquiNaLinha', 'comCupom', 'linkCurto', 'linkLongo', 'semDe', 'soLink'].sort());
  assert.deepEqual(Object.keys(FIXTURES_ESPERADO).sort(), Object.keys(FIXTURES).sort());
  const chamadas = semRede(() => { for (const t of Object.values(FIXTURES)) lerOfertaDoTexto(t); });
  assert.equal(chamadas, 0);
});

test('oferta-texto: fixture com link longo (a mensagem que funcionou) → todos os campos', () => {
  const o = lerOfertaDoTexto(FIXTURES.linkLongo);
  assert.deepEqual(Object.keys(o).sort(), [...CAMPOS].sort());
  assert.deepEqual(semUrls(o), FIXTURES_ESPERADO.linkLongo);
  assert.deepEqual(o.urls, [LINK_LONGO]);
});

test('oferta-texto: fixture com link.amazon → mesmos campos; o link curto é link de produto, não cupom', () => {
  const o = lerOfertaDoTexto(FIXTURES.linkCurto);
  assert.deepEqual(semUrls(o), FIXTURES_ESPERADO.linkCurto);
  assert.deepEqual(o.urls, ['https://link.amazon/2q3Xk9Z']);
  assert.equal(o.coupon, null);
});

test('oferta-texto: fixture sem "De" → oldPrice e discountPct nulos (nunca inventar preço antigo)', () => {
  const o = lerOfertaDoTexto(FIXTURES.semDe);
  assert.deepEqual(semUrls(o), FIXTURES_ESPERADO.semDe);
  assert.equal(o.oldPrice, null);
  assert.equal(o.discountPct, null);
  assert.equal(o.price, 1310.05);
});

test('oferta-texto: fixture "Compre aqui:" na mesma linha de outra informação e link com parâmetros de terceiro', () => {
  const o = lerOfertaDoTexto(FIXTURES.compreAquiNaLinha);
  assert.deepEqual(semUrls(o), FIXTURES_ESPERADO.compreAquiNaLinha);
  assert.equal(o.title, TITULO); // a linha com o link nunca vira título
  assert.equal(o.freeShipping, true); // o "Frete Grátis" da mesma linha continua valendo
  assert.deepEqual(o.urls, [`${LINK_LONGO}?tag=terceiro-20&crid=ABC123&qid=1730000000`]);
});

test('oferta-texto: fixture só com o link → tudo nulo, freeShipping false e a URL extraída', () => {
  const o = lerOfertaDoTexto(FIXTURES.soLink);
  assert.deepEqual(semUrls(o), FIXTURES_ESPERADO.soLink);
  assert.equal(o.title, null);
  assert.equal(o.price, null);
  assert.deepEqual(o.urls, ['https://link.amazon/2q3Xk9Z']);
});

test('oferta-texto: fixture com cupom → coupon DESEJO10 e o link continua sendo link', () => {
  const o = lerOfertaDoTexto(FIXTURES.comCupom);
  assert.deepEqual(semUrls(o), FIXTURES_ESPERADO.comCupom);
  assert.equal(o.coupon, 'DESEJO10');
  assert.deepEqual(o.urls, [LINK_LONGO]);
});

// ---------- cupom: URL nunca vira cupom ----------

test('oferta-texto: URL depois de "cupom" nunca vira cupom (com esquema, sem esquema, outra loja)', () => {
  for (const texto of [
    `${TITULO}\nPor R$ 99,90\nCupom: https://link.amazon/2q3Xk9Z`,
    `${TITULO}\nPor R$ 99,90\ncupom amzn.to/3abc`,
    `${TITULO}\nPor R$ 99,90\nCupom https://www.amazon.com.br/dp/${ASIN}?tag=x-20`,
    `${TITULO}\nPor R$ 99,90\ncupom: https://shopee.com.br/CUPOM10`,
    `${TITULO}\nPor R$ 99,90\ncupom loja.com/ABC123`,
  ]) {
    const o = lerOfertaDoTexto(texto);
    assert.equal(o.coupon, null, texto);
    assert.equal(o.price, 99.9);
  }
});

test('oferta-texto: cupom só com a palavra "cupom" seguida de um código; palavra solta ou código parecido com texto não vale', () => {
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\nUse o cupom: DESEJO10 no carrinho').coupon, 'DESEJO10');
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\ncupom PRIMEIRACOMPRA.').coupon, 'PRIMEIRACOMPRA');
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\ncupom de desconto: ab12cd').coupon, 'AB12CD');
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\nDESEJO10').coupon, null); // sem a palavra "cupom"
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\ncupom de desconto aplicado').coupon, null); // "aplicado" não é código
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\ncupom disponível').coupon, null);
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\ncupom').coupon, null);
  // Q4: palavra de enfeite entre "cupom" e o código; e um "cupom" sem código antes não esconde o seguinte
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\nCupom exclusivo: DESEJO10').coupon, 'DESEJO10');
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\ncupom novo ABC123').coupon, 'ABC123');
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\ncupom extra').coupon, null);
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\ncupom exclusivo https://loja.com/ABC123').coupon, null);
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 50\nCupom abaixo, não perca\nCupom: DESEJO10').coupon, 'DESEJO10');
});

// ---------- preços ----------

test('oferta-texto: "De" só vira oldPrice quando há um preço antigo maior; nunca inventado', () => {
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 199,90').oldPrice, null);
  assert.equal(lerOfertaDoTexto('Fone\nR$ 199,90').oldPrice, null);
  const invertido = lerOfertaDoTexto('Fone\nDe R$ 100,00\nPor R$ 150,00'); // "De" menor que "Por" não é desconto
  assert.equal(invertido.price, 150);
  assert.equal(invertido.oldPrice, null);
  const certo = lerOfertaDoTexto('Fone\nDe R$ 150,00\nPor R$ 100,00');
  assert.deepEqual([certo.oldPrice, certo.price], [150, 100]);
  const soDe = lerOfertaDoTexto('Fone\na partir de R$ 59,90'); // um preço só é o preço atual
  assert.deepEqual([soDe.price, soDe.oldPrice], [59.9, null]);
});

test('oferta-texto: preços no formato brasileiro, riscado do WhatsApp, "por apenas" e parcelas ignoradas', () => {
  assert.equal(lerPreco('1.310,05'), 1310.05);
  assert.equal(lerPreco('1.999'), 1999);
  assert.equal(lerPreco('59,9'), 59.9);
  assert.equal(lerPreco('59.90'), 59.9);
  assert.equal(lerPreco('12345'), 12345);
  assert.equal(lerPreco('abc'), null);
  assert.equal(lerPreco(''), null);
  const o = lerOfertaDoTexto('*Fone JBL*\n~De R$ 1.999,00~\n🔥 Por apenas R$1.310,05\nou em até 10x de R$ 131,00 sem juros');
  assert.equal(o.title, 'Fone JBL');
  assert.equal(o.oldPrice, 1999);
  assert.equal(o.price, 1310.05);
  const dois = lerOfertaDoTexto('Fone\nR$ 80,00 R$ 120,00'); // dois preços sem rótulo: o maior é o antigo
  assert.deepEqual([dois.price, dois.oldPrice], [80, 120]);
  const porESolto = lerOfertaDoTexto('Fone\nR$ 120,00\nPor R$ 80,00');
  assert.deepEqual([porESolto.price, porESolto.oldPrice], [80, 120]);
});

test('oferta-texto: Q1 preço solto maior depois do "Por" (cartão, parcelado, frete) não vira preço antigo', () => {
  for (const texto of ['Fone\nPor R$ 80 à vista ou R$ 90 no cartão', 'Fone\nPor R$ 80\nR$ 90 parcelado em 10x', 'Fone\nPor R$ 80\nFrete R$ 95 para o Norte']) {
    const o = lerOfertaDoTexto(texto);
    assert.deepEqual([o.price, o.oldPrice], [80, null], texto);
  }
  const riscado = lerOfertaDoTexto('Fone\n~R$ 120,00~\nPor R$ 80,00 ou R$ 90 no cartão'); // o solto antes do "Por" continua valendo
  assert.deepEqual([riscado.price, riscado.oldPrice], [80, 120]);
});

// ---------- título, desconto, vendas, frete ----------

test('oferta-texto: título é a primeira linha sem preço, sem link e sem só emoji/markdown; sem *_~; 3–200 caracteres', () => {
  assert.equal(lerOfertaDoTexto(`🔥🔥🔥\n*_${TITULO}_*\nPor R$ 10`).title, TITULO);
  assert.equal(lerOfertaDoTexto(`${LINK_LONGO}\n\nPor R$ 10\n${TITULO} 🔥`).title, TITULO);
  assert.equal(lerOfertaDoTexto('ok\nPor R$ 10').title, null); // 2 caracteres
  assert.equal(lerOfertaDoTexto('Por R$ 10\n34% OFF\n+300 vendidos\nFrete grátis\nCompre aqui:\n' + LINK_LONGO).title, null);
  const longo = 'Produto '.repeat(60).trim();
  const t = lerOfertaDoTexto(`${longo}\nPor R$ 10`).title;
  assert.ok(t.length <= TITULO_MAX && t.length > 190 && !t.endsWith(' ') && longo.startsWith(t));
  assert.equal(lerOfertaDoTexto('').title, null);
  assert.equal(lerOfertaDoTexto(null).title, null);
});

test('oferta-texto (S1): título com trecho com cara de link (domínio sem esquema, @usuario) é descartado; ponto decimal e Amazon.com.br não', () => {
  const comPreco = (titulo) => `${titulo}\nPor R$ 89,90\n${LINK_LONGO}`;
  // o título sai pelo número do dono e o WhatsApp deixaria estes trechos clicáveis: sem título, a oferta vai à fila ou sai curta
  for (const titulo of [
    'Fone Bluetooth bit.ly/promo-fone', 'Entre no grupo chat.whatsapp.com/AbCdEf123', 'Fone Bluetooth exemplo.com.br/fone',
    'Fale comigo wa.me/5531999998888', 'Siga @usuario para mais ofertas', 'Fone BIT.LY/X maiúsculo', 'Promo www.golpe.com',
    'Fone golpe.com.br sem caminho', 'Fone wa.me', 'Contato zap@loja.com.br',
  ]) {
    const o = lerOfertaDoTexto(comPreco(titulo));
    assert.equal(o.title, null, titulo);
    assert.equal(o.price, 89.9, `${titulo}: o resto da oferta continua lido`);
  }
  // ponto decimal, versão, peso e "Amazon.com.br" não são link ("Kit 3un.Cor Preta" passou a ser: S2, rodada 1 de correção)
  for (const titulo of ['Fone Bluetooth v2.0 com Bluetooth 5.3', 'Sabão em pó Omo 1.5kg', 'Echo Dot 5ª geração | Amazon.com.br']) {
    assert.equal(lerOfertaDoTexto(comPreco(titulo)).title, titulo);
  }
  const decimal = lerOfertaDoTexto(`Fone v2.0 Bluetooth\nPor R$ 89.90\n${LINK_LONGO}`);
  assert.deepEqual([decimal.title, decimal.price], ['Fone v2.0 Bluetooth', 89.9]);
  // custo linear com o texto inteiro de uma mensagem (4096) cheio de pontos, hífens e arrobas
  for (const ataque of ['a.'.repeat(2048), 'a-'.repeat(2047) + '.1', `${'a'.repeat(4095)}.`, '@'.repeat(4096), 'ab.cd'.repeat(819)]) {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) lerOfertaDoTexto(ataque);
    assert.ok(performance.now() - t0 < 500, `lento com ${ataque.slice(0, 12)}…`);
  }
});

test('oferta-texto (S2): domínio depois de "...", "+", "%" ou "." e domínio sem "/" com qualquer terminação também derrubam o título', () => {
  const comPreco = (titulo) => `${titulo}\nPor R$ 89,90\n${LINK_LONGO}`;
  const links = ['bit.ly/x', 'wa.me/5531', 'golpe.ru', 'chat.whatsapp.com/AbC'];
  const prefixos = ['', '...', '..', '.', '+', '%', '…', '(', '"', '-', '+%.'];
  for (const link of links) {
    for (const prefixo of prefixos) {
      const titulo = `Fone ${prefixo}${link}`;
      const o = lerOfertaDoTexto(comPreco(titulo));
      assert.equal(o.title, null, titulo);
      assert.equal(o.price, 89.9, `${titulo}: o resto da oferta continua lido`);
    }
    assert.equal(lerOfertaDoTexto(comPreco(`Fone abc..${link}`)).title, null, `abc..${link}`);
  }
  // sem "/", qualquer terminação de 2+ letras é link (não só as de uma lista), em qualquer caixa; menção depois de "..." ou "+"
  for (const titulo of ['Fone golpe.ru', 'Fone golpe.xn', 'Fone GOLPE.RU', 'Fone sub.golpe.casa', 'Fone x.co.uk', 'Kit 3un.Cor Preta',
    'Siga ...@usuario', 'Siga +@usuario', 'Siga %@usuario']) {
    assert.equal(lerOfertaDoTexto(comPreco(titulo)).title, null, titulo);
  }
  // decimal, versão, sigla e medida continuam título
  for (const titulo of ['Controle PS4.0 sem fio', 'Roteador Wi-Fi 6 AX1500', 'Firmware v2.1 atualizado', 'Fone Bluetooth 5.3 TWS',
    'Caixa de som 1.5L', 'Smart TV 4.0 Polegadas 2.4GHz', 'Notebook I5.8GB SSD', 'Fone JBL... Preto', 'Kit S.A. Ltda', 'Placa 3.0 USB-C 3.1',
    'Cafeteira 1.299 Watts', 'Echo Dot | Amazon.com.br', 'Fone de 100% algodão + capa']) {
    assert.equal(lerOfertaDoTexto(comPreco(titulo)).title, titulo, titulo);
  }
  const preco = lerOfertaDoTexto(`Fone v2.1 Bluetooth 5.3\nDe R$ 1.299,90\nPor R$ 899.90\n${LINK_LONGO}`);
  assert.deepEqual([preco.title, preco.price, preco.oldPrice], ['Fone v2.1 Bluetooth 5.3', 899.9, 1299.9]);
  // custo linear com a troca do ponto solto: só tirar o ponto do lookbehind deixaria "a.a.a…" quadrático (32 mil
  // caracteres: ~0,4 s por leitura contra ~1 ms)
  for (const ataque of ['.'.repeat(32768), '.a'.repeat(16384), '..a'.repeat(10923), '+a.'.repeat(10923), 'a.'.repeat(16383) + '1', `%${'a.'.repeat(16383)}`]) {
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) lerOfertaDoTexto(ataque);
    assert.ok(performance.now() - t0 < 500, `lento com ${ataque.slice(0, 12)}…`);
  }
});

test('oferta-texto (Q1): título terminado em "-Link" (TP-Link, D-Link) fica; linha de chamada que perdeu o link continua fora', () => {
  for (const titulo of ['Roteador Wi-Fi TP-Link', 'Switch 8 portas D-Link', 'Adaptador TP-Link: USB']) {
    assert.equal(lerOfertaDoTexto(`${titulo}\nPor R$ 199,00\n${LINK_LONGO}`).title, titulo);
  }
  for (const chamada of ['Compre aqui:', 'Link:', '👉 Clique aqui', 'Garanta já! Compre agora', 'Confira em:', 'Veja']) {
    assert.equal(lerOfertaDoTexto(`${chamada}\nPor R$ 199,00\n${LINK_LONGO}`).title, null, chamada);
  }
});

test('oferta-texto: desconto só com "NN% OFF" (ou "-NN%"), vendas com "mil", frete grátis com ou sem acento', () => {
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 10\n(34% OFF)').discountPct, 34);
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 10\n-15%').discountPct, 15);
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 10\n20% de desconto').discountPct, 20);
  assert.equal(lerOfertaDoTexto('Camiseta 100% algodão\nPor R$ 10').discountPct, null);
  assert.equal(lerOfertaDoTexto('Camiseta 100% algodão\nPor R$ 10').title, 'Camiseta 100% algodão');
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 10\n+2 mil vendidos').sold, 2000);
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 10\nMais de 1.500 compras').sold, 1500);
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 10\n1,5 mil vendas').sold, 1500);
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 10').sold, null);
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 10\nFrete gratis').freeShipping, true);
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 10\nFRETE GRÁTIS para todo o Brasil').freeShipping, true);
  assert.equal(lerOfertaDoTexto('Fone\nPor R$ 10\nFrete R$ 12').freeShipping, false);
});

// ---------- URLs ----------

test('oferta-texto: extrairUrls aceita esquema em qualquer host, hosts da Amazon sem esquema, tira pontuação final, sem repetir, até 5 e ≤ 2048', () => {
  assert.deepEqual(HOSTS_AMAZON, ['link.amazon', 'amzn.to', 'amzn.com', 'a.co', 'amazon.com.br', 'amazon.com']);
  assert.deepEqual(extrairUrls(`veja ${LINK_LONGO}. ou amzn.to/3abc, e (https://shopee.com.br/x) e www.amazon.com.br/dp/${ASIN}?x=1`), [
    LINK_LONGO, 'https://amzn.to/3abc', 'https://shopee.com.br/x', `https://www.amazon.com.br/dp/${ASIN}?x=1`,
  ]);
  assert.deepEqual(extrairUrls(`${LINK_LONGO} ${LINK_LONGO}`), [LINK_LONGO]); // sem repetir
  assert.deepEqual(extrairUrls('amazon.com.br.evil.com/x xamazon.com.br/y email@amazon.com.br/z'), []); // host parecido não vale sem esquema
  assert.deepEqual(extrairUrls('texto sem link, a.co sem caminho'), []);
  const muitas = Array.from({ length: 7 }, (_, i) => `https://amzn.to/${i}`).join(' ');
  assert.equal(extrairUrls(muitas).length, MAX_URLS);
  const enorme = `https://www.amazon.com.br/${'a'.repeat(MAX_URL)}`;
  assert.deepEqual(extrairUrls(`${enorme} ${LINK_LONGO}`), [LINK_LONGO]);
  assert.deepEqual(extrairUrls(''), []);
  assert.deepEqual(extrairUrls(undefined), []);
});

// ---------- palavras bloqueadas (CA5) ----------

test('oferta-texto: normalizar tira acento, caixa e espaços repetidos', () => {
  assert.equal(normalizar('  Usádo   Ótimo '), 'usado otimo');
  assert.equal(normalizar(null), '');
});

test('oferta-texto: palavraBloqueada ignora acento e caixa, casa no início de palavra, lista vazia nunca bloqueia', () => {
  assert.equal(palavraBloqueada('Produto Usádo, funciona', ['usado']), 'usado');
  assert.equal(palavraBloqueada('produto usado', ['USÁDO']), 'USÁDO'); // devolve como está na lista
  assert.equal(palavraBloqueada('Fone usados', ['usado']), 'usado'); // início de palavra: pega "usados"
  assert.equal(palavraBloqueada('Réu acusado', ['usado']), null); // não pega "acusado"
  assert.equal(palavraBloqueada('Fone', []), null);
  assert.equal(palavraBloqueada('Fone usado', []), null);
  assert.equal(palavraBloqueada('Fone usado', undefined), null);
  assert.equal(palavraBloqueada('Fone usado', ['', '  ']), null);
  assert.equal(palavraBloqueada('', ['usado']), null);
  assert.equal(palavraBloqueada(null, ['usado']), null);
  assert.equal(palavraBloqueada(['Fone novo', 'estado: SEMI-NOVO'], ['usado', 'semi-novo']), 'semi-novo'); // vários textos
  assert.equal(palavraBloqueada('Produto Não Original', ['nao original']), 'nao original'); // frase
  assert.equal(palavraBloqueada('c++ (usado)', ['c++']), 'c++'); // caractere de regex não quebra
  assert.equal(palavraBloqueada('Réplica 1:1', ['réplica', 'usado']), 'réplica'); // primeira da lista que casa
});

// ---------- mascararPessoais (CA11) ----------

test('privacidade: mascararPessoais não deixa telefone, JID nem e-mail passar e preserva preço, ASIN e vendas', () => {
  const texto = [
    TITULO, 'De R$ 1.999,00', 'Por R$ 1.310,05', '34% OFF', '+200 compras no mês passado', 'Frete Grátis',
    `Compre aqui: ${LINK_LONGO}`, 'Chama no zap 31 99999-8888 ou +55 (31) 9 9999-8888 ou 5531999998888',
    'ou 553199999888@s.whatsapp.net, 123456789012345@lid, fulano.silva+promo@gmail.com e @5531999998888',
  ].join('\n');
  const m = mascararPessoais(texto);
  for (const proibido of ['99999-8888', '9999-8888', '5531999998888', '553199999888', '123456789012345', 'gmail.com', 'fulano', 's.whatsapp.net']) {
    assert.ok(!m.includes(proibido), `vazou "${proibido}": ${m}`);
  }
  assert.ok(!/\d{8,}/.test(m.replace(/[\s().-]/g, '')), m);
  for (const fica of [TITULO, 'De R$ 1.999,00', 'Por R$ 1.310,05', '34% OFF', '+200 compras', LINK_LONGO, '@lid']) {
    assert.ok(m.includes(fica), `perdeu "${fica}": ${m}`);
  }
  assert.equal(mascararPessoais(''), '');
  assert.equal(mascararPessoais(null), '');
  assert.equal(mascararPessoais('R$ 12.345,67 e 1234567'), 'R$ 12.345,67 e 1234567'); // 7 dígitos ficam
});

test('privacidade (Q4/S5): telefone com " - ", travessão ou hífen que não quebra entre os blocos também é mascarado; custo linear', () => {
  for (const texto of ['Chama no zap 31 - 99999 - 8888', 'Zap 31 99999–8888', 'Zap 31 99999—8888', 'Zap 31 99999‑8888', 'Zap +55 (31) 99999 - 8888', 'Zap (31) 9 9999 – 8888']) {
    const m = mascararPessoais(texto);
    for (const p of ['99999', '9999', '8888']) assert.ok(!m.includes(p), `"${texto}" saiu como "${m}"`);
  }
  // o que não é telefone continua como está
  for (const fica of ['De R$ 1.999,00 Por R$ 1.310,05', '02/11/2026 B0FG2MD49G', 'Itens 1 - 2 - 3 - 4', 'Pack com 3 - 5 unidades']) assert.equal(mascararPessoais(fica), fica);
  for (const ataque of ['1 - '.repeat(1024), '1–'.repeat(2048), '1 2 3 4 5 6 7    '.repeat(240)]) {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) mascararPessoais(ataque);
    assert.ok(performance.now() - t0 < 500, `lento com ${ataque.slice(0, 12)}…`);
  }
});

test('privacidade + oferta-texto: a oferta lida do texto mascarado é a mesma', () => {
  const comZap = `${FIXTURES.comCupom}\nDúvidas: (31) 99999-8888 ou zap@loja.com.br`;
  const mascarado = mascararPessoais(comZap);
  assert.ok(!mascarado.includes('99999') && !mascarado.includes('zap@'));
  assert.deepEqual(semUrls(lerOfertaDoTexto(mascarado)), FIXTURES_ESPERADO.comCupom);
  assert.deepEqual(lerOfertaDoTexto(mascarado).urls, [LINK_LONGO]);
});

test('temCaraDeLink (exportada para o catálogo, S2): domínio sem esquema, mesmo depois de "..." ou "+", e menção', () => {
  for (const v of ['...bit.ly/x', '+bit.ly/x', 'Fone bit.ly/abc', 'veja evil.example', 'http://evil.example', 'fale com @loja', '%bit.ly/x']) assert.equal(temCaraDeLink(v), true, v);
  for (const v of ['Fone Bluetooth JBL', 'Amazon.com.br', 'Cabo 3.5mm 1.5m', 'R$ 1.299,90', 'PROMO10', 'Casa e Decoração', '']) assert.equal(temCaraDeLink(v), false, v);
});

// ---------- mesclarOferta: dados da loja primeiro, o texto completa campo a campo (CA5) ----------

const VAZIA = { title: null, price: null, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: null, image: null };
const DA_LOJA = { title: 'Fone JBL', price: 80, oldPrice: 100, discountPct: 20, sold: 300, freeShipping: false, coupon: null, image: 'https://m.media-amazon.com/images/I/x.jpg' };

test('mesclarOferta: sem loja e sem texto não há oferta nem fonte; os campos têm os mesmos nomes de sempre', () => {
  for (const args of [[null, {}], [null], [undefined, undefined], [null, null]]) {
    assert.deepEqual(mesclarOferta(...args), { oferta: VAZIA, fonte: null });
  }
  assert.deepEqual(Object.keys(mesclarOferta(null, {}).oferta), Object.keys(VAZIA));
});

test('mesclarOferta: só a loja → fonte "api", e o texto não entra', () => {
  const r = mesclarOferta(DA_LOJA, {});
  assert.equal(r.fonte, 'api');
  assert.deepEqual(r.oferta, DA_LOJA);
});

test('mesclarOferta: só o texto → fonte "texto" e a imagem fica nula', () => {
  const doTexto = { title: 'Fone no texto', price: 90, oldPrice: 120, discountPct: 25, sold: 50, freeShipping: true, coupon: 'PROMO10', urls: ['https://x'] };
  const r = mesclarOferta(null, doTexto);
  assert.equal(r.fonte, 'texto');
  assert.deepEqual(r.oferta, { title: 'Fone no texto', price: 90, oldPrice: 120, discountPct: 25, sold: 50, freeShipping: true, coupon: 'PROMO10', image: null });
});

test('mesclarOferta: loja + texto → "api+texto"; a loja vence campo a campo e o texto completa o que falta', () => {
  const daLoja = { ...VAZIA, title: 'Título da loja', price: 80, image: 'https://m.media-amazon.com/images/I/x.jpg' };
  const doTexto = { title: 'Título do texto', price: 70, oldPrice: 100, sold: 40, freeShipping: true, coupon: 'OFF5' };
  const r = mesclarOferta(daLoja, doTexto);
  assert.equal(r.fonte, 'api+texto');
  assert.equal(r.oferta.title, 'Título da loja');
  assert.equal(r.oferta.price, 80);
  assert.equal(r.oferta.oldPrice, 100);
  assert.equal(r.oferta.discountPct, 20); // da conta dos dois preços (80 e 100)
  assert.equal(r.oferta.sold, 40);
  assert.equal(r.oferta.freeShipping, true);
  assert.equal(r.oferta.coupon, 'OFF5');
});

test('mesclarOferta: a loja completa e o texto não acrescenta nada → "api" (texto não conta como fonte)', () => {
  const doTexto = { title: 'Outro', price: 1, oldPrice: 2, discountPct: 50, sold: 1, freeShipping: false, coupon: null };
  const r = mesclarOferta(DA_LOJA, doTexto);
  assert.equal(r.fonte, 'api');
  assert.deepEqual(r.oferta, DA_LOJA);
});

test('mesclarOferta: preço antigo menor ou igual ao atual é descartado, venha de onde vier', () => {
  for (const velho of [80, 79.99, 10]) {
    const daLoja = mesclarOferta({ ...VAZIA, price: 80, oldPrice: velho }, {});
    assert.equal(daLoja.oferta.oldPrice, null, `loja ${velho}`);
    assert.equal(daLoja.oferta.discountPct, null, `loja ${velho}`);
    assert.equal(daLoja.fonte, 'api', `loja ${velho}`);
    const doTexto = mesclarOferta(null, { price: 80, oldPrice: velho });
    assert.equal(doTexto.oferta.oldPrice, null, `texto ${velho}`);
    assert.equal(doTexto.oferta.discountPct, null, `texto ${velho}`);
  }
  // o antigo da loja descartado NÃO cai para o do texto (a loja manda) e não conta como fonte
  const r = mesclarOferta({ ...VAZIA, price: 80, oldPrice: 70 }, { oldPrice: 120 });
  assert.equal(r.oferta.oldPrice, null);
  assert.equal(r.fonte, 'api');
});

test('mesclarOferta: preço antigo sem preço atual é descartado e não conta como fonte', () => {
  const r = mesclarOferta(null, { oldPrice: 100 });
  assert.equal(r.oferta.oldPrice, null);
  assert.equal(r.fonte, null);
  assert.equal(mesclarOferta({ ...VAZIA, oldPrice: 100 }, {}).fonte, null);
});

test('mesclarOferta: preço antigo maior que o atual vale e o desconto sai da conta dos dois', () => {
  const r = mesclarOferta(null, { price: 75, oldPrice: 100 });
  assert.equal(r.oferta.oldPrice, 100);
  assert.equal(r.oferta.discountPct, 25);
  // preço da loja + antigo do texto: a conta usa os dois
  assert.equal(mesclarOferta({ ...VAZIA, price: 50 }, { oldPrice: 100 }).oferta.discountPct, 50);
  // o antigo que ficou na oferta conta como fonte: preço da loja + antigo do texto = os dois
  assert.equal(mesclarOferta({ ...VAZIA, price: 50 }, { oldPrice: 100 }).fonte, 'api+texto');
  assert.equal(mesclarOferta({ ...VAZIA, price: 50, oldPrice: 100 }, { oldPrice: 90 }).fonte, 'api');
});

test('mesclarOferta: o desconto da loja vale; 0 da loja significa "não veio" e cai na conta dos preços', () => {
  assert.equal(mesclarOferta({ ...VAZIA, price: 80, oldPrice: 100, discountPct: 33 }, {}).oferta.discountPct, 33);
  assert.equal(mesclarOferta({ ...VAZIA, price: 80, oldPrice: 100, discountPct: 0 }, {}).oferta.discountPct, 20);
});

test('mesclarOferta: o "NN% OFF" do texto só vale quando o preço também vem do texto', () => {
  // preço do texto (loja sem preço): o percentual do texto vale
  const r1 = mesclarOferta(null, { price: 90, discountPct: 30 });
  assert.equal(r1.oferta.discountPct, 30);
  assert.equal(r1.fonte, 'texto');
  const r2 = mesclarOferta({ ...VAZIA, title: 'Fone' }, { price: 90, discountPct: 30 });
  assert.equal(r2.oferta.discountPct, 30);
  assert.equal(r2.fonte, 'api+texto');
  // preço da loja: o percentual do texto fala de outro preço e é ignorado
  const r3 = mesclarOferta({ ...VAZIA, price: 80 }, { price: 90, discountPct: 30 });
  assert.equal(r3.oferta.price, 80);
  assert.equal(r3.oferta.discountPct, null);
  assert.equal(r3.fonte, 'api');
  // os dois preços conhecidos: a conta dos preços vem antes do percentual do texto
  assert.equal(mesclarOferta(null, { price: 75, oldPrice: 100, discountPct: 30 }).oferta.discountPct, 25);
});

test('mesclarOferta: a imagem vem só da loja, nunca do texto (nem de campo "image" do texto)', () => {
  assert.equal(mesclarOferta(null, { title: 'x', image: 'https://evil.example/a.jpg', urls: ['https://evil.example/b.jpg'] }).oferta.image, null);
  assert.equal(mesclarOferta({ ...VAZIA, title: 'x' }, { image: 'https://evil.example/a.jpg' }).oferta.image, null);
  assert.equal(mesclarOferta(DA_LOJA, { image: 'https://evil.example/a.jpg' }).oferta.image, DA_LOJA.image);
});

test('mesclarOferta: frete grátis é verdadeiro se qualquer lado diz; vazio e zero não viram dado', () => {
  assert.equal(mesclarOferta({ ...VAZIA, title: 'x', freeShipping: true }, {}).oferta.freeShipping, true);
  assert.equal(mesclarOferta({ ...VAZIA, title: 'x', freeShipping: true }, {}).fonte, 'api');
  const r = mesclarOferta({ ...VAZIA, title: 'x' }, { freeShipping: true });
  assert.equal(r.oferta.freeShipping, true);
  assert.equal(r.fonte, 'api+texto');
  assert.equal(mesclarOferta(null, { freeShipping: false }).fonte, null);
  // string vazia da loja não vale: o texto completa
  const v = mesclarOferta({ ...VAZIA, title: '', coupon: '' }, { title: 'Do texto', coupon: 'ABC' });
  assert.equal(v.oferta.title, 'Do texto');
  assert.equal(v.oferta.coupon, 'ABC');
  assert.equal(v.fonte, 'texto');
});

test('mesclarOferta: não muda os objetos recebidos', () => {
  const daLoja = Object.freeze({ ...DA_LOJA });
  const doTexto = Object.freeze({ title: 'a', price: 1, urls: Object.freeze(['https://x']) });
  assert.doesNotThrow(() => mesclarOferta(daLoja, doTexto));
});
