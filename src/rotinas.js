// Grupo vivo (plano grade-de-disparos, D6 e D7; ADR-007; CA11): rotinas recorrentes de mensagem ou enquete, com até 5
// conteúdos em rodízio ("um depois do outro") ou sorteio (sem repetir o último), para os grupos escolhidos, nos dias da
// semana e de 1 a 6 horários (o mesmo `repetir` do Disparar mensagem, calculado por proximaOcorrencia).
//
// Ciclo (o do espelho e dos remetentes): a tabela `rotinas` é só configuração. No horário, processarPendentes() grava
// uma ocorrência 'agora' na fila única de `envios` (src/envios.js), que tem a trava, a retomada, as pausas de Ajustes e
// o histórico por grupo, e pede um tick ao agendador (acordar). O Histórico mostra "Grupo vivo: <nome>" (origemDoLog).
// Sem envio duplicado: a ocorrência é gravada numa transação BEGIN IMMEDIATE cuja trava é o UPDATE da rotina no horário
// que foi lido (next_run_at, proximo_indice e updated_at iguais, changes === 1): dois ticks, ou uma edição no meio,
// não gravam a mesma ocorrência duas vezes nem com o texto velho.
//
// Horário perdido (P2, a mesma regra da grade, src/grade.js resolverVencido): atraso de até 30 min sai; passou disso,
// pula com uma linha de aviso; se vários venceram, sai só o mais recente. Com o WhatsApp fora, a rotina vencida espera
// sem gravar nada (gravar 'agora' deixaria a fila mandar com até 2 h de atraso); passados os 30 min, pula.
//
// Sem foto na 1ª versão (P9): o upload some 7 dias depois de ficar sem envio ativo. Operador tem os mesmos direitos do
// Dono aqui (P15). Dado pessoal: o log e a lista levam o nome do grupo, nunca o JID; o console, só o código do erro.

import { addLog } from './db.js';
import { proximaOcorrencia, validarTextoMensagem, validarEnquete, HHMM } from './envios.js';
import { resolverVencido, TOLERANCIA_MIN } from './grade.js';

export const MAX_CONTEUDOS = 5;          // textos ou enquetes em rodízio (P12)
export const MAX_HORARIOS_ROTINA = 6;    // horários por rotina: os mesmos 6 do Repetir (P6)
export const MAX_ROTINAS = 50;           // rotinas guardadas (ligadas ou não): o teto que os Docs e o README citam
export const ENVIAR_AGORA_INTERVALO_MIN = 1; // "Enviar agora": no máximo um por minuto em cada rotina (clique repetido)
const MAX_NOME = 60;
const MAX_GRUPOS = 500;
const MAX_NOME_LOG = 80;
const TOLERANCIA_MS = TOLERANCIA_MIN * 60000;
const FREIO_MS = ENVIAR_AGORA_INTERVALO_MIN * 60000;
const DIA = 86400000;
const TIPOS = ['mensagem', 'enquete'];
const ORDENS = ['rodizio', 'sorteio'];
const SEM_GRUPO = '(grupo removido)';
// payload.origem de um envio `e` no SQL; payload ilegível dá NULL (json_extract sozinho lançaria erro)
const ORIGEM_TIPO = "(CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.origem.tipo') END)";
const ORIGEM_ROTINA = "(CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.origem.rotina_id') END)";

