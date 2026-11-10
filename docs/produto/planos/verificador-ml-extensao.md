# Plano técnico: Verificador, entrega 2 — preço e estoque do Mercado Livre pela extensão do Chrome
- Brief: sem brief. Cartão do Trello "07 · Verificador", entrega 2 (pedido do lead, rodada 1). Base: docs/produto/planos/verificador-preco-estoque.md (ADR-010, abordagem C adiada)
- Data: 2026-11-09
- Ramo: `feat/verificador-extensao` (worktree `achadinho_turbo-wt-vext`, a partir de db59c35)

## Objetivo e critérios de aceite
Fazer a conferência do Mercado Livre funcionar em produção. A leitura passa a ser feita pela extensão do Chrome, com a sessão do navegador, porque a leitura pelo servidor é barrada.

Evidência do lead em 2026-11-09, só leitura: a página do produto responde 302 para `/gz/account-verification` e `api.mercadolibre.com/items` responde 403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES`.

- CA1 — No modo de link `extension`, toda conferência de oferta do ML lê preço e estoque pela extensão. Vale para todas as origens que já passam pelo verificador (regras, fila, Catálogo). Nesse modo, o servidor não pede a página nem a API do ML.
- CA2 — A leitura pela extensão segue as mesmas regras de hoje (D4 e D5 do plano anterior):
  - esgotado só com o enum do JSON-LD (`OutOfStock|SoldOut|Discontinued`);
  - preço comparado com o limite;
  - sem preço = sem conferência (`sem_preco`).
- CA3 — Página de verificação (redirecionamento para `account-verification`, `/gz/` ou captcha, HTTP 403 ou 429) vira "sem conferência", com a causa "o Mercado Livre pediu verificação no navegador".
  - A extensão não abre aba, não navega, não tenta de novo e não resolve CAPTCHA.
  - O servidor para de pedir conferências do ML por 30 min.
- CA4 — Extensão desconectada, antiga (sem o recurso), sem resposta ou com erro → "sem conferência", cada caso com a sua causa. Vale a regra dos 30 min (D3 do plano anterior). Nada vai ao Histórico com nível `erro`.
- CA5 — Prazos e fila:
  - o pedido de produto leva no máximo 15 s na extensão, e o servidor desiste em 18 s, abaixo dos 20 s do verificador;
  - pedidos de link (ML e Shopee) e de lista nunca esperam atrás de um pedido de produto parado na fila.
- CA6 — No máximo 120 conferências do ML por hora pela extensão. Passou disso → sem conferência, com a causa de limite, e nenhum pedido vai à extensão.
- CA7 — Só dados estruturados voltam da extensão: nunca o HTML, cookies ou o endereço final.
  - `estado` e até 5 ofertas, uma por bloco JSON-LD. Produto simples: `{ nome: boolean, price, availability }`. Página de catálogo (`ProductGroup`, sem `offers` no topo): `{ nome: boolean, variantes: [até 30 × { sku, nome: boolean, price, availability }] }`.
  - A extensão não escolhe a variante. O servidor a escolhe pelo `sku` igual ao item do anúncio do link (`pdp_filters` `item_id:` ou o `MLB` do caminho). Sem item, ou sem variante do anúncio, o grupo não informa preço nem estoque: nunca vale o preço de outra variante (outra voltagem, outra cor).
  - A extensão só busca `https://*.mercadolivre.com.br` em forma canônica.
  - O servidor valida tudo.
  - O manifest não ganha permissão nova e passa à versão 1.5.0.
  - A extensão 1.4.2 nunca recebe o pedido novo.
- CA8 — Os modos `direct` e `fake` e o `DRY_RUN` funcionam como hoje. Os testes não acessam a rede (`fetch` bloqueado). README, Docs, `TIPS`, `CAUSAS` e `FATOS` acompanham a mudança. `npm test` termina sem falha nova.

## Contexto atual
- **Leitor do ML hoje.** `conferirProduto` (src/ml.js:408-422) lê a API e depois a página pelo servidor. O parser de JSON-LD está em `blocosJsonLd`/`produtosJsonLd`/`disponivelJsonLd`/`lerHtmlProduto` (src/ml.js:182-264), e `num` em src/ml.js:34.
- **Verificador.**
  - Lê o ML por `ml.conferirProduto(oferta.url)` (src/verificador.js:209-212), com corrida de 20 s (`TEMPO_MAX_MS`, :48 e :234-243).
  - `CAUSAS` tem 7 frases (:58-66), fixadas em test/docs.test.js:1502.
  - `podeConferir('mercadolivre')` é sempre `true` (:202).
