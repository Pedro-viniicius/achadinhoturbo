// QA dos "Docs do sistema" (plano docs/produto/planos/docs-do-sistema.md, CA1 a CA8). Complementa test/docs.test.js
// (estrutura, escape, motor num DOM falso) com o que só aparece de verdade:
//   - Grupo A (vm, sem navegador): propriedades do livro inteiro (toda palavra é achável pela busca, caminhos do
//     painel citados existem, comandos sem segredo, sudo avisado) e o contrato do endereço em app.js (ir()).
//   - Grupo B (Chrome headless sobre o painel de verdade, DRY_RUN, porta aleatória, sem rede externa): o livro aberto
//     com mouse e teclado, foco, título da aba, Voltar/Avançar, progresso no localStorage, busca, Copiar, os "?" com
//     "Ler mais" (em página e em diálogo), o Operador, o percurso de todo o livro e as outras telas sem regressão.
// Os testes do grupo B só rodam se houver um Chrome/Chromium (variável CHROME_BIN ou google-chrome/chromium no PATH);
// sem ele, o grupo é pulado com o motivo na saída (nenhum teste do grupo A depende do navegador).
// Ids dos testes "QD<n>" (Docs; o Q3 antigo do dono é outro): reproduzem um bug aberto (falham até a correção).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(RAIZ, 'public');
const fonte = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8');
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = (pref) => { const p = fs.mkdtempSync(path.join(os.tmpdir(), pref)); pastas.push(p); return p; };
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================================================================
// Grupo A: o livro inteiro num vm
// =====================================================================================================================
const scriptsDocs = () => [...fonte('index.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]).filter((s) => s === 'docs.js' || s.startsWith('docs/'));
function carregarLivro() {
  const ctx = vm.createContext({});
  for (const arq of scriptsDocs()) vm.runInContext(fonte(arq), ctx, { filename: 'public/' + arq });
  return ctx;
}
const LIVRO = carregarLivro();
const rodar = (c, ctx = LIVRO) => vm.runInContext(c, ctx);
const CAPS = JSON.parse(rodar('JSON.stringify(DOCS_CAPS)'));
const TRILHA = JSON.parse(rodar('JSON.stringify(DOCS_TRILHA)'));

/** Todas as strings de um valor. `nota` (o tipo do bloco: aviso, dica, erro) não é texto do livro. */
function strings(v, saida = []) {
  if (typeof v === 'string') saida.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, saida));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (k !== 'nota') strings(x, saida); });
  return saida;
}
const semAcento = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

test('CA5: toda palavra do livro é achada pela busca na própria seção, sem acento e em maiúsculas', () => {
  // palavras (2+ letras) de títulos e blocos de cada seção; o quê → uma seção onde ela aparece
  const palavras = new Map();
  for (const c of Object.values(CAPS)) {
    for (const s of c.secoes) {
      for (const t of strings([s.titulo, s.blocos])) {
        const plano = rodar(`docsPlano(${JSON.stringify(t)})`);
        for (const w of plano.split(/[^\p{L}\p{N}]+/u)) {
          if (w.length < 2) continue;
          const k = semAcento(w);
          if (!palavras.has(k)) palavras.set(k, { cap: c.id, secao: s.id, original: w });
        }
      }
    }
  }
  assert.ok(palavras.size > 1000, `esperava mais de 1000 palavras distintas, achei ${palavras.size}`);
  const falhas = JSON.parse(rodar(`(() => {
    const falhas = []; const alvo = ${JSON.stringify([...palavras])};
    for (const [k, { cap, secao, original }] of alvo) {
      // palavra com acento: busca sem acento e em maiúsculas; sem acento: em maiúsculas (uma busca por palavra, para ser rápido)
      const termo = original === k ? original.toUpperCase() : k.toUpperCase();
      const r = docsBuscar(termo);
      if (!r.some((x) => x.cap === cap && x.secao === secao)) falhas.push(termo + ' → ' + cap + '/' + secao);
    }
    return JSON.stringify(falhas);
  })()`));
  assert.deepEqual(falhas, [], 'palavras que a busca não acha na seção de origem');
});

test('CA5: a busca devolve só links internos e o trecho escapado, para qualquer palavra do livro', () => {
  const html = JSON.parse(rodar(`(() => {
    const termos = ${JSON.stringify([...new Set(strings(Object.values(CAPS).flatMap((c) => c.secoes.map((s) => s.titulo))).flatMap((t) => t.split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 3))].slice(0, 400))};
    return JSON.stringify(termos.map((t) => docsHtmlBusca(t).html));
  })()`)).join('\n');
  for (const m of html.matchAll(/<a href="([^"]*)"/g)) assert.match(m[1], /^#docs(\/[a-z0-9-]+){1,2}$|^#docs$|^#referencia$/, `href ${m[1]}`);
  assert.doesNotMatch(html, /<(?!\/?(?:p|ol|li|a|span|mark|button)\b)[a-z]/i, 'tag fora da lista na busca');
  assert.doesNotMatch(html, /\son[a-z]+=/i);
});

test('CA8: todo segmento de caminho [[A → B]] do livro é um texto que existe de verdade no painel (menu, títulos, botões)', () => {
  // o painel inteiro (menu e telas) é o texto onde o segmento tem de aparecer
  const painel = semAcento([...fs.readdirSync(PUB).filter((f) => f.endsWith('.js') && f !== 'docs.js'), 'index.html'].map((f) => fonte(f)).join('\n'));
  // "cartão do disparo" descreve um cartão que não tem rótulo próprio; é o único segmento descritivo do livro
  const DESCRITIVOS = new Set(['cartao do disparo']);
  const sem = new Set();
  for (const s of strings(CAPS)) {
    for (const m of s.matchAll(/\[\[([^\[\]\n]+)\]\]/g)) {
      for (const seg of m[1].split('→').map((x) => semAcento(x.trim()))) {
        if (!DESCRITIVOS.has(seg) && !painel.includes(seg)) sem.add(`${seg} (em [[${m[1]}]])`);
      }
    }
  }
  assert.deepEqual([...sem], [], 'caminhos que citam um nome que não existe no painel');
});

test('CA8: nenhum comando do livro mostra segredo, e todo comando com sudo vem depois de um aviso da senha do computador', () => {
  const SEGREDO = /wa_auth|\.env|settings|ext_token|pseudo_key|PANEL_PASSWORD|sqlite|cat\s|echo\s/i;
  for (const c of Object.values(CAPS)) {
    for (const s of c.secoes) {
      const blocos = s.blocos;
      blocos.forEach((b, i) => {
        if (!b.comando) return;
        assert.doesNotMatch(b.comando, SEGREDO, `${c.id}/${s.id}: comando com cara de segredo: ${b.comando}`);
        if (/\bsudo\b/.test(b.comando)) {
          const antes = strings(blocos.slice(0, i)).join(' ');
          assert.match(antes, /senha do computador/, `${c.id}/${s.id}: sudo sem avisar da senha do computador antes`);
          assert.ok(blocos.slice(0, i).some((x) => x.nota === 'aviso'), `${c.id}/${s.id}: sudo sem uma nota de aviso antes`);
        }
      });
    }
  }
});

test('CA8: o livro não traz segredo, ID real nem e-mail de pessoa (só os exemplos seunome-20 e 98765432101)', () => {
  const tudo = strings(CAPS).join('\n');
  assert.doesNotMatch(tudo, /[a-f0-9]{24,}/i, 'sequência hexadecimal longa (token?)');
  assert.doesNotMatch(tudo, /\b\d{10,}\b(?<!98765432101)/, 'número longo que não é o exemplo');
  for (const e of tudo.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []) assert.match(e, /@exemplo\./, `e-mail real? ${e}`);
  assert.doesNotMatch(tudo, /Bearer|x-token|api_token\s*[:=]\s*\S{8,}/i);
});

