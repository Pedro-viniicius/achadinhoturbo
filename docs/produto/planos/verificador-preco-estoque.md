# Plano técnico: Verificador de preço e estoque logo antes do envio
- Brief: sem brief; cartão do Trello "🔴 07 · Verificador: preço e estoque conferidos logo antes do envio" (pedido do lead, rodada 1)
- Spec: docs/produto/specs/verificador-preco-estoque.md (designer, em paralelo; respostas em "Alinhamento com a spec")
- Data: 2026-11-09
- Ramo: `feat/verificador` (worktree `achadinho_turbo-wt-verificador`)

## Objetivo e critérios de aceite
Nenhuma oferta esgotada ou mais cara do que o anunciado sai para os grupos: o programa lê de novo preço e estoque na loja logo antes de gerar o link e mandar.

- CA1 — Toda oferta passa pelo verificador antes de gerar o link e enviar, em todas as origens:
  - disparo automático (todas as fontes, inclusive o Catálogo);
  - Disparo manual (agora e agendado);
  - espelhamento;
  - remetente;
  - "Enviar" da revisão do Catálogo.

  Lojas: ML (preço e estoque), Amazon (preço e estoque, com a API), Shopee (só preço, com a API). A Magalu nunca é conferida (D2).
- CA2 — Oferta esgotada não sai. O Histórico grava `aviso` "Descartada: esgotado na loja". O motivo entra em `MOTIVOS_VERIFICADOR` e em `public/docs/cap-referencia.js`.
- CA3 — Preço atual acima da referência mais o limite → não sai. O Histórico grava `aviso` "Descartada: preço subiu de R$ X para R$ Y (+N%, o limite é L%)". O limite fica em Ajustes: padrão 5%, inteiro de 0 a 50. Se o preço caiu ou subiu dentro do limite, a oferta sai com o preço atual e o desconto recalculado. Preço digitado à mão que difere do da loja é mantido.
- CA4 — Sem conferência (loja fora do ar, sem API, tempo esgotado, Magalu):
  - Dados de até 30 min: a oferta sai, e a linha `ok` do Histórico ganha " · preço não conferido (<causa>)".
  - Dados mais velhos ou de idade desconhecida: não sai, e o Histórico grava `aviso` "Descartada: não deu para conferir o preço (<causa>)".
  - Catálogo: vai à revisão com o motivo `nao_conferido`.
  - Cada conferência leva no máximo 20 s. Nada do verificador vai ao Histórico com nível `erro`.
- CA5 — `{HORA_PRECO}` → "14h32": a hora em que o preço foi conferido na loja. Vazio quando não houve conferência; a linha, ou o trecho entre `[ ]`, some.
- CA6 — Testes sem loja real (`fetch` global bloqueado, leitores injetados, `dryRun` e modo fake). README, `TIPS`/`LEIA_MAIS`, capítulos dos Docs e `FATOS` acompanham a mudança.
- CA7 — Tela:
  - Ajustes ganha o cartão "Conferir preço e estoque antes de enviar", com chave (padrão ligada) e limite em %. Desligar grava um `aviso` no Histórico.
  - Templates mostra a dica de `{HORA_PRECO}`.
  - O Disparo manual mostra o selo "Descartado" com o motivo e a dica no agendar.
  - Em `DRY_RUN`, a conferência confirma sem acessar a rede.

## Contexto atual
- **Regras.** `pickOffers` (src/scheduler.js:310) escolhe as ofertas. O laço de envio (src/scheduler.js:416-480) gera os links (`linksPorCodigo`, :423 e :437) e manda.
  - A Central é lida na hora da escolha (src/ml.js:312-318).
  - A "Lista de links" com preço digitado nunca é relida (src/ml.js:254).
  - O Catálogo chega pronto, e as ofertas suspeitas vão à revisão (src/scheduler.js:419-435).
