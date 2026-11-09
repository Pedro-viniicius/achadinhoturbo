// Backup automático (scripts/backup.js auto): chave, gpg, conferência, envio ao Drive, rotação e estado.
// Restauração pelo Drive (restaurar-drive): escolha do pacote, nome no padrão, destino fora do programa e vazio.
// Nenhum teste chama o Drive nem o rclone de verdade: o rclone é um falso que copia numa pasta temporária.
// O gpg é o de verdade, com GNUPGHOME temporário (pulado sem gpg); o agente dele é encerrado no fim.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import {
  fazerBackup, restaurar, MANTER_LOCAL, MANTER_DRIVE, REMOTO_PADRAO, CHAVE_PADRAO, ARQUIVO_ESTADO, RE_PACOTE_DRIVE,
  ESPERAS_ENVIO, MOTIVOS_BACKUP, lerChave, cifrar, decifrar, enviarAoDrive, limparDrive, backupAutomatico, codigoSaida, resumoAuto, comando,
  MOTIVOS_RESTAURAR, conferirDestino, restaurarDoDrive, RE_REMOTO, remotoValido,
} from '../scripts/backup.js';
import { ROOT } from '../src/config.js';
import { createAvisos, MOTIVOS_BACKUP as FRASES_DO_HISTORICO } from '../src/avisos.js';
import { createScheduler } from '../src/scheduler.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createLinkService } from '../src/links.js';

const SCRIPT = fileURLToPath(new URL('../scripts/backup.js', import.meta.url));
const pastas = [];
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-bk-')); pastas.push(p); return p; };

const temGpg = spawnSync('gpg', ['--version'], { stdio: 'ignore' }).status === 0;
const semGpg = !temGpg && 'gpg não instalado';
const GNUPGHOME = tmp();
fs.chmodSync(GNUPGHOME, 0o700);
const ENV_GPG = { ...process.env, GNUPGHOME };
after(() => {
  if (temGpg) {
    spawnSync('gpgconf', ['--kill', 'gpg-agent'], { env: ENV_GPG, stdio: 'ignore' });
    spawnSync('gpgconf', ['--remove-socketdir'], { env: ENV_GPG, stdio: 'ignore' });
  }
  for (const p of pastas) fs.rmSync(p, { recursive: true, force: true });
});

const REMOTO = 'falso:backups';
/** Pasta com espaço, como a do padrão (`gdrive:Achadinho Turbo - Backups`). */
const REMOTO_ESPACO = 'falso:Achadinho Turbo - Backups';
const AGORA = new Date(2026, 10, 8, 3, 0).getTime();

/** gpg real (GNUPGHOME temporário) que guarda os argumentos de cada chamada. */
function gpgReal({ trocar } = {}) {
  const real = comando('gpg', { env: ENV_GPG });
  const chamadas = [];
  const fn = (args) => { chamadas.push([...args]); return trocar ? trocar(args, real) : real(args); };
  fn.chamadas = chamadas;
  return fn;
}

/**
 * rclone falso: `copyto`, `lsf` e `deletefile` numa pasta local. Guarda os argumentos e o que recebeu. `remoto` é o
 * prefixo que ele espera em cada argumento do lado do Drive (inteiro, num argumento só).
 */
function rcloneFalso(drive, { falhaCopia = false, lancar = false, lsfMostra = () => true, falhaLsf = false, falhaBaixar = false, remoto = REMOTO } = {}) {
  const chamadas = []; const recebidos = [];
  const local = (r) => { assert.ok(r.startsWith(`${remoto}/`), r); return path.join(drive, r.slice(remoto.length + 1)); };
  const fn = (args) => {
    chamadas.push([...args]);
    const [op, ...resto] = args;
    if (op === 'copyto' && resto[0].startsWith(`${remoto}/`)) { // download (restaurar-drive): Drive → pasta local
      if (falhaBaixar || !fs.existsSync(local(resto[0]))) return { status: 3 };
      fs.copyFileSync(local(resto[0]), resto[1]);
      return { status: 0 };
    }
    if (op === 'copyto') {
      if (lancar) throw new Error('rede caiu');
      if (falhaCopia) return { status: 1 };
      recebidos.push({ origem: resto[0], bytes: fs.readFileSync(resto[0]) });
      fs.copyFileSync(resto[0], local(resto[1]));
      return { status: 0 };
    }
    if (op === 'lsf') {
      assert.deepEqual(resto, ['--files-only', `${remoto}/`]);
      if (falhaLsf) return { status: 1 };
      return { status: 0, stdout: fs.readdirSync(drive).filter(lsfMostra).map((f) => `${f}\n`).join('') };
    }
    if (op === 'deletefile') { fs.rmSync(local(resto[0])); return { status: 0 }; }
    return { status: 1 };
  };
  Object.assign(fn, { chamadas, recebidos });
  return fn;
}

function pastaDeDados({ banco = true } = {}) {
  const dir = tmp();
  if (banco) {
    const db = openDb(dir);
    db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run('etq', Date.now());
    db.close();
    fs.mkdirSync(path.join(dir, 'wa_auth'));
    fs.writeFileSync(path.join(dir, 'wa_auth', 'creds.json'), '{"segredo":"sessao"}');
  }
  return dir;
}

function novaChave(modo = 0o600, conteudo = crypto.randomBytes(32).toString('base64')) {
  const dir = tmp(); fs.chmodSync(dir, 0o700);
  const arquivo = path.join(dir, 'backup.chave');
  fs.writeFileSync(arquivo, `${conteudo}\n`, { mode: 0o600 });
  fs.chmodSync(arquivo, modo);
  return { arquivo, conteudo };
}

const lerJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const doDrive = (drive) => fs.readdirSync(drive).filter((f) => RE_PACOTE_DRIVE.test(f)).sort();
const ops = (rclone) => rclone.chamadas.map((a) => a[0]);
/** O que o gpg escreve no `--status-fd 1` quando decifra de verdade (o decifrar exige as duas linhas). */
const STATUS_DECIFROU = '[GNUPG:] DECRYPTION_OKAY\n[GNUPG:] GOODMDC\n';
const semEspera = () => { const feitas = []; const fn = async (ms) => { feitas.push(ms); }; fn.feitas = feitas; return fn; };

function cenario({ chave = novaChave(), banco = true, rclone, gpg, estadoAnterior } = {}) {
  const dataDir = pastaDeDados({ banco });
  const destDir = path.join(dataDir, 'backups');
  const drive = tmp();
  if (estadoAnterior) fs.writeFileSync(path.join(dataDir, ARQUIVO_ESTADO), JSON.stringify(estadoAnterior));
  const r = rclone || rcloneFalso(drive);
  const g = gpg || gpgReal();
  const esperar = semEspera();
  const rodar = () => backupAutomatico({ dataDir, destDir, chaveArquivo: chave.arquivo, remoto: REMOTO, rclone: r, gpg: g, esperar, agora: () => AGORA });
  return { dataDir, destDir, drive, chave, rclone: r, gpg: g, esperar, rodar, estadoArquivo: path.join(dataDir, ARQUIVO_ESTADO) };
}

/** Nada que identifique a chave, o home ou as pastas temporárias pode aparecer no texto. */
function semSegredo(texto, chave, extra = []) {
  assert.ok(!texto.includes(chave.conteudo), 'conteúdo da chave');
  assert.ok(!texto.includes(chave.arquivo), 'caminho da chave');
  assert.ok(!texto.includes(os.homedir()), 'caminho do home');
  for (const x of extra) assert.ok(!texto.includes(x), x);
}

/**
 * rclone falso para os testes do CLI: um executável em node numa pasta que vai na frente do PATH. Copia para a pasta
 * `drive` (envio), de volta dela (download), lista e apaga; grava o argv de cada chamada em `log`.
 */
