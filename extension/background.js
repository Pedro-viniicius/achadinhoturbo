// Conector da Central de Afiliados (achadinhoturbo): busca pedidos no painel (que roda no seu computador) e
// os executa de dentro de uma aba da Central de Afiliados do Mercado Livre ou do portal de afiliados da Shopee,
// com a sua sessão. Quatro pedidos: gerar link meli.la com a etiqueta, buscar a lista "Produtos selecionados para
// você", gerar o link de afiliado da Shopee (s.shopee.com.br, pelo "Link personalizado" do portal) e ler o preço e o
// estoque de um produto do Mercado Livre (produto_ml: um fetch daqui, sem aba, e só o JSON-LD resumido volta).
// Só os links, a lista e esse resumo voltam para o painel. Cookies e tokens ficam no navegador, e nada disso vai
// para o console.

const PADRAO = { servidor: 'http://127.0.0.1:3737', token: '' };
const ML = 'https://www.mercadolivre.com.br';
const CENTRAL = `${ML}/afiliados/hub?is_affiliate=true`;
const API_LINK = '/affiliate-program/api/v2/affiliates/createLink';
const API_LISTA = '/affiliate-program/api/hub/search?is_affiliate=true&device=desktop';
// Tempos limite. Dentro da aba, cada chamada à Central tem 15 s e cada chamada ao portal da Shopee, 20 s (fixos em
// chamarCentral e em chamarPortalShopee, que são injetadas e não enxergam as constantes daqui). ESPERA_ABA é quanto a
// aba da Central tem para devolver o resultado (acima dos 15 s do fetch). O teto vale para o pedido inteiro e fica
// abaixo do prazo do servidor (src/links.js): 45 s para o link do ML (requestLink), 90 s para o da Shopee
// (requestLinkShopee) e 60 s para a lista de ofertas (requestOffers). Com a aba presa, o laço responde ao painel e
// volta ao poll em vez de travar.
const ESPERA_ABA = 20000;
const TETO_PEDIDO = 40000; // link do ML: abaixo dos 45 s de requestLink
const TETO_SHOPEE = 80000; // link da Shopee: abaixo dos 90 s de requestLinkShopee
const TETO_OFERTAS = 55000; // abaixo dos 60 s de requestOffers em src/links.js
const ESPERA_CARREGAR = 15000; // a aba que abre ou recarrega tem até isso para terminar de carregar
// Leitura de produto (produto_ml): o fetch da página tem 12 s (corpo incluído) e o pedido inteiro, 15 s, abaixo dos
// 18 s de requestProduto em src/links.js. O estouro não marca centralTravada: a aba da Central não entra nesse pedido.
const TEMPO_PRODUTO = 12000;
const TETO_PRODUTO = 15000;
// Recursos que o poll anuncia ao painel (cabeçalho x-recursos): sem `produto_ml`, o servidor não manda esse pedido.
const RECURSOS = 'produto_ml';
const CENTRAL_SEM_RESPOSTA = 'a Central de Afiliados do Mercado Livre não respondeu a tempo. A extensão recarrega a aba e tenta de novo no próximo pedido';
const SHOPEE_SEM_RESPOSTA = 'o portal de afiliados da Shopee não respondeu a tempo. A extensão recarrega a aba e tenta de novo no próximo pedido';
const PRODUTO_SEM_RESPOSTA = 'a página do produto no Mercado Livre não respondeu a tempo';
const CENTRAL_NAO_ABRIU = 'não consegui abrir a Central de Afiliados';
const CENTRAL_SEM_SESSAO = 'não há sessão de afiliado neste Chrome. Entre na sua conta da Central de Afiliados do Mercado Livre';
// Versão desta extensão (manifest.json), mandada no poll (x-versao): o painel avisa quando a extensão está desatualizada.
const VERSAO = (() => { try { return String(chrome.runtime.getManifest?.()?.version || ''); } catch { return ''; } })();
const MAX_ERRO_REAL = 160;
let rodando = false;
let centralTravada = false; // uma chamada à Central ficou sem resposta: recarrega a aba antes da próxima
let shopeeTravada = false; // o mesmo para a aba do portal da Shopee

async function cfg() {
  const { conf } = await chrome.storage.local.get('conf');
  return { ...PADRAO, ...(conf || {}) };
}
async function status(p) {
  const { st = {} } = await chrome.storage.local.get('st');
  await chrome.storage.local.set({ st: { ...st, ...p } });
}

/**
 * Texto de diagnóstico que veio do Chrome ou do fetch (só `e.message`, nunca cabeçalho, corpo, token ou cookie): sem
 * caracteres de controle, cada endereço reduzido à origem (caminho e query podem levar dados) e cortado em
 * MAX_ERRO_REAL caracteres. Vazio quando não há texto.
 */
function erroReal(v) {
  const bruto = typeof v === 'string' ? v : typeof v?.message === 'string' ? v.message : '';
  const t = bruto
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (u) => {
      try { const o = new URL(u).origin; return o && o !== 'null' ? o : 'endereço'; } catch { return 'endereço'; }
    })
    .replace(/\s+/g, ' ').trim();
  return t.length > MAX_ERRO_REAL ? `${t.slice(0, MAX_ERRO_REAL - 1)}…` : t;
}

/**
 * Erro de um pedido à Central, com o `tipo` que vai ao painel (recusa | sessao | sem_resposta | aba | http | formato)
 * e, quando houver, o erro real entre aspas depois da nossa frase.
 */
function erroCentral(tipo, frase, real) {
  const r = erroReal(real);
  return Object.assign(new Error(r ? `${frase}: “${r}”` : frase), { tipo });
}

