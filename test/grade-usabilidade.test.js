// Usabilidade da grade de horários do formulário "Editar disparo automático" (public/grade.js, formRegra em public/app.js),
// com mouse e teclado de verdade. A cobertura de test/grade-painel.test.js usa uma tela simulada que só dispara eventos
// sintéticos (`click()`), por isso não enxerga a sequência real mousedown -> mouseup -> click nem o que a tela faz
// entre eles. Aqui: Chrome headless real (CDP, Input.dispatchMouseEvent/KeyEvent) sobre o painel de verdade
// (src/server.js em porta livre, DRY_RUN, pasta descartável, sem rede externa e sem WhatsApp).
//
// Bug relatado pelo dono: "esse menu está bugando a todo momento, momentos que clica e não vai, ou muda e troca".
// Causa comprovada (Q1): no `focusout` do campo de horário, grade.js movia a linha na hora; o `focusout` acontece no
// mousedown do próximo clique, a lista se reorganizava antes do mouseup e o `click` caía no <ol> (ancestral comum) e se perdia.
// Correção (princípio: as linhas só mudam de lugar quando o dono não está interagindo com a lista): a ordem fica pendente
// e só vale quando o foco vai para FORA da lista (focusin) ou no Enter; Copiar, Remover e Adicionar mexem só na própria
// <li> (nada é recriado, então "15:--" não se perde); a barra "+ Adicionar horário" fica acima da lista; avisos visíveis
// ("movido", "removido" com Desfazer); Enter não salva; Cancelar e Esc perguntam antes de descartar (U1 a U5).
// Os "Q<n>" e "U<n>" provam cada achado; os "GUARDA" protegem o que já funcionava.
// Sem Chrome/Chromium (CHROME_BIN ou google-chrome/chromium no PATH) os testes de navegador são pulados com o motivo.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

function acharChrome() {
  const candidatos = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const c of candidatos) {
    if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; continue; }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) { const f = path.join(dir, c); if (fs.existsSync(f)) return f; }
  }
  return null;
}
const CHROME = acharChrome();
const SEM_CHROME = CHROME ? false : 'sem Chrome/Chromium (defina CHROME_BIN): os testes de usabilidade da grade no navegador real foram pulados';
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

const HORAS = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