function rcloneNoPath() {
  const bin = tmp(); const drive = tmp(); const log = path.join(tmp(), 'rclone.log');
  fs.writeFileSync(path.join(bin, 'rclone'), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); fs.appendFileSync(process.env.RCLONE_FALSO_LOG, JSON.stringify(args) + '\\n');
const pre = (process.env.RCLONE_FALSO_REMOTO || 'falso:backups') + '/'; const dir = process.env.RCLONE_FALSO_DIR;
const loc = (x) => { if (!x.startsWith(pre)) process.exit(9); return path.join(dir, x.slice(pre.length)); };
if (args[0] === 'copyto' && args[1].startsWith(pre)) { if (!fs.existsSync(loc(args[1]))) process.exit(3); fs.copyFileSync(loc(args[1]), args[2]); }
else if (args[0] === 'copyto') fs.copyFileSync(args[1], loc(args[2]));
else if (args[0] === 'lsf') process.stdout.write(fs.readdirSync(dir).map((f) => f + '\\n').join(''));
else if (args[0] === 'deletefile') fs.rmSync(loc(args[1]));
else process.exit(1);
`, { mode: 0o700 });
  return { bin, drive, log, chamadas: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

test('backup: constantes do contrato e o fazerBackup mantém MANTER_LOCAL', () => {
  assert.equal(MANTER_LOCAL, 7); assert.equal(MANTER_DRIVE, 14);
  assert.equal(REMOTO_PADRAO, 'gdrive:Achadinho Turbo - Backups');
  assert.equal(CHAVE_PADRAO, path.join(os.homedir(), '.config/achadinhoturbo/backup.chave'));
  assert.equal(ARQUIVO_ESTADO, 'backup-estado.json');
  assert.deepEqual(ESPERAS_ENVIO, [2 * 60_000, 10 * 60_000]);
  assert.deepEqual(Object.keys(MOTIVOS_BACKUP).sort(), ['banco', 'chave_aberta', 'chave_ausente', 'cifrar', 'envio', 'limpeza_drive', 'verificacao']);
  assert.ok(RE_PACOTE_DRIVE.test('disparador-2026-11-08-03-00-00.tar.gz.gpg'));
  for (const ruim of ['disparador-2026-11-08-03-00-00.tar.gz', '../disparador-2026-11-08-03-00-00.tar.gz.gpg', 'x/disparador-2026-11-08-03-00-00.tar.gz.gpg',
    'disparador-velho.tar.gz.gpg', 'disparador-2026-11-08-03-00-00.tar.gz.gpg.bak', 'gdrive:disparador-2026-11-08-03-00-00.tar.gz.gpg']) assert.ok(!RE_PACOTE_DRIVE.test(ruim), ruim);
  const dataDir = pastaDeDados(); const dest = tmp();
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(dest, `disparador-2000-01-0${i}-00-00-00.tar.gz`), '');
  fazerBackup(dataDir, dest);
  assert.equal(fs.readdirSync(dest).length, MANTER_LOCAL);
});

test('lerChave: devolve só o caminho; recusa ausente, permissão aberta, curta e pasta', () => {
  const boa = novaChave();
  assert.equal(lerChave(boa.arquivo), boa.arquivo, 'devolve o caminho, não o conteúdo');
  const motivo = (arquivo) => { try { lerChave(arquivo); return 'aceitou'; } catch (e) { semSegredo(String(e.message), boa); return e.motivo; } };
  assert.equal(motivo(path.join(tmp(), 'nao-existe')), 'chave_ausente');
  assert.equal(motivo(novaChave(0o644).arquivo), 'chave_aberta');
  assert.equal(motivo(novaChave(0o640).arquivo), 'chave_aberta');
  assert.equal(motivo(novaChave(0o604).arquivo), 'chave_aberta');
  assert.equal(motivo(novaChave(0o600, 'curta').arquivo), 'chave_ausente');
  assert.equal(motivo(novaChave(0o600, `${'x'.repeat(10)}\n${'y'.repeat(40)}`).arquivo), 'chave_ausente', 'o gpg só lê a 1ª linha');
  const pasta = tmp(); fs.chmodSync(pasta, 0o700);
  assert.equal(motivo(pasta), 'chave_ausente');
  assert.throws(() => lerChave(), TypeError);
  assert.equal(motivo(novaChave(0o400).arquivo), 'aceitou', '0400 também é só do dono');
});

test('backup automático: só .gpg chega ao rclone, o Drive recebe algo que não é gzip e a cópia decifra e restaura', { skip: semGpg }, async () => {
  const gpg = gpgReal(); const drive = tmp(); const falso = rcloneFalso(drive);
  const decifradosNoEnvio = [];
  const rclone = (args) => { if (args[0] === 'copyto') decifradosNoEnvio.push(gpg.chamadas.filter((a) => a.includes('--decrypt')).length); return falso(args); };
  Object.assign(rclone, { chamadas: falso.chamadas, recebidos: falso.recebidos });
  const c = { ...cenario({ gpg, rclone }), drive };
  const estado = await c.rodar();
  assert.equal(codigoSaida(estado), 0);
  // local de sempre
  const locais = fs.readdirSync(c.destDir);
  assert.equal(locais.length, 1); assert.match(locais[0], /^disparador-.*\.tar\.gz$/);
  const local = path.join(c.destDir, locais[0]);
  assert.deepEqual([...fs.readFileSync(local).subarray(0, 2)], [0x1f, 0x8b], 'o local é gzip');
  // envio
  const copias = c.rclone.chamadas.filter((a) => a[0] === 'copyto');
  assert.equal(copias.length, 1);
  for (const [, origem, destino] of copias) {
    assert.ok(origem.endsWith('.gpg') && RE_PACOTE_DRIVE.test(path.basename(origem)), origem);
    assert.equal(destino, `${REMOTO}/${locais[0]}.gpg`);
  }
  for (const { bytes } of c.rclone.recebidos) assert.notDeepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b], 'o Drive não recebe gzip');
  assert.deepEqual(doDrive(c.drive), [`${locais[0]}.gpg`]);
  const noDrive = fs.readFileSync(path.join(c.drive, `${locais[0]}.gpg`));
  assert.ok(!noDrive.includes(Buffer.from('SQLite format 3')) && !noDrive.includes(Buffer.from('sessao')), 'nada em texto puro');
  // a cópia do Drive abre com a chave e passa no restaurar
  const pasta = tmp();
  const claro = await decifrar({ entrada: path.join(c.drive, `${locais[0]}.gpg`), saida: path.join(pasta, 'p.tar.gz'), chaveArquivo: c.chave.arquivo, gpg: c.gpg });
  assert.deepEqual(fs.readFileSync(claro), fs.readFileSync(local));
  const r = restaurar(claro, path.join(pasta, 'r'));
  assert.deepEqual([r.integridade, r.etiquetas, r.waAuth], ['ok', 1, true]);
  // gpg: AES256, chave só por caminho, e a pasta temporária do auto sumiu
  const cif = c.gpg.chamadas.find((a) => a.includes('--symmetric'));
  assert.deepEqual(cif.slice(0, 6), ['--batch', '--yes', '--quiet', '--no-symkey-cache', '--pinentry-mode', 'loopback']);
  assert.equal(cif[cif.indexOf('--passphrase-file') + 1], c.chave.arquivo);
  assert.equal(cif[cif.indexOf('--cipher-algo') + 1], 'AES256');
  assert.deepEqual(decifradosNoEnvio, [1], 'decifrou (e restaurou) antes de subir');
  const tmpAuto = path.dirname(cif[cif.indexOf('--output') + 1]);
  assert.match(path.basename(tmpAuto), /^achadinho-backup-auto-/);
  assert.ok(!fs.existsSync(tmpAuto), 'o mkdtemp do auto foi apagado');
  // argv sem o conteúdo da chave (nem no gpg nem no rclone)
  const argv = JSON.stringify([...c.gpg.chamadas, ...c.rclone.chamadas]);
  assert.ok(!argv.includes(c.chave.conteudo));
  // estado: formato do contrato, 0600, atômico e sem segredo
  assert.equal(fs.statSync(c.estadoArquivo).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(c.dataDir).filter((f) => f.includes('.tmp')), []);
  const txt = fs.readFileSync(c.estadoArquivo, 'utf8');
  semSegredo(txt, c.chave, [c.dataDir, c.destDir, tmpAuto, os.tmpdir()]);
  assert.deepEqual(JSON.parse(txt), {
    versao: 1, tentativa_em: AGORA,
    local: { ok: true, em: AGORA, arquivo: locais[0], motivo: null },
    drive: { ok: true, em: AGORA, copias: 1, motivo: null },
    ultimo_ok_local: AGORA, ultimo_ok_drive: AGORA,
  });
  assert.deepEqual(lerJson(c.estadoArquivo), estado);
  semSegredo(resumoAuto(estado), c.chave, [c.dataDir]);
});

test('backup automático: rclone que falha mantém o local, tenta 3 vezes e grava drive.ok:false (código 3)', { skip: semGpg }, async () => {
  for (const opcao of [{ falhaCopia: true }, { lancar: true }]) {
    const drive = tmp();
    const c = cenario({ rclone: rcloneFalso(drive, opcao), estadoAnterior: { versao: 1, ultimo_ok_local: 111, ultimo_ok_drive: 222 } });
    const estado = await c.rodar();
    assert.equal(codigoSaida(estado), 3);
    assert.deepEqual(ops(c.rclone), ['copyto', 'copyto', 'copyto'], 'sem lsf nem deletefile depois da falha');
    assert.deepEqual(c.esperar.feitas, [2 * 60_000, 10 * 60_000]);
    assert.deepEqual(fs.readdirSync(drive), []);
    const [local] = fs.readdirSync(c.destDir);
    assert.equal(restaurar(path.join(c.destDir, local), tmp()).integridade, 'ok', 'o local continua válido');
    const e = lerJson(c.estadoArquivo);
    assert.deepEqual(e.local, { ok: true, em: AGORA, arquivo: local, motivo: null });
    assert.deepEqual(e.drive, { ok: false, em: AGORA, copias: null, motivo: 'envio' });
    assert.equal(e.ultimo_ok_local, AGORA);
    assert.equal(e.ultimo_ok_drive, 222, 'o último sucesso do Drive vem do estado anterior');
    assert.match(resumoAuto(estado), /Drive: falhou: não consegui enviar/);
  }
});

test('backup automático: 16 cópias viram 14 e o que não é pacote fica na pasta do Drive', { skip: semGpg }, async () => {
  const drive = tmp();
  const antigos = Array.from({ length: 15 }, (_, i) => `disparador-2026-10-${String(i + 1).padStart(2, '0')}-03-00-00.tar.gz.gpg`);
  for (const f of antigos) fs.writeFileSync(path.join(drive, f), 'x');
  const estranhos = ['leia-me.txt', 'disparador-velho.tar.gz.gpg', 'disparador-2000-01-01-00-00-00.tar.gz', 'disparador-2000-01-01-00-00-00.tar.gz.gpg.bak'];
  for (const f of estranhos) fs.writeFileSync(path.join(drive, f), 'x');
  fs.mkdirSync(path.join(drive, 'subpasta'));
  const c = cenario({ rclone: rcloneFalso(drive) });
  const estado = await c.rodar();
  assert.equal(codigoSaida(estado), 0);
  const [local] = fs.readdirSync(c.destDir);
  const ficaram = doDrive(drive);
  assert.equal(ficaram.length, MANTER_DRIVE);
  assert.deepEqual(ficaram, [...antigos.slice(2), `${local}.gpg`]);
  for (const f of [...estranhos, 'subpasta']) assert.ok(fs.existsSync(path.join(drive, f)), f);
  const apagados = c.rclone.chamadas.filter((a) => a[0] === 'deletefile').map((a) => a[1]);
  assert.deepEqual(apagados, antigos.slice(0, 2).map((f) => `${REMOTO}/${f}`));
  assert.equal(estado.drive.copias, 14); assert.equal(estado.drive.motivo, null);
});

test('backup automático: limpeza do Drive só roda se o arquivo de hoje aparece na lista; falha nela não derruba o envio', { skip: semGpg }, async () => {
  const preparar = () => {
    const drive = tmp();
    for (let i = 1; i <= 15; i++) fs.writeFileSync(path.join(drive, `disparador-2026-10-${String(i).padStart(2, '0')}-03-00-00.tar.gz.gpg`), 'x');
    return drive;
  };
  // o lsf ainda não mostra o de hoje (só os de outubro): não apaga nada
  {
    const drive = preparar();
    const c = cenario({ rclone: rcloneFalso(drive, { lsfMostra: (f) => f.includes('2026-10-') }) });
    const estado = await c.rodar();
    assert.equal(codigoSaida(estado), 0, 'o envio deu certo');
    assert.ok(ops(c.rclone).includes('lsf') && !ops(c.rclone).includes('deletefile'));
    assert.equal(doDrive(drive).length, 16);
    assert.deepEqual([estado.drive.ok, estado.drive.motivo, estado.drive.copias], [true, 'limpeza_drive', 15]);
    assert.equal(estado.ultimo_ok_drive, AGORA);
  }
  // o lsf falha
  {
    const drive = preparar();
    const c = cenario({ rclone: rcloneFalso(drive, { falhaLsf: true }) });
    const estado = await c.rodar();
    assert.equal(codigoSaida(estado), 0);
    assert.deepEqual([estado.drive.ok, estado.drive.motivo, estado.drive.copias], [true, 'limpeza_drive', null]);
    assert.ok(!ops(c.rclone).includes('deletefile'));
    assert.match(resumoAuto(estado), /aviso: a cópia foi enviada, mas não consegui apagar/);
  }
});

test('limparDrive: nunca apaga a cópia de hoje, mesmo com nomes "do futuro" no Drive (relógio errado)', async () => {
  const drive = tmp();
  const futuros = Array.from({ length: 14 }, (_, i) => `disparador-2099-01-${String(i + 1).padStart(2, '0')}-00-00-00.tar.gz.gpg`);
  const hoje = 'disparador-2026-11-08-03-00-00.tar.gz.gpg';
  for (const f of [...futuros, hoje]) fs.writeFileSync(path.join(drive, f), 'x');
  const rclone = rcloneFalso(drive);
  assert.equal(await limparDrive({ remoto: REMOTO, rclone, atual: hoje }), 15);
  assert.ok(fs.existsSync(path.join(drive, hoje)));
  assert.ok(!ops(rclone).includes('deletefile'));
  await assert.rejects(limparDrive({ remoto: REMOTO, rclone }), TypeError);
});

test('backup automático: chave 0644 ou ausente é recusada: local feito, Drive não recebe nada (código 3)', async () => {
  for (const [chave, motivo] of [[novaChave(0o644), 'chave_aberta'], [{ arquivo: path.join(tmp(), 'sem-chave'), conteudo: 'nao-existe-conteudo' }, 'chave_ausente']]) {
    const c = cenario({ chave });
    const estado = await c.rodar();
    assert.equal(codigoSaida(estado), 3);
    assert.deepEqual(c.rclone.chamadas, [], 'o rclone não foi chamado');
    assert.deepEqual(c.gpg.chamadas, [], 'nem o gpg');
    assert.equal(fs.readdirSync(c.destDir).length, 1, 'o local foi feito');
    const e = lerJson(c.estadoArquivo);
    assert.deepEqual(e.drive, { ok: false, em: AGORA, copias: null, motivo });
    assert.equal(e.local.ok, true);
    semSegredo(fs.readFileSync(c.estadoArquivo, 'utf8'), chave);
    semSegredo(resumoAuto(estado), chave);
  }
});

test('backup automático: pacote que não passa na conferência não sobe e o estado registra o erro', { skip: semGpg }, async () => {
  const casos = [
    // o gpg "decifra" mas devolve lixo: o restaurar falha
    [(args, real) => {
      if (!args.includes('--decrypt')) return real(args);
      fs.writeFileSync(args[args.indexOf('--output') + 1], 'lixo'); return { status: 0, stdout: STATUS_DECIFROU };
    }, 'verificacao'],
    // o gpg não consegue decifrar
    [(args, real) => (args.includes('--decrypt') ? { status: 2 } : real(args)), 'verificacao'],
    // o gpg não consegue cifrar
    [() => ({ status: 2 }), 'cifrar'],
    // o gpg some (lança)
    [() => { throw new Error('spawn gpg ENOENT'); }, 'cifrar'],
  ];
  for (const [trocar, motivo] of casos) {
    const c = cenario({ gpg: gpgReal({ trocar }) });
    const estado = await c.rodar();
    assert.equal(codigoSaida(estado), 3, motivo);
    assert.deepEqual(c.rclone.chamadas, [], 'nada sobe');
    assert.deepEqual(lerJson(c.estadoArquivo).drive, { ok: false, em: AGORA, copias: null, motivo });
    assert.equal(fs.readdirSync(c.destDir).length, 1, 'o local fica');
    const saida = c.gpg.chamadas[0][c.gpg.chamadas[0].indexOf('--output') + 1];
    assert.ok(!fs.existsSync(path.dirname(saida)), 'o mkdtemp foi apagado mesmo com erro');
  }
});

test('backup automático: sem banco o local falha (código 1), o Drive nem é tentado e o último sucesso é herdado', async () => {
  const c = cenario({ banco: false, estadoAnterior: { versao: 1, ultimo_ok_local: 111, ultimo_ok_drive: 222 } });
  const estado = await c.rodar();
  assert.equal(codigoSaida(estado), 1);
  assert.deepEqual(c.rclone.chamadas, []); assert.deepEqual(c.gpg.chamadas, []);
  assert.deepEqual(lerJson(c.estadoArquivo), {
    versao: 1, tentativa_em: AGORA,
    local: { ok: false, em: AGORA, arquivo: null, motivo: 'banco' },
    drive: { ok: null, em: null, copias: null, motivo: null },
    ultimo_ok_local: 111, ultimo_ok_drive: 222,
  });
  assert.ok(!fs.readFileSync(c.estadoArquivo, 'utf8').includes(c.dataDir), 'sem o caminho do banco');
  assert.match(resumoAuto(estado), /Backup local: falhou: não consegui fazer o backup local do banco\nDrive: não tentado/);
  // estado anterior ilegível: sem herança, sem erro
  fs.writeFileSync(c.estadoArquivo, '{quebrado');
  const e2 = await c.rodar();
  assert.deepEqual([e2.ultimo_ok_local, e2.ultimo_ok_drive], [null, null]);
});

test('enviarAoDrive recusa o que não é pacote cifrado; backupAutomatico exige rclone, gpg, chave e remoto', async () => {
  const pasta = tmp(); const rclone = rcloneFalso(tmp());
  const gz = path.join(pasta, 'disparador-2026-11-08-03-00-00.tar.gz');
  fs.writeFileSync(gz, Buffer.from([0x1f, 0x8b, 8, 0]));
  await assert.rejects(enviarAoDrive({ arquivo: gz, remoto: REMOTO, rclone }), /só envio ao Drive pacote cifrado/);
  const disfarcado = path.join(pasta, 'disparador-2026-11-08-03-00-00.tar.gz.gpg');
  fs.copyFileSync(gz, disfarcado);
  await assert.rejects(enviarAoDrive({ arquivo: disfarcado, remoto: REMOTO, rclone }), /só envio ao Drive pacote cifrado/, 'gzip renomeado para .gpg');
  const outro = path.join(pasta, 'notas.gpg'); fs.writeFileSync(outro, Buffer.from([0x8c, 0x0d]));
  await assert.rejects(enviarAoDrive({ arquivo: outro, remoto: REMOTO, rclone }), /só envio ao Drive pacote cifrado/);
  assert.deepEqual(rclone.chamadas, [], 'o rclone nunca recebeu nada');
  await assert.rejects(enviarAoDrive({ arquivo: disfarcado, remoto: REMOTO }), TypeError);

  const dataDir = pastaDeDados(); const destDir = path.join(dataDir, 'backups'); const chave = novaChave();
  const base = { dataDir, destDir, chaveArquivo: chave.arquivo, remoto: REMOTO, rclone, gpg: gpgReal(), esperar: semEspera() };
  for (const falta of ['rclone', 'gpg', 'chaveArquivo', 'remoto']) {
    await assert.rejects(backupAutomatico({ ...base, [falta]: undefined }), (e) => e instanceof TypeError && e.message.includes(falta), falta);
  }
  assert.ok(!fs.existsSync(destDir), 'nada foi feito sem os parâmetros');
  await assert.rejects(cifrar({ entrada: gz, saida: `${gz}.gpg`, chaveArquivo: chave.arquivo }), TypeError);
});

test('CLI auto: códigos 0, 3 e 1, saída sem a chave e sem o home (rclone falso no PATH, HOME temporário)', { skip: semGpg }, () => {
  const home = tmp();
  const dirChave = path.join(home, '.config', 'achadinhoturbo');
  fs.mkdirSync(dirChave, { recursive: true, mode: 0o700 });
  const conteudo = crypto.randomBytes(32).toString('base64');
  const arqChave = path.join(dirChave, 'backup.chave');
  fs.writeFileSync(arqChave, `${conteudo}\n`, { mode: 0o600 });
  const { bin, drive, log } = rcloneNoPath();
  const dataDir = pastaDeDados();
  const env = {
    ...ENV_GPG, HOME: home, DATA_DIR: dataDir, BACKUP_REMOTO: REMOTO, PATH: `${bin}:${process.env.PATH}`,
    RCLONE_CONFIG: path.join(home, 'nao-existe.conf'), RCLONE_FALSO_DIR: drive, RCLONE_FALSO_LOG: log,
  };
  delete env.BACKUP_DIR;
  const rodar = (extra = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, 'auto'], { env: { ...env, ...extra }, encoding: 'utf8' });
  const confere = (r) => { for (const t of [r.stdout, r.stderr]) { assert.ok(!t.includes(conteudo)); assert.ok(!t.includes(home)); assert.ok(!t.includes(os.homedir())); } };

  const ok = rodar();
  assert.equal(ok.status, 0, ok.stderr); confere(ok);
  assert.match(ok.stdout, /^Backup local: ok \(disparador-[\d-]+\.tar\.gz\)\nDrive: ok \(1 cópia\)\n$/);
  assert.equal(doDrive(drive).length, 1);
  assert.equal(fs.readdirSync(path.join(dataDir, 'backups')).length, 1, 'local em DATA_DIR/backups');
  const e = lerJson(path.join(dataDir, ARQUIVO_ESTADO));
  assert.deepEqual([e.local.ok, e.drive.ok], [true, true]);
  assert.ok(!fs.readFileSync(log, 'utf8').includes(conteudo), 'argv do rclone sem a chave');

  fs.chmodSync(arqChave, 0o644);
  const aberta = rodar();
  assert.equal(aberta.status, 3); confere(aberta);
  assert.match(aberta.stderr, /Drive: falhou: a chave do backup está com permissão aberta/);
  fs.chmodSync(arqChave, 0o600);

  const vazio = pastaDeDados({ banco: false });
  const semBanco = rodar({ DATA_DIR: vazio });
  assert.equal(semBanco.status, 1); confere(semBanco);
  assert.ok(!semBanco.stderr.includes(vazio), 'sem o caminho do banco');
  assert.equal(lerJson(path.join(vazio, ARQUIVO_ESTADO)).local.motivo, 'banco');
});

// ---------- restaurar-drive (plano backup-automatico, etapa 3) ----------

/** Pacote de verdade (fazerBackup + gpg) com `etiquetas` etiquetas, gravado no Drive falso com o nome `nome`. */
async function pacoteNoDrive(drive, nome, chave, etiquetas = 1) {
  const dataDir = pastaDeDados();
  if (etiquetas > 1) {
    const db = openDb(dataDir);
    for (let i = 1; i < etiquetas; i++) db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run(`etq${i}`, 1);
    db.close();
  }
  const local = fazerBackup(dataDir, tmp());
  await cifrar({ entrada: local, saida: path.join(drive, nome), chaveArquivo: chave.arquivo, gpg: gpgReal() });
}

/**
 * Pacote cifrado cujo banco abre, mas não passa no PRAGMA integrity_check (índice que não bate com a tabela). Vai direto
 * por tar: o VACUUM INTO do fazerBackup reconstruiria o índice.
 */
async function pacoteCorrompidoNoDrive(drive, nome, chave) {
  const dir = tmp(); const db = openDb(dir);
  db.exec('CREATE TABLE zz(a, b); CREATE INDEX zz_i ON zz(a); INSERT INTO zz VALUES (1, 2), (3, 4);');
  db.close();
  const d = new DatabaseSync(path.join(dir, 'disparador.db'));
  d.exec('PRAGMA writable_schema=ON'); d.exec("UPDATE sqlite_schema SET sql = 'CREATE INDEX zz_i ON zz(b)' WHERE name = 'zz_i'");
  d.close();
  const pacote = path.join(tmp(), 'p.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', pacote, '-C', dir, 'disparador.db']).status, 0);
  await cifrar({ entrada: pacote, saida: path.join(drive, nome), chaveArquivo: chave.arquivo, gpg: gpgReal() });
}

/** O motivo do erro e a garantia de que a mensagem não traz a chave, o home nem pastas temporárias. */
async function motivoRestaurar(promessa, chave) {
  try { await promessa; return 'restaurou'; } catch (e) {
    if (!(e?.motivo)) throw e;
    semSegredo(String(e.message), chave, [os.tmpdir()]);
    return e.motivo;
  }
}

const restosDoTmp = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('achadinho-restaurar-drive-'));

test('restaurarDoDrive: sem arquivo, baixa o mais recente no padrão (ignora nomes estranhos), decifra e restaura', { skip: semGpg }, async () => {
  const chave = novaChave(); const drive = tmp();
  await pacoteNoDrive(drive, 'disparador-2026-11-01-03-00-00.tar.gz.gpg', chave, 1);
  await pacoteNoDrive(drive, 'disparador-2026-11-07-03-00-00.tar.gz.gpg', chave, 3);
  // nomes fora do padrão que ordenariam depois do mais recente: nunca são escolhidos
  for (const f of ['disparador-2099-01-01-00-00-00.tar.gz.gpg.bak', 'disparador-velho.tar.gz.gpg', 'zz.tar.gz.gpg', 'disparador-2099-01-01-00-00-00.tar.gz']) {
    fs.writeFileSync(path.join(drive, f), 'lixo');
  }
  const rclone = rcloneFalso(drive); const gpg = gpgReal();
  const destDir = path.join(tmp(), 'restaurado');
  const antes = restosDoTmp();
  const r = await restaurarDoDrive({ remoto: REMOTO, chaveArquivo: chave.arquivo, destDir, rclone, gpg });
  assert.deepEqual(r, { arquivo: 'disparador-2026-11-07-03-00-00.tar.gz.gpg', integridade: 'ok', regras: 0, etiquetas: 3, waAuth: true });
  assert.deepEqual(rclone.chamadas[0], ['lsf', '--files-only', `${REMOTO}/`]);
  assert.equal(rclone.chamadas.length, 2);
  const [op, origem, baixado] = rclone.chamadas[1];
  assert.deepEqual([op, origem], ['copyto', `${REMOTO}/disparador-2026-11-07-03-00-00.tar.gz.gpg`]);
  assert.match(path.basename(path.dirname(baixado)), /^achadinho-restaurar-drive-/);
  assert.ok(!fs.existsSync(path.dirname(baixado)), 'o mkdtemp (cópia baixada e pacote decifrado) foi apagado');
  assert.deepEqual(restosDoTmp(), antes);
  assert.ok(fs.existsSync(path.join(destDir, 'disparador.db')) && fs.existsSync(path.join(destDir, 'wa_auth', 'creds.json')));
  assert.equal(fs.statSync(destDir).mode & 0o777, 0o700);
  // gpg: decifra com a chave só por caminho
  assert.equal(gpg.chamadas.length, 1);
  const dec = gpg.chamadas[0];
  assert.ok(dec.includes('--decrypt')); assert.equal(dec[dec.indexOf('--passphrase-file') + 1], chave.arquivo);
  assert.ok(!JSON.stringify([...gpg.chamadas, ...rclone.chamadas]).includes(chave.conteudo), 'argv sem a chave');
  // o Drive fica como estava
  assert.equal(fs.readdirSync(drive).length, 6);
});

test('restaurarDoDrive: com arquivo, baixa exatamente esse (sem listar); nome fora do padrão é recusado antes do rclone', { skip: semGpg }, async () => {
  const chave = novaChave(); const drive = tmp();
  await pacoteNoDrive(drive, 'disparador-2026-11-01-03-00-00.tar.gz.gpg', chave, 2);
  fs.writeFileSync(path.join(drive, 'disparador-2026-11-07-03-00-00.tar.gz.gpg'), 'mais novo, mas não foi o pedido');
  const rclone = rcloneFalso(drive);
  const r = await restaurarDoDrive({ remoto: REMOTO, chaveArquivo: chave.arquivo, destDir: path.join(tmp(), 'r'), arquivo: 'disparador-2026-11-01-03-00-00.tar.gz.gpg', rclone, gpg: gpgReal() });
  assert.deepEqual([r.arquivo, r.integridade, r.etiquetas], ['disparador-2026-11-01-03-00-00.tar.gz.gpg', 'ok', 2]);
  assert.deepEqual(ops(rclone), ['copyto'], 'sem lsf');
  assert.equal(rclone.chamadas[0][1], `${REMOTO}/disparador-2026-11-01-03-00-00.tar.gz.gpg`);

  const ruins = ['../disparador-2026-11-01-03-00-00.tar.gz.gpg', 'x/disparador-2026-11-01-03-00-00.tar.gz.gpg', 'gdrive:disparador-2026-11-01-03-00-00.tar.gz.gpg',
    'disparador-2026-11-01-03-00-00.tar.gz', '--config=/tmp/x', 'disparador-2026-11-01-03-00-00.tar.gz.gpg\n', ' disparador-2026-11-01-03-00-00.tar.gz.gpg', ''];
  for (const arquivo of ruins) {
    const rc = rcloneFalso(drive); const gpg = gpgReal(); const destDir = path.join(tmp(), 'r');
    assert.equal(await motivoRestaurar(restaurarDoDrive({ remoto: REMOTO, chaveArquivo: chave.arquivo, destDir, arquivo, rclone: rc, gpg }), chave), 'nome_invalido', JSON.stringify(arquivo));
    assert.deepEqual([rc.chamadas, gpg.chamadas], [[], []], 'nem rclone nem gpg');
    assert.ok(!fs.existsSync(destDir));
  }
  assert.equal(MOTIVOS_RESTAURAR.nome_invalido, 'o nome do arquivo não está no padrão disparador-AAAA-MM-DD-HH-MM-SS.tar.gz.gpg');
});

test('restaurarDoDrive: falhas de rede, Drive, chave e gpg viram motivos fixos, não criam o destino e apagam o mkdtemp', { skip: semGpg }, async () => {
  const chave = novaChave(); const drive = tmp();
  const nome = 'disparador-2026-11-07-03-00-00.tar.gz.gpg';
  await pacoteNoDrive(drive, nome, chave);
  const antes = restosDoTmp();
  const caso = async ({ rclone = rcloneFalso(drive), chaveArquivo = chave.arquivo, arquivo, gpg = gpgReal() } = {}) => {
    const destDir = path.join(tmp(), 'r');
    const motivo = await motivoRestaurar(restaurarDoDrive({ remoto: REMOTO, chaveArquivo, destDir, arquivo, rclone, gpg }), chave);
    assert.ok(!fs.existsSync(destDir), `${motivo}: o destino não foi criado`);
    return { motivo, rclone, gpg };
  };
  assert.equal((await caso({ rclone: rcloneFalso(drive, { falhaLsf: true }) })).motivo, 'listar');
  assert.equal((await caso({ rclone: (args) => { throw new Error(`rede caiu ${args}`); } })).motivo, 'listar', 'rclone que lança');
  assert.equal((await caso({ rclone: rcloneFalso(tmp()) })).motivo, 'sem_copias', 'Drive vazio');
  assert.equal((await caso({ rclone: rcloneFalso(drive, { lsfMostra: (f) => f === 'leia-me.txt' }) })).motivo, 'sem_copias');
  assert.equal((await caso({ rclone: rcloneFalso(drive, { falhaBaixar: true }) })).motivo, 'baixar');
  assert.equal((await caso({ arquivo: 'disparador-2000-01-01-00-00-00.tar.gz.gpg' })).motivo, 'baixar', 'arquivo que não existe no Drive');
  // rclone que diz "ok" mas não grava nada
  assert.equal((await caso({ rclone: (args) => (args[0] === 'copyto' ? { status: 0 } : rcloneFalso(drive)(args)) })).motivo, 'baixar');
  // outra chave (válida) não abre a cópia
  const { motivo: m1, gpg: g1 } = await caso({ chaveArquivo: novaChave().arquivo });
  assert.equal(m1, 'decifrar'); assert.equal(g1.chamadas.length, 1);
  assert.equal((await caso({ gpg: () => ({ status: 2 }) })).motivo, 'decifrar');
  // o gpg "decifra" lixo: o tar falha
  const lixo = (args) => { fs.writeFileSync(args[args.indexOf('--output') + 1], 'lixo'); return { status: 0, stdout: STATUS_DECIFROU }; };
  assert.equal((await caso({ gpg: lixo })).motivo, 'restaurar');
  {
    const vazia = path.join(tmp(), 'vazia'); fs.mkdirSync(vazia);
    const pacoteRuim = (args) => { // tar válido que extrai um arquivo e não tem banco: o restaurar falha depois de extrair
      const d = tmp(); fs.writeFileSync(path.join(d, 'solto.txt'), 'x');
      spawnSync('tar', ['-czf', args[args.indexOf('--output') + 1], '-C', d, '.']); return { status: 0, stdout: STATUS_DECIFROU };
    };
    const m = await motivoRestaurar(restaurarDoDrive({ remoto: REMOTO, chaveArquivo: chave.arquivo, destDir: vazia, rclone: rcloneFalso(drive), gpg: pacoteRuim }), chave);
    assert.equal(m, 'restaurar');
    assert.deepEqual(fs.readdirSync(vazia), [], 'a pasta vazia volta a ficar vazia (dá para tentar de novo)');
  }
  // chave: ausente, curta ou aberta é recusada antes de qualquer chamada
  for (const [c, motivo] of [[path.join(tmp(), 'sem-chave'), 'chave_restaurar'], [novaChave(0o600, 'curta').arquivo, 'chave_restaurar'], [novaChave(0o644).arquivo, 'chave_aberta']]) {
    const r = await caso({ chaveArquivo: c });
    assert.equal(r.motivo, motivo);
    assert.deepEqual([r.rclone.chamadas, r.gpg.chamadas], [[], []]);
  }
  assert.match(MOTIVOS_RESTAURAR.chave_restaurar, /Não rode o instalador/);
  assert.deepEqual(restosDoTmp(), antes, 'nenhum mkdtemp sobrou');
  // parâmetros obrigatórios: sem eles nada é chamado
  const base = { remoto: REMOTO, chaveArquivo: chave.arquivo, destDir: path.join(tmp(), 'r'), rclone: rcloneFalso(drive), gpg: gpgReal() };
  for (const falta of ['remoto', 'chaveArquivo', 'destDir', 'rclone', 'gpg']) {
    await assert.rejects(restaurarDoDrive({ ...base, [falta]: undefined }), (e) => e instanceof TypeError && e.message.includes(falta), falta);
  }
  assert.deepEqual([base.rclone.chamadas, base.gpg.chamadas], [[], []]);
  // a falha não mexe no Drive (o pacote continua lá, igual)
  assert.deepEqual(fs.readdirSync(drive), [nome]);
});

test('conferirDestino: recusa a pasta do programa (inclusive por link simbólico) e o que já existe com conteúdo', () => {
  const raiz = tmp(); fs.mkdirSync(path.join(raiz, 'data'));
  const fora = tmp();
  const motivo = (p) => { try { return conferirDestino(p, { raiz }); } catch (e) { return e.motivo; } };
  for (const p of [raiz, path.join(raiz, 'data'), path.join(raiz, 'data', 'novo'), path.join(raiz, 'novo', 'mais'), path.join(fora, '..', path.basename(raiz), 'x')]) {
    assert.equal(motivo(p), 'destino_no_programa', p);
  }
  fs.symlinkSync(path.join(raiz, 'data'), path.join(fora, 'atalho'));
  fs.symlinkSync(raiz, path.join(fora, 'raiz-por-link'));
  assert.throws(() => conferirDestino(path.join(raiz, 'x'), { raiz: path.join(fora, 'raiz-por-link') }), (e) => e.motivo === 'destino_no_programa',
    'programa aberto por um link (o ROOT pode vir por link)');
  assert.equal(motivo(path.join(fora, 'atalho')), 'destino_no_programa', 'link para dentro do programa');
  assert.equal(motivo(path.join(fora, 'atalho', 'sub')), 'destino_no_programa');
  // com conteúdo, arquivo, link quebrado, abaixo de um arquivo
  const cheia = path.join(fora, 'cheia'); fs.mkdirSync(cheia); fs.writeFileSync(path.join(cheia, 'x'), '1');
  const arq = path.join(fora, 'arquivo'); fs.writeFileSync(arq, '1');
  fs.symlinkSync(path.join(fora, 'nao-existe'), path.join(fora, 'quebrado'));
  for (const p of [cheia, arq, path.join(fora, 'quebrado'), path.join(arq, 'sub')]) assert.equal(motivo(p), 'destino_com_conteudo', p);
  assert.equal(fs.readFileSync(path.join(cheia, 'x'), 'utf8'), '1');
  // aceitos: pasta nova (mesmo aninhada), pasta vazia e o vizinho com prefixo igual ao do programa
  const vazia = path.join(fora, 'vazia'); fs.mkdirSync(vazia);
  for (const p of [path.join(fora, 'nova'), path.join(fora, 'a', 'b'), vazia, `${raiz}-restaurado`]) assert.equal(motivo(p), path.resolve(p), p);
  assert.ok(!fs.existsSync(path.join(fora, 'nova')), 'só confere, não cria');
  // o padrão é a pasta do programa
  assert.throws(() => conferirDestino(path.join(ROOT, 'data-restaurado-teste')), (e) => e.motivo === 'destino_no_programa');
  assert.ok(!fs.existsSync(path.join(ROOT, 'data-restaurado-teste')));
  assert.throws(() => conferirDestino(), TypeError);
});

test('ponta a ponta: backupAutomatico envia, restaurarDoDrive dá integridade=ok e o agendador lê o mesmo backup-estado.json', { skip: semGpg }, async () => {
  const chave = novaChave(); const drive = tmp(); const gpg = gpgReal(); const rclone = rcloneFalso(drive);
  const dataDir = pastaDeDados();
  const estado = await backupAutomatico({ dataDir, destDir: path.join(dataDir, 'backups'), chaveArquivo: chave.arquivo, remoto: REMOTO, rclone, gpg, esperar: semEspera() });
  assert.equal(codigoSaida(estado), 0);
  const r = await restaurarDoDrive({ remoto: REMOTO, chaveArquivo: chave.arquivo, destDir: path.join(tmp(), 'restaurado'), rclone, gpg });
  assert.equal(r.integridade, 'ok'); assert.equal(r.etiquetas, 1); assert.equal(r.waAuth, true);
  assert.equal(r.arquivo, `${estado.local.arquivo}.gpg`, 'o pacote restaurado é o que o auto acabou de enviar');
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'backups')), [estado.local.arquivo], 'o local continua lá');

  // o agendador (src/scheduler.js) monta o caminho do estado sozinho a partir da pasta de dados: tem de ser o mesmo
  // arquivo que o script gravou (ARQUIVO_ESTADO), senão o aviso de atraso nunca veria a execução
  const db = openDb(dataDir);
  try {
    const wa = createWhatsApp({ db, dir: dataDir, dryRun: true });
    const scheduler = createScheduler({ db, wa, links: createLinkService({ getMode: () => 'fake' }), fast: true, dir: dataDir });
    await scheduler.avisos.tick(Date.now());
    const linhas = () => db.prepare("SELECT level, message FROM log WHERE rule_name = 'Backup' ORDER BY id").all().map((l) => ({ ...l }));
    assert.deepEqual(linhas()[0], { level: 'ok', message: 'Backup automático: cópia no computador ok; cópia no Google Drive ok (1 cópia guardada).' });
    // createAvisos direto, com o caminho pelo ARQUIVO_ESTADO do script: a mesma execução (backup_visto) não se repete
    const n = linhas().length;
    await createAvisos({ db, wa, estadoBackup: path.join(dataDir, ARQUIVO_ESTADO), inicio: Date.now() }).tick(Date.now());
    assert.equal(linhas().length, n, 'a execução já vista pelo agendador é a mesma');
    // uma restauração não cria nem altera o estado
    assert.deepEqual(lerJson(path.join(dataDir, ARQUIVO_ESTADO)), estado);
  } finally { db.close(); }
});

test('pasta com espaço (gdrive:Achadinho Turbo - Backups): envio, limpeza de 16 para 14 e restauração levam o caminho num argumento só', { skip: semGpg }, async () => {
  const chave = novaChave(); const drive = tmp(); const gpg = gpgReal();
  const rclone = rcloneFalso(drive, { remoto: REMOTO_ESPACO });
  const antigos = Array.from({ length: 15 }, (_, i) => `disparador-2000-01-${String(i + 1).padStart(2, '0')}-03-00-00.tar.gz.gpg`);
  for (const f of antigos) fs.writeFileSync(path.join(drive, f), 'x');
  const dataDir = pastaDeDados();
  const estado = await backupAutomatico({ dataDir, destDir: path.join(dataDir, 'backups'), chaveArquivo: chave.arquivo, remoto: REMOTO_ESPACO, rclone, gpg, esperar: semEspera(), agora: () => AGORA });
  assert.equal(codigoSaida(estado), 0);
  assert.deepEqual([estado.drive.ok, estado.drive.copias, estado.drive.motivo], [true, 14, null]);
  const enviado = `${estado.local.arquivo}.gpg`;
  assert.deepEqual(doDrive(drive), [...antigos.slice(2), enviado], '16 viraram 14');

  const r = await restaurarDoDrive({ remoto: REMOTO_ESPACO, chaveArquivo: chave.arquivo, destDir: path.join(tmp(), 'restaurado'), rclone, gpg });
  assert.deepEqual([r.arquivo, r.integridade, r.etiquetas, r.waAuth], [enviado, 'ok', 1, true]);

  // cada chamada, com o argv exato: o caminho com espaço é sempre UM argumento (sem shell, nada é partido nos espaços)
  const [envio, lista, ...resto] = rclone.chamadas;
  assert.equal(envio.length, 3); assert.equal(envio[0], 'copyto'); assert.equal(envio[2], `${REMOTO_ESPACO}/${enviado}`);
  assert.deepEqual(lista, ['lsf', '--files-only', `${REMOTO_ESPACO}/`]);
  assert.deepEqual(resto.slice(0, 2), antigos.slice(0, 2).map((f) => ['deletefile', `${REMOTO_ESPACO}/${f}`]));
  assert.deepEqual(resto[2], ['lsf', '--files-only', `${REMOTO_ESPACO}/`], 'a restauração lista a mesma pasta');
  assert.equal(resto[3].length, 3); assert.deepEqual(resto[3].slice(0, 2), ['copyto', `${REMOTO_ESPACO}/${enviado}`]);
  assert.equal(resto.length, 4);
  for (const args of rclone.chamadas) {
    for (const a of args) assert.ok(!['Turbo', '-', 'Backups', 'falso:Achadinho'].includes(a), `argumento partido: ${JSON.stringify(args)}`);
  }
});

test('CLI auto e restaurar-drive com BACKUP_REMOTO numa pasta com espaço: o rclone recebe o caminho inteiro num argumento só', { skip: semGpg }, () => {
  const home = tmp();
  const dirChave = path.join(home, '.config', 'achadinhoturbo');
  fs.mkdirSync(dirChave, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dirChave, 'backup.chave'), `${crypto.randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  const { bin, drive, log, chamadas } = rcloneNoPath();
  const antigos = Array.from({ length: 15 }, (_, i) => `disparador-2000-01-${String(i + 1).padStart(2, '0')}-03-00-00.tar.gz.gpg`);
  for (const f of antigos) fs.writeFileSync(path.join(drive, f), 'x');
  const dataDir = pastaDeDados();
  const env = {
    ...ENV_GPG, HOME: home, DATA_DIR: dataDir, BACKUP_REMOTO: REMOTO_ESPACO, PATH: `${bin}:${process.env.PATH}`,
    RCLONE_CONFIG: path.join(home, 'nao-existe.conf'), RCLONE_FALSO_DIR: drive, RCLONE_FALSO_LOG: log, RCLONE_FALSO_REMOTO: REMOTO_ESPACO,
  };
  delete env.BACKUP_DIR;
  const rodar = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { env, encoding: 'utf8' });

  const auto = rodar('auto');
  assert.equal(auto.status, 0, auto.stderr);
  assert.match(auto.stdout, /\nDrive: ok \(14 cópias\)\n$/);
  const [local] = fs.readdirSync(path.join(dataDir, 'backups'));
  assert.deepEqual(doDrive(drive), [...antigos.slice(2), `${local}.gpg`]);
  const dest = path.join(tmp(), 'restaurado');
  const rest = rodar('restaurar-drive', dest);
  assert.equal(rest.status, 0, rest.stderr);
  assert.equal(rest.stdout, `Restaurado ${local}.gpg em ${dest}: integridade=ok, regras=0, etiquetas=1, sessão WhatsApp=sim\n`);

  const c = chamadas();
  assert.equal(c[0].length, 3); assert.equal(c[0][0], 'copyto'); assert.equal(c[0][2], `${REMOTO_ESPACO}/${local}.gpg`);
  assert.deepEqual(c.slice(1), [
    ['lsf', '--files-only', `${REMOTO_ESPACO}/`],
    ...antigos.slice(0, 2).map((f) => ['deletefile', `${REMOTO_ESPACO}/${f}`]),
    ['lsf', '--files-only', `${REMOTO_ESPACO}/`],
    ['copyto', `${REMOTO_ESPACO}/${local}.gpg`, c.at(-1)[2]],
  ]);
});