/**
 * Roda DENTRO da aba da Central (mesma origem, com a sessão e o token anti-CSRF da página). Por ser injetada, não enxerga
 * nada de fora. Devolve { semSessao } | { status, texto } | { status: 0, tempoEsgotado?, erro? } (sem resposta em 15 s
 * ou falha de rede, com a mensagem do fetch em `erro`); nunca lança, e o token não sai daqui. Fora da origem de CENTRAL
 * (a aba foi para outra página), devolve { semSessao } sem chamar nada: naCentral recarrega a aba na Central e tenta
 * de novo.
 */
async function chamarCentral(caminho, corpo) {
  if (location.origin !== 'https://www.mercadolivre.com.br') return { status: 0, semSessao: true }; // a origem de ML/CENTRAL
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  if (!csrf) return { status: 0, semSessao: true };
  try {
    const r = await fetch(location.origin + caminho, {
      method: 'POST', credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-custom-origin': location.origin },
      body: JSON.stringify(corpo), signal: AbortSignal.timeout(15000),
    });
    return { status: r.status, texto: await r.text() };
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { status: 0, tempoEsgotado: true };
    return { status: 0, erro: String(e?.message ?? '').slice(0, 300) };
  }
}

/**
 * A promessa ou, passados `ms`, a rejeição com `erro`. A promessa original segue sozinha (não dá para cancelar um
 * executeScript); o que ela der depois é ignorado.
 */
function comPrazo(promessa, ms, erro) {
  let t;
  const prazo = new Promise((_, falha) => { t = setTimeout(() => falha(erro), ms); });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(t));
}

function esperarCarregar(tabId) {
  return new Promise((ok) => {
    const f = (id, i) => { if (id === tabId && i.status === 'complete') { chrome.tabs.onUpdated.removeListener(f); ok(); } };
    chrome.tabs.onUpdated.addListener(f);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(f); ok(); }, ESPERA_CARREGAR);
  });
}

/** O endereço é uma página de afiliados do Mercado Livre (https://<…>.mercadolivre.com.br/afiliados…)? */
function naPaginaDeAfiliados(url) {
  let u;
  try { u = new URL(String(url ?? '')); } catch { return false; }
  const h = u.hostname;
  return u.protocol === 'https:' && (h === 'mercadolivre.com.br' || h.endsWith('.mercadolivre.com.br'))
    && /^\/afiliados(?:\/|$)/.test(u.pathname);
}

// A aba da Central que a extensão abriu fica lembrada em chrome.storage.session: sobrevive ao service worker que o
// Chrome encerra e some quando o Chrome reinicia, porque os ids de aba recomeçam e o mesmo número pode ser uma aba
// do dono. Sem storage.session (Chrome anterior ao 102), nada é lembrado.
async function idLembrado() {
  try {
    const { abaCentral } = await chrome.storage.session.get('abaCentral');
    return Number.isInteger(abaCentral) ? abaCentral : null;
  } catch { return null; }
}
async function lembrar(id) {
  try { await chrome.storage.session.set({ abaCentral: id }); } catch { /* sem storage.session: segue sem lembrar */ }
}

/** A aba lembrada, se ainda existe; fechada, é esquecida. */
async function abaLembrada() {
  const id = await idLembrado();
  if (id === null) return null;
  try { return await chrome.tabs.get(id); } catch {
    try { await chrome.storage.session.remove('abaCentral'); } catch { /* nada a esquecer */ }
    return null;
  }
}

/**
 * Leva a aba à Central e espera carregar. Só navega a aba que a extensão abriu ou uma que ainda esteja em /afiliados:
 * qualquer outra aba do Mercado Livre é do dono e nunca é navegada (devolve false sem tocar nela). Aba fechada lança.
 */
async function levarACentral(tabId) {
  const aba = await chrome.tabs.get(tabId);
  if (aba.id !== await idLembrado() && !naPaginaDeAfiliados(aba.url)) return false;
  const carregou = esperarCarregar(tabId);
  await chrome.tabs.update(tabId, { url: CENTRAL });
  await carregou;
  return true;
}

/**
 * A aba da Central para o próximo pedido, nesta ordem: a que a extensão abriu, se está em /afiliados; outra aba em
 * /afiliados (de preferência carregada); a que a extensão abriu e saiu de /afiliados, levada de volta à Central; ou
 * uma nova, fixada e em segundo plano, que passa a ser a lembrada.
 */
async function abaDaCentral() {
  const lembrada = await abaLembrada();
  if (lembrada && naPaginaDeAfiliados(lembrada.url)) return lembrada.id;
  const abertas = (await chrome.tabs.query({ url: 'https://*.mercadolivre.com.br/afiliados*' })).filter((t) => naPaginaDeAfiliados(t.url));
  const pronta = abertas.find((t) => t.status === 'complete' && !t.discarded) || abertas.find((t) => t.status === 'complete') || abertas[0];
  if (pronta) return pronta.id;
  if (lembrada) {
    try { if (await levarACentral(lembrada.id)) return lembrada.id; } catch { /* fechou agora: abre outra */ }
  }
  const nova = await chrome.tabs.create({ url: CENTRAL, active: false, pinned: true });
  await lembrar(nova.id);
  await esperarCarregar(nova.id);
  return nova.id;
}

/** Aba descartada pelo Chrome (tirada da memória) não aceita script: recarrega e espera carregar. Aba fechada lança. */
async function acordar(tabId) {
  const aba = await chrome.tabs.get(tabId);
  if (!aba.discarded) return;
  const carregou = esperarCarregar(tabId);
  await chrome.tabs.reload(tabId);
  await carregou;
}