- **Fila `envios`.** `preparar('oferta')` (src/envios.js:1174) usa os dados gravados ao criar e gera os links (:1188-1201).
  - Quem monta o payload: `payloadDaOferta` (src/envios.js:847, Disparo manual e remetente), `gravarEnvio` (src/espelho.js:408) e src/catalogo-itens.js:443.
  - `lerEnvio` traz `created_at` (src/envios.js:440).
  - Falha no `preparar` → log `erro` por grupo (src/envios.js:1316-1323), e `erro` dispara o aviso por WhatsApp (src/avisos.js:377).
  - `envios.status` não tem CHECK (src/db.js:56); `SQL_ENVIO_FALHOU` (src/catalogo-itens.js:59) e o SQL do espelho (src/espelho.js:74) enumeram os status: não criar status novo.
- **Leitores.**
  - ML: API e depois a página, JSON-LD ou social (src/ml.js:241-280, :172). Não lê disponibilidade.
  - Amazon: `disponivel` já existe (src/amazon.js:205-213), com cache de 15 min e fila de 1/s (:89-91, :403).
  - Shopee: `productOfferV2` sem estoque (src/shopee.js:84; docs/produto/referencias/shopee-api-afiliados.md:22). Item não devolvido = fora do programa, que não bloqueia (commit 42130b3).
  - Magalu: não lida (ADR-008).
  - A extensão não lê produto (extension/background.js:364-368).
- **Template.** `PLACEHOLDERS` e `offerValues` (src/template.js:8, :36); `DICAS_PLACEHOLDERS` (public/ajuda.js:151); chips em public/app.js:595.
- **Ajustes.** src/server.js:267 e :294 (sem `soDono`); tela em public/app.js:683.
- **Selos do Disparo manual.** `dispPill` (public/disparos.js:312).
- **Motivos do Catálogo.** src/catalogo-itens.js:43, fixados em test/catalogo-itens.test.js:113 e test/docs.test.js:949-956, rótulos em public/espelhamento.js:568.
- **Fiação.** `criarServicos` (src/server.js:61-84) → `createScheduler` → `createEnvios` (src/scheduler.js:100). Ao menos 10 arquivos de teste usam `criarServicos`.

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| **A. `src/verificador.js` chamado no laço do `runRule` e no `preparar('oferta')`, antes do link (escolhida)** | 2 pontos cobrem todas as origens; decisão pura testável; sem banco nem extensão | +≤20 s por oferta no tick | Baixo |
| B. Conferir em `pickOffers`, repondo a descartada | Regra completa a quantidade | Minutos entre a conferência e o envio; não cobre `envios` | Médio |
| C. ML pela extensão (pedido `produto`) | Sessão do navegador | Mexe em background.js e no manifest, o dono recarrega a extensão, fila única com os links | Médio |

A é o caminho. C vira entrega 2 se o Histórico mostrar a leitura do ML falhando.

## Decisão
- **D1 — Pontos de conferência.**
  - Regras: antes de `linksPorCodigo`.
  - Fila: em `preparar('oferta')`, antes de `linksPorGrupo` e fora do `try` que diz "link de afiliado não gerado".
  - Prévias não conferem.
- **D2 — Leitura por loja.**
  - ML: pelo servidor, com o leitor do Disparo manual.
  - Amazon: só pela Creators API (ADR-002: não raspar HTML).
  - Shopee: só preço, pela Open API (sem estoque na API; a página exige anti-bot).
  - Magalu: nunca conferida.
- **D3 — Falha da conferência: regra do frescor, sem opção na tela.** Sem conferência, a oferta sai se `lidoEm` (a idade dos dados) for de até `FRESCOR_MIN = 30` min. Central, espelho, remetente, revisão e Disparo manual "agora" seguem saindo; agendado velho e lista digitada, não. Catálogo sem conferência vai à revisão.

  Por quê: segurar sempre travaria o espelho sem API e toda a Magalu; mandar sempre (o padrão da spec) deixaria sair o agendado de manhã com preço velho, contra o "pronto quando" do cartão.