test('CLI restaurar-drive: restaura a mais recente; recusa destino no programa, com conteúdo e nome fora do padrão', { skip: semGpg }, async () => {
  const home = tmp();
  const dirChave = path.join(home, '.config', 'achadinhoturbo');
  fs.mkdirSync(dirChave, { recursive: true, mode: 0o700 });
  const conteudo = crypto.randomBytes(32).toString('base64');
  const arqChave = path.join(dirChave, 'backup.chave');
  fs.writeFileSync(arqChave, `${conteudo}\n`, { mode: 0o600 });
  const { bin, drive, log, chamadas } = rcloneNoPath();
  await pacoteNoDrive(drive, 'disparador-2026-11-07-03-00-00.tar.gz.gpg', { arquivo: arqChave }, 2);
  await pacoteNoDrive(drive, 'disparador-2026-11-01-03-00-00.tar.gz.gpg', { arquivo: arqChave }, 1);
  const env = {
    ...ENV_GPG, HOME: home, DATA_DIR: tmp(), BACKUP_REMOTO: REMOTO, PATH: `${bin}:${process.env.PATH}`,
    RCLONE_CONFIG: path.join(home, 'nao-existe.conf'), RCLONE_FALSO_DIR: drive, RCLONE_FALSO_LOG: log,
  };
  pastas.push(path.join(ROOT, 'data-restaurado-teste')); // só existiria se a recusa regredisse
  const rodar = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, 'restaurar-drive', ...args], { env, encoding: 'utf8' });
  const confere = (r) => { for (const t of [r.stdout, r.stderr]) { assert.ok(!t.includes(conteudo)); assert.ok(!t.includes(home)); assert.ok(!t.includes(os.homedir())); } assert.ok(!r.stderr.includes(os.tmpdir())); };

  const dest = path.join(tmp(), 'achadinho-restaurado');
  const ok = rodar(dest);
  assert.equal(ok.status, 0, ok.stderr); confere(ok);
  assert.equal(ok.stdout, `Restaurado disparador-2026-11-07-03-00-00.tar.gz.gpg em ${dest}: integridade=ok, regras=0, etiquetas=2, sessão WhatsApp=sim\n`);
  assert.ok(fs.existsSync(path.join(dest, 'disparador.db')));
  assert.ok(!fs.readFileSync(log, 'utf8').includes(conteudo), 'argv do rclone sem a chave');

  const pedido = rodar(path.join(tmp(), 'outra'), 'disparador-2026-11-01-03-00-00.tar.gz.gpg');
  assert.equal(pedido.status, 0, pedido.stderr); assert.match(pedido.stdout, /^Restaurado disparador-2026-11-01-03-00-00\.tar\.gz\.gpg .*etiquetas=1,/);

  const n = chamadas().length;
  const recusas = [
    [[dest], MOTIVOS_RESTAURAR.destino_com_conteudo],
    // dentro do programa: só um nome novo (nunca data/: uma regressão extrairia o pacote de teste por cima dos dados do dono)
    [[path.join(ROOT, 'data-restaurado-teste', 'x')], MOTIVOS_RESTAURAR.destino_no_programa],
    [[path.join(tmp(), 'x'), '../disparador-2026-11-01-03-00-00.tar.gz.gpg'], MOTIVOS_RESTAURAR.nome_invalido],
  ];
  for (const [args, msg] of recusas) {
    const r = rodar(...args);
    assert.equal(r.status, 1, args.join(' ')); confere(r);
    assert.equal(r.stderr, `Falha na restauração do Drive: ${msg}\n`);
    assert.equal(r.stdout, '');
  }
  assert.equal(chamadas().length, n, 'nenhuma recusa chamou o rclone');
  assert.ok(!fs.existsSync(path.join(ROOT, 'data-restaurado-teste')));

  const semPasta = rodar();
  assert.equal(semPasta.status, 1); assert.match(semPasta.stderr, /^uso: npm run backup -- restaurar-drive <pasta-nova>/);

  // pacote que decifra, mas o banco não passa no integrity_check: código 2 (a pasta fica para inspeção)
  await pacoteCorrompidoNoDrive(drive, 'disparador-2026-11-09-03-00-00.tar.gz.gpg', { arquivo: arqChave });
  const quebrado = rodar(path.join(tmp(), 'quebrado'));
  assert.equal(quebrado.status, 2, quebrado.stderr); confere(quebrado);
  assert.match(quebrado.stdout, /^Restaurado disparador-2026-11-09-03-00-00\.tar\.gz\.gpg .*: integridade=row 1 missing from index zz_i, /);

  // Drive vazio e chave aberta: mensagem fixa, código 1
  for (const f of fs.readdirSync(drive)) fs.rmSync(path.join(drive, f));
  const vazio = rodar(path.join(tmp(), 'y'));
  assert.equal(vazio.status, 1); confere(vazio);
  assert.equal(vazio.stderr, `Falha na restauração do Drive: ${MOTIVOS_RESTAURAR.sem_copias}\n`);
  fs.chmodSync(arqChave, 0o644);
  const aberta = rodar(path.join(tmp(), 'z'));
  assert.equal(aberta.status, 1); confere(aberta);
  assert.equal(aberta.stderr, `Falha na restauração do Drive: ${MOTIVOS_BACKUP.chave_aberta}\n`);
});

