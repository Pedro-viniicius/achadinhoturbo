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
  const r = await fetch(`${base}/api/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CORPO_REGRA) });
  assert.equal(r.status, 200, 'a regra de teste deve ser criada pela API');
  return { base, porta, filho, dir, regraId: (await r.json()).id };
}
const CORPO_REGRA = { name: 'Regra QA', enabled: true, tag_id: 1, template_id: 1, group_jids: ['111@g.us'], per_run: 3, interval_min: 60, window_start: '08:00', window_end: '22:00',
  sources: [{ type: 'list', config: { items: 'https://produto.mercadolivre.com.br/MLB-2000001-x | Item | 10 | 20' } }],
  grade: { dias: [0, 1, 2, 3, 4, 5, 6], horarios: HORAS.map((hora, i) => ({ hora, qtd: (i % 3) + 1, template_id: null })) } };
/** Os testes compartilham o painel e alguns SALVAM (U4, ordem pendente): quem depende das 10 horas de origem restaura a regra antes de abrir o formulário. */
async function restaurarRegra() {
  const r = await fetch(`${painel.base}/api/rules/${painel.regraId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CORPO_REGRA) });
  assert.equal(r.status, 200, 'a regra de teste deve voltar ao estado de origem');
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
async function abrirFormulario(t, { largura = 1130, altura = 965, regraId = null, antes = null, restaurar = false } = {}) {
  if (restaurar) await restaurarRegra();
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
  if (antes) await p.js(antes); // gancho: roda com a página pronta e o formulário ainda fechado (ex.: segurar uma resposta do servidor)
  const [x, y] = await a.centro(regraId ? `article.regra[data-id="${regraId}"] button[data-act=editar]` : 'button[data-act=editar]');
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
  assert.deepEqual(e.horas, ['15:30', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'],
    'a linha voltou exatamente à posição de antes do Remover: o Desfazer não aplica a ordem pendente (a 15:30 ainda espera na 1ª posição)');
  assert.equal(await a.js(`document.querySelector('${NA_LISTA}[data-k="${k}"]').__eu`), 'a mesma linha', 'o mesmo nó voltou (não foi recriado)');
  assert.equal(await a.js(`document.querySelector('${li} .gh-q').value`), '7');
  assert.equal(await a.js(`document.querySelector('${li} .gh-t').value`), tpl);
  assert.equal(e.foco, '12:00', 'o foco vai para a linha devolvida');
  assert.equal(await a.js(TAMANHO('#gh-desfazer')).then((x) => x.visivel), false, 'o Desfazer some depois de usado');
  assert.equal((await a.js(TAMANHO('#gh-desf'))).texto, 'Horário 12:00 de volta.');
  // a ordem pendente continua valendo: ao sair da lista a linha editada vai para o lugar certo, com aviso e contorno
  await a.clicar('[name=dedupe_days]');
  const f = await a.estado();
  assert.deepEqual(f.horas, ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '15:30', '16:00', '17:00']);
  assert.equal(await a.js("document.querySelector('#gh-mov').textContent"), 'Horário 15:30 movido para a posição 8.');
  assert.equal(await a.js(`getComputedStyle(document.querySelector('${NA_LISTA}:nth-child(8)')).outlineStyle`), 'solid', 'a linha movida tem contorno');
  assert.equal(await a.js(`document.querySelector('${NA_LISTA}:nth-child(8) .gh-h').value`), '15:30');
});

