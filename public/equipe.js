// Equipe (#equipe, F5, só para o Dono), "Proteja o painel" (painel ainda sem login) e "Complete seu cadastro"
// (primeiro acesso do Dono migrado, que ainda não tem e-mail).
// Contrato: docs/produto/planos/entrega2-contrato.md. Spec: docs/produto/specs/disparos-comunicacao-conta.md ("Equipe (F5)").
// A rota fica em ROTAS (app.js), que também tira o item Equipe do menu e a rota do Operador (podeEquipe).
// Carrega antes de app.js: só define funções e constantes. Os utilitários de app.js e paineis.js ($, $$, esc, api,
// aviso, tentar, mostrarErros, REQ, S, ir, rotaAtual, atualizarEstado, dataHora) e de ajuda.js (q) só são usados
// quando as funções rodam. CSP script-src 'self': nada inline.
// O link do convite só chega ao navegador ao criar o convite e a cada "Copiar link" (que gera um link novo e mata o
// anterior). A lista (GET /api/equipe) nunca traz token nem link.

const TEXTOS_EQUIPE = {
  titulo: 'Equipe',
  sub: 'Pessoas que usam esta conta. Todas veem e mexem nos mesmos números, links e grupos.',
  carregando: 'Carregando…',
  naoCarregou: 'Não consegui carregar a equipe.',
  // campos comuns
  nome: 'Seu nome', email: 'E-mail', emailDica: 'É com ele que você vai entrar.', emailPh: 'nome@exemplo.com',
  senha: 'Senha', confirma: 'Confirmar senha', senhaDica: 'Ao menos 8 caracteres.',
  mostrar: 'Mostrar', mostrarSenha: 'Mostrar senha',
  faltaNome: 'Escreva o seu nome.', faltaEmail: 'Escolha um e-mail válido.',
  senhaCurta: 'A senha precisa de ao menos 8 caracteres.', senhasDiferentes: 'As senhas não são iguais.',
  salvar: 'Salvar', salvando: 'Salvando…',
  // Proteja o painel (sem login)
  proteger: 'Proteja o painel',
  protegerSub: 'Crie a sua conta de Dono: o painel passa a pedir e-mail e senha, e você pode convidar a equipe.',
  protegerDica: 'Depois disso o painel pede login. Você continua conectado neste navegador.',
  ativar: 'Ativar login', ativando: 'Ativando…', ativado: 'Login ativado',
  // nome da conta
  conta: 'Nome da conta', contaDica: 'Aparece no convite.', contaPh: 'Ex.: Achadinhos do Pedro', contaSalva: 'Nome da conta salvo',
  // convidar
  convidar: 'Convidar pessoa', papel: 'Papel', papeis: { operador: 'Operador', dono: 'Dono' },
  convidarDica: 'Operador usa todas as telas. Dono também convida, remove pessoas e muda papéis. O convite vale por 7 dias.',
  criar: 'Criar convite', criando: 'Criando…', criado: 'Convite criado',
  criadoPara: (email) => `Convite criado para ${email}.`,
  linkCriado: 'Mande este link para a pessoa. Ele só aparece completo agora; depois, “Copiar link” na lista gera um link novo.',
  linkDe: (email) => `Link do convite de ${email}`,
  copiarLink: 'Copiar link', copiarLinkDe: (email) => `Copiar link do convite de ${email}`, gerando: 'Gerando…',
  copiado: 'Link do convite copiado',
  linkNovoCopiado: 'Link do convite copiado. O link anterior deixou de funcionar.',
  linkNovoManual: (email) => `Link novo do convite de ${email}. O anterior deixou de funcionar. Não consegui copiar sozinho: selecione o link e copie (Ctrl+C).`,
  copieManual: 'Não consegui copiar sozinho: selecione o link e copie (Ctrl+C).',
  // pessoas
  pessoas: (n) => `Pessoas (${n})`,
  colPessoas: ['Pessoa', 'Papel', 'Entrou em', 'Ações'],
  voce: 'você', ehVoce: 'É você', ultimoDono: 'Último Dono',
  ultimoAcesso: (ms) => `Último acesso em ${dataHora(ms)}`,
  tornar: { dono: 'Tornar Dono', operador: 'Tornar Operador' },
  tornarDe: (nome, papel) => `Tornar ${nome} ${papel === 'dono' ? 'Dono' : 'Operador'}`,
  confirmaDono: (nome) => `Tornar ${nome} Dono? Essa pessoa também vai poder convidar, remover pessoas e mudar papéis, inclusive o seu.`,
  papelAlterado: 'Papel alterado',
  remover: 'Remover da equipe', removerDe: (nome) => `Remover ${nome} da equipe`,
  confirmaRemover: (nome) => `Remover ${nome} da equipe? Essa pessoa perde o acesso agora.`,
  removida: 'Pessoa removida',
  // convites
  convites: (n) => `Convites pendentes (${n})`,
  colConvites: ['E-mail', 'Papel', 'Vence em', 'Ações'],
  semConvites: 'Nenhum convite pendente.',
  convidadoPor: (nome) => `convidado por ${nome}`,
  vencido: 'Vencido', venceHoje: 'vence hoje', venceAmanha: 'vence amanhã',
  cancelar: 'Cancelar convite', cancelarDe: (email) => `Cancelar o convite para ${email}`,
  confirmaCancelar: (email) => `Cancelar o convite para ${email}? O link deixa de funcionar.`,
  cancelado: 'Convite cancelado',
  // complete seu cadastro
  cadastro: 'Complete seu cadastro',
  cadastroSub: 'Agora cada pessoa entra no painel com o próprio e-mail. Diga o seu nome e o e-mail que vai usar para entrar.',
  novaSenha: 'Nova senha (opcional)', novaSenhaDica: 'Deixe em branco para continuar com a senha atual.',
  confirmaNova: 'Confirmar nova senha',
  depois: 'Depois', cadastroCompleto: 'Cadastro completo',
};
const EQ_SENHA_MIN = 8;
const EQ_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // o mesmo formato básico que o servidor confere (algo@algo.algo)
const EQ_NOME_MIGRACAO = 'Dono'; // nome que a migração dá ao Dono antigo: em "Complete seu cadastro" o campo vem vazio
let eqDados = null;   // última resposta de GET /api/equipe (as ações da lista acham a pessoa ou o convite por id)
let eqCriado = null;  // { id, email, link } do convite criado nesta visita: o bloco de sucesso acompanha o link dele
let eqManual = null;  // { id, email, link }: "Copiar link" sem área de transferência mostra o link para copiar à mão

