// Painel de Ganhos e rastreio, Entrega A (plano dashboard-ganhos, etapa 9; spec docs/produto/specs/dashboard-ganhos.md):
// página #ganhos (cobertura do rastreio, M9/M10), fieldset "Códigos de rastreio" no formulário do Bloco, coluna Rastreio e
// diálogo de exceção em Grupos, item de menu só do Dono (decisão P2 do dono). ajuda.js, espelhamento.js, ganhos.js, app.js e
// paineis.js rodam juntos num `vm` com DOM falso e um fetch falso por rota: nenhuma rede, nenhum servidor, sem localStorage
// (o painel não pode depender dele). Foco em CA3/CA4 (associar), CA6 (cobertura visível), CA9 (sem configurar, nada muda),
// CA11 (só o Dono) e em P6 (Shopee só por bloco).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fonte = (arq) => fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');
const json = (x) => JSON.parse(JSON.stringify(x));
const ate = async (cond, n = 80) => { for (let i = 0; i < n && !cond(); i++) await new Promise((r) => setImmediate(r)); return cond(); };

const XSS = '<img src=x onerror=alert(1)>"\'&';
const XSS_ESC = '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;';
const semMarcacao = (html, onde) => assert.ok(!/<img|<script|onerror=alert\(1\)>/i.test(html.replaceAll(XSS_ESC, '')), `${onde}: texto cru virou marcação\n${html}`);

/**
 * Painel com DOM falso. `rotas`: 'METODO /api/caminho' → ({ corpo, consulta }) → [status, json]. `menu` guarda os itens do
 * menu (href → elemento): o Dono recebe o "Ganhos" por insertAdjacentHTML em #ng-principal, o Operador não.
 * `listas`: seletor → elementos devolvidos por querySelectorAll (ex.: os grupos marcados do bloco).
 */
function tela({ hash = '#ganhos' } = {}) {
  const reg = new Map(); const pedidos = []; const rotas = {}; const menu = new Map(); const listas = {}; const foco = []; const inseridos = [];
  const novo = (sel) => {
    const e = {
      sel, textContent: '', value: '', hidden: false, disabled: false, checked: false, open: false, className: '', dataset: {}, style: {}, attrs: {}, classes: new Set(),
      classList: { add(c) { e.classes.add(c); }, remove(c) { e.classes.delete(c); }, toggle(c, f) { if (f ?? !e.classes.has(c)) e.classes.add(c); else e.classes.delete(c); }, contains: (c) => e.classes.has(c) },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; },
      querySelector: (s) => consultar(s), querySelectorAll: (s) => listas[s] ?? [], addEventListener() {}, appendChild() {}, insertAdjacentHTML() {}, remove() {},
      focus() { foco.push(sel); }, scrollIntoView() {}, closest: () => null, showModal() { this.open = true; }, close() { this.open = false; }, _html: '',
    };
    // trocar o HTML do dialog recria os elementos de dentro dele (como o navegador)
    Object.defineProperty(e, 'innerHTML', {
      get() { return this._html; },
      set(v) { this._html = String(v); if (sel === '#dlg') for (const k of [...reg.keys()]) if (!['#dlg', '#pagina', '#toast', '#ng-principal', '#ng-conta'].includes(k)) reg.delete(k); },
    });
    return e;
  };
  const el = (s) => { if (!reg.has(s)) reg.set(s, novo(s)); return reg.get(s); };
  const registrar = (pos, html) => {
    inseridos.push({ pos, html });
    for (const m of html.matchAll(/<a href="(#[^"]+)">([^<]+)<\/a>/g)) { const a = novo('a'); a.textContent = m[2]; a.remove = () => menu.delete(m[1]); menu.set(m[1], a); }
  };
  function consultar(s) { const m = /^#rail nav a\[href="(#[a-z-]+)"\]$/.exec(s); return m ? menu.get(m[1]) ?? null : el(s); }
  el('#ng-principal').insertAdjacentHTML = registrar;
  el('#ng-conta').parentElement = { insertAdjacentHTML: registrar };
  const ctx = {
    console, URLSearchParams,
    document: { querySelector: consultar, querySelectorAll: () => [], addEventListener() {}, getElementById: () => null, createElement: () => novo('criado'), activeElement: null, body: {} },
    location: { hash, replace() {} },
    history: { replaceState(_a, _b, h) { ctx.location.hash = h; } },
    addEventListener() {}, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    confirm: () => true, innerWidth: 1024, innerHeight: 768,
    __campos: {},
    FormData: class { get(k) { return Object.hasOwn(ctx.__campos, k) ? ctx.__campos[k] : null; } },
    // a carga inicial do app.js (carregar: /state, /tags…) fica sem resposta: nem tela inicial nem toast de erro no meio do teste
    __fetch: () => new Promise(() => {}),
    // dispApi/dispSegHtml de disparos.js: o espelhamento.js só os usa dentro de funções que estes testes não chamam
    dispSegHtml: () => '', dispLigarSeg() {}, dispBrl: (n) => String(n),
  };
  ctx.fetch = (url, opts) => ctx.__fetch(url, opts);
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const arq of ['ajuda.js', 'espelhamento.js', 'ganhos.js', 'app.js', 'paineis.js']) vm.runInContext(fonte(arq), ctx, { filename: `public/${arq}` });
  // daqui em diante o fetch responde pelas rotas do teste
  ctx.__fetch = async (url, opts = {}) => {
    const metodo = opts.method || 'GET'; const [caminho, consulta = ''] = String(url).split('?');
    // importar comissões manda o arquivo cru (File) com content-type text/csv; o resto é JSON
    const tipo = opts.headers?.['content-type'] ?? null; const csv = /^text\/csv/.test(tipo || '');
    const corpo = opts.body ? (csv ? opts.body : JSON.parse(opts.body)) : null;
    pedidos.push({ metodo, caminho, consulta, corpo, tipo });
    const fn = rotas[`${metodo} ${caminho}`];
    const [status, jsonResp] = fn ? await fn({ corpo, consulta, tipo }) : [404, { erro: 'rota não prevista no teste' }];
    return { status, ok: status < 400, json: async () => jsonResp };
  };
  const rodar = (c) => vm.runInContext(c, ctx);
  const item = (href, texto) => { const a = novo('a'); a.textContent = texto; a.remove = () => menu.delete(href); menu.set(href, a); return a; };
  return { ctx, el, reg, pedidos, rotas, rodar, menu, listas, foco, inseridos, item };
}

const dono = { id: 1, papel: 'dono', nome: 'Pedro', email: 'p@x' };
const operador = { id: 2, papel: 'operador', nome: 'Ana', email: 'a@x' };
const estado = (usuario = dono) => ({ usuario, auth: true, whatsapp: { status: 'open' }, extensao: { online: true }, ajustes: { link_mode: 'extension' }, catalogo: { estado: 'conectada', para_revisar: 0, regras: [] } });

const TAGS = [{ id: 7, name: 'achados' }, { id: 8, name: 'casa' }];
const GRUPOS = [
  { jid: 'a@g.us', name: 'Achados', size: 10, blocks: [1], is_admin: true },
  { jid: 'b@g.us', name: 'Casa', size: 20, blocks: [1, 2], is_admin: false },
  { jid: 'c@g.us', name: 'Solto', size: 5, blocks: [], is_admin: false },
];
const bloco = (id, name, tag_id, jids) => ({ id, name, tag_id, note: '', group_jids: jids, grupos: jids.map((j) => ({ jid: j, name: j })), membros: 0, hoje: { entradas: 0, abriram: 0 } });
const BLOCOS = [bloco(1, 'Casa e cozinha', 7, ['a@g.us', 'b@g.us']), bloco(2, 'Beleza', null, ['b@g.us'])];
const cod = (loja, alvo_tipo, alvo, codigo) => ({ id: 1, loja, alvo_tipo, alvo: String(alvo), codigo, criado_em: 1, atualizado_em: 1 });

/** Põe o estado do painel: papel, grupos, blocos, etiquetas e (se `codigos`) as associações já carregadas. */
function preparar(t, { usuario = dono, st = estado(usuario), codigos = null } = {}) {
  t.ctx.__st = st; t.ctx.__tags = TAGS; t.ctx.__grupos = GRUPOS; t.ctx.__blocos = BLOCOS;
  t.rodar('S.st = __st; S.tags = __tags; S.groups = __grupos; S.blocks = __blocos; S.rules = []; S.templates = [];');
  if (codigos) { t.ctx.__cods = codigos; t.rodar('RASTREIO.codigos = __cods; RASTREIO.carregado = true;'); }
}

// Cenário C1 do plano (catálogo de métricas): M9 total 11/12, Shopee 87,5%, Amazon 100%, ML sem envio esperado (null); M10 12/16.
const contas = (envios, esperados, rastreados) => ({ envios, esperados, rastreados, cobertura: esperados ? rastreados / esperados : null, alcance: envios ? esperados / envios : null });
const COB = () => ({
  de: new Date(2026, 9, 1).getTime(), ate: new Date(2026, 9, 31, 23, 59).getTime(),
  total: contas(16, 12, 11),
  por_loja: [{ loja: 'mercadolivre', ...contas(2, 0, 0) }, { loja: 'amazon', ...contas(6, 4, 4) }, { loja: 'shopee', ...contas(8, 8, 7) }],
  por_grupo: [{ jid: 'a@g.us', ...contas(6, 6, 6) }, { jid: 'c@g.us', ...contas(4, 0, 0) }, { jid: 'b@g.us', ...contas(6, 6, 5) }],
});
// ---- Entrega B: respostas de GET /api/ganhos (src/ganhos.js metricas), cenário C1 do plano. Dinheiro em centavos; epc e custo_membro em centavos.
const linhaDin = (o = {}) => ({ comissao: 0, comissao_confirmada: 0, receita: 0, vendas: 0, cliques: 0, epc: null, conversao: null, envios: 0, esperados: 0, rastreados: 0, cobertura: null, alcance: null, gasto: null, entradas: 0, custo_membro: null, retorno: null, ...o });
const TOTAL_ZERO = linhaDin({ atribuida: null, comissao_atribuida: 0 });
const TOTAL_C1 = linhaDin({ comissao: 2100, comissao_confirmada: 1300, receita: 41000, vendas: 7, cliques: 250, epc: 6, conversao: 0.02, envios: 16, esperados: 12, rastreados: 11, cobertura: 11 / 12, alcance: 0.75,
  comissao_atribuida: 1000, atribuida: 1000 / 2100, gasto: 4300, entradas: 31, custo_membro: 4300 / 31, retorno: 2100 - 4300 });
const LINHAS_GRUPO = () => [
  { jid: 'a@g.us', nome: 'Achados', blocos: [{ id: 1, nome: 'Casa e cozinha' }], ...linhaDin({ comissao: 500, comissao_confirmada: 300, receita: 9000, vendas: 2, cliques: 100, epc: 5, conversao: 0.02, envios: 6, esperados: 6, rastreados: 6, cobertura: 1, alcance: 1, entradas: 10 }) },
  { jid: 'b@g.us', nome: 'Casa', blocos: [{ id: 1, nome: 'Casa e cozinha' }, { id: 2, nome: 'Beleza' }], ...linhaDin({ comissao: 100, comissao_confirmada: 100, receita: 2000, vendas: 1, cliques: 50, epc: 2, conversao: 0.02, envios: 6, esperados: 6, rastreados: 5, cobertura: 5 / 6, alcance: 1, entradas: 15 }) },
  { jid: 'c@g.us', nome: 'Solto', blocos: [], ...linhaDin({ envios: 4, entradas: 6, gasto: 1200, custo_membro: 200, retorno: -1200 }) },
];
const DIN_VAZIO = () => ({ de: 1, ate: 2, dia_de: '2026-10-01', dia_ate: '2026-10-31', por: 'grupo', loja: null, bloco: null, total: TOTAL_ZERO, nao_atribuida: { linhas: 0, comissao: 0, receita: 0, vendas: 0, cliques: 0 },
  cobertura: { total: {}, por_loja: [] }, linhas: [], importado_ate: {}, gastos_informados: 0 });
const DIN_C1 = (por) => ({ ...DIN_VAZIO(), por, total: TOTAL_C1, nao_atribuida: { linhas: 3, comissao: 1100, receita: 30000, vendas: 4, cliques: 60 }, importado_ate: { shopee: '2026-10-07', amazon: '2026-10-10', mercadolivre: '2026-10-11' }, gastos_informados: 2,
  linhas: {
    grupo: LINHAS_GRUPO(),
    bloco: [{ bloco_id: 1, nome: 'Casa e cozinha', grupos: 2, ...linhaDin({ comissao: 1000, comissao_confirmada: 600, receita: 11000, vendas: 5, cliques: 190, epc: 5.263, conversao: 0.0263, envios: 12, entradas: 25, gasto: 3100, custo_membro: 124, retorno: -2100 }) },
      { bloco_id: 2, nome: 'Beleza', grupos: 1, ...linhaDin({ envios: 6, entradas: 15 }) }],
    loja: [{ loja: 'mercadolivre', ...linhaDin({ comissao: 600, vendas: 1, receita: 12000, envios: 2 }), comissao_atribuida: 0, atribuida: 0 },
      { loja: 'amazon', ...linhaDin({ comissao: 900, vendas: 3, receita: 18000, cliques: 100, epc: 9, conversao: 0.03, envios: 6, esperados: 4, rastreados: 4, cobertura: 1, alcance: 0.6667 }), comissao_atribuida: 400, atribuida: 400 / 900 },
      { loja: 'shopee', ...linhaDin({ comissao: 600, vendas: 2, receita: 9000, cliques: 150, epc: 4, conversao: 0.0133, envios: 8, esperados: 8, rastreados: 7, cobertura: 0.875, alcance: 1 }), comissao_atribuida: 600, atribuida: 1 }],
    oferta: [{ loja: 'shopee', oferta: 'SHOPEE:1.2', titulo: 'Panela de pressão elétrica 6 litros', comissao: 500, comissao_confirmada: 300, receita: 9000, vendas: 2, envios: 4, grupos: 2 },
      { loja: 'amazon', oferta: 'B0ABC12345', titulo: null, comissao: 400, comissao_confirmada: 400, receita: 10000, vendas: 2, envios: 2, grupos: 1 }],
    dia: [{ dia: '2026-10-05', comissao: 300, comissao_confirmada: 300, receita: 5000, vendas: 1, cliques: 0, envios: 4, esperados: 4, rastreados: 4, cobertura: 1, alcance: 1 },
      { dia: '2026-10-06', comissao: 0, comissao_confirmada: 0, receita: 0, vendas: 0, cliques: 0, envios: 0, esperados: 0, rastreados: 0, cobertura: null, alcance: null }],
  }[por] });
