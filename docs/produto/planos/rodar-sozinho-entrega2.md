# Plano técnico: Rodar sozinho · Entrega 2 (Mercado Livre que se recupera)
- Brief: docs/produto/briefs/rodar-sozinho.md (seção "Entrega 2", "Propostas minhas", "Fracasso", "Restrições")
- Spec: docs/produto/specs/rodar-sozinho-entrega2.md (textos e telas; alinhamento no fim)
- Base de código: cópia `achadinho_turbo-wt-e1`, ramo `feature/rodar-sozinho-e1`, HEAD `def9a19` (entrega 1 aprovada). Linha de base: `npm test` com 2.937 testes, 2.936 passam, 0 falham, 1 todo.
- Data: 2026-11-11

## Objetivo e critérios de aceite
Falha passageira da Central ou da extensão deixa de mandar oferta do Mercado Livre para a revisão e de gastar minutos por oferta. Depois de 3 falhas seguidas o ML fica **em espera** e volta sozinho. O painel separa "extensão conectada" de "Central respondendo". CA2.1 a CA2.10 valem como estão no brief. Este plano acrescenta:
- CA2.11 — No catálogo, a oferta cujo preço conferido ficou `QUEDA_REVISAO_PCT`% ou mais abaixo do preço da lista vai à revisão com o motivo `queda_preco`. Abaixo do limite, sai.
- CA2.12 — A guarda de preço suspeito depois da conferência (desconto de 100%, preço antigo ≥ 10×, queda) vale também nas fontes antigas (descarta e deixa a oferta 6 h fora da escolha) e na fila de envios (descarta o envio). Preço digitado à mão não passa pela guarda.
- CA2.13 — Com a leitura do ML pausada (verificação, limite por hora, extensão antiga), as ofertas do ML ficam fora da escolha sem gastar tentativa e sem uma linha "Pulada" por oferta. A contagem entra na linha "Antes da escolha".
- CA2.14 — A execução para de escolher ofertas quando o tempo gasto com escolhidas que caíram fora passa de `ORCAMENTO_FALHAS_S`. A frase "Saíram X de Y" diz isso.
- CA2.15 — Quando o Etiqueta continua ocupado depois das novas tentativas, a releitura fica pausada por 1 min, e as Amazon seguintes da execução não esperam de novo.
- CA2.16 — A extensão manda a versão no poll. Abaixo de 1.6.0, ou sem versão, o painel mostra "Extensão desatualizada".
- CA2.17 — A migração tira da revisão, uma vez só, os itens pendentes só por `falha_link` e grava uma linha no Histórico com a contagem.

## Contexto atual
- **Link:** `requestLink` espera 90 s (`src/links.js:166-172`). `online` mede só o poll (`:101-106`). `lastOkAt` e `lastError` vivem só na memória (`:92`, `:311-327`) e se perdem a cada reinício.
- **Regra, catálogo:** link que falha vira `falha_link` e vai à revisão (`src/scheduler.js:865-877`). `esperaDoMl` só conhece extensão off-line e modo direto (`:311-316`). A falha do `requestLink` só vira espera se a extensão caiu (`:334-337`).
- **Regra, fontes antigas:**
  - link que falha grava uma linha `erro` e a oferta é pulada (`:888-891`);
  - a guarda de preço suspeito depois da conferência só existe no catálogo (`:843-846`);
  - o descarte do verificador pausa a oferta por 6 h (`:882`).
- **Reposição:** até `want × 4` escolhidas (`:773`), sem limite de tempo. A Amazon sem conferência sai da escolha por `semConferenciaAgora` (`:505-508`, `:575`). O ML com a leitura pausada não sai da escolha: cada oferta vira "Pulada" com `ml_verificacao` ou `limite_hora` (`src/verificador.js:121-129`, `src/scheduler.js:847-858`).
- **Preço suspeito:** `motivosDeRevisao` só olha o desconto de 100% e o preço antigo ≥ 10× (`src/catalogo.js:360-368`). `conferirOferta` da fila não tem guarda (`src/envios.js:1297-1311`).
- **Etiqueta ocupado:** o freio curto espera até 2 × 3 s (`src/catalogo.js:110`, `:661-666`). Depois disso, `ocupado` e `intervalo` não pausam a releitura (`src/verificador.js:152-155`).
- **"Enviar" da revisão:** quando falha em todos os grupos, `liberarFalhos` só tira a reserva de `sent_offers`. O item fica `enviado`, com `pode_reenviar` (`src/catalogo-itens.js:295-302`, `:366`).
- **Extensão:**
  - `abaDaCentral` só acha aba em `/afiliados*`; fora dela, abre uma aba fixada nova (`extension/background.js:84-92`);
  - o erro do `executeScript` e o do fetch se perdem (`:127-131`, `:61-63`), e o dono vê só uma frase genérica (`:146-149`);
  - aba descartada pelo Chrome não é tratada;
  - teto do pedido de 80 s (`:20`); o poll não manda a versão (`:576`); manifest em 1.5.0.