// ---------- QA (rodada 1): bordas e regressões ----------

test('lerChave: 31 caracteres não, 32 sim; CRLF e espaços não enganam; link simbólico é recusado', () => {
  const motivo = (arquivo) => { try { lerChave(arquivo); return 'aceitou'; } catch (e) { return e.motivo; } };
  assert.equal(motivo(novaChave(0o600, 'a'.repeat(31)).arquivo), 'chave_ausente');
  assert.equal(motivo(novaChave(0o600, 'a'.repeat(32)).arquivo), 'aceitou');
  assert.equal(motivo(novaChave(0o600, `${'a'.repeat(40)}\r`).arquivo), 'aceitou', 'CRLF no fim da linha');
  assert.equal(motivo(novaChave(0o600, `${'a'.repeat(31)}\r`).arquivo), 'chave_ausente', 'o \\r não conta como caractere da chave');
  assert.equal(motivo(novaChave(0o600, ' '.repeat(40)).arquivo), 'chave_ausente', 'só espaços');
  assert.equal(motivo(novaChave(0o600, '').arquivo), 'chave_ausente', 'arquivo vazio');
  // S7 (rodada 1): link simbólico é recusado, aponte para chave aberta ou para chave boa
  const dir = tmp();
  for (const [nome, alvo] of [['aberta', novaChave(0o644)], ['boa', novaChave()]]) {
    const atalho = path.join(dir, `${nome}.chave`);
    fs.symlinkSync(alvo.arquivo, atalho);
    assert.equal(motivo(atalho), 'chave_ausente', `link para chave ${nome}`);
  }
});

