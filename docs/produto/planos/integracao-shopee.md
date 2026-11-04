# Plano técnico: Shopee no Disparo manual e em Conexões

> **Atualização de 04/11/2026:** o dono reverteu esta decisão. `nao_encontrado` **não bloqueia** mais o Disparar: os dados ficam em branco para preencher à mão sem cartão de aviso (o produto pode não gerar comissão). O que este documento diz sobre o bloqueio vale só como histórico.

- Brief: não há. O pedido do dono de 03/11/2026, repassado pelo lead, faz as vezes de brief (premissas no fim).
- Referência: docs/produto/referencias/shopee-api-afiliados.md (Open API de Afiliados e "Link personalizado" capturado em 03/11)
- Spec de UI (em paralelo): docs/produto/specs/integracao-shopee.md. As respostas aos pontos "A alinhar com o plano" estão na seção "Alinhamento com a spec".
- Plano anterior que este estende: docs/produto/planos/espelhamento-amazon.md (ADR-002: a próxima loja segue `lerProduto`/`linkAfiliado`/`imagemPermitida`)
- Data: 2026-11-03

## Objetivo e critérios de aceite
No Disparo manual, o dono cola um link da Shopee, o painel identifica o produto, preenche título, preço, desconto, vendas e foto (pela Open API quando houver acesso; sem ela, deixa os campos em branco e editáveis, como na Amazon) e envia com o link de afiliado do dono. O link sai pela extensão do Chrome (Link personalizado do portal, com a sessão do dono, como o `meli.la` do ML) ou pela Open API (`generateShortLink`). Nunca é montado à mão.

CA1: identificar sem ler página. `shopee.com.br/<slug>-i.<shopId>.<itemId>`, `shopee.com.br/product/<shopId>/<itemId>` (com ou sem parâmetros) e os links curtos `s.shopee.com.br`, `shp.ee` e `shope.ee` chegam a `shopId` + `itemId`. Os curtos são resolvidos só pelos redirecionamentos (`GET`, `redirect:'manual'`, sem ler o corpo) e só em hosts da Shopee. Link que não chega a um produto devolve a causa `invalido` ou `nao_produto`.
CA2: com a API acessível, o Identificar preenche título (`productName`), preço (`priceMin`), desconto (`priceDiscountRate`), vendas (`sales`) e foto. Os campos ficam editáveis, e "Disparar" e "Agendar para hoje" enviam imagem com legenda com os valores ajustados.
CA3: sem credencial ou sem acesso à API (10035, 10020, 10031–10034), o Identificar ainda reconhece o produto e devolve os campos em branco e editáveis, com a `causa`. Disparar fica habilitado quando há caminho para o link (extensão on-line ou API) e o ID de afiliado está salvo. Sem caminho para o link, Disparar fica desabilitado com a causa (`sem_link`, `sem_id`).
CA4: o link enviado é sempre o `shortLink` (`https://s.shopee.com.br/…`) gerado pelo servidor ao criar o envio, a partir do endereço do produto sem parâmetros. Nunca é o link colado nem um link de terceiro, e nunca é montado à mão com `utm_source=an_…`. Se o `longLink` devolvido trouxer `utm_source=an_<ID>` diferente do ID de afiliado salvo, o envio é recusado ("o Chrome está em outra conta de afiliado").
CA5: em Conexões, o cartão Shopee tem três campos: ID de afiliado (texto), AppID (texto) e Senha da API (segredo). Salvar recusa AppID igual ao ID de afiliado. O `estado` tem os seis valores da spec, mais `situacao` e `extensao_online`. "Testar" faz uma chamada real com resultado por código e frase fixa.
CA6: a senha da API, a assinatura e os cookies da sessão do portal nunca aparecem em resposta do painel, `log`, console nem mensagem de erro. A extensão devolve só `shortLink` e `longLink`.
CA7: a foto só passa se vier do CDN da Shopee (`imagemPermitida('shopee')`). A CSP `img-src` libera só esses hosts. Foto fora da lista vira `null`.
CA8: `npm test` passa sem rede, com API, encurtadores e extensão simulados. Um teste prova o cabeçalho `Authorization` exato para um payload e um timestamp conhecidos, e o `fetch` global nunca é chamado. O que é do ML e da Amazon segue igual. Os testes que usavam a Shopee como "loja não conectada" passam a usar a Magalu.
CA9: espelhamento e regras automáticas continuam ignorando links da Shopee (sem mudança de comportamento). Os dois ficam para a entrega 2 (ver "Corte").

