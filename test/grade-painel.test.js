// Painel da grade de horários do Disparo automático (plano grade-de-disparos, etapa 7; spec grade-de-disparos,
// "Layout: grade na regra" e "Cartão"): public/grade.js e as ligações em formRegra/cartaoRegra de public/app.js.
// Todos os scripts do index.html rodam num `vm`, na ordem do HTML, com o DOM mínimo de test/equipe-qa.test.js (parser
// de HTML, seletores simples, eventos que borbulham) e um fetch falso por rota: nenhuma rede, nenhum servidor.
// Cobre CA2 (a grade é opcional: regra sem grade abre e salva como hoje, com grade:null), CA3 (validações no cliente
// com as mesmas frases de src/grade.js), CA4 (modelos rápidos e "Montar…"), CA9 (cartão), CA13 (aviso acima de 400
// mensagens por dia, sem bloquear) e o escape de todo texto do dono (nome de regra e de template).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { validarGrade, MAX_HORARIOS_GRADE, INTERVALO_MIN_GRADE, TOLERANCIA_MIN, MAX_QTD_GRADE } from '../src/grade.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(RAIZ, 'public');

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
// O painel num vm, com fetch falso por rota
// =====================================================================================================================
const XSS = '<img src=x onerror=alert(1)>"\'&';
const XSS_ESC = '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;';
/** Nenhuma tag nova nem atributo on* saiu do texto do dono (os atributos são lidos um a um, não por busca no texto). */
function semMarcacao(html, onde) {
  for (const [, tag, attrs] of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    assert.ok(!/^(img|script|iframe|svg)$/i.test(tag), `${onde}: tag <${tag}> vinda do texto\n${html}`);
    for (const [, nome] of attrs.matchAll(/([^\s=/]+)(?:="[^"]*")?/g)) assert.ok(!/^on/i.test(nome), `${onde}: atributo ${nome} na tag <${tag}>\n${html}`);
  }
}
/** O mesmo, no DOM já montado: nenhum <img>/<script> e nenhum atributo on*. */
function domLimpo(raiz, onde) {
  for (const el of raiz.querySelectorAll('*')) {
    assert.ok(!/^(img|script|iframe|svg)$/.test(el.localName), `${onde}: <${el.localName}> no DOM`);
    for (const k of el.atributos.keys()) assert.ok(!/^on/.test(k), `${onde}: atributo ${k} em <${el.localName}>`);
  }
}

const LIMITES = { max_horarios: MAX_HORARIOS_GRADE, intervalo_min: INTERVALO_MIN_GRADE, tolerancia_min: TOLERANCIA_MIN, max_qtd: MAX_QTD_GRADE };
const TEMPLATES = [{ id: 1, name: 'Padrão', body: '{TITULO} {LINK}' }, { id: 2, name: 'Cupom', body: '{CUPOM} {LINK}' }];
const GRUPOS = [{ jid: 'a@g.us', name: 'Grupo A', size: 10 }, { jid: 'b@g.us', name: 'Grupo B', size: 5 }, { jid: 'c@g.us', name: 'Grupo C', size: 3 }];
const regra = (extra = {}) => ({
  id: 5, name: 'Tecnologia', enabled: true, tag_id: 7, template_id: 1, group_jids: ['a@g.us'],
  sources: [{ type: 'list', tag_id: null, config: { items: 'https://produto.mercadolivre.com.br/MLB-1' } }],
  min_price: null, max_price: null, min_discount: null, per_run: 3, interval_min: 60, window_start: '08:00', window_end: '22:00',
  dedupe_days: 7, send_image: true, grade: null, next_run_at: null, proximo_horario: null, em_andamento: false, ...extra,
});
const linha = (hora, qtd = 3, template_id = null) => ({ hora, qtd, template_id });
const assentar = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

function tela({ rules = [regra()], templates = TEMPLATES, groups = GRUPOS, rotinas = [], st = {} } = {}) {
  const doc = new Documento(); parsearHtml(doc, fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), doc); doc.activeElement = doc.body;
  const janela = new No(doc); doc.janela = janela;
  const t = { doc, pedidos: [], rotas: {}, confirmacoes: [], confirmar: () => true, avisos: [] };
  /** FormData do formulário: o valor do primeiro controle com o nome (rádio e caixa: o marcado). */
  class FormDataFalso {
    constructor(f) { this.f = f; }
    get(n) {
      const els = this.f.querySelectorAll(`[name="${n}"]`); if (!els.length) return null;
      const e = els.find((x) => (x.type === 'radio' || x.type === 'checkbox' ? x.checked : true));
      return e ? e.value : null;
    }
  }
  const ctx = {
    document: doc, console, location: { hash: '#disparo-automatico', replace() {} }, history: { replaceState() {} },
    confirm: (m) => { t.confirmacoes.push(String(m)); return t.confirmar(String(m)); }, alert() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener: (tp, fn) => janela.addEventListener(tp, fn), removeEventListener() {},
    CSS: { escape: (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c) }, innerWidth: 1280, innerHeight: 800,
    FormData: FormDataFalso, __avisos: t.avisos,
    // a carga inicial do app.js (carregar: /state, /tags…) fica sem resposta: nem tela inicial nem toast no meio do teste
    __fetch: () => new Promise(() => {}),
  };
  ctx.fetch = (u, o) => ctx.__fetch(u, o); ctx.window = ctx;
  vm.createContext(ctx);
  for (const s of doc.querySelectorAll('script[src]')) {
    const src = s.getAttribute('src');
    vm.runInContext(fs.readFileSync(path.join(PUB, src), 'utf8'), ctx, { filename: `public/${src}` });
  }
  vm.runInContext('{ const o = aviso; aviso = (m, e = false) => { __avisos.push({ msg: String(m), erro: !!e }); return o(m, e); }; }', ctx);
  t.rotas['GET /api/catalogo/categorias'] = () => [200, { categorias: [] }];
  t.rotas['GET /api/rotinas'] = () => [200, rotinas];
  t.rotas['GET /api/rules'] = () => [200, rules];
  t.rotas['POST /api/rules'] = () => [200, { id: 99 }];
  for (const r of rules) t.rotas[`PUT /api/rules/${r.id}`] = () => [200, { ok: true }];
  ctx.__fetch = async (url, opts = {}) => {
    const metodo = opts.method || 'GET'; const caminho = String(url).split('?')[0];
    const corpo = opts.body ? JSON.parse(opts.body) : null;
    t.pedidos.push({ metodo, caminho, corpo });
    const fn = t.rotas[`${metodo} ${caminho}`];
    const [status, json] = fn ? await fn({ corpo }) : [404, { erro: 'rota não prevista no teste' }];
    return { status, ok: status < 400, json: async () => JSON.parse(JSON.stringify(json)) };
  };
  Object.assign(ctx, {
    __S: {
      st: { usuario: null, auth: false, whatsapp: { status: 'open' }, extensao: { online: true }, ajustes: { link_mode: 'extension', delay_group_s: 4, delay_offer_s: 10 },
        catalogo: { estado: 'conectada' }, afiliados: { categorias: [], ordens: [{ id: 'relevance', name: 'Relevância' }], por_pagina: 18 }, max_fontes: 5, placeholders: [], grade: LIMITES, ...st },
      tags: [{ id: 7, name: 'achadosmenicas' }], templates, groups, rules, blocks: [],
    },
  });
  t.rodar = (c) => vm.runInContext(c, ctx);
  t.json = (expr) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx) ?? 'null');
  t.rodar('S.st = __S.st; S.tags = __S.tags; S.templates = __S.templates; S.groups = __S.groups; S.rules = __S.rules; S.blocks = __S.blocks;');
  t.ctx = ctx;
  t.dlg = doc.querySelector('#dlg');
  t.$ = (s) => t.dlg.querySelector(s);
  t.$$ = (s) => t.dlg.querySelectorAll(s);
  t.clicar = async (x) => { const el = typeof x === 'string' ? t.$(x) : x; assert.ok(el, `existe: ${x}`); assert.equal(el.disabled, false, `habilitado: ${x}`); await disparar(el, 'click'); await assentar(); };
  t.mudar = async (el, valor) => { el.value = valor; await disparar(el, 'input'); await disparar(el, 'change'); await assentar(); };
  t.enviar = async () => { await disparar(t.$('#f'), 'submit'); await assentar(); };
  /** Abre o formulário da regra `i` de S.rules (ou um novo, com i = null) e espera a carga das categorias e rotinas. */
  t.abrir = async (i = 0) => { t.rodar(i == null ? 'formRegra()' : `formRegra(S.rules[${i}])`); await assentar(); };
  t.modo = (v) => t.clicar(`#r-modo button[data-v="${v}"]`);
  t.linhas = () => t.$$('#gh-lista > li').map((li) => ({ hora: li.querySelector('.gh-h').value, qtd: li.querySelector('.gh-q').value, template_id: li.querySelector('.gh-t').value }));
  t.horas = () => t.linhas().map((l) => l.hora);
  t.salvos = () => t.pedidos.filter((p) => p.metodo !== 'GET');
  t.erros = () => t.$$('.erros li').map((li) => li.textContent);
  t.texto = (s) => (t.$(s)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return t;
}
const horasDe = (de, ate, cada) => { const out = []; for (let m = de; m <= ate; m += cada) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); return out; };

