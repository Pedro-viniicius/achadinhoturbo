// Rastreio por grupo nos links (docs/produto/planos/dashboard-ganhos.md, etapas 1, 2 e 6).
// Etapa 1: esquema A (rastreio_codigos, rastreio_envios), só CREATE … IF NOT EXISTS em src/db.js.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';

// pastas temporárias apagadas no fim do arquivo
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-rastreio-')); pastas.push(p); return p; };
/** Linhas como objetos comuns (o node:sqlite devolve objetos sem protótipo). */
const linhas = (db, sql, ...params) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
const colunas = (db, tabela) => db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
const existe = (db, tipo, nome) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(tipo, nome);
const esquema = (db) => linhas(db, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');

// ------------------------------------------------------------------------------------------- etapa 1

const TABELAS_RASTREIO = {
  rastreio_codigos: ['id', 'loja', 'alvo_tipo', 'alvo', 'codigo', 'criado_em', 'atualizado_em'],
  rastreio_envios: ['id', 'ts', 'jid', 'loja', 'origem', 'rule_id', 'envio_id', 'oferta_chave', 'link', 'codigo',
    'nivel', 'bloco_id', 'esperado', 'motivo'],
};
// nome -> [tabela, colunas, único]
const INDICES_RASTREIO = {
  idx_rcod_alvo: ['rastreio_codigos', ['loja', 'alvo_tipo', 'alvo'], 1],
  idx_rcod_cod: ['rastreio_codigos', ['loja', 'codigo'], 1],
  idx_renv_ts: ['rastreio_envios', ['ts'], 0],
  idx_renv_cod: ['rastreio_envios', ['loja', 'codigo', 'ts'], 0],
};

function conferirEsquema(db, quando) {
  for (const [tabela, cols] of Object.entries(TABELAS_RASTREIO)) {
    assert.ok(existe(db, 'table', tabela), `tabela ${tabela} (${quando})`);
    assert.deepEqual(colunas(db, tabela), cols, `colunas de ${tabela} (${quando})`);
  }
  for (const [indice, [tabela, cols, unico]] of Object.entries(INDICES_RASTREIO)) {
    assert.equal(db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indice)?.tbl_name, tabela, `índice ${indice} (${quando})`);
    assert.deepEqual(db.prepare(`PRAGMA index_info(${indice})`).all().map((c) => c.name), cols, `colunas de ${indice} (${quando})`);
    assert.equal(db.prepare(`PRAGMA index_list(${tabela})`).all().find((i) => i.name === indice)?.unique, unico, `${indice} único? (${quando})`);
  }
}

test('esquema A: openDb cria rastreio_codigos, rastreio_envios e os índices; abrir 2× não muda nada', () => {
  const dir = tmp();
  const db1 = openDb(dir);
  conferirEsquema(db1, 'primeira abertura');
  const antes = esquema(db1);
  db1.close();
  const db2 = openDb(dir);
  conferirEsquema(db2, 'segunda abertura');
  assert.deepEqual(esquema(db2), antes, 'a segunda abertura não cria nem altera nada');
  for (const tabela of Object.keys(TABELAS_RASTREIO)) assert.equal(db2.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0, `${tabela} nasce vazia`);
  db2.close();
});