- **Servidor:** `/api/ext/poll` repassa só `x-recursos` (`src/server.js:197-200`). `/api/ext/result` não tem campo de tipo de erro (`:203-206`). `/api/state` devolve `links.status()` (`:327`).
- **Modelo de migração única com marca:** `migrarNaoConferido` (`src/db.js:302-330`).
- **Painel:** a faixa tem uma pílula só (`public/app.js:111-120`); Conexões tem uma linha só (`public/conexoes.js:179-192`).

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| A. Espera no serviço de links (`src/links.js`), testada pelo **próximo pedido real** depois de 5 min | Um ponto só: regra, fila, "Enviar" e lista passam por ele; nenhum tráfego extra na sessão do dono | O estado só se atualiza quando há pedido | Teste que nunca chega à Central (a oferta cai antes do link): tratado abaixo |
| B. A + sonda ativa a cada 5 min (pedido da lista da Central) | Estado sempre fresco para o painel e o vigia | Até 288 chamadas por dia à Central com a sessão do dono (ADR-011 protege essa sessão); pedido novo na extensão | Anti-robô do ML |
| C. Espera só no agendador | Menos arquivos | Fila e "Enviar" continuam gastando 90 s por pedido | Duas regras divergentes |

Vale a **A**. Ela basta para os CAs, e o vigia da entrega 3 já conta "havendo tentativas". A B pode entrar na entrega 3 se o dono quiser o selo sempre fresco.

## Decisão
1. **Estado da Central** em `src/links.js`, gravado em `settings.ml_central` (JSON, mesmo padrão de `ml_produto_pausa`):
   - **Contam como falha:** link com falha passageira; lista de ofertas com falha; `produto_ml` com `tempo` ou `erro`.
   - **Fecham a espera e zeram a contagem:** link gerado; lista lida; **recusa** do ML (a Central respondeu).
   - **Neutros:** `produto_ml` lido não fecha a espera. Senão ela abriria e fecharia em laço quando só o `createLink` falha. `desconectada`, `antiga`, `verificacao` e `limite` também não contam: nenhum pedido saiu.
   - **Abertura:** 3 falhas seguidas abrem a espera e marcam o próximo teste para 5 min depois.
   - **Teste:** com a espera aberta, `requestLink` e `requestOffers` recusam na hora, sem pedido à extensão (erro de classe `espera`), salvo quando o teste está liberado. O primeiro pedido desse momento é o teste e empurra o próximo para 5 min depois. Qualquer falha registrada durante a espera também empurra o próximo teste.
   - **Histórico:** uma linha ao abrir (`aviso`) e uma ao fechar (`info`), nunca `erro`. Teste que falha não grava linha.
2. **Classificação do erro de link** (`ErroLinkML` com `classe`, `causa`, `detalhe`):
   - A extensão nova manda `tipo` no resultado: `recusa|sessao|sem_resposta|aba|http|formato`.
   - A antiga é classificada pelo texto.
   - **Recusa definitiva** só se a mensagem casar com `RECUSAS_DEFINITIVAS`. Hoje há uma só, vista no banco do dono: `/must be active|status:\s*(paused|closed|inactive)/i` → causa `anuncio_inativo`.
   - Recusa que não casa com a lista conta como falha da oferta (D6). `detalhe` é o erro real, sem caracteres de controle, cortado em 160 caracteres no servidor.
