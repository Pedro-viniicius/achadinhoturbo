// Verificador de preço e estoque, etapa 8 (docs/produto/planos/verificador-preco-estoque.md; CA1 e CA7): a fiação
// (criarServicos com `verificar`/`simulado`, D9), os Ajustes por HTTP (GET /api/state e PUT /api/ajustes, com a linha
// `aviso` ao desligar, D10) e a tela (cartão de Ajustes, dica de {HORA_PRECO} em Templates, selo "Descartado" e dica do
// agendar no Disparo manual). Servidor pelo mesmo caminho do main (criarServicos + buildApp), WhatsApp simulado, links
// meli.la/fake-…, ml falso e o fetch global bloqueado (o último teste prova que ninguém o chamou). Painel num vm.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openDb, setSetting } from '../src/db.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { buildApp, criarServicos, AVISO_VERIFICADOR_DESLIGADO } from '../src/server.js';
import { LIMITE_PADRAO_PCT, MOTIVOS_VERIFICADOR } from '../src/verificador.js';

let acessosRede = 0;
globalThis.fetch = async () => { acessosRede++; throw new Error('rede proibida no teste'); };
const redeProibida = async () => { acessosRede++; throw new Error('rede proibida no teste'); };

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lerPublic = (arq) => fs.readFileSync(path.join(RAIZ, 'public', arq), 'utf8');
const J = (x) => JSON.parse(JSON.stringify(x)); // objetos do vm têm outro protótipo

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-verif-srv-')); pastas.push(p); return p; };

const URL_ML = 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM';
const G1 = '111@g.us';
const G2 = '222@g.us';
const SENHA = 'senha-de-teste-123';
const CORPO = '{TITULO_PRODUTO}\nPor {PRECO_PRODUTO}\n[🕒 Preço visto às {HORA_PRECO}]\n{LINK}';

/** ml falso: a leitura do Disparo manual (resolveOffer) e a conferência (conferirProduto), sem rede. */
function mlFalso() {
  const estado = { leitura: { price: 89.9, disponivel: true } };
  const conferencias = [];
  return {
    estado, conferencias,
    async resolveOffer(c) { return { key: c.key, url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: true, image: null }; },
    async conferirProduto(url) { conferencias.push(url); return { ...estado.leitura }; },
  };
}

/** Sobe como o main (criarServicos + buildApp). `servicos` vai ao criarServicos (verificar, simulado). */
function subir({ servicos = {}, panelPassword = '' } = {}) {
  const dir = tmp();
  const db = openDb(dir);
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const ml = mlFalso();
  const s = criarServicos({ db, wa, links, fast: true, dir, fetch: redeProibida, ml, ...servicos });
  const app = buildApp({ db, wa, links, scheduler: s.scheduler, amazon: s.amazon, shopee: s.shopee, catalogo: s.catalogo, catalogoItens: s.catalogoItens, publicHost: null, panelPassword, ml });
  for (const [jid, nome] of [[G1, 'Achadinhos'], [G2, 'Tech']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run('etiquetaA');
  const tpl = Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('Com hora', CORPO, Date.now()).lastInsertRowid);
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      ok({ db, dir, wa, links, ml, tpl, ...s, port: server.address().port,
        fechar: () => new Promise((r) => { s.scheduler.stop?.(); server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) });
    });
  });
}

