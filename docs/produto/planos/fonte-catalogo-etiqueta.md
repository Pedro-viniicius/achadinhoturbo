# Plano técnico: fonte "catalogo" (API de ofertas do Etiqueta)
- Brief: docs/produto/briefs/fonte-catalogo-etiqueta.md
- Spec (designer, em paralelo): docs/produto/specs/fonte-catalogo-etiqueta.md
- Contrato: ~/Documentos/mensagensParaEnviar/docs/produto/referencias/api-ofertas.md (repositório do Etiqueta: só leitura)
- Data: 2026-11-03. Linha de base: `npm test` → 640 testes, 639 passam, 0 falham, 1 todo.

## Objetivo e critérios de aceite
As regras do Disparo automático ganham a fonte `catalogo`, que lê `GET /api/v1/ofertas` do Etiqueta (servidor local, token lido de arquivo), envia com link de afiliado do dono e manda para revisão o que não dá para provar sozinho. CA1 a CA9 são os do brief, sem mudança de texto:
CA1 fonte catalogo gera candidatos e envia; sem repetição pela chave · CA2 cartão em Conexões (endereço, caminho do token, Testar, estados) e categorias na regra · CA3 cursor (último `proximo` não nulo, vazio não apaga, varredura do zero, `limite=200`, nunca em paralelo) · CA4 link por loja, nenhum link comum · CA5 fotos só dos CDNs das 3 lojas · CA6 catálogo só Amazon/Shopee dispensa etiqueta do ML · CA7 desconto 100% ou preço antigo ≥ 10× vai para revisão · CA8 token fora de log/resposta/URL/erro/console/git; falha = "fonte indisponível" sem derrubar; o front nunca chama o Etiqueta · CA9 texto cru escapado no painel; `npm test` sem rede e sem o token real.

## Contexto atual
- Fontes: `candidatesFor` só conhece `afiliados`, `search` e `list` (`src/ml.js:298-313`); `candidates` intercala até 5 fontes e marca `source_index`/`tag_id` (`src/ml.js:322-340`); `NOME_FONTE` (`src/ml.js:315`). Candidato com `title` e `price` não vai à rede, mas `resolveOffer` recalcula `discountPct` pelo preço antigo (`src/ml.js:254-256`): apagaria o `desconto_pct` da Shopee.
- Regra: `pickOffers` conta toda tentativa em `maxTries` (`src/scheduler.js:64-81`); etiqueta obrigatória (`:99`); link sempre por `links.requestLink` (`:113`); foto só do CDN do ML (`:121`); `sent_offers` gravado se algum grupo recebeu (`:132`); `wasSent` respeita `dedupe_days` e 0 = repete (`:57-61`); `previewOffers` usa o mesmo `pickOffers` (`:144-151`).
- Banco: esquema em `SCHEMA` com `CREATE TABLE IF NOT EXISTS` (`src/db.js:7-98`); `rules.sources` em JSON (`src/db.js:182-189`); `settings` guarda também segredos (`ext_token`, `pseudo_key`).
- Lojas: `LISTA` define o cartão de Conexões e os campos (`src/lojas.js:39-95`); `imagemPermitida(loja, url)` por CDN (`src/lojas.js:144-154`); `linkAfiliado('amazon')` = `amazon.montarLink(asin)`, `/dp/<ASIN>?tag=<tag de Conexões>` (`src/lojas.js:304-316`, `src/amazon.js:456-462`).
- Links: `requestLink` em modo `direct` devolve a URL comum, sem comissão (`src/links.js:88-94`); `links.modo()` existe (`src/links.js:168`). `LINK_SHOPEE` e `IMAGEM_SHOPEE` em `src/shopee.js:58-59`.
- Conexões: `segredosDe` lê config e segredo por campo do registro (`src/conexoes.js:70-81`); `visao` e `testar` têm ramo por loja (`src/conexoes.js:194-227`, `:327-336`); PUT e Testar só do Dono (`src/conexoes.js:362-367`).
- Fila de envios: `preparar('oferta')` já envia Shopee com `payload.link_afiliado` conferido por `LINK_SHOPEE`, Amazon por ASIN e ML por etiqueta (`src/envios.js:662-708`); `origemDoLog` só conhece `espelho` (`src/envios.js:292-298`).
- Revisão existente: o "Completar" do espelho grava `envios` direto (`src/espelho.js:397-408`), valida `ajustes` (`:522-554`) e trava com 409 (`:562-636`). `espelho_itens` é da Amazon (`asin`, `espelho_id`/`origem_jid` NOT NULL, índice único com `msg_id`; `src/db.js:90-97`).
- Servidor: `criarServicos` cria os clientes únicos (`src/server.js:46-52`); `ruleFromBody.tipo()` só aceita 3 tipos (`src/server.js:425`); apagar regra e "Limpar já enviadas" (`:467-473`); módulos montam rotas em `:493`; a CSP já libera os CDNs das 3 lojas (`:35`).
- Painel: `fonteHtml`, `lerFontes` e `resumoFonte` (`public/app.js:185-206`, `:250-257`, `:94-96`); etiqueta padrão obrigatória no formulário (`public/app.js:274`).
- Etiqueta (lido, não alterado): o coletor do ML grava `item_id` `MLB<n>` e `url` `https://produto.mercadolivre.com.br/MLB-<n>` (`mensagensParaEnviar/coletar_ml.js:347,393`); `item_id` pode ser "a própria url" em itens antigos (`servidor.py:76`).

