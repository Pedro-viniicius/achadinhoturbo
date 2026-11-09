// Relatórios e avisos (#relatorios, F3): números que recebem avisos e o resumo diário, prévia do resumo e
// configurações gerais (horário do resumo, virada do dia, limite padrão por grupo).
// Spec: docs/produto/specs/disparos-comunicacao-conta.md. Plano: docs/produto/planos/disparos-comunicacao-conta.md (etapa 11).
// A rota fica em ROTAS (app.js). Carrega antes de app.js: só define funções e constantes. Os utilitários de app.js
// ($, $$, esc, zap, api, aviso, tentar, mostrarErros, REQ, rotaAtual, atualizarEstado) e de ajuda.js (q) só são usados
// quando a página abre. CSP script-src 'self': nada inline.
// O número completo nunca vem do servidor: a lista e o formulário de edição mostram só a máscara (+55 11 •••••-1234).
// Só o Dono (podeEquipe, de app.js) vê Adicionar número, Remover e Enviar teste, troca o número, tira "Erro de disparo"
// e desliga um número ligado que recebe "Erro de disparo"; o servidor recusa o Operador com 403 nos mesmos casos. O
// Operador liga qualquer número, desliga os que não recebem "Erro de disparo", renomeia e mexe nos blocos.

const TEXTOS_RELATORIOS = {
  titulo: 'Relatórios e avisos',
  sub: 'Quem recebe os avisos e o resumo diário no WhatsApp, e de quais blocos.',
  carregando: 'Carregando…',
  naoCarregou: 'Não consegui carregar agora.',
  enviarAgora: 'Enviar resumo agora', enviando: 'Enviando…',
  adicionar: 'Adicionar número',
  numeros: 'Números que recebem',
  privacidade: 'Os números ficam só no seu computador.',
  vazio: 'Nenhum número cadastrado. Adicione quem deve receber os avisos e o resumo diário.',
  colunas: ['Nome', 'Número', 'Resumo dos blocos', 'Avisos', 'Ativo', 'Ações'],
  todos: 'Todos', naoRecebe: 'Não recebe', blocosApagados: 'Blocos apagados', nenhum: 'Nenhum',
  avisos: { lotacao: 'Grupo lotando', erro: 'Erro de disparo' },
  dicaAviso: {
    lotacao: 'Um grupo de um link ativo do rotacionador chegou perto do limite. Um aviso por grupo.',
    erro: 'Uma mensagem não saiu. No máximo um aviso a cada 30 minutos, com todos os erros juntos.',
  },
  editar: 'Editar', remover: 'Remover',
  // enviar teste (só o Dono vê o botão)
  enviarTeste: 'Enviar teste', enviarTestePara: (nome) => `Enviar teste do aviso de erro para ${nome}`,
  testeEnviado: (nome) => `Teste enviado para “${nome}”. Confira no WhatsApp.`,
  testeDesligado: 'Este número está desligado: ligue-o para receber os avisos de verdade.',
  testeSemErro: 'Ele não recebe os avisos de erro: marque “Erro de disparo” em Editar.',
  testeRecebe: 'Ele recebe os avisos de erro e de backup atrasado.',
  confirmaRemover: 'Remover este número? Ele deixa de receber avisos e resumos.',
  removido: 'Número removido', salvo: 'Número salvo', ligado: 'Número ligado', desligado: 'Número desligado',
  // formulário
  novoTitulo: 'Adicionar número', editarTitulo: 'Editar número',
  nome: 'Nome', nomePh: 'Ex.: Pedro',
  numero: 'Número', numeroPh: '35 99999-1234', numeroDica: 'Com DDD. Exemplo: 35 99999-1234',
  numeroManter: (m) => `Hoje: ${m}. Deixe em branco para manter; digite outro para trocar.`,
  numeroSoDono: (m) => `Hoje: ${m}. Só o Dono troca o número.`, erroSoDono: 'Só o Dono tira este aviso.',
  resumoLegenda: 'Resumo diário: quais blocos', recebe: 'Recebe o resumo diário',
  todosGrupos: 'Todos os grupos', soBlocos: 'Só os blocos marcados:',
  semBlocos: 'Para separar o resumo por nicho, crie blocos em <a href="#blocos">Blocos de análise</a>.',
  avisosLegenda: 'Avisos', ativo: 'Ativo', ativoDica: 'Desligado, o número não recebe nada até você ligar de novo.',
  ativoSoDono: 'Só o Dono desliga um número que recebe “Erro de disparo”.',
  ativoSoDonoLista: 'Só o Dono desliga os números ligados que recebem “Erro de disparo”.',
  salvar: 'Salvar número', salvando: 'Salvando…', cancelar: 'Cancelar',
  faltaNome: 'Dê um nome ao número.', faltaNumero: 'Número inválido. Use DDD e número, ex.: 35 99999-1234.',
  faltaBloco: 'Marque ao menos um bloco ou escolha “Todos os grupos”.',
  // resumo agora
  semAtivo: 'Cadastre um número ativo para enviar o resumo.',
  resumoEnviado: (n) => `Resumo enviado para ${n} ${n === 1 ? 'número' : 'números'}`,
  resumoFalhas: (n) => `${n} não ${n === 1 ? 'recebeu' : 'receberam'}: veja o motivo no Histórico.`,
  resumoEnviadoAs: (texto, hora) => `${texto} às ${hora}.`,
  // prévia
  previa: 'Prévia do resumo', verComo: 'Ver como:', verTodos: 'Todos os grupos',
  previaLegenda: 'Exemplo com os dados de agora.', previaNaoRecebe: 'Este número não recebe o resumo diário.',
  // configurações
  config: 'Configurações gerais',
  horario: 'Horário do resumo diário', horarioDica: 'O resumo sai uma vez por dia, neste horário.',
  virada: 'Virada do dia', viradaDica: 'Entradas até esse horário contam para o dia anterior.',
  limite: 'Limite padrão por grupo', limiteDica: 'O máximo do WhatsApp é 1024.',
  salvarConfig: 'Salvar configurações', configSalva: 'Configurações salvas',
  configSalvaAs: (hora) => `Configurações salvas às ${hora}.`,
  faltaHorario: 'Escolha o horário do resumo diário.', faltaVirada: 'Escolha a virada do dia.',
  faltaLimite: 'O limite padrão por grupo vai de 2 a 1024.',
};
const relHora = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

