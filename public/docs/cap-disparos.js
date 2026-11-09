// Docs do sistema: capítulos 3 (Templates), 4 (Disparo manual), 5 (Disparo automático) e 8 (Disparar mensagem).
// Só chama docsCapitulo (public/docs.js): nenhuma declaração no topo, porque o escopo global é o mesmo dos outros
// scripts do painel. Formato dos blocos e mini-marcação: comentário de docsInline e plano docs-do-sistema.
// Slugs da spec (docs/produto/specs/docs-do-sistema.md, seção 1): pode acrescentar seção, nunca renomear nem tirar.
// Fontes do texto: README ("Disparo manual" e as de Amazon e Shopee, "Primeiros passos" item 5, "Disparar mensagem",
// "Template com trecho opcional", "Catálogo → Como a regra usa a fonte"), src/template.js, src/envios.js e os
// rótulos de public/app.js (paginaRegras, formRegra, fonteHtml, paginaTemplates, paginaAjustes) e public/disparos.js.

docsCapitulo({
  id: 'templates',
  titulo: 'Templates: o texto da mensagem',
  aprenda: [
    'Inserir os campos da oferta e conferir a prévia.',
    'Deixar uma linha ou um trecho sumir quando falta o dado.',
    'Escolher entre o título curto e o completo.',
  ],
  abrir: [{ rota: '#templates', tela: 'Templates' }],
  secoes: [
    {
      id: 'campos', titulo: 'Campos e prévia',
      onde: '[[Templates]]',
      leia: 'templates/linha-some',
      blocos: [
        { p: 'Template é o texto da mensagem. Os campos entre chaves são trocados pelos dados da oferta na hora do envio.' },
        { tabela: { colunas: ['Campo', 'O que vira na mensagem'], linhas: [
          ['`{TITULO_PRODUTO}`', 'O nome abreviado do produto (veja “Título curto ou completo”).'],
          ['`{TITULO_COMPLETO}`', 'O nome inteiro do produto.'],
          ['`{PRECO_PRODUTO}`', 'O preço atual, como R$ 89,90.'],
          ['`{PRECO_ANTIGO}`', 'O preço antigo. Fica vazio se não for maior que o atual.'],
          ['`{DESCONTO_PRODUTO}`', 'O desconto, como 40%. Fica vazio sem desconto.'],
          ['`{NUMERO_VENDAS}`', 'O número de vendas, como +2 mil vendidos. Fica vazio se a loja não informa.'],
          ['`{FRETE}`', '“Frete grátis”, ou vazio.'],
          ['`{CUPOM}`', 'O cupom da oferta, ou vazio.'],
          ['`{LINK}`', 'O seu link de afiliado.'],
        ] } },
        { passos: [
          'Abra [[Templates]] e escolha um template nos botões acima do editor. Ou clique em “Novo template”.',
          'Escreva o texto em “Mensagem”. Para inserir um campo, clique no chip dele embaixo do editor.',
          'Veja em “Como vai aparecer” a prévia, como fica no WhatsApp.',
          'Clique em “Salvar template”.',
        ] },
        { nota: 'aviso', texto: '`{LINK}` é obrigatório. O painel recusa salvar sem ele, porque a mensagem sairia sem o link de afiliado.' },
        { nota: 'dica', texto: 'Use a formatação do WhatsApp: `*negrito*`, `_itálico_` e `~riscado~`.' },
      ],
    },
    {
      id: 'linha-some', titulo: 'Linha que some sozinha',
      onde: '[[Templates]]',
      blocos: [
        { p: 'Quando um campo fica vazio, a linha inteira some da mensagem. Por isso você pode deixar “Cupom” no template sempre: a linha só aparece quando a oferta tem cupom.' },
        { exemplo: '🔥 Por *{PRECO_PRODUTO}*\n🎟️ Cupom: *{CUPOM}*\n🛒 Compre aqui: {LINK}' },
        { p: 'Sem cupom, a linha “Cupom” desaparece e o resto fica. O mesmo vale para qualquer campo. Sem preço antigo, o painel não inventa uma linha “De”.' },
      ],
    },
    {
      id: 'opcional', titulo: 'Trecho opcional entre colchetes',
      onde: '[[Templates]]',
      blocos: [
        { p: 'Para sumir só um pedaço da linha, ponha o pedaço entre colchetes. Exemplo: o desconto na linha do preço.' },
        { exemplo: '🔥 Por *{PRECO_PRODUTO}*[ ({DESCONTO_PRODUTO} OFF)]' },
        { p: 'Com desconto, sai “🔥 Por *R$ 89,90* (40% OFF)”. Sem desconto, sai “🔥 Por *R$ 89,90*”. As regras:' },
        { passos: [
          'Se algum campo dentro dos colchetes estiver vazio, o pedaço todo some e o resto da linha fica.',
          'Se todos os campos têm valor, os colchetes saem e o conteúdo fica.',
          'Colchetes sem campo dentro são texto normal, e `[` ou `]` soltos também.',
          'Não existe colchete dentro de colchete.',
        ] },
        { nota: 'dica', texto: 'Os templates novos já nascem assim. O template “Padrão” que já existe no seu banco não muda sozinho: troque o trecho do desconto por `[ ({DESCONTO_PRODUTO} OFF)]` na tela Templates.' },
      ],
    },
    {
      id: 'titulo', titulo: 'Título curto ou completo',
      onde: '[[Ajustes → Título do produto na mensagem]]',
      leia: 'manutencao/ajustes',
      blocos: [
        { p: 'Os títulos do Mercado Livre vêm cheios de palavras-chave. `{TITULO_PRODUTO}` sai abreviado: tira “Compatível com…”, “Premium” e “Alta Qualidade” e corta sem partir palavra. `{TITULO_COMPLETO}` é o nome inteiro.' },
        { passos: [
          'Abra [[Ajustes → Título do produto na mensagem]].',
          'Em “Tamanho máximo (caracteres)”, escreva o limite. O padrão é 60. Para não abreviar, use 0.',
          'Clique em “Salvar”. A tela mostra um exemplo de título abreviado.',
        ] },
        { nota: 'dica', texto: 'Entre 50 e 70 caracteres deixa a mensagem limpa. O limite vai de 0 a 200.' },
      ],
    },
  ],
});