- **Fiação.** `criarServicos` cria o verificador sem `links` (src/server.js:84). O main usa `getMode` `fake` em `DRY_RUN`; fora dele vale `settings.link_mode` (src/server.js:766).
- **Fila da extensão** (src/links.js):
  - `ask` faz FIFO, rejeita se `!online()` e tem timeout que tira o pedido da fila (:94-107);
  - `poll` (:147) e `submit` por tipo (:175-191);
  - teto/hora da Shopee como modelo (:43-45, :81-85, :134-135);
  - `lastError`/`lastOkAt` alimentam o selo de Conexões (public/conexoes.js:185-192).
- **Rotas da extensão.** `GET /api/ext/poll` chama `links.poll(20000)` sem ler cabeçalho (src/server.js:173-176). `POST /api/ext/result` repassa `data` (src/server.js:179-182), com `jsonGrande` de 5 MB (:113).
- **Extensão** (extension/background.js):
  - laço serial de um pedido por vez (:370-408), poll só com `x-token` (:379);
  - `executar` cai em `gerarLink` para qualquer tipo desconhecido (:364-368): a 1.4.2 trataria um `produto_ml` como pedido de link sem etiqueta;
  - teto por pedido de 80 s/55 s com `comPrazo` (:17-19, :61-65, :388-401), e o estouro marca `centralTravada` para todo tipo que não é Shopee (:397);
  - trecho puro da Shopee com marcadores (:151, :284), testado por extração em test/extensao-shopee.test.js:17-19;
  - o console é proibido (test/extensao-shopee.test.js, "background.js não escreve no console").
- **Manifest.** 1.4.2, já com `https://*.mercadolivre.com.br/*` em `host_permissions` (extension/manifest.json:3, :11-16), fixado em test/extensao-shopee.test.js:477-482.
- **Testes do verificador.** Usam `getMode: () => 'fake'` (test/verificador-*.test.js, test/qa-verificador.test.js). O caminho pelo servidor continua coberto sem mudança.

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| **A. `fetch` no service worker da extensão (`credentials: 'include'`), extrair o JSON-LD por varredura de texto e devolver só `{ estado, ofertas }` (escolhida)** | Sem aba, sem histórico do navegador, sem permissão nova; TLS e cookies do Chrome real; 1 pedido por conferência | O SW não tem DOM (varredura de texto, cópia de `blocosJsonLd`); `Sec-Fetch-Mode: cors` difere de uma navegação (não verificado se o anti-robô liga) | Médio |
| B. Aba fixada que navega até o produto + `executeScript` lendo o DOM | É uma navegação real (roda desafios de JS) | Página pesada (o `complete` pode passar de 15 s), aba se mexendo à vista do dono, produto vai ao histórico e às recomendações, ciclo de vida de aba | Médio-alto |
| C. `executeScript` na aba da Central com `fetch` à página | Reusa a aba | `produto.mercadolivre.com.br` é outra origem: CORS barra; só serviria para `/p/` | Alto |

A é o mais simples e cobre os CAs. Se a prova real mostrar a causa de verificação também no navegador, B vira a entrega 3 (ver Riscos).

## Decisão
- **D1 — Como a extensão lê.**
  - Pedido `produto_ml`: `fetch(url, { credentials: 'include', redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(12000) })` no service worker, sem cabeçalho forjado.
  - Antes de buscar, `urlProdutoML(url)`: https, host `mercadolivre.com.br` ou `*.mercadolivre.com.br`, sem porta, credenciais nem `#`, até 2048 caracteres, forma canônica (`u.href === v`).
  - Depois, `estadoDaResposta(status, r.url)`:
    - host final fora de `*.mercadolivre.com.br`, caminho com `/gz/`, `account-verification` ou `captcha`, ou HTTP 403/429 → `{ estado: 'verificacao' }`;
    - outro não-2xx → erro "a página do produto respondeu HTTP N";
    - 2xx → corpo lido com teto de 3 MB (pelo `content-length` e contando o que chega) → `ofertasDoHtml(html)` → `{ estado: 'lido', ofertas }`.
  - O `fetch` leva `cache: 'no-store'`: preço e estoque nunca vêm do cache HTTP do Chrome.
  - `ofertasDoHtml` é a mesma varredura linear de `blocosJsonLd` (512/50). Para cada bloco, no máximo 5 itens no total:
    - se há um nó `ProductGroup` (página de catálogo real: ofertas em `hasVariant`, sem `offers` no topo): `{ nome: boolean, variantes: [até 30 × { sku: string(≤30)|null, nome: boolean, price, availability }] }`;
    - senão, o primeiro nó `Product` e a primeira `offers`: `{ nome: boolean, price: number|string(≤30)|null, availability: string(≤100)|null }`.
  - A extensão não escolhe a variante nem lê o endereço: isso é do servidor (D4).
  - Nunca: abrir aba, navegar, repetir, ler cookie ou devolver HTML ou URL.
