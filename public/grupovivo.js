// Grupo vivo (#grupo-vivo): rotinas recorrentes de mensagem ou enquete, com até 5 conteúdos em rodízio ou sorteio, para
// os grupos marcados, nos dias da semana e em até 6 horários. Plano: docs/produto/planos/grade-de-disparos.md (etapa 8,
// D6 e D8). Spec: docs/produto/specs/grade-de-disparos.md, "Layout: Grupo vivo", "Formulário" e "Galeria".
// Rotas (src/rotinas.js): GET/POST /api/rotinas, PUT/DELETE /api/rotinas/:id, POST /api/rotinas/:id/enabled e
// POST /api/rotinas/:id/enviar. O erro vem em {erro}, já em frase de tela. Operador pode tudo, como no Disparo automático.
// Carrega depois de grade.js e antes de app.js: só define nomes (prefixo gv/GV). Usa de app.js ($, $$, esc, zap, S, api,
// aviso, tentar, REQ, mostrarErros, seletorGrupos), de disparos.js (dispSegHtml, dispLigarSeg, dispLista, DISP_DIAS), de
// grade.js (gradeDiasTexto, gradeQuando, gradeMensagensDia, AVISO_MENSAGENS_DIA) e de ajuda.js (q) só quando a tela abre.
// Todo texto do dono (nome da rotina, textos, pergunta, opções, nome de grupo) passa por esc() ou zap().
// Sem foto na 1ª versão (P9): o upload some 7 dias depois de ficar sem envio ativo.

const TEXTOS_GRUPO_VIVO = {
  titulo: 'Grupo vivo',
  sub: 'Mensagens e enquetes que mostram que o grupo tem gente por trás. Escolha um modelo, ajuste o texto e marque os horários.',
  novaMensagem: 'Nova mensagem', novaEnquete: 'Nova enquete', modelos: 'Modelos', editarTitulo: 'Editar rotina',
  carregando: 'Carregando…', naoCarregou: (msg) => `Não consegui carregar as rotinas: ${msg}`, tentarDeNovo: 'Tentar de novo',
  // cartão
  mensagem: 'Mensagem', enquete: 'Enquete',
  ligarTitulo: 'Ligar ou pausar', ativoAria: (nome) => `Rotina ativa: ${nome}`,
  para: (n) => `Para ${n} ${n === 1 ? 'grupo' : 'grupos'}.`,
  rodizio: (n, tipo, ordem) => `${n} ${tipo === 'enquete' ? 'enquetes' : 'textos'} em ${ordem === 'sorteio' ? 'sorteio' : 'rodízio'}.`,
  pausado: 'Pausado', emInstantes: 'Enviando em instantes', semProximo: 'Sem próximo horário. Confira os dias e os horários.',
  proximo: (quando) => `Próximo envio ${quando}`,
  ultimas: (ok, erro) => `Últimas 24 h: ${ok ? `${ok} ${ok === 1 ? 'enviada' : 'enviadas'}` : 'nenhuma enviada'}${erro ? `, ${erro} com erro` : ''}.`,
  erroGrupo: (nome) => `Não foi para o grupo ${nome}.`, verHistorico: 'Veja o Histórico',
  enviarAgora: 'Enviar agora', editar: 'Editar', copiar: 'Copiar', excluir: 'Excluir',
  enviarAria: (nome) => `Enviar agora a rotina ${nome}`, editarAria: (nome) => `Editar a rotina ${nome}`,
  copiarAria: (nome) => `Copiar a rotina ${nome}`, excluirAria: (nome) => `Excluir a rotina ${nome}`,
  confirmaEnviar: (n) => `Enviar agora para ${n} ${n === 1 ? 'grupo' : 'grupos'}?`,
  confirmaExcluir: (nome) => `Excluir a rotina “${nome}”? O que já foi enviado continua no Histórico.`,
  enviando: (n) => `Enviando para ${n} ${n === 1 ? 'grupo' : 'grupos'}.`,
  ligada: 'Rotina ligada', pausada: 'Rotina pausada', excluida: 'Rotina excluída', criada: 'Rotina criada', salva: 'Rotina salva',
  copia: ' (cópia)',
  // galeria
  galeriaSub: 'Escolha um modelo para começar. Nada é salvo até você criar a rotina, e dá para mudar tudo.',
  galeriaVazia: 'Nenhuma rotina ainda. Comece por um modelo:',
  usar: 'Usar este modelo', usarAria: (titulo) => `Usar o modelo ${titulo}`, doZero: 'Criar do zero', fechar: 'Fechar',
  sugestao: (quando) => `Sugestão: ${quando}.`,
  // formulário
  nome: 'Nome', nomeDica: 'Só você vê. Ex.: Bom dia de segunda a sexta.', tipo: 'Tipo',
  textos: 'Textos', enquetes: 'Enquetes', rotulo: (tipo, i, n) => `${tipo === 'enquete' ? 'Enquete' : 'Texto'}${n > 1 ? ` ${i + 1}` : ''}`,
  addTexto: '+ Adicionar outro texto', addEnquete: '+ Adicionar outra enquete', remover: 'Remover', removerAria: (rotulo) => `Remover ${rotulo.toLowerCase()}`,
  contador: (n, max) => `${n} de ${max}`,
  formatoDica: 'Use *negrito*, _itálico_ e ~riscado~ como no WhatsApp.',
  pergunta: 'Pergunta', opcoes: 'Opções', addOpcao: '+ Adicionar opção', multipla: 'Permitir mais de uma resposta',
  opcaoAria: (rotulo, j) => `${rotulo}, opção ${j}`, removerOpcaoAria: (rotulo, j) => `Remover a opção ${j} de ${rotulo.toLowerCase()}`,
  ordem: 'Ordem', ordens: [['rodizio', 'Um depois do outro'], ['sorteio', 'Sorteio']],
  ordemDica: 'Cada envio usa um texto. Assim o grupo não vê sempre a mesma mensagem.',
  previa: 'Como vai aparecer', previaDe: (rotulo) => `Como vai aparecer (${rotulo.toLowerCase()})`, previaVazia: 'A prévia aparece aqui.',
  grupos: 'Grupos que vão receber', blocoDica: 'O bloco só ajuda a marcar: a rotina guarda os grupos marcados agora.',
  quando: 'Quando', dias: 'Dias da semana', horarios: 'Horários', novoHorario: 'Novo horário', addHorario: '+ Adicionar horário',
  semHorario: 'Nenhum horário ainda.', removerHorarioAria: (h) => `Remover horário ${h}`, horarioInvalido: 'Escolha o horário antes de adicionar.',
  pausas: 'As pausas entre mensagens são as de', ajustes: 'Ajustes',
  ligarAgora: 'Ligar agora', ligarDica: 'Desligada, a rotina fica salva, mas não envia nada.',
  semGrupos: 'Conecte o WhatsApp em Números de WhatsApp para escolher os grupos.',
  cancelar: 'Cancelar', criar: 'Criar rotina', salvar: 'Salvar', salvando: 'Salvando…',
  aviso: (total, limite) => `Com os disparos e as rotinas ligados, este número enviaria cerca de ${total.toLocaleString('pt-BR')} mensagens por dia. `
    + `Acima de ${limite} aumenta o risco de bloqueio do WhatsApp. Para baixar: menos horários ou menos grupos.`,
  // erros: as mesmas frases do servidor (MSG de src/rotinas.js, validarTextoMensagem e validarEnquete de src/envios.js,
  // montarEnquete de src/whatsapp.js); com mais de um conteúdo, a posição vai na frente ("Texto 2: …"), como lá
  erroNome: 'Dê um nome à rotina.', erroNomeLongo: (max) => `O nome pode ter até ${max} letras.`,
  erroTexto: 'Escreva a mensagem.', erroTextoLongo: (max) => `A mensagem passa de ${max} caracteres.`,
  erroPergunta: 'A enquete precisa de uma pergunta.', erroOpcoes: 'A enquete precisa de 2 a 12 opções.', erroRepetidas: 'A enquete tem opções repetidas.',
  erroPerguntaLonga: (max) => `A pergunta passa de ${max} caracteres.`, erroOpcaoLonga: (max) => `Cada opção pode ter até ${max} caracteres.`,
  erroMuitos: (max, tipo) => `Uma rotina tem no máximo ${max} ${tipo === 'enquete' ? 'enquetes' : 'textos'}.`,
  erroGrupos: 'Marque ao menos um grupo.', erroDia: 'Marque ao menos um dia.', erroHorario: 'Adicione ao menos um horário.',
  erroMuitosHorarios: (max) => `Uma rotina aceita no máximo ${max} horários.`,
};

