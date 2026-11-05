// Ganhos (docs/produto/planos/dashboard-ganhos.md, Entrega B).
// Etapa 11: esquema B (importacoes, comissoes, cliques_loja, gastos_anuncio), só CREATE … IF NOT EXISTS em src/db.js.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';

// pastas temporárias apagadas no fim do arquivo
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-ganhos-')); pastas.push(p); return p; };
/** Linhas como objetos comuns (o node:sqlite devolve objetos sem protótipo). */
const linhas = (db, sql, ...params) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
const colunas = (db, tabela) => db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
const existe = (db, tipo, nome) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(tipo, nome);
const esquema = (db) => linhas(db, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');

// ------------------------------------------------------------------------------------------- etapa 11

const TABELAS_GANHOS = {
  importacoes: ['id', 'loja', 'tipo', 'arquivo_sha256', 'codigo_arquivo', 'lidas', 'novas', 'atualizadas', 'ignoradas',
    'criado_em', 'user_id'],
  comissoes: ['id', 'loja', 'chave', 'data', 'codigo', 'produto', 'titulo', 'quantidade', 'venda_centavos',
    'comissao_centavos', 'status', 'importacao_id', 'atualizado_em'],
  cliques_loja: ['loja', 'dia', 'codigo', 'cliques', 'importacao_id', 'atualizado_em'],
  gastos_anuncio: ['id', 'alvo_tipo', 'alvo', 'inicio', 'fim', 'valor_centavos', 'nota', 'criado_em', 'user_id'],
};
// nome -> [tabela, colunas, único, parcial]; coluna null = expressão (lower(codigo))
const INDICES_GANHOS = {
  idx_com_chave: ['comissoes', ['loja', 'chave'], 1, 0],
  idx_com_cod: ['comissoes', ['loja', 'codigo', 'data'], 0, 0],
  // R2: a atribuição só lê as linhas grupo/bloco (WHERE nivel IN ('grupo','bloco'))
  idx_renv_atrib: ['rastreio_envios', ['loja', 'codigo', 'ts'], 0, 1],
  idx_renv_atrib_ci: ['rastreio_envios', ['loja', null, 'ts'], 0, 1],
};

function conferirEsquema(db, quando) {
  for (const [tabela, cols] of Object.entries(TABELAS_GANHOS)) {
    assert.ok(existe(db, 'table', tabela), `tabela ${tabela} (${quando})`);
    assert.deepEqual(colunas(db, tabela), cols, `colunas de ${tabela} (${quando})`);
  }
  for (const [indice, [tabela, cols, unico, parcial]] of Object.entries(INDICES_GANHOS)) {
    assert.equal(db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indice)?.tbl_name, tabela, `índice ${indice} (${quando})`);
    assert.deepEqual(db.prepare(`PRAGMA index_info(${indice})`).all().map((c) => c.name), cols, `colunas de ${indice} (${quando})`);
    const info = db.prepare(`PRAGMA index_list(${tabela})`).all().find((i) => i.name === indice);
    assert.equal(info?.unique, unico, `${indice} único? (${quando})`);
    assert.equal(info?.partial, parcial, `${indice} parcial? (${quando})`);
  }
  // chave primária composta de cliques_loja: um total por loja, dia e código
  const pk = db.prepare('PRAGMA table_info(cliques_loja)').all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  assert.deepEqual(pk, ['loja', 'dia', 'codigo'], `chave primária de cliques_loja (${quando})`);
}

test('esquema B: openDb cria importacoes, comissoes, cliques_loja, gastos_anuncio e os índices; abrir 2× não muda nada', () => {
  const dir = tmp();
  const db1 = openDb(dir);
  conferirEsquema(db1, 'primeira abertura');
  const antes = esquema(db1);
  db1.close();
  const db2 = openDb(dir);
  conferirEsquema(db2, 'segunda abertura');
  assert.deepEqual(esquema(db2), antes, 'a segunda abertura não cria nem altera nada');
  for (const tabela of Object.keys(TABELAS_GANHOS)) assert.equal(db2.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0, `${tabela} nasce vazia`);
  db2.close();
});

test('esquema B: banco da versão anterior (sem as tabelas dos ganhos) migra com os dados intactos', () => {
  const dir = tmp();
  // Banco como o do serviço antes desta etapa: esquema atual sem as tabelas da Entrega B, com dados.
  const velho = openDb(dir);
  velho.exec('DROP TABLE importacoes; DROP TABLE comissoes; DROP TABLE cliques_loja; DROP TABLE gastos_anuncio; DROP INDEX idx_renv_atrib; DROP INDEX idx_renv_atrib_ci;');
  velho.exec(`INSERT INTO tags (name, created_at) VALUES ('geral', 1);
    INSERT INTO blocks (id, name, tag_id, created_at) VALUES (4, 'Casa', 1, 1);
    INSERT INTO block_groups (block_id, jid) VALUES (4, 'g1@g.us');
    INSERT INTO groups (jid, name, size, updated_at) VALUES ('g1@g.us', 'Grupo 1', 10, 1);
    INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo, criado_em) VALUES ('amazon', 'bloco', '4', 'casa-20', 1);`);
  const tabelas = linhas(velho, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name);
  for (const t of Object.keys(TABELAS_GANHOS)) assert.ok(!tabelas.includes(t), `o banco simulado é mesmo o antigo (sem ${t})`);
  const dados = {};
  for (const t of tabelas) dados[t] = linhas(velho, `SELECT * FROM ${t} ORDER BY rowid`);
  velho.close();

  for (let abertura = 1; abertura <= 2; abertura++) {
    const db = openDb(dir);
    conferirEsquema(db, `abertura ${abertura}`);
    for (const t of tabelas) assert.deepEqual(linhas(db, `SELECT * FROM ${t} ORDER BY rowid`), dados[t], `${t} intacta (abertura ${abertura})`);
    db.close();
  }
});

test('esquema B: gasto de anúncio com valor_centavos <= 0 é recusado pelo CHECK', () => {
  const db = openDb(tmp());
  const gasto = db.prepare('INSERT INTO gastos_anuncio (alvo_tipo, alvo, inicio, fim, valor_centavos, criado_em) VALUES (?, ?, ?, ?, ?, 1)');
  assert.throws(() => gasto.run('bloco', '1', '2026-10-01', '2026-10-31', 0), /CHECK constraint failed/, 'valor zero');
  assert.throws(() => gasto.run('bloco', '1', '2026-10-01', '2026-10-31', -1), /CHECK constraint failed/, 'valor negativo');
  assert.throws(() => gasto.run('bloco', '1', '2026-10-01', '2026-10-31', null), /NOT NULL constraint failed: gastos_anuncio\.valor_centavos/, 'sem valor');
  assert.throws(() => gasto.run('loja', '1', '2026-10-01', '2026-10-31', 100), /CHECK constraint failed/, 'alvo fora de grupo/bloco');
  assert.throws(() => gasto.run('grupo', null, '2026-10-01', '2026-10-31', 100), /NOT NULL constraint failed: gastos_anuncio\.alvo/);
  gasto.run('bloco', '1', '2026-10-01', '2026-10-31', 1); // 1 centavo é o mínimo
  gasto.run('grupo', 'g3@g.us', '2026-10-12', '2026-10-31', 1200);
  assert.deepEqual(linhas(db, 'SELECT alvo_tipo, alvo, valor_centavos, nota FROM gastos_anuncio ORDER BY id'), [
    { alvo_tipo: 'bloco', alvo: '1', valor_centavos: 1, nota: null },
    { alvo_tipo: 'grupo', alvo: 'g3@g.us', valor_centavos: 1200, nota: null },
  ]);
  db.close();
});

