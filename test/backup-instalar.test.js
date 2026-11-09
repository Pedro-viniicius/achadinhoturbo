// Instalador do backup automático (npm run backup:instalar): chave, units do systemd e idempotência.
// Nenhum teste usa o home real, o systemd real nem o rclone real: `homeDir` é uma pasta temporária e `executar` é um
// falso que só registra as chamadas. O teste do CLI põe gpg/rclone/systemctl falsos na frente do PATH e HOME temporário.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  instalar, unidadesSystemd, nomeDoRemoto, ErroInstalar, UNIDADE_SERVICE, UNIDADE_TIMER, CHAVE_RELATIVA, HORARIO_PADRAO,
} from '../scripts/backup-instalar.js';
import { CHAVE_PADRAO, REMOTO_PADRAO, lerChave, remotoValido } from '../scripts/backup.js';

const SCRIPT = fileURLToPath(new URL('../scripts/backup-instalar.js', import.meta.url));
const RAIZ = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const NODE = '/opt/node/bin/node';
const pastas = [];
const tmp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-bkinst-')); pastas.push(p); return p; };
after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });

const modo = (p) => fs.statSync(p).mode & 0o777;
const chaveEm = (home) => path.join(home, '.config/achadinhoturbo/backup.chave');
const unitEm = (home, nome) => path.join(home, '.config/systemd/user', nome);

/** `executar` falso: registra cada chamada; `respostas['bin sub']` troca o resultado padrão (status 0). */
function executorFalso(respostas = {}) {
  const chamadas = [];
  const padrao = {
    'gpg --version': { status: 0, stdout: 'gpg (GnuPG) 2.4.8\n' },
    'rclone listremotes': { status: 0, stdout: 'gdrive:\npedro:\n' },
    'systemctl --user': { status: 0, stdout: '' },
  };
  const executar = (bin, args) => {
    chamadas.push([bin, ...args]);
    const chave = `${bin} ${args[0]}`;
    if (chave in respostas) return respostas[chave];
    if (bin === 'systemctl' && args.includes('list-timers')) {
      return respostas.listTimers || { status: 0, stdout: 'NEXT                        LEFT LAST PASSED UNIT                        ACTIVATES\nSun 2026-11-09 03:04:00 -03 10h  -    -      achadinhoturbo-backup.timer achadinhoturbo-backup.service\n' };
    }
    return padrao[chave] || { status: 0, stdout: '' };
  };
  return { executar, chamadas };
}

function rodarInstalar(home, opcoes = {}) {
  const linhas = [];
  const falso = opcoes.falso || executorFalso(opcoes.respostas);
  const r = instalar({ homeDir: home, raiz: RAIZ, node: NODE, executar: falso.executar, saida: (l) => linhas.push(l), ...opcoes.extra });
  return { r, saida: linhas.join('\n'), chamadas: falso.chamadas };
}

const ehErro = (re) => (e) => e instanceof ErroInstalar && re.test(e.message);

