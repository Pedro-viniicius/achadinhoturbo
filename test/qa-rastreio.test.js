// QA do rastreio por grupo (plano dashboard-ganhos, Entrega A, etapas 1 a 8): casos de borda, segurança e regressões que
// os testes do dev (rastreio, envios, disparador, catalogo-itens, seguranca) não cobrem. Nenhum teste acessa a rede
// (o fetch global é trocado por um que falha), o WhatsApp é simulado e os links são meli.la/fake-….
// Um teste que falha aqui é bug do produto (ver o relatório do QA): não relaxe a asserção.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';
import { createScheduler } from '../src/scheduler.js';
import { createEnvios } from '../src/envios.js';
import { createAmazon } from '../src/amazon.js';
import { createCatalogoItens } from '../src/catalogo-itens.js';
import { paraCandidato } from '../src/catalogo.js';
import * as mlPadrao from '../src/ml.js';
import * as rastreio from '../src/rastreio.js';

globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };

const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rastreio-')); pastas.push(p); return p; };
const linhas = (db, sql, ...a) => db.prepare(sql).all(...a).map((r) => ({ ...r }));
const contar = (db, tabela) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n;

const G1 = '111@g.us'; const G2 = '222@g.us'; const G3 = '333@g.us';
const GRUPOS3 = [G1, G2, G3];
const DIA = 86400000;

/** Banco com 3 grupos, as etiquetas etiquetaA/etiquetaB e o template 1 (o que o openDb semeia). */
function montarDb() {
  const dir = tmp(); const db = openDb(dir);
  for (const [jid, nome] of [[G1, 'Achadinhos'], [G2, 'Tech'], [G3, 'Casa']]) {
    db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, Date.now());
  }
  for (const n of ['etiquetaA', 'etiquetaB']) db.prepare('INSERT INTO tags (name, created_at) VALUES (?, 1)').run(n);
  return { dir, db };
}
const bloco = (db, jids, nome = 'Bloco') => {
  const id = Number(db.prepare('INSERT INTO blocks (name, created_at) VALUES (?, ?)').run(nome, Date.now()).lastInsertRowid);
  for (const j of jids) db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (?, ?)').run(id, j);
  return id;
};
const assoc = (db, loja, alvo_tipo, alvo, codigo) => rastreio.salvar(db, { loja, alvo_tipo, alvo: String(alvo), codigo });
const recusa = (status, re) => (e) => e instanceof rastreio.ErroRastreio && e.status === status && re.test(e.message);

// ------------------------------------------------------------------------------------------------ servidor HTTP

/** Servidor sem login (o Dono é quem usa o computador), com um `ml` falso, em porta aleatória. */
async function subir() {
  const { dir, db } = montarDb();
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const pedidos = [];
  const original = links.requestLink.bind(links);
  links.requestLink = (a) => { pedidos.push(a.tag); return original(a); };
  const ml = { async resolveOffer(c) { return { key: c.key, url: c.url, title: 'Fone Bom', price: 89.9, oldPrice: 149.9, discountPct: 40, sold: 1200, freeShipping: true, image: null }; } };
  const scheduler = createScheduler({ db, wa, links, fast: true, dir, ml });
  const app = buildApp({ db, wa, links, scheduler, publicHost: '', panelPassword: '', dataDir: dir, ml });
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const req = (caminho, { method = 'GET', body, raw, tipo, headers = {} } = {}) => new Promise((ok, err) => {
    const data = raw !== undefined ? Buffer.from(raw) : body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { origin, ...(data ? { 'content-length': data.length, 'content-type': tipo || 'application/json' } : {}), ...headers };
    const r = http.request({ host: '127.0.0.1', port, path: caminho, method, headers: h }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* não é JSON */ } ok({ status: res.statusCode, json, txt }); });
    });
    r.on('error', err); if (data) r.write(data); r.end();
  });
  return {
    db, wa, dir, pedidos, req,
    put: (corpo) => req('/api/rastreio/codigos', { method: 'PUT', body: corpo }),
    fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }),
  };
}

// =============================================================================================== rotas e núcleo

