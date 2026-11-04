// Tudo o que fala com a Amazon (plano espelhamento-amazon, etapa 3; ADR-002). Sem raspar HTML.
//
// Contrato do módulo (a ligação com lojas.js/conexoes.js/envios.js é da etapa 7 em diante):
//
// - extrairAsin(url) → 'B0…' (maiúsculas) | null. Sem rede. Só lê caminhos de amazon.com.br/amazon.com
//   (/dp/, /<slug>/dp/, /gp/product/, /gp/aw/d/, /exec/obidos/ASIN/, ?asin=). O código de um encurtador
//   (link.amazon, amzn.to, amzn.com, a.co) NUNCA é tratado como ASIN.
// - resolverLink(url, { fetch, cache?, agora? }) → { asin, urlFinal }. URL que já traz o ASIN volta sem rede.
//   Senão segue até 5 saltos, só com GET (o HEAD dá 404 no link.amazon), redirect:'manual', corpo cancelado
//   sem leitura, timeout de 8 s, e só enquanto o host está em HOSTS_AMAZON, sempre em https e sem porta.
//   Exceção: SALTOS_AMAZON (amzlinks.in, para onde o link.amazon redireciona) é aceito só como salto
//   intermediário e só no host exato, sem subdomínio (hostsDeSalto de src/rede.js): colado direto é 'invalido' sem
//   rede e nunca dá o ASIN.
//   urlFinal é origem + caminho, sem query: a tag de terceiro e o rastreio (crid, dib, sr, qid, linkId,
//   ascsubtag…) são descartados. Falha → LinkNaoResolvido { codigo/causa: 'invalido' | 'nao_produto' }.
//   Cache (Map passado em `cache`; null desliga): sucesso e 'nao_produto' por 1 h; 'invalido' depois de tentar a
//   rede por 10 min (cache negativo curto), menos a falha passageira (rede caiu, timeout ou 5xx da Amazon), que
//   não fica em cache: a próxima chamada tenta de novo. Pedidos simultâneos pela mesma URL com o mesmo cache
//   dividem um só caminho de rede. Assim um membro hostil que repete o mesmo link não multiplica GETs; o teto por grupo/hora
//   é da etapa 11.
//   O User-Agent de navegador serve só para o encurtador devolver o 3xx com Location: o resolvedor lê apenas
//   o status e o Location, nunca o corpo. Antes de chamar a rede, a etapa 11 deve tentar o ASIN em
//   canonicalUrl/matchedText da prévia do WhatsApp (extrairAsin), e só resolver se não houver.
// - createAmazon({ db, fetch, agora, esperar, lerConexao, cacheLinks = new Map() }) →
//   { lerItem(asin), lerItens(asins), montarLink(asin), resolver(url), testar(), situacao(), configurado(),
//     invalidarToken() }
//   - Credenciais lidas a cada chamada: por padrão da linha 'amazon' de `conexoes` (config.tag,
//     config.credencial_versao, segredos.credencial_id, segredos.credencial_secret). A etapa 7 pode injetar
//     `lerConexao` (ex.: segredosDe de conexoes.js). Nada disso fica em variável de módulo.
//   - lerItens(asins) → { [ASIN]: oferta | null }; oferta = { key:'ASIN:<asin>', asin, title, price, oldPrice,
//     discountPct, image, sold:null, freeShipping:false, coupon:null, disponivel }. O detailPageURL da API
//     não é usado: o link é sempre montarLink(asin). Falha → ErroAmazon { codigo/tipo }.
//     `discountPct: 0` e `freeShipping: false` significam "não veio" (a API não informa frete e o desconto pode
//     faltar), não "sem desconto"/"sem frete grátis". Na fusão campo a campo da etapa 11 (API × texto da
//     mensagem), use `||` para esses dois (`api.discountPct || doTexto.discountPct`), não `??`.
//     Pedidos simultâneos do mesmo ASIN dividem um só GetItems (promessa em voo por ASIN).
//   - montarLink(asin) → 'https://www.amazon.com.br/dp/<ASIN>?tag=<tag>'; sem tag → ErroAmazon('sem_tag');
//     ASIN inválido → LinkNaoResolvido('invalido').
//   - resolver(url) = resolverLink com o fetch, o relógio e o cache de links desta instância (`cacheLinks`;
//     cada instância tem o seu, nunca o do módulo).
//   - 404 ResourceNotFound do GetItems = todos os itens null (a chamada foi autorizada); outro 404 → 'nao_encontrado'.
//   - testar() → { ok, resultado: 'ok'|'nao_configurada'|'recusada'|'sem_acesso'|'tag_invalida'|'indisponivel',
//     mensagem, campos } (frases da spec; nunca o ID, o segredo nem o token).
//   - situacao() → { acesso: 'nao_configurada'|'desconhecido'|'ok'|'sem_acesso'|'credenciais_invalidas'|
//     'tag_invalida'|'cota'|'indisponivel', verificado_em, motivo }.
//   - configurado() → true quando há tag + ID + segredo (dá para chamar a API).
//   - invalidarToken(): chamar ao salvar a conexão (etapa 7). Esquece o token e a última verificação
//     (situacao() volta a 'desconhecido'). A situação também vale só para a mesma versão + ID + segredo + tag.
//   - Token e GetItems usam redirect:'error' (o segredo e o Bearer nunca seguem um 307/308) e leem o corpo em
//     stream até 2 MiB (content-length acima disso é recusado sem ler).
//
// Segurança: o token só vive na closure de createAmazon; as mensagens de erro são fixas por tipo (nunca corpo
// de resposta, URL, ID, segredo ou token); o módulo não escreve no console. Hosts de rede fixos: o do token
// (por versão da credencial), o do GetItems e os de HOSTS_AMAZON (mais SALTOS_AMAZON, só como salto) no resolvedor.
//
// O resolvedor (saltos, https, porta, timeout, User-Agent, cache e junção de pedidos) e o leitor de corpo com teto
// são os de src/rede.js (plano integracao-shopee, etapa 5): aqui ficam só o que é da Amazon (hosts, ASIN, frases).

