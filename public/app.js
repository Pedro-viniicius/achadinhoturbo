const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Imita a formatação do WhatsApp na prévia: *negrito*, ~riscado~, _itálico_
const zap = (t) => esc(t).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>').replace(/~([^~\n]+)~/g, '<s>$1</s>').replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
const S = { st: null, tags: [], templates: [], groups: [], rules: [], blocks: [] };
let ultimoQr = null; let editando = null;

// Ações que só o Dono faz (o servidor responde 403 com este texto ao Operador). No lugar do botão escondido, uma dica.
const SO_DONO = 'Só o Dono pode fazer isso.';
const SO_DONO_DICA = { desconectar: 'Só o Dono pode desconectar o WhatsApp.', limpar: 'Só o Dono pode apagar agora o que passou do prazo.' };
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.replace('/login.html'); throw new Error('Sessão expirada. Entre de novo.'); }
  if (r.status === 403 && (!j.erro || j.erro === SO_DONO)) {
    // Perdeu a permissão (o Dono mudou o papel desta pessoa): avisa e redesenha o menu e a tela com o papel atual.
    aviso(SO_DONO, true);
    if (path !== '/state') atualizarEstado().catch(() => {});
    throw new Error(SO_DONO);
  }
  if (!r.ok) throw new Error(j.erro || 'Erro ' + r.status);
  return j;
}
function aviso(msg, erro = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'mostra' + (erro ? ' erro' : '');
  clearTimeout(aviso.t); aviso.t = setTimeout(() => (t.className = ''), erro ? 6000 : 2500);
}
const tentar = (fn) => async (...a) => { try { await fn(...a); } catch (e) { aviso(e.message, true); } };
// Campo obrigatório: asterisco vermelho ao lado do rótulo.
const REQ = '<b class="req" title="Obrigatório">*</b>';
/**
 * Mostra, antes do rodapé do formulário (ou no fim do contêiner), um card com o que falta e marca os campos.
 * erros = [{ msg, el? }]. Devolve true se havia erros (então não salve).
 */
function mostrarErros(container, erros) {
  $$('.invalido', container).forEach((e) => e.classList.remove('invalido'));
  let box = $('.erros', container);
  if (!erros.length) { box?.remove(); return false; }
  if (!box) { box = document.createElement('div'); box.className = 'erros'; box.setAttribute('role', 'alert'); const rod = $('.rodape', container); rod ? rod.parentNode.insertBefore(box, rod) : container.appendChild(box); }
  box.innerHTML = `<b>Antes de salvar, falta:</b><ul>${erros.map((e) => `<li>${esc(e.msg)}</li>`).join('')}</ul>`;
  erros.forEach((e) => e.el?.classList.add('invalido'));
  (erros.find((e) => e.el)?.el || box).scrollIntoView({ block: 'center', behavior: 'smooth' });
  erros.find((e) => e.el)?.el?.focus?.();
  return true;
}
const hora = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

async function carregar() {
  [S.st, S.tags, S.templates, S.groups, S.rules, S.blocks] = await Promise.all([
    api('/state'), api('/tags'), api('/templates'), api('/groups'), api('/rules'), api('/blocks')]);
}

// ---------- faixa de status ----------
function faixa() {
  const w = S.st.whatsapp; const e = S.st.extensao;
  const wTxt = { open: 'WhatsApp conectado', qr: 'WhatsApp aguardando leitura do QR', connecting: 'WhatsApp conectando…', idle: 'WhatsApp desconectado' }[w.status];
  const wCls = w.status === 'open' ? 'ok' : w.status === 'idle' ? '' : 'espera';
  const modo = S.st.ajustes.link_mode;
  $('#faixa').innerHTML =
    (S.st.simulacao ? '<span class="pilula sim">Modo simulação: nada é enviado de verdade</span>' : '') +
    `<span class="pilula ${wCls}"><i></i>${wTxt}</span>` +
    (modo === 'direct' ? '<span class="pilula espera"><i></i>Links sem etiqueta (modo direto)</span>'
      : `<span class="pilula ${e.online ? 'ok' : ''}"><i></i>${e.online ? 'Extensão do Chrome conectada' : 'Extensão do Chrome desconectada'}</span>`) +
    (S.st.propostas_pendentes ? `<a href="#links" class="pilula espera" style="text-decoration:none"><i></i>${S.st.propostas_pendentes} ${S.st.propostas_pendentes === 1 ? 'proposta de grupo novo' : 'propostas de grupo novo'}</a>` : '');
}