test('PUT: código que não é texto (número, booleano, objeto, lista) é recusado e NÃO apaga a associação que já existe', async () => {
  const s = await subir();
  try {
    const b = bloco(s.db, [G1]);
    assert.equal((await s.put({ loja: 'amazon', alvo_tipo: 'bloco', alvo: b, codigo: 'turbob1-20' })).status, 200);
    for (const ruim of [123, true, false, {}, [], ['turbob2-20'], { toString: 'x' }]) {
      const r = await s.put({ loja: 'amazon', alvo_tipo: 'bloco', alvo: b, codigo: ruim });
      assert.equal(r.status, 400, `código ${JSON.stringify(ruim)}: ${r.txt}`);
      assert.deepEqual(linhas(s.db, 'SELECT loja, alvo, codigo FROM rastreio_codigos'), [{ loja: 'amazon', alvo: String(b), codigo: 'turbob1-20' }], `código ${JSON.stringify(ruim)} apagou ou trocou a associação`);
    }
  } finally { await s.fechar(); }
});

test('PUT: corpo ausente, lista, texto puro, JSON quebrado e corpo gigante dão 4xx com frase fixa; nada gravado; nunca 500', async () => {
  const s = await subir();
  try {
    const casos = [
      ['sem corpo', {}],
      ['lista', { raw: '[1,2]' }],
      ['texto puro', { raw: 'loja=amazon', tipo: 'text/plain' }],
      ['JSON quebrado', { raw: '{"loja":' }],
      ['nulo', { raw: 'null' }],
      ['associacoes não é lista', { raw: '{"associacoes":"x"}' }],
      ['associacoes vazia', { raw: '{"associacoes":[]}' }],
      ['gigante', { raw: JSON.stringify({ loja: 'amazon', alvo_tipo: 'grupo', alvo: G1, codigo: 'a'.repeat(2_000_000) }) }],
    ];
    for (const [nome, o] of casos) {
      const r = await s.req('/api/rastreio/codigos', { method: 'PUT', ...o });
      assert.ok(r.status >= 400 && r.status < 500, `${nome}: status ${r.status} ${r.txt.slice(0, 120)}`);
      assert.ok(!/at .*\.js|node_modules|SQLITE/i.test(r.txt), `${nome}: vazou pilha ou erro do banco`);
    }
    assert.equal(contar(s.db, 'rastreio_codigos'), 0);
  } finally { await s.fechar(); }
});

test('PUT bloco: id com zero à esquerda, ponto, espaço, sinal ou notação científica é 404 e nada é gravado', async () => {
  const s = await subir();
  try {
    const b = bloco(s.db, [G1]);
    assert.equal(b, 1);
    for (const alvo of ['01', '1.0', ' 1', '+1', '1e0', '1 ', '0x1', 1.5, -1, 0, null, '', '9007199254740993']) {
      const r = await s.put({ loja: 'amazon', alvo_tipo: 'bloco', alvo, codigo: 'casa-20' });
      assert.equal(r.status, 404, `alvo ${JSON.stringify(alvo)}: ${r.txt}`);
    }
    assert.equal(contar(s.db, 'rastreio_codigos'), 0);
  } finally { await s.fechar(); }
});

test('DELETE /api/blocks/01 (o SQLite acha o bloco 1) também apaga as associações do bloco 1: nada de associação órfã', async () => {
  const s = await subir();
  try {
    const b = bloco(s.db, [G1]);
    assoc(s.db, 'amazon', 'bloco', b, 'turbob1-20');
    assoc(s.db, 'shopee', 'bloco', b, 'b1');
    const r = await s.req('/api/blocks/01', { method: 'DELETE' });
    assert.equal(r.status, 200, r.txt);
    assert.equal(contar(s.db, 'blocks'), 0, 'o bloco 1 foi apagado');
    assert.deepEqual(linhas(s.db, 'SELECT loja, alvo, codigo FROM rastreio_codigos'), [], 'sobraram associações do bloco que não existe mais');
  } finally { await s.fechar(); }
});

