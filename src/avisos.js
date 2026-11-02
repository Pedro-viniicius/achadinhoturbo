// Avisos por WhatsApp (plano disparos-comunicacao-conta, decisão 5 e etapa 11): resumo diário por destino, aviso
// agregado de erro de disparo e de grupo lotando, mais as configurações gerais (horário do resumo, virada do dia e
// limite padrão por grupo). Roda no mesmo tick do agendador (src/scheduler.js), depois dos envios.
// Os números dos destinos (aviso_destinos.jid) são dado pessoal: ficam só no banco, a listagem mascara e eles nunca
// vão para log, console nem mensagem de erro. O log usa o nome do destino.

import { addLog, getSetting, setSetting } from './db.js';
import { resumo, evasaoDoDia, startOfDay, dayOf } from './analytics.js';
import { parseLink, statusDosGrupos, LOTACAO_PCT, LIMITE_MAX } from './rotador.js';
import { normalizarNumero } from './whatsapp.js';
import { createLimiter } from './auth.js';
import { chaveIp } from './privacidade.js';

export const PADROES = { resumo_horario: '21:00', virada_dia: '00:00', limite_padrao: 1000 };
const LIMITE_MIN = 2;
export const TIPOS_AVISO = ['lotacao', 'erro'];
const ERRO_INTERVALO_MS = 30 * 60000;   // no máximo um aviso de erro a cada 30 min
const LOTACAO_REARME_PCT = 90;          // o grupo avisado só pode ser avisado de novo depois de cair abaixo disto
const MAX_NOME = 60;
const MAX_DIGITOS_NOME = 5;              // o nome vai para o log: com 6 ou mais algarismos pode ser um telefone
const CONSULTAS_MAX = 10;               // consultas de número ao WhatsApp (onWhatsApp) por IP…
const CONSULTAS_JANELA_MS = 10 * 60000; // …a cada 10 min: cadastrar um número é raro, varrer números não
const MAX_ERRO_BRUTO = 500;             // corta antes das regex: texto enorme de uma biblioteca não trava o servidor
const MSG_NUMERO = 'Número inválido. Use DDD e número, ex.: 35 99999-1234.';
const ORIGEM = { id: null, name: 'Avisos' }; // coluna "Regra" do Histórico

const pad = (n) => String(n).padStart(2, '0');
const hhmmDe = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ddmm = (ymd) => ymd.split('-').reverse().slice(0, 2).join('/');
const num = (n) => Number(n || 0).toLocaleString('pt-BR');
const lerJson = (s, padrao) => { try { return JSON.parse(s) ?? padrao; } catch { return padrao; } };
/** Mensagem de erro sem número de telefone nem JID (erros de biblioteca podem trazer o destinatário). */
export function semNumero(e) {
  let t = String(e?.message || e || 'erro desconhecido');
  // o corte pode partir um número no meio: a última palavra cortada sai inteira
  if (t.length > MAX_ERRO_BRUTO) t = t.slice(0, MAX_ERRO_BRUTO).replace(/\S*$/, '…');
  return t.replace(/\S*@\S*/g, '…').replace(/\+?\d[\d\s().-]{5,}\d/g, '…').slice(0, 160);
}

