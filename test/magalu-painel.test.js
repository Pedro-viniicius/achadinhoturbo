// Painel da Magalu (plano integracao-magalu, etapa 4; spec docs/produto/specs/integracao-magalu.md, seções 1 e 2): o cartão de
// Conexões (public/conexoes.js) e o Disparo manual (public/disparos.js). Os arquivos rodam num `vm` com utilitários de app.js
// falsos e um DOM mínimo; nenhuma rede, nenhum servidor. As funções puras (dispMagalu*, cxMagalu*) são exportadas por texto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { RE_LOJA_MAGALU, LINK_MAGALU, HOSTS_MAGALU } from '../src/magalu.js';
import { PLATAFORMAS } from '../src/lojas.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lerPublic = (arq) => fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');
/** Objetos e arrays criados dentro do vm têm outro protótipo: compare por JSON. */
const J = (x) => JSON.parse(JSON.stringify(x));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Elemento falso: valor, HTML, classes e tratadores que a tela pendura. */
function el(extra = {}) {
  const classes = new Set(); const attrs = new Map();
  return {
    value: '', checked: false, disabled: false, hidden: false, _t: '', _html: '', className: '', placeholder: '', src: '', tabIndex: 0,
    dataset: {}, style: {}, isConnected: true, parentNode: null, focado: 0, filhos: [],
    classes, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle(c, on) { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); } },
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute(k) { if (k === 'style') this.style = {}; attrs.delete(k); },
    focus() { this.focado++; }, click() {}, scrollIntoView() {}, closest: () => null, insertBefore() {}, remove() {},
    appendChild(f) { this.filhos.push(f); return f; },
    insertAdjacentHTML(_onde, h) { this._html += h; },
    get textContent() { return this._t; }, set textContent(v) { this._t = String(v); this._html = ''; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); if (v === '') this.filhos = []; },
    ...extra,
  };
}
function fabricaDollar() {
  const mapa = new Map();
  const $ = (sel) => { if (!mapa.has(sel)) mapa.set(sel, el()); return mapa.get(sel); };
  return { $, mapa };
}
const AGUARDA = () => new Promise((r) => setImmediate(r));
const ESPERA = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================== Disparo manual (public/disparos.js)
function carregarDisparos({ S, fetch, extras = {} } = {}) {
  const { $, mapa } = fabricaDollar();
  const campos = new Map();
  const ctx = {
    console, setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; }, clearTimeout, Number, String, Math, Date, JSON, Array, Object, RegExp, URL, Intl, Promise, Symbol, Error, Set, Map,
    document: {
      createElement: () => el({ elements: { namedItem: (n) => { if (!campos.has(n)) campos.set(n, el()); return campos.get(n); } } }),
      getElementById: () => null, activeElement: null, body: el(),
    },
    $, $$: () => [], esc, zap: (x) => String(x), REQ: '*', q: (c) => `[?${c}]`, opcoes: () => '', aviso() {}, mostrarErros() { return false; },
    S: S || { templates: [], tags: [], groups: [], st: {} },
    seletorGrupos: () => ({ html: '', ligar() {}, marcados: () => [] }),
    location: { hash: '#teste', replace() {} }, confirm: () => true, FileReader: class {},
    fetch: fetch || (async () => { throw new Error('rede proibida no teste'); }),
    ...extras,
  };
  vm.createContext(ctx);
  vm.runInContext(`${lerPublic('disparos.js')}\n;globalThis.__x = { dispMagaluVeredito, dispMagaluLink, dispPareceMagaluCurto, DISP_LINK_MAGALU, DISP_RE_LOJA_MAGALU, DISP_HOSTS_MAGALU_CURTOS, TEXTOS_DISPAROS, paginaDisparoManual };`, ctx);
  return { ...ctx.__x, $, mapa, ctx, campos };
}
const D = carregarDisparos();
const T = D.TEXTOS_DISPAROS;
const A = T.magalu;

const LOJA = 'minhaloja';
const LINK = `https://www.magazinevoce.com.br/${LOJA}/fone-bluetooth/p/abc1234def/te/fone/`;
const PRODUTO = () => ({ key: 'MAGALU:abc1234def', codigo: 'abc1234def', urlProduto: 'https://www.magazineluiza.com.br/fone-bluetooth/p/abc1234def/te/fone/', sellerId: null, lojaDoLink: null, title: null, price: null, oldPrice: null, discountPct: null, sold: null, freeShipping: null, coupon: null, image: null });
const RESP = (extra = {}) => ({
  loja: { id: 'magalu', nome: 'Magalu', implementada: true }, motivo: null, editavel: true, produto: PRODUTO(), causa: null, causa_link: null,
  loja_parceiro: LOJA, outra_loja: false, pode_disparar: true, texto: `Oferta\n${LINK}`, template_id: 1, etiqueta: null, ...extra,
});

test('CA4: as regras do painel são as do servidor (nome da loja e forma do link) e a lista de links curtos é só de hosts da Magalu', () => {
  assert.equal(D.DISP_RE_LOJA_MAGALU.source, RE_LOJA_MAGALU.source);
  assert.equal(D.DISP_RE_LOJA_MAGALU.flags, RE_LOJA_MAGALU.flags);
  assert.equal(D.DISP_LINK_MAGALU.source, LINK_MAGALU.source.slice(1, -1), 'a mesma regex do link, sem as âncoras');
  assert.equal(PLATAFORMAS.magalu.campos[0].padrao, RE_LOJA_MAGALU.source);
  for (const h of J(D.DISP_HOSTS_MAGALU_CURTOS)) assert.ok(HOSTS_MAGALU.some((base) => h === base || h.endsWith(`.${base}`)), `${h} não é da Magalu`);
});

test('CA4: Identificar sem leitura (o estado normal): dados em branco, linha informativa, nada bloqueia e nenhuma loja de outro parceiro aparece', () => {
  const v = D.dispMagaluVeredito(RESP());
  assert.deepEqual(J(v), { tipo: 'sem_leitura', dados: true, mensagem: 'A Magalu não deixa o painel ler o produto. Preencha o título e o preço abaixo; o link já sai com o nome da sua loja.', link: null, outraLoja: '', bloqueio: '' });
  assert.doesNotMatch(v.mensagem, /!|erro|falha|não consegui/i, 'não é falha: sem "!" nem tom de erro');
});