3. **Prazos:** link do servidor de 90 para 45 s. Na extensão: teto do pedido de 80 para 40 s, espera da aba de 30 para 20 s, fetch na aba de 20 para 15 s, carregamento de 25 para 15 s. O servidor continua acima da extensão.
4. **Agendador:**
   - `esperaDoMl` ganha `ml_espera`. A oferta do ML espera na escolha, como a extensão desconectada (CA2.4).
   - `utilizavelNa` só consulta o estado da Central, sem gastar o teste.
   - **Falha passageira (link ou conferência `loja_fora`/`demorou`):** a oferta é pulada e a vaga é reposta. Ela soma 1 no contador `falhasMl` (memória, chave regra+oferta, no máximo 1 por execução).
   - **3ª falha:** catálogo vai à revisão com o motivo `falhas_repetidas`; fonte antiga fica 6 h fora da escolha.
   - **Recusa definitiva:** catálogo `registrar('descartado')`; fonte antiga pausa 6 h. Linha "Descartada…".
   - **Candidata de teste** (escolhida com a espera aberta): a falha dela não conta (D2), e ela fica `PAUSA_DESCARTADA_H` fora da escolha. Assim uma oferta "veneno" não segura o teste para sempre.
   - **Orçamento:** `ORCAMENTO_FALHAS_S = 120` de tempo gasto com escolhidas que caíram fora. Passou disso, a execução não escolhe mais nenhuma.
   - **Leitura do ML em pausa:** `verificador.pausaDaLeituraMl()` tira a oferta da escolha (categoria nova em `fraseFiltradas`). A espera da Central vence quando as duas valem (spec §2b).
5. **Queda de preço:** `quedaDePreco(lista, conferido)` em `src/catalogo.js`. `motivosDeRevisao(c, { precoLista })` acrescenta `queda_preco` quando a queda é ≥ `QUEDA_REVISAO_PCT` (D5; recomendo 50).
   - **Catálogo:** passa `precoLista = o.price`, o preço de antes da conferência.
   - **Fontes antigas:** a mesma guarda descarta com `preco_suspeito` e pausa 6 h.
   - **Fila:** `conferirOferta` lança `OfertaDescartada('preco_suspeito')` só quando o preço que vai na mensagem veio da conferência (não digitado).
6. **CA2.8:** `liberarFalhos` devolve o item a `revisao` (`decidido_em = NULL`, `envio_id` mantido), na mesma transação em que tira a reserva. `listar` passa `ultimo_envio_falhou` e os erros por grupo. O "Enviar" com o ML em espera responde 400 com frase fixa (sem pedido).
7. **Extensão 1.6.0:**
   - guarda o id da aba que abriu (`chrome.storage.local.abaCentral`); se essa aba saiu de `/afiliados`, volta para a Central com `tabs.update`, em vez de abrir outra;
   - nunca navega uma aba do ML aberta pelo dono que não esteja em `/afiliados`;
   - aba `discarded` é recarregada antes do `executeScript`;
   - o erro real vai entre aspas, com `tipo`;
   - o poll manda `x-versao` (do `chrome.runtime.getManifest()`);
   - o popup mostra o estado da Central e a versão.
8. **Etiqueta ocupado:** `ocupado` ou `intervalo` que sobra depois das novas tentativas pausa a releitura por `PAUSA_ETIQUETA_OCUPADO_S = 60`.
9. **Migração:** `DELETE` de `status='revisao' AND motivos='["falha_link"]'`, com a marca `migracao_e2_falha_link`, no molde de `migrarNaoConferido`. `falha_link` fica em `MOTIVOS` só para ler as linhas antigas.

## Esquema e contratos
- **`settings.ml_central`:** `{ falhasSeguidas, ultimoOkEm, ultimoErroEm, ultimoErro (≤160), emEsperaDesde|null, proximoTesteEm|null }`.
  - Na leitura: valor fora do formato vira 0 ou null; `proximoTesteEm` nunca passa de agora + 5 min; nada fica no futuro.
  - Sem tabela nova.
- **`src/links.js`:**
  - Constantes: `FALHAS_PARA_ESPERA = 3`, `TESTE_ESPERA_MIN = 5`, `PRAZO_LINK_MS = 45000`, `VERSAO_EXTENSAO = '1.6.0'`, `RECUSAS_DEFINITIVAS`.
  - `status()` passa a incluir `versao` (string|null), `versaoEsperada`, `desatualizada` (bool, só com a extensão on-line) e `central`, com `{ estado: 'respondendo'|'falhando'|'em_espera'|'sem_teste', falhasSeguidas, ultimoOkEm, ultimoErroEm, ultimoErro, emEsperaDesde, proximoTesteEm }`.
  - `central()` devolve o mesmo objeto, mais `testeLiberado` (bool, sem efeito colateral).
  - `produtoDisponivel()` devolve `null` ou `'verificacao'|'limite'|'antiga'|'desconectada'`, sem pedido.
  - `poll(waitMs, { recursos, versao })` e `submit(id, { …, tipo })`.
  - Rejeição do link: `ErroLinkML { classe: 'passageira'|'recusa'|'espera'|'desconectada', causa, detalhe }`.
