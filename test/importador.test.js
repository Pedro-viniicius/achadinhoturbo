// Importador de comissões e cliques por CSV (docs/produto/planos/dashboard-ganhos.md, D7 e etapa 14).
// Fixtures inline com valores inventados. As *_PROVISORIO têm cabeçalhos prováveis; as de "P5" têm os cabeçalhos
// reais capturados em 05/11/2026 (docs/produto/referencias/relatorios-dos-portais.md), nunca os valores do dono.
// Arquivo real nunca vai ao repositório.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { openDb, getSetting, setSetting } from '../src/db.js';
import { soDono } from '../src/auth.js';
import { MENSAGENS_CSV } from '../src/csv.js';
import {
  importar, analisar, listarImportacoes, apagarImportacao, montarRotas, ErroImportacao, MENSAGENS_IMPORTADOR,
  normalizarNome, lerDinheiro, lerData, lerStatus, COLUNAS,
  MAX_BYTES_ARQUIVO, MAX_LINHAS_ARQUIVO, MAX_COLUNAS_ARQUIVO, MAX_CARACTERES_CELULA,
} from '../src/importador.js';

// pastas temporárias apagadas no fim do arquivo
const pastas = [];
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-importador-')); pastas.push(p); return p; };
/** Linhas como objetos comuns (o node:sqlite devolve objetos sem protótipo). */
const linhas = (db, sql, ...params) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
const conta = (db, tabela) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n;
const csv = (...l) => Buffer.from(l.join('\r\n') + '\r\n', 'utf8');
/** O que a linha de comissoes guarda de negócio (sem id, chave, importação e datas de gravação). */
const negocio = (db) => linhas(db, `SELECT loja, data, codigo, produto, titulo, quantidade, venda_centavos, comissao_centavos, status
  FROM comissoes ORDER BY data, produto, id`);
const recusa = (status, mensagem) => (e) => {
  assert.ok(e instanceof ErroImportacao, `esperava ErroImportacao, veio ${e?.name}: ${e?.message}`);
  assert.equal(e.status, status);
  if (mensagem instanceof RegExp) assert.match(e.message, mensagem); else assert.equal(e.message, mensagem);
  return true;
};

// Amazon Associados, relatório de ganhos: título antes do cabeçalho, comissão em "Ad Fees", sem coluna de status.
const CAB_AMAZON = ['Category', 'Name', 'ASIN', 'Seller', 'Tracking ID', 'Date Shipped', 'Price', 'Items Shipped', 'Returns', 'Revenue', 'Ad Fees', 'Device Type Group'];
const LINHAS_AMAZON = [
  ['Eletrônicos', 'Fone inventado', 'B0TESTE001', 'Loja X', 'turbob1-20', '2026-10-09', '"50,00"', '2', '0', '"100,00"', '"4,00"', 'DESKTOP'],
  ['Casa', 'Panela inventada', 'B0TESTE002', 'Loja Y', 'casa-20', '10/10/2026', '"80,00"', '1', '0', '"80,00"', '"5,00"', 'PHONE'],
  ['Livros', 'Livro inventado', 'B0TESTE003', 'Loja Z', 'turbob1-20', '2026-10-11 08:15', '"30,00"', '1', '0', '"30,00"', '"1,50"', 'TABLET'],
];
const FIXTURE_AMAZON_PROVISORIO = csv('Relatório de ganhos de Associados (inventado)', CAB_AMAZON.join(','), ...LINHAS_AMAZON.map((l) => l.join(',')));
const ESPERADO_AMAZON = [
  { loja: 'amazon', data: '2026-10-09', codigo: 'turbob1-20', produto: 'B0TESTE001', titulo: null, quantidade: 2, venda_centavos: 10000, comissao_centavos: 400, status: 'pendente' },
  { loja: 'amazon', data: '2026-10-10', codigo: 'casa-20', produto: 'B0TESTE002', titulo: null, quantidade: 1, venda_centavos: 8000, comissao_centavos: 500, status: 'pendente' },
  { loja: 'amazon', data: '2026-10-11', codigo: 'turbob1-20', produto: 'B0TESTE003', titulo: null, quantidade: 1, venda_centavos: 3000, comissao_centavos: 150, status: 'pendente' },
];

// Shopee Afiliados, relatório de conversões, com colunas de comprador (que nunca podem ser lidas).
const CAB_SHOPEE = 'ID do pedido,Status do pedido,Hora do pedido,ID da loja,ID do item,Nome do item,Qtd,Valor de compra(R$),Comissão total do item(R$),Sub_id1,Nome do comprador,Telefone do comprador,Endereço de entrega';
const shopee = (status1 = 'Pendente', ...extras) => csv(CAB_SHOPEE,
  `2610PEDIDO01,${status1},2026-10-05 10:00:00,1,2,Garrafa inventada,1,"50,00","3,00",g1,Fulana de Teste,(31) 90000-0001,Rua Inventada 123`,
  '2610PEDIDO02,Concluído,2026-10-07 11:00:00,1,3,Copo inventado,1,"20,00","1,00",g2,Beltrano de Teste,(31) 90000-0002,Rua Inventada 456',
  '2610PEDIDO03,Cancelado,2026-10-08 12:00:00,4,5,Prato inventado,1,"90,00","9,99",g2,Ciclano de Teste,(31) 90000-0003,Rua Inventada 789',
  ...extras);
const FIXTURE_SHOPEE_PROVISORIO = shopee();
const PESSOAIS = ['Fulana', 'Beltrano', 'Ciclano', '90000', 'Rua Inventada', '2610PEDIDO'];

// Mercado Livre, já filtrado por etiqueta (sem coluna de código), separador ; e datas DD/MM/AAAA, sem pedido.
const FIXTURE_ML_PROVISORIO = csv(
  'Data da venda;ID do produto;Título;Valor da venda;Comissão;Status',
  '05/10/2026;MLB1000000001;Air fryer inventada;"350,00";"17,50";Pago',
  '06/10/2026;MLB1000000002;Liquidificador inventado;"120,00";"6,00";Pendente',
  '06/10/2026;MLB1000000002;Liquidificador inventado;"120,00";"6,00";Pendente',
);

// Shopee, relatório de cliques por dia e Sub_id.
const cliquesShopee = (g1b = '40') => csv('Data,Sub_id1,Cliques', '2026-10-01,g1,60', `2026-10-01,g1,${g1b}`, '2026-10-01,g2,50', '2026-10-02,,7');

const novoDb = () => openDb(tmp());

// ------------------------------------------------------------------------------------------- valores

test('limites reexportados do parser (tabela FATOS da etapa 18)', () => {
  assert.deepEqual([MAX_BYTES_ARQUIVO, MAX_LINHAS_ARQUIVO, MAX_COLUNAS_ARQUIVO, MAX_CARACTERES_CELULA], [5 * 1024 * 1024, 100_000, 200, 2_000]);
});

test('normalizarNome: minúsculas, sem acento, pontuação e R$ viram espaço; % não some', () => {
  assert.equal(normalizarNome('  Comissão total do item(R$) '), 'comissao total do item');
  assert.equal(normalizarNome('Sub_id1'), 'sub id1');
  assert.equal(normalizarNome('ID DE RASTREAMENTO'), 'id de rastreamento');
  assert.equal(normalizarNome('Comissão (%)'), 'comissao pct', 'taxa em % não se confunde com a comissão em dinheiro');
  assert.equal(normalizarNome(''), '');
  const vistos = new Map();
  for (const [campo, sinonimos] of Object.entries(COLUNAS)) {
    for (const s of sinonimos) {
      assert.equal(normalizarNome(s), s, `sinônimo "${s}" já vem normalizado`);
      assert.ok(!vistos.has(s), `"${s}" está em ${vistos.get(s)} e em ${campo}`);
      vistos.set(s, campo);
    }
  }
  // lista branca: nenhuma coluna de comprador casa com um campo
  for (const c of ['Nome do comprador', 'Nome', 'Name', 'Telefone', 'E-mail', 'CPF', 'Endereço', 'Buyer name']) assert.ok(!vistos.has(normalizarNome(c)), c);
});

test('lerDinheiro: formatos BR e US, negativo, milhar sem vírgula com aviso, inválido → null', () => {
  const casos = [
    ['R$ 1.234,56', 123456], ['1,234.56', 123456], ['-12,30', -1230], ['(12,30)', -1230], ['12.30', 1230],
    ['0,5', 50], ['10', 1000], ['+5,00', 500], ['1 234,56', 123456], ['1 234,56', 123456], ['US$ 3.50', 350],
    ['BRL 3,50', 350], ['1,234,567', 123456700], ['1.234,5', 123450], ['0,005', 1], ['-0,005', -1], ['2,675', 268],
  ];
  for (const [texto, centavos] of casos) assert.deepEqual(lerDinheiro(texto), { centavos, milhar: false }, texto);
  assert.deepEqual(lerDinheiro('1.234'), { centavos: 123400, milhar: true });
  assert.deepEqual(lerDinheiro('1.234.567'), { centavos: 123456700, milhar: true });
  for (const ruim of ['', '  ', 'abc', '1,2,3', '1.2.3', '12,30,', '--1', '1e5', 'R$', null, undefined, '9'.repeat(30)]) {
    assert.equal(lerDinheiro(ruim), null, String(ruim));
  }
});

test('lerData: AAAA-MM-DD, DD/MM/AAAA, ISO com hora e fuso; data impossível → null', () => {
  const casos = [
    ['2026-10-09', '2026-10-09'], ['2026-10-09 14:30', '2026-10-09'], ['2026-10-09T14:30:00Z', '2026-10-09'],
    ['2026-10-09T14:30:00.000-03:00', '2026-10-09'], ['09/10/2026', '2026-10-09'], ['09/10/2026 14:30', '2026-10-09'],
    ['9/1/2026', '2026-01-09'], ['2026/10/09', '2026-10-09'], ['10-09-2026', '2026-09-10'], [' 29/02/2028 ', '2028-02-29'],
  ];
  for (const [texto, data] of casos) assert.equal(lerData(texto), data, texto);
  for (const ruim of ['', '31/02/2026', '2026-13-01', '2026-00-10', '32/01/2026', '29/02/2026', 'ontem', '1999-01-01', '01/10/26', null]) {
    assert.equal(lerData(ruim), null, String(ruim));
  }
});

test('lerStatus: mapa pt/en; desconhecido → null (o importador conta como pendente com aviso)', () => {
  for (const s of ['Concluído', 'COMPLETED', 'validado', 'Pago', 'paid', 'Aprovado']) assert.equal(lerStatus(s), 'confirmada', s);
  for (const s of ['Pendente', 'pending', 'não pago', 'Em andamento']) assert.equal(lerStatus(s), 'pendente', s);
  for (const s of ['Cancelado', 'cancelled', 'canceled', 'inválido', 'Devolvido', 'refunded']) assert.equal(lerStatus(s), 'cancelada', s);
  for (const s of ['xyz', '', null]) assert.equal(lerStatus(s), null, String(s));
});

// ------------------------------------------------------------------------------------------- importar

