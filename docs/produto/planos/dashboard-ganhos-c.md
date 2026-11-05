# Plano técnico: Dashboard de ganhos, Entrega C (o que ficou de fora de A e B)
- Brief: docs/produto/briefs/dashboard-ganhos.md (CAs do brief citados como "CA9 do brief")
- Base: docs/produto/planos/dashboard-ganhos.md (catálogo MDD M1–M15, cenário C1, ADR-006) e spec docs/produto/specs/dashboard-ganhos.md
- Data: 2026-11-05
- Onde: só em `~/Documentos/achadinhoturbo-ganhos` (ramo `feature/dashboard-ganhos`). Linha de base: `TMPDIR=/tmp/claude-1000/t npm test` = 1291 testes, 1290 passam, 0 falham, 1 todo.

## Objetivo e critérios de aceite
Fechar o risco que ficou da rodada 3 (contagem em dobro ou sobrescrita silenciosa ao importar sem pedido com e sem "Código do arquivo") e os quatro itens da spec que esperavam dado do servidor.

- CA1: a prévia (e o resumo depois de gravar) diz quantas linhas novas têm a mesma data e o mesmo produto de vendas já importadas **com outro código ou sem código** (`outro_codigo`) e traz uma frase de aviso. O que é gravado não muda.
- CA2: a prévia (e o resumo) diz quantas linhas importadas antes **sem código vão receber o código deste arquivo** (`recebem_codigo`, o caso R4) e traz uma frase de aviso. O que é gravado não muda.
- CA3: os cartões mostram o valor do período anterior e a variação (M16) com sinal e palavra ("+300%, mais"); sem base para comparar, só o valor anterior.
- CA4: o Dono clica no nome de um grupo em "Por grupo" e a tabela "Por oferta" passa a mostrar só as ofertas daquele grupo, com um botão para voltar a todas.
- CA5: oferta com produto reconhecido tem link para a **página do produto na loja, sem afiliado**, em outra aba. Nunca é o link de afiliado. Sem produto reconhecido, não há link.
- CA6: `#ganhos?bloco=3&loja=shopee&periodo=30d` (e `de`/`ate` com `periodo=custom`) abre Ganhos com esses filtros; o endereço acompanha os filtros; o cartão do bloco ganha "Ver ganhos".
- CA7 (TDD e MDD): em cada etapa o teste vermelho vem primeiro; M16 tem fórmula e teste com valores conhecidos do C1; `npm test` verde.
- CA8 (CA9 do brief): sem `comparar` nem `grupo`, `GET /api/ganhos` responde como hoje, só com o campo novo `url` nas linhas de oferta. A importação grava exatamente como hoje.
- CA9 (CA10 do brief): README, `TIPS`/`LEIA_MAIS` de `public/ajuda.js` e `public/docs/cap-grupos.js` acompanham. Nenhum número novo está previsto; se aparecer, entra em `FATOS`.
- CA10 (CA11 do brief): rotas continuam só do Dono; parâmetros novos validados e recusados com frase fixa; avisos sem eco do arquivo; URL montada só por regex estrita para domínio fixo; `rel="noopener noreferrer"`.

## Contexto atual
- Chave sem pedido: `src/importador.js:328-334` (base = loja, data, produto ou título, código efetivo). Renomear a linha sem código (R4): `:405-407`. `classificar`: `:393-415`. Avisos: `:338-341` e `:457-462`. Resumo: `:463-472`. `registros` não diz se a linha tinha pedido: `:324` e `:334`.
- A prévia do painel já mostra qualquer `r.avisos` (`public/ganhos.js:840`), sempre com `esc`.
- `metricas`: `src/ganhos.js:161`. O recorte de bloco usa `noRecorte`/`jidsRecorte` (`:184-185`). `por=oferta` (`:287-309`) não tem URL nem filtro de grupo. `lerConsulta`: `:429-444`. Rota: `:457`.
- Período anterior da Visão Geral: mesmo tamanho, logo antes (`src/analytics.js:111`; painel em `public/paineis.js:18`).
- Painel: 5 GETs `/api/ganhos` por carga (`public/ganhos.js:656`). Cartões: `:427-458`. Por grupo: `:491`. Por oferta: `:550-566`. Estado `GANHOS`: `:31`. `rastreioLinhaBloco`: `:142`, chamado no cartão do bloco (`public/paineis.js:111`).
- Roteador: só o Histórico guarda a consulta do endereço (`public/app.js:696-710`). Para o Operador, a checagem é exata, `location.hash === '#ganhos'` (`:743`).
- URL de produto sem afiliado já existe: `lerChave` (`src/catalogo-itens.js:90-99`, regex em `:62-64`). Não cria ciclo: só `src/server.js` importa `src/ganhos.js`, e `catalogo-itens.js` não importa `ganhos.js`.
- O harness vm de `test/ganhos-painel.test.js:56-57` já tem `location.hash` e `history.replaceState`.