const IMPORTACOES = () => [
  { id: 12, loja: 'shopee', tipo: 'comissoes', codigo_arquivo: null, lidas: 312, novas: 287, atualizadas: 0, ignoradas: 5, criado_em: new Date(2026, 10, 3, 14, 30).getTime(), repetidas: 20, linhas: 287 },
  { id: 11, loja: 'amazon', tipo: 'cliques', codigo_arquivo: 'casa-20', lidas: 30, novas: 28, atualizadas: 2, ignoradas: 0, criado_em: new Date(2026, 10, 1, 9, 0).getTime(), repetidas: null, linhas: 30 },
];
/** `din`: 'vazio' (nunca importou: padrão, para os testes só de cobertura), 'c1' (cenário C1) ou { grupo, loja, ... } com respostas à mão. */
function rotasGanhos(t, { cobertura = COB(), codigos = [], din = 'vazio', importacoes = din === 'vazio' ? [] : IMPORTACOES(), gastos = [] } = {}) {
  t.rotas['GET /api/blocks'] = () => [200, BLOCOS];
  t.rotas['GET /api/rastreio/cobertura'] = () => [200, cobertura];
  t.rotas['GET /api/rastreio/codigos'] = () => [200, { codigos }];
  t.rotas['GET /api/ganhos'] = ({ consulta }) => {
    const por = new URLSearchParams(consulta).get('por') || 'grupo';
    if (typeof din === 'object') return [200, din[por]];
    return [200, din === 'c1' ? DIN_C1(por) : { ...DIN_VAZIO(), por }];
  };
  t.rotas['GET /api/ganhos/importacoes'] = () => [200, { importacoes }];
  t.rotas['GET /api/ganhos/gastos'] = () => [200, { gastos }];
}
const semRastreio = (t) => t.pedidos.filter((p) => p.caminho.startsWith('/api/rastreio'));
const pagina = (t) => t.el('#pagina').innerHTML;

// =========================================================================================== infraestrutura

