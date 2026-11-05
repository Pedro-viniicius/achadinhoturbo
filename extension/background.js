// Conector da Central de Afiliados (achadinhoturbo): busca pedidos no painel (que roda no seu computador) e
// os executa de dentro de uma aba da Central de Afiliados do Mercado Livre ou do portal de afiliados da Shopee,
// com a sua sessão. Três pedidos: gerar link meli.la com a etiqueta, buscar a lista "Produtos selecionados para
// você" e gerar o link de afiliado da Shopee (s.shopee.com.br, pelo "Link personalizado" do portal).
// Só os links e a lista voltam para o painel. Cookies e tokens ficam no navegador, e nada disso vai para o console.

const PADRAO = { servidor: 'http://127.0.0.1:3737', token: '' };
const ML = 'https://www.mercadolivre.com.br';
const CENTRAL = `${ML}/afiliados/hub?is_affiliate=true`;
const API_LINK = '/affiliate-program/api/v2/affiliates/createLink';
const API_LISTA = '/affiliate-program/api/hub/search?is_affiliate=true&device=desktop';
let rodando = false;

async function cfg() {
  const { conf } = await chrome.storage.local.get('conf');
  return { ...PADRAO, ...(conf || {}) };
}
async function status(p) {
  const { st = {} } = await chrome.storage.local.get('st');
  await chrome.storage.local.set({ st: { ...st, ...p } });
}

/** Roda DENTRO da aba da Central (mesma origem, com a sessão e o token anti-CSRF da página). */
async function chamarCentral(caminho, corpo) {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  if (!csrf) return { status: 0, semSessao: true };
  const r = await fetch(location.origin + caminho, {
    method: 'POST', credentials: 'include',
    headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-custom-origin': location.origin },
    body: JSON.stringify(corpo),
  });
  return { status: r.status, texto: await r.text() };
}

function esperarCarregar(tabId) {
  return new Promise((ok) => {
    const f = (id, i) => { if (id === tabId && i.status === 'complete') { chrome.tabs.onUpdated.removeListener(f); ok(); } };
    chrome.tabs.onUpdated.addListener(f);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(f); ok(); }, 25000);
  });
}

/** Usa uma aba da Central já aberta ou abre uma fixada, em segundo plano. */
async function abaDaCentral() {
  const abertas = await chrome.tabs.query({ url: 'https://*.mercadolivre.com.br/afiliados*' });
  const pronta = abertas.find((t) => t.status === 'complete') || abertas[0];
  if (pronta) return pronta.id;
  const nova = await chrome.tabs.create({ url: CENTRAL, active: false, pinned: true });
  await esperarCarregar(nova.id);
  return nova.id;
}

async function recarregar(tabId) {
  await chrome.tabs.update(tabId, { url: CENTRAL });
  await esperarCarregar(tabId);
}

/** Faz a chamada na aba; se a sessão/token da página venceu, recarrega a aba e tenta mais uma vez. */
async function naCentral(caminho, corpo) {
  let tabId = await abaDaCentral();
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    let res;
    try {
      [{ result: res } = {}] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: chamarCentral, args: [caminho, corpo] });
    } catch (e) {
      // aba fechada ou navegando: abre outra
      tabId = await abaDaCentral();
      continue;
    }
    if (res && !res.semSessao && res.status !== 401 && res.status !== 403) {
      if (!res.status || res.status >= 400) throw new Error(`a Central de Afiliados respondeu HTTP ${res.status}`);
      try { return JSON.parse(res.texto); } catch { throw new Error('a Central de Afiliados respondeu algo que não é JSON'); }
    }
    if (tentativa === 0) { await recarregar(tabId); continue; }
    throw new Error('não há sessão de afiliado neste Chrome. Entre na sua conta da Central de Afiliados do Mercado Livre');
  }
  throw new Error('não consegui abrir a Central de Afiliados');
}

