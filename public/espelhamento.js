// Espelhamento de ofertas da Amazon: cartão e formulário (Disparo automático), visão Espelhamento do Histórico
// (KPIs, tabela, "Mostrar mais") e o dialog "Completar" da fila.
// Spec: docs/produto/specs/espelhamento-amazon.md. Plano: docs/produto/planos/espelhamento-amazon.md (etapa 12).
// Rotas: GET/POST /api/espelhos, PUT/DELETE /api/espelhos/:id, POST /api/espelhos/:id/enabled,
// GET /api/espelhos/itens, POST /api/espelhos/itens/:id/enviar e /descartar.
// Também a visão Catálogo do Histórico e o dialog "Revisar oferta" da fonte Catálogo (spec fonte-catalogo-etiqueta,
// seção 3), que reaproveita o miolo do "Completar" (espDialogOferta). Rotas: GET /api/catalogo/itens,
// POST /api/catalogo/itens/:id/enviar e /descartar (os dois só do Dono).
// Carrega depois de disparos.js e antes de app.js: só define funções e constantes (prefixo Esp/ESP/esp/hist, para não
// colidir no escopo global dos scripts clássicos). Os utilitários de app.js ($, $$, esc, zap, S, api, aviso, REQ, opcoes,
// mostrarErros, seletorGrupos, hora, q, paginaHistorico, rotaAtual) e de disparos.js (dadosOferta, dispApi, dispSegHtml,
// dispLigarSeg) só são usados quando as telas abrem.
// Nunca aparece aqui o texto da mensagem de origem, número nem nome de participante: o servidor não os manda.

const TEXTOS_ESPELHAMENTO = {
  novo: 'Novo espelhamento', criar: 'Criar espelhamento', editarTitulo: 'Editar espelhamento',
  chip: 'Espelhamento',
  verRegistro: 'Ver registro', editar: 'Editar', excluir: 'Excluir', salvar: 'Salvar', cancelar: 'Cancelar', salvando: 'Salvando…',
  pausado: 'Pausado',
  semGrupos: 'Conecte o WhatsApp em Números de WhatsApp para escolher os grupos.',
  naoCarregouLista: (msg) => `Não consegui carregar os espelhamentos: ${msg}`,
  confirmaExcluir: (nome) => `Excluir o espelhamento “${nome}”? O que já foi enviado continua no Histórico.`,
  criado: 'Espelhamento criado', criadoDesligado: 'Espelhamento criado, desligado', salvo: 'Espelhamento salvo', ligado: 'Espelhamento ligado', pausadoAviso: 'Espelhamento pausado', excluido: 'Espelhamento excluído',
  // formulário
  nome: 'Nome', nomeDica: 'Ex.: Eletrônicos do grupo X',
  origem: 'Grupos de origem', origemDica: 'Só aparecem grupos em que o número conectado está.', buscaOrigem: 'Buscar grupo de origem',
  proprias: 'Espelhar também mensagens enviadas pelo meu número',
  propriasDica: 'Use se um dos grupos de origem é seu. Desligado, só o que os outros participantes postam é espelhado.',
  destino: 'Grupos de destino', buscaDestino: 'Buscar grupo de destino',
  template: 'Template', gerenciarTemplates: 'Gerenciar templates',
  previaCompleta: 'Completa', previaSemAntigo: 'Sem preço antigo e sem cupom',
  previaLegenda: 'Exemplo. Linha sem valor some sozinha; se faltar só o desconto, só ele some.',
  campos: 'Campos que você pode usar no template',
  palavras: 'Palavras bloqueadas', palavrasDica: 'Uma por linha ou separadas por vírgula. Não diferencia maiúscula, minúscula nem acento: “usado” também barra “Usádo”. Se o título ou a mensagem tiver uma delas, a oferta não é enviada e aparece como descartada no Histórico.',
  palavrasPlaceholder: 'usado\nrecondicionado\nvitrine',
  palavrasN: (n) => (n === 0 ? 'Nenhuma palavra bloqueada' : n === 1 ? '1 palavra' : `${n} palavras`),
  semPreco: 'Quando faltar o preço', semPrecoFila: 'Esperar eu completar (fica na fila do Histórico)', semPrecoCurto: 'Enviar mesmo assim, no formato curto',
  ritmo: 'Ritmo de envio',
  repetir: 'Não repetir a mesma oferta por (horas)', repetirDica: '0 = pode repetir. A mesma oferta é o mesmo produto da Amazon, mesmo com link diferente.',
  maxHora: 'No máximo por hora', maxHoraDica: '0 = sem limite. Acima disso a oferta espera a próxima hora livre.',
  funcionaDas: 'Funciona das', ate: 'Até', janelaDica: 'Opcional. Fora desse horário as ofertas esperam e saem quando abrir.',
  foto: 'Foto do produto', fotoComFoto: 'Enviar com foto, quando houver', fotoSoTexto: 'Só texto',
  semTagAviso: 'Falta a tag de associado da Amazon. Sem ela o espelhamento não liga: você pode salvar desligado.', cadastrarEmConexoes: 'Cadastre em Conexões.',
  ligarAgora: 'Ligar o espelhamento ao criar', ligarDica: 'Desligado, ele fica salvo e você liga depois, no cartão.',
  ligarSemTag: 'Sem a tag de associado da Amazon o espelhamento só pode ser salvo desligado. Cadastre a tag em Conexões para ligar.',
  soTextoAviso: 'A API da Amazon não está configurada. As ofertas vão sair com o título e os preços que estiverem escritos na mensagem de origem.',
  erroNome: 'Dê um nome ao espelhamento.',
  erroOrigem: 'Marque ao menos um grupo de origem.', erroDestino: 'Marque ao menos um grupo de destino.',
  erroAmbos: (nomes) => `Um grupo não pode ser origem e destino ao mesmo tempo: ${nomes}.`,
  erroTemplate: 'Escolha um template.', erroLink: 'O template precisa do campo {LINK}.',
  erroRepetir: 'Horas sem repetir: use de 0 a 8760.', erroMaxHora: 'Máximo por hora: use de 0 a 60 (0 = sem limite).',
  erroJanela: 'Preencha o início e o fim do horário, ou deixe os dois em branco.',
  erroPalavraGrande: 'Uma palavra bloqueada tem mais de 60 caracteres.', erroPalavrasMuitas: 'Use até 50 palavras bloqueadas.',
  // Histórico
  hist: {
    titulo: 'Histórico', sub: 'Tudo que foi enviado e tudo que deu errado, com o motivo.',
    tipo: 'Tipo', tudo: 'Tudo', automatico: 'Disparo automático', espelhamento: 'Espelhamento', remetente: 'Remetente',
    regra: 'Regra', todasRegras: 'Todos os espelhamentos', resultado: 'Mostrar', todosResultados: 'Tudo', soFila: 'Só o que está na fila',
    ultimas24: 'Últimas 24 h', espelhadas: 'Espelhadas', descartadas: 'Descartadas', naFila: 'Na fila', precisamDeVoce: 'Precisam de você',
    carregando: 'Carregando…',
    erroCarregar: 'Não consegui carregar o histórico. Tente de novo.', tentarDeNovo: 'Tentar de novo',
    vazio: 'Nenhuma oferta espelhada ainda. Crie um espelhamento em <a href="#disparo-automatico">Disparo automático</a>.',
    vazioFiltro: 'Nada com este filtro.',
    colunas: ['Quando', 'Regra', 'Grupo de origem', 'Destino', 'Oferta', 'Resultado'],
    rotulosCelula: { regra: 'Regra', origem: 'Origem', destino: 'Destino' },
    mostrarMais: 'Mostrar mais', carregandoMais: 'Carregando…',
    mostrando: (n) => `Mostrando ${n} ${n === 1 ? 'oferta' : 'ofertas'}.`, fim: (n) => `Mostrando todas as ${n} ${n === 1 ? 'oferta' : 'ofertas'}.`,
    completar: 'Completar', verNaAmazon: 'Ver na Amazon (abre em outra aba)',
    produto: (asin) => `Produto ${asin}`, linkAmazon: 'Link da Amazon', semOrigem: '—', semRegra: '(espelhamento apagado)',
    espelhada: 'Espelhada', aguardando: 'Aguardando', processando: 'Processando…', enviando: 'enviando…',
    detalhe: { api: 'com dados da Amazon', 'api+texto': 'com dados da Amazon e do texto da origem', texto: 'com o texto da origem', curto: 'no formato curto', manual: 'completada à mão' },
  },
  // Completar
  completar: {
    titulo: 'Completar oferta', sub: (origem, regra) => `Veio de ${origem || 'um grupo de origem'}, pelo espelhamento “${regra}”. Confira os dados e envie, ou descarte.`,
    enviar: (n) => `Enviar para ${n} ${n === 1 ? 'grupo' : 'grupos'}`, enviando: 'Enviando…', descartar: 'Descartar', fechar: 'Fechar',
    confirmaDescartar: 'Descartar esta oferta? Ela não será enviada.',
    faltaPreco: 'Preencha o preço atual.', avisoPrefixo: 'Atenção:', enviada: (n) => `Oferta enviada para ${n} ${n === 1 ? 'grupo' : 'grupos'}`, descartada: 'Oferta descartada',
    previa: 'Como vai aparecer', previaLegenda: 'Com o template do espelhamento. O link sai limpo, com a sua tag, na hora do envio.', semTemplate: 'O template deste espelhamento não existe mais. Edite o espelhamento.',
  },
};

/** Amostra de uma oferta da Amazon para a prévia (cópia de SAMPLE_OFFER_AMAZON, src/template.js; o servidor manda a sua em /api/state.amostras.amazon). */
const ESP_AMOSTRA = {
  title: 'Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades', price: 1310.05, oldPrice: 1999, discountPct: 34,
  sold: 200, freeShipping: true, coupon: 'DESEJO10',
};
const ESP_LINK_PREVIA = 'https://www.amazon.com.br/dp/B0FG2MD49G?tag=•••';