test('comando(): programa que não existe ou estoura o prazo vira status null (falha), sem lançar nem vazar a saída', () => {
  assert.equal(comando('achadinho-programa-que-nao-existe')(['--version']).status, null);
  const lento = comando(process.execPath, { timeout: 300 })(['-e', 'setTimeout(() => {}, 5000)']);
  assert.equal(lento.status, null);
  // o stderr é descartado: nada do que o programa escreve lá volta para o chamador
  const r = comando(process.execPath)(['-e', "console.error('SEGREDO-NO-STDERR'); console.log('ok'); process.exit(4)"]);
  assert.deepEqual(r, { status: 4, stdout: 'ok\n' });
});

test('CA2: o pacote enviado ao Drive é cifrado de verdade com AES256 (pacote OpenPGP SKESK, cifra 9) e não abre com outra chave', { skip: semGpg }, async () => {
  const c = cenario();
  const estado = await c.rodar();
  assert.equal(codigoSaida(estado), 0);
  const [nome] = doDrive(c.drive);
  const cab = fs.readFileSync(path.join(c.drive, nome)).subarray(0, 8);
  const tag = cab[0] & 0x40 ? cab[0] & 0x3f : (cab[0] >> 2) & 0x0f;
  assert.equal(tag, 3, 'primeiro pacote: Symmetric-Key Encrypted Session Key');
  assert.equal(cab[2], 4, 'versão 4');
  assert.equal(cab[3], 9, 'cifra 9 = AES256');
  assert.equal(cab[4], 3, 'S2K iterado e com sal');
  await assert.rejects(decifrar({ entrada: path.join(c.drive, nome), saida: path.join(tmp(), 'x.tar.gz'), chaveArquivo: novaChave().arquivo, gpg: c.gpg }),
    (e) => e.motivo === 'verificacao');
});

