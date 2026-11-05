// Docs do sistema: capítulos 9 (Grupos, blocos e rotacionador) e 10 (Resultados e avisos).
// Só chama docsCapitulo (public/docs.js): nenhuma declaração no topo, porque o escopo global é o mesmo dos outros
// scripts do painel. Formato dos blocos e mini-marcação: comentário de docsInline e plano docs-do-sistema.
// Slugs da spec (docs/produto/specs/docs-do-sistema.md, seção 1): pode acrescentar seção, nunca renomear nem tirar.
// Fontes do texto: README ("Visão Geral, blocos e rotacionador", "Relatórios e avisos"), src/rotador.js, src/avisos.js e
// os rótulos de public/paineis.js, public/relatorios.js e public/app.js. Número novo aqui entra na FATOS.

docsCapitulo({
  id: 'grupos',
  titulo: 'Grupos, blocos e rotacionador',
  aprenda: [
    'Pegar o link de convite dos grupos.',
    'Agrupar grupos por nicho em blocos.',
    'Divulgar um endereço só que leva ao grupo com vaga.',
    'Deixar o painel propor um grupo novo quando um enche.',
  ],
  antes: ['[Primeiros passos](#docs/primeiros-passos/whatsapp): o WhatsApp conectado.'],
  abrir: [
    { rota: '#grupos', tela: 'Grupos' },
    { rota: '#blocos', tela: 'Blocos de análise' },
    { rota: '#links', tela: 'Rotacionador de Links' },
  ],
  secoes: [
    {
      id: 'convites', titulo: 'Grupos e convites',
      onde: '[[Grupos]]',
      blocos: [
        { p: 'A página mostra os grupos do número conectado, com membros, blocos e o link de convite. O rotacionador só usa grupos que têm convite.' },
        { passos: [
          'Abra [[Grupos]] e clique em **Atualizar lista de grupos** depois de entrar em grupos novos.',
          'Na coluna “Convite”, clique em **Buscar convite**. Funciona quando o seu número é admin do grupo (aparece a marca “admin”).',
          'Se não for admin, peça o link a um admin, cole no campo e clique em **Salvar**.',
          'Para guardar de novo um convite que mudou, clique em **Atualizar** na linha do grupo.',
        ] },
        { nota: 'dica', texto: 'Sem o WhatsApp conectado, o botão “Atualizar lista de grupos” não aparece e a página pede para conectar em [[Números de WhatsApp]].' },
      ],
    },
    {
      id: 'blocos', titulo: 'Blocos de análise',
      onde: '[[Blocos de análise]]',
      blocos: [
        { p: 'Bloco é um conjunto de grupos de um nicho (Casa, Beleza, Tech…). Serve para ver os números de cada nicho separados e para marcar vários grupos de uma vez num disparo.' },
        { passos: [
          'Abra [[Blocos de análise]] e clique em **Novo bloco**.',
          'Dê um “Nome do bloco” e marque os grupos daquele nicho em “Grupos do bloco”.',
          'Se quiser separar o ganho na Central, escolha a “Etiqueta do Mercado Livre (opcional)” do nicho.',
          'Clique em **Salvar bloco**.',
          'Na [[Visão Geral]], clique no nome do bloco para ver só os números dele. No cartão do bloco, o botão “Ver na Visão Geral” faz o mesmo.',
          'Ao criar um disparo automático, use “Marcar um bloco…” para marcar todos os grupos e a etiqueta de uma vez.',
        ] },
        { nota: 'dica', texto: 'Um grupo pode estar em mais de um bloco. Excluir um bloco não apaga os grupos.' },
      ],
    },
    {
      id: 'rotacionador', titulo: 'Rotacionador de links',
      onde: '[[Rotacionador de Links]]',
      blocos: [
        { p: 'O rotacionador dá a você um endereço só para divulgar (`…/g/nome`). Quem clica cai no primeiro grupo da lista que ainda tem vaga. Quando ele enche, o clique passa ao próximo.' },
        { passos: [
          'Em [[Grupos]], garanta que cada grupo tem convite.',
          'Abra [[Rotacionador de Links]] e clique em **Novo link**.',
          'Escolha o “Nome” e o “Endereço do link”. Em “Grupos, em ordem”, clique nos grupos na ordem em que devem encher. Use ↑ e ↓ para reordenar.',
          'Escolha “Como distribuir os cliques” (tabela abaixo) e o “Limite de membros por grupo”.',
          'Se quiser, preencha a “URL reserva (quando todos lotarem)”: para onde vai quem clicar quando não houver vaga.',
          'Clique em **Salvar link**, copie o endereço com **Copiar** e divulgue. Os cliques aparecem no funil da [[Visão Geral]].',
        ] },
        { tabela: {
          colunas: ['Modo', 'Como se comporta'],
          linhas: [
            ['Encher um grupo por vez', 'O primeiro grupo enche, depois o segundo, e assim por diante.'],
            ['Alternar entre grupos com vaga', 'Divide os cliques entre os 3 primeiros grupos com vaga.'],
            ['Encher e reabrir quando esvaziar', 'Enche um por vez. O que lotou só volta quando cair para o número de membros que você escolher em “Reabrir quando cair para (membros)”.'],
          ],
        } },
        { p: 'O limite máximo do WhatsApp é 1.024 membros por grupo. O limite padrão dos links novos vem de [[Relatórios e avisos]].' },
        { nota: 'aviso', texto: 'No seu computador o endereço só abre para você. Para o público clicar, o programa precisa estar publicado na internet.' },
        { nota: 'erro', texto: '“Nenhum grupo escolhido tem convite.” O painel recusa o link. Volte em [[Grupos]], busque ou cole o convite e tente de novo.' },
      ],
    },
    {
      id: 'proximo-grupo', titulo: 'Próximo grupo com confirmação',
      onde: '[[Rotacionador de Links → Novo link]]',
      leia: 'resultados/avisos',
      blocos: [
        { p: 'Ligue “Criar próximo grupo (com a sua confirmação)” no link. Quando um grupo chega a 95% do limite, o painel propõe um grupo novo igual a ele: nome com o número seguinte, descrição, foto, permissões e admins.' },
        { passos: [
          'Quando houver proposta, o quadro “Próximo grupo” aparece no topo do [[Rotacionador de Links]].',
          'Confira ou mude o nome do grupo novo.',
          'Clique em **Criar agora** e confirme. Ou clique em **Ignorar**.',
        ] },
        { p: 'Nada é criado até você clicar. O grupo novo entra no link logo depois do que lotou, nos mesmos blocos e nos mesmos disparos automáticos.' },
        { nota: 'aviso', texto: 'Criar grupos é a ação que mais chama a atenção do WhatsApp. Evite criar vários no mesmo dia.' },
        { nota: 'dica', texto: 'Alguns admins podem não ser adicionados por causa da privacidade deles no WhatsApp. O painel avisa quantos faltaram: mande o convite a eles.' },
      ],
    },
  ],
});