/**
 * Leva a aba de volta à Central (sessão vencida ou chamada sem resposta). Se ela foi fechada ou é uma aba do dono que
 * saiu de /afiliados, usa ou abre outra.
 */
async function recarregarCentral(tabId) {
  centralTravada = false;
  try {
    if (await levarACentral(tabId)) return tabId;
  } catch { /* fechada */ }
  return abaDaCentral();
}

/**
 * Faz a chamada na aba; se a sessão/token da página venceu ou a Central não respondeu, recarrega a aba e tenta mais
 * uma vez. `pedido.encerrado` (o laço desistiu do pedido por tempo): para antes de chamar ou recarregar de novo.
 * Todo erro sai com `tipo` (erroCentral); o que vier do Chrome sem tipo (abrir ou achar a aba) vira `aba`.
 */
async function naCentral(caminho, corpo, pedido = {}) {
  try {
    return await naCentralSemTipo(caminho, corpo, pedido);
  } catch (e) {
    throw e?.tipo ? e : erroCentral('aba', CENTRAL_NAO_ABRIU, e);
  }
}

async function naCentralSemTipo(caminho, corpo, pedido) {
  const semResposta = () => erroCentral('sem_resposta', CENTRAL_SEM_RESPOSTA);
  if (pedido.encerrado) throw semResposta();
  let tabId = await abaDaCentral();
  if (centralTravada) tabId = await recarregarCentral(tabId);
  let erroDaAba = null; // a última falha do Chrome ao injetar (vai entre aspas se as duas tentativas falharem)
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (pedido.encerrado) throw semResposta();
    let res;
    const parada = new Error(CENTRAL_SEM_RESPOSTA);
    try {
      await acordar(tabId);
      [{ result: res } = {}] = await comPrazo(
        chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: chamarCentral, args: [caminho, corpo] }),
        ESPERA_ABA, parada,
      );
    } catch (e) {
      if (e !== parada) {
        // aba fechada, descartada de novo ou navegando: usa ou abre outra
        erroDaAba = e;
        tabId = await abaDaCentral();
        continue;
      }
      res = { status: 0, tempoEsgotado: true }; // a aba não devolveu nada (página congelada)
    }
    if (pedido.encerrado) throw semResposta();
    if (res && !res.semSessao && res.status !== 401 && res.status !== 403) {
      if (!res.status) {
        // sem resposta: a aba é recarregada antes da segunda tentativa ou, depois dela, antes do próximo pedido
        centralTravada = true;
        if (tentativa === 0) { tabId = await recarregarCentral(tabId); continue; }
        if (res.tempoEsgotado) throw semResposta();
        throw erroCentral('sem_resposta', 'não consegui falar com a Central de Afiliados', typeof res.erro === 'string' ? res.erro : '');
      }
      if (res.status >= 400) throw erroCentral('http', `a Central de Afiliados respondeu HTTP ${Number(res.status) || 0}`);
      try { return JSON.parse(res.texto); } catch { throw erroCentral('formato', 'a Central de Afiliados respondeu algo que não é JSON'); }
    }
    if (tentativa === 0) { tabId = await recarregarCentral(tabId); continue; }
    throw erroCentral('sessao', CENTRAL_SEM_SESSAO);
  }
  throw erroCentral('aba', CENTRAL_NAO_ABRIU, erroDaAba);
}

/**
 * Só um link https://meli.la/… volta como sucesso, em qualquer tentativa: sem ele, o pedido falha (recusa do Mercado
 * Livre, com a mensagem dele entre aspas, ou formato) e nunca vira link sem afiliação.
 */