test('esquema A: banco da versão anterior (sem as tabelas do rastreio) migra com os dados intactos', () => {
  const dir = tmp();
  // Banco como o do serviço antes desta etapa: esquema atual sem as tabelas do rastreio, com dados.
  const velho = openDb(dir);
  velho.exec('DROP TABLE rastreio_codigos; DROP TABLE rastreio_envios;');
  velho.exec(`INSERT INTO tags (name, created_at) VALUES ('geral', 1);
    INSERT INTO blocks (id, name, tag_id, created_at) VALUES (4, 'Casa', 1, 1);
    INSERT INTO block_groups (block_id, jid) VALUES (4, 'g1@g.us');
    INSERT INTO groups (jid, name, size, updated_at) VALUES ('g1@g.us', 'Grupo 1', 10, 1);`);
  const tabelas = linhas(velho, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name);
  assert.ok(!tabelas.includes('rastreio_codigos') && !tabelas.includes('rastreio_envios'), 'o banco simulado é mesmo o antigo');
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

test('esquema A: um código aponta para um só alvo por loja; um alvo tem um só código por loja', () => {
  const db = openDb(tmp());
  const novo = db.prepare('INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo, criado_em) VALUES (?, ?, ?, ?, 1)');
  novo.run('amazon', 'bloco', '1', 'casa-20');
  assert.throws(() => novo.run('amazon', 'grupo', 'g1@g.us', 'casa-20'), /UNIQUE constraint failed: rastreio_codigos\.loja, rastreio_codigos\.codigo/,
    '2º código igual na mesma loja');
  assert.throws(() => novo.run('amazon', 'bloco', '1', 'outro-20'), /UNIQUE constraint failed: rastreio_codigos\.loja, rastreio_codigos\.alvo_tipo, rastreio_codigos\.alvo/,
    '2º código para o mesmo alvo e loja');
  novo.run('shopee', 'bloco', '1', 'casa'); // outra loja, mesmo alvo
  novo.run('mercadolivre', 'bloco', '2', 'casa-20'); // outra loja, mesmo texto de código
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rastreio_codigos').get().n, 3);
  db.close();
});

test('esquema A: CHECK recusa loja, tipo de alvo, origem e nível fora da lista', () => {
  const db = openDb(tmp());
  const cod = db.prepare('INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo) VALUES (?, ?, ?, ?)');
  assert.throws(() => cod.run('ml', 'bloco', '1', 'x'), /CHECK constraint failed/);
  assert.throws(() => cod.run('amazon', 'regra', '1', 'x'), /CHECK constraint failed/);
  assert.throws(() => cod.run('amazon', 'bloco', null, 'x'), /NOT NULL constraint failed: rastreio_codigos\.alvo/);
  assert.throws(() => cod.run('amazon', 'bloco', '1', null), /NOT NULL constraint failed: rastreio_codigos\.codigo/);

  const env = db.prepare('INSERT INTO rastreio_envios (ts, jid, loja, origem, link, nivel) VALUES (1, ?, ?, ?, ?, ?)');
  assert.throws(() => env.run('g1@g.us', 'amazon', 'outro', 'https://amzn.to/x', 'padrao'), /CHECK constraint failed/);
  assert.throws(() => env.run('g1@g.us', 'amazon', 'regra', 'https://amzn.to/x', 'loja'), /CHECK constraint failed/);
  assert.throws(() => env.run('g1@g.us', 'amazon', 'regra', null, 'padrao'), /NOT NULL constraint failed: rastreio_envios\.link/);
  env.run('g1@g.us', 'amazon', 'regra', 'https://amzn.to/x', 'padrao');
  assert.deepEqual({ ...db.prepare('SELECT esperado, codigo, motivo FROM rastreio_envios').get() }, { esperado: 0, codigo: null, motivo: null }, 'esperado nasce 0');
  db.close();
});

// ------------------------------------------------------------------------------------------- etapa 2
// Núcleo src/rastreio.js: validar, salvar, resolver, agrupar, registrar, cobertura (M9/M10) e limpar.

const G1 = '1201@g.us', G2 = '1202@g.us', G3 = '1203@g.us', G4 = '1204@g.us';

/** Banco com 4 grupos, blocos B1 (id 1: G1, G2) e B2 (id 2: G4) e as etiquetas geral, etqA, etqB. */
function montar() {
  const db = openDb(tmp());
  db.exec(`INSERT INTO groups (jid, name, size, updated_at) VALUES
      ('${G1}', 'Grupo 1', 10, 1), ('${G2}', 'Grupo 2', 10, 1), ('${G3}', 'Grupo 3', 10, 1), ('${G4}', 'Grupo 4', 10, 1);
    INSERT INTO blocks (id, name, created_at) VALUES (1, 'B1', 1), (2, 'B2', 1);
    INSERT INTO block_groups (block_id, jid) VALUES (1, '${G1}'), (1, '${G2}'), (2, '${G4}');
    INSERT INTO tags (name, created_at) VALUES ('geral', 1), ('etqA', 1), ('etqB', 1);`);
  return db;
}
const PADRAO = Object.freeze({ codigo: null, nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null });
/** Objeto comum (o resultado pode vir de linha do node:sqlite, sem protótipo). */
const simples = (x) => JSON.parse(JSON.stringify(x));
/** Erro do rastreio com status e frase fixa, sem eco do valor recebido. */
const recusa = (status, frase, valor) => (e) => {
  assert.ok(e instanceof rastreio.ErroRastreio, `ErroRastreio (veio ${e?.constructor?.name}: ${e?.message})`);
  assert.equal(e.status, status);
  if (frase) assert.match(e.message, frase);
  // valor curto ('a') aparece em qualquer frase: só confere eco de 4 caracteres para cima
  if (valor && valor.length >= 4) assert.ok(!e.message.includes(valor), 'a mensagem não ecoa o valor recebido');
  return true;
};

const rastreio = await import('../src/rastreio.js');

test('validarCodigo: Shopee aceita só letras e números (até 30) e só no bloco (P6)', () => {
  const db = montar();
  assert.equal(rastreio.validarCodigo(db, 'shopee', 'casa1', 'bloco'), 'casa1');
  assert.equal(rastreio.validarCodigo(db, 'shopee', ' Casa1 ', 'bloco'), 'Casa1', 'espaço nas pontas sai');
  assert.equal(rastreio.validarCodigo(db, 'shopee', 'a'.repeat(30), 'bloco'), 'a'.repeat(30));
  for (const ruim of ['casa-1', 'casa 1', 'casa_1', 'cása', 'a'.repeat(31), 'x<script>']) {
    assert.throws(() => rastreio.validarCodigo(db, 'shopee', ruim, 'bloco'), recusa(400, /Sub_id aceita só letras e números/, ruim), `Sub_id "${ruim}"`);
  }
  assert.throws(() => rastreio.validarCodigo(db, 'shopee', 'casa1', 'grupo'), recusa(400, /Sub_id da Shopee.*bloco/), 'Shopee por grupo é recusada');
  db.close();
});

test('validarCodigo: Amazon segue o formato da tag (letras, números, - e _, 2 a 64) e recusa número puro', () => {
  const db = montar();
  for (const alvo of ['grupo', 'bloco']) assert.equal(rastreio.validarCodigo(db, 'amazon', ' casa-20 ', alvo), 'casa-20');
  assert.equal(rastreio.validarCodigo(db, 'amazon', 'Turbo_b1-20', 'bloco'), 'Turbo_b1-20');
  for (const ruim of ['casa 20', 'a', 'a'.repeat(65), 'casa-20?x=1', 'casa/20']) {
    assert.throws(() => rastreio.validarCodigo(db, 'amazon', ruim, 'grupo'), recusa(400, /ID de rastreamento da Amazon costuma terminar em -20/, ruim), `tag "${ruim}"`);
  }
  assert.throws(() => rastreio.validarCodigo(db, 'amazon', '18328801339', 'grupo'), recusa(400, /parece um ID de afiliado/, '18328801339'));
  db.close();
});

test('validarCodigo: Mercado Livre aceita só etiqueta cadastrada; loja e código vazios são recusados', () => {
  const db = montar();
  assert.equal(rastreio.validarCodigo(db, 'mercadolivre', 'etqA', 'grupo'), 'etqA');
  assert.equal(rastreio.validarCodigo(db, 'mercadolivre', 'etqA', 'bloco'), 'etqA');
  assert.throws(() => rastreio.validarCodigo(db, 'mercadolivre', 'naoexiste', 'grupo'), recusa(400, /etiqueta não está cadastrada/, 'naoexiste'));
  assert.throws(() => rastreio.validarCodigo(db, 'mercadolivre', 'ETQA', 'grupo'), recusa(400, /etiqueta não está cadastrada/), 'o nome é exato');
  for (const vazio of ['', '   ', null, undefined, 12, {}]) {
    assert.throws(() => rastreio.validarCodigo(db, 'amazon', vazio, 'grupo'), recusa(400, /Informe o código/), `código ${JSON.stringify(vazio)}`);
  }
  for (const loja of ['ml', 'Amazon', '', null, 'constructor']) {
    assert.throws(() => rastreio.validarCodigo(db, loja, 'casa-20', 'grupo'), recusa(400, /Loja desconhecida/), `loja ${JSON.stringify(loja)}`);
  }
  db.close();
});

test('salvar e listar: grava, troca o código do alvo, apaga com vazio; um código não vai para dois alvos', () => {
  const db = montar();
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: 'casab1-20' });
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'g3casa-20' });
  rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: '1', codigo: 'casa' });
  rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: G1, codigo: 'etqA' });
  const resumo = () => simples(rastreio.listar(db)).map(({ loja, alvo_tipo, alvo, codigo }) => `${loja} ${alvo_tipo} ${alvo} ${codigo}`);
  assert.deepEqual(resumo(), [`amazon bloco 1 casab1-20`, `amazon grupo ${G3} g3casa-20`, `mercadolivre grupo ${G1} etqA`, `shopee bloco 1 casa`]);
  assert.ok(simples(rastreio.listar(db)).every((r) => Number.isInteger(r.id) && Number.isInteger(r.criado_em) && Number.isInteger(r.atualizado_em)));

  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: 'novob1-20' }); // troca
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: 'novob1-20' }); // o mesmo de novo: nada muda
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rastreio_codigos WHERE loja = 'amazon' AND alvo_tipo = 'bloco'").get().n, 1);
  assert.equal(db.prepare("SELECT codigo FROM rastreio_codigos WHERE loja = 'amazon' AND alvo = '1'").get().codigo, 'novob1-20');

  assert.throws(() => rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 2, codigo: 'g3casa-20' }),
    recusa(400, /^Este código já está associado a outro grupo ou bloco\.$/), 'código de outro alvo, mesma loja');
  rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: 2, codigo: 'etqB' }); // mesmo bloco, outra loja

  for (const vazio of ['', '  ', null, undefined]) {
    rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'g3casa-20' });
    rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: vazio });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rastreio_codigos WHERE alvo = ?').get(G3).n, 0, `código ${JSON.stringify(vazio)} apaga`);
  }
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: G4, codigo: '' }); // apagar o que não existe: nada acontece
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rastreio_codigos').get().n, 4);
  db.close();
});