## Abordagens consideradas
Link da oferta:

| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| **Página do produto, sem afiliado** (`lerChave`) | o clique do dono não entra no relatório da loja (M4 a M6 ficam limpos); uma URL por oferta; nada sai para grupo (o CA9 do brief trata do que é enviado) | o dono pode copiar e divulgar um link sem comissão | baixo, com rótulo explícito |
| Link de afiliado enviado (`rastreio_envios.link`) | é o que o grupo recebeu | o clique do dono conta no relatório (M4 sobe, M5 e M6 caem); há um link por código, então qual mostrar?; regras de autoclique nos programas (não verificado) | médio |
| Sem link | risco zero | perde o uso de conferir preço e estoque | — |

Período anterior e R10:

| Abordagem | Prós | Contras |
|---|---|---|
| **`comparar=1` só no GET `por=grupo`**; o servidor devolve `anterior` | nenhum GET a mais; M16 testada no servidor | um `metricas` a mais por carga |
| 5 GETs com as datas do período anterior | servidor intocado | 10 GETs; conta feita no painel |
| R10: rota com vários `por` | 1 GET só | contrato novo e refactor da carga, sem ganho para esta entrega: **fica de fora** |

## Decisão
- D1. **Avisos da importação** são só contagem mais frase fixa, calculadas dentro de `classificar` antes de gravar. Na prévia e na gravação: mesma conta, verbo em outro tempo. Não bloqueiam e não mudam o que é gravado (CA8).
  - `recebem_codigo` = nº de ops com `chaveAntiga`.
  - `outro_codigo`: uma consulta carrega as linhas de `comissoes` da loja com `data` entre a menor e a maior do arquivo (`chave, data, produto, titulo, codigo`). Ficam de fora as linhas cuja `chave` é de algum registro do arquivo ou é `chaveAntiga` de alguma op. Chave de casamento = `data | (produto ?? titulo ?? '')`, a mesma base da chave. Para cada op `nova` de registro **sem pedido**, em ordem, consome a primeira linha da lista com o mesmo casamento e com `formaDoCodigo(loja)(codigo ?? '')` diferente do código do registro: conta 1 e tira a linha da lista (cada linha do banco conta uma vez só).
  - Linhas com pedido ficam fora, porque o pedido já separa as vendas (`:320-326`). Cliques ficam fora (ver Riscos).
- D2. `analisar` marca cada registro de comissão com `sem_pedido: true|false`. Campo interno: o resumo não o devolve.
- D3. **Período anterior** (M16): `metricas(…, { comparar: true })` acrescenta `anterior = { dia_de, dia_ate, total, variacao }`. Sem `comparar`, `anterior: null`. O período anterior tem os mesmos N dias de negócio logo antes (a regra da Visão Geral), calculados por número de dia: `periodRange('custom', 0, {de: diaTexto(nDe−N), ate: diaTexto(nDe−1)}, viradaMin)`, com os mesmos `loja`/`bloco`. `total` vem de `metricas` recursiva com `por: 'loja'` (a mais barata) e `comparar: false`.
- D4. **Filtro de grupo:** `grupo=<jid>` só com `por=oferta` e sem `bloco`. Recorte = comissões atribuídas a **esse grupo** (`alvo_tipo 'grupo'`, mesmo `jid`) e envios desse `jid`. Venda atribuída ao bloco inteiro não entra (ela não se divide: ADR-006). `nao_atribuida: null`. Invariante: Σ comissão das ofertas com `grupo=G` = comissão da linha G em `por=grupo` (só as linhas com produto).
- D5. **URL da oferta:** `urlDaOferta(loja, produto)` em `src/ganhos.js` normaliza e delega a `lerChave`:
  - Amazon: `/^(?:ASIN:)?([A-Z0-9]{10})$/i`, passado como `ASIN:` + maiúsculas;
  - ML: `/^MLB-?(\d{1,20})$/i`, passado como `MLB` + dígitos;
  - Shopee: `SHOPEE:<loja>.<item>` como está.
  - A loja devolvida tem de bater (`ml` corresponde a `mercadolivre`). Se não bater, `null`.
  - O painel só usa a URL se ela começar com `https://www.amazon.com.br/dp/`, `https://produto.mercadolivre.com.br/MLB-` ou `https://shopee.com.br/product/` (defesa em profundidade).