## Contexto atual
- O registro em `src/lojas.js:58-68` tem a `shopee` com `implementada:false`, os hosts `shopee.com.br`, `s.shopee.com.br`, `shp.ee` e `shope.ee`, e os campos `app_id` (texto, `^[0-9]{1,20}$`) e `chave` (segredo). `exigirLoja` recusa loja não implementada (`:124-130`). `IMAGENS` só tem ML e Amazon (`:133`). Em `lerProduto` e `linkAfiliado` há um ramo por loja (`:182-213`). `previaDoLink` atende só o ML (`:221-231`).
- `src/amazon.js` é o modelo de cliente. Resolvedor de link curto em `:192-281`, `lerCorpo` com teto de 2 MiB em `:378-410`, erros com mensagem fixa em `:109-131`. `createAmazon` tem `fetch` injetado, cache, `situacao`, `testar`, `configurado` e `invalidarToken` (`:425-663`). O título de uma linha fica em `tituloDoItem` (`:291-298`).
- `src/conexoes.js`: `segredosDe` (`:63-74`). `visao` tem ramo próprio para a Amazon e um genérico (`:143-169`). `salvar` faz merge por `json_patch`, tudo ou nada (`:181-205`). `testar` responde "ainda não implementada" para quem tem `implementada:false` (`:236-244`). As rotas usam `ctx.amazon` (`:269-274`).
- `src/envios.js`, ramos da Amazon:
  - Constantes nas linhas 50-65.
  - `validarAjustes` (`:355-372`), `temTagAmazon`, `asinDoLink`, `produtoAmazon` e `ofertaAmazon` (`:374-415`).
  - `identificarLink` (`:423-449`), `criar` (`:465-506`) e `preparar` (`:537-578`). Hoje a etiqueta é obrigatória para quem não é Amazon (`:542-543`), e a extensão só é exigida para o ML (`:489`).
- `src/links.js`: a fila de pedidos da extensão (`ask`, `poll`, `submit`). Hoje `submit` aceita só `LINK_MELI` no modo extensão (`:9`, `:80-81`) e tem modo `fake` (`:54`). Em `src/server.js:113-115`, `/api/ext/result` repassa só `ok`, `link`, `data` e `error`.
- `extension/background.js` roda `fetch` dentro de uma aba da Central (`executeScript`, `world:'MAIN'`, `:23-32`, `:58-77`) e trata os pedidos `link` e `ofertas` (`:79-97`, `:117-121`). O `manifest.json` só tem permissão para `*.mercadolivre.com.br` e para o localhost.
- `src/server.js`: `criarServicos` cria a Amazon e o agendador (`:41-45`). A CSP está em `:32`. `ctx` em `:485`. `src/scheduler.js:37-45` repassa `amazon` a `createEnvios` e `createEspelho`.
- `src/espelho.js` é todo Amazon: coluna `asin`, guarda pela `tag`, `urlDoAsin` e `identificar(url)?.id !== 'amazon'` (`:225`, `:918`).
- Testes que hoje usam a Shopee como loja não conectada: `test/envios.test.js:32-33`, `:181-203` e `:561`; `test/conexoes.test.js:112-117`, `:139` e `:279-283`; `test/lojas.test.js:38` e `:55`.
- O trabalho do espelhamento da Amazon está **sem commit** (`git status`: `src/amazon.js`, `src/espelho.js`, `public/espelhamento.js`… não rastreados).

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| **Link pela extensão (Link personalizado) e, havendo acesso, pela Open API (escolhida)** | Funciona hoje, sem a API. É o mesmo modelo do `meli.la`, que o dono já usa. O `longLink` permite conferir o ID | Endpoint interno pode mudar sem aviso. Exige o Chrome aberto e logado no portal | Médio, o mesmo do ML |
| Só a Open API | Sem Chrome | Hoje não funciona (10035) | Alto agora |
| Montar à mão `shopee.com.br/...?...utm_source=an_18328801339&utm_medium=affiliates` | Sem Chrome nem API | O link oficial traz também `utm_term` gerado pela plataforma. Não há documento dizendo que o link montado à mão é atribuído, e um link que não paga comissão falha em silêncio | **Rejeitada** |
| Raspar a página do produto para ter os dados | Teria dados sem API | Proibido (pedido do dono). Frágil | Rejeitada |
| **Extrair o resolvedor e o leitor de corpo da Amazon para `src/rede.js` (escolhida)** | Uma só política de SSRF auditada. `test/amazon.test.js` vira rede de proteção | Mexe em `amazon.js` (etapa 5, sem mudar comportamento) | Baixo |
| Copiar o resolvedor para `shopee.js` | Não mexe na Amazon | Duas cópias de código de segurança | Médio |
| **Ramos da Shopee em `envios.js` ao lado dos da Amazon (escolhida)** | Não reabre o código da Amazon recém-testado | Fluxos parecidos repetidos (dívida: na 3ª loja editável, extrair um adaptador) | Baixo |
| Adaptador genérico de "loja editável" agora | Menos repetição | Refatora a Amazon na mesma entrega | Médio |
| **Gerar o link no `criar` e guardar no payload (escolhida)** | Falha na hora, com mensagem, sem gravar nada. O envio não depende de Chrome nem de API no horário agendado | O link fica fixo desde o momento do pedido | Baixo |