- **D4 — Preço.**
  - Referência: `payload.preco_loja` (o preço da loja lido ao criar) ou `offer.price`.
  - Atual acima de `ref × (1 + L/100)` → descarta.
  - Senão, se `offer.price === ref`: `price` = atual, `oldPrice` só se for maior, `discountPct` recalculado.
  - Preço digitado (≠ ref) é mantido.
  - Sem ref (oferta sem preço, espelho "curto") → não compara.
  - Limite de 0 a 50 (a spec propõe 100). Acima de 50 a proteção vira enfeite; quem não quer conferir desliga a chave.
- **D5 — Esgotado só com sinal explícito.**
  - ML: JSON-LD `offers.availability` em `OutOfStock|SoldOut|Discontinued`, ou API com `status !== 'active'` ou `available_quantity === 0`.
  - Amazon: `disponivel === false`.
  - Conferido = preço lido. Disponível sem preço conta como sem conferência.
- **D6 — Regras.**
  - A descartada não é reposta na execução e fica 6 h fora da escolha da regra (`PAUSA_DESCARTADA_H`, `Map` em memória).
  - Catálogo esgotado ou que subiu → `registrar(…, 'descartado')`.
  - Um descarte nunca para as outras ofertas.
- **D7 — `{HORA_PRECO}`** = `vistoEm` em "HHhMM" na hora local, preenchido só pela conferência que deu certo.
  - `lidoEm`: nas regras, `Date.now()` da escolha (`null` para lista digitada e Catálogo); na fila, `envios.created_at`.
  - `lidoEm` só serve à regra do frescor; nunca vai ao texto.
- **D8 — Histórico.**
  - Descarte: uma linha `aviso` por oferta.
  - "Preço não conferido (<causa>)" e "preço atualizado de X para Y" viram sufixo " · …" da linha `ok` de cada grupo.
  - Frases fixas e `brl()`; nada vindo da loja; nunca o nível `erro`.
- **D9 — Fiação por opção.** `criarServicos({ verificar = false, simulado = false })`; o bloco principal passa `verificar: true, simulado: DRY_RUN`. Sem a opção, `verificador = null` e tudo segue como hoje (os mais de 2000 testes não mudam).
- **D10 — Ajustes sem `soDono`**, como os demais cartões. O desligamento grava um `aviso` "Verificador desligado em Ajustes".
- **D11 — Sem migração.** Chaves novas em `settings`, `preco_loja` opcional no payload e `resultado.descartado` no JSON do envio. Nenhum `envios.status` novo; o envio descartado termina em `erro`, com `resultado.descartado`. A extensão não muda.
- **D12 — Sem "Enviar mesmo assim" no Disparo manual.** O "agora" vai para a fila e a conferência acontece no tick, depois da resposta do POST: não há "barrada na hora" para mostrar.
  - Esgotado é sinal da loja.
  - Para "Usar R$ Y", basta disparar de novo: o `criar` relê a loja e grava o novo `preco_loja`.
  - Uma flag que pula o verificador seria uma porta para mandar oferta vencida.

## Esquema e contratos
- **`settings`:** `verificador_ativo` ('1'|'0'; ausente = ligado) e `verificador_limite_pct` (0 a 50; ausente = 5).
- **`src/ml.js`:**
  - `parseProductHtml` e `fromApiItem` devolvem `disponivel: true|false|null`.
  - `parseListLines` marca `digitado: true` quando a linha traz preço.
  - Nova `export async function conferirProduto(url, { fetchJson, fetchText } = {}) → { price, disponivel }`: sempre lê, sem o atalho de :254; `hostPermitido` antes; o leitor de página sai de `resolveOffer` para uma função do módulo.
- **`src/amazon.js`:** `lerItem(asin, { fresco })` e `lerItens(asins, { fresco })`.
- **`src/shopee.js`:** `lerItem(shopId, itemId, { fresco })`.

  Com `fresco`, o cache é ignorado na leitura e gravado depois; a fila de 1/s e o teto de 300/h valem.