test('unidadesSystemd: service oneshot com auto, prazo de 1 h e remoto; timer diário às 03:00 com Persistent; função pura', () => {
  const u = unidadesSystemd({ node: NODE, raiz: RAIZ, remoto: REMOTO_PADRAO, horario: HORARIO_PADRAO });
  assert.deepEqual(Object.keys(u), [UNIDADE_SERVICE, UNIDADE_TIMER]);
  assert.equal(UNIDADE_SERVICE, 'achadinhoturbo-backup.service');
  assert.equal(UNIDADE_TIMER, 'achadinhoturbo-backup.timer');
  const s = u[UNIDADE_SERVICE].split('\n');
  for (const linha of [
    'Type=oneshot', `WorkingDirectory=${RAIZ}`,
    `ExecStart=${NODE} --disable-warning=ExperimentalWarning scripts/backup.js auto`,
    // pasta com espaço: o valor vai entre aspas, senão o systemd parte em BACKUP_REMOTO=gdrive:Achadinho, Turbo, -…
    'Environment="BACKUP_REMOTO=gdrive:Achadinho Turbo - Backups"', 'Nice=10', 'IOSchedulingClass=idle', 'TimeoutStartSec=1h',
    'UMask=0077', // S3 (rodada 1): o que o backup cria (pastas temporárias inclusive) é só do dono
  ]) assert.ok(s.includes(linha), linha);
  const t = u[UNIDADE_TIMER].split('\n');
  for (const linha of ['[Timer]', 'OnCalendar=*-*-* 03:00', 'RandomizedDelaySec=10min', 'Persistent=true', 'WantedBy=timers.target']) assert.ok(t.includes(linha), linha);
  assert.deepEqual(unidadesSystemd({ node: NODE, raiz: RAIZ, remoto: REMOTO_PADRAO, horario: HORARIO_PADRAO }), u, 'mesma entrada, mesmo texto');
  assert.ok(unidadesSystemd({ node: NODE, raiz: RAIZ }).hasOwnProperty(UNIDADE_TIMER), 'remoto e horário têm padrão');
  assert.ok(unidadesSystemd({ node: NODE, raiz: RAIZ, horario: '21:30' })[UNIDADE_TIMER].includes('OnCalendar=*-*-* 21:30\n'));
  assert.ok(unidadesSystemd({ node: '/home/x/meu node/bin/node', raiz: RAIZ })[UNIDADE_SERVICE].includes('ExecStart="/home/x/meu node/bin/node" --disable'), 'caminho com espaço vai entre aspas');
});

test('unidadesSystemd: recusa o que poderia injetar linha ou especificador na unit', () => {
  for (const node of ['node', 'bin/node', '/x/node\nExecStartPre=/bin/rm', '/x/%h/node', '/x/$HOME/node', '/x/"node', undefined]) {
    assert.throws(() => unidadesSystemd({ node, raiz: RAIZ }), ErroInstalar, String(node));
  }
  assert.throws(() => unidadesSystemd({ node: NODE, raiz: '/x\n[Install]' }), ErroInstalar);
  for (const remoto of ['gdrive:x\nExecStartPre=/bin/sh', 'gdrive', ':pasta', 'gd rive:x', 'gdrive:%h', 'gdrive:a" b', 'gdrive:a\\ b', 'gdrive:a b ', 'gdrive:a  b', 'gdrive:$HOME']) {
    assert.throws(() => unidadesSystemd({ node: NODE, raiz: RAIZ, remoto }), ErroInstalar, JSON.stringify(remoto));
  }
  for (const horario of ['3:00', '24:00', '03:60', '03:00\nOnCalendar=minutely', '']) {
    assert.throws(() => unidadesSystemd({ node: NODE, raiz: RAIZ, horario }), ErroInstalar, JSON.stringify(horario));
  }
  assert.equal(nomeDoRemoto('gdrive:Achadinho Turbo - Backups'), 'gdrive:');
  // S7 (rodada 1): o instalador e o backup.js usam a mesma regra de remoto (o que um grava na unit o outro aceita)
  for (const remoto of [REMOTO_PADRAO, 'gdrive:achadinhoturbo-backups', 'meu_drive.2:', '-x:y', '--config=/x:y', 'gdrive', 'gdrive:a b', 'gdrive: a', 'gdrive:a  b', 'gdrive:a /b', 'gd rive:x']) {
    let aceito = true; try { nomeDoRemoto(remoto); } catch { aceito = false; }
    assert.equal(aceito, remotoValido(remoto), remoto);
  }
  assert.equal(nomeDoRemoto('meu_drive.2:'), 'meu_drive.2:');
});

test('o caminho da chave é o mesmo que o auto lê (CHAVE_PADRAO) e o package.json tem backup:instalar', () => {
  assert.equal(CHAVE_RELATIVA, path.join('.config', 'achadinhoturbo', 'backup.chave'));
  assert.equal(path.join(os.homedir(), CHAVE_RELATIVA), CHAVE_PADRAO);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['backup:instalar'], /^node( --disable-warning=ExperimentalWarning)? scripts\/backup-instalar\.js$/);
});

