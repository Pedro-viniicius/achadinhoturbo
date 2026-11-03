// QA da entrega 2 (Equipe, etapas 7 e 12 do plano disparos-comunicacao-conta; contrato em
// docs/produto/planos/entrega2-contrato.md): o painel de verdade contra o servidor de verdade.
// public/index.html (com todos os scripts, na ordem do HTML), login.html + login.js e convite.html + convite.js rodam
// num contexto vm com um DOM mínimo (parser de HTML, seletores simples, eventos que borbulham) e um fetch que fala com
// o servidor real em porta aleatória, guardando o cookie de sessão como um navegador. Cada "navegador" tem o seu
// cookie: Dono e Operador em navegadores diferentes, como na vida real. WhatsApp simulado e links falsos: nenhum
// teste acessa a rede. Prova de ponta a ponta o que os dois devs fizeram em paralelo a partir do contrato.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(RAIZ, 'public');
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-eqqa-')); pastas.push(p); return p; };

const SENHA = 'senha-de-teste-123';
const SO_DONO = 'Só o Dono pode fazer isso.';
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================================================================
// DOM mínimo: o bastante para as telas de Equipe, login e convite (e o resto do painel não quebrar ao abrir).
// =====================================================================================================================
const VAZIOS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const CRUS = new Set(['script', 'style', 'textarea', 'title']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decod = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));
const escT = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escA = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

class No {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; this.ouvintes = new Map(); }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument; }
  get nextElementSibling() {
    const irmaos = this.parentNode?.childNodes || [];
    for (let i = irmaos.indexOf(this) + 1; i < irmaos.length; i++) if (irmaos[i].nodeType === 1) return irmaos[i];
    return null;
  }
  get nextSibling() { const irmaos = this.parentNode?.childNodes || []; return irmaos[irmaos.indexOf(this) + 1] || null; }
  _soltar() { const p = this.parentNode; if (p) { p.childNodes.splice(p.childNodes.indexOf(this), 1); this.parentNode = null; } }
  remove() { this._soltar(); this.ownerDocument._conferirFoco(); }
  appendChild(n) { n._soltar(); this.childNodes.push(n); n.parentNode = this; return n; }
  insertBefore(n, ref) {
    if (ref == null) return this.appendChild(n);
    if (ref.parentNode !== this) throw new Error('NotFoundError: insertBefore com referência que não é filho');
    if (n === ref) return n;
    n._soltar(); this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); n.parentNode = this; return n;
  }
  removeChild(n) { if (n.parentNode !== this) throw new Error('NotFoundError: removeChild'); n.remove(); return n; }
  addEventListener(tipo, fn) { if (!this.ouvintes.has(tipo)) this.ouvintes.set(tipo, []); this.ouvintes.get(tipo).push(fn); }
  removeEventListener(tipo, fn) { const l = this.ouvintes.get(tipo) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { const alts = compilar(sel); const out = []; (function anda(n) { for (const f of n.childNodes) if (f.nodeType === 1) { if (alts.some((seq) => casaSeq(f, seq))) out.push(f); anda(f); } })(this); return out; }
}

class Texto extends No {
  constructor(doc, t) { super(doc); this.nodeType = 3; this.data = t; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get outerHTML() { return escT(this.data); }
}

const ATRIB_BOOL = { hidden: 'hidden', disabled: 'disabled', readOnly: 'readonly', required: 'required', open: 'open', multiple: 'multiple' };
class Elemento extends No {
  constructor(doc, tag, attrs = []) {
    super(doc);
    this.nodeType = 1; this.localName = tag; this.tagName = tag.toUpperCase(); this.nodeName = this.tagName;
    this.atributos = new Map(attrs); this.style = {}; this._valor = undefined; this._marcado = undefined;
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => (typeof k === 'string' ? el.getAttribute('data-' + kebab(k)) ?? undefined : undefined),
      set: (_, k, v) => { el.setAttribute('data-' + kebab(String(k)), v); return true; },
      has: (_, k) => el.hasAttribute('data-' + kebab(String(k))),
    });
    const cls = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    this.classList = {
      contains: (c) => cls().includes(c),
      add: (...cs) => el.setAttribute('class', [...new Set([...cls(), ...cs])].join(' ')),
      remove: (...cs) => el.setAttribute('class', cls().filter((x) => !cs.includes(x)).join(' ')),
      toggle: (c, forca) => { const on = forca ?? !cls().includes(c); if (on) el.classList.add(c); else el.classList.remove(c); return on; },
    };
    for (const [prop, attr] of Object.entries(ATRIB_BOOL)) {
      Object.defineProperty(this, prop, { get: () => el.hasAttribute(attr), set: (v) => (v ? el.setAttribute(attr, '') : el.removeAttribute(attr)), enumerable: true });
    }
  }
  getAttribute(k) { k = k.toLowerCase(); return this.atributos.has(k) ? this.atributos.get(k) : null; }
  setAttribute(k, v) { this.atributos.set(k.toLowerCase(), String(v)); }
  removeAttribute(k) { this.atributos.delete(k.toLowerCase()); }
  hasAttribute(k) { return this.atributos.has(k.toLowerCase()); }
  toggleAttribute(k, f) { const on = f ?? !this.hasAttribute(k); if (on) this.setAttribute(k, ''); else this.removeAttribute(k); return on; }
  get id() { return this.getAttribute('id') || ''; } set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; } set className(v) { this.setAttribute('class', v); }
  get name() { return this.getAttribute('name') || ''; }
  get placeholder() { return this.getAttribute('placeholder') || ''; } set placeholder(v) { this.setAttribute('placeholder', v); }
  get type() { return this.getAttribute('type') || (this.localName === 'button' ? 'submit' : this.localName === 'input' ? 'text' : ''); }
  set type(v) { this.setAttribute('type', v); }
  get value() {
    if (this._valor !== undefined) return this._valor;
    if (this.localName === 'select') { const ops = this.querySelectorAll('option'); const o = ops.find((x) => x.hasAttribute('selected')) || ops[0]; return o ? o.value : ''; }
    if (this.localName === 'textarea') return this.textContent;
    if (this.localName === 'option') return this.getAttribute('value') ?? this.textContent;
    return this.getAttribute('value') ?? '';
  }
  set value(v) { this._valor = String(v); }
  get checked() { return this._marcado ?? this.hasAttribute('checked'); } set checked(v) { this._marcado = !!v; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; if (String(v ?? '')) this.appendChild(new Texto(this.ownerDocument, String(v))); this.ownerDocument._conferirFoco(); }
  get innerHTML() { return this.childNodes.map((n) => n.outerHTML).join(''); }
  set innerHTML(html) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; parsearHtml(this.ownerDocument, String(html ?? ''), this); this.ownerDocument._conferirFoco(); }
  get outerHTML() {
    const a = [...this.atributos].map(([k, v]) => ` ${k}="${escA(v)}"`).join('');
    if (VAZIOS.has(this.localName)) return `<${this.localName}${a}>`;
    return `<${this.localName}${a}>${CRUS.has(this.localName) ? this.textContent : this.innerHTML}</${this.localName}>`;
  }
  insertAdjacentHTML(pos, html) {
    const t = new Elemento(this.ownerDocument, 'template'); parsearHtml(this.ownerDocument, html, t);
    for (const n of [...t.childNodes]) {
      if (pos === 'beforeend') this.appendChild(n);
      else if (pos === 'afterbegin') this.insertBefore(n, this.childNodes[0] || null);
      else if (pos === 'beforebegin') this.parentNode.insertBefore(n, this);
      else if (pos === 'afterend') this.parentNode.insertBefore(n, this.nextSibling);
    }
  }
  matches(sel) { return compilar(sel).some((seq) => casaSeq(this, seq)); }
  closest(sel) { const alts = compilar(sel); for (let n = this; n?.nodeType === 1; n = n.parentNode) if (alts.some((seq) => casaSeq(n, seq))) return n; return null; }
  focus() { this.ownerDocument.activeElement = this; this.onfocus?.({ type: 'focus', target: this }); }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  select() { this.selecionado = true; }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  reset() { for (const c of this.querySelectorAll('input, select, textarea')) { c._valor = undefined; c._marcado = undefined; } }
  get elements() { return { namedItem: (n) => this.querySelector(`[name="${n}"]`) }; }
  click() { return disparar(this, 'click'); }
}

class Documento extends No {
  constructor() { super(null); this.ownerDocument = this; this.nodeType = 9; this.activeElement = null; }
  get documentElement() { return this.childNodes.find((n) => n.nodeType === 1); }
  get body() { return this.querySelector('body'); }
  getElementById(id) { return this.querySelectorAll('[id]').find((e) => e.id === id) || null; }
  createElement(tag) { return new Elemento(this, String(tag).toLowerCase()); }
  _conferirFoco() { if (this.activeElement && !this.activeElement.isConnected) this.activeElement = this.body; }
  get isConnected() { return true; }
}

