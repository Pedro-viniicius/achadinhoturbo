// Avisos por WhatsApp (plano disparos-comunicacao-conta, decisão 5 e etapa 11): resumo diário por destino, aviso
// agregado de erro de disparo e de grupo lotando, mais as configurações gerais (horário do resumo, virada do dia e
// limite padrão por grupo). Roda no mesmo tick do agendador (src/scheduler.js), depois dos envios.
// Os números dos destinos (aviso_destinos.jid) são dado pessoal: ficam só no banco, a listagem mascara e eles nunca
// vão para log, console nem mensagem de erro. O log usa o nome do destino.

import fs from 'node:fs';
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
export const BACKUP_ATRASO_H = 26;        // último sucesso do backup (local ou Drive) mais velho que isto = atrasado
const BACKUP_REPETIR_MS = 24 * 3600000;   // …e o aviso de atraso se repete no máximo 1 vez a cada 24 h
const BACKUP_CARENCIA_MS = 60 * 60000;    // …nunca na primeira hora depois de o programa ligar (o timer Persistent ainda roda)
const BACKUP_SALTO_MS = 5 * 60000;        // …nem depois de o PC voltar da suspensão: o relógio andou isto além do tempo acordado
const BACKUP_ESTADO_MAX = 64 * 1024;      // estado maior que isto não é o nosso arquivo
const ORIGEM_BACKUP = { id: null, name: 'Backup' };
// Frases fixas por etapa que falhou (scripts/backup.js, MOTIVOS_BACKUP): o texto do arquivo nunca vai direto ao Histórico.
// As chaves são as mesmas do script (test/backup.test.js compara os dois mapas).
export const MOTIVOS_BACKUP = {
  chave_ausente: 'a chave de criptografia não foi encontrada', chave_aberta: 'a chave de criptografia (ou a pasta dela) está com permissão aberta',
  banco: 'não consegui copiar o banco', cifrar: 'não consegui criptografar o pacote', verificacao: 'o pacote criptografado não passou na conferência',
  envio: 'o envio ao Google Drive falhou', limpeza_drive: 'não consegui apagar as cópias antigas do Drive',
};
// Mensagens manuais de Relatórios e avisos ("Enviar teste" e "Enviar resumo agora"): saem na hora pelo número do dono;
// repetir demais pode marcar o número como robô, então os dois dividem um freio só (em memória: some ao reiniciar).
// O teto da hora conta ENVIOS (cliques), não números: um resumo para todos conta 1, com 6 ou com 20 números. O que
// segura o volume por número é o intervalo; o resumo diário do horário (tick) não passa por este freio.
export const MANUAL_INTERVALO_S = 60;        // no máximo 1 mensagem manual por número a cada 60 s…
export const MANUAL_TODOS_INTERVALO_S = 60;  // …1 resumo manual para todos os números a cada 60 s…
export const MANUAL_MAX_HORA = 5;            // …e no máximo 5 envios manuais por hora: cada teste ou resumo conta 1
const HORA_MS = 3600000;
export const TEXTO_TESTE = [
  '🔔 *Teste* do aviso de erro do Achadinho Turbo.',
  'Se esta mensagem chegou, o WhatsApp consegue entregar os avisos a este número.',
  'Nada falhou de verdade.',
].join('\n');
const MAX_ERRO_BRUTO = 500;             // corta antes das regex: texto enorme de uma biblioteca não trava o servidor
const MSG_NUMERO = 'Número inválido. Use DDD e número, ex.: 35 99999-1234.';
const ORIGEM = { id: null, name: 'Avisos' }; // coluna "Regra" do Histórico
const MAX_LINHAS_SAUDE = 5;             // bloco "Saúde dos envios" no fim do resumo (plano rodar-sozinho-entrega3)

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
 * Recusa com 429: o freio das mensagens manuais. `segundos` = quanto falta para poder mandar de novo; `limite` diz qual
 * dos três manda ('numero', 'todos' ou 'hora'); `numeros` = para quantos números ia o envio (o resumo pode ir para vários).
 */
