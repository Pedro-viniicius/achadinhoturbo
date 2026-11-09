// Monta o texto da mensagem a partir do template e da oferta.
// Linha cujo campo ficou vazio (ex.: sem cupom) é removida inteira.
// Pedaço entre colchetes com placeholder, ex. `[ ({DESCONTO_PRODUTO} OFF)]`, some sozinho
// quando algum placeholder dele está vazio; a linha continua. Colchete sem placeholder fica como está.

import { abreviarTitulo, TITULO_MAX_PADRAO } from './titulo.js';

export const PLACEHOLDERS = [
  'TITULO_PRODUTO', 'TITULO_COMPLETO', 'PRECO_ANTIGO', 'PRECO_PRODUTO', 'DESCONTO_PRODUTO',
  'NUMERO_VENDAS', 'FRETE', 'CUPOM', 'LINK', 'HORA_PRECO',
];

const RE_PLACEHOLDER = /\{([A-Z_]+)\}/g;
// Pedaço opcional: `[` … `]` sem outro colchete dentro (não há aninhamento). `[` ou `]` soltos não casam.
const RE_OPCIONAL = /\[([^[\]]*)\]/;

export function brl(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(Number(n)).replace(/\u00a0/g, ' ');
}

export function discountPct(price, oldPrice) {
  if (!price || !oldPrice || oldPrice <= price) return 0;
  return Math.round((1 - price / oldPrice) * 100);
}

function vendas(n) {
  n = Number(n) || 0;
  if (n <= 0) return '';
  if (n >= 1000) return `+${Math.floor(n / 1000)} mil vendidos`;
  return `+${n} vendidos`;
}

/** Hora local de um instante (ms) como "14h32"; vazio quando não há instante válido. */
function horaCurta(ts) {
  if (ts == null || ts === '' || !Number.isFinite(Number(ts))) return '';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const dois = (n) => String(n).padStart(2, '0');
  return `${dois(d.getHours())}h${dois(d.getMinutes())}`;
}

/** opts.tituloMax: tamanho máximo de {TITULO_PRODUTO} (0 = inteiro). {TITULO_COMPLETO} é sempre o nome inteiro. */
export function offerValues(o, opts = {}) {
  const pct = o.discountPct ?? discountPct(o.price, o.oldPrice);
  const completo = String(o.title || '').replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim();
  return {
    TITULO_PRODUTO: abreviarTitulo(completo, opts.tituloMax ?? TITULO_MAX_PADRAO),
    TITULO_COMPLETO: completo,
    PRECO_ANTIGO: o.oldPrice && o.oldPrice > o.price ? brl(o.oldPrice) : '',
    PRECO_PRODUTO: brl(o.price),
    DESCONTO_PRODUTO: pct > 0 ? `${pct}%` : '',
    NUMERO_VENDAS: vendas(o.sold),
    FRETE: o.freeShipping ? 'Frete grátis' : '',
    CUPOM: o.coupon || '',
    LINK: o.link || '',
    // Hora em que o verificador leu o preço na loja (`vistoEm`); vazio quando não houve conferência.
    HORA_PRECO: horaCurta(o.vistoEm),
  };
}

/** Placeholders conhecidos presentes no trecho. */
function chavesConhecidas(trecho) {
  return [...trecho.matchAll(RE_PLACEHOLDER)].map((m) => m[1]).filter((k) => PLACEHOLDERS.includes(k));
}

function algumVazio(chaves, vals) {
  return chaves.some((k) => !vals[k]);
}

function substituir(trecho, vals) {
  return trecho.replace(RE_PLACEHOLDER, (m, k) => (k in vals ? vals[k] : m));
}

/**
 * Renderiza uma linha; devolve null quando ela deve sumir: placeholder vazio fora de colchete, ou linha com pedaço
 * opcional que, sem os pedaços vazios, ficou só com espaços (ex.: `[🎟️ Cupom: {CUPOM}]` sem cupom).
 */
function renderizarLinha(linha, vals) {
  // split com grupo de captura alterna: fora, dentro, fora, dentro, …, fora
  const partes = linha.split(RE_OPCIONAL);
  const fora = partes.filter((_, i) => i % 2 === 0).join('');
  if (algumVazio(chavesConhecidas(fora), vals)) return null;
  const resultado = partes.map((parte, i) => {
    if (i % 2 === 0) return substituir(parte, vals);
    const chaves = chavesConhecidas(parte);
    if (!chaves.length) return `[${substituir(parte, vals)}]`; // colchete sem placeholder fica intacto
    return algumVazio(chaves, vals) ? '' : substituir(parte, vals);
  }).join('');
  // linha em branco do próprio template (sem pedaço opcional) continua: ela separa blocos
  if (partes.length > 1 && !resultado.trim()) return null;
  return resultado;
}

/**
 * O {HORA_PRECO} deste template derrubaria o {LINK}? Sem conferência de preço o {HORA_PRECO} fica vazio: fora de `[ ]`
 * a linha inteira some, e dentro de um `[ ]` some o trecho. Se o {LINK} está na mesma linha (fora do trecho, no caso
 * da hora fora de `[ ]`; no mesmo trecho, no da hora dentro), a mensagem sairia sem o link de afiliado.
 */
export function horaPrecoDerrubaOLink(body) {
  const TEM = (t, k) => t.includes(`{${k}}`);
  return String(body ?? '').split('\n').some((linha) => {
    if (!TEM(linha, 'HORA_PRECO') || !TEM(linha, 'LINK')) return false;
    const partes = linha.split(RE_OPCIONAL); // fora, dentro, fora, …
    if (partes.some((t, i) => i % 2 === 0 && TEM(t, 'HORA_PRECO'))) return true;
    return partes.some((t, i) => i % 2 === 1 && TEM(t, 'HORA_PRECO') && TEM(t, 'LINK'));
  });
}

export function renderTemplate(body, offer, opts = {}) {
  const vals = offerValues(offer, opts);
  const out = [];
  for (const line of String(body).split('\n')) {
    const rendered = renderizarLinha(line, vals);
    if (rendered !== null) out.push(rendered);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Template "Amazon" do brief, na sintaxe `[ … ]`: sem desconto, só o pedaço "(NN% OFF)" some. */
export const TEMPLATE_AMAZON = [
  '*{TITULO_PRODUTO}*',
  '',
  '😱 De ~{PRECO_ANTIGO}~',
  '🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]',
  '🚚 {FRETE}',
  '🎟️ Cupom: *{CUPOM}*',
  '',
  '🛒 Compre aqui: {LINK}',
].join('\n');

// Instante de conferência das amostras: 14h32 na hora local (a prévia mostra "14h32" em qualquer fuso).
const VISTO_EM_AMOSTRA = new Date(2026, 0, 15, 14, 32, 0).getTime();

export const SAMPLE_OFFER = {
  title: 'Fone de Ouvido Bluetooth TWS com Cancelamento de Ruído',
  price: 89.9, oldPrice: 149.9, sold: 2300, freeShipping: true,
  coupon: '', link: 'https://meli.la/2AbCdEf', vistoEm: VISTO_EM_AMOSTRA,
};

/** Oferta de exemplo da Amazon (produto da referência de 02/11) para a prévia do template. */
export const SAMPLE_OFFER_AMAZON = {
  key: 'ASIN:B0FG2MD49G', asin: 'B0FG2MD49G',
  title: 'Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades',
  price: 1310.05, oldPrice: 1999, discountPct: 34, sold: 200, freeShipping: true,
  coupon: 'DESEJO10', link: 'https://www.amazon.com.br/dp/B0FG2MD49G', vistoEm: VISTO_EM_AMOSTRA,
};
