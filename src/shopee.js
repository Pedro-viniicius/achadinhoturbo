// Tudo o que fala com a Shopee no servidor (plano integracao-shopee, decisão 2; ADR-003). Sem raspar HTML.
//
// Contrato do módulo:
//
// - extrairIds(url) → { shopId, itemId, urlProduto } | null. Sem rede. Lê o caminho de shopee.com.br e subdomínios
//   (menos o encurtador s.shopee.com.br): /<slug>-i.<shopId>.<itemId> e /product/<shopId>/<itemId> (também
//   /universal-link/product/…), com ou sem barra final. Os ids são dígitos (até 20) sem zeros à esquerda.
//   urlProduto = https://shopee.com.br + caminho, sem query nem fragmento: é o que vai à API e à extensão.
// - afiliadoDoLongLink(url) → '<dígitos>' do utm_source=an_<dígitos> | null (sem an_) | 'varios' (dois an_
//   diferentes: nunca confere com um ID).
// - HOSTS_SHOPEE, IMAGEM_SHOPEE (CDN da foto), LINK_SHOPEE (o único link de afiliado aceito: https://s.shopee.com.br/<código>),
//   RE_ID_AFILIADO (o ID de afiliado salvo em Conexões: só dígitos, de 5 a 20; a fonte única do formato).
// - ofertaDoNo(no, { shopId, itemId }) → oferta (parser tolerante do nó de productOfferV2; nunca lança).
// - createShopee({ db, fetch, agora, lerConexao, cacheLinks = new Map(), limiteHora = 300 }) →
//   { resolver(url), lerItem(shopId, itemId, { fresco }?), gerarLink(urlProduto), testar(), situacao(), configurado(),
//     apiUtil(), invalidar(), linkGuardado(urlProduto, idAfiliado, subId = ''),
//     guardarLink(urlProduto, idAfiliado, link, subId = '') }
//   - Teto de rede (S3): no máximo `limiteHora` acessos à Shopee por hora, somando cada chamada à Open API e cada
//     salto do resolvedor de link curto (o que vem do cache não conta). Passou do teto → ErroShopee('cota'), sem
//     rede; esse erro é do próprio programa e não muda situacao().
//   - Credenciais lidas a cada chamada: por padrão da linha 'shopee' de `conexoes` (config.app_id, segredos.chave);
//     o servidor pode injetar `lerConexao` (ex.: () => segredosDe(db, 'shopee')). Nada fica em variável de módulo.
//   - Chamada: POST URL_API com redirect:'error', timeout de 15 s, corpo lido até 2 MiB e
//     Authorization: SHA256 Credential=<AppId>, Timestamp=<s>, Signature=sha256hex(AppId + Timestamp + corpo + Senha).
//   - resolver(url) → ids (como extrairIds). Link curto: só redirecionamentos de hosts da Shopee (src/rede.js).
//     Falha → LinkShopeeNaoResolvido { causa: 'invalido' | 'nao_produto' }.
//   - lerItem(shopId, itemId) → oferta | null (a API não devolveu o nó desse item). Cache de 15 min por item
//     (inclusive o null); pedidos simultâneos do mesmo item dividem uma chamada. Falha → ErroShopee { tipo }.
//     `fresco: true` (o verificador de preço, plano verificador-preco-estoque D2): ignora o cache na leitura e vai à
//     API (ou junta-se a uma chamada em voo do mesmo item); o resultado regrava o cache. Conta no teto da hora como
//     qualquer chamada: teto atingido → ErroShopee('cota'), sem rede e sem nova tentativa. Sem a opção (ou com
//     qualquer valor que não seja true), o comportamento é o de sempre.
//   - gerarLink(urlProduto, { subId }?) → shortLink (generateShortLink). Com subId (RE_SUB_ID: alfanumérico, 1 a 30) a
//     mutation leva subIds:["<subId>"]; sem subId o corpo é idêntico ao de antes. subId que não serve →
//     ErroShopee('link_falhou'), sem rede e sem mudar situacao(). Fora de LINK_SHOPEE → ErroShopee('indisponivel').
//   - testar() → { ok, resultado: 'ok'|'nao_configurada'|'recusada'|'sem_acesso'|'conta_restrita'|'cota'|'indisponivel',
//     mensagem (FRASES_TESTE_SHOPEE), campos (os campos do nó que vieram preenchidos) }.
//   - situacao() → { acesso: 'nao_configurada'|'desconhecido'|'ok'|'sem_acesso'|'credencial_recusada'|
//     'conta_restrita'|'cota'|'indisponivel', verificado_em, motivo }; vale só para o mesmo AppID + Senha.
//   - configurado() → há AppID e Senha. apiUtil() → configurado e o último acesso não é sem_acesso,
//     credencial_recusada nem conta_restrita.
//   - linkGuardado / guardarLink (S2): o shortLink já gerado para o produto (por shopId.itemId, vindo do urlProduto)
//     e o ID de afiliado, por 7 dias, para não gerar outro a cada disparo. Vale para o link da API e o da
//     extensão (quem guarda é src/lojas.js). Outro ID de afiliado não acha o link do anterior; só guarda
//     LINK_SHOPEE. Fica só na memória do cliente. Com subId (opcional) o link é guardado por produto + ID + Sub_id: o
//     mesmo produto com outro Sub_id não reaproveita o link; sem subId a chave é a de antes. subId inválido: não
//     guarda (false) e não acha (null).
//   - invalidar(): chamar ao salvar a conexão. Esquece a última verificação, o cache de itens e os links guardados.
//
// Erros da API: o código sai de errors[0].extensions.code (ou errors[0].code); formato não verificado com a
// conta real, então o parser é tolerante e código desconhecido vira 'indisponivel'.
//
// Segurança: a Senha só é lida dentro da chamada e só entra no hash; a assinatura não é guardada. Mensagens de
// erro fixas por tipo (nunca corpo de resposta, URL, AppID, Senha ou assinatura); o módulo não escreve no console.
// Hosts de rede fixos: o da API e os de HOSTS_SHOPEE no resolvedor. Os ids entram na consulta GraphQL só como
// dígitos validados e a originUrl só com JSON.stringify, a partir de um caminho já normalizado.

