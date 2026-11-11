# Brief: Rodar sozinho (autocura e vigia)

- Data: 2026-11-11
- Origem: revisão do quadro do Trello "Operação corretor Mundial" com o dono, em 11/11/2026. Substitui as metas vencidas "🎯 META 07/11" e "🚀 1ª versão 10/11".
- Pedido do dono: "redesenhar nosso projeto a fim de sabermos onde estamos e para onde queremos ir (...) começando por aquelas [tarefas] que nos possibilitem deixar a ferramenta utilitária, depois pensamos em lançar para o público, por enquanto apenas eu vou usar localmente."
- Decisões do dono nesta conversa: prioridade = **rodar sozinho**; caminho = **autocura mais vigia**, em quatro entregas na ordem abaixo; preço da Amazon **conferido na hora pelo Etiqueta** (releitura da página só do produto escolhido), com as **6 horas** desde a última confirmação valendo como reserva quando a releitura falha.

## Problema

O Turbo está em uso real (4 regras do catálogo, 4 grupos, 30 a 50 ofertas por dia), mas o dono precisa vigiar o painel. O retrato do banco em 11/11/2026:

| Onde | O que acontece | Evidência |
|---|---|---|
| Amazon | Com o verificador ligado, **toda** oferta do catálogo vai para revisão: não há API da Amazon, e o Turbo ignora o `preco_em` que o Etiqueta manda (`lidoEm: null` em `src/scheduler.js:443`). | O dono desligou o verificador 3 vezes em 10/11; 23 itens da Amazon parados na revisão. |
| Mercado Livre | Falha passageira da Central ou da extensão vira revisão permanente (`src/scheduler.js:662-669`, `src/catalogo-itens.js:233`), sem nova tentativa. | Em 10/11 os 11 pedidos à Central falharam; 0 envios do ML no dia. |
| Vaga | A oferta que cai fora na hora do envio não é trocada por outra (`picked` tem tamanho fixo). | Em 10/11 às 9h a regra Black_Operação saiu com 0 de 2, sem linha no Histórico. |
| Avisos | "Separada para revisão" é `aviso`, e só `erro` vira aviso no WhatsApp (`src/avisos.js:377`). O selo da extensão mede o poll, não a Central. | Nenhum aviso de loja parada, extensão fora ou revisão acumulada. |
| Shopee | Toda oferta do catálogo exige aprovação manual (motivo `shopee`). | As 4 regras deixaram de pedir Shopee; nenhum envio desde 06/11. |

O defeito de fundo é um só: quando algo não dá certo, o Turbo **para e espera o dono, sem avisar**.

## O que o dono quer

Ligar o Turbo e deixá-lo trabalhar. Quando uma oferta não pode sair, o sistema tenta de novo ou põe outra no lugar. O dono só é chamado quando existe uma decisão que é dele, ou quando um problema persiste.

**Princípio novo:** a revisão manual fica só para o que pede julgamento humano. Falha técnica passageira nunca vira revisão.

## Objetivos

1. O verificador volta a ficar ligado sem travar a Amazon.
2. Cada regra preenche as vagas do horário sempre que houver oferta válida disponível.
3. Falha passageira do Mercado Livre se resolve sozinha quando a Central volta.
4. Qualquer parada que dure aparece no WhatsApp do dono, uma vez, com o que fazer.
5. A Shopee volta ao disparo automático sem aprovação oferta a oferta.

**Medida de sucesso:** 7 dias seguidos com o verificador ligado, sem o dono abrir a revisão para destravar envio, e com cada regra saindo com pelo menos 90% das vagas nos horários em que o catálogo tinha oferta válida.

## Fora do escopo

- Publicar em servidor, várias contas, perfil, API oficial do WhatsApp (lista "🔭 Depois · lançar ao público" do Trello).
- Ligar a API da Amazon (Creators API). O desenho precisa funcionar sem ela.
- Histórico de preço para a Black Friday (cartão 10) e dados na tela de Ganhos (cartões "3 · PORTAIS"): vêm depois desta meta.
- Mudar o Etiqueta além do ponto único da entrega 1 (a rota que relê o preço de um produto). Automatizar as rodadas de atualização de preço do Etiqueta fica de fora.

