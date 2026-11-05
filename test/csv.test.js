// Parser de CSV do importador de comissões (docs/produto/planos/dashboard-ganhos.md, etapa 12).
// Só bytes montados aqui, com valores inventados: nenhum arquivo real de portal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lerCsv, decodificar, parsear, detectarSeparador, ErroCsv, MENSAGENS_CSV,
  MAX_BYTES_ARQUIVO, MAX_LINHAS_ARQUIVO, MAX_COLUNAS_ARQUIVO, MAX_CARACTERES_CELULA,
} from '../src/csv.js';

const utf8 = (s) => Buffer.from(s, 'utf8');
/** O erro é ErroCsv com o motivo, o status HTTP e a frase fixa de MENSAGENS_CSV (sem nada do arquivo). */
const recusa = (motivo, status) => (e) => {
  assert.ok(e instanceof ErroCsv, `esperava ErroCsv, veio ${e?.name}: ${e?.message}`);
  assert.equal(e.motivo, motivo);
  assert.equal(e.status, status);
  assert.equal(e.message, MENSAGENS_CSV[motivo]);
  return true;
};

test('limites exportados com os números do plano (vão para a tabela FATOS dos Docs)', () => {
  assert.equal(MAX_BYTES_ARQUIVO, 5 * 1024 * 1024);
  assert.equal(MAX_LINHAS_ARQUIVO, 100_000);
  assert.equal(MAX_COLUNAS_ARQUIVO, 200);
  assert.equal(MAX_CARACTERES_CELULA, 2_000);
  for (const m of Object.values(MENSAGENS_CSV)) assert.match(m, /^[A-ZÉ].*\.$/, 'frase completa, com ponto');
});

test('aspas: vírgula e quebra de linha dentro da célula; "" vira uma aspa', () => {
  const { linhas } = lerCsv(utf8('titulo,valor\n"Fone, sem fio","10,50"\n"linha 1\nlinha 2",3\n"diz ""oi""",4\n'));
  assert.deepEqual(linhas, [
    ['titulo', 'valor'],
    ['Fone, sem fio', '10,50'],
    ['linha 1\nlinha 2', '3'],
    ['diz "oi"', '4'],
  ]);
});

test('células vazias, aspas no meio de célula sem aspas e linha final sem quebra', () => {
  const { linhas } = lerCsv(utf8('a,b,c\n,,\nx"y,"",z'));
  assert.deepEqual(linhas, [['a', 'b', 'c'], ['', '', ''], ['x"y', '', 'z']]);
});

test('separador: ; e tab detectados; vírgula é o padrão; título antes do cabeçalho não engana', () => {
  assert.equal(detectarSeparador('Data;Comissão;Valor\n01/10/2026;1,50;10,00\n'), ';');
  assert.equal(detectarSeparador('Data\tComissão\n2026-10-01\t1.50\n'), '\t');
  assert.equal(detectarSeparador('Data,Comissão\n2026-10-01,1.50\n'), ',');
  assert.equal(detectarSeparador('só uma coluna\n'), ',');
  // vírgula dentro de aspas não conta
  assert.equal(detectarSeparador('"a,b,c,d";x;y\n"1,2,3,4";5;6\n'), ';');
  // título com vírgula na primeira linha, cabeçalho com ; logo abaixo
  assert.equal(detectarSeparador('Relatório de ganhos, outubro\nData;Pedido;Comissão;Valor\n'), ';');
  assert.deepEqual(lerCsv(utf8('Data;Comissão\n01/10/2026;1,50\n')).linhas, [['Data', 'Comissão'], ['01/10/2026', '1,50']]);
  assert.deepEqual(lerCsv(utf8('Data\tComissão\n2026-10-01\t1.50\n')).linhas, [['Data', 'Comissão'], ['2026-10-01', '1.50']]);
  assert.equal(lerCsv(utf8('a;b\n1;2\n')).separador, ';');
  // separador explícito vence a detecção
  assert.deepEqual(parsear('a;b,c\n', { separador: ',' }).linhas, [['a;b', 'c']]);
});

test('quebras de linha: CRLF, LF e CR sozinho; linhas em branco puladas, com o número da linha original', () => {
  const { linhas, numeros } = lerCsv(utf8('a,b\r\n1,2\r\n\r\n3,4\r5,6\n\n'));
  assert.deepEqual(linhas, [['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']]);
  assert.deepEqual(numeros, [1, 2, 4, 5]);
  // célula entre aspas com quebra: a linha seguinte começa duas linhas depois
  const r = lerCsv(utf8('a,b\n"x\r\ny",1\nz,2\n'));
  assert.deepEqual(r.linhas, [['a', 'b'], ['x\r\ny', '1'], ['z', '2']]);
  assert.deepEqual(r.numeros, [1, 2, 4]);
});

test('codificação: UTF-8 com e sem BOM, windows-1252 (ç), UTF-16LE e UTF-16BE com BOM', () => {
  const esperado = [['Comissão', 'Preço'], ['ação', '1']];
  const texto = 'Comissão,Preço\nação,1\n';
  let r = lerCsv(utf8(texto));
  assert.equal(r.codificacao, 'utf-8'); assert.deepEqual(r.linhas, esperado);
  r = lerCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(texto)]));
  assert.equal(r.codificacao, 'utf-8'); assert.deepEqual(r.linhas, esperado, 'BOM não entra na primeira célula');
  r = lerCsv(Buffer.from(texto, 'latin1')); // ç = 0xE7, ã = 0xE3: não é UTF-8 válido
  assert.equal(r.codificacao, 'windows-1252'); assert.deepEqual(r.linhas, esperado);
  assert.equal(decodificar(Buffer.from([0x80, 0x0a])).texto, '€\n', '0x80 é o euro no windows-1252, não no latin1');
  r = lerCsv(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(texto, 'utf16le')]));
  assert.equal(r.codificacao, 'utf-16le'); assert.deepEqual(r.linhas, esperado);
  const be = Buffer.from(texto, 'utf16le'); be.swap16();
  r = lerCsv(Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  assert.equal(r.codificacao, 'utf-16be'); assert.deepEqual(r.linhas, esperado);
});