test('backup automático: depois de uma falha do Drive, o próximo dia que dá certo renova o último sucesso e limpa o motivo', { skip: semGpg }, async () => {
  const drive = tmp(); const chave = novaChave();
  const dataDir = pastaDeDados(); const destDir = path.join(dataDir, 'backups');
  const roda = (rclone, t) => backupAutomatico({ dataDir, destDir, chaveArquivo: chave.arquivo, remoto: REMOTO, rclone, gpg: gpgReal(), esperar: semEspera(), agora: () => t });
  const dia1 = await roda(rcloneFalso(drive), 1_000);
  assert.deepEqual([dia1.ultimo_ok_local, dia1.ultimo_ok_drive], [1_000, 1_000]);
  await new Promise((r) => setTimeout(r, 1100)); // o nome do pacote tem resolução de segundo
  const dia2 = await roda(rcloneFalso(drive, { falhaCopia: true }), 2_000);
  assert.deepEqual([dia2.drive.ok, dia2.drive.motivo, dia2.ultimo_ok_local, dia2.ultimo_ok_drive], [false, 'envio', 2_000, 1_000]);
  assert.equal(codigoSaida(dia2), 3);
  await new Promise((r) => setTimeout(r, 1100));
  const dia3 = await roda(rcloneFalso(drive), 3_000);
  assert.equal(codigoSaida(dia3), 0);
  assert.deepEqual(dia3.drive, { ok: true, em: 3_000, copias: 2, motivo: null });
  assert.deepEqual([dia3.ultimo_ok_local, dia3.ultimo_ok_drive], [3_000, 3_000]);
  assert.deepEqual(lerJson(path.join(dataDir, ARQUIVO_ESTADO)), dia3);
});

test('backup automático: o local continua com os 7 mais recentes quando o auto roda (mesmo com o Drive fora)', { skip: semGpg }, async () => {
  const c = cenario({ rclone: rcloneFalso(tmp(), { falhaCopia: true }) });
  fs.mkdirSync(c.destDir, { recursive: true });
  const velhos = Array.from({ length: 8 }, (_, i) => `disparador-2000-01-0${i + 1}-00-00-00.tar.gz`);
  for (const f of velhos) fs.writeFileSync(path.join(c.destDir, f), '');
  fs.writeFileSync(path.join(c.destDir, 'anotacoes.txt'), 'não é pacote');
  const estado = await c.rodar();
  assert.equal(codigoSaida(estado), 3);
  const pacotes = fs.readdirSync(c.destDir).filter((f) => /^disparador-.*\.tar\.gz$/.test(f));
  assert.equal(pacotes.length, MANTER_LOCAL);
  assert.ok(pacotes.includes(estado.local.arquivo));
  assert.ok(fs.existsSync(path.join(c.destDir, 'anotacoes.txt')), 'o que não é pacote fica');
});