import { createHash } from 'node:crypto';
import { discountPct } from './template.js';
import { tituloDeUmaLinha } from './titulo.js';
import { resolverPorRedirecionamento, lerCorpoLimitado, FalhaDeLink, paraUrl, hostDaLista, MAX_URL } from './rede.js';

export const HOSTS_AMAZON = Object.freeze(['link.amazon', 'amzn.to', 'amzn.com', 'a.co', 'amazon.com.br', 'amazon.com']);
// Redirecionador de terceiro (Button, não Amazon) no meio da cadeia (link.amazon → amzlinks.in → amazon.com.br).
// Só como salto e só o host exato: subdomínio de terceiro não é aceito (src/rede.js compara por igualdade).
const SALTOS_AMAZON = Object.freeze(['amzlinks.in']);
const HOSTS_PRODUTO = ['amazon.com.br', 'amazon.com']; // onde o caminho pode trazer o ASIN
// Só subdomínios (m.media-amazon.com, images-na.ssl-images-amazon.com): o domínio raiz fica fora porque a CSP do
// painel (src/server.js) libera só https://*.media-amazon.com e afins, e a foto não apareceria na prévia.
export const IMAGEM_AMAZON = /^https:\/\/([\w-]+\.)+(media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com)\//i;

export const MARKETPLACE = 'www.amazon.com.br';
export const URL_GET_ITEMS = 'https://creatorsapi.amazon/catalog/v1/getItems';
/** Endpoint do token pela versão da credencial (3.1 = NA, a do Brasil). */
export const URL_TOKEN = Object.freeze({
  3.1: 'https://api.amazon.com/auth/o2/token',
  3.2: 'https://api.amazon.co.uk/auth/o2/token',
  3.3: 'https://api.amazon.co.jp/auth/o2/token',
});
export const RECURSOS = Object.freeze(['itemInfo.title', 'images.primary.large', 'offersV2.listings.price',
  'offersV2.listings.availability', 'offersV2.listings.condition', 'offersV2.listings.isBuyBoxWinner']);
/** ASIN usado pelo testar() (o da referência do dono). 404 dele também prova o acesso. */
export const ASIN_TESTE = 'B0FG2MD49G';

const TIMEOUT_API = 15000;
const INTERVALO_API = 1000;            // 1 chamada/s (cota de credencial nova)
const LOTE = 10;                       // ASINs por GetItems
const CACHE_ITEM_MS = 15 * 60 * 1000;
const CACHE_ITEM_MAX = 1000;
const MAX_CORPO = 2 * 1024 * 1024;
const RE_ASIN = /^[A-Z0-9]{10}$/;
const RE_TAG = /^[A-Za-z0-9_-]{2,64}$/;
const RE_VERSAO = /^3\.[1-3]$/;