test('primeira execução: chave de 32 bytes aleatórios (0600, pasta 0700), units gravadas, systemctl na ordem e aviso sem a chave', () => {
  const home = tmp();
  const { r, saida, chamadas } = rodarInstalar(home);
  const chave = chaveEm(home);
  const conteudo = fs.readFileSync(chave, 'utf8');
  assert.match(conteudo, /^[0-9a-f]{64}\n$/, '32 bytes em hex numa linha só (o gpg lê só a 1ª linha)');
  assert.equal(lerChave(chave), chave, 'o auto aceita a chave criada');
  assert.equal(modo(chave), 0o600);
  assert.equal(modo(path.dirname(chave)), 0o700);
  assert.deepEqual(r, { chave, chaveCriada: true, pastaCorrigida: false, chavePermissaoCorrigida: false, unidades: { [UNIDADE_SERVICE]: true, [UNIDADE_TIMER]: true } });
  const esperadas = unidadesSystemd({ node: NODE, raiz: RAIZ });
  for (const nome of [UNIDADE_SERVICE, UNIDADE_TIMER]) assert.equal(fs.readFileSync(unitEm(home, nome), 'utf8'), esperadas[nome]);

  assert.deepEqual(chamadas, [
    ['gpg', '--version'],
    ['rclone', 'listremotes'],
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', UNIDADE_TIMER],
    ['systemctl', '--user', 'list-timers', UNIDADE_TIMER, '--no-pager'],
  ]);
  const segredo = conteudo.trim();
  assert.ok(!saida.includes(segredo), 'a saída não traz a chave');
  assert.ok(!saida.includes(segredo.slice(0, 16)), 'nem um pedaço dela');
  assert.ok(!JSON.stringify(chamadas).includes(segredo.slice(0, 16)), 'nem os argumentos dos programas');
  assert.ok(!JSON.stringify(Object.values(esperadas)).includes(segredo.slice(0, 16)), 'nem as units');
  assert.ok(saida.includes(chave), 'mostra o caminho da chave');
  assert.match(saida, /gerenciador de senhas/);
  assert.match(saida, /Sem ela, as cópias do Google Drive NÃO abrem/);
  assert.match(saida, /Chave do backup criada em /);
  assert.match(saida, /achadinhoturbo-backup\.timer achadinhoturbo-backup\.service/, 'mostra a próxima execução');
});

test('duas instalações em homes diferentes geram chaves diferentes', () => {
  const a = tmp(); const b = tmp();
  rodarInstalar(a); rodarInstalar(b);
  assert.notEqual(fs.readFileSync(chaveEm(a), 'utf8'), fs.readFileSync(chaveEm(b), 'utf8'));
});

