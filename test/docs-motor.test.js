// Docs do sistema, rodada 1 de correção do motor (public/docs.js): ordem dos resultados da busca (D7), apêndices sem
// "O que você vai aprender" e sem tempo de leitura (D8), anúncio do "Próximo" (D10), classe do bloco de comando (D6)
// e o placeholder da busca. Arquivo à parte de test/docs.test.js, que outro dev edita.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(RAIZ, 'public');
const fonte = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8');
const scriptsIndex = () => [...fonte('index.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

/** docs.js num vm; com `capitulos`, os capítulos reais; com `falsos`, capítulos de teste registrados no lugar deles. */
function carregar(ctxExtra = {}, { capitulos = false, falsos = [] } = {}) {
  const ctx = vm.createContext({ ...ctxExtra });
  vm.runInContext(fonte('docs.js'), ctx, { filename: 'public/docs.js' });
  if (capitulos) for (const arq of scriptsIndex().filter((s) => s.startsWith('docs/'))) vm.runInContext(fonte(arq), ctx, { filename: 'public/' + arq });
  for (const cap of falsos) vm.runInContext(`docsCapitulo(${JSON.stringify(cap)})`, ctx);
  return { ctx, rodar: (c) => vm.runInContext(c, ctx), json: (expr) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx) ?? 'null') };
}
const semTags = (html) => html.replace(/<[^>]*>/g, ' ');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- D7: ordem da busca -------------------------------------------------------------------------------------
const FALSOS_BUSCA = [
  { id: 'primeiros-passos', titulo: 'Começo', aprenda: ['a', 'b'], secoes: [
    { id: 'a', titulo: 'Outra coisa', blocos: [{ p: 'Fale do backup aqui.' }] }] },
  { id: 'conexoes', titulo: 'Backup da loja', aprenda: ['a', 'b'], secoes: [
    { id: 'x', titulo: 'Texto', blocos: [{ p: 'O backup fica no disco.' }] }] },
  { id: 'templates', titulo: 'Modelos', aprenda: ['a', 'b'], secoes: [
    { id: 'b', titulo: 'Fazer BACKUP agora', blocos: [{ p: 'Passo a passo.' }] },
    { id: 'c', titulo: 'Mais', blocos: [{ p: 'Outro backup.' }] }] },
];
const chave = (r) => r.cap + '/' + r.secao;

