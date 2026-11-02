// Conector da Central de Afiliados (achadinhoturbo): busca pedidos no painel (que roda no seu computador) e
// os executa de dentro de uma aba da Central de Afiliados do Mercado Livre, com a sua sessão.
// Dois pedidos: gerar link meli.la com a etiqueta e buscar a lista "Produtos selecionados para você".
// Só o link e a lista voltam para o painel. Cookies e tokens ficam no navegador.

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
      if (resp.status === 401) { await status({ ok: false, erro: 'Token recusado. Copie de novo em Ajustes.' }); return; }
      await status({ ok: true, erro: null, em: Date.now() });
      let job;
      try { ({ job } = await resp.json()); } catch { continue; }
      if (!job) continue; // long-poll voltou vazio: pergunta de novo
      let corpo;
      try {
        corpo = job.type === 'ofertas'
          ? { id: job.id, ok: true, data: await buscarOfertas(job) }
          : { id: job.id, ok: true, link: await gerarLink(job) };
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
