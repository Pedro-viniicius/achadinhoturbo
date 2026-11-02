// Conexão com o WhatsApp (Business ou comum) como "aparelho conectado", via Baileys.
// É uma conexão NÃO oficial: funciona em grupos, mas o WhatsApp pode restringir o número
// se detectar comportamento de robô. Por isso as pausas entre mensagens (Ajustes).
//
// Além de enviar, registra o que acontece nos grupos: quem entrou (pelo link ou adicionado),
// quem saiu (ou foi removido) e quem leu as suas mensagens. É a base da Visão Geral.

import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import pino from 'pino';
import { IMAGEM_PERMITIDA } from './ml.js';

const SYNC_MS = 10 * 60 * 1000;
/** 5511999999999:12@s.whatsapp.net -> 5511999999999@s.whatsapp.net */
export const bareJid = (j) => String(j || '').replace(/:\d+@/, '@');
/** Formas pelas quais a mesma pessoa pode aparecer (número ou LID). */
const idsOf = (p) => [p?.id, p?.lid, p?.phoneNumber, p?.jid].filter(Boolean).map(bareJid);
export const sameUser = (a, b) => { const A = idsOf(a); return idsOf(b).some((x) => A.includes(x)); };
/** Identificador estável para guardar: prefere o número, senão o id (LID). */
export const participantId = (p) => bareJid(typeof p === 'string' ? p : (p?.phoneNumber || p?.id || ''));
/** Dia do calendário local (YYYY-MM-DD): o padrão de `diaDe` quando ninguém passa a virada do dia. */
const diaDoCalendario = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * Valida uma enquete e devolve no formato do Baileys ({ name, values, selectableCount }).
 * 2 a 12 opções, sem repetir (ignora maiúsculas e espaços nas pontas). Uma escolha = 1; múltipla = 0.
 * Exportada para quem cria o envio validar com a mesma regra de quem envia.
 */
export function montarEnquete({ pergunta, opcoes, multipla } = {}) {
  const name = String(pergunta ?? '').trim();
  if (!name) throw new Error('A enquete precisa de uma pergunta.');
  if (!Array.isArray(opcoes) || opcoes.length < 2 || opcoes.length > 12) throw new Error('A enquete precisa de 2 a 12 opções.');
  const values = opcoes.map((o) => String(o ?? '').trim());
  if (values.some((v) => !v)) throw new Error('A enquete tem opção vazia.');
  if (new Set(values.map((v) => v.toLocaleLowerCase('pt-BR'))).size !== values.length) throw new Error('A enquete tem opções repetidas.');
  return { name, values, selectableCount: multipla ? 0 : 1 };
}