test('esquema B: CHECK recusa tipo de importação e status de comissão fora da lista; padrões de quantidade e venda', () => {
  const db = openDb(tmp());
  const imp = db.prepare('INSERT INTO importacoes (loja, tipo, arquivo_sha256, criado_em) VALUES (?, ?, ?, 1)');
  assert.throws(() => imp.run('amazon', 'pedidos', 'a'.repeat(64)), /CHECK constraint failed/);
  assert.throws(() => imp.run('amazon', 'comissoes', null), /NOT NULL constraint failed: importacoes\.arquivo_sha256/);
  const { lastInsertRowid: impId } = imp.run('amazon', 'comissoes', 'a'.repeat(64));
  imp.run('amazon', 'cliques', 'b'.repeat(64));

  const com = db.prepare(`INSERT INTO comissoes (loja, chave, data, codigo, comissao_centavos, status, importacao_id, atualizado_em)
    VALUES (?, ?, '2026-10-05', 'casa-20', ?, ?, ?, 1)`);
  assert.throws(() => com.run('amazon', 'k1', 300, 'paga', impId), /CHECK constraint failed/);
  assert.throws(() => com.run('amazon', 'k1', null, 'confirmada', impId), /NOT NULL constraint failed: comissoes\.comissao_centavos/);
  for (const status of ['confirmada', 'pendente', 'cancelada']) com.run('amazon', `k-${status}`, 300, status, impId);
  assert.deepEqual({ ...db.prepare("SELECT quantidade, venda_centavos FROM comissoes WHERE chave = 'k-confirmada'").get() },
    { quantidade: 1, venda_centavos: 0 }, 'quantidade nasce 1 e venda 0');
  db.close();
});

test('esquema B: uma comissão por loja e chave; um total de cliques por loja, dia e código', () => {
  const db = openDb(tmp());
  const com = db.prepare(`INSERT INTO comissoes (loja, chave, data, comissao_centavos, status, importacao_id, atualizado_em)
    VALUES (?, ?, '2026-10-05', 300, 'pendente', 1, 1)`);
  com.run('amazon', 'abc');
  assert.throws(() => com.run('amazon', 'abc'), /UNIQUE constraint failed: comissoes\.loja, comissoes\.chave/, 'mesma chave na mesma loja');
  com.run('shopee', 'abc'); // outra loja, mesma chave

  const clq = db.prepare('INSERT INTO cliques_loja (loja, dia, codigo, cliques, importacao_id) VALUES (?, ?, ?, ?, 1)');
  clq.run('amazon', '2026-10-05', 'casa-20', 40);
  assert.throws(() => clq.run('amazon', '2026-10-05', 'casa-20', 50), /UNIQUE constraint failed: cliques_loja\.loja, cliques_loja\.dia, cliques_loja\.codigo/);
  clq.run('amazon', '2026-10-06', 'casa-20', 10); // outro dia
  db.prepare("INSERT INTO cliques_loja (loja, dia, cliques, importacao_id) VALUES ('amazon', '2026-10-05', 7, 1)").run();
  assert.equal(db.prepare("SELECT codigo FROM cliques_loja WHERE cliques = 7").get().codigo, '', 'sem código vira texto vazio (cabe na chave)');
  assert.throws(() => db.prepare("INSERT INTO cliques_loja (loja, dia, cliques, importacao_id) VALUES ('amazon', '2026-10-05', 8, 1)").run(),
    /UNIQUE constraint failed/, 'sem código também é um total só por dia');
  db.close();
});

// ------------------------------------------------------------------------------------------- etapa 13
// Catálogo de métricas (MDD) do plano: cada métrica tem um teste com os valores conhecidos do cenário C1 (e C2).
const ganhos = await import('../src/ganhos.js');
const rastreio = await import('../src/rastreio.js');
const { periodRange } = await import('../src/analytics.js');

const G1 = '1201@g.us', G2 = '1202@g.us', G3 = '1203@g.us';
const TAG_PADRAO = 'desejodemen01-20';
/** Meio-dia (ou a hora `h`) de um dia de outubro de 2026, no fuso local. */
const OUT = (dia, h = 12, min = 0) => new Date(2026, 9, dia, h, min).getTime();
/** Período em dias de negócio, como a rota calcula (periodRange custom). */
const periodo = (de, ate, viradaMin = 0) => ({ ...periodRange('custom', Date.now(), { de, ate }, viradaMin), viradaMin });
const OUTUBRO = periodo('2026-10-01', '2026-10-31');
/** Objeto comum (linhas do node:sqlite vêm sem protótipo). */
const simples = (x) => JSON.parse(JSON.stringify(x));
const quase = (a, b, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${msg}: ${a} ≈ ${b}`);

/** Banco com G1 e G2 no bloco B1 (id 1), G3 fora de bloco, a etiqueta geral e uma importação. */
function base() {
  const db = openDb(tmp());
  db.exec(`INSERT INTO groups (jid, name, size, updated_at) VALUES ('${G1}', 'Grupo 1', 10, 1), ('${G2}', 'Grupo 2', 10, 1), ('${G3}', 'Grupo 3', 10, 1);
    INSERT INTO blocks (id, name, created_at) VALUES (1, 'B1', 1);
    INSERT INTO block_groups (block_id, jid) VALUES (1, '${G1}'), (1, '${G2}');
    INSERT INTO tags (name, created_at) VALUES ('geral', 1);
    INSERT INTO importacoes (id, loja, tipo, arquivo_sha256, criado_em) VALUES (1, 'shopee', 'comissoes', '${'a'.repeat(64)}', 1);`);
  return db;
}
const envio = (db, ts, jid, loja, codigo, nivel, esperado, extra = {}) => rastreio.registrar(db, {
  ts, jid, loja, origem: 'regra', link: `https://exemplo.invalid/${loja}/${codigo ?? 'base'}`, codigo, nivel, esperado, ...extra,
});
let nChave = 0;
function comissao(db, { loja, codigo = null, data, venda = 0, valor, qtd = 1, status, produto = null, titulo = null }) {
  db.prepare(`INSERT INTO comissoes (loja, chave, data, codigo, produto, titulo, quantidade, venda_centavos, comissao_centavos, status, importacao_id, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`).run(loja, `k${++nChave}`, data, codigo, produto, titulo, qtd, venda, valor, status);
}
const cliques = (db, loja, dia, codigo, n) => db.prepare('INSERT INTO cliques_loja (loja, dia, codigo, cliques, importacao_id) VALUES (?, ?, ?, ?, 1)').run(loja, dia, codigo, n);
const gasto = (db, alvo_tipo, alvo, inicio, fim, valor) => db.prepare(`INSERT INTO gastos_anuncio (alvo_tipo, alvo, inicio, fim, valor_centavos, criado_em)
  VALUES (?, ?, ?, ?, ?, 1)`).run(alvo_tipo, alvo, inicio, fim, valor);
function eventos(db, jid, n, ts, action = 'add') {
  for (let i = 0; i < n; i++) db.prepare('INSERT INTO group_events (ts, jid, participant, action) VALUES (?, ?, ?, ?)').run(ts + i, jid, `p-${jid}-${ts}-${i}`, action);
}

