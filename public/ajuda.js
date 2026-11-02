// Ajuda: ícones "?" com explicação ao passar o mouse (ou focar com Tab) e a página "Ajuda" do menu.
// Carrega antes de app.js: só define coisas; não usa nada de lá ao carregar.

const TIPS = {
  // regras
  'regras': 'Uma regra é um disparo automático: escolhe a etiqueta, o template, as fontes de ofertas, os grupos e o ritmo. Pode ter quantas quiser.',
  'regras.etiqueta': 'Nome da sua etiqueta no programa de afiliados do Mercado Livre. Entra em todo link meli.la desta regra e é o que atribui a comissão a você.',
  'regras.template': 'Modelo da mensagem. Campos como {PRECO_PRODUTO} são preenchidos com a oferta; linha com campo vazio some sozinha.',
  'regras.fontes': 'De onde vêm as ofertas. Até 5 fontes por regra; com mais de uma, saem intercaladas (uma de cada fonte por vez). Fonte que falhar vira aviso, as outras seguem.',
  'fonte.tipos': 'Central de Afiliados: lista pronta do Mercado Livre, com filtros. Lista de links: você cola os produtos. Busca: experimental, pode ser recusada pelo ML.',
  'fonte.busca': 'Palavras que a Central usa para filtrar a lista (ex.: “organizador”). Vazio = sem filtro de texto.',
  'fonte.paginas': 'Quantas páginas da Central são lidas a cada envio (18 produtos por página). Mais páginas = mais variedade, busca um pouco mais demorada.',
  'fonte.categorias': 'Nenhuma marcada = todas. Com várias, as ofertas saem intercaladas (uma de cada categoria por vez): bom para grupos de achadinhos gerais.',
  'fonte.maisvendidos': 'Só produtos com o selo “Mais vendido” da Central.',
  'fonte.ganhos': 'Só produtos com comissão extra (“Ganhos extras”) neste momento.',
  'fonte.lista': 'Um link por linha. Se o programa não conseguir ler título e preço sozinho, escreva na linha: link | título | preço | preço antigo | cupom.',
  'regras.filtros': 'A oferta só sai se passar nos três: preço mínimo, preço máximo e desconto mínimo (em relação ao preço antigo). Vazio = sem filtro.',
  'regras.grupos': 'Grupos do WhatsApp que recebem esta regra. Um grupo pode estar em várias regras; use “Marcar um bloco” para marcar um nicho inteiro.',
  'regras.por_envio': 'Quantas ofertas saem em cada ciclo. Cada oferta vai para todos os grupos marcados, uma atrás da outra.',
  'regras.intervalo': 'Tempo entre um ciclo e o próximo. Intervalos curtos aumentam o risco de o WhatsApp restringir o número; 30 a 60 min é um bom ritmo.',
  'regras.janela': 'Horário em que a regra pode enviar. Pode virar a noite (ex.: das 20:00 até 02:00).',
  'regras.dedupe': 'Por quantos dias a mesma oferta não se repete nesta regra. 0 = pode repetir.',
  'regras.foto': 'Envia a foto do produto com a mensagem como legenda. Se a foto falhar, vai só o texto.',
  // visão geral
  'visao': 'Tudo o que acontece nos seus grupos enquanto o programa está conectado: quem clica, entra, sai e lê. Filtre por período e por bloco.',
  'visao.funil': 'Caminho do tráfego: cliques nos links do rotacionador → quem entrou nos grupos → quem saiu. Compara com o período anterior.',
  'visao.cliques': 'Cliques nos links do Rotacionador. Só conta de verdade quando o programa está publicado na internet.',
  'visao.entradas': '“Pelo link” = a pessoa entrou sozinha pelo convite. “Adicionados” = um admin colocou.',
  'visao.saidas': 'Quem saiu ou foi removido. Saldo = entradas − saídas.',
  'visao.tempo': 'Quanto tempo quem saiu ficou no grupo, em média (só de quem vimos entrar e sair). Abaixo, há quanto tempo estão os que ficaram.',
  'visao.abriram': 'Pessoas diferentes que leram alguma mensagem sua no período (recibos de leitura). Mede alcance real, não só o total de membros.',
  'visao.grafico': 'Entradas e saídas por hora (um dia) ou por dia (períodos maiores). A parte escura da barra de saídas é quem entrou e saiu no mesmo dia.',
  'visao.evasao_dia': 'De quem entrou no período, quantos saíram no mesmo dia. Fica “em andamento” até o dia acabar.',
  'visao.evasao_7d': 'De quem entrou no período, quantos saíram em até 7 dias. Fecha 7 dias depois do fim do período.',
  'visao.evasao_ontem': 'Evasão de ontem, já fechada: quem entrou ontem e saiu no mesmo dia.',
  'visao.evasao_total': 'Saídas do período sobre o total de pessoas (membros atuais + quem saiu).',
  'visao.bloco': 'Filtra todos os números por um bloco de análise (conjunto de grupos de um nicho).',
  'visao.porgrupo': 'Os mesmos números, grupo a grupo. “Abriram” mostra também a porcentagem dos membros.',
  // blocos
  'blocos': 'Agrupe grupos por nicho (Casa, Beleza…). A Visão Geral filtra por bloco e, ao criar uma regra, você marca o bloco inteiro de uma vez.',
  'blocos.etiqueta': 'Etiqueta do Mercado Livre deste nicho. Ao criar uma regra a partir do bloco ela já vem marcada; assim o ganho aparece separado na Central.',
  // rotacionador
  'links': 'Um endereço só (…/g/nome) que leva para o primeiro grupo com vaga. Quando um grupo enche, o link passa a mandar para o próximo. Os cliques entram no funil.',
  'links.endereco': 'A parte final do endereço público. Só letras, números e hífen. Ex.: achadinhos → …/g/achadinhos.',
  'links.modo': 'Encher um por vez: enche o 1º, depois o 2º… Alternar: divide os cliques entre até 3 grupos com vaga. Reabrir: o que lotou só volta quando esvaziar.',
  'links.limite': 'A partir de quantos membros o grupo é considerado cheio (máximo 1.024, limite do WhatsApp).',
  'links.reserva': 'Para onde mandar quando todos os grupos lotarem. Vazio = página “grupos lotados”.',
  'links.proximo': 'Aos 95% do limite, o painel propõe criar um grupo novo igual (nome com o próximo número, foto, descrição, permissões e admins). Só cria quando você confirmar.',
  'links.ordem': 'Só grupos com convite entram na rotação. O primeiro da lista enche primeiro. Pegue o convite em “WhatsApp e grupos”.',
  // grupos / whatsapp
  'whatsapp': 'Seu número entra como “aparelho conectado”, igual ao WhatsApp Web. É uma conexão não oficial: mantenha as pausas e evite volume alto.',
  'grupos.convite': 'Link de convite do grupo. “Buscar convite” funciona quando o seu número é admin; senão, peça a um admin e cole aqui.',
  // ajustes
  'ajustes.pausas': 'Espera entre mensagens. O programa varia o tempo ao acaso para parecer humano. Mais curto = mais risco de bloqueio.',
  'ajustes.titulo': 'Tamanho máximo de {TITULO_PRODUTO}: tira “Compatível com…”, “Premium”, “Alta Qualidade” e corta sem partir palavra. 0 = nome inteiro.',
  'ajustes.modo_link': 'Pela extensão: link meli.la com a sua etiqueta (gera comissão). Link direto: sem etiqueta, só para testar o fluxo.',
  'ajustes.extensao': 'A extensão fica no seu Chrome, logada no Mercado Livre, e é quem gera os links e busca a lista da Central. Cookies nunca saem do navegador.',
  // etiquetas, templates, histórico
  'etiquetas': 'Etiquetas são os nomes criados em “Administrar etiquetas” na Central de Afiliados. Cada regra usa uma; é o que diz de quem é a comissão. Escreva exatamente igual.',
  'templates': 'Modelos de mensagem. Clique nos campos para inserir; a prévia mostra como fica no WhatsApp. {LINK} é obrigatório. *negrito* e ~riscado~ funcionam.',
  'historico': 'Tudo o que foi enviado e o que falhou, com o motivo. “Aviso” é oferta ou fonte pulada; “Erro” é algo que impediu o envio.',
};

