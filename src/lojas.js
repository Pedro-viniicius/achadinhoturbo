// Ponto único de loja: descobre de que loja é um link e, para as lojas já integradas, lê o
// produto e gera o link de afiliado. Hoje funcionam o Mercado Livre e a Amazon. As outras lojas
// aparecem em Conexões (campos que já podem ser salvos) e são recusadas com LojaNaoConectada.
//
// SSRF: identificar() só olha o hostname e nunca acessa a rede. O Mercado Livre lê a página (resolveOffer, que
// segue só hosts do ML); a Amazon só resolve o link pelos redirecionamentos e consulta a API oficial (as duas
// coisas em src/amazon.js, injetado). A imagem só passa se vier do CDN da própria loja (imagemPermitida).
//
// Amazon (plano espelhamento-amazon, etapa 7): o link enviado é sempre https://www.amazon.com.br/dp/<ASIN>?tag=<tag>
// (montarLink de amazon.js, com a tag de Conexões na hora da chamada): o slug, os parâmetros de rastreio e a tag
// de terceiro do link de origem nunca seguem adiante.

import { IMAGEM_PERMITIDA, offerKey } from './ml.js';
import { IMAGEM_AMAZON, ErroAmazon, LinkNaoResolvido, extrairAsin } from './amazon.js';
import { brl } from './template.js';

const MAX_URL = 4096;
const RE_ASIN = /^[A-Z0-9]{10}$/;

function congelar(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') congelar(v);
  return Object.freeze(o);
}

/**
 * Registro das plataformas, na ordem da tela Conexões.
 * - hosts: hostnames aceitos (vale o host exato ou um subdomínio dele, inclusive encurtadores).
 * - campos: o que a tela Conexões mostra e salva. tipo 'segredo' nunca volta ao navegador.
 *   padrao é uma regex em texto (com ^ e $) que o valor inteiro precisa casar.
 */
const LISTA = [
  {
    id: 'mercadolivre', nome: 'Mercado Livre', implementada: true,
    descricao: 'Gera os links meli.la com as suas etiquetas, pela extensão do Chrome.',
    hosts: ['mercadolivre.com.br', 'www.mercadolivre.com.br', 'produto.mercadolivre.com.br', 'meli.la'],
    campos: [
      { nome: 'etiqueta', rotulo: 'Etiqueta', tipo: 'texto', max: 60, padrao: '^[\\w.-]{2,60}$',
        ajuda: 'Etiqueta de afiliado usada no link meli.la. É o que atribui a comissão a você.' },
    ],
  },
  {
    // A tag é texto (decisão do lead de 02/11): vai em todo link enviado, então escondê-la não protege nada.
    // Só o ID e o segredo da credencial da Creators API são segredos.
    id: 'amazon', nome: 'Amazon', implementada: true,
    descricao: 'Programa de Associados da Amazon. Com a API oficial, o painel busca título, preço e foto do produto e gera o link com a sua tag.',
    hosts: ['amazon.com.br', 'www.amazon.com.br', 'amazon.com', 'amzn.to', 'amzn.com', 'a.co', 'link.amazon'],
    campos: [
      { nome: 'tag', rotulo: 'Tag de associado', tipo: 'texto', max: 64, padrao: '^[A-Za-z0-9_-]{2,64}$',
        ajuda: 'Ex.: seunome-20. Todo link enviado leva esta tag.' },
      { nome: 'credencial_id', rotulo: 'ID da credencial', tipo: 'segredo', max: 128, padrao: '^[A-Za-z0-9._-]{8,128}$',
        ajuda: 'Da Central de Associados, em Creators API. Não volta para esta tela; deixe em branco para manter o salvo.' },
      { nome: 'credencial_secret', rotulo: 'Segredo da credencial', tipo: 'segredo', max: 256, padrao: '^[!-~]{8,256}$',
        ajuda: 'O segredo fica guardado no seu computador e não volta para esta tela. Deixe em branco para manter o salvo.' },
      { nome: 'credencial_versao', rotulo: 'Versão da credencial', tipo: 'texto', max: 10, padrao: '^3\\.[1-3]$',
        ajuda: 'Versão que veio com a credencial; Brasil: 3.1' },
    ],
  },
  {
    id: 'shopee', nome: 'Shopee', implementada: false,
    descricao: 'Programa de Afiliados da Shopee, pela API de afiliados (AppID e chave secreta).',
    hosts: ['shopee.com.br', 's.shopee.com.br', 'shp.ee', 'shope.ee'],
    campos: [
      { nome: 'app_id', rotulo: 'AppID', tipo: 'texto', max: 20, padrao: '^[0-9]{1,20}$',
        ajuda: 'Número do aplicativo no painel de afiliados da Shopee.' },
      { nome: 'chave', rotulo: 'Chave secreta', tipo: 'segredo', max: 128, padrao: '^[!-~]{8,128}$',
        ajuda: 'A chave não volta para o navegador. Deixe em branco para manter a chave atual.' },
    ],
  },
  {
    id: 'magalu', nome: 'Magalu', implementada: false,
    descricao: 'Parceiro Magalu: o link leva o nome da sua loja de parceiro.',
    hosts: ['magazineluiza.com.br', 'www.magazineluiza.com.br', 'magazinevoce.com.br', 'www.magazinevoce.com.br', 'magalu.com'],
    campos: [
      { nome: 'loja', rotulo: 'Nome da sua loja', tipo: 'texto', max: 60, padrao: '^[A-Za-z0-9_-]{2,60}$',
        ajuda: 'Como aparece no endereço da sua loja de parceiro.' },
    ],
  },
  {
    id: 'facebook', nome: 'Facebook', implementada: false,
    descricao: 'Acompanhar campanhas e gasto no painel.',
    hosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.com', 'fb.me'],
    campos: [],
  },
];