// R1 (rodada 2) — o foco que vai para o "Desfazer" não pode aplicar a ordem pendente: o nó de referência mudava de lugar,
// a linha voltava no ponto errado e a outra se movia depois, sem aviso nem contorno
test('R1: trocar 08:00 por 10:30, remover 10:00 e Desfazer: 10:00 volta ao ponto de antes; ao sair da lista a 10:30 vai ao lugar certo com aviso e contorno', NAV, async (t) => {
  const a = await abrirFormulario(t, { restaurar: true });
  await a.digitarHora(`${NA_LISTA}:nth-child(1) .gh-h`, '1030'); // foco na lista; 10:30 espera na 1ª posição
  assert.equal((await a.estado()).foco, '10:30');
  const k30 = await a.js("document.activeElement.closest('li').dataset.k");
  const k10 = await a.chaveDe('10:00');
  await a.clicar(`${NA_LISTA}[data-k="${k10}"] [data-gh=remover]`);
  assert.deepEqual((await a.estado()).horas, ['10:30', '09:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']);
  await a.clicar('#gh-desfazer', { rolar: false });
  const e = await a.estado();
  assert.deepEqual(e.horas, ['10:30', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'], 'a 10:00 voltou ao ponto original; nada foi reordenado');
  assert.equal(e.chaves[2], k10, 'é o mesmo nó');
  assert.equal(await a.js("document.querySelector('#gh-mov').textContent"), '', 'nenhum aviso de "movido" antes de sair da lista');
  await a.clicar('[name=dedupe_days]'); // foco fora da lista
  const f = await a.estado();
  assert.deepEqual(f.horas, ['09:00', '10:00', '10:30', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']);
  assert.equal(f.chaves[2], k30, 'a linha editada é o mesmo nó');
  assert.equal(await a.js("document.querySelector('#gh-mov').textContent"), 'Horário 10:30 movido para a posição 3.', 'o aviso diz onde a linha foi parar');
  assert.equal(await a.js(`getComputedStyle(document.querySelector('${NA_LISTA}[data-k="${k30}"]')).outlineStyle`), 'solid', 'e a linha tem contorno');
});

test('R1: Desfazer depois de "Limpar tudo" devolve as linhas na ordem e os mesmos nós; com ordem pendente antes, a ordem vale ao limpar', NAV, async (t) => {
  const a = await abrirFormulario(t, { restaurar: true });
  await a.digitarHora(`${NA_LISTA}:nth-child(1) .gh-h`, '1030');
  await a.js("[...document.querySelectorAll('#gh-lista > li')].forEach((li, i) => { li.__n = i; })");
  await a.clicar('#gh-limpar');
  assert.deepEqual((await a.estado()).horas, []);
  await a.clicar('#gh-desfazer', { rolar: false });
  const e = await a.estado();
  assert.deepEqual(e.horas, ['09:00', '10:00', '10:30', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'], 'a ordem pendente valeu ao ir para o "Limpar tudo" (fora da lista)');
  assert.deepEqual(await a.js("[...document.querySelectorAll('#gh-lista > li')].map((li) => li.__n)"), [1, 2, 0, 3, 4, 5, 6, 7, 8, 9], 'os mesmos nós');
  await a.clicar('[name=dedupe_days]');
  assert.deepEqual((await a.estado()).horas, ['09:00', '10:00', '10:30', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'], 'nada mais se move');
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
  // a linha 15:30 estava fora de ordem; o "Limpar tudo" está fora da lista: ao clicar nele a ordem pendente já valeu
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

// R4 (rodada 2) — a assinatura do U4 compara os horários por hora: a ordem na tela (pendente enquanto o foco está na lista) não conta
test('U4: voltar a hora ao valor original com a linha ainda fora do lugar não conta como alteração (Esc fecha sem perguntar)', NAV, async (t) => {
  const a = await abrirFormulario(t, { restaurar: true });
  await editarPrimeiraLinha(a); // 08:00 -> 15:30
  await a.clicar('[name=dedupe_days]'); // a linha vai para a 8ª posição
  assert.equal((await a.estado()).horas.indexOf('15:30'), 7, 'pré-condição: a linha editada mudou de lugar');
  await a.digitarHora(`${NA_LISTA}:nth-child(8) .gh-h`, '0800'); // a hora volta ao original; a linha espera na 8ª posição
  const e = await a.estado();
  assert.equal(e.horas.indexOf('08:00'), 7, 'pré-condição: a linha com 08:00 ainda está fora do lugar (ordem pendente, foco na lista)');
  await a.tecla('Escape', 27); await dorme(200);
  assert.deepEqual(await a.js('window.__conf'), [], 'nenhuma pergunta: o formulário voltou ao que era');
  assert.equal(await a.js('document.querySelector("#dlg").open'), false, 'Esc fecha direto');
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

// =====================================================================================================================
// Rodada 1 da revisão (R1 a R4, D1)
// =====================================================================================================================

// R1 — com "removido" e "movido" à vista ao mesmo tempo, o aviso de "movido" some no mousedown e a lista saltava entre o
// aperto e o soltar. A linha de avisos reserva a altura do pior caso em cada largura: nada abaixo dela muda de lugar.
const AVISOS_JUNTOS = ['Horário 12:00 removido.', 'Horário 15:30 movido para a posição 7.']; // 12:00 sai: restam 9 linhas

/** Põe os avisos (texto de "removido" com Desfazer, texto de "movido") diretamente na barra e devolve a altura da linha de avisos. */
const alturaComAvisos = (a, desf, comBotao, mov) => a.js(`(() => {
  document.querySelector('.gh-desf-txt').textContent = ${JSON.stringify(desf)}; document.querySelector('#gh-desfazer').hidden = !${comBotao};
  document.querySelector('#gh-mov').textContent = ${JSON.stringify(mov)};
  return Math.round(document.querySelector('.gh-estado').getBoundingClientRect().height * 10) / 10; })()`);

/** Altura da linha de avisos igual em todos os casos, para cada largura de `larguras`; devolve as larguras que falharam. */
async function alturasDosAvisos(t, larguras) {
  const a = await abrirFormulario(t, { restaurar: true });
  // os textos vêm da própria tela (TEXTOS_GRADE): o pior caso é o que o código escreve, não uma cópia que pode ficar velha
  // Só entram combinações que a tela produz: "removido" (com Desfazer) convive com "movido" (a ordem pendente vale depois do Remover);
  // "removidos" (Limpar tudo) e "adicionado" (Adicionar) apagam o outro aviso.
  const T = await a.js(`(() => { const T = TEXTOS_GRADE; return { semHora: T.removido(T.semHora), removidos: T.removidos(48), movido: T.movido('15:30', 48), adicionado: T.adicionado('15:30', 48) }; })()`);
  assert.equal(T.semHora, 'Horário sem hora removido.', 'o texto de uma linha sem hora é o que o código escreve');
  const casos = [['vazia', '', false, ''], ['só removido', AVISOS_JUNTOS[0], true, ''], ['só removido (linha sem hora)', T.semHora, true, ''], ['só "48 removidos"', T.removidos, true, ''],
    ['só movido', '', false, T.movido], ['só adicionado', '', false, T.adicionado], ['os dois', AVISOS_JUNTOS[0], true, T.movido],
    ['os dois, os mais longos (linha sem hora)', T.semHora, true, T.movido]];
  const falhas = [];
  for (const largura of larguras) {
    await a.tela(largura, 900); await dorme(80);
    const alturas = []; for (const [, d, b, m] of casos) alturas.push(await alturaComAvisos(a, d, b, m));
    if (new Set(alturas).size !== 1) falhas.push(`${largura} px: ${casos.map((c, i) => `${c[0]}=${alturas[i]}`).join(', ')}`);
  }
  return falhas;
}

test('R1: a linha de avisos tem a MESMA altura vazia, só com "removido", só com "movido" e com os dois juntos, de 320 a 1280 px', NAV, async (t) => {
  const falhas = await alturasDosAvisos(t, [320, 360, 375, 414, 480, 600, 601, 640, 660, 700, 720, 760, 900, 1130, 1280]);
  assert.deepEqual(falhas, [], `a altura da linha de avisos mudou com o conteúdo (tudo abaixo dela salta): ${falhas.join(' | ')}`);
});

test('R1: 341 a 351 px: a linha de avisos tem a mesma altura com os dois avisos juntos', NAV, async (t) => {
  const falhas = await alturasDosAvisos(t, [341, 346, 351]);
  assert.deepEqual(falhas, [], `a altura da linha de avisos mudou com o conteúdo: ${falhas.join(' | ')}`);
});

for (const largura of [640, 375, 320]) test(`R1: ${largura} px: com "removido" e "movido" à vista, apertar a parte de baixo de "Copiar" não move nada antes de soltar e o clique copia`, NAV, async (t) => {
  const a = await abrirFormulario(t, { largura, altura: 900, restaurar: true });
  await editarPrimeiraLinha(a);
  const k12 = await a.chaveDe('12:00');
  await a.clicar(`${NA_LISTA}[data-k="${k12}"] [data-gh=remover]`); // "removido" + Desfazer
  await a.clicar('[name=dedupe_days]'); // foco fora da lista: a ordem pendente vale e o aviso de "movido" aparece
  assert.equal((await a.js(TAMANHO('#gh-desf'))).texto.replace(/\s+/g, ' '), `${AVISOS_JUNTOS[0]} Desfazer`, 'pré-condição: o aviso de remoção está à vista');
  assert.equal((await a.js(TAMANHO('#gh-mov'))).texto, AVISOS_JUNTOS[1], 'pré-condição: o aviso de movido está à vista junto com o de remoção');
  const k = await a.chaveDe('13:00');
  const alvo = `${NA_LISTA}[data-k="${k}"] [data-gh=copiar]`;
  const [x] = await a.centro(alvo); // rola o botão para o meio da janela
  const medir = () => a.js(`(() => { const b = document.querySelector(${JSON.stringify(alvo)}).getBoundingClientRect();
    return { y: b.top, h: b.height, estado: document.querySelector('.gh-estado').getBoundingClientRect().height, linhas: document.querySelectorAll('#gh-lista > li').length }; })()`);
  const antes = await medir();
  const y = antes.y + antes.h - 3; // a parte de baixo do botão: é onde um salto de poucos pixels faz o mouse sair dele
  await a.gravarEventos();
  await a.mouse('mouseMoved', x, y); await a.mouse('mousePressed', x, y);
  const apertado = await medir();
  await a.mouse('mouseReleased', x, y); await dorme(150);
  const ev = await a.eventos();
  assert.equal(apertado.estado, antes.estado, `a linha de avisos mudou de altura no mousedown (${antes.estado} -> ${apertado.estado} px)`);
  assert.equal(apertado.y, antes.y, `o botão saltou ${apertado.y - antes.y} px entre o aperto e o soltar`);
  assert.equal((await medir()).linhas, antes.linhas + 1, `"Copiar" não copiou. Eventos: ${sequencia(ev)}`);
});

// R3 — Remover e Desfazer devolviam a linha sem a marca de "editada" e ela mudava de lugar sem aviso nem contorno
test('R3: trocar 08:00 por 15:30, Remover e Desfazer: ao sair da lista a linha vai para o lugar certo COM aviso e contorno', NAV, async (t) => {
  const a = await abrirFormulario(t, { restaurar: true });
  await editarPrimeiraLinha(a);
  const k = await a.js("document.activeElement.closest('li').dataset.k");
  await a.clicar(`${NA_LISTA}[data-k="${k}"] [data-gh=remover]`);
  await a.clicar('#gh-desfazer', { rolar: false });
  assert.equal((await a.estado()).horas.indexOf('15:30'), 0, 'pré-condição: a ordem continua pendente (o foco está na lista)');
  await a.clicar('[name=dedupe_days]');
  const e = await a.estado();
  assert.equal(e.horas.indexOf('15:30'), 7, 'a linha foi para a 8ª posição');
  assert.equal(await a.js("document.querySelector('#gh-mov').textContent"), 'Horário 15:30 movido para a posição 8.', 'e o aviso diz onde ela foi parar');
  assert.equal(await a.js(`getComputedStyle(document.querySelector('${NA_LISTA}[data-k="${k}"]')).outlineStyle`), 'solid', 'e a linha tem contorno');
  assert.equal(e.chaves[7], k, 'é o mesmo nó');
});

// R2 — Esc com a dica "?" fixa aberta deve fechar só a dica, mesmo com o formulário alterado
test('R2: Esc com uma dica "?" fixa aberta e o formulário alterado fecha só a dica (não pergunta); o 2º Esc, sim', NAV, async (t) => {
  const a = await abrirFormulario(t, { restaurar: true });
  await sujar(a);
  await a.js('window.__resp = false');
  await a.clicar('#gh-lista-h .q'); // "?" dos Horários: tem "Ler mais", então a dica fica fixa dentro do diálogo
  await a.esperar("!!document.querySelector('#dlg #tip.tip-fixo')");
  await a.tecla('Escape', 27); await dorme(250);
  assert.deepEqual(await a.js('window.__conf'), [], 'o Esc que fecha a dica não pergunta "Descartar as alterações?"');
  assert.equal(await a.js('document.querySelector("#dlg").open'), true, 'o diálogo continua aberto');
  assert.equal(await a.js("!!document.querySelector('#tip.tip-fixo')"), false, 'e a dica fechou');
  assert.equal(await a.js(`document.querySelector('${NA_LISTA}:nth-child(1) .gh-q').value`), '19', 'com os dados');
  await a.tecla('Escape', 27); await dorme(250); // sem dica: volta a perguntar
  assert.deepEqual(await a.js('window.__conf'), ['Descartar as alterações?']);
  assert.equal(await a.js('document.querySelector("#dlg").open'), true);
});

test('R2: Esc com uma dica "?" fixa aberta e o formulário SEM alteração fecha só a dica; o 2º Esc fecha o diálogo', NAV, async (t) => {
  const a = await abrirFormulario(t, { restaurar: true });
  await a.clicar('#gh-lista-h .q');
  await a.esperar("!!document.querySelector('#dlg #tip.tip-fixo')");
  await a.tecla('Escape', 27); await dorme(250);
  assert.equal(await a.js('document.querySelector("#dlg").open'), true, 'o 1º Esc fecha só a dica');
  assert.equal(await a.js("!!document.querySelector('#tip.tip-fixo')"), false);
  await a.tecla('Escape', 27); await dorme(250);
  assert.equal(await a.js('document.querySelector("#dlg").open'), false, 'o 2º Esc fecha o diálogo');
  assert.deepEqual(await a.js('window.__conf'), []);
});

test('R2: um evento `cancel` do <dialog> com a dica "?" fixa aberta é cancelado sem perguntar (com ou sem alteração)', NAV, async (t) => {
  const a = await abrirFormulario(t, { restaurar: true });
  await a.js('window.__resp = true'); // se o formulário perguntasse, aceitar deixaria o `cancel` passar: o teste pegaria pela pergunta
  await a.clicar('#gh-lista-h .q');
  await a.esperar("!!document.querySelector('#dlg #tip.tip-fixo')");
  const pedir = () => a.js("(() => { const ev = new Event('cancel', { cancelable: true }); document.querySelector('#dlg').dispatchEvent(ev); return ev.defaultPrevented; })()");
  assert.equal(await pedir(), true, 'sem alteração: o pedido de fechar é recusado enquanto a dica está aberta');
  await sujar(a);
  assert.equal(await pedir(), true, 'com alteração: também, e sem perguntar');
  assert.deepEqual(await a.js('window.__conf'), []);
  assert.equal(await a.js('document.querySelector("#dlg").open'), true);
});

// R4 — as categorias do catálogo chegam depois e repintam as caixas (na ordem do servidor): o estado inicial acompanha
// enquanto o dono não mexeu em nada (comInicial); depois que ele mexeu, o que ele fez continua contando
const CATEGORIAS_DO_SERVIDOR = [{ nome: 'Beleza', total: 5, lojas: { amazon: 3, ml: 1, shopee: 1 } }, { nome: 'Casa', total: 7, lojas: { amazon: 4, ml: 2, shopee: 1 } }];
const SEGURAR_CATEGORIAS = `(() => { window.__cats = new Promise((ok) => { window.__liberarCats = ok; }); const f0 = window.fetch;
  window.fetch = (u, o) => (String(u).includes('/api/catalogo/categorias') ? window.__cats.then(() => new Response(JSON.stringify({ categorias: ${JSON.stringify(CATEGORIAS_DO_SERVIDOR)}, total: 12 }), { status: 200, headers: { 'content-type': 'application/json' } })) : f0(u, o)); })()`;
const CATS_NA_TELA = "[...document.querySelectorAll('#dlg .fc-cats input[type=checkbox]')].map((c) => c.value)";

/** Regra com fonte Catálogo cujas categorias marcadas estão em ordem DIFERENTE da que o servidor devolve (Casa, Beleza). */
async function criarRegraCatalogo(t) {
  const corpo = { name: 'Regra Catálogo', enabled: false, tag_id: 1, template_id: 1, group_jids: ['111@g.us'], per_run: 3, interval_min: 60, window_start: '08:00', window_end: '22:00',
    sources: [{ type: 'catalogo', config: { categorias: ['Casa', 'Beleza'], lojas: ['amazon'], ordem: 'atualizacao' } }],
    grade: { dias: [0, 1, 2, 3, 4, 5, 6], horarios: HORAS.map((hora) => ({ hora, qtd: 1, template_id: null })) } };
  const r = await fetch(`${painel.base}/api/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  assert.equal(r.status, 200, `a regra com fonte Catálogo deve ser criada pela API (${r.status})`);
  const { id } = await r.json();
  t.after(() => fetch(`${painel.base}/api/rules/${id}`, { method: 'DELETE' }));
  return id;
}

test('R4: categorias do catálogo chegam em outra ordem e o dono não mexeu em nada: Cancelar fecha direto (sem perguntar)', NAV, async (t) => {
  const id = await criarRegraCatalogo(t);
  const a = await abrirFormulario(t, { regraId: id, antes: SEGURAR_CATEGORIAS });
  assert.deepEqual(await a.js(CATS_NA_TELA), ['Casa', 'Beleza'], 'pré-condição: antes da chegada, a ordem é a da regra');
  await a.js('window.__liberarCats()');
  await a.esperar(`${CATS_NA_TELA}[0] === 'Beleza'`);
  assert.deepEqual(await a.js(CATS_NA_TELA), ['Beleza', 'Casa'], 'pré-condição: as caixas foram repintadas na ordem do servidor');
  await a.clicar('#cancelar');
  assert.deepEqual(await a.js('window.__conf'), [], 'a chegada das categorias não conta como alteração do dono');
  assert.equal(await a.js('document.querySelector("#dlg").open'), false);
});

test('R4: o dono altera um campo ANTES de as categorias chegarem: Cancelar continua perguntando', NAV, async (t) => {
  const id = await criarRegraCatalogo(t);
  const a = await abrirFormulario(t, { regraId: id, antes: SEGURAR_CATEGORIAS });
  await seta(a, '[name=name]', 'Outro nome');
  await a.js('window.__liberarCats(); window.__resp = false');
  await a.esperar(`${CATS_NA_TELA}[0] === 'Beleza'`);
  await a.clicar('#cancelar');
  assert.deepEqual(await a.js('window.__conf'), ['Descartar as alterações?']);
  assert.equal(await a.js('document.querySelector("#dlg").open'), true, 'recusar mantém o diálogo aberto');
  assert.equal(await a.js('document.querySelector("[name=name]").value'), 'Outro nome');
});

// D1 — a 320 px nada do bloco da grade passa da borda do bloco
test('D1: 320 px: nenhum elemento do bloco da grade passa da borda do bloco (sem rolagem horizontal própria)', NAV, async (t) => {
  for (const largura of [320, 375]) {
    const a = await abrirFormulario(t, { largura, altura: 900, restaurar: true });
    const r = await a.js(`(() => { const g = document.querySelector('#r-grade'); const lim = g.getBoundingClientRect().right + 0.5;
      return { sw: g.scrollWidth, cw: g.clientWidth, fora: [...g.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > lim && !e.closest('[hidden]')).map((e) => e.tagName + '.' + e.className).slice(0, 8) }; })()`);
    assert.deepEqual(r.fora, [], `${largura} px: elementos do bloco da grade fora da borda: ${r.fora.join(', ')}`);
    assert.ok(r.sw <= r.cw, `${largura} px: o bloco da grade rola na horizontal (${r.sw} > ${r.cw})`);
    await a.clicar('#cancelar');
  }
});

// =====================================================================================================================
// R8 (revisão, rodada 3) — o nó de referência do Desfazer pode mudar de lugar por OUTRO caminho (o foco em campo fora da
// lista aplica a ordem pendente); a linha devolvida tem de voltar no lugar certo pela hora, direto, sem se mover calada depois
// =====================================================================================================================

test('R8: trocar 10:00 por 16:30, remover 09:00, levar o foco para fora da lista e Desfazer: a 09:00 volta direto à 2ª posição e nada se move calado depois', NAV, async (t) => {
  const a = await abrirFormulario(t, { restaurar: true });
  await a.digitarHora(`${NA_LISTA}:nth-child(3) .gh-h`, '1630'); // 10:00 -> 16:30; a linha espera na 3ª posição
  assert.equal((await a.estado()).foco, '16:30', 'pré-condição: a hora foi trocada e o foco continua na lista');
  const k09 = await a.chaveDe('09:00');
  await a.clicar(`${NA_LISTA}[data-k="${k09}"] [data-gh=remover]`); // o "depois" da 09:00 é a linha pendente (16:30)
  assert.deepEqual((await a.estado()).horas, ['08:00', '16:30', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'], 'pré-condição: 09:00 saiu e a 16:30 ainda espera a ordem');
  await a.clicar('[name=dedupe_days]'); // foco fora da lista: a ordem pendente vale e a 16:30 vai para a 8ª posição
  assert.deepEqual((await a.estado()).horas, ['08:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '16:30', '17:00'], 'pré-condição: a 16:30 já está no lugar certo');
  await a.clicar('#gh-desfazer', { rolar: false });
  const e = await a.estado();
  assert.deepEqual(e.horas, ['08:00', '09:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '16:30', '17:00'],
    `a 09:00 devia voltar direto à 2ª posição (pela hora), mas ficou: ${e.horas.join(', ')}`);
  assert.equal(e.chaves[1], k09, 'é o mesmo nó');
  assert.equal(await a.js("document.querySelector('#gh-mov').textContent"), '', 'nenhum aviso de "movido" logo depois do Desfazer');
  // sair da lista de novo: nada pode se mover calado
  await a.clicar('[name=name]');
  const f = await a.estado();
  assert.deepEqual(f.horas, e.horas, `ao sair da lista a ordem mudou sem aviso: ${f.horas.join(', ')}`);
  assert.equal(await a.js("document.querySelector('#gh-mov').textContent"), '', 'e nenhum aviso de movido apareceu');
  assert.equal(await a.js("document.querySelectorAll('#gh-lista > li.gh-movida').length"), 0, 'nem contorno em linha alguma');
});

// =====================================================================================================================
// R6 (revisão, pré-existente) — link de rota interna dentro do formulário do <dialog> navega na mesma aba: a troca de rota
// fecha o diálogo sem perguntar e o que foi digitado se perde. Decisão: abrem em outra aba (target=_blank, rel=noopener),
// como a dica "Ler mais" do ajuda.js já faz dentro de diálogo.
// =====================================================================================================================

/** Todo `<a href^="#">` do formulário aberto no #dlg, com o que importa para abrir em outra aba. */
const LINKS_INTERNOS = `[...document.querySelectorAll('#dlg #f a[href^="#"]')].map((l) => ({ href: l.getAttribute('href'), target: l.target, rel: l.rel, texto: l.textContent.trim().slice(0, 40) }))`;
/** Os que não abririam em outra aba, descritos para a mensagem de falha. */
const linksRuins = (links) => links.filter((l) => l.target !== '_blank' || !l.rel.split(/\s+/).includes('noopener')).map((l) => `${l.href} ("${l.texto}", target="${l.target}", rel="${l.rel}")`);
/** Refaz o formulário com o estado `estado` (JS avaliado na página antes de `formRegra`) e o regra `regra` (JSON ou null = disparo novo). */
const refazerFormulario = (a, estado, regra = null) => a.js(`(() => { ${estado}; formRegra(${regra ? JSON.stringify(regra) : ''}); return document.querySelectorAll('#dlg #f').length; })()`);
const REGRA_CATALOGO_AMAZON = { name: 'Cat', enabled: true, tag_id: 1, template_id: 1, group_jids: ['111@g.us'], per_run: 3, interval_min: 60, window_start: '08:00', window_end: '22:00', dedupe_days: 7, send_image: true,
  sources: [{ type: 'catalogo', config: { categorias: [], lojas: ['amazon'], ordem: 'atualizacao' } }] };

test('R6: o link "Ajustes" do bloco da grade (sempre presente no formulário aberto) abre em outra aba, com rel noopener', NAV, async (t) => {
  const a = await abrirFormulario(t);
  const links = await a.js(LINKS_INTERNOS);
  assert.ok(links.some((l) => l.href === '#ajustes'), `pré-condição: o formulário tem o link "Ajustes" (links: ${links.map((l) => l.href).join(', ')})`);
  assert.deepEqual(linksRuins(links), [], 'links de rota interna dentro do formulário precisam abrir em outra aba');
});

test('R6: clicar em "Ajustes" com o mouse não fecha o diálogo nem perde o que foi digitado', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await seta(a, '[name=name]', 'Digitado e não salvo');
  const abas = async () => (await (await fetch(`http://127.0.0.1:${chrome.porta}/json/list`)).json()).filter((x) => x.type === 'page').map((x) => x.id);
  const antes = new Set(await abas());
  try {
    await a.clicar('#r-grade a[href="#ajustes"]');
    await dorme(300); // a aba nova (se abrir) carrega à parte: esta página não pode mudar
    assert.equal(await a.js('document.querySelector("#dlg").open'), true, 'o clique no link fechou o diálogo (a troca de rota fecha o #dlg sem perguntar)');
    assert.equal(await a.js('document.querySelector("[name=name]").value'), 'Digitado e não salvo', 'o que foi digitado continua no campo');
    assert.equal(await a.js('location.hash'), '#disparo-automatico', 'esta aba continua na mesma rota');
    assert.deepEqual(await a.js('window.__conf'), [], 'e nada perguntou nem descartou');
  } finally { // a aba que o link abriu não pode sobrar no Chrome de teste
    for (const id of await abas()) if (!antes.has(id)) await fetch(`http://127.0.0.1:${chrome.porta}/json/close/${id}`).catch(() => {});
  }
});

test('R6: sem etiqueta cadastrada e sem grupos carregados, os links "Conexões" e "Números de WhatsApp" do formulário abrem em outra aba', NAV, async (t) => {
  const a = await abrirFormulario(t);
  assert.equal(await refazerFormulario(a, 'S.tags = []; S.groups = []'), 1, 'o formulário foi refeito');
  const links = await a.js(LINKS_INTERNOS);
  const hrefs = links.map((l) => l.href);
  assert.ok(hrefs.includes('#conexoes') && hrefs.includes('#numeros'), `pré-condição: sem etiqueta e sem grupos o formulário mostra os dois links (achou: ${hrefs.join(', ')})`);
  assert.deepEqual(linksRuins(links), []);
});

test('R6: fonte Catálogo com o catálogo desconectado e a tag da Amazon ausente: os links "Conexões" dos avisos abrem em outra aba (e continuam assim depois de repintar)', NAV, async (t) => {
  const a = await abrirFormulario(t);
  await refazerFormulario(a, "S.st.catalogo = { estado: 'nao_configurada', tag_amazon: false }", REGRA_CATALOGO_AMAZON);
  await a.esperar("document.querySelectorAll('#dlg .fc-conexao a[href=\"#conexoes\"]').length === 1 && document.querySelectorAll('#dlg .fc-avisos a[href=\"#conexoes\"]').length === 1");
  let links = await a.js(LINKS_INTERNOS);
  assert.ok(links.filter((l) => l.href === '#conexoes').length >= 2, 'pré-condição: aviso de catálogo desconectado e aviso de tag da Amazon, com um link cada');
  assert.deepEqual(linksRuins(links), [], 'logo depois de abrir');
  // os avisos são repintados a cada mudança de loja (fcatAtualizar): o atributo tem de sair junto do HTML novo
  await a.js("window.__velho = document.querySelector('#dlg .fc-avisos a')");
  await a.js("document.querySelector('#dlg .fc-lojas input[value=shopee]').click(); document.querySelector('#dlg .fc-lojas input[value=shopee]').click()");
  assert.equal(await a.js('window.__velho.isConnected'), false, 'pré-condição: o clique nas lojas repintou os avisos (o link antigo saiu do DOM)');
  links = await a.js(LINKS_INTERNOS);
  assert.ok(links.filter((l) => l.href === '#conexoes').length >= 2, 'pré-condição: os avisos foram repintados e os links continuam lá');
  assert.deepEqual(linksRuins(links), [], 'depois de repintar os avisos');
});
