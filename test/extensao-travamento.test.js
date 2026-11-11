// Extensão do Chrome: a Central de Afiliados do Mercado Livre não responde e a extensão não pode travar para sempre.
// Relato (Trello, 05/11/2026): `gerarLink` -> `naCentral` -> `executeScript(chamarCentral)` nunca voltou, o laço
// parou de fazer poll e o alarme `despertar` não religou porque `rodando` ficou `true`. O servidor desiste em 90 s.
//
// Técnica: o extension/background.js inteiro num `vm` com `chrome.*`, `fetch`, `setTimeout`, `AbortSignal.timeout` e
// `Date` falsos, todos presos a UM relógio virtual (`avancar(ms)`): nenhum teste espera segundos reais, e nenhum chama
// o Mercado Livre. "Travar" é simulado de dois jeitos:
//   - fetch da Central pendurado (respeita `init.signal`, como o fetch de verdade: sem sinal, nunca volta);
//   - aba congelada: `chrome.scripting.executeScript` nunca resolve (o que o cartão descreve).
// O trabalho que "trava" é reconhecido pelo texto "congela" no pedido (url/etiqueta/corpo), para que as tentativas
// seguintes e os outros jobs não dependam de contar chamadas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTE = fs.readFileSync(path.join(RAIZ, 'extension', 'background.js'), 'utf8');

const ML = 'https://www.mercadolivre.com.br';
const CENTRAL = `${ML}/afiliados/hub?is_affiliate=true`;
const PORTAL = 'https://affiliate.shopee.com.br';
const SERVIDOR = 'http://127.0.0.1:3737';
const LIMITE_SERVIDOR = 90_000; // prazo mais longo do servidor (link da Shopee): "a extensão não respondeu a tempo"
// Prazo do servidor por tipo de pedido (src/links.js): link do ML 45 s desde a entrega 2, lista 60 s, Shopee 90 s.
const PRAZO_SERVIDOR = { link: 45_000, ofertas: 60_000, link_shopee: 90_000 };
const VERSAO_TESTE = '7.8.9'; // versão do manifest falso: o teste nunca depende do número do manifest.json
const LINK_OK = 'https://meli.la/2abcDEF';
const PRODUTO_SHOPEE = 'https://shopee.com.br/Produto-Normal-i.52377417.6309028319';
const PRODUTO_SHOPEE_CONGELA = 'https://shopee.com.br/Produto-Congela-i.52377417.6309028319';
const CORPO_LISTA = { categoria: 'MLB1', pagina: 1 };

const respostaLink = () => ({ urls: [{ short_url: LINK_OK }] });
const respostaLista = () => ({ polycard_client_model: { polycard_context: { url_prefix: 'https://p/' }, polycards: [{ id: 'MLB1' }] } });
const plano = (v) => JSON.parse(JSON.stringify(v)); // objetos do vm têm outro protótipo
const congelado = (v) => JSON.stringify(v).toLowerCase().includes('congela');

/**
 * Sobe o background.js com tudo falso e relógio virtual.
 *  - jobs: pedidos que o painel entrega no long-poll (a fila aceita `empilhar` depois).
 *  - pollVazio: 'longo' = sem pedido, o painel segura 25 s e responde { job: null } (como o servidor);
 *               'cai' = sem pedido, o painel "fecha" (o fetch do poll falha) e o laço termina.
 *  - modoCentral(job-ish, n): o que o fetch da Central faz: 'ok' | 'pendurar' (só volta se `signal` abortar) | número (ms de demora).
 *  - congelar(args): true = o executeScript nunca resolve.
 *  - tardio(args): ms depois dos quais um executeScript "congelado" finalmente resolve com o resultado de sempre.
 *  - semCsrf: a página da Central não tem o meta csrf-token (sessão vencida).
 *  - abas: as abas abertas ({ id, url, status, discarded? }); aba descartada recusa o executeScript até ser recarregada.
 *  - falhaInjecao(aba, args): texto de erro com que o executeScript falha (como o Chrome), ou null.
 *  - manifest: o que chrome.runtime.getManifest() devolve (a versão do teste, nunca a do arquivo).
 *  - demoraCarregar: ms até a aba que abre ou recarrega avisar que terminou de carregar (onUpdated 'complete').
 * modoCentral também aceita 'rede' (o fetch falha) e { status, corpo } (a Central responde isso).
 */
