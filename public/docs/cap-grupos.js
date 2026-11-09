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
    'Pegar o link de convite dos grupos e agrupá-los por nicho em blocos.',
    'Divulgar um endereço só que leva ao grupo com vaga.',
    'Deixar o painel propor um grupo novo quando um enche.',
    'Separar de qual grupo veio a venda com códigos de rastreio, importar as comissões e ver o ganho por grupo em Ganhos.',
  ],
  antes: ['[Primeiros passos](#docs/primeiros-passos/whatsapp): o WhatsApp conectado.'],
  abrir: [
    { rota: '#grupos', tela: 'Grupos' },
    { rota: '#blocos', tela: 'Blocos de análise' },
    { rota: '#links', tela: 'Rotacionador de Links' },
    { rota: '#ganhos', tela: 'Ganhos' },
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
          'Se quiser, escolha a “Etiqueta do Mercado Livre para o disparo (opcional)”: ela só vem marcada ao criar um disparo automático a partir do bloco e **não separa o ganho**. Para separar o ganho do nicho, use os códigos de rastreio ([veja a seção seguinte](#docs/grupos/rastreio)).',
          'Clique em **Salvar bloco**.',
          'Na [[Visão Geral]], clique no nome do bloco para ver só os números dele. No cartão do bloco, o botão “Ver na Visão Geral” faz o mesmo.',
          'Ao criar um disparo automático, use “Marcar um bloco…” para marcar todos os grupos e a etiqueta de uma vez.',
        ] },
        { nota: 'dica', texto: 'Um grupo pode estar em mais de um bloco. Excluir um bloco não apaga os grupos.' },
      ],
    },
    {
      id: 'rastreio', titulo: 'Rastreio por grupo: códigos nos links',
      onde: '[[Blocos de análise → Editar bloco → Códigos de rastreio (opcional)]]',
      blocos: [
        { p: 'Para saber de qual grupo veio uma venda, o link de cada grupo ou bloco pode sair com um **código de rastreio** diferente. **É opcional: sem configurar nada, os links saem como sempre saíram.** Só o Dono vê e muda os códigos.' },
        { tabela: {
          colunas: ['Loja', 'O código', 'Onde se cria', 'Cuidado'],
          linhas: [
            ['Mercado Livre', 'Uma etiqueta que já está em [[Conexões → Mercado Livre]].', 'No próprio painel, em “Etiquetas de afiliado”.', 'O painel não deixa apagar uma etiqueta que é código de rastreio. Se ela sumisse, o link sairia com a etiqueta padrão e a cobertura cairia.'],
            ['Amazon', 'Um ID de rastreamento, por exemplo `casa-20`.', 'No portal da Amazon, em “Gerenciar IDs de rastreamento”, **antes** de usar aqui.', 'O painel confere só o formato, não se o ID existe na sua conta. Confira a grafia: um ID errado gera link sem comissão. Não pode ser a tag padrão de [[Conexões → Amazon]].'],
            ['Shopee', 'Um Sub_id: só letras e números, até 30 caracteres.', 'No próprio campo “Sub_id da Shopee”.', 'Só existe por bloco, não por grupo. Veja o aviso abaixo.'],
          ],
        } },
        { passos: [
          'Abra [[Blocos de análise]], clique em **Novo bloco** (ou em **Editar** num bloco que já existe) e abra o quadro “Códigos de rastreio (opcional)”.',
          'Escolha a “Etiqueta do Mercado Livre”, escreva o “ID de rastreamento da Amazon” e o “Sub_id da Shopee”. Deixe vazio o que não quiser separar.',
          'Clique em **Salvar bloco**. O cartão do bloco passa a mostrar “Rastreio:” com os códigos.',
          'Para uma exceção, abra [[Grupos]], olhe a coluna “Rastreio”, clique em **Definir** (ou **Editar**) na linha do grupo, escolha os códigos dele e clique em **Salvar rastreio**. A coluna mostra “Padrão” ou “Do bloco” enquanto o grupo não tem código próprio. O código do grupo vence o do bloco.',
        ] },
        { p: '**Quem vence:** o código do grupo, depois o do bloco, depois o padrão de hoje. Se o grupo está em vários blocos com código, vale o bloco mais antigo (o de menor id). Um código pertence a um só grupo ou bloco: o painel recusa o mesmo código em dois lugares.' },
        { p: 'A associação **vence a etiqueta escolhida** no [[Disparo manual]] e nos disparos automáticos: o grupo que tem etiqueta de rastreio recebe o link com ela, mesmo que o disparo tenha outra etiqueta. Já a “Etiqueta do Mercado Livre para o disparo” do bloco não separa o ganho.' },
        { nota: 'aviso', texto: 'Shopee: o Sub_id vale por bloco porque cada Sub_id é um pedido de link a mais e conta no teto de 60 links por hora pela extensão. Cada envio aceita até 10 Sub_ids por envio; o que passar disso sai com o link base, sem Sub_id. O Sub_id sai pela API de afiliados da Shopee ou pela extensão (versão 1.4.1 ou mais nova; depois de atualizar, recarregue a extensão em `chrome://extensions`). Cada Sub_id gasta uma vaga do teto de 60 links por hora da extensão. Se a extensão for antiga, o envio para de pedir Sub_id já no primeiro pedido. O painel também guarda vagas do limite de 60 links por hora para o link normal: quando sobram poucas, o link sai sem Sub_id. Quando não entra, o link sai sem Sub_id e a falta aparece na cobertura. Todo envio da Shopee pede o Sub_id: o [[Disparo manual]], a revisão do catálogo e os links de um remetente.' },
        { nota: 'dica', texto: 'Equipe: o Operador não vê nem muda códigos, não apaga um bloco que tem código ou gasto com anúncio e não troca os grupos dele (o painel diz que só o Dono pode). Ninguém apaga uma etiqueta que é código: tire a associação antes.' },
        { p: 'O histórico do rastreio fica guardado por 400 dias, um prazo só dele. Ali ficam o grupo, o link e o código de cada envio, sem nome nem telefone de ninguém. O prazo não muda com “Guardar por (dias)” de Ajustes, nem quando ele é 0 (para sempre) ou menor que 400, e vai no backup junto com o banco.' },
      ],
    },
    {
      id: 'ganhos', titulo: 'Página Ganhos: o dashboard e a cobertura',
      onde: '[[Ganhos]]',
      leia: 'grupos/rastreio',
      blocos: [
        { p: 'A página Ganhos (só o Dono vê; fica logo abaixo de Visão Geral, no grupo Principal do menu) mostra quanto cada grupo, bloco, loja e oferta rendeu, a partir das comissões que você importa dos portais ([veja como importar](#docs/grupos/importar)), e se os links saíram com o código de rastreio. Os números só são tão completos quanto o rastreio e as importações.' },
        { passos: [
          'Abra [[Ganhos]] e escolha o período: 7 dias, 30 dias, Mês atual, Mês passado ou Personalizado.',
          'Se quiser, filtre por bloco (“Todos os grupos” volta ao geral) e por loja.',
          'Leia o quadro “Cobertura do rastreio”, os cartões e as tabelas “Por grupo”, “Por bloco”, “Por loja”, “Por oferta” e “Por dia”. Em “Por grupo”, clique no título de uma coluna para ordenar.',
        ] },
        { tabela: {
          colunas: ['Cartão', 'O que é'],
          linhas: [
            ['Comissão', 'Soma das comissões importadas no período, pela data da venda, sem as canceladas. “Confirmada” é só a que o portal já confirmou.'],
            ['Valor vendido', 'Soma do valor das compras: o que os clientes pagaram, não o que você ganha.'],
            ['Vendas (itens)', 'Itens vendidos nas linhas importadas.'],
            ['Cliques', 'Cliques que o **relatório de cliques da loja** informa. Você importa esse relatório; o painel não conta o clique nos links de oferta.'],
            ['Ganho por clique', 'Comissão dividida pelos cliques, só nas lojas que têm cliques importados no período. Em reais por clique.'],
            ['Conversão', 'Vendas divididas pelos cliques, nas mesmas lojas.'],
            ['Envios', 'Links de oferta que o Turbo enviou aos grupos no período.'],
            ['Comissão com grupo', 'Quanto da comissão deu para ligar a um grupo ou bloco pelo código de rastreio. O resto entra no total, mas sem grupo.'],
            ['Gasto', 'O que você informou de anúncio, repartido igualmente pelos dias do período.'],
            ['Entradas', 'Pessoas que entraram nos grupos no período, pelo histórico dos grupos.'],
            ['Custo por membro novo', 'Gasto dividido pelas entradas do mesmo período. Só existe para quem tem gasto próprio, um grupo ou um bloco.'],
            ['Retorno', 'Comissão menos gasto. “Deu lucro” ou “Deu prejuízo”. Não é calculado com filtro de loja.'],
          ],
        } },
        { p: 'Onde o número não existe, a tela mostra “—”: sem cliques importados não há ganho por clique nem conversão; sem gasto, não há custo por membro novo nem retorno. “—” não é zero. Enquanto você não importou nada, os cartões de dinheiro dizem “Importe o relatório para ver”.' },
        { nota: 'aviso', texto: 'Cliques e ganho por clique vêm do relatório da loja, não do Rotacionador de Links: o link de afiliado vai direto para a loja e o Turbo não vê o clique. Sem importar o relatório de cliques, esses cartões ficam em “—”.' },
        { tabela: {
          colunas: ['Número', 'O que é'],
          linhas: [
            ['Cobertura', 'Dos links que tinham código configurado, quantos saíram com ele. Boa: 90% ou mais. Parcial: de 60% a 89%. Baixa: abaixo de 60%.'],
            ['Alcance', 'Em quantos envios havia código configurado. Os outros saíram com o código padrão de cada loja, como sempre.'],
            ['Atenção', 'Aviso de uma loja cuja cobertura ficou abaixo de 80%. O aviso traz um link para [[Blocos de análise]].'],
          ],
        } },
        { p: 'Cobertura abaixo de 100% quer dizer que algum link saiu sem o código: o Sub_id foi recusado, bateu no limite de pedidos da Shopee ou a etiqueta falhou. Sem o código, a venda entra no total da loja, mas não dá para saber de qual grupo veio: ela aparece em “Sem grupo identificado”, na tabela “Por grupo”.' },
        { nota: 'dica', texto: '“Nenhum envio do período esperava código de rastreio” não é erro: significa que nenhum grupo ou bloco tem código associado.' },
        { p: '**Período anterior.** Em cada cartão que tem variação, a tela mostra o valor dos **mesmos N dias logo antes** do período escolhido, com os mesmos filtros, e a mudança em porcentagem, com a palavra (“+300%, mais”). A variação aparece em Comissão, Valor vendido, Vendas, Cliques, Ganho por clique, Conversão, Envios e Entradas. Quando o período anterior deu zero, não há como comparar: aparece só o valor dele, sem porcentagem.' },
        { p: '**Por grupo e por oferta.** Clique no **nome de um grupo** na tabela “Por grupo”: a tabela “Por oferta” passa a mostrar só as ofertas daquele grupo. “Ver todas as ofertas” volta ao geral. A venda que foi atribuída ao bloco inteiro não entra nesse filtro, porque ela não se divide entre os grupos. O filtro some quando você troca período, bloco ou loja.' },
        { p: '**Link da oferta.** O nome do produto em “Por oferta” abre a **página do produto na loja, sem o seu link de afiliado**, em outra aba. Serve para conferir preço e estoque. Quem entra por esse link não gera comissão para você: não divulgue ele. Oferta sem produto reconhecido não tem link.' },
        { p: '**Endereço da página.** Os filtros ficam no endereço, por exemplo `#ganhos?periodo=30d&bloco=3&loja=shopee` (com `periodo=custom`, também `de=` e `ate=`, em AAAA-MM-DD). Você pode salvar nos favoritos ou mandar para a equipe. No cartão de cada bloco, em [[Blocos de análise]], o atalho **Ver ganhos** abre a página já filtrada por ele.' },
      ],
    },
    {
      id: 'importar', titulo: 'Importar comissões e informar o gasto',
      onde: '[[Ganhos → Importar comissões]] e [[Ganhos → Gasto com anúncios]]',
      leia: 'grupos/ganhos',
      blocos: [
        { p: 'O Turbo não lê as suas comissões sozinho: você baixa o relatório no portal de cada loja, em **CSV**, e importa na página Ganhos. Só o Dono importa. O arquivo vai até 5 MB e até 100.000 linhas; para mais que isso, baixe um período menor (um mês por vez). Vale o CSV, ou o .zip da Amazon como veio (não precisa abrir). Arquivo do Excel (.xlsx) não vale: abra no Excel e salve como CSV.' },
        { p: 'O campo **“Data do relatório”** aparece só quando o arquivo não tem data em cada linha, ou seja, é um total do período (como o relatório “ID de rastreamento” da Amazon). Todas as linhas entram no dia que você escolher: escolha sempre o último dia do período do relatório. Em relatório com data por linha, o campo não aparece. Se o relatório tiver uma coluna de data que o painel não reconhece, o painel não pede a “Data do relatório”: ele avisa que não reconheceu a coluna.' },
        { tabela: {
          colunas: ['Loja', 'Que relatório baixar', 'Como o painel liga a venda ao grupo'],
          linhas: [
            ['Shopee', 'O relatório de vendas do portal Shopee Afiliados.', 'Pela coluna do Sub_id (“Sub_id1”), que é o código de rastreio do bloco.'],
            ['Amazon', 'O relatório de ganhos da Central de Associados (veja como baixar abaixo).', 'Pelo ID de rastreamento do relatório. Se o relatório já veio filtrado por um ID, use o campo “Código do arquivo”.'],
            ['Mercado Livre', 'Ainda sem relatório para importar (veja abaixo).', 'A venda na tela não traz a etiqueta; use o campo “Código do arquivo” se um dia houver arquivo.'],
          ],
        } },
        { nota: 'aviso', texto: 'Os nomes exatos dos menus mudam nos portais. Só a Amazon foi conferida com um arquivo real; Shopee e Mercado Livre ainda não. Se a prévia disser que não achou uma coluna, o painel não grava nada: confira o arquivo e peça ajuste da lista de colunas com o cabeçalho do seu arquivo (sem dados de comprador).' },
        { p: '**Como baixar cada relatório** (o caminho que foi visto em 05/11/2026; os menus dos portais mudam).' },
        { tabela: {
          colunas: ['Loja', 'Onde e o que baixar', 'Como importar'],
          linhas: [
            ['Amazon', 'Central de Associados: Relatórios → Fazer download de relatórios. Escolha o período, o ID de rastreamento (“Tudo” ou um deles) e o formato CSV. O arquivo vem num .zip.', 'Importe o .zip como veio, sem abrir. Veja os dois relatórios logo abaixo.'],
            ['Shopee', 'Shopee Afiliados: “Relatório de vendas” (comissões) e “Relatório de cliques” (uma linha por clique), com o botão “Exportar”.', 'Importe o CSV. O formato do arquivo exportado ainda não foi conferido com um arquivo real, porque a conta de teste não tinha vendas.'],
            ['Mercado Livre', 'Central de afiliados: a página de métricas mostra as vendas na tela, mas não foi achado botão de exportar, e a venda na tela não diz de qual etiqueta veio.', 'Hoje não dá para importar do Mercado Livre por arquivo.'],
          ],
        } },
        { p: '**Amazon, “Produto relacionado”**, filtrado por **um** ID de rastreamento: traz comissões **e** cliques. Importe o mesmo arquivo como “Comissões” e como “Cliques”, com o **mesmo** “Código do arquivo” (o ID do filtro). Sem filtro, o relatório não diz de qual ID veio cada linha. Linha sem venda, só com cliques, não entra como venda nas comissões: os cliques entram quando você importa o mesmo arquivo como “Cliques”.' },
        { p: '**Amazon, “ID de rastreamento”**: um total do período por ID, sem data em cada linha. Importe com o campo “Data do relatório”: todas as linhas entram no dia escolhido. Use sempre o último dia do período e não importe períodos que se sobrepõem (por exemplo 01–15/10 e depois 01–31/10), porque o total contaria duas vezes.' },
        { nota: 'aviso', texto: 'Não importe os dois relatórios da Amazon como comissões: a venda contaria em dobro. Escolha um deles.' },
        { passos: [
          'Abra [[Ganhos]] e clique em **Importar comissões**.',
          'Escolha a **Loja**. Em “O arquivo traz”, deixe **Comissões (vendas)**, ou escolha **Cliques** se for o relatório de cliques da loja.',
          'Se o relatório já veio filtrado por um código (uma etiqueta, um ID de rastreamento ou um Sub_id), digite-o em “Código do arquivo (opcional)”: ele vale para as linhas que não têm coluna de código. Ao baixar de novo o mesmo período, importe com o mesmo código: o mesmo arquivo importado uma vez com código e outra sem código conta as vendas em dobro (a conferência mostra essas linhas como novas antes de gravar).',
          'Escolha o arquivo e clique em **Conferir arquivo**. Nada é gravado ainda.',
          'Na prévia, veja quantas linhas são novas, quantas já estavam importadas, o período, a comissão e as colunas lidas e ignoradas. Se estiver certo, clique em **Importar agora**; senão, em **Voltar**.',
          'Clique em **Ver em Ganhos**: a página já mostra os números novos.',
        ] },
        { tabela: {
          colunas: ['Na prévia', 'O que quer dizer'],
          linhas: [
            ['Novas', 'Linhas que ainda não estavam no painel.'],
            ['Já importadas', 'Linhas iguais a outras já importadas. São ignoradas, não somam duas vezes: dá para importar o mesmo período de novo.'],
            ['Atualizadas', 'Linhas que já estavam e mudaram, por exemplo uma venda que era pendente e virou confirmada. Não duplicam.'],
            ['Puladas', 'Linhas com valor ou data inválidos. A prévia diz só o número da linha, nunca o conteúdo.'],
            ['Sem código ou código de ninguém', 'A venda não traz código de rastreio, ou o código não é de nenhum grupo seu. Entra no total, mas em nenhum grupo.'],
          ],
        } },
        { p: 'A prévia também pode trazer dois **avisos**. Nenhum bloqueia a importação: quem decide é você.' },
        { tabela: {
          colunas: ['Aviso', 'O que fazer'],
          linhas: [
            ['“Linhas têm a mesma data e produto de vendas já importadas com outro código (ou sem código)”', 'Se for o mesmo relatório importado de novo, não importe: a venda contaria em dobro. Se for de outro grupo, pode importar.'],
            ['“Linhas importadas antes sem código vão receber o código deste arquivo”', 'Se eram de outro grupo, não importe: apague a importação antiga em “Importações recentes” e importe os dois arquivos de novo, cada um com o seu código.'],
          ],
        } },
        { p: 'Depois de gravar, o resumo repete o aviso no passado (“receberam o código deste arquivo”). Se era engano, apague a importação em “Importações recentes”.' },
        { p: 'Cliques funcionam diferente: o relatório traz o total por dia e por código, e importar de novo **substitui** o número daquele dia (não soma). A lista “Importações recentes”, no fim da página, mostra data, loja, tipo e contagens de cada arquivo; **Apagar** tira só as linhas que aquela importação trouxe.' },
        { p: '**Privacidade:** o painel não lê nem guarda nome, endereço, telefone, e-mail ou documento de comprador, mesmo que o arquivo traga essas colunas (a prévia lista só os nomes das colunas ignoradas). Fica só data, código de rastreio, produto, título, quantidade, valor, comissão e status; o número do pedido só entra como um código embaralhado com uma chave que só existe no seu computador (não dá para voltar ao número), para não contar a mesma linha duas vezes. O arquivo em si não é guardado.' },
        { p: '**Gasto com anúncios:** clique em **Gasto com anúncios**, escolha o período (de até 366 dias), para qual bloco ou grupo o gasto vale, o valor em reais (como `1.234,50`) e, se quiser, uma observação de até 200 caracteres, e clique em **Salvar gasto**. O valor é repartido igualmente pelos dias do período, e o custo por membro novo é o gasto dividido pelas entradas do mesmo período. Não há edição: para corrigir, use **Excluir** e lance de novo. Se já existe gasto para o mesmo destino e período, o painel avisa mas grava; apague o anterior se for o mesmo anúncio.' },
        { nota: 'dica', texto: 'O custo por membro novo de um grupo só aparece se o gasto foi lançado para o próprio grupo, e o do bloco, para o bloco: um gasto de bloco não se divide entre os grupos dele, e o gasto de um grupo não entra no bloco. Cada gasto conta só no próprio alvo.' },
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
            ['a Central de Afiliados do Mercado Livre não respondeu a tempo… (ou o portal de afiliados da Shopee)', 'Em geral, nada: a extensão recarrega a aba e o próximo pedido tenta de novo. Se repetir, abra a aba da Central (ou do portal) no Chrome e veja se a página carrega.'],
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
          'Em “Avisos”, marque “Grupo lotando” e “Erro de disparo” (o backup atrasado também chega por este), e clique em **Salvar número**.',
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
            ['Backup atrasado', 'Usa o mesmo canal do “Erro de disparo”: vai aos números com esse aviso marcado. Sai quando o último backup que deu certo, no computador ou no Google Drive, tem mais de 26 h. No máximo 1 por dia, e nunca na primeira hora depois de o programa ligar. Veja [Backup automático e cópia no Google Drive](#docs/manutencao/backup-auto).'],
          ],
        } },
        { nota: 'erro', texto: '“O resumo chegou quase vazio.” Você usou o mesmo horário no resumo e na virada do dia. O resumo conta da virada até o horário dele, então sai com o dia zerado. Mude um dos dois.' },
        { nota: 'dica', texto: 'O número aparece mascarado na tela e fica só no seu computador. O cadastro aceita no máximo 10 números a cada 10 minutos, e o nome do destino não pode conter telefone.' },
      ],
    },
  ],
});