docsCapitulo({
  id: 'disparo-manual',
  titulo: 'Disparo manual',
  aprenda: [
    'Identificar um link e disparar uma oferta na hora.',
    'O que muda para Amazon, Shopee e Magalu.',
    'Agendar o envio para um horário de hoje.',
  ],
  antes: ['[Conexões](#docs/conexoes): a loja do link precisa estar conectada, e o WhatsApp também.'],
  abrir: [{ rota: '#disparo-manual', tela: 'Disparo manual' }],
  secoes: [
    {
      id: 'mercado-livre', titulo: 'Mercado Livre e links meli.la',
      onde: '[[Disparo manual]]',
      leia: 'perguntas/meli-la',
      blocos: [
        { p: 'O Disparo manual manda uma oferta específica, agora ou em um horário de hoje, sem criar disparo automático.' },
        { passos: [
          'Abra [[Disparo manual]].',
          'Cole o link do produto e clique em “Identificar”. O painel reconhece a loja, lê título, preço e foto e mostra “pronto para disparar”.',
          'Marque os grupos em “Grupos que vão receber”.',
          'Escolha o template e a “Etiqueta”. A etiqueta só existe no Mercado Livre. Se o grupo tem código de rastreio, a etiqueta dele vence a que você escolheu (veja [Rastreio por grupo](#docs/grupos/rastreio)).',
          'Confira a prévia e clique em “Disparar”.',
          'Veja o resultado no cartão “Histórico”, ao lado.',
        ] },
        { p: 'O link `meli.la` da Central de Afiliados também vale. Ele leva a uma página de afiliado, e o painel lê essa página e gera o seu link a partir do produto. Se não conseguir ler, cole o link da página do produto.' },
        { nota: 'aviso', texto: 'Para disparar na hora, o WhatsApp precisa estar conectado e a extensão do Chrome on-line. Sem a extensão, o botão “Disparar” fica apagado e a frase ao lado diz o motivo. Dá para agendar.' },
        { nota: 'dica', texto: 'Link do Facebook é reconhecido, mas o painel avisa que a loja ainda não está conectada e não envia nada. Mercado Livre, Amazon, Shopee e Magalu geram link de afiliado.' },
        { nota: 'dica', texto: 'Na Magalu o painel não lê o produto: preencha título e preço (a foto é opcional, por upload) e envie. O link sai com o nome da sua loja de parceiro, salvo em [[Conexões → Magalu]]; sem ele o botão “Disparar” fica apagado.' },
      ],
    },
    {
      id: 'amazon', titulo: 'Amazon',
      onde: '[[Disparo manual]]',
      leia: 'conexoes/amazon',
      blocos: [
        { p: 'A Amazon pede a **tag de associado** salva em [[Conexões → Amazon]]. Sem ela o botão “Disparar” fica apagado: todo link da Amazon sai com a sua tag. A extensão do Chrome não é usada.' },
        { passos: [
          'Cole o link e clique em “Identificar”. Vale `amazon.com.br/dp/…`, `link.amazon`, `amzn.to`, `amzn.com` e `a.co`.',
          'Em “Dados da oferta”, confira e ajuste o que precisar: título, “Preço atual”, “Preço antigo”, “Cupom (opcional)”, “Frete” e “Foto”.',
          'Marque os grupos e escolha o template.',
          'Veja a prévia: a tag aparece escondida (`tag=•••`).',
          'Clique em “Disparar”.',
        ] },
        { p: 'O link que vai ao grupo é sempre `https://www.amazon.com.br/dp/<ASIN>?tag=<sua tag>`, montado na hora do envio. O ASIN é o código do produto na Amazon.' },
        { nota: 'dica', texto: 'O preço antigo só vale se for maior que o atual. Senão a linha “De” some. O desconto é calculado dos dois preços. A foto é JPG ou PNG de até 5 MB; sem foto, a mensagem sai só com texto.' },
        { nota: 'erro', texto: '“Não consegui buscar os dados na Amazon agora.” Sem a API configurada, “Dados da oferta” vem em branco, sem aviso, e você preenche à mão (o título é obrigatório). Com a API fora do ar ou sem acesso, aparece essa mensagem e vale o mesmo. Link de busca, lista ou loja é recusado: cole o link da página do produto.' },
      ],
    },
    {
      id: 'shopee', titulo: 'Shopee',
      onde: '[[Disparo manual]]',
      leia: 'conexoes/shopee',
      blocos: [
        { p: 'A Shopee pede o **ID de afiliado** salvo em [[Conexões → Shopee]]. Sem ele o botão “Disparar” fica apagado. A Shopee não tem etiqueta.' },
        { passos: [
          'Deixe o Chrome logado em `affiliate.shopee.com.br`, com a extensão conectada.',
          'Cole o link do produto e clique em “Identificar”. Vale `shopee.com.br/…`, `s.shopee.com.br`, `shp.ee` e `shope.ee`.',
          'Com a API ligada, “Dados da oferta” já vem preenchido. Sem a API, preencha o título (obrigatório) e o preço.',
          'Marque os grupos e escolha o template.',
          'Clique em “Disparar”.',
        ] },
        { p: 'O link de afiliado é gerado na hora de disparar ou de agendar, pela API ou, de reserva, pela extensão do Chrome. A prévia mostra `https://s.shopee.com.br/(gerado ao disparar)`. Como o link já fica guardado no envio, um envio agendado não precisa do Chrome aberto na hora de sair.' },
        { nota: 'aviso', texto: 'Se a API responde mas não reconhece o produto, ele provavelmente não participa do programa de afiliados e pode não gerar comissão. O painel não avisa nem bloqueia: preencha os dados da oferta (o título é obrigatório) e dispare se quiser.' },
        { nota: 'erro', texto: '“O Chrome está logado em outra conta de afiliado da Shopee.” A comissão iria para outra conta, então o disparo é recusado. Entre na conta certa no portal e tente de novo.' },
        { nota: 'dica', texto: 'O painel reaproveita por até 7 dias o link já gerado do mesmo produto e pede no máximo 60 links por hora pela extensão. Passou disso, o disparo é recusado e volta a funcionar na hora seguinte.' },
      ],
    },
    {
      id: 'agendar', titulo: 'Agendar para hoje',
      onde: '[[Disparo manual]]',
      blocos: [
        { passos: [
          'Ligue “Agendar horário”.',
          'Escolha o “Horário de hoje”. Ele precisa ser depois de agora.',
          'Clique em “Agendar envio”.',
        ] },
        { p: 'O agendamento vale só para o mesmo dia. Para repetir ofertas, use o [Disparo automático](#docs/disparo-automatico). Para texto e enquete em outro dia, use [Disparar mensagem](#docs/mensagens/quando).' },
        { p: 'Os envios agendados aparecem em “Agendados”, no cartão “Histórico”, com o botão “Cancelar envio”. Eles sobrevivem a um reinício do programa.' },
        { nota: 'aviso', texto: 'Um agendado que perde o horário por mais de 2 horas (programa desligado, por exemplo) não sai mais e vira erro no Histórico. Com menos atraso que isso, ele sai assim que o programa voltar.' },
        { nota: 'dica', texto: 'No Mercado Livre, o link é gerado na hora de sair: a extensão precisa estar conectada nesse horário. Na Amazon, os dados e o link também são buscados na hora. Na Shopee, o link já foi gerado ao agendar. Na Magalu, o link é montado na hora de sair, com o nome da loja salvo nesse momento: se você apagar o nome antes, o envio falha e o Histórico mostra o erro.' },
      ],
    },
  ],
});

