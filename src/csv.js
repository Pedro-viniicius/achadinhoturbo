// Leitor de CSV do importador de comissões (docs/produto/planos/dashboard-ganhos.md, D7 e etapa 12).
// Recebe os bytes do arquivo enviado pelo painel (nunca gravado em disco) e devolve as linhas como listas de
// células. Aceita aspas (com o separador e quebra de linha dentro, "" escapado), separador , ; ou tab
// (detectado), BOM, CRLF/LF/CR e as codificações UTF-8, UTF-16 com BOM e windows-1252.
// Também aceita um .zip com um único CSV dentro (P5: o CSV da Amazon vem assim), aberto em memória com o zlib do Node.
// Limites (tamanho, linhas, colunas, célula) e conteúdo conferidos aqui. Toda recusa é um ErroCsv com frase
// fixa de MENSAGENS_CSV: nada do conteúdo do arquivo vai para a mensagem nem para o log.

import zlib from 'node:zlib';

/** Tamanho máximo do arquivo importado, em bytes (5 MB). */
export const MAX_BYTES_ARQUIVO = 5 * 1024 * 1024;
/** Linhas com conteúdo (cabeçalho e título incluídos; linha em branco não conta). */
export const MAX_LINHAS_ARQUIVO = 100_000;
/** Células numa linha. */
export const MAX_COLUNAS_ARQUIVO = 200;
/** Caracteres numa célula, depois de tiradas as aspas. */
export const MAX_CARACTERES_CELULA = 2_000;

const SEPARADORES = [',', ';', '\t'];
/** Linhas olhadas para escolher o separador (o cabeçalho é procurado nas mesmas 20, em src/importador.js). */
const LINHAS_PARA_SEPARADOR = 20;

export const MENSAGENS_CSV = Object.freeze({
  tipo: 'Este arquivo não é um CSV. Baixe o relatório do portal em CSV e tente de novo.',
  binario: 'Este arquivo não é um CSV. Baixe o relatório do portal em CSV e tente de novo.',
  excel: 'Este arquivo é do Excel. Abra no Excel, salve como CSV e tente de novo.',
  zip: 'Este .zip não tem um único arquivo CSV. Extraia o CSV e tente de novo.',
  tamanho: 'O arquivo tem mais de 5 MB. Baixe o relatório de um período menor (um mês por vez).',
  vazio: 'O arquivo está vazio. Confira se o período do relatório tem vendas.',
  linhas: 'O arquivo tem mais de 100.000 linhas. Baixe o relatório de um período menor (um mês por vez).',
  colunas: 'O arquivo tem mais de 200 colunas. Baixe o relatório do portal de novo, sem alterar.',
  celula: 'Uma célula do arquivo passa de 2.000 caracteres. Baixe o relatório do portal de novo, sem alterar.',
  aspas: 'O arquivo tem aspas abertas sem fechar. Baixe o relatório do portal de novo, sem alterar.',
});

const STATUS_CSV = { tipo: 415, excel: 415, zip: 415, tamanho: 413 }; // o resto é 400

/** Recusa do arquivo: `motivo` é a chave de MENSAGENS_CSV; `status` é o HTTP que a rota devolve. */
export class ErroCsv extends Error {
  constructor(motivo) {
    super(MENSAGENS_CSV[motivo]);
    this.name = 'ErroCsv';
    this.motivo = motivo;
    this.status = STATUS_CSV[motivo] ?? 400;
  }
}

// assinatura do cabeçalho local (o XLSX também é um ZIP) ou, no ZIP vazio, a do fim
const ehZip = (buf) => buf[0] === 0x50 && buf[1] === 0x4b && ((buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06));
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_FIM = 0x06054b50;
const ZIP_FIM_TAMANHO = 22;
const ZIP_CIFRADO = 0x0001 | 0x0040; // cifragem tradicional e forte (flags do cabeçalho)