## O que seria fracasso mesmo funcionando

- Sair oferta com preço velho ou errado só para preencher a vaga.
- Passar do teto de mensagens por hora ou furar o horário de silêncio para "compensar" vagas perdidas.
- Encher o WhatsApp do dono de avisos repetidos.
- Trocar link de afiliado por link comum em qualquer caminho de nova tentativa.
- Esconder do dono uma oferta que foi pulada: tudo o que não saiu continua explicado no Histórico.

## Restrições

- O serviço do dono roda desta pasta com `node --watch-path=src`: **editar `src/` reinicia o serviço real** (houve cerca de 30 reinícios em 10/11). O trabalho de código acontece numa cópia separada (worktree) e só entra aqui com a suíte verde e o ok do dono, fora dos horários de envio das regras.
- Mudança em `extension/background.js` exige que o dono recarregue a extensão em `chrome://extensions`. Agrupar as mudanças da extensão numa entrega só (a 2).
- Sem dependência nova. O Turbo continua sem raspar HTML da Amazon (ADR-002): quem lê a página é o Etiqueta, que já faz isso. Nenhum teste chama loja, Etiqueta ou WhatsApp reais.
- O Etiqueta é outro projeto (`~/Documentos/saas/etiqueta`, Python só com biblioteca padrão, servidor em `localhost:8765`, com `CLAUDE.md`, equipe e verificação próprios: `python3 verificar.py`). A mudança lá segue as regras de lá, e o dono reinicia o servidor do Etiqueta para ela valer.
- Toda saída do WhatsApp continua passando pelo `ritmo.js`.
- Docs acompanham cada entrega: `README.md`, `TIPS`/`LEIA_MAIS` de `public/ajuda.js`, capítulo do livro, tabela `FATOS` de `test/docs.test.js` para número novo, `cap-referencia.js` para motivo ou selo novo.
- Linha de base em 11/11/2026: `npm test` com 2.754 testes, 2.753 passam, 0 falhas, 1 `todo`.

## Abordagens consideradas

| Abordagem | O que é | Troca |
|---|---|---|
| A. Consertar loja por loja | Corrige as três causas conhecidas, sem aviso novo. | Mais curta; a próxima falha silenciosa de outro tipo passa despercebida. |
| B. Só o vigia | Avisos no WhatsApp quando algo para. | Rápida; o sistema continua parando, o dono só fica sabendo antes. |
| **C. Autocura mais vigia** | Falhou: tenta de novo, repõe a vaga e avisa só se persistir. | Mais trabalho; é a única que tira o dono de vigiar o painel. |

**Escolhida pelo dono: C**, em quatro entregas, cada uma útil sozinha.

## Entrega 1 · Amazon conferida na hora, verificador e vaga reposta

**Fato que mudou o desenho (11/11/2026):** o Etiqueta só confirma preços em rodadas manuais do dono (a última da Amazon foi em 09/11, das 4h às 7h) e hoje aceita preço de até 48 h (`config.preco_validade_horas`). Uma regra só de idade do preço deixaria a Amazon parada quase o tempo todo.

**Decidido pelo dono:** logo antes de enviar, o Turbo pede ao Etiqueta para reler a página **só do produto escolhido**, como o botão "Atualizar preço" do Etiqueta já faz (`buscar_produto_amazon` em `servidor.py`). As 6 horas ficam como reserva.

### Parte A · Etiqueta (outro repositório)

- Rota nova na API v1 (a mesma que o Turbo já consome, com o mesmo token): confirma o preço de **uma** oferta da Amazon que já existe no banco. Relê a página, grava o preço pelo caminho que o "Atualizar preço" usa (o servidor carimba `preco_em`) e devolve o resultado.
- Respostas que o Turbo precisa distinguir: preço lido (com o valor e o `preco_em` novo); página sem preço legível ou produto indisponível; página de outro produto (ASIN diferente); bloqueio ou captcha; falha de rede.
- Nunca insere item, nunca troca o link de afiliado, nunca apaga o preço antigo quando a leitura falha (mesmas garantias do `atualizar_precos.py`).
- Freio próprio contra excesso de leituras da Amazon.

### Parte B · Turbo