## Abordagens consideradas
Fila de revisão:
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| Reaproveitar `espelho_itens` | uma tabela, uma tela | colunas NOT NULL de espelho, dedupe por `asin`, `expirarFila` com JOIN em `espelhos`: exige reconstruir a tabela (migração destrutiva) e filtrar o catálogo em todo o espelho | alto: regressão no espelhamento |
| **Tabela própria `catalogo_itens` com o contrato do "Completar"** | espelho intocado; o painel reaproveita o dialog; a mesma tabela registra o que já foi tratado (serve ao cursor e à visão Catálogo) | uma tabela e um módulo novos | baixo |
| Sem fila (pular e logar) | trivial | não cumpre CA4 (Shopee) nem CA7 | — |

Modo "Novidades" (ordem `atualizacao` com cursor) com `limite=200` e `per_run` pequeno:
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| Cursor sempre no último `proximo` | literal do contrato | envia 3 de 200 novidades e perde 197 | alto |
| Backlog local de todas as ofertas | cursor literal | guarda cópia velha: item apagado ou com preço mudado no Etiqueta ainda sai (o contrato pede reler) | médio |
| **Cursor avança só sobre página inteira já tratada** | nada se perde; relê o Etiqueta a cada execução; estado mínimo | regra de consumo a testar bem | baixo, com testes |

Cursor: tabela `catalogo_cursores` em vez de `settings`: `settings` guarda segredos e chaves globais; o cursor é estado por regra e precisa sumir com ela (DELETE por `rule_id`, sem prefixo de texto, onde `_` do LIKE é curinga).