/** 'H:MM' ou 'HH:MM' válido → 'HH:MM'; senão null. */
function normalizarHhmm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${pad(Number(m[1]))}:${m[2]}`;
}
export function minutosDe(hhmm) { const n = normalizarHhmm(hhmm); return n == null ? null : Number(n.slice(0, 2)) * 60 + Number(n.slice(3)); }

// ---------- configurações gerais (settings) ----------
/** Configuração em vigor, com os padrões no lugar de valor ausente ou inválido. */
export function lerConfig(db) {
  const hhmm = (chave) => normalizarHhmm(getSetting(db, chave)) || PADROES[chave];
  const lim = Number(getSetting(db, 'limite_padrao', PADROES.limite_padrao));
  return {
    resumo_horario: hhmm('resumo_horario'), virada_dia: hhmm('virada_dia'),
    limite_padrao: Number.isInteger(lim) && lim >= LIMITE_MIN && lim <= LIMITE_MAX ? lim : PADROES.limite_padrao,
  };
}
/** Virada do dia em minutos (0 = meia-noite), para os cálculos por dia de src/analytics.js. */
export const viradaMin = (db) => minutosDe(lerConfig(db).virada_dia);
/** Limite de membros de um link novo quando o formulário não traz outro. */
export const limitePadrao = (db) => lerConfig(db).limite_padrao;

/** Valida tudo antes de gravar qualquer coisa. Campo ausente ou vazio fica como está. */
export function salvarConfig(db, b = {}) {
  const novo = {}; const tem = (k) => b[k] != null && b[k] !== '';
  if (tem('resumo_horario')) {
    novo.resumo_horario = normalizarHhmm(b.resumo_horario);
    if (!novo.resumo_horario) throw new Error('Horário do resumo inválido. Use HH:MM, por exemplo 21:00.');
  }
  if (tem('virada_dia')) {
    novo.virada_dia = normalizarHhmm(b.virada_dia);
    if (!novo.virada_dia) throw new Error('Virada do dia inválida. Use HH:MM, por exemplo 00:00.');
  }
  if (tem('limite_padrao')) {
    const n = Number(b.limite_padrao);
    if (!Number.isInteger(n) || n < LIMITE_MIN || n > LIMITE_MAX) throw new Error(`Limite padrão por grupo: de ${LIMITE_MIN} a ${LIMITE_MAX} (o máximo do WhatsApp é ${LIMITE_MAX}).`);
    novo.limite_padrao = n;
  }
  for (const [k, v] of Object.entries(novo)) setSetting(db, k, v);
  return lerConfig(db);
}

// ---------- destinos ----------
/** '5511987654321@s.whatsapp.net' → '+55 11 •••••-4321'. Só os 4 últimos dígitos aparecem. */
export function mascararNumero(jid) {
  const d = String(jid ?? '').split('@')[0].replace(/\D/g, '');
  if (d.length < 8) return '•••';
  const fim = d.slice(-4);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `+55 ${d.slice(2, 4)} ${'•'.repeat(d.length - 8)}-${fim}`;
  return `+${'•'.repeat(d.length - 4)}-${fim}`;
}

/** Linha de aviso_destinos → objeto. resumo_blocos: null = não recebe; [] = todos os grupos; [ids] = esses blocos. */
function lerDestino(r) {
  const blocos = r.resumo_blocos == null ? null : lerJson(r.resumo_blocos, null);
  const avisos = lerJson(r.avisos, []);
  return {
    id: r.id, nome: r.nome, jid: r.jid,
    resumo_blocos: Array.isArray(blocos) ? blocos.map(Number).filter(Number.isInteger) : null,
    avisos: Array.isArray(avisos) ? TIPOS_AVISO.filter((t) => avisos.includes(t)) : [],
    ativo: !!r.ativo, created_at: r.created_at,
  };
}
/** O que vai para o navegador: sem o JID, só o número mascarado. */
const paraTela = ({ jid, ...d }) => ({ ...d, numero: mascararNumero(jid) });
const todosDestinos = (db) => db.prepare('SELECT * FROM aviso_destinos ORDER BY nome COLLATE NOCASE, id').all().map(lerDestino);
const idValido = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Error('Número não encontrado.'); return n; };

/** Recusa com 429: muitas consultas de número ao WhatsApp em pouco tempo. */
class MuitasConsultas extends Error {
  constructor(segundos) {
    super(`Muitas consultas de número em pouco tempo. Tente de novo em ${Math.max(1, Math.ceil(segundos / 60))} min.`);
    this.status = 429;
  }
}

/**
 * Número digitado → JID canônico (resolve o 9º dígito). Nenhuma mensagem repete o número.
 * `antesDeConsultar()` roda logo antes de perguntar ao WhatsApp (o freio de consultas: pode lançar MuitasConsultas).
 */
async function resolverDestino(wa, numero, antesDeConsultar = () => {}) {
  let digitos;
  try { digitos = normalizarNumero(String(numero ?? '').slice(0, 40)); } catch { throw new Error(MSG_NUMERO); }
  antesDeConsultar();
  let r;
  try { r = await wa.resolverNumero(digitos); } catch {
    throw new Error('Não consegui conferir o número no WhatsApp. Confira se ele está conectado em Números de WhatsApp.');
  }
  if (!r?.existe || typeof r.jid !== 'string' || !r.jid.includes('@')) throw new Error('Este número não está no WhatsApp.');
  return r.jid;
}

function blocosDoCorpo(db, v) {
  if (v == null || v === false) return null;
  if (!Array.isArray(v) || v.length > 500) throw new Error('Escolha os blocos do resumo ou “Todos os grupos”.');
  if (!v.length) return '[]';
  const ids = [...new Set(v.map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || !db.prepare('SELECT 1 FROM blocks WHERE id = ?').get(n))) {
    throw new Error('Um dos blocos escolhidos não existe mais. Recarregue a página.');
  }
  return JSON.stringify(ids);
}

/**
 * Corpo do POST/PUT → colunas. No PUT, campo ausente mantém o atual e número vazio mantém o número salvo.
 * `antesDeConsultar`: o freio de consultas ao WhatsApp (ver resolverDestino).
 */
async function destinoDoCorpo({ db, wa }, corpo, atual = null, antesDeConsultar = undefined) {
  const b = corpo && typeof corpo === 'object' ? corpo : {};
  const tem = (k) => Object.hasOwn(b, k);
  const novoNome = tem('nome') || !atual;
  const nome = novoNome ? String(b.nome ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : atual.nome;
  if (!nome) throw new Error('Dê um nome ao número.');
  if (nome.length > MAX_NOME) throw new Error(`O nome pode ter até ${MAX_NOME} letras.`);
  // o nome aparece no Histórico e nos logs: não pode carregar o telefone
  if (novoNome && (nome.match(/\d/g) || []).length > MAX_DIGITOS_NOME) {
    throw new Error(`Não ponha o número no nome (ele aparece no Histórico): use até ${MAX_DIGITOS_NOME} algarismos.`);
  }
  const numero = tem('numero') ? String(b.numero ?? '').trim() : '';
  const jid = numero || !atual ? await resolverDestino(wa, numero, antesDeConsultar) : atual.jid;
  if (db.prepare('SELECT 1 FROM aviso_destinos WHERE jid = ? AND id IS NOT ?').get(jid, atual?.id ?? null)) throw new Error('Este número já está cadastrado.');
  const avisos = tem('avisos') ? (Array.isArray(b.avisos) ? TIPOS_AVISO.filter((t) => b.avisos.includes(t)) : []) : (atual?.avisos || []);
  return {
    nome, jid, avisos: JSON.stringify(avisos),
    resumo_blocos: tem('resumo_blocos') ? blocosDoCorpo(db, b.resumo_blocos) : (atual?.resumo_blocos == null ? null : JSON.stringify(atual.resumo_blocos)),
    ativo: (tem('ativo') ? !!b.ativo : atual ? atual.ativo : true) ? 1 : 0,
  };
}

// ---------- resumo, avisos e tick ----------
export function createAvisos({ db, wa } = {}) {
  const destinos = (filtro = () => true) => todosDestinos(db).filter(filtro);
  const registrar = (level, message) => addLog(db, { rule: ORIGEM, level, message });

  /** Manda o texto a um destino. Falha vira 'aviso' no log (nunca 'erro': não pode gerar outro aviso de erro). */
  async function entregar(d, texto, oQue) {
    try {
      await wa.sendText(d.jid, texto);
      registrar('ok', `Enviei ${oQue} para “${d.nome}”.`); return true;
    } catch (e) {
      registrar('aviso', `Não consegui enviar ${oQue} para “${d.nome}”: ${semNumero(e)}`); return false;
    }
  }

  /** Seções do resumo: [] (ou nada) = uma só, "Todos os grupos"; [ids] = esses blocos, pelo nome. */
  function secoes(blocos) {
    if (!Array.isArray(blocos) || !blocos.length) return [{ nome: 'Todos os grupos', jids: null }];
    const ids = [...new Set(blocos.map(Number).filter(Number.isInteger))];
    if (!ids.length) return [];
    return db.prepare(`SELECT id, name FROM blocks WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name COLLATE NOCASE, id`).all(...ids)
      .map((b) => ({ nome: b.name, jids: db.prepare('SELECT jid FROM block_groups WHERE block_id = ?').all(b.id).map((r) => r.jid) }));
  }
  function gruposDe(jids) {
    if (jids && !jids.length) return { n: 0, membros: 0 };
    const r = jids
      ? db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS m FROM groups WHERE jid IN (${jids.map(() => '?').join(',')})`).get(...jids)
      : db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS m FROM groups').get();
    return { n: r.n, membros: r.m };
  }

  /** Texto do resumo do dia de negócio até `now`. blocos: [] = todos os grupos, [ids] = esses blocos. → string */
  function montarResumo(blocos, now = Date.now()) {
    const v = viradaMin(db); const de = startOfDay(now, v);
    const linhas = [`📊 *Resumo de ${ddmm(dayOf(now, v))}* (até ${hhmmDe(now)})`];
    const lista = secoes(blocos);
    if (!lista.length) linhas.push('', 'Os blocos escolhidos para este número foram apagados. Edite o número em Relatórios e avisos.');
    for (const s of lista) {
      const g = gruposDe(s.jids);
      const r = resumo(db, { de, ate: now, jids: s.jids });
      const ev = evasaoDoDia(db, now, s.jids, v);
      linhas.push('',
        `*${String(s.nome).replace(/\*/g, '')}* · ${num(g.n)} ${g.n === 1 ? 'grupo' : 'grupos'} · ${num(g.membros)} ${g.membros === 1 ? 'membro' : 'membros'}`,
        `➕ Entraram: ${num(r.entradas)} · ➖ Saíram: ${num(r.saidas)}`,
        `🏃 Saíram no mesmo dia: ${ev.pct == null ? '—' : `${ev.pct.toLocaleString('pt-BR')}%`}`,
        `👀 Abriram: ${num(r.abriram)}`,
        `🔗 Cliques: ${num(r.cliques)}`);
    }
    return linhas.join('\n');
  }

  /** "Enviar resumo agora": para um destino (destinoId) ou para todos os ativos que recebem o resumo. → { enviados, falhas } */
  async function enviarResumo({ destinoId, now = Date.now() } = {}) {
    let alvo;
    if (destinoId != null && destinoId !== '') {
      const id = idValido(destinoId); const d = destinos((x) => x.id === id)[0];
      if (!d) throw new Error('Número não encontrado.');
      if (!d.ativo) throw new Error('Este número está desligado. Ligue-o para enviar o resumo.');
      if (d.resumo_blocos == null) throw new Error('Este número não recebe o resumo diário. Edite-o e escolha os blocos.');
      alvo = [d];
    } else {
      alvo = destinos((d) => d.ativo && d.resumo_blocos != null);
      if (!alvo.length) throw new Error('Cadastre um número ativo para enviar o resumo.');
    }
    if (!wa.isReady()) throw new Error('Conecte o WhatsApp em Números de WhatsApp para enviar o resumo.');
    let enviados = 0;
    for (const d of alvo) if (await entregar(d, montarResumo(d.resumo_blocos, now), 'o resumo')) enviados++;
    return { enviados, falhas: alvo.length - enviados };
  }

  /**
   * Resumo diário: 1× por dia de negócio (resumo_ultimo_dia), no horário resumo_horario. Horário-alvo =
   * início do dia de negócio + ((resumo − virada + 1440) % 1440) min. Se o serviço estava parado (ou o WhatsApp fora),
   * sai atrasado, desde que ainda no mesmo dia de negócio.
   */
  async function resumoDiario(now) {
    const cfg = lerConfig(db); const v = minutosDe(cfg.virada_dia); const dia = dayOf(now, v);
    if (getSetting(db, 'resumo_ultimo_dia') === dia) return;
    const alvo = new Date(startOfDay(now, v));
    alvo.setMinutes(alvo.getMinutes() + ((minutosDe(cfg.resumo_horario) - v + 1440) % 1440));
    if (now < alvo.getTime()) return;
    const lista = destinos((d) => d.ativo && d.resumo_blocos != null);
    if (lista.length && !wa.isReady()) return; // espera o WhatsApp voltar
    setSetting(db, 'resumo_ultimo_dia', dia); // marcado antes de enviar: nunca sai duas vezes no mesmo dia
    for (const d of lista) await entregar(d, montarResumo(d.resumo_blocos, now), 'o resumo diário');
  }

  function textoErros(rows, now) {
    const n = rows.length; const t0 = rows[0].ts;
    const desde = dayOf(t0) === dayOf(now) ? hhmmDe(t0) : `${ddmm(dayOf(t0))} ${hhmmDe(t0)}`;
    const motivos = new Map();
    for (const r of rows) { const m = semNumero(r.message || 'sem detalhe').slice(0, 100); motivos.set(m, (motivos.get(m) || 0) + 1); }
    const linhas = [`⚠️ *${n} ${n === 1 ? 'disparo falhou' : 'disparos falharam'} desde ${desde}*`];
    for (const [m, c] of [...motivos].slice(0, 3)) linhas.push(`• ${m}${c > 1 ? ` (${c}×)` : ''}`);
    if (motivos.size > 3) { const k = motivos.size - 3; linhas.push(`• e mais ${k} ${k === 1 ? 'motivo' : 'motivos'}`); }
    linhas.push('', 'Veja o Histórico no painel.');
    return linhas.join('\n');
  }

  /**
   * Erro de disparo: lê os 'erro' novos do log pelo cursor avisos_log_cursor e manda um aviso agregado, no máximo
   * 1 a cada 30 min (avisos_erro_ultimo) e só com o WhatsApp de pé. Enquanto não pode mandar, acumula.
   */
  async function avisoDeErro(now) {
    const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM log').get().n;
    const salvo = getSetting(db, 'avisos_log_cursor');
    if (salvo == null) { setSetting(db, 'avisos_log_cursor', maxId); return; } // primeira vez: o passado não vira aviso
    let cursor = Number(salvo) || 0;
    if (cursor > maxId) cursor = 0; // o log foi esvaziado: recomeça
    const novos = db.prepare("SELECT id, ts, message FROM log WHERE level = 'erro' AND id > ? ORDER BY id").all(cursor);
    if (!novos.length) return;
    const fim = novos[novos.length - 1].id;
    const lista = destinos((d) => d.ativo && d.avisos.includes('erro'));
    if (!lista.length) { setSetting(db, 'avisos_log_cursor', fim); return; } // ninguém para avisar: não acumula
    if (!wa.isReady()) return;
    if (now - Number(getSetting(db, 'avisos_erro_ultimo', 0)) < ERRO_INTERVALO_MS) return;
    setSetting(db, 'avisos_log_cursor', fim); setSetting(db, 'avisos_erro_ultimo', now);
    const texto = textoErros(novos, now);
    for (const d of lista) await entregar(d, texto, 'o aviso de erro');
  }

  function textoLotacao(grupos) {
    const linhas = [`🚨 *${grupos.length === 1 ? 'Grupo lotando' : 'Grupos lotando'}*`];
    for (const g of grupos) {
      const prop = db.prepare("SELECT name FROM group_proposals WHERE source_jid = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(g.jid);
      linhas.push(`• ${g.name}: ${num(g.size)} de ${num(g.limit)} membros (link “${g.link}”). ${prop
        ? `Há uma proposta para criar “${prop.name}”: confirme no Rotacionador de Links.`
        : 'Crie o próximo grupo ou aumente o limite no Rotacionador de Links.'}`);
    }
    return linhas.join('\n');
  }

  /**
   * Grupo lotando: grupos de links ativos com size ≥ LOTACAO_PCT% do limite. Avisa 1× por grupo (avisos_lotacao,
   * lista de JIDs de grupo) até ele cair abaixo de LOTACAO_REARME_PCT% ou sair dos links ativos.
   */
  async function avisoDeLotacao() {
    const salvos = lerJson(getSetting(db, 'avisos_lotacao', '[]'), []);
    const avisados = new Set(Array.isArray(salvos) ? salvos.filter((j) => typeof j === 'string') : []);
    const grupos = Object.fromEntries(db.prepare('SELECT jid, name, size, invite_code FROM groups').all().map((g) => [g.jid, g]));
    const lotando = new Map(); const acimaDoRearme = new Set();
    for (const l of db.prepare('SELECT * FROM links WHERE enabled = 1 ORDER BY id').all().map(parseLink)) {
      for (const st of statusDosGrupos(l, grupos)) {
        if (st.situacao === 'removido') continue;
        if (st.size >= Math.ceil((st.limit * LOTACAO_REARME_PCT) / 100)) acimaDoRearme.add(st.jid);
        if (st.size >= Math.ceil((st.limit * LOTACAO_PCT) / 100) && !lotando.has(st.jid)) lotando.set(st.jid, { ...st, link: l.name });
      }
    }
    const manter = [...avisados].filter((j) => acimaDoRearme.has(j));
    const novos = [...lotando.values()].filter((g) => !avisados.has(g.jid));
    const lista = novos.length ? destinos((d) => d.ativo && d.avisos.includes('lotacao')) : [];
    if (novos.length && lista.length && wa.isReady()) {
      setSetting(db, 'avisos_lotacao', JSON.stringify([...manter, ...novos.map((g) => g.jid)]));
      const texto = textoLotacao(novos);
      for (const d of lista) await entregar(d, texto, 'o aviso de grupo lotando');
    } else if (manter.length !== avisados.size) setSetting(db, 'avisos_lotacao', JSON.stringify(manter));
  }

  return {
    /**
     * Chamado a cada tick: resumo diário, aviso de erro e aviso de lotação. Uma parte que falha não impede as outras;
     * o erro sobe sem número (o agendador o mostra no console).
     */
    async tick(now = Date.now()) {
      let falha = null;
      for (const passo of [resumoDiario, avisoDeErro, avisoDeLotacao]) {
        try { await passo(now); } catch (e) { falha ??= e; }
      }
      if (falha) throw new Error(semNumero(falha));
    },
    montarResumo,
    enviarResumo,
  };
}

