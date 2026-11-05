// Parser de CSV do importador de comissões (docs/produto/planos/dashboard-ganhos.md, etapa 12).
// Só bytes montados aqui, com valores inventados: nenhum arquivo real de portal.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  lerCsv, decodificar, parsear, detectarSeparador, extrairCsvDoZip, ErroCsv, MENSAGENS_CSV,
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

// ------------------------------------------------------------------------------------------- ZIP (P5: o CSV da Amazon vem num .zip)

/**
 * ZIP montado aqui, entrada por entrada: { nome, dados, metodo (8 = deflate, 0 = guardado), flags, e para forjar
 * arquivo quebrado: comprimido, crc, tamanho (o declarado), nomeLocal }.
 */
function zip(entradas) {
  const locais = []; const centrais = []; let offset = 0;
  for (const e of entradas) {
    const nome = Buffer.from(e.nome, 'utf8');
    const nomeLocal = Buffer.from(e.nomeLocal ?? e.nome, 'utf8');
    const dados = Buffer.isBuffer(e.dados) ? e.dados : Buffer.from(e.dados ?? '', 'utf8');
    const metodo = e.metodo ?? 8;
    const comp = e.comprimido ?? (metodo === 8 ? zlib.deflateRawSync(dados) : dados);
    const crc = e.crc ?? zlib.crc32(dados);
    const tamanho = e.tamanho ?? dados.length;
    const flags = e.flags ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(tamanho, 22); local.writeUInt16LE(nomeLocal.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(metodo, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(tamanho, 24);
    central.writeUInt16LE(nome.length, 28); central.writeUInt32LE(offset, 42);
    locais.push(local, nomeLocal, comp); centrais.push(central, nome);
    offset += 30 + nomeLocal.length + comp.length;
  }
  const cd = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(entradas.length, 8); fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(cd.length, 12); fim.writeUInt32LE(offset, 16);
  return Buffer.concat([...locais, cd, fim]);
}
const NOME_AMAZON = '1234-Linked-Product-0f0f0f0f-aaaa-bbbb-cccc-000000000000-CSV.csv';
const CSV_INVENTADO = 'Date,ASIN,Clicks\n11-04-2026,B0TESTE001,3.0\n';

test('ZIP: uma entrada .csv (deflate ou guardada) é aberta em memória e lida como CSV; o nome não importa', () => {
  const esperado = [['Date', 'ASIN', 'Clicks'], ['11-04-2026', 'B0TESTE001', '3.0']];
  for (const metodo of [8, 0]) {
    const r = lerCsv(zip([{ nome: NOME_AMAZON, dados: CSV_INVENTADO, metodo }]));
    assert.deepEqual([r.codificacao, r.separador, r.linhas], ['utf-8', ',', esperado], `método ${metodo}`);
  }
  assert.deepEqual(lerCsv(zip([{ nome: 'RELATORIO.CSV', dados: CSV_INVENTADO }])).linhas, esperado, 'extensão em maiúsculas');
  // o conteúdo segue o caminho normal: BOM, windows-1252 e ; continuam valendo
  const cp1252 = Buffer.from('Comissão;Preço\nação;1\n', 'latin1');
  const r = lerCsv(zip([{ nome: 'x.csv', dados: cp1252 }]));
  assert.deepEqual([r.codificacao, r.separador, r.linhas], ['windows-1252', ';', [['Comissão', 'Preço'], ['ação', '1']]]);
  assert.equal(extrairCsvDoZip(zip([{ nome: 'x.csv', dados: CSV_INVENTADO }])).toString('utf8'), CSV_INVENTADO);
  assert.equal(decodificar(zip([{ nome: 'x.csv', dados: '﻿a,b\n' }])).texto, 'a,b\n', 'BOM tirado do CSV de dentro');
});

test('ZIP compatível com o zip do sistema (python zipfile): a fixture do teste lê igual a um .zip de verdade', () => {
  // bytes que o zipfile do Python 3 gravou para o mesmo CSV (deflate, data fixa), gerados uma vez e fixados aqui
  const doPython = Buffer.from('504b03041400000008000000655daedfeade2d0000002b000000050000007a2e63737673492c49d5710cf6f4d371cec94cce2ee6323' +
    '4d43530d135323032d3713208710d0e71353030d431d633e00200504b010214031400000008000000655daedfeade2d0000002b00000005000000000000000000000' +
    '08001000000007a2e637376504b0506000000000100010033000000500000000000', 'hex');
  assert.deepEqual(lerCsv(doPython).linhas, [['Date', 'ASIN', 'Clicks'], ['11-04-2026', 'B0TESTE001', '3.0']]);
});

test('ZIP: o XLSX (tem [Content_Types].xml e xl/) e um PK quebrado continuam com a frase do Excel (415)', () => {
  const xlsx = zip([{ nome: '[Content_Types].xml', dados: '<Types/>' }, { nome: 'xl/workbook.xml', dados: '<workbook/>' }, { nome: 'xl/worksheets/sheet1.xml', dados: '<x/>' }]);
  assert.throws(() => lerCsv(xlsx), recusa('excel', 415));
  assert.throws(() => lerCsv(zip([{ nome: 'xl/a.csv', dados: CSV_INVENTADO }])), recusa('excel', 415), 'pasta xl/ é de planilha');
  assert.throws(() => lerCsv(zip([{ nome: '[Content_Types].xml', dados: '<Types/>' }])), recusa('excel', 415));
  // só a assinatura, sem o fim do ZIP (diretório central): como antes
  assert.throws(() => lerCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), recusa('excel', 415));
  assert.throws(() => lerCsv(xlsx.subarray(0, xlsx.length - 10)), recusa('excel', 415), 'XLSX cortado no fim');
});

test('R4: ZIP cortado (sem o fim) cujo primeiro arquivo é .csv → frase do .zip; .xlsx, planilha ou nome ilegível → frase do Excel', () => {
  const inteiro = zip([{ nome: 'x.csv', dados: CSV_INVENTADO }]);
  for (const corte of [10, 22, 22 + 46 + 'x.csv'.length]) {
    assert.throws(() => lerCsv(inteiro.subarray(0, inteiro.length - corte)), recusa('zip', 415), `cortado ${corte} bytes antes do fim`);
  }
  assert.throws(() => lerCsv(inteiro.subarray(0, 30 + 'x.csv'.length)), recusa('zip', 415), 'só o cabeçalho local e o nome');
  const amazon = zip([{ nome: NOME_AMAZON.toUpperCase(), dados: CSV_INVENTADO }]);
  assert.throws(() => lerCsv(amazon.subarray(0, amazon.length - 10)), recusa('zip', 415), 'extensão em maiúsculas');
  for (const nome of ['relatorio.xlsx', '[Content_Types].xml', 'xl/workbook.xml', 'xl/a.csv']) {
    const z = zip([{ nome, dados: '<x/>' }]);
    assert.throws(() => lerCsv(z.subarray(0, z.length - 10)), recusa('excel', 415), nome);
  }
  // não dá para ler o nome: só a assinatura (test/seguranca.test.js e test/qa-ganhos-painel.test.js) ou o nome cortado
  assert.throws(() => lerCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04])), recusa('excel', 415), 'só a assinatura');
  assert.throws(() => lerCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), recusa('excel', 415), 'assinatura e versão');
  assert.throws(() => lerCsv(inteiro.subarray(0, 30 + 2)), recusa('excel', 415), 'nome cortado');
});

