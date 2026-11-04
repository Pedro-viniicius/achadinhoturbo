// Docs do sistema: capítulos 6 (Espelhar ofertas da Amazon) e 7 (Revisão de ofertas).
// Só chama docsCapitulo (public/docs.js): nenhuma declaração no topo, porque o escopo global é o mesmo dos outros
// scripts do painel. Formato dos blocos e mini-marcação: comentário de docsInline e plano docs-do-sistema.
// Slugs da spec (docs/produto/specs/docs-do-sistema.md, seção 1): pode acrescentar seção, nunca renomear nem tirar.
// Fontes do texto: README ("Espelhamento da Amazon", "Catálogo do Etiqueta → O que vai para a revisão"), src/espelho.js,
// src/catalogo-itens.js (MOTIVOS, TETO_REVISAO) e os rótulos de public/espelhamento.js. Número novo aqui entra na FATOS.

docsCapitulo({
  id: 'espelhamento',
  titulo: 'Espelhar ofertas da Amazon',
  aprenda: [
    'O que preparar antes de criar um espelhamento.',
    'Como escrever a mensagem de origem para o painel ler.',
    'Filtrar repetidas e palavras bloqueadas.',
    'Completar ou descartar o que fica na fila.',
  ],
  antes: [
    '[Conexões](#docs/conexoes/amazon): a tag de associado da Amazon salva.',
    '[Primeiros passos](#docs/primeiros-passos/whatsapp): o WhatsApp conectado.',
  ],
  abrir: [
    { rota: '#disparo-automatico', tela: 'Disparo automático' },
    { rota: '#historico', tela: 'Histórico' },
  ],
  secoes: [
    {
      id: 'antes', titulo: 'Antes de começar',
      onde: '[[Conexões → Amazon]]',
      leia: 'conexoes/amazon',
      blocos: [
        { p: 'O espelhamento vigia grupos de origem, pega os links da Amazon que aparecem neles e envia a oferta completa aos seus grupos. O link sai sempre com a **sua** tag, nunca com a de quem postou.' },
        { passos: [
          'Abra [[Conexões → Amazon]], escreva a tag em “Tag de associado” (ex.: `seunome-20`) e clique em **Salvar**.',
          'Confira o WhatsApp em [[Números de WhatsApp]]. O número precisa estar dentro dos grupos de origem **e** de destino: só esses aparecem na lista.',
          'A API da Amazon é opcional. Se tiver, preencha as credenciais e clique em **Testar**.',
        ] },
        { p: 'Com a API, título, preço, desconto e foto vêm da Amazon; sem ela, o painel usa o texto da origem e você completa na fila. Requisitos: [Amazon: tag e API](#docs/conexoes/amazon).' },
        { nota: 'aviso', texto: 'O painel só vê o que chega enquanto o WhatsApp está conectado. Mensagem postada com o programa desligado se perde: ele não lê o histórico do grupo.' },
      ],
    },
    {
      id: 'criar', titulo: 'Criar um espelhamento',
      onde: '[[Disparo automático → Novo espelhamento]]',
      blocos: [
        { passos: [
          'Abra [[Disparo automático]] e clique em **Novo espelhamento**.',
          'Dê um nome e marque os “Grupos de origem” e os “Grupos de destino”. Um grupo não pode ser os dois ao mesmo tempo.',
          'Escolha o “Template”. Ele precisa do campo `{LINK}`.',
          'Defina o que fazer “Quando faltar o preço” e as “Palavras bloqueadas” (próximas seções).',
          'Em “Ritmo de envio”, ajuste o “No máximo por hora” (padrão 10; 0 = sem limite) e, se quiser, “Funciona das”, “Até” e “Foto do produto”.',
          'Deixe marcado “Ligar o espelhamento ao criar” e clique em **Criar espelhamento**.',
        ] },
        { p: 'Fora do horário, ou acima do máximo por hora, a oferta espera e sai quando puder, com os dados consultados de novo. Oferta parada mais de 2 horas porque o programa estava desligado expira em vez de sair velha.' },
        { p: '“Espelhar também mensagens enviadas pelo meu número” vem desligado. Ligue quando um grupo de origem é seu e você mesmo posta as ofertas.' },
        { nota: 'aviso', texto: 'Sem a tag da Amazon, o espelhamento só pode ser salvo desligado.' },
      ],
    },
    {
      id: 'fluxo', titulo: 'O que acontece com cada mensagem',
      blocos: [
        { p: 'Cada mensagem com link da Amazon passa por leitura do link, conferência de repetida e de palavra bloqueada, junção dos dados e envio pela fila. O passo a passo está em [O que acontece com cada mensagem](#docs/referencia/fluxo-espelhamento), na Referência.' },
      ],
    },
    {
      id: 'formato', titulo: 'Como escrever a mensagem de origem',
      blocos: [
        { p: 'Sem a API, quem escreve a mensagem na origem decide o que o painel consegue ler. Este formato é lido por inteiro:' },
        { exemplo: [
          'Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades',
          'De R$ 1.999,00',
          'Por R$ 1.310,05',
          '34% OFF',
          '+200 compras no mês passado',
          'Frete Grátis',
          'Compre aqui: https://www.amazon.com.br/dp/B0FG2MD49G',
        ].join('\n') },
        { tabela: {
          colunas: ['O que', 'Como escrever'],
          linhas: [
            ['Título', 'Na 1ª linha, sem preço nem link (3 a 200 caracteres)'],
            ['Preço antigo', '`De R$ 1.999,00`'],
            ['Preço atual', '`Por R$ 1.310,05`'],
            ['Desconto', '`34% OFF` (só vale se o preço também veio do texto)'],
            ['Vendas', '`+200 compras`, `vendidos` ou `vendas`'],
            ['Frete', '`Frete Grátis`'],
            ['Cupom', '`Cupom DESEJO10` (só com a palavra “cupom”)'],
            ['Link', '`Compre aqui:` e o link da Amazon (diz qual é o produto)'],
          ],
        } },
        { p: 'Sem preço antigo, não escreva a linha “De”. Um preço só é o preço atual; com dois preços sem rótulo, o maior é o antigo. Parcela (“3x de R$ 33,33”) não conta como preço.' },
        { p: 'O link pode ser `amazon.com.br/dp/…` ou curto (`link.amazon`, `amzn.to`). O painel o remonta com o ASIN e a sua tag; parâmetros e a tag de quem postou são descartados.' },
        { nota: 'erro', texto: '“A oferta foi para a fila mesmo com título na mensagem.” Se a 1ª linha tem algo com cara de link (`bit.ly/…`, domínio solto, `@usuario`), o título é descartado por segurança: tire isso da primeira linha.' },
      ],
    },
    {
      id: 'filtros', titulo: 'Repetidas e palavras bloqueadas',
      blocos: [
        { p: 'O mesmo produto (ASIN) não é reenviado pelo mesmo espelhamento dentro de 168 horas, mesmo com link diferente. Mude em “Não repetir a mesma oferta por (horas)”, de 0 a 8760; com 0, pode repetir. Só conta como enviada a oferta que chegou a algum grupo.' },
        { p: 'Em “Palavras bloqueadas”, escreva uma por linha ou separadas por vírgula (até 50 palavras, de até 60 caracteres). Não diferencia maiúscula, minúscula nem acento. A palavra casa no início de outra: “usado” pega “usados”, mas não “acusado”. O painel procura no título e no texto da mensagem de origem; lista vazia não bloqueia nada.' },
        { nota: 'dica', texto: 'No Histórico, em [[Histórico → Espelhamento]], você vê “Descartada: repetida (enviada há 3 h)” ou “Descartada: palavra bloqueada (usado)”.' },
      ],
    },
    {
      id: 'fila', titulo: 'Fila: completar ou descartar',
      onde: '[[Histórico → Espelhamento]]',
      blocos: [
        { p: 'Quando falta o título ou o preço, “Quando faltar o preço” decide o que acontece:' },
        { tabela: {
          colunas: ['Opção', 'O que o painel faz'],
          linhas: [
            ['Esperar eu completar (fica na fila do Histórico)', 'A oferta vai para a fila. Você completa e envia.'],
            ['Enviar mesmo assim, no formato curto', 'Sai na hora com a foto, os dados que existirem e o link (pode sair quase só o link). Vai para a fila se a Amazon diz que o produto não existe na loja do Brasil ou que está indisponível.'],
          ],
        } },
        { passos: [
          'Abra [[Histórico]] e, em “Tipo”, escolha “Espelhamento”. O chip “N na fila”, no cartão do espelhamento, leva direto para lá.',
          'Na linha “Na fila: falta completar”, clique em **Completar**.',
          'Preencha ou ajuste título, preços, cupom, frete e foto (a prévia mostra a mensagem) e clique em **Enviar**, ou em **Descartar**.',
        ] },
        { p: 'Depois de enviada, a linha vira “Espelhada”, com “completada à mão”; as palavras bloqueadas valem de novo para o título que você digitar. A fila expira sozinha: oferta que ninguém completou em 24 horas (ou no prazo de “não repetir”, se for maior; com o padrão de 168 h, 7 dias) vira “Descartada: expirou sem ser completada”.' },
        { nota: 'dica', texto: 'Se outra pessoa já tratou a oferta, a tela avisa “Esta oferta já foi tratada.” Dono e Operador podem completar. O Completar exige a tag salva e o WhatsApp conectado.' },
      ],
    },
  ],
});

