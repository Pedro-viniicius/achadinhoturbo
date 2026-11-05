// QA do painel de Ganhos e rastreio (plano dashboard-ganhos, etapa 9, CA3/CA4/CA6/CA9/CA11; rodada 1 do QA): bordas e
// segurança que test/ganhos-painel.test.js (do dev) não cobre. Mesmo método dele: os scripts do painel rodam num `vm` com DOM
// falso e um fetch falso por rota; nenhuma rede, nenhum servidor, sem localStorage. A parte do servidor (403 do Operador,
// frases fixas) está em test/seguranca.test.js e test/qa-rastreio.test.js. Teste que falha aqui é bug do produto (ver
// relatório do QA): não relaxe a asserção.
// O último grupo (fumaça no Chrome headless, como test/qa-docs.test.js) sobe o painel de verdade em DRY_RUN, porta
// aleatória e DATA_DIR descartável, e é pulado sem Chrome/Chromium (CHROME_BIN ou google-chrome/chromium no PATH).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import * as rastreio from '../src/rastreio.js';

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
    const corpo = opts.body ? JSON.parse(opts.body) : null;
    pedidos.push({ metodo, caminho, consulta, corpo });
    const fn = rotas[`${metodo} ${caminho}`];
    const [status, jsonResp] = fn ? await fn({ corpo, consulta }) : [404, { erro: 'rota não prevista no teste' }];
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
function rotasGanhos(t, { cobertura = COB(), codigos = [] } = {}) {
  t.rotas['GET /api/blocks'] = () => [200, BLOCOS];
  t.rotas['GET /api/rastreio/cobertura'] = () => [200, cobertura];
  t.rotas['GET /api/rastreio/codigos'] = () => [200, { codigos }];
}
const semRastreio = (t) => t.pedidos.filter((p) => p.caminho.startsWith('/api/rastreio'));
const pagina = (t) => t.el('#pagina').innerHTML;

const campo = (t, nome, valor) => { t.el(`[name=${nome}]`).value = valor; };
const putsRastreio = (t) => t.pedidos.filter((p) => p.metodo === 'PUT' && p.caminho === '/api/rastreio/codigos');
const MARCADOS = (...jids) => jids.map((value) => ({ value }));
async function enviarBloco(t, { nome = 'Casa nova', tag_id = '', jids = ['a@g.us'] } = {}) {
  t.ctx.__campos = { name: nome, tag_id };
  t.listas['#gr input:checked'] = MARCADOS(...jids);
  await t.el('#f').onsubmit({ preventDefault() {} });
}
function rotasBloco(t, { codigos = [], idNovo = 9 } = {}) {
  t.rotas['GET /api/blocks'] = () => [200, BLOCOS];
  t.rotas['GET /api/rastreio/codigos'] = () => [200, { codigos }];
  t.rotas['POST /api/blocks'] = () => [200, { id: idNovo }];
  t.rotas['PUT /api/blocks/1'] = () => [200, {}];
  t.rotas['PUT /api/rastreio/codigos'] = () => [200, { codigos: [] }];
}
const linhasDaTabela = (h) => [...h.matchAll(/<tr><td>([^<]*)<\/td>/g)].map((m) => m[1]);

// Frases do servidor (src/rastreio.js MENSAGENS_RASTREIO), as que o painel precisa repetir ao pé da letra.
const FRASE_GRUPOS_BLOCO = 'Este bloco tem códigos de rastreio. Só o Dono pode mudar os grupos dele.';
const FRASE_APAGAR_BLOCO = 'Este bloco tem códigos de rastreio. Só o Dono pode apagá-lo.';
const FRASE_ETIQUETA = 'Esta etiqueta é código de rastreio de um grupo ou bloco. Tire a associação antes de apagá-la.';
const SO_DONO = 'Só o Dono pode fazer isso.';

// =========================================================================================== CA11 e S5

test('QG4/S5/CA11: #ganhos aberto antes do /api/state carregar não chama /api/rastreio (o Operador levaria 403 e veria uma tela de erro)', async () => {
  const t = tela({ hash: '#ganhos' });
  // o estado ainda não chegou: o painel não sabe o papel de quem está usando
  t.rotas['GET /api/blocks'] = () => [200, BLOCOS];
  t.rotas['GET /api/rastreio/cobertura'] = () => [403, { erro: SO_DONO }];
  assert.equal(t.rodar('S.st'), null, 'premissa: sem estado');
  t.rodar('ir()'); // o que o hashchange faz
  await ate(() => false, 10);
  assert.deepEqual(semRastreio(t).map((p) => `${p.metodo} ${p.caminho}`), [], 'sem saber o papel, não pode pedir dados só do Dono');
});

test('CA11: o Operador que era Dono na mesma aba (códigos ainda em memória) não vê código nenhum no formulário nem no cartão do bloco', async () => {
  const t = tela({ hash: '#blocos' });
  preparar(t, { usuario: operador, codigos: [cod('amazon', 'bloco', 1, 'casa-20'), cod('shopee', 'bloco', 1, 'segredoSub')] });
  rotasBloco(t);
  t.rodar('formBloco(S.blocks[0])');
  const h = t.el('#dlg').innerHTML;
  assert.doesNotMatch(h, /rastreio_|casa-20|segredoSub|Códigos de rastreio/, 'formulário do Operador');
  await t.rodar('paginaBlocos()');
  assert.doesNotMatch(pagina(t), /casa-20|segredoSub|Rastreio:/, 'cartão do Operador');
  assert.deepEqual(semRastreio(t), []);
  assert.doesNotMatch(t.rodar('tabelaGrupos(S.groups)'), /casa-20|Rastreio/);
});

test('CA11: o item "Ganhos" aparece quando o Operador é promovido a Dono (estado novo) e some de novo se for rebaixado', () => {
  const t = tela({ hash: '#blocos' }); preparar(t, { usuario: operador });
  t.rodar('pintarConta()');
  assert.equal(t.menu.has('#ganhos'), false);
  preparar(t, { usuario: dono });
  t.rodar('pintarConta()');
  assert.equal(t.menu.has('#ganhos'), true, 'promovido: o item entra');
  preparar(t, { usuario: operador });
  t.rodar('pintarConta()');
  assert.equal(t.menu.has('#ganhos'), false, 'rebaixado: o item sai do DOM');
});

test('CA11: 403 do servidor com frase própria (grupos de bloco com código) aparece no formulário, sem o aviso genérico e sem pedir o estado de novo', async () => {
  const t = tela({ hash: '#blocos' }); preparar(t, { usuario: operador }); rotasBloco(t);
  t.rotas['PUT /api/blocks/1'] = () => [403, { erro: FRASE_GRUPOS_BLOCO }];
  t.rodar('formBloco(S.blocks[0])');
  await enviarBloco(t, { tag_id: '7', jids: ['a@g.us'] });
  assert.ok(t.el('.erros').innerHTML.includes(FRASE_GRUPOS_BLOCO), `a frase do servidor, não outra: ${t.el('.erros').innerHTML}`);
  assert.equal(t.el('#dlg').open, true, 'o diálogo fica aberto');
  assert.notEqual(t.el('#toast').textContent, SO_DONO, 'não é o aviso genérico "Só o Dono pode fazer isso."');
  assert.equal(t.pedidos.filter((p) => p.caminho === '/api/state').length, 0, 'não é perda de papel: não redesenha a tela');
  assert.deepEqual(semRastreio(t), []);
});

