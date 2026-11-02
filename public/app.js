const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Imita a formatação do WhatsApp na prévia: *negrito*, ~riscado~, _itálico_
const zap = (t) => esc(t).replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>').replace(/~([^~\n]+)~/g, '<s>$1</s>').replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
const S = { st: null, tags: [], templates: [], groups: [], rules: [], blocks: [] };
let ultimoQr = null; let editando = null;

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.replace('/login.html'); throw new Error('Sessão expirada. Entre de novo.'); }
  if (!r.ok) throw new Error(j.erro || 'Erro ' + r.status);
  return j;
}
function aviso(msg, erro = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'mostra' + (erro ? ' erro' : '');
  clearTimeout(aviso.t); aviso.t = setTimeout(() => (t.className = ''), erro ? 6000 : 2500);
}
const tentar = (fn) => async (...a) => { try { await fn(...a); } catch (e) { aviso(e.message, true); } };
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
  if (!r.enabled) return 'Pausada';
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
    <h2><label class="chave" title="Ligar ou pausar"><input type="checkbox" data-act="ligar" ${r.enabled ? 'checked' : ''} aria-label="Regra ativa"><span></span></label>
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
const resumoFonte = (f) => f.type === 'afiliados' ? fonteAfiliados(f.config)
  : f.type === 'search' ? `busca por “${esc(f.config?.query || '')}”` : `${String(f.config?.items || '').split('\n').filter((l) => /^https?:/i.test(l.trim())).length} links na lista`;