- **`src/server.js`:** o poll lê `x-versao` (`^\d{1,3}\.\d{1,3}\.\d{1,3}$`, senão null). O result repassa `tipo`, só de uma lista fechada.
- **`src/verificador.js`:**
  - `CAUSAS` ganha `central_sem_resposta` ("a Central de Afiliados não respondeu"), `central_aba` ("não deu para abrir a Central de Afiliados no Chrome"), `central_login` ("a Central de Afiliados pediu login") e `anuncio_inativo` ("o anúncio está pausado ou inativo").
  - `MOTIVOS_VERIFICADOR` ganha `preco_suspeito`.
  - Novo: `pausaDaLeituraMl()`, que devolve `null` ou `ml_verificacao|limite_hora|extensao_antiga`. Só vale com o verificador ligado e o ML pela extensão.
- **`src/catalogo.js`:** `export const QUEDA_REVISAO_PCT`; `quedaDePreco(lista, conferido)`, que devolve a % inteira ou null; `motivosDeRevisao(c, opcoes = {})`.
- **`src/catalogo-itens.js`:** `MOTIVOS` ganha `queda_preco` e `falhas_repetidas`.
- **`src/scheduler.js`:**
  - Constantes: `FALHAS_DA_OFERTA = 3`, `ORCAMENTO_FALHAS_S = 120`.
  - `PULADA_POR` ganha `link_central` ("Central sem resposta"), `ml_espera` ("Mercado Livre em espera") e `orcamento`.
  - `DESCARTADA_POR` ganha `recusada_ml` ("recusada pelo Mercado Livre") e `preco_suspeito` ("preço suspeito").
  - `TEXTO_ESPERA` ganha `ml_espera`; `exec.filtradas` ganha `mlPausa` e `mlPausaCausa`.
  - `PULADA_POR.link` fica para outras lojas.
- **Divergências da spec:**
  - (a) `central.estado` (enumeração) e `emEsperaDesde`, no lugar de `respondendo`, `emEspera` e `desdeEm`;
  - (b) não existe "a Central demorou demais": a conferência do ML não passa pela Central e mantém as causas `demorou`/`loja_fora`;
  - (c) só uma recusa mapeada; "não existe mais" e "não gera link" ficam sem mapeamento até alguém ver essas frases reais (não verificado);
  - (d) o marcador `{LIMITE}` vira o número de `QUEDA_REVISAO_PCT`.

## Etapas
Ordem TDD: o teste nasce vermelho e o código o põe verde. Antes de começar, o `dev` roda `rg -n "não consegui gerar o link|falha_link|Link de afiliado não gerado|90 s|90_000|1\.5\.0" src test public README.md` para achar os testes e textos que mudam.

| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 1 | Estado da Central: contagem, espera, teste a cada 5 min, persistência e linhas de abrir e fechar; `ErroLinkML` e classificação (com `tipo` e pelo texto); prazo de 45 s; `x-versao`, `desatualizada`, `produtoDisponivel()`; poll e result do servidor | `src/links.js`, `src/server.js`, `test/links-central.test.js` (novo), `test/links.test.js` | `node --disable-warning=ExperimentalWarning --test test/links-central.test.js test/links.test.js test/links-produto.test.js` | dev | 1 | sim (link de afiliado, concorrência, persistência) | 2.1, 2.2, 2.4–2.6, 2.9, 2.16 |
| 2 | Extensão: aba lembrada e reaproveitada, aba descartada recarregada, erro real e `tipo`, prazos novos, `x-versao`; popup com a linha da Central e a versão | `extension/background.js`, `extension/popup.html`, `extension/popup.js`, `test/extensao-travamento.test.js` | `node --disable-warning=ExperimentalWarning --test test/extensao-travamento.test.js test/extensao-shopee.test.js test/extensao-produto.test.js` | dev | 1 | sim (extensão) | 2.7, 2.16 |
| 3 | `pausaDaLeituraMl`, causas novas, `preco_suspeito`, pausa de 60 s do Etiqueta ocupado; atualizar `TEXTO_PERMITIDO` | `src/verificador.js`, `test/verificador.test.js` | idem com `test/verificador.test.js` | dev | 1 | não | 2.13, 2.15 |
| 4 | `quedaDePreco`, `QUEDA_REVISAO_PCT`, `motivosDeRevisao(c, { precoLista })` | `src/catalogo.js`, `test/catalogo.test.js` | idem com `test/catalogo.test.js` | dev | 1 | não | 2.11 |
| 5 | Migração do `falha_link`; `MOTIVOS` novos; `liberarFalhos` devolve à revisão; `ultimo_envio_falhou`; "Enviar" recusa com o ML em espera | `src/db.js`, `src/catalogo-itens.js`, `test/catalogo-itens.test.js` | idem com `test/catalogo-itens.test.js` | dev | 1 | sim (migração) | 2.8, 2.17 |
| 6 | Agendador, parte A: `ml_espera` na escolha e na leitura, candidata de teste, falha passageira pulada e contada, 3ª falha à revisão, recusa descartada, orçamento de 120 s, textos | `src/scheduler.js`, `test/ml-recupera.test.js` (novo), mais os testes que fixam as frases antigas | `npm test` | dev | 2 | sim (agendador, concorrência) | 2.1–2.4, 2.9, 2.14 |
| 7 | Fila: guarda `preco_suspeito` depois da conferência (não com preço digitado) | `src/envios.js`, `test/verificador-envios.test.js` | idem com `test/verificador-envios.test.js` | dev | 2 | não | 2.12 |
| 8 | Painel: duas pílulas e `haQuanto`, que só repinta quando o HTML muda; Conexões com selo por prioridade e duas linhas; textos da revisão (`queda_preco`, `falhas_repetidas`, vazio, último envio falhou, `hcatPrecoSuspeito`) | `public/app.js`, `public/conexoes.js`, `public/espelhamento.js`, `public/style.css` | `npm test` e conferência a 375 e 1280 px com `PORT=3799 DATA_DIR=<tmp> DRY_RUN=1` | designer | 2 | não | 2.5, 2.8, 2.11, 2.16 |
| 9 | Agendador, parte B: guarda de queda no catálogo (`precoLista`), guarda nas fontes antigas (descarta e pausa 6 h), ML com a leitura pausada fora da escolha e a categoria nova na linha "Antes da escolha" | `src/scheduler.js`, `test/ml-recupera.test.js`, `test/verificador-regras.test.js` | `npm test` | dev | 3 | sim (agendador) | 2.11–2.13 |
| 10 | Docs, `TIPS`/`LEIA_MAIS` e README conforme a spec, §4, com o passo de recarregar a extensão | `public/ajuda.js`, `public/docs/cap-referencia.js`, `cap-conta.js`, `cap-comecar.js`, `cap-grupos.js`, `cap-amazon-revisao.js`, `cap-disparos.js`, `README.md` | `npm test` | designer | 4 | não | 2.10 |
| 11 | Versão 1.6.0 no manifest; `FATOS` com 3, 5, 3, `QUEDA_REVISAO_PCT`, 1.6.0 (e 120 s ou 45 s se os Docs citarem); frases e causas novas; asserções de versão | `extension/manifest.json`, `test/docs.test.js`, `test/extensao-shopee.test.js` | idem com `test/docs.test.js` e depois `npm test` | dev | 4 | não | 2.10, 2.16 |

Ordem dos grupos:
- O grupo 1 roda em paralelo (as etapas 1 a 5 não compartilham arquivo).
- As etapas 6, 7 e 8 dependem do grupo 1 e não compartilham arquivo entre si. A 8 usa o contrato de `/api/state` acima.
- A 9 vem depois da 6 (mesmo arquivo).
- A 10 e a 11 rodam juntas no fim.
- O manifest sobe só na 11, porque `test/docs.test.js:1781` e `test/extensao-shopee.test.js:478` fixam a versão: subir antes deixaria a suíte vermelha entre os grupos.