test('busca (D7): título da seção primeiro, depois título do capítulo, depois o texto; a ordem do sumário vale dentro de cada grupo', () => {
  const X = carregar({}, { falsos: FALSOS_BUSCA });
  const r = X.json('docsBuscar("backup")');
  assert.deepEqual(r.map(chave), ['templates/b', 'conexoes/', 'conexoes/x', 'primeiros-passos/a', 'templates/c']);
  for (const x of r) assert.deepEqual(Object.keys(x).sort(), ['cap', 'secao', 'titulo', 'trecho'], 'o grupo de ordenação não vaza para o resultado');
  // sem acento e com maiúsculas: o título casa igual
  const Y = carregar({}, { falsos: [{ id: 'conexoes', titulo: 'Conexões', aprenda: ['a', 'b'], secoes: [
    { id: 'z', titulo: 'Texto solto', blocos: [{ p: 'Reconexão do WhatsApp.' }] }, { id: 'y', titulo: 'RECONEXÃO', blocos: [{ p: 'Passos.' }] }] }] });
  assert.deepEqual(Y.json('docsBuscar("reconexao")').map(chave), ['conexoes/y', 'conexoes/z']);
  // com vários termos vale o título que tiver algum deles (todos precisam estar na mesma seção)
  assert.deepEqual(X.json('docsBuscar("backup passo")').map(chave), ['templates/b']);
  // o HTML da busca segue a mesma ordem
  const html = X.json('docsHtmlBusca("backup")').html;
  const hrefs = [...html.matchAll(/<li><a href="(#docs[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ['#docs/templates/b', '#docs/conexoes', '#docs/conexoes/x', '#docs/primeiros-passos/a', '#docs/templates/c']);
});

test('busca (D7): nos capítulos reais, os grupos vêm em ordem não decrescente e nenhum achado some', () => {
  const X = carregar({}, { capitulos: true });
  const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  for (const termo of ['amazon', 'backup', 'catalogo', 'tag', 'de']) {
    const r = X.json(`docsBuscar(${JSON.stringify(termo)})`);
    assert.ok(r.length > 0, termo);
    const grupo = (a) => {
      const capTitulo = X.rodar(`docsPlano(docsCap(${JSON.stringify(a.cap)}).titulo)`);
      return a.secao && norm(a.titulo).includes(norm(termo)) ? 0 : norm(capTitulo).includes(norm(termo)) ? 1 : 2;
    };
    const gs = r.map(grupo);
    assert.deepEqual(gs, [...gs].sort((a, b) => a - b), `${termo}: grupos fora de ordem`);
    assert.equal(new Set(r.map(chave)).size, r.length, `${termo}: achado repetido`);
    // dentro do grupo, a ordem do sumário (capítulo na trilha, seção na ordem do arquivo)
    const pos = (a) => { const trilha = X.json('DOCS_TRILHA.map((t) => t.id)'); const secs = X.json(`docsSecoes(docsCap(${JSON.stringify(a.cap)})).map((s) => s.id)`); return trilha.indexOf(a.cap) * 1000 + (a.secao ? secs.indexOf(a.secao) + 1 : 0); };
    for (let i = 1; i < r.length; i++) if (gs[i] === gs[i - 1]) assert.ok(pos(r[i]) > pos(r[i - 1]), `${termo}: ${chave(r[i - 1])} antes de ${chave(r[i])}`);
  }
  // "amazon" tem seção com o termo no título: vem antes de qualquer achado só de texto
  const amazon = X.json('docsBuscar("amazon")');
  assert.equal(amazon[0].secao !== '' && norm(amazon[0].titulo).includes('amazon'), true, 'a primeira é seção com "Amazon" no título');
});

test('busca: o placeholder do campo é "Ex.: tag da Amazon, backup"', () => {
  const X = carregar({}, { falsos: [] });
  assert.equal(X.rodar('DOCS_TEXTOS.buscaPh'), 'Ex.: tag da Amazon, backup');
});

// ---- D8: apêndices -------------------------------------------------------------------------------------------
const CAP_FALSO = (id, extra = {}) => ({ id, titulo: 'Título ' + id, aprenda: ['Aprender zebra', 'Outro item'], antes: ['Ter o painel aberto'], secoes: [{ id: 's', titulo: 'Seção', blocos: [{ p: 'Texto da seção.' }] }], ...extra });

test('apêndice (D8): sem "O que você vai aprender" e com "Consulta" no lugar de "Leitura: N min"; a trilha fica como era', () => {
  const X = carregar({}, { falsos: [CAP_FALSO('conexoes'), CAP_FALSO('perguntas'), CAP_FALSO('referencia')] });
  for (const id of ['perguntas', 'referencia']) {
    const html = X.rodar(`docsHtmlCapitulo(${JSON.stringify(id)})`);
    assert.doesNotMatch(html, /O que você vai aprender/); assert.doesNotMatch(html, /docs-aprenda/); assert.doesNotMatch(html, /Aprender zebra/);
    assert.doesNotMatch(html, /Leitura:/);
    assert.match(html, /<p class="docs-leitura">Consulta<\/p>/);
    assert.match(html, /<p class="docs-cap-n">Apêndice<\/p>/);
    assert.match(html, /Antes de começar/, '"Antes de começar" continua, se houver');
    assert.match(html, /Nesta página/, 'o índice do apêndice continua');
  }
  const trilha = X.rodar('docsHtmlCapitulo("conexoes")');
  assert.match(trilha, /O que você vai aprender/); assert.match(trilha, /Aprender zebra/); assert.match(trilha, /<p class="docs-leitura">Leitura: \d+ min<\/p>/); assert.doesNotMatch(trilha, /Consulta/);
});

test('apêndice (D8): nos capítulos reais, Perguntas reais e Referência não mostram o aprender nem o tempo; a trilha mostra', () => {
  const X = carregar({}, { capitulos: true });
  for (const id of ['perguntas', 'referencia']) {
    const html = X.rodar(`docsHtmlCapitulo(${JSON.stringify(id)})`);
    assert.doesNotMatch(html, /O que você vai aprender/, id); assert.doesNotMatch(html, /Leitura: \d+ min/, id); assert.match(html, />Consulta</, id);
  }
  for (const id of X.json('DOCS_TRILHA.filter((t) => t.numero != null).map((t) => t.id)')) {
    const html = X.rodar(`docsHtmlCapitulo(${JSON.stringify(id)})`);
    assert.match(html, /O que você vai aprender/, id); assert.match(html, /Leitura: \d+ min/, id);
  }
});

test('busca (D8): o que o apêndice não mostra (o "aprender") não vira resultado; na trilha continua valendo', () => {
  const X = carregar({}, { falsos: [CAP_FALSO('conexoes'), CAP_FALSO('perguntas')] });
  assert.deepEqual(X.json('docsBuscar("zebra")').map(chave), ['conexoes/'], 'só o capítulo da trilha');
  // o "antes" do apêndice continua na tela e na busca
  assert.deepEqual(X.json('docsBuscar("painel aberto")').map(chave), ['conexoes/', 'perguntas/']);
});

// ---- D6: classe do bloco de comando -----------------------------------------------------------------------------
test('bloco de comando (D6): o <pre> leva a classe docs-cmd-pre e o restante da marcação não muda', () => {
  const X = carregar({}, { falsos: [] });
  const html = X.rodar('docsHtmlBloco({ comando: "npm run backup -- <x>" })');
  assert.match(html, /^<div class="docs-cmd"><pre class="docs-cmd-pre" tabindex="0" aria-label="Comando"><code>npm run backup -- &lt;x&gt;<\/code><\/pre>/);
  assert.match(html, /<button type="button" class="leve" data-docs-copiar>Copiar<\/button><p class="docs-cmd-erro" hidden><\/p><\/div>$/);
  assert.doesNotMatch(semTags(X.rodar('docsHtmlBloco({ exemplo: "a" })')), /docs-cmd-pre/);
});

// ---- D10: "Próximo" anuncia o capítulo como lido ----------------------------------------------------------------------
/** Mini-DOM do docs.test.js: #pagina guarda o HTML e getElementById devolve elemento falso para ids presentes. */
function montarPagina({ storage = true } = {}) {
  const els = new Map(); let html = ''; const doc = { title: 'x', activeElement: null };
  const elemento = (id) => ({ id, textContent: '', value: '', open: false, hidden: false, onclick: null, focus() { doc.activeElement = this; }, scrollIntoView() {}, querySelector: () => null });
  const pagina = { id: 'pagina', onclick: null, get innerHTML() { return html; }, set innerHTML(v) { html = String(v); els.clear(); } };
  doc.getElementById = (id) => { if (id === 'pagina') return pagina; if (!html.includes(`id="${id}"`)) return null; if (!els.has(id)) els.set(id, elemento(id)); return els.get(id); };
  const guardado = new Map();
  const ctx = { document: doc, location: { hash: '#docs' }, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimeout, addEventListener() {}, scrollTo() {} };
  if (storage) ctx.localStorage = { getItem: (k) => (guardado.has(k) ? guardado.get(k) : null), setItem: (k, v) => guardado.set(k, String(v)), removeItem: (k) => guardado.delete(k) };
  const X = carregar(ctx, { capitulos: true });
  return { ...X, doc, pagina, status: () => doc.getElementById('docs-status')?.textContent, lidos: () => X.json('docsLidos()') };
}
const clique = (seletor) => { const a = { closest: (s) => (s === seletor ? a : null) }; return { target: a, preventDefault() {} }; };

test('"Próximo" (D10): marca como lido e anuncia "Capítulo N marcado como lido"; a página seguinte junta o aviso com a posição', async () => {
  const p = montarPagina();
  p.rodar('paginaDocs("docs/conexoes")');
  p.pagina.onclick(clique('.docs-nav-prox'));
  assert.deepEqual(p.lidos(), ['conexoes']);
  assert.equal(p.status(), '', 'o anúncio entra depois de uma pausa, como os outros');
  await esperar(150);
  assert.equal(p.status(), 'Capítulo 2 marcado como lido');
  // o link segue: a página nova refaz o status e diz as duas coisas
  p.rodar('paginaDocs("docs/templates")');
  await esperar(150);
  assert.match(p.status(), /^Capítulo 2 marcado como lido\. Capítulo 3 de 13: /);
  // o aviso vale uma vez só
  p.rodar('paginaDocs("docs/disparo-manual")'); await esperar(150);
  assert.match(p.status(), /^Capítulo 4 de 13: /);
});

test('"Próximo" (D10): capítulo que já estava lido, sem armazenamento, apêndice e aviso vencido não anunciam nada a mais', async () => {
  const p = montarPagina();
  p.rodar('paginaDocs("docs/perguntas")'); await esperar(150); const posApendice = p.status();
  p.pagina.onclick(clique('.docs-nav-prox')); await esperar(150); // apêndice não entra na trilha: nada é marcado
  assert.deepEqual(p.lidos(), []); assert.equal(p.status(), posApendice); assert.equal(p.rodar('DOCS_ESTADO.avisoLido'), null);
  // lido de antes: sem anúncio novo
  const q = montarPagina();
  q.rodar('docsMarcarLido("conexoes")'); q.rodar('paginaDocs("docs/conexoes")'); await esperar(150);
  q.pagina.onclick(clique('.docs-nav-prox')); await esperar(150);
  assert.match(q.status(), /^Capítulo 2 de 13: /, 'já estava lido: o anúncio da posição não é trocado');
  q.rodar('paginaDocs("docs/templates")'); await esperar(150);
  assert.match(q.status(), /^Capítulo 3 de 13: /);
  // sem localStorage: nada é gravado, nada é anunciado
  const s = montarPagina({ storage: false });
  s.rodar('paginaDocs("docs/conexoes")'); await esperar(150); const antes = s.status();
  s.pagina.onclick(clique('.docs-nav-prox')); await esperar(150);
  assert.equal(s.status(), antes); assert.equal(s.rodar('DOCS_ESTADO.avisoLido'), null);
  s.rodar('paginaDocs("docs/templates")'); await esperar(150); assert.match(s.status(), /^Capítulo 3 de 13: /);
  // aviso vencido (o "Próximo" abriu em outra aba e a página só mudou muito depois): não gruda
  const v = montarPagina();
  v.rodar('paginaDocs("docs/conexoes")'); v.pagina.onclick(clique('.docs-nav-prox'));
  v.rodar('DOCS_ESTADO.avisoLido.ate = Date.now() - 1'); v.rodar('paginaDocs("docs/templates")'); await esperar(150);
  assert.match(v.status(), /^Capítulo 3 de 13: /);
});

// ---- QD1 e menores do qa: busca na página ---------------------------------------------------------------------------
/** montarPagina com elementos que guardam hidden/value/onkeydown e innerHTML do #docs-resultados. */
function paginaComBusca(hash) {
  const p = montarPagina(); p.ctx.location.hash = hash;
  const estado = { hiddenRes: true, hiddenConteudo: false, valor: '', resHtml: '' };
  const orig = p.doc.getElementById;
  const desc = Object.getOwnPropertyDescriptor(p.pagina, 'innerHTML'); // página nova = campos novos: o estado de teste recomeça
  Object.defineProperty(p.pagina, 'innerHTML', { get: desc.get, set(v) { desc.set.call(this, v); Object.assign(estado, { hiddenRes: true, hiddenConteudo: false, valor: '', resHtml: '' }); }, configurable: true });
  p.doc.getElementById = (id) => {
    const el = orig(id); if (!el) return el;
    if (id === 'docs-resultados') { Object.defineProperty(el, 'hidden', { get: () => estado.hiddenRes, set: (v) => { estado.hiddenRes = v; }, configurable: true }); Object.defineProperty(el, 'innerHTML', { get: () => estado.resHtml, set: (v) => { estado.resHtml = v; }, configurable: true }); }
    if (id === 'docs-conteudo') Object.defineProperty(el, 'hidden', { get: () => estado.hiddenConteudo, set: (v) => { estado.hiddenConteudo = v; }, configurable: true });
    if (id === 'docs-q') Object.defineProperty(el, 'value', { get: () => estado.valor, set: (v) => { estado.valor = v; }, configurable: true });
    return el;
  };
  p.rodar(`paginaDocs(${JSON.stringify(hash.slice(1))})`);
  return { ...p, estado, res: () => p.doc.getElementById('docs-resultados'), campo: () => p.doc.getElementById('docs-q') };
}
const cliqueLink = (href, extra = {}) => { const a = { getAttribute: (k) => (k === 'href' ? href : null) }; const alvo = { closest: (s) => (s === '.docs-resultados-lista a' ? a : null) }; return { target: alvo, preventDefault() { extra.impediu = true; } }; };

test('busca (QD1): resultado que aponta para o endereço atual refaz a página (busca fechada, foco na seção); outro destino só fecha a busca e o link segue', () => {
  const p = paginaComBusca('#docs/conexoes/amazon');
  p.estado.valor = 'amazon'; p.rodar('docsMostrarBusca("amazon")');
  assert.equal(p.estado.hiddenRes, false); assert.equal(p.estado.hiddenConteudo, true);
  const aberturas = []; p.rodar('globalThis.__orig = paginaDocs; paginaDocs = (x) => { globalThis.__chamadas.push(x); return __orig(x); }; globalThis.__chamadas = [];');
  const e = { impediu: false }; p.pagina.onclick(cliqueLink('#docs/conexoes/amazon', e));
  assert.equal(e.impediu, true, 'o link não navega (não haveria hashchange)');
  assert.deepEqual(p.json('__chamadas'), ['docs/conexoes/amazon']);
  assert.equal(p.estado.hiddenRes, true, 'a busca fecha'); assert.equal(p.estado.hiddenConteudo, false);
  assert.equal(p.doc.activeElement?.id, 'docs-s-amazon', 'o foco vai para a seção');
  // outro endereço: o navegador navega (hashchange); a busca é fechada sem refazer a página
  const q = paginaComBusca('#docs/conexoes/amazon'); q.estado.valor = 'shopee'; q.rodar('docsMostrarBusca("shopee")');
  q.rodar('globalThis.__chamadas = []; globalThis.__orig = paginaDocs; paginaDocs = (x) => { globalThis.__chamadas.push(x); return __orig(x); };');
  const e2 = { impediu: false }; q.pagina.onclick(cliqueLink('#docs/conexoes/shopee', e2));
  assert.equal(e2.impediu, false); assert.deepEqual(q.json('__chamadas'), []); assert.equal(q.estado.hiddenRes, true);
});

test('busca (menores do qa): Esc nos resultados limpa a busca; 1 letra tira os resultados antigos; palavra só no título leva <mark> no título', () => {
  const p = paginaComBusca('#docs/conexoes');
  p.estado.valor = 'backup'; p.rodar('docsMostrarBusca("backup")'); assert.equal(p.estado.hiddenRes, false);
  assert.equal(typeof p.res().onkeydown, 'function');
  let impediu = false;
  p.res().onkeydown({ key: 'Enter', preventDefault() { impediu = true; } }); assert.equal(p.estado.hiddenRes, false); assert.equal(impediu, false, 'outras teclas não fazem nada');
  p.res().onkeydown({ key: 'Escape', preventDefault() { impediu = true; } });
  assert.equal(impediu, true); assert.equal(p.estado.hiddenRes, true); assert.equal(p.estado.hiddenConteudo, false); assert.equal(p.estado.valor, ''); assert.equal(p.doc.activeElement?.id, 'docs-q');
  let outra = false; p.res().onkeydown({ key: 'Escape', preventDefault() { outra = true; } }); assert.equal(outra, false, 'sem busca aberta o Esc passa adiante (fecha diálogo, etc.)');
  // 1 letra: a lista antiga sai, o conteúdo volta e o campo não é apagado
  p.estado.valor = 'backup'; p.rodar('docsMostrarBusca("backup")'); assert.equal(p.estado.hiddenRes, false);
  p.estado.valor = 'b'; p.rodar('docsMostrarBusca("b")');
  assert.equal(p.estado.hiddenRes, true); assert.equal(p.estado.resHtml, ''); assert.equal(p.estado.hiddenConteudo, false); assert.equal(p.estado.valor, 'b');
  // título
  const X = carregar({}, { falsos: FALSOS_BUSCA });
  const html = X.json('docsHtmlBusca("backup")').html;
  assert.match(html, /<span class="docs-res-onde">3\. Modelos · Fazer <mark>BACKUP<\/mark> agora<\/span>/);
  assert.match(html, /<span class="docs-res-onde">2\. <mark>Backup<\/mark> da loja<\/span>/);
  const nome = X.json('docsHtmlBusca("<b>")').html; assert.doesNotMatch(nome, /<b>/);
});