// ---------- utilitários da tela ----------
const eqTopo = (sub) => `<div class="topo"><div><h1>${TEXTOS_EQUIPE.titulo} ${q('equipe')}</h1><p class="sub">${sub}</p></div></div>`;
const eqEmailOk = (v) => v.length <= 120 && EQ_EMAIL.test(v);
const eqPapel = (p) => (p === 'dono'
  ? `<span class="estado-pill dono">${TEXTOS_EQUIPE.papeis.dono}</span>` : `<span class="estado-pill">${TEXTOS_EQUIPE.papeis.operador}</span>`);
const eqData = (ms) => (ms ? new Date(ms).toLocaleDateString('pt-BR') : '—');

/** Campo de senha com "Mostrar" (aria-pressed). `controla` = ids dos campos que o botão mostra junto (senha e confirmação). */
function eqCampoSenha({ id, nome, rotulo, dica, controla = [id], obrigatorio = false }) {
  return `<div class="campo"><label for="${id}">${rotulo}</label>
    <div class="senha-campo"><input id="${id}" name="${nome}" type="password" autocomplete="new-password" spellcheck="false"${obrigatorio ? ' required' : ''}${dica ? ` aria-describedby="${id}-dica"` : ''}>
      <button type="button" class="alt" data-ver-senha="${controla.join(' ')}" aria-controls="${controla.join(' ')}" aria-pressed="false" aria-label="${TEXTOS_EQUIPE.mostrarSenha}">${TEXTOS_EQUIPE.mostrar}</button></div>
    ${dica ? `<small id="${id}-dica">${dica}</small>` : ''}</div>`;
}
function eqLigarVerSenha(raiz) {
  $$('[data-ver-senha]', raiz).forEach((b) => (b.onclick = () => {
    const ver = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(ver)); b.classList.toggle('on', ver);
    b.dataset.verSenha.split(' ').forEach((id) => { const i = document.getElementById(id); if (i) i.type = ver ? 'text' : 'password'; });
  }));
}