**Testes por CA** (nome → arquivo):
- **CA2.1:** 'timeout do link pula, repõe a vaga e não cria catalogo_itens' → `ml-recupera`; 'falha de conferência loja_fora/demorou pula sem revisão' → `ml-recupera`.
- **CA2.2:** 'must be active, status: paused descarta com o motivo e não conta para a espera' → `links-central` e `ml-recupera`.
- **CA2.3:** '3ª falha em execuções diferentes vai à revisão com falhas_repetidas; duas falhas na mesma execução contam uma' → `ml-recupera`.
- **CA2.4:**
  - 'espera aberta: nenhum pedido link/produto_ml à extensão' e 'teste liberado depois de 5 min: um só pedido passa' → `links-central`;
  - 'a Central volta: as ofertas saem na execução seguinte sem ação' e 'reinício com a espera aberta mantém a espera e o horário do teste' → `ml-recupera` e `links-central`.
- **CA2.5:** 'status traz central.estado e as horas' → `links-central`; telas → etapa 8 (prova visual do designer).
- **CA2.6:** 'último sucesso e erro sobrevivem a novo createLinkService com o mesmo db' → `links-central`.
- **CA2.7:**
  - 'aba descartada é recarregada', 'aba lembrada fora de /afiliados é reaproveitada', 'três pedidos não criam segunda aba fixada', 'aba do dono fora de /afiliados nunca é navegada', 'erro real e tipo chegam no result' → `extensao-travamento`;
  - passo manual do dono (abaixo).
- **CA2.8:** '"Enviar" que falha em todos os grupos volta à revisão sem reserva; o "Enviar" seguinte funciona' → `catalogo-itens`.
- **CA2.9:**
  - 'nenhum caminho de nova tentativa chama o modo direto nem aceita link fora de meli.la' → `links-central`;
  - 'fallback para a etiqueta padrão, nunca link comum, também na espera' → `ml-recupera`.
- **CA2.10:** frases, causas e `FATOS` → `docs.test.js`.
- **CA2.11:** 'queda de 50% vai à revisão com queda_preco; 49% sai' → `catalogo` e `ml-recupera`.
- **CA2.12:** 'fonte antiga com preço suspeito depois da conferência descarta e pausa 6 h' → `ml-recupera`; 'fila descarta preco_suspeito; preço digitado passa' → `verificador-envios`.
- **CA2.13:** 'pausa de verificação: ML fora da escolha, nenhuma linha Pulada, contagem em Antes da escolha'; 'a espera vence a pausa' → `ml-recupera`.
- **CA2.14:** 'passados 120 s em ofertas que caíram, a execução para com a frase' → `ml-recupera` (relógio injetado).
- **CA2.15:** 'ocupado depois das novas tentativas pausa 60 s; a Amazon seguinte vai à reserva sem chamar' → `verificador`.
- **CA2.16:** 'sem x-versao ou 1.5.0 → desatualizada; 1.6.0 → não' → `links-central`.
- **CA2.17:** 'migração tira só os só falha_link, uma vez, com a contagem' → `catalogo-itens`.

**Extensão fora do `npm test` de ponta a ponta:** o `test/extensao-travamento.test.js` roda o `background.js` inteiro num `vm`, com `chrome.*` e relógio falsos (técnica que já existe), e cobre aba, erro e versão. Passo manual do dono depois do merge:
1. abrir `chrome://extensions` e clicar em recarregar na extensão achadinhoturbo;
2. conferir "Versão 1.6.0" no popup;
3. conferir em Conexões o selo "Conectado" e a linha "Central de Afiliados respondendo" depois do primeiro link.

**Ordem de entrada no serviço** (fora dos horários das regras, com o ok do dono):
1. `npm test` verde na worktree;
2. `npm run backup` (a migração apaga linhas);
3. merge de `src/` de uma vez;
4. conferir a linha da migração no Histórico;
5. recarregar a extensão.

Se a extensão não for recarregada, tudo funciona: o servidor classifica pelo texto e o painel mostra "desatualizada".

**Medição opcional (lead, só leitura):** contar no `log` as linhas `ok` com "preço atualizado de R$ X para R$ Y" em que Y ≤ X × 0,5, ≤ 0,7 e ≤ 0,3. Isso mostra quantas ofertas legítimas cada limite mandaria à revisão. O log guarda só as últimas 5.000 linhas.

## Pontos para o seguranca
- **Etapa 1:**
  - `ultimoErro` vem da extensão (texto livre): cortado em 160, sem caracteres de controle, mostrado no painel via `esc`;
  - nunca vai a log com dado pessoal;
  - `tipo` só de lista fechada; `x-versao` por regex;
  - a espera nunca troca link de afiliado por link comum (CA2.9): a recusa rápida é erro, nunca o modo `direct`;
  - `LINK_MELI` continua no `submit`.
