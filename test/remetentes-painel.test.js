// Painel do Remetente (plano envio-pelo-socio, etapa 7): cartões em Disparo automático, formulário "Novo remetente"
// com a máscara de telefone BR e a visão Remetente do Histórico (public/remetentes.js, com as ligações em app.js e
// espelhamento.js). espelhamento.js, remetentes.js e app.js rodam juntos, na ordem do index.html, num `vm` com um DOM
// mínimo e um fetch falso por rota: nenhuma rede, nenhum servidor. Foco em CA1 (campos e erros do servidor), CA11
// (contadores, último link e problema) e CA12 (todo texto do servidor escapado; o Operador vê sem os botões de escrita).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fonte = (arq) => fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');

// Texto hostil vindo do servidor (título, nome do grupo, nome do remetente, motivo, erro do WhatsApp)
const XSS = '<img src=x onerror=alert(1)>"\'&';
const XSS_ESC = '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;';
/** Nenhuma tag nova nem atributo on* saiu do texto do servidor (os atributos são lidos um a um, não por busca no texto). */
function semMarcacao(html, onde) {
  for (const [, tag, attrs] of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    assert.ok(!/^(img|script|iframe|svg)$/i.test(tag), `${onde}: tag <${tag}> vinda do texto\n${html}`);
    for (const [, nome] of attrs.matchAll(/([^\s=/]+)(?:="[^"]*")?/g)) assert.ok(!/^on/i.test(nome), `${onde}: atributo ${nome} na tag <${tag}>\n${html}`);
  }
}

/**
 * Carrega espelhamento.js, remetentes.js e app.js com DOM falso. Os utilitários de disparos.js e ajuda.js (q,
 * dispSegHtml, dispLigarSeg) são falsos. `rotas`: 'METODO /api/caminho' → (pedido) → [status, json].
 * `campos`: os controles do formulário (form.elements.namedItem); `marcados`: os jids que o seletor de grupos devolve.
 */
function tela() {
  const reg = new Map(); const pedidos = []; const rotas = {}; const campos = {}; const estado = { marcados: [] };
  const novo = (sel) => {
    const e = {
      sel, textContent: '', value: '', hidden: false, disabled: false, checked: false, open: false, className: '', dataset: {}, style: {}, attrs: {},
      classes: new Set(),
      classList: { add(c) { e.classes.add(c); }, remove(c) { e.classes.delete(c); }, toggle(c, f) { if (f ?? !e.classes.has(c)) e.classes.add(c); else e.classes.delete(c); }, contains: (c) => e.classes.has(c) },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
      hasAttribute(k) { return k in this.attrs; },
      querySelector: (s) => el(s), querySelectorAll: (s) => qsa(s), addEventListener() {}, appendChild() {}, insertAdjacentHTML() {}, remove() {},
      focus() {}, scrollIntoView() {}, contains: (x) => x != null && x === ctx.document.activeElement && !!ctx.__focoDentro, closest: () => null, showModal() { this.open = true; }, close() { this.open = false; },
      _html: '',
    };
    Object.defineProperty(e, 'innerHTML', { configurable: true,
      get() { return this._html; },
      // trocar o HTML do dialog recria os elementos de dentro dele (como o navegador)
      set(v) { this._html = String(v); if (sel === '#dlg') for (const k of [...reg.keys()]) if (!['#dlg', '#pagina', '#toast', '#lista'].includes(k)) reg.delete(k); },
    });
    if (sel === '#f-rem') e.elements = { namedItem: (n) => campos[n] ?? null };
    return e;
  };
  const el = (s) => { if (!reg.has(s)) reg.set(s, novo(s)); return reg.get(s); };
  const qsa = (s) => (s === '#s-gr input:checked' ? estado.marcados.map((value) => ({ value, checked: true })) : []);
  const ctx = {
    console, URLSearchParams,
    document: { querySelector: el, querySelectorAll: qsa, addEventListener() {}, createElement: () => novo('criado'), activeElement: null, body: {} },
    location: { hash: '#disparo-automatico', replace() {} },
    history: { replaceState(_a, _b, h) { ctx.location.hash = h; } },
    addEventListener() {}, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    confirm: (m) => { ctx.__confirmacoes.push(String(m)); return true; }, __confirmacoes: [],
    q: (k) => `<span class="q" data-k="${k}"></span>`,
    dispSegHtml: (id, itens, atual) => `<div class="seg" id="${id}">${itens.map(([v, r]) => `<button type="button" data-v="${v}" aria-checked="${v === atual}">${r}</button>`).join('')}</div>`,
    dispLigarSeg() {},
    // a carga inicial do app.js (carregar: /state, /tags…) fica sem resposta: nem tela inicial nem toast no meio do teste
    __fetch: () => new Promise(() => {}),
  };
  ctx.fetch = (url, opts) => ctx.__fetch(url, opts);
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fonte('espelhamento.js'), ctx, { filename: 'public/espelhamento.js' });
  vm.runInContext(fonte('remetentes.js'), ctx, { filename: 'public/remetentes.js' });
  vm.runInContext(fonte('app.js'), ctx, { filename: 'public/app.js' });
  ctx.__fetch = async (url, opts = {}) => {
    const metodo = opts.method || 'GET'; const [caminho, consulta = ''] = String(url).split('?');
    const corpo = opts.body ? JSON.parse(opts.body) : null;
    pedidos.push({ metodo, caminho, consulta, corpo });
    const fn = rotas[`${metodo} ${caminho}`];
    const [status, json] = fn ? await fn({ corpo, consulta }) : [404, { erro: 'rota não prevista no teste' }];
    return { status, ok: status < 400, json: async () => json };
  };
  const rodar = (c) => vm.runInContext(c, ctx);
  return { ctx, el, reg, pedidos, rotas, rodar, campos, estado };
}
const ate = async (cond, n = 80) => { for (let i = 0; i < n && !cond(); i++) await new Promise((r) => setImmediate(r)); return cond(); };
const json = (x) => JSON.parse(JSON.stringify(x));
const st = (papel = 'dono') => ({ usuario: { id: 1, papel, nome: 'Pedro', email: 'p@x' }, auth: true, whatsapp: { status: 'open' }, extensao: { online: true }, ajustes: { link_mode: 'extension' }, catalogo: {} });
/** Põe S.st, S.rules, S.templates, S.tags, S.groups e S.blocks. */
function preparar(t, { papel = 'dono', rules = [], templates = [{ id: 1, name: 'Padrão', body: '{TITULO} {LINK}' }, { id: 2, name: 'Sem link', body: '{TITULO}' }],
  tags = [{ id: 7, name: 'achadosmenicas' }], groups = [{ jid: 'a@g.us', name: 'Grupo A', size: 10 }, { jid: 'b@g.us', name: 'Grupo B', size: 5 }],
  blocks = [{ id: 3, name: 'Bloco 1', group_jids: ['a@g.us'] }] } = {}) {
  Object.assign(t.ctx, { __st: st(papel), __rules: rules, __tpls: templates, __tags: tags, __groups: groups, __blocks: blocks });
  t.rodar('S.st = __st; S.rules = __rules; S.templates = __tpls; S.tags = __tags; S.groups = __groups; S.blocks = __blocks;');
}

// ---------- como GET /api/remetentes e GET /api/remetentes/itens devolvem (plano, "Esquema e contratos") ----------
const remetente = (extra = {}) => ({
  id: 4, nome: 'Sócio João', numero: '+55 35 •••••-1234', enabled: true, destino_jids: ['a@g.us', 'b@g.us'], destinos_nomes: ['Grupo A', 'Grupo B'],
  template_id: 1, template_nome: 'Padrão', tag_id: null, etiqueta_nome: null, enviar_foto: true, max_por_hora: 10, dedupe_horas: 24, responder: true,
  problema: null, contadores_24h: { recebidos: 5, enviados: 4, repetidos: 1, descartados: 0, com_erro: 0 }, ultimo_em: null, ...extra,
});
const lista = (rems = [remetente()]) => ({ remetentes: rems, totais_24h: { recebidos: 7, enviados: 5, repetidos: 1, descartados: 1, com_erro: 0 } });
const item = (extra = {}) => ({
  id: 31, remetente_id: 4, remetente_nome: 'Sócio João', ts: 1_000, loja: 'mercadolivre', status: 'enviado', codigo: null, motivo: null, fonte_dados: 'api',
  oferta: { title: 'Fone JBL', price: 99.9 }, destinos: [{ nome: 'Grupo A', ok: true, erro: null }], decidido_em: 2_000, ...extra,
});

// =========================================================================================== números de telefone

test('máscara BR ao digitar: celular, fixo, +55 colado, parcial e fora do formato', () => {
  const t = tela();
  const m = (v) => t.rodar(`mascaraTelefoneBR(${JSON.stringify(v)})`);
  assert.equal(m('35999991234'), '(35) 99999-1234');
  assert.equal(m('+55 (35) 99999-1234'), '(35) 99999-1234');
  assert.equal(m('55 35 99999 1234'), '(35) 99999-1234');
  assert.equal(m('3533331234'), '(35) 3333-1234');
  assert.equal(m('553533331234'), '(35) 3333-1234');
  assert.equal(m(''), '');
  assert.equal(m('3'), '(3');
  assert.equal(m('359'), '(35) 9');
  assert.equal(m('359999'), '(35) 9999');
  assert.equal(m('3599999'), '(35) 9999-9');
  // DDD 55 sem o código do país continua sendo DDD 55 (só 12 ou 13 dígitos perdem o 55)
  assert.equal(m('55999991234'), '(55) 99999-1234');
  // mais dígitos que um número BR: fica como está, sem cortar (a validação avisa)
  assert.equal(m('35999991234567'), '35999991234567');
});

test('validação BR (a mesma do servidor): 10 ou 11 dígitos, DDD de 11 a 99 e, com 11, o terceiro dígito é 9', () => {
  const t = tela();
  const ok = (v) => t.rodar(`telefoneBRValido(digitosBR(${JSON.stringify(v)}))`);
  for (const v of ['35999991234', '3533331234', '+55 35 99999-1234', '(11) 98765-4321', '5511987654321']) assert.equal(ok(v), true, v);
  for (const v of ['35899991234', '0599999123', '1099991234', '359999912', '359999912345', '', 'abc', '55359999912345']) assert.equal(ok(v), false, v);
  assert.equal(t.rodar('digitosBR("+55 (35) 99999-1234")'), '35999991234');
});

test('número do servidor (mascararNumero) vira "(35) •••••-1234" e o leitor de tela ouve "número terminado em 1234"', () => {
  const t = tela();
  assert.equal(t.rodar('remNumeroTela("+55 35 •••••-1234")'), '(35) •••••-1234');
  assert.equal(t.rodar('remNumeroTela("+55 35 ••••-1234")'), '(35) ••••-1234');
  assert.equal(t.rodar('remNumeroTela("+•••••••••-1234")'), '+•••••••••-1234'); // fora do padrão BR: como veio
  const html = t.rodar('remNumeroHtml("+55 35 •••••-1234")');
  assert.match(html, /<span aria-hidden="true">\(35\) •••••-1234<\/span>/);
  assert.match(html, /<span class="sr-only">número terminado em 1234<\/span>/);
});

// =========================================================================================== cartão (CA11, CA12)

test('CA12: o cartão escapa nome do remetente, nome do grupo, template, número e problema vindos do servidor', () => {
  const t = tela(); preparar(t);
  t.ctx.__r = remetente({
    nome: `Sócio ${XSS}`, destino_jids: ['a@g.us'], destinos_nomes: [`Grupo ${XSS}`], template_nome: `Tpl ${XSS}`, numero: `+55 35 •••••-1234${XSS}`,
    problema: { nivel: 'aviso', texto: `Falta ${XSS}`, conexao: true },
  });
  const html = t.rodar('cartaoRemetente(__r, true)');
  semMarcacao(html, 'cartão');
  for (const s of [`Sócio ${XSS_ESC}`, `Grupo ${XSS_ESC}`, `Tpl ${XSS_ESC}`, `Falta ${XSS_ESC}`]) assert.ok(html.includes(s), `${s}\n${html}`);
  assert.match(html, /aria-label="Remetente ativo: Sócio &lt;img/);
  assert.match(html, /aria-label="Editar remetente Sócio &lt;img/);
  assert.match(html, /aria-label="Excluir remetente Sócio &lt;img/);
  assert.match(html, /<span class="chip">Remetente<\/span>/);
});

test('CA11: o cartão mostra os contadores de 24 h, o último link e o resumo (grupos, template, limite)', () => {
  const t = tela(); preparar(t);
  const hoje = new Date(); hoje.setHours(14, 32, 0, 0);
  t.ctx.__r = remetente({ ultimo_em: hoje.getTime() });
  const html = t.rodar('cartaoRemetente(__r, true)');
  assert.match(html, /Últimas 24 h: 5 links recebidos, 4 enviados, 1 repetido\./);
  assert.match(html, /Último link: hoje, 14:32\./);
  assert.match(html, /Para 2 grupos\./);
  assert.match(html, /Template: Padrão\./);
  assert.match(html, /Até 10 links por hora\./);
  assert.match(html, /\(35\) •••••-1234/);
  assert.match(html, /<button class="pri" data-act="rem-registro">Ver registro<\/button>/);
  // um grupo só: o nome (com title), não a contagem
  t.ctx.__r = remetente({ destino_jids: ['a@g.us'], destinos_nomes: ['Grupo A'] });
  assert.match(t.rodar('cartaoRemetente(__r, true)'), /Para o grupo “<span class="nome-grupo" title="Grupo A">Grupo A<\/span>”\./);
  // descartes e erros entram quando existem; singular e plural
  t.ctx.__r = remetente({ contadores_24h: { recebidos: 1, enviados: 0, repetidos: 0, descartados: 2, com_erro: 1 } });
  assert.match(t.rodar('cartaoRemetente(__r, true)'), /Últimas 24 h: 1 link recebido, 0 enviados, 2 descartados, 1 com erro\./);
  // sem atividade
  t.ctx.__r = remetente({ contadores_24h: { recebidos: 0, enviados: 0, repetidos: 0, descartados: 0, com_erro: 0 } });
  assert.match(t.rodar('cartaoRemetente(__r, true)'), /Ainda não recebeu links\./);
  // pausado
  t.ctx.__r = remetente({ enabled: false });
  const pausado = t.rodar('cartaoRemetente(__r, true)');
  assert.match(pausado, /Pausado\./);
  assert.doesNotMatch(pausado, /data-act="rem-ligar" checked/);
});

test('CA11: o problema real vem do servidor, com "!" textual, a classe do nível e o link para Conexões só quando pedido', () => {
  const t = tela(); preparar(t);
  t.ctx.__r = remetente({ problema: { nivel: 'aviso', texto: 'Os links do Mercado Livre não saem: falta a etiqueta.', conexao: true } });
  const aviso = t.rodar('cartaoRemetente(__r, true)');
  assert.match(aviso, /<p class="nivel-aviso aviso-cartao" role="status"><b>!<\/b> Os links do Mercado Livre não saem: falta a etiqueta\./);
  assert.match(aviso, /href="#conexoes"/);
  t.ctx.__r = remetente({ problema: { nivel: 'erro', texto: 'O número saiu do grupo Grupo B. Edite o remetente.', conexao: false } });
  const erro = t.rodar('cartaoRemetente(__r, true)');
  assert.match(erro, /<p class="nivel-erro aviso-cartao" role="status"><b>!<\/b> O número saiu do grupo Grupo B\./);
  assert.doesNotMatch(erro, /href="#conexoes"/);
  // modo direto: aviso de afiliação que se resolve em Ajustes, com conexao null (sem link para Conexões)
  t.ctx.__r = remetente({ problema: { nivel: 'aviso', texto: 'Os links do Mercado Livre estão no modo direto.', conexao: null } });
  const direto = t.rodar('cartaoRemetente(__r, true)');
  assert.match(direto, /<p class="nivel-aviso aviso-cartao" role="status"><b>!<\/b> Os links do Mercado Livre estão no modo direto\./);
  assert.doesNotMatch(direto, /href="#conexoes"/);
  // Magalu sem a loja de parceiro (integracao-magalu, etapa 5): a frase do servidor, no mesmo lugar e com o link
  t.ctx.__r = remetente({ problema: { nivel: 'aviso', texto: 'Os links da Magalu não saem: falta o nome da sua loja de parceiro. Cadastre em Conexões.', conexao: 'magalu' } });
  const magalu = t.rodar('cartaoRemetente(__r, true)');
  assert.match(magalu, /<p class="nivel-aviso aviso-cartao" role="status"><b>!<\/b> Os links da Magalu não saem: falta o nome da sua loja de parceiro\. Cadastre em Conexões\./);
  assert.match(magalu, /href="#conexoes"/);
  t.ctx.__r = remetente({ problema: null });
  assert.doesNotMatch(t.rodar('cartaoRemetente(__r, true)'), /aviso-cartao/);
});

test('CA12: o Operador vê o cartão sem Editar, Excluir nem a chave de ligar (o servidor também responde 403)', () => {
  const t = tela(); preparar(t, { papel: 'operador' });
  t.ctx.__r = remetente();
  const op = t.rodar('cartaoRemetente(__r, false)');
  assert.doesNotMatch(op, /data-act="rem-editar"|data-act="rem-excluir"/);
  assert.match(op, /<input type="checkbox" data-act="rem-ligar" checked disabled/);
  assert.match(op, /data-act="rem-registro"/);
  assert.match(op, /Só o Dono altera os remetentes\./);
  // cartoesRemetentes decide pelo papel de S.st
  t.ctx.__l = [remetente()]; t.rodar('REM.lista = __l;');
  assert.doesNotMatch(t.rodar('cartoesRemetentes()'), /rem-editar/);
  preparar(t, { papel: 'dono' });
  assert.match(t.rodar('cartoesRemetentes()'), /rem-editar/);
});

// =========================================================================================== Disparo automático (app.js)

test('Disparo automático: botão "Novo remetente" no topo (só o Dono), texto do .sub e os cartões depois dos outros tipos', async () => {
  const t = tela(); preparar(t);
  t.rotas['GET /api/espelhos'] = () => [200, { espelhos: [], totais_24h: {} }];
  t.rotas['GET /api/remetentes'] = () => [200, lista()];
  t.rodar('paginaRegras()');
  const topo = t.el('#pagina').innerHTML;
  assert.match(topo, /<button id="novo-rem">Novo remetente<\/button>/);
  assert.match(topo, /Também pode espelhar ofertas da Amazon e receber links de outros números\./);
  assert.ok(await ate(() => /data-rem-id="4"/.test(t.el('#lista').innerHTML)), t.el('#lista').innerHTML);
  assert.doesNotMatch(t.el('#lista').innerHTML, /Nenhum disparo automático ainda/);

  const o = tela(); preparar(o, { papel: 'operador' });
  o.rotas['GET /api/espelhos'] = () => [200, { espelhos: [] }];
  o.rotas['GET /api/remetentes'] = () => [200, lista()];
  o.rodar('paginaRegras()');
  assert.doesNotMatch(o.el('#pagina').innerHTML, /novo-rem/);
  assert.ok(await ate(() => /data-rem-id="4"/.test(o.el('#lista').innerHTML)));
  assert.doesNotMatch(o.el('#lista').innerHTML, /rem-editar/);
});

test('recarregarRegras busca /rules, /espelhos e /remetentes; falha da lista de remetentes vira uma linha escapada, sem derrubar o resto', async () => {
  const t = tela(); preparar(t);
  t.rodar('paginaRegras()'); // monta o #lista
  t.rotas['GET /api/rules'] = () => [200, []];
  t.rotas['GET /api/espelhos'] = () => [200, { espelhos: [] }];
  t.rotas['GET /api/remetentes'] = () => [500, { erro: `Falhou ${XSS}` }];
  t.pedidos.length = 0;
  await t.rodar('recarregarRegras()');
  assert.deepEqual(t.pedidos.map((p) => p.caminho).sort(), ['/api/espelhos', '/api/remetentes', '/api/rules']);
  const html = t.el('#lista').innerHTML;
  semMarcacao(html, 'erro da lista');
  assert.match(html, /Não consegui carregar os remetentes: Falhou &lt;img/);
  t.rotas['GET /api/remetentes'] = () => [200, lista([remetente({ nome: 'Outro' })])];
  await t.rodar('recarregarRegras()');
  assert.match(t.el('#lista').innerHTML, /Outro/);
  assert.doesNotMatch(t.el('#lista').innerHTML, /Não consegui carregar os remetentes/);
});

test('ações do cartão: ligar/pausar, Ver registro, Editar e Excluir (com confirmação); o Operador não escreve nada', async () => {
  const t = tela(); preparar(t);
  t.ctx.__l = [remetente()]; t.rodar('REM.lista = __l;');
  t.rotas['POST /api/remetentes/4/enabled'] = () => [200, { ok: true }];
  t.rotas['DELETE /api/remetentes/4'] = () => [200, { ok: true }];
  t.rotas['GET /api/rules'] = () => [200, []];
  t.rotas['GET /api/espelhos'] = () => [200, { espelhos: [] }];
  t.rotas['GET /api/remetentes'] = () => [200, lista()];
  const botao = (act, checked = false) => { t.ctx.__b = { dataset: { act }, checked, closest: () => ({ dataset: { remId: '4' } }) }; return t.rodar('remetenteAcao(__b)'); };
  await botao('rem-ligar', false);
  assert.deepEqual(json(t.pedidos.find((p) => p.caminho === '/api/remetentes/4/enabled')), { metodo: 'POST', caminho: '/api/remetentes/4/enabled', consulta: '', corpo: { enabled: false } });
  assert.equal(t.el('#toast').textContent, 'Remetente pausado');
  await botao('rem-registro');
  assert.equal(t.ctx.location.hash, '#historico?tipo=remetente&regra=4');
  await botao('rem-excluir');
  assert.ok(t.pedidos.some((p) => p.metodo === 'DELETE' && p.caminho === '/api/remetentes/4'));
  assert.equal(t.ctx.__confirmacoes.at(-1), 'Excluir o remetente “Sócio João”? Ele deixa de poder mandar links. O que já foi enviado continua no Histórico.');
  assert.equal(t.el('#toast').textContent, 'Remetente excluído');
  preencher(t, remetente()); await botao('rem-editar');
  assert.match(t.el('#dlg').innerHTML, /<h1>Editar remetente/);

  const o = tela(); preparar(o, { papel: 'operador' });
  o.ctx.__l = [remetente()]; o.rodar('REM.lista = __l;');
  for (const act of ['rem-ligar', 'rem-excluir', 'rem-editar']) {
    o.ctx.__b = { dataset: { act }, checked: false, closest: () => ({ dataset: { remId: '4' } }) };
    await o.rodar('remetenteAcao(__b)');
  }
  assert.deepEqual(o.pedidos, []);
  assert.equal(o.el('#dlg').innerHTML, '');
});

// =========================================================================================== formulário (CA1)

/** Controles falsos do formulário (novo, ou editar `r`), já preenchidos como o dono deixaria. */
function preencher(t, r) {
  const controle = (extra) => ({ value: '', checked: false, focus() {}, classList: { add() {}, remove() {} }, ...extra });
  const valores = { nome: 'Sócio João', numero: '', template_id: '1', tag_id: '', enviar_foto: '1', max_por_hora: '10', dedupe_horas: '24' };
  for (const k of Object.keys(t.campos)) delete t.campos[k];
  for (const [k, v] of Object.entries(valores)) t.campos[k] = controle({ value: v });
  Object.assign(t.campos.numero, { selectionStart: 0, setSelectionRange() {} });
  t.campos.responder = controle({ checked: true });
  t.campos.ligar = r ? null : controle({ checked: true });
}
/** Abre o formulário (novo, ou editar `r`) com os controles de preencher(). */
function abrirForm(t, r) {
  t.ctx.__r = r ?? null; preencher(t, r);
  t.rodar('formRemetente(__r || undefined)');
  return { html: t.el('#dlg').innerHTML, enviar: () => t.el('#f-rem').onsubmit({ preventDefault() {} }) };
}

test('CA1: o formulário tem nome, número BR, grupos (bloco como atalho), etiqueta, template, foto, limite 1 a 60, horas sem repetir, responder e ligar', () => {
  const t = tela(); preparar(t, { groups: [{ jid: 'a@g.us', name: `Grupo ${XSS}`, size: 3 }], tags: [{ id: 7, name: `Etiq ${XSS}` }], templates: [{ id: 1, name: `Tpl ${XSS}`, body: '{LINK}' }] });
  const { html } = abrirForm(t);
  semMarcacao(html, 'formulário');
  assert.match(html, /<h1>Novo remetente/);
  assert.match(html, /O número fica só no seu computador\./);
  assert.match(html, /<input name="nome"[^>]*maxlength="60"/);
  assert.match(html, /<input name="numero" type="tel" inputmode="tel" autocomplete="off"[^>]*required/);
  assert.match(html, /Com DDD\. Exemplo: \(35\) 99999-1234\./);
  assert.match(html, /id="s-bloco-atalho"/);
  assert.match(html, /O bloco só ajuda a marcar\. Se você mudar o bloco depois, esta lista não muda\./);
  assert.ok(html.includes(`Grupo ${XSS_ESC}`) && html.includes(`Etiq ${XSS_ESC}`) && html.includes(`Tpl ${XSS_ESC}`));
  assert.match(html, /<select name="tag_id"[^>]*><option value="">A etiqueta ML padrão<\/option>/);
  assert.match(html, /<select name="template_id">/);
  assert.doesNotMatch(html, /Um para cada loja/); // P3: não existe template por loja
  assert.match(html, /<select name="enviar_foto">/);
  assert.match(html, /<input name="max_por_hora" type="number" min="1" max="60"[^>]*value="10"/);
  assert.match(html, /<input name="dedupe_horas" type="number" min="0" max="8760"[^>]*value="24"/);
  assert.match(html, /<input type="checkbox" name="responder" checked/);
  assert.match(html, /<input type="checkbox" name="ligar" checked/);
  assert.doesNotMatch(html, /type="time"/); // não há janela de horário
  assert.match(html, /href="#ajustes"/);
  // rótulos que os Docs citam como caminho de tela (etapa 8; test/qa-docs.test.js CA8 os procura no painel)
  for (const rotulo of ['Novo remetente', 'Número do remetente', 'Grupos de destino', 'Etiqueta do Mercado Livre', 'No máximo (links por hora)',
    'Não repetir o mesmo produto por (horas)', 'Responder ao remetente no WhatsApp', 'Criar remetente']) assert.ok(html.includes(rotulo), rotulo);
  for (const k of ['remetente', 'remetente.numero', 'remetente.destino', 'remetente.responder', 'remetente.limite']) assert.match(html, new RegExp(`data-k="${k.replace('.', '\\.')}"`), k);
});

test('CA1: criar manda o corpo do contrato (número só com os dígitos), fecha, avisa e recarrega a lista', async () => {
  const t = tela(); preparar(t);
  t.rotas['POST /api/remetentes'] = () => [200, { id: 9 }];
  t.rotas['GET /api/rules'] = () => [200, []];
  t.rotas['GET /api/espelhos'] = () => [200, { espelhos: [] }];
  t.rotas['GET /api/remetentes'] = () => [200, lista()];
  const f = abrirForm(t);
  t.campos.numero.value = '+55 (35) 99999-1234'; t.estado.marcados = ['a@g.us', 'b@g.us'];
  t.campos.tag_id.value = '7'; t.campos.enviar_foto.value = '0'; t.campos.max_por_hora.value = '60'; t.campos.dedupe_horas.value = '0';
  t.campos.responder.checked = false;
  await f.enviar();
  const post = t.pedidos.find((p) => p.metodo === 'POST' && p.caminho === '/api/remetentes');
  assert.deepEqual(json(post.corpo), {
    nome: 'Sócio João', numero: '35999991234', destino_jids: ['a@g.us', 'b@g.us'], template_id: 1, tag_id: 7, enviar_foto: false,
    max_por_hora: 60, dedupe_horas: 0, responder: false, enabled: true,
  });
  assert.equal(t.el('#dlg').open, false);
  assert.equal(t.el('#toast').textContent, 'Remetente criado');
  assert.ok(t.pedidos.some((p) => p.caminho === '/api/remetentes' && p.metodo === 'GET'));
});

test('CA1: erros de campo no cliente (nome, número BR, grupos, template com {LINK}, 1 a 60, horas) sem chamar o servidor', async () => {
  const t = tela(); preparar(t);
  const f = abrirForm(t);
  Object.assign(t.campos.nome, { value: '  ' }); t.campos.numero.value = '(35) 89999-1234'; t.estado.marcados = [];
  t.campos.template_id.value = '2'; t.campos.max_por_hora.value = '61'; t.campos.dedupe_horas.value = '-1';
  const semPrevia = () => t.pedidos.filter((p) => p.caminho !== '/api/templates/preview');
  await f.enviar();
  assert.deepEqual(semPrevia(), []);
  const erros = t.el('.erros').innerHTML;
  for (const m of ['Dê um nome ao remetente.', 'Informe o número com DDD. Exemplo: (35) 99999-1234.', 'Marque ao menos um grupo de destino.',
    'O template precisa do campo {LINK}.', 'Links por hora: use um número de 1 a 60.', 'Horas sem repetir: use de 0 a 8760.']) assert.ok(erros.includes(m), `${m}\n${erros}`);
  // número vazio ao criar também é erro; limite 0 e fração também
  t.campos.nome.value = 'X'; t.campos.numero.value = ''; t.estado.marcados = ['a@g.us']; t.campos.template_id.value = '1'; t.campos.max_por_hora.value = '0'; t.campos.dedupe_horas.value = '1.5';
  await f.enviar();
  assert.deepEqual(semPrevia(), []);
  assert.match(t.el('.erros').innerHTML, /Informe o número com DDD/);
  assert.match(t.el('.erros').innerHTML, /Links por hora/);
  assert.match(t.el('.erros').innerHTML, /Horas sem repetir/);
});

test('CA1: o formulário mostra o erro do servidor (duplicado, número conectado, 429) escapado e o botão volta', async () => {
  const t = tela(); preparar(t);
  const f = abrirForm(t);
  t.campos.numero.value = '35999991234'; t.estado.marcados = ['a@g.us'];
  t.rotas['POST /api/remetentes'] = () => [409, { erro: `Este número já está cadastrado como ${XSS}.` }];
  await f.enviar();
  const erros = t.el('.erros').innerHTML;
  assert.ok(erros.includes(`Este número já está cadastrado como ${XSS_ESC}.`), erros);
  semMarcacao(erros, 'erro do servidor');
  assert.equal(t.el('#dlg').open, true);
  assert.equal(t.el('#rf-salvar').disabled, false);
  assert.equal(t.el('#rf-salvar').textContent, 'Criar remetente');
  t.rotas['POST /api/remetentes'] = () => [429, { erro: 'Muitas consultas de número. Tente de novo em alguns minutos.' }];
  await f.enviar();
  assert.match(t.el('.erros').innerHTML, /Muitas consultas de número/);
});

test('CA1: editar não mostra o número salvo (só o mascarado), número vazio mantém e "enabled" não vai no PUT', async () => {
  const t = tela(); preparar(t);
  t.rotas['PUT /api/remetentes/4'] = () => [200, { ok: true }];
  t.rotas['GET /api/rules'] = () => [200, []];
  t.rotas['GET /api/espelhos'] = () => [200, { espelhos: [] }];
  t.rotas['GET /api/remetentes'] = () => [200, lista()];
  const f = abrirForm(t, remetente({ tag_id: 7, enviar_foto: false, responder: false, max_por_hora: 5, dedupe_horas: 48 }));
  assert.match(f.html, /<h1>Editar remetente/);
  assert.doesNotMatch(f.html, /<input name="numero"[^>]*placeholder/);
  assert.match(f.html, /Hoje: <span aria-hidden="true">\(35\) •••••-1234<\/span><span class="sr-only">número terminado em 1234<\/span>\. Deixe em branco para manter; digite outro para trocar\./);
  assert.doesNotMatch(f.html, /<input name="numero"[^>]*required/);
  assert.doesNotMatch(f.html, /name="ligar"/);
  assert.match(f.html, /<option value="7" selected>/);
  assert.match(f.html, /<option value="0" selected>Só texto/);
  assert.doesNotMatch(f.html, /name="responder" checked/);
  t.estado.marcados = ['a@g.us'];
  await f.enviar();
  const put = t.pedidos.find((p) => p.metodo === 'PUT');
  assert.equal(put.caminho, '/api/remetentes/4');
  assert.equal('numero' in put.corpo, false);
  assert.equal('enabled' in put.corpo, false);
  assert.equal(t.el('#toast').textContent, 'Remetente salvo');
  // digitar outro número troca
  const g = abrirForm(t, remetente()); t.estado.marcados = ['a@g.us']; t.campos.numero.value = '(11) 98765-4321';
  await g.enviar();
  assert.equal(t.pedidos.filter((p) => p.metodo === 'PUT').at(-1).corpo.numero, '11987654321');
});

test('a máscara é aplicada no campo número ao digitar ou colar', () => {
  const t = tela(); preparar(t);
  abrirForm(t);
  const n = t.campos.numero;
  n.value = '+55 35 99999-1234'; n.selectionStart = n.value.length; n.oninput();
  assert.equal(n.value, '(35) 99999-1234');
  n.value = '3533331234'; n.oninput();
  assert.equal(n.value, '(35) 3333-1234');
});

test('sem grupos carregados (WhatsApp desconectado), "Criar remetente" fica travado com a razão ao lado', () => {
  const t = tela(); preparar(t, { groups: [] });
  const { html } = abrirForm(t);
  assert.match(html, /<button class="pri" id="rf-salvar" disabled aria-describedby="rf-motivo">Criar remetente<\/button>/);
  assert.match(html, /Conecte o WhatsApp em Números de WhatsApp para escolher os grupos\./);
});

// =========================================================================================== Histórico (CA12)

test('Histórico: o seletor "Tipo" ganha o quarto botão "Remetente"', () => {
  const t = tela();
  const html = t.rodar('histTipoHtml("remetente")');
  assert.match(html, /data-v="remetente" aria-checked="true">Remetente</);
  for (const v of ['', 'automatico', 'espelhamento', 'catalogo']) assert.match(html, new RegExp(`data-v="${v}"`));
});

test('Histórico tipo=remetente: pede /remetentes e /remetentes/itens filtrado pela regra; KPIs de 24 h; tudo escapado', async () => {
  const t = tela(); preparar(t); t.ctx.location.hash = '#historico?tipo=remetente&regra=4';
  t.rotas['GET /api/remetentes'] = () => [200, lista()];
  t.rotas['GET /api/remetentes/itens'] = () => [200, [
    item({ id: 33, remetente_nome: `Sócio ${XSS}`, oferta: { title: `Título ${XSS}` }, destinos: [{ nome: `Grupo ${XSS}`, ok: false, erro: `recusou ${XSS}` }, { nome: 'Grupo B', ok: true, erro: null }],
      jid: '5535999991234@s.whatsapp.net', lid: '123456789@lid', url: 'https://meli.la/SEGREDO', complemento: 'TEXTO DO SÓCIO', numero: '35999991234' }),
    item({ id: 34, destinos: [{ nome: `Único ${XSS}`, ok: true, erro: null }] }),
    item({ id: 32, status: 'descartado', codigo: 'sem_dados', motivo: `sem dados ${XSS}`, oferta: null, loja: 'amazon', destinos: [] }),
    item({ id: 31, status: 'erro', codigo: 'sem_etiqueta', motivo: 'falta a etiqueta do Mercado Livre', oferta: null, destinos: [] }),
  ]];
  await t.rodar('paginaHistorico("", new URLSearchParams("tipo=remetente&regra=4"))');
  const itens = t.pedidos.find((p) => p.caminho === '/api/remetentes/itens');
  assert.ok(itens, JSON.stringify(t.pedidos));
  const c = new URLSearchParams(itens.consulta);
  assert.equal(c.get('remetente'), '4'); assert.equal(c.get('limite'), '50'); assert.equal(c.get('antes'), null);
  const pagina = t.el('#pagina').innerHTML;
  assert.match(pagina, /data-v="remetente" aria-checked="true"/);
  const corpo = t.el('#rh-corpo').innerHTML;
  semMarcacao(corpo, 'Histórico');
  for (const s of [`Sócio ${XSS_ESC}`, `Título ${XSS_ESC}`, `Grupo ${XSS_ESC}`, `recusou ${XSS_ESC}`, `sem dados ${XSS_ESC}`, `>Único ${XSS_ESC}</span>`]) assert.ok(corpo.includes(s), `${s}\n${corpo}`);
  // o que a API não deveria mandar nunca aparece (número, LID, link recebido, texto do sócio)
  assert.doesNotMatch(corpo, /5535999991234|35999991234|123456789|SEGREDO|TEXTO DO SÓCIO/);
  // colunas e KPIs do remetente 4 (Enviados 4; Descartados = descartados + repetidos; Com erro)
  assert.match(corpo, /<th scope="col">Remetente<\/th>/);
  assert.match(corpo, /<div class="rotulo">Enviados<\/div><div class="valor">4<\/div>/);
  assert.match(corpo, /<div class="rotulo">Descartados<\/div><div class="valor">1<\/div>/);
  assert.match(corpo, /<div class="rotulo">Com erro<\/div><div class="valor">0<\/div>/);
  // título faltando: o nome da loja; afiliação faltando: link para Conexões
  assert.match(corpo, /Produto da Amazon/);
  assert.match(corpo, /Não saiu: falta a etiqueta do Mercado Livre/);
  assert.match(corpo, /href="#conexoes"/);
  // o filtro lista os remetentes pelo nome, com o atual selecionado
  assert.match(t.el('#rh-filtros').innerHTML, /<option value="4" selected>Sócio João<\/option>/);
});

test('Histórico Remetente: texto e classe de cada resultado (nunca só cor)', () => {
  const t = tela();
  const r = (extra) => { t.ctx.__it = item(extra); return json(t.rodar('remResultado(__it)')); };
  assert.deepEqual([r({}).cls, r({}).texto, r({}).detalhe], ['nivel-ok', 'Enviada', 'com o título da loja']);
  assert.equal(r({ fonte_dados: 'texto' }).detalhe, 'com o texto do remetente');
  assert.equal(r({ fonte_dados: 'api+texto' }).detalhe, 'com dados da loja e do texto do remetente');
  assert.match(r({ destinos: [{ nome: 'A', ok: null, erro: null }] }).detalhe, /enviando…/);
  const falha = r({ destinos: [{ nome: 'A', ok: true }, { nome: 'B', ok: false, erro: 'o WhatsApp recusou' }] });
  assert.deepEqual([falha.cls, falha.texto, falha.extra], ['nivel-erro', 'Erro ao enviar para 1 grupo', ['B: o WhatsApp recusou']]);
  assert.deepEqual([r({ status: 'duplicado', codigo: 'repetida', motivo: 'repetida (enviada há 3 h)' }).cls, r({ status: 'duplicado', codigo: 'repetida', motivo: 'repetida (enviada há 3 h)' }).texto], ['nivel-aviso', 'Descartada: repetida (enviada há 3 h)']);
  assert.equal(r({ status: 'descartado', codigo: 'limite', motivo: 'passou do limite de links por hora' }).texto, 'Descartada: passou do limite de links por hora');
  const af = r({ status: 'erro', codigo: 'sem_tag_amazon', motivo: 'falta a tag da Amazon' });
  assert.deepEqual([af.cls, af.texto, af.conexoes], ['nivel-aviso', 'Não saiu: falta a tag da Amazon', true]);
  // Magalu sem a loja de parceiro: também é de afiliação (aviso, com link para Conexões); sem título, o nome da loja
  const magalu = r({ status: 'erro', codigo: 'sem_loja_magalu', motivo: 'falta o nome da loja de parceiro da Magalu', loja: 'magalu', oferta: null });
  assert.deepEqual([magalu.cls, magalu.texto, magalu.conexoes], ['nivel-aviso', 'Não saiu: falta o nome da loja de parceiro da Magalu', true]);
  t.ctx.__it = item({ loja: 'magalu', oferta: null });
  assert.equal(t.rodar('remTituloItem(__it)'), 'Produto da Magalu');
  const e = r({ status: 'erro', codigo: 'falha', motivo: 'falha inesperada ao montar a oferta' });
  assert.deepEqual([e.cls, e.texto, !!e.conexoes], ['nivel-erro', 'Não saiu: falha inesperada ao montar a oferta', false]);
  assert.equal(r({ status: 'processando' }).texto, 'Processando…');
  assert.equal(r({ status: 'descartado', motivo: null }).texto, 'Descartada: sem motivo registrado');
});

test('Histórico Remetente: vazio, vazio por filtro, erro ao carregar com "Tentar de novo" e "Mostrar mais" com o cursor', async () => {
  const t = tela(); preparar(t); t.ctx.location.hash = '#historico?tipo=remetente';
  t.rotas['GET /api/remetentes'] = () => [200, lista([])];
  t.rotas['GET /api/remetentes/itens'] = () => [200, []];
  await t.rodar('paginaHistorico("", new URLSearchParams("tipo=remetente"))');
  assert.match(t.el('#rh-corpo').innerHTML, /Nenhum link recebido ainda\. Cadastre um remetente em <a href="#disparo-automatico">Disparo automático<\/a>\./);

  t.rotas['GET /api/remetentes'] = () => [200, lista()];
  t.ctx.location.hash = '#historico?tipo=remetente&regra=4';
  await t.rodar('paginaHistorico("", new URLSearchParams("tipo=remetente&regra=4"))');
  assert.match(t.el('#rh-corpo').innerHTML, /Nada com este filtro nas últimas 24 h\./);

  t.rotas['GET /api/remetentes/itens'] = () => [500, { erro: 'x' }];
  await t.rodar('paginaHistorico("", new URLSearchParams("tipo=remetente"))');
  assert.match(t.el('#rh-corpo').innerHTML, /Não consegui carregar o histórico\. Tente de novo\./);
  assert.match(t.el('#rh-corpo').innerHTML, /id="rh-de-novo"/);

  const cheia = Array.from({ length: 50 }, (_, i) => item({ id: 200 - i }));
  t.rotas['GET /api/remetentes/itens'] = ({ consulta }) => [200, new URLSearchParams(consulta).get('antes') ? [item({ id: 10 })] : cheia];
  await t.rodar('paginaHistorico("", new URLSearchParams("tipo=remetente"))');
  assert.match(t.el('#rh-corpo').innerHTML, /<button type="button" id="rh-mais">Mostrar mais<\/button>/);
  await t.el('#rh-mais').onclick();
  const mais = t.pedidos.filter((p) => p.caminho === '/api/remetentes/itens').at(-1);
  assert.equal(new URLSearchParams(mais.consulta).get('antes'), '151');
  assert.equal(t.el('#rh-mais').hidden, true);
  assert.equal(t.el('#rh-contagem').textContent, 'Mostrando todos os 51 links.');
});

test('a visão Remetente não repinta com uma resposta atrasada depois que o dono trocou de Tipo', async () => {
  const t = tela(); preparar(t); t.ctx.location.hash = '#historico?tipo=remetente';
  let solta; const espera = new Promise((r) => { solta = r; });
  t.rotas['GET /api/remetentes'] = async () => { await espera; return [200, lista()]; };
  t.rotas['GET /api/remetentes/itens'] = async () => { await espera; return [200, [item({ oferta: { title: 'ATRASADA' } })]]; };
  const atrasada = t.rodar('paginaHistorico("", new URLSearchParams("tipo=remetente"))');
  t.rotas['GET /api/log'] = () => [200, []];
  await t.rodar('paginaHistorico("", new URLSearchParams(""))');
  solta(); await atrasada;
  assert.doesNotMatch(t.el('#rh-corpo').innerHTML, /ATRASADA/);
});

test('D2: a atualização automática não repinta com o foco dentro do corpo nem sem mudança, e não leva aria-live', async () => {
  const t = tela(); preparar(t); t.ctx.location.hash = '#historico?tipo=remetente';
  const timers = []; t.ctx.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  let titulo = 'Primeiro'; let chamadas = 0;
  t.rotas['GET /api/remetentes'] = () => [200, lista()];
  t.rotas['GET /api/remetentes/itens'] = () => { chamadas++; return [200, [item({ oferta: { title: titulo } })]]; };
  await t.rodar('paginaHistorico("", new URLSearchParams("tipo=remetente"))');
  const corpo = t.el('#rh-corpo'); const gravacoes = []; let html = corpo.innerHTML;
  Object.defineProperty(corpo, 'innerHTML', { configurable: true, get: () => html, set: (v) => { html = v; gravacoes.push(v); } });
  assert.match(html, /aria-live="polite"/); assert.match(html, /Primeiro/);
  const tick = async () => { const antes = chamadas; await timers.shift()(); assert.equal(chamadas, antes + 1); };
  // nada mudou: não repinta
  await tick(); assert.equal(gravacoes.length, 0);
  // mudou, mas o foco está dentro do corpo: não repinta (o foco não se perde)
  titulo = 'Segundo'; t.ctx.document.activeElement = 'foco'; t.ctx.__focoDentro = true;
  await tick(); assert.equal(gravacoes.length, 0); assert.doesNotMatch(html, /Segundo/);
  // foco fora: repinta, sem aria-live (os KPIs não são lidos de novo)
  t.ctx.__focoDentro = false;
  await tick(); assert.equal(gravacoes.length, 1); assert.match(html, /Segundo/); assert.doesNotMatch(html, /aria-live/);
});

// =========================================================================================== index.html

test('index.html carrega remetentes.js logo depois de espelhamento.js e antes de app.js (o harness de equipe-qa lê esta lista)', () => {
  const srcs = [...fonte('index.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const i = srcs.indexOf('remetentes.js');
  assert.ok(i > 0, srcs.join(', '));
  assert.equal(srcs[i - 1], 'espelhamento.js');
  assert.ok(i < srcs.indexOf('app.js'));
});