async function gerarLink(job, pedido) {
  const j = await naCentral(API_LINK, { urls: [job.url], tag: job.tag }, pedido);
  const u = j?.urls?.[0] || {};
  if (/^https:\/\/meli\.la\//.test(u.short_url || '')) return u.short_url;
  const motivo = [u.error?.message, u.message, j?.message].find((v) => typeof v === 'string' && v.trim());
  if (motivo || j?.total_error) {
    const e = erroCentral('recusa', 'o Mercado Livre recusou o link', motivo);
    e.message += ` (etiqueta "${job.tag}")`;
    throw e;
  }
  throw erroCentral('formato', 'a Central de Afiliados respondeu sem link');
}

// ---- Shopee: funções puras (início) ----
// Sem chrome.*, sem rede e sem estado: test/extensao-shopee.test.js extrai este trecho por estes marcadores.
const SHOPEE_PORTAL = 'https://affiliate.shopee.com.br';
const SHOPEE_ABA = `${SHOPEE_PORTAL}/offer/custom_link`;
// Valor do cabeçalho Affiliate-Program-Type do programa "normal". Ponto único: o valor que a página usa ainda não
// foi extraído (docs/produto/referencias/shopee-api-afiliados.md). Vazio = o cabeçalho não vai. Se o teste com a
// sessão do dono mostrar que ele é obrigatório, copie aqui o valor da requisição "Obter link" vista no DevTools.
const SHOPEE_TIPO_PROGRAMA = '';
// Nome do campo do Sub_id1 dentro de `advancedLinkParams` do "Link personalizado". Ponto único. Formato capturado
// no portal em 05/11/2026 (pendência P4 do plano dashboard-ganhos, só o corpo, sem cookies):
// linkParams: [{ originalLink, advancedLinkParams: { subId1: "<Sub_id>" } }]; sem Sub_id, a página omite
// advancedLinkParams. Vazio = o Sub_id nunca vai ao portal: o corpo é o de sempre e a resposta diz
// sub_id_aplicado: false (o link sai de afiliado, sem Sub_id).
// Esta constante não basta: o servidor só pede link com Sub_id à extensão com SUBID_PELA_EXTENSAO (src/lojas.js) em
// true. Para ligar ou desligar o Sub_id pela extensão, mude os dois juntos.
const SHOPEE_SUBID_CAMPO = 'subId1';
// Cópia do RE_SUB_ID de src/shopee.js (fonte única do formato; a extensão não importa do servidor). Mudar lá pede
// mudar aqui (o portal só aceita alfanumérico).
const RE_SUB_ID = /^[A-Za-z0-9]{1,30}$/;
const SHOPEE_SUBID_RECUSADO = 'Sub_id da Shopee recusado pela extensão';
const LINK_SHOPEE = /^https:\/\/s\.shopee\.com\.br\/[A-Za-z0-9_-]{3,40}$/; // o mesmo de src/shopee.js e src/links.js
const MAX_URL_SHOPEE = 2048;
const SHOPEE_SEM_SESSAO = 'não há sessão de afiliado da Shopee neste Chrome. Entre no portal de afiliados da Shopee (affiliate.shopee.com.br)';
const SHOPEE_FORMATO = 'o portal de afiliados da Shopee respondeu num formato inesperado';
const SHOPEE_QUERY = 'query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){ batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){ shortLink longLink failCode } }';

/** Só aceita o endereço de produto que o servidor monta: https://shopee.com.br/…, sem porta, credenciais nem parâmetros. */
function urlProdutoShopee(v) {
  if (typeof v !== 'string' || !v || v.length > MAX_URL_SHOPEE) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'shopee.com.br' || u.port || u.username || u.password || u.search || u.hash) return null;
  return u.href === v ? v : null; // só a forma canônica: nada de barras invertidas, espaços ou maiúsculas no host
}

/** Sem Sub_id (undefined, null ou '')? */
function semSubId(v) {
  return v === undefined || v === null || v === '';
}

/**
 * Corpo do POST do "Link personalizado" (o mesmo que a página manda). O Sub_id só entra, em
 * advancedLinkParams[SHOPEE_SUBID_CAMPO], quando a constante está preenchida; vazio, o corpo é o de sempre.
 * Sub_id fora de RE_SUB_ID → null (recusado), com a constante vazia ou não.
 */
function corpoLinkShopee(originalLink, subId) {
  if (!semSubId(subId) && !(typeof subId === 'string' && RE_SUB_ID.test(subId))) return null;
  const param = { originalLink };
  if (!semSubId(subId) && SHOPEE_SUBID_CAMPO) param.advancedLinkParams = { [SHOPEE_SUBID_CAMPO]: subId };
  return JSON.stringify({
    operationName: 'batchGetCustomLink',
    query: SHOPEE_QUERY,
    variables: { linkParams: [param], sourceCaller: 'CUSTOM_LINK_CALLER' },
  });
}