/** Frases da tela (400 e 404 da API). Nenhuma leva JID nem número. */
const MSG = Object.freeze({
  naoEncontrada: 'Rotina não encontrada.',
  semNome: 'Dê um nome à rotina.',
  nomeLongo: `O nome pode ter até ${MAX_NOME} letras.`,
  tipo: 'Escolha o tipo: mensagem ou enquete.',
  tipoFixo: 'O tipo de uma rotina não muda. Crie outra rotina para mudar de mensagem para enquete.',
  muitosConteudos: (tipo) => `Uma rotina tem no máximo ${MAX_CONTEUDOS} ${tipo === 'enquete' ? 'enquetes' : 'textos'}.`,
  ordem: 'Ordem: um depois do outro ou sorteio.',
  semGrupos: 'Marque ao menos um grupo.',
  gruposInvalidos: 'Lista de grupos inválida.',
  muitosGrupos: `Marque no máximo ${MAX_GRUPOS} grupos.`,
  grupoSumiu: 'Algum grupo escolhido não existe mais. Atualize a lista e escolha de novo.',
  semRepetir: 'Escolha os dias e os horários da rotina.',
  semDia: 'Marque ao menos um dia.',
  semHorario: 'Adicione ao menos um horário.',
  horaInvalida: 'Horário inválido: use HH:MM.',
  horaRepetida: (h) => `Já existe um horário às ${h}.`,
  muitosHorarios: `Uma rotina aceita no máximo ${MAX_HORARIOS_ROTINA} horários.`,
  muitasRotinas: `O programa guarda no máximo ${MAX_ROTINAS} rotinas. Exclua uma para criar outra.`,
  ativo: 'Ativo: ligue ou desligue.',
  desconectado: 'O WhatsApp está desconectado. Conecte o número antes de disparar.', // a mesma do "agora" de envios.criar
  semGruposAgora: 'Os grupos desta rotina não existem mais. Edite a rotina e escolha os grupos de novo.',
  semTextoAgora: 'Esta rotina está sem texto. Edite a rotina.',
  freio: `Esta rotina já foi enviada agora há pouco. Espere ${ENVIAR_AGORA_INTERVALO_MIN === 1 ? 'um minuto' : `${ENVIAR_AGORA_INTERVALO_MIN} minutos`} para enviar de novo.`,
  indisponivel: 'O Grupo vivo não está disponível neste servidor.',
  inesperado: 'Não consegui concluir. Tente de novo.',
});

/** Linhas do Histórico (nível aviso), com horários no formato dd/mm HH:MM. */
const PERDIDO = 'o programa estava desligado, o WhatsApp desconectado ou outro envio demorou.';
const AVISOS = Object.freeze({
  semGrupos: 'Não enviada: os grupos desta rotina não existem mais. Edite a rotina e escolha os grupos.',
  semTexto: 'Não enviada: a rotina está sem texto. Edite a rotina.',
});

/** Erro com status HTTP (montarRotas responde com ele). A mensagem é sempre uma frase fixa de MSG ou dos validadores. */
class ErroRotina extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.name = 'ErroRotina';
    this.status = status;
  }
}

const pad = (n) => String(n).padStart(2, '0');
const hora = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const lerJson = (txt, padrao) => { try { return JSON.parse(txt) ?? padrao; } catch { return padrao; } };
const nomeDoErro = (e) => String(e?.code || e?.name || 'erro').slice(0, 60);
const objetoSimples = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validador de src/envios.js (Error com a frase da tela) → ErroRotina 400 com a mesma frase, com a posição na frente
 * quando há mais de um conteúdo. Erro de outro tipo (TypeError…) segue como está: não é frase para a tela.
 */
function comoCampo(fn, prefixo = '') {
  try { return fn(); } catch (e) {
    if (e instanceof ErroRotina || e?.constructor !== Error) throw e;
    throw new ErroRotina(400, `${prefixo}${e.message}`);
  }
}

/** Linha do banco → rotina com os JSON lidos (ilegível vira vazio: a ocorrência avisa em vez de quebrar o tick). */
function lerRotina(r) {
  if (!r) return null;
  const conteudos = lerJson(r.conteudos, []);
  const grupos = lerJson(r.group_jids, []);
  return {
    ...r,
    enabled: !!r.enabled,
    conteudos: Array.isArray(conteudos) ? conteudos : [],
    group_jids: Array.isArray(grupos) ? grupos.filter((j) => typeof j === 'string') : [],
    repetir: lerJson(r.repetir, null),
  };
}

/**
 * Rotinas do Grupo vivo. `wa`: o WhatsApp (isReady); `acordar`: pede um tick do agendador já (é por ele que a ocorrência
 * sai); sem ele, `envios.processarPendentes`. `agora`: relógio e `sortear`: número em [0, 1) do sorteio (testes).
 */
