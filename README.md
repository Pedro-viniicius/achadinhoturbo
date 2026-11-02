# achadinhoturbo

Programa **pessoal** que roda no seu computador e envia ofertas da sua **Central de Afiliados** do Mercado Livre para os seus grupos de WhatsApp, com link `meli.la` e **várias etiquetas** (cada regra usa a sua).

Você configura: grupos, template, quantas ofertas por envio, intervalo, horário de funcionamento e quanto tempo sem repetir a mesma oferta.

## Como funciona

```
Painel (localhost:3737) ── regras, etiquetas, templates, grupos
        │
   Agendador ──► pede a lista de ofertas e o link meli.la ──► Extensão do Chrome (aba da Central de Afiliados, já logada)
        │
        └──────► WhatsApp Business (aparelho conectado, via QR) ──► grupos
```

Nenhum cookie do Mercado Livre sai do seu Chrome: a extensão devolve só a lista de produtos e o link pronto.

## Instalar

1. Instale o **Node.js 22.13 ou mais novo** (versão LTS em nodejs.org).
2. Windows: dê dois cliques em `iniciar.bat`. Outros sistemas: `npm install` e depois `npm start`.
3. Abra http://localhost:3737

Quer só olhar o painel sem conectar nada? Rode `npm run simular`. Nesse modo nada é enviado de verdade.

### Senha do painel

Em casa, só no `localhost`, o painel abre sem senha (aparece um aviso no terminal). Para proteger, defina `PANEL_PASSWORD` no primeiro start ou rode `npm run senha`. A senha vira um hash no banco; a sessão fica num cookie `httpOnly` por 30 dias e sobrevive a reinícios. Cinco senhas erradas bloqueiam o IP por 15 minutos. Para trocar a senha (e encerrar todas as sessões): `npm run senha`.

### Publicar num servidor (VPS)

Variáveis de ambiente: `PUBLIC_HOST` (ex.: `disparador.meudominio.com`; exigido para aceitar o domínio e a origem `https://`), `PORT` (padrão 3737), `DATA_DIR` (pasta dos dados), `TZ` (ex.: `America/Sao_Paulo`; o horário de funcionamento das regras usa a hora local) e `PANEL_PASSWORD`. Com `PUBLIC_HOST` definido, o programa se recusa a subir sem senha. Ele continua ouvindo só em `127.0.0.1`: coloque um Nginx com HTTPS na frente. No `/api/ext/poll` (long-poll de 20 s) use `proxy_buffering off` e `proxy_read_timeout 60s`; no `/api/ext/result` aceite corpos de até 8 MB. Encerra limpo com SIGTERM.

### Backup

`npm run backup [pasta]` copia o banco com `VACUUM INTO` (seguro com o programa rodando) e a sessão do WhatsApp num `.tar.gz`, mantendo os 7 mais recentes. Para conferir um backup: `npm run backup -- restaurar arquivo.tar.gz pasta-vazia` (extrai e roda `PRAGMA integrity_check`). **O pacote contém a sessão do seu WhatsApp**: trate como senha.

## Visão Geral, blocos e rotacionador

- **Visão Geral**: funil do período (cliques nos links → entradas pelo link ou adicionados → saídas), saldo, tempo médio no grupo, quem abriu o grupo (leu alguma mensagem sua), gráfico de entradas e saídas por hora ou por dia, evasão (quem entrou e saiu no mesmo dia, em 7 dias, ontem e total), tabela por grupo e eventos. Tudo vem do que o WhatsApp informa enquanto o programa está conectado: antes disso não há histórico.
- **Blocos de análise**: agrupe grupos por nicho (com uma etiqueta do Mercado Livre opcional). A Visão Geral filtra por bloco, e ao criar uma regra você pode marcar um bloco inteiro.
- **Rotacionador de Links**: `/g/<nome>` leva para o primeiro grupo da lista com vaga (modos: encher um por vez, alternar entre até 3, encher e reabrir ao esvaziar), com limite por grupo, URL reserva e contagem de cliques. Só grupos com convite entram: em *WhatsApp e grupos*, use *Buscar convite* (precisa ser admin) ou cole o link. **No seu computador o endereço só abre para você**; para o público, o programa precisa estar publicado na internet.
- **Próximo grupo (com confirmação)**: ligando a opção no link, quando um grupo chega a 95% do limite o painel propõe um grupo novo igual (nome com o número seguinte, descrição, foto, permissões e admins). Nada é criado até você clicar em *Criar agora*. O grupo novo entra no link logo depois do que lotou, nos mesmos blocos e nas mesmas regras. Criar grupos é a ação que mais chama a atenção do WhatsApp: evite criar vários no mesmo dia.