test('ZIP: outro .zip (nenhum ou mais de um arquivo, outro tipo, pasta, "..", cifrado, outro método, quebrado) → 415 com frase fixa', () => {
  assert.equal(MENSAGENS_CSV.zip, 'Este .zip não tem um único arquivo CSV. Extraia o CSV e tente de novo.');
  const casos = {
    vazio: zip([]),
    dois: zip([{ nome: 'a.csv', dados: CSV_INVENTADO }, { nome: 'b.csv', dados: CSV_INVENTADO }]),
    'csv e outro': zip([{ nome: 'a.csv', dados: CSV_INVENTADO }, { nome: 'leia.txt', dados: 'x' }]),
    txt: zip([{ nome: 'a.txt', dados: CSV_INVENTADO }]),
    pasta: zip([{ nome: 'relatorios/a.csv', dados: CSV_INVENTADO }]),
    'barra invertida': zip([{ nome: 'relatorios\\a.csv', dados: CSV_INVENTADO }]),
    'ponto ponto': zip([{ nome: '..a.csv', dados: CSV_INVENTADO }]),
    'só pasta': zip([{ nome: 'a.csv/', dados: '' }]),
    cifrado: zip([{ nome: 'a.csv', dados: CSV_INVENTADO, flags: 0x0001 }]),
    'cifragem forte': zip([{ nome: 'a.csv', dados: CSV_INVENTADO, flags: 0x0041 }]),
    bzip2: zip([{ nome: 'a.csv', dados: CSV_INVENTADO, metodo: 12, comprimido: Buffer.from('BZh9') }]),
    'deflate quebrado': zip([{ nome: 'a.csv', dados: CSV_INVENTADO, comprimido: Buffer.from([0xff, 0xff, 0xff, 0xff]) }]),
    'crc errado': zip([{ nome: 'a.csv', dados: CSV_INVENTADO, crc: 1 }]),
    'tamanho declarado errado': zip([{ nome: 'a.csv', dados: CSV_INVENTADO, tamanho: 3 }]),
    'guardado com tamanho errado': zip([{ nome: 'a.csv', dados: CSV_INVENTADO, metodo: 0, tamanho: 3 }]),
    'nome local diferente': zip([{ nome: 'a.csv', nomeLocal: 'b.csv', dados: CSV_INVENTADO }]),
    'zip dentro do zip': zip([{ nome: 'a.csv', dados: zip([{ nome: 'b.csv', dados: CSV_INVENTADO }]) }]),
  };
  for (const [caso, buf] of Object.entries(casos)) assert.throws(() => lerCsv(buf), recusa('zip', 415), caso);
  // offset do diretório central apontando para fora do arquivo
  const fora = Buffer.from(zip([{ nome: 'a.csv', dados: CSV_INVENTADO }]));
  fora.writeUInt32LE(0xfffffff0, fora.length - 6);
  assert.throws(() => lerCsv(fora), recusa('zip', 415), 'diretório central fora do arquivo');
  // entrada que diz começar depois do fim
  const local = Buffer.from(zip([{ nome: 'a.csv', dados: CSV_INVENTADO }]));
  local.writeUInt32LE(0x7ffffff0, local.length - 22 - 'a.csv'.length - 46 + 42);
  assert.throws(() => lerCsv(local), recusa('zip', 415), 'cabeçalho local fora do arquivo');
});