- D6. **Endereço:** o roteador passa a consulta também para `ganhos`. Consulta com alguma chave conhecida volta os filtros ao padrão (`30d`, sem bloco, sem loja) e aplica só os valores válidos; consulta vazia mantém o estado atual (a navegação pelo menu não perde filtro). A cada carga, `history.replaceState` grava o endereço dos filtros (`#ganhos` quando tudo está no padrão). Isso não dispara `hashchange`.

## Métrica nova (MDD)
| ID | Métrica | Fórmula | Fonte | Granularidade | Uso |
|---|---|---|---|---|---|
| M16 | Variação contra o período anterior | (X − X_ant) ÷ X_ant, com X ∈ {comissao, receita, vendas, cliques, epc, conversao, envios, entradas}; `null` se X_ant é 0 ou `null` | `metricas` do período e do anterior | total do recorte | tendência nos cartões |

Valores conhecidos do C1 (`test/ganhos.test.js`, `cenarioC1`, virada 0). Cada linha vira um `test`:
- Custom 06–10/10, anterior 01–05/10 (`dia_de '2026-10-01'`, `dia_ate '2026-10-05'`):
  - comissão 1200 contra 300, **3**; receita 24000 contra 5000, **3,8**; vendas 5 contra 1, **4**;
  - cliques 150 contra 60, **1,5**; EPC 8,00 contra 5,00, **0,6**; conversão 1/30 contra 1/60, **1** (comparar com tolerância 1e-9);
  - envios 0 contra 16, **−1**; entradas 0 contra 0, **`null`**.
- Custom 01–05/10, anterior 26–30/09: comissão 300 contra 700, **≈ −0,5714**.
- Custom 30/09–30/09, anterior 29/09: comissão 700 contra 0, **`null`** (sem base).
- Painel: v = 3 → "+300%, mais"; v = −0,5714 → "−57%, menos"; arredondado a 0 → "0%, igual"; `null` → só "Período anterior: R$ X".

## Esquema e contratos
Sem migração e sem tabela nova.
- `importar(…)` devolve também `outro_codigo` e `recebem_codigo` (inteiros; `null` em cliques). Novas chaves em `MENSAGENS_IMPORTADOR`, montadas com `plural`, sem eco de conteúdo:
  - `outroCodigoPrevia`: "1 linha tem a mesma data e produto de uma venda já importada com outro código (ou sem código). Se for o mesmo relatório importado de novo, não importe: a venda contaria em dobro." / "{n} linhas têm a mesma data e produto de vendas já importadas com outro código (ou sem código). Se for o mesmo relatório importado de novo, não importe: as vendas contariam em dobro."
  - `outroCodigoGravado`: igual, terminando em "Se era o mesmo relatório, apague esta importação em Importações recentes."
  - `recebemCodigoPrevia`: "{n} linhas importadas antes sem código vão receber o código deste arquivo. Se eram de outro grupo, não importe: apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código." (singular análogo)
  - `recebemCodigoGravado`: "… receberam o código deste arquivo. Se eram de outro grupo, apague a importação antiga e importe os dois arquivos de novo, cada um com o seu código."
- `metricas(db, { …, grupo = null, comparar = false })`. O resultado ganha `grupo` (jid ou null) e `anterior`. Linhas de `por=oferta` ganham `url` (string ou null). Exporta `urlDaOferta`.
- `GET /api/ganhos` aceita `grupo=` e `comparar=1`. Novas chaves em `MENSAGENS_GANHOS`, recusadas por `lerConsulta`:
  - `grupo_por`, 400: "O filtro de grupo vale só para a tabela Por oferta."
  - `grupo_e_bloco`, 400: "Filtre por grupo ou por bloco, não pelos dois."
  - `comparar`, 400: "O parâmetro de comparação veio repetido ou inválido. Mande comparar=1 uma vez só."
  - grupo inexistente, repetido ou com mais de 200 caracteres: 404 com `M.grupo`, que já existe.

## Etapas
Responsável de todas: `dev` (sensível → `model: opus`). Verificação de cada etapa: `node --disable-warning=ExperimentalWarning --test <arquivos de teste da etapa>`, com o teste novo **falhando antes** do código. No fim de cada grupo: `TMPDIR=/tmp/claude-1000/t npm test`. Grupos em ordem: C1, depois C2.

| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 1 | Avisos da prévia: `sem_pedido` em `analisar`, `outro_codigo`/`recebem_codigo` em `classificar`, frases | src/importador.js, test/importador.test.js | `--test test/importador.test.js` | dev | C1 | não (só contagem e frase fixa; nenhuma entrada nova) | CA1, CA2, CA7, CA8, CA10 |
| 2 | `comparar` e M16, filtro `grupo` em `por=oferta`, `urlDaOferta`, validação em `lerConsulta` | src/ganhos.js, test/ganhos.test.js | `--test test/ganhos.test.js` | dev | C1 | **sim** (dado de arquivo vira URL; parâmetros novos) | CA3, CA4, CA5, CA7, CA8, CA10 |
| 3 | Painel: variação nos cartões (`comparar=1` só no GET `por=grupo`); grupo como botão que recarrega só `por=oferta&grupo=` (sem `bloco`), título "Por oferta: grupo X" e "Ver todas as ofertas"; link da oferta; `q('ganhos.oferta')` no título "Por oferta"; "Como ler" com a regra do período anterior; endereço `#ganhos?…` (ler e `replaceState`); "Ver ganhos" em `rastreioLinhaBloco`; roteador | public/ganhos.js, public/app.js, test/ganhos-painel.test.js | `--test test/ganhos-painel.test.js test/qa.test.js` | dev | C2 | **sim** (href vindo do servidor; filtros lidos do endereço) | CA3, CA4, CA5, CA6, CA10 |
| 4 | Docs: TIPS `ganhos.oferta` (novo) e acréscimos em `ganhos.comissao` e `ganhos.importar`; LEIA_MAIS `ganhos.oferta` → `grupos/ganhos`; seções `ganhos` e `importar` de cap-grupos; README "Página Ganhos" e importação | README.md, public/ajuda.js, public/docs/cap-grupos.js | `--test test/docs.test.js test/qa.test.js` | dev | C2 | não | CA9 |

- C1 = {1, 2}, sem arquivo em comum. C2 = {3, 4}, sem arquivo em comum: a 3 não toca `ajuda.js`, a 4 não toca `ganhos.js`.
- O `test/qa.test.js:685` (todo `q('…')` tem verbete) só fica verde com 3 e 4 prontas. Rode-o no fim do grupo, não como condição de cada etapa.
- `public/app.js` só entra na 3 (roteador, linhas 671, 702, 710 e 743).
- Não há etapa do `designer`: a variação reaproveita `.nota`/`.dica` e o link usa o `a` existente, sem CSS novo. O `designer` revisa o resultado junto com o `revisor`.

### Testes que nascem primeiro (vermelho)
1. Em `test/importador.test.js`, com os helpers `csv`/`novoDb`/`importar`, nomes começando por "Entrega C":
   - (a) Amazon sem pedido, 2 linhas iguais (10/10, `B0ABCDEF12`), importada com `codigo: 'grupoa-20'`. A prévia do mesmo arquivo **sem** código dá `novas 2`, `outro_codigo 2` e a frase `outroCodigoPrevia` no plural. Gravar dá os mesmos números, e a tabela fica com 4 linhas, como hoje.
   - (b) Variante do revisor: arquivo do grupo A sem código, depois o do grupo B com `grupob-20` (mesma data e produto). A prévia dá `atualizadas 1`, `recebem_codigo 1`, `outro_codigo 0` e a frase `recebemCodigoPrevia`.
   - (c) Sem falso alarme: reimportar com o mesmo código dá 0/0; arquivo **com pedido** com e sem código dá 0/0; outro dia ou outro produto dá 0/0; Amazon `GrupoA-20` contra `grupoa-20` dá 0 (R14).
   - (d) Consumo: 1 linha no banco com `a`, arquivo com 3 linhas iguais com `b`, `outro_codigo 1`.
   - (e) Cenário R11 (A com código e depois B com outro código): `outro_codigo 1`, documentado como ambíguo, só aviso.
   - (f) Cliques: `outro_codigo`/`recebem_codigo` são `null`.
   - (g) Nenhuma frase traz valor do arquivo nem o parâmetro `codigo`.
2. Em `test/ganhos.test.js`:
   - (a) Uma linha por valor de M16 acima, sobre `cenarioC1`.
   - (b) Sem `comparar`, `anterior === null`.
   - (c) `grupo=G1, por=oferta` dá `[{oferta:'SHOPEE:1.2', comissao:500, envios:4, grupos:1, …}]` e `total.comissao 500` (o 400 de B1 não entra). `grupo=G3` dá 0 linhas. Invariante contra `por=grupo` para G1 e G2.
   - (d) `grupo` com `por=grupo` dá 400 `grupo_por`; `grupo` + `bloco` dá 400; grupo inexistente dá 404; `comparar=2` ou repetido dá 400; tudo pela rota e por `lerConsulta`.
   - (e) `urlDaOferta`:
     - `('amazon','B0TESTE001')` e `('amazon','ASIN:b0teste001')` dão `https://www.amazon.com.br/dp/B0TESTE001`;
     - `('mercadolivre','MLB-123')` dá `https://produto.mercadolivre.com.br/MLB-123`;
     - `('shopee','SHOPEE:1.2')` dá `https://shopee.com.br/product/1/2`;
     - `('shopee','B0TESTE001')`, `('amazon','javascript:x')`, `null` e `('mercadolivre','123')` dão `null`.
     - As linhas de oferta do C1 trazem `url`, e nenhuma contém `tag=`, `meli.la` ou `s.shopee`.