test('bloco apagado e outro criado depois (o id não é reaproveitado, S1) não herda as associações do anterior', async () => {
  const s = await subir();
  try {
    const criar = (nome, jids) => s.req('/api/blocks', { method: 'POST', body: { name: nome, group_jids: jids } });
    const a = (await criar('Antigo', [G1])).json.id;
    assoc(s.db, 'amazon', 'bloco', a, 'antigo-20');
    assert.equal((await s.req(`/api/blocks/${a}`, { method: 'DELETE' })).status, 200);
    const novo = (await criar('Novo', [G2])).json.id;
    assert.ok(novo > a, 'o id não é reaproveitado (S1)');
    assert.deepEqual(rastreio.listar(s.db), []);
    assert.equal(rastreio.resolver(s.db, 'amazon', G2).nivel, 'padrao', 'o bloco novo não tem código');
  } finally { await s.fechar(); }
});

test('editar o bloco (tirar um grupo) tira o grupo do código do bloco; quem ficou continua com ele', async () => {
  const s = await subir();
  try {
    const b = (await s.req('/api/blocks', { method: 'POST', body: { name: 'Casa', group_jids: [G1, G2] } })).json.id;
    assoc(s.db, 'amazon', 'bloco', b, 'casa-20');
    assert.equal((await s.req(`/api/blocks/${b}`, { method: 'PUT', body: { name: 'Casa', group_jids: [G1] } })).status, 200);
    assert.deepEqual(['grupo ficou', rastreio.resolver(s.db, 'amazon', G1).nivel], ['grupo ficou', 'bloco']);
    assert.deepEqual(['grupo saiu', rastreio.resolver(s.db, 'amazon', G2)], ['grupo saiu', { codigo: null, nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null }]);
  } finally { await s.fechar(); }
});

test('Amazon: dois IDs de rastreamento que só diferem na caixa são o mesmo código (a Amazon não distingue) → duplicado', () => {
  const { db } = montarDb();
  const b1 = bloco(db, [G1]); const b2 = bloco(db, [G2]);
  assoc(db, 'amazon', 'bloco', b1, 'Turbo-20');
  assert.throws(() => assoc(db, 'amazon', 'bloco', b2, 'turbo-20'), recusa(400, /já está associado/));
  assert.throws(() => assoc(db, 'amazon', 'grupo', G3, 'TURBO-20'), recusa(400, /já está associado/));
  assert.equal(contar(db, 'rastreio_codigos'), 1);
  db.close();
});

test('Shopee: Sub_id de 30 caracteres passa e de 31 não; espaço nas pontas e quebra de linha final são aparados; acento e espaço no meio, recusados', () => {
  const { db } = montarDb();
  const b = bloco(db, [G1]);
  assert.equal(rastreio.validarCodigo(db, 'shopee', 'a'.repeat(30), 'bloco'), 'a'.repeat(30));
  assert.throws(() => rastreio.validarCodigo(db, 'shopee', 'a'.repeat(31), 'bloco'), recusa(400, /letras e números/));
  assert.equal(assoc(db, 'shopee', 'bloco', b, ' g1\n').codigo, 'g1');
  for (const ruim of ['g 1', 'g\n1', 'gé', 'g١', 'ｇ１', 'g-1', 'g_1', 'g.1', "g';--", '<b>', 'g\u0000']) {
    assert.throws(() => rastreio.validarCodigo(db, 'shopee', ruim, 'bloco'), recusa(400, /letras e números/), JSON.stringify(ruim));
  }
  db.close();
});

test('lote: 10 associações passam, 11 não; o mesmo código em dois blocos do mesmo lote desfaz o que já tinha sido gravado', async () => {
  const s = await subir();
  try {
    const ids = []; for (let i = 0; i < 11; i++) ids.push(bloco(s.db, [], `B${i}`));
    const item = (i, codigo) => ({ loja: 'shopee', alvo_tipo: 'bloco', alvo: ids[i], codigo });
    const dez = ids.slice(0, 10).map((_, i) => item(i, `s${i}`));
    assert.equal((await s.put({ associacoes: dez })).status, 200);
    assert.equal(contar(s.db, 'rastreio_codigos'), 10);
    const onze = await s.put({ associacoes: [...dez, item(10, 'extra')] });
    assert.equal(onze.status, 400);
    assert.equal(contar(s.db, 'rastreio_codigos'), 10, 'o 11º não entrou');
    // duplicado dentro do lote: o primeiro item é válido, o segundo repete o código → nada muda
    const antes = linhas(s.db, 'SELECT loja, alvo, codigo FROM rastreio_codigos ORDER BY alvo');
    const dup = await s.put({ associacoes: [item(0, 'novo0'), item(1, 'novo0')] });
    assert.equal(dup.status, 400, dup.txt);
    assert.deepEqual(linhas(s.db, 'SELECT loja, alvo, codigo FROM rastreio_codigos ORDER BY alvo'), antes, 'o lote é tudo ou nada');
  } finally { await s.fechar(); }
});