test('ZIP: descompactado acima de 5 MB é 413, conferido durante a descompactação (zip bomb, mesmo mentindo o tamanho)', () => {
  const grande = Buffer.alloc(MAX_BYTES_ARQUIVO + 1, 'a');
  const bomba = zip([{ nome: 'a.csv', dados: grande }]);
  assert.ok(bomba.length < 64 * 1024, 'o .zip é pequeno');
  assert.throws(() => lerCsv(bomba), recusa('tamanho', 413));
  assert.throws(() => lerCsv(zip([{ nome: 'a.csv', dados: grande, tamanho: 10 }])), recusa('tamanho', 413), 'tamanho declarado mentindo');
  assert.throws(() => lerCsv(zip([{ nome: 'a.csv', dados: grande, tamanho: 0xffffffff }])), recusa('zip', 415), 'marca do ZIP64: não aceito');
  // 100 MB de zeros também param no limite, sem alocar os 100 MB
  const cem = zip([{ nome: 'a.csv', dados: 'x', comprimido: zlib.deflateRawSync(Buffer.alloc(100 * 1024 * 1024)), tamanho: 1 }]);
  assert.throws(() => lerCsv(cem), recusa('tamanho', 413));
  // exatamente 5 MB passa (o limite é o mesmo do CSV solto)
  const cheio = Buffer.alloc(MAX_BYTES_ARQUIVO, 'x');
  for (let i = 1000; i < cheio.length; i += 1000) cheio[i] = 0x0a;
  assert.equal(extrairCsvDoZip(zip([{ nome: 'a.csv', dados: cheio }])).length, MAX_BYTES_ARQUIVO);
  assert.ok(lerCsv(zip([{ nome: 'a.csv', dados: cheio }])).linhas.length > 5000);
});

test('ZIP: as recusas não ecoam o nome nem o conteúdo da entrada', () => {
  const segredo = 'Maria da Silva 31999998888';
  const casos = [
    zip([{ nome: `${segredo}.txt`, dados: segredo }]),
    zip([{ nome: `${segredo}/a.csv`, dados: segredo }]),
    zip([{ nome: `${segredo}.csv`, dados: segredo }, { nome: 'b.csv', dados: segredo }]),
    zip([{ nome: `${segredo}.csv`, dados: `${segredo}\u0000` }]),
    zip([{ nome: `${segredo}.csv`, dados: segredo, crc: 7 }]),
  ];
  for (const buf of casos) {
    assert.throws(() => lerCsv(buf), (e) => {
      assert.ok(e instanceof ErroCsv, String(e));
      assert.ok(!e.message.includes('Maria') && !e.message.includes('3199'), e.message);
      assert.ok(!JSON.stringify(e).includes('Maria'), 'nem em campo extra do erro');
      return true;
    });
  }
});