function montar({
  jobs = [], pollVazio = 'longo', modoCentral = () => 'ok', congelar = () => false, tardio = () => null, semCsrf = false, abas,
  falhaInjecao = () => null, manifest = { version: VERSAO_TESTE }, demoraCarregar = 0,
} = {}) {
  let agora = 0; const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);
  const timers = []; let seqTimer = 0;
  const setTimeoutV = (f, ms = 0, ...a) => { const id = ++seqTimer; timers.push({ id, em: agora + Number(ms || 0), f: () => f(...a) }); return id; };
  const clearTimeoutV = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const esperar = (ms) => new Promise((ok) => setTimeoutV(ok, ms));
  const drenar = async () => { for (let i = 0; i < 3; i++) { await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 0)); } };
  async function avancar(ms) {
    const alvo = agora + ms;
    await drenar();
    for (let guarda = 0; guarda < 20000; guarda++) {
      const prox = timers.filter((t) => t.em <= alvo).sort((a, b) => a.em - b.em || a.id - b.id)[0];
      if (!prox) break;
      timers.splice(timers.indexOf(prox), 1);
      agora = Math.max(agora, prox.em);
      prox.f();
      await drenar();
    }
    agora = alvo;
    await drenar();
  }
  const AbortSignalV = {
    timeout: (ms) => { const c = new AbortController(); setTimeoutV(() => c.abort(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })), ms); return c.signal; },
    any: (...a) => AbortSignal.any(...a), abort: (...a) => AbortSignal.abort(...a),
  };
  class DataV extends Date {
    constructor(...a) { if (a.length) super(...a); else super(T0 + agora); }
    static now() { return T0 + agora; }
  }

  const resultados = []; const tempos = []; const eventos = []; const fetchesCentral = [];
  const navegacoes = []; const recargas = []; const cabecalhosPoll = [];
  const armazenado = { conf: { servidor: SERVIDOR, token: 'tok-painel' }, st: {} };
  const sessao = {}; // chrome.storage.session: some quando o Chrome reinicia, fica quando só o service worker reinicia
  const fila = [...jobs];
  const ouvintes = new Set(); const alarmes = [];
  const tabs = new Map((abas || [
    { id: 5, url: CENTRAL, status: 'complete' },
    { id: 6, url: `${PORTAL}/offer/custom_link`, status: 'complete' },
  ]).map((t) => [t.id, { ...t }]));
  let seqAba = 100; let nCentral = 0; let pollsVazios = 0; let polls = 0;

  const carregar = (aba, url) => {
    aba.url = url; aba.status = 'complete'; aba.discarded = false;
    setTimeoutV(() => { for (const f of [...ouvintes]) f(aba.id, { status: 'complete' }); }, demoraCarregar);
  };
  const casa = (padrao, url) => new RegExp(`^${padrao.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(url || '');
  const area = (dados) => ({
    get: async (k) => Object.fromEntries([k].flat().filter((c) => c in dados).map((c) => [c, structuredClone(dados[c])])),
    set: async (o) => { Object.assign(dados, structuredClone(o)); },
    remove: async (k) => { for (const c of [k].flat()) delete dados[c]; },
  });
  const chrome = {
    storage: {
      local: area(armazenado),
      session: area(sessao),
      onChanged: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener: (f) => alarmes.push(f) } },
    runtime: { onStartup: { addListener() {} }, onInstalled: { addListener() {} }, getManifest: () => structuredClone(manifest) },
    permissions: { remove: async () => true },
    tabs: {
      onUpdated: { addListener: (f) => ouvintes.add(f), removeListener: (f) => ouvintes.delete(f) },
      query: async ({ url }) => [...tabs.values()].filter((t) => casa(url, t.url)).map((t) => ({ ...t })),
      get: async (id) => { if (!tabs.has(id)) throw new Error('No tab'); return { ...tabs.get(id) }; },
      create: async ({ url, active, pinned }) => {
        const aba = { id: ++seqAba, active, pinned }; tabs.set(aba.id, aba); eventos.push('create'); carregar(aba, url); return { id: aba.id };
      },
      update: async (id, { url }) => {
        const aba = tabs.get(id); if (!aba) throw new Error('No tab'); eventos.push('reload'); navegacoes.push({ id, url }); carregar(aba, url || aba.url); return { id };
      },
      reload: async (id) => { const aba = tabs.get(id); if (!aba) throw new Error('No tab'); eventos.push('reload'); recargas.push(id); carregar(aba, aba.url); },
      remove: async (id) => { tabs.delete(id); eventos.push('remove'); },
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        const aba = tabs.get(target.tabId);
        if (!aba) throw new Error('No tab with id');
        if (aba.discarded) throw new Error('The tab was discarded.');
        const falha = falhaInjecao(aba, args);
        if (falha) throw new Error(falha);
        const marca = congelado(args) ? 'congela' : 'normal';
        eventos.push(`inject:${marca}`);
        if (congelar(args)) {
          const ms = tardio(args);
          if (ms == null) return new Promise(() => {});
          await esperar(ms);
        }
        ctx.location = new URL(aba.url);
        ctx.document = { querySelector: () => (semCsrf ? null : { content: 'csrf-da-pagina' }) };
        return [{ result: await func(...args) }];
      },
    },
  };

  const fetchV = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin === ML) {
      const corpo = init.body ? JSON.parse(init.body) : null;
      const marca = congelado(corpo) ? 'congela' : 'normal';
      const n = ++nCentral;
      eventos.push(`fetch:${marca}`);
      fetchesCentral.push({ url: String(url), ...init, headers: { ...(init.headers || {}) }, n });
      const modo = modoCentral(corpo, n);
      const sinal = init.signal;
      if (modo === 'pendurar') {
        return new Promise((_, rej) => {
          const abortou = () => rej(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
          if (sinal?.aborted) return abortou();
          sinal?.addEventListener?.('abort', abortou, { once: true });
        });
      }
      if (modo === 'rede') throw new TypeError('Failed to fetch');
      if (modo && typeof modo === 'object') return new Response(modo.corpo, { status: modo.status });
      if (typeof modo === 'number') await esperar(modo);
      return new Response(JSON.stringify(u.pathname.includes('/hub/search') ? respostaLista() : respostaLink()), { status: 200 });
    }
    if (u.origin === PORTAL) throw new Error('o teste não simula o portal da Shopee');
    assert.equal(u.origin, SERVIDOR, `fetch inesperado: ${url}`);
    assert.equal(init.headers['x-token'], 'tok-painel');
    if (u.pathname === '/api/ext/poll') {
      polls++;
      cabecalhosPoll.push({ ...init.headers });
      if (fila.length) return new Response(JSON.stringify({ job: fila.shift() }), { status: 200 });
      pollsVazios++;
      if (pollVazio === 'cai') throw new TypeError('Failed to fetch');
      await esperar(25_000);
      if (fila.length) return new Response(JSON.stringify({ job: fila.shift() }), { status: 200 });
      return new Response('{"job":null}', { status: 200 });
    }
    if (u.pathname === '/api/ext/result') {
      const corpo = JSON.parse(init.body);
      resultados.push(corpo); tempos.push(agora);
      return new Response('{}');
    }
    throw new Error(`rota inesperada: ${url}`);
  };

  const espiao = new Proxy({}, { get: (_, nome) => (...a) => { throw new Error(`console.${String(nome)} proibido: ${a.join(' ')}`); } });
  let ctx;
  const subir = () => {
    alarmes.length = 0; // o service worker antigo morreu: o alarme acorda só o novo
    ctx = vm.createContext({
      chrome, fetch: fetchV, URL, Response, Headers, AbortController, AbortSignal: AbortSignalV, structuredClone, console: espiao,
      setTimeout: setTimeoutV, clearTimeout: clearTimeoutV, Date: DataV,
    });
    vm.runInContext(FONTE, ctx, { filename: 'background.js' });
  };
  subir();
  return {
    get ctx() { return ctx; }, avancar, resultados, tempos, eventos, fetchesCentral, armazenado, sessao,
    navegacoes, recargas, cabecalhosPoll, abas: tabs,
    /** O Chrome encerra o service worker e o sobe de novo: as variáveis somem, chrome.storage fica. */
    reiniciarWorker: subir,
    empilhar: (job) => fila.push(job),
    alarme: () => alarmes.forEach((f) => f({ name: 'despertar' })),
    get agora() { return agora; },
    get polls() { return polls; },
    get pollsVazios() { return pollsVazios; },
  };
}

const jobLink = (id, etiqueta = 'minhaetiqueta', url = 'https://www.mercadolivre.com.br/produto-normal/p/MLB1') => ({ id, type: 'link', url, tag: etiqueta });
const jobOfertas = (id, corpo = CORPO_LISTA) => ({ id, type: 'ofertas', paginas: [corpo] });
const jobShopee = (id, url = PRODUTO_SHOPEE) => ({ id, type: 'link_shopee', url });
const porId = (m, id) => m.resultados.filter((r) => r.id === id);

// ---------------- CA1: o fetch de chamarCentral tem tempo limite ----------------

test('CA1: chamarCentral com a Central pendurada devolve um resultado de erro em vez de ficar pendurada', async () => {
  const m = montar({ pollVazio: 'cai', modoCentral: () => 'pendurar' });
  await m.avancar(0);
  m.ctx.location = new URL(CENTRAL);
  m.ctx.document = { querySelector: () => ({ content: 'csrf-da-pagina' }) };
  let fim = null;
  m.ctx.chamarCentral('/affiliate-program/api/v2/affiliates/createLink', { urls: ['https://x'], tag: 't' })
    .then((v) => { fim = { v }; }, (e) => { fim = { e }; });
  await m.avancar(45_000); // a Shopee usa 20 s; 45 s já é mais que o dobro e menos que os 90 s do servidor
  assert.ok(fim, 'chamarCentral continuou pendurada 45 s depois: o fetch não tem tempo limite');
  assert.ok(!fim.e, `chamarCentral lançou em vez de devolver um resultado de erro: ${fim.e?.message}`);
  assert.equal(typeof fim.v, 'object');
  assert.ok(fim.v, 'sem resultado');
  assert.ok(!(fim.v.status >= 200 && fim.v.status < 300), `o resultado de estouro não pode parecer sucesso: ${JSON.stringify(plano(fim.v))}`);
  assert.equal(fim.v.texto, undefined, 'não há corpo de resposta quando a Central não respondeu');
});

test('CA1: o limite de tempo não corta uma Central lenta que responde (8 s)', async () => {
  const m = montar({ pollVazio: 'cai', modoCentral: () => 8000 });
  await m.avancar(0);
  m.ctx.location = new URL(CENTRAL);
  m.ctx.document = { querySelector: () => ({ content: 'csrf-da-pagina' }) };
  let fim = null;
  m.ctx.chamarCentral('/affiliate-program/api/v2/affiliates/createLink', { urls: ['https://x'], tag: 't' }).then((v) => { fim = { v }; }, (e) => { fim = { e }; });
  await m.avancar(9000);
  assert.ok(fim && fim.v, `não terminou em 9 s: ${fim?.e?.message || 'pendurada'}`);
  assert.equal(fim.v.status, 200);
  assert.deepEqual(JSON.parse(fim.v.texto), respostaLink());
});

// ---------------- CA2: teto por job ----------------

const TIPOS = [
  ['link do ML (gerarLink)', (id) => jobLink(id, 'etiqueta-congela', 'https://www.mercadolivre.com.br/congela/p/MLB1')],
  ['lista de ofertas (buscarOfertas)', (id) => jobOfertas(id, { ...CORPO_LISTA, q: 'congela' })],
  ['link da Shopee (gerarLinkShopee)', (id) => jobShopee(id, PRODUTO_SHOPEE_CONGELA)],
];

for (const [nome, fazer] of TIPOS) {
  test(`CA2: ${nome} com a aba congelada: o laço manda ok:false antes do prazo do servidor, e segue no poll`, async () => {
    const m = montar({ jobs: [fazer(1), jobLink(2)], congelar: congelado });
    await m.avancar(120_000);
    const r1 = porId(m, 1);
    assert.equal(r1.length, 1, `esperava exatamente 1 resultado do job 1, veio ${JSON.stringify(m.resultados)}`);
    assert.equal(r1[0].ok, false);
    assert.equal(typeof r1[0].error, 'string');
    assert.ok(r1[0].error.length > 5, 'mensagem de erro vazia');
    const prazo = PRAZO_SERVIDOR[fazer(0).type];
    assert.ok(m.tempos[m.resultados.indexOf(r1[0])] < prazo, `o erro só saiu aos ${m.tempos[m.resultados.indexOf(r1[0])]} ms (o servidor desiste aos ${prazo} ms)`);
    // o laço seguiu vivo: o job seguinte foi entregue, depois dele o poll continua
    const r2 = porId(m, 2);
    assert.equal(r2.length, 1, 'o job seguinte nunca foi processado: o laço morreu junto com o job travado');
    assert.deepEqual(plano(r2[0]), { id: 2, ok: true, link: LINK_OK });
    assert.ok(m.polls >= 3, `o laço deveria continuar perguntando ao painel (polls: ${m.polls})`);
  });
}

test('CA2: ultimoErro guarda a mensagem do estouro (a mesma que foi ao painel)', async () => {
  const m = montar({ jobs: [jobLink(1, 'etiqueta-congela', 'https://www.mercadolivre.com.br/congela/p/MLB1')], pollVazio: 'cai', congelar: congelado });
  await m.avancar(LIMITE_SERVIDOR);
  const [r] = porId(m, 1);
  assert.ok(r, 'nenhum resultado até os 90 s');
  assert.equal(r.ok, false);
  assert.equal(m.armazenado.st.ultimoErro, r.error);
});

test('CA2: a mensagem de estouro não vaza a etiqueta, a URL nem o token do painel', async () => {
  const m = montar({ jobs: [jobLink(1, 'etiqueta-congela-segredo', 'https://www.mercadolivre.com.br/congela/p/MLB1')], pollVazio: 'cai', congelar: congelado });
  await m.avancar(LIMITE_SERVIDOR);
  const [r] = porId(m, 1);
  assert.ok(r, 'nenhum resultado até os 90 s');
  assert.ok(!r.error.includes('csrf-da-pagina') && !r.error.includes('tok-painel'));
  assert.ok(!r.error.includes('etiqueta-congela-segredo') && !r.error.includes('/congela/p/MLB1'), `a mensagem leva dados do pedido: ${r.error}`);
});

test('CA2: resposta tardia do job que estourou não gera um segundo resultado para o mesmo id', async () => {
  const m = montar({
    jobs: [jobLink(1, 'etiqueta-congela', 'https://www.mercadolivre.com.br/congela/p/MLB1')],
    congelar: congelado, tardio: () => 150_000, // a aba "descongela" aos 150 s e devolve um link válido
  });
  await m.avancar(LIMITE_SERVIDOR);
  assert.equal(porId(m, 1).length, 1, 'o job estourado deveria ter respondido antes dos 90 s');
  await m.avancar(200_000);
  const r1 = porId(m, 1);
  assert.equal(r1.length, 1, `resultado duplicado para o mesmo pedido: ${JSON.stringify(r1)}`);
  assert.equal(r1[0].ok, false);
});

// ---------------- CA2 + CA1 + CA4: a Central não responde ao fetch ----------------

test('CA1/CA2/CA4: fetch da Central pendurado: o job responde ok:false a tempo, a aba é recarregada e o próximo job funciona', async () => {
  const m = montar({
    jobs: [jobLink(1, 'etiqueta-congela', 'https://www.mercadolivre.com.br/congela/p/MLB1'), jobLink(2)],
    modoCentral: (corpo) => (congelado(corpo) ? 'pendurar' : 'ok'),
  });
  await m.avancar(120_000);
  const [r1] = porId(m, 1);
  assert.ok(r1, 'a Central não respondeu e a extensão nunca devolveu resultado do job 1');
  assert.equal(r1.ok, false);
  assert.ok(m.tempos[m.resultados.indexOf(r1)] < PRAZO_SERVIDOR.link);
  const [r2] = porId(m, 2);
  assert.deepEqual(plano(r2), { id: 2, ok: true, link: LINK_OK });
  // CA4: entre a chamada que passou do tempo e a primeira chamada do próximo job, a aba foi recarregada ou reaberta
  const i1 = m.eventos.indexOf('fetch:congela');
  const i2 = m.eventos.indexOf('fetch:normal');
  assert.ok(i1 >= 0 && i2 > i1, `sequência inesperada: ${m.eventos.join(',')}`);
  const entre = m.eventos.slice(i1, i2);
  assert.ok(entre.some((e) => e === 'reload' || e === 'create'), `a aba da Central não foi recarregada nem reaberta depois do estouro: ${entre.join(',')}`);
});

test('CA4: aba congelada (executeScript nunca volta): a aba da Central é recarregada ou reaberta antes do próximo job', async () => {
  const m = montar({
    jobs: [jobLink(1, 'etiqueta-congela', 'https://www.mercadolivre.com.br/congela/p/MLB1'), jobLink(2)],
    congelar: congelado,
  });
  await m.avancar(150_000);
  assert.equal(porId(m, 2).length, 1, 'o job seguinte não foi processado');
  const i1 = m.eventos.indexOf('inject:congela');
  const i2 = m.eventos.indexOf('inject:normal');
  assert.ok(i1 >= 0 && i2 > i1, `sequência inesperada: ${m.eventos.join(',')}`);
  const entre = m.eventos.slice(i1, i2);
  assert.ok(entre.some((e) => e === 'reload' || e === 'create'), `a aba da Central não foi recarregada nem reaberta depois do estouro: ${entre.join(',')}`);
});

// ---------------- CA3: o laço continua vivo / o alarme religa ----------------

test('CA3: depois do estouro, o laço termina (painel fecha) com rodando = false e o alarme `despertar` religa e entrega o próximo job', async () => {
  const m = montar({
    jobs: [jobLink(1, 'etiqueta-congela', 'https://www.mercadolivre.com.br/congela/p/MLB1')], pollVazio: 'cai', congelar: congelado,
  });
  // o alarme de 30 s dispara enquanto o job está pendurado
  for (let t = 0; t < 3; t++) { await m.avancar(30_000); m.alarme(); }
  assert.equal(porId(m, 1).length, 1, 'o job travado nunca devolveu resultado');
  m.empilhar(jobLink(2));
  await m.avancar(30_000);
  m.alarme();
  await m.avancar(5_000);
  const r2 = porId(m, 2);
  assert.equal(r2.length, 1, 'o alarme não religou o laço (rodando ficou true)');
  assert.deepEqual(plano(r2[0]), { id: 2, ok: true, link: LINK_OK });
});

test('CA3: com o painel respondendo sempre, um job entregue muito depois do estouro ainda é atendido (alarmes de 30 s rodando)', async () => {
  const m = montar({ jobs: [jobLink(1, 'etiqueta-congela', 'https://www.mercadolivre.com.br/congela/p/MLB1')], congelar: congelado });
  for (let t = 0; t < 4; t++) { await m.avancar(30_000); m.alarme(); } // 120 s
  assert.equal(porId(m, 1).length, 1);
  m.empilhar(jobLink(3));
  for (let t = 0; t < 3; t++) { await m.avancar(30_000); m.alarme(); }
  const r3 = porId(m, 3);
  assert.equal(r3.length, 1, 'o job posterior nunca foi atendido');
  assert.equal(r3[0].ok, true);
});

test('CA3: dois jobs seguidos travando não impedem o terceiro', async () => {
  const m = montar({
    jobs: [
      jobLink(1, 'etiqueta-congela', 'https://www.mercadolivre.com.br/congela/p/MLB1'),
      jobOfertas(2, { ...CORPO_LISTA, q: 'congela' }),
      jobLink(3),
    ],
    congelar: congelado,
  });
  await m.avancar(300_000);
  assert.deepEqual(m.resultados.map((r) => [r.id, r.ok]), [[1, false], [2, false], [3, true]]);
});

// ---------------- CA5: o caminho feliz não muda ----------------

test('CA5: link do ML devolve { id, ok: true, link } e a chamada à Central é a de sempre', async () => {
  const m = montar({ jobs: [jobLink(1, 'minhaetiqueta')], pollVazio: 'cai' });
  await m.avancar(5000);
  assert.deepEqual(plano(m.resultados), [{ id: 1, ok: true, link: LINK_OK }]);
  assert.equal(m.armazenado.st.ultimoErro, null);
  assert.equal(m.fetchesCentral.length, 1);
  const f = m.fetchesCentral[0];
  assert.equal(f.url, `${ML}/affiliate-program/api/v2/affiliates/createLink`);
  assert.equal(f.method, 'POST');
  assert.equal(f.credentials, 'include');
  assert.equal(f.headers['x-csrf-token'], 'csrf-da-pagina');
  assert.equal(f.headers['x-custom-origin'], ML);
  assert.deepEqual(JSON.parse(f.body), { urls: ['https://www.mercadolivre.com.br/produto-normal/p/MLB1'], tag: 'minhaetiqueta' });
  assert.ok(!JSON.stringify(m.resultados).includes('csrf-da-pagina'), 'o token anti-CSRF não sai da aba');
});

test('CA5: lista de ofertas devolve uma entrada por página, no formato de sempre', async () => {
  const m = montar({ jobs: [{ id: 4, type: 'ofertas', paginas: [CORPO_LISTA, { ...CORPO_LISTA, pagina: 2 }] }], pollVazio: 'cai' });
  await m.avancar(5000);
  const esperado = { polycard_client_model: { polycard_context: { url_prefix: 'https://p/' }, polycards: [{ id: 'MLB1' }] } };
  assert.deepEqual(plano(m.resultados), [{ id: 4, ok: true, data: [esperado, esperado] }]);
  assert.deepEqual(m.fetchesCentral.map((f) => JSON.parse(f.body)), [CORPO_LISTA, { ...CORPO_LISTA, pagina: 2 }]);
});

test('CA5: uma Central lenta (8 s por chamada) mas que responde não vira erro, nem em lista de várias páginas', async () => {
  const m = montar({
    jobs: [jobLink(1), { id: 2, type: 'ofertas', paginas: [CORPO_LISTA, { ...CORPO_LISTA, pagina: 2 }, { ...CORPO_LISTA, pagina: 3 }] }],
    pollVazio: 'cai', modoCentral: () => 8000,
  });
  await m.avancar(60_000);
  assert.deepEqual(m.resultados.map((r) => [r.id, r.ok]), [[1, true], [2, true]]);
  assert.equal(m.resultados[1].data.length, 3);
});

test('CA5: sem sessão (página sem csrf-token) recarrega a aba uma vez e devolve a mensagem de sempre', async () => {
  const m = montar({ jobs: [jobLink(1)], pollVazio: 'cai', semCsrf: true });
  await m.avancar(60_000);
  assert.equal(m.resultados.length, 1);
  assert.equal(m.resultados[0].ok, false);
  assert.match(m.resultados[0].error, /não há sessão de afiliado neste Chrome/);
  assert.equal(m.eventos.filter((e) => e === 'reload').length, 1);
  assert.equal(m.fetchesCentral.length, 0, 'sem csrf a chamada nem sai');
});

test('CA5: a extensão continua sem escrever no console e o poll vazio só pergunta de novo', async () => {
  const m = montar({ jobs: [], pollVazio: 'longo' });
  await m.avancar(100_000);
  assert.ok(m.pollsVazios >= 3, `polls vazios: ${m.pollsVazios}`);
  assert.deepEqual(m.resultados, []);
  assert.equal(m.armazenado.st.ok, true);
});

// ---------------- dev: as camadas por baixo do teto (prazo da aba, recarga no próximo pedido, pedido abandonado),
// o teto da lista (R3), o portal da Shopee sem resposta (R1) e a origem da aba da Central (S1) ----------------

const API_LINK_TESTE = '/affiliate-program/api/v2/affiliates/createLink';
/** Índice do n-ésimo evento (1 = primeiro) que começa com `prefixo`. */
const nesimo = (eventos, prefixo, n) => {
  let vistos = 0;
  return eventos.findIndex((e) => e.startsWith(prefixo) && ++vistos === n);
};

test('CA4/CA5: a aba congelou só na primeira tentativa: a extensão recarrega a aba e o mesmo pedido sai com o link, bem antes do teto', async () => {
  let n = 0;
  const m = montar({ jobs: [jobLink(1)], pollVazio: 'cai', congelar: () => ++n === 1 });
  await m.avancar(45_000);
  assert.deepEqual(plano(m.resultados), [{ id: 1, ok: true, link: LINK_OK }]);
  assert.ok(m.tempos[0] < 45_000, `o link só saiu aos ${m.tempos[0]} ms`);
  const i2 = nesimo(m.eventos, 'inject:', 2);
  assert.ok(i2 > 0 && m.eventos.slice(nesimo(m.eventos, 'inject:', 1), i2).includes('reload'), `sem recarga entre as tentativas: ${m.eventos.join(',')}`);
  assert.equal(m.armazenado.st.ultimoErro, null);
});

test('CA2/CA4: lista longa que estoura o teto: o pedido abandonado não chama mais a Central e o próximo pedido começa recarregando a aba', async () => {
  // 11 páginas de 9 s e teto de 55 s para a lista: o teto estoura durante a 7ª (pedida aos 54 s); a 7ª ainda responde
  // depois, e a 8ª não pode sair
  const paginas = Array.from({ length: 11 }, (_, i) => ({ ...CORPO_LISTA, pagina: i + 1 }));
  const m = montar({ jobs: [{ id: 1, type: 'ofertas', paginas }, jobLink(2)], pollVazio: 'cai', modoCentral: () => 9000 });
  await m.avancar(150_000);
  assert.deepEqual(m.resultados.map((r) => [r.id, r.ok]), [[1, false], [2, true]]);
  assert.ok(m.tempos[0] < 60_000, `o erro só saiu aos ${m.tempos[0]} ms`);
  const listas = m.fetchesCentral.filter((f) => f.url.includes('/hub/search'));
  assert.equal(listas.length, 7, `o pedido abandonado seguiu chamando a Central: ${listas.length} páginas pedidas`);
  // a 8ª injeção é a do pedido 2: logo antes dela, a aba foi recarregada
  const i = nesimo(m.eventos, 'inject:', 8);
  assert.ok(i > 0, `sequência inesperada: ${m.eventos.join(',')}`);
  assert.equal(m.eventos[i - 1], 'reload', `o pedido seguinte não recarregou a aba presa: ${m.eventos.join(',')}`);
});

test('R3: lista de ofertas com a aba congelada responde antes dos 60 s em que o servidor desiste dela', async () => {
  const m = montar({ jobs: [jobOfertas(1, { ...CORPO_LISTA, q: 'congela' }), jobLink(2)], congelar: congelado });
  await m.avancar(120_000);
  const [r1] = porId(m, 1);
  assert.ok(r1, 'a lista nunca respondeu');
  assert.equal(r1.ok, false);
  assert.match(r1.error, /Central de Afiliados do Mercado Livre não respondeu a tempo/);
  assert.ok(m.tempos[m.resultados.indexOf(r1)] < 60_000, `a lista só respondeu aos ${m.tempos[m.resultados.indexOf(r1)]} ms`);
  assert.deepEqual(plano(porId(m, 2)), [{ id: 2, ok: true, link: LINK_OK }]);
});

test('R4: resposta tardia de um pedido abandonado da Central não recarrega a aba; quem recarrega é o pedido seguinte', async () => {
  // 4 páginas de 9 s e a 5ª congelada (pedida aos 36 s): o teto de 55 s estoura com a aba presa, e o prazo da aba
  // (20 s) vence aos 56 s, já com o pedido encerrado
  const paginas = [1, 2, 3, 4].map((pagina) => ({ ...CORPO_LISTA, pagina })).concat({ ...CORPO_LISTA, pagina: 5, q: 'congela' });
  const m = montar({ jobs: [{ id: 1, type: 'ofertas', paginas }], congelar: congelado, modoCentral: () => 9000 });
  await m.avancar(55_500);
  assert.deepEqual(m.resultados.map((r) => [r.id, r.ok]), [[1, false]]);
  const depoisDoTeto = m.eventos.length;
  await m.avancar(3_000); // passa dos 56 s
  assert.deepEqual(m.eventos.slice(depoisDoTeto).filter((e) => e === 'reload'), [], `o pedido abandonado recarregou a aba: ${m.eventos.join(',')}`);
  m.empilhar(jobLink(2));
  await m.avancar(60_000);
  assert.deepEqual(plano(porId(m, 2)), [{ id: 2, ok: true, link: LINK_OK }]);
  const i = nesimo(m.eventos, 'inject:', 6);
  assert.equal(m.eventos[i - 1], 'reload', `o pedido seguinte não recarregou a aba presa: ${m.eventos.join(',')}`);
  assert.equal(m.eventos.filter((e) => e === 'reload').length, 1, `recargas a mais: ${m.eventos.join(',')}`);
});

test('R4: resposta tardia de um pedido abandonado da Shopee não recarrega a aba do portal', async () => {
  const m = montar({ jobs: [jobShopee(1, PRODUTO_SHOPEE_CONGELA)], congelar: congelado, tardio: () => 85_000 });
  await m.avancar(81_000);
  assert.deepEqual(m.resultados.map((r) => [r.id, r.ok]), [[1, false]]);
  const depoisDoTeto = m.eventos.length;
  await m.avancar(10_000); // a aba "descongela" aos 85 s
  assert.deepEqual(m.eventos.slice(depoisDoTeto).filter((e) => e === 'reload'), [], `o pedido abandonado recarregou a aba: ${m.eventos.join(',')}`);
  assert.equal(porId(m, 1).length, 1);
});

/** Fetch pendurado: como o de verdade, só volta quando o sinal aborta (sem sinal, nunca). */
const pendurado = (init = {}) => new Promise((_, falha) => {
  if (init.signal?.aborted) return falha(init.signal.reason);
  init.signal?.addEventListener?.('abort', () => falha(init.signal.reason), { once: true });
});

/** Troca o fetch do portal da Shopee (o montar() não o simula): `portal(url, init, n)` responde ou devolve undefined para pendurar. */
function comPortal(m, portal) {
  const original = m.ctx.fetch; let n = 0;
  m.ctx.fetch = (url, init = {}) => {
    if (new URL(url).origin !== PORTAL) return original(url, init);
    const r = portal(String(url), init, ++n);
    return r ? Promise.resolve(r) : pendurado(init);
  };
}
const LINK_SHOPEE_OK = 'https://s.shopee.com.br/abc123';
const portalOk = (url) => (url.includes('/api/v3/config/website')
  ? new Response('{}', { status: 200, headers: { 'csrf-token': 'csrf-do-portal' } })
  : new Response(JSON.stringify({ data: { batchCustomLink: [{ shortLink: LINK_SHOPEE_OK, longLink: 'https://shopee.com.br/x?utm_source=an_1' }] } }), { status: 200 }));

test('R1: portal da Shopee pendurado: recarrega a aba, tenta de novo, responde "não respondeu a tempo" e o próximo pedido começa recarregando', async () => {
  const m = montar({ jobs: [jobShopee(1), jobShopee(2)], pollVazio: 'cai' });
  comPortal(m, (url, init, n) => (n <= 2 ? undefined : portalOk(url))); // as 2 primeiras chamadas (uma por tentativa) penduram
  await m.avancar(5_000);
  assert.deepEqual(m.resultados, [], 'o pedido não pode falhar antes do prazo de 20 s');
  await m.avancar(115_000);
  const [r1] = porId(m, 1);
  assert.ok(r1, 'o pedido 1 nunca respondeu');
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'o portal de afiliados da Shopee não respondeu a tempo. A extensão recarrega a aba e tenta de novo no próximo pedido');
  assert.ok(m.tempos[m.resultados.indexOf(r1)] < 45_000, `só respondeu aos ${m.tempos[m.resultados.indexOf(r1)]} ms`);
  const [r2] = porId(m, 2);
  assert.deepEqual(plano(r2), { id: 2, ok: true, link: LINK_SHOPEE_OK, longo: 'https://shopee.com.br/x?utm_source=an_1', sub_id_aplicado: false });
  // pedido 1: injeta, recarrega, injeta; pedido 2: recarrega antes de injetar
  assert.deepEqual(m.eventos, ['inject:normal', 'reload', 'inject:normal', 'reload', 'inject:normal']);
});

test('R1: portal da Shopee fora do ar (rede): recarrega a aba, tenta de novo e devolve a mensagem de sempre', async () => {
  const m = montar({ jobs: [jobShopee(1)], pollVazio: 'cai' }); // o montar() derruba toda chamada ao portal
  await m.avancar(5_000);
  assert.deepEqual(plano(m.resultados), [{ id: 1, ok: false, error: 'não consegui falar com o portal de afiliados da Shopee' }]);
  assert.deepEqual(m.eventos, ['inject:normal', 'reload', 'inject:normal']);
});

test('S1: chamarCentral fora da origem da Central não chama nada e pede a recarga da aba', async () => {
  const m = montar({ pollVazio: 'cai' });
  await m.avancar(0);
  for (const fora of ['https://lista.mercadolivre.com.br/afiliados/hub', 'https://www.mercadolivre.com.br.evil.com/afiliados', 'http://www.mercadolivre.com.br/afiliados']) {
    m.ctx.location = new URL(fora);
    m.ctx.document = { querySelector: () => ({ content: 'csrf-da-pagina' }) };
    assert.deepEqual(plano(await m.ctx.chamarCentral(API_LINK_TESTE, { urls: ['https://x'], tag: 't' })), { status: 0, semSessao: true }, fora);
  }
  assert.equal(m.fetchesCentral.length, 0);
});

test('S1: com a aba da Central em outro subdomínio, a extensão a leva de volta à Central e o link sai', async () => {
  const m = montar({
    jobs: [jobLink(1)], pollVazio: 'cai',
    abas: [{ id: 5, url: 'https://lista.mercadolivre.com.br/afiliados/hub', status: 'complete' }, { id: 6, url: `${PORTAL}/offer/custom_link`, status: 'complete' }],
  });
  await m.avancar(5_000);
  assert.deepEqual(plano(m.resultados), [{ id: 1, ok: true, link: LINK_OK }]);
  assert.deepEqual(m.eventos, ['inject:normal', 'reload', 'inject:normal', 'fetch:normal']);
  assert.equal(m.fetchesCentral[0].url, `${ML}/affiliate-program/api/v2/affiliates/createLink`);
});

test('CA2/CA4: Shopee com a aba congelada: o pedido seguinte da Shopee recarrega a aba do portal antes de chamar', async () => {
  const m = montar({ jobs: [jobShopee(1, PRODUTO_SHOPEE_CONGELA), jobShopee(2)], pollVazio: 'cai', congelar: congelado });
  await m.avancar(120_000);
  assert.deepEqual(porId(m, 1).map((r) => r.ok), [false]);
  assert.equal(porId(m, 2).length, 1);
  const i1 = m.eventos.indexOf('inject:congela');
  const i2 = m.eventos.indexOf('inject:normal');
  assert.ok(i1 >= 0 && i2 > i1, `sequência inesperada: ${m.eventos.join(',')}`);
  assert.ok(m.eventos.slice(i1, i2).includes('reload'), `a aba do portal não foi recarregada: ${m.eventos.join(',')}`);
});

test('R5: poll ao painel sem resposta: em 30 s o laço para, marca o painel fora e o alarme o religa', async () => {
  const m = montar({ pollVazio: 'cai' });
  await m.avancar(0);
  const original = m.ctx.fetch; let segurar = true;
  m.ctx.fetch = (url, init = {}) => (segurar && new URL(url).pathname === '/api/ext/poll' ? pendurado(init) : original(url, init));
  m.alarme();
  await m.avancar(31_000);
  assert.equal(m.armazenado.st.ok, false);
  assert.equal(m.armazenado.st.erro, 'Painel fechado ou endereço errado.');
  segurar = false;
  m.empilhar(jobLink(1));
  m.alarme();
  await m.avancar(5_000);
  assert.deepEqual(plano(porId(m, 1)), [{ id: 1, ok: true, link: LINK_OK }], 'o alarme não religou o laço (rodando ficou true)');
});

test('R5: envio do resultado sem resposta do painel: em 10 s o laço desiste e atende o pedido seguinte', async () => {
  const m = montar({ jobs: [jobLink(1), jobLink(2)], pollVazio: 'cai' });
  const original = m.ctx.fetch;
  m.ctx.fetch = (url, init = {}) => (new URL(url).pathname === '/api/ext/result' && JSON.parse(init.body).id === 1 ? pendurado(init) : original(url, init));
  await m.avancar(15_000);
  assert.deepEqual(plano(porId(m, 2)), [{ id: 2, ok: true, link: LINK_OK }], 'o laço ficou preso no envio do resultado anterior');
});

// ---------------- Rodar sozinho, entrega 2, etapa 2: aba lembrada, aba descartada, erro real, prazos e versão ----------------
// Plano: docs/produto/planos/rodar-sozinho-entrega2.md (decisões 2, 3 e 7; CA2.7, CA2.9 e CA2.16).

const SO_PORTAL = [{ id: 6, url: `${PORTAL}/offer/custom_link`, status: 'complete' }];
const criadas = (m) => [...m.abas.values()].filter((t) => t.id > 100);
/** Entrega um pedido com o laço parado (pollVazio 'cai') e espera a resposta. */
async function pedir(m, job, ms = 30_000) {
  m.empilhar(job);
  m.alarme();
  await m.avancar(ms);
  return porId(m, job.id);
}

test('CA2.7: aba descartada é recarregada antes do executeScript e o link sai, sem abrir outra aba', async () => {
  const m = montar({
    jobs: [jobLink(1)], pollVazio: 'cai',
    abas: [{ id: 5, url: CENTRAL, status: 'complete', discarded: true }, ...SO_PORTAL],
  });
  await m.avancar(30_000);
  assert.deepEqual(plano(m.resultados), [{ id: 1, ok: true, link: LINK_OK }]);
  assert.deepEqual(m.recargas, [5], 'a aba descartada não foi recarregada');
  assert.deepEqual(m.navegacoes, [], 'recarregar a aba descartada não muda o endereço dela');
  assert.deepEqual(m.eventos, ['reload', 'inject:normal', 'fetch:normal']);
});

test('CA2.7: aba lembrada fora de /afiliados é reaproveitada (volta à Central) em vez de abrir outra', async () => {
  const m = montar({ pollVazio: 'cai', abas: SO_PORTAL });
  assert.deepEqual(plano(await pedir(m, jobLink(1))), [{ id: 1, ok: true, link: LINK_OK }]);
  const [aba] = criadas(m);
  assert.ok(aba, 'sem aba da Central, a extensão abre uma');
  assert.equal(aba.pinned, true);
  assert.equal(aba.active, false);
  m.abas.get(aba.id).url = `${ML}/ofertas#nav-header`; // a aba fixada saiu da Central (o dono clicou nela e navegou)
  assert.deepEqual(plano(await pedir(m, jobLink(2))), [{ id: 2, ok: true, link: LINK_OK }]);
  assert.equal(m.eventos.filter((e) => e === 'create').length, 1, `abriu outra aba: ${m.eventos.join(',')}`);
  assert.deepEqual(m.navegacoes, [{ id: aba.id, url: CENTRAL }]);
});