- **D2 — Tipo novo na mesma fila, sem atrasar links.**
  - `links.requestProduto({ url, timeoutMs = PRAZO_PRODUTO_MS })` → `ask({ type: 'produto_ml', url })`.
  - No `ask`, o pedido de outro tipo entra na fila antes do primeiro `produto_ml` que ainda espera. O `produto_ml` entra no fim.
  - Um link espera no máximo o produto que já está na extensão (até 15 s, dentro dos 90 s dele).
  - Na extensão, `executar` atende `produto_ml` e passa a recusar tipo desconhecido ("pedido desconhecido") em vez de cair em `gerarLink`.
- **D3 — Prazos.**
  - Extensão: `fetch` com 12 s (inclui o corpo) e teto do pedido `TETO_PRODUTO = 15000`. O estouro do produto não marca `centralTravada`.
  - Servidor: `PRAZO_PRODUTO_MS = 18000`; o pedido sai da fila (comportamento do `ask`).
  - Verificador: corrida de 20 s inalterada, só a defesa final.
  - Pedido na fila que não sai em 18 s (a extensão ocupada com um link de até 80 s) → "demorou".
- **D4 — Como o servidor espera.** `requestProduto` nunca rejeita. Devolve `{ price, disponivel }` ou `{ falha }`, com `falha` em `'desconectada'|'antiga'|'verificacao'|'limite'|'tempo'|'erro'`.
  - `submit` com tipo `produto_ml` valida `data` por `ml.lerProdutoDaExtensao(data, { url })`, com a `url` do pedido (a extensão nunca devolve endereço):
    - `{ price, disponivel }` com a mesma escolha de `lerHtmlProduto`: preço da primeira oferta com `nome` e `num(price)` > 0; disponibilidade dela ou, sem ela, a primeira válida por `disponivelJsonLd`. Num `ProductGroup`, a oferta é a variante cujo `sku` é o item do anúncio (`itemDoAnuncio(url)`). Sem item no link, vale a variante única do grupo (com ou sem `sku`); com item, a de `sku` igual ou, se o grupo tem uma variante só e ela não tem `sku`, essa. Fora disso, o grupo não dá preço a nenhuma oferta (`varianteDoAnuncio`, src/ml.js; regra real conferida na rodada 1, achado R2);
    - rodada 1, achado R1 (decisão do lead): sem item no link e com várias variantes, o primeiro grupo vira o resumo delas com `varias: true`, se nenhuma outra oferta trouxe preço: todas esgotadas → `disponivel: false`; todas à venda e com preço → o menor preço; senão nada. O verificador só descarta com isso (esgotado, ou o menor preço acima do limite); senão, sem conferência com a causa `varias_versoes`. Com 30 variantes na resposta da extensão (pode ter cortado), o resumo não informa nada. O mesmo resumo vale em `conferirProduto` (modo `direct`). O anúncio que a oferta conhece (o `metadata.id` da Central, o `item_id` do payload) vai no pedido como `pdp_filters=item_id:` num catálogo sem filtro;
    - `{ bloqueado: true }` para `estado: 'verificacao'`;
    - `null` para formato inválido → falha `'erro'`.
  - O `ok:false` da extensão também é falha `'erro'`.
  - O pedido de produto nunca mexe em `lastError`/`lastOkAt` (o selo de Conexões é dos links).
