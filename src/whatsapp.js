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

// A libsignal (usada pelo Baileys para a criptografia do WhatsApp) escreve no console global, fora do logger do
// Baileys, a sessão do Signal inteira ("Closing session:", <sessão>), com privKey, rootKey, chainKey e baseKey: num
// serviço do systemd isso iria para o journal (S1). O console do processo passa por um filtro: as frases da libsignal
// são descartadas e, em qualquer outra chamada, objeto com cara de material do Signal vira '[omitido]'. O resto
// (strings, números, erros) segue como está.
const FRASES_LIBSIGNAL = /^(?:Closing session|Opening session|Removing old closed session|Session already (?:closed|open)|Closing open session in favor|Closing stale open session|Migrating session to|Decrypted message with closed session|Session error|Failed to decrypt message|V1 session storage migration error)/;
const CHAVES_SIGNAL = new Set(['_chains', 'currentRatchet', 'indexInfo', 'pendingPreKey', 'ephemeralKeyPair', 'privKey',
  'rootKey', 'chainKey', 'baseKey', 'remoteIdentityKey', 'messageKeys', 'lastRemoteEphemeralKey']);
const PROTEGIDO = Symbol.for('achadinhoturbo.consoleProtegido');
const OMITIDO = '[omitido]';
const ehObjeto = (v) => v !== null && (typeof v === 'object' || typeof v === 'function');

/**
 * O argumento é (ou carrega, até 4 níveis abaixo) material de sessão do Signal? Um `SessionRecord` guarda as sessões
 * dois níveis abaixo. Na dúvida, sim: getter ou proxy que lança, ou objeto grande demais para olhar (mais de 1.000 nós).
 */
function pareceSessaoSignal(v) {
  let orcamento = 1000;
  const olhar = (x, nivel) => {
    if (!ehObjeto(x) || x instanceof Error || ArrayBuffer.isView(x) || x instanceof ArrayBuffer) return false;
    if (--orcamento < 0) return true;
    const chaves = Object.keys(x);
    if (chaves.some((k) => CHAVES_SIGNAL.has(k))) return true;
    return nivel < 4 && chaves.some((k) => olhar(x[k], nivel + 1));
  };
  try { return olhar(v, 0); } catch { return true; }
}

/**
 * Embrulha log/info/warn/error/debug/trace de `alvo` (o console global, por padrão) com o filtro acima. Idempotente.
 * O filtro nunca lança: se algo der errado nele, a chamada segue com todo objeto não-Error trocado por '[omitido]'.
 */
export function protegerConsole(alvo = console) {
  if (!alvo || alvo[PROTEGIDO]) return alvo;
  for (const nome of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const original = alvo[nome];
    if (typeof original !== 'function') continue;
    alvo[nome] = (...args) => {
      let saida;
      try {
        if (typeof args[0] === 'string' && FRASES_LIBSIGNAL.test(args[0])) return undefined;
        saida = args.some((a) => pareceSessaoSignal(a)) ? args.map((a) => (pareceSessaoSignal(a) ? OMITIDO : a)) : args;
      } catch {
        saida = args.map((a) => (ehObjeto(a) && !(a instanceof Error) ? OMITIDO : a));
      }
      return original.apply(alvo, saida);
    };
  }
  Object.defineProperty(alvo, PROTEGIDO, { value: true });
  return alvo;
}
protegerConsole(console);

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

/** Embrulhos do Baileys que guardam a mensagem de verdade em `.message` (temporária, visualização única). */
const EMBRULHOS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];
const temUrl = (t) => /https?:\/\/\S/i.test(t);

/** Maior texto que o ouvinte entrega ao handler: o resto é cortado na fronteira (S1, CWE-400: as regex do parser). */
export const MAX_TEXTO_RECEBIDO = 4096;

/**
 * Texto de uma mensagem recebida (o `message` de um WAMessage do Baileys), ou '' quando não há texto.
 * Lê `conversation`, `extendedTextMessage.text` (com o link da prévia quando o texto não traz link nenhum),
 * legenda de foto, vídeo e documento, e desembrulha mensagem temporária e de visualização única.
 * Edições, reações, enquetes e mensagens de sistema não têm texto aqui: formato desconhecido é ignorado.
 *
 * Decisão (R9): o link da prévia (`matchedText`/`canonicalUrl`) só entra quando o texto não tem link COM esquema
 * (`http://` ou `https://`). Se o texto traz um link sem esquema (ex.: `amzn.to/x`), a prévia também é anexada e o
 * texto sai com dois links do mesmo produto. Isso é aceito aqui de propósito (o ouvinte não interpreta links);
 * quem consome (etapa 11 do plano espelhamento-amazon) deve deduplicar por ASIN dentro da mesma mensagem.
 */
export function textoDaMensagem(message) {
  let m = message;
  for (let i = 0; i < 5 && m && typeof m === 'object'; i++) {
    const embrulho = EMBRULHOS.find((k) => m[k]?.message);
    if (!embrulho) break;
    m = m[embrulho].message;
  }
  if (!m || typeof m !== 'object') return '';
  const texto = (v) => (typeof v === 'string' ? v : '');
  if (texto(m.conversation)) return m.conversation;
  const ext = m.extendedTextMessage;
  if (ext && typeof ext === 'object') {
    const t = texto(ext.text);
    if (temUrl(t)) return t;
    // a prévia guarda o link quando o texto veio sem ele (ou só com o título)
    const link = [texto(ext.matchedText), texto(ext.canonicalUrl)].find(temUrl) || '';
    return [t, link].filter(Boolean).join('\n');
  }
  for (const k of ['imageMessage', 'videoMessage', 'documentMessage']) {
    const legenda = texto(m[k]?.caption);
    if (legenda) return legenda;
  }
  return '';
}