test('colunas: 200 passa, 201 é recusado', () => {
  const linha = (n) => Array.from({ length: n }, (_, i) => `c${i}`).join(',');
  assert.equal(lerCsv(utf8(`${linha(200)}\n${linha(200)}\n`)).linhas[1].length, 200);
  assert.throws(() => lerCsv(utf8(`${linha(3)}\n${linha(201)}\n`)), recusa('colunas', 400));
  // um arquivo de vírgulas só para numa linha só: para cedo, sem montar milhões de células
  assert.throws(() => lerCsv(Buffer.alloc(MAX_BYTES_ARQUIVO, ',')), recusa('colunas', 400));
});

test('célula: 2.000 caracteres passa, 2.001 é recusado (com e sem aspas)', () => {
  const ok = 'x'.repeat(MAX_CARACTERES_CELULA);
  assert.equal(lerCsv(utf8(`a,b\n${ok},1\n`)).linhas[1][0].length, MAX_CARACTERES_CELULA);
  assert.equal(lerCsv(utf8(`a,b\n"${ok}",1\n`)).linhas[1][0].length, MAX_CARACTERES_CELULA);
  assert.throws(() => lerCsv(utf8(`a,b\n${ok}x,1\n`)), recusa('celula', 400));
  assert.throws(() => lerCsv(utf8(`a,b\n"${ok}x",1\n`)), recusa('celula', 400));
  // aspas "" contam como um caractere
  assert.equal(lerCsv(utf8(`a\n"${'""'.repeat(MAX_CARACTERES_CELULA)}"\n`)).linhas[1][0].length, MAX_CARACTERES_CELULA);
});

test('linhas: 100.000 passam, 100.001 são recusadas (linha em branco não conta)', () => {
  const corpo = (n) => 'a,b\n' + '1,2\n'.repeat(n - 1);
  assert.equal(lerCsv(utf8(corpo(MAX_LINHAS_ARQUIVO) + '\n\n')).linhas.length, MAX_LINHAS_ARQUIVO);
  assert.throws(() => lerCsv(utf8(corpo(MAX_LINHAS_ARQUIVO + 1))), recusa('linhas', 400));
});

test('tamanho: até 5 MB passa, acima é 413', () => {
  const cheio = Buffer.alloc(MAX_BYTES_ARQUIVO, 'a'); cheio[1000] = 0x0a; // linhas longas demais seriam recusadas antes
  assert.throws(() => lerCsv(Buffer.concat([cheio, Buffer.from('a')])), recusa('tamanho', 413));
  const linhas = Buffer.from('a,b\n' + '1,2\n'.repeat(Math.floor((MAX_BYTES_ARQUIVO - 4) / 4)));
  assert.ok(linhas.length <= MAX_BYTES_ARQUIVO);
  assert.throws(() => lerCsv(linhas), recusa('linhas', 400), 'no limite de bytes o que pega é o de linhas');
});

test('conteúdo: XLSX (PK\\x03\\x04) é 415 com a frase do Excel; byte NUL é 400; vazio é 400', () => {
  assert.throws(() => lerCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), recusa('excel', 415));
  assert.match(MENSAGENS_CSV.excel, /salve como CSV/);
  assert.throws(() => lerCsv(utf8('a,b\n1,\u00002\n')), recusa('binario', 400));
  assert.throws(() => lerCsv(Buffer.from([0x61, 0x2c, 0x00, 0x62])), recusa('binario', 400));
  // UTF-16 com BOM tem bytes 0 nos caracteres ASCII: não é binário, mas NUL decodificado é
  assert.throws(() => lerCsv(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,\u0000b', 'utf16le')])), recusa('binario', 400));
  // UTF-16 com número ímpar de bytes não decodifica
  assert.throws(() => lerCsv(Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x2c])), recusa('tipo', 415));
  for (const vazio of [Buffer.alloc(0), utf8(''), utf8('\n\r\n  \n'), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0xff, 0xfe])]) {
    assert.throws(() => lerCsv(vazio), recusa('vazio', 400));
  }
  assert.throws(() => lerCsv(null), recusa('vazio', 400));
  assert.throws(() => lerCsv('a,b\n'), recusa('vazio', 400), 'só Buffer: texto já decodificado não passa por aqui');
});

test('aspas sem fechar no fim do arquivo → 400', () => {
  assert.throws(() => lerCsv(utf8('a,b\n"aberta,1\n2,3\n')), recusa('aspas', 400));
});

test('mensagens de erro nunca trazem o conteúdo do arquivo', () => {
  const segredo = 'Maria da Silva 31999998888';
  const casos = [
    utf8(`a,b\n${segredo}${'x'.repeat(MAX_CARACTERES_CELULA)},1\n`),
    utf8(`a,b\n"${segredo},1\n`),
    utf8(`${segredo},`.repeat(MAX_COLUNAS_ARQUIVO + 1)),
    utf8(`${segredo}\u0000`),
  ];
  for (const buf of casos) {
    assert.throws(() => lerCsv(buf), (e) => {
      assert.ok(e instanceof ErroCsv);
      assert.ok(!e.message.includes('Maria') && !e.message.includes('3199'), e.message);
      assert.ok(!JSON.stringify(e).includes('Maria'), 'nem em campo extra do erro');
      return true;
    });
  }
});
