// Ajuda: ícones "?" com explicação ao passar o mouse (ou focar com Tab) e a página "Ajuda" do menu.
// Carrega antes de app.js: só define coisas; não usa nada de lá ao carregar.

const TIPS = {
  // disparo automático (as chaves continuam “regras”: a API e o conceito são os mesmos)
  'regras': 'Um disparo automático escolhe a etiqueta, o template, as fontes de ofertas, os grupos e o ritmo. Pode ter quantos quiser. Também há o tipo Espelhamento, que pega ofertas da Amazon de outros grupos.',
  // espelhamento da Amazon
  'espelhamento': 'Pega ofertas da Amazon postadas em outros grupos, busca título, preço e foto, põe a sua tag e envia ao seu grupo com a mensagem completa.',
  'espelhamento.origem': 'Grupos onde o número conectado está e que você quer vigiar. O painel só lê links da Amazon; o resto da conversa é ignorado.',
  'espelhamento.proprias': 'Ligue se um grupo de origem é seu e você posta ofertas lá. Desligado, as mensagens enviadas pelo seu número não são espelhadas.',
  'espelhamento.bloqueadas': 'Se o título ou o texto da oferta tiver uma destas palavras, ela não é enviada. Não diferencia maiúscula, minúscula nem acento.',
  'espelhamento.repetir': 'Por quantas horas o mesmo produto da Amazon não é reenviado por este espelhamento. Padrão: 168 h (7 dias). 0 = pode repetir. Fora desse prazo, ele sai de novo.',
  'espelhamento.fila': 'Quando falta o título ou o preço, nem a API nem o texto da mensagem de origem trouxeram: “esperar eu completar” deixa a oferta na fila do Histórico até você completar ou descartar; “enviar mesmo assim” manda o formato curto, com o que houver e o link.',
  'espelhamento.formato': 'Sem acesso à API, o painel lê o texto da mensagem de origem. Funciona bem assim: título na 1ª linha, depois “De R$ …”, “Por R$ …”, “NN% OFF”, o frete e “Compre aqui: <link>” com o link completo da Amazon. Sem título ou sem preço no texto, a oferta espera na fila (ou sai no formato curto, conforme a regra).',
  'regras.etiqueta': 'Etiqueta usada nos links deste disparo quando a fonte não tem uma própria. É o que atribui a comissão a você.',
  'fonte.etiqueta': 'Etiqueta usada nos links das ofertas que vierem desta fonte. Assim um disparo manda ofertas de 2 a 5 etiquetas diferentes, uma por fonte. “A mesma da regra” usa a etiqueta padrão.',
  'regras.template': 'Modelo da mensagem. Campos como {PRECO_PRODUTO} são preenchidos com a oferta; linha com campo vazio some sozinha. Para uma parte da linha sumir sozinha, ponha-a entre colchetes: [ … ].',
  'regras.fontes': 'De onde vêm as ofertas. Até 5 fontes por disparo, cada uma podendo ter a própria etiqueta; com mais de uma, saem intercaladas (uma de cada fonte por vez). Para todas saírem no mesmo envio, ponha “Ofertas por envio” igual ao número de fontes.',
  'fonte.tipos': 'Central de Afiliados: lista pronta do Mercado Livre, com filtros. Lista de links: você cola os produtos. Busca: experimental, pode ser recusada pelo ML.',
  'fonte.busca': 'Palavras que a Central usa para filtrar a lista (ex.: “organizador”). Vazio = sem filtro de texto.',
  'fonte.paginas': 'Quantas páginas da Central são lidas a cada envio (18 produtos por página). Mais páginas = mais variedade, busca um pouco mais demorada.',
  'fonte.categorias': 'Nenhuma marcada = todas. Com várias, as ofertas saem intercaladas (uma de cada categoria por vez): bom para grupos de achadinhos gerais.',
  'fonte.maisvendidos': 'Só produtos com o selo “Mais vendido” da Central.',
  'fonte.ganhos': 'Só produtos com comissão extra (“Ganhos extras”) neste momento.',
  'fonte.lista': 'Um link por linha. Se o programa não conseguir ler título e preço sozinho, escreva na linha: link | título | preço | preço antigo | cupom.',
  'regras.filtros': 'A oferta só sai se passar nos três: preço mínimo, preço máximo e desconto mínimo (em relação ao preço antigo). Vazio = sem filtro.',
  'regras.grupos': 'Grupos do WhatsApp que recebem este disparo. Um grupo pode estar em vários disparos; use “Marcar um bloco” para marcar um nicho inteiro.',
  'regras.por_envio': 'Quantas ofertas saem em cada ciclo. Cada oferta vai para todos os grupos marcados, uma atrás da outra.',
  'regras.intervalo': 'Tempo entre um ciclo e o próximo. Intervalos curtos aumentam o risco de o WhatsApp restringir o número; 30 a 60 min é um bom ritmo.',
  'regras.janela': 'Horário em que o disparo pode enviar. Pode virar a noite (ex.: das 20:00 até 02:00).',
  'regras.dedupe': 'Por quantos dias a mesma oferta não se repete neste disparo. 0 = pode repetir.',
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
  'blocos': 'Agrupe grupos por nicho (Casa, Beleza…). A Visão Geral filtra por bloco e, ao criar um disparo automático, você marca o bloco inteiro de uma vez.',
  'blocos.etiqueta': 'Etiqueta do Mercado Livre deste nicho. Ao criar um disparo automático a partir do bloco ela já vem marcada; assim o ganho aparece separado na Central.',
  // rotacionador
  'links': 'Um endereço só (…/g/nome) que leva para o primeiro grupo com vaga. Quando um grupo enche, o link passa a mandar para o próximo. Os cliques entram no funil.',
  'links.endereco': 'A parte final do endereço público. Só letras, números e hífen. Ex.: achadinhos → …/g/achadinhos.',
  'links.modo': 'Encher um por vez: enche o 1º, depois o 2º… Alternar: divide os cliques entre até 3 grupos com vaga. Reabrir: o que lotou só volta quando esvaziar.',
  'links.limite': 'A partir de quantos membros o grupo é considerado cheio (máximo 1.024, limite do WhatsApp).',
  'links.reserva': 'Para onde mandar quando todos os grupos lotarem. Vazio = página “grupos lotados”.',
  'links.proximo': 'Aos 95% do limite, o painel propõe criar um grupo novo igual (nome com o próximo número, foto, descrição, permissões e admins). Só cria quando você confirmar.',
  'links.ordem': 'Só grupos com convite entram na rotação. O primeiro da lista enche primeiro. Pegue o convite em “Grupos”.',
  // grupos / números de whatsapp
  'grupos': 'Os grupos do número conectado, com membros, blocos e o link de convite. Para atualizar a lista, conecte o número em “Números de WhatsApp”.',
  'whatsapp': 'Números de WhatsApp: o seu número entra como “aparelho conectado”, igual ao WhatsApp Web. É uma conexão não oficial: mantenha as pausas e evite volume alto.',
  'grupos.convite': 'Link de convite do grupo. “Buscar convite” funciona quando o seu número é admin; senão, peça a um admin e cole aqui.',
  // ajustes
  'ajustes.pausas': 'Espera entre mensagens. O programa varia o tempo ao acaso para parecer humano. Mais curto = mais risco de bloqueio.',
  'ajustes.titulo': 'Tamanho máximo de {TITULO_PRODUTO}: tira “Compatível com…”, “Premium”, “Alta Qualidade” e corta sem partir palavra. 0 = nome inteiro.',
  'ajustes.modo_link': 'Pela extensão: link meli.la com a sua etiqueta (gera comissão). Link direto: sem etiqueta, só para testar o fluxo.',
  'ajustes.privacidade': 'Quem entra, sai ou lê é guardado com um pseudônimo (código derivado do número com uma chave local), não com o número. Depois do prazo, os registros são apagados de vez. É o que a LGPD chama de minimização e retenção.',
  'ajustes.extensao': 'Fica em Conexões. A extensão fica no seu Chrome, logada no Mercado Livre, e é quem gera os links e busca a lista da Central. Cookies nunca saem do navegador.',
  // disparo manual
  'manual': 'Dispare uma oferta agora ou em um horário de hoje, sem criar disparo automático. Cole o link, escolha grupos e template.',
  'manual.link': 'Cole o link do produto. “Identificar” descobre a loja e lê título, preço e foto. Mercado Livre e Amazon geram link de afiliado; Shopee, Magalu e Facebook ainda não.',
  'manual.amazon': 'Cole um link da Amazon (link.amazon, amzn.to ou da página do produto). O painel busca os dados; você confere, ajusta e envia. Se a busca falhar, preencha à mão.',
  'manual.agendar': 'Desligado, envia na hora. Ligado, envia no horário de hoje que você escolher. Se o programa reiniciar antes, o envio continua agendado.',
  'manual.etiqueta': 'Etiqueta usada no link meli.la desta mensagem. É o que atribui a comissão a você. Na Amazon, vale a tag de associado de Conexões.',
  // disparar mensagem
  'mensagem': 'Texto livre ou enquete para os grupos escolhidos. Serve para avisos, sorteios e chamadas que não são oferta.',
  'mensagem.formato': 'No WhatsApp: *negrito*, _itálico_, ~riscado~.',
  'mensagem.enquete': 'A enquete tem uma pergunta e de 2 a 12 opções. Marque “mais de uma resposta” se a pessoa puder votar em várias.',
  'mensagem.imagem': 'Foto com legenda: a foto vai com o texto embaixo (JPG ou PNG, até 5 MB). Prévia do link: o WhatsApp mostra título e imagem do site do link; só funciona com links do Mercado Livre.',
  'mensagem.quando': 'Agora, em um dia e horário, ou repetido nos dias da semana e em até 6 horários. Na lista ao lado, as repetidas podem ser pausadas; agendadas e repetidas podem ser canceladas.',
  // relatórios e avisos
  'relatorios': 'Números de WhatsApp que recebem avisos e o resumo diário dos blocos escolhidos. É por onde você fica sabendo de um grupo lotando ou de um envio que falhou.',
  'relatorios.virada': 'Hora em que um “dia” termina nos relatórios. Entradas antes dela contam para o dia anterior. Útil se seus picos passam da meia-noite.',
  'relatorios.limite': 'Limite de membros que já vem preenchido ao criar um link no rotacionador. Links que já existem não mudam: o aviso de lotação usa o limite de cada link. O máximo do WhatsApp é 1.024.',
  'relatorios.avisos': '“Grupo lotando”: um grupo chegou perto do limite. “Erro de disparo”: uma mensagem não saiu.',
  // conexões e equipe
  'conexoes': 'Onde ficam as lojas e a extensão que geram os seus links de afiliado. Mercado Livre e Amazon funcionam hoje; Shopee, Magalu e Facebook guardam os dados para quando forem implementados.',
  'conexoes.amazon': 'A API oficial da Amazon (Creators API) busca título, preço e foto. Exige conta de Associados aprovada e vendas qualificadas recentes. Sem ela, o painel usa o texto escrito na mensagem de origem.',
  'conexoes.segredo': 'A chave fica guardada no seu computador e não volta para esta tela. Preencha só se quiser trocar. Só o Dono vê estes campos.',
  'equipe': 'Quem pode entrar no painel, cada pessoa com o próprio e-mail e senha. Operador usa todas as telas, menos Equipe. Só o Dono convida, remove pessoas, muda papéis, desconecta o WhatsApp, gera novo token da extensão, apaga dados antes do prazo e vê as chaves das conexões.',
  'equipe.convite': 'Não enviamos e-mail: copie o link e mande pelo WhatsApp. Vale 7 dias e só pode ser usado uma vez. “Copiar link” na lista gera um link novo e o anterior para de funcionar.',
  'equipe.ativar': 'Enquanto o painel não tem login, qualquer pessoa no seu computador abre tudo. Ative o login para criar a sua conta de Dono e convidar a equipe.',
  // etiquetas, templates, histórico
  'etiquetas': 'Etiquetas são os nomes criados em “Administrar etiquetas” na Central de Afiliados. Cada disparo usa uma; é o que diz de quem é a comissão. Escreva exatamente igual. Fica em Conexões > Mercado Livre.',
  'templates': 'Modelos de mensagem. Clique nos campos para inserir; a prévia mostra como fica no WhatsApp. {LINK} é obrigatório. *negrito* e ~riscado~ funcionam.',
  'historico': 'Tudo o que foi enviado e o que falhou, com o motivo. “Aviso” é oferta ou fonte pulada; “Erro” é algo que impediu o envio.',
};

