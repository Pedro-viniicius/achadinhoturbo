// Backup do Disparador ML.
//   node scripts/backup.js [pasta-destino]                       cria disparador-<data>.tar.gz e mantém os 7 mais recentes
//   node scripts/backup.js restaurar <arquivo.tar.gz> <pasta>    extrai e roda PRAGMA integrity_check
// O banco é copiado com VACUUM INTO (seguro com o programa rodando e com o WAL ativo).
// ATENÇÃO: o pacote inclui data/wa_auth, a sessão do seu WhatsApp. Guarde com o mesmo cuidado de uma senha.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../src/config.js';

export function fazerBackup(dataDir, destDir, manter = 7) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'disparador-backup-'));
  try {
    const dbPath = path.join(dataDir, 'disparador.db');
    if (!fs.existsSync(dbPath)) throw new Error(`banco não encontrado em ${dbPath}`);
    const db = new DatabaseSync(dbPath);
    try { db.exec(`VACUUM INTO '${path.join(tmp, 'disparador.db').replace(/'/g, "''")}'`); } finally { db.close(); }
    const wa = path.join(dataDir, 'wa_auth');
    if (fs.existsSync(wa)) fs.cpSync(wa, path.join(tmp, 'wa_auth'), { recursive: true });
    const out = path.join(destDir, `disparador-${stamp}.tar.gz`);
    execFileSync('tar', ['-czf', out, '-C', tmp, '.']);
    fs.chmodSync(out, 0o600);
    const todos = fs.readdirSync(destDir).filter((f) => /^disparador-.*\.tar\.gz$/.test(f)).sort();
    for (const f of todos.slice(0, Math.max(0, todos.length - manter))) fs.rmSync(path.join(destDir, f));
    return out;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function restaurar(arquivo, destDir) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  execFileSync('tar', ['-xzf', arquivo, '-C', destDir]);
  const db = new DatabaseSync(path.join(destDir, 'disparador.db'), { readOnly: true });
  try {
    const r = db.prepare('PRAGMA integrity_check').get();
    const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return { integridade: r.integrity_check, regras: n('rules'), etiquetas: n('tags'), waAuth: fs.existsSync(path.join(destDir, 'wa_auth')) };
  } finally { db.close(); }
}

if (process.argv[1]?.endsWith('backup.js')) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'restaurar') {
      if (!a || !b) throw new Error('uso: backup.js restaurar <arquivo.tar.gz> <pasta-destino>');
      const r = restaurar(path.resolve(a), path.resolve(b));
      console.log(`Restaurado em ${path.resolve(b)}: integridade=${r.integridade}, regras=${r.regras}, etiquetas=${r.etiquetas}, sessão WhatsApp=${r.waAuth ? 'sim' : 'não'}`);
      if (r.integridade !== 'ok') process.exit(2);
    } else {
      const dest = path.resolve(cmd || process.env.BACKUP_DIR || path.join(DATA_DIR, '..', 'backups'));
      const out = fazerBackup(DATA_DIR, dest);
      console.log(`Backup gravado: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
    }
  } catch (e) { console.error('Falha no backup:', e.message); process.exit(1); }
}