import { createHash } from 'node:crypto';
import { resolverPorRedirecionamento, lerCorpoLimitado, paraUrl, hostDaLista, MAX_URL } from './rede.js';
import { tituloDeUmaLinha } from './titulo.js';

export const HOSTS_SHOPEE = Object.freeze(['shopee.com.br', 's.shopee.com.br', 'shp.ee', 'shope.ee']);
const HOSTS_PRODUTO = ['shopee.com.br'];   // onde o caminho pode trazer os ids
const ENCURTADORES = ['s.shopee.com.br']; // subdomínio de shopee.com.br que só tem códigos: nunca é produto
// Hosts da foto ainda não conferidos com uma resposta real da API (ver Riscos no plano): a CSP do painel e a
// regex de public/disparos.js precisam mudar junto.
export const IMAGEM_SHOPEE = /^https:\/\/(([\w-]+\.)+susercontent\.com|cf\.shopee\.com\.br)\//i;
export const LINK_SHOPEE = /^https:\/\/s\.shopee\.com\.br\/[A-Za-z0-9_-]{3,40}$/;
export const URL_API = 'https://open-api.affiliate.shopee.com.br/graphql';

const TIMEOUT_API = 15000;
const MAX_CORPO = 2 * 1024 * 1024;
const CACHE_ITEM_MS = 15 * 60 * 1000;
const CACHE_ITEM_MAX = 1000;
const CACHE_LINK_AFILIADO_MS = 7 * 24 * 3600 * 1000;
const CACHE_LINK_AFILIADO_MAX = 2000;
const JANELA_TETO_MS = 3600 * 1000;
const LIMITE_HORA = 300; // acessos à Shopee por hora (API + resolvedor), para o cliente único do servidor
const MAX_TITULO = 200; // mesmo teto do painel e de src/envios.js
const MAX_LOJA = 80;
const RE_ID = /^\d{1,20}$/;
export const RE_ID_AFILIADO = /^[0-9]{5,20}$/;
const RE_APP_ID = /^[0-9]{1,20}$/;
// Sub_id da Shopee: só alfanumérico (a Central de Afiliados não aceita outro caractere). O teto de 30 ainda não foi
// conferido com a Shopee (provisório, plano dashboard-ganhos D3); a fonte única do formato é esta.
export const RE_SUB_ID = /^[A-Za-z0-9]{1,30}$/;
const RE_SLUG = /-i\.(\d{1,20})\.(\d{1,20})\/?$/;
const RE_PRODUTO = /^\/(?:universal-link\/)?product\/(\d{1,20})\/(\d{1,20})\/?$/;
const CAMPOS_NO = ['itemId', 'productName', 'priceMin', 'priceMax', 'priceDiscountRate', 'sales', 'ratingStar', 'imageUrl', 'shopName'];

