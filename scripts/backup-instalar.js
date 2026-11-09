// Instalador do backup automático (npm run backup:instalar). Pode rodar quantas vezes quiser:
//   1. confere gpg, rclone e o remoto do Drive (`rclone listremotes`); sem eles, para antes de criar qualquer coisa;
//   2. cria a chave do backup só se ela faltar (32 bytes aleatórios, arquivo 0600 numa pasta 0700, nunca sobrescreve);
//   3. grava as units de usuário do systemd (service + timer diário) só quando o conteúdo mudou;
//   4. roda daemon-reload, enable --now do timer e mostra a próxima execução.
// A saída mostra o CAMINHO da chave, nunca o conteúdo. O stderr dos programas é descartado (mensagens fixas).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../src/config.js';
import { CHAVE_PADRAO, REMOTO_PADRAO, RE_REMOTO, ErroBackup, comando, lerChave } from './backup.js';

export const UNIDADE_SERVICE = 'achadinhoturbo-backup.service';
export const UNIDADE_TIMER = 'achadinhoturbo-backup.timer';
export const HORARIO_PADRAO = '03:00';
/** Caminho da chave relativo ao home: o mesmo que o `auto` lê (`CHAVE_PADRAO`). */
export const CHAVE_RELATIVA = path.relative(os.homedir(), CHAVE_PADRAO);

export class ErroInstalar extends Error {
  constructor(msg) { super(msg); this.name = 'ErroInstalar'; }
}