test('Amazon provisória: título antes do cabeçalho, Ad Fees → 3 linhas; sem coluna de status entra como pendente', () => {
  const db = novoDb();
  const r = importar(db, FIXTURE_AMAZON_PROVISORIO, { loja: 'amazon', userId: 7, now: 1000 });
  assert.equal(r.previa, false);
  assert.deepEqual([r.lidas, r.novas, r.atualizadas, r.repetidas, r.ignoradas], [3, 3, 0, 0, 0]);
  assert.deepEqual(negocio(db), ESPERADO_AMAZON);
  assert.deepEqual(r.periodo, { de: '2026-10-09', ate: '2026-10-11' });
  assert.equal(r.comissao_centavos, 1050);
  assert.deepEqual(r.colunas_usadas, [
    { campo: 'data', coluna: 'Date Shipped' }, { campo: 'produto', coluna: 'ASIN' }, { campo: 'codigo', coluna: 'Tracking ID' },
    { campo: 'venda', coluna: 'Revenue' }, { campo: 'comissao', coluna: 'Ad Fees' }, { campo: 'quantidade', coluna: 'Items Shipped' },
    { campo: 'devolucoes', coluna: 'Returns' },
  ]);
  assert.deepEqual(r.colunas_ignoradas, ['Category', 'Name', 'Seller', 'Price', 'Device Type Group']);
  assert.ok(r.avisos.includes(MENSAGENS_IMPORTADOR.semStatus), r.avisos.join(' | '));
  const [imp] = linhas(db, 'SELECT * FROM importacoes');
  assert.equal(r.importacao_id, imp.id);
  assert.deepEqual({ ...imp, id: 0 }, { id: 0, loja: 'amazon', tipo: 'comissoes', arquivo_sha256: imp.arquivo_sha256, codigo_arquivo: null,
    lidas: 3, novas: 3, atualizadas: 0, ignoradas: 0, criado_em: 1000, user_id: 7 });
  assert.match(imp.arquivo_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(linhas(db, 'SELECT DISTINCT importacao_id, atualizado_em FROM comissoes'), [{ importacao_id: imp.id, atualizado_em: 1000 }]);
  db.close();
});

test('colunas em outra ordem e colunas extras → as mesmas linhas, e a mesma chave (reimportar não duplica)', () => {
  const ordem = [10, 5, 2, 11, 0, 4, 9, 7, 1, 3, 6, 8];
  const cab = [...ordem.map((i) => CAB_AMAZON[i]), 'Coluna nova', 'Nome do comprador'];
  const outro = csv(cab.join(','), ...LINHAS_AMAZON.map((l) => [...ordem.map((i) => l[i]), 'x', 'Fulana de Teste'].join(',')));
  const db1 = novoDb(); const db2 = novoDb();
  importar(db1, FIXTURE_AMAZON_PROVISORIO, { loja: 'amazon' });
  // a chave é HMAC com a chave local de cada banco (S2): para comparar, o segundo banco usa a mesma chave local
  setSetting(db2, 'pseudo_key', getSetting(db1, 'pseudo_key'));
  const r = importar(db2, outro, { loja: 'amazon' });
  assert.deepEqual(negocio(db2), negocio(db1));
  assert.deepEqual(linhas(db2, 'SELECT chave FROM comissoes ORDER BY chave'), linhas(db1, 'SELECT chave FROM comissoes ORDER BY chave'));
  assert.ok(r.colunas_ignoradas.includes('Coluna nova') && r.colunas_ignoradas.includes('Nome do comprador'));
  const deNovo = importar(db1, outro, { loja: 'amazon' });
  assert.deepEqual([deNovo.novas, deNovo.repetidas], [0, 3]);
  db1.close(); db2.close();
});

test('LGPD: nome, telefone, endereço e pedido do comprador não ficam em nenhuma tabela; só os nomes das colunas voltam', () => {
  const db = novoDb();
  const r = importar(db, FIXTURE_SHOPEE_PROVISORIO, { loja: 'shopee' });
  assert.deepEqual([r.lidas, r.novas], [3, 3]);
  assert.deepEqual(r.colunas_ignoradas, ['Nome do comprador', 'Telefone do comprador', 'Endereço de entrega']);
  const guardado = JSON.stringify([linhas(db, 'SELECT * FROM comissoes'), linhas(db, 'SELECT * FROM importacoes')]);
  for (const p of PESSOAIS) assert.ok(!guardado.includes(p), `"${p}" não pode ser guardado`);
  const resposta = JSON.stringify(r);
  for (const p of PESSOAIS) assert.ok(!resposta.includes(p), `"${p}" não pode voltar na resposta`);
  // a chave é hash de 32 hex: o pedido não é recuperável pela coluna
  for (const { chave } of linhas(db, 'SELECT chave FROM comissoes')) assert.match(chave, /^[0-9a-f]{32}$/);
  assert.deepEqual(negocio(db), [
    { loja: 'shopee', data: '2026-10-05', codigo: 'g1', produto: 'SHOPEE:1.2', titulo: 'Garrafa inventada', quantidade: 1, venda_centavos: 5000, comissao_centavos: 300, status: 'pendente' },
    { loja: 'shopee', data: '2026-10-07', codigo: 'g2', produto: 'SHOPEE:1.3', titulo: 'Copo inventado', quantidade: 1, venda_centavos: 2000, comissao_centavos: 100, status: 'confirmada' },
    { loja: 'shopee', data: '2026-10-08', codigo: 'g2', produto: 'SHOPEE:4.5', titulo: 'Prato inventado', quantidade: 1, venda_centavos: 9000, comissao_centavos: 999, status: 'cancelada' },
  ]);
  assert.equal(r.comissao_centavos, 400, 'cancelada não soma');
  db.close();
});

test('reimportar o mesmo arquivo → 0 novas, todas repetidas, aviso de "já importado"; pendente → confirmada atualiza sem duplicar', () => {
  const db = novoDb();
  const a = importar(db, FIXTURE_SHOPEE_PROVISORIO, { loja: 'shopee', now: 1000 });
  assert.equal(a.ja_importado, false);
  const b = importar(db, FIXTURE_SHOPEE_PROVISORIO, { loja: 'shopee', now: 2000 });
  assert.deepEqual([b.lidas, b.novas, b.atualizadas, b.repetidas, b.ignoradas], [3, 0, 0, 3, 0]);
  assert.equal(b.ja_importado, true);
  assert.ok(b.avisos.includes(MENSAGENS_IMPORTADOR.jaImportado));
  assert.equal(conta(db, 'comissoes'), 3);
  assert.equal(conta(db, 'importacoes'), 2, 'o histórico registra a tentativa');
  const c = importar(db, shopee('Concluído'), { loja: 'shopee', now: 3000 });
  assert.deepEqual([c.lidas, c.novas, c.atualizadas, c.repetidas], [3, 0, 1, 2]);
  assert.equal(conta(db, 'comissoes'), 3);
  const g1 = linhas(db, "SELECT status, atualizado_em, importacao_id FROM comissoes WHERE codigo = 'g1'");
  assert.deepEqual(g1, [{ status: 'confirmada', atualizado_em: 3000, importacao_id: a.importacao_id }], 'a linha continua da importação que a criou');
  assert.deepEqual(linhas(db, "SELECT DISTINCT atualizado_em FROM comissoes WHERE codigo = 'g2'"), [{ atualizado_em: 1000 }], 'repetida não é regravada');
  db.close();
});

test('prévia: mesmos números da importação, nada gravado (nem importacoes)', () => {
  const db = novoDb();
  importar(db, FIXTURE_SHOPEE_PROVISORIO, { loja: 'shopee' });
  const antes = [negocio(db), linhas(db, 'SELECT * FROM importacoes')];
  const p = importar(db, shopee('Concluído', '2610PEDIDO04,Pendente,2026-10-09 09:00:00,1,9,Jarra inventada,2,"40,00","2,00",g1,X,Y,Z'),
    { loja: 'shopee', previa: true });
  assert.equal(p.previa, true);
  assert.equal(p.importacao_id, null);
  assert.deepEqual([p.lidas, p.novas, p.atualizadas, p.repetidas, p.ignoradas], [4, 1, 1, 2, 0]);
  assert.deepEqual([negocio(db), linhas(db, 'SELECT * FROM importacoes')], antes);
  // analisar (sem banco) dá as colunas e as linhas válidas
  const a = analisar(FIXTURE_SHOPEE_PROVISORIO, { loja: 'shopee' });
  assert.equal(a.registros.length, 3);
  assert.ok(a.registros.every((x) => !('pedido' in x)), 'o pedido sai do analisar só como chave');
  db.close();
});

test('código do arquivo preenche as linhas sem código; sem pedido, linhas iguais no mesmo arquivo são duas vendas', () => {
  const db = novoDb();
  const r = importar(db, FIXTURE_ML_PROVISORIO, { loja: 'mercadolivre', codigo: ' geral ' });
  assert.deepEqual([r.lidas, r.novas], [3, 3]);
  assert.deepEqual(negocio(db).map((l) => [l.codigo, l.produto, l.titulo, l.venda_centavos, l.comissao_centavos, l.status]), [
    ['geral', 'MLB1000000001', 'Air fryer inventada', 35000, 1750, 'confirmada'],
    ['geral', 'MLB1000000002', 'Liquidificador inventado', 12000, 600, 'pendente'],
    ['geral', 'MLB1000000002', 'Liquidificador inventado', 12000, 600, 'pendente'],
  ]);
  assert.equal(linhas(db, 'SELECT codigo_arquivo FROM importacoes')[0].codigo_arquivo, 'geral');
  const chaves = linhas(db, 'SELECT chave FROM comissoes ORDER BY chave').map((l) => l.chave);
  assert.equal(new Set(chaves).size, 3);
  for (const c of chaves) assert.match(c, /^[0-9a-f]{32}#\d+$/);
  const deNovo = importar(db, FIXTURE_ML_PROVISORIO, { loja: 'mercadolivre', codigo: 'geral' });
  assert.deepEqual([deNovo.novas, deNovo.repetidas], [0, 3]);
  // o código da coluna vale mais que o do arquivo
  const db2 = novoDb();
  importar(db2, csv('Data,Sub_id1,Comissão', '2026-10-01,g1,1', '2026-10-02,,2'), { loja: 'shopee', codigo: 'bloco1' });
  assert.deepEqual(negocio(db2).map((l) => l.codigo), ['g1', 'bloco1']);
  db.close(); db2.close();
});

// ------------------------------------------------------------------------------------------- chave (rodada 2: R1/Q2, Q1, R4, S2)

const chaves = (db) => linhas(db, 'SELECT chave FROM comissoes ORDER BY id').map((l) => l.chave);
const CAB_VARIACOES = 'ID do pedido,Hora do pedido,ID da loja,ID do item,Qtd,Comissão total do item(R$),Sub_id1,Status do pedido';
const variacoes = (status) => csv(CAB_VARIACOES,
  `2610VAR01,2026-10-05 10:00:00,1,2,1,"3,00",g1,${status}`,
  `2610VAR01,2026-10-05 10:00:00,1,2,1,"2,00",g1,${status}`,
  `2610VAR01,2026-10-05 10:00:00,1,2,1,"2,00",g1,${status}`);

test('R1/Q2: mesmo pedido e item em várias linhas (variações) → todas entram, a n-ésima com #n; prévia e resumo batem com o banco', () => {
  const db = novoDb();
  const p = importar(db, variacoes('Pendente'), { loja: 'shopee', previa: true });
  const r = importar(db, variacoes('Pendente'), { loja: 'shopee' });
  assert.deepEqual([p.novas, p.atualizadas, p.repetidas], [3, 0, 0], 'a prévia mostra o que vai ser gravado');
  assert.deepEqual([r.lidas, r.novas, r.atualizadas, r.repetidas], [3, 3, 0, 0]);
  assert.equal(conta(db, 'comissoes'), r.novas, 'o resumo bate com o banco');
  assert.equal(r.comissao_centavos, 700);
  assert.equal(linhas(db, 'SELECT SUM(comissao_centavos) AS s FROM comissoes')[0].s, 700, 'nenhuma comissão some');
  const [k1, ...resto] = chaves(db);
  assert.match(k1, /^[0-9a-f]{32}$/, 'a primeira ocorrência fica sem sufixo');
  assert.deepEqual(resto, [`${k1}#2`, `${k1}#3`]);
  const c = importar(db, variacoes('Concluído'), { loja: 'shopee' });
  assert.deepEqual([c.novas, c.atualizadas, c.repetidas], [0, 3, 0]);
  assert.deepEqual(linhas(db, 'SELECT DISTINCT status FROM comissoes'), [{ status: 'confirmada' }]);
  assert.equal(conta(db, 'comissoes'), 3);
  db.close();
});

test('Q1: sem pedido, o mesmo período baixado de novo com valores ou status revisados atualiza a linha (valores fora da chave)', () => {
  const db = novoDb();
  const amz = (devolucoes, tarifa) => csv('Name,ASIN,Tracking ID,Date Shipped,Items Shipped,Returns,Revenue,Ad Fees',
    `Fone inventado,B0TESTE001,turbob1-20,2026-10-09,2,${devolucoes},"100,00","${tarifa}"`,
    'Fone inventado,B0TESTE001,turbob1-20,2026-10-09,1,0,"50,00","2,00"');
  const a = importar(db, amz(0, '4,00'), { loja: 'amazon', now: 1000 });
  assert.equal(a.novas, 2, 'duas vendas iguais no mesmo dia continuam duas linhas');
  const b = importar(db, amz(2, '0,00'), { loja: 'amazon', now: 2000 });
  assert.deepEqual([b.novas, b.atualizadas, b.repetidas], [0, 1, 1]);
  assert.equal(conta(db, 'comissoes'), 2);
  assert.deepEqual(linhas(db, 'SELECT quantidade, comissao_centavos, status, importacao_id, atualizado_em FROM comissoes ORDER BY id'), [
    { quantidade: 2, comissao_centavos: 0, status: 'cancelada', importacao_id: a.importacao_id, atualizado_em: 2000 },
    { quantidade: 1, comissao_centavos: 200, status: 'pendente', importacao_id: a.importacao_id, atualizado_em: 1000 },
  ]);
  for (const k of chaves(db)) assert.match(k, /^[0-9a-f]{32}#[12]$/);
  // Mercado Livre sem pedido: pendente → pago atualiza as duas linhas iguais, sem criar outras
  const ml = (s) => csv('Data da venda;ID do produto;Valor da venda;Comissão;Status', `06/10/2026;MLB1;"120,00";"6,00";${s}`, `06/10/2026;MLB1;"120,00";"6,00";${s}`);
  importar(db, ml('Pendente'), { loja: 'mercadolivre' });
  const c = importar(db, ml('Pago'), { loja: 'mercadolivre' });
  assert.deepEqual([c.novas, c.atualizadas], [0, 2]);
  assert.equal(conta(db, 'comissoes'), 4);
  db.close();
});

test('R4: reimportar com o código do arquivo preenchido atualiza a linha que veio sem código e preenche o código, sem contar em dobro', () => {
  const db = novoDb();
  importar(db, FIXTURE_ML_PROVISORIO, { loja: 'mercadolivre' });
  importar(db, csv('ID do pedido,Data,Comissão', 'P-R4-1,2026-10-01,1'), { loja: 'shopee' });
  assert.deepEqual(negocio(db).map((l) => l.codigo), [null, null, null, null]);
  const r = importar(db, FIXTURE_ML_PROVISORIO, { loja: 'mercadolivre', codigo: 'geral' });
  assert.deepEqual([r.novas, r.atualizadas, r.repetidas], [0, 3, 0]);
  const s = importar(db, csv('ID do pedido,Data,Comissão', 'P-R4-1,2026-10-01,1'), { loja: 'shopee', codigo: 'bloco1' });
  assert.deepEqual([s.novas, s.atualizadas], [0, 1]);
  assert.equal(conta(db, 'comissoes'), 4);
  assert.deepEqual(negocio(db).map((l) => [l.loja, l.codigo]), [['shopee', 'bloco1'], ['mercadolivre', 'geral'], ['mercadolivre', 'geral'], ['mercadolivre', 'geral']]);
  // sem pedido, outro código do arquivo é outro grupo: linhas novas, sem apagar as de 'geral' (R11)
  const t = importar(db, FIXTURE_ML_PROVISORIO, { loja: 'mercadolivre', codigo: 'outro' });
  assert.deepEqual([t.novas, t.atualizadas, t.repetidas], [3, 0, 0]);
  assert.equal(conta(db, 'comissoes'), 7);
  assert.deepEqual(linhas(db, "SELECT codigo, COUNT(*) AS n, SUM(comissao_centavos) AS s FROM comissoes WHERE loja = 'mercadolivre' GROUP BY codigo ORDER BY codigo"),
    [{ codigo: 'geral', n: 3, s: 2950 }, { codigo: 'outro', n: 3, s: 2950 }]);
  // com pedido, o pedido separa as vendas: o código do arquivo continua fora da chave e só atualiza
  const u = importar(db, csv('ID do pedido,Data,Comissão', 'P-R4-1,2026-10-01,1'), { loja: 'shopee', codigo: 'bloco2' });
  assert.deepEqual([u.novas, u.atualizadas], [0, 1]);
  assert.equal(conta(db, 'comissoes'), 7);
  db.close();
});

test('R11: sem pedido e sem coluna de código, arquivos de grupos diferentes (Código do arquivo) no mesmo dia e produto não se sobrescrevem; a prévia bate com o banco', () => {
  const db = novoDb();
  const amz = (v) => csv('Date Shipped,ASIN,Ad Fees,Items Shipped', `2026-10-10,B0ABCDEF12,"${v}",1`);
  const pa = importar(db, amz('5,00'), { loja: 'amazon', codigo: 'grupoa-20', previa: true });
  assert.deepEqual([pa.novas, pa.atualizadas], [1, 0]);
  const a = importar(db, amz('5,00'), { loja: 'amazon', codigo: 'grupoa-20' });
  assert.deepEqual([a.novas, a.atualizadas], [1, 0]);
  const pb = importar(db, amz('7,00'), { loja: 'amazon', codigo: 'grupob-20', previa: true });
  assert.deepEqual([pb.novas, pb.atualizadas, pb.repetidas], [1, 0, 0], 'a prévia do grupo B diz linha nova');
  const b = importar(db, amz('7,00'), { loja: 'amazon', codigo: 'grupob-20' });
  assert.deepEqual([b.novas, b.atualizadas, b.repetidas], [pb.novas, pb.atualizadas, pb.repetidas], 'o resumo bate com a prévia');
  assert.deepEqual(linhas(db, 'SELECT codigo, comissao_centavos, importacao_id FROM comissoes ORDER BY codigo'), [
    { codigo: 'grupoa-20', comissao_centavos: 500, importacao_id: a.importacao_id },
    { codigo: 'grupob-20', comissao_centavos: 700, importacao_id: b.importacao_id },
  ]);
  // reimportar cada um continua sem duplicar
  assert.deepEqual([importar(db, amz('5,00'), { loja: 'amazon', codigo: 'grupoa-20' })].map((x) => [x.novas, x.atualizadas, x.repetidas]), [[0, 0, 1]]);
  assert.deepEqual([importar(db, amz('7,50'), { loja: 'amazon', codigo: 'grupob-20' })].map((x) => [x.novas, x.atualizadas]), [[0, 1]]);
  assert.deepEqual(linhas(db, 'SELECT codigo, comissao_centavos FROM comissoes ORDER BY codigo').map((l) => l.comissao_centavos), [500, 750]);
  // apagar a importação do grupo B não leva a linha do grupo A
  apagarImportacao(db, b.importacao_id);
  assert.deepEqual(linhas(db, 'SELECT codigo, comissao_centavos FROM comissoes'), [{ codigo: 'grupoa-20', comissao_centavos: 500 }]);
  db.close();
});

test('R14: na Amazon o código na chave não distingue maiúsculas (parâmetro e coluna); nas outras lojas distingue', () => {
  const db = novoDb();
  const amz = (v) => csv('Date Shipped,ASIN,Ad Fees,Items Shipped', `2026-10-10,B0ABCDEF12,"${v}",1`);
  const a = importar(db, amz('5,00'), { loja: 'amazon', codigo: 'GrupoA-20' });
  assert.deepEqual([a.novas, a.atualizadas], [1, 0]);
  const b = importar(db, amz('6,00'), { loja: 'amazon', codigo: 'grupoa-20' });
  assert.deepEqual([b.novas, b.atualizadas], [0, 1], 'outra caixa do mesmo ID da Amazon é a mesma venda');
  assert.equal(linhas(db, 'SELECT COUNT(*) AS n FROM comissoes')[0].n, 1);
  // na coluna, com pedido, idem
  const col = (cod) => csv('Order ID,Date Shipped,ASIN,Tracking ID,Ad Fees', `111,2026-10-12,B0ABCDEF12,${cod},"2,00"`);
  assert.equal(importar(db, col('Casa-20'), { loja: 'amazon' }).novas, 1);
  assert.deepEqual([importar(db, col('casa-20'), { loja: 'amazon' })].map((x) => [x.novas, x.repetidas + x.atualizadas]), [[0, 1]]);
  // Mercado Livre: etiqueta distingue caixa, como no resto do sistema
  const ml = (cod) => csv('Data,ID do item,Comissão', `2026-10-10,MLB123,"3,00"`);
  assert.equal(importar(db, ml(), { loja: 'mercadolivre', codigo: 'Etq' }).novas, 1);
  assert.equal(importar(db, ml(), { loja: 'mercadolivre', codigo: 'etq' }).novas, 1);
  db.close();
});

test('R15: cliques da Amazon com o código em outra caixa não duplicam (soma no arquivo e na reimportação)', () => {
  const db = novoDb();
  const arq = csv('Date,Clicks', '2026-10-10,7');
  assert.equal(importar(db, arq, { loja: 'amazon', tipo: 'cliques', codigo: 'GrupoA-20' }).novas, 1);
  assert.equal(importar(db, arq, { loja: 'amazon', tipo: 'cliques', codigo: 'grupoa-20' }).novas, 0);
  assert.deepEqual(linhas(db, 'SELECT codigo, cliques FROM cliques_loja'), [{ codigo: 'grupoa-20', cliques: 7 }]);
  const mesmo = csv('Date,Tracking ID,Clicks', '2026-10-11,Casa-20,3', '2026-10-11,casa-20,4');
  importar(db, mesmo, { loja: 'amazon', tipo: 'cliques' });
  assert.deepEqual(linhas(db, "SELECT cliques FROM cliques_loja WHERE dia = '2026-10-11'"), [{ cliques: 7 }]);
  db.close();
});

test('R11/R4: sem código e depois o mesmo arquivo com código atualiza a mesma linha (prévia igual ao banco); a chave passa a ser a do código', () => {
  const db = novoDb();
  const arq = csv('Date Shipped,ASIN,Ad Fees', '2026-10-10,B0ABCDEF12,"5,00"', '2026-10-10,B0ABCDEF12,"6,00"', '2026-10-11,B0ABCDEF12,"1,00"');
  importar(db, arq, { loja: 'amazon' });
  const antes = chaves(db);
  const p = importar(db, arq, { loja: 'amazon', codigo: 'grupoa-20', previa: true });
  assert.deepEqual([p.novas, p.atualizadas, p.repetidas], [0, 3, 0]);
  assert.deepEqual(chaves(db), antes, 'a prévia não grava');
  const r = importar(db, arq, { loja: 'amazon', codigo: 'grupoa-20' });
  assert.deepEqual([r.novas, r.atualizadas, r.repetidas], [p.novas, p.atualizadas, p.repetidas]);
  assert.deepEqual(linhas(db, 'SELECT codigo, comissao_centavos FROM comissoes ORDER BY id'), [
    { codigo: 'grupoa-20', comissao_centavos: 500 }, { codigo: 'grupoa-20', comissao_centavos: 600 }, { codigo: 'grupoa-20', comissao_centavos: 100 },
  ]);
  assert.ok(chaves(db).every((k) => /^[0-9a-f]{32}#[12]$/.test(k) && !antes.includes(k)), 'a chave foi regravada com o código');
  // agora a linha já tem código: reimportar com ele é repetida, e outro código é outra linha
  assert.deepEqual([importar(db, arq, { loja: 'amazon', codigo: 'grupoa-20' })].map((x) => [x.novas, x.atualizadas, x.repetidas]), [[0, 0, 3]]);
  assert.deepEqual([importar(db, arq, { loja: 'amazon', codigo: 'grupob-20' })].map((x) => [x.novas, x.atualizadas]), [[3, 0]]);
  assert.equal(conta(db, 'comissoes'), 6);
  db.close();
});

test('R11: o código do arquivo só pega a linha sem código do banco; com coluna de código no arquivo, nada muda', () => {
  const db = novoDb();
  // linha sem código no banco + arquivo com coluna de código (vazia numa linha, preenchida na outra)
  importar(db, csv('Date Shipped,ASIN,Ad Fees', '2026-10-10,B0ABCDEF12,"5,00"'), { loja: 'amazon' });
  const arq = csv('Date Shipped,ASIN,Tracking ID,Ad Fees', '2026-10-10,B0ABCDEF12,,"5,00"', '2026-10-10,B0ABCDEF12,col-20,"2,00"');
  const r = importar(db, arq, { loja: 'amazon', codigo: 'grupoa-20' });
  assert.deepEqual([r.novas, r.atualizadas], [1, 1], 'a linha de coluna vazia preenche o código da linha sem código; a outra é nova');
  assert.deepEqual(linhas(db, 'SELECT codigo, comissao_centavos FROM comissoes ORDER BY id'), [
    { codigo: 'grupoa-20', comissao_centavos: 500 }, { codigo: 'col-20', comissao_centavos: 200 },
  ]);
  // a mesma chave sem código não é tomada duas vezes no mesmo arquivo
  const db2 = novoDb();
  importar(db2, csv('Date Shipped,ASIN,Ad Fees', '2026-10-10,B0ABCDEF12,"5,00"'), { loja: 'amazon' });
  const longo = 'x'.repeat(101); // célula de código inválida: fica sem código, como sem o parâmetro
  const arq2 = csv('Date Shipped,ASIN,Tracking ID,Ad Fees', '2026-10-10,B0ABCDEF12,,"5,00"', `2026-10-10,B0ABCDEF12,${longo},"5,00"`);
  const s = importar(db2, arq2, { loja: 'amazon', codigo: 'grupoa-20' });
  assert.deepEqual([s.novas, s.atualizadas, s.repetidas], [1, 0, 1], 'a linha de código inválido é a mesma de antes; a do código do arquivo é nova');
  assert.deepEqual(linhas(db2, 'SELECT codigo FROM comissoes ORDER BY id').map((l) => l.codigo), [null, 'grupoa-20']);
  assert.deepEqual([importar(db2, arq2, { loja: 'amazon', codigo: 'grupoa-20' })].map((x) => [x.novas, x.atualizadas, x.repetidas]), [[0, 0, 2]], 'o resumo bateu com o banco');
  db.close(); db2.close();
});

test('S2: a chave é HMAC com a chave local (não o sha256 dos campos), estável no mesmo banco (inclusive reaberto) e outra em outro banco', () => {
  const dir = tmp();
  let db = openDb(dir);
  const arq = csv('ID do pedido,Data,ID do item,Sub_id1,Comissão', '2610HMAC01,2026-10-01,7,g1,1', ',2026-10-02,8,g2,2');
  importar(db, arq, { loja: 'shopee' });
  const k = chaves(db);
  assert.equal(k.length, 2);
  const sha = (partes) => crypto.createHash('sha256').update(JSON.stringify(partes)).digest('hex').slice(0, 32);
  const puros = [
    sha(['shopee', '2610HMAC01', '7', 'g1']), sha(['pedido', 'shopee', '2610HMAC01', '7', 'g1']),
    sha(['shopee', '2026-10-02', '8', 'g2']), sha(['linha', 'shopee', '2026-10-02', '8', 'g2']),
    sha(['shopee', '2026-10-02', '8', 'g2', 1, 0, 200]),
  ];
  for (const c of k) {
    assert.match(c, /^[0-9a-f]{32}(#\d+)?$/);
    assert.ok(!puros.includes(c.replace(/#\d+$/, '')), 'a chave não pode ser o sha256 puro de um pedido previsível');
  }
  assert.ok(!k.some((c) => c.includes('2610HMAC01')));
  assert.equal(importar(db, arq, { loja: 'shopee' }).repetidas, 2);
  db.close();
  db = openDb(dir);
  assert.deepEqual([importar(db, arq, { loja: 'shopee' })].map((x) => [x.novas, x.repetidas]), [[0, 2]], 'estável depois de reabrir');
  assert.deepEqual(chaves(db), k);
  const outro = novoDb();
  importar(outro, arq, { loja: 'shopee' });
  assert.ok(chaves(outro).every((c) => !k.includes(c)), 'outro banco, outra chave local');
  db.close(); outro.close();
});

test('cliques: soma por dia e código no arquivo; reimportar substitui (a última importação vale)', () => {
  const db = novoDb();
  const a = importar(db, cliquesShopee(), { loja: 'shopee', tipo: 'cliques', now: 1000 });
  assert.equal(a.tipo, 'cliques');
  assert.deepEqual([a.lidas, a.novas, a.atualizadas, a.repetidas, a.ignoradas], [4, 3, 0, 0, 0]);
  assert.equal(a.cliques_total, 157);
  const tabela = () => linhas(db, 'SELECT dia, codigo, cliques FROM cliques_loja ORDER BY dia, codigo');
  assert.deepEqual(tabela(), [
    { dia: '2026-10-01', codigo: 'g1', cliques: 100 }, { dia: '2026-10-01', codigo: 'g2', cliques: 50 }, { dia: '2026-10-02', codigo: '', cliques: 7 },
  ]);
  const b = importar(db, cliquesShopee('60'), { loja: 'shopee', tipo: 'cliques', now: 2000 });
  assert.deepEqual([b.novas, b.atualizadas, b.repetidas], [0, 1, 2]);
  assert.deepEqual(tabela()[0], { dia: '2026-10-01', codigo: 'g1', cliques: 120 }, 'substitui, não soma 100 + 120');
  assert.equal(conta(db, 'comissoes'), 0);
  // cliques num arquivo de comissões não bastam (e vice-versa): erro de coluna com frase fixa
  assert.throws(() => importar(db, cliquesShopee(), { loja: 'shopee' }), recusa(400, MENSAGENS_IMPORTADOR.semComissao));
  assert.throws(() => importar(db, FIXTURE_ML_PROVISORIO, { loja: 'mercadolivre', tipo: 'cliques' }), recusa(400, MENSAGENS_IMPORTADOR.semCliques));
  db.close();
});

test('linhas sem data ou comissão válida são puladas e contadas, com até 5 números de linha (sem conteúdo)', () => {
  const db = novoDb();
  const ruins = ['ontem,g1,1', '2026-10-01,g1,abc', ',g1,2', '31/02/2026,g1,3', '2026-10-02,g1,', 'Total,,99'];
  const r = importar(db, csv('Data,Sub_id1,Comissão', '2026-10-01,g1,"1,00"', ...ruins, '2026-10-03,g2,2.50'), { loja: 'shopee' });
  assert.deepEqual([r.lidas, r.novas, r.ignoradas], [8, 2, 6]);
  assert.deepEqual(r.linhas_ignoradas, [3, 4, 5, 6, 7], 'números das linhas do arquivo, no máximo 5');
  assert.ok(r.avisos.includes('6 linhas foram puladas por valor ou data inválidos. As outras foram importadas.'), r.avisos.join(' | '));
  assert.ok(!JSON.stringify(r).includes('ontem') && !JSON.stringify(r).includes('abc'));
  db.close();
});

test('status desconhecido → pendente com aviso; devolução de todos os itens → cancelada; milhar sem vírgula → aviso', () => {
  const db = novoDb();
  const r = importar(db, csv('Data,Comissão,Status,Quantidade,Devoluções', '2026-10-01,1.234,talvez,1,0', '2026-10-02,"2,00",Pago,2,2', '2026-10-03,"3,00",Pago,3,1'),
    { loja: 'amazon' });
  assert.deepEqual(negocio(db).map((l) => [l.data, l.comissao_centavos, l.status, l.quantidade]), [
    ['2026-10-01', 123400, 'pendente', 1], ['2026-10-02', 200, 'cancelada', 2], ['2026-10-03', 300, 'confirmada', 2],
  ]);
  assert.ok(r.avisos.includes('1 linha com status que o painel não conhece entrou como pendente.'), r.avisos.join(' | '));
  assert.ok(r.avisos.includes('1 valor como 1.234, sem vírgula, foi lido como milhar. Confira os números.'), r.avisos.join(' | '));
  db.close();
});

test('linhas sem grupo: sem código ou com código que não é de nenhum grupo/bloco; lista os códigos desconhecidos', () => {
  const db = novoDb();
  db.prepare("INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo) VALUES ('amazon', 'bloco', '1', 'turbob1-20')").run();
  // código que já saiu num envio com nível de grupo também é conhecido (a associação pode ter mudado depois)
  db.prepare(`INSERT INTO rastreio_envios (ts, jid, loja, origem, link, codigo, nivel, esperado)
    VALUES (1, 'g@g.us', 'amazon', 'manual', 'https://www.amazon.com.br/dp/B0?tag=antigo-20', 'antigo-20', 'grupo', 1)`).run();
  const r = importar(db, csv('Data,Tracking ID,Ad Fees', '2026-10-01,turbob1-20,1', '2026-10-02,casa-20,1', '2026-10-03,,1', '2026-10-04,antigo-20,1', '2026-10-05,casa-20,1'),
    { loja: 'amazon', previa: true });
  assert.equal(r.sem_grupo, 3);
  assert.deepEqual(r.codigos_desconhecidos, ['casa-20']);
  db.close();
});

test('R6/Q4: na Amazon o código conhecido casa sem distinguir maiúsculas (como a atribuição); nas outras lojas, com', () => {
  const db = novoDb();
  db.prepare("INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo) VALUES ('amazon', 'bloco', '1', 'turbob1-20')").run();
  db.prepare(`INSERT INTO rastreio_envios (ts, jid, loja, origem, link, codigo, nivel, esperado)
    VALUES (1, 'g@g.us', 'amazon', 'manual', 'https://www.amazon.com.br/dp/B0?tag=antigo-20', 'antigo-20', 'grupo', 1)`).run();
  db.prepare("INSERT INTO rastreio_codigos (loja, alvo_tipo, alvo, codigo) VALUES ('shopee', 'bloco', '1', 'g1')").run();
  const amz = importar(db, csv('Data,Tracking ID,Ad Fees', '2026-10-01,TurboB1-20,1', '2026-10-02,ANTIGO-20,1', '2026-10-03,Casa-20,1', '2026-10-04,casa-20,1'),
    { loja: 'amazon', previa: true });
  assert.equal(amz.sem_grupo, 2);
  assert.deepEqual(amz.codigos_desconhecidos, ['Casa-20'], 'o mesmo código desconhecido em outra caixa aparece uma vez só');
  const sh = importar(db, csv('Data,Sub_id1,Comissão', '2026-10-01,G1,1', '2026-10-02,g1,1'), { loja: 'shopee', previa: true });
  assert.deepEqual([sh.sem_grupo, sh.codigos_desconhecidos], [1, ['G1']]);
  db.close();
});

test('cabeçalho não encontrado, arquivo só com cabeçalho e parâmetros inválidos → erros com frase fixa, sem eco do arquivo', () => {
  const db = novoDb();
  const pessoal = 'Fulana de Teste,(31) 90000-0001';
  assert.throws(() => importar(db, csv(pessoal, pessoal), { loja: 'shopee' }), recusa(400, MENSAGENS_IMPORTADOR.semComissao));
  assert.throws(() => importar(db, csv('Nome,Comissão', pessoal), { loja: 'shopee' }), recusa(400, MENSAGENS_IMPORTADOR.semData));
  assert.throws(() => importar(db, csv('Data,Comissão'), { loja: 'shopee' }), recusa(400, MENSAGENS_CSV.vazio));
  // cabeçalho depois da 20ª linha não é procurado
  const titulo = Array.from({ length: 20 }, (_, i) => `título ${i}`);
  assert.throws(() => importar(db, csv(...titulo, 'Data,Comissão', '2026-10-01,1'), { loja: 'shopee' }), recusa(400, MENSAGENS_IMPORTADOR.semComissao));
  assert.equal(importar(db, csv(...titulo.slice(1), 'Data,Comissão', '2026-10-01,1'), { loja: 'shopee' }).novas, 1);
  for (const loja of ['', 'magalu', ['shopee'], undefined]) assert.throws(() => importar(db, csv('Data,Comissão', '2026-10-01,1'), { loja }), recusa(400, MENSAGENS_IMPORTADOR.loja));
  assert.throws(() => importar(db, csv('Data,Comissão', '2026-10-01,1'), { loja: 'shopee', tipo: 'vendas' }), recusa(400, MENSAGENS_IMPORTADOR.tipo));
  assert.throws(() => importar(db, csv('Data,Comissão', '2026-10-01,1'), { loja: 'shopee', codigo: 'x'.repeat(101) }), recusa(400, MENSAGENS_IMPORTADOR.codigo));
  assert.throws(() => importar(db, csv('Data,Comissão', '2026-10-01,1'), { loja: 'shopee', codigo: 'a\nb' }), recusa(400, MENSAGENS_IMPORTADOR.codigo));
  // erros do parser passam como ErroImportacao com o mesmo status e frase
  assert.throws(() => importar(db, Buffer.from([0x50, 0x4b, 0x03, 0x04]), { loja: 'shopee' }), recusa(415, MENSAGENS_CSV.excel));
  for (const m of Object.values(MENSAGENS_IMPORTADOR)) assert.ok(!/Fulana|90000/.test(m));
  assert.equal(conta(db, 'comissoes'), 1);
  db.close();
});

test('títulos e códigos longos ou com controle: título cortado em 200, código do arquivo longo vira "sem código"', () => {
  const db = novoDb();
  const r = importar(db, csv('Data,Nome do item,Sub_id1,ID do item,Comissão', `2026-10-01,"${'T'.repeat(250)}",${'c'.repeat(101)},${'9'.repeat(41)},1`), { loja: 'shopee' });
  assert.equal(r.novas, 1);
  const [l] = negocio(db);
  assert.equal(l.titulo, 'T'.repeat(200));
  assert.equal(l.codigo, null);
  assert.equal(l.produto, null, 'produto fora do formato não é guardado');
  db.close();
});

// ------------------------------------------------------------------------------------------- apagar e listar

test('DELETE da importação apaga só as linhas criadas por ela (as que ela só atualizou ficam)', () => {
  const db = novoDb();
  const a = importar(db, FIXTURE_SHOPEE_PROVISORIO, { loja: 'shopee' });
  const b = importar(db, shopee('Concluído', '2610PEDIDO04,Pendente,2026-10-09 09:00:00,1,9,Jarra inventada,2,"40,00","2,00",g1,X,Y,Z'), { loja: 'shopee' });
  assert.deepEqual([b.novas, b.atualizadas], [1, 1]);
  const k = importar(db, cliquesShopee(), { loja: 'shopee', tipo: 'cliques' });
  assert.deepEqual(apagarImportacao(db, b.importacao_id), { id: b.importacao_id, comissoes: 1, cliques: 0 });
  assert.equal(conta(db, 'comissoes'), 3);
  assert.equal(linhas(db, "SELECT status FROM comissoes WHERE codigo = 'g1'")[0].status, 'confirmada');
  assert.deepEqual(listarImportacoes(db).map((i) => i.id), [k.importacao_id, a.importacao_id]);
  assert.deepEqual(apagarImportacao(db, String(k.importacao_id)), { id: k.importacao_id, comissoes: 0, cliques: 3 });
  assert.deepEqual(apagarImportacao(db, a.importacao_id), { id: a.importacao_id, comissoes: 3, cliques: 0 });
  assert.deepEqual([conta(db, 'comissoes'), conta(db, 'cliques_loja'), conta(db, 'importacoes')], [0, 0, 0]);
  for (const ruim of [a.importacao_id, '01', '1e0', ' 1', 'abc', -1, 0, null, '9'.repeat(16)]) {
    assert.throws(() => apagarImportacao(db, ruim), recusa(404, MENSAGENS_IMPORTADOR.naoAchei), String(ruim));
  }
  db.close();
});

test('listarImportacoes: mais recente primeiro, com as contagens e as linhas que ainda são dela; sem sha256 nem usuário', () => {
  const db = novoDb();
  const a = importar(db, FIXTURE_AMAZON_PROVISORIO, { loja: 'amazon', now: 1000 });
  const b = importar(db, FIXTURE_AMAZON_PROVISORIO, { loja: 'amazon', now: 2000 });
  assert.deepEqual(listarImportacoes(db), [
    { id: b.importacao_id, loja: 'amazon', tipo: 'comissoes', codigo_arquivo: null, lidas: 3, novas: 0, atualizadas: 0, repetidas: 3, ignoradas: 0, linhas: 0, criado_em: 2000 },
    { id: a.importacao_id, loja: 'amazon', tipo: 'comissoes', codigo_arquivo: null, lidas: 3, novas: 3, atualizadas: 0, repetidas: 0, ignoradas: 0, linhas: 3, criado_em: 1000 },
  ]);
  db.close();
});

// ------------------------------------------------------------------------------------------- rotas

/** Express só com estas rotas; `papel` simula a sessão (null = sem login). Auth ligada: soDono de verdade. */
function subir({ papel = 'dono', comSoDono = true } = {}) {
  const db = novoDb();
  const app = express();
  const auth = { enabled: () => true };
  app.use((req, _res, next) => { req.user = papel ? { id: papel === 'dono' ? 1 : 2, papel } : null; next(); });
  montarRotas(app, comSoDono ? { db, soDono: soDono(auth) } : { db });
  return new Promise((ok) => {
    const server = app.listen(0, '127.0.0.1', () => {
      ok({ db, port: server.address().port, fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { db.close(); r(); }); }) });
    });
  });
}
function pedir(s, caminho, { method = 'GET', body = null, tipo = 'text/csv' } = {}) {
  return new Promise((ok, err) => {
    const headers = body != null ? { ...(tipo ? { 'content-type': tipo } : {}), 'content-length': body.length } : {};
    const r = http.request({ host: '127.0.0.1', port: s.port, path: caminho, method, headers }, (res) => {
      let txt = ''; res.setEncoding('utf8'); res.on('data', (c) => (txt += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(txt); } catch { /* não é JSON */ } ok({ status: res.statusCode, json, txt }); });
    });
    r.on('error', err); if (body != null) r.write(body); r.end();
  });
}

test('rotas: POST /api/ganhos/importar grava com o usuário; previa=1 não grava; GET lista; DELETE apaga', async () => {
  const s = await subir();
  try {
    let r = await pedir(s, '/api/ganhos/importar?loja=shopee&previa=1', { method: 'POST', body: FIXTURE_SHOPEE_PROVISORIO });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.previa, r.json.novas, r.json.importacao_id], [true, 3, null]);
    assert.equal(conta(s.db, 'importacoes') + conta(s.db, 'comissoes'), 0);
    r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', body: FIXTURE_SHOPEE_PROVISORIO, tipo: 'text/csv; charset=utf-8' });
    assert.equal(r.status, 200, r.txt);
    assert.equal(r.json.novas, 3);
    for (const p of PESSOAIS) assert.ok(!r.txt.includes(p), p);
    assert.equal(linhas(s.db, 'SELECT user_id FROM importacoes')[0].user_id, 1);
    r = await pedir(s, '/api/ganhos/importar?loja=shopee&tipo=cliques&codigo=x', { method: 'POST', body: cliquesShopee(), tipo: 'text/plain' });
    assert.equal(r.status, 200, r.txt);
    assert.equal(linhas(s.db, 'SELECT codigo_arquivo FROM importacoes WHERE tipo = ?', 'cliques')[0].codigo_arquivo, 'x');
    r = await pedir(s, '/api/ganhos/importacoes');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.importacoes.map((i) => [i.tipo, i.novas]), [['cliques', 3], ['comissoes', 3]]);
    const id = r.json.importacoes[1].id;
    r = await pedir(s, `/api/ganhos/importacoes/${id}`, { method: 'DELETE' });
    assert.deepEqual([r.status, r.json], [200, { id, comissoes: 3, cliques: 0 }]);
    r = await pedir(s, `/api/ganhos/importacoes/${id}`, { method: 'DELETE' });
    assert.deepEqual([r.status, r.json], [404, { erro: MENSAGENS_IMPORTADOR.naoAchei }]);
    r = await pedir(s, '/api/ganhos/importacoes/1e0', { method: 'DELETE' });
    assert.equal(r.status, 404);
  } finally { await s.fechar(); }
});

test('rotas: tipo de conteúdo errado → 415; XLSX → 415 do Excel; 6 MB → 413; parâmetro ruim → 400; nada gravado', async () => {
  const s = await subir();
  try {
    let r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', body: Buffer.from('{"a":1}'), tipo: 'application/json' });
    assert.deepEqual([r.status, r.json], [415, { erro: MENSAGENS_CSV.tipo }]);
    r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', body: FIXTURE_SHOPEE_PROVISORIO, tipo: null });
    assert.equal(r.status, 415);
    r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]) });
    assert.deepEqual([r.status, r.json], [415, { erro: MENSAGENS_CSV.excel }]);
    r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', body: Buffer.alloc(6 * 1024 * 1024, 'a') });
    assert.deepEqual([r.status, r.json], [413, { erro: MENSAGENS_CSV.tamanho }]);
    r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST' });
    assert.deepEqual([r.status, r.json], [400, { erro: MENSAGENS_CSV.vazio }]);
    for (const q of ['', '?loja=magalu', '?loja=shopee&loja=amazon']) {
      r = await pedir(s, `/api/ganhos/importar${q}`, { method: 'POST', body: FIXTURE_SHOPEE_PROVISORIO });
      assert.deepEqual([r.status, r.json], [400, { erro: MENSAGENS_IMPORTADOR.loja }], q);
    }
    r = await pedir(s, '/api/ganhos/importar?loja=shopee&tipo=vendas', { method: 'POST', body: FIXTURE_SHOPEE_PROVISORIO });
    assert.deepEqual([r.status, r.json], [400, { erro: MENSAGENS_IMPORTADOR.tipo }]);
    r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', body: csv('Fulana de Teste,(31) 90000-0001') });
    assert.deepEqual([r.status, r.json], [400, { erro: MENSAGENS_IMPORTADOR.semComissao }]);
    assert.equal(conta(s.db, 'importacoes') + conta(s.db, 'comissoes'), 0);
  } finally { await s.fechar(); }
});