/** Posição do registro de fim do ZIP (procurado de trás para frente, comentário de até 64 KB), ou -1. */
function fimDoZip(buf) {
  const ate = Math.max(0, buf.length - ZIP_FIM_TAMANHO - 0xffff);
  for (let i = buf.length - ZIP_FIM_TAMANHO; i >= ate; i--) {
    if (buf.readUInt32LE(i) === ZIP_FIM && i + ZIP_FIM_TAMANHO + buf.readUInt16LE(i + 20) <= buf.length) return i;
  }
  return -1;
}

/** O primeiro cabeçalho local (no início do arquivo) dá um nome terminado em .csv, fora de xl/? Nome cortado: não. */
function comecaComCsv(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== ZIP_LOCAL) return false;
  const n = buf.readUInt16LE(26);
  if (n === 0 || 30 + n > buf.length) return false;
  const nome = buf.toString('latin1', 30, 30 + n);
  return /\.csv$/i.test(nome) && !nome.startsWith('xl/');
}

/**
 * ZIP → bytes do único CSV dentro dele, sem tocar no disco. Lê o diretório central e aceita só: exatamente uma
 * entrada, com nome terminado em .csv (sem "/", "\" nem ".."), sem cifragem, guardada (0) ou deflate (8), sem
 * ZIP64, com nome, tamanho e CRC batendo. O descompactado passa no máximo MAX_BYTES_ARQUIVO, conferido também
 * durante a descompactação (`maxOutputLength`), contra zip bomb.
 * Recusas: sem fim de ZIP legível (cortado) → 415 'zip' se o primeiro arquivo dentro dele é um .csv, senão 415
 * 'excel' (como antes de aceitar ZIP: .xlsx, planilha ou nome ilegível); entradas de planilha ([Content_Types].xml
 * ou xl/) → 415 'excel'; descompactado grande demais → 413 'tamanho'; o resto → 415 'zip'.
 */
export function extrairCsvDoZip(buf) {
  const fim = fimDoZip(buf);
  if (fim < 0) throw new ErroCsv(comecaComCsv(buf) ? 'zip' : 'excel');
  const recusar = () => new ErroCsv('zip');
  const total = buf.readUInt16LE(fim + 10);
  const tamCentral = buf.readUInt32LE(fim + 12);
  const iniCentral = buf.readUInt32LE(fim + 16);
  // vários discos ou ZIP64 (0xffff/0xffffffff): não é o .zip de um relatório
  if (buf.readUInt16LE(fim + 4) !== 0 || buf.readUInt16LE(fim + 6) !== 0 || buf.readUInt16LE(fim + 8) !== total) throw recusar();
  if (total === 0xffff || iniCentral === 0xffffffff || iniCentral + tamCentral > fim) throw recusar();
  const entradas = [];
  let p = iniCentral;
  for (let i = 0; i < total; i++) {
    if (p + 46 > iniCentral + tamCentral || buf.readUInt32LE(p) !== ZIP_CENTRAL) throw recusar();
    const n = buf.readUInt16LE(p + 28);
    const fimEntrada = p + 46 + n + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (fimEntrada > iniCentral + tamCentral) throw recusar();
    entradas.push({
      flags: buf.readUInt16LE(p + 8), metodo: buf.readUInt16LE(p + 10), crc: buf.readUInt32LE(p + 16),
      comprimido: buf.readUInt32LE(p + 20), tamanho: buf.readUInt32LE(p + 24), local: buf.readUInt32LE(p + 42),
      nomeBytes: buf.subarray(p + 46, p + 46 + n), nome: buf.toString('latin1', p + 46, p + 46 + n),
    });
    p = fimEntrada;
  }
  if (entradas.some((e) => e.nome === '[Content_Types].xml' || e.nome.startsWith('xl/'))) throw new ErroCsv('excel');
  if (entradas.length !== 1) throw recusar();
  const [e] = entradas;
  if (!/\.csv$/i.test(e.nome) || /[/\\]|\.\./.test(e.nome)) throw recusar();
  if (e.flags & ZIP_CIFRADO) throw recusar();
  if (e.metodo !== 0 && e.metodo !== 8) throw recusar();
  if (e.comprimido === 0xffffffff || e.tamanho === 0xffffffff || e.local === 0xffffffff) throw recusar();
  if (e.tamanho > MAX_BYTES_ARQUIVO) throw new ErroCsv('tamanho');
  // cabeçalho local: mesma assinatura, sem cifragem e com o mesmo nome; os tamanhos valem os do diretório central
  const l = e.local;
  if (l + 30 > iniCentral || buf.readUInt32LE(l) !== ZIP_LOCAL || (buf.readUInt16LE(l + 6) & ZIP_CIFRADO)) throw recusar();
  const nl = buf.readUInt16LE(l + 26);
  const inicio = l + 30 + nl + buf.readUInt16LE(l + 28);
  if (inicio + e.comprimido > iniCentral || !buf.subarray(l + 30, l + 30 + nl).equals(e.nomeBytes)) throw recusar();
  const dados = buf.subarray(inicio, inicio + e.comprimido);
  let csv;
  if (e.metodo === 0) csv = dados;
  else {
    try { csv = zlib.inflateRawSync(dados, { maxOutputLength: MAX_BYTES_ARQUIVO }); } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw new ErroCsv('tamanho');
      throw recusar();
    }
  }
  if (csv.length !== e.tamanho || zlib.crc32(csv) !== e.crc) throw recusar();
  return csv;
}