/** Cenário C1 do plano, inteiro (rastreio_envios, comissoes, cliques_loja, gastos_anuncio e entradas). */
function cenarioC1() {
  const db = base();
  // rastreio_envios (01–04/10): 16 no período
  for (let i = 0; i < 4; i++) envio(db, OUT(1 + i), G1, 'shopee', 'g1', 'grupo', 1, { oferta_chave: 'SHOPEE:1.2' });
  for (let i = 0; i < 3; i++) envio(db, OUT(1 + i), G2, 'shopee', 'g2', 'grupo', 1, { oferta_chave: 'SHOPEE:1.2' });
  envio(db, OUT(4), G2, 'shopee', null, 'nenhum', 1, { motivo: 'limite_shopee', oferta_chave: 'SHOPEE:3.4' });
  for (const jid of [G1, G2]) for (let i = 0; i < 2; i++) envio(db, OUT(2 + i), jid, 'amazon', 'turbob1-20', 'bloco', 1, { bloco_id: 1, oferta_chave: 'ASIN:B0TESTE001' });
  for (let i = 0; i < 2; i++) envio(db, OUT(3 + i), G3, 'amazon', TAG_PADRAO, 'padrao', 0, { oferta_chave: 'ASIN:B0TESTE002' });
  for (let i = 0; i < 2; i++) envio(db, OUT(3 + i), G3, 'mercadolivre', 'geral', 'padrao', 0, { oferta_chave: 'MLB1' });
  // comissoes (centavos)
  comissao(db, { loja: 'shopee', codigo: 'g1', data: '2026-10-05', venda: 5000, valor: 300, status: 'confirmada', produto: 'SHOPEE:1.2', titulo: 'Panela' });
  comissao(db, { loja: 'shopee', codigo: 'g1', data: '2026-10-06', venda: 4000, valor: 200, status: 'pendente', produto: 'SHOPEE:1.2', titulo: 'Panela' });
  comissao(db, { loja: 'shopee', codigo: 'g2', data: '2026-10-07', venda: 2000, valor: 100, status: 'confirmada', produto: 'SHOPEE:3.4' });
  comissao(db, { loja: 'shopee', codigo: 'g2', data: '2026-10-08', venda: 9000, valor: 999, status: 'cancelada', produto: 'SHOPEE:3.4' });
  comissao(db, { loja: 'amazon', codigo: 'turbob1-20', data: '2026-10-09', venda: 10000, valor: 400, qtd: 2, status: 'confirmada', produto: 'B0TESTE001' });
  comissao(db, { loja: 'amazon', codigo: TAG_PADRAO, data: '2026-10-10', venda: 8000, valor: 500, status: 'confirmada', produto: 'B0TESTE002' });
  comissao(db, { loja: 'mercadolivre', data: '2026-10-11', venda: 12000, valor: 600, status: 'pendente', produto: 'MLB1' });
  comissao(db, { loja: 'shopee', codigo: 'g1', data: '2026-09-30', venda: 7000, valor: 700, status: 'confirmada', produto: 'SHOPEE:1.2' }); // fora
  // cliques_loja (outubro): Shopee g1 100, g2 50; Amazon turbob1-20 40, tag padrão 60; mais dois dias fora
  cliques(db, 'shopee', '2026-10-05', 'g1', 60);
  cliques(db, 'shopee', '2026-10-20', 'g1', 40);
  cliques(db, 'shopee', '2026-10-07', 'g2', 50);
  cliques(db, 'amazon', '2026-10-09', 'turbob1-20', 40);
  cliques(db, 'amazon', '2026-10-10', TAG_PADRAO, 60);
  cliques(db, 'shopee', '2026-09-30', 'g1', 30);
  cliques(db, 'shopee', '2026-11-01', 'g1', 5);
  // gastos_anuncio: B1 01–31/10 3100; G3 20/10–08/11 2000
  gasto(db, 'bloco', '1', '2026-10-01', '2026-10-31', 3100);
  gasto(db, 'grupo', G3, '2026-10-20', '2026-11-08', 2000);
  // entradas: G1 10, G2 15, G3 6 em outubro; fora do período e saídas não contam
  eventos(db, G1, 10, OUT(15)); eventos(db, G2, 15, OUT(16)); eventos(db, G3, 6, OUT(17));
  eventos(db, G1, 3, new Date(2026, 8, 30, 12).getTime());
  eventos(db, G1, 2, OUT(18), 'remove');
  return db;
}
/** Métricas do C1 em outubro (virada 0), recortadas por `por` e filtros. */
const c1 = (db, extra = {}) => simples(ganhos.metricas(db, { ...OUTUBRO, ...extra }));
const linhaDe = (r, campo, valor) => {
  const l = r.linhas.find((x) => x[campo] === valor);
  assert.ok(l, `linha ${campo}=${valor} em por=${r.por}`);
  return l;
};

test('M1 comissão (C1): total 2100, confirmada 1300; G1 500, G2 100, G3 0; B1 1000; por loja; não atribuída 1100; oferta e dia', () => {
  const db = cenarioC1();
  const grupo = c1(db, { por: 'grupo' });
  assert.equal(grupo.total.comissao, 2100, 'M1 total (só válidas, só outubro)');
  assert.equal(grupo.total.comissao_confirmada, 1300, 'M1c');
  assert.deepEqual([G1, G2, G3].map((j) => linhaDe(grupo, 'jid', j).comissao), [500, 100, 0], 'M1 por grupo');
  assert.equal(grupo.nao_atribuida.comissao, 1100, 'não atribuída (tag padrão da Amazon e ML sem código)');
  assert.equal(linhaDe(c1(db, { por: 'bloco' }), 'bloco_id', 1).comissao, 1000, 'B1 = a do bloco + a dos grupos dele');
  const loja = c1(db, { por: 'loja' });
  assert.deepEqual(loja.linhas.map((l) => [l.loja, l.comissao]), [['mercadolivre', 600], ['amazon', 900], ['shopee', 600]]);
  assert.equal(linhaDe(c1(db, { por: 'oferta' }), 'oferta', 'SHOPEE:1.2').comissao, 500, 'oferta SHOPEE:1.2');
  const dia = c1(db, { por: 'dia' });
  assert.equal(linhaDe(dia, 'dia', '2026-10-05').comissao, 300, 'dia 05/10');
  assert.equal(dia.linhas.length, 31, 'um dia por linha, outubro inteiro');
  db.close();
});

test('M2 receita (C1): total 41000 (cancelada e setembro fora)', () => {
  const db = cenarioC1();
  assert.equal(c1(db).total.receita, 41000);
  db.close();
});

test('M3 vendas (C1): total 7; G1 2; B1 5', () => {
  const db = cenarioC1();
  assert.equal(c1(db).total.vendas, 7);
  assert.equal(linhaDe(c1(db, { por: 'grupo' }), 'jid', G1).vendas, 2);
  assert.equal(linhaDe(c1(db, { por: 'bloco' }), 'bloco_id', 1).vendas, 5);
  db.close();
});

test('M4 cliques (C1, relatório da loja): G1 100; G2 50; B1 190; total 250', () => {
  const db = cenarioC1();
  const grupo = c1(db, { por: 'grupo' });
  assert.equal(grupo.total.cliques, 250, 'setembro e novembro fora');
  assert.equal(linhaDe(grupo, 'jid', G1).cliques, 100);
  assert.equal(linhaDe(grupo, 'jid', G2).cliques, 50);
  assert.equal(linhaDe(c1(db, { por: 'bloco' }), 'bloco_id', 1).cliques, 190);
  assert.equal(grupo.nao_atribuida.cliques, 60, 'cliques da tag padrão ficam sem grupo');
  db.close();
});

test('M5 ganho por clique (C1, centavos/clique): G1 5; G2 2; B1 ≈5,263; Shopee 4; Amazon 9; ML null; total 6', () => {
  const db = cenarioC1();
  const grupo = c1(db, { por: 'grupo' });
  assert.equal(linhaDe(grupo, 'jid', G1).epc, 5);
  assert.equal(linhaDe(grupo, 'jid', G2).epc, 2);
  assert.equal(linhaDe(grupo, 'jid', G3).epc, null, 'sem clique → null');
  quase(linhaDe(c1(db, { por: 'bloco' }), 'bloco_id', 1).epc, 1000 / 190, 'B1');
  const loja = c1(db, { por: 'loja' });
  assert.deepEqual(loja.linhas.map((l) => [l.loja, l.epc]), [['mercadolivre', null], ['amazon', 9], ['shopee', 4]]);
  assert.equal(grupo.total.epc, 6, 'total: só a comissão das lojas com clique (1500 ÷ 250)');
  db.close();
});