// Vão para dentro das units: nada de quebra de linha, aspas, barra invertida, `%` (especificador do systemd) nem `$`.
const PROIBIDO_NA_UNIT = /[\x00-\x1f\x7f"'\\%$;]/;
const RE_HORARIO = /^([01]\d|2[0-3]):[0-5]\d$/;

function caminhoParaUnit(nome, valor) {
  if (typeof valor !== 'string' || !path.isAbsolute(valor) || PROIBIDO_NA_UNIT.test(valor)) {
    throw new ErroInstalar(`${nome} precisa ser um caminho absoluto sem aspas, %, $ ou quebra de linha.`);
  }
  return valor;
}
const comAspas = (s) => (/\s/.test(s) ? `"${s}"` : s);

/** Nome do remoto do rclone (`gdrive:` em `gdrive:Achadinho Turbo - Backups`). */
export function nomeDoRemoto(remoto) {
  if (typeof remoto !== 'string' || !RE_REMOTO.test(remoto)) throw new ErroInstalar('remoto inválido: use o formato nome:pasta (ex.: "gdrive:Achadinho Turbo - Backups").');
  return remoto.slice(0, remoto.indexOf(':') + 1);
}

/**
 * Texto das duas units (função pura). O service roda `scripts/backup.js auto` uma vez (`Type=oneshot`), com baixa
 * prioridade e prazo de 1 h (3 envios de até 10 min + as esperas de 2 e 10 min cabem nele) e `UMask=0077` (tudo o que
 * ele cria, inclusive as pastas temporárias, é só do dono). O timer é diário, com
 * `Persistent=true`: se o PC estava desligado no horário, roda ao ligar. Nenhum segredo vai para as units.
 * O `Environment=` vai sempre entre aspas duplas: sem elas, o systemd parte o valor nos espaços da pasta do Drive. O
 * `RE_REMOTO` já recusa aspas, `\`, `%`, `$` e quebra de linha, então o valor entra sem escape.
 */
export function unidadesSystemd({ node, raiz, remoto = REMOTO_PADRAO, horario = HORARIO_PADRAO } = {}) {
  caminhoParaUnit('node', node);
  caminhoParaUnit('raiz', raiz);
  nomeDoRemoto(remoto);
  if (typeof horario !== 'string' || !RE_HORARIO.test(horario)) throw new ErroInstalar('horário inválido: use HH:MM (ex.: 03:00).');
  const cabecalho = '# Gerado por npm run backup:instalar. Para mudar, rode o instalador de novo em vez de editar.\n';
  const service = `${cabecalho}[Unit]
Description=achadinhoturbo: backup diário (local + cópia cifrada no Drive)

[Service]
Type=oneshot
WorkingDirectory=${raiz}
ExecStart=${comAspas(node)} --disable-warning=ExperimentalWarning scripts/backup.js auto
Environment="BACKUP_REMOTO=${remoto}"
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=1h
UMask=0077
`;
  const timer = `${cabecalho}[Unit]
Description=achadinhoturbo: backup diário às ${horario}

[Timer]
OnCalendar=*-*-* ${horario}
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { [UNIDADE_SERVICE]: service, [UNIDADE_TIMER]: timer };
}

/** Executor padrão: `(bin, args) => { status, stdout }`, sem shell, stderr descartado, prazo de 1 min. */
export function executarPadrao(bin, args) {
  return comando(bin, { timeout: 60_000 })(args);
}

function rodar(executar, bin, args) {
  try { return executar(bin, args) || { status: null, stdout: '' }; } catch { return { status: null, stdout: '' }; }
}

/** Cria a pasta da chave (0700) ou corrige a permissão dela. Devolve `true` se precisou corrigir. */
function prepararPasta(pasta) {
  fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
  const st = fs.statSync(pasta);
  if (!st.isDirectory()) throw new ErroInstalar(`${pasta} existe e não é uma pasta.`);
  if ((st.mode & 0o777) === 0o700) return false;
  fs.chmodSync(pasta, 0o700);
  return true;
}

/**
 * Cria a chave só se ela faltar (`flag 'wx'`: nunca sobrescreve, nem numa corrida). Se já existe, só confere: com
 * permissão aberta, fecha para 0600; inválida (menos de 32 caracteres), para sem tocar nela.
 */
function prepararChave(arquivo) {
  const segredo = crypto.randomBytes(32);
  const conteudo = Buffer.from(`${segredo.toString('hex')}\n`);
  let criada = false;
  try {
    fs.writeFileSync(arquivo, conteudo, { flag: 'wx', mode: 0o600 });
    criada = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw new ErroInstalar(`não consegui criar a chave em ${arquivo}.`);
  } finally { segredo.fill(0); conteudo.fill(0); }
  let permissaoCorrigida = false;
  const st = fs.statSync(arquivo);
  if (st.isFile() && (st.mode & 0o777) !== 0o600) { fs.chmodSync(arquivo, 0o600); permissaoCorrigida = !criada; }
  try { lerChave(arquivo); } catch (e) {
    if (e instanceof ErroBackup) throw new ErroInstalar(`a chave em ${arquivo} existe, mas é inválida (precisa ser um arquivo com pelo menos 32 caracteres na 1ª linha). Não vou trocá-la: as cópias já enviadas ao Drive dependem dela. Confira o arquivo.`);
    throw e;
  }
  return { criada, permissaoCorrigida };
}

/** Grava a unit só se o conteúdo mudou (arquivo temporário + rename). Devolve `true` se gravou. */
function gravarSeMudou(arquivo, texto) {
  let atual = null;
  try { atual = fs.readFileSync(arquivo, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (atual === texto) return false;
  const tmp = `${arquivo}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, texto, { mode: 0o644 });
    fs.renameSync(tmp, arquivo);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  return true;
}

/**
 * Instala (ou confere) o backup automático. `executar(bin, args)` roda gpg/rclone/systemctl e devolve
 * `{ status, stdout }`; `saida(linha)` recebe cada linha para o terminal. Lança `ErroInstalar` com mensagem fixa.
 */