test('R9: rotas: previa repetida (vira lista) → 400 com frase fixa, nada gravado; previa=true é prévia', async () => {
  const s = await subir();
  try {
    for (const q of ['previa=1&previa=1', 'previa=0&previa=1', 'previa=1&previa=']) {
      const r = await pedir(s, `/api/ganhos/importar?loja=shopee&${q}`, { method: 'POST', body: FIXTURE_SHOPEE_PROVISORIO });
      assert.deepEqual([r.status, r.json], [400, { erro: MENSAGENS_IMPORTADOR.previa }], q);
    }
    assert.equal(conta(s.db, 'importacoes') + conta(s.db, 'comissoes'), 0);
    const r = await pedir(s, '/api/ganhos/importar?loja=shopee&previa=true', { method: 'POST', body: FIXTURE_SHOPEE_PROVISORIO });
    assert.deepEqual([r.status, r.json.previa, r.json.importacao_id], [200, true, null]);
    assert.equal(conta(s.db, 'importacoes') + conta(s.db, 'comissoes'), 0);
  } finally { await s.fechar(); }
});

test('rotas: só o Dono (Operador 403, sem sessão 401, ctx sem soDono 403), inclusive GET', async () => {
  for (const [opcoes, status] of [[{ papel: 'operador' }, 403], [{ papel: null }, 401], [{ comSoDono: false }, 403]]) {
    const s = await subir(opcoes);
    try {
      const casos = [
        ['/api/ganhos/importar?loja=shopee', { method: 'POST', body: FIXTURE_SHOPEE_PROVISORIO }],
        ['/api/ganhos/importar?loja=shopee&previa=1', { method: 'POST', body: FIXTURE_SHOPEE_PROVISORIO }],
        ['/api/ganhos/importacoes', {}],
        ['/api/ganhos/importacoes/1', { method: 'DELETE' }],
      ];
      for (const [caminho, o] of casos) assert.equal((await pedir(s, caminho, o)).status, status, `${JSON.stringify(opcoes)} ${caminho}`);
      assert.equal(conta(s.db, 'importacoes') + conta(s.db, 'comissoes'), 0);
    } finally { await s.fechar(); }
  }
});