function parsearHtml(doc, html, pai) {
  const pilha = [pai];
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>|[^<]+|</g;
  let m;
  while ((m = re.exec(html))) {
    const topo = pilha[pilha.length - 1];
    if (m[0].startsWith('<!')) continue;
    if (m[1]) {
      const t = m[1].toLowerCase();
      for (let i = pilha.length - 1; i > 0; i--) if (pilha[i].localName === t) { pilha.length = i; break; }
      continue;
    }
    if (m[2]) {
      const t = m[2].toLowerCase(); const attrs = [];
      const ra = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g; let a;
      while ((a = ra.exec(m[3] || ''))) attrs.push([a[1].toLowerCase(), decod(a[2] ?? a[3] ?? a[4] ?? '')]);
      const el = topo.appendChild(new Elemento(doc, t, attrs));
      if (VAZIOS.has(t)) continue;
      if (CRUS.has(t)) {
        const fim = html.toLowerCase().indexOf(`</${t}`, re.lastIndex); const ate = fim < 0 ? html.length : fim;
        const cru = html.slice(re.lastIndex, ate);
        if (cru) el.appendChild(new Texto(doc, t === 'textarea' || t === 'title' ? decod(cru) : cru));
        re.lastIndex = ate; continue;
      }
      pilha.push(el); continue;
    }
    topo.appendChild(new Texto(doc, decod(m[0])));
  }
}

// ---------- seletores: tag, #id, .classe, [attr], [attr=v], [attr="v"], :checked, :disabled, :not(), ' ' e '>' ----------
const cacheSel = new Map();
function compilar(sel) {
  if (cacheSel.has(sel)) return cacheSel.get(sel);
  const alts = dividir(sel, ',').map((alt) => {
    const toks = []; let atual = ''; let prof = 0; let aspas = null;
    const fecha = () => { if (atual) { toks.push(atual); atual = ''; } };
    for (const ch of alt.trim()) {
      if (aspas) { atual += ch; if (ch === aspas) aspas = null; continue; }
      if (ch === '"' || ch === "'") { aspas = ch; atual += ch; continue; }
      if (ch === '[' || ch === '(') prof++; if (ch === ']' || ch === ')') prof--;
      if (!prof && /[\s>]/.test(ch)) { fecha(); toks.push(ch === '>' ? '>' : ' '); continue; }
      atual += ch;
    }
    fecha();
    const seq = []; let comb = null;
    for (const t of toks) {
      if (t === '>') comb = '>'; else if (t === ' ') { if (comb !== '>') comb = ' '; } else { seq.push({ comb: seq.length ? comb : null, comp: compor(t) }); comb = null; }
    }
    return seq;
  });
  cacheSel.set(sel, alts); return alts;
}
function dividir(s, sep) {
  const out = []; let atual = ''; let prof = 0; let aspas = null;
  for (const ch of s) {
    if (aspas) { atual += ch; if (ch === aspas) aspas = null; continue; }
    if (ch === '"' || ch === "'") aspas = ch;
    if (ch === '[' || ch === '(') prof++; if (ch === ']' || ch === ')') prof--;
    if (!prof && ch === sep) { out.push(atual); atual = ''; continue; }
    atual += ch;
  }
  out.push(atual); return out;
}
function compor(t) {
  const c = { tag: null, ids: [], classes: [], attrs: [], pseudos: [] };
  const mt = /^(\*|[a-zA-Z][\w-]*)/.exec(t); let resto = t;
  if (mt) { c.tag = mt[1].toLowerCase(); resto = t.slice(mt[1].length); }
  const re = /#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]|:([\w-]+)(?:\(((?:[^()]|\([^()]*\))*)\))?/gy;
  let m;
  while (re.lastIndex < resto.length && (m = re.exec(resto))) {
    if (m[1]) c.ids.push(m[1]); else if (m[2]) c.classes.push(m[2]);
    else if (m[3]) c.attrs.push({ nome: m[3].toLowerCase(), op: m[4] || null, valor: m[5] ?? m[6] ?? m[7] ?? null });
    else if (m[8]) c.pseudos.push({ nome: m[8], arg: m[9] });
  }
  if (re.lastIndex !== resto.length && resto.length) throw new Error(`seletor não suportado pelo DOM do teste: ${t}`);
  return c;
}
function casaComp(el, c) {
  if (c.tag && c.tag !== '*' && el.localName !== c.tag) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.nome); if (v == null) return false;
    if (a.op === '=' && v !== a.valor) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.valor)) return false;
    if (a.op === '^=' && !v.startsWith(a.valor)) return false;
    if (a.op === '$=' && !v.endsWith(a.valor)) return false;
    if (a.op === '*=' && !v.includes(a.valor)) return false;
  }
  for (const p of c.pseudos) {
    if (p.nome === 'checked') { if (!el.checked) return false; } else if (p.nome === 'disabled') { if (!el.disabled) return false; } else if (p.nome === 'not') { if (el.matches(p.arg)) return false; } else return false; // :popover-open e afins
  }
  return true;
}
function casaSeq(el, seq, i = seq.length - 1) {
  if (!casaComp(el, seq[i].comp)) return false;
  if (i === 0) return true;
  let p = el.parentNode;
  if (seq[i].comb === '>') return p?.nodeType === 1 && casaSeq(p, seq, i - 1);
  for (; p && p.nodeType === 1; p = p.parentNode) if (casaSeq(p, seq, i - 1)) return true;
  return false;
}

/** Evento que borbulha do alvo até o documento e a janela. Espera os tratadores assíncronos. Clique em botão submit envia o form. */
async function disparar(alvo, tipo, extra = {}) {
  const doc = alvo.ownerDocument;
  const ev = { type: tipo, target: alvo, defaultPrevented: false, parado: false, key: '', preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.parado = true; }, ...extra };
  const caminho = []; for (let n = alvo; n; n = n.parentNode) caminho.push(n);
  if (doc.janela) caminho.push(doc.janela);
  const rs = [];
  for (const n of caminho) {
    ev.currentTarget = n;
    if (typeof n['on' + tipo] === 'function') rs.push(n['on' + tipo](ev));
    for (const fn of n.ouvintes?.get(tipo) || []) rs.push(fn(ev));
    if (ev.parado) break;
  }
  await Promise.all(rs);
  if (tipo === 'click' && !ev.defaultPrevented && alvo.localName === 'button' && alvo.type === 'submit') {
    const f = alvo.closest('form'); if (f) await disparar(f, 'submit');
  }
  return ev;
}

// =====================================================================================================================
// Servidor de verdade e "navegadores" com cookie
// =====================================================================================================================
function req(port, caminho, { method = 'GET', headers = {}, raw } = {}) {
  return new Promise((ok, err) => {
    const h = { ...(raw ? { 'content-length': raw.length } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, headers: res.headers, json, txt }); });
    });
    r.on('error', err); if (raw) r.write(raw); r.end();
  });
}

function guardarCookie(jar, linha) {
  const [par, ...attrs] = String(linha).split(';'); const i = par.indexOf('=');
  const nome = par.slice(0, i).trim(); const valor = par.slice(i + 1).trim();
  const a = Object.fromEntries(attrs.map((x) => { const j = x.indexOf('='); return j < 0 ? [x.trim().toLowerCase(), true] : [x.slice(0, j).trim().toLowerCase(), x.slice(j + 1).trim()]; }));
  const morto = !valor || (a['max-age'] != null && Number(a['max-age']) <= 0) || (a.expires && Date.parse(a.expires) <= Date.now());
  if (morto) jar.delete(nome); else jar.set(nome, valor);
}