test('o painel roda sem localStorage e a página nova é carregada antes do app.js', () => {
  const t = tela();
  assert.equal(t.rodar('typeof localStorage'), 'undefined', 'o harness não tem localStorage');
  const scripts = [...fonte('index.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.includes('ganhos.js'), 'index.html carrega ganhos.js');
  assert.ok(scripts.indexOf('ganhos.js') < scripts.indexOf('app.js'), 'antes do app.js, como relatorios.js');
  assert.doesNotMatch(fonte('ganhos.js'), /localStorage|sessionStorage/, 'nada de storage do navegador');
  assert.doesNotMatch(fonte('index.html'), /href="#ganhos"/, 'o item do menu não é estático: entra por app.js só para o Dono');
});

test('o CSS novo de Ganhos usa só tokens (nenhum hex solto)', () => {
  const css = fonte('style.css');
  const i = css.indexOf('/* ganhos: início */'); const f = css.indexOf('/* ganhos: fim */');
  assert.ok(i >= 0 && f > i, 'bloco delimitado de regras novas');
  assert.doesNotMatch(css.slice(i, f), /#[0-9a-fA-F]{3,8}\b|rgb\(|rgba\(/, 'só var(--token)');
});

// =========================================================================================== P2: menu e página só do Dono

test('P2/CA11: o Dono recebe o item "Ganhos" no menu, logo depois de Visão Geral (começo do grupo Principal); sem login também', () => {
  for (const [rotulo, usuario] of [['Dono', dono], ['sem login', null]]) {
    const t = tela(); preparar(t, { usuario, st: { ...estado(), usuario } });
    t.rodar('pintarConta()');
    assert.ok(t.menu.has('#ganhos'), `${rotulo}: tem o item`);
    assert.equal(t.menu.get('#ganhos').textContent, 'Ganhos');
    const ins = t.inseridos.find((x) => x.html.includes('href="#ganhos"'));
    assert.equal(ins.pos, 'afterend', 'depois do título do grupo Principal (logo após Visão Geral), antes do Rotacionador');
    t.rodar('pintarConta()');
    assert.equal(t.inseridos.filter((x) => x.html.includes('href="#ganhos"')).length, 1, `${rotulo}: não duplica a cada atualização do estado`);
  }
});

test('P2/CA11: o Operador não tem o item (sai do DOM se o papel mudou) e #ganhos cai na Visão Geral', () => {
  const t = tela(); preparar(t, { usuario: operador });
  t.rodar('globalThis.__visao = 0; paginaVisao = () => { globalThis.__visao++; }'); // o redirecionamento abre a Visão Geral (sem rede)
  t.rodar('pintarConta()');
  assert.equal(t.menu.has('#ganhos'), false, 'o item nem existe para o Operador');
  assert.equal(t.ctx.__visao, 1, 'estava em #ganhos: o painel foi para a Visão Geral');
  assert.equal(t.ctx.location.hash, '#visao');
  t.ctx.location.hash = '#ganhos';
  assert.equal(t.rodar('rotaAtual()'), 'visao', '#ganhos digitado à mão vira a Visão Geral');
  // o Dono rebaixou esta pessoa com o menu já pintado: o item sai
  t.item('#ganhos', 'Ganhos'); assert.ok(t.menu.has('#ganhos'));
  t.rodar('pintarConta()');
  assert.equal(t.menu.has('#ganhos'), false);
  // o Dono abre normalmente
  const d = tela(); preparar(d);
  assert.equal(d.rodar('rotaAtual()'), 'ganhos');
});

test('P2/CA11: paginaGanhos chamada por um Operador não pede nada ao servidor e não desenha a página', async () => {
  const t = tela(); preparar(t, { usuario: operador }); rotasGanhos(t);
  await t.rodar('paginaGanhos()');
  assert.deepEqual(semRastreio(t), [], 'nenhum GET /api/rastreio como Operador (daria 403)');
  assert.equal(t.pedidos.length, 0);
  assert.ok(!/Ganhos/.test(pagina(t)), 'nada da página no DOM');
});

// =========================================================================================== CA6: cobertura

test('CA6: #ganhos mostra M9 e M10 do cenário C1 com palavra (Boa/Parcial), por loja e "—" para null', async () => {
  const t = tela(); preparar(t); rotasGanhos(t);
  await t.rodar('paginaGanhos()');
  const h = pagina(t);
  assert.match(h, /<h1>Ganhos/);
  // M9 total 11/12 = 91,7% → Boa; M10 12/16 = 75%
  assert.match(h, /91,7%[^<]*<\/b>[^<]*\(11 de 12 links\)/, 'texto principal com a conta');
  assert.match(h, /Boa/, 'o nível sempre com palavra');
  assert.match(h, /75%[^<]*<\/b>[^<]*\(12 de 16 links\)|12 de 16/, 'alcance (M10)');
  // por loja: Shopee 87,5% Parcial; Amazon 100% Boa; ML null → "—"
  assert.match(h, /Shopee[^]*?87,5%[^]*?Parcial/);
  assert.match(h, /Amazon[^]*?100%[^]*?Boa/);
  assert.match(h, /Mercado Livre[^]*?—/, 'null vira "—", nunca 0%');
  assert.ok(!/NaN|undefined|null/.test(h), h);
  // o filtro de período chega ao servidor
  const req = t.pedidos.find((p) => p.caminho === '/api/rastreio/cobertura');
  assert.match(req.consulta, /periodo=30d/);
  // entrega B: o aviso "Em breve" saiu; sem nenhuma importação, os cartões de dinheiro mostram "—" (nunca um R$ 0,00 falso)
  assert.doesNotMatch(h, /Em breve/);
  assert.doesNotMatch(h, /R\$/, 'sem importação, nenhum valor em reais inventado');
  assert.match(h, /class="q"/, 'ícone de ajuda (TIPS) nos títulos');
});

test('CA6: o nível de cobertura segue a spec (>= 90 Boa, 60 a 89 Parcial, < 60 Baixa, null sem nível) sobre o valor arredondado', () => {
  const t = tela();
  const nivel = (r) => json(t.rodar(`ganhosNivel(${r})`));
  assert.equal(nivel(1).rotulo, 'Boa'); assert.equal(nivel(0.9).rotulo, 'Boa'); assert.equal(nivel(0.8999).rotulo, 'Boa', '89,99 arredonda para 90,0');
  assert.equal(nivel(0.894).rotulo, 'Parcial'); assert.equal(nivel(0.6).rotulo, 'Parcial');
  assert.equal(nivel(0.599).rotulo, 'Baixa', '59,9 é abaixo de 60'); assert.equal(nivel(0).rotulo, 'Baixa');
  assert.equal(nivel(null), null, 'sem divisão possível, sem nível');
});

test('CA6: loja abaixo de 80% leva "Atenção" e o caminho para Blocos de análise; sem nenhum envio esperado, texto de "nada configurado"', async () => {
  const t = tela(); preparar(t);
  const baixa = COB(); baixa.por_loja[0] = { loja: 'mercadolivre', ...contas(5, 5, 2) }; baixa.total = contas(19, 17, 13);
  rotasGanhos(t, { cobertura: baixa });
  await t.rodar('paginaGanhos()');
  let h = pagina(t);
  assert.match(h, /Atenção/); assert.match(h, /Baixa/);
  assert.match(h, /Parte dos links de Mercado Livre saiu sem código/);
  assert.match(h, /href="#blocos"/);

  const vazio = tela(); preparar(vazio);
  rotasGanhos(vazio, { cobertura: { de: 1, ate: 2, total: contas(0, 0, 0), por_loja: [], por_grupo: [] } });
  await vazio.rodar('paginaGanhos()');
  h = pagina(vazio);
  assert.match(h, /Sem envios no período/);
  assert.doesNotMatch(h, /NaN|undefined/);

  const semAssoc = tela(); preparar(semAssoc);
  rotasGanhos(semAssoc, { cobertura: { de: 1, ate: 2, total: contas(6, 0, 0), por_loja: [{ loja: 'amazon', ...contas(6, 0, 0) }], por_grupo: [{ jid: 'a@g.us', ...contas(6, 0, 0) }] } });
  await semAssoc.rodar('paginaGanhos()');
  h = pagina(semAssoc);
  assert.match(h, /os links saem como hoje/i, 'CA9 dito na tela quando nada foi associado');
  assert.doesNotMatch(h, /0%/, 'cobertura null nunca vira 0%');
});

test('CA6: período, bloco e loja viram a consulta da cobertura; bloco que sumiu (404) volta para "todos"', async () => {
  const t = tela(); preparar(t); rotasGanhos(t);
  await t.rodar('paginaGanhos()');
  const clique = (alvoSel, chave, valor) => t.el(alvoSel).onclick({ target: { closest: () => ({ dataset: { [chave]: valor } }) } });
  clique('#g-per', 'p', 'mes');
  await ate(() => t.pedidos.filter((p) => p.caminho === '/api/rastreio/cobertura').length >= 2);
  clique('#g-loja', 'loja', 'shopee');
  await ate(() => t.pedidos.filter((p) => p.caminho === '/api/rastreio/cobertura').length >= 3);
  clique('#g-blc', 'b', '1');
  await ate(() => t.pedidos.filter((p) => p.caminho === '/api/rastreio/cobertura').length >= 4);
  const consultas = t.pedidos.filter((p) => p.caminho === '/api/rastreio/cobertura').map((p) => new URLSearchParams(p.consulta));
  assert.deepEqual(consultas.map((c) => c.get('periodo')), ['30d', 'mes', 'mes', 'mes']);
  assert.equal(consultas[2].get('loja'), 'shopee'); assert.equal(consultas[2].get('bloco'), null);
  assert.equal(consultas[3].get('bloco'), '1'); assert.equal(consultas[3].get('loja'), 'shopee');

  // personalizado: de/ate só vão quando são datas AAAA-MM-DD
  clique('#g-per', 'p', 'custom');
  await ate(() => t.pedidos.filter((p) => p.caminho === '/api/rastreio/cobertura').length >= 5);
  const custom = new URLSearchParams(t.pedidos.filter((p) => p.caminho === '/api/rastreio/cobertura').at(-1).consulta);
  assert.equal(custom.get('periodo'), 'custom'); assert.equal(custom.get('de'), null);

  // bloco apagado entre uma visita e outra: o servidor responde 404 e a tela volta para "todos os grupos"
  let primeira = true;
  t.rotas['GET /api/rastreio/cobertura'] = () => { if (primeira) { primeira = false; return [404, { erro: 'Este bloco não existe mais.' }]; } return [200, COB()]; };
  const antes = t.pedidos.length;
  await t.rodar('GANHOS.bloco = "99"; paginaGanhos()');
  await ate(() => /91,7%/.test(pagina(t)));
  assert.match(pagina(t), /91,7%/);
  assert.equal(t.rodar('GANHOS.bloco'), '', 'filtro de bloco limpo');
  assert.ok(t.pedidos.slice(antes).filter((p) => p.caminho === '/api/rastreio/cobertura').length === 2);
});

test('CA6: falha ao carregar mostra o erro com "Tentar de novo" (nenhum número inventado); nome de grupo é escapado', async () => {
  const t = tela(); preparar(t);
  rotasGanhos(t); t.rotas['GET /api/rastreio/cobertura'] = () => [500, { erro: 'Não consegui concluir. Tente de novo.' }];
  await t.rodar('paginaGanhos()');
  let h = pagina(t);
  assert.match(h, /Não consegui carregar/); assert.match(h, /id="g-tentar"/);
  assert.doesNotMatch(h, /%/);

  const x = tela(); preparar(x);
  x.rodar(`S.groups = [{ jid: 'a@g.us', name: ${JSON.stringify(XSS)}, blocks: [] }]`);
  rotasGanhos(x);
  await x.rodar('paginaGanhos()');
  h = pagina(x);
  semMarcacao(h, 'tabela por grupo'); assert.ok(h.includes(XSS_ESC), 'o nome aparece escapado');
});

// =========================================================================================== CA3/CA4: fieldset do bloco

const campo = (t, nome, valor) => { t.el(`[name=${nome}]`).value = valor; };
const MARCADOS = (...jids) => jids.map((value) => ({ value }));
async function enviarBloco(t, { nome = 'Casa nova', tag_id = '', jids = ['a@g.us'] } = {}) {
  t.ctx.__campos = { name: nome, tag_id };
  t.listas['#gr input:checked'] = MARCADOS(...jids);
  await t.el('#f').onsubmit({ preventDefault() {} });
}
const putsRastreio = (t) => t.pedidos.filter((p) => p.metodo === 'PUT' && p.caminho === '/api/rastreio/codigos');
function rotasBloco(t, { codigos = [], idNovo = 9 } = {}) {
  t.rotas['GET /api/blocks'] = () => [200, BLOCOS];
  t.rotas['GET /api/rastreio/codigos'] = () => [200, { codigos }];
  t.rotas['POST /api/blocks'] = () => [200, { id: idNovo }];
  t.rotas['PUT /api/blocks/1'] = () => [200, {}];
  t.rotas['PUT /api/blocks/9'] = () => [200, {}];
  t.rotas['PUT /api/rastreio/codigos'] = () => [200, { codigos: [] }];
}

test('CA3/CA4/P6: o formulário do bloco tem o fieldset "Códigos de rastreio (opcional)" com ML (nomes das etiquetas), Amazon e Shopee; o select de tag_id continua', async () => {
  const t = tela(); preparar(t, { codigos: [] });
  t.rodar('formBloco()');
  const h = t.el('#dlg').innerHTML;
  assert.match(h, /<fieldset[^>]*>\s*<legend[^>]*>Códigos de rastreio \(opcional\)/);
  assert.match(h, /name="tag_id"/, 'o select de tag_id (pré-preenche o disparo automático) segue como era');
  assert.match(h, /name="rastreio_mercadolivre"/); assert.match(h, /name="rastreio_amazon"/); assert.match(h, /name="rastreio_shopee"/);
  const ml = h.match(/<select name="rastreio_mercadolivre"[^]*?<\/select>/)[0];
  assert.match(ml, /<option value="achados">achados<\/option>/, 'valor = NOME da etiqueta (validarCodigo confere pelo nome)');
  assert.match(ml, /<option value="casa">casa<\/option>/);
  assert.doesNotMatch(ml, /value="7"|value="8"/, 'não o id');
  assert.match(h, /Sem preencher, nada muda/, 'CA9 dito no formulário');
  assert.match(h, /<details[^>]*class="[^"]*rastreio/); assert.doesNotMatch(h.match(/<details[^>]*>/)[0], /\sopen/, 'fechado quando os três estão vazios');
  assert.match(h, /data-tip="[^"]*Sub_id/, 'ajuda da Shopee (TIPS rastreio.shopee)');
});

test('CA3/CA4: bloco com associações abre o fieldset já preenchido e a etiqueta apagada de tags continua visível para o dono poder limpar', () => {
  const t = tela();
  preparar(t, { codigos: [cod('amazon', 'bloco', 1, 'casa-20'), cod('shopee', 'bloco', 1, 'casa'), cod('mercadolivre', 'bloco', 1, 'etq-velha'), cod('amazon', 'bloco', 2, 'beleza-20')] });
  t.rodar('formBloco(S.blocks[0])');
  const h = t.el('#dlg').innerHTML;
  assert.match(h, /name="rastreio_amazon"[^>]*value="casa-20"/); assert.match(h, /name="rastreio_shopee"[^>]*value="casa"/);
  assert.match(h.match(/<details[^>]*>/)[0], /\sopen/, 'aberto quando algum campo tem valor');
  assert.match(h, /<option value="etq-velha" selected>etq-velha[^<]*<\/option>/, 'etiqueta não cadastrada aparece selecionada');
  assert.ok(!h.includes('beleza-20'), 'o código do outro bloco não entra');
});

test('CA3/CA4/CA9: criar bloco com Amazon e Shopee grava o bloco e DEPOIS faz um PUT com as duas associações (alvo = id devolvido pelo POST)', async () => {
  const t = tela(); preparar(t, { codigos: [] }); rotasBloco(t);
  t.rodar('formBloco()');
  campo(t, 'rastreio_amazon', ' casa-20 '); campo(t, 'rastreio_shopee', 'casa'); campo(t, 'rastreio_mercadolivre', '');
  await enviarBloco(t);
  const ordem = t.pedidos.filter((p) => ['POST', 'PUT'].includes(p.metodo)).map((p) => `${p.metodo} ${p.caminho}`);
  assert.deepEqual(ordem, ['POST /api/blocks', 'PUT /api/rastreio/codigos'], 'a associação só se grava com o bloco já existente');
  assert.deepEqual(json(putsRastreio(t)[0].corpo), { associacoes: [
    { loja: 'amazon', alvo_tipo: 'bloco', alvo: '9', codigo: 'casa-20' },
    { loja: 'shopee', alvo_tipo: 'bloco', alvo: '9', codigo: 'casa' },
  ] }, 'só o que foi preenchido, código sem espaços, alvo em texto');
  assert.equal(t.el('#dlg').open, false, 'fechou');
});

test('CA4: etiqueta do Mercado Livre escolhida no fieldset vai por NOME; "usar a mesma etiqueta do bloco" copia o tag_id do bloco para o campo', async () => {
  const t = tela(); preparar(t, { codigos: [] }); rotasBloco(t);
  t.rodar('formBloco()');
  assert.match(t.el('#dlg').innerHTML, /data-usar-etiqueta/, 'atalho oferecido no formulário do bloco');
  // atalho: o bloco tem tag_id 7 ("achados"), a associação do ML está vazia
  campo(t, 'tag_id', '7'); campo(t, 'rastreio_mercadolivre', '');
  t.rodar('rastreioUsarEtiquetaDoBloco($("#dlg"))');
  assert.equal(t.el('[name=rastreio_mercadolivre]').value, 'achados');
  // sem tag_id escolhido, o atalho não faz nada
  campo(t, 'tag_id', ''); campo(t, 'rastreio_mercadolivre', '');
  t.rodar('rastreioUsarEtiquetaDoBloco($("#dlg"))');
  assert.equal(t.el('[name=rastreio_mercadolivre]').value, '');
  campo(t, 'rastreio_mercadolivre', 'casa');
  await enviarBloco(t, { tag_id: '7' });
  assert.deepEqual(json(putsRastreio(t)[0].corpo), { associacoes: [{ loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: '9', codigo: 'casa' }] });
  const post = t.pedidos.find((p) => p.metodo === 'POST' && p.caminho === '/api/blocks');
  assert.equal(post.corpo.tag_id, '7', 'o tag_id do bloco segue indo para /blocks como sempre (P9/D2)');
});

test('CA9: bloco sem nenhuma associação (novo, ou editado sem mudar nada) não faz PUT de rastreio', async () => {
  const novo = tela(); preparar(novo, { codigos: [] }); rotasBloco(novo);
  novo.rodar('formBloco()');
  await enviarBloco(novo);
  assert.equal(putsRastreio(novo).length, 0, 'novo e sem códigos: nada de PUT');
  assert.ok(novo.pedidos.some((p) => p.metodo === 'POST' && p.caminho === '/api/blocks'), 'o bloco foi criado');

  const igual = tela(); preparar(igual, { codigos: [cod('amazon', 'bloco', 1, 'casa-20')] }); rotasBloco(igual);
  igual.rodar('formBloco(S.blocks[0])');
  campo(igual, 'rastreio_amazon', 'casa-20'); campo(igual, 'rastreio_shopee', ''); campo(igual, 'rastreio_mercadolivre', '');
  await enviarBloco(igual, { tag_id: '7', jids: ['a@g.us', 'b@g.us'] });
  assert.equal(putsRastreio(igual).length, 0, 'editado sem mexer nos códigos: nada de PUT');
  assert.ok(igual.pedidos.some((p) => p.metodo === 'PUT' && p.caminho === '/api/blocks/1'));
});

test('CA3: apagar o código de um bloco manda a associação com codigo vazio (o servidor apaga)', async () => {
  const t = tela(); preparar(t, { codigos: [cod('amazon', 'bloco', 1, 'casa-20'), cod('shopee', 'bloco', 1, 'casa')] }); rotasBloco(t);
  t.rodar('formBloco(S.blocks[0])');
  campo(t, 'rastreio_amazon', ''); campo(t, 'rastreio_shopee', 'casa'); campo(t, 'rastreio_mercadolivre', '');
  await enviarBloco(t, { tag_id: '7', jids: ['a@g.us'] });
  assert.deepEqual(json(putsRastreio(t)[0].corpo), { associacoes: [{ loja: 'amazon', alvo_tipo: 'bloco', alvo: '1', codigo: '' }] }, 'só o que mudou');
});

test('CA3/CA4: código recusado (cliente confere o formato, servidor o resto) mostra a frase pronta, não fecha o diálogo e não cria o bloco duas vezes', async () => {
  const t = tela(); preparar(t, { codigos: [] }); rotasBloco(t);
  t.rodar('formBloco()');
  // formato errado: nem chega ao servidor, o campo é marcado
  campo(t, 'rastreio_amazon', '123456'); campo(t, 'rastreio_shopee', 'com espaço');
  await enviarBloco(t);
  const erros = t.el('.erros').innerHTML;
  assert.match(erros, /Isso parece um ID de afiliado\. O ID de rastreamento da Amazon tem letras e termina em -20\./);
  assert.match(erros, /O Sub_id aceita só letras e números, sem espaços \(até 30 caracteres\)\./);
  assert.equal(t.pedidos.filter((p) => ['POST', 'PUT'].includes(p.metodo)).length, 0, 'nada foi gravado');
  campo(t, 'rastreio_amazon', 'ab#c');
  await enviarBloco(t);
  assert.match(t.el('.erros').innerHTML, /costuma terminar em -20, como casa-20/);

  // o servidor recusa depois do bloco criado (código de outro alvo): erro na tela, diálogo aberto, bloco já existe
  t.rotas['PUT /api/rastreio/codigos'] = () => [400, { erro: 'Este código já está associado a outro grupo ou bloco.' }];
  campo(t, 'rastreio_amazon', 'casa-20'); campo(t, 'rastreio_shopee', '');
  t.el('#dlg').open = true;
  await enviarBloco(t);
  assert.match(t.el('.erros').innerHTML, /Este código já está associado a outro grupo ou bloco\./);
  assert.equal(t.el('#dlg').open, true, 'o diálogo fica aberto para corrigir');
  // corrigir e salvar de novo: atualiza o bloco criado (PUT /blocks/9), não cria outro
  t.rotas['PUT /api/rastreio/codigos'] = () => [200, { codigos: [] }];
  campo(t, 'rastreio_amazon', 'casa2-20');
  await enviarBloco(t);
  assert.equal(t.pedidos.filter((p) => p.metodo === 'POST' && p.caminho === '/api/blocks').length, 1, 'um POST só');
  assert.ok(t.pedidos.some((p) => p.metodo === 'PUT' && p.caminho === '/api/blocks/9'));
  assert.equal(json(putsRastreio(t).at(-1).corpo).associacoes[0].alvo, '9');
});

test('CA11: o Operador abre o formulário do bloco sem o fieldset de rastreio e sem pedir os códigos ao servidor', async () => {
  const t = tela({ hash: '#blocos' }); preparar(t, { usuario: operador }); rotasBloco(t);
  await t.rodar('paginaBlocos()');
  assert.deepEqual(semRastreio(t), [], 'GET de códigos daria 403 para o Operador: nem pede');
  t.rodar('formBloco(S.blocks[0])');
  const h = t.el('#dlg').innerHTML;
  assert.doesNotMatch(h, /rastreio_|Códigos de rastreio/);
  assert.match(h, /name="tag_id"/, 'o resto do formulário não mudou');
  assert.doesNotMatch(pagina(t), /Rastreio:/, 'o cartão do bloco também não mostra o rastreio');
  await enviarBloco(t, { tag_id: '7', jids: ['a@g.us'] });
  assert.equal(putsRastreio(t).length, 0);
});

test('CA3/CA4: o cartão do bloco resume o rastreio ("ML … · Amazon … · Shopee …" ou "padrão de cada loja") com texto escapado', async () => {
  const t = tela({ hash: '#blocos' }); preparar(t);
  rotasBloco(t, { codigos: [cod('amazon', 'bloco', 1, 'casa-20'), cod('shopee', 'bloco', 1, 'casa'), cod('mercadolivre', 'bloco', 1, XSS)] });
  await t.rodar('paginaBlocos()');
  const h = pagina(t);
  const c1 = h.match(/<article[^>]*data-id="1"[^]*?<\/article>/)[0]; const c2 = h.match(/<article[^>]*data-id="2"[^]*?<\/article>/)[0];
  assert.match(c1, /Rastreio:/); assert.match(c1, /Amazon[^<]*<b>casa-20<\/b>/); assert.match(c1, /Shopee[^<]*<b>casa<\/b>/); assert.match(c1, /ML[^<]*<b>/);
  semMarcacao(c1, 'cartão do bloco');
  assert.match(c2, /Rastreio: padrão de cada loja/, 'sem nenhum: o de hoje (CA9)');
  assert.match(c1, /Etiqueta do disparo automático/, 'a linha do tag_id segue, com o nome que a distingue do rastreio');
});

// =========================================================================================== Grupos: coluna Rastreio e exceção

test('CA3/CA4: Grupos (Dono) ganha a coluna Rastreio: "Do bloco" / "Padrão" + Definir; com exceção, selos com texto + Editar', () => {
  const t = tela({ hash: '#grupos' });
  preparar(t, { codigos: [cod('amazon', 'bloco', 1, 'casa-20'), cod('amazon', 'grupo', 'c@g.us', 'solto-20'), cod('mercadolivre', 'grupo', 'c@g.us', 'casa')] });
  const h = t.rodar('tabelaGrupos(S.groups)');
  assert.match(h, /<th>Rastreio/);
  const linha = (jid) => h.match(new RegExp(`<tr data-jid="${jid.replace('.', '\\.')}">[^]*?</tr>`))[0];
  const a = linha('a@g.us'); const b = linha('b@g.us'); const c = linha('c@g.us');
  assert.match(a, /Do bloco/); assert.match(a, /aria-label="Definir código de rastreio do grupo Achados"/); assert.match(a, />Definir</);
  assert.match(b, /Do bloco/, 'o grupo em dois blocos, um deles com código');
  assert.match(c, /Amazon[^<]*<b>solto-20<\/b>/); assert.match(c, /ML[^<]*<b>casa<\/b>/); assert.match(c, />Editar</);
  assert.match(c, /aria-label="Editar código de rastreio do grupo Solto"/);
  assert.doesNotMatch(c, /Shopee/);
  // grupo fora de bloco e sem exceção
  t.rodar('S.groups.push({ jid: "d@g.us", name: "Sem nada", blocks: [] })');
  assert.match(t.rodar('tabelaGrupos(S.groups)').match(/<tr data-jid="d@g\.us">[^]*?<\/tr>/)[0], />Padrão</);
});

test('CA11/CA9: Grupos para o Operador não tem a coluna nem os botões; o Dono ainda sem os códigos carregados vê "—" e nenhum botão', () => {
  const op = tela({ hash: '#grupos' }); preparar(op, { usuario: operador, codigos: [cod('amazon', 'grupo', 'c@g.us', 'solto-20')] });
  const h = op.rodar('tabelaGrupos(S.groups)');
  assert.doesNotMatch(h, /Rastreio|data-rastreio|solto-20/); assert.match(h, /<th>Convite/, 'o resto da tabela segue');
  assert.match(h, /colspan="3"|<tr data-jid/, 'colspan consistente com as colunas');
  const t = tela({ hash: '#grupos' }); preparar(t);
  const hd = t.rodar('tabelaGrupos(S.groups)');
  assert.match(hd, /<th>Rastreio/); assert.doesNotMatch(hd, /data-rastreio=/, 'sem os códigos não oferece Definir (poderia sobrescrever sem ver)');
  assert.equal(t.rodar('tabelaGrupos([])').match(/colspan="(\d)"/)[1], '4');
});

test('P6: o diálogo de exceção do grupo tem só Mercado Livre e Amazon, nunca Shopee; mostra o aviso de grupo em dois blocos com códigos diferentes', () => {
  const t = tela({ hash: '#grupos' });
  preparar(t, { codigos: [cod('amazon', 'bloco', 1, 'casa-20'), cod('amazon', 'bloco', 2, 'beleza-20'), cod('shopee', 'bloco', 1, 'casa')] });
  t.rodar('rastreioFormGrupo("b@g.us")');
  const h = t.el('#dlg').innerHTML;
  assert.match(h, /Rastreio do grupo Casa/);
  assert.match(h, /name="rastreio_mercadolivre"/); assert.match(h, /name="rastreio_amazon"/);
  assert.doesNotMatch(h, /rastreio_shopee|Sub_id da Shopee/, 'Sub_id só no bloco (P6)');
  assert.match(h, /Vale só para este grupo e vence o código do bloco\. Deixe vazio para voltar ao do bloco\./);
  assert.match(h, /Este grupo está nos blocos Casa e cozinha e Beleza com códigos diferentes\. O do bloco Casa e cozinha \(o mais antigo\) é usado\./);
  assert.match(h, /Salvar rastreio/); assert.match(h, /Cancelar/);
  assert.doesNotMatch(h, /<details/, 'no diálogo do grupo os campos vêm à vista, num fieldset com legenda');
  assert.match(h, /<fieldset[^>]*><legend>Códigos de rastreio/);
  assert.equal(t.el('#dlg').open, true);
  // grupo sem conflito: sem aviso
  const s = tela({ hash: '#grupos' }); preparar(s, { codigos: [] });
  s.rodar('rastreioFormGrupo("a@g.us")');
  assert.doesNotMatch(s.el('#dlg').innerHTML, /códigos diferentes/);
});

test('CA3/CA4: salvar a exceção do grupo faz PUT com alvo_tipo grupo e o jid; sem mudança, só fecha (CA9); nome do grupo escapado', async () => {
  const t = tela({ hash: '#grupos' }); preparar(t, { codigos: [] });
  t.rotas['PUT /api/rastreio/codigos'] = () => [200, { codigos: [cod('amazon', 'grupo', 'c@g.us', 'solto-20')] }];
  t.rotas['GET /api/rastreio/codigos'] = () => [200, { codigos: [cod('amazon', 'grupo', 'c@g.us', 'solto-20')] }];
  t.rodar('rastreioFormGrupo("c@g.us")');
  campo(t, 'rastreio_amazon', 'solto-20'); campo(t, 'rastreio_mercadolivre', 'casa');
  await t.el('#f').onsubmit({ preventDefault() {} });
  assert.deepEqual(json(putsRastreio(t)[0].corpo), { associacoes: [
    { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: 'c@g.us', codigo: 'casa' },
    { loja: 'amazon', alvo_tipo: 'grupo', alvo: 'c@g.us', codigo: 'solto-20' },
  ] });
  assert.equal(t.el('#dlg').open, false);
  assert.equal(t.rodar('RASTREIO.codigos.length'), 1, 'o cache vem da resposta do PUT');

  const quieto = tela({ hash: '#grupos' }); preparar(quieto, { codigos: [] });
  quieto.rodar('rastreioFormGrupo("c@g.us")');
  campo(quieto, 'rastreio_amazon', ''); campo(quieto, 'rastreio_mercadolivre', '');
  await quieto.el('#f').onsubmit({ preventDefault() {} });
  assert.equal(putsRastreio(quieto).length, 0, 'CA9: nada configurado, nada gravado');
  assert.equal(quieto.el('#dlg').open, false);

  const x = tela({ hash: '#grupos' }); preparar(x, { codigos: [] });
  x.rodar(`S.groups = [{ jid: 'z@g.us', name: ${JSON.stringify(XSS)}, blocks: [] }]`);
  x.rodar('rastreioFormGrupo("z@g.us")');
  semMarcacao(x.el('#dlg').innerHTML, 'diálogo do grupo');
  assert.ok(x.el('#dlg').innerHTML.includes(XSS_ESC));
  semMarcacao(x.rodar('tabelaGrupos(S.groups)'), 'tabela de grupos');
});

test('CA11: o Operador não abre o diálogo de rastreio do grupo (a função recusa em silêncio)', () => {
  const t = tela({ hash: '#grupos' }); preparar(t, { usuario: operador });
  t.rodar('rastreioFormGrupo("a@g.us")');
  assert.equal(t.el('#dlg').open, false); assert.equal(t.el('#dlg').innerHTML, '');
});

test('CA3/CA4: paginaGrupos (Dono) carrega os códigos e redesenha a coluna; (Operador) nunca pede', async () => {
  const t = tela({ hash: '#grupos' }); preparar(t);
  rotasBloco(t, { codigos: [cod('amazon', 'grupo', 'c@g.us', 'solto-20')] });
  t.rodar('paginaGrupos()');
  assert.doesNotMatch(pagina(t), /data-rastreio=/, 'antes de chegar, sem botão');
  await ate(() => /solto-20/.test(pagina(t)));
  assert.match(pagina(t), /Amazon[^<]*<b>solto-20<\/b>/);
  assert.equal(t.pedidos.filter((p) => p.caminho === '/api/rastreio/codigos').length >= 1, true);

  const op = tela({ hash: '#grupos' }); preparar(op, { usuario: operador }); rotasBloco(op);
  op.rodar('paginaGrupos()');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(semRastreio(op), []);
  assert.doesNotMatch(pagina(op), /Rastreio/);
});

// =========================================================================================== ajuda

test('ajuda: toda chave de TIPS que a tela nova usa existe e o texto dispensa o jargão "tag" sozinha', () => {
  const t = tela();
  const usadas = [...fonte('ganhos.js').matchAll(/\bq\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(usadas.length >= 4, 'a tela usa os verbetes novos');
  const TIPS = json(t.rodar('TIPS'));
  for (const k of usadas) assert.ok(Object.hasOwn(TIPS, k) && TIPS[k].length > 20, `TIPS.${k}`);
  for (const k of ['ganhos', 'ganhos.cobertura', 'rastreio', 'rastreio.amazon', 'rastreio.shopee', 'rastreio.grupo']) assert.ok(Object.hasOwn(TIPS, k), `TIPS.${k} (spec)`);
  assert.doesNotMatch(TIPS['blocos.etiqueta'], /ganho aparece separado/, 'a etiqueta do bloco só pré-preenche o disparo; quem separa o ganho é o rastreio');
});

// =========================================================================================== rodada 2: foco, região viva, textos

const GRUPOS_MUITOS = (n) => Array.from({ length: n }, (_, i) => ({ jid: `g${i}@g.us`, ...contas(2, 2, 1) }));
const cliqueGanhos = (t, alvoSel, chave, valor) => t.el(alvoSel).onclick({ target: { closest: () => ({ dataset: { [chave]: valor } }) } });
const coberturas = (t) => t.pedidos.filter((p) => p.caminho === '/api/rastreio/cobertura').length;

test('D1/CA6: depois de trocar período, bloco ou loja o foco volta ao botão clicado (a página foi redesenhada) e a página antiga fica até a nova chegar', async () => {
  const t = tela(); preparar(t); rotasGanhos(t);
  await t.rodar('paginaGanhos()');
  assert.deepEqual(t.foco, [], 'ao abrir a página ninguém rouba o foco');
  cliqueGanhos(t, '#g-per', 'p', 'mes');
  assert.match(pagina(t), /<h1>Ganhos/, 'durante o recarregamento o conteúdo anterior não é apagado (o foco não cai no corpo da página)');
  await ate(() => coberturas(t) >= 2 && t.foco.length >= 1);
  assert.deepEqual(t.foco, ['#g-per [data-p="mes"]']);
  cliqueGanhos(t, '#g-loja', 'loja', 'shopee');
  await ate(() => t.foco.length >= 2);
  assert.equal(t.foco.at(-1), '#g-loja [data-loja="shopee"]');
  cliqueGanhos(t, '#g-blc', 'b', '1');
  await ate(() => t.foco.length >= 3);
  assert.equal(t.foco.at(-1), '#g-blc [data-b="1"]');
  cliqueGanhos(t, '#g-blc', 'b', '');
  await ate(() => t.foco.length >= 4);
  assert.equal(t.foco.at(-1), '#g-blc [data-b=""]', 'o botão "Todos os grupos"');
});

test('D1: o campo de data (Personalizado) e o "Mostrar mais" também devolvem o foco ao controle equivalente', async () => {
  const t = tela(); preparar(t);
  const cob = COB(); cob.por_grupo = GRUPOS_MUITOS(30);
  rotasGanhos(t, { cobertura: cob });
  await t.rodar('paginaGanhos()');
  cliqueGanhos(t, '#g-per', 'p', 'custom');
  await ate(() => t.foco.length >= 1);
  assert.equal(t.foco.at(-1), '#g-per [data-p="custom"]');
  t.el('#g-de').onchange({ target: { value: '2026-10-01' } });
  await ate(() => t.foco.length >= 2);
  assert.equal(t.foco.at(-1), '#g-de');
  t.el('#g-ate').onchange({ target: { value: '2026-10-31' } });
  await ate(() => t.foco.length >= 3);
  assert.equal(t.foco.at(-1), '#g-ate');
  assert.match(pagina(t), /id="g-mais"/);
  t.el('#g-mais').onclick();
  await ate(() => t.foco.length >= 4);
  assert.equal(t.foco.at(-1), '#g-tabela-titulo', 'o botão sumiu (todos à vista): o foco vai para o título da tabela');
  assert.match(pagina(t), /id="g-tabela-titulo"[^>]*tabindex="-1"/);
});

test('D1: o anúncio "Ganhos atualizados" mora numa região aria-live estável, fora do trecho redesenhado', async () => {
  const t = tela(); preparar(t); rotasGanhos(t);
  await t.rodar('paginaGanhos()');
  assert.doesNotMatch(pagina(t), /sr-only"[^>]*role="status"|role="status"[^>]*sr-only|Ganhos atualizados/, 'a região não é recriada com a página');
  assert.match(t.el('#g-vivo').textContent, /^Ganhos atualizados: 30 dias/);
  cliqueGanhos(t, '#g-per', 'p', 'mes');
  await ate(() => coberturas(t) >= 2 && /Mês atual/.test(t.el('#g-vivo').textContent));
  assert.match(t.el('#g-vivo').textContent, /^Ganhos atualizados: Mês atual/);
  cliqueGanhos(t, '#g-blc', 'b', '1');
  await ate(() => /Casa e cozinha/.test(t.el('#g-vivo').textContent));
  assert.match(t.el('#g-vivo').textContent, /bloco Casa e cozinha/);
  cliqueGanhos(t, '#g-loja', 'loja', 'amazon');
  await ate(() => /loja Amazon/.test(t.el('#g-vivo').textContent));
  assert.match(t.el('#g-vivo').textContent, /loja Amazon/);
  // o código que cria a região quando ela não existe a deixa polida e atômica
  assert.match(fonte('ganhos.js'), /setAttribute\('aria-live', 'polite'\)/);
});

test('R6: a dica do Sub_id e a prévia dizem que hoje o Sub_id só sai pela API da Shopee; sem ela o link sai sem Sub_id', () => {
  const t = tela(); preparar(t, { codigos: [] });
  t.rodar('formBloco()');
  const h = t.el('#dlg').innerHTML;
  const dica = h.match(/name="rastreio_shopee"[^]*?<small>([^<]*)<\/small>/)[1];
  assert.match(dica, /API de afiliados da Shopee/); assert.match(dica, /sem ela, o link sai sem Sub_id/i);
  campo(t, 'rastreio_shopee', 'casa');
  t.rodar('rastreioPrevia($("#dlg"), "bloco")');
  assert.match(t.el('#dlg').querySelector('[data-previa]').textContent, /Shopee: usa o Sub_id casa\. Hoje o Sub_id só sai pela API de afiliados da Shopee; sem ela, o link sai sem Sub_id\./);
});

test('R6: Shopee abaixo de 80% manda o dono para a API da Shopee (Conexões), não para Blocos; as outras lojas seguem para Blocos', async () => {
  const t = tela(); preparar(t);
  const baixa = COB(); baixa.por_loja = [{ loja: 'shopee', ...contas(8, 8, 2) }, { loja: 'amazon', ...contas(6, 4, 1) }]; baixa.total = contas(14, 12, 3);
  rotasGanhos(t, { cobertura: baixa });
  await t.rodar('paginaGanhos()');
  const h = pagina(t);
  const avisos = [...h.matchAll(/<div class="aviso-impl" role="status">[^]*?<\/div>/g)].map((m) => m[0]);
  const shopee = avisos.find((a) => /Shopee/.test(a)); const amazon = avisos.find((a) => /Amazon/.test(a));
  assert.match(shopee, /só aceita o código de rastreio quando você conecta sua conta de afiliado/); assert.doesNotMatch(shopee, /Sub_id|API/, 'sem jargão'); assert.match(shopee, /href="#conexoes"/);
  assert.doesNotMatch(shopee, /href="#blocos"/, 'o dono já configurou o Sub_id em Blocos: mandar de volta para lá é enganar');
  assert.match(amazon, /href="#blocos"/);
});

test('R7: o diálogo do grupo diz "sem escolher, vale a do bloco; sem bloco, a etiqueta do disparo"; o do bloco mantém "a etiqueta do disparo"', () => {
  const t = tela({ hash: '#grupos' }); preparar(t, { codigos: [] });
  t.rodar('rastreioFormGrupo("a@g.us")');
  const g = t.el('#dlg').innerHTML.match(/name="rastreio_mercadolivre"[^]*?<small>([^<]*)<\/small>/)[1];
  assert.equal(g, 'Sem escolher, vale a do bloco; sem bloco, a etiqueta do disparo.');
  t.rodar('formBloco()');
  assert.match(t.el('#dlg').innerHTML.match(/name="rastreio_mercadolivre"[^]*?<small>([^<]*)<\/small>/)[1], /^Sem escolher, vale a etiqueta do disparo\.$/);
});

test('QG3: o pertencimento ao bloco vem de S.blocks (group_jids), não do S.groups[].blocks velho: o texto sob o nome do grupo também', () => {
  const t = tela({ hash: '#grupos' }); preparar(t, { codigos: [cod('amazon', 'bloco', 9, 'x-20')] });
  // S.groups ainda diz que "c" não está em bloco e "a" está no 1; os blocos (mais novos) dizem o contrário
  t.rodar(`S.blocks = [${JSON.stringify(bloco(1, 'Casa e cozinha', 7, ['b@g.us']))}, ${JSON.stringify(bloco(9, 'Novo', null, ['c@g.us']))}]`);
  const h = t.rodar('tabelaGrupos(S.groups)');
  const linha = (jid) => h.match(new RegExp(`<tr data-jid="${jid.replace('.', '\\.')}">[^]*?</tr>`))[0];
  assert.match(linha('c@g.us'), /Novo/); assert.match(linha('c@g.us'), /Do bloco/);
  assert.doesNotMatch(linha('a@g.us'), /Casa e cozinha/, 'texto sob o nome sem o bloco que o perdeu');
  assert.match(linha('b@g.us'), /Casa e cozinha/);
});

// =========================================================================================== Entrega B (etapa 17): Dashboard, Importar, Gasto
// CA5 (importar pelo painel, com prévia antes de gravar), CA6 (métricas por grupo, bloco, loja, oferta e período, cobertura,
// custo por membro), CA8 (estes testes nasceram antes do código). Valores do cenário C1 do plano (catálogo de métricas).

const { MAX_BYTES_ARQUIVO, MAX_LINHAS_ARQUIVO } = await import('../src/csv.js');
const { MAX_DIAS_GASTO, MAX_NOTA } = await import('../src/ganhos.js');

/** O Intl do pt-BR separa "R$" do número com um espaço sem quebra: os testes comparam com espaço comum. */
const flat = (h) => String(h).replace(/ /g, ' ');
const cartao = (h, m) => { const x = flat(h).match(new RegExp(`<div class="kpi[^"]*" data-m="${m}">[^]*?</div>\\s*</div>`)); assert.ok(x, `cartão ${m} não encontrado`); return x[0]; };
const valorDe = (h, m) => cartao(h, m).match(/<div class="valor">([^<]*)<\/div>/)[1].trim();
const notaDe = (h, m) => (cartao(h, m).match(/<div class="nota">([^]*?)<\/div>/) || [, ''])[1].replace(/<[^>]+>/g, '').trim();
const secao = (h, id) => { const x = flat(h).match(new RegExp(`<section id="${id}"[^>]*>[^]*?</section>`)); assert.ok(x, `seção ${id} não encontrada`); return x[0]; };
const linhasSecao = (h, id) => [...secao(h, id).matchAll(/<tr[^>]*data-k="([^"]*)"[^>]*>([^]*?)<\/tr>/g)].map((m) => ({ k: m[1], html: m[2] }));
const celulaDe = (html, rot) => { const x = html.match(new RegExp(`<td[^>]*data-rot="${rot}"[^>]*>([^]*?)</td>`)); assert.ok(x, `coluna ${rot} não encontrada em ${html}`); return x[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); };
const textoPagina = (h) => flat(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

async function abrirGanhos(opcoes = {}, { usuario = dono } = {}) {
  const t = tela(); preparar(t, { usuario }); rotasGanhos(t, opcoes);
  await t.rodar('paginaGanhos()');
  return t;
}
const consultasGanhos = (t) => t.pedidos.filter((p) => p.caminho === '/api/ganhos').map((p) => new URLSearchParams(p.consulta));

test('CA6/M1-M15: o Dashboard do cenário C1 mostra os 12 cartões com o valor certo em R$, em porcentagem e em contagem', async () => {
  const t = await abrirGanhos({ din: 'c1' }); const h = pagina(t);
  assert.equal(valorDe(h, 'comissao'), 'R$ 21,00', 'M1');
  assert.match(notaDe(h, 'comissao'), /Confirmada: R\$ 13,00/, 'M1c');
  assert.equal(valorDe(h, 'receita'), 'R$ 410,00', 'M2');
  assert.equal(valorDe(h, 'vendas'), '7', 'M3');
  assert.equal(valorDe(h, 'cliques'), '250', 'M4');
  assert.equal(valorDe(h, 'epc'), 'R$ 0,06', 'M5: o servidor manda centavos por clique');
  assert.equal(valorDe(h, 'conversao'), '2%', 'M6');
  assert.equal(valorDe(h, 'envios'), '16', 'M7');
  assert.equal(valorDe(h, 'atribuida'), '47,6%', 'M11');
  assert.match(notaDe(h, 'atribuida'), /R\$ 10,00 de R\$ 21,00/);
  assert.equal(valorDe(h, 'gasto'), 'R$ 43,00', 'M12');
  assert.equal(valorDe(h, 'entradas'), '31', 'M13');
  assert.equal(valorDe(h, 'custo'), 'R$ 1,39', 'M14: 4300 ÷ 31 centavos');
  assert.equal(valorDe(h, 'retorno'), '-R$ 22,00', 'M15');
  assert.match(notaDe(h, 'retorno'), /prejuízo/, 'a cor nunca é o único sinal: a palavra vem junto');
  assert.ok(!/NaN|undefined|null|Infinity/.test(h));
  // cada cartão tem o seu "?" (TIPS)
  for (const m of ['comissao', 'receita', 'vendas', 'cliques', 'epc', 'conversao', 'envios', 'atribuida', 'gasto', 'entradas', 'custo', 'retorno']) assert.match(cartao(h, m), /class="q"/, `? em ${m}`);
  assert.ok(!/Em breve/.test(h));
});

test('CA6: o retorno positivo diz "lucro"; a data até onde foi importado aparece por loja', async () => {
  const total = { ...TOTAL_C1, comissao: 9000, retorno: 4700, atribuida: 0.5 };
  const t = await abrirGanhos({ din: { grupo: { ...DIN_C1('grupo'), total }, loja: DIN_C1('loja'), bloco: DIN_C1('bloco'), oferta: DIN_C1('oferta'), dia: DIN_C1('dia') } });
  const h = pagina(t);
  assert.equal(valorDe(h, 'retorno'), 'R$ 47,00'); assert.match(notaDe(h, 'retorno'), /lucro/);
  assert.match(textoPagina(h), /Dados importados até 07\/10 \(Shopee\), 10\/10 \(Amazon\), 11\/10 \(Mercado Livre\)/);
});

test('CA6/plano item 17: divisão por zero (null do servidor) vira "—", nunca 0, NaN nem "R$ 0,00"; cliques zerados explicam de onde vêm', async () => {
  const total = { ...TOTAL_C1, epc: null, conversao: null, cliques: 0, gasto: null, custo_membro: null, retorno: null, atribuida: null, comissao_atribuida: 0 };
  const t = await abrirGanhos({ din: { grupo: { ...DIN_C1('grupo'), total, gastos_informados: 0 }, loja: DIN_C1('loja'), bloco: DIN_C1('bloco'), oferta: DIN_C1('oferta'), dia: DIN_C1('dia') } });
  const h = pagina(t);
  for (const m of ['epc', 'conversao', 'cliques', 'gasto', 'custo', 'retorno', 'atribuida']) assert.equal(valorDe(h, m), '—', m);
  assert.match(notaDe(h, 'cliques'), /relatório de cliques da loja/, 'sem cliques importados: diz onde conseguir');
  assert.match(notaDe(h, 'epc'), /sem cliques/i);
  assert.match(notaDe(h, 'gasto') + cartao(h, 'gasto'), /Informar/, 'o cartão do gasto leva ao diálogo');
  assert.match(notaDe(h, 'custo'), /gasto/i); assert.match(notaDe(h, 'retorno'), /gasto/i);
  assert.ok(!/NaN|undefined|null/.test(h));
});

test('CA6: M14 sem entradas e M15 com filtro de loja explicam o "—"', async () => {
  const total = { ...TOTAL_C1, entradas: 0, custo_membro: null, retorno: null };
  const t = tela(); preparar(t); rotasGanhos(t, { din: { grupo: { ...DIN_C1('grupo'), total, loja: 'shopee' }, loja: DIN_C1('loja'), bloco: DIN_C1('bloco'), oferta: DIN_C1('oferta'), dia: DIN_C1('dia') }, importacoes: IMPORTACOES() });
  t.rodar('GANHOS.loja = "shopee"'); await t.rodar('paginaGanhos()');
  const h = pagina(t);
  assert.equal(valorDe(h, 'custo'), '—'); assert.match(notaDe(h, 'custo'), /sem entradas/i);
  assert.equal(valorDe(h, 'retorno'), '—'); assert.match(notaDe(h, 'retorno'), /filtro de loja/i);
});

test('CA6: o filtro de período, bloco e loja chega aos cinco recortes (grupo, bloco, loja, oferta, dia) de GET /api/ganhos', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  assert.deepEqual(consultasGanhos(t).map((c) => c.get('por')).sort(), ['bloco', 'dia', 'grupo', 'loja', 'oferta']);
  assert.ok(consultasGanhos(t).every((c) => c.get('periodo') === '30d' && c.get('bloco') === null && c.get('loja') === null));
  const antes = consultasGanhos(t).length;
  cliqueGanhos(t, '#g-loja', 'loja', 'amazon');
  await ate(() => consultasGanhos(t).length >= antes + 5);
  cliqueGanhos(t, '#g-blc', 'b', '2');
  await ate(() => consultasGanhos(t).length >= antes + 10);
  const novas = consultasGanhos(t).slice(antes);
  assert.ok(novas.slice(0, 5).every((c) => c.get('loja') === 'amazon' && c.get('bloco') === null));
  assert.ok(novas.slice(5).every((c) => c.get('loja') === 'amazon' && c.get('bloco') === '2'));
  assert.ok(t.pedidos.some((p) => p.caminho === '/api/ganhos/importacoes'), 'as importações recentes vêm juntas');
});

test('CA6: Por grupo — colunas, uma linha por grupo, "Sem grupo identificado" fora do ranking, totais no rodapé e "—" para null', async () => {
  const t = await abrirGanhos({ din: 'c1' }); const h = pagina(t);
  const s = secao(h, 'g-sec-grupo');
  for (const col of ['Grupo', 'Bloco', 'Comissão', 'Vendas', 'Cliques', 'Ganho por clique', 'Entradas', 'Gasto', 'Custo por membro novo']) assert.match(s, new RegExp(`<th[^>]*scope="col"[^>]*>(?:<button[^>]*>)?${col}`), col);
  assert.match(s, /<caption class="sr-only">[^<]*grupo/i);
  const linhas = linhasSecao(h, 'g-sec-grupo');
  assert.deepEqual(linhas.map((l) => l.k), ['a@g.us', 'b@g.us', 'c@g.us', 'sem-grupo'], 'ordem da comissão, com a linha sem grupo por último');
  const a = linhas[0].html;
  assert.match(celulaDe(a, 'Grupo'), /Achados/); assert.equal(celulaDe(a, 'Bloco'), 'Casa e cozinha');
  assert.equal(celulaDe(a, 'Comissão'), 'R$ 5,00'); assert.equal(celulaDe(a, 'Vendas'), '2'); assert.equal(celulaDe(a, 'Cliques'), '100');
  assert.equal(celulaDe(a, 'Ganho por clique'), 'R$ 0,05'); assert.equal(celulaDe(a, 'Entradas'), '10');
  assert.equal(celulaDe(a, 'Gasto'), '—', 'G1 não tem gasto próprio'); assert.equal(celulaDe(a, 'Custo por membro novo'), '—');
  assert.equal(celulaDe(linhas[1].html, 'Bloco'), 'Casa e cozinha, Beleza');
  const c = linhas[2].html;
  assert.equal(celulaDe(c, 'Comissão'), 'R$ 0,00', 'importou e o grupo vendeu zero: zero de verdade'); assert.equal(celulaDe(c, 'Ganho por clique'), '—');
  assert.equal(celulaDe(c, 'Gasto'), 'R$ 12,00'); assert.equal(celulaDe(c, 'Custo por membro novo'), 'R$ 2,00'); assert.equal(celulaDe(c, 'Bloco'), '—');
  const sem = linhas[3].html;
  assert.match(sem, /Sem grupo identificado/); assert.equal(celulaDe(sem, 'Comissão'), 'R$ 11,00'); assert.equal(celulaDe(sem, 'Cliques'), '60'); assert.equal(celulaDe(sem, 'Entradas'), '—');
  const rodape = s.match(/<tfoot[^>]*>[^]*?<\/tfoot>/)[0];
  assert.match(rodape, /Total/); assert.match(rodape, /R\$ 21,00/); assert.match(rodape, /250/); assert.match(rodape, /R\$ 43,00/);
});

test('CA6: Por grupo — o cabeçalho ordena (botão, aria-sort), nulos sempre por último, e o mesmo clique inverte', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  assert.match(secao(pagina(t), 'g-sec-grupo'), /aria-sort="descending"[^>]*>(?:<button[^>]*>)?Comissão/, 'ordem inicial: comissão, maior primeiro');
  const ordenar = (col) => t.el('#g-sec-grupo').onclick({ target: { closest: () => ({ dataset: { ordem: col } }) } });
  ordenar('entradas'); await ate(() => /aria-sort="descending"[^>]*>(?:<button[^>]*>)?Entradas/.test(secao(pagina(t), 'g-sec-grupo')));
  assert.deepEqual(linhasSecao(pagina(t), 'g-sec-grupo').map((l) => l.k), ['b@g.us', 'a@g.us', 'c@g.us', 'sem-grupo']);
  ordenar('entradas'); await ate(() => /aria-sort="ascending"[^>]*>(?:<button[^>]*>)?Entradas/.test(secao(pagina(t), 'g-sec-grupo')));
  assert.deepEqual(linhasSecao(pagina(t), 'g-sec-grupo').map((l) => l.k), ['c@g.us', 'a@g.us', 'b@g.us', 'sem-grupo']);
  ordenar('gasto'); await ate(() => /aria-sort="descending"[^>]*>(?:<button[^>]*>)?Gasto/.test(secao(pagina(t), 'g-sec-grupo')));
  assert.deepEqual(linhasSecao(pagina(t), 'g-sec-grupo').map((l) => l.k).slice(0, 1), ['c@g.us'], 'quem tem gasto vem antes de quem tem "—"');
  assert.equal(linhasSecao(pagina(t), 'g-sec-grupo').at(-1).k, 'sem-grupo');
  ordenar('nome'); await ate(() => /aria-sort="ascending"[^>]*>(?:<button[^>]*>)?Grupo/.test(secao(pagina(t), 'g-sec-grupo')));
  assert.deepEqual(linhasSecao(pagina(t), 'g-sec-grupo').map((l) => l.k).slice(0, 3), ['a@g.us', 'b@g.us', 'c@g.us']);
});

test('CA6: Por grupo — mais de 25 grupos: "Mostrar mais" (não paginação) e sem a linha sem grupo quando um bloco está filtrado', async () => {
  const muitos = Array.from({ length: 30 }, (_, i) => ({ jid: `g${String(i).padStart(2, '0')}@g.us`, nome: `Grupo ${i}`, blocos: [], ...linhaDin({ comissao: 1000 - i }) }));
  const t = await abrirGanhos({ din: { grupo: { ...DIN_C1('grupo'), linhas: muitos }, loja: DIN_C1('loja'), bloco: DIN_C1('bloco'), oferta: DIN_C1('oferta'), dia: DIN_C1('dia') } });
  assert.equal(linhasSecao(pagina(t), 'g-sec-grupo').filter((l) => l.k !== 'sem-grupo').length, 25);
  assert.match(pagina(t), /id="g-mais-grupo"[^>]*>Mostrar mais \(5\)/);
  t.el('#g-mais-grupo').onclick(); await ate(() => linhasSecao(pagina(t), 'g-sec-grupo').filter((l) => l.k !== 'sem-grupo').length === 30);
  assert.doesNotMatch(pagina(t), /id="g-mais-grupo"/);
  assert.equal(t.foco.at(-1), '#g-sec-grupo-titulo', 'o botão sumiu: o foco vai para o título da tabela');
  // com bloco filtrado o servidor manda nao_atribuida null: a linha não existe
  const f = tela(); preparar(f); rotasGanhos(f, { din: { grupo: { ...DIN_C1('grupo'), nao_atribuida: null, bloco: 1 }, loja: DIN_C1('loja'), bloco: DIN_C1('bloco'), oferta: DIN_C1('oferta'), dia: DIN_C1('dia') }, importacoes: IMPORTACOES() });
  f.rodar('GANHOS.bloco = "1"'); await f.rodar('paginaGanhos()');
  assert.equal(linhasSecao(pagina(f), 'g-sec-grupo').some((l) => l.k === 'sem-grupo'), false);
});

test('CA6: Por bloco, Por loja, Por oferta e Por dia mostram os valores do C1', async () => {
  const t = await abrirGanhos({ din: 'c1' }); const h = pagina(t);
  const b = linhasSecao(h, 'g-sec-bloco');
  assert.deepEqual(b.map((l) => l.k), ['1', '2']);
  assert.equal(celulaDe(b[0].html, 'Comissão'), 'R$ 10,00'); assert.equal(celulaDe(b[0].html, 'Cliques'), '190'); assert.equal(celulaDe(b[0].html, 'Ganho por clique'), 'R$ 0,0526');
  assert.equal(celulaDe(b[0].html, 'Gasto'), 'R$ 31,00'); assert.equal(celulaDe(b[0].html, 'Custo por membro novo'), 'R$ 1,24'); assert.equal(celulaDe(b[0].html, 'Retorno'), '-R$ 21,00');
  assert.equal(celulaDe(b[1].html, 'Comissão'), 'R$ 0,00');

  const l = linhasSecao(h, 'g-sec-loja');
  assert.deepEqual(l.map((x) => x.k), ['mercadolivre', 'amazon', 'shopee']);
  assert.equal(celulaDe(l[0].html, 'Loja'), 'Mercado Livre'); assert.equal(celulaDe(l[0].html, 'Ganho por clique'), '—', 'ML sem cliques importados');
  assert.equal(celulaDe(l[1].html, 'Comissão'), 'R$ 9,00'); assert.equal(celulaDe(l[1].html, 'Ganho por clique'), 'R$ 0,09'); assert.equal(celulaDe(l[1].html, 'Conversão'), '3%');
  assert.match(celulaDe(l[1].html, 'Cobertura'), /100%.*Boa/); assert.match(celulaDe(l[2].html, 'Cobertura'), /87,5%.*Parcial/); assert.equal(celulaDe(l[0].html, 'Cobertura'), '—');
  assert.equal(celulaDe(l[2].html, 'Com grupo'), '100%'); assert.equal(celulaDe(l[0].html, 'Com grupo'), '0%', 'comissão toda sem grupo: 0% de verdade');

  const o = linhasSecao(h, 'g-sec-oferta');
  assert.deepEqual(o.map((x) => x.k), ['shopee|SHOPEE:1.2', 'amazon|B0ABC12345']);
  assert.match(o[0].html, /title="Panela de pressão elétrica 6 litros"/); assert.match(celulaDe(o[0].html, 'Oferta'), /Panela de pressão/);
  assert.equal(celulaDe(o[0].html, 'Comissão'), 'R$ 5,00'); assert.equal(celulaDe(o[0].html, 'Vendas'), '2'); assert.equal(celulaDe(o[0].html, 'Grupos que enviaram'), '2');
  assert.equal(celulaDe(o[0].html, 'Loja'), 'Shopee');
  assert.match(celulaDe(o[1].html, 'Oferta'), /^Oferta B0ABC12345$/, 'sem título: "Oferta <código>"');

  const d = linhasSecao(h, 'g-sec-dia');
  assert.deepEqual(d.map((x) => x.k), ['2026-10-05', '2026-10-06']);
  assert.equal(celulaDe(d[0].html, 'Dia'), '05/10'); assert.equal(celulaDe(d[0].html, 'Comissão'), 'R$ 3,00'); assert.equal(celulaDe(d[1].html, 'Comissão'), 'R$ 0,00');
  assert.match(secao(h, 'g-sec-dia'), /<caption class="sr-only">/);
});

test('CA6: Por oferta mostra as 10 maiores e "Ver todas"', async () => {
  const muitas = Array.from({ length: 14 }, (_, i) => ({ loja: 'shopee', oferta: `SHOPEE:1.${i}`, titulo: `Oferta ${i}`, comissao: 1000 - i, comissao_confirmada: 0, receita: 0, vendas: 1, envios: 1, grupos: 1 }));
  const t = await abrirGanhos({ din: { grupo: DIN_C1('grupo'), loja: DIN_C1('loja'), bloco: DIN_C1('bloco'), oferta: { ...DIN_C1('oferta'), linhas: muitas }, dia: DIN_C1('dia') } });
  assert.equal(linhasSecao(pagina(t), 'g-sec-oferta').length, 10);
  assert.match(pagina(t), /id="g-mais-oferta"[^>]*>Ver todas \(14\)/);
  t.el('#g-mais-oferta').onclick(); await ate(() => linhasSecao(pagina(t), 'g-sec-oferta').length === 14);
  assert.equal(linhasSecao(pagina(t), 'g-sec-oferta').length, 14);
});

test('segurança/XSS por CSV: título, código, loja, bloco e grupo vindos do servidor (que os leu de um arquivo) entram sempre por esc', async () => {
  const din = { grupo: { ...DIN_C1('grupo'), linhas: [{ jid: XSS, nome: XSS, blocos: [{ id: 1, nome: XSS }], ...linhaDin({ comissao: 100 }) }] },
    loja: { ...DIN_C1('loja'), linhas: [{ loja: XSS, ...linhaDin({ comissao: 1 }), comissao_atribuida: 0, atribuida: 0 }] },
    bloco: { ...DIN_C1('bloco'), linhas: [{ bloco_id: 5, nome: XSS, grupos: 1, ...linhaDin({}) }] },
    oferta: { ...DIN_C1('oferta'), linhas: [{ loja: 'amazon', oferta: XSS, titulo: XSS, comissao: 1, comissao_confirmada: 0, receita: 0, vendas: 1, envios: 0, grupos: 0 }, { loja: XSS, oferta: 'X1', titulo: null, comissao: 1, comissao_confirmada: 0, receita: 0, vendas: 1, envios: 0, grupos: 0 }] },
    dia: DIN_C1('dia') };
  const t = await abrirGanhos({ din, importacoes: [{ ...IMPORTACOES()[0], loja: XSS, codigo_arquivo: XSS }] });
  const h = pagina(t);
  semMarcacao(h, 'dashboard'); assert.ok(h.includes(XSS_ESC));
  semMarcacao(secao(h, 'g-sec-oferta'), 'ofertas');
});

test('CA6: depois de importar mas sem nenhuma venda no recorte, "Nenhuma comissão neste período e filtro." e "Limpar filtros" volta ao padrão', async () => {
  const t = tela(); preparar(t);
  const zero = (por) => ({ ...DIN_C1(por), total: { ...TOTAL_ZERO, gasto: null }, linhas: [], nao_atribuida: { linhas: 0, comissao: 0, receita: 0, vendas: 0, cliques: 0 }, gastos_informados: 0 });
  rotasGanhos(t, { din: { grupo: zero('grupo'), loja: zero('loja'), bloco: zero('bloco'), oferta: zero('oferta'), dia: zero('dia') }, importacoes: IMPORTACOES() });
  t.rodar('GANHOS.loja = "shopee"; GANHOS.periodo = "7d"'); await t.rodar('paginaGanhos()');
  const h = pagina(t);
  assert.match(textoPagina(h), /Nenhuma comissão neste período e filtro\./);
  assert.doesNotMatch(h, /id="g-sec-grupo"/, 'sem tabelas vazias');
  assert.match(h, /id="g-limpar"[^>]*>Limpar filtros/);
  t.el('#g-limpar').onclick();
  assert.deepEqual(json(t.rodar('({ p: GANHOS.periodo, b: GANHOS.bloco, l: GANHOS.loja })')), { p: '30d', b: '', l: '' });
});

test('CA6: nunca importou nem informou gasto e não há envio: estado vazio com os 3 passos, os botões e "os links continuam saindo como hoje"', async () => {
  const t = await abrirGanhos({ cobertura: { de: 1, ate: 2, total: contas(0, 0, 0), por_loja: [], por_grupo: [] } });
  const h = pagina(t); const txt = textoPagina(h);
  assert.match(txt, /Ainda não há ganhos para mostrar/);
  assert.match(txt, /1\. Rastreie os links por grupo/); assert.match(txt, /2\. Baixe o relatório de comissões/); assert.match(txt, /3\. Informe o gasto com anúncios/);
  assert.match(h, /href="#blocos"[^>]*>Abrir Blocos de análise/); assert.match(h, /id="g-vz-importar"/); assert.match(h, /id="g-vz-gasto"/);
  assert.match(txt, /Os links continuam saindo como hoje enquanto você não configurar nada\./);
  assert.match(h, /href="#docs\/grupos\/importar"[^>]*>Como baixar o relatório de cada loja/);
  assert.doesNotMatch(h, /data-m="comissao"|g-sec-grupo/, 'no lugar de cartões e tabelas');
  assert.match(h.match(/<button[^>]*id="g-importar"[^>]*>/)[0], /^((?!pri).)*$/, 'o botão do topo vira comum: a ação principal é a do estado vazio');
  assert.match(h.match(/<button[^>]*id="g-vz-importar"[^>]*>/)[0], /class="pri"/);
  assert.match(txt, /Sem envios no período/, 'a cobertura continua dizendo isso (CA9)');
  // os botões do estado vazio abrem os mesmos diálogos
  t.el('#g-vz-importar').onclick(); await ate(() => t.el('#dlg').open);
  assert.match(t.el('#dlg').innerHTML, /Importar comissões/);
});

test('CA6: há envios rastreados mas nada importado: a cobertura aparece e os cartões de dinheiro mostram "—" com "Importe o relatório para ver"', async () => {
  const t = await abrirGanhos({ din: { ...Object.fromEntries(['grupo', 'loja', 'bloco', 'oferta', 'dia'].map((por) => [por, { ...DIN_VAZIO(), por, total: { ...TOTAL_ZERO, envios: 16 } }])) }, importacoes: [] }); const h = pagina(t);
  assert.match(textoPagina(h), /91,7%/, 'cobertura normal');
  for (const m of ['comissao', 'receita', 'vendas', 'cliques', 'epc', 'conversao', 'atribuida', 'retorno']) assert.equal(valorDe(h, m), '—', m);
  assert.match(notaDe(h, 'comissao'), /Importe o relatório para ver/);
  assert.equal(valorDe(h, 'envios'), '16', 'o que não depende de importação aparece');
  assert.doesNotMatch(h, /Ainda não há ganhos para mostrar/);
  assert.doesNotMatch(h, /R\$/);
});

test('CA6: se o dinheiro não carrega, a cobertura continua na tela e o erro tem "Tentar de novo"; a falha não vira número', async () => {
  const t = tela(); preparar(t); rotasGanhos(t, { din: 'c1' });
  let falhar = true;
  t.rotas['GET /api/ganhos'] = ({ consulta }) => (falhar ? [500, { erro: 'Não consegui concluir. Tente de novo.' }] : [200, DIN_C1(new URLSearchParams(consulta).get('por'))]);
  await t.rodar('paginaGanhos()');
  const h = pagina(t);
  assert.match(textoPagina(h), /91,7%/, 'cobertura (entrega A) segue');
  assert.match(textoPagina(h), /Não consegui carregar os valores em reais/); assert.match(h, /id="g-tentar-din"/);
  assert.doesNotMatch(h, /data-m="comissao"|R\$|NaN/);
  falhar = false;
  t.el('#g-tentar-din').onclick(); await ate(() => /data-m="comissao"/.test(pagina(t)));
  assert.equal(valorDe(pagina(t), 'comissao'), 'R$ 21,00');
});

test('CA6: o texto do Dashboard e as dicas dizem que o clique vem do relatório da loja, não do Rotacionador', async () => {
  const t = await abrirGanhos({ din: 'c1' }); const h = pagina(t);
  assert.match(notaDe(h, 'cliques'), /relatório da loja/);
  assert.doesNotMatch(cartao(h, 'cliques') + cartao(h, 'epc') + cartao(h, 'conversao'), /Rotacionador/i);
  const TIPS = json(t.rodar('TIPS'));
  for (const k of ['ganhos.cliques', 'ganhos.gpc', 'ganhos.conversao']) { assert.match(TIPS[k], /relatório/i, k); assert.doesNotMatch(TIPS[k], /do Rotacionador|no Rotacionador|pelo Rotacionador/i, k); }
  assert.doesNotMatch(TIPS.ganhos, /Por enquanto|ainda não estão/, 'o verbete da página não diz mais que só há cobertura');
  assert.match(textoPagina(h), /Como ler estes números/);
});

test('CA6/CA11: o Dono tem os botões Importar comissões e Gasto com anúncios no topo; o Operador nunca vê a página (nem pede nada)', async () => {
  const t = await abrirGanhos({ din: 'c1' }); const h = pagina(t);
  assert.match(h.match(/<button[^>]*id="g-importar"[^>]*>[^<]*/)[0], /class="pri"[^>]*>Importar comissões/);
  assert.match(h, /<button[^>]*id="g-gasto"[^>]*>Gasto com anúncios/);
  const op = await abrirGanhos({ din: 'c1' }, { usuario: operador });
  assert.equal(op.pedidos.length, 0); assert.doesNotMatch(pagina(op), /Importar comissões/);
  // as funções dos diálogos recusam o Operador em silêncio
  op.rodar('ganhosAbrirImportar()'); op.rodar('ganhosAbrirGasto()');
  await new Promise((r) => setImmediate(r));
  assert.equal(op.pedidos.length, 0); assert.equal(op.el('#dlg').open, false); assert.equal(op.el('#dlg').innerHTML, '');
});

// ------------------------------------------------------------------------------------------- Importações recentes

test('CA5/CA6: "Importações recentes" mostra data, loja, tipo e contagens (sem nome de arquivo) e apaga uma importação depois de confirmar', async () => {
  const t = await abrirGanhos({ din: 'c1' }); const h = pagina(t);
  const linhas = linhasSecao(h, 'g-sec-imp');
  assert.deepEqual(linhas.map((l) => l.k), ['12', '11']);
  const a = linhas[0].html;
  assert.match(celulaDe(a, 'Data'), /03\/11\/2026/); assert.equal(celulaDe(a, 'Loja'), 'Shopee'); assert.equal(celulaDe(a, 'Tipo'), 'Comissões');
  assert.equal(celulaDe(a, 'Lidas'), '312'); assert.equal(celulaDe(a, 'Novas'), '287'); assert.equal(celulaDe(a, 'Repetidas'), '20'); assert.equal(celulaDe(a, 'Puladas'), '5');
  const c = linhas[1].html;
  assert.equal(celulaDe(c, 'Tipo'), 'Cliques'); assert.equal(celulaDe(c, 'Repetidas'), '—', 'cliques não têm repetidas'); assert.match(celulaDe(c, 'Código do arquivo'), /casa-20/);
  assert.doesNotMatch(secao(h, 'g-sec-imp'), /\.csv/i);
  // apagar: confirma, DELETE e a página recarrega
  let apagada = false;
  t.rotas['DELETE /api/ganhos/importacoes/12'] = () => { apagada = true; return [200, { id: 12, comissoes: 287, cliques: 0 }]; };
  t.rotas['GET /api/ganhos/importacoes'] = () => [200, { importacoes: apagada ? [IMPORTACOES()[1]] : IMPORTACOES() }];
  let pergunta = ''; t.ctx.confirm = (m) => { pergunta = m; return false; };
  const apagar = (id) => t.el('#g-sec-imp').onclick({ target: { closest: () => ({ dataset: { apagarImp: id } }) } });
  await apagar('12');
  assert.equal(apagada, false, 'sem confirmar, nada é apagado'); assert.match(pergunta, /287 linhas/);
  t.ctx.confirm = () => true;
  await apagar('12');
  await ate(() => linhasSecao(pagina(t), 'g-sec-imp').length === 1);
  assert.equal(apagada, true); assert.deepEqual(linhasSecao(pagina(t), 'g-sec-imp').map((l) => l.k), ['11']);
});

// ------------------------------------------------------------------------------------------- diálogo Importar comissões

const ARQUIVO = (o = {}) => ({ name: 'comissoes-outubro.csv', size: 86016, type: 'text/csv', ...o });
const PREVIA = (o = {}) => ({ previa: true, importacao_id: null, loja: 'shopee', tipo: 'comissoes', codigo_arquivo: null, lidas: 312, novas: 287, atualizadas: 0, repetidas: 20, ignoradas: 5, linhas_ignoradas: [3, 9],
  colunas_usadas: [{ campo: 'data', coluna: 'Order Time' }, { campo: 'comissao', coluna: 'Net Commission' }, { campo: 'codigo', coluna: 'Sub_id1' }],
  colunas_ignoradas: ['Nome do comprador', 'Telefone'], periodo: { de: '2026-10-01', ate: '2026-10-31' }, comissao_centavos: 128450, cliques_total: null,
  sem_grupo: 4, codigos_desconhecidos: ['xyz'], ja_importado: false, avisos: [], ...o });
const importarCliques = (t, seletor, chave, valor) => t.el(seletor).onclick({ target: { closest: () => ({ dataset: { [chave]: valor } }) } });
const posts = (t) => t.pedidos.filter((p) => p.metodo === 'POST' && p.caminho === '/api/ganhos/importar');
/** Abre o diálogo, escolhe loja e arquivo como o navegador faria. */
async function abrirImportar(t, { loja = 'shopee', arquivo = ARQUIVO(), tipo = null, codigo = '' } = {}) {
  t.el('#g-importar').onclick(); await ate(() => t.el('#dlg').open);
  if (loja) importarCliques(t, '#imp-loja', 'loja', loja);
  if (tipo) importarCliques(t, '#imp-tipo', 'tipo', tipo);
  if (codigo) t.el('#imp-codigo').value = codigo;
  if (arquivo) { t.el('#imp-arq').files = [arquivo]; t.el('#imp-arq').onchange({}); }
}
const enviarImp = (t) => t.el('#f').onsubmit({ preventDefault() {} });

test('CA5: o diálogo abre com foco no título, "?" da ajuda, loja (radiogroup), tipo, código opcional e arquivo; o botão fica desabilitado até haver loja e arquivo', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  t.el('#g-importar').onclick(); await ate(() => t.el('#dlg').open);
  const h = t.el('#dlg').innerHTML;
  assert.match(h, /<h1 tabindex="-1">Importar comissões/); assert.match(h, /class="q"/);
  assert.equal(t.foco.at(-1), 'h1');
  assert.match(h, /id="imp-loja"[^>]*role="radiogroup"/);
  for (const [k, n] of [['shopee', 'Shopee'], ['amazon', 'Amazon'], ['mercadolivre', 'Mercado Livre']]) assert.match(h, new RegExp(`data-loja="${k}"[^>]*role="radio"[^>]*>${n}`));
  assert.match(h, /id="imp-tipo"[^>]*role="radiogroup"/); assert.match(h, /data-tipo="comissoes"/); assert.match(h, /data-tipo="cliques"/);
  assert.match(h, /<label[^>]*>[^<]*<span>Arquivo CSV do relatório[^]*?<input[^>]*type="file"[^>]*id="imp-arq"|id="imp-arq"/);
  assert.match(h, /name="imp-codigo"|id="imp-codigo"/);
  assert.match(h, /Até 5 MB/);
  assert.equal(t.el('#imp-ok').disabled, true, 'sem loja nem arquivo');
  importarCliques(t, '#imp-loja', 'loja', 'amazon'); assert.equal(t.el('#imp-ok').disabled, true, 'falta o arquivo');
  t.el('#imp-arq').files = [ARQUIVO()]; t.el('#imp-arq').onchange({}); assert.equal(t.el('#imp-ok').disabled, false);
  assert.match(t.el('#imp-info').textContent, /comissoes-outubro\.csv, 84 KB/, 'nome e tamanho do arquivo escolhido');
  assert.match(t.el('#imp-dica').textContent, /Amazon/, 'a dica muda com a loja');
  assert.equal(posts(t).length, 0, 'nada vai ao servidor só por escolher');
});

test('CA5: loja já filtrada em Ganhos vem marcada no diálogo', async () => {
  const t = tela(); preparar(t); rotasGanhos(t, { din: 'c1' }); t.rodar('GANHOS.loja = "amazon"'); await t.rodar('paginaGanhos()');
  t.el('#g-importar').onclick(); await ate(() => t.el('#dlg').open);
  assert.match(t.el('#dlg').innerHTML, /data-loja="amazon"[^>]*aria-checked="true"/);
  assert.match(t.el('#dlg').innerHTML, /data-loja="shopee"[^>]*aria-checked="false"/);
});

test('CA5/plano item 17: conferir o arquivo manda text/csv com previa=1, mostra colunas usadas e ignoradas ANTES de gravar, e só "Importar agora" grava', async () => {
  const t = await abrirGanhos({ din: 'c1' }); const arq = ARQUIVO();
  t.rotas['POST /api/ganhos/importar'] = ({ consulta }) => [200, new URLSearchParams(consulta).get('previa') === '1' ? PREVIA() : PREVIA({ previa: false, importacao_id: 13 })];
  await abrirImportar(t, { arquivo: arq });
  await enviarImp(t);
  assert.equal(posts(t).length, 1);
  const p = posts(t)[0]; const q1 = new URLSearchParams(p.consulta);
  assert.equal(p.tipo, 'text/csv', 'content-type explícito: no Windows o File.type de .csv pode ser application/vnd.ms-excel (415)');
  assert.equal(p.corpo, arq, 'o arquivo vai cru, sem ler como texto (a codificação é problema do servidor)');
  assert.equal(q1.get('loja'), 'shopee'); assert.equal(q1.get('tipo'), 'comissoes'); assert.equal(q1.get('previa'), '1'); assert.equal(q1.get('codigo'), null);
  const h = flat(t.el('#dlg').innerHTML); const txt = textoPagina(h);
  assert.match(txt, /Confira antes de importar/); assert.match(txt, /Nada foi gravado ainda/);
  assert.match(txt, /312 linhas lidas/); assert.match(txt, /287 novas/); assert.match(txt, /20 já importadas/); assert.match(txt, /5 puladas/);
  assert.match(txt, /linhas 3 e 9/, 'só os números das linhas puladas, nunca o conteúdo');
  assert.match(txt, /Período do arquivo: 01\/10 a 31\/10/); assert.match(txt, /Comissão no arquivo: R\$ 1\.284,50/);
  assert.match(txt, /Colunas lidas:[^.]*Data \(Order Time\)[^.]*Comissão \(Net Commission\)[^.]*Código de rastreio \(Sub_id1\)/);
  assert.match(txt, /Colunas ignoradas \(o painel não lê\): Nome do comprador, Telefone/);
  assert.match(txt, /Dados de comprador não são guardados/);
  assert.match(txt, /4 linhas não trazem código de rastreio ou o código não é de nenhum grupo seu\. Entram no total, mas não aparecem em nenhum grupo\./);
  assert.match(txt, /Códigos que não são de nenhum grupo seu: xyz/);
  assert.match(h, /id="imp-gravar"[^>]*>Importar agora/); assert.match(h, /id="imp-voltar"/);
  assert.equal(posts(t).length, 1, 'ainda nada foi gravado');
  // gravar: o mesmo arquivo, sem previa
  await enviarImp(t);
  assert.equal(posts(t).length, 2);
  const q2 = new URLSearchParams(posts(t)[1].consulta);
  assert.equal(q2.get('previa'), null); assert.equal(q2.get('loja'), 'shopee'); assert.equal(posts(t)[1].corpo, arq);
});

test('CA5: depois de gravar, o resumo traz o foco no título, "Ver em Ganhos" (redesenha a página com os novos números) e "Importar outro arquivo"', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  t.rotas['POST /api/ganhos/importar'] = ({ consulta }) => [200, new URLSearchParams(consulta).get('previa') === '1' ? PREVIA() : PREVIA({ previa: false, importacao_id: 13 })];
  await abrirImportar(t); await enviarImp(t); await enviarImp(t);
  const h = flat(t.el('#dlg').innerHTML); const txt = textoPagina(h);
  assert.match(txt, /Importado: Shopee/); assert.match(txt, /287 novas/); assert.match(txt, /20 já importadas e ignoradas/);
  assert.equal(t.foco.at(-1), '#imp-titulo'); assert.match(h, /id="imp-titulo"[^>]*tabindex="-1"/);
  assert.match(h, /id="imp-ver"[^>]*class="pri"[^>]*>Ver em Ganhos/); assert.match(h, /id="imp-outro"[^>]*>Importar outro arquivo/);
  assert.equal(posts(t).length, 2);
  const antes = consultasGanhos(t).length;
  await t.el('#imp-ver').onclick();
  assert.equal(t.el('#dlg').open, false);
  await ate(() => consultasGanhos(t).length >= antes + 5);
  assert.ok(consultasGanhos(t).length >= antes + 5, 'a página recarregou');
  // importar outro: volta ao formulário vazio com a loja que já estava
  const t2 = await abrirGanhos({ din: 'c1' });
  t2.rotas['POST /api/ganhos/importar'] = ({ consulta }) => [200, new URLSearchParams(consulta).get('previa') === '1' ? PREVIA() : PREVIA({ previa: false, importacao_id: 13 })];
  await abrirImportar(t2); await enviarImp(t2); await enviarImp(t2);
  t2.el('#imp-outro').onclick();
  assert.match(t2.el('#dlg').innerHTML, /id="imp-arq"/); assert.equal(t2.el('#imp-ok').disabled, true, 'arquivo novo: o botão volta desabilitado');
});

test('CA5: relatório de cliques e código do arquivo vão como tipo=cliques e codigo=…; a prévia mostra o total de cliques, não comissão', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  t.rotas['POST /api/ganhos/importar'] = () => [200, PREVIA({ tipo: 'cliques', loja: 'amazon', codigo_arquivo: 'casa-20', comissao_centavos: null, cliques_total: 1234, sem_grupo: null, codigos_desconhecidos: null, colunas_usadas: [{ campo: 'data', coluna: 'Dia' }, { campo: 'cliques', coluna: 'Cliques' }] })];
  await abrirImportar(t, { loja: 'amazon', tipo: 'cliques', codigo: ' casa-20 ' });
  await enviarImp(t);
  const q = new URLSearchParams(posts(t)[0].consulta);
  assert.equal(q.get('tipo'), 'cliques'); assert.equal(q.get('codigo'), 'casa-20', 'aparado'); assert.equal(q.get('loja'), 'amazon');
  const txt = textoPagina(t.el('#dlg').innerHTML);
  assert.match(txt, /Cliques no arquivo: 1\.234/); assert.doesNotMatch(txt, /Comissão no arquivo|não trazem código/);
});

