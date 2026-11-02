// Conexão com o WhatsApp (Business ou comum) como "aparelho conectado", via Baileys.
// É uma conexão NÃO oficial: funciona em grupos, mas o WhatsApp pode restringir o número
// se detectar comportamento de robô. Por isso as pausas entre mensagens (Ajustes).

import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import pino from 'pino';

export function createWhatsApp({ db, dir, dryRun = false }) {
  const authDir = path.join(dir, 'wa_auth');
  const state = { status: 'idle', qr: null, me: null, error: null };
  let sock = null; let starting = false; let stopped = false;
  const simulated = []; // mensagens "enviadas" no modo simulação

  const upsertGroup = db.prepare(`INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name, size = excluded.size, updated_at = excluded.updated_at`);

  async function syncGroups() {
    if (dryRun) return;
    const all = await sock.groupFetchAllParticipating();
    const list = Object.values(all);
    db.exec('BEGIN');
    try {
      const now = Date.now();
      for (const g of list) upsertGroup.run(g.id, g.subject || g.id, g.participants?.length ?? null, now);
      const keep = list.map((g) => g.id);
      if (keep.length) db.prepare(`DELETE FROM groups WHERE jid NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  async function connect() {
    if (dryRun) { state.status = 'open'; state.me = 'modo-simulacao'; return; }
    if (sock || starting) return;
    starting = true; stopped = false; state.status = 'connecting'; state.error = null;
    try {
      const baileys = await import('@whiskeysockets/baileys');
      const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
      const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
      const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
      let version; try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* usa a versão padrão da lib */ }
      sock = makeWASocket({
        ...(version ? { version } : {}),
        auth, logger: pino({ level: 'silent' }),
        markOnlineOnConnect: false, syncFullHistory: false,
      });
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) { state.status = 'qr'; state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 }); }
        if (connection === 'open') {
          state.status = 'open'; state.qr = null; state.error = null; state.me = sock?.user?.id || null;
          syncGroups().catch((e) => { state.error = 'Não consegui listar os grupos: ' + e.message; });
        }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          sock = null; state.qr = null;
          if (code === DisconnectReason.loggedOut) {
            fs.rmSync(authDir, { recursive: true, force: true });
            state.status = 'idle'; state.me = null;
            state.error = 'O aparelho foi desconectado pelo celular. Conecte de novo.';
          } else if (!stopped) {
            state.status = 'connecting';
            setTimeout(() => connect().catch(() => {}), 3000);
          }
        }
      });
    } catch (e) {
      sock = null; state.status = 'idle'; state.error = 'Falha ao iniciar o WhatsApp: ' + e.message;
    } finally { starting = false; }
  }

  async function logout() {
    stopped = true;
    try { await sock?.logout(); } catch { /* já caiu */ }
    sock = null;
    fs.rmSync(authDir, { recursive: true, force: true });
    state.status = 'idle'; state.qr = null; state.me = null;
    db.exec('DELETE FROM groups');
  }

  const isReady = () => state.status === 'open' && (dryRun || !!sock);

  async function sendText(jid, text) {
    if (dryRun) { simulated.push({ jid, text }); return; }
    if (!isReady()) throw new Error('WhatsApp desconectado');
    await sock.sendMessage(jid, { text });
  }

  async function sendImage(jid, url, caption) {
    if (dryRun) { simulated.push({ jid, text: caption, image: url }); return; }
    if (!isReady()) throw new Error('WhatsApp desconectado');
    await sock.sendMessage(jid, { image: { url }, caption });
  }

  return {
    state: () => ({ ...state }), isReady, connect, logout, syncGroups, sendText, sendImage, simulated,
    // reconecta sozinho ao abrir o programa se já houver sessão salva
    autoStart: () => { if (!dryRun && fs.existsSync(path.join(authDir, 'creds.json'))) connect(); },
  };
}