test('PUT idempotente: gravar a mesma associação de novo não troca o id nem a data de criação', () => {
  const { db } = montarDb();
  const b = bloco(db, [G1]);
  const a = rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: b, codigo: 'etiquetaA' }, 1000);
  const c = rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: String(b), codigo: 'etiquetaA' }, 9000);
  assert.deepEqual([c.id, c.criado_em], [a.id, a.criado_em]);
  assert.equal(contar(db, 'rastreio_codigos'), 1);
  db.close();
});

test('isolamento entre lojas: o código do ML não vale para a Amazon nem para a Shopee do mesmo grupo (e vice-versa)', () => {
  const { db } = montarDb();
  const b = bloco(db, [G1]);
  assoc(db, 'mercadolivre', 'grupo', G1, 'etiquetaB');
  assert.equal(rastreio.resolver(db, 'mercadolivre', G1).codigo, 'etiquetaB');
  assert.equal(rastreio.resolver(db, 'amazon', G1).nivel, 'padrao');
  assert.equal(rastreio.resolver(db, 'shopee', G1).nivel, 'padrao');
  assoc(db, 'shopee', 'bloco', b, 'etiquetaB'); // mesmo texto, outra loja: permitido (UNIQUE é por loja)
  assoc(db, 'amazon', 'bloco', b, 'etiquetab-20');
  assert.deepEqual(['ml', rastreio.resolver(db, 'mercadolivre', G1).nivel], ['ml', 'grupo']);
  assert.deepEqual(['shopee', rastreio.resolver(db, 'shopee', G1).codigo], ['shopee', 'etiquetaB']);
  db.close();
});

test('cobertura: os limites do período são inclusivos (de e ate) e 1 ms fora não entra', () => {
  const { db } = montarDb();
  const de = Date.UTC(2026, 9, 1); const ate = Date.UTC(2026, 9, 31, 23, 59, 59, 999);
  const linha = (ts) => rastreio.registrar(db, { ts, jid: G1, loja: 'amazon', origem: 'regra', link: 'https://www.amazon.com.br/dp/B000000001?tag=x-20', nivel: 'bloco', esperado: 1, codigo: 'x-20' });
  for (const ts of [de - 1, de, ate, ate + 1]) linha(ts);
  assert.equal(rastreio.cobertura(db, { de, ate }).total.envios, 2);
  assert.equal(rastreio.cobertura(db, { de, ate: de }).total.envios, 1);
  assert.equal(rastreio.cobertura(db, { de: ate, ate }).total.envios, 1);
  db.close();
});

test('limpar: a linha de exatamente 400 dias fica; 1 ms mais velha sai; o resto da tabela não é tocado', () => {
  const { db } = montarDb();
  const agora = Date.UTC(2027, 0, 1);
  const linha = (ts) => rastreio.registrar(db, { ts, jid: G1, loja: 'shopee', origem: 'manual', link: 'https://s.shopee.com.br/abc', nivel: 'padrao' });
  linha(agora - 400 * DIA); linha(agora - 400 * DIA - 1); linha(agora);
  assoc(db, 'amazon', 'grupo', G1, 'casa-20');
  assert.equal(rastreio.limpar(db, undefined, agora), 1);
  assert.equal(contar(db, 'rastreio_envios'), 2);
  assert.equal(contar(db, 'rastreio_codigos'), 1, 'associação não é apagada pela retenção');
  db.close();
});

