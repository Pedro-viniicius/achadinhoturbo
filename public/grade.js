// Grade de horários do Disparo automático (plano grade-de-disparos, etapa 7; spec grade-de-disparos, "Layout: grade na
// regra" e "Cartão"). Editor da grade dentro de "Ritmo de envio" (formRegra, app.js), conversão "intervalo → grade",
// modelos rápidos e "Montar…", resumo do dia, estimativa de mensagens por dia do número (aviso acima de
// AVISO_MENSAGENS_DIA, sem bloquear) e o resumo do cartão (cartaoRegra).
// Carrega antes de app.js e só define nomes: esc, $, $$, S, api, q, REQ e DISP_DIAS (disparos.js) são lidos na hora da
// chamada. Todo texto do dono (nome de regra e de template) passa por esc(). As frases de erro são as de src/grade.js
// (validarGrade), que o servidor devolve no 400: o cliente avisa antes, com as mesmas palavras.

const TEXTOS_GRADE = {
  comoEnviar: 'Como enviar', intervalo: 'A cada X minutos', grade: 'Em horários marcados',
  dias: 'Em quais dias', diasDica: 'Os mesmos horários valem nos dias marcados.',
  modelos: 'Modelos rápidos', montar: 'Montar…',
  de: 'De', ate: 'Até', cada: 'A cada', cadaMin: (n) => `${n} min`, ofertasEm: 'Ofertas em cada',
  substituir: 'Substituir horários', acrescentar: 'Acrescentar',
  horarios: 'Horários', horario: 'Horário', ofertas: 'Ofertas', template: 'Template',
  padrao: (nome) => `Padrão da regra (${nome})`, apagado: '(template apagado)',
  linha: (n) => `Horário ${n}`, copiar: 'Copiar', remover: 'Remover',
  copiarRot: (h) => `Copiar horário ${h}`, removerRot: (h) => `Remover horário ${h}`, semHora: 'sem hora',
  adicionar: '+ Adicionar horário', limpar: 'Limpar tudo', limparConfirma: 'Apagar todos os horários desta grade?',
  contador: (n, max) => `(${n} de ${max} horários)`,
  vazio: 'Nenhum horário ainda. Comece por um modelo ou adicione um horário.',
  movido: (n) => `Horário movido para a posição ${n}.`,
  pausas: 'As pausas entre mensagens são as de',
  confirmaTroca: (n) => `Isso troca os horários atuais por ${n} novos. Continuar?`,
  geradorMax: (n, max) => `Isso daria ${n} horários, e o máximo é ${max}. Aumente o intervalo ou encurte o período.`,
  geradorVazio: 'Confira o “De” e o “Até”: nenhum horário cabe nesse período.',
  // mesmas frases de src/grade.js (validarGrade)
  erroDia: 'Marque ao menos um dia.', erroSemHorario: 'Adicione ao menos um horário.',
  erroMax: (max) => `A grade aceita no máximo ${max} horários.`, erroHora: 'Horário inválido: use HH:MM.',
  erroQtd: (h, max) => `Horário ${h}: ofertas de 1 a ${max}.`,
  erroTpl: (h) => `Horário ${h}: o template escolhido não existe mais. Escolha outro.`,
  erroRepetido: (h) => `Já existe um horário às ${h}.`,
  erroPerto: (a, b, min) => `Os horários ${a} e ${b} estão a menos de ${min} min um do outro.`,
  // resumo vivo do formulário (neutro, não é aviso)
  resumo: (n, de, ate, ofertas, grupos) => `${n} ${n === 1 ? 'horário' : 'horários'} por dia, ${n === 1 ? `às ${de}` : `das ${de} às ${ate}`}. `
    + `${ofertas} ${ofertas === 1 ? 'oferta' : 'ofertas'} por dia`
    + (grupos ? ` em ${grupos} ${grupos === 1 ? 'grupo' : 'grupos'} (${ofertas * grupos} ${ofertas * grupos === 1 ? 'mensagem' : 'mensagens'}).` : ', ainda sem grupo marcado.'),
  aviso: (total, limite, comRotinas) => `Com os disparos${comRotinas ? ' e as rotinas' : ''} ligados, este número enviaria cerca de ${total.toLocaleString('pt-BR')} mensagens por dia. `
    + `Acima de ${limite} aumenta o risco de bloqueio do WhatsApp. Para baixar: menos ofertas por horário, menos horários ou menos grupos.`,
  // cartão
  chip: 'Grade',
  cartaoRes: (n, faixa, ofertas, dias, grupos) => `${n} ${n === 1 ? 'horário' : 'horários'} por dia (${faixa}), ${ofertas}, ${dias}, para ${grupos} ${grupos === 1 ? 'grupo' : 'grupos'}.`,
  umTemplate: (nome) => `Template: ${nome}.`, variosTemplates: (n) => `Templates: ${n} diferentes.`,
  proximo: (quando, qtd, tpl) => `Próximo envio ${quando}: ${qtd} ${qtd === 1 ? 'oferta' : 'ofertas'} com o template ${tpl}.`,
  emInstantes: (qtd, tpl) => `Enviando em instantes: ${qtd} ${qtd === 1 ? 'oferta' : 'ofertas'} com o template ${tpl}.`,
};
// Acima disto o painel avisa (P5: estimativa conservadora; o WhatsApp não publica limite). Não bloqueia.
const AVISO_MENSAGENS_DIA = 400;
// Os mesmos de src/grade.js; valem os de /api/state.grade quando o servidor manda.
const GRADE_LIMITES_PADRAO = { max_horarios: 48, intervalo_min: 10, tolerancia_min: 30, max_qtd: 20 };
const GRADE_CADA = [15, 30, 45, 60, 90, 120];
// Modelos rápidos: atalhos que preenchem o gerador e já aplicam ("Substituir").
const GRADE_MODELOS = [
  { id: 'meia-hora', rotulo: 'A cada 30 min, 8h às 22h', de: '08:00', ate: '22:00', cada: 30 },
  { id: 'hora', rotulo: 'A cada hora, 8h às 22h', de: '08:00', ate: '22:00', cada: 60 },
  { id: 'tres', rotulo: 'Manhã, tarde e noite', horas: ['09:00', '15:00', '20:00'] },
  { id: 'pico', rotulo: 'Horários de pico', horas: ['12:00', '18:00', '21:00'] },
];
const GRADE_HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/; // o HHMM de src/envios.js
const GRADE_DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const GRADE_DIAS_LONGOS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** Limites da grade: os de /api/state.grade, com os de src/grade.js como reserva. */
function gradeLimites() {
  const s = S.st?.grade || {}; const L = { ...GRADE_LIMITES_PADRAO };
  for (const k of Object.keys(L)) if (Number.isInteger(s[k]) && s[k] > 0) L[k] = s[k];
  return L;
}
const gradePad = (n) => String(n).padStart(2, '0');
/** 'HH:MM' (ou 'H:MM') → minutos do dia; inválido → NaN. */
function gradeMin(h) { const m = GRADE_HHMM.exec(String(h ?? '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; }
/** Minutos (qualquer inteiro) → 'HH:MM' do dia. */
const gradeHora = (min) => { const m = ((min % 1440) + 1440) % 1440; return `${gradePad(Math.floor(m / 60))}:${gradePad(m % 60)}`; };
/** Inteiro de um número ou de um texto só com dígitos (como `inteiro` de src/grade.js); outra coisa: NaN. */
function gradeInteiro(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v.trim())) return Number(v.trim());
  return NaN;
}
const gradeOrdenar = (hs) => [...hs].sort((a, b) => gradeMin(a.hora) - gradeMin(b.hora));

/**
 * Erros da grade, na ordem em que validarGrade (src/grade.js) os acharia e com as mesmas frases, mas todos de uma vez:
 * [{ msg, i?, campo }] com `i` = índice da linha em `g.horarios` e `campo` = 'dias' | 'lista' | 'hora' | 'qtd' | 'tpl'.
 * `templateExiste(id)`: padrão = está em S.templates.
 */
function gradeValidar(g, { templateExiste } = {}) {
  const T = TEXTOS_GRADE; const L = gradeLimites(); const erros = [];
  const existe = typeof templateExiste === 'function' ? templateExiste : (id) => (S.templates || []).some((t) => t.id === id);
  if (!Array.isArray(g?.dias) || !g.dias.length) erros.push({ msg: T.erroDia, campo: 'dias' });
  const hs = Array.isArray(g?.horarios) ? g.horarios : [];
  if (!hs.length) { erros.push({ msg: T.erroSemHorario, campo: 'lista' }); return erros; }
  if (hs.length > L.max_horarios) erros.push({ msg: T.erroMax(L.max_horarios), campo: 'lista' });
  const boas = [];
  hs.forEach((l, i) => {
    const m = GRADE_HHMM.exec(typeof l?.hora === 'string' ? l.hora.trim() : '');
    if (!m) { erros.push({ msg: T.erroHora, i, campo: 'hora' }); return; }
    const hora = `${gradePad(m[1])}:${m[2]}`;
    const qtd = gradeInteiro(l.qtd);
    if (!(qtd >= 1 && qtd <= L.max_qtd)) erros.push({ msg: T.erroQtd(hora, L.max_qtd), i, campo: 'qtd' });
    if (l.template_id != null && l.template_id !== '') {
      const id = gradeInteiro(l.template_id);
      if (!(id >= 1) || !existe(id)) erros.push({ msg: T.erroTpl(hora), i, campo: 'tpl' });
    }
    boas.push({ hora, i, min: gradeMin(hora) });
  });
  boas.sort((a, b) => a.min - b.min);
  for (let k = 1; k < boas.length; k++) {
    const a = boas[k - 1]; const b = boas[k];
    if (a.min === b.min) erros.push({ msg: T.erroRepetido(b.hora), i: b.i, campo: 'hora' });
    else if (b.min - a.min < L.intervalo_min) erros.push({ msg: T.erroPerto(a.hora, b.hora, L.intervalo_min), i: b.i, campo: 'hora' });
  }
  const vistos = new Set();
  return erros.filter((e) => !vistos.has(e.msg) && vistos.add(e.msg));
}

/** Horários de `de` a `ate` (inclusive; "Até" antes de "De" vira a noite) a cada `cada` min. → [{ hora, qtd, template_id }] */
function gradeGerar({ de, ate, cada, qtd, template_id = null }) {
  const s = gradeMin(de); let e = gradeMin(ate); const passo = Number(cada);
  if (!Number.isFinite(s) || !Number.isFinite(e) || !(passo >= 1)) return [];
  if (e < s) e += 1440;
  const vistos = new Set(); const out = [];
  for (let m = s; m <= e && out.length <= 1440; m += passo) {
    const hora = gradeHora(m);
    if (!vistos.has(hora)) { vistos.add(hora); out.push({ hora, qtd, template_id }); }
  }
  return gradeOrdenar(out);
}

/** Minutos de funcionamento da janela (como inWindow de src/scheduler.js: início = fim é o dia todo; pode virar a noite). */
function gradeJanela(ini, fim) {
  const s = gradeMin(ini); const e = gradeMin(fim);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 1440;
  return s === e ? 1440 : (e - s + 1440) % 1440;
}
/**
 * "A cada X minutos" → linhas da grade, para a primeira vez em "Em horários marcados": do início da janela, a cada
 * intervalo, enquanto estiver dentro dela (o fim não entra, como no agendador). Só se o resultado for uma grade
 * válida (até 48 linhas, 10 min entre elas, ofertas de 1 a 20); senão, [] (a grade começa vazia, com os modelos).
 */
function gradeDeIntervalo({ per_run, interval_min, window_start, window_end } = {}) {
  const iv = gradeInteiro(interval_min); const s = gradeMin(window_start);
  if (!(iv >= 1) || !Number.isFinite(s)) return [];
  const n = Math.ceil(gradeJanela(window_start, window_end) / iv);
  if (n > gradeLimites().max_horarios) return [];
  const qtd = gradeInteiro(per_run);
  const hs = gradeOrdenar(Array.from({ length: n }, (_, k) => ({ hora: gradeHora(s + k * iv), qtd, template_id: null })));
  return gradeValidar({ dias: [0], horarios: hs }).length ? [] : hs;
}

/** Mensagens por dia de uma regra salva (ofertas × grupos): com grade, a soma das ofertas dos horários; sem, ofertas × ⌈janela ÷ intervalo⌉. */
function gradeMensagensRegra(r) {
  const grupos = Array.isArray(r?.group_jids) ? r.group_jids.length : 0;
  if (r?.grade && Array.isArray(r.grade.horarios)) return grupos * r.grade.horarios.reduce((s, l) => s + (gradeInteiro(l?.qtd) || 0), 0);
  const iv = gradeInteiro(r?.interval_min); const por = gradeInteiro(r?.per_run);
  if (!(iv >= 1) || !(por >= 1)) return 0;
  return grupos * por * Math.ceil(gradeJanela(r.window_start, r.window_end) / iv);
}
/**
 * Estimativa do número (CA13): regras ligadas (a aberta entra com `atual.msgs`, do formulário, ligada ou não) e
 * rotinas do Grupo vivo ligadas (horários × grupos). Por dia em que tudo roda: não desconta dias da semana.
 */
function gradeMensagensDia({ regras = [], rotinas = [], atual = null } = {}) {
  let total = atual ? Number(atual.msgs) || 0 : 0;
  for (const r of regras) if (r?.enabled && (!atual || r.id !== atual.id)) total += gradeMensagensRegra(r);
  for (const x of rotinas || []) {
    if (!x?.enabled) continue;
    total += (Array.isArray(x.repetir?.horarios) ? x.repetir.horarios.length : 0) * (Array.isArray(x.group_jids) ? x.group_jids.length : 0);
  }
  return total;
}

/** Resumo vivo do formulário: "14 horários por dia, das 08:00 às 21:30. 42 ofertas por dia em 2 grupos (84 mensagens)." */
function gradeResumo(horarios, grupos) {
  const boas = gradeOrdenar((horarios || []).filter((l) => Number.isFinite(gradeMin(l.hora))));
  if (!boas.length) return '';
  const ofertas = boas.reduce((s, l) => s + (gradeInteiro(l.qtd) || 0), 0);
  return TEXTOS_GRADE.resumo(boas.length, gradeHora(gradeMin(boas[0].hora)), gradeHora(gradeMin(boas.at(-1).hora)), ofertas, grupos);
}
/** [1,2,3,4,5] → "seg a sex"; [0,6] → "dom e sáb"; os 7 → "todos os dias". */
function gradeDiasTexto(dias) {
  const ds = [...new Set((dias || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  if (ds.length === 7) return 'todos os dias';
  const corridos = ds.length >= 3 && ds.every((d, i) => !i || d === ds[i - 1] + 1);
  if (corridos) return `${GRADE_DIAS_CURTOS[ds[0]]} a ${GRADE_DIAS_CURTOS[ds.at(-1)]}`;
  const nomes = ds.map((d) => GRADE_DIAS_CURTOS[d]);
  return nomes.length <= 1 ? nomes.join('') : `${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}`;
}
/** "hoje às 10:30", "amanhã às 08:00" ou "quarta às 08:00". */
function gradeQuando(ts) {
  const d = new Date(ts); const hm = `${gradePad(d.getHours())}:${gradePad(d.getMinutes())}`;
  const meiaNoite = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dias = Math.round((meiaNoite(d) - meiaNoite(new Date())) / 864e5);
  return `${dias === 0 ? 'hoje' : dias === 1 ? 'amanhã' : GRADE_DIAS_LONGOS[d.getDay()]} às ${hm}`;
}
const gradeNomeTemplate = (id) => (S.templates || []).find((t) => t.id === id)?.name;

/**
 * Peças do cartão de uma regra com grade (CA9): { chip, res, tpls, prox }, já com esc(). O próximo horário vem de
 * GET /api/rules (`proximo_horario`: { ts, hora, qtd, template_id }, ou só o ts); sem ele, o texto de sempre (proximo).
 */
function gradeCartao(r) {
  const T = TEXTOS_GRADE; const hs = gradeOrdenar((r.grade?.horarios || []).filter((l) => Number.isFinite(gradeMin(l?.hora))));
  const qtds = hs.map((l) => gradeInteiro(l.qtd)).filter((n) => n >= 1);
  const min = Math.min(...qtds); const max = Math.max(...qtds);
  const ofertas = !qtds.length ? '0 ofertas' : min === max ? `${min} ${min === 1 ? 'oferta' : 'ofertas'}${hs.length > 1 ? ' cada' : ''}` : `de ${min} a ${max} ofertas cada`;
  const faixa = !hs.length ? '—' : hs.length === 1 ? hs[0].hora : `${hs[0].hora} a ${hs.at(-1).hora}`;
  const grupos = Array.isArray(r.group_jids) ? r.group_jids.length : 0;
  const res = esc(T.cartaoRes(hs.length, faixa, ofertas, gradeDiasTexto(r.grade?.dias), grupos));
  const usados = [...new Set(hs.map((l) => gradeInteiro(l.template_id) >= 1 ? gradeInteiro(l.template_id) : r.template_id))];
  const tpls = usados.length > 1 ? T.variosTemplates(usados.length) : T.umTemplate(esc(gradeNomeTemplate(usados[0] ?? r.template_id) || '—'));
  let prox = proximo(r);
  const ph = typeof r.proximo_horario === 'number' ? { ts: r.proximo_horario } : r.proximo_horario;
  if (r.enabled && !r.em_andamento && Number.isFinite(ph?.ts)) {
    const linha = ph.qtd != null ? ph : hs.find((l) => l.hora === gradeHora(new Date(ph.ts).getHours() * 60 + new Date(ph.ts).getMinutes())) || {};
    const qtd = gradeInteiro(linha.qtd) >= 1 ? gradeInteiro(linha.qtd) : gradeInteiro(r.per_run);
    const tpl = esc(gradeNomeTemplate(gradeInteiro(linha.template_id) >= 1 ? gradeInteiro(linha.template_id) : r.template_id) || '—');
    prox = ph.ts <= Date.now() ? T.emInstantes(qtd, tpl) : T.proximo(gradeQuando(ph.ts), qtd, tpl);
  }
  return { chip: ` <span class="chip">${T.chip}</span>`, res, tpls, prox };
}

// ---------- formulário ----------
/** O `.seg` "Como enviar" (primeiro item de "Ritmo de envio"). */
function gradeModoHtml(modo) {
  const T = TEXTOS_GRADE;
  return `<div class="gh-bloco"><span id="r-modo-h" class="gh-tit">${T.comoEnviar} ${q('regras.modo_grade')}</span>
    ${dispSegHtml('r-modo', [['intervalo', T.intervalo], ['grade', T.grade]], modo, 'r-modo-h')}</div>`;
}
/** Opções de template de uma linha: "Padrão da regra ({nome})" + os templates; id que sumiu fica marcado como apagado. */
function gradeOpcoesTemplate(sel, padraoNome) {
  const T = TEXTOS_GRADE; const id = gradeInteiro(sel); const tpls = S.templates || [];
  const sumiu = id >= 1 && !tpls.some((t) => t.id === id);
  return `<option value="">${esc(T.padrao(padraoNome ?? '—'))}</option>`
    + tpls.map((t) => `<option value="${Number(t.id)}" ${t.id === id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
    + (sumiu ? `<option value="${id}" selected>${T.apagado}</option>` : '');
}
/** Uma linha da lista (`k` é a chave estável da linha; `i`, a posição). */
function gradeLinhaHtml(l, i, k, padraoNome) {
  const T = TEXTOS_GRADE; const L = gradeLimites();
  const hora = Number.isFinite(gradeMin(l.hora)) ? gradeHora(gradeMin(l.hora)) : String(l.hora ?? '');
  const rot = hora || T.semHora;
  return `<li class="gh-linha" role="group" aria-label="${esc(T.linha(i + 1))}" data-k="${Number(k)}">
    <label class="campo"><span class="gh-rot">${T.horario}</span><input type="time" class="gh-h" value="${esc(hora)}"></label>
    <label class="campo"><span class="gh-rot">${T.ofertas}</span><input type="number" class="gh-q" min="1" max="${L.max_qtd}" step="1" inputmode="numeric" value="${esc(l.qtd ?? '')}"></label>
    <label class="campo gh-tpl"><span class="gh-rot">${T.template}</span><select class="gh-t">${gradeOpcoesTemplate(l.template_id, padraoNome)}</select></label>
    <div class="gh-acoes"><button type="button" data-gh="copiar" aria-label="${esc(T.copiarRot(rot))}">${T.copiar}</button><button type="button" class="leve perigo" data-gh="remover" aria-label="${esc(T.removerRot(rot))}">${T.remover}</button></div></li>`;
}
/** Bloco `#r-grade` (escondido no modo intervalo). A lista é pintada por gradeLigar. */
function gradeHtml(r) {
  const T = TEXTOS_GRADE; const padraoNome = gradeNomeTemplate(gradeInteiro(r?.template_id)) ?? '—';
  const qtd = gradeInteiro(r?.per_run) >= 1 && gradeInteiro(r?.per_run) <= gradeLimites().max_qtd ? gradeInteiro(r.per_run) : 3;
  return `<div id="r-grade" class="gh" hidden>
    <div class="gh-bloco"><span id="gh-dias-h" class="gh-tit">${T.dias} ${REQ}</span>
      <div class="dias" id="gh-dias" role="group" aria-labelledby="gh-dias-h" aria-describedby="gh-dias-d">${DISP_DIAS.map((d) => `<button type="button" data-d="${d.d}" aria-pressed="false" aria-label="${d.nome}" title="${d.nome}">${d.letra}</button>`).join('')}</div>
      <small class="dica" id="gh-dias-d">${T.diasDica}</small></div>
    <div class="gh-bloco"><span id="gh-mod-h" class="gh-tit">${T.modelos} ${q('regras.grade_modelos')}</span>
      <div class="linha gh-modelos" role="group" aria-labelledby="gh-mod-h">${GRADE_MODELOS.map((m) => `<button type="button" class="chip" data-gh-modelo="${m.id}">${m.rotulo}</button>`).join('')}<button type="button" class="chip" id="gh-montar" aria-expanded="false" aria-controls="gh-gerador">${T.montar}</button></div>
      <div id="gh-gerador" class="gh-gerador" hidden>
        <div class="grade gh-ger-campos">
          <label class="campo">${T.de}<input type="time" id="gh-ger-de" value="08:00"></label>
          <label class="campo">${T.ate}<input type="time" id="gh-ger-ate" value="22:00"></label>
          <label class="campo">${T.cada}<select id="gh-ger-cada">${GRADE_CADA.map((n) => `<option value="${n}" ${n === 60 ? 'selected' : ''}>${T.cadaMin(n)}</option>`).join('')}</select></label>
          <label class="campo">${T.ofertasEm}<input type="number" id="gh-ger-qtd" min="1" max="${gradeLimites().max_qtd}" step="1" inputmode="numeric" value="${qtd}"></label>
          <label class="campo gh-tpl">${T.template}<select id="gh-ger-tpl">${gradeOpcoesTemplate(null, padraoNome)}</select></label></div>
        <div class="linha"><button type="button" data-gh="substituir">${T.substituir}</button><button type="button" data-gh="acrescentar">${T.acrescentar}</button><small id="gh-ger-st" class="dica" role="status"></small></div></div></div>
    <div class="gh-bloco"><span id="gh-lista-h" class="gh-tit">${T.horarios} ${REQ} ${q('regras.grade_horarios')}</span>
      <div class="gh-cab" aria-hidden="true"><span>${T.horario}</span><span>${T.ofertas}</span><span>${T.template}</span><span></span></div>
      <ol class="gh-lista" id="gh-lista" aria-labelledby="gh-lista-h"></ol>
      <div class="vazio gh-vazio" id="gh-vazio" hidden>${T.vazio}</div>
      <div class="linha"><button type="button" id="gh-add">${T.adicionar}</button><button type="button" class="leve" id="gh-limpar">${T.limpar}</button><span class="dica" id="gh-cont" aria-live="polite"></span></div>
      <span class="sr-only" id="gh-mov" role="status"></span></div>
    <p class="dica gh-resumo" id="gh-resumo" role="status" aria-live="polite"></p>
    <p class="nivel-aviso gh-aviso" id="gh-aviso" role="status" hidden></p>
    <p class="dica" style="margin:0">${T.pausas} <a href="#ajustes">Ajustes</a>.</p></div>`;
}

/**
 * Liga o editor dentro de `raiz` (o diálogo de formRegra), já com gradeModoHtml e gradeHtml no lugar.
 * opts = { regra, nGrupos: () => número de grupos marcados, lerIntervalo: () => { per_run, interval_min, window_start, window_end } }.
 * Os campos do intervalo têm a classe `r-intervalo` e só ficam escondidos (os valores continuam no formulário).
 * Devolve { modo(), corpo() → grade | null, erros() → [{ msg, el }], atualizar() }.
 */
function gradeLigar(raiz, { regra = {}, nGrupos = () => 0, lerIntervalo = () => ({}) } = {}) {
  const T = TEXTOS_GRADE;
  const bloco = $('#r-grade', raiz); const lista = $('#gh-lista', raiz); const diasEl = $('#gh-dias', raiz);
  const tplRegra = $('[name=template_id]', raiz);
  let modo = regra.grade ? 'grade' : 'intervalo';
  let iniciada = !!regra.grade; // regra sem grade: a lista nasce da conversão na primeira vez em "Em horários marcados"
  let rotinas = null; let pediuRotinas = false; let chave = 0;
  const padraoNome = () => gradeNomeTemplate(gradeInteiro(tplRegra?.value)) ?? '—';
  const qtdPadrao = () => { const n = gradeInteiro(lerIntervalo().per_run); return n >= 1 && n <= gradeLimites().max_qtd ? n : 3; };

  const lerLinhas = () => $$('#gh-lista > li', raiz).map((li) => ({ hora: $('.gh-h', li).value.trim(), qtd: $('.gh-q', li).value.trim(), template_id: $('.gh-t', li).value || null, li }));
  const pintar = (linhas, focoK) => {
    const nome = padraoNome();
    lista.innerHTML = gradeOrdenarEstavel(linhas).map((l, i) => gradeLinhaHtml(l, i, l.k ?? ++chave, nome)).join('');
    if (focoK != null) $(`#gh-lista > li[data-k="${focoK}"] .gh-h`, raiz)?.focus();
    atualizar();
  };
  const pintarDias = (dias) => $$('button', diasEl).forEach((b) => b.setAttribute('aria-pressed', String(dias.includes(Number(b.dataset.d)))));
  const diasMarcados = () => $$('button[aria-pressed="true"]', diasEl).map((b) => Number(b.dataset.d));
  /** Linhas para uma nova pintura: a chave estável de cada uma e os valores como estão na tela. */
  const atuais = () => lerLinhas().map((l) => ({ hora: l.hora, qtd: l.qtd, template_id: l.template_id, k: Number(l.li.dataset.k) }));
  const minutosUsados = () => lerLinhas().map((l) => gradeMin(l.hora)).filter(Number.isFinite);
  /** Primeiro minuto a partir de `ini` (de 10 em 10, dando a volta no dia) com 10 min de folga para todos os outros. */
  const livre = (ini) => {
    const usados = minutosUsados(); const folga = gradeLimites().intervalo_min;
    for (let d = 0; d < 1440; d += 10) { const c = (ini + d) % 1440; if (usados.every((u) => Math.abs(u - c) >= folga)) return c; }
    return ini % 1440;
  };

  function atualizar() {
    const linhas = lerLinhas(); const L = gradeLimites(); const n = linhas.length;
    $('#gh-vazio', raiz).hidden = n > 0; lista.hidden = n === 0; $('.gh-cab', raiz).hidden = n === 0;
    const cont = $('#gh-cont', raiz); if (cont.textContent !== T.contador(n, L.max_horarios)) cont.textContent = T.contador(n, L.max_horarios);
    $('#gh-add', raiz).disabled = n >= L.max_horarios;
    $('#gh-limpar', raiz).hidden = n === 0;
    $$('[data-gh="copiar"]', lista).forEach((b) => (b.disabled = n >= L.max_horarios));
    // rótulos com o número da linha e a hora atual (leitor de tela)
    linhas.forEach((l, i) => {
      const rot = Number.isFinite(gradeMin(l.hora)) ? gradeHora(gradeMin(l.hora)) : T.semHora;
      l.li.setAttribute('aria-label', T.linha(i + 1));
      $('[data-gh="copiar"]', l.li).setAttribute('aria-label', T.copiarRot(rot));
      $('[data-gh="remover"]', l.li).setAttribute('aria-label', T.removerRot(rot));
    });
    const grupos = nGrupos();
    // só troca o texto quando ele muda: os role=status não repetem o anúncio a cada alteração
    const resumo = gradeResumo(linhas, grupos); const rs = $('#gh-resumo', raiz); if (rs.textContent !== resumo) rs.textContent = resumo;
    // estimativa do número: só com a grade à vista (o aviso fica no bloco da grade)
    const av = $('#gh-aviso', raiz);
    const msgs = grupos * linhas.reduce((s, l) => s + (Number.isFinite(gradeMin(l.hora)) ? gradeInteiro(l.qtd) || 0 : 0), 0);
    const ligadas = (rotinas || []).filter((x) => x?.enabled);
    const total = gradeMensagensDia({ regras: S.rules || [], rotinas: ligadas, atual: { id: regra.id, msgs } });
    const passou = modo === 'grade' && total > AVISO_MENSAGENS_DIA;
    const html = passou ? `<b>!</b> ${esc(T.aviso(total, AVISO_MENSAGENS_DIA, ligadas.length > 0))}` : '';
    av.hidden = !passou; if (av.innerHTML !== html) av.innerHTML = html;
  }
  /** Rotinas do Grupo vivo, para a estimativa: pedidas uma vez, quando a grade aparece; sem a rota, contam zero. */
  const pedirRotinas = () => {
    if (pediuRotinas) return; pediuRotinas = true;
    api('/rotinas').then((x) => { rotinas = Array.isArray(x) ? x : []; }).catch(() => { rotinas = []; }).then(() => { if (bloco.isConnected) atualizar(); });
  };
  const mostrarModo = () => {
    bloco.hidden = modo !== 'grade';
    $$('.r-intervalo', raiz).forEach((el) => (el.hidden = modo === 'grade'));
    if (modo !== 'grade') return;
    if (!iniciada) { iniciada = true; pintar(gradeDeIntervalo(lerIntervalo())); }
    pedirRotinas(); atualizar();
  };
  /** Troca ou acrescenta horários (gerador e modelos). Passou do máximo: não aplica e diz por quê. */
  const aplicar = (novas, acrescentar) => {
    const st = $('#gh-ger-st', raiz); const L = gradeLimites();
    if (!novas.length) { st.textContent = T.geradorVazio; return; }
    const atuaisL = atuais();
    let final;
    if (acrescentar) {
      const tem = new Set(atuaisL.map((l) => gradeMin(l.hora)));
      final = [...atuaisL, ...novas.filter((l) => !tem.has(gradeMin(l.hora)))];
    } else final = novas;
    if (final.length > L.max_horarios) { st.textContent = T.geradorMax(final.length, L.max_horarios); return; }
    if (!acrescentar && atuaisL.length && !confirm(T.confirmaTroca(novas.length))) return;
    st.textContent = '';
    pintar(final);
  };
  const doGerador = (extra = {}) => {
    const qtd = gradeInteiro($('#gh-ger-qtd', raiz).value);
    const tpl = gradeInteiro($('#gh-ger-tpl', raiz).value);
    const base = { qtd: Number.isFinite(qtd) ? qtd : $('#gh-ger-qtd', raiz).value, template_id: tpl >= 1 ? tpl : null };
    if (extra.horas) return extra.horas.map((hora) => ({ hora, ...base }));
    return gradeGerar({ de: $('#gh-ger-de', raiz).value, ate: $('#gh-ger-ate', raiz).value, cada: $('#gh-ger-cada', raiz).value, ...base });
  };

  // ---- ligações ----
  dispLigarSeg($('#r-modo', raiz), (v) => { modo = v === 'grade' ? 'grade' : 'intervalo'; mostrarModo(); });
  diasEl.onclick = (e) => { const b = e.target.closest('button[data-d]'); if (!b) return; b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); };
  $('#gh-montar', raiz).onclick = (e) => {
    const b = e.target.closest('button'); const aberto = b.getAttribute('aria-expanded') === 'true';
    b.setAttribute('aria-expanded', String(!aberto)); $('#gh-gerador', raiz).hidden = aberto;
    if (!aberto) $('#gh-ger-de', raiz).focus();
  };
  $('.gh-modelos', raiz).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-gh-modelo]'); if (!b) return;
    const m = GRADE_MODELOS.find((x) => x.id === b.dataset.ghModelo); if (!m) return;
    if (m.de) { $('#gh-ger-de', raiz).value = m.de; $('#gh-ger-ate', raiz).value = m.ate; $('#gh-ger-cada', raiz).value = String(m.cada); }
    aplicar(doGerador(m.horas ? { horas: m.horas } : {}), false);
  });
  $('[data-gh="substituir"]', raiz).onclick = () => aplicar(doGerador(), false);
  $('[data-gh="acrescentar"]', raiz).onclick = () => aplicar(doGerador(), true);
  $('#gh-add', raiz).onclick = () => {
    const ls = atuais(); const ult = gradeOrdenar(ls.filter((l) => Number.isFinite(gradeMin(l.hora)))).at(-1);
    const nova = ult ? { hora: gradeHora(livre(gradeMin(ult.hora) + 60)), qtd: ult.qtd, template_id: ult.template_id } : { hora: '08:00', qtd: qtdPadrao(), template_id: null };
    nova.k = ++chave; pintar([...ls, nova], nova.k);
  };
  $('#gh-limpar', raiz).onclick = () => {
    if (!lerLinhas().length || !confirm(T.limparConfirma)) return;
    pintar([]); $('#gh-add', raiz).focus();
  };
  lista.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-gh]'); if (!b) return;
    const li = b.closest('li'); const k = Number(li.dataset.k); const ls = atuais(); const i = ls.findIndex((l) => l.k === k);
    if (b.dataset.gh === 'copiar') {
      const o = ls[i]; const m = gradeMin(o.hora);
      const nova = { hora: Number.isFinite(m) ? gradeHora(livre(m + 30)) : '', qtd: o.qtd, template_id: o.template_id, k: ++chave };
      pintar([...ls, nova], nova.k);
    } else if (b.dataset.gh === 'remover') {
      ls.splice(i, 1);
      const foco = ls[Math.max(0, i - 1)]?.k;
      pintar(ls, foco);
      if (foco == null) $('#gh-add', raiz).focus();
    }
  });
  // reordenar só ao sair do campo de horário (nunca enquanto digita): a linha é movida, não recriada
  lista.addEventListener('focusout', (e) => {
    const h = e.target; if (!h?.classList?.contains('gh-h')) return;
    const li = h.closest('li'); const m = gradeMin(h.value); if (!Number.isFinite(m)) return;
    const irmaos = $$('#gh-lista > li', raiz).filter((x) => x !== li);
    const depois = irmaos.find((x) => { const n = gradeMin($('.gh-h', x).value); return Number.isFinite(n) && n > m; });
    const antes = $$('#gh-lista > li', raiz);
    const posAntes = antes.indexOf(li);
    if (depois) { if (li.nextElementSibling !== depois) lista.insertBefore(li, depois); } else if (antes.at(-1) !== li) lista.appendChild(li);
    const pos = $$('#gh-lista > li', raiz).indexOf(li);
    if (pos !== posAntes) {
      $('#gh-mov', raiz).textContent = T.movido(pos + 1);
      const destino = e.relatedTarget;
      if (destino && li.contains(destino)) setTimeout(() => { if (destino.isConnected && document.activeElement !== destino) destino.focus(); }, 0);
    }
    atualizar();
  });
  bloco.addEventListener('change', () => atualizar());
  tplRegra?.addEventListener('change', () => {
    const nome = T.padrao(padraoNome());
    $$('.gh-t option[value=""], #gh-ger-tpl option[value=""]', raiz).forEach((o) => (o.textContent = nome));
  });

  // ---- estado inicial ----
  const g = regra.grade || {};
  pintarDias(Array.isArray(g.dias) && g.dias.length ? g.dias.map(Number) : [0, 1, 2, 3, 4, 5, 6]);
  pintar(Array.isArray(g.horarios) ? g.horarios : []);
  mostrarModo();

  /** Corpo da regra: a grade em "Em horários marcados"; null em "A cada X minutos" (o PUT sem grade grava NULL). */
  const corpo = () => (modo !== 'grade' ? null : {
    dias: diasMarcados(),
    horarios: lerLinhas().map((l) => ({ hora: l.hora, qtd: Number.isFinite(gradeInteiro(l.qtd)) ? gradeInteiro(l.qtd) : l.qtd, template_id: gradeInteiro(l.template_id) >= 1 ? gradeInteiro(l.template_id) : null })),
  });
  /** Erros da grade para mostrarErros: [{ msg, el }]; marca aria-invalid nos campos (e limpa os que ficaram bons). */
  const erros = () => {
    $$('[aria-invalid]', bloco).forEach((el) => el.removeAttribute('aria-invalid'));
    if (modo !== 'grade') return [];
    const ls = lerLinhas(); const campo = { hora: '.gh-h', qtd: '.gh-q', tpl: '.gh-t' };
    return gradeValidar(corpo()).map((e) => {
      const el = e.campo === 'dias' ? $('button', diasEl) : e.campo === 'lista' ? $('#gh-add', raiz) : $(campo[e.campo], ls[e.i].li);
      if (e.i != null) el.setAttribute('aria-invalid', 'true');
      return { msg: e.msg, el };
    });
  };
  return { modo: () => modo, atualizar, corpo, erros };
}
/** Ordena por hora, deixando as linhas sem hora válida no fim, na ordem em que estavam. */
function gradeOrdenarEstavel(linhas) {
  const boas = linhas.filter((l) => Number.isFinite(gradeMin(l.hora))); const ruins = linhas.filter((l) => !Number.isFinite(gradeMin(l.hora)));
  return [...gradeOrdenar(boas), ...ruins];
}