- **D5 — O servidor não tenta a leitura própria no modo `extension`.** Ela é barrada em produção (evidência acima), e cada tentativa sai do mesmo IP do navegador do dono e soma pontos no anti-robô. No modo `direct` (sem extensão) e nos testes, `ml.conferirProduto` continua igual. Em `DRY_RUN`, o verificador simulado não lê nada.
- **D6 — Extensão desconectada ou antiga.**
  - Desconectada (`!online()`) → falha `'desconectada'`, sem fila.
  - A 1.5.0 manda `x-recursos: produto_ml` no poll. `links.poll(waitMs, { recursos })` guarda o último conjunto, aceitando só nomes conhecidos e cabeçalho de até 200 caracteres.
  - Sem `produto_ml` no último poll → falha `'antiga'`, sem fila. Assim a 1.4.2 nunca recebe o pedido (CA7).
  - Nos dois casos vale a regra dos 30 min. A Central sai com " · preço não conferido (…)" se o link puder ser gerado.
- **D7 — Proteção da sessão do dono.**
  - Pausa: depois de `{ bloqueado }`, `requestProduto` responde `'verificacao'` sem fila por `PAUSA_VERIFICACAO_MIN = 30`.
  - Teto: `LIMITE_PRODUTO_HORA = 120` pedidos entregues à fila por hora (janela como `vagasShopee`); passou → `'limite'`. Off-line, antiga e pausa não contam.

  Por quê: a mesma sessão gera os `meli.la`, e sessão marcada pelo anti-robô para o programa inteiro. O teto é um cinto a mais; com ~4 regras ele fica folgado.
- **D8 — `CAUSAS` novas** (verificador; texto fixo):
  - `extensao_off`: 'a extensão do Chrome não está conectada';
  - `extensao_antiga`: 'a extensão do Chrome precisa ser recarregada';
  - `ml_verificacao`: 'o Mercado Livre pediu verificação no navegador';
  - `limite_hora`: 'o limite de conferências por hora foi atingido'.

  Mapa: `tempo` → `demorou`, `erro` → `loja_fora`. URL fora de `*.mercadolivre.com.br` → `loja_fora` sem pedido.
- **D9 — Verificador.** `createVerificador({ …, links = null })`. No ML, usa a extensão se `links?.modo() === 'extension'`; senão, `ml.conferirProduto`. `podeConferir('mercadolivre')` segue `true` (desconexão é passageira). `criarServicos` passa `links`.
- **D10 — Manifest 1.5.0**, sem permissão nova: o host do ML já está em `host_permissions`, e o `fetch` do SW com essa permissão leva os cookies (não verificado; ver Premissas).
- **D11 — O que o dono faz:** recarregar a extensão em `chrome://extensions` depois do merge (até lá, Histórico "a extensão do Chrome precisa ser recarregada", igual a hoje em efeito) e manter o Chrome logado no ML. Se aparecer "pediu verificação no navegador", abrir um produto no Chrome e passar pela verificação ele mesmo; o programa nunca faz isso.

## Esquema e contratos
Sem migração e sem tabela.

**Pedido e resposta da extensão:**
- Pedido: `{ id, type: 'produto_ml', url }`.
- Resposta: `{ id, ok: true, data: { estado: 'lido', ofertas: [...] } }`, ou `{ id, ok: true, data: { estado: 'verificacao' } }`, ou `{ id, ok: false, error }`. Cada item de `ofertas` é de um dos dois formatos:
  - `Product`: `{ nome: boolean, price: number|string(≤30)|null, availability: string(≤100)|null }`;
  - `ProductGroup`: `{ nome: boolean, variantes: [1 a 30 × { sku: string(≤30)|null, nome: boolean, price, availability }] }`.

**`src/ml.js`:** `export function lerProdutoDaExtensao(data, { url } = {}) → { price: number|null, disponivel: true|false|null } | { bloqueado: true } | null`.
- `estado` só `lido` ou `verificacao`; nenhuma outra chave é aceita.
- `ofertas` com mais de 5 itens, grupo com 0 ou mais de 30 variantes ou fora do formato → `null`.
- `price` só por `num` (texto) ou número finito, entre 0 e 10.000.000. Número vindo de fora não passa pelo `num` (`num(1e21)` lê "121").
- `url` é o link do pedido: `itemDoAnuncio(url)` escolhe a variante de um `ProductGroup` (`varianteDoAnuncio`, por `sku`).