/**
 * Plataformas por id. Objeto sem protótipo: PLATAFORMAS[idQueVeioDaRequisicao] nunca acha
 * 'constructor', '__proto__' etc. Tudo congelado (é configuração compartilhada).
 */
export const PLATAFORMAS = congelar(Object.assign(Object.create(null), Object.fromEntries(LISTA.map((p) => [p.id, p]))));

function plataforma(id) {
  return typeof id === 'string' && Object.hasOwn(PLATAFORMAS, id) ? PLATAFORMAS[id] : null;
}

const resumo = (p) => ({ id: p.id, nome: p.nome, implementada: p.implementada });

/** Link de uma loja que ainda não tem integração. A mensagem já serve para mostrar na tela. */
export class LojaNaoConectada extends Error {
  constructor(loja) {
    super(`${loja.nome} identificada, mas ainda não está conectada. Configure em Conexões.`);
    this.name = 'LojaNaoConectada';
    this.loja = resumo(loja);
  }
}

/**
 * De que loja é este link? → { id, nome, implementada } ou null.
 * Só lê o hostname (sem rede). Aceita o host exato ou um subdomínio: x.mercadolivre.com.br sim,
 * mercadolivre.com.br.evil.com e evilmercadolivre.com.br não. Só http: e https:.
 */
export function identificar(url) {
  if (typeof url !== 'string' || url.length > MAX_URL) return null;
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  const p = LISTA.find((l) => l.hosts.some((h) => host === h || host.endsWith('.' + h)));
  return p ? resumo(p) : null;
}

/** Garante que a loja existe, está integrada e que o link é dela. Devolve a URL sem espaços. */
function exigirLoja(id, url) {
  const p = plataforma(id);
  if (!p) throw new Error('Loja desconhecida.');
  if (!p.implementada) throw new LojaNaoConectada(p);
  if (identificar(url)?.id !== p.id) throw new Error(`Este link não é da loja ${p.nome}.`);
  return url.trim();
}

/** CDN de imagem de cada loja integrada. Sem protótipo: id vindo de fora não acha 'constructor'. */
const IMAGENS = Object.freeze(Object.assign(Object.create(null), { mercadolivre: IMAGEM_PERMITIDA, amazon: IMAGEM_AMAZON }));

/**
 * A foto do produto pode seguir adiante? Só https do CDN da própria loja (o envio baixa essa URL no servidor).
 * Loja sem CDN conhecido, URL de outra loja ou valor que não é texto → false.
 */
export function imagemPermitida(lojaId, url) {
  if (typeof url !== 'string' || !url || url.length > MAX_URL) return false;
  const re = typeof lojaId === 'string' && Object.hasOwn(IMAGENS, lojaId) ? IMAGENS[lojaId] : null;
  return !!re && re.test(url);
}

const imagemSegura = (lojaId, img) => (imagemPermitida(lojaId, img) ? img : null);

/** ErroAmazon novo (nunca o mesmo objeto que outro chamador recebeu) com o ASIN já resolvido. */
function erroComAsin(e, asin) {
  const tipo = e instanceof ErroAmazon ? e.tipo : 'indisponivel';
  const novo = new ErroAmazon(tipo, e instanceof ErroAmazon ? { status: e.status, retryAfterSeconds: e.retryAfterSeconds } : {});
  novo.asin = asin;
  return novo;
}

