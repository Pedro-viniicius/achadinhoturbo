// Docs do sistema: capítulos 11 (Equipe e papéis), 12 (Privacidade e segurança) e 13 (Manutenção).
// Só chama docsCapitulo (public/docs.js): nenhuma declaração no topo, porque o escopo global é o mesmo dos outros
// scripts do painel. Formato dos blocos e mini-marcação: comentário de docsInline e plano docs-do-sistema.
// Slugs da spec (docs/produto/specs/docs-do-sistema.md, seção 1): pode acrescentar seção, nunca renomear nem tirar.
// Nada de segredo, token nem ID real aqui: exemplos usam 98765432101 e seunome-20. A pasta da sessão do WhatsApp
// só é citada como pasta a proteger.
// Fontes: README (Equipe, Backup, Privacidade (LGPD), Cuidados), scripts/backup.js, public/equipe.js, public/app.js.

docsCapitulo({
  id: 'equipe',
  titulo: 'Equipe e papéis',
  aprenda: [
    'A diferença entre Dono e Operador.',
    'Convidar alguém sem passar a sua senha.',
    'Mudar o papel ou tirar o acesso de uma pessoa.',
  ],
  antes: ['O painel precisa ter login ligado. Se ainda não tem, veja [Abrir o painel e entrar](#docs/primeiros-passos/entrar).'],
  secoes: [
    {
      id: 'papeis', titulo: 'Dono e Operador',
      onde: '[[Equipe]]',
      blocos: [
        { p: 'Cada pessoa entra no painel com o próprio e-mail e a própria senha. Você nunca passa a sua. O **Operador** usa o dia a dia; o **Dono** faz tudo, inclusive mexer na equipe.' },
        { tabela: {
          colunas: ['O que se faz', 'Operador', 'Dono'],
          linhas: [
            ['Disparos, grupos, Histórico, Relatórios e o resto do dia a dia', 'Sim', 'Sim'],
            ['Ver a tela Equipe, convidar, remover pessoas e mudar papéis', 'Não', 'Sim'],
            ['Salvar e testar Conexões, e ver quais segredos estão salvos', 'Não', 'Sim'],
            ['Gerar novo token da extensão', 'Não', 'Sim'],
            ['Desconectar o WhatsApp', 'Não', 'Sim'],
            ['Apagar dados antigos em Ajustes', 'Não', 'Sim'],
            ['Revisar e enviar ofertas do Catálogo', 'Não (só vê a lista)', 'Sim'],
          ],
        } },
        { p: 'O servidor confere o papel a cada pedido: quando você troca o papel de alguém, vale na hora. Ninguém muda o próprio papel nem remove a si mesmo, e a equipe sempre fica com pelo menos um Dono.' },
        { nota: 'dica', texto: 'Este capítulo aparece para o Operador também, para ele saber o que existe. As ações marcadas “Só o Dono” ele não consegue fazer: o painel as esconde e o servidor as recusa.' },
      ],
    },
    {
      id: 'convidar', titulo: 'Convidar alguém', soDono: true,
      onde: '[[Equipe → Convidar pessoa]]',
      blocos: [
        { passos: [
          'Em “Convidar pessoa”, digite o e-mail, escolha o papel (Operador ou Dono) e clique em “Criar convite”.',
          'Copie o link e mande pelo WhatsApp. Não enviamos e-mail.',
          'A pessoa abre o link, escreve o nome e cria a senha. Depois disso, ela entra com o e-mail e essa senha.',
        ] },
        { nota: 'dica', texto: 'O convite vale 7 dias e só pode ser usado uma vez. O link só aparece completo na hora em que é criado. Depois, “Copiar link” na lista gera um link novo e o anterior para de funcionar.' },
        { p: 'Se a pessoa disser que o link não abre, a mensagem é sempre a mesma, seja o convite vencido, usado ou cancelado: “Este convite não vale mais”. Gere um link novo com “Copiar link”, ou crie outro convite.' },
        { p: 'Convite que não vai mais ser usado: “Cancelar convite”, na lista “Convites pendentes”. O link deixa de funcionar na hora.' },
      ],
    },
    {
      id: 'gerir', titulo: 'Remover e mudar papel', soDono: true,
      onde: '[[Equipe → Pessoas]]',
      blocos: [
        { p: 'Na lista “Pessoas”, cada linha tem os botões “Tornar Dono” ou “Tornar Operador” e “Remover da equipe”. Remover encerra as sessões da pessoa na hora: ela perde o acesso agora.' },
        { p: 'O token da extensão aparece em Conexões para o Dono e para o Operador. Se a pessoa removida viu essa tela, clique em “Gerar novo token” em [[Conexões → Mercado Livre]] e cole o novo na extensão: o antigo para de funcionar na hora.' },
        { nota: 'aviso', texto: 'Quem vira Dono também pode convidar, remover pessoas e mudar papéis, inclusive o seu. O painel pede confirmação antes.' },
        { p: 'O Histórico registra entradas, trocas de papel e remoções pelo **nome** da pessoa, nunca pelo e-mail.' },
      ],
    },
  ],
});