test('GET cobertura: datas inválidas no período custom caem no padrão (200); loja ou bloco repetidos/mal formados são 400/404, nunca 500', async () => {
  const s = await subir();
  try {
    for (const q of ['periodo=custom&de=lixo&ate=outro-lixo', 'periodo=custom&de=2026-13-45', 'periodo=zzz', 'periodo=7d&periodo=30d', 'periodo=custom&de=2030-01-01&ate=2000-01-01']) {
      const r = await s.req(`/api/rastreio/cobertura?${q}`);
      assert.equal(r.status, 200, `${q}: ${r.txt}`);
      assert.ok(Number.isFinite(r.json.de) && Number.isFinite(r.json.ate) && r.json.de <= r.json.ate, q);
    }
    assert.equal((await s.req('/api/rastreio/cobertura?loja=amazon&loja=shopee')).status, 400);
    assert.equal((await s.req('/api/rastreio/cobertura?loja=constructor')).status, 400);
    assert.equal((await s.req('/api/rastreio/cobertura?bloco=1&bloco=2')).status, 404);
    assert.equal((await s.req('/api/rastreio/cobertura?bloco=__proto__')).status, 404);
  } finally { await s.fechar(); }
});

// =============================================================================================== envio manual (ponta a ponta)

test('HTTP: associação gravada pelo PUT vale no Disparo manual (POST /api/envios); a etiqueta escolhida perde para a associação (P1)', async () => {
  const s = await subir();
  try {
    assert.equal((await s.put({ loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: G2, codigo: 'etiquetaB' })).status, 200);
    const c = await s.req('/api/envios', { method: 'POST', body: { tipo: 'oferta', url: 'https://produto.mercadolivre.com.br/MLB-1234567890-fone-bom-_JM', template_id: 1, tag_id: 1, group_jids: GRUPOS3 } });
    assert.equal(c.status, 200, c.txt);
    for (let i = 0; i < 400 && s.db.prepare("SELECT status FROM envios WHERE id = ?").get(c.json.id).status !== 'concluido'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(s.pedidos, ['etiquetaA', 'etiquetaB'], 'um pedido por código: o do grupo 2 é à parte');
    const links = s.wa.simulated.map((m) => /meli\.la\/fake-(\w+)-/.exec(m.text)?.[1]);
    assert.deepEqual(links, ['etiquetaA', 'etiquetaB', 'etiquetaA']);
    assert.deepEqual(linhas(s.db, 'SELECT jid, codigo, nivel, esperado, origem FROM rastreio_envios ORDER BY id'), [
      { jid: G1, codigo: 'etiquetaA', nivel: 'padrao', esperado: 0, origem: 'manual' },
      { jid: G2, codigo: 'etiquetaB', nivel: 'grupo', esperado: 1, origem: 'manual' },
      { jid: G3, codigo: 'etiquetaA', nivel: 'padrao', esperado: 0, origem: 'manual' },
    ]);
  } finally { await s.fechar(); }
});

/** Fila de envios com links falsos, sem passar pelo servidor. */
function filaEnvios(m, { amazon } = {}) {
  const links = createLinkService({ getMode: () => 'fake' });
  const pedidos = []; const original = links.requestLink.bind(links);
  links.requestLink = (a) => { pedidos.push(a.tag); return original(a); };
  const envios = createEnvios({ db: m.db, wa: m.wa, links, ml: {}, fast: true, dir: m.dir, ...(amazon ? { amazon } : {}) });
  return { envios, pedidos };
}
const waDe = (m) => { const wa = createWhatsApp({ db: m.db, dir: m.dir, dryRun: true }); wa.connect(); return wa; };
const tplCriadoEm = (db) => db.prepare('SELECT created_at FROM templates WHERE id = 1').get().created_at;
const inserirEnvio = (db, payload, jids) => Number(db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, status, next_run_at, created_at)
  VALUES ('oferta', ?, ?, 'agora', 'pendente', ?, ?)`).run(JSON.stringify(payload), JSON.stringify(jids), Date.now(), Date.now()).lastInsertRowid);
const OFERTA = { key: 'MLB1234567890', title: 'Fone Bom', price: 89.9, oldPrice: null, discountPct: null, sold: null, freeShipping: true, coupon: null, image: null };
const payloadML = (db, extra = {}) => ({
  url: 'https://produto.mercadolivre.com.br/MLB-1234567890', loja: 'mercadolivre', tag_id: 1, etiqueta: 'etiquetaA', template_id: 1,
  template_criado_em: tplCriadoEm(db), fonte_dados: 'manual', origem: { tipo: 'manual' }, offer: OFERTA, ...extra,
});
const ASIN = 'B0ABC12345';
const payloadAmazon = (db, extra = {}) => ({
  url: `https://www.amazon.com.br/dp/${ASIN}`, loja: 'amazon', asin: ASIN, tag_id: null, etiqueta: null, template_id: 1, template_criado_em: tplCriadoEm(db),
  fonte_dados: 'texto', origem: { tipo: 'manual' }, offer: { ...OFERTA, key: `ASIN:${ASIN}` }, ...extra,
});
const amazonCom = (db, tag) => createAmazon({ db, fetch: async () => { throw new Error('rede proibida'); }, esperar: async () => {}, lerConexao: () => ({ tag }) });
const linkDoTexto = (x) => /https:\/\/\S+$/.exec(x.text)?.[0];