// Limites de src/rotinas.js (valem os de /api/state.grade quando o servidor manda) e de src/envios.js.
const GV_LIMITES_PADRAO = { max_conteudos: 5, max_horarios_rotina: 6 };
const GV_MAX_NOME = 60;
const GV_MAX_TEXTO = 4096;
const GV_MAX_PERGUNTA = 255;
const GV_MAX_OPCAO = 100;
const GV_MAX_OPCOES = 12;
const GV_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const GV_TODOS_DIAS = [0, 1, 2, 3, 4, 5, 6];

// Modelos da galeria (spec, "Galeria"): sem emoji e sem número inventado. Só preenchem o formulário; o texto é editável.
const MODELOS_GRUPO_VIVO = [
  { id: 'bom-dia', titulo: 'Bom dia', tipo: 'mensagem', repetir: { dias: GV_TODOS_DIAS, horarios: ['08:00'] }, conteudos: [
    'Bom dia, pessoal! Hoje tem achadinho novo saindo ao longo do dia. Fiquem de olho aqui no grupo.',
    'Bom dia! Café na mão e olho nas ofertas. Daqui a pouco começam os achadinhos de hoje.',
    'Bom dia, gente! Quem já separou o que quer garantir hoje? As ofertas começam a sair por aqui.',
  ] },
  { id: 'regras', titulo: 'Regras do grupo', tipo: 'mensagem', repetir: { dias: [0], horarios: ['10:00'] }, conteudos: [
    'Regras do grupo, para todo mundo aproveitar: 1) Aqui só ofertas e dúvidas sobre elas. 2) Sem spam e sem links de outros sites. 3) Preço e estoque mudam rápido: confira na página da loja antes de comprar. 4) Dúvida? Pergunte aqui que a gente ajuda.',
  ] },
  { id: 'seguranca', titulo: 'Aviso de segurança', tipo: 'mensagem', repetir: { dias: [3], horarios: ['12:00'] }, conteudos: [
    'Dica de segurança: compre só pelos links que chegam aqui, que levam direto para a página da loja. Ninguém do grupo vai pedir senha, código ou dados por mensagem privada. Se alguém pedir, desconfie.',
  ] },
  { id: 'prova-social', titulo: 'Prova social (convite)', tipo: 'mensagem', repetir: { dias: [6], horarios: ['11:00'] }, conteudos: [
    'Já comprou alguma oferta daqui e gostou? Conta pra gente! Seu relato ajuda o pessoal a escolher melhor.',
  ] },
  { id: 'preco-muda', titulo: 'Preço muda', tipo: 'mensagem', repetir: { dias: [1, 2, 3, 4, 5], horarios: ['14:00'] }, conteudos: [
    'Lembrete: o preço e o estoque podem mudar a qualquer momento. O valor que vale é o que aparece na página da loja na hora da compra.',
  ] },
  { id: 'boa-noite', titulo: 'Boa noite', tipo: 'mensagem', repetir: { dias: GV_TODOS_DIAS, horarios: ['21:30'] }, conteudos: [
    'Por hoje é só, pessoal! Amanhã tem mais achadinhos. Boa noite e boas compras.',
  ] },
  { id: 'ver-mais', titulo: 'Enquete: o que ver mais', tipo: 'enquete', repetir: { dias: [5], horarios: ['12:00'] }, conteudos: [
    { pergunta: 'O que você quer ver mais por aqui?', opcoes: ['Casa e cozinha', 'Eletrônicos', 'Moda', 'Beleza', 'Ferramentas'], multipla: true },
  ] },
  { id: 'ja-comprou', titulo: 'Enquete: já comprou', tipo: 'enquete', repetir: { dias: [1], horarios: ['19:00'] }, conteudos: [
    { pergunta: 'Você já comprou alguma oferta do grupo?', opcoes: ['Sim, e gostei', 'Ainda não', 'Comprei mais de uma vez'], multipla: false },
  ] },
  { id: 'melhor-horario', titulo: 'Enquete: melhor horário', tipo: 'enquete', repetir: { dias: [4], horarios: ['12:00'] }, conteudos: [
    { pergunta: 'Em que horário você mais olha o grupo?', opcoes: ['Manhã', 'Tarde', 'Noite'], multipla: false },
  ] },
  { id: 'sextou', titulo: 'Enquete: sextou', tipo: 'enquete', repetir: { dias: [5], horarios: ['18:00'] }, conteudos: [
    { pergunta: 'Sextou! O que vai pro carrinho neste fim de semana?', opcoes: ['Algo para casa', 'Eletrônico', 'Presente', 'Só olhando'], multipla: false },
  ] },
];