## Decisão
1. **`src/rede.js` (novo):** recebe de `amazon.js`, sem mudar o comportamento, `resolverPorRedirecionamento(url, { hosts, extrair(u) → valor|null, paginaSemValor(u) → bool, fetch, cache, agora })` e `lerCorpoLimitado(r, max)`.
   - O resolvedor só usa `GET` com `redirect:'manual'`, cancela o corpo, aceita até 5 saltos, tem timeout de 8 s e só segue `https` sem porta e sem credenciais.
   - Cache com falha passageira fora do cache e junção de pedidos simultâneos, como já faz a Amazon.
   - Erro: `{ causa: 'invalido'|'nao_produto' }`, e cada loja embrulha na sua classe com as suas frases.
   - `tituloDeUmaLinha(v, max)` vai para `src/titulo.js`.
2. **`src/shopee.js` (novo).**
   - Funções sem rede:
     - `extrairIds(url)`: casa `/-i\.(\d{1,20})\.(\d{1,20})\/?$/` ou `^/(universal-link/)?product/(\d{1,20})/(\d{1,20})/?$` no `pathname` de `shopee.com.br` e subdomínios. Devolve `{ shopId, itemId, urlProduto }`, em que `urlProduto = https://shopee.com.br + pathname`, sem query e sem fragmento: é o mesmo formato do teste real da referência.
     - `HOSTS_SHOPEE`.
     - `IMAGEM_SHOPEE = /^https:\/\/(([\w-]+\.)+susercontent\.com|cf\.shopee\.com\.br)\//i` (os hosts não estão verificados: ver Riscos).
     - `LINK_SHOPEE = /^https:\/\/s\.shopee\.com\.br\/[A-Za-z0-9_-]{3,40}$/`.
     - `afiliadoDoLongLink(url)`: o `an_<dígitos>` de `utm_source`, ou `null`.
   - `createShopee({ db, fetch, agora, lerConexao })` → `{ resolver(url), lerItem(shopId, itemId), gerarLink(urlProduto), testar(), situacao(), configurado(), apiUtil(), invalidar() }`.
     - Credenciais lidas a cada chamada (`segredosDe(db,'shopee')`): `app_id` e `chave`.
     - Uma chamada é `POST https://open-api.affiliate.shopee.com.br/graphql`, com `redirect:'error'`, timeout de 15 s e corpo de no máximo 2 MiB. Cabeçalho: `Authorization: SHA256 Credential=<AppId>, Timestamp=<s>, Signature=<sha256hex(AppId+ts+payload+chave)>`, em que `payload` é a string exata do corpo.
     - `lerItem`: `productOfferV2(itemId:<d>, shopId:<d>, limit:1){ nodes { itemId productName priceMin priceMax priceDiscountRate sales ratingStar imageUrl shopName } }`. Os IDs só entram depois de validados como dígitos.
     - O nó vira a oferta `{ key:'SHOPEE:<shop>.<item>', shopId, itemId, title, price:Number(priceMin), oldPrice:null, discountPct:(1..99|0), sold, image (só IMAGEM_SHOPEE), freeShipping:false, coupon:null, extra:{ loja_nome (≤80), nota (0–5), preco_max } }`. Sem nó igual a `itemId`, devolve `null`.
     - Cache de 15 min por item. Sem fila, porque o limite é de 8000/h e o volume é manual.
     - `gerarLink`: `mutation{ generateShortLink(input:{ originUrl:<JSON.stringify(urlProduto)> }){ shortLink } }`. O `shortLink` precisa passar em `LINK_SHOPEE`; se não passar, a falha é `indisponivel`.
     - `ErroShopee { tipo }` com mensagem fixa por tipo:
       - `sem_credenciais`
       - `credencial_recusada`: 10020
       - `conta_restrita`: 10031–10034 e 11002
       - `sem_acesso`: 10035
       - `cota`: 10030 e HTTP 429
       - `nao_encontrado`
       - `indisponivel`: rede, 5xx, JSON inválido e 11000/11001
     - O código sai de `errors[0].extensions.code` (formato não verificado: o parser é tolerante, e código desconhecido vira `indisponivel`).
     - `situacao()` segue o modelo da Amazon (`acesso`, `verificado_em`, `motivo`), com impressão das credenciais.
     - `apiUtil()` = `configurado()` e `acesso ∉ {sem_acesso, credencial_recusada, conta_restrita}`.
     - `testar()`: `productOfferV2(keyword:"celular", limit:1)`. Resultados: `ok`, `nao_configurada`, `recusada`, `sem_acesso`, `conta_restrita`, `cota` e `indisponivel`, com `campos` iguais aos que vieram.