test('salvar (Q2): ID da Amazon é o mesmo sem olhar a caixa; o alvo pode trocar só a caixa do seu; Sub_id e etiqueta seguem exatos', () => {
  const db = montar();
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: 'Turbo-20' });
  assert.throws(() => rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'tURBO-20' }), recusa(400, /já está associado/));
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: 'turbo-20' }); // o próprio alvo, só a caixa
  assert.deepEqual(simples(rastreio.listar(db)).map((r) => r.codigo), ['turbo-20'], 'a grafia nova é gravada');
  // Shopee e Mercado Livre: a comparação continua exata
  rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: 1, codigo: 'casa' });
  rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: 2, codigo: 'CASA' });
  db.prepare("INSERT INTO tags (name, created_at) VALUES ('ETQA', 1)").run();
  rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: G1, codigo: 'etqA' });
  rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: G2, codigo: 'ETQA' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rastreio_codigos').get().n, 5);
  db.close();
});

test('blocoTemCodigo e etiquetaEmUso (CA11): o que trava apagar bloco/etiqueta e trocar grupos pelo Operador', () => {
  const db = montar();
  assert.equal(rastreio.blocoTemCodigo(db, 1), false);
  rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: 1, codigo: 'casa' });
  rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: G3, codigo: 'etqA' });
  assert.deepEqual([1, '1', 2, null, 'abc', '01'].map((id) => rastreio.blocoTemCodigo(db, id)), [true, true, false, false, false, false]);
  assert.deepEqual(['etqA', 'etqB', 'ETQA', '', null].map((n) => rastreio.etiquetaEmUso(db, n)), [true, false, false, false, false]);
  rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: 2, codigo: 'etqB' });
  assert.equal(rastreio.etiquetaEmUso(db, 'etqB'), true, 'por bloco também');
  db.close();
});

test('salvar: recusa alvo inexistente ou inválido e Shopee por grupo, sem gravar nada', () => {
  const db = montar();
  assert.throws(() => rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 99, codigo: 'casa-20' }), recusa(404, /bloco não existe/));
  for (const alvo of ['abc', '1.5', -1, 0, null, '']) {
    assert.throws(() => rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo, codigo: 'casa-20' }), recusa(404, /bloco não existe/), `bloco ${JSON.stringify(alvo)}`);
  }
  assert.throws(() => rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: '999@g.us', codigo: 'casa-20' }), recusa(404, /grupo não existe/, '999@g.us'));
  assert.throws(() => rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: 'x'.repeat(500), codigo: 'casa-20' }), recusa(404, /grupo não existe/));
  assert.throws(() => rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'regra', alvo: 1, codigo: 'casa-20' }), recusa(400, /grupo ou bloco/));
  assert.throws(() => rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'grupo', alvo: G1, codigo: 'casa' }), recusa(400, /Sub_id da Shopee.*bloco/));
  assert.throws(() => rastreio.salvar(db, { loja: 'ml', alvo_tipo: 'grupo', alvo: G1, codigo: 'etqA' }), recusa(400, /Loja desconhecida/));
  assert.throws(() => rastreio.salvar(db, null), recusa(400));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rastreio_codigos').get().n, 0);
  db.close();
});

test('apagarDoBloco: tira as associações do bloco em todas as lojas e mais nada', () => {
  const db = montar();
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: 'casab1-20' });
  rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: 1, codigo: 'casa' });
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 2, codigo: 'casab2-20' });
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: G1, codigo: 'g1casa-20' });
  assert.equal(rastreio.apagarDoBloco(db, 1), 2);
  assert.deepEqual(simples(rastreio.listar(db)).map((r) => r.codigo), ['casab2-20', 'g1casa-20']);
  assert.equal(rastreio.apagarDoBloco(db, '2'), 1, 'id em texto também vale');
  assert.equal(rastreio.apagarDoBloco(db, 1), 0);
  db.close();
});

test('resolver: sem associação → padrão (esperado 0), em todas as lojas (CA9)', () => {
  const db = montar();
  for (const loja of ['mercadolivre', 'amazon', 'shopee']) {
    for (const jid of [G1, G3, 'desconhecido@g.us']) assert.deepEqual(simples(rastreio.resolver(db, loja, jid)), PADRAO, `${loja} ${jid}`);
  }
  assert.throws(() => rastreio.resolver(db, 'ml', G1), /loja/i);
  db.close();
});