test('M6 conversão (C1): G1 2%; B1 ≈2,63%; Amazon 3%', () => {
  const db = cenarioC1();
  assert.equal(linhaDe(c1(db, { por: 'grupo' }), 'jid', G1).conversao, 0.02);
  quase(linhaDe(c1(db, { por: 'bloco' }), 'bloco_id', 1).conversao, 5 / 190, 'B1');
  assert.equal(linhaDe(c1(db, { por: 'loja' }), 'loja', 'amazon').conversao, 0.03);
  assert.equal(linhaDe(c1(db, { por: 'loja' }), 'loja', 'mercadolivre').conversao, null, 'loja sem clique → null');
  db.close();
});

test('M7 envios (C1): G1 6; G2 6; G3 4; B1 12; total 16; oferta com grupos que enviaram', () => {
  const db = cenarioC1();
  const grupo = c1(db, { por: 'grupo' });
  assert.deepEqual([G1, G2, G3].map((j) => linhaDe(grupo, 'jid', j).envios), [6, 6, 4]);
  assert.equal(grupo.total.envios, 16);
  assert.equal(linhaDe(c1(db, { por: 'bloco' }), 'bloco_id', 1).envios, 12);
  const oferta = linhaDe(c1(db, { por: 'oferta' }), 'oferta', 'SHOPEE:1.2');
  assert.deepEqual([oferta.envios, oferta.grupos, oferta.loja, oferta.titulo], [7, 2, 'shopee', 'Panela']);
  const dia = c1(db, { por: 'dia' });
  assert.deepEqual(['2026-10-01', '2026-10-02', '2026-10-05'].map((d) => linhaDe(dia, 'dia', d).envios), [2, 4, 0]);
  db.close();
});

test('M9 cobertura do rastreio (C1, de rastreio.cobertura): total 11/12; Shopee 87,5%; Amazon 100%; ML null', () => {
  const db = cenarioC1();
  const r = c1(db, { por: 'loja' });
  quase(r.total.cobertura, 11 / 12, 'M9 total');
  assert.deepEqual([r.total.esperados, r.total.rastreados], [12, 11]);
  assert.deepEqual(r.linhas.map((l) => [l.loja, l.cobertura]), [['mercadolivre', null], ['amazon', 1], ['shopee', 0.875]]);
  assert.deepEqual(r.cobertura.por_loja.map((l) => [l.loja, l.cobertura]), [['mercadolivre', null], ['amazon', 1], ['shopee', 0.875]], 'faixa de cobertura do painel');
  db.close();
});

test('M10 alcance das associações (C1): 12/16 = 75%', () => {
  const db = cenarioC1();
  assert.equal(c1(db).total.alcance, 0.75);
  assert.equal(c1(db).cobertura.total.alcance, 0.75);
  db.close();
});

test('M11 comissão atribuída (C1): total ≈47,62%; Shopee 100%; Amazon ≈44,44%; ML 0%', () => {
  const db = cenarioC1();
  const r = c1(db, { por: 'loja' });
  quase(r.total.atribuida, 1000 / 2100, 'M11 total');
  assert.equal(r.total.comissao_atribuida, 1000);
  const porLoja = Object.fromEntries(r.linhas.map((l) => [l.loja, l.atribuida]));
  assert.equal(porLoja.shopee, 1);
  quase(porLoja.amazon, 400 / 900, 'Amazon');
  assert.equal(porLoja.mercadolivre, 0);
  db.close();
});

test('M12 gasto com anúncio (C1): B1 3100 em outubro; G3 1200 (12 de 20 dias); G1 null (o do bloco não se divide)', () => {
  const db = cenarioC1();
  assert.equal(linhaDe(c1(db, { por: 'bloco' }), 'bloco_id', 1).gasto, 3100);
  const grupo = c1(db, { por: 'grupo' });
  assert.equal(linhaDe(grupo, 'jid', G3).gasto, 1200);
  assert.equal(linhaDe(grupo, 'jid', G1).gasto, null);
  assert.equal(grupo.total.gasto, 4300, 'total: cada gasto uma vez');
  db.close();
});

test('M12: gasto de grupo não entra no bloco (só no próprio alvo, nem no recorte do bloco)', () => {
  const db = cenarioC1();
  gasto(db, 'grupo', G1, '2026-10-01', '2026-10-31', 500); // G1 está em B1
  const bloco = c1(db, { por: 'bloco' });
  assert.equal(linhaDe(bloco, 'bloco_id', 1).gasto, 3100, 'B1 conta só o gasto lançado para B1');
  assert.equal(linhaDe(bloco, 'bloco_id', 1).retorno, 1000 - 3100);
  assert.equal(linhaDe(c1(db, { por: 'grupo' }), 'jid', G1).gasto, 500, 'o gasto continua no grupo');
  const recorte = c1(db, { bloco: 1, por: 'grupo' });
  assert.equal(recorte.total.gasto, 3100, 'o total do recorte do bloco também é só o do bloco');
  assert.equal(linhaDe(recorte, 'jid', G1).gasto, 500);
  // bloco sem gasto próprio: null, mesmo com gasto num grupo dele
  db.exec("DELETE FROM gastos_anuncio WHERE alvo_tipo = 'bloco'");
  assert.equal(linhaDe(c1(db, { por: 'bloco' }), 'bloco_id', 1).gasto, null);
  assert.equal(c1(db, { bloco: 1, por: 'grupo' }).total.gasto, null);
  db.close();
});

test('M12 gasto com anúncio, período personalizado 16–31/10: B1 1600; G3 1200', () => {
  const db = cenarioC1();
  const p = periodo('2026-10-16', '2026-10-31');
  assert.equal(linhaDe(simples(ganhos.metricas(db, { ...p, por: 'bloco' })), 'bloco_id', 1).gasto, 1600, '16 de 31 dias');
  assert.equal(linhaDe(simples(ganhos.metricas(db, { ...p, por: 'grupo' })), 'jid', G3).gasto, 1200, '12 de 20 dias');
  db.close();
});

test('M13 entradas (C1): G1 10; G2 15; G3 6; B1 25; total 31 (saídas e setembro fora)', () => {
  const db = cenarioC1();
  const grupo = c1(db, { por: 'grupo' });
  assert.deepEqual([G1, G2, G3].map((j) => linhaDe(grupo, 'jid', j).entradas), [10, 15, 6]);
  assert.equal(linhaDe(c1(db, { por: 'bloco' }), 'bloco_id', 1).entradas, 25);
  assert.equal(grupo.total.entradas, 31);
  db.close();
});

test('M14 custo por membro (C1): B1 124; G3 200; G1 null', () => {
  const db = cenarioC1();
  assert.equal(linhaDe(c1(db, { por: 'bloco' }), 'bloco_id', 1).custo_membro, 124);
  const grupo = c1(db, { por: 'grupo' });
  assert.equal(linhaDe(grupo, 'jid', G3).custo_membro, 200);
  assert.equal(linhaDe(grupo, 'jid', G1).custo_membro, null);
  db.close();
});

test('M15 retorno (C1): B1 −2100; G3 −1200; G1 null (sem gasto)', () => {
  const db = cenarioC1();
  assert.equal(linhaDe(c1(db, { por: 'bloco' }), 'bloco_id', 1).retorno, -2100);
  const grupo = c1(db, { por: 'grupo' });
  assert.equal(linhaDe(grupo, 'jid', G3).retorno, -1200);
  assert.equal(linhaDe(grupo, 'jid', G1).retorno, null);
  assert.equal(grupo.total.retorno, 2100 - 4300);
  db.close();
});

