// Testes de src/rede.js (resolvedor por redirecionamento e leitor de corpo genéricos) e de tituloDeUmaLinha
// (src/titulo.js), extraídos do padrão de src/amazon.js (plano integracao-shopee, etapa 1; CA1 e CA8).
// O fetch global fica bloqueado no arquivo inteiro e o último teste prova que ele nunca foi chamado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolverPorRedirecionamento, lerCorpoLimitado, FalhaDeLink, paraUrl, hostDaLista, MAX_URL } from '../src/rede.js';
import { tituloDeUmaLinha } from '../src/titulo.js';

const fetchOriginal = globalThis.fetch;
let chamadasGlobais = 0;
test.before(() => { globalThis.fetch = async () => { chamadasGlobais++; throw new Error('rede proibida no teste'); }; });
test.after(() => { globalThis.fetch = fetchOriginal; });

// Loja de mentira: encurtador curto.test e produtos em loja.test/p/<n>.
const HOSTS = ['curto.test', 'loja.test'];
const extrair = (u) => {
  if (!hostDaLista(u.hostname, ['loja.test'])) return null;
  const m = /^\/p\/(\d+)$/.exec(u.pathname);
  return m ? { id: m[1] } : null;
};
const paginaSemValor = (u) => hostDaLista(u.hostname, ['loja.test']);

const redirecionar = (status, location) => new Response(null, { status, headers: location ? { location } : {} });
function fetchFalso(handler) {
  const chamadas = [];
  const f = async (url, init = {}) => { chamadas.push({ url: String(url), init }); return handler(String(url), init, chamadas.length); };
  f.chamadas = chamadas;
  return f;
}
function relogio(inicio = 1_700_000_000_000) {
  const r = { t: inicio };
  r.agora = () => r.t;
  return r;
}
const opcoes = (f, extra = {}) => ({ hosts: HOSTS, extrair, paginaSemValor, fetch: f, ...extra });
const capturarErro = async (fn) => { try { await fn(); } catch (e) { return e; } assert.fail('deveria ter lançado'); };

test('rede: valor já na URL volta sem rede e sem query; encurtador segue só GET manual até o valor', async () => {
  const nunca = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  assert.deepEqual(await resolverPorRedirecionamento('loja.test/p/42?rastreio=1#x', opcoes(nunca)), { valor: { id: '42' }, urlFinal: 'https://loja.test/p/42' });
  assert.equal(nunca.chamadas.length, 0);

  const f = fetchFalso((url, init, n) => {
    if (n === 1) { assert.equal(url, 'https://curto.test/abc'); return redirecionar(301, 'https://curto.test/def'); }
    if (n === 2) return redirecionar(302, 'http://loja.test/p/7?tag=terceiro');
    return assert.fail('salto a mais');
  });
  assert.deepEqual(await resolverPorRedirecionamento('http://curto.test/abc', opcoes(f)), { valor: { id: '7' }, urlFinal: 'https://loja.test/p/7' });
  for (const { init } of f.chamadas) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.ok(init.signal instanceof AbortSignal);
    assert.match(init.headers['User-Agent'], /^Mozilla\/5\.0 .+Chrome\//); assert.equal(init.headers['Accept-Language'], 'pt-BR');
  }
});

test('rede: entrada e Location fora da lista, com porta, credenciais ou longos demais são invalido sem seguir', async () => {
  const nunca = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  for (const url of ['https://evil.test/p/1', 'https://curto.test:8443/x', 'https://u:p@curto.test/x', 'ftp://curto.test/x', 'https://curto.test.evil.test/x',
    `https://curto.test/${'a'.repeat(MAX_URL)}`, '', null, 42]) {
    const e = await capturarErro(() => resolverPorRedirecionamento(url, opcoes(nunca)));
    assert.ok(e instanceof FalhaDeLink, String(url).slice(0, 40)); assert.equal(e.causa, 'invalido');
  }
  // opções incompletas: nunca vai à rede
  for (const o of [{ hosts: [], extrair }, { hosts: HOSTS }, { hosts: 'curto.test', extrair }, undefined]) {
    assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', { ...o, fetch: nunca }))).causa, 'invalido');
  }
  assert.equal(nunca.chamadas.length, 0);
  for (const destino of ['https://evil.test/p/1', 'https://loja.test:8080/p/1', 'https://169.254.169.254/', `https://loja.test/${'a'.repeat(MAX_URL)}`]) {
    const f = fetchFalso(() => redirecionar(302, destino));
    assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(f)))).causa, 'invalido', destino.slice(0, 40));
    assert.equal(f.chamadas.length, 1);
  }
  const loop = fetchFalso((url, init, n) => redirecionar(301, `https://curto.test/s${n}`));
  assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(loop)))).causa, 'invalido');
  assert.equal(loop.chamadas.length, 5);
});