function req(port, caminho, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((ok, err) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* html */ } ok({ status: res.statusCode, headers: res.headers, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
}
const put = (s, body, headers) => req(s.port, '/api/ajustes', { method: 'PUT', body, headers });
const estado = async (s) => (await req(s.port, '/api/state')).json.ajustes;
const logs = (s) => s.db.prepare('SELECT level, message FROM log ORDER BY id').all().map((r) => ({ ...r }));
const setting = (s, k) => s.db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;

/** Disparo manual "agora" pelo POST (o painel) e espera o envio terminar. → linhas do GET /api/envios */
async function dispararEEsperar(s) {
  const r = await req(s.port, '/api/envios', { method: 'POST', body: { tipo: 'oferta', url: URL_ML, tag_id: 1, template_id: s.tpl, group_jids: [G1, G2], quando: 'agora' } });
  assert.equal(r.status, 200, r.txt);
  const id = r.json.id;
  for (let i = 0; i < 200; i++) {
    const st = s.db.prepare('SELECT status FROM envios WHERE id = ?').get(id)?.status;
    if (st && !['pendente', 'enviando'].includes(st)) break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  const p = await req(s.port, '/api/envios?tipo=oferta');
  assert.equal(p.status, 200);
  return { id, linhas: p.json.linhas, envio: { ...s.db.prepare('SELECT status, payload FROM envios WHERE id = ?').get(id) } };
}

// ------------------------------------------------------------------------------------------------- fiação (CA1)
test('CA1 (D9): com verificar, o Disparo manual pelo painel é conferido e o esgotado não sai: selo descartado no GET /api/envios, aviso no Histórico, sem link', async (t) => {
  const s = await subir({ servicos: { verificar: true } });
  t.after(s.fechar);
  assert.ok(s.verificador, 'criarServicos devolve o verificador');
  s.ml.estado.leitura = { price: 89.9, disponivel: false };
  const pedidos = []; const pedir = s.links.requestLink;
  s.links.requestLink = async (o) => { pedidos.push(o.url); return pedir(o); };

  const { linhas, envio } = await dispararEEsperar(s);
  assert.deepEqual(s.ml.conferencias, [URL_ML], 'uma conferência, na loja, pelo ml do servidor');
  assert.equal(envio.status, 'erro');
  assert.deepEqual(linhas.map((l) => [l.grupo, l.status, l.erro, l.descartado]).sort(),
    [['Achadinhos', 'erro', MOTIVOS_VERIFICADOR.esgotado, 'esgotado'], ['Tech', 'erro', MOTIVOS_VERIFICADOR.esgotado, 'esgotado']]);
  assert.equal(s.wa.simulated.length, 0, 'nada foi aos grupos');
  assert.deepEqual(pedidos, [], 'a descartada não pede link');
  assert.ok(logs(s).every((l) => l.level !== 'erro'), 'nada como erro');
});

test('CA1 (D9): o mesmo verificador vai ao agendador e à fila; preço confere e sai com a hora da conferência', async (t) => {
  const s = await subir({ servicos: { verificar: true } });
  t.after(s.fechar);
  const { linhas, envio } = await dispararEEsperar(s);
  assert.equal(envio.status, 'concluido');
  assert.equal(JSON.parse(envio.payload).preco_loja, 89.9, 'com o verificador, o preço da loja vai ao payload');
  assert.deepEqual(s.ml.conferencias, [URL_ML]);
  assert.equal(s.wa.simulated.length, 2);
  for (const m of s.wa.simulated) assert.match(m.text, /Preço visto às \d{2}h\d{2}/);
  assert.ok(linhas.every((l) => l.status === 'enviado' && !Object.hasOwn(l, 'descartado')));
});

test('CA1 (D9): sem verificar (o padrão dos testes), nada é conferido e o payload é o de antes', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  assert.equal(s.verificador, null);
  s.ml.estado.leitura = { price: 89.9, disponivel: false }; // seria descartada, se conferisse
  const { linhas, envio } = await dispararEEsperar(s);
  assert.equal(envio.status, 'concluido');
  assert.deepEqual(s.ml.conferencias, [], 'sem verificador, a loja não é relida');
  assert.ok(!Object.hasOwn(JSON.parse(envio.payload), 'preco_loja'));
  assert.ok(linhas.every((l) => l.status === 'enviado'));
  for (const m of s.wa.simulated) assert.doesNotMatch(m.text, /Preço visto/, 'sem conferência, {HORA_PRECO} some');
});

test('CA7 (DRY_RUN): simulado confirma sem acessar a rede nem o leitor da loja, com a hora em {HORA_PRECO}', async (t) => {
  const s = await subir({ servicos: { verificar: true, simulado: true } });
  t.after(s.fechar);
  s.ml.conferirProduto = async () => { throw new Error('não deveria ler a loja na simulação'); };
  const antes = acessosRede;
  const { envio } = await dispararEEsperar(s);
  assert.equal(envio.status, 'concluido');
  assert.equal(acessosRede, antes, 'nenhum fetch');
  assert.equal(s.wa.simulated.length, 2);
  for (const m of s.wa.simulated) assert.match(m.text, /Preço visto às \d{2}h\d{2}/);
});

test('CA7: desligado em Ajustes (PUT), o verificador do agendador deixa de conferir na hora, sem reiniciar', async (t) => {
  const s = await subir({ servicos: { verificar: true } });
  t.after(s.fechar);
  s.ml.estado.leitura = { price: 89.9, disponivel: false };
  assert.equal((await put(s, { verificador_ativo: false })).status, 200);
  const { envio } = await dispararEEsperar(s);
  assert.equal(envio.status, 'concluido', 'desligado: sai sem conferir');
  assert.deepEqual(s.ml.conferencias, []);
  for (const m of s.wa.simulated) assert.doesNotMatch(m.text, /Preço visto/);
});

test('CA1 (D9): o main de src/server.js liga o verificador, simulado em DRY_RUN', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'src', 'server.js'), 'utf8');
  const main = src.slice(src.indexOf('// ---------- inicialização ----------'));
  assert.match(main, /criarServicos\(\{[^}]*verificar: true, simulado: DRY_RUN \}\)/, 'o bloco principal passa verificar: true e simulado: DRY_RUN');
});

