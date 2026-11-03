// Espelhamento de ofertas da Amazon: cartão e formulário (Disparo automático), visão Espelhamento do Histórico
// (KPIs, tabela, "Mostrar mais") e o dialog "Completar" da fila.
// Spec: docs/produto/specs/espelhamento-amazon.md. Plano: docs/produto/planos/espelhamento-amazon.md (etapa 12).
// Rotas: GET/POST /api/espelhos, PUT/DELETE /api/espelhos/:id, POST /api/espelhos/:id/enabled,
// GET /api/espelhos/itens, POST /api/espelhos/itens/:id/enviar e /descartar.
// Carrega depois de disparos.js e antes de app.js: só define funções e constantes (prefixo Esp/ESP/esp/hist, para não
// colidir no escopo global dos scripts clássicos). Os utilitários de app.js ($, $$, esc, zap, S, api, aviso, REQ, opcoes,
// mostrarErros, seletorGrupos, hora, q, paginaHistorico, rotaAtual) e de disparos.js (dadosOferta, dispApi, dispSegHtml,
// dispLigarSeg) só são usados quando as telas abrem.
// Nunca aparece aqui o texto da mensagem de origem, número nem nome de participante: o servidor não os manda.

const TEXTOS_ESPELHAMENTO = {
  novo: 'Novo espelhamento', criar: 'Criar espelhamento', editarTitulo: 'Editar espelhamento',
  chip: 'Espelhamento',
  subRegras: 'Também pode espelhar ofertas da Amazon de outros grupos.',
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
    tipo: 'Tipo', tudo: 'Tudo', automatico: 'Disparo automático', espelhamento: 'Espelhamento',
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
/** HTML do seletor "Tipo" (Tudo | Disparo automático | Espelhamento). Ligue com histLigarTipo(). */
function histTipoHtml(tipo) {
  const H = TEXTOS_ESPELHAMENTO.hist;
  return `<span class="rotulo-campo" id="hs-tipo-r">${H.tipo}</span>${dispSegHtml('hs-tipo', [['', H.tudo], ['automatico', H.automatico], ['espelhamento', H.espelhamento]], tipo, 'hs-tipo-r')}`;
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
function espKpisHtml() {
  const H = TEXTOS_ESPELHAMENTO.hist; const info = ESP.info; if (!info) return '';
  const regra = ESP_H.regra ? ESP.lista.find((x) => String(x.id) === String(ESP_H.regra)) : null;
  const c = (regra ? regra.contadores_24h : info.totais_24h) || {}; const fila = c.na_fila || 0;
  return `<div class="kpis esp-kpis" aria-live="polite">
    <div class="kpi"><div class="rotulo">${H.espelhadas}</div><div class="valor">${c.espelhadas || 0}</div><div class="nota">${H.ultimas24}</div></div>
    <div class="kpi"><div class="rotulo">${H.descartadas}</div><div class="valor">${c.descartadas || 0}</div><div class="nota">${H.ultimas24}</div></div>
    <div class="kpi${fila > 0 ? ' atencao' : ''}"><div class="rotulo">${H.naFila}</div><div class="valor">${fila}</div><div class="nota">${fila > 0 ? H.precisamDeVoce : H.ultimas24}</div></div></div>`;
}
function espCorpoHtml() {
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
  return espKpisHtml() + lista;
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
  const pintar = () => { corpo.innerHTML = espCorpoHtml(); ligarCorpo(); };
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
      pintar();
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

// ---------- "Completar" um item da fila ----------
function completarEspelhamento(itemId) {
  const T = TEXTOS_ESPELHAMENTO; const C = T.completar; const dlg = $('#dlg');
  const it = ESP_H.itens.find((x) => x.id === itemId); if (!it) return;
  const regra = ESP.lista.find((r) => r.id === it.espelho_id);
  const tpl = regra ? S.templates.find((t) => t.id === regra.template_id) : null;
  const n = espDestinosAtivos(regra);
  dlg.innerHTML = `<div class="corpo" id="cm"><h1>${C.titulo}</h1><p class="dica" style="margin:0">${esc(C.sub(it.origem_nome, it.espelho_nome || T.hist.semRegra))}</p>
    <div id="cm-dados"></div>
    <div class="previa"><h2 style="margin:0;font-size:15px">${C.previa}</h2><div class="chat" style="min-height:0"><div class="balao" id="cm-pv"></div></div><p class="legenda-previa">${tpl ? C.previaLegenda : C.semTemplate}</p></div>
    <div class="rodape"><button type="button" id="cm-fechar">${C.fechar}</button><button type="button" id="cm-descartar" class="perigo leve">${C.descartar}</button><button type="button" class="pri" id="cm-enviar" ${n ? '' : 'disabled'}>${C.enviar(n)}</button></div></div>`;
  const corpo = $('#cm', dlg);
  const link = `https://www.amazon.com.br/dp/${espAsinOk(it.asin) ? String(it.asin).toUpperCase() : '…'}?tag=•••`;
  let seq = 0;
  const prever = async (v) => {
    const k = ++seq; if (!tpl) return;
    try {
      const r = await api('/templates/preview', 'POST', { body: tpl.body, amostra: { title: v.title, price: v.price, oldPrice: v.oldPrice, discountPct: v.discountPct, sold: it.oferta?.sold ?? null, freeShipping: v.freeShipping, coupon: v.coupon, link } });
      if (k === seq) $('#cm-pv', dlg).innerHTML = zap(r.texto);
    } catch { /* fica a prévia anterior */ }
  };
  let tm;
  const dados = dadosOferta(it.oferta || {}, (v) => { clearTimeout(tm); tm = setTimeout(() => prever(v), 250); });
  $('#cm-dados', dlg).appendChild(dados.el); prever(dados.valores());
  // o preço atual é obrigatório para enviar (o Disparo manual, que usa o mesmo formulário, não o exige)
  dados.el.elements.namedItem('price')?.closest('label')?.querySelector('span')?.insertAdjacentHTML('beforeend', ` ${REQ}`);
  const fechar = () => { clearTimeout(tm); dlg.close(); };
  $('#cm-fechar', dlg).onclick = fechar;
  // o item já saiu da fila (409): avisa, fecha e atualiza a lista
  const jaTratado = async (err) => { fechar(); aviso(err.message, true); await histIr({ tipo: 'espelhamento', regra: ESP_H.regra, status: ESP_H.status }); };
  $('#cm-enviar', dlg).onclick = tentar(async () => {
    const erros = dados.erros();
    if (!erros.length && dados.valores().price == null) erros.push({ msg: C.faltaPreco, el: dados.el.elements.namedItem('price') });
    if (mostrarErros(corpo, erros)) return;
    const btn = $('#cm-enviar', dlg); btn.disabled = true; btn.textContent = C.enviando;
    try { await dispApi(`/espelhos/itens/${itemId}/enviar`, { method: 'POST', body: { ajustes: dados.ajustes() } }); } catch (err) {
      if (err.status === 409) return jaTratado(err);
      btn.disabled = false; btn.textContent = C.enviar(n); mostrarErros(corpo, [{ msg: err.message }]); return;
    }
    fechar(); aviso(C.enviada(n)); await histIr({ tipo: 'espelhamento', regra: ESP_H.regra, status: ESP_H.status });
  });
  $('#cm-descartar', dlg).onclick = tentar(async () => {
    if (!confirm(C.confirmaDescartar)) return;
    try { await dispApi(`/espelhos/itens/${itemId}/descartar`, { method: 'POST' }); } catch (err) {
      if (err.status === 409) return jaTratado(err);
      mostrarErros(corpo, [{ msg: err.message }]); return;
    }
    fechar(); aviso(C.descartada); await histIr({ tipo: 'espelhamento', regra: ESP_H.regra, status: ESP_H.status });
  });
  dlg.showModal(); dados.el.elements.namedItem('title')?.focus();
}