export function instalar({
  homeDir, raiz = ROOT, executar = executarPadrao, saida = console.log,
  node = process.execPath, remoto = REMOTO_PADRAO, horario = HORARIO_PADRAO,
} = {}) {
  if (!homeDir || !path.isAbsolute(homeDir)) throw new ErroInstalar('homeDir é obrigatório (caminho absoluto).');
  // Tudo o que pode dar errado sem tocar no disco vem antes: units, gpg, rclone e o remoto.
  const unidades = unidadesSystemd({ node, raiz, remoto, horario });
  const nomeRemoto = nomeDoRemoto(remoto);

  if (rodar(executar, 'gpg', ['--version']).status !== 0) {
    throw new ErroInstalar('gpg não encontrado. Instale com: sudo apt install gnupg');
  }
  const lista = rodar(executar, 'rclone', ['listremotes']);
  if (lista.status == null) throw new ErroInstalar('rclone não encontrado. Instale com: sudo apt install rclone');
  if (lista.status !== 0) throw new ErroInstalar('o rclone não conseguiu listar os remotos (rclone listremotes falhou).');
  const remotos = String(lista.stdout || '').split('\n').map((l) => l.trim());
  if (!remotos.includes(nomeRemoto)) {
    throw new ErroInstalar(`o remoto ${nomeRemoto} não existe no rclone. Crie com: rclone config (tipo "drive", nome "${nomeRemoto.slice(0, -1)}") e rode de novo.`);
  }
  saida(`gpg e rclone ok; remoto ${nomeRemoto} encontrado.`);

  // Chave
  const chave = path.join(homeDir, CHAVE_RELATIVA);
  const pastaCorrigida = prepararPasta(path.dirname(chave));
  if (pastaCorrigida) saida(`A pasta ${path.dirname(chave)} estava aberta para outros usuários: corrigi para 700.`);
  const { criada, permissaoCorrigida } = prepararChave(chave);
  if (permissaoCorrigida) saida(`A chave estava com permissão aberta: corrigi para 600.`);
  saida(criada ? `Chave do backup criada em ${chave}.` : `Chave do backup já existia em ${chave}: mantida.`);

  // Units
  const pastaUnits = path.join(homeDir, '.config/systemd/user');
  fs.mkdirSync(pastaUnits, { recursive: true });
  const gravadas = {};
  for (const [nome, texto] of Object.entries(unidades)) {
    gravadas[nome] = gravarSeMudou(path.join(pastaUnits, nome), texto);
    saida(gravadas[nome] ? `Unit ${nome} gravada.` : `Unit ${nome} sem mudança.`);
  }

  if (rodar(executar, 'systemctl', ['--user', 'daemon-reload']).status !== 0) {
    throw new ErroInstalar('systemctl --user daemon-reload falhou. Rode-o à mão e depois rode o instalador de novo.');
  }
  if (rodar(executar, 'systemctl', ['--user', 'enable', '--now', UNIDADE_TIMER]).status !== 0) {
    throw new ErroInstalar(`não consegui ligar o timer. Veja: systemctl --user status ${UNIDADE_TIMER}`);
  }
  const timers = rodar(executar, 'systemctl', ['--user', 'list-timers', UNIDADE_TIMER, '--no-pager']);
  if (timers.status === 0 && String(timers.stdout || '').trim()) saida(String(timers.stdout).trimEnd());
  else saida(`Timer ligado. Para ver a próxima execução: systemctl --user list-timers ${UNIDADE_TIMER}`);
  saida(`O backup roda todo dia às ${horario} (com até 10 min de folga). Se o PC estiver desligado nesse horário, roda ao ligar.`);
  saida('Se atualizar o Node.js, rode npm run backup:instalar de novo (a unit guarda o caminho do node).');

  saida('');
  saida('IMPORTANTE: copie a chave do backup para o seu gerenciador de senhas.');
  saida(`  Ela fica em ${chave}.`);
  saida('  Sem ela, as cópias do Google Drive NÃO abrem: se este computador se perder, a chave vai junto.');
  saida('  Abra o arquivo no seu próprio terminal para copiar; não cole a chave em chat, e-mail nem no Drive.');

  return { chave, chaveCriada: criada, pastaCorrigida, chavePermissaoCorrigida: permissaoCorrigida, unidades: gravadas };
}

/** Caminho real (links simbólicos resolvidos); o próprio caminho se não der para resolver. */
function real(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

// O node resolve os links do script principal no import.meta.url, mas não no argv[1]: compara os dois já resolvidos.
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  try {
    instalar({ homeDir: os.homedir(), remoto: process.env.BACKUP_REMOTO || REMOTO_PADRAO });
  } catch (e) {
    // ErroInstalar tem mensagem fixa (no máximo o caminho da chave); de qualquer outro erro só sai o código (EACCES…)
    const codigo = typeof e?.code === 'string' && /^[A-Z_]{2,20}$/.test(e.code) ? ` (${e.code})` : '';
    console.error(`Falha ao instalar o backup automático: ${e instanceof ErroInstalar ? e.message : `erro inesperado ao gravar a chave ou as units${codigo}.`}`);
    process.exitCode = 1;
  }
}