test('segunda execução: não troca a chave nem regrava as units; unit editada à mão volta ao conteúdo gerado', () => {
  const home = tmp();
  rodarInstalar(home);
  const chave = chaveEm(home);
  const antes = { chave: fs.readFileSync(chave), stChave: fs.statSync(chave) };
  const stUnits = Object.fromEntries([UNIDADE_SERVICE, UNIDADE_TIMER].map((n) => [n, fs.statSync(unitEm(home, n))]));

  const { r, saida, chamadas } = rodarInstalar(home);
  assert.deepEqual(fs.readFileSync(chave), antes.chave, 'mesma chave');
  assert.equal(fs.statSync(chave).ino, antes.stChave.ino);
  assert.equal(fs.statSync(chave).mtimeMs, antes.stChave.mtimeMs);
  for (const [n, st] of Object.entries(stUnits)) {
    const agora = fs.statSync(unitEm(home, n));
    assert.equal(agora.ino, st.ino, `${n} não foi regravada`);
    assert.equal(agora.mtimeMs, st.mtimeMs, `${n} não foi regravada`);
  }
  assert.equal(r.chaveCriada, false);
  assert.deepEqual(r.unidades, { [UNIDADE_SERVICE]: false, [UNIDADE_TIMER]: false });
  assert.match(saida, /já existia em .*: mantida/);
  assert.match(saida, /Unit achadinhoturbo-backup\.service sem mudança/);
  assert.match(saida, /IMPORTANTE: copie a chave/, 'o aviso da chave aparece de novo');
  assert.ok(!saida.includes(antes.chave.toString().trim()));
  assert.equal(chamadas.filter((c) => c.includes('enable')).length, 1, 'enable --now é idempotente no systemd');
  assert.deepEqual(fs.readdirSync(path.join(home, '.config/systemd/user')).sort(), [UNIDADE_SERVICE, UNIDADE_TIMER], 'nada duplicado nem temporário sobrando');
  assert.deepEqual(fs.readdirSync(path.dirname(chave)), ['backup.chave']);

  fs.appendFileSync(unitEm(home, UNIDADE_TIMER), 'OnCalendar=minutely\n');
  const terceira = rodarInstalar(home);
  assert.deepEqual(terceira.r.unidades, { [UNIDADE_SERVICE]: false, [UNIDADE_TIMER]: true });
  assert.equal(fs.readFileSync(unitEm(home, UNIDADE_TIMER), 'utf8'), unidadesSystemd({ node: NODE, raiz: RAIZ })[UNIDADE_TIMER]);
  assert.deepEqual(fs.readFileSync(chave), antes.chave);

  const outroNode = rodarInstalar(home, { extra: { node: '/opt/node-24/bin/node' } });
  assert.deepEqual(outroNode.r.unidades, { [UNIDADE_SERVICE]: true, [UNIDADE_TIMER]: false }, 'node atualizado: só o service muda');
});

test('trocar o remoto (unit antiga com achadinhoturbo-backups → pasta com espaço): regrava só o service e não toca na chave', () => {
  const home = tmp();
  rodarInstalar(home, { extra: { remoto: 'gdrive:achadinhoturbo-backups' } });
  // a unit que a versão anterior gravava: o mesmo texto, com o Environment= sem aspas
  const linhaAntiga = '\nEnvironment=BACKUP_REMOTO=gdrive:achadinhoturbo-backups\n';
  const unitAntiga = fs.readFileSync(unitEm(home, UNIDADE_SERVICE), 'utf8').replace('\nEnvironment="BACKUP_REMOTO=gdrive:achadinhoturbo-backups"\n', linhaAntiga);
  assert.ok(unitAntiga.includes(linhaAntiga));
  fs.writeFileSync(unitEm(home, UNIDADE_SERVICE), unitAntiga);
  const chave = chaveEm(home);
  const antes = { chave: fs.readFileSync(chave), st: fs.statSync(chave), timer: fs.statSync(unitEm(home, UNIDADE_TIMER)) };

  const { r } = rodarInstalar(home); // o padrão novo
  assert.deepEqual(r.unidades, { [UNIDADE_SERVICE]: true, [UNIDADE_TIMER]: false }, 'só o service muda');
  assert.equal(r.chaveCriada, false);
  const service = fs.readFileSync(unitEm(home, UNIDADE_SERVICE), 'utf8');
  assert.equal(service, unitAntiga.replace(linhaAntiga, '\nEnvironment="BACKUP_REMOTO=gdrive:Achadinho Turbo - Backups"\n'), 'a única linha que muda é a do remoto');
  assert.deepEqual(fs.readFileSync(chave), antes.chave, 'mesma chave');
  assert.equal(fs.statSync(chave).ino, antes.st.ino); assert.equal(fs.statSync(chave).mtimeMs, antes.st.mtimeMs);
  assert.equal(fs.statSync(unitEm(home, UNIDADE_TIMER)).mtimeMs, antes.timer.mtimeMs, 'o timer não foi regravado');

  const deNovo = rodarInstalar(home);
  assert.deepEqual(deNovo.r.unidades, { [UNIDADE_SERVICE]: false, [UNIDADE_TIMER]: false }, 'a terceira execução não regrava nada');
});