test('CA4: invalido e nao_produto bloqueiam, escondem os dados e dizem o motivo ao lado do botão', () => {
  const casos = [
    [RESP({ causa: 'invalido', produto: null, pode_disparar: false }), 'invalido', 'Não reconheci este link da Magalu. Cole o endereço da página do produto (magazinevoce.com.br/… ou magazineluiza.com.br/…). Se era um link curto, abra-o no navegador e copie o endereço da página.', 'Cole um link de produto da Magalu.'],
    [RESP({ causa: 'nao_produto', produto: null, pode_disparar: false }), 'nao_produto', 'Este link não leva a um produto específico. Cole o link da página do produto.', 'Cole o link da página do produto.'],
  ];
  for (const [r, tipo, msg, motivo] of casos) {
    assert.deepEqual(J(D.dispMagaluVeredito(r)), { tipo, dados: false, mensagem: msg, link: null, outraLoja: '', bloqueio: motivo }, tipo);
  }
  // sem produto e sem causa: tratado como link inválido; resposta vazia também
  assert.equal(D.dispMagaluVeredito(RESP({ produto: null })).tipo, 'invalido');
  assert.equal(D.dispMagaluVeredito(null).tipo, 'invalido');
  // o link inválido pesa mais que a falta da loja: o dono corrige o link primeiro
  const dois = D.dispMagaluVeredito(RESP({ causa: 'invalido', produto: null, causa_link: 'sem_loja', pode_disparar: false }));
  assert.deepEqual([dois.tipo, dois.dados, dois.link], ['invalido', false, null]);
});

test('CA4: sem_loja bloqueia com o aviso e o link para Conexões, e os dados continuam em branco e editáveis', () => {
  const v = D.dispMagaluVeredito(RESP({ causa_link: 'sem_loja', loja_parceiro: null, pode_disparar: false }));
  assert.deepEqual(J(v), {
    tipo: 'sem_loja', dados: true, mensagem: A.semLeitura, link: { texto: 'Magalu identificada, mas falta o nome da sua loja de parceiro.', acao: 'Cadastre em Conexões.' },
    outraLoja: '', bloqueio: 'Cadastre o nome da loja da Magalu em Conexões.',
  });
});

test('CA4: outra_loja soma a linha informativa a qualquer linha de produto, sem bloquear e sem dizer o nome da outra loja', () => {
  const v = D.dispMagaluVeredito(RESP({ outra_loja: true }));
  assert.equal(v.outraLoja, 'O link que você colou é de outra loja de parceiro. O envio sai com a sua loja, não com essa.');
  assert.equal(v.bloqueio, ''); assert.equal(v.tipo, 'sem_leitura'); assert.equal(v.dados, true);
  const comSemLoja = D.dispMagaluVeredito(RESP({ outra_loja: true, causa_link: 'sem_loja', pode_disparar: false }));
  assert.equal(comSemLoja.tipo, 'sem_loja'); assert.ok(comSemLoja.outraLoja, 'soma também com a falta da loja');
  // só `true` liga a linha (texto do servidor nunca vira "ligado" por truthy)
  for (const nao of [false, null, undefined, 'true', 1, 'outra']) assert.equal(D.dispMagaluVeredito(RESP({ outra_loja: nao })).outraLoja, '', String(nao));
  assert.doesNotMatch(T.magalu.outraLoja, new RegExp(LOJA), 'o texto é fixo');
});

test('CA4: pode_disparar que não seja exatamente true, ou qualquer causa_link, nunca habilita o botão', () => {
  assert.equal(D.dispMagaluVeredito(RESP({ pode_disparar: false })).bloqueio, 'Não dá para disparar este link da Magalu.');
  assert.equal(D.dispMagaluVeredito(RESP({ pode_disparar: undefined })).bloqueio, 'Não dá para disparar este link da Magalu.', 'sem o campo, bloqueia');
  assert.equal(D.dispMagaluVeredito(RESP({ pode_disparar: 'true' })).bloqueio, 'Não dá para disparar este link da Magalu.');
  const novo = D.dispMagaluVeredito(RESP({ causa_link: 'outra_coisa', pode_disparar: true }));
  assert.equal(novo.bloqueio, 'Não dá para disparar este link da Magalu.', 'causa nova do servidor: bloqueia');
  assert.equal(novo.link, null);
});

test('CA4: "Resolvendo o link…" só para os links curtos da Magalu (o host ou subdomínio dele, como o servidor resolve)', () => {
  for (const ok of ['https://maga.lu/abc', 'https://magazineluiza.onelink.me/xYz1?a=b', 'https://divulgador.magalu.com/abc', 'HTTPS://MAGA.LU/ABC',
    'https://magalu.com/AbC123?pid=x', 'https://MAGALU.COM/abc', 'https://www.magalu.com/abc']) assert.equal(D.dispPareceMagaluCurto(ok), true, ok);
  for (const nao of ['https://www.magazineluiza.com.br/x/p/abc1234/te/', 'https://www.magazinevoce.com.br/loja/p/abc1234/', 'https://maga.lu.evil.com/x', 'https://evil.com/maga.lu', 'https://xmaga.lu/a',
    'https://xmagalu.com/abc', 'https://magalu.com.evil.com/abc', 'https://evil.com/magalu.com',
    'https://s.shopee.com.br/AbC', 'nao é url', '', undefined, null]) assert.equal(D.dispPareceMagaluCurto(nao), false, String(nao));
});

test('CA4: o link de afiliado sai do texto do servidor só se tem a forma do link da Magalu', () => {
  assert.equal(D.dispMagaluLink(`Oferta\n${LINK}\nfim`), LINK);
  assert.equal(D.dispMagaluLink(`x https://www.magazinevoce.com.br/${LOJA}/p/abc1234/ y`), `https://www.magazinevoce.com.br/${LOJA}/p/abc1234/`);
  assert.equal(D.dispMagaluLink(`ver ${LINK}?seller_id=v1_2 depois`), `${LINK}?seller_id=v1_2`, 'o seller_id válido faz parte do link');
  for (const nao of ['sem link', 'https://meli.la/2AbCdEf', 'https://www.magazinevoce.com.br/', 'https://www.magazinevoce.com.br/loja/', 'http://www.magazinevoce.com.br/loja/p/abc1234/', 'https://magazinevoce.com.br.evil.com/loja/p/abc1234/', '', null, undefined, 7]) {
    assert.equal(D.dispMagaluLink(nao), '', String(nao));
  }
});