## Primeiros passos

1. **Etiquetas**: cadastre os nomes das suas etiquetas, escritos como no programa de afiliados.
2. **WhatsApp e grupos**: clique em *Conectar WhatsApp* e leia o QR no WhatsApp Business (Aparelhos conectados).
3. **Templates**: ajuste a mensagem. Linha com campo vazio some sozinha. `{TITULO_PRODUTO}` sai **abreviado** (só o que identifica o produto: tira "Compatível com…", "Premium", "Alta Qualidade" e corta em até 60 caracteres sem partir palavra; o tamanho muda em *Ajustes*, 0 desliga). `{TITULO_COMPLETO}` é o nome inteiro.
4. **Extensão** (abaixo). Sem ela, nem a lista de ofertas nem o link de afiliado são gerados.
5. **Regras**: crie uma regra escolhendo etiqueta, template, grupos e ritmo. A fonte padrão é a **Central de Afiliados**: a lista "Produtos selecionados para você", com busca, **uma ou várias categorias** (com várias, as ofertas saem intercaladas, bom para grupos de achadinhos gerais), ordem, "só mais vendidos" e "só com ganhos extras". Uma regra aceita **até 5 fontes** (Central com filtros diferentes, listas de links, buscas, misturadas): as ofertas saem intercaladas, uma de cada fonte por vez, e uma fonte que falhar vira aviso sem travar as outras. A etiqueta é uma por regra: para etiquetas diferentes no mesmo grupo, crie outra regra apontando para o mesmo grupo. Use *Ver ofertas* para conferir antes e *Enviar agora* para testar.

## Extensão do Chrome

1. No Chrome, abra `chrome://extensions`, ligue o **Modo do desenvolvedor** e clique em **Carregar sem compactação**. Escolha a pasta `extension`.
2. Clique no ícone da extensão e cole o **endereço** e o **token** que aparecem em *Ajustes* no painel.
3. Entre na sua conta de afiliado do Mercado Livre nesse mesmo Chrome.

O Chrome precisa ficar aberto enquanto as regras rodam. A extensão abre sozinha uma aba fixada da Central de Afiliados quando precisa; se a sessão vencer, ela recarrega a aba e tenta de novo. Se ainda assim falhar, o *Histórico* mostra "não há sessão de afiliado neste Chrome": basta entrar de novo na conta.

## O que foi testado e o que não foi

Testado (`npm test`, 36 testes): várias fontes por regra, próximo grupo, visão geral, eventos de grupo, blocos, rotacionador, login, sessão, Host/Origin, token da extensão, cabeçalhos, backup e restauração, várias categorias, template, horário de funcionamento (inclusive virando a noite), envio para vários grupos, etiquetas separadas por regra, não repetir ofertas, filtros de preço e desconto, leitura da lista da Central de Afiliados, fila de pedidos com a extensão, API do painel e proteções.

Conferido uma vez contra a Central de Afiliados real (02/11/2026): a lista de produtos e a geração do link `meli.la` com etiqueta. O Mercado Livre pode mudar esses endereços sem aviso; se isso acontecer, o *Histórico* mostra o motivo. **Não testado contra o WhatsApp real**, porque exige a sua conta.

- Na fonte *Lista de links*, se o título e o preço não forem lidos sozinhos, escreva-os na linha: `link | título | preço | preço antigo | cupom`.
- A *Busca por palavra-chave* é experimental: a API pública do Mercado Livre pode recusar o acesso sem login.

## Cuidados

- A conexão com o WhatsApp é **não oficial**. Há risco de o número ser restringido. Mantenha as pausas em *Ajustes* e evite volume alto.
- A pasta `data` guarda a sessão do seu WhatsApp. Não compartilhe nem envie para a nuvem.
- O programa só ouve em `127.0.0.1`. Num servidor, quem expõe é o Nginx com HTTPS, e o painel exige senha.
