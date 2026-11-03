// Conexões (#conexoes; os endereços antigos #etiquetas e a extensão de Ajustes vieram para cá).
// Hoje só o Mercado Livre funciona: etiquetas de afiliado + extensão do Chrome.
// Carrega antes de app.js: só define funções. Os utilitários de app.js e paineis.js ($, $$, esc, api,
// aviso, tentar, mostrarErros, REQ, S, atualizarEstado, podeEquipe, dataHora) só são usados quando as funções rodam.

const TEXTOS_CONEXOES = {
  sub: 'Plataformas ligadas ao painel.',
  mlDesc: 'Gera os links meli.la com as suas etiquetas, pela extensão do Chrome.',
  conectado: 'Conectado',
  falta: 'Falta configurar',
  impl: 'Ainda não implementado',
  pronta: 'Configurada',
  avisoImpl: '<b>Ainda não implementado.</b> Você já pode guardar os dados. O painel só vai usar quando a integração existir.',
  avisoImplSemCampos: '<b>Ainda não implementado.</b> Em breve neste painel.',
  segredoSalvo: '•••••••• salva; digite para trocar',
  segredoSoDono: 'Só o Dono vê e troca esta chave.',
  tokenSoDono: 'Só o Dono pode gerar um novo token.',
  nadaSalvo: 'Nada salvo ainda. Salve os dados para poder testar.',
  salvoEm: (ms) => `Dados salvos em ${dataHora(ms)}.`,
  carregando: 'Carregando as outras lojas…',
  erroCarregar: 'Não consegui carregar as outras lojas.',
  formatoSegredo: 'formato inválido. Confira se copiou o valor inteiro, sem espaços.',
};

function paginaConexoes({ rolarPara } = {}) {
  const url = S.st.endereco_publico || `http://127.0.0.1:${S.st.porta}`;
  $('#pagina').innerHTML = `<div class="topo"><div><h1>Conexões ${q('conexoes')}</h1><p class="sub">${TEXTOS_CONEXOES.sub}</p></div></div>
    <div class="conexoes">
      <article class="card conexao conexao-ml" aria-labelledby="cx-ml">
        <header><h2 id="cx-ml">Mercado Livre</h2><span class="estado-pill" id="ml-selo"></span></header>
        <p class="desc">${TEXTOS_CONEXOES.mlDesc}</p>
        <section class="secao" id="ml-etiquetas" aria-labelledby="ml-etq-h"></section>
        <section class="secao" aria-labelledby="ml-ext-h">
          <h3 id="ml-ext-h">Extensão do Chrome ${q('ajustes.extensao')}</h3>
          <ol class="passos"><li>Instale a extensão no Chrome (pasta <code>extension</code> do programa).</li>
            <li>Abra a Central de Afiliados nesse Chrome, logado na sua conta do Mercado Livre.</li>
            <li>Clique no ícone da extensão e cole o endereço e o token abaixo.</li></ol>
          <label class="campo">Endereço<div class="copia"><input readonly value="${esc(url)}" id="c1"><button type="button" data-c="c1" aria-label="Copiar endereço">Copiar</button></div></label>
          <label class="campo">Token<div class="copia"><input readonly value="${esc(S.st.ext_token)}" id="c2"><button type="button" data-c="c2" aria-label="Copiar token">Copiar</button></div></label>
          <p class="estado-linha" id="ml-estado" role="status"></p>
          <div class="linha">${podeEquipe() ? '<button type="button" id="novo-token" class="leve perigo">Gerar novo token</button><small class="dica">Use se achar que o token vazou. A extensão para de funcionar até você colar o novo.</small>'
    : `<small class="dica">${TEXTOS_CONEXOES.tokenSoDono}</small>`}</div>
        </section>
      </article>
    </div>
    <div class="conexoes" id="outras-lojas"></div>`;
  paginaEtiquetas($('#ml-etiquetas'));
  pintarEstadoML();
  $$('[data-c]', $('#pagina')).forEach((b) => (b.onclick = async () => { await navigator.clipboard.writeText($('#' + b.dataset.c).value); aviso('Copiado'); }));
  // Operador: o botão não existe (podeEquipe, de app.js); o servidor também recusa com 403.
  if ($('#novo-token')) $('#novo-token').onclick = tentar(async () => {
    if (!confirm('Gerar um novo token? A extensão do Chrome vai parar até você colar o token novo nela.')) return;
    await api('/ajustes/token', 'POST'); await atualizarEstado(); aviso('Token novo gerado'); paginaConexoes();
  });
  if (rolarPara) $('#' + rolarPara)?.scrollIntoView({ block: 'start' });
  outrasLojas();
}