docsCapitulo({
  id: 'privacidade',
  titulo: 'Privacidade e segurança',
  aprenda: [
    'O que fica guardado no seu computador.',
    'Por que chaves e senhas não voltam para a tela.',
    'Como o login e a sessão funcionam.',
    'O prazo de guarda dos dados e como avisar os membros.',
  ],
  abrir: [{ rota: '#ajustes', tela: 'Ajustes' }],
  secoes: [
    {
      id: 'dados', titulo: 'O que fica no seu computador',
      blocos: [
        { p: 'Tudo fica na pasta `data` do programa, no seu computador, fora do controle de versões. O painel só ouve neste computador (`127.0.0.1`); num servidor, quem expõe é um Nginx com HTTPS, e o painel exige login.' },
        { tabela: {
          colunas: ['O quê', 'Como fica guardado'],
          linhas: [
            ['Quem entra, sai ou lê nos grupos', 'Um pseudônimo (código derivado do número com uma chave local), nunca o número. O painel mostra só os primeiros caracteres.'],
            ['Números que recebem avisos', 'Guardados, mas a tela mostra o número mascarado.'],
            ['Nomes e e-mails da equipe e dos convidados', 'Guardados. Do convite, só uma impressão do link (hash), nunca o link.'],
            ['Espelhamento', 'O nome do grupo de origem e o texto da mensagem, **mascarado** (e-mails, telefones e sequências de 8 ou mais dígitos viram `…`) e cortado em 1000 caracteres. Nunca quem postou. O texto não vai para o navegador nem para o log.'],
            ['Números dos remetentes', 'Guardados, entram no backup e são apagados ao excluir o remetente. A tela mostra o número mascarado. Do que o remetente manda, o texto da mensagem não é guardado: só os campos lidos dele (título, preço, cupom), já mascarados, e só até o link ser decidido.'],
            ['Ofertas do Catálogo', 'Título, preço, foto, categoria e link. Sem dado pessoal.'],
            ['Fotos de Disparar mensagem', 'Sem metadados. Apagadas 7 dias depois de não terem mais envio ativo.'],
            ['Sessão do WhatsApp', 'Uma pasta dentro de `data`. Equivale a uma senha.'],
          ],
        } },
        { p: 'O log do programa usa só nomes de grupo e de destino: nunca números de telefone, e-mails nem o texto das mensagens.' },
        { nota: 'aviso', texto: 'A pasta `data` e os backups carregam a sessão do WhatsApp, números e e-mails. Não compartilhe, não envie para a nuvem e nunca faça commit deles.' },
      ],
    },
    {
      id: 'segredos', titulo: 'Segredos nunca voltam à tela',
      blocos: [
        { p: 'Chaves e senhas ficam no seu computador e não voltam para a tela. Depois de salvos, o campo só mostra que está preenchido: vazio mantém o valor salvo e um valor novo substitui. Só o Dono vê esses campos.' },
        { p: 'Isso vale para a Senha da API da Shopee e o segredo da credencial da Amazon. As mensagens de erro do painel são frases fixas: não repetem esses valores.' },
        { p: 'O token da extensão é diferente: ele fica à vista em [[Conexões → Mercado Livre]], para o Dono e para o Operador, porque é preciso colá-lo na extensão.' },
        { p: 'O token do Etiqueta fica num arquivo seu: o painel só guarda o **caminho** do arquivo, lê o conteúdo a cada pedido e nunca o mostra. Se você colou o token em algum lugar, gere outro no Etiqueta.' },
        { nota: 'dica', texto: 'Suspeita de vazamento do token da extensão? Em [[Conexões → Mercado Livre]], clique em “Gerar novo token” (só o Dono) e cole o novo na extensão: a antiga para de funcionar até lá.' },
      ],
    },
    {
      id: 'login', titulo: 'Login e sessão',
      onde: '[[Equipe]]',
      blocos: [
        { p: 'A senha vira um código irreversível (hash) no banco. Depois de entrar, a sessão fica num cookie do navegador por **30 dias** e cai antes se ficar **7 dias sem uso**. Ela sobrevive a reinícios do programa.' },
        { p: 'Cinco tentativas erradas bloqueiam o IP por 15 minutos. O erro é sempre “E-mail ou senha incorretos.”, sem dizer qual dos dois errou.' },
        { p: 'Esqueceu a senha do Dono? Num terminal, na pasta do programa, rode o comando abaixo. Ele troca a senha do Dono mais antigo da equipe e encerra **todas** as sessões abertas.' },
        { comando: 'npm run senha' },
      ],
    },
    {
      id: 'retencao', titulo: 'Prazo de guarda e apagar',
      onde: '[[Ajustes → Privacidade dos grupos]]',
      blocos: [
        { p: 'Eventos, leituras e cliques dos grupos, os itens já decididos do espelhamento e os itens já decididos dos remetentes são apagados depois do prazo em “Guardar por (dias)”. O padrão é **90 dias**. A limpeza roda ao iniciar o programa e a cada 6 horas.' },
        { nota: 'aviso', texto: '0 significa guardar para sempre, e então os textos do espelhamento também ficam. Não é recomendado.' },
        { p: 'Para aplicar o prazo agora, use “Apagar o que já passou do prazo” (só o Dono). Ficam de fora o que ainda está na fila do espelhamento e dos remetentes e o item enviado que ainda conta para o “não repetir”.' },
        { passos: [
          '**Apagar um espelhamento** apaga na hora todos os itens e textos dele.',
          '**Desconectar o WhatsApp** pergunta se você também quer apagar o histórico de entradas, saídas, leituras e cliques dos grupos. Responda sim só se não for mais usar esse número aqui.',
          '**Remover uma pessoa da equipe** em [[Equipe]] apaga os dados dela. O e-mail ainda fica no convite que ela usou, até a limpeza de convites (30 dias depois de usado, cancelado ou vencido).',
        ] },
        { p: 'Para apagar tudo de um membro de grupo que pediu, não há botão: é uma chamada da API do painel (`POST /api/privacidade/apagar-participante`). Peça ao responsável técnico.' },
      ],
    },
    {
      id: 'membros', titulo: 'Avisar os membros',
      blocos: [
        { p: 'O painel conta entradas, saídas e leituras dos grupos para medir o alcance. Avise os membros, por exemplo na descrição do grupo: “Contamos entradas, saídas e leituras de mensagens para medir o alcance do grupo.”' },
        { p: 'Cliques no rotacionador: o IP só é usado na memória, para contar um clique por hora. Ele não vai para o banco.' },
      ],
    },
  ],
});