test('P9/CA9: bloco com etiqueta (blocks.tag_id) mas SEM associação de rastreio não muda o envio: 1 pedido, mesmo link, linhas "padrao"', async () => {
  const m = montarDb(); m.wa = waDe(m);
  const b = bloco(m.db, GRUPOS3);
  m.db.prepare('UPDATE blocks SET tag_id = 2 WHERE id = ?').run(b); // etiquetaB no bloco; o envio escolhe a etiquetaA
  const { envios, pedidos } = filaEnvios(m);
  const id = inserirEnvio(m.db, payloadML(m.db), GRUPOS3);
  await envios.runEnvio(id);
  assert.deepEqual(pedidos, ['etiquetaA']);
  assert.equal(new Set(m.wa.simulated.map(linkDoTexto)).size, 1);
  assert.deepEqual(linhas(m.db, 'SELECT codigo, nivel, esperado FROM rastreio_envios'), Array(3).fill({ codigo: 'etiquetaA', nivel: 'padrao', esperado: 0 }));
  m.db.close();
});

test('runEnvio chamado de novo num envio já concluído não manda outra vez nem duplica as linhas de rastreio', async () => {
  const m = montarDb(); m.wa = waDe(m);
  const { envios } = filaEnvios(m);
  assoc(m.db, 'mercadolivre', 'grupo', G1, 'etiquetaB');
  const id = inserirEnvio(m.db, payloadML(m.db), GRUPOS3);
  await envios.runEnvio(id);
  const antes = [m.wa.simulated.length, contar(m.db, 'rastreio_envios')];
  await envios.runEnvio(id); await envios.runEnvio(id);
  assert.deepEqual([m.wa.simulated.length, contar(m.db, 'rastreio_envios')], antes);
  assert.deepEqual(antes, [3, 3]);
  m.db.close();
});

test('CA1: a hora gravada é a do envio (entre o início e o fim da execução) e o jid é sempre de grupo, nunca de pessoa', async () => {
  const m = montarDb(); m.wa = waDe(m);
  const { envios } = filaEnvios(m);
  const id = inserirEnvio(m.db, payloadML(m.db), GRUPOS3);
  const t0 = Date.now();
  await envios.runEnvio(id);
  const t1 = Date.now();
  const rs = linhas(m.db, 'SELECT ts, jid FROM rastreio_envios');
  assert.equal(rs.length, 3);
  assert.ok(rs.every((r) => r.ts >= t0 && r.ts <= t1), JSON.stringify(rs));
  assert.ok(rs.every((r) => /@g\.us$/.test(r.jid)));
  m.db.close();
});

test('CA3: Amazon sem tag em Conexões — grupos com ID associado saem com ele; o grupo sem associação falha; nenhum link sai sem tag', async () => {
  const m = montarDb(); m.wa = waDe(m);
  const amazon = amazonCom(m.db, '');
  const { envios } = filaEnvios(m, { amazon });
  const b = bloco(m.db, [G1, G2]);
  assoc(m.db, 'amazon', 'bloco', b, 'turbob1-20');
  const id = inserirEnvio(m.db, payloadAmazon(m.db), GRUPOS3);
  await envios.runEnvio(id);
  const enviados = m.wa.simulated.map((x) => [x.jid, linkDoTexto(x)]);
  assert.deepEqual(enviados, [[G1, `https://www.amazon.com.br/dp/${ASIN}?tag=turbob1-20`], [G2, `https://www.amazon.com.br/dp/${ASIN}?tag=turbob1-20`]]);
  assert.ok(m.wa.simulated.every((x) => !/amazon\.com\.br\/dp\/\w+(?!\?tag=)(\s|$)/.test(x.text) || /\?tag=/.test(x.text)));
  assert.deepEqual(linhas(m.db, 'SELECT jid, ok FROM envio_resultados ORDER BY jid'), [{ jid: G1, ok: 1 }, { jid: G2, ok: 1 }, { jid: G3, ok: 0 }]);
  assert.deepEqual(linhas(m.db, 'SELECT jid FROM rastreio_envios ORDER BY jid').map((r) => r.jid), [G1, G2], 'o grupo que falhou não ganha linha');
  m.db.close();
});

