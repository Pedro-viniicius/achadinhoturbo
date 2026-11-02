# achadinhoturbo

Programa **pessoal** que roda no seu computador e envia ofertas da sua **Central de Afiliados** do Mercado Livre para os seus grupos de WhatsApp, com link `meli.la` e **várias etiquetas** (cada regra usa a sua).

Além das regras automáticas, o painel faz **disparo manual** de uma oferta, **mensagens e enquetes** (agora, agendadas ou repetidas) e manda **resumo diário e avisos** para o seu WhatsApp.

Você configura: grupos, template, quantas ofertas por envio, intervalo, horário de funcionamento e quanto tempo sem repetir a mesma oferta.

## Como funciona

```
Painel (localhost:3737) ── disparos, conexões, templates, grupos, avisos
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

**Nginx:** além do proxy, defina `proxy_set_header X-Forwarded-For $remote_addr;` e `proxy_set_header X-Forwarded-Proto $scheme;` (o programa confia nesses cabeçalhos para o limite de tentativas de login e para o HSTS; sem reescrevê-los, um cliente pode falsificá-los) e `server_name` só com o seu domínio. Variáveis de ambiente: `PUBLIC_HOST` (ex.: `disparador.meudominio.com`; exigido para aceitar o domínio e a origem `https://`), `PORT` (padrão 3737), `DATA_DIR` (pasta dos dados), `TZ` (ex.: `America/Sao_Paulo`; o horário de funcionamento das regras usa a hora local) e `PANEL_PASSWORD`. Com `PUBLIC_HOST` definido, o programa se recusa a subir sem senha. Ele continua ouvindo só em `127.0.0.1`: coloque um Nginx com HTTPS na frente. No `/api/ext/poll` (long-poll de 20 s) use `proxy_buffering off` e `proxy_read_timeout 60s`; no `/api/ext/result` aceite corpos de até 8 MB. Encerra limpo com SIGTERM.

### Backup

`npm run backup [pasta]` copia o banco com `VACUUM INTO` (seguro com o programa rodando) e a sessão do WhatsApp num `.tar.gz`, mantendo os 7 mais recentes. O destino padrão é `data/backups/`, que o `.gitignore` já exclui; se você apontar para dentro de um repositório git não ignorado, o script avisa. **Nunca faça commit de um backup.** Para conferir um backup: `npm run backup -- restaurar arquivo.tar.gz pasta-vazia` (extrai e roda `PRAGMA integrity_check`). **O pacote contém a sessão do seu WhatsApp**: trate como senha.

## Menu do painel

O menu lateral é dividido em grupos:

- **Visão Geral**
- **Principal**: Rotacionador de Links, Grupos, Blocos de análise
- **Disparos**: Disparo manual, Disparo automático (antes chamado *Regras*), Disparar mensagem, Templates
- **Comunicação**: Relatórios e avisos
- **Conta**: Conexões, Números de WhatsApp, Equipe (**em breve**)
- No rodapé: Histórico, Ajustes, Ajuda

Os endereços antigos continuam funcionando: `#regras` abre *Disparo automático*, `#whatsapp` abre *Números de WhatsApp* e `#etiquetas` abre *Conexões* (na seção do Mercado Livre).

## Visão Geral, blocos e rotacionador

- **Visão Geral**: funil do período (cliques nos links → entradas pelo link ou adicionados → saídas), saldo, tempo médio no grupo, quem abriu o grupo (leu alguma mensagem sua), gráfico de entradas e saídas por hora ou por dia, evasão (quem entrou e saiu no mesmo dia, em 7 dias, ontem e total), tabela por grupo e eventos. Tudo vem do que o WhatsApp informa enquanto o programa está conectado: antes disso não há histórico.
- **Blocos de análise**: agrupe grupos por nicho (com uma etiqueta do Mercado Livre opcional). A Visão Geral filtra por bloco, e ao criar uma regra de disparo automático você pode marcar um bloco inteiro.
- **Rotacionador de Links**: `/g/<nome>` leva para o primeiro grupo da lista com vaga (modos: encher um por vez, alternar entre até 3, encher e reabrir ao esvaziar), com limite por grupo, URL reserva e contagem de cliques. Só grupos com convite entram: em *Grupos*, use *Buscar convite* (precisa ser admin) ou cole o link. **No seu computador o endereço só abre para você**; para o público, o programa precisa estar publicado na internet.
- **Próximo grupo (com confirmação)**: ligando a opção no link, quando um grupo chega a 95% do limite o painel propõe um grupo novo igual (nome com o número seguinte, descrição, foto, permissões e admins). Nada é criado até você clicar em *Criar agora*. O grupo novo entra no link logo depois do que lotou, nos mesmos blocos e nas mesmas regras. Criar grupos é a ação que mais chama a atenção do WhatsApp: evite criar vários no mesmo dia.

