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

const HOST_PERMITIDO = /^([\w-]+\.)*(mercadolivre\.com\.br|mercadolibre\.com|meli\.la)$/i;
export const IMAGEM_PERMITIDA = /^https:\/\/([\w-]+\.)*mlstatic\.com\//i;
export function hostPermitido(url) { try { return HOST_PERMITIDO.test(new URL(url).hostname); } catch { return false; } }

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
    if (!/^https?:\/\//i.test(url) || !hostPermitido(url)) continue; // só links do Mercado Livre
    const key = offerKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const preco = num(price);
    // digitado: o preço veio da linha (escrito à mão), não da loja
    out.push({ key, url, title: title || null, price: preco, oldPrice: num(oldPrice), coupon: coupon || null, ...(preco != null ? { digitado: true } : {}) });
  }
  return out;
}

const ENTIDADES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: '\u00a0' };

/** Decodifica entidades HTML numa passada só (o resultado não é decodificado de novo: "&amp;quot;" vira "&quot;"). */
function decodificarEntidades(texto) {
  return String(texto).replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{2,6}));/gi, (inteiro, dec, hex, nome) => {
    if (nome) return ENTIDADES[nome.toLowerCase()] ?? inteiro;
    const cod = dec != null ? Number(dec) : parseInt(hex, 16);
    return cod > 0 && cod <= 0x10ffff && !(cod >= 0xd800 && cod <= 0xdfff) ? String.fromCodePoint(cod) : inteiro;
  });
}