## Decisão
- **D1 Módulos.** `src/catalogo.js`: cliente HTTP do Etiqueta, leitura do token, mapeamento oferta → candidato, cursor e candidatos (padrão `src/amazon.js`: `fetch` injetado, frases fixas, sem console). `src/catalogo-itens.js`: tabela `catalogo_itens`, revisão, envio aprovado pela fila de `envios` (padrão do espelho) e rotas.
- **D2 Token.** Lido do arquivo do caminho salvo a cada chamada; nunca em banco, memória duradoura, URL, log ou resposta. Sem caminho salvo: nenhuma leitura e nenhuma rede (nada de caminho padrão no servidor: protege os testes, CA9). Arquivo comum, até 4096 bytes, conteúdo aparado em `^[A-Za-z0-9_-]{32,}$`; fora disso, `arquivo_invalido` sem enviar nada.
- **D3 Endereço só local.** Campo aceita só `^http://(localhost|127\.0\.0\.1):[0-9]{1,5}$`; `fetch` com `redirect:'error'`, timeout 15 s, corpo até 2 MiB (`lerCorpoLimitado`, `src/rede.js:180`), sem `Origin`. Uma fila de promessas no cliente: nunca dois pedidos ao Etiqueta ao mesmo tempo (CA3).
- **D4 Link por loja (CA4).** ML: `item_id` `MLB<n>` vira `https://produto.mercadolivre.com.br/MLB-<n>` e o link sai por `requestLink` com a etiqueta da fonte ou da regra; outro `item_id` é ignorado; em modo `direct` as ofertas do ML do catálogo não saem (seria link comum). Amazon: `item_id` ASIN e link remontado por `montarLink` com a tag de Conexões (ADR-002; ver P1). Shopee: sempre revisão; ao aprovar, sai o `link` do catálogo conferido por `LINK_SHOPEE` (ver P2).
- **D5 Revisão (CA4, CA7).** Vão para `catalogo_itens` com `status='revisao'`: Shopee (`shopee`), `desconto_pct ≥ 100` (`desconto_100`), `preco_antigo ≥ 10 × preco` (`preco_antigo`) e falha de link de um item (`falha_link`). Contam no `per_run`. Teto de 50 pendentes por regra (acima, esperam sem consumir). Loja indisponível no momento (extensão off-line, sem tag da Amazon) não é revisão: a oferta espera.
- **D6 Consumo e cursor (CA3).** "Tratada" na regra = linha em `catalogo_itens` ou em `sent_offers`. Em Novidades, a oferta tratada nunca sai de novo (ignora `dedupe_days`, inclusive 0); nas outras ordens vale `wasSent` (janela) e linha `revisao`/`descartado` bloqueia. O cursor de uma página só avança quando todas as ofertas válidas dela foram tratadas ou recusadas pelos filtros da regra nesta execução; vazio com `proximo:null` não muda nada. Primeira leitura de um filtro (sem cursor): avança até o fim sem enviar (até 20 páginas por execução, `pronto=0` até a página vazia), para "Novidades" não despejar o catálogo antigo (P3). "Reler do começo" = cursor nulo com `pronto=1` (varredura do zero, dedupe pela chave). Cursor recusado (400): volta ao avanço até o fim e registra aviso. Filtro mudou: chave nova, cursor novo.
- **D7 Outras ordens.** Sem cursor: páginas do início (deslocamento) até achar `max(per_run×4, 20)` ofertas não tratadas, no máximo 10 páginas.
- **D8 Etiqueta opcional (CA6).** `precisaEtiqueta(sources)` = alguma fonte não é catálogo, ou é catálogo com `lojas` vazio ou com `ml`. Servidor (agendador) e painel usam a mesma regra.
- **D9 Foto (CA5).** `imagemPermitida(loja, imagem)` no mapeamento e no envio (`loja` padrão `mercadolivre` para as fontes antigas).
- **D10 Painel.** Só fala com `/api/...` do Turbo. Categorias da última verificação guardadas em `settings.catalogo_verificacao` no "Testar"; a regra lê dali, sem chamar o Etiqueta.