// Estado da tela: lista de espelhamentos (Disparo automático e Histórico) e da visão Espelhamento do Histórico.
const ESP = { lista: [], info: null, erro: '' };
const ESP_H = { ger: 0, itens: [], fim: false, regra: '', status: '', carregandoMais: false };
const ESP_PAGINA = 50; // o servidor devolve no máximo 50 por pedido

const ESP_GRUPO_REMOVIDO = '(grupo removido)'; // o que o servidor escreve em *_nomes quando o grupo não está mais na lista
/** Quantos grupos recebem de fato: os destinos da regra menos os que sumiram da lista de grupos. */
const espDestinosAtivos = (regra) => (Array.isArray(regra?.destinos_nomes)
  ? regra.destinos_nomes.filter((n) => n !== ESP_GRUPO_REMOVIDO).length : (regra?.destino_jids?.length ?? 0));
const espN = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
/** Nome de grupo com reticências e `title` (para caber no resumo do cartão). */
const espNomeCurto = (nome) => `<span class="nome-grupo" title="${esc(nome)}">${esc(nome)}</span>`;

/** Lê GET /api/espelhos para ESP. Falha (rota ainda ausente, servidor fora) vira texto em ESP.erro, nunca exceção. */
async function carregarEspelhos() {
  try {
    const r = await api('/espelhos');
    ESP.lista = Array.isArray(r?.espelhos) ? r.espelhos : []; ESP.info = r; ESP.erro = '';
  } catch (e) { ESP.erro = e.message || 'erro'; }
}

// ---------- cartão (Disparo automático) ----------
function resumoEspelhamento(e) {
  const T = TEXTOS_ESPELHAMENTO;
  const o = e.origem_jids?.length ?? 0; const d = e.destino_jids?.length ?? 0;
  const de = o === 1 && e.origens_nomes?.[0] ? espNomeCurto(e.origens_nomes[0]) : espN(o, 'grupo', 'grupos');
  const para = d === 1 && e.destinos_nomes?.[0] ? espNomeCurto(e.destinos_nomes[0]) : espN(d, 'grupo', 'grupos');
  const partes = [`De ${de} para ${para}.`, `Template: ${esc(e.template_nome || '—')}.`,
    e.dedupe_horas > 0 ? `Repetida: não reenvia em ${e.dedupe_horas} h.` : 'Repetida: pode reenviar.',
    e.max_por_hora > 0 ? `Até ${e.max_por_hora} por hora.` : 'Sem limite por hora.'];
  if (e.janela_inicio && e.janela_fim) partes.push(`Das ${esc(e.janela_inicio)} às ${esc(e.janela_fim)}.`);
  partes.push(e.sem_preco === 'curto' ? 'Sem preço: envia no formato curto.' : 'Sem preço: espera você completar.');
  return partes.join(' ');
}
function espNumeros(e) {
  const c = e.contadores_24h || {};
  return `Últimas 24 h: ${espN(c.espelhadas || 0, 'espelhada', 'espelhadas')}, ${espN(c.descartadas || 0, 'descartada', 'descartadas')}, ${c.na_fila || 0} na fila.`;
}
/** Endereço do Histórico filtrado (tipo Espelhamento; por regra; opcionalmente só a fila). */
const espEndereco = (id, soFila) => `#historico?tipo=espelhamento&regra=${id}${soFila ? '&status=na_fila' : ''}`;
function cartaoEspelhamento(e) {
  const T = TEXTOS_ESPELHAMENTO; const fila = e.contadores_24h?.na_fila || 0;
  return `<article class="card regra" data-esp-id="${e.id}">
    <h2><label class="chave" title="Ligar ou pausar"><input type="checkbox" data-act="esp-ligar" ${e.enabled ? 'checked' : ''} aria-label="${esc(`Espelhamento “${e.nome}” ativo`)}"><span></span></label>
      ${esc(e.nome)} <span class="chip">${T.chip}</span>${fila > 0 ? ` <a class="chip chip-link chip-toque" href="${espEndereco(e.id, true)}" title="Ver as ofertas que esperam você completar">${fila} na fila</a>` : ''}</h2>
    <p class="res">${resumoEspelhamento(e)}</p>
    ${e.problema ? `<p class="nivel-erro aviso-cartao"><b>${T.avisoPrefixo}</b> ${esc(e.problema)}</p>` : ''}
    <div class="prox">${e.enabled ? '' : T.pausado + '. '}${espNumeros(e)}</div>
    <div class="acoes">
      <button class="pri" data-act="esp-registro">${T.verRegistro}</button>
      <button data-act="esp-editar" aria-label="Editar espelhamento ${esc(e.nome)}">${T.editar}</button>
      <button data-act="esp-excluir" class="perigo leve" aria-label="Excluir espelhamento ${esc(e.nome)}">${T.excluir}</button></div></article>`;
}
/** Cartões dos espelhamentos (e a linha de erro, se a lista não carregou), para a lista mista de paginaRegras. */
function cartoesEspelhamento() {
  const erro = ESP.erro ? `<p class="dica" role="status">${esc(TEXTOS_ESPELHAMENTO.naoCarregouLista(ESP.erro))}</p>` : '';
  return erro + ESP.lista.map(cartaoEspelhamento).join('');
}
/** Cliques de data-act="esp-…" da lista de Disparo automático. Lança erro (o chamador mostra o toast). */
async function espelhamentoAcao(b) {
  const T = TEXTOS_ESPELHAMENTO; const id = Number(b.closest('[data-esp-id]')?.dataset.espId); const e = ESP.lista.find((x) => x.id === id); const act = b.dataset.act;
  if (!e) return;
  if (act === 'esp-ligar') {
    try { await api(`/espelhos/${id}/enabled`, 'POST', { enabled: b.checked }); } catch (err) { b.checked = !b.checked; throw err; }
    aviso(b.checked ? T.ligado : T.pausadoAviso); await recarregarRegras();
  }
  if (act === 'esp-registro') location.hash = espEndereco(id, false);
  if (act === 'esp-editar') formEspelhamento(e);
  if (act === 'esp-excluir' && confirm(T.confirmaExcluir(e.nome))) { await api(`/espelhos/${id}`, 'DELETE'); aviso(T.excluido); await recarregarRegras(); }
}

// ---------- formulário "Novo espelhamento" / "Editar espelhamento" ----------
const espPalavrasDe = (txt) => String(txt || '').split(/[\n,;]/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);