test('C2 (atribuição histórica, D6): g1 de G1 passa a G3 em 20/10 com envio a G3 em 21/10', () => {
  const db = base();
  envio(db, OUT(1), G1, 'shopee', 'g1', 'grupo', 1);
  envio(db, OUT(21), G3, 'shopee', 'g1', 'grupo', 1);
  envio(db, OUT(22), G2, 'shopee', 'g1', 'padrao', 0); // sem associação: não muda a atribuição
  const venda = (data) => comissao(db, { loja: 'shopee', codigo: 'g1', data, valor: 100, status: 'confirmada' });
  venda('2026-10-05'); venda('2026-10-20'); venda('2026-10-21'); venda('2026-10-25');
  assert.deepEqual(simples(ganhos.atribuir(db, { loja: 'shopee', codigo: 'g1', data: '2026-10-05' })), { alvo_tipo: 'grupo', jid: G1, bloco_id: null }, 'venda 05/10 → G1');
  assert.deepEqual(simples(ganhos.atribuir(db, { loja: 'shopee', codigo: 'g1', data: '2026-10-25' })), { alvo_tipo: 'grupo', jid: G3, bloco_id: null }, 'venda 25/10 → G3');
  const grupo = c1(db, { por: 'grupo' });
  assert.equal(linhaDe(grupo, 'jid', G1).comissao, 200, '05/10 e 20/10 (associação trocada, mas sem envio ainda)');
  assert.equal(linhaDe(grupo, 'jid', G3).comissao, 200, '21/10 (envio ao meio-dia, até o fim do dia) e 25/10');
  db.close();
});

test('atribuição (D6): antes do primeiro envio, código sem associação e bloco → não atribuída ou bloco; Amazon sem maiúsculas', () => {
  const db = base();
  envio(db, OUT(10), G1, 'shopee', 'g1', 'grupo', 1);
  envio(db, OUT(10), G3, 'amazon', TAG_PADRAO, 'padrao', 0);
  envio(db, OUT(10), G2, 'amazon', 'Turbob1-20', 'bloco', 1, { bloco_id: 1 });
  assert.equal(ganhos.atribuir(db, { loja: 'shopee', codigo: 'g1', data: '2026-10-09' }), null, 'venda antes do envio');
  assert.equal(ganhos.atribuir(db, { loja: 'amazon', codigo: TAG_PADRAO, data: '2026-10-11' }), null, 'código padrão não identifica grupo');
  assert.equal(ganhos.atribuir(db, { loja: 'shopee', codigo: null, data: '2026-10-11' }), null, 'sem código');
  assert.equal(ganhos.atribuir(db, { loja: 'mercadolivre', codigo: 'g1', data: '2026-10-11' }), null, 'mesmo código em outra loja');
  assert.deepEqual(simples(ganhos.atribuir(db, { loja: 'amazon', codigo: 'turbob1-20', data: '2026-10-11' })), { alvo_tipo: 'bloco', jid: null, bloco_id: 1 },
    'a Amazon não distingue maiúsculas no ID de rastreamento');
  assert.equal(ganhos.atribuir(db, { loja: 'shopee', codigo: 'G1', data: '2026-10-11' }), null, 'Sub_id da Shopee distingue maiúsculas');
  db.close();
});

test('R2: a consulta da atribuição usa os índices parciais (só grupo/bloco), não percorre as linhas com o código padrão', () => {
  const db = base();
  const sqls = [];
  const espiao = { prepare: (sql) => { sqls.push(sql); return db.prepare(sql); } };
  ganhos.atribuir(espiao, { loja: 'shopee', codigo: 'g1', data: '2026-10-11' });
  const daAtribuicao = sqls.filter((s) => /FROM rastreio_envios/.test(s));
  assert.equal(daAtribuicao.length, 2, 'uma consulta exata e uma sem caixa (Amazon)');
  const plano = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('amazon', 'x-20', 1).map((r) => r.detail).join(' | ');
  const [exato, semCaixa] = daAtribuicao.map(plano);
  assert.match(exato, /USING INDEX idx_renv_atrib \(loja=\? AND codigo=\? AND ts<\?\)/, exato);
  assert.match(semCaixa, /USING INDEX idx_renv_atrib_ci \(loja=\? AND <expr>=\? AND ts<\?\)/, semCaixa);
  for (const p of [exato, semCaixa]) assert.doesNotMatch(p, /TEMP B-TREE/, 'sem ordenar à parte');
  db.close();
});

test('atribuição (D6) e período seguem a virada do dia: envio às 01:00 de 22/10 com virada 02:00 é do dia 21/10', () => {
  const db = base();
  envio(db, OUT(22, 1), G1, 'shopee', 'g1', 'grupo', 1);
  comissao(db, { loja: 'shopee', codigo: 'g1', data: '2026-10-21', valor: 100, status: 'confirmada' });
  assert.equal(ganhos.atribuir(db, { loja: 'shopee', codigo: 'g1', data: '2026-10-21' }, 0), null, 'virada 0: o envio é de 22/10');
  assert.deepEqual(simples(ganhos.atribuir(db, { loja: 'shopee', codigo: 'g1', data: '2026-10-21' }, 120)), { alvo_tipo: 'grupo', jid: G1, bloco_id: null });
  const r = simples(ganhos.metricas(db, { ...periodo('2026-10-21', '2026-10-21', 120), por: 'grupo' }));
  assert.equal(linhaDe(r, 'jid', G1).comissao, 100);
  assert.equal(linhaDe(r, 'jid', G1).envios, 1, 'o envio das 01:00 de 22/10 é do dia de negócio 21/10');
  db.close();
});

test('divisão por zero → null: banco sem dados devolve zeros e null, sem gasto nem cobertura', () => {
  const db = base();
  for (const por of ganhos.POR) {
    const r = simples(ganhos.metricas(db, { ...OUTUBRO, por }));
    assert.deepEqual(r.total, {
      comissao: 0, comissao_confirmada: 0, receita: 0, vendas: 0, cliques: 0, epc: null, conversao: null,
      envios: 0, esperados: 0, rastreados: 0, cobertura: null, alcance: null, comissao_atribuida: 0, atribuida: null,
      gasto: null, entradas: 0, custo_membro: null, retorno: null,
    }, `total (por=${por})`);
    assert.deepEqual(r.nao_atribuida, { linhas: 0, comissao: 0, receita: 0, vendas: 0, cliques: 0 });
    assert.deepEqual(r.importado_ate, {}, 'nunca importou');
    assert.equal(r.gastos_informados, 0);
  }
  assert.deepEqual(c1(db, { por: 'grupo' }).linhas, [], 'grupo sem movimento não aparece');
  assert.deepEqual(c1(db, { por: 'oferta' }).linhas, []);
  assert.deepEqual(c1(db, { por: 'bloco' }).linhas.map((l) => [l.bloco_id, l.comissao, l.epc, l.gasto, l.custo_membro]), [[1, 0, null, null, null]], 'blocos aparecem sempre');
  // gasto sem entradas: custo por membro null, retorno = −gasto
  gasto(db, 'grupo', G3, '2026-10-01', '2026-10-10', 1000);
  const g3 = linhaDe(c1(db, { por: 'grupo' }), 'jid', G3);
  assert.deepEqual([g3.gasto, g3.entradas, g3.custo_membro, g3.retorno], [1000, 0, null, -1000]);
  db.close();
});

