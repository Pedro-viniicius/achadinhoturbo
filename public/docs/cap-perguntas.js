// Docs do sistema: apêndice "Perguntas reais" (as dúvidas que o dono teve de fato).
// Só chama docsCapitulo (public/docs.js): nenhuma declaração no topo, porque o escopo global é o mesmo dos outros
// scripts do painel. Formato dos blocos e mini-marcação: comentário de docsInline e plano docs-do-sistema.
// Pergunta nova = uma seção nova no fim de `secoes`: { id, titulo (a pergunta), blocos (a resposta), onde, leia }.
// Slugs da spec (docs/produto/specs/docs-do-sistema.md, seção 1): pode acrescentar seção, nunca renomear nem tirar.
// Nada de segredo, token nem ID real aqui: exemplos usam 98765432101 e seunome-20.

docsCapitulo({
  id: 'perguntas',
  titulo: 'Perguntas reais',
  aprenda: [
    'Respostas curtas para as dúvidas que apareceram no uso de verdade.',
    'Onde fica cada coisa no painel e qual capítulo explica com calma.',
  ],
  secoes: [
    {
      id: 'tag-amazon', titulo: 'Cadastrei a tag da Amazon e o painel diz que falta. Onde ela vai?',
      onde: '[[Conexões → Amazon]], campo “Tag de associado”',
      leia: 'conexoes/amazon',
      blocos: [
        { p: 'No cartão da **Amazon**, não nas etiquetas do Mercado Livre. As etiquetas de [[Conexões → Mercado Livre]] são só do Mercado Livre, e o espelhamento da Amazon não as usa.' },
        { p: 'Em [[Conexões → Amazon]], preencha “Tag de associado” (por exemplo, `seunome-20`) e clique em **Salvar**. Sem a tag, o espelhamento não liga e o Disparo manual da Amazon fica bloqueado.' },
        { nota: 'dica', texto: 'Se você também usar a API da Amazon, a tag precisa ser da mesma loja (Amazon.com.br) da credencial.' },
      ],
    },
    {
      id: 'meli-la', titulo: 'O link meli.la não lê o produto. Por quê?',
      onde: '[[Disparo manual]]',
      leia: 'disparo-manual/mercado-livre',
      blocos: [
        { p: 'O `meli.la` que vem de outro afiliado leva a uma página de afiliado (a vitrine de quem criou o link), não à página do produto. O painel lê essa página para descobrir qual é o produto e gera o **seu** link a partir dele.' },
        { p: 'Em [[Disparo manual]], cole o link e clique em **Identificar**. Se mesmo assim não ler, cole o link da página do produto (`produto.mercadolivre.com.br/MLB-…`).' },
      ],
    },
    {
      id: 'precisa-api', titulo: 'Preciso da API da Shopee e da Amazon? O Mercado Livre já funciona?',
      onde: '[[Conexões]]',
      leia: 'conexoes/por-onde-comecar',
      blocos: [
        { p: 'Não precisa de API para começar. O Mercado Livre não usa API: usa a extensão do Chrome, logada na Central de Afiliados, e já funciona. A API só poupa digitação.' },
        { tabela: {
          colunas: ['Loja', 'Sem API', 'Com API'],
          linhas: [
            ['Mercado Livre', 'Extensão do Chrome e etiqueta. Já funciona.', 'Não usa API.'],
            ['Amazon', 'Com a tag, funciona. Os dados vêm do texto da mensagem de origem (no espelhamento) ou você preenche (no Disparo manual).', 'Título, preço, preço antigo e foto vêm da Amazon. A API exige conta de Associados aprovada e **10 vendas qualificadas nos últimos 30 dias** na Amazon.com.br.'],
            ['Shopee', 'Com o ID de afiliado e o Chrome logado no portal de afiliados, o link sai pela extensão e você preenche título e preço.', 'O painel busca os dados do produto. Peça o acesso em `affiliate.shopee.com.br/open_api` (resposta em até 3 dias úteis).'],
            ['Magalu', 'Só o nome da sua loja de parceiro: o link sai com ele e você preenche título e preço no Disparo manual.', 'Não há API pública da Magalu para parceiro: o painel não lê o produto.'],
          ],
        } },
      ],
    },
    {
      id: 'id-shopee', titulo: 'Meu ID de afiliado da Shopee vai no AppID?',
      onde: '[[Conexões → Shopee]]',
      leia: 'conexoes/shopee',
      blocos: [
        { p: 'Não. São três dados diferentes, cada um no seu campo de [[Conexões → Shopee]]:' },
        { tabela: {
          colunas: ['Campo', 'O que é', 'Precisa?'],
          linhas: [
            ['ID de afiliado', 'O número da sua conta de afiliado (só números, como `98765432101`). Vai nos links e define de quem é a comissão.', 'Sim, é o único obrigatório.'],
            ['AppID', 'O número do aplicativo da API. Só existe depois que a Shopee libera a API. O painel recusa se for igual ao ID de afiliado.', 'Opcional.'],
            ['Senha da API', 'Equivale a uma senha. Fica guardada no seu computador e não volta para a tela.', 'Opcional.'],
          ],
        } },
      ],
    },
    {
      id: 'catalogo', titulo: 'Onde conecto o catálogo do Etiqueta?',
      onde: '[[Conexões → Catálogo do Etiqueta]]',
      leia: 'conexoes/catalogo',
      blocos: [
        { passos: [
          'Em [[Conexões → Catálogo do Etiqueta]], confira o endereço (o padrão é `http://127.0.0.1:8765`).',
          'Em “Arquivo do token”, escreva o **caminho** do arquivo `api_token.txt`, nunca o conteúdo dele.',
          'Clique em **Salvar** e depois em **Testar**.',
        ] },
        { p: 'Para usar as ofertas dele: [[Disparo automático → Novo disparo automático → De onde vêm as ofertas]], escolha “Catálogo (app Etiqueta)”. Só o Dono salva e testa a conexão.' },
      ],
    },
    {
      id: 'etiqueta-desta-fonte', titulo: '“Etiqueta desta fonte” é o app Etiqueta?',
      onde: '[[Conexões → Mercado Livre]]',
      leia: 'referencia/glossario',
      blocos: [
        { p: 'Não. É a **etiqueta de afiliado do Mercado Livre**, a que você criou na Central de Afiliados. Por isso o painel escreve “Etiqueta ML”. Ela diz de quem é a comissão dos links `meli.la` daquela fonte.' },
        { p: 'O app Etiqueta, o seu outro programa, aparece no painel só como “Catálogo”. Onde cadastrar a etiqueta: [[Conexões → Mercado Livre]]. Veja o quadro “Cinco nomes parecidos” na Referência.' },
      ],
    },
    {
      id: 'so-catalogo', titulo: 'Dá para usar só o catálogo, sem misturar com a Central de Afiliados?',
      onde: '[[Disparo automático → Novo disparo automático → De onde vêm as ofertas]]',
      leia: 'disparo-automatico/catalogo',
      blocos: [
        { p: 'Dá. No disparo, deixe só a fonte “Catálogo (app Etiqueta)”. A etiqueta do Mercado Livre só serve para gerar links do Mercado Livre.' },
        { p: 'Se o Catálogo for só de Amazon e/ou Shopee (marque as lojas), a “Etiqueta ML padrão” fica opcional. Se o Catálogo puder trazer Mercado Livre, a etiqueta continua obrigatória. Isso inclui o Catálogo sem nenhuma loja marcada, que vale por todas.' },
      ],
    },
    {
      id: 'catalogo-links', titulo: 'Os links do catálogo já são meus. Por que o Turbo gera de novo ou pede revisão?',
      onde: '[[Histórico → Tipo → Catálogo]]',
      leia: 'revisao/motivos',
      blocos: [
        { p: 'Porque o link curto não prova de quem é a conta. A sua comissão continua sua: o link novo leva a sua etiqueta ou tag.' },
        { tabela: {
          colunas: ['Loja', 'O que o Turbo faz', 'Espera revisão?'],
          linhas: [
            ['Mercado Livre', 'Refaz o `meli.la` pela extensão, com a etiqueta do disparo. O link do catálogo não é usado.', 'Não, sai sozinho.'],
            ['Amazon', 'Remonta o link com a tag de [[Conexões → Amazon]].', 'Não, sai sozinho.'],
            ['Shopee', 'O link `s.shopee` não mostra de quem é a conta. Aprovada, a oferta sai com o link do próprio catálogo.', 'Sim, toda oferta da Shopee.'],
          ],
        } },
        { p: 'Também esperam a revisão: desconto de 100%, preço antigo 10 vezes maior que o preço (ou mais) e oferta cujo link não pôde ser gerado. Só o Dono revisa, em [[Histórico → Tipo → Catálogo]].' },
        { nota: 'dica', texto: 'Mercado Livre com a extensão desligada, ou Amazon sem a tag salva: as ofertas esperam e saem sozinhas quando o que falta voltar. Elas não vão para a revisão.' },
      ],
    },
    {
      id: 'limpar-log', titulo: 'Como limpo o log antigo que tem as chaves do WhatsApp?',
      onde: 'Um terminal comum do computador',
      leia: 'manutencao/log',
      blocos: [
        { p: 'O log antigo do serviço fica em dois lugares: no journal e, no Ubuntu, numa cópia em `/var/log/syslog`. Limpe os dois.' },
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
        { p: 'Faça tudo pelo painel (não remova o aparelho pelo celular antes: aí o painel apaga a sessão sozinho e o botão “Desconectar” some). Em [[Números de WhatsApp]], clique em “Desconectar” (só o Dono) e, na segunda pergunta (“Apagar também o histórico…?”), clique em **Cancelar**, porque você continua com o mesmo número. Depois clique em “Conectar WhatsApp” e leia o QR novo.' },
        { nota: 'dica', texto: 'A causa já está corrigida: o programa não escreve mais as chaves da sessão no log. Só o log antigo precisa ser limpo.' },
      ],
    },
    {
      id: 'painel-local', titulo: 'Como rodo ou vejo o painel no meu computador?',
      onde: 'O navegador, em `http://localhost:3737`',
      leia: 'manutencao/painel',
      blocos: [
        { p: 'O painel roda como um serviço do computador. Abra `http://localhost:3737`. Se não abrir, veja se o serviço está ligado:' },
        { comando: 'systemctl --user status achadinhoturbo' },
        { p: 'Para reiniciar:' },
        { comando: 'systemctl --user restart achadinhoturbo' },
        { p: 'Depois de uma atualização da tela, recarregue com {{Ctrl}}+{{Shift}}+{{R}}.' },
        { p: 'Sem o serviço: no Windows, dê dois cliques em `iniciar.bat`. Nos outros sistemas, rode `npm start`.' },
        { p: 'Para só olhar, sem enviar nada, rode `npm run simular` na pasta do programa. Ele usa uma pasta separada, `data-simulacao`, e não mexe nos seus dados. Se a porta 3737 estiver ocupada pelo serviço, use o comando abaixo e abra `http://localhost:3799`:' },
        { comando: 'PORT=3799 npm run simular' },
      ],
    },
  ],
});