/** Selo do cartão e linha de estado da extensão. Também chamada por atualizarEstado (app.js) a cada 3 s nesta página. */
function pintarEstadoML() {
  const selo = $('#ml-selo'); const linha = $('#ml-estado'); if (!selo || !linha) return;
  const e = S.st.extensao; const direto = S.st.ajustes.link_mode === 'direct';
  const ok = S.tags.length > 0 && e.online && !direto;
  selo.className = 'estado-pill ' + (ok ? 'conectado' : 'falta');
  selo.textContent = ok ? TEXTOS_CONEXOES.conectado : TEXTOS_CONEXOES.falta;
  const erro = e.lastError ? ` Último erro: ${e.lastError}.` : '';
  const texto = direto ? 'Modo direto ligado em Ajustes: os links saem sem etiqueta e não geram comissão.'
    : e.online ? `Extensão conectada. ${e.lastOkAt ? `Último link gerado em ${dataHora(e.lastOkAt)}.` : 'Nenhum link gerado ainda.'}${erro}`
      : `Extensão desconectada.${erro || ' Abra o Chrome com a extensão instalada e logado na Central de Afiliados.'}`;
  linha.classList.toggle('aviso', direto || !e.online);
  if (linha.textContent !== texto) linha.textContent = texto;
}

// ---------- etiquetas de afiliado (era a página #etiquetas; agora é uma seção do cartão Mercado Livre) ----------
function paginaEtiquetas(el = $('#ml-etiquetas')) {
  if (!el) return;
  el.innerHTML = `<h3 id="ml-etq-h">Etiquetas de afiliado ${q('etiquetas')}</h3>
    <p class="desc">Os nomes das suas etiquetas do programa de afiliados do Mercado Livre, escritos exatamente como aparecem lá. Depois escolha qual usar em cada disparo automático.</p>
    <form id="nt" novalidate><div class="linha"><label class="campo" style="flex:1;min-width:200px"><span>Nome da etiqueta ${REQ}</span><input name="name" placeholder="Ex.: achadosdesejo" style="width:100%"></label>
      <label class="campo" style="flex:1;min-width:200px"><span>Anotação (opcional)</span><input name="note" placeholder="Ex.: grupo de casa"></label><button class="pri" style="align-self:end">Adicionar etiqueta</button></div></form>
    ${S.tags.length ? `<div class="tabela"><table><thead><tr><th scope="col">Etiqueta</th><th scope="col">Anotação</th><th scope="col">Usada em</th><th scope="col"></th></tr></thead><tbody>
      ${S.tags.map((t) => { const uso = S.rules.filter((r) => r.tag_id === t.id).length; return `<tr><td><span class="chip etq">${esc(t.name)}</span></td><td>${esc(t.note)}</td><td>${uso} ${uso === 1 ? 'disparo automático' : 'disparos automáticos'}</td><td style="text-align:right"><button type="button" class="perigo leve" data-del="${t.id}" aria-label="Excluir a etiqueta ${esc(t.name)}">Excluir</button></td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="vazio">Nenhuma etiqueta cadastrada.</div>'}`;
  const recarregar = async () => { S.tags = await api('/tags'); paginaEtiquetas(el); pintarEstadoML(); };
  $('#nt', el).onsubmit = tentar(async (ev) => {
    ev.preventDefault(); const f = new FormData(ev.target); const nome = String(f.get('name') || '').trim();
    const erros = [];
    if (!nome) erros.push({ msg: 'Digite o nome da etiqueta, igual ao cadastrado na Central de Afiliados.', el: $('[name=name]', ev.target) });
    else if (!/^[\w.-]{2,60}$/.test(nome)) erros.push({ msg: 'A etiqueta deve ter 2 a 60 caracteres: letras, números, ponto, hífen ou _ (sem espaços).', el: $('[name=name]', ev.target) });
    if (mostrarErros(ev.target, erros)) return;
    try { await api('/tags', 'POST', { name: nome, note: f.get('note') }); } catch (e) { mostrarErros(ev.target, [{ msg: e.message }]); return; }
    aviso('Etiqueta adicionada'); await recarregar();
  });
  $$('[data-del]', el).forEach((b) => (b.onclick = tentar(async () => { await api('/tags/' + b.dataset.del, 'DELETE'); await recarregar(); })));
}

// ---------- outras lojas (Amazon, Shopee, Magalu, Facebook) ----------
// Os campos vêm do registro do servidor (GET /api/conexoes → campos). O valor de um segredo nunca vem nem é
// posto no HTML: o servidor só diz quais estão salvos (segredos_salvos); campo de segredo vazio ao salvar
// mantém o que está guardado. Sem segredos_salvos na resposta (Operador), o campo de segredo fica travado.
async function outrasLojas() {
  const el = $('#outras-lojas'); if (!el) return;
  el.innerHTML = `<p class="dica" role="status">${TEXTOS_CONEXOES.carregando}</p>`;
  let lista;
  try { lista = await api('/conexoes'); } catch (e) {
    if (el.isConnected) el.innerHTML = `<div class="vazio" role="status">${esc(`${TEXTOS_CONEXOES.erroCarregar} ${e.message}`)}</div>`;
    return;
  }
  if (!el.isConnected || !Array.isArray(lista)) return; // saiu da página enquanto carregava
  const outras = lista.filter((p) => p && p.id !== 'mercadolivre');
  el.innerHTML = outras.map(cartaoConexao).join('');
  outras.forEach((p) => { const art = $(`#cx-${CSS.escape(p.id)}`, el); if (art) { aplicarConexao(art, p); ligarConexao(art, p); } });
}

/** Classe e texto do selo para o `estado` que o servidor manda. Texto sempre visível (nunca só cor). */
function pillConexao(estado) {
  return {
    conectado: ['conectado', TEXTOS_CONEXOES.conectado], pronta: ['pronta', TEXTOS_CONEXOES.pronta],
    falta_configurar: ['falta', TEXTOS_CONEXOES.falta],
  }[estado] || ['impl', TEXTOS_CONEXOES.impl];
}

function cartaoConexao(p) {
  const id = esc(p.id); const campos = Array.isArray(p.campos) ? p.campos : [];
  const aviso = p.implementada ? '' : `<div class="aviso-impl"><p>${campos.length ? TEXTOS_CONEXOES.avisoImpl : TEXTOS_CONEXOES.avisoImplSemCampos}</p></div>`;
  const form = !campos.length ? '' : `<form novalidate>
      ${campos.map((c) => campoConexao(p, c)).join('')}
      <div class="acoes"><button type="submit" class="pri">Salvar</button><button type="button" data-testar aria-describedby="cx-${id}-estado">Testar</button></div>
      <p class="estado-linha" id="cx-${id}-estado" role="status"></p>
    </form>`;
  return `<article class="card conexao" id="cx-${id}" aria-labelledby="cx-${id}-h">
    <header class="cab"><h2 id="cx-${id}-h">${esc(p.nome || p.id)}</h2><span class="estado-pill"></span></header>
    ${p.descricao ? `<p class="desc">${esc(p.descricao)}</p>` : ''}
    ${aviso}${form}
  </article>`;
}

/** Um campo do registro. Sem `value` no segredo (nunca vem do servidor) e sem maxlength (cortaria a chave colada sem avisar). */
function campoConexao(p, c) {
  const id = `cx-${esc(p.id)}-${esc(c.nome)}`;
  const dica = c.ajuda ? `<small class="dica" id="${id}-dica">${esc(c.ajuda)}</small>` : '';
  const desc = c.ajuda ? ` aria-describedby="${id}-dica"` : '';
  if (c.tipo === 'segredo') {
    // new-password: o Chrome não preenche aqui a senha do painel que ele guardou
    return `<label class="campo"><span>${esc(c.rotulo)} ${q('conexoes.segredo')}</span>
      <input type="password" name="${esc(c.nome)}" id="${id}" autocomplete="new-password" spellcheck="false"${desc}>${dica}</label>`;
  }
  return `<label class="campo"><span>${esc(c.rotulo)}</span>
    <input type="text" name="${esc(c.nome)}" id="${id}" autocomplete="off" spellcheck="false"${desc}>${dica}</label>`;
}

/** Põe no cartão o que o servidor respondeu: selo, valores de texto, placeholder do segredo e linha de estado. */
function aplicarConexao(art, p) {
  const [cls, txt] = pillConexao(p.estado);
  const selo = $('.cab .estado-pill', art); selo.className = 'estado-pill ' + cls; selo.textContent = txt;
  const form = $('form', art); if (!form) return;
  const salvos = Array.isArray(p.segredos_salvos) ? p.segredos_salvos : null;
  for (const c of p.campos) {
    const el = form.elements.namedItem(c.nome); if (!el) continue;
    if (c.tipo === 'segredo') {
      el.value = ''; el.disabled = !salvos;
      el.placeholder = !salvos ? TEXTOS_CONEXOES.segredoSoDono : salvos.includes(c.nome) ? TEXTOS_CONEXOES.segredoSalvo : '';
    } else el.value = p.config?.[c.nome] ?? '';
  }
  $('[data-testar]', form).disabled = !p.updated_at; // "Testar" só depois de salvar; a linha abaixo diz por quê
  const linha = $('.estado-linha', form); linha.classList.remove('aviso');
  linha.textContent = p.updated_at ? TEXTOS_CONEXOES.salvoEm(p.updated_at) : TEXTOS_CONEXOES.nadaSalvo;
}

/** Erro de um campo, igual ao que o servidor confere (max e padrao do registro). Nunca repete o valor. */
function erroCampoConexao(c, v) {
  if (v.length > c.max) return `${c.rotulo}: até ${c.max} caracteres.`;
  let re = null; try { re = c.padrao ? new RegExp(c.padrao) : null; } catch { /* o servidor confere */ }
  if (!re || re.test(v)) return '';
  return c.tipo === 'segredo' ? `${c.rotulo}: ${TEXTOS_CONEXOES.formatoSegredo}` : `${c.rotulo}: formato inválido.${c.ajuda ? ' ' + c.ajuda : ''}`;
}

/** { campos, erros } do formulário. Segredo vazio não vai (mantém o salvo); texto vazio vai e apaga. */
function lerFormConexao(form, p) {
  const campos = {}; const erros = [];
  for (const c of p.campos) {
    const el = form.elements.namedItem(c.nome); if (!el || el.disabled) continue;
    const v = String(el.value || '').trim();
    if (c.tipo === 'segredo' && !v) continue;
    const msg = v ? erroCampoConexao(c, v) : '';
    if (msg) erros.push({ msg, el }); else campos[c.nome] = v;
  }
  return { campos, erros };
}

function ligarConexao(art, p) {
  const form = $('form', art); if (!form) return;
  let atual = p;
  const linha = $('.estado-linha', form); const salvar = $('[type=submit]', form); const testar = $('[data-testar]', form);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const { campos, erros } = lerFormConexao(form, atual);
    if (mostrarErros(form, erros)) return;
    salvar.disabled = true; salvar.textContent = 'Salvando…'; linha.classList.remove('aviso'); linha.textContent = 'Salvando…';
    try {
      atual = await api('/conexoes/' + encodeURIComponent(atual.id), 'PUT', { campos });
      aplicarConexao(art, atual); // limpa o campo de segredo e troca o placeholder para "salva"
      aviso(`${atual.nome}: dados salvos`);
    } catch (e) {
      linha.textContent = '';
      mostrarErros(form, [{ msg: e.message }]);
    } finally { salvar.disabled = false; salvar.textContent = 'Salvar'; }
  };
  testar.onclick = async () => {
    testar.disabled = true; testar.textContent = 'Testando…';
    try {
      const r = await api('/conexoes/' + encodeURIComponent(atual.id) + '/testar', 'POST', {});
      linha.textContent = r.mensagem; linha.classList.toggle('aviso', !r.ok);
    } catch (e) {
      linha.textContent = e.message; linha.classList.add('aviso');
    } finally { testar.disabled = !atual.updated_at; testar.textContent = 'Testar'; }
  };
}