test('CA11: 403 ao apagar um bloco com código mostra a frase do servidor num aviso e o bloco continua na tela', async () => {
  const t = tela({ hash: '#blocos' }); preparar(t, { usuario: operador }); rotasBloco(t);
  t.rotas['DELETE /api/blocks/1'] = () => [403, { erro: FRASE_APAGAR_BLOCO }];
  await t.rodar('paginaBlocos()');
  const botao = { dataset: { act: 'excluir' }, closest: () => ({ dataset: { id: '1' } }) };
  await t.el('#pagina').onclick({ target: { closest: (s) => (s === '[data-act]' ? botao : null) } });
  assert.equal(t.el('#toast').textContent, FRASE_APAGAR_BLOCO);
  assert.match(t.el('#toast').className, /erro/, 'aviso de erro');
  assert.equal(t.pedidos.filter((p) => p.metodo === 'GET' && p.caminho === '/api/blocks').length, 1, 'a lista não foi recarregada como se tivesse apagado');
  assert.match(pagina(t), /Casa e cozinha/);
});

test('CA11: etiqueta que é código de rastreio (400 com frase) mostra a frase pelo mesmo caminho do botão Apagar de Conexões', async () => {
  const t = tela({ hash: '#conexoes' }); preparar(t, { usuario: operador });
  t.rotas['DELETE /api/tags/7'] = () => [400, { erro: FRASE_ETIQUETA }];
  await t.rodar("tentar(async () => { await api('/tags/7', 'DELETE'); })()");
  assert.equal(t.el('#toast').textContent, FRASE_ETIQUETA);
  assert.equal(t.pedidos.length, 1, 'uma tentativa, nenhum redesenho');
});

// =========================================================================================== CA9: erros do servidor não gravam rastreio

test('CA3/CA9: se o servidor recusa o PUT do bloco (400), o rastreio NÃO é gravado, o erro aparece e o diálogo fica aberto', async () => {
  const t = tela({ hash: '#blocos' }); preparar(t, { codigos: [] }); rotasBloco(t);
  t.rotas['PUT /api/blocks/1'] = () => [400, { erro: 'Dê um nome ao bloco.' }];
  t.rodar('formBloco(S.blocks[0])');
  campo(t, 'rastreio_amazon', 'novo-20');
  await enviarBloco(t, { tag_id: '7', jids: ['a@g.us'] });
  assert.equal(putsRastreio(t).length, 0, 'bloco não salvo: associação não vai');
  assert.ok(t.el('.erros').innerHTML.includes('Dê um nome ao bloco.'));
  assert.equal(t.el('#dlg').open, true);

  const novo = tela({ hash: '#blocos' }); preparar(novo, { codigos: [] }); rotasBloco(novo);
  novo.rotas['POST /api/blocks'] = () => [400, { erro: 'Marque ao menos um grupo.' }];
  novo.rodar('formBloco()');
  campo(novo, 'rastreio_shopee', 'casa');
  await enviarBloco(novo);
  assert.equal(putsRastreio(novo).length, 0, 'bloco novo não criado: nenhum PUT de rastreio com alvo inventado');
});

test('CA3: se os códigos não carregaram (500), o Dono edita o bloco sem o fieldset, vê o aviso e nada de rastreio é gravado nem apagado', async () => {
  const t = tela({ hash: '#blocos' }); preparar(t); rotasBloco(t);
  t.rotas['GET /api/rastreio/codigos'] = () => [500, { erro: 'Não consegui concluir. Tente de novo.' }];
  await t.rodar('paginaBlocos()');
  assert.match(pagina(t), /Casa e cozinha/, 'a lista de blocos aparece mesmo sem os códigos');
  assert.doesNotMatch(pagina(t), /Rastreio:/, 'nada de "padrão de cada loja" quando não sei');
  t.rodar('formBloco(S.blocks[0])');
  const h = t.el('#dlg').innerHTML;
  assert.doesNotMatch(h, /rastreio_/);
  assert.match(h, /Não consegui carregar os códigos de rastreio agora/);
  await enviarBloco(t, { tag_id: '7', jids: ['a@g.us', 'b@g.us'] });
  assert.equal(putsRastreio(t).length, 0);
  assert.ok(t.pedidos.some((p) => p.metodo === 'PUT' && p.caminho === '/api/blocks/1'), 'o resto do bloco salva normalmente');
});

// =========================================================================================== XSS pelos códigos

test('segurança: códigos de rastreio com HTML e aspas viram texto no formulário do bloco, no do grupo e na célula de Grupos', () => {
  const t = tela({ hash: '#blocos' });
  preparar(t, { codigos: [cod('amazon', 'bloco', 1, XSS), cod('shopee', 'bloco', 1, XSS), cod('mercadolivre', 'bloco', 1, XSS), cod('amazon', 'grupo', 'c@g.us', XSS), cod('mercadolivre', 'grupo', 'c@g.us', XSS)] });
  t.rodar('formBloco(S.blocks[0])');
  const bloco = t.el('#dlg').innerHTML;
  semMarcacao(bloco, 'formulário do bloco');
  assert.ok(bloco.includes(`name="rastreio_amazon" value="${XSS_ESC}"`), 'o valor não escapa do atributo');
  assert.ok(bloco.includes(`name="rastreio_shopee" value="${XSS_ESC}"`));
  t.rodar('rastreioFormGrupo("c@g.us")');
  const grupo = t.el('#dlg').innerHTML;
  semMarcacao(grupo, 'diálogo do grupo');
  assert.ok(grupo.includes(`name="rastreio_amazon" value="${XSS_ESC}"`));
  semMarcacao(t.rodar('tabelaGrupos(S.groups)'), 'tabela de grupos');
});

test('segurança: loja e grupo desconhecidos na resposta da cobertura (texto do servidor) são escapados na página Ganhos', async () => {
  const t = tela(); preparar(t);
  const cob = COB();
  cob.por_loja.push({ loja: XSS, ...contas(10, 10, 2) });
  cob.por_grupo.push({ jid: XSS, ...contas(10, 10, 2) });
  rotasGanhos(t, { cobertura: cob });
  await t.rodar('paginaGanhos()');
  const h = pagina(t);
  semMarcacao(h, 'página Ganhos');
  assert.ok(h.includes(XSS_ESC), 'o texto aparece, escapado');
});

// =========================================================================================== CA6: números e níveis na tela