/** Conteúdo de <meta property="og:..."> (o tag tem no máximo 2000 caracteres, para a busca ser linear). */
function metaOg(html, nome) {
  for (const m of String(html).matchAll(/<meta\b[^>]{0,2000}>/gi)) {
    const tag = m[0];
    const prop = tag.match(/\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if ((prop?.[1] ?? prop?.[2])?.toLowerCase() !== nome) continue;
    const cont = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (cont) return decodificarEntidades(cont[1] ?? cont[2]);
  }
  return null;
}

/** Valor da etiqueta de preço da vitrine: "725", "1.299,90" (formato brasileiro). Outro formato vira null. */
function precoBr(texto) {
  const t = String(texto).trim();
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(t)) return null;
  const n = Number(t.replaceAll('.', '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Trecho do JSON embutido que pertence só ao cartão em destaque ("card-featured"). Os outros produtos da vitrine ficam
 * no mesmo JSON, depois dele: o trecho termina no próximo "id":"card-…" ou no segundo "polycards" (começo da lista
 * de produtos do cartão seguinte), o que vier primeiro. Sem o cartão, null.
 */
function trechoDoCartaoDestaque(html) {
  const ini = html.search(/"id"\s*:\s*"card-featured"/);
  if (ini < 0) return null;
  const a = html.slice(ini, ini + 60000);
  const fins = [];
  const outro = a.slice(10).search(/"id"\s*:\s*"card-/);
  if (outro >= 0) fins.push(outro + 10);
  const p1 = a.search(/"polycards"/);
  if (p1 >= 0) {
    const p2 = a.slice(p1 + 10).search(/"polycards"/);
    if (p2 >= 0) fins.push(p1 + 10 + p2);
  }
  return a.slice(0, fins.length ? Math.min(...fins) : a.length);
}

/** Preço atual e preço antigo do componente de preço do cartão em destaque (só o primeiro componente do trecho). */
function precosDoTrecho(trecho) {
  const p1 = trecho.search(/"id"\s*:\s*"price"/);
  if (p1 < 0) return null;
  const resto = trecho.slice(p1 + 1);
  const p2 = resto.search(/"id"\s*:\s*"price"/);
  const bloco = p2 < 0 ? resto.slice(0, 6000) : resto.slice(0, p2);
  const valor = (chave) => {
    const v = bloco.match(new RegExp(`"${chave}"\\s*:\\s*\\{[^{}]{0,200}?"value"\\s*:\\s*(\\d+(?:\\.\\d+)?)`));
    return v ? Number(v[1]) : null;
  };
  const atual = valor('current_price');
  return atual > 0 ? { price: atual, oldPrice: valor('previous_price') } : null;
}

/**
 * Endereço do produto em destaque (metadata.url, sem esquema e sem parâmetros): https + host do Mercado Livre,
 * sem query nem fragmento, e um endereço de produto (anúncio MLB-… ou catálogo /p/MLB…). Encurtador (meli.la),
 * vitrine social (/social/…) ou qualquer outra coisa vira null.
 */
function urlDoTrecho(trecho) {
  const m = trecho.match(/"metadata"\s*:\s*\{[^{}]{0,2000}?"url"\s*:\s*"((?:[^"\\]|\\.){1,2000})"/);
  if (!m) return null;
  let bruto;
  try { bruto = JSON.parse(`"${m[1]}"`); } catch { return null; }
  if (typeof bruto !== 'string') return null;
  try {
    const u = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(bruto) ? bruto : `https://${bruto}`);
    if (u.protocol !== 'https:' || u.search || u.hash || u.username || u.password || !hostPermitido(u.href)) return null;
    if (/(?:^|\.)meli\.la$/i.test(u.hostname) || /\/social\//i.test(u.pathname)) return null;
    if (!extractItemId(u.pathname) && !isCatalogUrl(u.pathname)) return null;
    return u.origin + u.pathname;
  } catch { return null; }
}

/**
 * Página social do afiliado (/social/mp…, para onde o meli.la redireciona): sem JSON-LD. O título e o preço
 * vêm do og:title ("<título> - R$ <preço>"), a imagem do og:image e, se houver, o preço antigo e o endereço do
 * produto do cartão em destaque. O preço do cartão só vale se bater com o do og:title (diferença menor que R$ 1);
 * se não bater, fica o do og:title e sem preço antigo.
 */
function parseSocialHtml(html) {
  const og = metaOg(html, 'og:title');
  if (!og) return null;
  const texto = og.replaceAll('\u00a0', ' ');
  const corte = texto.lastIndexOf(' - R$');
  if (corte < 0) return null;
  const title = texto.slice(0, corte).trim();
  const price = precoBr(texto.slice(corte + 5));
  if (!title || !price) return null;
  const trecho = trechoDoCartaoDestaque(html);
  const cartao = trecho ? precosDoTrecho(trecho) : null;
  const confere = cartao && Math.abs(cartao.price - price) < 1;
  const url = trecho && confere ? urlDoTrecho(trecho) : null;
  const imagem = metaOg(html, 'og:image');
  return {
    title,
    price: confere ? cartao.price : price,
    oldPrice: confere && cartao.oldPrice && cartao.oldPrice > cartao.price ? cartao.oldPrice : null,
    image: IMAGEM_PERMITIDA.test(imagem || '') ? imagem : null, // imagem só do CDN do Mercado Livre
    ...(url ? { url } : {}),
  };
}

/**
 * Conteúdo de cada `<script type="application/ld+json">…</script>` da página, na ordem. Varredura linear (sem regex
 * com `[\s\S]*?` sobre a página toda, que é quadrática com milhares de `<script ` sem fechamento): a tag de abertura
 * tem de caber em MAX_TAG_LD caracteres e não tem `<` nem `>` dentro; se não há `</script>` depois, não há mais bloco.
 * No máximo MAX_BLOCOS_LD blocos (uma página real tem poucos; milhares de blocos vazios só gastariam JSON.parse).
 */
const MAX_TAG_LD = 512;
const MAX_BLOCOS_LD = 50;
function* blocosJsonLd(html) {
  const abre = new RegExp(`<script[^<>]{0,${MAX_TAG_LD}}>`, 'gi');
  const tipo = /^<script[^>]+type=["']application\/ld\+json["'][^>]*>$/i;
  const fecha = /<\/script>/gi;
  let pos = 0;
  for (let n = 0; n < MAX_BLOCOS_LD;) {
    abre.lastIndex = pos;
    const tag = abre.exec(html);
    if (!tag) return;
    pos = tag.index + tag[0].length;
    if (!tipo.test(tag[0])) continue;
    fecha.lastIndex = pos;
    const fim = fecha.exec(html);
    if (!fim) return;
    yield html.slice(pos, fim.index);
    n++;
    pos = fim.index + fim[0].length;
  }
}

/** O primeiro nó schema.org Product de cada bloco JSON-LD da página, na ordem (bloco que não é JSON é pulado). */
function* produtosJsonLd(html) {
  for (const bloco of blocosJsonLd(html)) {
    let data; try { data = JSON.parse(bloco); } catch { continue; }
    const nodes = [].concat(data, data?.['@graph'] || []).flat();
    const prod = nodes.find((n) => n && [].concat(n['@type']).includes('Product'));
    if (prod) yield prod;
  }
}

/** Primeira oferta (schema.org Offer) do produto, ou {}. */
function ofertaDoProduto(prod) {
  const off = [].concat(prod.offers || [])[0];
  return off && typeof off === 'object' ? off : {};
}

// schema.org ItemAvailability: só estes valores contam. Esgotado só com sinal explícito; qualquer outro valor
// (PreOrder, BackOrder, texto livre…) fica sem resposta (null), nunca vira "esgotado".
const ESGOTADO_LD = new Set(['outofstock', 'soldout', 'discontinued']);
const DISPONIVEL_LD = new Set(['instock', 'limitedavailability', 'onlineonly']);

/** `offers.availability` do JSON-LD → true (à venda), false (esgotado) ou null (ausente ou fora da lista). */
function disponivelJsonLd(valor) {
  if (typeof valor !== 'string') return null;
  const m = valor.trim().match(/^(?:https?:\/\/(?:www\.)?schema\.org\/)?([a-z]{1,40})$/i);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (ESGOTADO_LD.has(v)) return false;
  return DISPONIVEL_LD.has(v) ? true : null;
}

/**
 * Uma passada só pela página: o produto (JSON-LD, ou a página social do afiliado) e o estoque informado.
 * → { produto: { title, price, oldPrice, image, disponivel? } | null, disponivel: true|false|null }
 * `produto.disponivel` (true/false) só vem quando a oferta do produto lido informa `availability` (ver
 * disponivelJsonLd); a página social não informa estoque. `disponivel` do resultado é o do produto ou, sem ele, o
 * primeiro JSON-LD da página que responder (anúncio esgotado costuma vir sem preço).
 */
function lerHtmlProduto(html) {
  html = String(html ?? '');
  let produto = null; let disponivel = null; // `disponivel`: o primeiro availability válido da página, de qualquer produto
  for (const prod of produtosJsonLd(html)) {
    const off = ofertaDoProduto(prod);
    const daOferta = disponivelJsonLd(off.availability);
    if (disponivel == null) disponivel = daOferta;
    if (!produto) {
      const price = num(off.price ?? off.lowPrice);
      if (prod.name && price) {
        const img = [].concat(prod.image || [])[0];
        const old = num((html.match(/"original_price"\s*:\s*([\d.]+)/) || [])[1]);
        const imagem = typeof img === 'string' ? img : img?.url || null;
        produto = {
          title: prod.name, price,
          oldPrice: old && old > price ? old : null,
          image: IMAGEM_PERMITIDA.test(imagem || '') ? imagem : null, // imagem só do CDN do Mercado Livre
          ...(daOferta != null ? { disponivel: daOferta } : {}),
        };
      }
    }
    if (produto && (produto.disponivel != null || disponivel != null)) break; // já tem o que precisa: não lê mais blocos
  }
  if (produto) return { produto, disponivel: produto.disponivel ?? disponivel };
  return { produto: parseSocialHtml(html), disponivel };
}

/**
 * Lê o JSON-LD (schema.org Product) que as páginas de produto costumam trazer; sem ele, tenta a página social do afiliado.
 * Com JSON-LD, `disponivel` (true/false) só vem quando a oferta informa `availability` (ver disponivelJsonLd); a página
 * social não informa estoque.
 */
export function parseProductHtml(html) {
  return lerHtmlProduto(html).produto;
}

/** Maior página de produto lida (a social tem ~1 MB): acima disso, a leitura é cortada e dá erro. */
export const MAX_PAGINA = 2 * 1024 * 1024;

/** Corpo da resposta como texto, com teto de MAX_PAGINA bytes (pelo content-length e contando o que chega). */
async function lerPagina(r) {
  const declarado = r.headers?.get?.('content-length');
  const grande = () => new Error('página grande demais');
  if (declarado != null && declarado !== '' && !(Number(declarado) <= MAX_PAGINA)) {
    try { await r.body?.cancel?.(); } catch { /* já fechado */ }
    throw grande();
  }
  const leitor = r.body?.getReader?.();
  if (!leitor) return typeof r.text === 'function' ? String(await r.text()).slice(0, MAX_PAGINA) : '';
  const partes = []; let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value?.byteLength ?? 0;
    if (total > MAX_PAGINA) {
      try { await leitor.cancel(); } catch { /* já fechado */ }
      throw grande();
    }
    partes.push(value);
  }
  return Buffer.concat(partes).toString('utf8');
}

// API pública: sem redirecionamento (quem responde por ela não manda a gente para outro lugar) e com o mesmo teto de
// bytes das páginas
async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(await lerPagina(r));
}

/**
 * Endereço de página do Mercado Livre que dá para pedir: http vira https (a Lista de links aceita os dois; o Mercado
 * Livre redireciona de qualquer jeito), e só vale https sem porta e sem usuário/senha. Outro → null.
 */
function enderecoSeguro(url) {
  let u;
  try { u = new URL(String(url ?? '')); } catch { return null; }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return null;
  return hostPermitido(u.href) ? u.href : null;
}

/**
 * Estoque do anúncio pela API: false com sinal explícito (`available_quantity` 0 ou `status` diferente de "active",
 * como paused e closed), true se "active", null sem `status`.
 */
function disponivelDaApi(it) {
  if (it.available_quantity === 0) return false;
  if (typeof it.status !== 'string') return null;
  return it.status === 'active';
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
    disponivel: disponivelDaApi(it),
  };
}

/** A oferta sem `disponivel`: o estoque é só do verificador (conferirProduto); resolveOffer e a busca seguem como antes. */
function semDisponivel(o) {
  const { disponivel: _estoque, ...resto } = o;
  return resto;
}

/** Texto de uma página do Mercado Livre: segue no máximo 3 redirecionamentos, e só para hosts do Mercado Livre. */
async function getPagina(u) {
  for (let salto = 0; salto < 4; salto++) {
    u = enderecoSeguro(u); // cada salto: https, sem porta, do Mercado Livre
    if (!u) throw new Error('endereço fora do Mercado Livre');
    const r = await fetch(u, { headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u).toString(); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return lerPagina(r);
  }
  throw new Error('redirecionamentos demais');
}

/** Completa os dados de um candidato da lista (API pública -> HTML da página). */
export async function resolveOffer(cand, { fetchJson = getJson, fetchText } = {}) {
  const getText = fetchText || getPagina;
  // já veio completo (busca) ou com dados digitados à mão
  if (cand.title && cand.price) {
    return { sold: 0, freeShipping: false, image: null, ...cand, discountPct: discountPct(cand.price, cand.oldPrice) };
  }
  let data = null; let why = ''; let urlProduto = null;
  const id = extractItemId(cand.url);
  if (id && !isCatalogUrl(cand.url)) {
    try { data = semDisponivel(fromApiItem(await fetchJson(`https://api.mercadolibre.com/items/${id}`))); } catch (e) { why = `API ${e.message}`; }
  }
  if (!data) {
    try {
      const p = parseProductHtml(await getText(cand.url));
      if (p) { const { url: urlDaPagina, ...resto } = semDisponivel(p); data = { sold: 0, freeShipping: false, ...resto }; urlProduto = urlDaPagina || null; }
      else why = (why ? why + '; ' : '') + 'página sem dados de produto';
    } catch (e) { why = (why ? why + '; ' : '') + `página ${e.message}`; }
  }
  if (!data) {
    throw new Error(`não consegui ler o produto (${why}). Escreva na lista: URL | título | preço | preço antigo`);
  }
  const merged = {
    // a página social do afiliado informa o produto de verdade: é dele o link que vai para a Central (o meli.la colado pode ser de outro afiliado)
    ...data, key: cand.key, url: urlProduto || cand.url,
    title: cand.title || data.title, price: cand.price ?? data.price,
    oldPrice: cand.oldPrice ?? data.oldPrice, coupon: cand.coupon || null,
    ...(cand.digitado ? { digitado: true } : {}), // preço da lista de links, escrito à mão
  };
  merged.discountPct = discountPct(merged.price, merged.oldPrice);
  return merged;
}

/**
 * Preço e estoque de agora, para o verificador (logo antes do envio). Ao contrário do resolveOffer, sempre lê a loja
 * (não há atalho para dados já conhecidos): API do anúncio e, sem preço nela, a página (JSON-LD ou social).
 * O endereço tem de ser http(s) do Mercado Livre (hostPermitido), conferido antes de qualquer leitura; a página só
 * segue redirecionamentos para o Mercado Livre e tem o teto MAX_PAGINA.
 *
 * Devolve { price, disponivel }: `price` > 0 ou null (a leitura não trouxe preço); `disponivel` false só com sinal
 * explícito da loja (API: available_quantity 0 ou status ≠ active; JSON-LD: OutOfStock, SoldOut, Discontinued),
 * true se a loja diz que está à venda, null se não diz. Lança se o endereço não for do Mercado Livre ou se a página
 * não puder ser lida (a mensagem nunca traz o endereço nem o conteúdo da loja).
 */
export async function conferirProduto(url, { fetchJson = getJson, fetchText = getPagina } = {}) {
  const alvo = enderecoSeguro(url);
  if (!alvo) throw new Error('endereço fora do Mercado Livre');
  const precoValido = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  let daApi = null;
  const id = extractItemId(alvo);
  if (id && !isCatalogUrl(alvo)) {
    try { daApi = fromApiItem(await fetchJson(`https://api.mercadolibre.com/items/${id}`)); } catch { daApi = null; }
    // esgotado pela API, ou preço lido: não precisa da página
    if (daApi && (daApi.disponivel === false || precoValido(daApi.price))) return { price: precoValido(daApi.price), disponivel: daApi.disponivel };
  }
  const html = await fetchText(alvo);
  const { produto: p, disponivel: daPagina } = lerHtmlProduto(html);
  return { price: precoValido(p?.price), disponivel: daPagina ?? daApi?.disponivel ?? null };
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
    const o = semDisponivel(fromApiItem(it));
    return { ...o, discountPct: discountPct(o.price, o.oldPrice) };
  });
}