test('todo motivo de falha do script tem frase própria no Histórico (os dois lados do contrato não se afastam)', async () => {
  const dir = tmp(); const db = openDb(dir);
  try {
    const wa = createWhatsApp({ db, dir, dryRun: true });
    const arquivo = path.join(dir, ARQUIVO_ESTADO);
    const agora = Date.now(); const frases = new Map();
    for (const [i, motivo] of Object.keys(MOTIVOS_BACKUP).entries()) {
      fs.writeFileSync(arquivo, JSON.stringify({
        versao: 1, tentativa_em: agora - 1000 * (i + 1),
        local: { ok: false, em: agora, arquivo: null, motivo }, drive: { ok: false, em: agora, copias: null, motivo },
        ultimo_ok_local: agora, ultimo_ok_drive: agora,
      }));
      await createAvisos({ db, wa, estadoBackup: arquivo, inicio: agora - 7_200_000 }).tick(agora);
      const msg = db.prepare("SELECT message FROM log WHERE rule_name = 'Backup' ORDER BY id DESC LIMIT 1").get().message;
      const m = msg.match(/falhou \(([^)]+)\)/);
      assert.ok(m, `${motivo}: sem frase no Histórico: ${msg}`);
      frases.set(motivo, m[1]);
    }
    assert.equal(new Set(frases.values()).size, Object.keys(MOTIVOS_BACKUP).length, 'frases repetidas entre motivos diferentes');
    // R3: as chaves dos dois mapas são as mesmas (motivo novo no script pede frase no Histórico, e o contrário)
    assert.deepEqual(Object.keys(FRASES_DO_HISTORICO).sort(), Object.keys(MOTIVOS_BACKUP).sort());
    for (const frase of frases.values()) assert.doesNotMatch(frase, /function|object|undefined|\/|\.tar|gpg|rclone/i);
  } finally { db.close(); }
});

test('CLI auto: gpg que falha escrevendo segredo na saída e no erro: código 3, nada disso aparece na saída do script', { skip: semGpg }, () => {
  const home = tmp();
  const dirChave = path.join(home, '.config', 'achadinhoturbo');
  fs.mkdirSync(dirChave, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dirChave, 'backup.chave'), `${crypto.randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  const { bin, drive, log } = rcloneNoPath();
  fs.writeFileSync(path.join(bin, 'gpg'), `#!${process.execPath}\nconsole.error('TOKEN-SECRETO-GPG /home/outro/.gnupg'); console.log('TOKEN-SECRETO-GPG'); process.exit(2);\n`, { mode: 0o700 });
  const dataDir = pastaDeDados();
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, 'auto'], {
    env: { ...process.env, HOME: home, DATA_DIR: dataDir, BACKUP_REMOTO: REMOTO, PATH: `${bin}:${process.env.PATH}`, RCLONE_FALSO_DIR: drive, RCLONE_FALSO_LOG: log },
    encoding: 'utf8',
  });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /Drive: falhou: o gpg não conseguiu cifrar o pacote/);
  for (const t of [r.stdout, r.stderr, fs.readFileSync(path.join(dataDir, ARQUIVO_ESTADO), 'utf8')]) assert.ok(!t.includes('TOKEN-SECRETO') && !t.includes('/home/outro'));
  assert.deepEqual(doDrive(drive), [], 'nada subiu');
  assert.equal(fs.existsSync(log), false, 'o rclone nem foi chamado');
  assert.equal(fs.readdirSync(path.join(dataDir, 'backups')).length, 1, 'o local ficou');
});

// ---------- correções da rodada 1 (S1, S2, S3, S5, S7, R4, R5) ----------

test('S1: pacote sem cifra (gpg --store) "mais novo" no Drive não é restaurado: o decifrar recusa e o destino nem é criado', { skip: semGpg }, async () => {
  const chave = novaChave(); const drive = tmp();
  await pacoteNoDrive(drive, 'disparador-2026-11-07-03-00-00.tar.gz.gpg', chave, 1);
  // pacote de verdade (banco íntegro), só "embrulhado" pelo gpg --store: sem cifra e sem a chave
  const local = fazerBackup(pastaDeDados(), tmp());
  const falso = path.join(drive, 'disparador-2099-01-01-00-00-00.tar.gz.gpg');
  assert.equal(spawnSync('gpg', ['--batch', '--yes', '--quiet', '--store', '--output', falso, local], { env: ENV_GPG }).status, 0);
  // a brecha: o gpg "decifra" esse pacote com status 0, sem usar a chave
  const semConferir = comando('gpg', { env: ENV_GPG })(['--batch', '--yes', '--quiet', '--status-fd', '1', '--passphrase-file', chave.arquivo, '--output', path.join(tmp(), 'x'), '--decrypt', falso]);
  assert.equal(semConferir.status, 0);
  assert.doesNotMatch(semConferir.stdout, /DECRYPTION_OKAY/);

  const destDir = path.join(tmp(), 'restaurado'); const gpg = gpgReal(); const rclone = rcloneFalso(drive);
  assert.equal(await motivoRestaurar(restaurarDoDrive({ remoto: REMOTO, chaveArquivo: chave.arquivo, destDir, rclone, gpg }), chave), 'decifrar');
  assert.ok(!fs.existsSync(destDir), 'o destino não foi criado');
  assert.equal(rclone.chamadas[1][1], `${REMOTO}/disparador-2099-01-01-00-00-00.tar.gz.gpg`, 'foi o pacote escolhido (o mais recente)');
  assert.deepEqual(gpg.chamadas, [], 'recusado pelo 1º byte, antes de chamar o gpg');
  // direto no decifrar, com um gpg que diria "decifrei": o 1º byte basta para recusar
  const mentiroso = gpgReal({ trocar: (args) => { fs.writeFileSync(args[args.indexOf('--output') + 1], fs.readFileSync(local)); return { status: 0, stdout: STATUS_DECIFROU }; } });
  await assert.rejects(decifrar({ entrada: falso, saida: path.join(tmp(), 'y.tar.gz'), chaveArquivo: chave.arquivo, gpg: mentiroso }), (e) => e.motivo === 'verificacao');
  assert.deepEqual(mentiroso.chamadas, []);
  // e o envio também recusa o --store, mesmo com o nome no padrão
  const r2 = rcloneFalso(tmp());
  await assert.rejects(enviarAoDrive({ arquivo: falso, remoto: REMOTO, rclone: r2 }), /só envio ao Drive pacote cifrado/);
  assert.deepEqual(r2.chamadas, []);
});

test('S1: decifrar exige DECRYPTION_OKAY e GOODMDC no --status-fd 1 e nenhum DECRYPTION_FAILED, não só o status 0', { skip: semGpg }, async () => {
  const chave = novaChave(); const pasta = tmp();
  const local = fazerBackup(pastaDeDados(), tmp());
  const cifrado = path.join(pasta, 'disparador-2026-11-08-03-00-00.tar.gz.gpg');
  await cifrar({ entrada: local, saida: cifrado, chaveArquivo: chave.arquivo, gpg: gpgReal() });
  const comStatus = (stdout) => gpgReal({ trocar: (args) => { fs.writeFileSync(args[args.indexOf('--output') + 1], fs.readFileSync(local)); return { status: 0, stdout }; } });
  const tenta = (gpg) => decifrar({ entrada: cifrado, saida: path.join(tmp(), 'p.tar.gz'), chaveArquivo: chave.arquivo, gpg });
  for (const stdout of ['', '[GNUPG:] DECRYPTION_OKAY\n', '[GNUPG:] GOODMDC\n', `${STATUS_DECIFROU}[GNUPG:] DECRYPTION_FAILED\n`,
    'x [GNUPG:] DECRYPTION_OKAY\nx [GNUPG:] GOODMDC\n', '[GNUPG:] DECRYPTION_OKAYX\n[GNUPG:] GOODMDCX\n']) {
    await assert.rejects(tenta(comStatus(stdout)), (e) => e.motivo === 'verificacao', JSON.stringify(stdout));
  }
  const ok = comStatus(STATUS_DECIFROU);
  assert.ok(fs.existsSync(await tenta(ok)));
  assert.deepEqual(ok.chamadas[0].slice(6, 8), ['--status-fd', '1'], 'o status vem pelo stdout');
  // o gpg de verdade com a chave certa passa, e o argv continua sem o conteúdo da chave
  const real = gpgReal();
  assert.deepEqual(fs.readFileSync(await tenta(real)), fs.readFileSync(local));
  assert.ok(!JSON.stringify(real.chamadas).includes(chave.conteudo));
});

test('S1: enviarAoDrive só aceita arquivo que começa por SKESK (0x8c–0x8f ou 0xc3)', async () => {
  const nome = 'disparador-2026-11-08-03-00-00.tar.gz.gpg';
  const envia = async (bytes) => {
    const arquivo = path.join(tmp(), nome); fs.writeFileSync(arquivo, Buffer.from(bytes));
    const rclone = rcloneFalso(tmp());
    try { await enviarAoDrive({ arquivo, remoto: REMOTO, rclone, esperar: async () => {} }); return rclone.chamadas.length; } catch (e) {
      assert.match(e.message, /só envio ao Drive pacote cifrado/); assert.deepEqual(rclone.chamadas, []); return 'recusou';
    }
  };
  for (const b of [0x8c, 0x8d, 0x8e, 0x8f, 0xc3]) assert.equal(await envia([b, 0x0d, 4, 9]), 1, b.toString(16));
  // literal/comprimido (--store), chave pública, outros pacotes, gzip e arquivo vazio
  for (const b of [0xa3, 0xac, 0xcb, 0xc8, 0x84, 0x85, 0xc1, 0x90, 0x88, 0x1f]) assert.equal(await envia([b, 0x8b, 4, 9]), 'recusou', b.toString(16));
  assert.equal(await envia([]), 'recusou', 'vazio');
});

test('S3: a conferência em texto puro sai da pasta temporária antes do envio: no rclone só há o .gpg', { skip: semGpg }, async () => {
  for (const opcao of [{}, { falhaCopia: true }]) {
    const drive = tmp(); const falso = rcloneFalso(drive, opcao); const vistos = [];
    const rclone = (args) => { if (args[0] === 'copyto') vistos.push(fs.readdirSync(path.dirname(args[1]))); return falso(args); };
    Object.assign(rclone, { chamadas: falso.chamadas, recebidos: falso.recebidos });
    const c = cenario({ rclone });
    const estado = await c.rodar();
    assert.ok(vistos.length >= 1);
    for (const v of vistos) assert.deepEqual(v, [`${estado.local.arquivo}.gpg`], JSON.stringify(opcao));
  }
  // a conferência que falha também não deixa nada (o restaurar falha depois de extrair)
  const lixo = gpgReal({ trocar: (args, real) => {
    if (!args.includes('--decrypt')) return real(args);
    const d = tmp(); fs.writeFileSync(path.join(d, 'solto.txt'), 'x');
    spawnSync('tar', ['-czf', args[args.indexOf('--output') + 1], '-C', d, '.']); return { status: 0, stdout: STATUS_DECIFROU };
  } });
  const c = cenario({ gpg: lixo });
  assert.equal((await c.rodar()).drive.motivo, 'verificacao');
  assert.ok(!fs.existsSync(path.dirname(lixo.chamadas[0][lixo.chamadas[0].indexOf('--output') + 1])));
});