// =====================================================================================================================
// XSS: nome de regra e de template saem escapados
// =====================================================================================================================

test('XSS: nome de template e de regra maliciosos saem escapados no formulário da grade (linhas, padrão do disparo e "Montar…")', async () => {
  const tpls = [{ id: 1, name: `Padrão ${XSS}`, body: '{LINK}' }, { id: 2, name: `Cupom ${XSS}`, body: '{LINK}' }];
  const t = tela({ templates: tpls, rules: [regra({ name: `Regra ${XSS}`, grade: { dias: [1, 2, 3], horarios: [linha('09:00', 2, 2), linha('12:00')] } })] });
  await t.abrir();
  assert.equal(t.$('#r-grade').hidden, false, 'regra com grade abre em "Em horários marcados"');
  domLimpo(t.dlg, 'formulário');
  // os textos chegam à tela como texto (o leitor de tela e o select mostram o nome como o dono escreveu)
  const opcoes = t.$$('#gh-lista > li')[1].querySelectorAll('.gh-t option').map((o) => o.textContent);
  assert.deepEqual(opcoes, [`Padrão do disparo (Padrão ${XSS})`, `Padrão ${XSS}`, `Cupom ${XSS}`]);
  assert.equal(t.$$('#gh-lista > li')[0].querySelector('.gh-t').value, '2');
  assert.ok(t.$('#gh-ger-tpl').querySelectorAll('option').some((o) => o.textContent === `Cupom ${XSS}`));
  // o HTML cru que grade.js monta (antes do parser) também não abre tag
  semMarcacao(t.rodar('gradeHtml(S.rules[0])'), 'gradeHtml');
  semMarcacao(t.rodar('gradeLinhaHtml({ hora: "09:00", qtd: 2, template_id: 2 }, 0, 1, S.templates.find((x) => x.id === 1).name)'), 'linha');
  assert.ok(t.rodar('gradeLinhaHtml({ hora: "09:00", qtd: 2, template_id: 2 }, 0, 1, S.templates.find((x) => x.id === 1).name)').includes(`Cupom ${XSS_ESC}`));
  // trocar o template da regra atualiza o "Padrão do disparo (…)" das linhas, ainda escapado
  await t.mudar(t.$('select[name=template_id]'), '2');
  assert.equal(t.$$('#gh-lista > li')[1].querySelector('.gh-t option').textContent, `Padrão do disparo (Cupom ${XSS})`);
  domLimpo(t.dlg, 'formulário depois da troca');
});

test('XSS: o cartão da regra com grade escapa nome da regra, template do próximo horário e templates da grade', () => {
  const t = tela({ templates: [{ id: 1, name: `Padrão ${XSS}`, body: '{LINK}' }, { id: 2, name: `Cupom ${XSS}`, body: '{LINK}' }] });
  const ts = Date.now() + 5 * 60000;
  t.ctx.__r = regra({ name: `Regra ${XSS}`, grade: { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [linha('09:00', 3, 2)] }, proximo_horario: { ts, hora: '09:00', qtd: 3, template_id: 2 } });
  const html = t.rodar('cartaoRegra(__r)');
  semMarcacao(html, 'cartão');
  assert.ok(html.includes(`Regra ${XSS_ESC}`), html);
  assert.ok(html.includes(`com o template Cupom ${XSS_ESC}`), html);
  assert.ok(html.includes(`Template: Cupom ${XSS_ESC}.`), html);
});

// =====================================================================================================================
// CA2: a grade é opcional; regra sem grade abre e salva como hoje
// =====================================================================================================================