docsCapitulo({
  id: 'manutencao',
  titulo: 'Manutenção',
  aprenda: [
    'Abrir o painel e atualizar a tela.',
    'Fazer backup e restaurar.',
    'Reconectar o WhatsApp e limpar o log antigo.',
    'Ajustar pausas e limites.',
  ],
  abrir: [{ rota: '#ajustes', tela: 'Ajustes' }, { rota: '#numeros', tela: 'Números de WhatsApp' }],
  secoes: [
    {
      id: 'painel', titulo: 'Ver o painel e atualizar',
      blocos: [
        { p: 'O painel roda como um serviço do computador, chamado `achadinhoturbo`, na porta 3737. Abra `http://localhost:3737` no navegador.' },
        { p: 'Para saber se o serviço está ligado:' },
        { comando: 'systemctl --user status achadinhoturbo' },
        { p: 'Para reiniciar:' },
        { comando: 'systemctl --user restart achadinhoturbo' },
        { p: 'Depois de uma atualização da tela, recarregue o navegador com {{Ctrl}}+{{Shift}}+{{R}}, para ele não usar a versão antiga guardada.' },
        { p: 'Sem o serviço: no Windows, dê dois cliques em `iniciar.bat`. Nos outros sistemas, rode `npm start` na pasta do programa.' },
        { nota: 'dica', texto: 'Quer só olhar o painel, sem enviar nada? Na pasta do programa, rode `npm run simular`. Nesse modo nada é enviado de verdade, e ele usa uma pasta separada, `data-simulacao`: não mexe nos seus dados (por isso começa sem grupos nem regras). Se a porta 3737 estiver ocupada pelo serviço, rode `PORT=3799 npm run simular` e abra `http://localhost:3799`.' },
      ],
    },
    {
      id: 'backup', titulo: 'Backup e restaurar',
      blocos: [
        { p: 'O backup é um arquivo `.tar.gz` com o banco de dados e a sessão do WhatsApp. É seguro fazer com o programa rodando. Na pasta do programa:' },
        { comando: 'npm run backup' },
        { p: 'O arquivo vai para `data/backups/` (ou para a pasta que você escrever depois do comando) e o programa guarda os 7 mais recentes. Se a pasta escolhida estiver dentro de um repositório git que não a ignora, o comando avisa.' },
        { nota: 'aviso', texto: 'O backup contém a sessão do seu WhatsApp, o ID e o segredo da credencial da Amazon, números, e-mails e textos de grupos de terceiros (mascarados). Trate como uma senha: guarde num lugar só seu, não envie para a nuvem e nunca faça commit.' },
        { p: '**Para restaurar**, abra um terminal na pasta do programa e siga os passos, um comando de cada vez. O backup é extraído **fora** da pasta do programa, na pasta `achadinho-restaurado` ao lado dela, para os dados pessoais não caírem dentro do projeto.' },
        { p: '**1. Pare o serviço:**' },
        { comando: 'systemctl --user stop achadinhoturbo' },
        { p: '**2. Confira o backup.** O comando extrai o arquivo na pasta nova e roda uma verificação de integridade; o resultado deve trazer `integridade=ok`. **Troque pelo nome do seu arquivo** antes de rodar:' },
        { comando: 'npm run backup -- restaurar data/backups/disparador-2026-11-04-10-30-00.tar.gz ../achadinho-restaurado' },
        { p: '**3. Troque as pastas.** A `data` atual fica guardada como `data-antiga`, e a restaurada vira a nova `data`:' },
        { comando: 'mv data data-antiga' },
        { comando: 'mv ../achadinho-restaurado data' },
        { p: 'Traga de volta os backups e as fotos enviadas, que não vão dentro do pacote. Se não houver `data-antiga/uploads`, ignore o erro do segundo comando:' },
        { comando: 'mv data-antiga/backups data/backups' },
        { comando: 'mv data-antiga/uploads data/uploads' },
        { p: '**4. Ligue o serviço de novo:**' },
        { comando: 'systemctl --user start achadinhoturbo' },
        { p: 'No Windows, feche a janela do `iniciar.bat`, troque os nomes das pastas pelo Explorador de Arquivos e abra o `iniciar.bat` de novo.' },
        { nota: 'dica', texto: 'A sessão do WhatsApp do backup só vale se o aparelho ainda estiver conectado no celular. Se o painel pedir, leia o QR de novo em [[Números de WhatsApp]].' },
        { nota: 'aviso', texto: 'Quando tudo estiver certo, apague a pasta `data-antiga`: ela também tem a sessão do WhatsApp e dados pessoais.' },
      ],
    },
    {
      id: 'reconectar', titulo: 'Reconectar o WhatsApp',
      onde: '[[Números de WhatsApp]]',
      blocos: [
        { p: 'Se o número cair, abra [[Números de WhatsApp]]. Quando aparecer “Nenhum número conectado”, clique em “Conectar WhatsApp” e leia o QR no celular.' },
        { passos: [
          'No celular, abra o WhatsApp Business e toque nos três pontos e em “Aparelhos conectados”.',
          'Toque em “Conectar um aparelho” e aponte para o QR da tela. O código se renova sozinho a cada poucos segundos.',
          'Depois de conectar, a lista de “Grupos” volta a aparecer.',
        ] },
        { p: 'O programa só vê o que acontece **enquanto está conectado**. Mensagem agendada que perde o horário por mais de 2 horas, por falta de conexão, não sai.' },
        { p: '“Desconectar” (só o Dono) encerra a sessão deste programa e apaga a sessão guardada no computador. Ele pergunta duas vezes: se quer mesmo desconectar e, depois, “Apagar também o histórico…?” dos grupos. Se vai continuar usando o número, clique em **Cancelar** nessa segunda pergunta: o programa desconecta e guarda o histórico.' },
        { nota: 'dica', texto: 'Para trocar as chaves da sessão (por exemplo, depois de [limpar o log antigo](#docs/manutencao/log)), faça tudo pelo painel: clique em “Desconectar” e, na segunda pergunta (“Apagar também o histórico…?”), clique em **Cancelar**, porque você continua com o mesmo número. Depois clique em “Conectar WhatsApp” e leia o QR novo.' },
      ],
    },
    {
      id: 'log', titulo: 'Limpar o log antigo',
      onde: 'Um terminal comum do computador',
      blocos: [
        { p: '**Só para quem roda o programa no Linux (Ubuntu).** No Windows e no macOS estes comandos não existem.' },
        { p: 'Versões antigas do programa escreviam as chaves da sessão do WhatsApp no log do serviço. Isso **já foi corrigido**: o log novo não guarda as chaves. Mas o log antigo pode ainda ter essas linhas, e quem as lê consegue usar a sua sessão. O sistema guarda esse log em dois lugares: no journal e, no Ubuntu, numa cópia em `/var/log/syslog`. Limpe os dois.' },
        { nota: 'aviso', texto: 'Estes comandos apagam os logs do computador inteiro, não só os do Achadinho Turbo. Se você precisa de algum log de outro programa, guarde-o antes. Eles precisam da senha do computador: rode num terminal comum e digite a senha quando o `sudo` pedir. Por um prompt sem terminal, eles não funcionam.' },
        { p: 'Abra um terminal comum (não precisa estar na pasta do programa) e rode um comando de cada vez.' },
        { p: '**1. Limpe o journal:**' },
        { comando: 'sudo journalctl --rotate && sudo journalctl --vacuum-time=1s' },
        { p: '**2. Esvazie o syslog:**' },
        { comando: 'sudo truncate -s 0 /var/log/syslog' },
        { p: '**3. Confira.** Cada comando abaixo só conta as linhas com as chaves, sem mostrá-las. O resultado de todos deve ser **0**:' },
        { comando: 'journalctl --user -u achadinhoturbo --no-pager | grep -c privKey' },
        { comando: 'sudo grep -c privKey /var/log/syslog' },
        { comando: 'sudo zgrep -c privKey /var/log/syslog.*' },
        { p: 'O último mostra uma linha por cópia antiga (`/var/log/syslog.1`, `/var/log/syslog.2.gz`…), com o número depois dos dois pontos; se ele disser que não achou o arquivo, não há cópia antiga. Se alguma der mais que 0, apague essa cópia. **Troque pelo nome que apareceu:**' },
        { comando: 'sudo rm /var/log/syslog.1' },
        { p: '**4. Refaça a conexão do WhatsApp com um QR novo. Este passo é obrigatório.** Limpar o log apaga as linhas, não as chaves: quem copiou o log antes (um backup, outro programa, outra pessoa no computador) ainda consegue usar a sua sessão. Um QR novo cria chaves novas e inutiliza as antigas em qualquer cópia.' },
        { p: 'Faça tudo pelo painel (não remova o aparelho pelo celular antes: aí o painel apaga a sessão sozinho e o botão “Desconectar” some). Em [[Números de WhatsApp]], clique em “Desconectar” (só o Dono) e, na segunda pergunta (“Apagar também o histórico…?”), clique em **Cancelar**, porque você continua com o mesmo número. Depois clique em “Conectar WhatsApp” e leia o QR novo. Veja [Reconectar o WhatsApp](#docs/manutencao/reconectar).' },
      ],
    },
    {
      id: 'ajustes', titulo: 'Ajustes: pausas e limites',
      onde: '[[Ajustes]]',
      blocos: [
        { p: 'Os cartões são: pausas entre mensagens, tamanho do título, modo de link e privacidade dos grupos. A extensão do Chrome agora fica em [[Conexões → Mercado Livre]]; o cartão dela em Ajustes só leva para lá.' },
        { tabela: {
          colunas: ['Campo', 'Padrão', 'Para que serve'],
          linhas: [
            ['Entre um grupo e outro (segundos)', '6 (mínimo 2)', 'Espera entre os grupos de um mesmo envio.'],
            ['Entre uma oferta e a próxima (segundos)', '30 (mínimo 5)', 'Espera entre duas ofertas de um mesmo disparo.'],
            ['Tamanho máximo (caracteres)', '60', 'Abrevia `{TITULO_PRODUTO}`. 0 = não abreviar. Sugestão: 50 a 70.'],
            ['Guardar por (dias)', '90', 'Prazo de guarda dos dados dos grupos. Veja [Prazo de guarda e apagar](#docs/privacidade/retencao).'],
          ],
        } },
        { p: 'O programa varia as pausas ao acaso, para mais ou para menos. Pausa curta demais parece robô, e a conexão com o WhatsApp é não oficial: há risco de o número ser restringido. O padrão, de 6 s entre grupos e 30 s entre ofertas, é um ponto de partida seguro; o painel não aceita menos (mínimo de 2 s e de 5 s). Evite volume alto.' },
        { p: 'Em “Como gerar o link de afiliado” há duas opções:' },
        { passos: [
          '**Pela extensão do Chrome (com a etiqueta, gera comissão)**: o modo de verdade.',
          '**Link direto, sem etiqueta (só para testar, não gera comissão)**: só para testar o fluxo. Nesse modo, as ofertas do Mercado Livre que vêm do Catálogo ou de um remetente não saem.',
        ] },
      ],
    },
  ],
});