function formEspelhamento(e) {
  const T = TEXTOS_ESPELHAMENTO; const nova = !e; const dlg = $('#dlg');
  const padraoTpl = S.templates.find((t) => t.name === 'Amazon')?.id ?? S.templates[0]?.id ?? null;
  e = e || { nome: '', enabled: true, origem_jids: [], destino_jids: [], template_id: padraoTpl, incluir_minhas: false, dedupe_horas: 168,
    palavras_bloqueadas: [], sem_preco: 'fila', max_por_hora: 10, janela_inicio: null, janela_fim: null, enviar_foto: true };
  const origem = seletorGrupos({ selecionados: e.origem_jids, prefixo: 'o-', rotuloBusca: T.buscaOrigem });
  const destino = seletorGrupos({ selecionados: e.destino_jids, prefixo: 'd-', rotuloBusca: T.buscaDestino });
  const semGrupos = !S.groups.length;
  const palavras = Array.isArray(e.palavras_bloqueadas) ? e.palavras_bloqueadas.join('\n') : String(e.palavras_bloqueadas || '');
  const placeholders = (S.st?.placeholders || []).map((p) => `<li><code>{${esc(p)}}</code> ${esc(typeof DICAS_PLACEHOLDERS === 'object' ? DICAS_PLACEHOLDERS[p] || '' : '')}</li>`).join('');
  dlg.innerHTML = `<form method="dialog" id="f-esp" novalidate><h1>${nova ? T.novo : T.editarTitulo}</h1>
    <label class="campo"><span>${T.nome} ${REQ}</span><input name="nome" value="${esc(e.nome)}" maxlength="80" autocomplete="off" required><small>${T.nomeDica}</small></label>
    <div id="ef-aviso" aria-live="polite"></div>
    <fieldset><legend>${T.origem} ${REQ} ${q('espelhamento.origem')} <span class="contagem" id="o-cont"></span></legend>
      <p class="dica" style="margin:0 0 8px">${T.origemDica}</p>${origem.html}</fieldset>
    <div style="display:grid;gap:4px"><label class="linha opcao-chk"><input type="checkbox" name="incluir_minhas" ${e.incluir_minhas ? 'checked' : ''} aria-describedby="ef-proprias-dica"><span>${T.proprias} ${q('espelhamento.proprias')}</span></label>
      <small class="dica" id="ef-proprias-dica">${T.propriasDica}</small></div>
    <fieldset><legend>${T.destino} ${REQ} <span class="contagem" id="d-cont"></span></legend>${destino.html}</fieldset>
    <div style="display:grid;gap:8px"><label class="campo"><span>${T.template} ${REQ}</span><select name="template_id">${opcoes(S.templates, e.template_id, 'Escolha…')}</select></label>
      <a href="#templates" class="dica alvo24" style="justify-self:start">${T.gerenciarTemplates}</a>
      <span class="rotulo-campo" id="ef-variante-r">Exemplo da prévia</span>
      ${dispSegHtml('ef-variante', [['completa', T.previaCompleta], ['sem', T.previaSemAntigo]], 'completa', 'ef-variante-r')}
      <div class="previa"><div class="chat" style="min-height:0"><div class="balao" id="ef-pv"></div></div><p class="legenda-previa">${T.previaLegenda}</p></div>
      <details><summary>${T.campos}</summary><p class="dica" style="margin:8px 0 0">${typeof DICA_OPCIONAL === 'string' ? DICA_OPCIONAL : ''}</p><ul style="margin:8px 0 0;padding-left:20px">${placeholders}</ul></details></div>
    <label class="campo"><span>${T.palavras} ${q('espelhamento.bloqueadas')}</span><textarea name="palavras" class="mono" rows="4" placeholder="${esc(T.palavrasPlaceholder)}" aria-describedby="ef-palavras-dica ef-palavras-n">${esc(palavras)}</textarea>
      <small id="ef-palavras-dica">${T.palavrasDica}</small><small id="ef-palavras-n" aria-live="polite"></small></label>
    <label class="campo"><span>${T.semPreco} ${q('espelhamento.fila')}</span><select name="sem_preco"><option value="fila">${T.semPrecoFila}</option><option value="curto" ${e.sem_preco === 'curto' ? 'selected' : ''}>${T.semPrecoCurto}</option></select></label>
    <fieldset><legend>${T.ritmo}</legend><div class="grade" style="align-items:start">
      <label class="campo"><span>${T.repetir} ${q('espelhamento.repetir')}</span><input name="dedupe_horas" type="number" min="0" max="8760" value="${esc(e.dedupe_horas)}"><small>${T.repetirDica}</small></label>
      <label class="campo"><span>${T.maxHora}</span><input name="max_por_hora" type="number" min="0" max="60" value="${esc(e.max_por_hora)}"><small>${T.maxHoraDica}</small></label>
      <label class="campo"><span>${T.funcionaDas}</span><input name="janela_inicio" type="time" value="${esc(e.janela_inicio || '')}"></label>
      <label class="campo"><span>${T.ate}</span><input name="janela_fim" type="time" value="${esc(e.janela_fim || '')}"></label>
      <label class="campo"><span>${T.foto}</span><select name="enviar_foto"><option value="1">${T.fotoComFoto}</option><option value="0" ${e.enviar_foto ? '' : 'selected'}>${T.fotoSoTexto}</option></select></label></div>
      <small class="dica">${T.janelaDica}</small></fieldset>
    ${nova ? `<div style="display:grid;gap:4px"><label class="linha opcao-chk"><input type="checkbox" name="ligar" checked aria-describedby="ef-ligar-dica"><span>${T.ligarAgora}</span></label>
      <small class="dica" id="ef-ligar-dica">${T.ligarDica}</small></div>` : ''}
    <div class="rodape"><span class="dica" id="ef-motivo" style="align-self:center;margin-right:auto">${semGrupos ? T.semGrupos : ''}</span><button type="button" id="ef-cancelar">${T.cancelar}</button><button class="pri" id="ef-salvar" ${semGrupos ? 'disabled' : ''}>${nova ? T.criar : T.salvar}</button></div></form>`;

  const form = $('#f-esp', dlg);
  origem.ligar(dlg, { contador: $('#o-cont', dlg) }); destino.ligar(dlg, { contador: $('#d-cont', dlg) });
  const campo = (n) => form.elements.namedItem(n);

  // aviso de conexão da Amazon (ao vivo, sem bloquear)
  api('/conexoes').then((lista) => {
    const am = Array.isArray(lista) ? lista.find((c) => c.id === 'amazon') : null; const box = $('#ef-aviso', dlg); if (!am || !box) return;
    if (am.estado === 'falta_configurar') {
      box.innerHTML = `<div class="aviso-impl"><p>${T.semTagAviso} <a href="#conexoes" class="alvo24" style="text-decoration:underline">${T.cadastrarEmConexoes}</a></p></div>`;
      // sem tag o espelhamento só pode ser criado desligado (o servidor também recusa ligar)
      const ligar = campo('ligar');
      if (ligar) { ligar.checked = false; ligar.disabled = true; const dica = $('#ef-ligar-dica', dlg); if (dica) dica.textContent = T.ligarSemTag; }
    }
    else if (am.estado === 'so_tag') box.innerHTML = `<div class="aviso-impl"><p>${T.soTextoAviso} ${q('espelhamento.formato')} <a href="#conexoes" class="alvo24" style="text-decoration:underline">Ver em Conexões.</a></p></div>`;
  }).catch(() => {});

  // contador de palavras
  const inPalavras = campo('palavras'); const nPal = $('#ef-palavras-n', dlg);
  const contaPalavras = () => { nPal.textContent = T.palavrasN(espPalavrasDe(inPalavras.value).length); };
  inPalavras.oninput = contaPalavras; contaPalavras();

  // prévia do template, com a oferta de exemplo da Amazon (a variante "sem" tira preço antigo, desconto e cupom)
  let variante = 'completa'; let seq = 0; const pv = $('#ef-pv', dlg); const selTpl = campo('template_id');
  const prever = async () => {
    const n = ++seq; const tpl = S.templates.find((t) => String(t.id) === selTpl.value);
    if (!tpl) { pv.textContent = ''; return; }
    const base = { ...ESP_AMOSTRA, ...(S.st?.amostras?.amazon || {}), link: ESP_LINK_PREVIA };
    const amostra = variante === 'sem' ? { ...base, oldPrice: null, discountPct: 0, coupon: '' } : base;
    try { const r = await api('/templates/preview', 'POST', { body: tpl.body, amostra }); if (n === seq) pv.innerHTML = zap(r.texto); } catch { /* fica a prévia anterior */ }
  };
  selTpl.onchange = prever;
  dispLigarSeg($('#ef-variante', dlg), (v) => { variante = v; prever(); });
  prever();

  $('#ef-cancelar', dlg).onclick = () => dlg.close();
  form.onsubmit = tentar(async (ev) => {
    ev.preventDefault();
    const nome = campo('nome').value.trim(); const o = origem.marcados(dlg); const d = destino.marcados(dlg);
    const tplId = Number(selTpl.value) || null; const tpl = S.templates.find((t) => t.id === tplId);
    const palavrasLista = espPalavrasDe(inPalavras.value);
    const num = (n) => { const v = String(campo(n).value).trim(); return /^\d+$/.test(v) ? Number(v) : NaN; };
    const dedupe = num('dedupe_horas'); const maxHora = num('max_por_hora');
    const ini = campo('janela_inicio').value; const fim = campo('janela_fim').value;
    const erros = [];
    if (!nome) erros.push({ msg: T.erroNome, el: campo('nome') });
    if (!o.length) erros.push({ msg: T.erroOrigem, el: $('#o-gr', dlg) });
    if (!d.length) erros.push({ msg: T.erroDestino, el: $('#d-gr', dlg) });
    const ambos = o.filter((j) => d.includes(j));
    if (ambos.length) erros.push({ msg: T.erroAmbos(ambos.slice(0, 3).map((j) => S.groups.find((g) => g.jid === j)?.name || 'sem nome').join(', ')), el: $('#d-gr', dlg) });
    if (!tpl) erros.push({ msg: T.erroTemplate, el: selTpl });
    else if (!String(tpl.body).includes('{LINK}')) erros.push({ msg: T.erroLink, el: selTpl });
    if (!(dedupe >= 0 && dedupe <= 8760)) erros.push({ msg: T.erroRepetir, el: campo('dedupe_horas') });
    if (!(maxHora >= 0 && maxHora <= 60)) erros.push({ msg: T.erroMaxHora, el: campo('max_por_hora') });
    if (!ini !== !fim) erros.push({ msg: T.erroJanela, el: campo(ini ? 'janela_fim' : 'janela_inicio') });
    if (palavrasLista.some((p) => p.length > 60)) erros.push({ msg: T.erroPalavraGrande, el: inPalavras });
    else if (palavrasLista.length > 50) erros.push({ msg: T.erroPalavrasMuitas, el: inPalavras });
    if (mostrarErros(dlg, erros)) return;
    const corpo = {
      nome, origem_jids: o, destino_jids: d, template_id: tplId, incluir_minhas: campo('incluir_minhas').checked, dedupe_horas: dedupe,
      palavras_bloqueadas: palavrasLista, sem_preco: campo('sem_preco').value, max_por_hora: maxHora,
      janela_inicio: ini || null, janela_fim: fim || null, enviar_foto: campo('enviar_foto').value === '1',
      ...(nova ? { enabled: !!campo('ligar')?.checked } : {}),
    };
    const btn = $('#ef-salvar', dlg); btn.disabled = true; btn.textContent = T.salvando;
    try { await api(nova ? '/espelhos' : `/espelhos/${e.id}`, nova ? 'POST' : 'PUT', corpo); } catch (err) {
      btn.disabled = false; btn.textContent = nova ? T.criar : T.salvar; mostrarErros(dlg, [{ msg: err.message }]); return;
    }
    dlg.close(); aviso(nova ? (corpo.enabled ? T.criado : T.criadoDesligado) : T.salvo); await recarregarRegras();
  });
  dlg.showModal(); campo('nome').focus();
}

// ---------- Histórico: seletor "Tipo" (compartilhado com a visão de sempre) ----------
/** HTML do seletor "Tipo" (Tudo | Disparo automático | Espelhamento | Catálogo | Remetente). Ligue com histLigarTipo(). */
function histTipoHtml(tipo) {
  const H = TEXTOS_ESPELHAMENTO.hist;
  return `<span class="rotulo-campo" id="hs-tipo-r">${H.tipo}</span>${dispSegHtml('hs-tipo', [['', H.tudo], ['automatico', H.automatico], ['espelhamento', H.espelhamento], ['catalogo', TEXTOS_REVISAO_CATALOGO.tipo], ['remetente', H.remetente]], tipo, 'hs-tipo-r')}`;
}
function histLigarTipo(nivel = '') { dispLigarSeg($('#hs-tipo'), (v) => histIr({ tipo: v }, nivel)); }
/** Muda o filtro do Histórico: o endereço passa a mostrá-lo (sem nova entrada no histórico do navegador) e a página é refeita. */
function histIr(f, nivel = '') {
  const p = new URLSearchParams();
  if (f.tipo) p.set('tipo', f.tipo);
  if (f.regra) p.set('regra', f.regra);
  if (f.status) p.set('status', f.status);
  const qs = p.toString();
  history.replaceState(null, '', '#historico' + (qs ? '?' + qs : ''));
  return paginaHistorico(nivel, p);
}
/** Linha do log de uma regra de Disparo automático: só elas têm rule_id (espelho, envios avulsos, avisos e equipe não têm).
 * O servidor já filtra em GET /api/log?tipo=automatico; isto é só a defesa do cliente. */