test('CA2: regra sem grade abre em "A cada X minutos" e o corpo enviado leva grade:null e o ritmo de hoje', async () => {
  const t = tela();
  await t.abrir();
  const seg = t.$$('#r-modo button');
  assert.deepEqual(seg.map((b) => [b.dataset.v, b.textContent, b.getAttribute('aria-checked')]), [['intervalo', 'A cada X minutos', 'true'], ['grade', 'Em horários marcados', 'false']]);
  assert.equal(t.$('#r-grade').hidden, true);
  for (const n of ['per_run', 'interval_min', 'window_start', 'window_end']) assert.equal(t.$(`[name=${n}]`).closest('label').hidden, false, n);
  for (const n of ['dedupe_days', 'send_image']) assert.equal(t.$(`[name=${n}]`).closest('label').hidden, false, n);
  await t.enviar();
  const [put] = t.salvos();
  assert.equal(put.metodo, 'PUT'); assert.equal(put.caminho, '/api/rules/5');
  assert.equal(put.corpo.grade, null);
  assert.ok(Object.hasOwn(put.corpo, 'grade'), 'o PUT manda grade explícito (ausente grava NULL, mas o painel é explícito)');
  assert.deepEqual([put.corpo.per_run, put.corpo.interval_min, put.corpo.window_start, put.corpo.window_end], ['3', '60', '08:00', '22:00']);
  // regra nova também nasce em "A cada X minutos"
  await t.abrir(null);
  assert.equal(t.$('#r-modo button[data-v="intervalo"]').getAttribute('aria-checked'), 'true');
  t.$('#gr input[value="a@g.us"]').checked = true;
  t.$('[name=name]').value = 'Nova';
  await t.enviar();
  const post = t.salvos().find((p) => p.metodo === 'POST');
  assert.ok(post, JSON.stringify(t.erros()));
  assert.equal(post.corpo.grade, null);
});

test('CA2: trocar para "Em horários marcados" monta as linhas pela conversão do intervalo; voltar manda grade:null sem perder o ritmo', async () => {
  const t = tela();
  await t.abrir();
  await t.modo('grade');
  assert.equal(t.$('#r-grade').hidden, false);
  for (const n of ['per_run', 'interval_min', 'window_start', 'window_end']) assert.equal(t.$(`[name=${n}]`).closest('label').hidden, true, n);
  for (const n of ['dedupe_days', 'send_image']) assert.equal(t.$(`[name=${n}]`).closest('label').hidden, false, n);
  // 60 min, das 08:00 às 22:00 (o fim é exclusivo, como a janela do agendador): 08:00 … 21:00 = 14 horários
  assert.deepEqual(t.horas(), horasDe(8 * 60, 21 * 60, 60));
  assert.ok(t.linhas().every((l) => l.qtd === '3' && l.template_id === ''));
  assert.deepEqual(t.$$('#gh-dias button').map((b) => b.getAttribute('aria-pressed')), Array(7).fill('true'), 'padrão: todos os dias');
  assert.equal(t.texto('#gh-resumo'), '14 horários por dia, das 08:00 às 21:00. 42 ofertas por dia em 1 grupo (42 mensagens).');
  assert.equal(t.texto('#gh-cont'), '(14 de 48 horários)');
  await t.enviar();
  let put = t.salvos().at(-1);
  assert.deepEqual(put.corpo.grade, { dias: [0, 1, 2, 3, 4, 5, 6], horarios: horasDe(8 * 60, 21 * 60, 60).map((h) => linha(h)) });
  assert.deepEqual([put.corpo.per_run, put.corpo.interval_min, put.corpo.window_start, put.corpo.window_end], ['3', '60', '08:00', '22:00'], 'o ritmo de intervalo continua gravado');
  // remove uma linha, volta para o intervalo e de novo para a grade: a lista editada continua (não reconverte)
  await t.clicar(t.$$('#gh-lista > li')[0].querySelector('[data-gh="remover"]'));
  await t.modo('intervalo');
  assert.equal(t.$('#r-grade').hidden, true);
  await t.enviar();
  put = t.salvos().at(-1);
  assert.equal(put.corpo.grade, null);
  assert.equal(put.corpo.per_run, '3');
  await t.modo('grade');
  assert.equal(t.horas().length, 13);
  assert.equal(t.horas()[0], '09:00');
});

test('D1: em "Em horários marcados", "Ofertas por envio" e "Intervalo" escondidos não dão erro; vai o valor salvo ou o padrão', async () => {
  const t = tela({ rules: [regra({ per_run: 4, interval_min: 45 }), regra({ id: 6, per_run: 25, interval_min: 0 })] });
  // 0 em "Ofertas por envio" e vazio no intervalo, ainda em "A cada X minutos"; depois troca para a grade e salva
  await t.abrir();
  await t.mudar(t.$('[name=per_run]'), '0');
  await t.mudar(t.$('[name=interval_min]'), '');
  await t.modo('grade');
  await t.clicar('#gh-add'); // a conversão com 0 ofertas não monta a grade: começa vazia
  await t.enviar();
  assert.deepEqual(t.erros(), [], 'nenhum erro de campo escondido');
  let put = t.salvos().at(-1);
  assert.ok(put, 'salvou');
  assert.deepEqual([put.corpo.per_run, put.corpo.interval_min], ['4', '45'], 'vai o último valor válido (o salvo na regra)');
  assert.equal(put.corpo.grade.horarios.length, 1);
  // regra antiga com valores fora do que o servidor aceita: vai o padrão (3 ofertas, 60 min)
  await t.abrir(1);
  await t.modo('grade');
  await t.clicar('#gh-add');
  await t.enviar();
  assert.deepEqual(t.erros(), []);
  put = t.salvos().at(-1);
  assert.equal(put.caminho, '/api/rules/6');
  assert.deepEqual([put.corpo.per_run, put.corpo.interval_min], ['3', '60']);
  // valor válido digitado antes de trocar continua indo
  await t.abrir();
  await t.mudar(t.$('[name=per_run]'), '7');
  await t.mudar(t.$('[name=interval_min]'), '30');
  await t.modo('grade');
  await t.enviar();
  put = t.salvos().at(-1);
  assert.deepEqual([put.corpo.per_run, put.corpo.interval_min], ['7', '30']);
  // em "A cada X minutos" os dois campos continuam validados, à vista
  await t.abrir();
  await t.mudar(t.$('[name=per_run]'), '0');
  await t.mudar(t.$('[name=interval_min]'), '0');
  const antes = t.salvos().length;
  await t.enviar();
  assert.deepEqual(t.erros(), ['Ofertas por envio: de 1 a 20.', 'Intervalo entre envios: ao menos 1 minuto.']);
  assert.equal(t.salvos().length, antes);
  assert.equal(t.$('[name=per_run]').closest('label').hidden, false);
  // e voltar da grade para o intervalo também mostra o erro no campo, à vista
  await t.modo('grade');
  await t.modo('intervalo');
  await t.enviar();
  assert.deepEqual(t.erros(), ['Ofertas por envio: de 1 a 20.', 'Intervalo entre envios: ao menos 1 minuto.']);
  assert.equal(t.salvos().length, antes);
});