test('sem o remoto gdrive: aborta antes de criar qualquer coisa (nem pasta, nem chave, nem unit, nem systemctl)', () => {
  for (const stdout of ['pedro:\n', '', 'meugdrive:\npedro:\n', 'gdrive-velho:\n']) {
    const home = tmp();
    const falso = executorFalso({ 'rclone listremotes': { status: 0, stdout } });
    assert.throws(() => rodarInstalar(home, { falso }), ehErro(/o remoto gdrive: não existe no rclone/), JSON.stringify(stdout));
    assert.deepEqual(fs.readdirSync(home), [], 'home intacto');
    assert.ok(!falso.chamadas.some(([bin]) => bin === 'systemctl'));
  }
});

test('sem gpg, sem rclone ou com listremotes falhando: aborta antes de criar qualquer coisa', () => {
  const casos = [
    [{ 'gpg --version': { status: null, stdout: '' } }, /gpg não encontrado/],
    [{ 'gpg --version': { status: 2, stdout: '' } }, /gpg não encontrado/],
    [{ 'rclone listremotes': { status: null, stdout: '' } }, /rclone não encontrado/],
    [{ 'rclone listremotes': { status: 1, stdout: 'gdrive:\n' } }, /listremotes falhou/],
  ];
  for (const [respostas, re] of casos) {
    const home = tmp();
    const falso = executorFalso(respostas);
    assert.throws(() => rodarInstalar(home, { falso }), ehErro(re));
    assert.deepEqual(fs.readdirSync(home), []);
    assert.ok(!falso.chamadas.some(([bin]) => bin === 'systemctl'));
  }
  // executar que lança (programa ausente em outro executor) vale como "não encontrado"
  const home = tmp();
  assert.throws(() => instalar({ homeDir: home, raiz: RAIZ, node: NODE, saida: () => {}, executar: () => { throw new Error('ENOENT'); } }), ehErro(/gpg não encontrado/));
  assert.deepEqual(fs.readdirSync(home), []);
});

test('entrada inválida (homeDir, remoto, node) aborta antes de chamar qualquer programa', () => {
  const home = tmp();
  const falso = executorFalso();
  assert.throws(() => instalar({ raiz: RAIZ, node: NODE, executar: falso.executar, saida: () => {} }), ehErro(/homeDir/));
  assert.throws(() => instalar({ homeDir: 'relativo', raiz: RAIZ, node: NODE, executar: falso.executar, saida: () => {} }), ehErro(/homeDir/));
  assert.throws(() => rodarInstalar(home, { falso, extra: { remoto: 'gdrive:x\nExecStartPre=/bin/sh' } }), ehErro(/remoto inválido/));
  assert.throws(() => rodarInstalar(home, { falso, extra: { node: '/x/%h/node' } }), ehErro(/node precisa/));
  assert.deepEqual(falso.chamadas, []);
  assert.deepEqual(fs.readdirSync(home), []);
  // outro remoto: confere o nome dele no listremotes
  const outro = executorFalso({ 'rclone listremotes': { status: 0, stdout: 'gdrive:\n' } });
  assert.throws(() => rodarInstalar(tmp(), { falso: outro, extra: { remoto: 'pedro:backups' } }), ehErro(/o remoto pedro: não existe/));
});

