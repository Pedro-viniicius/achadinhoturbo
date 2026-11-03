// Equipe (plano disparos-comunicacao-conta, F5; contrato em docs/produto/planos/entrega2-contrato.md): pessoas,
// papéis (dono|operador) e convites por link. O centro (pessoas, sessões, convites, soDono) fica em src/auth.js;
// aqui ficam as rotas, a listagem da tela Equipe, o nome da conta e o registro no Histórico.
// E-mails são dado pessoal: nunca em log nem em erro. O Histórico usa o nome da pessoa.

import { getSetting, setSetting, addLog } from './db.js';
import { ErroAuth, createLimiter } from './auth.js';
import { chaveIp } from './privacidade.js';

const ORIGEM = { id: null, name: 'Equipe' }; // coluna "Regra" do Histórico
const DIA = 24 * 60 * 60 * 1000;
export const CONTA_NOME_MAX = 60;
const NOME_PAPEL = { dono: 'Dono', operador: 'Operador' };

/** Responde JSON; ErroAuth vira o status dele. Erro inesperado (banco) não devolve nem registra a mensagem. */
const responder = (fn, status = 200) => async (req, res) => {
  try { const r = await fn(req, res); res.status(status).json(r ?? { ok: true }); } catch (e) {
    if (e instanceof ErroAuth) return res.status(e.status).json({ erro: e.message });
    console.error('[equipe] falha inesperada:', e?.code || e?.name || 'erro'); // sem e.message: pode trazer valores da query
    res.status(500).json({ erro: 'Não consegui concluir. Tente de novo.' });
  }
};
const idDe = (req) => { const n = Number(req.params.id); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const registrar = (db, message) => addLog(db, { rule: ORIGEM, level: 'info', message });

/** Regra da tela Equipe que não mexe com senha, token nem sessão. → { listar, salvarConta } */
export function createEquipe({ db }) {
  /**
   * Pessoas e convites pendentes (vencidos inclusive, com vencido:true). Nunca traz token nem link.
   * Antes, apaga os convites usados, cancelados ou vencidos há mais de 30 dias (limpeza preguiçosa).
   */
  function listar(atual, now = Date.now()) {
    const limite = now - 30 * DIA;
    db.prepare('DELETE FROM invites WHERE used_at < ? OR canceled_at < ? OR expires_at < ?').run(limite, limite, limite);
    const pessoas = db.prepare('SELECT id, nome, email, papel, created_at, last_login_at FROM users ORDER BY id').all();
    const donos = pessoas.filter((p) => p.papel === 'dono').length;
    const convites = db.prepare(`SELECT i.id, i.email, i.papel, i.expires_at, i.created_at, u.nome AS convidado_por
      FROM invites i LEFT JOIN users u ON u.id = i.created_by
      WHERE i.used_at IS NULL AND i.canceled_at IS NULL ORDER BY i.created_at DESC, i.id DESC`).all();
    return {
      conta_nome: getSetting(db, 'conta_nome', ''),
      pessoas: pessoas.map((p) => ({ ...p, voce: p.id === atual?.id, ultimo_dono: p.papel === 'dono' && donos === 1 })),
      convites: convites.map((c) => ({ ...c, convidado_por: c.convidado_por ?? '', vencido: c.expires_at <= now })),
    };
  }

  /** Nome da conta (aparece no convite). Vazio apaga. */
  function salvarConta(valor) {
    if (typeof valor !== 'string') throw new ErroAuth(400, 'Informe o nome da conta.');
    const nome = valor.trim();
    if (nome.length > CONTA_NOME_MAX) throw new ErroAuth(400, `O nome da conta pode ter até ${CONTA_NOME_MAX} caracteres.`);
    setSetting(db, 'conta_nome', nome);
  }

  return { listar, salvarConta };
}

/**
 * Rotas públicas do convite, montadas por buildApp ANTES do middleware de sessão (estão em PUBLIC_PATHS).
 * Freio próprio: 10 falhas por IP e 100 no total em 15 min; só o link que não vale conta como falha.
 * ctx = { db, auth, gravarCookie }
 */
export function montarRotasPublicas(app, { db, auth, gravarCookie }) {
  const porIp = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const todos = createLimiter({ max: 100, windowMs: 15 * 60 * 1000 });
  const comFreio = (fn) => responder(async (req, res) => {
    const ip = chaveIp(req.ip);
    const espera = Math.max(porIp.blocked(ip) ? porIp.retryAfterS(ip) : 0, todos.blocked('todos') ? todos.retryAfterS('todos') : 0);
    if (espera) {
      const min = Math.ceil(espera / 60);
      throw new ErroAuth(429, `Muitas tentativas. Tente de novo em ${min} ${min === 1 ? 'minuto' : 'minutos'}.`);
    }
    try { return await fn(req, res, ip); } catch (e) {
      if (e instanceof ErroAuth && e.status === 410) { porIp.fail(ip); todos.fail('todos'); }
      throw e;
    }
  });
  app.post('/api/convite/info', comFreio((req) => ({ conta_nome: getSetting(db, 'conta_nome', ''), ...auth.infoConvite(req.body?.token) })));
  app.post('/api/convite/aceitar', comFreio(async (req, res, ip) => {
    const { sid, user } = await auth.aceitarConvite(req.body?.token, req.body, ip);
    gravarCookie(req, res, sid);
    registrar(db, `${user.nome} entrou na equipe pelo convite, como ${NOME_PAPEL[user.papel]}.`);
  }));
}

/**
 * Rotas de F5 que exigem login, montadas por buildApp depois do middleware de sessão e da checagem Host/Origin.
 * ctx = { db, wa, links, scheduler, auth, wrap, soDono, dataDir, ml, enderecoPublico, publicHost, gravarCookie, sidDe }.
 */
export function montarRotas(app, ctx) {
  const { db, auth, soDono, gravarCookie, sidDe, publicHost } = ctx;
  const equipe = createEquipe({ db });
  // o token vai no fragmento: não aparece em requisição, log de proxy nem Referer. Sem domínio público, o Host
  // da requisição (só localhost passa pelo middleware Host/Origin).
  const linkDe = (req, token) => `${publicHost ? `https://${publicHost}` : `http://${String(req.headers.host || '').toLowerCase()}`}/convite.html#${token}`;
  const porQuem = (req) => (req.user ? ` (por ${req.user.nome})` : '');

  app.put('/api/me', responder(async (req) => {
    if (!req.user) throw new ErroAuth(409, 'O painel ainda não tem login.');
    await auth.atualizarMe(req.user.id, req.body, sidDe(req));
  }));
  // só com o login desligado (sem pessoa ainda, então sem soDono): cria o Dono e já deixa este navegador entrado
  app.post('/api/equipe/ativar', responder(async (req, res) => {
    const { sid, user } = await auth.ativar(req.body, chaveIp(req.ip));
    gravarCookie(req, res, sid);
    registrar(db, `Login ativado: ${user.nome} é o Dono.`);
  }));
  app.get('/api/equipe', soDono, responder((req) => equipe.listar(req.user)));
  app.put('/api/equipe/conta', soDono, responder((req) => { equipe.salvarConta(req.body?.conta_nome); }));
  app.post('/api/equipe/convites', soDono, responder((req) => {
    const { id, token } = auth.criarConvite({ email: req.body?.email, papel: req.body?.papel, criadoPor: req.user?.id });
    registrar(db, `Convite de ${NOME_PAPEL[req.body.papel]} criado${porQuem(req)}.`);
    return { id, link: linkDe(req, token) }; // o único momento em que o link aparece, além do giro
  }, 201));
  app.post('/api/equipe/convites/:id/link', soDono, responder((req) => ({ link: linkDe(req, auth.novoLinkConvite(idDe(req))) })));
  app.delete('/api/equipe/convites/:id', soDono, responder((req) => {
    auth.cancelarConvite(idDe(req));
    registrar(db, `Convite cancelado${porQuem(req)}.`);
  }));
  app.put('/api/equipe/pessoas/:id', soDono, responder((req) => {
    const { pessoa, mudou } = auth.mudarPapel(req.user?.id, idDe(req), req.body?.papel);
    if (mudou) registrar(db, `${pessoa.nome} agora é ${NOME_PAPEL[req.body.papel]}${porQuem(req)}.`);
  }));
  app.delete('/api/equipe/pessoas/:id', soDono, responder((req) => {
    const p = auth.removerPessoa(req.user?.id, idDe(req));
    registrar(db, `${p.nome} saiu da equipe${porQuem(req)}.`);
  }));
}