async function paginaRelatorios() {
  const t = TEXTOS_RELATORIOS;
  $('#pagina').innerHTML = `<div class="topo"><div><h1>${t.titulo} ${q('relatorios')}</h1><p class="sub">${t.carregando}</p></div></div>`;
  let dados;
  try { dados = await api('/avisos'); } catch (e) {
    if (rotaAtual() === 'relatorios') $('#pagina').innerHTML = `<div class="topo"><div><h1>${t.titulo} ${q('relatorios')}</h1><p class="sub">${t.sub}</p></div></div>
      <div class="vazio" role="status">${esc(`${t.naoCarregou} ${e.message}`)}</div>`;
    return;
  }
  if (rotaAtual() !== 'relatorios') return; // saiu da página enquanto carregava
  pintarRelatorios(dados);
}

function pintarRelatorios(d) {
  const t = TEXTOS_RELATORIOS; const pg = $('#pagina');
  const comResumo = d.destinos.filter((x) => x.resumo_blocos != null);
  // "Ver como" só quando os números recebem resumos diferentes entre si ou do "todos os grupos"
  const variam = new Set(['[]', ...comResumo.map((x) => JSON.stringify(x.resumo_blocos))]).size > 1;
  const inicial = comResumo[0] ? String(comResumo[0].id) : '';
  const seletor = variam ? `<label class="linha dica">${t.verComo} <select id="rel-ver" style="width:auto">
      ${comResumo.map((x) => `<option value="${x.id}" ${String(x.id) === inicial ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}
      <option value="">${t.verTodos}</option></select></label>` : '';
  pg.innerHTML = `<div class="topo"><div><h1>${t.titulo} ${q('relatorios')}</h1><p class="sub">${t.sub}</p></div>
      <div class="linha"><button type="button" id="rel-agora">${t.enviarAgora}</button>${podeEquipe() ? `<button type="button" class="pri" id="rel-novo">${t.adicionar}</button>` : ''}</div></div>
    <p class="dica" id="rel-estado" role="status" style="margin:-8px 0 12px"></p>
    <section class="card" aria-labelledby="rel-num-h"><h2 id="rel-num-h">${t.numeros}</h2>
      <p class="dica" style="margin:0 0 12px">${t.privacidade}</p>
      ${d.destinos.some(ativoTravado) ? `<p class="dica" style="margin:0 0 12px">${t.ativoSoDonoLista}</p>` : ''}
      ${d.destinos.length ? tabelaDestinosAviso(d) : `<div class="vazio">${t.vazio}</div>`}</section>
    <section class="card" aria-labelledby="rel-prev-h">
      <div class="linha" style="justify-content:space-between"><h2 id="rel-prev-h" style="margin:0">${t.previa}</h2>${seletor}</div>
      <div class="chat" style="min-height:0;margin-top:10px"><div class="balao" id="rel-previa" aria-live="polite">${t.carregando}</div></div>
      <p class="dica" style="margin:8px 0 0">${t.previaLegenda}</p></section>
    <section class="card" aria-labelledby="rel-cfg-h"><h2 id="rel-cfg-h">${t.config}</h2>
      <form id="rel-cfg" class="form-pilha" novalidate style="margin-top:12px">
        <div class="grade" style="align-items:start">
          <label class="campo"><span>${t.horario}</span><input type="time" name="resumo_horario" value="${esc(d.config.resumo_horario)}" required aria-describedby="rel-h-d"><small id="rel-h-d">${t.horarioDica}</small></label>
          <label class="campo"><span>${t.virada} ${q('relatorios.virada')}</span><input type="time" name="virada_dia" value="${esc(d.config.virada_dia)}" required aria-describedby="rel-v-d"><small id="rel-v-d">${t.viradaDica}</small></label>
          <label class="campo"><span>${t.limite} ${q('relatorios.limite')}</span><input type="number" name="limite_padrao" min="2" max="1024" step="1" inputmode="numeric" value="${esc(d.config.limite_padrao)}" required aria-describedby="rel-l-d"><small id="rel-l-d">${t.limiteDica}</small></label>
        </div>
        <div class="rodape-card"><button type="submit" class="pri" id="rel-cfg-salvar">${t.salvarConfig}</button><span class="dica" id="rel-cfg-estado" role="status"></span></div>
      </form></section>`;

  const novo = $('#rel-novo'); if (novo) novo.onclick = () => formDestinoAviso(d);
  $('#rel-agora').onclick = tentar(() => enviarResumoAgora(d));
  const ver = $('#rel-ver'); if (ver) ver.onchange = () => previaRelatorios(ver.value);
  previaRelatorios(inicial);

  // liga/desliga direto na lista (cada chave tem o próprio tratador: o onchange da página vazaria para a próxima)
  $$('[data-act=ativo]', pg).forEach((inp) => {
    const x = d.destinos.find((y) => String(y.id) === inp.closest('[data-id]').dataset.id);
    inp.onchange = tentar(async () => {
      inp.disabled = true;
      try { await api(`/avisos/destinos/${x.id}`, 'PUT', { ativo: inp.checked }); x.ativo = inp.checked; } catch (e) { inp.checked = !inp.checked; throw e; } finally {
        travarAtivo(inp, x); // o Operador que acabou de ligar um número com "Erro de disparo" não o desliga de volta
      }
      aviso(inp.checked ? t.ligado : t.desligado);
    });
  });
  pg.onclick = tentar(async (ev) => {
    const btn = ev.target.closest('button[data-act]'); if (!btn) return;
    const x = d.destinos.find((y) => String(y.id) === btn.closest('[data-id]').dataset.id); if (!x) return;
    if (btn.dataset.act === 'teste') return enviarTesteAviso(btn, x);
    if (btn.dataset.act === 'editar') formDestinoAviso(d, x);
    if (btn.dataset.act === 'remover' && confirm(t.confirmaRemover)) {
      await api(`/avisos/destinos/${x.id}`, 'DELETE'); aviso(t.removido); paginaRelatorios();
    }
  });
  ligarConfigAvisos(d);
}

function tabelaDestinosAviso(d) {
  const t = TEXTOS_RELATORIOS; const nomeBloco = new Map(d.blocos.map((b) => [b.id, b.nome]));
  const chips = (lista) => lista.map((n) => `<span class="chip">${esc(n)}</span>`).join('');
  const blocos = (x) => (x.resumo_blocos == null ? `<span class="dica">${t.naoRecebe}</span>`
    : !x.resumo_blocos.length ? chips([t.todos])
      : chips(x.resumo_blocos.map((id) => nomeBloco.get(id)).filter(Boolean)) || `<span class="dica">${t.blocosApagados}</span>`);
  const avisos = (x) => (x.avisos.length ? chips(x.avisos.map((a) => t.avisos[a] || a)) : `<span class="dica">${t.nenhum}</span>`);
  // "Enviar teste" e "Remover": só o Dono vê (podeEquipe, de app.js; o servidor recusa o Operador com 403)
  const dono = podeEquipe();
  const teste = (x) => (dono ? `<button type="button" data-act="teste" aria-label="${esc(t.enviarTestePara(x.nome))}">${t.enviarTeste}</button>
        ` : '');
  const remover = (x) => (dono ? `
        <button type="button" class="perigo leve" data-act="remover" aria-label="${esc(`${t.remover} ${x.nome}`)}">${t.remover}</button>` : '');
  // chave Ativo travada para o Operador num número ligado que recebe "Erro de disparo" (a dica vai no title e no leitor de tela)
  const chave = (x) => { const trava = ativoTravado(x);
    return `<label class="chave" title="${trava ? t.ativoSoDono : t.ativo}" style="display:inline-block;vertical-align:middle"><input type="checkbox" data-act="ativo" ${x.ativo ? 'checked' : ''}${trava ? ' disabled' : ''} aria-label="${esc(`${t.ativo}: ${x.nome}`)}" aria-describedby="rel-ativo-d-${x.id}"><span></span></label><span class="sr-only" id="rel-ativo-d-${x.id}">${trava ? t.ativoSoDono : ''}</span>`; };
  return `<div class="tabela"><table><thead><tr>${t.colunas.map((c, i) => `<th scope="col"${i === t.colunas.length - 1 ? ' style="text-align:right"' : ''}>${c}</th>`).join('')}</tr></thead><tbody>
    ${d.destinos.map((x) => `<tr data-id="${x.id}"><td>${esc(x.nome)}</td><td><span class="mono" style="white-space:nowrap">${esc(x.numero)}</span></td>
      <td><div class="chips">${blocos(x)}</div></td><td><div class="chips">${avisos(x)}</div></td>
      <td>${chave(x)}</td>
      <td style="text-align:right;white-space:nowrap">${teste(x)}<button type="button" data-act="editar" aria-label="${esc(`${t.editar} ${x.nome}`)}">${t.editar}</button>${remover(x)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

/** Texto do resumo que o destino receberia (ou o de todos os grupos, sem destino). */
async function previaRelatorios(destinoId) {
  const t = TEXTOS_RELATORIOS; const el = $('#rel-previa'); if (!el) return;
  el.textContent = t.carregando;
  try {
    const r = await api('/avisos/previa' + (destinoId ? `?destino=${encodeURIComponent(destinoId)}` : ''));
    if (!el.isConnected) return;
    if (r.recebe) el.innerHTML = zap(r.texto); else el.textContent = t.previaNaoRecebe;
  } catch (e) { if (el.isConnected) el.textContent = `${t.naoCarregou} ${e.message}`; }
}

async function enviarResumoAgora(d) {
  const t = TEXTOS_RELATORIOS; const btn = $('#rel-agora');
  if (!d.destinos.some((x) => x.ativo && x.resumo_blocos != null)) { aviso(t.semAtivo, true); return; }
  btn.disabled = true; btn.textContent = t.enviando; btn.setAttribute('aria-busy', 'true');
  let r;
  try { r = await api('/avisos/resumo-agora', 'POST', {}); } finally {
    if (btn.isConnected) { btn.disabled = false; btn.textContent = t.enviarAgora; btn.removeAttribute('aria-busy'); }
  }
  const texto = t.resumoEnviado(r.enviados);
  const estado = $('#rel-estado');
  if (estado) estado.textContent = t.resumoEnviadoAs(texto, relHora()) + (r.falhas ? ` ${t.resumoFalhas(r.falhas)}` : '');
  aviso(r.falhas ? `${texto}. ${t.resumoFalhas(r.falhas)}` : texto, !r.enviados);
}

/**
 * S1: o Operador não desliga um número ligado que recebe "Erro de disparo" (ele cala os avisos de erro e de backup
 * atrasado); o servidor recusa com 403. Ligar e desligar os outros continua livre.
 */
function ativoTravado(x) { return !podeEquipe() && !!x.ativo && x.avisos.includes('erro'); }

/** Põe a chave Ativo da lista no estado de `x` (travada ou não, com a dica). */
function travarAtivo(inp, x) {
  const t = TEXTOS_RELATORIOS; const trava = ativoTravado(x);
  inp.disabled = trava;
  const rotulo = inp.closest('label'); if (rotulo) rotulo.title = trava ? t.ativoSoDono : t.ativo;
  const dica = $(`#rel-ativo-d-${x.id}`); if (dica) dica.textContent = trava ? t.ativoSoDono : '';
}

/** "Enviar teste": o botão fica travado enquanto envia (um clique duplo não manda duas); o servidor também freia. */
async function enviarTesteAviso(btn, x) {
  const t = TEXTOS_RELATORIOS; if (btn.disabled) return;
  btn.disabled = true; btn.textContent = t.enviando; btn.setAttribute('aria-busy', 'true');
  let r;
  try { r = await api(`/avisos/destinos/${x.id}/teste`, 'POST', {}); } finally {
    // o foco volta ao botão: enquanto travado (disabled) ele saiu do foco e o teclado recomeçaria do topo
    if (btn.isConnected) { btn.disabled = false; btn.textContent = t.enviarTeste; btn.removeAttribute('aria-busy'); btn.focus(); }
  }
  const partes = [t.testeEnviado(x.nome)];
  if (!r.ativo) partes.push(t.testeDesligado);
  if (!r.recebe_erro) partes.push(t.testeSemErro);
  else if (r.ativo) partes.push(t.testeRecebe); // desligado não recebe nada: "recebe" enganaria
  const texto = partes.join(' ');
  const estado = $('#rel-estado'); if (estado) estado.textContent = texto; // fica na tela depois que o aviso some
  aviso(texto);
}

function ligarConfigAvisos(d) {
  const t = TEXTOS_RELATORIOS; const f = $('#rel-cfg'); const campo = (n) => $(`[name=${n}]`, f);
  f.onsubmit = tentar(async (ev) => {
    ev.preventDefault();
    const corpo = { resumo_horario: campo('resumo_horario').value, virada_dia: campo('virada_dia').value, limite_padrao: campo('limite_padrao').value };
    const erros = []; const n = Number(corpo.limite_padrao);
    if (!/^\d{2}:\d{2}$/.test(corpo.resumo_horario)) erros.push({ msg: t.faltaHorario, el: campo('resumo_horario') });
    if (!/^\d{2}:\d{2}$/.test(corpo.virada_dia)) erros.push({ msg: t.faltaVirada, el: campo('virada_dia') });
    if (corpo.limite_padrao === '' || !Number.isInteger(n) || n < 2 || n > 1024) erros.push({ msg: t.faltaLimite, el: campo('limite_padrao') });
    if (relErros(f, erros)) return;
    const btn = $('#rel-cfg-salvar'); btn.disabled = true; btn.textContent = t.salvando;
    try { d.config = await api('/avisos/config', 'PUT', corpo); } catch (e) { relErros(f, [{ msg: e.message }]); return; } finally {
      btn.disabled = false; btn.textContent = t.salvarConfig;
    }
    $('#rel-cfg-estado').textContent = t.configSalvaAs(relHora()); aviso(t.configSalva);
    atualizarEstado().catch(() => {}); // o limite padrão do formulário de link vem de /api/state
    previaRelatorios($('#rel-ver')?.value ?? (d.destinos.find((x) => x.resumo_blocos != null)?.id || '')); // a virada muda o "hoje"
  });
}
/** mostrarErros de app.js, com a caixa logo acima do rodapé do card. */
function relErros(form, erros) {
  const tem = mostrarErros(form, erros);
  const box = $('.erros', form); const rod = $('.rodape-card', form);
  if (box && rod && box.nextElementSibling !== rod) form.insertBefore(box, rod);
  return tem;
}

function formDestinoAviso(d, x) {
  const t = TEXTOS_RELATORIOS; const novo = !x; const dlg = $('#dlg'); const dono = podeEquipe();
  x = x || { nome: '', numero: '', resumo_blocos: [], avisos: ['lotacao', 'erro'], ativo: true };
  // Operador: o número fica travado e "Erro de disparo" marcado não pode ser desmarcado (o servidor recusaria)
  const travaErro = (a) => !dono && a === 'erro' && x.avisos.includes('erro');
  const travaAtivo = !novo && ativoTravado(x); // e o número ligado com "Erro de disparo" não se desliga
  const recebe = x.resumo_blocos != null; const marcados = new Set(recebe ? x.resumo_blocos : []);
  const alcance = recebe && x.resumo_blocos.length ? 'blocos' : 'todos';
  const radio = (v, rot) => `<label class="linha"><input type="radio" name="alcance" value="${v}" ${alcance === v ? 'checked' : ''} style="width:auto">${rot}</label>`;
  dlg.innerHTML = `<form method="dialog" id="f" novalidate><h1>${novo ? t.novoTitulo : t.editarTitulo}</h1>
    <p class="dica" style="margin:-8px 0 0">${t.privacidade}</p>
    <div class="grade" style="align-items:start">
      <label class="campo"><span>${t.nome} ${REQ}</span><input name="nome" maxlength="60" value="${esc(x.nome)}" placeholder="${t.nomePh}" autocomplete="off" required></label>
      <label class="campo"><span>${t.numero} ${novo ? REQ : ''}</span><input name="numero" type="tel" inputmode="tel" autocomplete="off" placeholder="${novo ? t.numeroPh : esc(x.numero)}" aria-describedby="f-num-d" ${novo ? 'required' : ''}${!novo && !dono ? ' disabled' : ''}>
        <small id="f-num-d">${novo ? t.numeroDica : esc(dono ? t.numeroManter(x.numero) : t.numeroSoDono(x.numero))}</small></label>
    </div>
    <fieldset><legend>${t.resumoLegenda}</legend>
      <label class="linha"><input type="checkbox" name="recebe" ${recebe ? 'checked' : ''} style="width:auto">${t.recebe}</label>
      <div id="f-alcance" style="display:grid;gap:8px;padding-left:4px">
        ${radio('todos', t.todosGrupos)}
        ${d.blocos.length ? `${radio('blocos', t.soBlocos)}
          <div class="grupos" id="f-blocos" role="group" aria-label="${t.soBlocos}" style="max-height:180px">${d.blocos.map((b) => `<label><input type="checkbox" name="bloco" value="${b.id}" ${marcados.has(b.id) ? 'checked' : ''}>${esc(b.nome)}</label>`).join('')}</div>`
    : `<small class="dica">${t.semBlocos}</small>`}
      </div></fieldset>
    <fieldset><legend>${t.avisosLegenda} ${q('relatorios.avisos')}</legend>
      ${Object.keys(t.avisos).map((a) => `<label class="linha" style="align-items:flex-start;flex-wrap:nowrap"><input type="checkbox" name="aviso" value="${a}" ${x.avisos.includes(a) ? 'checked' : ''}${travaErro(a) ? ' disabled' : ''} style="width:auto;margin-top:3px" aria-describedby="f-av-${a}">
        <span>${t.avisos[a]}<small class="dica" id="f-av-${a}" style="display:block">${t.dicaAviso[a]}${travaErro(a) ? ` ${t.erroSoDono}` : ''}</small></span></label>`).join('')}
    </fieldset>
    <label class="linha" style="align-items:flex-start;flex-wrap:nowrap"><input type="checkbox" name="ativo" ${x.ativo ? 'checked' : ''}${travaAtivo ? ' disabled' : ''} style="width:auto;margin-top:3px" aria-describedby="f-ativo-d">
      <span>${t.ativo}<small class="dica" id="f-ativo-d" style="display:block">${t.ativoDica}${travaAtivo ? ` ${t.ativoSoDono}` : ''}</small></span></label>
    <div class="rodape"><button type="button" id="cancelar">${t.cancelar}</button><button class="pri" id="f-salvar">${t.salvar}</button></div></form>`;
  const f = $('#f', dlg); const campo = (n) => $(`[name=${n}]`, f);
  // sem resumo, a escolha dos blocos fica travada; marcar um bloco escolhe "Só os blocos marcados"
  const ajusta = () => { $$('#f-alcance input', f).forEach((i) => (i.disabled = !campo('recebe').checked)); };
  campo('recebe').onchange = ajusta; ajusta();
  $$('input[name=bloco]', f).forEach((i) => (i.onchange = () => { if (i.checked) $('input[name=alcance][value=blocos]', f).checked = true; }));
  $('#cancelar', f).onclick = () => dlg.close();
  f.onsubmit = tentar(async (ev) => {
    ev.preventDefault();
    const nome = campo('nome').value.trim(); const numero = campo('numero').value.trim(); const erros = [];
    const digitos = numero.replace(/\D/g, '').replace(/^0+/, '');
    if (!nome) erros.push({ msg: t.faltaNome, el: campo('nome') });
    if ((novo || numero) && !(digitos.length >= 10 && digitos.length <= 15)) erros.push({ msg: t.faltaNumero, el: campo('numero') });
    const comResumo = campo('recebe').checked; const escolha = $('input[name=alcance]:checked', f)?.value || 'todos';
    const blocos = $$('input[name=bloco]:checked', f).map((i) => Number(i.value));
    if (comResumo && escolha === 'blocos' && !blocos.length) erros.push({ msg: t.faltaBloco, el: $('#f-blocos', f) });
    if (mostrarErros(f, erros)) return;
    const corpo = {
      nome, resumo_blocos: !comResumo ? null : escolha === 'blocos' ? blocos : [],
      avisos: $$('input[name=aviso]:checked', f).map((i) => i.value), ativo: campo('ativo').checked,
    };
    if (numero) corpo.numero = numero; // na edição, vazio mantém o número salvo
    const btn = $('#f-salvar', f); btn.disabled = true; btn.textContent = t.salvando;
    try { await api(novo ? '/avisos/destinos' : `/avisos/destinos/${x.id}`, novo ? 'POST' : 'PUT', corpo); } catch (e) {
      btn.disabled = false; btn.textContent = t.salvar; mostrarErros(f, [{ msg: e.message }]); return;
    }
    dlg.close(); aviso(t.salvo); paginaRelatorios();
  });
  dlg.showModal(); campo('nome').focus();
}