3. **Link pela extensão.**
   - `src/links.js`: `requestLinkShopee({ url, timeoutMs })`. No modo `fake`, devolve `{ link:'https://s.shopee.com.br/fake<n>', longo:null }`. Fora dele, vai sempre à extensão (o modo `direct` do ML **não** vale para a Shopee: ela nunca sai sem afiliado).
   - O pedido tem `type:'link_shopee'`. Em `submit`, a validação depende do tipo: `link_shopee` exige `LINK_SHOPEE` e `longo` opcional (https, host da Shopee, ≤ 2048). Os outros tipos ficam como hoje.
   - `extension/background.js`:
     - Recusa job com `url` que não seja `https://shopee.com.br/…`.
     - Usa a aba `https://affiliate.shopee.com.br/offer/custom_link`, a que estiver aberta ou uma nova, fixada e em segundo plano.
     - Roda dentro dela o `fetch` do contrato capturado (`POST /api/v3/gql?q=batchCustomLink`, `credentials:'include'`, `operationName: batchGetCustomLink`, `variables:{ linkParams:[{ originalLink }], sourceCaller:'CUSTOM_LINK_CALLER' }`, sem `advancedLinkParams`), mais o cabeçalho anti-CSRF se a etapa 3 confirmar que ele é preciso.
     - Com `failCode` diferente de 0 ou sem `shortLink`, o erro é "a Shopee recusou o link (código N)". Com 401/403 ou sem sessão, recarrega uma vez; depois disso, o erro é "não há sessão de afiliado da Shopee neste Chrome".
     - Devolve só `{ link: shortLink, longo: longLink }`.
     - `manifest.json`: `host_permissions` ganha `https://affiliate.shopee.com.br/*`, e a versão vai para 1.3.0.
   - `src/server.js:114` passa também `longo`.
4. **`src/lojas.js`:**
   - A `shopee` passa a `implementada:true`.
   - Campos, nesta ordem:
     - `id_afiliado`: texto, `^[0-9]{5,20}$`, rótulo "ID de afiliado".
     - `app_id`: texto, rótulo "AppID".
     - `chave`: segredo, rótulo "Senha da API".
   - `IMAGENS.shopee = IMAGEM_SHOPEE`.
   - `lerProduto('shopee', url, { shopee })` → ids (`extrairIds` ou `shopee.resolver`) → `shopee.lerItem`. Quando o erro é da API, ele é um `ErroShopee` com `.ids` junto, para quem chama seguir com os campos vazios.
   - `linkAfiliado('shopee', { urlProduto }, { shopee, links, idAfiliado })`:
     - Com `apiUtil()`, tenta `shopee.gerarLink`.
     - Se não houver API, ou se ela falhar, usa `links.requestLinkShopee`. O fallback é inofensivo, porque os dois caminhos geram o link da conta do dono.
     - Se o `longo` tiver `an_<X>` e X ≠ `idAfiliado`, recusa.
     - Devolve o `shortLink`.
5. **`src/conexoes.js`:**
   - `createConexoes({ …, shopee })`.
   - Visão da Shopee: `estado`, `situacao` e `extensao_online` (de `links.status().online`). Os valores de `estado`:
     - `falta_configurar`: sem ID.
     - `so_id`: ID salvo, sem AppID ou sem senha. Os links saem pela extensão.
     - `pronta`: ID e credencial salvos, sem verificação.
     - `conectada`: `acesso` ok.
     - `sem_acesso`: `acesso` em `sem_acesso`.
     - `erro_credencial`: `acesso` em `credencial_recusada` ou `conta_restrita`.
   - Em `salvar('shopee')`, o AppID final igual ao ID final é recusado com 400 "O AppID e o ID de afiliado são números diferentes. Confira os dois no portal da Shopee.". Salvar também chama `shopee.invalidar()`.
   - `testar('shopee')` usa as frases fixas por `resultado`. Com credencial aceita e sem ID, o resultado é `sem_id`.
6. **`src/envios.js`:**
   - `createEnvios({ …, shopee })`.
   - **Identificar (Shopee)** responde `{ loja, motivo:null, editavel:true, produto, causa, extra, link_via:'api'|'extensao'|null, causa_link:null|'sem_id'|'sem_link', pode_disparar, texto, template_id, etiqueta:null }`.
     - O `texto` usa como link de exemplo `https://s.shopee.com.br/(gerado ao disparar)`.
     - Sem credencial, a `causa` é `sem_credenciais` e a API não é chamada.
     - Com link que não leva a produto, a `causa` é `invalido` ou `nao_produto` e o `produto` é `null`.
     - Com `causa` em `nao_encontrado`, `pode_disparar` é `false` (decisão da spec: o produto está fora do programa).
   - **Criar:** confere `id_afiliado` salvo e um caminho para o link, e valida os `ajustes`, como na Amazon. Depois lê os dados, aplica os ajustes (o título é obrigatório) e chama `linkAfiliado`. Tudo isso acontece **antes** do `INSERT`, e qualquer falha devolve 400 sem gravar nada.
     - O payload fica `{ url: urlProduto, loja:'shopee', shop_id, item_id, link_afiliado, fonte_dados:'api'|'manual', upload?, origem:{tipo:'manual'}, offer }`.
   - **Preparar:** exige `LINK_SHOPEE.test(p.link_afiliado)`. Não faz chamada de rede para o link. A foto passa por `imagemPermitida('shopee')`, e o log registra "Enviado com o link de afiliado da Shopee". A Shopee não usa etiqueta.