/** Erros de nome, e-mail e senha (com confirmação). `senhaOpcional`: vazio passa (Complete seu cadastro). */
function eqValidar(f, { senhaOpcional = false } = {}) {
  const t = TEXTOS_EQUIPE; const campo = (n) => $(`[name=${n}]`, f); const erros = [];
  if (!campo('nome').value.trim()) erros.push({ msg: t.faltaNome, el: campo('nome') });
  if (!eqEmailOk(campo('email').value.trim())) erros.push({ msg: t.faltaEmail, el: campo('email') });
  const senha = campo('senha').value;
  if (senha || !senhaOpcional) {
    if (senha.length < EQ_SENHA_MIN) erros.push({ msg: t.senhaCurta, el: campo('senha') });
    else if (senha !== campo('confirma').value) erros.push({ msg: t.senhasDiferentes, el: campo('confirma') });
  }
  return erros;
}

/** Copia para a área de transferência; false quando o navegador não deixa (ex.: endereço sem HTTPS fora do localhost). */
async function eqCopiar(texto) {
  try { if (!navigator.clipboard?.writeText) return false; await navigator.clipboard.writeText(texto); return true; } catch { return false; }
}

// ---------- página ----------
function paginaEquipe() {
  eqDados = null; eqCriado = null; eqManual = null;
  if (!S.st?.auth) { eqProteger(); return; }
  $('#pagina').innerHTML = eqTopo(TEXTOS_EQUIPE.carregando);
  eqCarregar();
}

async function eqCarregar() {
  const t = TEXTOS_EQUIPE; let d;
  try { d = await api('/equipe'); } catch (e) {
    if (rotaAtual() === 'equipe') $('#pagina').innerHTML = `${eqTopo(t.sub)}<div class="vazio" role="status">${esc(`${t.naoCarregou} ${e.message}`)}</div>`;
    return;
  }
  if (rotaAtual() !== 'equipe') return; // saiu da página enquanto carregava
  eqPintar(d);
}

// ---------- "Proteja o painel": o painel ainda não tem login (auth:false) ----------
function eqProteger() {
  const t = TEXTOS_EQUIPE;
  $('#pagina').innerHTML = `${eqTopo(t.sub)}
    <section class="card" aria-labelledby="eq-prot-h"><h2 id="eq-prot-h">${t.proteger} ${q('equipe.ativar')}</h2>
      <p class="sub" style="margin-top:0">${t.protegerSub}</p>
      <form id="eq-ativar" class="form-pilha eq-form" novalidate>
        <div class="grade eq-campos">
          <label class="campo"><span>${t.nome} ${REQ}</span><input name="nome" maxlength="80" autocomplete="name" required></label>
          <label class="campo"><span>${t.email} ${REQ}</span><input name="email" type="email" maxlength="120" autocomplete="username" placeholder="${t.emailPh}" required aria-describedby="eq-at-email-d"><small id="eq-at-email-d">${t.emailDica}</small></label>
          ${eqCampoSenha({ id: 'eq-at-senha', nome: 'senha', rotulo: `${t.senha} ${REQ}`, dica: t.senhaDica, controla: ['eq-at-senha', 'eq-at-confirma'], obrigatorio: true })}
          <label class="campo"><span>${t.confirma} ${REQ}</span><input id="eq-at-confirma" name="confirma" type="password" autocomplete="new-password" required></label>
        </div>
        <p class="dica" style="margin:0">${t.protegerDica}</p>
        <div class="rodape-card"><button type="submit" class="pri" id="eq-ativar-btn">${t.ativar}</button></div>
      </form></section>`;
  const f = $('#eq-ativar'); eqLigarVerSenha(f);
  f.onsubmit = tentar(async (ev) => {
    ev.preventDefault();
    if (eqErros(f, eqValidar(f))) return;
    const campo = (n) => $(`[name=${n}]`, f); const btn = $('#eq-ativar-btn');
    btn.disabled = true; btn.textContent = t.ativando;
    try {
      await api('/equipe/ativar', 'POST', { nome: campo('nome').value.trim(), email: campo('email').value.trim(), senha: campo('senha').value });
    } catch (e) { eqErros(f, [{ msg: e.message }]); return; } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = t.ativar; } }
    await atualizarEstado(true); // agora com login: Sair, a pessoa no menu e a tela de Dono
    aviso(t.ativado);
    if (rotaAtual() === 'equipe') ir();
  });
}