test('CA2.7: três pedidos não criam segunda aba fixada, nem com o service worker reiniciado no meio', async () => {
  const m = montar({ pollVazio: 'cai', abas: SO_PORTAL });
  const desvios = [`${ML}/ofertas`, 'https://www.mercadolivre.com.br/jms/mlb/lgz/login?go=x', null];
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(plano(await pedir(m, jobLink(i + 1))), [{ id: i + 1, ok: true, link: LINK_OK }]);
    const [aba] = criadas(m);
    if (desvios[i]) m.abas.get(aba.id).url = desvios[i];
    if (i === 1) m.reiniciarWorker(); // as variáveis do background somem; a aba lembrada fica no chrome.storage.session
  }
  assert.equal(m.eventos.filter((e) => e === 'create').length, 1, `abriu aba a mais: ${m.eventos.join(',')}`);
  assert.equal([...m.abas.values()].filter((t) => t.pinned).length, 1);
});

test('CA2.7: aba do dono fora de /afiliados nunca é navegada', async (t) => {
  await t.test('sem aba da Central, abre a sua e não toca nas abas do Mercado Livre do dono', async () => {
    const m = montar({
      jobs: [jobLink(1), jobLink(2)], pollVazio: 'cai',
      abas: [{ id: 7, url: `${ML}/ofertas`, status: 'complete' }, { id: 8, url: 'https://produto.mercadolivre.com.br/MLB-123456789-fone', status: 'complete' }, ...SO_PORTAL],
    });
    await m.avancar(30_000);
    assert.deepEqual(m.resultados.map((r) => [r.id, r.ok]), [[1, true], [2, true]]);
    assert.deepEqual(m.navegacoes.filter((n) => n.id === 7 || n.id === 8), []);
    assert.equal(m.abas.get(7).url, `${ML}/ofertas`);
    assert.equal(criadas(m).length, 1);
  });
  await t.test('a aba de afiliados do dono saiu da Central no meio do pedido: a extensão não a leva de volta', async () => {
    let n = 0;
    const m = montar({
      jobs: [jobLink(1)], pollVazio: 'cai', congelar: () => ++n === 1,
      abas: [{ id: 5, url: CENTRAL, status: 'complete' }, ...SO_PORTAL],
    });
    await m.avancar(1_000);
    m.abas.get(5).url = `${ML}/ofertas`; // o dono navegou a aba dele enquanto a primeira tentativa esperava
    await m.avancar(40_000);
    assert.deepEqual(plano(m.resultados), [{ id: 1, ok: true, link: LINK_OK }]);
    assert.deepEqual(m.navegacoes.filter((x) => x.id === 5), [], `navegou a aba do dono: ${JSON.stringify(m.navegacoes)}`);
    assert.deepEqual(m.recargas, []);
    assert.equal(m.abas.get(5).url, `${ML}/ofertas`);
    assert.equal(criadas(m).length, 1, 'sem poder usar a aba do dono, a extensão abre a sua');
  });
  await t.test('aba lembrada de outra sessão do Chrome não vale (ids recomeçam): a aba com aquele id é do dono', async () => {
    const m = montar({ pollVazio: 'cai', abas: [{ id: 7, url: `${ML}/ofertas`, status: 'complete' }, ...SO_PORTAL] });
    m.armazenado.abaCentral = 7; // um id guardado em chrome.storage.local antes de o Chrome reiniciar não pode ser usado
    assert.deepEqual(plano(await pedir(m, jobLink(1))), [{ id: 1, ok: true, link: LINK_OK }]);
    assert.deepEqual(m.navegacoes.filter((x) => x.id === 7), []);
  });
});