/** O longLink só serve para o servidor conferir o an_<ID>: https, host da Shopee, sem porta nem credenciais. */
function longoShopee(v) {
  if (typeof v !== 'string' || !v || v.length > MAX_URL_SHOPEE) return null;
  let u;
  try { u = new URL(v.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !(host === 'shopee.com.br' || host.endsWith('.shopee.com.br')) || u.port || u.username || u.password) return null;
  return u.href;
}

/** Algo no JSON diz "não logado"? Só olha códigos e frases conhecidas; nunca devolve o texto do portal. */
function jsonSemSessao(j) {
  const COD = /^(401|403|unauthenticated|unauthori[sz]ed|forbidden|not_?login|need_?login)$/i;
  const FRASE = /not\s?log(?:ged)?\s?in|unauthori[sz]ed|unauthenticated|login required|need login|session (?:expired|invalid)/i;
  const erros = Array.isArray(j?.errors) ? j.errors.slice(0, 10) : [];
  return erros.some((e) => COD.test(String(e?.extensions?.code ?? '').slice(0, 40)) || FRASE.test(String(e?.message ?? '').slice(0, 300)))
    || COD.test(String(j?.code ?? '').slice(0, 40));
}

/**
 * Lê o que a aba devolveu ({ semSessao } | { status, texto }) e decide: { semSessao: true } (recarregar e tentar de
 * novo), { erro } (frase fixa, sem nada do corpo da resposta) ou { link, longo }.
 */
function interpretarShopee(res) {
  if (!res || typeof res !== 'object') return { erro: 'não consegui falar com o portal de afiliados da Shopee' };
  if (res.semSessao || res.status === 401 || res.status === 403) return { semSessao: true };
  if (!res.status) return { erro: 'não consegui falar com o portal de afiliados da Shopee' };
  let j = null;
  try { j = JSON.parse(res.texto); } catch { /* fica null */ }
  if (res.status >= 400) return jsonSemSessao(j) ? { semSessao: true } : { erro: `o portal de afiliados da Shopee respondeu HTTP ${Number(res.status) || 0}` };
  if (!j || typeof j !== 'object') return { erro: SHOPEE_FORMATO };
  const lista = j.data?.batchCustomLink;
  const item = Array.isArray(lista) ? lista[0] : null;
  if (!item || typeof item !== 'object') return jsonSemSessao(j) ? { semSessao: true } : { erro: SHOPEE_FORMATO };
  const fc = item.failCode;
  if (fc !== undefined && fc !== null && fc !== 0 && fc !== '0') {
    const n = Number(fc);
    return { erro: Number.isSafeInteger(n) ? `a Shopee recusou o link (código ${n})` : 'a Shopee recusou o link' };
  }
  const link = typeof item.shortLink === 'string' ? item.shortLink.trim() : '';
  if (!LINK_SHOPEE.test(link)) return { erro: SHOPEE_FORMATO };
  return { link, longo: longoShopee(item.longLink) };
}

/**
 * Roda DENTRO da aba do portal (mesma origem, com a sessão do dono). Por ser injetada, não enxerga nada de fora:
 * recebe o corpo pronto e o tipo de programa. Lê o token anti-CSRF do cabeçalho de resposta `csrf-token` de
 * /api/v3/config/website (na falta dele, do `csrf_token` da configuração) e o manda no cabeçalho `CSRF-token`.
 * Devolve só { semSessao } | { status, texto } | { status: 0 }; o token não sai daqui.
 */
async function chamarPortalShopee(corpo, tipoPrograma) {
  if (location.origin !== 'https://affiliate.shopee.com.br') return { semSessao: true };
  const extra = tipoPrograma ? { 'affiliate-program-type': tipoPrograma } : {};
  // A API não redireciona: um redirecionamento (que com redirect:'manual' vira 'opaqueredirect') é a ida ao login.
  const naoLogado = (r) => r.status === 401 || r.status === 403 || r.type === 'opaqueredirect';
  try {
    const cfg = await fetch(`${location.origin}/api/v3/config/website`, {
      credentials: 'include', redirect: 'manual', headers: { accept: 'application/json, text/plain, */*', ...extra }, signal: AbortSignal.timeout(20000),
    });
    if (naoLogado(cfg)) return { semSessao: true };
    if (!cfg.ok) return { status: cfg.status, texto: '' };
    let csrf = cfg.headers.get('csrf-token');
    if (!csrf) {
      try { const c = await cfg.json(); csrf = c?.data?.csrf_token ?? c?.csrf_token; } catch { csrf = null; }
    }
    const headers = { accept: 'application/json, text/plain, */*', 'content-type': 'application/json', ...extra };
    if (typeof csrf === 'string' && /^[!-~]{1,512}$/.test(csrf)) headers['csrf-token'] = csrf;
    const r = await fetch(`${location.origin}/api/v3/gql?q=batchCustomLink`, {
      method: 'POST', credentials: 'include', redirect: 'manual', headers, body: corpo, signal: AbortSignal.timeout(20000),
    });
    if (naoLogado(r)) return { semSessao: true };
    return { status: r.status, texto: await r.text() };
  } catch (e) {
    // tempo esgotado (20 s) separado da queda de rede: os dois recarregam a aba, só a mensagem final muda
    return e?.name === 'TimeoutError' ? { status: 0, tempoEsgotado: true } : { status: 0 };
  }
}
// ---- Shopee: funções puras (fim) ----

// ---- Mercado Livre produto: funções puras (início) ----
// Sem chrome.* e sem estado: test/extensao-produto.test.js extrai este trecho por estes marcadores. O servidor valida
// a resposta de novo (lerProdutoDaExtensao em src/ml.js) e recusa a resposta inteira se houver chave a mais.
const MAX_URL_PRODUTO_ML = 2048;
const MAX_PAGINA_ML = 3 * 1024 * 1024; // bytes do corpo da página (pelo content-length e contando o que chega)
const MAX_TAG_LD = 512; // a mesma varredura de blocosJsonLd em src/ml.js
const MAX_BLOCOS_LD = 50;
const MAX_OFERTAS_ML = 5; // MAX_OFERTAS_EXTENSAO em src/ml.js
const MAX_VARIANTES_ML = 30; // MAX_VARIANTES_EXTENSAO em src/ml.js
const MAX_PRECO_ML = 10000000;
const PRODUTO_RECUSADO = 'endereço de produto do Mercado Livre recusado pela extensão';
const PRODUTO_GRANDE = 'a página do produto no Mercado Livre é grande demais';

const hostDoML = (h) => h === 'mercadolivre.com.br' || h.endsWith('.mercadolivre.com.br');
// Os mesmos padrões de urlProdutoML em src/ml.js: só anúncio ou catálogo, nos dois hosts de produto
const HOSTS_PRODUTO_ML = ['www.mercadolivre.com.br', 'produto.mercadolivre.com.br'];
const CAMINHO_ANUNCIO_ML = /^\/MLB-?\d{6,20}(?:[-_](?:[\w.~-]|%(?!2f|5c|2e)[0-9a-f]{2})*)?$/i;
const CAMINHO_CATALOGO_ML = /^\/(?:(?:[\w.~-]|%(?!2f|5c|2e)[0-9a-f]{2})+\/)?p\/MLB\d{1,20}$/i;
const FILTRO_ITEM_ML = /^item_id:MLB\d{6,20}$/;
// Partes do endereço final (rótulos do host e segmentos do caminho) que são a página de verificação do Mercado Livre
const PARTES_VERIFICACAO_ML = ['gz', 'account-verification', 'captcha'];

/**
 * Só aceita o endereço de um produto (anúncio /MLB-… ou catálogo …/p/MLB…) em https://www.mercadolivre.com.br ou
 * https://produto.mercadolivre.com.br, nunca a vitrine /social/; sem porta, credenciais nem `#`; da query, só
 * `pdp_filters=item_id:MLB…`; até 2048 caracteres e exatamente na forma que o painel manda (origin + caminho
 * [+ ?pdp_filters=…]). Qualquer outra página do Mercado Livre (conta, carrinho, sair…) → null: a extensão busca com a
 * sessão do dono.
 */
function urlProdutoML(v) {
  if (typeof v !== 'string' || !v || v.length > MAX_URL_PRODUTO_ML || v.includes('#')) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || !HOSTS_PRODUTO_ML.includes(u.hostname) || u.port || u.username || u.password) return null;
  let caminho;
  try { caminho = decodeURIComponent(u.pathname); } catch { return null; }
  if (/(?:^|\/)social(?:\/|$)/i.test(caminho)) return null;
  if (!CAMINHO_CATALOGO_ML.test(u.pathname) && !CAMINHO_ANUNCIO_ML.test(u.pathname)) return null;
  const filtros = u.searchParams.getAll('pdp_filters');
  const filtro = filtros.length === 1 && FILTRO_ITEM_ML.test(filtros[0]) ? filtros[0] : null;
  return `${u.origin}${u.pathname}${filtro ? `?pdp_filters=${filtro}` : ''}` === v ? v : null;
}