/** Ícone "?" com explicação. Uso: ${q('regras.etiqueta')} */
function q(chave) {
  const t = TIPS[chave]; if (!t) return '';
  return `<span class="q" tabindex="0" role="img" aria-label="Ajuda: ${t.replace(/"/g, '&quot;')}" data-tip="${t.replace(/"/g, '&quot;')}">?</span>`;
}

// Tooltip global (um só elemento, #tip), por delegação: hover, foco e toque.
(() => {
  let atual = null;
  const tip = () => document.getElementById('tip');
  function mostrar(el) {
    const t = tip(); if (!t) return;
    t.textContent = el.dataset.tip; t.hidden = false; t.classList.add('tip-ajuda');
    const r = el.getBoundingClientRect(); const w = Math.min(320, innerWidth - 24);
    t.style.maxWidth = w + 'px';
    const left = Math.max(12, Math.min(r.left + r.width / 2 - t.offsetWidth / 2, innerWidth - t.offsetWidth - 12));
    const top = r.bottom + 8 + t.offsetHeight > innerHeight ? r.top - t.offsetHeight - 8 : r.bottom + 8;
    t.style.left = left + 'px'; t.style.top = top + 'px'; atual = el;
  }
  function esconder() { const t = tip(); if (t && atual) { t.hidden = true; t.classList.remove('tip-ajuda'); atual = null; } }
  document.addEventListener('mouseover', (e) => { const el = e.target.closest?.('.q'); if (el) mostrar(el); });
  document.addEventListener('mouseout', (e) => { if (e.target.closest?.('.q') === atual) esconder(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest?.('.q'); if (el) mostrar(el); });
  document.addEventListener('focusout', (e) => { if (e.target.closest?.('.q') === atual) esconder(); });
  document.addEventListener('click', (e) => { const el = e.target.closest?.('.q'); if (el) { e.preventDefault(); atual === el ? esconder() : mostrar(el); } else if (atual) esconder(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') esconder(); });
  addEventListener('scroll', esconder, true);
})();

// ---------- página Ajuda ----------
const AJUDA = [
  { id: 'visao', titulo: 'Visão Geral', rota: '#visao', oque: 'O painel de resultados dos seus grupos: cliques, entradas, saídas, leitura das mensagens e evasão, por período e por bloco.',
    passos: ['Escolha o período (Hoje, 7 dias, Mês…) e, se quiser, um bloco.', 'Leia o funil: cliques → entradas → saídas. “Pelo link” é quem entrou sozinho; “adicionados”, quem um admin colocou.', '“Abriram o grupo” conta pessoas que leram alguma mensagem sua: é o seu alcance real.', 'Nos cartões de evasão, veja quantos saem no mesmo dia e em 7 dias. Alta evasão no mesmo dia = expectativa errada no convite.'],
    dica: 'Os números começam a contar quando o programa está conectado ao WhatsApp. Não há histórico de antes.' },
  { id: 'regras', titulo: 'Regras de envio', rota: '#regras', oque: 'O disparo automático. Cada regra junta etiqueta + template + fontes de ofertas + grupos + ritmo.',
    passos: ['Dê um nome, escolha a etiqueta e o template.', 'Adicione até 5 fontes. A Central de Afiliados é a mais prática: filtre por busca e categorias.', 'Marque os grupos (ou um bloco inteiro) e defina o ritmo: ofertas por envio, intervalo e horário.', 'Clique em “Ver ofertas” para conferir o que sairia, e em “Enviar agora” para testar.'],
    dica: 'Para o mesmo grupo receber de duas etiquetas, crie duas regras apontando para ele.' },
  { id: 'blocos', titulo: 'Blocos de análise', rota: '#blocos', oque: 'Conjuntos de grupos por nicho (Casa, Beleza, Tech…), com etiqueta própria opcional.',
    passos: ['Crie um bloco, dê um nome e marque os grupos daquele nicho.', 'Se quiser separar o ganho na Central, escolha a etiqueta do nicho.', 'Na Visão Geral, clique no bloco para ver só os números dele.', 'Ao criar uma regra, use “Marcar um bloco…” para marcar todos os grupos e a etiqueta de uma vez.'],
    dica: 'Um grupo pode estar em mais de um bloco.' },
  { id: 'links', titulo: 'Rotacionador de Links', rota: '#links', oque: 'Um endereço só para divulgar (…/g/nome). Quem clica cai no primeiro grupo com vaga; quando enche, o link passa ao próximo.',
    passos: ['Em “WhatsApp e grupos”, garanta que cada grupo tem convite (Buscar, se você é admin, ou cole).', 'Crie o link, escolha o endereço, o modo e os grupos na ordem em que devem encher.', 'Ligue “Criar próximo grupo” para o painel propor um grupo novo quando um chegar a 95%.', 'Divulgue o endereço. Os cliques aparecem no funil da Visão Geral.'],
    dica: 'No seu computador o endereço só abre para você. Para o público, o programa precisa estar publicado na internet.' },
  { id: 'etiquetas', titulo: 'Etiquetas', rota: '#etiquetas', oque: 'Os nomes que identificam você no programa de afiliados do Mercado Livre. Vão em todo link meli.la.',
    passos: ['Na Central de Afiliados, abra “Administrar etiquetas” e copie o nome exato.', 'Cadastre aqui com a mesma grafia.', 'Use uma etiqueta por nicho ou por grupo para ver o ganho separado na Central.'],
    dica: 'Nome diferente do cadastrado na Central = comissão não atribuída.' },
  { id: 'templates', titulo: 'Templates', rota: '#templates', oque: 'O texto das mensagens. Campos entre chaves são preenchidos com a oferta.',
    passos: ['Clique nos campos (chips) para inserir: {TITULO_PRODUTO}, {PRECO_PRODUTO}, {DESCONTO_PRODUTO}, {LINK}…', 'Linha com campo vazio some sozinha: pode deixar “Cupom: {CUPOM}” sempre.', '{TITULO_PRODUTO} sai abreviado (ajuste em Ajustes); {TITULO_COMPLETO} é o nome inteiro.', 'Veja a prévia ao lado, como fica no WhatsApp.'],
    dica: '{LINK} é obrigatório; sem ele a mensagem sai sem o link de afiliado.' },
  { id: 'whatsapp', titulo: 'WhatsApp e grupos', rota: '#whatsapp', oque: 'Conecta o número que envia (como “aparelho conectado”) e lista seus grupos com membros e convites.',
    passos: ['Clique em “Conectar WhatsApp” e leia o QR em Aparelhos conectados, no celular.', 'Use “Atualizar lista de grupos” depois de entrar em grupos novos.', 'Pegue o convite dos grupos que vão para o rotacionador.'],
    dica: 'Prefira um número que você não dependa. A conexão é não oficial e pode ser restringida com volume alto.' },
  { id: 'historico', titulo: 'Histórico', rota: '#historico', oque: 'Registro de tudo o que saiu e do que falhou, com o motivo.',
    passos: ['Filtre por “Só erros” quando algo não sair.', 'Erros comuns: extensão desconectada, WhatsApp desconectado, Central sem sessão.'],
    dica: 'Os avisos mostram ofertas e fontes puladas, sem travar o envio.' },
  { id: 'ajustes', titulo: 'Ajustes', rota: '#ajustes', oque: 'Pausas entre mensagens, tamanho do título, modo de link e conexão da extensão do Chrome.',
    passos: ['Pausas: 6 s entre grupos e 30 s entre ofertas é um ponto de partida seguro.', 'Título: 60 caracteres deixa a mensagem limpa; 0 desliga.', 'Extensão: copie endereço e token e cole no ícone dela no Chrome.'],
    dica: 'A extensão precisa do Chrome aberto e logado na Central de Afiliados.' },
];
const GLOSSARIO = [
  ['Etiqueta', 'Identificador do afiliado no Mercado Livre. Vai no link e define de quem é a comissão.'],
  ['meli.la', 'Link curto do Mercado Livre gerado pela Central de Afiliados, já com a sua etiqueta.'],
  ['Central de Afiliados', 'Área do Mercado Livre para afiliados. A lista “Produtos selecionados para você” é a fonte padrão das regras.'],
  ['Fonte', 'De onde uma regra tira ofertas: Central, lista de links ou busca. Até 5 por regra, intercaladas.'],
  ['Bloco', 'Conjunto de grupos de um nicho, para análise e para marcar regras de uma vez.'],
  ['Rotacionador', 'Link único que leva ao primeiro grupo com vaga.'],
  ['Evasão', 'Quem entra e sai logo: no mesmo dia ou em até 7 dias.'],
  ['Extensão', 'Complemento do Chrome que fala com a Central de Afiliados usando a sua sessão. Nada de cookie sai do navegador.'],
];
function paginaAjuda() {
  document.getElementById('pagina').innerHTML = `<div class="topo"><div><h1>Ajuda</h1><p class="sub">Como cada ferramenta funciona, em ordem de uso. Os ícones <span class="q" tabindex="0" data-tip="Isso! Passe o mouse ou toque nos “?” pelo painel para ver explicações curtas.">?</span> pelo painel dão explicações curtas no lugar.</p></div></div>
    <div class="card"><h2>Comece por aqui</h2><ol class="passos passos-ajuda">
      <li><b>Etiquetas</b>: cadastre o nome exato da sua etiqueta da Central de Afiliados.</li>
      <li><b>WhatsApp e grupos</b>: conecte o número pelo QR e atualize a lista de grupos.</li>
      <li><b>Extensão do Chrome</b>: instale pela pasta <code>extension</code>, cole o endereço e o token de Ajustes, e fique logado na Central de Afiliados nesse Chrome.</li>
      <li><b>Templates</b>: ajuste a mensagem e veja a prévia.</li>
      <li><b>Regras</b>: crie a primeira regra, clique em “Ver ofertas” e depois em “Enviar agora”.</li>
      <li>Acompanhe o <b>Histórico</b> e a <b>Visão Geral</b>.</li></ol></div>
    <div class="ajuda-grade">${AJUDA.map((a) => `<article class="card ajuda-card" id="ajuda-${a.id}"><h2>${a.titulo}</h2><p class="sub">${a.oque}</p>
      <p class="rotulo-ajuda">Como usar</p><ol class="passos">${a.passos.map((p) => `<li>${p}</li>`).join('')}</ol>
      <p class="dica-ajuda"><b>Dica:</b> ${a.dica}</p><a class="btn" href="${a.rota}">Abrir ${a.titulo}</a></article>`).join('')}</div>
    <div class="card"><h2>Glossário</h2><dl class="glossario">${GLOSSARIO.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')}</dl></div>`;
}