// Estado da tela: a lista que veio do servidor, o erro da última carga, o contador que descarta resposta velha e o
// botão que abriu o diálogo (o foco volta para ele quando o diálogo fecha).
const GV = { lista: [], erro: '', seq: 0, origem: null };

/** Limites do formulário: os de /api/state.grade, com os de src/rotinas.js como reserva. */
function gvLimites() {
  const s = S.st?.grade || {}; const L = { ...GV_LIMITES_PADRAO };
  for (const k of Object.keys(L)) if (Number.isInteger(s[k]) && s[k] > 0) L[k] = s[k];
  return L;
}
/** { dias, horarios } → "Seg a sex às 08:00 e 18:00" (sem ponto final). */
function gvQuandoTexto(rep) {
  const dias = gradeDiasTexto(Array.isArray(rep?.dias) ? rep.dias : []);
  const hs = (Array.isArray(rep?.horarios) ? rep.horarios : []).filter((h) => typeof h === 'string').sort();
  const txt = [dias, hs.length ? `às ${dispLista(hs)}` : ''].filter(Boolean).join(' ');
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}
/** Texto da próxima ocorrência para o cartão (".prox"). */
function gvProximo(r) {
  const T = TEXTOS_GRUPO_VIVO;
  if (!r.enabled) return T.pausado;
  if (!Number.isFinite(r.next_run_at)) return T.semProximo;
  return r.next_run_at <= Date.now() ? T.emInstantes : T.proximo(gradeQuando(r.next_run_at));
}

// ---------- cartão ----------
/** Cartão de uma rotina (string HTML, com esc() em todo texto do dono). */
function cartaoRotinaViva(r) {
  const T = TEXTOS_GRUPO_VIVO; const nome = String(r.nome ?? '');
  const n = Array.isArray(r.conteudos) ? r.conteudos.length : 0; const grupos = Array.isArray(r.group_jids) ? r.group_jids.length : 0;
  const quando = gvQuandoTexto(r.repetir);
  const res = [quando ? `${quando}.` : '', T.para(grupos), n > 1 ? T.rodizio(n, r.tipo, r.ordem) : ''].filter(Boolean).join(' ');
  const erro = r.ultimo_erro_grupo ? `<p class="nivel-erro gv-erro"><b>!</b> ${esc(T.erroGrupo(r.ultimo_erro_grupo))} <a href="#historico">${T.verHistorico}</a>.</p>` : '';
  return `<article class="card regra" data-gv-id="${Number(r.id)}">
    <h2><label class="chave" title="${T.ligarTitulo}"><input type="checkbox" data-act="gv-ligar"${r.enabled ? ' checked' : ''} aria-label="${esc(T.ativoAria(nome))}"><span></span></label>
      ${esc(nome)} <span class="chip">${r.tipo === 'enquete' ? T.enquete : T.mensagem}</span></h2>
    <p class="res">${esc(res)}</p>${erro}
    <div class="prox">${esc(gvProximo(r))}</div>
    <p class="dica gv-24h">${esc(T.ultimas(Number(r.enviadas_24h) || 0, Number(r.erros_24h) || 0))}</p>
    <div class="acoes">
      <button type="button" class="pri" data-act="gv-enviar" aria-label="${esc(T.enviarAria(nome))}">${T.enviarAgora}</button>
      <button type="button" data-act="gv-editar" aria-label="${esc(T.editarAria(nome))}">${T.editar}</button>
      <button type="button" data-act="gv-copiar" aria-label="${esc(T.copiarAria(nome))}">${T.copiar}</button>
      <button type="button" class="perigo leve" data-act="gv-excluir" aria-label="${esc(T.excluirAria(nome))}">${T.excluir}</button></div></article>`;
}

