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
    'O que muda para Amazon e Shopee.',
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
          'Escolha o template e a “Etiqueta”. A etiqueta só existe no Mercado Livre.',
          'Confira a prévia e clique em “Disparar”.',
          'Veja o resultado no cartão “Histórico”, ao lado.',
        ] },
        { p: 'O link `meli.la` da Central de Afiliados também vale. Ele leva a uma página de afiliado, e o painel lê essa página e gera o seu link a partir do produto. Se não conseguir ler, cole o link da página do produto.' },
        { nota: 'aviso', texto: 'Para disparar na hora, o WhatsApp precisa estar conectado e a extensão do Chrome on-line. Sem a extensão, o botão “Disparar” fica apagado e a frase ao lado diz o motivo. Dá para agendar.' },
        { nota: 'dica', texto: 'Link de Magalu ou Facebook é reconhecido, mas o painel avisa que a loja ainda não está conectada e não envia nada. Só Mercado Livre, Amazon e Shopee geram link de afiliado.' },
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
        { nota: 'erro', texto: '“Não consegui buscar os dados na Amazon agora.” Sem API, ou com a API fora do ar, a tela deixa os campos em branco e o título é obrigatório. Preencha à mão. Link de busca, lista ou loja é recusado: cole o link da página do produto.' },
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
        { nota: 'aviso', texto: 'Se a API responde mas não reconhece o produto, ele provavelmente não participa do programa de afiliados e não geraria comissão. O disparo é bloqueado.' },
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
        { nota: 'dica', texto: 'No Mercado Livre, o link é gerado na hora de sair: a extensão precisa estar conectada nesse horário. Na Amazon, os dados e o link também são buscados na hora. Na Shopee, o link já foi gerado ao agendar.' },
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
    'Definir o ritmo e o horário.',
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
        { nota: 'dica', texto: 'Para o mesmo grupo receber de duas etiquetas, crie dois disparos apontando para ele.' },
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
  ],
});

docsCapitulo({
  id: 'mensagens',
  titulo: 'Disparar mensagem e enquete',
  aprenda: [
    'Mandar um texto livre, com ou sem foto.',
    'Criar uma enquete.',
    'Enviar agora, agendar ou repetir, e pausar ou cancelar.',
  ],
  abrir: [{ rota: '#disparar-mensagem', tela: 'Disparar mensagem' }],
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
  ],
});
