// Painel do Grupo vivo (plano grade-de-disparos, etapa 8; spec grade-de-disparos, "Layout: Grupo vivo", "Formulário" e
// "Galeria"): public/grupovivo.js, a rota `grupo-vivo` de public/app.js, o item de menu e o <script> do index.html e o
// link no .sub de "Disparar mensagem". Todos os scripts do index.html rodam num `vm`, na ordem do HTML, com o DOM mínimo
// de test/equipe-qa.test.js (o mesmo de test/grade-painel.test.js) e um fetch falso por rota: nenhuma rede, nenhum
// servidor. Cobre CA11 (cartões, formulário e o corpo do contrato de src/rotinas.js, limites de 5 conteúdos e 6
// horários, erro do servidor), CA12 (a galeria só preenche o formulário, nunca salva), CA13 (aviso acima de 400
// mensagens por dia, sem bloquear) e o escape de todo texto do dono (nome da rotina, textos, opções, nome de grupo).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { MAX_CONTEUDOS, MAX_HORARIOS_ROTINA } from '../src/rotinas.js';

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

const GRUPOS = [{ jid: 'a@g.us', name: 'Grupo A', size: 10 }, { jid: 'b@g.us', name: 'Grupo B', size: 5 }, { jid: 'c@g.us', name: 'Grupo C', size: 3 }];
const rotina = (extra = {}) => ({
  id: 3, nome: 'Bom dia', enabled: true, tipo: 'mensagem', conteudos: ['Bom dia, pessoal!', 'Bom dia!'], ordem: 'rodizio',
  group_jids: ['a@g.us', 'b@g.us'], repetir: { dias: [1, 2, 3, 4, 5], horarios: ['08:00', '18:00'] }, next_run_at: Date.now() + 3600000,
  enviadas_24h: 0, erros_24h: 0, ultimo_erro_grupo: null, ...extra,
});
const enquete = (extra = {}) => rotina({
  id: 4, nome: 'Enquete da sexta', tipo: 'enquete', conteudos: [{ pergunta: 'O que ver?', opcoes: ['Casa', 'Moda'], multipla: false }],
  group_jids: ['c@g.us'], repetir: { dias: [5], horarios: ['12:00'] }, ...extra,
});
const assentar = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
const limpo = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Título sem o "?" da ajuda (q('grupovivo') ganha verbete na etapa 9). */
const titulo = (el) => limpo(el?.textContent).replace(/\s?\?$/, '');