- O catálogo passa a ler o `preco_em` do Etiqueta e a carregá-lo na oferta.
- **Amazon sem API, na hora do envio:** o verificador pede a confirmação ao Etiqueta.
  - Preço lido: vale a regra que já existe (subiu além do limite de 5%: descarta; senão envia com o preço lido, e `{HORA_PRECO}` mostra a hora da leitura).
  - Sem preço, indisponível ou outro produto: descarta, com o motivo.
  - Bloqueio, captcha, falha de rede ou Etiqueta fora do ar: **reserva das 6 horas**. Com `preco_em` de até 6 h a oferta sai, e `{HORA_PRECO}` mostra o `preco_em`; mais velho, ausente ou inválido, a oferta é **pulada**.
- **Pulada** não vai para revisão e não conta como enviada: pode voltar numa execução seguinte.
- **Vaga reposta:** quando uma oferta escolhida é pulada, descartada ou separada na hora do envio, a regra tenta a próxima candidata até preencher as vagas do horário ou acabar a lista, com um teto de tentativas por execução.
- O Histórico registra sempre que a regra sai com menos ofertas do que pediu ("saíram X de Y").
- Ligar e desligar o verificador ficam os dois registrados no Histórico (hoje só o desligar).
- As ofertas hoje paradas na revisão só por `nao_conferido` saem da fila de revisão.

### Escolhas minhas (o dono pode corrigir)

- **Mercado Livre não sai sem conferência.** A reserva das 6 horas vale só para a Amazon. No ML, conferência que falha por causa passageira (`loja_fora`, `demorou`, `ml_verificacao`, `limite_hora`) pula a oferta e repõe a vaga; na entrega 2 essas falhas passam a contar para o disjuntor. Motivo: o ML tem conferência ao vivo pela extensão, e se ela falha o link também tende a falhar.
- **Preço que não dá para conhecer** (`varias_versoes`, `sem_preco`) pula a oferta com a mesma pausa das descartadas (6 h fora da escolha da regra), em vez de mandar para a revisão.
- O motivo `nao_conferido` deixa de mandar oferta do catálogo para a revisão. Na revisão ficam: `shopee` (até a entrega 4), `desconto_100` e `preco_antigo`.
- Teto de tentativas de reposição: 3 vezes o número de vagas da execução. A leitura da Amazon tem prazo curto para não segurar a execução.
- **Histórico:** oferta que chegou a ser escolhida e caiu fora ganha a sua linha, com o motivo (como hoje). Candidatas filtradas antes da escolha viram **uma** linha por execução, com a contagem.
- **Migração:** só tira da revisão os itens pendentes por `nao_conferido`; não recua cursor nem relê nada. Eles voltam se o catálogo os trouxer de novo.
- `preco_em` é texto ISO na hora local do computador, sem fuso (contrato do Etiqueta, `api-ofertas.md:58`); os dois programas rodam na mesma máquina.

### Critérios de aceite

- CA1.1 — Etiqueta: a rota nova devolve cada um dos cinco resultados acima com páginas simuladas, exige o token da API v1, só aceita oferta da Amazon existente, e carimba `preco_em` só quando o preço é legível.
- CA1.2 — Etiqueta: leitura que falha não altera preço, link nem `preco_em` do item; nenhum teste abre a Amazon de verdade; `python3 verificar.py` verde.
- CA1.3 — Turbo: com o verificador ligado e sem API da Amazon, oferta da Amazon com preço confirmado na hora sai sem passar pela revisão, com o preço lido.
- CA1.4 — Turbo: preço que subiu além do limite, produto indisponível ou outro produto descartam a oferta com o motivo no Histórico.
- CA1.5 — Turbo: com a releitura falhando, `preco_em` de até 6 h envia; acima de 6 h, ausente ou inválido, a oferta é pulada, não vai para revisão e não entra em `sent_offers`.
- CA1.6 — `{HORA_PRECO}` mostra a hora em que o preço foi de fato visto (leitura na hora ou `preco_em`); nunca a hora do envio.
- CA1.7 — Quando uma escolhida cai fora, a regra envia a próxima candidata válida; a execução termina com as vagas preenchidas se houver candidatas, sem passar do teto de tentativas.
- CA1.8 — Regra que sai com menos que o pedido grava uma linha "saíram X de Y" com os motivos.
- CA1.9 — Ligar e desligar o verificador gravam cada um a sua linha no Histórico, com quem fez.
- CA1.10 — Itens pendentes só por `nao_conferido` deixam a revisão na migração; itens com outros motivos ficam onde estão.
- CA1.11 — Nada muda para quem tem a API da Amazon ligada, para o Disparo manual e para o verificador desligado. Mercado Livre nunca sai sem conferência.
- CA1.12 — Reposição de vaga respeita teto por hora, silêncio e pausas do `ritmo.js`, e a regra de "não repetir produto parecido".
- CA1.13 — Docs e `FATOS` atualizados nos dois projetos (o número 6 h aparece no código e nos Docs do Turbo).

