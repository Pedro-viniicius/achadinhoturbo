// Cartão "Catálogo do Etiqueta" em Conexões (plano fonte-catalogo-etiqueta, etapa 6; spec
// docs/produto/specs/fonte-catalogo-etiqueta.md, seção 1). public/conexoes.js roda num `vm` com utilitários de app.js
// falsos e um DOM mínimo; nenhuma rede, nenhum Etiqueta. As funções puras `cxCat*` são exportadas por texto.
// CA2 (cartão, Testar, estados), CA8 (o token nunca aparece; o painel só fala com /api) e CA9 (texto cru escapado).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { RE_ENDERECO_CATALOGO, RE_CAMINHO_TOKEN } from '../src/lojas.js';
import { createConexoes } from '../src/conexoes.js';
import { openDb } from '../src/db.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTE = fs.readFileSync(path.join(RAIZ, 'public', 'conexoes.js'), 'utf8');
/** Objetos e arrays criados dentro do vm têm outro protótipo: compare por JSON. */
const J = (x) => JSON.parse(JSON.stringify(x));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TOKEN = 'Tk_0123456789abcdefghijklmnopqrstuvwxyzABCD'; // formato do token do Etiqueta (falso)
const MALICIOSO = `<img src=x onerror="alert('xss')">Casa & "Cozinha" 'top'`;

/** Elemento falso: valor, HTML, classes e tratadores; `focado` conta os focus(). */
function el(extra = {}) {
  const classes = new Set();
  return {
    value: '', disabled: false, hidden: false, _t: '', _html: '', className: '', placeholder: '', dataset: {}, focado: 0,
    classes, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle(c, on) { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); } },
    focus() { this.focado++; },
    get textContent() { return this._t; }, set textContent(v) { this._t = String(v); this._html = esc(v); },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); this._t = String(v).replace(/<[^>]*>/g, ''); },
    ...extra,
  };
}

/**
 * Carrega public/conexoes.js num vm. `respostas` = { 'METODO /caminho': valor | função }. `$` acha um elemento por
 * seletor (a raiz é ignorada): o cartão inteiro vive num mapa só.
 */