function tela({ rotinas = [rotina()], groups = GRUPOS, rules = [], st = {} } = {}) {
  const doc = new Documento(); parsearHtml(doc, fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'), doc); doc.activeElement = doc.body;
  const janela = new No(doc); doc.janela = janela;
  const t = { doc, pedidos: [], rotas: {}, confirmacoes: [], confirmar: () => true, avisos: [], rotinas, intervalos: [] };
  const ctx = {
    document: doc, console, location: { hash: '#grupo-vivo', replace() {} }, history: { replaceState() {} },
    confirm: (m) => { t.confirmacoes.push(String(m)); return t.confirmar(String(m)); }, alert() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: (fn, ms) => { t.intervalos.push({ fn, ms }); return 0; }, clearInterval() {},
    addEventListener: (tp, fn) => janela.addEventListener(tp, fn), removeEventListener() {},
    CSS: { escape: (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c) }, innerWidth: 1280, innerHeight: 800, __avisos: t.avisos,
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
  t.rotas['GET /api/rotinas'] = () => [200, t.rotinas];
  t.rotas['POST /api/rotinas'] = () => [200, { id: 99, next_run_at: Date.now() + 60000 }];
  for (const r of rotinas) {
    t.rotas[`PUT /api/rotinas/${r.id}`] = () => [200, { id: r.id, next_run_at: Date.now() + 60000 }];
    t.rotas[`DELETE /api/rotinas/${r.id}`] = () => [200, { ok: true }];
    t.rotas[`POST /api/rotinas/${r.id}/enabled`] = ({ corpo }) => [200, { ok: true, enabled: corpo.enabled, next_run_at: null }];
    t.rotas[`POST /api/rotinas/${r.id}/enviar`] = () => [200, { envio_id: 1, grupos: r.group_jids.length }];
  }
  ctx.__fetch = async (url, opts = {}) => {
    const metodo = opts.method || 'GET'; const caminho = String(url).split('?')[0];
    const corpo = opts.body ? JSON.parse(opts.body) : null;
    t.pedidos.push({ metodo, caminho, corpo });
    const fn = t.rotas[`${metodo} ${caminho}`];
    const [status, json] = fn ? await fn({ corpo }) : [404, { erro: 'rota não prevista no teste' }];
    return { status, ok: status < 400, json: async () => JSON.parse(JSON.stringify(json)) };
  };
  ctx.__S = {
    st: { usuario: null, auth: false, whatsapp: { status: 'open' }, extensao: { online: true }, ajustes: { link_mode: 'extension', delay_group_s: 4, delay_offer_s: 10 },
      grade: { max_horarios: 48, intervalo_min: 10, tolerancia_min: 30, max_qtd: 20, max_conteudos: MAX_CONTEUDOS, max_horarios_rotina: MAX_HORARIOS_ROTINA }, ...st },
    tags: [], templates: [{ id: 1, name: 'Padrão', body: '{LINK}' }], groups, rules, blocks: [],
  };
  t.rodar = (c) => vm.runInContext(c, ctx);
  t.rodar('S.st = __S.st; S.tags = __S.tags; S.templates = __S.templates; S.groups = __S.groups; S.rules = __S.rules; S.blocks = __S.blocks;');
  t.ctx = ctx;
  t.pag = doc.querySelector('#pagina');
  t.dlg = doc.querySelector('#dlg');
  t.$ = (s) => t.dlg.querySelector(s);
  t.$$ = (s) => t.dlg.querySelectorAll(s);
  t.p = (s) => t.pag.querySelector(s);
  t.pp = (s) => t.pag.querySelectorAll(s);
  t.abrir = async () => { t.rodar('paginaGrupoVivo()'); await assentar(); };
  t.clicar = async (x) => { const el = typeof x === 'string' ? (t.$(x) || t.p(x)) : x; assert.ok(el, `existe: ${x}`); assert.equal(el.disabled, false, `habilitado: ${x}`); await disparar(el, 'click'); await assentar(); };
  t.escrever = async (el, valor) => { assert.ok(el, 'campo existe'); el.value = valor; await disparar(el, 'input'); await disparar(el, 'change'); await assentar(); };
  t.marcar = async (jid) => { const i = t.$(`#gv-gr input[value="${jid}"]`); i.checked = true; await disparar(i, 'change'); await assentar(); };
  t.dia = (d) => t.clicar(t.$(`#gv-dias button[data-d="${d}"]`));
  t.addHora = async (h) => { await t.escrever(t.$('#gv-hor-novo'), h); await t.clicar('#gv-hor-add'); };
  t.enviar = async () => { await disparar(t.$('#gv-f'), 'submit'); await assentar(); };
  t.textos = () => t.$$('#gv-conteudos textarea').map((x) => x.value);
  t.horarios = () => t.$$('#gv-horarios button[data-h]').map((b) => b.dataset.h);
  t.dias = () => t.$$('#gv-dias button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => Number(b.dataset.d));
  t.salvos = () => t.pedidos.filter((p) => p.metodo !== 'GET');
  t.erros = () => t.$$('.erros li').map((li) => li.textContent);
  t.cartoes = () => t.pp('#gv-lista article.card');
  t.acao = (i, act) => t.cartoes()[i].querySelector(`[data-act="${act}"]`);
  /** Roda os setInterval de 10 s do app.js (o do Disparo automático e o do Grupo vivo), como se 10 s tivessem passado. */
  t.tique = async () => { for (const x of t.intervalos.filter((i) => i.ms === 10000)) x.fn(); await assentar(); };
  return t;
}

// Frases dos validadores do servidor (src/envios.js), lidas na fonte: o cliente avisa antes, com as mesmas palavras.
const { validarTextoMensagem, validarEnquete } = await import('../src/envios.js');
const fraseDe = (fn) => { try { fn(); } catch (e) { return e.message; } assert.fail('o validador não recusou'); };
const SEM_TEXTO = fraseDe(() => validarTextoMensagem(''));
const SEM_PERGUNTA = fraseDe(() => validarEnquete({ pergunta: '', opcoes: ['a', 'b'] }));
const POUCAS_OPCOES = fraseDe(() => validarEnquete({ pergunta: 'P', opcoes: ['a'] }));
const OPCOES_REPETIDAS = fraseDe(() => validarEnquete({ pergunta: 'P', opcoes: ['Casa', ' casa '] }));

const BOM_DIA = [
  'Bom dia, pessoal! Hoje tem achadinho novo saindo ao longo do dia. Fiquem de olho aqui no grupo.',
  'Bom dia! Café na mão e olho nas ofertas. Daqui a pouco começam os achadinhos de hoje.',
  'Bom dia, gente! Quem já separou o que quer garantir hoje? As ofertas começam a sair por aqui.',
];
const TITULOS_MODELOS = ['Bom dia', 'Regras do grupo', 'Aviso de segurança', 'Prova social (convite)', 'Preço muda', 'Boa noite',
  'Enquete: o que ver mais', 'Enquete: já comprou', 'Enquete: melhor horário', 'Enquete: sextou'];

// =====================================================================================================================
// XSS: todo texto do dono sai escapado
// =====================================================================================================================

test('XSS: nome da rotina, textos, opções e nome de grupo maliciosos saem escapados no cartão', async () => {
  const groups = [{ jid: 'a@g.us', name: `Grupo ${XSS}`, size: 3 }, ...GRUPOS.slice(1)];
  const t = tela({ groups, rotinas: [
    rotina({ nome: `Rotina ${XSS}`, conteudos: [`Texto ${XSS}`, `*negrito* ${XSS}`], ultimo_erro_grupo: `Grupo ${XSS}`, erros_24h: 1, enviadas_24h: 2 }),
    enquete({ nome: `Enquete ${XSS}`, conteudos: [{ pergunta: `P ${XSS}`, opcoes: [`O1 ${XSS}`, 'O2'], multipla: true }] }),
  ] });
  await t.abrir();
  assert.equal(t.cartoes().length, 2);
  domLimpo(t.pag, 'lista');
  for (const r of t.rotinas) {
    t.ctx.__r = r;
    const html = t.rodar('cartaoRotinaViva(__r)');
    semMarcacao(html, 'cartão');
    assert.ok(html.includes(r.nome.replace(XSS, XSS_ESC)), html);
  }
  const [c0] = t.cartoes();
  assert.ok(limpo(c0.querySelector('h2').textContent).includes(`Rotina ${XSS}`), 'o nome chega à tela como texto');
  assert.equal(c0.querySelector('[data-act="gv-ligar"]').getAttribute('aria-label'), `Rotina ativa: Rotina ${XSS}`);
  assert.ok(limpo(c0.querySelector('.nivel-erro').textContent).includes(`Não foi para o grupo Grupo ${XSS}.`));
  t.ctx.__r = { ...t.rotinas[0], ultimo_erro_grupo: `G ${XSS}` };
  assert.ok(t.rodar('cartaoRotinaViva(__r)').includes(`G ${XSS_ESC}`));
});

test('XSS: o formulário de editar mostra nome, textos, pergunta, opções e grupos como texto, sem abrir tag', async () => {
  const groups = [{ jid: 'a@g.us', name: `Grupo ${XSS}`, size: 3 }, ...GRUPOS.slice(1)];
  const t = tela({ groups, rotinas: [
    rotina({ nome: `Rotina ${XSS}`, conteudos: [`Texto ${XSS}`, `*negrito* ${XSS}`, `</textarea>${XSS}`] }),
    enquete({ nome: `Enquete ${XSS}`, conteudos: [{ pergunta: `P ${XSS}`, opcoes: [`O1 ${XSS}`, 'O2'], multipla: true }], group_jids: ['a@g.us'] }),
  ] });
  await t.abrir();
  await t.clicar(t.acao(0, 'gv-editar'));
  domLimpo(t.dlg, 'formulário de mensagem');
  assert.equal(t.$('input[name=nome]').value, `Rotina ${XSS}`);
  assert.deepEqual(t.textos(), [`Texto ${XSS}`, `*negrito* ${XSS}`, `</textarea>${XSS}`], 'nem "</textarea>" fecha o campo');
  assert.ok(limpo(t.$('#gv-gr').textContent).includes(`Grupo ${XSS}`));
  // a prévia formata como o WhatsApp, mas o texto continua texto
  assert.equal(limpo(t.$('#gv-pv').textContent), `Texto ${XSS}`);
  await t.escrever(t.$$('#gv-conteudos textarea')[1], `*negrito* ${XSS}`);
  semMarcacao(t.$('#gv-pv').innerHTML, 'prévia');
  assert.equal(t.$('#gv-pv strong')?.textContent, 'negrito');
  await t.clicar(t.acao(1, 'gv-editar'));
  domLimpo(t.dlg, 'formulário de enquete');
  assert.equal(t.$('input[name=nome]').value, `Enquete ${XSS}`);
  assert.equal(t.$('#gv-conteudos input[data-campo="pergunta"]').value, `P ${XSS}`);
  assert.deepEqual(t.$$('#gv-conteudos input[data-op]').map((i) => i.value), [`O1 ${XSS}`, 'O2']);
  assert.equal(t.$('#gv-conteudos input[data-campo="multipla"]').checked, true);
  assert.ok(limpo(t.$('#gv-pv').textContent).includes(`P ${XSS}`));
  assert.ok(limpo(t.$('#gv-pv').textContent).includes(`O1 ${XSS}`));
  // os modelos da galeria passam pelo mesmo caminho: o HTML dela não abre tag
  semMarcacao(t.rodar('gvGaleriaHtml()'), 'galeria');
});

// =====================================================================================================================
// Estado vazio e galeria (CA12)
// =====================================================================================================================

test('estado vazio: sem rotina, a galeria aparece no lugar da lista, com os 10 modelos e "Criar do zero"; nada é salvo', async () => {
  const t = tela({ rotinas: [] });
  await t.abrir();
  assert.equal(titulo(t.p('h1')), 'Grupo vivo');
  assert.equal(t.cartoes().length, 0);
  assert.deepEqual(t.pp('#gv-lista .gv-modelo h3').map((h) => h.textContent), TITULOS_MODELOS);
  assert.equal(t.pp('#gv-lista .card.nivel-aviso, #gv-lista .gh-aviso').length, 0, 'sem card de aviso');
  assert.deepEqual(t.salvos(), []);
  await t.clicar(t.p('#gv-lista [data-gv-zero]'));
  assert.equal(t.dlg.open, true);
  assert.equal(titulo(t.$('h1')), 'Nova mensagem');
  assert.equal(t.$('input[name=nome]').value, '');
  assert.deepEqual(t.textos(), ['']);
  assert.deepEqual(t.salvos(), []);
});

test('CA12: "Modelos" abre a galeria; "Usar este modelo" preenche o formulário e nada é salvo até "Criar rotina"', async () => {
  const t = tela();
  await t.abrir();
  await t.clicar('#gv-modelos');
  assert.equal(t.dlg.open, true);
  const cards = t.$$('.gv-modelo');
  assert.deepEqual(cards.map((c) => c.querySelector('h3').textContent), TITULOS_MODELOS);
  assert.deepEqual(cards.map((c) => c.querySelector('.chip').textContent), [...Array(6).fill('Mensagem'), ...Array(4).fill('Enquete')]);
  const usar = cards[0].querySelector('button[data-modelo]');
  assert.equal(usar.textContent, 'Usar este modelo');
  assert.equal(usar.getAttribute('aria-label'), 'Usar o modelo Bom dia');
  await t.clicar(usar);
  assert.ok(t.$('#gv-f'), 'abriu o formulário');
  assert.equal(t.$('input[name=nome]').value, 'Bom dia');
  assert.deepEqual(t.textos(), BOM_DIA);
  assert.equal(t.$('#gv-ordem-box').hidden, false, 'com 3 textos aparece a Ordem');
  assert.equal(t.$('#gv-ordem button[data-v="rodizio"]').getAttribute('aria-checked'), 'true');
  assert.deepEqual(t.dias(), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(t.horarios(), ['08:00']);
  assert.equal(t.$('input[name=ligar]').checked, true);
  assert.equal(t.$('#gv-salvar').textContent, 'Criar rotina');
  assert.deepEqual(t.salvos(), [], 'usar o modelo não salva');
  // enquete do modelo
  await t.clicar('#gv-modelos');
  await t.clicar(t.$$('.gv-modelo')[6].querySelector('button[data-modelo]'));
  assert.equal(titulo(t.$('h1')), 'Nova enquete');
  assert.equal(t.$('#gv-tipo button[data-v="enquete"]').getAttribute('aria-checked'), 'true');
  assert.equal(t.$('#gv-conteudos input[data-campo="pergunta"]').value, 'O que você quer ver mais por aqui?');
  assert.deepEqual(t.$$('#gv-conteudos input[data-op]').map((i) => i.value), ['Casa e cozinha', 'Eletrônicos', 'Moda', 'Beleza', 'Ferramentas']);
  assert.equal(t.$('#gv-conteudos input[data-campo="multipla"]').checked, true);
  assert.deepEqual(t.dias(), [5]);
  assert.deepEqual(t.horarios(), ['12:00']);
  assert.deepEqual(t.salvos(), []);
  // edita e cria: só agora o POST, com o que está no formulário
  await t.escrever(t.$('#gv-conteudos input[data-campo="pergunta"]'), 'O que você quer ver mais?');
  await t.marcar('b@g.us');
  await t.enviar();
  const [post] = t.salvos();
  assert.equal(`${post.metodo} ${post.caminho}`, 'POST /api/rotinas');
  assert.deepEqual(post.corpo, {
    nome: 'Enquete: o que ver mais', tipo: 'enquete', ordem: 'rodizio', group_jids: ['b@g.us'], enabled: true,
    conteudos: [{ pergunta: 'O que você quer ver mais?', opcoes: ['Casa e cozinha', 'Eletrônicos', 'Moda', 'Beleza', 'Ferramentas'], multipla: true }],
    repetir: { dias: [5], horarios: ['12:00'] },
  });
});

test('CA12: os modelos têm os textos da spec, sem emoji, dentro dos limites do servidor', () => {
  const t = tela();
  const modelos = JSON.parse(t.rodar('JSON.stringify(MODELOS_GRUPO_VIVO)')); // fora do realm do vm
  assert.equal(modelos.length, 10);
  assert.deepEqual(modelos[0].conteudos, BOM_DIA);
  for (const m of modelos) {
    assert.ok(['mensagem', 'enquete'].includes(m.tipo), m.titulo);
    assert.ok(m.conteudos.length >= 1 && m.conteudos.length <= MAX_CONTEUDOS, m.titulo);
    assert.ok(m.repetir.horarios.length >= 1 && m.repetir.horarios.length <= MAX_HORARIOS_ROTINA, m.titulo);
    assert.ok(m.repetir.dias.length >= 1, m.titulo);
    assert.doesNotMatch(JSON.stringify(m), /\p{Extended_Pictographic}/u, `${m.titulo}: sem emoji`);
    for (const c of m.conteudos) {
      if (m.tipo === 'mensagem') assert.equal(validarTextoMensagem(c), c, m.titulo);
      else assert.deepEqual(validarEnquete(c), c, m.titulo);
    }
  }
});

// =====================================================================================================================
// CA11: formulário e o corpo do contrato
// =====================================================================================================================

test('CA11: "Nova mensagem" do zero manda o corpo do contrato (nome, tipo, conteúdos, ordem, grupos, repetir, enabled) e recarrega', async () => {
  const t = tela({ rotinas: [] });
  await t.abrir();
  await t.clicar('#gv-nova-msg');
  assert.equal(titulo(t.$('h1')), 'Nova mensagem');
  assert.equal(t.$('#gv-tipo button[data-v="mensagem"]').getAttribute('aria-checked'), 'true');
  assert.equal(t.$('#gv-ordem-box').hidden, true, 'com um texto só, sem Ordem');
  assert.equal(t.doc.activeElement, t.$('input[name=nome]'), 'foco inicial em Nome');
  await t.escrever(t.$('input[name=nome]'), '  Bom dia útil ');
  await t.escrever(t.$$('#gv-conteudos textarea')[0], 'Bom dia, pessoal!');
  await t.clicar('#gv-add');
  assert.equal(t.textos().length, 2);
  assert.equal(t.doc.activeElement, t.$$('#gv-conteudos textarea')[1], 'foco no texto novo');
  assert.equal(t.$('#gv-ordem-box').hidden, false);
  await t.escrever(t.$$('#gv-conteudos textarea')[1], ' Bom dia!\n');
  await t.clicar('#gv-ordem button[data-v="sorteio"]');
  await t.marcar('a@g.us'); await t.marcar('c@g.us');
  await t.dia(3); await t.dia(1);
  await t.addHora('18:00'); await t.addHora('08:00'); await t.addHora('08:00');
  assert.deepEqual(t.horarios(), ['08:00', '18:00'], 'em ordem e sem repetir');
  const antes = t.pedidos.filter((p) => p.metodo === 'GET' && p.caminho === '/api/rotinas').length;
  t.rotinas = [rotina({ id: 99, nome: 'Bom dia útil' })];
  await t.enviar();
  const [post] = t.salvos();
  assert.equal(`${post.metodo} ${post.caminho}`, 'POST /api/rotinas');
  assert.deepEqual(post.corpo, {
    nome: 'Bom dia útil', tipo: 'mensagem', conteudos: ['Bom dia, pessoal!', 'Bom dia!'], ordem: 'sorteio',
    group_jids: ['a@g.us', 'c@g.us'], repetir: { dias: [1, 3], horarios: ['08:00', '18:00'] }, enabled: true,
  });
  assert.equal(t.dlg.open, false);
  assert.deepEqual({ ...t.avisos.at(-1) }, { msg: 'Rotina criada', erro: false });
  assert.equal(t.pedidos.filter((p) => p.metodo === 'GET' && p.caminho === '/api/rotinas').length, antes + 1, 'recarrega a lista');
  assert.equal(t.cartoes().length, 1);
});

test('CA11: "Nova enquete": pergunta, opções (as vazias ficam de fora) e "mais de uma resposta"; trocar o tipo não perde o que foi escrito', async () => {
  const t = tela({ rotinas: [] });
  await t.abrir();
  await t.clicar('#gv-nova-enq');
  assert.equal(titulo(t.$('h1')), 'Nova enquete');
  await t.escrever(t.$('input[name=nome]'), 'Enquete da sexta');
  await t.escrever(t.$('#gv-conteudos input[data-campo="pergunta"]'), ' O que ver? ');
  const ops = t.$$('#gv-conteudos input[data-op]');
  assert.equal(ops.length, 2, 'começa com 2 opções');
  await t.escrever(ops[0], 'Casa'); await t.escrever(ops[1], ' Moda ');
  await t.clicar(t.$('#gv-conteudos [data-gv="add-opcao"]'));
  assert.equal(t.$$('#gv-conteudos input[data-op]').length, 3);
  const mult = t.$('#gv-conteudos input[data-campo="multipla"]'); mult.checked = true; await disparar(mult, 'change'); await assentar();
  // mensagem e volta: a enquete continua
  await t.clicar('#gv-tipo button[data-v="mensagem"]');
  assert.equal(t.$('#gv-conteudos input[data-campo="pergunta"]'), null);
  await t.escrever(t.$$('#gv-conteudos textarea')[0], 'rascunho');
  await t.clicar('#gv-tipo button[data-v="enquete"]');
  assert.equal(t.$('#gv-conteudos input[data-campo="pergunta"]').value, ' O que ver? ');
  assert.equal(t.$('#gv-conteudos input[data-campo="multipla"]').checked, true);
  await t.marcar('b@g.us'); await t.dia(5); await t.addHora('12:00');
  const lig = t.$('input[name=ligar]'); lig.checked = false; await disparar(lig, 'change'); await assentar();
  await t.enviar();
  const [post] = t.salvos();
  assert.deepEqual(post.corpo, {
    nome: 'Enquete da sexta', tipo: 'enquete', conteudos: [{ pergunta: 'O que ver?', opcoes: ['Casa', 'Moda'], multipla: true }], ordem: 'rodizio',
    group_jids: ['b@g.us'], repetir: { dias: [5], horarios: ['12:00'] }, enabled: false,
  });
  assert.equal(t.avisos.at(-1).msg, 'Rotina criada');
});

test('CA11: Editar abre com o que está salvo e manda PUT sem tipo nem enabled; Copiar abre uma rotina nova "(cópia)"', async () => {
  const t = tela({ rotinas: [rotina({ ordem: 'sorteio' })] });
  await t.abrir();
  await t.clicar(t.acao(0, 'gv-editar'));
  assert.equal(titulo(t.$('h1')), 'Editar rotina');
  assert.equal(t.$('#gv-tipo'), null, 'o tipo não muda depois de criada');
  assert.ok(limpo(t.$('#gv-tipo-fixo').textContent).includes('Mensagem'));
  assert.equal(t.$('input[name=nome]').value, 'Bom dia');
  assert.deepEqual(t.textos(), ['Bom dia, pessoal!', 'Bom dia!']);
  assert.equal(t.$('#gv-ordem button[data-v="sorteio"]').getAttribute('aria-checked'), 'true');
  assert.deepEqual(t.dias(), [1, 2, 3, 4, 5]);
  assert.deepEqual(t.horarios(), ['08:00', '18:00']);
  assert.deepEqual(t.$$('#gv-gr input').filter((i) => i.checked).map((i) => i.value), ['a@g.us', 'b@g.us']);
  assert.equal(t.$('input[name=ligar]'), null, 'ligar e pausar fica na chave do cartão');
  assert.equal(t.$('#gv-salvar').textContent, 'Salvar');
  await t.escrever(t.$('input[name=nome]'), 'Bom dia de semana');
  await t.clicar(t.$('#gv-horarios button[data-h="18:00"]'));
  await t.enviar();
  const [put] = t.salvos();
  assert.equal(`${put.metodo} ${put.caminho}`, 'PUT /api/rotinas/3');
  assert.deepEqual(put.corpo, {
    nome: 'Bom dia de semana', conteudos: ['Bom dia, pessoal!', 'Bom dia!'], ordem: 'sorteio',
    group_jids: ['a@g.us', 'b@g.us'], repetir: { dias: [1, 2, 3, 4, 5], horarios: ['08:00'] },
  });
  assert.deepEqual({ ...t.avisos.at(-1) }, { msg: 'Rotina salva', erro: false });
  // Copiar: formulário de rotina nova com os mesmos dados e "(cópia)" no nome
  await t.clicar(t.acao(0, 'gv-copiar'));
  assert.equal(titulo(t.$('h1')), 'Nova mensagem');
  assert.equal(t.$('input[name=nome]').value, 'Bom dia (cópia)');
  assert.deepEqual(t.textos(), ['Bom dia, pessoal!', 'Bom dia!']);
  assert.deepEqual(t.salvos().length, 1, 'copiar não salva sozinho');
  await t.enviar();
  const post = t.salvos().at(-1);
  assert.equal(`${post.metodo} ${post.caminho}`, 'POST /api/rotinas');
  assert.equal(post.corpo.nome, 'Bom dia (cópia)');
  assert.equal(post.corpo.tipo, 'mensagem');
  assert.equal(post.corpo.enabled, true);
});

test('cartão: resumo, próximo envio, contagem de 24 h e o grupo com erro (texto, nunca só cor); pausada mostra "Pausado"', async () => {
  const t = tela({ rotinas: [
    rotina({ enviadas_24h: 2, erros_24h: 1, ultimo_erro_grupo: 'Grupo B' }),
    enquete({ enabled: false, next_run_at: null }),
    rotina({ id: 5, nome: 'Boa noite', conteudos: ['Boa noite!'], repetir: { dias: [0, 1, 2, 3, 4, 5, 6], horarios: ['21:30'] }, group_jids: ['a@g.us', 'b@g.us', 'c@g.us'] }),
  ] });
  await t.abrir();
  const [c0, c1, c2] = t.cartoes();
  assert.equal(c0.querySelector('.chip').textContent, 'Mensagem');
  assert.equal(c1.querySelector('.chip').textContent, 'Enquete');
  assert.equal(limpo(c0.querySelector('.res').textContent), 'Seg a sex às 08:00 e 18:00. Para 2 grupos. 2 textos em rodízio.');
  assert.equal(limpo(c1.querySelector('.res').textContent), 'Sex às 12:00. Para 1 grupo.');
  assert.equal(limpo(c2.querySelector('.res').textContent), 'Todos os dias às 21:30. Para 3 grupos.');
  assert.match(limpo(c0.querySelector('.prox').textContent), /^Próximo envio (hoje|amanhã) às \d\d:\d\d$/);
  assert.equal(limpo(c1.querySelector('.prox').textContent), 'Pausado');
  assert.equal(limpo(c0.querySelector('.gv-24h').textContent), 'Últimas 24 h: 2 enviadas, 1 com erro.');
  assert.equal(limpo(c2.querySelector('.gv-24h').textContent), 'Últimas 24 h: nenhuma enviada.');
  assert.equal(limpo(c0.querySelector('.nivel-erro').textContent), '! Não foi para o grupo Grupo B. Veja o Histórico.');
  assert.equal(c0.querySelector('.nivel-erro a').getAttribute('href'), '#historico');
  assert.equal(c2.querySelector('.nivel-erro'), null);
  assert.equal(c1.querySelector('[data-act="gv-ligar"]').checked, false);
  assert.deepEqual(c0.querySelectorAll('.acoes button').map((b) => b.textContent), ['Enviar agora', 'Editar', 'Copiar', 'Excluir']);
  assert.equal(c0.querySelector('[data-act="gv-excluir"]').getAttribute('aria-label'), 'Excluir a rotina Bom dia');
});

test('cartão: ligar e pausar, Enviar agora (com confirmação) e Excluir (com confirmação) chamam as rotas e avisam', async () => {
  const t = tela({ rotinas: [rotina()] });
  await t.abrir();
  // pausar
  let chave = t.acao(0, 'gv-ligar'); chave.checked = false; await t.clicar(chave);
  assert.deepEqual(t.salvos().at(-1), { metodo: 'POST', caminho: '/api/rotinas/3/enabled', corpo: { enabled: false } });
  assert.deepEqual({ ...t.avisos.at(-1) }, { msg: 'Rotina pausada', erro: false });
  // erro ao ligar: a chave volta e o toast traz a frase do servidor
  t.rotas['POST /api/rotinas/3/enabled'] = () => [400, { erro: 'Ativo: ligue ou desligue.' }];
  chave = t.acao(0, 'gv-ligar'); chave.checked = false; await t.clicar(chave);
  assert.equal(chave.checked, true);
  assert.deepEqual({ ...t.avisos.at(-1) }, { msg: 'Ativo: ligue ou desligue.', erro: true });
  // Enviar agora: cancelado na confirmação, nada sai
  const n = t.salvos().length;
  t.confirmar = () => false;
  await t.clicar(t.acao(0, 'gv-enviar'));
  assert.equal(t.confirmacoes.at(-1), 'Enviar agora para 2 grupos?');
  assert.equal(t.salvos().length, n);
  t.confirmar = () => true;
  await t.clicar(t.acao(0, 'gv-enviar'));
  assert.deepEqual(t.salvos().at(-1), { metodo: 'POST', caminho: '/api/rotinas/3/enviar', corpo: null });
  assert.deepEqual({ ...t.avisos.at(-1) }, { msg: 'Enviando para 2 grupos.', erro: false });
  // Enviar agora com o WhatsApp fora: a frase do servidor no toast
  t.rotas['POST /api/rotinas/3/enviar'] = () => [400, { erro: 'O WhatsApp está desconectado. Conecte o número antes de disparar.' }];
  await t.clicar(t.acao(0, 'gv-enviar'));
  assert.deepEqual({ ...t.avisos.at(-1) }, { msg: 'O WhatsApp está desconectado. Conecte o número antes de disparar.', erro: true });
  // Excluir
  t.confirmar = () => false;
  await t.clicar(t.acao(0, 'gv-excluir'));
  assert.equal(t.confirmacoes.at(-1), 'Excluir a rotina “Bom dia”? O que já foi enviado continua no Histórico.');
  assert.notEqual(t.salvos().at(-1).metodo, 'DELETE');
  t.confirmar = () => true;
  t.rotinas = [];
  await t.clicar(t.acao(0, 'gv-excluir'));
  assert.deepEqual(t.salvos().at(-1), { metodo: 'DELETE', caminho: '/api/rotinas/3', corpo: null });
  assert.deepEqual({ ...t.avisos.at(-1) }, { msg: 'Rotina excluída', erro: false });
  assert.equal(t.cartoes().length, 0);
  assert.equal(t.pp('#gv-lista .gv-modelo').length, 10, 'sem rotina, volta a galeria');
});

// =====================================================================================================================
// CA11: limites de 5 conteúdos e 6 horários
// =====================================================================================================================

test('CA11: até 5 textos e 6 horários (os de /api/state.grade), com contador; o 6º texto e o 7º horário não entram', async () => {
  const t = tela({ rotinas: [] });
  await t.abrir();
  await t.clicar('#gv-nova-msg');
  assert.equal(limpo(t.$('#gv-cont-n').textContent), `1 de ${MAX_CONTEUDOS}`);
  for (let i = 1; i < MAX_CONTEUDOS; i++) await t.clicar('#gv-add');
  assert.equal(t.textos().length, MAX_CONTEUDOS);
  assert.equal(t.$('#gv-add').disabled, true);
  assert.equal(limpo(t.$('#gv-cont-n').textContent), `${MAX_CONTEUDOS} de ${MAX_CONTEUDOS}`);
  await disparar(t.$('#gv-add'), 'click'); await assentar();
  assert.equal(t.textos().length, MAX_CONTEUDOS, 'botão travado não acrescenta');
  // remover devolve a vaga; o foco vai ao texto anterior
  await t.clicar(t.$$('#gv-conteudos [data-gv="remover"]')[2]);
  assert.equal(t.textos().length, MAX_CONTEUDOS - 1);
  assert.equal(t.$('#gv-add').disabled, false);
  assert.equal(t.doc.activeElement, t.$$('#gv-conteudos textarea')[1]);
  // com um texto só, não há "Remover"
  while (t.textos().length > 1) await t.clicar(t.$$('#gv-conteudos [data-gv="remover"]')[0]);
  assert.equal(t.$$('#gv-conteudos [data-gv="remover"]').length, 0);
  // horários
  const horas = ['06:00', '09:00', '12:00', '15:00', '18:00', '21:00'];
  assert.equal(horas.length, MAX_HORARIOS_ROTINA);
  for (const h of horas) await t.addHora(h);
  assert.deepEqual(t.horarios(), horas);
  assert.equal(t.$('#gv-hor-add').disabled, true);
  assert.equal(t.$('#gv-hor-novo').disabled, true);
  assert.equal(limpo(t.$('#gv-hor-cont').textContent), `${MAX_HORARIOS_ROTINA} de ${MAX_HORARIOS_ROTINA}`);
  t.$('#gv-hor-novo').value = '23:00'; await disparar(t.$('#gv-hor-add'), 'click'); await assentar();
  assert.deepEqual(t.horarios(), horas, 'botão travado não acrescenta');
  await t.clicar(t.$('#gv-horarios button[data-h="12:00"]'));
  assert.equal(t.$('#gv-hor-add').disabled, false);
  assert.equal(t.horarios().length, MAX_HORARIOS_ROTINA - 1);
});

test('CA11: os limites vêm de /api/state.grade (sem eles, 5 e 6); enquete com até 12 opções', async () => {
  const t = tela({ rotinas: [], st: { grade: { max_conteudos: 2, max_horarios_rotina: 1 } } });
  await t.abrir();
  await t.clicar('#gv-nova-enq');
  await t.clicar('#gv-add');
  assert.equal(t.$$('#gv-conteudos input[data-campo="pergunta"]').length, 2);
  assert.equal(t.$('#gv-add').disabled, true);
  await t.addHora('08:00');
  assert.equal(t.$('#gv-hor-add').disabled, true);
  // opções: até 12 por enquete
  const add = () => t.$$('#gv-conteudos [data-gv="add-opcao"]')[0];
  for (let i = 2; i < 12; i++) await t.clicar(add());
  assert.equal(t.$$('#gv-conteudos li[data-i="0"] input[data-op]').length, 12);
  assert.equal(add().disabled, true);
  // sem os limites do servidor, valem os de src/rotinas.js
  const t2 = tela({ rotinas: [], st: { grade: undefined } });
  await t2.abrir();
  await t2.clicar('#gv-nova-msg');
  assert.equal(limpo(t2.$('#gv-cont-n').textContent), `1 de ${MAX_CONTEUDOS}`);
  assert.equal(limpo(t2.$('#gv-hor-cont').textContent), `0 de ${MAX_HORARIOS_ROTINA}`);
});

// =====================================================================================================================
// Erros: no cliente (as frases do servidor) e do servidor
// =====================================================================================================================

test('validação no cliente com as frases do servidor, sem chamar o servidor; com um texto só, sem a posição na frente', async () => {
  const t = tela({ rotinas: [] });
  await t.abrir();
  await t.clicar('#gv-nova-msg');
  await t.enviar();
  assert.deepEqual(t.erros(), ['Dê um nome à rotina.', SEM_TEXTO, 'Marque ao menos um grupo.', 'Marque ao menos um dia.', 'Adicione ao menos um horário.']);
  assert.equal(t.doc.activeElement, t.$('input[name=nome]'), 'foco no primeiro campo com erro');
  await t.clicar('#gv-add');
  await t.escrever(t.$$('#gv-conteudos textarea')[1], '   ');
  await t.escrever(t.$('input[name=nome]'), 'x'.repeat(61));
  await t.enviar();
  assert.deepEqual(t.erros().slice(0, 3), ['O nome pode ter até 60 letras.', `Texto 1: ${SEM_TEXTO}`, `Texto 2: ${SEM_TEXTO}`]);
  // enquete
  await t.clicar('#gv-tipo button[data-v="enquete"]');
  await t.enviar();
  assert.deepEqual(t.erros().slice(1, 2), [SEM_PERGUNTA]);
  await t.escrever(t.$('#gv-conteudos input[data-campo="pergunta"]'), 'P');
  await t.escrever(t.$$('#gv-conteudos input[data-op]')[0], 'Casa');
  await t.enviar();
  assert.deepEqual(t.erros().slice(1, 2), [POUCAS_OPCOES]);
  await t.escrever(t.$$('#gv-conteudos input[data-op]')[1], ' casa ');
  await t.enviar();
  assert.deepEqual(t.erros().slice(1, 2), [OPCOES_REPETIDAS]);
  await t.clicar('#gv-add');
  await t.enviar();
  assert.deepEqual(t.erros().slice(1, 3), [`Enquete 1: ${OPCOES_REPETIDAS}`, `Enquete 2: ${SEM_PERGUNTA}`]);
  assert.deepEqual(t.salvos(), [], 'nada foi ao servidor');
});

test('CA11: o erro do servidor aparece na caixa de erros, escapado, com o formulário aberto e o botão de volta', async () => {
  const t = tela({ rotinas: [] });
  t.rotas['POST /api/rotinas'] = () => [400, { erro: `Texto 2: Escreva a mensagem. ${XSS}` }];
  await t.abrir();
  await t.clicar('#gv-nova-msg');
  await t.escrever(t.$('input[name=nome]'), 'Bom dia');
  await t.escrever(t.$$('#gv-conteudos textarea')[0], 'Bom dia!');
  await t.marcar('a@g.us'); await t.dia(1); await t.addHora('08:00');
  await t.enviar();
  assert.equal(t.salvos().length, 1);
  assert.deepEqual(t.erros(), [`Texto 2: Escreva a mensagem. ${XSS}`]);
  domLimpo(t.dlg, 'erro do servidor');
  assert.equal(t.dlg.open, true);
  assert.equal(t.$('#gv-salvar').disabled, false);
  assert.equal(t.$('#gv-salvar').textContent, 'Criar rotina');
  // 500 com a frase genérica do servidor
  t.rotas['POST /api/rotinas'] = () => [500, { erro: 'Não consegui concluir. Tente de novo.' }];
  await t.enviar();
  assert.deepEqual(t.erros(), ['Não consegui concluir. Tente de novo.']);
});

test('lista: falha ao carregar mostra a frase escapada e "Tentar de novo"; sem grupos, "Criar rotina" fica travado com a razão', async () => {
  const t = tela({ rotinas: [], groups: [] });
  t.rotas['GET /api/rotinas'] = () => [500, { erro: `Falhou ${XSS}` }];
  await t.abrir();
  domLimpo(t.pag, 'erro da lista');
  assert.ok(limpo(t.p('#gv-lista').textContent).includes(`Falhou ${XSS}`));
  t.rotas['GET /api/rotinas'] = () => [200, [rotina()]];
  await t.clicar(t.p('#gv-lista [data-gv-recarregar]'));
  assert.equal(t.cartoes().length, 1);
  await t.clicar('#gv-nova-msg');
  assert.equal(t.$('#gv-salvar').disabled, true);
  assert.equal(t.$('#gv-salvar').getAttribute('aria-describedby'), 'gv-motivo');
  assert.ok(limpo(t.$('#gv-motivo').textContent).length > 0);
});

// =====================================================================================================================
// CA13: estimativa de mensagens por dia do número
// =====================================================================================================================

test('CA13: o formulário soma disparos e rotinas ligados com a rotina aberta e avisa acima de 400 por dia, sem bloquear', async () => {
  // regra com grade: 13 horários × 10 ofertas × 3 grupos = 390; rotina ligada: 3 horários × 3 grupos = 9; desligada não conta
  const horas = Array.from({ length: 13 }, (_, i) => ({ hora: `${String(8 + i).padStart(2, '0')}:00`, qtd: 10, template_id: null }));
  const rules = [{ id: 1, enabled: true, group_jids: ['a@g.us', 'b@g.us', 'c@g.us'], grade: { dias: [0, 1, 2, 3, 4, 5, 6], horarios: horas } }];
  const ligada = rotina({ group_jids: ['a@g.us', 'b@g.us', 'c@g.us'], repetir: { dias: [1], horarios: ['08:00', '12:00', '18:00'] } });
  const desligada = enquete({ enabled: false, group_jids: ['a@g.us', 'b@g.us', 'c@g.us'], repetir: { dias: [1], horarios: ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00'] } });
  const t = tela({ rules, rotinas: [ligada, desligada] });
  await t.abrir();
  // editar a rotina ligada: ela conta uma vez só (399)
  await t.clicar(t.acao(0, 'gv-editar'));
  assert.equal(t.$('#gv-aviso').hidden, true);
  // nova: 399 + 1 grupo × 1 horário = 400 (não passa); 2 horários = 401 (passa)
  await t.clicar('#gv-nova-msg');
  await t.marcar('a@g.us'); await t.addHora('08:00');
  assert.equal(t.$('#gv-aviso').hidden, true);
  await t.addHora('09:00');
  assert.equal(t.$('#gv-aviso').hidden, false);
  assert.equal(limpo(t.$('#gv-aviso').textContent),
    '! Com os disparos e as rotinas ligados, este número enviaria cerca de 401 mensagens por dia. Acima de 400 aumenta o risco de bloqueio do WhatsApp. Para baixar: menos horários ou menos grupos.');
  // não bloqueia
  await t.escrever(t.$('input[name=nome]'), 'Mais uma'); await t.escrever(t.$$('#gv-conteudos textarea')[0], 'Oi'); await t.dia(1);
  await t.enviar();
  assert.equal(t.salvos().at(-1).metodo, 'POST');
  assert.equal(t.erros().length, 0);
});

// =====================================================================================================================
// D2: a lista se atualiza sozinha; S1: teto de rotinas e freio do "Enviar agora" (frases do servidor)
// =====================================================================================================================

test('D2: a lista se atualiza sozinha a cada 10 s na tela do Grupo vivo, sem diálogo aberto, sem roubar o foco e sem repintar à toa', async () => {
  const t = tela({ rotinas: [rotina({ next_run_at: Date.now() - 1000 })] });
  await t.abrir();
  const prox = () => limpo(t.cartoes()[0].querySelector('.prox').textContent);
  const gets = () => t.pedidos.filter((p) => p.metodo === 'GET' && p.caminho === '/api/rotinas').length;
  assert.equal(prox(), 'Enviando em instantes');
  assert.equal(t.intervalos.filter((x) => x.ms === 10000).length, 2, 'o do Disparo automático e o do Grupo vivo');
  // nada mudou: busca, mas não repinta (o cartão continua o mesmo nó)
  const card = t.cartoes()[0]; let n = gets();
  await t.tique();
  assert.equal(gets(), n + 1);
  assert.equal(t.cartoes()[0], card);
  // o envio saiu: o próximo horário e a contagem de 24 h chegam sem recarregar a página
  t.rotinas = [rotina({ next_run_at: Date.now() + 3600000, enviadas_24h: 1 })];
  await t.tique();
  assert.match(prox(), /^Próximo envio (hoje|amanhã) às \d\d:\d\d$/);
  assert.equal(limpo(t.cartoes()[0].querySelector('.gv-24h').textContent), 'Últimas 24 h: 1 enviada.');
  // foco dentro da lista: não repinta (o foco se perderia)
  const editar = t.acao(0, 'gv-editar'); editar.focus();
  t.rotinas = [rotina({ enabled: false, next_run_at: null })];
  await t.tique();
  assert.equal(t.doc.activeElement, editar);
  assert.match(prox(), /^Próximo envio/);
  editar.blur();
  await t.tique();
  assert.equal(prox(), 'Pausado');
  // diálogo aberto: nem busca
  await t.clicar('#gv-nova-msg');
  assert.equal(t.dlg.open, true);
  n = gets(); await t.tique();
  assert.equal(gets(), n);
  t.dlg.close();
  // carga pedida pelo dono ainda em andamento: a automática não a atropela
  let soltar = null;
  t.rotas['GET /api/rotinas'] = () => new Promise((r) => { soltar = () => r([200, t.rotinas]); });
  t.rodar('gvCarregar()'); await assentar();
  n = gets(); await t.tique();
  assert.equal(gets(), n);
  soltar(); await assentar();
  // falha numa atualização automática: fica o que está na tela (sem a frase de erro nem "Tentar de novo")
  t.rotas['GET /api/rotinas'] = () => [500, { erro: 'Falhou' }];
  await t.tique();
  assert.equal(t.cartoes().length, 1);
  assert.equal(t.p('#gv-lista [data-gv-recarregar]'), null);
  // fora da tela do Grupo vivo: não busca
  t.rotas['GET /api/rotinas'] = () => [200, t.rotinas];
  t.ctx.location.hash = '#visao';
  n = gets(); await t.tique();
  assert.equal(gets(), n);
});

test('S1: teto de rotinas e freio do "Enviar agora": a frase do servidor aparece (caixa de erros no formulário, toast no cartão)', async () => {
  const t = tela({ rotinas: [rotina()] });
  const TETO = 'Frase do teto de rotinas que o servidor mandar.';
  const FREIO = 'Frase do freio de 1 minuto que o servidor mandar.';
  t.rotas['POST /api/rotinas'] = () => [400, { erro: TETO }];
  t.rotas['POST /api/rotinas/3/enviar'] = () => [429, { erro: FREIO }];
  await t.abrir();
  await t.clicar(t.acao(0, 'gv-copiar'));
  await t.enviar();
  assert.equal(t.salvos().at(-1).metodo, 'POST');
  assert.deepEqual(t.erros(), [TETO]);
  assert.equal(t.dlg.open, true, 'o formulário continua aberto');
  t.dlg.close();
  await t.clicar(t.acao(0, 'gv-enviar'));
  assert.deepEqual({ ...t.avisos.at(-1) }, { msg: FREIO, erro: true });
  assert.equal(t.cartoes().length, 1);
});

// =====================================================================================================================
// Menu, rota e link no Disparar mensagem
// =====================================================================================================================

test('menu e rota: "Grupo vivo" logo depois de "Disparar mensagem", grupovivo.js antes de app.js, rota grupo-vivo e o link no .sub', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const t = tela();
  const itens = t.doc.querySelector('#ng-disparos').parentElement.querySelectorAll('a').map((a) => [a.getAttribute('href'), a.textContent]);
  assert.deepEqual(itens, [['#disparo-manual', 'Disparo manual'], ['#disparo-automatico', 'Disparo automático'], ['#disparar-mensagem', 'Disparar mensagem'],
    ['#grupo-vivo', 'Grupo vivo'], ['#templates', 'Templates']]);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.indexOf('grupovivo.js') > scripts.indexOf('grade.js') && scripts.indexOf('grupovivo.js') < scripts.indexOf('app.js'), scripts.join(' '));
  assert.equal(t.rodar("Object.hasOwn(ROTAS, 'grupo-vivo')"), true);
  assert.equal(t.rodar('rotaAtual()'), 'grupo-vivo');
  assert.equal(t.rodar("let __chamou = false; paginaGrupoVivo = () => { __chamou = true; }; ROTAS['grupo-vivo'](); __chamou"), true);
  assert.match(t.rodar('TEXTOS_DISPAROS.mensagem.sub'), /<a href="#grupo-vivo">Grupo vivo<\/a>/);
  assert.match(fs.readFileSync(path.join(PUB, 'style.css'), 'utf8'), /nav a\[href="#grupo-vivo"\] \{ --ic:url\(/, 'ícone do menu');
});