test('CA6: "Atenção" só para loja abaixo de 80% (80,0% não leva; 79,5% leva) e cada loja mostra o nível pela palavra', async () => {
  const t = tela(); preparar(t);
  const cob = COB();
  cob.por_loja = [{ loja: 'mercadolivre', ...contas(10, 10, 8) }, { loja: 'amazon', ...contas(200, 200, 159) }, { loja: 'shopee', ...contas(10, 10, 9) }];
  rotasGanhos(t, { cobertura: cob });
  await t.rodar('paginaGanhos()');
  const h = pagina(t);
  const avisos = [...h.matchAll(/<b>Atenção\.<\/b> Parte dos links de ([^<]+?) saiu/g)].map((m) => m[1]);
  assert.deepEqual(avisos, ['Amazon'], '79,5% leva o aviso; 80% e 90% não');
  assert.match(h, /Mercado Livre<\/b> 80% <span class="estado-pill pendente">Parcial/, '80% é Parcial, e não Atenção');
  assert.match(h, /Amazon<\/b> 79,5% <span class="estado-pill pendente">Parcial/);
  assert.match(h, /Shopee<\/b> 90% <span class="estado-pill conectado">Boa/);
  const baixa = tela(); preparar(baixa);
  const c2 = COB(); c2.por_loja = [{ loja: 'shopee', ...contas(100, 100, 59) }, { loja: 'amazon', ...contas(100, 100, 60) }];
  rotasGanhos(baixa, { cobertura: c2 });
  await baixa.rodar('paginaGanhos()');
  assert.match(pagina(baixa), /Shopee<\/b> 59% <span class="estado-pill erro">Baixa/);
  assert.match(pagina(baixa), /Amazon<\/b> 60% <span class="estado-pill pendente">Parcial/);
});

test('CA6: grupo sem envio esperado (cobertura null) aparece com "—", sem nível e depois dos que têm número; os menos cobertos vêm primeiro', async () => {
  const t = tela(); preparar(t);
  const cob = COB();
  cob.por_grupo = [{ jid: 'm1@g.us', ...contas(10, 10, 9) }, { jid: 'n1@g.us', ...contas(4, 0, 0) }, { jid: 'b1@g.us', ...contas(10, 10, 3) }, { jid: 'c1@g.us', ...contas(10, 10, 10) }];
  rotasGanhos(t, { cobertura: cob });
  await t.rodar('paginaGanhos()');
  const h = pagina(t);
  assert.deepEqual(linhasDaTabela(h), ['b1@g.us', 'm1@g.us', 'c1@g.us', 'n1@g.us']);
  const nulo = h.match(/<tr><td>n1@g\.us<\/td>[^]*?<\/tr>/)[0];
  assert.match(nulo, /—/); assert.doesNotMatch(nulo, /0%|Boa|Parcial|Baixa|NaN/, 'null nunca vira 0% nem ganha nível');
});

test('CA6: mais de 25 grupos: 25 linhas e "Mostrar mais (N)"; o botão mostra todos', async () => {
  const t = tela(); preparar(t);
  const cob = COB();
  cob.por_grupo = Array.from({ length: 30 }, (_, i) => ({ jid: `g${String(i).padStart(2, '0')}@g.us`, ...contas(100, 100, 100 - i) }));
  rotasGanhos(t, { cobertura: cob });
  await t.rodar('paginaGanhos()');
  assert.equal(linhasDaTabela(pagina(t)).length, 25);
  assert.equal(linhasDaTabela(pagina(t))[0], 'g29@g.us', 'o menos coberto primeiro');
  assert.match(pagina(t), /Mostrar mais \(5\)/);
  t.el('#g-mais').onclick();
  await ate(() => linhasDaTabela(pagina(t)).length === 30);
  assert.equal(linhasDaTabela(pagina(t)).length, 30);
  assert.doesNotMatch(pagina(t), /Mostrar mais/);
});

test('CA6: respostas fora de ordem — a resposta antiga de um filtro trocado não sobrescreve a da escolha mais recente', async () => {
  const t = tela(); preparar(t);
  const fila = [];
  t.rotas['GET /api/blocks'] = () => [200, BLOCOS];
  t.rotas['GET /api/rastreio/cobertura'] = ({ consulta }) => new Promise((ok) => fila.push({ consulta, ok }));
  const p1 = t.rodar('paginaGanhos()'); // 30 dias
  t.rodar("GANHOS.periodo = 'mes'");
  const p2 = t.rodar('paginaGanhos()'); // mês atual
  await ate(() => fila.length === 2);
  assert.match(fila[0].consulta, /periodo=30d/); assert.match(fila[1].consulta, /periodo=mes/);
  fila[1].ok([200, COB()]); await p2;
  const velha = COB(); velha.total = contas(10, 10, 5);
  fila[0].ok([200, velha]); await p1;
  assert.match(pagina(t), /91,7%/, 'vale o filtro mais recente');
  assert.doesNotMatch(pagina(t), /50%/, 'a resposta velha não apareceu');
});

test('CA6: o painel que sai de #ganhos enquanto carrega não redesenha a página antiga por cima da nova', async () => {
  const t = tela({ hash: '#ganhos' }); preparar(t);
  const fila = [];
  t.rotas['GET /api/blocks'] = () => [200, BLOCOS];
  t.rotas['GET /api/rastreio/cobertura'] = () => new Promise((ok) => fila.push(ok));
  const p = t.rodar('paginaGanhos()');
  await ate(() => fila.length === 1);
  t.ctx.location.hash = '#visao'; // o usuário foi para outra página
  t.el('#pagina').innerHTML = '<h1>Outra página</h1>';
  fila[0]([200, COB()]); await p;
  assert.equal(pagina(t), '<h1>Outra página</h1>');
});

// =========================================================================================== coluna Rastreio de Grupos

test('QG3/CA3/CA4: depois de salvar um bloco novo com código, a coluna Rastreio de Grupos mostra "Do bloco" para o grupo dele (sem recarregar a página)', async () => {
  const t = tela({ hash: '#blocos' }); preparar(t, { codigos: [] });
  // S.groups veio no carregamento da página: 'c@g.us' ainda não estava em bloco nenhum
  const novoBloco = bloco(9, 'Solto e feliz', null, ['c@g.us']);
  t.rotas['GET /api/blocks'] = () => [200, [...BLOCOS, novoBloco]];
  // servidor real: o PUT grava e o GET seguinte devolve o que foi gravado (sem isso o teste dependeria do atalho RASTREIO.fresco)
  let gravados = [];
  t.rotas['GET /api/rastreio/codigos'] = () => [200, { codigos: gravados }];
  t.rotas['POST /api/blocks'] = () => [200, { id: 9 }];
  t.rotas['PUT /api/rastreio/codigos'] = () => { gravados = [cod('amazon', 'bloco', 9, 'solto-20')]; return [200, { codigos: gravados }]; };
  t.rodar('formBloco()');
  campo(t, 'rastreio_amazon', 'solto-20');
  await enviarBloco(t, { nome: 'Solto e feliz', jids: ['c@g.us'] });
  await ate(() => /Solto e feliz/.test(pagina(t)));
  assert.equal(t.rodar('S.blocks.some((b) => b.id === 9)'), true, 'premissa: a lista de blocos está atualizada');
  const linha = t.rodar('tabelaGrupos(S.groups)').match(/<tr data-jid="c@g\.us">[^]*?<\/tr>/)[0];
  assert.match(linha, /Do bloco/, 'o grupo está num bloco com código: dizer "Padrão" engana o Dono sobre o link que sai');
  assert.doesNotMatch(linha, />Padrão</);
});