/**
 * Candidatos de uma fonte ({ type, config }), sem baixar detalhes ainda.
 * A fonte "catalogo" (API de ofertas do Etiqueta) delega a deps.catalogo.candidatos (src/catalogo.js) com
 * { rule, fonteIndex, quer, tratada, utilizavel, vistas, paginas, onWarn, previa }, que vêm de candidates() e do
 * agendador. Sem deps.catalogo (servidor sem o cliente do Etiqueta), a fonte falha como indisponível.
 */
export async function candidatesFor({ type, config }, deps = {}) {
  const cfg = config || {};
  if (type === 'catalogo') {
    if (typeof deps.catalogo?.candidatos !== 'function') throw new Error('Catálogo do Etiqueta indisponível neste servidor.');
    return deps.catalogo.candidatos(cfg, {
      rule: deps.rule, fonteIndex: deps.fonteIndex, quer: deps.quer, tratada: deps.tratada, utilizavel: deps.utilizavel,
      vistas: deps.vistas, paginas: deps.paginas, onWarn: deps.onWarn, previa: deps.previa === true,
    });
  }
  if (type === 'afiliados') {
    if (!deps.links) throw new Error('serviço de links indisponível');
    let pages;
    try { pages = await deps.links.requestOffers({ paginas: hubBodies(cfg) }); } catch (e) {
      throw new Error(`a Central de Afiliados não devolveu a lista (${e.message})`);
    }
    return parseHubPages(pages, hubCategorias(cfg).length);
  }
  if (type === 'search') {
    if (!cfg.query) throw new Error('a busca está sem a palavra-chave');
    return searchOffers({ query: cfg.query, sort: cfg.sort || 'relevance', limit: cfg.limit || 50 }, deps);
  }
  return parseListLines(cfg.items);
}