## Esquema e contratos
```sql
-- em SCHEMA (src/db.js), não destrutivo
CREATE TABLE IF NOT EXISTS catalogo_itens (
  id INTEGER PRIMARY KEY, rule_id INTEGER NOT NULL, chave TEXT NOT NULL, loja TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('revisao','enviado','descartado')), motivos TEXT NOT NULL DEFAULT '[]',
  oferta TEXT NOT NULL, envio_id INTEGER, criado_em INTEGER NOT NULL, decidido_em INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_item ON catalogo_itens (rule_id, chave);
CREATE INDEX IF NOT EXISTS idx_cat_status ON catalogo_itens (status, rule_id, criado_em);
CREATE TABLE IF NOT EXISTS catalogo_cursores (
  rule_id INTEGER NOT NULL, filtro TEXT NOT NULL, cursor TEXT, pronto INTEGER NOT NULL DEFAULT 0,
  atualizado_em INTEGER, PRIMARY KEY (rule_id, filtro));
```
- `oferta` (JSON): `{ title, price, oldPrice, discountPct, sold, freeShipping, coupon, image, url, asin?, link? (só Shopee), categoria, tag_id, source_index }`. Sem dado pessoal.
- Chave Turbo (cruza com as outras fontes): ML `MLB<n>`, Amazon `ASIN:<ASIN>`, Shopee `SHOPEE:<shop>.<item>` (`item_id` `^\d{1,20}\.\d{1,20}$`). Oferta que não fecha (loja, chave, título, preço > 0, link Shopee fora de `LINK_SHOPEE`) é ignorada e só conta num aviso.
- Fonte na regra: `{ type:'catalogo', tag_id, config:{ categorias:[≤20, 1–200 car., sem repetir], lojas:[subconjunto de amazon|ml|shopee], q:'≤200, ≤10 termos, sem termo vazio', desconto_min: 0–99|null, ordem: atualizacao|relevancia|desconto|menor_preco|maior_preco|cupom|recentes } }`; inválido → 400 com frase fixa (`limparFonteCatalogo`, exportada de `src/catalogo.js`). `filtro` do cursor = sha256 do config normalizado (16 hex).
- `src/catalogo.js`: `createCatalogo({ db, fetch, lerConexao, agora })` → `{ testar(), situacao() → { estado, resultado, verificado_em, falha_desde }, candidatos(cfg, ctx), avancar(ruleId, paginas, tratada), recomecar(ruleId), esquecerRegra(ruleId) }`; puros: `paraCandidato(o)`, `motivosDeRevisao(c)`, `limparFonteCatalogo(c)`, `precisaEtiqueta(sources)`. `ctx` = `{ rule, fonteIndex, quer, tratada(c), paginas: Map }` (vem de `pickOffers` via `ml.candidates`).
- `resultado` do teste e da última chamada: `ok | nao_configurada | sem_arquivo | arquivo_invalido | token_recusado (401) | desligada (503) | fora_do_ar (rede, tempo, 5xx) | resposta_inesperada (400/403/404, JSON fora do contrato, versao ≠ 1)`. `estado` do cartão: `falta_configurar | salva | conectada | token_recusado | indisponivel (desligada, fora_do_ar, resposta_inesperada) | sem_arquivo (sem_arquivo, arquivo_invalido)`.
- `src/catalogo-itens.js`: `createCatalogoItens({ db, wa, links, amazon, envios, acordar })` → `{ tratada(rule, c, modo), registrar(rule, oferta, status, motivos), revisaoCheia(ruleId), listar(filtros), enviar(id, corpo, {userId}), descartar(id), contar() }`.
- Rotas (depois do login e do Host/Origin; Dono e Operador, como o espelho): `GET /api/catalogo/categorias` → `{ categorias:[{nome,total,lojas:{amazon,ml,shopee}}], total, verificado_em, estado }` (sem rede) · `GET /api/catalogo/itens?regra=&status=&limite=` → `{ itens:[{ id, rule_id, regra, loja, status, motivos, oferta:{…, link}, grupos, envio_status, criado_em, decidido_em }], contadores_24h:{ enviadas, descartadas, para_revisar } }` · `POST /api/catalogo/itens/:id/enviar` `{ ajustes:{ title, price, oldPrice, coupon, freeShipping, sem_foto, upload } }` → `{ envio_id }`, 409 "Esta oferta já foi tratada." · `POST /api/catalogo/itens/:id/descartar` → `{ ok }`/409 · `POST /api/rules/:id/catalogo/recomecar` → `{ ok }`. Conexões: `PUT /api/conexoes/catalogo` `{ campos:{ endereco, caminho_token } }` e `POST /api/conexoes/catalogo/testar` → `{ ok, resultado, mensagem, total, categorias }` (só Dono). `/api/state` ganha `catalogo: { estado, para_revisar, falha_desde }`.
- Envio aprovado: linha em `envios` (`tipo 'oferta'`, `quando 'agora'`, grupos e template da regra) com o payload que `preparar` já entende, `origem:{ tipo:'catalogo', rule_id, nome }`; mesma transação marca o item `enviado` com `envio_id` e grava `sent_offers`. ML só com modo `extension`/`fake` e etiqueta; Amazon só com tag salva.