docsCapitulo({
  id: 'disparo-automatico',
  titulo: 'Disparo automático',
  aprenda: [
    'As cinco partes de um disparo: etiqueta, template, fontes, grupos e ritmo.',
    'Escolher as fontes de ofertas, inclusive o Catálogo.',
    'Definir o ritmo: a cada X minutos ou em horários marcados.',
    'Testar antes de ligar.',
  ],
  antes: [
    '[Conexões](#docs/conexoes) e [Templates](#docs/templates): etiqueta do Mercado Livre cadastrada e um template pronto.',
    '[Primeiros passos](#docs/primeiros-passos/whatsapp): WhatsApp e extensão conectados.',
  ],
  abrir: [{ rota: '#disparo-automatico', tela: 'Disparo automático' }],
  secoes: [
    {
      id: 'anatomia', titulo: 'Anatomia de um disparo',
      onde: '[[Disparo automático]]',
      blocos: [
        { p: 'O Disparo automático envia ofertas sozinho, no ritmo que você definir. Antes se chamava “Regras”. Cada disparo junta cinco partes:' },
        { tabela: { colunas: ['Parte', 'O que define', 'Onde fica no formulário'], linhas: [
          ['Etiqueta', 'De quem é a comissão dos links do Mercado Livre.', '“Etiqueta ML padrão”'],
          ['Template', 'O texto da mensagem.', '“Template”'],
          ['Fontes', 'De onde vêm as ofertas.', '“De onde vêm as ofertas”'],
          ['Grupos', 'Quem recebe: grupos soltos ou [blocos](#docs/grupos/blocos).', '“Grupos que vão receber”'],
          ['Ritmo', 'Quantas ofertas, a cada quanto tempo e em que horário.', '“Ritmo de envio”'],
        ] } },
        { passos: [
          'Abra [[Disparo automático]] e clique em “Novo disparo automático”.',
          'Dê um “Nome” e escolha a “Etiqueta ML padrão” e o “Template”.',
          'Escolha as fontes de ofertas.',
          'Se quiser, preencha os “Filtros” (preço e desconto mínimos, preço máximo), que valem para todas as fontes.',
          'Marque os grupos em “Grupos que vão receber”. “Marcar um bloco…” marca um bloco inteiro de uma vez (veja [Blocos de análise](#docs/grupos/blocos)).',
          'Defina o ritmo de envio.',
          'Clique em “Criar disparo automático”.',
        ] },
        { p: 'Cada disparo vira um cartão com interruptor e os botões “Enviar agora”, “Ver ofertas”, “Editar”, “Limpar ‘já enviadas’” e “Excluir”.' },
        { nota: 'dica', texto: 'Para o mesmo grupo receber de duas etiquetas, crie dois disparos apontando para ele. Se o grupo tem código de rastreio, a etiqueta dele vence a do disparo ([veja aqui](#docs/grupos/rastreio)).' },
      ],
    },
    {
      id: 'fontes', titulo: 'Fontes de ofertas',
      onde: '[[Disparo automático → Novo disparo automático → De onde vêm as ofertas]]',
      leia: 'disparo-automatico/catalogo',
      blocos: [
        { p: 'Um disparo aceita até 5 fontes, misturadas como você quiser. As ofertas saem intercaladas, uma de cada fonte por vez. Fonte que falha vira aviso no Histórico, sem travar as outras.' },
        { tabela: { colunas: ['Fonte', 'Para que serve', 'O que você preenche'], linhas: [
          ['Central de Afiliados', 'A lista “Produtos selecionados para você” da sua Central. É a mais prática.', '“Buscar por (opcional)”, “Categorias”, “Ordem”, “Páginas lidas por envio”, “Só mais vendidos” e “Só com ganhos extras”.'],
          ['Lista de links', 'Produtos que você escolheu à mão.', '“Um produto por linha”. Formato opcional: `link | título | preço | preço antigo | cupom`.'],
          ['Busca por palavra-chave (experimental)', 'Ofertas de uma busca no Mercado Livre.', '“Palavra-chave” e “Ordem”.'],
          ['Catálogo (app Etiqueta)', 'As ofertas do seu app Etiqueta, já com link de afiliado.', 'Veja a próxima seção.'],
        ] } },
        { p: 'Na Central, marque uma ou várias categorias (nenhuma marcada = todas); com várias, as ofertas saem intercaladas. Cada página lida traz 18 produtos; “Páginas lidas por envio” vai de 1 a 10.' },
        { p: 'Cada fonte pode ter a sua “Etiqueta ML desta fonte”; com “A etiqueta ML padrão”, vale a do disparo.' },
        { nota: 'dica', texto: 'Para todas as fontes saírem no mesmo envio, ponha “Ofertas por envio” igual ao número de fontes.' },
      ],
    },
    {
      id: 'catalogo', titulo: 'Usar o Catálogo como fonte',
      onde: '[[Disparo automático → Novo disparo automático → De onde vêm as ofertas]]',
      leia: 'conexoes/catalogo',
      blocos: [
        { p: 'O Catálogo traz as ofertas do seu app Etiqueta. Antes, conecte-o em [Conexões](#docs/conexoes/catalogo).' },
        { passos: [
          'Em “De onde vêm as ofertas”, escolha “Catálogo (app Etiqueta)”.',
          'Marque as “Categorias do Etiqueta” (até 20; nenhuma marcada = todas).',
          'Marque as “Lojas”: Mercado Livre, Amazon e Shopee (nenhuma marcada = as três).',
          'Se quiser, preencha “Buscar por (opcional)” (até 10 palavras separadas por vírgula; basta uma aparecer no título) e “Desconto mínimo no catálogo (%)”, de 0 a 99, que vale só para esta fonte.',
          'Escolha a “Ordem”.',
        ] },
        { p: 'A ordem padrão, “Novidades (após salvar)”, envia só o que chegar ao catálogo depois de você salvar. A primeira leitura apenas marca o ponto de partida, e “Ver ofertas” avisa “Primeira leitura”. As outras ordens e o botão “Reler do começo” estão em [Ordens do Catálogo](#docs/referencia/ordens-catalogo).' },
        { p: 'O Mercado Livre sai sozinho, com o `meli.la` refeito pela extensão e a etiqueta do disparo; a Amazon sai sozinha, com a tag de [[Conexões → Amazon]]. Sem a extensão ou sem a tag, a oferta espera. Toda oferta da Shopee espera a sua [revisão](#docs/revisao/motivos) em [[Histórico → Catálogo]] e, aprovada, sai com o link do próprio catálogo. Também esperam as ofertas com 100% de desconto, com preço antigo 10 vezes maior ou com link que falhou. Só o Dono revisa.' },
        { nota: 'dica', texto: 'A “Etiqueta ML padrão” é opcional ou obrigatória? Depende das lojas do Catálogo: veja [Perguntas reais](#docs/perguntas/so-catalogo).' },
        { nota: 'erro', texto: '“Catálogo indisponível” no cartão do disparo: o Etiqueta está fora do ar. As outras fontes seguem. Ligue o `servidor.py` e teste em Conexões.' },
      ],
    },
    {
      id: 'ritmo', titulo: 'Ritmo e horário',
      onde: '[[Disparo automático → Novo disparo automático → Ritmo de envio]]',
      blocos: [
        { p: 'Defina o ritmo em “Ritmo de envio”:' },
        { tabela: { colunas: ['Campo', 'O que faz', 'Limites'], linhas: [
          ['“Ofertas por envio”', 'Quantas ofertas saem a cada ciclo, cada uma para todos os grupos.', 'De 1 a 20'],
          ['“Intervalo entre envios (minutos)”', 'O tempo entre um ciclo e o seguinte.', 'Mínimo 1'],
          ['“Funciona das” e “Até”', 'O horário em que o disparo pode enviar. Pode virar a noite (ex.: das 20:00 até 02:00).', 'Hora local'],
          ['“Não repetir a mesma oferta por (dias)”', 'Por quantos dias a mesma oferta não se repete neste disparo.', '0 = pode repetir'],
          ['“Foto do produto”', '“Enviar com foto, quando houver” ou “Só texto”.', 'Padrão: com foto'],
        ] } },
        { nota: 'aviso', texto: 'Intervalos curtos aumentam o risco de o WhatsApp restringir o número; 30 a 60 minutos é um bom ritmo.' },
        { nota: 'dica', texto: 'Prefere mandar em horas certas do dia, cada uma com a sua quantidade de ofertas e o seu template? Veja os [horários marcados](#docs/disparo-automatico/horarios-marcados).' },
      ],
    },
    {
      id: 'horarios-marcados', titulo: 'Horários marcados',
      onde: '[[Disparo automático → Novo disparo automático → Ritmo de envio → Em horários marcados]]',
      blocos: [
        { p: 'Em vez de enviar “a cada X minutos”, o disparo pode sair em **horários marcados**: você lista as horas do dia e diz, para cada uma, quantas ofertas saem e com qual template. Por exemplo, 5 ofertas às 12:00, 2 às 15:00 e 8 às 20:00. É opcional, disparo por disparo: o padrão continua sendo “A cada X minutos”, e os disparos que você já tem não mudam.' },
        { passos: [
          'Abra [[Disparo automático]] e clique em “Novo disparo automático” (ou em “Editar”, num disparo que já existe).',
          'Em “Ritmo de envio”, no “Como enviar”, escolha “Em horários marcados”.',
          'Marque “Em quais dias” os horários valem. O padrão é todos os dias.',
          'Monte a lista com os “Modelos rápidos”, com o “Montar…” ou com o botão “+ Adicionar horário”. Cada linha tem “Horário”, “Ofertas” e “Template”; em “Template”, “Padrão do disparo” usa o template do disparo.',
          'Confira o resumo embaixo da lista (por exemplo, “14 horários por dia…”) e clique em “Salvar”.',
        ] },
        { tabela: { colunas: ['Campo', 'O que faz', 'Limites'], linhas: [
          ['Horários', 'As horas do dia em que o disparo envia, sem horário repetido.', 'até 48 horários, com pelo menos 10 min entre um e outro (inclusive da noite para a manhã: 23:55 e 00:00 não cabem juntos)'],
          ['“Ofertas”', 'Quantas ofertas saem naquele horário. Cada oferta vai para todos os grupos do disparo.', 'de 1 a 20 ofertas por horário'],
          ['“Template”', 'O modelo da mensagem daquele horário. Vazio: o template do disparo.', 'Um template que exista'],
          ['“Em quais dias”', 'Os dias da semana em que a lista inteira vale.', 'Ao menos um dia'],
        ] } },
        { p: '**Modelos rápidos e “Montar…”.** “A cada 30 min, 8h às 22h”, “A cada hora, 8h às 22h”, “Manhã, tarde e noite” (09:00, 15:00 e 20:00) e “Horários de pico” (12:00, 18:00 e 21:00) preenchem a lista de uma vez. O “Montar…” faz o mesmo com o seu “De”, “Até”, “A cada” e “Ofertas em cada”. Os modelos rápidos e o “Montar…” incluem o horário final: de hora em hora, das 8h às 22h, dá 15 horários. “Substituir horários” troca a lista; “Acrescentar” soma ao que já existe. Nada fica salvo até clicar em “Salvar”.' },
        { p: '**Quem já tinha um ritmo.** Na primeira vez que você troca para “Em horários marcados”, o painel converte o ritmo atual em uma lista: do início de “Funciona das”, a cada “Intervalo entre envios”, com as “Ofertas por envio”. O horário final não entra: “a cada 60 min, das 8h às 22h” vira 14 horários, das 08:00 às 21:00. Se a conta não couber na grade (mais de 48 horários ou menos de 10 min entre eles), a lista começa vazia, para você escolher um modelo. Voltar para “A cada X minutos” restaura o ritmo anterior, porque os campos continuam guardados.' },
        { p: '**A janela.** Em horários marcados, o “Funciona das/até” não vale: os horários dizem tudo. Os valores ficam guardados para quando você voltar ao intervalo.' },
        { p: '**O cartão.** O cartão do disparo ganha o selo “Grade”, um resumo (quantos horários, de quando a quando, quantas ofertas) e o “Próximo envio”, por exemplo “hoje às 10:30: 3 ofertas com o template Padrão”.' },
        { nota: 'dica', texto: 'Quer saber o que o programa faz quando um horário chega, atrasa ou fica sem ofertas? Veja [O que acontece na hora marcada](#docs/disparo-automatico/na-hora-marcada).' },
      ],
    },
    {
      id: 'na-hora-marcada', titulo: 'O que acontece na hora marcada',
      onde: '[[Disparo automático → cartão do disparo]]',
      blocos: [
        { p: '**O que sai em cada horário.** Na hora marcada, o programa busca a quantidade daquele horário, monta a mensagem com o template daquele horário e envia para os grupos do disparo, uma oferta de cada vez, com as [pausas de Ajustes](#docs/manutencao/ajustes). Se houver menos ofertas do que o pedido, sai o que houver, sem acumular para o horário seguinte, e o Histórico avisa. Sem nenhuma oferta nova, vale a mensagem de sempre: “Sem ofertas novas dentro dos filtros desta vez.”' },
        { p: '**Horário perdido.** O programa pode estar desligado, o WhatsApp desconectado ou outro envio demorar. O horário sai se atrasou até 30 min. Passou disso, é pulado, com um aviso no [[Histórico]]. Se vários horários venceram, sai só o mais recente: nunca saem dois atrasados de uma vez. Com o WhatsApp fora, o horário espera a volta dele, dentro desses mesmos 30 min.' },
        { tabela: { colunas: ['Aviso no Histórico', 'O que significa'], linhas: [
          ['Horário 10:00 pulado: o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 12:00.', 'Um horário passou do prazo e não saiu. O próximo sai normalmente (ou o aviso diz “O das 12:00 sai agora.”).'],
          ['3 horários pulados (10:00 a 12:00): o programa estava desligado, o WhatsApp desconectado ou outro envio demorou.', 'Vários horários venceram juntos. Só o mais recente tem direito de sair.'],
          ['8 horários pulados (09:00 de 03/11 a 13:00): o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 21:00.', 'O programa ficou dias desligado. Em vez de um aviso para cada horário, o Histórico traz um só, com o primeiro e o último pulados; o de outro dia vem com a data. Depois de muitos dias, o número pode ficar abaixo do total: o programa não confere um por um os horários do meio.'],
          ['Horário 10:00: saíram 5 de 8 ofertas; não havia mais ofertas novas dentro dos filtros.', 'A fonte tinha menos ofertas novas do que o horário pedia. Amplie as fontes ou os filtros se isso se repetir.'],
          ['Horário 10:00: o template escolhido para este horário não existe mais. As ofertas saíram com o template da regra.', 'O template da linha foi apagado. Escolha outro na grade. (O aviso diz “da regra” porque é a palavra que o programa escreve; aqui é o template do disparo.)'],
        ] } },
        { p: '**Enviar agora e Ver ofertas.** Num disparo com horários marcados, “Ver ofertas” e “Enviar agora” usam a quantidade e o template do próximo horário. “Enviar agora” manda de verdade, mas não pula esse horário: ele sai de novo na hora marcada. Os avisos desse envio começam com “Enviar agora (como no horário das 10:00):”.' },
        { p: '**Template em uso.** Um template usado em algum horário não pode ser apagado. O painel diz qual disparo e qual horário o usam, com esta frase:' },
        { exemplo: 'A regra "Promoções" usa este template no horário 10:00.' },
        { p: 'Troque o template daquele horário em “Editar” e apague de novo. O programa escreve “regra” nessa frase; o nome entre aspas é o do seu disparo.' },
        { nota: 'aviso', texto: 'O painel soma as mensagens por dia de todos os disparos e de todas as rotinas do [[Grupo vivo]] que estão ligados. Com mais de 400 mensagens por dia, aparece um aviso no formulário. É só um aviso: o programa nunca bloqueia. O WhatsApp não publica um limite; o 400 é uma estimativa prudente, e quem decide é você. Para baixar: menos ofertas por horário, menos horários ou menos grupos.' },
      ],
    },
    {
      id: 'mexer-nos-horarios', titulo: 'Mexer na lista de horários',
      onde: '[[Disparo automático → Novo disparo automático → Ritmo de envio → Horários]]',
      blocos: [
        { p: '**Mexer na lista.** A lista só põe as linhas em ordem quando você sai dela: digite o horário, vá para outro campo fora da lista (ou aperte Enter) e a linha vai para o lugar certo, com o aviso “Horário 21:00 movido para a posição 27.” e um contorno até a sua próxima ação. Enquanto você está dentro da lista, nada muda de lugar. “Copiar” cria a linha logo abaixo da original; “+ Adicionar horário” põe a nova no fim. Esse botão e o “Limpar tudo” ficam acima da lista e acompanham a rolagem; em tela estreita, só os avisos acompanham. Enter no “Horário” ou nas “Ofertas” não salva o disparo: salve pelo botão “Salvar”.' },
        { p: '**Remover e “Limpar tudo”.** Os dois apagam sem pedir confirmação, porque nada vale até o “Salvar”. Logo acima da lista aparece, por exemplo, “Horário 12:00 removido.” com o botão “Desfazer”, que devolve as linhas, com o que estava digitado, até você mexer na lista de novo. Um clique duplo em “Remover” apaga só uma linha.' },
        { p: '**Cancelar com alterações.** “Cancelar” e a tecla Esc perguntam “Descartar as alterações?” quando há algo não salvo no formulário; sem alterações, fecham direto.' },
      ],
    },
    {
      id: 'pausas', titulo: 'Pausas entre mensagens',
      onde: '[[Ajustes → Pausas entre mensagens]]',
      leia: 'manutencao/ajustes',
      blocos: [
        { p: 'Além do intervalo do disparo, o programa espera um pouco entre as mensagens. Essas pausas valem para todos os envios e se ajustam em Ajustes: veja [Ajustes: pausas e limites](#docs/manutencao/ajustes).' },
      ],
    },
    {
      id: 'testar', titulo: 'Testar antes de ligar',
      onde: '[[Disparo automático → cartão do disparo]]',
      blocos: [
        { passos: [
          'No cartão do disparo, clique em “Ver ofertas”. Abre “Próximas ofertas”: o que sairia no próximo envio, nesta ordem. O link `meli.la` só é gerado na hora de enviar.',
          'Se estiver bom, clique em “Enviar agora” para um envio de verdade. O painel avisa “Envio iniciado. Acompanhe no Histórico.”',
          'Confira o resultado em [[Histórico]].',
        ] },
        { p: 'Para mandar de novo ofertas já enviadas, clique em “Limpar ‘já enviadas’”.' },
        { nota: 'aviso', texto: '“Enviar agora” manda de verdade. Um disparo novo já nasce ligado e envia no próximo ciclo. “Ver ofertas” não envia nada.' },
      ],
    },
    {
      id: 'remetentes', titulo: 'Receber links de um remetente',
      onde: '[[Disparo automático → Novo remetente]]',
      blocos: [
        { p: 'Um **remetente** é um número de WhatsApp de confiança, como o do seu sócio, que pode mandar links de produto no privado do número conectado. O programa monta a oferta e envia para os grupos que você escolheu, sem pedir a sua aprovação. O link sai sempre com a **sua** afiliação, nunca com a de quem mandou. Número que você não cadastrou é ignorado, sem resposta.' },
        { p: '**Como cadastrar.** Só o Dono cadastra, edita, liga e exclui remetentes; o Operador só vê.' },
        { passos: [
          'Abra [[Disparo automático]] e clique em “Novo remetente”.',
          'Escreva o “Nome” (só você vê) e o “Número do remetente”, com DDD. O programa confere se o número existe no WhatsApp. O número conectado ao painel não pode ser o remetente.',
          'Marque os “Grupos de destino”: é para onde vão todos os links deste número. “Marcar um bloco…” só ajuda a marcar; se o bloco mudar depois, a lista não muda.',
          'Escolha o “Template” (precisa do campo `{LINK}`), a “Etiqueta do Mercado Livre” e a “Foto do produto”.',
          'Em “Ritmo e proteção”, ajuste “No máximo (links por hora)” e “Não repetir o mesmo produto por (horas)”.',
          'Decida se ele recebe resposta em “Responder ao remetente no WhatsApp” e clique em “Criar remetente”.',
        ] },
        { p: 'Cada remetente vira um cartão com interruptor, o resumo do que ele mandou nas últimas 24 horas e os botões “Ver registro”, “Editar” e “Excluir”. Desligado, ele continua cadastrado, mas os links dele são ignorados em silêncio.' },
        { p: '**As quatro lojas.** Aceita links do Mercado Livre, da Amazon, da Shopee e da Magalu. O programa nunca reenvia o link que o remetente mandou: ele lê o produto (na Magalu, usa o título e o preço escritos na mensagem) e gera o seu.' },
        { tabela: { colunas: ['Loja', 'Como o link sai', 'O que precisa estar pronto'], linhas: [
          ['Mercado Livre', 'Um `meli.la` novo, gerado pela extensão do Chrome, com a etiqueta escolhida no remetente.', 'A etiqueta em [[Conexões → Mercado Livre]] e a extensão conectada. Com o link direto (sem extensão) o link do Mercado Livre não sai.'],
          ['Amazon', 'O endereço do produto com a sua tag de associado.', 'A tag em [[Conexões → Amazon]].'],
          ['Shopee', 'Um link curto gerado pela sua conta, pela API ou pela extensão.', 'O ID de afiliado em [[Conexões → Shopee]] e a API da Shopee ou a extensão do Chrome conectada.'],
          ['Magalu', 'O endereço do produto na sua loja de parceiro (`magazinevoce.com.br/<sua loja>/…`). A loja que vem no link do remetente nunca vale.', 'O nome da loja em [[Conexões → Magalu]].'],
        ] } },
        { p: 'Os links do remetente seguem o código de rastreio de cada grupo (a Magalu não tem rastreio por grupo), como no [[Disparo manual]]: a etiqueta do grupo vence a escolhida no remetente e, na Shopee, o link sai com o Sub_id do bloco. Veja [Rastreio por grupo](#docs/grupos/rastreio).' },
        { p: 'Título, preço e foto vêm da loja. Quando a loja não informa algum campo, o programa completa com o que o remetente escreveu na mensagem (título na primeira linha, “De R$”, “Por R$”, “NN% OFF”, frete e cupom), mas só quando a mensagem tem um link só. Na Magalu nada vem da loja: título e preço têm de estar na mensagem. Sem título ou sem preço a oferta não sai, e o remetente é orientado a mandar o link junto com o nome e o preço. Veja [Como escrever a mensagem](#docs/espelhamento/formato).' },
        { p: '**O que o remetente recebe.** Com “Responder ao remetente no WhatsApp” ligado, ele recebe uma frase por mensagem, depois que os envios terminam. A resposta nunca leva link, número, nome de grupo nem o texto que ele mandou.' },
        { tabela: { colunas: ['Situação', 'Frase que o remetente recebe'], linhas: [
          ['Saiu para todos os grupos', '“Enviado para 3 grupos.” (ou “Enviado para 1 grupo.”)'],
          ['Saiu só para alguns', '“Enviado para 2 de 3 grupos.”'],
          ['Não saiu para nenhum', '“Não consegui enviar esse link para os grupos. O dono vai ver o motivo no painel.”'],
          ['Produto repetido', '“Esse produto já foi enviado há 3 h. Não repeti.”'],
          ['Falta afiliação, grupo ou template', '“Não consegui montar esse link agora. O dono vai ver o motivo no painel.”'],
          ['Sem título ou sem preço', '“Não consegui ler os dados desse produto. Mande o link junto com o nome e o preço.”'],
          ['Link que não é de produto', '“Não reconheci esse link. Mande o link da página do produto.”'],
          ['Mensagem com link, mas de outra loja', '“Não encontrei um link do Mercado Livre, Amazon, Shopee ou Magalu nessa mensagem.”'],
          ['Passou do limite por hora', '“Muitos links em pouco tempo. Tente de novo daqui a pouco.” (no máximo 1 vez por hora)'],
          ['Vários links na mesma mensagem', '“Recebi 3 links: 2 enviados, 1 repetido.”'],
        ] } },
        { p: 'Mensagem sem nenhum link, número desconhecido, remetente desligado e mensagem da própria conta não recebem nada: silêncio. Assim ninguém descobre, testando, se um número está cadastrado.' },
        { p: '**Limites.** Servem para proteger os seus grupos, caso o número do remetente caia em outras mãos.' },
        { tabela: { colunas: ['O quê', 'Valor', 'Onde muda'], linhas: [
          ['Links por hora', '10 links por hora por remetente por padrão; o campo aceita de 1 a 60 links por hora. Os que passam disso são descartados.', 'Campo “No máximo (links por hora)”'],
          ['Mesmo produto', '24 h sem repetir por padrão (de 0 a 8760; 0 = pode repetir). Vale por remetente, mesmo com link diferente.', 'Campo “Não repetir o mesmo produto por (horas)”'],
          ['Links por mensagem', 'até 5 links por mensagem; o resto é ignorado', 'Fixo'],
          ['Programa fora do ar', 'a mensagem que o remetente mandou com o programa desligado ou sem conexão não é processada, sem resposta: ele precisa mandar de novo. Um link aceito que fica parado na fila por mais de 2 h expira', 'Fixo'],
          ['Respostas', 'até 20 respostas por hora por remetente', 'Fixo'],
        ] } },
        { p: 'Os envios saem pela mesma fila dos outros disparos, com as [pausas de Ajustes](#docs/manutencao/ajustes), e cada link aparece em [[Histórico → Tipo → Remetente]] com o resultado e o motivo, mesmo quando não saiu. O Histórico mostra só o nome que você deu ao remetente, nunca o número.' },
        { p: '**Privacidade.** O número do remetente fica só no seu computador (e na cópia criptografada do backup), entra no backup e é apagado ao excluir o remetente; o Histórico fica com o nome. Os backups que você já fez continuam com o número até saírem da rotação (7 no computador; 14 no Google Drive, que depois ficam até 30 dias na lixeira do Drive). O texto da mensagem não é guardado: ficam só os campos lidos dele (título, preço, cupom), com e-mails e telefones já escondidos. O painel mostra o número sempre mascarado. Veja [Privacidade](#docs/privacidade/dados).' },
        { nota: 'aviso', texto: 'Quem controla o número do remetente consegue mandar links para os seus grupos, até o limite por hora do remetente, sempre das quatro lojas e sempre com a sua afiliação. Se desconfiar de um número, desligue o remetente no cartão ou exclua-o.' },
        { nota: 'dica', texto: 'O link não saiu e o remetente recebeu “Não consegui montar esse link agora”? Abra [[Histórico → Tipo → Remetente]]: o motivo mais comum é a etiqueta, a tag, o ID ou o nome da loja de parceiro que falta em [[Conexões]]. O cartão do remetente também mostra o problema: grupo, template ou etiqueta apagados aparecem logo, e o aviso de tag, ID ou nome da loja faltando aparece depois que um link foi barrado por isso.' },
      ],
    },
  ],
});