/**
 * Status e endereço final da resposta (depois dos redirecionamentos) → { estado: 'verificacao' } (o Mercado Livre
 * pediu verificação: endereço final fora de https://*.mercadolivre.com.br, um rótulo do host ou um segmento do caminho
 * igual a `gz`, `account-verification` ou `captcha`, ou HTTP 403/429), { erro } (outro HTTP fora de 2xx) ou
 * { ler: true } (ler o corpo). A query e o slug de um produto ("teclado-anti-captcha") nunca contam.
 */
function estadoDaResposta(status, urlFinal) {
  let u = null;
  try { u = new URL(String(urlFinal ?? '')); } catch { /* sem endereço final: trata como fora do Mercado Livre */ }
  const fora = !u || u.protocol !== 'https:' || !hostDoML(u.hostname);
  const partes = fora ? [] : [...u.hostname.split('.'), ...u.pathname.toLowerCase().split('/')];
  if (fora || partes.some((p) => PARTES_VERIFICACAO_ML.includes(p)) || status === 403 || status === 429) return { estado: 'verificacao' };
  if (!(status >= 200 && status < 300)) return { erro: `a página do produto respondeu HTTP ${Number(status) || 0}` };
  return { ler: true };
}

/**
 * Corpo da resposta como texto, com teto de MAX_PAGINA_ML bytes. Acima disso, cancela a leitura e lança
 * PRODUTO_GRANDE. Outras falhas (tempo esgotado, rede) lançam o erro da leitura.
 */
async function corpoDaPaginaML(r) {
  const declarado = r.headers?.get?.('content-length');
  if (declarado != null && declarado !== '' && !(Number(declarado) <= MAX_PAGINA_ML)) {
    try { await r.body?.cancel?.(); } catch { /* já fechado */ }
    throw new Error(PRODUTO_GRANDE);
  }
  const leitor = r.body?.getReader?.();
  if (!leitor) return '';
  const dec = new TextDecoder();
  let texto = ''; let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value?.byteLength ?? 0;
    if (total > MAX_PAGINA_ML) {
      try { await leitor.cancel(); } catch { /* já fechado */ }
      throw new Error(PRODUTO_GRANDE);
    }
    texto += dec.decode(value, { stream: true });
  }
  return texto + dec.decode();
}

/**
 * Conteúdo de cada `<script type="application/ld+json">…</script>` da página, na ordem, até MAX_BLOCOS_LD. Cópia de
 * blocosJsonLd (src/ml.js): varredura linear, sem regex `[\s\S]*?` sobre a página toda.
 */