- **`src/template.js`:** `'HORA_PRECO'` em `PLACEHOLDERS`. `offerValues`: `HORA_PRECO = o.vistoEm ? 'HHhMM' : ''`. `SAMPLE_OFFER` e `SAMPLE_OFFER_AMAZON` com `vistoEm` às 14h32.
- **`src/verificador.js`** (novo):
  - Constantes: `LIMITE_PADRAO_PCT = 5`, `LIMITE_MAX_PCT = 50`, `FRESCOR_MIN = 30`, `TEMPO_MAX_MS = 20000`, `PAUSA_DESCARTADA_H = 6`.
  - `MOTIVOS_VERIFICADOR = { esgotado: 'Descartada: esgotado na loja', preco_subiu: 'Descartada: preço subiu', nao_conferido: 'Descartada: não deu para conferir o preço' }`.
  - `CAUSAS` fixas: a loja não respondeu, a API da Amazon não está ligada, a Magalu não deixa ler a página, a Shopee não devolveu o produto, a página não trouxe o preço, a loja demorou demais.
  - `class OfertaDescartada extends Error { motivo, texto }`.
  - `decidir({ leitura, referencia, precoOferta, limitePct, lidoEm, agora })` é pura.
  - `createVerificador({ db, ml, amazon, shopee, simulado = false, agora = Date.now, tempoMaxMs })` → `{ ativo(), limitePct(), conferir(oferta, { lidoEm, referencia }) }`.
  - `oferta` = `{ loja: 'mercadolivre'|'amazon'|'shopee'|'magalu', url, asin, shopId, itemId, price, oldPrice, discountPct, … }`.
  - `conferir` nunca lança. Devolve `{ acao: 'enviar', oferta, conferido, sufixo|null }` (`oferta.vistoEm` só se conferido) ou `{ acao: 'descartar', motivo, texto }`.
  - Desligado: `enviar`, sem `vistoEm`, sem sufixo.
  - `Promise.race` com `tempoMaxMs`, e `.catch` na promessa perdedora.
- **Assinaturas:** `createEnvios({ …, verificador = null })`; `createScheduler({ …, verificador = null })`, que repassa ao `createEnvios`; `criarServicos({ …, verificar, simulado })`.
- **Payload da oferta:** `preco_loja`, o preço da loja antes de ajustes e texto, gravado por `payloadDaOferta`.
- **Resultado do envio:** `resultado = { ok, erro, motivo, descartado: 'esgotado'|'preco_subiu'|'nao_conferido' }`. `painel('oferta')` devolve `descartado` em cada linha do histórico.
- **API de Ajustes:** `GET /api/state` → `ajustes.verificador_ativo` (bool) e `ajustes.verificador_limite_pct`. `PUT /api/ajustes` aceita os dois: booleano estrito e inteiro de 0 a 50; fora disso, 400 "Informe um número inteiro de 0 a 50.".
- **Catálogo:** `MOTIVOS` ganha `'nao_conferido'`, com o rótulo "Não deu para conferir o preço: confira na loja".