test('resolver: o código do grupo vence o do bloco; o bloco vale para os grupos dele', () => {
  const db = montar();
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: 'casab1-20' });
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: G1, codigo: 'g1casa-20' });
  rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: 1, codigo: 'etqB' });
  assert.deepEqual(simples(rastreio.resolver(db, 'amazon', G1)), { codigo: 'g1casa-20', nivel: 'grupo', bloco_id: null, esperado: 1, motivo: null });
  assert.deepEqual(simples(rastreio.resolver(db, 'amazon', G2)), { codigo: 'casab1-20', nivel: 'bloco', bloco_id: 1, esperado: 1, motivo: null });
  assert.deepEqual(simples(rastreio.resolver(db, 'mercadolivre', G1)), { codigo: 'etqB', nivel: 'bloco', bloco_id: 1, esperado: 1, motivo: null });
  assert.deepEqual(simples(rastreio.resolver(db, 'amazon', G3)), PADRAO, 'grupo fora do bloco não herda');
  assert.deepEqual(simples(rastreio.resolver(db, 'shopee', G2)), PADRAO, 'associação de outra loja não vale');
  db.close();
});

test('resolver: grupo em vários blocos fica com o de menor id que tenha código daquela loja', () => {
  const db = montar();
  db.exec(`INSERT INTO blocks (id, name, created_at) VALUES (5, 'B5', 1);
    INSERT INTO block_groups (block_id, jid) VALUES (5, '${G3}'), (2, '${G3}');`);
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 5, codigo: 'b5-20' });
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 2, codigo: 'b2-20' });
  rastreio.salvar(db, { loja: 'shopee', alvo_tipo: 'bloco', alvo: 5, codigo: 'b5' });
  assert.deepEqual(simples(rastreio.resolver(db, 'amazon', G3)), { codigo: 'b2-20', nivel: 'bloco', bloco_id: 2, esperado: 1, motivo: null });
  assert.deepEqual(simples(rastreio.resolver(db, 'shopee', G3)), { codigo: 'b5', nivel: 'bloco', bloco_id: 5, esperado: 1, motivo: null },
    'o bloco 2 não tem Sub_id: vale o 5');
  db.close();
});

test('resolver: etiqueta do ML apagada de tags → padrão com esperado=1 e motivo etiqueta_apagada', () => {
  const db = montar();
  rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: G1, codigo: 'etqA' });
  rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: 2, codigo: 'etqB' });
  db.exec("DELETE FROM tags WHERE name IN ('etqA', 'etqB')");
  const apagada = { codigo: null, nivel: 'padrao', bloco_id: null, esperado: 1, motivo: 'etiqueta_apagada' };
  assert.deepEqual(simples(rastreio.resolver(db, 'mercadolivre', G1)), apagada, 'no grupo');
  assert.deepEqual(simples(rastreio.resolver(db, 'mercadolivre', G4)), apagada, 'no bloco');
  assert.deepEqual(simples(rastreio.resolver(db, 'mercadolivre', G2)), PADRAO, 'quem não tinha associação segue no padrão');
  db.close();
});

test('resolver: bloco apagado e Sub_id da Shopee gravado por grupo (fora do salvar) não valem', () => {
  const db = montar();
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 2, codigo: 'b2-20' });
  db.exec('DELETE FROM blocks WHERE id = 2'); // block_groups e a associação ficaram órfãos
  assert.deepEqual(simples(rastreio.resolver(db, 'amazon', G4)), PADRAO);
  db.prepare("INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo) VALUES ('shopee', 'grupo', ?, 'g1')").run(G1);
  assert.deepEqual(simples(rastreio.resolver(db, 'shopee', G1)), PADRAO, 'P6: Sub_id só por bloco');
  db.close();
});

test('agrupar: sem associação → uma entrada só, com todos os grupos na ordem e o código padrão (CA9)', () => {
  const db = montar();
  const jids = [G3, G1, G4, G2];
  assert.deepEqual(simples(rastreio.agrupar(db, { loja: 'mercadolivre', jids, padrao: 'geral' })),
    [{ codigo: 'geral', nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null, jids }]);
  assert.deepEqual(simples(rastreio.agrupar(db, { loja: 'shopee', jids, padrao: null })),
    [{ codigo: null, nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null, jids }], 'Shopee sem Sub_id: código nulo');
  assert.deepEqual(simples(rastreio.agrupar(db, { loja: 'amazon', jids: [], padrao: 'turbo-20' })), []);
  assert.throws(() => rastreio.agrupar(db, { loja: 'ml', jids, padrao: 'geral' }), /loja/i);
  db.close();
});

test('agrupar: 3 grupos e 2 códigos → 2 entradas, na ordem do primeiro grupo de cada uma', () => {
  const db = montar();
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: 'casab1-20' });
  assert.deepEqual(simples(rastreio.agrupar(db, { loja: 'amazon', jids: [G3, G1, G2], padrao: 'turbo-20' })), [
    { codigo: 'turbo-20', nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null, jids: [G3] },
    { codigo: 'casab1-20', nivel: 'bloco', bloco_id: 1, esperado: 1, motivo: null, jids: [G1, G2] },
  ]);
  rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'grupo', alvo: G2, codigo: 'g2casa-20' });
  assert.deepEqual(simples(rastreio.agrupar(db, { loja: 'amazon', jids: [G1, G3, G2], padrao: 'turbo-20' })).map((e) => [e.codigo, e.nivel, e.jids]), [
    ['casab1-20', 'bloco', [G1]], ['turbo-20', 'padrao', [G3]], ['g2casa-20', 'grupo', [G2]],
  ]);
  db.close();
});

test('agrupar: etiqueta apagada sai com o código padrão, numa entrada à parte que conta como esperada', () => {
  const db = montar();
  rastreio.salvar(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: G1, codigo: 'etqA' });
  db.exec("DELETE FROM tags WHERE name = 'etqA'");
  assert.deepEqual(simples(rastreio.agrupar(db, { loja: 'mercadolivre', jids: [G1, G3], padrao: 'geral' })), [
    { codigo: 'geral', nivel: 'padrao', bloco_id: null, esperado: 1, motivo: 'etiqueta_apagada', jids: [G1] },
    { codigo: 'geral', nivel: 'padrao', bloco_id: null, esperado: 0, motivo: null, jids: [G3] },
  ]);
  db.close();
});