## Primeiros passos

1. **Conexões → Mercado Livre**: cadastre os nomes das suas etiquetas, escritos como no programa de afiliados.
2. **Números de WhatsApp** e **Grupos**: clique em *Conectar WhatsApp* e leia o QR no WhatsApp Business (Aparelhos conectados).
3. **Templates**: ajuste a mensagem. Linha com campo vazio some sozinha. `{TITULO_PRODUTO}` sai **abreviado** (só o que identifica o produto: tira "Compatível com…", "Premium", "Alta Qualidade" e corta em até 60 caracteres sem partir palavra; o tamanho muda em *Ajustes*, 0 desliga). `{TITULO_COMPLETO}` é o nome inteiro.
4. **Extensão** (abaixo). Sem ela, nem a lista de ofertas nem o link de afiliado são gerados.
5. **Disparo automático**: crie uma regra escolhendo etiqueta, template, grupos e ritmo. A fonte padrão é a **Central de Afiliados**: a lista "Produtos selecionados para você", com busca, **uma ou várias categorias** (com várias, as ofertas saem intercaladas, bom para grupos de achadinhos gerais), ordem, "só mais vendidos" e "só com ganhos extras". Uma regra aceita **até 5 fontes** (Central com filtros diferentes, listas de links, buscas, misturadas): as ofertas saem intercaladas, uma de cada fonte por vez, e uma fonte que falhar vira aviso sem travar as outras. A etiqueta é uma por regra: para etiquetas diferentes no mesmo grupo, crie outra regra apontando para o mesmo grupo. Use *Ver ofertas* para conferir antes e *Enviar agora* para testar.

## Disparo manual

Em *Disparos → Disparo manual* você manda uma oferta específica sem criar regra:

1. Cole o link do produto e clique em **Identificar**. O programa reconhece a loja, lê o produto e monta a mensagem com o template escolhido.
2. Escolha o **template**, a **etiqueta** (do Mercado Livre) e os grupos.
3. Envie **agora** ou **agende para hoje** (só o mesmo dia; para repetir, use *Disparar mensagem*).
4. O histórico mostra o que foi enviado, está na fila ou deu erro (últimos 30 dias nos contadores).

**Hoje só o Mercado Livre envia.** Se o link for de outra loja (Amazon, Shopee, Magalu, Facebook), o programa reconhece e avisa que a loja **não está conectada** (ainda não implementada), sem enviar nada.

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
- **Amazon, Shopee, Magalu e Facebook**: mostram **"ainda não implementado"**. Você já pode preencher e salvar os dados (tag de associado, AppID e chave, nome da loja de parceiro etc.), mas nenhum envio usa essas lojas ainda.
- **Segredos nunca voltam ao navegador**: depois de salvos, o painel só mostra que o campo está preenchido. Deixar o campo vazio mantém o valor salvo; digitar um valor novo substitui.

## Equipe (em breve)

O item *Equipe* aparece no menu (só para o Dono) e a página mostra **"Em construção"**: convites e papéis para mais pessoas usarem o painel chegam na próxima entrega.

## Extensão do Chrome

1. No Chrome, abra `chrome://extensions`, ligue o **Modo do desenvolvedor** e clique em **Carregar sem compactação**. Escolha a pasta `extension`.
2. Clique no ícone da extensão e cole o **endereço** e o **token** que aparecem em *Conexões → Mercado Livre* no painel.
3. Entre na sua conta de afiliado do Mercado Livre nesse mesmo Chrome.