// ---------------------------------------------------------------------------------------------------------------
// Contrato do endereço (app.js ir()): o que o endereço mostra é a página que abriu
/** app.js num vm com DOM mínimo; paginaDocs vira espião. Devolve ir(hash) → { endereco, pedido }. */
function irDoPainel() {
  const falso = () => ({ addEventListener() {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, setAttribute() {}, removeAttribute() {}, getAttribute: () => null, focus() {}, contains: () => false, open: false });
  const hist = []; const chamadas = [];
  const ctx = vm.createContext({
    document: { querySelector: falso, querySelectorAll: () => [], addEventListener() {}, getElementById: () => null, activeElement: null, body: {} },
    location: { hash: '' }, history: { replaceState: (_a, _b, h) => { hist.push(h); ctx.location.hash = h; } }, addEventListener() {}, console,
    fetch: () => new Promise(() => {}), setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
  });
  ctx.window = ctx;
  vm.runInContext(fonte('docs.js'), ctx, { filename: 'public/docs.js' });
  vm.runInContext(fonte('app.js'), ctx, { filename: 'public/app.js' });
  vm.runInContext('paginaDocs = (p) => { globalThis.__docs.push(p); }; globalThis.__docs = [];', ctx);
  return (hash) => {
    ctx.location.hash = hash; hist.length = 0; ctx.__docs.length = 0;
    vm.runInContext('ir()', ctx);
    return { endereco: ctx.location.hash, pedido: ctx.__docs.at(-1), docs: ctx };
  };
}
const selecao = (ctx, pedido) => JSON.parse(vm.runInContext(`JSON.stringify(docsPedido(${JSON.stringify(pedido ?? null)}))`, ctx));

test('ir(): endereços válidos dos Docs ficam como estão e abrem o que dizem', () => {
  const ir = irDoPainel();
  for (const h of ['#docs', '#docs/conexoes', '#docs/conexoes/amazon', '#docs/xyz', '#docs/perguntas/tag-amazon']) {
    const r = ir(h);
    assert.equal(r.endereco, h, `endereço de ${h}`);
    assert.equal(r.pedido, h.slice(1), `pedido de ${h}`);
  }
  assert.equal(ir('#ajuda').endereco, '#docs');
  assert.equal(ir('#ajuda/conexoes/amazon').endereco, '#docs', 'o alias abre o início dos Docs');
  assert.equal(ir('#docs?x=1').endereco, '#docs');
  assert.equal(ir('#docs/conexoes?x=1').endereco, '#docs/conexoes');
});

test('QD2: endereço malformado dos Docs (barra no fim, maiúscula, 3 níveis): o endereço reescrito mostra a mesma página que foi aberta', () => {
  const ir = irDoPainel(); const divergentes = [];
  for (const h of ['#docs/conexoes/', '#docs/conexoes/amazon/', '#docs/CONEXOES', '#docs/a/b/c', '#docs/conexoes/__proto__', '#docs/conexoes/Amazon']) {
    const r1 = ir(h); // abre a página e reescreve o endereço
    const aberta = selecao(r1.docs, r1.pedido);
    const r2 = ir(r1.endereco); // recarregar o endereço reescrito tem de abrir a mesma página
    const recarregada = selecao(r2.docs, r2.pedido);
    if (JSON.stringify(aberta) !== JSON.stringify(recarregada)) divergentes.push(`${h}: abriu ${JSON.stringify(aberta)} mas o endereço reescrito (${r1.endereco}) abre ${JSON.stringify(recarregada)}`);
  }
  assert.deepEqual(divergentes, []);
});

// =====================================================================================================================
// Grupo B: Chrome headless sobre o painel de verdade
// =====================================================================================================================
function acharChrome() {
  const candidatos = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const c of candidatos) {
    if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; continue; }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) { const f = path.join(dir, c); if (fs.existsSync(f)) return f; }
  }
  return null;
}
const CHROME = acharChrome();
const SEM_CHROME = CHROME ? false : 'sem Chrome/Chromium (defina CHROME_BIN): os testes de navegador real dos Docs foram pulados';
const NAV = { skip: SEM_CHROME, timeout: 90000 };

const livre = () => new Promise((ok, falha) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); s.on('error', falha); });
const filhos = [];
const encerrar = async (filho) => {
  if (!filho || filho.exitCode != null || filho.signalCode != null) return;
  const saiu = new Promise((r) => filho.once('exit', r));
  try { process.kill(-filho.pid, 'SIGKILL'); } catch { try { filho.kill('SIGKILL'); } catch { /* já saiu */ } }
  await Promise.race([saiu, dorme(3000)]);
};
after(async () => { for (const f of filhos) await encerrar(f); });

/** Painel de verdade (src/server.js) em porta livre, simulado, sem login, num DATA_DIR descartável. */
async function subirPainel() {
  const dir = tmp('disp-qadocs-'); const porta = await livre();
  const env = { ...process.env, PORT: String(porta), DATA_DIR: dir, DRY_RUN: '1', FAST: '1', PANEL_PASSWORD: '', PUBLIC_HOST: '', TMPDIR: dir };
  const filho = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(RAIZ, 'src', 'server.js')], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  filhos.push(filho);
  let saida = '';
  await new Promise((ok, falha) => {
    const timer = setTimeout(() => falha(new Error(`servidor não subiu em 20 s:\n${saida}`)), 20000);
    const ler = (c) => { saida += c; if (/rodando em http/.test(saida)) { clearTimeout(timer); ok(); } };
    filho.stdout.on('data', ler); filho.stderr.on('data', ler);
    filho.once('exit', (c) => { clearTimeout(timer); falha(new Error(`servidor saiu (${c}):\n${saida}`)); });
  });
  return { base: `http://127.0.0.1:${porta}`, porta, filho, dir };
}

/** Chrome headless com depuração remota em porta que ele escolhe (lida do arquivo DevToolsActivePort). */
async function subirChrome() {
  // Pasta curta: o Chrome cria um socket no TMPDIR e o caminho do socket tem limite (um TMPDIR comprido derruba o Chrome).
  const curto = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : '/tmp', 'qadocs-'));
  pastas.push(curto);
  const perfil = path.join(curto, 'p'); fs.mkdirSync(perfil);
  const args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--remote-debugging-port=0',
    `--user-data-dir=${perfil}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'];
  const filho = spawn(CHROME, args, { stdio: 'ignore', detached: true, env: { ...process.env, TMPDIR: curto } });
  filhos.push(filho);
  const arq = path.join(perfil, 'DevToolsActivePort');
  const t0 = Date.now();
  while (!fs.existsSync(arq) || !fs.readFileSync(arq, 'utf8').includes('\n')) {
    if (Date.now() - t0 > 20000) throw new Error('Chrome não abriu a porta de depuração em 20 s');
    await dorme(50);
  }
  return { porta: Number(fs.readFileSync(arq, 'utf8').split('\n')[0]), filho };
}

// A Visão Geral desenha um "Carregando…" e só depois põe os dados (e sobrescreve a página aberta nesse meio tempo):
// só se considera pronta quando a grade de dados apareceu.
const VISAO_PRONTA = "!!document.querySelector('#pagina .grade-vg')";

/** Uma aba com o driver CDP mínimo (WebSocket global do Node 22). */
async function abrirAba(chrome, url) {
  const alvo = await (await fetch(`http://127.0.0.1:${chrome.porta}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok, falha) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => falha(new Error('WebSocket do Chrome'))); });
  let n = 0; const esperando = new Map(); const eventos = [];
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && esperando.has(d.id)) { esperando.get(d.id)(d); esperando.delete(d.id); } else if (d.method) eventos.push(d);
  });
  const cmd = (method, params = {}) => new Promise((ok, err) => { const id = ++n; esperando.set(id, (d) => (d.error ? err(new Error(JSON.stringify(d.error))) : ok(d.result))); ws.send(JSON.stringify({ id, method, params })); });
  await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Log.enable'); await cmd('Page.bringToFront'); // aba em primeiro plano: o hover do mouse só chega a ela assim
  const js = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'erro de JavaScript na página');
    return r.result.value;
  };
  const esperar = async (expr, ms = 8000, rotulo = expr) => {
    const t0 = Date.now(); let ultimo;
    while (Date.now() - t0 < ms) { try { ultimo = await js(expr); if (ultimo) return ultimo; } catch (e) { ultimo = e.message; } await dorme(30); }
    throw new Error(`timeout esperando: ${rotulo} (último: ${JSON.stringify(ultimo)})`);
  };
  const tela = (w, h = 900) => cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  const tecla = async (key) => {
    const mapa = { Tab: [9, 'Tab'], Enter: [13, 'Enter'], Escape: [27, 'Escape'], ' ': [32, 'Space'] }; const [vk, code] = mapa[key];
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key === 'Enter') await cmd('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
    if (key === ' ') await cmd('Input.dispatchKeyEvent', { type: 'char', ...base, text: ' ' });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const clicar = async (sel) => {
    const pos = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (!pos) throw new Error('sem elemento para clicar: ' + sel);
    const [x, y] = pos;
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  /** Vai para outra tela. Só passa antes pela Visão Geral se o hash já for o pedido (o painel não repinta a tela quando o hash não muda). */
  const ir = async (hash) => {
    if ((await js('location.hash')) === hash) { await js("location.hash = '#visao'"); await esperar(VISAO_PRONTA); }
    await js(`location.hash = ${JSON.stringify(hash)}`); await dorme(60);
  };
  const erros = () => eventos
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => JSON.stringify(e.params).slice(0, 300))
    .filter((s) => !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(s)); // o painel pede as fontes do Google; sem rede, falha de propósito
  return { id: alvo.id, cmd, js, esperar, tela, tecla, clicar, ir, erros, fechar: async () => { try { ws.close(); await fetch(`http://127.0.0.1:${chrome.porta}/json/close/${alvo.id}`); } catch { /* aba já fechou */ } } };
}