// ---------------------------------------------------------------------------------------------- Ajustes (CA7)
test('CA7: GET /api/state traz a chave (padrão ligada) e o limite (padrão 5); valores salvos ruins voltam ao padrão', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  let a = await estado(s);
  assert.deepEqual([a.verificador_ativo, a.verificador_limite_pct], [true, LIMITE_PADRAO_PCT]);
  setSetting(s.db, 'verificador_ativo', '0'); setSetting(s.db, 'verificador_limite_pct', '12');
  a = await estado(s);
  assert.deepEqual([a.verificador_ativo, a.verificador_limite_pct], [false, 12]);
  setSetting(s.db, 'verificador_ativo', '1'); setSetting(s.db, 'verificador_limite_pct', '99');
  a = await estado(s);
  assert.deepEqual([a.verificador_ativo, a.verificador_limite_pct], [true, LIMITE_PADRAO_PCT]);
});

test('CA7: PUT /api/ajustes valida o limite (inteiro de 0 a 50) e a chave (booleano); recusado não grava nada', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  for (const v of [51, -1, 'x', 5.5, '', '5.5', '-1', '100', true, [5], { n: 5 }]) {
    const r = await put(s, { verificador_limite_pct: v });
    assert.equal(r.status, 400, `limite ${JSON.stringify(v)}`);
    assert.equal(r.json.erro, 'Informe um número inteiro de 0 a 50.');
  }
  for (const v of ['false', 0, 1, 'sim', []]) {
    const r = await put(s, { verificador_ativo: v });
    assert.equal(r.status, 400, `chave ${JSON.stringify(v)}`);
  }
  // os dois são conferidos antes de gravar: limite bom com chave ruim não grava o limite
  assert.equal((await put(s, { verificador_ativo: 'nao', verificador_limite_pct: 9 })).status, 400);
  assert.equal((await put(s, { verificador_ativo: false, verificador_limite_pct: 51 })).status, 400);
  assert.deepEqual([setting(s, 'verificador_ativo'), setting(s, 'verificador_limite_pct')], [null, null]);
  assert.deepEqual(logs(s), []);

  for (const [v, esperado] of [[0, 0], [50, 50], ['7', 7], [5, 5]]) {
    assert.equal((await put(s, { verificador_limite_pct: v })).status, 200, `limite ${JSON.stringify(v)}`);
    assert.equal((await estado(s)).verificador_limite_pct, esperado);
  }
  // null e ausente não mexem (como os outros campos)
  assert.equal((await put(s, { verificador_limite_pct: null, verificador_ativo: null })).status, 200);
  assert.deepEqual([setting(s, 'verificador_limite_pct'), setting(s, 'verificador_ativo')], ['5', null]);
  // corpo sem JSON não derruba a rota
  assert.equal((await req(s.port, '/api/ajustes', { method: 'PUT' })).status, 200);
});