/** Um navegador: cookie próprio, área de transferência, confirm() e o histórico de pedidos e de navegação. */
function criarNavegador(port) {
  const base = `http://127.0.0.1:${port}`;
  const jar = new Map(); const pendentes = new Set();
  const nav = {
    jar, pedidos: [], navegou: [], clipboard: [], comClipboard: true, confirmacoes: [], confirmar: () => true, fechado: false,
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    fetch(url, opts = {}) {
      if (nav.fechado) return new Promise(() => {}); // depois do teste, a tela não fala mais com ninguém
      const u = new URL(String(url), base + '/');
      const method = String(opts.method || 'GET').toUpperCase();
      const headers = { ...(opts.headers || {}) };
      if (jar.size) headers.cookie = nav.cookie();
      if (!['GET', 'HEAD'].includes(method)) headers.origin = base; // o navegador manda Origin em POST/PUT/DELETE
      const corpo = opts.body == null ? null : String(opts.body);
      nav.pedidos.push({ method, caminho: u.pathname + u.search, corpo: corpo ? JSON.parse(corpo) : null });
      const p = req(port, u.pathname + u.search, { method, headers, raw: corpo == null ? undefined : Buffer.from(corpo) }).then((r) => {
        for (const c of [].concat(r.headers['set-cookie'] || [])) guardarCookie(jar, c);
        return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => { if (r.json == null) throw new SyntaxError('sem JSON'); return r.json; }, text: async () => r.txt };
      });
      pendentes.add(p); p.finally(() => pendentes.delete(p)).catch(() => {});
      return p;
    },
    /** Espera a tela parar de pedir coisas ao servidor (e os tratadores que vêm depois). */
    async assentar() {
      for (let i = 0; i < 400; i++) {
        if (pendentes.size) { await Promise.allSettled([...pendentes]); continue; }
        await dorme(4); if (!pendentes.size) { await dorme(4); if (!pendentes.size) return; }
      }
      throw new Error('a tela não parou de pedir');
    },
    /** Chamada direta à API com o cookie deste navegador (para montar o cenário). */
    async api(caminho, method = 'GET', body) {
      const r = await nav.fetch('/api' + caminho, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    pedidosPara: (caminho, method) => nav.pedidos.filter((x) => x.caminho === caminho && (!method || x.method === method)),
  };
  return nav;
}

/** Servidor em porta aleatória. senha = PANEL_PASSWORD (vazia: painel sem login, o caso atual do dono). */
async function subir({ senha = '' } = {}) {
  const dir = tmp(); const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true, dir });
  const app = buildApp({ db, wa, links, scheduler, publicHost: '', panelPassword: senha, dataDir: dir });
  const server = await new Promise((ok) => { const sv = app.listen(0, '127.0.0.1', () => ok(sv)); });
  const port = server.address().port; const navs = [];
  return {
    db, dir, port, auth: app.locals.auth,
    navegador: () => { const n = criarNavegador(port); navs.push(n); return n; },
    fechar: () => new Promise((r) => { for (const n of navs) n.fechado = true; server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }),
  };
}

/**
 * Abre uma página de public/ no navegador `nav`: monta o DOM a partir do HTML e roda os <script src> na ordem.
 * → { $, $$, doc, location, avisos (toasts), rodar(código), rodarJson(expr), clicar, enviar, irPara, tique }
 */
async function abrir(nav, arquivo, { hash = '' } = {}) {
  const doc = new Documento(); parsearHtml(doc, fs.readFileSync(path.join(PUB, arquivo), 'utf8'), doc); doc.activeElement = doc.body;
  const janela = new No(doc); doc.janela = janela;
  const avisos = []; const intervalos = [];
  const location = { hash, pathname: '/' + arquivo, replace: (u) => nav.navegou.push(String(u)), reload: () => nav.navegou.push('reload'), assign: (u) => nav.navegou.push(String(u)) };
  const ctx = {
    document: doc, location, console,
    history: { replaceState: (_s, _t, u) => { if (String(u).startsWith('#')) location.hash = String(u); }, pushState: (_s, _t, u) => { if (String(u).startsWith('#')) location.hash = String(u); } },
    navigator: { get clipboard() { return nav.comClipboard ? { writeText: async (t) => { nav.clipboard.push(String(t)); } } : undefined; }, userAgent: 'qa' },
    fetch: (...a) => nav.fetch(...a),
    confirm: (m) => { nav.confirmacoes.push(String(m)); return nav.confirmar(String(m)); }, alert: () => {},
    setTimeout: (fn, ms, ...a) => { const t = setTimeout(() => { if (!nav.fechado) fn(...a); }, ms); t.unref(); return t; }, clearTimeout,
    setInterval: (fn, ms) => { intervalos.push({ fn, ms }); return intervalos.length; }, clearInterval: () => {},
    addEventListener: (t, fn) => janela.addEventListener(t, fn), removeEventListener: (t, fn) => janela.removeEventListener(t, fn),
    CSS: { escape: (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c) },
    innerWidth: 1280, innerHeight: 800, __avisos: avisos,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const s of doc.querySelectorAll('script[src]')) {
    const src = s.getAttribute('src');
    vm.runInContext(fs.readFileSync(path.join(PUB, src), 'utf8'), ctx, { filename: `public/${src}` });
  }
  // toasts: guarda todos, não só o último que ficou no #toast
  vm.runInContext("if (typeof aviso === 'function') { const __orig = aviso; aviso = (msg, erro = false) => { __avisos.push({ msg: String(msg), erro: !!erro }); return __orig(msg, erro); }; }", ctx);
  await nav.assentar();
  const pegar = (x) => (typeof x === 'string' ? doc.querySelector(x) : x);
  const p = {
    doc, location, avisos, intervalos,
    $: (s) => doc.querySelector(s), $$: (s) => doc.querySelectorAll(s),
    texto: (s = '#pagina') => doc.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    rodar: (c) => vm.runInContext(c, ctx),
    rodarJson: (expr) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx) ?? 'null'),
    async clicar(x) {
      const el = pegar(x); assert.ok(el, `existe na tela: ${x}`); assert.equal(el.disabled, false, `habilitado: ${x}`);
      await disparar(el, 'click'); await nav.assentar();
    },
    async enviar(x) { const f = pegar(x); assert.ok(f, `existe na tela: ${x}`); await disparar(f, 'submit'); await nav.assentar(); },
    async irPara(h) { location.hash = h; for (const fn of janela.ouvintes.get('hashchange') || []) await fn({ type: 'hashchange' }); await nav.assentar(); },
    /** O "a cada 3 s" do painel (setInterval de atualizarEstado), na hora em que o teste quer. */
    async tique() { const it = intervalos.find((i) => i.ms === 3000); assert.ok(it, 'o painel atualiza o estado a cada 3 s'); await it.fn(); await nav.assentar(); },
  };
  return p;
}

/** Preenche campos `[name=…]` dentro de `raiz`. */
function preencher(raiz, campos) {
  for (const [nome, v] of Object.entries(campos)) { const el = raiz.querySelector(`[name=${nome}]`); assert.ok(el, `campo ${nome}`); el.value = v; }
}
/** O que mostrarErros (app.js) listou dentro de `raiz`. */
const errosDe = (raiz) => raiz.querySelectorAll('.erros li').map((li) => li.textContent);
const tokenDe = (link) => String(link).split('#')[1];

/** Console do servidor e das telas, para o CA10. */
function capturarConsole(t) {
  const saida = [];
  for (const m of ['log', 'info', 'warn', 'error']) t.mock.method(console, m, (...a) => saida.push(a.map(String).join(' ')));
  return saida;
}
/** CA10: nenhum e-mail no Histórico (tabela log) nem no console. */
function semEmailNoLog(s, saida) {
  const log = s.db.prepare('SELECT * FROM log').all().map((r) => JSON.stringify(r)).join('\n');
  assert.ok(!log.includes('@'), `e-mail no log: ${log}`);
  assert.ok(!saida.join('\n').includes('@'), `e-mail no console: ${saida.join(' | ')}`);
}

/** Painel sem login → "Ativar login" pela API num navegador novo → navegador do Dono, já com cookie. */
async function donoAtivo(s, { nome = 'Ana', email = 'ana@exemplo.com', senha = SENHA } = {}) {
  const nav = s.navegador();
  const r = await nav.api('/equipe/ativar', 'POST', { nome, email, senha });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return nav;
}
/** O Dono cria o convite (API) e a pessoa aceita num navegador próprio (API). → { nav, id, token, senha } */
async function convidado(s, dono, { email, papel = 'operador', nome, senha = `senha-de-${email.split('@')[0]}-1` }) {
  const c = await dono.api('/equipe/convites', 'POST', { email, papel });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const nav = s.navegador(); const token = tokenDe(c.json.link);
  const a = await nav.api('/convite/aceitar', 'POST', { token, nome, senha });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  return { nav, id: s.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id, token, senha };
}
/** A linha da tabela com `data-id`, dentro da lista (#eq-pes-h ou #eq-cvs-h). */
const linhaDe = (p, titulo, id) => p.$(`#eq-listas`).querySelectorAll('section').find((sec) => sec.querySelector(titulo))?.querySelector(`tr[data-id="${id}"]`) || null;