test('CA2.7: erro real e tipo chegam no result', async (t) => {
  const recusa = JSON.stringify({ urls: [{ error: { message: 'The article must be active, status: paused' } }] });
  const casos = [
    ['aba', { falhaInjecao: () => 'Could not establish connection. Receiving end does not exist.' },
      /^não consegui abrir a Central de Afiliados: “Could not establish connection\. Receiving end does not exist\.”$/],
    ['http', { modoCentral: () => ({ status: 500, corpo: 'erro interno' }) }, /^a Central de Afiliados respondeu HTTP 500$/],
    ['sessao', { semCsrf: true }, /não há sessão de afiliado neste Chrome/],
    ['sem_resposta', { congelar: () => true }, /Central de Afiliados do Mercado Livre não respondeu a tempo/],
    ['sem_resposta', { modoCentral: () => 'rede' }, /^não consegui falar com a Central de Afiliados: “Failed to fetch”$/],
    ['formato', { modoCentral: () => ({ status: 200, corpo: '<html>' }) }, /não é JSON/],
    ['formato', { modoCentral: () => ({ status: 200, corpo: '{"urls":[{}]}' }) }, /sem link/],
    ['recusa', { modoCentral: () => ({ status: 200, corpo: recusa }) },
      /^o Mercado Livre recusou o link: “The article must be active, status: paused” \(etiqueta "minhaetiqueta"\)$/],
  ];
  for (const [tipo, opcoes, frase] of casos) {
    await t.test(`${tipo}: ${frase}`, async () => {
      const m = montar({ jobs: [jobLink(1)], pollVazio: 'cai', ...opcoes });
      await m.avancar(60_000);
      const [r] = plano(m.resultados);
      assert.equal(r?.ok, false, JSON.stringify(r));
      assert.equal(r.tipo, tipo);
      assert.match(r.error, frase);
      assert.equal(m.armazenado.st.ultimoErro, r.error, 'o popup mostra o mesmo erro que foi ao painel');
      assert.equal(m.armazenado.st.central, tipo === 'recusa' ? 'respondendo' : 'sem_resposta');
    });
  }
  await t.test('lista de ofertas também leva o tipo; Shopee e produto não', async () => {
    const m = montar({ jobs: [jobOfertas(1)], pollVazio: 'cai', modoCentral: () => ({ status: 502, corpo: '' }) });
    await m.avancar(60_000);
    assert.deepEqual(plano(m.resultados), [{ id: 1, ok: false, error: 'a Central de Afiliados respondeu HTTP 502', tipo: 'http' }]);
    const s = montar({ jobs: [jobShopee(2)], pollVazio: 'cai' });
    await s.avancar(10_000);
    assert.equal(plano(s.resultados)[0].tipo, undefined);
  });
  await t.test('link gerado marca a Central respondendo e limpa o último erro', async () => {
    const m = montar({ pollVazio: 'cai', modoCentral: (_, n) => (n <= 2 ? 'rede' : 'ok'), abas: [{ id: 5, url: CENTRAL, status: 'complete' }, ...SO_PORTAL] });
    await pedir(m, jobLink(1));
    assert.equal(m.armazenado.st.central, 'sem_resposta');
    assert.deepEqual(plano(await pedir(m, jobLink(2))), [{ id: 2, ok: true, link: LINK_OK }]);
    assert.equal(m.armazenado.st.central, 'respondendo');
    assert.equal(m.armazenado.st.ultimoErro, null);
  });
});