test('rotas: falha inesperada → 500 com frase fixa; o log não traz conteúdo do arquivo nem a mensagem do SQLite', async () => {
  const s = await subir();
  const logs = [];
  const original = console.error;
  console.error = (...a) => logs.push(a.map(String).join(' '));
  try {
    s.db.exec('DROP TABLE comissoes'); // a gravação falha no meio
    const r = await pedir(s, '/api/ganhos/importar?loja=shopee', { method: 'POST', body: FIXTURE_SHOPEE_PROVISORIO });
    assert.deepEqual([r.status, r.json], [500, { erro: MENSAGENS_IMPORTADOR.interno }]);
    assert.equal(conta(s.db, 'importacoes'), 0, 'transação desfeita: nem a importação fica');
    assert.equal(logs.length, 1);
    for (const p of [...PESSOAIS, 'comissoes', 'g1', 'Garrafa']) assert.ok(!logs[0].includes(p), logs[0]);
  } finally { console.error = original; s.db.exec('CREATE TABLE comissoes (id INTEGER)'); await s.fechar(); }
});

// ------------------------------------------------------------------------------------------- P5: relatórios reais dos portais

// Amazon, "Produto relacionado" (Linked-Product): cabeçalho real em inglês; data MM-DD-AAAA, ponto decimal, "-" vazio,
// e a linha "Other" (ASIN que não é ASIN) com os cliques sem produto. Valores inventados.
const CAB_AMAZON_PRODUTO = 'Date,Category,Product Title,ASIN,Clicks,Indirect Items Ordered,Direct Items Ordered,Items Ordered,'
  + 'Direct Conversion Rate,Order Quantity,Product Conversion Rate,Order Conversion Rate,Commission Rate,Ordered Revenue,Items Shipped,'
  + 'Items Returned,Items Shipped Revenue,Items Shipped Earnings,Items Returned Revenue,Items Returned Earnings,Total Earnings';
