// Disparo manual (#disparo-manual, F1) e Disparar mensagem (#disparar-mensagem, F2).
// Spec: docs/produto/specs/disparos-comunicacao-conta.md. Plano: docs/produto/planos/disparos-comunicacao-conta.md (etapa 9).
// As rotas ficam em ROTAS (app.js), que já aplica main.larga às duas. Os grupos usam seletorGrupos() de app.js.
// Carrega antes de app.js: só define funções e constantes. Os utilitários de app.js ($, $$, esc, zap, S, aviso,
// mostrarErros, REQ, opcoes, seletorGrupos) e de ajuda.js (q) só são usados quando as páginas abrem.
// CSP (script-src 'self'; img-src 'self' data: https://*.mlstatic.com): nada inline. A miniatura da foto vem do
// FileReader (data:); a foto do produto só aparece se vier do CDN do Mercado Livre (senão, um desenho no lugar).

const TEXTOS_DISPAROS = {
  manual: {
    titulo: 'Disparo manual', ajuda: 'manual',
    sub: 'Cole o link de um produto, escolha os grupos e o template e dispare. O painel identifica a loja, gera o seu link de afiliado e envia com a foto do produto.',
  },
  mensagem: {
    titulo: 'Disparar mensagem', ajuda: 'mensagem',
    sub: 'Uma mensagem comum (com foto, se quiser) ou uma enquete para os grupos que você escolher. Envie agora, agende ou repita nos dias da semana.',
  },
  // estados gerais
  semConexao: 'Sem resposta do programa. Confira se ele está rodando e tente de novo.',
  soDono: 'Só o Dono pode fazer isso.',
  antesDeEnviar: 'Antes de enviar, falta:',
  naoEnviou: 'Não deu para enviar:',
  carregando: 'Carregando…',
  naoCarregou: 'Não consegui carregar agora. Tento de novo em alguns segundos.',
  ultimos30: 'Contagem dos últimos 30 dias.',
  verTudo: 'Ver tudo no Histórico',
  // Disparo manual
  linkPlaceholder: 'Cole aqui o link do produto',
  identificar: 'Identificar', identificando: 'Identificando…',
  pronto: (loja) => `${loja} · pronto para disparar`,
  semPreco: 'Achei o produto, mas não consegui ler o preço. O template vai omitir essa linha.',
  semProduto: 'Não consegui ler este produto. Confira o link e identifique de novo.',
  linkInvalido: 'Não reconheci este link. Cole o endereço completo da página do produto.',
  lojaNaoConectada: (loja) => `${loja} identificada, mas ainda não está conectada.`,
  configureConexoes: 'Configure em Conexões.',
  gerenciarTemplates: 'Gerenciar templates',
  semTemplates: 'Nenhum template. Crie um em Templates.',
  previaExemplo: 'Exemplo. Identifique um link para ver com o seu produto.',
  previaProduto: 'Com o produto identificado. O link de afiliado é gerado na hora do envio.',
  etiquetaDica: 'O link meli.la sai com esta etiqueta.',
  semEtiqueta: 'Cadastre uma etiqueta em <a href="#conexoes">Conexões</a> (Mercado Livre).',
  agendarRotulo: 'Agendar horário',
  agendarDica: 'Desligado, dispara na hora. Ligado, dispara no horário de hoje que você escolher.',
  horaHoje: 'Horário de hoje',
  disparar: 'Disparar', agendarEnvio: 'Agendar envio', enviando: 'Enviando…', salvando: 'Salvando…',
  motivoWhats: 'Conecte o WhatsApp em Números de WhatsApp para disparar agora.',
  motivoExtensao: 'A extensão do Chrome está desconectada: abra a Central de Afiliados no Chrome, ou agende o envio.',
  motivoIdentificando: 'Identificando o link…',
  motivoProduto: 'Identifique o link do produto.',
  motivoLoja: 'Conecte a loja para disparar.',
  motivoGrupo: 'Marque ao menos um grupo.',
  motivoTemplate: 'Escolha um template.',
  motivoEtiqueta: 'Cadastre uma etiqueta em Conexões.',
  faltaLink: 'Cole o link do produto.',
  faltaHora: 'Escolha a hora do envio.',
  horaPassada: 'A hora precisa ser depois de agora.',
  disparoIniciado: (n) => `Enviando para ${n} ${n === 1 ? 'grupo' : 'grupos'}. Acompanhe no histórico.`,
  agendadoPara: (quando) => `Envio agendado para ${quando}`,
  histVazioManual: 'Nenhum disparo ainda. O que você disparar aparece aqui.',
  agendadosHoje: 'Agendados',
  confirmaCancelarManual: 'Cancelar este disparo? Ele não será enviado.',
  canceladoManual: 'Disparo cancelado',
  // Disparar mensagem
  tipo: 'Tipo',
  mensagemRotulo: 'Mensagem',
  formatoDica: 'Use *negrito*, _itálico_ e ~riscado~ como no WhatsApp.',
  imagem: 'Imagem',
  escolherFoto: 'Escolher foto', trocarFoto: 'Trocar foto', removerFoto: 'Remover foto',
  fotoLegenda: 'O texto acima vai como legenda. JPG ou PNG, até 5 MB.',
  fotoTipo: 'Use uma foto JPG ou PNG.',
  fotoGrande: 'A foto passa de 5 MB. Escolha uma menor.',
  fotoSubindo: 'Enviando a foto…', fotoPronta: 'Foto pronta.',
  previaLinkDica: 'O WhatsApp mostra o título e a imagem do site embaixo do texto. Por enquanto, só links do Mercado Livre.',
  pergunta: 'Pergunta', opcoes: 'Opções',
  addOpcao: '+ Adicionar opção',
  multipla: 'Permitir mais de uma resposta',
  quandoEnviar: 'Quando enviar',
  diasSemana: 'Dias da semana', horarios: 'Horários',
  addHorario: '+ Adicionar horário', semHorario: 'Nenhum horário ainda.',
  repetirDica: 'Ex.: segunda e quinta, às 09:00 e 18:00.',
  comoAparece: 'Como vai aparecer',
  previaVazia: 'A prévia aparece aqui.',
  dispararAgora: 'Disparar agora', salvarRepeticao: 'Salvar repetição',
  faltaMensagem: 'Escreva a mensagem.',
  faltaFoto: 'Escolha a foto.',
  fotoAindaSubindo: 'Espere a foto terminar de subir.',
  fotoFalhou: 'A foto não subiu. Troque ou remova a foto.',
  faltaPreviaUrl: 'Cole o link da prévia.',
  previaUrlInvalida: 'O link da prévia precisa começar com https://.',
  faltaPergunta: 'A enquete precisa de uma pergunta.',
  faltaOpcoes: 'A enquete precisa de ao menos 2 opções.',
  opcoesRepetidas: 'As opções da enquete não podem se repetir.',
  faltaDataHora: 'Escolha a data e a hora do envio.',
  faltaDia: 'Escolha ao menos um dia da semana.',
  faltaHorario: 'Adicione ao menos um horário.',
  horarioInvalido: 'Escolha o horário antes de adicionar.',
  whatsAgora: 'Conecte o WhatsApp em Números de WhatsApp para enviar agora, ou escolha Agendar.',
  repeticaoSalva: 'Repetição salva',
  agendadasVazio: 'Nada agendado. Escolha Agendar ou Repetir em Quando enviar.',
  histVazioMensagem: 'Nenhuma mensagem enviada ainda. O que você enviar aparece aqui.',
  confirmaCancelar: 'Cancelar esta mensagem? Ela não será enviada.',
  cancelada: 'Mensagem cancelada', pausada: 'Mensagem pausada', retomada: 'Mensagem retomada',
};