## Etapas
| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 0 | Tabelas `catalogo_itens` e `catalogo_cursores` (com índices) no `SCHEMA`, como em "Esquema e contratos"; teste de que `openDb` cria as duas num banco novo e num banco antigo sem perder dados | `src/db.js`, `test/base.test.js` | `node --disable-warning=ExperimentalWarning --test test/base.test.js` | dev | A0 | sim (migração) | CA1, CA3 |
| 1 | Cliente do Etiqueta: token por arquivo (D2), endereço local (D3), fila única, `testar`/`situacao` com resultados fixos e gravação de `catalogo_verificacao`; `paraCandidato` (chave, URL ML, ASIN, Shopee, foto por CDN, `discountPct` do contrato), `motivosDeRevisao`, `limparFonteCatalogo`, `precisaEtiqueta`; `candidatos` (D6, D7) e `avancar`/`recomecar`/`esquecerRegra` em `catalogo_cursores`. Testes com `fetch` falso e servidor HTTP local em porta aleatória, token em pasta temporária: cabeçalho só `Authorization`, nada de `Origin`; token ausente de URL, erros, console e `log`; 401/503/rede/JSON ruim; vazio com `proximo:null` mantém cursor; 400 de cursor; avanço até o fim; `limite=200`; dois pedidos simultâneos saem em fila | `src/catalogo.js`, `test/catalogo.test.js` | `node --disable-warning=ExperimentalWarning --test test/catalogo.test.js` | dev | A | sim | CA1, CA3, CA4, CA5, CA6, CA7, CA8, CA9 |
| 2 | `src/catalogo-itens.js` (tratada por modo, registrar com upsert, teto de 50, listar com `envio_status`, enviar com trava `BEGIN IMMEDIATE` + 409, ajustes como `src/espelho.js:522-554`, descartar, rotas `/api/catalogo/itens*`); `origemDoLog` com "Catálogo: <regra>". Testes: dois "Enviar" simultâneos geram um envio só; payload por loja passa no `preparar`; Shopee com link fora de `LINK_SHOPEE` recusado; ML em modo `direct` recusado | `src/catalogo-itens.js`, `src/envios.js`, `test/catalogo-itens.test.js` | `node --disable-warning=ExperimentalWarning --test test/catalogo-itens.test.js test/envios.test.js` | dev | A | sim | CA1, CA4, CA7 |
| 3 | Conexão `catalogo` ("Catálogo do Etiqueta") em `LISTA`: campos texto `endereco` (D3) e `caminho_token` (`^(~/|/)[^\u0000-\u001f\u007f]{1,500}$`), `hosts: []`, sem segredo; `visao` com `estado`, `situacao` e categorias da última verificação; `testar('catalogo')` chama `catalogo.testar()`. Ajustar as listas de plataformas dos testes | `src/lojas.js`, `src/conexoes.js`, `test/lojas.test.js`, `test/conexoes.test.js` | `node --disable-warning=ExperimentalWarning --test test/lojas.test.js test/conexoes.test.js` | dev | A | sim | CA2, CA8 |
| 4 | Regra com catálogo: `candidates` passa `rule` e `fonteIndex`; `candidatesFor('catalogo')` delega a `deps.catalogo`; `NOME_FONTE.catalogo`. Em `src/scheduler.js`: `pickOffers(rule, want, ctx)` sem `resolveOffer` e sem `maxTries` para catálogo, pula tratadas, loja indisponível (ML: `links.modo()` `fake` ou `extension` on-line; Amazon: tag) e revisão cheia, guarda recusadas por filtro; `runRule`: etiqueta só se `precisaEtiqueta` (D8), revisão em vez de envio, link por loja (D4) com `falha_link` → revisão, foto por `imagemPermitida` (D9), registro `enviado`, `avancar` no fim; `previewOffers` sem gravar nada e com o motivo de revisão. Testes de regra ponta a ponta com Etiqueta falso | `src/ml.js`, `src/scheduler.js`, `test/catalogo-regras.test.js` | `node --disable-warning=ExperimentalWarning --test test/catalogo-regras.test.js test/disparador.test.js` | dev | B | sim | CA1, CA3, CA4, CA5, CA6, CA7, CA8 |
| 5 | Servidor: `criarServicos` cria `catalogo` (`lerConexao: () => segredosDe(db,'catalogo')`) e `catalogoItens` e passa ao agendador e ao `ctx`; `ruleFromBody` aceita `catalogo` via `limparFonteCatalogo`; apagar regra chama `esquecerRegra`; "Limpar já enviadas" apaga também os `enviado` de `catalogo_itens`; rotas `/api/catalogo/categorias` e `/api/rules/:id/catalogo/recomecar`; `/api/state.catalogo`. Testes: 400 com frases fixas; nenhuma resposta de `/api` contém o token | `src/server.js`, `test/servidor.test.js` | `node --disable-warning=ExperimentalWarning --test test/servidor.test.js && npm test` | dev | B | sim | CA1, CA2, CA3, CA6, CA8 |
| 6 | Cartão "Catálogo do Etiqueta" conforme a spec, seção 1 (campos, Testar, 6 selos, frases por `resultado`, tabela de categorias com `esc()`, Operador travado); `style.css` só se a spec pedir largura total. Funções puras testadas | `public/conexoes.js`, `public/style.css`, `test/catalogo-conexoes-painel.test.js` | `node --disable-warning=ExperimentalWarning --test test/catalogo-conexoes-painel.test.js` + painel em `PORT=3799 DATA_DIR=<tmp> DRY_RUN=1` | dev | C | sim (XSS) | CA2, CA8, CA9 |
| 7 | Fonte "Catálogo" no formulário (spec, seção 2: categorias de `/api/catalogo/categorias`, lojas, filtros, ordens, avisos A1–A4, etiqueta opcional por D8, "Reler do começo"), `resumoFonte`, chips do cartão; Histórico > Catálogo e dialog "Revisar oferta" (spec, seção 3) sobre `/api/catalogo/itens*`, extraindo o miolo comum do "Completar". Teste com texto malicioso em título, categoria e cupom | `public/app.js`, `public/espelhamento.js`, `test/catalogo-painel.test.js` | `node --disable-warning=ExperimentalWarning --test test/catalogo-painel.test.js test/espelhamento-painel.test.js` + painel em DRY_RUN | dev | C | sim (XSS) | CA1, CA2, CA6, CA7, CA9 |
| 8 | Textos: `TIPS`, `AJUDA`, `GLOSSARIO` (spec, "Textos da interface") e seção "Catálogo do Etiqueta" no README (configurar, estados, revisão, Novidades começa do fim, "Reler do começo") | `public/ajuda.js`, `README.md` | `node --check public/ajuda.js && npm test` | dev | C | não | CA2, CA7 |
| 9 | Verificação final pedida pelo dono: subir o código novo em `PORT=3799 DATA_DIR=<tmp> DRY_RUN=1`, salvar endereço e caminho do token no cartão, "Testar" contra o Etiqueta real (só GET) e relatar ofertas por categoria e loja (`GET /api/catalogo/categorias`); conferir que o serviço do dono (porta 3737) subiu com o código novo. Nunca abrir o arquivo do token | — | `curl -s http://127.0.0.1:3799/api/catalogo/categorias` (com sessão, se houver login) | lead | D | não | CA2 |

