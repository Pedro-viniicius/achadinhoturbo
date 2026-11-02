// Páginas: Visão Geral, Blocos de análise, Rotacionador de Links e a tabela de grupos.
// Usa os utilitários globais de app.js ($, $$, esc, api, aviso, tentar, hora, S).

const PERIODOS = [['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', '7 dias'], ['30d', '30 dias'], ['mes', 'Mês atual'], ['mes_passado', 'Mês passado']];
const V = { periodo: 'hoje', bloco: '' };
const fmtPct = (p) => (p == null ? '—' : p.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%');
const fmtMin = (m) => (m == null ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`);
const dataBR = (ymd) => String(ymd).split('-').reverse().slice(0, 2).join('/');
const dataHora = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const nomeGrupo = (jid) => S.groups.find((g) => g.jid === jid)?.name || jid;

// ---------- Visão Geral ----------
async function paginaVisao() {
  $('#pagina').innerHTML = '<div class="topo"><div><h1>Visão Geral</h1><p class="sub">Carregando…</p></div></div>';
  const [blocos, o] = await Promise.all([api('/blocks'), api(`/overview?periodo=${V.periodo}${V.bloco ? '&bloco=' + V.bloco : ''}`)]);
  S.blocks = blocos;
  const rotulo = PERIODOS.find((p) => p[0] === V.periodo)?.[1] || 'Hoje';
  const ant = o.anterior; const antRot = V.periodo === 'hoje' ? 'ontem' : 'período anterior';
  const maxF = Math.max(1, o.cliques, o.entradas, o.saidas);
  const barra = (n) => `<div class="barra"><i style="width:${Math.round((n / maxF) * 100)}%"></i></div>`;
  const sem = (s) => `<div class="vazio" style="padding:20px">${s}</div>`;
  const semEventos = !o.entradas && !o.saidas && !o.cliques;
  $('#pagina').innerHTML = `
    <div class="topo"><div><h1>Visão Geral ${q('visao')}</h1><p class="sub">${rotulo} · ${o.membros} membros em ${o.grupos} ${o.grupos === 1 ? 'grupo' : 'grupos'}.</p></div></div>
    <div class="filtros"><div class="seg" id="per">${PERIODOS.map(([k, n]) => `<button data-p="${k}" class="${k === V.periodo ? 'on' : ''}">${n}</button>`).join('')}</div></div>
    <div class="filtros chips" id="blc">${q('visao.bloco')}<button data-b="" class="${V.bloco ? '' : 'on'}">Todos os grupos</button>
      ${blocos.map((b) => `<button data-b="${b.id}" class="${String(b.id) === String(V.bloco) ? 'on' : ''}">${esc(b.name)} <small>${b.group_jids.length}</small></button>`).join('')}
      <a href="#blocos" class="btn" style="text-decoration:none;border-radius:99px;padding:6px 12px">+ Novo bloco</a></div>
    <div class="grade-vg">
      <div class="card"><h2>Funil do período ${q('visao.funil')}</h2>
        <div class="funil" style="margin-top:12px">
          <div class="etapa"><div><div class="n">${o.cliques}</div><small>CLIQUES NOS LINKS ${q('visao.cliques')} · ${antRot}: ${ant.cliques}</small></div>${barra(o.cliques)}<small class="dica">${o.cliques ? fmtPct(Math.round((o.entradas_link / o.cliques) * 1000) / 10) + ' viraram entrada' : '— viraram entrada'}</small></div>
          <div class="etapa"><div><div class="n">${o.entradas}</div><small>ENTRADAS ${q('visao.entradas')} · ${antRot}: ${ant.entradas}</small></div>${barra(o.entradas)}<small class="dica">pelo link <b>${o.entradas_link}</b> · adicionados <b>${o.entradas_add}</b></small></div>
          <div class="etapa"><div><div class="n">${o.saidas}</div><small>SAÍDAS ${q('visao.saidas')} · ${antRot}: ${ant.saidas}</small></div>${barra(o.saidas)}<small class="dica">saldo <b>${o.saldo >= 0 ? '+' : ''}${o.saldo}</b></small></div>
        </div></div>
      <div style="display:grid;gap:12px">
        <div class="kpi destaque"><div class="rotulo">Tempo médio no grupo ${q('visao.tempo')}</div><div class="valor">${fmtMin(o.tempo_medio_min)}</div>
          <div class="nota">quanto tempo, em média, quem saiu ficou no grupo (${o.saidas_com_entrada} ${o.saidas_com_entrada === 1 ? 'saída' : 'saídas'} com entrada registrada)<br>
          quem ainda está: ${fmtMin(o.permanencia_atual_min)} em média até agora (${o.ativos} pessoas)${o.desde ? `<br>desde o início (${new Date(o.desde).toLocaleDateString('pt-BR')}) · não muda com o filtro de datas` : ''}</div></div>
        <div class="kpi"><div class="rotulo">Abriram o grupo ${q('visao.abriram')}</div><div class="valor">${o.abriram}</div>
          <div class="nota"><b>${fmtPct(o.abriram_pct)}</b> dos ${o.membros} membros · pessoas diferentes que leram alguma mensagem sua · ${antRot}: ${ant.abriram}</div></div>
      </div>
    </div>
    <div class="card"><div class="topo" style="margin-bottom:8px"><div><h2>Entradas e saídas por ${o.periodo.por_hora ? 'horário' : 'dia'} ${q('visao.grafico')}</h2></div>
      <div class="legenda"><span><i class="c1"></i>Entradas</span><span><i class="c2"></i>Saídas</span><span><i class="c3"></i>Parte escura: saíram no mesmo dia em que entraram</span></div></div>
      ${semEventos ? sem('Sem entradas ou saídas no período.') : graficoBarras(o.serie, o.periodo.por_hora)}
      <details style="margin-top:8px"><summary class="dica" style="cursor:pointer">Ver em tabela</summary>
        <table style="margin-top:8px"><thead><tr><th>${o.periodo.por_hora ? 'Hora' : 'Dia'}</th><th>Entradas</th><th>Saídas</th><th>Mesmo dia</th></tr></thead>
        <tbody>${o.serie.filter((p) => p.entradas || p.saidas).map((p) => `<tr><td>${o.periodo.por_hora ? String(p.k).padStart(2, '0') + 'h' : dataBR(p.k)}</td><td>${p.entradas}</td><td>${p.saidas}</td><td>${p.saidas_mesmo_dia}</td></tr>`).join('') || '<tr><td colspan="4">Nada no período.</td></tr>'}</tbody></table></details></div>
    <h2 style="margin:20px 0 10px">Evasão do tráfego</h2>
    <div class="kpis" style="margin-top:0">
      ${kpiEvasao('Evasão de quem entrou no dia ' + q('visao.evasao_dia'), o.evasao.entrou_dia, `De ${o.evasao.entrou_dia.de} que entraram, ${o.evasao.entrou_dia.n} saíram no mesmo dia`, 'Ninguém entrou no período ainda.')}
      ${kpiEvasao('Evasão em 7 dias de quem entrou no dia ' + q('visao.evasao_7d'), o.evasao.em_7d, `De ${o.evasao.em_7d.de} que entraram, ${o.evasao.em_7d.n} saíram em até 7 dias`, 'Ninguém entrou no período ainda.')}
      ${kpiEvasao(`Evasão de ontem (${dataBR(o.evasao.ontem.dia)}) ` + q('visao.evasao_ontem'), { ...o.evasao.ontem, fechado: true }, `De ${o.evasao.ontem.de} que entraram, ${o.evasao.ontem.n} saíram no mesmo dia`, 'Ninguém entrou ontem.')}
      ${kpiEvasao('Evasão total do período ' + q('visao.evasao_total'), { ...o.evasao.total_dia, fechado: true }, `${o.evasao.total_dia.n} saídas sobre ${o.evasao.total_dia.de} pessoas`, 'Nenhuma saída neste período.')}
    </div>
    <h2 style="margin:20px 0 10px">Por grupo ${q('visao.porgrupo')}</h2>
    <div class="card tabela"><table><thead><tr><th>Grupo</th><th>Membros</th><th>Abriram</th><th>Entradas</th><th>Pelo link</th><th>Adicionados</th><th>Saídas</th><th>Mesmo dia</th></tr></thead>
      <tbody>${o.por_grupo.sort((a, b) => b.entradas - a.entradas || b.membros - a.membros).map((g) => `<tr><td>${esc(g.name)}</td><td>${g.membros}</td><td>${g.abriram} <small class="dica">${fmtPct(g.abriram_pct)}</small></td><td><b>${g.entradas}</b></td><td>${g.pelo_link}</td><td>${g.adicionados}</td><td>${g.saidas}</td><td>${g.mesmo_dia}</td></tr>`).join('') || '<tr><td colspan="8">Nenhum grupo. Conecte o WhatsApp e sincronize os grupos.</td></tr>'}</tbody></table></div>
    <h2 style="margin:20px 0 10px">Eventos do período</h2>
    <div class="card">${o.eventos.length ? `<ul class="eventos" style="list-style:none;margin:0;padding:0">${o.eventos.map((e) => `<li><time>${dataHora(e.ts)}</time><span>${esc(e.group_name || e.jid)}: ${e.action === 'add' ? (e.by_link ? 'entrou pelo link' : 'foi adicionado') : (e.actor ? 'foi removido' : 'saiu')} <span class="dica">· ${esc(String(e.participant).replace(/@.*$/, ''))}</span></span></li>`).join('')}</ul>` : sem('Nenhum evento. As entradas e saídas passam a ser registradas enquanto o programa está conectado ao WhatsApp.')}</div>`;
  $('#per').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { V.periodo = b.dataset.p; paginaVisao(); } };
  $('#blc').onclick = (e) => { const b = e.target.closest('[data-b]'); if (b) { V.bloco = b.dataset.b; paginaVisao(); } };
  ligarTooltips();
  clearTimeout(paginaVisao.t); paginaVisao.t = setTimeout(() => { if (location.hash === '#visao' && !$('#dlg').open) paginaVisao(); }, 30000);
}
function kpiEvasao(titulo, ev, texto, vazio) {
  return `<div class="kpi"><div class="rotulo">${titulo}</div><div class="valor">${ev.pct == null ? '—' : fmtPct(ev.pct)}</div>
    <div class="nota"><span class="estado-pill ${ev.fechado ? '' : 'on'}">${ev.fechado ? 'fechado' : 'em andamento'}</span> ${ev.de ? texto : vazio}</div></div>`;
}
function graficoBarras(serie, porHora) {
  const W = 920, H = 220, padL = 36, padB = 28, padT = 10;
  const max = Math.max(1, ...serie.flatMap((s) => [s.entradas, s.saidas]));
  const n = serie.length; const gw = (W - padL) / n; const bw = Math.max(3, Math.min(18, (gw - 8) / 2));
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const rot = (p) => (porHora ? String(p.k).padStart(2, '0') + 'h' : dataBR(p.k));
  let s = `<svg class="viz" viewBox="0 0 ${W} ${H}" role="img" aria-label="Entradas e saídas por ${porHora ? 'hora' : 'dia'}">`;
  for (const t of [...new Set([0, Math.ceil(max / 2), max])]) s += `<line class="grid" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  const passo = porHora ? 3 : Math.max(1, Math.ceil(n / 10));
  serie.forEach((p, i) => {
    const x0 = padL + i * gw + (gw - 2 * bw - 2) / 2;
    if (p.entradas > 0) s += `<rect class="s1" x="${x0}" y="${y(p.entradas)}" width="${bw}" height="${H - padB - y(p.entradas)}" rx="3"/>`;
    if (p.saidas > 0) {
      s += `<rect class="s2" x="${x0 + bw + 2}" y="${y(p.saidas)}" width="${bw}" height="${H - padB - y(p.saidas)}" rx="3"/>`;
      // parte de quem entrou e saiu no mesmo dia: segmento escuro na base da barra de saídas
      if (p.saidas_mesmo_dia > 0) s += `<rect class="s3" x="${x0 + bw + 2}" y="${y(p.saidas_mesmo_dia)}" width="${bw}" height="${H - padB - y(p.saidas_mesmo_dia)}" rx="3"/>`;
    }
    s += `<rect class="hit" x="${padL + i * gw}" y="${padT}" width="${gw}" height="${H - padT - padB}" data-tip="${esc(`${rot(p)}: ${p.entradas} entradas, ${p.saidas} saídas (${p.saidas_mesmo_dia} no mesmo dia)`)}"/>`;
    if (i % passo === 0) s += `<text class="tick" x="${padL + i * gw + gw / 2}" y="${H - 8}" text-anchor="middle">${rot(p)}</text>`;
  });
  return s + '</svg>';
}
function ligarTooltips() {
  $$('.hit').forEach((el) => {
    el.onmousemove = (e) => { const tip = tipShow(el.dataset.tip); if (tip) { tip.style.left = Math.min(e.clientX + 12, innerWidth - 280) + 'px'; tip.style.top = (e.clientY - 36) + 'px'; } };
    el.onmouseleave = () => tipHide();
  });
}

// ---------- Blocos de análise ----------
async function paginaBlocos() {
  S.blocks = await api('/blocks');
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Blocos de análise ${q('blocos')}</h1><p class="sub">Agrupe os grupos por nicho para ver as métricas de cada um separadas na Visão Geral. Um bloco pode ter uma etiqueta do Mercado Livre: ao criar uma regra, escolha o bloco e ela já marca os grupos e a etiqueta.</p></div>
    <button class="pri" id="novo">Novo bloco</button></div>
    ${S.blocks.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">${S.blocks.map((b) => {
      const tag = S.tags.find((t) => t.id === b.tag_id);
      return `<article class="card" data-id="${b.id}" style="margin:0"><h2>${esc(b.name)}</h2>
        <p class="dica" style="margin:0">Etiqueta do Mercado Livre: <b>${tag ? esc(tag.name) : 'padrão da regra'}</b></p>
        <div class="bl-stats"><div><b>${b.grupos.length}</b><small>${b.grupos.length === 1 ? 'grupo' : 'grupos'}</small></div><div><b>${b.membros}</b><small>membros</small></div><div><b>${b.hoje.entradas}</b><small>entradas hoje</small></div><div><b>${b.hoje.abriram}</b><small>abriram hoje</small></div></div>
        <div class="chips" style="margin-bottom:12px">${b.grupos.slice(0, 6).map((g) => `<span class="chip">${esc(g.name)}</span>`).join('')}${b.grupos.length > 6 ? `<span class="chip">+${b.grupos.length - 6}</span>` : ''}</div>
        <div class="acoes" style="border:0;padding:0"><button data-act="ver">Ver na Visão Geral</button><button data-act="editar">Editar</button><button data-act="excluir" class="perigo leve">Excluir</button></div></article>`;
    }).join('')}</div>` : '<div class="vazio">Nenhum bloco ainda. Crie um bloco para separar seus grupos por nicho, por exemplo “Casa” ou “Beleza”.</div>'}`;
  $('#novo').onclick = () => formBloco();
  $('#pagina').onclick = tentar(async (ev) => {
    const btn = ev.target.closest('[data-act]'); if (!btn) return;
    const id = Number(btn.closest('[data-id]').dataset.id); const b = S.blocks.find((x) => x.id === id);
    if (btn.dataset.act === 'ver') { V.bloco = String(id); location.hash = '#visao'; }
    if (btn.dataset.act === 'editar') formBloco(b);
    if (btn.dataset.act === 'excluir' && confirm(`Excluir o bloco “${b.name}”? Os grupos continuam existindo.`)) { await api(`/blocks/${id}`, 'DELETE'); paginaBlocos(); }
  });
}
function formBloco(b) {
  const novo = !b; b = b || { name: '', tag_id: null, group_jids: [] }; const sel = new Set(b.group_jids); const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog" id="f"><h1>${novo ? 'Novo bloco' : 'Editar bloco'}</h1>
    <div class="grade"><label class="campo">Nome do bloco<input name="name" value="${esc(b.name)}" placeholder="Ex.: Casa e cozinha" required></label>
      <label class="campo"><span>Etiqueta do Mercado Livre (opcional) ${q('blocos.etiqueta')}</span><select name="tag_id"><option value="">Nenhuma</option>${S.tags.map((t) => `<option value="${t.id}" ${t.id === b.tag_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        <small>Para separar o ganho por nicho. Ao criar uma regra a partir deste bloco, a etiqueta já vem marcada.</small></label></div>
    <fieldset><legend>Grupos do bloco <span id="cont" class="dica"></span></legend>
      ${S.groups.length ? `<div class="linha"><input id="busca" placeholder="Buscar grupo…" style="flex:1"><button type="button" id="so-marcados" class="alt" aria-pressed="false" title="Mostrar só os grupos marcados, para conferir e desmarcar">Só marcados</button><button type="button" id="nenhum">Limpar</button></div>
      <div class="grupos" id="gr">${S.groups.map((g) => `<label data-n="${esc(g.name.toLowerCase())}"><input type="checkbox" value="${esc(g.jid)}" ${sel.has(g.jid) ? 'checked' : ''}>${esc(g.name)}<small>${g.size ?? ''}</small></label>`).join('')}</div>` : '<div class="dica">Nenhum grupo carregado. Conecte o WhatsApp e sincronize os grupos.</div>'}</fieldset>
    <div class="rodape"><button type="button" id="cancelar">Cancelar</button><button class="pri">${novo ? 'Salvar bloco' : 'Salvar'}</button></div></form>`;
  const conta = () => { $('#cont').textContent = `(${$$('#gr input:checked', dlg).length} selecionados)`; };
  if ($('#gr')) { const filtro = filtroGrupos(dlg, conta); $('#nenhum').onclick = () => { $$('#gr input').forEach((i) => (i.checked = false)); filtro(); }; }
  $('#cancelar').onclick = () => dlg.close();
  $('#f').onsubmit = tentar(async (ev) => {
    ev.preventDefault(); const f = new FormData($('#f'));
    await api(novo ? '/blocks' : `/blocks/${b.id}`, novo ? 'POST' : 'PUT', { name: f.get('name'), tag_id: f.get('tag_id') || null, group_jids: $$('#gr input:checked', dlg).map((i) => i.value) });
    dlg.close(); aviso(novo ? 'Bloco criado' : 'Bloco salvo'); paginaBlocos();
  });
  dlg.showModal();
}

// ---------- Rotacionador de Links ----------
async function paginaLinks() {
  const [links, propostas] = await Promise.all([api('/links'), api('/proposals')]);
  const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(S.st.endereco_publico || '');
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Rotacionador de Links ${q('links')}</h1><p class="sub">Cada link leva para o primeiro grupo da lista que ainda não atingiu o limite. Os cliques entram no funil da Visão Geral.</p></div>
    <button class="pri" id="novo">Novo link</button></div>
    ${propostas.length ? `<div class="card" id="props" style="border-color:var(--accent)"><h2>Próximo grupo</h2>${propostas.map((p) => `<div data-pid="${p.id}" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--line)">
        <div style="flex:1;min-width:240px">${p.status === 'pending' ? `<b>${esc(p.source_name || p.source_jid)}</b> chegou a ${p.source_size}/${p.limit_members} membros (link “${esc(p.link_name || '')}”).<br><small class="dica">Proposta: criar <b>${esc(p.name)}</b> igual a ele, logo depois na fila.</small>`
          : p.status === 'created' ? `<b>${esc(p.name)}</b> criado a partir de ${esc(p.source_name || p.source_jid)} em ${dataHora(p.decided_at)}.${p.detail?.admins_nao_adicionados?.length ? `<br><small style="color:var(--warn)">Não consegui adicionar ${p.detail.admins_nao_adicionados.length} admin(s) (privacidade do WhatsApp): mande o convite a eles.</small>` : ''}${p.detail?.avisos?.length ? `<br><small class="dica">${esc(p.detail.avisos.join(' · '))}</small>` : ''}`
          : p.status === 'failed' ? `<b>${esc(p.name)}</b>: falhou em ${dataHora(p.decided_at)}. <small style="color:var(--err)">${esc(p.detail?.erro || '')}</small>` : `<span class="dica">${esc(p.name)}: ignorado em ${dataHora(p.decided_at)}.</span>`}</div>
        ${p.status === 'pending' ? `<input value="${esc(p.name)}" data-nome style="width:220px"><button class="pri" data-prop="criar">Criar agora</button><button data-prop="ignorar" class="leve">Ignorar</button>` : ''}</div>`).join('')}</div>` : ''}
    ${local ? '<div class="card" style="border-color:var(--warn)"><b>Atenção:</b> o programa está rodando só no seu computador, então estes endereços só abrem aqui. Para divulgar, publique o programa na internet (o link fica <code>https://seu-dominio/g/nome</code>).</div>' : ''}
    ${links.length ? links.map((l) => `<article class="card" data-id="${l.id}"><h2><label class="chave" title="Ligar ou pausar"><input type="checkbox" data-act="ligar" ${l.enabled ? 'checked' : ''}><span></span></label> ${esc(l.name)}
        <span class="chip">${esc(S.st.modos_link.find((m) => m.id === l.mode)?.name || l.mode)}</span></h2>
      <div class="copia" style="margin:8px 0"><input readonly value="${esc(l.url)}" id="u${l.id}"><button data-act="copiar" data-c="u${l.id}">Copiar</button></div>
      <p class="res">${l.auto_next ? '<span class="chip">propõe próximo grupo</span> ' : ''}${l.cliques_hoje} ${l.cliques_hoje === 1 ? 'clique' : 'cliques'} hoje · ${l.cliques_total} no total · limite ${l.limit_members} por grupo${l.mode === 'reopen' ? ` · reabre abaixo de ${l.reopen_below}` : ''}${l.fallback_url ? ` · reserva: ${esc(l.fallback_url)}` : ''}</p>
      <div style="display:grid;gap:6px;margin:10px 0">${l.grupos.map((g) => `<div style="display:grid;grid-template-columns:minmax(0,1fr) 110px 70px;gap:10px;align-items:center;font-size:14px"><span>${esc(g.name)}</span><div class="prog"><i style="width:${g.pct}%"></i></div><small class="dica">${g.size}/${g.limit} · ${g.situacao}</small></div>`).join('')}</div>
      <div class="acoes"><button data-act="editar">Editar</button><button data-act="excluir" class="perigo leve">Excluir</button></div></article>`).join('')
      : '<div class="vazio">Nenhum link ainda. Conecte o WhatsApp, busque o convite dos grupos em “WhatsApp e grupos” e crie um link escolhendo os grupos na ordem em que devem encher.</div>'}`;
  $('#novo').onclick = () => formLink();
  $('#pagina').onclick = tentar(async (ev) => {
    const pb = ev.target.closest('[data-prop]');
    if (pb) {
      const row = pb.closest('[data-pid]'); const pid = row.dataset.pid;
      if (pb.dataset.prop === 'ignorar') { await api(`/proposals/${pid}/dismiss`, 'POST'); aviso('Proposta ignorada'); return paginaLinks(); }
      if (!confirm('Criar o grupo agora no seu WhatsApp? Esta ação é a que mais chama atenção do WhatsApp; evite repetir várias vezes no mesmo dia.')) return;
      pb.disabled = true; pb.textContent = 'Criando…';
      await api(`/proposals/${pid}/create`, 'POST', { name: $('[data-nome]', row).value });
      aviso('Grupo criado e encaixado no link'); S.groups = await api('/groups'); return paginaLinks();
    }
    const btn = ev.target.closest('[data-act]'); if (!btn) return;
    const id = Number(btn.closest('[data-id]').dataset.id); const l = links.find((x) => x.id === id);
    if (btn.dataset.act === 'copiar') { await navigator.clipboard.writeText($('#' + btn.dataset.c).value); aviso('Copiado'); }
    if (btn.dataset.act === 'ligar') { await api(`/links/${id}/enabled`, 'POST', { enabled: btn.checked }); aviso(btn.checked ? 'Link ligado' : 'Link pausado'); }
    if (btn.dataset.act === 'editar') formLink(l);
    if (btn.dataset.act === 'excluir' && confirm(`Excluir o link “${l.name}”? Quem clicar nele depois verá “não encontrado”.`)) { await api(`/links/${id}`, 'DELETE'); paginaLinks(); }
  });
}
function formLink(l) {
  const novo = !l; l = l || { name: '', slug: '', mode: 'fill', fallback_url: '', limit_members: 1000, reopen_below: 900, group_jids: [] };
  const dlg = $('#dlg'); let ordem = [...l.group_jids];
  const semConvite = (jid) => !S.groups.find((g) => g.jid === jid)?.invite_code;
  dlg.innerHTML = `<form method="dialog" id="f"><h1>${novo ? 'Novo link' : 'Editar link'}</h1>
    <p class="sub" style="margin:-8px 0 12px">As pessoas vão para o primeiro grupo da lista que ainda tem vaga.</p>
    <div class="grade"><label class="campo">Nome<input name="name" value="${esc(l.name)}" placeholder="Ex.: Achadinhos de casa" required></label>
      <label class="campo"><span>Endereço do link ${q('links.endereco')}</span><div class="linha" style="align-items:center"><span class="dica" style="white-space:nowrap">${esc((S.st.endereco_publico || '').replace(/^https?:\/\//, ''))}/g/</span><input name="slug" value="${esc(l.slug)}" placeholder="achadinhos" style="flex:1"></div></label></div>
    <label class="campo"><span>URL reserva (quando todos lotarem) ${q('links.reserva')}</span><input name="fallback_url" value="${esc(l.fallback_url || '')}" placeholder="Opcional: https://…"></label>
    <fieldset><legend>Como distribuir os cliques ${q('links.modo')}</legend><div class="modos">${S.st.modos_link.map((m) => `<label><input type="radio" name="mode" value="${m.id}" ${m.id === l.mode ? 'checked' : ''} style="width:auto"><b>${esc(m.name)}</b><small>${esc(m.desc)}</small></label>`).join('')}</div></fieldset>
    <label class="campo" style="border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start"><input type="checkbox" name="auto_next" ${l.auto_next ? 'checked' : ''} style="width:auto;margin-top:4px"><span>Criar próximo grupo (com a sua confirmação) ${q('links.proximo')}
      <small style="display:block;font-weight:400;color:var(--muted)">Quando um grupo deste link chegar a ${S.st.lotacao_pct}% do limite, o painel propõe um grupo novo igual (nome com o próximo número, descrição, foto, permissões e admins). Nada é criado até você clicar em “Criar agora”. O grupo novo entra neste link logo depois do que lotou, nos mesmos blocos e nas mesmas regras.</small></span></label>
    <div class="grade"><label class="campo"><span>Limite de membros por grupo ${q('links.limite')}</span><input name="limit_members" type="number" min="2" max="${S.st.limite_max}" value="${l.limit_members}"><small>Padrão 1.000 (máximo ${S.st.limite_max.toLocaleString('pt-BR')}).</small></label>
      <label class="campo" id="f-reopen">Reabrir quando cair para (membros)<input name="reopen_below" type="number" min="1" value="${l.reopen_below}"></label></div>
    <fieldset><legend>Grupos, em ordem ${q('links.ordem')} <span class="dica">(o primeiro enche primeiro)</span></legend>
      <input id="busca-g" placeholder="Buscar grupo para adicionar…" style="width:100%;margin-bottom:8px">
      <div class="grupos" id="disp" style="max-height:150px"></div>
      <ul class="ordem" id="ordem" style="list-style:none;padding:0;margin:10px 0 0"></ul>
      <small class="dica">Só grupos com convite entram na rotação. Busque ou cole o convite em “WhatsApp e grupos”.</small></fieldset>
    <div class="rodape"><button type="button" id="cancelar">Cancelar</button><button class="pri">${novo ? 'Salvar link' : 'Salvar'}</button></div></form>`;
  const ajustaModo = () => { $('#f-reopen').hidden = $('input[name=mode]:checked', dlg)?.value !== 'reopen'; };
  $$('input[name=mode]', dlg).forEach((i) => (i.onchange = ajustaModo)); ajustaModo();
  const pinta = () => {
    const q = $('#busca-g').value.toLowerCase();
    $('#disp').innerHTML = S.groups.filter((g) => !ordem.includes(g.jid) && g.name.toLowerCase().includes(q)).slice(0, 40)
      .map((g) => `<label data-add="${esc(g.jid)}" style="cursor:pointer">${esc(g.name)}<small>${g.size ?? ''} membros${g.invite_code ? '' : ' · sem convite'}</small></label>`).join('') || '<div class="dica" style="padding:8px 12px">Nenhum grupo para adicionar.</div>';
    $('#ordem').innerHTML = ordem.map((jid, i) => `<li><b>${i + 1}.</b><span>${esc(nomeGrupo(jid))}${semConvite(jid) ? ' <small style="color:var(--warn)">sem convite</small>' : ''}</span><button type="button" data-mv="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-mv="${i}" data-d="1" ${i === ordem.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-rm="${i}" class="perigo leve">✕</button></li>`).join('') || '<li class="dica" style="border:0;background:none">Clique nos grupos acima para adicionar.</li>';
  };
  $('#busca-g').oninput = pinta; pinta();
  $('#disp').onclick = (e) => { const l2 = e.target.closest('[data-add]'); if (l2) { ordem.push(l2.dataset.add); pinta(); } };
  $('#ordem').onclick = (e) => {
    const mv = e.target.closest('[data-mv]'); const rm = e.target.closest('[data-rm]');
    if (mv) { const i = Number(mv.dataset.mv); const j = i + Number(mv.dataset.d); [ordem[i], ordem[j]] = [ordem[j], ordem[i]]; pinta(); }
    if (rm) { ordem.splice(Number(rm.dataset.rm), 1); pinta(); }
  };
  $('#cancelar').onclick = () => dlg.close();
  $('#f').onsubmit = tentar(async (ev) => {
    ev.preventDefault(); const f = new FormData($('#f')); const g = (k) => f.get(k);
    await api(novo ? '/links' : `/links/${l.id}`, novo ? 'POST' : 'PUT', { name: g('name'), slug: g('slug'), mode: g('mode'), fallback_url: g('fallback_url'), limit_members: g('limit_members'), reopen_below: g('reopen_below'), group_jids: ordem, auto_next: !!g('auto_next') });
    dlg.close(); aviso(novo ? 'Link criado' : 'Link salvo'); paginaLinks();
  });
  dlg.showModal();
}

// ---------- tabela de grupos (página WhatsApp e grupos) ----------
function tabelaGrupos(groups) {
  const blocoNome = (id) => S.blocks.find((b) => b.id === id)?.name;
  return `<div class="card tabela"><table><thead><tr><th>Grupo</th><th>Membros</th><th>Convite ${q('grupos.convite')}</th></tr></thead><tbody>
    ${groups.map((g) => `<tr data-jid="${esc(g.jid)}"><td>${esc(g.name)}${g.is_admin ? '<span class="badge-adm">admin</span>' : ''}${g.blocks?.length ? `<br><small class="dica">${g.blocks.map(blocoNome).filter(Boolean).map(esc).join(' · ')}</small>` : ''}</td><td>${g.size ?? ''}</td>
      <td><div class="conv">${g.invite_code ? `<input readonly value="https://chat.whatsapp.com/${esc(g.invite_code)}">` : '<input data-colar placeholder="https://chat.whatsapp.com/…">'}
        <button data-inv="${g.invite_code ? 'colar' : 'colar'}" title="Salvar o link colado" ${g.invite_code ? 'hidden' : ''}>Salvar</button><button data-inv="buscar" title="Busca o link pelo WhatsApp (precisa ser admin)">${g.invite_code ? 'Atualizar' : 'Buscar convite'}</button></div></td></tr>`).join('')
      || '<tr><td colspan="3">Nenhum grupo. Toque em “Atualizar lista de grupos”.</td></tr>'}</tbody></table></div>`;
}
document.addEventListener('click', (ev0) => tentar(async (ev) => {
  const btn = ev.target.closest('[data-inv]'); if (!btn) return;
  const tr = btn.closest('[data-jid]'); const jid = tr.dataset.jid;
  if (btn.dataset.inv === 'buscar') { await api(`/groups/${encodeURIComponent(jid)}/invite`, 'POST'); aviso('Convite salvo'); }
  else { const url = $('[data-colar]', tr)?.value; await api(`/groups/${encodeURIComponent(jid)}/invite`, 'PUT', { url }); aviso('Convite salvo'); }
  S.groups = await api('/groups'); if (location.hash === '#whatsapp') paginaWhatsapp();
})(ev0));