**`src/links.js`:**
- Exporta `PRAZO_PRODUTO_MS = 18000`, `LIMITE_PRODUTO_HORA = 120` e `PAUSA_VERIFICACAO_MIN = 30`.
- `requestProduto({ url, timeoutMs })` e `poll(waitMs, { recursos } = {})`.
- `status()` sem mudança.

**`src/server.js`:** a rota de poll passa `{ recursos: req.headers['x-recursos'] }`. `criarServicos` chama `createVerificador({ …, links })`.

**`extension/background.js`:**
- Trecho `// ---- Mercado Livre produto: funções puras (início|fim) ----` com `urlProdutoML`, `estadoDaResposta`, `ofertasDoHtml`.
- Funções impuras `lerProdutoML(job, pedido)` e `TETO_PRODUTO`.
- Cabeçalho `x-recursos` no poll.

## Etapas
| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 1 | `lerProdutoDaExtensao` (contrato acima), reusando `num` e `disponivelJsonLd`. Testes: InStock com preço; OutOfStock sem preço; primeira oferta sem `nome` pulada; preço string "89.90"; `verificacao`; `ProductGroup` com `hasVariant` (variante escolhida pelo `sku` do link, nunca a de outro anúncio, grupo sem item ou sem a variante não informa); formatos inválidos (array, 6 ofertas, 31 variantes, `estado` estranho, price objeto, availability gigante) → null; `fetch` global bloqueado | src/ml.js, test/ml-extensao.test.js | `node --disable-warning=ExperimentalWarning --test test/ml-extensao.test.js test/ml-conferir.test.js` | dev | A | sim (entrada externa) | CA2, CA7 |
| 2 | Extensão (D1 a D3, D6, D10).<br>• Trecho puro com marcadores; `lerProdutoML` com `fetch` do SW.<br>• `executar` com `produto_ml` e recusa de tipo desconhecido; `TETO_PRODUTO` 15 s sem marcar `centralTravada`; `x-recursos` no poll.<br>• Manifest 1.5.0 e descrição citando a conferência; assert do manifest atualizado.<br>• Testes por extração e `vm`: URL canônica/porta/host alheio/`mercadolibre.com` recusados; redirecionamento para `/gz/account-verification` → `verificacao` sem segunda chamada nem `chrome.tabs`; 403/429; 500 → `ok:false`; corpo > 3 MB; 60 blocos; teto 15 s com `fetch` pendurado (relógio virtual); tipo `xyz` → `ok:false` sem `executeScript`; resultado sem HTML/URL | extension/background.js, extension/manifest.json, test/extensao-produto.test.js, test/extensao-shopee.test.js | `node --disable-warning=ExperimentalWarning --test test/extensao-produto.test.js test/extensao-shopee.test.js test/extensao-travamento.test.js` | dev | A | sim (extensão, sessão do dono) | CA1, CA3, CA5, CA7 |
| 3 | Fila (D2, D4, D6, D7).<br>• `requestProduto`, prioridade no `ask`, `recursos` no `poll`, `submit` do `produto_ml` sem tocar em `lastError`, pausa e teto.<br>• Rota de poll lê `x-recursos`; `criarServicos` passa `links` ao verificador.<br>• Testes com relógio injetado: off-line → `desconectada` sem fila; poll sem recurso → `antiga`; link pedido depois sai antes do produto que espera; 18 s → `tempo` e o pedido sai da fila; `verificacao` → 30 min sem fila e depois volta; 121º → `limite`; `ok:false`/`data` inválido → `erro`; `lastError` intacto; cabeçalho de 500 caracteres ignorado; `poll` HTTP com `x-recursos` pelo token | src/links.js, src/server.js, test/links-produto.test.js | `node --disable-warning=ExperimentalWarning --test test/links-produto.test.js test/links.test.js test/servidor.test.js test/disparador.test.js test/verificador-servidor.test.js` | dev | B | sim (token, fila da extensão) | CA1, CA3–CA6 |
| 4 | Verificador (D5, D8, D9): `links` em `createVerificador`, ramo do ML pela extensão, mapa falha → `CAUSAS`, 4 causas novas. Testes com `links` falso: modo `extension` não chama `ml.conferirProduto` (espião que lança); cada falha → causa certa e regra dos 30 min (29/31 min); `{ price, disponivel:false }` → esgotado; `direct`/`fake`/sem `links` → `ml.conferirProduto`; simulado não chama `links` | src/verificador.js, test/verificador.test.js | `node --disable-warning=ExperimentalWarning --test test/verificador.test.js test/qa-verificador.test.js test/verificador-envios.test.js test/verificador-regras.test.js` (docs.test.js falha até a etapa 6: contagem de `CAUSAS`) | dev | B | sim (decide o que sai) | CA1–CA4, CA6, CA8 |
| 5 | Ponta a ponta sem rede: `criarServicos({ verificar: true })` com `getMode: 'extension'`, WhatsApp `dryRun`, extensão simulada que faz poll (com `x-recursos`) e responde com o `data` produzido pelas funções puras da extensão (extraídas por marcadores) sobre fixtures HTML (InStock 89,90 / OutOfStock / sem JSON-LD).<br>• Disparo manual agora: sai com `{HORA_PRECO}`, é descartada esgotada, ou sai com "preço não conferido (a página não trouxe o preço)".<br>• Regra da Central com a extensão antiga (sem cabeçalho) → sufixo "a extensão do Chrome precisa ser recarregada" e nenhum `produto_ml` entregue.<br>• Link e produto juntos na fila: o link sai primeiro | test/verificador-ml-extensao.test.js | `node --disable-warning=ExperimentalWarning --test test/verificador-ml-extensao.test.js` | dev | C | não | CA1–CA5, CA8 |
| 6 | Docs.<br>• README: bullet do ML em "Conferência…" (pela extensão, com a sessão; sem ela, sem conferência), lista de causas com as 4 novas, 120/h e pausa de 30 min, parágrafo da versão 1.5.0 em "Extensão do Chrome".<br>• cap-conta (manutencao/verificador: linha do ML na tabela, causas, teto e pausa); cap-referencia (linha `nao_conferido` com as causas); cap-comecar (`extensao`: também confere preço e estoque; recarregar para a 1.5.0); TIP `ajustes.extensao`.<br>• test/docs.test.js: `CAUSAS` 7 → 11; `FATOS` com `LIMITE_PRODUTO_HORA` (120), `PAUSA_VERIFICACAO_MIN` (30), `TETO_PRODUTO` (15 s) e `PRAZO_PRODUTO_MS` (18 s); lista das 11 causas em cada texto; grafia antiga "sem usar a extensão" proibida; o que ainda lê pelo servidor (Identificar e Criar do Disparo manual, modo direct) dito com honestidade | README.md, public/docs/cap-conta.js, public/docs/cap-referencia.js, public/docs/cap-comecar.js, public/ajuda.js, test/docs.test.js | `node --disable-warning=ExperimentalWarning --test test/docs.test.js test/qa.test.js test/qa-docs.test.js` | dev (texto revisado pelo designer) | C | não | CA8 |