let painel; let chrome;
before(async () => { if (SEM_CHROME) return; [painel, chrome] = await Promise.all([subirPainel(), subirChrome()]); }, { timeout: 60000 });

/** Aba nova no painel, já na Visão Geral e com o localStorage dos Docs limpo. */
async function aba(t, { largura = 1280, base = () => painel.base } = {}) {
  const p = await abrirAba(chrome, base() + '/#visao');
  t.after(() => p.fechar());
  await p.tela(largura);
  await p.esperar(VISAO_PRONTA, 15000, 'painel carregado');
  await p.js("localStorage.removeItem('docs.lidos')");
  return p;
}
const foco = (p) => p.js("(() => { const e = document.activeElement; return e ? (e.id || e.tagName) : ''; })()");
/** Espera o livro estar desenhado para o endereço (não só o hash igual: a tela anterior ainda pode estar no DOM). */
async function abriuDocs(p, hash) {
  const cap = hash.split('/')[1] || '';
  const estado = `(() => {
    const cur = document.querySelector('.docs-toc a[aria-current="page"]')?.getAttribute('href');
    const certo = ${JSON.stringify(cap)} ? (cur === '#docs/' + ${JSON.stringify(cap)} || (!cur && !Object.hasOwn(DOCS_CAPS, ${JSON.stringify(cap)}))) : cur === '#docs';
    return { hash: location.hash, cur, certo, titulo: document.querySelector('#docs-titulo')?.textContent || null };
  })()`;
  try { await p.esperar(`(() => { const e = ${estado}; return e.hash === ${JSON.stringify(hash)} && e.certo && !!e.titulo; })()`, 8000, 'Docs em ' + hash); }
  catch (e) { throw new Error(`${e.message} | estado: ${JSON.stringify(await p.js(estado).catch((x) => x.message))}`); }
}

test('CA1/CA6: menu "Docs" no rodapé, sem "Ajuda"; #ajuda e #ajuda/… abrem o Início dos Docs com o endereço #docs', NAV, async (t) => {
  const p = await aba(t);
  const menu = JSON.parse(await p.js("JSON.stringify([...document.querySelectorAll('#rail nav a')].map((a) => [a.textContent.trim(), a.getAttribute('href')]))"));
  assert.ok(menu.some(([txt, href]) => txt === 'Docs' && href === '#docs'), JSON.stringify(menu));
  assert.ok(!menu.some(([txt, href]) => txt === 'Ajuda' || href === '#ajuda'), 'o item Ajuda saiu do menu');
  await p.clicar('#rail nav a[href="#docs"]');
  await abriuDocs(p, '#docs');
  assert.equal(await p.js("document.querySelector('h1').textContent"), 'Docs do sistema');
  assert.equal(await p.js('document.title'), 'Docs do sistema');
  assert.equal(await foco(p), 'docs-titulo', 'o foco vai para o título do conteúdo');
  assert.equal(await p.js("document.querySelector('#menu-atual').textContent"), '· Docs');
  assert.equal(await p.js("document.querySelector('#rail nav a[aria-current=\"page\"]')?.textContent"), 'Docs');
  for (const antigo of ['#ajuda', '#ajuda/conexoes/amazon']) {
    await p.ir(antigo); await abriuDocs(p, '#docs');
    assert.equal(await p.js("document.querySelector('#docs-titulo').textContent"), 'Início', antigo);
  }
  assert.deepEqual(p.erros(), []);
});

test('CA1: link direto #docs/<capítulo>/<seção> (recarregando a página): foco no h3, título da aba, seção marcada no sumário; seção inexistente abre o capítulo no topo', NAV, async (t) => {
  const p = await aba(t);
  await p.js("location.hash = '#docs/conexoes/amazon'"); await abriuDocs(p, '#docs/conexoes/amazon');
  await p.js('location.reload()');
  await p.esperar("document.querySelector('#docs-s-amazon') && document.activeElement?.id === 'docs-s-amazon'", 10000, 'foco no h3 depois de recarregar');
  assert.equal(await p.js('document.title'), 'Conexões: suas lojas · Docs do sistema');
  assert.equal(await p.js("document.activeElement.tagName"), 'H3');
  assert.equal(await p.js("document.querySelector('.docs-toc a[aria-current=\"location\"]')?.getAttribute('href')"), '#docs/conexoes/amazon');
  assert.equal(await p.js("document.querySelector('.docs-toc a[aria-current=\"page\"]')?.getAttribute('href')"), '#docs/conexoes');
  await p.ir('#docs/conexoes/nao-existe'); await abriuDocs(p, '#docs/conexoes/nao-existe');
  assert.equal(await foco(p), 'docs-titulo');
  assert.equal(await p.js('scrollY'), 0, 'seção inexistente: capítulo no topo');
  assert.equal(await p.js("document.querySelector('.docs-toc a[aria-current=\"location\"]')"), null);
});

test('CA1: capítulo inexistente mantém o endereço, mostra "Não achamos este capítulo", título da aba próprio e leva ao início', NAV, async (t) => {
  const p = await aba(t);
  await p.js("location.hash = '#docs/xyz'"); await abriuDocs(p, '#docs/xyz');
  assert.equal(await p.js("document.querySelector('#docs-titulo').textContent"), 'Não achamos este capítulo');
  assert.equal(await p.js('document.title'), 'Capítulo não encontrado · Docs do sistema');
  assert.equal(await foco(p), 'docs-titulo');
  await p.clicar('.docs-vazio a.btn');
  await p.esperar("location.hash === '#docs' && document.querySelector('#docs-titulo')?.textContent === 'Início'");
  // nomes que existem em Object.prototype não podem virar capítulo
  for (const nome of ['constructor']) {
    await p.ir('#docs/' + nome); await abriuDocs(p, '#docs/' + nome);
    assert.equal(await p.js("document.querySelector('#docs-titulo').textContent"), 'Não achamos este capítulo', nome);
  }
  // sair dos Docs devolve o título do painel
  await p.ir('#ajustes'); await p.esperar("document.querySelector('#pagina h1')?.textContent.startsWith('Ajustes')");
  assert.equal(await p.js('document.title'), 'achadinhoturbo');
});

