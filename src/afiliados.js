// Fonte "Ofertas da Central de Afiliados": a mesma lista "Produtos selecionados para você"
// que aparece em mercadolivre.com.br/afiliados/hub. Quem busca é a extensão do Chrome, de dentro
// da aba do Mercado Livre (com a sua sessão); aqui só montamos o pedido e lemos a resposta.

import { discountPct } from './template.js';

export const POR_PAGINA = 18; // a Central devolve 18 produtos por página

export const ORDENS = [
  { id: 'relevance', name: 'Mais relevantes' },
  { id: 'lowest_price', name: 'Menor preço' },
  { id: 'highest_price', name: 'Maior preço' },
];

// Categorias que o filtro da Central oferecia em 02/11/2026.
export const CATEGORIAS = [
  ['MLB1574', 'Casa, Móveis e Decoração'], ['MLB5726', 'Eletrodomésticos'], ['MLB1246', 'Beleza e Cuidado Pessoal'],
  ['MLB1430', 'Calçados, Roupas e Bolsas'], ['MLB1051', 'Celulares e Telefones'], ['MLB1000', 'Eletrônicos, Áudio e Vídeo'],
  ['MLB1648', 'Informática'], ['MLB1144', 'Games'], ['MLB1276', 'Esportes e Fitness'], ['MLB264586', 'Saúde'],
  ['MLB1384', 'Bebês'], ['MLB1132', 'Brinquedos e Hobbies'], ['MLB1071', 'Pet Shop'], ['MLB1403', 'Alimentos e Bebidas'],
  ['MLB263532', 'Ferramentas'], ['MLB1500', 'Construção'], ['MLB5672', 'Acessórios para Veículos'],
  ['MLB3937', 'Joias e Relógios'], ['MLB1039', 'Câmeras e Acessórios'], ['MLB1182', 'Instrumentos Musicais'],
  ['MLB12404', 'Festas e Lembrancinhas'], ['MLB1499', 'Indústria e Comércio'], ['MLB271599', 'Agro'],
].map(([id, name]) => ({ id, name }));

/** Configuração da regra -> corpos dos pedidos à Central, um por página. */
export function hubBodies(cfg = {}) {
  const filters = [];
  if (cfg.categoria) filters.push({ id: 'category', value: String(cfg.categoria) });
  if (cfg.mais_vendidos) filters.push({ id: 'best_seller', value: true });
  if (cfg.ganhos_extras) filters.push({ id: 'extra_commission', value: true });
  const sort = ORDENS.some((o) => o.id === cfg.ordem) ? cfg.ordem : 'relevance';
  const paginas = Math.min(Math.max(Number(cfg.paginas) || 3, 1), 10);
  return Array.from({ length: paginas }, (_, i) => ({
    search: String(cfg.busca || '').trim(), sort, filters, offset: i * POR_PAGINA,
  }));
}

/** "| +10mil vendidos" -> 10000; "+500 vendidos" -> 500. */
export function parseVendidos(text) {
  const m = String(text || '').match(/\+?\s*([\d.,]+)\s*(mil|mi)?\s*vendid/i);
  if (!m) return 0;
  const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * (m[2]?.toLowerCase() === 'mil' ? 1000 : m[2] ? 1e6 : 1));
}

/** Texto de um componente com {marcadores} preenchidos pelos rótulos que vêm junto. */
function textoComValores(t, values = []) {
  const map = Object.fromEntries((values || []).map((v) => [v.key, v.label?.text ?? '']));
  return String(t || '').replace(/\{(\w+)\}/g, (_, k) => map[k] ?? '').replace(/\s+/g, ' ').trim();
}

