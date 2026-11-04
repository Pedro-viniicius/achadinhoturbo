// Painel da Shopee (plano integracao-shopee, etapa 9; spec docs/produto/specs/integracao-shopee.md): o Disparo manual
// (public/disparos.js) e o cartão de Conexões (public/conexoes.js). Os arquivos rodam num `vm` com utilitários de app.js
// falsos e um DOM mínimo; nenhuma rede, nenhum servidor. As funções puras (dispShopee*, cx*) são exportadas por texto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { IMAGEM_SHOPEE } from '../src/shopee.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lerPublic = (arq) => fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');
/** Objetos e arrays criados dentro do vm têm outro protótipo: compare por JSON. */
const J = (x) => JSON.parse(JSON.stringify(x));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Elemento falso: valor, HTML, classes e tratadores que a tela pendura; `focado` conta os focus(). */
function el(extra = {}) {
  const classes = new Set(); const attrs = new Map();
  const e = {
    value: '', checked: false, disabled: false, hidden: false, _t: '', _html: '', className: '', placeholder: '', src: '', tabIndex: 0,
    dataset: {}, style: {}, isConnected: true, parentNode: null, focado: 0, filhos: [],
    classes, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle(c, on) { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); } },
    setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute(k) { if (k === 'style') this.style = {}; attrs.delete(k); },
    focus() { this.focado++; }, click() {}, scrollIntoView() {}, closest: () => null, insertBefore() {}, remove() {},
    appendChild(f) { this.filhos.push(f); return f; },
    insertAdjacentHTML(_onde, h) { this._html += h; },
    get textContent() { return this._t; }, set textContent(v) { this._t = String(v); this._html = ''; }, // como no DOM: o texto troca os filhos
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); if (v === '') this.filhos = []; },
    ...extra,
  };
  return e;
}
/** `$` falso: um elemento por seletor (a raiz é ignorada). */
function fabricaDollar() {
  const mapa = new Map();
  const $ = (sel) => { if (!mapa.has(sel)) mapa.set(sel, el()); return mapa.get(sel); };
  return { $, mapa };
}

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
    $, $$: () => [], esc, zap: (x) => String(x), REQ: '*', q: () => '', opcoes: () => '', aviso() {}, mostrarErros() { return false; },
    S: S || { templates: [], tags: [], groups: [], st: {} },
    seletorGrupos: () => ({ html: '', ligar() {}, marcados: () => [] }),
    location: { hash: '#teste', replace() {} }, confirm: () => true, FileReader: class {},
    fetch: fetch || (async () => { throw new Error('rede proibida no teste'); }),
    ...extras,
  };
  vm.createContext(ctx);
  vm.runInContext(`${lerPublic('disparos.js')}\n;globalThis.__x = { dadosOferta, dispShopeeVeredito, dispShopeeAvisoApi, dispShopeeLinhaLoja, dispShopeeFaixa, dispPareceShopeeCurto, dispImgSegura, DISP_IMG_SHOPEE, DISP_IMG_VAZIA, TEXTOS_DISPAROS, paginaDisparoManual };`, ctx);
  return { ...ctx.__x, $, mapa, ctx, campos };
}
const D = carregarDisparos();
const T = D.TEXTOS_DISPAROS;

test('CA2: a regex da foto do painel é a IMAGEM_SHOPEE do servidor (mesmo source e flags) e o resto vira o desenho de sacola', () => {
  assert.equal(D.DISP_IMG_SHOPEE.source, IMAGEM_SHOPEE.source, 'mesma regex nos dois lados');
  assert.equal(D.DISP_IMG_SHOPEE.flags, IMAGEM_SHOPEE.flags);
  for (const ok of ['https://down-br.img.susercontent.com/file/abc', 'https://cf.shopee.com.br/file/abc', 'https://a.b.susercontent.com/x']) {
    assert.equal(D.dispImgSegura(ok), ok, ok);
  }
  for (const ruim of ['http://cf.shopee.com.br/x', 'https://cf.shopee.com.br.evil.com/x', 'https://evil.com/susercontent.com/x', 'https://susercontent.com.evil.com/x',
    'https://susercontent.com/x', 'https://shopee.com.br/x.jpg', 'javascript:alert(1)', '', null, undefined]) {
    assert.equal(D.dispImgSegura(ruim), D.DISP_IMG_VAZIA, String(ruim));
  }
  // o que já valia continua valendo (Mercado Livre e Amazon)
  assert.equal(D.dispImgSegura('https://http2.mlstatic.com/D_NQ_NP.jpg'), 'https://http2.mlstatic.com/D_NQ_NP.jpg');
  assert.equal(D.dispImgSegura('https://m.media-amazon.com/images/I/x.jpg'), 'https://m.media-amazon.com/images/I/x.jpg');
});

const PRODUTO = (extra = {}) => ({ key: 'SHOPEE:1.2', title: 'Fone Bluetooth', price: 79.9, oldPrice: null, discountPct: 15, sold: 1234, freeShipping: false, coupon: null, image: 'https://cf.shopee.com.br/file/x', ...extra });
const VAZIO = () => ({ key: 'SHOPEE:1.2', title: null, price: null, oldPrice: null, discountPct: null, sold: null, freeShipping: null, coupon: null, image: null });
const RESP = (extra = {}) => ({
  loja: { id: 'shopee', nome: 'Shopee', implementada: true }, motivo: null, editavel: true, produto: PRODUTO(), causa: null,
  extra: { loja_nome: 'Loja Boa', nota: 4.8, preco_max: 79.9 }, link_via: 'extensao', causa_link: null, pode_disparar: true, texto: 'x', template_id: 1, ...extra,
});

test('CA2: Identificar completo da Shopee: pronto para disparar, dados preenchidos, sem aviso de preço antigo, "Vai sair pela extensão"', () => {
  const v = D.dispShopeeVeredito(RESP());
  assert.deepEqual({ ...v }, { tipo: 'completo', dados: true, mensagem: 'Shopee · pronto para disparar', destaque: false, link: null, bloqueio: '', via: 'Vai sair pela extensão do Chrome.' });
  assert.equal(D.dispShopeeVeredito(RESP({ link_via: 'api' })).via, 'Vai sair pela API da Shopee.');
  assert.equal(D.dispShopeeVeredito(RESP({ link_via: null })).via, '', 'sem caminho informado: nenhuma frase');
});

test('CA2: dados parciais: lista o que a Shopee não trouxe e mantém Disparar habilitado; preço antigo ausente não é aviso', () => {
  const v = D.dispShopeeVeredito(RESP({ produto: PRODUTO({ image: null, sold: null }) }));
  assert.equal(v.tipo, 'parcial');
  assert.equal(v.mensagem, 'A Shopee não trouxe a foto e as vendas. Preencha abaixo; o que ficar vazio some da mensagem.');
  assert.equal(v.bloqueio, ''); assert.equal(v.dados, true); assert.equal(v.destaque, false);
  assert.equal(D.dispShopeeVeredito(RESP({ produto: PRODUTO({ image: null }) })).mensagem, 'A Shopee não trouxe a foto. Preencha abaixo; o que ficar vazio some da mensagem.');
  assert.equal(D.dispShopeeVeredito(RESP({ produto: PRODUTO({ price: null }) })).tipo, 'parcial');
  assert.equal(D.dispShopeeVeredito(RESP({ produto: PRODUTO({ oldPrice: null }) })).tipo, 'completo', 'oldPrice nulo é o normal da Shopee');
});

test('CA2: causas que bloqueiam (invalido, nao_produto): mensagem, seção de dados fora e motivo ao lado do botão', () => {
  const casos = [
    [RESP({ causa: 'invalido', produto: null, pode_disparar: false }), 'invalido', T.shopee.invalido, 'Cole um link de produto da Shopee.'],
    [RESP({ causa: 'nao_produto', produto: null, pode_disparar: false }), 'nao_produto', 'Este link não leva a um produto específico. Cole o link da página do produto.', 'Cole o link da página do produto.'],
  ];
  for (const [r, tipo, msg, motivo] of casos) {
    const v = D.dispShopeeVeredito(r);
    assert.deepEqual({ ...v }, { tipo, dados: false, mensagem: msg, destaque: true, link: null, bloqueio: motivo, via: '' }, tipo);
  }
  assert.match(T.shopee.invalido, /s\.shopee\.com\.br ou shp\.ee/);
  assert.equal(T.shopee.motivoNaoEncontrado, undefined, 'nao_encontrado não bloqueia: não há motivo ao lado do botão');
  // sem produto e sem causa: tratado como link inválido (nunca habilita)
  assert.equal(D.dispShopeeVeredito(RESP({ produto: null })).bloqueio, 'Cole um link de produto da Shopee.');
  assert.equal(D.dispShopeeVeredito(null).tipo, 'invalido');
  // o link inválido pesa mais que a falta de ID: o dono precisa corrigir o link primeiro
  assert.equal(D.dispShopeeVeredito(RESP({ causa: 'invalido', produto: null, causa_link: 'sem_id', pode_disparar: false })).tipo, 'invalido');
});