test('QG3/CA3/CA4: grupo tirado do bloco com código deixa de aparecer como "Do bloco" na coluna Rastreio, sem recarregar a página', async () => {
  const t = tela({ hash: '#blocos' }); preparar(t, { codigos: [cod('amazon', 'bloco', 1, 'casa-20')] });
  // 'a@g.us' estava no bloco 1 quando a página carregou; o Dono o tira do bloco e salva
  const semA = { ...BLOCOS[0], group_jids: ['b@g.us'], grupos: [{ jid: 'b@g.us', name: 'b@g.us' }] };
  rotasBloco(t, { codigos: [cod('amazon', 'bloco', 1, 'casa-20')] });
  t.rotas['GET /api/blocks'] = () => [200, [semA, BLOCOS[1]]];
  t.rodar('formBloco(S.blocks[0])');
  await enviarBloco(t, { nome: 'Casa e cozinha', tag_id: '7', jids: ['b@g.us'] });
  await ate(() => t.pedidos.filter((p) => p.caminho === '/api/blocks' && p.metodo === 'GET').length >= 1 && t.rodar('S.blocks[0].group_jids.length') === 1);
  const linha = t.rodar('tabelaGrupos(S.groups)').match(/<tr data-jid="a@g\.us">[^]*?<\/tr>/)[0];
  assert.match(linha, />Padrão</, 'o grupo A não está mais em bloco nenhum');
});

// =========================================================================================== fumaça no Chrome headless

function acharChrome() {
  const candidatos = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const c of candidatos) {
    if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; continue; }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) { const f = path.join(dir, c); if (fs.existsSync(f)) return f; }
  }
  return null;
}
const CHROME = acharChrome();
const NAV = { skip: CHROME ? false : 'sem Chrome/Chromium (defina CHROME_BIN): a fumaça de Ganhos no navegador real foi pulada', timeout: 90000 };
const pastas = []; const filhos = [];
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const livre = () => new Promise((ok, falha) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); s.on('error', falha); });
const encerrar = async (filho) => {
  if (!filho || filho.exitCode != null || filho.signalCode != null) return;
  const saiu = new Promise((r) => filho.once('exit', r));
  try { process.kill(-filho.pid, 'SIGKILL'); } catch { try { filho.kill('SIGKILL'); } catch { /* já saiu */ } }
  await Promise.race([saiu, dorme(3000)]);
};
after(async () => { for (const f of filhos) await encerrar(f); for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });

/** Painel de verdade, simulado e sem login. `semear(db)` roda antes de subir (o banco é descartável). */
async function subirPainel(semear) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-qaganhos-')); pastas.push(dir);
  if (semear) { const db = openDb(dir); semear(db); db.close(); }
  const porta = await livre();
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
  return { base: `http://127.0.0.1:${porta}`, filho, dir };
}

async function subirChrome() {
  const curto = fs.mkdtempSync(path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : '/tmp', 'qaganhos-')); pastas.push(curto);
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

/** Aba com o driver CDP mínimo (WebSocket global do Node 22). */
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
  await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Log.enable'); await cmd('Page.bringToFront');
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
  const clicar = async (sel) => {
    const pos = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (!pos) throw new Error('sem elemento para clicar: ' + sel);
    const [x, y] = pos;
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const erros = () => eventos
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
    .map((e) => JSON.stringify(e.params).slice(0, 300))
    .filter((x) => !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(x)); // sem rede, as fontes do Google falham de propósito
  return { id: alvo.id, cmd, js, esperar, clicar, erros, fechar: async () => { try { ws.close(); await fetch(`http://127.0.0.1:${chrome.porta}/json/close/${alvo.id}`); } catch { /* já fechou */ } } };
}

let chrome;
before(async () => { if (CHROME) chrome = await subirChrome(); }, { timeout: 60000 });
const PRONTO = "!!document.querySelector('#pagina .grade-vg')"; // Visão Geral desenhada
async function abaNoPainel(t, painel, hash) {
  const p = await abrirAba(chrome, painel.base + '/#visao');
  t.after(() => p.fechar());
  await p.esperar(PRONTO, 15000, 'painel carregado');
  await p.js(`location.hash = ${JSON.stringify(hash)}`);
  return p;
}
/** Preenche um campo do diálogo como quem digita (dispara input para a prévia atualizar). */
const digitar = (p, sel, valor) => p.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(valor)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

test('CA6/CA10: #ganhos num painel sem nenhum envio: item no menu, "Sem envios no período", sem erro de console e sem 0% inventado', NAV, async (t) => {
  const painel = await subirPainel();
  const p = await abaNoPainel(t, painel, '#ganhos');
  await p.esperar("document.querySelector('#pagina h1')?.textContent.startsWith('Ganhos') && /Sem envios no período/.test(document.querySelector('#pagina').textContent)", 10000, 'página Ganhos vazia');
  assert.equal(await p.js("document.querySelector('#rail nav a[href=\"#ganhos\"]')?.textContent"), 'Ganhos');
  assert.equal(await p.js("document.querySelector('#rail nav a[aria-current=\"page\"]')?.textContent"), 'Ganhos');
  const texto = await p.js("document.querySelector('#pagina').textContent");
  assert.doesNotMatch(texto, /NaN|undefined|null|0%/);
  // Entrega B (etapa 17): o "Em breve" saiu; no lugar entra o estado vazio da spec (3 passos) com os botões de importar e gasto
  assert.doesNotMatch(texto, /Em breve/);
  assert.match(texto, /Ainda não há ganhos para mostrar/);
  assert.match(texto, /Os links continuam saindo como hoje enquanto você não configurar nada/);
  assert.equal(await p.js("document.querySelectorAll('#pagina .g-vazio .passo').length"), 3, 'os 3 passos da spec');
  assert.equal(await p.js("document.querySelector('#g-vz-importar')?.textContent"), 'Importar comissões');
  assert.equal(await p.js("document.querySelector('#g-vz-gasto')?.textContent"), 'Gasto com anúncios');
  assert.deepEqual(p.erros(), []);
});