## Etapas
| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 1 | ML: `disponivel` (JSON-LD só por enum, API), `conferirProduto` com o leitor extraído (`resolveOffer` igual), `digitado`. Fixtures: InStock, OutOfStock, sem `offers`, social, API paused; host de fora recusado; `fetch` global bloqueado | src/ml.js, test/ml-conferir.test.js | `node --disable-warning=ExperimentalWarning --test test/ml-conferir.test.js test/qa-ml-social.test.js test/disparador.test.js` | dev | A | sim (HTML externo) | CA1, CA2, CA6 |
| 2 | `fresco` em `lerItem`/`lerItens` da Amazon e da Shopee: com cache válido vai à rede, grava o cache, respeita a fila de 1/s e o teto/h; sem `fresco`, nada muda | src/amazon.js, src/shopee.js, test/amazon.test.js, test/shopee.test.js | `node --disable-warning=ExperimentalWarning --test test/amazon.test.js test/shopee.test.js` | dev | A | sim (cota externa) | CA1, CA6 |
| 3 | `{HORA_PRECO}` no template e nas amostras, mais `DICAS_PLACEHOLDERS`. Testes: 14h05; sem `vistoEm` a linha some; dentro de `[ ]` | src/template.js, test/template.test.js, public/ajuda.js | `node --disable-warning=ExperimentalWarning --test test/template.test.js test/qa.test.js` | dev | A | não | CA5 |
| 4 | Catálogo: `nao_conferido` em `MOTIVOS`, rótulo em espelhamento.js:568, linha na 1ª tabela de "motivos" e testes fixos 4 → 5 | src/catalogo-itens.js, test/catalogo-itens.test.js, public/espelhamento.js, public/docs/cap-referencia.js, test/docs.test.js | `node --disable-warning=ExperimentalWarning --test test/catalogo-itens.test.js test/docs.test.js` | dev | A | não | CA4 |
| 5 | `src/verificador.js` (contratos acima; ids da Shopee de `shopId`/`itemId` ou da chave `SHOPEE:s.i`).<br>• `decidir`: esgotado, acima e dentro do limite, limite 0, caiu, digitado mantido, sem ref, 29/31 min, `lidoEm` null.<br>• `conferir` com leitores falsos: Magalu, Amazon sem API, Shopee null, 20 s com relógio injetado, desligado, simulado.<br>• Textos sem dado da loja | src/verificador.js, test/verificador.test.js | `node --disable-warning=ExperimentalWarning --test test/verificador.test.js` | dev | B | sim (decide o que sai) | CA1–CA4, CA6, CA7 |
| 6 | Fila:<br>• `verificador` em `createEnvios`; `preco_loja` em `payloadDaOferta`.<br>• Conferência em `preparar` (D1) com `lidoEm = created_at` (repassado pelo `runEnvio`); texto renderizado com a oferta conferida; sufixo no retorno de `enviar`.<br>• `OfertaDescartada` no `runEnvio`: uma linha `aviso`, `registrar` ok=0 com o texto por grupo, `finalizar` com `descartado`, nenhum `erro`.<br>• `painel` devolve `descartado`; prévias (envios.js:925/958/989/995, espelho.js:925) com `vistoEm: Date.now()`.<br>• Testes (`dryRun`, verificador falso): manual agora e agendado, payloads de espelho, catálogo e remetente; descartada não pede link (espião em `requestLink`); `{HORA_PRECO}` no texto | src/envios.js, src/espelho.js, test/verificador-envios.test.js | `node --disable-warning=ExperimentalWarning --test test/verificador-envios.test.js test/envios.test.js test/espelho.test.js test/remetentes.test.js` | dev | C | sim (fila, envio) | CA1–CA5 |
| 7 | Regras:<br>• `verificador` em `createScheduler` (repassa ao `createEnvios`); `lidoEm` em `pickOffers`.<br>• `Map` de 6 h pulado antes de `tried++`; conferência antes de `linksPorCodigo`; sufixo em `comoSaiu`.<br>• Catálogo: descartar → `'descartado'`; `nao_conferido` → revisão (`TEXTO_MOTIVO`).<br>• `summary.descartadas`; frase da grade (:482) cita as descartadas.<br>• Testes: lista digitada velha não sai; Central sem conferência sai com o sufixo; esgotada não volta em 6 h; Catálogo vai à revisão | src/scheduler.js, test/verificador-regras.test.js | `node --disable-warning=ExperimentalWarning --test test/verificador-regras.test.js test/disparador.test.js test/catalogo-regras.test.js test/qa-grade.test.js` | dev | C | sim (envio) | CA1–CA5 |
| 8 | Fiação e tela:<br>• `criarServicos` + bloco principal (D9); `GET`/`PUT` com validação e `aviso` ao desligar.<br>• Cartão de Ajustes da spec (chave + limite; sem o select de falha, D3).<br>• Dica de `{HORA_PRECO}` em `paginaTemplates`; `TEXTOS_VERIFICADOR`.<br>• `dispPill` com "Descartado" + motivo; dica no agendar.<br>• TIPS `ajustes.verificador` e `ajustes.verificador.limite`.<br>• Teste: `verificar: true` + ml falso + `fetch` bloqueado → descartado; sem `verificar` não confere; `PUT` 51/-1/"x" → 400; simulado sem rede | src/server.js, public/app.js, public/disparos.js, public/ajuda.js, test/verificador-servidor.test.js | `node --disable-warning=ExperimentalWarning --test test/verificador-servidor.test.js test/servidor.test.js test/qa.test.js test/equipe-qa.test.js` | dev | D | sim (configuração que desliga a proteção) | CA1, CA7 |
| 9 | Docs, conforme a seção "Docs" da spec, com as correções do Alinhamento:<br>• README.<br>• `LEIA_MAIS` das 2 TIPS → `manutencao/verificador`.<br>• cap-conta: seção nova `verificador` em manutencao e linhas na tabela de ajustes.<br>• cap-disparos: `{HORA_PRECO}` em templates/campos, exemplo em opcional, frase em disparo-manual/agendar.<br>• cap-referencia: 3ª tabela de motivos com `MOTIVOS_VERIFICADOR`, linha em limites (0 a 50), glossário.<br>• `FATOS`: 5, 30 e 6, mais um teste de que a 3ª tabela cobre `MOTIVOS_VERIFICADOR` | README.md, public/ajuda.js, public/docs/cap-conta.js, public/docs/cap-disparos.js, public/docs/cap-referencia.js, test/docs.test.js | `node --disable-warning=ExperimentalWarning --test test/docs.test.js test/qa.test.js test/qa-docs.test.js` | dev (texto revisado pelo designer) | E | não | CA2, CA5, CA6 |

