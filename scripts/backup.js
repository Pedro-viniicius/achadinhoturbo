// Backup do Disparador ML.
//   node scripts/backup.js [pasta-destino]                       cria disparador-<data>.tar.gz e mantém os 7 mais recentes
//   node scripts/backup.js restaurar <arquivo.tar.gz> <pasta>    extrai numa pasta nova (fora do programa) e roda PRAGMA integrity_check
//   node scripts/backup.js auto                                  (timer) backup local + cópia cifrada (gpg) no Drive (rclone)
//   node scripts/backup.js restaurar-drive <pasta-nova> [arquivo] baixa do Drive (a mais recente sem arquivo), decifra e restaura
// O banco é copiado com VACUUM INTO (seguro com o programa rodando e com o WAL ativo).
// ATENÇÃO: o pacote inclui data/wa_auth, a sessão do seu WhatsApp. Guarde com o mesmo cuidado de uma senha.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, ROOT } from '../src/config.js';

export const MANTER_LOCAL = 7;
export const MANTER_DRIVE = 14;
export const REMOTO_PADRAO = 'gdrive:Achadinho Turbo - Backups';
export const CHAVE_PADRAO = path.join(os.homedir(), '.config/achadinhoturbo/backup.chave');
/** Nome do arquivo de estado dentro da pasta de dados (o agendador lê o mesmo arquivo). */
export const ARQUIVO_ESTADO = 'backup-estado.json';
/** Único formato de nome que o Drive recebe, lista e apaga. */
export const RE_PACOTE_DRIVE = /^disparador-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.tar\.gz\.gpg$/;
/** Esperas entre as 3 tentativas de envio (2 e 10 min). */
export const ESPERAS_ENVIO = [2 * 60_000, 10 * 60_000];
/**
 * Remoto do rclone no formato `nome:pasta` (o instalador usa o mesmo). Nunca começa com `-` (não vira opção do rclone).
 * O nome não tem espaço; a pasta aceita espaço simples entre palavras (`gdrive:Achadinho Turbo - Backups`), mas não no
 * começo ou no fim do caminho, nem colado numa `/` (pasta do Drive com espaço na ponta do nome), nem dois seguidos.
 */
export const RE_REMOTO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*:(?!.* \/|.*\/ )(?:[A-Za-z0-9_./-]+(?: [A-Za-z0-9_./-]+)*)?$/;
export const remotoValido = (r) => typeof r === 'string' && !r.startsWith('-') && RE_REMOTO.test(r);

/**
 * Pastas temporárias em uso (podem ter o banco e a sessão do WhatsApp em texto puro). O CLI `auto` apaga o que estiver
 * aqui se receber SIGTERM/SIGINT no meio (o `finally` não roda quando o processo é encerrado por sinal).
 */
const TEMPORARIOS = new Set();
function criarTemporario(prefixo) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  TEMPORARIOS.add(p);
  fs.chmodSync(p, 0o700);
  return p;
}
function apagarTemporario(p) {
  if (!p) return;
  fs.rmSync(p, { recursive: true, force: true });
  TEMPORARIOS.delete(p);
}
/** Apaga todas as pastas temporárias ainda registradas (usado pelo tratamento de sinal do CLI). */
export function apagarTemporarios() {
  for (const p of [...TEMPORARIOS]) { try { apagarTemporario(p); } catch { /* segue para a próxima */ } }
}