const DISP_DIAS = [
  { d: 0, letra: 'D', nome: 'Domingo', curto: 'dom' },
  { d: 1, letra: 'S', nome: 'Segunda-feira', curto: 'seg' },
  { d: 2, letra: 'T', nome: 'Terça-feira', curto: 'ter' },
  { d: 3, letra: 'Q', nome: 'Quarta-feira', curto: 'qua' },
  { d: 4, letra: 'Q', nome: 'Quinta-feira', curto: 'qui' },
  { d: 5, letra: 'S', nome: 'Sexta-feira', curto: 'sex' },
  { d: 6, letra: 'S', nome: 'Sábado', curto: 'sáb' },
];
const DISP_FOTO_MAX = 5 * 1024 * 1024;
const DISP_FOTO_TIPOS = ['image/jpeg', 'image/png'];
const DISP_MAX_OPCOES = 12;
const DISP_MAX_HORARIOS = 6;
const DISP_ATUALIZA_MS = 6000;
// Foto do produto: só do CDN do Mercado Livre, o único site que a CSP libera (alinhado a IMAGEM_PERMITIDA de src/ml.js).
const DISP_IMG_ML = /^https:\/\/([a-z0-9-]+\.)+mlstatic\.com\//i;
// Desenho de sacola no lugar da foto do produto quando ela não vem ou vem de outro site.
const DISP_IMG_VAZIA = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><g fill="none" stroke="#8C88A6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 28h28l-2.5 24h-23z"/><path d="M29 28v-3a7 7 0 0 1 14 0v3"/></g></svg>');

/**
 * Como api() de app.js, mas o erro leva `status` e aceita `arquivo` (File) como corpo cru, para o upload da foto.
 */