docsCapitulo({
  id: 'revisao',
  titulo: 'Revisão de ofertas',
  aprenda: [
    'Quais ofertas esperam a sua revisão e por quê.',
    'Revisar, corrigir o preço e enviar pelo Histórico.',
    'O que fazer quando o envio falha.',
  ],
  antes: ['[Disparo automático](#docs/disparo-automatico/catalogo): um disparo com a fonte Catálogo.'],
  abrir: [{ rota: '#historico', tela: 'Histórico' }],
  secoes: [
    {
      id: 'motivos', titulo: 'O que espera a sua revisão',
      onde: '[[Histórico → Catálogo]]',
      leia: 'disparo-automatico/catalogo',
      blocos: [
        { p: 'Nenhuma oferta suspeita do Catálogo sai sozinha. Quatro motivos mandam a oferta para a revisão:' },
        { tabela: {
          colunas: ['Como aparece no Histórico', 'Por que espera', 'O que conferir'],
          linhas: [
            ['Shopee: confirme o link', 'Toda oferta da Shopee. O link curto não prova de quem é a conta de afiliado.', 'Abra o link e confira o produto.'],
            ['Desconto de 100%: confira o preço', 'A oferta aparece com 100% de desconto.', 'O preço. Costuma ser erro no catálogo.'],
            ['Preço antigo muito alto: confira o preço', 'O preço antigo é 10 vezes maior que o preço, ou mais.', 'Os dois preços.'],
            ['Não consegui gerar o link: confira a oferta', 'O link de afiliado daquele item não saiu.', 'A oferta. Ao enviar, o painel tenta de novo.'],
          ],
        } },
        { p: 'Uma oferta pode ter mais de um motivo: eles aparecem juntos, ligados por “e”. As ofertas na revisão contam nas “ofertas por envio” do disparo.' },
        { p: 'Cada disparo guarda no máximo 50 ofertas esperando. Acima disso, as novas esperam sem entrar na fila. O cartão mostra “Revisão cheia (50)” e o Histórico avisa a cada execução, até você revisar ou descartar algumas.' },
        { p: 'O número de ofertas para revisar aparece no cartão do disparo (“N para revisar”), no Histórico e no menu, só para o Dono.' },
        { nota: 'dica', texto: 'Nem tudo vai para a revisão. Se a extensão do Chrome estiver desligada, as ofertas do Mercado Livre esperam e saem sozinhas quando ela voltar. Sem a tag da Amazon, as da Amazon esperam com um aviso.' },
      ],
    },
    {
      id: 'revisar', titulo: 'Revisar e enviar', soDono: true,
      onde: '[[Histórico → Catálogo]]',
      blocos: [
        { passos: [
          'Abra [[Histórico]] e, em “Tipo”, escolha “Catálogo”. O quadro “Para revisar” mostra quantas esperam.',
          'Se quiser, em “Mostrar” escolha “Só o que está para revisar” e filtre por disparo.',
          'Na linha “Para revisar”, clique em **Revisar**.',
          'Clique em “Abrir o link da oferta” e confira o produto na outra aba.',
          'Corrija título, preços, cupom (até 100 caracteres), frete e foto, se precisar. A prévia usa o template do disparo.',
          'Clique em **Enviar para N grupos**, ou em **Descartar**.',
        ] },
        { p: 'Quando há outras ofertas esperando no mesmo disparo, aparece também **Enviar e ir para a próxima**. Ela envia esta e abre a seguinte, a mais antiga primeiro.' },
        { p: 'O envio usa a fila de envios, com as pausas de [[Ajustes]]. Precisa do WhatsApp conectado. No Mercado Livre, também da extensão on-line e da etiqueta. Na Amazon, da tag.' },
        { p: 'Aprovada, a oferta da Shopee sai com o link do próprio catálogo. As do Mercado Livre e da Amazon saem com o link refeito com a sua etiqueta ou tag, na hora do envio.' },
        { nota: 'aviso', texto: 'Só o Dono revisa. O Operador vê a lista, com o texto “Só o Dono revisa.” no lugar do botão, e o servidor recusa se ele tentar.' },
        { nota: 'dica', texto: 'Se outra pessoa já tratou a oferta, a tela avisa “Esta oferta já foi tratada.”, fecha e atualiza a lista.' },
      ],
    },
    {
      id: 'preco', titulo: 'Corrigir o preço', soDono: true,
      blocos: [
        { p: 'Não existe “enviar mesmo assim” com preço suspeito. O botão de enviar fica travado e a tela mostra: “Corrija o preço ou apague o preço antigo para enviar.”' },
        { tabela: {
          colunas: ['O que a tela mostra', 'O botão Enviar', 'O que fazer'],
          linhas: [
            ['Preço antigo 10 vezes maior que o preço, ou mais', 'Travado', 'Corrija os preços ou apague o preço antigo.'],
            ['Desconto de 100% que sai da conta dos dois preços', 'Travado', 'Corrija os preços ou apague o preço antigo.'],
            ['100% só informado pelo Etiqueta, sem preço antigo maior', 'Liberado depois da revisão', 'Confira o preço e envie. A mensagem sai sem desconto.'],
          ],
        } },
        { p: 'Sem preço antigo, a mensagem sai sem “de/por” e sem desconto. Se houver preço antigo, o desconto é calculado dos dois preços.' },
        { p: 'O “100%” que o Etiqueta informa nunca vai na mensagem. É comum na Shopee, que não traz preço antigo. O servidor confere a conta de novo com os valores que você enviou.' },
        { nota: 'dica', texto: 'O preço atual é obrigatório para enviar. Se o campo estiver vazio, a tela pede “Preencha o preço atual.”' },
      ],
    },
    {
      id: 'reenviar', titulo: 'Quando o envio falha', soDono: true,
      onde: '[[Histórico → Catálogo]]',
      blocos: [
        { p: 'Se o envio aprovado não chegar a **nenhum** grupo, a linha mostra “Erro ao enviar para N grupos” e o motivo de cada um. Ao lado aparece o botão **Enviar de novo**.' },
        { passos: [
          'Leia o motivo na linha. Os comuns: WhatsApp desconectado, extensão do Chrome fora do ar, tag ou etiqueta que faltam.',
          'Resolva a causa. Por exemplo, reconecte o WhatsApp em [[Números de WhatsApp]].',
          'Clique em **Enviar de novo**. Abre a mesma tela da revisão, sem o botão Descartar.',
          'Confira os dados e clique em **Enviar para N grupos**.',
        ] },
        { p: 'Se o envio chegou a pelo menos um grupo, a linha mostra o erro dos que falharam, mas não oferece reenvio. O Operador vê o erro por grupo, sem o botão.' },
      ],
    },
  ],
});