// Dica de cada campo do template ({CAMPO}). Chaves iguais a PLACEHOLDERS de src/template.js.
const DICAS_PLACEHOLDERS = {
  TITULO_PRODUTO: 'Nome do produto, abreviado conforme o tamanho em Ajustes.',
  TITULO_COMPLETO: 'Nome do produto inteiro, sem abreviar.',
  PRECO_ANTIGO: 'Preço de antes (“De R$”). Vazio quando não há desconto.',
  PRECO_PRODUTO: 'Preço atual (“Por R$”).',
  DESCONTO_PRODUTO: 'Porcentagem de desconto, como 25% OFF. Vazio quando não há preço antigo.',
  NUMERO_VENDAS: 'Quantidade de vendas, como +1 mil vendidos. Vazio quando a loja não informa.',
  FRETE: 'Informação de frete, como “Frete grátis”. Vazio quando não há.',
  CUPOM: 'Cupom da oferta. Vazio quando não há.',
  LINK: 'Link do produto com a sua etiqueta ou tag. Obrigatório.',
};
const DICA_OPCIONAL = 'Para um pedaço da linha sumir sozinho, ponha-o entre colchetes: [🎟️ Cupom: {CUPOM}]. Se algum campo dentro dos colchetes estiver vazio, o pedaço some e o resto da linha fica.';