test('CA2: a conversão só acontece quando cabe em 48 linhas com 10 min entre elas; janela que vira a noite sai em ordem', async () => {
  const casos = [
    [{ interval_min: 30 }, horasDe(8 * 60, 21 * 60 + 30, 30)], // 28 linhas
    [{ interval_min: 15 }, []], // 56 linhas: não cabe
    [{ interval_min: 5 }, []], // menos de 10 min entre horários
    [{ interval_min: 60, window_start: '20:00', window_end: '02:00' }, ['00:00', '01:00', '20:00', '21:00', '22:00', '23:00']],
    [{ interval_min: 120, window_start: '06:00', window_end: '06:00' }, horasDe(0, 22 * 60, 120)], // janela de 24 h
    [{ interval_min: 60, per_run: 25 }, []], // ofertas fora de 1..20: começa vazia
  ];
  for (const [extra, esperado] of casos) {
    const t = tela({ rules: [regra(extra)] });
    await t.abrir(); await t.modo('grade');
    assert.deepEqual(t.horas(), esperado, JSON.stringify(extra));
    assert.equal(t.$('#gh-vazio').hidden, esperado.length > 0, JSON.stringify(extra));
    if (!esperado.length) assert.equal(t.texto('#gh-vazio'), 'Nenhum horário ainda. Comece por um modelo ou adicione um horário.');
  }
});

test('CA2: regra com grade abre com os dias e as linhas salvos; a lista de horários mostra a grade em ordem', async () => {
  const t = tela({ rules: [regra({ grade: { dias: [1, 2, 3, 4, 5], horarios: [linha('09:00', 2), linha('18:30', 4, 2)] } })] });
  await t.abrir();
  assert.equal(t.$('#r-modo button[data-v="grade"]').getAttribute('aria-checked'), 'true');
  assert.deepEqual(t.linhas(), [{ hora: '09:00', qtd: '2', template_id: '' }, { hora: '18:30', qtd: '4', template_id: '2' }]);
  assert.deepEqual(t.$$('#gh-dias button').map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'true', 'true', 'true', 'true', 'false']);
  assert.deepEqual(t.$$('#gh-lista > li').map((li) => li.getAttribute('aria-label')), ['Horário 1', 'Horário 2']);
  await t.enviar();
  assert.deepEqual(t.salvos().at(-1).corpo.grade, { dias: [1, 2, 3, 4, 5], horarios: [linha('09:00', 2), linha('18:30', 4, 2)] });
});

// =====================================================================================================================
// Linhas: Copiar, Remover, Adicionar, Limpar tudo e reordenar ao sair do campo
// =====================================================================================================================

test('linhas: Copiar (30 min depois ou o próximo livre), Remover (foco na anterior), + Adicionar (1 h depois da última) e Limpar tudo', async () => {
  const t = tela({ rules: [regra({ grade: { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [linha('08:00', 2, 2), linha('08:30', 5)] } })] });
  await t.abrir();
  // Copiar 08:00: 08:30 já existe, o próximo livre com 10 min de folga é 08:40; mesmos valores e foco no horário novo
  const copiar = t.$$('#gh-lista > li')[0].querySelector('[data-gh="copiar"]');
  assert.equal(copiar.getAttribute('aria-label'), 'Copiar horário 08:00');
  await t.clicar(copiar);
  assert.deepEqual(t.linhas(), [{ hora: '08:00', qtd: '2', template_id: '2' }, { hora: '08:30', qtd: '5', template_id: '' }, { hora: '08:40', qtd: '2', template_id: '2' }]);
  assert.equal(t.doc.activeElement, t.$$('#gh-lista > li')[2].querySelector('.gh-h'));
  // + Adicionar: 1 h depois da última, copiando ofertas e template dela
  await t.clicar('#gh-add');
  assert.deepEqual(t.linhas().at(-1), { hora: '09:40', qtd: '2', template_id: '2' });
  assert.equal(t.doc.activeElement, t.$$('#gh-lista > li').at(-1).querySelector('.gh-h'));
  assert.equal(t.texto('#gh-cont'), '(4 de 48 horários)');
  // Remover 08:30: foco no horário da linha anterior
  await t.clicar(t.$$('#gh-lista > li')[1].querySelector('[data-gh="remover"]'));
  assert.deepEqual(t.horas(), ['08:00', '08:40', '09:40']);
  assert.equal(t.doc.activeElement, t.$$('#gh-lista > li')[0].querySelector('.gh-h'));
  // Limpar tudo pede confirmação; cancelada, nada muda
  t.confirmar = () => false;
  await t.clicar('#gh-limpar');
  assert.equal(t.horas().length, 3);
  t.confirmar = () => true;
  await t.clicar('#gh-limpar');
  assert.deepEqual(t.horas(), []);
  assert.equal(t.$('#gh-vazio').hidden, false);
  assert.equal(t.doc.activeElement, t.$('#gh-add'), 'sem linhas, o foco vai para "+ Adicionar horário"');
  // + Adicionar numa grade vazia começa às 08:00 com as ofertas do intervalo
  await t.clicar('#gh-add');
  assert.deepEqual(t.linhas(), [{ hora: '08:00', qtd: '3', template_id: '' }]);
});

test('linhas: mudar o horário não reordena enquanto digita; ao sair do campo a linha vai para o lugar certo e o status avisa', async () => {
  const t = tela({ rules: [regra({ grade: { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [linha('08:00', 1), linha('12:00', 2), linha('18:00', 3)] } })] });
  await t.abrir();
  const h = t.$$('#gh-lista > li')[0].querySelector('.gh-h');
  h.focus();
  await t.mudar(h, '20:00');
  assert.deepEqual(t.horas(), ['20:00', '12:00', '18:00'], 'change sozinho não move a linha');
  const qtdDaMesma = t.$$('#gh-lista > li')[0].querySelector('.gh-q');
  await disparar(h, 'focusout', { relatedTarget: qtdDaMesma }); await assentar();
  assert.deepEqual(t.linhas().map((l) => [l.hora, l.qtd]), [['12:00', '2'], ['18:00', '3'], ['20:00', '1']]);
  assert.equal(t.texto('#gh-mov'), 'Horário movido para a posição 3.');
  assert.deepEqual(t.$$('#gh-lista > li').map((li) => li.getAttribute('aria-label')), ['Horário 1', 'Horário 2', 'Horário 3']);
  assert.equal(t.$$('#gh-lista > li')[2].querySelector('[data-gh="copiar"]').getAttribute('aria-label'), 'Copiar horário 20:00');
  assert.equal(t.$$('#gh-lista > li')[2].querySelector('.gh-h'), h, 'a linha é movida, não recriada (o que foi digitado continua)');
  assert.equal(t.texto('#gh-resumo'), '3 horários por dia, das 12:00 às 20:00. 6 ofertas por dia em 1 grupo (6 mensagens).');
});

// =====================================================================================================================
// CA4: modelos rápidos e "Montar…"
// =====================================================================================================================

