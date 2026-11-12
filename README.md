# achadinhoturbo

Programa **pessoal** que roda no seu computador e envia ofertas da sua **Central de Afiliados** do Mercado Livre para os seus grupos de WhatsApp, com link `meli.la` e **várias etiquetas** (cada regra usa a sua).

Além das regras automáticas, o painel faz **disparo manual** de uma oferta (do Mercado Livre ou da Amazon), **mensagens e enquetes** (agora, agendadas ou repetidas), **espelha ofertas da Amazon** postadas em outros grupos (veja [Espelhamento da Amazon](#espelhamento-da-amazon)), usa as ofertas do seu app Etiqueta como fonte (veja [Catálogo do Etiqueta](#catálogo-do-etiqueta)), publica os links que um **remetente** de confiança manda no privado (veja [Remetente](#remetente-links-enviados-por-outro-número)) e manda **resumo diário e avisos** para o seu WhatsApp.

Você configura: grupos, template, quantas ofertas por envio e o ritmo (a cada tantos minutos, dentro do horário de funcionamento, ou em **horários marcados**, cada um com a sua quantidade e o seu template), quanto tempo sem repetir a mesma oferta e, se quiser, as rotinas do **Grupo vivo** (mensagens e enquetes que mostram que o grupo tem gente por trás; veja [Horários marcados e Grupo vivo](#horários-marcados-e-grupo-vivo)).

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
        ├─ Remetente ◄── links que um número cadastrado manda no privado (Mercado Livre, Amazon, Shopee ou Magalu) ──► link do dono, sem aprovação
        │
        ├─ Catálogo ──► lê as ofertas do app Etiqueta (127.0.0.1:8765, token lido de um arquivo) ──► link por loja; suspeitas esperam a revisão do Dono
        │
        └──────► WhatsApp Business (aparelho conectado, via QR) ──► grupos de destino (uma fila só, com as pausas de Ajustes)
```

O Disparo manual da Amazon segue o mesmo caminho do espelhamento, só que a oferta vem do link que você cola. O espelhamento automático ouve os grupos de origem e decide o que enviar; veja [Espelhamento da Amazon](#espelhamento-da-amazon).

Nenhum cookie do Mercado Livre sai do seu Chrome: a extensão devolve só a lista de produtos e o link pronto.

Antes de gerar o link e enviar, o programa confere o preço e o estoque da oferta na loja; veja [Conferência de preço e estoque antes do envio](#conferência-de-preço-e-estoque-antes-do-envio).

## Instalar

1. Instale o **Node.js 22.13 ou mais novo** (versão LTS em nodejs.org).
2. Windows: dê dois cliques em `iniciar.bat`. Outros sistemas: `npm install` e depois `npm start`.
3. Abra http://localhost:3737

Quer só olhar o painel sem conectar nada? Rode `npm run simular`. Nesse modo nada é enviado de verdade, e ele usa uma pasta separada, `data-simulacao/` (ou a de `DATA_DIR`, se você passar uma): não mexe nos seus dados de `data/`. Se a porta 3737 estiver ocupada pelo serviço, use `PORT=3799 npm run simular`.

### Login do painel

Em casa, só no `localhost`, o painel abre sem login (aparece um aviso no terminal). Para proteger, abra *Conta → Equipe* e use **Ativar login**: você cria a sua conta de **Dono** (nome, e-mail e senha) e continua entrado neste navegador. Também valem `PANEL_PASSWORD` no primeiro start ou `npm run senha`; nesses dois casos o Dono é criado sem e-mail e entra só com a senha até completar o cadastro.

- **Quem já tinha senha:** no primeiro start desta versão, a senha única vira a conta do **Dono** (sem e-mail), e as sessões abertas continuam valendo. Ao entrar, o painel pede **"Complete seu cadastro"** (nome e e-mail; nova senha é opcional). Depois disso, o login pede **e-mail e senha**.
- A senha vira um hash no banco; a sessão fica num cookie `httpOnly` por 30 dias (cai depois de 7 dias sem uso) e sobrevive a reinícios. Cinco tentativas erradas bloqueiam o IP por 15 minutos. A mensagem de erro é sempre "E-mail ou senha incorretos.", sem dizer qual dos dois errou.
- **`LOGIN_SEM_LIMITE=1`** desliga esse bloqueio (por exemplo, enquanto só você usa o painel). Só vale sem `PUBLIC_HOST`: com o painel público, o limite continua. No serviço do systemd, crie `~/.config/systemd/user/achadinhoturbo.service.d/sem-limite.conf` com `[Service]` e `Environment=LOGIN_SEM_LIMITE=1`, depois `systemctl --user daemon-reload && systemctl --user restart achadinhoturbo`. Para religar o bloqueio, apague o arquivo e rode os mesmos dois comandos.
- **`npm run senha`** troca a senha do Dono (o mais antigo da equipe) e encerra **todas** as sessões. Serve para recuperar o acesso. Em "Complete seu cadastro" dá para escolher uma senha nova: as outras sessões dessa pessoa caem, a do navegador em uso fica.
- **Voltar à versão anterior:** a senha única continua guardada e acompanha a senha do Dono mais antigo, então o código antigo entra com ela.

### Publicar num servidor (VPS)

**Nginx:** além do proxy, defina `proxy_set_header X-Forwarded-For $remote_addr;` e `proxy_set_header X-Forwarded-Proto $scheme;` (o programa confia nesses cabeçalhos para o limite de tentativas de login e para o HSTS; sem reescrevê-los, um cliente pode falsificá-los) e `server_name` só com o seu domínio. Variáveis de ambiente: `PUBLIC_HOST` (ex.: `disparador.meudominio.com`; exigido para aceitar o domínio e a origem `https://`), `PORT` (padrão 3737), `DATA_DIR` (pasta dos dados), `TZ` (ex.: `America/Sao_Paulo`; o horário de funcionamento das regras usa a hora local) e `PANEL_PASSWORD`. Com `PUBLIC_HOST` definido, o programa se recusa a subir sem login (senha ou conta de Dono). Ele continua ouvindo só em `127.0.0.1`: coloque um Nginx com HTTPS na frente. No `/api/ext/poll` (long-poll de 20 s) use `proxy_buffering off` e `proxy_read_timeout 60s`; no `/api/ext/result` aceite corpos de até 8 MB. Encerra limpo com SIGTERM.

### Backup

`npm run backup [pasta]` copia o banco com `VACUUM INTO` (seguro com o programa rodando) e a sessão do WhatsApp num `.tar.gz`, mantendo os 7 mais recentes. O destino padrão é `data/backups/` (outra pasta precisa já existir ou ser escrita com `/`, como `./bk`), que o `.gitignore` já exclui; se você apontar para dentro de um repositório git não ignorado, o script avisa. **Nunca faça commit de um backup.** Esse comando é **só local**: não manda nada para o Drive e não conta para o aviso de backup atrasado (veja abaixo). Para conferir um backup: `npm run backup -- restaurar arquivo.tar.gz ../achadinho-restaurado` (extrai numa pasta nova, fora da pasta do programa, e roda `PRAGMA integrity_check`; o passo a passo para trocar a `data/` está nos Docs, capítulo *Manutenção*). **O pacote contém a sessão do seu WhatsApp**: trate como senha. Ele também leva o ID e o segredo da credencial da Amazon, o **número de WhatsApp de cada remetente** (veja [Remetente](#remetente-links-enviados-por-outro-número)) e, com o espelhamento, **textos de mensagens de grupos de terceiros** (já mascarados; veja [Privacidade (LGPD)](#privacidade-lgpd)).

#### Backup automático e cópia criptografada no Google Drive

Um timer do systemd (`achadinhoturbo-backup.timer`) roda `scripts/backup.js auto` todo dia às **03:00** (com até 10 minutos de folga). Se o computador estiver desligado nesse horário, o backup roda quando você o ligar. Como o serviço do painel, é um timer de usuário: só roda com a sua sessão aberta no computador. Cada execução:

1. Faz o backup local de sempre, em `data/backups/`, mantendo os 7 mais recentes.
2. **Criptografa** o pacote com `gpg` (AES256) e **confere**: decifra o arquivo numa pasta temporária e roda o `PRAGMA integrity_check`. Se a conferência falhar, nada sobe.
3. Envia o `.tar.gz.gpg` com o `rclone` para a pasta `Achadinho Turbo - Backups` do remoto `gdrive:`, com até 3 tentativas (esperando 2 e depois 10 minutos). Só sobe arquivo criptografado: o programa recusa qualquer outro.
4. Depois de o envio do dia dar certo, apaga do Drive o que passar das 14 cópias, mas só arquivos chamados `disparador-AAAA-MM-DD-HH-MM-SS.tar.gz.gpg`. O Drive guarda as 14 cópias mais recentes.

Falha de internet, de Drive ou de `rclone` nunca apaga nem invalida o backup local.

A cópia vai **cifrada** para o **seu** Google Drive, com uma chave que só você tem. O computador guarda 7 cópias e o Drive guarda 14. As cópias que saem da rotação vão para a **lixeira do Drive**, onde o Google as mantém por até 30 dias. Por isso, **excluir alguém do programa só tira essa pessoa das cópias depois que elas saem da rotação e da lixeira do Drive** (veja [Privacidade (LGPD)](#privacidade-lgpd)).

**Instalar (uma vez):** é preciso ter o `gpg` e o `rclone` instalados e o Google Drive configurado no `rclone` com o nome `gdrive` (`rclone config`, tipo `drive`). Depois, na pasta do programa:

```
npm run backup:instalar
```

O instalador confere os três, cria a chave se ela ainda não existir, grava as duas units em `~/.config/systemd/user/`, liga o timer e mostra a próxima execução. Pode ser rodado de novo sem trocar a chave nem duplicar nada. **Se você atualizar o Node.js, rode `npm run backup:instalar` de novo**: a unit guarda o caminho do `node`.

**A chave.** A chave nasce uma única vez, no instalador: 32 bytes aleatórios em `~/.config/achadinhoturbo/backup.chave` (arquivo com permissão 600, numa pasta 700). **Perder a chave torna as cópias do Drive impossíveis de abrir.** Se este computador se perder, a chave vai junto: copie-a **agora** para o seu gerenciador de senhas, abrindo o arquivo no seu próprio terminal, só para ler (`less ~/.config/achadinhoturbo/backup.chave`; saia com Q). Não cole a chave em chat, e-mail nem no próprio Drive. O programa nunca a mostra na tela, no log, no Histórico nem no estado do backup. **Nunca rode o instalador de novo para "recuperar" a chave**: se o arquivo sumiu, o instalador cria uma chave **nova**, e ela não abre as cópias antigas. Recupere o arquivo a partir do gerenciador de senhas. Sem a chave (ou com a permissão aberta), o automático faz só a cópia local e recusa o Drive.

**Aviso de backup atrasado.** Cada execução grava `data/backup-estado.json` (hora, resultado de cada lado e último sucesso; sem chave e sem dado pessoal) e deixa uma linha no Histórico, com *Backup* na coluna *Origem* (nível ok ou aviso, nunca erro). Se o último sucesso do backup local **ou** do Drive tiver mais de 26 h (ou o estado não puder ser lido), o programa avisa pelo WhatsApp os números que recebem *Erro de disparo* em *Relatórios e avisos*: no máximo **1 vez a cada 24 h** e nunca na primeira hora depois de o programa ligar. Sem número cadastrado para esse aviso, só o Histórico mostra. Se o WhatsApp estiver fora, o aviso espera.

**Conferir e diagnosticar:**

- `systemctl --user list-timers achadinhoturbo-backup.timer` mostra a próxima execução.
- `systemctl --user start achadinhoturbo-backup.service` roda o backup agora.
- `journalctl --user -u achadinhoturbo-backup -n 20 --no-pager` mostra o resultado (só mensagens fixas, nunca a chave).
- Código de saída do `auto`: **0** tudo certo; **1** o backup local falhou (o Drive nem é tentado); **3** o local deu certo, mas o Drive ou a conferência falhou.
- O Drive deixou de aceitar (token vencido)? Rode `rclone config reconnect gdrive:`.

**Restaurar a cópia do Drive:** com a chave no lugar, `npm run backup -- restaurar-drive ../achadinho-restaurado` baixa a cópia **mais recente**, decifra e roda a mesma conferência do `restaurar` (`PRAGMA integrity_check`; o resultado deve trazer `integridade=ok`). Para uma cópia específica, acrescente o nome no fim: `npm run backup -- restaurar-drive ../achadinho-restaurado disparador-AAAA-MM-DD-HH-MM-SS.tar.gz.gpg`. Os nomes saem de `rclone lsf "gdrive:Achadinho Turbo - Backups"` (as aspas são necessárias: o nome da pasta tem espaços). O comando recusa uma pasta dentro da pasta do programa e uma pasta que já exista com conteúdo: use sempre uma pasta nova ou vazia (o `restaurar` manual segue a mesma regra). Para repetir o teste, apague antes a pasta de teste. Código de saída: **0** ok; **1** falha (a mensagem diz o motivo); **2** o banco restaurado não passou na integridade. Depois, troque a `data/` como no passo a passo dos Docs (capítulo *Manutenção*). Em outro computador, instale o programa, o `gpg` e o `rclone`, configure o remoto `gdrive` (`rclone config`) e crie o arquivo da chave com o que está no gerenciador de senhas (arquivo com permissão 600, dentro de uma pasta com permissão 700: `mkdir -p -m 700 ~/.config/achadinhoturbo`) **sem rodar o instalador**.

**Restaurar sem o programa, em qualquer computador com `gpg`:** baixe o `.tar.gz.gpg` pelo navegador (pasta `Achadinho Turbo - Backups` do Drive) e decifre. Antes, rode `umask 077` no terminal, para os arquivos novos nascerem visíveis só para você. O `gpg` pede a senha: cole a chave. A senha não vai na linha de comando. **Se o gpg não pedir a senha, o arquivo não é o seu backup cifrado: apague-o e não use.**

```
gpg --no-symkey-cache --output backup.tar.gz --decrypt disparador-AAAA-MM-DD-HH-MM-SS.tar.gz.gpg
```

Ou, com a chave num arquivo seu (apague-o depois):

```
gpg --batch --pinentry-mode loopback --passphrase-file backup.chave --output backup.tar.gz --decrypt disparador-AAAA-MM-DD-HH-MM-SS.tar.gz.gpg
```

Depois, `mkdir ../achadinho-restaurado` e `tar -xzf backup.tar.gz -C ../achadinho-restaurado`. Apague o `backup.tar.gz` (ele tem a sessão do WhatsApp). Dentro da pasta ficam o `disparador.db` e a `wa_auth`.


## Menu do painel

O menu lateral é dividido em grupos:

- **Visão Geral**
- **Ganhos** (só o Dono; no grupo **Principal** do menu, logo abaixo de Visão Geral): comissões, cliques, ganho por grupo, bloco, loja e oferta, cobertura do rastreio e custo por membro novo, veja [Rastreio por grupo e página Ganhos](#rastreio-por-grupo-e-página-ganhos)
- **Principal**: Rotacionador de Links, Grupos, Blocos de análise
- **Disparos**: Disparo manual, Disparo automático (antes chamado *Regras*; é onde ficam os botões *Novo espelhamento* e *Novo remetente*), Disparar mensagem, Grupo vivo, Templates
- **Comunicação**: Relatórios e avisos
- **Conta**: Conexões, Números de WhatsApp, Equipe (só o Dono vê)
- No rodapé: Histórico (com o seletor *Tipo*: Tudo, Disparo automático, Espelhamento, Catálogo ou Remetente), Ajustes, Docs

Os endereços antigos continuam funcionando: `#regras` abre *Disparo automático*, `#whatsapp` abre *Números de WhatsApp*, `#etiquetas` abre *Conexões* (na seção do Mercado Livre) e `#ajuda` abre os *Docs*.

### Docs do painel

O item **Docs** do menu é o manual dentro do próprio painel (`#docs`). Ele tem três partes:

- **O livro**: 13 capítulos em ordem de trilha, de *Primeiros passos* até *Manutenção*, cada um com o que você vai aprender, passos numerados, o caminho no painel e comandos com botão *Copiar*. Cada capítulo e cada seção tem endereço próprio (`#docs/<capítulo>` e `#docs/<capítulo>/<seção>`), há busca no topo, e o navegador guarda quais capítulos você já leu (só neste navegador).
- **Perguntas reais**: as dúvidas que mais aparecem (tag da Amazon, `meli.la`, ID da Shopee, Catálogo, limpar o log, painel só no computador…), cada uma com resposta curta e o caminho no painel.
- **Referência**: glossário por tema (com o quadro "Cinco nomes parecidos": etiqueta do Mercado Livre, app Etiqueta, Catálogo, tag da Amazon e ID de afiliado da Shopee), o significado de cada selo dos cartões de *Conexões*, os motivos de revisão e de descarte, e a tabela de limites e números.

Os botões **?** das telas continuam com a explicação curta e muitos levam ao capítulo do assunto. O Operador também lê tudo, inclusive *Equipe e papéis* (as ações que só o Dono faz levam o selo "Só o Dono"). **Este README segue como guia de instalação e referência técnica** (arquivos, API, segurança, decisões); o passo a passo de uso mora nos Docs, e os números que aparecem nos dois lugares são conferidos por teste (`test/docs.test.js`).

## Visão Geral, blocos e rotacionador

- **Visão Geral**: funil do período (cliques nos links → entradas pelo link ou adicionados → saídas), saldo, tempo médio no grupo, quem abriu o grupo (leu alguma mensagem sua), gráfico de entradas e saídas por hora ou por dia, evasão (quem entrou e saiu no mesmo dia, em 7 dias, ontem e total), tabela por grupo e eventos. Tudo vem do que o WhatsApp informa enquanto o programa está conectado: antes disso não há histórico.
- **Blocos de análise**: agrupe grupos por nicho. A Visão Geral filtra por bloco, e ao criar uma regra de disparo automático você pode marcar um bloco inteiro. O campo *Etiqueta do Mercado Livre para o disparo (opcional)* só deixa a etiqueta já marcada ao criar um disparo a partir do bloco; **ele não separa o ganho**. Para separar o ganho do nicho, o bloco tem os *Códigos de rastreio (opcional)* (veja [Rastreio por grupo e página Ganhos](#rastreio-por-grupo-e-página-ganhos)).
- **Rotacionador de Links**: `/g/<nome>` leva para o primeiro grupo da lista com vaga (modos: encher um por vez, alternar entre até 3, encher e reabrir ao esvaziar), com limite por grupo, URL reserva e contagem de cliques. Só grupos com convite entram: em *Grupos*, use *Buscar convite* (precisa ser admin) ou cole o link. **No seu computador o endereço só abre para você**; para o público, o programa precisa estar publicado na internet.
- **Próximo grupo (com confirmação)**: ligando a opção no link, quando um grupo chega a 95% do limite o painel propõe um grupo novo igual (nome com o número seguinte, descrição, foto, permissões e admins). Nada é criado até você clicar em *Criar agora*. O grupo novo entra no link logo depois do que lotou, nos mesmos blocos e nas mesmas regras. Criar grupos é a ação que mais chama a atenção do WhatsApp: evite criar vários no mesmo dia.

## Rastreio por grupo e página Ganhos

Para saber de qual grupo veio uma venda, cada link enviado pode sair com um **código de rastreio** do grupo ou do bloco. **Sem configurar nada, os links saem como hoje.** O rastreio é opcional e por loja:

| Loja | O código | Onde se cria |
|---|---|---|
| Mercado Livre | uma **etiqueta** já cadastrada em *Conexões → Mercado Livre* | no painel |
| Amazon | um **ID de rastreamento** (ex.: `casa-20`) | no portal da Amazon, em *Gerenciar IDs de rastreamento*, antes de usar aqui |
| Shopee | um **Sub_id**: letras e números, até 30 caracteres | no próprio campo (só por bloco) |

- **Onde configurar:** em *Blocos de análise*, no quadro *Códigos de rastreio (opcional)* do bloco, ou, para uma exceção, na coluna *Rastreio* de *Grupos* (o grupo vence o bloco; a Shopee não tem código por grupo, só por bloco). Só o **Dono** vê e muda os códigos.
- **Precedência:** grupo > bloco > padrão de hoje. Se o grupo está em vários blocos, vale o bloco mais antigo (o de menor id). **Um código pertence a um só grupo ou bloco**: o painel recusa o mesmo código em dois lugares.
- **A associação vence a etiqueta escolhida** no *Disparo manual* e na regra de *Disparo automático*: o grupo que tem etiqueta de rastreio recebe o link com ela, mesmo que o disparo tenha outra etiqueta. Já o campo *Etiqueta do Mercado Livre para o disparo* do bloco não separa o ganho.
- **Amazon:** o painel confere só o formato (letras, números e hífen, ex.: `casa-20`), **não** se o ID existe na sua conta: confira a grafia, porque um ID errado gera link sem comissão. Não pode ser a tag padrão de *Conexões → Amazon*.
- **Mercado Livre:** a etiqueta precisa existir em *Conexões → Mercado Livre*. O painel não deixa apagar uma etiqueta que é código de rastreio (tire a associação antes); se ela sumir mesmo assim, o link sai com a padrão e a cobertura cai.
- **Shopee:** cada Sub_id pede um link a mais à Shopee e conta no teto de 60 links por hora pela extensão; por isso ele é por bloco e há **até 10 Sub_ids por envio** (o que passar disso sai com o link base, sem Sub_id). **O Sub_id sai pela API de afiliados da Shopee ou pela extensão** (versão **1.4.1 ou mais nova**; depois de atualizar, recarregue a extensão em `chrome://extensions`). Cada Sub_id gasta uma vaga do teto de 60 links por hora da extensão. Se a extensão for antiga, o envio **para de pedir Sub_id já no primeiro** pedido. O painel também **guarda vagas** do limite de 60 links por hora para o link normal: quando sobram poucas, o link sai sem Sub_id. Quando não entra, o link sai sem Sub_id e a falta aparece na cobertura. Todo envio da Shopee pede o Sub_id: o *Disparo manual*, a revisão do [Catálogo do Etiqueta](#catálogo-do-etiqueta) e os links de um [remetente](#remetente-links-enviados-por-outro-número).
- **Equipe:** o Operador não vê nem muda códigos, não apaga um bloco que tem código ou gasto com anúncio e não troca os grupos dele (o painel responde que só o Dono pode). Ninguém apaga uma etiqueta que é código de rastreio: tire a associação antes.

### Página Ganhos

A página **Ganhos** (só o Dono) mostra quanto cada grupo, bloco, loja e oferta rendeu, a partir das comissões que **você importa** dos portais das lojas, e se os links saíram com o código de rastreio. Filtros: período (7 dias, 30 dias, mês atual, mês passado ou datas), bloco e loja. O que ela traz:

- **Cartões:** comissão (e a parte confirmada), valor vendido, vendas (itens), cliques, ganho por clique, conversão, envios, comissão com grupo, gasto, entradas, custo por membro novo e retorno (comissão menos gasto). Onde o número não existe (divisão por zero, sem importação, sem gasto), a tela mostra **“—”**, nunca um zero inventado.
- **Tabelas:** por grupo (clique no título da coluna para ordenar; a linha *Sem grupo identificado* soma as vendas sem código ou com código de ninguém e fica fora do ranking), por bloco, por loja, por oferta (as 10 maiores, com *Ver todas*), por dia e a cobertura por grupo.
- **Cobertura:** dos links que tinham código configurado, quantos saíram com ele. Boa: 90% ou mais; Parcial: de 60% a 89%; Baixa: abaixo de 60%. A loja leva o aviso *Atenção* quando a cobertura dela fica abaixo de 80%. Abaixo de 100% significa que o Sub_id foi recusado ou bateu no limite, ou que a etiqueta falhou; sem o código, a venda entra no total, mas não se sabe de qual grupo veio. **Alcance:** em quantos envios havia código configurado (os outros saíram com o código padrão de cada loja).
- **Cliques vêm do relatório da loja**, não do Rotacionador: o link de afiliado vai direto para a loja e o Turbo não vê o clique. Ganho por clique e conversão só existem para as lojas que têm cliques importados no período.
- **Período anterior:** em cada cartão com variação, o painel mostra o valor dos **mesmos N dias logo antes** do período escolhido, com os mesmos filtros, e a mudança em porcentagem (por exemplo, “+300%, mais”). A variação aparece em Comissão, Valor vendido, Vendas, Cliques, Ganho por clique, Conversão, Envios e Entradas. Sem base para comparar (o período anterior deu zero), aparece só o valor dele.
- **Por grupo e por oferta:** clique no **nome de um grupo** na tabela *Por grupo* para ver na tabela *Por oferta* só as ofertas daquele grupo; *Ver todas as ofertas* volta. A venda que foi atribuída ao bloco inteiro não entra nesse filtro, porque ela não se divide entre os grupos. O filtro some quando você troca período, bloco ou loja.
- **Link da oferta:** o nome do produto em *Por oferta* abre a **página do produto na loja, sem o seu link de afiliado**, em outra aba. Serve para conferir preço e estoque; quem entra por esse link não gera comissão para você, então não divulgue ele. Oferta sem produto reconhecido não tem link.
- **Endereço:** a página guarda os filtros no endereço, como `#ganhos?periodo=30d&bloco=3&loja=shopee` (com `periodo=custom`, também `de=` e `ate=`, em AAAA-MM-DD). Dá para salvar nos favoritos ou mandar para a equipe. No cartão de cada bloco, em *Blocos de análise*, o atalho **Ver ganhos** abre a página já filtrada por ele.

#### Importar comissões e cliques

Em *Ganhos → Importar comissões* (só o Dono): escolha a **loja** (Shopee, Amazon ou Mercado Livre), o que o arquivo traz (**comissões** ou **cliques**) e o arquivo baixado do portal da loja: um **CSV** ou, na Amazon, o **.zip** com o CSV dentro, **como veio** (não precisa abrir). O arquivo vai até 5 MB e até 100.000 linhas; arquivo do Excel (.xlsx) não vale: salve como CSV. Se o relatório já veio filtrado por um código, digite-o em *Código do arquivo*: ele vale para as linhas sem coluna de código. O campo *Data do relatório* aparece só quando o arquivo não tem data em cada linha, ou seja, é um **total do período**: todas as linhas entram no dia que você escolher. Escolha sempre o **último dia do período** do relatório e **não importe períodos que se sobrepõem** (por exemplo 01–15/10 e depois 01–31/10), porque o total contaria duas vezes. Se o relatório tiver uma coluna de data que o painel não reconhece, o painel **não pede** a *Data do relatório*: ele avisa que não reconheceu a coluna.

1. **Conferir arquivo** mostra uma **prévia que não grava nada**: linhas lidas, novas, já importadas, atualizadas e puladas (só o número da linha), período, comissão, linhas sem grupo e as **colunas usadas e as ignoradas**.
   - **Avisos da prévia** (nada é bloqueado: quem decide é você). *Outro código*: “linhas têm a mesma data e produto de vendas já importadas com outro código (ou sem código)”. Se for o mesmo relatório importado de novo, **não importe**: a venda contaria em dobro. Se era de outro grupo, tudo bem. *Vão receber o código deste arquivo*: “linhas importadas antes sem código vão receber o código deste arquivo”. Se eram de outro grupo, não importe: apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código. Depois de gravar, o resumo repete o aviso no passado (“receberam”).
2. **Importar agora** grava. Reimportar o mesmo período não duplica: linhas iguais são ignoradas e uma venda que era pendente e virou confirmada é atualizada. Cliques substituem o total do dia (não somam).
3. *Importações recentes* (no fim da página) lista data, loja, tipo e contagens; **Apagar** tira só as linhas que aquela importação trouxe.

Os nomes de coluna reconhecidos são os mais comuns de cada relatório (data, código, produto, comissão, status, cliques…). **Só a Amazon foi conferida com um arquivo real**; Shopee e Mercado Livre ainda não. Se a prévia disser que não achou uma coluna, nada é gravado.

#### Como baixar cada relatório

Os menus dos portais mudam; o caminho abaixo é o que foi visto em 05/11/2026.

- **Amazon** (Central de Associados): *Relatórios → Fazer download de relatórios*. Escolha o período, o **ID de rastreamento** (`Tudo` ou um deles) e o formato **CSV**. O arquivo vem num `.zip`: importe-o como veio. Há dois relatórios úteis, e **não se importam os dois como comissões**, porque a venda contaria em dobro:
  - **Produto relacionado**, filtrado por **um** ID de rastreamento: traz comissões **e** cliques (data no formato mês-dia-ano, colunas em inglês). Importe o mesmo arquivo como *Comissões* e como *Cliques*, com o **mesmo** *Código do arquivo* (o ID de rastreamento do filtro). Sem filtro, o relatório não diz de qual ID veio cada linha. Linha **sem venda, só com cliques**, não entra como venda nas comissões: os cliques entram quando você importa o mesmo arquivo como *Cliques*.
  - **ID de rastreamento**: um **total do período por ID** (cliques e ganhos), sem data em cada linha. Importe com o campo *Data do relatório*: tudo entra no dia escolhido. Use sempre o **último dia do período** e **não importe períodos que se sobrepõem** (por exemplo 01–15/10 e depois 01–31/10), porque o total contaria duas vezes. Escolha um dos dois relatórios para as comissões, nunca os dois.
- **Shopee** (Shopee Afiliados): *Relatório de vendas* (comissões) e *Relatório de cliques* (uma linha por clique), com o botão **Exportar**. **O formato do arquivo exportado ainda não foi conferido com um arquivo real**, porque a conta usada para testar não tinha vendas. Se a prévia não achar uma coluna, nada é gravado.
- **Mercado Livre** (Central de afiliados): a página de métricas mostra as vendas na tela, mas **não foi achado botão de exportar**, e a venda na tela não diz de qual etiqueta veio (a separação por etiqueta fica numa aba à parte). **Hoje não dá para importar do Mercado Livre por arquivo.**

**Privacidade:** nome, endereço, telefone, e-mail ou documento de comprador **nunca são lidos nem guardados**, mesmo que o arquivo traga essas colunas; só entram data, código, produto, título, quantidade, valor, comissão e status. O número do pedido vira um código embaralhado com uma chave que só existe no seu computador (não dá para voltar ao número) e serve só para não contar a mesma linha duas vezes. O arquivo em si não vai para o disco. Comissões e cliques ficam até você apagar a importação e vão no backup junto com o banco.

#### Gasto com anúncios

Em *Ganhos → Gasto com anúncios*: período (o gasto de um período vai até 366 dias), **bloco ou grupo** para o qual vale, valor em reais (por exemplo `1.234,50`) e uma observação de até 200 caracteres. O valor é repartido igualmente pelos dias do período; o **custo por membro novo** é o gasto dividido pelas entradas do mesmo período (limitado ao prazo de guarda dos eventos dos grupos) e só existe para quem tem gasto próprio, grupo ou bloco. Não há edição: use **Excluir** e lance de novo. Se já existe gasto para o mesmo destino e período, o painel avisa e grava mesmo assim. Cada gasto conta só no próprio alvo: o gasto lançado para um grupo **não** entra no bloco dele, e o de um bloco não se divide entre os grupos.

**Histórico do rastreio e privacidade:** cada envio de oferta que deu certo grava uma linha por grupo em `rastreio_envios` (grupo, link, loja e código; **sem dado de pessoa**). O histórico do rastreio fica guardado por 400 dias, um prazo próprio: ele **não segue** o prazo de *Ajustes → Privacidade dos grupos*, nem quando esse prazo é 0 (para sempre) ou menor. A limpeza roda ao iniciar e a cada 6 h. A tabela vai no backup junto com o banco.

## Primeiros passos

1. **Conexões → Mercado Livre**: cadastre os nomes das suas etiquetas, escritos como no programa de afiliados.
2. **Números de WhatsApp** e **Grupos**: clique em *Conectar WhatsApp* e leia o QR no WhatsApp Business (Aparelhos conectados).
3. **Templates**: ajuste a mensagem. Linha com campo vazio some sozinha. `{TITULO_PRODUTO}` sai **abreviado** (só o que identifica o produto: tira "Compatível com…", "Premium", "Alta Qualidade" e corta em até 60 caracteres sem partir palavra; o tamanho muda em *Ajustes*, 0 desliga). `{TITULO_COMPLETO}` é o nome inteiro. Um pedaço entre colchetes, como `[ ({DESCONTO_PRODUTO} OFF)]`, some sozinho quando falta o dado (veja [Template com trecho opcional](#template-com-trecho-opcional)).
4. **Extensão** (abaixo). Sem ela, nem a lista de ofertas nem o link de afiliado são gerados.
5. **Disparo automático**: crie uma regra escolhendo etiqueta, template, grupos e ritmo. A fonte padrão é a **Central de Afiliados**: a lista "Produtos selecionados para você", com busca, **uma ou várias categorias** (com várias, as ofertas saem intercaladas, bom para grupos de achadinhos gerais), ordem, "só mais vendidos" e "só com ganhos extras". Cada página da Central traz 18 produtos e "Páginas lidas por envio" vai de 1 a 10. Uma regra aceita **até 5 fontes** (Central com filtros diferentes, listas de links, buscas, misturadas): as ofertas saem intercaladas, uma de cada fonte por vez, e uma fonte que falhar vira aviso sem travar as outras. A etiqueta é uma por regra: para etiquetas diferentes no mesmo grupo, crie outra regra apontando para o mesmo grupo. Se o grupo tem código de rastreio (veja [Rastreio por grupo e página Ganhos](#rastreio-por-grupo-e-página-ganhos)), a etiqueta dele vence a da regra. Use *Ver ofertas* para conferir antes e *Enviar agora* para testar. Outra fonte é o **Catálogo** (as ofertas do seu app Etiqueta): veja [Catálogo do Etiqueta](#catálogo-do-etiqueta).

## Disparo manual

Em *Disparos → Disparo manual* você manda uma oferta específica sem criar regra:

1. Cole o link do produto e clique em **Identificar**. O programa reconhece a loja, lê o produto e monta a mensagem com o template escolhido.
2. Escolha o **template**, a **etiqueta** (só no Mercado Livre) e os grupos.
3. Envie **agora** ou **agende para hoje** (só o mesmo dia; para repetir, use *Disparar mensagem*).
4. O histórico mostra o que foi enviado, está na fila ou deu erro (últimos 30 dias nos contadores).
5. Dentro do **horário de silêncio** de *Ajustes* (padrão 23:00 às 07:00), o envio **agora** mostra um aviso com **Enviar mesmo assim** (que nunca ignora o limite de 40 mensagens por hora); o **agendado** que cai nele é pulado, e o painel avisa antes. Veja [Proteção do número](#proteção-do-número-anti-banimento).

**Hoje o Mercado Livre, a Amazon, a Shopee e a Magalu enviam.** Se o link for do Facebook, o programa reconhece e avisa que a loja **não está conectada** (ainda não implementada), sem enviar nada.

**Links `meli.la` da Central de Afiliados:** o painel lê a página do afiliado para a qual eles redirecionam e gera o link a partir do produto.

### Disparo manual com um link da Amazon

Precisa da **tag de associado** salva em *Conexões → Amazon*. Sem ela o botão de disparar fica desabilitado: o link da Amazon sempre sai com a sua tag. A extensão do Chrome não é usada.

1. Cole o link e clique em **Identificar**. Aceita `amazon.com.br/dp/…`, `amazon.com.br/<nome>/dp/…`, `link.amazon`, `amzn.to`, `amzn.com` e `a.co`. O programa abre o link curto seguindo os redirecionamentos (só em endereços da Amazon e, no meio do caminho, no `amzlinks.in`, que o `link.amazon` usa; sem ler a página; o `amzlinks.in` é um redirecionador de terceiro, não da Amazon, e só vale nesse endereço exato, nunca num subdomínio dele nem colado direto) até achar o código do produto (o **ASIN**) e consulta a API oficial, se houver acesso.
2. A seção **Dados da oferta** vem preenchida e dá para editar: título (até 200 caracteres), preço atual, preço antigo (só vale se for maior que o atual; senão a linha "De" some), cupom (até 30 caracteres), **frete grátis** e a **foto** (trocar por JPG ou PNG de até 5 MB, ou remover; sem foto a mensagem sai só com texto). O desconto é calculado dos dois preços.
3. A prévia mostra a mensagem com o template escolhido, com a tag escondida (`tag=•••`). O link que vai ao grupo é sempre `https://www.amazon.com.br/dp/<ASIN>?tag=<sua tag>`, montado na hora do envio.
4. Se a API não responder, os campos ficam em branco para você preencher e o **título é obrigatório**. Sem credencial salva, a tela não mostra aviso sobre a API; com conta sem acesso, limite de consultas ou instabilidade, ela diz o motivo. Link que não leva a um produto (busca, lista, loja) ou que não abre é recusado com a explicação.
5. Envie **agora** ou **agende para hoje**, como no Mercado Livre.

### Disparo manual com um link da Shopee

A Shopee funciona no **Disparo manual** (agora ou agendado para hoje) e nos links que um [remetente](#remetente-links-enviados-por-outro-número) manda no privado. **O espelhamento da Shopee não existe**, e as regras do *Disparo automático* só enviam a Shopee pela fonte [Catálogo do Etiqueta](#catálogo-do-etiqueta), sempre depois de revisão do Dono (o espelhamento, veja [Espelhamento da Amazon](#espelhamento-da-amazon), só trata a Amazon).

**O link de afiliado nunca é montado à mão.** O link que vai ao grupo é sempre `https://s.shopee.com.br/<código>`, gerado pela própria Shopee na sua conta, por um de dois caminhos:

1. **API de Afiliados da Shopee**, primeiro, quando ela está liberada para a sua conta e o AppID e a Senha da API estão salvos.
2. **Extensão do Chrome**, pelo **"Link personalizado"** do portal de afiliados da Shopee (`affiliate.shopee.com.br`). É o caminho de **reserva**: vale também enquanto a Shopee não libera a API (o caso normal no começo) e quando a API falha na hora. A extensão usa a sua sessão do navegador, como faz com a Central de Afiliados do Mercado Livre.

O programa só aceita como resposta um link `s.shopee.com.br`; qualquer outra coisa é recusada e nada é enviado.

Para não pedir links demais à Shopee, o programa reaproveita por até 7 dias (enquanto ele não reiniciar) o link já gerado para o mesmo produto (vindo da API, ou da extensão com o número da sua conta conferido; salvar o cartão Shopee em Conexões descarta os guardados) e limita os pedidos: no máximo 60 links por hora pela extensão e 300 consultas por hora à Shopee no total. Passou do limite, o disparo é recusado com o aviso e volta a funcionar na hora seguinte.

**Conferência da conta.** Quando o portal devolve, junto do link curto, o endereço longo com o número da conta (`an_…`), o programa o compara com o **ID de afiliado** salvo em *Conexões → Shopee*. Se não conferir, o disparo é **recusado** ("o Chrome está logado em outra conta de afiliado da Shopee…"): a comissão iria para a outra conta. Entre na conta certa no portal e tente de novo.

**Pré-requisitos**

- **ID de afiliado** salvo em *Conexões → Shopee* (só números, por exemplo `98765432101`). É o número da sua conta de afiliado: **não é o AppID da API e não é a tag da Amazon**. Sem ele o botão de disparar fica desabilitado.
- **Para o caminho da extensão:** o Chrome aberto e **logado em `affiliate.shopee.com.br`**, com a extensão **conectada** (veja [Extensão do Chrome](#extensão-do-chrome)). A versão **1.3.0** da extensão pede uma permissão nova, para `affiliate.shopee.com.br`: depois de atualizar a pasta `extension`, abra `chrome://extensions` e clique em **Recarregar** na extensão (e aceite a permissão, se o Chrome pedir). Com a extensão antiga, o link da Shopee não sai. Sem a extensão conectada e sem API útil, o botão de disparar fica desabilitado, com o motivo.
- **AppID e Senha da API (opcionais):** só servem para o painel buscar os dados do produto sozinho e gerar o link pela API. Ficam em *Conexões → Shopee*. A conta nova costuma **não ter acesso** à API: no portal, a página "Abrir API" mostra o aviso de que a conta não tem acesso e AppID e Senha vazios. Nesse caso peça o acesso à Shopee pelo formulário de atendimento (resposta em até 3 dias úteis); o endereço e o resumo da API estão em `docs/produto/referencias/shopee-api-afiliados.md`. Enquanto isso, tudo funciona pela extensão, com os dados do produto preenchidos por você.

**Passo a passo**

1. Cole o link e clique em **Identificar**. Aceita `shopee.com.br/<nome>-i.<loja>.<produto>`, `shopee.com.br/product/<loja>/<produto>` (também `universal-link/product/…`) e os links curtos `s.shopee.com.br`, `shp.ee` e `shope.ee`, que o programa abre seguindo só os redirecionamentos de endereços da Shopee (sem ler a página). Link que não leva a um produto (busca, loja, campanha) ou que não abre é recusado com a explicação.
2. **Com a API:** a seção **Dados da oferta** vem preenchida com **título, preço, desconto, número de vendas, nome da loja, nota e foto**. A API **não traz o preço antigo**, e ele não é calculado a partir do desconto: se quiser a linha "De", escreva o preço antigo (só vale se for maior que o atual). Nome da loja e nota são só informação: não vão na mensagem.
3. **Sem a API:** os campos ficam **em branco para você preencher** e o **título é obrigatório**. Sem AppID e Senha, ou com a conta ainda sem acesso, a tela não mostra aviso sobre a API; com limite de consultas, instabilidade ou credencial recusada, ela diz o motivo. O link sai do mesmo jeito, pela extensão.
4. **Produto fora do programa:** se a API responde mas não reconhece o produto, ele provavelmente **não participa do programa de afiliados** e pode não gerar comissão. O disparo **não é bloqueado** e a tela não mostra aviso: os campos de **Dados da oferta** ficam em branco para você preencher (o **título é obrigatório**) e o link sai do mesmo jeito.
5. A prévia mostra a mensagem com o template escolhido; no lugar do link aparece `https://s.shopee.com.br/(gerado ao disparar)`. A Shopee não tem etiqueta.
6. Envie **agora** ou **agende para hoje**. O link é gerado **na hora de criar o envio** e guardado nele: um envio agendado **não precisa do Chrome aberto** na hora de sair. Se o link não puder ser gerado (extensão fora, outra conta, Shopee fora do ar), o envio **não é criado** e a tela diz o motivo.

**Privacidade:** a Senha da API fica só no banco, **não volta ao navegador** (o painel só mostra que está preenchida) e **não vai para log nem para mensagem de erro**: as mensagens da Shopee são frases fixas. O **token da sessão do portal fica dentro do navegador**: a extensão o usa lá e devolve ao programa só o link gerado. Para a API da Shopee vão só os números do produto ou o endereço dele sem parâmetros, o AppID e a assinatura da chamada (a Senha nunca sai do computador); para o portal, pela extensão, só o endereço do produto sem parâmetros.

### Disparo manual com um link da Magalu

A Magalu funciona no **Disparo manual** (agora ou agendado para hoje) e nos links que um [remetente](#remetente-links-enviados-por-outro-número) manda no privado. **Ela fica de fora** do [Catálogo do Etiqueta](#catálogo-do-etiqueta), das regras do *Disparo automático*, do espelhamento, do [rastreio por grupo e da página Ganhos](#rastreio-por-grupo-e-página-ganhos) e da importação de comissões: a Magalu não tem sub-id nem relatório que o programa conheça, então os ganhos dela **não são separados por grupo**.

Precisa só do **nome da sua loja de parceiro** (Magazine Você) salvo em *Conexões → Magalu*: é o trecho que vem depois de `magazinevoce.com.br/` no endereço da sua loja (se o endereço é `magazinevoce.com.br/minhaloja`, escreva `minhaloja`). Não há senha, API nem extensão do Chrome. Sem o nome salvo o botão de disparar fica desabilitado.

1. Cole o link e clique em **Identificar**. Aceita o endereço da página do produto no `magazineluiza.com.br` ou no `magazinevoce.com.br` (de qualquer loja) e os links curtos `maga.lu`, `magalu.com` e `magazineluiza.onelink.me`. O link curto `onelink.me` passa pela AppsFlyer, o serviço de links da Magalu: o programa abre o link curto seguindo só os redirecionamentos entre esses endereços (os da Magalu e o `magazineluiza.onelink.me`) e **nunca pede a página do produto**. Se não conseguir, ele diz para colar o endereço da página. Link que não leva a um produto (início, busca, categoria) é recusado com a explicação.
2. **A Magalu não deixa o programa ler o produto.** A seção **Dados da oferta** vem **em branco para você preencher**: o **título é obrigatório** (até 200 caracteres), o preço é opcional (use o que aparece na página da Magalu), e dá para informar preço antigo, cupom e **frete grátis**. A **foto** só vai se você enviar uma (JPG ou PNG de até 5 MB); sem foto a mensagem sai só com texto.
3. A prévia mostra a mensagem com o template escolhido e o **link real**. O link que vai ao grupo é sempre `https://www.magazinevoce.com.br/<sua loja>/<produto>/p/<código>/`, **montado na hora do envio** com o nome salvo naquele momento. Só segue do link colado o caminho do produto e o vendedor escolhido (`seller_id`); o resto (`utm`, fragmento, a loja de outro parceiro) é descartado.
4. **Link de outra loja de parceiro:** o painel avisa e o envio sai **com a sua loja**, nunca com a dela.
5. Envie **agora** ou **agende para hoje**. Se você apagar o nome da loja antes de o envio agendado sair, ele falha com a explicação no *Histórico* e nada é enviado. Quando sai, o *Histórico* diz "Enviado pela Magalu, com a sua loja de parceiro".

O programa **não confirma que o nome da loja existe**: nome errado gera um link de outra loja e a comissão não vem para você. Use **Conferir minha loja** no cartão da Magalu, que abre a sua página.

**Privacidade:** o nome da loja não é segredo (vai inteiro no link). Mesmo assim, log e mensagens de erro não levam link nem nome de loja, só frases fixas.

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
- **Silêncio e limite por hora**: o **"agora"** no horário de silêncio mostra o aviso com **Enviar mesmo assim**; agendado e repetido dentro dele são **pulados** (o painel avisa antes, sem "mesmo assim"). Com o limite por hora cheio, o envio entra na fila e sai quando houver vaga (o que esperar mais de 2 horas é descartado, com aviso). Veja [Proteção do número](#proteção-do-número-anti-banimento).

## Conferência de preço e estoque antes do envio

Logo antes de gerar o link e mandar, o programa lê de novo o preço e o estoque da oferta na loja. Oferta **esgotada** ou **mais cara do que o limite** não sai, e o *Histórico* diz o motivo. Vale para todo envio de oferta: Disparo automático (todas as fontes, inclusive o Catálogo), Disparo manual (agora e agendado), espelhamento, remetente e o "Enviar" da revisão do Catálogo. A prévia não confere.

- **Mercado Livre**: preço e estoque, **pela extensão do Chrome**, com a sessão do seu navegador: o Mercado Livre barra a leitura feita pelo próprio programa, então com a extensão conectada o programa não lê a página dele sozinho. Sem a extensão conectada (ou antiga, sem a versão 1.5.0), **não há conferência** e vale a regra dos 30 min abaixo. A extensão devolve só o preço e a disponibilidade, nunca a página nem os cookies. No modo *Link direto* (só para testar), o programa ainda tenta ler a página sozinho, e o Mercado Livre costuma barrar.
- **Amazon**: preço e estoque. Com a API da Amazon ligada (*Conexões → Amazon*), pela API. Sem a API, só na regra com a fonte **Catálogo**: o Etiqueta relê a página do produto escolhido **na hora do envio**; se a leitura falhar, vale o último preço visto, desde que tenha **até 6 h** (a reserva, abaixo). Sem a API e fora do Catálogo, não há conferência.
- **Shopee**: só o preço (a API não informa estoque), só com a API da Shopee ligada. Cada conferência conta nas 300 consultas por hora.
- **Magalu**: nunca é conferida (o programa não lê a página da Magalu).

O que acontece:

- **Preço igual ou mais barato**, ou **mais caro dentro do limite**: a mensagem sai com o preço lido na loja e o desconto recalculado. Preço digitado à mão e diferente do da loja é mantido. Se o preço mudou, a linha do envio no *Histórico* termina em `· preço atualizado de R$ 89,90 para R$ 91,00`.
- **Esgotado**: não sai. `Descartada: esgotado na loja`.
- **Mais caro que o limite**: não sai. `Descartada: preço subiu de R$ 89,90 para R$ 99,90 (+11%, o limite é 5%)`. O **limite padrão de 5%** muda em *Ajustes → Conferir preço e estoque antes de enviar*, com um número inteiro **de 0 a 50%** (0 barra qualquer alta; preço que caiu sempre pode sair).
- **A loja não respondeu** (todas as lojas, menos a Amazon do Catálogo): se os dados da oferta são de até 30 min, ela sai, sem a hora do preço, e a linha do envio termina em `· preço não conferido (a loja não respondeu)`. Se são mais velhos, **não sai**: `Descartada: não deu para conferir o preço (a loja não respondeu)`. Os dados do Disparo automático pela Central são lidos na hora da escolha; os de um envio agendado, do espelhamento ou de um remetente, na criação do envio; uma lista de links com preço digitado não tem idade conhecida (não sai). No **Catálogo** a oferta que não deu para conferir é **pulada**, nunca vai à revisão, e a vaga passa para a próxima: `Pulada: não deu para conferir o preço (a loja não respondeu). O Mercado Livre não sai sem conferir; tenta de novo no próximo envio.`
- **Amazon do Catálogo: o Etiqueta e a reserva de 6 h**: o programa pede ao Etiqueta que releia a página só do produto escolhido, na hora do envio. Preço lido: vale a regra de sempre, e a hora na mensagem é a da leitura. A página sem preço nem estoque: `Descartada: indisponível na loja (a página não mostra preço nem estoque)`. A página de outro produto: `Descartada: a página da loja abriu outro produto (o código não confere com a oferta)`. Leitura que falhou: se o último preço visto tem até **6 h** (a **reserva de 6 h**), a oferta sai com esse preço e a linha do envio termina em `· preço visto às 09:40, não conferido agora (o Etiqueta não respondeu)`; se tem mais, ou a oferta não diz quando o preço foi visto, ela é **pulada**: `Pulada: o preço visto às 02:10 de 10/11 tem mais de 6 h e não deu para conferir agora (o Etiqueta não respondeu). Tenta de novo no próximo envio.` ou `Pulada: não deu para conferir o preço agora (o Etiqueta não respondeu) e a oferta não diz quando o preço foi visto. Tenta de novo no próximo envio.` A oferta que o Etiqueta já não tem (`a oferta saiu do Etiqueta`) não usa a reserva e é pulada: `Pulada: a oferta saiu do Etiqueta e o preço não pôde ser conferido. Ela só volta se o catálogo a trouxer de novo.` Depois de uma falha, o programa deixa de chamar o Etiqueta por 10 min, ou pelo tempo que o Etiqueta pedir (nesse prazo, as Amazon vão direto à reserva); se o Etiqueta só está ocupado com outra leitura (`o Etiqueta estava ocupado com outra leitura da Amazon`), o programa espera alguns segundos e pede de novo. Se o motivo for a atualização de preços do Etiqueta em andamento, a causa mostrada é a mesma, mas o programa não espera nem repete: para de pedir a releitura por um curto tempo (o que o Etiqueta pedir) e as ofertas saem pela reserva ou são puladas. A oferta cuja página a Amazon bloqueou ou não abriu fica 6 h fora da escolha da regra: `Pulada: o preço visto às 02:10 de 10/11 tem mais de 6 h e não deu para conferir agora (a Amazon bloqueou a leitura). Fica 6 h fora da escolha desta regra.` A conferência da hora do preço exige que o Achadinho Turbo e o Etiqueta rodem com o mesmo fuso horário (a hora do preço é local, sem fuso, dos dois lados); com fusos diferentes, toda confirmação é recusada como `o Etiqueta não respondeu`. Hoje os dois rodam no mesmo computador, sem fuso próprio. Com a API da Amazon ligada, nada disso é usado. Os dois "6 h" são diferentes: a reserva é a idade máxima do preço visto; a pausa (abaixo) é o tempo que uma oferta descartada fica fora da escolha.
- **Pulada, descartada e separada para revisão**: **separada para revisão** espera a sua decisão em *Histórico → Catálogo* (Shopee, 100% de desconto, preço antigo 10 vezes maior, queda grande de preço, link que falhou 3 vezes); **descartada** é o verificador barrando de propósito (esgotada, indisponível, preço acima do limite, preço suspeito, página de outro produto) ou o Mercado Livre recusando o anúncio; **pulada** é a oferta que não saiu desta vez e pode voltar (preço sem conferência, produto parecido, fora dos filtros depois da conferência, verificador desligado no meio do envio: `Pulada: o verificador foi desligado durante este envio e o preço não foi conferido. Tenta de novo no próximo envio.`). A pulada por preço impossível de saber (`Pulada: não dá para saber o preço (a página não trouxe o preço). Fica 6 h fora da escolha desta regra.`) fica 6 h fora da escolha, como a oferta da Amazon cuja página falhou na releitura; as outras voltam no próximo envio. Pulada e descartada **não vão à revisão**, e nos três casos a vaga passa para a próxima oferta.
- **Quando sai menos do que o pedido**: toda regra (por intervalo ou horários marcados) deixa no *Histórico* `Saíram 2 de 3 ofertas; 1 pulada (preço sem conferência), 1 descartada (esgotada na loja).`, com os motivos na ordem pulada, descartada, separada para revisão (com motivos diferentes: `2 descartadas (1 esgotada na loja, 1 preço subiu)`), e o fim `não havia mais ofertas novas dentro dos filtros` ou o motivo de parar. Antes dela, uma linha informativa conta as candidatas que nem chegaram a ser escolhidas: `Antes da escolha, 14 ofertas ficaram de fora: 6 fora dos filtros da regra, 5 já enviadas ou parecidas, 3 em pausa de 6 h.` (sem nenhuma sobrando, termina com `Nenhuma sobrou.`). A oferta escolhida que cai fora é reposta pela próxima da lista, até completar as vagas. Quatro motivos de pulada pedem ação sua: `revisão cheia` (revise ou descarte em *Histórico → Catálogo*), `falta conexão com a loja` (conecte a loja em *Conexões*), `link não gerado` (veja o erro na linha acima) e `falha no envio` (veja a linha `Falha no envio` e confira o número em *Números de WhatsApp*).
- **Mercado Livre em espera** (o que se chama de "disjuntor" em conversas técnicas): é a **Central de Afiliados** (o site que gera os links `meli.la`) que para de responder, e é diferente da *pausa da verificação* (30 min, 2 h ou 6 h, quando o Mercado Livre pede verificação no navegador). Uma falha passageira só **pula** a oferta (`Pulada: não deu para gerar o link de afiliado (a Central de Afiliados não respondeu). Tenta de novo no próximo envio.`; na 2ª falha da mesma oferta, a linha acrescenta `É a 2ª vez que falha; na 3ª ela vai para a revisão.`). Com **3 falhas seguidas** o Mercado Livre inteiro entra em espera: `Mercado Livre em espera: a Central de Afiliados falhou 3 vezes seguidas (a Central de Afiliados não respondeu). As ofertas do Mercado Livre esperam e o programa testa de novo em 5 min.` As ofertas dele nem são tentadas (`Catálogo do Etiqueta: 3 ofertas do Mercado Livre esperando: a Central de Afiliados não está respondendo. O programa testa de novo a cada 5 min e elas saem sozinhas quando ela voltar.`), o programa testa **a cada 5 min** com o próximo pedido real, e quando a Central responde: `Mercado Livre voltou: a Central de Afiliados respondeu ao teste (esteve em espera por 1 h 20 min). As ofertas do Mercado Livre saem no próximo envio.` Você não faz nada; só se passar de **1 hora**, abra a Central de Afiliados no Chrome e veja se a página carrega e se a sua conta está logada. No Catálogo, a **3ª falha** da mesma oferta (uma por execução; o contador fica na memória e reiniciar o programa o zera) a manda para a revisão: `Separada para revisão: o link falhou em 3 envios seguidos (a Central de Afiliados não respondeu). Abra a oferta em Histórico > Catálogo, confira e envie à mão.` (se foi a conferência: `a conferência do preço falhou em 3 envios seguidos`). Recusa definitiva do Mercado Livre (anúncio pausado ou inativo): `Descartada: o Mercado Livre recusou gerar o link (o anúncio está pausado ou inativo).` Não conta para a espera. A execução para de repor vagas depois de **120 s** gastos com ofertas que caíram fora (`o tempo para repor vagas acabou`). Quando a leitura do Mercado Livre está em pausa (verificação, limite por hora ou extensão a recarregar), as ofertas dele ficam fora da escolha sem linha de pulada, e a linha informativa diz `5 do Mercado Livre com a leitura em pausa (o Mercado Livre pediu verificação no navegador)`; com o Mercado Livre em espera, vale a espera. Na primeira abertura depois da atualização: `Revisão do Catálogo: 28 ofertas que esperavam revisão só porque o link não foi gerado saíram da fila. Elas voltam se o catálogo as trouxer de novo.`
- **Preço suspeito depois da conferência**: o preço lido na loja 50% ou mais abaixo do preço da lista, desconto de 100% ou preço antigo 10 vezes maior. No Catálogo a oferta vai para a revisão (`Separada para revisão: o preço está 62% abaixo do preço da lista (o limite é 50%), confira o preço.`); nas fontes antigas é descartada e fica 6 horas fora da escolha (`Descartada: preço suspeito (R$ 12,00 na loja, 62% abaixo do preço da lista). Fica 6 h fora da escolha desta regra.`); na fila (Disparo manual e "Enviar") a linha é `Descartada: preço suspeito`. Preço digitado à mão não passa por essa guarda.
- **Causas** que aparecem entre parênteses: a loja não respondeu; a API da Amazon não está ligada; a API da Shopee não está ligada; a Magalu não deixa ler a página; a Shopee não devolveu o produto; a página não trouxe o preço; a loja demorou demais; a extensão do Chrome não está conectada; a extensão do Chrome precisa ser recarregada; o Mercado Livre pediu verificação no navegador; o limite de conferências por hora foi atingido; o produto tem várias versões e o link não diz qual; o Etiqueta não respondeu; a Amazon bloqueou a leitura; o Etiqueta estava ocupado com outra leitura da Amazon; a oferta saiu do Etiqueta; a Central de Afiliados não respondeu; não deu para abrir a Central de Afiliados no Chrome; a Central de Afiliados pediu login; o anúncio está pausado ou inativo. Cada conferência espera até 20 segundos.
- **Mercado Livre pela extensão: limites e verificação**: o programa pede no máximo 120 conferências por hora à extensão; passou disso, a oferta fica sem conferência (`o limite de conferências por hora foi atingido`) e nenhum pedido vai ao Mercado Livre. Se o Mercado Livre responder com uma página de verificação (CAPTCHA, `account-verification`) ou com erro 403/429, o programa para de pedir por 30 min e a causa é `o Mercado Livre pediu verificação no navegador`. Se ele pedir de novo na conferência seguinte, a pausa passa a 2 h e depois a 6 h (o máximo); uma conferência que dá certo volta aos 30 min. A pausa e o limite por hora continuam valendo se o programa reiniciar. A extensão não abre aba, não tenta de novo e não resolve CAPTCHA: para sair disso, abra um produto no Chrome e passe você mesmo pela verificação. Essas conferências não entram no *Histórico* como erro.
- **A conferência do Mercado Livre usa a sua conta**: a extensão abre a página do produto com a sessão do Chrome, a mesma conta de afiliado que gera os links `meli.la`. Só vão à extensão endereços de anúncio (`produto.mercadolivre.com.br/MLB-…`) ou de catálogo (`…/p/MLB…`), nunca outra página da sua conta. Se o *Histórico* mostrar `o Mercado Livre pediu verificação no navegador` várias vezes seguidas, desligue a chave *Conferir antes de cada envio* em *Ajustes → Conferir preço e estoque antes de enviar* (vale para todas as lojas), passe pela verificação no Chrome e ligue de novo. Desligada, nenhuma conferência vai ao Mercado Livre, e os links continuam saindo.
- **Catálogo de várias versões**: o link da Central de Afiliados e o de um `meli.la` costumam abrir a página de catálogo (`/p/MLB…`), que junta versões do produto (cor, voltagem) com preços diferentes. Quando a oferta traz o anúncio, como na Central, a extensão lê a versão dele. Quando não traz: todas as versões esgotadas, `Descartada: esgotado na loja`; todas à venda e até a mais barata acima do limite, `Descartada: preço subiu…`, com o preço da mais barata; nos outros casos, a oferta fica sem conferência, com a causa `o produto tem várias versões e o link não diz qual`. O programa nunca usa o preço de uma versão como se fosse o do anúncio.
- **O que ainda não passa pela extensão**: o *Identificar* e o *Criar* do Disparo manual e a leitura do modo *Link direto* continuam lendo a página do produto pelo programa, e em produção o Mercado Livre costuma barrar essa leitura (o painel responde que não conseguiu ler o produto). A conferência antes do envio não é afetada.
- **Descartada no Disparo automático**: nas fontes antigas (Central de Afiliados, lista de links e busca), a oferta não volta a ser escolhida por 6 horas (a lista é zerada se o programa reiniciar) e a vaga dela passa para a próxima oferta do mesmo envio. No **Catálogo** o descarte é definitivo: a oferta fica registrada como descartada e não volta, e o *Histórico* do catálogo mostra `Descartada: esgotado na loja`, `Descartada: preço subiu`, `Descartada: indisponível na loja` ou `Descartada: a página da loja abriu outro produto`. A pulada não é descarte: não vai à revisão nem ao histórico do catálogo. Nada do verificador entra no Histórico como erro, então nenhum aviso de erro vai por WhatsApp.
- **Disparo manual**: o "agora" vai para a fila e a conferência acontece no momento do envio; a linha do *Histórico* ganha o selo *Descartado* com o motivo. Não existe "Enviar mesmo assim": para mandar um produto cujo preço subiu, dispare de novo (o programa lê a loja outra vez e usa o preço novo como referência). No agendamento, a conferência é na hora do envio; por isso, numa loja que o programa **não consegue conferir** (a Magalu, e a Amazon fora do Catálogo ou a Shopee sem a API ligada), agendar para daqui a **mais de 25 min** é recusado (`Esta loja não tem conferência de preço: agende para até 25 min ou envie agora.`): a oferta sairia com dados de mais de 30 min e seria descartada (a diferença de 5 min é a folga do tick e da fila). Ao clicar em *Identificar*, a dica do agendar já avisa quando a loja é assim.
- **Desligar**: a chave "Conferir antes de cada envio" desliga tudo isso; as ofertas saem sem conferir, e o *Histórico* registra `Verificador desligado em Ajustes`; ao ligar de novo, registra `Verificador ligado em Ajustes`. Mudar o limite também deixa uma linha (`Limite do verificador: 5% → 50%`). Com login no painel, essas linhas terminam com quem salvou: `(por Ana)`.
- **`{HORA_PRECO}`**: campo de template com a hora em que o preço foi visto na loja, como `14h32` (a da conferência na hora do envio ou, se a leitura falhou, a do último preço visto, até 6 h). Vazio quando não há hora; use entre colchetes, como `[🕒 Preço visto às {HORA_PRECO}]`, para o trecho sumir (veja [Template com trecho opcional](#template-com-trecho-opcional)). O programa **não deixa salvar** um template com `{HORA_PRECO}` na mesma linha do `{LINK}` fora de um trecho entre colchetes só dele (sem hora a linha some e a mensagem sairia sem o link): `Ponha o {HORA_PRECO} em outra linha, ou entre [ ] sem o {LINK}: sem conferência de preço, a linha some e a mensagem sai sem o link de afiliado.`

## Ofertas repetidas e parecidas

O Disparo automático não manda o mesmo produto duas vezes, mesmo que a oferta venha com outro código, nem produtos parecidos em sequência. Assim o grupo não vê o mesmo item de novo nem duas versões dele, uma atrás da outra. Vale para o Disparo automático (todas as fontes, inclusive "Enviar agora" e "Ver ofertas") e para o "Enviar" da revisão do Catálogo. **Não vale** para o Disparo manual, o espelhamento nem o remetente (estes têm as suas próprias regras).

Como o programa decide:

- **O que é o mesmo produto:** o título é igual depois de tirar acento, maiúscula, pontuação e palavras como "de", "com", "frete" e "original", e tem 3 ou mais palavras. Ele não sai de novo dentro dos dias de *Não repetir a mesma oferta por (dias)* do disparo, mesmo com outro código. Com **0**, pode voltar entre um envio e outro.
- **O que é parecido:** o programa olha só as 8 primeiras palavras do título. Dois produtos são parecidos quando 75% das palavras são as mesmas. Ofertas parecidas esperam 24 h, mesmo que estejam mais baratas. Depois disso saem como sempre, sem o aviso. A espera nunca passa dos dias de *Não repetir a mesma oferta por (dias)* do disparo, o que só muda algo com menos de 1 dia: com **0**, a parecida não espera entre um envio e outro. Produtos diferentes da mesma marca, de linhas diferentes (um tênis e uma camiseta da Nike, por exemplo), não são parecidos e continuam saindo. Já o mesmo produto em outra versão da mesma linha (outra cor, outro tamanho, ou o shampoo e o condicionador da mesma linha) costuma contar como parecido, porque o título quase não muda. Título com menos de 3 palavras nunca é comparado.
- **No mesmo envio:** produtos parecidos nunca saem juntos, mesmo que um seja mais barato e mesmo com 0 dias. O disparo tenta a próxima oferta.
- **No Catálogo em ordem Novidades:** a oferta pulada conta como tratada e só volta se o Etiqueta atualizar a oferta. A exceção é a pulada por ser parecida com outra do mesmo envio: ela é avaliada de novo na execução seguinte, contra o que saiu de fato. Nas outras ordens e nas outras fontes, a pulada volta a ser avaliada a cada execução.
- **A exceção: o mesmo produto pelo menos 5% mais barato.** Vale só para o mesmo produto com outro código, nunca para os parecidos. Entre um envio e outro, ele sai antes do prazo se estiver pelo menos 5% mais barato que o menor preço com que este disparo já o mandou. Exemplo: saiu por R$ 100,00, então só sai de novo por R$ 95,00 ou menos. Menos de 5% mais barato, preço igual, maior ou sem preço guardado: espera. Se um produto parecido saiu nas últimas 24 h, ele também espera. A mensagem dessa oferta começa com a frase abaixo, seguida de uma linha em branco e da mensagem de sempre, em qualquer template, com ou sem foto:

  🔎 Nossa busca achou esta oportunidade ainda melhor, caso você ainda não tenha aproveitado a primeira.

- **O preço é conferido de novo:** depois de ler o preço na loja ([Conferência de preço e estoque antes do envio](#conferência-de-preço-e-estoque-antes-do-envio)), se a oferta deixou de estar pelo menos 5% mais barata, ela é pulada e não leva a frase. Ela fica 6 horas fora da escolha deste disparo, como a descartada na conferência: a vaga vai para a próxima oferta, e depois desse prazo ela é conferida de novo.
- **"Ver ofertas"** mostra a mensagem como ela sairia, inclusive com a frase, e não grava nada.
- **Envios antigos:** o programa preencheu o título e o preço dos envios do Catálogo que já tinham saído. Envios antigos de outras fontes não têm título guardado e não entram na comparação.

No *Histórico* aparecem linhas informativas (nunca com nome de grupo ou número). Cada conflito aparece uma vez: se a mesma oferta é pulada de novo pelo mesmo motivo nas execuções seguintes, a linha não se repete (se o programa reiniciar, ela pode aparecer mais uma vez).

- `Pulada: o mesmo produto saiu por este disparo às 09:02 de 08/11 por R$ 49,90, com outro código ("…"). Só sai de novo se estiver pelo menos 5% mais barato.`
- `Pulada: parecida com "…", que saiu por este disparo às 09:02 por R$ 49,90. Ofertas parecidas esperam 24 h.`
- `Pulada: parecida com "…", que foi escolhida neste mesmo envio.`
- `Saiu como oportunidade melhor: o mesmo produto saiu às 09:02 por R$ 59,90 ("…"); agora por R$ 49,90.`
- `Pulada: na conferência o preço ficou em R$ 52,00, que não é pelo menos 5% menor que o de "…" (R$ 49,90, às 09:02).`

Se o anterior saiu sem preço guardado, o texto diz `sem preço guardado para comparar` no lugar do valor.

**"Enviar" do Catálogo:** segue a mesma regra. Se a oferta é o mesmo produto e não está pelo menos 5% mais barata, ou é parecida com uma que saiu nas últimas 24 h, o painel recusa o envio com uma frase igual às de "Pulada", mas começando por `Não enviada:`, e a oferta continua esperando a revisão. Se o disparo está mandando agora a mesma oferta ou uma parecida, o envio é recusado mesmo que esta esteja mais barata, como duas parecidas no mesmo envio: `Não enviada: parecida com "…", que está saindo agora por este disparo. Tente de novo em alguns minutos.` Se é o mesmo produto pelo menos 5% mais barato, sai com a frase, e a linha `Saiu como oportunidade melhor` entra no *Histórico* só depois que a fila manda a oferta a algum grupo. O preço que vale é o que você deixou em *Revisar oferta*. Na fila, o preço é conferido de novo na loja: se subiu e não está mais pelo menos 5% abaixo, a oferta é descartada com `Descartada: preço subiu para R$ 52,00 e não está mais pelo menos 5% abaixo do da mesma oferta enviada antes (R$ 49,90)`, e o botão *Enviar de novo* continua lá. Com **0** dias, o "Enviar" não faz essa comparação.

O grau de semelhança (75%), as 24 h, as 8 palavras e os 5% são fixos: não há campo nem tela para mudar.

## Horários marcados e Grupo vivo

Duas formas de ritmo que não mudam nada do que já existe: um disparo sem horários marcados e os envios de *Disparar mensagem* continuam como antes.

### Horários marcados (a grade)

Em *Disparo automático → Novo disparo automático → Ritmo de envio*, o **Como enviar** tem duas opções: **A cada X minutos** (o padrão, com "Funciona das/até") e **Em horários marcados**. A grade é opcional, disparo por disparo.

- **O que é**: uma lista de horários do dia, cada um com as suas **Ofertas** e o seu **Template** ("Padrão do disparo" usa o do disparo), e os **dias da semana** em que ela vale (o padrão é todos).
- **Limites**: até 48 horários, com pelo menos 10 min entre um e outro (inclusive da noite para a manhã: 23:55 e 00:00 não cabem juntos) e sem horário repetido; de 1 a 20 ofertas por horário. Um template que não existe é recusado.
- **Mexer na lista**: as linhas só se reordenam quando você sai da lista (outro campo ou botão, ou *Enter*, que não salva o disparo); o aviso "Horário 21:00 movido para a posição 27." e um contorno na linha duram até a sua próxima ação. *Copiar* cria a linha logo abaixo da original e *+ Adicionar horário* a põe no fim; a barra com esse botão e *Limpar tudo* fica acima da lista e acompanha a rolagem (em tela estreita, só os avisos acompanham). *Remover* e *Limpar tudo* não pedem confirmação e mostram o aviso com *Desfazer* ("Horário 12:00 removido."), que devolve as linhas com o que estava digitado até a próxima alteração da lista; um clique duplo em *Remover* apaga uma linha só. *Cancelar* e *Esc* com alterações não salvas perguntam "Descartar as alterações?".
- **Modelos rápidos e Montar…**: "A cada 30 min, 8h às 22h", "A cada hora, 8h às 22h", "Manhã, tarde e noite" e "Horários de pico" preenchem a lista, e *Montar…* faz o mesmo com o seu "De", "Até", "A cada" e "Ofertas em cada". Os modelos rápidos e o *Montar…* incluem o horário final. *Substituir horários* troca a lista; *Acrescentar* soma. Nada é salvo até clicar em *Salvar*.
- **O ritmo atual vira a grade**: na primeira vez que você troca para *Em horários marcados*, o painel converte o intervalo e a janela em horários. O horário final não entra: "a cada 60 min, das 8h às 22h" vira 14 horários, das 08:00 às 21:00. Se não couber (mais de 48 horários ou menos de 10 min entre eles), a lista começa vazia. Voltar para *A cada X minutos* restaura o ritmo anterior, porque os campos ficam guardados.
- **A janela não vale**: em horários marcados, o "Funciona das/até" não vale. Os valores ficam guardados. O **horário de silêncio** de *Ajustes* vale: um horário marcado que cai nele é pulado, com aviso.
- **Horário perdido**: o horário sai se atrasou até 30 min (programa desligado, WhatsApp fora, fila ocupada). Passou disso, é pulado, com um aviso no *Histórico*. Se vários venceram, sai só o mais recente. As frases:
  - `Horário 10:00 pulado: o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 12:00.`
  - `3 horários pulados (10:00 a 12:00): o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 13:00.`
  - `8 horários pulados (09:00 de 03/11 a 13:00): o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 21:00.` (o programa ficou dias desligado: o Histórico traz um aviso só, com o primeiro e o último horário pulados, em vez de um por horário; o de outro dia vem com a data. Depois de muitos dias, o número pode ficar abaixo do total, porque o programa não confere um por um os horários do meio)
  - `Horário 10:00: saíram 5 de 8 ofertas; não havia mais ofertas novas dentro dos filtros.` (faltou oferta: sai o que houver, sem acumular para o horário seguinte)
  - `Horário 10:00: saíram 4 de 5 ofertas; 1 descartada (esgotada na loja); não havia mais ofertas novas dentro dos filtros.` (uma oferta esgotada não saiu e a vaga dela foi para a próxima da lista, mas faltaram ofertas novas; a frase cita as puladas, as descartadas e as separadas para revisão, com o motivo de cada uma)
  - `Horário 10:00: o template escolhido para este horário não existe mais. As ofertas saíram com o template da regra.`
- **Enviar agora e Ver ofertas**: usam a quantidade e o template do próximo horário. *Enviar agora* envia de verdade, mas não pula esse horário.
- **Template em uso**: um template usado numa grade não pode ser apagado: `A regra "Promoções" usa este template no horário 10:00.`
- **Cartão**: ganha o selo *Grade*, um resumo e o "Próximo envio … N ofertas com o template X".

### Grupo vivo

Em *Disparos → Grupo vivo*, rotinas que mandam sozinhas **mensagens** ou **enquetes** para os grupos. Não é oferta: as ofertas saem pelo Disparo automático.

- **Rotina**: um nome (só você vê), liga e desliga, o tipo (*Nova mensagem* ou *Nova enquete*, que não muda depois), de 1 a 5 conteúdos (até 5 textos ou enquetes), os grupos, os dias da semana e até 6 horários por rotina. O programa guarda até 50 rotinas. Sem foto por enquanto.
- **Ordem**: com mais de um conteúdo, *Um depois do outro* segue a lista e volta ao primeiro; *Sorteio* escolhe ao acaso, sem repetir o último.
- **Cartão**: cada rotina vira um cartão com o "Próximo envio" e quantas saíram nas últimas 24 horas. A lista se atualiza sozinha a cada 10 s, enquanto nenhum formulário está aberto.
- **Modelos**: a galeria tem 10 modelos (seis mensagens e quatro enquetes). *Usar este modelo* só preenche o formulário: nada é salvo até *Criar rotina*.
- **Horário perdido**: a mesma regra da grade (atrasou até 30 min, senão é pulado, e sai só o mais recente). As frases: `Horário de 05/11 10:00 pulado: o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 05/11 18:00.` e, quando vários passaram (o programa ficou dias desligado), um aviso só, com o último: `7 horários pulados, o último de 05/11 08:00: o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 05/11 18:00.`
- **Enviar agora**: manda a rotina já, avança o rodízio e não muda o próximo horário. Para a mesma rotina, só vale um a cada 1 min.
- **Histórico**: os envios aparecem como `Grupo vivo: nome da rotina`, em *Tudo* (não há tipo próprio). Excluir uma rotina não apaga o que ela já enviou. O Operador pode criar e mudar rotinas, como no Disparo automático.
- **Fila e pausas**: tudo sai pela mesma fila, com as pausas de *Ajustes*.
- **Silêncio**: uma rotina cujo horário cai no horário de silêncio de *Ajustes* é **pulada**, com aviso; o *Enviar agora* no silêncio é recusado na hora, com o motivo, sem gravar nada nem andar o rodízio. As mensagens contam no limite por hora. Veja [Proteção do número](#proteção-do-número-anti-banimento).

### Aviso de volume

O painel soma as mensagens por dia dos disparos e das rotinas ligados e, com mais de 400 mensagens por dia, mostra um aviso no formulário. No *Disparo automático*, quando há outros disparos ou rotinas ligados, o aviso diz "Somando os outros disparos e rotinas ligados, este número…"; quando só o disparo aberto entra na conta, diz "Este número…". É só um aviso: o programa nunca bloqueia por causa dele. O WhatsApp não publica um limite, então o 400 é uma estimativa prudente. O que segura o número de verdade é o limite por hora de *Ajustes → Proteção do número* (veja a seção a seguir).

Honestamente: a grade e o Grupo vivo foram testados com o WhatsApp simulado (`test/grade.test.js`, `test/rotinas.test.js`, `test/grade-painel.test.js`, `test/grupovivo-painel.test.js`); não foi testado contra o WhatsApp real, que exige a sua conta. Confira com uma rotina de teste num grupo seu antes de ligar as de verdade.

## Proteção do número (anti-banimento)

A conexão com o WhatsApp é não oficial: o WhatsApp pode restringir um número que manda muito, rápido demais ou de madrugada. O cartão **Ajustes → Proteção do número** segura o programa antes disso, para **toda** mensagem que o número envia (disparos automáticos, Disparo manual, Disparar mensagem, Grupo vivo, espelhamento, remetente, Catálogo, avisos e *Enviar teste*). Os valores já vêm num padrão seguro; só o **Dono** muda (o Operador vê os valores, com os campos desabilitados) e cada mudança vira um aviso no *Histórico*, com "(por nome)".

| Controle | Padrão | Faixa |
|---|---|---|
| Máximo de mensagens por hora | 40 | de 1 a 200 |
| Horário de silêncio | ligado, das 23:00 às 07:00 (hora do computador) | dois horários diferentes; pode virar a noite |
| Pausa entre um grupo e outro | 6 s | de 2 a 60 s |
| Pausa entre uma oferta e a próxima | 30 s | de 5 a 600 s |

- **Limite por hora**: janela deslizante de 60 minutos ("Na última hora: 12 de 40", também em *Números de WhatsApp*). **Mensagem** é um envio a **um** grupo: uma oferta para 5 grupos são 5 mensagens. Toda mensagem conta, mas só o que vai a **grupo** espera; o privado (avisos, *Enviar teste* e a resposta ao remetente) nunca fica preso. Com o limite cheio, nada sai duas vezes e nada se perde sem aviso: o disparo por intervalo volta a rodar quando houver vaga (cada grupo é uma vaga: a oferta que não cabe inteira vai aos grupos que couberam e a execução para ali); o envio da fila volta a pendente e retoma só os grupos que faltam (um grupo cujo envio deu falha não é tentado de novo na mesma vez); o que espera mais de 2 horas atrás do limite é descartado com o aviso `Não enviado: o limite de 40 mensagens por hora ficou cheio por mais de 2 h.` (aviso, não erro); um horário marcado espera dentro dos 30 min de tolerância e depois é pulado; o *Enviar agora* de um disparo automático não sai, o painel mostra o motivo e o *Histórico* ganha um aviso. O *Histórico* ganha **uma** linha de aviso por vez que o limite enche ("Limite de 40 mensagens por hora atingido: o que falta sai a partir das 15:20."), sempre aviso, nunca erro. Não existe "Enviar mesmo assim" para o limite.
- **Horário de silêncio**: soma com o "Funciona das/até" de cada disparo (sai só o que os dois permitem). O que cai nele:
  - **disparo a cada X minutos**: adiado para o fim do silêncio;
  - **com hora marcada** (horários marcados, agendado, repetido e Grupo vivo): **pulado**, com aviso, e não sai quando o silêncio acabar (`Horário 10:00 pulado: horário de silêncio.`), mesmo que só seja visto depois dele (programa desligado de madrugada); uma repetição segue para a próxima ocorrência;
  - ***Enviar agora* do Grupo vivo**: recusado na hora (`Horário de silêncio até 07:00: o Enviar agora do Grupo vivo não sai agora.`), sem gravar nada nem andar o rodízio;
  - **"agora"** (Disparo manual, Disparar mensagem, espelhamento, remetente e Catálogo): espera o fim do silêncio, e o tempo em silêncio não conta para as 2 horas de atraso máximo;
  - ***Enviar agora* de um disparo automático**: não sai; o painel e o *Histórico* dizem `Enviar agora não saiu: horário de silêncio até 07:00.`.
- **Enviar mesmo assim**: só no envio **"agora"** do *Disparo manual* e do *Disparar mensagem* que cairia no silêncio (aviso com "Enviar mesmo assim" e "Cancelar"). Ele ignora o silêncio, mas nunca o limite por hora. Agendado e repetido dentro do silêncio mostram só o aviso de que serão pulados, e o servidor recusa o pedido (erro 400).
- **Pausas**: variam ±30% ao acaso em torno do valor de Ajustes (6 s vira de 4 a 8 s) e agora valem entre **quaisquer duas mensagens** do número, de qualquer origem. O cartão mostra a faixa ("Na prática: de 4 a 8 segundos…"). Um valor antigo gravado fora da faixa vale como o mínimo ou o máximo. O cartão antigo "Pausas entre mensagens" virou parte deste.
- **Grupos**: o selo **Falta 2º admin** aparece em todo grupo com um só administrador (contado na sincronização, a cada 10 minutos e no botão *Atualizar lista de grupos*; o programa guarda só quantos admins há, nunca quem são). Para resolver, abra o grupo no WhatsApp e toque em *Tornar admin* para um membro de confiança.
- **Fora do programa (com você)**: um 2º admin em cada grupo e combinar quantas ofertas por dia cada grupo recebe (o programa só avisa acima de 400 mensagens por dia). Tenha um segundo chip de reserva, com WhatsApp Business instalado, e deixe esse número também dentro dos seus grupos. Se este número for restringido, você o conecta em *Números de WhatsApp* e continua enviando. Trocar para o chip reserva herda a contagem da última hora.
- **Desligar**: ponha o limite em 200 e desligue "Não enviar de madrugada".

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

1. O programa lê o link da mensagem (aceita `amazon.com.br/dp/…`, `amazon.com.br/<nome>/dp/…`, `link.amazon`, `amzn.to`, `amzn.com` e `a.co`, com ou sem parâmetros e até sem `https://`). Se for link curto, abre-o **só** em endereços da Amazon (e no `amzlinks.in`, um redirecionador de terceiro, não da Amazon, aceito apenas no meio do caminho e só nesse endereço exato, sem subdomínio), seguindo os redirecionamentos, até achar o código do produto (o **ASIN**). Não lê a página.
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
- `{HORA_PRECO}` (a hora em que o preço foi visto na loja, como `14h32`) fica vazio sem hora: ponha-o sempre entre colchetes, como `[🕒 Preço visto às {HORA_PRECO}]`. Sem colchetes, a linha inteira some quando não há hora, como qualquer campo vazio; por isso ele não pode ficar na mesma linha do `{LINK}` (o programa recusa salvar assim).

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
2. **User-Agent de navegador para abrir o link curto.** Para o `link.amazon` devolver o redirecionamento, o programa se apresenta como um navegador comum (Chrome) ao abrir o link, só em endereços da Amazon (e no `amzlinks.in`, redirecionador de terceiro que o `link.amazon` usa, quando aparece no meio do caminho e só nesse endereço exato) e sem ler a página. Se você não quiser esse comportamento, diga: sem ele, link curto pode não resolver e só links longos (`…/dp/<ASIN>`) funcionam.

O endereço da API (`creatorsapi.amazon`) e os nomes dos campos da resposta vêm da documentação da Amazon e **nunca foram conferidos contra a Amazon real**: o botão **Testar** é quem confirma isso na sua conta.

## Catálogo do Etiqueta

O **Etiqueta** é o seu outro programa, que coleta e organiza ofertas e roda neste mesmo computador (`python3 servidor.py`). O **Catálogo** é a fonte do *Disparo automático* que lê as ofertas dele, já com o link de afiliado de cada loja (Mercado Livre, Amazon e Shopee). Três coisas diferentes, com nomes parecidos:

- **etiqueta de afiliado do Mercado Livre**: o nome criado na Central de Afiliados, que vai no link `meli.la` e define de quem é a comissão (*Conexões → Mercado Livre*);
- **Etiqueta (o app)**: o seu outro programa, o dono das ofertas;
- **Catálogo**: a fonte do painel que lê as ofertas do app Etiqueta. A interface só escreve "Etiqueta" no cartão de Conexões e nos Docs; nas regras e no Histórico é sempre "Catálogo".

### Configurar

1. Deixe o Etiqueta ligado (`python3 servidor.py`) com o arquivo `api_token.txt` na pasta dele.
2. Em *Conexões → Catálogo do Etiqueta* (só o **Dono** salva e testa), preencha:
   - **Endereço do Etiqueta**: `http://127.0.0.1:8765` (já vem preenchido) ou `http://localhost:8765`. Só vale `http`, só `127.0.0.1` ou `localhost`, com a porta e **sem nada depois dela**. Prefira `127.0.0.1`: o `localhost` pode resolver para um endereço que o Etiqueta não escuta.
   - **Arquivo do token**: o **caminho** do `api_token.txt` (começa com `/` ou `~/`, até 500 caracteres), por exemplo `/home/<você>/…/api_token.txt`. O arquivo **precisa se chamar `api_token.txt`** e não pode ser um atalho (link simbólico): qualquer outro nome é recusado, para que o painel nunca leia outro arquivo de segredo do computador. **Nunca o conteúdo do arquivo**: o painel recusa um caminho que pareça o próprio token (32 ou mais letras, números, `_` e `-`) e não repete o que você digitou. Se você colou o token em algum lugar, gere outro no Etiqueta.
3. Clique em **Salvar** e depois em **Testar**. O teste usa o que está **salvo**, não o que está digitado.

### Estados do cartão

O selo diz em que ponto está, sempre com texto:

| Selo | Quando |
|---|---|
| *Falta configurar* | sem endereço ou sem caminho do token salvos |
| *Salvo, ainda não testado* | salvo, nenhum teste ainda |
| *Conectada* | o último teste (ou a última leitura de uma regra) foi aceito |
| *Token recusado* | o Etiqueta respondeu 401. O Etiqueta lê o arquivo do token só ao ligar: depois de trocar o token, reinicie o `servidor.py` e teste de novo |
| *Indisponível* | o Etiqueta está desligado ou sem rede (`fora_do_ar`), está no ar com a API desligada (`desligada`: falta o `api_token.txt` ou ele é inválido) ou respondeu fora do contrato (`resposta_inesperada`) |
| *Arquivo do token não encontrado* | o painel não achou ou não conseguiu ler o arquivo, ou ele está vazio ou fora do formato (até 4096 bytes, só 32 ou mais letras, números, `_` e `-`) |

O **Testar** mostra uma frase por resultado e, quando conecta, "Conectado. N ofertas em M categorias." com a lista de **categorias** e o total por loja (Mercado Livre, Amazon, Shopee). Essa lista é a **da última vez que você clicou em Testar**: abrir a tela de uma regra não a atualiza, e o painel nunca chama o Etiqueta para isso. O Operador vê o selo e as categorias, mas não muda a conexão.

### Como a regra usa a fonte

Em *Disparo automático → Novo disparo → De onde vêm as ofertas*, escolha **Catálogo (app Etiqueta)**. Uma regra aceita até 5 fontes, misturando Catálogo com Central, lista de links e busca. A fonte do Catálogo tem:

- **Categorias** do Etiqueta (até 20; nenhuma marcada = todas; com várias, vale qualquer uma delas).
- **Lojas**: Mercado Livre, Amazon e Shopee (nenhuma marcada = as três).
- **Buscar por**: até 10 palavras separadas por vírgula (até 200 caracteres no total). Basta uma aparecer no título; não diferencia maiúscula nem acento.
- **Desconto mínimo no catálogo (%)**: número inteiro de 0 a 99. Vale só para esta fonte; o *Desconto mínimo (%)* em *Filtros* é o filtro geral do disparo.
- **Ordem**: *Novidades* (padrão), *Mais vendidos*, *Maior desconto*, *Menor preço*, *Maior preço*, *Com cupom primeiro* e *Coletadas há menos tempo*. A ordem aleatória não existe aqui.
- Os filtros de preço e de desconto da própria regra continuam valendo por cima.

O painel lê o Etiqueta em **páginas de 200 ofertas, um pedido por vez** (nunca dois pedidos ao mesmo tempo ao Etiqueta, mesmo com várias regras). Cada oferta é identificada pelo código da loja (Mercado Livre `MLB…`, Amazon pelo ASIN, Shopee por `loja.item`): a mesma oferta não sai duas vezes na mesma regra, o mesmo produto com outro código só sai antes da espera se estiver pelo menos 5% mais barato, e um produto parecido espera 24 h (veja [Ofertas repetidas e parecidas](#ofertas-repetidas-e-parecidas)). Oferta fora do formato esperado (título, código ou preço inválido, ou link da Shopee fora de `s.shopee.com.br`) é ignorada, e um aviso no *Histórico* diz quantas. Só o link da Shopee é conferido (os do Mercado Livre e da Amazon são refeitos pelo painel); foto de fora das lojas é descartada e a oferta sai sem ela.

**Novidades começa do fim.** Na **primeira leitura** de uma fonte nessa ordem (e sempre que você muda os filtros dela), o painel só percorre o catálogo até o fim, marcando o ponto de partida, **sem enviar nada** (até 20 páginas por execução; se o catálogo for maior, a próxima execução continua de onde parou). Enquanto isso, a prévia (*Ver ofertas*) avisa "Primeira leitura" e não mostra ofertas dessa fonte. Depois disso, cada execução envia o que **chegou ou foi atualizado no catálogo depois** (uma nova coleta do Etiqueta conta como atualização), e uma oferta tratada nunca sai de novo nesse disparo, nem com "dias sem repetir" em 0. O ponto de partida só avança por páginas inteiras já tratadas, então nada se perde, e uma oferta que ficou esperando (veja abaixo) segura a leitura naquela página até ser tratada.

**Reler do começo** (ao editar a regra, só o Dono): na próxima execução, o painel confere o catálogo inteiro de novo, em **todas as fontes Catálogo em Novidades** da regra. Serve para mandar o que já estava lá antes de você salvar, ou depois de reorganizar categorias no Etiqueta. Ofertas já tratadas não se repetem. Não funciona com a regra rodando (o painel pede para tentar de novo).

**As outras ordens** não usam ponto de partida: cada envio lê as páginas do início até achar ofertas ainda não tratadas (o maior entre 20 e 4 vezes as "ofertas por envio", em até 10 páginas) e pega as melhores. Vale o "não repetir por N dias" da regra (0 = pode repetir). Oferta que foi para a revisão ou descartada não volta.

Se o Etiqueta cair, a fonte aparece como **indisponível** (chip "Catálogo indisponível" nos disparos que a usam, com a hora em que começou), o *Histórico* registra o motivo e as outras fontes da regra seguem normalmente. Nada é enviado por essa fonte até ele voltar. Você pode salvar a regra mesmo com o catálogo fora do ar.

### O link de cada loja

Nenhum link comum sai: o link do Etiqueta só é usado onde descrito abaixo.

- **Mercado Livre**: o programa pega o código `MLB…` da oferta e **gera de novo o link `meli.la` pela extensão do Chrome**, com a **etiqueta da regra** (ou a da fonte). O link que vem do Etiqueta não é usado. Com a **extensão desligada**, essas ofertas **esperam** e saem sozinhas quando ela voltar (o *Histórico* avisa; não vão para a revisão). Com o modo de link em "Link direto" (sem etiqueta, só para testar), as ofertas do Mercado Livre do catálogo **não saem**, porque seriam links comuns.
- **Amazon**: o link é **remontado** como `https://www.amazon.com.br/dp/<ASIN>?tag=<sua tag>`, com a **tag de *Conexões → Amazon***. Sem a tag salva, as ofertas da Amazon esperam (com aviso).
- **Shopee**: **toda** oferta da Shopee vai para a **revisão**. O link curto do Etiqueta não prova de quem é a conta de afiliado, por isso o Dono confere antes. Aprovada, sai com o link `s.shopee.com.br` do próprio catálogo (qualquer outro endereço é recusado), não pela API nem pela extensão da Shopee.
- **Foto**: só de endereços de imagem da própria loja (Mercado Livre, Amazon e Shopee). Foto de outro lugar é descartada e a mensagem sai só com texto.

Uma regra cujas fontes são **só Catálogo de Amazon e/ou Shopee dispensa a etiqueta do Mercado Livre**: o campo "Etiqueta ML padrão" (a etiqueta de afiliado do Mercado Livre) fica opcional e o servidor não recusa a regra por falta dela. Se alguma fonte puder trazer Mercado Livre (inclusive um Catálogo sem lojas marcadas, que vale por todas), a etiqueta continua obrigatória.

### O que vai para a revisão

Nenhuma oferta suspeita sai sozinha. Vão para a revisão, em vez de ser enviadas:

- toda oferta da **Shopee**;
- oferta com **desconto de 100%**;
- oferta com **preço antigo 10 vezes maior** que o preço (ou mais), provável erro de preço no catálogo;
- oferta com **preço 50% ou mais abaixo do preço da lista** (`Preço muito abaixo da lista: confira o preço`), que pode ser promoção de verdade ou preço errado: você confere na loja e decide;
- oferta do Mercado Livre cujo **link ou conferência falhou em 3 envios seguidos** (`Falhou 3 vezes seguidas: confira a oferta e envie`; uma falha passageira só pula a oferta);

Oferta esgotada, indisponível, com a página de outro produto, com preço suspeito, recusada pelo Mercado Livre ou mais cara que o limite é **descartada**, e a que não deu para conferir o preço é **pulada** no Catálogo (nas fontes antigas, com dados de mais de 30 min, também é descartada): nenhuma das duas vai à revisão (veja [Conferência de preço e estoque antes do envio](#conferência-de-preço-e-estoque-antes-do-envio)).

A oferta separada para revisão libera a vaga, que passa para a próxima da lista; por isso a fila de revisão de uma regra com muita Shopee enche mais depressa. Cada regra guarda **no máximo 50** ofertas esperando: acima disso, as novas esperam sem entrar na fila (chip "Revisão cheia (50)" e aviso no *Histórico* a cada execução) até você revisar ou descartar algumas.

**Só o Dono revisa.** Em *Histórico → Tipo → Catálogo* há a lista de tudo o que passou pelo catálogo (enviadas sozinhas, enviadas pela revisão, para revisar e descartadas). Em "Para revisar", o botão **Revisar** abre a oferta: o Dono abre o link para conferir o produto, corrige título, preços, cupom, frete e foto se precisar, e **envia** (para os grupos, o template e a opção de foto da regra) ou **descarta**. A revisão aceita cupom de até 100 caracteres (o do catálogo). Se o "Enviar" da revisão não chegar a **nenhum** grupo, a oferta **volta para a revisão** com `Último envio falhou: a oferta não chegou a nenhum grupo. Ela continua na revisão: tente de novo.` e o erro de cada grupo; com o Mercado Livre em espera, o "Enviar" responde que a Central não está respondendo e pede para enviar quando ela voltar. Se o envio não chegar a **nenhum** grupo, a linha mostra o erro e o botão **Enviar de novo** (só o Dono), que abre a mesma tela. O Operador vê a lista, mas não revisa nem envia (o servidor responde 403). O número de ofertas para revisar aparece no cartão da regra, no *Histórico* e no menu, só para o Dono.

**Não existe "Enviar mesmo com 100%".** Com preço antigo 10 vezes maior que o preço (ou um 100% que saia da conta dos dois preços), o "Enviar" só funciona depois de você **corrigir o preço ou apagar o preço antigo** ("Corrija o preço ou apague o preço antigo para enviar."); sem preço antigo, a mensagem sai sem o "de/por" e sem desconto. Quando o 100% é só o número informado pelo Etiqueta (comum na Shopee, que não traz preço antigo), o "Enviar" fica liberado depois da revisão: esse número **nunca vai na mensagem**, que sai sem desconto (ou com o desconto calculado dos dois preços, se houver preço antigo). O servidor confere de novo a conta com os valores enviados. A lista do *Histórico* mostra no máximo as 200 mais recentes; com mais que isso, filtre por disparo (cada um guarda até 50 para revisar). O envio aprovado usa a fila de envios (as pausas de *Ajustes* valem) e precisa do WhatsApp conectado; no Mercado Livre também da extensão on-line e da etiqueta, e na Amazon da tag. Se outra pessoa já tratou a oferta, a tela avisa "Esta oferta já foi tratada."

### Privacidade e segurança

- **O token nunca vai a banco, log, URL, mensagem de erro, resposta da API do painel nem tela.** O painel guarda só o **endereço** e o **caminho** do arquivo (nenhum dos dois é segredo). O arquivo é **lido a cada pedido**, só numa variável local, e o conteúdo é conferido (formato de token, até 4096 bytes, arquivo comum) antes de ir ao Etiqueta; um arquivo qualquer não vira cabeçalho. Sem caminho salvo, o programa não lê nem chama nada.
- **O Etiqueta só aceita pedidos do servidor, nunca do navegador** (ele recusa pedidos com `Origin`). Por isso o painel não fala com ele: tudo passa pelas rotas do próprio programa. O servidor só chama endereços deste computador, não segue redirecionamentos, desiste em 15 segundos e limita a resposta a 2 MiB.
- Os textos que vêm do Etiqueta (título, categoria, cupom) são tratados como texto cru e escapados em toda a tela.
- O que fica em `data/disparador.db`: as categorias da última verificação (`settings`), o ponto de partida de cada fonte (`catalogo_cursores`) e, para cada oferta tratada, título, preço, foto, categoria e link (`catalogo_itens`). **Não há dado pessoal**, mas os backups carregam tudo isso. Apagar uma regra apaga na hora os itens e o ponto de partida dela; "Limpar já enviadas" apaga também as enviadas do catálogo (as em revisão e as descartadas ficam).

## Remetente: links enviados por outro número

Um **remetente** é um número de WhatsApp de confiança, como o do seu sócio, que manda links de produto no **privado** do número conectado. O programa monta a oferta e a envia aos grupos que você escolheu, **sem pedir a sua aprovação**. O link sai sempre com a **sua** afiliação, nunca com a de quem mandou. Qualquer número que você não cadastrou é ignorado, sem resposta.

Isto foi testado só com o WhatsApp, as lojas e a extensão **simulados**; a prova com o celular do sócio é o último passo (veja [O que foi testado e o que não foi](#o-que-foi-testado-e-o-que-não-foi)).

### Cadastrar

Em *Disparo automático → Novo remetente* (só o Dono cadastra, edita, liga e exclui; o Operador só vê):

1. **Nome** (só você vê) e **Número do remetente**, com DDD, por exemplo `(35) 99999-1234`. O programa confere se o número existe no WhatsApp. O número conectado ao painel não pode ser o remetente, e o mesmo número não entra duas vezes.
2. **Grupos de destino**: para onde vão todos os links deste número (de 1 a 500 grupos). *Marcar um bloco…* só ajuda a marcar: se o bloco mudar depois, a lista não muda.
3. **Template** (precisa do campo `{LINK}`), **Etiqueta do Mercado Livre** (vale só para o Mercado Livre) e **Foto do produto**.
4. **Ritmo e proteção**: *No máximo (links por hora)* e *Não repetir o mesmo produto por (horas)* (veja [Limites do remetente](#limites-do-remetente)).
5. **Responder ao remetente no WhatsApp** (ligado por padrão) e *Ligar agora*.

Cada remetente vira um cartão com interruptor, o resumo das últimas 24 horas (recebidos, enviados, repetidos, descartados, com erro) e os botões *Ver registro*, *Editar* e *Excluir*. Desligado, ele continua cadastrado, mas os links dele são ignorados em silêncio. Se algo impede o envio, o cartão mostra o problema. Grupo de que o número saiu, template ou etiqueta apagados aparecem logo. O aviso de tag da Amazon, ID da Shopee ou nome da loja da Magalu faltando só aparece depois que um link do remetente foi barrado por isso.

### As quatro lojas

O programa **nunca reenvia o link que o remetente mandou**: ele lê o produto e gera o seu.

| Loja | Como o link sai | O que precisa estar pronto |
|---|---|---|
| Mercado Livre | Um `meli.la` novo, gerado pela extensão do Chrome, com a etiqueta escolhida no remetente | A etiqueta em *Conexões → Mercado Livre* e a extensão conectada. No modo de link direto o Mercado Livre não sai |
| Amazon | O endereço do produto (`/dp/<ASIN>`) com a sua tag de associado | A tag em *Conexões → Amazon* |
| Shopee | Um link curto gerado pela sua conta, pela API ou pela extensão | O ID de afiliado em *Conexões → Shopee* e a API da Shopee ou a extensão do Chrome conectada |
| Magalu | O endereço do produto na sua loja de parceiro (`magazinevoce.com.br/<sua loja>/…`); a loja que veio no link do remetente nunca vale | O nome da loja em *Conexões → Magalu* |

Os links do remetente seguem o [código de rastreio](#rastreio-por-grupo-e-página-ganhos) de cada grupo (a Magalu não tem rastreio por grupo), como no *Disparo manual*: a etiqueta do grupo vence a escolhida no remetente e, na Shopee, o link sai com o Sub_id do bloco.

Título, preço e foto vêm da loja. Quando a loja não informa algum campo, o programa completa com o que o remetente escreveu na mensagem (título na primeira linha, "De R$", "Por R$", "NN% OFF", frete e cupom), mas **só quando a mensagem tem um link só**; veja [Formato de mensagem de origem que funciona](#formato-de-mensagem-de-origem-que-funciona). Na Magalu nada vem da loja: título e preço têm de estar na mensagem. **Sem título ou sem preço a oferta não sai**: o remetente é orientado a mandar o link junto com o nome e o preço. Um link do Mercado Livre que o programa não consegue ligar a um produto também é recusado.

### O que o remetente recebe

Com *Responder ao remetente no WhatsApp* ligado, ele recebe **uma frase por mensagem**, depois que os envios dela terminam. A resposta **nunca leva link, número, nome de grupo nem o texto que ele mandou**.

| Situação | Frase |
|---|---|
| Saiu para todos os grupos | "Enviado para 3 grupos." (ou "Enviado para 1 grupo.") |
| Saiu só para alguns | "Enviado para 2 de 3 grupos." |
| Não saiu para nenhum | "Não consegui enviar esse link para os grupos. O dono vai ver o motivo no painel." |
| Produto repetido | "Esse produto já foi enviado há 3 h. Não repeti." |
| Falta afiliação, grupo ou template | "Não consegui montar esse link agora. O dono vai ver o motivo no painel." |
| Sem título ou sem preço | "Não consegui ler os dados desse produto. Mande o link junto com o nome e o preço." |
| Link que não é de produto | "Não reconheci esse link. Mande o link da página do produto." |
| Mensagem com link, mas de outra loja | "Não encontrei um link do Mercado Livre, Amazon, Shopee ou Magalu nessa mensagem." |
| Passou do limite por hora | "Muitos links em pouco tempo. Tente de novo daqui a pouco." (no máximo 1 vez por hora) |
| Vários links na mesma mensagem | "Recebi 3 links: 2 enviados, 1 repetido." |

Mensagem **sem nenhum link**, número desconhecido, remetente desligado e mensagem da própria conta não recebem nada: silêncio. Assim ninguém descobre, testando, se um número está cadastrado.

### Limites do remetente

Servem para proteger os seus grupos, caso o número do remetente caia em outras mãos.

- **Links por hora**: **10 links por hora por remetente** por padrão; o campo aceita **de 1 a 60 links por hora**. Os que passam disso são descartados (uma linha por hora no Histórico) e o remetente recebe a frase de limite.
- **Mesmo produto**: **24 h sem repetir** por padrão (de 0 a 8760; **0 = pode repetir**). Vale por remetente, mesmo com link diferente, e não cruza com as regras, o espelhamento nem o Disparo manual. O mesmo produto também não sai duas vezes na mesma mensagem.
- **Links por mensagem**: até **5 links por mensagem**; o resto é ignorado.
- **Mensagem enviada com o programa fora do ar**: o que o remetente mandou enquanto o programa estava desligado ou sem conexão com o WhatsApp **não é processado**, sem resposta; ele precisa mandar de novo. Um link que já foi aceito e ficou parado na fila por **mais de 2 h** expira e não sai.
- **Respostas**: até **20 respostas por hora** por remetente.

Os envios saem pela **mesma fila** dos outros disparos, com as pausas de *Ajustes*. Em *Histórico → Tipo → Remetente* cada link aparece com o resultado e o motivo ("Enviada", "Descartada: repetida (enviada há 3 h)", "Não saiu: falta a tag da Amazon", "Descartada: sem dados para montar a oferta"…), mesmo quando não saiu. O Histórico mostra só o **nome** do remetente, nunca o número.

Quem controla o número do remetente consegue mandar links para os seus grupos, até o limite por hora, sempre das quatro lojas e sempre com a sua afiliação. Se desconfiar de um número, desligue o remetente ou exclua-o.

### Privacidade e segurança do remetente

- **O número do remetente fica só no seu computador (e na cópia criptografada do backup), entra no backup e é apagado ao excluir o remetente** (o Histórico fica com o nome). Os backups que você já fez continuam com o número até saírem da rotação (7 no computador; 14 no Google Drive, que depois ficam até 30 dias na lixeira do Drive). Está na tabela `remetentes` de `data/disparador.db`; a API do painel mostra só o número mascarado e nunca o identificador interno do WhatsApp. Nunca vai para log, console nem mensagem de erro.
- **O texto da mensagem não é guardado.** Ficam só os campos lidos dele (título, preço, cupom…), com e-mails, telefones e sequências de 8 ou mais dígitos já escondidos, só quando a mensagem tem um link só e só até o link ser decidido. Links do Mercado Livre e links curtos são guardados sem os parâmetros. Os itens já decididos são apagados no prazo de *Ajustes → Privacidade dos grupos*, e o que ainda conta para "não repetir" é mantido pelas horas definidas.
- Só mensagens **privadas** de números cadastrados e ligados são tratadas. Grupos, status, canais, mensagens da própria conta e qualquer outro número não geram item, resposta nem linha de log.

## Relatórios e avisos

Em *Comunicação → Relatórios e avisos* você cadastra os **números que recebem** o resumo diário e os avisos, direto no WhatsApp:

- **Números de destino**: para cada número, escolha se recebe o **resumo diário**, quais **blocos** entram nele (todos os grupos ou só alguns blocos) e quais **avisos** quer. A lista mostra o número mascarado. O programa confere no WhatsApp se o número existe (no máximo **10 cadastros a cada 10 minutos**) e o **nome** do destino não pode conter telefone (6 dígitos ou mais).
- **Resumo diário**: sai uma vez por dia, no **horário do resumo** (padrão 21:00), com os números do dia, para todos os grupos ou por bloco: grupos e membros, quantos entraram, quantos saíram, a % de quem entrou e saiu no mesmo dia, quantas pessoas abriram as suas mensagens e os cliques nos links do rotacionador. Se o programa estava desligado no horário, o resumo sai atrasado, desde que ainda seja o mesmo dia. Há **prévia** e **Enviar resumo agora** para testar.
- **Virada do dia**: define a hora em que o dia "começa" para a Visão Geral, o resumo e os blocos (padrão 00:00, como antes). Com virada às 02:00, uma entrada às 01:30 conta no dia anterior, e as leituras também passam a ser contadas por esse "dia de negócio". Não use o mesmo horário para o resumo e para a virada: o resumo sairia com o dia zerado.
- **Limite padrão por grupo**: só preenche o limite de cada link **novo** do rotacionador (padrão 1000; vale de 2 a 1.024, o máximo do WhatsApp). Links que já existem não mudam: o aviso de lotação usa o limite de cada link.
- **Aviso de grupo lotando**: quando um grupo do rotacionador chega a 95% do limite. Avisa uma vez por grupo e só avisa de novo depois que ele cair abaixo de 90% do limite.
- **Aviso de erro de disparo**: mensagem **agregada** com os erros novos, **no máximo 1 a cada 30 minutos**. Só sai com o WhatsApp conectado: se ele caiu, o aviso chega quando voltar.
- **Aviso de backup atrasado**: usa o mesmo canal do *Erro de disparo* (os números com esse aviso marcado). Sai quando o último backup que deu certo, no computador ou no Google Drive, tem mais de 26 h; no máximo 1 a cada 24 h. Veja [Backup](#backup).
- **Enviar teste** (só o Dono): na linha de cada número, manda uma mensagem marcada como teste do aviso de erro ("Se esta mensagem chegou, o WhatsApp consegue entregar os avisos a este número. Nada falhou de verdade."), para você conferir sem esperar uma falha. Vale com o número desligado ou sem *Erro de disparo* marcado (o painel avisa os dois casos) e precisa do WhatsApp conectado. Cada teste deixa uma linha no Histórico, com *Avisos* na coluna *Origem* e o **nome** do número (nunca o número).
- **Mensagens manuais**: *Enviar teste* e *Enviar resumo agora* saem na hora pelo seu número; para ele não parecer um robô, os dois somados vão no máximo **1 mensagem manual por número a cada 60 s, 1 resumo para todos os números a cada 60 s e 5 envios manuais por hora (cada teste ou resumo conta 1, mesmo o resumo para todos)**, contados na memória do programa (reiniciar zera). Assim o *Enviar resumo agora* do topo funciona com quantos números você tiver. O resumo para todos confere cada número antes de enviar: se um deles recebeu um teste ou resumo há menos de 60 s, nada sai. Passou do limite, a resposta é 429 com os segundos que faltam. O resumo diário do horário não entra nesses limites.
- **Quem pode o quê**: só o Dono cadastra, remove, troca o número, tira *Erro de disparo* de um número e desliga um número que recebe *Erro de disparo* (o servidor responde 403 ao Operador; desligado, ele não recebe os avisos de erro nem o de backup atrasado). O Operador liga qualquer número, desliga os que não recebem *Erro de disparo*, muda o nome e os blocos do resumo e usa *Enviar resumo agora*.

## Conexões

Em *Conta → Conexões* ficam os cartões das lojas:

- **Mercado Livre**: etiquetas e a extensão do Chrome (que antes ficavam em *Etiquetas* e *Ajustes*). O cartão diz o que falta para o disparo funcionar: um selo (*Conectado*, *Falta configurar*, *Extensão desconectada*, *Central sem resposta* ou *Extensão desatualizada*) e duas linhas, uma da **extensão do Chrome** (conectada, e há quanto tempo falou com o painel) e outra da **Central de Afiliados** (respondendo, ou sem resposta, desde quando, quando será o próximo teste e o último erro). A faixa do topo mostra as duas em pílulas separadas, com “Mercado Livre em espera: Central sem resposta há 25 min” quando a Central para. *Extensão desatualizada* é a extensão conectada com versão abaixo da 1.6.0; ela continua funcionando. Atualize a pasta `extension` do programa, abra `chrome://extensions` e clique em recarregar (a seta circular) na extensão achadinhoturbo. Até lá, o painel mostra “Extensão desatualizada”.
- **Amazon**: tag de associado, ID e segredo da credencial da API e versão da credencial, com o botão **Testar**. O selo do cartão diz em que ponto está: *Falta configurar* (sem tag), *Só com a tag* (os dados vêm do texto da mensagem), *Credencial salva* (ainda não confirmada) ou *Conectada* (a Amazon aceitou). Passo a passo e requisitos em [Espelhamento da Amazon](#espelhamento-da-amazon).
- **Shopee**: ID de afiliado, AppID e Senha da API (os dois últimos opcionais), com o botão **Testar** e a linha que diz se a extensão do Chrome está conectada. O selo do cartão diz em que ponto está: *Falta configurar* (sem ID de afiliado), *Só com o ID* (os links saem pela extensão; é o ponto normal enquanto a Shopee não libera a API), *Credenciais salvas* (ainda não confirmadas), *Conectada* (a Shopee aceitou), *Sem acesso à API* (a Shopee ainda não liberou a API para a conta) ou *Credencial recusada* (AppID ou Senha recusados, ou conta com restrição). *Sem acesso* e *Credencial recusada* **não impedem o disparo** se a extensão estiver conectada: o link cai para ela. O AppID não pode ser igual ao ID de afiliado (são números diferentes; o painel recusa). **Testar** faz uma consulta real à API e responde com uma frase por resultado (aceita, não configurada, recusada, sem acesso, conta restrita, limite de consultas, Shopee fora do ar); se as credenciais forem aceitas mas faltar o ID de afiliado, avisa. Passo a passo e requisitos em [Disparo manual com um link da Shopee](#disparo-manual-com-um-link-da-shopee).
- **Catálogo do Etiqueta**: endereço do app Etiqueta e **caminho** do arquivo do token (nunca o token), com o botão **Testar** e a lista de categorias. Não é loja: é uma **fonte de ofertas** do *Disparo automático*. Passo a passo, estados e revisão em [Catálogo do Etiqueta](#catálogo-do-etiqueta).
- **Magalu**: só precisa do nome da sua loja de parceiro (Magazine Você), sem senha nem API. O link sai com ele. A Magalu não deixa o programa ler o produto: você preenche título e preço no Disparo manual (foto é opcional, por upload). O programa não confirma se o nome existe: use "Conferir minha loja" no cartão. O selo diz *Falta configurar* (nome não salvo) ou *Configurada* (nome salvo). Passo a passo em [Disparo manual com um link da Magalu](#disparo-manual-com-um-link-da-magalu).
- **Facebook**: mostra **"ainda não implementado"**. Você já pode preencher e salvar os dados, mas nenhum envio usa essa loja ainda.
- **Segredos nunca voltam ao navegador**: depois de salvos, o painel só mostra que o campo está preenchido. Deixar o campo vazio mantém o valor salvo; digitar um valor novo substitui.

## Equipe

Em *Conta → Equipe* o Dono dá acesso ao painel para outras pessoas. Cada uma entra com o próprio e-mail e senha.

- **Papéis:** **Operador** usa as telas do dia a dia, mas não vê *Equipe* nem pode gerar novo token da extensão, desconectar o WhatsApp, apagar dados antigos (*Ajustes*), salvar e testar *Conexões* (nem ver quais segredos estão salvos) ou, em *Relatórios e avisos*, cadastrar, remover e trocar números, tirar *Erro de disparo*, desligar um número que recebe *Erro de disparo* e usar *Enviar teste*. **Dono** faz tudo isso e também convida, remove pessoas e muda papéis. O servidor confere o papel a cada pedido: uma troca vale na hora.
- **Convidar:** informe o e-mail e o papel e clique em *Criar convite*. **Nenhum e-mail é enviado**: copie o link e mande pelo WhatsApp. A pessoa abre o link, escolhe nome e senha e já entra. O link vale **7 dias** e **uma vez só**.
- **O link só aparece completo na hora em que é criado.** Depois, *Copiar link* na lista gera um link **novo** e o anterior deixa de funcionar (o painel guarda só uma impressão do link, não o link). *Cancelar* invalida o convite. Link inválido, vencido, usado ou cancelado mostra sempre a mesma mensagem: "Este convite não vale mais".
- **Proteções:** ninguém muda o próprio papel nem remove a si mesmo, e a equipe sempre fica com ao menos um Dono. Remover alguém encerra as sessões dessa pessoa na hora.
- Convites usados, cancelados ou vencidos há mais de 30 dias são apagados quando a tela *Equipe* é aberta. O *Histórico* registra entradas, trocas de papel e remoções pelo **nome** da pessoa, nunca pelo e-mail.

## Extensão do Chrome

1. No Chrome, abra `chrome://extensions`, ligue o **Modo do desenvolvedor** e clique em **Carregar sem compactação**. Escolha a pasta `extension`.
2. Clique no ícone da extensão e cole o **endereço** e o **token** que aparecem em *Conexões → Mercado Livre* no painel.
3. Entre na sua conta de afiliado do Mercado Livre nesse mesmo Chrome. Para os links da **Shopee**, entre também em `affiliate.shopee.com.br` (veja [Disparo manual com um link da Shopee](#disparo-manual-com-um-link-da-shopee)).

O Chrome precisa ficar aberto enquanto as regras rodam. A extensão abre sozinha uma aba fixada da Central de Afiliados quando precisa; se a sessão vencer, ela recarrega a aba e tenta de novo. Se ainda assim falhar, o *Histórico* mostra "não há sessão de afiliado neste Chrome": basta entrar de novo na conta.

Se a Central de Afiliados (ou o portal da Shopee) parar de responder, a extensão espera até 20 s por chamada (e até 20 s pela aba da Central), recarrega a aba e tenta mais uma vez. Sem resposta, ela desiste do pedido em até 40 s no link do Mercado Livre, 55 s na lista de ofertas e 80 s no link da Shopee (antes dos 45 s, 60 s e 90 s que o painel espera), o *Histórico* mostra "a Central de Afiliados do Mercado Livre não respondeu a tempo" (ou "o portal de afiliados da Shopee não respondeu a tempo") e ela continua atendendo os pedidos seguintes: o próximo começa recarregando a aba. Enquanto a extensão trabalha num pedido, o painel continua a mostrá-la conectada (por até 90 s desde que ela recebeu o pedido). Depois de 3 falhas seguidas o Mercado Livre fica em espera e volta sozinho (veja *Mercado Livre em espera*, na conferência de preço). Só se passar de 1 hora, abra a aba da Central no Chrome e veja se a página carrega e se a sua conta está logada.

A versão **1.3.0** da extensão acrescenta a permissão para `affiliate.shopee.com.br`. Quem já tinha a extensão carregada precisa clicar em **Recarregar** nela em `chrome://extensions`, senão os links da Shopee não saem.

A versão **1.4.1** manda também o **Sub_id da Shopee**. Depois de atualizar a pasta `extension`, **recarregue a extensão em `chrome://extensions`**. Com uma extensão mais antiga, o link da Shopee sai sem Sub_id e a falta aparece na cobertura do *Ganhos*.

A versão **1.4.2** não trava mais quando a Central de Afiliados ou o portal da Shopee param de responder (antes, a extensão podia ficar parada e o painel mostrava "Extensão do Chrome desconectada"). Depois de atualizar a pasta `extension`, **recarregue a extensão em `chrome://extensions`**.

A versão **1.5.0** confere o **preço e o estoque do Mercado Livre** antes de cada envio (veja [Conferência de preço e estoque antes do envio](#conferência-de-preço-e-estoque-antes-do-envio)): a extensão abre a página do produto com a sua sessão do Chrome, sem abrir aba, e devolve só o preço e a disponibilidade. Não pede permissão nova. Depois de atualizar a pasta `extension`, **recarregue a extensão em `chrome://extensions`** e mantenha o Chrome **logado no Mercado Livre**. Até recarregar, a oferta sai (se os dados forem de até 30 min) com `· preço não conferido (a extensão do Chrome precisa ser recarregada)`. Cada produto espera até 15 s na extensão e o programa desiste em 18 s; os pedidos de link e de lista passam na frente dos de produto.

A versão **1.6.0** recupera a Central de Afiliados sozinha: reaproveita a aba que ela mesma abriu (e a recarrega se o Chrome a descartou), nunca navega uma aba do Mercado Livre que você abriu fora de `/afiliados`, devolve o **erro real** (entre aspas, no painel e no *Histórico*) e informa a versão ao painel; o popup mostra a linha da Central e a versão. Atualize a pasta `extension` do programa, abra `chrome://extensions` e clique em recarregar (a seta circular) na extensão achadinhoturbo. Até lá, o painel mostra “Extensão desatualizada”, e o Mercado Livre continua funcionando, só sem as correções novas. A lembrança da aba fica no Chrome: depois de reiniciá-lo pode surgir uma aba fixada a mais, uma vez.

## O que foi testado e o que não foi

Testado (`npm test`, mais de 100 testes; a saída do comando mostra o número atual): disparo manual, mensagens e enquetes (agendamento, repetição, pausar e cancelar, retomada após reinício, atraso máximo), conexões e segredos, avisos e resumo diário, equipe (migração da senha única, login por e-mail, convites, papéis), várias fontes por regra, próximo grupo, visão geral, eventos de grupo, blocos, rotacionador, login, sessão, Host/Origin, token da extensão, cabeçalhos, backup e restauração, várias categorias, template, horário de funcionamento (inclusive virando a noite), envio para vários grupos, etiquetas separadas por regra, não repetir ofertas, filtros de preço e desconto, leitura da lista da Central de Afiliados, fila de pedidos com a extensão, API do painel e proteções. Da Amazon: o ASIN de cada formato de link, o link curto resolvido por redirecionamentos simulados, a API e o texto da origem (com as mensagens de exemplo do dono), o template com trecho opcional, o ouvinte de mensagens dos grupos, o cartão em Conexões e o Disparo manual. Da Shopee: os ids de cada formato de link, o link curto resolvido por redirecionamentos simulados (só em endereços da Shopee), a assinatura e os erros da API, o cliente de rede compartilhado com a Amazon (`test/rede.test.js`), o pedido do link pela extensão e a recusa de link que não é `s.shopee.com.br` (`test/links.test.js`), a extensão (`test/extensao-shopee.test.js`, com o portal simulado: sessão vencida, aba fechada, outra conta), a extensão quando a Central ou o portal não respondem (`test/extensao-travamento.test.js`, com relógio simulado: tempo limite de cada chamada, teto por pedido, recarga da aba, um resultado por pedido e o laço que não trava), a conferência do ID de afiliado pelo endereço longo, os estados do cartão e o Testar em Conexões e o Disparo manual (Identificar, criar, agendar, produto fora do programa, API e extensão fora do ar), com a API e o portal sempre simulados. O espelhamento: receber a mensagem (formatos de texto, anti-laço, só grupos), decidir cada item (repetida, palavra bloqueada, janela e máximo por hora, fila, formato curto, completar, expirar, recuperar após queda), as rotas, a ligação ao agendador e a privacidade, tudo com `fetch` e WhatsApp simulados. Do Catálogo (com um Etiqueta falso, em servidor HTTP local de porta aleatória e token falso em pasta temporária; nenhum teste chama o Etiqueta real nem lê o token real): o cliente e o token (`test/catalogo.test.js`: leitura do arquivo a cada pedido, formato do token, endereço só local, token fora de URL, erro, log e console, 401, 503, rede, resposta fora do contrato, um pedido por vez, páginas de 200, ponto de partida em Novidades, cursor recusado, oferta para candidato por loja, foto por CDN), a fila de revisão e o envio aprovado (`test/catalogo-itens.test.js`: teto de 50, dois "Enviar" ao mesmo tempo geram um envio só, preço suspeito recusado, link por loja, ML em modo direto recusado), as regras ponta a ponta (`test/catalogo-regras.test.js`: Novidades, as outras ordens, revisão, espera por loja indisponível, etiqueta opcional, pré-visualização sem gravar), o cartão em Conexões e as rotas (`test/conexoes.test.js`, `test/servidor.test.js`) e os textos escapados no painel (`test/catalogo-conexoes-painel.test.js`, `test/catalogo-painel.test.js`).

Conferido uma vez contra a Central de Afiliados real (02/11/2026): a lista de produtos e a geração do link `meli.la` com etiqueta. O Mercado Livre pode mudar esses endereços sem aviso; se isso acontecer, o *Histórico* mostra o motivo. **Não testado contra o WhatsApp real**, porque exige a sua conta. **A Amazon também nunca foi testada de verdade**: a Creators API, o token e os encurtadores são sempre simulados nos testes. Quem confirma que a sua conta tem acesso é o botão **Testar** em *Conexões → Amazon*. **A Shopee também nunca foi testada de verdade**: a Open API de Afiliados (sem acesso na conta do dono em 03/11/2026), o "Link personalizado" do portal (endereço interno, sem documentação, que a Shopee pode mudar sem aviso) e a foto vinda do CDN da Shopee são simulados nos testes. O formato dos códigos de erro da API foi tirado da documentação e o parser é tolerante: erro desconhecido vira "a Shopee não respondeu agora". Quem confirma na sua conta é o botão **Testar** em *Conexões → Shopee* (para a API) e um primeiro disparo manual com a extensão conectada (para o link). **O Catálogo foi conferido uma vez contra o Etiqueta real (03/11/2026), só leitura** (conexão, token, categorias); o envio de ofertas dele aos grupos nunca foi feito de verdade, e que a Central de Afiliados gera o `meli.la` a partir da página `produto.mercadolivre.com.br/MLB-<n>` ainda não foi conferido: se falhar, a oferta vai para a revisão como "não consegui gerar o link". Confira com uma oferta antes de ligar uma regra grande. **A conferência do Mercado Livre pela extensão foi provada só com páginas de exemplo e uma leitura manual no Chrome do dono (09/11/2026)**: os testes usam páginas HTML de exemplo (com o formato colhido nessa leitura manual) e uma extensão simulada; o pedido da extensão com a sua sessão nunca rodou contra o Mercado Livre de verdade. Não foi conferido que o Mercado Livre deixa a extensão ler a página sem pedir verificação, nem que a Central de Afiliados manda o anúncio no `metadata.id` (os exemplos dos testes assumem que sim). Depois de recarregar a extensão, confira no *Histórico* a primeira oferta do Mercado Livre. **A Magalu também nunca foi testada de verdade**: o link `magazinevoce.com.br/<sua loja>/…` e a abertura dos links curtos são simulados nos testes, e as páginas da Magalu bloqueiam leitura automática. Não foi conferido que o link montado atribui a comissão à sua loja nem como a Magalu responde aos links curtos: antes de usar nos grupos grandes, mande um produto de teste, clique no link e veja o clique no painel do Parceiro Magalu.

- Na fonte *Lista de links*, se o título e o preço não forem lidos sozinhos, escreva-os na linha: `link | título | preço | preço antigo | cupom`.
- A *Busca por palavra-chave* é experimental: a API pública do Mercado Livre pode recusar o acesso sem login.

## Privacidade (LGPD)

- Quem entra, sai ou lê mensagens nos grupos é guardado com um **pseudônimo** (HMAC-SHA256 do número com uma chave local que fica só no banco), nunca com o número. O painel mostra só os primeiros caracteres do pseudônimo.
- **Números de telefone e e-mails em `data/`:** além do pseudônimo dos membros, o banco guarda os **números de WhatsApp que você cadastra para receber avisos** (tabela `aviso_destinos`) e os **nomes e e-mails da equipe e dos convidados** (tabelas `users` e `invites`). A API mostra o número mascarado; o programa não escreve número nem e-mail no log nem em mensagem de erro. **Os backups carregam tudo isso**: trate-os como dado pessoal.
- **Convites:** o banco guarda só uma impressão (hash) do link, nunca o link. Convites usados, cancelados ou vencidos são apagados 30 dias depois, na próxima vez que a tela *Equipe* abre. Para apagar os dados de alguém da equipe, remova a pessoa em *Equipe* (o e-mail ainda fica no convite que ela usou até essa limpeza).
- **Espelhamento da Amazon**: o programa ouve os grupos de origem, mas entrega ao espelhamento só `{ grupo, se foi do seu número, texto, id da mensagem, hora }`: **nunca o número, o identificador nem o nome de exibição de quem postou**. Só os links da Amazon são tratados; o resto da conversa é descartado. Na tabela `espelho_itens` ficam o JID e o **nome do grupo** de origem, o id da mensagem (só para não processar duas vezes) e o **texto da mensagem**, guardado **mascarado** (e-mails, telefones e qualquer sequência de 8 ou mais dígitos viram `…`) e cortado em **1000 caracteres**. Esse texto **não vai para o navegador** (nem na fila de completar) e **não entra no log**, que usa só nomes de grupo. Para a Amazon vão o link postado (para abrir o encurtador), o código do produto e a sua tag, nunca o texto da mensagem, o grupo ou quem postou. **Os backups carregam esses textos de grupos de terceiros**: mesmo mascarados, trate o pacote como dado pessoal. **Retenção:** os itens já decididos (enviados, descartados, expirados, com erro) são apagados depois do prazo de *Ajustes → Privacidade dos grupos* (padrão 90 dias; **0 = guardar para sempre**, e então os textos também ficam), na limpeza que roda ao iniciar e a cada 6 h. Ficam de fora dessa limpeza o que ainda está na fila de decisão ou na fila para completar (esta expira sozinha, veja [Fila para completar](#fila-para-completar)) e o item enviado que ainda conta para o "não repetir" do espelhamento. **Apagar um espelhamento apaga na hora todos os itens e textos dele.** O botão *Apagar o que já passou do prazo* de *Ajustes* aplica a mesma regra na hora, inclusive aos itens do espelhamento.
- **Backups** (`data/backups/` e a cópia no Google Drive): carregam o banco e a sessão do WhatsApp, ou seja, **tudo o que está acima**. Os de `data/backups/` ficam sem criptografia no seu disco (os 7 mais recentes); os do Drive sobem **criptografados** (AES256) com uma chave que só existe no seu computador e no seu gerenciador de senhas (as 14 cópias mais recentes). O Google não consegue abri-los, e você também não, se perder a chave. As cópias que saem da rotação vão para a lixeira do Drive, onde o Google as mantém por até 30 dias, e **excluir alguém do programa só tira essa pessoa das cópias depois que elas saem da rotação e da lixeira do Drive**. O estado do backup (`data/backup-estado.json`) não tem dado pessoal. Veja [Backup](#backup).
- **Remetente**: o número de cada remetente (e o identificador interno que o WhatsApp usa para ele) fica só na tabela `remetentes` do banco, **entra no backup** e é **apagado ao excluir o remetente** (os backups já feitos continuam com ele até saírem da rotação (7 no computador; 14 no Google Drive, que depois ficam até 30 dias na lixeira do Drive)); a API mostra só o número mascarado, e nem log, console nem mensagem de erro o levam. O **texto da mensagem não é guardado**: só os campos lidos dele, já mascarados. Veja [Privacidade e segurança do remetente](#privacidade-e-segurança-do-remetente).
- **Catálogo do Etiqueta**: o token fica num arquivo seu; o programa guarda só o caminho, lê o arquivo a cada pedido e nunca o põe em banco, log, URL, mensagem de erro ou tela. Ficam no banco as ofertas já tratadas (título, preço, foto, categoria e link), sem dado pessoal; veja [Privacidade e segurança](#privacidade-e-segurança) do Catálogo.
- **Fotos enviadas:** as fotos de *Disparar mensagem* ficam em `data/uploads/` e são apagadas **7 dias depois** de não terem mais nenhum envio ativo (agendado ou repetido) que as use.
- **Retenção:** eventos, leituras e cliques são apagados depois do prazo de *Ajustes → Privacidade dos grupos* (padrão 90 dias; a limpeza roda ao iniciar e a cada 6 h). Sessões vencidas também.
- **Histórico do rastreio por grupo** (`rastreio_envios`): só grupo, link, loja e código, sem dado de pessoa. Prazo próprio de 400 dias, que vale mesmo com a retenção de *Ajustes* em 0 ou menor; vai nos backups junto com o banco. Veja [Rastreio por grupo e página Ganhos](#rastreio-por-grupo-e-página-ganhos).
- **Comissões e cliques importados** (`comissoes`, `cliques_loja`, `importacoes`, `gastos_anuncio`): só data, código de rastreio, produto, título, quantidade, valor, comissão e status por linha; nenhum dado de comprador (nome, endereço, telefone, e-mail, documento) é lido ou guardado, e o pedido só existe como um código embaralhado com a chave do programa (não dá para voltar ao número). O arquivo CSV não vai ao disco (de `importacoes` fica só o resumo e o sha256). Ficam até o dono apagar a importação em *Ganhos* e vão nos backups junto com o banco. Veja [Rastreio por grupo e página Ganhos](#rastreio-por-grupo-e-página-ganhos).
- **Exclusão por titular:** `POST /api/privacidade/apagar-participante` com `{ "id": "5511999999999" }` apaga tudo daquela pessoa.
- Ao desconectar o WhatsApp, o painel oferece apagar o histórico dos grupos.
- Avise os membros dos grupos (na descrição, por exemplo) que entradas, saídas e leituras são contadas para medir o alcance.
- Cliques no rotacionador: o IP só é usado em memória para contar um clique por hora; não vai para o banco.
- **Token da extensão:** em *Conexões → Mercado Livre → Gerar novo token* se suspeitar de vazamento. A extensão só aceita `https://` fora do seu computador e o servidor só aceita links `meli.la` vindos dela.

## Cuidados

- A conexão com o WhatsApp é **não oficial**. Há risco de o número ser restringido. Mantenha a proteção do número em *Ajustes* (limite de 40 mensagens por hora, horário de silêncio das 23:00 às 07:00 e pausas, com padrão de 6 s entre grupos e 30 s entre ofertas e mínimo de 2 s e de 5 s: veja [Proteção do número](#proteção-do-número-anti-banimento)) e evite volume alto.
- A pasta `data` guarda a sessão do seu WhatsApp, números de telefone dos avisos, e-mails da equipe, fotos enviadas e segredos das conexões. Não compartilhe nem envie sem criptografia (a cópia do backup no Google Drive só sobe criptografada).
- O programa só ouve em `127.0.0.1`. Num servidor, quem expõe é o Nginx com HTTPS, e o painel exige login.
