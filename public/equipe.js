// Equipe (#equipe, F5, só para o Dono) e "Complete seu cadastro" (primeiro acesso do Dono migrado).
// Por enquanto só o esqueleto ("Em construção"): a etapa 12 do plano docs/produto/planos/disparos-comunicacao-conta.md
// preenche as telas conforme a spec (docs/produto/specs/disparos-comunicacao-conta.md).
// A rota fica em ROTAS (app.js), que também tira o item Equipe do menu e a rota do Operador (podeEquipe).
// Carrega antes de app.js: só define funções.

const TEXTOS_EQUIPE = {
  titulo: 'Equipe',
  sub: 'Pessoas que usam esta conta. Todas veem e mexem nos mesmos números, links e grupos.',
  cadastro: 'Complete seu cadastro',
  construcao: 'Esta tela ainda está sendo feita e aparece aqui numa próxima atualização do painel.',
};

function paginaEquipe() {
  const t = TEXTOS_EQUIPE;
  $('#pagina').innerHTML = `<div class="topo"><div><h1>${t.titulo} ${q('equipe')}</h1><p class="sub">${t.sub}</p></div></div>
    <div class="card"><h2>Em construção</h2><p class="sub">${t.construcao}</p></div>`;
}

/** Primeiro acesso: pede nome e e-mail (PUT /api/me). app.js chama quando /api/state traz usuario.precisa_completar. */
function completarCadastro() {
  const dlg = $('#dlg');
  dlg.innerHTML = `<div class="corpo"><h1>${TEXTOS_EQUIPE.cadastro}</h1><p class="sub">${TEXTOS_EQUIPE.construcao}</p>
    <div class="rodape"><button type="button" class="pri" id="fechar">Fechar</button></div></div>`;
  $('#fechar', dlg).onclick = () => dlg.close();
  dlg.showModal();
}
