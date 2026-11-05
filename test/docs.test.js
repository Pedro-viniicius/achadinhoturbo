// Docs do sistema (plano docs/produto/planos/docs-do-sistema.md, etapa 1): o motor public/docs.js e os capítulos
// public/docs/cap-*.js. Estrutura do conteúdo (campos, ids, slugs da spec, trilha), escopo global dos scripts,
// links internos, escape do docsInline (XSS), busca e a página montada num DOM falso mínimo (só getElementById).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { MOTIVOS } from '../src/catalogo-itens.js';
import { pastaDeDados } from '../src/config.js';
import { spawnSync } from 'node:child_process';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(RAIZ, 'public');
const fonte = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8');
const scriptsIndex = () => [...fonte('index.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const CAPS_ARQ = fs.readdirSync(path.join(PUB, 'docs')).filter((f) => f.endsWith('.js')).map((f) => 'docs/' + f);
const ID = /^[a-z0-9-]+$/;
const ALVO = /^#[a-z0-9-]+(\/[a-z0-9-]+){0,2}$/;

/** Slugs da spec (docs/produto/specs/docs-do-sistema.md, seção 1), na ordem. Etapas de conteúdo podem acrescentar. */
const SPEC = {
  'primeiros-passos': ['entrar', 'whatsapp', 'extensao', 'teste'],
  conexoes: ['mercado-livre', 'amazon', 'shopee', 'catalogo', 'sem-api'],
  templates: ['campos', 'linha-some', 'opcional', 'titulo'],
  'disparo-manual': ['mercado-livre', 'amazon', 'shopee', 'agendar'],
  'disparo-automatico': ['anatomia', 'fontes', 'catalogo', 'ritmo', 'testar'],
  espelhamento: ['antes', 'criar', 'formato', 'filtros', 'fila'],
  revisao: ['motivos', 'revisar', 'preco', 'reenviar'],
  mensagens: ['mensagem', 'enquete', 'quando', 'pausar'],
  grupos: ['convites', 'blocos', 'rotacionador', 'proximo-grupo'],
  resultados: ['visao', 'historico', 'avisos'],
  equipe: ['papeis', 'convidar', 'gerir'],
  privacidade: ['dados', 'segredos', 'retencao', 'membros'],
  manutencao: ['painel', 'backup', 'reconectar', 'log', 'ajustes'],
  perguntas: ['tag-amazon', 'meli-la', 'precisa-api', 'id-shopee', 'catalogo', 'etiqueta-desta-fonte', 'so-catalogo', 'catalogo-links', 'limpar-log', 'painel-local'],
  referencia: ['glossario', 'estados', 'motivos', 'limites'],
};

/** docs.js + os capítulos (na ordem do index.html) num vm. ctx extra: document, location, navigator… */
function carregar(ctxExtra = {}, { capitulos = true } = {}) {
  const ctx = vm.createContext({ ...ctxExtra });
  vm.runInContext(fonte('docs.js'), ctx, { filename: 'public/docs.js' });
  if (capitulos) for (const arq of scriptsIndex().filter((s) => s.startsWith('docs/'))) vm.runInContext(fonte(arq), ctx, { filename: 'public/' + arq });
  return {
    ctx,
    rodar: (c) => vm.runInContext(c, ctx),
    json: (expr) => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx) ?? 'null'),
  };
}
const D = carregar();
const TRILHA = D.json('DOCS_TRILHA');
const CAPS = D.json('DOCS_CAPS');
const inline = (s) => D.rodar(`docsInline(${JSON.stringify(s)})`);

/** Todas as strings de um valor (para varrer links e textos). */
function strings(v, saida = []) {
  if (typeof v === 'string') saida.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, saida));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, saida));
  return saida;
}
/**
 * Toda tag do HTML está na lista; os atributos são só `nome` ou `nome="valor sem aspas nem < >"` (texto escapado
 * dentro de um valor não é atributo); nenhum atributo on*; todo href é interno.
 */
function soTagsSeguras(html, permitidas, onde) {
  const ATRIBUTO = /\s+([a-zA-Z][\w:-]*)(?:="([^"<>]*)")?/g;
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    assert.ok(permitidas.has(m[1].toLowerCase()), `${onde}: tag fora da lista <${m[1]}>\n${html}`);
    assert.equal(m[2].replace(ATRIBUTO, '').trim(), '', `${onde}: atributos malformados em <${m[1]}${m[2]}>`);
    for (const [, nome, valor] of m[2].matchAll(ATRIBUTO)) {
      assert.doesNotMatch(nome, /^on/i, `${onde}: atributo ${nome} em <${m[1]}>`);
      if (nome === 'href') assert.match(valor, ALVO, `${onde}: href não interno ${valor}`);
    }
  }
}
const TAGS_INLINE = new Set(['strong', 'code', 'kbd', 'span', 'b', 'a']);
const TAGS_PAGINA = new Set([...TAGS_INLINE, 'article', 'header', 'p', 'h2', 'h3', 'h4', 'div', 'ul', 'ol', 'li', 'section', 'pre', 'button',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'dl', 'dt', 'dd', 'nav', 'mark', 'progress', 'label', 'input']);
const TAGS_DOM = new Set([...TAGS_PAGINA, 'h1', 'form', 'label', 'input', 'small', 'details', 'summary']);

/** ROTAS e ALIASES de verdade: app.js num vm com o mínimo de DOM que ele usa ao carregar (como em test/qa.test.js). */
function rotasDoPainel() {
  const falso = () => ({ addEventListener() {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, setAttribute() {}, removeAttribute() {}, focus() {}, contains: () => false });
  const ctx = vm.createContext({
    document: { querySelector: falso, querySelectorAll: () => [], addEventListener() {}, getElementById: () => null, activeElement: null, body: {} },
    location: { hash: '' }, history: { replaceState() {} }, addEventListener() {}, console,
    fetch: () => new Promise(() => {}), setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
  });
  ctx.window = ctx;
  vm.runInContext(fonte('app.js'), ctx, { filename: 'public/app.js' });
  return new Set(JSON.parse(vm.runInContext('JSON.stringify([...Object.keys(ROTAS), ...Object.keys(ALIASES)])', ctx)));
}

// ---------------------------------------------------------------------------------------------------------------
test('trilha: os 13 capítulos e os 2 apêndices da spec, na ordem; todo registrado está na trilha e vice-versa', () => {
  assert.deepEqual(TRILHA.map((t) => t.id), Object.keys(SPEC));
  assert.deepEqual(TRILHA.map((t) => t.numero), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, null, null]);
  for (const t of TRILHA) {
    assert.deepEqual(Object.keys(t).sort(), ['id', 'numero', 'parte']);
    assert.equal(t.parte, t.numero == null ? 'apendice' : 'trilha', t.id);
  }
  assert.deepEqual(Object.keys(CAPS).sort(), TRILHA.map((t) => t.id).sort());
});