const histEhAutomatico = (l) => l.rule_id != null;

// ---------- Histórico: visão Espelhamento ----------
/** Texto e classe do resultado de um item. → { cls, texto, detalhe, extra } */
function espResultado(it) {
  const H = TEXTOS_ESPELHAMENTO.hist; const motivo = it.motivo || '';
  const falhas = (it.destinos || []).filter((d) => d.ok === false);
  switch (it.status) {
    case 'enviado': {
      if (falhas.length) return { cls: 'nivel-erro', texto: `Erro ao enviar para ${espN(falhas.length, 'grupo', 'grupos')}`, detalhe: '', extra: falhas.map((d) => `${d.nome}${d.erro ? ': ' + d.erro : ''}`) };
      const pendente = (it.destinos || []).some((d) => d.ok == null);
      const det = H.detalhe[it.fonte_dados] || '';
      return { cls: 'nivel-ok', texto: H.espelhada, detalhe: [det, pendente ? H.enviando : ''].filter(Boolean).join(' · '), extra: [] };
    }
    case 'duplicado': case 'descartado': case 'expirado': return { cls: 'nivel-aviso', texto: `Descartada: ${motivo || 'sem motivo registrado'}`, detalhe: '', extra: [] };
    case 'na_fila': return { cls: 'nivel-aviso', texto: `Na fila: ${motivo || 'falta completar'}`, detalhe: '', extra: [] };
    case 'erro':
      if (motivo === 'link não resolvido' || motivo === 'não é um produto') return { cls: 'nivel-aviso', texto: `Descartada: ${motivo}`, detalhe: '', extra: [] };
      return { cls: 'nivel-erro', texto: `Não espelhada: ${motivo || 'erro'}`, detalhe: '', extra: [] };
    default: return { cls: 'nivel-aviso', texto: motivo ? H.aguardando : H.processando, detalhe: motivo, extra: [] };
  }
}
const espAsinOk = (a) => /^[A-Z0-9]{10}$/i.test(String(a || ''));
function espTituloItem(it) {
  const H = TEXTOS_ESPELHAMENTO.hist;
  return it.oferta?.title || (espAsinOk(it.asin) ? H.produto(it.asin) : H.linkAmazon);
}
/** Texto do resultado escapado; no motivo "falta a tag…", "Conexões" vira link para a tela onde se cadastra a tag. */
function espTextoHtml(r) {
  const t = esc(r.texto);
  return /falta a tag/i.test(r.texto) ? t.replace('Conexões', '<a href="#conexoes" class="alvo24">Conexões</a>') : t;
}
function espLinhaHtml(it) {
  const H = TEXTOS_ESPELHAMENTO.hist; const r = espResultado(it); const titulo = espTituloItem(it);
  const destinos = it.destinos || []; const nomesDest = destinos.map((d) => d.nome);
  const dest = !destinos.length ? '—' : destinos.length === 1 ? `<span class="trunca" title="${esc(nomesDest[0])}">${esc(nomesDest[0])}</span>` : `<span title="${esc(nomesDest.join(', '))}">${espN(destinos.length, 'grupo', 'grupos')}</span>`;
  const origem = it.origem_nome || H.semOrigem;
  const ref = it.decidido_em || it.ts;
  const botao = it.status === 'na_fila' ? `<button type="button" class="pri" data-completar="${it.id}" aria-label="${esc(`Completar oferta ${titulo}, do grupo ${origem}`)}">${H.completar}</button>` : '';
  return `<tr data-item="${it.id}"><td class="esp-quando" style="white-space:nowrap">${hora(ref)}</td>
    <td class="esp-regra" data-l="${H.rotulosCelula.regra}"><span class="trunca" title="${esc(it.espelho_nome || H.semRegra)}">${esc(it.espelho_nome || H.semRegra)}</span></td>
    <td class="esp-origem" data-l="${H.rotulosCelula.origem}"><span class="trunca" title="${esc(origem)}">${esc(origem)}</span></td>
    <td class="esp-destino" data-l="${H.rotulosCelula.destino}">${dest}</td>
    <td class="esp-oferta"><span class="trunca" title="${esc(titulo)}">${esc(titulo)}</span>${espAsinOk(it.asin) ? `<span class="dica-celula"><a class="alvo24" href="https://www.amazon.com.br/dp/${esc(String(it.asin).toUpperCase())}" target="_blank" rel="noopener" aria-label="${H.verNaAmazon}" style="text-decoration:underline">${esc(String(it.asin).toUpperCase())}</a></span>` : ''}</td>
    <td class="esp-resultado"><span class="${r.cls}">${espTextoHtml(r)}</span>${r.detalhe ? `<span class="dica-celula">${esc(r.detalhe)}</span>` : ''}${r.extra.map((x) => `<span class="dica-celula">${esc(x)}</span>`).join('')}${botao ? `<div style="margin-top:6px">${botao}</div>` : ''}</td></tr>`;
}
function espKpisHtml(live) {
  const H = TEXTOS_ESPELHAMENTO.hist; const info = ESP.info; if (!info) return '';
  const regra = ESP_H.regra ? ESP.lista.find((x) => String(x.id) === String(ESP_H.regra)) : null;
  const c = (regra ? regra.contadores_24h : info.totais_24h) || {}; const fila = c.na_fila || 0;
  return `<div class="kpis esp-kpis"${live ? ' aria-live="polite"' : ''}>
    <div class="kpi"><div class="rotulo">${H.espelhadas}</div><div class="valor">${c.espelhadas || 0}</div><div class="nota">${H.ultimas24}</div></div>
    <div class="kpi"><div class="rotulo">${H.descartadas}</div><div class="valor">${c.descartadas || 0}</div><div class="nota">${H.ultimas24}</div></div>
    <div class="kpi${fila > 0 ? ' atencao' : ''}"><div class="rotulo">${H.naFila}</div><div class="valor">${fila}</div><div class="nota">${fila > 0 ? H.precisamDeVoce : H.ultimas24}</div></div></div>`;
}
function espCorpoHtml(live) {
  const H = TEXTOS_ESPELHAMENTO.hist;
  let lista;
  if (!ESP_H.itens.length) {
    const filtrado = ESP_H.regra || ESP_H.status; const semRegras = !ESP.lista.length;
    lista = `<div class="vazio">${filtrado && !semRegras ? H.vazioFiltro : H.vazio}</div>`;
  } else {
    lista = `<div class="card tabela esp-tab"><table><thead><tr>${H.colunas.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead><tbody id="esp-linhas">${ESP_H.itens.map(espLinhaHtml).join('')}</tbody></table></div>
      <p class="dica" role="status" id="esp-contagem" style="margin:10px 0 0">${ESP_H.fim ? H.fim(ESP_H.itens.length) : H.mostrando(ESP_H.itens.length)}</p>
      <div class="linha" style="margin-top:8px"><button type="button" id="esp-mais" ${ESP_H.fim ? 'hidden' : ''}>${H.mostrarMais}</button></div>`;
  }
  return espKpisHtml(live) + lista;
}
const espConsulta = (antes) => {
  const p = new URLSearchParams({ limite: String(ESP_PAGINA) });
  if (ESP_H.regra) p.set('espelho', ESP_H.regra);
  if (ESP_H.status) p.set('status', ESP_H.status);
  if (antes) p.set('antes', String(antes));
  return `/espelhos/itens?${p}`;
};