// ---------------------------------------------------------------------------------------------- erros

const MENSAGENS_LINK = {
  invalido: 'Não consegui abrir este link da Shopee.',
  nao_produto: 'Este link da Shopee não leva a um produto.',
};

/** Link que não chegou a um produto. Mensagem fixa: nunca a URL. */
export class LinkShopeeNaoResolvido extends Error {
  constructor(causa) {
    const c = Object.hasOwn(MENSAGENS_LINK, causa) ? causa : 'invalido';
    super(MENSAGENS_LINK[c]);
    this.name = 'LinkShopeeNaoResolvido';
    this.causa = c;
    this.codigo = c;
  }
}

export const MENSAGENS_SHOPEE = Object.freeze({
  sem_credenciais: 'A busca de dados da Shopee não está ligada (faltam o AppID e a Senha da API em Conexões).',
  credencial_recusada: 'A Shopee não aceitou o AppID ou a Senha da API salvos. Confira em Conexões e use "Testar".',
  conta_restrita: 'A Shopee recusou o acesso da API a esta conta. Fale com o suporte de afiliados da Shopee.',
  sem_acesso: 'A Shopee ainda não liberou a API para a sua conta.',
  cota: 'A Shopee limitou as consultas por agora. Tente de novo em alguns minutos.',
  nao_encontrado: 'A Shopee não encontrou este produto na API de afiliados. Ele pode não participar do programa.',
  indisponivel: 'A Shopee não respondeu agora. Tente de novo em alguns minutos.',
  // do link de afiliado (src/lojas.js)
  sem_id: 'Falta o ID de afiliado da Shopee em Conexões.',
  outra_conta: 'O Chrome está logado em outra conta de afiliado da Shopee. Entre na conta do ID de Conexões e tente de novo.',
  link_falhou: 'A Shopee não gerou o seu link agora. Tente de novo em alguns minutos.',
});

/**
 * Erro da Shopee. `tipo` (= `codigo`) estável; mensagem fixa por tipo; nunca carrega corpo, URL, AppID, Senha
 * ou assinatura. `codigoApi` é o número do erro da Open API, quando veio. `final` (só 'outra_conta'): os 4
 * últimos dígitos do ID de afiliado salvo, para a frase da spec (o ID não é segredo).
 */
export class ErroShopee extends Error {
  constructor(tipo, { status = null, codigoApi = null, final = null } = {}) {
    const t = Object.hasOwn(MENSAGENS_SHOPEE, tipo) ? tipo : 'indisponivel';
    const fim = t === 'outra_conta' && typeof final === 'string' && /^\d{4}$/.test(final) ? final : null;
    super(fim ? `O Chrome está logado em outra conta de afiliado da Shopee. Entre na conta do ID …${fim} e tente de novo.` : MENSAGENS_SHOPEE[t]);
    this.name = 'ErroShopee';
    this.tipo = t;
    this.codigo = t;
    this.status = status;
    this.codigoApi = Number.isInteger(codigoApi) ? codigoApi : null;
  }
}