/** mostrarErros de app.js, com a caixa logo acima do rodapé do card. */
function eqErros(form, erros) {
  const tem = mostrarErros(form, erros);
  const box = $('.erros', form); const rod = $('.rodape-card', form);
  if (box && rod && box.nextElementSibling !== rod) form.insertBefore(box, rod);
  return tem;
}

// ---------- Equipe do Dono ----------
function eqPintar(d) {
  const t = TEXTOS_EQUIPE; eqDados = d; const pg = $('#pagina');
  pg.innerHTML = `${eqTopo(t.sub)}
    <div class="grade eq-grade">
      <section class="card" aria-labelledby="eq-conta-h"><h2 id="eq-conta-h">${t.conta}</h2>
        <form id="eq-conta" class="form-pilha eq-form" novalidate>
          <div class="linha"><input name="conta_nome" maxlength="60" value="${esc(d.conta_nome || '')}" placeholder="${t.contaPh}" aria-labelledby="eq-conta-h" aria-describedby="eq-conta-d" style="flex:1 1 180px;width:auto">
            <button type="submit" id="eq-conta-btn">${t.salvar}</button></div>
          <small class="dica" id="eq-conta-d">${t.contaDica}</small>
        </form></section>
      <section class="card" aria-labelledby="eq-conv-h"><h2 id="eq-conv-h">${t.convidar} ${q('equipe.convite')}</h2>
        <form id="eq-convidar" class="form-pilha eq-form" novalidate>
          <div class="grade" style="align-items:start">
            <label class="campo"><span>${t.email} ${REQ}</span><input name="email" type="email" maxlength="120" autocomplete="off" placeholder="${t.emailPh}" required></label>
            <label class="campo"><span>${t.papel}</span><select name="papel"><option value="operador">${t.papeis.operador}</option><option value="dono">${t.papeis.dono}</option></select></label>
          </div>
          <small class="dica">${t.convidarDica}</small>
          <div class="rodape-card"><button type="submit" class="pri" id="eq-criar-btn">${t.criar}</button></div>
        </form>
        <div id="eq-criado" role="status"></div></section>
    </div>
    <div id="eq-listas">${eqListasHtml(d)}</div>`;
  eqLigarConta(); eqLigarConvidar();
  // Botões das listas por delegação (#pagina.onclick é zerado por ir() ao trocar de página).
  pg.onclick = tentar(async (ev) => {
    const b = ev.target.closest('button[data-eq]'); if (!b || !$('#eq-listas')?.contains(b)) return;
    const id = Number(b.closest('[data-id]')?.dataset.id);
    if (b.dataset.eq === 'manual-copiar') { const i = $('#eq-manual-link'); i.focus(); i.select(); aviso(await eqCopiar(i.value) ? t.copiado : t.copieManual); return; }
    if (b.dataset.eq === 'copiar') return eqCopiarLink(eqDados.convites.find((c) => c.id === id), b);
    if (b.dataset.eq === 'cancelar') return eqCancelar(eqDados.convites.find((c) => c.id === id));
    if (b.dataset.eq === 'papel') return eqMudarPapel(eqDados.pessoas.find((p) => p.id === id), b.dataset.papel);
    if (b.dataset.eq === 'remover') return eqRemover(eqDados.pessoas.find((p) => p.id === id));
  });
}