const FIXTURE_AMAZON_PRODUTO = csv(CAB_AMAZON_PRODUTO,
  '11-04-2026,-,-,Other,12.0,0.0,0.0,0.0,0,0.0,0,0,-,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0',
  '11-04-2026,Cozinha,Panela inventada,B0TESTE001,8.0,0.0,1.0,1.0,0.125,1.0,0.125,0.125,0.05,80.0,1.0,0.0,80.0,4.0,0.0,0.0,4.0',
  '11-05-2026,Livros,Livro inventado,B0TESTE002,5.0,0.0,2.0,2.0,0.4,2.0,0.4,0.4,0.045,60.0,2.0,1.0,60.0,2.7,30.0,1.35,1.35');
// Amazon, "ID de rastreamento" (Tracking-Id): cabeçalho real em português, sem coluna de data (total do período por ID).
const CAB_AMAZON_ID = 'Número de rastreamento,cliques,produtos pedidos,receita solicitada,produtos enviados,produtos devolvidos,'
  + 'receita de produtos enviados,receita de produtos devolvidos,ganhos totais,bônus,ganhos de produtos enviados,ganhos de produtos devolvidos';
const FIXTURE_AMAZON_ID = csv(CAB_AMAZON_ID,
  'grupoa-20,40.0,-,-,-,-,-,-,-,0.0,-,-',
  'grupob-20,25.0,2.0,150.0,2.0,0.0,150.0,0.0,7.5,0.0,7.5,0.0');
// Shopee, relatório de cliques: colunas vistas na tela (o arquivo exportado não foi visto); uma linha por clique.
const CAB_SHOPEE_CLIQUES = 'ID dos Cliques,Período dos Cliques,Região dos Cliques,Sub_id,Referenciador';
const FIXTURE_SHOPEE_CLIQUES = csv(CAB_SHOPEE_CLIQUES,
  'C0001,2026-11-04 10:15:00,Região Inventada,g1,WhatsApp',
  'C0002,2026-11-04 23:59,Região Inventada,g1,WhatsApp',
  'C0003,04/11/2026 08:00:01,Outra Região,g2,-',
  'C0004,05/11/2026 00:00,Outra Região,g1,',
  ',2026-11-05 01:00:00,Outra Região,g1,',
  'C0006,ontem,Outra Região,g1,');