test('CA5: "nada novo" — todas as linhas já importadas: diz que nada mudou e não oferece gravar', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  t.rotas['POST /api/ganhos/importar'] = () => [200, PREVIA({ novas: 0, atualizadas: 0, repetidas: 312, ignoradas: 0, linhas_ignoradas: [], ja_importado: true, sem_grupo: 0, codigos_desconhecidos: [], avisos: ['Este arquivo já foi importado antes. As linhas repetidas não mudam nada.'] })];
  await abrirImportar(t); await enviarImp(t);
  const h = t.el('#dlg').innerHTML; const txt = textoPagina(h);
  assert.match(txt, /Todas as 312 linhas já estavam importadas\. Nada mudou\./);
  assert.doesNotMatch(h, /id="imp-gravar"/); assert.match(h, /id="imp-voltar"/);
  assert.equal(posts(t).length, 1);
});

test('CA5: linhas atualizadas (pendente que virou confirmada) e avisos do servidor aparecem na prévia', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  t.rotas['POST /api/ganhos/importar'] = () => [200, PREVIA({ novas: 10, atualizadas: 3, repetidas: 0, avisos: ['O arquivo não tem coluna de status: as vendas entram como pendentes.'] })];
  await abrirImportar(t); await enviarImp(t);
  const txt = textoPagina(t.el('#dlg').innerHTML);
  assert.match(txt, /3 atualizadas/); assert.match(txt, /O arquivo não tem coluna de status: as vendas entram como pendentes\./);
});