/** Só dígitos, sem zeros à esquerda e com o 55 quando vier só DDD + número (10 ou 11 dígitos). */
export function normalizarNumero(digitos) {
  let d = String(digitos ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  // a mensagem não repete o número: pode acabar num log
  if (d.length < 12 || d.length > 15) throw new Error('Número inválido: informe DDD e número.');
  return d;
}

const LARGURA_MINIATURA = 192; // a mesma da prévia do Baileys (linkPreviewImageThumbnailWidth)
const MAX_IMAGEM_PREVIA = 5 * 1024 * 1024;
const hostDe = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

/**
 * Prévia do link: aceita uma URL ou { url, title, description, image }, com image em Buffer ou URL https.
 * Sem URL (nem na prévia nem no texto), não há prévia.
 */
function normalizarPrevia(text, previa) {
  const p = typeof previa === 'string' ? { url: previa } : (previa && typeof previa === 'object' ? previa : {});
  const noTexto = String(text ?? '').match(/https?:\/\/\S+/i)?.[0] || '';
  const url = String(p.url || '').trim() || noTexto;
  if (!url) return null;
  return {
    url, noTexto: noTexto || url,
    title: String(p.title || '').trim() || hostDe(url) || url,
    description: p.description ? String(p.description) : undefined,
    image: p.image || undefined,
  };
}

/** Baixa a imagem da prévia: só https do CDN do Mercado Livre (mlstatic), sem seguir redirecionamento, até 5 MB e 5 s. */
async function baixarImagem(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('a imagem da prévia precisa ser https');
  // a regra mora aqui, não só em quem chama: nenhum caminho baixa imagem de outro host (SSRF)
  if (!IMAGEM_PERMITIDA.test(u.href)) throw new Error('a imagem da prévia só pode vir do Mercado Livre (mlstatic)');
  const r = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!/^image\//i.test(r.headers.get('content-type') || '')) throw new Error('o endereço não é uma imagem');
  const partes = []; let total = 0;
  for await (const parte of r.body) {
    total += parte.length;
    if (total > MAX_IMAGEM_PREVIA) throw new Error('imagem grande demais');
    partes.push(parte);
  }
  return Buffer.concat(partes);
}

/**
 * Monta o linkPreview do Baileys sem o link-preview-js (que não está instalado e buscaria páginas de terceiros).
 * A miniatura sai do extractImageThumb do Baileys (precisa do sharp ou do jimp); se falhar, a prévia vai sem imagem.
 */
async function montarLinkPreview(previa) {
  const info = { 'canonical-url': previa.url, 'matched-text': previa.noTexto, title: previa.title };
  if (previa.description) info.description = previa.description;
  if (previa.image) {
    try {
      const bytes = Buffer.isBuffer(previa.image) ? previa.image : await baixarImagem(String(previa.image));
      const { extractImageThumb } = await import('@whiskeysockets/baileys');
      info.jpegThumbnail = (await extractImageThumb(bytes, LARGURA_MINIATURA)).buffer;
    } catch (e) {
      console.warn('[prévia] enviando sem miniatura:', e.message);
    }
  }
  return info;
}

/**
 * `diaDe(ts)` → 'YYYY-MM-DD': o dia em que uma leitura conta (uma por pessoa por dia). O servidor passa o dia de negócio
 * (com a virada do dia de Relatórios e avisos); sem ele, vale o dia do calendário.
 */
export function createWhatsApp({ db, dir, dryRun = false, pseudo = (id) => id, diaDe = diaDoCalendario }) {
  const authDir = path.join(dir, 'wa_auth');
  const state = { status: 'idle', qr: null, me: null, error: null };
  let sock = null; let starting = false; let stopped = false; let syncTimer = null;
  const simulated = []; // mensagens "enviadas" no modo simulação

  const upsertGroup = db.prepare(`INSERT INTO groups (jid, name, size, updated_at, is_admin, description) VALUES (?,?,?,?,?,?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name, size = excluded.size, updated_at = excluded.updated_at,
      is_admin = excluded.is_admin, description = excluded.description`);
  const insEvent = db.prepare('INSERT INTO group_events (ts, jid, participant, action, by_link, actor) VALUES (?,?,?,?,?,?)');
  const bumpSize = db.prepare('UPDATE groups SET size = MAX(0, COALESCE(size, 0) + ?), updated_at = ? WHERE jid = ?');
  const insRead = db.prepare('INSERT OR IGNORE INTO group_reads (jid, participant, day, ts) VALUES (?,?,?,?)');

  const meInfo = () => ({ id: sock?.user?.id, lid: sock?.user?.lid });

  async function syncGroups() {
    if (dryRun) return;
    const all = await sock.groupFetchAllParticipating();
    const list = Object.values(all);
    const me = meInfo();
    db.exec('BEGIN');
    try {
      const now = Date.now();
      for (const g of list) {
        const mine = (g.participants || []).find((p) => sameUser(p, me));
        const admin = mine ? (mine.admin === 'admin' || mine.admin === 'superadmin' || mine.isAdmin || mine.isSuperAdmin ? 1 : 0) : null;
        upsertGroup.run(g.id, g.subject || g.id, g.size ?? g.participants?.length ?? null, now, admin, g.desc || null);
      }
      const keep = list.map((g) => g.id);
      if (keep.length) db.prepare(`DELETE FROM groups WHERE jid NOT IN (${keep.map(() => '?').join(',')})`).run(...keep);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  /** Registra entradas e saídas. `add` com autor = a própria pessoa é "entrou pelo link"; `remove` com autor = a própria pessoa é "saiu". */
  function onParticipants({ id, author, authorPn, participants, action }) {
    if (!['add', 'remove'].includes(action)) return;
    const now = Date.now();
    const autor = { id: author, phoneNumber: authorPn };
    for (const p of participants || []) {
      const pid = participantId(p);
      if (!pid) continue;
      const self = !author || sameUser(autor, p);
      // guarda pseudônimos, não números (LGPD): ver src/privacidade.js
      insEvent.run(now, id, pseudo(pid), action, action === 'add' && self ? 1 : 0, self ? null : pseudo(participantId(autor)));
    }
    bumpSize.run(action === 'add' ? participants.length : -participants.length, now, id);
  }

  /** Recibo de leitura de uma mensagem nossa num grupo: conta uma vez por pessoa por dia. */
  function onReceipts(updates) {
    const now = Date.now();
    for (const u of updates || []) {
      const jid = u.key?.remoteJid; const who = u.receipt?.userJid;
      if (!jid || !jid.endsWith('@g.us') || !u.key?.fromMe || !who) continue;
      if (!(u.receipt.readTimestamp || u.receipt.playedTimestamp)) continue;
      const ts = Number(u.receipt.readTimestamp || u.receipt.playedTimestamp) * 1000 || now;
      insRead.run(jid, pseudo(bareJid(who)), diaDe(ts), ts);
    }
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
      sock.ev.on('group-participants.update', (u) => { try { onParticipants(u); } catch (e) { console.error('[grupos]', e.message); } });
      sock.ev.on('message-receipt.update', (u) => { try { onReceipts(u); } catch (e) { console.error('[leituras]', e.message); } });
      sock.ev.on('groups.update', (list) => {
        for (const g of list || []) {
          if (!g.id) continue;
          if (g.subject) db.prepare('UPDATE groups SET name = ? WHERE jid = ?').run(g.subject, g.id);
          if (g.size != null) db.prepare('UPDATE groups SET size = ? WHERE jid = ?').run(g.size, g.id);
        }
      });
      sock.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) { state.status = 'qr'; state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 }); }
        if (connection === 'open') {
          state.status = 'open'; state.qr = null; state.error = null; state.me = sock?.user?.id || null;
          syncGroups().catch((e) => { state.error = 'Não consegui listar os grupos: ' + e.message; });
          clearInterval(syncTimer); syncTimer = setInterval(() => syncGroups().catch(() => {}), SYNC_MS);
        }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          sock = null; state.qr = null; clearInterval(syncTimer); syncTimer = null;
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

  async function logout({ apagarEventos = false } = {}) {
    stopped = true; clearInterval(syncTimer); syncTimer = null;
    try { await sock?.logout(); } catch { /* já caiu */ }
    sock = null;
    fs.rmSync(authDir, { recursive: true, force: true });
    state.status = 'idle'; state.qr = null; state.me = null;
    db.exec('DELETE FROM groups');
    if (apagarEventos) db.exec('DELETE FROM group_events; DELETE FROM group_reads; DELETE FROM link_clicks;');
  }

  const isReady = () => state.status === 'open' && (dryRun || !!sock);

  /**
   * Texto, com prévia do link opcional ({ previa }: URL ou { url, title, description, image }).
   * Sem prévia vai `linkPreview: null`, para o Baileys não tentar carregar o link-preview-js.
   */
  async function sendText(jid, text, { previa } = {}) {
    const p = previa ? normalizarPrevia(text, previa) : null;
    if (dryRun) {
      const registro = { tipo: 'text', jid, text };
      if (p) registro.previa = { url: p.url, title: p.title, description: p.description, image: Buffer.isBuffer(p.image) ? { bytes: p.image.length } : p.image };
      simulated.push(registro); return;
    }
    if (!isReady()) throw new Error('WhatsApp desconectado');
    await sock.sendMessage(jid, { text, linkPreview: p ? await montarLinkPreview(p) : null });
  }

  /** Foto por URL (o Baileys baixa) ou por Buffer (upload), com legenda. */
  async function sendImage(jid, urlOuBuffer, caption, { mimetype } = {}) {
    const ehBuffer = Buffer.isBuffer(urlOuBuffer);
    if (ehBuffer ? !urlOuBuffer.length : !(typeof urlOuBuffer === 'string' && urlOuBuffer)) throw new Error('Imagem inválida.');
    if (mimetype != null && !/^image\/[\w.+-]+$/i.test(String(mimetype))) throw new Error('Tipo de imagem inválido.');
    if (dryRun) {
      const registro = { tipo: 'image', jid, text: caption, image: ehBuffer ? { bytes: urlOuBuffer.length } : urlOuBuffer };
      if (mimetype) registro.mimetype = mimetype;
      simulated.push(registro); return;
    }
    if (!isReady()) throw new Error('WhatsApp desconectado');
    await sock.sendMessage(jid, { image: ehBuffer ? urlOuBuffer : { url: urlOuBuffer }, caption, ...(mimetype ? { mimetype } : {}) });
  }

  /** Enquete ({ pergunta, opcoes, multipla }). Valida antes de tudo, também no modo simulado. */
  async function sendPoll(jid, enquete) {
    const poll = montarEnquete(enquete);
    if (dryRun) { simulated.push({ tipo: 'poll', jid, text: poll.name, poll }); return; }
    if (!isReady()) throw new Error('WhatsApp desconectado');
    await sock.sendMessage(jid, { poll });
  }

  /**
   * Acha o JID canônico de um número (no Brasil, resolve o 9º dígito): { jid, existe }.
   * Se o WhatsApp não conhece o número, devolve o JID montado com existe: false.
   */
  async function resolverNumero(digitos) {
    const d = normalizarNumero(digitos);
    const montado = `${d}@s.whatsapp.net`;
    if (dryRun) return { jid: montado, existe: true };
    if (!isReady()) throw new Error('WhatsApp desconectado');
    const [achado] = (await sock.onWhatsApp(d)) || [];
    return achado?.exists && achado.jid ? { jid: bareJid(achado.jid), existe: true } : { jid: montado, existe: false };
  }

  /** Busca o link de convite do grupo (exige ser admin) e guarda. */
  async function fetchInvite(jid) {
    if (dryRun) { const code = 'SIMULADO' + jid.replace(/\D/g, '').slice(-6); db.prepare('UPDATE groups SET invite_code = ? WHERE jid = ?').run(code, jid); return code; }
    if (!isReady()) throw new Error('WhatsApp desconectado');
    let code;
    try { code = await sock.groupInviteCode(jid); } catch (e) {
      throw new Error(/not-authorized|forbidden|401|403/i.test(e.message) ? 'Seu número não é admin deste grupo. Peça o link a um admin e cole aqui.' : 'Não consegui buscar o convite: ' + e.message);
    }
    if (!code) throw new Error('Seu número não é admin deste grupo. Peça o link a um admin e cole aqui.');
    db.prepare('UPDATE groups SET invite_code = ?, is_admin = 1 WHERE jid = ?').run(code, jid);
    return code;
  }

  /**
   * Cria o próximo grupo a partir de um que lotou: mesmo nome (número seguinte), descrição, foto,
   * permissões e admins. Devolve { jid, invite_code, admins_adicionados, admins_nao_adicionados }.
   * É uma ação sensível para o número: só roda quando você confirma no painel.
   */
  async function createNextGroup(sourceJid, name) {
    const now = Date.now();
    if (dryRun) {
      const jid = `${Date.now()}@g.us`; const code = 'SIMULADO' + String(now).slice(-6);
      db.prepare('INSERT INTO groups (jid, name, size, updated_at, is_admin, invite_code) VALUES (?,?,?,?,?,?)').run(jid, name, 1, now, 1, code);
      return { jid, invite_code: code, admins_adicionados: [], admins_nao_adicionados: [] };
    }
    if (!isReady()) throw new Error('WhatsApp desconectado');
    const src = await sock.groupMetadata(sourceJid);
    const me = meInfo();
    const admins = (src.participants || []).filter((p) => (p.admin || p.isAdmin || p.isSuperAdmin) && !sameUser(p, me)).map((p) => p.phoneNumber || p.id);
    const novo = await sock.groupCreate(name, admins);
    const jid = novo.id;
    const falhas = [];
    const tentar = async (rotulo, fn) => { try { await fn(); } catch (e) { falhas.push(`${rotulo}: ${e.message}`); } };
    if (src.desc) await tentar('descrição', () => sock.groupUpdateDescription(jid, src.desc));
    await tentar('foto', async () => { const url = await sock.profilePictureUrl(sourceJid, 'image'); if (url) await sock.updateProfilePicture(jid, { url }); });
    if (src.announce) await tentar('só admins enviam', () => sock.groupSettingUpdate(jid, 'announcement'));
    if (src.restrict) await tentar('só admins editam', () => sock.groupSettingUpdate(jid, 'locked'));
    const presentes = new Set((novo.participants || []).map((p) => bareJid(p.phoneNumber || p.id)));
    const adicionados = admins.filter((a) => presentes.has(bareJid(a)));
    if (adicionados.length) await tentar('promover admins', () => sock.groupParticipantsUpdate(jid, adicionados, 'promote'));
    let code = null;
    await tentar('convite', async () => { code = await sock.groupInviteCode(jid); });
    db.prepare(`INSERT INTO groups (jid, name, size, updated_at, is_admin, invite_code, description) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(jid) DO UPDATE SET name = excluded.name, size = excluded.size, updated_at = excluded.updated_at, is_admin = 1, invite_code = excluded.invite_code, description = excluded.description`)
      .run(jid, name, novo.size ?? (novo.participants?.length || 1), now, 1, code, src.desc || null);
    return { jid, invite_code: code, admins_adicionados: adicionados, admins_nao_adicionados: admins.filter((a) => !presentes.has(bareJid(a))), avisos: falhas };
  }

  return {
    state: () => ({ ...state }), isReady, connect, logout, syncGroups, sendText, sendImage, sendPoll, resolverNumero,
    fetchInvite, createNextGroup, simulated,
    // usados nos testes para simular eventos do WhatsApp e conferir o que vai ao Baileys
    _onParticipants: onParticipants, _onReceipts: onReceipts,
    _usarSocket: (falso) => { sock = falso; state.status = 'open'; },
    // reconecta sozinho ao abrir o programa se já houver sessão salva
    autoStart: () => { if (!dryRun && fs.existsSync(path.join(authDir, 'creds.json'))) connect(); },
  };
}