test('rede: hostsDeSalto vale só como salto intermediário e só no host exato; sem a opção (padrão []) o host de salto é recusado como antes', async () => {
  const salto = ['salto.test'];
  // como entrada, o host de salto é inválido e nunca vai à rede (nem como subdomínio)
  const nunca = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  for (const url of ['https://salto.test/abc', 'salto.test/abc', 'http://salto.test/abc', 'https://x.salto.test/abc']) {
    const e = await capturarErro(() => resolverPorRedirecionamento(url, opcoes(nunca, { hostsDeSalto: salto })));
    assert.equal(e.causa, 'invalido', url);
  }
  assert.equal(nunca.chamadas.length, 0);

  // sem a opção, o Location para o host de salto continua recusado, sem buscá-lo
  const sem = fetchFalso(() => redirecionar(302, 'https://salto.test/abc'));
  assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(sem)))).causa, 'invalido');
  assert.equal(sem.chamadas.length, 1);
  const vazio = fetchFalso(() => redirecionar(302, 'https://salto.test/abc'));
  assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(vazio, { hostsDeSalto: [] })))).causa, 'invalido');
  assert.equal(vazio.chamadas.length, 1);

  // com a opção, o salto é seguido (só o host exato, inclusive em maiúsculas, que o URL normaliza) e o valor sai do destino final
  for (const host of ['salto.test', 'SALTO.test']) {
    const f = fetchFalso((url, init, n) => (n === 1 ? redirecionar(302, `https://${host}/abc`) : redirecionar(302, 'https://loja.test/p/9?rastreio=1')));
    assert.deepEqual(await resolverPorRedirecionamento('https://curto.test/x', opcoes(f, { hostsDeSalto: salto })), { valor: { id: '9' }, urlFinal: 'https://loja.test/p/9' });
    assert.deepEqual(f.chamadas.map((c) => c.url), ['https://curto.test/x', 'https://salto.test/abc']);
  }
  // S1: subdomínio do host de salto é recusado (quem controla o DNS dele poderia apontá-lo para um IP interno) e nunca é buscado
  for (const destino of ['https://x.salto.test/abc', 'https://a.b.salto.test/abc', 'https://salto.test./abc']) {
    const f = fetchFalso((url, init, n) => (n === 1 ? redirecionar(302, destino) : redirecionar(302, 'https://loja.test/p/9')));
    assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(f, { hostsDeSalto: salto })))).causa, 'invalido', destino);
    assert.deepEqual(f.chamadas.map((c) => c.url), ['https://curto.test/x'], `não buscou ${destino}`);
  }
  // o host de salto não abre porta: fora da lista, porta, http (vira https só nos hosts aceitos) e credenciais seguem recusados
  for (const destino of ['https://evil.test/p/1', 'https://salto.test:8443/x', 'https://salto.test.evil.test/x', 'https://u:p@salto.test/x']) {
    const f = fetchFalso((url, init, n) => (n === 1 ? redirecionar(302, 'https://salto.test/abc') : redirecionar(302, destino)));
    assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(f, { hostsDeSalto: salto })))).causa, 'invalido', destino);
    assert.deepEqual(f.chamadas.map((c) => c.url), ['https://curto.test/x', 'https://salto.test/abc'], `não buscou ${destino}`);
  }
  // 200 no host de salto não é produto nem nao_produto: é inválido; o limite de 5 saltos inclui os saltos novos
  const pagina = fetchFalso((url, init, n) => (n === 1 ? redirecionar(302, 'https://salto.test/abc') : new Response('<html>', { status: 200 })));
  assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(pagina, { hostsDeSalto: salto })))).causa, 'invalido');
  const loop = fetchFalso((url, init, n) => redirecionar(301, `https://salto.test/s${n}`));
  assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(loop, { hostsDeSalto: salto })))).causa, 'invalido');
  assert.equal(loop.chamadas.length, 5);
});