/**
 * Rotas de F3, montadas por buildApp depois do login e da checagem Host/Origin.
 * ctx = { db, wa, links, scheduler, auth, wrap, soDono, dataDir, ml, enderecoPublico }; os avisos são ctx.scheduler.avisos.
 */
export function montarRotas(app, ctx) {
  const { db, wrap } = ctx;
  let proprio = null; // só se o agendador não trouxer os avisos
  // Freio do cadastro: cada consulta de número ao WhatsApp (onWhatsApp) conta, por IP. Varrer números com a sessão
  // do painel poderia marcar o número do dono como robô.
  const consultas = createLimiter({ max: CONSULTAS_MAX, windowMs: CONSULTAS_JANELA_MS });
  const freioDe = (req) => () => {
    const ip = chaveIp(req.ip);
    if (consultas.blocked(ip)) throw new MuitasConsultas(consultas.retryAfterS(ip));
    consultas.fail(ip);
  };
  /** Como o wrap do servidor, mas o 429 do freio chega como 429. */
  const comFreio = (fn) => async (req, res) => {
    try { res.json(await fn(req) ?? { ok: true }); } catch (e) { res.status(e instanceof MuitasConsultas ? 429 : 400).json({ erro: e.message }); }
  };
  const avisos = () => ctx.scheduler?.avisos || (proprio ??= createAvisos({ db, wa: ctx.wa }));
  const blocos = () => db.prepare('SELECT id, name FROM blocks ORDER BY name COLLATE NOCASE, id').all().map((b) => ({ id: b.id, nome: b.name }));
  const listar = () => todosDestinos(db).map(paraTela);
  const destinoPorId = (v) => {
    const r = db.prepare('SELECT * FROM aviso_destinos WHERE id = ?').get(idValido(v));
    if (!r) throw new Error('Número não encontrado.');
    return lerDestino(r);
  };

  app.get('/api/avisos', wrap(() => ({ destinos: listar(), config: lerConfig(db), blocos: blocos() })));
  app.get('/api/avisos/destinos', wrap(() => listar()));
  app.post('/api/avisos/destinos', comFreio(async (req) => {
    const d = await destinoDoCorpo(ctx, req.body, null, freioDe(req));
    const id = db.prepare('INSERT INTO aviso_destinos (nome, jid, resumo_blocos, avisos, ativo, created_at) VALUES (?,?,?,?,?,?)')
      .run(d.nome, d.jid, d.resumo_blocos, d.avisos, d.ativo, Date.now()).lastInsertRowid;
    return { id: Number(id) };
  }));
  app.put('/api/avisos/destinos/:id', comFreio(async (req) => {
    const atual = destinoPorId(req.params.id);
    const d = await destinoDoCorpo(ctx, req.body, atual, freioDe(req));
    db.prepare('UPDATE aviso_destinos SET nome = ?, jid = ?, resumo_blocos = ?, avisos = ?, ativo = ? WHERE id = ?')
      .run(d.nome, d.jid, d.resumo_blocos, d.avisos, d.ativo, atual.id);
  }));
  app.delete('/api/avisos/destinos/:id', wrap((req) => {
    if (!db.prepare('DELETE FROM aviso_destinos WHERE id = ?').run(idValido(req.params.id)).changes) throw new Error('Número não encontrado.');
  }));
  app.put('/api/avisos/config', wrap((req) => salvarConfig(db, req.body || {})));
  app.get('/api/avisos/previa', wrap((req) => {
    const id = req.query.destino;
    if (id == null || id === '') return { texto: avisos().montarResumo([]), recebe: true };
    const d = destinoPorId(id);
    return d.resumo_blocos == null ? { texto: '', recebe: false } : { texto: avisos().montarResumo(d.resumo_blocos), recebe: true };
  }));
  app.post('/api/avisos/resumo-agora', wrap((req) => avisos().enviarResumo({ destinoId: req.body?.destino_id })));
}