7. **Ligação:** `criarServicos` cria `shopee`. O agendador repassa `shopee` a `createEnvios` e o expõe. `buildApp({ shopee })` e `ctx.shopee`. A CSP `img-src` ganha `https://*.susercontent.com https://cf.shopee.com.br`.

## Esquema e contratos
Não há tabela nova nem migração. Na tabela `conexoes`, a linha `shopee` fica com `config { id_afiliado, app_id }` e `segredos { chave }`, e o `id_afiliado` novo entra pelo `json_patch` que já existe. As assinaturas e os payloads estão na Decisão (2 a 6). O contrato do endpoint do portal está em `docs/produto/referencias/shopee-api-afiliados.md`, seção "Sem a Open API".

## Etapas
Verificação: `node --disable-warning=ExperimentalWarning --test test/<arquivo>.test.js` e depois `npm test` (linha de base de 03/11: 463 testes, 462 passam, 1 todo). Para arquivos de `public/` e `extension/`: `node --check` e conferência no `npm run simular`. Etapa sensível vai para o `dev` com `model: opus` e passa pelo `seguranca`.

| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 0 | **Pré-requisito.** Commitar o espelhamento da Amazon (a etapa 5 e todas as outras mexem nesses arquivos). O contrato do Link personalizado já está capturado | — | `git status` limpo nesses arquivos e `npm test` verde | lead (com aprovação do dono) | — | não | — |
| 1 | `src/rede.js` (resolvedor e leitor de corpo genéricos); `tituloDeUmaLinha`; `src/shopee.js` completo (decisão 2); registro e ramos da Shopee em `src/lojas.js` (decisão 4). Testes com `fetchFalso`: todos os formatos de URL, código de encurtador sem ids, saltos só por hosts da Shopee; o cabeçalho de assinatura com um vetor fixo, calculado à parte com `crypto`; o parser do nó (`priceMin` em texto, desconto de 0 a 99, `imageUrl` fora do CDN); cada código de erro e o tipo que ele gera; `LINK_SHOPEE` (recusa `s.shopee.com.br.evil.com`, porta, http); `afiliadoDoLongLink`; `testar`; `situacao`; nenhuma mensagem contém a senha nem a assinatura; o `fetch` global não é chamado. `linkAfiliado`: API, extensão, fallback e ID divergente recusado | src/rede.js, src/titulo.js, src/shopee.js, src/lojas.js, test/shopee.test.js, test/lojas.test.js | test/shopee.test.js, test/lojas.test.js | dev (opus) | A | **sim** (segredo, rede, SSRF) | CA1, CA2, CA4, CA6, CA7, CA8 |
| 2 | `src/links.js`: `requestLinkShopee`, `type:'link_shopee'`, validação de `submit` por tipo e modo `fake`. Testes: `link_shopee` com `meli.la` é recusado; o ML com `s.shopee` é recusado; `longo` com outro host é descartado; `fake` gera link sem extensão | src/links.js, test/links.test.js (novo) | test/links.test.js | dev (opus) | A | **sim** (entrada da extensão) | CA4, CA8 |
| 3 | Extensão: o pedido `link_shopee` (decisão 3) e o `manifest`. **Primeiro, confirmar na sessão do dono** se o endpoint exige cabeçalho anti-CSRF (e de onde a página o tira) e registrar o **nome** do cabeçalho, nunca o valor, na referência. Teste manual: com o Chrome logado no portal, um pedido gera `s.shopee.com.br/…`; deslogado, aparece a mensagem de sessão | extension/background.js, extension/manifest.json | `node --check` + teste manual com o dono | dev (opus) | A | **sim** (sessão, cookies) | CA4, CA6 |
| 4 | CSS da spec, só se o `ol` dentro de `.aviso-impl` pedir. Conferir em 375 px e 1280 px | public/style.css | revisão visual | designer | A | não | — |
| 5 | `src/amazon.js` passa a usar `src/rede.js` e `tituloDeUmaLinha`, sem mudar comportamento: `test/amazon.test.js` e `test/qa-espelhamento*.test.js` passam **sem edição** | src/amazon.js | test/amazon.test.js, test/qa-espelhamento-b.test.js | dev (opus) | B | **sim** (SSRF) | CA8 |
| 6 | `src/conexoes.js` (decisão 5). Testes: os 6 estados; `extensao_online`; AppID igual ao ID → 400 sem gravar; `testar` por código (via `createConexoes` com `shopee` falso); a senha nunca aparece no texto cru das respostas; os casos de "não implementada" passam para a Magalu (`:112-117`, `:139`, `:279-283`) | src/conexoes.js, test/conexoes.test.js | test/conexoes.test.js | dev (opus) | B | **sim** (segredo) | CA5, CA6 |
| 7 | `src/envios.js` (decisão 6). Testes com `createShopee` (`fetchFalso`) e o `links` em `fake`/`extension`: Identificar com API ok (CA2); com 10035, campos nulos, `causa:'sem_acesso'`, `link_via:'extensao'` e `pode_disparar` verdadeiro; sem extensão e sem API, `sem_link`; sem ID, `sem_id`; link curto resolvido; `POST /api/envios` → `simulated` com imagem, legenda e `s.shopee.com.br`; ID divergente → 400 e nada gravado; agendado para hoje; o ML e a Amazon iguais. A Shopee sai de `:32-33`, `:181-203` e `:561`, e a Magalu entra no lugar | src/envios.js, test/envios.test.js | test/envios.test.js | dev (opus) | B | **sim** (entrada do painel, rede) | CA2, CA3, CA4, CA9 |
| 8 | Ligação (decisão 7) e `longo` em `/api/ext/result`. Teste de ponta a ponta em `test/servidor.test.js`: `criarServicos` com `fetch` falso, o Identificar da Shopee, a CSP com os hosts novos, `/api/conexoes` sem a senha, e uma volta da extensão (`poll` e `result` com `link` e `longo`) até o `simulated` | src/server.js, src/scheduler.js, test/servidor.test.js | test/servidor.test.js, test/seguranca.test.js | dev (opus) | C | **sim** (CSP, rota da extensão) | CA4, CA6, CA7 |
| 9 | Painel conforme a spec, com as respostas da seção "Alinhamento com a spec". `public/disparos.js`: fluxo da Shopee, `TEXTOS_DISPAROS.shopee`, `descontoInformado`, regex da foto igual a `IMAGEM_SHOPEE`, "Resolvendo…" para os links curtos, `pode_disparar`/`causa_link`. `public/conexoes.js`: tabela por loja, 6 selos, `fieldset`s e aviso de extensão. Testes de funções puras no molde de `test/espelhamento-painel.test.js`. Ajustar `test/conexoes.test.js:672` se a regra da linha de falha passar a valer para a Shopee | public/disparos.js, public/conexoes.js, test/shopee-painel.test.js (novo), test/conexoes.test.js | `node --check` + `npm run simular` + test/shopee-painel.test.js | dev | C | não | CA2, CA3, CA5 |
| 10 | Ajuda: `TIPS`/`AJUDA` da spec (`conexoes.shopee`, `manual.shopee`), as 4 menções "Shopee ainda não" e o glossário | public/ajuda.js | `node --check` + página Ajuda | designer | C | não | — |
| 11 | README: seção Shopee (dois caminhos de link, o que precisa estar aberto, pré-requisitos, recarregar a extensão em `chrome://extensions`) | README.md | leitura | dev | C | não | — |