// ---------- galeria ----------
/** Os modelos em cartões compactos ("Usar este modelo" só abre o formulário preenchido) e "Criar do zero". */
function gvGaleriaHtml({ vazia = false } = {}) {
  const T = TEXTOS_GRUPO_VIVO;
  const amostra = (m) => (m.tipo === 'enquete' ? `${m.conteudos[0].pergunta} ${m.conteudos[0].opcoes.join(' / ')}` : m.conteudos[0]);
  return `<div class="gv-galeria">${vazia ? `<p class="dica">${T.galeriaVazia}</p>` : ''}
    <ul class="gv-modelos">${MODELOS_GRUPO_VIVO.map((m) => `<li class="gv-modelo">
      <div class="gv-modelo-topo"><h3>${esc(m.titulo)}</h3><span class="chip">${m.tipo === 'enquete' ? T.enquete : T.mensagem}</span></div>
      <p class="gv-modelo-txt">${esc(amostra(m))}</p>
      <p class="dica">${esc(T.sugestao(gvQuandoTexto(m.repetir).toLowerCase()))}</p>
      <button type="button" data-modelo="${esc(m.id)}" aria-label="${esc(T.usarAria(m.titulo))}">${T.usar}</button></li>`).join('')}</ul>
    <div class="linha"><button type="button" data-gv-zero>${T.doZero}</button></div></div>`;
}
/** Abre o diálogo (se ainda não estiver aberto) guardando quem o abriu, para devolver o foco ao fechar. */
function gvMostrarDlg() {
  const dlg = $('#dlg'); if (dlg.open) return;
  GV.origem = document.activeElement;
  dlg.addEventListener('close', gvDevolverFoco); // a mesma função não é registrada duas vezes
  dlg.showModal();
}
function gvDevolverFoco() {
  const o = GV.origem; GV.origem = null;
  if (o && o.isConnected && o !== document.body) o.focus?.();
}
/** Galeria "Modelos" no diálogo. Nada é salvo aqui. */
function galeriaModelos() {
  const T = TEXTOS_GRUPO_VIVO; const dlg = $('#dlg');
  dlg.innerHTML = `<div class="corpo"><h1>${T.modelos} ${q('grupovivo')}</h1><p class="dica" style="margin:-8px 0 0">${T.galeriaSub}</p>
    ${gvGaleriaHtml()}<div class="rodape"><button type="button" id="gv-gal-fechar">${T.fechar}</button></div></div>`;
  $('#gv-gal-fechar', dlg).onclick = () => dlg.close();
  $('.corpo', dlg).onclick = (ev) => {
    const b = ev.target.closest('[data-modelo], [data-gv-zero]'); if (!b) return;
    if (b.hasAttribute('data-gv-zero')) formRotinaViva(null, { tipo: 'mensagem' }); else gvUsarModelo(b.dataset.modelo);
  };
  gvMostrarDlg();
  $('button[data-modelo]', dlg)?.focus();
}
/** Formulário de rotina nova já preenchido com o modelo (cópia: editar o formulário não muda o modelo). */
function gvUsarModelo(id) {
  const m = MODELOS_GRUPO_VIVO.find((x) => x.id === id); if (!m) return;
  formRotinaViva({ nome: m.titulo, tipo: m.tipo, conteudos: JSON.parse(JSON.stringify(m.conteudos)), ordem: 'rodizio', group_jids: [],
    repetir: { dias: [...m.repetir.dias], horarios: [...m.repetir.horarios] }, enabled: true });
}

// ---------- página ----------
function paginaGrupoVivo() {
  const T = TEXTOS_GRUPO_VIVO;
  $('#pagina').innerHTML = `<div class="topo"><div><h1>${T.titulo} ${q('grupovivo')}</h1><p class="sub">${T.sub}</p></div>
    <div class="linha"><button type="button" class="pri" id="gv-nova-msg">${T.novaMensagem}</button><button type="button" id="gv-nova-enq">${T.novaEnquete}</button><button type="button" id="gv-modelos">${T.modelos}</button></div></div>
    <div id="gv-lista" aria-busy="true"><p class="dica">${T.carregando}</p></div>`;
  $('#gv-nova-msg').onclick = () => formRotinaViva(null, { tipo: 'mensagem' });
  $('#gv-nova-enq').onclick = () => formRotinaViva(null, { tipo: 'enquete' });
  $('#gv-modelos').onclick = () => galeriaModelos();
  $('#gv-lista').onclick = tentar(gvAcao);
  GV.lista = []; GV.erro = '';
  return gvCarregar();
}
/** Busca as rotinas e repinta a lista; resposta de uma carga mais antiga é descartada. */
async function gvCarregar() {
  const n = ++GV.seq;
  try {
    const x = await api('/rotinas'); if (n !== GV.seq) return;
    GV.lista = Array.isArray(x) ? x : []; GV.erro = '';
  } catch (e) { if (n !== GV.seq) return; GV.erro = e.message; }
  gvPintarLista();
}
function gvPintarLista() {
  const T = TEXTOS_GRUPO_VIVO; const el = $('#gv-lista'); if (!el) return;
  el.removeAttribute('aria-busy');
  el.innerHTML = GV.erro
    ? `<p class="dica" role="status">${esc(T.naoCarregou(GV.erro))}</p><button type="button" data-gv-recarregar>${T.tentarDeNovo}</button>`
    : GV.lista.length ? GV.lista.map(cartaoRotinaViva).join('') : gvGaleriaHtml({ vazia: true }); // vazio: a galeria no lugar
}
/** Cliques da lista (cartões, galeria do estado vazio e "Tentar de novo"). Erro de rota vira toast (tentar). */
async function gvAcao(ev) {
  const T = TEXTOS_GRUPO_VIVO;
  const b = ev.target.closest('[data-act], [data-modelo], [data-gv-zero], [data-gv-recarregar]'); if (!b) return;
  if (b.hasAttribute('data-gv-recarregar')) return gvCarregar();
  if (b.hasAttribute('data-modelo')) return gvUsarModelo(b.dataset.modelo);
  if (b.hasAttribute('data-gv-zero')) return formRotinaViva(null, { tipo: 'mensagem' });
  const id = Number(b.closest('[data-gv-id]')?.dataset.gvId); const r = GV.lista.find((x) => x.id === id); if (!r) return;
  const act = b.dataset.act;
  if (act === 'gv-ligar') {
    try { await api(`/rotinas/${id}/enabled`, 'POST', { enabled: b.checked }); } catch (e) { b.checked = !b.checked; throw e; }
    aviso(b.checked ? T.ligada : T.pausada); await gvCarregar();
  }
  if (act === 'gv-enviar') {
    const n = Array.isArray(r.group_jids) ? r.group_jids.length : 0;
    if (!confirm(T.confirmaEnviar(n))) return;
    const x = await api(`/rotinas/${id}/enviar`, 'POST');
    aviso(T.enviando(Number(x?.grupos) || n)); await gvCarregar();
  }
  if (act === 'gv-editar') formRotinaViva(r);
  if (act === 'gv-copiar') formRotinaViva({ ...r, id: null, enabled: true, nome: String(r.nome ?? '').slice(0, GV_MAX_NOME - T.copia.length) + T.copia });
  if (act === 'gv-excluir') {
    if (!confirm(T.confirmaExcluir(r.nome))) return;
    await api(`/rotinas/${id}`, 'DELETE'); aviso(T.excluida); await gvCarregar();
  }
}