test('CA7 (D10): desligar grava uma linha aviso no Histórico; ligar e salvar de novo desligado não gravam outra', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  assert.equal((await put(s, { verificador_ativo: true })).status, 200);
  assert.deepEqual(logs(s), [], 'ligar não vai ao Histórico');
  assert.equal((await put(s, { verificador_ativo: false })).status, 200);
  assert.equal((await estado(s)).verificador_ativo, false);
  assert.deepEqual(logs(s), [{ level: 'aviso', message: AVISO_VERIFICADOR_DESLIGADO }]);
  assert.equal(AVISO_VERIFICADOR_DESLIGADO, 'Verificador desligado em Ajustes');
  assert.equal((await put(s, { verificador_ativo: false })).status, 200, 'salvar de novo desligado');
  assert.equal(logs(s).length, 1, 'já estava desligado: sem nova linha');
  assert.equal((await put(s, { verificador_ativo: true })).status, 200);
  assert.equal((await estado(s)).verificador_ativo, true);
  assert.equal((await put(s, { verificador_ativo: false })).status, 200);
  assert.deepEqual(logs(s).map((l) => l.level), ['aviso', 'aviso'], 'cada desligamento fica no Histórico');
});

test('CA7 (D10): quem salva os outros Ajustes salva o verificador; o Operador também (e o desligamento fica no Histórico)', async (t) => {
  const s = await subir({ panelPassword: SENHA });
  t.after(s.fechar);
  assert.equal((await put(s, { verificador_ativo: false })).status, 401, 'sem login, nada');
  const lg = await req(s.port, '/api/login', { method: 'POST', body: { senha: SENHA } });
  assert.equal(lg.status, 200);
  s.db.prepare("UPDATE users SET papel = 'operador'").run();
  const cookie = String(lg.headers?.['set-cookie']?.[0] ?? '');
  const sid = cookie.split(';')[0];
  const comSessao = { cookie: sid };
  const eu = (await req(s.port, '/api/state', { headers: comSessao })).json;
  assert.equal(eu.usuario?.papel, 'operador');
  assert.equal((await put(s, { verificador_ativo: false, verificador_limite_pct: 10 }, comSessao)).status, 200);
  // o rastro leva quem salvou (o nome da sessão, como o log da Equipe): o desligamento e a mudança do limite
  assert.deepEqual(logs(s), [
    { level: 'aviso', message: 'Limite do verificador: 5% → 10% (por Dono)' },
    { level: 'aviso', message: `${AVISO_VERIFICADOR_DESLIGADO} (por Dono)` },
  ]);
});

test('S2: mudar o limite deixa um aviso no Histórico (antes → depois, e quem mudou); o mesmo valor, ou outro campo, não', async (t) => {
  const s = await subir();
  t.after(s.fechar);
  assert.equal((await put(s, { verificador_limite_pct: 50 })).status, 200);
  assert.deepEqual(logs(s), [{ level: 'aviso', message: 'Limite do verificador: 5% → 50%' }], 'sem login no painel, sem "por"');
  assert.equal((await put(s, { verificador_limite_pct: 50 })).status, 200, 'o mesmo valor');
  assert.equal((await put(s, { verificador_limite_pct: '50', titulo_max: 40 })).status, 200, 'o mesmo valor em texto, com outro campo');
  assert.equal((await put(s, { verificador_limite_pct: 5, verificador_ativo: true })).status, 200);
  assert.equal((await put(s, { verificador_limite_pct: 0 })).status, 200);
  assert.deepEqual(logs(s).map((l) => l.message), ['Limite do verificador: 5% → 50%', 'Limite do verificador: 50% → 5%', 'Limite do verificador: 5% → 0%']);
  // valor inválido: 400 e nada no Histórico
  assert.equal((await put(s, { verificador_limite_pct: 51 })).status, 400);
  assert.equal(logs(s).length, 3);
  // quem salva com login vai no texto; nada de dado da pessoa além do nome da sessão
  const c = await subir({ panelPassword: SENHA });
  t.after(c.fechar);
  const lg = await req(c.port, '/api/login', { method: 'POST', body: { senha: SENHA } });
  const sessao = { cookie: String(lg.headers?.['set-cookie']?.[0] ?? '').split(';')[0] };
  c.db.prepare("UPDATE users SET nome = 'Ana Souza', email = 'ana@exemplo.com'").run();
  assert.equal((await put(c, { verificador_ativo: false, verificador_limite_pct: 12 }, sessao)).status, 200);
  assert.deepEqual(logs(c).map((l) => l.message), ['Limite do verificador: 5% → 12% (por Ana Souza)', `${AVISO_VERIFICADOR_DESLIGADO} (por Ana Souza)`]);
  assert.ok(!JSON.stringify(logs(c)).includes('ana@exemplo.com'), 'o e-mail nunca vai ao Histórico');
});