test('registrar: grava uma linha por grupo com os campos do envio; recusa linha inválida sem gravar', () => {
  const db = montar();
  const id = rastreio.registrar(db, { ts: 1000, jid: G1, loja: 'amazon', origem: 'regra', rule_id: 3, oferta_chave: 'ASIN:B0FG2MD49G',
    link: 'https://www.amazon.com.br/dp/B0FG2MD49G?tag=casab1-20', codigo: 'casab1-20', nivel: 'bloco', bloco_id: 1, esperado: true });
  assert.ok(Number.isInteger(id) && id > 0);
  assert.deepEqual({ ...db.prepare('SELECT * FROM rastreio_envios WHERE id = ?').get(id) }, {
    id, ts: 1000, jid: G1, loja: 'amazon', origem: 'regra', rule_id: 3, envio_id: null, oferta_chave: 'ASIN:B0FG2MD49G',
    link: 'https://www.amazon.com.br/dp/B0FG2MD49G?tag=casab1-20', codigo: 'casab1-20', nivel: 'bloco', bloco_id: 1, esperado: 1, motivo: null,
  });
  const antes = Date.now();
  const id2 = rastreio.registrar(db, { jid: G2, loja: 'shopee', origem: 'manual', envio_id: 7, link: 'https://s.shopee.com.br/abc', nivel: 'nenhum', esperado: 1, motivo: 'limite_shopee' });
  const l2 = db.prepare('SELECT ts, codigo, esperado, motivo FROM rastreio_envios WHERE id = ?').get(id2);
  assert.ok(l2.ts >= antes && l2.ts <= Date.now(), 'sem ts, vale a hora de agora');
  assert.deepEqual({ ...l2, ts: 0 }, { ts: 0, codigo: null, esperado: 1, motivo: 'limite_shopee' });

  const ok = { jid: G1, loja: 'amazon', origem: 'regra', link: 'https://amzn.to/segredo', nivel: 'padrao' };
  for (const [campo, valor] of [['loja', 'ml'], ['origem', 'outra'], ['nivel', 'loja'], ['jid', ''], ['link', ''], ['link', null], ['jid', 5]]) {
    assert.throws(() => rastreio.registrar(db, { ...ok, [campo]: valor }), (e) => !e.message.includes('segredo') && new RegExp(campo).test(e.message), `${campo} = ${JSON.stringify(valor)}`);
  }
  assert.throws(() => rastreio.registrar(db, null), TypeError);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rastreio_envios').get().n, 2);
  db.close();
});