docsCapitulo({
  id: 'resultados',
  titulo: 'Resultados e avisos',
  aprenda: [
    'Ler o funil, o alcance e a evasão na Visão Geral.',
    'Achar no Histórico o que saiu e o que falhou.',
    'Receber o resumo diário e os avisos pelo WhatsApp.',
  ],
  antes: ['[Grupos, blocos e rotacionador](#docs/grupos): grupos e, se quiser números por nicho, blocos.'],
  abrir: [
    { rota: '#visao', tela: 'Visão Geral' },
    { rota: '#historico', tela: 'Histórico' },
    { rota: '#relatorios', tela: 'Relatórios e avisos' },
  ],
  secoes: [
    {
      id: 'visao', titulo: 'Visão Geral',
      onde: '[[Visão Geral]]',
      blocos: [
        { p: 'A Visão Geral mostra o que acontece nos seus grupos: cliques nos links, entradas, saídas, quem leu as suas mensagens e a evasão.' },
        { passos: [
          'Escolha o período: Hoje, Ontem, 7 dias, 30 dias, Mês atual ou Mês passado.',
          'Se quiser, clique em um bloco para ver só os grupos dele. “Todos os grupos” volta ao geral.',
          'Leia o funil: “Cliques nos links”, “Entradas” e “Saídas”.',
          'Veja “Abriram o grupo” e “Tempo médio no grupo”.',
          'Confira a “Evasão do tráfego” e a tabela “Por grupo”.',
        ] },
        { tabela: {
          colunas: ['Número', 'O que é'],
          linhas: [
            ['Cliques nos links', 'Cliques nos links do rotacionador. Abaixo, a parte que virou entrada.'],
            ['Entradas', '“Pelo link” é quem entrou sozinho pelo convite. “Adicionados” é quem um admin colocou.'],
            ['Saídas', 'Quem saiu no período. O saldo é entradas menos saídas.'],
            ['Abriram o grupo', 'Pessoas diferentes que leram alguma mensagem sua. É o seu alcance real.'],
            ['Tempo médio no grupo', 'Quanto tempo, em média, quem saiu ficou no grupo.'],
            ['Evasão', 'Quem entrou e saiu: no mesmo dia, em até 7 dias, ontem e no total do período.'],
          ],
        } },
        { p: 'Evasão alta no mesmo dia costuma indicar expectativa errada no convite: o que a pessoa leu antes de entrar não bate com o grupo.' },
        { nota: 'aviso', texto: 'Os números começam a contar quando o programa está conectado ao WhatsApp. Não há histórico de antes disso.' },
      ],
    },
    {
      id: 'historico', titulo: 'Histórico',
      onde: '[[Histórico]]',
      blocos: [
        { p: 'O Histórico registra tudo o que saiu e tudo o que deu errado, com o motivo. A lista se atualiza sozinha.' },
        { passos: [
          'Abra [[Histórico]]. Em “Tipo”, escolha o que quer ver: Tudo, Disparo automático, Espelhamento, Catálogo ou Remetente.',
          'Para achar um problema, troque o filtro de “Tudo” para “Só erros”. Também há “Só enviados” e “Só avisos”.',
          'Leia a coluna “Resultado”: ela diz o que aconteceu com cada oferta.',
        ] },
        { p: 'O tipo Espelhamento lista cada oferta espelhada, com o motivo de ter sido descartada ou de estar na fila. O tipo Catálogo mostra o que passou pelo catálogo e o que espera revisão. O tipo Remetente mostra cada link que um remetente mandou e o que aconteceu com ele. Veja [Espelhar ofertas da Amazon](#docs/espelhamento/fila), [Revisão de ofertas](#docs/revisao/motivos) e [Receber links de um remetente](#docs/disparo-automatico/remetentes).' },
        { p: 'As rotinas do [Grupo vivo](#docs/mensagens/grupo-vivo) aparecem como “Grupo vivo: nome da rotina” e só em “Tudo”: não há tipo próprio para elas. Os avisos dos horários marcados de um disparo automático aparecem em “Tudo” e em “Disparo automático”.' },
        { tabela: {
          colunas: ['Mensagem no Histórico', 'O que fazer'],
          linhas: [
            ['WhatsApp desconectado: nada foi enviado.', 'Reconecte o número em [[Números de WhatsApp]].'],
            ['a extensão do Chrome não está conectada…', 'Abra o Chrome com a extensão instalada e logado na Central de Afiliados.'],
            ['não há sessão de afiliado neste Chrome…', 'Entre na sua conta da Central de Afiliados do Mercado Livre, no mesmo Chrome da extensão.'],
            ['perdeu o horário: passou mais de 2 h…', 'O envio agendado não saiu porque o WhatsApp ou o programa ficou fora. Agende de novo.'],
            ['Horário 10:00 pulado: … (disparo) ou Horário de 05/11 10:00 pulado: … (rotina do Grupo vivo)', 'Um horário marcado atrasou mais de 30 min e não saiu. O próximo sai normalmente. Veja [O que acontece na hora marcada](#docs/disparo-automatico/na-hora-marcada).'],
            ['8 horários pulados (09:00 de 03/11 a 13:00): … (disparo) ou 7 horários pulados, o último de 05/11 08:00: … (rotina do Grupo vivo)', 'Vários horários passaram sem sair, por exemplo com o programa dias desligado: o Histórico traz um aviso só. O de um disparo diz o primeiro e o último horário pulados; o de uma rotina, o último.'],
          ],
        } },
        { nota: 'dica', texto: 'Avisos não travam o envio. Uma fonte que falhou, por exemplo, vira aviso, e as outras fontes do disparo seguem normalmente.' },
      ],
    },
    {
      id: 'avisos', titulo: 'Relatórios e avisos',
      onde: '[[Relatórios e avisos]]',
      blocos: [
        { p: 'Aqui você escolhe quem recebe, pelo WhatsApp, o resumo diário e os avisos do programa.' },
        { passos: [
          'Abra [[Relatórios e avisos]] e clique em **Adicionar número**.',
          'Escreva o “Nome” e o “Número”, com DDD. O painel confere se o número existe no WhatsApp.',
          'Marque “Recebe o resumo diário” e escolha “Todos os grupos” ou “Só os blocos marcados:”.',
          'Em “Avisos”, marque “Grupo lotando” e “Erro de disparo”, e clique em **Salvar número**.',
          'Em “Configurações gerais”, defina o “Horário do resumo diário” (padrão 21:00), a “Virada do dia” e o “Limite padrão por grupo”. Clique em **Salvar configurações**.',
          'Para testar, use a prévia e **Enviar resumo agora**.',
        ] },
        { tabela: {
          colunas: ['Item', 'Como funciona'],
          linhas: [
            ['Resumo diário', 'Sai uma vez por dia, no horário do resumo, com os números do dia. Se o programa estava desligado, sai atrasado, desde que ainda seja o mesmo dia.'],
            ['Virada do dia', 'Diz a que horas um dia termina nos relatórios (padrão 00:00). Com virada às 02:00, uma entrada às 01:30 conta no dia anterior.'],
            ['Limite padrão por grupo', 'Só preenche o limite dos links novos do rotacionador (padrão 1.000). Os links que já existem não mudam.'],
            ['Grupo lotando', 'Avisa quando um grupo de um link ativo chega a 95% do limite do link. Avisa uma vez por grupo, até ele cair abaixo de 90%.'],
            ['Erro de disparo', 'Uma mensagem com os erros novos, no máximo 1 a cada 30 minutos. Só sai com o WhatsApp conectado: se ele caiu, o aviso chega quando voltar.'],
          ],
        } },
        { nota: 'erro', texto: '“O resumo chegou quase vazio.” Você usou o mesmo horário no resumo e na virada do dia. O resumo conta da virada até o horário dele, então sai com o dia zerado. Mude um dos dois.' },
        { nota: 'dica', texto: 'O número aparece mascarado na tela e fica só no seu computador. O cadastro aceita no máximo 10 números a cada 10 minutos, e o nome do destino não pode conter telefone.' },
      ],
    },
  ],
});