test('Decisão do dono: nao_encontrado (fora do programa) não bloqueia nem mostra aviso: os dados ficam em branco para preencher', () => {
  const v = D.dispShopeeVeredito(RESP({ causa: 'nao_encontrado', produto: VAZIO(), extra: null, link_via: 'api', pode_disparar: true }));
  assert.deepEqual({ ...v }, {
    tipo: 'nao_encontrado', dados: true, mensagem: '', destaque: true, link: null, bloqueio: '', via: 'Vai sair pela API da Shopee.',
  });
  assert.equal(T.shopee.naoEncontrado, undefined, 'sem texto de aviso para fora do programa');
  // sem ID ou sem caminho para o link o bloqueio continua, e é por causa do link
  const semId = D.dispShopeeVeredito(RESP({ causa: 'nao_encontrado', produto: VAZIO(), causa_link: 'sem_id', link_via: null, pode_disparar: false }));
  assert.deepEqual([semId.tipo, semId.dados, semId.link.causa, semId.bloqueio], ['nao_encontrado', true, 'sem_id', T.shopee.motivoSemId]);
  const semLink = D.dispShopeeVeredito(RESP({ causa: 'nao_encontrado', produto: VAZIO(), causa_link: 'sem_link', link_via: null, pode_disparar: false }));
  assert.equal(semLink.bloqueio, T.shopee.motivoSemLink);
  // pode_disparar falso do servidor continua valendo
  assert.equal(D.dispShopeeVeredito(RESP({ causa: 'nao_encontrado', produto: VAZIO(), pode_disparar: false })).bloqueio, T.shopee.motivoGeral);
});

test('CA2: causa_link sem_id e sem_link bloqueiam, mostram o segundo aviso com o link para Conexões e mantêm os dados editáveis', () => {
  const semId = D.dispShopeeVeredito(RESP({ causa_link: 'sem_id', pode_disparar: false }));
  assert.equal(semId.dados, true);
  assert.deepEqual({ ...semId.link }, { causa: 'sem_id', texto: 'Shopee identificada, mas falta o ID de afiliado.', acao: 'Cadastre em Conexões.' });
  assert.equal(semId.bloqueio, 'Cadastre o ID de afiliado em Conexões.');
  assert.equal(semId.via, '', 'bloqueado: não promete por onde o link sairia');
  assert.equal(semId.mensagem, 'Dados lidos da Shopee.', 'não diz "pronto para disparar" com o botão travado');
  const semLink = D.dispShopeeVeredito(RESP({ causa_link: 'sem_link', link_via: null, pode_disparar: false }));
  assert.deepEqual({ ...semLink.link }, { causa: 'sem_link', texto: 'Não tenho como gerar o seu link de afiliado agora. Abra o Chrome com a extensão e entre no portal de afiliados da Shopee, ou ligue a API em Conexões.', acao: 'Ir para Conexões' });
  assert.equal(semLink.bloqueio, 'Falta um caminho para o link: Chrome com a extensão ou API.');
  // com os dados em falta também: aviso da API + aviso do link, ambos
  const dois = D.dispShopeeVeredito(RESP({ produto: VAZIO(), causa: 'sem_credenciais', causa_link: 'sem_link', link_via: null, pode_disparar: false }));
  assert.equal(dois.tipo, 'api'); assert.equal(dois.link.causa, 'sem_link'); assert.ok(dois.bloqueio);
});

test('CA2: pode_disparar falso sem outra explicação nunca habilita o botão', () => {
  const v = D.dispShopeeVeredito(RESP({ pode_disparar: false }));
  assert.equal(v.bloqueio, T.shopee.motivoGeral);
  assert.equal(D.dispShopeeVeredito(RESP({ pode_disparar: undefined })).bloqueio, T.shopee.motivoGeral, 'sem o campo, bloqueia');
});

test('CA2: falha dos dados (sem API) vira aviso com campos em branco, Disparar habilitado e o trecho do link conforme link_via', () => {
  const API = (causa, via = 'extensao') => D.dispShopeeVeredito(RESP({ produto: VAZIO(), causa, link_via: via, extra: null }));
  const esperado = {
    credencial_recusada: 'A Shopee não aceitou o AppID ou a Senha da API salvos. Confira em Conexões e use “Testar”. Preencha os dados abaixo; o link sai pelo Chrome.',
    conta_restrita: 'A Shopee recusou o acesso da API a esta conta. Fale com o suporte de afiliados da Shopee. Preencha os dados abaixo; o link sai pelo Chrome.',
    cota: 'A Shopee limitou as consultas por agora. Preencha à mão ou tente de novo em alguns minutos.',
    indisponivel: 'Não consegui buscar os dados na Shopee agora. Preencha o título e o preço abaixo; o link já sai com o seu ID de afiliado.',
  };
  for (const [causa, msg] of Object.entries(esperado)) {
    const v = API(causa);
    assert.equal(v.tipo, 'api', causa); assert.equal(v.mensagem, msg, causa);
    assert.equal(v.dados, true, `${causa}: campos em branco para preencher`); assert.equal(v.destaque, true);
    assert.equal(v.bloqueio, '', `${causa}: não bloqueia`);
  }
  // API não ligada ou sem acesso: sem aviso (mensagem vazia), campos em branco e disparo permitido
  for (const causa of ['sem_credenciais', 'sem_acesso']) {
    const v = API(causa);
    assert.deepEqual([v.tipo, v.mensagem, v.dados, v.bloqueio], ['api', '', true, ''], causa);
    assert.equal(D.dispShopeeAvisoApi(causa, 'api'), '', causa);
  }
  // pela API: "o link sai pela API"; sem caminho: o trecho some
  assert.equal(API('conta_restrita', 'api').mensagem, 'A Shopee recusou o acesso da API a esta conta. Fale com o suporte de afiliados da Shopee. Preencha os dados abaixo; o link sai pela API.');
  assert.equal(D.dispShopeeAvisoApi('indisponivel', null), 'Não consegui buscar os dados na Shopee agora. Preencha o título e o preço abaixo.');
  assert.equal(D.dispShopeeAvisoApi('cota', 'api'), esperado.cota, 'a cota não fala do link');
  // causa que o painel não conhece: vale como "indisponivel"
  assert.equal(D.dispShopeeAvisoApi('causa_nova', 'extensao'), esperado.indisponivel);
  assert.equal(D.dispShopeeAvisoApi('constructor', 'extensao'), esperado.indisponivel);
  // produto sem título e sem preço mesmo sem causa: também é "dados em branco"
  assert.equal(D.dispShopeeVeredito(RESP({ produto: VAZIO(), causa: null })).tipo, 'api');
  // nenhuma frase diz que sem a API não há link
  for (const msg of Object.values(esperado)) assert.doesNotMatch(msg, /não há link|sem link/i);
});

test('CA2: linha secundária (loja, vendas e nota) só com o que veio; nota em texto, nunca só estrelas', () => {
  const linha = D.dispShopeeLinhaLoja;
  assert.equal(linha(PRODUTO(), { loja_nome: 'Loja Boa', nota: 4.8 }), 'Loja: Loja Boa · 1.234 vendidos · nota 4,8 de 5');
  assert.equal(linha(PRODUTO({ sold: 1 }), { loja_nome: 'Loja Boa', nota: 5 }), 'Loja: Loja Boa · 1 vendido · nota 5 de 5');
  assert.equal(linha(PRODUTO({ sold: null }), { loja_nome: 'Loja Boa', nota: null }), 'Loja: Loja Boa');
  assert.equal(linha(PRODUTO({ sold: 0 }), { loja_nome: '', nota: 0 }), '0 vendidos · nota 0 de 5');
  assert.equal(linha(PRODUTO({ sold: null }), null), '');
  assert.equal(linha(PRODUTO({ sold: null }), { loja_nome: '   ', nota: 7 }), '', 'nota fora de 0 a 5 não aparece');
});

test('CA2: faixa de preço: só avisa quando o preço máximo é maior que o atual', () => {
  assert.match(D.dispShopeeFaixa(PRODUTO({ price: 79.9 }), { preco_max: 129.9 }), /^Este produto tem variações de R\$\s79,90 a R\$\s129,90\. Usei o menor preço; ajuste se precisar\.$/);
  assert.equal(D.dispShopeeFaixa(PRODUTO({ price: 79.9 }), { preco_max: 79.9 }), '');
  assert.equal(D.dispShopeeFaixa(PRODUTO({ price: 79.9 }), { preco_max: null }), '');
  assert.equal(D.dispShopeeFaixa(PRODUTO({ price: null }), { preco_max: 10 }), '');
  assert.equal(D.dispShopeeFaixa(PRODUTO(), null), '');
});

test('CA2: "Resolvendo o link…" só para os links curtos da Shopee', () => {
  for (const ok of ['https://s.shopee.com.br/AbC123', 'https://shp.ee/xyz', 'https://shope.ee/xyz', 'HTTPS://S.SHOPEE.COM.BR/x']) assert.equal(D.dispPareceShopeeCurto(ok), true, ok);
  for (const nao of ['https://shopee.com.br/produto-i.1.2', 'https://s.shopee.com.br.evil.com/x', 'https://evil.com/s.shopee.com.br', 'nao é url', '', undefined]) assert.equal(D.dispPareceShopeeCurto(nao), false, String(nao));
});

// ---------------- dadosOferta: desconto informado pela Shopee
/** dadosOferta num vm com a seção "Dados da oferta" falsa, que guarda o HTML e a dica do desconto. */
function carregarDados() {
  const campos = new Map(); const dica = el(); let html = '';
  const campo = (n) => { if (!campos.has(n)) campos.set(n, el()); return campos.get(n); };
  const base = carregarDisparos({ extras: { document: { createElement: () => ({ dataset: {}, set innerHTML(v) { html = v; }, get innerHTML() { return html; }, elements: { namedItem: campo } }), getElementById: () => null, activeElement: null, body: el() },
    $: (sel) => (sel === '[data-desc-dica]' ? dica : el()) } });
  return { dadosOferta: base.dadosOferta, campo, dica, html: () => html };
}

