// Ajuda: ícones "?" com explicação ao passar o mouse (ou focar com Tab) (a página "Docs" do menu mora em docs.js).
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
  'regras.etiqueta': 'Etiqueta ML padrão: a etiqueta de afiliado do Mercado Livre (ML), da Central de Afiliados, não o app Etiqueta, usada nos links deste disparo quando a fonte não tem uma própria. É o que atribui a comissão a você. Fica opcional quando todas as fontes são do Catálogo e só de Amazon e/ou Shopee.',
  'fonte.etiqueta': 'Etiqueta ML desta fonte: a etiqueta de afiliado do Mercado Livre (ML) usada nos links das ofertas desta fonte (não é o app Etiqueta). Assim um disparo manda ofertas de 2 a 5 etiquetas diferentes, uma por fonte. “A etiqueta ML padrão” usa a do campo de cima.',
  'regras.template': 'Modelo da mensagem. Campos como {PRECO_PRODUTO} são preenchidos com a oferta; linha com campo vazio some sozinha. Para uma parte da linha sumir sozinha, ponha-a entre colchetes: [ … ].',
  'regras.fontes': 'De onde vêm as ofertas: Central de Afiliados, lista de links, busca ou Catálogo (app Etiqueta). Até 5 fontes por disparo, cada uma podendo ter a própria etiqueta; com mais de uma, saem intercaladas (uma de cada fonte por vez). Para todas saírem no mesmo envio, ponha “Ofertas por envio” igual ao número de fontes.',
  'fonte.tipos': 'Central de Afiliados: lista pronta do Mercado Livre, com filtros. Lista de links: você cola os produtos. Busca: experimental, pode ser recusada pelo ML. Catálogo: ofertas do seu app Etiqueta, com filtros de categoria e loja.',
  'fonte.busca': 'Palavras que a Central usa para filtrar a lista (ex.: “organizador”). Vazio = sem filtro de texto.',
  'fonte.paginas': 'Quantas páginas da Central são lidas a cada envio (18 produtos por página). Mais páginas = mais variedade, busca um pouco mais demorada.',
  'fonte.categorias': 'Nenhuma marcada = todas. Com várias, as ofertas saem intercaladas (uma de cada categoria por vez): bom para grupos de achadinhos gerais.',
  'fonte.maisvendidos': 'Só produtos com o selo “Mais vendido” da Central.',
  'fonte.ganhos': 'Só produtos com comissão extra (“Ganhos extras”) neste momento.',
  'fonte.catalogo': 'Ofertas do Etiqueta, que já vêm com link de afiliado da própria loja. Escolha categorias, lojas e filtros. Toda oferta da Shopee, as com 100% de desconto ou preço antigo exagerado e as que falham ao gerar o link esperam a sua revisão (só o Dono revisa).',
  'fonte.catalogo.categoria': 'Abas do Etiqueta (aparecem depois de testar a conexão). Nenhuma marcada = todas. Vale qualquer uma das marcadas.',
  'fonte.catalogo.loja': 'Nenhuma marcada = as três lojas. Só Amazon e/ou Shopee não precisa de etiqueta do Mercado Livre.',
  'fonte.catalogo.ordem': '“Novidades” começa a contar quando você salva: envia o que chegar ou for atualizado no catálogo depois disso (uma nova coleta do Etiqueta conta), e a mesma oferta nunca sai duas vezes neste disparo. Para mandar o que já existe, use “Reler do começo”. As outras ordens pegam as melhores que ainda não foram enviadas dentro do prazo de repetição.',
  'fonte.catalogo.revisao': 'Shopee (o link não prova de quem é a conta) e ofertas com 100% de desconto ou preço antigo exagerado esperam a sua revisão em Histórico > Catálogo; o mesmo vale se o link falhar ao ser gerado. Só o Dono revisa e envia; corrija os preços à mão antes de enviar. Nada disso sai sozinho.',
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
  'manual.link': 'Cole o link do produto. “Identificar” descobre a loja e lê título, preço e foto. Mercado Livre, Amazon e Shopee geram link de afiliado; Magalu e Facebook ainda não.',
  'manual.shopee': 'Cole um link da Shopee (da página do produto ou curto, como s.shopee.com.br ou shp.ee). O painel gera o seu link de afiliado ao disparar (pela extensão do Chrome ou pela API). Com a API, busca também os dados; sem ela, preencha título e preço à mão. A Shopee não informa o preço antigo, só o desconto. Produto fora do programa de afiliados é bloqueado.',
  'manual.amazon': 'Cole um link da Amazon (link.amazon, amzn.to ou da página do produto). O painel busca os dados; você confere, ajusta e envia. Se a busca falhar, preencha à mão.',
  'manual.agendar': 'Desligado, envia na hora. Ligado, envia no horário de hoje que você escolher. Se o programa reiniciar antes, o envio continua agendado.',
  'manual.etiqueta': 'Etiqueta usada no link meli.la desta mensagem. É o que atribui a comissão a você. Na Amazon, vale a tag de associado de Conexões. Na Shopee, vale o ID de afiliado de Conexões.',
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
  'conexoes': 'Onde ficam as lojas e a extensão que geram os seus links de afiliado. Mercado Livre, Amazon e Shopee funcionam hoje; Magalu e Facebook guardam os dados para quando forem implementados. O Catálogo do Etiqueta é uma fonte de ofertas, não uma loja.',
  'conexoes.shopee': 'O link curto de afiliado da Shopee sai pela extensão do Chrome logada no portal de afiliados e, quando houver acesso, pela API. A API (pedida na Shopee, resposta em até 3 dias úteis) busca também título, preço e foto. Sem a API você preenche título e preço à mão. Quando o link sai pela extensão, o painel confere o número da conta que vem no endereço longo e recusa se for outra conta. Espelhamento da Shopee não existe; nas regras automáticas, a Shopee só entra pela fonte Catálogo, sempre com revisão.',
  'conexoes.shopee.id': 'O número da sua conta de afiliado da Shopee (só números). Vai nos seus links e define de quem é a comissão. Não é o AppID nem a tag da Amazon.',
  'conexoes.shopee.appid': 'Número do aplicativo da API, que a Shopee mostra depois de liberar o acesso. Não é segredo, mas é diferente do ID de afiliado: o painel recusa os dois iguais.',
  'conexoes.shopee.senha': 'Senha da API de afiliados da Shopee. Equivale a uma senha: fica guardada no seu computador e não volta para esta tela.',
  'conexoes.shopee.extensao': 'Os links da Shopee saem pela extensão do Chrome. O Chrome precisa estar aberto e logado no portal de afiliados da Shopee (affiliate.shopee.com.br, “Link personalizado”), e a extensão na versão 1.3.0 ou mais nova (recarregue em chrome://extensions depois de atualizar). O mesmo produto reaproveita o link gerado por até 7 dias (enquanto o programa não reiniciar), e há um limite de 60 links por hora pela extensão.',
  'conexoes.amazon': 'A API oficial da Amazon (Creators API) busca título, preço e foto. Exige conta de Associados aprovada e vendas qualificadas recentes. Sem ela, o painel usa o texto escrito na mensagem de origem.',
  'conexoes.catalogo': 'O Etiqueta é o seu outro programa de ofertas, no mesmo computador. Aqui você diz onde ele está e onde fica o arquivo do token; o painel lê as ofertas e as categorias dele. Não é a etiqueta de afiliado do Mercado Livre.',
  'conexoes.catalogo.endereco': 'Endereço do servidor do Etiqueta. O padrão é http://127.0.0.1:8765. Só vale endereço deste computador.',
  'conexoes.catalogo.token': 'Caminho do arquivo api_token.txt do Etiqueta. O painel lê o arquivo; o token nunca aparece aqui. Se trocar o token, reinicie o servidor.py do Etiqueta e teste de novo.',
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
  DESCONTO_PRODUTO: 'Porcentagem de desconto, como 25%. Vazio quando não há preço antigo.',
  NUMERO_VENDAS: 'Quantidade de vendas, como +1 mil vendidos. Vazio quando a loja não informa.',
  FRETE: 'Informação de frete, como “Frete grátis”. Vazio quando não há.',
  CUPOM: 'Cupom da oferta. Vazio quando não há.',
  LINK: 'Link do produto com a sua etiqueta ou tag. Obrigatório.',
};
const DICA_OPCIONAL = 'Para um pedaço da linha sumir sozinho, ponha-o entre colchetes: [🎟️ Cupom: {CUPOM}]. Se algum campo dentro dos colchetes estiver vazio, o pedaço some e o resto da linha fica.';