test('CA3/CA4/CA6: no navegador real, o Dono associa códigos a um bloco e a um grupo e a página Ganhos mostra a cobertura semeada (Boa, Baixa, "—", Atenção)', NAV, async (t) => {
  const agora = Date.now();
  const painel = await subirPainel((db) => {
    for (const [jid, nome] of [['111@g.us', 'Achados'], ['222@g.us', 'Casa']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, agora);
    db.prepare("INSERT INTO tags (name, created_at) VALUES ('achados', 1)").run();
    const env = db.prepare('INSERT INTO rastreio_envios (ts, jid, loja, origem, link, codigo, nivel, esperado, motivo) VALUES (?,?,?,?,?,?,?,?,?)');
    const h = agora - 3600_000;
    for (let i = 0; i < 3; i++) env.run(h, '111@g.us', 'amazon', 'manual', 'https://amzn.to/x', 'casa-20', 'bloco', 1, null);
    env.run(h, '111@g.us', 'shopee', 'manual', 'https://s.shopee.com.br/a', 'casa', 'bloco', 1, null);
    env.run(h, '111@g.us', 'shopee', 'manual', 'https://s.shopee.com.br/b', null, 'nenhum', 1, 'limite_shopee');
    for (let i = 0; i < 2; i++) env.run(h, '222@g.us', 'mercadolivre', 'regra', 'https://meli.la/x', null, 'padrao', 0, null);
  });
  const p = await abaNoPainel(t, painel, '#blocos');
  const api = (caminho) => p.js(`fetch('/api${caminho}').then((r) => r.json())`);

  // novo bloco com Amazon e Shopee pelo formulário
  await p.esperar("!!document.querySelector('#novo')", 8000, 'página Blocos');
  await p.clicar('#novo');
  await p.esperar("!!document.querySelector('#dlg [name=rastreio_amazon]')", 8000, 'fieldset do bloco');
  assert.equal(await p.js("document.querySelector('#dlg details.rastreio').open"), false, 'fechado quando vazio');
  await digitar(p, '#dlg [name=name]', 'Casa e cozinha');
  await p.clicar('#dlg #gr input[value="111@g.us"]');
  await p.js("document.querySelector('#dlg details.rastreio').open = true");
  await digitar(p, '#dlg [name=rastreio_amazon]', 'casa-20');
  await digitar(p, '#dlg [name=rastreio_shopee]', 'casa');
  assert.match(await p.js("document.querySelector('#dlg [data-previa]').textContent"), /Amazon: usa casa-20\. Shopee: usa o Sub_id casa\./);
  await p.clicar('#dlg .rodape .pri');
  await p.esperar("!document.querySelector('#dlg').open", 8000, 'diálogo fechado');
  const codigos = (await api('/rastreio/codigos')).codigos.map((c) => `${c.loja}:${c.alvo_tipo}:${c.codigo}`).sort();
  assert.deepEqual(codigos, ['amazon:bloco:casa-20', 'shopee:bloco:casa']);
  await p.esperar("/Rastreio:[^]*Amazon[^]*casa-20/.test(document.querySelector('#pagina').textContent)", 8000, 'cartão do bloco com o rastreio');

  // exceção por grupo (sem Shopee). Recarrega a página: sem isso a coluna usa a lista de grupos em memória (ver os testes QG3 acima)
  await p.js("location.hash = '#visao'"); await dorme(100);
  await p.js('location.reload()');
  await p.esperar(PRONTO, 15000, 'painel recarregado');
  await p.js("location.hash = '#grupos'");
  await p.esperar("!!document.querySelector('[data-rastreio=\"222@g.us\"]')", 8000, 'botão Definir do grupo Casa');
  assert.match(await p.js("document.querySelector('tr[data-jid=\"111@g.us\"]').textContent"), /Do bloco/);
  await p.clicar('[data-rastreio="222@g.us"]');
  await p.esperar("!!document.querySelector('#dlg [name=rastreio_amazon]')", 8000, 'diálogo do grupo');
  assert.equal(await p.js("document.querySelector('#dlg [name=rastreio_shopee]')"), null, 'P6: nada de Sub_id no grupo');
  await digitar(p, '#dlg [name=rastreio_amazon]', 'casa-solta-20');
  await p.clicar('#dlg .rodape .pri');
  await p.esperar("!document.querySelector('#dlg').open", 8000, 'diálogo do grupo fechado');
  await p.esperar("/casa-solta-20/.test(document.querySelector('tr[data-jid=\"222@g.us\"]')?.textContent || '')", 8000, 'selo do grupo na tabela');
  assert.ok((await api('/rastreio/codigos')).codigos.some((c) => c.alvo_tipo === 'grupo' && c.alvo === '222@g.us' && c.codigo === 'casa-solta-20'));

  // a mesma etiqueta duas vezes: o servidor recusa e o painel mostra a frase
  await p.clicar('[data-rastreio="111@g.us"]');
  await p.esperar("!!document.querySelector('#dlg [name=rastreio_amazon]')", 8000, 'diálogo do grupo 111');
  await digitar(p, '#dlg [name=rastreio_amazon]', 'casa-solta-20');
  await p.clicar('#dlg .rodape .pri');
  await p.esperar("/Este código já está associado a outro grupo ou bloco\./.test(document.querySelector('#dlg .erros')?.textContent || '')", 8000, 'frase do servidor no diálogo');
  assert.equal(await p.js("document.querySelector('#dlg').open"), true, 'o diálogo fica aberto');
  await p.clicar('#dlg #cancelar');

  // a página Ganhos com a cobertura semeada: total 4 de 5 esperados = 80% (Parcial); Amazon 100%; Shopee 50% (Baixa + Atenção); ML sem esperado ("—")
  await p.js("location.hash = '#ganhos'");
  await p.esperar("/Cobertura do rastreio/.test(document.querySelector('#pagina')?.textContent || '') && /Achados/.test(document.querySelector('#pagina').textContent)", 10000, 'cobertura desenhada');
  const texto = await p.js("document.querySelector('#pagina').textContent.replace(/\\s+/g, ' ')");
  assert.match(texto, /80% dos links com rastreio configurado saíram com o código \(4 de 5 links\)\. Parcial/);
  assert.match(texto, /Mercado Livre 2 envios, nenhum com código configurado/);
  assert.match(texto, /Amazon 100% Boa/);
  assert.match(texto, /Shopee 50% Baixa/);
  assert.match(texto, /Atenção\. Parte dos links da Shopee saiu sem Sub_id\. Confira se a extensão está na versão 1\.4\.1 ou mais nova/);
  assert.doesNotMatch(texto, /Atenção\. Parte dos links de (Amazon|Mercado Livre)/);
  assert.doesNotMatch(texto, /NaN|undefined|\bnull\b/);
  assert.equal(await p.js("[...document.querySelectorAll('#pagina tbody tr')].map((r) => r.cells[0].textContent).join('|')"), 'Achados|Casa', 'tabela por grupo, o menos coberto primeiro, com nomes e não JIDs');

  // filtro por bloco e por loja chega à tela (só o grupo do bloco)
  await p.clicar('#g-blc [data-b]:not([data-b=""])');
  await p.esperar("document.querySelectorAll('#pagina tbody tr').length === 1", 8000, 'só o grupo do bloco');
  await p.clicar('#g-loja [data-loja="amazon"]');
  await p.esperar("/100%/.test(document.querySelector('#pagina .cob-card')?.textContent || '') && !/Shopee/.test(document.querySelector('#pagina .cob-lojas')?.textContent || '')", 8000, 'filtro por loja');
  // o único erro de console esperado é o 400 provocado de propósito (código repetido); qualquer outro é falha da tela
  const inesperados = p.erros().filter((e) => !/status of 400.*\/api\/rastreio\/codigos/.test(e));
  assert.deepEqual(inesperados, [], 'nenhum erro de console no percurso inteiro');
});

// =========================================================================================== Entrega B no Chrome headless

/** Escolhe o arquivo no `input type=file` do diálogo como o navegador faz (sem disco), disparando `change`. */
const escolherArquivo = (p, nome, texto) => p.js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(texto)}], ${JSON.stringify(nome)}, { type: 'text/csv' })); const i = document.querySelector('#imp-arq'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return i.files.length; })()`);
const norm = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();
const celula = (p, secao, chave, coluna) => p.js(`(() => { const th = [...document.querySelectorAll('#${secao} thead th')].findIndex((h) => h.textContent.trim().startsWith(${JSON.stringify(coluna)})); const tr = document.querySelector('#${secao} tbody tr[data-k="${chave}"]'); return tr && th >= 0 ? tr.cells[th].textContent.replace(/\\s+/g, ' ').trim() : null; })()`);

test('CA5/CA6: no navegador real, o Dono confere e importa o CSV de comissões e o de cliques pelo diálogo, o Dashboard mostra os valores certos, o título malicioso fica como texto, e apagar a importação desfaz', NAV, async (t) => {
  const dia = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const agora = Date.now();
  const painel = await subirPainel((db) => {
    for (const [jid, nome] of [['111@g.us', 'Achados'], ['222@g.us', 'Casa']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, agora);
    db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (1, 'Casa e cozinha', 1)").run();
    for (const jid of ['111@g.us', '222@g.us']) db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (1, ?)').run(jid);
    rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: '1', codigo: 'casa' });
    for (const jid of ['111@g.us', '222@g.us']) {
      rastreio.registrar(db, { ts: agora - 5 * 86400000, jid, loja: 'shopee', origem: 'manual', link: 'https://s.shopee.com.br/x', codigo: 'casa', nivel: 'bloco', bloco_id: 1, esperado: 1, oferta_chave: 'SHOPEE:1.2' });
    }
  });
  const p = await abaNoPainel(t, painel, '#ganhos');
  await p.esperar("!!document.querySelector('#g-importar')", 10000, 'página Ganhos com o botão de importar');
  await p.js('window.confirm = () => true; window.__xss = 0'); // o confirm nativo trava o navegador sem cabeça

  // 1) comissões da Shopee: conferir (não grava) → importar agora
  const XSS = '<img src=x onerror="window.__xss=1">';
  const comissoes = ['ID do pedido,Status do pedido,Hora do pedido,ID da loja,ID do item,Nome do item,Qtd,Valor de compra(R$),Comissão total do item(R$),Sub_id1,Nome do comprador,Telefone do comprador',
    `QAP1,Concluído,${dia(2)} 10:00:00,1,2,Garrafa inventada,1,"50,00","3,00",casa,Fulana de Teste,(31) 90000-0001`,
    `QAP2,Pendente,${dia(3)} 11:00:00,1,2,Garrafa inventada,1,"40,00","2,00",casa,Beltrano de Teste,(31) 90000-0002`,
    `QAP3,Concluído,${dia(2)} 12:00:00,1,3,"${XSS.replaceAll('"', '""')}",1,"20,00","1,00",outro,Ciclano de Teste,(31) 90000-0003`].join('\r\n');
  await p.clicar('#g-importar');
  await p.esperar("!!document.querySelector('#dlg #imp-arq')", 8000, 'diálogo de importar');
  assert.equal(await p.js("document.querySelector('#dlg #imp-ok').disabled"), true, 'sem loja e arquivo o botão fica desabilitado');
  await p.clicar('#dlg #imp-loja [data-loja="shopee"]');
  await escolherArquivo(p, 'comissoes-outubro.csv', comissoes);
  await p.esperar("/comissoes-outubro\\.csv, /.test(document.querySelector('#dlg #imp-info').textContent)", 5000, 'nome e tamanho do arquivo');
  assert.equal(await p.js("document.querySelector('#dlg #imp-ok').disabled"), false);
  await p.clicar('#dlg #imp-ok');
  await p.esperar("!!document.querySelector('#dlg #imp-gravar')", 8000, 'prévia');
  let dlg = norm(await p.js("document.querySelector('#dlg').textContent"));
  assert.match(dlg, /Nada foi gravado ainda/);
  assert.match(dlg, /3 linhas lidas/);
  assert.match(dlg, /3 novas/);
  assert.match(dlg, /Comissão no arquivo: R\$ 6,00 \(sem as canceladas\)/);
  assert.match(dlg, /Colunas ignoradas \(o painel não lê\): [^.]*Nome do comprador[^.]*Telefone do comprador/);
  for (const pessoa of ['Fulana', 'Beltrano', 'Ciclano', '90000']) assert.ok(!dlg.includes(pessoa), `a prévia mostrou "${pessoa}"`);
  assert.deepEqual(await p.js("fetch('/api/ganhos/importacoes').then((r) => r.json())"), { importacoes: [] }, 'a prévia não gravou nada');
  await p.clicar('#dlg #imp-gravar');
  await p.esperar("/Importado: Shopee/.test(document.querySelector('#dlg').textContent)", 8000, 'resumo de sucesso');
  assert.equal(await p.js("document.activeElement?.id"), 'imp-titulo', 'o foco vai para o título do resumo');
  assert.match(norm(await p.js("document.querySelector('#dlg').textContent")), /3 novas/);

  // 2) cliques: "Importar outro arquivo", tipo Cliques, código do arquivo vazio
  await p.clicar('#dlg #imp-outro');
  await p.esperar("!!document.querySelector('#dlg #imp-tipo')", 5000, 'formulário de novo');
  await p.clicar('#dlg #imp-loja [data-loja="shopee"]');
  await p.clicar('#dlg #imp-tipo [data-tipo="cliques"]');
  await escolherArquivo(p, 'cliques.csv', ['Data,Sub_id1,Cliques', `${dia(2)},casa,100`, `${dia(2)},outro,20`].join('\r\n'));
  await p.clicar('#dlg #imp-ok');
  await p.esperar("!!document.querySelector('#dlg #imp-gravar')", 8000, 'prévia dos cliques');
  assert.match(norm(await p.js("document.querySelector('#dlg').textContent")), /Cliques no arquivo: 120/);
  await p.clicar('#dlg #imp-gravar');
  await p.esperar("/Importado: Shopee/.test(document.querySelector('#dlg').textContent)", 8000, 'resumo dos cliques');
  await p.clicar('#dlg #imp-ver');
  await p.esperar("!document.querySelector('#dlg').open && /6,00/.test(document.querySelector('#pagina [data-m=comissao] .valor')?.textContent || '')", 10000, 'Ganhos redesenhado com a comissão importada');

  // o Dashboard: 3 vendas (3,00 + 2,00 + 1,00), só 4,00 confirmados; 120 cliques; EPC 6,00/120; B1 ficou com 5,00 e o `outro` sem grupo
  const kpi = (m) => p.js(`(() => { const e = document.querySelector('#pagina [data-m="${m}"] .valor'); return e && e.textContent.replace(/\\s+/g, ' ').trim(); })()`);
  assert.equal(await kpi('comissao'), 'R$ 6,00');
  assert.match(norm(await p.js("document.querySelector('#pagina [data-m=comissao] .nota').textContent")), /Confirmada: R\$ 4,00/);
  assert.equal(await kpi('vendas'), '3');
  assert.equal(await kpi('cliques'), '120');
  assert.equal(await kpi('epc'), 'R$ 0,05');
  assert.equal(await kpi('conversao'), '2,5%');
  assert.equal(await kpi('gasto'), '—', 'sem gasto informado');
  assert.equal(await celula(p, 'g-sec-bloco', '1', 'Comissão'), 'R$ 5,00');
  assert.equal(await celula(p, 'g-sec-bloco', '1', 'Cliques'), '100');
  assert.equal(await celula(p, 'g-sec-grupo', 'sem-grupo', 'Comissão'), 'R$ 1,00', 'o Sub_id `outro` não é de grupo nenhum');
  assert.equal(await celula(p, 'g-sec-loja', 'shopee', 'Comissão'), 'R$ 6,00');
  // o título vindo do arquivo é texto: nada de <img> na página e o onerror nunca rodou
  assert.equal(await p.js("document.querySelectorAll('#pagina img').length"), 0, 'título do CSV não virou marcação');
  assert.equal(await p.js('window.__xss'), 0);
  assert.ok((await p.js("document.querySelector('#g-sec-oferta').textContent")).includes('<img src=x onerror="window.__xss=1">'), 'o texto cru aparece como texto');
  // importações recentes: as duas, com "Apagar"
  assert.equal(await p.js("document.querySelectorAll('#g-sec-imp tbody tr').length"), 2);

  // 3) apagar a importação de comissões (a de cliques fica): a comissão volta a zero e os cliques continuam
  const idComissoes = await p.js("[...document.querySelectorAll('#g-sec-imp tbody tr')].find((r) => /Comissões/.test(r.textContent))?.dataset.k");
  await p.clicar(`#g-sec-imp [data-apagar-imp="${idComissoes}"]`);
  await p.esperar("document.querySelectorAll('#g-sec-imp tbody tr').length === 1", 8000, 'importação apagada');
  assert.equal(await kpi('comissao'), 'R$ 0,00');
  assert.equal(await kpi('cliques'), '120');
  const dados = await p.js("fetch('/api/ganhos/importacoes').then((r) => r.json())");
  assert.deepEqual(dados.importacoes.map((i) => [i.tipo, i.linhas]), [['cliques', 2]]);
  assert.deepEqual(p.erros(), [], 'nenhum erro de console no percurso inteiro');
});

