// Monta o texto da mensagem a partir do template e da oferta.
// Linha cujo campo ficou vazio (ex.: sem cupom) é removida inteira.

export const PLACEHOLDERS = [
  'TITULO_PRODUTO', 'PRECO_ANTIGO', 'PRECO_PRODUTO', 'DESCONTO_PRODUTO',
  'NUMERO_VENDAS', 'FRETE', 'CUPOM', 'LINK',
];

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

export function offerValues(o) {
  const pct = o.discountPct ?? discountPct(o.price, o.oldPrice);
  return {
    TITULO_PRODUTO: String(o.title || '').replace(/[*_~]/g, '').trim(),
    PRECO_ANTIGO: o.oldPrice && o.oldPrice > o.price ? brl(o.oldPrice) : '',
    PRECO_PRODUTO: brl(o.price),
    DESCONTO_PRODUTO: pct > 0 ? `${pct}%` : '',
    NUMERO_VENDAS: vendas(o.sold),
    FRETE: o.freeShipping ? 'Frete grátis' : '',
    CUPOM: o.coupon || '',
    LINK: o.link || '',
  };
}

export function renderTemplate(body, offer) {
  const vals = offerValues(offer);
  const out = [];
  for (const line of String(body).split('\n')) {
    const keys = [...line.matchAll(/\{([A-Z_]+)\}/g)].map((m) => m[1]);
    if (keys.some((k) => PLACEHOLDERS.includes(k) && !vals[k])) continue;
    out.push(line.replace(/\{([A-Z_]+)\}/g, (m, k) => (k in vals ? vals[k] : m)));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const SAMPLE_OFFER = {
  title: 'Fone de Ouvido Bluetooth TWS com Cancelamento de Ruído',
  price: 89.9, oldPrice: 149.9, sold: 2300, freeShipping: true,
  coupon: '', link: 'https://meli.la/2AbCdEf',
};