/**
 * Bytes → texto. ZIP: abre o único CSV de dentro (extrairCsvDoZip) e segue com ele; ZIP dentro do ZIP → 'zip'.
 * Ordem: UTF-16 com BOM (LE ou BE) → UTF-8 estrito (BOM tirado) → windows-1252.
 * XLSX (ZIP) → 415 'excel'; byte NUL (fora do UTF-16) ou caractere NUL → 400 'binario'.
 */
export function decodificar(entrada) {
  let buf = entrada;
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new ErroCsv('vazio');
  if (buf.length > MAX_BYTES_ARQUIVO) throw new ErroCsv('tamanho');
  if (ehZip(buf)) {
    buf = extrairCsvDoZip(buf);
    if (buf.length === 0) throw new ErroCsv('vazio');
    if (ehZip(buf)) throw new ErroCsv('zip');
  }
  let codificacao = null;
  if (buf[0] === 0xff && buf[1] === 0xfe) codificacao = 'utf-16le';
  else if (buf[0] === 0xfe && buf[1] === 0xff) codificacao = 'utf-16be';
  let texto;
  if (codificacao) {
    try { texto = new TextDecoder(codificacao, { fatal: true }).decode(buf); } catch { throw new ErroCsv('tipo'); }
  } else {
    if (buf.includes(0)) throw new ErroCsv('binario');
    try {
      texto = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      codificacao = 'utf-8';
    } catch {
      texto = new TextDecoder('windows-1252').decode(buf);
      codificacao = 'windows-1252';
    }
  }
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  if (texto.includes('\u0000')) throw new ErroCsv('binario');
  if (texto.trim() === '') throw new ErroCsv('vazio');
  return { texto, codificacao };
}

/**
 * Separador do arquivo, entre , ; e tab, olhando (fora de aspas) as primeiras 20 linhas com conteúdo. Vence o
 * que aparece o mesmo número de vezes no maior número de linhas (o formato da tabela); empate: o que aparece
 * mais vezes nessas linhas. Assim a vírgula decimal (`1,50`) e um título antes do cabeçalho não decidem.
 * Nenhum separador ou empate total: vírgula.
 */
export function detectarSeparador(texto) {
  const porLinha = []; // [{ ',': n, ';': n, '\t': n }] de cada linha com conteúdo
  let conta = { ',': 0, ';': 0, '\t': 0 };
  let comConteudo = false;
  let aspas = false;
  const fecharLinha = () => {
    if (comConteudo) porLinha.push(conta);
    conta = { ',': 0, ';': 0, '\t': 0 };
    comConteudo = false;
  };
  for (let i = 0; i < texto.length && porLinha.length < LINHAS_PARA_SEPARADOR; i++) {
    const c = texto[i];
    if (!aspas && c === '\n') fecharLinha();
    else if (!aspas && c === '\r') { if (texto[i + 1] !== '\n') fecharLinha(); }
    else {
      comConteudo = true;
      if (c === '"') aspas = !aspas;
      else if (!aspas && c in conta) conta[c]++;
    }
  }
  if (porLinha.length < LINHAS_PARA_SEPARADOR) fecharLinha();
  const nota = (s) => {
    const freq = new Map();
    for (const l of porLinha) if (l[s] > 0) freq.set(l[s], (freq.get(l[s]) || 0) + 1);
    let linhas = 0; let vezes = 0;
    for (const [n, f] of freq) if (f > linhas || (f === linhas && n > vezes)) { linhas = f; vezes = n; }
    return [linhas, vezes];
  };
  let escolhido = ','; let melhor = nota(',');
  for (const s of [';', '\t']) {
    const n = nota(s);
    if (n[0] > melhor[0] || (n[0] === melhor[0] && n[1] > melhor[1])) { escolhido = s; melhor = n; }
  }
  return escolhido;
}