test('filtros: loja recorta comissão, cliques e envios (não o gasto); bloco recorta tudo ao bloco e aos grupos dele', () => {
  const db = cenarioC1();
  const shopee = c1(db, { loja: 'shopee', por: 'grupo' });
  assert.deepEqual([shopee.total.comissao, shopee.total.cliques, shopee.total.envios, shopee.total.epc], [600, 150, 8, 4]);
  quase(shopee.total.cobertura, 7 / 8, 'cobertura da Shopee');
  assert.deepEqual([shopee.total.gasto, shopee.total.entradas, shopee.total.retorno], [4300, 31, null], 'gasto não tem loja: o retorno fica null');
  assert.deepEqual(shopee.linhas.map((l) => l.jid).sort(), [G1, G2, G3].sort(), 'G3 entra pelas entradas e pelo gasto');
  assert.deepEqual(c1(db, { loja: 'shopee', por: 'loja' }).linhas.map((l) => l.loja), ['shopee']);

  const b1 = c1(db, { bloco: 1, por: 'grupo' });
  assert.deepEqual([b1.total.comissao, b1.total.cliques, b1.total.envios, b1.total.gasto, b1.total.entradas, b1.total.custo_membro, b1.total.retorno],
    [1000, 190, 12, 3100, 25, 124, -2100]);
  assert.equal(b1.nao_atribuida, null, 'no recorte do bloco não há "sem grupo"');
  assert.deepEqual(b1.linhas.map((l) => l.jid), [G1, G2], 'só os grupos do bloco, por comissão');
  assert.deepEqual(linhaDe(b1, 'jid', G1).blocos, [{ id: 1, nome: 'B1' }]);
  assert.deepEqual(c1(db, { bloco: 1, por: 'loja' }).linhas.map((l) => [l.loja, l.comissao]), [['mercadolivre', 0], ['amazon', 400], ['shopee', 600]]);
  assert.throws(() => ganhos.metricas(db, { ...OUTUBRO, bloco: 99 }), (e) => e instanceof ganhos.ErroGanhos && e.status === 404 && e.message === ganhos.MENSAGENS_GANHOS.bloco);
  db.close();
});

test('recortes por oferta e por grupo: ordem por comissão, nomes, ASIN com e sem prefixo, data com hora', () => {
  const db = cenarioC1();
  const oferta = c1(db, { por: 'oferta' });
  assert.deepEqual(oferta.linhas.map((l) => [l.loja, l.oferta, l.comissao, l.vendas, l.envios, l.grupos]), [
    ['mercadolivre', 'MLB1', 600, 1, 2, 1],
    ['amazon', 'B0TESTE002', 500, 1, 2, 1],
    ['shopee', 'SHOPEE:1.2', 500, 2, 7, 2],
    ['amazon', 'B0TESTE001', 400, 2, 4, 2],
    ['shopee', 'SHOPEE:3.4', 100, 1, 1, 1],
  ], 'ASIN do relatório casa com ASIN:… do envio; empate por comissão segue o nome');
  const grupo = c1(db, { por: 'grupo' });
  assert.deepEqual(grupo.linhas.map((l) => [l.jid, l.nome]), [[G1, 'Grupo 1'], [G2, 'Grupo 2'], [G3, 'Grupo 3']]);
  assert.deepEqual(grupo.importado_ate, { mercadolivre: '2026-10-11', amazon: '2026-10-10', shopee: '2026-10-08' }, 'última data importada por loja');
  assert.equal(grupo.gastos_informados, 2);
  assert.deepEqual([grupo.por, grupo.dia_de, grupo.dia_ate, grupo.loja, grupo.bloco], ['grupo', '2026-10-01', '2026-10-31', null, null]);
  // data com hora (importador antigo) continua no dia certo
  comissao(db, { loja: 'shopee', codigo: 'g1', data: '2026-10-31 23:10', valor: 50, status: 'confirmada' });
  assert.equal(linhaDe(c1(db, { por: 'grupo' }), 'jid', G1).comissao, 550);
  assert.throws(() => ganhos.metricas(db, { ...OUTUBRO, por: 'semana' }), (e) => e instanceof ganhos.ErroGanhos && e.status === 400);
  assert.throws(() => ganhos.metricas(db, { ...OUTUBRO, loja: 'magalu' }), (e) => e instanceof ganhos.ErroGanhos && e.status === 400);
  assert.throws(() => ganhos.metricas(db, { de: NaN, ate: 1 }), TypeError);
  db.close();
});

// ---------- gastos com anúncio ----------
const ERRO = (status, frase) => (e) => e instanceof ganhos.ErroGanhos && e.status === status && e.message === frase;

test('gastos: salvar grava em centavos (nota aparada), listar traz o nome do alvo, apagar tira', () => {
  const db = base();
  const g = simples(ganhos.salvarGasto(db, { alvo_tipo: 'bloco', alvo: 1, inicio: '2026-10-01', fim: '2026-10-31', valor_centavos: 3100, nota: '  Meta Ads  ' }, { agora: 5, userId: 7 }));
  assert.deepEqual(g.gasto, { id: g.gasto.id, alvo_tipo: 'bloco', alvo: '1', nome_alvo: 'B1', inicio: '2026-10-01', fim: '2026-10-31', valor_centavos: 3100, nota: 'Meta Ads', criado_em: 5 });
  assert.equal(g.aviso, null);
  assert.equal(db.prepare('SELECT user_id FROM gastos_anuncio WHERE id = ?').get(g.gasto.id).user_id, 7);
  ganhos.salvarGasto(db, { alvo_tipo: 'grupo', alvo: G3, inicio: '2026-10-20', fim: '2026-11-08', valor_centavos: 2000 });
  assert.deepEqual(simples(ganhos.listarGastos(db)).map((x) => [x.alvo_tipo, x.alvo, x.nome_alvo, x.nota]),
    [['grupo', G3, 'Grupo 3', null], ['bloco', '1', 'B1', 'Meta Ads']], 'mais recente primeiro (pelo início)');
  // alvo que sumiu continua na lista, sem nome
  db.exec(`DELETE FROM groups WHERE jid = '${G3}'`);
  assert.equal(simples(ganhos.listarGastos(db))[0].nome_alvo, null);
  assert.equal(ganhos.apagarGasto(db, g.gasto.id), true);
  assert.equal(ganhos.apagarGasto(db, g.gasto.id), false, 'já apagado');
  assert.deepEqual(simples(ganhos.listarGastos(db)).map((x) => x.alvo_tipo), ['grupo']);
  db.close();
});

test('gastos: mesmo alvo com período sobreposto grava e avisa (não bloqueia)', () => {
  const db = base();
  ganhos.salvarGasto(db, { alvo_tipo: 'grupo', alvo: G1, inicio: '2026-10-01', fim: '2026-10-15', valor_centavos: 100 });
  assert.equal(ganhos.salvarGasto(db, { alvo_tipo: 'grupo', alvo: G1, inicio: '2026-10-15', fim: '2026-10-20', valor_centavos: 100 }).aviso, ganhos.MENSAGENS_GANHOS.sobreposto);
  assert.equal(ganhos.salvarGasto(db, { alvo_tipo: 'grupo', alvo: G2, inicio: '2026-10-01', fim: '2026-10-15', valor_centavos: 100 }).aviso, null, 'outro alvo');
  assert.equal(ganhos.salvarGasto(db, { alvo_tipo: 'grupo', alvo: G1, inicio: '2026-10-21', fim: '2026-10-31', valor_centavos: 100 }).aviso, null, 'logo depois');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gastos_anuncio').get().n, 4);
  db.close();
});