/** Visão Espelhamento do Histórico (`#historico?tipo=espelhamento&regra=<id>&status=na_fila`). */
async function paginaHistoricoEspelhamento(params) {
  const H = TEXTOS_ESPELHAMENTO.hist; const ger = ++ESP_H.ger;
  ESP_H.regra = /^\d+$/.test(params.get('regra') || '') ? params.get('regra') : '';
  ESP_H.status = params.get('status') === 'na_fila' ? 'na_fila' : '';
  ESP_H.itens = []; ESP_H.fim = false;
  clearTimeout(paginaHistorico.t);
  $('#pagina').innerHTML = `<div class="topo"><div><h1>${H.titulo} ${q('historico')}</h1><p class="sub">${H.sub}</p></div>
      <div class="linha">${histTipoHtml('espelhamento')}</div></div>
    <div id="esp-filtros" class="linha" style="margin-bottom:12px"></div>
    <div id="esp-corpo"><p class="dica">${H.carregando}</p></div>`;
  histLigarTipo();
  const corpo = $('#esp-corpo'); const ativa = () => ger === ESP_H.ger && rotaAtual() === 'historico';
  const filtros = () => {
    $('#esp-filtros').innerHTML = `<label class="campo" style="min-width:200px"><span>${H.regra}</span><select id="esp-regra"><option value="">${H.todasRegras}</option>${ESP.lista.map((r) => `<option value="${r.id}" ${String(r.id) === ESP_H.regra ? 'selected' : ''}>${esc(r.nome)}</option>`).join('')}</select></label>
      <label class="campo" style="min-width:200px"><span>${H.resultado}</span><select id="esp-status"><option value="">${H.todosResultados}</option><option value="na_fila" ${ESP_H.status ? 'selected' : ''}>${H.soFila}</option></select></label>`;
    $('#esp-regra').onchange = (ev) => histIr({ tipo: 'espelhamento', regra: ev.target.value, status: ESP_H.status });
    $('#esp-status').onchange = (ev) => histIr({ tipo: 'espelhamento', regra: ESP_H.regra, status: ev.target.value });
  };
  const ligarCorpo = () => {
    const mais = $('#esp-mais'); if (mais) mais.onclick = tentar(() => espMostrarMais(ger));
    $$('[data-completar]', corpo).forEach((b) => (b.onclick = tentar(() => completarEspelhamento(Number(b.dataset.completar)))));
  };
  let pintado = ''; // o corpo da última pintura, sem aria-live: compara com o das atualizações automáticas
  // Atualização automática: não repinta com o foco dentro do corpo (o foco se perderia) nem quando nada mudou
  // (o aria-live repetiria os KPIs). Só a primeira pintura anuncia; as seguintes não levam aria-live.
  const pintar = (auto) => {
    const html = espCorpoHtml(false);
    if (auto && (html === pintado || corpo.contains(document.activeElement))) return;
    pintado = html; corpo.innerHTML = auto ? html : espCorpoHtml(true); ligarCorpo();
  };
  const carregar = async (primeira) => {
    try {
      const [info, itens] = await Promise.all([api('/espelhos'), api(espConsulta())]);
      if (!ativa()) return;
      ESP.lista = Array.isArray(info?.espelhos) ? info.espelhos : []; ESP.info = info; ESP.erro = '';
      if (primeira) filtros();
      if (itens.length < ESP_PAGINA) { ESP_H.itens = itens; ESP_H.fim = true; } else {
        // a primeira página do servidor substitui as que já estão na tela; o que for mais velho que ela continua
        const menor = itens.at(-1).id; ESP_H.itens = [...itens, ...ESP_H.itens.filter((x) => x.id < menor)];
        if (primeira) ESP_H.fim = false;
      }
      pintar(!primeira);
    } catch (e) {
      if (!ativa() || !primeira) return; // numa atualização automática que falha, fica o que já está na tela
      filtros();
      corpo.innerHTML = `<div class="vazio" role="alert">${H.erroCarregar}<div style="margin-top:12px"><button type="button" id="esp-de-novo">${H.tentarDeNovo}</button></div></div>`;
      $('#esp-de-novo').onclick = () => histIr({ tipo: 'espelhamento', regra: ESP_H.regra, status: ESP_H.status });
    }
  };
  await carregar(true);
  const agenda = () => {
    clearTimeout(paginaHistorico.t);
    paginaHistorico.t = setTimeout(async () => {
      if (!ativa()) return;
      if (!$('#dlg').open && !ESP_H.carregandoMais) await carregar(false);
      agenda();
    }, 6000);
  };
  agenda();
}

/** "Mostrar mais": busca a página seguinte (cursor = id do último item da tela) e acrescenta as linhas, sem refazer a tabela. */
async function espMostrarMais(ger) {
  const H = TEXTOS_ESPELHAMENTO.hist; const ultimo = ESP_H.itens.at(-1); const btn = $('#esp-mais');
  if (!ultimo || !btn || ESP_H.carregandoMais) return;
  ESP_H.carregandoMais = true; btn.disabled = true; btn.textContent = H.carregandoMais;
  try {
    const mais = await api(espConsulta(ultimo.id));
    if (ger !== ESP_H.ger) return;
    ESP_H.itens = [...ESP_H.itens, ...mais]; if (mais.length < ESP_PAGINA) ESP_H.fim = true;
    $('#esp-linhas').insertAdjacentHTML('beforeend', mais.map(espLinhaHtml).join(''));
    $$('[data-completar]', $('#esp-linhas')).forEach((b) => { if (!b.onclick) b.onclick = tentar(() => completarEspelhamento(Number(b.dataset.completar))); });
    $('#esp-contagem').textContent = ESP_H.fim ? H.fim(ESP_H.itens.length) : H.mostrando(ESP_H.itens.length);
    btn.hidden = ESP_H.fim;
  } finally { ESP_H.carregandoMais = false; btn.disabled = false; btn.textContent = H.mostrarMais; }
}

// ---------- miolo comum dos dialogs de oferta: "Completar" (espelhamento) e "Revisar oferta" (catálogo) ----------
/**
 * Abre o #dlg com os dados editáveis (dadosOferta), a prévia com o template e os botões Fechar, Descartar e Enviar.
 * O 409 ("já tratada") avisa, fecha e atualiza; outro erro aparece no dialog (mostrarErros) e o botão volta.
 * cfg = {
 *   titulo, sub (texto puro: é escapado aqui), topoHtml (HTML já seguro entre o subtítulo e os dados; opcional),
 *   oferta (valores iniciais de dadosOferta), sold, link (o {LINK} da prévia), tpl (template ou null), legenda,
 *   n (grupos que recebem; 0 trava o envio), caminho (`/espelhos/itens/<id>`: POST <caminho>/enviar e /descartar),
 *   atualizar() → Promise (refaz a lista depois de enviar, descartar ou do 409),
 *   bloqueio(valores) → texto (opcional): enquanto houver texto, os botões de envio ficam travados e o texto aparece
 *     no rodapé, ligado a eles por aria-describedby (o servidor decide de novo),
 *   suspeito(valores) → bool (opcional): o "Preço antigo" fica com aria-invalid, destaque de aviso e o texto da trava,
 *   proxima: { texto, depois() → Promise } (opcional): segundo botão, que envia e chama depois() no lugar de atualizar(),
 *   dadosOpcoes (opcional): o 3º argumento de dadosOferta (ex.: { cupomMax }),
 *   precoAntigoSemExemplo (opcional): tira o exemplo "149,90" do "Preço antigo",
 *   errosTitulo: { campos, servidor, descartar } (opcional): título do card de erros (padrão o de mostrarErros).
 *   semDescartar (opcional): sem o botão Descartar (reenvio de oferta já enviada: o servidor só descarta item em revisão).
 * }
 */
function espDialogOferta(cfg) {
  const C = TEXTOS_ESPELHAMENTO.completar; const dlg = $('#dlg'); const n = cfg.n;
  // o motivo da trava fica no rodapé (fixo no fim do dialog), à vista de quem está nos botões
  const trava = cfg.bloqueio ? '<p class="dica nivel-aviso trava-envio" id="cm-trava" role="status" hidden></p>' : '';
  dlg.innerHTML = `<div class="corpo" id="cm"><h1>${cfg.titulo}</h1><p class="dica" style="margin:0">${esc(cfg.sub)}</p>${cfg.topoHtml || ''}
    <div id="cm-dados"></div>
    <div class="previa"><h2 style="margin:0;font-size:15px">${C.previa}</h2><div class="chat" style="min-height:0"><div class="balao" id="cm-pv"></div></div><p class="legenda-previa">${cfg.legenda}</p></div>
    <div class="rodape">${trava}<button type="button" id="cm-fechar">${C.fechar}</button>${cfg.semDescartar ? '' : `<button type="button" id="cm-descartar" class="perigo leve">${C.descartar}</button>`}${cfg.proxima ? `<button type="button" id="cm-proxima">${cfg.proxima.texto}</button>` : ''}<button type="button" class="pri" id="cm-enviar" ${n ? '' : 'disabled'}>${C.enviar(n)}</button></div></div>`;
  const corpo = $('#cm', dlg);
  let seq = 0;
  const prever = async (v) => {
    const k = ++seq; if (!cfg.tpl) return;
    try {
      const r = await api('/templates/preview', 'POST', { body: cfg.tpl.body, amostra: { title: v.title, price: v.price, oldPrice: v.oldPrice, discountPct: v.discountPct, sold: cfg.sold ?? null, freeShipping: v.freeShipping, coupon: v.coupon, link: cfg.link } });
      if (k === seq) $('#cm-pv', dlg).innerHTML = zap(r.texto);
    } catch { /* fica a prévia anterior */ }
  };
  let tm; let enviando = false;
  // botões de envio travados enquanto cfg.bloqueio tiver um motivo (só no "Revisar oferta")
  const botoesEnvio = () => [$('#cm-enviar', dlg), cfg.proxima ? $('#cm-proxima', dlg) : null].filter(Boolean);
  const aplicarTrava = () => {
    if (!cfg.bloqueio) return;
    const v = dados.valores(); const msg = cfg.bloqueio(v) || ''; const p = $('#cm-trava', dlg);
    if (p) { p.textContent = msg; p.hidden = !msg; }
    botoesEnvio().forEach((b) => {
      if (!enviando) b.disabled = !n || !!msg;
      if (msg) b.setAttribute('aria-describedby', 'cm-trava'); else b.removeAttribute('aria-describedby');
    });
    // preço suspeito: o "Preço antigo" fica marcado (aria-invalid e destaque de aviso), com o texto da trava como descrição
    const antigo = cfg.suspeito ? dados.el.elements.namedItem('oldPrice') : null;
    if (antigo) {
      const s = !!msg && !!cfg.suspeito(v);
      if (s) antigo.setAttribute('aria-invalid', 'true'); else antigo.removeAttribute('aria-invalid');
      antigo.classList.toggle('campo-suspeito', s);
      const ids = String(antigo.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== 'cm-trava');
      if (s) ids.push('cm-trava');
      if (ids.length) antigo.setAttribute('aria-describedby', ids.join(' ')); else antigo.removeAttribute('aria-describedby');
    }
  };
  const dados = dadosOferta(cfg.oferta || {}, (v) => { aplicarTrava(); clearTimeout(tm); tm = setTimeout(() => prever(v), 250); }, cfg.dadosOpcoes);
  if (cfg.precoAntigoSemExemplo) dados.el.elements.namedItem('oldPrice')?.removeAttribute('placeholder');
  $('#cm-dados', dlg).appendChild(dados.el); prever(dados.valores()); aplicarTrava();
  // o preço atual é obrigatório para enviar (o Disparo manual, que usa o mesmo formulário, não o exige)
  dados.el.elements.namedItem('price')?.closest('label')?.querySelector('span')?.insertAdjacentHTML('beforeend', ` ${REQ}`);
  const fechar = () => { clearTimeout(tm); dlg.close(); };
  $('#cm-fechar', dlg).onclick = fechar;
  // o item já foi tratado (409): avisa, fecha e atualiza a lista
  const jaTratado = async (err) => { fechar(); aviso(err.message, true); await cfg.atualizar(); };
  const enviar = async (btn, rotulo, depois) => {
    const erros = dados.erros();
    if (!erros.length && dados.valores().price == null) erros.push({ msg: C.faltaPreco, el: dados.el.elements.namedItem('price') });
    if (mostrarErros(corpo, erros, cfg.errosTitulo?.campos)) return;
    if (cfg.bloqueio?.(dados.valores())) { aplicarTrava(); return; }
    btn.disabled = true; btn.textContent = C.enviando; enviando = true;
    try { await dispApi(`${cfg.caminho}/enviar`, { method: 'POST', body: { ajustes: dados.ajustes() } }); } catch (err) {
      enviando = false;
      if (err.status === 409) return jaTratado(err);
      btn.disabled = false; btn.textContent = rotulo; aplicarTrava(); mostrarErros(corpo, [{ msg: err.message }], cfg.errosTitulo?.servidor); return;
    }
    fechar(); aviso(C.enviada(n)); await depois();
  };
  $('#cm-enviar', dlg).onclick = tentar(() => enviar($('#cm-enviar', dlg), C.enviar(n), cfg.atualizar));
  if (cfg.proxima) $('#cm-proxima', dlg).onclick = tentar(() => enviar($('#cm-proxima', dlg), cfg.proxima.texto, cfg.proxima.depois));
  if ($('#cm-descartar', dlg)) $('#cm-descartar', dlg).onclick = tentar(async () => {
    if (!confirm(C.confirmaDescartar)) return;
    try { await dispApi(`${cfg.caminho}/descartar`, { method: 'POST' }); } catch (err) {
      if (err.status === 409) return jaTratado(err);
      mostrarErros(corpo, [{ msg: err.message }], cfg.errosTitulo?.descartar); return;
    }
    fechar(); aviso(C.descartada); await cfg.atualizar();
  });
  dlg.showModal(); dados.el.elements.namedItem('title')?.focus();
}

