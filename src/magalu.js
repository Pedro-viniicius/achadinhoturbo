// Tudo o que é da Magalu (plano integracao-magalu, etapa 1; ADR-008). Sem API, sem leitura de página, sem raspar HTML.
//
// O Parceiro Magalu não tem API de links nem de produto, e a página do produto é bloqueada para o servidor. O link de
// afiliado é a página do produto dentro da loja do parceiro (magazinevoce.com.br/<loja>/…): ele é montado aqui, sem
// rede, a partir do endereço do produto, e nunca repassa o link colado (como a Amazon, ADR-002).
//
// Contrato do módulo (a ligação com lojas.js é da etapa 2; com envios.js, da etapa 3):
//
// - extrairProdutoMagalu(url) → { codigo, urlProduto, sellerId, lojaDoLink } | null. Sem rede.
//   - magazineluiza.com.br (ou subdomínio): caminho [<slug>/]p/<codigo>/[<cat>/[<sub>/]].
//   - magazinevoce.com.br (ou subdomínio): o 1º segmento é a loja de um parceiro (RE_LOJA_MAGALU) e o resto é igual.
//   - Segmentos em lista branca: slug [a-z0-9-]{1,200}, código [a-z0-9]{6,20}, categoria [a-z0-9-]{1,60}. Letras
//     maiúsculas do caminho do produto viram minúsculas (a loja do parceiro fica como veio). `..`, `%`, `\`, barra
//     dupla, porta, credenciais, mais de 2048 caracteres ou fora de http/https → null.
//   - urlProduto: o endereço canônico https://www.magazineluiza.com.br/[<slug>/]p/<codigo>/[<cat>/[<sub>/]], com
//     ?seller_id=<x> só se o link trazia um seller_id válido (^[A-Za-z0-9_-]{1,60}$: escolhe o vendedor da página, não
//     é rastreio; P4 do plano). Todo o resto da query e o fragmento caem (utm, loja de outro parceiro, rastreio).
//   - lojaDoLink: a loja de parceiro do link colado (só magazinevoce), para quem chama saber que era de outro parceiro.
//     Nunca vai para o link montado, para o payload nem para log.
// - montarLinkMagalu(urlProduto, loja) → https://www.magazinevoce.com.br/<loja>/[<slug>/]p/<codigo>/[<cat>/[<sub>/]]
//   [?seller_id=<x>], sempre casando LINK_MAGALU. Sem rede. `urlProduto` pode ser qualquer endereço de produto da
//   Magalu (magazineluiza ou magazinevoce de qualquer loja): o caminho é refeito por extrairProdutoMagalu e a loja é
//   sempre a dada. Loja fora de RE_LOJA_MAGALU → ErroMagalu('sem_loja'); endereço que não é de produto →
//   LinkMagaluNaoResolvido('invalido').
// - createMagalu({ fetch, cache = new Map(), agora = Date.now }) → { resolver(url) }
//   - resolver(url) → o mesmo objeto de extrairProdutoMagalu. Link de produto volta sem rede. Link que é de
//     magazineluiza/magazinevoce mas não é de produto (início, busca, vitrine) → 'nao_produto' sem rede. A página do
//     produto nunca é pedida; um Location (do link curto) para uma página da Magalu sem produto (busca, vitrine) é
//     pedido por GET sem ler o corpo e vira 'nao_produto'. O resto (link curto: magazineluiza.onelink.me,
//     maga.lu, magalu.com e subdomínios) passa por resolverPorRedirecionamento de src/rede.js só com HOSTS_MAGALU, sem
//     host de salto: o valor sai do Location, sem pedir o destino. Falha → LinkMagaluNaoResolvido { causa }.
//
// Segurança: as mensagens de erro são frases fixas (nunca o link, a loja ou a URL); o módulo não escreve no console.

import { resolverPorRedirecionamento, FalhaDeLink, paraUrl, hostDaLista } from './rede.js';

export const HOSTS_MAGALU = Object.freeze(['magazineluiza.com.br', 'magazinevoce.com.br', 'magalu.com', 'maga.lu', 'magazineluiza.onelink.me']);
const HOST_LOJA = 'magazineluiza.com.br';  // a página do produto da Magalu
const HOST_PARCEIRO = 'magazinevoce.com.br'; // a mesma página dentro da loja de um parceiro
const HOSTS_PRODUTO = [HOST_LOJA, HOST_PARCEIRO];