function eqListasHtml(d) {
  const t = TEXTOS_EQUIPE; const pessoas = d.pessoas || []; const convites = d.convites || [];
  const th = (cols) => cols.map((c, i) => `<th scope="col"${i === cols.length - 1 ? ' style="text-align:right"' : ''}>${c}</th>`).join('');
  const acoesPessoa = (p) => {
    if (p.voce || p.ultimo_dono) return `<span class="dica">${p.ultimo_dono ? t.ultimoDono : t.ehVoce}</span>`;
    const outro = p.papel === 'dono' ? 'operador' : 'dono';
    return `<button type="button" data-eq="papel" data-papel="${outro}" aria-label="${esc(t.tornarDe(p.nome, outro))}">${t.tornar[outro]}</button>
      <button type="button" class="perigo leve" data-eq="remover" aria-label="${esc(t.removerDe(p.nome))}">${t.remover}</button>`;
  };
  const pessoasHtml = `<section class="card" aria-labelledby="eq-pes-h"><h2 id="eq-pes-h" tabindex="-1">${t.pessoas(pessoas.length)}</h2>
    <div class="tabela"><table><thead><tr>${th(t.colPessoas)}</tr></thead><tbody>
    ${pessoas.map((p) => `<tr data-id="${p.id}">
      <td><b>${esc(p.nome)}</b>${p.voce ? `<span class="chip voce">${t.voce}</span>` : ''}<span class="dica-celula">${esc(p.email || '')}</span></td>
      <td>${eqPapel(p.papel)}</td>
      <td>${eqData(p.created_at)}${p.last_login_at ? `<span class="dica-celula">${t.ultimoAcesso(p.last_login_at)}</span>` : ''}</td>
      <td style="text-align:right;white-space:nowrap">${acoesPessoa(p)}</td></tr>`).join('')}
    </tbody></table></div></section>`;

  const vence = (c) => {
    if (c.vencido || c.expires_at <= Date.now()) return `<span class="estado-pill falta">${t.vencido}</span>`;
    const dia = (ms) => { const x = new Date(ms); return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    const faltam = Math.round((dia(c.expires_at) - dia(Date.now())) / 86400000);
    const alerta = faltam <= 0 ? t.venceHoje : faltam === 1 ? t.venceAmanha : '';
    return `${dataHora(c.expires_at)}${alerta ? ` <span class="venc-aviso">${alerta}</span>` : ''}`;
  };
  const manual = eqManual && convites.some((c) => c.id === eqManual.id) ? `<div class="sucesso eq-manual" role="status">
      <p>${esc(t.linkNovoManual(eqManual.email))}</p>
      <div class="copia"><input readonly id="eq-manual-link" value="${esc(eqManual.link)}" aria-label="${esc(t.linkDe(eqManual.email))}"><button type="button" data-eq="manual-copiar">${t.copiarLink}</button></div></div>` : '';
  const convitesHtml = `<section class="card" aria-labelledby="eq-cvs-h"><h2 id="eq-cvs-h" tabindex="-1">${t.convites(convites.length)}</h2>
    ${convites.length ? `<div class="tabela"><table><thead><tr>${th(t.colConvites)}</tr></thead><tbody>
    ${convites.map((c) => { const vencido = c.vencido || c.expires_at <= Date.now(); return `<tr data-id="${c.id}">
      <td>${esc(c.email)}${c.convidado_por ? `<span class="dica-celula">${esc(t.convidadoPor(c.convidado_por))}</span>` : ''}</td>
      <td>${eqPapel(c.papel)}</td>
      <td>${vence(c)}</td>
      <td style="text-align:right;white-space:nowrap">${vencido ? '' : `<button type="button" data-eq="copiar" aria-label="${esc(t.copiarLinkDe(c.email))}">${t.copiarLink}</button>`}
        <button type="button" class="perigo leve" data-eq="cancelar" aria-label="${esc(t.cancelarDe(c.email))}">${t.cancelar}</button></td></tr>`; }).join('')}
    </tbody></table></div>${manual}` : `<div class="vazio">${t.semConvites}</div>`}</section>`;
  return pessoasHtml + convitesHtml;
}

/**
 * Busca a equipe de novo e redesenha só as listas (os formulários e o bloco do convite criado ficam).
 * `foco` = seletor (dentro das listas) que recebe o foco depois, já que o botão clicado foi redesenhado; sem ele
 * (ou se sumiu, como a linha removida), o foco vai ao título da lista `titulo`.
 */
async function eqRecarregarListas({ foco, titulo } = {}) {
  const d = await api('/equipe');
  const el = $('#eq-listas'); if (rotaAtual() !== 'equipe' || !el) return;
  const tinhaFoco = el.contains(document.activeElement) || document.activeElement === document.body;
  eqDados = d; el.innerHTML = eqListasHtml(d);
  if (!tinhaFoco) return; // o foco estava em outro lugar (ex.: no "Copiar link" do convite recém-criado): fica lá
  const alvo = (foco && $(foco, el)) || (titulo && $(titulo, el));
  alvo?.focus(); if (alvo?.id === 'eq-manual-link') alvo.select();
}

function eqLigarConta() {
  const t = TEXTOS_EQUIPE; const f = $('#eq-conta');
  f.onsubmit = tentar(async (ev) => {
    ev.preventDefault();
    const btn = $('#eq-conta-btn'); const nome = $('[name=conta_nome]', f).value.trim();
    btn.disabled = true; btn.textContent = t.salvando;
    try { await api('/equipe/conta', 'PUT', { conta_nome: nome }); } catch (e) { mostrarErros(f, [{ msg: e.message }]); return; } finally {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = t.salvar; }
    }
    mostrarErros(f, []); S.st.conta_nome = nome; aviso(t.contaSalva);
  });
}

