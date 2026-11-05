// Ponto único de loja: descobre de que loja é um link e, para as lojas já integradas, lê o
// produto e gera o link de afiliado. Hoje funcionam o Mercado Livre, a Amazon e a Shopee. As outras lojas
// aparecem em Conexões (campos que já podem ser salvos) e são recusadas com LojaNaoConectada.
//
// SSRF: identificar() só olha o hostname e nunca acessa a rede. O Mercado Livre lê a página (resolveOffer, que
// segue só hosts do ML); a Amazon e a Shopee só resolvem o link pelos redirecionamentos e consultam a API oficial
// (src/amazon.js e src/shopee.js, injetados). A imagem só passa se vier do CDN da própria loja (imagemPermitida).
//
// Amazon (plano espelhamento-amazon, etapa 7): o link enviado é sempre https://www.amazon.com.br/dp/<ASIN>?tag=<tag>
// (montarLink de amazon.js, com a tag de Conexões na hora da chamada): o slug, os parâmetros de rastreio e a tag
// de terceiro do link de origem nunca seguem adiante.
//
// Shopee (plano integracao-shopee, decisão 4; ADR-003): o link enviado é sempre o shortLink https://s.shopee.com.br/…
// gerado pela conta do dono (Open API quando útil, extensão do Chrome de reserva) a partir do endereço do produto
// sem parâmetros. Nunca o link colado, nunca montado à mão. Se o longLink da extensão trouxer outro an_<ID>, recusa.
// O link confiável fica guardado no cliente da Shopee por 7 dias (shopee.guardarLink, por produto e ID de afiliado):
// o mesmo produto não pede outro link à API nem à extensão a cada disparo (S2). Confiável = veio da API, ou da
// extensão com um longLink cujo an_<ID> é o ID salvo; sem essa prova, o link vale só para o disparo atual.
//
// Catálogo do Etiqueta (plano fonte-catalogo-etiqueta, etapa 3): não é loja, é uma fonte de ofertas que entra no
// registro só para ter o cartão de Conexões. `hosts: []` (identificar nunca a devolve; lerProduto e linkAfiliado a
// recusam) e nenhum segredo: o token fica num arquivo do dono e aqui só se guarda o CAMINHO dele (quem lê o arquivo
// é src/catalogo.js, na hora de cada chamada). O endereço só pode ser deste computador (D3).

import path from 'node:path';
import { IMAGEM_PERMITIDA, offerKey } from './ml.js';
import { IMAGEM_AMAZON, ErroAmazon, LinkNaoResolvido, extrairAsin } from './amazon.js';
import { IMAGEM_SHOPEE, ErroShopee, LinkShopeeNaoResolvido, LINK_SHOPEE, RE_ID_AFILIADO, RE_SUB_ID, extrairIds, afiliadoDoLongLink } from './shopee.js';
import { brl } from './template.js';

const MAX_URL = 4096;
const RE_ASIN = /^[A-Z0-9]{10}$/;

/**
 * Endereço do Etiqueta (D3): só http://localhost ou http://127.0.0.1, com porta de 1 a 65535 e nada depois dela
 * (sem caminho, usuário, senha, consulta nem barra final). É a regra do PUT de Conexões; src/catalogo.js confere de
 * novo antes de cada chamada.
 */