test('CA2.7: o erro real não leva endereço completo, token, caracteres de controle nem texto sem fim', async () => {
  const sujo = 'Cannot access contents of url "https://www.mercadolivre.com.br/afiliados/hub?token=abc123&csrf=xyz".\n\u0007'
    + ' Extension manifest must request permission to access this host. ' + 'x'.repeat(400);
  const m = montar({ jobs: [jobLink(1, 'etiqueta-secreta')], pollVazio: 'cai', falhaInjecao: () => sujo });
  await m.avancar(30_000);
  const [r] = plano(m.resultados);
  assert.equal(r.tipo, 'aba');
  assert.match(r.error, /“Cannot access contents of url "https:\/\/www\.mercadolivre\.com\.br"\. Extension manifest/);
  for (const proibido of ['token=abc123', 'csrf=xyz', 'abc123', '/afiliados/hub', 'etiqueta-secreta', 'tok-painel', 'csrf-da-pagina']) {
    assert.ok(!r.error.includes(proibido), `o erro leva "${proibido}": ${r.error}`);
  }
  assert.doesNotMatch(r.error, /[\u0000-\u001f\u007f]/);
  assert.ok(r.error.length <= 220, `erro com ${r.error.length} caracteres`);
});

test('CA2.9: nenhuma nova tentativa (aba descartada, sessão recarregada) aceita link fora de meli.la', async (t) => {
  const semAfiliacao = JSON.stringify({ urls: [{ short_url: 'https://www.mercadolivre.com.br/fone/p/MLB1' }] });
  const cenarios = [
    ['aba descartada', { abas: [{ id: 5, url: CENTRAL, status: 'complete', discarded: true }, ...SO_PORTAL] }],
    ['aba lembrada que saiu da Central', { abas: SO_PORTAL, desviar: true }],
    ['sessão recarregada', { semCsrfPrimeira: true }],
  ];
  for (const [nome, c] of cenarios) {
    await t.test(nome, async () => {
      const m = montar({ pollVazio: 'cai', abas: c.abas, modoCentral: () => ({ status: 200, corpo: semAfiliacao }) });
      if (c.semCsrfPrimeira) {
        // a primeira injeção cai numa página sem csrf (sessão vencida): a extensão recarrega e tenta de novo
        const original = m.ctx.chrome.scripting.executeScript;
        let k = 0;
        m.ctx.chrome.scripting.executeScript = async (o) => (++k === 1 ? [{ result: { status: 0, semSessao: true } }] : original(o));
      }
      if (c.desviar) {
        await pedir(m, jobLink(1));
        m.abas.get(criadas(m)[0].id).url = `${ML}/ofertas`;
      }
      const r = plano(await pedir(m, jobLink(9)));
      assert.equal(r.length, 1);
      assert.equal(r[0].ok, false);
      assert.equal(r[0].link, undefined);
      assert.equal(r[0].tipo, 'formato');
      assert.ok(!m.resultados.some((x) => x.ok && !/^https:\/\/meli\.la\//.test(x.link)), 'saiu link sem afiliação');
    });
  }
});

test('prazos novos: aba congelada é recarregada aos 20 s, e o link responde até os 40 s, antes dos 45 s do servidor', async () => {
  // a recarga demora 12 s para avisar que carregou: 20 + 12 + 20 = 52 s sem o teto; o teto de 40 s responde antes
  const m = montar({
    jobs: [jobLink(1, 'etiqueta-congela', 'https://www.mercadolivre.com.br/congela/p/MLB1')], pollVazio: 'cai', congelar: congelado, demoraCarregar: 12_000,
  });
  await m.avancar(19_500);
  assert.ok(!m.eventos.includes('reload'), 'recarregou antes dos 20 s de espera da aba');
  await m.avancar(1_000);
  assert.ok(m.eventos.includes('reload'), `a aba congelada não foi recarregada aos 20 s: ${m.eventos.join(',')}`);
  await m.avancar(18_500); // 39 s
  assert.deepEqual(m.resultados, [], 'o link não pode desistir antes do teto de 40 s');
  await m.avancar(1_500);
  const [r] = plano(m.resultados);
  assert.ok(r, 'sem resposta aos 40 s');
  assert.deepEqual(r, { id: 1, ok: false, error: 'a Central de Afiliados do Mercado Livre não respondeu a tempo. A extensão recarrega a aba e tenta de novo no próximo pedido', tipo: 'sem_resposta' });
  assert.equal(m.tempos[0], 40_000);
});

test('prazos novos: aba que não avisa que carregou é usada depois de 15 s de espera', async () => {
  const m = montar({
    jobs: [jobLink(1)], pollVazio: 'cai', demoraCarregar: 120_000,
    abas: [{ id: 5, url: CENTRAL, status: 'complete', discarded: true }, ...SO_PORTAL],
  });
  await m.avancar(30_000);
  assert.deepEqual(plano(m.resultados), [{ id: 1, ok: true, link: LINK_OK }]);
  assert.equal(m.tempos[0], 15_000);
});

test('prazos novos: o fetch da Central dentro da aba desiste em 15 s', async () => {
  const m = montar({ pollVazio: 'cai', modoCentral: () => 'pendurar' });
  await m.avancar(0);
  m.ctx.location = new URL(CENTRAL);
  m.ctx.document = { querySelector: () => ({ content: 'csrf-da-pagina' }) };
  let fim = null;
  m.ctx.chamarCentral(API_LINK_TESTE, { urls: ['https://x'], tag: 't' }).then((v) => { fim = v; });
  await m.avancar(14_900);
  assert.equal(fim, null, 'desistiu antes dos 15 s');
  await m.avancar(200);
  assert.deepEqual(plano(fim), { status: 0, tempoEsgotado: true });
});

test('CA2.16: o poll manda x-versao com a versão do chrome.runtime.getManifest()', async (t) => {
  for (const versao of [VERSAO_TESTE, '2.10.3']) {
    await t.test(versao, async () => {
      const m = montar({ jobs: [jobLink(1)], pollVazio: 'cai', manifest: { version: versao, name: 'falso' } });
      await m.avancar(5_000);
      assert.ok(m.cabecalhosPoll.length >= 2);
      for (const h of m.cabecalhosPoll) assert.deepEqual(plano(h), { 'x-token': 'tok-painel', 'x-recursos': 'produto_ml', 'x-versao': versao });
    });
  }
});

// ---------------- popup: linha da Central e versão ----------------

const POPUP = fs.readFileSync(path.join(RAIZ, 'extension', 'popup.js'), 'utf8');
const POPUP_HTML = fs.readFileSync(path.join(RAIZ, 'extension', 'popup.html'), 'utf8');

/** Roda o popup.js num vm com um document de mentira (só getElementById) e o st dado. */
async function abrirPopup(st, manifest = { version: VERSAO_TESTE }) {
  const ids = [...POPUP_HTML.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]);
  const el = Object.fromEntries(ids.map((id) => [id, { id, textContent: '', className: '', hidden: false, value: '', addEventListener() {} }]));
  for (const [id, e] of Object.entries(el)) {
    const tag = POPUP_HTML.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))[0];
    e.hidden = /\shidden[\s>]/.test(tag);
    e.className = tag.match(/class="([^"]*)"/)?.[1] || '';
  }
  const chrome = {
    storage: { local: { get: async () => structuredClone({ conf: { servidor: SERVIDOR, token: 't' }, st }) }, onChanged: { addListener() {} } },
    runtime: { getManifest: () => structuredClone(manifest) },
    permissions: { request: async () => true },
  };
  const ctx = vm.createContext({ chrome, document: { getElementById: (id) => el[id] || null }, setTimeout, URL, confirm: () => true });
  vm.runInContext(POPUP, ctx, { filename: 'popup.js' });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return el;
}