// Cenário C1 do catálogo de métricas (plano, "Catálogo de métricas (MDD)"): só a parte de rastreio_envios.
const OUT = (dia, h = 12) => new Date(2026, 9, dia, h).getTime();
const PERIODO_C1 = { de: new Date(2026, 9, 1).getTime(), ate: new Date(2026, 10, 1).getTime() - 1 };
function cenarioC1() {
  const db = montar();
  const linha = (dia, jid, loja, codigo, nivel, esperado, extra = {}) => rastreio.registrar(db, {
    ts: OUT(dia), jid, loja, origem: 'espelho', link: `https://exemplo.invalid/${loja}/${codigo ?? 'base'}`, codigo, nivel, esperado, ...extra,
  });
  for (let i = 0; i < 4; i++) linha(1 + i, G1, 'shopee', 'g1', 'grupo', 1);
  for (let i = 0; i < 3; i++) linha(1 + i, G2, 'shopee', 'g2', 'grupo', 1);
  linha(4, G2, 'shopee', null, 'nenhum', 1, { motivo: 'limite_shopee' });
  for (const jid of [G1, G2]) for (let i = 0; i < 2; i++) linha(2 + i, jid, 'amazon', 'turbob1-20', 'bloco', 1, { bloco_id: 1 });
  for (let i = 0; i < 2; i++) linha(3 + i, G3, 'amazon', 'turbo-20', 'padrao', 0);
  for (let i = 0; i < 2; i++) linha(3 + i, G3, 'mercadolivre', 'geral', 'padrao', 0);
  // fora do período (30/09 e 01/11): não contam
  rastreio.registrar(db, { ts: new Date(2026, 8, 30, 23, 59).getTime(), jid: G1, loja: 'shopee', origem: 'regra', link: 'https://x.invalid/a', nivel: 'nenhum', esperado: 1 });
  rastreio.registrar(db, { ts: PERIODO_C1.ate + 1, jid: G3, loja: 'amazon', origem: 'regra', link: 'https://x.invalid/b', nivel: 'padrao', esperado: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rastreio_envios WHERE ts BETWEEN ? AND ?').get(PERIODO_C1.de, PERIODO_C1.ate).n, 16, 'C1 tem 16 envios no período');
  return db;
}
const quase = (a, b, msg) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${msg}: ${a} ≈ ${b}`);

test('cobertura C1: M9 total = 11/12 (≈91,67%) e M10 = 12/16 (75%)', () => {
  const db = cenarioC1();
  const c = simples(rastreio.cobertura(db, PERIODO_C1));
  assert.deepEqual({ ...c.total, cobertura: undefined, alcance: undefined }, { envios: 16, esperados: 12, rastreados: 11, cobertura: undefined, alcance: undefined });
  quase(c.total.cobertura, 11 / 12, 'M9 total');
  assert.equal(c.total.alcance, 0.75, 'M10 total');
  db.close();
});

test('cobertura C1: M9 por loja — Shopee 87,5%, Amazon 100%, Mercado Livre null; M10 por loja', () => {
  const db = cenarioC1();
  const porLoja = Object.fromEntries(simples(rastreio.cobertura(db, PERIODO_C1)).por_loja.map((l) => [l.loja, l]));
  assert.deepEqual(Object.keys(porLoja), ['mercadolivre', 'amazon', 'shopee'], 'ordem fixa das lojas');
  assert.deepEqual(porLoja.shopee, { loja: 'shopee', envios: 8, esperados: 8, rastreados: 7, cobertura: 0.875, alcance: 1 });
  assert.deepEqual(porLoja.amazon, { loja: 'amazon', envios: 6, esperados: 4, rastreados: 4, cobertura: 1, alcance: 4 / 6 });
  assert.deepEqual(porLoja.mercadolivre, { loja: 'mercadolivre', envios: 2, esperados: 0, rastreados: 0, cobertura: null, alcance: 0 }, 'sem esperados: M9 null');
  db.close();
});

test('cobertura C1: por grupo e com filtros de loja e de grupos', () => {
  const db = cenarioC1();
  const porGrupo = Object.fromEntries(simples(rastreio.cobertura(db, PERIODO_C1)).por_grupo.map((g) => [g.jid, g]));
  assert.deepEqual(porGrupo[G1], { jid: G1, envios: 6, esperados: 6, rastreados: 6, cobertura: 1, alcance: 1 });
  assert.deepEqual(porGrupo[G2], { jid: G2, envios: 6, esperados: 6, rastreados: 5, cobertura: 5 / 6, alcance: 1 });
  assert.deepEqual(porGrupo[G3], { jid: G3, envios: 4, esperados: 0, rastreados: 0, cobertura: null, alcance: 0 });
  assert.equal(Object.keys(porGrupo).length, 3);

  const shopee = simples(rastreio.cobertura(db, { ...PERIODO_C1, loja: 'shopee' }));
  assert.deepEqual(shopee.total, { envios: 8, esperados: 8, rastreados: 7, cobertura: 0.875, alcance: 1 });
  assert.deepEqual(shopee.por_loja.map((l) => l.loja), ['shopee']);
  const g3 = simples(rastreio.cobertura(db, { ...PERIODO_C1, jids: [G3] }));
  assert.deepEqual(g3.total, { envios: 4, esperados: 0, rastreados: 0, cobertura: null, alcance: 0 });
  const nenhum = simples(rastreio.cobertura(db, { ...PERIODO_C1, jids: [] }));
  assert.deepEqual(nenhum, { total: { envios: 0, esperados: 0, rastreados: 0, cobertura: null, alcance: null }, por_loja: [], por_grupo: [] }, 'lista vazia de grupos: nada');
  db.close();
});

test('cobertura: período sem envio → M9 e M10 null (divisão por zero); loja inválida e período inválido recusados', () => {
  const db = cenarioC1();
  const vazio = simples(rastreio.cobertura(db, { de: new Date(2025, 0, 1).getTime(), ate: new Date(2025, 0, 31).getTime() }));
  assert.deepEqual(vazio, { total: { envios: 0, esperados: 0, rastreados: 0, cobertura: null, alcance: null }, por_loja: [], por_grupo: [] });
  assert.throws(() => rastreio.cobertura(db, { ...PERIODO_C1, loja: 'ml' }), /loja/i);
  assert.throws(() => rastreio.cobertura(db, { de: 'ontem', ate: PERIODO_C1.ate }), /período/i);
  db.close();
});

test('limpar: apaga só o que passou de 400 dias; dias inválido não apaga tudo', () => {
  const db = montar();
  const DIA = 86400000;
  const agora = new Date(2026, 10, 4, 12).getTime();
  const em = (ts) => rastreio.registrar(db, { ts, jid: G1, loja: 'amazon', origem: 'regra', link: 'https://amzn.to/x', nivel: 'padrao' });
  const velhas = () => { em(agora - 401 * DIA); em(agora - 400 * DIA - 1); };
  velhas(); em(agora - 400 * DIA); em(agora - 399 * DIA); em(agora);
  const restam = () => db.prepare('SELECT ts FROM rastreio_envios ORDER BY ts').all().map((r) => agora - r.ts);
  assert.equal(rastreio.RETENCAO_RASTREIO_DIAS, 400);
  assert.equal(rastreio.limpar(db, undefined, agora), 2, 'padrão: 400 dias');
  assert.deepEqual(restam(), [400 * DIA, 399 * DIA, 0], 'exatamente 400 dias fica');
  for (const dias of [0, -1, NaN, null, 'x', Infinity]) {
    velhas();
    assert.equal(rastreio.limpar(db, dias, agora), 2, `dias ${dias} vale como 400`);
    assert.deepEqual(restam(), [400 * DIA, 399 * DIA, 0]);
  }
  assert.equal(rastreio.limpar(db, 1, agora), 2, 'retenção de 1 dia');
  assert.deepEqual(restam(), [0]);
  assert.equal(rastreio.limpar(db, 400, agora), 0);
  db.close();
});

// ------------------------------------------------------------------------------------------- etapa 6
// Tag padrão da Amazon recusada como código, rotas de associação (só Dono), bloco apagado limpa as
// associações dele, retenção chama rastreio.limpar e o resultado da extensão leva sub_id_aplicado.

const TAG_PADRAO = 'desejopadrao-20';
/** Grava a linha 'amazon' de conexoes com a tag em config (como hoje) ou em segredos (compatibilidade). */
function tagPadrao(db, tag, onde = 'config') {
  const json = JSON.stringify({ tag });
  db.prepare(`INSERT INTO conexoes (plataforma, config, segredos, updated_at) VALUES ('amazon', ?, ?, 1)
    ON CONFLICT (plataforma) DO UPDATE SET config = excluded.config, segredos = excluded.segredos`)
    .run(onde === 'config' ? json : '{}', onde === 'config' ? '{}' : json);
}

test('validarCodigo: Amazon recusa a tag padrão de Conexões (não separaria o grupo dos outros), sem ecoar o valor', () => {
  const db = montar();
  assert.equal(rastreio.validarCodigo(db, 'amazon', TAG_PADRAO, 'grupo'), TAG_PADRAO, 'sem Amazon em Conexões, aceita');
  tagPadrao(db, TAG_PADRAO);
  for (const alvo of ['grupo', 'bloco']) {
    for (const igual of [TAG_PADRAO, ` ${TAG_PADRAO} `, TAG_PADRAO.toUpperCase()]) {
      assert.throws(() => rastreio.validarCodigo(db, 'amazon', igual, alvo), recusa(400, /tag padrão da conta/, TAG_PADRAO), `${alvo}: "${igual}"`);
    }
  }
  assert.equal(rastreio.MENSAGENS_RASTREIO.amazon_padrao.includes(TAG_PADRAO), false);
  assert.equal(rastreio.validarCodigo(db, 'amazon', 'casa-20', 'bloco'), 'casa-20', 'outro ID passa');
  assert.throws(() => rastreio.salvar(db, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: TAG_PADRAO }), recusa(400, /tag padrão da conta/));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rastreio_codigos').get().n, 0, 'nada gravado');
  // tag guardada como segredo (versão antiga de Conexões) vale igual; JSON quebrado não derruba
  tagPadrao(db, TAG_PADRAO, 'segredos');
  assert.throws(() => rastreio.validarCodigo(db, 'amazon', TAG_PADRAO, 'grupo'), recusa(400, /tag padrão da conta/));
  db.prepare("UPDATE conexoes SET config = '{quebrado', segredos = '{quebrado' WHERE plataforma = 'amazon'").run();
  assert.equal(rastreio.validarCodigo(db, 'amazon', TAG_PADRAO, 'grupo'), TAG_PADRAO);
  // a etiqueta do ML e o Sub_id da Shopee não olham a tag da Amazon
  tagPadrao(db, 'casa1');
  assert.equal(rastreio.validarCodigo(db, 'shopee', 'casa1', 'bloco'), 'casa1');
  db.close();
});

// ---------- rotas (buildApp real, WhatsApp simulado, links falsos) ----------
const http = await import('node:http');
const { buildApp } = await import('../src/server.js');
const { createWhatsApp } = await import('../src/whatsapp.js');
const { createLinkService } = await import('../src/links.js');
const { createScheduler } = await import('../src/scheduler.js');

/** Servidor sem login (quem usa o computador é o Dono), com o banco de montar(). */
function subir() {
  const db = montar(); const dir = tmp();
  const wa = createWhatsApp({ db, dir, dryRun: true });
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  const app = buildApp({ db, wa, links, scheduler, publicHost: '', panelPassword: '' });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      ok({ db, port, origin: `http://127.0.0.1:${port}`, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) });
    });
  });
}
function req(s, caminho, { method = 'GET', body } = {}) {
  return new Promise((ok, err) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { origin: s.origin, ...(data != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ host: '127.0.0.1', port: s.port, path: caminho, method, headers }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* não é JSON */ } ok({ status: res.statusCode, json, txt }); });
    });
    r.on('error', err); if (data != null) r.write(data); r.end();
  });
}
const semDatas = (codigos) => codigos.map(({ loja, alvo_tipo, alvo, codigo }) => ({ loja, alvo_tipo, alvo, codigo }));