## Entrega 2 · Mercado Livre que se recupera

Comportamento:

- Falha **passageira** ao gerar o link ou conferir (prazo estourado, Central sem resposta, "não consegui abrir") não manda a oferta para a revisão: ela é liberada, a vaga é reposta (entrega 1) e a oferta pode ser tentada de novo numa execução seguinte.
- Recusa **definitiva** do próprio Mercado Livre (por exemplo "The article must be active, status: paused") descarta a oferta com o motivo; ninguém consegue consertar isso na revisão.
- A mesma oferta que falha repetidas vezes vai para a revisão com o motivo, para não ficar em laço.
- **Disjuntor:** depois de falhas seguidas da Central, o Turbo trata o Mercado Livre como indisponível: as ofertas do ML **esperam** (como já acontece com a extensão desconectada) em vez de cada uma gastar mais de um minuto e falhar. O Turbo testa de tempos em tempos e volta sozinho.
- "Extensão conectada" passa a distinguir **extensão viva** de **Central respondendo**, no painel e em Conexões.
- O último sucesso e o último erro da Central sobrevivem ao reinício do serviço.
- Extensão: trata aba da Central descartada ou congelada, reaproveita a aba que saiu da página de afiliados em vez de abrir uma aba fixada nova a cada pedido, e devolve o erro real do Chrome em vez de uma frase genérica.
- Correção: "Enviar" manual da revisão que falha em todos os grupos não deixa o item como `enviado`.

Propostas minhas:

- Limites: 3 falhas seguidas abrem o disjuntor; novo teste a cada 5 minutos; a mesma oferta vai para a revisão na 3ª falha em execuções diferentes.
- As falhas passageiras de conferência do ML (entrega 1) contam para o disjuntor e para a 3ª falha da oferta.
- Os itens hoje parados na revisão por `falha_link` saem da fila na migração desta entrega, como os `nao_conferido` na entrega 1.
- A versão da extensão sobe, e o painel avisa quando a extensão conectada é mais antiga que a esperada.

Critérios de aceite:

- CA2.1 — Falha passageira de link ou de conferência do ML não cria item em revisão; a vaga é reposta.
- CA2.2 — Recusa definitiva do ML descarta a oferta com o motivo no Histórico.
- CA2.3 — A 3ª falha da mesma oferta, em execuções diferentes, leva-a à revisão com o motivo.
- CA2.4 — Com o disjuntor aberto, ofertas do ML esperam sem pedido à extensão; ao voltar a Central, saem na execução seguinte sem ação do dono.
- CA2.5 — Painel e Conexões mostram separadamente "extensão conectada" e "Central respondendo", com há quanto tempo.
- CA2.6 — Último sucesso e último erro da Central persistem entre reinícios.
- CA2.7 — Extensão: aba descartada é recuperada; aba fora da página de afiliados é reaproveitada; o erro original chega ao painel. Sem aba fixada nova a cada pedido.
- CA2.8 — Item cujo "Enviar" manual falhou em todos os grupos não fica `enviado`.
- CA2.9 — Em nenhum caminho de nova tentativa sai link sem afiliação.
- CA2.10 — Docs atualizados, com o passo de recarregar a extensão.

## Entrega 3 · Vigia

Comportamento: avisos no WhatsApp do dono (mesmos destinos que hoje recebem "erro"), cada um dizendo o que parou, desde quando e o que fazer.

