// Docs do sistema: capítulos 1 (Primeiros passos) e 2 (Conexões).
// Só chama docsCapitulo (public/docs.js): nenhuma declaração no topo, porque o escopo global é o mesmo dos outros
// scripts do painel. Formato dos blocos e mini-marcação: comentário de docsInline e plano docs-do-sistema.
// Slugs da spec (docs/produto/specs/docs-do-sistema.md, seção 1): pode acrescentar seção, nunca renomear nem tirar.
// Fontes do texto: README ("Instalar", "Login do painel", "Primeiros passos", "Conexões", "Extensão do Chrome",
// "Catálogo do Etiqueta → Configurar"), src/lojas.js (campos) e public/conexoes.js (rótulos, selos e frases da tela).

docsCapitulo({
  id: 'primeiros-passos',
  titulo: 'Primeiros passos',
  aprenda: [
    'Abrir o painel e entrar.',
    'Conectar o seu número de WhatsApp e achar os grupos.',
    'Instalar a extensão do Chrome que gera os links.',
    'Fazer um primeiro disparo de teste.',
  ],
  antes: ['Node.js 22.13 ou mais novo e o Chrome instalados no computador onde o programa vai rodar.'],
  abrir: [{ rota: '#numeros', tela: 'Números de WhatsApp' }, { rota: '#conexoes', tela: 'Conexões' }],
  secoes: [
    {
      id: 'comece', titulo: 'Mapa da trilha',
      blocos: [
        { p: 'Comece por aqui: esta é a ordem que funciona para quem começa do zero, a mesma da trilha deste livro.' },
        { passos: [
          '**Abrir o painel e entrar**: crie a conta de Dono para proteger o painel. [Entrar](#docs/primeiros-passos/entrar).',
          '**Números de WhatsApp**: conecte o número pelo QR. A lista aparece em **Grupos**. [Como conectar](#docs/primeiros-passos/whatsapp).',
          '**Extensão do Chrome**: carregue a pasta `extension`, cole o endereço e o token (um código que liga o painel à extensão) e fique logado na Central de Afiliados. [Como instalar](#docs/primeiros-passos/extensao).',
          '**Conexões**: cadastre o nome exato da sua etiqueta do Mercado Livre. [Etiquetas](#docs/conexoes/mercado-livre).',
          '**Templates**: ajuste a mensagem e veja a prévia. [Templates](#docs/templates).',
          '**Disparo manual**: cole um link, clique em “Identificar” e dispare para um grupo de teste. [Primeiro disparo de teste](#docs/primeiros-passos/teste) e [Disparo manual](#docs/disparo-manual).',
          '**Disparo automático**: crie o primeiro, clique em “Ver ofertas” e depois em “Enviar agora”. [Disparo automático](#docs/disparo-automatico).',
          '**Relatórios e avisos**: escolha quem recebe o resumo diário e os avisos. [Resultados e avisos](#docs/resultados/avisos).',
        ] },
        { p: 'Depois, acompanhe o **Histórico** e a **Visão Geral**. Avisos e enquetes, agora ou agendados, estão em [Disparar mensagem e enquete](#docs/mensagens).' },
      ],
    },
    {
      id: 'entrar', titulo: 'Abrir o painel e entrar',
      onde: '[[Equipe]]',
      leia: 'manutencao/painel',
      blocos: [
        { p: 'Você já está no painel. Se precisar abrir de novo, ligue o programa e abra o endereço dele:' },
        { passos: [
          'Se ainda não tem, instale o Node.js 22.13 ou mais novo (versão LTS, em nodejs.org).',
          'No Windows, dê dois cliques em `iniciar.bat`. Em outros sistemas, rode `npm install` e depois `npm start`.',
          'Abra `http://localhost:3737` no navegador.',
        ] },
        { p: 'Em casa, só no próprio computador, o painel abre sem login e o terminal mostra um aviso. Para proteger o painel, crie a sua conta de Dono:' },
        { passos: [
          'Abra [[Equipe]]. A tela mostra “Proteja o painel”.',
          'Escreva o seu nome, um e-mail e uma senha de 8 caracteres ou mais.',
          'Clique em “Ativar login”. Você continua entrado neste navegador.',
        ] },
        { p: 'A partir daí o painel pede e-mail e senha. Os prazos da sessão e o bloqueio por senhas erradas estão em [Limites e números](#docs/referencia/limites).' },
        { nota: 'dica', texto: 'Esqueceu a senha? Rode `npm run senha` no computador: ela troca a senha do Dono e encerra todas as sessões abertas.' },
      ],
    },
    {
      id: 'whatsapp', titulo: 'Conectar o WhatsApp',
      onde: '[[Números de WhatsApp]]',
      leia: 'manutencao/reconectar',
      blocos: [
        { p: 'O número que envia entra como “aparelho conectado”, igual ao WhatsApp Web. O celular continua funcionando normalmente.' },
        { passos: [
          'Abra [[Números de WhatsApp]] e clique em “Conectar WhatsApp”. O painel mostra um QR.',
          'No celular, abra o WhatsApp Business, toque nos três pontos e em “Aparelhos conectados”.',
          'Toque em “Conectar um aparelho” e aponte a câmera para o QR.',
          'Espere: a tela passa a mostrar “Conectado” e o número.',
          'Abra [[Grupos]]. A lista mostra os grupos em que o número está.',
        ] },
        { nota: 'dica', texto: 'O QR se renova sozinho a cada poucos segundos. Se a lista de grupos estiver desatualizada, clique em “Atualizar lista de grupos”, na tela Grupos.' },
        { nota: 'aviso', texto: 'A conexão é não oficial e o WhatsApp pode restringir o número. Prefira um número de que você não dependa e evite volume alto. O programa já protege o número com um limite de 40 mensagens por hora, horário de silêncio das 23:00 às 07:00 e pausas entre mensagens: veja [Proteção do número](#docs/manutencao/protecao-do-numero).' },
        { nota: 'dica', texto: 'Tenha um **segundo chip de reserva**, com o WhatsApp Business instalado, e deixe esse número também dentro dos seus grupos. Se este número for restringido, você o conecta em [[Números de WhatsApp]] e continua enviando. Nessa tela, uma linha mostra quantas mensagens saíram na última hora. E ponha um **segundo admin em cada grupo**: em [[Grupos]], o selo “Falta 2º admin” mostra quais faltam.' },
      ],
    },
    {
      id: 'extensao', titulo: 'Instalar a extensão do Chrome',
      onde: '[[Conexões → Mercado Livre]]',
      blocos: [
        { p: 'A extensão usa a sua sessão na Central de Afiliados do Mercado Livre para gerar os links `meli.la`, ler a lista de ofertas e, na versão 1.5.0, conferir o preço e o estoque do produto antes de cada envio. Nenhum cookie sai do seu Chrome: ela devolve só a lista de produtos, o link pronto e, na conferência, o preço e a disponibilidade.' },
        { passos: [
          'No Chrome, abra `chrome://extensions` e ligue o “Modo do desenvolvedor”.',
          'Clique em “Carregar sem compactação” e escolha a pasta `extension` do programa.',
          'No painel, em [[Conexões → Mercado Livre]], clique em “Copiar” no endereço e depois no token.',
          'Clique no ícone da extensão, cole os dois e clique em “Salvar e conectar”.',
          'No mesmo Chrome, entre na sua conta da Central de Afiliados do Mercado Livre.',
          'Volte a Conexões: a linha de estado diz “Extensão conectada.”',
        ] },
        { nota: 'dica', texto: 'O Chrome precisa ficar aberto enquanto os disparos rodam. A extensão abre sozinha uma aba fixada da Central. Para os links da Shopee, entre também em `affiliate.shopee.com.br`.' },
        { nota: 'erro', texto: '“Não há sessão de afiliado neste Chrome” no Histórico. A sessão venceu. Entre de novo na Central de Afiliados nesse Chrome. Se a Shopee não gera links, abra `chrome://extensions` e clique em “Recarregar” na extensão: a versão 1.3.0 pede uma permissão nova. Depois de atualizar a pasta `extension` para a 1.5.0, clique em “Recarregar” também: até lá, o Histórico diz “a extensão do Chrome precisa ser recarregada” nas conferências do Mercado Livre.' },
        { nota: 'aviso', texto: 'O token da extensão funciona como uma senha. Se achar que ele vazou, o Dono clica em “Gerar novo token” em Conexões. A extensão para de funcionar até você colar o novo.' },
      ],
    },
    {
      id: 'teste', titulo: 'Seu primeiro disparo de teste',
      onde: '[[Disparo manual]]',
      leia: 'disparo-manual/mercado-livre',
      blocos: [
        { p: 'Teste antes de mandar para um grupo de verdade. Há dois jeitos.' },
        { p: '**Só olhar o painel, sem enviar nada.** Rode o comando abaixo e abra o endereço que o terminal mostrar. O painel avisa “Modo simulação: nada é enviado de verdade”.' },
        { comando: 'npm run simular' },
        { p: 'O modo simulado usa uma pasta separada, `data-simulacao`, e não mexe nos seus dados: por isso ele começa sem grupos nem regras. Se a porta 3737 estiver ocupada pelo serviço, use o comando abaixo e abra `http://localhost:3799`:' },
        { comando: 'PORT=3799 npm run simular' },
        { p: '**Enviar de verdade para um grupo de teste.** Crie no WhatsApp um grupo só seu e siga:' },
        { passos: [
          'Conecte o WhatsApp e a extensão (seções anteriores) e cadastre a etiqueta em [[Conexões → Mercado Livre]].',
          'Abra [[Disparo manual]], cole o link de um produto do Mercado Livre e clique em “Identificar”.',
          'Marque o grupo de teste em “Grupos que vão receber” e escolha o template.',
          'Confira a prévia e clique em “Disparar”.',
          'Veja o resultado no cartão “Histórico”, ao lado do formulário.',
        ] },
        { nota: 'dica', texto: 'Se o botão “Disparar” está apagado, a frase ao lado dele diz o que falta: WhatsApp, extensão, link, grupo ou template.' },
      ],
    },
  ],
});

