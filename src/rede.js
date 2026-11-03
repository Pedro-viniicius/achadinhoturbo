// Política de rede compartilhada pelas lojas (plano integracao-shopee, decisão 1; ADR-003). Sem raspar HTML.
//
// - resolverPorRedirecionamento(url, { hosts, extrair, paginaSemValor, fetch, cache, agora }) → { valor, urlFinal }.
//   Resolve um link (inclusive encurtador) até o valor que a loja precisa (ASIN, ids do produto…), só pelos
//   redirecionamentos:
//   - URL de entrada e cada Location: http ou https (http vira https), sem porta, sem credenciais, até 2048
//     caracteres e com o host em `hosts` (host exato ou subdomínio com ponto). Fora disso: 'invalido', sem rede.
//   - Só GET, redirect:'manual', corpo cancelado sem leitura, timeout de 8 s por salto, até 5 saltos. Lê apenas o
//     status e o Location.
//   - extrair(u: URL) → valor | null (sem rede). Se a própria entrada já traz o valor, volta sem rede.
//   - paginaSemValor(u: URL) → bool: um 2xx nesse host sem o valor é 'nao_produto' (busca, loja, campanha); o
//     resto é 'invalido'.
//   - urlFinal = origem + caminho, sem query nem fragmento (rastreio e tag de terceiro ficam para trás).
//   - Falha → FalhaDeLink { causa: 'invalido' | 'nao_produto' } com mensagem genérica; cada loja embrulha na sua
//     classe e nas suas frases.
//   - Cache (Map passado em `cache`; sem ele, nada é guardado): sucesso e 'nao_produto' por 1 h; 'invalido' por
//     10 min; a falha passageira (rede, timeout, 5xx) não entra, e a próxima chamada tenta de novo. Pedidos
//     simultâneos pela mesma URL com o mesmo cache dividem um só caminho de rede. Cada chamador recebe cópia.
// - lerCorpoLimitado(r, max) → { texto, json, recusado }. content-length acima de `max` é recusado sem ler; sem
//   content-length, lê em stream e cancela ao passar do teto. Recusado ou falha → { texto:'', json:null, recusado:true }.
//
// Segurança: nenhuma mensagem leva URL, corpo ou cabeçalho; o módulo não escreve no console.

export const MAX_URL = 2048;
const MAX_SALTOS = 5;
const TIMEOUT_LINK = 8000;
const CACHE_LINK_MS = 60 * 60 * 1000;
const CACHE_LINK_MAX = 500;
const CACHE_INVALIDO_MS = 10 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

const CAUSAS = new Set(['invalido', 'nao_produto']);

/** Link que não chegou ao valor. Mensagem genérica e fixa (nunca a URL); a loja troca pela dela. */
export class FalhaDeLink extends Error {
  constructor(causa) {
    const c = CAUSAS.has(causa) ? causa : 'invalido';
    super(c === 'nao_produto' ? 'O link não leva a um produto.' : 'Não consegui abrir o link.');
    this.name = 'FalhaDeLink';
    this.causa = c;
    this.codigo = c;
  }
}

/** O host está na lista (exato ou subdomínio com ponto)? */
export const hostDaLista = (host, lista) => {
  const h = String(host ?? '').toLowerCase();
  return !!h && lista.some((x) => h === x || h.endsWith(`.${x}`));
};

/** URL a partir de texto (aceita sem esquema: 'shp.ee/x'); null se inválida, grande demais, com credenciais ou fora de http/https. */
export function paraUrl(entrada) {
  if (typeof entrada !== 'string') return null;
  const s = entrada.trim();
  if (!s || s.length > MAX_URL) return null;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return u;
}

/** URL que o resolvedor aceita seguir: host da lista, sem porta nem credenciais; http vira https. null se não serve. */
function urlSeguivel(u, hosts) {
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port !== '') return null;
  if (!hostDaLista(u.hostname, hosts)) return null;
  if (u.protocol === 'http:') u.protocol = 'https:';
  return u;
}

const semQuery = (u) => `${u.origin}${u.pathname}`;
const copia = (v) => (v && typeof v === 'object' ? { ...v } : v);
const EM_VOO = new WeakMap(); // cache → Map(url de entrada → promessa), para juntar pedidos simultâneos

function lembrar(cache, chave, registro) {
  if (!cache) return;
  cache.delete(chave);
  cache.set(chave, registro);
  while (cache.size > CACHE_LINK_MAX) cache.delete(cache.keys().next().value);
}

/**
 * Marca interna da falha que pode passar sozinha (fetch que lançou, timeout ou 5xx): não entra no cache.
 * 429 e 4xx ficam (repetir não ajuda e só gera mais GETs).
 */
const PASSAGEIRA = Symbol('passageira');
const falhaPassageira = () => Object.assign(new FalhaDeLink('invalido'), { [PASSAGEIRA]: true });

function extrairSeguro(extrair, u) {
  try { return extrair(u) ?? null; } catch { return null; }
}