function carregar(respostas = {}) {
  const campos = new Map();
  const campo = (n) => { if (!campos.has(n)) campos.set(n, el()); return campos.get(n); };
  const form = { elements: { namedItem: campo }, onsubmit: null, oninput: null };
  const d = { form, linha: el(), testar: el(), salvar: el(), selo: el(), cats: el(), campo };
  const mapa = { form, '.estado-linha': d.linha, '[data-testar]': d.testar, '[type=submit]': d.salvar, '.cab .estado-pill': d.selo, '[data-cats]': d.cats };
  const pedidos = []; const avisos = []; const errosMostrados = [];
  const ctx = {
    console, Number, String, Array, Object, Math, Date, JSON, RegExp, Promise, Error,
    $: (sel) => mapa[sel] ?? null, $$: () => [], esc, q: (chave) => `[?${chave}]`, REQ: '*', S: {}, tentar: (f) => f,
    dataHora: () => '03/11/2026 10:00', aviso: (m) => avisos.push(m),
    mostrarErros: (_f, lista) => { errosMostrados.push(...lista); return lista.length > 0; },
    api: async (url, metodo = 'GET', corpo) => {
      pedidos.push({ req: `${metodo} ${url}`, corpo: corpo === undefined ? undefined : J(corpo) });
      const r = respostas[`${metodo} ${url}`]; return typeof r === 'function' ? r(corpo) : r;
    },
    fetch: async () => { throw new Error('o painel nunca chama a rede direto'); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${FONTE}\n;globalThis.__x = { pillConexao, cartaoConexao, aplicarConexao, ligarConexao, TEXTOS_CONEXOES,
    CX_CAT_RE_ENDERECO, CX_CAT_RE_CAMINHO, CX_CAT_PARECE_TOKEN, cxCatSoLeitura, cxCatTestarBloqueado, cxCatMudou, cxCatErros,
    cxCatCampoDoErro, cxCatFrase, cxCatFraseTeste, cxCatLinha, cxCatLinhaHtml, cxCatCategorias, cartaoCatalogo };`, ctx);
  return { ...ctx.__x, ctx, d, pedidos, avisos, errosMostrados };
}
const C = carregar();
const TC = C.TEXTOS_CONEXOES.catalogo;

const CAMPOS = [
  { nome: 'endereco', rotulo: 'Endereço do Etiqueta', tipo: 'texto', max: 40, padrao: RE_ENDERECO_CATALOGO.source, ajuda: 'x' },
  { nome: 'caminho_token', rotulo: 'Arquivo do token', tipo: 'texto', max: 500, padrao: RE_CAMINHO_TOKEN.source, ajuda: 'y' },
];
const SALVO = { endereco: 'http://localhost:8765', caminho_token: '/home/dono/etiqueta/api_token.txt' };
const CATS = [
  { nome: 'Casa', total: 1500, lojas: { amazon: 700, ml: 600, shopee: 200 } },
  { nome: 'Eletrônicos', total: 2353, lojas: { amazon: 800, ml: 1200, shopee: 353 } },
];
/** Cartão como o GET /api/conexoes manda para o Dono (`segredos_salvos: []`). */
const CARTAO = (extra = {}) => ({
  id: 'catalogo', nome: 'Catálogo do Etiqueta', implementada: true, descricao: 'd', campos: CAMPOS, config: {}, segredos_salvos: [],
  estado: 'falta_configurar', situacao: { resultado: null, verificado_em: null, falha_desde: null, mensagem: null },
  verificacao: { categorias: [], total: 0, verificado_em: null }, endereco_padrao: 'http://127.0.0.1:8765', updated_at: null, ...extra,
});
const CONECTADA = (extra = {}) => CARTAO({
  config: SALVO, estado: 'conectada', updated_at: 1_700_000_000_000,
  situacao: { resultado: 'ok', verificado_em: 1_700_000_100_000, falha_desde: null, mensagem: 'Conectado. 3.853 ofertas em 2 categorias.' },
  verificacao: { categorias: CATS, total: 3853, verificado_em: 1_700_000_100_000 }, ...extra,
});

// ================================================================== regras iguais às do servidor
test('CA2/CA8: as regexes do painel são as do servidor (mesmo source e flags) e "parece o token" recusa o mesmo que o PUT', (t) => {
  assert.equal(C.CX_CAT_RE_ENDERECO.source, RE_ENDERECO_CATALOGO.source); assert.equal(C.CX_CAT_RE_ENDERECO.flags, RE_ENDERECO_CATALOGO.flags);
  assert.equal(C.CX_CAT_RE_CAMINHO.source, RE_CAMINHO_TOKEN.source); assert.equal(C.CX_CAT_RE_CAMINHO.flags, RE_CAMINHO_TOKEN.flags);
  // o servidor de verdade (createConexoes.salvar) e o cliente concordam sobre o que é o token colado no lugar do caminho
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-catpainel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openDb(dir); t.after(() => db.close());
  const conexoes = createConexoes({ db });
  const amostras = [TOKEN, `/${TOKEN}`, `~/${TOKEN}`, 'a'.repeat(32), 'a'.repeat(31), `/home/x/${TOKEN}`, `${TOKEN}.txt`, '/home/dono/api_token.txt', `~/${'a'.repeat(31)}`];
  for (const caminho of amostras) {
    const cliente = C.cxCatErros({ endereco: 'http://localhost:8765', caminho_token: caminho }).some((e) => e.msg === TC.pareceToken);
    let servidor = false;
    try { conexoes.salvar('catalogo', { campos: { caminho_token: caminho } }, true); } catch (e) { servidor = e.message === TC.pareceToken; }
    assert.equal(cliente, servidor, `${caminho.slice(0, 12)}…: cliente ${cliente}, servidor ${servidor}`);
  }
});

// ================================================================== selo
test('CA2: os 6 selos do Catálogo com texto e classe de .estado-pill; as outras lojas não mudam', () => {
  const P = (e) => J(C.pillConexao(e, 'catalogo'));
  assert.deepEqual(P('falta_configurar'), ['falta', 'Falta configurar']);
  assert.deepEqual(P('salva'), ['', 'Salvo, ainda não testado'], 'neutro');
  assert.deepEqual(P('conectada'), ['conectado', 'Conectada']);
  assert.deepEqual(P('token_recusado'), ['erro', 'Token recusado']);
  assert.deepEqual(P('indisponivel'), ['pendente', 'Indisponível']);
  assert.deepEqual(P('sem_arquivo'), ['erro', 'Arquivo do token não encontrado']);
  assert.deepEqual(P('estado_novo'), ['impl', 'Ainda não implementado'], 'estado desconhecido: o genérico');
  assert.deepEqual(J(C.pillConexao('so_id', 'shopee', { extensao_online: true })), ['pronta', 'Só com o ID']);
  assert.deepEqual(J(C.pillConexao('so_tag', 'amazon')), ['pendente', 'Só com a tag']);
  assert.deepEqual(J(C.pillConexao('pronta', 'magalu')), ['pronta', 'Configurada']);
});

// ================================================================== HTML do cartão
test('CA2: cartão com subtítulo, fieldset, os dois campos de texto da spec (nenhum password, nenhum value=), Testar ligado à linha', () => {
  const html = C.cartaoConexao(CONECTADA());
  assert.match(html, /^<article class="card conexao conexao-catalogo" id="cx-catalogo" aria-labelledby="cx-catalogo-h">/);
  assert.match(html, /<h2 id="cx-catalogo-h">Catálogo do Etiqueta \[\?conexoes\.catalogo\]<\/h2><p class="sub">Fonte de ofertas<\/p>/);
  assert.match(html, /<span class="estado-pill"><\/span><\/header>/);
  assert.match(html, /Não tem relação com as etiquetas do Mercado Livre\./);
  assert.match(html, /<form novalidate>\s*<fieldset><legend>Como falar com o Etiqueta<\/legend>/);
  const endereco = html.match(/<input[^>]*name="endereco"[^>]*>/)[0];
  assert.match(endereco, /type="text"/); assert.match(endereco, /inputmode="url"/); assert.match(endereco, /autocomplete="off"/); assert.match(endereco, /spellcheck="false"/);
  assert.match(endereco, /aria-describedby="cx-catalogo-endereco-dica"/);
  assert.match(html, /<span>Endereço do Etiqueta \[\?conexoes\.catalogo\.endereco\]<\/span>/);
  assert.match(html, /Só vale endereço deste computador: localhost ou 127\.0\.0\.1\. Já vem preenchido com o padrão\./);
  const caminho = html.match(/<input[^>]*name="caminho_token"[^>]*>/)[0];
  assert.match(caminho, /type="text"/); assert.match(caminho, /class="mono"/); assert.match(caminho, /autocomplete="off"/); assert.match(caminho, /spellcheck="false"/);
  assert.match(caminho, /placeholder="\/home\/ufla\/Documentos\/mensagensParaEnviar\/api_token\.txt"/);
  assert.match(html, /<span>Arquivo do token \[\?conexoes\.catalogo\.token\]<\/span>/);
  assert.match(html, /Cole o <b>caminho<\/b>, nunca o conteúdo: o painel lê o arquivo e o token não passa por esta tela\./);
  assert.doesNotMatch(html, /type="password"/, 'o caminho não é segredo');
  assert.doesNotMatch(html, /value=/, 'nada salvo vai em atributo');
  assert.ok(!html.includes(SALVO.caminho_token), 'o caminho entra só pelo JavaScript');
  assert.match(html, /<button type="submit" class="pri">Salvar<\/button><button type="button" data-testar aria-describedby="cx-catalogo-estado">Testar<\/button>/);
  assert.match(html, /<p class="estado-linha" id="cx-catalogo-estado" role="status"><\/p>\s*<\/form>\s*<div data-cats><\/div>/);
  assert.doesNotMatch(html, /Só o Dono muda esta conexão/, 'o Dono não vê a trava');
});

test('CA2: Operador (sem segredos_salvos) vê a frase "Só o Dono muda esta conexão." ligada aos campos e ao Testar', () => {
  const html = C.cartaoConexao(CONECTADA({ segredos_salvos: undefined }));
  assert.match(html, /<p class="dica" id="cx-catalogo-sodono">Só o Dono muda esta conexão\.<\/p>/);
  assert.match(html, /aria-describedby="cx-catalogo-endereco-dica cx-catalogo-sodono"/);
  assert.match(html, /aria-describedby="cx-catalogo-caminho_token-dica cx-catalogo-sodono"/);
  assert.match(html, /data-testar aria-describedby="cx-catalogo-estado cx-catalogo-sodono"/);
  assert.equal(C.cxCatSoLeitura(CONECTADA({ segredos_salvos: undefined })), true);
  assert.equal(C.cxCatSoLeitura(CONECTADA()), false);
});

test('as outras lojas seguem no cartão genérico; Catálogo de um servidor sem a integração também', () => {
  const shopee = C.cartaoConexao({ id: 'shopee', nome: 'Shopee', implementada: true, campos: [{ nome: 'id_afiliado', rotulo: 'ID', tipo: 'texto', max: 20 }], config: {}, segredos_salvos: [] });
  assert.match(shopee, /id="cx-shopee"/); assert.doesNotMatch(shopee, /conexao-catalogo|data-cats/);
  const antigo = C.cartaoConexao(CARTAO({ implementada: false, estado: 'nao_implementada' }));
  assert.match(antigo, /Ainda não implementado\./); assert.doesNotMatch(antigo, /conexao-catalogo|data-cats/);
});

// ================================================================== validação no cliente
test('CA2/CA8: validação: endereço vazio e fora de localhost/127.0.0.1; caminho vazio, longo, com controle ou relativo', () => {
  const E = (endereco, caminho_token = SALVO.caminho_token) => J(C.cxCatErros({ endereco, caminho_token }));
  assert.deepEqual(E('http://localhost:8765'), []);
  assert.deepEqual(E('  http://127.0.0.1:1  '), [], 'apara espaços');
  assert.deepEqual(E(''), [{ campo: 'endereco', msg: 'Informe o endereço do Etiqueta. O padrão é http://127.0.0.1:8765.' }]);
  for (const ruim of ['localhost:8765', 'https://localhost:8765', 'http://localhost', 'http://localhost:8765/', 'http://localhost:8765/api',
    'http://user:senha@localhost:8765', 'http://192.168.0.10:8765', 'http://evil.com:8765', 'http://localhost.evil.com:8765', 'http://localhost:0', 'http://localhost:65536', 'javascript:alert(1)']) {
    assert.deepEqual(E(ruim), [{ campo: 'endereco', msg: 'Use só o endereço deste computador, como http://127.0.0.1:8765 (sem o que vem depois da porta).' }], ruim);
  }
  const K = (caminho_token) => J(C.cxCatErros({ endereco: 'http://localhost:8765', caminho_token }));
  assert.deepEqual(K(''), [{ campo: 'caminho_token', msg: 'Informe o caminho do arquivo do token.' }]);
  assert.deepEqual(K('/' + 'a/'.repeat(250) + 'x'), [{ campo: 'caminho_token', msg: 'Caminho inválido.' }], 'mais de 500');
  assert.deepEqual(K('/home/x\u0007/api_token.txt'), [{ campo: 'caminho_token', msg: 'Caminho inválido.' }]);
  assert.deepEqual(K('api_token.txt'), [{ campo: 'caminho_token', msg: 'Caminho inválido. Use o caminho completo do arquivo, começando por / ou ~/.' }]);
  assert.deepEqual(K('~/Documentos/api_token.txt'), []);
  assert.deepEqual(K('/home/' + 'a'.repeat(494)), [], '500 no total');
  assert.deepEqual(K('/home/' + 'a'.repeat(495)), [{ campo: 'caminho_token', msg: 'Caminho inválido.' }], '501');
  // os dois errados: os dois erros, endereço primeiro (é o primeiro campo)
  assert.deepEqual(E('', '').map((e) => e.campo), ['endereco', 'caminho_token']);
});

test('CA8: caminho que parece o token é recusado sem ecoar o valor e marcado para limpar o campo', () => {
  for (const v of [TOKEN, `/${TOKEN}`, `~/${TOKEN}`, `  ${TOKEN}  `, 'a'.repeat(600)]) {
    const erros = J(C.cxCatErros({ endereco: 'http://localhost:8765', caminho_token: v }));
    assert.deepEqual(erros, [{ campo: 'caminho_token', msg: TC.pareceToken, limpar: true }], v.slice(0, 10));
    assert.ok(!erros[0].msg.includes(v.trim()) && !erros[0].msg.includes(TOKEN));
  }
  assert.equal(TC.pareceToken, 'Isto parece o token, não o caminho do arquivo. Cole o caminho (por exemplo, …/api_token.txt). Se você colou o token em algum lugar, gere outro no Etiqueta.');
  // com ponto, barra no meio ou curto: é caminho
  for (const v of [`/home/x/${TOKEN}`, `${TOKEN}.txt`, `/${'a'.repeat(31)}`]) {
    assert.ok(!C.cxCatErros({ endereco: 'http://localhost:8765', caminho_token: v }).some((e) => e.limpar), v);
  }
  assert.equal(C.cxCatCampoDoErro('Endereço não aceito. Use um endereço deste computador, como http://localhost:8765.'), 'endereco');
  assert.equal(C.cxCatCampoDoErro(TC.pareceToken), 'caminho_token');
  assert.equal(C.cxCatCampoDoErro('Caminho inválido. Use o caminho completo do arquivo, começando por / ou ~/.'), 'caminho_token');
  assert.equal(C.cxCatCampoDoErro('Arquivo do token: até 500 caracteres.'), 'caminho_token');
  assert.equal(C.cxCatCampoDoErro('Endereço não aceito. … Caminho inválido.'), 'endereco', 'os dois: o primeiro campo leva o foco');
  assert.equal(C.cxCatCampoDoErro('Só o Dono pode fazer isso.'), '');
});

// ================================================================== Testar e linha de estado
test('CA2: Testar habilitado só com endereço e caminho salvos, e só para o Dono', () => {
  assert.equal(C.cxCatTestarBloqueado(CARTAO()), true);
  assert.equal(C.cxCatTestarBloqueado(CARTAO({ config: { endereco: SALVO.endereco } })), true);
  assert.equal(C.cxCatTestarBloqueado(CARTAO({ config: { caminho_token: SALVO.caminho_token } })), true);
  assert.equal(C.cxCatTestarBloqueado(CARTAO({ config: SALVO, estado: 'salva' })), false);
  assert.equal(C.cxCatTestarBloqueado(CARTAO({ config: SALVO, estado: 'salva', segredos_salvos: undefined })), true, 'Operador');
  assert.equal(C.cxCatTestarBloqueado(null), true);
});

test('CA2: frase por resultado (Testar e última verificação), com endereço e caminho salvos e números com milhar', () => {
  const F = (r, n = {}) => C.cxCatFrase(r, SALVO, n);
  assert.equal(F('ok', { total: 3853, categorias: 12 }), 'Conectado. 3.853 ofertas em 12 categorias.');
  assert.equal(F('ok', { total: 1, categorias: 1 }), 'Conectado. 1 oferta em 1 categoria.');
  assert.equal(F('ok', { total: -3, categorias: 'x' }), 'Conectado. 0 ofertas em 0 categorias.', 'número ruim vira 0');
  assert.equal(F('token_recusado'), 'O Etiqueta recusou o token. Se você trocou o arquivo do token, reinicie o servidor.py do Etiqueta (ele lê o arquivo só ao ligar) e teste de novo.');
  assert.match(F('desligada'), /^O Etiqueta está no ar, mas a API dele está desligada\. Falta o arquivo api_token\.txt/);
  assert.equal(F('fora_do_ar'), 'Não consegui falar com o Etiqueta em http://localhost:8765. Confira se ele está ligado (python3 servidor.py) e se o endereço e a porta estão certos.');
  assert.equal(F('sem_arquivo'), 'Não encontrei o arquivo do token em /home/dono/etiqueta/api_token.txt. Confira o caminho, e se este programa tem permissão para ler o arquivo.');
  assert.equal(F('arquivo_invalido'), 'O arquivo do token está vazio ou fora do formato (32 ou mais letras, números, _ e -). Gere o token de novo no Etiqueta.');
  assert.equal(F('resposta_inesperada'), 'O Etiqueta respondeu algo que não esperávamos. Tente de novo; se continuar, veja o terminal do servidor.py.');
  assert.equal(F('nao_configurada'), 'Salve o endereço e o caminho do token para testar.');
  // desconhecido: a frase fixa do servidor; sem ela, "algo que não esperávamos" (nunca "undefined", nunca protótipo)
  assert.equal(C.cxCatFrase('indisponivel', SALVO, {}, 'O teste do Catálogo não está disponível agora. Tente de novo.'), 'O teste do Catálogo não está disponível agora. Tente de novo.');
  assert.equal(C.cxCatFrase('constructor', SALVO, {}), F('resposta_inesperada'));
  assert.equal(C.cxCatFrase(undefined), F('resposta_inesperada'));
  // resultado conhecido: a mensagem do servidor não entra (nem um token que viesse nela)
  for (const r of ['ok', 'token_recusado', 'desligada', 'fora_do_ar', 'sem_arquivo', 'arquivo_invalido', 'resposta_inesperada']) {
    assert.ok(!C.cxCatFrase(r, SALVO, {}, `vazou ${TOKEN}`).includes(TOKEN), r);
  }
  // sem config: as frases não ficam com "em undefined"
  assert.equal(C.cxCatFrase('fora_do_ar', {}), 'Não consegui falar com o Etiqueta. Confira se ele está ligado (python3 servidor.py) e se o endereço e a porta estão certos.');
  assert.doesNotMatch(C.cxCatFrase('sem_arquivo', null), /undefined|null/);
});

test('CA2: resultado do Testar: sucesso só com ok e resultado ok juntos; falhas em aviso', () => {
  const p = CONECTADA();
  assert.deepEqual(J(C.cxCatFraseTeste(p, { ok: true, resultado: 'ok', mensagem: 'x', total: 3853, categorias: CATS })),
    { frase: 'Conectado. 3.853 ofertas em 2 categorias.', ok: true, aviso: false });
  assert.deepEqual(J(C.cxCatFraseTeste(p, { ok: false, resultado: 'ok' })), { frase: TC.teste.resposta_inesperada(), ok: false, aviso: true }, 'ok sem o sinal');
  assert.deepEqual(J(C.cxCatFraseTeste(p, { ok: true, resultado: 'token_recusado' })), { frase: TC.teste.token_recusado(), ok: false, aviso: true });
  assert.equal(C.cxCatFraseTeste(p, null).aviso, true);
});

test('CA2: linha de estado: falta salvar, salvo sem teste, verificação com hora, campos mudados e Operador', () => {
  const L = (p, v) => J(C.cxCatLinha(p, v));
  assert.deepEqual(L(CARTAO()), { frase: 'Salve o endereço e o caminho do arquivo do token para testar.', verificado: '', ok: false, aviso: false });
  assert.deepEqual(L(CARTAO({ segredos_salvos: undefined })), { frase: 'Nada salvo ainda.', verificado: '', ok: false, aviso: false }, 'Operador não é mandado salvar');
  assert.deepEqual(L(CARTAO({ config: SALVO, estado: 'salva', updated_at: 5 })), { frase: 'Dados salvos em 03/11/2026 10:00.', verificado: '', ok: false, aviso: false });
  assert.deepEqual(L(CONECTADA()), { frase: 'Conectado. 3.853 ofertas em 2 categorias.', verificado: 'Verificado em 03/11/2026 10:00.', ok: true, aviso: false });
  const recusado = L(CONECTADA({ estado: 'token_recusado', situacao: { resultado: 'token_recusado', verificado_em: 9, mensagem: 'x' } }));
  assert.equal(recusado.frase, TC.teste.token_recusado()); assert.equal(recusado.aviso, true); assert.equal(recusado.verificado, 'Verificado em 03/11/2026 10:00.');
  assert.equal(L(CONECTADA({ situacao: { resultado: 'ok', verificado_em: null } })).verificado, '', 'sem hora, nada de "Verificado em"');
  // campos diferentes do salvo: avisa que o Testar usa o salvo; iguais (com espaços) não
  assert.deepEqual(L(CONECTADA(), { endereco: 'http://127.0.0.1:8765', caminho_token: SALVO.caminho_token }), { frase: 'Você mudou os campos. Salve antes de testar.', verificado: '', ok: false, aviso: true });
  assert.equal(L(CONECTADA(), { endereco: ` ${SALVO.endereco} `, caminho_token: SALVO.caminho_token }).ok, true);
  assert.equal(C.cxCatMudou(CARTAO(), { endereco: 'x', caminho_token: 'y' }), false, 'nada salvo: a linha já pede para salvar');
  // HTML: ✓ em .nivel-ok; falha com "!"; tudo escapado
  assert.equal(C.cxCatLinhaHtml(C.cxCatLinha(CONECTADA())), '<span class="nivel-ok">✓ Conectado. 3.853 ofertas em 2 categorias.</span> Verificado em 03/11/2026 10:00.');
  assert.equal(C.cxCatLinhaHtml({ frase: 'Falhou.', verificado: '', ok: false, aviso: true }), '! Falhou.');
  assert.equal(C.cxCatLinhaHtml({ frase: 'Salvando…', verificado: '', ok: false, aviso: false }), 'Salvando…');
});

test('CA9: caminho e endereço do dono com HTML saem escapados na linha (sem_arquivo / fora_do_ar)', () => {
  const cfg = { endereco: 'http://localhost:8765', caminho_token: `/home/x/${MALICIOSO}/api_token.txt` };
  const p = CONECTADA({ config: cfg, estado: 'sem_arquivo', situacao: { resultado: 'sem_arquivo', verificado_em: 1, mensagem: 'x' } });
  const html = C.cxCatLinhaHtml(C.cxCatLinha(p));
  assert.ok(!html.includes('<img'), html); assert.ok(!/onerror="/.test(html));
  assert.ok(html.includes(esc(cfg.caminho_token)));
  const fora = C.cxCatLinhaHtml(C.cxCatLinha(CONECTADA({ config: { ...cfg, endereco: '<b>x</b>' }, situacao: { resultado: 'fora_do_ar', verificado_em: 1 } })));
  assert.ok(fora.includes('&lt;b&gt;x&lt;/b&gt;') && !fora.includes('<b>'), fora);
});

// ================================================================== categorias
test('CA2: categorias só em "conectada": resumo com soma por loja e milhar, tabela acessível com rolagem interna, nota', () => {
  for (const estado of ['falta_configurar', 'salva', 'token_recusado', 'indisponivel', 'sem_arquivo']) assert.equal(C.cxCatCategorias(CONECTADA({ estado })), '', estado);
  const html = C.cxCatCategorias(CONECTADA());
  assert.match(html, /<p class="cat-resumo">3\.853 ofertas em 2 categorias\. Mercado Livre: 1\.800 · Amazon: 1\.500 · Shopee: 553\.<\/p>/);
  assert.match(html, /<details open><summary>Categorias do Etiqueta \(2\)<\/summary>/);
  assert.match(html, /<div class="tabela cat-tabela" tabindex="0" role="region" aria-label="Tabela de categorias do Etiqueta">/);
  assert.match(html, /<caption class="sr-only">Categorias do Etiqueta e total de ofertas por loja<\/caption>/);
  const cab = [...html.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(cab, ['Categoria', 'Total', 'Mercado Livre', 'Amazon', 'Shopee']);
  assert.match(html, /<tr><th scope="row"><span class="cat-nome" title="Casa">Casa<\/span><\/th><td class="num">1\.500<\/td><td class="num">600<\/td><td class="num">700<\/td><td class="num">200<\/td><\/tr>/);
  assert.ok(html.indexOf('Casa') < html.indexOf('Eletrônicos'), 'ordem como a API entrega');
  assert.match(html, /Esta lista é a da última verificação\. Se o Etiqueta ganhar categorias novas, clique em “Testar” para atualizar\./);
  // conectada sem categorias
  assert.equal(C.cxCatCategorias(CONECTADA({ verificacao: { categorias: [], total: 0 } })), '<p class="dica">O Etiqueta está conectado, mas ainda não tem ofertas. Colete ofertas nele e teste de novo.</p>');
  assert.equal(C.cxCatCategorias(CONECTADA({ verificacao: null })), C.cxCatCategorias(CONECTADA({ verificacao: { categorias: [] } })));
  // números ruins viram 0; sem total, soma as categorias; item sem nome é ignorado
  const ruins = C.cxCatCategorias(CONECTADA({ verificacao: { categorias: [{ nome: 'A', total: 2.5, lojas: { ml: -1, amazon: '3', shopee: 1e20 } }, { nome: '', total: 1 }, null, { total: 4 }, { nome: 'B', total: 4 }] } }));
  assert.match(ruins, /4 ofertas em 2 categorias\. Mercado Livre: 0 · Amazon: 0 · Shopee: 0\./);
  assert.match(ruins, /title="A">A<\/span><\/th><td class="num">0<\/td><td class="num">0<\/td><td class="num">0<\/td><td class="num">0<\/td>/);
});

test('CA9: nome de categoria malicioso (<img onerror>, aspas) sai escapado na célula e no title; nada de tag nova', () => {
  const longo = 'L'.repeat(200);
  const html = C.cxCatCategorias(CONECTADA({ verificacao: { total: 3, categorias: [{ nome: MALICIOSO, total: 1, lojas: { ml: 1 } }, { nome: '"><script>alert(1)</script>', total: 1, lojas: {} }, { nome: longo, total: 1, lojas: {} }] } }));
  assert.ok(!html.includes('<img'), 'sem <img>'); assert.ok(!html.includes('<script'), 'sem <script>');
  assert.ok(!/onerror="/.test(html));
  assert.ok(html.includes(`title="${esc(MALICIOSO)}">${esc(MALICIOSO)}</span>`), 'célula e title escapados');
  assert.ok(html.includes('title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'), 'aspas não fecham o atributo');
  assert.ok(html.includes(`title="${longo}">${longo}</span>`), 'nome longo inteiro no title (o CSS põe as reticências)');
  // a única tag <img/script> possível teria de vir do texto: conta as tags abertas no HTML
  const tags = new Set([...html.matchAll(/<([a-z]+)[\s>]/g)].map((m) => m[1]));
  assert.deepEqual([...tags].sort(), ['caption', 'details', 'div', 'p', 'span', 'summary', 'table', 'tbody', 'td', 'th', 'thead', 'tr']);
  // o mesmo na região inteira do cartão (aplicarCatalogo pinta [data-cats])
  const t = carregar();
  t.aplicarConexao({}, CONECTADA({ verificacao: { total: 1, categorias: [{ nome: MALICIOSO, total: 1, lojas: {} }] } }));
  assert.ok(!t.d.cats.innerHTML.includes('<img') && t.d.cats.innerHTML.includes(esc(MALICIOSO)));
});

// ================================================================== cartão em DOM falso
test('CA2: aplicarConexao: endereço padrão quando não há nada salvo, valores salvos, selo, travas e linha', () => {
  const t = carregar();
  t.aplicarConexao({}, CARTAO());
  assert.equal(t.d.campo('endereco').value, 'http://127.0.0.1:8765', 'valor, não só placeholder');
  assert.equal(t.d.campo('caminho_token').value, '');
  assert.equal(t.d.testar.disabled, true); assert.equal(t.d.salvar.disabled, false);
  assert.equal(t.d.selo.className, 'estado-pill falta'); assert.equal(t.d.selo.textContent, 'Falta configurar');
  assert.equal(t.d.linha.textContent, 'Salve o endereço e o caminho do arquivo do token para testar.');
  assert.equal(t.d.cats.innerHTML, '');
  // endereço padrão vindo do servidor; sem ele, o do painel (também 127.0.0.1, como o do servidor)
  t.aplicarConexao({}, CARTAO({ endereco_padrao: 'http://localhost:9999' }));
  assert.equal(t.d.campo('endereco').value, 'http://localhost:9999');
  t.aplicarConexao({}, CARTAO({ endereco_padrao: undefined }));
  assert.equal(t.d.campo('endereco').value, 'http://127.0.0.1:8765');
  // conectada: valores salvos, Testar liberado, linha com ✓ e hora, categorias
  t.aplicarConexao({}, CONECTADA());
  assert.equal(t.d.campo('endereco').value, SALVO.endereco); assert.equal(t.d.campo('caminho_token').value, SALVO.caminho_token);
  assert.equal(t.d.testar.disabled, false);
  assert.equal(t.d.selo.className, 'estado-pill conectado'); assert.equal(t.d.selo.textContent, 'Conectada');
  assert.equal(t.d.linha.innerHTML, '<span class="nivel-ok">✓ Conectado. 3.853 ofertas em 2 categorias.</span> Verificado em 03/11/2026 10:00.');
  assert.equal(t.d.linha.classes.has('aviso'), false);
  assert.match(t.d.cats.innerHTML, /Categorias do Etiqueta \(2\)/);
  // indisponível: aviso com "!", categorias somem
  t.aplicarConexao({}, CONECTADA({ estado: 'indisponivel', situacao: { resultado: 'desligada', verificado_em: 1 } }));
  assert.equal(t.d.selo.className, 'estado-pill pendente'); assert.equal(t.d.selo.textContent, 'Indisponível');
  assert.match(t.d.linha.textContent, /^! O Etiqueta está no ar, mas a API dele está desligada\./); assert.equal(t.d.linha.classes.has('aviso'), true);
  assert.equal(t.d.cats.innerHTML, '');
  // Operador: campos, Salvar e Testar travados; vê selo e categorias
  t.aplicarConexao({}, CONECTADA({ segredos_salvos: undefined }));
  assert.equal(t.d.campo('endereco').disabled, true); assert.equal(t.d.campo('caminho_token').disabled, true);
  assert.equal(t.d.salvar.disabled, true); assert.equal(t.d.testar.disabled, true);
  assert.equal(t.d.selo.textContent, 'Conectada'); assert.match(t.d.cats.innerHTML, /<table>/);
});

test('CA8: Salvar com o token no campo do caminho: campo limpo, nada enviado, frase sem o valor e foco no campo', async () => {
  const t = carregar({ 'PUT /conexoes/catalogo': () => CARTAO({ config: SALVO, estado: 'salva', updated_at: 5 }) });
  t.ligarConexao({}, CARTAO());
  t.d.campo('endereco').value = 'http://localhost:8765'; t.d.campo('caminho_token').value = TOKEN;
  await t.d.form.onsubmit({ preventDefault() {} });
  assert.equal(t.d.campo('caminho_token').value, '', 'o token não fica no campo');
  assert.deepEqual(t.pedidos, [], 'nada foi enviado');
  assert.deepEqual(t.errosMostrados.map((e) => e.msg), [TC.pareceToken]);
  assert.equal(t.errosMostrados[0].el, t.d.campo('caminho_token'));
  const tudo = JSON.stringify(t.errosMostrados.map((e) => e.msg)) + t.d.linha.textContent + t.d.linha.innerHTML + t.avisos.join();
  assert.ok(!tudo.includes(TOKEN), 'o token não aparece em lugar nenhum');
  // endereço errado: foco no endereço, nada enviado
  t.errosMostrados.length = 0;
  t.d.campo('endereco').value = 'http://evil.com:80'; t.d.campo('caminho_token').value = SALVO.caminho_token;
  await t.d.form.onsubmit({ preventDefault() {} });
  assert.equal(t.errosMostrados[0].el, t.d.campo('endereco')); assert.deepEqual(t.pedidos, []);
});

test('CA2: Salvar com valores certos manda só endereço e caminho, aplica a resposta e mostra o toast "Catálogo: dados salvos"', async () => {
  const t = carregar({ 'PUT /conexoes/catalogo': () => CARTAO({ config: SALVO, estado: 'salva', updated_at: 5 }) });
  t.ligarConexao({}, CARTAO());
  t.d.campo('endereco').value = ` ${SALVO.endereco} `; t.d.campo('caminho_token').value = SALVO.caminho_token;
  await t.d.form.onsubmit({ preventDefault() {} });
  assert.deepEqual(t.pedidos, [{ req: 'PUT /conexoes/catalogo', corpo: { campos: SALVO } }]);
  assert.deepEqual(t.avisos, ['Catálogo: dados salvos']);
  assert.equal(t.d.selo.textContent, 'Salvo, ainda não testado');
  assert.equal(t.d.testar.disabled, false, 'com os dois salvos, Testar liberado');
  assert.equal(t.d.linha.textContent, 'Dados salvos em 03/11/2026 10:00.');
  assert.equal(t.d.salvar.disabled, false); assert.equal(t.d.salvar.textContent, 'Salvar');
  assert.deepEqual(t.errosMostrados, [], 'sem erro: a caixa de erros some (mostrarErros com lista vazia)');
});

test('CA8: 400 do servidor: o token recusado limpa o campo e foca o caminho; endereço recusado foca o endereço', async () => {
  let erro = TC.pareceToken;
  const t = carregar({ 'PUT /conexoes/catalogo': () => { throw new Error(erro); } });
  t.ligarConexao({}, CARTAO());
  // o servidor vê um token que o cliente não pegou (ex.: regra futura): limpa do mesmo jeito
  t.d.campo('endereco').value = SALVO.endereco; t.d.campo('caminho_token').value = '/home/dono/token.txt';
  await t.d.form.onsubmit({ preventDefault() {} });
  assert.equal(t.d.campo('caminho_token').value, '');
  assert.equal(t.errosMostrados.at(-1).el, t.d.campo('caminho_token')); assert.equal(t.errosMostrados.at(-1).msg, TC.pareceToken);
  assert.equal(t.d.salvar.disabled, false, 'o botão volta');
  erro = 'Endereço não aceito. Use um endereço deste computador, como http://localhost:8765.';
  t.d.campo('caminho_token').value = '/home/dono/token.txt';
  await t.d.form.onsubmit({ preventDefault() {} });
  assert.equal(t.errosMostrados.at(-1).el, t.d.campo('endereco'));
  assert.equal(t.d.campo('caminho_token').value, '/home/dono/token.txt', 'só limpa quando o erro é o do token');
});

test('CA2: Operador não envia nada ao clicar em Salvar ou Testar', async () => {
  const t = carregar({});
  const p = CONECTADA({ segredos_salvos: undefined });
  t.aplicarConexao({}, p); t.ligarConexao({}, p);
  t.d.campo('endereco').value = 'http://127.0.0.1:8765'; // valores válidos: só a trava do Operador segura o envio
  await t.d.form.onsubmit({ preventDefault() {} });
  await t.d.testar.onclick();
  assert.deepEqual(t.pedidos, []);
});

test('CA2: Testar: "Testando…", relê o cartão (selo e categorias), frase por resultado com ✓ ou "!", e devolve o botão', async () => {
  let resposta = { ok: true, resultado: 'ok', mensagem: 'x', total: 3853, categorias: CATS };
  let cartao = CONECTADA();
  const t = carregar({ 'POST /conexoes/catalogo/testar': () => resposta, 'GET /conexoes': () => [{ id: 'amazon' }, cartao] });
  t.ligarConexao({}, CARTAO({ config: SALVO, estado: 'salva', updated_at: 5 }));
  const espera = t.d.testar.onclick();
  assert.equal(t.d.testar.textContent, 'Testando…'); assert.equal(t.d.testar.disabled, true); assert.equal(t.d.linha.textContent, 'Testando…');
  await espera;
  assert.deepEqual(t.pedidos.map((p) => p.req), ['POST /conexoes/catalogo/testar', 'GET /conexoes'], 'só /api do painel');
  assert.equal(t.d.linha.innerHTML, '<span class="nivel-ok">✓ Conectado. 3.853 ofertas em 2 categorias.</span>');
  assert.equal(t.d.linha.classes.has('aviso'), false);
  assert.equal(t.d.selo.textContent, 'Conectada'); assert.match(t.d.cats.innerHTML, /Eletrônicos/);
  assert.equal(t.d.testar.textContent, 'Testar'); assert.equal(t.d.testar.disabled, false);
  // token recusado
  resposta = { ok: false, resultado: 'token_recusado', mensagem: `qualquer ${TOKEN}`, total: 0, categorias: [] };
  cartao = CONECTADA({ estado: 'token_recusado', situacao: { resultado: 'token_recusado', verificado_em: 9 } });
  await t.d.testar.onclick();
  assert.equal(t.d.linha.textContent, `! ${TC.teste.token_recusado()}`); assert.equal(t.d.linha.classes.has('aviso'), true);
  assert.ok(!t.d.linha.innerHTML.includes(TOKEN));
  assert.equal(t.d.selo.className, 'estado-pill erro'); assert.equal(t.d.selo.textContent, 'Token recusado');
  assert.equal(t.d.cats.innerHTML, '', 'sem conectada, sem tabela');
  // sem arquivo: o caminho salvo aparece; o selo diz o estado
  resposta = { ok: false, resultado: 'sem_arquivo' };
  cartao = CONECTADA({ estado: 'sem_arquivo', situacao: { resultado: 'sem_arquivo', verificado_em: 9 } });
  await t.d.testar.onclick();
  assert.match(t.d.linha.textContent, /^! Não encontrei o arquivo do token em \/home\/dono\/etiqueta\/api_token\.txt\./);
  assert.equal(t.d.selo.textContent, 'Arquivo do token não encontrado');
  // erro do painel (rede, 403): a frase da exceção, em aviso, e o botão volta
  t.ctx.api = async () => { throw new Error('Sem resposta do programa.'); };
  await t.d.testar.onclick();
  assert.equal(t.d.linha.textContent, '! Sem resposta do programa.'); assert.equal(t.d.testar.disabled, false);
});

test('CA2: Testar bloqueado não chama o servidor; campos mudados avisam "Salve antes de testar" e voltar ao salvo apaga o aviso', async () => {
  const t = carregar({});
  t.ligarConexao({}, CARTAO());
  await t.d.testar.onclick();
  assert.deepEqual(t.pedidos, [], 'sem os dois salvos, nada');
  const t2 = carregar({});
  const p = CONECTADA();
  t2.aplicarConexao({}, p); t2.ligarConexao({}, p);
  t2.d.campo('endereco').value = 'http://127.0.0.1:9999';
  t2.d.form.oninput();
  assert.equal(t2.d.linha.textContent, '! Você mudou os campos. Salve antes de testar.'); assert.equal(t2.d.linha.classes.has('aviso'), true);
  t2.d.campo('endereco').value = SALVO.endereco;
  t2.d.form.oninput();
  assert.match(t2.d.linha.innerHTML, /^<span class="nivel-ok">✓ Conectado\./); assert.equal(t2.d.linha.classes.has('aviso'), false);
});

test('CA8: o painel do Catálogo nunca chama o Etiqueta nem a rede direto: só api("/conexoes…")', () => {
  const inicio = FONTE.indexOf('// ---------- Catálogo do Etiqueta');
  assert.ok(inicio > 0, 'marcador da seção');
  const trecho = FONTE.slice(inicio);
  assert.doesNotMatch(trecho, /\bfetch\s*\(|XMLHttpRequest|EventSource|WebSocket|8765\/api|\/api\/v1/);
  const chamadas = [...trecho.matchAll(/api\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(chamadas)].sort(), ['/conexoes', '/conexoes/catalogo', '/conexoes/catalogo/testar']);
});