test('CA1: Anterior e Próximo (mouse e Enter) levam ao capítulo vizinho com foco no título; Voltar e Avançar do navegador refazem a leitura', NAV, async (t) => {
  const p = await aba(t);
  await p.js("location.hash = '#docs'"); await abriuDocs(p, '#docs');
  await p.clicar('#docs-inicio-cta a.btn');
  await abriuDocs(p, '#docs/primeiros-passos');
  assert.equal(await p.js('document.title'), 'Primeiros passos · Docs do sistema');
  await p.clicar('.docs-nav-prox'); await abriuDocs(p, '#docs/conexoes');
  assert.equal(await foco(p), 'docs-titulo');
  await p.js("document.querySelector('.docs-nav-prox').focus()"); await p.tecla('Enter');
  await abriuDocs(p, '#docs/templates');
  assert.equal(await p.js('document.title'), 'Templates: o texto da mensagem · Docs do sistema');
  await p.clicar('.docs-nav-ant'); await abriuDocs(p, '#docs/conexoes');
  await p.js('history.back()'); await abriuDocs(p, '#docs/templates');
  assert.equal(await p.js('document.title'), 'Templates: o texto da mensagem · Docs do sistema');
  assert.equal(await foco(p), 'docs-titulo');
  await p.js('history.forward()'); await abriuDocs(p, '#docs/conexoes');
  // primeiro capítulo: Anterior vai ao Início; último: Próximo leva às Perguntas reais
  await p.ir('#docs/primeiros-passos'); await abriuDocs(p, '#docs/primeiros-passos');
  assert.equal(await p.js("document.querySelector('.docs-nav-ant').getAttribute('href')"), '#docs');
  await p.ir('#docs/manutencao'); await abriuDocs(p, '#docs/manutencao');
  assert.equal(await p.js("document.querySelector('.docs-nav-prox').getAttribute('href')"), '#docs/perguntas');
  await p.ir('#docs/referencia'); await abriuDocs(p, '#docs/referencia');
  assert.equal(await p.js("document.querySelector('.docs-nav-ant, .docs-nav-prox')"), null, 'apêndice sem Anterior/Próximo');
  assert.deepEqual(p.erros(), []);
});

test('CA1: progresso no localStorage — "Próximo" marca, "Marcar como lido" desmarca, "Continuar do capítulo N", "Limpar progresso" devolve o foco', NAV, async (t) => {
  const p = await aba(t);
  await p.js("location.hash = '#docs'"); await abriuDocs(p, '#docs');
  assert.match(await p.js("document.querySelector('#docs-inicio-cta').textContent"), /^0 de 13 lidos\. Fica salvo só neste navegador\.Começar pelo capítulo 1$/);
  await p.ir('#docs/primeiros-passos'); await abriuDocs(p, '#docs/primeiros-passos');
  assert.equal(await p.js("localStorage.getItem('docs.lidos')"), null, 'abrir não marca');
  await p.clicar('.docs-nav-prox'); await abriuDocs(p, '#docs/conexoes');
  assert.equal(await p.js("localStorage.getItem('docs.lidos')"), '["primeiros-passos"]');
  assert.equal(await p.js("document.querySelector('.docs-progresso-t').textContent"), '1 de 13 lidos');
  assert.match(await p.js("document.querySelector('.docs-toc a[href=\"#docs/primeiros-passos\"]').textContent"), /✓.*\(lido\)/s);
  // caixa "Marcar como lido" do capítulo 2: marca e desmarca
  await p.clicar('#docs-lido');
  await p.esperar("localStorage.getItem('docs.lidos') === '[\"primeiros-passos\",\"conexoes\"]'");
  await p.clicar('#docs-lido');
  await p.esperar("localStorage.getItem('docs.lidos') === '[\"primeiros-passos\"]'");
  await p.ir('#docs'); await abriuDocs(p, '#docs');
  assert.match(await p.js("document.querySelector('#docs-inicio-cta').textContent"), /1 de 13 lidos.*Continuar do capítulo 2$/);
  await p.clicar('[data-docs-limpar-progresso]');
  await p.esperar("localStorage.getItem('docs.lidos') === null");
  assert.equal(await foco(p), 'docs-progresso-t', 'o botão sumiu: o foco vai para o resumo do progresso');
  assert.equal(await p.js("document.querySelector('[data-docs-limpar-progresso]')"), null);
  assert.match(await p.js("document.querySelector('#docs-inicio-cta').textContent"), /^0 de 13 lidos.*Começar pelo capítulo 1$/);
  assert.deepEqual(p.erros(), []);
});