test('segurança: o ID de rastreamento da Amazon nunca aparece no histórico, no resultado por grupo, no console nem na resposta do painel', async (t) => {
  const erros = t.mock.method(console, 'error', () => {});
  const avisos = t.mock.method(console, 'log', () => {});
  const m = montarDb(); m.wa = waDe(m);
  const SEGREDO = 'segredo-xyz-20';
  const amazon = amazonCom(m.db, 'padrao-20');
  const { envios } = filaEnvios(m, { amazon });
  assoc(m.db, 'amazon', 'grupo', G1, SEGREDO);
  const id = inserirEnvio(m.db, payloadAmazon(m.db), GRUPOS3);
  await envios.runEnvio(id);
  assert.ok(m.wa.simulated.some((x) => x.text.includes(SEGREDO)), 'a tag vai inteira ao WhatsApp (e só lá e no rastreio)');
  for (const tabela of ['log', 'envio_resultados']) {
    const texto = JSON.stringify(linhas(m.db, `SELECT * FROM ${tabela}`));
    assert.ok(!texto.includes(SEGREDO), `${tabela} vazou o ID de rastreamento`);
  }
  const painel = JSON.stringify(envios.painel('oferta'));
  assert.ok(!painel.includes(SEGREDO), 'o painel de envios vazou o ID de rastreamento');
  assert.ok(![...erros.mock.calls, ...avisos.mock.calls].some((c) => JSON.stringify(c.arguments).includes(SEGREDO)), 'console');
  m.db.close();
});

// =============================================================================================== regras (agendador)

const ITEM1 = 'https://produto.mercadolivre.com.br/MLB-1000001-a | Fone A | 50 | 100';
const addRegra = (db, items, groups = GRUPOS3) => Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config,
  per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at) VALUES ('R',1,1,1,?,'list',?,3,60,'00:00','23:59',7,1,?)`)
  .run(JSON.stringify(groups), JSON.stringify({ items }), Date.now()).lastInsertRowid);

test('regra: rodar duas vezes não repete a oferta (dedupe) nem duplica as linhas de rastreio; associação órfã de grupo que sumiu não atrapalha', async () => {
  const { dir, db } = montarDb();
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  // associação de um grupo que não está mais em `groups` (a sincronização do WhatsApp apaga a linha, não a associação)
  db.prepare("INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo) VALUES ('mercadolivre', 'grupo', '999@g.us', 'etiquetaZ')").run();
  assoc(db, 'mercadolivre', 'grupo', G2, 'etiquetaB');
  const id = addRegra(db, ITEM1);
  const r1 = await scheduler.runRule(id);
  assert.deepEqual([r1.offers, r1.messages, r1.errors], [1, 3, 0]);
  const r2 = await scheduler.runRule(id);
  assert.deepEqual([r2.offers, r2.messages], [0, 0]);
  assert.deepEqual(linhas(db, 'SELECT jid, codigo, nivel FROM rastreio_envios ORDER BY id'), [
    { jid: G1, codigo: 'etiquetaA', nivel: 'padrao' }, { jid: G2, codigo: 'etiquetaB', nivel: 'grupo' }, { jid: G3, codigo: 'etiquetaA', nivel: 'padrao' },
  ]);
  db.close();
});

test('regra, CA3: catálogo Amazon sem tag em Conexões — nenhuma mensagem sai sem tag, e o grupo sem associação não recebe nada', async () => {
  const { dir, db } = montarDb();
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const conexao = { tag: '' };
  const amazon = createAmazon({ db, fetch: async () => { throw new Error('rede proibida'); }, esperar: async () => {}, lerConexao: () => conexao });
  const oferta = { id: 1, loja: 'amazon', titulo: 'Produto 1', preco: 100, preco_antigo: 150, desconto_pct: 33, categoria: 'Casa', item_id: 'B000000001', link: 'https://www.amazon.com.br/dp/X?tag=terceiro-20' };
  const catalogo = { candidatos: async () => [paraCandidato(oferta)] };
  const catalogoItens = createCatalogoItens({ db, wa, links, amazon });
  const scheduler = createScheduler({ db, wa, links, ml: mlPadrao, fast: true, amazon, catalogo, catalogoItens });
  const b = bloco(db, [G2]);
  assoc(db, 'amazon', 'bloco', b, 'turbob2-20');
  const id = Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, sources, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('Catálogo', 1, 1, 1, ?, 'list', '{}', ?, 3, 60, '00:00', '23:59', 7, 0, ?)`)
    .run(JSON.stringify(GRUPOS3), JSON.stringify([{ type: 'catalogo', tag_id: null, config: { ordem: 'relevancia', lojas: ['amazon'] } }]), Date.now()).lastInsertRowid);
  await scheduler.runRule(id);
  for (const x of wa.simulated) assert.match(x.text, /amazon\.com\.br\/dp\/B000000001\?tag=[\w-]+/, 'link sem tag saiu');
  assert.ok(!wa.simulated.some((x) => x.jid === G1 || x.jid === G3), 'grupo sem associação e sem tag padrão não pode receber link');
  assert.ok(linhas(db, 'SELECT jid FROM rastreio_envios').every((r) => r.jid === G2));
  db.close();
});