function eqLigarConvidar() {
  const t = TEXTOS_EQUIPE; const f = $('#eq-convidar'); const campo = (n) => $(`[name=${n}]`, f);
  f.onsubmit = tentar(async (ev) => {
    ev.preventDefault();
    const email = campo('email').value.trim(); const papel = campo('papel').value;
    if (eqErros(f, eqEmailOk(email) ? [] : [{ msg: t.faltaEmail, el: campo('email') }])) return;
    const btn = $('#eq-criar-btn'); btn.disabled = true; btn.textContent = t.criando;
    let r;
    try { r = await api('/equipe/convites', 'POST', { email, papel }); } catch (e) {
      eqErros(f, [{ msg: e.message, el: campo('email') }]); return;
    } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = t.criar; } }
    f.reset(); eqCriado = { id: r.id, email, link: r.link };
    eqPintarCriado(); aviso(t.criado);
    $('#eq-criado-copiar')?.focus(); // spec: depois de criar, o foco vai ao "Copiar link"
    await eqRecarregarListas();
  });
}

/** Bloco de sucesso do convite criado: o link aparece completo só aqui (e a cada "Copiar link", já como link novo). */
function eqPintarCriado() {
  const t = TEXTOS_EQUIPE; const el = $('#eq-criado'); if (!el) return;
  if (!eqCriado) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="sucesso"><p><b>${esc(t.criadoPara(eqCriado.email))}</b> ${t.linkCriado}</p>
    <div class="copia"><input readonly id="eq-criado-link" value="${esc(eqCriado.link)}" aria-label="${esc(t.linkDe(eqCriado.email))}"><button type="button" id="eq-criado-copiar">${t.copiarLink}</button></div></div>`;
  const input = $('#eq-criado-link');
  input.onfocus = () => input.select();
  $('#eq-criado-copiar').onclick = async () => {
    if (await eqCopiar(input.value)) aviso(t.copiado); else { input.focus(); input.select(); aviso(t.copieManual); }
  };
}

/** "Copiar link" da lista: o servidor gera um link novo (o anterior para de funcionar e o prazo volta a 7 dias). */
async function eqCopiarLink(c, btn) {
  const t = TEXTOS_EQUIPE; if (!c) return;
  btn.disabled = true; btn.textContent = t.gerando;
  let r;
  try { r = await api(`/equipe/convites/${c.id}/link`, 'POST'); } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = t.copiarLink; } }
  if (eqCriado?.id === c.id) { eqCriado.link = r.link; eqPintarCriado(); } // o link mostrado acima morreu: troca pelo novo
  const copiou = await eqCopiar(r.link);
  eqManual = copiou ? null : { id: c.id, email: c.email, link: r.link };
  aviso(copiou ? t.linkNovoCopiado : t.copieManual);
  // o prazo do convite foi renovado; sem área de transferência, o foco vai ao link para copiar à mão
  await eqRecarregarListas({ foco: copiou ? `tr[data-id="${c.id}"] [data-eq=copiar]` : '#eq-manual-link', titulo: '#eq-cvs-h' });
}

async function eqCancelar(c) {
  const t = TEXTOS_EQUIPE; if (!c || !confirm(t.confirmaCancelar(c.email))) return;
  await api(`/equipe/convites/${c.id}`, 'DELETE');
  if (eqCriado?.id === c.id) { eqCriado = null; eqPintarCriado(); }
  if (eqManual?.id === c.id) eqManual = null;
  aviso(t.cancelado); await eqRecarregarListas({ titulo: '#eq-cvs-h' });
}

async function eqMudarPapel(p, papel) {
  const t = TEXTOS_EQUIPE; if (!p || !['dono', 'operador'].includes(papel)) return;
  if (papel === 'dono' && !confirm(t.confirmaDono(p.nome))) return;
  await api(`/equipe/pessoas/${p.id}`, 'PUT', { papel });
  aviso(t.papelAlterado); await eqRecarregarListas({ foco: `tr[data-id="${p.id}"] [data-eq=papel]`, titulo: '#eq-pes-h' });
}

async function eqRemover(p) {
  const t = TEXTOS_EQUIPE; if (!p || !confirm(t.confirmaRemover(p.nome))) return;
  await api(`/equipe/pessoas/${p.id}`, 'DELETE');
  aviso(t.removida); await eqRecarregarListas({ titulo: '#eq-pes-h' });
}

// ---------- "Complete seu cadastro" ----------
/** Primeiro acesso do Dono migrado (sem e-mail): nome, e-mail e nova senha opcional (PUT /api/me). app.js chama
 *  quando /api/state traz usuario.precisa_completar; volta a cada carga da página até completar, sem travar o resto. */
function completarCadastro() {
  const t = TEXTOS_EQUIPE; const u = S.st?.usuario || {}; const dlg = $('#dlg');
  const nome = u.nome && u.nome !== EQ_NOME_MIGRACAO ? u.nome : '';
  dlg.innerHTML = `<form method="dialog" id="eq-cadastro" novalidate><h1>${t.cadastro}</h1>
    <p class="sub" style="margin-top:-8px">${t.cadastroSub}</p>
    <div class="grade eq-campos">
      <label class="campo"><span>${t.nome} ${REQ}</span><input name="nome" maxlength="80" autocomplete="name" value="${esc(nome)}" required></label>
      <label class="campo"><span>${t.email} ${REQ}</span><input name="email" type="email" maxlength="120" autocomplete="username" value="${esc(u.email || '')}" placeholder="${t.emailPh}" required aria-describedby="eq-cad-email-d"><small id="eq-cad-email-d">${t.emailDica}</small></label>
      ${eqCampoSenha({ id: 'eq-cad-senha', nome: 'senha', rotulo: t.novaSenha, dica: t.novaSenhaDica, controla: ['eq-cad-senha', 'eq-cad-confirma'] })}
      <label class="campo"><span>${t.confirmaNova}</span><input id="eq-cad-confirma" name="confirma" type="password" autocomplete="new-password"></label>
    </div>
    <div class="rodape"><button type="button" id="eq-depois">${t.depois}</button><button class="pri" id="eq-cad-salvar">${t.salvar}</button></div></form>`;
  const f = $('#eq-cadastro', dlg); const campo = (n) => $(`[name=${n}]`, f);
  eqLigarVerSenha(f);
  $('#eq-depois', f).onclick = () => dlg.close();
  f.onsubmit = tentar(async (ev) => {
    ev.preventDefault();
    if (mostrarErros(f, eqValidar(f, { senhaOpcional: true }))) return;
    const corpo = { nome: campo('nome').value.trim(), email: campo('email').value.trim() };
    if (campo('senha').value) corpo.senha = campo('senha').value;
    const btn = $('#eq-cad-salvar', f); btn.disabled = true; btn.textContent = t.salvando;
    try { await api('/me', 'PUT', corpo); } catch (e) {
      btn.disabled = false; btn.textContent = t.salvar; mostrarErros(f, [{ msg: e.message }]); return;
    }
    dlg.close(); aviso(t.cadastroCompleto);
    atualizarEstado().catch(() => {}); // nome e e-mail no menu
  });
  dlg.showModal(); campo(nome ? 'email' : 'nome').focus();
}