- **Etapa 2:**
  - a extensão só navega a aba que ela mesma abriu (id lembrado) ou uma já em `/afiliados`;
  - nada de permissão nova no manifest;
  - o erro real não pode levar token, csrf nem cookie: só `e.message` do Chrome ou do fetch, cortado.
- **Etapa 5:** `DELETE` restrito por `status` e `motivos` exatos, uma vez só, com backup antes. A volta à revisão acontece na mesma transação que tira a reserva.
- **Etapas 6 e 9:**
  - concorrência entre o teste da espera, `emEnvio` e o "Enviar" do Catálogo;
  - a candidata de teste devolvida sai de `saindo`;
  - o orçamento nunca fura o `ritmo.js`.

## Foco de revisão (casos de encaixe)
1. **Oferta que sempre falha:** fora da espera, ela gasta 1 tentativa por execução e vai à revisão na 3ª. Como candidata de teste, fica 6 h fora da escolha, e o teste seguinte usa outra oferta. Testes 'veneno na cabeça da lista não segura o teste' e 'não trava as seguintes'.
2. **Espera que nunca fecha:** o teste em que a oferta cai antes do link (preço subiu) não gasta o teste, porque o próximo pedido de link ainda o encontra liberado. Teste 'descarte antes do link não gasta o teste'.
3. **Espera que abre e fecha em laço:** a conferência lida não fecha a espera, só link, lista ou recusa. Teste 'produto_ml ok com createLink falhando não fecha a espera'.
4. **Extensão on-line com a Central fora:** é exatamente o caso de 10/11. Teste 'poll vivo e três timeouts abrem a espera; o selo diz Central sem resposta'.
5. **Reinício com a espera aberta:** a espera continua, e o próximo teste fica, no máximo, 5 min à frente. Teste em `links-central`.
6. **Vários códigos de rastreio na mesma oferta:** no teste, o primeiro pedido é o teste. Se ele falha, os outros recusam na hora, sem 3 × 45 s.

## Riscos e como reverter
- **Espera que segura o ML sem necessidade:** apagar `settings.ml_central` (com o serviço parado) zera o estado. O código volta com `git revert` das etapas 1, 6 e 9.
- **Queda de preço manda promoção boa para a revisão:** mudar `QUEDA_REVISAO_PCT` (uma linha) ou pôr 100 para desligar.
- **Migração:** as linhas apagadas são cópias de ofertas do Etiqueta e voltam se o catálogo as trouxer. A volta total é pelo backup.
- **Prazos mais curtos cortam um link lento legítimo:** voltar `PRAZO_LINK_MS` e `TETO_PEDIDO` (duas constantes). A oferta é só pulada, nunca vai sem afiliação.
- **Extensão 1.6.0 com defeito:** carregar a pasta `extension` do commit anterior em `chrome://extensions`. O servidor aceita as duas versões.

## Decisões do dono
**Aprovado pelo dono em 11/11/2026: todas as recomendações abaixo valem.** D1 fora desta entrega; D2 como recomendado; D3 versão 1.6.0; D5 `QUEDA_REVISAO_PCT = 50`, constante no código, sem campo em Ajustes; D6 recusa não mapeada conta como falha da oferta; D7 duas pílulas; D8 120 s; D9 sim.

- **D1, botão "Testar agora" (spec 1).**
  - Recomendo deixar fora desta entrega.
  - Se entrar: rota `POST` só do Dono que libera o teste já (`proximoTesteEm = agora`), mais o botão em Conexões. São cerca de 20 linhas na etapa 1 e na etapa 8.
- **D2, as falhas que abrem a espera contam para a 3ª falha da oferta? (spec 2).**
  - Recomendo: as 3 que abrem a espera contam (1 para cada oferta, porque aconteceram antes dela abrir). A falha no teste, com a espera aberta, não conta, e a candidata de teste fica 6 h fora.
  - Alternativa: contar tudo. Com a Central fora por horas, algumas ofertas do topo iriam à revisão por culpa dela. Muda só a etapa 6.