test('rotas: GET/PUT /api/rastreio/codigos grava, troca, apaga com vazio e devolve a lista inteira', async () => {
  const s = await subir();
  try {
    let r = await req(s, '/api/rastreio/codigos');
    assert.deepEqual([r.status, r.json], [200, { codigos: [] }]);
    r = await req(s, '/api/rastreio/codigos', { method: 'PUT', body: { loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: ' casa-20 ' } });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(semDatas(r.json.codigos), [{ loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'casa-20' }]);
    // lote do formulário do bloco: as três lojas de uma vez
    r = await req(s, '/api/rastreio/codigos', { method: 'PUT', body: { associacoes: [
      { loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: 1, codigo: 'etqA' },
      { loja: 'amazon', alvo_tipo: 'bloco', alvo: '1', codigo: 'turbob1-20' },
      { loja: 'shopee', alvo_tipo: 'bloco', alvo: 1, codigo: 'b1' },
    ] } });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(semDatas((await req(s, '/api/rastreio/codigos')).json.codigos), [
      { loja: 'amazon', alvo_tipo: 'bloco', alvo: '1', codigo: 'turbob1-20' },
      { loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'casa-20' },
      { loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: '1', codigo: 'etqA' },
      { loja: 'shopee', alvo_tipo: 'bloco', alvo: '1', codigo: 'b1' },
    ]);
    // troca e apaga (vazio) no mesmo lote
    r = await req(s, '/api/rastreio/codigos', { method: 'PUT', body: { associacoes: [
      { loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'outra-20' },
      { loja: 'shopee', alvo_tipo: 'bloco', alvo: 1, codigo: '' },
    ] } });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(semDatas(r.json.codigos).filter((c) => c.alvo_tipo === 'grupo' || c.loja === 'shopee'), [{ loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'outra-20' }]);
  } finally { await s.fechar(); }
});

test('rotas: código duplicado → 400 com frase fixa; lote com um item ruim não grava nenhum; corpo e alvo inválidos', async () => {
  const s = await subir();
  try {
    const put = (body) => req(s, '/api/rastreio/codigos', { method: 'PUT', body });
    assert.equal((await put({ loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: 'turbob1-20' })).status, 200);
    const contar = () => s.db.prepare('SELECT COUNT(*) AS n FROM rastreio_codigos').get().n;

    const dup = await put({ loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'turbob1-20' });
    assert.deepEqual([dup.status, dup.json], [400, { erro: 'Este código já está associado a outro grupo ou bloco.' }]);
    assert.ok(!dup.txt.includes('turbob1-20'), 'não ecoa o código');

    // lote: o 1º seria válido, o 2º é duplicado → nada muda
    const lote = await put({ associacoes: [
      { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: G3, codigo: 'etqB' },
      { loja: 'amazon', alvo_tipo: 'grupo', alvo: G3, codigo: 'turbob1-20' },
    ] });
    assert.deepEqual([lote.status, lote.json], [400, { erro: 'Este código já está associado a outro grupo ou bloco.' }]);
    assert.equal(contar(), 1, 'o lote é tudo ou nada');

    const casos = [
      [{ loja: 'shopee', alvo_tipo: 'grupo', alvo: G3, codigo: 'g3' }, 400, rastreio.MENSAGENS_RASTREIO.shopee_grupo],
      [{ loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: G3, codigo: 'naoexiste' }, 400, rastreio.MENSAGENS_RASTREIO.etiqueta],
      [{ loja: 'ml', alvo_tipo: 'grupo', alvo: G3, codigo: 'etqA' }, 400, rastreio.MENSAGENS_RASTREIO.loja],
      [{ loja: 'amazon', alvo_tipo: 'bloco', alvo: 99, codigo: 'casa-20' }, 404, rastreio.MENSAGENS_RASTREIO.bloco],
      [{ loja: 'amazon', alvo_tipo: 'grupo', alvo: 'sumiu@g.us', codigo: 'casa-20' }, 404, rastreio.MENSAGENS_RASTREIO.grupo],
      [[], 400, rastreio.MENSAGENS_RASTREIO.corpo],
      [{ associacoes: [] }, 400, rastreio.MENSAGENS_RASTREIO.corpo],
      [{ associacoes: 'x' }, 400, rastreio.MENSAGENS_RASTREIO.corpo],
      [{ associacoes: Array.from({ length: 11 }, () => ({ loja: 'amazon', alvo_tipo: 'bloco', alvo: 2, codigo: '' })) }, 400, rastreio.MENSAGENS_RASTREIO.lote],
    ];
    for (const [body, status, erro] of casos) {
      const r = await put(body);
      assert.deepEqual([r.status, r.json], [status, { erro }], JSON.stringify(body).slice(0, 80));
    }
    assert.equal(contar(), 1, 'nenhuma recusa grava');
  } finally { await s.fechar(); }
});