// ---------- "Completar" um item da fila ----------
function completarEspelhamento(itemId) {
  const T = TEXTOS_ESPELHAMENTO; const C = T.completar;
  const it = ESP_H.itens.find((x) => x.id === itemId); if (!it) return;
  const regra = ESP.lista.find((r) => r.id === it.espelho_id);
  const tpl = regra ? S.templates.find((t) => t.id === regra.template_id) : null;
  espDialogOferta({
    titulo: C.titulo, sub: C.sub(it.origem_nome, it.espelho_nome || T.hist.semRegra), oferta: it.oferta || {}, sold: it.oferta?.sold,
    link: `https://www.amazon.com.br/dp/${espAsinOk(it.asin) ? String(it.asin).toUpperCase() : '…'}?tag=•••`,
    tpl, legenda: tpl ? C.previaLegenda : C.semTemplate, n: espDestinosAtivos(regra), caminho: `/espelhos/itens/${itemId}`,
    atualizar: () => histIr({ tipo: 'espelhamento', regra: ESP_H.regra, status: ESP_H.status }),
  });
}

// ---------- Histórico: visão Catálogo e "Revisar oferta" (fonte Catálogo, app Etiqueta) ----------
// Spec: docs/produto/specs/fonte-catalogo-etiqueta.md, seção 3. Tudo o que vem do catálogo (título, categoria, cupom,
// nome da regra) é texto cru de fora: sempre por esc(); o link só vira <a> se for https de um dos hosts esperados.
// Só o Dono revisa (o servidor responde 403 ao Operador em enviar e descartar); o Operador vê a lista sem o botão.
const TEXTOS_REVISAO_CATALOGO = {
  tipo: 'Catálogo',
  enviadas: 'Enviadas', descartadas: 'Descartadas', paraRevisar: 'Para revisar', ultimas24: 'Últimas 24 h', esperamVoce: 'Esperam a sua revisão',
  regra: 'Disparo automático', todasRegras: 'Todos os disparos', resultado: 'Mostrar', todos: 'Tudo', soRevisar: 'Só o que está para revisar',
  colunas: ['Quando', 'Regra', 'Loja', 'Oferta', 'Resultado'],
  rotulosCelula: { regra: 'Regra', loja: 'Loja' },
  vazio: 'Nada para revisar. As ofertas da Shopee, as com 100% de desconto, as com queda grande de preço e as que falharam 3 vezes aparecem aqui.', vazioFiltro: 'Nada com este filtro.',
  erroCarregar: 'Não consegui carregar as ofertas do catálogo. Tente de novo.',
  semRegra: '(disparo apagado)', semTitulo: 'Oferta sem título',
  lojas: { ml: 'Mercado Livre', amazon: 'Amazon', shopee: 'Shopee' },
  motivos: {
    shopee: 'Shopee: confirme o link', desconto_100: 'Desconto de 100%: confira o preço',
    preco_antigo: 'Preço antigo muito alto: confira o preço', falha_link: 'Não consegui gerar o link: confira a oferta',
    nao_conferido: 'Não deu para conferir o preço: confira na loja',
    queda_preco: 'Preço muito abaixo da lista: confira o preço', falhas_repetidas: 'Falhou 3 vezes seguidas: confira a oferta e envie',
  },
  // com a queda em % (`queda_pct` do item, quando o servidor a mandar): o texto da spec; sem ela, o de `motivos.queda_preco`
  quedaMotivo: (pct) => `Preço ${pct}% abaixo da lista: confira o preço`,
  // item que voltou à revisão porque o "Enviar" não chegou a nenhum grupo (`ultimo_envio_falhou`)
  ultimoEnvioFalhou: 'Último envio falhou: a oferta não chegou a nenhum grupo. Ela continua na revisão: tente de novo.',
  ultimoEnvioErro: (nome, erro) => `${nome}${erro ? ': ' + erro : ''}`,
  enviada: 'Enviada', paraRevisarPre: 'Para revisar', descartada: 'Descartada: na revisão',
  // descartada pelo verificador de preço e estoque (chaves de `descartado_por` de GET /api/catalogo/itens; MOTIVOS_VERIFICADOR)
  descartadaPor: {
    esgotado: 'Descartada: esgotado na loja', preco_subiu: 'Descartada: preço subiu',
    indisponivel: 'Descartada: indisponível na loja', outro_produto: 'Descartada: a página da loja abriu outro produto',
  },
  dicaAmazon: 'link da Amazon com a sua tag', dicaML: 'link do Mercado Livre gerado com a sua etiqueta', revisada: 'revisada e enviada', enviando: 'enviando…',
  erroGrupos: (n) => `Erro ao enviar para ${espN(n, 'grupo', 'grupos')}`,
  revisar: 'Revisar', revisarAria: (titulo, loja) => `Revisar oferta ${titulo}, da ${loja}`, soDono: 'Só o Dono revisa.',
  // item enviado cujo envio não chegou a nenhum grupo (`pode_reenviar` do servidor): o Dono abre o mesmo dialog
  reenviar: 'Enviar de novo', reenviarAria: (titulo, loja) => `Enviar de novo a oferta ${titulo}, da ${loja}`,
  subReenviar: (regra) => `Veio do catálogo, pela regra “${regra}”. O envio anterior não chegou a nenhum grupo (o motivo está na linha desta oferta). Confira os dados e envie de novo.`,
  // a lista mostra no máximo HCAT_LIMITE itens (GET /api/catalogo/itens pagina por antes=/proximo; a tela ainda não usa)
  limiteRevisar: (n, total) => `Mostrando as ${n} mais recentes de ${total} para revisar. Escolha um disparo no filtro acima para ver as outras (cada disparo guarda até 50).`,
  limiteTodos: (n) => `Mostrando as ${n} mais recentes. Para achar uma mais antiga, escolha um disparo e “Só o que está para revisar” no filtro acima.`,
  cheia: (regra, n) => `A regra “${regra}” tem ${n} ofertas esperando revisão. As novas esperam até você revisar ou descartar algumas.`,
  // dialog "Revisar oferta"
  titulo: 'Revisar oferta',
  sub: (regra, motivos) => `Veio do catálogo, pela regra “${regra}”. Motivo: ${motivos}. Confira os dados e envie, ou descarte.`,
  faixaShopee: 'O link da Shopee não prova de quem é a conta. Abra o link abaixo para conferir o produto antes de enviar.',
  faixaPreco: (x, antigo, preco) => `Esta oferta aparece com 100% de desconto ou com preço antigo ${x}× maior que o preço (${antigo} → ${preco}). Costuma ser erro no catálogo. Corrija os preços à mão, ou apague o preço antigo: a mensagem sai sem “de/por” e sem desconto.`,
  // 100% informado pelo Etiqueta sem preço antigo 10× maior: o envio é liberado, porque o servidor nunca manda o "100%"
  faixa100SemAntigo: 'O Etiqueta informou 100% de desconto; esse número não vai na mensagem. Sem um preço antigo maior que o preço, ela sai sem “de/por” e sem desconto. Confira o preço antes de enviar.',
  faixa100ComAntigo: (antigo, preco) => `O Etiqueta informou 100% de desconto; esse número não vai na mensagem. O desconto sai calculado dos dois preços (${antigo} → ${preco}). Confira os preços antes de enviar.`,
  // queda de preço: {LIMITE} é QUEDA_REVISAO_PCT (src/catalogo.js); o servidor ainda não manda o limite, então o número é o da constante
  faixaQueda: (pct, limite) => `O Etiqueta trouxe este preço ${pct == null ? 'bem abaixo' : pct + '% abaixo'} do preço da lista, mais que o limite de ${limite}%. Pode ser promoção de verdade ou preço errado. Confira na loja antes de enviar.`,
  faixaFalhas: 'O link ou a conferência do preço falhou em 3 envios seguidos. Ao enviar, o painel tenta de novo na hora; se falhar, o motivo aparece na linha desta oferta no Histórico.',
  faixaUltimoFalhou: 'O último envio desta oferta não chegou a nenhum grupo:',
  faixaLink: 'Não consegui gerar o link do Mercado Livre desta oferta. Ao enviar, o painel tenta de novo na hora; se falhar, o motivo aparece na linha desta oferta no Histórico.',
  abrirLink: 'Abrir o link da oferta (abre em outra aba)', linkFora: 'Link fora do esperado: não enviar.',
  corrijaPreco: 'Corrija o preço ou apague o preço antigo para enviar.',
  errosCampos: 'Antes de enviar, falta:', errosServidor: 'Não foi possível enviar:', errosDescartar: 'Não foi possível descartar:',
  proxima: 'Enviar e ir para a próxima',
  legenda: {
    ml: 'Com o template da regra. O link meli.la é gerado com a sua etiqueta na hora do envio.',
    amazon: 'Com o template da regra. O link sai com a sua tag da Amazon na hora do envio.',
    shopee: 'Com o template da regra. O link é o do catálogo, o mesmo de cima.',
  },
  semTemplate: 'O template desta regra não existe mais. Edite a regra no Disparo automático.',
};
// Link mostrado na revisão (plano, alinhamento 10): ML = página do produto, Amazon = /dp/<ASIN> sem tag, Shopee = link curto.
const HCAT_LINKS = Object.freeze({
  ml: /^https:\/\/produto\.mercadolivre\.com\.br\/MLB-\d{1,20}$/,
  amazon: /^https:\/\/www\.amazon\.com\.br\/dp\/[A-Z0-9]{10}$/,
  shopee: /^https:\/\/s\.shopee\.com\.br\/[A-Za-z0-9_-]{3,40}$/,
});
const HCAT_LIMITE = 200; // o máximo que GET /api/catalogo/itens devolve por página (antes=/proximo; a tela usa só a primeira)
const HCAT = { regra: '', status: '', itens: [], dados: null };