test('popup: a caixa de estado tem role=status e a versão sai do manifest', async () => {
  assert.match(POPUP_HTML, /<div[^>]*\bid="estado"[^>]*\brole="status"|<div[^>]*\brole="status"[^>]*\bid="estado"/);
  const el = await abrirPopup({ ok: true });
  assert.equal(el.versao.textContent, `Versão ${VERSAO_TESTE}`);
  assert.equal((await abrirPopup({ ok: false }, { version: '3.1.4' })).versao.textContent, 'Versão 3.1.4');
});

test('popup: linha da Central só com a extensão conectada, respondendo ou sem resposta, e o erro real', async () => {
  let el = await abrirPopup({ ok: true, central: 'respondendo' });
  assert.equal(el.msg.textContent, 'Conectado ao achadinhoturbo');
  assert.equal(el.linhaCentral.hidden, false);
  assert.equal(el.msgCentral.textContent, 'Central de Afiliados: respondendo');
  assert.match(el.linhaCentral.className, /\bok\b/);

  el = await abrirPopup({ ok: true, central: 'sem_resposta', ultimoErro: 'não consegui abrir a Central de Afiliados: “No tab with id: 5”' });
  assert.equal(el.msgCentral.textContent, 'Central de Afiliados: sem resposta');
  assert.doesNotMatch(el.linhaCentral.className, /\bok\b/);
  assert.equal(el.erro.textContent, 'Último erro ao gerar link: não consegui abrir a Central de Afiliados: “No tab with id: 5”');

  el = await abrirPopup({ ok: false, erro: 'Painel fechado ou endereço errado.', central: 'respondendo' });
  assert.equal(el.msg.textContent, 'Painel fechado ou endereço errado.');
  assert.equal(el.linhaCentral.hidden, true, 'sem a extensão conectada, a linha da Central some');

  el = await abrirPopup({ ok: true }); // ainda sem pedido à Central
  assert.equal(el.linhaCentral.hidden, true);
});