test('gastos: validação com frases fixas e sem eco (fim ≥ início, ≤ 366 dias, valor > 0, nota ≤ 200, alvo existente)', () => {
  const db = base();
  const M = ganhos.MENSAGENS_GANHOS;
  const ok = { alvo_tipo: 'grupo', alvo: G1, inicio: '2026-10-01', fim: '2026-10-31', valor_centavos: 100 };
  const casos = [
    [null, 400, M.corpo], [[ok], 400, M.corpo], ['x', 400, M.corpo],
    [{ ...ok, alvo_tipo: 'loja' }, 400, M.alvo], [{ ...ok, alvo_tipo: undefined }, 400, M.alvo],
    [{ ...ok, alvo: 'naoexiste@g.us' }, 404, M.grupo], [{ ...ok, alvo: '' }, 404, M.grupo], [{ ...ok, alvo: 5 }, 404, M.grupo],
    [{ ...ok, alvo_tipo: 'bloco', alvo: 99 }, 404, M.bloco], [{ ...ok, alvo_tipo: 'bloco', alvo: '01' }, 404, M.bloco],
    [{ ...ok, alvo_tipo: 'bloco', alvo: '1e0' }, 404, M.bloco], [{ ...ok, alvo_tipo: 'bloco', alvo: G1 }, 404, M.bloco],
    [{ ...ok, inicio: undefined }, 400, M.periodo], [{ ...ok, fim: '31/10/2026' }, 400, M.periodo],
    [{ ...ok, inicio: '2026-02-30' }, 400, M.periodo], [{ ...ok, fim: '2026-13-01' }, 400, M.periodo], [{ ...ok, inicio: 20261001 }, 400, M.periodo],
    [{ ...ok, inicio: '2026-10-31', fim: '2026-10-01' }, 400, M.ordem],
    [{ ...ok, inicio: '2026-01-01', fim: '2027-01-02' }, 400, M.longo],
    [{ ...ok, valor_centavos: 0 }, 400, M.valor], [{ ...ok, valor_centavos: -5 }, 400, M.valor],
    [{ ...ok, valor_centavos: 1.5 }, 400, M.valor_formato], [{ ...ok, valor_centavos: '100' }, 400, M.valor_formato],
    [{ ...ok, valor_centavos: undefined }, 400, M.valor_formato], [{ ...ok, valor_centavos: Number.MAX_SAFE_INTEGER }, 400, M.valor_formato],
    [{ ...ok, nota: 'x'.repeat(201) }, 400, M.nota], [{ ...ok, nota: 5 }, 400, M.nota],
  ];
  for (const [entrada, status, frase] of casos) {
    assert.throws(() => ganhos.salvarGasto(db, entrada), ERRO(status, frase), JSON.stringify(entrada));
  }
  for (const frase of Object.values(M)) assert.ok(!frase.includes(G1) && !frase.includes('naoexiste'), 'frases fixas');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gastos_anuncio').get().n, 0, 'nada gravado');
  // limites que passam: 366 dias (ano bissexto inteiro), 1 dia, nota de 200, 1 centavo
  ganhos.salvarGasto(db, { ...ok, inicio: '2028-01-01', fim: '2028-12-31', valor_centavos: 1, nota: 'x'.repeat(200) });
  ganhos.salvarGasto(db, { ...ok, inicio: '2026-10-05', fim: '2026-10-05', nota: '' });
  ganhos.salvarGasto(db, { ...ok, alvo_tipo: 'bloco', alvo: '1' });
  assert.deepEqual(simples(db.prepare('SELECT alvo, nota FROM gastos_anuncio ORDER BY id').all()), [{ alvo: G1, nota: 'x'.repeat(200) }, { alvo: G1, nota: null }, { alvo: '1', nota: null }]);
  db.close();
});

// ------------------------------------------------------------------------------------------- etapa 15
// Rotas montadas num Express do próprio teste (a etapa 16 monta no servidor), com o soDono real de src/auth.js.
const express = (await import('express')).default;
const http = await import('node:http');
const { soDono } = await import('../src/auth.js');

/**
 * Express com as rotas dos ganhos sobre `db`. O cabeçalho x-papel faz as vezes da sessão (req.user = {id: 7, papel});
 * `login` liga a auth (sem login no painel, quem usa o computador é o Dono); `semSoDono` monta sem ctx.soDono.
 */
function subirGanhos(db, { login = false, semSoDono = false, viradaMin = 0 } = {}) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use((req, _res, next) => { const p = req.get('x-papel'); req.user = p ? { id: 7, papel: p } : null; next(); });
  const auth = { enabled: () => login };
  ganhos.montarRotas(app, { db, viradaMin: () => viradaMin, ...(semSoDono ? {} : { soDono: soDono(auth) }) });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => ok({
      db, port: server.address().port,
      fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }),
    }));
  });
}
function pedir(s, caminho, { method = 'GET', body, papel } = {}) {
  return new Promise((ok, err) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { ...(papel ? { 'x-papel': papel } : {}), ...(data != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ host: '127.0.0.1', port: s.port, path: caminho, method, headers }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* não é JSON */ } ok({ status: res.statusCode, json, txt }); });
    });
    r.on('error', err); if (data != null) r.write(data); r.end();
  });
}
const OUT_Q = 'periodo=custom&de=2026-10-01&ate=2026-10-31';
const GASTO_OK = Object.freeze({ alvo_tipo: 'grupo', alvo: G3, inicio: '2026-10-01', fim: '2026-10-31', valor_centavos: 1500, nota: 'Meta Ads' });

test('rota GET /api/ganhos?por=grupo devolve M1–M15 do C1 (o mesmo que metricas)', async () => {
  const s = await subirGanhos(cenarioC1());
  try {
    const r = await pedir(s, `/api/ganhos?${OUT_Q}&por=grupo`);
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(r.json, c1(s.db, { por: 'grupo' }), 'a rota só lê a consulta e chama metricas');
    const t = r.json.total;
    assert.deepEqual([t.comissao, t.comissao_confirmada, t.receita, t.vendas, t.cliques, t.epc, t.envios, t.alcance, t.comissao_atribuida, t.gasto, t.entradas, t.retorno],
      [2100, 1300, 41000, 7, 250, 6, 16, 0.75, 1000, 4300, 31, -2200]);
    quase(t.conversao, 6 / 250, 'M6 total (lojas com clique)');
    quase(t.cobertura, 11 / 12, 'M9');
    quase(t.atribuida, 1000 / 2100, 'M11');
    quase(t.custo_membro, 4300 / 31, 'M14 total');
    const g1 = linhaDe(r.json, 'jid', G1); const g3 = linhaDe(r.json, 'jid', G3);
    assert.deepEqual([g1.comissao, g1.vendas, g1.cliques, g1.epc, g1.conversao, g1.envios, g1.entradas, g1.gasto, g1.custo_membro, g1.retorno],
      [500, 2, 100, 5, 0.02, 6, 10, null, null, null]);
    assert.deepEqual([g3.comissao, g3.envios, g3.gasto, g3.entradas, g3.custo_membro, g3.retorno], [0, 4, 1200, 6, 200, -1200]);
    assert.deepEqual([r.json.dia_de, r.json.dia_ate, r.json.nao_atribuida.comissao], ['2026-10-01', '2026-10-31', 1100]);
  } finally { await s.fechar(); }
});

test('rota GET /api/ganhos: recortes, filtros, período padrão (mês atual) e virada do ctx', async () => {
  const s = await subirGanhos(cenarioC1(), { viradaMin: 120 });
  try {
    let r = await pedir(s, `/api/ganhos?${OUT_Q}&por=bloco&bloco=1`);
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(r.json.linhas.map((l) => [l.bloco_id, l.comissao, l.gasto, l.custo_membro, l.retorno]), [[1, 1000, 3100, 124, -2100]]);
    r = await pedir(s, `/api/ganhos?${OUT_Q}&por=loja&loja=shopee`);
    assert.deepEqual([r.status, r.json.loja, r.json.linhas.map((l) => [l.loja, l.comissao, l.epc])], [200, 'shopee', [['shopee', 600, 4]]]);
    r = await pedir(s, `/api/ganhos?${OUT_Q}&por=oferta&loja=`);
    assert.equal(linhaDe(r.json, 'oferta', 'SHOPEE:1.2').comissao, 500, 'loja vazia = todas');
    // sem parâmetros: mês atual, por grupo, com a virada do ctx
    r = await pedir(s, '/api/ganhos');
    const esperado = periodRange('mes', Date.now(), {}, 120);
    assert.deepEqual([r.status, r.json.por, r.json.de, r.json.ate], [200, 'grupo', esperado.de, esperado.ate]);
  } finally { await s.fechar(); }
});