class MuitasManuais extends Error {
  constructor(segundos, limite, numeros = 1) {
    const s = Math.max(1, Math.ceil(segundos));
    const espera = s < 120 ? `${s} s` : `${Math.ceil(s / 60)} min`;
    super(limite === 'numero'
      ? (numeros === 1 ? `Espere ${s} s para mandar outro teste ou resumo a este número.`
        : `Espere ${s} s: um dos números recebeu um teste ou resumo há menos de ${MANUAL_INTERVALO_S} s.`)
      : limite === 'todos' ? `O resumo para todos os números acabou de sair. Espere ${s} s para mandar de novo.`
        : `O limite é de ${MANUAL_MAX_HORA} envios manuais por hora (cada teste ou resumo conta 1, mesmo o resumo para todos). Tente de novo em ${espera}.`);
    this.status = 429; this.segundos = s; this.limite = limite;
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
  // \p{Nd}: qualquer algarismo Unicode (o "１２３" de largura total também é telefone)
  if (novoNome && (nome.match(/\p{Nd}/gu) || []).length > MAX_DIGITOS_NOME) {
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
/**
 * `estadoBackup`: caminho do data/backup-estado.json que o scripts/backup.js grava (sem ele, não há aviso de backup).
 * `inicio`: quando o programa ligou (carência do aviso de atraso).
 * `monotonico`: relógio que só anda com o PC acordado (o `performance.now()` do Linux não conta a suspensão). Comparado
 * com o `now` dos ticks, mostra quando o PC voltou da suspensão: aí a carência recomeça.
 * Vigia (plano rodar-sozinho-entrega3, etapa 4): este arquivo não importa src/vigia.js (o vigia importa `semNumero`
 * daqui), então o que é dele entra por opção, e quem liga os dois é o agendador:
 * - `linhaDeSaude({ execucoes, revisao, abertas, temRegraAtiva, agora })` → texto do bloco "Saúde dos envios" (a de
 *   src/vigia.js). Sem ela, o resumo é o de antes, sem o bloco;
 * - `abertas()` → lista das causas em aberto agora (síncrona; o formato de `causasAbertas` do vigia). Sem ela, ou se
 *   falhar, nenhuma causa: o bloco sai sem "Em aberto agora".
 */
export function createAvisos({ db, wa, estadoBackup = null, inicio = Date.now(), monotonico = () => performance.now(), linhaDeSaude = null, abertas = null } = {}) {
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

  /**
   * Mensagem do vigia aos destinos de "Erro de disparo" (D1): os mesmos do aviso de erro (ativos e com 'erro'), um
   * `entregar` por destino, sem nova tentativa. A linha do Histórico leva só o nome do destino; a falha vira 'aviso'
   * (nunca 'erro', CA3.7). Não confere o WhatsApp nem o silêncio: isso é do vigia, antes de chamar. Nunca lança.
   * → quantos destinos receberam (0 sem texto, sem destino ou com tudo falhando)
   */
  async function entregarAosDeErro(texto, oQue) {
    if (typeof texto !== 'string' || !texto.trim()) return 0;
    // vai ao Histórico: nada de número, nem por descuido de quem chama
    const oque = semNumero(typeof oQue === 'string' && oQue.trim() ? oQue : 'o aviso do vigia');
    let lista;
    try { lista = destinos((d) => d.ativo && d.avisos.includes('erro')); } catch { return 0; }
    let n = 0;
    for (const d of lista) {
      try { if (await entregar(d, texto, oque)) n++; } catch { /* o Histórico falhou: segue para o próximo destino */ }
    }
    return n;
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
    const saude = blocoDeSaude(de, now);
    if (saude) linhas.push('', saude);
    return linhas.join('\n');
  }

  /**
   * Bloco "Saúde dos envios" (spec §2; Decisão 7), uma vez no fim do resumo: as execuções de regra do dia de negócio
   * até `now` (todas as regras, sem filtro de bloco: D7), as ofertas esperando revisão (todas as lojas: D6), se há
   * regra ativa e as causas em aberto. No máximo MAX_LINHAS_SAUDE linhas. Sem a opção `linhaDeSaude`, ou se ela
   * falhar, null: o resumo sai sem o bloco, nunca deixa de sair.
   */
  function blocoDeSaude(de, now) {
    if (typeof linhaDeSaude !== 'function') return null;
    try {
      const execucoes = db.prepare('SELECT id, ts, rule_id, conta, want, saidas, erros, lojas_pedidas, por_loja FROM execucoes WHERE ts >= ? AND ts <= ? ORDER BY id').all(de, now);
      const revisao = Number(db.prepare("SELECT COUNT(*) AS n FROM catalogo_itens WHERE status = 'revisao'").get()?.n) || 0;
      const temRegraAtiva = !!db.prepare('SELECT 1 FROM rules WHERE enabled = 1 LIMIT 1').get();
      let lista = [];
      try { const a = typeof abertas === 'function' ? abertas() : []; if (Array.isArray(a)) lista = a; } catch { /* vigia sem leitura: sem causas */ }
      const texto = linhaDeSaude({ execucoes, revisao, abertas: lista, temRegraAtiva, agora: now });
      if (typeof texto !== 'string' || !texto.trim()) return null;
      return texto.split('\n').slice(0, MAX_LINHAS_SAUDE).join('\n');
    } catch (e) {
      console.error(`[avisos] linha de saúde: ${semNumero(e)}`); // só no console: a linha 'erro' viraria aviso de erro
      return null;
    }
  }

  // Freio das mensagens manuais, pelo relógio monotônico: acertar a hora do PC não destrava nem trava o freio. O
  // `performance.now()` do Linux não anda com o PC suspenso: depois de uma suspensão, a espera pode durar mais que a dita.
  const manuaisPorNumero = new Map(); // jid → quando saiu a última mensagem manual para ele (só em memória; nunca vai a log)
  const manuaisNaHora = [];           // quando saiu cada envio manual da última hora (1 por teste ou resumo, não por número)
  let ultimoTodos = null;             // quando saiu o último resumo manual para todos os números

  /**
   * Reserva um envio manual: uma vaga por JID (todas ou nenhuma), uma vaga na hora e, se `todos`, a do resumo para
   * todos. Sem await: dois pedidos juntos não passam os dois. Sem vaga, lança MuitasManuais com a MAIOR espera entre
   * as três (é a que manda de fato; no empate, a da hora, depois a de todos).
   */
  function reservarManuais(jids, { todos = false } = {}) {
    const agora = monotonico(); const intervalo = MANUAL_INTERVALO_S * 1000;
    while (manuaisNaHora.length && agora - manuaisNaHora[0] >= HORA_MS) manuaisNaHora.shift();
    for (const [jid, ts] of manuaisPorNumero) if (agora - ts >= intervalo) manuaisPorNumero.delete(jid);
    const porNumero = Math.max(0, ...jids.map((j) => (manuaisPorNumero.has(j) ? manuaisPorNumero.get(j) + intervalo - agora : 0)));
    // a fila nunca passa do teto: cheia, a próxima vaga abre quando o envio mais antigo fizer uma hora
    const porHora = manuaisNaHora.length >= MANUAL_MAX_HORA ? manuaisNaHora[manuaisNaHora.length - MANUAL_MAX_HORA] + HORA_MS - agora : 0;
    const porTodos = todos && ultimoTodos != null ? Math.max(0, ultimoTodos + MANUAL_TODOS_INTERVALO_S * 1000 - agora) : 0;
    const [limite, ms] = [['hora', porHora], ['todos', porTodos], ['numero', porNumero]].reduce((a, b) => (b[1] > a[1] ? b : a));
    if (ms > 0) throw new MuitasManuais(ms / 1000, limite, jids.length);
    for (const j of jids) manuaisPorNumero.set(j, agora);
    manuaisNaHora.push(agora);
    if (todos) ultimoTodos = agora;
  }

  /**
   * "Enviar resumo agora": para um destino (destinoId) ou para todos os ativos que recebem o resumo. Divide o freio com
   * o "Enviar teste" (reservarManuais): conta 1 envio na hora, para um número ou para todos; para todos, reserva a vaga
   * de cada número antes do primeiro envio; sem vaga, 429 e nada sai. → { enviados, falhas }
   */
  async function enviarResumo({ destinoId, now = Date.now() } = {}) {
    let alvo; const paraTodos = destinoId == null || destinoId === '';
    if (!paraTodos) {
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
    reservarManuais(alvo.map((d) => d.jid), { todos: paraTodos });
    let enviados = 0;
    for (const d of alvo) if (await entregar(d, montarResumo(d.resumo_blocos, now), 'o resumo')) enviados++;
    return { enviados, falhas: alvo.length - enviados };
  }

  /**
   * "Enviar teste": manda o TEXTO_TESTE a um destino pelo mesmo caminho dos avisos (entregar: a linha do Histórico
   * leva só o nome). Vale para destino desligado e para o que não marcou "Erro de disparo": a resposta diz os dois.
   * Freio: o das mensagens manuais (reservarManuais), dividido com o "Enviar resumo agora"; a vaga é reservada antes do
   * envio, então um clique duplo não manda duas mensagens. Um envio que falha gasta a vaga.
   * → { enviado: true, ativo, recebe_erro }
   */
  async function enviarTeste({ destinoId } = {}) {
    const id = idValido(destinoId); const d = destinos((x) => x.id === id)[0];
    if (!d) throw new Error('Número não encontrado.');
    if (!wa.isReady()) throw new Error('Conecte o WhatsApp em Números de WhatsApp para enviar o teste.');
    reservarManuais([d.jid]);
    if (!await entregar(d, TEXTO_TESTE, 'o teste do aviso de erro')) throw new Error('Não consegui enviar o teste. Veja o motivo no Histórico.');
    return { enviado: true, ativo: d.ativo, recebe_erro: d.avisos.includes('erro') };
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

  // ---------- backup ----------
  /** Lê o estado do backup: null = o arquivo não existe; 'ilegivel' = existe mas não dá para confiar; senão o objeto. */
  function lerEstadoBackup() {
    let fd = null;
    try {
      // lstat não segue link simbólico; o que não é arquivo comum (FIFO, dispositivo, pasta, link) não é o nosso arquivo
      if (!fs.lstatSync(estadoBackup).isFile()) return 'ilegivel';
      // O_NOFOLLOW/O_NONBLOCK: se o arquivo for trocado por um link ou FIFO entre o lstat e o open, o open não segue nem espera
      fd = fs.openSync(estadoBackup, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!fs.fstatSync(fd).isFile()) return 'ilegivel';
      const buf = Buffer.alloc(BACKUP_ESTADO_MAX + 1); // um byte além do limite basta para saber que passou
      let n = 0;
      while (n < buf.length) {
        const r = fs.readSync(fd, buf, n, buf.length - n, null);
        if (r === 0) break;
        n += r;
      }
      if (n > BACKUP_ESTADO_MAX) return 'ilegivel';
      const e = JSON.parse(buf.toString('utf8', 0, n));
      return e && typeof e === 'object' && !Array.isArray(e) ? e : 'ilegivel';
    } catch (e) { return e?.code === 'ENOENT' ? null : 'ilegivel'; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* já fechado */ } }
  }
  const registrarBackup = (level, message) => addLog(db, { rule: ORIGEM_BACKUP, level, message }); // coluna "Regra": Backup
  const instante = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const ladoOk = (l) => l && typeof l === 'object' && l.ok === true;
  const motivoDe = (l) => (typeof l?.motivo === 'string' && Object.hasOwn(MOTIVOS_BACKUP, l.motivo) ? MOTIVOS_BACKUP[l.motivo] : undefined);

  /** Linha do Histórico de uma execução nova do backup: 'ok' ou 'aviso', nunca 'erro' (não pode gerar aviso de erro de disparo). */
  function linhaDoBackup(e) {
    const { local, drive } = e;
    const drivePronto = ladoOk(drive);
    const copias = Number.isInteger(drive?.copias) && drive.copias >= 0 && drive.copias <= 1000 ? drive.copias : null;
    const partes = [ladoOk(local) ? 'cópia no computador ok' : `cópia no computador falhou${motivoDe(local) ? ` (${motivoDe(local)})` : ''}`];
    if (drivePronto) partes.push(`cópia no Google Drive ok${copias == null ? '' : ` (${copias} ${copias === 1 ? 'cópia guardada' : 'cópias guardadas'})`}`);
    else if (drive?.ok === false) partes.push(`cópia no Google Drive falhou${motivoDe(drive) ? ` (${motivoDe(drive)})` : ''}`);
    else partes.push('cópia no Google Drive não foi tentada');
    if (drivePronto && motivoDe(drive)) partes.push(`atenção: ${motivoDe(drive)}`);
    registrarBackup(ladoOk(local) && drivePronto && !motivoDe(drive) ? 'ok' : 'aviso', `Backup automático: ${partes.join('; ')}.`);
  }

  // Carência do aviso de atraso: desde que o programa ligou ou desde que o PC voltou da suspensão (o timer do backup é
  // Persistent e roda logo ao acordar). Um tick demorado (regra disparando por muitos minutos) não conta como suspensão:
  // nele o relógio monotônico anda junto com o de parede.
  let inicioCarencia = inicio;
  let tickAnterior = null; // { now, mono } da passada anterior (os dois lidos no começo do tick)

  const idade = (ts, now) => (ts == null ? 'nunca deu certo' : `há ${Math.max(0, Math.floor((now - ts) / 3600000))} h`);

  /**
   * Backup: cada execução nova do `auto` (tentativa_em diferente de backup_visto) vira uma linha no Histórico. Se o último
   * sucesso, local ou do Drive, é mais velho que BACKUP_ATRASO_H (ou o estado não pode ser lido), avisa os destinos que
   * recebem "Erro de disparo", 1× a cada 24 h (avisos_backup_ultimo) e só depois da carência de 60 min desde `inicio` ou
   * desde a volta da suspensão (o relógio de parede andou mais de BACKUP_SALTO_MS além do monotônico entre dois ticks;
   * `now` e `mono` são lidos juntos no começo do tick, antes de qualquer envio que possa demorar).
   * Sem destinos, só o Histórico. Com destinos e o WhatsApp fora, espera. Nada de caminho nem número no texto.
   * Não é `async`: só devolve uma promise quando há entrega a fazer. Uma passada que não tem o que mandar (quase todas)
   * não acrescenta voltas de microtask ao tick, e os testes que correm contra o relógio (qa-grade) dependem dessa ordem.
   */
  function avisoDeBackup(now, mono) {
    if (!estadoBackup) return;
    if (tickAnterior && (now - tickAnterior.now) - (mono - tickAnterior.mono) > BACKUP_SALTO_MS) inicioCarencia = now;
    tickAnterior = { now, mono };
    const e = lerEstadoBackup();
    if (e == null) return; // nunca rodou (ou o automático não foi instalado): nada a dizer
    if (e !== 'ilegivel') {
      const t = instante(e.tentativa_em);
      if (t != null && String(t) !== String(getSetting(db, 'backup_visto'))) { setSetting(db, 'backup_visto', t); linhaDoBackup(e); }
    }
    if (now - inicioCarencia < BACKUP_CARENCIA_MS) return;
    const ok = e === 'ilegivel' ? [] : [instante(e.ultimo_ok_local), instante(e.ultimo_ok_drive)];
    const limite = BACKUP_ATRASO_H * 3600000;
    if (e !== 'ilegivel' && ok.every((t) => t != null && now - t <= limite)) return; // em dia
    if (now - Number(getSetting(db, 'avisos_backup_ultimo', 0)) < BACKUP_REPETIR_MS) return;
    const lista = destinos((d) => d.ativo && d.avisos.includes('erro'));
    if (lista.length && !wa.isReady()) return; // espera o WhatsApp voltar
    setSetting(db, 'avisos_backup_ultimo', now);
    const itens = e === 'ilegivel' ? ['Não consegui ler o estado do backup']
      : [`Cópia no computador: ${idade(ok[0], now)}`, `Cópia no Google Drive: ${idade(ok[1], now)}`];
    registrarBackup('aviso', `Backup atrasado. ${itens.join('; ')}.${lista.length ? '' : ' Nenhum número recebe o aviso de erro de disparo.'}`);
    const texto = ['⚠️ *O backup está atrasado*', ...itens.map((i) => (e === 'ilegivel' ? `${i}.` : `• ${i}`)), '',
      'Veja o Histórico no painel e confira o backup automático (capítulo Manutenção dos Docs).'].join('\n');
    if (!lista.length) return undefined;
    return (async () => { for (const d of lista) await entregar(d, texto, 'o aviso de backup atrasado'); })();
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
     * Chamado a cada tick: resumo diário, aviso de erro, backup e aviso de lotação. Uma parte que falha não impede as outras;
     * o erro sobe sem número (o agendador o mostra no console).
     */
    async tick(now = Date.now()) {
      let falha = null;
      const mono = monotonico(); // junto com o `now`: um envio lento antes do backup não pode parecer suspensão no tick seguinte
      for (const passo of [resumoDiario, avisoDeErro, avisoDeBackup, avisoDeLotacao]) {
        try { const r = passo(now, mono); if (r) await r; } catch (e) { falha ??= e; }
      }
      if (falha) throw new Error(semNumero(falha));
    },
    montarResumo,
    enviarResumo,
    enviarTeste,
    entregarAosDeErro,
  };
}

/**
 * Rotas de F3, montadas por buildApp depois do login e da checagem Host/Origin.
 * ctx = { db, wa, links, scheduler, auth, wrap, soDono, dataDir, ml, enderecoPublico }; os avisos são ctx.scheduler.avisos.
 */
export function montarRotas(app, ctx) {
  const { db, wrap } = ctx;
  // sem ctx.soDono (servidor montado sem ele), ninguém faz o que é só do Dono: falha fechada
  const soDono = typeof ctx.soDono === 'function' ? ctx.soDono : (_req, res) => res.status(403).json({ erro: 'Só o Dono pode fazer isso.' });
  let proprio = null; // só se o agendador não trouxer os avisos
  // Freio do cadastro: cada consulta de número ao WhatsApp (onWhatsApp) conta, por IP. Varrer números com a sessão
  // do painel poderia marcar o número do dono como robô.
  const consultas = createLimiter({ max: CONSULTAS_MAX, windowMs: CONSULTAS_JANELA_MS });
  const freioDe = (req) => () => {
    const ip = chaveIp(req.ip);
    if (consultas.blocked(ip)) throw new MuitasConsultas(consultas.retryAfterS(ip));
    consultas.fail(ip);
  };
  /** Como o wrap do servidor, mas o 429 do freio de mensagens manuais chega como 429, com os segundos e o Retry-After. */
  const comLimite = (fn) => async (req, res) => {
    try { res.json(await fn(req) ?? { ok: true }); } catch (e) {
      if (e instanceof MuitasManuais) { res.set('Retry-After', String(e.segundos)); return res.status(429).json({ erro: e.message, segundos: e.segundos }); }
      res.status(400).json({ erro: e.message });
    }
  };
  /**
   * S1: no PUT, trocar o número (qualquer número digitado), tirar "Erro de disparo" ou desligar um número ativo que
   * recebe "Erro de disparo" é só do Dono: desligado, ele deixa de receber os avisos de erro e de backup atrasado. O
   * Operador liga qualquer número, desliga os que não recebem "Erro de disparo", troca o nome e mexe nos blocos do
   * resumo. Corpo que não é objeto não muda nada disso (o PUT o recusa). O `!b.ativo` é o mesmo `!!b.ativo` do
   * destinoDoCorpo: o que aqui conta como desligar é o que lá desliga.
   */
  const pedeDono = (b, atual) => {
    if (!b || typeof b !== 'object') return false;
    if (Object.hasOwn(b, 'numero') && String(b.numero ?? '').trim()) return true;
    const recebeErro = atual.avisos.includes('erro');
    if (Object.hasOwn(b, 'ativo') && !b.ativo && atual.ativo && recebeErro) return true;
    return Object.hasOwn(b, 'avisos') && recebeErro && !(Array.isArray(b.avisos) && b.avisos.includes('erro'));
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
  // cadastrar e apagar número: só o Dono (S1: um número novo é mais um destino para mensagens pelo número do dono)
  app.post('/api/avisos/destinos', soDono, comFreio(async (req) => {
    const d = await destinoDoCorpo(ctx, req.body, null, freioDe(req));
    const id = db.prepare('INSERT INTO aviso_destinos (nome, jid, resumo_blocos, avisos, ativo, created_at) VALUES (?,?,?,?,?,?)')
      .run(d.nome, d.jid, d.resumo_blocos, d.avisos, d.ativo, Date.now()).lastInsertRowid;
    return { id: Number(id) };
  }));
  app.put('/api/avisos/destinos/:id', (req, res, next) => {
    let atual;
    try { atual = destinoPorId(req.params.id); } catch (e) { return res.status(400).json({ erro: e.message }); }
    return pedeDono(req.body, atual) ? soDono(req, res, next) : next();
  }, comFreio(async (req) => {
    const atual = destinoPorId(req.params.id);
    const d = await destinoDoCorpo(ctx, req.body, atual, freioDe(req));
    db.prepare('UPDATE aviso_destinos SET nome = ?, jid = ?, resumo_blocos = ?, avisos = ?, ativo = ? WHERE id = ?')
      .run(d.nome, d.jid, d.resumo_blocos, d.avisos, d.ativo, atual.id);
  }));
  app.delete('/api/avisos/destinos/:id', soDono, wrap((req) => {
    if (!db.prepare('DELETE FROM aviso_destinos WHERE id = ?').run(idValido(req.params.id)).changes) throw new Error('Número não encontrado.');
  }));
  app.put('/api/avisos/config', wrap((req) => salvarConfig(db, req.body || {})));
  app.get('/api/avisos/previa', wrap((req) => {
    const id = req.query.destino;
    if (id == null || id === '') return { texto: avisos().montarResumo([]), recebe: true };
    const d = destinoPorId(id);
    return d.resumo_blocos == null ? { texto: '', recebe: false } : { texto: avisos().montarResumo(d.resumo_blocos), recebe: true };
  }));
  // resumo agora e "Enviar teste" dividem o freio das mensagens manuais (429 com os segundos que faltam)
  app.post('/api/avisos/resumo-agora', comLimite((req) => avisos().enviarResumo({ destinoId: req.body?.destino_id })));
  // "Enviar teste": manda uma mensagem pelo número do dono, então só o Dono (o Operador recebe 403)
  app.post('/api/avisos/destinos/:id/teste', soDono, comLimite((req) => avisos().enviarTeste({ destinoId: req.params.id })));
}