test('CA4: a etiqueta fixa leva o nome da loja escapado, o link para Conexões e a frase do rastreio; sem nome, a frase sai sem ele', () => {
  assert.equal(A.etiqueta(LOJA), 'O link da Magalu leva o nome da sua loja de parceiro, minhaloja (de <a href="#conexoes">Conexões</a> → Magalu). A Magalu não separa os ganhos por grupo.');
  assert.equal(A.etiqueta(''), 'O link da Magalu leva o nome da sua loja de parceiro (de <a href="#conexoes">Conexões</a> → Magalu). A Magalu não separa os ganhos por grupo.');
  assert.ok(A.etiqueta('<img src=x onerror=alert(1)>').includes('&lt;img src=x onerror=alert(1)&gt;'), 'passa por esc');
  assert.ok(!A.etiqueta('"><script>x</script>').includes('<script>'));
});

// ---------------- a página do Disparo manual, de ponta a ponta com um servidor falso
/**
 * Abre paginaDisparoManual com um fetch falso. `rotas` = { 'METODO /api/caminho': ({corpo}) => { status, json } | Promise }.
 * A extensão fica OFF-LINE com o modo de link "extension": a Magalu não pode depender dela.
 */
function abrirDisparo(rotas, { whats = 'open' } = {}) {
  const pedidos = []; const erros = [];
  const S = { templates: [{ id: 1, name: 'Padrão', body: '{TITULO} {LINK}' }], tags: [{ id: 2, name: 'etqa' }], groups: [], st: { whatsapp: { status: whats }, extensao: { online: false }, ajustes: { link_mode: 'extension' }, simulacao: false } };
  const base = {
    'POST /api/templates/preview': () => ({ status: 200, json: { texto: 'prévia' } }),
    'GET /api/envios?tipo=oferta': () => ({ status: 200, json: { linhas: [], agendadas: [], contadores: {} } }),
    'POST /api/envios': () => ({ status: 200, json: { id: 7, status: 'pendente' } }),
  };
  const todas = { ...base, ...rotas };
  const fetch = async (url, opts = {}) => {
    const metodo = opts.method || 'GET'; const corpo = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    pedidos.push({ metodo, url, corpo });
    const f = todas[`${metodo} ${url}`];
    if (!f) return { status: 404, ok: false, json: async () => ({ erro: `sem rota ${metodo} ${url}` }) };
    const r = await f({ corpo });
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json };
  };
  const D2 = carregarDisparos({ S, fetch, extras: { mostrarErros: (_f, lista) => { erros.push(...lista); return lista.length > 0; }, seletorGrupos: () => ({ html: '', ligar() {}, marcados: () => ['111@g.us'] }) } });
  D2.paginaDisparoManual();
  D2.$('#dm-tpl').value = '1';
  return { ...D2, pedidos, erros, S };
}
const URL_MAGALU = 'https://www.magazineluiza.com.br/fone-bluetooth/p/abc1234def/te/fone/';
const identificarCom = async (json, url = URL_MAGALU, rotas = {}) => {
  const a = abrirDisparo({ 'POST /api/disparo/identificar': () => ({ status: 200, json }), ...rotas });
  a.$('#dm-url').value = url;
  await a.$('#dm-identificar').onclick();
  return a;
};
const digitar = (a, nome, valor) => { const c = a.campos.get(nome); c.value = valor; c.oninput(); };

test('CA4: Identificar da Magalu sem leitura: linha informativa, "Dados da oferta" em branco, foto só por upload e etiqueta em texto fixo', async () => {
  const a = await identificarCom(RESP());
  const prod = a.$('#dm-prod').innerHTML;
  assert.match(prod, /A Magalu não deixa o painel ler o produto\. Preencha o título e o preço abaixo; o link já sai com o nome da sua loja\./);
  assert.doesNotMatch(prod, /card-prod|<img|aviso|role="alert"/, 'não é cartão de produto nem de falha');
  assert.match(prod, /class="dica"/);
  assert.equal(a.$('#dm-dados').filhos.length, 1, 'a seção Dados da oferta entrou');
  for (const n of ['title', 'price', 'oldPrice', 'coupon']) assert.equal(a.campos.get(n).value, '', `${n} em branco`);
  assert.equal(a.campos.get('freeShipping').checked, false);
  // dica do Preço (nota ligada por aria-describedby ao campo)
  assert.equal(a.$('#dm-etq').hidden, true, 'sem o select de etiquetas do Mercado Livre');
  assert.equal(a.$('#dm-etq-amazon').hidden, true); assert.equal(a.$('#dm-etq-shopee').hidden, true);
  assert.equal(a.$('#dm-etq-magalu').hidden, false);
  assert.equal(a.$('[data-etq-txt]').innerHTML, A.etiqueta(LOJA));
  assert.match(a.$('[data-etq-txt]').innerHTML, /A Magalu não separa os ganhos por grupo\./);
  assert.equal(a.$('#dm-agendar').checked, false);
  assert.equal(a.$('#dm-disparar').disabled, false, a.$('#dm-motivo').textContent);
});

test('CA4: a dica do campo Preço é a da spec e fica ligada ao campo', async () => {
  let html = '';
  const base = carregarDisparos({ extras: { document: { createElement: () => ({ dataset: {}, set innerHTML(v) { html = v; }, get innerHTML() { return html; }, elements: { namedItem: () => el() } }), getElementById: () => null, activeElement: null, body: el() } } });
  vm.runInContext('globalThis.__dados = dadosOferta', base.ctx);
  base.ctx.__dados({}, () => {}, { notaPreco: A.dicaPreco });
  assert.match(html, /name="price"[^>]*aria-describedby="do\d+-faixa"/);
  assert.match(html, /<small id="do\d+-faixa" data-faixa>Use o preço que aparece na página da Magalu\.<\/small>/);
});

