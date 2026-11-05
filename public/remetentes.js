// Remetente: números cadastrados pelo dono que mandam, no privado do WhatsApp, links de Mercado Livre, Amazon ou Shopee;
// o programa monta a oferta com a afiliação do dono e a envia aos grupos do remetente. Aqui: cartões (Disparo automático),
// formulário "Novo remetente" / "Editar remetente" com a máscara de telefone BR e a visão Remetente do Histórico.
// Spec: docs/produto/specs/envio-pelo-socio.md. Plano: docs/produto/planos/envio-pelo-socio.md (etapa 7).
// Rotas: GET/POST /api/remetentes, PUT/DELETE /api/remetentes/:id, POST /api/remetentes/:id/enabled,
// GET /api/remetentes/itens. A escrita é só do Dono (o servidor responde 403 ao Operador; o Operador não vê os botões).
// Carrega depois de espelhamento.js e antes de app.js: só define funções e constantes (prefixo rem/REM, para não colidir
// no escopo global dos scripts clássicos). Usa de app.js ($, $$, esc, zap, S, api, aviso, tentar, REQ, opcoes,
// mostrarErros, seletorGrupos, hora, q, paginaHistorico, rotaAtual, podeEquipe, recarregarRegras), de disparos.js
// (dispSegHtml, dispLigarSeg) e de espelhamento.js (ESP_H, espN, espNomeCurto, espDestinosAtivos, histTipoHtml,
// histLigarTipo, histIr, ESP_AMOSTRA, ESP_LINK_PREVIA) só quando as telas abrem.
// Privacidade: o servidor manda o número só mascarado e nunca manda o número inteiro, o LID, o link recebido nem o texto
// da mensagem. Todo texto que vem do servidor (nomes, título, motivo, erro) passa por esc().