// ---------- regras ----------
function proximo(r) {
  if (r.em_andamento) return 'Enviando agora…';
  if (!r.enabled) return 'Pausado';
  if (!r.next_run_at) return 'Começa no próximo ciclo (até 15 s)';
  const d = r.next_run_at - Date.now();
  if (d <= 0) return 'Enviando em instantes';
  if (d < 120 * 60000) return `Próximo envio em ${Math.max(1, Math.round(d / 60000))} min`;
  return 'Próximo envio ' + new Date(r.next_run_at).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
function cartaoRegra(r) {
  const tag = S.tags.find((t) => t.id === r.tag_id); const tpl = S.templates.find((t) => t.id === r.template_id);
  const fontes = (r.sources?.length ? r.sources : [{ type: r.source_type, config: r.source_config }]).map(resumoFonte);
  const fonte = fontes.length === 1 ? fontes[0] : `${fontes.length} fontes intercaladas (${fontes.join('; ')})`;
  return `<article class="card regra" data-id="${r.id}">
    <h2><label class="chave" title="Ligar ou pausar"><input type="checkbox" data-act="ligar" ${r.enabled ? 'checked' : ''} aria-label="Disparo automático ativo"><span></span></label>
      ${esc(r.name)} ${tag ? `<span class="chip etq">${esc(tag.name)}</span>` : '<span class="chip">sem etiqueta</span>'}</h2>
    <p class="res">${r.per_run} ${r.per_run === 1 ? 'oferta' : 'ofertas'} a cada ${r.interval_min} min, das ${esc(r.window_start)} às ${esc(r.window_end)}, para ${r.group_jids.length} ${r.group_jids.length === 1 ? 'grupo' : 'grupos'}.
      Fonte: ${fonte}. Template: ${esc(tpl?.name || '—')}.</p>
    <div class="prox">${proximo(r)}</div>
    <div class="acoes">
      <button class="pri" data-act="rodar" ${r.em_andamento ? 'disabled' : ''}>Enviar agora</button>
      <button data-act="ver">Ver ofertas</button><button data-act="editar">Editar</button>
      <button data-act="zerar" class="leve" title="Permite que as ofertas já enviadas saiam de novo">Limpar “já enviadas”</button>
      <button data-act="excluir" class="perigo leve">Excluir</button></div></article>`;
}
const resumoFonte = (f) => (f.type === 'afiliados' ? fonteAfiliados(f.config)
  : f.type === 'search' ? `busca por “${esc(f.config?.query || '')}”` : `${String(f.config?.items || '').split('\n').filter((l) => /^https?:/i.test(l.trim())).length} links na lista`)
  + (f.tag_id && S.tags.find((t) => t.id === f.tag_id) ? ` · etiqueta ${esc(S.tags.find((t) => t.id === f.tag_id).name)}` : '');
const categoriasDe = (c = {}) => Array.isArray(c.categorias) ? c.categorias : c.categoria ? [c.categoria] : [];
function fonteAfiliados(c = {}) {
  const nomes = categoriasDe(c).map((id) => S.st.afiliados?.categorias.find((x) => x.id === id)?.name).filter(Boolean);
  const cats = nomes.length > 3 ? `${nomes.length} categorias` : nomes.map(esc).join(' + ');
  const partes = [c.busca ? `“${esc(c.busca)}”` : '', cats, c.mais_vendidos ? 'mais vendidos' : '', c.ganhos_extras ? 'ganhos extras' : ''].filter(Boolean);
  return `Central de Afiliados${partes.length ? ' (' + partes.join(', ') + ')' : ''}`;
}
function paginaRegras() {
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Disparo automático ${q('regras')}</h1>
    <p class="sub">Antes chamado de Regras. Cada disparo automático escolhe uma etiqueta, os grupos, o template e o ritmo. Pode ter quantos quiser.</p></div>
    <button class="pri" id="nova">Novo disparo automático</button></div><div id="lista"></div>`;
  $('#nova').onclick = () => formRegra();
  listaRegras();
  $('#lista').onclick = tentar(async (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    const id = Number(b.closest('[data-id]').dataset.id); const r = S.rules.find((x) => x.id === id); const act = b.dataset.act;
    if (act === 'ligar') { await api(`/rules/${id}/enabled`, 'POST', { enabled: b.checked }); aviso(b.checked ? 'Disparo automático ligado' : 'Disparo automático pausado'); await recarregarRegras(); }
    if (act === 'rodar') { await api(`/rules/${id}/run`, 'POST'); aviso('Envio iniciado. Acompanhe no Histórico.'); setTimeout(recarregarRegras, 800); }
    if (act === 'editar') formRegra(r);
    if (act === 'ver') verOfertas(r);
    if (act === 'zerar' && confirm('Limpar a lista de ofertas já enviadas deste disparo automático?')) { await api(`/rules/${id}/reset-sent`, 'POST'); aviso('Lista limpa'); }
    if (act === 'excluir' && confirm(`Excluir o disparo automático “${r.name}”?`)) { await api(`/rules/${id}`, 'DELETE'); await recarregarRegras(); }
  });
}
function listaRegras() {
  const el = $('#lista'); if (!el) return;
  el.innerHTML = S.rules.length ? S.rules.map(cartaoRegra).join('')
    : '<div class="vazio">Nenhum disparo automático ainda. Cadastre uma etiqueta em <a href="#conexoes">Conexões</a>, conecte o WhatsApp em <a href="#numeros">Números de WhatsApp</a> e crie o primeiro.</div>';
}
async function recarregarRegras() { S.rules = await api('/rules'); listaRegras(); }

function opcoes(lista, sel, vazio) {
  return (vazio ? `<option value="">${vazio}</option>` : '') + lista.map((o) => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
}
/** Lista de grupos (#gr) com busca (#busca) e o botão "Só marcados" (#so-marcados). Devolve a função que reaplica o filtro. */
function filtroGrupos(dlg, conta) {
  const busca = $('#busca', dlg); const so = $('#so-marcados', dlg);
  const aplica = () => {
    const q = (busca?.value || '').toLowerCase(); const soMarcados = so?.getAttribute('aria-pressed') === 'true';
    let n = 0;
    $$('#gr label', dlg).forEach((l) => { const marcado = $('input', l).checked; if (marcado) n++; l.hidden = !l.dataset.n.includes(q) || (soMarcados && !marcado); });
    if (so) { so.textContent = `Só marcados (${n})`; so.classList.toggle('on', soMarcados); }
    conta();
  };
  if (busca) busca.oninput = aplica;
  if (so) so.onclick = () => { so.setAttribute('aria-pressed', so.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); aplica(); };
  $('#gr', dlg).onchange = aplica; aplica();
  return aplica;
}
/**
 * Seletor de grupos reutilizável (Disparo automático, Blocos, Disparo manual, Disparar mensagem): busca,
 * "Só marcados", "Marcar visíveis", "Limpar" e, se pedido, o atalho "Marcar um bloco…".
 * opts = { selecionados: [jid], blocos: bool, marcarVisiveis: bool (padrão true) }.
 * Devolve { html, ligar(raiz, { contador, aoMudar, aoBloco }) → reaplica o filtro, marcados(raiz) → [jid] }.
 * Use um seletor por tela ou diálogo: as consultas valem dentro de `raiz`.
 */
function seletorGrupos(opts = {}) {
  const sel = new Set(opts.selecionados || []);
  const html = !S.groups.length
    ? '<div class="dica">Nenhum grupo carregado. Conecte o WhatsApp em <a href="#numeros">Números de WhatsApp</a>.</div>'
    : `<div class="linha">${opts.blocos && S.blocks?.length ? `<select id="bloco-atalho" style="width:auto" aria-label="Marcar os grupos de um bloco"><option value="">Marcar um bloco…</option>${S.blocks.map((b) => `<option value="${b.id}">${esc(b.name)} (${b.group_jids.length})</option>`).join('')}</select>` : ''}<input id="busca" placeholder="Buscar grupo…" aria-label="Buscar grupo" style="flex:1 1 180px;min-width:160px"><button type="button" id="so-marcados" class="alt" aria-pressed="false" title="Mostrar só os grupos marcados, para conferir e desmarcar">Só marcados</button>${opts.marcarVisiveis === false ? '' : '<button type="button" id="todos">Marcar visíveis</button>'}<button type="button" id="nenhum">Limpar</button></div>
      <div class="grupos" id="gr">${S.groups.map((g) => `<label data-n="${esc(g.name.toLowerCase())}"><input type="checkbox" value="${esc(g.jid)}" ${sel.has(g.jid) ? 'checked' : ''}>${esc(g.name)}<small>${g.size ?? ''}</small></label>`).join('')}</div>`;
  const marcados = (raiz) => $$('#gr input:checked', raiz).map((i) => i.value);
  const ligar = (raiz, { contador, aoMudar, aoBloco } = {}) => {
    if (!$('#gr', raiz)) return () => {};
    const aplica = filtroGrupos(raiz, () => { const n = marcados(raiz).length; if (contador) contador.textContent = `(${n} ${n === 1 ? 'selecionado' : 'selecionados'})`; aoMudar?.(n); });
    const todos = $('#todos', raiz);
    if (todos) todos.onclick = () => { $$('#gr label:not([hidden]) input', raiz).forEach((i) => (i.checked = true)); aplica(); };
    $('#nenhum', raiz).onclick = () => { $$('#gr input', raiz).forEach((i) => (i.checked = false)); aplica(); };
    const atalho = $('#bloco-atalho', raiz);
    if (atalho) atalho.onchange = () => {
      const b = S.blocks.find((x) => String(x.id) === atalho.value); if (!b) return;
      $$('#gr input', raiz).forEach((i) => { if (b.group_jids.includes(i.value)) i.checked = true; });
      aoBloco?.(b); aplica(); atalho.value = '';
    };
    return aplica;
  };
  return { html, ligar, marcados };
}
function fonteHtml(f, i, total) {
  const sc = f.config || {}; const catsSel = new Set(categoriasDe(sc));
  return `<div class="fonte sub-campo" data-i="${i}" style="margin-bottom:10px"><legend>Fonte ${i + 1}${total > 1 ? '' : ''} ${total > 1 ? `<button type="button" data-rm-fonte class="leve perigo" style="float:right;padding:2px 8px">Remover</button>` : ''}</legend>
    <div class="grade" style="margin-bottom:8px"><label class="campo"><span>Etiqueta desta fonte ${q('fonte.etiqueta')}</span><select name="src_tag"><option value="">A etiqueta padrão</option>${S.tags.map((t) => `<option value="${t.id}" ${t.id === f.tag_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label></div>
    <div class="linha">${q('fonte.tipos')}<label><input type="radio" name="st${i}" value="afiliados" ${f.type === 'afiliados' ? 'checked' : ''} style="width:auto"> Central de Afiliados</label>
      <label><input type="radio" name="st${i}" value="list" ${f.type === 'list' ? 'checked' : ''} style="width:auto"> Lista de links</label>
      <label><input type="radio" name="st${i}" value="search" ${f.type === 'search' ? 'checked' : ''} style="width:auto"> Busca por palavra-chave (experimental)</label></div>
    <div class="f-afiliados"><div class="grade">
      <label class="campo"><span>Buscar por (opcional) ${q('fonte.busca')}</span><input name="af_busca" value="${esc(sc.busca || '')}" placeholder="Ex.: organizador, air fryer"></label>
      <label class="campo">Ordem<select name="af_ordem">${(S.st.afiliados?.ordens || []).map((o) => `<option value="${o.id}" ${o.id === sc.ordem ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>
      <label class="campo"><span>Páginas lidas por envio ${q('fonte.paginas')}</span><input name="af_paginas" type="number" min="1" max="10" value="${esc(sc.paginas ?? 3)}"><small>Cada página traz ${S.st.afiliados?.por_pagina || 18} produtos.</small></label></div>
      <fieldset class="sub-campo"><legend>Categorias ${q('fonte.categorias')} <span class="dica af-cont"></span></legend>
        <div class="grupos cats af-cats">${(S.st.afiliados?.categorias || []).map((c) => `<label><input type="checkbox" value="${c.id}" ${catsSel.has(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('')}</div>
        <small>Nenhuma marcada = todas. Com várias, as ofertas saem intercaladas (uma de cada categoria por vez).</small></fieldset>
      <div class="linha"><label><input type="checkbox" name="af_mais_vendidos" ${sc.mais_vendidos ? 'checked' : ''} style="width:auto"> Só mais vendidos</label>${q('fonte.maisvendidos')}
        <label><input type="checkbox" name="af_ganhos_extras" ${sc.ganhos_extras ? 'checked' : ''} style="width:auto"> Só com ganhos extras</label>${q('fonte.ganhos')}</div>
      <small class="dica">É a lista “Produtos selecionados para você” da sua Central de Afiliados. A extensão do Chrome busca a lista e gera cada link meli.la com a etiqueta desta fonte (ou a padrão).</small></div>
    <div class="f-list"><label class="campo"><span>Um produto por linha ${REQ} ${q('fonte.lista')}</span><textarea name="items" class="mono" rows="5" placeholder="https://produto.mercadolivre.com.br/MLB-123...&#10;https://produto.mercadolivre.com.br/MLB-456... | Fone Bluetooth | 89,90 | 149,90 | CUPOM10">${esc(sc.items || '')}</textarea>
      <small>Formato opcional: link | título | preço | preço antigo | cupom. Se o título e o preço não forem lidos sozinhos, escreva-os aqui.</small></label></div>
    <div class="f-search grade"><label class="campo"><span>Palavra-chave ${REQ}</span><input name="query" value="${esc(sc.query || '')}" placeholder="Ex.: air fryer"></label>
      <label class="campo">Ordem<select name="sort"><option value="relevance">Relevância</option><option value="price_asc" ${sc.sort === 'price_asc' ? 'selected' : ''}>Menor preço</option><option value="price_desc" ${sc.sort === 'price_desc' ? 'selected' : ''}>Maior preço</option></select></label></div></div>`;
}
function formRegra(r) {
  const nova = !r;
  r = r || { name: '', enabled: true, tag_id: S.tags[0]?.id, template_id: S.templates[0]?.id, group_jids: [], sources: [{ type: 'afiliados', config: { paginas: 3 } }],
    per_run: 3, interval_min: 60, window_start: '08:00', window_end: '22:00', dedupe_days: 7, send_image: true };
  const grupos = seletorGrupos({ selecionados: r.group_jids, blocos: true }); const dlg = $('#dlg');
  const fontes = (r.sources?.length ? r.sources : [{ type: r.source_type || 'afiliados', config: r.source_config || {} }]).map((f) => ({ type: f.type, tag_id: f.tag_id ?? null, config: { ...(f.config || {}) } }));
  const MAXF = S.st.max_fontes || 5;
  dlg.innerHTML = `<form method="dialog" id="f" novalidate><h1>${nova ? 'Novo disparo automático' : 'Editar disparo automático'}</h1>
    <div class="grade">
      <label class="campo"><span>Nome ${REQ}</span><input name="name" value="${esc(r.name)}" placeholder="Ex.: Tecnologia" required></label>
      <label class="campo"><span>Etiqueta padrão ${REQ} ${q('regras.etiqueta')}</span><select name="tag_id">${opcoes(S.tags, r.tag_id, 'Escolha…')}</select>
        ${S.tags.length ? '' : '<small>Cadastre uma etiqueta em <a href="#conexoes">Conexões</a> (Mercado Livre).</small>'}</label>
      <label class="campo"><span>Template ${REQ} ${q('regras.template')}</span><select name="template_id">${opcoes(S.templates, r.template_id)}</select></label></div>
    <fieldset><legend>De onde vêm as ofertas ${REQ} ${q('regras.fontes')} <span class="dica" id="f-cont"></span></legend>
      <div id="fontes"></div>
      <div class="linha"><button type="button" id="add-fonte">+ Adicionar fonte</button><small class="dica">Até ${MAXF} fontes por disparo automático. Com mais de uma, as ofertas saem intercaladas (uma de cada fonte por vez). Um grupo também pode estar em vários disparos automáticos.</small></div></fieldset>
    <fieldset><legend>Filtros ${q('regras.filtros')}</legend><div class="grade">
      <label class="campo">Preço mínimo (R$)<input name="min_price" type="number" step="0.01" min="0" value="${r.min_price ?? ''}" placeholder="Sem mínimo"></label>
      <label class="campo">Preço máximo (R$)<input name="max_price" type="number" step="0.01" min="0" value="${r.max_price ?? ''}" placeholder="Sem máximo"></label>
      <label class="campo">Desconto mínimo (%)<input name="min_discount" type="number" min="0" max="99" value="${r.min_discount ?? ''}" placeholder="Qualquer"></label></div></fieldset>
    <fieldset><legend>Grupos que vão receber ${REQ} ${q('regras.grupos')} <span id="cont" class="dica"></span></legend>
      ${grupos.html}</fieldset>
    <fieldset><legend>Ritmo de envio</legend><div class="grade">
      <label class="campo"><span>Ofertas por envio ${REQ} ${q('regras.por_envio')}</span><input name="per_run" type="number" min="1" max="20" value="${r.per_run}"><small>Cada oferta vai para todos os grupos, uma atrás da outra.</small></label>
      <label class="campo"><span>Intervalo entre envios (minutos) ${REQ} ${q('regras.intervalo')}</span><input name="interval_min" type="number" min="1" value="${r.interval_min}"></label>
      <label class="campo"><span>Funciona das ${q('regras.janela')}</span><input name="window_start" type="time" value="${esc(r.window_start)}"></label>
      <label class="campo">Até<input name="window_end" type="time" value="${esc(r.window_end)}"></label>
      <label class="campo"><span>Não repetir a mesma oferta por (dias) ${q('regras.dedupe')}</span><input name="dedupe_days" type="number" min="0" value="${r.dedupe_days}"><small>0 = pode repetir.</small></label>
      <label class="campo"><span>Foto do produto ${q('regras.foto')}</span><select name="send_image"><option value="1">Enviar com foto, quando houver</option><option value="0" ${r.send_image ? '' : 'selected'}>Só texto</option></select></label></div></fieldset>
    <div class="rodape"><button type="button" id="cancelar">Cancelar</button><button class="pri" id="salvar">${nova ? 'Criar disparo automático' : 'Salvar'}</button></div></form>`;
  const pintaFontes = () => {
    $('#fontes').innerHTML = fontes.map((f, i) => fonteHtml(f, i, fontes.length)).join('');
    $('#f-cont').textContent = fontes.length > 1 ? `(${fontes.length} fontes)` : '';
    $('#add-fonte').hidden = fontes.length >= MAXF;
    $$('.fonte', dlg).forEach((el) => {
      const i = Number(el.dataset.i);
      const ajusta = () => { const t = $(`input[name=st${i}]:checked`, el).value; $('.f-afiliados', el).hidden = t !== 'afiliados'; $('.f-list', el).hidden = t !== 'list'; $('.f-search', el).hidden = t !== 'search'; };
      $$(`input[name=st${i}]`, el).forEach((r) => (r.onchange = ajusta)); ajusta();
      const conta = () => { const n = $$('.af-cats input:checked', el).length; $('.af-cont', el).textContent = n ? `(${n} marcadas)` : '(todas)'; };
      $('.af-cats', el).onchange = conta; conta();
      const rm = $('[data-rm-fonte]', el); if (rm) rm.onclick = () => { lerFontes(); fontes.splice(i, 1); pintaFontes(); };
    });
  };
  const lerFontes = () => {
    $$('.fonte', dlg).forEach((el) => {
      const i = Number(el.dataset.i); const v = (n) => $(`[name=${n}]`, el)?.value ?? ''; const t = $(`input[name=st${i}]:checked`, el).value;
      fontes[i] = { type: t, tag_id: Number(v('src_tag')) || null, config: t === 'afiliados'
        ? { busca: v('af_busca'), categorias: $$('.af-cats input:checked', el).map((c) => c.value), ordem: v('af_ordem'), paginas: Number(v('af_paginas')) || 3, mais_vendidos: !!$('[name=af_mais_vendidos]', el).checked, ganhos_extras: !!$('[name=af_ganhos_extras]', el).checked }
        : t === 'list' ? { items: v('items') } : { query: v('query'), sort: v('sort') } };
    });
  };
  pintaFontes();
  $('#add-fonte').onclick = () => { lerFontes(); if (fontes.length < MAXF) fontes.push({ type: 'afiliados', config: { paginas: 3 } }); pintaFontes(); };
  grupos.ligar(dlg, { contador: $('#cont', dlg), aoBloco: (b) => { if (b.tag_id) $('select[name=tag_id]', dlg).value = b.tag_id; } });
  $('#cancelar').onclick = () => dlg.close();
  $('#f').onsubmit = tentar(async (ev) => {
    ev.preventDefault(); const f = new FormData($('#f'));
    const g = (k) => f.get(k);
    const corpo = {
      name: g('name'), tag_id: g('tag_id') || null, template_id: g('template_id') || null,
      group_jids: grupos.marcados(dlg), sources: (lerFontes(), fontes),
      min_price: g('min_price'), max_price: g('max_price'), min_discount: g('min_discount'),
      per_run: g('per_run'), interval_min: g('interval_min'), window_start: g('window_start'), window_end: g('window_end'),
      dedupe_days: g('dedupe_days'), send_image: g('send_image') === '1', enabled: nova ? true : r.enabled,
    };
    const erros = [];
    if (!String(corpo.name || '').trim()) erros.push({ msg: 'Dê um nome ao disparo automático.', el: $('[name=name]', dlg) });
    if (!corpo.tag_id) erros.push({ msg: 'Escolha a etiqueta padrão (cadastre em Conexões > Mercado Livre se ainda não tiver).', el: $('[name=tag_id]', dlg) });
    if (!corpo.template_id) erros.push({ msg: 'Escolha um template.', el: $('[name=template_id]', dlg) });
    fontes.forEach((f, i) => {
      const el = $(`.fonte[data-i="${i}"]`, dlg);
      if (f.type === 'list' && !String(f.config.items || '').split('\n').some((l) => /^https?:/i.test(l.trim()))) erros.push({ msg: `Fonte ${i + 1}: cole ao menos um link de produto.`, el: $('textarea[name=items]', el) });
      if (f.type === 'search' && !String(f.config.query || '').trim()) erros.push({ msg: `Fonte ${i + 1}: digite a palavra-chave da busca.`, el: $('input[name=query]', el) });
    });
    if (!corpo.group_jids.length) erros.push({ msg: 'Marque ao menos um grupo que vai receber as ofertas.', el: $('#gr', dlg) });
    if (!(Number(corpo.per_run) >= 1 && Number(corpo.per_run) <= 20)) erros.push({ msg: 'Ofertas por envio: de 1 a 20.', el: $('[name=per_run]', dlg) });
    if (!(Number(corpo.interval_min) >= 1)) erros.push({ msg: 'Intervalo entre envios: ao menos 1 minuto.', el: $('[name=interval_min]', dlg) });
    if (mostrarErros(dlg, erros)) return;
    try { await api(nova ? '/rules' : `/rules/${r.id}`, nova ? 'POST' : 'PUT', corpo); } catch (e) { mostrarErros(dlg, [{ msg: e.message }]); return; }
    dlg.close(); aviso(nova ? 'Disparo automático criado' : 'Disparo automático salvo'); await recarregarRegras();
  });
  dlg.showModal();
}
async function verOfertas(r) {
  const dlg = $('#dlg'); dlg.innerHTML = '<div class="corpo"><h1>Próximas ofertas</h1><p class="dica">Buscando…</p></div>'; dlg.showModal();
  try {
    const of = await api(`/rules/${r.id}/offers`);
    dlg.innerHTML = `<div class="corpo"><h1>Próximas ofertas de “${esc(r.name)}”</h1>
      <p class="dica">É o que sairia no próximo envio, nesta ordem. O link meli.la só é gerado na hora de enviar.</p>
      ${of.length ? `<div class="chat">${of.map((o) => `<div class="balao">${o.etiqueta ? `<small class="dica" style="display:block;margin-bottom:6px">Fonte ${o.fonte} · etiqueta <b>${esc(o.etiqueta)}</b></small>` : ''}${zap(o.text)}${o.comissao ? `<small class="dica" style="display:block;margin-top:6px">${esc(o.comissao)}${o.destaque ? ' · ' + esc(o.destaque) : ''}</small>` : ''}</div>`).join('')}</div>` : '<div class="vazio">Nenhuma oferta nova dentro dos filtros. Veja o Histórico para o motivo.</div>'}
      <div class="rodape"><button id="fechar" class="pri">Fechar</button></div></div>`;
  } catch (e) {
    dlg.innerHTML = `<div class="corpo"><h1>Não consegui buscar</h1><p>${esc(e.message)}</p><div class="rodape"><button id="fechar" class="pri">Fechar</button></div></div>`;
  }
  $('#fechar').onclick = () => dlg.close();
}

// ---------- templates ----------
function paginaTemplates(id) {
  const t = S.templates.find((x) => x.id === id) || S.templates[0]; editando = t?.id ?? null;
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Templates ${q('templates')}</h1><p class="sub">O texto da mensagem. Linha com campo vazio (por exemplo, sem cupom) some sozinha. O {LINK} é obrigatório.</p></div>
    <button id="novoT" class="pri">Novo template</button></div>
    <div class="modelos">${S.templates.map((x) => `<button data-id="${x.id}" class="${x.id === t.id ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>
    <div class="editor"><div class="card" style="display:grid;gap:12px">
      <label class="campo"><span>Nome ${REQ}</span><input id="tn" value="${esc(t.name)}"></label>
      <label class="campo"><span>Mensagem ${REQ} <small class="dica">(precisa ter {LINK})</small></span><textarea id="tb" class="mono" rows="12">${esc(t.body)}</textarea></label>
      <div class="linha" id="chips">${S.st.placeholders.map((p) => `<button type="button" class="chip mono" data-p="${p}">{${p}}</button>`).join('')}</div>
      <small class="dica">Dica do WhatsApp: *negrito*, _itálico_, ~riscado~.</small>
      <div class="linha"><button class="pri" id="sv">Salvar template</button><button class="perigo leve" id="dl">Excluir</button></div></div>
      <div><h2>Como vai aparecer</h2><div class="chat"><div class="balao" id="pv"></div></div></div></div>`;
  const tb = $('#tb'); let tm;
  const prever = async () => { try { $('#pv').innerHTML = zap((await api('/templates/preview', 'POST', { body: tb.value })).texto); } catch { /* ignora */ } };
  tb.oninput = () => { clearTimeout(tm); tm = setTimeout(prever, 200); }; prever();
  $('#chips').onclick = (e) => { const p = e.target.dataset.p; if (!p) return; const a = tb.selectionStart; tb.setRangeText(`{${p}}`, a, tb.selectionEnd, 'end'); tb.focus(); prever(); };
  $$('.modelos button').forEach((b) => (b.onclick = () => paginaTemplates(Number(b.dataset.id))));
  $('#novoT').onclick = tentar(async () => { const r = await api('/templates', 'POST', { name: 'Novo template', body: S.templates[0].body }); S.templates = await api('/templates'); paginaTemplates(r.id); });
  $('#sv').onclick = tentar(async () => {
    const card = $('#sv').closest('.card'); const erros = [];
    if (!$('#tn').value.trim()) erros.push({ msg: 'Dê um nome ao template.', el: $('#tn') });
    if (!tb.value.includes('{LINK}')) erros.push({ msg: 'A mensagem precisa ter {LINK}, senão sai sem o link de afiliado.', el: tb });
    if (mostrarErros(card, erros)) return;
    try { await api('/templates/' + t.id, 'PUT', { name: $('#tn').value, body: tb.value }); } catch (e) { mostrarErros(card, [{ msg: e.message }]); return; }
    S.templates = await api('/templates'); aviso('Template salvo'); paginaTemplates(t.id);
  });
  $('#dl').onclick = tentar(async () => { if (!confirm('Excluir este template?')) return; await api('/templates/' + t.id, 'DELETE'); S.templates = await api('/templates'); paginaTemplates(); });
}

// ---------- Números de WhatsApp (conexão por QR, estado e desconectar) ----------
function paginaNumeros() {
  const w = S.st.whatsapp; let corpo;
  if (w.status === 'open') {
    corpo = `<div class="card"><h2>Conectado</h2><p class="sub">Número: ${esc(String(w.me || '').split(':')[0].split('@')[0])}. ${S.groups.length} ${S.groups.length === 1 ? 'grupo encontrado' : 'grupos encontrados'}, listados em <a href="#grupos">Grupos</a>.</p>
      <div class="acoes" style="border:0;padding:0">${podeEquipe() ? '<button id="desconectar" class="perigo">Desconectar</button>' : `<p class="dica" style="margin:0">${SO_DONO_DICA.desconectar}</p>`}</div></div>`;
  } else if (w.status === 'qr') {
    corpo = `<div class="card qr"><h2>Leia o QR no celular</h2><img src="${w.qr}" alt="QR Code para conectar o WhatsApp">
      <ol class="passos"><li>Abra o WhatsApp Business no celular.</li><li>Toque nos três pontos e em “Aparelhos conectados”.</li><li>Toque em “Conectar um aparelho” e aponte para este QR.</li></ol>
      <p class="dica">O código se renova sozinho a cada poucos segundos.</p></div>`;
  } else if (w.status === 'connecting') {
    corpo = '<div class="card"><h2>Conectando…</h2><p class="sub">Aguarde alguns segundos.</p></div>';
  } else {
    corpo = `<div class="card"><h2>Nenhum número conectado</h2><p class="sub">Você vai conectar o seu WhatsApp Business como “aparelho conectado”, igual ao WhatsApp Web. O celular continua funcionando normalmente.</p>
      ${w.error ? `<p style="color:var(--err)">${esc(w.error)}</p>` : ''}<button class="pri" id="conectar">Conectar WhatsApp</button></div>`;
  }
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Números de WhatsApp ${q('whatsapp')}</h1><p class="sub">Este número envia as ofertas. Para reduzir o risco de bloqueio, use as pausas em Ajustes e prefira um número que você não precise muito.</p></div></div>${corpo}`;
  if ($('#conectar')) $('#conectar').onclick = tentar(async () => { await api('/wa/connect', 'POST'); await atualizarEstado(true); });
  // id "desconectar", não "sair": #sair é o botão de sair do painel, no menu.
  if ($('#desconectar')) $('#desconectar').onclick = tentar(async () => {
    if (!confirm('Desconectar o WhatsApp deste programa?')) return;
    const apagar = confirm('Apagar também o histórico de entradas, saídas, leituras e cliques dos grupos? (recomendado se não for usar mais este número aqui)');
    await api('/wa/logout', 'POST', { apagar_eventos: apagar }); S.groups = []; await atualizarEstado(true);
  });
}

// ---------- Grupos (lista, convites e sincronização) ----------
function paginaGrupos() {
  const aberto = S.st.whatsapp.status === 'open';
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Grupos ${q('grupos')}</h1><p class="sub">Os grupos do número conectado, com membros, blocos e o link de convite que o Rotacionador de Links usa.</p></div>
    ${aberto ? '<button id="sync">Atualizar lista de grupos</button>' : ''}</div>
    ${aberto ? '' : '<div class="card"><h2>WhatsApp desconectado</h2><p class="sub">Conecte o número em <a href="#numeros">Números de WhatsApp</a> para atualizar a lista e buscar convites.</p></div>'}
    ${aberto || S.groups.length ? tabelaGrupos(S.groups) : ''}`;
  if ($('#sync')) $('#sync').onclick = tentar(async () => { await api('/wa/sync-groups', 'POST'); S.groups = await api('/groups'); aviso('Grupos atualizados'); paginaGrupos(); });
}

// ---------- histórico ----------
async function paginaHistorico(nivel = '') {
  const log = await api('/log' + (nivel ? `?nivel=${nivel}` : ''));
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Histórico ${q('historico')}</h1><p class="sub">Tudo que foi enviado e tudo que deu errado, com o motivo.</p></div>
    <select id="nv" style="width:auto" aria-label="Filtrar"><option value="">Tudo</option><option value="ok" ${nivel === 'ok' ? 'selected' : ''}>Só enviados</option><option value="erro" ${nivel === 'erro' ? 'selected' : ''}>Só erros</option><option value="aviso" ${nivel === 'aviso' ? 'selected' : ''}>Só avisos</option></select></div>
    ${log.length ? `<div class="card tabela"><table><thead><tr><th>Quando</th><th>Origem</th><th>Grupo</th><th>Oferta</th><th>Resultado</th></tr></thead><tbody>
    ${log.map((l) => `<tr><td>${hora(l.ts)}</td><td>${esc(l.rule_name || '')}</td><td>${esc(l.group_name || '')}</td><td>${esc(l.offer_title || '')}</td><td><span class="nivel-${l.level}">${esc(l.message)}</span></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="vazio">Nada por aqui ainda.</div>'}`;
  $('#nv').onchange = (e) => paginaHistorico(e.target.value);
  clearTimeout(paginaHistorico.t); paginaHistorico.t = setTimeout(() => { if (location.hash === '#historico' && !$('#dlg').open) paginaHistorico($('#nv')?.value || ''); }, 6000);
}

// ---------- ajustes ----------
function paginaAjustes() {
  const a = S.st.ajustes;
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Ajustes</h1></div></div>
    <div class="card" style="display:grid;gap:14px"><div><h2>Pausas entre mensagens ${q('ajustes.pausas')}</h2><p class="sub">Pausas curtas demais parecem robô. O programa varia o tempo para mais ou para menos, de forma aleatória.</p></div>
      <div class="grade"><label class="campo">Entre um grupo e outro (segundos)<input id="dg" type="number" min="2" value="${a.delay_group_s}"></label>
      <label class="campo">Entre uma oferta e a próxima (segundos)<input id="do" type="number" min="5" value="${a.delay_offer_s}"></label></div>
      <div><button class="pri" id="sa">Salvar pausas</button></div></div>
    <div class="card" style="display:grid;gap:14px"><div><h2>Título do produto na mensagem ${q('ajustes.titulo')}</h2><p class="sub">Os títulos do Mercado Livre vêm cheios de palavras-chave. {TITULO_PRODUTO} sai abreviado: só o que identifica o produto, sem “Compatível com…”, “Premium”, “Alta Qualidade”. Para o nome inteiro, use {TITULO_COMPLETO} no template.</p></div>
      <div class="grade"><label class="campo">Tamanho máximo (caracteres)<input id="tm" type="number" min="0" max="200" value="${a.titulo_max ?? 60}"><small>0 = não abreviar. Sugestão: 50 a 70.</small></label></div>
      <div class="linha"><button class="pri" id="st">Salvar</button><small class="dica" id="tm-ex"></small></div></div>
    <div class="card" style="display:grid;gap:14px"><div><h2>Como gerar o link de afiliado ${q('ajustes.modo_link')}</h2></div>
      <label class="campo"><select id="lm"><option value="extension">Pela extensão do Chrome (com a etiqueta, gera comissão)</option>
        <option value="direct" ${a.link_mode === 'direct' ? 'selected' : ''}>Link direto, sem etiqueta (só para testar, não gera comissão)</option></select></label>
      <div><button id="sl">Salvar modo</button></div></div>
    <div class="card" style="display:grid;gap:12px"><div><h2>Extensão do Chrome ${q('ajustes.extensao')}</h2><p class="sub">O endereço, o token e o estado da extensão ficam em Conexões, no cartão do Mercado Livre.</p></div>
      <div><a class="btn" href="#conexoes" style="text-decoration:none;display:inline-block">Ver em Conexões</a></div></div>
    <div class="card" style="display:grid;gap:14px"><div><h2>Privacidade dos grupos ${q('ajustes.privacidade')}</h2><p class="sub">Entradas, saídas e leituras são guardadas com um pseudônimo por pessoa (não o número) e apagadas depois do prazo abaixo. Cliques do rotacionador também.</p></div>
      <div class="grade"><label class="campo">Guardar por (dias)<input id="ret" type="number" min="0" max="3650" value="${a.retencao_dias ?? 90}"><small>0 = guardar para sempre (não recomendado).</small></label></div>
      <div class="linha"><button class="pri" id="sr">Salvar</button>${podeEquipe() ? '<button id="limpar-agora">Apagar o que já passou do prazo</button>' : `<small class="dica">${SO_DONO_DICA.limpar}</small>`}</div></div>`;
  $('#sr').onclick = tentar(async () => { await api('/ajustes', 'PUT', { retencao_dias: $('#ret').value }); await atualizarEstado(); aviso('Salvo'); });
  if ($('#limpar-agora')) $('#limpar-agora').onclick = tentar(async () => { const r = await api('/privacidade/limpar', 'POST'); aviso(`Apagados: ${r.eventos ?? 0} eventos, ${r.leituras ?? 0} leituras, ${r.cliques ?? 0} cliques`); });
  $('#sa').onclick = tentar(async () => { await api('/ajustes', 'PUT', { delay_group_s: $('#dg').value, delay_offer_s: $('#do').value }); await atualizarEstado(); aviso('Pausas salvas'); });
  const exemploTitulo = tentar(async () => { const r = await api('/templates/preview', 'POST', { body: '{TITULO_PRODUTO}', amostra: { title: 'Fones De Ouvido Usb-c Tipo C Com Microfone Integrado Som Estéreo Alta Qualidade Controle Chamadas Compatível Com iPhone 15 16 17 Android Samsung Premium' } }); $('#tm-ex').textContent = 'Exemplo: “' + r.texto + '”'; });
  exemploTitulo();
  $('#st').onclick = tentar(async () => { await api('/ajustes', 'PUT', { titulo_max: $('#tm').value }); await atualizarEstado(); aviso('Salvo'); exemploTitulo(); });
  $('#sl').onclick = tentar(async () => { await api('/ajustes', 'PUT', { link_mode: $('#lm').value }); await atualizarEstado(); aviso('Modo salvo'); });
}

// ---------- navegação e atualização ----------
// Uma rota por hash. As páginas novas ficam nos próprios arquivos (disparos.js, relatorios.js, conexoes.js,
// equipe.js, carregados antes deste); aqui a função só é procurada na hora de abrir a página.
const ROTAS = {
  visao: () => paginaVisao(), links: () => paginaLinks(), grupos: () => paginaGrupos(), blocos: () => paginaBlocos(),
  'disparo-manual': () => paginaDisparoManual(), 'disparo-automatico': () => paginaRegras(),
  'disparar-mensagem': () => paginaDispararMensagem(), templates: () => paginaTemplates(),
  relatorios: () => paginaRelatorios(),
  conexoes: (pedido) => paginaConexoes({ rolarPara: pedido === 'etiquetas' ? 'ml-etiquetas' : '' }),
  numeros: () => paginaNumeros(), equipe: () => paginaEquipe(),
  historico: () => paginaHistorico(), ajustes: () => paginaAjustes(), ajuda: () => paginaAjuda(),
};
// Endereços antigos continuam abrindo a página nova (favoritos, links da ajuda). #etiquetas rola até a seção em Conexões.
const ALIASES = { regras: 'disparo-automatico', whatsapp: 'numeros', etiquetas: 'conexoes' };
// Telas de duas colunas (formulário à esquerda, acompanhamento à direita) usam main.larga.
const ROTAS_LARGAS = new Set(['disparo-manual', 'disparar-mensagem']);
// Equipe é só do Dono. Sem login (auth desligada) usuario é null e o painel se comporta como Dono.
// O mesmo critério esconde do Operador: Desconectar (Números), Apagar agora (Ajustes) e Gerar novo token (Conexões).
const podeEquipe = () => !S.st?.usuario || S.st.usuario.papel === 'dono';
/** Rota que está aberta: resolve os nomes antigos e manda rota desconhecida (ou Equipe para o Operador) para a Visão Geral. */
function rotaAtual() {
  const pedido = (location.hash || '#visao').slice(1); const r = Object.hasOwn(ALIASES, pedido) ? ALIASES[pedido] : pedido;
  return Object.hasOwn(ROTAS, r) && (r !== 'equipe' || podeEquipe()) ? r : 'visao';
}
function ir() {
  const pedido = (location.hash || '#visao').slice(1); const r = rotaAtual();
  if (location.hash !== '#' + r) history.replaceState(null, '', '#' + r); // o endereço passa a mostrar a página aberta
  $$('#rail nav a').forEach((a) => { if (a.getAttribute('href') === '#' + r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#menu-atual').textContent = '· ' + ($(`#rail nav a[href="#${r}"]`)?.textContent || '');
  $('main').classList.toggle('larga', ROTAS_LARGAS.has(r));
  fecharMenu();
  const pg = $('#pagina'); pg.onclick = null; pg.innerHTML = ''; // tratadores da tela anterior não podem vazar para a próxima
  if ($('#dlg').open) $('#dlg').close();
  ROTAS[r](pedido);
}

// ---------- menu em telas estreitas (≤ 900 px): o botão "Menu" abre os grupos sobre o conteúdo ----------
const menuAberto = () => $('#rail').classList.contains('aberto');
function abrirMenu() { $('#rail').classList.add('aberto'); $('#menu-btn').setAttribute('aria-expanded', 'true'); }
function fecharMenu() {
  if (!menuAberto()) return;
  const rail = $('#rail'); const btn = $('#menu-btn'); const foco = document.activeElement;
  rail.classList.remove('aberto'); btn.setAttribute('aria-expanded', 'false');
  // O foco estava num item que agora some: volta ao botão. Não rouba o foco de um campo tocado fora do menu.
  if (!foco || foco === document.body || (rail.contains(foco) && foco !== btn)) btn.focus();
}
$('#menu-btn').onclick = () => (menuAberto() ? fecharMenu() : abrirMenu());
$('#rail').addEventListener('click', (e) => { if (e.target.closest('a')) fecharMenu(); }); // inclusive o item da página já aberta
document.addEventListener('click', (e) => { if (menuAberto() && !$('#rail').contains(e.target)) fecharMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuAberto()) fecharMenu(); });

// ---------- conta no menu: pessoa, "Sair" e o item Equipe (só para o Dono) ----------
function pintarConta() {
  const u = S.st.usuario; const p = $('#pessoa');
  const html = u ? `<b>${esc(u.nome || '')}</b>${esc(u.email || '')}` : '';
  if (p.innerHTML !== html) p.innerHTML = html;
  p.hidden = !u; $('#sair').hidden = !S.st.auth;
  // Para o Operador o item não fica escondido: sai do DOM.
  const item = $('#rail nav a[href="#equipe"]');
  if (podeEquipe() && !item) $('#ng-conta').parentElement.insertAdjacentHTML('beforeend', '<a href="#equipe">Equipe</a>');
  if (!podeEquipe() && item) item.remove();
  if (!podeEquipe() && location.hash === '#equipe') ir();
}
async function atualizarEstado(forcar) {
  const antes = S.st?.whatsapp || {}; const papelAntes = S.st?.usuario?.papel; const hashAntes = location.hash;
  S.st = await api('/state'); faixa(); pintarConta();
  // O Dono trocou o papel desta pessoa: redesenha a página aberta (botões só do Dono aparecem ou somem).
  // Se era a Equipe, pintarConta já levou para a Visão Geral (o endereço mudou).
  const papel = S.st.usuario?.papel;
  if (papelAntes && papel && papel !== papelAntes) { if (location.hash === hashAntes) ir(); return; }
  const w = S.st.whatsapp; const r = rotaAtual();
  const mudou = antes.status !== w.status;
  if ((r === 'numeros' && (forcar || mudou || antes.qr !== w.qr)) || (r === 'grupos' && (forcar || mudou))) {
    if (w.status === 'open') [S.groups, S.blocks] = await Promise.all([api('/groups'), api('/blocks')]);
    if (r === 'numeros') paginaNumeros(); else paginaGrupos();
  }
  if (r === 'conexoes') pintarEstadoML();
}
window.addEventListener('hashchange', ir);
carregar().then(() => {
  faixa(); pintarConta(); ir();
  $('#sair').onclick = tentar(async () => { await api('/logout', 'POST'); location.replace('/login.html'); });
  if (S.st.usuario?.precisa_completar) completarCadastro();
}).catch((e) => aviso(e.message, true));
setInterval(() => atualizarEstado().catch(() => {}), 3000);
setInterval(() => { if (rotaAtual() === 'disparo-automatico' && !$('#dlg').open) recarregarRegras().catch(() => {}); }, 10000);