async function dispApi(caminho, { method = 'GET', body, arquivo } = {}) {
  const opts = { method };
  if (arquivo) { opts.headers = { 'content-type': arquivo.type }; opts.body = arquivo; }
  else if (body) { opts.headers = { 'content-type': 'application/json' }; opts.body = JSON.stringify(body); }
  let r;
  try { r = await fetch('/api' + caminho, opts); } catch { throw new Error(TEXTOS_DISPAROS.semConexao); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.replace('/login.html'); throw new Error('Sessão expirada. Entre de novo.'); }
  if (!r.ok) {
    const T = TEXTOS_DISPAROS;
    const msg = j.erro || (r.status === 413 ? T.fotoGrande : r.status === 403 ? T.soDono : 'Erro ' + r.status);
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return j;
}

// ---------- formatação ----------
const dispDoisDig = (n) => String(n).padStart(2, '0');
/** Data local no formato do input date (YYYY-MM-DD). */
const dispDataISO = (d = new Date()) => `${d.getFullYear()}-${dispDoisDig(d.getMonth() + 1)}-${dispDoisDig(d.getDate())}`;
/** Próxima hora cheia de hoje ("15:00"); às 23 h fica 23:59 para não cair amanhã. */
function dispProximaHora() { const h = new Date().getHours(); return h >= 23 ? '23:59' : `${dispDoisDig(h + 1)}:00`; }
const dispHHMM = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
/** "Hoje 18:00", "Ontem 09:12", "Amanhã 08:00" ou "02/11 18:00". */
function dispQuando(ms) {
  if (!ms) return '—';
  const d = new Date(ms); const meiaNoite = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dias = Math.round((meiaNoite(d) - meiaNoite(new Date())) / 864e5);
  const rel = { 0: 'Hoje', [-1]: 'Ontem', 1: 'Amanhã' }[dias] || d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return `${rel} ${dispHHMM(ms)}`;
}
/** Data do input date + hora para frases: "hoje às 18:00", "amanhã às 09:00", "05/11 às 09:00". */
function dispDataFrase(ymd, hhmm) {
  const amanha = new Date(); amanha.setDate(amanha.getDate() + 1);
  const dia = ymd === dispDataISO() ? 'hoje' : ymd === dispDataISO(amanha) ? 'amanhã' : ymd.split('-').reverse().slice(0, 2).join('/');
  return `${dia} às ${hhmm}`;
}
/** ['a','b','c'] → "a, b e c". */
const dispLista = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} e ${a.at(-1)}`);
/** { dias:[1,4], horarios:['09:00','18:00'] } → "Seg e qui, 09:00 e 18:00". */
function dispDescRepetir(rep = {}) {
  const dias = DISP_DIAS.filter((x) => (rep.dias || []).map(Number).includes(x.d));
  const txtDias = dias.length === 7 ? 'todos os dias' : dispLista(dias.map((x) => x.curto));
  const txt = `${txtDias}${(rep.horarios || []).length ? ', ' + dispLista([...rep.horarios].sort()) : ''}`;
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}
const dispBrl = (n) => (n == null || n === '' || Number.isNaN(Number(n)) ? '' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const dispPlural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

// ---------- peças compartilhadas pelas duas telas ----------
/** mostrarErros de app.js, com a caixa logo acima do rodapé do card e o título certo para envio. */
function dispErros(form, erros, titulo = TEXTOS_DISPAROS.antesDeEnviar) {
  const tem = mostrarErros(form, erros);
  const box = $('.erros', form); const rod = $('.rodape-card', form);
  if (box) {
    if (rod && rod.parentNode === form && box.nextElementSibling !== rod) form.insertBefore(box, rod);
    const b = $('b', box); if (b) b.textContent = titulo;
  }
  return tem;
}
/** Trava os campos durante o envio. Devolve a função que destrava só o que estava habilitado. */
function dispTravar(raiz) {
  const els = $$('input, select, textarea, button', raiz).filter((e) => !e.disabled);
  els.forEach((e) => (e.disabled = true));
  return () => els.forEach((e) => (e.disabled = false));
}
/** Segmentado acessível: role=radiogroup, aria-checked e tabindex móvel (setas, Home e End trocam a escolha). */
function dispSegHtml(id, itens, atual, rotuloId) {
  return `<div class="seg" role="radiogroup" id="${id}" aria-labelledby="${rotuloId}" style="justify-self:start">${itens.map(([v, r]) =>
    `<button type="button" role="radio" data-v="${v}" aria-checked="${v === atual}" tabindex="${v === atual ? 0 : -1}">${r}</button>`).join('')}</div>`;
}
function dispLigarSeg(el, aoMudar) {
  const bts = $$('button[role="radio"]', el);
  const escolher = (b, foco) => {
    bts.forEach((x) => { const on = x === b; x.setAttribute('aria-checked', String(on)); x.tabIndex = on ? 0 : -1; });
    if (foco) b.focus();
    aoMudar(b.dataset.v);
  };
  el.onclick = (e) => { const b = e.target.closest('button[role="radio"]'); if (b && !b.disabled) escolher(b); };
  el.onkeydown = (e) => {
    const i = bts.indexOf(document.activeElement); if (i < 0) return;
    const passo = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const alvo = passo ? bts[(i + passo + bts.length) % bts.length] : e.key === 'Home' ? bts[0] : e.key === 'End' ? bts.at(-1) : null;
    if (!alvo) return;
    e.preventDefault(); escolher(alvo, true);
  };
}
/** Selo de status de uma linha do histórico: sempre com palavra, nunca só cor. */
function dispPill(status, ts, erro) {
  const s = String(status || '').toLowerCase();
  if (['enviado', 'ok', 'concluido'].includes(s)) return `<span class="estado-pill enviado">Enviado${S.st?.simulacao ? ' · simulado' : ''}</span>`;
  if (s === 'erro') return `<span class="estado-pill erro">Erro</span>${erro ? `<span class="dica-celula trunca" title="${esc(erro)}">${esc(erro)}</span>` : ''}`;
  if (s === 'pendente' || s === 'agendado') return `<span class="estado-pill pendente">Pendente${ts ? ' · ' + dispHHMM(ts) : ''}</span>`;
  if (s === 'enviando') return '<span class="estado-pill fila">Enviando</span>';
  if (s === 'fila' || s === 'na_fila') return '<span class="estado-pill fila">Na fila</span>';
  if (s === 'pausado') return '<span class="estado-pill pausado">Pausada</span>';
  if (s === 'cancelado') return '<span class="estado-pill pausado">Cancelado</span>';
  return `<span class="estado-pill">${esc(status || '—')}</span>`;
}
function dispKpis(c = {}, rotulos) {
  const itens = [['enviados', rotulos[0], ''], ['na_fila', rotulos[1], ''], ['com_erro', rotulos[2], ' erro']];
  return `<div class="kpis mini">${itens.map(([k, r, cls]) => `<div class="kpi${cls}"><div class="rotulo">${r}</div><div class="valor">${Number(c[k]) || 0}</div></div>`).join('')}</div>
    <p class="dica" style="margin:-4px 0 12px">${TEXTOS_DISPAROS.ultimos30}</p>`;
}
/**
 * Tabela das 20 linhas mais recentes de GET /api/envios: `quando` (ms: hora do envio ou, no pendente, a hora em que
 * vai sair), `titulo`, `grupo` (nome, ou "3 grupos") e `status`. `sub(l)` é a dica embaixo do título (loja, ou Mensagem/Enquete).
 */
function dispTabela(linhas, colTitulo, sub) {
  return `<div class="tabela"><table><thead><tr><th scope="col">Quando</th><th scope="col">${colTitulo}</th><th scope="col">Grupo</th><th scope="col">Status</th></tr></thead><tbody>
    ${linhas.slice(0, 20).map((l) => `<tr><td style="white-space:nowrap">${dispQuando(l.quando)}</td>
      <td><span class="trunca" title="${esc(l.titulo || '')}">${esc(l.titulo || '—')}</span>${sub(l) ? `<span class="dica-celula">${esc(sub(l))}</span>` : ''}</td>
      <td><span class="trunca" title="${esc(l.grupo || '')}">${esc(l.grupo || '—')}</span></td>
      <td>${dispPill(l.status, l.quando, l.erro)}</td></tr>`).join('')}</tbody></table></div>`;
}
/**
 * Um item de "Agendadas e repetidas" (ou dos disparos agendados do F1), de `agendadas` em GET /api/envios.
 * `titulo` é o começo do texto, a pergunta da enquete ou o produto. Pausar e Retomar só no repetido: o agendado
 * único só se cancela (o servidor recusa pausá-lo).
 */
function dispItemAgendado(a, { podePausar }) {
  const pausado = a.status === 'pausado';
  const rep = a.quando === 'repetir' && a.repetir;
  const titulo = String(a.titulo || '');
  const texto = a.tipo === 'enquete' ? `Enquete: ${titulo || '—'}` : titulo || '—';
  const n = Number.isInteger(a.grupos) ? a.grupos : Array.isArray(a.group_jids) ? a.group_jids.length : null;
  const id = Number(a.id);
  const curto = esc(texto.length > 60 ? texto.slice(0, 57) + '…' : texto); // o objeto do botão para o leitor de tela
  const pausar = !podePausar || a.quando !== 'repetir' ? '' : pausado
    ? `<button type="button" data-act="retomar" data-id="${id}" aria-label="Retomar: ${curto}">Retomar</button>`
    : a.status === 'pendente' ? `<button type="button" data-act="pausar" data-id="${id}" aria-label="Pausar: ${curto}">Pausar</button>` : '';
  return `<li><span class="texto" title="${esc(texto)}">${esc(texto)}</span>
    <span class="meta">${n != null ? `<span>${dispPlural(n, 'grupo', 'grupos')}</span>` : ''}<span>${esc(rep ? dispDescRepetir(a.repetir) : dispQuando(a.next_run_at))}</span>${rep && a.next_run_at && !pausado ? `<span>Próximo envio: ${esc(dispQuando(a.next_run_at))}</span>` : ''}${pausado ? '<span class="estado-pill pausado">Pausada</span>' : a.status === 'enviando' ? '<span class="estado-pill fila">Enviando</span>' : ''}</span>
    <div class="acoes">${pausar}<button type="button" class="perigo leve" data-act="cancelar" data-id="${id}" aria-label="Cancelar envio: ${curto}">Cancelar envio</button></div></li>`;
}
/** Repinta só se o conteúdo mudou (o polling não rouba o foco à toa) e devolve o foco ao mesmo botão. */
function dispRepintar(el, html) {
  if (el.dataset.ass === html) return;
  const f = document.activeElement;
  const chave = f && el.contains(f) && f.dataset.act ? `[data-act="${f.dataset.act}"][data-id="${f.dataset.id}"]` : '';
  el.innerHTML = html; el.dataset.ass = html;
  if (chave) $(chave, el)?.focus();
}
/** Ações cancelar/pausar/retomar por delegação. `msgs` = toast de cada ação; `depois` recarrega a lista. */
function dispLigarAcoes(el, { confirma, msgs, depois }) {
  el.onclick = async (ev) => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    const act = b.dataset.act; const id = Number(b.dataset.id);
    if (!['cancelar', 'pausar', 'retomar'].includes(act) || !Number.isInteger(id)) return;
    if (act === 'cancelar' && !confirm(confirma)) return;
    b.disabled = true;
    try { await dispApi(`/envios/${id}/${act}`, { method: 'POST' }); aviso(msgs[act]); } catch (e) { aviso(e.message, true); b.disabled = false; }
    await depois();
    // O botão clicado some na repintura (Pausar vira Retomar; o item cancelado sai): o foco fica no mesmo item ou na lista.
    if (!document.activeElement || document.activeElement === document.body) {
      ($(`button[data-id="${id}"]:not([data-act="cancelar"])`, el) || $(`button[data-id="${id}"]`, el) || $('button[data-act]', el))?.focus();
    }
  };
}
/**
 * Atualiza a tela a cada 6 s enquanto a rota estiver aberta e sem diálogo aberto (padrão de paginaHistorico).
 * Ao abrir a tela de novo, a cadeia anterior morre (geração).
 */
function dispAcompanhar(rota, passo) {
  clearTimeout(dispAcompanhar.t);
  const ger = (dispAcompanhar.ger = (dispAcompanhar.ger || 0) + 1);
  const agenda = () => { if (ger === dispAcompanhar.ger && location.hash === '#' + rota) dispAcompanhar.t = setTimeout(roda, DISP_ATUALIZA_MS); };
  const roda = async () => {
    if (ger !== dispAcompanhar.ger || location.hash !== '#' + rota) return;
    if (!$('#dlg').open) await passo().catch(() => {});
    agenda();
  };
  agenda();
}

// ================= Disparo manual (F1) =================
function paginaDisparoManual() {
  const T = TEXTOS_DISPAROS; const t = T.manual;
  const grupos = seletorGrupos({ blocos: true });
  const modoExt = () => !S.st.simulacao && S.st.ajustes?.link_mode === 'extension';
  $('#pagina').innerHTML = `<div class="topo"><div><h1>${t.titulo} ${q(t.ajuda)}</h1><p class="sub">${t.sub}</p></div></div>
  <div class="duas-col">
    <div>
      <form class="card form-pilha" id="dm-form" novalidate aria-label="${t.titulo}">
        <div style="display:grid;gap:6px">
          <label class="campo" for="dm-url"><span>Link do produto ${REQ} ${q('manual.link')}</span></label>
          <div class="linha"><input id="dm-url" type="url" inputmode="url" autocomplete="off" placeholder="${T.linkPlaceholder}" style="flex:999 1 220px">
            <button type="button" id="dm-identificar" style="flex:1 0 auto">${T.identificar}</button></div>
        </div>
        <div id="dm-prod" aria-live="polite"></div>
        <fieldset><legend>Grupos que vão receber ${REQ} <span class="contagem" id="dm-cont"></span></legend>${grupos.html}</fieldset>
        <div style="display:grid;gap:8px">
          <label class="campo"><span>Template ${REQ}</span><select id="dm-tpl">${opcoes(S.templates, S.templates[0]?.id)}</select>
            ${S.templates.length ? '' : `<small>${T.semTemplates}</small>`}</label>
          <a href="#templates" class="dica" style="justify-self:start">${T.gerenciarTemplates}</a>
          <div class="previa"><div class="chat" style="min-height:0"><div class="balao" id="dm-pv"></div></div><p class="legenda-previa" id="dm-pv-leg"></p></div>
        </div>
        <label class="campo"><span>Etiqueta ${q('manual.etiqueta')}</span>
          ${S.tags.length ? `<select id="dm-tag">${opcoes(S.tags, S.tags[0]?.id)}</select><small>${T.etiquetaDica}</small>`
            : `<select id="dm-tag" disabled><option value="">Nenhuma etiqueta cadastrada</option></select><small>${T.semEtiqueta}</small>`}</label>
        <div style="display:grid;gap:6px">
          <div class="linha"><label class="chave"><input type="checkbox" id="dm-agendar" aria-describedby="dm-agendar-dica"><span></span></label>
            <label for="dm-agendar" style="font-weight:600;font-size:14px">${T.agendarRotulo}</label>${q('manual.agendar')}</div>
          <small class="dica" id="dm-agendar-dica">${T.agendarDica}</small>
          <label class="campo" id="dm-hora-campo" hidden><span>${T.horaHoje} ${REQ}</span><input type="time" id="dm-hora" style="width:auto;justify-self:start"></label>
        </div>
        <div class="rodape-card"><button type="button" class="pri" id="dm-disparar" aria-describedby="dm-motivo">${T.disparar}</button><span class="dica" id="dm-motivo" aria-live="polite"></span></div>
      </form>
    </div>
    <div>
      <section class="card" aria-labelledby="dm-hist-h"><h2 id="dm-hist-h">Histórico</h2>
        <div id="dm-kpis" aria-live="polite"></div><div id="dm-hist"><p class="dica">${T.carregando}</p></div>
        <p style="margin:12px 0 0"><a href="#historico">${T.verTudo}</a></p></section>
    </div>
  </div>`;

  const form = $('#dm-form'); const inUrl = $('#dm-url'); const btnId = $('#dm-identificar'); const prodEl = $('#dm-prod');
  const selTpl = $('#dm-tpl'); const selTag = $('#dm-tag'); const pv = $('#dm-pv'); const pvLeg = $('#dm-pv-leg');
  const chkAg = $('#dm-agendar'); const campoHora = $('#dm-hora-campo'); const inHora = $('#dm-hora');
  const btn = $('#dm-disparar'); const motivoEl = $('#dm-motivo'); const kpisEl = $('#dm-kpis'); const histEl = $('#dm-hist');
  // produto: o que a identificação devolveu; texto: a prévia do servidor para o template textoTpl
  const st = { url: '', loja: null, produto: null, texto: '', textoTpl: '', identificando: false, enviando: false, ok: '' };
  form.onsubmit = (e) => e.preventDefault(); // Enter num campo nunca dispara

  let seqPv = 0;
  const prever = async () => {
    const n = ++seqPv; const tpl = S.templates.find((x) => String(x.id) === selTpl.value);
    if (!tpl) { pv.textContent = ''; pvLeg.textContent = T.semTemplates; return; }
    if (st.produto && st.texto && st.textoTpl === selTpl.value) { pv.innerHTML = zap(st.texto); pvLeg.textContent = T.previaProduto; return; }
    const p = st.produto;
    const amostra = p ? { title: p.title || '', price: p.price ?? null, oldPrice: p.oldPrice ?? null, sold: p.sold ?? null, freeShipping: !!p.freeShipping, coupon: p.coupon || '', discountPct: p.discountPct ?? null } : null;
    try {
      const r = await dispApi('/templates/preview', { method: 'POST', body: { body: tpl.body, ...(amostra ? { amostra } : {}) } });
      if (n !== seqPv) return;
      pv.innerHTML = zap(r.texto); pvLeg.textContent = p ? T.previaProduto : T.previaExemplo;
    } catch { /* fica a prévia anterior */ }
  };

  const motivo = () => {
    const agora = !chkAg.checked;
    if (agora && S.st.whatsapp?.status !== 'open') return T.motivoWhats;
    if (agora && modoExt() && !S.st.extensao?.online) return T.motivoExtensao;
    if (st.identificando) return T.motivoIdentificando;
    if (st.loja && !st.loja.implementada) return T.motivoLoja;
    if (!st.produto) return T.motivoProduto;
    if (!grupos.marcados(form).length) return T.motivoGrupo;
    if (!selTpl.value) return T.motivoTemplate;
    if (!S.tags.length && modoExt()) return T.motivoEtiqueta;
    return '';
  };
  const resumo = () => {
    const n = grupos.marcados(form).length; const tpl = S.templates.find((x) => String(x.id) === selTpl.value);
    return `${dispPlural(n, 'grupo', 'grupos')} · Template ${tpl?.name || '—'} · ${chkAg.checked ? (inHora.value ? 'hoje às ' + inHora.value : 'hoje, falta a hora') : 'agora'}`;
  };
  const atualizar = () => {
    const m = motivo();
    btn.disabled = st.enviando || !!m;
    btn.textContent = st.enviando ? T.enviando : chkAg.checked ? T.agendarEnvio : T.disparar;
    if (st.enviando) motivoEl.textContent = T.enviando;
    else if (st.ok) motivoEl.innerHTML = `<span class="nivel-ok">✓ ${esc(st.ok)}</span>`;
    else motivoEl.textContent = m || resumo();
  };

  // ----- identificar -----
  const limparProduto = () => {
    st.url = ''; st.loja = null; st.produto = null; st.texto = ''; st.textoTpl = '';
    prodEl.innerHTML = ''; inUrl.classList.remove('invalido'); inUrl.removeAttribute('aria-invalid');
  };
  const pintarFalha = (msg) => { prodEl.innerHTML = `<div class="card-prod aviso" role="alert"><div class="info"><span>${esc(msg)}</span></div></div>`; };
  const pintarProduto = (r) => {
    const loja = r.loja;
    if (!loja.implementada) {
      const txt = String(r.motivo || T.lojaNaoConectada(loja.nome || 'Loja')).replace(/\s*Configure em Conex(õ|o)es\.?\s*$/i, '');
      prodEl.innerHTML = `<div class="card-prod aviso"><div class="info"><span>${esc(txt)} <a href="#conexoes">${T.configureConexoes}</a></span></div></div>`;
      return;
    }
    const p = r.produto;
    if (!p) { pintarFalha(r.motivo || T.semProduto); return; }
    // Foto do CDN do Mercado Livre (a CSP libera https://*.mlstatic.com); qualquer outra vira o desenho de sacola.
    const img = DISP_IMG_ML.test(p.image || '') ? p.image : DISP_IMG_VAZIA;
    const temPreco = p.price != null && p.price !== '';
    const preco = temPreco ? `<span class="preco">${dispBrl(p.price)}${Number(p.oldPrice) > Number(p.price) ? `<s>${dispBrl(p.oldPrice)}</s>` : ''}</span>` : '';
    prodEl.innerHTML = `<div class="card-prod"><img src="${esc(img)}" alt="${esc(p.title || 'Produto')}" width="72" height="72">
      <div class="info"><span class="titulo" title="${esc(p.title || '')}">${esc(p.title || 'Produto sem título')}</span>${preco}
        <span class="chip">${esc(loja.nome || '')}</span>
        <span class="dica">${esc(temPreco ? T.pronto(loja.nome || '') : T.semPreco)}</span></div></div>`;
  };
  const identificar = async () => {
    const url = inUrl.value.trim();
    if (st.identificando) return;
    if (!url) { dispErros(form, [{ msg: T.faltaLink, el: inUrl }]); return; }
    const voltarFoco = document.activeElement === btnId;
    limparProduto(); dispErros(form, []);
    st.identificando = true; btnId.disabled = true; btnId.textContent = T.identificando; atualizar();
    try {
      const tplId = selTpl.value;
      const r = await dispApi('/disparo/identificar', { method: 'POST', body: { url, template_id: Number(tplId) || null, tag_id: Number(selTag.value) || null } });
      if (inUrl.value.trim() !== url) return; // o link mudou enquanto identificava
      if (!r || !r.loja) { pintarFalha(T.linkInvalido); return; }
      st.url = url; st.loja = r.loja;
      st.produto = r.loja.implementada ? r.produto || null : null;
      st.texto = st.produto ? r.texto || '' : ''; st.textoTpl = tplId;
      pintarProduto(r);
    } catch (e) {
      if (inUrl.value.trim() !== url) return;
      pintarFalha(e.message);
      inUrl.classList.add('invalido'); inUrl.setAttribute('aria-invalid', 'true');
    } finally {
      st.identificando = false; btnId.disabled = false; btnId.textContent = T.identificar;
      if (voltarFoco && (document.activeElement === document.body || !document.activeElement)) btnId.focus();
      prever(); atualizar();
    }
  };
  btnId.onclick = identificar;
  inUrl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); identificar(); } };
  // Editar o link depois de identificar limpa o resultado.
  inUrl.oninput = () => {
    if (st.url && inUrl.value.trim() === st.url) return;
    if (st.url || st.loja || prodEl.innerHTML) { limparProduto(); prever(); }
    atualizar();
  };

  // ----- template, etiqueta, agendar -----
  selTpl.onchange = () => { prever(); atualizar(); };
  chkAg.onchange = () => {
    campoHora.hidden = !chkAg.checked;
    if (chkAg.checked && !inHora.value) inHora.value = dispProximaHora();
    atualizar();
  };
  const horaPassada = () => new Date(`${dispDataISO()}T${inHora.value}`).getTime() <= Date.now();
  inHora.onchange = () => {
    if (inHora.value && horaPassada()) dispErros(form, [{ msg: T.horaPassada, el: inHora }]);
    else if (inHora.classList.contains('invalido')) dispErros(form, []);
    atualizar();
  };
  inHora.oninput = atualizar;

  // ----- disparar -----
  btn.onclick = async () => {
    const erros = [];
    if (!st.produto) erros.push({ msg: T.motivoProduto, el: inUrl });
    if (!grupos.marcados(form).length) erros.push({ msg: T.motivoGrupo, el: $('#gr', form) });
    if (!selTpl.value) erros.push({ msg: T.motivoTemplate, el: selTpl });
    if (chkAg.checked && !inHora.value) erros.push({ msg: T.faltaHora, el: inHora });
    else if (chkAg.checked && horaPassada()) erros.push({ msg: T.horaPassada, el: inHora });
    if (dispErros(form, erros)) return;
    const n = grupos.marcados(form).length; const hhmm = inHora.value;
    // Corpo achatado, como POST /api/envios lê (o servidor relê o produto pela url: o que a tela mostrou não vale).
    const corpo = {
      tipo: 'oferta', group_jids: grupos.marcados(form), quando: chkAg.checked ? 'agendado' : 'agora',
      ...(chkAg.checked ? { agendar_data: dispDataISO(), agendar_hhmm: hhmm } : {}),
      url: st.url, tag_id: Number(selTag.value) || null, template_id: Number(selTpl.value),
    };
    st.enviando = true; const soltar = dispTravar(form); form.setAttribute('aria-busy', 'true'); atualizar();
    let ok = false;
    try { await dispApi('/envios', { method: 'POST', body: corpo }); ok = true; }
    catch (e) { dispErros(form, [{ msg: e.message }], T.naoEnviou); }
    finally { st.enviando = false; soltar(); form.removeAttribute('aria-busy'); }
    if (ok) {
      const msg = corpo.quando === 'agendado' ? T.agendadoPara(`hoje às ${hhmm}`) : T.disparoIniciado(n);
      aviso(msg); st.ok = msg;
      inUrl.value = ''; limparProduto(); prever(); inUrl.focus();
      clearTimeout(paginaDisparoManual.ok); paginaDisparoManual.ok = setTimeout(() => { st.ok = ''; atualizar(); }, 3000);
      carregarHist();
    }
    atualizar();
  };

  // ----- histórico (direita) -----
  const carregarHist = async () => {
    try {
      const d = await dispApi('/envios?tipo=oferta');
      const ag = (d.agendadas || []).filter((a) => a.status !== 'cancelado');
      dispRepintar(kpisEl, dispKpis(d.contadores, ['Enviados', 'Pendentes', 'Com erro']));
      dispRepintar(histEl, `${ag.length ? `<h3 style="margin:0 0 8px;font-size:15px">${T.agendadosHoje}</h3><ul class="agendadas" style="margin-bottom:12px">${ag.map((a) => dispItemAgendado(a, { podePausar: false })).join('')}</ul>` : ''}
        ${(d.linhas || []).length ? dispTabela(d.linhas, 'Produto', (l) => l.loja || '') : `<div class="vazio">${T.histVazioManual}</div>`}`);
    } catch {
      if (!histEl.dataset.ass) dispRepintar(histEl, `<p class="dica">${esc(T.naoCarregou)}</p>`);
    }
  };
  dispLigarAcoes(histEl, { confirma: T.confirmaCancelarManual, msgs: { cancelar: T.canceladoManual }, depois: carregarHist });

  grupos.ligar(form, {
    contador: $('#dm-cont'), aoMudar: atualizar,
    aoBloco: (b) => { if (b.tag_id && selTag && !selTag.disabled && $(`option[value="${Number(b.tag_id)}"]`, selTag)) selTag.value = String(b.tag_id); },
  });
  prever(); atualizar(); carregarHist();
  dispAcompanhar('disparo-manual', async () => { await carregarHist(); if (!st.enviando) atualizar(); });
}

// ================= Disparar mensagem (F2) =================
function paginaDispararMensagem() {
  const T = TEXTOS_DISPAROS; const t = T.mensagem;
  const grupos = seletorGrupos({ blocos: true });
  const hoje = dispDataISO();
  const rot = 'font-weight:600;font-size:14px';
  $('#pagina').innerHTML = `<div class="topo"><div><h1>${t.titulo} ${q(t.ajuda)}</h1><p class="sub">${t.sub}</p></div></div>
  <div class="duas-col">
    <div>
      <form class="card form-pilha" id="mg-form" novalidate aria-label="${t.titulo}">
        <fieldset><legend>Grupos que vão receber ${REQ} <span class="contagem" id="mg-cont"></span></legend>${grupos.html}</fieldset>
        <div style="display:grid;gap:6px"><span id="mg-tipo-h" style="${rot}">${T.tipo}</span>
          ${dispSegHtml('mg-tipo', [['mensagem', 'Mensagem'], ['enquete', 'Enquete']], 'mensagem', 'mg-tipo-h')}</div>
        <section id="mg-sec-msg" class="form-pilha">
          <div style="display:grid;gap:4px">
            <label class="campo"><span>${T.mensagemRotulo} ${REQ} ${q('mensagem.formato')}</span>
              <textarea id="mg-texto" rows="8" maxlength="4096" aria-describedby="mg-texto-dica mg-texto-cont"></textarea></label>
            <div class="linha" style="justify-content:space-between"><small class="dica" id="mg-texto-dica">${T.formatoDica}</small><span class="contador" id="mg-texto-cont">0/4096</span></div>
          </div>
          <fieldset id="mg-imagem"><legend id="mg-img-h">${T.imagem} ${q('mensagem.imagem')}</legend>
            ${dispSegHtml('mg-img', [['nenhuma', 'Sem imagem'], ['upload', 'Foto com legenda'], ['previa', 'Prévia do link']], 'nenhuma', 'mg-img-h')}
            <div id="mg-img-upload" style="display:grid;gap:8px" hidden>
              <input type="file" id="mg-foto" accept="image/jpeg,image/png" hidden>
              <div class="miniatura" id="mg-mini" hidden><img id="mg-mini-img" alt="Prévia da foto">
                <div style="display:grid;gap:6px;min-width:0"><span class="dica" id="mg-foto-nome" style="overflow-wrap:anywhere"></span>
                  <div class="linha"><button type="button" id="mg-foto-trocar">${T.trocarFoto}</button><button type="button" class="perigo leve" id="mg-foto-remover">${T.removerFoto}</button></div></div></div>
              <div id="mg-foto-escolher-box"><button type="button" id="mg-foto-escolher">${T.escolherFoto}</button></div>
              <p class="dica" id="mg-foto-estado" role="status" style="margin:0"></p>
              <small class="dica">${T.fotoLegenda}</small>
            </div>
            <div id="mg-img-previa" hidden>
              <label class="campo"><span>Link ${REQ}</span><input id="mg-previa-url" type="url" inputmode="url" autocomplete="off" placeholder="https://produto.mercadolivre.com.br/…">
                <small>${T.previaLinkDica}</small></label></div>
          </fieldset>
        </section>
        <section id="mg-sec-enq" class="form-pilha" hidden>
          <label class="campo"><span>${T.pergunta} ${REQ} ${q('mensagem.enquete')}</span><input id="mg-pergunta" maxlength="255" autocomplete="off"></label>
          <div style="display:grid;gap:8px">
            <div class="linha" style="justify-content:space-between"><span id="mg-opc-h" style="${rot}">${T.opcoes} ${REQ}</span><span class="contador" id="mg-opc-cont"></span></div>
            <ol class="opcoes-enquete" id="mg-opcoes" aria-labelledby="mg-opc-h"></ol>
            <div><button type="button" id="mg-opc-add" aria-describedby="mg-opc-cont">${T.addOpcao}</button></div>
          </div>
          <label class="linha" style="font-weight:500"><input type="checkbox" id="mg-multipla" style="width:auto"> ${T.multipla}</label>
        </section>
        <div class="previa"><h3 style="margin:0;font-size:15px">${T.comoAparece}</h3>
          <div class="chat" style="min-height:0"><div class="balao" id="mg-pv"><img id="mg-pv-img" alt="" hidden style="display:block;max-width:100%;max-height:240px;border-radius:8px;margin-bottom:6px"><span id="mg-pv-txt"></span><small id="mg-pv-link" class="dica" hidden style="display:block;margin-top:6px"></small></div></div></div>
        <fieldset><legend id="mg-quando-h">${T.quandoEnviar} ${q('mensagem.quando')}</legend>
          ${dispSegHtml('mg-quando', [['agora', 'Agora'], ['agendado', 'Agendar'], ['repetir', 'Repetir']], 'agora', 'mg-quando-h')}
          <div id="mg-q-agendado" class="grade" hidden>
            <label class="campo"><span>Data ${REQ}</span><input type="date" id="mg-data" min="${hoje}" value="${hoje}"></label>
            <label class="campo"><span>Hora ${REQ}</span><input type="time" id="mg-hora" value="${dispProximaHora()}"></label></div>
          <div id="mg-q-repetir" style="display:grid;gap:14px" hidden>
            <div style="display:grid;gap:6px"><span id="mg-dias-h" style="${rot}">${T.diasSemana} ${REQ}</span>
              <div class="dias" id="mg-dias" role="group" aria-labelledby="mg-dias-h">${DISP_DIAS.map((d) => `<button type="button" data-d="${d.d}" aria-pressed="false" aria-label="${d.nome}" title="${d.nome}">${d.letra}</button>`).join('')}</div></div>
            <div style="display:grid;gap:6px"><span id="mg-hor-h" style="${rot}">${T.horarios} ${REQ}</span>
              <div class="horarios" id="mg-horarios" role="group" aria-labelledby="mg-hor-h"></div>
              <div class="linha"><input type="time" id="mg-hor-novo" aria-label="Novo horário" style="width:auto"><button type="button" id="mg-hor-add" aria-describedby="mg-hor-cont">${T.addHorario}</button><span class="contador" id="mg-hor-cont"></span></div>
              <small class="dica">${T.repetirDica}</small></div>
          </div>
        </fieldset>
        <div class="rodape-card"><button type="button" class="pri" id="mg-enviar">${T.dispararAgora}</button><span class="dica" id="mg-resumo" aria-live="polite"></span></div>
      </form>
    </div>
    <div>
      <section class="card" aria-labelledby="mg-ag-h"><h2 id="mg-ag-h">Agendadas e repetidas</h2>
        <div id="mg-agendadas"><p class="dica">${T.carregando}</p></div></section>
      <section class="card" aria-labelledby="mg-hist-h"><h2 id="mg-hist-h">Histórico</h2>
        <div id="mg-kpis" aria-live="polite"></div><div id="mg-hist"><p class="dica">${T.carregando}</p></div>
        <p style="margin:12px 0 0"><a href="#historico">${T.verTudo}</a></p></section>
    </div>
  </div>`;

  const form = $('#mg-form'); const ta = $('#mg-texto'); const contTexto = $('#mg-texto-cont');
  const secMsg = $('#mg-sec-msg'); const secEnq = $('#mg-sec-enq');
  const boxUpload = $('#mg-img-upload'); const boxPrevia = $('#mg-img-previa'); const inPrevia = $('#mg-previa-url');
  const inFoto = $('#mg-foto'); const mini = $('#mg-mini'); const miniImg = $('#mg-mini-img'); const fotoNome = $('#mg-foto-nome');
  const escolherBox = $('#mg-foto-escolher-box'); const fotoEstado = $('#mg-foto-estado');
  const inPerg = $('#mg-pergunta'); const olOpc = $('#mg-opcoes'); const contOpc = $('#mg-opc-cont'); const addOpc = $('#mg-opc-add'); const chkMult = $('#mg-multipla');
  const pvImg = $('#mg-pv-img'); const pvTxt = $('#mg-pv-txt'); const pvLink = $('#mg-pv-link');
  const qAg = $('#mg-q-agendado'); const qRep = $('#mg-q-repetir'); const inData = $('#mg-data'); const inHora = $('#mg-hora');
  const diasEl = $('#mg-dias'); const horEl = $('#mg-horarios'); const inHorNovo = $('#mg-hor-novo'); const addHor = $('#mg-hor-add'); const contHor = $('#mg-hor-cont');
  const btn = $('#mg-enviar'); const resumoEl = $('#mg-resumo'); const agEl = $('#mg-agendadas'); const kpisEl = $('#mg-kpis'); const histEl = $('#mg-hist');
  // foto = { nome, dataUrl, id, subindo, erro }; fotoSeq descarta resposta de foto já trocada
  const st = { tipo: 'mensagem', imagem: 'nenhuma', quando: 'agora', foto: null, fotoSeq: 0, opcoes: ['', ''], dias: new Set(), horarios: [], enviando: false, ok: '' };
  form.onsubmit = (e) => e.preventDefault();

  // ----- prévia -----
  const prever = () => {
    if (st.tipo === 'enquete') {
      const p = inPerg.value.trim(); const ops = st.opcoes.map((o) => o.trim()).filter(Boolean);
      pvImg.hidden = true; pvLink.hidden = true;
      pvTxt.innerHTML = p || ops.length
        ? `<strong>${esc(p || T.pergunta)}</strong>${ops.map((o) => `\n○ ${esc(o)}`).join('')}${chkMult.checked ? `\n<small class="dica">${T.multipla}</small>` : ''}`
        : `<span class="dica">${T.previaVazia}</span>`;
      return;
    }
    const comFoto = st.imagem === 'upload' && st.foto?.dataUrl;
    pvImg.hidden = !comFoto; if (comFoto && pvImg.src !== st.foto.dataUrl) pvImg.src = st.foto.dataUrl;
    const url = st.imagem === 'previa' ? inPrevia.value.trim() : '';
    pvLink.hidden = !url; pvLink.textContent = url ? `Prévia do link: ${url}` : '';
    pvTxt.innerHTML = ta.value.trim() ? zap(ta.value) : comFoto ? '' : `<span class="dica">${T.previaVazia}</span>`;
  };

  // ----- resumo, botão e seções -----
  const quandoTxt = () => (st.quando === 'agora' ? 'agora'
    : st.quando === 'agendado' ? (inData.value && inHora.value ? dispDataFrase(inData.value, inHora.value) : 'falta a data e a hora')
      : st.dias.size && st.horarios.length ? dispDescRepetir({ dias: [...st.dias], horarios: st.horarios }).toLowerCase() : 'falta dia e horário');
  const atualizar = () => {
    secMsg.hidden = st.tipo !== 'mensagem'; secEnq.hidden = st.tipo !== 'enquete';
    boxUpload.hidden = st.imagem !== 'upload'; boxPrevia.hidden = st.imagem !== 'previa';
    qAg.hidden = st.quando !== 'agendado'; qRep.hidden = st.quando !== 'repetir';
    const n = ta.value.length; contTexto.textContent = `${n}/4096`; contTexto.classList.toggle('cheio', n >= 4096);
    btn.disabled = st.enviando;
    btn.textContent = st.enviando ? (st.quando === 'agora' ? T.enviando : T.salvando)
      : { agora: T.dispararAgora, agendado: T.agendarEnvio, repetir: T.salvarRepeticao }[st.quando];
    if (st.enviando) resumoEl.textContent = btn.textContent;
    else if (st.ok) resumoEl.innerHTML = `<span class="nivel-ok">✓ ${esc(st.ok)}</span>`;
    else resumoEl.textContent = `${dispPlural(grupos.marcados(form).length, 'grupo', 'grupos')} · ${st.tipo === 'enquete' ? 'Enquete' : 'Mensagem'} · ${quandoTxt()}`;
  };

  dispLigarSeg($('#mg-tipo'), (v) => { st.tipo = v; prever(); atualizar(); });
  dispLigarSeg($('#mg-img'), (v) => { st.imagem = v; prever(); atualizar(); });
  dispLigarSeg($('#mg-quando'), (v) => { st.quando = v; atualizar(); });
  ta.oninput = () => { prever(); atualizar(); };
  inPrevia.oninput = prever;

  // ----- foto: miniatura pelo FileReader (data:) e upload por fetch com o File como corpo -----
  const pintarFoto = () => {
    const f = st.foto;
    mini.hidden = !f?.dataUrl; escolherBox.hidden = !!f?.dataUrl;
    if (f?.dataUrl && miniImg.src !== f.dataUrl) miniImg.src = f.dataUrl;
    fotoNome.textContent = f?.nome || '';
    fotoEstado.className = 'dica' + (f?.erro ? ' nivel-erro' : '');
    fotoEstado.textContent = !f ? '' : f.erro || (f.subindo ? T.fotoSubindo : f.id ? T.fotoPronta : '');
  };
  const escolherFoto = async (arq) => {
    if (!arq) return;
    if (!DISP_FOTO_TIPOS.includes(arq.type) || arq.size > DISP_FOTO_MAX) {
      st.fotoSeq++; st.foto = null; inFoto.value = ''; pintarFoto();
      fotoEstado.className = 'dica nivel-erro'; fotoEstado.textContent = DISP_FOTO_TIPOS.includes(arq.type) ? T.fotoGrande : T.fotoTipo;
      prever(); return;
    }
    const seq = ++st.fotoSeq;
    st.foto = { nome: arq.name, dataUrl: null, id: null, subindo: true, erro: '' }; pintarFoto();
    const leitor = new FileReader();
    leitor.onload = () => { if (seq === st.fotoSeq) { st.foto.dataUrl = String(leitor.result); pintarFoto(); prever(); } };
    leitor.readAsDataURL(arq);
    try {
      const r = await dispApi('/uploads', { method: 'POST', arquivo: arq });
      if (seq === st.fotoSeq) st.foto.id = r.id ?? null;
    } catch (e) { if (seq === st.fotoSeq) st.foto.erro = e.message; }
    if (seq === st.fotoSeq) { st.foto.subindo = false; pintarFoto(); }
  };
  const removerFoto = () => { st.fotoSeq++; st.foto = null; inFoto.value = ''; pintarFoto(); prever(); $('#mg-foto-escolher').focus(); };
  $('#mg-foto-escolher').onclick = () => inFoto.click();
  $('#mg-foto-trocar').onclick = () => inFoto.click();
  $('#mg-foto-remover').onclick = removerFoto;
  inFoto.onchange = () => escolherFoto(inFoto.files?.[0]);

  // ----- enquete -----
  const pintarOpcoes = (focar) => {
    olOpc.innerHTML = st.opcoes.map((v, i) => `<li><input data-i="${i}" maxlength="100" autocomplete="off" value="${esc(v)}" aria-label="Opção ${i + 1}">${i >= 2 ? `<button type="button" class="perigo leve" data-rm="${i}" aria-label="Remover opção ${i + 1}">Remover</button>` : ''}</li>`).join('');
    contOpc.textContent = `${st.opcoes.length} de ${DISP_MAX_OPCOES} opções`; contOpc.classList.toggle('cheio', st.opcoes.length >= DISP_MAX_OPCOES);
    addOpc.disabled = st.opcoes.length >= DISP_MAX_OPCOES;
    if (focar != null) $(`input[data-i="${focar}"]`, olOpc)?.focus();
  };
  const novaOpcao = () => { if (st.opcoes.length >= DISP_MAX_OPCOES) return; st.opcoes.push(''); pintarOpcoes(st.opcoes.length - 1); };
  olOpc.oninput = (e) => { const i = e.target.dataset?.i; if (i != null) { st.opcoes[Number(i)] = e.target.value; prever(); } };
  olOpc.onclick = (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    const i = Number(b.dataset.rm); st.opcoes.splice(i, 1); pintarOpcoes(Math.min(i, st.opcoes.length - 1)); prever();
  };
  // Enter numa opção vai para a próxima (ou cria uma nova, se for a última).
  olOpc.onkeydown = (e) => {
    const i = e.target.dataset?.i; if (e.key !== 'Enter' || i == null) return;
    e.preventDefault(); const prox = Number(i) + 1;
    if (prox < st.opcoes.length) $(`input[data-i="${prox}"]`, olOpc)?.focus(); else novaOpcao();
  };
  addOpc.onclick = novaOpcao;
  inPerg.oninput = prever; chkMult.onchange = prever;

  // ----- repetir: dias e horários -----
  diasEl.onclick = (e) => {
    const b = e.target.closest('button[data-d]'); if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true'; const d = Number(b.dataset.d);
    b.setAttribute('aria-pressed', String(on)); if (on) st.dias.add(d); else st.dias.delete(d);
    $$('.invalido', diasEl).forEach((x) => x.classList.remove('invalido'));
    atualizar();
  };
  const pintarHorarios = () => {
    horEl.innerHTML = st.horarios.length
      ? st.horarios.map((h) => `<span class="chip">${h}<button type="button" data-h="${h}" aria-label="Remover horário ${h}">×</button></span>`).join('')
      : `<span class="dica">${T.semHorario}</span>`;
    const cheio = st.horarios.length >= DISP_MAX_HORARIOS;
    contHor.textContent = `${st.horarios.length} de ${DISP_MAX_HORARIOS}`; contHor.classList.toggle('cheio', cheio);
    addHor.disabled = cheio; inHorNovo.disabled = cheio;
  };
  const novoHorario = () => {
    const h = inHorNovo.value.slice(0, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h)) { dispErros(form, [{ msg: T.horarioInvalido, el: inHorNovo }]); return; }
    if (st.horarios.length >= DISP_MAX_HORARIOS) return;
    if (!st.horarios.includes(h)) { st.horarios.push(h); st.horarios.sort(); }
    if (inHorNovo.classList.contains('invalido')) dispErros(form, []);
    inHorNovo.value = ''; pintarHorarios(); atualizar();
    (inHorNovo.disabled ? $('button', horEl) : inHorNovo)?.focus();
  };
  addHor.onclick = novoHorario;
  inHorNovo.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); novoHorario(); } };
  horEl.onclick = (e) => {
    const b = e.target.closest('button[data-h]'); if (!b) return;
    st.horarios = st.horarios.filter((h) => h !== b.dataset.h); pintarHorarios(); atualizar(); inHorNovo.focus();
  };
  inData.onchange = atualizar; inHora.onchange = atualizar;

  // ----- validar e enviar -----
  const montar = () => {
    const erros = []; const jids = grupos.marcados(form);
    if (!jids.length) erros.push({ msg: T.motivoGrupo, el: $('#gr', form) });
    let payload;
    if (st.tipo === 'mensagem') {
      const texto = ta.value;
      if (!texto.trim() && st.imagem !== 'upload') erros.push({ msg: T.faltaMensagem, el: ta });
      if (st.imagem === 'upload') {
        const f = st.foto; const el = f?.dataUrl ? $('#mg-foto-trocar') : $('#mg-foto-escolher');
        if (!f) erros.push({ msg: T.faltaFoto, el });
        else if (f.subindo) erros.push({ msg: T.fotoAindaSubindo, el });
        else if (!f.id) erros.push({ msg: T.fotoFalhou, el });
      }
      const url = inPrevia.value.trim();
      if (st.imagem === 'previa') {
        if (!url) erros.push({ msg: T.faltaPreviaUrl, el: inPrevia });
        else if (!/^https?:\/\/\S+$/i.test(url)) erros.push({ msg: T.previaUrlInvalida, el: inPrevia });
      }
      payload = { texto, imagem: st.imagem, ...(st.imagem === 'upload' ? { upload: st.foto?.id } : {}), ...(st.imagem === 'previa' ? { previa_url: url } : {}) };
    } else {
      const pergunta = inPerg.value.trim(); const ops = st.opcoes.map((o) => o.trim()).filter(Boolean);
      if (!pergunta) erros.push({ msg: T.faltaPergunta, el: inPerg });
      if (ops.length < 2) erros.push({ msg: T.faltaOpcoes, el: $$('input[data-i]', olOpc).find((i) => !i.value.trim()) || null });
      else if (new Set(ops.map((o) => o.toLowerCase())).size !== ops.length) erros.push({ msg: T.opcoesRepetidas, el: null });
      payload = { pergunta, opcoes: ops, multipla: chkMult.checked };
    }
    const corpo = { tipo: st.tipo, group_jids: jids, quando: st.quando, ...payload }; // achatado, como POST /api/envios lê
    if (st.quando === 'agora' && S.st.whatsapp?.status !== 'open') erros.push({ msg: T.whatsAgora });
    if (st.quando === 'agendado') {
      if (!inData.value || !inHora.value) erros.push({ msg: T.faltaDataHora, el: !inData.value ? inData : inHora });
      else if (new Date(`${inData.value}T${inHora.value}`).getTime() <= Date.now()) erros.push({ msg: T.horaPassada, el: inHora });
      corpo.agendar_data = inData.value; corpo.agendar_hhmm = inHora.value;
    }
    if (st.quando === 'repetir') {
      if (!st.dias.size) erros.push({ msg: T.faltaDia, el: $('button', diasEl) });
      if (!st.horarios.length) erros.push({ msg: T.faltaHorario, el: inHorNovo.disabled ? null : inHorNovo });
      corpo.repetir = { dias: [...st.dias].sort((a, b) => a - b), horarios: [...st.horarios] };
    }
    return { erros, corpo };
  };
  const limparConteudo = () => {
    ta.value = ''; inPrevia.value = ''; st.fotoSeq++; st.foto = null; inFoto.value = ''; pintarFoto();
    inPerg.value = ''; st.opcoes = ['', '']; chkMult.checked = false; pintarOpcoes();
  };
  btn.onclick = async () => {
    const { erros, corpo } = montar();
    if (dispErros(form, erros)) return;
    st.enviando = true; const soltar = dispTravar(form); form.setAttribute('aria-busy', 'true'); atualizar();
    let ok = false;
    try { await dispApi('/envios', { method: 'POST', body: corpo }); ok = true; }
    catch (e) { dispErros(form, [{ msg: e.message }], T.naoEnviou); }
    finally { st.enviando = false; soltar(); form.removeAttribute('aria-busy'); }
    if (ok) {
      const msg = corpo.quando === 'agora' ? T.disparoIniciado(corpo.group_jids.length)
        : corpo.quando === 'agendado' ? T.agendadoPara(dispDataFrase(corpo.agendar_data, corpo.agendar_hhmm)) : T.repeticaoSalva;
      aviso(msg); st.ok = msg; limparConteudo(); prever();
      clearTimeout(paginaDispararMensagem.ok); paginaDispararMensagem.ok = setTimeout(() => { st.ok = ''; atualizar(); }, 3000);
      carregarPainel();
    }
    // a contagem de opções e horários decide o que fica desabilitado depois de destravar
    addOpc.disabled = st.opcoes.length >= DISP_MAX_OPCOES; pintarHorarios();
    atualizar();
  };

  // ----- agendadas e histórico (direita) -----
  const carregarPainel = async () => {
    try {
      const d = await dispApi('/envios?tipo=mensagem');
      const ag = (d.agendadas || []).filter((a) => a.status !== 'cancelado');
      dispRepintar(agEl, ag.length ? `<ul class="agendadas">${ag.map((a) => dispItemAgendado(a, { podePausar: true })).join('')}</ul>` : `<div class="vazio">${T.agendadasVazio}</div>`);
      dispRepintar(kpisEl, dispKpis(d.contadores, ['Enviados', 'Na fila', 'Com erro']));
      dispRepintar(histEl, `${(d.linhas || []).length ? dispTabela(d.linhas, 'Mensagem', (l) => (l.tipo === 'enquete' ? 'Enquete' : 'Mensagem')) : `<div class="vazio">${T.histVazioMensagem}</div>`}`);
    } catch {
      if (!agEl.dataset.ass) dispRepintar(agEl, `<p class="dica">${esc(T.naoCarregou)}</p>`);
      if (!histEl.dataset.ass) dispRepintar(histEl, `<p class="dica">${esc(T.naoCarregou)}</p>`);
    }
  };
  dispLigarAcoes(agEl, { confirma: T.confirmaCancelar, msgs: { cancelar: T.cancelada, pausar: T.pausada, retomar: T.retomada }, depois: carregarPainel });

  grupos.ligar(form, { contador: $('#mg-cont'), aoMudar: atualizar });
  pintarOpcoes(); pintarHorarios(); pintarFoto(); prever(); atualizar(); carregarPainel();
  dispAcompanhar('disparar-mensagem', carregarPainel);
}