/** ZIP com uma entrada (deflate), como o da Amazon: só o necessário para a rota; os casos do formato estão em csv.test.js. */
function zipUm(nome, dados) {
  const n = Buffer.from(nome); const comp = zlib.deflateRawSync(dados); const crc = zlib.crc32(dados);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(dados.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(dados.length, 24); central.writeUInt16LE(n.length, 28);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(1, 8); fim.writeUInt16LE(1, 10);
  fim.writeUInt32LE(46 + n.length, 12); fim.writeUInt32LE(30 + n.length + comp.length, 16);
  return Buffer.concat([local, n, comp, central, n, fim]);
}

test('P5: lerData com loja=amazon lê NN-NN-AAAA (hífen) como mês-dia-ano; DD/MM/AAAA (barra) continua dia/mês em todas as lojas', () => {
  const casos = [
    ['11-04-2026', 'amazon', '2026-11-04'], ['11-04-2026 10:00', 'amazon', '2026-11-04'], ['1-4-2026', 'amazon', '2026-01-04'],
    ['04/11/2026', 'amazon', '2026-11-04'], ['2026-11-04', 'amazon', '2026-11-04'], ['12-31-2026', 'amazon', '2026-12-31'],
    ['11-04-2026', 'shopee', '2026-04-11'], ['11-04-2026', 'mercadolivre', '2026-04-11'], ['11-04-2026', undefined, '2026-04-11'],
    ['04/11/2026', 'shopee', '2026-11-04'],
  ];
  for (const [texto, loja, data] of casos) assert.equal(lerData(texto, { loja }), data, `${texto} ${loja}`);
  for (const ruim of ['13-04-2026', '02-30-2026', '31-12-2026']) assert.equal(lerData(ruim, { loja: 'amazon' }), null, ruim);
  assert.equal(lerData('31-12-2026'), '2026-12-31', 'sem loja, como antes');
});

test('P5: data e hora no formato dos cliques da Shopee (AAAA-MM-DD hh:mm[:ss] e DD/MM/AAAA hh:mm[:ss])', () => {
  for (const [texto, data] of [['2026-11-04 10:15:00', '2026-11-04'], ['2026-11-04 23:59', '2026-11-04'], ['04/11/2026 08:00:01', '2026-11-04'], ['05/11/2026 00:00', '2026-11-05']]) {
    assert.equal(lerData(texto, { loja: 'shopee' }), data, texto);
  }
});

test('P5: status "em revisão" (Mercado Livre) é pendente', () => {
  for (const s of ['EM REVISÃO', 'em revisão', 'Em revisao']) assert.equal(lerStatus(s), 'pendente', s);
});

test('P5: Amazon "Produto relacionado" (cabeçalho real) como comissões: MM-DD-AAAA, ponto decimal, "-" vazio, Total Earnings; "Other" não é produto', () => {
  const db = novoDb();
  const r = importar(db, FIXTURE_AMAZON_PRODUTO, { loja: 'amazon', codigo: 'grupoa-20' });
  assert.deepEqual([r.lidas, r.novas, r.ignoradas, r.so_cliques], [3, 2, 0, 1], r.avisos.join(' | '));
  // a "Other" só tem cliques (comissão, venda e quantidade 0): fica de fora das comissões (R2)
  assert.deepEqual(negocio(db), [
    { loja: 'amazon', data: '2026-11-04', codigo: 'grupoa-20', produto: 'B0TESTE001', titulo: 'Panela inventada', quantidade: 1, venda_centavos: 8000, comissao_centavos: 400, status: 'pendente' },
    { loja: 'amazon', data: '2026-11-05', codigo: 'grupoa-20', produto: 'B0TESTE002', titulo: 'Livro inventado', quantidade: 1, venda_centavos: 6000, comissao_centavos: 135, status: 'pendente' },
  ]);
  assert.deepEqual(r.periodo, { de: '2026-11-04', ate: '2026-11-05' });
  assert.equal(r.comissao_centavos, 535, 'Total Earnings (já com a devolução), não Items Shipped Earnings');
  assert.deepEqual(r.colunas_usadas, [
    { campo: 'data', coluna: 'Date' }, { campo: 'produto', coluna: 'ASIN' }, { campo: 'titulo', coluna: 'Product Title' },
    { campo: 'venda', coluna: 'Items Shipped Revenue' }, { campo: 'comissao', coluna: 'Total Earnings' },
    { campo: 'quantidade', coluna: 'Items Shipped' }, { campo: 'devolucoes', coluna: 'Items Returned' },
  ]);
  assert.ok(r.colunas_ignoradas.includes('Clicks') && r.colunas_ignoradas.includes('Items Shipped Earnings'));
  db.close();
});

test('P5: Amazon "Produto relacionado" como cliques: Clicks com ponto decimal somados por dia (a linha Other conta)', () => {
  const db = novoDb();
  const r = importar(db, FIXTURE_AMAZON_PRODUTO, { loja: 'amazon', tipo: 'cliques', codigo: 'GrupoA-20' });
  assert.deepEqual([r.lidas, r.novas, r.ignoradas, r.cliques_total], [3, 2, 0, 25]);
  assert.deepEqual(linhas(db, 'SELECT dia, codigo, cliques FROM cliques_loja ORDER BY dia'), [
    { dia: '2026-11-04', codigo: 'grupoa-20', cliques: 20 }, { dia: '2026-11-05', codigo: 'grupoa-20', cliques: 5 },
  ]);
  db.close();
});

test('P5: CSV da Amazon dentro do .zip pela rota → importa como o CSV solto; o XLSX segue recusado', async () => {
  const s = await subir();
  try {
    const nome = '1234-Linked-Product-0f0f0f0f-aaaa-bbbb-cccc-000000000000-CSV.csv';
    let r = await pedir(s, '/api/ganhos/importar?loja=amazon&tipo=cliques&codigo=grupoa-20&previa=1', { method: 'POST', body: zipUm(nome, FIXTURE_AMAZON_PRODUTO) });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.previa, r.json.lidas, r.json.novas, r.json.cliques_total], [true, 3, 2, 25]);
    assert.ok(!r.txt.includes('Linked-Product'), 'o nome da entrada não volta');
    r = await pedir(s, '/api/ganhos/importar?loja=amazon&codigo=grupoa-20', { method: 'POST', body: zipUm(nome, FIXTURE_AMAZON_PRODUTO) });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.novas, r.json.so_cliques], [2, 1], 'a "Other" só tem cliques (R2)');
    assert.equal(conta(s.db, 'comissoes'), 2);
    r = await pedir(s, '/api/ganhos/importar?loja=amazon', { method: 'POST', body: zipUm('leia.txt', FIXTURE_AMAZON_PRODUTO) });
    assert.deepEqual([r.status, r.json], [415, { erro: MENSAGENS_CSV.zip }]);
    assert.equal(conta(s.db, 'importacoes'), 1);
  } finally { await s.fechar(); }
});

test('P5: Amazon "ID de rastreamento" (sem coluna de data): sem a data do relatório → 400 com frase fixa; com dia, toda linha usa a data e há aviso', () => {
  const db = novoDb();
  assert.equal(MENSAGENS_IMPORTADOR.semData, 'Este relatório não tem data por linha: informe a data do relatório.');
  for (const tipo of ['comissoes', 'cliques']) {
    assert.throws(() => importar(db, FIXTURE_AMAZON_ID, { loja: 'amazon', tipo }), recusa(400, MENSAGENS_IMPORTADOR.semData), tipo);
  }
  const r = importar(db, FIXTURE_AMAZON_ID, { loja: 'amazon', dia: '2026-11-04' });
  assert.deepEqual([r.lidas, r.novas, r.ignoradas, r.so_cliques], [2, 1, 0, 1], 'o grupoa-20 só tem cliques (R2)');
  assert.deepEqual(negocio(db), [
    { loja: 'amazon', data: '2026-11-04', codigo: 'grupob-20', produto: null, titulo: null, quantidade: 2, venda_centavos: 15000, comissao_centavos: 750, status: 'pendente' },
  ]);
  assert.deepEqual(r.colunas_usadas, [
    { campo: 'codigo', coluna: 'Número de rastreamento' }, { campo: 'venda', coluna: 'receita de produtos enviados' },
    { campo: 'comissao', coluna: 'ganhos totais' }, { campo: 'quantidade', coluna: 'produtos enviados' }, { campo: 'devolucoes', coluna: 'produtos devolvidos' },
  ]);
  assert.ok(r.avisos.includes(MENSAGENS_IMPORTADOR.diaUsado), r.avisos.join(' | '));
  assert.deepEqual(r.periodo, { de: '2026-11-04', ate: '2026-11-04' });
  assert.equal(importar(db, FIXTURE_AMAZON_ID, { loja: 'amazon', dia: '2026-11-04' }).repetidas, 1, 'reimportar com a mesma data não duplica');
  const k = importar(db, FIXTURE_AMAZON_ID, { loja: 'amazon', tipo: 'cliques', dia: '2026-11-04' });
  assert.deepEqual([k.novas, k.cliques_total], [2, 65]);
  assert.ok(k.avisos.includes(MENSAGENS_IMPORTADOR.diaUsado));
  assert.deepEqual(linhas(db, 'SELECT dia, codigo, cliques FROM cliques_loja ORDER BY codigo'), [
    { dia: '2026-11-04', codigo: 'grupoa-20', cliques: 40 }, { dia: '2026-11-04', codigo: 'grupob-20', cliques: 25 },
  ]);
  db.close();
});

test('P5: com coluna de data, a data do relatório não muda nada (aviso de que não foi usada); dia inválido → 400 com frase fixa', () => {
  const db = novoDb();
  const r = importar(db, FIXTURE_AMAZON_PRODUTO, { loja: 'amazon', dia: '2026-10-01', previa: true });
  assert.deepEqual(r.periodo, { de: '2026-11-04', ate: '2026-11-05' });
  assert.ok(r.avisos.includes(MENSAGENS_IMPORTADOR.diaIgnorado), r.avisos.join(' | '));
  assert.ok(!r.avisos.includes(MENSAGENS_IMPORTADOR.diaUsado));
  assert.ok(!importar(db, FIXTURE_AMAZON_PRODUTO, { loja: 'amazon', previa: true }).avisos.includes(MENSAGENS_IMPORTADOR.diaIgnorado));
  for (const dia of ['ontem', '2026-02-30', '2026-1-01', '04/11/2026', '1999-12-31', '2026-11-04 10:00', ['2026-11-04'], 20261104, ' 2026-11-04']) {
    assert.throws(() => importar(db, FIXTURE_AMAZON_ID, { loja: 'amazon', dia }), recusa(400, MENSAGENS_IMPORTADOR.dia), String(dia));
  }
  for (const vazio of [undefined, null, '']) {
    assert.throws(() => importar(db, FIXTURE_AMAZON_ID, { loja: 'amazon', dia: vazio }), recusa(400, MENSAGENS_IMPORTADOR.semData), String(vazio));
  }
  assert.equal(conta(db, 'comissoes'), 0);
  db.close();
});

test('P5: rota com dia=: válida importa; inválida ou repetida → 400 com frase fixa, nada gravado', async () => {
  const s = await subir();
  try {
    for (const q of ['dia=ontem', 'dia=2026-02-30', 'dia=2026-11-04&dia=2026-11-05', 'dia=2026-11-04%2010:00']) {
      const r = await pedir(s, `/api/ganhos/importar?loja=amazon&${q}`, { method: 'POST', body: FIXTURE_AMAZON_ID });
      assert.deepEqual([r.status, r.json], [400, { erro: MENSAGENS_IMPORTADOR.dia }], q);
    }
    let r = await pedir(s, '/api/ganhos/importar?loja=amazon', { method: 'POST', body: FIXTURE_AMAZON_ID });
    assert.deepEqual([r.status, r.json], [400, { erro: MENSAGENS_IMPORTADOR.semData }]);
    assert.equal(conta(s.db, 'importacoes') + conta(s.db, 'comissoes'), 0);
    r = await pedir(s, '/api/ganhos/importar?loja=amazon&tipo=cliques&dia=2026-11-04', { method: 'POST', body: FIXTURE_AMAZON_ID });
    assert.equal(r.status, 200, r.txt);
    assert.deepEqual([r.json.novas, r.json.cliques_total], [2, 65]);
    assert.ok(r.json.avisos.includes(MENSAGENS_IMPORTADOR.diaUsado));
  } finally { await s.fechar(); }
});

test('P5: Shopee, relatório de cliques com uma linha por clique: cada linha vale 1, somada por dia e Sub_id; data com hora', () => {
  const db = novoDb();
  const r = importar(db, FIXTURE_SHOPEE_CLIQUES, { loja: 'shopee', tipo: 'cliques' });
  assert.deepEqual([r.lidas, r.novas, r.ignoradas, r.cliques_total], [6, 3, 2, 4]);
  assert.deepEqual(r.linhas_ignoradas, [6, 7], 'sem ID do clique e com data inválida');
  assert.deepEqual(linhas(db, 'SELECT dia, codigo, cliques FROM cliques_loja ORDER BY dia, codigo'), [
    { dia: '2026-11-04', codigo: 'g1', cliques: 2 }, { dia: '2026-11-04', codigo: 'g2', cliques: 1 }, { dia: '2026-11-05', codigo: 'g1', cliques: 1 },
  ]);
  assert.deepEqual(r.colunas_usadas.map((c) => c.campo), ['data', 'codigo', 'id_clique']);
  assert.deepEqual(r.colunas_ignoradas, ['Região dos Cliques', 'Referenciador']);
  assert.ok(!JSON.stringify(r).includes('Região Inventada') && !JSON.stringify(r).includes('C0001'));
  // com coluna de contagem, ela vale (não conta linhas)
  const c = importar(db, csv('ID dos Cliques,Período dos Cliques,Sub_id,Cliques', 'C1,2026-11-06 10:00,g1,5'), { loja: 'shopee', tipo: 'cliques' });
  assert.equal(c.cliques_total, 5);
  // relatório de cliques não serve como comissões
  assert.throws(() => importar(db, FIXTURE_SHOPEE_CLIQUES, { loja: 'shopee' }), recusa(400, MENSAGENS_IMPORTADOR.semComissao));
  db.close();
});