test('CA3: dadosOferta com desconto informado: o campo mostra o percentual da Shopee; mexeu no preço, é descartado e recalculado', () => {
  const x = carregarDados();
  const dados = x.dadosOferta(PRODUTO({ price: 80, discountPct: 15 }), () => {}, { descontoInformado: 15, fonte: 'Shopee' });
  const digitar = (n, v) => { x.campo(n).value = v; x.campo(n).oninput(); };
  assert.equal(x.campo('oldPrice').value, '', 'a Shopee não traz preço antigo: o campo fica vazio');
  assert.equal(x.campo('desconto').value, '15%');
  assert.equal(x.dica.textContent, 'Informado pela Shopee.');
  assert.equal(dados.valores().discountPct, 15, 'a prévia usa o desconto informado');
  assert.equal(dados.valores().oldPrice, null, 'nenhum preço antigo inventado');
  digitar('title', 'Outro título');
  assert.equal(x.campo('desconto').value, '15%', 'título não muda o desconto');
  digitar('price', '70,00');
  assert.equal(x.campo('desconto').value, '—', 'preço mudou: o desconto informado cai (sem preço antigo, não há desconto)');
  assert.equal(x.dica.textContent, 'Calculado dos dois preços.');
  assert.equal(dados.valores().discountPct, 0);
  digitar('price', '80,00');
  assert.equal(x.campo('desconto').value, '15%'); assert.equal(x.dica.textContent, 'Informado pela Shopee.', 'voltou ao preço da Shopee');
  digitar('oldPrice', '100,00');
  assert.equal(x.campo('desconto').value, '20%', 'com os dois preços vale a conta'); assert.equal(x.dica.textContent, 'Calculado dos dois preços.');
  // o que vai ao servidor nunca leva desconto, preço antigo inventado, link nem URL de foto
  assert.deepEqual(Object.keys(dados.ajustes()).sort(), ['coupon', 'freeShipping', 'oldPrice', 'price', 'title']);
});

test('CA3: sem desconto informado (dados em branco) a dica é a de sempre; a Amazon, sem opções, não muda a dica', () => {
  const x = carregarDados();
  x.dadosOferta(VAZIO(), () => {}, { descontoInformado: null, fonte: 'Shopee' });
  assert.equal(x.campo('desconto').value, '—'); assert.equal(x.dica.textContent, 'Calculado dos dois preços.');
  const y = carregarDados();
  const amazon = y.dadosOferta({ title: 'Fone', price: 80, oldPrice: null, discountPct: 20 }, () => {});
  assert.equal(y.campo('desconto').value, '20%'); assert.equal(y.dica.textContent, '', 'a Amazon não ganhou a frase "Informado pela"');
  assert.equal(amazon.valores().discountPct, 20);
});

test('CA3: a nota da faixa de preço entra sob o Preço atual, ligada por aria-describedby; sem faixa, nada', () => {
  const x = carregarDados();
  x.dadosOferta(PRODUTO(), () => {}, { fonte: 'Shopee', notaPreco: 'Este produto tem variações <b>x</b>' });
  assert.match(x.html(), /name="price"[^>]*aria-describedby="do\d+-faixa"/);
  assert.match(x.html(), /<small id="do\d+-faixa" data-faixa>Este produto tem variações &lt;b&gt;x&lt;\/b&gt;<\/small>/, 'texto escapado');
  const y = carregarDados();
  y.dadosOferta(PRODUTO(), () => {}, { fonte: 'Shopee', notaPreco: '' });
  assert.doesNotMatch(y.html(), /data-faixa/);
});

// ---------------- a página do Disparo manual, de ponta a ponta com um servidor falso
/** Resposta adiada: `esperar()` devolve a promessa; `soltar(valor)` a resolve. */
function adiada() { let soltar; const p = new Promise((r) => { soltar = r; }); return { p, soltar }; }

/**
 * Abre paginaDisparoManual com um fetch falso. `rotas` = { 'METODO /api/caminho': ({corpo}) => { status, json } | Promise }.
 * → { t (elementos), pedidos, erros (mostrarErros), erroTitulos, S }
 */