/** Código da Open API → tipo. Fora da tabela (inclusive 11000/11001) → 'indisponivel'. */
const TIPO_DO_CODIGO = Object.freeze({
  10020: 'credencial_recusada',
  10030: 'cota',
  10031: 'conta_restrita', 10032: 'conta_restrita', 10033: 'conta_restrita', 10034: 'conta_restrita', 11002: 'conta_restrita',
  10035: 'sem_acesso',
  11000: 'indisponivel', 11001: 'indisponivel',
});

/** Frases do "Testar" (spec, seção 1). `sem_id` é do conexoes.js (credencial aceita e ID de afiliado vazio). */
export const FRASES_TESTE_SHOPEE = Object.freeze({
  ok: 'Credenciais aceitas pela Shopee.',
  nao_configurada: 'Salve o AppID e a Senha da API para testar.',
  recusada: 'A Shopee não aceitou o AppID ou a Senha da API. Confira se copiou os dois por inteiro, sem espaços, se o aplicativo está ativo no painel de afiliados e se a data e a hora do computador estão certas.',
  sem_acesso: 'A Shopee ainda não liberou a API para a sua conta. Peça o acesso pelo link acima e tente de novo quando eles responderem. Enquanto isso os links continuam saindo pela extensão.',
  conta_restrita: 'A Shopee recusou o acesso desta conta (acesso negado, ID de afiliado inválido, conta com restrição ou credenciais de outra conta). Fale com o suporte de afiliados da Shopee.',
  cota: 'A Shopee limitou as consultas por agora. Tente de novo em alguns minutos.',
  indisponivel: 'A Shopee não respondeu agora. Tente de novo em alguns minutos.',
  sem_id: 'Credenciais aceitas, mas falta o ID de afiliado.',
});

const RESULTADO_DO_TIPO = { credencial_recusada: 'recusada', sem_acesso: 'sem_acesso', conta_restrita: 'conta_restrita', cota: 'cota' };
const ACESSO_DO_TIPO = {
  sem_credenciais: 'nao_configurada', credencial_recusada: 'credencial_recusada', conta_restrita: 'conta_restrita',
  sem_acesso: 'sem_acesso', cota: 'cota', indisponivel: 'indisponivel',
};
const ACESSO_SEM_API = new Set(['sem_acesso', 'credencial_recusada', 'conta_restrita']);

// ------------------------------------------------------------------------------------------ ids e links

/** Sub_id pedido: '' (ausente: undefined, null ou vazio), o próprio texto se for válido, ou null se não servir. */
function subIdDe(v) {
  if (v === undefined || v === null || v === '') return '';
  return typeof v === 'string' && RE_SUB_ID.test(v) ? v : null;
}

/** Id em texto canônico (dígitos, sem zeros à esquerda, > 0) ou null. Aceita número inteiro seguro. */
function idCanonico(v) {
  let s;
  if (typeof v === 'number') s = Number.isSafeInteger(v) && v > 0 ? String(v) : '';
  else if (typeof v === 'string') s = v.trim();
  else return null;
  if (!RE_ID.test(s)) return null;
  s = s.replace(/^0+/, '');
  return s ? s : null;
}

/** Ids do caminho de uma URL de produto da Shopee (já validada como URL). */
function idsDaUrl(u) {
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (!hostDaLista(host, HOSTS_PRODUTO) || hostDaLista(host, ENCURTADORES)) return null;
  const caminho = u.pathname;
  const m = RE_SLUG.exec(caminho) ?? RE_PRODUTO.exec(caminho);
  if (!m) return null;
  const shopId = idCanonico(m[1]);
  const itemId = idCanonico(m[2]);
  if (!shopId || !itemId) return null;
  return { shopId, itemId, urlProduto: `https://shopee.com.br${caminho}` };
}

/** { shopId, itemId, urlProduto } de um link de produto da Shopee, ou null. Sem rede. */
export function extrairIds(url) {
  return idsDaUrl(paraUrl(url));
}

/** Página da Shopee (não o encurtador) que abriu sem levar a um produto: busca, loja, campanha. */
const paginaSemProduto = (u) => hostDaLista(u.hostname, HOSTS_PRODUTO) && !hostDaLista(u.hostname, ENCURTADORES);