test('P5: números com ponto decimal (245.0, 0.0) e "-" valem nos inteiros; "-" no texto é vazio', () => {
  const db = novoDb();
  const c = importar(db, csv('Date,ASIN,Product Title,Items Shipped,Items Returned,Items Shipped Revenue,Total Earnings',
    '10-01-2026,-,-,-,-,-,0.5', '10-02-2026,B0TESTE001,Fone inventado,3.0,1.0,"1,234.50",2.0', '10-03-2026,-,-,-,-,-,-'), { loja: 'amazon', codigo: 'x-20' });
  assert.deepEqual([c.novas, c.ignoradas, c.so_cliques], [2, 0, 1], 'a linha só com "-" vale 0 em tudo: só cliques (R2)');
  assert.deepEqual(negocio(db).map((l) => [l.data, l.produto, l.titulo, l.quantidade, l.venda_centavos, l.comissao_centavos, l.status]), [
    ['2026-10-01', null, null, 0, 0, 50, 'pendente'], ['2026-10-02', 'B0TESTE001', 'Fone inventado', 2, 123450, 200, 'pendente'],
  ]);
  const k = importar(db, csv('Date,Clicks', '10-01-2026,245.0', '10-02-2026,0.0', '10-03-2026,-', '10-04-2026,1.5'), { loja: 'amazon', tipo: 'cliques' });
  assert.deepEqual([k.novas, k.ignoradas, k.cliques_total], [3, 1, 245], '1.5 clique não existe: pulada');
  db.close();
});

// ------------------------------------------------------------------------------------------- Entrega C, etapa 1: avisos de código na prévia

const amzC = (...l) => csv('Date Shipped,ASIN,Ad Fees,Items Shipped', ...l);
const DOIS_IGUAIS = amzC('2026-10-10,B0ABCDEF12,"5,00",1', '2026-10-10,B0ABCDEF12,"5,00",1');
/** Frase de MENSAGENS_IMPORTADOR com singular e plural ([um, vários]) montada para n. */
const frase = ([um, varios], n) => (n === 1 ? um : varios).replace('{n}', String(n));
const contagens = (r) => [r.novas, r.atualizadas, r.repetidas, r.outro_codigo, r.recebem_codigo];

test('Entrega C: frases fixas dos avisos de código (texto do plano), com singular e plural', () => {
  const M = MENSAGENS_IMPORTADOR;
  assert.equal(frase(M.outroCodigoPrevia, 1), '1 linha tem a mesma data e produto de uma venda já importada com outro código (ou sem código). Se for o mesmo relatório importado de novo, não importe: a venda contaria em dobro.');
  assert.equal(frase(M.outroCodigoPrevia, 3), '3 linhas têm a mesma data e produto de vendas já importadas com outro código (ou sem código). Se for o mesmo relatório importado de novo, não importe: as vendas contariam em dobro.');
  assert.equal(frase(M.outroCodigoGravado, 1), '1 linha tem a mesma data e produto de uma venda já importada com outro código (ou sem código). Se era o mesmo relatório, apague esta importação em Importações recentes.');
  assert.equal(frase(M.outroCodigoGravado, 2), '2 linhas têm a mesma data e produto de vendas já importadas com outro código (ou sem código). Se era o mesmo relatório, apague esta importação em Importações recentes.');
  assert.equal(frase(M.recebemCodigoPrevia, 1), '1 linha importada antes sem código vai receber o código deste arquivo. Se era de outro grupo, não importe: apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código.');
  assert.equal(frase(M.recebemCodigoPrevia, 2), '2 linhas importadas antes sem código vão receber o código deste arquivo. Se eram de outro grupo, não importe: apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código.');
  assert.equal(frase(M.recebemCodigoGravado, 1), '1 linha importada antes sem código recebeu o código deste arquivo. Se era de outro grupo, apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código.');
  assert.equal(frase(M.recebemCodigoGravado, 2), '2 linhas importadas antes sem código receberam o código deste arquivo. Se eram de outro grupo, apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código.');
});

test('Entrega C (a): sem pedido, o relatório importado com código e depois sem código → outro_codigo 2 com aviso; grava como hoje (4 linhas)', () => {
  const db = novoDb();
  importar(db, DOIS_IGUAIS, { loja: 'amazon', codigo: 'grupoa-20' });
  const p = importar(db, DOIS_IGUAIS, { loja: 'amazon', previa: true });
  assert.deepEqual(contagens(p), [2, 0, 0, 2, 0]);
  assert.ok(p.avisos.includes(frase(MENSAGENS_IMPORTADOR.outroCodigoPrevia, 2)), p.avisos.join(' | '));
  assert.ok(!p.avisos.includes(frase(MENSAGENS_IMPORTADOR.outroCodigoGravado, 2)));
  assert.equal(conta(db, 'comissoes'), 2, 'a prévia não grava');
  const r = importar(db, DOIS_IGUAIS, { loja: 'amazon' });
  assert.deepEqual(contagens(r), contagens(p), 'o resumo bate com a prévia');
  assert.ok(r.avisos.includes(frase(MENSAGENS_IMPORTADOR.outroCodigoGravado, 2)), r.avisos.join(' | '));
  assert.ok(!r.avisos.includes(frase(MENSAGENS_IMPORTADOR.outroCodigoPrevia, 2)));
  assert.equal(conta(db, 'comissoes'), 4, 'o aviso não bloqueia nem muda o que é gravado');
  assert.deepEqual(linhas(db, 'SELECT codigo, COUNT(*) AS n FROM comissoes GROUP BY codigo ORDER BY codigo'), [{ codigo: null, n: 2 }, { codigo: 'grupoa-20', n: 2 }]);
  db.close();
});

test('Entrega C (b): arquivo do grupo A sem código, depois o do grupo B com código → recebem_codigo 1 com aviso, outro_codigo 0; grava como hoje', () => {
  const db = novoDb();
  importar(db, amzC('2026-10-10,B0ABCDEF12,"5,00",1'), { loja: 'amazon' });
  const p = importar(db, amzC('2026-10-10,B0ABCDEF12,"7,00",1'), { loja: 'amazon', codigo: 'grupob-20', previa: true });
  assert.deepEqual(contagens(p), [0, 1, 0, 0, 1]);
  assert.ok(p.avisos.includes(frase(MENSAGENS_IMPORTADOR.recebemCodigoPrevia, 1)), p.avisos.join(' | '));
  const r = importar(db, amzC('2026-10-10,B0ABCDEF12,"7,00",1'), { loja: 'amazon', codigo: 'grupob-20' });
  assert.deepEqual(contagens(r), contagens(p));
  assert.ok(r.avisos.includes(frase(MENSAGENS_IMPORTADOR.recebemCodigoGravado, 1)), r.avisos.join(' | '));
  assert.deepEqual(linhas(db, 'SELECT codigo, comissao_centavos FROM comissoes'), [{ codigo: 'grupob-20', comissao_centavos: 700 }], 'R4 como hoje');
  // a linha do banco que vai receber o código não conta também como "outro código" para a linha seguinte
  const db2 = novoDb();
  importar(db2, amzC('2026-10-10,B0ABCDEF12,"5,00",1'), { loja: 'amazon' });
  const q = importar(db2, DOIS_IGUAIS, { loja: 'amazon', codigo: 'grupob-20', previa: true });
  assert.deepEqual(contagens(q), [1, 1, 0, 0, 1]);
  db.close(); db2.close();
});

test('Entrega C (c): sem falso alarme (mesmo código, com pedido, outro dia ou produto, Amazon em outra caixa) → 0 e 0, sem frase', () => {
  const semAviso = (r, caso) => {
    assert.deepEqual([r.outro_codigo, r.recebem_codigo], [0, 0], caso);
    const M = MENSAGENS_IMPORTADOR;
    const todas = [M.outroCodigoPrevia, M.outroCodigoGravado, M.recebemCodigoPrevia, M.recebemCodigoGravado].flat().map((f) => f.split('{n}').pop());
    assert.ok(!r.avisos.some((a) => todas.some((f) => a.endsWith(f))), `${caso}: ${r.avisos.join(' | ')}`);
  };
  let db = novoDb();
  importar(db, DOIS_IGUAIS, { loja: 'amazon', codigo: 'grupoa-20' });
  semAviso(importar(db, DOIS_IGUAIS, { loja: 'amazon', codigo: 'grupoa-20', previa: true }), 'reimportar com o mesmo código');
  semAviso(importar(db, amzC('2026-10-11,B0ABCDEF12,"5,00",1', '2026-10-10,B0ZZZZZZZZ,"5,00",1'), { loja: 'amazon', previa: true }), 'outro dia ou outro produto');
  db.close();
  db = novoDb();
  const comPedido = (pedido) => csv('Order ID,Date Shipped,ASIN,Ad Fees', `${pedido},2026-10-10,B0ABCDEF12,"5,00"`);
  importar(db, comPedido('111'), { loja: 'amazon', codigo: 'grupoa-20' });
  semAviso(importar(db, comPedido('111'), { loja: 'amazon', previa: true }), 'com pedido, sem código');
  const outroPedido = importar(db, comPedido('222'), { loja: 'amazon', previa: true });
  assert.equal(outroPedido.novas, 1);
  semAviso(outroPedido, 'com pedido, outro pedido no mesmo dia e produto');
  db.close();
  db = novoDb();
  importar(db, amzC('2026-10-10,B0ABCDEF12,"5,00",1'), { loja: 'amazon', codigo: 'GrupoA-20' });
  semAviso(importar(db, amzC('2026-10-10,B0ABCDEF12,"6,00",1'), { loja: 'amazon', codigo: 'grupoa-20', previa: true }), 'Amazon: GrupoA-20 e grupoa-20 (R14)');
  // sem produto nem título (relatório por ID de rastreamento) não dá para dizer "mesmo produto"
  importar(db, FIXTURE_AMAZON_ID, { loja: 'amazon', dia: '2026-11-04' });
  semAviso(importar(db, csv('Número de rastreamento,ganhos totais', 'grupoc-20,1.0'), { loja: 'amazon', dia: '2026-11-04', previa: true }), 'sem produto');
  db.close();
});

test('Entrega C (d) e (e): cada linha do banco conta uma vez só; R11 (A com código, B com outro) conta 1, só aviso', () => {
  let db = novoDb();
  importar(db, csv('Data,ID do item,Comissão', '2026-10-10,MLB123,"3,00"'), { loja: 'mercadolivre', codigo: 'a' });
  const tres = csv('Data,ID do item,Comissão', '2026-10-10,MLB123,"3,00"', '2026-10-10,MLB123,"3,00"', '2026-10-10,MLB123,"3,00"');
  const r = importar(db, tres, { loja: 'mercadolivre', codigo: 'b' });
  assert.deepEqual(contagens(r), [3, 0, 0, 1, 0]);
  assert.ok(r.avisos.includes(frase(MENSAGENS_IMPORTADOR.outroCodigoGravado, 1)), r.avisos.join(' | '));
  assert.equal(conta(db, 'comissoes'), 4);
  db.close();
  // R11 legítimo (dois grupos vendem o mesmo produto no mesmo dia) também avisa: é ambíguo, por isso não bloqueia
  db = novoDb();
  importar(db, amzC('2026-10-10,B0ABCDEF12,"5,00",1'), { loja: 'amazon', codigo: 'grupoa-20' });
  const b = importar(db, amzC('2026-10-10,B0ABCDEF12,"7,00",1'), { loja: 'amazon', codigo: 'grupob-20' });
  assert.deepEqual(contagens(b), [1, 0, 0, 1, 0]);
  assert.equal(conta(db, 'comissoes'), 2);
  db.close();
});

test('Entrega C (f) e (g): cliques não têm os avisos (null); nenhuma frase traz valor do arquivo nem o código do parâmetro', () => {
  const db = novoDb();
  const k = importar(db, cliquesShopee(), { loja: 'shopee', tipo: 'cliques', codigo: 'segredo1', previa: true });
  assert.deepEqual([k.outro_codigo, k.recebem_codigo], [null, null]);
  const dados = amzC('2026-10-10,B0ABCDEF12,"5,55",1', '2026-10-10,B0ABCDEF12,"5,55",1');
  importar(db, dados, { loja: 'amazon' });
  importar(db, dados, { loja: 'amazon', codigo: 'segredo1' });
  const r = importar(db, amzC('2026-10-10,B0ABCDEF12,"5,55",1', '2026-10-10,B0ABCDEF12,"5,55",1', '2026-10-10,B0ABCDEF12,"5,55",1'), { loja: 'amazon', codigo: 'segredo2' });
  assert.ok(r.outro_codigo > 0, 'o caso tem aviso');
  const texto = r.avisos.join(' ');
  for (const eco of ['segredo', 'B0ABCDEF12', '2026-10-10', '5,55', 'amazon']) assert.ok(!texto.includes(eco), `${eco} em: ${texto}`);
  const M = MENSAGENS_IMPORTADOR;
  for (const f of [M.outroCodigoPrevia, M.outroCodigoGravado, M.recebemCodigoPrevia, M.recebemCodigoGravado].flat()) {
    assert.equal(f.replace('{n}', '').includes('{'), false, 'só o {n} é trocado');
  }
  db.close();
});