3. Em `test/ganhos-painel.test.js` (harness vm):
   - (a) A carga pede `comparar=1` só no GET `por=grupo` e faz os mesmos 5 GETs `/api/ganhos`. O cartão Comissão mostra "Período anterior: R$ 3,00 (+300%, mais)". `variacao null` mostra o valor sem %.
   - (b) Clicar no grupo G1 faz 1 GET `por=oferta&grupo=…` sem `bloco`, com o título e "Ver todas as ofertas", que volta a todas sem GET novo. A linha "Sem grupo identificado" não tem botão. O botão tem `aria-pressed`.
   - (c) A oferta com `url` vira `<a target="_blank" rel="noopener noreferrer">` com aria-label "… na loja, sem seu link de afiliado (abre em outra aba)". `url` `javascript:` ou de outro domínio não vira link. `url null`, sem link.
   - (d) `#ganhos?bloco=3&loja=shopee&periodo=30d` faz os GETs com esses filtros. `loja=x`, `bloco=01` e `periodo=zz` são ignorados. Trocar o filtro reescreve o endereço; tudo no padrão volta a `#ganhos`. Operador em `#ganhos?bloco=3` vai para `#visao` sem chamar `/api/ganhos`.
   - (e) O cartão do bloco tem "Ver ganhos" para `#ganhos?bloco=<id>`, e o Operador não o tem.
4. `test/qa.test.js` (q com verbete, LEIA_MAIS válido) e `test/docs.test.js` continuam verdes. Nenhum FATOS novo.

## Pontos para o seguranca
- Etapa 2: `urlDaOferta` só monta URL a partir das regex de `lerChave`, com host fixo. Nada do CSV passa inteiro para a URL. `grupo` limitado a 200 caracteres e conferido em `groups`. Parâmetro repetido (lista) recusado. Erro sem eco.
- Etapa 3: o href passa pela checagem de prefixo e por `esc`, com `rel="noopener noreferrer"` (sem `Referer` do painel para a loja). Filtros do endereço só entram por regex/lista e nunca vão para seletor ou HTML sem `esc`. O Operador continua sem chamar `/api/ganhos` (checagem de rota por prefixo antes do `?`).
- Etapa 1: as frases são fixas, com só a contagem; o parâmetro `codigo` não volta no texto.

## Riscos e como reverter
- Falso alarme do `outro_codigo` quando dois grupos vendem o mesmo produto no mesmo dia (R11 legítimo): a frase diz "parecem"/"se for o mesmo relatório" e não bloqueia. Mitigação real é o relatório com pedido ou com coluna de código (P5).
- Cliques sem aviso: importar o mesmo arquivo de cliques com e sem código também duplica M4. Fica fora porque arquivos por código no mesmo dia são o fluxo normal, e o aviso seria ruído. Premissa P-C2.
- Link do ML com id de catálogo (`/p/MLB…`) pode abrir 404: o formato é o mesmo de `lerChave`, usado no catálogo (não verificado para id de catálogo).
- O dono copiar o link sem afiliado e divulgar: rótulo explícito e TIPS `ganhos.oferta`.
- Reverter: `git revert` dos commits. Não há esquema novo; os campos novos são ignorados pelo painel antigo.

## Perguntas em aberto e premissas adotadas
- P-C1. O aviso da importação não bloqueia nem exige confirmação extra. **Premissa: sim**, porque o botão "Importar arquivo" da prévia já é a confirmação.
- P-C2. Cliques sem aviso de código (ver Riscos). **Premissa adotada.**
- P-C3. A variação aparece em Comissão, Valor vendido, Vendas, Cliques, Ganho por clique, Conversão, Envios e Entradas. Gasto, Custo por membro, Retorno e Comissão com grupo ficam sem ela (entrada do dono, ou o sinal confunde a %). **Premissa adotada.**
- P-C4. O filtro de grupo some ao trocar qualquer filtro e não vai para o endereço. **Premissa adotada.**

## ADR
Sem ADR: é extensão de contratos existentes, sem dependência, sem padrão novo e sem mudança de modelo de dados.