test('CA1: localStorage com lixo ou bloqueado não quebra o livro (valor inválido = nenhum lido; bloqueado = sem progresso)', NAV, async (t) => {
  const p = await aba(t);
  for (const lixo of ['{{ruim', '"texto"', '{"a":1}', 'null', '[1,2,{"x":1}]', '["__proto__","constructor"]']) {
    await p.js(`localStorage.setItem('docs.lidos', ${JSON.stringify(lixo)})`);
    await p.ir('#docs'); await abriuDocs(p, '#docs');
    assert.equal(await p.js("document.querySelector('.docs-progresso-t').textContent"), '0 de 13 lidos', lixo);
  }
  await p.js("localStorage.removeItem('docs.lidos')");
  await p.cmd('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('bloqueado', 'SecurityError'); }, configurable: true });" });
  await p.js("location.hash = '#docs/conexoes'"); await p.js('location.reload()');
  await p.esperar("document.querySelector('#docs-titulo')?.textContent === 'Conexões: suas lojas'", 12000, 'livro abre com localStorage bloqueado');
  assert.equal(await p.js("document.querySelector('.docs-progresso-t')"), null);
  assert.equal(await p.js("document.querySelector('#docs-lido')"), null);
  await p.clicar('.docs-nav-prox'); await abriuDocs(p, '#docs/templates');
  assert.deepEqual(p.erros(), []);
});

test('CA5: busca no navegador — sem acento, 1 letra, sem resultado, Esc e "Limpar busca" voltam ao capítulo, HTML digitado não vira tag', NAV, async (t) => {
  const p = await aba(t);
  await p.js("location.hash = '#docs/conexoes'"); await abriuDocs(p, '#docs/conexoes');
  const digitar = (txt) => p.js(`(() => { const q = document.querySelector('#docs-q'); q.focus(); q.value = ${JSON.stringify(txt)}; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await digitar('catalogo');
  await p.esperar("document.querySelector('#docs-resultados').hidden === false && document.querySelector('#docs-conteudo').hidden === true");
  const r1 = await p.js("document.querySelector('.docs-res-resumo').textContent");
  assert.match(r1, /^\d+ resultados para “catalogo”$/);
  const marcado = await p.js("[...document.querySelectorAll('#docs-resultados mark')].map((m) => m.textContent.toLowerCase().normalize('NFD').replace(/\\p{M}/gu, ''))");
  assert.ok(marcado.length > 0 && marcado.every((m) => m === 'catalogo'), JSON.stringify(marcado));
  assert.equal(await p.js("document.querySelectorAll('#docs-resultados li').length"), 20, 'no máximo 20 resultados');
  assert.match(await p.js("document.querySelector('#docs-resultados').textContent"), /Mostrando 20 de \d+\. Refine a busca\./);
  await p.esperar("/resultados para “catalogo”/.test(document.querySelector('#docs-status').textContent)", 3000, 'o resumo é anunciado no role=status');
  // maiúsculas e acento dão o mesmo número de resultados
  await digitar('CATÁLOGO'); await p.esperar("document.querySelector('.docs-res-resumo')?.textContent.includes('CATÁLOGO')");
  assert.equal((await p.js("document.querySelector('.docs-res-resumo').textContent")).replace('CATÁLOGO', 'catalogo'), r1);
  // sem resultado: links para Perguntas reais e Referência
  await digitar('zzqqxx'); await p.esperar("document.querySelector('.docs-res-resumo')?.textContent === 'Nada encontrado para “zzqqxx”.'");
  assert.deepEqual(await p.js("[...document.querySelectorAll('#docs-resultados a')].map((a) => a.getAttribute('href'))"), ['#docs/perguntas', '#docs/referencia']);
  // Esc no campo: volta ao capítulo, limpa o campo e o foco fica nele
  await p.tecla('Escape');
  await p.esperar("document.querySelector('#docs-resultados').hidden === true && document.querySelector('#docs-conteudo').hidden === false");
  assert.equal(await p.js("document.querySelector('#docs-q').value"), '');
  assert.equal(await foco(p), 'docs-q');
  // "Limpar busca" pelo teclado
  await digitar('backup'); await p.esperar("document.querySelector('#docs-resultados').hidden === false");
  await p.js("document.querySelector('[data-docs-limpar]').focus()"); await p.tecla('Enter');
  await p.esperar("document.querySelector('#docs-resultados').hidden === true");
  assert.equal(await foco(p), 'docs-q');
  // 1 letra: nada acontece (os resultados anteriores não mudam e nenhum erro)
  await digitar('x'); await dorme(400);
  assert.equal(await p.js("document.querySelector('#docs-resultados').hidden"), true);
  // HTML digitado vira texto
  await digitar('<img src=x onerror="window.__xss=1">'); await p.esperar("document.querySelector('.docs-res-resumo')?.textContent.startsWith('Nada encontrado')");
  assert.equal(await p.js("document.querySelectorAll('#docs-resultados img').length"), 0);
  assert.equal(await p.js('window.__xss === undefined'), true);
  assert.deepEqual(p.erros(), []);
});

test('QD1: clicar num resultado da busca que aponta para o endereço em que a pessoa já está fecha a busca e mostra a seção', NAV, async (t) => {
  const p = await aba(t);
  await p.js("location.hash = '#docs/conexoes/amazon'"); await abriuDocs(p, '#docs/conexoes/amazon');
  await p.js(`(() => { const q = document.querySelector('#docs-q'); q.value = 'amazon'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.esperar("document.querySelector('#docs-resultados').hidden === false && !!document.querySelector('#docs-resultados a[href=\"#docs/conexoes/amazon\"]')");
  await p.clicar('#docs-resultados a[href="#docs/conexoes/amazon"]');
  await dorme(500);
  assert.equal(await p.js('location.hash'), '#docs/conexoes/amazon');
  assert.equal(await p.js("document.querySelector('#docs-resultados').hidden"), true, 'a busca continua na tela: o clique no resultado da seção atual não fez nada');
});

test('CA5 (rodada 2): Esc com o foco nos resultados limpa a busca e 1 letra esconde a lista antiga', NAV, async (t) => {
  const p = await aba(t);
  await p.js("location.hash = '#docs/conexoes'"); await abriuDocs(p, '#docs/conexoes');
  const digitar = (txt) => p.js(`(() => { const q = document.querySelector('#docs-q'); q.focus(); q.value = ${JSON.stringify(txt)}; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await digitar('backup'); await p.esperar("document.querySelector('#docs-resultados').hidden === false");
  await p.js("document.querySelector('#docs-resultados a').focus()"); await p.tecla('Escape');
  await p.esperar("document.querySelector('#docs-resultados').hidden === true && document.querySelector('#docs-conteudo').hidden === false");
  assert.equal(await p.js("document.querySelector('#docs-q').value"), '');
  await digitar('backup'); await p.esperar("document.querySelector('#docs-resultados').hidden === false");
  await digitar('b'); await p.esperar("document.querySelector('#docs-resultados').hidden === true || document.querySelector('#docs-resultados li') === null", 3000, '1 letra esconde a lista antiga');
  assert.deepEqual(p.erros(), []);
});

test('CA1: o sumário em 375 px é um <details> fechado (Enter e Espaço abrem), escolher um capítulo fecha; em 1280 px fica aberto; sem rolagem horizontal', NAV, async (t) => {
  const p = await aba(t, { largura: 375 });
  await p.js("location.hash = '#docs/disparo-automatico'"); await abriuDocs(p, '#docs/disparo-automatico');
  assert.equal(await p.js("document.querySelector('#docs-toc summary').textContent"), 'Sumário · cap. 5 de 13 · Disparo automático');
  assert.equal(await p.js("document.querySelector('#docs-toc').open"), false);
  assert.ok((await p.js("document.querySelector('#docs-toc summary').getBoundingClientRect().height")) >= 44, 'summary com 44 px ou mais');
  await p.js("document.querySelector('#docs-toc summary').focus()");
  await p.tecla('Enter'); assert.equal(await p.js("document.querySelector('#docs-toc').open"), true);
  await p.tecla('Enter'); assert.equal(await p.js("document.querySelector('#docs-toc').open"), false);
  await p.tecla(' '); assert.equal(await p.js("document.querySelector('#docs-toc').open"), true);
  await p.clicar('.docs-toc-trilha > li:nth-child(4) > a');
  await abriuDocs(p, '#docs/disparo-manual');
  assert.equal(await p.js("document.querySelector('#docs-toc').open"), false, 'a página recarrega com o sumário fechado');
  for (const alvo of ['.docs-nav-prox', '.docs-nav-ant']) assert.ok((await p.js(`document.querySelector('${alvo}').getBoundingClientRect().height`)) >= 44, alvo);
  assert.ok((await p.js("document.querySelector('.docs-nav-prox').getBoundingClientRect().top")) < (await p.js("document.querySelector('.docs-nav-ant').getBoundingClientRect().top")), '"Próximo" vem primeiro no celular');
  await p.tela(1280); await p.esperar("document.querySelector('#docs-toc').open === true", 4000, 'sumário abre ao alargar');
  assert.equal(await p.js("getComputedStyle(document.querySelector('#docs-toc')).position"), 'sticky');
  assert.equal(await p.js("document.querySelector('#docs-toc').getBoundingClientRect().width"), 260);
  // pular o sumário
  await p.js("document.querySelector('.docs-pular').focus()"); await p.tecla('Enter');
  assert.equal(await foco(p), 'docs-titulo');
  assert.deepEqual(p.erros(), []);
});

test('CA4/CA7: percorre o livro todo em 1280 e 375 px: nenhum link interno quebrado, id repetido, título pulado nem rolagem horizontal; cada seção recebe o foco', NAV, async (t) => {
  const p = await aba(t);
  const rotas = new Set(JSON.parse(await p.js('JSON.stringify([...Object.keys(ROTAS), ...Object.keys(ALIASES)])')));
  const trilha = JSON.parse(await p.js('JSON.stringify(DOCS_TRILHA.map((x) => ({ id: x.id, secoes: DOCS_CAPS[x.id].secoes.map((s) => s.id) })))'));
  const secoesDe = Object.fromEntries(trilha.map((c) => [c.id, c.secoes]));
  const links = new Set(); const problemas = [];
  for (const largura of [1280, 375]) {
    await p.tela(largura);
    for (const c of trilha) {
      await p.ir('#docs/' + c.id); await abriuDocs(p, '#docs/' + c.id);
      const r = JSON.parse(await p.js(`JSON.stringify({
        hrefs: [...document.querySelectorAll('#pagina a[href]')].map((a) => a.getAttribute('href')),
        repetidos: (() => { const n = {}; document.querySelectorAll('[id]').forEach((e) => { n[e.id] = (n[e.id] || 0) + 1; }); return Object.keys(n).filter((k) => n[k] > 1); })(),
        sobra: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        niveis: [...document.querySelectorAll('#pagina h1, #pagina h2, #pagina h3, #pagina h4')].map((h) => Number(h.tagName[1])),
        foco: document.activeElement.id, titulo: document.title,
        linkSemTexto: [...document.querySelectorAll('#pagina a')].filter((a) => !(a.textContent.trim() || a.getAttribute('aria-label'))).length,
      })`));
      if (r.repetidos.length) problemas.push(`${c.id}: ids repetidos ${r.repetidos}`);
      if (r.foco !== 'docs-titulo') problemas.push(`${c.id}: foco em "${r.foco}"`);
      if (r.linkSemTexto) problemas.push(`${c.id}: ${r.linkSemTexto} link(s) sem texto`);
      r.niveis.forEach((n, i) => { if (i && n - r.niveis[i - 1] > 1) problemas.push(`${c.id}: título pulou de h${r.niveis[i - 1]} para h${n}`); });
      r.hrefs.forEach((h) => links.add(h));
    }
  }
  assert.ok(links.size > 80, `esperava mais de 80 links distintos, vi ${links.size}`);
  for (const h of links) {
    const [rota, cap, sec, resto] = h.slice(1).split('/');
    if (!h.startsWith('#') || resto !== undefined || !rotas.has(rota)) { problemas.push(`link para rota inexistente: ${h}`); continue; }
    if (rota === 'docs' && cap && !secoesDe[cap]) problemas.push(`link para capítulo inexistente: ${h}`);
    else if (rota === 'docs' && cap && sec && !secoesDe[cap].includes(sec)) problemas.push(`link para seção inexistente: ${h}`);
  }
  // cada seção aberta pelo endereço: foco no h3 da seção e título da aba do capítulo
  await p.tela(1280);
  for (const c of trilha) {
    for (const s of c.secoes) {
      await p.ir(`#docs/${c.id}/${s}`);
      const noH3 = `document.activeElement?.id === 'docs-s-${s}'`;
      try { await p.esperar(noH3, 4000); } catch {
        // uma segunda tentativa: em máquina carregada a primeira pintura de capítulo longo pode passar de 4 s
        await p.ir(`#docs/${c.id}/${s}`);
        try { await p.esperar(noH3, 6000); } catch { problemas.push(`${c.id}/${s}: o foco não foi para o h3 (está em "${await foco(p)}")`); }
      }
    }
  }
  assert.deepEqual(problemas, []);
  assert.deepEqual(p.erros(), []);
});

/** Capítulos cuja página rola na horizontal na largura dada (só a tabela pode rolar, dentro do próprio quadro). */
async function capitulosQueRolam(p, largura) {
  await p.tela(largura);
  const ids = JSON.parse(await p.js('JSON.stringify(DOCS_TRILHA.map((x) => x.id))'));
  const problemas = [];
  for (const id of ids) {
    await p.ir('#docs/' + id); await abriuDocs(p, '#docs/' + id);
    const sobra = await p.js('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    if (sobra > 0) problemas.push(`${largura}px ${id}: a página rola ${sobra}px na horizontal`);
  }
  return problemas;
}

test('QD4: em 375 px nenhum capítulo faz a página rolar na horizontal (o .sr-only dos caminhos dentro de tabela escapa do quadro que rola)', NAV, async (t) => {
  assert.deepEqual(await capitulosQueRolam(await aba(t), 375), []);
});

test('QD5: em 320 px (reflow, WCAG 1.4.10) nenhum capítulo faz a página rolar na horizontal', NAV, async (t) => {
  assert.deepEqual(await capitulosQueRolam(await aba(t), 320), []);
});

test('CA3: as 10 Perguntas reais — cada uma com "Onde", com "Ler o capítulo" que leva à seção certa e com endereço próprio', NAV, async (t) => {
  const p = await aba(t);
  const ids = ['tag-amazon', 'meli-la', 'precisa-api', 'id-shopee', 'catalogo', 'etiqueta-desta-fonte', 'so-catalogo', 'catalogo-links', 'limpar-log', 'painel-local'];
  await p.js("location.hash = '#docs/perguntas'"); await abriuDocs(p, '#docs/perguntas');
  assert.deepEqual(await p.js("[...document.querySelectorAll('.docs-indice a')].map((a) => a.getAttribute('href'))"), ids.map((i) => '#docs/perguntas/' + i));
  for (const id of ids) {
    await p.ir(`#docs/perguntas/${id}`); await p.esperar(`document.activeElement?.id === 'docs-s-${id}'`, 5000, 'foco na pergunta ' + id);
    const s = JSON.parse(await p.js(`JSON.stringify((() => { const sec = document.querySelector('#docs-s-${id}').closest('section'); return { onde: sec.querySelector('.docs-onde')?.textContent || '', leia: sec.querySelector('.docs-leia a')?.getAttribute('href') || '', h3: sec.querySelector('h3').textContent }; })())`));
    assert.match(s.onde, /^Onde:\s+\S/, `${id}: sem "Onde:"`);
    assert.match(s.leia, /^#docs\/[a-z0-9-]+\/[a-z0-9-]+$/, `${id}: sem "Ler o capítulo"`);
    assert.match(s.h3, /\?$/, `${id}: o título é a pergunta`);
    await p.clicar(`section[aria-labelledby="docs-s-${id}"] .docs-leia a`);
    await abriuDocs(p, s.leia);
    const [cap, sec] = s.leia.slice(6).split('/');
    await p.esperar(`document.activeElement?.id === 'docs-s-${sec}'`, 5000, `${id}: foco em ${cap}/${sec}`);
  }
  assert.deepEqual(p.erros(), []);
});

test('CA1/CA6: Copiar do bloco de comando — copia o texto, mostra "Copiado" e anuncia; sem permissão seleciona o código e explica', NAV, async (t) => {
  const p = await aba(t);
  const url = painel.base;
  const SEC = 'section[aria-labelledby="docs-s-log"]'; const BTN = `${SEC} .docs-cmd button`; const ERRO = `${SEC} .docs-cmd-erro`;
  await p.js("location.hash = '#docs/manutencao/log'"); await abriuDocs(p, '#docs/manutencao/log');
  const comando = await p.js(`document.querySelector('${SEC} .docs-cmd code').textContent`);
  assert.equal(comando, 'sudo journalctl --rotate && sudo journalctl --vacuum-time=1s');
  await p.cmd('Browser.setPermission', { permission: { name: 'clipboard-write' }, setting: 'denied', origin: url });
  await p.clicar(BTN);
  await p.esperar(`document.querySelector('${ERRO}').hidden === false`);
  assert.equal(await p.js(`document.querySelector('${ERRO}').textContent`), 'Não deu para copiar. Selecione e copie (Ctrl+C).');
  assert.equal(await p.js('getSelection().toString().trim()'), comando, 'o código fica selecionado para Ctrl+C');
  assert.equal(await p.js(`document.querySelector('${BTN}').textContent`), 'Copiar');
  await p.cmd('Browser.setPermission', { permission: { name: 'clipboard-write' }, setting: 'granted', origin: url });
  await p.cmd('Browser.setPermission', { permission: { name: 'clipboard-read' }, setting: 'granted', origin: url });
  await p.js('window.focus()');
  await p.clicar(BTN);
  await p.esperar(`document.querySelector('${BTN}').textContent === 'Copiado'`);
  assert.equal(await p.js(`document.querySelector('${ERRO}').hidden`), true);
  await p.esperar("document.querySelector('#docs-status').textContent === 'Comando copiado'");
  assert.equal(await p.js('navigator.clipboard.readText()'), comando);
  await p.esperar(`document.querySelector('${BTN}').textContent === 'Copiar'`, 4000, 'volta a "Copiar" em 2 s');
  // pelo teclado (Enter e Espaço)
  await p.js(`document.querySelector('${BTN}').focus()`); await p.tecla('Enter');
  await p.esperar(`document.querySelector('${BTN}').textContent === 'Copiado'`);
  assert.deepEqual(p.erros(), []);
});

// ---------------------------------------------------------------------------------------------------------------
// "Ler mais" a partir dos "?" (CA6)
/** Percorre todos os "?" com destino (visíveis) da tela atual: clique fixa, foco no link, Esc devolve o foco. */
async function conferirLeiaMais(p, escopo, rotulo) {
  const emDialogo = escopo.startsWith('dialog'); // em diálogo o link abre em outra aba (não fecha o formulário aberto)
  const lista = JSON.parse(await p.js(`JSON.stringify([...document.querySelectorAll('${escopo} .q[data-docs]')].map((e, i) => ({ i, d: e.dataset.docs, vis: e.getBoundingClientRect().width > 0 })).filter((x) => x.vis))`));
  const falhas = [];
  for (const q of lista) {
    const el = `document.querySelectorAll('${escopo} .q[data-docs]')[${q.i}]`;
    await p.js(`${el}.scrollIntoView({ block: 'center' })`);
    const [x, y] = await p.js(`(() => { const r = ${el}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    try {
      await p.esperar(`(() => { const l = document.querySelector('#tip a'); return !!l && document.activeElement === l; })()`, 3000, 'foco no link');
      const s = JSON.parse(await p.js(`JSON.stringify({ aberto: document.querySelector('#tip').matches(':popover-open'), href: document.querySelector('#tip a').getAttribute('href'), alvo: document.querySelector('#tip a').getAttribute('target'), rel: document.querySelector('#tip a').getAttribute('rel'), txt: document.querySelector('#tip a').textContent, exp: ${el}.getAttribute('aria-expanded'),
        dentro: (() => { const r = document.querySelector('#tip').getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5; })() })`));
      const textoOk = emDialogo ? /^Ler mais \(abre em outra aba\): .+ →$/.test(s.txt) : /^Ler mais: .+ →$/.test(s.txt);
      const abaOk = emDialogo ? s.alvo === '_blank' && /\bnoopener\b/.test(s.rel || '') : s.alvo === null;
      if (!s.aberto || s.href !== '#docs/' + q.d || !textoOk || !abaOk || s.exp !== 'true' || !s.dentro) falhas.push(`${rotulo} ${q.d}: ${JSON.stringify(s)}`);
    } catch (e) { falhas.push(`${rotulo} ${q.d}: ${e.message}`); }
    await p.tecla('Escape');
    const e = JSON.parse(await p.js(`JSON.stringify({ tip: document.querySelector('#tip').matches(':popover-open'), foco: document.activeElement === ${el}, exp: ${el}.getAttribute('aria-expanded'), noCorpo: document.querySelector('#tip').parentNode === document.body, dlg: !!document.querySelector('dialog[open]') })`));
    if (e.tip || !e.foco || e.exp !== 'false' || !e.noCorpo) falhas.push(`${rotulo} ${q.d} depois do Esc: ${JSON.stringify(e)}`);
  }
  return { n: lista.length, falhas };
}

test('CA6: os "?" com destino das telas do painel fixam a dica, põem o foco em "Ler mais: … →" com o capítulo certo e o Esc devolve o foco ao "?"', NAV, async (t) => {
  const p = await aba(t);
  let total = 0; const falhas = [];
  for (const rota of ['conexoes', 'disparo-manual', 'disparo-automatico', 'disparar-mensagem', 'templates', 'relatorios', 'numeros', 'historico', 'ajustes', 'visao', 'links', 'grupos', 'blocos']) {
    await p.ir('#' + rota); await dorme(350);
    const r = await conferirLeiaMais(p, '#pagina', rota); total += r.n; falhas.push(...r.falhas);
  }
  assert.ok(total >= 15, `esperava ao menos 15 "?" com destino nas telas, vi ${total}`);
  assert.deepEqual(falhas, []);
  assert.deepEqual(p.erros(), []);
});

test('CA6: dentro de um diálogo modal (Novo disparo automático) o "Ler mais" abre em outra aba (target e rel), o Esc fecha só a dica e o segundo Esc fecha o diálogo', NAV, async (t) => {
  for (const largura of [1280, 375]) {
    const p = await aba(t, { largura });
    await p.ir('#disparo-automatico'); await p.esperar("document.querySelector('#pagina h1')?.textContent.startsWith('Disparo automático')");
    await p.clicar('#pagina button'); await p.esperar("!!document.querySelector('dialog[open]')");
    const r = await conferirLeiaMais(p, 'dialog[open]', `dialog ${largura}px`);
    assert.ok(r.n >= 5, `${largura}px: esperava ao menos 5 "?" com destino no diálogo, vi ${r.n}`);
    assert.deepEqual(r.falhas, []);
    assert.equal(await p.js("!!document.querySelector('dialog[open]')"), true, 'o Esc da dica não fecha o diálogo');
    // clicar no link de dentro do diálogo abre os Docs em outra aba e o diálogo (com o que foi digitado) continua aberto
    const abas = async () => (await (await fetch(`http://127.0.0.1:${chrome.porta}/json/list`)).json()).filter((x) => x.type === 'page');
    const antes = (await abas()).length;
    await p.js("document.querySelector('dialog[open] .q[data-docs]').scrollIntoView({ block: 'center' })");
    await p.clicar('dialog[open] .q[data-docs]');
    await p.esperar("!!document.querySelector('#tip a')");
    const destino = await p.js("document.querySelector('#tip a').getAttribute('href')");
    await p.clicar('#tip a');
    const t0 = Date.now(); let nova;
    while (!nova && Date.now() - t0 < 8000) { nova = (await abas()).find((x) => x.url.endsWith(destino)); if (!nova) await dorme(100); }
    assert.ok(nova, `${largura}px: o link do diálogo não abriu ${destino} em outra aba`);
    assert.equal((await abas()).length, antes + 1);
    await fetch(`http://127.0.0.1:${chrome.porta}/json/close/${nova.id}`);
    assert.equal(await p.js("!!document.querySelector('dialog[open]')"), true, 'o diálogo continua aberto depois do clique no link');
    assert.equal(await p.js('location.hash'), '#disparo-automatico', 'a aba de origem não navegou');
    await p.js("document.querySelector('dialog[open] .q[data-docs]').scrollIntoView()");
    await p.tecla('Escape'); await p.esperar("!document.querySelector('dialog[open]')", 3000, 'o segundo Esc fecha o diálogo');
    assert.deepEqual(p.erros(), []);
  }
});

test('CA6: "?" — hover só mostra a prévia (sem link) e some ao sair; Enter ou Espaço fixam; Enter no link abre o capítulo e Voltar leva à tela de origem', NAV, async (t) => {
  const p = await aba(t);
  await p.ir('#conexoes'); await p.esperar("!!document.querySelector('.q[data-docs]')");
  // a tela de Conexões ainda se ajusta depois de pronta: repete o movimento do mouse até a dica abrir
  await p.js("document.querySelector('.q[data-docs]').scrollIntoView({ block: 'center' })"); await dorme(300); // o scroll fecha a prévia: rola antes de passar o mouse
  const passar = async () => {
    const pos = await p.js("(() => { const r = document.querySelector('.q[data-docs]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()");
    await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 }); // sai e entra de novo: só assim o navegador repete o mouseover
    await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos[0], y: pos[1] });
  };
  for (let i = 0; i < 20 && !(await p.js("document.querySelector('#tip').matches(':popover-open')")); i++) { await passar(); await dorme(100); }
  await p.esperar("document.querySelector('#tip').matches(':popover-open')", 2000, 'hover abre a prévia');
  assert.equal(await p.js("!!document.querySelector('#tip a')"), false, 'a prévia não tem link');
  await p.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 });
  await p.esperar("!document.querySelector('#tip').matches(':popover-open')");
  // teclado
  const destino = await p.js("document.querySelector('.q[data-docs]').dataset.docs");
  await p.js("document.querySelector('.q[data-docs]').focus()");
  await p.esperar("document.querySelector('#tip').matches(':popover-open')");
  assert.equal(await p.js("!!document.querySelector('#tip a')"), false, 'foco = prévia');
  await p.tecla('Enter');
  await p.esperar("document.activeElement === document.querySelector('#tip a')");
  assert.equal(await p.js("document.querySelector('#tip a').getAttribute('href')"), '#docs/' + destino);
  await p.tecla('Enter');
  await abriuDocs(p, '#docs/' + destino);
  assert.equal(await p.js("document.querySelector('#tip').matches(':popover-open')"), false);
  await p.js('history.back()');
  await p.esperar("location.hash === '#conexoes' && document.querySelector('#pagina h1')?.textContent.startsWith('Conexões')", 8000, 'Voltar leva à Conexões');
  // Espaço fixa; Tab tira a dica e segue
  await p.js("document.querySelector('.q[data-docs]').focus()"); await p.tecla(' ');
  await p.esperar("!!document.querySelector('#tip a')");
  await p.tecla('Tab');
  await p.esperar("!document.querySelector('#tip').matches(':popover-open')");
  // clicar fora fecha a dica fixa
  await p.clicar('.q[data-docs]'); await p.esperar("!!document.querySelector('#tip a')");
  await p.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 3, y: 3, button: 'left', clickCount: 1 });
  await p.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 3, y: 3, button: 'left', clickCount: 1 });
  await p.esperar("!document.querySelector('#tip').matches(':popover-open')");
  assert.deepEqual(p.erros(), []);
});