const TEXTOS_REMETENTE = {
  novo: 'Novo remetente', criar: 'Criar remetente', editarTitulo: 'Editar remetente',
  chip: 'Remetente', tipo: 'Remetente',
  subRegras: 'Também pode espelhar ofertas da Amazon e receber links de outros números.',
  verRegistro: 'Ver registro', editar: 'Editar', excluir: 'Excluir', salvar: 'Salvar', cancelar: 'Cancelar', salvando: 'Salvando…',
  pausado: 'Pausado', soDono: 'Só o Dono altera os remetentes.',
  ativoAria: (nome) => `Remetente ativo: ${nome}`, editarAria: (nome) => `Editar remetente ${nome}`, excluirAria: (nome) => `Excluir remetente ${nome}`,
  naoCarregouLista: (msg) => `Não consegui carregar os remetentes: ${msg}`,
  confirmaExcluir: (nome) => `Excluir o remetente “${nome}”? Ele deixa de poder mandar links. O que já foi enviado continua no Histórico.`,
  criado: 'Remetente criado', criadoDesligado: 'Remetente criado, desligado', salvo: 'Remetente salvo', ligado: 'Remetente ligado', pausadoAviso: 'Remetente pausado', excluido: 'Remetente excluído',
  // cartão
  numeroRes: 'Número', paraRes: 'Para', templateRes: 'Template', limiteRes: (n) => `Até ${n} ${n === 1 ? 'link' : 'links'} por hora.`,
  semAtividade: 'Ainda não recebeu links.', nenhumHoje: 'Nenhum link nas últimas 24 h.',
  ultimo: (quando) => `Último link: ${quando}.`, hoje: 'hoje', ontem: 'ontem',
  numeroFim: (fim) => `número terminado em ${fim}`,
  verConexoes: 'Ver em Conexões.',
  // formulário
  privacidade: 'O número fica só no seu computador.',
  nome: 'Nome', nomeDica: 'Ex.: Sócio João. Só você vê este nome.',
  numero: 'Número do remetente', numeroPh: '(35) 99999-1234',
  numeroDica: 'Com DDD. Exemplo: (35) 99999-1234. É o número do WhatsApp de quem vai mandar os links.',
  numeroManter: (html) => `Hoje: ${html}. Deixe em branco para manter; digite outro para trocar.`,
  destino: 'Grupos de destino', destinoDica: 'Para onde vão os links que este número mandar.', buscaDestino: 'Buscar grupo de destino',
  blocoDica: 'O bloco só ajuda a marcar. Se você mudar o bloco depois, esta lista não muda.',
  etiqueta: 'Etiqueta do Mercado Livre', etiquetaPadrao: 'A etiqueta ML padrão',
  etiquetaDica: 'Vale só para links do Mercado Livre. Amazon e Shopee usam a configuração de Conexões.',
  template: 'Template', gerenciarTemplates: 'Gerenciar templates', camposTemplate: 'Campos do template',
  previaLoja: 'Exemplo da prévia', previaLegenda: 'Exemplo. Linha sem valor some sozinha.',
  lojas: [['ml', 'Mercado Livre'], ['amazon', 'Amazon'], ['shopee', 'Shopee']],
  foto: 'Foto do produto', fotoComFoto: 'Enviar com foto, quando houver', fotoSoTexto: 'Só texto',
  ritmo: 'Ritmo e proteção',
  maxHora: 'No máximo (links por hora)',
  maxHoraDica: 'Passou disso, os links da hora são descartados e o remetente recebe um aviso. Protege os seus grupos se o número for usado por outra pessoa.',
  repetir: 'Não repetir o mesmo produto por (horas)', repetirDica: '0 = pode repetir. Vale mesmo se o link for diferente.',
  pausas: 'As pausas entre mensagens são as de', ajustes: 'Ajustes',
  responder: 'Responder ao remetente no WhatsApp',
  responderDica: 'Manda uma frase curta ao número cadastrado dizendo se o link saiu. Desligado, ele não recebe nada.',
  ligarAgora: 'Ligar agora', ligarDica: 'Desligado, o remetente fica cadastrado, mas os links dele são ignorados.',
  semGrupos: 'Conecte o WhatsApp em Números de WhatsApp para escolher os grupos.',
  erroNome: 'Dê um nome ao remetente.', erroNomeGrande: 'O nome pode ter até 60 caracteres.',
  erroNumero: 'Informe o número com DDD. Exemplo: (35) 99999-1234.',
  erroDestino: 'Marque ao menos um grupo de destino.', erroDestinoMuitos: 'Marque no máximo 500 grupos de destino.',
  erroTemplate: 'Escolha um template.', erroLink: 'O template precisa do campo {LINK}.',
  erroMaxHora: 'Links por hora: use um número de 1 a 60.', erroRepetir: 'Horas sem repetir: use de 0 a 8760.',
  // Histórico
  hist: {
    titulo: 'Histórico', sub: 'Tudo que foi enviado e tudo que deu errado, com o motivo.',
    regra: 'Remetente', todos: 'Todos os remetentes',
    ultimas24: 'Últimas 24 h', enviados: 'Enviados', descartados: 'Descartados', comErro: 'Com erro',
    carregando: 'Carregando…',
    erroCarregar: 'Não consegui carregar o histórico. Tente de novo.', tentarDeNovo: 'Tentar de novo',
    vazio: 'Nenhum link recebido ainda. Cadastre um remetente em <a href="#disparo-automatico">Disparo automático</a>.',
    vazioFiltro: 'Nada com este filtro nas últimas 24 h.',
    colunas: ['Quando', 'Remetente', 'Grupo', 'Oferta', 'Resultado'],
    rotulosCelula: { remetente: 'Remetente', grupo: 'Grupo' },
    mostrarMais: 'Mostrar mais', carregandoMais: 'Carregando…',
    mostrando: (n) => `Mostrando ${n} ${n === 1 ? 'link' : 'links'}.`, fim: (n) => `Mostrando ${n === 1 ? 'o único link' : `todos os ${n} links`}.`,
    semRemetente: '(remetente excluído)', semLink: 'Mensagem sem link de loja',
    produto: { mercadolivre: 'Produto do Mercado Livre', amazon: 'Produto da Amazon', shopee: 'Produto da Shopee' },
    enviada: 'Enviada', processando: 'Processando…', enviando: 'enviando…', semMotivo: 'sem motivo registrado',
    descartada: (m) => `Descartada: ${m}`, naoSaiu: (m) => `Não saiu: ${m}`,
    erroGrupos: (n) => `Erro ao enviar para ${n} ${n === 1 ? 'grupo' : 'grupos'}`,
    detalhe: { api: 'com o título da loja', 'api+texto': 'com dados da loja e do texto do remetente', texto: 'com o texto do remetente' },
  },
};

/** Ofertas de exemplo da prévia do template (o servidor completa a do Mercado Livre com SAMPLE_OFFER, src/template.js). */
const REM_LINK_ML = 'https://meli.la/•••';
const REM_AMOSTRA_SHOPEE = {
  title: 'Garrafa Térmica Inox 1 Litro com Tampa Antivazamento', price: 39.9, oldPrice: 79.9, discountPct: 50,
  sold: 1500, freeShipping: true, coupon: '', link: 'https://s.shopee.com.br/•••',
};
/** Códigos de bloqueio por falta de afiliação (src/remetentes.js): a linha do Histórico leva a Conexões. */
const REM_AFILIACAO = new Set(['sem_etiqueta', 'modo_direto', 'sem_extensao', 'sem_tag_amazon', 'sem_id_shopee', 'sem_link_shopee']);

// Estado: lista de remetentes (Disparo automático e Histórico) e da visão Remetente do Histórico.
const REM = { lista: [], info: null, erro: '' };
const REM_H = { itens: [], fim: false, regra: '', carregandoMais: false };
const REM_PAGINA = 50; // o servidor devolve no máximo 50 por pedido