Ordem: A (1 e 2, sem arquivo comum) → B (3 e 4, sem arquivo comum; a 4 usa `links` falso) → C (5 e 6) → `npm test` completo pelo lead (linha de base: 2243 testes, 0 falhas reais, 1 TODO). As etapas 1 a 4 vão ao `dev` com `model: opus`.

Depois do merge:
1. O dono recarrega a extensão.
2. O lead confere no Histórico a próxima oferta do ML: linha `ok` sem "preço não conferido" e com `{HORA_PRECO}` preenchido, se o template usa.
3. Se o Histórico mostrar a causa de verificação, ver Riscos.

## Pontos para o seguranca
1. O `fetch` do SW leva os cookies do dono ao ML. Confira:
   - `urlProdutoML` (canônica, só `*.mercadolivre.com.br`) nos dois lados (src/links.js e background.js);
   - o host final conferido depois do redirecionamento;
   - nenhum outro host recebe pedido com credenciais.
2. A resposta personalizada (página logada) nunca sai do SW: só `estado` e até 5 itens (`{ nome: bool, price, availability }` ou `{ nome: bool, variantes: [até 30 × { sku, nome: bool, price, availability }] }`) com tamanho limitado. Nada vai ao console (o teste existente proíbe).
3. `lerProdutoDaExtensao` trata `data` como hostil (formato fixo, tetos, `num`, enum). Nada dele vai ao Histórico além de `brl()` e `CAUSAS`.
4. `x-recursos` só liga uma capacidade e não autoriza nada. A autenticação continua no `x-token` (`extAuth`, src/server.js:164-170). Teto de 200 caracteres; nome desconhecido é ignorado.
5. Anti-robô: o servidor não faz nenhuma tentativa no modo `extension`. A extensão não forja cabeçalho, não repete, não abre aba e não resolve CAPTCHA. Pausa de 30 min e teto de 120/h. Confira se algum caminho pula a pausa (por exemplo, dois pedidos na fila quando chega o `bloqueado`: os que já estão na fila podem sair; aceitável, no máximo alguns).
6. A extensão antiga não pode receber `produto_ml` (gate por recurso), e a nova recusa tipo desconhecido em vez de gerar link sem etiqueta.
7. `requestProduto` nunca rejeita, e os timers são limpos. O estouro do produto não deixa `centralTravada` nem recarrega a aba da Central.