**Ordem:**
- A: as etapas 1, 2, 3 e 4 rodam em paralelo, sem arquivo em comum.
- Ao fim de A, **falham de propósito** os testes de `test/envios.test.js` e `test/conexoes.test.js` que usam a Shopee como loja não conectada. As etapas 6 e 7 os corrigem.
- B: as etapas 5, 6 e 7 rodam em paralelo.
- C: as etapas 8, 9, 10 e 11 rodam em paralelo. A 9 segue o contrato; até a 8 terminar, a tela mostra o erro do servidor sem quebrar.
- Arquivos em mais de um grupo: `test/conexoes.test.js` (6 → 9) e `src/lojas.js`/`src/shopee.js` (1, depois só lidos).

**Corte:**
- Entrega 1 = este plano.
- Entrega 2 (plano próprio), espelhamento da Shopee: generalizar `espelho_itens.asin` para `loja` + `produto_id` (migração aditiva); usar o leitor de texto (`oferta-texto.js`) como fonte sem API; link pela extensão ou pela API; guarda anti-laço pelo `an_<ID>` do `longLink`.
- Regras automáticas com a Shopee dependem da API (`productOfferV2`/`shopeeOfferV2` como fonte de ofertas) e ficam para depois do acesso liberado.

## Alinhamento com a spec
| Ponto da spec ("A alinhar") | Resposta do plano |
|---|---|
| 1. O link só sai pela API? | **Não.** O link sai **pela extensão do Chrome** (Link personalizado do portal, com a sessão do dono, como o `meli.la`) **ou pela API** (`generateShortLink`), nunca montado à mão. Sem API, os dados ficam em branco e editáveis, **como na Amazon**, e Disparar fica habilitado se `pode_disparar` for verdadeiro (ID salvo e extensão on-line ou API útil). A tabela de estados da seção 2 muda: `sem_credenciais`, `sem_acesso`, `credencial_recusada` e `conta_restrita` passam a ser aviso + "preencha à mão" quando `link_via` não é `null`. Só bloqueiam `invalido`, `nao_produto`, `nao_encontrado`, `causa_link:'sem_id'` e `causa_link:'sem_link'` ("Abra o Chrome com a extensão e entre no portal de afiliados da Shopee, ou ligue a API em Conexões"). Os textos que dizem "sem a API não há link" precisam ser trocados. |
| 2. Preço antigo e desconto | A API só traz `priceDiscountRate`. O servidor manda `oldPrice:null` e `discountPct` inteiro, e não deriva preço antigo. Se o dono mudar o preço, o desconto informado é descartado e recalculado pelos dois preços (`aplicarAjustes`). O template já tira `[ ({DESCONTO_PRODUTO} OFF)]` sozinho. |
| 3. Causas | Os nomes da spec ficam: `invalido`, `nao_produto`, `nao_encontrado`, `sem_credenciais`, `sem_acesso`, `credencial_recusada`, `conta_restrita`, `cota`, `indisponivel`. `sem_id` e `sem_link` vêm em `causa_link`, separadas da causa dos dados. Não existe `link_gerado` (o link é gerado no Disparar): no lugar dele vão `link_via` e `pode_disparar`. |
| 4. Estados e teste | Os 6 estados da spec ficam, mais `extensao_online`. `so_id` **deixa de ser só espera**: com a extensão, já dá para disparar. Resultados do teste: `ok`, `nao_configurada`, `recusada`, `sem_acesso`, `conta_restrita`, `cota`, `indisponivel` e `sem_id`. O 11002 entra em `conta_restrita`. AppID igual ao ID **bloqueia** no servidor (400), não é só aviso. |
| 5. Campos | `id_afiliado` (texto, `^[0-9]{5,20}$`, tamanho variável), `app_id` (texto, `^[0-9]{1,20}$`), `chave` (segredo, `^[!-~]{8,128}$`). Os limites saem em `GET /api/conexoes → campos`. |
| 6. Produto fora do programa e link do formulário | `nao_encontrado` = a API não devolve o nó. Premissa: o produto está fora do programa, e Disparar fica bloqueado. Linkar também o formulário de atendimento da referência no passo 1 (a página `open_api` está com "Aplicar" desabilitado para esta conta). |
| 7. Dados ao navegador | `produto` (os campos da oferta) e `extra:{ loja_nome, nota, preco_max }`. A foto vem só do CDN da lista (`*.susercontent.com`, `cf.shopee.com.br`, a confirmar com a primeira resposta real). |
| 8. Sub IDs | Não entram nesta entrega (o formato de `advancedLinkParams` não foi capturado). |
| 9. Contador de 8000/h | Não haverá contador. Cache de 15 min por produto; 10030 vira `cota`. |
| Extensão (novo) | O cartão mostra se a extensão está on-line (`extensao_online`) e o texto "os links da Shopee saem pela extensão do Chrome logada no portal de afiliados". O `select` de etiquetas some, como na Amazon. |