- **Loja parada:** uma loja pedida por regra ativa ficou sem nenhum envio por um período, dentro dos horários de envio, havendo tentativas.
- **Extensão ou Central fora** por mais que um tempo, dentro dos horários de envio.
- **Revisão acumulada** acima de um número de ofertas.
- **Regra vazia:** a regra saiu com 0 ofertas em horários seguidos.
- Um aviso por causa, com freio; e um "voltou ao normal" quando a causa some.
- O resumo diário ganha uma linha de saúde: envios por loja, puladas, falhas e pendentes na revisão.
- A faixa do topo do painel mostra a causa em aberto com há quanto tempo (spec do `designer`).

Propostas minhas:

- **Conta por horário de envio, não por relógio.** As regras com grade têm horários a horas um do outro; "3 horas" de relógio daria alarme falso ou atraso.
- **Loja parada** = 3 execuções seguidas de regras que pedem aquela loja em que alguma oferta dela caiu fora (pulada, falhada ou esperando) e nenhuma saiu. Execução sem candidata daquela loja não conta: falta de novidade não é defeito.
- **Regra vazia** = 2 execuções seguidas da mesma regra com 0 envios **e** alguma oferta que caiu fora.
- **Extensão ou Central fora** = 30 minutos, contados só dentro da janela de envio de alguma regra ativa.
- **Revisão acumulada** = 10 ofertas pendentes no total.
- "Loja pedida" vem da lista de lojas da regra; lista vazia vale Amazon e Mercado Livre. A Shopee só entra depois da entrega 4.
- Freio = 1 aviso por causa a cada 3 horas. Nada sai no horário de silêncio; o que acumulou sai de uma vez ao fim dele.
- A entrega 1 já grava, por execução e por loja, quantas saíram, foram puladas, descartadas e esperaram, para o vigia ler depois.

Critérios de aceite:

- CA3.1 — Cada uma das quatro causas gera o aviso certo com dados simulados, e não gera fora dos horários de envio das regras.
- CA3.2 — O freio segura a repetição; a volta ao normal gera um aviso só.
- CA3.3 — O resumo diário traz a linha de saúde com os números do dia.
- CA3.4 — O painel mostra a causa em aberto e há quanto tempo.
- CA3.5 — Avisos nunca levam número de telefone, e-mail ou segredo; passam pelo `ritmo.js`.
- CA3.6 — Docs, `TIPS` e `FATOS` atualizados (os limites são números que aparecem nos dois).

## Entrega 4 · Shopee automática

Depende do teste real que está com o dono (cartão "4 · PORTAIS · Teste real da Shopee"). Sem ele, não se sabe se o "Link personalizado" pela extensão funciona com a conta do dono.

Direção: a oferta da Shopee do catálogo deixa de usar o link curto do Etiqueta e passa a ter o link gerado pela conta do dono (extensão hoje; Open API se a Shopee liberar), com o Sub_id do grupo. Com link próprio provado, a oferta não precisa de revisão. O dono volta a incluir Shopee nas regras.

O desenho detalhado e os critérios de aceite desta entrega são escritos depois do teste real, com o resultado em mãos.

## O que fica com o construtor

- O nome, o verbo e o formato exato da rota nova do Etiqueta, e o freio de leituras dela.
- Como representar "pulada" no banco e onde aplicar a reserva das 6 horas.
- A forma do laço de reposição de vaga e do disjuntor.
- Como classificar erro passageiro e recusa definitiva do Mercado Livre.
- Onde guardar o estado da Central e o estado dos avisos do vigia.
- Os textos finais das mensagens e dos selos (com o `designer`).

## O que depende do dono (fora do código)

- **Hoje:** rodar a atualização de preços da Amazon no Etiqueta (`operacao/atualizar-amazon.sh`). Os preços confirmados em 09/11 passam das 48 h nesta manhã e o catálogo deixa de trazer Amazon até a próxima rodada.
- Reiniciar o servidor do Etiqueta e religar o verificador em Ajustes depois da entrega 1.
- Recarregar a extensão do Chrome depois da entrega 2.
- Fazer o teste real da Shopee antes da entrega 4 e voltar a incluir Shopee nas regras depois dela.
- Dar o ok para levar cada entrega ao serviço e para os commits.
