// Lê a oferta escrita no texto de uma mensagem de origem (espelhamento da Amazon, sem API).
// Caminho principal quando a Creators API não responde; com a API, serve de fallback campo a campo.
//
// Regras do dono (docs/produto/referencias/espelhamento-amazon.md):
// - título = primeira linha sem preço, sem link e que não seja só emoji/markdown; se essa linha tem um trecho com
//   cara de link (domínio sem "https://", como "bit.ly/x" ou "golpe.ru", ou "@usuario"), não há título: o título
//   sai pelo número do dono e o WhatsApp transformaria o trecho em link clicável;
// - "De R$ x" só vira preço antigo quando existe no texto: nenhuma linha "De" é inventada;
// - "Por R$ y" é o preço; "NN% OFF" o desconto; "+200 compras" as vendas; "Frete Grátis" o frete;
// - cupom só com a palavra "cupom" seguida de um código, nunca uma URL;
// - toda URL de loja na mensagem é link de produto, nunca cupom.
//
// Puro: sem rede, sem banco. Preços no formato brasileiro (R$ 1.310,05).

export const MAX_URL = 2048;
export const MAX_URLS = 5;
export const TITULO_MIN = 3;
export const TITULO_MAX = 200;

/** Hosts da Amazon reconhecidos mesmo sem "https://" (ex.: `amzn.to/abc`). */
export const HOSTS_AMAZON = ['link.amazon', 'amzn.to', 'amzn.com', 'a.co', 'amazon.com.br', 'amazon.com'];

const FIM_URL = /[^\s<>"'`]+/.source;
const RE_URL_ESQUEMA = new RegExp(`https?://${FIM_URL}`, 'gi');
const RE_URL_AMAZON = new RegExp(`(?<![\\w@./-])(?:www\\.)?(?:${HOSTS_AMAZON.map((h) => h.replace(/\./g, '\\.')).join('|')})/${FIM_URL}`, 'gi');
const PONTUACAO_FINAL = /[.,;:!?)\]}>*_~]+$/;