test('regra, CA9: etiqueta apagada de tags entre duas execuções — a 2ª usa a da regra, e a linha antiga continua intacta', async () => {
  const { dir, db } = montarDb();
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  assoc(db, 'mercadolivre', 'grupo', G1, 'etiquetaB');
  await scheduler.runRule(addRegra(db, ITEM1, [G1]));
  db.prepare("DELETE FROM tags WHERE name = 'etiquetaB'").run();
  await scheduler.runRule(addRegra(db, 'https://produto.mercadolivre.com.br/MLB-1000002-b | Mouse B | 30 | 40', [G1]));
  assert.deepEqual(linhas(db, 'SELECT oferta_chave, codigo, nivel, esperado, motivo FROM rastreio_envios ORDER BY id'), [
    { oferta_chave: 'MLB1000001', codigo: 'etiquetaB', nivel: 'grupo', esperado: 1, motivo: null },
    { oferta_chave: 'MLB1000002', codigo: 'etiquetaA', nivel: 'padrao', esperado: 1, motivo: 'etiqueta_apagada' },
  ]);
  const c = rastreio.cobertura(db, { de: 0, ate: Date.now() + DIA });
  assert.deepEqual([c.total.esperados, c.total.rastreados, c.total.cobertura], [2, 1, 0.5]);
  db.close();
});

// ---------------------------------------------------------------------- rodada 2 (Q2 sem regressão)

test('Amazon (Q2, rodada 2): trocar só a caixa do código do próprio alvo é permitido e grava a nova grafia; a tag padrão em outra caixa continua recusada', () => {
  const { db } = montarDb();
  const b1 = bloco(db, [G1]); const b2 = bloco(db, [G2]);
  assoc(db, 'amazon', 'bloco', b1, 'Turbo-20');
  assert.equal(assoc(db, 'amazon', 'bloco', b1, 'turbo-20').codigo, 'turbo-20', 'o mesmo alvo pode corrigir a caixa');
  assert.deepEqual(linhas(db, 'SELECT alvo, codigo FROM rastreio_codigos'), [{ alvo: String(b1), codigo: 'turbo-20' }]);
  db.prepare("INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', ?, '{}', 1)").run(JSON.stringify({ tag: 'Padrao-20' }));
  assert.throws(() => assoc(db, 'amazon', 'bloco', b2, 'padrao-20'), recusa(400, /padrão|conta|Conexões/i));
  assert.equal(contar(db, 'rastreio_codigos'), 1);
  db.close();
});