function* blocosJsonLdML(html) {
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

const tiposLdML = (n) => [].concat(n['@type']);
const objetoLd = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** `price` (ou `lowPrice`) e `availability` da primeira oferta do nó, já no formato que o servidor aceita. */
function precoEEstoqueML(no) {
  const off = [].concat(no.offers || [])[0];
  const o = off && typeof off === 'object' ? off : {};
  const p = o.price ?? o.lowPrice;
  let price = null;
  if (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= MAX_PRECO_ML) price = p;
  else if (typeof p === 'string' && p.length <= 30) price = p;
  const availability = typeof o.availability === 'string' && o.availability.length <= 100 ? o.availability : null;
  return { price, availability };
}

/**
 * Resumo do JSON-LD da página: até MAX_OFERTAS_ML itens, um por bloco, na ordem. Em cada bloco vale o primeiro nó
 * ProductGroup (página de catálogo: as ofertas ficam em `hasVariant`), que vira { nome, variantes: [até 30 ×
 * { sku, nome, price, availability }] }, ou, sem ele, o primeiro Product, que vira { nome, price, availability }.
 * `nome` diz só se o nó tem nome (o nome não sai daqui). A extensão não escolhe a variante: o servidor escolhe pelo
 * endereço do pedido. Bloco que não é JSON, sem produto ou com grupo sem variante não gera item.
 */
function ofertasDoHtml(html) {
  const ofertas = [];
  for (const bloco of blocosJsonLdML(String(html ?? ''))) {
    if (ofertas.length >= MAX_OFERTAS_ML) break;
    let data;
    try { data = JSON.parse(bloco); } catch { continue; }
    const nodes = [].concat(data, data?.['@graph'] || []).flat().filter((n) => n && typeof n === 'object');
    const grupo = nodes.find((n) => tiposLdML(n).includes('ProductGroup'));
    if (grupo) {
      const variantes = [].concat(grupo.hasVariant ?? []).filter(objetoLd).slice(0, MAX_VARIANTES_ML).map((v) => ({
        sku: typeof v.sku === 'string' && v.sku.length <= 30 ? v.sku : null,
        nome: !!v.name,
        ...precoEEstoqueML(v),
      }));
      if (variantes.length) ofertas.push({ nome: !!grupo.name, variantes });
      continue;
    }
    const prod = nodes.find((n) => tiposLdML(n).includes('Product'));
    if (prod) ofertas.push({ nome: !!prod.name, ...precoEEstoqueML(prod) });
  }
  return ofertas;
}
// ---- Mercado Livre produto: funções puras (fim) ----

/**
 * Lê o preço e o estoque de um produto do Mercado Livre com um fetch daqui (service worker), com os cookies do
 * navegador: sem aba, sem navegar, sem repetir e sem resolver CAPTCHA. Página de verificação → { estado:
 * 'verificacao' } (o painel para de pedir por um tempo). Só o resumo do JSON-LD volta; nunca o HTML nem o endereço.
 */
async function lerProdutoML(job, pedido = {}) {
  const url = urlProdutoML(job.url);
  if (!url) throw new Error(PRODUTO_RECUSADO);
  if (pedido.encerrado) throw new Error(PRODUTO_SEM_RESPOSTA);
  const semResposta = (e) => (e?.name === 'TimeoutError' || e?.name === 'AbortError'
    ? new Error(PRODUTO_SEM_RESPOSTA) : new Error('não consegui abrir a página do produto no Mercado Livre'));
  let r;
  try {
    // no-store: o preço tem de ser o de agora, nunca o do cache HTTP do Chrome
    r = await fetch(url, { credentials: 'include', redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(TEMPO_PRODUTO) });
  } catch (e) { throw semResposta(e); }
  const v = estadoDaResposta(r.status, r.url);
  if (!v.ler) {
    try { await r.body?.cancel?.(); } catch { /* já fechado */ }
    if (v.erro) throw new Error(v.erro);
    return { data: { estado: 'verificacao' } };
  }
  let html;
  try { html = await corpoDaPaginaML(r); } catch (e) { throw e?.message === PRODUTO_GRANDE ? e : semResposta(e); }
  return { data: { estado: 'lido', ofertas: ofertasDoHtml(html) } };
}

let abaShopee = null; // a aba que a extensão abriu para o portal (reaproveitada mesmo se a Shopee a levar ao login)

/** Usa uma aba do portal já aberta (de preferência a do Link personalizado) ou abre uma fixada, em segundo plano. */
async function abaDaShopee() {
  const abertas = await chrome.tabs.query({ url: `${SHOPEE_PORTAL}/*` });
  const pronta = abertas.find((t) => t.url?.startsWith(SHOPEE_ABA) && t.status === 'complete')
    || abertas.find((t) => t.status === 'complete') || abertas[0];
  if (pronta) return pronta.id;
  if (abaShopee !== null) {
    try { await chrome.tabs.get(abaShopee); return await recarregarShopee(abaShopee); } catch { abaShopee = null; }
  }
  const nova = await chrome.tabs.create({ url: SHOPEE_ABA, active: false, pinned: true });
  abaShopee = nova.id;
  await esperarCarregar(nova.id);
  return nova.id;
}

async function recarregarShopee(tabId) {
  try {
    await chrome.tabs.update(tabId, { url: SHOPEE_ABA });
  } catch {
    if (abaShopee === tabId) abaShopee = null;
    return abaDaShopee(); // a aba foi fechada: usa ou abre outra
  }
  await esperarCarregar(tabId);
  return tabId;
}

/**
 * Gera o link na aba do portal; sem sessão (ou fora do portal, ex.: página de login), recarrega uma vez.
 * sub_id_aplicado: o Sub_id do pedido foi no corpo (só com SHOPEE_SUBID_CAMPO preenchido) e a Shopee devolveu o
 * link sem failCode (com failCode, o pedido volta como erro, sem o campo).
 */
async function gerarLinkShopee(job, pedido = {}) {
  const url = urlProdutoShopee(job.url);
  if (!url) throw new Error('endereço de produto da Shopee recusado pela extensão');
  const corpo = corpoLinkShopee(url, job.subId);
  if (!corpo) throw new Error(SHOPEE_SUBID_RECUSADO);
  const subIdAplicado = !semSubId(job.subId) && !!SHOPEE_SUBID_CAMPO;
  let tabId = await abaDaShopee();
  if (shopeeTravada) { shopeeTravada = false; tabId = await recarregarShopee(tabId); }
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (pedido.encerrado) throw new Error(SHOPEE_SEM_RESPOSTA);
    let res = null;
    try {
      [{ result: res } = {}] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: chamarPortalShopee, args: [corpo, SHOPEE_TIPO_PROGRAMA] });
    } catch {
      res = { semSessao: true }; // aba fechada ou fora do portal (a Shopee leva ao login, onde a extensão não entra)
    }
    if (pedido.encerrado) throw new Error(SHOPEE_SEM_RESPOSTA); // resposta tardia de um pedido abandonado: não recarrega
    if (res && typeof res === 'object' && !res.semSessao && !res.status) {
      // o portal não respondeu (tempo esgotado ou rede): recarrega a aba e tenta de novo; na segunda, o próximo pedido
      // da Shopee começa recarregando a aba
      if (tentativa === 0) { tabId = await recarregarShopee(tabId); continue; }
      shopeeTravada = true;
      if (res.tempoEsgotado) throw new Error(SHOPEE_SEM_RESPOSTA);
    }
    const v = interpretarShopee(res);
    if (v.erro) throw new Error(v.erro);
    if (!v.semSessao) return { link: v.link, longo: v.longo, sub_id_aplicado: subIdAplicado };
    if (tentativa === 0) tabId = await recarregarShopee(tabId);
  }
  throw new Error(SHOPEE_SEM_SESSAO);
}