export const NOME_FONTE = { afiliados: 'Central de Afiliados', list: 'lista de links', search: 'busca', catalogo: 'Catálogo do Etiqueta' };

/**
 * Candidatos de uma regra. Com várias fontes (até 5), busca cada uma e intercala (1ª da fonte A,
 * 1ª da B, 2ª da A, …), sem repetir. Uma fonte que falha vira aviso (deps.onWarn) e as outras seguem;
 * só dá erro se todas falharem. As chaves de cada fonte vão para `vistas` (deps.vistas ou um Set novo) antes
 * da próxima: o catálogo conta a chave que outra fonte já trouxe como tratada. Na pré-visualização
 * (deps.previa), a falha da fonte catálogo não vira aviso.
 */
export async function candidates(rule, deps = {}) {
  const fontes = rule.sources?.length ? rule.sources : [{ type: rule.source_type, config: rule.source_config }];
  // cada candidato carrega a fonte de origem e a etiqueta dela (se tiver uma própria)
  const marcar = (lista, i, f) => lista.map((c) => ({ ...c, source_index: i, tag_id: f.tag_id ?? null }));
  const vistas = deps.vistas instanceof Set ? deps.vistas : new Set();
  // a fonte recebe a regra e a posição dela (o catálogo guarda o que leu por fonte, para o cursor)
  const depsDa = (i) => ({ ...deps, rule, fonteIndex: i, vistas });
  const buscar = async (f, i) => {
    const lista = marcar(await candidatesFor(f, depsDa(i)), i, f);
    for (const c of lista) if (c?.key != null) vistas.add(c.key);
    return lista;
  };
  if (fontes.length === 1) return buscar(fontes[0], 0);
  const filas = []; const erros = [];
  for (const [i, f] of fontes.entries()) {
    try { filas.push(await buscar(f, i)); } catch (e) {
      // a pré-visualização não escreve aviso do catálogo (só entra no erro se todas as fontes falharem)
      erros.push({ texto: `fonte ${i + 1} (${NOME_FONTE[f.type] || f.type}): ${e.message}`, avisar: !(deps.previa && f.type === 'catalogo') });
    }
  }
  if (!filas.length) throw new Error(erros.map((e) => e.texto).join('; '));
  for (const e of erros) if (e.avisar) deps.onWarn?.(`Fonte ignorada neste envio: ${e.texto}`);
  const out = []; const seen = new Set();
  for (let i = 0; filas.some((f) => i < f.length); i++) {
    for (const f of filas) { const c = f[i]; if (c && !seen.has(c.key)) { seen.add(c.key); out.push(c); } }
  }
  return out;
}

export function rejectReason(o, rule) {
  if (rule.min_price != null && o.price < rule.min_price) return `preço abaixo de ${rule.min_price}`;
  if (rule.max_price != null && o.price > rule.max_price) return `preço acima de ${rule.max_price}`;
  if (rule.min_discount != null && (o.discountPct || 0) < rule.min_discount) return `desconto abaixo de ${rule.min_discount}%`;
  return null;
}