/** messageTimestamp do Baileys (segundos: número, string ou Long) → ms; sem valor válido, agora. */
function tsDaMensagem(v) {
  const n = Number(v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now();
}

const MAX_IDS_ENVIADOS = 1000;

/** Só o nome do erro (ex.: 'SyntaxError'), nunca a mensagem: ela pode carregar texto recebido do grupo (S7). */
const nomeDoErro = (e) => (typeof e?.name === 'string' && /^[A-Za-z_$][\w$]{0,63}$/.test(e.name) ? e.name : 'Error');

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
export function createWhatsApp({ db, dir, dryRun = false, pseudo = (id) => id, diaDe = diaDoCalendario, onMensagem = null }) {
  const authDir = path.join(dir, 'wa_auth');
  const state = { status: 'idle', qr: null, me: null, error: null };
  let sock = null; let starting = false; let stopped = false; let syncTimer = null;
  const simulated = []; // mensagens "enviadas" no modo simulação
  let aoReceber = typeof onMensagem === 'function' ? onMensagem : null;
  // ids das mensagens que este programa enviou (os últimos 1000): voltam pelo messages.upsert e são ignorados (anti-laço)
  const idsEnviados = new Set();
  function registrarEnvio(enviada) {
    const id = enviada?.key?.id;
    if (!id) return;
    idsEnviados.delete(id); idsEnviados.add(id);
    if (idsEnviados.size > MAX_IDS_ENVIADOS) idsEnviados.delete(idsEnviados.values().next().value);
  }

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

  /**
   * Mensagens novas nos grupos (messages.upsert). Só `notify` (o que chega agora, não o histórico) e só grupos.
   * Entrega ao handler apenas { jid, fromMe, texto, msgId, ts }: nunca participante, pushName ou outro dado da pessoa.
   * `texto` chega cortado em MAX_TEXTO_RECEBIDO caracteres (S1). Ver em textoDaMensagem a decisão R9 (link duplicado).
   * Nada aqui lança para o Baileys; o erro do handler vai ao console só com o nome do erro (`e.name`), nunca com
   * `e.message`, que pode trazer trecho da mensagem (ex.: SyntaxError do JSON.parse) (S7).
   */
  function onMensagens(upsert) {
    if (!aoReceber || upsert?.type !== 'notify' || !Array.isArray(upsert.messages)) return;
    for (const msg of upsert.messages) {
      try {
        const key = msg?.key;
        const msgId = typeof key?.id === 'string' ? key.id : '';
        const jid = typeof key?.remoteJid === 'string' ? key.remoteJid : '';
        if (!msgId || idsEnviados.has(msgId)) continue;
        if (!jid.endsWith('@g.us')) continue;
        const texto = textoDaMensagem(msg.message).slice(0, MAX_TEXTO_RECEBIDO);
        if (!texto) continue;
        const entrega = { jid, fromMe: key.fromMe === true, texto, msgId, ts: tsDaMensagem(msg.messageTimestamp) };
        Promise.resolve(aoReceber(entrega)).catch((e) => console.error('[espelho] erro no handler:', nomeDoErro(e)));
      } catch (e) { console.error('[espelho] erro no handler:', nomeDoErro(e)); }
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
      sock.ev.on('messages.upsert', (u) => { try { onMensagens(u); } catch (e) { console.error('[espelho] erro no ouvinte:', nomeDoErro(e)); } });
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
    registrarEnvio(await sock.sendMessage(jid, { text, linkPreview: p ? await montarLinkPreview(p) : null }));
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
    registrarEnvio(await sock.sendMessage(jid, { image: ehBuffer ? urlOuBuffer : { url: urlOuBuffer }, caption, ...(mimetype ? { mimetype } : {}) }));
  }

  /** Enquete ({ pergunta, opcoes, multipla }). Valida antes de tudo, também no modo simulado. */
  async function sendPoll(jid, enquete) {
    const poll = montarEnquete(enquete);
    if (dryRun) { simulated.push({ tipo: 'poll', jid, text: poll.name, poll }); return; }
    if (!isReady()) throw new Error('WhatsApp desconectado');
    registrarEnvio(await sock.sendMessage(jid, { poll }));
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
    /** Define quem recebe as mensagens novas dos grupos ({ jid, fromMe, texto, msgId, ts }); null desliga. */
    onMensagem: (handler) => { aoReceber = typeof handler === 'function' ? handler : null; },
    // usados nos testes para simular eventos do WhatsApp e conferir o que vai ao Baileys
    _onParticipants: onParticipants, _onReceipts: onReceipts, _onMensagens: onMensagens,
    _usarSocket: (falso) => { sock = falso; state.status = 'open'; },
    // reconecta sozinho ao abrir o programa se já houver sessão salva
    autoStart: () => { if (!dryRun && fs.existsSync(path.join(authDir, 'creds.json'))) connect(); },
  };
}