/** O link do item, se for exatamente o formato esperado da loja; senão null (não vira <a> e trava o "Enviar"). */
const hcatLinkSeguro = (loja, link) => (Object.hasOwn(HCAT_LINKS, loja) && typeof link === 'string' && HCAT_LINKS[loja].test(link) ? link : null);
/** Motivos do servidor em texto ("A e B"); motivo desconhecido não aparece. */
const HCAT_QUEDA_LIMITE = 50; // espelha QUEDA_REVISAO_PCT de src/catalogo.js (o painel não importa de src/)
/** `queda_pct` do item (inteiro de 1 a 99) ou null: o servidor ainda pode não mandar. */
const hcatQuedaPct = (it) => (Number.isInteger(it?.queda_pct) && it.queda_pct >= 1 && it.queda_pct <= 99 ? it.queda_pct : null);
const hcatMotivos = (lista, it) => (Array.isArray(lista) ? lista : []).map((m) => {
  if (m === 'queda_preco' && hcatQuedaPct(it) != null) return TEXTOS_REVISAO_CATALOGO.quedaMotivo(hcatQuedaPct(it));
  return Object.hasOwn(TEXTOS_REVISAO_CATALOGO.motivos, m) ? TEXTOS_REVISAO_CATALOGO.motivos[m] : '';
}).filter(Boolean).join(' e ');
const hcatNomeLoja = (loja) => (Object.hasOwn(TEXTOS_REVISAO_CATALOGO.lojas, loja) ? TEXTOS_REVISAO_CATALOGO.lojas[loja] : '—');
/**
 * Preço ainda suspeito com os valores do formulário (a mesma conta do servidor, precoSuspeito em src/catalogo-itens.js):
 * desconto de 100% ou preço antigo ≥ 10× o preço.
 */
function hcatPrecoSuspeito(v) {
  const preco = Number(v?.price); const antigo = Number(v?.oldPrice); const pct = Number(v?.discountPct);
  if (Number.isFinite(pct) && pct >= 100) return true;
  return v?.oldPrice != null && Number.isFinite(antigo) && Number.isFinite(preco) && preco > 0 && antigo >= 10 * preco;
}

/** Texto e classe do resultado de um item do catálogo. → { cls, texto, detalhe, extra } */
function hcatResultado(it) {
  const R = TEXTOS_REVISAO_CATALOGO;
  if (it.status === 'revisao') {
    // voltou à revisão porque o "Enviar" falhou em todos os grupos (CA2.8): o aviso do último envio e o erro de cada grupo
    const falhou = it.ultimo_envio_falhou === true;
    const erros = falhou && Array.isArray(it.ultimo_envio_erros) ? it.ultimo_envio_erros.map((g) => R.ultimoEnvioErro(g?.nome ?? '', g?.erro ?? '')) : [];
    return { cls: 'nivel-aviso', texto: `${R.paraRevisarPre}: ${hcatMotivos(it.motivos, it) || '—'}`, detalhe: falhou ? R.ultimoEnvioFalhou : '', extra: erros };
  }
  if (it.status === 'descartado') {
    const porque = typeof it.descartado_por === 'string' && Object.hasOwn(R.descartadaPor, it.descartado_por) ? R.descartadaPor[it.descartado_por] : R.descartada;
    return { cls: 'nivel-aviso', texto: porque, detalhe: '', extra: [] };
  }
  const grupos = Array.isArray(it.grupos) ? it.grupos : [];
  const falhas = grupos.filter((g) => g.ok === false);
  if (falhas.length) return { cls: 'nivel-erro', texto: R.erroGrupos(falhas.length), detalhe: '', extra: falhas.map((g) => `${g.nome}${g.erro ? ': ' + g.erro : ''}`) };
  // enviada sozinha pela regra (sem envio_id) ou pela revisão (com envio_id; ainda saindo enquanto algum grupo está sem resultado)
  const pela = it.envio_id != null ? R.revisada : it.loja === 'amazon' ? R.dicaAmazon : it.loja === 'ml' ? R.dicaML : '';
  const saindo = it.envio_id != null && grupos.some((g) => g.ok == null);
  return { cls: 'nivel-ok', texto: R.enviada, detalhe: [pela, saindo ? R.enviando : ''].filter(Boolean).join(' · '), extra: [] };
}

/** O item abre o dialog: em revisão, ou enviado sem ter chegado a nenhum grupo (`pode_reenviar`). */
const hcatAbreDialog = (it) => it?.status === 'revisao' || (it?.status === 'enviado' && it.pode_reenviar === true);

/**
 * Linha da tabela. `dono`: mostra o botão "Revisar" (senão, o texto "Só o Dono revisa.") e, no item enviado que não
 * chegou a nenhum grupo, "Enviar de novo" (o Operador não vê nada a mais: o erro por grupo já está na linha).
 */
function hcatLinhaHtml(it, dono) {
  const R = TEXTOS_REVISAO_CATALOGO; const r = hcatResultado(it); const o = it.oferta || {};
  const titulo = o.title || R.semTitulo; const loja = hcatNomeLoja(it.loja); const regra = it.regra || R.semRegra;
  const botao = (texto, aria, cls) => `<div style="margin-top:6px"><button type="button" class="${cls}" data-revisar="${Number(it.id)}" aria-label="${esc(aria)}">${texto}</button></div>`;
  const acao = it.status === 'revisao' ? (dono ? botao(R.revisar, R.revisarAria(titulo, loja), 'pri') : `<span class="dica-celula">${R.soDono}</span>`)
    : hcatAbreDialog(it) && dono ? botao(R.reenviar, R.reenviarAria(titulo, loja), '') : '';
  // classes esp-* : o mesmo arranjo em cartão da tabela do espelhamento em telas estreitas (style.css)
  return `<tr data-item="${Number(it.id)}"><td class="esp-quando" style="white-space:nowrap">${hora(it.decidido_em || it.criado_em)}</td>
    <td class="esp-regra" data-l="${R.rotulosCelula.regra}"><span class="trunca" title="${esc(regra)}">${esc(regra)}</span></td>
    <td class="esp-origem" data-l="${R.rotulosCelula.loja}"><span class="chip">${esc(loja)}</span></td>
    <td class="esp-oferta"><span class="trunca" title="${esc(titulo)}">${esc(titulo)}</span>${o.categoria ? `<span class="dica-celula trunca" title="${esc(o.categoria)}">${esc(o.categoria)}</span>` : ''}</td>
    <td class="esp-resultado"><span class="${r.cls}">${esc(r.texto)}</span>${r.detalhe ? `<span class="dica-celula">${esc(r.detalhe)}</span>` : ''}${r.extra.map((x) => `<span class="dica-celula">${esc(x)}</span>`).join('')}${acao}</td></tr>`;
}

/** KPIs (últimas 24 h; "Para revisar" conta toda a fila) e o aviso de fila cheia de cada regra, + a tabela. */
function hcatCorpoHtml(dados, dono) {
  const R = TEXTOS_REVISAO_CATALOGO; const c = dados?.contadores_24h || {}; const fila = Number(c.para_revisar) || 0;
  const kpis = `<div class="kpis esp-kpis" aria-live="polite">
    <div class="kpi"><div class="rotulo">${R.enviadas}</div><div class="valor">${Number(c.enviadas) || 0}</div><div class="nota">${R.ultimas24}</div></div>
    <div class="kpi"><div class="rotulo">${R.descartadas}</div><div class="valor">${Number(c.descartadas) || 0}</div><div class="nota">${R.ultimas24}</div></div>
    <div class="kpi${fila > 0 ? ' atencao' : ''}"><div class="rotulo">${R.paraRevisar}</div><div class="valor">${fila}</div><div class="nota">${fila > 0 ? R.esperamVoce : R.ultimas24}</div></div></div>`;
  const teto = Number(dados?.teto_revisao) || 50;
  const cheias = (Array.isArray(dados?.regras) ? dados.regras : []).filter((x) => x.cheia)
    .map((x) => `<div class="aviso-impl" role="status" style="margin-bottom:10px"><p>${esc(R.cheia(x.regra || R.semRegra, teto))}</p></div>`).join('');
  const itens = Array.isArray(dados?.itens) ? dados.itens : [];
  // a rota devolve no máximo HCAT_LIMITE: avisa que há mais e como chegar nelas (o filtro por disparo cabe inteiro)
  const total = Number(c.para_revisar) || 0;
  const corte = itens.length < HCAT_LIMITE ? ''
    : `<p class="dica" role="status" id="hc-limite" style="margin:0 0 10px">${HCAT.status === 'revisao' ? R.limiteRevisar(itens.length, Math.max(total, itens.length)) : R.limiteTodos(itens.length)}</p>`;
  const lista = !itens.length ? `<div class="vazio">${HCAT.regra || HCAT.status ? R.vazioFiltro : R.vazio}</div>`
    : `<div class="card tabela esp-tab" id="hc-tab" tabindex="-1"><table><thead><tr>${R.colunas.map((x) => `<th scope="col">${x}</th>`).join('')}</tr></thead><tbody id="hc-linhas">${itens.map((it) => hcatLinhaHtml(it, dono)).join('')}</tbody></table></div>`;
  return kpis + cheias + corte + lista;
}