// ---------------------------------------------------------------------------------------------- erros

const MENSAGENS_LINK = {
  invalido: 'Não consegui abrir este link da Amazon.',
  nao_produto: 'Este link da Amazon não leva a um produto.',
};

/** Link que não chegou a um ASIN. Mensagem fixa: nunca a URL. */
export class LinkNaoResolvido extends Error {
  constructor(causa) {
    super(MENSAGENS_LINK[causa] ?? MENSAGENS_LINK.invalido);
    this.name = 'LinkNaoResolvido';
    this.causa = MENSAGENS_LINK[causa] ? causa : 'invalido';
    this.codigo = this.causa;
  }
}

export const MENSAGENS_AMAZON = Object.freeze({
  sem_credenciais: 'A API da Amazon não está configurada. Configure em Conexões ou preencha à mão.',
  sem_tag: 'Falta a tag de associado da Amazon em Conexões.',
  credenciais_invalidas: 'A Amazon não aceitou a credencial. Confira o ID e o segredo e se a credencial está ativa.',
  sem_acesso: 'A credencial é válida, mas a conta ainda não tem acesso à API. Confira se há vendas qualificadas nos últimos 30 dias.',
  tag_invalida: 'A tag não pertence a esta credencial/loja.',
  cota: 'A Amazon limitou as consultas por agora. Tente de novo em alguns minutos.',
  nao_encontrado: 'A Amazon não encontrou este produto.',
  indisponivel: 'A Amazon não respondeu agora. Tente de novo em alguns minutos.',
});