// O stderr do tar é descartado: os nomes dos arquivos do wa_auth trazem o telefone. A mensagem é fixa.
function tar(args, falha) {
  try { execFileSync('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch { throw new Error(falha); }
}

export function fazerBackup(dataDir, destDir, manter = MANTER_LOCAL) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const tmp = criarTemporario('disparador-backup-');
  try {
    const dbPath = path.join(dataDir, 'disparador.db');
    if (!fs.existsSync(dbPath)) throw new Error(`banco não encontrado em ${dbPath}`);
    const db = new DatabaseSync(dbPath);
    try { db.exec(`VACUUM INTO '${path.join(tmp, 'disparador.db').replace(/'/g, "''")}'`); } finally { db.close(); }
    const wa = path.join(dataDir, 'wa_auth');
    if (fs.existsSync(wa)) fs.cpSync(wa, path.join(tmp, 'wa_auth'), { recursive: true });
    const out = path.join(destDir, `disparador-${stamp}.tar.gz`);
    tar(['-czf', out, '-C', tmp, '.'], 'o tar não conseguiu empacotar o backup');
    fs.chmodSync(out, 0o600);
    const todos = fs.readdirSync(destDir).filter((f) => /^disparador-.*\.tar\.gz$/.test(f)).sort();
    for (const f of todos.slice(0, Math.max(0, todos.length - manter))) fs.rmSync(path.join(destDir, f));
    return out;
  } finally { apagarTemporario(tmp); }
}

export function restaurar(arquivo, destDir) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  tar(['-xzf', arquivo, '-C', destDir], 'o tar não conseguiu extrair o pacote');
  const db = new DatabaseSync(path.join(destDir, 'disparador.db'), { readOnly: true });
  try {
    const r = db.prepare('PRAGMA integrity_check').get();
    const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return { integridade: r.integrity_check, regras: n('rules'), etiquetas: n('tags'), waAuth: fs.existsSync(path.join(destDir, 'wa_auth')) };
  } finally { db.close(); }
}

// ---------- backup automático: cópia cifrada no Drive ----------
// O stderr do gpg e do rclone é descartado e as mensagens são fixas por etapa: no journal e no estado só entram o
// motivo e o código de saída (nunca a chave, o caminho do home ou a saída do rclone).

/** Mensagem fixa de cada motivo de falha (vai para o estado, o journal e, pela etapa dos avisos, o Histórico). */
export const MOTIVOS_BACKUP = {
  chave_ausente: 'a chave do backup não existe ou é inválida (rode npm run backup:instalar)',
  chave_aberta: 'a chave do backup está com permissão aberta (a chave precisa ser 600 e a pasta dela, 700)',
  banco: 'não consegui fazer o backup local do banco',
  cifrar: 'o gpg não conseguiu cifrar o pacote',
  verificacao: 'o pacote cifrado não passou na conferência (decifrar e restaurar)',
  envio: 'não consegui enviar a cópia ao Drive depois de 3 tentativas',
  limpeza_drive: 'a cópia foi enviada, mas não consegui apagar as cópias antigas do Drive',
};

export class ErroBackup extends Error {
  constructor(motivo) { super(MOTIVOS_BACKUP[motivo] || motivo); this.name = 'ErroBackup'; this.motivo = motivo; }
}

function exigir(valores) {
  for (const [nome, v] of Object.entries(valores)) if (!v) throw new TypeError(`${nome} é obrigatório`);
}

/**
 * Executor padrão de gpg/rclone: `(args) => { status, stdout }`. O stderr é descartado (pode trazer detalhes da
 * conta ou do arquivo) e nada passa pelo shell. `status: null` quando o programa não existe ou estourou o prazo.
 * Prazo de 10 min por chamada: 3 envios + as esperas (12 min) cabem no `TimeoutStartSec=1h` da unit.
 */