/**
 * Texto → { separador, linhas, numeros }. `linhas` são as linhas com conteúdo (linha em branco é pulada);
 * `numeros[i]` é o número (a partir de 1) da linha do arquivo onde a linha `i` começa, para o importador dizer
 * quais linhas pulou sem mostrar o conteúdo delas. Recusa (ErroCsv) linhas, colunas e célula acima do limite e
 * aspas sem fechar.
 */
export function parsear(texto, { separador } = {}) {
  const sep = SEPARADORES.includes(separador) ? separador : detectarSeparador(texto);
  const linhas = [];
  const numeros = [];
  let linhaFisica = 1;
  let inicioDaLinha = 1;
  let linha = [];
  let celula = '';
  let entreAspas = false; // dentro de uma célula aberta com aspas
  let teveAspas = false;  // a célula atual começou com aspas (célula "" não é linha em branco)
  const n = texto.length;

  const fecharCelula = () => {
    if (linha.length >= MAX_COLUNAS_ARQUIVO) throw new ErroCsv('colunas');
    linha.push(celula);
    celula = '';
  };
  const fecharLinha = () => {
    const emBranco = linha.length === 0 && celula === '' && !teveAspas;
    if (!emBranco) {
      fecharCelula();
      if (linhas.length >= MAX_LINHAS_ARQUIVO) throw new ErroCsv('linhas');
      linhas.push(linha);
      numeros.push(inicioDaLinha);
    }
    linha = [];
    celula = '';
    teveAspas = false;
  };
  const crescer = (pedaco) => {
    if (celula.length + pedaco.length > MAX_CARACTERES_CELULA) throw new ErroCsv('celula');
    celula += pedaco;
  };

  let i = 0;
  while (i < n) {
    const c = texto[i];
    if (entreAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { crescer('"'); i += 2; continue; }
        entreAspas = false; i++; continue;
      }
      if (c === '\n' || (c === '\r' && texto[i + 1] !== '\n')) linhaFisica++;
      crescer(c); i++; continue;
    }
    if (c === '"' && celula === '' && !teveAspas) { entreAspas = true; teveAspas = true; i++; continue; }
    if (c === sep) { fecharCelula(); teveAspas = false; i++; continue; }
    if (c === '\r' || c === '\n') {
      fecharLinha();
      i += c === '\r' && texto[i + 1] === '\n' ? 2 : 1;
      linhaFisica++;
      inicioDaLinha = linhaFisica;
      continue;
    }
    // resto da célula até o separador ou a quebra, numa fatia só (rápido em arquivo grande);
    // aspas no meio de célula sem aspas (ou depois de fechar as aspas) valem como caractere
    let j = i + 1;
    while (j < n) {
      const d = texto[j];
      if (d === sep || d === '\r' || d === '\n') break;
      j++;
    }
    crescer(texto.slice(i, j));
    i = j;
  }
  if (entreAspas) throw new ErroCsv('aspas');
  fecharLinha();
  return { separador: sep, linhas, numeros };
}

/** Bytes do arquivo → { codificacao, separador, linhas, numeros }. Toda recusa é ErroCsv. */
export function lerCsv(buf, opcoes = {}) {
  const { texto, codificacao } = decodificar(buf);
  return { codificacao, ...parsear(texto, opcoes) };
}