Grupos: A0 (0) primeiro; A (1, 2, 3) em paralelo, sem arquivo comum; B (4, 5) depois de A, em paralelo; C (6, 7, 8) depois de B, em paralelo; D por último. `npm test` completo ao fechar cada grupo.

## Pontos para o seguranca
- Token: lido só na chamada, nunca em variável de módulo, banco, `settings`, URL, log, console, erro ou resposta; os testes leem token falso de pasta temporária. Conferir `catch` de `fetch` (mensagem do undici) e o `situacao()`.
- SSRF e destino do token: só `http://localhost|127.0.0.1:<porta>`, `redirect:'error'`; validação no PUT e de novo na chamada. O caminho do arquivo é escolha do Dono: formato do token conferido antes de qualquer envio (um arquivo qualquer, como `data/wa_auth/*`, não vira cabeçalho); arquivo não comum ou grande recusado sem bloquear (FIFO).
- Nenhum link comum: ML em modo `direct` não sai; Amazon só com tag; Shopee só `LINK_SHOPEE` e só por revisão; `link` do catálogo nunca vai a `href` sem conferência de host no painel.
- Concorrência: trava do "Enviar" da revisão (`BEGIN IMMEDIATE` + 409); fila única de pedidos ao Etiqueta; cursor escrito só por `runRule` (a trava `running` é por regra).
- XSS: `titulo`, `categoria`, `busca`, `cupom` crus em cartão, tabela, `title`, `aria-label` e dialog; `src` só dos CDNs.
- Operador revisa e envia (como no espelho): confirmar com o dono (P6).