test('CA4: Disparar com o título vazio é recusado com a frase de sempre e nada vai ao servidor; com título e preço, vai sem etiqueta e sem foto', async () => {
  const a = await identificarCom(RESP());
  await a.$('#dm-disparar').onclick();
  assert.deepEqual(a.erros.map((e) => e.msg), ['Preencha o título da oferta.']);
  assert.equal(a.pedidos.filter((p) => p.url === '/api/envios').length, 0, 'nada enviado');
  a.erros.length = 0;
  digitar(a, 'title', 'Fone Bluetooth'); digitar(a, 'price', '89,90');
  await a.$('#dm-disparar').onclick();
  assert.deepEqual(a.erros, []);
  const env = a.pedidos.filter((p) => p.url === '/api/envios');
  assert.equal(env.length, 1);
  const c = J(env[0].corpo);
  assert.equal(c.url, URL_MAGALU, 'o servidor relê o produto pela url colada');
  assert.equal(c.tag_id, null, 'a Magalu não usa etiqueta do Mercado Livre');
  assert.deepEqual(c.ajustes, { title: 'Fone Bluetooth', price: 89.9, oldPrice: null, coupon: '', freeShipping: false, sem_foto: true });
  assert.equal(c.tipo, 'oferta'); assert.equal(c.quando, 'agora'); assert.deepEqual(c.group_jids, ['111@g.us']);
  assert.ok(!JSON.stringify(c).includes('magazinevoce'), 'o painel nunca manda o link montado');
});

test('CA4: a Magalu não depende da extensão do Chrome: com ela desligada, nem o estado vazio nem os bloqueios dizem "extensão desconectada"', async () => {
  const bloqueado = await identificarCom(RESP({ causa: 'invalido', produto: null, pode_disparar: false }));
  assert.equal(bloqueado.S.st.extensao.online, false);
  assert.equal(bloqueado.$('#dm-motivo').textContent, 'Cole um link de produto da Magalu.');
  const livre = await identificarCom(RESP());
  assert.notEqual(livre.$('#dm-motivo').textContent, 'A extensão do Chrome está desconectada: abra a Central de Afiliados no Chrome, ou agende o envio.');
  assert.equal(livre.$('#dm-disparar').disabled, false);
  // o Mercado Livre continua pedindo a extensão (a condição nova é só da Magalu)
  const ml = abrirDisparo({});
  ml.S.st.extensao.online = false;
  ml.$('#dm-url').value = 'https://produto.mercadolivre.com.br/MLB-1'; ml.$('#dm-url').oninput();
  assert.equal(ml.$('#dm-motivo').textContent, T.motivoExtensao);
});

test('CA4: sem_loja: aviso com o link "Cadastre em Conexões." (#conexoes), linha informativa abaixo, campos editáveis e Disparar desabilitado com o motivo', async () => {
  const a = await identificarCom(RESP({ causa_link: 'sem_loja', loja_parceiro: null, pode_disparar: false, texto: 'Oferta' }));
  const prod = a.$('#dm-prod').innerHTML;
  assert.match(prod, /role="alert"/);
  assert.match(prod, /Magalu identificada, mas falta o nome da sua loja de parceiro\. <a href="#conexoes">Cadastre em Conexões\.<\/a>/);
  assert.ok(prod.indexOf('Magalu identificada') < prod.indexOf('A Magalu não deixa o painel ler o produto'), 'a linha informativa continua abaixo do aviso');
  assert.equal(a.$('#dm-prod').style.display, 'grid');
  assert.equal(a.$('#dm-dados').filhos.length, 1, 'os campos seguem editáveis');
  assert.equal(a.$('#dm-disparar').disabled, true);
  assert.equal(a.$('#dm-motivo').textContent, 'Cadastre o nome da loja da Magalu em Conexões.');
  assert.equal(a.$('[data-etq-txt]').innerHTML, A.etiqueta(''), 'sem nome salvo, a frase da etiqueta não cita nome');
  // preencher os campos não destrava: o servidor decidiu
  digitar(a, 'title', 'Fone'); assert.equal(a.$('#dm-disparar').disabled, true);
  await a.$('#dm-disparar').onclick();
  assert.equal(a.pedidos.filter((p) => p.url === '/api/envios').length, 0);
  assert.ok(a.erros.some((e) => e.msg === 'Cadastre o nome da loja da Magalu em Conexões.'));
});

test('CA4: invalido e nao_produto: sem seção de dados, a etiqueta do Mercado Livre volta, Disparar desabilitado com o motivo', async () => {
  for (const [r, texto, motivo] of [
    [RESP({ causa: 'nao_produto', produto: null, pode_disparar: false }), /Este link não leva a um produto específico/, 'Cole o link da página do produto.'],
    [RESP({ causa: 'invalido', produto: null, pode_disparar: false }), /Não reconheci este link da Magalu\. Cole o endereço da página do produto \(magazinevoce\.com\.br\/… ou magazineluiza\.com\.br\/…\)/, 'Cole um link de produto da Magalu.']]) {
    const a = await identificarCom(r);
    assert.match(a.$('#dm-prod').innerHTML, texto, r.causa);
    assert.match(a.$('#dm-prod').innerHTML, /role="alert"/, 'bloqueio usa o padrão de erro existente');
    assert.equal(a.$('#dm-dados').filhos.length, 0, `${r.causa}: sem dados`);
    assert.equal(a.$('#dm-disparar').disabled, true, r.causa);
    assert.equal(a.$('#dm-motivo').textContent, motivo, r.causa);
    assert.equal(a.$('#dm-etq-magalu').hidden, true, r.causa);
  }
});

test('CA4: outra_loja: a linha informativa entra junto da do item, sem bloquear e sem o nome da outra loja', async () => {
  const a = await identificarCom(RESP({ outra_loja: true }), 'https://www.magazinevoce.com.br/lojadooutro/fone/p/abc1234def/te/');
  const prod = a.$('#dm-prod').innerHTML;
  assert.match(prod, /A Magalu não deixa o painel ler o produto\./);
  assert.match(prod, /O link que você colou é de outra loja de parceiro\. O envio sai com a sua loja, não com essa\./);
  assert.doesNotMatch(prod, /lojadooutro/);
  assert.equal(a.$('#dm-disparar').disabled, false);
  assert.equal(a.$('#dm-prod').style.display, 'grid');
});