// Preço brasileiro: "R$ 1.310,05", "R$1310,05", "R$ 59", "R$ 59.90" (ponto como decimal, só com 2 casas).
const PRECO = /R\$\s?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/.source;
const RE_PRECO = new RegExp(PRECO, 'gi'); // só com matchAll: regex global guarda lastIndex no .test()
const RE_TEM_PRECO = new RegExp(PRECO, 'i');
const RE_ROTULO_DE = /\bde\s*:?\s*~?\s*$/i; // "De R$", "de: R$", "~De R$" (riscado)
const RE_ROTULO_POR = /\bpor\s*:?\s*(?:apenas|s[óo]|somente)?\s*$/i;
const RE_PARCELA = /\d+\s*x\s*(?:de\s*)?$/i; // "3x de R$ 33,33" não é preço antigo
const RE_DESCONTO = /(?:(\d{1,3})\s*%\s*(?:off|de\s+desconto|desconto|dto)|-\s*(\d{1,3})\s*%)/i;
const RE_VENDAS = /\+?\s*(\d+(?:[.,]\d+)?)\s*(mil)?\s*(?:compras?|vendid[oa]s?|vendas?|comprad[oa]s?)\b/i;
const RE_FRETE = /frete\s+gr[áa]tis/i;
// o código termina em fim de palavra e não continua como domínio ("loja.com"): URL nunca é cupom
// entre "cupom" e o código podem vir palavras de enfeite ("Cupom exclusivo: DESEJO10", "cupom de desconto: X1")
const ENFEITE_CUPOM = /(?:de\s+desconto|desconto|exclusivo|novos?|extra|limitado|ativo|aplicado|v[áa]lido|dispon[íi]vel|gr[áa]tis)(?![A-Za-z0-9])\s*:?\s*/.source;
const RE_CUPOM = new RegExp(`\\bcupom\\s*:?\\s*(?:${ENFEITE_CUPOM})*["'“”]?([A-Za-z0-9-]{3,20})(?!\\w)(?!\\.\\w)`, 'i');
const RE_CUPOM_TODOS = new RegExp(RE_CUPOM.source, 'gi'); // só com matchAll: regex global guarda lastIndex no .test()
const CUPOM_NAO = new Set(['DESCONTO', 'EXTRA', 'NOVO', 'NOVOS', 'GRATIS', 'ATIVO', 'VALIDO', 'DISPONIVEL', 'APLICADO', 'EXCLUSIVO', 'LIMITADO', 'PARA', 'COM', 'USE', 'USAR', 'APLIQUE', 'APLICAR']);
const RE_SO_SIMBOLOS = /^[^\p{L}\p{N}]*$/u;
// Domínio sem esquema: rótulos separados por ponto, o último só de letras (2+), com ou sem "/" depois ("bit.ly/x",
// "golpe.ru"). Número decimal e versão ("R$ 89.90", "v2.0", "Bluetooth 5.3") não têm terminação de letras; palavras
// grudadas por ponto ("3un.Cor") contam como link: o WhatsApp não distingue, e o título sai pelo número do dono.
// Cada rótulo não tem ponto e o grupo termina em ponto: um jeito só de casar. O ponto no lookbehind impede começar
// no meio de "a.b.c" (custo linear); por isso o ponto que não vem logo depois de letra, dígito ou hífen ("...bit.ly",
// ".bit.ly") é trocado por espaço antes (RE_PONTO_SOLTO), e "+bit.ly", "%bit.ly" não protegem mais o domínio.
const RE_DOMINIO = /(?<![\p{L}\p{N}._-])(?:[\p{L}\p{N}-]+\.)+(\p{L}{2,})(?![\p{L}\p{N}-])(\/)?/gu;
const RE_MENCAO = /(?<![\p{L}\p{N}._-])@[\p{L}\p{N}_]/u;
const RE_PONTO_SOLTO = /(?<![\p{L}\p{N}-])\./gu;
// "Compre aqui:", "Link:", "Clique aqui" que ficaram sem o link; a palavra não pode vir grudada por hífen ("TP-Link")
const RE_CHAMADA_SEM_LINK = /(?<![\p{L}\p{N}-])(?:compre|comprar|confira|clique|acesse|link|veja)(?![\p{L}\p{N}])\s*(?:aqui|agora|já|em)?\s*:?\s*$/iu;
const HOSTS_AMAZON_SET = new Set(HOSTS_AMAZON);
const RE_APARAR = /^[^\p{L}\p{N}("'“]+|[^\p{L}\p{N})"'”!?.%]+$/gu;

/** Remove acentos e caixa: "Usádo" -> "usado". */
export function normalizar(s) {
  return String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** "1.310,05" -> 1310.05; "59.90" -> 59.9; "1.999" -> 1999. Null quando não é número. */
export function lerPreco(s) {
  let t = String(s ?? '').replace(/\s/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (!/^\d+\.\d{1,2}$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * URLs da mensagem: com esquema (qualquer host) e, para os hosts da Amazon, sem esquema.
 * Cada uma com ≤ MAX_URL caracteres, sem repetição, no máximo MAX_URLS. Toda URL é link, nunca cupom.
 */
export function extrairUrls(texto) {
  const t = String(texto ?? '');
  const achadas = [];
  for (const m of t.matchAll(RE_URL_ESQUEMA)) achadas.push({ i: m.index, url: m[0] });
  for (const m of t.matchAll(RE_URL_AMAZON)) achadas.push({ i: m.index, url: `https://${m[0]}` });
  achadas.sort((a, b) => a.i - b.i);
  const out = [];
  for (const { url } of achadas) {
    const u = url.replace(PONTUACAO_FINAL, '');
    if (u.length > MAX_URL || out.includes(u)) continue;
    out.push(u);
    if (out.length >= MAX_URLS) break;
  }
  return out;
}

/** Texto sem as URLs (com ou sem esquema) e sem markdown do WhatsApp, para ler os campos. */
function semUrlsNemMarkdown(texto) {
  return String(texto ?? '').replace(RE_URL_ESQUEMA, ' ').replace(RE_URL_AMAZON, ' ').replace(/[*_~]/g, '');
}

function lerPrecos(texto) {
  const lista = [];
  for (const m of texto.matchAll(RE_PRECO)) {
    const valor = lerPreco(m[1]);
    if (valor == null) continue;
    const antes = texto.slice(Math.max(0, m.index - 24), m.index);
    let rotulo = null;
    if (RE_PARCELA.test(antes)) rotulo = 'parcela';
    else if (RE_ROTULO_DE.test(antes)) rotulo = 'de';
    else if (RE_ROTULO_POR.test(antes)) rotulo = 'por';
    lista.push({ valor, rotulo, pos: m.index });
  }
  return lista;
}

/**
 * A linha tem trecho que o WhatsApp mostraria como link ou menção? Domínio sem esquema (qualquer terminação de 2+
 * letras, com ou sem "/") ou "@usuario", mesmo depois de "...", "+" ou "%". O nome de um host da Amazon sozinho
 * ("Amazon.com.br") não conta.
 */
export function temCaraDeLink(linha) {
  const t = linha.replace(RE_PONTO_SOLTO, ' ');
  if (RE_MENCAO.test(t)) return true;
  for (const m of t.matchAll(RE_DOMINIO)) {
    const host = m[0].replace(/\/$/, '').toLowerCase().replace(/^www\./, '');
    if (!m[2] && HOSTS_AMAZON_SET.has(host)) continue;
    return true;
  }
  return false;
}

function lerTitulo(texto) {
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.replace(/\s+/g, ' ').trim();
    if (!linha || RE_SO_SIMBOLOS.test(linha)) continue;
    if (RE_TEM_PRECO.test(linha) || RE_DESCONTO.test(linha) || RE_VENDAS.test(linha) || RE_FRETE.test(linha) || RE_CUPOM.test(linha)) continue;
    if (RE_CHAMADA_SEM_LINK.test(linha)) continue;
    const t = linha.replace(RE_APARAR, '').trim();
    if (t.length < TITULO_MIN) continue;
    if (temCaraDeLink(linha)) return null; // nada de link pelo número do dono: sem título, a oferta vai à fila ou sai curta
    return t.length > TITULO_MAX ? t.slice(0, TITULO_MAX).replace(/\s+\S*$/, '').trim() : t;
  }
  return null;
}

function lerDesconto(texto) {
  const m = RE_DESCONTO.exec(texto);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  return n >= 1 && n <= 99 ? n : null;
}

function lerVendas(texto) {
  const m = RE_VENDAS.exec(texto);
  if (!m) return null;
  let n = Number(m[1].includes(',') ? m[1].replace(/\./g, '').replace(',', '.') : m[1].replace(/\./g, ''));
  if (m[2]) n *= 1000;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Código do cupom: só depois da palavra "cupom", com dígito ou todo em maiúsculas, nunca uma URL. O primeiro que vale. */
function lerCupom(texto) {
  for (const m of texto.matchAll(RE_CUPOM_TODOS)) {
    const codigo = m[1];
    const maiusculo = /^[A-Z0-9-]+$/.test(codigo);
    if (!maiusculo && !/\d/.test(codigo)) continue;
    const up = codigo.toUpperCase();
    if (CUPOM_NAO.has(up) || /^-|-$/.test(up)) continue;
    return up;
  }
  return null;
}

/**
 * Oferta lida do texto. Campos ausentes são null (freeShipping é false quando o texto não diz "frete grátis").
 * `oldPrice` só quando o texto traz um preço maior que o atual; `discountPct` só com "NN% OFF" explícito
 * (o template calcula o resto). `urls` = extrairUrls(texto).
 */
export function lerOfertaDoTexto(texto) {
  const urls = extrairUrls(texto);
  const limpo = semUrlsNemMarkdown(texto);
  const precos = lerPrecos(limpo).filter((p) => p.rotulo !== 'parcela');

  let price = precos.find((p) => p.rotulo === 'por')?.valor ?? null;
  let oldPrice = precos.find((p) => p.rotulo === 'de')?.valor ?? null;
  const soltos = precos.filter((p) => p.rotulo === null).map((p) => p.valor);
  const posPor = precos.find((p) => p.rotulo === 'por')?.pos;
  if (precos.length === 1) {
    price = precos[0].valor; oldPrice = null; // um preço só é o preço atual, mesmo com "a partir de R$"
  } else if (price == null && oldPrice == null) {
    if (soltos.length === 1) price = soltos[0];
    else if (soltos.length >= 2) { price = Math.min(...soltos); oldPrice = Math.max(...soltos); }
  } else if (price == null) {
    price = soltos.length ? Math.min(...soltos) : null;
  } else if (oldPrice == null) {
    // preço solto só é o antigo quando vem ANTES do "Por" (riscado, em seta); depois dele é outra coisa
    // ("ou R$ 90 no cartão", "Frete R$ 95"): "De" só com preço antigo explícito
    const antes = precos.filter((p) => p.rotulo === null && p.pos < posPor).map((p) => p.valor);
    if (antes.length) oldPrice = Math.max(...antes);
  }
  if (oldPrice != null && (price == null || oldPrice <= price)) oldPrice = null;

  return {
    title: lerTitulo(limpo),
    price,
    oldPrice,
    discountPct: lerDesconto(limpo),
    sold: lerVendas(limpo),
    freeShipping: RE_FRETE.test(limpo),
    coupon: lerCupom(limpo),
    urls,
  };
}

function escaparRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Primeira palavra da lista encontrada nos textos, sem distinguir maiúsculas, minúsculas nem acento,
 * casando no início de palavra ("usado" pega "Usádos", não "acusado"). Devolve a palavra como está na
 * lista ou null. Lista vazia nunca bloqueia.
 */
export function palavraBloqueada(textos, lista) {
  if (!Array.isArray(lista) || !lista.length) return null;
  const alvo = (Array.isArray(textos) ? textos : [textos]).map(normalizar).filter(Boolean).join('\n');
  if (!alvo) return null;
  for (const palavra of lista) {
    const p = normalizar(palavra);
    if (!p) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${p.split(' ').map(escaparRegex).join('\\s+')}`, 'u');
    if (re.test(alvo)) return String(palavra).trim();
  }
  return null;
}

const ASIN_EXEMPLO = 'B0FG2MD49G';
const TITULO_EXEMPLO = 'Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades';
const MENSAGEM_COMPLETA = [TITULO_EXEMPLO, 'De R$ 1.999,00', 'Por R$ 1.310,05', '34% OFF', '+200 compras no mês passado', 'Frete Grátis'];

/**
 * Mensagens de exemplo da referência do dono: fixtures dos testes e do `npm run simular`.
 * - linkLongo: a mensagem que funcionou, literal;
 * - linkCurto: a mesma com `link.amazon` no lugar do link longo;
 * - semDe: sem preço antigo (não se inventa "De");
 * - compreAquiNaLinha: "Compre aqui: <link>" dividindo a linha com outra informação e com parâmetros de terceiro;
 * - soLink: só o link (sem título nem preço: vai para a fila ou sai no formato curto);
 * - comCupom: com a linha "Cupom DESEJO10".
 */
export const FIXTURES = Object.freeze({
  linkLongo: [...MENSAGEM_COMPLETA, `Compre aqui: https://www.amazon.com.br/dp/${ASIN_EXEMPLO}`].join('\n'),
  linkCurto: [...MENSAGEM_COMPLETA, 'Compre aqui: https://link.amazon/2q3Xk9Z'].join('\n'),
  semDe: [TITULO_EXEMPLO, 'Por R$ 1.310,05', '+200 compras no mês passado', 'Frete Grátis', `Compre aqui: https://www.amazon.com.br/dp/${ASIN_EXEMPLO}`].join('\n'),
  compreAquiNaLinha: [...MENSAGEM_COMPLETA.slice(0, -1), `Frete Grátis. Compre aqui: https://www.amazon.com.br/dp/${ASIN_EXEMPLO}?tag=terceiro-20&crid=ABC123&qid=1730000000`].join('\n'),
  soLink: 'https://link.amazon/2q3Xk9Z',
  comCupom: [...MENSAGEM_COMPLETA, 'Cupom DESEJO10', `Compre aqui: https://www.amazon.com.br/dp/${ASIN_EXEMPLO}`].join('\n'),
});

/** O que cada fixture deve render (sem `urls`): documentação viva do contrato. */
export const FIXTURES_ESPERADO = Object.freeze({
  linkLongo: { title: TITULO_EXEMPLO, price: 1310.05, oldPrice: 1999, discountPct: 34, sold: 200, freeShipping: true, coupon: null },
  linkCurto: { title: TITULO_EXEMPLO, price: 1310.05, oldPrice: 1999, discountPct: 34, sold: 200, freeShipping: true, coupon: null },
  semDe: { title: TITULO_EXEMPLO, price: 1310.05, oldPrice: null, discountPct: null, sold: 200, freeShipping: true, coupon: null },
  compreAquiNaLinha: { title: TITULO_EXEMPLO, price: 1310.05, oldPrice: 1999, discountPct: 34, sold: 200, freeShipping: true, coupon: null },
  soLink: { title: null, price: null, oldPrice: null, discountPct: null, sold: null, freeShipping: false, coupon: null },
  comCupom: { title: TITULO_EXEMPLO, price: 1310.05, oldPrice: 1999, discountPct: 34, sold: 200, freeShipping: true, coupon: 'DESEJO10' },
});