// ------------------------------------------------------------------------------------------- rodada 2 da Entrega C: R1, R2, S1

test('R1: "Horário do pedido" (Shopee) é a coluna de data: cada linha fica no seu dia, sem pedir a data do relatório', () => {
  const db = novoDb();
  assert.ok(COLUNAS.data.includes('horario do pedido'));
  const arq = csv('ID do pedido,Horário do pedido,ID da loja,ID do item,Comissão total do item(R$),Sub_id1',
    'P1,2026-11-04 10:00:00,1,2,"3,00",casa', 'P2,2026-11-05 11:00:00,1,3,"4,00",casa');
  const r = importar(db, arq, { loja: 'shopee' });
  assert.deepEqual([r.lidas, r.novas, r.ignoradas], [2, 2, 0]);
  assert.deepEqual(r.periodo, { de: '2026-11-04', ate: '2026-11-05' });
  assert.deepEqual(r.colunas_usadas[0], { campo: 'data', coluna: 'Horário do pedido' });
  db.close();
});

test('R1: coluna com cara de data que o painel não reconhece → 400 com frase própria e fixa, mesmo com a data do relatório (nunca tudo num dia só)', () => {
  const db = novoDb();
  const M = MENSAGENS_IMPORTADOR;
  assert.equal(M.dataDesconhecida, 'Não reconheci a coluna de data deste relatório. O portal pode ter mudado o formato. Mande o arquivo de exemplo para a equipe ajustar.');
  assert.notEqual(M.dataDesconhecida, M.semData);
  for (const col of ['Data de pagamento', 'Order Timestamp', 'Horário da compra', 'Período', 'Dia da venda', 'Purchase Date (UTC)', 'Hora']) {
    const com = csv(`ID do pedido,${col},Comissão`, 'P1,2026-11-04 10:00,"3,00"', 'P2,2026-11-05 10:00,"4,00"');
    const cli = csv(`${col},Sub_id1,Cliques`, '2026-11-04 10:00,g1,3', '2026-11-05 10:00,g1,4');
    for (const dia of [undefined, '2026-11-01']) {
      assert.throws(() => importar(db, com, { loja: 'shopee', dia }), recusa(400, M.dataDesconhecida), `${col}, dia ${dia}`);
      assert.throws(() => importar(db, cli, { loja: 'shopee', tipo: 'cliques', dia }), recusa(400, M.dataDesconhecida), `cliques: ${col}, dia ${dia}`);
    }
    assert.ok(!M.dataDesconhecida.includes(col), 'sem eco do nome da coluna');
  }
  assert.equal(conta(db, 'comissoes') + conta(db, 'cliques_loja') + conta(db, 'importacoes'), 0, 'nada gravado');
  // sem nenhuma coluna com cara de data, a frase segue a de pedir a data do relatório (o painel mostra o campo por ela)
  assert.throws(() => importar(db, FIXTURE_AMAZON_ID, { loja: 'amazon' }), recusa(400, M.semData));
  assert.throws(() => importar(db, csv('Produto,Comissão,Status', 'Fone,"3,00",Pago'), { loja: 'shopee' }), recusa(400, M.semData));
  db.close();
});

// "Produto relacionado" da Amazon com linhas só de cliques: o produto com cliques e sem venda e a "Other".
// (data, título, ASIN, cliques, enviados, receita, ganho)
const lpCliques = (data, titulo, asin, cliques, enviados, receita, ganho) => [data, '-', titulo, asin, cliques, '0.0', '0.0', '0.0',
  '0', '0.0', '0', '0', '-', receita, enviados, '0.0', receita, ganho, '0.0', '0.0', ganho].join(',');
const LP_A = csv(CAB_AMAZON_PRODUTO,
  lpCliques('11-04-2026', 'Panela inventada', 'B0TESTE001', '8.0', '0.0', '0.0', '0'),
  lpCliques('11-04-2026', '-', 'Other', '12.0', '0.0', '0.0', '0'),
  lpCliques('11-04-2026', 'Livro inventado', 'B0TESTE002', '5.0', '1.0', '60.0', '2.7'));
const LP_B = csv(CAB_AMAZON_PRODUTO,
  lpCliques('11-04-2026', 'Panela inventada', 'B0TESTE001', '3.0', '0.0', '0.0', '0'),
  lpCliques('11-04-2026', '-', 'Other', '4.0', '0.0', '0.0', '0'),
  lpCliques('11-04-2026', 'Fone inventado', 'B0TESTE003', '2.0', '1.0', '50.0', '2.5'));
const zeradas = (db) => db.prepare('SELECT COUNT(*) AS n FROM comissoes WHERE comissao_centavos = 0 AND venda_centavos = 0 AND quantidade = 0').get().n;

test('R2: em comissões, a linha só de cliques (comissão, venda e quantidade 0) não é gravada; conta em so_cliques e num aviso, não em puladas', () => {
  const M = MENSAGENS_IMPORTADOR;
  assert.equal(frase(M.soCliques, 1), '1 linha só tem cliques (sem venda nem comissão) e ficou de fora. Os cliques entram ao importar o arquivo como cliques.');
  assert.equal(frase(M.soCliques, 2), '2 linhas só têm cliques (sem venda nem comissão) e ficaram de fora. Os cliques entram ao importar o arquivo como cliques.');
  const db = novoDb();
  const p = importar(db, LP_A, { loja: 'amazon', codigo: 'grupoa-20', previa: true });
  const a = importar(db, LP_A, { loja: 'amazon', codigo: 'grupoa-20' });
  for (const r of [p, a]) {
    assert.deepEqual([r.lidas, r.novas, r.atualizadas, r.repetidas, r.ignoradas, r.so_cliques], [3, 1, 0, 0, 0, 2]);
    assert.deepEqual(r.linhas_ignoradas, []);
    assert.ok(r.avisos.includes(frase(M.soCliques, 2)), r.avisos.join(' | '));
    assert.ok(!r.avisos.some((x) => /pulada/.test(x)), 'não cai em "puladas por valor inválido"');
    assert.deepEqual(r.periodo, { de: '2026-11-04', ate: '2026-11-04' });
  }
  assert.deepEqual(negocio(db), [
    { loja: 'amazon', data: '2026-11-04', codigo: 'grupoa-20', produto: 'B0TESTE002', titulo: 'Livro inventado', quantidade: 1, venda_centavos: 6000, comissao_centavos: 270, status: 'pendente' },
  ]);
  // no histórico, a linha só de cliques não vira "repetida" (lidas − novas − atualizadas − puladas)
  const [h] = listarImportacoes(db);
  assert.deepEqual([h.lidas, h.novas, h.repetidas, h.ignoradas, h.linhas], [3, 1, 0, 2, 1]);
  // reimportar o mesmo arquivo: a venda é repetida, as só de cliques seguem de fora
  const de0 = importar(db, LP_A, { loja: 'amazon', codigo: 'grupoa-20' });
  assert.deepEqual([de0.novas, de0.repetidas, de0.so_cliques], [0, 1, 2]);
  // o arquivo do grupo B (outro Código do arquivo), com o mesmo produto só de cliques no mesmo dia: sem outro_codigo falso
  const pb = importar(db, LP_B, { loja: 'amazon', codigo: 'grupob-20', previa: true });
  const b = importar(db, LP_B, { loja: 'amazon', codigo: 'grupob-20' });
  for (const r of [pb, b]) assert.deepEqual([r.novas, r.so_cliques, r.outro_codigo, r.recebem_codigo], [1, 2, 0, 0], r.avisos.join(' | '));
  assert.equal(conta(db, 'comissoes'), 2);
  assert.equal(zeradas(db), 0, 'nenhuma oferta de R$ 0 em "Por oferta"');
  // o mesmo arquivo como cliques: as linhas só de cliques valem (so_cliques não se aplica)
  const k = importar(db, LP_A, { loja: 'amazon', tipo: 'cliques', codigo: 'grupoa-20' });
  assert.deepEqual([k.cliques_total, k.so_cliques], [25, null]);
  db.close();
});

test('R2: venda com comissão 0 (ou quantidade sem valor) continua gravada; a linha zerada de antes no banco não gera outro_codigo', () => {
  const db = novoDb();
  const r = importar(db, amzC('2026-10-10,B0ABCDEF12,0,1', '2026-10-11,B0ABCDEF12,0,-'), { loja: 'amazon', previa: true });
  assert.deepEqual([r.novas, r.so_cliques], [1, 1], 'quantidade 1 com comissão 0 é venda; "-" na quantidade vale 0');
  const v = importar(db, csv('Date Shipped,ASIN,Revenue,Ad Fees,Items Shipped', '2026-10-10,B0ABCDEF12,"10,00",0,0'), { loja: 'amazon', previa: true });
  assert.deepEqual([v.novas, v.so_cliques], [1, 0], 'com valor de venda, entra');
  // linha zerada gravada antes desta correção, do grupo A, no mesmo dia e produto da venda do grupo B
  db.prepare(`INSERT INTO comissoes (loja, chave, data, codigo, produto, titulo, quantidade, venda_centavos, comissao_centavos, status,
    importacao_id, atualizado_em) VALUES ('amazon', 'antiga#1', '2026-11-04', 'grupoa-20', 'B0TESTE003', 'Fone inventado', 0, 0, 0, 'pendente', 1, 0)`).run();
  const b = importar(db, LP_B, { loja: 'amazon', codigo: 'grupob-20', previa: true });
  assert.deepEqual([b.novas, b.outro_codigo], [1, 0], b.avisos.join(' | '));
  db.close();
});

test('S1: "Número de rastreamento", "Tracking ID" e "ID de rastreamento" só são o código na Amazon; nas outras lojas a coluna é ignorada', () => {
  const db = novoDb();
  const rastreio = 'BR123456789XX'; // nas outras lojas, pode ser o código de envio dos Correios de um comprador
  for (const col of ['Número de rastreamento', 'Tracking ID', 'ID de rastreamento']) {
    const com = csv(`Data,${col},ID do item,Comissão`, `2026-11-04,${rastreio},MLB123,"3,00"`);
    const cli = csv(`Data,${col},Cliques`, `2026-11-04,${rastreio},5`);
    for (const loja of ['shopee', 'mercadolivre']) {
      const r = importar(db, com, { loja, previa: true });
      assert.ok(r.colunas_ignoradas.includes(col), `${loja}: ${r.colunas_ignoradas.join(', ')}`);
      assert.ok(!r.colunas_usadas.some((c) => c.campo === 'codigo'), `${loja}: ${col} não é o código`);
      assert.deepEqual([r.sem_grupo, r.codigos_desconhecidos], [1, []]);
      const k = importar(db, cli, { loja, tipo: 'cliques', previa: true });
      assert.ok(k.colunas_ignoradas.includes(col), `${loja} (cliques)`);
      for (const x of [r, k]) assert.ok(!JSON.stringify(x).includes(rastreio), `${loja}: o valor da coluna não volta`);
    }
    const a = importar(db, com, { loja: 'amazon', previa: true });
    assert.deepEqual(a.colunas_usadas.find((c) => c.campo === 'codigo'), { campo: 'codigo', coluna: col }, 'na Amazon é o ID de rastreamento');
  }
  importar(db, csv('Data,Número de rastreamento,ID do item,Comissão', `2026-11-04,${rastreio},MLB123,"3,00"`), { loja: 'mercadolivre' });
  importar(db, csv('Data,Número de rastreamento,Cliques', `2026-11-04,${rastreio},5`), { loja: 'shopee', tipo: 'cliques' });
  assert.deepEqual(linhas(db, 'SELECT loja, codigo FROM comissoes'), [{ loja: 'mercadolivre', codigo: null }]);
  assert.deepEqual(linhas(db, 'SELECT loja, codigo FROM cliques_loja'), [{ loja: 'shopee', codigo: '' }]);
  db.close();
});

test('R7/Q1: "Média de cliques" e "Mediana" não têm cara de data (começo de palavra): o relatório sem data entra com o dia informado', () => {
  const r = analisar(csv('Número de rastreamento,cliques,Média de cliques,Mediana,ganhos totais', 'grupoa-20,10,2,1,"3,00"'), { loja: 'amazon', dia: '2026-11-10' });
  assert.equal(r.registros.length, 1);
  assert.equal(r.registros[0].data, '2026-11-10');
  // e uma coluna que é mesmo de data, mas desconhecida, continua barrando o dia
  assert.throws(() => analisar(csv('Número de rastreamento,Data de pagamento,ganhos totais', 'grupoa-20,2026-11-03,"3,00"'), { loja: 'amazon', dia: '2026-11-10' }));
  // nomes colados (camelCase) com date/time no fim também barram
  for (const col of ['OrderDate', 'ClickTime']) assert.throws(() => analisar(csv(`Número de rastreamento,${col},ganhos totais`, 'grupoa-20,x,"3,00"'), { loja: 'amazon', dia: '2026-11-10' }), col);
});