function exigirAmazon(amazon, ...metodos) {
  if (!amazon || metodos.some((m) => typeof amazon[m] !== 'function')) throw new Error('Serviço da Amazon indisponível.');
}

/**
 * Amazon: resolve o link até o ASIN (amazon.resolver: só redirecionamentos de hosts da Amazon, sem ler página) e
 * consulta a API (amazon.lerItem). Erros:
 * - LinkNaoResolvido { causa: 'invalido' | 'nao_produto' } quando o link não chega a um ASIN;
 * - ErroAmazon { tipo, asin } quando a API não respondeu ou não achou o produto ('nao_encontrado'). O `asin` vai
 *   junto para quem chama poder seguir com os campos vazios (o link limpo só precisa dele).
 */
async function lerProdutoAmazon(url, amazon) {
  exigirAmazon(amazon, 'resolver', 'lerItem');
  const resolvido = await amazon.resolver(url);
  const asin = typeof resolvido?.asin === 'string' ? resolvido.asin.toUpperCase() : '';
  if (!RE_ASIN.test(asin)) throw new LinkNaoResolvido('invalido');
  let oferta;
  try { oferta = await amazon.lerItem(asin); } catch (e) { throw erroComAsin(e, asin); }
  if (!oferta) throw erroComAsin(new ErroAmazon('nao_encontrado'), asin);
  return { ...oferta, key: `ASIN:${asin}`, asin, image: imagemSegura('amazon', oferta.image) };
}

/**
 * Lê título, preço e foto do produto. Mercado Livre: ml.resolveOffer (injetado). Amazon: amazon (createAmazon,
 * injetado) → { key: 'ASIN:<ASIN>', asin, title, price, oldPrice, discountPct, image, … }.
 * A imagem fora do CDN da loja vira null: o envio busca essa URL no servidor.
 */
export async function lerProduto(id, url, { ml, amazon } = {}) {
  const limpo = exigirLoja(id, url);
  if (id === 'amazon') return lerProdutoAmazon(limpo, amazon);
  if (!ml?.resolveOffer) throw new Error('Leitura de produtos do Mercado Livre indisponível.');
  const offer = await ml.resolveOffer({ key: offerKey(limpo), url: limpo });
  return { ...offer, image: imagemSegura('mercadolivre', offer?.image) };
}

/**
 * Link de afiliado do produto.
 * - Mercado Livre: com a etiqueta (tag) escolhida, por links.requestLink (injetado).
 * - Amazon: sempre https://www.amazon.com.br/dp/<ASIN>?tag=<tag de Conexões> (amazon.montarLink). O ASIN vem de
 *   `asin` (já resolvido pelo servidor, ex.: o do payload do envio), do próprio link ou, para encurtador, de
 *   amazon.resolver. `tag` é ignorada: a tag é a de Conexões. Sem tag salva → ErroAmazon('sem_tag'), com a
 *   mensagem fixa (nunca carrega ID, segredo nem token).
 */
export async function linkAfiliado(id, { url, tag, asin } = {}, { links, amazon } = {}) {
  const limpo = exigirLoja(id, url);
  if (id === 'amazon') {
    exigirAmazon(amazon, 'montarLink');
    const dado = typeof asin === 'string' ? asin.trim().toUpperCase() : '';
    let a = RE_ASIN.test(dado) ? dado : extrairAsin(limpo);
    if (!a) {
      exigirAmazon(amazon, 'montarLink', 'resolver');
      a = (await amazon.resolver(limpo))?.asin;
    }
    return amazon.montarLink(a);
  }
  if (typeof tag !== 'string' || !tag.trim()) throw new Error('Escolha uma etiqueta.');
  if (!links?.requestLink) throw new Error('Serviço de links indisponível.');
  return links.requestLink({ url: limpo, tag: tag.trim() });
}

const SO_ML = 'A prévia do link só funciona com links do Mercado Livre.';

/**
 * Dados para a prévia do link no WhatsApp: { title, description?, image }.
 * Só Mercado Livre e só imagem mlstatic; qualquer outro site é recusado (sem buscar nada).
 */
export async function previaDoLink(url, { ml } = {}) {
  const loja = identificar(url);
  if (!loja) throw new Error(SO_ML);
  if (!loja.implementada) throw new LojaNaoConectada(loja);
  if (loja.id !== 'mercadolivre') throw new Error(SO_ML);
  const offer = await lerProduto(loja.id, url, { ml });
  const previa = { title: String(offer.title || ''), image: offer.image };
  const preco = brl(offer.price);
  if (preco) previa.description = preco;
  return previa;
}