/** Nome da loja de parceiro: a mesma regra do campo `loja` de Conexões (src/lojas.js usa o .source). */
export const RE_LOJA_MAGALU = /^[A-Za-z0-9_-]{2,60}$/;
/** O link de afiliado que sai (montarLinkMagalu confere o resultado contra ela antes de devolver). */
export const LINK_MAGALU = /^https:\/\/www\.magazinevoce\.com\.br\/[A-Za-z0-9_-]{2,60}\/(?:[a-z0-9-]{1,200}\/)?p\/[a-z0-9]{6,20}\/(?:[a-z0-9-]{1,60}\/){0,2}(?:\?seller_id=[A-Za-z0-9_-]{1,60})?$/;

const RE_SLUG = /^[a-z0-9-]{1,200}$/;
const RE_CODIGO = /^[a-z0-9]{6,20}$/;
const RE_CATEGORIA = /^[a-z0-9-]{1,60}$/;
const RE_SELLER = /^[A-Za-z0-9_-]{1,60}$/;
const MAX_CATEGORIAS = 2;

// ---------------------------------------------------------------------------------------------- erros

const MENSAGENS_LINK = Object.freeze({
  invalido: 'Não consegui abrir este link da Magalu. Cole o endereço da página do produto.',
  nao_produto: 'Este link da Magalu não leva a um produto.',
});

/** Link que não chegou a um produto da Magalu. Mensagem fixa: nunca a URL. */
export class LinkMagaluNaoResolvido extends Error {
  constructor(causa) {
    const c = Object.hasOwn(MENSAGENS_LINK, causa) ? causa : 'invalido';
    super(MENSAGENS_LINK[c]);
    this.name = 'LinkMagaluNaoResolvido';
    this.causa = c;
    this.codigo = c;
  }
}

export const MENSAGENS_MAGALU = Object.freeze({
  sem_loja: 'Falta o nome da sua loja de parceiro da Magalu. Cadastre em Conexões → Magalu.',
});

/** Erro da Magalu. `tipo` (= `codigo`) estável; mensagem fixa por tipo; nunca carrega a loja nem o link. */
export class ErroMagalu extends Error {
  constructor(tipo) {
    const t = Object.hasOwn(MENSAGENS_MAGALU, tipo) ? tipo : 'sem_loja';
    super(MENSAGENS_MAGALU[t]);
    this.name = 'ErroMagalu';
    this.tipo = t;
    this.codigo = t;
  }
}

// ------------------------------------------------------------------------------------- produto e link

/**
 * O texto colado tem, antes da query e do fragmento, algo que o parser de URL esconderia: `..` (resolvido), `%`
 * (codificação), `\` (vira `/`) ou barra dupla? Recusado antes de interpretar.
 */
function caminhoCruSuspeito(texto) {
  const cru = texto.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[?#]/)[0];
  return cru.includes('..') || cru.includes('%') || cru.includes('\\') || cru.includes('//');
}

/** Segmentos do produto ([slug/]p/<codigo>/[cat/[sub/]], já em minúsculas) → { slug, codigo, cats } | null. */
function lerSegmentos(seg) {
  let slug = null;
  let i = 0;
  if (seg[0] !== 'p') {
    if (seg[1] !== 'p' || !RE_SLUG.test(seg[0])) return null;
    slug = seg[0];
    i = 1;
  }
  const codigo = seg[i + 1];
  if (typeof codigo !== 'string' || !RE_CODIGO.test(codigo)) return null;
  const cats = seg.slice(i + 2);
  if (cats.length > MAX_CATEGORIAS || !cats.every((c) => RE_CATEGORIA.test(c))) return null;
  return { slug, codigo, cats };
}

/** Produto a partir de uma URL já interpretada (o `extrair` do resolvedor). null se não é página de produto. */
function produtoDaUrl(u) {
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port !== '') return null;
  const host = u.hostname.toLowerCase();
  const parceiro = hostDaLista(host, [HOST_PARCEIRO]);
  if (!parceiro && !hostDaLista(host, [HOST_LOJA])) return null;
  const caminho = u.pathname;
  if (caminho.includes('%') || caminho.includes('\\')) return null;
  const seg = caminho.split('/').slice(1); // o caminho sempre começa por '/'
  if (seg.length && seg[seg.length - 1] === '') seg.pop(); // barra final
  if (seg.some((s) => s === '')) return null; // barra dupla
  let lojaDoLink = null;
  if (parceiro) {
    lojaDoLink = seg.shift();
    if (typeof lojaDoLink !== 'string' || !RE_LOJA_MAGALU.test(lojaDoLink)) return null;
  }
  const partes = lerSegmentos(seg.map((s) => s.toLowerCase()));
  if (!partes) return null;
  const seller = u.searchParams.get('seller_id');
  const sellerId = typeof seller === 'string' && RE_SELLER.test(seller) ? seller : null;
  const caminhoProduto = `${partes.slug ? `${partes.slug}/` : ''}p/${partes.codigo}/${partes.cats.map((c) => `${c}/`).join('')}`;
  return {
    codigo: partes.codigo,
    urlProduto: `https://www.${HOST_LOJA}/${caminhoProduto}${sellerId ? `?seller_id=${sellerId}` : ''}`,
    sellerId,
    lojaDoLink,
    caminho: caminhoProduto, // interno: montarLinkMagalu usa; extrairProdutoMagalu tira
  };
}