// ---------- telefone BR (função pura; a mesma regra vale no servidor, que decide) ----------
/** Só os dígitos; com 12 ou 13 dígitos começando por 55, tira o código do país. */
function digitosBR(valor) {
  const d = String(valor ?? '').replace(/\D/g, '');
  return (d.length === 12 || d.length === 13) && d.startsWith('55') ? d.slice(2) : d;
}
/** 10 ou 11 dígitos, DDD de 11 a 99 e, com 11, o terceiro dígito é 9. */
const telefoneBRValido = (d) => /^\d{10,11}$/.test(d) && Number(d.slice(0, 2)) >= 11 && (d.length === 10 || d[2] === '9');
/** Máscara ao digitar: (35) 99999-1234 ou (35) 3333-1234. Mais dígitos que um número BR: os dígitos, sem cortar. */
function mascaraTelefoneBR(valor) {
  const d = digitosBR(valor);
  if (!d || d.length > 11) return d;
  if (d.length <= 2) return `(${d}`;
  const dd = d.slice(0, 2); const r = d.slice(2);
  if (r.length <= 4) return `(${dd}) ${r}`;
  if (r.length <= 8) return `(${dd}) ${r.slice(0, 4)}-${r.slice(4)}`;
  return `(${dd}) ${r.slice(0, 5)}-${r.slice(5)}`;
}
/** Formata o campo no lugar, com o cursor depois do mesmo número de dígitos de antes (colar e apagar continuam livres). */
function remAplicarMascara(input) {
  const antes = String(input.value ?? ''); const novo = mascaraTelefoneBR(antes);
  if (novo === antes) return;
  const pos = Number.isInteger(input.selectionStart) ? input.selectionStart : antes.length;
  const tirados = antes.replace(/\D/g, '').length - novo.replace(/\D/g, '').length; // o 55 do país
  const n = Math.max(0, antes.slice(0, pos).replace(/\D/g, '').length - tirados);
  input.value = novo;
  let i = 0; for (let vistos = 0; i < novo.length && vistos < n; i++) if (/\d/.test(novo[i])) vistos++;
  if (document.activeElement === input) try { input.setSelectionRange(i, i); } catch { /* campo sem seleção */ }
}
/** '+55 35 •••••-1234' (mascararNumero do servidor) → '(35) •••••-1234'; outro formato fica como veio. */
function remNumeroTela(numero) {
  const s = String(numero ?? ''); const m = /^\+55 (\d{2}) (•+)-(\d{4})$/.exec(s);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : s;
}
/** Número mascarado na tela; o leitor de tela ouve "número terminado em 1234" em vez dos pontos. */
function remNumeroHtml(numero) {
  const tela = remNumeroTela(numero); const fim = /(\d{4})$/.exec(tela)?.[1];
  return fim ? `<span aria-hidden="true">${esc(tela)}</span><span class="sr-only">${esc(TEXTOS_REMETENTE.numeroFim(fim))}</span>` : esc(tela || '—');
}
/** "hoje, 14:32", "ontem, 14:32" ou "03/11, 14:32". */
function remQuando(ms) {
  const T = TEXTOS_REMETENTE; const d = new Date(ms); const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
  if (d.toDateString() === new Date().toDateString()) return `${T.hoje}, ${hm}`;
  if (d.toDateString() === ontem.toDateString()) return `${T.ontem}, ${hm}`;
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}, ${hm}`;
}

/** Lê GET /api/remetentes para REM. Falha (rota ausente, servidor fora) vira texto em REM.erro, nunca exceção. */
async function carregarRemetentes() {
  try {
    const r = await api('/remetentes');
    REM.lista = Array.isArray(r?.remetentes) ? r.remetentes : []; REM.info = r; REM.erro = '';
  } catch (e) { REM.erro = e.message || 'erro'; }
}

// ---------- cartão (Disparo automático) ----------
function resumoRemetente(r) {
  const T = TEXTOS_REMETENTE; const d = espDestinosAtivos(r); const max = Number(r.max_por_hora) || 0;
  const para = d === 1 && Array.isArray(r.destinos_nomes) && r.destinos_nomes.length === 1 ? `o grupo “${espNomeCurto(r.destinos_nomes[0])}”` : espN(d, 'grupo', 'grupos');
  return [`${T.numeroRes} ${remNumeroHtml(r.numero)}.`, `${T.paraRes} ${para}.`, `${T.templateRes}: ${esc(r.template_nome || '—')}.`, T.limiteRes(max)].join(' ');
}
function remNumeros(r) {
  const T = TEXTOS_REMETENTE; const c = r.contadores_24h || {}; const n = (k) => Number(c[k]) || 0;
  const ultimo = r.ultimo_em ? ` ${T.ultimo(remQuando(r.ultimo_em))}` : '';
  if (!n('recebidos')) return r.ultimo_em ? T.nenhumHoje + ultimo : T.semAtividade;
  const partes = [espN(n('recebidos'), 'link recebido', 'links recebidos'), espN(n('enviados'), 'enviado', 'enviados')];
  if (n('repetidos')) partes.push(espN(n('repetidos'), 'repetido', 'repetidos'));
  if (n('descartados')) partes.push(espN(n('descartados'), 'descartado', 'descartados'));
  if (n('com_erro')) partes.push(`${n('com_erro')} com erro`);
  return `Últimas 24 h: ${partes.join(', ')}.${ultimo}`;
}
/** Linha do problema real (do servidor): "!" textual, a classe do nível e, se pedido, o link para Conexões. */
function remProblemaHtml(p) {
  if (!p || !p.texto) return '';
  const cls = p.nivel === 'aviso' ? 'nivel-aviso' : 'nivel-erro';
  const link = p.conexao ? ` <a href="#conexoes" class="alvo24" style="text-decoration:underline">${TEXTOS_REMETENTE.verConexoes}</a>` : '';
  return `<p class="${cls} aviso-cartao" role="status"><b>!</b> ${esc(p.texto)}${link}</p>`;
}
/** Endereço do Histórico, visão Remetente, filtrado por remetente. */
const remEndereco = (id) => `#historico?tipo=remetente&regra=${Number(id)}`;
/** Cartão de um remetente. `dono`: com a chave de ligar, Editar e Excluir (o Operador vê a chave travada e uma dica). */
function cartaoRemetente(r, dono) {
  const T = TEXTOS_REMETENTE;
  const acoes = dono
    ? `<button data-act="rem-editar" aria-label="${esc(T.editarAria(r.nome))}">${T.editar}</button>
      <button data-act="rem-excluir" class="perigo leve" aria-label="${esc(T.excluirAria(r.nome))}">${T.excluir}</button>`
    : `<small class="dica">${T.soDono}</small>`;
  return `<article class="card regra" data-rem-id="${Number(r.id)}">
    <h2><label class="chave" title="${dono ? 'Ligar ou pausar' : esc(T.soDono)}"><input type="checkbox" data-act="rem-ligar"${r.enabled ? ' checked' : ''}${dono ? '' : ' disabled'} aria-label="${esc(T.ativoAria(r.nome))}"><span></span></label>
      ${esc(r.nome)} <span class="chip">${T.chip}</span></h2>
    <p class="res">${resumoRemetente(r)}</p>
    ${remProblemaHtml(r.problema)}
    <div class="prox">${r.enabled ? '' : T.pausado + '. '}${esc(remNumeros(r))}</div>
    <div class="acoes">
      <button class="pri" data-act="rem-registro">${T.verRegistro}</button>
      ${acoes}</div></article>`;
}
/** Cartões dos remetentes (e a linha de erro, se a lista não carregou), para a lista mista de paginaRegras. */
function cartoesRemetentes() {
  const erro = REM.erro ? `<p class="dica" role="status">${esc(TEXTOS_REMETENTE.naoCarregouLista(REM.erro))}</p>` : '';
  const dono = podeEquipe();
  return erro + REM.lista.map((r) => cartaoRemetente(r, dono)).join('');
}
/** Cliques de data-act="rem-…" da lista de Disparo automático. Lança erro (o chamador mostra o toast). */
async function remetenteAcao(b) {
  const T = TEXTOS_REMETENTE; const id = Number(b.closest('[data-rem-id]')?.dataset.remId); const r = REM.lista.find((x) => x.id === id); const act = b.dataset.act;
  if (!r) return;
  if (act === 'rem-registro') { location.hash = remEndereco(id); return; }
  if (!podeEquipe()) return; // o Operador não tem os botões; o servidor também recusa com 403
  if (act === 'rem-ligar') {
    try { await api(`/remetentes/${id}/enabled`, 'POST', { enabled: b.checked }); } catch (err) { b.checked = !b.checked; throw err; }
    aviso(b.checked ? T.ligado : T.pausadoAviso); await recarregarRegras();
  }
  if (act === 'rem-editar') formRemetente(r);
  if (act === 'rem-excluir' && confirm(T.confirmaExcluir(r.nome))) { await api(`/remetentes/${id}`, 'DELETE'); aviso(T.excluido); await recarregarRegras(); }
}