## Riscos e como reverter
- Migração: só `CREATE TABLE/INDEX IF NOT EXISTS`. Reverter o código deixa as tabelas sem uso; `DROP` manual não é necessário (se feito, em migração separada que aborta se houver linhas).
- O serviço do dono reinicia a cada mudança em `src/` (`--watch-path`): entre as etapas 1–5 ele roda código parcial. Mitigação: nenhuma regra usa `catalogo` até a etapa 7; se algo quebrar, `git checkout` do arquivo.
- `localhost` pode resolver para `::1` e o Etiqueta só escuta em `127.0.0.1` (não verificado no Node 22): o "Testar" mostra `fora_do_ar`; o dono troca para `http://127.0.0.1:8765`.
- URL `produto.mercadolivre.com.br/MLB-<n>` aceita pela Central para gerar o meli.la: não verificado (o `MLB` pode ser de catálogo). Falha vai para revisão (`falha_link`); conferir com 1 oferta real antes de ligar regra grande.
- Primeira leitura de um filtro amplo: até 20 páginas (~10 s) por execução, segurando o tick. Teto fixo; reduzir se incomodar.
- Página com oferta que nunca é tratada (loja indisponível para sempre, ex.: modo `direct`) prende o cursor: aviso no Histórico a cada execução; as páginas seguintes continuam sendo lidas até o teto.
- Contrato v1 mudar: `resposta_inesperada`, fonte indisponível, nada enviado.

## Perguntas em aberto e premissas adotadas
- P1 Amazon: o brief diz "link como veio"; o plano remonta `/dp/<ASIN>?tag=<tag de Conexões>` (mesma tag do dono, formato único do Turbo, ADR-002). Exige a tag da Amazon salva. Confirmar.
- P2 Shopee: adotado o CA4 literal (revisão e link do catálogo). Alternativa: gerar o link pela conta do dono (ADR-003, API ou extensão) e dispensar a revisão. Qual?
- P3 Novidades começa do fim (só o que entrar depois de salvar a regra); o catálogo antigo sai pelas outras ordens ou por "Reler do começo". Confirmar.
- P4 Revisão de oferta suspeita permite "Enviar mesmo com 100%" (spec). Confirmar.
- P5 Teto de 50 ofertas pendentes de revisão por regra. Confirmar o número.
- P6 Operador pode revisar e enviar (premissa, igual ao espelho).
- P7 Nome do cartão: "Catálogo do Etiqueta" (spec) ou "Etiqueta" (brief).
- Premissas: Disparo manual não muda; ML com `item_id` que não é `MLB<n>` é ignorado (conta no aviso); categorias atualizam só no "Testar".

## Pré-requisitos do dono
- Etiqueta rodando (`python3 servidor.py`) com `api_token.txt` válido; caminho do arquivo em mãos (não o conteúdo).
- Para Amazon: tag salva em Conexões → Amazon. Para ML: etiqueta cadastrada e extensão do Chrome conectada (modo extensão). Para Shopee: nada além de revisar.
- Responder P1 a P7 antes do grupo B.