/** ID de afiliado do longLink (utm_source=an_<dígitos>) → '<dígitos>' | null | 'varios' (ver o contrato). */
export function afiliadoDoLongLink(url) {
  const u = paraUrl(url);
  if (!u) return null;
  const ids = new Set();
  for (const [k, v] of u.searchParams) {
    if (k.toLowerCase() !== 'utm_source') continue;
    const m = /^an_(\d{1,20})$/i.exec(v.trim());
    if (m) ids.add(m[1]);
  }
  if (ids.size > 1) return 'varios';
  return ids.size ? [...ids][0] : null;
}

// ------------------------------------------------------------------------------------------------ nó

/** Número de um campo que pode vir em texto ("19.90"); vazio, nulo ou booleano → NaN. */
function numero(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim()) return Number(v.trim());
  return Number.NaN;
}
const numeroPositivo = (v) => { const n = numero(v); return Number.isFinite(n) && n > 0 ? n : null; };

/** Oferta a partir de um nó de productOfferV2 (parser tolerante: campo ausente vira null, nunca lança). */
export function ofertaDoNo(no, { shopId, itemId } = {}) {
  const pct = Math.round(numero(no?.priceDiscountRate));
  const vendas = numero(no?.sales);
  const nota = numero(no?.ratingStar);
  const img = no?.imageUrl;
  return {
    key: `SHOPEE:${shopId}.${itemId}`, shopId, itemId,
    title: tituloDeUmaLinha(no?.productName, MAX_TITULO),
    price: numeroPositivo(no?.priceMin),
    oldPrice: null, // a API não traz o preço antigo, e ele não é derivado do percentual
    discountPct: Number.isFinite(pct) && pct >= 1 && pct <= 99 ? pct : 0,
    sold: Number.isFinite(vendas) && vendas >= 0 ? Math.floor(vendas) : null,
    image: typeof img === 'string' && img.length <= MAX_URL && IMAGEM_SHOPEE.test(img) ? img : null,
    freeShipping: false, coupon: null,
    extra: {
      loja_nome: tituloDeUmaLinha(no?.shopName, MAX_LOJA),
      nota: Number.isFinite(nota) && nota >= 0 && nota <= 5 ? Math.round(nota * 10) / 10 : null,
      preco_max: numeroPositivo(no?.priceMax),
    },
  };
}

const copiaOferta = (o) => (o ? { ...o, extra: { ...o.extra } } : null);

// ----------------------------------------------------------------------------------------------- API