// "Ler mais" dos ícones "?": chave de TIPS → 'capítulo/seção' dos Docs (public/docs/cap-*.js). Só as chaves daqui ganham
// o link; TIPS não muda. Um teste (test/qa.test.js) confere que toda chave existe em TIPS e todo destino existe nos capítulos.
const LEIA_MAIS = {
  'conexoes.amazon': 'conexoes/amazon',
  'espelhamento.formato': 'espelhamento/formato',
  'espelhamento.fila': 'espelhamento/fila',
  'espelhamento': 'espelhamento/criar',
  'conexoes.shopee': 'conexoes/shopee',
  'conexoes.shopee.id': 'perguntas/id-shopee',
  'conexoes.shopee.appid': 'perguntas/id-shopee',
  'conexoes.shopee.senha': 'perguntas/id-shopee',
  'conexoes.shopee.extensao': 'primeiros-passos/extensao',
  'ajustes.extensao': 'primeiros-passos/extensao',
  'conexoes.catalogo': 'conexoes/catalogo',
  'conexoes.catalogo.endereco': 'conexoes/catalogo',
  'conexoes.catalogo.token': 'conexoes/catalogo',
  'regras.etiqueta': 'perguntas/etiqueta-desta-fonte',
  'fonte.etiqueta': 'perguntas/etiqueta-desta-fonte',
  'fonte.catalogo': 'disparo-automatico/catalogo',
  'fonte.catalogo.ordem': 'disparo-automatico/catalogo',
  'fonte.catalogo.revisao': 'revisao/motivos',
  'regras.fontes': 'disparo-automatico/fontes',
  'fonte.tipos': 'disparo-automatico/fontes',
  'manual.link': 'disparo-manual/mercado-livre',
  'manual.amazon': 'disparo-manual/amazon',
  'manual.shopee': 'disparo-manual/shopee',
  'regras.template': 'templates/linha-some',
  'templates': 'templates/linha-some',
  'whatsapp': 'primeiros-passos/whatsapp',
  'equipe': 'equipe/papeis',
  'equipe.convite': 'equipe/convidar',
  'ajustes.privacidade': 'privacidade/retencao',
  'links': 'grupos/rotacionador',
  'links.modo': 'grupos/rotacionador',
  'links.proximo': 'grupos/proximo-grupo',
  'relatorios': 'resultados/avisos',
  'relatorios.virada': 'resultados/avisos',
};
const LEIA_MAIS_DESTINO = /^[a-z0-9-]+\/[a-z0-9-]+$/; // único formato que vira href do link (sempre interno)
const leiaMaisDe = (chave) => (typeof chave === 'string' && Object.hasOwn(LEIA_MAIS, chave) && LEIA_MAIS_DESTINO.test(LEIA_MAIS[chave]) ? LEIA_MAIS[chave] : '');