test('pasta da chave aberta (0755) é corrigida para 0700; chave existente com 0644 vira 0600 sem mudar o conteúdo', () => {
  const home = tmp();
  const chave = chaveEm(home);
  fs.mkdirSync(path.dirname(chave), { recursive: true });
  fs.chmodSync(path.dirname(chave), 0o755);
  const original = 'a'.repeat(40) + '\n';
  fs.writeFileSync(chave, original, { mode: 0o644 });
  fs.chmodSync(chave, 0o644);
  const { r, saida } = rodarInstalar(home);
  assert.equal(modo(path.dirname(chave)), 0o700);
  assert.equal(modo(chave), 0o600);
  assert.equal(fs.readFileSync(chave, 'utf8'), original, 'a chave existente nunca é trocada');
  assert.equal(r.chaveCriada, false);
  assert.equal(r.pastaCorrigida, true);
  assert.equal(r.chavePermissaoCorrigida, true);
  assert.match(saida, /corrigi para 700/);
  assert.match(saida, /corrigi para 600/);
  assert.ok(!saida.includes('a'.repeat(32)), 'nem a chave antiga aparece');

  // pasta 0700 já certa: não é tocada nem anunciada
  const deNovo = rodarInstalar(home);
  assert.equal(deNovo.r.pastaCorrigida, false);
  assert.ok(!/corrigi/.test(deNovo.saida));
});

test('chave existente inválida: aborta sem trocá-la e sem gravar units; pasta no lugar da chave também aborta', () => {
  const home = tmp();
  const chave = chaveEm(home);
  fs.mkdirSync(path.dirname(chave), { recursive: true, mode: 0o700 });
  fs.writeFileSync(chave, 'curta\n', { mode: 0o600 });
  const falso = executorFalso();
  assert.throws(() => rodarInstalar(home, { falso }), ehErro(/existe, mas é inválida.*Não vou trocá-la/));
  assert.equal(fs.readFileSync(chave, 'utf8'), 'curta\n');
  assert.ok(!fs.existsSync(path.join(home, '.config/systemd')));
  assert.ok(!falso.chamadas.some(([bin]) => bin === 'systemctl'));

  const home2 = tmp();
  fs.mkdirSync(chaveEm(home2), { recursive: true });
  assert.throws(() => rodarInstalar(home2), ehErro(/inválida/));
});

test('systemctl falhando: daemon-reload ou enable abortam com mensagem fixa; list-timers falho só avisa', () => {
  const home = tmp();
  assert.throws(() => rodarInstalar(home, { respostas: { 'systemctl --user': { status: 1, stdout: '' } } }), ehErro(/daemon-reload falhou/));
  assert.ok(fs.existsSync(chaveEm(home)), 'a chave criada fica (a próxima execução a mantém)');
  const falso = executorFalso();
  const executar = (bin, args) => (args.includes('enable') ? { status: 1, stdout: '' } : falso.executar(bin, args));
  assert.throws(() => instalar({ homeDir: home, raiz: RAIZ, node: NODE, executar, saida: () => {} }), ehErro(/não consegui ligar o timer/));
  const { saida } = rodarInstalar(home, { respostas: { listTimers: { status: 1, stdout: '' } } });
  assert.match(saida, /Para ver a próxima execução: systemctl --user list-timers achadinhoturbo-backup\.timer/);
});