/** Painel de verdade, com 2 grupos e 1 etiqueta semeados e uma regra com grade de 10 horários criada pela API. */
async function subirPainel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qagrade-usab-')); pastas.push(dir);
  const porta = await livre();
  const db = openDb(dir);
  for (const jid of ['111@g.us', '222@g.us']) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, `Grupo ${jid.slice(0, 3)}`, 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etiquetaA', Date.now());
  db.close();
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
  const base = `http://127.0.0.1:${porta}`;
  const corpo = { name: 'Regra QA', enabled: true, tag_id: 1, template_id: 1, group_jids: ['111@g.us'], per_run: 3, interval_min: 60, window_start: '08:00', window_end: '22:00',
    sources: [{ type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-2000001-x | Item | 10 | 20' } }],
    grade: { dias: [0, 1, 2, 3, 4, 5, 6], horarios: HORAS.map((hora, i) => ({ hora, qtd: (i % 3) + 1, template_id: null })) } };
  const r = await fetch(`${base}/api/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  assert.equal(r.status, 200, 'a regra de teste deve ser criada pela API');
  return { base, porta, filho, dir };
}

async function subirChrome() {
  // pasta curta: o Chrome cria um socket no TMPDIR e um TMPDIR comprido derruba o Chrome
  const curto = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : '/tmp', 'qagrade-')); pastas.push(curto);
  const perfil = path.join(curto, 'p'); fs.mkdirSync(perfil);
  const args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--remote-debugging-port=0',
    `--user-data-dir=${perfil}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'];
  const filho = spawn(CHROME, args, { stdio: 'ignore', detached: true, env: { ...process.env, TMPDIR: curto } });
  filhos.push(filho);
  const arq = path.join(perfil, 'DevToolsActivePort'); const t0 = Date.now();
  while (!fs.existsSync(arq) || !fs.readFileSync(arq, 'utf8').includes('\n')) {
    if (Date.now() - t0 > 20000) throw new Error('Chrome não abriu a porta de depuração em 20 s');
    await dorme(50);
  }
  return { porta: Number(fs.readFileSync(arq, 'utf8').split('\n')[0]), filho };
}

/** Uma aba com o driver CDP mínimo (WebSocket global do Node 22): mouse e teclado de verdade. */
async function abrirAba(url) {
  const alvo = await (await fetch(`http://127.0.0.1:${chrome.porta}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok, falha) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => falha(new Error('WebSocket do Chrome'))); });
  let n = 0; const esperando = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && esperando.has(d.id)) { esperando.get(d.id)(d); esperando.delete(d.id); } });
  const cmd = (method, params = {}) => new Promise((ok, err) => { const id = ++n; esperando.set(id, (d) => (d.error ? err(new Error(JSON.stringify(d.error))) : ok(d.result))); ws.send(JSON.stringify({ id, method, params })); });
  await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Page.bringToFront');
  const js = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'erro de JavaScript na página');
    return r.result.value;
  };
  const esperar = async (expr, ms = 8000) => {
    const t0 = Date.now(); let ultimo;
    while (Date.now() - t0 < ms) { try { ultimo = await js(expr); if (ultimo) return ultimo; } catch (e) { ultimo = e.message; } await dorme(30); }
    throw new Error(`timeout esperando: ${expr} (último: ${JSON.stringify(ultimo)})`);
  };
  const tela = (w, h) => cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const mouse = (type, x, y, clickCount = 1) => cmd('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : clickCount });
  const tecla = async (key, vk, text) => {
    const base = { key, code: text ? `Digit${text}` : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(text ? { text } : {}) });
    if (text) await cmd('Input.dispatchKeyEvent', { type: 'char', ...base, text });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  /** Enter de verdade: com `text` o Chrome faz o que faria no teclado (inclusive enviar o formulário). */
  const enter = async () => {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r' }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  return { cmd, js, esperar, tela, mouse, tecla, enter, fechar: async () => { try { ws.close(); await fetch(`http://127.0.0.1:${chrome.porta}/json/close/${alvo.id}`); } catch { /* aba já fechou */ } } };
}

let painel; let chrome;
before(async () => { if (SEM_CHROME) return; [painel, chrome] = await Promise.all([subirPainel(), subirChrome()]); }, { timeout: 60000 });

// ---------------------------------------------------------------------------------------------------------------------
// Ações do dono, todas com mouse e teclado reais
// ---------------------------------------------------------------------------------------------------------------------
const NA_LISTA = '#gh-lista > li';
const ESTADO = `({
  horas: [...document.querySelectorAll('#gh-lista > li')].map((li) => li.querySelector('.gh-h').value),
  chaves: [...document.querySelectorAll('#gh-lista > li')].map((li) => li.dataset.k),
  foco: document.activeElement?.closest('li')?.querySelector('.gh-h')?.value ?? null,
  focoClasse: document.activeElement?.className || document.activeElement?.dataset?.gh || document.activeElement?.tagName,
  aberto: document.querySelector('#dlg').open,
})`;

/** Abre o "Editar" da regra com um clique de verdade, na janela `largura` x `altura`, e devolve a página pronta. */
async function abrirFormulario(t, { largura = 1130, altura = 965 } = {}) {
  const p = await abrirAba(`${painel.base}/#disparo-automatico`);
  t.after(() => p.fechar());
  await p.tela(largura, altura);
  await p.esperar("!!document.querySelector('button[data-act=editar]')", 15000);
  const a = {
    ...p,
    /** Centro (x, y) do primeiro elemento de `sel`, depois de rolá-lo para o meio da janela. */
    centro: async (sel, rolar = true) => {
      const pos = await p.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; ${rolar ? "e.scrollIntoView({ block: 'center' });" : ''} const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.left]; })()`);
      if (!pos) throw new Error(`sem elemento: ${sel}`);
      return pos;
    },
    apertarSoltar: async (x, y, xSoltar = x, ySoltar = y, vezes = 1) => {
      await p.mouse('mouseMoved', x, y); await p.mouse('mousePressed', x, y, vezes); await p.mouse('mouseReleased', xSoltar, ySoltar, vezes);
    },
    clicar: async (sel, { rolar = true } = {}) => { const [x, y] = await a.centro(sel, rolar); await a.apertarSoltar(x, y); await dorme(150); },
    /** Foca o campo de horário `sel` com o mouse (segmento da hora) e digita 4 dígitos: troca a hora, sem sair do campo. */
    digitarHora: async (sel, hhmm) => {
      const [, y, esquerda] = await a.centro(sel); await a.apertarSoltar(esquerda + 14, y);
      for (const c of hhmm) await p.tecla(c, 48 + Number(c), c);
    },
    estado: () => p.js(ESTADO),
    chaveDe: (hora) => p.js(`[...document.querySelectorAll('#gh-lista > li')].find((li) => li.querySelector('.gh-h').value === ${JSON.stringify(hora)}).dataset.k`),
    /** Registra mousedown, mouseup e click (fase de captura) com a linha e o controle de cada um. */
    gravarEventos: () => p.js(`window.__ev = []; for (const tipo of ['mousedown', 'mouseup', 'click']) document.addEventListener(tipo, (e) => { const li = e.target.closest?.('li.gh-linha'); window.__ev.push({ tipo, linha: li?.dataset.k ?? null, hora: li?.querySelector('.gh-h').value ?? null, alvo: e.target.tagName + '.' + (e.target.dataset?.gh || e.target.className || '') }); }, true)`),
    eventos: () => p.js('window.__ev'),
  };
  const [x, y] = await a.centro('button[data-act=editar]');
  await a.apertarSoltar(x, y);
  await p.esperar(`document.querySelector('#dlg').open && document.querySelectorAll('#gh-lista > li').length === ${HORAS.length}`);
  // o confirm nativo trava o CDP: um falso registra o texto e responde `window.__resp`; os pedidos que gravam também
  await p.js(`window.__conf = []; window.__resp = true; window.confirm = (m) => { window.__conf.push(String(m)); return window.__resp; };
    window.__req = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.method && o.method !== 'GET') window.__req.push(o.method + ' ' + String(u)); return f(u, o); };`);
  return a;
}
const sequencia = (ev) => ev.map((e) => `${e.tipo}:${e.alvo}@${e.hora ?? '-'}`).join(' > ');

/** Troca a hora da 1ª linha (08:00 -> 15:30) com a linha ainda em foco e devolve os botões de uma linha mais abaixo. */
async function editarPrimeiraLinha(a, { aoTopo = false } = {}) {
  if (aoTopo) await a.js("document.querySelector('#gh-lista > li:nth-child(1)').scrollIntoView({ block: 'start' }); document.querySelector('#dlg').scrollTop -= 60");
  await a.digitarHora(`${NA_LISTA}:nth-child(1) .gh-h`, '1530');
  assert.equal((await a.estado()).foco, '15:30', 'a hora da 1ª linha foi trocada e o campo continua em foco (a linha ainda não saiu do lugar)');
}

// =====================================================================================================================
// Q1 — hora alterada + clique em outro controle: a lista se mexe entre o mousedown e o mouseup e o clique se perde
// =====================================================================================================================

test('Q1: depois de trocar uma hora, o clique em "Copiar" de OUTRA linha copia (11 linhas)', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await editarPrimeiraLinha(a);
  const k = await a.chaveDe('12:00');
  await a.gravarEventos();
  await a.clicar(`${NA_LISTA}[data-k="${k}"] [data-gh=copiar]`);
  const e = await a.estado(); const ev = await a.eventos();
  assert.equal(e.horas.length, HORAS.length + 1, `"Copiar" da linha 12:00 não fez nada (continuam ${e.horas.length} linhas). Eventos: ${sequencia(ev)}`);
});

test('Q1: depois de trocar uma hora, o clique em "Remover" de OUTRA linha remove essa linha (e só ela)', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await editarPrimeiraLinha(a);
  const k = await a.chaveDe('12:00');
  await a.gravarEventos();
  await a.clicar(`${NA_LISTA}[data-k="${k}"] [data-gh=remover]`);
  const e = await a.estado(); const ev = await a.eventos();
  // a ordem de "15:30" continua pendente (o foco ainda está dentro da lista): as outras linhas não saltam
  assert.deepEqual(e.horas, ['15:30', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00'],
    `"Remover" da linha 12:00 não removeu só ela (ficou ${e.horas.join(', ')}). Eventos: ${sequencia(ev)}`);
});

test('Q1: depois de trocar uma hora, o clique em "Copiar" da MESMA linha copia', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await editarPrimeiraLinha(a);
  const k = await a.js("document.activeElement.closest('li').dataset.k");
  await a.gravarEventos();
  await a.clicar(`${NA_LISTA}[data-k="${k}"] [data-gh=copiar]`);
  const e = await a.estado(); const ev = await a.eventos();
  assert.equal(e.horas.length, HORAS.length + 1, `"Copiar" da linha recém-editada não fez nada (${e.horas.length} linhas). Eventos: ${sequencia(ev)}`);
});

test('Q1: depois de trocar uma hora, o clique em "Remover" da MESMA linha remove', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await editarPrimeiraLinha(a);
  const k = await a.js("document.activeElement.closest('li').dataset.k");
  await a.gravarEventos();
  await a.clicar(`${NA_LISTA}[data-k="${k}"] [data-gh=remover]`);
  const e = await a.estado(); const ev = await a.eventos();
  assert.ok(!e.horas.includes('15:30'), `"Remover" da linha 15:30 não removeu (ficou ${e.horas.join(', ')}). Eventos: ${sequencia(ev)}`);
});

for (const [rotulo, seletor] of [['Template', '.gh-t'], ['Ofertas', '.gh-q']]) {
  test(`Q1: depois de trocar uma hora, ao apertar o mouse em "${rotulo}" de outra linha ela continua sob o cursor quando o mouse é solto`, NAV, async (t) => {
    const a = await abrirFormulario(t);
    await editarPrimeiraLinha(a);
    const k = await a.chaveDe('12:00');
    await a.gravarEventos();
    await a.clicar(`${NA_LISTA}[data-k="${k}"] ${seletor}`);
    const ev = await a.eventos(); const baixo = ev.find((e) => e.tipo === 'mousedown'); const cima = ev.find((e) => e.tipo === 'mouseup');
    assert.equal(baixo.linha, cima.linha, `o mouse foi apertado em ${rotulo} da linha ${baixo.hora} e solto sobre a linha ${cima.hora}: a lista se reorganizou entre o aperto e o soltar. Eventos: ${sequencia(ev)}`);
  });
}

test('Q1: em janela estreita (375 px), com a linha editada à vista, "Copiar" da linha seguinte também copia', NAV, async (t) => {
  const a = await abrirFormulario(t, { largura: 375, altura: 900 });
  await editarPrimeiraLinha(a, { aoTopo: true });
  const k = await a.js("document.querySelectorAll('#gh-lista > li')[1].dataset.k");
  const alvo = `${NA_LISTA}[data-k="${k}"] [data-gh=copiar]`;
  const [, y] = await a.centro(alvo, false); // sem rolar: linha editada e botão ficam à vista, como na tela do dono
  const dlg = await a.js("(() => { const r = document.querySelector('#dlg').getBoundingClientRect(); return [r.top, r.bottom]; })()");
  assert.ok(y > dlg[0] && y < dlg[1], `pré-condição: o botão (y=${Math.round(y)}) está dentro do diálogo (${dlg.map(Math.round).join(' a ')})`);
  await a.gravarEventos();
  await a.clicar(alvo, { rolar: false });
  const e = await a.estado(); const ev = await a.eventos();
  assert.equal(e.horas.length, HORAS.length + 1, `em 375 px o "Copiar" da 2ª linha não fez nada (${e.horas.length} linhas). Eventos: ${sequencia(ev)}`);
});

// =====================================================================================================================
// Q4 — hora digitada pela metade e clique em outro botão: a linha é zerada e jogada para o fim da lista
// =====================================================================================================================

test('Q4: hora digitada pela metade ("15:--") e um clique em "Copiar" de outra linha não zera a linha nem a joga para o fim da lista', NAV, async (t) => {
  const a = await abrirFormulario(t);
  const sel = `${NA_LISTA}:nth-child(2) .gh-h`; // 09:00
  const kEditada = await a.js("document.querySelectorAll('#gh-lista > li')[1].dataset.k");
  const [, y, esquerda] = await a.centro(sel); await a.apertarSoltar(esquerda + 14, y);
  await a.tecla('Backspace', 8); await a.tecla('1', 49, '1'); await a.tecla('5', 53, '5'); await a.tecla('Backspace', 8); // hora 15, minutos apagados
  assert.equal(await a.js('document.activeElement.value'), '', 'pré-condição: com os minutos apagados o campo fica sem valor (mostra 15:--)');
  const k = await a.chaveDe('12:00');
  await a.clicar(`${NA_LISTA}[data-k="${k}"] [data-gh=copiar]`);
  const e = await a.estado();
  assert.equal(e.horas.length, HORAS.length + 1, 'o Copiar da linha 12:00 funcionou');
  assert.equal(e.chaves.indexOf(kEditada), 1, `a linha que estava sendo editada (2ª) foi para a posição ${e.chaves.indexOf(kEditada) + 1} de ${e.chaves.length}, com a hora em branco: ${e.horas.map((h) => h || '--:--').join(', ')}`);
});

// =====================================================================================================================
// GUARDA — o que funciona hoje e a correção do Q1 não pode quebrar (passam hoje)
// =====================================================================================================================

test('GUARDA: com o formulário aberto, o tique de 3 s do painel não mexe no diálogo (nenhuma mutação, foco e rolagem iguais)', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await a.js("document.querySelector('#gh-lista > li:nth-child(5) .gh-t').scrollIntoView({ block: 'center' }); document.querySelector('#gh-lista > li:nth-child(5) .gh-t').focus()");
  await a.js("window.__mut = 0; new MutationObserver((m) => { window.__mut += m.length; }).observe(document.querySelector('#dlg'), { subtree: true, childList: true, attributes: true, characterData: true })");
  const antes = await a.js('({ foco: document.activeElement.className, rolagem: document.querySelector("#dlg").scrollTop })');
  await dorme(7000); // dois tiques do setInterval de 3 s (public/app.js)
  const depois = await a.js('({ foco: document.activeElement.className, rolagem: document.querySelector("#dlg").scrollTop, mutacoes: window.__mut })');
  assert.equal(depois.mutacoes, 0, 'nada dentro do diálogo é redesenhado pelo tique');
  assert.deepEqual({ foco: depois.foco, rolagem: depois.rolagem }, antes);
});

test('GUARDA: Tab dentro da linha não move nada; ao sair da lista a linha vai para o lugar certo, o foco segue o Tab e o aviso aparece', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await editarPrimeiraLinha(a);
  await a.tecla('Tab', 9); await a.tecla('Tab', 9); // 1º Tab: minutos do campo de hora; 2º Tab: sai do campo (Ofertas, na mesma linha)
  await dorme(100);
  let e = await a.estado();
  assert.equal(e.horas.indexOf('15:30'), 0, 'dentro da lista nada se mexe: a linha 15:30 continua na 1ª posição');
  assert.equal(e.focoClasse, 'gh-q', 'o foco foi para o campo seguinte (Ofertas) da mesma linha');
  assert.equal(await a.js("document.querySelector('#gh-mov').textContent"), '', 'sem aviso enquanto a ordem está pendente');
  // Tab a partir do último controle da lista leva o foco para fora dela: a ordem pendente vale agora
  await a.js("document.querySelector('#gh-lista > li:last-child [data-gh=remover]').focus()");
  await a.tecla('Tab', 9); await dorme(100);
  e = await a.estado();
  assert.equal(e.horas.indexOf('15:30'), 7, 'a linha 15:30 foi para o lugar certo (8ª)');
  assert.ok(!(await a.js("!!document.activeElement.closest('#gh-lista')")), 'o foco ficou fora da lista, onde o Tab o levou');
  assert.equal(await a.js("document.querySelector('#gh-mov').textContent"), 'Horário 15:30 movido para a posição 8.');
});

test('GUARDA: Remover da última linha leva o foco ao horário da linha anterior, e Esc fecha o diálogo devolvendo o foco ao botão "Editar"', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await a.clicar(`${NA_LISTA}:last-child [data-gh=remover]`);
  const e = await a.estado();
  assert.deepEqual(e.horas, HORAS.slice(0, -1));
  assert.equal(e.foco, '16:00', 'spec: "Remover leva o foco ao horário da linha anterior"');
  await a.tecla('Escape', 27); await dorme(200);
  assert.equal(await a.js('document.querySelector("#dlg").open'), false);
  assert.equal(await a.js('document.activeElement.dataset.act'), 'editar', 'spec: "Esc fecha e devolve o foco ao botão de origem"');
});

// =====================================================================================================================
// Ajudantes dos testes U1 a U5
// =====================================================================================================================
const TAMANHO = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); const c = getComputedStyle(e);
  return { x: r.left, y: r.top, w: r.width, h: r.height, visivel: c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !e.closest('[hidden]'), texto: (e.innerText ?? e.textContent).trim() }; })()`;
/** A linha `li` está inteira na parte visível do diálogo? (o rodapé e a barra grudados não contam como vista) */
const NA_VISTA = (sel) => `(() => { const li = document.querySelector(${JSON.stringify(sel)}); const r = li.getBoundingClientRect(); const d = document.querySelector('#dlg').getBoundingClientRect();
  const barra = document.querySelector('.gh-estado').getBoundingClientRect(); const rod = document.querySelector('#dlg .rodape').getBoundingClientRect();
  return r.top >= Math.max(d.top, barra.bottom) - 1 && r.bottom <= Math.min(d.bottom, rod.top) + 1; })()`;
/** Posições na página (independem da rolagem) do que vem depois da barra da lista e a altura da própria lista. */
const posicoes = (a) => a.js(`(() => { const rol = document.querySelector('#dlg').scrollTop; const y = (sel) => document.querySelector(sel).getBoundingClientRect().top + rol;
  return { dedupe: y('[name=dedupe_days]'), primeiraLinha: y('#gh-lista > li'), estado: document.querySelector('.gh-estado').getBoundingClientRect().height, lista: document.querySelector('#gh-lista').getBoundingClientRect().height }; })()`);
const seta = (a, sel, valor) => a.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(valor)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const requisicoes = (a) => a.js('window.__req');

// =====================================================================================================================
// U2 — Enter nos campos da grade não salva
// =====================================================================================================================

test('U2: Enter no horário, nas ofertas e nos campos do gerador não salva nem fecha; no horário aplica a ordem pendente, mantém o foco e deixa a linha à vista', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await editarPrimeiraLinha(a);
  await a.enter(); await dorme(250);
  let e = await a.estado();
  assert.equal(e.aberto, true, 'Enter no horário não fecha o diálogo (antes: salvava e fechava)');
  assert.deepEqual(await requisicoes(a), [], 'Enter no horário não grava nada');
  assert.equal(e.horas.indexOf('15:30'), 7, 'a ordem pendente foi aplicada no Enter');
  assert.equal(e.foco, '15:30', 'o foco continua no campo de horário da linha');
  assert.equal(e.focoClasse, 'gh-h');
  assert.ok(await a.js(NA_VISTA(`${NA_LISTA}[data-k="${await a.chaveDe('15:30')}"]`)), 'a linha movida foi rolada para a vista');
  assert.equal(await a.js("document.querySelector('#gh-mov').textContent"), 'Horário 15:30 movido para a posição 8.');
  // Ofertas
  await a.clicar(`${NA_LISTA}:nth-child(3) .gh-q`);
  await a.enter(); await dorme(200);
  e = await a.estado();
  assert.equal(e.aberto, true, 'Enter nas ofertas não fecha');
  assert.equal(e.focoClasse, 'gh-q', 'e o foco fica no campo');
  // gerador ("Montar…")
  await a.clicar('#gh-montar');
  await a.clicar('#gh-ger-qtd');
  await a.enter(); await dorme(200);
  assert.equal(await a.js('document.querySelector("#dlg").open'), true, 'Enter no gerador não fecha');
  assert.equal(await a.js('document.activeElement.id'), 'gh-ger-qtd');
  assert.deepEqual(await requisicoes(a), [], 'nenhum Enter gravou');
});

// =====================================================================================================================
// U3 — Remover: clique duplo, folga entre os botões, Desfazer
// =====================================================================================================================

test('U3: clique duplo em "Remover" apaga UMA linha; pelo teclado (Enter e Espaço) o Remover continua valendo', NAV, async (t) => {
  const a = await abrirFormulario(t);
  const [x, y] = await a.centro(`${NA_LISTA}:nth-child(5) [data-gh=remover]`);
  await a.mouse('mouseMoved', x, y); await a.mouse('mousePressed', x, y, 1); await a.mouse('mouseReleased', x, y, 1);
  await a.mouse('mousePressed', x, y, 2); await a.mouse('mouseReleased', x, y, 2); // o 2º clique do duplo cairia na linha que subiu
  await dorme(200);
  assert.deepEqual((await a.estado()).horas, HORAS.filter((h) => h !== '12:00'), 'só a 5ª linha (12:00) saiu');
  // teclado: detail 0, vale
  await a.js(`document.querySelector('${NA_LISTA}:nth-child(1) [data-gh=remover]').focus()`);
  await a.enter(); await dorme(150);
  assert.deepEqual((await a.estado()).horas, HORAS.filter((h) => !['12:00', '08:00'].includes(h)), 'Enter no botão remove');
  await a.js(`document.querySelector('${NA_LISTA}:nth-child(1) [data-gh=remover]').focus()`);
  await a.tecla(' ', 32, ' '); await dorme(150);
  assert.deepEqual((await a.estado()).horas, HORAS.filter((h) => !['12:00', '08:00', '09:00'].includes(h)), 'Espaço no botão remove');
});

for (const [largura, altura, alvoMin] of [[1130, 965, 24], [375, 900, 44]]) {
  test(`U3: ${largura} px: Copiar e Remover ficam a 12 px ou mais um do outro e os botões mantêm o tamanho do alvo (${alvoMin} px)`, NAV, async (t) => {
    const a = await abrirFormulario(t, { largura, altura });
    const m = await a.js(`(() => { const li = document.querySelector('${NA_LISTA}:nth-child(2)'); const c = li.querySelector('[data-gh=copiar]').getBoundingClientRect(); const r = li.querySelector('[data-gh=remover]').getBoundingClientRect();
      return { vao: Math.abs(r.left - c.right), hc: c.height, hr: r.height, wr: r.width, wc: c.width }; })()`);
    assert.ok(m.vao >= 12, `o vão entre Copiar e Remover é ${m.vao} px`);
    assert.ok(m.hc >= alvoMin && m.hr >= alvoMin && m.wc >= alvoMin && m.wr >= alvoMin, `alvos de ${JSON.stringify(m)}`);
  });
}

test('U3: Desfazer de "Remover" devolve os MESMOS nós na posição original, com os valores intactos (e vale mesmo com ordem pendente)', NAV, async (t) => {
  const a = await abrirFormulario(t);
  const k = await a.chaveDe('12:00');
  const li = `${NA_LISTA}[data-k="${k}"]`;
  await seta(a, `${li} .gh-q`, '7');
  const tpl = await a.js(`(() => { const s = document.querySelector('${li} .gh-t'); s.selectedIndex = s.options.length - 1; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  assert.ok(tpl, 'pré-condição: a linha tem um template próprio');
  await a.js(`document.querySelector('${li}').__eu = 'a mesma linha'`);
  await editarPrimeiraLinha(a); // ordem pendente: 15:30 ainda na 1ª posição
  await a.clicar(`${li} [data-gh=remover]`);
  assert.ok(!(await a.estado()).horas.includes('12:00'));
  const aviso = await a.js(TAMANHO('#gh-desf'));
  assert.ok(aviso.visivel && aviso.h > 10 && aviso.w > 100, `o aviso de remoção tem tamanho na tela (${aviso.w}x${aviso.h})`);
  assert.match(aviso.texto, /^Horário 12:00 removido\.\s*Desfazer$/);
  const btn = await a.js(TAMANHO('#gh-desfazer'));
  assert.ok(btn.visivel && btn.w >= 24 && btn.h >= 24, 'o botão Desfazer está à vista e tem tamanho de alvo');
  await a.clicar('#gh-desfazer', { rolar: false });
  const e = await a.estado();
  assert.deepEqual(e.horas, ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '15:30', '16:00', '17:00'],
    'a linha voltou à posição original (e a ordem pendente foi aplicada ao ir para o botão, fora da lista, sem perder o clique)');
  assert.equal(await a.js(`document.querySelector('${NA_LISTA}[data-k="${k}"]').__eu`), 'a mesma linha', 'o mesmo nó voltou (não foi recriado)');
  assert.equal(await a.js(`document.querySelector('${li} .gh-q').value`), '7');
  assert.equal(await a.js(`document.querySelector('${li} .gh-t').value`), tpl);
  assert.equal(e.foco, '12:00', 'o foco vai para a linha devolvida');
  assert.equal(await a.js(TAMANHO('#gh-desfazer')).then((x) => x.visivel), false, 'o Desfazer some depois de usado');
  assert.equal((await a.js(TAMANHO('#gh-desf'))).texto, 'Horário 12:00 de volta.');
});

test('U3: o Desfazer some na próxima alteração da lista e cada aviso é escrito uma vez (o leitor de tela não repete)', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await a.clicar(`${NA_LISTA}:nth-child(3) [data-gh=remover]`);
  assert.equal((await a.js(TAMANHO('#gh-desfazer'))).visivel, true);
  await a.js("window.__muts = 0; new MutationObserver((m) => { window.__muts += m.length; }).observe(document.querySelector('.gh-estado'), { subtree: true, childList: true, characterData: true })");
  await a.clicar('[name=dedupe_days]'); await a.clicar('[name=name]'); await dorme(200); // foco fora da lista, sem nada a mudar
  assert.equal(await a.js('window.__muts'), 0, 'ir e vir entre campos não reescreve o aviso (nem o anuncia de novo)');
  assert.equal((await a.js(TAMANHO('#gh-desfazer'))).visivel, true, 'o Desfazer espera, sem depender de tempo');
  await seta(a, `${NA_LISTA}:nth-child(1) .gh-q`, '9'); // alteração da lista
  const depois = await a.js(TAMANHO('#gh-desfazer'));
  assert.equal(depois.visivel, false, 'alterar uma linha tira o Desfazer');
  assert.equal((await a.js(TAMANHO('#gh-desf'))).texto, '');
});

test('U3: "Limpar tudo" não pede confirm e o Desfazer devolve todas as linhas, na ordem, com os valores digitados', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await editarPrimeiraLinha(a); // 15:30 na 1ª posição (ordem pendente)
  await seta(a, `${NA_LISTA}:nth-child(4) .gh-q`, '12');
  const antes = await a.js("[...document.querySelectorAll('#gh-lista > li')].map((li, i) => { li.__n = i; return [li.querySelector('.gh-h').value, li.querySelector('.gh-q').value, li.querySelector('.gh-t').value]; })");
  await a.clicar('#gh-limpar');
  assert.deepEqual(await a.js('window.__conf'), [], 'Limpar tudo não usa confirm (nada é gravado antes do Salvar)');
  assert.deepEqual((await a.estado()).horas, []);
  assert.equal((await a.js(TAMANHO('#gh-vazio'))).visivel, true, 'a lista vazia mostra a mensagem de sempre');
  assert.match((await a.js(TAMANHO('#gh-desf'))).texto, /^10 horários removidos\.\s*Desfazer$/);
  assert.equal(await a.js('document.activeElement.id'), 'gh-add', 'o foco vai para "+ Adicionar horário"');
  await a.clicar('#gh-desfazer', { rolar: false });
  const depois = await a.js("[...document.querySelectorAll('#gh-lista > li')].map((li) => [li.querySelector('.gh-h').value, li.querySelector('.gh-q').value, li.querySelector('.gh-t').value, li.__n])");
  // a linha 15:30 estava fora de ordem; ao levar o foco ao "Desfazer" (fora da lista) a ordem pendente vale
  const ordenadas = antes.map((l, n) => [...l, n]).sort((x, y) => (x[0] < y[0] ? -1 : 1));
  assert.deepEqual(depois.map((l) => l.slice(0, 3)), ordenadas.map((l) => l.slice(0, 3)), 'mesmas linhas e mesmos valores');
  assert.deepEqual(depois.map((l) => l[3]), ordenadas.map((l) => l[3]), 'os mesmos nós');
  assert.equal((await a.js(TAMANHO('#gh-desf'))).texto, '10 horários de volta.');
});

// =====================================================================================================================
// U5 — "+ Adicionar horário" não foge do cursor
// =====================================================================================================================

for (const [largura, altura] of [[1130, 965], [375, 900]]) {
  test(`U5: ${largura} px: três cliques seguidos no mesmo ponto de "+ Adicionar horário" criam três linhas`, NAV, async (t) => {
    const a = await abrirFormulario(t, { largura, altura });
    const [x, y] = await a.centro('#gh-add');
    for (let i = 0; i < 3; i++) { await a.apertarSoltar(x, y); await dorme(120); }
    const e = await a.estado();
    assert.equal(e.horas.length, HORAS.length + 3, `três cliques no mesmo ponto: ${e.horas.length - HORAS.length} linha(s) nova(s)`);
    assert.deepEqual(e.horas.slice(0, HORAS.length), HORAS, 'as linhas antigas não foram tocadas (nenhum clique caiu em outro controle)');
    assert.equal(e.foco, e.horas.at(-1), 'o foco está no horário da última linha criada');
    // com o mouse a tela não rola (o botão sairia de baixo do cursor): o aviso visível e o contorno dizem onde a linha está
    assert.equal((await a.js(TAMANHO('#gh-mov'))).texto, `Horário ${e.horas.at(-1)} adicionado na posição ${HORAS.length + 3}.`);
    assert.equal(await a.js(`getComputedStyle(document.querySelector('${NA_LISTA}:last-child')).outlineStyle`), 'solid');
    assert.equal(await a.js("document.querySelector('#gh-cont').textContent"), '(13 de 48 horários)');
  });
}

test('U5: "+ Adicionar horário" pelo teclado leva a linha nova à vista (não há cursor para fugir)', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await a.js("document.querySelector('#gh-add').scrollIntoView({ block: 'center' }); document.querySelector('#gh-add').focus()");
  await a.enter(); await dorme(200);
  assert.equal((await a.estado()).horas.length, HORAS.length + 1);
  assert.ok(await a.js(NA_VISTA(`${NA_LISTA}:last-child`)), 'a linha nova está à vista');
  assert.equal((await a.estado()).foco, (await a.estado()).horas.at(-1));
});

test('U5: a barra com "+ Adicionar horário", "Limpar tudo" e o contador fica ACIMA da lista, na ordem do DOM e na visual', NAV, async (t) => {
  const a = await abrirFormulario(t);
  const o = await a.js(`(() => { const y = (s) => document.querySelector(s).getBoundingClientRect().top; const dom = (s) => [...document.querySelectorAll('#r-grade *')].indexOf(document.querySelector(s));
    return { add: y('#gh-add'), limpar: y('#gh-limpar'), lista: y('#gh-lista'), domAdd: dom('#gh-add'), domLista: dom('#gh-lista'), domCont: dom('#gh-cont') }; })()`);
  assert.ok(o.add < o.lista && o.limpar < o.lista, 'os botões estão acima da primeira linha');
  assert.ok(o.domCont < o.domAdd && o.domAdd < o.domLista, 'a ordem do DOM acompanha a visual (título e contador, barra, lista)');
});

// =====================================================================================================================
// U1 — aviso visível e destaque da linha movida
// =====================================================================================================================

for (const [largura, altura] of [[1130, 965], [375, 900]]) test(`U1: ${largura} px: ao levar o foco para fora da lista, a linha movida ganha contorno e um aviso VISÍVEL (com tamanho real) diz onde ela foi parar`, NAV, async (t) => {
  const a = await abrirFormulario(t, { largura, altura });
  await editarPrimeiraLinha(a);
  const k = await a.js("document.activeElement.closest('li').dataset.k");
  const antes = await posicoes(a);
  await a.centro('[name=dedupe_days]'); // o clique abaixo rola o diálogo: a barra (ou a linha de avisos) gruda no topo e continua à vista
  await a.clicar('[name=dedupe_days]'); // outro campo, fora da lista
  const e = await a.estado();
  assert.equal(e.horas.indexOf('15:30'), 7);
  const mov = await a.js(TAMANHO('#gh-mov'));
  assert.equal(mov.texto, 'Horário 15:30 movido para a posição 8.');
  assert.ok(mov.visivel && mov.w > 150 && mov.h > 10, `o aviso tem tamanho real na tela (${Math.round(mov.w)}x${Math.round(mov.h)})`);
  const dentro = await a.js(`(() => { const r = document.querySelector('#gh-mov').getBoundingClientRect(); const d = document.querySelector('#dlg').getBoundingClientRect(); return r.top >= d.top && r.bottom <= d.bottom && r.left >= d.left && r.right <= d.right; })()`);
  assert.ok(dentro, 'o aviso está dentro da parte visível do diálogo (a barra gruda no topo, mesmo com a lista rolada)');
  assert.equal(await a.js('document.querySelector("#gh-mov").getAttribute("role")'), 'status');
  const contorno = await a.js(`(() => { const c = getComputedStyle(document.querySelector('${NA_LISTA}[data-k="${k}"]')); return { largura: c.outlineWidth, estilo: c.outlineStyle }; })()`);
  assert.deepEqual(contorno, { largura: '2px', estilo: 'solid' }, 'a linha movida tem contorno (não só cor)');
  assert.equal(e.chaves[7], k);
  // o aviso não empurra nada: o que está abaixo da barra fica no mesmo lugar
  const depois = await posicoes(a);
  assert.deepEqual(depois, antes, 'o aviso não empurrou nada: o que vem depois da barra fica no mesmo lugar (senão o clique seguinte erraria o alvo)');
  // a tela não rolou para a linha: o dono já estava em outro campo
  assert.equal(await a.js('document.activeElement.name'), 'dedupe_days');
  // a próxima ação tira o destaque e o aviso
  await a.clicar('[name=name]');
  assert.equal(await a.js('document.querySelector("#gh-mov").textContent'), '');
  assert.equal(await a.js(`getComputedStyle(document.querySelector('${NA_LISTA}[data-k="${k}"]')).outlineStyle`), 'none');
});

// =====================================================================================================================
// Ordem pendente: só vale ao sair da lista
// =====================================================================================================================

test('Ordem pendente: clicar em área sem foco não ordena; levar o foco para fora da lista ordena; o Salvar leva a hora digitada', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await editarPrimeiraLinha(a);
  // título do formulário: área que não recebe foco (o campo de hora perde o foco, nada ganha)
  const [x, y] = await a.centro('#dlg h1'); await a.apertarSoltar(x, y); await dorme(120);
  assert.equal((await a.estado()).horas[0], '15:30', 'clique em área sem foco deixa a ordem pendente');
  await a.clicar('[name=name]');
  assert.equal((await a.estado()).horas.indexOf('15:30'), 7, 'foco em campo fora da lista aplica a ordem');
  // outra edição e, desta vez, direto no Salvar
  await a.digitarHora(`${NA_LISTA}:nth-child(1) .gh-h`, '2345');
  await a.clicar('#salvar');
  await esperarSalvo(a);
  const regra = await (await fetch(`${painel.base}/api/rules`)).json();
  const horas = regra.find((r) => r.name === 'Regra QA').grade.horarios.map((h) => h.hora);
  assert.deepEqual(horas, ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '15:30', '16:00', '17:00', '23:45'],
    'o servidor guardou as horas digitadas, em ordem, mesmo com a tela fora de ordem no Salvar');
});
const esperarSalvo = (a) => a.esperar("document.querySelector('#dlg').open === false", 8000);

// =====================================================================================================================
// Q4 ampliado — "15:--" sobrevive a Copiar, Remover e Adicionar (nenhuma linha é recriada)
// =====================================================================================================================

test('Q4: a hora pela metade ("15:--") continua na mesma linha, no mesmo nó e no mesmo lugar depois de Copiar, Remover e Adicionar', NAV, async (t) => {
  const a = await abrirFormulario(t);
  const kEditada = await a.js("document.querySelectorAll('#gh-lista > li')[1].dataset.k");
  const sel = `${NA_LISTA}:nth-child(2) .gh-h`;
  const [, y, esquerda] = await a.centro(sel); await a.apertarSoltar(esquerda + 14, y);
  await a.tecla('Backspace', 8); await a.tecla('1', 49, '1'); await a.tecla('5', 53, '5'); await a.tecla('Backspace', 8);
  assert.equal(await a.js('document.activeElement.value'), '', 'pré-condição: 15:-- (value vazio)');
  await a.js(`document.querySelector('${sel}').__eu = 'o mesmo campo'`);
  const incompleto = () => a.js(`(() => { const h = document.querySelector('${NA_LISTA}[data-k="${kEditada}"] .gh-h'); return { eu: h?.__eu, ruim: h?.validity.badInput, pos: [...document.querySelectorAll('#gh-lista > li')].findIndex((li) => li.dataset.k === '${kEditada}') }; })()`);
  const kOutra = await a.chaveDe('12:00');
  await a.clicar(`${NA_LISTA}[data-k="${kOutra}"] [data-gh=copiar]`);
  assert.deepEqual(await incompleto(), { eu: 'o mesmo campo', ruim: true, pos: 1 }, 'depois de Copiar');
  await a.clicar(`${NA_LISTA}[data-k="${kOutra}"] [data-gh=remover]`);
  assert.deepEqual(await incompleto(), { eu: 'o mesmo campo', ruim: true, pos: 1 }, 'depois de Remover');
  await a.clicar('#gh-add');
  assert.deepEqual(await incompleto(), { eu: 'o mesmo campo', ruim: true, pos: 1 }, 'depois de Adicionar');
  // levar o foco para fora da lista ordena as outras e deixa a linha sem hora válida onde está
  await a.clicar('[name=dedupe_days]');
  const e = await a.estado();
  assert.equal(e.chaves.indexOf(kEditada), 1, 'a linha sem hora válida não vai para o fim ao ordenar');
});

test('Q4: copiar a própria linha com "15:--" cria uma linha sem hora logo abaixo, sem recriar a original', NAV, async (t) => {
  const a = await abrirFormulario(t);
  const kEditada = await a.js("document.querySelectorAll('#gh-lista > li')[1].dataset.k");
  const sel = `${NA_LISTA}:nth-child(2) .gh-h`;
  const [, y, esquerda] = await a.centro(sel); await a.apertarSoltar(esquerda + 14, y);
  await a.tecla('Backspace', 8); await a.tecla('1', 49, '1'); await a.tecla('5', 53, '5'); await a.tecla('Backspace', 8);
  await a.js(`document.querySelector('${sel}').__eu = 'o mesmo campo'`);
  await a.clicar(`${NA_LISTA}[data-k="${kEditada}"] [data-gh=copiar]`);
  const e = await a.estado();
  assert.equal(e.horas.length, HORAS.length + 1);
  assert.equal(e.chaves.indexOf(kEditada), 1);
  assert.equal(e.horas[2], '', 'a cópia fica logo abaixo e sem hora');
  assert.equal(await a.js(`document.querySelector('${NA_LISTA}[data-k="${kEditada}"] .gh-h').__eu`), 'o mesmo campo');
});

// =====================================================================================================================
// U4 — descartar alterações
// =====================================================================================================================

/** Altera uma ofertas (campo da grade) para o formulário ficar "sujo". */
const sujar = (a) => seta(a, `${NA_LISTA}:nth-child(1) .gh-q`, '19');

test('U4: Cancelar sem alteração fecha direto; com alteração pergunta "Descartar as alterações?", recusar mantém o diálogo e os dados, aceitar fecha', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await a.clicar('#cancelar');
  assert.equal(await a.js('document.querySelector("#dlg").open'), false, 'sem alteração fecha direto');
  assert.deepEqual(await a.js('window.__conf'), [], 'e sem perguntar');
  // reabre, altera e cancela recusando
  await a.clicar('button[data-act=editar]');
  await a.esperar("document.querySelector('#dlg').open && document.querySelectorAll('#gh-lista > li').length === 10");
  await sujar(a);
  await a.js('window.__resp = false');
  await a.clicar('#cancelar');
  assert.deepEqual(await a.js('window.__conf'), ['Descartar as alterações?']);
  assert.equal(await a.js('document.querySelector("#dlg").open'), true, 'recusar mantém o diálogo aberto');
  assert.equal(await a.js(`document.querySelector('${NA_LISTA}:nth-child(1) .gh-q').value`), '19', 'e os dados');
  await a.js('window.__resp = true');
  await a.clicar('#cancelar');
  assert.equal(await a.js('document.querySelector("#dlg").open'), false, 'aceitar descarta e fecha');
  assert.deepEqual(await requisicoes(a), [], 'nada foi gravado');
});

test('U4: Esc sem alteração fecha direto; com alteração pergunta, recusar mantém o diálogo e os dados (inclusive no 2º Esc), aceitar fecha', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await a.tecla('Escape', 27); await dorme(200);
  assert.equal(await a.js('document.querySelector("#dlg").open'), false, 'Esc sem alteração fecha');
  assert.deepEqual(await a.js('window.__conf'), []);
  await a.clicar('button[data-act=editar]');
  await a.esperar("document.querySelector('#dlg').open && document.querySelectorAll('#gh-lista > li').length === 10");
  await sujar(a);
  await a.js('window.__resp = false');
  await a.tecla('Escape', 27); await dorme(200);
  assert.equal(await a.js('document.querySelector("#dlg").open'), true, 'Esc recusado mantém aberto');
  await a.tecla('Escape', 27); await dorme(200); // 2º Esc seguido: o Chrome não pode fechar sem perguntar
  assert.equal(await a.js('document.querySelector("#dlg").open'), true, 'o 2º Esc também pergunta');
  assert.deepEqual(await a.js('window.__conf'), ['Descartar as alterações?', 'Descartar as alterações?']);
  assert.equal(await a.js(`document.querySelector('${NA_LISTA}:nth-child(1) .gh-q').value`), '19');
  await a.js('window.__resp = true');
  await a.tecla('Escape', 27); await dorme(200);
  assert.equal(await a.js('document.querySelector("#dlg").open'), false, 'Esc aceito fecha');
  assert.equal(await a.js('document.activeElement.dataset.act'), 'editar', 'e devolve o foco ao botão de origem');
});

test('U4: voltar o valor ao original não conta como alteração; Salvar não pergunta; o ouvinte do Esc some ao fechar e não atrapalha outros diálogos', NAV, async (t) => {
  const a = await abrirFormulario(t);
  const original = await a.js(`document.querySelector('${NA_LISTA}:nth-child(1) .gh-q').value`);
  await sujar(a); await seta(a, `${NA_LISTA}:nth-child(1) .gh-q`, original);
  await a.tecla('Escape', 27); await dorme(200);
  assert.equal(await a.js('document.querySelector("#dlg").open'), false, 'valor de volta ao original: fecha direto');
  assert.deepEqual(await a.js('window.__conf'), []);
  // sujo + Salvar: não pergunta nada
  await a.clicar('button[data-act=editar]');
  await a.esperar("document.querySelector('#dlg').open && document.querySelectorAll('#gh-lista > li').length === 10");
  await sujar(a);
  await a.clicar('#salvar');
  await esperarSalvo(a);
  assert.deepEqual(await a.js('window.__conf'), [], 'Salvar não pergunta');
  assert.equal((await requisicoes(a)).filter((r) => r.startsWith('PUT')).length, 1, 'e grava');
  // outro conteúdo no mesmo <dialog>: Esc fecha sem perguntar (o ouvinte do formulário já saiu)
  await a.js("window.__resp = false; const d = document.querySelector('#dlg'); d.innerHTML = '<p>outro</p>'; d.showModal()");
  await a.tecla('Escape', 27); await dorme(200);
  assert.equal(await a.js('document.querySelector("#dlg").open'), false, 'outro diálogo fecha com Esc normalmente');
  assert.deepEqual(await a.js('window.__conf'), []);
});

test('U4: mudar o modo ("Em horários marcados") conta como alteração; voltar ao modo original, não', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await a.js("document.querySelector('#r-modo button[data-v=intervalo]').click()");
  await a.js('window.__resp = false');
  await a.tecla('Escape', 27); await dorme(200);
  assert.equal(await a.js('document.querySelector("#dlg").open'), true, 'trocar para "A cada X minutos" é alteração');
  assert.equal((await a.js('window.__conf')).length, 1);
  await a.js("document.querySelector('#r-modo button[data-v=grade]').click()");
  await a.tecla('Escape', 27); await dorme(200);
  assert.equal(await a.js('document.querySelector("#dlg").open'), false, 'de volta ao modo original, fecha direto');
});