test('rede: o host de salto nunca fornece o valor nem vira nao_produto, mesmo com extrair e paginaSemValor que o aceitariam', async () => {
  const tudo = { extrair: (u) => { const m = /^\/p\/(\d+)$/.exec(u.pathname); return m ? { id: m[1] } : null; }, paginaSemValor: () => true };
  // Location no host de salto com caminho de produto: segue adiante em vez de parar com o valor dali
  const f = fetchFalso((url, init, n) => (n === 1 ? redirecionar(302, 'https://salto.test/p/1') : redirecionar(302, 'https://loja.test/p/2')));
  assert.deepEqual(await resolverPorRedirecionamento('https://curto.test/x', opcoes(f, { hostsDeSalto: ['salto.test'], ...tudo })),
    { valor: { id: '2' }, urlFinal: 'https://loja.test/p/2' });
  assert.equal(f.chamadas.length, 2);
  // 200 no host de salto: invalido, mesmo com paginaSemValor dizendo que é página da loja
  const pagina = fetchFalso((url, init, n) => (n === 1 ? redirecionar(302, 'https://salto.test/busca') : new Response('ok', { status: 200 })));
  assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(pagina, { hostsDeSalto: ['salto.test'], ...tudo })))).causa, 'invalido');
  // hostsDeSalto que não é lista: invalido, sem rede
  const nunca = fetchFalso(() => assert.fail('não deveria acessar a rede'));
  assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(nunca, { hostsDeSalto: 'salto.test' })))).causa, 'invalido');
  assert.equal(nunca.chamadas.length, 0);
});

test('rede: 2xx em página sem valor é nao_produto; extrair ou paginaSemValor que lançam viram null/invalido', async () => {
  const f = fetchFalso((url, init, n) => (n === 1 ? redirecionar(302, 'https://loja.test/busca') : new Response('ok', { status: 200 })));
  const e = await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(f)));
  assert.equal(e.causa, 'nao_produto');
  assert.equal(e.message, 'O link não leva a um produto.');
  const g = fetchFalso(() => new Response('ok', { status: 200 }));
  assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://curto.test/x', opcoes(g)))).causa, 'invalido', '200 no encurtador');
  const quebrado = { hosts: HOSTS, extrair: () => { throw new Error('x'); }, paginaSemValor: () => { throw new Error('y'); } };
  const h = fetchFalso(() => new Response('ok', { status: 200 }));
  assert.equal((await capturarErro(() => resolverPorRedirecionamento('https://loja.test/p/1', { ...quebrado, fetch: h }))).causa, 'invalido');
  assert.equal(new FalhaDeLink('outra').causa, 'invalido');
});

test('rede: cache só quando passado; sucesso e nao_produto 1 h, invalido 10 min, falha passageira fora; cópia por chamador', async () => {
  const rel = relogio();
  const ok = fetchFalso(() => redirecionar(302, 'https://loja.test/p/9'));
  await resolverPorRedirecionamento('https://curto.test/a', opcoes(ok));
  await resolverPorRedirecionamento('https://curto.test/a', opcoes(ok));
  assert.equal(ok.chamadas.length, 2, 'sem cache, cada chamada vai à rede');

  const cache = new Map();
  const r1 = await resolverPorRedirecionamento('https://curto.test/a', opcoes(ok, { cache, agora: rel.agora }));
  r1.valor.id = 'mexido';
  const r2 = await resolverPorRedirecionamento('https://curto.test/a', opcoes(ok, { cache, agora: rel.agora }));
  assert.deepEqual(r2, { valor: { id: '9' }, urlFinal: 'https://loja.test/p/9' });
  assert.equal(ok.chamadas.length, 3);
  rel.t += 60 * 60 * 1000 + 1;
  await resolverPorRedirecionamento('https://curto.test/a', opcoes(ok, { cache, agora: rel.agora }));
  assert.equal(ok.chamadas.length, 4);

  const inv = fetchFalso(() => new Response('x', { status: 404 }));
  const o = opcoes(inv, { cache, agora: rel.agora });
  await capturarErro(() => resolverPorRedirecionamento('https://curto.test/hostil', o));
  await capturarErro(() => resolverPorRedirecionamento('https://curto.test/hostil', o));
  assert.equal(inv.chamadas.length, 1);
  rel.t += 10 * 60 * 1000 + 1;
  await capturarErro(() => resolverPorRedirecionamento('https://curto.test/hostil', o));
  assert.equal(inv.chamadas.length, 2);

  for (const resp of [() => { throw new TypeError('fetch failed'); }, () => new Response('x', { status: 503 })]) {
    const c = new Map();
    const p = fetchFalso(resp);
    await capturarErro(() => resolverPorRedirecionamento('https://curto.test/caiu', opcoes(p, { cache: c, agora: rel.agora })));
    await capturarErro(() => resolverPorRedirecionamento('https://curto.test/caiu', opcoes(p, { cache: c, agora: rel.agora })));
    assert.equal(p.chamadas.length, 2); assert.equal(c.size, 0);
  }

  let liberar;
  const portao = new Promise((ok2) => { liberar = ok2; });
  const junto = fetchFalso(async () => { await portao; return redirecionar(302, 'https://loja.test/p/5'); });
  const c2 = new Map();
  const pedidos = Array.from({ length: 10 }, () => resolverPorRedirecionamento('https://curto.test/j', opcoes(junto, { cache: c2, agora: rel.agora })));
  liberar();
  const res = await Promise.all(pedidos);
  assert.equal(junto.chamadas.length, 1);
  assert.notEqual(res[0].valor, res[1].valor);
});