docsCapitulo({
  id: 'conexoes',
  titulo: 'Conexões: suas lojas',
  aprenda: [
    'Cadastrar as etiquetas do Mercado Livre com o nome exato.',
    'Onde vai a tag da Amazon e o que a API acrescenta.',
    'Os três dados da Shopee: ID de afiliado, AppID e Senha da API.',
    'Conectar o Catálogo do Etiqueta.',
  ],
  antes: ['[Primeiros passos](#docs/primeiros-passos): o WhatsApp conectado e a extensão instalada.'],
  abrir: [{ rota: '#conexoes', tela: 'Conexões' }],
  secoes: [
    {
      id: 'por-onde-comecar', titulo: 'Por onde começar',
      leia: 'perguntas/precisa-api',
      blocos: [
        { p: 'Para começar você só precisa do Mercado Livre; Amazon, Shopee, Magalu e Catálogo podem esperar. A API só poupa digitação. Veja o que funciona sem ela:' },
        { tabela: { colunas: ['Loja', 'Sem API', 'Com API'], linhas: [
          ['Mercado Livre', 'Funciona: extensão do Chrome e etiqueta.', 'Não usa API.'],
          ['Amazon', 'Funciona com a tag. Os dados vêm do texto da mensagem de origem ou você preenche.', 'Título, preço, preço antigo e foto vêm da Amazon.'],
          ['Shopee', 'Funciona com o ID de afiliado e o Chrome logado no portal. O link sai pela extensão e você preenche título e preço.', 'O painel busca título, preço e foto.'],
          ['Magalu', 'Funciona só com o nome da sua loja de parceiro. O link sai com ele; você preenche título e preço e confere a loja pelo link do cartão.', 'Nada a mais: não existe API.'],
        ] } },
      ],
    },
    {
      id: 'mercado-livre', titulo: 'Mercado Livre e etiquetas',
      onde: '[[Conexões → Mercado Livre]]',
      leia: 'perguntas/etiqueta-desta-fonte',
      blocos: [
        { p: 'O cartão **Mercado Livre** tem duas partes: as etiquetas e a extensão do Chrome, que está em [Instalar a extensão do Chrome](#docs/primeiros-passos/extensao). Etiqueta é o nome que você criou no programa de afiliados do Mercado Livre. Ela vai dentro do link `meli.la` e define de quem é a comissão.' },
        { passos: [
          'Abra [[Conexões]] e vá até “Etiquetas de afiliado”.',
          'Em “Nome da etiqueta”, escreva o nome exatamente como aparece na Central de Afiliados (ex.: `achadosdesejo`).',
          'Se quiser, anote para que serve em “Anotação (opcional)”.',
          'Clique em “Adicionar etiqueta”. Repita para as outras.',
        ] },
        { p: 'O selo do cartão diz “Conectado” ou “Falta configurar”, e a linha abaixo dele explica o motivo. Os selos estão em [Estados dos cartões](#docs/referencia/estados).' },
        { nota: 'erro', texto: '“A etiqueta deve ter 2 a 60 caracteres: letras, números, ponto, hífen ou _ (sem espaços).” Tire os espaços e confira o nome na Central de Afiliados.' },
      ],
    },
    {
      id: 'amazon', titulo: 'Amazon: tag e API',
      soDono: true,
      onde: '[[Conexões → Amazon]]',
      leia: 'perguntas/tag-amazon',
      blocos: [
        { p: 'Só com a **tag de associado** a Amazon já funciona: todo link enviado sai com ela. A tag **não** vai nas etiquetas do Mercado Livre.' },
        { passos: [
          'Abra [[Conexões → Amazon]].',
          'Em “Tag de associado”, escreva a sua tag (ex.: `seunome-20`).',
          'Clique em “Salvar”. O selo passa a “Só com a tag”.',
        ] },
        { p: 'A **API** (Creators API) acrescenta título, preço, preço antigo, desconto e foto vindos da Amazon. Sem ela, você preenche à mão.' },
        { p: 'Para ligar a API, pegue as credenciais:' },
        { passos: [
          'Na Central de Associados da Amazon.com.br, abra “Ferramentas”, “Creators API”, clique em “Create Application” e depois em “Add New Credential”.',
          'Copie o Credential ID, o Secret e a Version (no Brasil, 3.1).',
          'No painel, preencha “ID da credencial”, “Segredo da credencial” e “Versão da credencial”. Clique em “Salvar” e depois em “Testar”.',
        ] },
        { nota: 'aviso', texto: 'A API exige conta de Associados aprovada em definitivo e pelo menos 10 vendas qualificadas nos últimos 30 dias na Amazon.com.br. Sem isso o teste diz que a conta ainda não tem acesso.' },
        { p: 'O ID e o segredo da credencial ficam só no seu computador e não voltam para a tela; campo vazio ao salvar mantém o valor guardado. Selos: [Estados dos cartões](#docs/referencia/estados).' },
      ],
    },
    {
      id: 'shopee', titulo: 'Shopee: ID, AppID e Senha',
      soDono: true,
      onde: '[[Conexões → Shopee]]',
      leia: 'perguntas/id-shopee',
      blocos: [
        { p: 'A Shopee pede três dados diferentes. Cada um tem o seu campo:' },
        { tabela: { colunas: ['Campo', 'O que é', 'Precisa?'], linhas: [
          ['ID de afiliado', 'O número da sua conta de afiliado (só números, ex.: `98765432101`). Vai nos links e define de quem é a comissão.', 'Sim, é o único obrigatório'],
          ['AppID', 'O número do aplicativo da API. Só existe depois que a Shopee libera a API. O painel recusa se for igual ao ID de afiliado.', 'Não'],
          ['Senha da API', 'Equivale a uma senha. Fica guardada no seu computador e não volta para a tela.', 'Não'],
        ] } },
        { p: 'Para os links saírem pela extensão do Chrome:' },
        { passos: [
          'Abra [[Conexões → Shopee]], escreva o “ID de afiliado” e clique em “Salvar”.',
          'Deixe o Chrome logado em `affiliate.shopee.com.br`, o portal de afiliados da Shopee.',
          'Em `chrome://extensions`, clique em “Recarregar” na extensão (versão 1.3.0 ou mais nova).',
          'Confira a linha “Extensão do Chrome conectada” no cartão da Shopee.',
        ] },
        { p: 'Para o painel buscar título, preço e foto sozinho, peça acesso à API em `affiliate.shopee.com.br/open_api` (resposta em até 3 dias úteis; conta nova costuma não ter acesso). Quando liberarem, cole o “AppID” e a “Senha da API”, clique em “Salvar” e depois em “Testar”.' },
        { nota: 'erro', texto: '“O ID de afiliado da Shopee tem só números.” O que você digitou parece uma tag da Amazon: ela vai no cartão Amazon.' },
        { p: 'Sem a API você já dispara: preencha título e preço à mão. O Disparo automático só envia a Shopee pela fonte Catálogo, sempre depois da sua [revisão](#docs/revisao/motivos). Não há espelhamento da Shopee.' },
      ],
    },
    {
      id: 'magalu', titulo: 'Magalu: o nome da sua loja',
      soDono: true,
      onde: '[[Conexões → Magalu]]',
      blocos: [
        { p: 'A Magalu não tem API nem senha. O painel só precisa do **nome da sua loja de parceiro** (Magazine Você): o link de afiliado sai com esse nome, e a comissão vai para a sua loja.' },
        { passos: [
          'Abra [[Conexões → Magalu]].',
          'Escreva o “Nome da sua loja”: é o trecho que vem depois de `magazinevoce.com.br/` no endereço da sua loja. Se o endereço é `magazinevoce.com.br/minhaloja`, escreva `minhaloja` (só letras, números, hífen e _).',
          'Clique em “Salvar”. O selo passa para “Configurada”.',
          'Clique em “Conferir minha loja” e veja se abre a página da sua loja.',
        ] },
        { p: 'No [[Disparo manual]], cole o link do produto. O link que vai ao grupo é sempre `https://www.magazinevoce.com.br/<sua loja>/…`, montado na hora do envio. O link que um [remetente](#docs/disparo-automatico/remetentes) manda também sai com a sua loja, com título e preço escritos na mensagem dele.' },
        { p: 'A Magalu fica de fora do Catálogo, das regras do Disparo automático, do espelhamento, do rastreio por grupo, da página Ganhos e da importação de comissões. Ela não separa os ganhos por grupo.' },
        { nota: 'aviso', texto: 'O painel não confirma que o nome existe. Nome errado gera um link de outra loja, e a comissão não vem para você: use sempre “Conferir minha loja”.' },
        { nota: 'erro', texto: '“O link que você colou é de outra loja de parceiro. O envio sai com a sua loja, não com essa.” Nada a fazer: o painel troca a loja do link pela sua.' },
        { nota: 'dica', texto: 'O painel não lê o produto na Magalu: título e preço são seus (use o preço que aparece na página da Magalu) e a foto é opcional, por upload.' },
      ],
    },
    {
      id: 'catalogo', titulo: 'Catálogo do Etiqueta',
      soDono: true,
      onde: '[[Conexões → Catálogo do Etiqueta]]',
      leia: 'disparo-automatico/catalogo',
      blocos: [
        { p: 'O Etiqueta é o seu outro programa de ofertas, neste mesmo computador. O **Catálogo** é a fonte do Disparo automático que lê as ofertas dele; não é loja nem etiqueta do Mercado Livre.' },
        { passos: [
          'Deixe o Etiqueta ligado (`python3 servidor.py`), com o arquivo `api_token.txt` na pasta dele.',
          'Abra [[Conexões → Catálogo do Etiqueta]] e confira o “Endereço do Etiqueta”: `http://127.0.0.1:8765` (prefira `127.0.0.1` a `localhost`; só vale endereço deste computador, com `http`).',
          'Em “Arquivo do token”, cole o caminho completo do `api_token.txt` (começa com `/` ou `~/`).',
          'Clique em “Salvar” e depois em “Testar”.',
          'O teste diz “Conectado. N ofertas em M categorias.” e lista as categorias.',
        ] },
        { nota: 'aviso', texto: 'Cole o caminho do arquivo, nunca o token. O arquivo precisa se chamar `api_token.txt`. Se você colou o token em algum lugar, gere outro no Etiqueta.' },
        { nota: 'erro', texto: '“Token recusado.” O Etiqueta lê o arquivo do token só ao ligar. Depois de trocar o token, reinicie o `servidor.py` e clique em “Testar” de novo.' },
        { p: 'A lista de categorias é a do último “Testar”: se o Etiqueta ganhar categorias novas, teste de novo. Selos: [Estados dos cartões](#docs/referencia/estados).' },
      ],
    },
    {
      id: 'sem-api', titulo: 'O que funciona sem API',
      leia: 'perguntas/precisa-api',
      blocos: [
        { p: 'Você não precisa de API para começar: o quadro por loja está no topo do capítulo, em [Por onde começar](#docs/conexoes/por-onde-comecar). Hoje Mercado Livre, Amazon, Shopee e Magalu enviam; link do Facebook é reconhecido, mas o painel avisa que a loja não está conectada.' },
      ],
    },
  ],
});