const publico = (p) => (p ? { codigo: p.codigo, urlProduto: p.urlProduto, sellerId: p.sellerId, lojaDoLink: p.lojaDoLink } : null);

function produtoDoTexto(url) {
  if (typeof url !== 'string' || caminhoCruSuspeito(url)) return null;
  return produtoDaUrl(paraUrl(url));
}

/** { codigo, urlProduto, sellerId, lojaDoLink } de um link de produto da Magalu, ou null. Sem rede. */
export function extrairProdutoMagalu(url) {
  return publico(produtoDoTexto(url));
}

/** Link de afiliado com a loja de parceiro dada (ver o contrato no topo do arquivo). Sem rede. */
export function montarLinkMagalu(urlProduto, loja) {
  const nome = typeof loja === 'string' ? loja.trim() : '';
  if (!RE_LOJA_MAGALU.test(nome)) throw new ErroMagalu('sem_loja');
  const p = produtoDoTexto(urlProduto);
  if (!p) throw new LinkMagaluNaoResolvido('invalido');
  const link = `https://www.${HOST_PARCEIRO}/${nome}/${p.caminho}${p.sellerId ? `?seller_id=${p.sellerId}` : ''}`;
  if (!LINK_MAGALU.test(link)) throw new LinkMagaluNaoResolvido('invalido');
  return link;
}

// ------------------------------------------------------------------------------------------- resolvedor

/** Uma página de magazineluiza/magazinevoce que chegou (2xx) sem produto: início, busca, vitrine → 'nao_produto'. */
const paginaSemProduto = (u) => hostDaLista(u.hostname, HOSTS_PRODUTO);

/** Cliente da Magalu: só o resolvedor de link curto (ver o contrato no topo do arquivo). */
export function createMagalu({ fetch: doFetch, cache = new Map(), agora = Date.now } = {}) {
  async function resolver(url) {
    const direto = produtoDoTexto(url);
    if (direto) return publico(direto);
    const u = typeof url === 'string' && !caminhoCruSuspeito(url) ? paraUrl(url) : null;
    if (!u) throw new LinkMagaluNaoResolvido('invalido');
    // a página da Magalu nunca é pedida: o que não tem a forma de produto não vira produto abrindo a página
    if (hostDaLista(u.hostname, HOSTS_PRODUTO)) throw new LinkMagaluNaoResolvido(u.port === '' ? 'nao_produto' : 'invalido');
    try {
      const { valor } = await resolverPorRedirecionamento(url, {
        hosts: HOSTS_MAGALU, extrair: produtoDaUrl, paginaSemValor: paginaSemProduto, fetch: doFetch, cache, agora,
      });
      const p = publico(valor);
      if (!p || !extrairProdutoMagalu(p.urlProduto)) throw new LinkMagaluNaoResolvido('invalido');
      return p;
    } catch (e) {
      if (e instanceof LinkMagaluNaoResolvido) throw e;
      throw new LinkMagaluNaoResolvido(e instanceof FalhaDeLink ? e.causa : 'invalido'); // frases da Magalu, nunca a URL
    }
  }

  return { resolver };
}