// ---------- formulário "Novo remetente" / "Editar remetente" ----------
function formRemetente(r) {
  const T = TEXTOS_REMETENTE; const nova = !r; const dlg = $('#dlg');
  r = r || { nome: '', numero: '', enabled: true, destino_jids: [], template_id: S.templates[0]?.id ?? null, tag_id: null, enviar_foto: true,
    max_por_hora: 10, dedupe_horas: 24, responder: true };
  const destino = seletorGrupos({ selecionados: r.destino_jids, blocos: true, prefixo: 's-', rotuloBusca: T.buscaDestino });
  const semGrupos = !S.groups.length;
  const tags = (S.tags || []).map((t) => `<option value="${Number(t.id)}"${t.id === r.tag_id ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
  dlg.innerHTML = `<form method="dialog" id="f-rem" novalidate><h1>${nova ? T.novo : T.editarTitulo} ${q('remetente')}</h1>
    <p class="dica" style="margin:-8px 0 0">${T.privacidade}</p>
    <label class="campo"><span>${T.nome} ${REQ}</span><input name="nome" value="${esc(r.nome)}" maxlength="60" autocomplete="off" required aria-describedby="rf-nome-d"><small id="rf-nome-d">${T.nomeDica}</small></label>
    <label class="campo"><span>${T.numero} ${nova ? REQ : ''} ${q('remetente.numero')}</span><input name="numero" type="tel" inputmode="tel" autocomplete="off" ${nova ? ` placeholder="${T.numeroPh}"` : ''} aria-describedby="rf-num-d"${nova ? ' required' : ''}>
      <small id="rf-num-d">${nova ? T.numeroDica : T.numeroManter(remNumeroHtml(r.numero))}</small></label>
    <fieldset><legend>${T.destino} ${REQ} ${q('remetente.destino')} <span class="contagem" id="s-cont" aria-live="polite"></span></legend>
      <p class="dica" style="margin:0 0 8px">${T.destinoDica}</p>${destino.html}
      <small class="dica" style="display:block;margin-top:8px">${T.blocoDica}</small></fieldset>
    <label class="campo"><span>${T.etiqueta}</span><select name="tag_id" aria-describedby="rf-tag-d"><option value="">${T.etiquetaPadrao}</option>${tags}</select><small id="rf-tag-d">${T.etiquetaDica}</small></label>
    <div style="display:grid;gap:8px"><label class="campo"><span>${T.template} ${REQ}</span><select name="template_id">${opcoes(S.templates, r.template_id, 'Escolha…')}</select></label>
      <div class="linha"><a href="#templates" class="dica alvo24">${T.gerenciarTemplates}</a><a href="#docs/templates/campos" class="dica alvo24">${T.camposTemplate}</a></div>
      <span class="rotulo-campo" id="rf-loja-r">${T.previaLoja}</span>
      ${dispSegHtml('rf-loja', T.lojas, 'ml', 'rf-loja-r')}
      <div class="previa"><div class="chat" style="min-height:0"><div class="balao" id="rf-pv"></div></div><p class="legenda-previa">${T.previaLegenda}</p></div></div>
    <label class="campo"><span>${T.foto}</span><select name="enviar_foto"><option value="1">${T.fotoComFoto}</option><option value="0"${r.enviar_foto ? '' : ' selected'}>${T.fotoSoTexto}</option></select></label>
    <fieldset><legend>${T.ritmo}</legend><div class="grade" style="align-items:start">
      <label class="campo"><span>${T.maxHora} ${q('remetente.limite')}</span><input name="max_por_hora" type="number" min="1" max="60" step="1" inputmode="numeric" value="${esc(r.max_por_hora)}" aria-describedby="rf-max-d"><small id="rf-max-d">${T.maxHoraDica}</small></label>
      <label class="campo"><span>${T.repetir}</span><input name="dedupe_horas" type="number" min="0" max="8760" step="1" inputmode="numeric" value="${esc(r.dedupe_horas)}" aria-describedby="rf-rep-d"><small id="rf-rep-d">${T.repetirDica}</small></label></div>
      <small class="dica">${T.pausas} <a href="#ajustes" class="alvo24" style="text-decoration:underline">${T.ajustes}</a>.</small></fieldset>
    <div style="display:grid;gap:4px"><label class="linha opcao-chk"><input type="checkbox" name="responder"${r.responder ? ' checked' : ''} aria-describedby="rf-resp-d"><span>${T.responder} ${q('remetente.responder')}</span></label>
      <small class="dica" id="rf-resp-d">${T.responderDica}</small></div>
    ${nova ? `<div style="display:grid;gap:4px"><label class="linha opcao-chk"><input type="checkbox" name="ligar" checked aria-describedby="rf-ligar-d"><span>${T.ligarAgora}</span></label>
      <small class="dica" id="rf-ligar-d">${T.ligarDica}</small></div>` : ''}
    <div class="rodape"><span class="dica" id="rf-motivo" style="align-self:center;margin-right:auto">${semGrupos ? T.semGrupos : ''}</span><button type="button" id="rf-cancelar">${T.cancelar}</button><button class="pri" id="rf-salvar"${semGrupos ? ' disabled aria-describedby="rf-motivo"' : ''}>${nova ? T.criar : T.salvar}</button></div></form>`;

  const form = $('#f-rem', dlg); const campo = (n) => form.elements.namedItem(n);
  destino.ligar(dlg, { contador: $('#s-cont', dlg) });
  const inNum = campo('numero'); inNum.oninput = () => remAplicarMascara(inNum);

  // prévia do template com uma oferta de exemplo da loja escolhida
  let loja = 'ml'; let seq = 0; const pv = $('#rf-pv', dlg); const selTpl = campo('template_id');
  const prever = async () => {
    const n = ++seq; const tpl = S.templates.find((t) => String(t.id) === String(selTpl.value));
    if (!tpl) { pv.textContent = ''; return; }
    const amostra = loja === 'amazon' ? { ...ESP_AMOSTRA, ...(S.st?.amostras?.amazon || {}), link: ESP_LINK_PREVIA }
      : loja === 'shopee' ? { ...REM_AMOSTRA_SHOPEE } : { link: REM_LINK_ML };
    try { const res = await api('/templates/preview', 'POST', { body: tpl.body, amostra }); if (n === seq) pv.innerHTML = zap(res.texto); } catch { /* fica a prévia anterior */ }
  };
  selTpl.onchange = prever;
  dispLigarSeg($('#rf-loja', dlg), (v) => { loja = v; prever(); });
  prever();

  $('#rf-cancelar', dlg).onclick = () => dlg.close();
  form.onsubmit = tentar(async (ev) => {
    ev.preventDefault();
    const nome = String(campo('nome').value).trim(); const bruto = String(inNum.value).trim(); const digitos = digitosBR(bruto);
    const d = destino.marcados(dlg); const tplId = Number(selTpl.value) || null; const tpl = S.templates.find((t) => t.id === tplId);
    const num = (n) => { const v = String(campo(n).value).trim(); return /^\d+$/.test(v) ? Number(v) : NaN; };
    const maxHora = num('max_por_hora'); const dedupe = num('dedupe_horas');
    const erros = [];
    if (!nome) erros.push({ msg: T.erroNome, el: campo('nome') });
    else if (nome.length > 60) erros.push({ msg: T.erroNomeGrande, el: campo('nome') });
    if ((nova || bruto) && !telefoneBRValido(digitos)) erros.push({ msg: T.erroNumero, el: inNum });
    if (!d.length) erros.push({ msg: T.erroDestino, el: $('#s-gr', dlg) });
    else if (d.length > 500) erros.push({ msg: T.erroDestinoMuitos, el: $('#s-gr', dlg) });
    if (!tpl) erros.push({ msg: T.erroTemplate, el: selTpl });
    else if (!String(tpl.body).includes('{LINK}')) erros.push({ msg: T.erroLink, el: selTpl });
    if (!(maxHora >= 1 && maxHora <= 60)) erros.push({ msg: T.erroMaxHora, el: campo('max_por_hora') });
    if (!(dedupe >= 0 && dedupe <= 8760)) erros.push({ msg: T.erroRepetir, el: campo('dedupe_horas') });
    if (mostrarErros(dlg, erros)) return;
    const corpo = {
      nome, destino_jids: d, template_id: tplId, tag_id: Number(campo('tag_id').value) || null, enviar_foto: campo('enviar_foto').value === '1',
      max_por_hora: maxHora, dedupe_horas: dedupe, responder: !!campo('responder').checked,
      ...(nova ? { enabled: !!campo('ligar')?.checked } : {}),
    };
    if (bruto) corpo.numero = digitos; // na edição, vazio mantém o número salvo
    const btn = $('#rf-salvar', dlg); btn.disabled = true; btn.textContent = T.salvando;
    try { await api(nova ? '/remetentes' : `/remetentes/${Number(r.id)}`, nova ? 'POST' : 'PUT', corpo); } catch (err) {
      btn.disabled = false; btn.textContent = nova ? T.criar : T.salvar;
      const el = typeof err.campo === 'string' ? campo(err.campo) : null; // o servidor pode dizer qual campo recusou
      mostrarErros(dlg, [{ msg: err.message, el: el || undefined }]); return;
    }
    dlg.close(); aviso(nova ? (corpo.enabled ? T.criado : T.criadoDesligado) : T.salvo); await recarregarRegras();
  });
  dlg.showModal(); campo('nome').focus();
}

// ---------- Histórico: visão Remetente ----------
/** Texto e classe do resultado de um item. → { cls, texto, detalhe, extra, conexoes } */
function remResultado(it) {
  const H = TEXTOS_REMETENTE.hist; const motivo = it.motivo || H.semMotivo;
  const destinos = Array.isArray(it.destinos) ? it.destinos : []; const falhas = destinos.filter((d) => d.ok === false);
  switch (it.status) {
    case 'enviado': {
      if (falhas.length) return { cls: 'nivel-erro', texto: H.erroGrupos(falhas.length), detalhe: '', extra: falhas.map((d) => `${d.nome}${d.erro ? ': ' + d.erro : ''}`), conexoes: false };
      const det = Object.hasOwn(H.detalhe, it.fonte_dados) ? H.detalhe[it.fonte_dados] : '';
      const saindo = destinos.some((d) => d.ok == null);
      return { cls: 'nivel-ok', texto: H.enviada, detalhe: [det, saindo ? H.enviando : ''].filter(Boolean).join(' · '), extra: [], conexoes: false };
    }
    case 'duplicado': case 'descartado': return { cls: 'nivel-aviso', texto: H.descartada(motivo), detalhe: '', extra: [], conexoes: false };
    case 'erro': {
      const afiliacao = REM_AFILIACAO.has(it.codigo);
      return { cls: afiliacao ? 'nivel-aviso' : 'nivel-erro', texto: H.naoSaiu(motivo), detalhe: '', extra: [], conexoes: afiliacao };
    }
    default: return { cls: 'nivel-aviso', texto: H.processando, detalhe: '', extra: [], conexoes: false };
  }
}
/** Título da oferta; sem ele, o nome da loja; nunca o texto da mensagem do remetente. */
function remTituloItem(it) {
  const H = TEXTOS_REMETENTE.hist;
  if (it.oferta?.title) return String(it.oferta.title);
  return Object.hasOwn(H.produto, it.loja) ? H.produto[it.loja] : H.semLink;
}
function remLinhaHtml(it) {
  const H = TEXTOS_REMETENTE.hist; const r = remResultado(it); const titulo = remTituloItem(it);
  const destinos = Array.isArray(it.destinos) ? it.destinos : []; const nomes = destinos.map((d) => String(d.nome ?? ''));
  const grupo = !destinos.length ? '—' : destinos.length === 1 ? `<span class="trunca" title="${esc(nomes[0])}">${esc(nomes[0])}</span>`
    : `<span title="${esc(nomes.join(', '))}">${espN(destinos.length, 'grupo', 'grupos')}</span>`;
  const quem = it.remetente_nome || H.semRemetente;
  const conexoes = r.conexoes ? `<span class="dica-celula"><a href="#conexoes" class="alvo24" style="text-decoration:underline">${TEXTOS_REMETENTE.verConexoes}</a></span>` : '';
  // classes esp-* : o mesmo arranjo em cartão da tabela do espelhamento em telas estreitas (style.css)
  return `<tr data-item="${Number(it.id)}"><td class="esp-quando" style="white-space:nowrap">${hora(it.decidido_em || it.ts)}</td>
    <td class="esp-regra" data-l="${H.rotulosCelula.remetente}"><span class="trunca" title="${esc(quem)}">${esc(quem)}</span></td>
    <td class="esp-destino" data-l="${H.rotulosCelula.grupo}">${grupo}</td>
    <td class="esp-oferta"><span class="trunca" title="${esc(titulo)}">${esc(titulo)}</span></td>
    <td class="esp-resultado"><span class="${r.cls}">${esc(r.texto)}</span>${r.detalhe ? `<span class="dica-celula">${esc(r.detalhe)}</span>` : ''}${r.extra.map((x) => `<span class="dica-celula">${esc(x)}</span>`).join('')}${conexoes}</td></tr>`;
}
/** KPIs das últimas 24 h (do remetente filtrado, ou de todos). "Descartados" soma os repetidos. */
function remKpisHtml(live) {
  const H = TEXTOS_REMETENTE.hist; const info = REM.info; if (!info) return '';
  const regra = REM_H.regra ? REM.lista.find((x) => String(x.id) === String(REM_H.regra)) : null;
  const c = (regra ? regra.contadores_24h : info.totais_24h) || {}; const n = (k) => Number(c[k]) || 0;
  const kpi = (rotulo, valor) => `<div class="kpi"><div class="rotulo">${rotulo}</div><div class="valor">${valor}</div><div class="nota">${H.ultimas24}</div></div>`;
  return `<div class="kpis esp-kpis"${live ? ' aria-live="polite"' : ''}>${kpi(H.enviados, n('enviados'))}${kpi(H.descartados, n('descartados') + n('repetidos'))}${kpi(H.comErro, n('com_erro'))}</div>`;
}
function remCorpoHtml(live) {
  const H = TEXTOS_REMETENTE.hist;
  let lista;
  if (!REM_H.itens.length) lista = `<div class="vazio">${REM_H.regra && REM.lista.length ? H.vazioFiltro : H.vazio}</div>`;
  else {
    lista = `<div class="card tabela esp-tab"><table><thead><tr>${H.colunas.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead><tbody id="rh-linhas">${REM_H.itens.map(remLinhaHtml).join('')}</tbody></table></div>
      <p class="dica" role="status" id="rh-contagem" style="margin:10px 0 0">${REM_H.fim ? H.fim(REM_H.itens.length) : H.mostrando(REM_H.itens.length)}</p>
      <div class="linha" style="margin-top:8px"><button type="button" id="rh-mais"${REM_H.fim ? ' hidden' : ''}>${H.mostrarMais}</button></div>`;
  }
  return remKpisHtml(live) + lista;
}
const remConsulta = (antes) => {
  const p = new URLSearchParams({ limite: String(REM_PAGINA) });
  if (REM_H.regra) p.set('remetente', REM_H.regra);
  if (antes) p.set('antes', String(antes));
  return `/remetentes/itens?${p}`;
};

/** Visão Remetente do Histórico (`#historico?tipo=remetente&regra=<id>`). Atualiza a cada 6 s, sem repintar com o dialog aberto. */
async function paginaHistoricoRemetente(params) {
  const H = TEXTOS_REMETENTE.hist; const ger = ++ESP_H.ger; // o mesmo contador das outras visões: resposta de outra visão não pinta aqui
  REM_H.regra = /^\d+$/.test(params?.get('regra') || '') ? params.get('regra') : '';
  REM_H.itens = []; REM_H.fim = false;
  clearTimeout(paginaHistorico.t);
  $('#pagina').innerHTML = `<div class="topo"><div><h1>${H.titulo} ${q('historico')}</h1><p class="sub">${H.sub}</p></div>
      <div class="linha">${histTipoHtml('remetente')}</div></div>
    <div id="rh-filtros" class="linha" style="margin-bottom:12px"></div>
    <div id="rh-corpo"><p class="dica">${H.carregando}</p></div>`;
  histLigarTipo();
  const corpo = $('#rh-corpo'); const ativa = () => ger === ESP_H.ger && rotaAtual() === 'historico';
  const filtros = () => {
    $('#rh-filtros').innerHTML = `<label class="campo" style="min-width:200px"><span>${H.regra}</span><select id="rh-regra"><option value="">${H.todos}</option>${REM.lista.map((r) => `<option value="${Number(r.id)}"${String(r.id) === REM_H.regra ? ' selected' : ''}>${esc(r.nome)}</option>`).join('')}</select></label>`;
    $('#rh-regra').onchange = (ev) => histIr({ tipo: 'remetente', regra: ev.target.value });
  };
  let pintado = ''; // o corpo da última pintura, sem aria-live: compara com o das atualizações automáticas
  // Atualização automática: não repinta com o foco dentro do corpo (o foco se perderia) nem quando nada mudou
  // (o aria-live repetiria os KPIs). Só a primeira pintura anuncia; as seguintes não levam aria-live.
  const pintar = (auto) => {
    const html = remCorpoHtml(false);
    if (auto && (html === pintado || corpo.contains(document.activeElement))) return;
    pintado = html; corpo.innerHTML = auto ? html : remCorpoHtml(true); const mais = $('#rh-mais');
    if (mais) mais.onclick = tentar(() => remMostrarMais(ger));
  };
  const carregar = async (primeira) => {
    try {
      const [info, itens] = await Promise.all([api('/remetentes'), api(remConsulta())]);
      if (!ativa()) return;
      REM.lista = Array.isArray(info?.remetentes) ? info.remetentes : []; REM.info = info; REM.erro = '';
      const novos = Array.isArray(itens) ? itens : [];
      if (primeira) filtros();
      if (novos.length < REM_PAGINA) { REM_H.itens = novos; REM_H.fim = true; } else {
        // a primeira página do servidor substitui as que já estão na tela; o que for mais velho que ela continua
        const menor = novos.at(-1).id; REM_H.itens = [...novos, ...REM_H.itens.filter((x) => x.id < menor)];
        if (primeira) REM_H.fim = false;
      }
      pintar(!primeira);
    } catch {
      if (!ativa() || !primeira) return; // numa atualização automática que falha, fica o que já está na tela
      filtros();
      corpo.innerHTML = `<div class="vazio" role="alert">${H.erroCarregar}<div style="margin-top:12px"><button type="button" id="rh-de-novo">${H.tentarDeNovo}</button></div></div>`;
      $('#rh-de-novo').onclick = () => histIr({ tipo: 'remetente', regra: REM_H.regra });
    }
  };
  await carregar(true);
  const agenda = () => {
    clearTimeout(paginaHistorico.t);
    paginaHistorico.t = setTimeout(async () => {
      if (!ativa()) return;
      if (!$('#dlg').open && !REM_H.carregandoMais) await carregar(false);
      agenda();
    }, 6000);
  };
  agenda();
}

/** "Mostrar mais": busca a página seguinte (cursor = id do último item da tela) e acrescenta as linhas, sem refazer a tabela. */
async function remMostrarMais(ger) {
  const H = TEXTOS_REMETENTE.hist; const ultimo = REM_H.itens.at(-1); const btn = $('#rh-mais');
  if (!ultimo || !btn || REM_H.carregandoMais) return;
  REM_H.carregandoMais = true; btn.disabled = true; btn.textContent = H.carregandoMais;
  try {
    const mais = await api(remConsulta(ultimo.id));
    if (ger !== ESP_H.ger) return;
    const novos = Array.isArray(mais) ? mais : [];
    REM_H.itens = [...REM_H.itens, ...novos]; if (novos.length < REM_PAGINA) REM_H.fim = true;
    $('#rh-linhas').insertAdjacentHTML('beforeend', novos.map(remLinhaHtml).join(''));
    $('#rh-contagem').textContent = REM_H.fim ? H.fim(REM_H.itens.length) : H.mostrando(REM_H.itens.length);
    btn.hidden = REM_H.fim;
  } finally { REM_H.carregandoMais = false; btn.disabled = false; btn.textContent = H.mostrarMais; }
}