test('estrutura: campos permitidos, ids válidos e únicos, aprenda de 2 a 4, toda seção com bloco, todo bloco de um tipo só', () => {
  const CAMPOS_CAP = new Set(['id', 'titulo', 'aprenda', 'antes', 'abrir', 'secoes']);
  const CAMPOS_SECAO = new Set(['id', 'titulo', 'soDono', 'onde', 'leia', 'blocos']);
  const TIPOS = { p: [], passos: [], nota: ['texto'], comando: [], exemplo: [], tabela: [], termos: ['titulo'] };
  const texto = (v, onde) => assert.ok(typeof v === 'string' && v.trim() !== '', `${onde}: texto vazio ou não é string`);
  const listaDeTextos = (v, onde) => { assert.ok(Array.isArray(v) && v.length > 0, `${onde}: lista vazia`); v.forEach((x, i) => texto(x, `${onde}[${i}]`)); };
  for (const [id, cap] of Object.entries(CAPS)) {
    for (const k of Object.keys(cap)) assert.ok(CAMPOS_CAP.has(k), `${id}: campo desconhecido ${k}`);
    assert.equal(cap.id, id); assert.match(id, ID); texto(cap.titulo, `${id}.titulo`);
    listaDeTextos(cap.aprenda, `${id}.aprenda`);
    assert.ok(cap.aprenda.length >= 2 && cap.aprenda.length <= 4, `${id}: "O que você vai aprender" com ${cap.aprenda.length} itens`);
    if (cap.antes !== undefined) listaDeTextos(cap.antes, `${id}.antes`);
    if (cap.abrir !== undefined) {
      assert.ok(Array.isArray(cap.abrir) && cap.abrir.length > 0, `${id}.abrir`);
      for (const a of cap.abrir) { assert.deepEqual(Object.keys(a).sort(), ['rota', 'tela'], `${id}.abrir`); assert.match(a.rota, /^#[a-z0-9-]+$/); texto(a.tela, `${id}.abrir.tela`); }
    }
    assert.ok(Array.isArray(cap.secoes) && cap.secoes.length > 0, `${id}: sem seções`);
    const ids = new Set();
    for (const s of cap.secoes) {
      const onde = `${id}/${s.id}`;
      for (const k of Object.keys(s)) assert.ok(CAMPOS_SECAO.has(k), `${onde}: campo desconhecido ${k}`);
      assert.match(s.id, ID, onde); assert.ok(!ids.has(s.id), `${onde}: id repetido`); ids.add(s.id);
      texto(s.titulo, `${onde}.titulo`);
      if (s.soDono !== undefined) assert.equal(s.soDono, true, `${onde}.soDono`);
      if (s.onde !== undefined) texto(s.onde, `${onde}.onde`);
      if (s.leia !== undefined) {
        const [c, sec] = String(s.leia).split('/');
        assert.ok(CAPS[c]?.secoes.some((x) => x.id === sec), `${onde}: leia aponta para ${s.leia}, que não existe`);
      }
      assert.ok(Array.isArray(s.blocos) && s.blocos.length > 0, `${onde}: seção sem bloco`);
      s.blocos.forEach((b, i) => {
        const ob = `${onde}.blocos[${i}]`;
        const tipos = Object.keys(b).filter((k) => Object.hasOwn(TIPOS, k));
        assert.equal(tipos.length, 1, `${ob}: precisa de exatamente um tipo (${Object.keys(b)})`);
        const [tipo] = tipos;
        for (const k of Object.keys(b)) assert.ok(k === tipo || TIPOS[tipo].includes(k), `${ob}: campo ${k} não cabe em ${tipo}`);
        if (tipo === 'p' || tipo === 'comando' || tipo === 'exemplo') texto(b[tipo], ob);
        if (tipo === 'passos') listaDeTextos(b.passos, ob);
        if (tipo === 'nota') { assert.ok(['aviso', 'dica', 'erro'].includes(b.nota), `${ob}: nota ${b.nota}`); texto(b.texto, ob); }
        if (tipo === 'tabela') {
          assert.deepEqual(Object.keys(b.tabela).sort(), ['colunas', 'linhas'], ob);
          listaDeTextos(b.tabela.colunas, `${ob}.colunas`);
          assert.ok(Array.isArray(b.tabela.linhas) && b.tabela.linhas.length > 0, `${ob}.linhas`);
          for (const l of b.tabela.linhas) { assert.equal(l.length, b.tabela.colunas.length, `${ob}: linha com ${l.length} células`); listaDeTextos(l, ob); }
        }
        if (tipo === 'termos') {
          if (b.titulo !== undefined) texto(b.titulo, `${ob}.titulo`);
          assert.ok(Array.isArray(b.termos) && b.termos.length > 0, ob);
          for (const par of b.termos) { assert.equal(par.length, 2, `${ob}: verbete ${par}`); listaDeTextos(par, ob); }
        }
      });
    }
  }
});

test('slugs: todo capítulo e toda seção da spec existem, na ordem da spec', () => {
  for (const [cap, secoes] of Object.entries(SPEC)) {
    const ids = CAPS[cap].secoes.map((s) => s.id);
    assert.deepEqual(ids.filter((s) => secoes.includes(s)), secoes, `${cap}: seções da spec ${ids}`);
  }
});

test('conteúdo migrado da Ajuda: glossário inteiro na Referência, Comece por aqui, convite e selo "Só o Dono" na Equipe', () => {
  const glossario = CAPS.referencia.secoes.find((s) => s.id === 'glossario').blocos.filter((b) => b.termos).flatMap((b) => b.termos);
  assert.ok(glossario.length >= 34, `verbetes: ${glossario.length}`);
  for (const t of ['Etiqueta', 'Etiqueta (o app)', 'Catálogo', 'Tag de associado', 'ID de afiliado', 'Dono', 'Operador', 'Virada do dia', 'Enquete']) {
    assert.ok(glossario.some(([x]) => x === t), `glossário: ${t}`);
  }
  const equipe = D.rodar('docsHtmlCapitulo("equipe")');
  for (const r of [/Criar convite/, /Copie o link e mande pelo WhatsApp/, /cria a senha/, /Vale 7 dias|vale 7 dias/]) assert.match(equipe, r);
  assert.match(equipe, /<h3 id="docs-s-convidar" tabindex="-1">Convidar alguém <span class="chip so-dono">Só o Dono<\/span><\/h3>/);
  assert.doesNotMatch(D.rodar('docsHtmlCapitulo("equipe")').split('docs-s-convidar')[0], /so-dono/, '"Dono e Operador" não leva o selo');
  assert.match(D.rodar('docsHtmlCapitulo("primeiros-passos")'), /Comece por aqui/);
});

test('escopo global: os cap-*.js não declaram nada no topo; docs.js só usa nomes docs/DOCS_ e paginaDocs; nenhum nome repetido entre os scripts do painel', () => {
  for (const arq of CAPS_ARQ) {
    const txt = fonte(arq);
    txt.split('\n').forEach((linha, i) => assert.doesNotMatch(linha, /^\s*(const|let|var|class|function|async\s+function)\b/, `${arq}:${i + 1} declara no topo`));
    for (const linha of txt.replace(/^\s*\/\/.*$/gm, '').split('\n')) if (/^\S/.test(linha)) assert.match(linha, /^(docsCapitulo\(\{|\}\);)$/, `${arq}: no topo só docsCapitulo({ … });`);
    const ctx = vm.createContext({ docsCapitulo: () => {} }); const antes = new Set(Object.keys(ctx));
    vm.runInContext(txt, ctx, { filename: arq });
    assert.deepEqual(Object.keys(ctx).filter((k) => !antes.has(k)), [], `${arq} criou global`);
  }
  const DECL = /^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of fonte('docs.js').matchAll(DECL)) assert.match(m[1], /^(docs|DOCS_)|^paginaDocs$/, `docs.js declara ${m[1]}`);
  const dono = new Map();
  for (const arq of scriptsIndex()) {
    for (const m of fonte(arq).matchAll(DECL)) { assert.ok(!dono.has(m[1]), `${m[1]} declarado em ${dono.get(m[1])} e em ${arq}`); dono.set(m[1], arq); }
  }
});

test('index.html: docs.js e todos os arquivos de public/docs/ logo depois de ajuda.js e antes de app.js; nada inline', () => {
  const s = scriptsIndex(); const i = s.indexOf('ajuda.js');
  assert.ok(i >= 0);
  assert.equal(s[i + 1], 'docs.js');
  const caps = s.slice(i + 2, i + 2 + CAPS_ARQ.length);
  assert.deepEqual([...caps].sort(), [...CAPS_ARQ].sort(), 'os 7 capítulos logo depois de docs.js');
  assert.ok(s.indexOf('app.js') > i + 1 + CAPS_ARQ.length, 'antes de app.js');
  assert.doesNotMatch(fonte('index.html'), /<script(?![^>]*\bsrc=)[^>]*>/, 'nenhum <script> inline (CSP script-src self)');
  assert.doesNotMatch(fonte('docs.js') + CAPS_ARQ.map(fonte).join(''), /\son[a-z]+=/i, 'nenhum atributo on* no HTML gerado');
});

test('links: todo #docs/… citado em public/**/*.js existe; todo link e todo "Abrir" de capítulo vão para uma rota do painel', () => {
  const existe = (alvo) => {
    const [, cap, sec] = alvo.split('/');
    if (cap === undefined) return true;
    return !!CAPS[cap] && (sec === undefined || CAPS[cap].secoes.some((s) => s.id === sec));
  };
  const arquivos = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arquivos(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  let vistos = 0;
  for (const f of arquivos(PUB)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/#docs((?:\/[a-z0-9-]+)+)/g)) { vistos++; assert.ok(existe('#docs' + m[1]), `${path.relative(RAIZ, f)}: #docs${m[1]} não existe`); }
  }
  assert.ok(vistos > 5, 'há links #docs/… no conteúdo');
  const rotas = rotasDoPainel();
  const links = strings([CAPS, D.json('DOCS_TEXTOS')]).flatMap((t) => [...t.matchAll(/\]\(([^()\s]*)\)/g)].map((m) => m[1]));
  for (const l of links) {
    assert.match(l, ALVO, `link não interno: ${l}`);
    if (l === '#docs' || l.startsWith('#docs/')) assert.ok(existe(l), `link ${l}`);
    else assert.ok(rotas.has(l.slice(1)), `link ${l}: rota que não existe`);
  }
  for (const cap of Object.values(CAPS)) for (const a of cap.abrir || []) assert.ok(rotas.has(a.rota.slice(1)), `${cap.id}: Abrir ${a.rota}`);
});

// ---------------------------------------------------------------------------------------------------------------
test('docsInline: escapa primeiro e só gera strong, code, kbd, caminho e link interno', () => {
  assert.equal(inline('**Salvar**'), '<strong>Salvar</strong>');
  assert.equal(inline('`npm test`'), '<code>npm test</code>');
  assert.equal(inline('{{Ctrl}}+{{C}}'), '<kbd>Ctrl</kbd>+<kbd>C</kbd>');
  assert.equal(inline('[[Conexões → Amazon]]'), '<span class="caminho"><b>Conexões</b><span class="sr-only"> depois </span><span aria-hidden="true">→</span><b>Amazon</b></span>');
  assert.equal(inline('[o capítulo](#docs/conexoes/amazon)'), '<a href="#docs/conexoes/amazon">o capítulo</a>');
  assert.equal(inline('[Conexões](#conexoes)'), '<a href="#conexoes">Conexões</a>');
  assert.equal(inline('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;');
  assert.equal(inline('`**não** vira negrito`'), '<code>**não** vira negrito</code>', 'dentro de código nada é marcação');
  assert.equal(inline('[🎟️ Cupom: {CUPOM}]'), '[🎟️ Cupom: {CUPOM}]', 'colchete sem (alvo) é texto');
  assert.equal(inline(null), ''); assert.equal(inline(undefined), ''); assert.equal(inline(42), '42');
});

test('docsInline com conteúdo malicioso: nada vira tag, atributo nem link externo', () => {
  const casos = {
    '<img src=x onerror=alert(1)>': '&lt;img src=x onerror=alert(1)&gt;',
    '<script>alert(1)</script>': '&lt;script&gt;alert(1)&lt;/script&gt;',
    '[x](javascript:alert(1))': '[x](javascript:alert(1))',
    '[x](javascript:alert)': 'x (<code>javascript:alert</code>)',
    '[x](#a" onclick="alert(1))': '[x](#a&quot; onclick=&quot;alert(1))',
    '[x](#a"onclick="alert)': 'x (<code>#a&quot;onclick=&quot;alert</code>)',
    '[x](https://exemplo.com)': 'x (<code>https://exemplo.com</code>)',
    '[x](//exemplo.com)': 'x (<code>//exemplo.com</code>)',
    '[x](#docs/a/b/c)': 'x (<code>#docs/a/b/c</code>)',
    '[x](#Docs)': 'x (<code>#Docs</code>)',
    '**<b onmouseover=alert(1)>x</b>**': '<strong>&lt;b onmouseover=alert(1)&gt;x&lt;/b&gt;</strong>',
    '`<script>`': '<code>&lt;script&gt;</code>',
    '{{<i>}}': '<kbd>&lt;i&gt;</kbd>',
    '[[<a href=x> → B]]': '<span class="caminho"><b>&lt;a href=x&gt;</b><span class="sr-only"> depois </span><span aria-hidden="true">→</span><b>B</b></span>',
    '[<img src=x>](#docs)': '<a href="#docs">&lt;img src=x&gt;</a>',
    '&lt;script&gt;': '&amp;lt;script&amp;gt;',
  };
  for (const [entrada, esperado] of Object.entries(casos)) {
    const html = inline(entrada);
    assert.equal(html, esperado, entrada);
    soTagsSeguras(html, TAGS_INLINE, entrada);
    assert.doesNotMatch(html, /<(img|script)/i, entrada);
  }
});

test('capítulo com <script> em todos os campos: o HTML do capítulo, do sumário, da navegação e da busca não gera tag nem link externo', () => {
  const M = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'[x](javascript:alert(1))';
  const X = carregar({}, { capitulos: false });
  X.rodar(`docsCapitulo(${JSON.stringify({
    id: 'primeiros-passos', titulo: M, aprenda: [M, M], antes: [M],
    abrir: [{ rota: M, tela: M }, { rota: 'javascript:alert(1)', tela: M }, { rota: '#conexoes', tela: M }],
    secoes: [{ id: 'a', titulo: M, soDono: true, onde: M, leia: M, blocos: [
      { p: M }, { passos: [M, M] }, { nota: M, texto: M }, { nota: '__proto__', texto: M }, { nota: 'aviso', texto: M }, { comando: M }, { exemplo: M },
      { tabela: { colunas: [M, M], linhas: [[M, M]] } }, { termos: [[M, M]], titulo: M }, { desconhecido: M },
    ] }],
  })})`);
  X.rodar(`docsCapitulo(${JSON.stringify({ id: 'perguntas', titulo: M, aprenda: [M, M], secoes: [{ id: 'b', titulo: M, leia: 'primeiros-passos/a', blocos: [{ p: M }] }, { id: 'c', titulo: 'c', leia: 'primeiros-passos/zz', blocos: [{ p: 'c' }] }] })})`);
  const html = X.rodar(`[docsHtmlCapitulo('primeiros-passos'), docsHtmlNav('primeiros-passos'), docsHtmlSumario('primeiros-passos', 'a'),
    docsHtmlCapitulo('perguntas'), docsHtmlNav('perguntas'), docsHtmlBusca('script').html, docsHtmlBusca(${JSON.stringify(M)}).html, docsHtmlBusca('alert img').html].join('\\n')`);
  assert.doesNotMatch(html, /<script|<img/i);
  soTagsSeguras(html, TAGS_PAGINA, 'capítulo malicioso');
  assert.match(html, /<a class="btn" href="#conexoes">/, 'o "Abrir" com rota válida fica');
  assert.equal((html.match(/class="btn"/g) || []).length, 1, 'rotas inválidas não viram link');
  assert.match(html, /docs-nota--dica/, 'tipo de nota desconhecido vira dica');
  assert.equal((html.match(/class="docs-leia"/g) || []).length, 1, '"Ler o capítulo" só com destino que existe');
  assert.match(html, /<mark>script<\/mark>/, 'a busca marca o termo e escapa o resto');
  // a página inteira (com o resumo do sumário e o título da aba, que são texto)
  const p = montarPagina({ capitulos: false });
  p.rodar(`docsCapitulo(${JSON.stringify({ id: 'conexoes', titulo: M, aprenda: [M, M], secoes: [{ id: 'a', titulo: M, blocos: [{ p: M }] }] })})`);
  p.rodar('paginaDocs("docs/conexoes/a")');
  assert.doesNotMatch(p.html(), /<script|<img/i);
  soTagsSeguras(p.html(), TAGS_DOM, 'página com capítulo malicioso');
  assert.equal(p.doc.title, `${M} · Docs do sistema`, 'o título da aba é texto (document.title não interpreta HTML)');
});

test('docsCapitulo: recusa id inválido ou repetido e seção com id inválido', () => {
  const X = carregar({}, { capitulos: false });
  const registra = (cap) => X.rodar(`docsCapitulo(${JSON.stringify(cap)})`);
  for (const id of ['', 'A', 'a b', '<x>', '__proto__', '../x', 'a/b']) assert.throws(() => registra({ id, secoes: [] }), /id de capítulo inválido/, id);
  assert.throws(() => registra({ id: 'x', secoes: [{ id: 'B' }] }), /id de seção inválido/);
  assert.throws(() => X.rodar('docsCapitulo(null)'), /inválido/);
  registra({ id: 'x', secoes: [] });
  assert.throws(() => registra({ id: 'x', secoes: [] }), /repetido/);
  assert.equal(X.rodar('docsCap("x")'), null, 'fora da trilha não abre');
});

// ---------------------------------------------------------------------------------------------------------------
test('busca: ignora maiúsculas e acentos, começa com 2 letras, exige todos os termos e marca o trecho', () => {
  for (const t of ['', ' ', 'c', ' c ', 'á', null, undefined]) assert.deepEqual(D.json(`docsBuscar(${JSON.stringify(t ?? null)})`), [], `termo ${t}`);
  const sem = D.json('docsBuscar("catalogo")'); const com = D.json('docsBuscar("CATÁLOGO")');
  assert.ok(sem.length > 0); assert.deepEqual(com, sem);
  assert.ok(sem.some((r) => r.cap === 'conexoes' && r.secao === 'catalogo'), 'acha Conexões → Catálogo do Etiqueta');
  for (const r of sem) assert.deepEqual(Object.keys(r).sort(), ['cap', 'secao', 'titulo', 'trecho']);
  const dois = D.json('docsBuscar("catalogo shopee")'); const chave = (r) => r.cap + '/' + r.secao;
  assert.ok(dois.length > 0 && dois.length < sem.length);
  const soShopee = new Set(D.json('docsBuscar("shopee")').map(chave));
  for (const r of dois) assert.ok(soShopee.has(chave(r)) && sem.some((x) => chave(x) === chave(r)), `${chave(r)} tem os dois termos`);
  const { resumo, html } = D.json('docsHtmlBusca("catalogo")');
  assert.match(resumo, /^\d+ resultados? para “catalogo”$/);
  assert.match(html, /<mark>Catálogo<\/mark>/, 'marca o texto original, com acento');
  assert.match(html, /href="#docs\/conexoes\/catalogo"/);
});

test('busca: sem resultado aponta para Perguntas reais e Referência; mais de 20 mostra 20 e avisa', () => {
  const nada = D.json('docsHtmlBusca("zzqqxx")');
  assert.equal(nada.resumo, 'Nada encontrado para “zzqqxx”.');
  assert.match(nada.html, /href="#docs\/perguntas"/); assert.match(nada.html, /href="#docs\/referencia"/); assert.match(nada.html, /data-docs-limpar/);
  const total = D.json('docsBuscar("de")').length;
  assert.ok(total > 20, `"de" aparece em ${total} trechos`);
  const muitos = D.json('docsHtmlBusca("de")');
  assert.equal((muitos.html.match(/<li>/g) || []).length, 20);
  assert.match(muitos.html, new RegExp(`Mostrando 20 de ${total}\\. Refine a busca\\.`));
});

// ---------------------------------------------------------------------------------------------------------------
test('capítulo, início, não achado e Anterior/Próximo', () => {
  const nav1 = D.rodar('docsHtmlNav("primeiros-passos")');
  assert.match(nav1, /<a class="docs-nav-ant" href="#docs"><span class="docs-nav-r">Anterior<\/span> <span class="docs-nav-t">Início<\/span><\/a>/);
  assert.match(nav1, /href="#docs\/conexoes"><span class="docs-nav-r">Próximo<\/span> <span class="docs-nav-t">2\. Conexões: suas lojas<\/span>/);
  const nav13 = D.rodar('docsHtmlNav("manutencao")');
  assert.match(nav13, /href="#docs\/privacidade">.*12\. Privacidade e segurança/);
  assert.match(nav13, /href="#docs\/perguntas"><span class="docs-nav-r">Continue com<\/span> <span class="docs-nav-t">Perguntas reais<\/span>/);
  for (const ap of ['perguntas', 'referencia']) {
    const n = D.rodar(`docsHtmlNav("${ap}")`);
    assert.match(n, /Voltar ao início do livro/); assert.doesNotMatch(n, /Anterior|Próximo/);
  }
  const c5 = D.rodar('docsHtmlCapitulo("disparo-automatico")');
  assert.match(c5, /<p class="docs-cap-n">Capítulo 5<\/p><h2 id="docs-titulo" tabindex="-1">Disparo automático<\/h2><p class="docs-leitura">Leitura: \d+ min<\/p>/);
  assert.match(c5, /O que você vai aprender/); assert.match(c5, /Antes de começar/);
  assert.match(c5, /<a class="btn" href="#disparo-automatico">Abrir Disparo automático no painel<\/a>/);
  assert.match(c5, /<a class="docs-ancora" href="#docs\/disparo-automatico\/catalogo" aria-label="Link para esta seção">#<\/a>/);
  const perguntas = D.rodar('docsHtmlCapitulo("perguntas")');
  assert.match(perguntas, /<p class="docs-cap-n">Apêndice<\/p>/);
  for (const s of SPEC.perguntas) assert.match(perguntas, new RegExp(`<li><a href="#docs/perguntas/${s}">`), `índice: ${s}`);
  assert.match(perguntas, /<p class="docs-leia"><a href="#docs\/conexoes\/amazon">Ler o capítulo 2\. Conexões: suas lojas: Amazon: tag e API<\/a><\/p>/);
  assert.match(D.rodar('docsHtmlCapitulo("xyz")'), /Não achamos este capítulo/);
  const inicio = D.rodar('docsHtmlInicio()');
  assert.match(inicio, /<a class="btn" href="#docs\/primeiros-passos">Começar pelo capítulo 1<\/a>/);
  soTagsSeguras(inicio + c5 + perguntas + D.rodar('docsHtmlNaoAchado()') + D.rodar('docsHtmlSumario("conexoes", "amazon")'), TAGS_PAGINA, 'páginas');
});

// ---------------------------------------------------------------------------------------------------------------
/** DOM mínimo: #pagina guarda o HTML; getElementById devolve um elemento falso só para ids presentes nesse HTML. */
function montarPagina({ largo = false, clipboard = true, capitulos = true, storage } = {}) {
  const els = new Map(); const ouvintes = []; const copiados = []; let html = ''; const rolagens = [];
  const doc = { title: 'achadinhoturbo', activeElement: null };
  const elemento = (id) => ({
    id, textContent: '', value: '', open: false, rolou: 0, onclick: null, oninput: null, onkeydown: null, onsubmit: null,
    hidden: new RegExp(`id="${id}"[^>]*\\shidden[\\s>]`).test(html),
    focus() { doc.activeElement = this; }, scrollIntoView() { this.rolou++; }, querySelector: () => null,
  });
  const pagina = { id: 'pagina', onclick: null, get innerHTML() { return html; }, set innerHTML(v) { html = String(v); els.clear(); } };
  doc.getElementById = (id) => {
    if (id === 'pagina') return pagina;
    if (!html.includes(`id="${id}"`)) return null;
    if (!els.has(id)) els.set(id, elemento(id));
    return els.get(id);
  };
  const ctx = {
    document: doc, location: { hash: '#docs' },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimeout,
    addEventListener: (tipo, fn) => ouvintes.push({ tipo, fn }), scrollTo: (x, y) => rolagens.push([x, y]),
    navigator: { clipboard: clipboard ? { writeText: async (t) => { copiados.push(t); } } : undefined },
  };
  if (storage && storage !== 'lanca') ctx.localStorage = storage;
  if (largo !== null) ctx.matchMedia = (q) => ({ matches: largo && q === '(min-width: 1100px)', addEventListener() {} });
  const P = carregar(ctx, { capitulos });
  // localStorage que lança ao ser lido (navegador com armazenamento bloqueado): definido depois, o spread de carregar() leria o getter
  if (storage === 'lanca') Object.defineProperty(P.ctx, 'localStorage', { get() { throw new Error('SecurityError'); }, configurable: true });
  return { ...P, doc, pagina, el: (id) => doc.getElementById(id), ouvintes, copiados, rolagens, html: () => html };
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

test('paginaDocs: capítulo com foco no h2, título da aba, sumário (aberto só ≥ 1100 px) e anúncio da posição', async () => {
  const p = montarPagina();
  p.rodar('paginaDocs("docs/conexoes")');
  assert.equal(p.doc.title, 'Conexões: suas lojas · Docs do sistema');
  assert.equal(p.doc.activeElement?.id, 'docs-titulo');
  assert.deepEqual(p.rolagens, [[0, 0]]);
  assert.match(p.html(), /<h1>Docs do sistema<\/h1>/);
  assert.match(p.html(), /<details class="docs-toc" id="docs-toc"><summary>Sumário · cap\. 2 de 13 · Conexões: suas lojas<\/summary><nav class="docs-toc-nav" aria-label="Sumário do livro">/);
  assert.match(p.html(), /<a href="#docs\/conexoes" aria-current="page">/);
  assert.match(p.html(), /<form class="docs-busca" id="docs-busca" role="search"><label for="docs-q">Buscar nos Docs<\/label>/);
  assert.match(p.html(), /<article class="card docs-capitulo" aria-labelledby="docs-titulo">/);
  assert.match(p.html(), /<nav class="docs-nav" aria-label="Capítulo anterior e próximo">/);
  assert.equal(p.el('docs-status').textContent, '');
  await esperar(150);
  assert.equal(p.el('docs-status').textContent, 'Capítulo 2 de 13: Conexões: suas lojas');
  soTagsSeguras(p.html(), TAGS_DOM, 'página');

  const largo = montarPagina({ largo: true });
  largo.rodar('paginaDocs("docs/conexoes")');
  assert.match(largo.html(), /<details class="docs-toc" id="docs-toc" open>/);
  const semMatchMedia = montarPagina({ largo: null });
  semMatchMedia.rodar('paginaDocs("docs")');
  assert.match(semMatchMedia.html(), /<details class="docs-toc" id="docs-toc">/);
});

test('paginaDocs: seção pedida recebe o foco; seção inexistente abre o capítulo no topo; capítulo inexistente mostra o estado próprio', () => {
  const p = montarPagina();
  p.rodar('paginaDocs("docs/conexoes/amazon")');
  assert.equal(p.doc.activeElement?.id, 'docs-s-amazon');
  assert.equal(p.el('docs-s-amazon').rolou, 1);
  assert.match(p.html(), /<a href="#docs\/conexoes\/amazon" aria-current="location">/);

  p.rodar('paginaDocs("docs/conexoes/nao-existe")');
  assert.equal(p.doc.activeElement?.id, 'docs-titulo');
  assert.doesNotMatch(p.html(), /aria-current="location"/);

  p.rodar('paginaDocs("docs/xyz")');
  assert.equal(p.doc.title, 'Capítulo não encontrado · Docs do sistema');
  assert.equal(p.doc.activeElement?.id, 'docs-titulo');
  assert.match(p.html(), /<h2 id="docs-titulo" tabindex="-1">Não achamos este capítulo<\/h2>/);
  assert.match(p.html(), /<a class="btn" href="#docs">Ir para o início do livro<\/a>/);
  assert.match(p.html(), /aria-label="Sumário do livro"/, 'o sumário continua');
  assert.doesNotMatch(p.html(), /aria-current="page"/);

  for (const pedido of ['docs', 'ajuda', 'docs/', undefined]) {
    p.rodar(`paginaDocs(${JSON.stringify(pedido ?? null)})`);
    assert.equal(p.doc.title, 'Docs do sistema', String(pedido));
    assert.match(p.html(), /Começar pelo capítulo 1/);
    assert.match(p.html(), /<a href="#docs" aria-current="page">Início<\/a>/);
  }
});

test('paginaDocs: busca filtra ao digitar (200 ms), 1 letra não faz nada, Esc e "Limpar busca" voltam ao capítulo', async () => {
  const p = montarPagina();
  p.rodar('paginaDocs("docs/templates")');
  const campo = p.el('docs-q'); const res = p.el('docs-resultados'); const conteudo = p.el('docs-conteudo');
  assert.equal(res.hidden, true); assert.equal(conteudo.hidden, false);
  campo.value = 'c'; campo.oninput(); await esperar(260);
  assert.equal(res.hidden, true, '1 letra: nada acontece');
  campo.value = 'catálogo'; campo.oninput(); await esperar(100);
  assert.equal(res.hidden, true, 'espera 200 ms');
  await esperar(160);
  assert.equal(res.hidden, false); assert.equal(conteudo.hidden, true);
  assert.match(res.innerHTML, /<mark>Catálogo<\/mark>/);
  await esperar(150);
  assert.match(p.el('docs-status').textContent, /^\d+ resultados? para “catálogo”$/);
  let impedido = false;
  campo.onkeydown({ key: 'Escape', preventDefault() { impedido = true; } });
  assert.ok(impedido); assert.equal(res.hidden, true); assert.equal(conteudo.hidden, false); assert.equal(campo.value, '');
  assert.equal(p.doc.activeElement, campo);

  campo.value = 'zzqqxx'; let enviou = false;
  p.el('docs-busca').onsubmit({ preventDefault() { enviou = true; } });
  assert.ok(enviou); assert.equal(res.hidden, false); assert.match(res.innerHTML, /Nada encontrado para “zzqqxx”\./);
  p.pagina.onclick({ target: { closest: (s) => (s === '[data-docs-limpar]' ? {} : null) }, preventDefault() {} });
  assert.equal(res.hidden, true); assert.equal(conteudo.hidden, false);

  campo.value = '<img src=x onerror=alert(1)>'; p.el('docs-busca').onsubmit({ preventDefault() {} });
  assert.doesNotMatch(res.innerHTML, /<img/);
});

test('paginaDocs: Copiar do bloco de comando (ok e falha), pular para o conteúdo, Ver o sumário e título da aba ao sair', async () => {
  const bloco = (codigo) => {
    const erro = { hidden: true, textContent: '' }; const code = { textContent: codigo };
    const b = { querySelector: (s) => (s === 'code' ? code : s === '.docs-cmd-erro' ? erro : null) };
    const botao = { textContent: 'Copiar', closest: (s) => (s === '[data-docs-copiar]' ? botao : s === '.docs-cmd' ? b : null) };
    return { botao, erro };
  };
  const p = montarPagina();
  p.rodar('paginaDocs("docs/manutencao")');
  const ok = bloco('npm run backup');
  p.ctx.__botao = ok.botao;
  assert.equal(await p.rodar('docsCopiar(__botao)'), true);
  assert.deepEqual(p.copiados, ['npm run backup']);
  assert.equal(ok.botao.textContent, 'Copiado'); assert.equal(ok.erro.hidden, true);
  await esperar(150); assert.equal(p.el('docs-status').textContent, 'Comando copiado');

  const sem = montarPagina({ clipboard: false });
  sem.rodar('paginaDocs("docs/manutencao")');
  const falha = bloco('npm start'); sem.ctx.__botao = falha.botao;
  assert.equal(await sem.rodar('docsCopiar(__botao)'), false);
  assert.equal(falha.botao.textContent, 'Copiar'); assert.equal(falha.erro.hidden, false);
  assert.equal(falha.erro.textContent, 'Não deu para copiar. Selecione e copie (Ctrl+C).');
  // o clique chega pela delegação em #pagina
  const viaClique = bloco('npm test'); p.pagina.onclick({ target: viaClique.botao, preventDefault() {} }); await esperar(10);
  assert.deepEqual(p.copiados, ['npm run backup', 'npm test']);

  let impediu = false; p.doc.activeElement = null;
  p.pagina.onclick({ target: { closest: (s) => (s === '[data-docs-pular]' ? {} : null) }, preventDefault() { impediu = true; } });
  assert.ok(impediu, 'o link de pular não troca o endereço'); assert.equal(p.doc.activeElement?.id, 'docs-titulo');
  assert.match(p.html(), /<a class="docs-pular" href="#docs\/manutencao" data-docs-pular>Pular para o conteúdo do capítulo<\/a>/);

  p.rodar('paginaDocs("docs/xyz")');
  p.pagina.onclick({ target: { closest: (s) => (s === '[data-docs-sumario]' ? {} : null) }, preventDefault() {} });
  assert.equal(p.el('docs-toc').open, true);

  const mudou = p.ouvintes.filter((o) => o.tipo === 'hashchange');
  assert.equal(mudou.length, 1, 'um ouvinte só, mesmo abrindo várias páginas');
  p.ctx.location.hash = '#docs/conexoes'; mudou[0].fn();
  assert.equal(p.doc.title, 'Capítulo não encontrado · Docs do sistema', 'dentro dos Docs o título é da página');
  p.ctx.location.hash = '#visao'; mudou[0].fn();
  assert.equal(p.doc.title, 'achadinhoturbo', 'fora dos Docs volta o título do painel');
});

// ---------------------------------------------------------------------------------------------------------------
// Etapa 12: progresso de leitura (localStorage 'docs.lidos')
/** localStorage falso: guarda em Map; falhaEscrita faz setItem/removeItem lançarem (cota cheia, modo privado). */
function storageFalso(inicial = {}, { falhaEscrita = false, falhaLeitura = false } = {}) {
  const m = new Map(Object.entries(inicial));
  return {
    m,
    getItem(k) { if (falhaLeitura) throw new Error('leitura bloqueada'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (falhaEscrita) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem(k) { if (falhaEscrita) throw new Error('bloqueado'); m.delete(k); },
  };
}
const TRILHA_IDS = Object.keys(SPEC).slice(0, 13);
/** Evento de clique falso: o alvo só reconhece o seletor dado em closest(). */
const alvoClique = (seletor, extra = {}) => { const { preventDefault, ...resto } = extra; const a = { ...resto, closest: (s) => (s === seletor ? a : null) }; return { target: a, preventDefault: preventDefault || (() => {}) }; };

test('progresso: sem localStorage (ou com ele bloqueado) nada quebra e não aparece progresso nenhum', async () => {
  for (const storage of [undefined, 'lanca', { getItem: 5 }]) {
    const p = montarPagina({ storage });
    const nome = typeof storage === 'string' ? storage : storage ? 'sem getItem' : 'ausente';
    assert.deepEqual(p.json('docsLidos()'), [], nome);
    assert.equal(p.rodar('docsProgressoDisponivel()'), false, nome);
    assert.equal(p.rodar('docsMarcarLido("conexoes")'), false, nome);
    assert.equal(p.rodar('docsLimparProgresso()'), false, nome);
    assert.equal(p.rodar('docsProximoNaoLido()?.id'), 'primeiros-passos', nome);
    assert.doesNotMatch(p.rodar('docsHtmlSumario("conexoes", "")'), /docs-progresso|lidos|Limpar progresso|docs-toc-lido/, nome);
    assert.doesNotMatch(p.rodar('docsHtmlInicio()'), /lidos|Fica salvo/, nome);
    assert.equal(p.rodar('docsHtmlMarcar("conexoes")'), '', nome);
    p.rodar('paginaDocs("docs/conexoes")');
    assert.doesNotMatch(p.html(), /docs-lido|Marcar como lido|docs-progresso/, nome);
    assert.equal(p.doc.activeElement?.id, 'docs-titulo', nome);
    // os cliques de progresso não fazem nada (e não lançam)
    p.pagina.onclick(alvoClique('[data-docs-limpar-progresso]'));
    p.pagina.onclick(alvoClique('.docs-nav-prox'));
    p.pagina.onclick(alvoClique('[data-docs-lido]', { checked: true }));
    await esperar(150);
    assert.equal(p.el('docs-status').textContent, 'Capítulo 2 de 13: Conexões: suas lojas', `${nome}: sem anúncio de progresso`);
  }
});

test('progresso: valor guardado inválido é ignorado (JSON quebrado, formato errado, ids desconhecidos ou de apêndice); leitura que lança = nenhum', () => {
  const lidosCom = (raw, opcoes) => { const st = storageFalso(raw === undefined ? {} : { 'docs.lidos': raw }, opcoes); return montarPagina({ storage: st }).json('docsLidos()'); };
  assert.deepEqual(lidosCom(undefined), []);
  for (const ruim of ['{{', '', 'null', '"conexoes"', '{"conexoes":true}', '5', 'true', '[', 'undefined']) assert.deepEqual(lidosCom(ruim), [], JSON.stringify(ruim));
  assert.deepEqual(lidosCom('[1,null,{"a":1},["conexoes"]]'), []);
  assert.deepEqual(lidosCom('["manutencao","xyz","perguntas","referencia","conexoes","conexoes","__proto__","constructor","primeiros-passos"]'), ['primeiros-passos', 'conexoes', 'manutencao'], 'ordem da trilha, sem repetidos, sem apêndice');
  assert.deepEqual(lidosCom('["conexoes"]', { falhaLeitura: true }), []);
  // JSON quebrado não impede de marcar: a próxima gravação conserta o valor
  const st = storageFalso({ 'docs.lidos': '{{' }); const p = montarPagina({ storage: st });
  assert.equal(p.rodar('docsMarcarLido("templates")'), true);
  assert.equal(st.m.get('docs.lidos'), '["templates"]');
});

test('progresso: marcar, desmarcar, limpar; só capítulos da trilha; falha de gravação não lança', () => {
  const st = storageFalso(); const p = montarPagina({ storage: st });
  assert.equal(p.rodar('docsProgressoDisponivel()'), true);
  assert.equal(p.rodar('docsMarcarLido("conexoes")'), true);
  assert.equal(p.rodar('docsMarcarLido("primeiros-passos")'), true);
  assert.equal(st.m.get('docs.lidos'), '["primeiros-passos","conexoes"]', 'guarda só os ids, na ordem da trilha');
  assert.equal(p.rodar('docsMarcarLido("conexoes")'), true, 'repetir não duplica');
  assert.deepEqual(p.json('docsLidos()'), ['primeiros-passos', 'conexoes']);
  assert.equal(p.rodar('docsMarcarLido("conexoes", false)'), true);
  assert.deepEqual(p.json('docsLidos()'), ['primeiros-passos']);
  for (const ruim of ['perguntas', 'referencia', 'xyz', '', undefined, null, '__proto__']) assert.equal(p.rodar(`docsMarcarLido(${JSON.stringify(ruim ?? null)})`), false, String(ruim));
  assert.deepEqual(p.json('docsLidos()'), ['primeiros-passos']);
  assert.equal(p.rodar('docsLimparProgresso()'), true);
  assert.equal(st.m.has('docs.lidos'), false); assert.deepEqual(p.json('docsLidos()'), []);
  // nada de dado pessoal no localStorage
  p.rodar('docsMarcarLido("grupos")');
  assert.deepEqual([...st.m.keys()], ['docs.lidos']); assert.match(st.m.get('docs.lidos'), /^\["grupos"\]$/);

  const cheio = storageFalso({}, { falhaEscrita: true }); const q = montarPagina({ storage: cheio });
  assert.equal(q.rodar('docsMarcarLido("conexoes")'), false);
  assert.equal(q.rodar('docsLimparProgresso()'), false);
  assert.deepEqual(q.json('docsLidos()'), []);
});

test('progresso: sumário mostra "N de 13 lidos", ✓ antes do número, "(lido)" para leitor de tela e "Limpar progresso" só com algo lido', () => {
  const st = storageFalso(); const p = montarPagina({ storage: st });
  const vazio = p.rodar('docsHtmlSumario("conexoes", "")');
  assert.match(vazio, /<p class="docs-progresso-t" id="docs-progresso-t" tabindex="-1">0 de 13 lidos<\/p>/);
  assert.match(vazio, /<progress class="docs-barra" max="13" value="0"/);
  assert.doesNotMatch(vazio, /docs-toc-lido|\(lido\)|Limpar progresso/);
  p.rodar('docsMarcarLido("primeiros-passos"); docsMarcarLido("templates")');
  const html = p.rodar('docsHtmlSumario("conexoes", "")');
  assert.match(html, /2 de 13 lidos/); assert.match(html, /value="2"/);
  assert.match(html, /<a href="#docs\/primeiros-passos"><span class="docs-toc-lido" aria-hidden="true">✓<\/span> <span class="docs-toc-n">1\.<\/span> Primeiros passos <span class="sr-only">\(lido\)<\/span><\/a>/);
  assert.match(html, /<a href="#docs\/templates"><span class="docs-toc-lido" aria-hidden="true">✓<\/span> <span class="docs-toc-n">3\./);
  assert.match(html, /<a href="#docs\/conexoes" aria-current="page"><span class="docs-toc-n">2\.<\/span> [^<]*<\/a>/, 'não lido não leva marca');
  assert.equal((html.match(/\(lido\)/g) || []).length, 2);
  assert.match(html, /<button type="button" class="leve" data-docs-limpar-progresso>Limpar progresso<\/button>/);
  // apêndice nunca entra no progresso
  p.rodar('docsMarcarLido("perguntas")');
  assert.equal((p.rodar('docsHtmlSumario("", "")').match(/\(lido\)/g) || []).length, 2);
  soTagsSeguras(html, TAGS_PAGINA, 'sumário com progresso');
});

test('progresso: Início — "Começar pelo capítulo 1", "Continuar do capítulo N" (primeiro não lido) e "Você terminou a trilha"', () => {
  const st = storageFalso(); const p = montarPagina({ storage: st });
  const inicio = () => p.rodar('docsHtmlInicio()');
  assert.match(inicio(), /<p class="docs-inicio-progresso">0 de 13 lidos\. Fica salvo só neste navegador\.<\/p>/);
  assert.match(inicio(), /<a class="btn" href="#docs\/primeiros-passos">Começar pelo capítulo 1<\/a>/);
  st.m.set('docs.lidos', '["primeiros-passos","conexoes"]');
  assert.match(inicio(), /2 de 13 lidos/);
  assert.match(inicio(), /<a class="btn" href="#docs\/templates">Continuar do capítulo 3<\/a>/);
  st.m.set('docs.lidos', '["primeiros-passos","templates"]');
  assert.match(inicio(), /<a class="btn" href="#docs\/conexoes">Continuar do capítulo 2<\/a>/, 'o primeiro que falta, não o seguinte ao último');
  st.m.set('docs.lidos', '["conexoes"]');
  assert.match(inicio(), /<a class="btn" href="#docs\/primeiros-passos">Continuar do capítulo 1<\/a>/);
  st.m.set('docs.lidos', JSON.stringify(TRILHA_IDS));
  assert.match(inicio(), /13 de 13 lidos\. Você terminou a trilha\. Fica salvo só neste navegador\./);
  assert.doesNotMatch(inicio(), /Continuar do capítulo/);
  assert.match(inicio(), /Começar pelo capítulo 1/);
  assert.equal(p.rodar('docsProximoNaoLido()'), null);
  soTagsSeguras(inicio(), TAGS_PAGINA, 'início com progresso');
});

test('progresso: na página, "Marcar como lido" marca, atualiza o sumário e anuncia; só aparece em capítulo da trilha', async () => {
  const st = storageFalso(); const p = montarPagina({ storage: st });
  p.rodar('paginaDocs("docs/conexoes")');
  assert.match(p.html(), /<p class="docs-marcar"><label><input type="checkbox" id="docs-lido" data-docs-lido="conexoes"> Marcar como lido<\/label><\/p>/);
  assert.ok(p.html().indexOf('docs-marcar') < p.html().indexOf('<nav class="docs-nav"'), 'a caixa vem antes do Anterior/Próximo');
  assert.match(p.html(), /0 de 13 lidos/);
  soTagsSeguras(p.html(), TAGS_DOM, 'página com progresso');
  const caixa = p.el('docs-lido'); caixa.checked = true;
  p.pagina.onclick(alvoClique('[data-docs-lido]', { checked: true }));
  assert.equal(st.m.get('docs.lidos'), '["conexoes"]');
  assert.match(p.el('docs-toc').innerHTML, /^<summary>Sumário · cap\. 2 de 13 · Conexões: suas lojas<\/summary>/);
  assert.match(p.el('docs-toc').innerHTML, /1 de 13 lidos/); assert.match(p.el('docs-toc').innerHTML, /✓<\/span> <span class="docs-toc-n">2\./);
  assert.equal(caixa.checked, true);
  await esperar(150); assert.equal(p.el('docs-status').textContent, 'Capítulo 2 marcado como lido');
  p.pagina.onclick(alvoClique('[data-docs-lido]', { checked: false }));
  assert.equal(st.m.get('docs.lidos'), '[]'); assert.match(p.el('docs-toc').innerHTML, /0 de 13 lidos/); assert.doesNotMatch(p.el('docs-toc').innerHTML, /docs-toc-lido/);
  assert.equal(caixa.checked, false);
  await esperar(150); assert.equal(p.el('docs-status').textContent, 'Capítulo 2 desmarcado');

  // a página abre com a caixa marcada quando já foi lido
  st.m.set('docs.lidos', '["conexoes"]'); p.rodar('paginaDocs("docs/conexoes")');
  assert.match(p.html(), /data-docs-lido="conexoes" checked>/);
  assert.match(p.html(), /<a href="#docs\/conexoes" aria-current="page"><span class="docs-toc-lido"/);

  // início, apêndices e capítulo inexistente não têm a caixa
  for (const pedido of ['docs', 'docs/perguntas', 'docs/referencia', 'docs/xyz']) { p.rodar(`paginaDocs(${JSON.stringify(pedido)})`); assert.doesNotMatch(p.html(), /docs-lido|Marcar como lido/, pedido); }
});

test('progresso: gravação que falha não deixa a caixa mentir nem lança; "Próximo" marca o atual e o link segue', () => {
  const cheio = storageFalso({}, { falhaEscrita: true }); const p = montarPagina({ storage: cheio });
  p.rodar('paginaDocs("docs/templates")');
  const caixa = p.el('docs-lido'); caixa.checked = true;
  assert.doesNotThrow(() => p.pagina.onclick(alvoClique('[data-docs-lido]', { checked: true })));
  assert.equal(caixa.checked, false, 'a caixa volta ao que está guardado');
  assert.doesNotThrow(() => p.pagina.onclick(alvoClique('.docs-nav-prox')));

  const st = storageFalso(); const q = montarPagina({ storage: st });
  q.rodar('paginaDocs("docs/templates")');
  let impediu = false;
  q.pagina.onclick(alvoClique('.docs-nav-prox', { preventDefault() { impediu = true; } }));
  assert.equal(st.m.get('docs.lidos'), '["templates"]'); assert.equal(impediu, false, 'o link navega normalmente');
  // no apêndice e no Início o "Próximo" não marca nada
  q.rodar('paginaDocs("docs/perguntas")'); q.pagina.onclick(alvoClique('.docs-nav-prox'));
  q.rodar('paginaDocs("docs")'); q.pagina.onclick(alvoClique('.docs-nav-prox'));
  assert.equal(st.m.get('docs.lidos'), '["templates"]');
  // último capítulo: "Continue com Perguntas reais" também conta como lido
  q.rodar('paginaDocs("docs/manutencao")'); q.pagina.onclick(alvoClique('.docs-nav-prox'));
  assert.equal(st.m.get('docs.lidos'), '["templates","manutencao"]');
});

test('progresso: "Limpar progresso" apaga, atualiza o sumário e o Início, leva o foco ao resumo e anuncia', async () => {
  const st = storageFalso({ 'docs.lidos': '["primeiros-passos","conexoes"]' }); const p = montarPagina({ storage: st });
  p.rodar('paginaDocs("docs")');
  assert.match(p.html(), /Continuar do capítulo 3/); assert.match(p.html(), /Limpar progresso/);
  p.pagina.onclick(alvoClique('[data-docs-limpar-progresso]'));
  assert.equal(st.m.has('docs.lidos'), false);
  assert.match(p.el('docs-toc').innerHTML, /0 de 13 lidos/); assert.doesNotMatch(p.el('docs-toc').innerHTML, /Limpar progresso|docs-toc-lido/);
  assert.match(p.el('docs-inicio-cta').innerHTML, /Começar pelo capítulo 1/); assert.doesNotMatch(p.el('docs-inicio-cta').innerHTML, /Continuar/);
  assert.equal(p.doc.activeElement?.id, 'docs-progresso-t');
  await esperar(150); assert.equal(p.el('docs-status').textContent, 'Progresso apagado.');
  // com a gravação bloqueada o clique também não lança
  const bloq = storageFalso({ 'docs.lidos': '["conexoes"]' }, { falhaEscrita: true }); const q = montarPagina({ storage: bloq });
  q.rodar('paginaDocs("docs")');
  assert.doesNotThrow(() => q.pagina.onclick(alvoClique('[data-docs-limpar-progresso]')));
  assert.match(q.el('docs-toc').innerHTML, /1 de 13 lidos/, 'continua o que está guardado');
});

// ---------------------------------------------------------------------------------------------------------------
// Etapa 14: coerência entre os Docs (public/docs/cap-*.js), o README e o código. Número que aparece nos dois textos
// entra na tabela FATOS: o texto é montado a partir do valor, então mudar só o código, só o README ou só o capítulo
// derruba o teste.
// ---------------------------------------------------------------------------------------------------------------
const lerRaiz = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
/** Texto corrido sem a marcação (negrito, código) e com espaços normalizados. */
const limpo = (t) => t.replace(/\*\*|`/g, '').replace(/\s+/g, ' ');
const README = limpo(lerRaiz('README.md'));
const TEXTO_DOCS = limpo(strings(CAPS).join('\n'));
const milhar = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, '.');
const PALAVRA = { 5: 'cinco' };
const numero = (v) => [String(v), ...(PALAVRA[v] ? [PALAVRA[v]] : [])].join('|');

/**
 * texto: (valor) → RegExp que o README e os Docs precisam conter. codigo: [arquivo, regex com 1 grupo numérico]:
 * cada constante tem de valer `valor`. `readme`/`docs` trocam o texto de um lado só quando a redação difere.
 */
const FATOS = [
  { nome: 'limite máximo do grupo', valor: 1024, texto: (v) => new RegExp(milhar(v).replace('.', '\\.')), codigo: [['src/rotador.js', /export const LIMITE_MAX = (\d+);/]] },
  { nome: 'limite padrão do link novo', valor: 1000, texto: (v) => new RegExp(`padrão ${milhar(v).replace('.', '\\.?')}\\b`), codigo: [['src/avisos.js', /limite_padrao: (\d+) \}/]] },
  { nome: 'aviso de lotação', valor: 95, texto: (v) => new RegExp(`${v}% do limite`), codigo: [['src/rotador.js', /export const LOTACAO_PCT = (\d+);/]] },
  { nome: 'rearme do aviso de lotação', valor: 90, texto: (v) => new RegExp(`abaixo de ${v}%`), codigo: [['src/avisos.js', /const LOTACAO_REARME_PCT = (\d+);/]] },
  { nome: 'retenção padrão', valor: 90, texto: (v) => new RegExp(`padrão(?: é)? ${v} dias`), codigo: [['src/privacidade.js', /export const RETENCAO_PADRAO_DIAS = (\d+);/]] },
  { nome: 'teto da revisão do Catálogo', valor: 50, texto: (v) => new RegExp(`até ${v} (?:ofertas esperando|para revisar)`), codigo: [['src/catalogo-itens.js', /export const TETO_REVISAO = (\d+);/]] },
  { nome: 'links por hora da Shopee pela extensão', valor: 60, texto: (v) => new RegExp(`${v} links por hora pela extensão`), codigo: [['src/links.js', /const LIMITE_SHOPEE_HORA = (\d+);/]] },
  { nome: 'consultas por hora à Shopee', valor: 300, texto: (v) => new RegExp(`${v} consultas por hora`), codigo: [['src/shopee.js', /const LIMITE_HORA = (\d+);/]] },
  { nome: 'links por hora por grupo de origem (espelhamento)', valor: 60, texto: (v) => new RegExp(`${v} links por hora,? por (?:espelhamento e por )?grupo de origem`), codigo: [['src/espelho.js', /const MAX_LINKS_HORA = (\d+);/]] },
  { nome: 'dedupe do espelhamento', valor: 168, texto: (v) => new RegExp(`${v} h(?:oras)?\\b`), codigo: [['src/db.js', /dedupe_horas INTEGER NOT NULL DEFAULT (\d+)/], ['src/espelho.js', /lerInteiro\(b\.dedupe_horas, (\d+),/]] },
  { nome: 'horários da repetição', valor: 6, texto: (v) => new RegExp(`(?:até|a) ${v} horários`), codigo: [['src/envios.js', /const MAX_HORARIOS = (\d+);/]] },
  { nome: 'vida da sessão (dias)', valor: 30, texto: (v) => new RegExp(`sessão[^.]{0,50}por ${v} dias`, 'i'), codigo: [['src/auth.js', /export const SESSION_MS = (\d+) \* 24 \* 60 \* 60 \* 1000;/]] },
  { nome: 'sessão sem uso (dias)', valor: 7, texto: (v) => new RegExp(`${v} dias sem (?:uso|usar)`), codigo: [['src/auth.js', /export const INATIVIDADE_MS = (\d+) \* 24 \* 60 \* 60 \* 1000;/]] },
  { nome: 'produtos por página da Central de Afiliados', valor: 18, texto: (v) => new RegExp(`traz ${v} produtos`), codigo: [['src/afiliados.js', /export const POR_PAGINA = (\d+);/]] },
  { nome: 'ofertas por página do catálogo', valor: 200, texto: (v) => new RegExp(`páginas de ${v} ofertas|${v} ofertas por página`), codigo: [['src/catalogo.js', /const LIMITE = (\d+);/]] },
  { nome: 'erros de senha até o bloqueio', valor: 5, texto: (v) => new RegExp(`(?:${numero(v)}) (?:tentativas|senhas) erradas bloqueiam o IP`, 'i'), codigo: [['src/server.js', /const loginLimiter = createLimiter\(\{ max: (\d+),/]] },
  { nome: 'minutos do bloqueio de login', valor: 15, texto: (v) => new RegExp(`bloqueiam o IP por ${v} minutos`), codigo: [['src/server.js', /const loginLimiter = createLimiter\(\{ max: \d+, windowMs: (\d+) \* 60 \* 1000 \}\)/]] },
  { nome: 'pausa padrão entre grupos', valor: 6, texto: (v) => new RegExp(`\\b${v} s entre grupos`), codigo: [['src/server.js', /getSetting\(db, 'delay_group_s', (\d+)\)/], ['src/scheduler.js', /getSetting\(db, 'delay_group_s', (\d+)\)/], ['src/envios.js', /getSetting\(db, 'delay_group_s', (\d+)\)/]] },
  { nome: 'pausa padrão entre ofertas', valor: 30, texto: (v) => new RegExp(`\\b${v} s entre ofertas`), codigo: [['src/server.js', /getSetting\(db, 'delay_offer_s', (\d+)\)/], ['src/scheduler.js', /getSetting\(db, 'delay_offer_s', (\d+)\)/]] },
  { nome: 'pausa mínima entre grupos', valor: 2, texto: (v) => new RegExp(`mínimo de ${v} s e de \\d+ s`), codigo: [['src/server.js', /setSetting\(db, 'delay_group_s', Math\.max\((\d+),/]] },
  { nome: 'pausa mínima entre ofertas', valor: 5, texto: (v) => new RegExp(`mínimo de \\d+ s e de ${v} s`), codigo: [['src/server.js', /setSetting\(db, 'delay_offer_s', Math\.max\((\d+),/]] },
  { nome: 'atraso máximo de um agendado (horas)', valor: 2, texto: (v) => new RegExp(`perde o horário por mais de ${v} horas`), codigo: [['src/envios.js', /const ATRASO_MAX = (\d+) \* 3600000;/]] },
  { nome: 'tamanho máximo da mensagem', valor: 4096, texto: (v) => new RegExp(`[Aa]té ${v} caracteres`), codigo: [['src/envios.js', /const MAX_TEXTO = (\d+);/]] },
  { nome: 'validade do convite (dias)', valor: 7, texto: (v) => new RegExp(`(?:convite|link) vale ${v} dias`), codigo: [['src/auth.js', /export const CONVITE_MS = (\d+) \* 24 \* 60 \* 60 \* 1000;/]] },
  { nome: 'fontes por regra', valor: 5, texto: (v) => new RegExp(`aceita até (?:${numero(v)}) fontes`), codigo: [['src/db.js', /export const MAX_SOURCES = (\d+);/]] },
  { nome: 'Sub_ids da Shopee por envio', valor: 10, texto: (v) => new RegExp(`até ${v} Sub_ids por envio`), codigo: [['src/envios.js', /export const MAX_SUBIDS_POR_ENVIO = (\d+);/]] },
  { nome: 'tamanho do Sub_id da Shopee', valor: 30, texto: (v) => new RegExp(`Sub_id[^.]{0,80}até ${v} caracteres`), codigo: [['src/shopee.js', /export const RE_SUB_ID = \/\^\[A-Za-z0-9\]\{1,(\d+)\}\$\/;/], ['src/rastreio.js', /export const MAX_SUB_ID = (\d+);/]] },
  { nome: 'guarda do histórico do rastreio (dias)', valor: 400, texto: (v) => new RegExp(`histórico do rastreio[^.]{0,80}${v} dias`), codigo: [['src/rastreio.js', /export const RETENCAO_RASTREIO_DIAS = (\d+);/]] },
  { nome: 'cobertura Boa (%)', valor: 90, texto: (v) => new RegExp(`Boa[^.]{0,30}${v}% ou mais`), codigo: [['public/ganhos.js', /const chave = p >= (\d+) \? 'boa'/]] },
  { nome: 'cobertura Baixa (%)', valor: 60, texto: (v) => new RegExp(`Baixa[^.]{0,30}abaixo de ${v}%`), codigo: [['public/ganhos.js', /p >= \d+ \? 'boa' : p >= (\d+) \? 'parcial'/]] },
  { nome: 'cobertura da loja que leva Atenção (%)', valor: 80, texto: (v) => new RegExp(`Atenção[^.]{0,120}abaixo de ${v}%`), codigo: [['public/ganhos.js', /const GANHOS_LIMIAR_LOJA = (\d+);/]] },
  { nome: 'tamanho máximo do arquivo de comissões (MB)', valor: 5, texto: (v) => new RegExp(`até ${v} MB`), codigo: [['src/csv.js', /export const MAX_BYTES_ARQUIVO = (\d+) \* 1024 \* 1024;/], ['public/ganhos.js', /const GANHOS_MAX_BYTES = (\d+) \* 1024 \* 1024;/]] },
  // 100_000 no código: o grupo captura só as centenas de milhar (o "_000" fixo); o texto diz "até 100.000 linhas"
  { nome: 'linhas máximas do arquivo de comissões (milhares)', valor: 100, texto: (v) => new RegExp(`até ${v}\\.000 linhas`), codigo: [['src/csv.js', /export const MAX_LINHAS_ARQUIVO = (\d+)_000;/]] },
  { nome: 'dias máximos de um gasto com anúncios', valor: 366, texto: (v) => new RegExp(`gasto[^.]{0,60}até ${v} dias`), codigo: [['src/ganhos.js', /export const MAX_DIAS_GASTO = (\d+);/], ['public/ganhos.js', /const GANHOS_MAX_DIAS_GASTO = (\d+);/]] },
  { nome: 'caracteres da observação do gasto', valor: 200, texto: (v) => new RegExp(`observação[^.]{0,40}até ${v} caracteres`), codigo: [['src/ganhos.js', /export const MAX_NOTA = (\d+);/], ['public/ganhos.js', /const GANHOS_MAX_NOTA = (\d+);/]] },
  // Remetente (envio pelo sócio, plano envio-pelo-socio, etapa 8): o que o dono vê no cadastro e o que o sócio recebe.
  { nome: 'links por hora do remetente (padrão)', valor: 10, texto: (v) => new RegExp(`${v} links por hora por remetente`), codigo: [['src/db.js', /CREATE TABLE IF NOT EXISTS remetentes \([^;]*?max_por_hora INTEGER NOT NULL DEFAULT (\d+)/]] },
  { nome: 'links por hora do remetente (máximo)', valor: 60, texto: (v) => new RegExp(`de 1 a ${v} links por hora`), codigo: [['src/remetentes.js', /const MAX_POR_HORA = (\d+);/]] },
  { nome: 'horas sem repetir do remetente (padrão)', valor: 24, texto: (v) => new RegExp(`${v} h(?:oras)? sem repetir`), codigo: [['src/db.js', /CREATE TABLE IF NOT EXISTS remetentes \([^;]*?dedupe_horas INTEGER NOT NULL DEFAULT (\d+)/]] },
  { nome: 'links por mensagem do remetente', valor: 5, texto: (v) => new RegExp(`[Aa]té (?:${numero(v)}) links por mensagem`), codigo: [['src/oferta-texto.js', /export const MAX_URLS = (\d+);/]] },
  { nome: 'link parado do remetente na fila (horas)', valor: 2, texto: (v) => new RegExp(`parado na fila por mais de ${v} h expira`), codigo: [['src/remetentes.js', /const PARADO_MAX = (\d+) \* HORA;/]] },
  { nome: 'respostas por hora ao remetente', valor: 20, texto: (v) => new RegExp(`até ${v} respostas por hora`), codigo: [['src/remetentes.js', /const MAX_RESPOSTAS_HORA = (\d+);/]] },
  // Grade de horários e Grupo vivo (plano grade-de-disparos, etapa 9, CA14)
  { nome: 'horários da grade', valor: 48, texto: (v) => new RegExp(`até ${v} horários`), codigo: [['src/grade.js', /export const MAX_HORARIOS_GRADE = (\d+);/]] },
  { nome: 'minutos entre dois horários da grade', valor: 10, texto: (v) => new RegExp(`pelo menos ${v} min entre`), codigo: [['src/grade.js', /export const INTERVALO_MIN_GRADE = (\d+);/]] },
  { nome: 'ofertas por horário da grade', valor: 20, texto: (v) => new RegExp(`de 1 a ${v} ofertas por horário`), codigo: [['src/grade.js', /export const MAX_QTD_GRADE = (\d+);/]] },
  { nome: 'tolerância de um horário perdido (min)', valor: 30, texto: (v) => new RegExp(`atrasou até ${v} min`), codigo: [['src/grade.js', /export const TOLERANCIA_MIN = (\d+);/]] },
  { nome: 'textos ou enquetes por rotina do Grupo vivo', valor: 5, texto: (v) => new RegExp(`até (?:${numero(v)}) (?:textos|enquetes)`), codigo: [['src/rotinas.js', /export const MAX_CONTEUDOS = (\d+);/]] },
  { nome: 'horários por rotina do Grupo vivo', valor: 6, texto: (v) => new RegExp(`até ${v} horários por rotina`), codigo: [['src/rotinas.js', /export const MAX_HORARIOS_ROTINA = (\d+);/]] },
  { nome: 'rotinas do Grupo vivo', valor: 50, texto: (v) => new RegExp(`até ${v} rotinas`), codigo: [['src/rotinas.js', /export const MAX_ROTINAS = (\d+);/]] },
  { nome: '"Enviar agora" de uma rotina do Grupo vivo (min entre dois)', valor: 1, texto: (v) => new RegExp(`um(?: “Enviar agora”)? a cada ${v} min\\b`), codigo: [['src/rotinas.js', /export const ENVIAR_AGORA_INTERVALO_MIN = (\d+);/]] },
  { nome: 'atualização automática da lista do Grupo vivo (s)', valor: 10, texto: (v) => new RegExp(`se atualiza sozinha a cada ${v} s\\b`), codigo: [['public/app.js', /rotaAtual\(\) === 'grupo-vivo' && !\$\('#dlg'\)\.open\) gvAtualizar\(\)\.catch\(\(\) => \{\}\); \}, (\d+)000\);/]] },
  { nome: 'mensagens por dia que ativam o aviso', valor: 400, texto: (v) => new RegExp(`mais de ${milhar(v)} mensagens por dia`), codigo: [['public/grade.js', /const AVISO_MENSAGENS_DIA = (\d+);/]] },
];

test('FATOS: cada número aparece nos Docs e no README e bate com a constante do código', () => {
  assert.ok(FATOS.length >= 15);
  for (const f of FATOS) {
    assert.ok(Number.isInteger(f.valor), f.nome);
    for (const [arq, re] of f.codigo) {
      const m = re.exec(lerRaiz(arq));
      assert.ok(m, `${f.nome}: não achei a constante em ${arq} (${re})`);
      assert.equal(Number(m[1]), f.valor, `${f.nome}: ${arq} diz ${m[1]}, a tabela diz ${f.valor}`);
    }
    const texto = f.texto(f.valor);
    assert.match(TEXTO_DOCS, texto, `${f.nome}: os Docs (public/docs/cap-*.js) não trazem ${texto}`);
    assert.match(README, texto, `${f.nome}: o README não traz ${texto}`);
  }
});

test('FATOS: o texto montado do valor não casa com outro valor (a tabela de fato pega uma mudança de número)', () => {
  for (const f of FATOS) {
    const outro = f.texto(f.valor + 1);
    assert.doesNotMatch(README + '\n' + TEXTO_DOCS, outro, `${f.nome}: ${outro} também casa; o texto não prova o valor`);
  }
});

// A versão da extensão que manda o Sub_id da Shopee (P4) não é um inteiro: fica fora de FATOS, mas segue a mesma ideia. A fonte é
// extension/manifest.json (a versão com o campo `SHOPEE_SUBID_CAMPO`); README, Docs, TIPS e o painel citam "1.4.1 ou mais nova".
test('P4: a versão da extensão citada para o Sub_id da Shopee aparece no README, nos Docs, no TIPS e no painel, e o manifest já é essa ou mais nova', () => {
  const citada = '1.4.1';
  const texto = new RegExp(`versão ${citada.replace(/\./g, '\\.')} ou mais nova`);
  assert.match(README, texto, 'README');
  assert.match(TEXTO_DOCS, texto, 'Docs');
  assert.match(limpo(lerRaiz('public/ajuda.js')), new RegExp(`versão ${citada.replace(/\./g, '\\.')} ou mais nova`), 'ajuda.js');
  assert.match(lerRaiz('public/ganhos.js'), new RegExp(`versão ${citada.replace(/\./g, '\\.')} ou mais nova`), 'public/ganhos.js');
  const versao = JSON.parse(lerRaiz('extension/manifest.json')).version.split('.').map(Number);
  const pedida = citada.split('.').map(Number);
  const ok = versao[0] > pedida[0] || (versao[0] === pedida[0] && (versao[1] > pedida[1] || (versao[1] === pedida[1] && versao[2] >= pedida[2])));
  assert.ok(ok, `o manifest (${versao.join('.')}) é mais velho que a versão citada (${citada})`);
  assert.match(lerRaiz('extension/background.js'), /const SHOPEE_SUBID_CAMPO = 'subId1';/, 'o campo do Sub_id está ligado na extensão');
});

// ---------------------------------------------------------------------------------------------------------------
// Remetente (plano envio-pelo-socio, etapa 8, CA13): verbetes, glossário, seção do capítulo e README. As frases que o
// sócio recebe vêm de RESPOSTAS (src/remetentes.js): a documentação precisa citá-las como o programa as manda.
// ---------------------------------------------------------------------------------------------------------------
const TIPS_REMETENTE = ['remetente', 'remetente.numero', 'remetente.destino', 'remetente.responder', 'remetente.limite'];
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Regex da frase, com os números trocados por \d+ (a documentação mostra um exemplo, o programa conta de verdade). */
const frase = (t) => new RegExp(escRe(limpo(t)).replace(/\d+/g, '\\d+'));

function tipsDoPainel() {
  const noop = () => {};
  const ctx = vm.createContext({ document: { addEventListener: noop, getElementById: () => null }, addEventListener: noop, innerWidth: 1280, innerHeight: 800 });
  vm.runInContext(fonte('ajuda.js'), ctx, { filename: 'public/ajuda.js' });
  return JSON.parse(vm.runInContext('JSON.stringify(TIPS)', ctx));
}

test('Remetente: os cinco verbetes de TIPS existem, em linguagem simples, com os números certos', () => {
  const T = tipsDoPainel();
  for (const k of TIPS_REMETENTE) {
    assert.ok(typeof T[k] === 'string' && T[k].length >= 40 && T[k].length <= 520, `TIPS.${k}: ${T[k]?.length}`);
    assert.doesNotMatch(T[k], /\b(jid|lid|hmac|payload|endpoint|json|sqlite|baileys)\b/i, `TIPS.${k}: jargão`);
  }
  assert.match(T['remetente'], /número/i);
  assert.match(T['remetente'], /sua (?:etiqueta|tag|afiliação)|sua conta/i, 'o link sai com a afiliação do dono');
  assert.match(T['remetente.numero'], /DDD/);
  assert.match(T['remetente.numero'], /só (?:no|neste) seu computador|fica só no seu computador/i);
  assert.match(T['remetente.destino'], /grupos?/i);
  assert.match(T['remetente.responder'], /frase/i);
  assert.doesNotMatch(T['remetente.responder'], /link de afiliado/i);
  const lim = T['remetente.limite'];
  assert.match(lim, /\b10\b/, 'padrão de 10 links por hora'); assert.match(lim, /\b60\b/, 'máximo de 60');
  assert.match(lim, /\b24\b/, 'padrão de 24 h sem repetir');
});

test('Remetente: o glossário tem o verbete "Remetente" e a tabela de limites traz a linha do remetente', () => {
  const g = CAPS.referencia.secoes.find((s) => s.id === 'glossario').blocos.filter((b) => b.termos).flatMap((b) => b.termos);
  const v = g.find(([x]) => x === 'Remetente');
  assert.ok(v, 'glossário: Remetente'); assert.ok(g.filter(([x]) => x === 'Remetente').length === 1);
  assert.match(v[1], /número/); assert.match(v[1], /Disparo automático/);
  assert.ok(primeiraColuna('referencia', 'limites').some((x) => /^Remetente/.test(x)), 'limites: linha do Remetente');
});

test('Remetente: a seção "remetentes" do Disparo automático cobre cadastro, as 3 lojas, as respostas, os limites e a LGPD', async () => {
  const { RESPOSTAS } = await import('../src/remetentes.js');
  const sec = CAPS['disparo-automatico'].secoes.find((s) => s.id === 'remetentes');
  assert.ok(sec, 'seção remetentes em disparo-automatico');
  assert.ok(sec.onde && /Novo remetente/.test(sec.onde));
  const txt = limpo(strings(sec.blocos).join('\n'));
  // cadastrar
  for (const r of [/Novo remetente/, /Nome/, /Número do remetente/, /Grupos de destino/, /Template/, /Etiqueta do Mercado Livre/, /Responder ao remetente/, /Criar remetente/]) assert.match(txt, r);
  // as 3 lojas e a afiliação do dono
  for (const r of [/Mercado Livre/, /Amazon/, /Shopee/, /extensão/, /tag de associado/, /ID de afiliado/, /nunca reenvia o link que o remetente mandou/]) assert.match(txt, r);
  assert.match(txt, /sempre com a sua afiliação|sempre sai com a sua/i);
  // as frases que o sócio recebe
  const frases = [RESPOSTAS.enviadoTodos(1), RESPOSTAS.enviadoTodos(3), RESPOSTAS.enviadoParte(2, 3), RESPOSTAS.falhaEnvio, RESPOSTAS.repetida(3), RESPOSTAS.montar, RESPOSTAS.sem_dados,
    RESPOSTAS.link_invalido, RESPOSTAS.sem_link_de_loja, RESPOSTAS.limite, RESPOSTAS.varios(3, { enviados: 2, repetidos: 1, nao: 0 })];
  for (const f of frases) assert.match(txt, frase(f), `a seção não traz a frase: ${f}`);
  assert.match(txt, /nunca (?:leva|levam)[^.]*link/i); assert.match(txt, /silêncio/);
  // limites
  for (const r of [/10 links por hora por remetente/, /de 1 a 60 links por hora/, /24 h sem repetir/, /até 5 links por mensagem/, /parado na fila por mais de 2 h expira/, /até 20 respostas por hora/]) assert.match(txt, r);
  // o programa não processa o que chegou com ele fora do ar (nem promete a regra antiga de "mensagem com mais de 2 h")
  assert.match(txt, /desligado ou sem conexão não é processada/); assert.match(txt, /precisa mandar de novo/);
  assert.doesNotMatch(txt, /mais de 2 h é ignorada/);
  // a Shopee exige também a API ou a extensão, não só o ID (R1)
  assert.match(txt, /ID de afiliado em [\[*]*Conexões → Shopee[\]*]* e a API da Shopee ou a extensão do Chrome conectada/);
  // backups já feitos continuam com o número até saírem do rodízio (S4)
  assert.match(txt, /backups que você já fez continuam com o número até saírem do rodízio[^.]*7 mais recentes/);
  // o aviso de tag ou ID só aparece depois que um link foi barrado
  assert.match(txt, /depois que um link foi barrado/);
  // LGPD
  for (const r of [/só no seu computador/, /entra no backup/, /apagado ao excluir o remetente|apaga o número/, /texto da mensagem não é guardado/]) assert.match(txt, r);
  // nada de promessa que o programa não cumpre
  assert.doesNotMatch(txt, /Avisei o dono|Recebi\. Sai assim/);
});

test('Remetente: o README tem a seção, as frases do sócio, os limites e a LGPD (e o Histórico lista o tipo)', async () => {
  const { RESPOSTAS } = await import('../src/remetentes.js');
  assert.match(README_BRUTO, /^## Remetente/m);
  const i = README_BRUTO.search(/^## Remetente/m); const resto = README_BRUTO.slice(i + 5); const fim = resto.search(/^## /m);
  const txt = limpo(resto.slice(0, fim < 0 ? undefined : fim));
  for (const f of [RESPOSTAS.enviadoTodos(3), RESPOSTAS.enviadoParte(2, 3), RESPOSTAS.repetida(3), RESPOSTAS.sem_dados, RESPOSTAS.sem_link_de_loja, RESPOSTAS.limite]) assert.match(txt, frase(f), `README sem a frase: ${f}`);
  for (const r of [/Mercado Livre/, /Amazon/, /Shopee/, /entra no backup/, /apagado ao excluir o remetente/, /texto da mensagem não é guardado/, /silêncio/, /Novo remetente/]) assert.match(txt, r);
  assert.match(limpo(README_BRUTO), /Tudo, Disparo automático, Espelhamento, Catálogo ou Remetente/);
  assert.match(txt, /ID de afiliado em [\[*]*Conexões → Shopee[\]*]* e a API da Shopee ou a extensão do Chrome conectada/);
  assert.match(txt, /não é processado/); assert.match(txt, /precisa mandar de novo/); assert.doesNotMatch(txt, /mais de 2 h é ignorada/);
  assert.match(txt, /backups que você já fez continuam com o número até saírem do rodízio[^.]*7 mais recentes/);
  assert.match(txt, /depois que um link do remetente foi barrado/);
  const privacidade = limpo(README_BRUTO.slice(README_BRUTO.search(/^## Privacidade \(LGPD\)/m)));
  assert.match(privacidade, /Remetente/, 'a seção de privacidade cita o Remetente');
});

test('Remetente: o prazo de guarda, o botão "Apagar o que já passou do prazo" e o link direto citam os itens dos remetentes', () => {
  const sec = (cap, id) => limpo(strings(CAPS[cap].secoes.find((x) => x.id === id).blocos).join('\n'));
  const retencao = sec('privacidade', 'retencao');
  assert.match(retencao, /itens já decididos dos remetentes/);
  assert.match(retencao, /fila do espelhamento e dos remetentes/);
  assert.match(limpo(strings(CAPS.manutencao.secoes.flatMap((x) => x.blocos)).join('\n')), /Catálogo ou de um remetente não saem/);
  // o aviso do botão mostra o que foi apagado dos remetentes (o servidor devolve `remetentes`)
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\$\{r\.remetentes \?\? 0\} itens dos remetentes/);
});

test('Remetente: o capítulo do Histórico lista o tipo Remetente', () => {
  assert.match(limpo(strings(CAPS.resultados).join('\n')), /Tudo, Disparo automático, Espelhamento, Catálogo ou Remetente/);
});

/** Primeira coluna de todas as tabelas de uma seção. */
const primeiraColuna = (cap, secao) => CAPS[cap].secoes.find((s) => s.id === secao).blocos.filter((b) => b.tabela).flatMap((b) => b.tabela.linhas.map((l) => l[0]));

test('referencia/estados: todo selo citado existe literalmente em public/conexoes.js', () => {
  const src = fonte('conexoes.js');
  const selos = primeiraColuna('referencia', 'estados');
  assert.ok(selos.length >= 14, `selos: ${selos.length}`);
  for (const s of selos) assert.ok(["'", '"', '`'].some((q) => src.includes(q + s + q)), `selo “${s}” não existe em public/conexoes.js`);
});

test('referencia/motivos: a primeira tabela cobre exatamente os MOTIVOS de src/catalogo-itens.js, com o rótulo do Histórico', () => {
  assert.equal(MOTIVOS.length, 4);
  const bloco = /motivos: \{([^}]*)\}/.exec(fonte('espelhamento.js'));
  assert.ok(bloco, 'não achei o mapa de rótulos dos motivos em public/espelhamento.js');
  const rotulos = MOTIVOS.map((m) => { const r = new RegExp(`\\b${m}: '([^']+)'`).exec(bloco[1]); assert.ok(r, `motivo ${m} sem rótulo em public/espelhamento.js`); return r[1]; });
  const tabela = CAPS.referencia.secoes.find((s) => s.id === 'motivos').blocos.find((b) => b.tabela).tabela;
  assert.deepEqual(tabela.linhas.map((l) => l[0]).sort(), [...rotulos].sort());
});

test('nenhum capítulo ficou em preparação', () => {
  assert.ok(CAPS_ARQ.length >= 7);
  for (const arq of CAPS_ARQ) assert.doesNotMatch(fonte(arq), /Conteúdo em preparação/i, arq);
  assert.doesNotMatch(strings(CAPS).join('\n'), /Conteúdo em preparação/i);
});

test('perguntas: as 10 da spec existem, cada uma com "onde" e "leia" que apontam para uma seção real', () => {
  assert.equal(SPEC.perguntas.length, 10);
  const secoes = CAPS.perguntas.secoes;
  assert.deepEqual(secoes.filter((s) => SPEC.perguntas.includes(s.id)).map((s) => s.id), SPEC.perguntas);
  for (const s of secoes) {
    assert.ok(typeof s.onde === 'string' && s.onde.trim() !== '', `perguntas/${s.id}: sem "onde"`);
    assert.match(s.leia ?? '', /^[a-z0-9-]+\/[a-z0-9-]+$/, `perguntas/${s.id}: "leia" inválido`);
    const [c, sec] = s.leia.split('/');
    assert.ok(CAPS[c]?.secoes.some((x) => x.id === sec), `perguntas/${s.id}: leia ${s.leia} não existe`);
    assert.ok(s.blocos.length > 0, s.id);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Rodada 1 de correções (R1, R4, S1, S2, S3): simulação em pasta própria, restaurar fora do projeto, limpar o log
// também no syslog, a segunda pergunta do "Desconectar" e o token da extensão.
// ---------------------------------------------------------------------------------------------------------------
const README_BRUTO = lerRaiz('README.md');
const blocosDe = (cap, secao) => { const s = CAPS[cap].secoes.find((x) => x.id === secao); assert.ok(s, `${cap}/${secao} não existe`); return s.blocos; };
const comandosDe = (cap, secao) => blocosDe(cap, secao).filter((b) => Object.hasOwn(b, 'comando')).map((b) => b.comando);
const textoDe = (cap, secao) => limpo(strings(blocosDe(cap, secao)).join('\n'));
const todosComandos = () => Object.values(CAPS).flatMap((c) => c.secoes.flatMap((s) => s.blocos.filter((b) => Object.hasOwn(b, 'comando')).map((b) => b.comando)));

test('S2: toda pasta citada nos comandos de restaurar e de simular (Docs e README) fica fora do projeto ou ignorada pelo git', (t) => {
  if (spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: RAIZ }).status !== 0) return t.skip('sem git ou fora de um repositório');
  const simulacao = path.relative(RAIZ, pastaDeDados({ env: {}, argv: ['--simular'], raiz: RAIZ }));
  assert.equal(simulacao, 'data-simulacao');
  const comandos = [...todosComandos(), ...[...README_BRUTO.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])];
  const pastas = new Set([simulacao]);
  for (const c of comandos) {
    const r = /\brestaurar\s+(\S+)\s+(\S+)/.exec(c);
    if (r) { if (r[1].includes('/')) pastas.add(path.dirname(r[1])); pastas.add(r[2]); }
    for (const m of c.matchAll(/(?:^|&&|;)\s*mv\s+(\S+)\s+(\S+)/g)) { pastas.add(m[1]); pastas.add(m[2]); }
  }
  // pasta de dados citada no texto corrido (data-simulacao, data-antiga…), dos dois lados
  for (const txt of [TEXTO_DOCS, README]) for (const m of txt.matchAll(/(?<![\w/.-])data-[a-z]+(?![\w-])/g)) pastas.add(m[0]);
  for (const p of ['data-simulacao', 'data-antiga', 'data', '../achadinho-restaurado']) assert.ok(pastas.has(p), `esperava ver ${p} nos comandos ou no texto`);
  let dentro = 0;
  for (const p of pastas) {
    const rel = path.relative(RAIZ, path.resolve(RAIZ, p));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) { assert.notEqual(rel, '', `${p} é a própria pasta do projeto`); continue; }
    dentro++;
    const r = spawnSync('git', ['check-ignore', '-q', '--no-index', path.join(rel, 'disparador.db')], { cwd: RAIZ });
    assert.equal(r.status, 0, `${p} fica dentro do projeto e não está no .gitignore`);
  }
  assert.ok(dentro >= 4, `pastas dentro do projeto conferidas: ${dentro}`);
  // e a regra não engole as pastas do projeto que começam parecido
  for (const p of ['docs', 'public/docs']) assert.notEqual(spawnSync('git', ['check-ignore', '-q', '--no-index', path.join(p, 'x.js')], { cwd: RAIZ }).status, 0, `${p} não pode ser ignorada`);
});

test('S2/D15: restaurar extrai fora do projeto, em passos numerados com um comando por bloco e o aviso de apagar a data-antiga', () => {
  const cmds = comandosDe('manutencao', 'backup');
  const restaurar = cmds.find((c) => /\brestaurar\b/.test(c));
  assert.match(restaurar, /^npm run backup -- restaurar \S+\.tar\.gz \.\.\/achadinho-restaurado$/);
  assert.match(README_BRUTO, /`npm run backup -- restaurar arquivo\.tar\.gz \.\.\/achadinho-restaurado`/);
  const ordem = ['systemctl --user stop achadinhoturbo', restaurar, 'mv data data-antiga', 'mv ../achadinho-restaurado data', 'systemctl --user start achadinhoturbo'];
  const pos = ordem.map((c) => cmds.indexOf(c));
  assert.ok(pos.every((i) => i >= 0), `faltam passos: ${ordem.filter((_, i) => pos[i] < 0)}`);
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'parar → conferir → trocar a pasta → iniciar');
  const txt = blocosDe('manutencao', 'backup').filter((b) => Object.hasOwn(b, 'p')).map((b) => b.p).join('\n');
  for (const n of [1, 2, 3, 4]) assert.match(txt, new RegExp(`\\*\\*${n}\\. `), `passo ${n} numerado`);
  assert.match(txt, /\*\*Troque pelo nome do seu arquivo\*\*/);
  assert.match(textoDe('manutencao', 'backup'), /apague a pasta data-antiga/);
});

test('Docs: um comando por bloco (nenhum bloco de comando tem mais de uma linha)', () => {
  const cmds = todosComandos();
  assert.ok(cmds.length >= 20, `comandos: ${cmds.length}`);
  for (const c of cmds) assert.doesNotMatch(c, /\n/, `bloco com mais de um comando: ${c}`);
});

test('S1: limpar o log alcança o journal e o /var/log/syslog, confere só por contagem e exige o QR novo — igual no capítulo e na pergunta', () => {
  const esperado = [
    'sudo journalctl --rotate && sudo journalctl --vacuum-time=1s',
    'sudo truncate -s 0 /var/log/syslog',
    'journalctl --user -u achadinhoturbo --no-pager | grep -c privKey',
    'sudo grep -c privKey /var/log/syslog',
    'sudo zgrep -c privKey /var/log/syslog.*',
  ];
  const cap = comandosDe('manutencao', 'log'); const perg = comandosDe('perguntas', 'limpar-log');
  assert.deepEqual(perg, cap, 'os dois lugares trazem os mesmos comandos, na mesma ordem');
  assert.deepEqual(cap.slice(0, esperado.length), esperado);
  // conferir nunca mostra as linhas: todo comando que procura privKey só conta
  for (const c of cap.filter((x) => x.includes('privKey'))) assert.match(c, /grep -c privKey/, c);
  for (const [c, s] of [['manutencao', 'log'], ['perguntas', 'limpar-log']]) {
    const txt = textoDe(c, s); const onde = `${c}/${s}`;
    assert.match(txt, /computador inteiro/, `${onde}: avisa que apaga os logs do computador inteiro`);
    assert.match(txt, /terminal comum/, `${onde}: precisa de terminal comum`);
    assert.match(txt, /senha do computador/, `${onde}: precisa da senha`);
    assert.match(txt, /deve ser 0/, `${onde}: espera 0`);
    assert.match(txt, /obrigatório/, `${onde}: QR novo obrigatório`);
    assert.match(txt, /inutiliza as antigas em qualquer cópia/, `${onde}: explica por que refazer o QR`);
    assert.match(txt, /segunda pergunta[^.]*Cancelar/, `${onde}: Cancelar na segunda pergunta do Desconectar`);
    const avisos = blocosDe(c, s).filter((b) => b.nota === 'aviso');
    const iAviso = blocosDe(c, s).indexOf(avisos[0]); const iSudo = blocosDe(c, s).findIndex((b) => /^sudo /.test(b.comando ?? ''));
    assert.ok(avisos.length && iAviso < iSudo, `${onde}: o aviso vem antes do primeiro sudo`);
  }
});

test('R4: o "Desconectar" pergunta de novo e quem continua com o mesmo número clica em Cancelar', () => {
  const app = fonte('app.js');
  assert.ok(app.includes("confirm('Apagar também o histórico"), 'a segunda pergunta existe em public/app.js');
  assert.match(textoDe('manutencao', 'reconectar'), /Apagar também o histórico…\?[^.]*clique em Cancelar/);
  const dica = blocosDe('manutencao', 'reconectar').find((b) => b.nota === 'dica').texto;
  assert.match(limpo(dica), /segunda pergunta \(“Apagar também o histórico…\?”\), clique em Cancelar/);
});

test('S3: o token da extensão não está entre os segredos que não voltam à tela; remover alguém pede um token novo', () => {
  const frases = blocosDe('privacidade', 'segredos').filter((b) => Object.hasOwn(b, 'p')).map((b) => limpo(b.p));
  for (const f of frases.filter((x) => /não voltam|Só o Dono vê/.test(x))) assert.doesNotMatch(f, /token da extensão/, f);
  assert.match(textoDe('privacidade', 'segredos'), /token da extensão[^.]*para o Dono e para o Operador/);
  assert.match(textoDe('equipe', 'gerir'), /Se a pessoa removida viu essa tela, clique em “Gerar novo token”[^.]*cole o novo na extensão/);
  // o painel mostra mesmo o token a quem não é Dono (o texto acima precisa continuar verdadeiro)
  assert.match(fonte('conexoes.js'), /id="c2"[^>]*|value="\$\{esc\(S\.st\.ext_token\)\}"/);
});

test('R1: simular usa uma pasta separada, sem "pare o serviço antes", com PORT=3799 se a 3737 estiver ocupada (Docs e README)', () => {
  const pasta = path.basename(pastaDeDados({ env: {}, argv: ['--simular'], raiz: RAIZ }));
  const lugares = { README, 'manutencao/painel': textoDe('manutencao', 'painel'), 'perguntas/painel-local': textoDe('perguntas', 'painel-local'), 'primeiros-passos/teste': textoDe('primeiros-passos', 'teste') };
  for (const [onde, txt] of Object.entries(lugares)) {
    assert.match(txt, /npm run simular/, onde);
    assert.ok(txt.includes(pasta), `${onde}: cita a pasta ${pasta}`);
    assert.match(txt, /PORT=3799 npm run simular/, onde);
    assert.match(txt, /não mexe nos seus dados/, onde);
    assert.doesNotMatch(txt, /pare-o antes|pare o serviço antes|se o painel já estiver ligado, pare/i, onde);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Grade de horários e Grupo vivo (plano grade-de-disparos, etapa 9, CA14): verbetes, seções dos capítulos, glossário,
// limites e README. As frases do Histórico citadas nos Docs têm de ser as do código (src/scheduler.js, src/rotinas.js,
// src/server.js): o texto da documentação é conferido contra elas.
// ---------------------------------------------------------------------------------------------------------------
const TIPS_GRADE = ['regras.modo_grade', 'regras.grade_horarios', 'regras.grade_modelos', 'grupovivo', 'grupovivo.rodizio'];
const JARGAO = /\b(json|payload|endpoint|cron|slot|tick|sqlite|jid|baileys|api)\b/i;
const secaoTxt = (cap, id) => { const s = CAPS[cap].secoes.find((x) => x.id === id); assert.ok(s, `${cap}/${id} não existe`); return limpo(strings(s.blocos).join('\n')); };
/** Parte do README de um título `## …` até o próximo `## `. */
const readmeSecao = (titulo) => {
  const i = README_BRUTO.search(new RegExp(`^## ${titulo}`, 'm')); assert.ok(i >= 0, `README sem a seção "${titulo}"`);
  const resto = README_BRUTO.slice(i + 3); const fim = resto.search(/^## /m);
  return limpo(resto.slice(0, fim < 0 ? undefined : fim));
};
/** O motivo do horário pulado, como está no código (uma só fonte para o Histórico da grade e a frase dos Docs). */
const motivoPulado = () => /const MOTIVO_PULADO = '([^']+)';/.exec(lerRaiz('src/scheduler.js'))[1];
/** Vários horários pulados, como o código escreve: o agendador (o 1º de outro dia leva a data) e as rotinas. */
const PULADOS_GRADE_DIAS = new RegExp(`\\d+ horários pulados \\(\\d\\d:\\d\\d de \\d\\d/\\d\\d a \\d\\d:\\d\\d\\): ${escRe(motivoPulado())}`);
const PULADOS_ROTINA = new RegExp(`\\d+ horários pulados, o último de \\d\\d/\\d\\d \\d\\d:\\d\\d: ${escRe(motivoPulado())}`);

test('Grade e Grupo vivo: nenhuma frase de horário pulado que o código não escreve ("Vários horários pulados desde…")', () => {
  for (const [onde, txt] of [['README', README], ['Docs', TEXTO_DOCS]]) {
    assert.doesNotMatch(txt, /Vários horários pulados|horários pulados desde|primeiro horário perdido/, onde);
  }
  for (const arq of ['src/scheduler.js', 'src/rotinas.js']) assert.doesNotMatch(lerRaiz(arq), /Vários horários|pulados desde/, arq);
});

test('Grade e Grupo vivo: os cinco verbetes de TIPS existem, em linguagem simples, com os números certos', () => {
  const T = tipsDoPainel();
  for (const k of TIPS_GRADE) {
    assert.ok(typeof T[k] === 'string' && T[k].length >= 60 && T[k].length <= 520, `TIPS.${k}: ${T[k]?.length}`);
    assert.doesNotMatch(T[k], JARGAO, `TIPS.${k}: jargão`);
  }
  const m = T['regras.modo_grade'];
  assert.match(m, /A cada X minutos/); assert.match(m, /Em horários marcados/); assert.match(m, /Funciona das\/até/); assert.match(m, /não vale/);
  const h = T['regras.grade_horarios'];
  assert.match(h, /\b48 horários/); assert.match(h, /1 a 20 ofertas/); assert.match(h, /10 min/); assert.match(h, /30 min/); assert.match(h, /Histórico/);
  const mo = T['regras.grade_modelos'];
  assert.match(mo, /Montar…/); assert.match(mo, /Substituir horários/); assert.match(mo, /Acrescentar/); assert.match(mo, /horário final/);
  const g = T['grupovivo'];
  assert.match(g, /até 5 textos ou enquetes/); assert.match(g, /até 6 horários/); assert.match(g, /sem foto/i); assert.match(g, /Grupo vivo: /); assert.match(g, /ofertas/);
  const r = T['grupovivo.rodizio'];
  assert.match(r, /Um depois do outro/); assert.match(r, /Sorteio/); assert.match(r, /sem repetir o último/); assert.match(r, /Enviar agora/);
});

test('Grade e Grupo vivo: cada verbete leva ao "Ler mais" da seção certa, e a seção existe', () => {
  const noop = () => {};
  const ctx = vm.createContext({ document: { addEventListener: noop, getElementById: () => null }, addEventListener: noop, innerWidth: 1280, innerHeight: 800 });
  vm.runInContext(fonte('ajuda.js'), ctx, { filename: 'public/ajuda.js' });
  const LEIA = JSON.parse(vm.runInContext('JSON.stringify(LEIA_MAIS)', ctx));
  const esperado = { 'regras.modo_grade': 'disparo-automatico/horarios-marcados', 'regras.grade_horarios': 'disparo-automatico/horarios-marcados',
    'regras.grade_modelos': 'disparo-automatico/horarios-marcados', grupovivo: 'mensagens/grupo-vivo', 'grupovivo.rodizio': 'mensagens/grupo-vivo' };
  for (const [k, destino] of Object.entries(esperado)) {
    assert.equal(LEIA[k], destino, k);
    const [cap, sec] = destino.split('/'); assert.ok(CAPS[cap].secoes.some((s) => s.id === sec), `${destino} não existe`);
  }
});

test('Grade: a seção "horarios-marcados" do Disparo automático cobre o formulário, os limites e a conversão do ritmo atual', () => {
  const sec = CAPS['disparo-automatico'].secoes.find((s) => s.id === 'horarios-marcados');
  assert.ok(sec, 'seção horarios-marcados em disparo-automatico');
  assert.match(sec.onde, /Ritmo de envio → Em horários marcados/);
  const ids = CAPS['disparo-automatico'].secoes.map((s) => s.id);
  assert.ok(ids.indexOf('horarios-marcados') === ids.indexOf('ritmo') + 1, 'logo depois de "Ritmo e horário"');
  assert.ok(ids.indexOf('na-hora-marcada') === ids.indexOf('horarios-marcados') + 1, '"O que acontece na hora marcada" logo depois');
  const txt = secaoTxt('disparo-automatico', 'horarios-marcados');
  // o formulário, com os rótulos de public/grade.js
  for (const r of [/Como enviar/, /A cada X minutos/, /Em horários marcados/, /Em quais dias/, /Modelos rápidos/, /Montar…/, /Substituir horários/, /Acrescentar/, /\+ Adicionar horário/, /Padrão do disparo/, /Horário/, /Ofertas/, /Template/, /Salvar/]) assert.match(txt, r);
  for (const r of [/A cada 30 min, 8h às 22h/, /A cada hora, 8h às 22h/, /Manhã, tarde e noite/, /Horários de pico/]) assert.match(txt, r);
  // limites (os da virada do dia valem: 23:55 e 00:00 são recusados)
  for (const r of [/até 48 horários/, /pelo menos 10 min entre/, /de 1 a 20 ofertas por horário/]) assert.match(txt, r);
  assert.match(txt, /sem horário repetido/i); assert.match(txt, /23:55 e 00:00 não cabem juntos/);
  // continua opcional e o padrão é o intervalo; a janela não vale
  assert.match(txt, /padrão continua sendo “A cada X minutos”/); assert.match(txt, /opcional/);
  assert.match(txt, /“Funciona das\/até” não vale/); assert.match(txt, /ficam guardados/);
  // conversão do ritmo atual: o horário final não entra; os modelos incluem o final
  assert.match(txt, /“a cada 60 min, das 8h às 22h” vira 14 horários, das 08:00 às 21:00/);
  assert.match(txt, /horário final não entra/); assert.match(txt, /modelos rápidos e o “Montar…” incluem o horário final/);
  assert.match(txt, /15 horários/);
  assert.match(txt, /O cartão/); assert.match(txt, /selo “Grade”/);
  // o resto mora na outra seção e a primeira leva até ela
  assert.match(txt, /#docs\/disparo-automatico\/na-hora-marcada/);
  assert.doesNotMatch(txt, /sai só o mais recente|atrasou até 30 min|mais de 400 mensagens/);
});

test('Grade: a seção "na-hora-marcada" cobre o que sai, o horário perdido, Enviar agora, o template em uso e o aviso de volume', () => {
  const sec = CAPS['disparo-automatico'].secoes.find((s) => s.id === 'na-hora-marcada');
  assert.ok(sec, 'seção na-hora-marcada em disparo-automatico'); assert.match(sec.titulo, /O que acontece na hora marcada/);
  const txt = secaoTxt('disparo-automatico', 'na-hora-marcada');
  assert.match(txt, /atrasou até 30 min/);
  // o que sai, e quando faltam ofertas
  assert.match(txt, /sem acumular/); assert.match(txt, /Sem ofertas novas dentro dos filtros desta vez/);
  // horário perdido
  assert.match(txt, /sai só o mais recente/); assert.match(txt, /pulado/); assert.match(txt, PULADOS_GRADE_DIAS);
  // Enviar agora e Ver ofertas
  assert.match(txt, /“Enviar agora”[^.]*não pula esse horário/); assert.match(txt, /“Ver ofertas”/); assert.match(txt, /quantidade e o template do próximo horário/);
  // template em uso: a frase do servidor, em bloco próprio (destacada), e a explicação em palavras do dono
  assert.ok(sec.blocos.some((b) => typeof b.exemplo === 'string' && /^A regra "[^"]+" usa este template no horário \d\d:\d\d\.$/.test(b.exemplo)), 'frase do template em uso em destaque');
  assert.match(txt, /qual disparo e qual horário o usam/);
  // aviso de volume: só aviso
  assert.match(txt, /mais de 400 mensagens por dia/); assert.match(txt, /nunca bloqueia|nada é bloqueado/);
  assert.match(txt, /Grupo vivo/);
});

test('Grade: as duas seções têm o tamanho das outras (no máximo 8 blocos) e dizem "disparo", não "regra" (fora das frases do servidor)', () => {
  for (const id of ['horarios-marcados', 'na-hora-marcada']) {
    const sec = CAPS['disparo-automatico'].secoes.find((s) => s.id === id);
    assert.ok(sec.blocos.length <= 8, `${id}: ${sec.blocos.length} blocos`);
    const sobra = secaoTxt('disparo-automatico', id)
      .replace(/template da regra/g, '').replace(/A regra "[^"]+" usa/g, '').replace(/“da regra”/g, '').replace(/escreve “regra”/g, '');
    assert.doesNotMatch(sobra, /\bregra\b/i, `${id}: "regra" fora das frases do programa`);
  }
  assert.doesNotMatch(tipsDoPainel()['regras.grade_horarios'], /\bregra\b/i);
});

test('Grade: as frases do Histórico citadas nos Docs e no README são as que o código escreve', () => {
  const sched = lerRaiz('src/scheduler.js'); const server = lerRaiz('src/server.js');
  const motivo = motivoPulado();
  const docs = secaoTxt('disparo-automatico', 'na-hora-marcada'); const readme = readmeSecao('Horários marcados e Grupo vivo');
  for (const [onde, txt] of [['Docs', docs], ['README', readme]]) {
    assert.ok(txt.includes(`Horário 10:00 pulado: ${motivo}`), `${onde}: frase do horário pulado`);
    assert.match(txt, new RegExp(`\\d+ horários pulados \\(\\d\\d:\\d\\d a \\d\\d:\\d\\d\\): ${escRe(motivo)}`), `${onde}: vários pulados`);
    assert.match(txt, new RegExp(`\\d+ horários pulados \\(\\d\\d:\\d\\d de \\d\\d/\\d\\d a \\d\\d:\\d\\d\\): ${escRe(motivo)}`), `${onde}: vários pulados desde outro dia`);
    assert.match(txt, /Horário 10:00: saíram 5 de 8 ofertas; não havia mais ofertas novas dentro dos filtros\./, `${onde}: saíram N de M`);
    assert.match(txt, /Horário 10:00: o template escolhido para este horário não existe mais\. As ofertas saíram com o template da regra\./, `${onde}: template apagado`);
    assert.match(txt, /A regra "[^"]+" usa este template no horário \d\d:\d\d\./, `${onde}: template em uso`);
  }
  // e o código ainda escreve exatamente isso
  assert.ok(sched.includes('Horário ${quandoDe(pulados[0], agora)} pulado')); assert.ok(sched.includes('${pulados.length} horários pulados ('));
  assert.ok(sched.includes('${quandoDe(pulados[0], agora)} a ${quandoDe(pulados.at(-1), agora)})')); assert.ok(sched.includes('return `${horaDe(ts)} de ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;'), 'outro dia: "10:00 de 03/11"');
  assert.ok(sched.includes('aíram ${summary.offers} de ${want} ofertas; não havia mais ofertas novas dentro dos filtros.'));
  assert.ok(sched.includes('o template escolhido para este horário não existe mais. As ofertas saíram com o template da regra.'));
  assert.ok(server.includes('A regra "${naGrade.regra}" usa este template no horário ${naGrade.hora}.'));
});

test('Grupo vivo: a seção "grupo-vivo" do capítulo de mensagens cobre rotinas, galeria, rodízio, Enviar agora, horário perdido e Histórico', () => {
  const sec = CAPS.mensagens.secoes.find((s) => s.id === 'grupo-vivo');
  assert.ok(sec, 'seção grupo-vivo em mensagens'); assert.match(sec.onde, /Grupo vivo/);
  const txt = secaoTxt('mensagens', 'grupo-vivo');
  for (const r of [/Nova mensagem/, /Nova enquete/, /Modelos/, /Usar este modelo/, /Criar rotina/, /Nome/, /Ordem/, /Um depois do outro/, /Sorteio/, /Dias da semana/, /Horários/, /Enviar agora/, /Editar/, /Copiar/, /Excluir/]) assert.match(txt, r);
  for (const r of [/até 5 textos ou enquetes/, /até 6 horários por rotina/, /mais de 400 mensagens por dia/, /atrasou até 30 min/]) assert.match(txt, r);
  assert.match(txt, /Sem foto por enquanto\./); assert.doesNotMatch(txt, /7 dias|metadados|EXIF/i, 'sem a explicação das fotos');
  assert.match(txt, /até 50 rotinas/); assert.match(txt, /“Enviar agora” a cada 1 min/);
  assert.match(txt, PULADOS_ROTINA); assert.match(txt, /#docs\/disparo-automatico\/na-hora-marcada/);
  assert.match(txt, /sem repetir o último/); assert.match(txt, /10 modelos/);
  assert.match(txt, /só preenche o formulário|só preenchem o formulário/); assert.match(txt, /nada é salvo até/);
  assert.match(txt, /“Enviar agora”[^.]*avança o rodízio[^.]*não muda o próximo horário/);
  assert.match(txt, /Grupo vivo: Bom dia/); assert.match(txt, /sai só o mais recente/);
  assert.match(txt, /Disparar mensagem[^.]*envios pontuais|envios pontuais[^.]*Disparar mensagem/);
  assert.match(txt, /nunca bloqueia|nada é bloqueado/);
  // a frase de horário perdido do Grupo vivo é a de src/rotinas.js
  const rot = lerRaiz('src/rotinas.js');
  assert.ok(rot.includes('Horário de ${hora(ultimo)} pulado')); assert.ok(rot.includes('${pulados.length} horários pulados, o último de ${hora(ultimo)}'));
  assert.ok(rot.includes("const PERDIDO = '" + motivoPulado() + "'"), 'o motivo é o mesmo da grade');
  assert.match(txt, new RegExp(`Horário de \\d\\d/\\d\\d \\d\\d:\\d\\d pulado: ${escRe(motivoPulado())}`));
  // os dez modelos da galeria: os nomes citados existem em public/grupovivo.js
  const gv = fonte('grupovivo.js');
  for (const nome of ['Bom dia', 'Regras do grupo', 'Aviso de segurança', 'Prova social (convite)', 'Preço muda', 'Boa noite', 'Enquete: o que ver mais', 'Enquete: já comprou', 'Enquete: melhor horário', 'Enquete: sextou']) assert.ok(gv.includes(`titulo: '${nome}'`), `modelo ${nome}`);
  assert.equal([...gv.matchAll(/^  \{ id: '[a-z-]+', titulo: /gm)].length, 10);
});

test('Grade e Grupo vivo: glossário, tabela de limites, Histórico e ritmo apontam para as seções novas', () => {
  const g = CAPS.referencia.secoes.find((s) => s.id === 'glossario').blocos.filter((b) => b.termos).flatMap((b) => b.termos);
  for (const t of ['Horários marcados', 'Grupo vivo', 'Rotina']) assert.equal(g.filter(([x]) => x === t).length, 1, `glossário: ${t}`);
  assert.match(g.find(([x]) => x === 'Horários marcados')[1], /Disparo automático/); assert.match(g.find(([x]) => x === 'Grupo vivo')[1], /mensagens e enquetes/);
  const col = primeiraColuna('referencia', 'limites');
  assert.ok(col.some((x) => /^Horários marcados/.test(x)) && col.some((x) => /^Grupo vivo/.test(x)), 'limites: as duas linhas novas');
  const lim = textoDe('referencia', 'limites');
  for (const r of [/até 48 horários/, /pelo menos 10 min entre/, /de 1 a 20 ofertas por horário/, /atrasou até 30 min/, /até 5 textos ou enquetes/, /até 6 horários por rotina/, /até 50 rotinas/, /“Enviar agora” por minuto/, /mais de 400 mensagens por dia/]) assert.match(lim, r);
  const hist = textoDe('resultados', 'historico');
  assert.match(hist, /Grupo vivo: nome da rotina/); assert.match(hist, /só em “Tudo”|aparece em “Tudo”/); assert.match(hist, /Horário 10:00 pulado/); assert.match(hist, /Horário de 05\/11 10:00 pulado/); assert.match(hist, /\d+ horários pulados \(\d\d:\d\d de \d\d\/\d\d a \d\d:\d\d\): …/); assert.match(hist, /\d+ horários pulados, o último de \d\d\/\d\d \d\d:\d\d: …/); assert.match(hist, /#docs\/disparo-automatico\/na-hora-marcada/);
  assert.match(textoDe('disparo-automatico', 'ritmo'), /Em horários marcados[^.]*#docs\/disparo-automatico\/horarios-marcados|horários marcados\]\(#docs\/disparo-automatico\/horarios-marcados\)/i);
  assert.match(strings(CAPS['disparo-automatico'].aprenda).join(' '), /horários marcados/i);
  assert.match(strings(CAPS.mensagens.aprenda).join(' '), /Grupo vivo/);
});

test('Grade e Grupo vivo: o README tem a linha de resumo, o menu, a seção, os limites e a prova de que é só aviso', () => {
  const linhas = README_BRUTO.split('\n');
  assert.match(linhas[6], /^Você configura:/); assert.match(limpo(linhas[6]), /horários marcados/); assert.match(limpo(linhas[6]), /Grupo vivo/);
  assert.match(limpo(README_BRUTO.slice(README_BRUTO.search(/^## Menu do painel/m), README_BRUTO.search(/^### Docs do painel/m))), /Disparar mensagem, Grupo vivo, Templates/);
  const txt = readmeSecao('Horários marcados e Grupo vivo');
  for (const r of [/Em horários marcados/, /A cada X minutos/, /Modelos rápidos/, /Montar…/, /Grupo vivo/, /Nova mensagem/, /Nova enquete/, /Um depois do outro/, /Sorteio/, /Criar rotina/, /Enviar agora/, /sem foto/i, /10 modelos/]) assert.match(txt, r);
  for (const r of [/até 48 horários/, /pelo menos 10 min entre/, /de 1 a 20 ofertas por horário/, /atrasou até 30 min/, /até 5 textos ou enquetes/, /até 6 horários por rotina/, /até 50 rotinas/, /mais de 400 mensagens por dia/]) assert.match(txt, r);
  assert.match(txt, /23:55 e 00:00 não cabem juntos/); assert.match(txt, /Próximo: 13:00\./); assert.doesNotMatch(txt, /Padrão da regra/);
  assert.match(txt, /só vale um a cada 1 min/);
  assert.match(txt, /se atualiza sozinha a cada 10 s/); assert.match(txt, /Somando os outros disparos e rotinas ligados, este número…/);
  const sem = txt.replace(/[*"“”]/g, ''); // o README usa aspas retas e itálico onde os Docs usam aspas curvas
  assert.match(sem, /a cada 60 min, das 8h às 22h vira 14 horários, das 08:00 às 21:00/); assert.match(txt, /horário final não entra/);
  const [daGrade, doGrupoVivo] = txt.split('### Grupo vivo'); // a regra do horário perdido é dita nas duas partes
  assert.match(daGrade, PULADOS_GRADE_DIAS); assert.match(doGrupoVivo, PULADOS_ROTINA);
  assert.match(daGrade, /sai só o mais recente/); assert.match(doGrupoVivo, /sai só o mais recente/); assert.match(sem, /Enviar agora[^.]*não pula esse horário/); assert.match(sem, /Enviar agora[^.]*avança o rodízio[^.]*não muda o próximo horário/);
  assert.match(txt, /nunca bloqueia/); assert.match(txt, /não foi testado contra o WhatsApp real|não testado contra o WhatsApp real/i);
  assert.match(txt, /A regra "[^"]+" usa este template no horário/);
  assert.match(txt, /Grupo vivo: nome da rotina/);
});
