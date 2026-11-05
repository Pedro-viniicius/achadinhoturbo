// Importador de comissões e cliques por CSV (docs/produto/planos/dashboard-ganhos.md, D7 e etapa 14).
// Fixtures PROVISÓRIAS, inline, com cabeçalhos prováveis e valores inventados: quando o dono mandar os exemplos
// dos portais (P5), entra só a linha de cabeçalho com valores inventados. Arquivo real nunca vai ao repositório.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import crypto from 'node:crypto';
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