/** Ícone "?" com explicação. Uso: ${q('regras.etiqueta')}. Com destino em LEIA_MAIS vira um botão que fixa a dica e mostra o link. */
function q(chave) {
  const t = Object.hasOwn(TIPS, chave) ? TIPS[chave] : ''; if (!t) return '';
  const tx = t.replace(/"/g, '&quot;'); const destino = leiaMaisDe(chave);
  if (destino) return `<span class="q" tabindex="0" role="button" aria-expanded="false" aria-label="Ajuda: ${tx}" data-tip="${tx}" data-docs="${destino}">?</span>`;
  return `<span class="q" tabindex="0" role="img" aria-label="Ajuda: ${tx}" data-tip="${tx}">?</span>`;
}

/** Título da seção de destino ("capítulo/seção"), lido dos capítulos na hora do clique; sem eles, o próprio destino. */
function leiaMaisTitulo(destino) {
  const [capId, secId] = String(destino).split('/');
  try {
    const cap = typeof DOCS_CAPS !== 'undefined' && Object.hasOwn(DOCS_CAPS, capId) ? DOCS_CAPS[capId] : null;
    const sec = (cap?.secoes || []).find((x) => x && x.id === secId);
    if (sec && typeof sec.titulo === 'string') return typeof docsPlano === 'function' ? docsPlano(sec.titulo) : sec.titulo;
  } catch { /* sem capítulos carregados */ }
  return destino;
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
  t.hidden = true; t.classList.remove('tip-ajuda', 'tip-fixo'); t.style.pointerEvents = '';
}

// Ícones "?": por delegação, com hover, foco e toque. Os que têm destino em LEIA_MAIS (data-docs) fixam a dica ao clicar,
// tocar ou apertar Enter/Espaço e mostram o link "Ler mais: <seção> →" (foco nele; Esc ou clique fora fecha e devolve o foco).
(() => {
  let atual = null; let fixo = false; let semPrevia = false; let guardada = null; // guardada = o #tip, mesmo se um diálogo que o continha for refeito
  const dentroDaDica = (alvo) => !!alvo?.closest?.('#tip');
  function posicionar(el, t) {
    const r = el.getBoundingClientRect(); const w = Math.min(320, innerWidth - 24);
    t.style.maxWidth = w + 'px';
    const left = Math.max(12, Math.min(r.left + r.width / 2 - t.offsetWidth / 2, innerWidth - t.offsetWidth - 12));
    let top = r.bottom + 8 + t.offsetHeight > innerHeight ? r.top - t.offsetHeight - 8 : r.bottom + 8;
    if (fixo) top = Math.max(8, Math.min(top, innerHeight - t.offsetHeight - 8)); // fixa, ela acompanha o "?" sem sair da tela
    t.style.left = left + 'px'; t.style.top = top + 'px';
  }
  // Um <dialog> modal deixa tudo fora dele inerte, inclusive o #tip (que mora no fim do <body>): com a dica fixa o link não
  // receberia foco nem clique. Então, enquanto fixa, a dica vai para dentro do diálogo do "?" e volta ao <body> ao fechar.
  function trazerParaCorpo() {
    const t = guardada || document.getElementById('tip'); if (!t) return;
    guardada = t; if (t.parentNode !== document.body && document.body) document.body.appendChild(t);
  }
  function abrigarNoDialogo(el) {
    const t = guardada || document.getElementById('tip'); if (!t) return;
    guardada = t; const dlg = el.closest?.('dialog');
    if (dlg && t.parentNode !== dlg) dlg.appendChild(t); else if (!dlg) trazerParaCorpo();
  }
  function soltar() { if (atual?.dataset?.docs) atual.setAttribute('aria-expanded', 'false'); fixo = false; }
  function mostrar(el) { // prévia (hover e foco): sem link, some ao sair
    trazerParaCorpo(); const t = tipShow(el.dataset.tip); if (!t) return;
    soltar(); t.classList.add('tip-ajuda'); t.classList.remove('tip-fixo');
    atual = el; posicionar(el, t);
  }
  function fixar(el) {
    abrigarNoDialogo(el); const t = tipShow(el.dataset.tip); if (!t) return;
    soltar(); t.classList.add('tip-ajuda', 'tip-fixo'); // .tip-fixo devolve o pointer-events que .tip tira (layout do link: .tip-link)
    const destino = String(el.dataset.docs || ''); let link = null;
    if (LEIA_MAIS_DESTINO.test(destino)) {
      link = document.createElement('a'); link.className = 'tip-link'; link.href = '#docs/' + destino;
      // Dentro de um <dialog> (formulário aberto) navegar na mesma aba fecharia o diálogo e perderia o que foi digitado: abre em outra aba.
      const emDialogo = !!el.closest?.('dialog');
      if (emDialogo) { link.target = '_blank'; link.rel = 'noopener'; }
      link.textContent = `Ler mais${emDialogo ? ' (abre em outra aba)' : ''}: ${leiaMaisTitulo(destino)} →`;
      t.appendChild(link);
    }
    atual = el; fixo = true; el.setAttribute('aria-expanded', 'true'); posicionar(el, t);
    link?.focus?.({ preventScroll: true });
  }
  function esconder(devolverFoco) {
    if (!atual) return;
    const el = atual; const estavaFixo = fixo; soltar(); tipHide(); atual = null; trazerParaCorpo();
    if (devolverFoco && estavaFixo && el.isConnected) { semPrevia = true; try { el.focus({ preventScroll: true }); } finally { semPrevia = false; } }
  }
  const alternar = (el) => { if (fixo && atual === el) esconder(true); else fixar(el); };
  document.addEventListener('mouseover', (e) => { const el = e.target.closest?.('.q'); if (el && !fixo) mostrar(el); });
  document.addEventListener('mouseout', (e) => { if (!fixo && e.target.closest?.('.q') === atual) esconder(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest?.('.q'); if (el && !fixo && !semPrevia) mostrar(el); });
  document.addEventListener('focusout', (e) => {
    if (!fixo) { if (e.target.closest?.('.q') === atual) esconder(); return; }
    const p = e.relatedTarget; // foco foi para outro lugar da página (Tab do link também cai aqui pelo keydown)
    if (p && !dentroDaDica(p) && p !== atual) esconder();
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('.q');
    if (el) { e.preventDefault(); if (el.dataset.docs) alternar(el); else if (atual === el && !fixo) esconder(); else { esconder(); mostrar(el); } return; }
    if (dentroDaDica(e.target) && !e.target.closest?.('a')) return; // clicar no texto da dica fixa não fecha
    if (atual) esconder(); // clicar fora ou no link (que navega) fecha
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (fixo) { e.preventDefault(); e.stopPropagation(); esconder(true); } else esconder(); return; }
    if (e.key === 'Tab' && fixo && dentroDaDica(e.target)) { esconder(true); return; } // o Tab segue a partir do "?"
    if ((e.key === 'Enter' || e.key === ' ') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const el = e.target.closest?.('.q[data-docs]'); if (el) { e.preventDefault(); alternar(el); }
    }
  });
  addEventListener('scroll', () => { if (!atual) return; if (!fixo) { esconder(); return; } const t = document.getElementById('tip'); if (atual.isConnected && t) posicionar(atual, t); else esconder(); }, true);
  addEventListener('hashchange', () => esconder());
  document.addEventListener('close', () => esconder(), true); // diálogo fechado por fora (o evento não borbulha: captura)
})();