// =====================================================================================================================
// CA7: o dono atual (painel sem senha) protege o painel e vira Dono
// =====================================================================================================================
test('CA7 sem senha: Equipe mostra só "Proteja o painel"; "Ativar login" manda o contrato, deixa este navegador entrado e a tela volta como Dono', async (t) => {
  const saida = capturarConsole(t);
  const s = await subir();
  try {
    const nav = s.navegador();
    const p = await abrir(nav, 'index.html', { hash: '#equipe' });
    assert.equal(p.location.hash, '#equipe', 'sem login o painel é do Dono: a rota Equipe abre');
    assert.ok(p.$('#rail nav a[href="#equipe"]'), 'item Equipe no menu');
    assert.equal(p.$('#sair').hidden, true, 'sem login não há "Sair"'); assert.equal(p.$('#pessoa').hidden, true);
    const f = p.$('#eq-ativar'); assert.ok(f, 'card "Proteja o painel"');
    assert.match(p.texto(), /Proteja o painel/);
    assert.match(p.texto(), /Depois disso o painel pede login\. Você continua conectado neste navegador\./);
    assert.equal(p.$('#eq-convidar'), null, 'sem login, só o card de ativar');
    assert.equal(nav.pedidosPara('/api/equipe').length, 0, 'nem chega a pedir a lista');
    // validação no navegador: nada vai ao servidor
    preencher(f, { nome: '', email: 'ana@exemplo', senha: 'curta', confirma: 'curta' });
    await p.enviar(f);
    assert.deepEqual(errosDe(f), ['Escreva o seu nome.', 'Escolha um e-mail válido.', 'A senha precisa de ao menos 8 caracteres.']);
    preencher(f, { nome: 'Ana', email: 'ana@exemplo.com', senha: SENHA, confirma: SENHA + 'x' });
    await p.enviar(f);
    assert.deepEqual(errosDe(f), ['As senhas não são iguais.']);
    assert.equal(nav.pedidosPara('/api/equipe/ativar').length, 0);
    assert.equal(s.auth.enabled(), false);
    // ativa
    preencher(f, { nome: '  Ana  ', email: ' ana@exemplo.com ', senha: SENHA, confirma: SENHA });
    await p.enviar(f);
    const [ped] = nav.pedidosPara('/api/equipe/ativar');
    assert.deepEqual(ped.corpo, { nome: 'Ana', email: 'ana@exemplo.com', senha: SENHA }, 'contrato: { nome, email, senha }, sem a confirmação');
    assert.match(nav.cookie(), /^sid=[a-f0-9]{64}$/, 'a resposta deixou este navegador entrado');
    assert.ok(p.avisos.some((a) => a.msg === 'Login ativado' && !a.erro), JSON.stringify(p.avisos));
    // a tela voltou como Dono, sem recarregar a página
    assert.equal(p.location.hash, '#equipe');
    assert.equal(p.$('#eq-pes-h')?.textContent, 'Pessoas (1)');
    assert.ok(p.$('#eq-convidar'), 'agora "Convidar pessoa"');
    const ana = linhaDe(p, '#eq-pes-h', 1);
    assert.ok(ana, 'linha da Ana');
    assert.match(ana.textContent, /Ana/); assert.match(ana.textContent, /você/); assert.match(ana.textContent, /ana@exemplo\.com/);
    assert.match(ana.textContent, /Último Dono/, 'a própria linha (último Dono) sem Remover nem troca de papel');
    assert.equal(ana.querySelectorAll('button').length, 0);
    assert.equal(p.$('#sair').hidden, false, '"Sair" aparece'); assert.equal(p.$('#pessoa').hidden, false);
    assert.match(p.texto('#pessoa'), /Ana/);
    assert.equal(p.rodarJson('S.st.usuario.papel'), 'dono');
    // outro navegador, sem o cookie: agora o painel pede login, e o login é por e-mail
    const outro = s.navegador();
    await abrir(outro, 'index.html');
    assert.ok(outro.navegou.includes('/login.html'), `foi para o login: ${outro.navegou}`);
    const l = await abrir(outro, 'login.html');
    assert.equal(l.$('#campo-email').hidden, false); assert.equal(l.$('#sub').textContent, 'Seus achadinhos chegam primeiro.');
    l.$('#email').value = 'ana@exemplo.com'; l.$('#senha').value = SENHA;
    await l.enviar('#f');
    assert.deepEqual(outro.pedidosPara('/api/login').at(-1).corpo, { email: 'ana@exemplo.com', senha: SENHA });
    assert.equal(outro.navegou.at(-1), '/');
    semEmailNoLog(s, saida);
  } finally { await s.fechar(); }
});

// =====================================================================================================================
// CA7: quem já tinha senha (legado) entra só com ela e completa o cadastro
// =====================================================================================================================
test('CA7 legado: login só com a senha; "Complete seu cadastro" volta a cada carga até salvar; PUT /api/me leva o login ao modo e-mail', async (t) => {
  const saida = capturarConsole(t);
  const s = await subir({ senha: SENHA }); // PANEL_PASSWORD: hash da senha única → migração → Dono sem e-mail
  try {
    const nav = s.navegador();
    const l = await abrir(nav, 'login.html');
    assert.deepEqual(nav.navegou, [], 'sem sessão, fica no login');
    // legado: o e-mail fica à mostra, mas opcional (em branco, entra a conta sem e-mail; quem entrou por convite usa o dele, Q1)
    assert.equal(l.$('#campo-email').hidden, false, 'legado: campo de e-mail à mostra');
    assert.equal(l.$('#email').disabled, false); assert.equal(l.$('#email').required, false, 'legado: e-mail opcional');
    assert.equal(l.$('#rotulo-email').textContent, 'E-mail (opcional)');
    assert.equal(l.$('#dica-email').hidden, false); assert.match(l.$('#dica-email').textContent, /Deixe em branco se você usa a senha da instalação\./);
    assert.equal(l.$('#sub').textContent, 'Use a senha definida na instalação.');
    l.$('#senha').value = 'errada-123';
    await l.enviar('#f');
    assert.equal(l.$('#erro').hidden, false); assert.equal(l.$('#erro').textContent, 'E-mail ou senha incorretos.', 'a mensagem do servidor, como vem');
    l.$('#senha').value = SENHA;
    await l.enviar('#f');
    assert.deepEqual(nav.pedidosPara('/api/login').at(-1).corpo, { senha: SENHA }, 'legado manda só a senha');
    assert.deepEqual(nav.navegou, ['/']);

    // o painel abre o diálogo, que não bloqueia: "Depois" fecha sem salvar
    const p = await abrir(nav, 'index.html');
    const dlg = p.$('#dlg');
    assert.equal(dlg.open, true, '"Complete seu cadastro" aberto');
    assert.match(dlg.textContent, /Complete seu cadastro/);
    const cad = p.$('#eq-cadastro');
    assert.equal(cad.querySelector('[name=nome]').value, '', 'o "Dono" da migração não vem como nome');
    await p.clicar('#eq-depois');
    assert.equal(dlg.open, false);
    assert.equal(nav.pedidosPara('/api/me').length, 0);
    await p.irPara('#templates');
    assert.match(p.texto(), /Templates?/, 'o resto do painel funciona');

    // na próxima carga ele volta
    const p2 = await abrir(nav, 'index.html');
    assert.equal(p2.$('#dlg').open, true, 'volta a cada carga até completar');
    const cad2 = p2.$('#eq-cadastro');
    preencher(cad2, { nome: 'Ana', email: 'Ana@Exemplo.com', senha: 'nova-senha-da-ana', confirma: 'outra-coisa-123' });
    await p2.enviar(cad2);
    assert.deepEqual(errosDe(cad2), ['As senhas não são iguais.']);
    assert.equal(nav.pedidosPara('/api/me').length, 0);
    preencher(cad2, { senha: '', confirma: '' });
    await p2.enviar(cad2);
    const [me] = nav.pedidosPara('/api/me', 'PUT');
    assert.deepEqual(me.corpo, { nome: 'Ana', email: 'Ana@Exemplo.com' }, 'sem senha nova, o campo nem vai');
    assert.equal(p2.$('#dlg').open, false);
    assert.ok(p2.avisos.some((a) => a.msg === 'Cadastro completo' && !a.erro), JSON.stringify(p2.avisos));
    assert.match(p2.texto('#pessoa'), /Ana.*ana@exemplo\.com/, 'nome e e-mail no menu');
    assert.equal(p2.rodarJson('S.st.usuario.precisa_completar'), false);

    // não volta mais
    const p3 = await abrir(nav, 'index.html');
    assert.equal(p3.$('#dlg').open, false);

    // o login agora pede e-mail; sem e-mail, o erro é local
    const nav2 = s.navegador();
    const l2 = await abrir(nav2, 'login.html');
    assert.equal(l2.$('#campo-email').hidden, false); assert.equal(l2.$('#email').disabled, false);
    assert.equal(l2.$('#email').required, true); assert.equal(l2.$('#rotulo-email').textContent, 'E-mail'); assert.equal(l2.$('#dica-email').hidden, true);
    assert.equal(l2.$('#sub').textContent, 'Seus achadinhos chegam primeiro.');
    l2.$('#senha').value = SENHA;
    await l2.enviar('#f');
    assert.equal(l2.$('#erro').textContent, 'Digite o seu e-mail.'); assert.equal(nav2.pedidosPara('/api/login').length, 0);
    l2.$('#email').value = 'ana@exemplo.com';
    await l2.enviar('#f');
    assert.equal(nav2.navegou.at(-1), '/', 'entra com e-mail + a senha de antes');
    semEmailNoLog(s, saida);
  } finally { await s.fechar(); }
});

