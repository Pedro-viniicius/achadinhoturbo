// Conversa com a extensão do Chrome, que roda no seu navegador já logado no Mercado Livre
// (e no portal de afiliados da Shopee). Três tipos de pedido: gerar o link de afiliado do ML
// (meli.la), gerar o link de afiliado da Shopee (s.shopee.com.br, pelo Link personalizado do
// portal) e buscar a lista de ofertas da Central de Afiliados. Nenhum cookie sai do navegador:
// só o link pronto ou a lista voltam.

import { amostraHub, validarPaginas } from './afiliados.js';
import { LINK_SHOPEE, RE_SUB_ID } from './shopee.js';

// No modo extensão só aceitamos o link curto do Mercado Livre: quem tiver o token não consegue
// fazer o programa publicar uma URL qualquer nos grupos.
export const LINK_MELI = /^https:\/\/meli\.la\/[A-Za-z0-9_-]{3,40}$/;

// O link da Shopee só é aceito no formato curto oficial (LINK_SHOPEE de src/shopee.js), em qualquer
// modo: a Shopee nunca sai sem afiliado.
// O pedido só leva à extensão o endereço do produto já normalizado pelo servidor:
// shopee.com.br, caminho em ASCII visível, sem `?` nem `#` (sem parâmetros).
const URL_PRODUTO_SHOPEE = /^https:\/\/shopee\.com\.br\/[!"$->@-~]*$/;
const MAX_URL = 2048;
// Sub_id1 da Shopee (plano dashboard-ganhos, D3): RE_SUB_ID de src/shopee.js; extension/background.js confere de novo.
const semSubId = (v) => v === undefined || v === null || v === '';

/**
 * O `longo` (longLink) só serve para conferir o ID de afiliado. Vale só se for https, num host
 * da Shopee (shopee.com.br ou subdomínio), sem porta nem credenciais e com até 2048 caracteres;
 * qualquer outra coisa é descartada (null), sem recusar o link curto.
 */
function longoDaShopee(v) {
  if (typeof v !== 'string' || !v || v.length > MAX_URL) return null;
  let u;
  try { u = new URL(v.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const daShopee = host === 'shopee.com.br' || host.endsWith('.shopee.com.br');
  if (u.protocol !== 'https:' || !daShopee || u.port || u.username || u.password) return null;
  return u.href;
}

const ONLINE_MS = 45000;
// Teto de pedidos de link da Shopee à extensão (S2): o portal de afiliados não é feito para geração em massa.
const JANELA_SHOPEE_MS = 3600 * 1000;
const LIMITE_SHOPEE_HORA = 60;
export const LIMITE_SHOPEE_ATINGIDO = 'Limite de links da Shopee por hora atingido; tente mais tarde.';
const MAX_ERRO = 300; // o erro vem da extensão (texto livre): vai para o log, para a tela e para /api/state
const erroCurto = (t) => String(t).slice(0, MAX_ERRO);

/**
 * getMode(): 'extension' | 'direct' | 'fake'. limiteShopeeHora: pedidos `link_shopee` que vão à extensão por
 * hora (padrão 60). agora: relógio da janela desse teto (injetado nos testes).
 * status(): lastOkAt/lastError são do link do ML; shopeeLastOkAt/shopeeLastError, do link da Shopee (R4).
 */
export function createLinkService({ getMode, limiteShopeeHora = LIMITE_SHOPEE_HORA, agora = Date.now }) {
  const jobs = new Map();   // id -> { resolve, reject, timer, type }
  const queue = [];         // pedidos esperando a extensão buscar
  const waiters = [];       // extensão esperando pedido (long-poll)
  let seq = 0; let lastPollAt = 0; let lastOkAt = 0; let lastError = ''; let lastOffersAt = 0;
  let shopeeLastOkAt = 0; let shopeeLastError = '';
  const tetoShopee = Number.isInteger(limiteShopeeHora) && limiteShopeeHora > 0 ? limiteShopeeHora : LIMITE_SHOPEE_HORA;
  const pedidosShopee = []; // instantes dos pedidos link_shopee entregues à fila na última hora

  const online = () => Date.now() - lastPollAt < ONLINE_MS;
  const status = () => ({ online: online(), lastPollAt, lastOkAt, lastOffersAt, lastError, shopeeLastOkAt, shopeeLastError, pending: queue.length });

  /**
   * Quantos pedidos link_shopee ainda cabem na janela de 1 h (0 = o próximo é recusado com LIMITE_SHOPEE_ATINGIDO).
   * src/lojas.js consulta antes de pedir um Sub_id (`reservaVagas`, que o envio passa), para deixar vagas ao link base.
   * Na simulação o teto não vale, e as vagas não mudam.
   */
  function vagasShopee() {
    const limite = agora() - JANELA_SHOPEE_MS;
    while (pedidosShopee.length && pedidosShopee[0] <= limite) pedidosShopee.shift();
    return Math.max(0, tetoShopee - pedidosShopee.length);
  }

  function flush() {
    while (waiters.length && queue.length) {
      const w = waiters.shift(); clearTimeout(w.t); w.res(queue.shift());
    }
  }

  /** Entrega um pedido para a extensão e espera a resposta. */
  function ask(job, timeoutMs) {
    if (!online()) return Promise.reject(new Error('a extensão do Chrome não está conectada (abra o Chrome com a extensão instalada)'));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        jobs.delete(id);
        const i = queue.findIndex((j) => j.id === id); if (i >= 0) queue.splice(i, 1);
        reject(new Error('a extensão não respondeu a tempo'));
      }, timeoutMs);
      jobs.set(id, { resolve, reject, timer, type: job.type, subId: job.subId });
      queue.push({ id, ...job });
      flush();
    });
  }

  /** modo: 'extension' (padrão) | 'direct' (usa a URL como está, SEM comissão) | 'fake' (simulação/testes) */
  async function requestLink({ url, tag, timeoutMs = 90000 }) {
    const mode = getMode();
    if (mode === 'direct') return url;
    if (mode === 'fake') return `https://meli.la/fake-${encodeURIComponent(tag)}-${++seq}`;
    const { link } = await ask({ type: 'link', url, tag }, timeoutMs);
    return link;
  }

  /**
   * Link de afiliado da Shopee para o endereço do produto (`https://shopee.com.br/…`, sem parâmetros).
   * Devolve `{ link, longo, subIdAplicado }`: `link` sempre passa em LINK_SHOPEE; `longo` é o longLink (ou null).
   * `subId` (opcional, RE_SUB_ID; vazio = sem Sub_id) vai no pedido; `subIdAplicado` só é true quando a extensão
   * responde `sub_id_aplicado: true` (a extensão antiga não responde o campo: o link sai sem Sub_id).
   * O modo 'direct' do ML não vale aqui: fora da simulação, o link sai sempre pela extensão.
   * Teto: `limiteShopeeHora` pedidos entregues à extensão por hora (o que a extensão off-line recusou não conta);
   * passou → LIMITE_SHOPEE_ATINGIDO, sem pedido. A simulação (fake) não conta e simula a extensão que aplica o Sub_id.
   */
  async function requestLinkShopee({ url, subId, timeoutMs = 90000 }) {
    if (typeof url !== 'string' || url.length > MAX_URL || !URL_PRODUTO_SHOPEE.test(url)) {
      throw new Error('endereço de produto da Shopee inválido');
    }
    const comSubId = !semSubId(subId);
    if (comSubId && !(typeof subId === 'string' && RE_SUB_ID.test(subId))) throw new Error('Sub_id da Shopee inválido');
    if (getMode() === 'fake') return { link: `https://s.shopee.com.br/fake${++seq}`, longo: null, subIdAplicado: comSubId };
    if (vagasShopee() === 0) throw new Error(LIMITE_SHOPEE_ATINGIDO);
    if (online()) pedidosShopee.push(agora()); // off-line, ask recusa sem pôr na fila
    // sem Sub_id, o pedido é o de antes (sem o campo)
    return ask(comSubId ? { type: 'link_shopee', url, subId } : { type: 'link_shopee', url }, timeoutMs);
  }

  /** Busca páginas da lista da Central de Afiliados. `paginas` = corpos prontos (ver afiliados.js). */
  async function requestOffers({ paginas, timeoutMs = 60000 }) {
    if (getMode() === 'fake') return amostraHub();
    const { data } = await ask({ type: 'ofertas', paginas }, timeoutMs);
    return data;
  }

  function poll(waitMs = 20000) {
    lastPollAt = Date.now();
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((res) => {
      const w = { res };
      w.t = setTimeout(() => {
        const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1);
        lastPollAt = Date.now(); res(null);
      }, waitMs);
      waiters.push(w);
    });
  }

  /** Resposta a um pedido link_shopee: resultado em shopeeLastOkAt/shopeeLastError (o estado do ML não muda). */
  function respostaShopee(e, { ok, link, longo, error, sub_id_aplicado: aplicado }) {
    const l = String(link || '').trim();
    if (ok && LINK_SHOPEE.test(l)) {
      shopeeLastOkAt = Date.now(); shopeeLastError = '';
      // só vale o true literal, e só se o pedido levou Sub_id
      e.resolve({ link: l, longo: longoDaShopee(longo), subIdAplicado: e.subId !== undefined && aplicado === true });
      return true;
    }
    shopeeLastError = erroCurto(!ok ? error || 'a extensão não conseguiu'
      : error || (l ? 'a extensão devolveu um link que não é s.shopee.com.br; recusado' : 'resposta sem link'));
    e.reject(new Error(shopeeLastError));
    return true;
  }

  function submit(id, { ok, link, longo, data, error, sub_id_aplicado }) {
    const e = jobs.get(id); if (!e) return false;
    clearTimeout(e.timer); jobs.delete(id);
    if (e.type === 'link_shopee') return respostaShopee(e, { ok, link, longo, error, sub_id_aplicado });
    if (!ok) { lastError = erroCurto(error || 'a extensão não conseguiu'); e.reject(new Error(lastError)); return true; }
    if (e.type === 'ofertas') {
      const v = validarPaginas(data);
      if (!v.ok) { lastError = v.erro; e.reject(new Error(lastError)); return true; }
      lastOffersAt = Date.now(); e.resolve({ data: v.paginas }); return true;
    }
    const l = String(link || '').trim();
    const valido = getMode() === 'extension' ? LINK_MELI.test(l) : /^https?:\/\//i.test(l);
    if (valido) { lastOkAt = Date.now(); lastError = ''; e.resolve({ link: l }); }
    else { lastError = erroCurto(error || (l ? 'a extensão devolveu um link que não é meli.la; recusado' : 'resposta sem link')); e.reject(new Error(lastError)); }
    return true;
  }

  // modo(): o modo em que requestLink vai gerar o link agora (quem precisa saber se a extensão é necessária pergunta aqui)
  return { requestLink, requestLinkShopee, requestOffers, poll, submit, status, vagasShopee, modo: () => getMode() };
}