function lerJson(texto) {
  try { const o = JSON.parse(texto); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

/** Credenciais da linha 'shopee' de conexoes. Só usado dentro das chamadas; nunca guardado. */
function lerConexaoDoBanco(db) {
  const linha = db?.prepare("SELECT config, segredos FROM conexoes WHERE plataforma = 'shopee'").get();
  const config = lerJson(linha?.config);
  const segredos = lerJson(linha?.segredos);
  return { id_afiliado: config.id_afiliado, app_id: config.app_id, chave: segredos.chave };
}

const texto = (v) => (typeof v === 'string' ? v.trim() : '');

function normalizarConexao(c) {
  const appId = texto(c?.app_id);
  const id = texto(c?.id_afiliado);
  return {
    appId: RE_APP_ID.test(appId) ? appId : '', // vai no cabeçalho: só dígitos
    chave: texto(c?.chave),
    idAfiliado: RE_ID_AFILIADO.test(id) ? id : '',
  };
}

/** Impressão das credenciais (não reversível), para a situação valer só para o mesmo AppID + Senha. */
const impressaoDe = (c) => createHash('sha256').update(`${c.appId}\n${c.chave}`).digest('hex').slice(0, 16);

/** Código de erro da resposta GraphQL: undefined (sem errors[]), null (errors[] sem código legível) ou o número. */
function codigoDoErro(json) {
  const erros = json?.errors;
  if (!Array.isArray(erros) || !erros.length) return undefined;
  const e0 = erros[0];
  const c = e0?.extensions?.code ?? e0?.code;
  if (Number.isInteger(c)) return c;
  if (typeof c === 'string' && /^\d{1,9}$/.test(c.trim())) return Number(c.trim());
  return null;
}

const consultaItem = (shopId, itemId) =>
  `query{productOfferV2(itemId:${itemId},shopId:${shopId},limit:1){nodes{${CAMPOS_NO.join(' ')}}}}`;
const CONSULTA_TESTE = `query{productOfferV2(keyword:"celular",limit:1){nodes{${CAMPOS_NO.join(' ')}}}}`;

/**
 * Cliente da Open API de Afiliados. db: banco aberto (lê a conexão 'shopee'); fetch: injetado nos testes;
 * agora: relógio; lerConexao(): substitui a leitura do banco; cacheLinks: Map do resolvedor (um por instância).
 */
export function createShopee({ db, fetch: f, agora = Date.now, lerConexao, cacheLinks = new Map(), limiteHora = LIMITE_HORA } = {}) {
  const doFetch = (...a) => (f ?? globalThis.fetch)(...a);
  const ler = () => normalizarConexao(lerConexao ? lerConexao() : lerConexaoDoBanco(db));
  const teto = Number.isInteger(limiteHora) && limiteHora > 0 ? limiteHora : LIMITE_HORA;
  const acessos = [];        // instantes dos acessos à Shopee na última hora (API e saltos do resolvedor)
  const linksGerados = new Map(); // '<ID de afiliado>|<shop>.<item>' → { link, ate }

  /** Tira da janela o que passou de 1 h. */
  function podar() {
    const limite = agora() - JANELA_TETO_MS;
    while (acessos.length && acessos[0] <= limite) acessos.shift();
  }
  const tetoAtingido = () => { podar(); return acessos.length >= teto; };
  /** Conta um acesso à Shopee. → false (e não conta) se o teto da hora já foi atingido. */
  function consumirAcesso() {
    if (tetoAtingido()) return false;
    acessos.push(agora());
    return true;
  }
  /** Teto do próprio programa: tipo 'cota' (mesma frase), marcado para não virar situação da conta. */
  const erroTeto = () => Object.assign(new ErroShopee('cota'), { local: true });

  const itens = new Map();   // '<shop>.<item>' → { oferta | null, ate }
  const emVoo = new Map();   // '<shop>.<item>' → promessa da chamada em andamento
  const SEM_VERIFICACAO = Object.freeze({ acesso: 'desconhecido', verificado_em: null, motivo: null, impressao: null });
  let ultima = SEM_VERIFICACAO;

  function registrar(c, acesso, motivo = null) {
    ultima = { acesso, verificado_em: agora(), motivo, impressao: impressaoDe(c) };
  }
  function registrarErro(c, e) {
    if (e instanceof ErroShopee && !e.local && Object.hasOwn(ACESSO_DO_TIPO, e.tipo)) registrar(c, ACESSO_DO_TIPO[e.tipo], e.message);
  }

  /** Uma chamada assinada. → `data` da resposta (objeto) ou ErroShopee. */
  async function chamar(query, c) {
    const corpo = JSON.stringify({ query });
    const ts = String(Math.floor(agora() / 1000));
    const assinatura = createHash('sha256').update(c.appId + ts + corpo + c.chave).digest('hex');
    if (!consumirAcesso()) throw erroTeto();
    let r;
    try {
      r = await doFetch(URL_API, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_API),
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json',
          Authorization: `SHA256 Credential=${c.appId}, Timestamp=${ts}, Signature=${assinatura}`,
        },
        body: corpo,
      });
    } catch { throw new ErroShopee('indisponivel'); }
    const status = Number(r?.status) || 0;
    const { json, recusado } = await lerCorpoLimitado(r, MAX_CORPO);
    if (status === 429) throw new ErroShopee('cota', { status });
    const codigo = codigoDoErro(json);
    if (codigo !== undefined) {
      throw new ErroShopee((codigo != null && TIPO_DO_CODIGO[codigo]) || 'indisponivel', { status, codigoApi: codigo });
    }
    const data = json?.data;
    if (status < 200 || status >= 300 || recusado || !data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ErroShopee('indisponivel', { status });
    }
    return data;
  }

  function exigirApi(c) {
    if (!c.appId || !c.chave) throw new ErroShopee('sem_credenciais');
  }

  async function buscarItem(shopId, itemId) {
    const c = ler();
    try {
      exigirApi(c);
      const data = await chamar(consultaItem(shopId, itemId), c);
      const nos = data.productOfferV2?.nodes;
      if (!Array.isArray(nos)) throw new ErroShopee('indisponivel');
      const no = nos.find((n) => idCanonico(n?.itemId) === itemId);
      const oferta = no ? ofertaDoNo(no, { shopId, itemId }) : null;
      const chave = `${shopId}.${itemId}`;
      itens.delete(chave);
      itens.set(chave, { oferta, ate: agora() + CACHE_ITEM_MS });
      while (itens.size > CACHE_ITEM_MAX) itens.delete(itens.keys().next().value);
      registrar(c, 'ok');
      return oferta;
    } catch (e) {
      const erro = e instanceof ErroShopee ? e : new ErroShopee('indisponivel');
      registrarErro(c, erro);
      throw erro;
    }
  }

  /**
   * Dados de um produto (cache de 15 min). → oferta | null (a API não devolveu esse item).
   * opcoes.fresco === true: não lê o cache (vai à API ou junta-se à chamada em voo); grava o cache como qualquer leitura.
   */
  async function lerItem(shopId, itemId, opcoes) {
    const s = idCanonico(shopId);
    const i = idCanonico(itemId);
    if (!s || !i) return null;
    const chave = `${s}.${i}`;
    const salvo = opcoes?.fresco === true ? null : itens.get(chave);
    if (salvo && salvo.ate > agora()) return copiaOferta(salvo.oferta);
    let p = emVoo.get(chave);
    if (!p) {
      p = buscarItem(s, i);
      emVoo.set(chave, p);
      const limpar = () => { if (emVoo.get(chave) === p) emVoo.delete(chave); };
      p.then(limpar, limpar);
    }
    return copiaOferta(await p);
  }

  /**
   * Link curto de afiliado do produto pela API (generateShortLink). Com `subId` (alfanumérico, RE_SUB_ID) a mutation
   * leva subIds:["<subId>"]; sem ele o corpo é o de sempre. Sub_id que não serve → ErroShopee('link_falhou'), sem rede
   * e sem mexer na situação da conta; a mensagem não traz o valor.
   */
  async function gerarLink(urlProduto, { subId } = {}) {
    const ids = extrairIds(urlProduto);
    if (!ids) throw new LinkShopeeNaoResolvido('invalido');
    const sub = subIdDe(subId);
    if (sub === null) throw new ErroShopee('link_falhou');
    const c = ler();
    try {
      exigirApi(c);
      const extra = sub ? `,subIds:${JSON.stringify([sub])}` : '';
      const data = await chamar(`mutation{generateShortLink(input:{originUrl:${JSON.stringify(ids.urlProduto)}${extra}}){shortLink}}`, c);
      registrar(c, 'ok');
      const link = data.generateShortLink?.shortLink;
      if (typeof link !== 'string' || !LINK_SHOPEE.test(link)) throw new ErroShopee('indisponivel');
      return link;
    } catch (e) {
      const erro = e instanceof ErroShopee ? e : new ErroShopee('indisponivel');
      registrarErro(c, erro);
      throw erro;
    }
  }

  async function testar() {
    const c = ler();
    if (!c.appId || !c.chave) {
      return { ok: false, resultado: 'nao_configurada', mensagem: FRASES_TESTE_SHOPEE.nao_configurada, campos: [] };
    }
    let data;
    try {
      data = await chamar(CONSULTA_TESTE, c);
    } catch (e) {
      const erro = e instanceof ErroShopee ? e : new ErroShopee('indisponivel');
      registrarErro(c, erro);
      const resultado = RESULTADO_DO_TIPO[erro.tipo] ?? 'indisponivel';
      return { ok: false, resultado, mensagem: FRASES_TESTE_SHOPEE[resultado], campos: [] };
    }
    registrar(c, 'ok');
    const nos = data.productOfferV2?.nodes;
    const no = Array.isArray(nos) && nos[0] && typeof nos[0] === 'object' ? nos[0] : null;
    const campos = no ? CAMPOS_NO.filter((k) => no[k] != null && no[k] !== '') : [];
    return { ok: true, resultado: 'ok', mensagem: FRASES_TESTE_SHOPEE.ok, campos };
  }

  function situacao() {
    const c = ler();
    if (!c.appId || !c.chave) return { acesso: 'nao_configurada', verificado_em: null, motivo: MENSAGENS_SHOPEE.sem_credenciais };
    if (ultima.impressao !== impressaoDe(c)) return { acesso: 'desconhecido', verificado_em: null, motivo: null };
    return { acesso: ultima.acesso, verificado_em: ultima.verificado_em, motivo: ultima.motivo };
  }

  function configurado() {
    const c = ler();
    return !!(c.appId && c.chave);
  }

  const apiUtil = () => configurado() && !ACESSO_SEM_API.has(situacao().acesso);

  /** Ao salvar a conexão: esquece a última verificação, o cache de itens e os links de afiliado guardados. */
  function invalidar() {
    ultima = SEM_VERIFICACAO;
    itens.clear();
    linksGerados.clear();
  }

  /**
   * Chave do link guardado: ID de afiliado válido + ids do produto (+ Sub_id, se houver; sem Sub_id a chave é a de
   * sempre). null se algum não serve.
   */
  function chaveDoLink(urlProduto, idAfiliado, subId) {
    const ids = extrairIds(urlProduto);
    const id = texto(idAfiliado);
    const sub = subIdDe(subId);
    if (!ids || !RE_ID_AFILIADO.test(id) || sub === null) return null;
    return `${id}|${ids.shopId}.${ids.itemId}${sub ? `|${sub}` : ''}`;
  }

  /** shortLink já gerado para este produto, este ID de afiliado e este Sub_id (até 7 dias), ou null. */
  function linkGuardado(urlProduto, idAfiliado, subId = '') {
    const chave = chaveDoLink(urlProduto, idAfiliado, subId);
    const salvo = chave ? linksGerados.get(chave) : null;
    if (!salvo) return null;
    if (salvo.ate <= agora()) { linksGerados.delete(chave); return null; }
    return salvo.link;
  }

  /** Guarda o shortLink do produto para este ID de afiliado (e Sub_id) por 7 dias. → true se guardou. */
  function guardarLink(urlProduto, idAfiliado, link, subId = '') {
    const chave = chaveDoLink(urlProduto, idAfiliado, subId);
    if (!chave || typeof link !== 'string' || !LINK_SHOPEE.test(link)) return false;
    linksGerados.delete(chave);
    linksGerados.set(chave, { link, ate: agora() + CACHE_LINK_AFILIADO_MS });
    while (linksGerados.size > CACHE_LINK_AFILIADO_MAX) linksGerados.delete(linksGerados.keys().next().value);
    return true;
  }

  async function resolver(url) {
    let barrado = false;
    // cada salto do resolvedor conta no teto; o que vem do cache de links não passa por aqui
    const fetchContado = (...a) => {
      if (!consumirAcesso()) { barrado = true; return Promise.reject(new Error('teto')); }
      return doFetch(...a);
    };
    try {
      const { valor } = await resolverPorRedirecionamento(url, {
        hosts: HOSTS_SHOPEE, extrair: idsDaUrl, paginaSemValor: paginaSemProduto, fetch: fetchContado, cache: cacheLinks, agora,
      });
      return valor;
    } catch (e) {
      // pedido simultâneo pelo mesmo link divide o caminho de rede: o teto pode ter barrado o salto do outro chamador
      if (barrado || (e?.causa !== 'nao_produto' && tetoAtingido())) throw erroTeto();
      throw new LinkShopeeNaoResolvido(e?.causa);
    }
  }

  return { resolver, lerItem, gerarLink, testar, situacao, configurado, apiUtil, invalidar, linkGuardado, guardarLink };
}