// ---------- formulário "Nova mensagem" / "Nova enquete" / "Editar rotina" ----------
const gvEnqueteVazia = () => ({ pergunta: '', opcoes: ['', ''], multipla: false });
/** Enquete salva → estado editável (sempre ao menos 2 campos de opção). */
function gvEnqueteDe(c) {
  const opcoes = Array.isArray(c?.opcoes) ? c.opcoes.map((o) => String(o ?? '')) : [];
  while (opcoes.length < 2) opcoes.push('');
  return { pergunta: String(c?.pergunta ?? ''), opcoes: opcoes.slice(0, GV_MAX_OPCOES), multipla: c?.multipla === true };
}

/**
 * Formulário da rotina no #dlg. `r` com `id`: editar (PUT, sem tipo nem enabled; o tipo não muda); sem `id`: rotina nova
 * (POST), vazia (`tipo` escolhe Mensagem ou Enquete) ou já preenchida (modelo da galeria, "Copiar").
 */
function formRotinaViva(r, { tipo = 'mensagem' } = {}) {
  const T = TEXTOS_GRUPO_VIVO; const L = gvLimites(); const dlg = $('#dlg');
  const nova = !r?.id;
  const base = r || { nome: '', tipo, conteudos: [], ordem: 'rodizio', group_jids: [], repetir: { dias: [], horarios: [] }, enabled: true };
  const ehEnq = base.tipo === 'enquete'; const conteudos = Array.isArray(base.conteudos) ? base.conteudos : [];
  const st = {
    tipo: ehEnq ? 'enquete' : 'mensagem',
    textos: !ehEnq && conteudos.length ? conteudos.map((c) => String(c ?? '')) : [''],
    enquetes: ehEnq && conteudos.length ? conteudos.map(gvEnqueteDe) : [gvEnqueteVazia()],
    ordem: base.ordem === 'sorteio' ? 'sorteio' : 'rodizio',
    dias: new Set((base.repetir?.dias || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)),
    horarios: [...new Set((base.repetir?.horarios || []).filter((h) => GV_HHMM.test(String(h))))].sort(),
    ativo: 0, // o conteúdo da prévia: o último que o dono mexeu
  };
  const grupos = seletorGrupos({ selecionados: base.group_jids || [], blocos: true, prefixo: 'gv-' });
  const semGrupos = !S.groups.length;
  const titulo = () => (nova ? (st.tipo === 'enquete' ? T.novaEnquete : T.novaMensagem) : T.editarTitulo);
  dlg.innerHTML = `<form method="dialog" id="gv-f" novalidate aria-labelledby="gv-h1"><h1 id="gv-h1"><span id="gv-h1-t">${titulo()}</span> ${q('grupovivo')}</h1>
    <label class="campo"><span>${T.nome} ${REQ}</span><input name="nome" value="${esc(base.nome)}" maxlength="${GV_MAX_NOME}" autocomplete="off" required aria-describedby="gv-nome-d"><small id="gv-nome-d">${T.nomeDica}</small></label>
    ${nova ? `<div class="gh-bloco"><span id="gv-tipo-h" class="gh-tit">${T.tipo}</span>${dispSegHtml('gv-tipo', [['mensagem', T.mensagem], ['enquete', T.enquete]], st.tipo, 'gv-tipo-h')}</div>`
    : `<p class="gh-bloco gv-tipo-fixo" id="gv-tipo-fixo"><span class="gh-tit">${T.tipo}</span><span><span class="chip">${st.tipo === 'enquete' ? T.enquete : T.mensagem}</span></span></p>`}
    <fieldset><legend><span id="gv-cont-t"></span> ${REQ} <span class="contador" id="gv-cont-n" aria-live="polite"></span></legend>
      <ol class="gv-itens" id="gv-conteudos" aria-labelledby="gv-cont-t"></ol><small class="dica" id="gv-fmt-d">${T.formatoDica}</small>
      <div class="linha"><button type="button" id="gv-add" aria-describedby="gv-cont-n"></button></div>
      <div class="gh-bloco" id="gv-ordem-box" hidden><span id="gv-ordem-h" class="gh-tit">${T.ordem} ${q('grupovivo.rodizio')}</span>
        ${dispSegHtml('gv-ordem', T.ordens, st.ordem, 'gv-ordem-h')}<small class="dica">${T.ordemDica}</small></div>
      <div class="previa"><span class="gh-tit" id="gv-pv-h">${T.previa}</span>
        <div class="chat" style="min-height:0"><div class="balao" id="gv-pv" aria-labelledby="gv-pv-h"></div></div></div>
    </fieldset>
    <fieldset><legend>${T.grupos} ${REQ} <span class="contagem" id="gv-gcont" aria-live="polite"></span></legend>${grupos.html}
      ${S.blocks?.length && !semGrupos ? `<small class="dica">${T.blocoDica}</small>` : ''}</fieldset>
    <fieldset><legend>${T.quando}</legend>
      <div class="gh-bloco"><span id="gv-dias-h" class="gh-tit">${T.dias} ${REQ}</span>
        <div class="dias" id="gv-dias" role="group" aria-labelledby="gv-dias-h">${DISP_DIAS.map((d) => `<button type="button" data-d="${d.d}" aria-pressed="${st.dias.has(d.d)}" aria-label="${d.nome}" title="${d.nome}">${d.letra}</button>`).join('')}</div></div>
      <div class="gh-bloco"><span id="gv-hor-h" class="gh-tit">${T.horarios} ${REQ}</span>
        <div class="horarios" id="gv-horarios" role="group" aria-labelledby="gv-hor-h"></div>
        <div class="linha"><input type="time" id="gv-hor-novo" aria-label="${T.novoHorario}" style="width:auto"><button type="button" id="gv-hor-add" aria-describedby="gv-hor-cont">${T.addHorario}</button><span class="contador" id="gv-hor-cont" aria-live="polite"></span></div></div>
      <p class="nivel-aviso gh-aviso" id="gv-aviso" role="status" hidden></p>
      <small class="dica">${T.pausas} <a href="#ajustes" class="alvo24" style="text-decoration:underline">${T.ajustes}</a>.</small></fieldset>
    ${nova ? `<div style="display:grid;gap:4px"><label class="linha opcao-chk"><input type="checkbox" name="ligar"${base.enabled === false ? '' : ' checked'} aria-describedby="gv-ligar-d"><span>${T.ligarAgora}</span></label>
      <small class="dica" id="gv-ligar-d">${T.ligarDica}</small></div>` : ''}
    <div class="rodape"><span class="dica gv-motivo" id="gv-motivo">${semGrupos ? T.semGrupos : ''}</span><button type="button" id="gv-cancelar">${T.cancelar}</button><button class="pri" id="gv-salvar"${semGrupos ? ' disabled aria-describedby="gv-motivo"' : ''}>${nova ? T.criar : T.salvar}</button></div></form>`;

  const form = $('#gv-f', dlg); const inNome = $('[name=nome]', form);
  const ol = $('#gv-conteudos', form); const btAdd = $('#gv-add', form); const contN = $('#gv-cont-n', form);
  const boxOrdem = $('#gv-ordem-box', form); const pv = $('#gv-pv', form); const pvH = $('#gv-pv-h', form);
  const diasEl = $('#gv-dias', form); const horEl = $('#gv-horarios', form); const inHor = $('#gv-hor-novo', form);
  const btHor = $('#gv-hor-add', form); const contHor = $('#gv-hor-cont', form); const av = $('#gv-aviso', form);
  const itens = () => (st.tipo === 'enquete' ? st.enquetes : st.textos);
  const rotulo = (i) => T.rotulo(st.tipo, i, itens().length);

  // ----- conteúdos (textos ou enquetes) -----
  const removerHtml = (i, n) => (n > 1 ? `<button type="button" class="perigo leve" data-gv="remover" aria-label="${esc(T.removerAria(rotulo(i)))}">${T.remover}</button>` : '');
  const textoHtml = (c, i, n) => `<li class="gv-item" data-i="${i}"><div class="gv-item-topo"><label class="gh-tit" for="gv-t-${i}">${rotulo(i)}</label>${removerHtml(i, n)}</div>
    <textarea id="gv-t-${i}" data-campo="texto" rows="4" maxlength="${GV_MAX_TEXTO}" aria-describedby="gv-fmt-d">${esc(c)}</textarea></li>`;
  const enqueteHtml = (c, i, n) => `<li class="gv-item" data-i="${i}"><div class="gv-item-topo"><span class="gh-tit">${rotulo(i)}</span>${removerHtml(i, n)}</div>
    <label class="campo"><span>${T.pergunta} ${REQ}</span><input data-campo="pergunta" maxlength="${GV_MAX_PERGUNTA}" autocomplete="off" value="${esc(c.pergunta)}"></label>
    <div class="gh-bloco"><span class="gh-tit" id="gv-o-${i}">${T.opcoes} ${REQ} <span class="contador">${T.contador(c.opcoes.length, GV_MAX_OPCOES)}</span></span>
      <ol class="opcoes-enquete" aria-labelledby="gv-o-${i}">${c.opcoes.map((o, j) => `<li><input data-op="${j}" maxlength="${GV_MAX_OPCAO}" autocomplete="off" value="${esc(o)}" aria-label="${esc(T.opcaoAria(rotulo(i), j + 1))}">${j >= 2
        ? `<button type="button" class="perigo leve" data-gv="rm-opcao" data-op="${j}" aria-label="${esc(T.removerOpcaoAria(rotulo(i), j + 1))}">${T.remover}</button>` : ''}</li>`).join('')}</ol>
      <div><button type="button" data-gv="add-opcao"${c.opcoes.length >= GV_MAX_OPCOES ? ' disabled' : ''}>${T.addOpcao}</button></div></div>
    <label class="linha opcao-chk"><input type="checkbox" data-campo="multipla"${c.multipla ? ' checked' : ''}><span>${T.multipla}</span></label></li>`;
  /** Repinta a lista de conteúdos; `foco` = { i, sel } leva o foco a um campo do item i. */
  const pintarItens = (foco) => {
    const lista = itens(); const n = lista.length;
    ol.innerHTML = lista.map((c, i) => (st.tipo === 'enquete' ? enqueteHtml(c, i, n) : textoHtml(c, i, n))).join('');
    $('#gv-fmt-d', form).hidden = st.tipo !== 'mensagem';
    $('#gv-cont-t', form).textContent = st.tipo === 'enquete' ? T.enquetes : T.textos;
    contN.textContent = T.contador(n, L.max_conteudos); contN.classList.toggle('cheio', n >= L.max_conteudos);
    btAdd.textContent = st.tipo === 'enquete' ? T.addEnquete : T.addTexto; btAdd.disabled = n >= L.max_conteudos;
    boxOrdem.hidden = n < 2;
    if (foco) $(`li[data-i="${foco.i}"] ${foco.sel}`, ol)?.focus();
  };
  const prever = () => {
    const lista = itens(); const i = Math.min(st.ativo, lista.length - 1); const c = lista[i];
    pvH.textContent = lista.length > 1 ? T.previaDe(rotulo(i)) : T.previa;
    if (st.tipo === 'enquete') {
      const p = String(c.pergunta).trim(); const ops = c.opcoes.map((o) => String(o).trim()).filter(Boolean);
      pv.innerHTML = p || ops.length
        ? `<strong>${esc(p || T.pergunta)}</strong>${ops.map((o) => `\n○ ${esc(o)}`).join('')}${c.multipla ? `\n<small class="dica">${T.multipla}</small>` : ''}`
        : `<span class="dica">${T.previaVazia}</span>`;
    } else pv.innerHTML = String(c).trim() ? zap(c) : `<span class="dica">${T.previaVazia}</span>`;
  };
  const campoDoItem = () => (st.tipo === 'enquete' ? 'input[data-campo="pergunta"]' : 'textarea');
  ol.oninput = (e) => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    const i = Number(li.dataset.i); st.ativo = i;
    if (e.target.dataset.campo === 'texto') st.textos[i] = e.target.value;
    else if (e.target.dataset.campo === 'pergunta') st.enquetes[i].pergunta = e.target.value;
    else if (e.target.localName === 'input' && e.target.dataset.op != null) st.enquetes[i].opcoes[Number(e.target.dataset.op)] = e.target.value;
    prever();
  };
  ol.onchange = (e) => {
    const li = e.target.closest('li[data-i]'); if (!li || e.target.dataset.campo !== 'multipla') return;
    const i = Number(li.dataset.i); st.ativo = i; st.enquetes[i].multipla = !!e.target.checked; prever();
  };
  ol.onclick = (e) => {
    const b = e.target.closest('button[data-gv]'); const li = b?.closest('li[data-i]'); if (!b || !li) return;
    const i = Number(li.dataset.i); const lista = itens();
    if (b.dataset.gv === 'remover') {
      if (lista.length <= 1) return;
      lista.splice(i, 1); st.ativo = Math.max(0, i - 1);
      pintarItens({ i: st.ativo, sel: campoDoItem() });
    } else if (b.dataset.gv === 'add-opcao') {
      const ops = st.enquetes[i].opcoes; if (ops.length >= GV_MAX_OPCOES) return;
      ops.push(''); st.ativo = i; pintarItens({ i, sel: `input[data-op="${ops.length - 1}"]` });
    } else if (b.dataset.gv === 'rm-opcao') {
      const ops = st.enquetes[i].opcoes; const j = Number(b.dataset.op); if (ops.length <= 2) return;
      ops.splice(j, 1); st.ativo = i; pintarItens({ i, sel: `input[data-op="${Math.min(j, ops.length - 1)}"]` });
    }
    prever();
  };
  // Enter numa opção vai para a próxima (ou cria uma nova, se for a última), como em Disparar mensagem
  ol.onkeydown = (e) => {
    if (e.key !== 'Enter' || e.target.localName !== 'input' || e.target.dataset.op == null) return;
    e.preventDefault();
    const li = e.target.closest('li[data-i]'); const i = Number(li.dataset.i); const j = Number(e.target.dataset.op) + 1;
    const prox = $(`input[data-op="${j}"]`, li);
    if (prox) prox.focus(); else $('button[data-gv="add-opcao"]', li)?.click();
  };
  btAdd.onclick = () => {
    const lista = itens(); if (lista.length >= L.max_conteudos) return;
    lista.push(st.tipo === 'enquete' ? gvEnqueteVazia() : ''); st.ativo = lista.length - 1;
    pintarItens({ i: st.ativo, sel: campoDoItem() }); prever();
  };
  if (nova) {
    dispLigarSeg($('#gv-tipo', form), (v) => {
      st.tipo = v; st.ativo = 0; $('#gv-h1-t', form).textContent = titulo(); pintarItens(); prever();
    });
  }
  dispLigarSeg($('#gv-ordem', form), (v) => { st.ordem = v; });

  // ----- grupos, dias e horários -----
  const avisoAtualizar = () => {
    const outras = GV.lista.filter((x) => nova || x.id !== base.id); // a rotina aberta entra com o que está na tela
    const total = gradeMensagensDia({ regras: S.rules, rotinas: outras }) + st.horarios.length * grupos.marcados(dlg).length;
    const passou = total > AVISO_MENSAGENS_DIA;
    const html = passou ? `<b>!</b> ${esc(T.aviso(total, AVISO_MENSAGENS_DIA))}` : '';
    av.hidden = !passou; if (av.innerHTML !== html) av.innerHTML = html;
  };
  grupos.ligar(dlg, { contador: $('#gv-gcont', form), aoMudar: avisoAtualizar });
  diasEl.onclick = (e) => {
    const b = e.target.closest('button[data-d]'); if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true'; const d = Number(b.dataset.d);
    b.setAttribute('aria-pressed', String(on)); if (on) st.dias.add(d); else st.dias.delete(d);
    $$('.invalido', diasEl).forEach((x) => x.classList.remove('invalido'));
  };
  const pintarHorarios = () => {
    horEl.innerHTML = st.horarios.length
      ? st.horarios.map((h) => `<span class="chip">${h}<button type="button" data-h="${h}" aria-label="${T.removerHorarioAria(h)}">×</button></span>`).join('')
      : `<span class="dica">${T.semHorario}</span>`;
    const cheio = st.horarios.length >= L.max_horarios_rotina;
    contHor.textContent = T.contador(st.horarios.length, L.max_horarios_rotina); contHor.classList.toggle('cheio', cheio);
    btHor.disabled = cheio; inHor.disabled = cheio;
    avisoAtualizar();
  };
  const novoHorario = () => {
    const h = String(inHor.value).slice(0, 5);
    if (!GV_HHMM.test(h)) { mostrarErros(dlg, [{ msg: T.horarioInvalido, el: inHor }]); return; }
    if (st.horarios.length >= L.max_horarios_rotina) return;
    if (!st.horarios.includes(h)) { st.horarios.push(h); st.horarios.sort(); }
    if (inHor.classList.contains('invalido')) mostrarErros(dlg, []);
    inHor.value = ''; pintarHorarios();
    (inHor.disabled ? $('button', horEl) : inHor)?.focus();
  };
  btHor.onclick = novoHorario;
  inHor.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); novoHorario(); } };
  horEl.onclick = (e) => {
    const b = e.target.closest('button[data-h]'); if (!b) return;
    st.horarios = st.horarios.filter((h) => h !== b.dataset.h); pintarHorarios(); inHor.focus();
  };

  // ----- validar (as frases do servidor) e salvar -----
  const montar = () => {
    const erros = []; const lista = itens(); const n = lista.length;
    const pos = (i) => (n > 1 ? `${T.rotulo(st.tipo, i, n)}: ` : '');
    const noItem = (i, sel) => $(`li[data-i="${i}"] ${sel}`, ol);
    const nome = String(inNome.value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!nome) erros.push({ msg: T.erroNome, el: inNome });
    else if (nome.length > GV_MAX_NOME) erros.push({ msg: T.erroNomeLongo(GV_MAX_NOME), el: inNome });
    if (n > L.max_conteudos) erros.push({ msg: T.erroMuitos(L.max_conteudos, st.tipo), el: null });
    let conteudos;
    if (st.tipo === 'enquete') {
      conteudos = st.enquetes.map((c) => ({ pergunta: String(c.pergunta).trim(), opcoes: c.opcoes.map((o) => String(o).trim()).filter(Boolean), multipla: !!c.multipla }));
      conteudos.forEach((c, i) => {
        const opcao = () => $$(`li[data-i="${i}"] input[data-op]`, ol).find((x) => !String(x.value).trim()) || noItem(i, 'input[data-op]');
        let erro = null;
        if (!c.pergunta) erro = { msg: T.erroPergunta, el: noItem(i, 'input[data-campo="pergunta"]') };
        else if (c.opcoes.length < 2 || c.opcoes.length > GV_MAX_OPCOES) erro = { msg: T.erroOpcoes, el: opcao() };
        else if (new Set(c.opcoes.map((o) => o.toLocaleLowerCase('pt-BR'))).size !== c.opcoes.length) erro = { msg: T.erroRepetidas, el: noItem(i, 'input[data-op]') };
        else if (c.pergunta.length > GV_MAX_PERGUNTA) erro = { msg: T.erroPerguntaLonga(GV_MAX_PERGUNTA), el: noItem(i, 'input[data-campo="pergunta"]') };
        else if (c.opcoes.some((o) => o.length > GV_MAX_OPCAO)) erro = { msg: T.erroOpcaoLonga(GV_MAX_OPCAO), el: noItem(i, 'input[data-op]') };
        if (erro) erros.push({ msg: pos(i) + erro.msg, el: erro.el });
      });
    } else {
      conteudos = st.textos.map((c) => String(c).replace(/\r\n/g, '\n').trim());
      conteudos.forEach((c, i) => {
        if (!c) erros.push({ msg: pos(i) + T.erroTexto, el: noItem(i, 'textarea') });
        else if (c.length > GV_MAX_TEXTO) erros.push({ msg: pos(i) + T.erroTextoLongo(GV_MAX_TEXTO), el: noItem(i, 'textarea') });
      });
    }
    const jids = grupos.marcados(dlg);
    if (!jids.length) erros.push({ msg: T.erroGrupos, el: $('#gv-gr', dlg) });
    if (!st.dias.size) erros.push({ msg: T.erroDia, el: $('button', diasEl) });
    if (!st.horarios.length) erros.push({ msg: T.erroHorario, el: inHor.disabled ? null : inHor });
    else if (st.horarios.length > L.max_horarios_rotina) erros.push({ msg: T.erroMuitosHorarios(L.max_horarios_rotina), el: null });
    const corpo = {
      nome, ...(nova ? { tipo: st.tipo } : {}), conteudos, ordem: st.ordem, group_jids: jids,
      repetir: { dias: [...st.dias].sort((a, b) => a - b), horarios: [...st.horarios] },
      ...(nova ? { enabled: !!$('[name=ligar]', form)?.checked } : {}), // editar não liga nem pausa: isso é a chave do cartão
    };
    return { erros, corpo };
  };
  $('#gv-cancelar', form).onclick = () => dlg.close();
  form.onsubmit = tentar(async (ev) => {
    ev.preventDefault();
    const { erros, corpo } = montar();
    if (mostrarErros(dlg, erros)) return;
    const btn = $('#gv-salvar', form); btn.disabled = true; btn.textContent = T.salvando;
    try { await api(nova ? '/rotinas' : `/rotinas/${Number(base.id)}`, nova ? 'POST' : 'PUT', corpo); } catch (e) {
      btn.disabled = false; btn.textContent = nova ? T.criar : T.salvar;
      mostrarErros(dlg, [{ msg: e.message }]); return;
    }
    dlg.close(); aviso(nova ? T.criada : T.salva); await gvCarregar();
  });

  pintarItens(); prever(); pintarHorarios();
  gvMostrarDlg();
  inNome.focus();
}
