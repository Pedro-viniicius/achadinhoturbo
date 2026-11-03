// Seletor de grupos do painel (`seletorGrupos` e `filtroGrupos` de public/app.js, etapa 9 do plano espelhamento-amazon):
// com prefixo vazio os ids e o comportamento são os de sempre; com prefixo, dois seletores convivem na mesma raiz.
// As duas funções são extraídas do app.js (que não dá para carregar inteiro sem o painel) e rodam num `vm` com um DOM
// mínimo: o bastante para o markup do seletor e para as consultas que ele faz. Nenhuma rede, nenhum servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fonte = fs.readFileSync(path.join(RAIZ, 'public', 'app.js'), 'utf8');

// ---- extrai `esc`, `filtroGrupos` e `seletorGrupos` do app.js ----
const linhaEsc = fonte.split('\n').find((l) => l.startsWith('const esc = '));
const ini = fonte.indexOf('function filtroGrupos(');
const fim = fonte.indexOf('function fonteHtml(');
assert.ok(linhaEsc && ini > 0 && fim > ini, 'não achei esc/filtroGrupos/seletorGrupos em public/app.js');
const trecho = `${linhaEsc}\n${fonte.slice(ini, fim)}`;

// ---- DOM mínimo ----
const decod = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
class El {
  constructor(tag, attrs = {}) {
    this.tag = tag; this.attrs = attrs; this.children = []; this.parent = null; this.text = '';
    this.checked = 'checked' in attrs; this.dataset = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5)] = v;
    this.value = attrs.value ?? '';
    this.hidden = false; this.textContent = ''; this.classList = { toggle() {} };
  }
  get id() { return this.attrs.id || ''; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  descendentes() { return this.children.flatMap((c) => [c, ...c.descendentes()]); }
}
function parsear(html) {
  const raiz = new El('raiz'); let atual = raiz;
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/g)) {
    if (m[4] !== undefined) { atual.text += decod(m[4]); continue; }
    const [, fecha, tag, resto] = m;
    if (fecha) { atual = atual.parent || raiz; continue; }
    const attrs = {};
    for (const a of resto.matchAll(/([a-z][\w-]*)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : decod(a[2]);
    const el = new El(tag, attrs); el.parent = atual; atual.children.push(el);
    if (!['input', 'br', 'img'].includes(tag)) atual = el;
  }
  return raiz;
}
// Um passo do seletor: tag?, #id?, :checked?, :not([hidden])?
const casa = (el, passo) => {
  const m = passo.match(/^([a-z]+)?(?:#([\w-]+))?(:checked)?(:not\(\[hidden\]\))?$/);
  if (!m) throw new Error(`seletor fora do mínimo do teste: ${passo}`);
  return (!m[1] || el.tag === m[1]) && (!m[2] || el.id === m[2]) && (!m[3] || el.checked) && (!m[4] || !el.hidden);
};
function consulta(sel, raiz) {
  const passos = sel.split(' '); let atuais = [raiz];
  for (const p of passos) atuais = [...new Set(atuais.flatMap((a) => a.descendentes().filter((d) => casa(d, p))))];
  return atuais;
}

function carregar({ grupos, blocos = [] }) {
  const ctx = { S: { groups: grupos, blocks: blocos }, $: (s, r) => consulta(s, r)[0] || null, $$: (s, r) => consulta(s, r) };
  vm.createContext(ctx);
  vm.runInContext(`${trecho}\nthis.seletorGrupos = seletorGrupos;`, ctx);
  return ctx.seletorGrupos;
}

const GRUPOS = [
  { jid: '1@g.us', name: 'Achados Eletrônicos', size: 10 },
  { jid: '2@g.us', name: 'Promoções Casa', size: 20 },
  { jid: '3@g.us', name: 'Achadinhos Tech', size: 30 },
];
const BLOCOS = [{ id: 7, name: 'Bloco Tech', group_jids: ['1@g.us', '3@g.us'] }];
const marcar = (raiz, id, jid, v = true) => { consulta(`#${id} input`, raiz).find((i) => i.value === jid).checked = v; };
const visiveis = (raiz, id) => consulta(`#${id} label`, raiz).filter((l) => !l.hidden).map((l) => l.dataset.n);
const ids = (raiz) => raiz.descendentes().map((e) => e.id).filter(Boolean);

test('prefixo vazio: os ids são os de sempre e o rótulo da busca é "Buscar grupo"', () => {
  const seletorGrupos = carregar({ grupos: GRUPOS, blocos: BLOCOS });
  const g = seletorGrupos({ blocos: true });
  const raiz = parsear(g.html);
  assert.deepEqual(ids(raiz), ['bloco-atalho', 'busca', 'so-marcados', 'todos', 'nenhum', 'gr']);
  assert.equal(consulta('#busca', raiz)[0].getAttribute('aria-label'), 'Buscar grupo');
  assert.equal(consulta('#gr label', raiz).length, 3);
});

test('prefixo vazio: busca, "Só marcados", "Marcar visíveis", "Limpar", atalho de bloco, contador e marcados', () => {
  const seletorGrupos = carregar({ grupos: GRUPOS, blocos: BLOCOS });
  const g = seletorGrupos({ selecionados: ['2@g.us'], blocos: true });
  const raiz = parsear(g.html);
  const contador = { textContent: '' }; const mudancas = []; let bloco = null;
  const aplica = g.ligar(raiz, { contador, aoMudar: (n) => mudancas.push(n), aoBloco: (b) => { bloco = b; } });
  assert.equal(typeof aplica, 'function');
  assert.equal(contador.textContent, '(1 selecionado)');
  assert.deepEqual(g.marcados(raiz), ['2@g.us']);

  const busca = consulta('#busca', raiz)[0]; busca.value = 'achad'; busca.oninput();
  assert.deepEqual(visiveis(raiz, 'gr'), ['achados eletrônicos', 'achadinhos tech']);
  consulta('#todos', raiz)[0].onclick();
  assert.deepEqual(g.marcados(raiz).sort(), ['1@g.us', '2@g.us', '3@g.us']);
  assert.equal(contador.textContent, '(3 selecionados)');

  busca.value = ''; busca.oninput();
  marcar(raiz, 'gr', '1@g.us', false); consulta('#gr', raiz)[0].onchange();
  const so = consulta('#so-marcados', raiz)[0]; so.onclick();
  assert.equal(so.getAttribute('aria-pressed'), 'true');
  assert.equal(so.textContent, 'Só marcados (2)');
  assert.deepEqual(visiveis(raiz, 'gr'), ['promoções casa', 'achadinhos tech']);

  consulta('#nenhum', raiz)[0].onclick();
  assert.deepEqual(g.marcados(raiz), []);
  assert.equal(contador.textContent, '(0 selecionados)');
  assert.equal(mudancas.at(-1), 0);

  const atalho = consulta('#bloco-atalho', raiz)[0]; atalho.value = '7'; atalho.onchange();
  assert.deepEqual(g.marcados(raiz).sort(), ['1@g.us', '3@g.us']);
  assert.equal(bloco.id, 7);
  assert.equal(atalho.value, '');
});

test('marcarVisiveis: false tira só o botão "Marcar visíveis"', () => {
  const seletorGrupos = carregar({ grupos: GRUPOS });
  const g = seletorGrupos({ marcarVisiveis: false });
  const raiz = parsear(g.html);
  assert.deepEqual(ids(raiz), ['busca', 'so-marcados', 'nenhum', 'gr']);
  g.ligar(raiz, {});
});

test('com prefixo: todos os ids ganham o prefixo e o rótulo da busca vem de rotuloBusca (escapado)', () => {
  const seletorGrupos = carregar({ grupos: GRUPOS, blocos: BLOCOS });
  const g = seletorGrupos({ prefixo: 'esp-', rotuloBusca: 'Buscar grupo de "destino"', blocos: true });
  const raiz = parsear(g.html);
  assert.deepEqual(ids(raiz), ['esp-bloco-atalho', 'esp-busca', 'esp-so-marcados', 'esp-todos', 'esp-nenhum', 'esp-gr']);
  assert.equal(consulta('#esp-busca', raiz)[0].getAttribute('aria-label'), 'Buscar grupo de "destino"');
  assert.match(g.html, /aria-label="Buscar grupo de &quot;destino&quot;"/);
  assert.equal(consulta('#gr', raiz).length, 0);
});

test('dois seletores na mesma raiz (sem prefixo e com prefixo) não se misturam', () => {
  const seletorGrupos = carregar({ grupos: GRUPOS, blocos: BLOCOS });
  const a = seletorGrupos({ selecionados: ['1@g.us'], blocos: true });
  const b = seletorGrupos({ prefixo: 'esp-', selecionados: ['2@g.us'], blocos: true, rotuloBusca: 'Buscar grupo de origem' });
  const raiz = parsear(`<div>${a.html}</div><div>${b.html}</div>`);
  const ca = { textContent: '' }; const cb = { textContent: '' };
  a.ligar(raiz, { contador: ca }); b.ligar(raiz, { contador: cb });
  assert.deepEqual(a.marcados(raiz), ['1@g.us']);
  assert.deepEqual(b.marcados(raiz), ['2@g.us']);

  // filtro de um não esconde nada no outro
  const buscaB = consulta('#esp-busca', raiz)[0]; buscaB.value = 'casa'; buscaB.oninput();
  assert.deepEqual(visiveis(raiz, 'esp-gr'), ['promoções casa']);
  assert.equal(visiveis(raiz, 'gr').length, 3);

  // "Marcar visíveis" de B só mexe em B
  consulta('#esp-todos', raiz)[0].onclick();
  assert.deepEqual(b.marcados(raiz), ['2@g.us']);
  assert.deepEqual(a.marcados(raiz), ['1@g.us']);
  buscaB.value = ''; buscaB.oninput();
  consulta('#todos', raiz)[0].onclick();
  assert.deepEqual(a.marcados(raiz).sort(), ['1@g.us', '2@g.us', '3@g.us']);
  assert.deepEqual(b.marcados(raiz), ['2@g.us']);
  assert.equal(ca.textContent, '(3 selecionados)');
  assert.equal(cb.textContent, '(1 selecionado)');

  // "Limpar" e atalho de bloco de B só mexem em B
  const atalhoB = consulta('#esp-bloco-atalho', raiz)[0]; atalhoB.value = '7'; atalhoB.onchange();
  assert.deepEqual(b.marcados(raiz).sort(), ['1@g.us', '2@g.us', '3@g.us']);
  consulta('#esp-nenhum', raiz)[0].onclick();
  assert.deepEqual(b.marcados(raiz), []);
  assert.equal(a.marcados(raiz).length, 3);

  // "Só marcados" de B só mexe em B
  marcar(raiz, 'esp-gr', '3@g.us'); consulta('#esp-gr', raiz)[0].onchange();
  consulta('#esp-so-marcados', raiz)[0].onclick();
  assert.deepEqual(visiveis(raiz, 'esp-gr'), ['achadinhos tech']);
  assert.equal(visiveis(raiz, 'gr').length, 3);
  assert.equal(consulta('#so-marcados', raiz)[0].getAttribute('aria-pressed'), 'false');
});

test('sem grupos carregados: só a dica, e ligar não faz nada nem quebra (com e sem prefixo)', () => {
  const seletorGrupos = carregar({ grupos: [] });
  for (const prefixo of [undefined, 'esp-']) {
    const g = seletorGrupos({ prefixo });
    assert.match(g.html, /Nenhum grupo carregado/);
    const raiz = parsear(g.html);
    assert.equal(typeof g.ligar(raiz, {}), 'function');
    assert.deepEqual(g.marcados(raiz), []);
  }
});