test('rede: lerCorpoLimitado lê até o teto, recusa acima dele sem ler tudo e tolera corpo ruim', async () => {
  assert.deepEqual(await lerCorpoLimitado(new Response('{"a":1}'), 100), { texto: '{"a":1}', json: { a: 1 }, recusado: false });
  assert.deepEqual(await lerCorpoLimitado(new Response('não é json'), 100), { texto: 'não é json', json: null, recusado: false });
  assert.deepEqual(await lerCorpoLimitado(new Response('x'.repeat(101)), 100), { texto: '', json: null, recusado: true });
  assert.deepEqual(await lerCorpoLimitado({ body: null, text: async () => '{"b":2}' }, 100), { texto: '{"b":2}', json: { b: 2 }, recusado: false });
  for (const r of [null, {}, { body: {} }, { body: { getReader: () => ({ read: async () => { throw new Error('quebrou'); } }) } }]) {
    assert.deepEqual(await lerCorpoLimitado(r, 100), { texto: '', json: null, recusado: true });
  }
  for (const max of [0, -1, Number.NaN, undefined]) assert.equal((await lerCorpoLimitado(new Response('{}'), max)).recusado, true);

  const PEDACO = 1024;
  const s = { lidos: 0, cancelado: false };
  const body = new ReadableStream({ pull(c) { s.lidos++; c.enqueue(new Uint8Array(PEDACO).fill(0x61)); }, cancel() { s.cancelado = true; } }, { highWaterMark: 0 });
  assert.equal((await lerCorpoLimitado(new Response(body), 10 * PEDACO)).recusado, true);
  assert.ok(s.lidos <= 12, `leu ${s.lidos}`); assert.equal(s.cancelado, true);
  const s2 = { lidos: 0, cancelado: false };
  const body2 = new ReadableStream({ pull(c) { s2.lidos++; c.enqueue(new Uint8Array(PEDACO)); }, cancel() { s2.cancelado = true; } }, { highWaterMark: 0 });
  assert.equal((await lerCorpoLimitado(new Response(body2, { headers: { 'content-length': String(1e9) } }), 10 * PEDACO)).recusado, true);
  assert.equal(s2.lidos, 0); assert.equal(s2.cancelado, true);
});

test('rede: paraUrl e hostDaLista', () => {
  assert.equal(paraUrl('shp.ee/x').href, 'https://shp.ee/x');
  for (const v of ['javascript:alert(1)', 'https://u:p@a.test/', `https://a.test/${'a'.repeat(MAX_URL)}`, '', null, 1]) assert.equal(paraUrl(v), null, String(v).slice(0, 30));
  assert.ok(hostDaLista('X.Loja.test', ['loja.test']));
  for (const h of ['loja.test.evil', 'evilloja.test', '', null]) assert.ok(!hostDaLista(h, ['loja.test']), String(h));
});

test('titulo: tituloDeUmaLinha junta as linhas e corta antes de uma palavra, no teto pedido', () => {
  assert.equal(tituloDeUmaLinha('  Fone\n\tBom   Demais '), 'Fone Bom Demais');
  assert.equal(tituloDeUmaLinha('abc def ghi', 7), 'abc def');
  assert.equal(tituloDeUmaLinha('abc defghi', 7), 'abc');
  assert.equal(tituloDeUmaLinha('abcdefghij', 4), 'abcd', 'sem espaço, corta no teto');
  assert.equal(tituloDeUmaLinha('a'.repeat(200) + ' fim').length, 200, 'padrão de 200 (mesmo do painel)');
  for (const v of ['', '   ', null, undefined, 42, {}]) assert.equal(tituloDeUmaLinha(v), null, String(v));
  for (const max of [0, -1, 1.5, Number.NaN]) assert.equal(tituloDeUmaLinha('abc', max), null, String(max));
});

test('rede: o fetch global nunca foi chamado (CA8)', () => {
  assert.equal(chamadasGlobais, 0);
});