## Riscos e como reverter
- **O `fetch` do SW também cai em `account-verification`** (não verificado, porque depende da sessão real). Efeito: igual a hoje (sem conferência), com a causa clara e 30 min sem pedidos.
  - Próximo passo: abordagem B (aba) como entrega 3, ou o dono passa pela verificação no Chrome.
  - Reverter: nada a fazer; ou desligar o verificador em Ajustes.
- **Os cookies não vão no `fetch` do SW** (regra de SameSite para extensões, não verificado). Efeito: pedido como navegador sem sessão. Pode passar ou cair no item acima, e o tratamento é o mesmo.
- **O anti-robô marca a sessão do dono e os `meli.la` param.** Mitigação D7.
  - Reverter na hora: desligar o verificador em Ajustes (nenhum `produto_ml` sai);
  - de vez: `git revert` do ramo.

  As duas versões convivem: servidor antigo com extensão nova nunca manda `produto_ml`; servidor novo com extensão antiga, idem (gate).
- **Fila mais cheia.** Até 18 s a mais por oferta do ML (antes eram ~1 s de falha rápida). Os links têm prioridade (D2).
- **O JSON-LD da página real não traz `offers`** (premissa herdada, não verificada). Efeito: `sem_preco`, sem descarte falso. O Histórico mostra a causa.
- **Sem migração.** O `git revert` basta. O dono recarrega a extensão anterior só se quiser; a 1.5.0 funciona com o servidor antigo.

## Perguntas em aberto e premissas adotadas
Nenhuma pergunta ao dono: D1 a D11 decidem. Premissas:
- O `fetch` do service worker para um host em `host_permissions` envia os cookies da sessão (Chrome trata como first-party). Não verificado.
- As páginas `produto.mercadolivre.com.br/MLB-…` e `www.mercadolivre.com.br/…/p/MLB…` trazem JSON-LD `Product` com `offers.price` e `offers.availability` (premissa do plano anterior), ou, nas de catálogo, um `ProductGroup` sem `offers` no topo e com as ofertas em `hasVariant[]` (`sku` = item do anúncio). O servidor escolhe a variante pelo link. Não verificado contra a página real logada.
- A página social (meli.la do afiliado) não é lida pela extensão: o `meli.la` não está em `host_permissions` e a URL da oferta já é a do produto. Sem ela, cai em `loja_fora`.
- O Disparo manual "criar" (`resolveOffer` pelo servidor) também é barrado em produção, mas fica fora desta entrega. Candidato a reusar `requestProduto` numa próxima.
- Excesso de engenharia avaliado: o teto de 120/h (D7) é o item mais dispensável. Mantido por custar ~10 linhas no padrão do `vagasShopee` e proteger a sessão que sustenta o programa inteiro.

## ADR
**ADR-011 — Leitura de produto do ML pela extensão do Chrome.**
- **Decisão:**
  - pedido `produto_ml` na fila única da extensão, com prioridade menor que os links;
  - `fetch` no service worker com a sessão e extração do JSON-LD na extensão;
  - só dados estruturados voltam;
  - capacidade anunciada no poll (`x-recursos`);
  - o servidor não lê o ML no modo `extension`;
  - pausa de 30 min após verificação e teto de 120/h.
- **Consequências:**
  - a conferência do ML depende do Chrome aberto;
  - o parser de JSON-LD existe em dois lugares: a cópia da extensão é testada contra as mesmas fixtures do servidor (etapa 5);
  - o dono recarrega a extensão (1.5.0).
- **Rejeitadas:**
  - aba com navegação (B), reservada à entrega 3;
  - `fetch` na página da Central (C, barrado pelo CORS);
  - enviar o HTML ao servidor (vazaria a página logada);
  - driblar o anti-robô no servidor.