- **D3, versão 1.6.0 (spec 3).** Recomendo sim; entra em `FATOS`.
- **D4, a extensão antiga funciona? (spec 4).** Fato, não decisão: funciona. A diferença é que fica sem a recuperação da aba e sem o erro real. Vale o tom "continua funcionando".
- **D5, percentual da queda e onde alterar (spec 5).** Exemplo para R$ 199 lido como parcela:

  | Limite | Pega a parcela de | Deixa passar | Custo |
  |---|---|---|---|
  | 30% | 2× ou mais (≥ 50%) | — | Promoções reais de 30 a 50% vão à revisão (frequentes na Black Friday) |
  | **50%** | 2× ou mais, contando "igual ou maior" | queda real < 50% | Promoção real ≥ 50% vai à revisão (rara) |
  | 70% | 4× ou mais | parcela de 2× e 3× | Pouca revisão, proteção menor |

  Recomendo **50%**, como constante no código (sem campo). A alternativa é um campo em Ajustes ao lado do limite de alta, no texto da spec. Isso acrescenta à etapa 8 o campo e uma rota de Ajustes no `src/server.js` (mais uma etapa sensível de configuração).
- **D6, recusa que não casa com a lista (spec 6).**
  - Recomendo tratá-la como falha da oferta, que vai à revisão na 3ª, em vez de descartar. Uma etiqueta errada faria a Central recusar tudo, e o descarte no catálogo é permanente naquela regra.
  - Alternativa (spec): descartar mostrando a resposta do ML.
- **D7, faixa com duas pílulas ou uma (spec 7).** Recomendo duas (spec).
- **D8, orçamento de 120 s por execução para ofertas que caem fora.** É a resposta ao item 4. Recomendo 120 s. Mais alto segura mais o tick único (envios agendados e avisos).
- **D9, fila de envios descarta preço suspeito depois da conferência (CA2.12).** Muda o Disparo manual e o "Enviar". Recomendo sim, só quando o preço da mensagem veio da leitura.

## Premissas adotadas
- **P1:** o contador da 3ª falha fica em memória; um reinício o zera (no pior caso, 2 tentativas a mais). O estado da Central é gravado (CA2.6).
- **P2:** as fontes antigas ganham só a recusa rápida na espera, a classificação e a guarda. Elas não têm linha de espera agregada (nenhuma regra atual as usa).
- **P3:** os prazos novos (45 s e 40 s) são técnicos, sem número nos Docs, salvo se os Docs já citam 90 s.

## Os 5 itens deixados pela entrega 1
1. Queda grande sem preço antigo: decisão 5, etapas 4 e 9 (CA2.11).
2. Guarda nas fontes antigas e na fila: etapas 7 e 9 (CA2.12).
3. "Pulada" repetida do ML: etapas 3 e 9 (CA2.13). A espera da Central também tira o ML da escolha (CA2.4).
4. Tempo por execução: orçamento e prazos menores, etapas 1, 2 e 6 (CA2.14).
5. Etiqueta ocupado: pausa de 60 s, etapa 3 (CA2.15).

## Alinhamento com a spec
- §1: aceitos `link_central`, `ml_espera`, `recusada_ml` e `falhas_repetidas` (motivo novo, `falha_link` só para ler o antigo). A frase da 2ª falha ("É a 2ª vez que falha…") sai do contador `falhasMl`.
- §1, frase "a Central demorou demais" na conferência: não vale. A conferência mantém as causas atuais (divergência b).
- §3: o "Enviar" responde com `envio_id` antes do envio sair. A falha em todos os grupos só aparece depois, na lista (`ultimo_envio_falhou`). Não verifiquei se o diálogo acompanha o envio. Se não acompanha, o texto da §3 vai na linha do item.
- Frase nova sem spec: o fim "o tempo para repor vagas acabou" (orçamento). O designer confirma o texto na etapa 10.

## ADR
**ADR-015: Espera do Mercado Livre no serviço de links, testada pelo próximo pedido real.** Contexto: falha da Central virava revisão permanente e gastava 90 s por pedido; o estado sumia a cada reinício. Decisão:
- estado em `settings.ml_central`;
- 3 falhas seguidas abrem a espera; o teste é o próximo pedido real depois de 5 min;
- só link, lista ou recusa fecham a espera;
- a falha é classificada por `tipo` vindo da extensão 1.6.0, ou pelo texto;
- recusa definitiva só por lista de padrões.

Consequências: fila, regra e "Enviar" passam pela mesma espera; o selo só se atualiza quando há pedido. Alternativas rejeitadas: sonda ativa (tráfego na sessão do dono) e espera só no agendador.