test('CA5: no navegador real, arquivo errado (XLSX, grande demais, sem coluna de comissão) mostra a frase pronta, mantém o arquivo e não grava nada', NAV, async (t) => {
  const painel = await subirPainel();
  const p = await abaNoPainel(t, painel, '#ganhos');
  await p.esperar("!!document.querySelector('#g-vz-importar')", 10000, 'estado vazio');
  await p.clicar('#g-vz-importar');
  await p.esperar("!!document.querySelector('#dlg #imp-arq')", 8000, 'diálogo');
  await p.clicar('#dlg #imp-loja [data-loja="amazon"]');
  // arquivo sem coluna de comissão: o servidor recusa com a frase fixa, sem repetir o conteúdo
  await escolherArquivo(p, 'relatorio.csv', 'Nome do comprador,Valor\r\nFulana-Secreta,10');
  await p.clicar('#dlg #imp-ok');
  await p.esperar("/Não encontrei a coluna de comissão/.test(document.querySelector('#dlg').textContent)", 8000, 'frase do servidor');
  assert.ok(!(await p.js("document.querySelector('#dlg').textContent")).includes('Fulana-Secreta'));
  assert.match(await p.js("document.querySelector('#dlg #imp-info').textContent"), /relatorio\.csv/, 'o arquivo continua escolhido');
  // XLSX disfarçado de .csv (PK\x03\x04): o servidor diz que é do Excel
  await p.js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])], 'x.csv', { type: 'text/csv' })); const i = document.querySelector('#imp-arq'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await p.clicar('#dlg #imp-ok');
  await p.esperar("/Este arquivo é do Excel/.test(document.querySelector('#dlg').textContent)", 8000, 'frase do Excel');
  // .xlsx e arquivo acima de 5 MB nem saem do navegador
  await p.js(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['a'], 'planilha.xlsx', { type: 'application/vnd.ms-excel' })); const i = document.querySelector('#imp-arq'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await p.clicar('#dlg #imp-ok');
  await p.esperar("/Este arquivo não é um CSV/.test(document.querySelector('#dlg').textContent)", 5000, 'frase de tipo (local)');
  await p.js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'grande.csv', { type: 'text/csv' })); const i = document.querySelector('#imp-arq'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await p.clicar('#dlg #imp-ok');
  await p.esperar("/O arquivo tem mais de 5 MB/.test(document.querySelector('#dlg').textContent)", 5000, 'frase de tamanho (local)');
  assert.deepEqual(await p.js("fetch('/api/ganhos/importacoes').then((r) => r.json())"), { importacoes: [] });
  assert.deepEqual(p.erros().filter((e) => !/status of (400|415)/.test(e)), [], 'só os 400/415 provocados de propósito aparecem no console');
});