test('CA5: erros de arquivo que o navegador já sabe (tamanho e tipo) saem antes de enviar, com a frase da spec; o arquivo continua escolhido', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  await abrirImportar(t, { arquivo: ARQUIVO({ size: MAX_BYTES_ARQUIVO + 1 }) });
  await enviarImp(t);
  assert.match(t.el('.erros').innerHTML, /O arquivo tem mais de 5 MB\. Baixe o relatório de um período menor \(um mês por vez\)\./);
  assert.equal(posts(t).length, 0);
  t.el('#imp-arq').files = [ARQUIVO({ name: 'relatorio.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })]; t.el('#imp-arq').onchange({});
  await enviarImp(t);
  assert.match(t.el('.erros').innerHTML, /Este arquivo não é um CSV\. Baixe o relatório do portal em CSV e tente de novo\./);
  assert.equal(posts(t).length, 0);
  assert.match(t.el('#dlg').innerHTML, /id="imp-arq"/, 'o diálogo segue aberto para trocar o arquivo');
  // .csv com tipo estranho (Windows) passa
  t.rotas['POST /api/ganhos/importar'] = () => [200, PREVIA()];
  t.el('#imp-arq').files = [ARQUIVO({ type: 'application/vnd.ms-excel' })]; t.el('#imp-arq').onchange({});
  await enviarImp(t);
  assert.equal(posts(t).length, 1, '.csv com type application/vnd.ms-excel é aceito (o servidor recebe text/csv)');
});

test('CA5: recusas do servidor (formato, tamanho, tipo, permissão) mostram a frase pronta; o arquivo e a loja continuam; "Tentar de novo" para falha de rede ou 500', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  await abrirImportar(t);
  for (const [status, erro] of [[400, 'Não encontrei a coluna de comissão (esperada: Comissão, Commission ou Ad Fees). O portal pode ter mudado o formato. Mande o arquivo de exemplo para a equipe ajustar.'],
    [413, 'O arquivo tem mais de 5 MB. Baixe o relatório de um período menor (um mês por vez).'], [415, 'Este arquivo é do Excel. Abra no Excel, salve como CSV e tente de novo.']]) {
    t.rotas['POST /api/ganhos/importar'] = () => [status, { erro }];
    await enviarImp(t);
    assert.ok(t.el('.erros').innerHTML.includes(erro.replaceAll('"', '&quot;')) || t.el('.erros').innerHTML.includes(erro), `${status}: ${t.el('.erros').innerHTML}`);
    assert.equal(t.el('#imp-ok').disabled, false, 'o dono pode tentar de novo ou trocar o arquivo');
  }
  // 403 sem frase: o texto da spec
  t.rotas['POST /api/ganhos/importar'] = () => [403, {}];
  await enviarImp(t);
  assert.match(t.el('.erros').innerHTML, /Só o Dono pode importar comissões\./);
  // 500: "Nada foi salvo" + botão vira "Tentar de novo"
  t.rotas['POST /api/ganhos/importar'] = () => [500, { erro: 'Não consegui importar agora. Nada foi salvo. Tente de novo; se repetir, veja o histórico do programa.' }];
  await enviarImp(t);
  assert.match(t.el('.erros').innerHTML, /Nada foi salvo/); assert.equal(t.el('#imp-ok').textContent, 'Tentar de novo');
  // rede caiu (fetch rejeita): a mesma frase e nenhuma importação fantasma
  t.rotas['POST /api/ganhos/importar'] = () => { throw new Error('ECONNRESET 127.0.0.1:3737'); };
  await enviarImp(t);
  assert.match(t.el('.erros').innerHTML, /Não consegui importar agora\. Nada foi salvo\./);
  assert.doesNotMatch(t.el('.erros').innerHTML, /ECONNRESET|127\.0\.0\.1/, 'a mensagem técnica não vai para a tela');
});

test('segurança/XSS por CSV: nomes de coluna, códigos desconhecidos, avisos e linhas da prévia entram por esc', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  t.rotas['POST /api/ganhos/importar'] = () => [200, PREVIA({ colunas_usadas: [{ campo: 'data', coluna: XSS }, { campo: 'comissao', coluna: XSS }], colunas_ignoradas: [XSS], codigos_desconhecidos: [XSS], avisos: [XSS], codigo_arquivo: XSS })];
  await abrirImportar(t); await enviarImp(t);
  const h = t.el('#dlg').innerHTML;
  semMarcacao(h, 'prévia'); assert.ok(h.includes(XSS_ESC));
});