O Chrome precisa ficar aberto enquanto as regras rodam. A extensão abre sozinha uma aba fixada da Central de Afiliados quando precisa; se a sessão vencer, ela recarrega a aba e tenta de novo. Se ainda assim falhar, o *Histórico* mostra "não há sessão de afiliado neste Chrome": basta entrar de novo na conta.

## O que foi testado e o que não foi

Testado (`npm test`, mais de 100 testes; a saída do comando mostra o número atual): disparo manual, mensagens e enquetes (agendamento, repetição, pausar e cancelar, retomada após reinício, atraso máximo), conexões e segredos, avisos e resumo diário, várias fontes por regra, próximo grupo, visão geral, eventos de grupo, blocos, rotacionador, login, sessão, Host/Origin, token da extensão, cabeçalhos, backup e restauração, várias categorias, template, horário de funcionamento (inclusive virando a noite), envio para vários grupos, etiquetas separadas por regra, não repetir ofertas, filtros de preço e desconto, leitura da lista da Central de Afiliados, fila de pedidos com a extensão, API do painel e proteções.

Conferido uma vez contra a Central de Afiliados real (02/11/2026): a lista de produtos e a geração do link `meli.la` com etiqueta. O Mercado Livre pode mudar esses endereços sem aviso; se isso acontecer, o *Histórico* mostra o motivo. **Não testado contra o WhatsApp real**, porque exige a sua conta.

- Na fonte *Lista de links*, se o título e o preço não forem lidos sozinhos, escreva-os na linha: `link | título | preço | preço antigo | cupom`.
- A *Busca por palavra-chave* é experimental: a API pública do Mercado Livre pode recusar o acesso sem login.

## Privacidade (LGPD)

- Quem entra, sai ou lê mensagens nos grupos é guardado com um **pseudônimo** (HMAC-SHA256 do número com uma chave local que fica só no banco), nunca com o número. O painel mostra só os primeiros caracteres do pseudônimo.
- **Números de telefone em `data/`:** além do pseudônimo dos membros, o banco guarda os **números de WhatsApp que você cadastra para receber avisos** (tabela `aviso_destinos`) e, quando a Equipe chegar, os **e-mails das pessoas convidadas**. A API mostra o número mascarado e o programa não o escreve no log. **Os backups carregam tudo isso**: trate-os como dado pessoal.
- **Fotos enviadas:** as fotos de *Disparar mensagem* ficam em `data/uploads/` e são apagadas **7 dias depois** de não terem mais nenhum envio ativo (agendado ou repetido) que as use.
- **Retenção:** eventos, leituras e cliques são apagados depois do prazo de *Ajustes → Privacidade dos grupos* (padrão 90 dias; a limpeza roda ao iniciar e a cada 6 h). Sessões vencidas também.
- **Exclusão por titular:** `POST /api/privacidade/apagar-participante` com `{ "id": "5511999999999" }` apaga tudo daquela pessoa.
- Ao desconectar o WhatsApp, o painel oferece apagar o histórico dos grupos.
- Avise os membros dos grupos (na descrição, por exemplo) que entradas, saídas e leituras são contadas para medir o alcance.
- Cliques no rotacionador: o IP só é usado em memória para contar um clique por hora; não vai para o banco.
- **Token da extensão:** em *Conexões → Mercado Livre → Gerar novo token* se suspeitar de vazamento. A extensão só aceita `https://` fora do seu computador e o servidor só aceita links `meli.la` vindos dela.

## Cuidados

- A conexão com o WhatsApp é **não oficial**. Há risco de o número ser restringido. Mantenha as pausas em *Ajustes* e evite volume alto.
- A pasta `data` guarda a sessão do seu WhatsApp, números de telefone dos avisos, fotos enviadas e segredos das conexões. Não compartilhe nem envie para a nuvem.
- O programa só ouve em `127.0.0.1`. Num servidor, quem expõe é o Nginx com HTTPS, e o painel exige senha.