## Pontos para o seguranca
- **Segredo (etapas 1, 6, 8):** a `chave` só é lida dentro de `shopee.js` na hora da chamada. A assinatura nunca é guardada nem registrada. `ErroShopee` tem mensagem fixa e nunca carrega o corpo da resposta. Nenhuma resposta do painel leva a `chave`, e o teste da etapa 6 varre o texto cru.
- **Injeção em GraphQL (1):** IDs só como dígitos validados; a `originUrl` é montada pelo servidor a partir de um `pathname` já normalizado e vai com `JSON.stringify`.
- **SSRF (1, 5):** o resolvedor só segue hosts da Shopee, por `GET` sem ler o corpo, com 5 saltos e 8 s. A API só fala com o host fixo, com `redirect:'error'`. O Baileys só baixa a foto se ela passar em `IMAGEM_SHOPEE`.
- **Link vindo de fora (2, 3, 7):** o `shortLink`, venha da extensão ou da API, precisa passar em `LINK_SHOPEE` no servidor, no `submit` e de novo no `preparar`. O `longo` só serve para conferir o ID. Quem tiver o `ext_token` não consegue fazer o programa publicar outra URL.
- **Sessão do portal (3):** cookies e o token anti-CSRF não saem do navegador; a extensão devolve só os dois links. A extensão recusa job com `url` fora de `https://shopee.com.br/`. A permissão nova vale só para `affiliate.shopee.com.br`.
- **Autorização:** `PUT`/`testar` de Conexões continuam `soDono`. O Identificar e os envios ficam como hoje (qualquer pessoa logada).
- **CSP (8):** `img-src` ganha só os dois hosts. Nenhum `connect-src` novo.