const categoriasDe = (c = {}) => Array.isArray(c.categorias) ? c.categorias : c.categoria ? [c.categoria] : [];
function fonteAfiliados(c = {}) {
  const nomes = categoriasDe(c).map((id) => S.st.afiliados?.categorias.find((x) => x.id === id)?.name).filter(Boolean);
  const cats = nomes.length > 3 ? `${nomes.length} categorias` : nomes.map(esc).join(' + ');
  const partes = [c.busca ? `“${esc(c.busca)}”` : '', cats, c.mais_vendidos ? 'mais vendidos' : '', c.ganhos_extras ? 'ganhos extras' : ''].filter(Boolean);
  return `Central de Afiliados${partes.length ? ' (' + partes.join(', ') + ')' : ''}`;
}
function paginaRegras() {
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Regras de envio</h1>
    <p class="sub">Cada regra escolhe uma etiqueta, os grupos, o template e o ritmo. Você pode ter quantas quiser, cada uma com a sua etiqueta.</p></div>
    <button class="pri" id="nova">Nova regra</button></div><div id="lista"></div>`;
  $('#nova').onclick = () => formRegra();
  listaRegras();
  $('#lista').onclick = tentar(async (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    const id = Number(b.closest('[data-id]').dataset.id); const r = S.rules.find((x) => x.id === id); const act = b.dataset.act;
    if (act === 'ligar') { await api(`/rules/${id}/enabled`, 'POST', { enabled: b.checked }); aviso(b.checked ? 'Regra ligada' : 'Regra pausada'); await recarregarRegras(); }
    if (act === 'rodar') { await api(`/rules/${id}/run`, 'POST'); aviso('Envio iniciado. Acompanhe no Histórico.'); setTimeout(recarregarRegras, 800); }
    if (act === 'editar') formRegra(r);
    if (act === 'ver') verOfertas(r);
    if (act === 'zerar' && confirm('Limpar a lista de ofertas já enviadas desta regra?')) { await api(`/rules/${id}/reset-sent`, 'POST'); aviso('Lista limpa'); }
    if (act === 'excluir' && confirm(`Excluir a regra “${r.name}”?`)) { await api(`/rules/${id}`, 'DELETE'); await recarregarRegras(); }
  });
}
function listaRegras() {
  const el = $('#lista'); if (!el) return;
  el.innerHTML = S.rules.length ? S.rules.map(cartaoRegra).join('')
    : '<div class="vazio">Nenhuma regra ainda. Cadastre uma etiqueta, conecte o WhatsApp e crie a primeira regra.</div>';
}
async function recarregarRegras() { S.rules = await api('/rules'); listaRegras(); }

function opcoes(lista, sel, vazio) {
  return (vazio ? `<option value="">${vazio}</option>` : '') + lista.map((o) => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
}
function fonteHtml(f, i, total) {
  const sc = f.config || {}; const catsSel = new Set(categoriasDe(sc));
  return `<div class="fonte sub-campo" data-i="${i}" style="margin-bottom:10px"><legend>Fonte ${i + 1}${total > 1 ? '' : ''} ${total > 1 ? `<button type="button" data-rm-fonte class="leve perigo" style="float:right;padding:2px 8px">Remover</button>` : ''}</legend>
    <div class="linha"><label><input type="radio" name="st${i}" value="afiliados" ${f.type === 'afiliados' ? 'checked' : ''} style="width:auto"> Central de Afiliados</label>
      <label><input type="radio" name="st${i}" value="list" ${f.type === 'list' ? 'checked' : ''} style="width:auto"> Lista de links</label>
      <label><input type="radio" name="st${i}" value="search" ${f.type === 'search' ? 'checked' : ''} style="width:auto"> Busca por palavra-chave (experimental)</label></div>
    <div class="f-afiliados"><div class="grade">
      <label class="campo">Buscar por (opcional)<input name="af_busca" value="${esc(sc.busca || '')}" placeholder="Ex.: organizador, air fryer"></label>
      <label class="campo">Ordem<select name="af_ordem">${(S.st.afiliados?.ordens || []).map((o) => `<option value="${o.id}" ${o.id === sc.ordem ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>
      <label class="campo">Páginas lidas por envio<input name="af_paginas" type="number" min="1" max="10" value="${sc.paginas ?? 3}"><small>Cada página traz ${S.st.afiliados?.por_pagina || 18} produtos.</small></label></div>
      <fieldset class="sub-campo"><legend>Categorias <span class="dica af-cont"></span></legend>
        <div class="grupos cats af-cats">${(S.st.afiliados?.categorias || []).map((c) => `<label><input type="checkbox" value="${c.id}" ${catsSel.has(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('')}</div>
        <small>Nenhuma marcada = todas. Com várias, as ofertas saem intercaladas (uma de cada categoria por vez).</small></fieldset>
      <div class="linha"><label><input type="checkbox" name="af_mais_vendidos" ${sc.mais_vendidos ? 'checked' : ''} style="width:auto"> Só mais vendidos</label>
        <label><input type="checkbox" name="af_ganhos_extras" ${sc.ganhos_extras ? 'checked' : ''} style="width:auto"> Só com ganhos extras</label></div>
      <small class="dica">É a lista “Produtos selecionados para você” da sua Central de Afiliados. A extensão do Chrome busca a lista e gera cada link meli.la com a etiqueta desta regra.</small></div>
    <div class="f-list"><label class="campo">Um produto por linha<textarea name="items" class="mono" rows="5" placeholder="https://produto.mercadolivre.com.br/MLB-123...&#10;https://produto.mercadolivre.com.br/MLB-456... | Fone Bluetooth | 89,90 | 149,90 | CUPOM10">${esc(sc.items || '')}</textarea>
      <small>Formato opcional: link | título | preço | preço antigo | cupom. Se o título e o preço não forem lidos sozinhos, escreva-os aqui.</small></label></div>
    <div class="f-search grade"><label class="campo">Palavra-chave<input name="query" value="${esc(sc.query || '')}" placeholder="Ex.: air fryer"></label>
      <label class="campo">Ordem<select name="sort"><option value="relevance">Relevância</option><option value="price_asc" ${sc.sort === 'price_asc' ? 'selected' : ''}>Menor preço</option><option value="price_desc" ${sc.sort === 'price_desc' ? 'selected' : ''}>Maior preço</option></select></label></div></div>`;
}
function formRegra(r) {
  const nova = !r;
  r = r || { name: '', enabled: true, tag_id: S.tags[0]?.id, template_id: S.templates[0]?.id, group_jids: [], sources: [{ type: 'afiliados', config: { paginas: 3 } }],
    per_run: 3, interval_min: 60, window_start: '08:00', window_end: '22:00', dedupe_days: 7, send_image: true };
  const sel = new Set(r.group_jids); const dlg = $('#dlg');
  const fontes = (r.sources?.length ? r.sources : [{ type: r.source_type || 'afiliados', config: r.source_config || {} }]).map((f) => ({ type: f.type, config: { ...(f.config || {}) } }));
  const MAXF = S.st.max_fontes || 5;
  dlg.innerHTML = `<form method="dialog" id="f"><h1>${nova ? 'Nova regra' : 'Editar regra'}</h1>
    <div class="grade">
      <label class="campo">Nome da regra<input name="name" value="${esc(r.name)}" placeholder="Ex.: Tecnologia" required></label>
      <label class="campo">Etiqueta de afiliado<select name="tag_id">${opcoes(S.tags, r.tag_id, 'Escolha…')}</select>
        ${S.tags.length ? '' : '<small>Cadastre uma etiqueta em “Etiquetas”.</small>'}</label>
      <label class="campo">Template<select name="template_id">${opcoes(S.templates, r.template_id)}</select></label></div>
    <fieldset><legend>De onde vêm as ofertas <span class="dica" id="f-cont"></span></legend>
      <div id="fontes"></div>
      <div class="linha"><button type="button" id="add-fonte">+ Adicionar fonte</button><small class="dica">Até ${MAXF} fontes por regra. Com mais de uma, as ofertas saem intercaladas (uma de cada fonte por vez). Um grupo também pode estar em várias regras.</small></div></fieldset>
    <fieldset><legend>Filtros</legend><div class="grade">
      <label class="campo">Preço mínimo (R$)<input name="min_price" type="number" step="0.01" min="0" value="${r.min_price ?? ''}" placeholder="Sem mínimo"></label>
      <label class="campo">Preço máximo (R$)<input name="max_price" type="number" step="0.01" min="0" value="${r.max_price ?? ''}" placeholder="Sem máximo"></label>
      <label class="campo">Desconto mínimo (%)<input name="min_discount" type="number" min="0" max="99" value="${r.min_discount ?? ''}" placeholder="Qualquer"></label></div></fieldset>
    <fieldset><legend>Grupos que vão receber <span id="cont" class="dica"></span></legend>
      ${S.groups.length ? `<div class="linha">${S.blocks?.length ? `<select id="bloco-atalho" style="width:auto"><option value="">Marcar um bloco…</option>${S.blocks.map((b) => `<option value="${b.id}">${esc(b.name)} (${b.group_jids.length})</option>`).join('')}</select>` : ''}<input id="busca" placeholder="Buscar grupo…" style="flex:1"><button type="button" id="todos">Marcar visíveis</button><button type="button" id="nenhum">Limpar</button></div>
      <div class="grupos" id="gr">${S.groups.map((g) => `<label data-n="${esc(g.name.toLowerCase())}"><input type="checkbox" value="${esc(g.jid)}" ${sel.has(g.jid) ? 'checked' : ''}>${esc(g.name)}<small>${g.size ?? ''}</small></label>`).join('')}</div>`
        : '<div class="dica">Nenhum grupo carregado. Conecte o WhatsApp na aba “WhatsApp e grupos”.</div>'}</fieldset>
    <fieldset><legend>Ritmo de envio</legend><div class="grade">
      <label class="campo">Ofertas por envio<input name="per_run" type="number" min="1" max="20" value="${r.per_run}"><small>Cada oferta vai para todos os grupos, uma atrás da outra.</small></label>
      <label class="campo">Intervalo entre envios (minutos)<input name="interval_min" type="number" min="1" value="${r.interval_min}"></label>
      <label class="campo">Funciona das<input name="window_start" type="time" value="${esc(r.window_start)}"></label>
      <label class="campo">Até<input name="window_end" type="time" value="${esc(r.window_end)}"></label>
      <label class="campo">Não repetir a mesma oferta por (dias)<input name="dedupe_days" type="number" min="0" value="${r.dedupe_days}"><small>0 = pode repetir.</small></label>
      <label class="campo">Foto do produto<select name="send_image"><option value="1">Enviar com foto, quando houver</option><option value="0" ${r.send_image ? '' : 'selected'}>Só texto</option></select></label></div></fieldset>
    <div class="rodape"><button type="button" id="cancelar">Cancelar</button><button class="pri" id="salvar">${nova ? 'Criar regra' : 'Salvar'}</button></div></form>`;
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
      fontes[i] = { type: t, config: t === 'afiliados'
        ? { busca: v('af_busca'), categorias: $$('.af-cats input:checked', el).map((c) => c.value), ordem: v('af_ordem'), paginas: Number(v('af_paginas')) || 3, mais_vendidos: !!$('[name=af_mais_vendidos]', el).checked, ganhos_extras: !!$('[name=af_ganhos_extras]', el).checked }
        : t === 'list' ? { items: v('items') } : { query: v('query'), sort: v('sort') } };
    });
  };
  pintaFontes();
  $('#add-fonte').onclick = () => { lerFontes(); if (fontes.length < MAXF) fontes.push({ type: 'afiliados', config: { paginas: 3 } }); pintaFontes(); };
  const conta = () => { const n = $$('#gr input:checked', dlg).length; const c = $('#cont'); if (c) c.textContent = `(${n} selecionados)`; };
  if ($('#gr')) {
    $('#gr').onchange = conta; conta();
    $('#busca').oninput = (e) => $$('#gr label').forEach((l) => (l.hidden = !l.dataset.n.includes(e.target.value.toLowerCase())));
    $('#todos').onclick = () => { $$('#gr label:not([hidden]) input').forEach((i) => (i.checked = true)); conta(); };
    $('#nenhum').onclick = () => { $$('#gr input').forEach((i) => (i.checked = false)); conta(); };
    if ($('#bloco-atalho')) $('#bloco-atalho').onchange = (e) => {
      const b = S.blocks.find((x) => String(x.id) === e.target.value); if (!b) return;
      $$('#gr input').forEach((i) => { if (b.group_jids.includes(i.value)) i.checked = true; });
      if (b.tag_id) $('select[name=tag_id]', dlg).value = b.tag_id;
      conta(); e.target.value = '';
    };
  }
  $('#cancelar').onclick = () => dlg.close();
  $('#f').onsubmit = tentar(async (ev) => {
    ev.preventDefault(); const f = new FormData($('#f'));
    const g = (k) => f.get(k);
    const corpo = {
      name: g('name'), tag_id: g('tag_id') || null, template_id: g('template_id') || null,
      group_jids: $$('#gr input:checked', dlg).map((i) => i.value), sources: (lerFontes(), fontes),
      min_price: g('min_price'), max_price: g('max_price'), min_discount: g('min_discount'),
      per_run: g('per_run'), interval_min: g('interval_min'), window_start: g('window_start'), window_end: g('window_end'),
      dedupe_days: g('dedupe_days'), send_image: g('send_image') === '1', enabled: nova ? true : r.enabled,
    };
    if (!corpo.tag_id) throw new Error('Escolha uma etiqueta.');
    await api(nova ? '/rules' : `/rules/${r.id}`, nova ? 'POST' : 'PUT', corpo);
    dlg.close(); aviso(nova ? 'Regra criada' : 'Regra salva'); await recarregarRegras();
  });
  dlg.showModal();
}
async function verOfertas(r) {
  const dlg = $('#dlg'); dlg.innerHTML = '<div class="corpo"><h1>Próximas ofertas</h1><p class="dica">Buscando…</p></div>'; dlg.showModal();
  try {
    const of = await api(`/rules/${r.id}/offers`);
    dlg.innerHTML = `<div class="corpo"><h1>Próximas ofertas de “${esc(r.name)}”</h1>
      <p class="dica">É o que sairia no próximo envio, nesta ordem. O link meli.la só é gerado na hora de enviar.</p>
      ${of.length ? `<div class="chat">${of.map((o) => `<div class="balao">${zap(o.text)}${o.comissao ? `<small class="dica" style="display:block;margin-top:6px">${esc(o.comissao)}${o.destaque ? ' · ' + esc(o.destaque) : ''}</small>` : ''}</div>`).join('')}</div>` : '<div class="vazio">Nenhuma oferta nova dentro dos filtros. Veja o Histórico para o motivo.</div>'}
      <div class="rodape"><button id="fechar" class="pri">Fechar</button></div></div>`;
  } catch (e) {
    dlg.innerHTML = `<div class="corpo"><h1>Não consegui buscar</h1><p>${esc(e.message)}</p><div class="rodape"><button id="fechar" class="pri">Fechar</button></div></div>`;
  }
  $('#fechar').onclick = () => dlg.close();
}

// ---------- etiquetas ----------
function paginaEtiquetas() {
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Etiquetas de afiliado</h1>
    <p class="sub">Cadastre aqui os nomes das suas etiquetas do programa de afiliados do Mercado Livre, escritos exatamente como aparecem lá. Depois escolha qual usar em cada regra.</p></div></div>
    <form class="card" id="nt"><div class="linha"><input name="name" placeholder="Ex.: achadosdesejo" required style="flex:1;min-width:200px" aria-label="Nome da etiqueta">
      <input name="note" placeholder="Anotação (opcional)" style="flex:1;min-width:200px" aria-label="Anotação"><button class="pri">Adicionar etiqueta</button></div></form>
    ${S.tags.length ? `<div class="card tabela"><table><thead><tr><th>Etiqueta</th><th>Anotação</th><th>Usada em</th><th></th></tr></thead><tbody>
      ${S.tags.map((t) => { const uso = S.rules.filter((r) => r.tag_id === t.id).length; return `<tr><td><span class="chip etq">${esc(t.name)}</span></td><td>${esc(t.note)}</td><td>${uso} ${uso === 1 ? 'regra' : 'regras'}</td><td style="text-align:right"><button class="perigo leve" data-del="${t.id}">Excluir</button></td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="vazio">Nenhuma etiqueta cadastrada.</div>'}`;
  $('#nt').onsubmit = tentar(async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target);
    await api('/tags', 'POST', { name: f.get('name'), note: f.get('note') }); S.tags = await api('/tags'); aviso('Etiqueta adicionada'); paginaEtiquetas();
  });
  $$('[data-del]').forEach((b) => (b.onclick = tentar(async () => { await api('/tags/' + b.dataset.del, 'DELETE'); S.tags = await api('/tags'); paginaEtiquetas(); })));
}

// ---------- templates ----------
function paginaTemplates(id) {
  const t = S.templates.find((x) => x.id === id) || S.templates[0]; editando = t?.id ?? null;
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Templates</h1><p class="sub">O texto da mensagem. Linha com campo vazio (por exemplo, sem cupom) some sozinha. O {LINK} é obrigatório.</p></div>
    <button id="novoT" class="pri">Novo template</button></div>
    <div class="modelos">${S.templates.map((x) => `<button data-id="${x.id}" class="${x.id === t.id ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div>
    <div class="editor"><div class="card" style="display:grid;gap:12px">
      <label class="campo">Nome<input id="tn" value="${esc(t.name)}"></label>
      <label class="campo">Mensagem<textarea id="tb" class="mono" rows="12">${esc(t.body)}</textarea></label>
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
  $('#sv').onclick = tentar(async () => { await api('/templates/' + t.id, 'PUT', { name: $('#tn').value, body: tb.value }); S.templates = await api('/templates'); aviso('Template salvo'); paginaTemplates(t.id); });
  $('#dl').onclick = tentar(async () => { if (!confirm('Excluir este template?')) return; await api('/templates/' + t.id, 'DELETE'); S.templates = await api('/templates'); paginaTemplates(); });
}

// ---------- WhatsApp ----------
function paginaWhatsapp() {
  const w = S.st.whatsapp; let corpo;
  if (w.status === 'open') {
    corpo = `<div class="card"><h2>Conectado</h2><p class="sub">Número: ${esc(String(w.me || '').split(':')[0].split('@')[0])}. ${S.groups.length} grupos encontrados.</p>
      <div class="acoes" style="border:0;padding:0"><button id="sync">Atualizar lista de grupos</button><button id="sair" class="perigo">Desconectar</button></div></div>
      ${tabelaGrupos(S.groups)}`;
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
  $('#pagina').innerHTML = `<div class="topo"><div><h1>WhatsApp e grupos</h1><p class="sub">Este número envia as ofertas. Para reduzir o risco de bloqueio, use as pausas em Ajustes e prefira um número que você não precise muito.</p></div></div>${corpo}`;
  if ($('#conectar')) $('#conectar').onclick = tentar(async () => { await api('/wa/connect', 'POST'); await atualizarEstado(true); });
  if ($('#sync')) $('#sync').onclick = tentar(async () => { await api('/wa/sync-groups', 'POST'); S.groups = await api('/groups'); aviso('Grupos atualizados'); paginaWhatsapp(); });
  if ($('#sair')) $('#sair').onclick = tentar(async () => { if (!confirm('Desconectar o WhatsApp deste programa?')) return; await api('/wa/logout', 'POST'); S.groups = []; await atualizarEstado(true); });
}

// ---------- histórico ----------
async function paginaHistorico(nivel = '') {
  const log = await api('/log' + (nivel ? `?nivel=${nivel}` : ''));
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Histórico</h1><p class="sub">Tudo que foi enviado e tudo que deu errado, com o motivo.</p></div>
    <select id="nv" style="width:auto" aria-label="Filtrar"><option value="">Tudo</option><option value="ok" ${nivel === 'ok' ? 'selected' : ''}>Só enviados</option><option value="erro" ${nivel === 'erro' ? 'selected' : ''}>Só erros</option><option value="aviso" ${nivel === 'aviso' ? 'selected' : ''}>Só avisos</option></select></div>
    ${log.length ? `<div class="card tabela"><table><thead><tr><th>Quando</th><th>Regra</th><th>Grupo</th><th>Oferta</th><th>Resultado</th></tr></thead><tbody>
    ${log.map((l) => `<tr><td>${hora(l.ts)}</td><td>${esc(l.rule_name || '')}</td><td>${esc(l.group_name || '')}</td><td>${esc(l.offer_title || '')}</td><td><span class="nivel-${l.level}">${esc(l.message)}</span></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="vazio">Nada por aqui ainda.</div>'}`;
  $('#nv').onchange = (e) => paginaHistorico(e.target.value);
  clearTimeout(paginaHistorico.t); paginaHistorico.t = setTimeout(() => { if (location.hash === '#historico' && !$('#dlg').open) paginaHistorico($('#nv')?.value || ''); }, 6000);
}

// ---------- ajustes ----------
function paginaAjustes() {
  const a = S.st.ajustes; const url = S.st.endereco_publico || `http://127.0.0.1:${S.st.porta}`;
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Ajustes</h1></div></div>
    <div class="card" style="display:grid;gap:14px"><div><h2>Pausas entre mensagens</h2><p class="sub">Pausas curtas demais parecem robô. O programa varia o tempo para mais ou para menos, de forma aleatória.</p></div>
      <div class="grade"><label class="campo">Entre um grupo e outro (segundos)<input id="dg" type="number" min="2" value="${a.delay_group_s}"></label>
      <label class="campo">Entre uma oferta e a próxima (segundos)<input id="do" type="number" min="5" value="${a.delay_offer_s}"></label></div>
      <div><button class="pri" id="sa">Salvar pausas</button></div></div>
    <div class="card" style="display:grid;gap:14px"><div><h2>Como gerar o link de afiliado</h2></div>
      <label class="campo"><select id="lm"><option value="extension">Pela extensão do Chrome (com a etiqueta, gera comissão)</option>
        <option value="direct" ${a.link_mode === 'direct' ? 'selected' : ''}>Link direto, sem etiqueta (só para testar, não gera comissão)</option></select></label>
      <div><button id="sl">Salvar modo</button></div></div>
    <div class="card" style="display:grid;gap:12px"><div><h2>Conectar a extensão do Chrome</h2><p class="sub">Na extensão, clique no ícone e cole estes dois valores.</p></div>
      <label class="campo">Endereço<div class="copia"><input readonly value="${url}" id="c1"><button data-c="c1">Copiar</button></div></label>
      <label class="campo">Token<div class="copia"><input readonly value="${esc(S.st.ext_token)}" id="c2"><button data-c="c2">Copiar</button></div></label>
      <p class="dica">Último link gerado: ${S.st.extensao.lastOkAt ? hora(S.st.extensao.lastOkAt) : 'nenhum ainda'}${S.st.extensao.lastError ? `. Último erro: ${esc(S.st.extensao.lastError)}` : ''}</p></div>`;
  $('#sa').onclick = tentar(async () => { await api('/ajustes', 'PUT', { delay_group_s: $('#dg').value, delay_offer_s: $('#do').value }); await atualizarEstado(); aviso('Pausas salvas'); });
  $('#sl').onclick = tentar(async () => { await api('/ajustes', 'PUT', { link_mode: $('#lm').value }); await atualizarEstado(); aviso('Modo salvo'); });
  $$('[data-c]').forEach((b) => (b.onclick = async () => { await navigator.clipboard.writeText($('#' + b.dataset.c).value); aviso('Copiado'); }));
}

// ---------- navegação e atualização ----------
const ROTAS = { visao: () => paginaVisao(), blocos: () => paginaBlocos(), links: () => paginaLinks(), regras: paginaRegras, etiquetas: paginaEtiquetas, templates: () => paginaTemplates(), whatsapp: paginaWhatsapp, historico: () => paginaHistorico(), ajustes: paginaAjustes };
function ir() {
  const r = (location.hash || '#visao').slice(1); const f = ROTAS[r] || paginaVisao;
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + r));
  f();
}
async function atualizarEstado(forcar) {
  const antes = JSON.stringify([S.st?.whatsapp?.status, S.st?.whatsapp?.qr]);
  S.st = await api('/state'); faixa();
  const depois = JSON.stringify([S.st.whatsapp.status, S.st.whatsapp.qr]);
  if (location.hash === '#whatsapp' && (forcar || antes !== depois)) {
    if (S.st.whatsapp.status === 'open') [S.groups, S.blocks] = await Promise.all([api('/groups'), api('/blocks')]);
    paginaWhatsapp();
  }
}
window.addEventListener('hashchange', ir);
carregar().then(() => {
  faixa(); ir();
  if (S.st.auth) { const b = $('#sair'); b.hidden = false; b.onclick = tentar(async () => { await api('/logout', 'POST'); location.replace('/login.html'); }); }
}).catch((e) => aviso(e.message, true));
setInterval(() => atualizarEstado().catch(() => {}), 3000);
setInterval(() => { if ((location.hash || '#regras') === '#regras' && !$('#dlg').open) recarregarRegras().catch(() => {}); }, 10000);