test('CA5: sem loja ou sem arquivo o envio nem sai (botão desabilitado e o submit por Enter também recusa)', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  await abrirImportar(t, { loja: null, arquivo: null });
  await enviarImp(t);
  assert.equal(posts(t).length, 0);
  assert.match(t.el('.erros').innerHTML, /Escolha a loja do arquivo/);
});

test('CA5: o painel só aceita o tamanho que o servidor aceita (5 MB) e diz o mesmo número', () => {
  const t = tela();
  assert.equal(t.rodar('GANHOS_MAX_BYTES'), MAX_BYTES_ARQUIVO);
  assert.equal(MAX_BYTES_ARQUIVO, 5 * 1024 * 1024); assert.equal(MAX_LINHAS_ARQUIVO, 100_000);
  assert.equal(t.rodar('GANHOS_MAX_DIAS_GASTO'), MAX_DIAS_GASTO); assert.equal(t.rodar('GANHOS_MAX_NOTA'), MAX_NOTA);
});

// ------------------------------------------------------------------------------------------- diálogo Gasto com anúncios

const GASTO = (o = {}) => ({ id: 5, alvo_tipo: 'bloco', alvo: '1', nome_alvo: 'Casa e cozinha', inicio: '2026-10-01', fim: '2026-10-31', valor_centavos: 310000, nota: 'Meta Ads', criado_em: 1, ...o });
const gastoCampos = (t, { ini = '2026-10-01', fim = '2026-10-31', alvo = 'bloco:1', valor = '150,00', nota = '' } = {}) => {
  t.el('#gs-ini').value = ini; t.el('#gs-fim').value = fim; t.el('#gs-alvo').value = alvo; t.el('#gs-valor').value = valor; t.el('#gs-nota').value = nota;
};
const postsGasto = (t) => t.pedidos.filter((p) => p.metodo === 'POST' && p.caminho === '/api/ganhos/gastos');
async function abrirGasto(t) { t.el('#g-gasto').onclick(); await ate(() => t.el('#dlg').open); }