async function gerarLink(job) {
  const j = await naCentral(API_LINK, { urls: [job.url], tag: job.tag });
  const u = j?.urls?.[0] || {};
  if (/^https:\/\/meli\.la\//.test(u.short_url || '')) return u.short_url;
  const motivo = u.error?.message || u.message || j?.message || (j?.total_error ? 'o Mercado Livre recusou o link' : 'resposta sem link');
  throw new Error(`${motivo} (etiqueta "${job.tag}")`);
}

// ---- Shopee: funções puras (início) ----
// Sem chrome.*, sem rede e sem estado: test/extensao-shopee.test.js extrai este trecho por estes marcadores.
const SHOPEE_PORTAL = 'https://affiliate.shopee.com.br';
const SHOPEE_ABA = `${SHOPEE_PORTAL}/offer/custom_link`;
// Valor do cabeçalho Affiliate-Program-Type do programa "normal". Ponto único: o valor que a página usa ainda não
// foi extraído (docs/produto/referencias/shopee-api-afiliados.md). Vazio = o cabeçalho não vai. Se o teste com a
// sessão do dono mostrar que ele é obrigatório, copie aqui o valor da requisição "Obter link" vista no DevTools.
const SHOPEE_TIPO_PROGRAMA = '';
// Nome do campo do Sub_id1 dentro de `advancedLinkParams` do "Link personalizado". Ponto único: o formato ainda não
// foi capturado (pendência P4 do plano dashboard-ganhos). Vazio = o Sub_id nunca vai ao portal: o corpo é o de sempre
// e a resposta diz sub_id_aplicado: false (o link sai de afiliado, sem Sub_id). Ao capturar no DevTools o corpo de
// "Obter link" com o Sub_id1 preenchido, copie aqui só o nome do campo (nunca cookie nem cabeçalho).
// Preencher só esta constante não basta: o servidor só pede link com Sub_id à extensão com SUBID_PELA_EXTENSAO
// (src/lojas.js) em true. Para ligar o Sub_id pela extensão, mude os dois juntos.
const SHOPEE_SUBID_CAMPO = '';
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
  } catch {
    return { status: 0 };
  }
}
// ---- Shopee: funções puras (fim) ----

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
 * sub_id_aplicado: o Sub_id do pedido foi no corpo (só com SHOPEE_SUBID_CAMPO preenchido).
 */
async function gerarLinkShopee(job) {
  const url = urlProdutoShopee(job.url);
  if (!url) throw new Error('endereço de produto da Shopee recusado pela extensão');
  const corpo = corpoLinkShopee(url, job.subId);
  if (!corpo) throw new Error(SHOPEE_SUBID_RECUSADO);
  const subIdAplicado = !semSubId(job.subId) && !!SHOPEE_SUBID_CAMPO;
  let tabId = await abaDaShopee();
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    let res = null;
    try {
      [{ result: res } = {}] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: chamarPortalShopee, args: [corpo, SHOPEE_TIPO_PROGRAMA] });
    } catch {
      res = { semSessao: true }; // aba fechada ou fora do portal (a Shopee leva ao login, onde a extensão não entra)
    }
    const v = interpretarShopee(res);
    if (v.erro) throw new Error(v.erro);
    if (!v.semSessao) return { link: v.link, longo: v.longo, sub_id_aplicado: subIdAplicado };
    if (tentativa === 0) tabId = await recarregarShopee(tabId);
  }
  throw new Error(SHOPEE_SEM_SESSAO);
}

async function buscarOfertas(job) {
  const paginas = [];
  for (const corpo of job.paginas || []) {
    const j = await naCentral(API_LISTA, corpo);
    const model = j?.polycard_client_model;
    if (!model) throw new Error('a Central de Afiliados mudou o formato da lista');
    // devolve uma entrada por pedido, na mesma ordem (o servidor intercala as categorias)
    paginas.push({ polycard_client_model: { polycard_context: { url_prefix: model.polycard_context?.url_prefix }, polycards: model.polycards || [] } });
  }
  return paginas;
}

async function laco() {
  if (rodando) return; rodando = true;
  try {
    for (;;) {
      const c = await cfg();
      if (!c.token) { await status({ ok: false, erro: 'Cole o token do painel no ícone da extensão.' }); return; }
      let resp;
      try {
        resp = await fetch(`${c.servidor}/api/ext/poll`, { headers: { 'x-token': c.token } });
      } catch { await status({ ok: false, erro: 'Painel fechado ou endereço errado.' }); return; }
      if (resp.status === 401) { await status({ ok: false, erro: 'Token recusado. Copie de novo em Conexões → Mercado Livre, no painel.' }); return; }
      await status({ ok: true, erro: null, em: Date.now() });
      let job;
      try { ({ job } = await resp.json()); } catch { continue; }
      if (!job) continue; // long-poll voltou vazio: pergunta de novo
      let corpo;
      try {
        if (job.type === 'ofertas') corpo = { id: job.id, ok: true, data: await buscarOfertas(job) };
        else if (job.type === 'link_shopee') corpo = { id: job.id, ok: true, ...(await gerarLinkShopee(job)) };
        else corpo = { id: job.id, ok: true, link: await gerarLink(job) };
        await status({ ultimoErro: null });
      } catch (e) {
        corpo = { id: job.id, ok: false, error: String(e.message || e) };
        await status({ ultimoErro: corpo.error });
      }
      await fetch(`${c.servidor}/api/ext/result`, {
        method: 'POST', headers: { 'x-token': c.token, 'content-type': 'application/json' }, body: JSON.stringify(corpo),
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