## Alinhamento com a spec
1. Fila: tabela própria `catalogo_itens`, rotas `/api/catalogo/itens/:id/enviar|descartar` com o mesmo corpo (`ajustes`, inclusive `upload` e `sem_foto`), o mesmo 409 e a mesma resposta `{ envio_id }` do espelho. A visão Catálogo lista o que passou pelo catálogo: enviadas automaticamente (sem `envio_id`), pela revisão (com `envio_status`), para revisar e descartadas.
2. ML sem extensão: **não** vai para a revisão; espera e sai sozinha quando a extensão volta. O motivo `ml_sem_extensao` não existe; existe `falha_link` (falha de um item) e o envio pela revisão gera o link na hora.
3. "Reler do começo": por regra (todas as fontes catálogo dela), `POST /api/rules/:id/catalogo/recomecar`. Com P3, o texto da ordem Novidades deve dizer que ela começa a contar ao salvar.
4. Categorias: guardadas no "Testar" (`settings.catalogo_verificacao`); `GET /api/catalogo/categorias` não chama o Etiqueta; abrir a regra não atualiza.
5. Estados: os seis da spec. Resultados `desligada` (503) e `fora_do_ar` (rede) são as duas frases de `indisponivel`; `endereco_invalido` é erro de campo do PUT (400), não resultado de teste. O servidor valida endereço (só `http`, porta obrigatória, sem caminho) e caminho (`/` ou `~/`, até 500, sem controle) com a mesma regra do cliente.
6. Contador: `/api/state.catalogo.para_revisar` já existe; o menu é decisão do dono (spec, pergunta 4).
7. Limites do contrato: validados no servidor com 400 e frase fixa; nada do Etiqueta é repassado.
8. Disparo manual: não muda.
9. Motivos vêm do servidor: `shopee`, `desconto_100`, `preco_antigo`, `falha_link` (lista).
10. Link mostrado na revisão: ML = página do produto (`produto.mercadolivre.com.br`, o meli.la nasce no envio), Amazon = `https://www.amazon.com.br/dp/<ASIN>` sem tag, Shopee = `s.shopee.com.br`. A lista de hosts do painel precisa desses três; a dica "link da Amazon como veio" vira "com a sua tag" se P1 for aceita.
11. Chip "Catálogo indisponível": vem de `/api/state.catalogo.falha_desde` (global, não por regra).

## ADR-004: fonte de ofertas pela API local do Etiqueta
- Contexto: o Etiqueta expõe ofertas com link de afiliado em `127.0.0.1:8765`, com Bearer. O Turbo já tem regras com várias fontes e uma fila de envios.
- Decisão: cliente próprio (`src/catalogo.js`) que lê o token do arquivo a cada chamada e só fala com endereço local; mapeia para o formato de candidato do Turbo com a chave de cada loja; Amazon remontada com a tag de Conexões, ML regenerado com a etiqueta, Shopee e preços suspeitos por revisão; tabelas `catalogo_itens` (o que já foi tratado e a revisão) e `catalogo_cursores`; o envio aprovado sai pela fila de `envios`.
- Consequências: nenhum segredo novo no banco; trocar o token no Etiqueta não exige nada no Turbo; o espelho não muda; as tabelas novas crescem com o que é tratado (cerca de `per_run` linhas por execução), sem dado pessoal. Se o Turbo for para uma VPS, esta fonte para de funcionar (o contrato prevê um empurrão HTTPS, fora deste plano).

## Decisões do dono (03/11/2026)
- Plano e spec aprovados para o uso automático. O dono delegou à equipe as perguntas em aberto; ficam as premissas recomendadas:
  - P1: link da Amazon remontado com a tag de Conexões (`montarLink`, ADR-002), não "como veio".
  - P2: Shopee do catálogo sai com o link do catálogo, **só depois de revisão**.
  - P3: "Novidades" começa do fim: a primeira leitura avança o cursor sem enviar.
  - P4: sem "Enviar mesmo com 100%": desconto 100% / preço antigo ≥ 10× só sai depois de revisão, com os preços corrigidos à mão.
  - P5: teto de 50 pendentes por regra.
  - P6: só o Dono revisa e envia.
  - P7: cartão "Catálogo do Etiqueta".
  - P8: oferta do ML com a extensão desligada espera a extensão voltar (não vai à revisão).
- Teste real de conexão (03/11, lead, só leitura): `localhost:8765` respondeu 200 em IPv4; 7.998 ofertas em 4 categorias; `Origin` → 403; token errado → 401; Shopee vem com `preco_antigo: null`.