Ordem: A (1 a 4, sem arquivo comum) → B (5) → C (6 e 7, sem arquivo comum) → D (8) → E (9) → `npm test` completo pelo lead. As etapas sensíveis vão ao `dev` com `model: opus`.

## Alinhamento com a spec
| Ponto da spec | Resposta do plano |
|---|---|
| Decisão 2: limite de 0 a 100 | 0 a 50 (D4). A mensagem de erro passa a "de 0 a 50". |
| Decisão 4 e select "Se a loja não responder" (padrão "Enviar mesmo assim") | Recusado: regra fixa do frescor de 30 min (D3), sem select. A TIP `ajustes.verificador.falha` e o `LEIA_MAIS` dela somem. A sub do cartão ganha: "Se a loja não responder, a oferta só sai se os dados forem de até 30 min." |
| Decisão 8, "Enviar mesmo assim" / "Usar R$ Y" / "Tentar de novo" no manual | Fora desta entrega (D12). O resultado aparece no histórico do Disparo manual com o selo "Descartado" (via `resultado.descartado`). |
| Textos do Resultado | Adotados ("Descartada: esgotado na loja"…). "Preço não conferido" e "preço atualizado" viram sufixo da linha `ok` (D8). |
| `{HORA_PRECO}` vazio sem conferência | Adotado (D7). |
| Catálogo: barrada não vai à revisão; `MOTIVOS` sem mudança | Em parte. Esgotado e preço que subiu → `descartado`. Sem conferência → revisão `nao_conferido` (etapa 4), porque descartar perderia para sempre toda oferta da Amazon sem API, e esperar trava o cursor. |
| Espelhamento/Remetente: gravar status `descartado` no item | Não. O item do espelho ou do remetente já está decidido quando o envio nasce. O motivo aparece pelo resultado do envio por grupo, e o texto já começa com "Descartada:". A resposta ao remetente fica a genérica (src/remetentes.js:624). |
| `[ARQ]` quem salva o cartão | Quem salva os outros Ajustes, sem `soDono` (D10). |
| `[ARQ]` amostra da prévia | `SAMPLE_OFFER` com `vistoEm` às 14h32 (etapa 3). |
| "Repetição" no fluxo | Oferta não repete (src/envios.js:1012); só agora e agendado. |
| `LEIA_MAIS` → `manutencao/verificador` | Adotado (etapa 9). |