export function comando(bin, { env = process.env, timeout = 10 * 60_000 } = {}) {
  return (args) => {
    const r = spawnSync(bin, args, { env, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    return { status: r.error ? null : r.status, stdout: r.stdout || '' };
  };
}

async function rodar(executor, args) {
  try { return (await executor(args)) || { status: null }; } catch { return { status: null }; }
}

/**
 * Confere a chave do backup e devolve o CAMINHO (nunca o conteúdo). Recusa arquivo ausente, link simbólico, o que não
 * seja arquivo comum, pasta da chave em que grupo/outros podem gravar (`& 0o022`: dariam para trocar o arquivo), chave
 * com permissão para grupo/outros (`& 0o077`) ou com menos de 32 caracteres na 1ª linha (o gpg só lê a 1ª).
 */
export function lerChave(arquivo) {
  exigir({ chaveArquivo: arquivo });
  let st;
  try { st = fs.lstatSync(arquivo); } catch { throw new ErroBackup('chave_ausente'); }
  if (!st.isFile()) throw new ErroBackup('chave_ausente'); // link simbólico, pasta, FIFO…
  let pasta;
  try { pasta = fs.statSync(path.dirname(path.resolve(arquivo))); } catch { throw new ErroBackup('chave_ausente'); }
  if (pasta.mode & 0o022) throw new ErroBackup('chave_aberta');
  if (st.mode & 0o077) throw new ErroBackup('chave_aberta');
  let buf;
  try {
    // O_NOFOLLOW: se o arquivo virou link entre o lstat e a leitura, recusa
    const fd = fs.openSync(arquivo, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { buf = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
  } catch { throw new ErroBackup('chave_ausente'); }
  try {
    const fim = buf.indexOf(0x0a);
    const linha = (fim === -1 ? buf : buf.subarray(0, fim)).toString('utf8').replace(/\r$/, '');
    if (linha.trim().length < 32) throw new ErroBackup('chave_ausente');
  } finally { buf.fill(0); }
  return arquivo;
}

// A chave vai ao gpg só pelo caminho (`--passphrase-file`): nunca em argv nem em env.
const GPG_BASE = ['--batch', '--yes', '--quiet', '--no-symkey-cache', '--pinentry-mode', 'loopback'];

export async function cifrar({ entrada, saida, chaveArquivo, gpg } = {}) {
  exigir({ entrada, saida, chaveArquivo, gpg });
  const r = await rodar(gpg, [...GPG_BASE, '--passphrase-file', chaveArquivo, '--symmetric', '--cipher-algo', 'AES256', '--output', saida, entrada]);
  if (r.status !== 0 || !fs.existsSync(saida)) throw new ErroBackup('cifrar');
  fs.chmodSync(saida, 0o600);
  return saida;
}

/**
 * 1º byte de um pacote OpenPGP "Symmetric-Key Encrypted Session Key" (tag 3): 0x8c–0x8f no formato antigo, 0xc3 no
 * novo. É assim que começa o que o `gpg --symmetric` grava. Um pacote sem cifra (`gpg --store`: literal ou comprimido,
 * 0xa3/0xac/0xcb…) começa diferente e é recusado no envio e na volta.
 */
const ehSkesk = (b) => (b >= 0x8c && b <= 0x8f) || b === 0xc3;
function comecaComSkesk(arquivo) {
  const cab = Buffer.alloc(1);
  let lidos = 0;
  try {
    const fd = fs.openSync(arquivo, 'r');
    try { lidos = fs.readSync(fd, cab, 0, 1, 0); } finally { fs.closeSync(fd); }
  } catch { return false; }
  return lidos === 1 && ehSkesk(cab[0]);
}

const temStatus = (saida, palavra) => new RegExp(`^\\[GNUPG:\\] ${palavra}(?: |$)`, 'm').test(saida);

/**
 * Decifra um pacote do backup. Não basta o gpg sair com 0: um pacote sem cifra (`gpg --store`) "decifra" com 0 sem
 * usar a chave. Exige que o arquivo comece por um SKESK e que o gpg diga, pelo `--status-fd 1`, DECRYPTION_OKAY e
 * GOODMDC (integridade conferida), sem DECRYPTION_FAILED.
 */
export async function decifrar({ entrada, saida, chaveArquivo, gpg } = {}) {
  exigir({ entrada, saida, chaveArquivo, gpg });
  if (!comecaComSkesk(entrada)) throw new ErroBackup('verificacao');
  const r = await rodar(gpg, [...GPG_BASE, '--status-fd', '1', '--passphrase-file', chaveArquivo, '--output', saida, '--decrypt', entrada]);
  const st = String(r.stdout || '');
  const confere = r.status === 0 && temStatus(st, 'DECRYPTION_OKAY') && temStatus(st, 'GOODMDC') && !temStatus(st, 'DECRYPTION_FAILED');
  if (!confere || !fs.existsSync(saida)) throw new ErroBackup('verificacao');
  fs.chmodSync(saida, 0o600);
  return saida;
}

const noRemoto = (remoto, nome) => `${remoto.replace(/\/+$/, '')}/${nome}`;

/**
 * Envia um pacote JÁ CIFRADO ao Drive (`rclone copyto`), com até 3 tentativas. Recusa qualquer outro arquivo: nome
 * fora de `RE_PACOTE_DRIVE` ou conteúdo que não comece por um SKESK (o gzip começa com 1f 8b; o `gpg --store`, sem
 * cifra, com outro pacote OpenPGP).
 */
export async function enviarAoDrive({ arquivo, remoto, rclone, esperar = dormir, esperas = ESPERAS_ENVIO } = {}) {
  exigir({ arquivo, remoto, rclone });
  const nome = path.basename(arquivo);
  if (!RE_PACOTE_DRIVE.test(nome) || !comecaComSkesk(arquivo)) throw new Error('só envio ao Drive pacote cifrado (.tar.gz.gpg)');
  const tentativas = esperas.length + 1;
  for (let i = 0; i < tentativas; i++) {
    const r = await rodar(rclone, ['copyto', arquivo, noRemoto(remoto, nome)]);
    if (r.status === 0) return nome;
    if (i < tentativas - 1) await esperar(esperas[i]);
  }
  throw new ErroBackup('envio');
}

/**
 * Mantém no Drive só as `manter` cópias mais recentes. Só lista e apaga nomes em `RE_PACOTE_DRIVE` (nunca a pasta) e
 * só se o arquivo de hoje aparecer na lista. Devolve quantas cópias ficaram; lança `limpeza_drive` em qualquer falha.
 */
export async function limparDrive({ remoto, rclone, atual, manter = MANTER_DRIVE } = {}) {
  exigir({ remoto, rclone, atual });
  const l = await rodar(rclone, ['lsf', '--files-only', noRemoto(remoto, '')]);
  if (l.status !== 0) throw new ErroBackup('limpeza_drive');
  const nomes = [...new Set(String(l.stdout || '').split('\n').map((x) => x.trim()).filter((x) => RE_PACOTE_DRIVE.test(x)))].sort();
  if (!nomes.includes(atual)) throw Object.assign(new ErroBackup('limpeza_drive'), { copias: nomes.length });
  let restantes = nomes.length; let falhou = false;
  for (const f of nomes.slice(0, Math.max(0, nomes.length - manter))) {
    if (f === atual) continue;
    const r = await rodar(rclone, ['deletefile', noRemoto(remoto, f)]);
    if (r.status === 0) restantes--; else falhou = true;
  }
  if (falhou) throw Object.assign(new ErroBackup('limpeza_drive'), { copias: restantes });
  return restantes;
}

function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }
const quando = (v) => (Number.isFinite(v) ? v : null);

/** Lê o estado anterior; `null` se não existe ou está ilegível. */
export function lerEstado(arquivo) {
  try { const e = JSON.parse(fs.readFileSync(arquivo, 'utf8')); return e && typeof e === 'object' ? e : null; } catch { return null; }
}

/** Grava o estado de forma atômica (arquivo temporário 0600 + rename). */
export function gravarEstado(arquivo, estado) {
  const tmp = `${arquivo}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(estado, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, arquivo);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/** 0 ok; 1 o local falhou (o Drive nem é tentado); 3 local ok e o Drive (ou a conferência) falhou. */
export function codigoSaida(estado) {
  if (!estado?.local?.ok) return 1;
  return estado.drive?.ok === true ? 0 : 3;
}

/**
 * Backup do timer: local (`fazerBackup`) → cifra num mkdtemp 0700 → confere (decifra e `restaurar` com
 * integridade=ok) → envia com 3 tentativas → limpa o Drive além de 14 → grava `<dataDir>/backup-estado.json`.
 * Falha do Drive nunca apaga nem invalida o local. `rclone`, `gpg`, `chaveArquivo` e `remoto` são obrigatórios.
 */
export async function backupAutomatico({ dataDir, destDir, chaveArquivo, remoto, rclone, gpg, esperar = dormir, agora = Date.now } = {}) {
  exigir({ dataDir, destDir, chaveArquivo, remoto, rclone, gpg });
  if (!remotoValido(remoto)) throw new TypeError('remoto inválido: use nome:pasta');
  const arquivoEstado = path.join(dataDir, ARQUIVO_ESTADO);
  const anterior = lerEstado(arquivoEstado);
  const estado = {
    versao: 1,
    tentativa_em: agora(),
    local: { ok: false, em: null, arquivo: null, motivo: null },
    drive: { ok: null, em: null, copias: null, motivo: null },
    ultimo_ok_local: quando(anterior?.ultimo_ok_local),
    ultimo_ok_drive: quando(anterior?.ultimo_ok_drive),
  };
  // A chave é conferida primeiro, mas o local roda mesmo sem ela: só o Drive é recusado.
  let erroChave = null;
  try { lerChave(chaveArquivo); } catch (e) { erroChave = e instanceof ErroBackup ? e.motivo : 'chave_ausente'; }

  let local = null;
  try { local = fazerBackup(dataDir, destDir, MANTER_LOCAL); } catch { /* motivo fixo abaixo */ }
  estado.local.em = agora();
  if (!local) {
    estado.local.motivo = 'banco';
    gravarEstado(arquivoEstado, estado);
    return estado;
  }
  Object.assign(estado.local, { ok: true, arquivo: path.basename(local) });
  estado.ultimo_ok_local = estado.local.em;

  const falhaDrive = (motivo) => Object.assign(estado.drive, { ok: false, em: agora(), motivo });
  if (erroChave) {
    falhaDrive(erroChave);
    gravarEstado(arquivoEstado, estado);
    return estado;
  }
  // etapa em curso: um erro inesperado (fora de ErroBackup) vira o motivo fixo dela
  let etapa = 'cifrar';
  let tmp = null;
  try {
    tmp = criarTemporario('achadinho-backup-auto-');
    const cifrado = path.join(tmp, `${path.basename(local)}.gpg`);
    await cifrar({ entrada: local, saida: cifrado, chaveArquivo, gpg });
    etapa = 'verificacao';
    const claro = path.join(tmp, 'conferencia.tar.gz'); const conferencia = path.join(tmp, 'conferencia');
    let integridade;
    try {
      await decifrar({ entrada: cifrado, saida: claro, chaveArquivo, gpg });
      integridade = restaurar(claro, conferencia).integridade;
    } finally {
      // o texto puro da conferência sai antes do envio (que pode levar 12 min entre as tentativas): fica só o .gpg
      fs.rmSync(claro, { force: true }); fs.rmSync(conferencia, { recursive: true, force: true });
    }
    if (integridade !== 'ok') throw new ErroBackup('verificacao');
    etapa = 'envio';
    const nome = await enviarAoDrive({ arquivo: cifrado, remoto, rclone, esperar });
    Object.assign(estado.drive, { ok: true, em: agora() });
    estado.ultimo_ok_drive = estado.drive.em;
    try { estado.drive.copias = await limparDrive({ remoto, rclone, atual: nome }); } catch (e) {
      estado.drive.motivo = 'limpeza_drive';
      estado.drive.copias = Number.isFinite(e?.copias) ? e.copias : null;
    }
  } catch (e) {
    falhaDrive(e instanceof ErroBackup && e.motivo in MOTIVOS_BACKUP ? e.motivo : etapa);
  } finally { apagarTemporario(tmp); }
  gravarEstado(arquivoEstado, estado);
  return estado;
}

/** Resumo do `auto` para o journal: nome do pacote, número de cópias e motivos fixos. Sem caminho nem chave. */
export function resumoAuto(estado) {
  const linhas = [estado.local.ok ? `Backup local: ok (${estado.local.arquivo})` : `Backup local: falhou: ${MOTIVOS_BACKUP[estado.local.motivo] || 'erro'}`];
  if (estado.drive.ok === true) linhas.push(`Drive: ok${estado.drive.copias == null ? '' : ` (${estado.drive.copias} ${estado.drive.copias === 1 ? 'cópia' : 'cópias'})`}${estado.drive.motivo ? `; aviso: ${MOTIVOS_BACKUP[estado.drive.motivo]}` : ''}`);
  else if (estado.drive.ok === false) linhas.push(`Drive: falhou: ${MOTIVOS_BACKUP[estado.drive.motivo] || 'erro'}`);
  else linhas.push('Drive: não tentado');
  return linhas.join('\n');
}

// ---------- restauração a partir do Drive ----------

/** Mensagem fixa de cada falha do `restaurar-drive` (nunca a saída do rclone/gpg, a chave ou o caminho do home). */
export const MOTIVOS_RESTAURAR = {
  nome_invalido: 'o nome do arquivo não está no padrão disparador-AAAA-MM-DD-HH-MM-SS.tar.gz.gpg',
  chave_restaurar: 'a chave do backup não existe ou é inválida: copie a chave guardada no gerenciador de senhas para '
    + '~/.config/achadinhoturbo/backup.chave (permissão 600). Não rode o instalador: ele criaria uma chave nova, que não abre as cópias antigas',
  listar: 'não consegui listar as cópias do Drive (confira a internet e o acesso do rclone: rclone config reconnect gdrive:)',
  sem_copias: 'não há nenhuma cópia do backup no Drive',
  baixar: 'não consegui baixar a cópia do Drive (confira a internet, o nome do arquivo e o acesso do rclone)',
  decifrar: 'não consegui decifrar a cópia: a chave não é a que cifrou o pacote ou o arquivo está corrompido',
  restaurar: 'a cópia foi decifrada, mas não consegui extrair o pacote nem abrir o banco',
  destino_no_programa: 'a pasta de destino fica dentro da pasta do programa: escolha uma fora dela (ex.: ../achadinho-restaurado)',
  destino_com_conteudo: 'a pasta de destino já existe e não é uma pasta vazia: escolha uma pasta nova',
};

class ErroRestaurar extends ErroBackup {
  constructor(motivo) { super(motivo); this.message = MOTIVOS_RESTAURAR[motivo] || this.message; this.name = 'ErroRestaurar'; }
}

/** Caminho real de `p`, mesmo que ele (ou parte dele) ainda não exista: resolve links no maior trecho que existe. */
function caminhoReal(p) {
  let atual = path.resolve(p); const resto = [];
  for (;;) {
    try { return path.join(fs.realpathSync(atual), ...resto.reverse()); } catch (e) { if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e; }
    const pai = path.dirname(atual);
    if (pai === atual) return path.resolve(p);
    resto.push(path.basename(atual)); atual = pai;
  }
}

/**
 * Confere a pasta de destino da restauração e devolve o caminho absoluto. Recusa pasta dentro de `raiz` (a do programa,
 * também por link simbólico: nunca sobrescreve `data/`) e qualquer coisa que já exista e não seja uma pasta vazia.
 */
export function conferirDestino(pasta, { raiz = ROOT } = {}) {
  exigir({ destDir: pasta });
  const dest = path.resolve(pasta);
  const real = caminhoReal(dest); const raizReal = caminhoReal(raiz);
  if (real === raizReal || real.startsWith(raizReal + path.sep)) throw new ErroRestaurar('destino_no_programa');
  let existe = true;
  try { fs.lstatSync(dest); } catch (e) { if (e?.code === 'ENOENT') existe = false; else throw new ErroRestaurar('destino_com_conteudo'); }
  if (existe) {
    let itens;
    try { itens = fs.readdirSync(dest); } catch { throw new ErroRestaurar('destino_com_conteudo'); } // arquivo ou link quebrado
    if (itens.length) throw new ErroRestaurar('destino_com_conteudo');
  }
  return dest;
}

/**
 * Restaura uma cópia do Drive: confere o destino e a chave → escolhe o pacote (o `arquivo` pedido, que precisa casar
 * com `RE_PACOTE_DRIVE`, ou o mais recente do `lsf --files-only`) → `rclone copyto` num mkdtemp 0700 → `decifrar` →
 * `restaurar` (PRAGMA integrity_check) em `destDir`. O mkdtemp é apagado no fim, com ou sem erro. Falhas viram
 * mensagens fixas (`MOTIVOS_RESTAURAR`). `rclone`, `gpg`, `chaveArquivo`, `remoto` e `destDir` são obrigatórios.
 * Devolve `{ arquivo, integridade, regras, etiquetas, waAuth }`.
 */
export async function restaurarDoDrive({ remoto, chaveArquivo, destDir, arquivo, rclone, gpg, raiz = ROOT } = {}) {
  exigir({ remoto, chaveArquivo, destDir, rclone, gpg });
  if (!remotoValido(remoto)) throw new TypeError('remoto inválido: use nome:pasta');
  if (arquivo != null && !RE_PACOTE_DRIVE.test(String(arquivo))) throw new ErroRestaurar('nome_invalido');
  const dest = conferirDestino(destDir, { raiz });
  const existia = fs.existsSync(dest); // só pode ser uma pasta vazia
  try { lerChave(chaveArquivo); } catch (e) { throw new ErroRestaurar(e?.motivo === 'chave_aberta' ? 'chave_aberta' : 'chave_restaurar'); }
  let nome = arquivo == null ? null : String(arquivo);
  if (!nome) {
    const l = await rodar(rclone, ['lsf', '--files-only', noRemoto(remoto, '')]);
    if (l.status !== 0) throw new ErroRestaurar('listar');
    const nomes = String(l.stdout || '').split('\n').map((x) => x.trim()).filter((x) => RE_PACOTE_DRIVE.test(x)).sort();
    if (!nomes.length) throw new ErroRestaurar('sem_copias');
    nome = nomes.at(-1);
  }
  let tmp = null;
  try {
    tmp = criarTemporario('achadinho-restaurar-drive-');
    const baixado = path.join(tmp, nome);
    const c = await rodar(rclone, ['copyto', noRemoto(remoto, nome), baixado]);
    if (c.status !== 0 || !fs.existsSync(baixado)) throw new ErroRestaurar('baixar');
    let claro;
    try { claro = await decifrar({ entrada: baixado, saida: path.join(tmp, 'pacote.tar.gz'), chaveArquivo, gpg }); } catch { throw new ErroRestaurar('decifrar'); }
    let r;
    try { r = restaurar(claro, dest); } catch {
      // desfaz a extração pela metade: a pasta foi conferida vazia (ou inexistente) logo antes, e assim dá para tentar de novo
      if (existia) for (const f of fs.readdirSync(dest)) fs.rmSync(path.join(dest, f), { recursive: true, force: true });
      else fs.rmSync(dest, { recursive: true, force: true });
      throw new ErroRestaurar('restaurar');
    }
    return { arquivo: nome, ...r };
  } finally { apagarTemporario(tmp); }
}

const USO = [
  'uso:',
  '  npm run backup [pasta-destino]                                backup local (padrão: data/backups), mantém os 7 mais recentes',
  '  npm run backup -- restaurar <arquivo.tar.gz> <pasta-nova>     extrai numa pasta nova, fora do programa, e confere o banco',
  '  npm run backup -- restaurar-drive <pasta-nova> [arquivo.gpg]  baixa a cópia do Drive, decifra e restaura',
  '  npm run backup:instalar                                       liga o backup automático (timer diário + Drive)',
].join('\n');
const ehCli = Boolean(process.argv[1]?.endsWith('backup.js'));
const SUBCOMANDO = ehCli ? process.argv[2] : undefined;

/** BACKUP_REMOTO (ou o padrão) já conferido; `null` (com mensagem fixa e código 1) se o valor não serve. */
function remotoDoAmbiente() {
  const remoto = process.env.BACKUP_REMOTO || REMOTO_PADRAO;
  if (remotoValido(remoto)) return remoto;
  console.error('BACKUP_REMOTO inválido: use o formato nome:pasta (ex.: "gdrive:Achadinho Turbo - Backups"), sem começar por "-".');
  process.exitCode = 1;
  return null;
}

/** `npm run backup -- auto` (o timer): backup local + cópia cifrada no Drive; código 0, 1 ou 3. */
function cliAuto() {
  const remoto = remotoDoAmbiente();
  if (!remoto) return;
  // Encerrado pelo systemd (SIGTERM, prazo da unit) ou por Ctrl+C: o `finally` não roda, então apaga aqui as pastas
  // temporárias (banco e sessão do WhatsApp em texto puro) e sai com 1.
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.once(sinal, () => {
      apagarTemporarios();
      console.error(`Backup automático interrompido (${sinal}): apaguei as pastas temporárias.`);
      process.exit(1);
    });
  }
  backupAutomatico({
    dataDir: DATA_DIR,
    destDir: path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups')),
    chaveArquivo: CHAVE_PADRAO,
    remoto,
    rclone: comando('rclone'),
    gpg: comando('gpg'),
  }).then((estado) => {
    const codigo = codigoSaida(estado);
    (codigo === 0 ? console.log : console.error)(resumoAuto(estado));
    process.exitCode = codigo;
  }, () => {
    // erro fora das etapas (ex.: não deu para gravar o estado): mensagem fixa, sem caminho nem detalhe
    console.error('Falha no backup automático: erro fora das etapas (provavelmente ao gravar o estado do backup).');
    process.exitCode = 1;
  });
}

if (ehCli && SUBCOMANDO === 'instalar') {
  console.error('Para instalar o backup automático, use: npm run backup:instalar');
  process.exitCode = 1;
} else if (ehCli && SUBCOMANDO === 'restaurar-drive') {
  const [, pasta, arquivo] = process.argv.slice(2);
  const remoto = pasta ? remotoDoAmbiente() : null;
  if (!pasta) {
    console.error('uso: npm run backup -- restaurar-drive <pasta-nova> [disparador-AAAA-MM-DD-HH-MM-SS.tar.gz.gpg]');
    process.exitCode = 1;
  } else if (remoto) {
    restaurarDoDrive({
      remoto,
      chaveArquivo: CHAVE_PADRAO,
      destDir: pasta,
      arquivo,
      rclone: comando('rclone'),
      gpg: comando('gpg'),
    }).then((r) => {
      console.log(`Restaurado ${r.arquivo} em ${path.resolve(pasta)}: integridade=${r.integridade}, regras=${r.regras}, etiquetas=${r.etiquetas}, sessão WhatsApp=${r.waAuth ? 'sim' : 'não'}`);
      if (r.integridade !== 'ok') process.exitCode = 2;
    }, (e) => {
      // só mensagens fixas: nada da saída do rclone/gpg, da chave ou de caminhos temporários
      console.error(`Falha na restauração do Drive: ${e instanceof ErroBackup ? e.message : 'erro inesperado'}`);
      process.exitCode = 1;
    });
  }
} else if (ehCli && SUBCOMANDO === 'auto') {
  cliAuto();
} else if (ehCli) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'restaurar') {
      if (!a || !b) throw new Error('uso: backup.js restaurar <arquivo.tar.gz> <pasta-destino>');
      // mesma conferência do restaurar-drive: pasta nova (ou vazia) e fora da pasta do programa (nunca por cima de data/)
      const dest = conferirDestino(b);
      const r = restaurar(path.resolve(a), dest);
      console.log(`Restaurado em ${dest}: integridade=${r.integridade}, regras=${r.regras}, etiquetas=${r.etiquetas}, sessão WhatsApp=${r.waAuth ? 'sim' : 'não'}`);
      if (r.integridade !== 'ok') process.exit(2);
    } else if (cmd && !cmd.includes('/') && !fs.existsSync(cmd)) {
      // erro de digitação (ex.: "restaura"): não cria uma pasta com esse nome nem faz backup nela
      console.error(`"${cmd}" não é um comando nem uma pasta que exista.\n${USO}`);
      process.exit(1);
    } else {
      // padrão: dentro de data/ (que o .gitignore já exclui). Nunca grave backup dentro de um repositório git.
      const dest = path.resolve(cmd || process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
      try {
        const topo = execFileSync('git', ['-C', path.dirname(dest), 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const ignorado = (() => { try { execFileSync('git', ['-C', topo, 'check-ignore', '-q', dest], { stdio: 'ignore' }); return true; } catch { return false; } })();
        if (topo && !ignorado) console.error(`AVISO: ${dest} está dentro do repositório git ${topo} e não está no .gitignore. O backup contém a sessão do WhatsApp e dados pessoais: não faça commit dele.`);
      } catch { /* fora de um repositório git: ok */ }
      const out = fazerBackup(DATA_DIR, dest);
      console.log(`Backup gravado: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
    }
  } catch (e) { console.error('Falha no backup:', e.message); process.exit(1); }
}