export function createRotinas({ db, wa = null, acordar = null, envios = null, agora = Date.now, sortear = Math.random } = {}) {
  const waPronto = () => { try { return !!wa?.isReady?.(); } catch { return false; } };
  const grupoExiste = (jid) => !!db.prepare('SELECT 1 FROM groups WHERE jid = ?').get(jid);
  const nomeDoLog = (nome) => `Grupo vivo: ${String(nome ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOME_LOG) || 'sem nome'}`;
  const log = (nome, o) => addLog(db, { rule: { id: null, name: nomeDoLog(nome) }, ...o });
  const rotinaPorId = (id) => lerRotina(db.prepare('SELECT * FROM rotinas WHERE id = ?').get(id));
  // "Enviar agora" aceito por rotina (id → ts), só em memória: reiniciar o programa zera o freio, o que basta para o
  // clique repetido. Ts no futuro (o relógio do computador voltou) não freia.
  const enviadoAgora = new Map();
  const freado = (id, now) => { const t = enviadoAgora.get(id); return t != null && now >= t && now - t < FREIO_MS; };

  function transacao(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  function pedirEnvio() {
    if (acordar) { acordar(); return; }
    envios?.processarPendentes?.().catch((e) => console.error('[grupo vivo] fila de envios:', nomeDoErro(e)));
  }

  // ------------------------------------------------------------------------------------------- ocorrência

  /**
   * Conteúdo da vez. Rodízio: `proximo_indice % n`. Sorteio: qualquer um no primeiro envio; depois, um diferente do
   * último (o anterior ao `proximo_indice`) quando há 2 ou mais. → { indice, proximo } (proximo = indice + 1, em volta)
   */
  function escolher(r) {
    const n = r.conteudos.length;
    const atual = ((Number(r.proximo_indice) || 0) % n + n) % n;
    let indice = atual;
    if (r.ordem === 'sorteio' && n > 1) {
      const x = Number(sortear());
      const f = Number.isFinite(x) ? Math.min(Math.max(x, 0), 1 - 1e-9) : 0;
      if (r.last_run_at == null) indice = Math.floor(f * n);
      else {
        const ultimo = (atual - 1 + n) % n;
        const k = Math.floor(f * (n - 1));
        indice = k >= ultimo ? k + 1 : k;
      }
    }
    return { indice, proximo: (indice + 1) % n };
  }

  /** Grava a linha de `envios` ('agora', vencida já) com o conteúdo e a origem. Chamar dentro de transação. → id */
  function gravarEnvio(r, indice, destinos, now) {
    const origem = { tipo: 'rotina', rotina_id: r.id, nome: r.nome };
    const c = r.conteudos[indice];
    const payload = r.tipo === 'enquete'
      ? { pergunta: c?.pergunta, opcoes: c?.opcoes, multipla: c?.multipla === true, origem }
      : { texto: c, imagem: 'nenhuma', origem };
    return Number(db.prepare(`INSERT INTO envios (tipo, payload, group_jids, quando, repetir, status, next_run_at, user_id, created_at)
      VALUES (?, ?, ?, 'agora', NULL, 'pendente', ?, NULL, ?)`).run(r.tipo, JSON.stringify(payload), JSON.stringify(destinos), now, now).lastInsertRowid);
  }

  /** Conteúdo gravado que ainda dá para mandar (o banco pode ter sido mexido à mão). */
  const conteudoOk = (r) => r.conteudos.length > 0 && r.conteudos.every((c) => (r.tipo === 'enquete'
    ? objetoSimples(c) && typeof c.pergunta === 'string' && Array.isArray(c.opcoes)
    : typeof c === 'string' && c.length > 0));

  function avisoDePulados(pulados, executar, proximo) {
    const ultimo = pulados.at(-1);
    const quais = pulados.length === 1 ? `Horário de ${hora(ultimo)} pulado` : `${pulados.length} horários pulados, o último de ${hora(ultimo)}`;
    const depois = executar != null ? ` Sai agora o de ${hora(executar)}.` : proximo != null ? ` Próximo: ${hora(proximo)}.` : '';
    return `${quais}: ${PERDIDO}${depois}`;
  }

  /**
   * Uma rotina vencida, lida em `linha`. Decide pelo horário perdido (resolverVencido) e grava numa transação, com a
   * trava no que foi lido. → true se gravou um envio
   */
  function ocorrencia(linha, now) {
    const r = lerRotina(linha);
    const { executar, pulados, proximo } = resolverVencido((h) => proximaOcorrencia(r.repetir, h), r.next_run_at, now, TOLERANCIA_MS);
    // WhatsApp fora: espera sem mexer em nada; se ele não voltar em 30 min, o horário é pulado num tick seguinte
    if (executar != null && !waPronto()) return false;
    const destinos = executar != null ? [...new Set(r.group_jids)].filter(grupoExiste) : [];
    const temTexto = conteudoOk(r);
    const vai = executar != null && destinos.length > 0 && temTexto;
    const { indice, proximo: proximoIndice } = vai ? escolher(r) : { indice: null, proximo: r.proximo_indice };

    const envioId = transacao(() => {
      const trava = db.prepare(`UPDATE rotinas SET next_run_at = ?, proximo_indice = ?, last_run_at = COALESCE(?, last_run_at)
        WHERE id = ? AND enabled = 1 AND next_run_at = ? AND proximo_indice = ? AND updated_at IS ?`)
        .run(proximo, proximoIndice, vai ? now : null, r.id, r.next_run_at, r.proximo_indice, r.updated_at);
      if (trava.changes !== 1) return undefined; // outro tick, um "Enviar agora" ou uma edição chegou antes
      if (!vai) return null;
      const id = gravarEnvio(r, indice, destinos, now);
      db.prepare('UPDATE rotinas SET ultimo_envio_id = ? WHERE id = ?').run(id, r.id);
      return id;
    });
    if (envioId === undefined) return false;
    if (pulados.length) log(r.nome, { level: 'aviso', message: avisoDePulados(pulados, executar, proximo) });
    if (executar != null && !temTexto) log(r.nome, { level: 'aviso', message: AVISOS.semTexto });
    else if (executar != null && !destinos.length) log(r.nome, { level: 'aviso', message: AVISOS.semGrupos });
    return envioId != null;
  }

  /**
   * Rotinas ligadas com o horário vencido: cada uma grava a sua ocorrência (ou pula). Uma rotina com problema não para
   * as outras (console só com o código). Síncrono por dentro: entre ler e gravar não há espera. → quantos envios gravou
   */
  async function processarPendentes(now = agora()) {
    const vencidas = db.prepare('SELECT * FROM rotinas WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id').all(now);
    let gravados = 0;
    for (const linha of vencidas) {
      try { if (ocorrencia(linha, now)) gravados++; } catch (e) { console.error('[grupo vivo] rotina:', nomeDoErro(e)); }
    }
    if (gravados) pedirEnvio();
    return gravados;
  }

  // ------------------------------------------------------------------------------------------- cadastro

  function idValido(v) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) throw new ErroRotina(404, MSG.naoEncontrada);
    return n;
  }

  function exigirRotina(id) {
    const r = rotinaPorId(idValido(id));
    if (!r) throw new ErroRotina(404, MSG.naoEncontrada);
    return r;
  }

  function lerNome(v) {
    const nome = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!nome) throw new ErroRotina(400, MSG.semNome);
    if (nome.length > MAX_NOME) throw new ErroRotina(400, MSG.nomeLongo);
    return nome;
  }

  /** De 1 a 5 conteúdos do tipo, cada um pelo validador de Disparar mensagem (mesmos limites e frases). */
  function lerConteudos(lista, tipo) {
    const validar = tipo === 'enquete' ? (c) => validarEnquete(objetoSimples(c) ? c : {}) : (c) => validarTextoMensagem(c);
    if (!Array.isArray(lista) || !lista.length) return [comoCampo(() => validar(undefined))]; // lança a frase de "vazio"
    if (lista.length > MAX_CONTEUDOS) throw new ErroRotina(400, MSG.muitosConteudos(tipo));
    const rotulo = tipo === 'enquete' ? 'Enquete' : 'Texto';
    return lista.map((c, i) => comoCampo(() => validar(c), lista.length > 1 ? `${rotulo} ${i + 1}: ` : ''));
  }

  function lerGrupos(lista) {
    if (!Array.isArray(lista) || !lista.length) throw new ErroRotina(400, MSG.semGrupos);
    if (lista.length > MAX_GRUPOS) throw new ErroRotina(400, MSG.muitosGrupos);
    if (lista.some((j) => typeof j !== 'string' || !j)) throw new ErroRotina(400, MSG.gruposInvalidos);
    const jids = [...new Set(lista)];
    if (jids.some((j) => !grupoExiste(j))) throw new ErroRotina(400, MSG.grupoSumiu);
    return jids;
  }

  /** { dias:[0..6], horarios:['HH:MM'] 1..6 }, normalizado (em ordem, hora com 2 dígitos); horário repetido é recusado. */
  function lerRepetir(r) {
    if (!objetoSimples(r)) throw new ErroRotina(400, MSG.semRepetir);
    const brutos = Array.isArray(r.dias) ? r.dias.map((d) => (typeof d === 'string' && /^[0-6]$/.test(d) ? Number(d) : d)) : [];
    if (!brutos.length || brutos.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new ErroRotina(400, MSG.semDia);
    if (!Array.isArray(r.horarios) || !r.horarios.length) throw new ErroRotina(400, MSG.semHorario);
    if (r.horarios.length > MAX_HORARIOS_ROTINA) throw new ErroRotina(400, MSG.muitosHorarios);
    const horarios = [];
    for (const h of r.horarios) {
      const m = HHMM.exec(typeof h === 'string' ? h.trim() : '');
      if (!m) throw new ErroRotina(400, MSG.horaInvalida);
      const hhmm = `${pad(m[1])}:${m[2]}`;
      if (horarios.includes(hhmm)) throw new ErroRotina(400, MSG.horaRepetida(hhmm));
      horarios.push(hhmm);
    }
    return { dias: [...new Set(brutos)].sort((a, b) => a - b), horarios: horarios.sort() };
  }

  function lerAtivo(v, padrao) {
    if (v === undefined) return padrao;
    if (typeof v !== 'boolean') throw new ErroRotina(400, MSG.ativo);
    return v;
  }

  /**
   * Corpo do POST/PUT → campos validados. No PUT (`atual`), campo ausente mantém o atual e o tipo não muda (vir igual
   * é aceito). Sem rede.
   */
  function validarCorpo(corpo, atual) {
    const b = objetoSimples(corpo) ? corpo : {};
    const tem = (k) => Object.hasOwn(b, k);
    const campo = (k, padrao) => (tem(k) ? b[k] : padrao);
    const nome = lerNome(campo('nome', atual?.nome));
    let tipo;
    if (atual) {
      if (tem('tipo') && b.tipo !== atual.tipo) throw new ErroRotina(400, MSG.tipoFixo);
      tipo = atual.tipo;
    } else {
      if (!TIPOS.includes(b.tipo)) throw new ErroRotina(400, MSG.tipo);
      tipo = b.tipo;
    }
    const conteudos = lerConteudos(campo('conteudos', atual?.conteudos), tipo);
    const ordem = campo('ordem', atual?.ordem ?? 'rodizio');
    if (!ORDENS.includes(ordem)) throw new ErroRotina(400, MSG.ordem);
    return {
      nome, tipo, conteudos, ordem,
      group_jids: lerGrupos(campo('group_jids', atual?.group_jids)),
      repetir: lerRepetir(campo('repetir', atual?.repetir)),
      enabled: lerAtivo(campo('enabled', undefined), atual ? atual.enabled : true),
    };
  }

  const proximoDe = (v, now) => (v.enabled ? proximaOcorrencia(v.repetir, now) : null);

  /**
   * POST /api/rotinas. Ligada: o próximo horário a partir de agora; desligada: sem horário. → { id, next_run_at }
   * O id nunca repete o de uma rotina excluída: os envios dela (payload.origem.rotina_id) não passam a contar para outra.
   * Com MAX_ROTINAS guardadas, recusa (400); a contagem é dentro da transação, então dois POST juntos não passam do teto.
   */
  function criar(corpo) {
    const v = validarCorpo(corpo, null);
    const now = agora();
    const next = proximoDe(v, now);
    const id = transacao(() => {
      if (db.prepare('SELECT COUNT(*) AS n FROM rotinas').get().n >= MAX_ROTINAS) throw new ErroRotina(400, MSG.muitasRotinas);
      const novoId = Number(db.prepare(`SELECT MAX(COALESCE((SELECT MAX(id) FROM rotinas), 0),
        COALESCE((SELECT MAX(CAST(${ORIGEM_ROTINA} AS INTEGER)) FROM envios e WHERE ${ORIGEM_TIPO} = 'rotina'), 0)) + 1 AS id`).get().id);
      db.prepare(`INSERT INTO rotinas (id, nome, enabled, tipo, conteudos, ordem, proximo_indice, group_jids, repetir, next_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(novoId, v.nome, v.enabled ? 1 : 0, v.tipo, JSON.stringify(v.conteudos), v.ordem,
        JSON.stringify(v.group_jids), JSON.stringify(v.repetir), next, now, now);
      return novoId;
    });
    return { id, next_run_at: next };
  }

  /**
   * PUT /api/rotinas/:id. Recalcula o próximo horário a partir de agora (ligada) ou o tira (desligada). O rodízio segue
   * de onde estava. Uma ocorrência lida antes da edição não grava mais (a trava confere updated_at). → { id, next_run_at }
   */
  function atualizar(id, corpo) {
    const atual = exigirRotina(id);
    const v = validarCorpo(corpo, atual);
    const now = agora();
    const next = proximoDe(v, now);
    const r = db.prepare(`UPDATE rotinas SET nome = ?, enabled = ?, conteudos = ?, ordem = ?, group_jids = ?, repetir = ?, next_run_at = ?,
      updated_at = ? WHERE id = ?`).run(v.nome, v.enabled ? 1 : 0, JSON.stringify(v.conteudos), v.ordem, JSON.stringify(v.group_jids),
      JSON.stringify(v.repetir), next, now, atual.id);
    if (r.changes !== 1) throw new ErroRotina(404, MSG.naoEncontrada);
    return { id: atual.id, next_run_at: next };
  }

  /** POST /api/rotinas/:id/enabled. Ligar: próximo horário a partir de agora; desligar: sem horário. → { ok, enabled, next_run_at } */
  function ativar(id, enabled) {
    const r = exigirRotina(id);
    if (typeof enabled !== 'boolean') throw new ErroRotina(400, MSG.ativo);
    const now = agora();
    const next = enabled ? proximaOcorrencia(r.repetir, now) : null;
    db.prepare('UPDATE rotinas SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, next, now, r.id);
    return { ok: true, enabled, next_run_at: next };
  }

  /** DELETE /api/rotinas/:id. O que já foi para a fila segue nela; o Histórico fica com o nome. → { ok } */
  function apagar(id) {
    const r = exigirRotina(id);
    db.prepare('DELETE FROM rotinas WHERE id = ?').run(r.id);
    return { ok: true };
  }

  /**
   * POST /api/rotinas/:id/enviar: grava a ocorrência já (ligada ou não) e avança o rodízio, sem mexer no próximo horário.
   * Exige o WhatsApp conectado, como o "agora" de Disparar mensagem. Freio: um envio aceito por minuto em cada rotina
   * (429); o pedido recusado por outro motivo não conta. → { envio_id, grupos }
   */
  function enviarAgora(id) {
    const n = idValido(id);
    if (!rotinaPorId(n)) throw new ErroRotina(404, MSG.naoEncontrada);
    if (!waPronto()) throw new ErroRotina(400, MSG.desconectado);
    const now = agora();
    const feito = transacao(() => {
      const r = rotinaPorId(n);
      if (!r) throw new ErroRotina(404, MSG.naoEncontrada);
      const destinos = [...new Set(r.group_jids)].filter(grupoExiste);
      if (!destinos.length) throw new ErroRotina(400, MSG.semGruposAgora);
      if (!conteudoOk(r)) throw new ErroRotina(400, MSG.semTextoAgora);
      if (freado(r.id, now)) throw new ErroRotina(429, MSG.freio);
      const { indice, proximo } = escolher(r);
      const envioId = gravarEnvio(r, indice, destinos, now);
      db.prepare('UPDATE rotinas SET proximo_indice = ?, last_run_at = ?, ultimo_envio_id = ? WHERE id = ?').run(proximo, now, envioId, r.id);
      return { envio_id: envioId, grupos: destinos.length };
    });
    for (const [rid, t] of enviadoAgora) if (!freado(rid, now)) enviadoAgora.delete(rid); // só os que ainda freiam
    enviadoAgora.set(n, now);
    pedirEnvio();
    return feito;
  }

  /**
   * GET /api/rotinas: a configuração e, das últimas 24 h, quantos grupos receberam e quantos falharam, e o nome do grupo
   * cujo último resultado foi erro (o mais recente; some quando ele volta a receber). Nunca JID fora de `group_jids`.
   */
  function listar(now = agora()) {
    const nomes = new Map(db.prepare('SELECT jid, name FROM groups').all().map((g) => [g.jid, g.name]));
    const porRotina = new Map();
    const resultados = db.prepare(`SELECT ${ORIGEM_ROTINA} AS rotina_id, r.id, r.jid, r.group_name, r.ok
      FROM envio_resultados r JOIN envios e ON e.id = r.envio_id WHERE r.ts >= ? AND ${ORIGEM_TIPO} = 'rotina' ORDER BY r.id`).all(now - DIA);
    for (const x of resultados) {
      const rid = Number(x.rotina_id);
      if (!porRotina.has(rid)) porRotina.set(rid, { ok: 0, erro: 0, ultimo: new Map() });
      const c = porRotina.get(rid);
      if (x.ok) c.ok++; else c.erro++;
      c.ultimo.set(x.jid, x);
    }
    const ultimoErro = (c) => {
      const erros = [...(c?.ultimo.values() ?? [])].filter((x) => !x.ok).sort((a, b) => b.id - a.id);
      if (!erros.length) return null;
      return erros[0].group_name || nomes.get(erros[0].jid) || SEM_GRUPO;
    };
    return db.prepare('SELECT * FROM rotinas ORDER BY id').all().map(lerRotina).map((r) => {
      const c = porRotina.get(r.id);
      return {
        id: r.id, nome: r.nome, enabled: r.enabled, tipo: r.tipo, conteudos: r.conteudos, ordem: r.ordem, group_jids: r.group_jids,
        repetir: r.repetir, next_run_at: r.enabled ? r.next_run_at : null,
        enviadas_24h: c?.ok ?? 0, erros_24h: c?.erro ?? 0, ultimo_erro_grupo: ultimoErro(c),
      };
    });
  }

  return { processarPendentes, listar, criar, atualizar, ativar, apagar, enviarAgora };
}

/** Responde JSON; ErroRotina vira o status dele. Erro inesperado (banco) não devolve nem registra a mensagem. */
const responder = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) {
    if (e instanceof ErroRotina) return res.status(e.status).json({ erro: e.message });
    console.error('[grupo vivo] falha inesperada:', nomeDoErro(e)); // sem e.message: pode trazer os valores da query
    res.status(500).json({ erro: MSG.inesperado });
  }
};

/**
 * Rotas do Grupo vivo, montadas por buildApp depois do login e da checagem Host/Origin (a ligação é da etapa 6). Dono e
 * Operador podem tudo (P15), como no Disparo automático. O serviço é `ctx.rotinas` ou `ctx.scheduler.rotinas`, lido na hora.
 */
export function montarRotas(app, ctx) {
  const servico = () => {
    const s = ctx.rotinas ?? ctx.scheduler?.rotinas;
    if (!s) throw new ErroRotina(503, MSG.indisponivel);
    return s;
  };
  app.get('/api/rotinas', responder(() => servico().listar()));
  app.post('/api/rotinas', responder((req) => servico().criar(req.body)));
  app.put('/api/rotinas/:id', responder((req) => servico().atualizar(req.params.id, req.body)));
  app.post('/api/rotinas/:id/enabled', responder((req) => servico().ativar(req.params.id, req.body?.enabled)));
  app.post('/api/rotinas/:id/enviar', responder((req) => servico().enviarAgora(req.params.id)));
  app.delete('/api/rotinas/:id', responder((req) => servico().apagar(req.params.id)));
}
