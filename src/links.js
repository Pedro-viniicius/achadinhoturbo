// Conversa com a extensão do Chrome, que roda no seu navegador já logado no Mercado Livre.
// Dois tipos de pedido: gerar o link de afiliado (meli.la) e buscar a lista de ofertas da
// Central de Afiliados. Nenhum cookie sai do navegador: só o link pronto ou a lista voltam.

import { amostraHub } from './afiliados.js';

const ONLINE_MS = 45000;

export function createLinkService({ getMode }) {
  const jobs = new Map();   // id -> { resolve, reject, timer, type }
  const queue = [];         // pedidos esperando a extensão buscar
  const waiters = [];       // extensão esperando pedido (long-poll)
  let seq = 0; let lastPollAt = 0; let lastOkAt = 0; let lastError = ''; let lastOffersAt = 0;

  const online = () => Date.now() - lastPollAt < ONLINE_MS;
  const status = () => ({ online: online(), lastPollAt, lastOkAt, lastOffersAt, lastError, pending: queue.length });

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
      jobs.set(id, { resolve, reject, timer, type: job.type });
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

  function submit(id, { ok, link, data, error }) {
    const e = jobs.get(id); if (!e) return false;
    clearTimeout(e.timer); jobs.delete(id);
    if (!ok) { lastError = error || 'a extensão não conseguiu'; e.reject(new Error(lastError)); return true; }
    if (e.type === 'ofertas') {
      if (!Array.isArray(data)) { lastError = 'a extensão devolveu a lista vazia'; e.reject(new Error(lastError)); return true; }
      lastOffersAt = Date.now(); e.resolve({ data }); return true;
    }
    if (/^https?:\/\//i.test(link || '')) { lastOkAt = Date.now(); lastError = ''; e.resolve({ link }); }
    else { lastError = error || 'resposta sem link'; e.reject(new Error(lastError)); }
    return true;
  }

  return { requestLink, requestOffers, poll, submit, status };
}