test('CA6: em 375 px o Dashboard com dados (nome de grupo e título sem espaço, cartões e tabelas) não cria rolagem horizontal da página', NAV, async (t) => {
  const dia = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const agora = Date.now();
  const longo = 'ÓtimaOfertaSuperPromocionalSemEspacoNenhum'.repeat(4);
  const painel = await subirPainel((db) => {
    for (const [jid, nome] of [['111@g.us', `Grupo ${longo}`], ['222@g.us', 'Casa'], ['333@g.us', 'Solto']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, agora);
    db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (1, ?, 1)").run(`Bloco ${longo}`);
    for (const jid of ['111@g.us', '222@g.us']) db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (1, ?)').run(jid);
    db.prepare("INSERT INTO importacoes (id, loja, tipo, arquivo_sha256, codigo_arquivo, lidas, novas, atualizadas, ignoradas, criado_em) VALUES (1, 'shopee', 'comissoes', ?, ?, 3, 3, 0, 0, ?)").run('a'.repeat(64), longo.slice(0, 90), agora);
    db.prepare("INSERT INTO comissoes (loja, chave, data, codigo, produto, titulo, quantidade, venda_centavos, comissao_centavos, status, importacao_id, atualizado_em) VALUES ('shopee', 'k1', ?, 'casa', 'SHOPEE:1.2', ?, 1, 123456789, 98765432, 'confirmada', 1, 1)").run(dia(2), longo.slice(0, 190));
    db.prepare("INSERT INTO cliques_loja (loja, dia, codigo, cliques, importacao_id) VALUES ('shopee', ?, 'casa', 1234567, 1)").run(dia(2));
    rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: '1', codigo: 'casa' });
    rastreio.registrar(db, { ts: agora - 5 * 86400000, jid: '111@g.us', loja: 'shopee', origem: 'manual', link: 'https://s.shopee.com.br/x', codigo: 'casa', nivel: 'bloco', bloco_id: 1, esperado: 1, oferta_chave: 'SHOPEE:1.2' });
  });
  const p = await abaNoPainel(t, painel, '#ganhos');
  await p.cmd('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
  await p.esperar("/R\\$\\s*987\\.654,32/.test(document.querySelector('#pagina [data-m=comissao] .valor')?.textContent || '')", 10000, 'Dashboard com os números grandes');
  const medidas = await p.js('({ largura: window.innerWidth, pagina: document.documentElement.scrollWidth })');
  assert.ok(medidas.pagina <= medidas.largura + 1, `a página rola na horizontal: ${JSON.stringify(medidas)}`);
  // prova de que a medida enxerga o problema: um elemento largo de propósito faz a página passar da tela
  const comLargo = await p.js("(() => { const d = document.createElement('div'); d.id = 'qa-largo'; d.style.cssText = 'width:2000px;height:1px'; document.querySelector('#pagina').appendChild(d); const w = document.documentElement.scrollWidth; d.remove(); return w; })()");
  assert.ok(comLargo > 1500, `a medida não detecta rolagem (${comLargo})`);
  assert.deepEqual(p.erros(), []);
});