async function buscarOfertas(job, pedido) {
  const paginas = [];
  for (const corpo of job.paginas || []) {
    const j = await naCentral(API_LISTA, corpo, pedido);
    const model = j?.polycard_client_model;
    if (!model) throw erroCentral('formato', 'a Central de Afiliados mudou o formato da lista');
    // devolve uma entrada por pedido, na mesma ordem (o servidor intercala as categorias)
    paginas.push({ polycard_client_model: { polycard_context: { url_prefix: model.polycard_context?.url_prefix }, polycards: model.polycards || [] } });
  }
  return paginas;
}

/**
 * O trabalho de um pedido, já no formato da resposta (sem id e ok). Tipo desconhecido é recusado: nunca vira pedido de
 * link (um link sem etiqueta seria pior que nenhum).
 */
async function executar(job, pedido) {
  if (job.type === 'link') return { link: await gerarLink(job, pedido) };
  if (job.type === 'ofertas') return { data: await buscarOfertas(job, pedido) };
  if (job.type === 'link_shopee') return gerarLinkShopee(job, pedido);
  if (job.type === 'produto_ml') return lerProdutoML(job, pedido);
  throw new Error('pedido desconhecido');
}

async function laco() {
  if (rodando) return; rodando = true;
  try {
    for (;;) {
      const c = await cfg();
      if (!c.token) { await status({ ok: false, erro: 'Cole o token do painel no ícone da extensão.' }); return; }
      let resp;
      try {
        // o painel segura o poll por 20 s; sem resposta em 30 s, o laço para e o alarme o religa
        const headers = { 'x-token': c.token, 'x-recursos': RECURSOS };
        if (VERSAO) headers['x-versao'] = VERSAO;
        resp = await fetch(`${c.servidor}/api/ext/poll`, { headers, signal: AbortSignal.timeout(30000) });
      } catch { await status({ ok: false, erro: 'Painel fechado ou endereço errado.' }); return; }
      if (resp.status === 401) { await status({ ok: false, erro: 'Token recusado. Copie de novo em Conexões → Mercado Livre, no painel.' }); return; }
      await status({ ok: true, erro: null, em: Date.now() });
      let job;
      try { ({ job } = await resp.json()); } catch { continue; }
      if (!job) continue; // long-poll voltou vazio: pergunta de novo
      let corpo;
      // Um resultado por pedido: passado o teto, responde o erro e segue; o que o trabalho der depois é ignorado.
      const pedido = { encerrado: false };
      const produto = job.type === 'produto_ml';
      const shopee = job.type === 'link_shopee';
      const central = job.type === 'link' || job.type === 'ofertas'; // os pedidos que passam pela Central (levam `tipo`)
      const estouro = central ? erroCentral('sem_resposta', CENTRAL_SEM_RESPOSTA)
        : new Error(produto ? PRODUTO_SEM_RESPOSTA : shopee ? SHOPEE_SEM_RESPOSTA : CENTRAL_SEM_RESPOSTA);
      const teto = produto ? TETO_PRODUTO : job.type === 'ofertas' ? TETO_OFERTAS : shopee ? TETO_SHOPEE : TETO_PEDIDO;
      try {
        corpo = { id: job.id, ok: true, ...(await comPrazo(executar(job, pedido), teto, estouro)) };
        await status(central ? { ultimoErro: null, central: 'respondendo' } : { ultimoErro: null });
      } catch (e) {
        if (e === estouro) {
          pedido.encerrado = true; // o trabalho abandonado para na próxima etapa, sem chamar nem recarregar de novo
          // a leitura de produto não usa aba: o estouro dela não recarrega a Central nem o portal
          if (shopee) shopeeTravada = true; else if (!produto) centralTravada = true;
        }
        corpo = { id: job.id, ok: false, error: String(e.message || e) };
        if (central && e?.tipo) corpo.tipo = e.tipo;
        // recusa: a Central respondeu (o Mercado Livre recusou a oferta); qualquer outro erro conta como sem resposta
        await status(central ? { ultimoErro: corpo.error, central: corpo.tipo === 'recusa' ? 'respondendo' : 'sem_resposta' } : { ultimoErro: corpo.error });
      }
      await fetch(`${c.servidor}/api/ext/result`, {
        method: 'POST', headers: { 'x-token': c.token, 'content-type': 'application/json' }, body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }
  } finally { rodando = false; }
}

chrome.alarms.create('despertar', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => laco());
chrome.runtime.onStartup.addListener(laco);
chrome.runtime.onInstalled.addListener(async () => {
  // versões antigas pediam todos os sites. Ao atualizar, devolve essa concessão quando o painel configurado
  // não precisa dela (local ou nenhum). Com painel https remoto ela fica até o dono salvar de novo no popup,
  // que então pede só aquele domínio (pedir permissão aqui não vale: precisa de gesto do usuário).
  try {
    const { conf } = await chrome.storage.local.get('conf');
    const origem = conf?.servidor ? new URL(conf.servidor).origin : '';
    const remoto = origem.startsWith('https://') && !/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origem);
    if (!remoto) await chrome.permissions.remove({ origins: ['https://*/*'] });
  } catch { /* sem conf ou sem a concessão: nada a fazer */ }
  laco();
});
chrome.storage.onChanged.addListener((m) => { if (m.conf) laco(); });
laco();