test('rotas: GET /api/rastreio/cobertura devolve M9/M10 do período, por loja e por bloco; filtros inválidos recusados', async () => {
  const s = await subir();
  try {
    const agora = Date.now();
    const em = (jid, loja, nivel, esperado, ts = agora) => rastreio.registrar(s.db, { ts, jid, loja, origem: 'regra', link: 'https://exemplo.com/x', nivel, esperado, codigo: nivel === 'padrao' ? null : 'c' });
    em(G1, 'amazon', 'bloco', 1); em(G2, 'amazon', 'padrao', 1); em(G3, 'amazon', 'padrao', 0); em(G3, 'shopee', 'padrao', 0);
    em(G1, 'amazon', 'bloco', 1, agora - 60 * 86400000); // fora dos 30 dias

    let r = await req(s, '/api/rastreio/cobertura?periodo=30d');
    assert.equal(r.status, 200, r.txt);
    assert.ok(Number.isFinite(r.json.de) && Number.isFinite(r.json.ate) && r.json.de < r.json.ate, 'devolve o período usado');
    assert.deepEqual(r.json.total, { envios: 4, esperados: 2, rastreados: 1, cobertura: 0.5, alcance: 0.5 });
    assert.deepEqual(r.json.por_loja.map((l) => l.loja), ['amazon', 'shopee']);

    r = await req(s, '/api/rastreio/cobertura?periodo=30d&loja=shopee');
    assert.deepEqual(r.json.total, { envios: 1, esperados: 0, rastreados: 0, cobertura: null, alcance: 0 });
    r = await req(s, '/api/rastreio/cobertura?periodo=30d&bloco=1');
    assert.deepEqual(r.json.por_grupo.map((g) => g.jid).sort(), [G1, G2].sort(), 'só os grupos do bloco 1');
    r = await req(s, '/api/rastreio/cobertura?periodo=custom&de=2000-01-01&ate=2000-01-02');
    assert.deepEqual(r.json.total, { envios: 0, esperados: 0, rastreados: 0, cobertura: null, alcance: null });

    for (const [q, status, erro] of [
      ['loja=ml', 400, rastreio.MENSAGENS_RASTREIO.loja],
      ['bloco=99', 404, rastreio.MENSAGENS_RASTREIO.bloco],
      ['bloco=abc', 404, rastreio.MENSAGENS_RASTREIO.bloco],
      ['loja=amazon&loja=shopee', 400, rastreio.MENSAGENS_RASTREIO.loja],
    ]) {
      r = await req(s, `/api/rastreio/cobertura?${q}`);
      assert.deepEqual([r.status, r.json], [status, { erro }], q);
    }
  } finally { await s.fechar(); }
});

test('DELETE /api/blocks/:id apaga as associações do bloco (todas as lojas) e mais nada', async () => {
  const s = await subir();
  try {
    for (const a of [
      { loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: 1, codigo: 'etqA' }, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 1, codigo: 'b1-20' },
      { loja: 'shopee', alvo_tipo: 'bloco', alvo: 1, codigo: 'b1' }, { loja: 'amazon', alvo_tipo: 'bloco', alvo: 2, codigo: 'b2-20' },
      { loja: 'amazon', alvo_tipo: 'grupo', alvo: G1, codigo: 'g1-20' },
    ]) rastreio.salvar(s.db, a);
    rastreio.registrar(s.db, { jid: G1, loja: 'amazon', origem: 'regra', link: 'https://exemplo.com/x', nivel: 'bloco', bloco_id: 1, codigo: 'b1-20', esperado: 1 });
    const r = await req(s, '/api/blocks/1', { method: 'DELETE' });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual(semDatas(rastreio.listar(s.db)), [
      { loja: 'amazon', alvo_tipo: 'bloco', alvo: '2', codigo: 'b2-20' },
      { loja: 'amazon', alvo_tipo: 'grupo', alvo: G1, codigo: 'g1-20' },
    ]);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM rastreio_envios').get().n, 1, 'o histórico de envios fica (atribuição)');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE id = 1').get().n, 0);
  } finally { await s.fechar(); }
});

test('retenção: "Apagar o que já passou do prazo" chama rastreio.limpar (400 dias, mesmo com retenção 0 = para sempre)', async () => {
  const s = await subir();
  try {
    const DIA = 86400000; const agora = Date.now();
    const em = (ts) => rastreio.registrar(s.db, { ts, jid: G1, loja: 'amazon', origem: 'regra', link: 'https://exemplo.com/x', nivel: 'padrao' });
    em(agora - 401 * DIA); em(agora - 399 * DIA); em(agora);
    s.db.prepare("INSERT INTO settings (key, value) VALUES ('retencao_dias', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const r = await req(s, '/api/privacidade/limpar', { method: 'POST' });
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.rastreio, 1);
    assert.ok('sessoes' in r.json, 'o resto da resposta continua igual');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM rastreio_envios').get().n, 2);
  } finally { await s.fechar(); }
});

test('retenção: o serviço, ao subir, apaga as linhas de rastreio_envios com mais de 400 dias', async () => {
  const { spawn } = await import('node:child_process');
  const dir = tmp();
  const db = openDb(dir);
  const DIA = 86400000; const agora = Date.now();
  for (const ts of [agora - 500 * DIA, agora - 401 * DIA, agora - 10 * DIA]) {
    rastreio.registrar(db, { ts, jid: G1, loja: 'amazon', origem: 'regra', link: 'https://exemplo.com/x', nivel: 'padrao' });
  }
  db.close();
  const raiz = path.join(import.meta.dirname, '..');
  const env = { ...process.env, DATA_DIR: dir, PORT: '0', DRY_RUN: '1', PANEL_PASSWORD: '', PUBLIC_HOST: '', FAST: '1' };
  const filho = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(raiz, 'src', 'server.js')], { cwd: raiz, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let saida = '';
  try {
    await new Promise((ok, falha) => {
      const t = setTimeout(() => falha(new Error(`o servidor não subiu em 20 s: ${saida.slice(-500)}`)), 20000);
      const ler = (c) => { saida += c; if (saida.includes('rodando em')) { clearTimeout(t); ok(); } };
      filho.stdout.on('data', ler); filho.stderr.on('data', ler);
      filho.on('exit', (code) => { clearTimeout(t); falha(new Error(`o servidor saiu (${code}): ${saida.slice(-500)}`)); });
    });
  } finally {
    filho.removeAllListeners('exit');
    if (filho.exitCode === null && filho.signalCode === null) {
      const fim = new Promise((r) => filho.once('exit', r));
      filho.kill('SIGTERM');
      await fim;
    }
  }
  assert.match(saida, /Retenção \(rastreio\): apagadas 2 linhas antigas\./);
  const db2 = openDb(dir);
  assert.deepEqual(db2.prepare('SELECT COUNT(*) AS n FROM rastreio_envios').get().n, 1);
  db2.close();
});