test('CA4: loja_parceiro só aparece se tem a forma de nome de loja (o resto do servidor é descartado)', async () => {
  const a = await identificarCom(RESP({ loja_parceiro: '"><img src=x onerror=alert(1)>' }));
  assert.doesNotMatch(a.$('[data-etq-txt]').innerHTML, /<img|onerror/);
  assert.equal(a.$('[data-etq-txt]').innerHTML, A.etiqueta(''));
  const b = await identificarCom(RESP({ loja_parceiro: 'minha-loja_2' }));
  assert.match(b.$('[data-etq-txt]').innerHTML, /sua loja de parceiro, minha-loja_2 \(de/);
});

test('CA4/CA6: link curto: "Resolvendo o link…" enquanto o servidor segue o redirecionamento; link longo não mostra', async () => {
  let soltar; const p = new Promise((r) => { soltar = r; });
  const a = abrirDisparo({ 'POST /api/disparo/identificar': () => p });
  a.$('#dm-url').value = 'https://maga.lu/AbCdE';
  const espera = a.$('#dm-identificar').onclick();
  assert.match(a.$('#dm-prod').innerHTML, /Resolvendo o link…/);
  assert.equal(a.$('#dm-identificar').textContent, 'Identificando…'); assert.equal(a.$('#dm-disparar').disabled, true);
  soltar({ status: 200, json: RESP() });
  await espera;
  assert.doesNotMatch(a.$('#dm-prod').innerHTML, /Resolvendo/);
  assert.match(a.$('#dm-prod').innerHTML, /A Magalu não deixa o painel ler o produto/);
  // link curto que não resolveu: invalido com a orientação
  const b = await identificarCom(RESP({ causa: 'invalido', produto: null, pode_disparar: false }), 'https://magazineluiza.onelink.me/xYz1');
  assert.match(b.$('#dm-prod').innerHTML, /Se era um link curto, abra-o no navegador e copie o endereço da página\./);
  const c = abrirDisparo({ 'POST /api/disparo/identificar': () => ({ status: 200, json: RESP() }) });
  c.$('#dm-url').value = URL_MAGALU;
  const e2 = c.$('#dm-identificar').onclick();
  assert.doesNotMatch(c.$('#dm-prod').innerHTML, /Resolvendo/);
  await e2;
});

test('CA4: a prévia é o texto do servidor (link real); ao digitar, a prévia ao vivo usa esse mesmo link e a legenda da Magalu', async () => {
  const a = await identificarCom(RESP());
  assert.equal(a.$('#dm-pv').innerHTML, `Oferta\n${LINK}`, 'o texto do servidor, com o link real e sem máscara');
  assert.equal(a.$('#dm-pv-leg').textContent, 'Mostra os dados acima. O link de afiliado leva o nome da sua loja.');
  digitar(a, 'title', 'Fone Bluetooth'); digitar(a, 'price', '89,90');
  await ESPERA(320);
  const prev = a.pedidos.filter((p) => p.url === '/api/templates/preview').at(-1);
  assert.equal(prev.corpo.amostra.link, LINK, 'o link da prévia é o do texto, não o do Mercado Livre');
  assert.equal(prev.corpo.amostra.title, 'Fone Bluetooth'); assert.equal(prev.corpo.amostra.price, 89.9);
  assert.equal(a.$('#dm-pv-leg').textContent, 'Mostra os dados acima. O link de afiliado leva o nome da sua loja.');
  // sem link no texto (sem_loja): marcador neutro, nunca o link de exemplo do Mercado Livre
  const b = await identificarCom(RESP({ causa_link: 'sem_loja', loja_parceiro: null, pode_disparar: false, texto: 'Oferta' }));
  digitar(b, 'title', 'Fone');
  await ESPERA(320);
  const link = b.pedidos.filter((p) => p.url === '/api/templates/preview').at(-1).corpo.amostra.link;
  assert.equal(link, 'https://www.magazinevoce.com.br/(a sua loja)/…');
  assert.doesNotMatch(link, /meli\.la/);
});

test('CA4: trocar o link depois de identificar limpa o aviso, os dados e a etiqueta volta ao select do Mercado Livre', async () => {
  const a = await identificarCom(RESP({ outra_loja: true }), URL_MAGALU, {});
  a.S.st.extensao.online = true; // o motivo do Mercado Livre (extensão) não mascara o que a conferência quer ver
  assert.equal(a.$('#dm-etq-magalu').hidden, false); assert.equal(a.$('#dm-prod').style.display, 'grid');
  a.$('#dm-url').value = 'https://www.magazineluiza.com.br/outro/p/zzz9999/te/'; a.$('#dm-url').oninput();
  assert.equal(a.$('#dm-prod').innerHTML, ''); assert.equal(a.$('#dm-dados').filhos.length, 0);
  assert.equal(a.$('#dm-etq-magalu').hidden, true); assert.equal(a.$('#dm-etq').hidden, false);
  assert.equal(a.$('#dm-prod').style.display, undefined, 'o grid do aviso não sobra para a próxima identificação');
  assert.equal(a.$('#dm-motivo').textContent, 'Identifique o link do produto.');
});

test('CA4: a Shopee e a Amazon não mudaram: a etiqueta da Magalu fica escondida e o texto da Shopee segue o dela', async () => {
  const shopee = await identificarCom({
    loja: { id: 'shopee', nome: 'Shopee', implementada: true }, motivo: null, editavel: true, causa: null, link_via: 'api', causa_link: null, pode_disparar: true, texto: 'x', template_id: 1,
    produto: { key: 'SHOPEE:1.2', title: 'Fone', price: 79.9, oldPrice: null, discountPct: 15, sold: 3, freeShipping: false, coupon: null, image: null }, extra: null,
  }, 'https://shopee.com.br/Fone-i.1.2', { 'GET /api/conexoes': () => ({ status: 200, json: [] }) });
  assert.equal(shopee.$('#dm-etq-magalu').hidden, true); assert.equal(shopee.$('#dm-etq-shopee').hidden, false);
  const amazon = await identificarCom({
    loja: { id: 'amazon', nome: 'Amazon', implementada: true }, motivo: null, editavel: true, causa: null, tag_salva: true, texto: 'x', template_id: 1,
    produto: { key: 'ASIN:B0ABC12345', asin: 'B0ABC12345', title: 'Fone', price: 80, oldPrice: null, discountPct: null, image: null },
  }, 'https://www.amazon.com.br/dp/B0ABC12345');
  assert.equal(amazon.$('#dm-etq-magalu').hidden, true); assert.equal(amazon.$('#dm-etq-amazon').hidden, false);
});

// ================================================================== Conexões (public/conexoes.js)
function carregarConexoes(respostas = {}, mapa = null) {
  const { $: dollar } = fabricaDollar();
  const pedidos = [];
  const ctx = {
    console, Number, String, Array, Object, Math, Date, JSON, RegExp, Promise, Error,
    $: (sel) => (mapa ? mapa[sel] ?? null : dollar(sel)), $$: () => [], esc, q: (chave) => `[?${chave}]`, REQ: '*', S: {}, aviso() {}, tentar: (f) => f, dataHora: () => '06/11/2026 10:00',
    mostrarErros: (_f, lista) => { ctx.errosMostrados.push(...lista); return lista.length > 0; }, errosMostrados: [],
    api: async (url, metodo = 'GET', corpo) => { pedidos.push(`${metodo} ${url}`); ctx.corpos.push(corpo); const r = respostas[`${metodo} ${url}`]; return typeof r === 'function' ? r() : r; }, corpos: [],
  };
  vm.createContext(ctx);
  vm.runInContext(`${lerPublic('conexoes.js')}\n;globalThis.__x = { pillConexao, cartaoConexao, aplicarConexao, ligarConexao, lerFormConexao, cxLinhaEstado, cxMagaluHref, cxMagaluLinkHtml, cxErroCampoMagalu, CX_MAGALU_RE_LOJA, TEXTOS_CONEXOES };`, ctx);
  return { ...ctx.__x, ctx, pedidos };
}
const C = carregarConexoes();
const TC = C.TEXTOS_CONEXOES.magalu;

const CAMPOS = () => J(PLATAFORMAS.magalu.campos).map((c) => ({ nome: c.nome, rotulo: c.rotulo, tipo: c.tipo, max: c.max, padrao: c.padrao, ajuda: c.ajuda }));
const CARTAO = (extra = {}) => ({
  id: 'magalu', nome: 'Magalu', implementada: true, descricao: PLATAFORMAS.magalu.descricao, campos: CAMPOS(), config: {}, segredos_salvos: [],
  estado: 'falta_configurar', updated_at: null, ...extra,
});

test('CA1: a regra do nome da loja no painel é a do servidor e o campo vem do registro', () => {
  assert.equal(C.CX_MAGALU_RE_LOJA.source, RE_LOJA_MAGALU.source);
  assert.equal(C.CX_MAGALU_RE_LOJA.flags, RE_LOJA_MAGALU.flags);
  assert.equal(CAMPOS()[0].padrao, RE_LOJA_MAGALU.source);
});

test('CA1: o cartão da Magalu perde "Ainda não implementado", ganha o campo com ajuda e dica, o link no lugar de "Testar" e nenhum valor no HTML', () => {
  const html = C.cartaoConexao(CARTAO({ config: { loja: 'minhaloja' }, estado: 'pronta' }));
  assert.doesNotMatch(html, /Ainda não implementado|aviso-impl/);
  assert.doesNotMatch(html, /data-testar|Testar/, 'não há botão Testar');
  assert.doesNotMatch(html, /<fieldset|type="password"/);
  assert.match(html, /<h2 id="cx-magalu-h">Magalu \[\?conexoes\.magalu\]<\/h2>/);
  assert.match(html, /<span>Nome da sua loja \[\?conexoes\.magalu\.loja\]<\/span>/);
  const input = html.match(/<input[^>]*name="loja"[^>]*>/)[0];
  for (const attr of ['type="text"', 'id="cx-magalu-loja"', 'autocomplete="off"', 'spellcheck="false"', 'autocapitalize="none"', 'aria-describedby="cx-magalu-loja-dica"']) assert.ok(input.includes(attr), attr);
  assert.match(html, /<small class="dica" id="cx-magalu-loja-dica">É o trecho que vem depois de magazinevoce\.com\.br\/ no endereço da sua loja\. Se o endereço é magazinevoce\.com\.br\/minhaloja, escreva minhaloja\. Só letras, números, hífen e _\.<\/small>/);
  assert.match(html, /<button type="submit" class="pri">Salvar<\/button>/);
  assert.match(html, /data-conferir-box/);
  assert.match(html, /class="desc">Parceiro Magalu \(Magazine Você\): o link de afiliado sai com o nome da sua loja de parceiro\./);
  assert.doesNotMatch(html, /value=/, 'o valor entra por aplicarConexao, nunca no HTML');
  assert.doesNotMatch(html, /minhaloja<|="minhaloja"/);
  assert.match(html, /<p class="estado-linha" id="cx-magalu-estado" role="status"><\/p>/);
  assert.match(html, /<p class="dica" data-magalu-nota hidden><\/p>/);
  // servidor antigo (Magalu ainda não implementada): cartão genérico, sem quebrar
  const antigo = C.cartaoConexao(CARTAO({ implementada: false, estado: 'nao_implementada' }));
  assert.match(antigo, /Ainda não implementado\./); assert.doesNotMatch(antigo, /data-conferir-box|conexoes\.magalu/);
});

test('CA1: os dois selos da Magalu: "Falta configurar" e "Configurada" (nada novo em pillConexao)', () => {
  assert.deepEqual(J(C.pillConexao('falta_configurar', 'magalu')), ['falta', 'Falta configurar']);
  assert.deepEqual(J(C.pillConexao('pronta', 'magalu')), ['pronta', 'Configurada']);
});

test('CA1: o endereço de "Conferir minha loja" é só do nome salvo e válido, com encodeURIComponent; nome fora da regra não gera link', () => {
  const href = (loja) => C.cxMagaluHref({ config: { loja } });
  assert.equal(href('minhaloja'), 'https://www.magazinevoce.com.br/minhaloja/');
  assert.equal(href('Magazine_Fulano-2'), 'https://www.magazinevoce.com.br/Magazine_Fulano-2/');
  assert.equal(href('ab'), 'https://www.magazinevoce.com.br/ab/');
  assert.equal(href('a'.repeat(60)), `https://www.magazinevoce.com.br/${'a'.repeat(60)}/`);
  for (const ruim of ['a', 'a'.repeat(61), 'a/b', '../x', 'a b', 'ação', 'loja.com', 'https://evil.com', '"><script>', 'a\n', "x'y", 'x%2f', '', null, undefined, 7, {}, ['abc']]) assert.equal(href(ruim), '', String(ruim));
  assert.equal(C.cxMagaluHref(null), ''); assert.equal(C.cxMagaluHref({}), ''); assert.equal(C.cxMagaluHref({ config: null }), '');
  // o resultado sempre tem a forma exata, com a loja como único segmento
  assert.match(href('loja-1_x'), /^https:\/\/www\.magazinevoce\.com\.br\/[A-Za-z0-9_-]{2,60}\/$/);
});

test('CA1: o link é um <a> com target=_blank, rel=noopener e "(abre em outra aba)" visível; sem endereço, nada', () => {
  const html = C.cxMagaluLinkHtml('https://www.magazinevoce.com.br/minhaloja/');
  assert.match(html, /^<a class="btn" data-conferir href="https:\/\/www\.magazinevoce\.com\.br\/minhaloja\/" target="_blank" rel="noopener"/);
  assert.match(html, />Conferir minha loja \(abre em outra aba\)<\/a>$/);
  assert.equal(C.cxMagaluLinkHtml(''), '');
  assert.ok(C.cxMagaluLinkHtml('https://x/"><b>').includes('&quot;&gt;&lt;b&gt;'), 'o href passa por esc');
});

/** Um cartão da Magalu em DOM falso (sem "Testar"): formulário, linha de estado, Salvar, selo, caixa do link e nota. */
function novoCartao(respostas = {}) {
  const campos = new Map();
  const campo = (n) => { if (!campos.has(n)) campos.set(n, el()); return campos.get(n); };
  const form = { elements: { namedItem: campo }, onsubmit: null };
  const f = { form, linha: el(), salvar: el(), selo: el(), caixa: el(), nota: el(), campo };
  const mapa = { form, '.estado-linha': f.linha, '[type=submit]': f.salvar, '.cab .estado-pill': f.selo, '[data-conferir-box]': f.caixa, '[data-magalu-nota]': f.nota };
  const C2 = carregarConexoes(respostas, mapa);
  return { C2, ...f, errosMostrados: () => C2.ctx.errosMostrados };
}

test('CA1: aplicarConexao: selo, valor salvo no campo, link só com nome salvo, nota só em "Configurada" e linha de estado', () => {
  const f = novoCartao();
  f.C2.aplicarConexao({}, CARTAO());
  assert.equal(f.selo.className, 'estado-pill falta'); assert.equal(f.selo.textContent, 'Falta configurar');
  assert.equal(f.campo('loja').value, '');
  assert.equal(f.caixa.innerHTML, '', 'sem nome salvo o link não existe');
  assert.equal(f.nota.hidden, true); assert.equal(f.nota.textContent, '');
  assert.equal(f.linha.textContent, 'Nada salvo ainda. Salve o nome da loja para poder conferir.');
  assert.equal(f.linha.classes.has('aviso'), false);
  // nome salvo e válido
  f.C2.aplicarConexao({}, CARTAO({ estado: 'pronta', config: { loja: 'minhaloja' }, updated_at: 1_700_000_000_000 }));
  assert.equal(f.selo.className, 'estado-pill pronta'); assert.equal(f.selo.textContent, 'Configurada');
  assert.equal(f.campo('loja').value, 'minhaloja');
  assert.match(f.caixa.innerHTML, /href="https:\/\/www\.magazinevoce\.com\.br\/minhaloja\/"/);
  assert.equal(f.nota.hidden, false);
  assert.equal(f.nota.textContent, 'O painel não consegue confirmar que o nome existe: use “Conferir minha loja”.');
  assert.equal(f.linha.textContent, 'Dados salvos em 06/11/2026 10:00.');
  // o nome foi apagado (já houve gravação antes): selo volta, link some, a linha pede para salvar o nome
  f.C2.aplicarConexao({}, CARTAO({ estado: 'falta_configurar', config: {}, updated_at: 1_700_000_000_001 }));
  assert.equal(f.selo.textContent, 'Falta configurar'); assert.equal(f.caixa.innerHTML, ''); assert.equal(f.nota.hidden, true);
  assert.equal(f.linha.textContent, 'Dados salvos em 06/11/2026 10:00. Salve o nome da loja para poder conferir.');
  // a nota "o painel não confirma" só vale no selo Configurada (nome válido, mas selo de outro estado: sem nota)
  f.C2.aplicarConexao({}, CARTAO({ estado: 'falta_configurar', config: { loja: 'minhaloja' }, updated_at: 5 }));
  assert.equal(f.nota.hidden, true);
  // o valor salvo no banco fora da regra (mexido à mão): o campo mostra, mas o link não existe
  f.C2.aplicarConexao({}, CARTAO({ estado: 'pronta', config: { loja: '../outra' }, updated_at: 5 }));
  assert.equal(f.caixa.innerHTML, ''); assert.equal(f.nota.hidden, true);
});

test('CA1: o link usa o nome SALVO, nunca o que está digitado no campo', () => {
  const f = novoCartao();
  f.C2.aplicarConexao({}, CARTAO({ estado: 'pronta', config: { loja: 'salva' }, updated_at: 5 }));
  f.campo('loja').value = 'digitada-e-nao-salva';
  assert.match(f.caixa.innerHTML, /\/salva\//); assert.doesNotMatch(f.caixa.innerHTML, /digitada/);
});

test('CA1: validação no cliente: as cinco frases da spec, na ordem (endereço, espaço ou acento, tamanho, outro caractere), sem repetir o valor', () => {
  const c = CAMPOS()[0];
  const erro = (v) => C.cxErroCampoMagalu(c, v);
  const casos = [
    ['https://www.magazinevoce.com.br/minhaloja/', TC.enderecoColado], ['magazinevoce.com.br/minhaloja', TC.enderecoColado], ['minha.loja', TC.enderecoColado],
    ['minha/loja', TC.enderecoColado], ['HTTP://x', TC.enderecoColado], ['magazinevoce.com.br/minha loja', TC.enderecoColado], ['ação.com', TC.enderecoColado], ['minha loja', TC.espacoAcento], ['loja\tx', TC.espacoAcento], ['lojão', TC.espacoAcento],
    ['açaí', TC.espacoAcento], ['a', TC.tamanho], ['a'.repeat(61), TC.tamanho], ['loja!', TC.caractere], ['loja@home', TC.caractere], ['lo$ja', TC.caractere], ['l"oja', TC.caractere],
  ];
  for (const [v, msg] of casos) assert.equal(erro(v), msg, v);
  // nenhuma frase repete o que foi digitado (uma marca única em cada tipo de engano)
  for (const v of ['https://zq9x.com/zq9x', 'zq9x/zq9x', 'zq9x zq9x', 'zq9xão', 'zq9x!', 'z']) assert.ok(!erro(v).includes('zq9x'), v);
  assert.equal(TC.enderecoColado, 'Escreva só o nome da loja, sem o endereço. Se o endereço é magazinevoce.com.br/minhaloja, escreva minhaloja.');
  assert.equal(TC.espacoAcento, 'O nome da loja não leva espaços nem acentos. Copie do endereço da sua loja, depois de magazinevoce.com.br/.');
  assert.equal(TC.tamanho, 'O nome da loja tem de 2 a 60 caracteres.');
  assert.equal(TC.caractere, 'Use só letras, números, hífen ou _ no nome da loja.');
  for (const ok of ['minhaloja', 'ab', 'a'.repeat(60), 'Minha-Loja_1', 'http', 'meuhttp']) assert.equal(erro(ok), '', ok);
  // sem padrão no registro, vale a regra do painel (a mesma do servidor)
  assert.equal(C.cxErroCampoMagalu({ nome: 'loja' }, 'minhaloja'), ''); assert.equal(C.cxErroCampoMagalu({ nome: 'loja' }, 'a b'), TC.espacoAcento);
  // nenhuma frase carrega o valor mesmo com texto comprido ou perigoso
  const perigo = '<img src=x onerror=alert(1)>segredo-123';
  assert.ok(!erro(perigo).includes('segredo-123') && !erro(perigo).includes('<img'));
});

test('CA1: ao salvar, valor inválido leva o foco ao campo e nada é enviado; vazio apaga; nome válido é enviado e repinta o cartão', async () => {
  const f = novoCartao({ 'PUT /conexoes/magalu': () => CARTAO({ estado: 'pronta', config: { loja: 'minhaloja' }, updated_at: 9 }) });
  f.C2.ligarConexao({}, CARTAO());
  const enviar = () => f.form.onsubmit({ preventDefault() {} });
  f.campo('loja').value = 'https://www.magazinevoce.com.br/minhaloja/';
  await enviar();
  assert.deepEqual(f.errosMostrados().map((e) => e.msg), [TC.enderecoColado]);
  assert.equal(f.errosMostrados()[0].el, f.campo('loja'), 'foco no campo');
  assert.deepEqual(f.C2.pedidos, [], 'nada foi enviado');
  f.errosMostrados().length = 0;
  f.campo('loja').value = '  minhaloja  ';
  await enviar();
  assert.deepEqual(f.errosMostrados(), []);
  assert.deepEqual(f.C2.pedidos, ['PUT /conexoes/magalu']);
  assert.deepEqual(J(f.C2.ctx.corpos[0]), { campos: { loja: 'minhaloja' } }, 'sem espaços nas pontas');
  assert.match(f.caixa.innerHTML, /minhaloja\//, 'o cartão repintou com o link do nome salvo');
  assert.equal(f.selo.textContent, 'Configurada');
  // vazio apaga (o servidor responde sem nome; o selo volta)
  const g = novoCartao({ 'PUT /conexoes/magalu': () => CARTAO({ estado: 'falta_configurar', config: {}, updated_at: 10 }) });
  g.C2.ligarConexao({}, CARTAO({ estado: 'pronta', config: { loja: 'minhaloja' }, updated_at: 9 }));
  g.campo('loja').value = '   ';
  await g.form.onsubmit({ preventDefault() {} });
  assert.deepEqual(g.errosMostrados(), []);
  assert.deepEqual(J(g.C2.ctx.corpos[0]), { campos: { loja: '' } });
  assert.equal(g.selo.textContent, 'Falta configurar'); assert.equal(g.caixa.innerHTML, '');
});

test('CA1: o 400 do servidor (frase fixa, sem eco) cai no campo do nome e o botão Salvar volta', async () => {
  const frase = 'Escreva só o nome da loja (o trecho depois de magazinevoce.com.br/), com letras, números, hífen ou _.';
  const f = novoCartao({ 'PUT /conexoes/magalu': () => { throw new Error(frase); } });
  f.C2.ligarConexao({}, CARTAO());
  f.campo('loja').value = 'minhaloja';
  await f.form.onsubmit({ preventDefault() {} });
  assert.deepEqual(f.errosMostrados().map((e) => e.msg), [frase]);
  assert.equal(f.errosMostrados()[0].el, f.campo('loja'));
  assert.equal(f.salvar.disabled, false);
  assert.equal(PLATAFORMAS.magalu.campos[0].erro, frase, 'a frase do painel é a do registro do servidor');
  // erro de outra natureza não rouba o foco do campo
  const g = novoCartao({ 'PUT /conexoes/magalu': () => { throw new Error('Só o Dono pode fazer isso.'); } });
  g.C2.ligarConexao({}, CARTAO());
  g.campo('loja').value = 'minhaloja';
  await g.form.onsubmit({ preventDefault() {} });
  assert.equal(g.errosMostrados()[0].el, undefined);
});

test('CA1: a Magalu não tem Testar: ligarConexao e aplicarConexao funcionam sem esse botão, e as outras lojas ainda o têm', () => {
  const f = novoCartao();
  assert.doesNotThrow(() => f.C2.ligarConexao({}, CARTAO()));
  assert.doesNotThrow(() => f.C2.aplicarConexao({}, CARTAO({ estado: 'pronta', config: { loja: 'minhaloja' }, updated_at: 1 })));
  const facebook = C.cartaoConexao({ id: 'facebook', nome: 'Facebook', implementada: false, estado: 'nao_implementada', descricao: 'y', campos: [{ nome: 'pagina', rotulo: 'Página', tipo: 'texto', max: 60 }], config: {} });
  assert.match(facebook, /data-testar/); assert.match(facebook, /Ainda não implementado/);
  const amazon = C.cartaoConexao({ id: 'amazon', nome: 'Amazon', implementada: true, estado: 'so_tag', descricao: 'x', campos: [{ nome: 'tag', rotulo: 'Tag', tipo: 'texto', max: 40 }], config: {}, segredos_salvos: [] });
  assert.match(amazon, /data-testar/); assert.doesNotMatch(amazon, /autocapitalize|data-conferir-box/);
});

test('CA1: o nome da loja nunca vira HTML: valor perigoso salvo não gera link nem marcação', () => {
  const f = novoCartao();
  f.C2.aplicarConexao({}, CARTAO({ estado: 'pronta', config: { loja: '"><img src=x onerror=alert(1)>' }, updated_at: 1 }));
  assert.equal(f.caixa.innerHTML, '');
  assert.equal(C.cartaoConexao(CARTAO({ config: { loja: '"><img src=x onerror=alert(1)>' } })).includes('onerror'), false);
});