const hcatConsulta = () => {
  const p = new URLSearchParams({ limite: String(HCAT_LIMITE), status: HCAT.status || 'todos' });
  if (HCAT.regra) p.set('regra', HCAT.regra);
  return `/catalogo/itens?${p}`;
};
const hcatIr = () => histIr({ tipo: 'catalogo', regra: HCAT.regra, status: HCAT.status });

/** Visão Catálogo do Histórico (`#historico?tipo=catalogo&regra=<id>&status=revisao`). */
async function paginaHistoricoCatalogo(params) {
  const H = TEXTOS_ESPELHAMENTO.hist; const R = TEXTOS_REVISAO_CATALOGO; const ger = ++ESP_H.ger;
  HCAT.regra = /^\d+$/.test(params?.get('regra') || '') ? params.get('regra') : '';
  HCAT.status = params?.get('status') === 'revisao' ? 'revisao' : '';
  HCAT.itens = []; HCAT.dados = null;
  clearTimeout(paginaHistorico.t);
  const regras = (S.rules || []).filter((r) => (r.sources || []).some((f) => f?.type === 'catalogo'));
  $('#pagina').innerHTML = `<div class="topo"><div><h1>${H.titulo} ${q('historico')}</h1><p class="sub">${H.sub}</p></div>
      <div class="linha">${histTipoHtml('catalogo')}</div></div>
    <div class="linha" style="margin-bottom:12px">
      <label class="campo" style="min-width:200px"><span>${R.regra}</span><select id="hc-regra"><option value="">${R.todasRegras}</option>${regras.map((r) => `<option value="${Number(r.id)}" ${String(r.id) === HCAT.regra ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
      <label class="campo" style="min-width:200px"><span>${R.resultado}</span><select id="hc-status"><option value="">${R.todos}</option><option value="revisao" ${HCAT.status ? 'selected' : ''}>${R.soRevisar}</option></select></label></div>
    <div id="hc-corpo"><p class="dica">${H.carregando}</p></div>`;
  histLigarTipo();
  $('#hc-regra').onchange = (ev) => { HCAT.regra = ev.target.value; hcatIr(); };
  $('#hc-status').onchange = (ev) => { HCAT.status = ev.target.value; hcatIr(); };
  const ativa = () => ger === ESP_H.ger && rotaAtual() === 'historico';
  const pintar = () => {
    const corpo = $('#hc-corpo'); corpo.innerHTML = hcatCorpoHtml(HCAT.dados, podeEquipe());
    $$('[data-revisar]', corpo).forEach((b) => (b.onclick = tentar(() => revisarCatalogo(Number(b.dataset.revisar)))));
  };
  const carregar = async (primeira) => {
    try {
      const dados = await api(hcatConsulta());
      if (!ativa()) return;
      HCAT.dados = dados; HCAT.itens = Array.isArray(dados?.itens) ? dados.itens : [];
      pintar();
    } catch {
      if (!ativa() || !primeira) return; // numa atualização automática que falha, fica o que já está na tela
      $('#hc-corpo').innerHTML = `<div class="vazio" role="alert">${R.erroCarregar}<div style="margin-top:12px"><button type="button" id="hc-de-novo">${H.tentarDeNovo}</button></div></div>`;
      $('#hc-de-novo').onclick = () => hcatIr();
    }
  };
  await carregar(true);
  const agenda = () => {
    clearTimeout(paginaHistorico.t);
    paginaHistorico.t = setTimeout(async () => {
      if (!ativa()) return;
      if (!$('#dlg').open) await carregar(false); // com o dialog aberto, a lista não é repintada
      agenda();
    }, 6000);
  };
  agenda();
}

/** Faixa de motivo do topo do dialog (texto fixo; os preços passam por dispBrl e esc). */
function hcatFaixaHtml(it) {
  const R = TEXTOS_REVISAO_CATALOGO; const m = Array.isArray(it.motivos) ? it.motivos : []; const o = it.oferta || {};
  const ps = [];
  if (m.includes('shopee')) ps.push(R.faixaShopee);
  if (m.includes('desconto_100') || m.includes('preco_antigo')) {
    const preco = Number(o.price); const antigo = Number(o.oldPrice);
    const temAntigo = o.oldPrice != null && Number.isFinite(antigo) && preco > 0 && antigo > preco;
    // preço antigo ≥ 10×: a trava vale até corrigir; 100% só informado pelo Etiqueta: o número não sai e o envio é liberado
    if (temAntigo && (antigo >= 10 * preco || !m.includes('desconto_100'))) ps.push(R.faixaPreco(Math.round(antigo / preco), dispBrl(antigo), dispBrl(preco)));
    else if (m.includes('desconto_100')) ps.push(temAntigo ? R.faixa100ComAntigo(dispBrl(antigo), dispBrl(preco)) : R.faixa100SemAntigo);
  }
  if (m.includes('queda_preco')) ps.push(R.faixaQueda(hcatQuedaPct(it), HCAT_QUEDA_LIMITE));
  if (m.includes('falha_link')) ps.push(R.faixaLink);
  if (m.includes('falhas_repetidas')) ps.push(R.faixaFalhas);
  if (it.status === 'revisao' && it.ultimo_envio_falhou === true) {
    const erros = Array.isArray(it.ultimo_envio_erros) ? it.ultimo_envio_erros.map((g) => R.ultimoEnvioErro(g?.nome ?? '', g?.erro ?? '')) : [];
    ps.push(erros.length ? `${R.faixaUltimoFalhou} ${erros.join(' · ')}` : R.ultimoEnvioFalhou);
  }
  return ps.length ? `<div class="aviso-impl" role="status"><div class="aviso-corpo">${ps.map((p) => `<p>${esc(p)}</p>`).join('')}</div></div>` : '';
}

/** Dialog "Revisar oferta" de um item do catálogo (só o Dono; item 'revisao', ou enviado com `pode_reenviar`). */
function revisarCatalogo(itemId) {
  const R = TEXTOS_REVISAO_CATALOGO;
  const it = HCAT.itens.find((x) => x.id === itemId); if (!hcatAbreDialog(it)) return;
  const reenvio = it.status !== 'revisao';
  const regra = (S.rules || []).find((r) => r.id === it.rule_id);
  const tpl = regra ? (S.templates || []).find((t) => t.id === regra.template_id) : null;
  const link = hcatLinkSeguro(it.loja, it.oferta?.link);
  const linkHtml = link
    ? `<p style="margin:0"><a href="${esc(link)}" target="_blank" rel="noopener noreferrer" class="alvo24" style="text-decoration:underline">${R.abrirLink}</a></p>`
    : `<p class="nivel-erro" style="margin:0">${R.linkFora}</p>`;
  const linkPrevia = it.loja === 'ml' ? 'https://meli.la/(gerado no envio)' : !link ? '…' : it.loja === 'amazon' ? `${link}?tag=•••` : link;
  // as outras desta regra que esperam revisão, a mais antiga primeiro (para "Enviar e ir para a próxima")
  const proximas = () => HCAT.itens.filter((x) => x.status === 'revisao' && x.rule_id === it.rule_id && x.id !== itemId)
    .sort((a, b) => (a.criado_em - b.criado_em) || (a.id - b.id));
  const depois = async () => {
    await hcatIr();
    $('#hc-tab')?.focus(); // o botão que abriu sumiu com a linha: o foco volta à tabela
  };
  espDialogOferta({
    titulo: R.titulo, sub: reenvio ? R.subReenviar(it.regra || R.semRegra) : R.sub(it.regra || R.semRegra, hcatMotivos(it.motivos, it) || '—'),
    topoHtml: hcatFaixaHtml(it) + linkHtml,
    oferta: it.oferta || {}, sold: it.oferta?.sold, link: linkPrevia, tpl,
    legenda: tpl ? R.legenda[it.loja] || '' : R.semTemplate,
    n: Array.isArray(it.grupos) ? it.grupos.length : 0, caminho: `/catalogo/itens/${Number(itemId)}`,
    atualizar: depois,
    bloqueio: (v) => (!link ? R.linkFora : hcatPrecoSuspeito(v) ? R.corrijaPreco : ''),
    suspeito: hcatPrecoSuspeito,
    // cupom do catálogo: até 100 (o Espelhamento e o Disparo manual seguem com 30); sem exemplo no "Preço antigo"
    dadosOpcoes: { cupomMax: 100 }, precoAntigoSemExemplo: true,
    errosTitulo: { campos: R.errosCampos, servidor: R.errosServidor, descartar: R.errosDescartar },
    semDescartar: reenvio,
    proxima: !reenvio && proximas().length ? {
      texto: R.proxima,
      depois: async () => {
        await hcatIr();
        const prox = proximas()[0];
        if (prox) revisarCatalogo(prox.id); else $('#hc-tab')?.focus();
      },
    } : null,
  });
}