// ---------------------------------------------------------------------------------------------- painel (CA7)
/** Elemento falso: valor, atributos, classes e tratadores que a tela pendura; `focado` conta os focus(). */
function el(extra = {}) {
  const classes = new Set(); const attrs = new Map();
  return {
    value: '', checked: false, disabled: false, hidden: false, textContent: '', innerHTML: '', dataset: {}, style: {}, focado: 0,
    classes, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    attrs, setAttribute: (k, v) => attrs.set(k, String(v)), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null), removeAttribute: (k) => attrs.delete(k),
    focus() { this.focado++; }, closest: () => null, contains: () => false, scrollIntoView() {},
    ...extra,
  };
}
function fabricaDollar() {
  const mapa = new Map();
  return { mapa, $: (sel) => { if (!mapa.has(sel)) mapa.set(sel, el()); return mapa.get(sel); } };
}
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Trecho de public/app.js entre dois marcadores (o arquivo inteiro precisa do DOM e do carregar()). */
function trechoApp(inicio, fim) {
  const src = lerPublic('app.js'); const i = src.indexOf(inicio); const f = src.indexOf(fim, i);
  assert.ok(i >= 0 && f > i, `marcadores de app.js: ${inicio} … ${fim}`);
  return src.slice(i, f);
}

/** O cartão de Ajustes do verificador num vm: `TEXTOS_VERIFICADOR`, `cartaoVerificador` e `ligarCartaoVerificador`. */
function cartao() {
  const { $, mapa } = fabricaDollar();
  const pedidos = []; const avisos = []; let resposta = { ok: true };
  const ctx = {
    $, esc, q: (k) => `[?${k}]`, console, Number, String, RegExp, Object,
    api: async (caminho, metodo, corpo) => { pedidos.push({ caminho, metodo, corpo: J(corpo) }); if (resposta instanceof Error) throw resposta; return resposta; },
    atualizarEstado: async () => {}, aviso: (m, erro = false) => avisos.push({ m, erro }),
  };
  vm.createContext(ctx);
  const fonte = trechoApp('const TEXTOS_VERIFICADOR = {', 'async function api(') + trechoApp('function cartaoVerificador(', '// ---------- navegação');
  vm.runInContext(`${fonte}\n;globalThis.__x = { TEXTOS_VERIFICADOR, cartaoVerificador, ligarCartaoVerificador };`, ctx);
  return { ...ctx.__x, $, mapa, pedidos, avisos, falhar: (e) => { resposta = e; } };
}

test('CA7: cartão de Ajustes: título, chave ligada por padrão com o texto visível, limite 0 a 50 e as duas ajudas; desligado deixa o limite desabilitado com a dica', () => {
  const c = cartao();
  const V = c.TEXTOS_VERIFICADOR;
  const ligado = c.cartaoVerificador({});
  assert.match(ligado, new RegExp(`<h2>${V.titulo} \\[\\?ajustes\\.verificador\\]</h2>`));
  assert.match(ligado, /id="vf-ativo"[^>]* checked>/, 'ausente = ligado');
  assert.match(ligado, new RegExp(`<label for="vf-ativo"[^>]*>${V.chave}</label>`), 'o texto da chave é um label visível');
  assert.match(ligado, /id="vf-limite" type="number" inputmode="numeric" min="0" max="50" step="1" value="5" aria-describedby="vf-limite-dica vf-limite-erro">/);
  assert.match(ligado, /\[\?ajustes\.verificador\.limite\]/);
  assert.match(ligado, /<small class="dica" id="vf-desligado" hidden>/);
  assert.doesNotMatch(ligado, /<select/, 'sem o select de falha (D3)');
  assert.match(V.sub, /até 30 min/, 'a sub explica a regra do frescor');

  const desligado = c.cartaoVerificador({ verificador_ativo: false, verificador_limite_pct: 12 });
  assert.doesNotMatch(desligado, /id="vf-ativo"[^>]* checked/);
  assert.match(desligado, /value="12"[^>]* disabled>/, 'limite desabilitado, não escondido');
  assert.match(desligado, new RegExp(`<small class="dica" id="vf-desligado">${V.desligado}</small>`));
});