test('CA4: modelos rápidos substituem os horários (com confirmação quando já há linhas) e usam as ofertas e o template do gerador', async () => {
  const t = tela({ rules: [regra({ interval_min: 5 })] }); // conversão impossível: começa vazia
  await t.abrir(); await t.modo('grade');
  const modelos = t.$$('.gh-modelos button[data-gh-modelo]');
  assert.deepEqual(modelos.map((b) => b.textContent), ['A cada 30 min, 8h às 22h', 'A cada hora, 8h às 22h', 'Manhã, tarde e noite', 'Horários de pico']);
  await t.clicar(modelos[0]);
  assert.deepEqual(t.confirmacoes, [], 'grade vazia: sem confirmação');
  assert.deepEqual(t.horas(), horasDe(8 * 60, 22 * 60, 30));
  assert.equal(t.horas().length, 29);
  assert.ok(t.linhas().every((l) => l.qtd === '3' && l.template_id === ''));
  // com linhas: pede confirmação com o número de horários novos
  t.confirmar = () => false;
  await t.clicar(t.$$('.gh-modelos button[data-gh-modelo]')[1]);
  assert.deepEqual(t.confirmacoes, ['Isso troca os horários atuais por 15 novos. Continuar?']);
  assert.equal(t.horas().length, 29, 'cancelado: nada muda');
  t.confirmar = () => true;
  await t.clicar(t.$$('.gh-modelos button[data-gh-modelo]')[1]);
  assert.deepEqual(t.horas(), horasDe(8 * 60, 22 * 60, 60));
  // ofertas e template do gerador valem para os modelos
  t.$('#gh-ger-qtd').value = '5'; t.$('#gh-ger-tpl').value = '2';
  await t.clicar(t.$$('.gh-modelos button[data-gh-modelo]')[2]);
  assert.deepEqual(t.linhas(), ['09:00', '15:00', '20:00'].map((hora) => ({ hora, qtd: '5', template_id: '2' })));
  assert.equal(t.confirmacoes.at(-1), 'Isso troca os horários atuais por 3 novos. Continuar?');
  await t.clicar(t.$$('.gh-modelos button[data-gh-modelo]')[3]);
  assert.deepEqual(t.horas(), ['12:00', '18:00', '21:00']);
});

test('CA4: "Montar…" abre o gerador; Acrescentar junta em ordem, Substituir troca, e o que passa de 48 horários não é aplicado', async () => {
  const t = tela({ rules: [regra({ grade: { dias: [0, 1, 2, 3, 4, 5, 6], horarios: [linha('09:00'), linha('15:00'), linha('20:00')] } })] });
  await t.abrir();
  const montar = t.$('#gh-montar');
  assert.equal(montar.getAttribute('aria-expanded'), 'false'); assert.equal(t.$('#gh-gerador').hidden, true);
  await t.clicar(montar);
  assert.equal(montar.getAttribute('aria-expanded'), 'true'); assert.equal(t.$('#gh-gerador').hidden, false);
  assert.deepEqual(t.$('#gh-ger-cada').querySelectorAll('option').map((o) => o.value), ['15', '30', '45', '60', '90', '120']);
  t.$('#gh-ger-de').value = '10:00'; t.$('#gh-ger-ate').value = '11:00'; t.$('#gh-ger-cada').value = '30'; t.$('#gh-ger-qtd').value = '5'; t.$('#gh-ger-tpl').value = '2';
  await t.clicar('[data-gh="acrescentar"]');
  assert.deepEqual(t.linhas().map((l) => [l.hora, l.qtd, l.template_id]), [['09:00', '3', ''], ['10:00', '5', '2'], ['10:30', '5', '2'], ['11:00', '5', '2'], ['15:00', '3', ''], ['20:00', '3', '']]);
  assert.deepEqual(t.confirmacoes, [], 'acrescentar não pede confirmação');
  // Acrescentar com horário que já existe: a linha que já estava fica (sem duplicar)
  t.$('#gh-ger-de').value = '15:00'; t.$('#gh-ger-ate').value = '15:30';
  await t.clicar('[data-gh="acrescentar"]');
  assert.deepEqual(t.horas(), ['09:00', '10:00', '10:30', '11:00', '15:00', '15:30', '20:00']);
  assert.equal(t.linhas()[4].qtd, '3');
  // Substituir: confirmação com o número de novos
  t.$('#gh-ger-de').value = '08:00'; t.$('#gh-ger-ate').value = '09:00'; t.$('#gh-ger-cada').value = '60';
  await t.clicar('[data-gh="substituir"]');
  assert.deepEqual(t.confirmacoes, ['Isso troca os horários atuais por 2 novos. Continuar?']);
  assert.deepEqual(t.horas(), ['08:00', '09:00']);
  // 00:00 até 23:59 a cada 15 = 96 horários: não aplica e diz por quê
  t.$('#gh-ger-de').value = '00:00'; t.$('#gh-ger-ate').value = '23:59'; t.$('#gh-ger-cada').value = '15';
  await t.clicar('[data-gh="substituir"]');
  assert.deepEqual(t.horas(), ['08:00', '09:00']);
  assert.equal(t.texto('#gh-ger-st'), 'Isso daria 96 horários, e o máximo é 48. Aumente o intervalo ou encurte o período.');
  // Acrescentar que somado passaria de 48 também não aplica
  t.$('#gh-ger-de').value = '10:00'; t.$('#gh-ger-ate').value = '21:30'; t.$('#gh-ger-cada').value = '15'; // 47 novos
  await t.clicar('[data-gh="acrescentar"]');
  assert.deepEqual(t.horas(), ['08:00', '09:00']);
  assert.equal(t.texto('#gh-ger-st'), 'Isso daria 49 horários, e o máximo é 48. Aumente o intervalo ou encurte o período.');
});

// =====================================================================================================================
// CA3: validações no cliente, com as mesmas frases do servidor (src/grade.js)
// =====================================================================================================================

test('CA3: gradeValidar dá as mesmas frases que validarGrade do servidor, caso a caso', () => {
  const t = tela();
  const existe = (id) => [1, 2].includes(id);
  const muitas = { dias: [1], horarios: Array.from({ length: 49 }, (_, i) => linha(`${String(Math.floor((i * 20) / 60)).padStart(2, '0')}:${String((i * 20) % 60).padStart(2, '0')}`)) };
  const casos = [
    ['49 horários', muitas],
    ['horário repetido', { dias: [1], horarios: [linha('10:00'), linha('10:00')] }],
    ['9 min', { dias: [1], horarios: [linha('10:00'), linha('10:09')] }],
    ['qtd 0', { dias: [1], horarios: [linha('10:00', 0)] }],
    ['qtd 21', { dias: [1], horarios: [linha('10:00', 21)] }],
    ['qtd vazia', { dias: [1], horarios: [linha('10:00', '')] }],
    ['qtd quebrada', { dias: [1], horarios: [linha('10:00', '2.5')] }],
    ['sem dia', { dias: [], horarios: [linha('10:00')] }],
    ['sem horário', { dias: [1], horarios: [] }],
    ['hora inválida', { dias: [1], horarios: [linha('25:00')] }],
    ['hora vazia', { dias: [1], horarios: [linha('')] }],
    ['template inexistente', { dias: [1], horarios: [linha('10:00', 3, 9)] }],
    ['virada do dia', { dias: [1], horarios: [linha('23:55'), linha('00:00')] }], // R4/S2: a última contra a primeira
  ];
  for (const [nome, g] of casos) {
    let servidor = null;
    try { validarGrade(g, { templateExiste: existe }); } catch (e) { servidor = e.message; }
    assert.ok(servidor, `${nome}: o servidor recusa`);
    t.ctx.__g = g;
    const cliente = t.json('gradeValidar(__g, { templateExiste: (id) => [1, 2].includes(id) }).map((e) => e.msg)');
    assert.equal(cliente[0], servidor, `${nome}: ${JSON.stringify(cliente)}`);
  }
  // grade válida: nenhum erro, como no servidor (10 min exatos passam)
  t.ctx.__g = { dias: [0, 6], horarios: [linha('10:00'), linha('10:10', 20, 2), linha('9:00', '1')] };
  assert.deepEqual(t.json('gradeValidar(__g, { templateExiste: (id) => [1, 2].includes(id) })'), []);
  assert.doesNotThrow(() => validarGrade(t.ctx.__g, { templateExiste: existe }));
  // os limites vêm de /api/state.grade (os mesmos do servidor)
  assert.deepEqual(t.json('gradeLimites()'), LIMITES);
});