docsCapitulo({
  id: 'mensagens',
  titulo: 'Disparar mensagem e enquete',
  aprenda: [
    'Mandar um texto livre, com ou sem foto.',
    'Criar uma enquete.',
    'Enviar agora, agendar ou repetir, e pausar ou cancelar.',
    'Manter o Grupo vivo com rotinas de mensagem e enquete.',
  ],
  abrir: [{ rota: '#disparar-mensagem', tela: 'Disparar mensagem' }, { rota: '#grupo-vivo', tela: 'Grupo vivo' }],
  secoes: [
    {
      id: 'mensagem', titulo: 'Mensagem com foto',
      onde: '[[Disparar mensagem]]',
      blocos: [
        { p: 'Serve para avisos, sorteios e chamadas que não são oferta.' },
        { passos: [
          'Abra [[Disparar mensagem]] e marque os grupos.',
          'Em “Tipo”, deixe “Mensagem”.',
          'Escreva o texto (até 4096 caracteres). Use `*negrito*`, `_itálico_` e `~riscado~`.',
          'Em “Imagem”, escolha “Sem imagem”, “Foto com legenda” ou “Prévia do link”.',
          'Deixe “Quando enviar” em “Agora” e clique em “Disparar agora”. Para outros horários, veja a seção “Agora, agendada ou repetida”.',
        ] },
        { p: 'Com “Foto com legenda”, o texto vai como legenda. A foto é JPG ou PNG de até 5 MB. O painel a regrava antes de guardar: gira se for preciso e tira os metadados (EXIF, localização, modelo do aparelho). A “Prévia do link” mostra título e imagem do site embaixo do texto, e só funciona com links do Mercado Livre.' },
        { nota: 'erro', texto: '“A foto passa de 5 MB.” Escolha uma foto menor. “Use uma foto JPG ou PNG.” Troque o formato.' },
      ],
    },
    {
      id: 'enquete', titulo: 'Enquete',
      onde: '[[Disparar mensagem]]',
      blocos: [
        { passos: [
          'Em “Tipo”, escolha “Enquete”.',
          'Escreva a “Pergunta” (até 255 caracteres).',
          'Preencha de 2 a 12 “Opções”, com até 100 caracteres cada. Clique em “+ Adicionar opção” para somar.',
          'Marque “Permitir mais de uma resposta” se quiser.',
          'Escolha “Quando enviar” e envie.',
        ] },
        { nota: 'dica', texto: 'As opções da enquete não podem se repetir.' },
        { nota: 'aviso', texto: 'Enquetes e repetições aumentam o volume de envio e o risco de o WhatsApp restringir o número. Use com moderação.' },
      ],
    },
    {
      id: 'quando', titulo: 'Agora, agendada ou repetida',
      onde: '[[Disparar mensagem → Quando enviar]]',
      blocos: [
        { tabela: { colunas: ['Opção', 'O que faz', 'Botão'], linhas: [
          ['Agora', 'Envia já. O WhatsApp precisa estar conectado.', '“Disparar agora”'],
          ['Agendar', 'Envia em uma data e hora que você escolhe.', '“Agendar envio”'],
          ['Repetir', 'Envia nos dias da semana e nos horários que você escolhe.', '“Salvar repetição”'],
        ] } },
        { p: 'Para repetir, toque nos “Dias da semana” e adicione de 1 a 6 horários por dia, com “+ Adicionar horário”. Exemplo: segunda e quinta, às 09:00 e 18:00.' },
        { p: 'Todo envio, inclusive o “Agora”, sai pela mesma fila do disparo automático, com as pausas de Ajustes. Por isso pode haver atraso de alguns minutos enquanto um disparo está enviando.' },
        { nota: 'aviso', texto: 'Um agendado que perde o horário por mais de 2 horas (programa desligado, por exemplo) não sai mais e vira erro no Histórico. Agendados e repetições sobrevivem a um reinício e retomam sozinhos.' },
      ],
    },
    {
      id: 'pausar', titulo: 'Pausar e cancelar',
      onde: '[[Disparar mensagem → Agendadas e repetidas]]',
      blocos: [
        { p: 'No cartão “Agendadas e repetidas”, ao lado do formulário, cada item tem botões:' },
        { passos: [
          '“Pausar” e “Retomar”: só nas repetidas.',
          '“Cancelar envio”: nas agendadas e nas repetidas. O painel pede confirmação.',
        ] },
        { p: 'O que já saiu fica no [[Histórico]], com o resultado de cada envio.' },
        { nota: 'dica', texto: 'Cancelar uma mensagem agendada evita o envio. O que já foi enviado não volta.' },
      ],
    },
    {
      id: 'grupo-vivo', titulo: 'Grupo vivo: rotinas de mensagem e enquete',
      onde: '[[Grupo vivo]]',
      blocos: [
        { p: 'O **Grupo vivo** manda sozinho mensagens e enquetes que mostram que o grupo tem gente por trás: bom dia, regras, aviso de segurança, uma pergunta. Não é oferta (as ofertas saem pelo [[Disparo automático]]) e não é envio pontual: para um aviso ou um sorteio de hoje, [[Disparar mensagem]] continua servindo, para envios pontuais.' },
        { p: 'Cada **rotina** tem um nome (só você vê), uma chave de liga e desliga, o tipo (“Mensagem” ou “Enquete”, que não muda depois de criada), de 1 a 5 conteúdos, os grupos, os dias da semana e de 1 a 6 horários. Uma rotina aceita até 5 textos ou enquetes e até 6 horários por rotina, e o programa guarda até 50 rotinas. Sem foto por enquanto.' },
        { passos: [
          'Abra [[Grupo vivo]] e clique em “Nova mensagem” ou “Nova enquete”. Para partir de um exemplo, clique em “Modelos”.',
          'Escreva o “Nome” e o texto (ou a pergunta e as opções da enquete). Com mais de um conteúdo, escolha a “Ordem”.',
          'Marque os grupos, os “Dias da semana” e os “Horários” (de 1 a 6; digite a hora e clique em “+ Adicionar horário”).',
          'Deixe “Ligar agora” marcado para a rotina já valer e clique em “Criar rotina”.',
        ] },
        { p: '**Galeria de modelos.** Em “Modelos” há 10 modelos: seis mensagens (Bom dia, Regras do grupo, Aviso de segurança, Prova social, Preço muda e Boa noite) e quatro enquetes (o que ver mais, já comprou, melhor horário e sextou). “Usar este modelo” só preenche o formulário: nada é salvo até você clicar em “Criar rotina”, e dá para mudar tudo. Os modelos convidam o grupo a participar e não trazem número inventado.' },
        { p: '**Ordem dos conteúdos.** Com mais de um texto (ou enquete), cada envio usa um deles, para o grupo não ver sempre a mesma mensagem. “Um depois do outro” segue a lista e volta ao primeiro. “Sorteio” escolhe ao acaso, sem repetir o último.' },
        { p: '**O cartão.** Cada rotina vira um cartão com a chave, o resumo, o “Próximo envio”, quantas saíram nas últimas 24 horas e os botões “Enviar agora”, “Editar”, “Copiar” e “Excluir”. Desligada, ela continua salva e aparece como “Pausado”. Se o número saiu de um grupo, o cartão avisa, e o motivo está no [[Histórico]]. Excluir uma rotina não apaga o que ela já enviou: continua no Histórico. A lista se atualiza sozinha a cada 10 s, enquanto nenhum formulário está aberto.' },
        { p: '**Enviar agora.** Manda a rotina já, para os grupos dela. “Enviar agora” avança o rodízio (o próximo envio usa o conteúdo seguinte) e não muda o próximo horário da rotina. Para a mesma rotina, o programa só aceita um “Enviar agora” a cada 1 min, para um clique repetido não mandar a mesma mensagem duas vezes.' },
        { p: '**Horário perdido.** Vale o mesmo dos horários marcados do Disparo automático: o horário sai se atrasou até 30 min; depois disso é pulado, com um aviso no Histórico, e se vários venceram sai só o mais recente. Veja [O que acontece na hora marcada](#docs/disparo-automatico/na-hora-marcada).' },
        { tabela: { colunas: ['Aviso no Histórico', 'O que significa'], linhas: [
          ['Horário de 05/11 10:00 pulado: o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 05/11 18:00.', 'O horário passou do prazo e não saiu. O próximo sai normalmente.'],
          ['7 horários pulados, o último de 05/11 08:00: o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 05/11 18:00.', 'O programa ficou dias desligado e vários horários passaram. O Histórico traz um aviso só, com o último horário pulado, em vez de um por horário.'],
          ['Não enviada: os grupos desta rotina não existem mais. Edite a rotina e escolha os grupos.', 'Todos os grupos da rotina foram apagados ou o número saiu deles.'],
        ] } },
        { p: 'Os envios saem pela mesma fila dos outros, com as [pausas de Ajustes](#docs/manutencao/ajustes), e aparecem no [[Histórico]] como “Grupo vivo: nome da rotina” (por exemplo, “Grupo vivo: Bom dia”), no tipo “Tudo”. O Operador pode criar e mudar rotinas, como no Disparo automático.' },
        { nota: 'aviso', texto: 'Rotinas são mais mensagens por dia. O painel soma os disparos e as rotinas ligados e, com mais de 400 mensagens por dia, mostra um aviso no formulário do [[Disparo automático]]. Quando há outros disparos ou rotinas ligados, o aviso diz “Somando os outros disparos e rotinas ligados, este número…”; quando só o disparo aberto entra na conta, diz “Este número…”. É só um aviso: o programa nunca bloqueia, mas o risco de o WhatsApp restringir o número cresce com o volume.' },
      ],
    },
  ],
});