/** Erro da API. `codigo` (= `tipo`) estável; mensagem fixa por tipo; nunca carrega corpo, URL, ID, segredo ou token. */
export class ErroAmazon extends Error {
  constructor(tipo, { status = null, retryAfterSeconds = null } = {}) {
    const t = Object.hasOwn(MENSAGENS_AMAZON, tipo) ? tipo : 'indisponivel';
    super(MENSAGENS_AMAZON[t]);
    this.name = 'ErroAmazon';
    this.tipo = t;
    this.codigo = t;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ------------------------------------------------------------------------------------------ ASIN e link

const RE_CAMINHOS = [
  /(?:^|\/)dp\/([A-Z0-9]{10})(?=\/|$)/i,              // /dp/<ASIN> e /<slug>/dp/<ASIN>
  /(?:^|\/)gp\/product\/([A-Z0-9]{10})(?=\/|$)/i,
  /(?:^|\/)gp\/aw\/d\/([A-Z0-9]{10})(?=\/|$)/i,
  /(?:^|\/)exec\/obidos\/ASIN\/([A-Z0-9]{10})(?=\/|$)/i,
];

function asinDaUrl(u) {
  if (!u || !hostDaLista(u.hostname, HOSTS_PRODUTO)) return null;
  for (const re of RE_CAMINHOS) {
    const m = re.exec(u.pathname);
    if (m) return m[1].toUpperCase();
  }
  for (const [k, v] of u.searchParams) {
    if (k.toLowerCase() === 'asin' && /^[A-Z0-9]{10}$/i.test(v)) return v.toUpperCase();
  }
  return null;
}

/** ASIN (10 caracteres, maiúsculas) de um link de produto da Amazon, ou null. Sem rede. */
export function extrairAsin(url) {
  return asinDaUrl(paraUrl(url));
}

const CACHE_LINKS = new Map(); // url de entrada → resultado ou causa (só para quem chama resolverLink direto)

/** Página de uma loja da Amazon (2xx) sem ASIN: busca, lista ou loja → 'nao_produto'. */
const paginaDaLoja = (u) => hostDaLista(u.hostname, HOSTS_PRODUTO);

/**
 * Resolve um link da Amazon (inclusive encurtador) até o ASIN, sem ler página (resolverPorRedirecionamento de
 * src/rede.js com HOSTS_AMAZON e SALTOS_AMAZON como salto). opts.fetch: fetch injetado (padrão: o global, na hora da chamada); opts.cache: Map
 * (padrão: o do módulo; null desliga o cache e a junção de pedidos simultâneos); opts.agora: relógio.
 */
export async function resolverLink(url, { fetch: f, cache = CACHE_LINKS, agora = Date.now } = {}) {
  try {
    const { valor, urlFinal } = await resolverPorRedirecionamento(url, {
      hosts: HOSTS_AMAZON, hostsDeSalto: SALTOS_AMAZON, extrair: asinDaUrl, paginaSemValor: paginaDaLoja, fetch: f, cache, agora,
    });
    return { asin: valor, urlFinal };
  } catch (e) {
    throw new LinkNaoResolvido(e instanceof FalhaDeLink ? e.causa : 'invalido'); // frases da Amazon, nunca a URL
  }
}

// ------------------------------------------------------------------------------------------------ API

const numeroPositivo = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

// Mesmo teto do título no painel (maxlength) e em src/envios.js (MAX_TITULO): título maior aqui sairia como 'manual' sem o dono mexer.
const MAX_TITULO = 200;

/** Oferta a partir de um item do GetItems (parser tolerante: campo ausente vira null, nunca lança). */
export function ofertaDoItem(item) {
  const asin = String(item?.asin ?? '').toUpperCase();
  const listings = Array.isArray(item?.offersV2?.listings) ? item.offersV2.listings : [];
  const listing = listings.find((l) => l?.isBuyBoxWinner === true) ?? listings[0] ?? null;
  const preco = listing?.price ?? null;
  const price = numeroPositivo(preco?.money?.amount);
  const base = numeroPositivo(preco?.savingBasis?.money?.amount);
  const oldPrice = price != null && base != null && base > price ? base : null;
  const pct = Number(preco?.savings?.percentage);
  const titulo = item?.itemInfo?.title?.displayValue;
  const imagem = item?.images?.primary?.large?.url;
  const tipoDisp = listing?.availability?.type;
  return {
    key: `ASIN:${asin}`, asin,
    title: tituloDeUmaLinha(titulo, MAX_TITULO),
    price, oldPrice,
    discountPct: Number.isFinite(pct) && pct > 0 && pct < 100 ? Math.round(pct) : discountPct(price, oldPrice),
    image: typeof imagem === 'string' && imagem.length <= MAX_URL && IMAGEM_AMAZON.test(imagem) ? imagem : null,
    sold: null, freeShipping: false, coupon: null,
    disponivel: typeof tipoDisp === 'string' ? tipoDisp.toUpperCase() === 'IN_STOCK' : null,
  };
}

function lerJson(texto) {
  try { const o = JSON.parse(texto); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

/** Credenciais da linha 'amazon' de conexoes. Só usado dentro das chamadas; nunca guardado. */
function lerConexaoDoBanco(db) {
  const linha = db?.prepare("SELECT config, segredos FROM conexoes WHERE plataforma = 'amazon'").get();
  const config = lerJson(linha?.config);
  const segredos = lerJson(linha?.segredos);
  return {
    tag: config.tag ?? segredos.tag, // a tag é texto (decisão do lead de 02/11); aceita segredo por compatibilidade
    credencial_versao: config.credencial_versao,
    credencial_id: segredos.credencial_id,
    credencial_secret: segredos.credencial_secret,
  };
}

const texto = (v) => (typeof v === 'string' ? v.trim() : '');

function normalizarConexao(c) {
  const tag = texto(c?.tag);
  const versao = texto(c?.credencial_versao);
  return {
    tag: RE_TAG.test(tag) ? tag : '',
    id: texto(c?.credencial_id),
    secret: texto(c?.credencial_secret),
    versao: RE_VERSAO.test(versao) ? versao : '3.1',
  };
}

/**
 * Impressão das credenciais. Não reversível. A do token não leva a tag (o token não depende dela); a da
 * situação leva, porque 'tag_invalida' e 'ok' dependem da tag.
 */
const impressaoDe = (c, { comTag = false } = {}) => createHash('sha256')
  .update(`${c.versao}\n${c.id}\n${c.secret}${comTag ? `\n${c.tag}` : ''}`).digest('hex').slice(0, 16);
const impressaoSituacao = (c) => impressaoDe(c, { comTag: true });

function segundosDeEspera(r, corpo) {
  const h = Number.parseInt(r?.headers?.get?.('retry-after') ?? '', 10);
  const b = Number(corpo?.retryAfterSeconds);
  const s = Number.isFinite(h) && h >= 0 ? h : Number.isFinite(b) && b >= 0 ? Math.round(b) : null;
  return s == null ? null : Math.min(s, 3600);
}

/** Corpo da resposta com teto de MAX_CORPO bytes (lerCorpoLimitado de src/rede.js). */
const lerCorpo = (r) => lerCorpoLimitado(r, MAX_CORPO);

const ACESSO_DO_TIPO = {
  sem_credenciais: 'nao_configurada', sem_tag: 'nao_configurada', credenciais_invalidas: 'credenciais_invalidas',
  sem_acesso: 'sem_acesso', tag_invalida: 'tag_invalida', cota: 'cota', nao_encontrado: 'indisponivel', indisponivel: 'indisponivel',
};
const RESULTADO_DO_TIPO = {
  credenciais_invalidas: 'recusada', sem_acesso: 'sem_acesso', tag_invalida: 'tag_invalida',
  cota: 'indisponivel', indisponivel: 'indisponivel', nao_encontrado: 'indisponivel',
};

/**
 * Cliente da Creators API. db: banco aberto (lê a conexão 'amazon'); fetch: injetado nos testes;
 * agora: relógio; esperar(ms): pausa do limite de 1 chamada/s; lerConexao(): substitui a leitura do banco.
 */
export function createAmazon({ db, fetch: f, agora = Date.now, esperar, lerConexao, cacheLinks = new Map() } = {}) {
  const doFetch = (...a) => (f ?? globalThis.fetch)(...a);
  const pausa = esperar ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  const ler = () => normalizarConexao(lerConexao ? lerConexao() : lerConexaoDoBanco(db));

  let tokenCache = null;   // { impressao, valor, ate }
  let tokenEmVoo = null;   // { impressao, promessa }
  const itens = new Map(); // ASIN → { oferta | null, ate }
  const itensEmVoo = new Map(); // ASIN → promessa de { ASIN: oferta | null } do GetItems em andamento
  const SEM_VERIFICACAO = Object.freeze({ acesso: 'desconhecido', verificado_em: null, motivo: null, impressao: null });
  let ultima = SEM_VERIFICACAO;
  let ultimaChamada = -Infinity;
  let filaApi = Promise.resolve();

  function registrar(c, acesso, motivo = null) {
    ultima = { acesso, verificado_em: agora(), motivo, impressao: impressaoSituacao(c) };
  }
  function registrarErro(c, e) {
    if (e instanceof ErroAmazon) registrar(c, ACESSO_DO_TIPO[e.tipo] ?? 'indisponivel', e.message);
  }

  function esquecerToken() { tokenCache = null; tokenEmVoo = null; }
  /** Ao salvar a conexão: esquece o token e a última verificação. */
  function invalidarToken() { esquecerToken(); ultima = SEM_VERIFICACAO; }

  async function pedirToken(c) {
    let r;
    try {
      r = await doFetch(URL_TOKEN[c.versao], {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_API),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret, scope: 'creatorsapi::default' }),
      });
    } catch { throw new ErroAmazon('indisponivel'); }
    const { json } = await lerCorpo(r);
    const status = Number(r?.status) || 0;
    if (status === 429) throw new ErroAmazon('cota', { status, retryAfterSeconds: segundosDeEspera(r, json) });
    if (status === 400 || status === 401 || status === 403) throw new ErroAmazon('credenciais_invalidas', { status });
    if (status < 200 || status >= 300) throw new ErroAmazon('indisponivel', { status });
    const valor = typeof json?.access_token === 'string' ? json.access_token : '';
    if (!valor) throw new ErroAmazon('indisponivel', { status });
    const expira = Number(json.expires_in);
    const segundos = Number.isFinite(expira) && expira > 0 ? expira : 3600;
    return { valor, ate: agora() + Math.max(0, segundos - 60) * 1000 };
  }

  /** Token em cache para estas credenciais, ou um novo (um pedido por vez). */
  async function token(c) {
    const impressao = impressaoDe(c);
    if (tokenCache && tokenCache.impressao === impressao && tokenCache.ate > agora()) return tokenCache.valor;
    if (!tokenEmVoo || tokenEmVoo.impressao !== impressao) {
      const promessa = pedirToken(c).then((t) => {
        if (tokenEmVoo?.promessa === promessa) { tokenCache = { impressao, ...t }; tokenEmVoo = null; }
        return t.valor;
      }, (e) => { if (tokenEmVoo?.promessa === promessa) tokenEmVoo = null; throw e; });
      tokenEmVoo = { impressao, promessa };
    }
    return tokenEmVoo.promessa;
  }

  /** Executa fn respeitando 1 chamada/s ao GetItems (fila interna). */
  function naVez(fn) {
    const p = filaApi.then(async () => {
      const falta = ultimaChamada + INTERVALO_API - agora();
      if (falta > 0) await pausa(falta);
      ultimaChamada = agora();
      return fn();
    });
    filaApi = p.catch(() => {});
    return p;
  }

  async function chamarGetItems(asins, c, bearer) {
    let r;
    try {
      r = await doFetch(URL_GET_ITEMS, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_API),
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE },
        body: JSON.stringify({
          itemIds: asins, itemIdType: 'ASIN', marketplace: MARKETPLACE, partnerTag: c.tag,
          languagesOfPreference: ['pt_BR'], condition: 'New', resources: [...RECURSOS],
        }),
      });
    } catch { throw new ErroAmazon('indisponivel'); }
    const { texto: corpoTexto, json, recusado } = await lerCorpo(r);
    return { status: Number(r?.status) || 0, r, corpoTexto, json, recusado };
  }

  /** Um GetItems (≤ 10 ASINs), com nova tentativa única em 401 (token vencido). → { ASIN: oferta|null } */
  async function consultar(asins, c) {
    let resp;
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const bearer = await token(c);
      resp = await naVez(() => chamarGetItems(asins, c, bearer));
      if (resp.status !== 401) break;
      esquecerToken();
    }
    const { status, r, corpoTexto, json, recusado } = resp;
    const resultado = Object.fromEntries(asins.map((a) => [a, null]));
    if (status === 200 && recusado) throw new ErroAmazon('indisponivel', { status }); // corpo grande demais ou ilegível
    if (status === 200) {
      const lista = Array.isArray(json?.itemsResult?.items) ? json.itemsResult.items : [];
      for (const item of lista) {
        const asin = String(item?.asin ?? '').toUpperCase();
        if (Object.hasOwn(resultado, asin)) resultado[asin] = ofertaDoItem(item);
      }
      return resultado; // ASIN em errors[] ou fora de items → null
    }
    if (status === 404 && /ResourceNotFound|ItemNotAccessible|InvalidParameterValue/i.test(corpoTexto)) return resultado;
    if (status === 401) throw new ErroAmazon('credenciais_invalidas', { status });
    if (status === 403) throw new ErroAmazon('sem_acesso', { status });
    if (status === 400) {
      throw new ErroAmazon(/InvalidPartnerTag|InvalidAssociate/i.test(corpoTexto) ? 'tag_invalida' : 'indisponivel', { status });
    }
    if (status === 404) throw new ErroAmazon('nao_encontrado', { status });
    if (status === 429) throw new ErroAmazon('cota', { status, retryAfterSeconds: segundosDeEspera(r, json) });
    throw new ErroAmazon('indisponivel', { status });
  }

  function exigirApi(c) {
    if (!c.id || !c.secret) throw new ErroAmazon('sem_credenciais');
    if (!c.tag) throw new ErroAmazon('sem_tag');
  }

  /** Dados de vários ASINs (lotes de 10, cache de 15 min). → { ASIN: oferta | null } */
  async function lerItens(asins) {
    const pedidos = [...new Set((Array.isArray(asins) ? asins : [])
      .map((a) => (typeof a === 'string' ? a.trim().toUpperCase() : '')).filter((a) => RE_ASIN.test(a)))];
    const saida = {};
    const faltam = [];
    const esperando = new Map(); // ASIN → promessa já em voo (de outro chamador)
    for (const a of pedidos) {
      const s = itens.get(a);
      if (s && s.ate > agora()) saida[a] = s.oferta ? { ...s.oferta } : null;
      else if (itensEmVoo.has(a)) esperando.set(a, itensEmVoo.get(a));
      else faltam.push(a);
    }
    if (!faltam.length && !esperando.size) return saida;

    let propria = null;
    if (faltam.length) {
      propria = buscarItens(faltam);
      for (const a of faltam) itensEmVoo.set(a, propria);
      const limpar = () => { for (const a of faltam) if (itensEmVoo.get(a) === propria) itensEmVoo.delete(a); };
      propria.then(limpar, limpar);
    }
    // Espera todas antes de copiar, para nenhuma rejeição ficar sem tratamento.
    const resultados = await Promise.allSettled([propria, ...esperando.values()].filter(Boolean));
    const falha = resultados.find((r) => r.status === 'rejected');
    if (falha) throw falha.reason;
    const copiar = (res, a) => (res[a] ? { ...res[a] } : null);
    if (propria) { const res = await propria; for (const a of faltam) saida[a] = copiar(res, a); }
    for (const [a, p] of esperando) saida[a] = copiar(await p, a);
    return saida;
  }

  /** GetItems dos ASINs (lotes de 10), gravando o cache de itens. → { ASIN: oferta | null } (compartilhado). */
  async function buscarItens(faltam) {
    const res = {};
    const c = ler();
    try {
      exigirApi(c);
      for (let i = 0; i < faltam.length; i += LOTE) {
        const lote = faltam.slice(i, i + LOTE);
        const parcial = await consultar(lote, c);
        for (const a of lote) {
          itens.delete(a);
          itens.set(a, { oferta: parcial[a], ate: agora() + CACHE_ITEM_MS });
          res[a] = parcial[a];
        }
        while (itens.size > CACHE_ITEM_MAX) itens.delete(itens.keys().next().value);
      }
      registrar(c, 'ok');
    } catch (e) {
      registrarErro(c, e);
      throw e;
    }
    return res;
  }

  async function lerItem(asin) {
    const a = typeof asin === 'string' ? asin.trim().toUpperCase() : '';
    if (!RE_ASIN.test(a)) return null;
    return (await lerItens([a]))[a] ?? null;
  }

  function montarLink(asin) {
    const a = typeof asin === 'string' ? asin.trim().toUpperCase() : '';
    if (!RE_ASIN.test(a)) throw new LinkNaoResolvido('invalido');
    const { tag } = ler();
    if (!tag) throw new ErroAmazon('sem_tag');
    return `https://www.amazon.com.br/dp/${a}?tag=${tag}`;
  }

  const MSG_OK = 'Credencial aceita pela Amazon.';

  async function testar() {
    const c = ler();
    if (!c.id || !c.secret) {
      return { ok: false, resultado: 'nao_configurada', mensagem: 'Preencha o ID e o segredo da credencial e salve antes de testar.', campos: [] };
    }
    const falha = (e) => {
      const erro = e instanceof ErroAmazon ? e : new ErroAmazon('indisponivel');
      registrarErro(c, erro);
      const resultado = RESULTADO_DO_TIPO[erro.tipo] ?? 'indisponivel';
      const mensagem = resultado === 'indisponivel' ? MENSAGENS_AMAZON.indisponivel : erro.message;
      return { ok: false, resultado, mensagem, campos: [] };
    };
    esquecerToken();
    try { await token(c); } catch (e) { return falha(e); }
    if (!c.tag) {
      ultima = { acesso: 'desconhecido', verificado_em: agora(), motivo: null, impressao: impressaoSituacao(c) };
      return { ok: true, resultado: 'ok', mensagem: `${MSG_OK} Cadastre a tag de associado para conferir o acesso à API.`, campos: [] };
    }
    try {
      const res = await consultar([ASIN_TESTE], c);
      registrar(c, 'ok');
      const oferta = res[ASIN_TESTE];
      const campos = oferta ? ['title', 'price', 'oldPrice', 'discountPct', 'image'].filter((k) => oferta[k] != null && oferta[k] !== 0) : [];
      return { ok: true, resultado: 'ok', mensagem: MSG_OK, campos };
    } catch (e) { return falha(e); }
  }

  function situacao() {
    const c = ler();
    if (!c.id || !c.secret) return { acesso: 'nao_configurada', verificado_em: null, motivo: MENSAGENS_AMAZON.sem_credenciais };
    if (ultima.impressao !== impressaoSituacao(c)) return { acesso: 'desconhecido', verificado_em: null, motivo: null };
    return { acesso: ultima.acesso, verificado_em: ultima.verificado_em, motivo: ultima.motivo };
  }

  function configurado() {
    const c = ler();
    return !!(c.tag && c.id && c.secret);
  }

  const resolver = (url) => resolverLink(url, { fetch: doFetch, agora, cache: cacheLinks });

  return { lerItem, lerItens, montarLink, resolver, testar, situacao, configurado, invalidarToken };
}