test('CA3: salvar com grade inválida mostra as frases, marca o campo e não chama o servidor', async () => {
  const t = tela({ rules: [regra({ grade: { dias: [1, 2], horarios: [linha('10:00'), linha('12:00')] } })] });
  await t.abrir();
  const [l1, l2] = t.$$('#gh-lista > li');
  l1.querySelector('.gh-q').value = '0';
  l2.querySelector('.gh-h').value = '10:05';
  await t.enviar();
  assert.deepEqual(t.salvos(), []);
  assert.deepEqual(t.erros(), ['Horário 10:00: ofertas de 1 a 20.', 'Os horários 10:00 e 10:05 estão a menos de 10 min um do outro.']);
  assert.ok(l1.querySelector('.gh-q').classList.contains('invalido'));
  assert.equal(l1.querySelector('.gh-q').getAttribute('aria-invalid'), 'true');
  assert.ok(l2.querySelector('.gh-h').classList.contains('invalido'));
  assert.equal(t.doc.activeElement, l1.querySelector('.gh-q'), 'foco no primeiro inválido');
  // horário repetido
  l1.querySelector('.gh-q').value = '3'; l2.querySelector('.gh-h').value = '10:00';
  await t.enviar();
  assert.deepEqual(t.erros(), ['Já existe um horário às 10:00.']);
  assert.equal(l1.querySelector('.gh-q').getAttribute('aria-invalid'), null, 'o campo corrigido perde a marca');
  // nenhum dia
  l2.querySelector('.gh-h').value = '11:00';
  for (const b of t.$$('#gh-dias button[aria-pressed="true"]')) await t.clicar(b);
  await t.enviar();
  assert.deepEqual(t.erros(), ['Marque ao menos um dia.']);
  assert.deepEqual(t.salvos(), []);
  // nenhum horário
  await t.clicar(t.$$('#gh-dias button')[3]);
  await t.clicar('#gh-limpar');
  await t.enviar();
  assert.deepEqual(t.erros(), ['Adicione ao menos um horário.']);
  assert.deepEqual(t.salvos(), []);
  // corrigido: salva com os dias e a grade
  await t.clicar('#gh-add');
  await t.enviar();
  assert.deepEqual(t.salvos().at(-1).corpo.grade, { dias: [3], horarios: [linha('08:00')] });
});

test('R4/S2: na virada do dia, a última linha contra a primeira também precisa de 10 min (mesma frase do servidor)', async () => {
  const t = tela({ rules: [regra({ grade: { dias: [1], horarios: [linha('00:00'), linha('12:00'), linha('23:55')] } })] });
  t.ctx.__g = { dias: [1], horarios: [linha('23:55'), linha('00:00')] };
  assert.deepEqual(t.json('gradeValidar(__g).map((e) => e.msg)'), ['Os horários 23:55 e 00:00 estão a menos de 10 min um do outro.']);
  // 10 min exatos passam; uma linha só não tem com quem comparar
  t.ctx.__g = { dias: [1], horarios: [linha('23:50'), linha('00:00')] };
  assert.deepEqual(t.json('gradeValidar(__g)'), []);
  t.ctx.__g = { dias: [1], horarios: [linha('23:59')] };
  assert.deepEqual(t.json('gradeValidar(__g)'), []);
  t.ctx.__g = { dias: [1], horarios: [linha('23:58'), linha('12:00'), linha('00:03')] };
  assert.deepEqual(t.json('gradeValidar(__g).map((e) => e.msg)'), ['Os horários 23:58 e 00:03 estão a menos de 10 min um do outro.']);
  // no formulário: não salva, mostra a frase e marca o horário
  await t.abrir();
  await t.enviar();
  assert.deepEqual(t.erros(), ['Os horários 23:55 e 00:00 estão a menos de 10 min um do outro.']);
  assert.deepEqual(t.salvos(), []);
  assert.equal(t.$$('#gh-lista > li')[0].querySelector('.gh-h').getAttribute('aria-invalid'), 'true');
  // "+ Adicionar horário" também respeita a virada: depois de 22:55, com 00:00 na grade, 23:55 ficaria perto demais
  const t2 = tela({ rules: [regra({ grade: { dias: [1], horarios: [linha('00:00'), linha('22:55')] } })] });
  await t2.abrir();
  await t2.clicar('#gh-add');
  assert.deepEqual(t2.horas(), ['00:00', '00:15', '22:55']);
  await t2.enviar();
  assert.deepEqual(t2.erros(), []);
});

test('D8:a marca de inválido (aria-invalid e a borda) de um campo da grade sai no change do próprio campo', async () => {
  const t = tela({ rules: [regra({ grade: { dias: [1, 2], horarios: [linha('10:00'), linha('12:00')] } })] });
  await t.abrir();
  const [l1, l2] = t.$$('#gh-lista > li');
  l1.querySelector('.gh-q').value = '0';
  l2.querySelector('.gh-h').value = '10:05';
  await t.enviar();
  assert.equal(l1.querySelector('.gh-q').getAttribute('aria-invalid'), 'true');
  assert.equal(l2.querySelector('.gh-h').getAttribute('aria-invalid'), 'true');
  await t.mudar(l1.querySelector('.gh-q'), '2');
  assert.equal(l1.querySelector('.gh-q').getAttribute('aria-invalid'), null, 'o campo mexido perde a marca na hora');
  assert.equal(l1.querySelector('.gh-q').classList.contains('invalido'), false);
  assert.equal(l2.querySelector('.gh-h').getAttribute('aria-invalid'), 'true', 'o outro campo continua marcado até o próximo Salvar');
  assert.ok(l2.querySelector('.gh-h').classList.contains('invalido'));
  await t.mudar(l2.querySelector('.gh-h'), '11:00');
  assert.equal(l2.querySelector('.gh-h').getAttribute('aria-invalid'), null);
  assert.equal(l2.querySelector('.gh-h').classList.contains('invalido'), false);
  assert.deepEqual(t.salvos(), []);
});