test('CA6/D1: em 375 px nenhuma célula das tabelas .tab-din corta o texto (Custo por membro novo "—" e com valor, Cobertura por loja com dados importados)', NAV, async (t) => {
  const dia = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const agora = Date.now();
  const longo = 'ÓtimaOfertaSuperPromocionalSemEspacoNenhum'.repeat(3);
  const painel = await subirPainel((db) => {
    for (const [jid, nome] of [['111@g.us', `Grupo ${longo}`], ['222@g.us', 'Casa'], ['333@g.us', 'Solto sem gasto']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, agora);
    db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (1, ?, 1)").run(`Bloco ${longo}`);
    db.prepare("INSERT INTO blocks (id, name, created_at) VALUES (2, 'Bloco sem gasto', 1)").run();
    for (const jid of ['111@g.us', '222@g.us']) db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (1, ?)').run(jid);
    db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (2, ?)').run('333@g.us');
    db.prepare("INSERT INTO importacoes (id, loja, tipo, arquivo_sha256, codigo_arquivo, lidas, novas, atualizadas, ignoradas, criado_em) VALUES (1, 'shopee', 'comissoes', ?, NULL, 3, 3, 0, 0, ?)").run('a'.repeat(64), agora);
    const com = db.prepare("INSERT INTO comissoes (loja, chave, data, codigo, produto, titulo, quantidade, venda_centavos, comissao_centavos, status, importacao_id, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, 1, 123456789, 98765432, 'confirmada', 1, 1)");
    com.run('shopee', 'k1', dia(2), 'casa', 'SHOPEE:1.2', longo.slice(0, 120));
    com.run('amazon', 'k2', dia(2), 'turbo-20', 'ASIN:B0TESTE001', 'Fone');
    com.run('mercadolivre', 'k3', dia(2), 'geral', 'MLB1', 'Outra');
    rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: '1', codigo: 'casa' });
    rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: '1', codigo: 'turbo-20' });
    const env = (jid, loja, codigo, nivel, esperado, bloco) => rastreio.registrar(db, { ts: agora - 3 * 86400000, jid, loja, origem: 'manual', link: `https://exemplo.invalid/${loja}`, codigo, nivel, bloco_id: bloco, esperado, oferta_chave: 'MLB1' });
    env('111@g.us', 'shopee', 'casa', 'bloco', 1, 1); env('222@g.us', 'shopee', null, 'padrao', 1, 1);
    env('111@g.us', 'amazon', 'turbo-20', 'bloco', 1, 1); env('333@g.us', 'mercadolivre', null, 'nenhum', 0, null);
    // gasto do grupo grande e do bloco 1 (com entradas); o grupo 333 e o bloco 2 ficam sem gasto → "—"
    const gasto = db.prepare('INSERT INTO gastos_anuncio (alvo_tipo, alvo, inicio, fim, valor_centavos, criado_em) VALUES (?,?,?,?,?,?)');
    gasto.run('bloco', '1', dia(20), dia(1), 876543210, 1); gasto.run('grupo', '111@g.us', dia(20), dia(1), 123456789, 1);
    for (let i = 0; i < 12; i++) db.prepare("INSERT INTO group_events (ts, jid, participant, action) VALUES (?, '111@g.us', ?, 'add')").run(agora - 2 * 86400000 + i, `p-${i}`);
  });
  const p = await abaNoPainel(t, painel, '#ganhos');
  await p.cmd('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
  await p.esperar("/2\\.962\\.962,96/.test(document.querySelector('#pagina [data-m=comissao] .valor')?.textContent || '') && !!document.querySelector('#g-sec-loja td[data-rot=Cobertura]')", 10000, 'Dashboard com dados e a tabela Por loja');
  // abre tudo o que é recolhido e mostra as linhas todas (a medida vale para o que o dono vê ao rolar a página)
  await p.js("document.querySelectorAll('#pagina details').forEach((d) => { d.open = true; })");
  const medir = (seletor) => p.js(`(() => [...document.querySelectorAll(${JSON.stringify(seletor)})].map((c) => ({ rot: c.dataset.rot || c.tagName, texto: c.textContent.trim().slice(0, 40), sw: c.scrollWidth, cw: c.clientWidth, esq: Math.round(c.getBoundingClientRect().left), dir: Math.round(c.getBoundingClientRect().right), tela: window.innerWidth })))()`);
  // cortado = o conteúdo passa do que a célula mostra OU a célula sai da tela (cai na rolagem interna da tabela)
  const cortadas = (cels) => cels.filter((c) => c.sw > c.cw + 1 || c.dir > c.tela + 1 || c.esq < -1);
  for (const [secao, rot] of [['g-sec-grupo', 'Custo por membro novo'], ['g-sec-bloco', 'Custo por membro novo'], ['g-sec-loja', 'Cobertura']]) {
    const alvo = await medir(`#${secao} td[data-rot="${rot}"]`);
    assert.ok(alvo.length >= 2, `${secao}: esperava células "${rot}" na tela, vieram ${alvo.length}`);
    assert.deepEqual(cortadas(alvo), [], `${secao}: texto cortado em "${rot}"`);
    if (rot === 'Custo por membro novo') {
      assert.ok(alvo.some((c) => c.texto === '—'), `${secao}: precisava de uma célula "—" para medir`);
      assert.ok(alvo.some((c) => /R\$/.test(c.texto)), `${secao}: precisava de uma célula com valor para medir`);
    } else assert.ok(alvo.some((c) => /%/.test(c.texto)) && alvo.some((c) => c.texto === '—'), `${secao}: precisava de Cobertura com número e com "—"`);
  }
  const caixas = await medir('.tab-din');
  assert.ok(caixas.length >= 4, `tabelas .tab-din na tela: ${caixas.length}`);
  assert.deepEqual(cortadas(caixas), [], 'uma tabela .tab-din rola na horizontal por dentro em 375 px');
  const todas = await medir('.tab-din tbody td, .tab-din tfoot td');
  assert.ok(todas.length > 20, `poucas células medidas: ${todas.length}`);
  assert.deepEqual(cortadas(todas), [], 'alguma célula das tabelas corta o texto em 375 px');
  const pagina = await p.js('({ largura: window.innerWidth, pagina: document.documentElement.scrollWidth })');
  assert.ok(pagina.pagina <= pagina.largura + 1, `a página rola na horizontal: ${JSON.stringify(pagina)}`);
  // prova de que a medida enxerga corte: texto sem quebra numa célula faz scrollWidth passar de clientWidth
  const corte = await p.js("(() => { const c = document.querySelector('#g-sec-bloco td[data-rot=\"Custo por membro novo\"]'); c.style.cssText = 'white-space:nowrap;overflow:hidden;width:20px;display:block'; c.textContent = 'R$ 1.234.567.890,12'; const r = c.scrollWidth > c.clientWidth; return r; })()");
  assert.equal(corte, true, 'a medida não detecta texto cortado');
  assert.deepEqual(p.erros(), []);
});