test('rota GET /api/ganhos: consulta inválida → frase fixa, sem eco do valor', async () => {
  const s = await subirGanhos(cenarioC1());
  const M = ganhos.MENSAGENS_GANHOS;
  try {
    const casos = [
      ['por=semana', 400, M.por], ['por=grupo&por=bloco', 400, M.por],
      ['loja=magalu', 400, M.loja], ['loja=shopee&loja=amazon', 400, M.loja],
      ['bloco=99', 404, M.bloco], ['bloco=01', 404, M.bloco], ['bloco=abc', 404, M.bloco], ['bloco=1&bloco=1', 404, M.bloco],
      ['periodo=semana', 400, M.periodo_consulta], ['periodo=custom&de=31/10/2026', 400, M.periodo_consulta],
      ['periodo=custom&de=2026-10-01&ate=2026-02-30', 400, M.periodo_consulta], ['periodo=custom&de=2026-10-01&de=2026-10-02', 400, M.periodo_consulta],
    ];
    for (const [q, status, erro] of casos) {
      const r = await pedir(s, `/api/ganhos?${q}`);
      assert.deepEqual([r.status, r.json], [status, { erro }], q);
      assert.ok(!/magalu|semana|abc|31\/10/.test(r.txt), `sem eco (${q})`);
    }
  } finally { await s.fechar(); }
});

test('rotas de gastos: POST grava (com user_id e aviso), GET lista, DELETE apaga; validação com frases fixas', async () => {
  const s = await subirGanhos(base());
  const M = ganhos.MENSAGENS_GANHOS;
  try {
    let r = await pedir(s, '/api/ganhos/gastos');
    assert.deepEqual([r.status, r.json], [200, { gastos: [] }]);
    r = await pedir(s, '/api/ganhos/gastos', { method: 'POST', body: GASTO_OK, papel: 'dono' });
    assert.equal(r.status, 200, r.txt);
    const id = r.json.gasto.id;
    assert.deepEqual([r.json.gasto.alvo, r.json.gasto.nome_alvo, r.json.gasto.valor_centavos, r.json.gasto.nota, r.json.aviso, r.json.gastos.length],
      [G3, 'Grupo 3', 1500, 'Meta Ads', null, 1]);
    assert.equal(s.db.prepare('SELECT user_id FROM gastos_anuncio WHERE id = ?').get(id).user_id, 7, 'quem lançou');
    r = await pedir(s, '/api/ganhos/gastos', { method: 'POST', body: { ...GASTO_OK, inicio: '2026-10-31', fim: '2026-11-05' } });
    assert.deepEqual([r.status, r.json.aviso, r.json.gastos.length], [200, M.sobreposto, 2], 'sobreposto grava e avisa');

    const casos = [
      [{ ...GASTO_OK, inicio: '2026-10-31', fim: '2026-10-01' }, 400, M.ordem],
      [{ ...GASTO_OK, inicio: '2026-01-01', fim: '2027-01-02' }, 400, M.longo],
      [{ ...GASTO_OK, valor_centavos: 0 }, 400, M.valor],
      [{ ...GASTO_OK, nota: 'segredo'.repeat(30) }, 400, M.nota],
      [{ ...GASTO_OK, alvo: 'sumiu@g.us' }, 404, M.grupo],
      [{ ...GASTO_OK, alvo_tipo: 'bloco', alvo: '7' }, 404, M.bloco],
      [undefined, 400, M.corpo], [[GASTO_OK], 400, M.corpo],
    ];
    for (const [body, status, erro] of casos) {
      const p = await pedir(s, '/api/ganhos/gastos', { method: 'POST', body });
      assert.deepEqual([p.status, p.json], [status, { erro }], JSON.stringify(body));
      assert.ok(!/segredo|sumiu/.test(p.txt), 'sem eco');
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM gastos_anuncio').get().n, 2, 'nenhum inválido gravado');

    r = await pedir(s, `/api/ganhos/gastos/${id}`, { method: 'DELETE' });
    assert.deepEqual([r.status, r.json.gastos.map((g) => g.id).includes(id), r.json.gastos.length], [200, false, 1]);
    for (const caminho of [`/api/ganhos/gastos/${id}`, '/api/ganhos/gastos/abc', '/api/ganhos/gastos/1e0', '/api/ganhos/gastos/999']) {
      const d = await pedir(s, caminho, { method: 'DELETE' });
      assert.deepEqual([d.status, d.json], [404, { erro: M.gasto_sumiu }], caminho);
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM gastos_anuncio').get().n, 1);
  } finally { await s.fechar(); }
});

test('CA11: todas as rotas dos ganhos são só do Dono, inclusive GET (Operador 403, sem sessão 401); sem soDono, ninguém', async () => {
  const rotas = [
    ['GET', `/api/ganhos?${OUT_Q}`], ['GET', '/api/ganhos/gastos'],
    ['POST', '/api/ganhos/gastos', { ...GASTO_OK }], ['DELETE', '/api/ganhos/gastos/1'],
  ];
  const s = await subirGanhos(cenarioC1(), { login: true });
  try {
    const antes = s.db.prepare('SELECT COUNT(*) AS n FROM gastos_anuncio').get().n;
    for (const [method, caminho, body] of rotas) {
      const op = await pedir(s, caminho, { method, body, papel: 'operador' });
      assert.deepEqual([op.status, op.json], [403, { erro: 'Só o Dono pode fazer isso.' }], `Operador em ${method} ${caminho}`);
      const anon = await pedir(s, caminho, { method, body });
      assert.equal(anon.status, 401, `sem sessão em ${method} ${caminho}`);
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM gastos_anuncio').get().n, antes, 'nada gravado nem apagado');
    for (const [method, caminho, body] of rotas) {
      const dono = await pedir(s, caminho, { method, body, papel: 'dono' });
      assert.equal(dono.status, 200, `Dono em ${method} ${caminho}: ${dono.txt}`);
    }
  } finally { await s.fechar(); }

  const fechado = await subirGanhos(cenarioC1(), { semSoDono: true });
  try {
    for (const [method, caminho, body] of rotas) {
      const r = await pedir(fechado, caminho, { method, body, papel: 'dono' });
      assert.equal(r.status, 403, `sem ctx.soDono: ${method} ${caminho}`);
    }
  } finally { await fechado.fechar(); }
});

test('rotas dos ganhos: falha inesperada do banco → 500 com frase fixa, sem a mensagem do SQLite no log nem na resposta', async (t) => {
  const s = await subirGanhos(cenarioC1());
  const logs = [];
  t.mock.method(console, 'error', (...a) => logs.push(a.map(String).join(' ')));
  try {
    s.db.exec('DROP TABLE comissoes; DROP TABLE gastos_anuncio');
    for (const [method, caminho, body] of [['GET', `/api/ganhos?${OUT_Q}`], ['GET', '/api/ganhos/gastos'], ['POST', '/api/ganhos/gastos', GASTO_OK]]) {
      const r = await pedir(s, caminho, { method, body });
      assert.deepEqual([r.status, r.json], [500, { erro: 'Não consegui concluir. Tente de novo.' }], `${method} ${caminho}`);
    }
    assert.equal(logs.length, 3);
    for (const l of logs) assert.ok(!/comissoes|gastos_anuncio|no such table|Meta Ads|@g\.us/.test(l), `log sem detalhe da consulta: ${l}`);
  } finally { await s.fechar(); }
});
