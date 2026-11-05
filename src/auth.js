// Login do painel por pessoa (tabela users: nome, e-mail, hash scrypt da senha, papel dono|operador), convites por
// link e sessão em cookie httpOnly guardada no SQLite (só o hash do identificador; sobrevive a reinício; ligada à
// pessoa por user_id), expiração por inatividade, limite de tentativas e comparação de segredos em tempo constante.
// E-mail é dado pessoal: nunca vai para log nem para mensagem de erro. Do convite, o banco guarda só o sha256 do token.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getSetting, setSetting } from './db.js';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = promisify(crypto.scrypt);
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;   // vida máxima: 30 dias
export const INATIVIDADE_MS = 7 * 24 * 60 * 60 * 1000; // sem uso por 7 dias, cai
const TOQUE_MS = 10 * 60 * 1000;                       // atualiza "último uso" no máximo a cada 10 min
// Senha única de antes da Equipe. Fica no banco e acompanha a senha do Dono mais antigo: voltar ao código antigo
// (rollback) continua entrando com ela.
const HASH_KEY = 'panel_password_hash';
export const SENHA_MIN = 8;
export const SENHA_MAX = 200;                          // o /api/login corta a senha em 200 caracteres
export const NOME_MAX = 80;
export const EMAIL_MAX = 120;
export const CONVITE_MS = 7 * 24 * 60 * 60 * 1000;     // o convite vale 7 dias
export const PAPEIS = ['dono', 'operador'];
export const CONVITE_INVALIDO = 'Este convite não vale mais.'; // inválido, vencido, usado e cancelado: a mesma mensagem
// Hash de formato válido, com sal e resultado aleatórios: e-mail desconhecido gasta o mesmo scrypt e nunca confere.
const HASH_FICTICIO = `scrypt$${crypto.randomBytes(16).toString('hex')}$${crypto.randomBytes(32).toString('hex')}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX64 = /^[a-f0-9]{64}$/;

/** Erro de regra com o status HTTP e uma mensagem para a pessoa (nunca traz e-mail nem senha). */
export class ErroAuth extends Error {
  constructor(status, message) { super(message); this.name = 'ErroAuth'; this.status = status; }
}

export function hashPassword(pw, salt = crypto.randomBytes(16)) {
  const h = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

/** Como hashPassword, sem travar o servidor enquanto calcula. */
async function hashPasswordAsync(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(String(pw), salt, 32, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

/** Assíncrono: não trava o servidor enquanto calcula. */
export async function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const h = await scrypt(String(pw), Buffer.from(saltHex, 'hex'), 32, SCRYPT);
  return safeEqual(h, Buffer.from(hashHex, 'hex'));
}

/** Compara dois segredos sem vazar, pelo tempo, em que posição divergem. */
export function safeEqual(a, b) {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(String(a ?? ''));
  const y = Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// ---------- validação dos campos de pessoa (mensagens da spec; nunca ecoam o valor) ----------
export function validarNome(v) {
  const nome = typeof v === 'string' ? v.trim() : '';
  if (!nome) throw new ErroAuth(400, 'Informe o nome.');
  if (nome.length > NOME_MAX) throw new ErroAuth(400, `O nome pode ter até ${NOME_MAX} caracteres.`);
  return nome;
}
/** E-mail em minúsculas, até 120 caracteres, formato algo@algo.algo. */
export function validarEmail(v) {
  const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) throw new ErroAuth(400, 'Escolha um e-mail válido.');
  return email;
}
export function validarSenha(v) {
  if (typeof v !== 'string' || v.length < SENHA_MIN) throw new ErroAuth(400, `A senha precisa de ao menos ${SENHA_MIN} caracteres.`);
  if (v.length > SENHA_MAX) throw new ErroAuth(400, `A senha pode ter até ${SENHA_MAX} caracteres.`);
  return v;
}
export function papelValido(p) {
  if (!PAPEIS.includes(p)) throw new ErroAuth(400, 'Escolha o papel: Dono ou Operador.');
  return p;
}

/** Tudo ou nada. IMMEDIATE pega a trava de escrita já no início: o que se confere dentro vale até o COMMIT. */
function emTransacao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const donoMaisAntigo = (db) => db.prepare("SELECT id, senha_hash FROM users WHERE papel = 'dono' ORDER BY id LIMIT 1").get();
const criarDonoSemEmail = (db, hash) => Number(db.prepare("INSERT INTO users (nome, email, senha_hash, papel, created_at) VALUES ('Dono', NULL, ?, 'dono', ?)")
  .run(hash, Date.now()).lastInsertRowid);
/** panel_password_hash acompanha a senha do Dono mais antigo (rollback para a senha única). */
function espelharSenhaUnica(db) {
  const d = donoMaisAntigo(db);
  if (d) setSetting(db, HASH_KEY, d.senha_hash);
}

/**
 * Senha única → Dono. Só roda com o hash da senha única e sem nenhuma pessoa; idempotente (roda a cada start).
 * Cria o Dono sem e-mail com o mesmo hash e passa a ele as sessões abertas. O hash antigo fica no banco.
 * → true se migrou.
 */
export function migrarDono(db) {
  if (!getSetting(db, HASH_KEY) || db.prepare('SELECT 1 FROM users LIMIT 1').get()) return false;
  return emTransacao(db, () => {
    const hash = getSetting(db, HASH_KEY);
    if (!hash || db.prepare('SELECT 1 FROM users LIMIT 1').get()) return false;
    const id = criarDonoSemEmail(db, hash);
    db.prepare('UPDATE sessions SET user_id = ? WHERE user_id IS NULL').run(id);
    return true;
  });
}

/** Troca a senha do Dono (o mais antigo; sem ninguém, cria o Dono sem e-mail) e encerra todas as sessões. */
export function setPassword(db, pw) {
  if (String(pw).length < SENHA_MIN) throw new Error(`A senha precisa ter ao menos ${SENHA_MIN} caracteres.`);
  if (String(pw).length > SENHA_MAX) throw new Error(`A senha pode ter até ${SENHA_MAX} caracteres.`);
  const h = hashPassword(pw);
  emTransacao(db, () => {
    const dono = donoMaisAntigo(db);
    if (dono) db.prepare('UPDATE users SET senha_hash = ? WHERE id = ?').run(h, dono.id);
    else criarDonoSemEmail(db, h);
    setSetting(db, HASH_KEY, h);
    db.exec('DELETE FROM sessions');
  });
}

/** A sessão é do Dono? Sem login no painel (auth desligada), quem usa o computador é o Dono. */
export const ehDono = (auth, req) => !auth.enabled() || req.user?.papel === 'dono';

/** Middleware: só o Dono passa (ehDono). */
export const soDono = (auth) => (req, res, next) => {
  if (ehDono(auth, req)) return next();
  if (!req.user) return res.status(401).json({ erro: 'Faça login para continuar' });
  res.status(403).json({ erro: 'Só o Dono pode fazer isso.' });
};

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie malformado: ignora */ }
  }
  return out;
}

/** Conta falhas por chave (IP, ou 'global') e bloqueia depois de `max` dentro de `windowMs`. */
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  const get = (k) => { const h = hits.get(k); if (h && h.resetAt <= Date.now()) { hits.delete(k); return null; } return h || null; };
  return {
    blocked: (k) => { const h = get(k); return !!h && h.count >= max; },
    fail(k) {
      const h = get(k) || { count: 0, resetAt: Date.now() + windowMs };
      h.count++; hits.set(k, h);
      if (hits.size > 10000) for (const [key, v] of hits) if (v.resetAt <= Date.now()) hits.delete(key);
    },
    reset: (k) => hits.delete(k),
    retryAfterS: (k) => { const h = get(k); return h ? Math.max(1, Math.ceil((h.resetAt - Date.now()) / 1000)) : 0; },
  };
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sidHash = sha256;

export function createAuth({ db, password = '' }) {
  const um = (sql, ...p) => db.prepare(sql).get(...p);
  const temPessoas = () => !!um('SELECT 1 FROM users LIMIT 1');
  if (password && !getSetting(db, HASH_KEY) && !temPessoas()) {
    if (String(password).length < SENHA_MIN) throw new Error(`PANEL_PASSWORD precisa ter ao menos ${SENHA_MIN} caracteres.`);
    setSetting(db, HASH_KEY, hashPassword(password));
  }
  migrarDono(db);

  const enabled = () => temPessoas() || !!getSetting(db, HASH_KEY);
  /** A conta sem e-mail (o Dono migrado), enquanto existir. */
  const pessoaSemEmail = () => um("SELECT id, senha_hash FROM users WHERE email IS NULL ORDER BY (papel = 'dono') DESC, id LIMIT 1");
  /** 'legado' enquanto houver conta sem e-mail (o login aceita e-mail em branco para ela); senão 'email'. */
  const modo = () => (pessoaSemEmail() ? 'legado' : 'email');

  // No máximo 2 senhas novas calculadas ao mesmo tempo (o aceite do convite é público e cada scrypt usa 16 MB).
  let hashesEmAndamento = 0;
  async function hashNovo(senha) {
    if (hashesEmAndamento >= 2) throw new ErroAuth(429, 'Aguarde um instante e tente de novo.');
    hashesEmAndamento++;
    try { return await hashPasswordAsync(senha); } finally { hashesEmAndamento--; }
  }

  function abrirSessao(userId, ip) {
    const now = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    const sid = crypto.randomBytes(32).toString('hex');
    // no banco fica só o hash: um vazamento do banco ou de um backup não dá sessões válidas
    db.prepare('INSERT INTO sessions (id, created_at, expires_at, ip, last_seen, user_id) VALUES (?,?,?,?,?,?)')
      .run(sidHash(sid), now, now + SESSION_MS, String(ip || ''), now, userId);
    return sid;
  }

  /**
   * Com e-mail: a pessoa desse e-mail. Sem e-mail: a conta sem e-mail (Dono migrado), se existir.
   * Os freios (por IP, global, 2 ao mesmo tempo) ficam na rota, antes de chamar aqui. → sid ou null.
   */
  async function login(email, pw, ip) {
    const e = String(email ?? '').trim().toLowerCase();
    const p = e ? um('SELECT id, senha_hash FROM users WHERE email = ?', e) : pessoaSemEmail();
    // e-mail desconhecido gasta o mesmo scrypt num hash fictício: o tempo não diz se a conta existe
    const ok = await verifyPassword(pw, p?.senha_hash ?? HASH_FICTICIO);
    if (!ok || !p) return null;
    // enquanto o scrypt rodava, a pessoa pode ter sido removida ou trocado a senha
    if (!um('SELECT 1 FROM users WHERE id = ? AND senha_hash = ?', p.id, p.senha_hash)) return null;
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), p.id);
    return abrirSessao(p.id, ip);
  }

  /** Sessão válida com a pessoa (relida a cada requisição: papel novo vale na hora), ou null. */
  function sessionFrom(sid) {
    if (!sid || !HEX64.test(sid)) return null;
    const h = sidHash(sid);
    const s = um(`SELECT s.*, u.id AS u_id, u.nome AS u_nome, u.email AS u_email, u.papel AS u_papel
      FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?`, h);
    if (!s) return null;
    const now = Date.now();
    // vencida, parada há mais de 7 dias ou sem pessoa (removida, ou sessão sem dono depois da migração): cai
    if (s.u_id == null || s.expires_at < now || (s.last_seen || s.created_at) + INATIVIDADE_MS < now) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(h); return null;
    }
    if (now - (s.last_seen || 0) > TOQUE_MS) db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now, h);
    const { u_id, u_nome, u_email, u_papel, ...sessao } = s;
    return { ...sessao, user: { id: u_id, nome: u_nome, email: u_email, papel: u_papel } };
  }
  const logout = (sid) => { if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sidHash(sid)); };

  /** Painel sem login: cria o Dono com e-mail e abre a sessão de quem ativou. → { sid, user } */
  async function ativar(corpo, ip) {
    if (enabled()) throw new ErroAuth(409, 'O painel já tem login.');
    const nome = validarNome(corpo?.nome); const email = validarEmail(corpo?.email); validarSenha(corpo?.senha);
    const h = await hashNovo(corpo.senha);
    return emTransacao(db, () => {
      if (enabled()) throw new ErroAuth(409, 'O painel já tem login.');
      const now = Date.now();
      const id = Number(db.prepare("INSERT INTO users (nome, email, senha_hash, papel, created_at, last_login_at) VALUES (?,?,?,'dono',?,?)")
        .run(nome, email, h, now, now).lastInsertRowid);
      setSetting(db, HASH_KEY, h);
      return { sid: abrirSessao(id, ip), user: { id, nome, papel: 'dono' } };
    });
  }

  /**
   * A pessoa muda o próprio nome e e-mail e, se mandar `senha`, a própria senha: as outras sessões dela caem,
   * a atual (sidAtual) fica.
   */
  async function atualizarMe(userId, corpo, sidAtual) {
    const nome = validarNome(corpo?.nome); const email = validarEmail(corpo?.email);
    const trocaSenha = corpo?.senha != null && corpo.senha !== '';
    if (trocaSenha) validarSenha(corpo.senha);
    const emUso = () => um('SELECT 1 FROM users WHERE email = ? AND id <> ?', email, userId);
    if (emUso()) throw new ErroAuth(409, 'Este e-mail já está em uso.');
    const h = trocaSenha ? await hashNovo(corpo.senha) : null;
    emTransacao(db, () => {
      if (!um('SELECT 1 FROM users WHERE id = ?', userId)) throw new ErroAuth(401, 'Faça login para continuar');
      if (emUso()) throw new ErroAuth(409, 'Este e-mail já está em uso.');
      db.prepare('UPDATE users SET nome = ?, email = ? WHERE id = ?').run(nome, email, userId);
      if (h) {
        db.prepare('UPDATE users SET senha_hash = ? WHERE id = ?').run(h, userId);
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, sidHash(sidAtual ?? ''));
        espelharSenhaUnica(db);
      }
    });
  }

  // ---------- convites: o token só existe na resposta que cria ou gira o link; no banco, o sha256 dele ----------
  const PENDENTE = 'used_at IS NULL AND canceled_at IS NULL';
  /** Convite pendente e no prazo deste token, ou null (inválido, vencido, usado e cancelado dão o mesmo null). */
  function conviteValido(token) {
    if (typeof token !== 'string' || !HEX64.test(token)) return null;
    return um(`SELECT * FROM invites WHERE token_hash = ? AND ${PENDENTE} AND expires_at > ?`, sha256(token), Date.now()) || null;
  }

  /** → { id, token }. Exige login ativo; o e-mail não pode estar na equipe nem ter convite pendente no prazo. */
  function criarConvite({ email, papel, criadoPor }) {
    if (!enabled()) throw new ErroAuth(409, 'Ative o login antes de convidar alguém.');
    const e = validarEmail(email); papelValido(papel);
    const now = Date.now();
    if (um('SELECT 1 FROM users WHERE email = ?', e)) throw new ErroAuth(409, 'Esta pessoa já está na equipe.');
    if (um(`SELECT 1 FROM invites WHERE email = ? AND ${PENDENTE} AND expires_at > ?`, e, now)) {
      throw new ErroAuth(409, 'Já existe um convite para este e-mail. Cancele-o para criar outro.');
    }
    const token = crypto.randomBytes(32).toString('hex');
    const id = Number(db.prepare('INSERT INTO invites (token_hash, email, papel, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(sha256(token), e, papel, now + CONVITE_MS, criadoPor ?? null, now).lastInsertRowid);
    return { id, token };
  }

  /** Gira o token (o link antigo morre) e renova o prazo para 7 dias. → token novo */
  function novoLinkConvite(id) {
    const token = crypto.randomBytes(32).toString('hex');
    const r = db.prepare(`UPDATE invites SET token_hash = ?, expires_at = ? WHERE id = ? AND ${PENDENTE}`).run(sha256(token), Date.now() + CONVITE_MS, id);
    if (!r.changes) throw new ErroAuth(404, 'Convite não encontrado.');
    return token;
  }

  function cancelarConvite(id) {
    const r = db.prepare(`UPDATE invites SET canceled_at = ? WHERE id = ? AND ${PENDENTE}`).run(Date.now(), id);
    if (!r.changes) throw new ErroAuth(404, 'Convite não encontrado.');
  }

  /** → { email, papel } do convite; senão ErroAuth 410. */
  function infoConvite(token) {
    const c = conviteValido(token);
    if (!c) throw new ErroAuth(410, CONVITE_INVALIDO);
    return { email: c.email, papel: c.papel };
  }

  /**
   * Cria a pessoa com o e-mail e o papel do convite (nunca do corpo), marca o convite como usado e abre a sessão.
   * O scrypt roda antes; a conferência do convite e as gravações ficam num bloco síncrono só, sem await no meio:
   * dois aceites do mesmo link ao mesmo tempo não criam duas pessoas. → { sid, user }
   */
  async function aceitarConvite(token, corpo, ip) {
    const c = conviteValido(token);
    if (!c) throw new ErroAuth(410, CONVITE_INVALIDO);
    const nome = validarNome(corpo?.nome); validarSenha(corpo?.senha);
    if (um('SELECT 1 FROM users WHERE email = ?', c.email)) throw new ErroAuth(409, 'Esta pessoa já está na equipe.');
    const h = await hashNovo(corpo.senha);
    return emTransacao(db, () => {
      const v = conviteValido(token);
      if (!v) throw new ErroAuth(410, CONVITE_INVALIDO);
      if (um('SELECT 1 FROM users WHERE email = ?', v.email)) throw new ErroAuth(409, 'Esta pessoa já está na equipe.');
      const now = Date.now();
      const id = Number(db.prepare('INSERT INTO users (nome, email, senha_hash, papel, created_at, last_login_at) VALUES (?,?,?,?,?,?)')
        .run(nome, v.email, h, v.papel, now, now).lastInsertRowid);
      db.prepare('UPDATE invites SET used_at = ? WHERE id = ?').run(now, v.id);
      return { sid: abrirSessao(id, ip), user: { id, nome, papel: v.papel } };
    });
  }

  // ---------- pessoas: papel e remoção (a própria pessoa e o último Dono ficam protegidos) ----------
  const pessoa = (id) => um('SELECT id, nome, papel FROM users WHERE id = ?', id);
  const donos = () => um("SELECT COUNT(*) AS n FROM users WHERE papel = 'dono'").n;

  /** Vale na hora: a sessão relê o papel a cada requisição. → { pessoa (antes da troca), mudou } */
  function mudarPapel(atualId, id, papel) {
    papelValido(papel);
    const p = pessoa(id);
    if (!p) throw new ErroAuth(404, 'Pessoa não encontrada.');
    if (p.id === atualId) throw new ErroAuth(409, 'Você não pode mudar o próprio papel.');
    if (p.papel === papel) return { pessoa: p, mudou: false };
    return emTransacao(db, () => {
      if (p.papel === 'dono' && donos() <= 1) throw new ErroAuth(409, 'A equipe precisa de ao menos um Dono.');
      db.prepare('UPDATE users SET papel = ? WHERE id = ?').run(papel, p.id);
      espelharSenhaUnica(db);
      return { pessoa: p, mudou: true };
    });
  }

  /** Apaga a pessoa e as sessões dela (ela sai na hora). Os convites que ela criou ficam. → a pessoa removida */
  function removerPessoa(atualId, id) {
    const p = pessoa(id);
    if (!p) throw new ErroAuth(404, 'Pessoa não encontrada.');
    if (p.id === atualId) throw new ErroAuth(409, 'Você não pode remover a si mesmo.');
    return emTransacao(db, () => {
      if (p.papel === 'dono' && donos() <= 1) throw new ErroAuth(409, 'A equipe precisa de ao menos um Dono.');
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(p.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(p.id);
      espelharSenhaUnica(db);
      return p;
    });
  }

  return {
    enabled, modo, login, logout, sessionFrom, setPassword: (pw) => setPassword(db, pw),
    ativar, atualizarMe, criarConvite, novoLinkConvite, cancelarConvite, infoConvite, aceitarConvite, mudarPapel, removerPessoa,
  };
}