test('CA6: o diálogo de gasto tem período, "Vale para" (blocos e grupos, sem "todos"), valor e observação; lista os gastos com o nome do alvo; foco no título', async () => {
  const t = await abrirGanhos({ din: 'c1', gastos: [GASTO(), GASTO({ id: 6, alvo_tipo: 'grupo', alvo: 'c@g.us', nome_alvo: 'Solto', inicio: '2026-10-20', fim: '2026-11-08', valor_centavos: 200000, nota: null }), GASTO({ id: 7, alvo: '9', nome_alvo: null })] });
  await abrirGasto(t);
  const h = flat(t.el('#dlg').innerHTML);
  assert.match(h, /<h1 tabindex="-1">Gasto com anúncios/); assert.equal(t.foco.at(-1), 'h1'); assert.match(h, /class="q"/);
  assert.match(h, /id="gs-ini"[^>]*type="date"|type="date"[^>]*id="gs-ini"/); assert.match(h, /id="gs-fim"/);
  assert.match(h, /<optgroup label="Blocos">[^]*value="bloco:1"[^]*value="bloco:2"[^]*<optgroup label="Grupos">[^]*value="grupo:a@g\.us"/);
  assert.doesNotMatch(h, /Todos os grupos<\/option>/, 'o servidor não aceita gasto geral (P8)');
  assert.match(h, /id="gs-valor"[^>]*inputmode="decimal"/); assert.match(h, /id="gs-nota"[^>]*maxlength="200"/);
  assert.match(h, /repartido igualmente por dia/);
  const lista = flat(t.el('#gs-lista').innerHTML);
  assert.match(lista, /01\/10\/2026 a 31\/10\/2026/); assert.match(lista, /Casa e cozinha/); assert.match(lista, /R\$ 3\.100,00/); assert.match(lista, /Meta Ads/);
  assert.match(lista, /Solto/); assert.match(lista, /20\/10\/2026 a 08\/11\/2026/);
  assert.match(lista, /\(apagado\)|já não existe/i, 'alvo que sumiu não mostra null');
  assert.doesNotMatch(lista, /null|undefined/);
  assert.match(lista, /data-apagar-gasto="5"[^>]*>Excluir/);
  assert.doesNotMatch(lista, />Editar</, 'não há edição: apaga e lança de novo');
});