test('CA7: Salvar do cartão valida o limite na tela (erro sob o campo, foco, sem pedido) e manda o corpo do contrato', async () => {
  const c = cartao();
  const V = c.TEXTOS_VERIFICADOR;
  const chk = c.$('#vf-ativo'); const inp = c.$('#vf-limite'); const erro = c.$('#vf-limite-erro'); const btn = c.$('#vf-salvar'); const dica = c.$('#vf-desligado');
  chk.checked = true; erro.hidden = true; btn.textContent = V.salvar;
  c.ligarCartaoVerificador();
  for (const v of ['51', '-1', '', '5.5', '100', 'abc']) {
    inp.value = v; inp.focado = 0;
    await btn.onclick();
    assert.equal(erro.hidden, false, `limite ${v}`);
    assert.equal(erro.textContent, V.erroLimite);
    assert.equal(V.erroLimite, 'Informe um número inteiro de 0 a 50.');
    assert.equal(inp.getAttribute('aria-invalid'), 'true');
    assert.equal(inp.focado, 1, 'foco no campo');
    inp.oninput(); assert.equal(erro.hidden, true, 'digitar limpa o erro'); assert.equal(inp.getAttribute('aria-invalid'), null);
  }
  assert.deepEqual(c.pedidos, [], 'nada vai ao servidor com o limite inválido');

  inp.value = ' 7 ';
  await btn.onclick();
  assert.deepEqual(c.pedidos, [{ caminho: '/ajustes', metodo: 'PUT', corpo: { verificador_ativo: true, verificador_limite_pct: 7 } }]);
  assert.deepEqual(c.avisos, [{ m: V.salvo, erro: false }]);
  assert.deepEqual([btn.disabled, btn.textContent, btn.focado], [false, V.salvar, 1], 'botão volta e recebe o foco');

  // desligar: limite desabilitado, dica à mostra; o limite (mesmo inválido) não vai no corpo
  chk.checked = false; chk.onchange();
  assert.deepEqual([inp.disabled, dica.hidden], [true, false]);
  inp.value = '999';
  await btn.onclick();
  assert.deepEqual(c.pedidos.at(-1).corpo, { verificador_ativo: false });
  chk.checked = true; chk.onchange();
  assert.deepEqual([inp.disabled, dica.hidden], [false, true]);

  // erro do servidor: toast de erro e o botão volta
  c.falhar(new Error('Informe um número inteiro de 0 a 50.'));
  inp.value = '9';
  await btn.onclick();
  assert.deepEqual(c.avisos.at(-1), { m: 'Informe um número inteiro de 0 a 50.', erro: true });
  assert.deepEqual([btn.disabled, btn.textContent], [false, V.salvar]);
});

test('CA7: Templates mostra a dica visível de {HORA_PRECO}; Ajustes põe o cartão entre Título e Modo do link', () => {
  const tpl = trechoApp('function paginaTemplates(', '$$(\'.modelos button\')');
  assert.match(tpl, /id="chips"[\s\S]*<small class="dica">\$\{esc\(TEXTOS_VERIFICADOR\.horaPreco\)\}<\/small>\s*<small class="dica">Dica do WhatsApp/);
  const c = cartao();
  assert.match(c.TEXTOS_VERIFICADOR.horaPreco, /^\{HORA_PRECO\}: .*14h32.*\[ \].*LINK.*\[🕒 Preço visto às \{HORA_PRECO\}\]$/);
  const aj = trechoApp('function paginaAjustes(', 'function cartaoVerificador(');
  assert.ok(aj.indexOf('ajustes.titulo') < aj.indexOf('${cartaoVerificador(a)}') && aj.indexOf('${cartaoVerificador(a)}') < aj.indexOf('ajustes.modo_link'));
  assert.match(aj, /ligarCartaoVerificador\(\);/);
});