test('CA7 legado: "Complete seu cadastro" com e-mail de outra pessoa mostra o 409 do servidor e o diálogo fica aberto', async () => {
  const s = await subir({ senha: SENHA });
  try {
    const nav = s.navegador();
    assert.equal((await nav.api('/login', 'POST', { senha: SENHA })).status, 200);
    await convidado(s, nav, { email: 'bia@exemplo.com', nome: 'Bia' });
    const p = await abrir(nav, 'index.html');
    const cad = p.$('#eq-cadastro');
    preencher(cad, { nome: 'Ana', email: 'BIA@exemplo.com' });
    await p.enviar(cad);
    assert.deepEqual(errosDe(cad), ['Este e-mail já está em uso.']);
    assert.equal(p.$('#dlg').open, true);
    assert.equal(p.$('#eq-cad-salvar').disabled, false, 'o botão volta para tentar de novo');
  } finally { await s.fechar(); }
});

// =====================================================================================================================
// CA7: convite de ponta a ponta (tela Equipe → link → convite.html → painel como Operador → login por e-mail)
// =====================================================================================================================
test('CA7 convite de ponta a ponta: o Dono cria na tela, o link abre convite.html, a pessoa cria a conta e cai no painel como Operador', async (t) => {
  const saida = capturarConsole(t);
  const s = await subir();
  try {
    const dono = await donoAtivo(s);
    const p = await abrir(dono, 'index.html', { hash: '#equipe' });
    // nome da conta
    p.$('#eq-conta [name=conta_nome]').value = '  Achadinhos da Ana ';
    await p.enviar('#eq-conta');
    assert.deepEqual(dono.pedidosPara('/api/equipe/conta').at(-1).corpo, { conta_nome: 'Achadinhos da Ana' });
    assert.ok(p.avisos.some((a) => a.msg === 'Nome da conta salvo'));
    // convite: e-mail inválido nem vai
    const f = p.$('#eq-convidar');
    preencher(f, { email: 'bia' });
    await p.enviar(f);
    assert.deepEqual(errosDe(f), ['Escolha um e-mail válido.']);
    assert.equal(dono.pedidosPara('/api/equipe/convites').length, 0);
    preencher(f, { email: 'bia@exemplo.com', papel: 'operador' });
    await p.enviar(f);
    assert.deepEqual(dono.pedidosPara('/api/equipe/convites').at(-1).corpo, { email: 'bia@exemplo.com', papel: 'operador' });
    assert.ok(p.avisos.some((a) => a.msg === 'Convite criado'));
    // o link aparece completo no bloco de sucesso, e só ali
    const link = p.$('#eq-criado-link')?.value;
    const m = String(link).match(new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/convite\\.html#([a-f0-9]{64})$`));
    assert.ok(m, `link do convite: ${link}`);
    const token = m[1];
    assert.match(p.texto('#eq-criado'), /Convite criado para bia@exemplo\.com\. Mande este link para a pessoa\. Ele só aparece completo agora/);
    assert.equal(f.querySelector('[name=email]').value, '', 'formulário limpo para o próximo');
    assert.equal(p.$('#eq-cvs-h').textContent, 'Convites pendentes (1)');
    const id = s.db.prepare('SELECT id FROM invites').get().id;
    const linha = linhaDe(p, '#eq-cvs-h', id);
    assert.ok(linha, 'linha do convite');
    assert.match(linha.textContent, /bia@exemplo\.com/); assert.match(linha.textContent, /convidado por Ana/); assert.match(linha.textContent, /Operador/);
    assert.equal(linha.querySelector('[data-eq=copiar]').getAttribute('aria-label'), 'Copiar link do convite de bia@exemplo.com');
    assert.ok(!p.$('#eq-listas').innerHTML.includes(token), 'a lista nunca mostra o link');
    await p.clicar('#eq-criado-copiar');
    assert.equal(dono.clipboard.at(-1), link, '"Copiar link" do bloco copia o link criado');
    assert.ok(p.avisos.some((a) => a.msg === 'Link do convite copiado'));
    assert.equal(dono.pedidosPara(`/api/equipe/convites/${id}/link`).length, 0, 'o do bloco não gira o token');

    // a pessoa abre o link
    const bia = s.navegador();
    const c = await abrir(bia, 'convite.html', { hash: '#' + token });
    assert.equal(c.$('#f').hidden, false, 'formulário à mostra');
    assert.equal(c.$('#carregando').hidden, true); assert.equal(c.$('#invalido').hidden, true); assert.equal(c.$('#falha').hidden, true);
    assert.deepEqual(bia.pedidosPara('/api/convite/info').map((x) => x.corpo), [{ token }], 'o token vai no corpo, nunca na URL');
    assert.equal(c.$('#quem').textContent, 'Achadinhos da Ana convidou você como Operador.');
    assert.equal(c.$('#email').value, 'bia@exemplo.com'); assert.ok(c.$('#email').hasAttribute('readonly'));
    // erros inline
    preencher(c.$('#f'), { nome: '  ', senha: 'curta', confirma: 'curta' });
    await c.enviar('#f');
    assert.equal(c.$('#erro-nome').hidden, false); assert.equal(c.$('#erro-nome').textContent, 'Escreva o seu nome.');
    assert.equal(c.$('#erro-senha').textContent, 'A senha precisa de ao menos 8 caracteres.');
    assert.equal(c.$('#nome').getAttribute('aria-invalid'), 'true');
    preencher(c.$('#f'), { nome: 'Bia', senha: 'senha-da-bia-1', confirma: 'senha-da-bia-2' });
    await c.enviar('#f');
    assert.equal(c.$('#erro-confirma').textContent, 'As senhas não são iguais.'); assert.equal(c.$('#erro-nome').hidden, true);
    assert.equal(bia.pedidosPara('/api/convite/aceitar').length, 0);
    // mostrar/ocultar vale para os dois campos
    await c.clicar('#ver-senha');
    assert.equal(c.$('#ver-senha').getAttribute('aria-pressed'), 'true');
    assert.equal(c.$('#senha').type, 'text'); assert.equal(c.$('#confirma').type, 'text');
    // aceita
    preencher(c.$('#f'), { confirma: 'senha-da-bia-1' });
    await c.enviar('#f');
    assert.deepEqual(bia.pedidosPara('/api/convite/aceitar').at(-1).corpo, { token, nome: 'Bia', senha: 'senha-da-bia-1' });
    assert.deepEqual(bia.navegou, ['/']);
    assert.match(bia.cookie(), /^sid=[a-f0-9]{64}$/);

    // painel da Bia: Operador
    const pb = await abrir(bia, 'index.html');
    assert.deepEqual(pb.rodarJson('S.st.usuario'), { id: 2, nome: 'Bia', email: 'bia@exemplo.com', papel: 'operador', precisa_completar: false });
    assert.equal(pb.$('#dlg').open, false, 'quem veio por convite já tem e-mail: nada de "Complete seu cadastro"');
    assert.equal(pb.$('#rail nav a[href="#equipe"]'), null, 'o item Equipe nem existe para o Operador');
    assert.match(pb.texto('#pessoa'), /Bia/);

    // a lista do Dono: 2 pessoas, nenhum convite
    await p.irPara('#visao'); await p.irPara('#equipe');
    assert.equal(p.$('#eq-pes-h').textContent, 'Pessoas (2)');
    assert.equal(p.$('#eq-cvs-h').textContent, 'Convites pendentes (0)');
    assert.match(p.texto('#eq-listas'), /Nenhum convite pendente\./);

    // o mesmo link de novo: não vale mais
    const outro = s.navegador();
    const c2 = await abrir(outro, 'convite.html', { hash: '#' + token });
    assert.equal(c2.$('#invalido').hidden, false); assert.equal(c2.$('#f').hidden, true);
    assert.match(c2.texto('#invalido'), /Este convite não vale mais Peça um novo link a quem convidou você\./);

    // Bia sai e entra de novo pela tela de login, com e-mail
    await pb.clicar('#sair');
    assert.equal(bia.navegou.at(-1), '/login.html'); assert.equal(bia.jar.size, 0, 'cookie apagado');
    const lb = await abrir(bia, 'login.html');
    lb.$('#email').value = 'bia@exemplo.com'; lb.$('#senha').value = 'senha-da-bia-1';
    await lb.enviar('#f');
    assert.equal(bia.navegou.at(-1), '/', 'a pessoa passa a entrar com e-mail e senha');

    const log = s.db.prepare('SELECT message FROM log').all().map((r) => r.message).join(' | ');
    assert.match(log, /Bia entrou na equipe pelo convite, como Operador\./);
    assert.ok(!log.includes(token), 'o token não vai para o Histórico');
    semEmailNoLog(s, saida);
  } finally { await s.fechar(); }
});

test('CA7 convite.html: token mal formado nem chama o servidor; 429 do freio mostra o motivo e "Tentar de novo"; e-mail já na equipe mostra o 409', async () => {
  const s = await subir();
  try {
    const dono = await donoAtivo(s);
    const nav = s.navegador();
    const c = await abrir(nav, 'convite.html', { hash: '#abc' });
    assert.equal(c.$('#invalido').hidden, false); assert.equal(nav.pedidos.length, 0, 'nada vai ao servidor');
    const c0 = await abrir(nav, 'convite.html');
    assert.equal(c0.$('#invalido').hidden, false, 'sem token');
    // 409: o convite pendente cujo e-mail já entrou por outro caminho
    const r = await dono.api('/equipe/convites', 'POST', { email: 'gil@exemplo.com', papel: 'operador' });
    const token = tokenDe(r.json.link);
    assert.equal((await dono.api('/me', 'PUT', { nome: 'Ana', email: 'gil@exemplo.com' })).status, 200); // a Ana passou a usar esse e-mail
    const cg = await abrir(nav, 'convite.html', { hash: '#' + token });
    preencher(cg.$('#f'), { nome: 'Gil', senha: 'senha-do-gil-1', confirma: 'senha-do-gil-1' });
    await cg.enviar('#f');
    assert.equal(cg.$('#erro').hidden, false); assert.equal(cg.$('#erro').textContent, 'Esta pessoa já está na equipe.');
    assert.deepEqual(nav.navegou, [], 'continua na página');
    assert.equal(cg.$('#criar').disabled, false);
    // freio: 10 links ruins do mesmo IP trancam o info por 15 min
    for (let i = 0; i < 10; i++) await nav.api('/convite/info', 'POST', { token: String(i).repeat(64).slice(0, 64) });
    const cb = await abrir(nav, 'convite.html', { hash: '#' + token });
    assert.equal(cb.$('#falha').hidden, false, 'não é "convite inválido": é falha com motivo');
    assert.match(cb.$('#falha-msg').textContent, /^Muitas tentativas\. Tente de novo em \d+ minutos?\.$/);
    assert.ok(cb.$('#de-novo'));
  } finally { await s.fechar(); }
});

// =====================================================================================================================
// CA7: o Operador não vê nem alcança as ações do Dono
// =====================================================================================================================
test('CA7 Operador: #equipe desvia para a Visão Geral; Desconectar, Apagar agora, Gerar novo token, segredos e o cartão Equipe da Ajuda somem; o Dono vê tudo', async (t) => {
  const saida = capturarConsole(t);
  const s = await subir();
  try {
    const dono = await donoAtivo(s);
    const { nav: bia } = await convidado(s, dono, { email: 'bia@exemplo.com', nome: 'Bia' });
    const pb = await abrir(bia, 'index.html', { hash: '#equipe' });
    assert.equal(pb.location.hash, '#visao', 'a rota Equipe desvia para a Visão Geral');
    assert.match(pb.texto(), /Visão Geral/);
    assert.equal(bia.pedidosPara('/api/equipe').length, 0, 'nem pede a lista');
    assert.equal(pb.$('#rail nav a[href="#equipe"]'), null);
    await pb.irPara('#equipe');
    assert.equal(pb.location.hash, '#visao', 'digitar #equipe também desvia');
    // Números de WhatsApp (simulação: conectado)
    await pb.irPara('#numeros');
    assert.equal(pb.$('#desconectar'), null, 'sem "Desconectar"');
    assert.match(pb.texto(), /Só o Dono pode desconectar o WhatsApp\./);
    // Ajustes
    await pb.irPara('#ajustes');
    assert.equal(pb.$('#limpar-agora'), null, 'sem "Apagar o que já passou do prazo"');
    assert.match(pb.texto(), /Só o Dono pode apagar agora o que passou do prazo\./);
    // Conexões: sem "Gerar novo token"; campos de segredo travados
    await pb.irPara('#conexoes');
    assert.equal(pb.$('#novo-token'), null, 'sem "Gerar novo token"');
    assert.match(pb.texto(), /Só o Dono pode gerar um novo token\./);
    const segredosOp = pb.$$('#outras-lojas input[type=password]');
    assert.ok(segredosOp.length > 0, 'há campos de segredo nas outras lojas');
    assert.ok(segredosOp.every((i) => i.disabled && i.value === ''), 'segredo travado e vazio para o Operador');
    // Ajuda: o cartão da Equipe some, como o item do menu
    await pb.irPara('#ajuda');
    assert.equal(pb.$('#ajuda-equipe'), null);
    assert.ok(pb.$('#ajuda-numeros'), 'os outros cartões ficam');

    // o Dono vê tudo
    const pd = await abrir(dono, 'index.html', { hash: '#numeros' });
    assert.ok(pd.$('#desconectar'));
    await pd.irPara('#ajustes'); assert.ok(pd.$('#limpar-agora'));
    await pd.irPara('#conexoes'); assert.ok(pd.$('#novo-token'));
    const segredosDono = pd.$$('#outras-lojas input[type=password]');
    assert.ok(segredosDono.length > 0 && segredosDono.every((i) => !i.disabled), 'o Dono pode trocar segredos');
    await pd.irPara('#ajuda'); assert.ok(pd.$('#ajuda-equipe'));
    await pd.irPara('#equipe'); assert.equal(pd.location.hash, '#equipe');
    semEmailNoLog(s, saida);
  } finally { await s.fechar(); }
});

test('CA7 Operador: uma ação de Dono que chega ao servidor (tela antiga, outra aba) vira aviso "Só o Dono pode fazer isso." e nada muda', async () => {
  const s = await subir();
  try {
    const dono = await donoAtivo(s);
    const { nav: bia } = await convidado(s, dono, { email: 'bia@exemplo.com', nome: 'Bia' });
    const pb = await abrir(bia, 'index.html', { hash: '#ajustes' });
    const token = getSetting(s.db, 'ext_token');
    for (const [caminho, metodo] of [['/ajustes/token', 'POST'], ['/privacidade/limpar', 'POST'], ['/wa/logout', 'POST'], ['/equipe', 'GET']]) {
      pb.avisos.length = 0;
      await pb.rodar(`tentar(() => api('${caminho}', '${metodo}'))()`); await bia.assentar();
      assert.ok(pb.avisos.length > 0 && pb.avisos.every((a) => a.msg === SO_DONO && a.erro), `${metodo} ${caminho}: ${JSON.stringify(pb.avisos)}`);
    }
    assert.equal(getSetting(s.db, 'ext_token'), token, 'token intacto');
    assert.equal(bia.navegou.length, 0, 'continua no painel (403 não é 401)');
    assert.equal(pb.location.hash, '#ajustes');
  } finally { await s.fechar(); }
});

// =====================================================================================================================
// CA7: Copiar link gira o token, cancelar, vencido
// =====================================================================================================================
test('CA7 "Copiar link" da lista gera um link novo e copia; o antigo abre "Este convite não vale mais"; sem área de transferência o link aparece para copiar à mão', async () => {
  const s = await subir();
  try {
    const dono = await donoAtivo(s);
    const p = await abrir(dono, 'index.html', { hash: '#equipe' });
    preencher(p.$('#eq-convidar'), { email: 'cid@exemplo.com', papel: 'dono' });
    await p.enviar('#eq-convidar');
    const link1 = p.$('#eq-criado-link').value; const id = s.db.prepare('SELECT id FROM invites').get().id;
    // gira pela lista
    await p.clicar(linhaDe(p, '#eq-cvs-h', id).querySelector('[data-eq=copiar]'));
    assert.equal(dono.pedidosPara(`/api/equipe/convites/${id}/link`, 'POST').length, 1);
    const link2 = dono.clipboard.at(-1);
    assert.match(link2, /\/convite\.html#[a-f0-9]{64}$/); assert.notEqual(link2, link1);
    assert.ok(p.avisos.some((a) => a.msg === 'Link do convite copiado. O link anterior deixou de funcionar.'), JSON.stringify(p.avisos));
    assert.equal(p.$('#eq-criado-link').value, link2, 'o bloco de cima troca o link morto pelo novo');
    // o antigo morreu, o novo vale (e é de Dono)
    const nav = s.navegador();
    const c1 = await abrir(nav, 'convite.html', { hash: '#' + tokenDe(link1) });
    assert.equal(c1.$('#invalido').hidden, false, 'link antigo: não vale mais');
    const c2 = await abrir(nav, 'convite.html', { hash: '#' + tokenDe(link2) });
    assert.equal(c2.$('#f').hidden, false); assert.equal(c2.$('#quem').textContent, 'achadinhoturbo convidou você como Dono.', 'sem nome da conta, "achadinhoturbo"');
    // sem área de transferência (ex.: endereço sem HTTPS fora do localhost): o link novo aparece para copiar à mão
    dono.comClipboard = false;
    await p.clicar(linhaDe(p, '#eq-cvs-h', id).querySelector('[data-eq=copiar]'));
    const manual = p.$('#eq-manual-link');
    assert.ok(manual, 'campo com o link para copiar à mão');
    const link3 = manual.value;
    assert.match(link3, /\/convite\.html#[a-f0-9]{64}$/); assert.notEqual(link3, link2);
    assert.ok(manual.hasAttribute('readonly'));
    assert.equal(p.doc.activeElement, manual, 'o foco vai para o link');
    assert.match(p.texto('#eq-listas'), /Link novo do convite de cid@exemplo\.com\. O anterior deixou de funcionar\./);
    assert.ok(p.avisos.some((a) => a.msg === 'Não consegui copiar sozinho: selecione o link e copie (Ctrl+C).'));
    const c3 = await abrir(nav, 'convite.html', { hash: '#' + tokenDe(link2) });
    assert.equal(c3.$('#invalido').hidden, false, 'o segundo também morreu');
    const c4 = await abrir(nav, 'convite.html', { hash: '#' + tokenDe(link3) });
    assert.equal(c4.$('#f').hidden, false);
    // GET /api/equipe nunca traz link nem token
    const lista = await dono.api('/equipe');
    for (const r of [link1, link2, link3]) assert.ok(!JSON.stringify(lista.json).includes(tokenDe(r)), 'a lista não traz token');
  } finally { await s.fechar(); }
});

test('CA7 cancelar convite pela tela: pede confirmação com o texto da spec; recusar não chama o servidor; aceitar cancela e o link morre', async () => {
  const s = await subir();
  try {
    const dono = await donoAtivo(s);
    const a = await dono.api('/equipe/convites', 'POST', { email: 'dan@exemplo.com', papel: 'operador' });
    const p = await abrir(dono, 'index.html', { hash: '#equipe' });
    preencher(p.$('#eq-convidar'), { email: 'eva@exemplo.com', papel: 'operador' });
    await p.enviar('#eq-convidar');
    const idEva = s.db.prepare("SELECT id FROM invites WHERE email = 'eva@exemplo.com'").get().id;
    assert.equal(p.$('#eq-cvs-h').textContent, 'Convites pendentes (2)');
    // recusa
    dono.confirmar = () => false;
    await p.clicar(linhaDe(p, '#eq-cvs-h', a.json.id).querySelector('[data-eq=cancelar]'));
    assert.equal(dono.confirmacoes.at(-1), 'Cancelar o convite para dan@exemplo.com? O link deixa de funcionar.');
    assert.equal(dono.pedidosPara(`/api/equipe/convites/${a.json.id}`, 'DELETE').length, 0);
    // aceita
    dono.confirmar = () => true;
    await p.clicar(linhaDe(p, '#eq-cvs-h', a.json.id).querySelector('[data-eq=cancelar]'));
    assert.equal(dono.pedidosPara(`/api/equipe/convites/${a.json.id}`, 'DELETE').length, 1);
    assert.ok(p.avisos.some((x) => x.msg === 'Convite cancelado'));
    assert.equal(p.$('#eq-cvs-h').textContent, 'Convites pendentes (1)');
    assert.equal(linhaDe(p, '#eq-cvs-h', a.json.id), null);
    const nav = s.navegador();
    const c = await abrir(nav, 'convite.html', { hash: '#' + tokenDe(a.json.link) });
    assert.equal(c.$('#invalido').hidden, false);
    // cancelar o convite do bloco de sucesso tira o link morto da tela
    assert.ok(p.$('#eq-criado-link'));
    await p.clicar(linhaDe(p, '#eq-cvs-h', idEva).querySelector('[data-eq=cancelar]'));
    assert.equal(p.$('#eq-criado-link'), null, 'o link cancelado não fica à mostra');
    assert.match(p.texto('#eq-listas'), /Nenhum convite pendente\./);
    const log = s.db.prepare('SELECT message FROM log').all().map((r) => r.message);
    assert.equal(log.filter((m) => /^Convite cancelado \(por Ana\)\.$/.test(m)).length, 2, log.join(' | '));
  } finally { await s.fechar(); }
});

test('CA7 convite vencido: a lista mostra "Vencido" só com Cancelar; o link abre "não vale mais"; o que vence amanhã avisa', async () => {
  const s = await subir();
  try {
    const dono = await donoAtivo(s);
    const v = await dono.api('/equipe/convites', 'POST', { email: 'vel@exemplo.com', papel: 'operador' });
    const am = await dono.api('/equipe/convites', 'POST', { email: 'ama@exemplo.com', papel: 'operador' });
    const novo = await dono.api('/equipe/convites', 'POST', { email: 'nov@exemplo.com', papel: 'operador' });
    s.db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, v.json.id);
    const d = new Date(); const amanhaMeioDia = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12).getTime();
    s.db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(amanhaMeioDia, am.json.id);
    // vence em 7 dias: conferido no banco a partir do que a tela criou
    const prazo = s.db.prepare('SELECT expires_at - created_at AS ms FROM invites WHERE id = ?').get(novo.json.id).ms;
    assert.equal(prazo, 7 * 24 * 3600 * 1000);
    const p = await abrir(dono, 'index.html', { hash: '#equipe' });
    const lv = linhaDe(p, '#eq-cvs-h', v.json.id);
    assert.match(lv.textContent, /Vencido/);
    assert.equal(lv.querySelector('[data-eq=copiar]'), null, 'vencido: sem "Copiar link"');
    assert.ok(lv.querySelector('[data-eq=cancelar]'), 'vencido: só "Cancelar"');
    assert.match(linhaDe(p, '#eq-cvs-h', am.json.id).textContent, /vence amanhã/);
    assert.doesNotMatch(linhaDe(p, '#eq-cvs-h', novo.json.id).textContent, /Vencido|vence amanhã|vence hoje/);
    const nav = s.navegador();
    const c = await abrir(nav, 'convite.html', { hash: '#' + tokenDe(v.json.link) });
    assert.equal(c.$('#invalido').hidden, false);
    // e-mail do vencido pode receber convite novo
    preencher(p.$('#eq-convidar'), { email: 'vel@exemplo.com' });
    await p.enviar('#eq-convidar');
    assert.ok(p.$('#eq-criado-link'), 'convite novo para quem tinha um vencido');
  } finally { await s.fechar(); }
});

// =====================================================================================================================
// CA7: papel e remoção, vistos dos dois lados (Dono e a pessoa, em navegadores diferentes)
// =====================================================================================================================
test('CA7 mudar papel pela tela vale na hora no painel da outra pessoa; rebaixada na Equipe, o 403 vira aviso e ela sai da tela; remover derruba a sessão', async (t) => {
  const saida = capturarConsole(t);
  const s = await subir();
  try {
    const dono = await donoAtivo(s);
    const b = await convidado(s, dono, { email: 'bia@exemplo.com', nome: 'Bia' });
    const pb = await abrir(b.nav, 'index.html', { hash: '#numeros' });
    assert.equal(pb.$('#desconectar'), null);
    const p = await abrir(dono, 'index.html', { hash: '#equipe' });
    let lb = linhaDe(p, '#eq-pes-h', b.id);
    const tornar = lb.querySelector('[data-eq=papel]');
    assert.equal(tornar.textContent, 'Tornar Dono'); assert.equal(tornar.getAttribute('aria-label'), 'Tornar Bia Dono');
    // promover pede confirmação
    dono.confirmar = () => false;
    await p.clicar(tornar);
    assert.equal(dono.confirmacoes.at(-1), 'Tornar Bia Dono? Essa pessoa também vai poder convidar, remover pessoas e mudar papéis, inclusive o seu.');
    assert.equal(dono.pedidosPara(`/api/equipe/pessoas/${b.id}`).length, 0);
    dono.confirmar = () => true;
    await p.clicar(linhaDe(p, '#eq-pes-h', b.id).querySelector('[data-eq=papel]'));
    assert.deepEqual(dono.pedidosPara(`/api/equipe/pessoas/${b.id}`, 'PUT').at(-1).corpo, { papel: 'dono' });
    assert.ok(p.avisos.some((a) => a.msg === 'Papel alterado'));
    lb = linhaDe(p, '#eq-pes-h', b.id);
    assert.match(lb.querySelector('.estado-pill').textContent, /^Dono$/);
    assert.equal(lb.querySelector('[data-eq=papel]').textContent, 'Tornar Operador');
    const minha = linhaDe(p, '#eq-pes-h', 1);
    assert.match(minha.textContent, /É você/, 'com dois Donos, a própria linha diz "É você"');
    assert.equal(minha.querySelectorAll('button').length, 0);
    // no painel da Bia, o próximo "a cada 3 s" já mostra o que é de Dono
    await pb.tique();
    assert.ok(pb.$('#desconectar'), 'virou Dona: "Desconectar" aparece na tela aberta');
    assert.ok(pb.$('#rail nav a[href="#equipe"]'), 'e o item Equipe');
    await pb.irPara('#equipe');
    assert.equal(pb.location.hash, '#equipe'); assert.equal(pb.$('#eq-pes-h').textContent, 'Pessoas (2)');
    // o Dono rebaixa (sem confirm para rebaixar); a Bia ainda está com a Equipe aberta e clica antes do próximo tique
    const confirmsAntes = dono.confirmacoes.length;
    await p.clicar(linhaDe(p, '#eq-pes-h', b.id).querySelector('[data-eq=papel]'));
    assert.deepEqual(dono.pedidosPara(`/api/equipe/pessoas/${b.id}`, 'PUT').at(-1).corpo, { papel: 'operador' });
    assert.equal(dono.confirmacoes.length, confirmsAntes, 'rebaixar não pede confirmação');
    pb.$('#eq-conta [name=conta_nome]').value = 'Tentativa da Bia';
    await pb.enviar('#eq-conta');
    assert.ok(pb.avisos.some((a) => a.msg === SO_DONO && a.erro), JSON.stringify(pb.avisos));
    assert.equal(getSetting(s.db, 'conta_nome', ''), '', 'nada gravado');
    assert.equal(pb.location.hash, '#visao', 'a tela sai da Equipe sozinha');
    assert.equal(pb.$('#rail nav a[href="#equipe"]'), null, 'e o item some do menu');
    // remover
    dono.confirmar = () => true;
    await p.clicar(linhaDe(p, '#eq-pes-h', b.id).querySelector('[data-eq=remover]'));
    assert.equal(dono.confirmacoes.at(-1), 'Remover Bia da equipe? Essa pessoa perde o acesso agora.');
    assert.ok(p.avisos.some((a) => a.msg === 'Pessoa removida'));
    assert.equal(p.$('#eq-pes-h').textContent, 'Pessoas (1)');
    assert.equal(linhaDe(p, '#eq-pes-h', b.id), null);
    // o painel da Bia, no próximo tique, vai para o login; e ela não entra mais
    await pb.tique();
    assert.equal(b.nav.navegou.at(-1), '/login.html');
    const l = await abrir(b.nav, 'login.html');
    l.$('#email').value = 'bia@exemplo.com'; l.$('#senha').value = b.senha;
    await l.enviar('#f');
    assert.equal(l.$('#erro').textContent, 'E-mail ou senha incorretos.');
    const log = s.db.prepare('SELECT message FROM log ORDER BY id').all().map((r) => r.message).join(' | ');
    assert.match(log, /Bia agora é Dono \(por Ana\)\..*Bia agora é Operador \(por Ana\)\..*Bia saiu da equipe \(por Ana\)\./);
    semEmailNoLog(s, saida);
  } finally { await s.fechar(); }
});

test('CA7/segurança: nome com HTML na Equipe e no convite aparece como texto, sem virar elemento', async () => {
  const s = await subir();
  try {
    const dono = await donoAtivo(s);
    const nome = '<img src=x onerror="alert(1)">Zé';
    await dono.api('/equipe/conta', 'PUT', { conta_nome: '<b>Loja</b>' });
    const r = await dono.api('/equipe/convites', 'POST', { email: 'ze@exemplo.com', papel: 'operador' });
    const nav = s.navegador();
    const c = await abrir(nav, 'convite.html', { hash: '#' + tokenDe(r.json.link) });
    assert.equal(c.$('#quem').textContent, '<b>Loja</b> convidou você como Operador.');
    assert.equal(c.$('#quem').querySelector('b'), null);
    preencher(c.$('#f'), { nome, senha: 'senha-do-ze-12', confirma: 'senha-do-ze-12' });
    await c.enviar('#f');
    const p = await abrir(dono, 'index.html', { hash: '#equipe' });
    assert.equal(p.$('#pagina').querySelectorAll('img').length, 0, 'nenhuma <img> na tela');
    assert.match(p.texto('#eq-listas'), /<img src=x onerror="alert\(1\)">Zé/);
    assert.equal(p.$('#eq-conta [name=conta_nome]').value, '<b>Loja</b>');
    const pz = await abrir(nav, 'index.html');
    assert.equal(pz.$('#pessoa').querySelectorAll('img').length, 0);
    assert.match(pz.texto('#pessoa'), /<img src=x/);
  } finally { await s.fechar(); }
});

// =====================================================================================================================
// CA8: ajuda e menu coerentes com a Equipe de verdade
// =====================================================================================================================
test('CA8 ajuda: verbetes de Equipe existem nas telas, nada de "próxima entrega", e o texto do Operador bate com o que a tela esconde', async () => {
  const s = await subir();
  try {
    const nav = s.navegador();
    const p = await abrir(nav, 'index.html', { hash: '#equipe' });
    const tipAtivar = p.$('#eq-prot-h .q')?.dataset.tip;
    assert.match(String(tipAtivar), /Ative o login para criar a sua conta de Dono e convidar a equipe\./, 'verbete equipe.ativar no card');
    await nav.api('/equipe/ativar', 'POST', { nome: 'Ana', email: 'ana@exemplo.com', senha: SENHA });
    const pd = await abrir(nav, 'index.html', { hash: '#equipe' });
    assert.match(String(pd.$('#eq-conv-h .q')?.dataset.tip), /Não enviamos e-mail: copie o link e mande pelo WhatsApp\. Vale 7 dias e só pode ser usado uma vez\./);
    assert.ok(pd.$('h1 .q')?.dataset.tip, 'verbete equipe no título');
    await pd.irPara('#ajuda');
    const card = pd.texto('#ajuda-equipe');
    assert.match(card, /Criar convite/); assert.match(card, /Copie o link e mande pelo WhatsApp/); assert.match(card, /cria a senha/);
    for (const arq of ['ajuda.js', 'equipe.js', 'app.js', 'index.html']) {
      assert.doesNotMatch(fs.readFileSync(path.join(PUB, arq), 'utf8'), /próxima entrega/i, `${arq} ainda promete "próxima entrega"`);
    }
    // o glossário do Operador lista exatamente o que a tela esconde dele
    const op = pd.$$('#pagina dt').find((dt) => dt.textContent === 'Operador')?.nextElementSibling?.textContent || '';
    for (const x of [/Equipe/, /desconecta o WhatsApp/, /novo token/, /apaga dados/]) assert.match(op, x, `glossário do Operador: ${op}`);
  } finally { await s.fechar(); }
});

// =====================================================================================================================
// Achados (falham hoje; passam quando o bug for corrigido)
// =====================================================================================================================
test('Q1 — modo legado: quem entrou por convite enquanto o Dono ainda não completou o cadastro consegue entrar de novo pela tela de login', async () => {
  const s = await subir({ senha: SENHA }); // instalação com senha única: Dono migrado, sem e-mail (modo legado)
  try {
    const dono = s.navegador();
    assert.equal((await dono.api('/login', 'POST', { senha: SENHA })).status, 200);
    // "Complete seu cadastro" não bloqueia: o Dono vai direto à Equipe e convida
    const b = await convidado(s, dono, { email: 'bia@exemplo.com', nome: 'Bia' });
    // Bia usa o painel, sai (ou a sessão vence) e volta pela tela de login
    assert.equal((await b.nav.api('/logout', 'POST')).status, 200);
    const l = await abrir(b.nav, 'login.html');
    // ela preenche o que a tela oferece: e-mail (se houver campo visível) e senha
    if (!l.$('#campo-email').hidden && !l.$('#email').disabled) l.$('#email').value = 'bia@exemplo.com';
    l.$('#senha').value = b.senha;
    await l.enviar('#f');
    assert.equal(b.nav.navegou.at(-1), '/', `Bia não consegue entrar: a tela de login mostra só a senha (modo legado) e manda ${JSON.stringify(b.nav.pedidosPara('/api/login').at(-1)?.corpo && Object.keys(b.nav.pedidosPara('/api/login').at(-1).corpo))}; erro na tela: "${l.$('#erro').textContent}"`);
  } finally { await s.fechar(); }
});