test('CA3: 400 do servidor com a grade (ex.: template apagado) aparece na caixa de erros, com a frase dele', async () => {
  const t = tela({ rules: [regra({ grade: { dias: [1], horarios: [linha('10:00', 3, 2)] } })] });
  t.rotas['PUT /api/rules/5'] = () => [400, { erro: 'Horário 10:00: o template escolhido não existe mais. Escolha outro.' }];
  await t.abrir();
  await t.enviar();
  assert.deepEqual(t.erros(), ['Horário 10:00: o template escolhido não existe mais. Escolha outro.']);
  assert.equal(t.dlg.open, true, 'o formulário continua aberto');
});

test('CA3: template da linha que sumiu da lista aparece como apagado e é recusado antes de salvar', async () => {
  const t = tela({ rules: [regra({ grade: { dias: [1], horarios: [linha('10:00', 3, 77)] } })] });
  await t.abrir();
  const sel = t.$$('#gh-lista > li')[0].querySelector('.gh-t');
  assert.equal(sel.value, '77');
  assert.equal(sel.querySelectorAll('option').find((o) => o.value === '77').textContent, '(template apagado)');
  await t.enviar();
  assert.deepEqual(t.erros(), ['Horário 10:00: o template escolhido não existe mais. Escolha outro.']);
  assert.deepEqual(t.salvos(), []);
});

// =====================================================================================================================
// CA13: estimativa de mensagens por dia e aviso acima de 400, sem bloquear
// =====================================================================================================================

test('CA13: soma as regras ligadas, a regra aberta e as rotinas ligadas; acima de 400 avisa e deixa salvar', async () => {
  const outra = regra({ id: 6, name: 'Casa', group_jids: ['a@g.us', 'b@g.us', 'c@g.us'], per_run: 10, interval_min: 60 }); // 10 × 14 × 3 = 420
  const desligada = regra({ id: 7, name: 'Off', enabled: false, per_run: 20, interval_min: 10 });
  const comGrade = regra({ id: 8, name: 'Grade', group_jids: ['a@g.us', 'b@g.us'], grade: { dias: [1], horarios: [linha('10:00', 4), linha('11:00', 6)] } }); // 10 × 2 = 20
  const rotinas = [
    { id: 1, nome: 'Bom dia', enabled: true, group_jids: ['a@g.us', 'b@g.us'], repetir: { dias: [1], horarios: ['08:00', '20:00'] } }, // 2 × 2 = 4
    { id: 2, nome: 'Off', enabled: false, group_jids: ['a@g.us'], repetir: { dias: [1], horarios: ['09:00'] } },
  ];
  const t = tela({ rules: [regra({ grade: { dias: [1], horarios: [linha('09:00', 1), linha('12:00', 2)] } }), outra, desligada, comGrade], rotinas });
  await t.abrir();
  // esta regra: 3 ofertas × 1 grupo = 3; total 3 + 420 + 20 + 4 = 447
  const av = t.$('#gh-aviso');
  assert.equal(av.hidden, false);
  assert.equal(av.textContent.replace(/\s+/g, ' ').trim(), '! Somando os outros disparos e rotinas ligados, este número enviaria cerca de 447 mensagens por dia. Acima de 400 aumenta o risco de bloqueio do WhatsApp. Para baixar: menos ofertas por horário, menos horários ou menos grupos.');
  assert.ok(av.classList.contains('nivel-aviso'));
  assert.equal(t.json('gradeMensagensDia({ regras: S.rules, rotinas: __rot, atual: { id: 5, msgs: 3 } })'.replace('__rot', JSON.stringify(rotinas))), 447);
  // não bloqueia: salva normalmente
  await t.enviar();
  assert.equal(t.salvos().at(-1).metodo, 'PUT');
  assert.deepEqual(t.erros(), []);
  // marcar mais grupos na regra aberta muda a conta na hora (3 → 9 mensagens)
  await t.abrir();
  for (const j of ['b@g.us', 'c@g.us']) { const c = t.$(`#gr input[value="${j}"]`); c.checked = true; await disparar(c, 'change'); }
  await assentar();
  assert.match(t.texto('#gh-aviso'), /cerca de 453 mensagens por dia/);
  assert.equal(t.texto('#gh-resumo'), '2 horários por dia, das 09:00 às 12:00. 3 ofertas por dia em 3 grupos (9 mensagens).');
});

test('CA13: até 400 por dia, só o resumo neutro (sem aviso); sem /api/rotinas, conta só os disparos', async () => {
  const outra = regra({ id: 6, name: 'Casa', group_jids: ['a@g.us', 'b@g.us', 'c@g.us'], per_run: 9, interval_min: 60 }); // 9 × 14 × 3 = 378
  const t = tela({ rules: [regra({ grade: { dias: [1], horarios: [linha('09:00', 1), linha('12:00', 1)] } }), outra] });
  t.rotas['GET /api/rotinas'] = () => [404, { erro: 'não existe' }];
  await t.abrir();
  assert.equal(t.$('#gh-aviso').hidden, true, '380 não passa de 400');
  t.rodar('S.rules[1].per_run = 10');
  await t.mudar(t.$$('#gh-lista > li')[0].querySelector('.gh-q'), '1');
  assert.equal(t.$('#gh-aviso').hidden, false);
  assert.match(t.texto('#gh-aviso'), /^! Somando os outros disparos e rotinas ligados, este número enviaria cerca de 422 mensagens por dia\./);
  // intervalo: ofertas × ⌈janela ÷ intervalo⌉ × grupos (janela de 24 h quando início = fim; vira a noite)
  const conta = (r) => { t.ctx.__x = r; return t.rodar('gradeMensagensRegra(__x)'); };
  assert.equal(conta(regra({ per_run: 2, interval_min: 90, window_start: '08:00', window_end: '08:00' })), 2 * 16);
  assert.equal(conta(regra({ per_run: 1, interval_min: 60, window_start: '20:00', window_end: '02:00' })), 6);
  assert.equal(conta(regra({ per_run: 1, interval_min: 45, window_start: '08:00', window_end: '22:00' })), 19); // 840/45 = 18,7
  assert.equal(conta(regra({ group_jids: [], per_run: 5 })), 0);
});