/** Resolve o link só pelos redirecionamentos (ver o contrato no topo do arquivo). */
export async function resolverPorRedirecionamento(url, { hosts, extrair, paginaSemValor = () => false, fetch: f, cache = null, agora = Date.now } = {}) {
  if (!Array.isArray(hosts) || !hosts.length || typeof extrair !== 'function') throw new FalhaDeLink('invalido');
  const inicial = urlSeguivel(paraUrl(url), hosts);
  if (!inicial) throw new FalhaDeLink('invalido');
  const direto = extrairSeguro(extrair, inicial);
  if (direto != null) return { valor: copia(direto), urlFinal: semQuery(inicial) };

  const chave = inicial.href;
  const salvo = cache?.get(chave);
  if (salvo && salvo.ate > agora()) {
    if (salvo.causa) throw new FalhaDeLink(salvo.causa);
    return { valor: copia(salvo.valor), urlFinal: salvo.urlFinal };
  }

  let emVoo = null;
  if (cache) {
    emVoo = EM_VOO.get(cache);
    if (!emVoo) { emVoo = new Map(); EM_VOO.set(cache, emVoo); }
  }
  let promessa = emVoo?.get(chave);
  if (!promessa) {
    promessa = seguir(inicial, { hosts, extrair, paginaSemValor, doFetch: f ?? globalThis.fetch }).then((r) => {
      lembrar(cache, chave, { ...r, ate: agora() + CACHE_LINK_MS });
      return r;
    }, (e) => {
      const causa = e instanceof FalhaDeLink ? e.causa : 'invalido';
      if (e?.[PASSAGEIRA]) cache?.delete(chave); // tenta de novo na próxima chamada
      else lembrar(cache, chave, { causa, ate: agora() + (causa === 'invalido' ? CACHE_INVALIDO_MS : CACHE_LINK_MS) });
      throw new FalhaDeLink(causa);
    });
    if (emVoo) {
      const p = promessa;
      emVoo.set(chave, p);
      const limpar = () => { if (emVoo.get(chave) === p) emVoo.delete(chave); };
      p.then(limpar, limpar);
    }
  }
  try {
    const r = await promessa;
    return { valor: copia(r.valor), urlFinal: r.urlFinal };
  } catch (e) {
    throw new FalhaDeLink(e?.causa); // erro novo por chamador (nada compartilhado entre eles)
  }
}

/** Segue os saltos a partir de `inicial` (já validada e sem o valor). → { valor, urlFinal } ou FalhaDeLink. */
async function seguir(inicial, { hosts, extrair, paginaSemValor, doFetch }) {
  let atual = inicial;
  for (let salto = 0; salto < MAX_SALTOS; salto++) {
    let r;
    try {
      r = await doFetch(atual.href, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_LINK),
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR' },
      });
    } catch { throw falhaPassageira(); }
    try { await r?.body?.cancel?.(); } catch { /* corpo já fechado */ }
    const status = Number(r?.status) || 0;
    if (status >= 500 && status < 600) throw falhaPassageira();

    if (status >= 300 && status < 400) {
      const location = r.headers?.get?.('location');
      if (!location) throw new FalhaDeLink('invalido');
      let prox;
      try { prox = new URL(location, atual); } catch { throw new FalhaDeLink('invalido'); }
      prox = urlSeguivel(prox, hosts);
      if (!prox || prox.href.length > MAX_URL) throw new FalhaDeLink('invalido');
      const valor = extrairSeguro(extrair, prox);
      if (valor != null) return { valor, urlFinal: semQuery(prox) };
      atual = prox;
      continue;
    }
    // Chegou a uma página (sem redirecionar): sem o valor, é busca, lista ou loja naquele host.
    let semValor = false;
    try { semValor = !!paginaSemValor(atual); } catch { /* trata como inválido */ }
    if (status >= 200 && status < 300 && semValor) throw new FalhaDeLink('nao_produto');
    throw new FalhaDeLink('invalido');
  }
  throw new FalhaDeLink('invalido'); // saltos demais
}

async function cancelarCorpo(r) {
  try { await r?.body?.cancel?.(); } catch { /* corpo já fechado ou travado */ }
}

/** Corpo da resposta como texto e JSON, com teto de `max` bytes (ver o contrato no topo do arquivo). */
export async function lerCorpoLimitado(r, max) {
  const vazio = { texto: '', json: null, recusado: true };
  if (!(Number.isFinite(max) && max > 0)) { await cancelarCorpo(r); return vazio; }
  try {
    const declarado = r?.headers?.get?.('content-length');
    if (declarado != null && declarado !== '' && !(Number(declarado) <= max)) {
      await cancelarCorpo(r);
      return vazio;
    }
    let t;
    const leitor = r?.body?.getReader?.();
    if (leitor) {
      const partes = [];
      let total = 0;
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        total += value?.byteLength ?? 0;
        if (total > max) {
          try { await leitor.cancel(); } catch { /* já fechado */ }
          return vazio;
        }
        partes.push(value);
      }
      t = Buffer.concat(partes).toString('utf8');
    } else if (r?.body == null && typeof r?.text === 'function') {
      t = await r.text(); // resposta sem stream (corpo vazio ou objeto simples)
    } else return vazio;
    if (typeof t !== 'string' || t.length > max) return vazio;
    let json = null;
    try { json = JSON.parse(t); } catch { /* não é JSON */ }
    return { texto: t, json, recusado: false };
  } catch { return vazio; }
}