export const RE_ENDERECO_CATALOGO = /^http:\/\/(localhost|127\.0\.0\.1):([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/;
/** Caminho do arquivo do token: absoluto (/) ou na pasta do usuário (~/), sem caractere de controle. */
export const RE_CAMINHO_TOKEN = /^(~\/|\/)[^\u0000-\u001f\u007f]{1,500}$/;
/**
 * "Caminho" que é, na verdade, o próprio token (formato do token do Etiqueta: 32 ou mais de A-Za-z0-9_-), colado
 * puro ou com / ou ~/ na frente: nunca é lido. Regra única do PUT de Conexões e de src/catalogo.js.
 */
export const PARECE_TOKEN = /^(~\/|\/)?[A-Za-z0-9_-]{32,}$/;
/** Nome que o arquivo do token tem no Etiqueta. Outro nome é recusado no PUT e de novo antes de abrir o arquivo. */
export const ARQUIVO_TOKEN = 'api_token.txt';
/** O caminho termina no arquivo do token do Etiqueta (…/api_token.txt)? Um arquivo qualquer do dono nunca vira cabeçalho. */
export const caminhoDoArquivoDoToken = (v) => typeof v === 'string' && v.endsWith(`/${ARQUIVO_TOKEN}`) && path.posix.basename(v) === ARQUIVO_TOKEN;
/** Endereço que o cartão já traz preenchido (o servidor do Etiqueta escuta só em 127.0.0.1; localhost pode virar ::1). */
export const ENDERECO_CATALOGO_PADRAO = 'http://127.0.0.1:8765';

function congelar(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') congelar(v);
  return Object.freeze(o);
}

/**
 * Registro das plataformas, na ordem da tela Conexões.
 * - hosts: hostnames aceitos (vale o host exato ou um subdomínio dele, inclusive encurtadores).
 * - campos: o que a tela Conexões mostra e salva. tipo 'segredo' nunca volta ao navegador.
 *   padrao é uma regex em texto (com ^ e $) que o valor inteiro precisa casar. erro (opcional) é a frase de
 *   formato inválido no lugar da padrão (nunca inclui o valor).
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
    // O ID de afiliado e o AppID são texto (não protegem nada: o ID vai em todo link). Só a Senha da API é segredo.
    id: 'shopee', nome: 'Shopee', implementada: true,
    descricao: 'Programa de Afiliados da Shopee. O link curto de afiliado sai pela extensão do Chrome ou pela API; com a API, o painel também busca título, preço e foto do produto.',
    hosts: ['shopee.com.br', 's.shopee.com.br', 'shp.ee', 'shope.ee'],
    campos: [
      { nome: 'id_afiliado', rotulo: 'ID de afiliado', tipo: 'texto', max: 20, padrao: RE_ID_AFILIADO.source,
        ajuda: 'Só números. Ex.: 98765432101. É o número da sua conta de afiliado da Shopee. Vai nos seus links e define de quem é a comissão. Não é o AppID e não é a tag da Amazon.' },
      { nome: 'app_id', rotulo: 'AppID', tipo: 'texto', max: 20, padrao: '^[0-9]{1,20}$',
        ajuda: 'Número do aplicativo, mostrado na página da API de Afiliados da Shopee. Diferente do ID de afiliado.' },
      { nome: 'chave', rotulo: 'Senha da API', tipo: 'segredo', max: 128, padrao: '^[!-~]{8,128}$',
        ajuda: 'A senha fica guardada no seu computador e não volta para esta tela. Deixe em branco para manter a salva.' },
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
  {
    // Fonte de ofertas, não loja (ver o topo do arquivo): sem hosts e sem segredo. O caminho é texto (é do dono e
    // aparece na tela); o conteúdo do arquivo nunca passa por aqui.
    id: 'catalogo', nome: 'Catálogo do Etiqueta', implementada: true,
    descricao: 'O Etiqueta é o seu outro programa de ofertas, que roda neste computador. O painel lê as ofertas dele, que já vêm com o seu link de afiliado, e usa como fonte nos disparos automáticos. Não tem relação com as etiquetas do Mercado Livre.',
    hosts: [],
    campos: [
      { nome: 'endereco', rotulo: 'Endereço do Etiqueta', tipo: 'texto', max: 40, padrao: RE_ENDERECO_CATALOGO.source,
        erro: `Endereço não aceito. Use um endereço deste computador, como ${ENDERECO_CATALOGO_PADRAO}.`,
        ajuda: 'Onde o servidor do Etiqueta está rodando (python3 servidor.py). Só vale endereço deste computador: localhost ou 127.0.0.1.' },
      { nome: 'caminho_token', rotulo: 'Arquivo do token', tipo: 'texto', max: 500, padrao: RE_CAMINHO_TOKEN.source,
        erro: 'Caminho inválido. Use o caminho completo do arquivo, começando por / ou ~/.',
        ajuda: 'Caminho do arquivo api_token.txt que está na pasta do Etiqueta. Cole o caminho, nunca o conteúdo: o painel lê o arquivo e o token não passa por esta tela.' },
    ],
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
const IMAGENS = Object.freeze(Object.assign(Object.create(null), { mercadolivre: IMAGEM_PERMITIDA, amazon: IMAGEM_AMAZON, shopee: IMAGEM_SHOPEE }));

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
 * Amazon: resolve o link até o ASIN (amazon.resolver: só redirecionamentos de hosts da Amazon, mais o amzlinks.in de
 * terceiro só como salto e só no host exato, sem ler página) e consulta a API (amazon.lerItem). Erros:
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

function exigirShopee(shopee, ...metodos) {
  if (!shopee || metodos.some((m) => typeof shopee[m] !== 'function')) throw new Error('Serviço da Shopee indisponível.');
}

/** ErroShopee novo (nunca o mesmo objeto que outro chamador recebeu) com os ids já resolvidos. */
function erroComIds(e, ids) {
  const novo = e instanceof ErroShopee
    ? new ErroShopee(e.tipo, { status: e.status, codigoApi: e.codigoApi })
    : new ErroShopee('indisponivel');
  novo.ids = { ...ids };
  return novo;
}

/**
 * Ids do produto da Shopee: do próprio link (sem rede) ou, para encurtador, de shopee.resolver (só redirecionamentos
 * de hosts da Shopee). O resultado é refeito por extrairIds a partir do urlProduto: o que vem do resolvedor
 * injetado também precisa ser um endereço de produto da Shopee. Falha → LinkShopeeNaoResolvido.
 */
async function idsShopee(url, shopee) {
  let ids = extrairIds(url);
  if (!ids) {
    exigirShopee(shopee, 'resolver');
    ids = await shopee.resolver(url);
  }
  const v = extrairIds(ids?.urlProduto);
  if (!v) throw new LinkShopeeNaoResolvido('invalido');
  return v;
}

/**
 * Shopee: ids (extrairIds ou shopee.resolver) e shopee.lerItem. Erros:
 * - LinkShopeeNaoResolvido { causa: 'invalido' | 'nao_produto' } quando o link não chega a um produto;
 * - ErroShopee { tipo, ids } quando a API não respondeu ou não devolveu o produto ('nao_encontrado'). Os `ids`
 *   ({ shopId, itemId, urlProduto }) vão junto para quem chama seguir com os campos vazios.
 */
async function lerProdutoShopee(url, shopee) {
  exigirShopee(shopee, 'lerItem');
  const ids = await idsShopee(url, shopee);
  let oferta;
  try { oferta = await shopee.lerItem(ids.shopId, ids.itemId); } catch (e) { throw erroComIds(e, ids); }
  if (!oferta) throw erroComIds(new ErroShopee('nao_encontrado'), ids);
  const extra = oferta.extra && typeof oferta.extra === 'object' ? { ...oferta.extra } : null;
  return {
    ...oferta, extra, key: `SHOPEE:${ids.shopId}.${ids.itemId}`, shopId: ids.shopId, itemId: ids.itemId,
    urlProduto: ids.urlProduto, image: imagemSegura('shopee', oferta.image),
  };
}

/**
 * Pedir link com Sub_id à extensão do Chrome? Ligado desde o P4 do plano dashboard-ganhos: a extensão manda o Sub_id
 * ao "Link personalizado" do portal em advancedLinkParams.subId1 (SHOPEE_SUBID_CAMPO em extension/background.js;
 * formato em docs/produto/referencias/relatorios-dos-portais.md). Sem a Open API (ou se ela falhar), o pedido com
 * Sub_id vai à extensão e gasta uma vaga do teto de links por hora (src/links.js; esgotado → LIMITE_SHOPEE_ATINGIDO).
 * Quem pede o Sub_id guarda vagas desse teto para o link padrão (`reservaVagas`; o envio usa RESERVA_LINK_BASE_SHOPEE
 * de src/envios.js) e para de pedir Sub_id no envio assim que um não volta aplicado (extensão antiga, timeout, falha).
 * O Sub_id só conta como aplicado quando a extensão responde sub_id_aplicado: true; a extensão antiga (sem o campo)
 * devolve o link de afiliado sem Sub_id, com sub_id null. Desligado, o Sub_id só sairia pela Open API e, sem ela,
 * linkAfiliadoShopeeRastreado recusaria com SubIdIndisponivel. O valor é fixado por test/lojas.test.js; os dois
 * interruptores (este e SHOPEE_SUBID_CAMPO) mudam juntos.
 */
export const SUBID_PELA_EXTENSAO = true;

/**
 * O link com Sub_id não saiu sem pedir à extensão (ver SUBID_PELA_EXTENSAO). `motivo` vai para a cobertura do
 * rastreio: 'subid_extensao_indisponivel' (sem a API), 'falha_link' (a API falhou) ou 'limite_shopee' (o teto de links
 * por hora chegou à reserva do link padrão, `reservaVagas`). Nunca carrega Sub_id nem ID.
 */
export class SubIdIndisponivel extends Error {
  constructor(motivo = 'subid_extensao_indisponivel') {
    const limite = motivo === 'limite_shopee';
    super(limite ? 'O Sub_id da Shopee ficou sem vaga no limite de links por hora; o link padrão segue valendo.'
      : 'O Sub_id da Shopee só sai pela API, que não gerou o link agora.');
    this.name = 'SubIdIndisponivel';
    this.motivo = limite || motivo === 'falha_link' ? motivo : 'subid_extensao_indisponivel';
  }
}

/** Link já guardado no cliente da Shopee para o produto, o ID e o Sub_id ('' = o link padrão), ou null. */
function linkGuardadoShopee(shopee, urlProduto, id, subId) {
  if (typeof shopee?.linkGuardado !== 'function') return null;
  const l = subId ? shopee.linkGuardado(urlProduto, id, subId) : shopee.linkGuardado(urlProduto, id);
  return typeof l === 'string' && LINK_SHOPEE.test(l) ? l : null;
}

/**
 * Link de afiliado da Shopee (ver o topo do arquivo) → { link, sub_id }. Ordem: ID de afiliado salvo (senão
 * ErroShopee 'sem_id', sem rede) → endereço do produto sem parâmetros → link guardado para o produto, o ID e o
 * Sub_id (até 7 dias) → API (shopee.gerarLink, com { subId } quando há Sub_id) se shopee.apiUtil() → senão, ou se
 * a API falhar, a extensão (links.requestLinkShopee, com o mesmo subId). O link final precisa casar LINK_SHOPEE
 * ('link_falhou'), e o an_<ID> do longLink, quando vem, precisa ser o ID salvo ('outra_conta').
 * Sub_id (plano dashboard-ganhos, etapa 5): vazio ou fora de RE_SUB_ID (src/shopee.js) = sem Sub_id (o link padrão, D4).
 * `sub_id` é o Sub_id só quando ele foi aplicado: pela API (subIds é documentado) ou pela extensão que respondeu
 * sub_id_aplicado; senão null, e o link é o de afiliado sem Sub_id (CA9).
 * Só o link confiável é guardado (shopee.guardarLink): o da API, ou o da extensão com o an_<ID> do longLink
 * conferido. Guardado com o Sub_id só se ele foi aplicado; o que saiu sem Sub_id vale como o link padrão.
 * Link da extensão sem longLink (ou sem an_) sai neste disparo, mas não é guardado.
 * Com Sub_id, a extensão só é chamada se `subIdPelaExtensao === true` (padrão SUBID_PELA_EXTENSAO); senão, sem link
 * da API → SubIdIndisponivel, sem pedido nenhum (o link padrão, sem Sub_id, segue indo pela extensão como hoje).
 * `reservaVagas` (inteiro > 0; senão sem reserva): com Sub_id, a extensão só é chamada se links.vagasShopee() passa
 * dela; senão SubIdIndisponivel('limite_shopee'), sem pedido. O link padrão, a API e o link guardado não olham a reserva.
 */
async function linkAfiliadoShopee(base, { shopee, links, idAfiliado, subId, subIdPelaExtensao = SUBID_PELA_EXTENSAO, reservaVagas = 0 }) {
  const id = typeof idAfiliado === 'string' ? idAfiliado.trim() : '';
  if (!RE_ID_AFILIADO.test(id)) throw new ErroShopee('sem_id');
  const sub = typeof subId === 'string' && RE_SUB_ID.test(subId) ? subId : '';
  const { urlProduto } = await idsShopee(base, shopee);
  const guardado = linkGuardadoShopee(shopee, urlProduto, id, sub);
  if (guardado) return { link: guardado, sub_id: sub || null };
  let link = null;
  let longo = null;
  let daApi = false;
  let extAplicou = false;
  let apiTentada = false;
  if (typeof shopee?.apiUtil === 'function' && typeof shopee.gerarLink === 'function' && shopee.apiUtil()) {
    // os dois caminhos são da conta do dono; sem Sub_id, a chamada é a de antes (só o endereço)
    apiTentada = true;
    try { link = await shopee.gerarLink(urlProduto, ...(sub ? [{ subId: sub }] : [])); } catch { link = null; }
    daApi = link != null;
  }
  // desligado (subIdPelaExtensao !== true), o Sub_id não vai à extensão: economiza o teto de links por hora
  if (link == null && sub && subIdPelaExtensao !== true) throw new SubIdIndisponivel(apiTentada ? 'falha_link' : 'subid_extensao_indisponivel');
  if (link == null) {
    if (typeof links?.requestLinkShopee !== 'function') throw new Error('Serviço de links indisponível.');
    // as últimas vagas da hora ficam para o link padrão, sem o qual a oferta não sai para ninguém (R3/S2)
    const reserva = Number.isSafeInteger(reservaVagas) && reservaVagas > 0 ? reservaVagas : 0;
    if (sub && reserva && typeof links.vagasShopee === 'function' && !(links.vagasShopee() > reserva)) throw new SubIdIndisponivel('limite_shopee');
    const r = await links.requestLinkShopee(sub ? { url: urlProduto, subId: sub } : { url: urlProduto });
    link = r?.link;
    longo = r?.longo ?? null;
    extAplicou = r?.subIdAplicado === true;
  }
  if (typeof link !== 'string' || !LINK_SHOPEE.test(link)) throw new ErroShopee('link_falhou');
  const dono = afiliadoDoLongLink(longo);
  if (dono && dono !== id) throw new ErroShopee('outra_conta', { final: id.slice(-4) });
  const aplicado = sub !== '' && (daApi || extAplicou);
  const confiavel = daApi || dono === id;
  if (confiavel && typeof shopee?.guardarLink === 'function') {
    if (aplicado) shopee.guardarLink(urlProduto, id, link, sub);
    else shopee.guardarLink(urlProduto, id, link);
  }
  return { link, sub_id: aplicado ? sub : null };
}

/**
 * Link de afiliado da Shopee com o Sub_id de rastreio (plano dashboard-ganhos, etapa 5) → { link, sub_id }.
 * `base`: o link ou o endereço do produto (tem de ser da Shopee). deps: { shopee, links, idAfiliado, subId? }.
 * `sub_id` é null quando o Sub_id não foi pedido, era inválido ou não foi aplicado (ex.: extensão antiga, que não
 * responde sub_id_aplicado): o link continua de afiliado, o mesmo de sem Sub_id. Erros: os do link padrão e, com Sub_id
 * válido e sem link da API, SubIdIndisponivel (a extensão só recebe Sub_id com `subIdPelaExtensao: true`; padrão
 * SUBID_PELA_EXTENSAO; nem com o teto da hora na `reservaVagas` do link padrão: motivo 'limite_shopee').
 */
export async function linkAfiliadoShopeeRastreado(base, { shopee, links, idAfiliado, subId, subIdPelaExtensao = SUBID_PELA_EXTENSAO, reservaVagas = 0 } = {}) {
  return linkAfiliadoShopee(exigirLoja('shopee', base), { shopee, links, idAfiliado, subId, subIdPelaExtensao, reservaVagas });
}

/**
 * Lê título, preço e foto do produto. Mercado Livre: ml.resolveOffer (injetado). Amazon: amazon (createAmazon,
 * injetado) → { key: 'ASIN:<ASIN>', asin, title, price, oldPrice, discountPct, image, … }. Shopee: shopee
 * (createShopee, injetado) → { key: 'SHOPEE:<shop>.<item>', shopId, itemId, urlProduto, title, price, oldPrice:null,
 * discountPct, sold, image, extra: { loja_nome, nota, preco_max }, … }.
 * A imagem fora do CDN da loja vira null: o envio busca essa URL no servidor.
 */
export async function lerProduto(id, url, { ml, amazon, shopee } = {}) {
  const limpo = exigirLoja(id, url);
  if (id === 'amazon') return lerProdutoAmazon(limpo, amazon);
  if (id === 'shopee') return lerProdutoShopee(limpo, shopee);
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
 * - Shopee: o shortLink https://s.shopee.com.br/… (linkAfiliadoShopee). Parte de `urlProduto` (o endereço já
 *   resolvido pelo servidor, ex.: o do payload) ou de `url`; `idAfiliado` é o ID salvo em Conexões. `tag` é ignorada.
 */
export async function linkAfiliado(id, { url, tag, asin, urlProduto } = {}, { links, amazon, shopee, idAfiliado } = {}) {
  if (id === 'shopee') return (await linkAfiliadoShopeeRastreado(urlProduto ?? url, { shopee, links, idAfiliado })).link;
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
