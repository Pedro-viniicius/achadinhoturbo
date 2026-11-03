# achadinhoturbo

Programa **pessoal** que roda no seu computador e envia ofertas da sua **Central de Afiliados** do Mercado Livre para os seus grupos de WhatsApp, com link `meli.la` e **várias etiquetas** (cada regra usa a sua).

Além das regras automáticas, o painel faz **disparo manual** de uma oferta (do Mercado Livre ou da Amazon), **mensagens e enquetes** (agora, agendadas ou repetidas), **espelha ofertas da Amazon** postadas em outros grupos (veja [Espelhamento da Amazon](#espelhamento-da-amazon)) e manda **resumo diário e avisos** para o seu WhatsApp.

Você configura: grupos, template, quantas ofertas por envio, intervalo, horário de funcionamento e quanto tempo sem repetir a mesma oferta.

## Como funciona

```
Painel (localhost:3737) ── disparos, espelhamento, conexões, templates, grupos, avisos
        │
   Agendador
        │
        ├─ Mercado Livre ──► pede a lista de ofertas e o link meli.la ──► Extensão do Chrome (aba da Central de Afiliados, já logada)
        │
        ├─ Espelhamento (Amazon) ◄── mensagens dos grupos de origem (só links da Amazon)
        │       └──► resolve o ASIN ──► Creators API da Amazon (ou o texto da mensagem) ──► link .../dp/<ASIN>?tag=<sua tag>
        │
        └──────► WhatsApp Business (aparelho conectado, via QR) ──► grupos de destino (uma fila só, com as pausas de Ajustes)
```

O Disparo manual da Amazon segue o mesmo caminho do espelhamento, só que a oferta vem do link que você cola. O espelhamento automático ouve os grupos de origem e decide o que enviar; veja [Espelhamento da Amazon](#espelhamento-da-amazon).

Nenhum cookie do Mercado Livre sai do seu Chrome: a extensão devolve só a lista de produtos e o link pronto.

## Instalar

1. Instale o **Node.js 22.13 ou mais novo** (versão LTS em nodejs.org).
2. Windows: dê dois cliques em `iniciar.bat`. Outros sistemas: `npm install` e depois `npm start`.
3. Abra http://localhost:3737

Quer só olhar o painel sem conectar nada? Rode `npm run simular`. Nesse modo nada é enviado de verdade.

### Login do painel

Em casa, só no `localhost`, o painel abre sem login (aparece um aviso no terminal). Para proteger, abra *Conta → Equipe* e use **Ativar login**: você cria a sua conta de **Dono** (nome, e-mail e senha) e continua entrado neste navegador. Também valem `PANEL_PASSWORD` no primeiro start ou `npm run senha`; nesses dois casos o Dono é criado sem e-mail e entra só com a senha até completar o cadastro.

- **Quem já tinha senha:** no primeiro start desta versão, a senha única vira a conta do **Dono** (sem e-mail), e as sessões abertas continuam valendo. Ao entrar, o painel pede **"Complete seu cadastro"** (nome e e-mail; nova senha é opcional). Depois disso, o login pede **e-mail e senha**.
- A senha vira um hash no banco; a sessão fica num cookie `httpOnly` por 30 dias (cai depois de 7 dias sem uso) e sobrevive a reinícios. Cinco tentativas erradas bloqueiam o IP por 15 minutos. A mensagem de erro é sempre "E-mail ou senha incorretos.", sem dizer qual dos dois errou.
- **`npm run senha`** troca a senha do Dono (o mais antigo da equipe) e encerra **todas** as sessões. Serve para recuperar o acesso. Em "Complete seu cadastro" dá para escolher uma senha nova: as outras sessões dessa pessoa caem, a do navegador em uso fica.
- **Voltar à versão anterior:** a senha única continua guardada e acompanha a senha do Dono mais antigo, então o código antigo entra com ela.

### Publicar num servidor (VPS)

**Nginx:** além do proxy, defina `proxy_set_header X-Forwarded-For $remote_addr;` e `proxy_set_header X-Forwarded-Proto $scheme;` (o programa confia nesses cabeçalhos para o limite de tentativas de login e para o HSTS; sem reescrevê-los, um cliente pode falsificá-los) e `server_name` só com o seu domínio. Variáveis de ambiente: `PUBLIC_HOST` (ex.: `disparador.meudominio.com`; exigido para aceitar o domínio e a origem `https://`), `PORT` (padrão 3737), `DATA_DIR` (pasta dos dados), `TZ` (ex.: `America/Sao_Paulo`; o horário de funcionamento das regras usa a hora local) e `PANEL_PASSWORD`. Com `PUBLIC_HOST` definido, o programa se recusa a subir sem login (senha ou conta de Dono). Ele continua ouvindo só em `127.0.0.1`: coloque um Nginx com HTTPS na frente. No `/api/ext/poll` (long-poll de 20 s) use `proxy_buffering off` e `proxy_read_timeout 60s`; no `/api/ext/result` aceite corpos de até 8 MB. Encerra limpo com SIGTERM.

### Backup

`npm run backup [pasta]` copia o banco com `VACUUM INTO` (seguro com o programa rodando) e a sessão do WhatsApp num `.tar.gz`, mantendo os 7 mais recentes. O destino padrão é `data/backups/`, que o `.gitignore` já exclui; se você apontar para dentro de um repositório git não ignorado, o script avisa. **Nunca faça commit de um backup.** Para conferir um backup: `npm run backup -- restaurar arquivo.tar.gz pasta-vazia` (extrai e roda `PRAGMA integrity_check`). **O pacote contém a sessão do seu WhatsApp**: trate como senha. Ele também leva o ID e o segredo da credencial da Amazon e, com o espelhamento, **textos de mensagens de grupos de terceiros** (já mascarados; veja [Privacidade (LGPD)](#privacidade-lgpd)).

## Menu do painel

O menu lateral é dividido em grupos:

- **Visão Geral**
- **Principal**: Rotacionador de Links, Grupos, Blocos de análise
- **Disparos**: Disparo manual, Disparo automático (antes chamado *Regras*; é onde fica o botão *Novo espelhamento*), Disparar mensagem, Templates
- **Comunicação**: Relatórios e avisos
- **Conta**: Conexões, Números de WhatsApp, Equipe (só o Dono vê)
- No rodapé: Histórico (com o seletor *Tipo*: Tudo, Disparo automático ou Espelhamento), Ajustes, Ajuda

Os endereços antigos continuam funcionando: `#regras` abre *Disparo automático*, `#whatsapp` abre *Números de WhatsApp* e `#etiquetas` abre *Conexões* (na seção do Mercado Livre).

## Visão Geral, blocos e rotacionador

- **Visão Geral**: funil do período (cliques nos links → entradas pelo link ou adicionados → saídas), saldo, tempo médio no grupo, quem abriu o grupo (leu alguma mensagem sua), gráfico de entradas e saídas por hora ou por dia, evasão (quem entrou e saiu no mesmo dia, em 7 dias, ontem e total), tabela por grupo e eventos. Tudo vem do que o WhatsApp informa enquanto o programa está conectado: antes disso não há histórico.
- **Blocos de análise**: agrupe grupos por nicho (com uma etiqueta do Mercado Livre opcional). A Visão Geral filtra por bloco, e ao criar uma regra de disparo automático você pode marcar um bloco inteiro.
- **Rotacionador de Links**: `/g/<nome>` leva para o primeiro grupo da lista com vaga (modos: encher um por vez, alternar entre até 3, encher e reabrir ao esvaziar), com limite por grupo, URL reserva e contagem de cliques. Só grupos com convite entram: em *Grupos*, use *Buscar convite* (precisa ser admin) ou cole o link. **No seu computador o endereço só abre para você**; para o público, o programa precisa estar publicado na internet.
- **Próximo grupo (com confirmação)**: ligando a opção no link, quando um grupo chega a 95% do limite o painel propõe um grupo novo igual (nome com o número seguinte, descrição, foto, permissões e admins). Nada é criado até você clicar em *Criar agora*. O grupo novo entra no link logo depois do que lotou, nos mesmos blocos e nas mesmas regras. Criar grupos é a ação que mais chama a atenção do WhatsApp: evite criar vários no mesmo dia.

## Primeiros passos

1. **Conexões → Mercado Livre**: cadastre os nomes das suas etiquetas, escritos como no programa de afiliados.
2. **Números de WhatsApp** e **Grupos**: clique em *Conectar WhatsApp* e leia o QR no WhatsApp Business (Aparelhos conectados).
3. **Templates**: ajuste a mensagem. Linha com campo vazio some sozinha. `{TITULO_PRODUTO}` sai **abreviado** (só o que identifica o produto: tira "Compatível com…", "Premium", "Alta Qualidade" e corta em até 60 caracteres sem partir palavra; o tamanho muda em *Ajustes*, 0 desliga). `{TITULO_COMPLETO}` é o nome inteiro. Um pedaço entre colchetes, como `[ ({DESCONTO_PRODUTO} OFF)]`, some sozinho quando falta o dado (veja [Template com trecho opcional](#template-com-trecho-opcional)).
4. **Extensão** (abaixo). Sem ela, nem a lista de ofertas nem o link de afiliado são gerados.
5. **Disparo automático**: crie uma regra escolhendo etiqueta, template, grupos e ritmo. A fonte padrão é a **Central de Afiliados**: a lista "Produtos selecionados para você", com busca, **uma ou várias categorias** (com várias, as ofertas saem intercaladas, bom para grupos de achadinhos gerais), ordem, "só mais vendidos" e "só com ganhos extras". Uma regra aceita **até 5 fontes** (Central com filtros diferentes, listas de links, buscas, misturadas): as ofertas saem intercaladas, uma de cada fonte por vez, e uma fonte que falhar vira aviso sem travar as outras. A etiqueta é uma por regra: para etiquetas diferentes no mesmo grupo, crie outra regra apontando para o mesmo grupo. Use *Ver ofertas* para conferir antes e *Enviar agora* para testar.

## Disparo manual

Em *Disparos → Disparo manual* você manda uma oferta específica sem criar regra:

1. Cole o link do produto e clique em **Identificar**. O programa reconhece a loja, lê o produto e monta a mensagem com o template escolhido.
2. Escolha o **template**, a **etiqueta** (só no Mercado Livre) e os grupos.
3. Envie **agora** ou **agende para hoje** (só o mesmo dia; para repetir, use *Disparar mensagem*).
4. O histórico mostra o que foi enviado, está na fila ou deu erro (últimos 30 dias nos contadores).

**Hoje o Mercado Livre e a Amazon enviam.** Se o link for de Shopee, Magalu ou Facebook, o programa reconhece e avisa que a loja **não está conectada** (ainda não implementada), sem enviar nada.

**Links `meli.la` da Central de Afiliados:** o painel lê a página do afiliado para a qual eles redirecionam e gera o link a partir do produto.

### Disparo manual com um link da Amazon

Precisa da **tag de associado** salva em *Conexões → Amazon*. Sem ela o botão de disparar fica desabilitado: o link da Amazon sempre sai com a sua tag. A extensão do Chrome não é usada.

1. Cole o link e clique em **Identificar**. Aceita `amazon.com.br/dp/…`, `amazon.com.br/<nome>/dp/…`, `link.amazon`, `amzn.to`, `amzn.com` e `a.co`. O programa abre o link curto seguindo os redirecionamentos (só em endereços da Amazon, sem ler a página) até achar o código do produto (o **ASIN**) e consulta a API oficial, se houver acesso.
2. A seção **Dados da oferta** vem preenchida e dá para editar: título (até 200 caracteres), preço atual, preço antigo (só vale se for maior que o atual; senão a linha "De" some), cupom (até 30 caracteres), **frete grátis** e a **foto** (trocar por JPG ou PNG de até 5 MB, ou remover; sem foto a mensagem sai só com texto). O desconto é calculado dos dois preços.
3. A prévia mostra a mensagem com o template escolhido, com a tag escondida (`tag=•••`). O link que vai ao grupo é sempre `https://www.amazon.com.br/dp/<ASIN>?tag=<sua tag>`, montado na hora do envio.
4. Se a API não responder (sem credencial, conta sem acesso, limite de consultas ou instabilidade), a tela diz o motivo e deixa os campos em branco para você preencher; o **título é obrigatório**. Link que não leva a um produto (busca, lista, loja) ou que não abre é recusado com a explicação.
5. Envie **agora** ou **agende para hoje**, como no Mercado Livre.

## Disparar mensagem

Em *Disparos → Disparar mensagem* você envia texto livre ou uma enquete para os grupos:

- **Mensagem**: aceita a formatação do WhatsApp (`*negrito*`, `_itálico_`, `~riscado~`). Até 4096 caracteres.
- **Foto** (opcional): JPG ou PNG de até 5 MB, conferida pelo conteúdo do arquivo. Antes de guardar, a foto é **regravada**: girada se preciso (a foto em pé do celular continua em pé) e **sem metadados** (EXIF, localização, modelo do aparelho), que não chegam aos grupos. Arquivo que não abre como foto é recusado.
- **Prévia do link** (opcional): só para links do Mercado Livre.
- **Enquete**: pergunta de até 255 caracteres e de **2 a 12 opções** (até 100 caracteres cada), com opção de **múltipla escolha**.
- **Quando**: **agora**, **agendar** (data e hora) ou **repetir** (escolha os dias da semana e **até 6 horários** por dia).
- Um envio **repetido** pode ser **pausado** e **retomado**; agendados e repetidos podem ser **cancelados**. O histórico mostra o resultado de cada envio.
- Um agendado que **perde o horário por mais de 2 horas** (programa desligado, por exemplo) **não sai mais** e vira erro no histórico. Se o horário foi perdido por menos que isso, ele sai assim que o programa voltar.
- Agendados e repetições **sobrevivem a reinício**: ficam no banco e retomam sozinhos.
- Todo envio, inclusive o **"agora"**, sai pela **mesma fila** das regras automáticas, com a pausa entre mensagens de *Ajustes*. Por isso pode haver atraso de alguns minutos enquanto uma regra está enviando; os envios entram entre as regras.
- Repetições e enquetes aumentam o volume de envio e o risco de restrição do número: use com moderação.

## Espelhamento da Amazon

O programa vigia os **grupos de origem** que você escolher, pega os links da Amazon que aparecem neles, busca título, preço e foto e envia a oferta completa (**imagem com legenda**) para os seus **grupos de destino**. O link sai sempre limpo e com a **sua** tag: `https://www.amazon.com.br/dp/<ASIN>?tag=<sua tag>`, sem o nome do produto, sem rastreio e sem a tag de quem postou na origem.

Tudo isto foi testado só com a Amazon e o WhatsApp **simulados** (veja [O que foi testado e o que não foi](#o-que-foi-testado-e-o-que-não-foi)): quem confirma que a sua conta funciona de verdade é o botão **Testar** em *Conexões → Amazon* e um primeiro espelhamento com um produto novo.

### Antes de começar

1. **A tag de associado vai no cartão Amazon, em *Conexões → Amazon*, campo "Tag de associado"** (por exemplo, `seunome-20`). **Não** é a lista de etiquetas de *Conexões → Mercado Livre*: aquelas são só do Mercado Livre e o espelhamento da Amazon não as usa. Sem a tag salva, o espelhamento não liga e o Disparo manual da Amazon não dispara.
2. **WhatsApp conectado**, com o número dentro dos grupos de origem **e** de destino (só aparecem na lista os grupos em que o número está). O programa só vê o que chega **enquanto está conectado**.
3. **Credenciais da Creators API: opcionais.** Com elas, título, preço, preço antigo, desconto e foto vêm da Amazon. Sem elas, o programa usa o que estiver escrito na mensagem de origem (veja [Formato de mensagem de origem que funciona](#formato-de-mensagem-de-origem-que-funciona)) e o que faltar você completa na [fila](#fila-para-completar). Requisitos da API, que substituiu a antiga PA-API 5 (as chaves antigas **não funcionam**):
   - **Conta de Associados da Amazon.com.br aprovada em definitivo.** Só o **titular principal** da conta consegue se cadastrar na API.
   - **Pelo menos 10 vendas qualificadas nos últimos 30 dias**, pelos seus links da **Amazon.com.br**. Sem isso a API responde "sem acesso" e o painel diz "a conta ainda não tem acesso". O acesso é **revogado depois de 30 dias seguidos sem vendas** e **volta em até 2 dias** depois que vendas referidas são enviadas, sem reconfigurar nada. A documentação da Amazon não diz "por loja" com todas as letras, mas conta, tag e cadastro são por loja.
   - **Credenciais:** na Central de Associados, *Ferramentas → Creators API → Create Application → Add New Credential*. Copie ou baixe o CSV com **Credential ID**, **Secret** e **Version** (espera-se `3.1`). Cada loja aceita 2 aplicativos, e cada aplicativo 2 credenciais; o programa usa uma só.
   - **A tag precisa ser da mesma loja da credencial.** Tag de outra loja é recusada ("A tag não pertence a esta credencial/loja").
   - **Loja/região:** `www.amazon.com.br`, fixa. Link de `amazon.com` (EUA) tem o código lido, mas o produto é buscado e o link montado na Amazon.com.br (se não existir lá, a oferta vai para a fila com o motivo).

### Passo a passo

1. **Conexões → Amazon** (só o Dono salva e testa): preencha a **tag**. Para usar a API, preencha também o **ID da credencial**, o **segredo da credencial** e a **versão** (`3.1` para o Brasil), clique em **Salvar** e depois em **Testar**. O teste confere a credencial, se a conta tem acesso e se a tag casa com ela. O ID e o segredo ficam só no seu computador e **não voltam para a tela** (depois de salvos, o campo só mostra que está preenchido; vazio mantém o salvo). Resultados do teste: "Credencial aceita pela Amazon", "A Amazon não aceitou a credencial", "A credencial é válida, mas a conta ainda não tem acesso à API", "A tag não pertence a esta credencial/loja" ou "A Amazon não respondeu agora".
2. **Disparo automático → Novo espelhamento**: dê um nome; marque os **grupos de origem** e os **grupos de destino**; escolha o **template** (precisa do campo `{LINK}`), as **palavras bloqueadas**, o que fazer **quando faltar o preço** e o ritmo (veja [Regras do espelhamento](#regras-do-espelhamento)); salve ligado ou desligado. Um grupo não pode ser origem e destino ao mesmo tempo. Se o número sair de um grupo do espelhamento, o cartão avisa qual.
3. **Acompanhe**: o cartão do espelhamento mostra os números das últimas 24 h (espelhadas, descartadas, na fila); "espelhadas" conta só o que chegou a algum grupo ou ainda está saindo. Em *Histórico*, o seletor **Tipo → Espelhamento** lista cada oferta com o resultado e o motivo: "Espelhada" (com dados da Amazon, com o texto da origem, no formato curto ou completada à mão), "Descartada: palavra bloqueada (usado)", "Descartada: repetida (enviada há 3 h)", "Descartada: link não resolvido", "Na fila: falta completar" ou erro de envio (inclusive quando o envio perdeu o horário porque o WhatsApp ficou fora mais de 2 h). O Histórico mostra só o **nome do grupo** de origem, nunca quem postou nem o texto da mensagem.
4. **Complete a fila**: veja [Fila para completar](#fila-para-completar).
5. **Uma oferta isolada** (sem espelhamento): use o [Disparo manual com um link da Amazon](#disparo-manual-com-um-link-da-amazon).

Teste sempre com um produto **novo**: o mesmo produto repetido é descartado como "repetida" (parece falha, mas é a regra).

### O que acontece com uma mensagem

```
Grupo de origem: alguém posta uma mensagem com link da Amazon
   │  o programa recebe só: grupo, hora, id e texto (nunca quem postou)
   ▼
Recebe e guarda um item por link da Amazon (texto mascarado; resto da conversa é descartado)
   │  ignora: link que já leva a sua tag · mensagem do seu número (se a opção estiver desligada)
   │          · o mesmo produto repetido na mesma mensagem
   ▼
Agendador (a cada 15 s, ou na hora em que a mensagem chega)
   │  fora do horário, ou acima do máximo por hora ──► ESPERA e sai quando puder
   ▼
1. Resolve o link ──► ASIN        (não resolve: "Descartada: link não resolvido" / "não é um produto")
2. Já saiu há menos de N horas? ──► "Descartada: repetida"
3. Dados: API da Amazon (prioridade) e/ou texto da mensagem, campo a campo
4. Palavra bloqueada no título ou na mensagem? ──► "Descartada: palavra bloqueada"
5. Tem título e preço? ──► sim: segue
                       └─► não: "Na fila" (você completa) ou formato curto, conforme a regra
   ▼
Template ──► imagem com legenda (ou só texto) com o link …/dp/<ASIN>?tag=<sua tag>
   ▼
Fila única de envios (pausas de Ajustes) ──► grupos de destino (nunca o de origem)
```

Em palavras:

1. O programa lê o link da mensagem (aceita `amazon.com.br/dp/…`, `amazon.com.br/<nome>/dp/…`, `link.amazon`, `amzn.to`, `amzn.com` e `a.co`, com ou sem parâmetros e até sem `https://`). Se for link curto, abre-o **só** em endereços da Amazon, seguindo os redirecionamentos, até achar o código do produto (o **ASIN**). Não lê a página.
2. Confere a repetição (veja [Não repetir a mesma oferta](#não-repetir-a-mesma-oferta)).
3. Junta os dados (veja [De onde vêm os dados](#de-onde-vêm-os-dados)), confere as palavras bloqueadas e, com título e preço, monta a mensagem com o template e coloca o envio **na fila de envios**. Os dados são consultados **na hora de enviar**: uma oferta que esperou a janela abrir sai com o preço atual.
4. A mensagem sai como **imagem com legenda** quando há foto (a que a Amazon devolve, só de endereços de imagem da própria Amazon). Sem API não há foto: a mensagem sai só com texto. Se a foto não carregar, também sai só com texto.
5. O envio vai para os grupos de destino **menos o grupo de onde a oferta veio**, com as pausas entre mensagens de *Ajustes*, e aparece no *Histórico*.

Se o agendador cair no meio de uma decisão, os itens que ficaram "em processamento" voltam à fila de decisão quando o programa reinicia.

### Regras do espelhamento

- **Só mensagens novas, de grupos.** O programa não reprocessa histórico: o que foi postado com o WhatsApp desconectado ou o programa desligado se perde. Conversa privada é ignorada, e só links da Amazon interessam. Só os primeiros **4096 caracteres** da mensagem são lidos.
- **Espelhar também mensagens enviadas pelo meu número**: **desligado por padrão**. Ligue quando um grupo de origem é seu e você mesmo posta as ofertas. Mensagem de outro número vale sempre.
- **Sem laço.** Um grupo não pode ser origem e destino do mesmo espelhamento; o grupo de onde a oferta veio nunca recebe a própria oferta; as mensagens que o próprio programa envia são ignoradas; e link que já leva a **sua** tag é ignorado.
- **Mensagem com mais de um link**: até 5 links são lidos e cada produto da Amazon vira uma oferta. O texto da mensagem descreve **um** produto só: se a mensagem tem produtos diferentes, o texto não é usado para nenhum deles (só a API; sem ela, cada oferta vai para a fila ou sai no formato curto).
- **Limite de links**: no máximo **60 links por hora**, por espelhamento e por grupo de origem. Passou disso, os seguintes são ignorados até a hora seguinte (uma linha no log avisa), para um grupo muito ativo não sobrecarregar a Amazon.
- **Ritmo**: até **10 por hora** por espelhamento (padrão; 0 = sem limite) e, se você definir, uma **janela de horário** ("Funciona das … até …", hora do computador; pode virar a noite). Fora da janela, ou acima do máximo por hora, a oferta **espera** e sai quando puder, com os dados consultados de novo na hora. Só conta para o máximo a oferta que chegou a algum grupo ou ainda está na fila de envio.
- **Item parado**: oferta que ficou mais de **2 horas** esperando para ser decidida porque o programa esteve desligado ou fora do ar **expira** em vez de sair velha. A espera pela janela ou pelo máximo por hora não é "parada": ela sai quando a hora chegar.
- **Foto**: *Enviar com foto, quando houver* ou *Só texto*.
- **Quando falta o título ou o preço** (nem a API nem o texto trouxeram): veja [Formato curto e fila](#formato-curto-e-fila).
- **Palavras bloqueadas**: veja [Palavras bloqueadas](#palavras-bloqueadas).
- **Sem tag**, o espelhamento não liga; um espelhamento ligado cuja tag foi apagada em Conexões aparece com aviso e as ofertas dele terminam como erro até você cadastrar a tag. Template apagado ou sem `{LINK}` também vira erro, com o motivo.

### Não repetir a mesma oferta

O mesmo produto (ASIN) não é reenviado pelo mesmo espelhamento dentro de **168 horas** (padrão; configurável de 0 a 8760 no campo "Não repetir a mesma oferta por (horas)"; **0 = pode repetir**). O item fica "Descartada: repetida (enviada há N h)". É a mesma oferta mesmo com link diferente (curto, longo, com tag de terceiro). Só conta como enviada a oferta que chegou a pelo menos um grupo (ou que ainda está na fila de envio): se o envio falhou em todos os grupos, a próxima postagem do mesmo produto sai normalmente. A regra vale por espelhamento: dois espelhamentos diferentes podem enviar o mesmo produto.

### Formato curto e fila

Quando falta o **título ou o preço** (a API não trouxe e a mensagem de origem também não), a regra "Quando faltar o preço" decide:

- **Esperar eu completar** (padrão): a oferta vai para a [fila](#fila-para-completar), e o motivo fica no Histórico e no log.
- **Enviar mesmo assim, no formato curto**: sai na hora só o que houver (foto e os dados que existirem) e o link; a linha do template sem valor some. Evita perder a oferta, mas pode sair uma mensagem quase só com o link.

Em dois casos o item vai para a fila mesmo com a regra em formato curto: quando a API responde que o produto **não existe na loja do Brasil** e quando ela diz que está **indisponível**.

### De onde vêm os dados

1. A **API** tem prioridade: título, preço, preço antigo, desconto e foto. A API **não informa** vendas, frete nem cupom.
2. O **texto da mensagem de origem** completa campo a campo o que a API não trouxe (vendas, frete grátis, cupom, ou tudo, se a API estiver fora). O "NN% OFF" escrito na origem só vale quando o preço também veio do texto; com preço da API o desconto vem da API ou da conta entre os dois preços. Preço antigo só entra quando é maior que o atual: **nenhuma linha "De" é inventada**.
3. O **link da mensagem** só serve para achar o produto: o link enviado é sempre reconstruído com o código do produto e a sua tag.

Se a API pedir para esperar (limite de consultas) por até 2 minutos, o item espera e tenta de novo (até 3 vezes); acima disso, segue só com o texto. A API devolve os dados do mesmo produto por até 15 minutos de uma consulta para a outra (cache em memória, nada vai ao banco).

O programa **não lê a página da Amazon** (isso é contra as regras do programa de Associados): só segue os redirecionamentos do link curto e consulta a API. Se um encurtador não redireciona (responde uma página em vez de um redirecionamento), o item fica "link não resolvido": cole o link longo no Disparo manual.

### Fila para completar

Oferta a que falta o **título ou o preço** (e o espelhamento está em *esperar eu completar*) fica em **"Na fila: falta completar"**. Em *Histórico → Tipo → Espelhamento*, clique em **Completar**: preencha ou ajuste título, preços, cupom, frete e foto (os mesmos campos do Disparo manual), veja a prévia e clique em **Enviar** para os grupos do espelhamento, ou em **Descartar**. Depois de enviada, a linha vira "Espelhada · completada à mão". As palavras bloqueadas valem de novo para o título que você digitar. Se outra pessoa da equipe já tratou a oferta, a tela avisa "Esta oferta já foi tratada." Se o mesmo produto já foi espelhado dentro das horas de "não repetir" (por exemplo, duas ofertas iguais na fila), o Completar avisa e a oferta sai da fila como "repetida", sem enviar. Completar exige a tag salva e o WhatsApp conectado.

A fila expira sozinha: oferta que ninguém completou em **24 horas** (ou nas horas de "não repetir", se forem mais; com o padrão de 168 h, são 7 dias) vira "Descartada: expirou sem ser completada". A fila é aberta a qualquer pessoa da equipe com login (Dono ou Operador).

### Palavras bloqueadas

Uma lista por espelhamento, uma palavra por linha ou separadas por vírgula (até 50 palavras de até 60 caracteres). **Não diferencia maiúscula, minúscula nem acento**: "usado" barra "Usádo" e "USADOS". Casa no **início da palavra**: "usado" pega "usados", mas não "acusado". As palavras são procuradas no **título** (da API ou do texto) e no **texto da mensagem de origem**; achou, a oferta não é enviada e aparece como "Descartada: palavra bloqueada (usado)". Lista vazia não bloqueia nada.

### Template com trecho opcional

Um trecho entre colchetes com campo dentro, como `[ ({DESCONTO_PRODUTO} OFF)]`, **some sozinho** quando algum campo dele está vazio; a linha continua. Se todos os campos do trecho têm valor, os colchetes saem e o conteúdo fica.

- Campo vazio **fora** de colchetes continua apagando a **linha inteira** (como sempre foi).
- Colchetes **sem campo** dentro ficam como estão, e `[` ou `]` soltos também. Não há colchete dentro de colchete.
- Sem preço antigo, **nenhuma linha "De" é inventada**.
- O template **Amazon** é criado uma única vez (em instalação nova ou antiga) e já usa o trecho opcional no desconto: sem desconto, só o "(NN% OFF)" some e a linha do preço fica. Se você apagar ou renomear esse template, ele **não** volta.
- Os templates novos já nascem assim. O template **Padrão** que já existe no seu banco **não** muda sozinho: para ter o mesmo efeito, troque o trecho do desconto por `[ ({DESCONTO_PRODUTO} OFF)]` na tela *Templates*.
- O template do espelhamento precisa do campo `{LINK}`.

### Formato de mensagem de origem que funciona

Quando a API não responde, quem escreve a mensagem na origem decide o que o programa consegue ler. Este formato (o que o dono viu funcionar) é lido por inteiro:

```
Roteador Mesh TP-Link Deco BE22, Wi-Fi 7, Pack com 3 Unidades
De R$ 1.999,00
Por R$ 1.310,05
34% OFF
+200 compras no mês passado
Frete Grátis
Compre aqui: https://www.amazon.com.br/dp/B0FG2MD49G
```

- **Título na primeira linha** (a primeira linha sem preço, sem link e que não seja só emoji; de 3 a 200 caracteres). Se essa linha tiver algo com cara de link, mesmo sem `https://` (como `bit.ly/…`, `chat.whatsapp.com/…`, `wa.me/…`, um domínio solto como `golpe.ru` ou palavras grudadas por ponto como `3un.Cor`) ou um `@usuario`, o título do texto é descartado por segurança: a oferta vai para a fila (ou sai no formato curto).
- **Uma informação por linha**: `De R$ …` é o preço antigo, `Por R$ …` o preço atual, `NN% OFF` o desconto, `+200 compras`/`vendidos`/`vendas` as vendas, `Frete Grátis` o frete.
- **Sem "De" quando não há preço antigo.** Um preço só, sem "De/Por", é o preço atual. Dois preços sem rótulo: o maior é o antigo. Parcela ("3x de R$ 33,33") não conta como preço.
- **Cupom só com a palavra "cupom"** seguida do código (`Cupom DESEJO10`). Link **nunca** é cupom.
- **"Compre aqui:" antes do link** (na linha de baixo ou na mesma linha de "Frete Grátis") e, de preferência, o link no formato `https://www.amazon.com.br/dp/<ASIN>`. O link curto (`link.amazon`, `amzn.to`) também funciona quando redireciona. Parâmetros e a tag de terceiro que vierem no link são descartados.
- Uma mensagem **só com o link** não traz título nem preço: com a API ela sai completa; sem a API vai para a fila (ou sai no formato curto).
- Até **5 links por mensagem** são lidos (cada um com até 2048 caracteres); cada produto da Amazon vira uma oferta, e o texto só descreve bem **um** produto por mensagem.
- Como o texto é guardado mascarado (veja [Privacidade](#privacidade-lgpd)), um número de **8 ou mais dígitos** no título (código de modelo, por exemplo) ou num preço de milhões vira "…" antes da leitura. Preço comum ("R$ 1.310,05") passa intacto.

### Pendências do dono

Estas duas decisões **ainda são suas** e a equipe não as tomou por você:

1. **Licença da Creators API e Operating Agreement da Amazon.** A equipe **não leu** esses termos. Falta conferir se eles permitem guardar preços por alguns minutos (o programa guarda os dados da API em memória por até 15 minutos por produto) e usar esses dados em mensagens de WhatsApp. Confira antes de depender da API em produção.
2. **User-Agent de navegador para abrir o link curto.** Para o `link.amazon` devolver o redirecionamento, o programa se apresenta como um navegador comum (Chrome) ao abrir o link, só em endereços da Amazon e sem ler a página. Se você não quiser esse comportamento, diga: sem ele, link curto pode não resolver e só links longos (`…/dp/<ASIN>`) funcionam.

O endereço da API (`creatorsapi.amazon`) e os nomes dos campos da resposta vêm da documentação da Amazon e **nunca foram conferidos contra a Amazon real**: o botão **Testar** é quem confirma isso na sua conta.

## Relatórios e avisos

Em *Comunicação → Relatórios e avisos* você cadastra os **números que recebem** o resumo diário e os avisos, direto no WhatsApp:

- **Números de destino**: para cada número, escolha se recebe o **resumo diário**, quais **blocos** entram nele (todos os grupos ou só alguns blocos) e quais **avisos** quer. A lista mostra o número mascarado. O programa confere no WhatsApp se o número existe (no máximo **10 cadastros a cada 10 minutos**) e o **nome** do destino não pode conter telefone (6 dígitos ou mais).
- **Resumo diário**: sai uma vez por dia, no **horário do resumo** (padrão 21:00), com os números do dia, para todos os grupos ou por bloco: grupos e membros, quantos entraram, quantos saíram, a % de quem entrou e saiu no mesmo dia, quantas pessoas abriram as suas mensagens e os cliques nos links do rotacionador. Se o programa estava desligado no horário, o resumo sai atrasado, desde que ainda seja o mesmo dia. Há **prévia** e **Enviar resumo agora** para testar.
- **Virada do dia**: define a hora em que o dia "começa" para a Visão Geral, o resumo e os blocos (padrão 00:00, como antes). Com virada às 02:00, uma entrada às 01:30 conta no dia anterior, e as leituras também passam a ser contadas por esse "dia de negócio". Não use o mesmo horário para o resumo e para a virada: o resumo sairia com o dia zerado.
- **Limite padrão por grupo**: só preenche o limite de cada link **novo** do rotacionador (padrão 1000). Links que já existem não mudam: o aviso de lotação usa o limite de cada link.
- **Aviso de grupo lotando**: quando um grupo do rotacionador chega a 95% do limite. Avisa uma vez por grupo, até ele esvaziar.
- **Aviso de erro de disparo**: mensagem **agregada** com os erros novos, **no máximo 1 a cada 30 minutos**. Só sai com o WhatsApp conectado: se ele caiu, o aviso chega quando voltar.

## Conexões

Em *Conta → Conexões* ficam os cartões das lojas:

- **Mercado Livre**: etiquetas e a extensão do Chrome (que antes ficavam em *Etiquetas* e *Ajustes*). O cartão diz o que falta para o disparo funcionar.
- **Amazon**: tag de associado, ID e segredo da credencial da API e versão da credencial, com o botão **Testar**. O selo do cartão diz em que ponto está: *Falta configurar* (sem tag), *Só com a tag* (os dados vêm do texto da mensagem), *Credencial salva* (ainda não confirmada) ou *Conectada* (a Amazon aceitou). Passo a passo e requisitos em [Espelhamento da Amazon](#espelhamento-da-amazon).
- **Shopee, Magalu e Facebook**: mostram **"ainda não implementado"**. Você já pode preencher e salvar os dados (AppID e chave, nome da loja de parceiro etc.), mas nenhum envio usa essas lojas ainda. Hoje só o Mercado Livre e a Amazon enviam.
- **Segredos nunca voltam ao navegador**: depois de salvos, o painel só mostra que o campo está preenchido. Deixar o campo vazio mantém o valor salvo; digitar um valor novo substitui.

## Equipe

Em *Conta → Equipe* o Dono dá acesso ao painel para outras pessoas. Cada uma entra com o próprio e-mail e senha.

- **Papéis:** **Operador** usa as telas do dia a dia, mas não vê *Equipe* nem pode gerar novo token da extensão, desconectar o WhatsApp, apagar dados antigos (*Ajustes*) ou salvar e testar *Conexões* (nem ver quais segredos estão salvos). **Dono** faz tudo isso e também convida, remove pessoas e muda papéis. O servidor confere o papel a cada pedido: uma troca vale na hora.
- **Convidar:** informe o e-mail e o papel e clique em *Criar convite*. **Nenhum e-mail é enviado**: copie o link e mande pelo WhatsApp. A pessoa abre o link, escolhe nome e senha e já entra. O link vale **7 dias** e **uma vez só**.
- **O link só aparece completo na hora em que é criado.** Depois, *Copiar link* na lista gera um link **novo** e o anterior deixa de funcionar (o painel guarda só uma impressão do link, não o link). *Cancelar* invalida o convite. Link inválido, vencido, usado ou cancelado mostra sempre a mesma mensagem: "Este convite não vale mais".
- **Proteções:** ninguém muda o próprio papel nem remove a si mesmo, e a equipe sempre fica com ao menos um Dono. Remover alguém encerra as sessões dessa pessoa na hora.
- Convites usados, cancelados ou vencidos há mais de 30 dias são apagados quando a tela *Equipe* é aberta. O *Histórico* registra entradas, trocas de papel e remoções pelo **nome** da pessoa, nunca pelo e-mail.

## Extensão do Chrome

1. No Chrome, abra `chrome://extensions`, ligue o **Modo do desenvolvedor** e clique em **Carregar sem compactação**. Escolha a pasta `extension`.
2. Clique no ícone da extensão e cole o **endereço** e o **token** que aparecem em *Conexões → Mercado Livre* no painel.
3. Entre na sua conta de afiliado do Mercado Livre nesse mesmo Chrome.

O Chrome precisa ficar aberto enquanto as regras rodam. A extensão abre sozinha uma aba fixada da Central de Afiliados quando precisa; se a sessão vencer, ela recarrega a aba e tenta de novo. Se ainda assim falhar, o *Histórico* mostra "não há sessão de afiliado neste Chrome": basta entrar de novo na conta.

## O que foi testado e o que não foi

Testado (`npm test`, mais de 100 testes; a saída do comando mostra o número atual): disparo manual, mensagens e enquetes (agendamento, repetição, pausar e cancelar, retomada após reinício, atraso máximo), conexões e segredos, avisos e resumo diário, equipe (migração da senha única, login por e-mail, convites, papéis), várias fontes por regra, próximo grupo, visão geral, eventos de grupo, blocos, rotacionador, login, sessão, Host/Origin, token da extensão, cabeçalhos, backup e restauração, várias categorias, template, horário de funcionamento (inclusive virando a noite), envio para vários grupos, etiquetas separadas por regra, não repetir ofertas, filtros de preço e desconto, leitura da lista da Central de Afiliados, fila de pedidos com a extensão, API do painel e proteções. Da Amazon: o ASIN de cada formato de link, o link curto resolvido por redirecionamentos simulados, a API e o texto da origem (com as mensagens de exemplo do dono), o template com trecho opcional, o ouvinte de mensagens dos grupos, o cartão em Conexões e o Disparo manual. O espelhamento: receber a mensagem (formatos de texto, anti-laço, só grupos), decidir cada item (repetida, palavra bloqueada, janela e máximo por hora, fila, formato curto, completar, expirar, recuperar após queda), as rotas, a ligação ao agendador e a privacidade, tudo com `fetch` e WhatsApp simulados.

Conferido uma vez contra a Central de Afiliados real (02/11/2026): a lista de produtos e a geração do link `meli.la` com etiqueta. O Mercado Livre pode mudar esses endereços sem aviso; se isso acontecer, o *Histórico* mostra o motivo. **Não testado contra o WhatsApp real**, porque exige a sua conta. **A Amazon também nunca foi testada de verdade**: a Creators API, o token e os encurtadores são sempre simulados nos testes. Quem confirma que a sua conta tem acesso é o botão **Testar** em *Conexões → Amazon*.

- Na fonte *Lista de links*, se o título e o preço não forem lidos sozinhos, escreva-os na linha: `link | título | preço | preço antigo | cupom`.
- A *Busca por palavra-chave* é experimental: a API pública do Mercado Livre pode recusar o acesso sem login.

## Privacidade (LGPD)

- Quem entra, sai ou lê mensagens nos grupos é guardado com um **pseudônimo** (HMAC-SHA256 do número com uma chave local que fica só no banco), nunca com o número. O painel mostra só os primeiros caracteres do pseudônimo.
- **Números de telefone e e-mails em `data/`:** além do pseudônimo dos membros, o banco guarda os **números de WhatsApp que você cadastra para receber avisos** (tabela `aviso_destinos`) e os **nomes e e-mails da equipe e dos convidados** (tabelas `users` e `invites`). A API mostra o número mascarado; o programa não escreve número nem e-mail no log nem em mensagem de erro. **Os backups carregam tudo isso**: trate-os como dado pessoal.
- **Convites:** o banco guarda só uma impressão (hash) do link, nunca o link. Convites usados, cancelados ou vencidos são apagados 30 dias depois, na próxima vez que a tela *Equipe* abre. Para apagar os dados de alguém da equipe, remova a pessoa em *Equipe* (o e-mail ainda fica no convite que ela usou até essa limpeza).
- **Espelhamento da Amazon**: o programa ouve os grupos de origem, mas entrega ao espelhamento só `{ grupo, se foi do seu número, texto, id da mensagem, hora }`: **nunca o número, o identificador nem o nome de exibição de quem postou**. Só os links da Amazon são tratados; o resto da conversa é descartado. Na tabela `espelho_itens` ficam o JID e o **nome do grupo** de origem, o id da mensagem (só para não processar duas vezes) e o **texto da mensagem**, guardado **mascarado** (e-mails, telefones e qualquer sequência de 8 ou mais dígitos viram `…`) e cortado em **1000 caracteres**. Esse texto **não vai para o navegador** (nem na fila de completar) e **não entra no log**, que usa só nomes de grupo. Para a Amazon vão o link postado (para abrir o encurtador), o código do produto e a sua tag, nunca o texto da mensagem, o grupo ou quem postou. **Os backups carregam esses textos de grupos de terceiros**: mesmo mascarados, trate o pacote como dado pessoal. **Retenção:** os itens já decididos (enviados, descartados, expirados, com erro) são apagados depois do prazo de *Ajustes → Privacidade dos grupos* (padrão 90 dias; **0 = guardar para sempre**, e então os textos também ficam), na limpeza que roda ao iniciar e a cada 6 h. Ficam de fora dessa limpeza o que ainda está na fila de decisão ou na fila para completar (esta expira sozinha, veja [Fila para completar](#fila-para-completar)) e o item enviado que ainda conta para o "não repetir" do espelhamento. **Apagar um espelhamento apaga na hora todos os itens e textos dele.** O botão *Apagar o que já passou do prazo* de *Ajustes* aplica a mesma regra na hora, inclusive aos itens do espelhamento.
- **Fotos enviadas:** as fotos de *Disparar mensagem* ficam em `data/uploads/` e são apagadas **7 dias depois** de não terem mais nenhum envio ativo (agendado ou repetido) que as use.
- **Retenção:** eventos, leituras e cliques são apagados depois do prazo de *Ajustes → Privacidade dos grupos* (padrão 90 dias; a limpeza roda ao iniciar e a cada 6 h). Sessões vencidas também.
- **Exclusão por titular:** `POST /api/privacidade/apagar-participante` com `{ "id": "5511999999999" }` apaga tudo daquela pessoa.
- Ao desconectar o WhatsApp, o painel oferece apagar o histórico dos grupos.
- Avise os membros dos grupos (na descrição, por exemplo) que entradas, saídas e leituras são contadas para medir o alcance.
- Cliques no rotacionador: o IP só é usado em memória para contar um clique por hora; não vai para o banco.
- **Token da extensão:** em *Conexões → Mercado Livre → Gerar novo token* se suspeitar de vazamento. A extensão só aceita `https://` fora do seu computador e o servidor só aceita links `meli.la` vindos dela.

## Cuidados

- A conexão com o WhatsApp é **não oficial**. Há risco de o número ser restringido. Mantenha as pausas em *Ajustes* e evite volume alto.
- A pasta `data` guarda a sessão do seu WhatsApp, números de telefone dos avisos, e-mails da equipe, fotos enviadas e segredos das conexões. Não compartilhe nem envie para a nuvem.
- O programa só ouve em `127.0.0.1`. Num servidor, quem expõe é o Nginx com HTTPS, e o painel exige login.