test('CA6: gasto vazio mostra "Nenhum gasto informado…"', async () => {
  const t = await abrirGanhos({ din: 'c1', gastos: [] }); await abrirGasto(t);
  assert.match(textoPagina(t.el('#gs-lista').innerHTML), /Nenhum gasto informado\. Sem ele não dá para calcular o custo por membro novo\./);
});

test('CA6: salvar o gasto manda alvo_tipo, alvo, datas, valor em CENTAVOS inteiros e a observação; atualiza a lista, avisa e recarrega a página por trás', async () => {
  const t = await abrirGanhos({ din: 'c1', gastos: [] }); await abrirGasto(t);
  const gravado = GASTO({ id: 8, valor_centavos: 123450, nota: 'Meta Ads, campanha de outubro' });
  t.rotas['POST /api/ganhos/gastos'] = () => [200, { gasto: gravado, aviso: null, gastos: [gravado] }];
  gastoCampos(t, { valor: 'R$ 1.234,50', nota: '  Meta Ads, campanha de outubro ' });
  const antes = consultasGanhos(t).length;
  await t.el('#f').onsubmit({ preventDefault() {} });
  assert.equal(postsGasto(t).length, 1);
  assert.deepEqual(json(postsGasto(t)[0].corpo), { alvo_tipo: 'bloco', alvo: '1', inicio: '2026-10-01', fim: '2026-10-31', valor_centavos: 123450, nota: 'Meta Ads, campanha de outubro' });
  assert.match(flat(t.el('#gs-lista').innerHTML), /R\$ 1\.234,50/);
  assert.match(t.el('#toast').textContent, /Gasto salvo/);
  assert.equal(t.el('#dlg').open, true, 'o diálogo fica para lançar outro ou conferir a lista');
  await ate(() => consultasGanhos(t).length >= antes + 5);
  assert.ok(consultasGanhos(t).length >= antes + 5, 'Ganhos redesenha com o gasto novo');
  // grupo: o jid vai inteiro, sem o prefixo
  gastoCampos(t, { alvo: 'grupo:a@g.us', valor: '10', nota: '' });
  await t.el('#f').onsubmit({ preventDefault() {} });
  assert.deepEqual(json(postsGasto(t)[1].corpo), { alvo_tipo: 'grupo', alvo: 'a@g.us', inicio: '2026-10-01', fim: '2026-10-31', valor_centavos: 1000, nota: null });
});

test('CA6: o aviso de gasto sobreposto do servidor aparece na tela e não bloqueia', async () => {
  const t = await abrirGanhos({ din: 'c1', gastos: [GASTO()] }); await abrirGasto(t);
  const aviso = 'Já existe gasto para este período e destino. Se for o mesmo anúncio, apague o anterior em vez de somar.';
  t.rotas['POST /api/ganhos/gastos'] = () => [200, { gasto: GASTO({ id: 9 }), aviso, gastos: [GASTO({ id: 9 }), GASTO()] }];
  gastoCampos(t); await t.el('#f').onsubmit({ preventDefault() {} });
  assert.ok(t.el('#gs-aviso').textContent.includes(aviso)); assert.equal(t.el('#gs-aviso').hidden, false);
  assert.equal(linhasGasto(t).length, 2, 'foi gravado mesmo assim');
});
const linhasGasto = (t) => [...t.el('#gs-lista').innerHTML.matchAll(/data-apagar-gasto="(\d+)"/g)].map((m) => m[1]);

test('CA6: validação do gasto na tela com as frases da spec, sem chamar o servidor (período, ordem, tamanho, alvo, valor, observação)', async () => {
  const t = await abrirGanhos({ din: 'c1', gastos: [] }); await abrirGasto(t);
  const tenta = async (campos, esperado) => {
    gastoCampos(t, campos); await t.el('#f').onsubmit({ preventDefault() {} });
    assert.ok(esperado.test(t.el('.erros').innerHTML), `${JSON.stringify(campos)} → ${t.el('.erros').innerHTML}`);
  };
  await tenta({ ini: '' }, /Escolha o período do gasto\./);
  await tenta({ fim: '' }, /Escolha o período do gasto\./);
  await tenta({ ini: '2026-10-10', fim: '2026-10-09' }, /A data final não pode ser antes da inicial\./);
  await tenta({ ini: '2025-01-01', fim: '2026-10-31' }, new RegExp(`O período do gasto vai até ${MAX_DIAS_GASTO} dias\\. Divida em partes menores\\.`));
  await tenta({ alvo: '' }, /Escolha para qual grupo ou bloco vale o gasto\./);
  await tenta({ valor: '' }, /Digite o valor em reais, por exemplo 150,00\./);
  await tenta({ valor: 'abc' }, /Digite o valor em reais, por exemplo 150,00\./);
  await tenta({ valor: '12,345' }, /Digite o valor em reais, por exemplo 150,00\./);
  await tenta({ valor: '0' }, /O valor precisa ser maior que zero\./);
  await tenta({ valor: '-5' }, /O valor precisa ser maior que zero\./);
  await tenta({ nota: 'x'.repeat(MAX_NOTA + 1) }, new RegExp(`A observação vai até ${MAX_NOTA} caracteres\\.`));
  assert.equal(postsGasto(t).length, 0, 'nada chegou ao servidor');
});

test('CA6: o servidor recusando o gasto (frase pronta) aparece na tela; o diálogo segue aberto com o que foi digitado', async () => {
  const t = await abrirGanhos({ din: 'c1', gastos: [] }); await abrirGasto(t);
  t.rotas['POST /api/ganhos/gastos'] = () => [404, { erro: 'Este bloco não existe mais.' }];
  gastoCampos(t); await t.el('#f').onsubmit({ preventDefault() {} });
  assert.match(t.el('.erros').innerHTML, /Este bloco não existe mais\./); assert.equal(t.el('#dlg').open, true);
});

test('CA6: excluir um gasto pergunta antes, manda DELETE, atualiza a lista e recarrega Ganhos', async () => {
  const t = await abrirGanhos({ din: 'c1', gastos: [GASTO(), GASTO({ id: 6, nota: null })] }); await abrirGasto(t);
  t.rotas['DELETE /api/ganhos/gastos/5'] = () => [200, { gastos: [GASTO({ id: 6, nota: null })] }];
  let pergunta = ''; t.ctx.confirm = (m) => { pergunta = m; return false; };
  const apagar = (id) => t.el('#gs-lista').onclick({ target: { closest: () => ({ dataset: { apagarGasto: id } }) } });
  await apagar('5');
  assert.equal(t.pedidos.some((p) => p.metodo === 'DELETE'), false, 'sem confirmar, não apaga'); assert.match(flat(pergunta), /R\$ 3\.100,00/);
  t.ctx.confirm = () => true;
  const antes = consultasGanhos(t).length;
  await apagar('5');
  assert.deepEqual(linhasGasto(t), ['6']);
  assert.match(t.el('#toast').textContent, /Gasto excluído/);
  await ate(() => consultasGanhos(t).length >= antes + 5);
  assert.ok(consultasGanhos(t).length >= antes + 5);
});

test('segurança/XSS: observação e nome do alvo do gasto entram por esc, e o diálogo mostra o nome de bloco/grupo escapado', async () => {
  const t = await abrirGanhos({ din: 'c1', gastos: [GASTO({ nota: XSS, nome_alvo: XSS })] }); await abrirGasto(t);
  semMarcacao(t.el('#gs-lista').innerHTML, 'lista de gastos'); assert.ok(t.el('#gs-lista').innerHTML.includes(XSS_ESC));
  const x = tela(); preparar(x);
  x.rodar(`S.groups = [{ jid: 'z@g.us', name: ${JSON.stringify(XSS)}, blocks: [] }]; S.blocks = [${JSON.stringify(bloco(3, XSS, null, ['z@g.us']))}]`);
  x.ctx.__b = [bloco(3, XSS, null, ['z@g.us'])];
  rotasGanhos(x, { din: 'c1', gastos: [] }); x.rotas['GET /api/blocks'] = () => [200, x.ctx.__b];
  await x.rodar('paginaGanhos()'); await abrirGasto(x);
  semMarcacao(x.el('#dlg').innerHTML, 'opções do diálogo');
});

test('CA6: o gasto falhando ao carregar a lista não abre o diálogo às cegas: aviso e nada na tela', async () => {
  const t = await abrirGanhos({ din: 'c1' });
  t.rotas['GET /api/ganhos/gastos'] = () => [500, { erro: 'Não consegui concluir. Tente de novo.' }];
  t.el('#g-gasto').onclick(); await ate(() => /Não consegui concluir/.test(t.el('#toast').textContent));
  assert.equal(t.el('#dlg').open, false);
});

test('leitura de valor em reais: 1.234,50, 150, 150,5, R$ 10,00 e 1234.5 viram centavos inteiros; o resto é recusado', () => {
  const t = tela();
  const lê = (v) => t.rodar(`ganhosLerReais(${JSON.stringify(v)})`);
  assert.equal(lê('1.234,50'), 123450); assert.equal(lê('150'), 15000); assert.equal(lê('150,5'), 15050); assert.equal(lê('R$ 10,00'), 1000);
  assert.equal(lê('1234.5'), 123450); assert.equal(lê('0,01'), 1); assert.equal(lê('1.234'), 123400, '1.234 sem vírgula é milhar (padrão BR)'); assert.equal(lê('  99,99 '), 9999);
  assert.equal(lê('0'), 0); assert.equal(lê('-5'), -500);
  for (const ruim of ['', 'abc', '12,345', '1,2,3', '1.2.3', '12,', ',5', 'R$', '1e5', '10 reais', '١٢٣', '999999999999,00']) assert.equal(lê(ruim), null, JSON.stringify(ruim));
  // sem arredondamento de ponto flutuante: 0,07 e 1,15 são exatos
  assert.equal(lê('0,07'), 7); assert.equal(lê('1,15'), 115); assert.equal(lê('4,35'), 435);
});

test('ajuda (B): os verbetes novos existem, o "?" de cada cartão e dos diálogos usa chave de TIPS e nenhum diz que a comissão "ainda não está"', () => {
  const t = tela(); const TIPS = json(t.rodar('TIPS'));
  for (const k of ['ganhos.comissao', 'ganhos.cliques', 'ganhos.gpc', 'ganhos.conversao', 'ganhos.custo', 'ganhos.importar', 'ganhos.gasto', 'ganhos.receita', 'ganhos.vendas', 'ganhos.envios', 'ganhos.atribuida', 'ganhos.entradas', 'ganhos.retorno']) {
    assert.ok(typeof TIPS[k] === 'string' && TIPS[k].length > 20, `TIPS.${k}`);
  }
  assert.match(TIPS['ganhos.importar'], /não guarda nome, endereço nem telefone de comprador/);
  assert.match(TIPS['ganhos.cobertura'], /Sub_id|limite/, 'a cobertura < 100% tem causa dita');
  assert.doesNotMatch(Object.values(TIPS).join(' '), /Os números de comissão ainda não estão/);
});

test('D3/D4/D5/S4: cartões principais primeiro; diálogo e confirmação com texto novo', async () => {
  const t = tela(); preparar(t); rotasGanhos(t, {});
  await t.rodar('paginaGanhos()');
  const ms = [...pagina(t).matchAll(/data-m="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ms.slice(0, 4), ['comissao', 'gasto', 'retorno', 'custo']);
  assert.equal(ms.length, 12);
  const fonte = (await import('node:fs')).readFileSync(new URL('../public/ganhos.js', import.meta.url), 'utf8');
  assert.match(fonte, /titulo: 'Importar comissões ou cliques'/);
  assert.match(fonte, /Escolha a loja e o arquivo para continuar\./);
  assert.match(fonte, /só atualizou linhas de uma importação anterior; apagá-la não desfaz essas mudanças/);
  assert.doesNotMatch(fonte, /os números voltam ao que eram antes/);
});