// ---------------------------------------------------------------------------------------------------------------
test('CA6: as outras telas seguem iguais — Histórico guarda ?tipo=, aliases antigos resolvem, rota desconhecida cai na Visão Geral', NAV, async (t) => {
  const p = await aba(t);
  const abrir = async (hash, h1, final = hash) => {
    await p.ir(hash);
    await p.esperar(`document.querySelector('#pagina h1')?.textContent.replace(/\\s?\\?$/, '') === ${JSON.stringify(h1)}`, 8000, `${hash} → ${h1}`);
    assert.equal(await p.js('location.hash'), final, hash);
    assert.equal(await p.js("document.querySelector('#menu-atual').textContent.replace(/\\s?\\(\\d+\\)$/, '')"), '· ' + (h1 === 'Docs do sistema' ? 'Docs' : h1), hash);
  };
  await abrir('#historico?tipo=catalogo', 'Histórico');
  await abrir('#historico?tipo=espelhamento', 'Histórico');
  assert.ok(await p.js("!!document.querySelector('#esp-regra')"), 'a visão do Espelhamento abriu pelo endereço');
  await abrir('#historico', 'Histórico');
  await abrir('#etiquetas', 'Conexões', '#conexoes');
  await abrir('#regras', 'Disparo automático', '#disparo-automatico');
  await abrir('#whatsapp', 'Números de WhatsApp', '#numeros');
  await abrir('#conexoes', 'Conexões');
  await abrir('#conexoes/qualquer-coisa', 'Conexões', '#conexoes');
  await abrir('#visao/xyz', 'Visão Geral', '#visao');
  await abrir('#naoexiste', 'Visão Geral', '#visao');
  assert.deepEqual(p.erros(), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Operador: login ligado numa instância própria; o Dono ativa o login e convida, o Operador aceita (tudo por HTTP na própria aba)
/** Painel novo com login: abre uma aba como Dono (ativa o login, cria o convite), depois a mesma aba vira o Operador. */
async function comOperador(t) {
  const outro = await subirPainel();
  t.after(() => encerrar(outro.filho));
  const p = await abrirAba(chrome, outro.base + '/#visao');
  t.after(() => p.fechar());
  await p.tela(1280);
  await p.esperar(VISAO_PRONTA, 15000, 'painel carregado');
  const api = (rota, metodo, corpo) => p.js(`fetch('/api${rota}', { method: '${metodo}', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(corpo))} }).then(async (r) => JSON.stringify({ s: r.status, j: await r.json().catch(() => null) }))`).then(JSON.parse);
  assert.equal((await api('/equipe/ativar', 'POST', { nome: 'Ana Dona', email: 'ana@exemplo.com', senha: 'senha-forte-123' })).s, 200);
  const convite = await api('/equipe/convites', 'POST', { email: 'bia@exemplo.com', papel: 'operador' });
  assert.equal(convite.s, 201);
  // Depois de recarregar, o #pessoa aparece antes de a Visão Geral terminar de carregar (ela pede /blocks e /overview e depois
  // sobrescreve #pagina). Quem abre outra tela nesse meio tempo vê o livro sumir. Por isso espera a Visão Geral pronta.
  const comoDono = async () => { await p.js('location.reload()'); await p.esperar("document.querySelector('#pessoa')?.textContent.includes('Ana Dona')", 12000, 'Dono no painel'); await p.esperar(VISAO_PRONTA, 15000, 'Visão Geral do Dono carregada'); };
  const virarOperador = async () => {
    assert.equal((await api('/convite/aceitar', 'POST', { token: convite.j.link.split('#')[1], nome: 'Bia Operadora', senha: 'senha-da-bia-12345' })).s, 200);
    await p.js("location.hash = '#visao'"); await p.js('location.reload()');
    await p.esperar("document.querySelector('#pessoa')?.textContent.includes('Bia Operadora')", 12000, 'Operador no painel');
    await p.esperar(VISAO_PRONTA, 15000, 'Visão Geral do Operador carregada');
  };
  return { p, api, comoDono, virarOperador };
}

test('CA6/CA8: o Operador lê todo o livro — "Equipe e papéis" aparece com "Só o Dono" nas ações do Dono; #equipe do painel continua barrado', NAV, async (t) => {
  const { p, api, comoDono, virarOperador } = await comOperador(t);
  await comoDono();
  await p.js("location.hash = '#docs/equipe'"); await abriuDocs(p, '#docs/equipe');
  assert.equal(await p.js("document.querySelectorAll('.chip.so-dono').length"), 2, 'o Dono vê os mesmos selos');
  await virarOperador();
  const menu = JSON.parse(await p.js("JSON.stringify([...document.querySelectorAll('#rail nav a')].map((a) => a.textContent.trim()))"));
  assert.ok(!menu.includes('Equipe'), 'o Operador não tem o item Equipe');
  assert.ok(menu.includes('Docs'));
  await p.ir('#ajuda'); await abriuDocs(p, '#docs');
  await p.ir('#docs/equipe'); await abriuDocs(p, '#docs/equipe');
  assert.equal(await p.js("document.querySelector('#docs-titulo').textContent"), 'Equipe e papéis');
  assert.deepEqual(await p.js("[...document.querySelectorAll('.chip.so-dono')].map((c) => c.parentElement.textContent.replace(/\\s*Só o Dono$/, ''))"), ['Convidar alguém', 'Remover e mudar papel']);
  assert.ok(await p.js("[...document.querySelectorAll('.docs-toc-trilha a')].some((a) => /Equipe e papéis/.test(a.textContent))"), 'o sumário traz o capítulo');
  assert.ok((await p.js("docsBuscar('convidar').map((r) => r.cap)")).includes('equipe'), 'a busca acha a Equipe');
  await p.ir('#equipe'); await p.esperar("location.hash === '#visao'");
  assert.equal((await api('/equipe/convites', 'POST', { email: 'c@exemplo.com', papel: 'operador' })).s, 403, 'as ações do Dono seguem barradas no servidor');
  assert.deepEqual(p.erros().filter((e) => !/403/.test(e)), []);
});

test('QD3: no capítulo "Equipe e papéis", o Operador não recebe um botão "Abrir Equipe no painel" que o manda de volta à Visão Geral sem explicar', NAV, async (t) => {
  const { p, virarOperador } = await comOperador(t);
  await virarOperador();
  await p.js("location.hash = '#docs/equipe'"); await abriuDocs(p, '#docs/equipe');
  const botao = await p.js("document.querySelector('.docs-abrir a.btn')?.getAttribute('href') || null");
  if (botao === null) return; // correção possível: não mostrar o botão a quem não pode abrir a tela
  await p.clicar('.docs-abrir a.btn');
  await dorme(500);
  const depois = await p.js('location.hash');
  assert.equal(depois, botao, `o botão leva a ${botao}, mas o painel mandou o Operador para ${depois}`);
});