/** Um card ("polycard") da Central -> oferta no formato do programa. */
export function cardToOffer(card, ctx = {}) {
  const meta = card?.metadata || {};
  const comps = Object.fromEntries((card?.components || []).map((c) => [c.id || c.type, c]));
  const title = comps.title?.title?.text;
  const price = Number(comps.price?.price?.current_price?.value);
  if (!title || !meta.url || !Number.isFinite(price) || price <= 0) return null;
  const prev = Number(comps.price?.price?.previous_price?.value);
  const oldPrice = Number.isFinite(prev) && prev > price ? prev : null;
  const prefix = ctx.url_prefix || 'https://';
  const url = /^https?:\/\//i.test(meta.url) ? meta.url : prefix + String(meta.url).replace(/^\/+/, '');
  const pic = card.pictures?.pictures?.[0]?.id;
  const rc = comps.review_compacted?.review_compacted;
  const pill = comps.affiliates_commission_chip?.chip?.pill;
  return {
    key: meta.id || meta.product_id || url,
    url, title, price, oldPrice,
    discountPct: discountPct(price, oldPrice),
    sold: parseVendidos(rc ? textoComValores(rc.text, rc.values) : ''),
    freeShipping: false,
    image: pic ? `https://http2.mlstatic.com/D_NQ_NP_2X_${pic}-F.jpg` : null,
    comissao: pill ? textoComValores(pill.text, pill.values) : null,
    ganhosExtras: String(meta.extra_commission) === 'true',
    destaque: comps.highlight?.highlight?.text || null,
  };
}

/** Páginas devolvidas pela extensão -> lista de ofertas, sem repetir. */
export function parseHubPages(pages) {
  const out = []; const seen = new Set();
  for (const p of [].concat(pages || [])) {
    const model = p?.polycard_client_model || p || {};
    const ctx = model.polycard_context || {};
    for (const card of model.polycards || []) {
      const o = cardToOffer(card, ctx);
      if (!o || seen.has(o.key)) continue;
      seen.add(o.key); out.push(o);
    }
  }
  return out;
}

/** Resposta de exemplo no mesmo formato da Central (modo simulação e testes). */
export function amostraHub() {
  const card = (id, title, cur, prev, vendidos, extra = false) => ({
    metadata: { id, product_id: id.replace(/^MLB/, 'MLBP'), url: `www.mercadolivre.com.br/produto-exemplo/p/${id}`, extra_commission: String(extra), type: 'product' },
    pictures: { pictures: [{ id: `000000-${id}_112026` }] },
    components: [
      { id: 'title', type: 'title', title: { text: title } },
      { id: 'review_compacted', type: 'review_compacted', review_compacted: { text: '{icon_star_fill} {label} {label2}', values: [{ key: 'icon_star_fill', type: 'icon' }, { key: 'label', type: 'label', label: { text: '4.8' } }, { key: 'label2', type: 'label', label: { text: `| +${vendidos} vendidos` } }] } },
      { id: 'affiliates_commission_chip', type: 'chip', chip: { pill: { text: extra ? '{ganancia} {extra}' : 'GANHOS 12%', values: extra ? [{ key: 'ganancia', label: { text: 'GANHOS EXTRAS' } }, { key: 'extra', label: { text: '16%' } }] : [] } } },
      { id: 'price', type: 'price', price: { current_price: { value: cur }, ...(prev ? { previous_price: { value: prev } } : {}) } },
    ],
  });
  return [{
    polycard_client_model: {
      polycard_context: { url_prefix: 'https://' },
      polycards: [
        card('MLB9000001', 'Kit 10 Potes Herméticos de Vidro', 69.9, 159.9, '50mil'),
        card('MLB9000002', 'Organizador de Gaveta Dobrável', 29.9, 49.9, '10mil', true),
        card('MLB9000003', 'Air Fryer 4L Antiaderente', 299.9, 499.9, '100mil'),
        card('MLB9000004', 'Garrafa Térmica Inox 1L', 59.9, null, '5mil'),
        card('MLB9000005', 'Jogo de Toalhas 4 Peças', 89.9, 129.9, '500'),
      ],
    },
  }];
}