test('D7: sem outros disparos nem rotinas ligados, o aviso não fala em somar; com eles, começa por "Somando os outros…"', async () => {
  // esta regra sozinha: 10 horários × 14 ofertas × 3 grupos = 420; a outra regra e a rotina estão desligadas
  const horas = Array.from({ length: 10 }, (_, i) => linha(`${String(8 + i).padStart(2, '0')}:00`, 14));
  const desligada = regra({ id: 6, name: 'Off', enabled: false, per_run: 20, interval_min: 10 });
  const rotinas = [{ id: 1, enabled: false, group_jids: ['a@g.us'], repetir: { dias: [1], horarios: ['08:00'] } }];
  const t = tela({ rules: [regra({ group_jids: ['a@g.us', 'b@g.us', 'c@g.us'], grade: { dias: [1], horarios: horas } }), desligada], rotinas });
  await t.abrir();
  assert.equal(t.texto('#gh-resumo'), '10 horários por dia, das 08:00 às 17:00. 140 ofertas por dia em 3 grupos (420 mensagens).');
  assert.equal(t.texto('#gh-aviso'), '! Este número enviaria cerca de 420 mensagens por dia. Acima de 400 aumenta o risco de bloqueio do WhatsApp. Para baixar: menos ofertas por horário, menos horários ou menos grupos.');
  // só uma rotina ligada (nenhum outro disparo): já é soma
  const t2 = tela({ rules: [regra({ group_jids: ['a@g.us', 'b@g.us', 'c@g.us'], grade: { dias: [1], horarios: horas } })], rotinas: [{ ...rotinas[0], enabled: true }] });
  await t2.abrir();
  assert.match(t2.texto('#gh-aviso'), /^! Somando os outros disparos e rotinas ligados, este número enviaria cerca de 421 mensagens por dia\./);
  // disparo novo (sem id): os disparos ligados que já existem são "os outros"
  const t3 = tela({ rules: [regra({ id: 6, group_jids: ['a@g.us', 'b@g.us', 'c@g.us'], per_run: 10 })] }); // 10 × 14 × 3 = 420
  await t3.abrir(null);
  await t3.modo('grade');
  assert.match(t3.texto('#gh-aviso'), /^! Somando os outros disparos e rotinas ligados, este número enviaria cerca de 420 mensagens por dia\./);
});

test('D6: o aviso da grade e do Grupo vivo usa só o "!" de texto, sem a bolinha do .nivel-aviso', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  assert.match(css, /\.nivel-aviso::before \{[^}]*border-radius:50%/, 'a bolinha continua nos outros avisos');
  assert.match(css, /\.gh-aviso::before \{ ?content: ?none; ?\}/);
  // a regra que tira vem depois da que põe (mesma especificidade: vence a última)
  assert.ok(css.indexOf('.gh-aviso::before') > css.indexOf('.nivel-aviso::before'));
});

// =====================================================================================================================
// CA9: cartão
// =====================================================================================================================

test('CA9: cartão da regra com grade: chip "Grade", resumo, próximo horário com a quantidade e o template', () => {
  const t = tela();
  const hoje = new Date(Date.now() + 3 * 60000);
  const ts = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), hoje.getHours(), hoje.getMinutes()).getTime();
  const hm = `${String(new Date(ts).getHours()).padStart(2, '0')}:${String(new Date(ts).getMinutes()).padStart(2, '0')}`;
  const grade = { dias: [1, 2, 3, 4, 5], horarios: [linha('09:00', 2), linha('12:00', 3, 2), linha('20:00', 4)] };
  t.ctx.__r = regra({ group_jids: ['a@g.us', 'b@g.us'], grade, proximo_horario: { ts, hora: hm, qtd: 3, template_id: 2 } });
  const html = t.rodar('cartaoRegra(__r)');
  assert.match(html, /<span class="chip">Grade<\/span>/);
  assert.ok(html.includes('3 horários por dia (09:00 a 20:00), de 2 a 4 ofertas cada, seg a sex, para 2 grupos.'), html);
  assert.ok(html.includes('Templates: 2 diferentes.'), html);
  const dia = new Date(ts).toDateString() === new Date().toDateString() ? 'hoje' : 'amanhã';
  assert.ok(html.includes(`<div class="prox">Próximo envio ${dia} às ${hm}: 3 ofertas com o template Cupom.</div>`), html);
  // template null no próximo horário = o da regra; outro dia da semana
  const quarta = new Date(); quarta.setDate(quarta.getDate() + ((3 - quarta.getDay() + 7) % 7 || 7)); quarta.setHours(8, 0, 0, 0);
  const longe = quarta.getTime() - Date.now() > 2 * 86400000;
  t.ctx.__r = regra({ grade: { dias: [3], horarios: [linha('08:00', 1)] }, proximo_horario: { ts: quarta.getTime(), hora: '08:00', qtd: 1, template_id: null } });
  const h2 = t.rodar('cartaoRegra(__r)');
  if (longe) assert.ok(h2.includes('<div class="prox">Próximo envio quarta às 08:00: 1 oferta com o template Padrão.</div>'), h2);
  assert.ok(h2.includes('1 horário por dia (08:00), 1 oferta, qua, para 1 grupo.'), h2);
  assert.ok(h2.includes('Template: Padrão.'), h2);
  // pausado e enviando agora, como hoje
  t.ctx.__r = regra({ enabled: false, grade, proximo_horario: { ts, hora: hm, qtd: 3, template_id: 2 } });
  assert.match(t.rodar('cartaoRegra(__r)'), /<div class="prox">Pausado<\/div>/);
  t.ctx.__r = regra({ em_andamento: true, grade, proximo_horario: { ts, hora: hm, qtd: 3, template_id: 2 } });
  assert.match(t.rodar('cartaoRegra(__r)'), /<div class="prox">Enviando agora…<\/div>/);
  // atrasado dentro da tolerância: sai em instantes
  t.ctx.__r = regra({ grade, proximo_horario: { ts: Date.now() - 60000, hora: '09:00', qtd: 2, template_id: null } });
  assert.match(t.rodar('cartaoRegra(__r)'), /<div class="prox">Enviando em instantes: 2 ofertas com o template Padrão\.<\/div>/);
  // dias: todos, fim de semana, avulsos
  assert.equal(t.rodar('gradeDiasTexto([0,1,2,3,4,5,6])'), 'todos os dias');
  assert.equal(t.rodar('gradeDiasTexto([1,2,3,4,5])'), 'seg a sex');
  assert.equal(t.rodar('gradeDiasTexto([0,6])'), 'dom e sáb');
  assert.equal(t.rodar('gradeDiasTexto([1,3,5])'), 'seg, qua e sex');
});

test('CA9: cartão de regra sem grade fica como hoje (sem chip "Grade", resumo do intervalo e template da regra)', () => {
  const t = tela();
  t.ctx.__r = regra({ group_jids: ['a@g.us', 'b@g.us'] });
  const html = t.rodar('cartaoRegra(__r)');
  assert.doesNotMatch(html, /Grade/);
  assert.ok(html.includes(`<p class="res">3 ofertas a cada 60 min, das 08:00 às 22:00, para 2 grupos.
      Fonte: 1 links na lista. Template: Padrão.</p>`), html);
  assert.ok(html.includes('<div class="prox">Começa no próximo ciclo (até 15 s)</div>'), html);
});
