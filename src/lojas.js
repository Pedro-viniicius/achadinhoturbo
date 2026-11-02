// Ponto único de loja: descobre de que loja é um link e, para as lojas já integradas, lê o
// produto e gera o link de afiliado. Hoje só o Mercado Livre funciona. As outras lojas
// aparecem em Conexões (campos que já podem ser salvos) e são recusadas com LojaNaoConectada.
//
// SSRF: identificar() só olha o hostname e nunca acessa a rede. Só o Mercado Livre lê página
// (resolveOffer, que segue só hosts do ML) e a imagem só passa se vier do CDN mlstatic.

import { IMAGEM_PERMITIDA, offerKey } from './ml.js';
import { brl } from './template.js';

const MAX_URL = 4096;

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
    id: 'amazon', nome: 'Amazon', implementada: false,
    descricao: 'Programa de Associados da Amazon. Sem API: o link leva a sua tag de associado.',
    hosts: ['amazon.com.br', 'www.amazon.com.br', 'amazon.com', 'amzn.to', 'a.co'],
    campos: [
      { nome: 'tag', rotulo: 'Tag de associado', tipo: 'texto', max: 64, padrao: '^[A-Za-z0-9_-]{2,64}$',
        ajuda: 'Ex.: seunome-20' },
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

const imagemSegura = (img) => (typeof img === 'string' && IMAGEM_PERMITIDA.test(img) ? img : null);

/**
 * Lê título, preço e foto do produto. Só o Mercado Livre (ml.resolveOffer, injetado).
 * A imagem fora do CDN mlstatic vira null: o envio busca essa URL no servidor.
 */
export async function lerProduto(id, url, { ml } = {}) {
  const limpo = exigirLoja(id, url);
  if (!ml?.resolveOffer) throw new Error('Leitura de produtos do Mercado Livre indisponível.');
  const offer = await ml.resolveOffer({ key: offerKey(limpo), url: limpo });
  return { ...offer, image: imagemSegura(offer?.image) };
}

/** Link de afiliado do produto com a etiqueta (tag) escolhida. Só o Mercado Livre (links.requestLink, injetado). */
export async function linkAfiliado(id, { url, tag } = {}, { links } = {}) {
  const limpo = exigirLoja(id, url);
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