## Pontos para o seguranca
1. O HTML e o JSON do ML são entrada externa. A disponibilidade é lida só por enum; a página tem o teto `MAX_PAGINA` (src/ml.js:196); `hostPermitido` vale a cada salto.
2. Histórico e console só levam frases fixas, `brl()` e `CAUSAS`. Nunca a URL, o corpo da loja ou o erro cru (no console, só `e.name`).
3. `fresco` não fura a fila de 1/s nem o teto de 300/h, e não há nova tentativa. Confira se a conferência pode tirar vagas do teto da Shopee usado pelos links.
4. O Operador pode desligar a proteção (D10): avalie `soDono`. O desligamento fica no Histórico.
5. Na corrida de 20 s, a promessa perdedora não pode gerar rejeição sem tratamento.
6. Descartada no `runEnvio`: o `finalizar` sempre roda e nada fica preso em `enviando`; nenhum `erro` no log (não dispara aviso por WhatsApp).
7. Nenhuma flag pula o verificador (D12).
8. Os testes novos bloqueiam `globalThis.fetch`.

## Riscos e como reverter
- **Leitura do ML pelo servidor bloqueada** (não verificado em produção). A Central segue saindo com "preço não conferido"; lista digitada e agendados velhos param. Reverter: chave em Ajustes, sem deploy. Entrega 2: abordagem C.
- **Preço da Central diferente do preço da página** (vendedor do buy box) gera descartes falsos. O Histórico mostra os dois preços e a oferta fica 6 h fora. Reverter: subir o limite ou desligar.
- **Tick mais lento**, até 20 s por oferta. Reverter: desligar.
- **Código.** Sem migração; `git revert` do ramo basta. O código antigo ignora `preco_loja`, `resultado.descartado` e as chaves de `settings`. Item de revisão com `nao_conferido` aparece sem motivo no código antigo (filtro de src/catalogo-itens.js:342), o que não faz mal.

## Perguntas em aberto e premissas adotadas
Nenhuma pergunta ao dono: D1 a D12 decidem. Premissas:
- As páginas do ML (anúncio e `/p/`) trazem JSON-LD com `offers.price` e `offers.availability`. Não verificado com página real; o dev usa fixtures. Sem esses campos, a leitura cai em "sem conferência", sem descarte falso.
- `disponivel === false` da Amazon inclui PREORDER/LEADTIME (src/amazon.js:213, a mesma regra do espelho).
- No remetente, `lidoEm` é o `created_at` do envio, não a hora da mensagem (até 2 h antes).
- O `preco_em` do Etiqueta (docs/produto/referencias/api-ofertas.md do Etiqueta) não é usado; o Catálogo sem conferência vai à revisão.
- Corte possível: 1 a 7 numa entrega e 8 e 9 em outra. Não recomendo: sem a 8 não há como desligar.

## ADR
**ADR-010 — Verificador de preço e estoque antes do envio.**
- **Decisão:**
  - `src/verificador.js`, com `decidir` pura e leitores por loja, chamado no `runRule` e no `preparar('oferta')`.
  - Regra do frescor de 30 min quando a conferência falha.
  - ML pelo servidor; Amazon e Shopee pela API; Magalu sem conferência.
  - Sem migração, sem mudar a extensão e sem flag que pule a conferência.
- **Consequências:**
  - Uma leitura a mais por oferta.
  - Até 20 s a mais no tick por oferta.
  - Oferta sem conferência e com dados velhos deixa de sair.
- **Rejeitadas:**
  - Conferir na escolha.
  - ML pela extensão (adiada).
  - Raspar a página da Amazon (ADR-002).
  - Opção "enviar mesmo assim" (spec).