test('CLI: node scripts/backup-instalar.js usa o HOME, mostra o caminho e nunca a chave; sem gdrive: sai com 1 sem criar nada', () => {
  const bin = tmp();
  const registro = path.join(bin, 'chamadas.log');
  const falso = (nome, corpo) => {
    const p = path.join(bin, nome);
    fs.writeFileSync(p, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(registro)}, ${JSON.stringify(nome)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n${corpo}\n`);
    fs.chmodSync(p, 0o755);
  };
  falso('gpg', '');
  falso('rclone', "process.stdout.write(process.env.REMOTOS_FALSOS || '');");
  falso('systemctl', "if (process.argv.includes('list-timers')) process.stdout.write('NEXT LEFT UNIT\\nSun 2026-11-09 03:04:00 10h achadinhoturbo-backup.timer\\n');");
  const rodarCli = (home, remotos) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, REMOTOS_FALSOS: remotos, BACKUP_REMOTO: '' },
    encoding: 'utf8', timeout: 30_000,
  });

  const home = tmp();
  const r = rodarCli(home, 'gdrive:\npedro:\n');
  assert.equal(r.status, 0, r.stderr);
  const chave = chaveEm(home);
  const segredo = fs.readFileSync(chave, 'utf8').trim();
  assert.equal(modo(chave), 0o600);
  assert.ok(r.stdout.includes(chave));
  assert.ok(!r.stdout.includes(segredo) && !r.stderr.includes(segredo));
  assert.ok(!fs.readFileSync(registro, 'utf8').includes(segredo.slice(0, 16)));
  assert.ok(fs.readFileSync(unitEm(home, UNIDADE_SERVICE), 'utf8').includes(`ExecStart=${process.execPath} --disable-warning`), 'node atual por caminho absoluto');
  assert.ok(fs.readFileSync(unitEm(home, UNIDADE_SERVICE), 'utf8').includes(`WorkingDirectory=${RAIZ}\n`));
  assert.ok(fs.readFileSync(unitEm(home, UNIDADE_SERVICE), 'utf8').includes('\nEnvironment="BACKUP_REMOTO=gdrive:Achadinho Turbo - Backups"\n'), 'BACKUP_REMOTO vazio: o padrão, entre aspas');
  assert.match(fs.readFileSync(registro, 'utf8'), /^systemctl --user enable --now achadinhoturbo-backup\.timer$/m);

  const vazio = tmp();
  fs.rmSync(registro, { force: true });
  const sem = rodarCli(vazio, 'pedro:\n');
  assert.equal(sem.status, 1);
  assert.match(sem.stderr, /Falha ao instalar o backup automático: o remoto gdrive: não existe no rclone/);
  assert.deepEqual(fs.readdirSync(vazio), []);
  assert.ok(!/systemctl/.test(fs.readFileSync(registro, 'utf8')));
});

// ---------- QA (rodada 1) ----------

test('CLI: rodar o script por um caminho com link simbólico para o projeto instala do mesmo jeito (não pode sair mudo, com código 0, sem fazer nada)', () => {
  const bin = tmp();
  for (const nome of ['gpg', 'rclone', 'systemctl']) {
    const p = path.join(bin, nome);
    fs.writeFileSync(p, `#!${process.execPath}\nif (process.argv[2] === 'listremotes') process.stdout.write('gdrive:\\n');\n`, { mode: 0o755 });
  }
  const casa = tmp(); const ponte = tmp();
  fs.symlinkSync(RAIZ, path.join(ponte, 'projeto'));
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ponte, 'projeto', 'scripts', 'backup-instalar.js')], {
    env: { ...process.env, HOME: casa, PATH: `${bin}:${process.env.PATH}`, BACKUP_REMOTO: '' }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(chaveEm(casa)), 'a chave foi criada');
  assert.ok(fs.existsSync(unitEm(casa, UNIDADE_TIMER)), 'o timer foi gravado');
  assert.match(r.stdout, /IMPORTANTE: copie a chave/);
});

test('instalar: ~/.config/systemd/user que é um arquivo falha com erro de sistema, sem units, e a chave criada antes não é trocada na segunda tentativa', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.config/systemd'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/systemd/user'), 'sou um arquivo');
  const falhou = (e) => ['EEXIST', 'ENOTDIR'].includes(e.code);
  assert.throws(() => rodarInstalar(home), falhou);
  const chave = chaveEm(home);
  const antes = fs.readFileSync(chave, 'utf8');
  assert.match(antes, /^[0-9a-f]{64}\n$/, 'a chave criada antes da falha das units fica');
  assert.throws(() => rodarInstalar(home), falhou);
  assert.equal(fs.readFileSync(chave, 'utf8'), antes, 'a segunda tentativa não troca a chave');
  assert.equal(fs.readFileSync(path.join(home, '.config/systemd/user'), 'utf8'), 'sou um arquivo');
});