## Riscos e como reverter
- **O endpoint interno do portal muda ou passa a exigir outro cabeçalho:** o erro aparece no Disparar (falha antes de gravar). Com a API liberada, o link sai por ela. Reverter: a extensão volta à 1.2.1 e a Shopee volta a `implementada:false` em `lojas.js` (uma linha). Não há migração.
- **O formato do erro da Open API e os campos do nó não estão verificados (a conta ainda não tem acesso):** o parser é tolerante, o "Testar" mostra os `campos` que vieram e o dev confere no explorador quando o acesso sair.
- **Host da foto diferente do previsto:** a foto vira `null` e a mensagem sai sem foto. Corrigir a regex em `IMAGEM_SHOPEE`, na regex da etapa 9 e na CSP (as três juntas).
- **`s.shopee.com.br` responder sem 30x:** o link curto colado dá `invalido`, e o dono cola o link longo. Não lemos HTML.
- **Chrome logado em outra conta:** a conferência pelo `longLink` recusa. Se o `longLink` vier sem `an_`, não há como conferir; premissa: aceita.
- **Refatoração da Amazon (5):** os testes existentes passam sem edição. Se não passarem, a etapa 5 é descartada e o `amazon.js` fica como está (a 1 não depende dela).

## Perguntas em aberto e premissas adotadas
**Perguntas para o dono:**
1. O link deve ir pela API sempre que ela funcionar, com a extensão como reserva (premissa), ou sempre pela extensão?
2. Produto que a API diz "não encontrado": bloquear o Disparar (premissa, segue a spec) ou deixar sair pela extensão mesmo assim?
3. Entrega 2 (espelhamento da Shopee, inclusive sem API, pelo texto da origem e pela extensão): segue logo depois desta?

**Premissas:**
- Preço = `priceMin`. Não derivamos preço antigo. O desconto vem da Shopee até o dono mudar o preço.
- O modo direto (Ajustes) vale só para o ML. A Shopee nunca sai sem afiliado.
- O link é gerado no criar, inclusive para o agendado.
- Sem Sub_id.
- Sem fila de chamadas para a API.
- O ID de afiliado é obrigatório para disparar, e AppID igual ao ID é erro.
- `nao_encontrado` bloqueia.

## Pré-requisitos do dono
1. **Agora:** em Conexões → Shopee, preencher o **ID de afiliado** `18328801339` (não é o AppID nem a tag da Amazon).
2. **Recarregar a extensão** em `chrome://extensions` depois da etapa 3 (permissão nova para `affiliate.shopee.com.br`) e deixar o Chrome **logado no portal de afiliados da Shopee**.
3. **Quando a Shopee liberar a API:** copiar o **AppID** e a **Senha** da página "Abrir API" do portal para Conexões → Shopee → Salvar → **Testar**. O teste mostra se a credencial foi aceita e se a conta tem acesso.
4. Para conferir o resolvedor, mandar ao lead um link curto `s.shopee.com.br/…` e um `shp.ee/…` reais, de qualquer produto.

## ADR
**ADR-003: Shopee com link de afiliado só por canal oficial do dono (Link personalizado pela extensão ou Open API), dados pela Open API ou à mão, e a política de rede compartilhada com a Amazon.**
- **Contexto.** A conta ainda não tem acesso à Open API (10035). O portal converte links com a sessão do navegador, como a Central do ML. Montar o link à mão não tem atribuição documentada. Raspar HTML é proibido.
- **Decisão.** Por ordem:
  - `src/shopee.js` é o cliente da Open API (assinatura SHA256, `productOfferV2`, `generateShortLink`).
  - A extensão ganha o pedido `link_shopee` (endpoint `batchCustomLink`).
  - `lojas.linkAfiliado('shopee')` usa a API quando ela está útil e a extensão como reserva, e confere o ID pelo `longLink`.
  - O link é gerado ao criar o envio e guardado no payload.
  - Sem API, os dados são editados à mão, como na Amazon.
  - Resolvedor e leitor de corpo vão para `src/rede.js`, usados pela Amazon e pela Shopee.
- **Consequências.** A Shopee funciona hoje, sem a API, desde que o Chrome esteja aberto e logado. Quando o acesso sair, ela ganha dados automáticos e deixa de depender do Chrome. O endpoint interno pode mudar, com o mesmo risco que já aceitamos no ML. O `envios.js` tem dois ramos de "loja editável": a terceira loja pede um adaptador.

## Decisões do dono (03/11/2026)
- Plano e spec aprovados para implementação.
- Com a API liberada, o link sai **pela API primeiro**, com a extensão de reserva (premissa confirmada).
- `nao_encontrado` (a API não devolve o produto: fora do programa de afiliados) **bloqueia** o Disparar (premissa confirmada).
- Etapa 0 cumprida: espelhamento da Amazon commitado em `3cb632c` e enviado ao GitHub.