test('S3: o CLI auto encerrado por SIGTERM ou SIGINT apaga as pastas temporárias e sai com 1', { skip: semGpg, timeout: 60_000 }, async () => {
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    const home = tmp();
    const dirChave = path.join(home, '.config', 'achadinhoturbo');
    fs.mkdirSync(dirChave, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dirChave, 'backup.chave'), `${crypto.randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    const bin = tmp(); const log = path.join(tmp(), 'rclone.log');
    // rclone que sempre falha: depois da 1ª tentativa vem a espera de 2 min, com o .gpg na pasta temporária
    fs.writeFileSync(path.join(bin, 'rclone'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.RCLONE_FALSO_LOG, 'chamado\\n'); process.exit(1);\n`, { mode: 0o700 });
    const tmpDoFilho = tmp();
    const filho = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, 'auto'], {
      env: { ...ENV_GPG, HOME: home, DATA_DIR: pastaDeDados(), BACKUP_REMOTO: REMOTO, PATH: `${bin}:${process.env.PATH}`, RCLONE_FALSO_LOG: log, TMPDIR: tmpDoFilho },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let saida = ''; filho.stdout.on('data', (d) => { saida += d; }); filho.stderr.on('data', (d) => { saida += d; });
    const fim = new Promise((r) => filho.on('exit', (code, signal) => r({ code, signal })));
    try {
      for (let i = 0; i < 400 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(fs.existsSync(log), 'o rclone foi chamado');
      assert.equal(fs.readdirSync(tmpDoFilho).filter((f) => f.startsWith('achadinho-backup-auto-')).length, 1, 'na espera, a pasta temporária existe');
      filho.kill(sinal);
      const r = await fim;
      assert.deepEqual(r, { code: 1, signal: null }, `${sinal}: ${saida}`);
      assert.deepEqual(fs.readdirSync(tmpDoFilho), [], `${sinal}: nenhuma pasta temporária sobrou`);
      assert.match(saida, new RegExp(`Backup automático interrompido \\(${sinal}\\): apaguei as pastas temporárias\\.`));
    } finally { filho.kill('SIGKILL'); }
  }
});

test('S2: o stderr do tar (os nomes do wa_auth trazem o telefone) é descartado e a mensagem de erro é fixa', () => {
  const bin = tmp();
  fs.writeFileSync(path.join(bin, 'tar'), `#!${process.execPath}\nprocess.stderr.write('tar: ./wa_auth/session-5511987654321.0.json: Cannot open: Permission denied\\n'); process.exit(2);\n`, { mode: 0o700 });
  const dataDir = pastaDeDados(); const pacote = path.join(tmp(), 'p.tar.gz'); fs.writeFileSync(pacote, 'x');
  const codigo = `import { fazerBackup, restaurar } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
for (const f of [() => fazerBackup(${JSON.stringify(dataDir)}, ${JSON.stringify(tmp())}), () => restaurar(${JSON.stringify(pacote)}, ${JSON.stringify(path.join(tmp(), 'r'))})]) {
  try { f(); console.log('passou'); } catch (e) { console.log(e.message); }
}`;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', codigo], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'o tar não conseguiu empacotar o backup\no tar não conseguiu extrair o pacote\n');
  assert.ok(!`${r.stdout}${r.stderr}`.includes('5511987654321'), r.stderr);
  // o CLI manual mostra a mesma frase fixa
  const cli = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, path.join(tmp(), 'bk')], { env: { ...process.env, DATA_DIR: dataDir, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, 'Falha no backup: o tar não conseguiu empacotar o backup\n');
});

test('S5 e R5: restaurar manual confere o destino; "instalar" aponta o npm run backup:instalar; nome desconhecido mostra o uso sem criar pasta', () => {
  const dataDir = pastaDeDados();
  const pacote = fazerBackup(dataDir, tmp());
  const cwd = tmp();
  const rodar = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { cwd, env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: '' }, encoding: 'utf8' });
  const semBackupPadrao = () => assert.ok(!fs.existsSync(path.join(dataDir, 'backups')), 'nenhum backup no destino padrão');

  // S5: pasta com conteúdo não recebe o pacote por cima
  const cheia = tmp(); fs.writeFileSync(path.join(cheia, 'meu.txt'), 'meu');
  const r1 = rodar('restaurar', pacote, cheia);
  assert.equal(r1.status, 1);
  assert.equal(r1.stderr, `Falha no backup: ${MOTIVOS_RESTAURAR.destino_com_conteudo}\n`);
  assert.deepEqual(fs.readdirSync(cheia), ['meu.txt']);
  // S5: dentro da pasta do programa (nome novo, nunca data/)
  pastas.push(path.join(ROOT, 'data-restaurado-teste'));
  const r2 = rodar('restaurar', pacote, path.join(ROOT, 'data-restaurado-teste', 'x'));
  assert.equal(r2.status, 1);
  assert.equal(r2.stderr, `Falha no backup: ${MOTIVOS_RESTAURAR.destino_no_programa}\n`);
  assert.ok(!fs.existsSync(path.join(ROOT, 'data-restaurado-teste')));
  // pasta nova e pasta vazia: restaura como antes
  for (const dest of [path.join(tmp(), 'nova'), tmp()]) {
    const ok = rodar('restaurar', pacote, dest);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, `Restaurado em ${dest}: integridade=ok, regras=0, etiquetas=1, sessão WhatsApp=sim\n`);
  }

  // R5: "instalar" não faz backup
  const inst = rodar('instalar');
  assert.deepEqual([inst.status, inst.stdout, inst.stderr], [1, '', 'Para instalar o backup automático, use: npm run backup:instalar\n']);
  // R5: erro de digitação mostra o uso, sai com 1 e não cria a pasta
  for (const nome of ['restaura', 'restaurar-driv', 'auto2', '--help']) {
    const r = rodar(nome);
    assert.equal(r.status, 1, nome); assert.equal(r.stdout, '', nome);
    assert.match(r.stderr, /não é um comando nem uma pasta que exista\.\nuso:\n/, nome);
    assert.match(r.stderr, /npm run backup:instalar/);
  }
  assert.deepEqual(fs.readdirSync(cwd), [], 'nenhuma pasta criada');
  semBackupPadrao();
  // pasta que já existe (sem /) e caminho com /: backup normal, como antes
  fs.mkdirSync(path.join(cwd, 'bk'));
  for (const destino of ['bk', './outra']) {
    const r = rodar(destino);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readdirSync(path.join(cwd, destino)).length, 1, destino);
  }
  semBackupPadrao();
});

test('S7: lerChave recusa a pasta da chave em que grupo ou outros podem gravar', () => {
  const motivo = (arquivo) => { try { lerChave(arquivo); return 'aceitou'; } catch (e) { return e.motivo; } };
  for (const modo of [0o720, 0o702, 0o770, 0o777, 0o1777]) {
    const c = novaChave(); fs.chmodSync(path.dirname(c.arquivo), modo);
    assert.equal(motivo(c.arquivo), 'chave_aberta', modo.toString(8));
  }
  for (const modo of [0o700, 0o750, 0o755]) {
    const c = novaChave(); fs.chmodSync(path.dirname(c.arquivo), modo);
    assert.equal(motivo(c.arquivo), 'aceitou', modo.toString(8));
  }
});

test('S7: BACKUP_REMOTO fora do formato nome:pasta (ou começando com -) é recusado nas funções e no CLI, antes de qualquer coisa', { skip: semGpg }, async () => {
  const ruins = ['-x:y', '--config=/tmp/x:y', 'gdrive', ':pasta', 'gd rive:x', ' gdrive:x', 'gdrive:x\n', 'gdrive:%h', '',
    // pasta com espaço: só espaço simples entre palavras
    'gdrive: a', 'gdrive:a ', 'gdrive:a  b', 'gdrive:a /b', 'gdrive:a/ b', 'gdrive:a\tb', 'gdrive:a\u00a0b', 'gdrive:a\nb',
    'gdrive:"a b"', "gdrive:'a b'", 'gdrive:a %h', 'gdrive:a $HOME', 'gdrive:a\\ b', 'gdrive:a; b', 'gdrive:a, b', 'gdrive:a: b'];
  for (const r of ruins) assert.equal(remotoValido(r), false, JSON.stringify(r));
  for (const r of [REMOTO, REMOTO_PADRAO, REMOTO_ESPACO, 'meu_drive.2:', 'gdrive:a/b-c.d', 'gdrive:a b', 'gdrive:Pasta A/Sub B']) assert.equal(remotoValido(r), true, r);
  assert.ok(!RE_REMOTO.test('-x:y'));

  const chave = novaChave(); const dataDir = pastaDeDados(); const destDir = path.join(dataDir, 'backups');
  const rclone = rcloneFalso(tmp()); const gpg = gpgReal();
  for (const remoto of ['-x:y', 'gdrive']) {
    await assert.rejects(backupAutomatico({ dataDir, destDir, chaveArquivo: chave.arquivo, remoto, rclone, gpg, esperar: semEspera() }), TypeError);
    await assert.rejects(restaurarDoDrive({ remoto, chaveArquivo: chave.arquivo, destDir: path.join(tmp(), 'r'), rclone, gpg }), TypeError);
  }
  assert.ok(!fs.existsSync(destDir)); assert.ok(!fs.existsSync(path.join(dataDir, ARQUIVO_ESTADO)));
  assert.deepEqual([rclone.chamadas, gpg.chamadas], [[], []]);

  const { bin, log } = rcloneNoPath();
  const home = tmp();
  for (const args of [['auto'], ['restaurar-drive', path.join(tmp(), 'r')]]) {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], {
      env: { ...ENV_GPG, HOME: home, DATA_DIR: dataDir, BACKUP_REMOTO: '--config=/tmp/x:y', PATH: `${bin}:${process.env.PATH}`, RCLONE_FALSO_LOG: log },
      encoding: 'utf8',
    });
    assert.equal(r.status, 1, args[0]);
    assert.match(r.stderr, /^BACKUP_REMOTO inválido: use o formato nome:pasta/, args[0]);
    assert.ok(!r.stderr.includes('/tmp/x'), 'o valor recusado não é repetido');
  }
  assert.ok(!fs.existsSync(log), 'o rclone nem foi chamado');
  assert.ok(!fs.existsSync(destDir), 'o auto não fez nada');
});