function abrirDisparo(rotas, { whats = 'open' } = {}) {
  const pedidos = []; const erros = [];
  const S = { templates: [{ id: 1, name: 'Padrão', body: '{TITULO}' }], tags: [{ id: 2, name: 'etqa' }], groups: [], st: { whatsapp: { status: whats }, extensao: { online: false }, ajustes: { link_mode: 'extension' }, simulacao: false } };
  const base = {
    'POST /api/templates/preview': () => ({ status: 200, json: { texto: 'prévia' } }),
    'GET /api/envios?tipo=oferta': () => ({ status: 200, json: { linhas: [], agendadas: [], contadores: {} } }),
    'GET /api/conexoes': () => ({ status: 200, json: [{ id: 'shopee', config: { id_afiliado: '98765432101' } }] }),
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
const AGUARDA = () => new Promise((r) => setImmediate(r));

test('CA2: link curto da Shopee: "Resolvendo o link…" enquanto identifica; depois o cartão com loja, vendas e nota, dados e Disparar habilitado', async () => {
  const id = adiada();
  const a = abrirDisparo({ 'POST /api/disparo/identificar': () => id.p });
  a.$('#dm-url').value = 'https://s.shopee.com.br/AbC123';
  const espera = a.$('#dm-identificar').onclick();
  assert.match(a.$('#dm-prod').innerHTML, /Resolvendo o link…/, 'link curto: estado de resolução');
  assert.equal(a.$('#dm-identificar').textContent, 'Identificando…'); assert.equal(a.$('#dm-identificar').disabled, true);
  assert.equal(a.$('#dm-disparar').disabled, true);
  id.soltar({ status: 200, json: RESP() });
  await espera;
  const prod = a.$('#dm-prod').innerHTML;
  assert.match(prod, /Fone Bluetooth/); assert.match(prod, />Shopee</, 'chip da loja');
  assert.match(prod, /Shopee · pronto para disparar/);
  assert.match(prod, /Loja: Loja Boa · 1\.234 vendidos · nota 4,8 de 5/);
  assert.match(prod, /src="https:\/\/cf\.shopee\.com\.br\/file\/x"/, 'foto do CDN da Shopee');
  assert.doesNotMatch(prod, /Resolvendo/);
  assert.equal(a.$('#dm-dados').filhos.length, 1, 'a seção Dados da oferta entrou');
  assert.equal(a.$('#dm-disparar').disabled, false, a.$('#dm-motivo').textContent);
  assert.equal(a.$('#dm-etq').hidden, true, 'sem o select de etiquetas do Mercado Livre');
  assert.equal(a.$('#dm-etq-amazon').hidden, true);
  assert.equal(a.$('#dm-etq-shopee').hidden, false);
  await AGUARDA();
  assert.match(a.$('[data-etq-txt]').innerHTML, /O link curto de afiliado da Shopee é gerado na hora de disparar ou agendar, pela API ou pela extensão do Chrome, com o ID …2101 \(de <a href="#conexoes">Conexões<\/a> &gt; Shopee\)\./);
  assert.doesNotMatch(a.$('[data-etq-txt]').innerHTML, /98765432101/, 'só os 4 últimos dígitos');
  assert.equal(a.$('[data-etq-via]').textContent, 'Vai sair pela extensão do Chrome.');
  // o corpo do Identificar leva a url colada; sem etiqueta do ML relevante
  assert.equal(a.pedidos.find((p) => p.url === '/api/disparo/identificar').corpo.url, 'https://s.shopee.com.br/AbC123');
});

test('CA2: link longo da Shopee não mostra "Resolvendo"; "não está disponível neste servidor" aparece como aviso, sem quebrar', async () => {
  const a = abrirDisparo({ 'POST /api/disparo/identificar': () => ({ status: 400, json: { erro: 'A integração com a Shopee não está disponível neste servidor.' } }) });
  a.$('#dm-url').value = 'https://shopee.com.br/Fone-i.123.456';
  const espera = a.$('#dm-identificar').onclick();
  assert.doesNotMatch(a.$('#dm-prod').innerHTML, /Resolvendo/);
  await espera;
  assert.match(a.$('#dm-prod').innerHTML, /A integração com a Shopee não está disponível neste servidor\./);
  assert.equal(a.$('#dm-disparar').disabled, true);
  assert.equal(a.$('#dm-identificar').disabled, false, 'o botão Identificar volta');
});

test('CA2: sem_link e sem_id: dados editáveis, segundo aviso com link para Conexões e Disparar desabilitado com o motivo ao lado', async () => {
  for (const [causaLink, aviso, motivo] of [['sem_link', /Não tenho como gerar o seu link de afiliado agora[\s\S]*Ir para Conexões/, 'Falta um caminho para o link: Chrome com a extensão ou API.'],
    ['sem_id', /Shopee identificada, mas falta o ID de afiliado\.[\s\S]*Cadastre em Conexões\./, 'Cadastre o ID de afiliado em Conexões.']]) {
    const a = abrirDisparo({ 'POST /api/disparo/identificar': () => ({ status: 200, json: RESP({ causa_link: causaLink, link_via: null, pode_disparar: false }) }) });
    a.$('#dm-url').value = 'https://shopee.com.br/Fone-i.123.456';
    await a.$('#dm-identificar').onclick();
    assert.match(a.$('#dm-prod').innerHTML, aviso, causaLink);
    assert.match(a.$('#dm-prod').innerHTML, /href="#conexoes"/);
    assert.equal(a.$('#dm-prod').style.display, 'grid');
    assert.equal(a.$('#dm-dados').filhos.length, 1, `${causaLink}: dados continuam editáveis`);
    assert.equal(a.$('#dm-disparar').disabled, true, causaLink);
    assert.equal(a.$('#dm-motivo').textContent, motivo, causaLink);
    assert.equal(a.$('[data-etq-via]').textContent, '', `${causaLink}: não promete a via`);
  }
});

test('CA2: nao_produto e invalido: sem seção de dados, Disparar desabilitado com o motivo', async () => {
  for (const [r, texto, motivo] of [
    [RESP({ causa: 'nao_produto', produto: null, pode_disparar: false }), /Este link não leva a um produto específico/, 'Cole o link da página do produto.'],
    [RESP({ causa: 'invalido', produto: null, pode_disparar: false }), /Não reconheci este link da Shopee/, 'Cole um link de produto da Shopee.']]) {
    const a = abrirDisparo({ 'POST /api/disparo/identificar': () => ({ status: 200, json: r }) });
    a.$('#dm-url').value = 'https://shopee.com.br/Fone-i.123.456';
    await a.$('#dm-identificar').onclick();
    assert.match(a.$('#dm-prod').innerHTML, texto, r.causa);
    assert.equal(a.$('#dm-dados').filhos.length, 0, `${r.causa}: sem dados`);
    assert.equal(a.$('#dm-disparar').disabled, true, r.causa);
    assert.equal(a.$('#dm-motivo').textContent, motivo, r.causa);
  }
});

test('Decisão do dono: nao_encontrado mostra "Dados da oferta" em branco, sem cartão de aviso, e deixa Disparar habilitado', async () => {
  const a = abrirDisparo({ 'POST /api/disparo/identificar': () => ({ status: 200, json: RESP({ causa: 'nao_encontrado', produto: VAZIO(), extra: null, link_via: 'api', pode_disparar: true }) }) });
  a.$('#dm-url').value = 'https://shopee.com.br/Fone-i.123.456';
  await a.$('#dm-identificar').onclick();
  assert.equal(a.$('#dm-prod').innerHTML, '', 'sem cartão de aviso');
  assert.equal(a.$('#dm-dados').filhos.length, 1, 'dados da oferta para preencher');
  assert.equal(a.$('#dm-disparar').disabled, false, a.$('#dm-motivo').textContent);
  assert.doesNotMatch(a.$('#dm-prod').innerHTML, /<img/, 'sem produto, sem foto');
});

test('CA2: sem_acesso (API ainda não liberada): sem cartão, o dono preenche à mão e Disparar fica habilitado (o link sai pelo Chrome)', async () => {
  const a = abrirDisparo({ 'POST /api/disparo/identificar': () => ({ status: 200, json: RESP({ produto: VAZIO(), causa: 'sem_acesso', extra: null }) }) });
  a.$('#dm-url').value = 'https://shopee.com.br/Fone-i.123.456';
  await a.$('#dm-identificar').onclick();
  assert.equal(a.$('#dm-prod').innerHTML, '', 'sem_acesso: nenhum cartão de aviso');
  assert.equal(a.$('#dm-dados').filhos.length, 1);
  assert.equal(a.$('#dm-disparar').disabled, false, a.$('#dm-motivo').textContent);
  assert.doesNotMatch(a.$('#dm-prod').innerHTML, /<img/, 'sem produto, sem foto');
});

test('Sem aviso técnico: Amazon sem_credenciais e Shopee sem_credenciais/sem_acesso deixam #dm-prod vazio; cota e indisponivel continuam avisando', async () => {
  const amazon = (causa) => ({ loja: { id: 'amazon', nome: 'Amazon', implementada: true }, motivo: null, editavel: true, causa, tag_salva: true,
    produto: { key: 'ASIN:B0ABC12345', asin: 'B0ABC12345', title: null, price: null, oldPrice: null, discountPct: null, image: null }, texto: 'x', template_id: 1 });
  const identificar = async (json, url) => {
    const a = abrirDisparo({ 'POST /api/disparo/identificar': () => ({ status: 200, json }) });
    a.$('#dm-url').value = url; await a.$('#dm-identificar').onclick(); return a;
  };
  const URL_AMZ = 'https://www.amazon.com.br/dp/B0ABC12345'; const URL_SHP = 'https://shopee.com.br/Fone-i.123.456';
  const vazia = await identificar(amazon('sem_credenciais'), URL_AMZ);
  assert.equal(vazia.$('#dm-prod').innerHTML, '', 'Amazon sem_credenciais: nenhum cartão');
  assert.equal(vazia.$('#dm-dados').filhos.length, 1, 'os campos continuam em branco'); assert.equal(vazia.$('#dm-disparar').disabled, false, vazia.$('#dm-motivo').textContent);
  for (const [causa, texto] of [['cota', /limitou as consultas|tente de novo/i], ['indisponivel', /Não consegui|preencha/i]]) {
    const a = await identificar(amazon(causa), URL_AMZ);
    assert.match(a.$('#dm-prod').innerHTML, /card-prod aviso/, `Amazon ${causa}: o aviso continua`); assert.match(a.$('#dm-prod').innerHTML, texto, causa);
  }
  for (const causa of ['sem_credenciais', 'sem_acesso']) {
    const a = await identificar(RESP({ produto: VAZIO(), causa, extra: null }), URL_SHP);
    assert.equal(a.$('#dm-prod').innerHTML, '', `Shopee ${causa}: nenhum cartão`);
    assert.equal(a.$('#dm-dados').filhos.length, 1); assert.equal(a.$('#dm-disparar').disabled, false, causa);
  }
  for (const causa of ['cota', 'indisponivel', 'credencial_recusada', 'conta_restrita']) {
    const a = await identificar(RESP({ produto: VAZIO(), causa, extra: null }), URL_SHP);
    assert.match(a.$('#dm-prod').innerHTML, /card-prod aviso/, `Shopee ${causa}: o aviso continua`);
  }
  // o aviso do link continua, porque bloqueia o disparo
  const bloq = await identificar(RESP({ produto: VAZIO(), causa: 'sem_credenciais', causa_link: 'sem_link', link_via: null, pode_disparar: false, extra: null }), URL_SHP);
  const cartoes = (a) => (a.$('#dm-prod').innerHTML.match(/card-prod/g) || []).length;
  assert.equal(cartoes(bloq), 1, 'só o aviso do link');
  assert.match(bloq.$('#dm-prod').innerHTML, /Não tenho como gerar o seu link/); assert.doesNotMatch(bloq.$('#dm-prod').innerHTML, /busca automática|AppID/);
  assert.equal(bloq.$('#dm-disparar').disabled, true);
  const semId = await identificar(RESP({ produto: VAZIO(), causa: 'sem_credenciais', causa_link: 'sem_id', link_via: null, pode_disparar: false, extra: null }), URL_SHP);
  assert.equal(cartoes(semId), 1); assert.match(semId.$('#dm-prod').innerHTML, /falta o ID de afiliado/); assert.equal(semId.$('#dm-disparar').disabled, true);
});

test('CA3: Disparar na Shopee mostra "Gerando o seu link…" até o servidor responder e manda os ajustes sem link nem etiqueta', async () => {
  const envio = adiada();
  const a = abrirDisparo({
    'POST /api/disparo/identificar': () => ({ status: 200, json: RESP() }),
    'POST /api/envios': () => envio.p,
  });
  a.$('#dm-url').value = 'https://shopee.com.br/Fone-i.123.456';
  await a.$('#dm-identificar').onclick();
  const espera = a.$('#dm-disparar').onclick();
  assert.equal(a.$('#dm-disparar').textContent, 'Gerando o seu link…', 'pode levar até 90 s: o botão diz o que acontece');
  assert.equal(a.$('#dm-motivo').textContent, 'Gerando o seu link…');
  assert.equal(a.$('#dm-form').getAttribute('aria-busy'), 'true');
  envio.soltar({ status: 200, json: { id: 7, status: 'pendente' } });
  await espera;
  const corpo = a.pedidos.find((p) => p.url === '/api/envios').corpo;
  assert.equal(corpo.tipo, 'oferta'); assert.equal(corpo.url, 'https://shopee.com.br/Fone-i.123.456'); assert.equal(corpo.tag_id, null, 'a Shopee não usa etiqueta do ML');
  assert.deepEqual(Object.keys(corpo.ajustes).sort(), ['coupon', 'freeShipping', 'oldPrice', 'price', 'title'], 'só o que o dono pode editar (a foto da Shopee não vai: o servidor a relê)');
  assert.equal(corpo.ajustes.oldPrice, null, 'preço antigo nulo: nada inventado');
  assert.doesNotMatch(JSON.stringify(corpo), /s\.shopee\.com\.br|link_afiliado|"link"/, 'nunca manda link');
  assert.equal(a.$('#dm-disparar').textContent, 'Disparar', 'terminou: o botão volta');
});

test('CA3: as três falhas do servidor ao gerar o link aparecem em .erros com o texto do servidor, sem gravar nada e com os dados intactos', async () => {
  const falhas = [
    'O Chrome está logado em outra conta de afiliado da Shopee. Entre na conta do ID …2101 e tente de novo.',
    'Não há sessão de afiliado da Shopee neste Chrome. Entre no portal de afiliados e tente de novo.',
    'A Shopee não gerou o seu link agora. Tente de novo em alguns minutos.',
  ];
  let i = 0;
  const a = abrirDisparo({
    'POST /api/disparo/identificar': () => ({ status: 200, json: RESP() }),
    'POST /api/envios': () => ({ status: 400, json: { erro: falhas[i++] } }),
  });
  a.$('#dm-url').value = 'https://shopee.com.br/Fone-i.123.456';
  await a.$('#dm-identificar').onclick();
  for (const msg of falhas) {
    a.erros.length = 0;
    await a.$('#dm-disparar').onclick();
    assert.deepEqual(a.erros.map((e) => e.msg), [msg], 'o texto é o do servidor, sem repetir ID nem credencial');
    assert.equal(a.$('.erros').focado > 0, true, 'o foco vai para o erro');
    assert.equal(a.$('#dm-dados').filhos.length, 1, 'os dados editados continuam na tela');
    assert.match(a.$('#dm-prod').innerHTML, /Fone Bluetooth/, 'o produto continua identificado');
    assert.equal(a.$('#dm-disparar').textContent, 'Disparar');
  }
  assert.equal(a.pedidos.filter((p) => p.url === '/api/envios').length, 3);
});

test('CA3: agendar na Shopee também mostra "Gerando o seu link…" e o corpo é o do agendado de hoje', async () => {
  const envio = adiada();
  const a = abrirDisparo({ 'POST /api/disparo/identificar': () => ({ status: 200, json: RESP() }), 'POST /api/envios': () => envio.p });
  a.$('#dm-url').value = 'https://shopee.com.br/Fone-i.123.456';
  await a.$('#dm-identificar').onclick();
  a.$('#dm-agendar').checked = true; a.$('#dm-agendar').onchange();
  a.$('#dm-hora').value = '23:59'; a.$('#dm-hora').oninput?.();
  assert.equal(a.$('#dm-disparar').textContent, 'Agendar envio');
  const espera = a.$('#dm-disparar').onclick();
  // perto da meia-noite a hora pode já ter passado: então o painel recusa antes de chamar o servidor
  if (a.pedidos.some((p) => p.url === '/api/envios')) {
    assert.equal(a.$('#dm-disparar').textContent, 'Gerando o seu link…');
    envio.soltar({ status: 200, json: { id: 8, status: 'pendente' } });
  }
  await espera;
  const corpo = a.pedidos.find((p) => p.url === '/api/envios')?.corpo;
  if (corpo) { assert.equal(corpo.quando, 'agendado'); assert.equal(corpo.agendar_hhmm, '23:59'); }
});

test('CA2: a prévia usa o link ilustrativo da Shopee e o desconto informado; trocar o link limpa o resultado e a etiqueta volta ao select do ML', async () => {
  const a = abrirDisparo({
    'POST /api/disparo/identificar': () => ({ status: 200, json: RESP() }),
    'POST /api/templates/preview': ({ corpo }) => ({ status: 200, json: { texto: `prévia ${corpo.amostra?.link ?? ''} ${corpo.amostra?.discountPct ?? ''}` } }),
  });
  a.$('#dm-url').value = 'https://shopee.com.br/Fone-i.123.456';
  await a.$('#dm-identificar').onclick();
  assert.equal(a.$('#dm-pv-leg').textContent, 'Mostra os dados acima. O link de afiliado é gerado na hora do envio.');
  // o dono muda o título: a prévia sai do servidor com o link ilustrativo da Shopee e o desconto da Shopee
  a.campos.get('title').value = 'Outro'; a.campos.get('title').oninput();
  await new Promise((r) => setTimeout(r, 300));
  const previa = a.pedidos.filter((p) => p.url === '/api/templates/preview').at(-1).corpo.amostra;
  assert.equal(previa.link, 'https://s.shopee.com.br/(gerado ao disparar)');
  assert.equal(previa.discountPct, 15); assert.equal(previa.oldPrice, null); assert.equal(previa.sold, 1234);
});

test('CA2: trocar o link depois de identificar limpa o resultado, os dados e o aviso, e a etiqueta volta ao select do Mercado Livre', async () => {
  const a = abrirDisparo({ 'POST /api/disparo/identificar': () => ({ status: 200, json: RESP({ causa_link: 'sem_link', link_via: null, pode_disparar: false }) }) });
  a.S.st.extensao.online = true;
  a.$('#dm-url').value = 'https://shopee.com.br/Fone-i.123.456';
  await a.$('#dm-identificar').onclick();
  assert.equal(a.$('#dm-etq-shopee').hidden, false); assert.equal(a.$('#dm-prod').style.display, 'grid');
  a.$('#dm-url').value = 'https://shopee.com.br/Outro-i.1.9'; a.$('#dm-url').oninput();
  assert.equal(a.$('#dm-prod').innerHTML, ''); assert.equal(a.$('#dm-dados').filhos.length, 0);
  assert.equal(a.$('#dm-etq-shopee').hidden, true); assert.equal(a.$('#dm-etq').hidden, false);
  assert.equal(a.$('#dm-prod').style.display, undefined, 'o grid do aviso não sobra para a próxima identificação');
  assert.equal(a.$('#dm-motivo').textContent, 'Identifique o link do produto.');
});

// ================================================================== Conexões (public/conexoes.js)
function carregarConexoes(respostas = {}, mapa = null) {
  const { $: dollar } = fabricaDollar();
  const pedidos = [];
  const ctx = {
    console, Number, String, Array, Object, Math, Date, JSON, RegExp, Promise, Error,
    $: (sel) => (mapa ? mapa[sel] ?? null : dollar(sel)), $$: () => [], esc, q: (chave) => `[?${chave}]`, REQ: '*', S: {}, aviso() {}, tentar: (f) => f, dataHora: () => '03/11/2026 10:00',
    mostrarErros: (_f, lista) => { ctx.errosMostrados.push(...lista); return lista.length > 0; }, errosMostrados: [],
    api: async (url, metodo = 'GET') => { pedidos.push(`${metodo} ${url}`); const r = respostas[`${metodo} ${url}`]; return typeof r === 'function' ? r() : r; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${lerPublic('conexoes.js')}\n;globalThis.__x = { pillConexao, cartaoConexao, aplicarConexao, ligarConexao, lerFormConexao, cxLinhaEstado, cxTestarBloqueado, cxFraseTeste, cxExtLinha, cxAvisoShopee, cxErroCampoShopee, cxCruzaShopee, TEXTOS_CONEXOES };`, ctx);
  return { ...ctx.__x, ctx, pedidos };
}
const C = carregarConexoes();

const CAMPOS_SHOPEE = [
  { nome: 'id_afiliado', rotulo: 'ID de afiliado', tipo: 'texto', max: 20, padrao: '^[0-9]{5,20}$', ajuda: 'Só números. Ex.: 98765432101. É o número da sua conta de afiliado da Shopee. Vai nos seus links e define de quem é a comissão. Não é o AppID e não é a tag da Amazon.' },
  { nome: 'app_id', rotulo: 'AppID', tipo: 'texto', max: 20, padrao: '^[0-9]{1,20}$', ajuda: 'Número do aplicativo, mostrado na página da API de Afiliados da Shopee. Diferente do ID de afiliado.' },
  { nome: 'chave', rotulo: 'Senha da API', tipo: 'segredo', max: 128, padrao: '^[!-~]{8,128}$', ajuda: 'A senha fica guardada no seu computador e não volta para esta tela. Deixe em branco para manter a salva.' },
];
const CARTAO = (extra = {}) => ({
  id: 'shopee', nome: 'Shopee', implementada: true, descricao: 'Programa de Afiliados da Shopee. O link curto de afiliado sai pela extensão do Chrome ou pela API; com a API, o painel também busca título, preço e foto do produto.',
  campos: CAMPOS_SHOPEE, config: {}, segredos_salvos: [], estado: 'falta_configurar', situacao: { acesso: 'nao_configurada', verificado_em: null, motivo: 'A busca de dados da Shopee não está ligada (faltam o AppID e a Senha da API em Conexões).' },
  extensao_online: false, updated_at: null, ...extra,
});

test('CA5: os 6 selos da Shopee, com texto e classe de .estado-pill (so_id depende da extensão); as outras lojas não mudam', () => {
  const P = (estado, online = false) => C.pillConexao(estado, 'shopee', { extensao_online: online });
  assert.deepEqual(J(P('falta_configurar')), ['falta', 'Falta configurar']);
  assert.deepEqual(J(P('so_id', true)), ['pronta', 'Só com o ID']);
  assert.deepEqual(J(P('so_id', false)), ['pendente', 'Só com o ID']);
  assert.deepEqual(J(P('sem_acesso')), ['pendente', 'Sem acesso à API']);
  assert.deepEqual(J(P('pronta')), ['', 'Credenciais salvas'], 'neutro: sem classe de cor');
  assert.deepEqual(J(P('conectada')), ['conectado', 'Conectada']);
  assert.deepEqual(J(P('erro_credencial')), ['erro', 'Credencial recusada']);
  assert.deepEqual(J(C.pillConexao('qualquer', 'shopee')), ['impl', 'Ainda não implementado']);
  // Amazon e Magalu como antes
  assert.deepEqual(J(C.pillConexao('so_tag', 'amazon')), ['pendente', 'Só com a tag']);
  assert.deepEqual(J(C.pillConexao('pronta', 'amazon')), ['', 'Credencial salva']);
  assert.deepEqual(J(C.pillConexao('nao_implementada', 'magalu')), ['impl', 'Ainda não implementado']);
  assert.deepEqual(J(C.pillConexao('pronta', 'magalu')), ['pronta', 'Configurada']);
});

test('CA5: o cartão da Shopee tem os dois fieldset com as legends, os rótulos e as dicas da spec, e nunca valor de segredo no HTML', () => {
  const html = C.cartaoConexao(CARTAO({ config: { id_afiliado: '55566677788', app_id: '777888999' }, segredos_salvos: ['chave'] }));
  const legends = [...html.matchAll(/<legend>([^<]*)<\/legend>/g)].map((m) => m[1]);
  assert.deepEqual(legends, ['Sua conta de afiliado', 'Acesso à API']);
  assert.equal([...html.matchAll(/<fieldset>/g)].length, 2);
  const [conta, api] = html.split('</fieldset>');
  assert.match(conta, /name="id_afiliado"[^>]*inputmode="numeric"|inputmode="numeric"[^>]*name="id_afiliado"/);
  assert.match(conta, /<span>ID de afiliado \[\?conexoes\.shopee\.id\]<\/span>/);
  assert.match(conta, /Não é o AppID e não é a tag da Amazon\./, 'dica sempre visível');
  assert.match(conta, /aria-describedby="cx-shopee-id_afiliado-dica"/);
  assert.doesNotMatch(conta, /name="app_id"|name="chave"/);
  assert.match(api, /Estes dois só existem depois que a Shopee liberar a API\. Pode deixar em branco: os links já saem pela extensão\./);
  assert.match(api, /<span>AppID \[\?conexoes\.shopee\.appid\]<\/span>/);
  assert.match(api, /<span>Senha da API \[\?conexoes\.shopee\.senha\]<\/span>/);
  assert.match(api, /type="password"[^>]*autocomplete="new-password"|autocomplete="new-password"/);
  assert.match(api, /A senha fica guardada no seu computador e não volta para esta tela\./);
  assert.doesNotMatch(html, /value=/, 'nenhum valor em atributo: ID, AppID e Senha entram só pelo JavaScript');
  assert.doesNotMatch(html, /777888999|55566677788/, 'nem o AppID nem o ID no HTML do cartão');
  assert.match(html, /<button type="button" data-testar aria-describedby="cx-shopee-estado">Testar<\/button>/);
  assert.match(html, /<h2 id="cx-shopee-h">Shopee \[\?conexoes\.shopee\]<\/h2>/);
  assert.doesNotMatch(html, /Ainda não implementado/, 'implementada: o aviso genérico sai');
});

test('CA5: linha da extensão em role=status, com "✓"/"!" em texto; .off quando desconectada', () => {
  const on = C.cartaoConexao(CARTAO({ extensao_online: true }));
  assert.match(on, /<p class="ext-linha" role="status" data-ext><span data-ext-txt>✓ Extensão do Chrome conectada\. Os links da Shopee saem por ela, com o Chrome logado no portal de afiliados\.<\/span>/);
  const off = C.cartaoConexao(CARTAO({ extensao_online: false }));
  assert.match(off, /<p class="ext-linha off" role="status" data-ext><span data-ext-txt>! Extensão do Chrome desconectada\. Abra o Chrome com a extensão e entre no portal de afiliados da Shopee, ou ligue a API abaixo\.<\/span>/);
  assert.match(C.cartaoConexao(CARTAO({ extensao_online: undefined })), /ext-linha off/, 'sem a informação, trata como desconectada');
  assert.deepEqual({ ...C.cxExtLinha(CARTAO({ extensao_online: true })) }, { texto: C.TEXTOS_CONEXOES.shopee.extOn, off: false });
});

test('CA5: aviso "Antes de usar": .aviso-corpo com .passos, link externo seguro e a frase de fechamento; recolhido em <details> quando conectada', () => {
  const aviso = C.cxAvisoShopee(CARTAO());
  assert.match(aviso, /^<div class="aviso-impl"><div class="aviso-corpo">/);
  assert.match(aviso, /<p><b>Antes de usar: deixe o Chrome pronto e, se quiser a busca automática, peça a API\.<\/b><\/p>/);
  assert.equal([...aviso.matchAll(/<li>/g)].length, 3);
  assert.match(aviso, /<ol class="passos">/);
  assert.match(aviso, /recarregue a extensão em <code>chrome:\/\/extensions<\/code>/);
  assert.match(aviso, /<a href="https:\/\/affiliate\.shopee\.com\.br\/open_api" target="_blank" rel="noopener">Open API de Afiliados \(abre em outra aba\)<\/a>/);
  assert.match(aviso, /<a href="https:\/\/help\.shopee\.com\.br\/portal\/webform\/[0-9a-f]+" target="_blank" rel="noopener">formulário de atendimento da Shopee \(abre em outra aba\)<\/a>/);
  assert.match(aviso, /A Shopee responde em até 3 dias úteis\./);
  assert.match(aviso, /Sem a API você já dispara: só precisa preencher título e preço à mão\./);
  assert.doesNotMatch(aviso, /<details>/, 'antes de conectada fica sempre visível');
  for (const a of aviso.match(/<a [^>]*>/g)) assert.match(a, /target="_blank" rel="noopener"/);
  // sem_acesso: outro título, o resto igual
  const sem = C.cxAvisoShopee(CARTAO({ estado: 'sem_acesso' }));
  assert.match(sem, /<b>A Shopee ainda não liberou a API para a sua conta\.<\/b>/);
  assert.match(sem, /Sem a API você já dispara/); assert.match(sem, /<li><b>Para os links:<\/b>/);
  // conectada: recolhido
  const ok = C.cxAvisoShopee(CARTAO({ estado: 'conectada' }));
  assert.match(ok, /<details><summary>Como configurar<\/summary>/);
  assert.match(ok, /<\/details><\/div><\/div>$/);
});

test('CA5: "Testar" só com AppID e Senha da API salvos; a linha de estado diz por quê (e o botão aponta para ela)', () => {
  assert.equal(C.cxTestarBloqueado(CARTAO()), true);
  assert.equal(C.cxTestarBloqueado(CARTAO({ config: { id_afiliado: '98765432101' }, updated_at: 1 })), true, 'só o ID: não dá para testar a API');
  assert.equal(C.cxTestarBloqueado(CARTAO({ config: { app_id: '123' }, segredos_salvos: [], updated_at: 1 })), true, 'AppID sem Senha');
  assert.equal(C.cxTestarBloqueado(CARTAO({ config: { app_id: '123' }, segredos_salvos: ['chave'], updated_at: 1 })), false);
  // Operador não vê quais segredos existem (segredos_salvos ausente): com AppID, deixa o servidor decidir (403 "Só o Dono")
  assert.equal(C.cxTestarBloqueado(CARTAO({ config: { app_id: '123' }, segredos_salvos: undefined, updated_at: 1 })), false);
  assert.equal(C.cxTestarBloqueado(CARTAO({ config: {}, segredos_salvos: undefined })), true);
  // outras lojas: como antes (depois de salvar algo)
  assert.equal(C.cxTestarBloqueado({ id: 'amazon', updated_at: null }), true);
  assert.equal(C.cxTestarBloqueado({ id: 'amazon', updated_at: 1 }), false);

  const so = C.cxLinhaEstado(CARTAO({ estado: 'so_id', config: { id_afiliado: '98765432101' }, updated_at: 1_700_000_000_000 }));
  assert.equal(so.texto, 'Dados salvos em 03/11/2026 10:00. Para testar, salve o AppID e a Senha da API. Eles aparecem depois que a Shopee liberar a API.');
  assert.equal(so.aviso, false, 'so_id não é erro');
  assert.equal(C.cxLinhaEstado(CARTAO()).texto, 'Nada salvo ainda. Para testar, salve o AppID e a Senha da API. Eles aparecem depois que a Shopee liberar a API.');
  const pronto = C.cxLinhaEstado(CARTAO({ estado: 'pronta', config: { id_afiliado: '98765432101', app_id: '123' }, segredos_salvos: ['chave'], updated_at: 1 }));
  assert.equal(pronto.texto, 'Dados salvos em 03/11/2026 10:00.');
});

test('CA5: estado pronta sem ID de afiliado avisa "Falta o ID de afiliado"; a falha da última verificação continua em texto ao recarregar', () => {
  const semId = C.cxLinhaEstado(CARTAO({ estado: 'pronta', config: { app_id: '123' }, segredos_salvos: ['chave'], updated_at: 1 }));
  assert.equal(semId.texto, 'Falta o ID de afiliado. Sem ele os links não saem. Dados salvos em 03/11/2026 10:00.');
  assert.equal(semId.aviso, true);
  const motivo = 'A Shopee ainda não liberou a API para a sua conta.';
  for (const acesso of ['sem_acesso', 'credencial_recusada', 'conta_restrita', 'cota', 'indisponivel']) {
    const l = C.cxLinhaEstado(CARTAO({ estado: 'sem_acesso', config: { id_afiliado: '98765432101', app_id: '1' }, segredos_salvos: ['chave'], updated_at: 1, situacao: { acesso, verificado_em: 5, motivo } }));
    assert.equal(l.texto, `${motivo} Dados salvos em 03/11/2026 10:00.`, acesso); assert.equal(l.aviso, true, acesso);
  }
  // ok, desconhecido, nao_configurada e sem frase: nada de falha (o motivo do "não configurada" é do servidor e não entra na linha)
  for (const situacao of [{ acesso: 'ok', verificado_em: 1, motivo: null }, { acesso: 'desconhecido', verificado_em: null, motivo: null },
    { acesso: 'nao_configurada', verificado_em: null, motivo: 'A busca de dados da Shopee não está ligada (faltam o AppID e a Senha da API em Conexões).' }, { acesso: 'sem_acesso', verificado_em: 1, motivo: null }, undefined]) {
    const l = C.cxLinhaEstado(CARTAO({ estado: 'pronta', config: { id_afiliado: '98765432101', app_id: '1' }, segredos_salvos: ['chave'], updated_at: 1, situacao }));
    assert.equal(l.texto, 'Dados salvos em 03/11/2026 10:00.', JSON.stringify(situacao)); assert.equal(l.aviso, false);
  }
  // outra loja nunca mostra o motivo
  assert.equal(C.cxLinhaEstado({ id: 'magalu', updated_at: 1, situacao: { acesso: 'sem_acesso', motivo } }).aviso, false);
});

test('CA5: resultado do Testar por `resultado`: sucesso com ✓, falhas em aviso, sem_id (ok falso) em aviso, frase da tela e nunca o valor digitado', () => {
  const F = (r) => C.cxFraseTeste(CARTAO(), r);
  assert.deepEqual({ ...F({ ok: true, resultado: 'ok', mensagem: 'x' }) }, { frase: 'Credenciais aceitas pela Shopee.', ok: true, aviso: false });
  assert.match(F({ ok: false, resultado: 'recusada' }).frase, /^A Shopee não aceitou o AppID ou a Senha da API\. Confira se copiou os dois por inteiro, sem espaços/);
  assert.match(F({ ok: false, resultado: 'sem_acesso' }).frase, /^A Shopee ainda não liberou a API para a sua conta\. Peça o acesso pelo link acima .* os links continuam saindo pela extensão\.$/);
  assert.match(F({ ok: false, resultado: 'conta_restrita' }).frase, /^A Shopee recusou o acesso desta conta .*Fale com o suporte de afiliados da Shopee\.$/);
  assert.equal(F({ ok: false, resultado: 'cota' }).frase, 'A Shopee limitou as consultas por agora. Tente de novo em alguns minutos.');
  assert.equal(F({ ok: false, resultado: 'indisponivel' }).frase, 'A Shopee não respondeu agora. Tente de novo em alguns minutos.');
  assert.equal(F({ ok: false, resultado: 'nao_configurada' }).frase, 'Salve o AppID e a Senha da API para testar.');
  assert.deepEqual({ ...F({ ok: false, resultado: 'sem_id' }) }, { frase: 'Credenciais aceitas, mas falta o ID de afiliado.', ok: false, aviso: true }, 'sucesso parcial, em aviso');
  for (const r of ['recusada', 'sem_acesso', 'conta_restrita', 'cota', 'indisponivel', 'nao_configurada']) assert.equal(F({ ok: false, resultado: r }).aviso, true, r);
  // resultado desconhecido: vale a frase do servidor; sem nada, vazio (nunca "undefined")
  assert.equal(F({ ok: false, resultado: 'novo', mensagem: 'Frase do servidor.' }).frase, 'Frase do servidor.');
  assert.equal(F({ ok: false, resultado: 'constructor' }).frase, '');
  assert.equal(F({}).frase, '');
  // a Amazon continua como antes: no sucesso vale a frase do servidor (com a dica da tag)
  assert.equal(C.cxFraseTeste({ id: 'amazon' }, { ok: true, resultado: 'ok', mensagem: 'Credencial aceita pela Amazon. Cadastre a tag.' }).frase, 'Credencial aceita pela Amazon. Cadastre a tag.');
  assert.match(C.cxFraseTeste({ id: 'amazon' }, { ok: false, resultado: 'recusada', mensagem: 'x' }).frase, /^A Amazon não aceitou a credencial\./);
});

// ---------------- validação no cliente e o cartão em DOM falso
/** Um cartão da Shopee em DOM falso: formulário com os campos, linha de estado, Testar, Salvar, selo, linha da extensão e aviso. */
function novoCartao(respostas = {}) {
  const campos = new Map();
  const campo = (n) => { if (!campos.has(n)) campos.set(n, el()); return campos.get(n); };
  const form = { elements: { namedItem: campo }, onsubmit: null };
  const f = { form, linha: el(), testar: el(), salvar: el(), selo: el(), ctxApi: el(), txt: el(), ext: el(), antes: el(), campo };
  const mapa = { form, '.estado-linha': f.linha, '[data-testar]': f.testar, '[type=submit]': f.salvar, '.cab .estado-pill': f.selo, '[data-ctx-api]': f.ctxApi, '[data-ext-txt]': f.txt, '[data-ext]': f.ext, '[data-antes]': f.antes };
  const C2 = carregarConexoes(respostas, mapa);
  return { C2, ...f, errosMostrados: () => C2.ctx.errosMostrados };
}

test('CA5: validação do cliente: ID com letras ou traço parece tag da Amazon (sem repetir o valor); formatos; AppID igual ao ID', () => {
  const C2 = carregarConexoes();
  const c = (nome) => CAMPOS_SHOPEE.find((x) => x.nome === nome);
  const tag = 'seunome-20';
  const msgTag = C2.cxErroCampoShopee(c('id_afiliado'), tag);
  assert.equal(msgTag, 'O ID de afiliado da Shopee tem só números. O que você digitou parece uma tag da Amazon: ela vai em Conexões > Amazon.');
  assert.ok(!msgTag.includes(tag), 'não repete o valor');
  assert.equal(C2.cxErroCampoShopee(c('id_afiliado'), 'abc12345'), msgTag);
  assert.equal(C2.cxErroCampoShopee(c('id_afiliado'), '123'), 'ID de afiliado: use só números, como 98765432101.');
  assert.equal(C2.cxErroCampoShopee(c('id_afiliado'), '123 456 789'), 'ID de afiliado: use só números, como 98765432101.');
  assert.equal(C2.cxErroCampoShopee(c('id_afiliado'), '1'.repeat(21)), 'ID de afiliado: use só números, como 98765432101.');
  assert.equal(C2.cxErroCampoShopee(c('id_afiliado'), '98765432101'), '');
  assert.equal(C2.cxErroCampoShopee(c('app_id'), '12a4'), 'AppID: use só números.');
  assert.equal(C2.cxErroCampoShopee(c('app_id'), '123456789'), '');
  assert.equal(C2.cxErroCampoShopee(c('app_id'), '1'.repeat(21)), 'AppID: até 20 caracteres.');
  assert.equal(C2.cxErroCampoShopee(c('chave'), 'curta'), 'Senha da API: formato inválido. Confira se copiou o valor inteiro, sem espaços.');
  assert.equal(C2.cxErroCampoShopee(c('chave'), 'SenhaLonga123'), '');
  // AppID = ID de afiliado (inclusive com zeros à esquerda como o servidor), só quando os dois estão preenchidos
  const igual = 'O AppID e o ID de afiliado são números diferentes. Confira os dois no portal da Shopee.';
  assert.equal(C2.cxCruzaShopee({ id_afiliado: '98765432101', app_id: '98765432101' }), igual);
  assert.equal(C2.cxCruzaShopee({ id_afiliado: '98765432101', app_id: '0098765432101' }), igual);
  assert.equal(C2.cxCruzaShopee({ id_afiliado: '98765432101', app_id: '123456789' }), '');
  assert.equal(C2.cxCruzaShopee({ id_afiliado: '', app_id: '' }), '');
  assert.equal(C2.cxCruzaShopee({ app_id: '123' }), '');
});

test('CA5: ao salvar, o erro de campo leva o foco ao campo e nada é enviado; AppID = ID erra no AppID; valores certos são enviados', async () => {
  const f = novoCartao({ 'PUT /conexoes/shopee': () => CARTAO({ estado: 'so_id', config: { id_afiliado: '98765432101' }, updated_at: 1 }) });
  const p = CARTAO();
  f.C2.ligarConexao({}, p);
  const enviar = () => f.form.onsubmit({ preventDefault() {} });
  f.campo('id_afiliado').value = 'seunome-20'; f.campo('app_id').value = ''; f.campo('chave').value = '';
  await enviar();
  assert.deepEqual(f.errosMostrados().map((e) => e.msg), ['O ID de afiliado da Shopee tem só números. O que você digitou parece uma tag da Amazon: ela vai em Conexões > Amazon.']);
  assert.equal(f.errosMostrados()[0].el, f.campo('id_afiliado'), 'foco no campo errado');
  assert.deepEqual(f.C2.pedidos, [], 'nada foi enviado');
  f.errosMostrados().length = 0;
  f.campo('id_afiliado').value = '98765432101'; f.campo('app_id').value = '98765432101';
  await enviar();
  assert.equal(f.errosMostrados()[0].msg, 'O AppID e o ID de afiliado são números diferentes. Confira os dois no portal da Shopee.');
  assert.equal(f.errosMostrados()[0].el, f.campo('app_id'), 'o erro cai no AppID');
  assert.deepEqual(f.C2.pedidos, []);
  f.errosMostrados().length = 0;
  f.campo('app_id').value = '';
  await enviar();
  assert.deepEqual(f.errosMostrados(), []);
  assert.deepEqual(f.C2.pedidos, ['PUT /conexoes/shopee']);
});

test('CA5: o 400 do servidor para AppID = ID (a outra aba mudou o ID, por exemplo) também cai no campo AppID', async () => {
  const f = novoCartao({ 'PUT /conexoes/shopee': () => { throw new Error('O AppID e o ID de afiliado são números diferentes. Confira os dois no portal da Shopee.'); } });
  f.C2.ligarConexao({}, CARTAO({ config: { id_afiliado: '98765432101' } }));
  f.campo('id_afiliado').value = '98765432101'; f.campo('app_id').value = '123456789';
  await f.form.onsubmit({ preventDefault() {} });
  assert.equal(f.errosMostrados().at(-1).el, f.campo('app_id'));
  assert.equal(f.salvar.disabled, false, 'o botão Salvar volta');
});

test('CA5: aplicarConexao: valores nos campos, Senha vazia com placeholder, Testar travado sem credenciais, selo e linha da extensão', () => {
  const f = novoCartao();
  f.C2.aplicarConexao({}, CARTAO({ estado: 'so_id', extensao_online: true, config: { id_afiliado: '98765432101' }, updated_at: 5 }));
  assert.equal(f.campo('id_afiliado').value, '98765432101');
  assert.equal(f.campo('app_id').value, '');
  assert.equal(f.campo('chave').value, ''); assert.equal(f.campo('chave').placeholder, '');
  assert.equal(f.testar.disabled, true);
  assert.equal(f.selo.className, 'estado-pill pronta'); assert.equal(f.selo.textContent, 'Só com o ID');
  assert.equal(f.txt.textContent, C2texto('extOn')); assert.equal(f.ext.classes.has('off'), false);
  assert.equal(f.ctxApi.hidden, false, 'sem credenciais salvas, a linha de contexto aparece');
  assert.match(f.antes.innerHTML, /Antes de usar/);
  assert.equal(f.linha.classes.has('aviso'), false);
  // extensão caiu: o selo muda para aviso e a linha vira .off
  f.C2.aplicarConexao({}, CARTAO({ estado: 'so_id', extensao_online: false, config: { id_afiliado: '98765432101' }, updated_at: 5 }));
  assert.equal(f.selo.className, 'estado-pill pendente'); assert.equal(f.ext.classes.has('off'), true); assert.match(f.txt.textContent, /^! Extensão do Chrome desconectada/);
  // credenciais salvas: Testar liberado, linha de contexto some, placeholder de "salva"
  f.C2.aplicarConexao({}, CARTAO({ estado: 'pronta', config: { id_afiliado: '98765432101', app_id: '123456789' }, segredos_salvos: ['chave'], updated_at: 6 }));
  assert.equal(f.testar.disabled, false); assert.equal(f.ctxApi.hidden, true);
  assert.equal(f.campo('chave').placeholder, '•••••••• salva; digite para trocar'); assert.equal(f.campo('chave').disabled, false);
  assert.equal(f.selo.textContent, 'Credenciais salvas'); assert.equal(f.selo.className, 'estado-pill ');
  // conectada: o aviso recolhe em <details>
  f.C2.aplicarConexao({}, CARTAO({ estado: 'conectada', config: { id_afiliado: '98765432101', app_id: '123456789' }, segredos_salvos: ['chave'], updated_at: 7 }));
  assert.match(f.antes.innerHTML, /<details><summary>Como configurar<\/summary>/);
  assert.equal(f.selo.className, 'estado-pill conectado');
  // Operador: sem segredos_salvos, a Senha fica travada com a explicação
  f.C2.aplicarConexao({}, CARTAO({ segredos_salvos: undefined }));
  assert.equal(f.campo('chave').disabled, true); assert.equal(f.campo('chave').placeholder, 'Só o Dono vê e troca esta chave.');
  // pronta sem ID: linha em aviso
  f.C2.aplicarConexao({}, CARTAO({ estado: 'pronta', config: { app_id: '123456789' }, segredos_salvos: ['chave'], updated_at: 8 }));
  assert.equal(f.linha.classes.has('aviso'), true); assert.match(f.linha.textContent, /^Falta o ID de afiliado\. Sem ele os links não saem\./);
});
function C2texto(chave) { return C.TEXTOS_CONEXOES.shopee[chave]; }

test('CA5: Testar na Shopee: "Testando…", frase por resultado, relê o cartão (selo novo) e devolve o botão pela regra de AppID e Senha', async () => {
  const cartaoNovo = CARTAO({ estado: 'sem_acesso', config: { id_afiliado: '98765432101', app_id: '123456789' }, segredos_salvos: ['chave'], updated_at: 9, extensao_online: true,
    situacao: { acesso: 'sem_acesso', verificado_em: 9, motivo: 'A Shopee ainda não liberou a API para a sua conta.' } });
  let resposta = { ok: false, resultado: 'sem_acesso', mensagem: 'qualquer coisa', campos: [] };
  const f = novoCartao({ 'POST /conexoes/shopee/testar': () => resposta, 'GET /conexoes': [cartaoNovo] });
  const inicial = CARTAO({ estado: 'pronta', config: { id_afiliado: '98765432101', app_id: '123456789' }, segredos_salvos: ['chave'], updated_at: 9 });
  f.C2.ligarConexao({}, inicial);
  const espera = f.testar.onclick();
  assert.equal(f.testar.textContent, 'Testando…'); assert.equal(f.testar.disabled, true);
  await espera;
  assert.match(f.linha.textContent, /^A Shopee ainda não liberou a API para a sua conta\. Peça o acesso pelo link acima/);
  assert.equal(f.linha.classes.has('aviso'), true);
  assert.equal(f.selo.textContent, 'Sem acesso à API'); assert.equal(f.selo.className, 'estado-pill pendente');
  assert.match(f.antes.innerHTML, /A Shopee ainda não liberou a API para a sua conta\./, 'o aviso muda para a variante sem_acesso');
  assert.equal(f.testar.textContent, 'Testar'); assert.equal(f.testar.disabled, false, 'AppID e Senha salvos: pode testar de novo');
  // sucesso
  resposta = { ok: true, resultado: 'ok', mensagem: 'x', campos: ['title'] };
  await f.testar.onclick();
  assert.equal(f.linha.innerHTML, '<span class="nivel-ok">✓ Credenciais aceitas pela Shopee.</span>'); assert.equal(f.linha.classes.has('aviso'), false);
  // sem_id: aviso, sem ✓
  resposta = { ok: false, resultado: 'sem_id', mensagem: 'x', campos: [] };
  await f.testar.onclick();
  assert.equal(f.linha.textContent, 'Credenciais aceitas, mas falta o ID de afiliado.'); assert.equal(f.linha.classes.has('aviso'), true);
  assert.doesNotMatch(f.linha.innerHTML, /nivel-ok/);
  // erro de rede do painel: a frase da exceção, em aviso
  resposta = null;
  f.C2.ctx.api = async () => { throw new Error('Sem resposta do programa.'); };
  await f.testar.onclick();
  assert.equal(f.linha.textContent, 'Sem resposta do programa.');
});

test('CA5: nenhuma tela mostra a Senha da API (nem em HTML, nem na frase do teste); o servidor nunca a manda, e a tela não a pede', () => {
  const senha = 'Senha-API-Shopee-SECRETA-7x9y';
  const html = C.cartaoConexao(CARTAO({ config: { id_afiliado: '98765432101', app_id: '123456789' }, segredos_salvos: ['chave'] }));
  assert.ok(!html.includes(senha));
  for (const r of ['ok', 'recusada', 'sem_acesso', 'conta_restrita', 'cota', 'indisponivel', 'nao_configurada', 'sem_id']) {
    assert.ok(!C.cxFraseTeste(CARTAO(), { ok: r === 'ok', resultado: r, mensagem: senha }).frase.includes(senha), r);
  }
  // o único `type=password` do cartão é a Senha da API, e a Shopee não tem outro segredo
  assert.equal([...html.matchAll(/type="password"/g)].length, 1);
});

test('as outras lojas seguem iguais: o cartão da Amazon continua sem fieldset e o do Magalu com o aviso "Ainda não implementado"', () => {
  const amazon = C.cartaoConexao({ id: 'amazon', nome: 'Amazon', implementada: true, estado: 'so_tag', descricao: 'x', campos: [{ nome: 'tag', rotulo: 'Tag', tipo: 'texto', max: 40, ajuda: 'a' }, { nome: 'credencial_id', rotulo: 'ID', tipo: 'segredo', max: 80 }], config: {}, segredos_salvos: [] });
  assert.doesNotMatch(amazon, /<fieldset/); assert.doesNotMatch(amazon, /ext-linha|inputmode/);
  assert.match(amazon, /Antes de usar a API:/); assert.match(amazon, /\[\?conexoes\.segredo\]/, 'o segredo da Amazon mantém a ajuda genérica');
  const magalu = C.cartaoConexao({ id: 'magalu', nome: 'Magalu', implementada: false, estado: 'nao_implementada', descricao: 'y', campos: [{ nome: 'loja', rotulo: 'Nome da sua loja', tipo: 'texto', max: 60 }], config: {} });
  assert.match(magalu, /Ainda não implementado\./); assert.doesNotMatch(magalu, /<fieldset/);
  // Shopee que o servidor ainda não implementa (servidor antigo): cai no cartão genérico, sem quebrar
  const antiga = C.cartaoConexao(CARTAO({ implementada: false, estado: 'nao_implementada' }));
  assert.match(antiga, /Ainda não implementado\./); assert.doesNotMatch(antiga, /ext-linha|<fieldset/);
});
