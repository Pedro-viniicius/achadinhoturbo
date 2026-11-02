// Fontes de ofertas do Mercado Livre.
//
// ATENÇÃO: este arquivo fala com o site/API do Mercado Livre, que muda sem aviso e às vezes
// bloqueia acesso sem login. Por isso a fonte "Lista de links" aceita título e preço escritos
// à mão (URL | título | preço | preço antigo | cupom): assim o envio funciona mesmo se a
// leitura automática do produto falhar.

import { discountPct } from './template.js';
import { hubBodies, hubCategorias, parseHubPages } from './afiliados.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export function extractItemId(url) {
  const m = String(url).match(/MLB-?(\d{6,})/i);
  return m ? `MLB${m[1]}` : null;
}

/** Páginas /p/MLB123 são de catálogo (o número não é de um anúncio). */
export function isCatalogUrl(url) {
  return /\/p\/MLB\d+/i.test(String(url));
}

/** Chave estável para não repetir oferta: id do anúncio ou a URL sem parâmetros. */
export function offerKey(url) {
  const id = extractItemId(url);
  if (id) return id;
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return String(url).trim(); }
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Linhas no formato:  URL | título | preço | preço antigo | cupom  (tudo depois da URL é opcional). */
export function parseListLines(text) {
  const out = []; const seen = new Set();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [url, title, price, oldPrice, coupon] = line.split('|').map((s) => s.trim());
    if (!/^https?:\/\//i.test(url)) continue;
    const key = offerKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, url, title: title || null, price: num(price), oldPrice: num(oldPrice), coupon: coupon || null });
  }
  return out;
}

/** Lê o JSON-LD (schema.org Product) que as páginas de produto costumam trazer. */
export function parseProductHtml(html) {
  const blocks = [...String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data; try { data = JSON.parse(b[1]); } catch { continue; }
    const nodes = [].concat(data, data?.['@graph'] || []).flat();
    const prod = nodes.find((n) => n && [].concat(n['@type']).includes('Product'));
    if (!prod) continue;
    const off = [].concat(prod.offers || [])[0] || {};
    const price = num(off.price ?? off.lowPrice);
    if (!prod.name || !price) continue;
    const img = [].concat(prod.image || [])[0];
    const old = num((String(html).match(/"original_price"\s*:\s*([\d.]+)/) || [])[1]);
    return {
      title: prod.name, price,
      oldPrice: old && old > price ? old : null,
      image: typeof img === 'string' ? img : img?.url || null,
    };
  }
  return null;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function fromApiItem(it) {
  const price = Number(it.price);
  const oldPrice = it.original_price ? Number(it.original_price) : null;
  return {
    key: it.id, url: it.permalink, title: it.title, price,
    oldPrice: oldPrice && oldPrice > price ? oldPrice : null,
    sold: it.sold_quantity || 0,
    freeShipping: !!it.shipping?.free_shipping,
    image: (it.pictures?.[0]?.secure_url) || (it.thumbnail || '').replace('http://', 'https://').replace(/-I\.jpg$/, '-O.jpg') || null,
  };
}

/** Completa os dados de um candidato da lista (API pública -> HTML da página). */
export async function resolveOffer(cand, { fetchJson = getJson, fetchText } = {}) {
  const getText = fetchText || (async (u) => {
    const r = await fetch(u, { headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
  // já veio completo (busca) ou com dados digitados à mão
  if (cand.title && cand.price) {
    return { sold: 0, freeShipping: false, image: null, ...cand, discountPct: discountPct(cand.price, cand.oldPrice) };
  }
  let data = null; let why = '';
  const id = extractItemId(cand.url);
  if (id && !isCatalogUrl(cand.url)) {
    try { data = fromApiItem(await fetchJson(`https://api.mercadolibre.com/items/${id}`)); } catch (e) { why = `API ${e.message}`; }
  }
  if (!data) {
    try {
      const p = parseProductHtml(await getText(cand.url));
      if (p) data = { sold: 0, freeShipping: false, ...p };
      else why = (why ? why + '; ' : '') + 'página sem dados de produto';
    } catch (e) { why = (why ? why + '; ' : '') + `página ${e.message}`; }
  }
  if (!data) {
    throw new Error(`não consegui ler o produto (${why}). Escreva na lista: URL | título | preço | preço antigo`);
  }
  const merged = {
    ...data, key: cand.key, url: cand.url,
    title: cand.title || data.title, price: cand.price ?? data.price,
    oldPrice: cand.oldPrice ?? data.oldPrice, coupon: cand.coupon || null,
  };
  merged.discountPct = discountPct(merged.price, merged.oldPrice);
  return merged;
}

/** Busca na API pública do Mercado Livre (experimental: pode exigir login/token). */
export async function searchOffers({ query, sort = 'relevance', limit = 50 }, { fetchJson = getJson } = {}) {
  const u = new URL('https://api.mercadolibre.com/sites/MLB/search');
  u.searchParams.set('q', query); u.searchParams.set('limit', String(Math.min(limit, 50)));
  if (sort !== 'relevance') u.searchParams.set('sort', sort);
  let j;
  try { j = await fetchJson(u.toString()); } catch (e) {
    throw new Error(`a busca do Mercado Livre recusou o acesso (${e.message}). Use a fonte "Lista de links" por enquanto.`);
  }
  return (j.results || []).map((it) => {
    const o = fromApiItem(it);
    return { ...o, discountPct: discountPct(o.price, o.oldPrice) };
  });
}

/** Candidatos de uma regra, sem baixar detalhes ainda. */
export async function candidates(rule, deps = {}) {
  const cfg = rule.source_config || {};
  if (rule.source_type === 'afiliados') {
    if (!deps.links) throw new Error('serviço de links indisponível');
    let pages;
    try { pages = await deps.links.requestOffers({ paginas: hubBodies(cfg) }); } catch (e) {
      throw new Error(`a Central de Afiliados não devolveu a lista (${e.message})`);
    }
    return parseHubPages(pages, hubCategorias(cfg).length);
  }
  if (rule.source_type === 'search') {
    if (!cfg.query) throw new Error('a regra de busca está sem a palavra-chave');
    return searchOffers({ query: cfg.query, sort: cfg.sort || 'relevance', limit: cfg.limit || 50 }, deps);
  }
  return parseListLines(cfg.items);
}

export function rejectReason(o, rule) {
  if (rule.min_price != null && o.price < rule.min_price) return `preço abaixo de ${rule.min_price}`;
  if (rule.max_price != null && o.price > rule.max_price) return `preço acima de ${rule.max_price}`;
  if (rule.min_discount != null && (o.discountPct || 0) < rule.min_discount) return `desconto abaixo de ${rule.min_discount}%`;
  return null;
}