/** public/disparos.js num vm (só funções; as páginas abrem com `$` falso). */
function disparos(S, { fetch: fetchFalso } = {}) {
  const { $, mapa } = fabricaDollar();
  const ctx = {
    console, setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; }, clearTimeout, Number, String, Math, Date, JSON, Array, Object, RegExp, URL, Intl, Promise, Symbol, Error, Set, Map,
    document: { createElement: () => el(), getElementById: () => null, activeElement: null, body: el() },
    $, $$: () => [], esc, zap: (x) => String(x), REQ: '*', q: () => '', opcoes: () => '', aviso() {}, mostrarErros() { return false; },
    S, seletorGrupos: () => ({ html: '', ligar() {}, marcados: () => [] }),
    location: { hash: '#teste', replace() {} }, confirm: () => true, FileReader: class {},
    fetch: fetchFalso ?? (async () => ({ status: 404, ok: false, json: async () => ({}) })),
  };
  vm.createContext(ctx);
  vm.runInContext(`${lerPublic('disparos.js')}\n;globalThis.__x = { dispPill, dispTabela, paginaDisparoManual, TEXTOS_DISPAROS };`, ctx);
  return { ...ctx.__x, $, mapa };
}
const S_BASE = (ajustes) => ({ templates: [{ id: 1, name: 'Padrão', body: '{LINK}' }], tags: [{ id: 1, name: 'etq' }], groups: [], st: { whatsapp: { status: 'open' }, extensao: { online: true }, ajustes, simulacao: false } });