/** Ícone "?" com explicação. Uso: ${q('regras.etiqueta')} */
function q(chave) {
  const t = TIPS[chave]; if (!t) return '';
  return `<span class="q" tabindex="0" role="img" aria-label="Ajuda: ${t.replace(/"/g, '&quot;')}" data-tip="${t.replace(/"/g, '&quot;')}">?</span>`;
}

// Caixinha de explicação (#tip). Usa a API de popover para ficar acima de qualquer diálogo aberto.
function tipShow(texto) {
  const t = document.getElementById('tip'); if (!t) return null;
  t.textContent = texto; t.hidden = false;
  if (t.showPopover && !t.matches(':popover-open')) t.showPopover();
  return t;
}
function tipHide() {
  const t = document.getElementById('tip'); if (!t) return;
  if (t.hidePopover && t.matches(':popover-open')) t.hidePopover();
  t.hidden = true; t.classList.remove('tip-ajuda');
}

// Ícones "?": por delegação, com hover, foco e toque.
(() => {
  let atual = null;
  function mostrar(el) {
    const t = tipShow(el.dataset.tip); if (!t) return;
    t.classList.add('tip-ajuda');
    const r = el.getBoundingClientRect(); const w = Math.min(320, innerWidth - 24);
    t.style.maxWidth = w + 'px';
    const left = Math.max(12, Math.min(r.left + r.width / 2 - t.offsetWidth / 2, innerWidth - t.offsetWidth - 12));
    const top = r.bottom + 8 + t.offsetHeight > innerHeight ? r.top - t.offsetHeight - 8 : r.bottom + 8;
    t.style.left = left + 'px'; t.style.top = top + 'px'; atual = el;
  }
  function esconder() { if (atual) { tipHide(); atual = null; } }
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
  { id: 'links', titulo: 'Rotacionador de Links', rota: '#links', oque: 'Um endereço só para divulgar (…/g/nome). Quem clica cai no primeiro grupo com vaga; quando enche, o link passa ao próximo.',
    passos: ['Em “Grupos”, garanta que cada grupo tem convite (Buscar, se você é admin, ou cole).', 'Crie o link, escolha o endereço, o modo e os grupos na ordem em que devem encher.', 'Ligue “Criar próximo grupo” para o painel propor um grupo novo quando um chegar a 95%.', 'Divulgue o endereço. Os cliques aparecem no funil da Visão Geral.'],
    dica: 'No seu computador o endereço só abre para você. Para o público, o programa precisa estar publicado na internet.' },
  { id: 'grupos', titulo: 'Grupos', rota: '#grupos', oque: 'A lista dos grupos do número conectado, com membros, blocos e o link de convite.',
    passos: ['Use “Atualizar lista de grupos” depois de entrar em grupos novos.', 'Pegue o convite dos grupos que vão para o rotacionador: “Buscar convite” se você é admin, ou cole o link.', 'Para agrupar por nicho, use “Blocos de análise”.'],
    dica: 'Sem número conectado, a lista fica vazia. Conecte em “Números de WhatsApp”.' },
  { id: 'blocos', titulo: 'Blocos de análise', rota: '#blocos', oque: 'Conjuntos de grupos por nicho (Casa, Beleza, Tech…), com etiqueta própria opcional.',
    passos: ['Crie um bloco, dê um nome e marque os grupos daquele nicho.', 'Se quiser separar o ganho na Central, escolha a etiqueta do nicho.', 'Na Visão Geral, clique no bloco para ver só os números dele.', 'Ao criar um disparo automático, use “Marcar um bloco…” para marcar todos os grupos e a etiqueta de uma vez.'],
    dica: 'Um grupo pode estar em mais de um bloco.' },
  { id: 'disparo-manual', titulo: 'Disparo manual', rota: '#disparo-manual', oque: 'Manda uma oferta agora, ou em um horário de hoje, sem criar disparo automático.',
    passos: ['Cole o link do produto e clique em “Identificar”: o programa descobre a loja e lê título, preço e foto.', 'Para a Amazon, cole o link (link.amazon, amzn.to ou da página do produto): o painel busca os dados, você confere e ajusta. Se a busca falhar, preencha à mão.', 'Escolha a etiqueta, o template e os grupos.', 'Clique em “Disparar”. Para mandar mais tarde, ligue “Agendar” e escolha um horário de hoje.', 'Confira o resultado no Histórico.'],
    dica: 'Se a loja não estiver conectada, o aviso aparece na hora. Mercado Livre e Amazon geram link de afiliado; Shopee, Magalu e Facebook ainda não.' },
  { id: 'disparo-automatico', titulo: 'Disparo automático', rota: '#disparo-automatico', oque: 'Envia ofertas sozinho, no ritmo que você definir. Cada disparo junta etiqueta + template + fontes de ofertas + grupos + ritmo. É o que antes se chamava “Regras”.',
    passos: ['Dê um nome, escolha a etiqueta e o template.', 'Adicione até 5 fontes. A Central de Afiliados é a mais prática: filtre por busca e categorias.', 'Marque os grupos (ou um bloco inteiro) e defina o ritmo: ofertas por envio, intervalo e horário.', 'Clique em “Ver ofertas” para conferir o que sairia, e em “Enviar agora” para testar.'],
    dica: 'Para o mesmo grupo receber de duas etiquetas, crie dois disparos apontando para ele.' },
  { id: 'espelhamento', titulo: 'Espelhar ofertas da Amazon', rota: '#disparo-automatico', oque: 'Pega ofertas da Amazon postadas em outros grupos, põe a sua tag e envia ao seu grupo com a mensagem completa, foto incluída. Fica em Disparo automático (botão “Novo espelhamento”).',
    passos: ['Em Conexões, cadastre a tag de associado da Amazon (e, se tiver, as credenciais da API). Sem a tag o espelhamento pode ser salvo desligado, mas só liga depois de você cadastrá-la.', 'Crie o espelhamento em Disparo automático: escolha os grupos de origem, os grupos de destino e o template. Se quiser, bloqueie palavras e defina por quantas horas (padrão 168) o mesmo produto não se repete e o máximo por hora.', 'Escolha o que fazer quando faltar o preço: esperar você completar (fila) ou enviar mesmo assim, no formato curto.', 'Acompanhe no Histórico, no tipo Espelhamento, e use “Completar” ou “Descartar” no que ficar na fila.'],
    dica: 'Todo link sai como amazon.com.br/dp/… com a sua tag, nunca a de quem postou. Sem acesso à API, a mensagem sai com o texto da origem: funciona melhor com título na 1ª linha, “De R$”, “Por R$”, “NN% OFF”, frete e “Compre aqui:” com o link completo.' },
  { id: 'disparar-mensagem', titulo: 'Disparar mensagem', rota: '#disparar-mensagem', oque: 'Manda um texto livre ou uma enquete para os grupos. Serve para avisos, sorteios e chamadas que não são oferta.',
    passos: ['Escolha Mensagem ou Enquete. Na mensagem, use *negrito*, _itálico_ e ~riscado~. Na enquete, uma pergunta e de 2 a 12 opções.', 'Se quiser, anexe uma foto (JPG ou PNG, até 5 MB). Ela vai com o texto como legenda. A prévia do link só funciona com links do Mercado Livre.', 'Escolha os grupos e quando enviar: agora, em um dia e horário, ou repetido nos dias da semana (até 6 horários).', 'Na lista ao lado, as repetidas podem ser pausadas (e retomadas); agendadas e repetidas podem ser canceladas. O que já saiu fica no Histórico.'],
    dica: 'Cancelar uma mensagem agendada evita o envio; o que já foi enviado não volta.' },
  { id: 'templates', titulo: 'Templates', rota: '#templates', oque: 'O texto das mensagens. Campos entre chaves são preenchidos com a oferta.',
    passos: ['Clique nos campos (chips) para inserir: {TITULO_PRODUTO}, {PRECO_PRODUTO}, {DESCONTO_PRODUTO}, {LINK}…', 'Linha com campo vazio some sozinha: pode deixar “Cupom: {CUPOM}” sempre.', 'Para sumir só um pedaço da linha, ponha-o entre colchetes: “[🎟️ Cupom: {CUPOM}]”. Se algum campo dentro dos colchetes estiver vazio, o pedaço todo some e o resto da linha fica. Colchete sem campo dentro é texto normal.', '{TITULO_PRODUTO} sai abreviado (ajuste em Ajustes); {TITULO_COMPLETO} é o nome inteiro.', 'Veja a prévia ao lado, como fica no WhatsApp.'],
    dica: '{LINK} é obrigatório; sem ele a mensagem sai sem o link de afiliado.' },
  { id: 'relatorios', titulo: 'Relatórios e avisos', rota: '#relatorios', oque: 'Define quem recebe, pelo WhatsApp, o resumo diário e os avisos do programa.',
    passos: ['Cadastre os números que recebem e escolha os blocos de cada um.', 'Ligue o resumo diário e defina o horário de envio. A “virada do dia” diz a que horas um dia termina nos relatórios; o resumo conta da virada até o horário dele, então não use o mesmo horário nos dois (ele sairia quase vazio).', 'Defina o limite padrão de membros: ele só preenche o limite de cada link novo do rotacionador. O aviso de lotação sai quando um grupo chega perto do limite do link dele.', 'Ligue o aviso de erro para saber quando uma mensagem não saiu.'],
    dica: 'Os números aparecem mascarados na tela e os dados ficam só no seu computador.' },
  { id: 'conexoes', titulo: 'Conexões', rota: '#conexoes', oque: 'Onde ficam as lojas e a extensão do Chrome que geram os seus links de afiliado.',
    passos: ['Mercado Livre: cadastre aqui as etiquetas, com o nome exato da Central de Afiliados.', 'Extensão do Chrome: copie o endereço e o token e cole no ícone dela.', 'Amazon: cadastre a tag de associado (ex.: seunome-20). Para a API buscar título, preço e foto, cadastre também o Credential ID, o Secret e a versão da Creators API (Central de Associados > Ferramentas > Creators API > Create Application > Add New Credential) e clique em “Testar”. Sem a API, o espelhamento usa o texto da mensagem de origem.', 'Shopee, Magalu e Facebook estão como “ainda não implementado”: você já pode guardar os dados, mas o painel só vai usá-los quando a integração existir.'],
    dica: 'A API da Amazon exige conta de Associados aprovada em definitivo, com pelo menos 10 vendas qualificadas nos últimos 30 dias, na Amazon.com.br. Chaves e senhas ficam no seu computador e não voltam para a tela. Só o Dono vê esses campos.' },
  { id: 'numeros', titulo: 'Números de WhatsApp', rota: '#numeros', oque: 'Conecta o número que envia (como “aparelho conectado”).',
    passos: ['Clique em “Conectar WhatsApp” e leia o QR em Aparelhos conectados, no celular.', 'Depois de conectar, a lista de grupos aparece em “Grupos”.', 'Se o número cair, conecte de novo por aqui.'],
    dica: 'Prefira um número que você não dependa. A conexão é não oficial e pode ser restringida com volume alto.' },
  { id: 'equipe', titulo: 'Equipe', rota: '#equipe', oque: 'Convida pessoas para usar o painel, cada uma com o próprio e-mail e senha, sem passar a sua. Só o Dono vê esta tela.',
    passos: ['Se o painel ainda não pede login, preencha “Proteja o painel” para criar a sua conta de Dono.', 'Em “Convidar pessoa”, digite o e-mail, escolha o papel (Operador ou Dono) e clique em “Criar convite”.', 'Copie o link e mande pelo WhatsApp. Não enviamos e-mail.', 'A pessoa abre o link, escreve o nome e cria a senha. Depois disso, ela entra com o e-mail e essa senha.', 'Para mudar o papel ou tirar o acesso, use a lista “Pessoas”. Convite que não vai ser usado: “Cancelar convite”.'],
    dica: 'O convite vale 7 dias e só pode ser usado uma vez. “Copiar link” na lista gera um link novo e o anterior para de funcionar.' },
  { id: 'historico', titulo: 'Histórico', rota: '#historico', oque: 'Registro de tudo o que saiu e do que falhou, com o motivo.',
    passos: ['Filtre por “Só erros” quando algo não sair.', 'Em Tipo > Espelhamento, veja cada oferta espelhada, o motivo de ter sido descartada (palavra bloqueada, repetida, sem dados) e as que esperam na fila.', 'Erros comuns: extensão desconectada, WhatsApp desconectado, Central sem sessão.'],
    dica: 'Os avisos mostram ofertas e fontes puladas, sem travar o envio.' },
  { id: 'ajustes', titulo: 'Ajustes', rota: '#ajustes', oque: 'Pausas entre mensagens, tamanho do título, modo de link e privacidade. A extensão do Chrome agora fica em Conexões.',
    passos: ['Pausas: 6 s entre grupos e 30 s entre ofertas é um ponto de partida seguro.', 'Título: 60 caracteres deixa a mensagem limpa; 0 desliga.', 'Modo de link: “Pela extensão” gera comissão; “Link direto” é só para testar.'],
    dica: 'A extensão precisa do Chrome aberto e logado na Central de Afiliados.' },
];
const GLOSSARIO = [
  ['Etiqueta', 'Identificador do afiliado no Mercado Livre. Vai no link e define de quem é a comissão. Fica em Conexões > Mercado Livre.'],
  ['meli.la', 'Link curto do Mercado Livre gerado pela Central de Afiliados, já com a sua etiqueta.'],
  ['Central de Afiliados', 'Área do Mercado Livre para afiliados. A lista “Produtos selecionados para você” é a fonte padrão do disparo automático.'],
  ['Loja conectada', 'Loja cujos dados você já cadastrou em Conexões. Hoje Mercado Livre e Amazon funcionam de fato.'],
  ['Tag de associado', 'Identificador do afiliado na Amazon (ex.: seunome-20). Vai no link e define de quem é a comissão. Fica em Conexões > Amazon.'],
  ['Pedaço opcional', 'Trecho do template entre colchetes, como [🎟️ Cupom: {CUPOM}]. Some sozinho quando algum campo dentro dele está vazio.'],
  ['Espelhamento', 'Disparo que copia ofertas da Amazon de grupos de origem para os seus grupos, com a sua tag e a mensagem completa.'],
  ['Grupo de origem', 'Grupo que o espelhamento vigia em busca de links da Amazon. O resto da conversa é ignorado.'],
  ['Grupo de destino', 'Grupo seu que recebe as ofertas espelhadas.'],
  ['Na fila', 'Oferta espelhada à qual falta o título ou o preço. Espera no Histórico até você completar ou descartar (se a regra for “esperar eu completar”).'],
  ['Palavra bloqueada', 'Palavra que, se aparecer no título ou no texto da oferta, impede o envio. Não diferencia maiúscula, minúscula nem acento.'],
  ['Repetida', 'Mesmo produto da Amazon já enviado pelo mesmo espelhamento nas últimas horas definidas (padrão 168). Não é reenviado.'],
  ['Fonte', 'De onde um disparo automático tira ofertas: Central, lista de links ou busca. Até 5 por disparo, intercaladas.'],
  ['Envio', 'Uma mensagem que o programa mandou (ou tentou mandar) para os grupos. Todo envio aparece no Histórico.'],
  ['Ocorrência', 'Cada vez que algo acontece em um disparo agendado ou repetido: um horário que chegou e foi enviado, pulado ou falhou.'],
  ['Repetição', 'Mensagem que sai sozinha nos dias da semana e horários escolhidos (até 6 horários).'],
  ['Bloco', 'Conjunto de grupos de um nicho, para análise, para relatórios e para marcar disparos de uma vez.'],
  ['Rotacionador', 'Link único que leva ao primeiro grupo com vaga.'],
  ['Destino de aviso', 'Número de WhatsApp que recebe o resumo diário e os avisos, em Relatórios e avisos.'],
  ['Virada do dia', 'Hora em que um dia termina nos relatórios. Entradas antes dela contam para o dia anterior.'],
  ['Evasão', 'Quem entra e sai logo: no mesmo dia ou em até 7 dias.'],
  ['Enquete', 'Pergunta com 2 a 12 opções para o grupo votar, enviada em Disparar mensagem.'],
  ['Dono', 'Quem administra a conta: convida, remove pessoas, muda papéis e vê as chaves das conexões.'],
  ['Operador', 'Quem usa o painel no dia a dia. Acessa todas as telas, menos Equipe. Não desconecta o WhatsApp, não gera novo token da extensão nem apaga dados antes do prazo.'],
  ['Convite', 'Link que o Dono cria em Equipe para alguém criar a própria senha e entrar no painel. Vale 7 dias e só pode ser usado uma vez.'],
  ['Extensão', 'Complemento do Chrome que fala com a Central de Afiliados usando a sua sessão. Nada de cookie sai do navegador.'],
];
function paginaAjuda() {
  // Para o Operador o cartão da Equipe some, como o item do menu (podeEquipe é de app.js, que carrega depois).
  document.getElementById('pagina').innerHTML = `<div class="topo"><div><h1>Ajuda</h1><p class="sub">Como cada ferramenta funciona, em ordem de uso. Os ícones <span class="q" tabindex="0" data-tip="Isso! Passe o mouse ou toque nos “?” pelo painel para ver explicações curtas.">?</span> pelo painel dão explicações curtas no lugar.</p></div></div>
    <div class="card"><h2>Comece por aqui</h2><ol class="passos passos-ajuda">
      <li><b>Números de WhatsApp</b>: conecte o número pelo QR. A lista aparece em <b>Grupos</b>.</li>
      <li><b>Conexões</b>: no Mercado Livre, cadastre o nome exato da sua etiqueta da Central de Afiliados. Na extensão do Chrome (pasta <code>extension</code>), cole o endereço e o token, e fique logado na Central nesse Chrome.</li>
      <li><b>Templates</b>: ajuste a mensagem e veja a prévia.</li>
      <li><b>Disparo manual</b>: cole um link, clique em “Identificar” e dispare para testar.</li>
      <li><b>Disparo automático</b>: crie o primeiro, clique em “Ver ofertas” e depois em “Enviar agora”.</li>
      <li><b>Disparar mensagem</b>: avisos e enquetes, agora ou agendados.</li>
      <li><b>Relatórios e avisos</b>: escolha quem recebe o resumo diário e os avisos.</li>
      <li>Acompanhe o <b>Histórico</b> e a <b>Visão Geral</b>.</li></ol></div>
    <div class="ajuda-grade">${AJUDA.filter((a) => a.id !== 'equipe' || typeof podeEquipe !== 'function' || podeEquipe()).map((a) => `<article class="card ajuda-card" id="ajuda-${a.id}"><h2>${a.titulo}</h2><p class="sub">${a.oque}</p>
      <p class="rotulo-ajuda">Como usar</p><ol class="passos">${a.passos.map((p) => `<li>${p}</li>`).join('')}</ol>
      <p class="dica-ajuda"><b>Dica:</b> ${a.dica}</p><a class="btn" href="${a.rota}">Abrir ${a.titulo}</a></article>`).join('')}</div>
    <div class="card"><h2>Glossário</h2><dl class="glossario">${GLOSSARIO.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')}</dl></div>`;
}