test('CA7: Disparo manual: selo "Descartado" com o motivo (sem o "Descartada:"); as outras linhas não mudam', () => {
  const D = disparos(S_BASE({}));
  const texto = 'Descartada: preço subiu de R$ 89,90 para R$ 99,90 (+11%, o limite é 5%)';
  const motivo = 'preço subiu de R$ 89,90 para R$ 99,90 (+11%, o limite é 5%)';
  assert.equal(D.dispPill('erro', 1, texto, 'preco_subiu'),
    `<span class="estado-pill pausado">Descartado</span><span class="dica-celula trunca" title="${motivo}">${motivo}</span>`);
  assert.match(D.dispPill('erro', 1, null, 'esgotado'), /Descartado<\/span><span class="dica-celula trunca" title="esgotado na loja">esgotado na loja</, 'sem texto, o motivo pela chave');
  assert.equal(D.dispPill('erro', 1, '<b>x</b>', 'nao_conferido'), '<span class="estado-pill pausado">Descartado</span><span class="dica-celula trunca" title="&lt;b&gt;x&lt;/b&gt;">&lt;b&gt;x&lt;/b&gt;</span>', 'escapado');
  // sem descartado (ou com valor que não é texto), o selo é o de antes
  assert.equal(D.dispPill('erro', 1, 'falhou'), '<span class="estado-pill erro">Erro</span><span class="dica-celula trunca" title="falhou">falhou</span>');
  assert.equal(D.dispPill('erro', 1, 'falhou', null), D.dispPill('erro', 1, 'falhou'));
  assert.equal(D.dispPill('erro', 1, 'falhou', true), D.dispPill('erro', 1, 'falhou'));
  assert.match(D.dispPill('enviado', 1), /Enviado/);

  const tabela = D.dispTabela([
    { quando: 1, titulo: 'Fone', grupo: 'Achadinhos', status: 'erro', erro: MOTIVOS_VERIFICADOR.esgotado, descartado: 'esgotado' },
    { quando: 1, titulo: 'Fone', grupo: 'Tech', status: 'erro', erro: 'WhatsApp desconectado' },
  ], 'Produto', () => '');
  assert.match(tabela, /Descartado<\/span><span class="dica-celula trunca" title="esgotado na loja">/);
  assert.match(tabela, /estado-pill erro">Erro<\/span><span class="dica-celula trunca" title="WhatsApp desconectado">/);
});

test('CA7: Disparo manual: a dica do agendar ("conferidos na hora do envio") só com o verificador ligado', () => {
  for (const [ajustes, tem] of [[{}, true], [{ verificador_ativo: true }, true], [{ verificador_ativo: false }, false]]) {
    const D = disparos(S_BASE(ajustes));
    D.paginaDisparoManual();
    const html = D.$('#pagina').innerHTML;
    const campo = html.slice(html.indexOf('id="dm-hora-campo"'), html.indexOf('</label>', html.indexOf('id="dm-hora-campo"')));
    assert.ok(campo.length > 0);
    if (tem) {
      assert.match(campo, /<input type="time" id="dm-hora"[^>]*aria-describedby="dm-hora-confere">/);
      assert.match(campo, new RegExp(`<small class="dica" id="dm-hora-confere">${D.TEXTOS_DISPAROS.agendarConfere}</small>`));
      assert.equal(D.TEXTOS_DISPAROS.agendarConfere, 'O preço e o estoque são conferidos na hora do envio, não agora.');
    } else {
      assert.doesNotMatch(campo, /dm-hora-confere/, JSON.stringify(ajustes));
    }
  }
});

test('R1: o Identificar de loja sem conferência troca a dica do agendar pela explicação; outra identificação a devolve', async () => {
  const respostas = [
    { loja: { id: 'magalu', nome: 'Magalu', implementada: true }, sem_conferencia: true, produto: null, texto: null },
    { loja: { id: 'mercadolivre', nome: 'Mercado Livre', implementada: true }, produto: { title: 'Fone', price: 10 }, texto: 'x' },
  ];
  const D = disparos(S_BASE({}), { fetch: async (caminho) => (caminho === '/api/disparo/identificar'
    ? { status: 200, ok: true, json: async () => respostas.shift() } : { status: 404, ok: false, json: async () => ({}) }) });
  D.paginaDisparoManual();
  const dica = D.$('#dm-hora-confere');
  D.$('#dm-url').value = 'https://www.magazinevoce.com.br/loja/p/x/1/';
  await D.$('#dm-identificar').onclick();
  assert.equal(dica.textContent, 'Esta loja não tem conferência de preço: agende para até 25 min ou envie agora.');
  assert.equal(dica.textContent, D.TEXTOS_DISPAROS.agendarSemConferencia);
  // editar o link limpa o resultado e a dica volta
  D.$('#dm-url').value = 'https://www.magazinevoce.com.br/loja/p/x/2/';
  D.$('#dm-url').oninput();
  assert.equal(dica.textContent, D.TEXTOS_DISPAROS.agendarConfere, 'link editado: a dica de sempre');
  D.$('#dm-url').value = 'https://produto.mercadolivre.com.br/MLB-1-x';
  await D.$('#dm-identificar').onclick();
  assert.equal(dica.textContent, D.TEXTOS_DISPAROS.agendarConfere, 'loja que confere: a dica de sempre');
});

test('CA7: TIPS das duas ajudas do cartão (sem a de falha, D3)', () => {
  const ctx = { document: { addEventListener() {}, getElementById: () => null }, addEventListener() {} }; vm.createContext(ctx);
  vm.runInContext(`${lerPublic('ajuda.js')}\n;globalThis.__t = JSON.stringify(TIPS);`, ctx);
  const TIPS = JSON.parse(ctx.__t);
  assert.match(TIPS['ajustes.verificador'], /esgotado/);
  assert.match(TIPS['ajustes.verificador'], /30 min/);
  assert.match(TIPS['ajustes.verificador.limite'], /Padrão 5, de 0 a 50/);
  assert.ok(!Object.hasOwn(TIPS, 'ajustes.verificador.falha'));
});

test('CA6: nenhum teste deste arquivo acessou a rede', () => {
  assert.equal(acessosRede, 0);
});
