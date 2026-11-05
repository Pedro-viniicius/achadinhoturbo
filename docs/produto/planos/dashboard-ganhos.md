# Plano técnico: rastreio por grupo nos links e Dashboard de ganhos
- Brief: docs/produto/briefs/dashboard-ganhos.md
- Data: 2026-11-04
- Onde trabalhar: só em `~/Documentos/achadinhoturbo-ganhos` (ramo `feature/dashboard-ganhos`). Nada em `~/Documentos/achadinhoturbo`.
- Tamanho: denso (18 etapas + catálogo MDD); é feature para duas entregas. **Corte proposto em duas entregas no mesmo ramo:** A = rastreio (cartão 08, etapas 1–10) e B = importador + dashboard (cartão 12, etapas 11–18). A funciona sozinha; B depende de A.

## Objetivo e critérios de aceite
Ligar envio → código de rastreio → comissão por grupo/bloco e mostrar ganho, conversão, cobertura e custo por membro. CA1–CA11: copiados do brief, sem alteração (seção "Critérios de aceite").

## Contexto atual
- Regras: `runRule` gera **um** link por oferta e manda o mesmo texto a todos os grupos (`src/scheduler.js:264`, laço em `:274-286`); Amazon do catálogo: `amazon.montarLink(asin)` (`:115`). Registro: `sent_offers` só por regra+oferta (`:288`); por grupo, só o `log` em texto (`:280`).
- Envios (manual, catálogo, espelho): `preparar` monta **um** `enviar(jid)` por ocorrência (`src/envios.js:666-715`); ML pede o link na hora do envio (`:690`), Amazon monta do ASIN (`:689`), Shopee usa `payload.link_afiliado` gerado no `criar` (`:688`, `:599-630`). Resultado por grupo em `envio_resultados` sem link nem código (`src/db.js:59-61`, `src/envios.js:323`).
- Catálogo: Shopee entra com o link do Etiqueta (`src/catalogo-itens.js:381-384`); grava `envios` direto (`:455`). `createCatalogoItens` recebe `envios` (`:161`). Espelho grava `envios` Amazon (`src/espelho.js:433-443`).
- Amazon: `montarLink(asin)` usa só a tag de Conexões (`src/amazon.js:456-461`); `RE_TAG` em `:87`.
- Shopee API: `gerarLink(urlProduto)` sem `subIds` (`src/shopee.js:399-415`); cache por ID+produto (`:460-482`). Extensão: `corpoLinkShopee` sem `advancedLinkParams` (`extension/background.js:112-118`); formato dos Sub_ids **não capturado** (`docs/produto/referencias/shopee-api-afiliados.md`). Teto 60/h pela extensão (`src/links.js:38-40`, `:106-114`). `lojas.linkAfiliado` Shopee: guardado → API → extensão (`src/lojas.js:293-318`).
- Blocos: `blocks.tag_id` já existe (`src/db.js:35`) mas só pré-preenche a regra no painel (`public/paineis.js:103`, `:127-128`); não muda o link. Rotas de blocos sem `soDono` (`src/server.js:323-345`). Um grupo pode estar em vários blocos (`block_groups`, PK `(block_id, jid)`, `src/db.js:36`).
- Cliques: `link_clicks` são cliques no **rotacionador** (`/g/:slug`), não nos links de oferta (`src/db.js:47`, `src/analytics.js:73`). O Turbo não vê clique em link de afiliado: clique por código só vem do relatório da loja.
- Entradas: `group_events` `action='add'` (`src/analytics.js:141`), apagadas após `retencao_dias` (padrão 90, `src/privacidade.js:11`, `:69-75`).
- Papéis: `soDono` (`src/auth.js:131-135`); sem login no painel, passa. Host/Origin em `/api` (`src/server.js:111-124`). Upload modelo: `express.raw` por rota (`src/envios.js:1188-1190`). Módulos montam rotas por `montarRotas(app, ctx)` (`src/server.js:596-597`).
- Não há `docs/produto/decisoes.md` nem spec deste brief (não verificado se o designer está escrevendo).

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| **Um link por código distinto** (grupos com o mesmo código dividem o link) | Sem associação = 1 link como hoje (CA9); custo = nº de códigos, não de grupos | Mais um laço no envio | Baixo |
| Um link por grupo, sempre | Simples | N pedidos por oferta mesmo sem associação; quebra CA9; come o teto da Shopee | Alto |
| Redirecionador próprio (`/r/:id` → link de afiliado) | Conta clique no Turbo | Depende do PC ligado e do endereço público; o link publicado deixa de ser da loja; se cair, ninguém compra | Alto |

| Importador | Prós | Contras |
|---|---|---|
| **Parser CSV próprio (~100 linhas) + sinônimos de cabeçalho** | Sem dependência; testável; mesma regra para 3 lojas | XLSX fica fora (dono salva como CSV) |
| Biblioteca (csv-parse / xlsx) | Lê XLSX | Dependência nova (`xlsx` tem histórico de CVE); exige aprovação |

## Decisão
D1. Link por **código distinto** entre os grupos de destino; ordem de envio dos grupos não muda. Sem associação, o código padrão (etiqueta da regra/envio, tag padrão da Amazon, Shopee sem Sub_id) gera **um** link, igual a hoje.
D2. Associação explícita em tabela nova `rastreio_codigos` (loja × grupo **ou** bloco → código). Precedência: grupo > bloco (o de menor `id`, se o grupo está em vários) > padrão. `blocks.tag_id` **não** vira associação (mudaria o envio de quem já usa, CA9); a tela oferece "usar a etiqueta do bloco" como atalho (P9).
D3. Código por loja: ML = nome de etiqueta existente em `tags`; Amazon = ID de rastreamento (`RE_TAG` de `src/amazon.js:87`); Shopee = Sub_id1, `^[A-Za-z0-9]{1,30}$` (tamanho máximo **não verificado**, provisório). `UNIQUE(loja, codigo)`: um código aponta para um só alvo.
D4. Falha nunca troca por link comum (CA9): código recusado/falho → link padrão da loja (o de hoje); padrão falhou → erro como hoje. A falta entra na cobertura (`esperado=1`, `nivel` sem código, `motivo`).
D5. Shopee: link base sempre primeiro (o mesmo de hoje, vira fallback), depois um por Sub_id distinto, no `criar` (ADR-003), até `MAX_SUBIDS_POR_ENVIO = 10`; `LIMITE_SHOPEE_ATINGIDO` ou o 11º em diante → base. API: `subIds` documentado → aplicado. Extensão: só envia Sub_id quando `SHOPEE_SUBID_CAMPO` estiver preenchido (P4) e responde `sub_id_aplicado`; extensão antiga não responde o campo → tratado como **não aplicado** (compatível).
D6. Todo envio de oferta ok grava uma linha em `rastreio_envios` (CA1). Atribuição da comissão: a linha de `rastreio_envios` mais recente com a mesma loja+código, `nivel` grupo/bloco, até o fim do dia da venda. Sem isso → "não atribuída".
D7. Importação por CSV colado pelo painel (corpo cru `text/csv`, só Dono), com prévia sem gravar. Só colunas da lista branca são lidas; o arquivo não vai ao disco.
D8. Dinheiro em centavos (INTEGER). Métricas calculadas na consulta (nada pré-agregado): reatribui sozinho quando o dono corrige uma associação.
D9. Tudo do dashboard é só Dono (leitura também), até P2.

## Catálogo de métricas (MDD) — definido antes do código
Recorte: período (dias de negócio, `periodRange` + `viradaMin`, `src/analytics.js:29`); comissão e cliques por **data da venda/clique** (AAAA-MM-DD). "Válida" = `status != 'cancelada'`. Alvo de bloco = linhas atribuídas ao bloco + às dos grupos que estão hoje em `block_groups`. Divisão por zero → `null` (tela mostra "—").

| ID | Métrica | Fórmula | Fonte | Granularidade | Uso / meta |
|---|---|---|---|---|---|
| M1 | Comissão | Σ `comissao_centavos` válidas | `comissoes` | grupo, bloco, loja, oferta, dia | principal; mostra também a confirmada (M1c = só `confirmada`) |
| M2 | Receita (vendas) | Σ `venda_centavos` válidas | `comissoes` | idem | contexto do M1 |
| M3 | Vendas (itens) | Σ `quantidade` válidas | `comissoes` | idem | base da conversão |
| M4 | Cliques | Σ `cliques` | `cliques_loja` (relatório da loja) | grupo, bloco, loja, dia | base do EPC |
| M5 | Ganho por clique (EPC) | Σ M1 das lojas com clique no recorte ÷ M4 | `comissoes` + `cliques_loja` | grupo, bloco, loja | comparar grupos/nichos |
| M6 | Conversão | M3 ÷ M4 | idem | grupo, bloco, loja | qualidade do público |
| M7 | Envios | nº de linhas | `rastreio_envios` | grupo, bloco, loja, oferta, dia | volume; contexto |
| M9 | Cobertura do rastreio | linhas `esperado=1` e `nivel IN (grupo,bloco)` ÷ linhas `esperado=1` | `rastreio_envios` | loja, grupo, dia | **meta 100%**; abaixo = Sub_id recusado, limite, etiqueta falhou |
| M10 | Alcance das associações | linhas `esperado=1` ÷ todas | `rastreio_envios` | loja, grupo | quanto do envio está configurado (informativo) |
| M11 | Comissão atribuída | M1 atribuída a grupo/bloco ÷ M1 | `comissoes` + D6 | loja, período | meta → 100%; mede a utilidade do dashboard |
| M12 | Gasto com anúncio | Σ `valor_centavos × dias_sobrepostos ÷ dias_do_gasto` | `gastos_anuncio` | grupo, bloco (só no próprio alvo) | entrada do M14/M15 |
| M13 | Entradas | nº `group_events` `action='add'` | `group_events` | grupo, bloco | limitado à retenção (90 dias padrão) |
| M14 | Custo por membro | M12 ÷ M13 | acima | grupo, bloco | quanto custa trazer cada pessoa |
| M15 | Retorno | M1 − M12 | acima | grupo, bloco, total | lucro do anúncio |

**Cenário C1** (fixture única de `test/ganhos.test.js` e, para M9/M10, de `test/rastreio.test.js`). Período 2026-10-01..31, virada 0. Grupos G1, G2 (bloco B1) e G3. Associações: Shopee G1→`g1`, G2→`g2`; Amazon B1→`turbob1-20`.
- `rastreio_envios` (01–04/10): Shopee G1 4× `g1`/grupo/esp1; Shopee G2 3× `g2`/grupo/esp1 + 1× sem código/`nenhum`/esp1/`limite_shopee`; Amazon G1 2× e G2 2× `turbob1-20`/bloco/esp1; Amazon G3 2× tag padrão/`padrao`/esp0; ML G3 2× etiqueta `geral`/`padrao`/esp0. Total 16.
- `comissoes` (centavos): c1 Shopee `g1` 05/10 venda 5000 com 300 qtd 1 confirmada (produto `SHOPEE:1.2`); c2 Shopee `g1` 06/10 4000/200/1 pendente (`SHOPEE:1.2`); c3 Shopee `g2` 07/10 2000/100/1 confirmada; c4 Shopee `g2` 08/10 9000/999 cancelada; c5 Amazon `turbob1-20` 09/10 10000/400/2 confirmada; c6 Amazon tag padrão 10/10 8000/500/1 confirmada; c7 ML sem código 11/10 12000/600/1 pendente; c8 Shopee `g1` 30/09 7000/700 (fora).
- `cliques_loja` (outubro): Shopee `g1` 100, `g2` 50; Amazon `turbob1-20` 40, tag padrão 60.
- `gastos_anuncio`: B1 01–31/10 3100; G3 20/10–08/11 2000. Entradas: G1 10, G2 15, G3 6.

Valores esperados (cada linha é um `test(...)`):
- M1: total 2100; M1c 1300; G1 500; G2 100; G3 0; B1 1000; Shopee 600, Amazon 900, ML 600; não atribuída 1100; oferta `SHOPEE:1.2` 500; dia 05/10 = 300.
- M2: total 41000. M3: total 7; G1 2; B1 5.
- M4: G1 100; G2 50; B1 190; total 250. M5: G1 5,00; G2 2,00; B1 ≈5,263; Shopee 4,00; Amazon 9,00; ML `null`; total 6,00 (centavos/clique).
- M6: G1 2%; B1 ≈2,63%; Amazon 3%. M7: G1 6; G2 6; G3 4; B1 12; total 16.
- M9: total 11/12 ≈91,67%; Shopee 87,5%; Amazon 100%; ML `null`. M10: 12/16 = 75%.
- M11: total 1000/2100 ≈47,62%; Shopee 100%; Amazon ≈44,44%; ML 0%.
- M12: B1 3100 (out. inteiro) e 1600 (16–31/10); G3 1200 (12 de 20 dias). M14: B1 124; G3 200; G1 `null` (gasto do bloco não se divide). M15: B1 −2100; G3 −1200.
- **C2 (atribuição histórica, D6):** `g1` de G1 passa a G3 em 20/10 com envio a G3 em 21/10; venda 05/10 → G1, venda 25/10 → G3.

## Esquema e contratos
Só `CREATE TABLE/INDEX IF NOT EXISTS` no `SCHEMA` de `src/db.js` (nenhuma tabela existente muda; reverter = código antigo ignora as tabelas).
```sql
-- Entrega A
CREATE TABLE IF NOT EXISTS rastreio_codigos (id INTEGER PRIMARY KEY,
  loja TEXT NOT NULL CHECK (loja IN ('mercadolivre','amazon','shopee')),
  alvo_tipo TEXT NOT NULL CHECK (alvo_tipo IN ('grupo','bloco')), alvo TEXT NOT NULL,
  codigo TEXT NOT NULL, criado_em INTEGER, atualizado_em INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rcod_alvo ON rastreio_codigos (loja, alvo_tipo, alvo);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rcod_cod ON rastreio_codigos (loja, codigo);
CREATE TABLE IF NOT EXISTS rastreio_envios (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, jid TEXT NOT NULL,
  loja TEXT NOT NULL, origem TEXT NOT NULL CHECK (origem IN ('regra','manual','catalogo','espelho')),
  rule_id INTEGER, envio_id INTEGER, oferta_chave TEXT, link TEXT NOT NULL, codigo TEXT,
  nivel TEXT NOT NULL CHECK (nivel IN ('grupo','bloco','padrao','nenhum')), bloco_id INTEGER,
  esperado INTEGER NOT NULL DEFAULT 0, motivo TEXT);
CREATE INDEX IF NOT EXISTS idx_renv_ts ON rastreio_envios (ts);
CREATE INDEX IF NOT EXISTS idx_renv_cod ON rastreio_envios (loja, codigo, ts);
-- Entrega B
CREATE TABLE IF NOT EXISTS importacoes (id INTEGER PRIMARY KEY, loja TEXT NOT NULL, tipo TEXT NOT NULL CHECK (tipo IN ('comissoes','cliques')),
  arquivo_sha256 TEXT NOT NULL, codigo_arquivo TEXT, lidas INTEGER, novas INTEGER, atualizadas INTEGER, ignoradas INTEGER,
  criado_em INTEGER NOT NULL, user_id INTEGER);
CREATE TABLE IF NOT EXISTS comissoes (id INTEGER PRIMARY KEY, loja TEXT NOT NULL, chave TEXT NOT NULL, data TEXT NOT NULL,
  codigo TEXT, produto TEXT, titulo TEXT, quantidade INTEGER NOT NULL DEFAULT 1, venda_centavos INTEGER NOT NULL DEFAULT 0,
  comissao_centavos INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('confirmada','pendente','cancelada')),
  importacao_id INTEGER NOT NULL, atualizado_em INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_com_chave ON comissoes (loja, chave);
CREATE INDEX IF NOT EXISTS idx_com_cod ON comissoes (loja, codigo, data);
CREATE TABLE IF NOT EXISTS cliques_loja (loja TEXT NOT NULL, dia TEXT NOT NULL, codigo TEXT NOT NULL DEFAULT '',
  cliques INTEGER NOT NULL, importacao_id INTEGER NOT NULL, atualizado_em INTEGER, PRIMARY KEY (loja, dia, codigo));
CREATE TABLE IF NOT EXISTS gastos_anuncio (id INTEGER PRIMARY KEY, alvo_tipo TEXT NOT NULL CHECK (alvo_tipo IN ('grupo','bloco')),
  alvo TEXT NOT NULL, inicio TEXT NOT NULL, fim TEXT NOT NULL, valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  nota TEXT, criado_em INTEGER, user_id INTEGER);
```
- **LGPD — o que se guarda de cada linha importada:** data, código, produto (ASIN/`SHOPEE:<shop>.<item>`/MLB), título (≤ 200), quantidade, venda, comissão, status. Pedido só como `chave` = HMAC-SHA256 com a `pseudo_key` local (32 hex) de `loja|pedido|produto|código da coluna`, com `#n` a partir da 2ª linha igual no mesmo arquivo; sem pedido, HMAC de `loja|data|produto|código efetivo` (o da coluna ou, se vazio, o "Código do arquivo") + `#n` (n-ésima linha igual no mesmo arquivo); quando o código veio do parâmetro, a linha antiga gravada sem código (`codigo IS NULL`, mesma base sem código) é atualizada e ganha a chave nova. Valores e status ficam fora da chave: baixar de novo com valor revisado atualiza a linha. Com pedido, o parâmetro fica fora da chave (rodadas 1–3: R1/Q2, Q1, R4, S2, R11, 05/11/2026). Coluna fora da lista branca nunca é lida (nome, endereço, telefone, e-mail, CPF de comprador); a resposta lista só os **nomes** das colunas ignoradas. Arquivo bruto não é gravado; `importacoes` guarda só o sha256 (aviso "já importado").
- **Retenção:** `rastreio_envios` apagada após `RETENCAO_RASTREIO_DIAS = 400` (P3; sem dado de pessoa, mas precisa durar mais que o atraso dos relatórios). `comissoes`/`cliques_loja` ficam até o dono apagar a importação. Backup leva tudo (já leva o banco).
- **`src/rastreio.js`** (novo): `validarCodigo(db, loja, codigo)`, `salvar(db, {loja, alvo_tipo, alvo, codigo})` (vazio = apaga), `listar(db)`, `apagarDoBloco(db, id)`, `resolver(db, loja, jid)` → `{codigo, nivel, bloco_id, esperado}`, `agrupar(db, {loja, jids, padrao})` → `[{codigo, nivel, bloco_id, esperado, jids}]` na ordem do 1º grupo, `registrar(db, linha)`, `cobertura(db, {de, ate, loja?, jids?})`, `limpar(db, dias, now)`, `montarRotas`.
- **Contratos alterados (compatíveis):** `amazon.montarLink(asin, {tag}?)` (tag fora de `RE_TAG` → `ErroAmazon('sem_tag')`); `shopee.gerarLink(urlProduto, {subId}?)`, `linkGuardado/guardarLink(url, id, subId='')`; `links.requestLinkShopee({url, subId?})` → `{link, longo, subIdAplicado}`; `lojas.linkAfiliadoShopeeRastreado(base, deps)` → `{link, sub_id|null}` (o `linkAfiliado('shopee')` atual passa a chamá-lo e devolve só `link`); `envios.linksRastreioShopee({urlProduto, jids, base})` → `{[jid]: {link, codigo, nivel, bloco_id, esperado, motivo}}`; payload de oferta Shopee ganha `links_rastreio` opcional (código antigo ignora e usa `link_afiliado`).
- **Rotas (todas `soDono`):** `GET/PUT /api/rastreio/codigos`, `GET /api/rastreio/cobertura`; `POST /api/ganhos/importar?loja=&tipo=&codigo=&previa=1` (corpo `text/csv`/`text/plain`, ≤ 5 MB), `GET /api/ganhos/importacoes`, `DELETE /api/ganhos/importacoes/:id`; `GET /api/ganhos?periodo=&de=&ate=&por=grupo|bloco|loja|oferta|dia&loja=&bloco=`; `GET/POST/DELETE /api/ganhos/gastos`.

## Importador (D7)
- Cabeçalho: procurado nas 20 primeiras linhas (Amazon costuma ter título antes, **não verificado**): a linha com ≥ 2 sinônimos, incluindo data e (comissão ou cliques). Normalização do nome: minúsculas, sem acento, `_`/pontuação → espaço.
- Sinônimos (constante `COLUNAS` por campo, comum às lojas; **provisórios** até P5): data (`data`, `data do pedido`, `order time`, `date shipped`, `data de envio`, `purchase time`…), pedido (`id do pedido`, `order id`, `checkout id`), produto (`asin`, `item id`, `id do item`, `shop id`+`item id`, `mlb`), código (`tracking id`, `id de rastreamento`, `sub id1`, `sub_id1`, `subid`, `etiqueta`), venda (`revenue`, `receita`, `valor da compra`, `purchase value`, `order amount`), comissão (`ad fees`, `taxas de publicidade`, `comissao`, `commission`, `total commission`, `net commission`, `ganhos`), status, quantidade (`items shipped`, `quantidade`, `qty`), devoluções (`returns`, `devolucoes`), cliques (`clicks`, `cliques`).
- `codigo` do arquivo (parâmetro): vale para linhas sem coluna de código (ML/Amazon que exportam já filtrados por etiqueta/ID — **não verificado** se o relatório do ML traz etiqueta por venda).
- Valores: dinheiro BR e US (`R$ 1.234,56`, `1,234.56`, `-12,30`; com os dois separadores, o último é o decimal; `1.234` sem vírgula = milhar com aviso); datas `AAAA-MM-DD[ hh:mm]`, `DD/MM/AAAA[ hh:mm]`, ISO; status por mapa (`completed/concluído/validado/pago` → confirmada; `pending/pendente/não pago` → pendente; `cancelled/cancelado/inválido/devolvido` → cancelada; desconhecido → pendente + aviso).
- Dedupe: `INSERT … ON CONFLICT(loja, chave) DO UPDATE` de status/valores (pendente → confirmada não duplica). Cliques: `ON CONFLICT(loja, dia, codigo) DO UPDATE` (a última importação vale).
- Validação: tamanho ≤ 5 MB (413), `Content-Type` `text/csv|text/plain` (415), começa com `PK\x03\x04` → 415 "Arquivo do Excel: salve como CSV"; byte NUL → 400; UTF-8 estrito, senão UTF-16 com BOM, senão windows-1252; ≤ 100.000 linhas, ≤ 200 colunas, célula ≤ 2.000 caracteres; linha sem data ou comissão válida → ignorada e contada. Mensagens fixas, sem eco de conteúdo do arquivo.
- Fixtures **provisórias**, inline em `test/importador.test.js` (`FIXTURE_AMAZON_PROVISORIO` etc.), com cabeçalhos prováveis e valores inventados. Quando o dono mandar os exemplos (P5), entra **só a linha de cabeçalho** + valores inventados; arquivo real nunca vai ao repositório.

## Gasto com anúncios
Formulário Dono: alvo (grupo ou bloco), início, fim (≤ 366 dias, fim ≥ início), valor em R$, nota (≤ 200). Rateio por dia (M12). Sem edição: apaga e lança de novo.

## Etapas
Verificação de cada etapa: `node --disable-warning=ExperimentalWarning --test test/<arquivo>.test.js` dos arquivos listados (o teste novo **falha antes** do código, CA8) e, no fim de cada grupo, `npm test` (linha de base: 944, 943 passam, 1 todo). Responsável: `dev` (sensível → `model: opus`); UI segue a spec do `designer`.

| # | Etapa | Arquivos | Grupo | Sensível | CAs |
|---|---|---|---|---|---|
| 1 | Esquema A (`rastreio_codigos`, `rastreio_envios`) | src/db.js, test/rastreio.test.js | A1 | sim (migração) | CA1, CA3, CA4 |
| 2 | Núcleo `src/rastreio.js` (validar, salvar, resolver, agrupar, registrar, cobertura M9/M10, limpar) | src/rastreio.js, test/rastreio.test.js | A2 | não | CA1–CA4, CA7 |
| 3 | `montarLink(asin, {tag})` | src/amazon.js, test/amazon.test.js | A2 | não | CA3, CA9 |
| 4 | `gerarLink` com `subIds` e cache por Sub_id | src/shopee.js, test/shopee.test.js | A2 | não | CA2 |
| 5 | Sub_id pela extensão e `linkAfiliadoShopeeRastreado` | extension/background.js, extension/manifest.json (1.4.0), src/links.js, src/lojas.js, test/extensao-shopee.test.js, test/links.test.js, test/lojas.test.js | A2 | sim (sessão do portal) | CA2, CA9 |
| 6 | Rotas de associação, bloco apagado limpa associação, retenção | src/rastreio.js, src/server.js, test/rastreio.test.js, test/seguranca.test.js | A3 | sim (autorização) | CA3, CA4, CA11 |
| 7 | Envios: link por código, `links_rastreio` da Shopee (manual e catálogo), registro por grupo | src/envios.js, src/catalogo-itens.js, test/envios.test.js, test/catalogo-itens.test.js | A3 | sim (link de afiliado) | CA1–CA4, CA9 |
| 8 | Regras: link por código e registro por grupo | src/scheduler.js, test/disparador.test.js | A3 | sim (link de afiliado) | CA1, CA3, CA4, CA9 |
| 9 | Painel: página `#ganhos`, aba Rastreio (associações + cobertura) | public/ganhos.js (novo), public/index.html, public/app.js, public/ajuda.js (TIPS), public/style.css, test/ganhos-painel.test.js (novo) | A4 | não | CA3, CA4, CA6 |
| 10 | Docs A | README.md, public/ajuda.js (LEIA_MAIS), public/docs/cap-grupos.js, test/docs.test.js (FATOS: 10 Sub_ids por envio, 400 dias) | A5 | não | CA10 |
| 11 | Esquema B (`importacoes`, `comissoes`, `cliques_loja`, `gastos_anuncio`) | src/db.js, test/ganhos.test.js (novo) | B1 | sim (migração) | CA5, CA6 |
| 12 | Parser `src/csv.js` (aspas, `,`/`;`/tab, BOM, CRLF, codificação, limites) | src/csv.js (novo), test/csv.test.js (novo) | B2 | sim (entrada de arquivo) | CA5, CA11 |
| 13 | Métricas M1–M15 e gastos em `src/ganhos.js` (funções, sem rotas) | src/ganhos.js (novo), test/ganhos.test.js | B2 | não | CA6, CA7 |
| 14 | Importador: sinônimos, valores, dedupe, lista branca, prévia, rotas | src/importador.js (novo), test/importador.test.js (novo) | B3 | sim (upload, dado pessoal) | CA5, CA11 |
| 15 | Rotas de `ganhos` (métricas, gastos) | src/ganhos.js, test/ganhos.test.js | B3 | sim (autorização) | CA6, CA11 |
| 16 | Montar rotas B no servidor; 403 do Operador e limites de upload | src/server.js, test/seguranca.test.js | B4 | sim (autorização, upload) | CA5, CA11 |
| 17 | Painel: abas Dashboard, Importar (com prévia) e Gastos | public/ganhos.js, public/ajuda.js (TIPS), public/style.css, test/ganhos-painel.test.js | B5 | não | CA5, CA6 |
| 18 | Docs B | README.md, public/ajuda.js (LEIA_MAIS), public/docs/cap-grupos.js, public/docs/cap-referencia.js, test/docs.test.js (FATOS: 5 MB, 100.000 linhas) | B6 | não | CA10 |

Grupos rodam em ordem (A1 → A2 → … → B6). Paralelos: A2 = {2, 3, 4, 5}; A3 = {6, 7, 8}; B2 = {12, 13}; B3 = {14, 15}. Nenhum arquivo em comum dentro do grupo (conferido: `lojas.js` só na 5; `server.js` só na 6 e na 16; `test/rastreio.test.js` só em 1, 2 e 6, em grupos distintos).

### Testes que nascem primeiro (vermelho) e pronto quando
1. `openDb` cria as duas tabelas e índices; abrir 2× não falha; 2º código igual na mesma loja → erro de UNIQUE. Pronto: verde + `npm test` igual à base.
2. `resolver`: grupo vence bloco; bloco de menor id vence; sem nada → padrão; etiqueta ML apagada de `tags` → padrão com `esperado=1, motivo='etiqueta_apagada'`. `agrupar`: sem associação → 1 entrada com todos os jids na ordem; 3 grupos, 2 códigos → 2 entradas. `validarCodigo`: Sub_id com hífen recusado; tag Amazon fora de `RE_TAG` recusada; etiqueta inexistente recusada. `cobertura`: C1 → M9 e M10 (valores do catálogo). `limpar`: apaga só > 400 dias.
3. `montarLink('B0…', {tag:'turbob1-20'})` usa a tag; sem opção → tag de Conexões (teste existente `:546` continua); tag inválida → `ErroAmazon` `sem_tag`; sem tag de Conexões e com override válido → usa o override.
4. Corpo da mutation leva `subIds:["g1"]` só quando há subId (fetch falso confere o corpo); cache: mesmo produto com Sub_id diferente não reaproveita link.
5. `corpoLinkShopee(url, 'g1')` com `SHOPEE_SUBID_CAMPO` vazio → corpo **igual ao de hoje**; com campo preenchido → `advancedLinkParams` no formato da constante; Sub_id não alfanumérico recusado. `links`: `subId` vai no job; resposta sem `sub_id_aplicado` → `subIdAplicado:false`. `lojas`: API com subId → `sub_id:'g1'`; extensão que não aplicou → `sub_id:null`; `outra_conta` continua.
6. PUT/GET com Operador → 403, sem login (auth ligada) → 401; código duplicado → 400 com frase fixa; `DELETE /api/blocks/:id` apaga as associações do bloco; retenção chama `rastreio.limpar`.
7. Sem associação: ML manual faz **1** `requestLink` para 3 grupos e o mesmo texto (igual a hoje) + 3 linhas `rastreio_envios` (`padrao`); ML com G1→`etqA`: 2 pedidos, G1 recebe o link de `etqA`; etiqueta associada falha → G1 recebe o link padrão, linha `esperado=1`, `motivo='falha_link'`; Amazon por bloco → link com `turbob1-20`; espelho idem (payload de origem espelho); Shopee: `criar` gera base + 1 por Sub_id, `LIMITE_SHOPEE_ATINGIDO` no 2º → base com `motivo='limite_shopee'`; 11 Sub_ids distintos → 10 + base; `links_rastreio` inválido no payload → base; catálogo Shopee: base = link do Etiqueta. Retomada (grupo já ok) não duplica linha.
8. Regra sem associação: 1 `requestLink`, mesma ordem de grupos, mesmo log e `sent_offers` (comparar com o teste atual); com G2→`etqB`: 2 pedidos; falha do padrão com associação ok → só os grupos do padrão falham; Amazon do catálogo com tag de bloco; uma linha `rastreio_envios` por grupo ok, nenhuma por grupo que falhou.
9. Harness vm: `#ganhos` abre para Dono; Operador não vê o item do menu; salvar associação chama PUT; todo `q('…')` novo tem TIPS (`test/qa.test.js` existente).
10. FATOS novos passam; `test/qa-docs.test.js` continua verde.
11. `openDb` cria as 4 tabelas; `valor_centavos <= 0` recusado pelo CHECK; idempotente.
12. Aspas com vírgula e quebra de linha; `""` escapado; `;` e tab detectados; BOM UTF-8; CRLF; windows-1252 (`ç`); UTF-16LE com BOM; 200 colunas ok / 201 erro; célula > 2.000 erro; NUL → erro.
13. Um `test` por linha de valores esperados do cenário C1 e C2; divisão por zero → `null`; período custom de 16–31/10 no M12.
14. Fixture Amazon provisória (título antes do cabeçalho, `Ad Fees`) importa 3 linhas; colunas em outra ordem e extras → mesmo resultado; coluna `Nome do comprador`/`Telefone` → valor não está em nenhuma linha de `comissoes` e o nome aparece em `colunas_ignoradas`; reimportar o mesmo arquivo → 0 novas; pendente → confirmada atualiza sem duplicar; `previa=1` não grava; `codigo` do arquivo preenche linhas sem código; cliques: reimport substitui; `PK\x03\x04` → 415; 6 MB → 413; `DELETE` da importação apaga só as linhas criadas por ela.
15. `GET /api/ganhos?por=grupo` devolve M1–M15 do C1; gasto: fim < início → 400; > 366 dias → 400; valor 0 → 400.
16. Todas as rotas novas: Operador 403; `Origin` de outro site → 403; `Content-Type: application/json` no importar → 415; nenhuma resposta de erro ecoa conteúdo do arquivo.
17. Dashboard mostra "—" para `null`; valores formatados em R$; prévia mostra colunas usadas/ignoradas antes de gravar; harness vm sem `localStorage`.
18. FATOS novos passam; capítulo explica que o clique vem do relatório da loja e que a cobertura < 100% é Sub_id recusado/limite.

## Pontos para o seguranca
- Etapa 5: a extensão só acrescenta Sub_id alfanumérico validado nela também; nada de valor de cookie/CSRF em log; formato capturado (P4) sem cookie no repositório.
- Etapas 7/8: invariável "nunca link comum" — todo caminho de falha cai no link de afiliado padrão ou em erro; `links_rastreio` do payload é revalidado (`LINK_SHOPEE`) no envio.
- Etapas 14/16: upload só Dono, Host/Origin, limites (5 MB, linhas, colunas, célula), XLSX recusado, decodificação estrita, nenhum eco do conteúdo, arquivo nunca no disco, lista branca de colunas (LGPD), pedido só em hash.
- Etapas 6/15/16: toda rota nova com `soDono`, inclusive GET (D9).
- Painel: valores importados (título, código) sempre por `esc` (XSS por CSV).

## Riscos e como reverter
- Formato real dos relatórios diferente do provável → prévia antes de gravar + sinônimos numa constante; ajuste é só acrescentar sinônimo (P5). Reverter: `DELETE` da importação.
- Sub_id da Shopee pela extensão sem formato (P4) → cobertura Shopee 0% pela extensão até a captura; nada quebra (link base). Pela API, funciona quando o acesso sair.
- Teto de 60/h consumido por Sub_ids → fallback para o link base e motivo `limite_shopee` na cobertura; recomendar código por **bloco** na Shopee (P6).
- Etiqueta associada não existe na conta do ML → link padrão + `falha_link`; o painel mostra a cobertura do grupo caindo.
- Associação por bloco dá ganho por bloco, não por grupo (documentado; M14 de grupo vira `null`).
- Custo por membro limitado à retenção de `group_events` (90 dias padrão).
- Reverter o código: `git revert`; tabelas novas ficam sem uso (nada lê); payload com `links_rastreio` é ignorado pelo código antigo, que usa `link_afiliado`. Extensão 1.4.0 com servidor antigo: o job não leva `subId`, corpo igual ao de hoje.

## Perguntas em aberto e premissas adotadas
- P1. A associação do grupo vence a etiqueta escolhida no Disparo manual e na regra? **Premissa: sim** (senão a atribuição quebra).
- P2. O Operador pode ver o dashboard? **Premissa: não** (D9); abrir depois é trocar o middleware dos GET.
- P3. `rastreio_envios` por 400 dias e comissões até apagar a importação? **Premissa: sim.**
- P4. Capturar no DevTools o corpo de "Obter link" com Sub_id1 preenchido (só o trecho `advancedLinkParams`, sem cookies). Sem isso, Sub_id só pela Open API.
- P5. Exemplo de cada portal (comissões e cliques): basta a linha de cabeçalho e 2 linhas com valores trocados. O relatório do ML traz a etiqueta por venda?
- P6. Shopee por grupo ou por bloco? Cada código = 1 pedido à extensão (teto 60/h). **Recomendo bloco.**
- P7. Só CSV na v1 (XLSX = "Salvar como CSV")? **Premissa: sim**; XLSX exigiria dependência nova.
- P8. Gasto também "geral" (todos os grupos)? **Premissa: não**, só grupo ou bloco.
- P9. `blocks.tag_id` existente não vira associação sozinho (CA9); a tela oferece copiar. **Premissa adotada.**

## A alinhar com a spec (designer)
Página nova `#ganhos` no grupo de análise do menu, com abas Dashboard, Importar, Gastos e Rastreio; seletor de período reaproveita o da Visão Geral; recorte `por` (grupo/bloco/loja/oferta/dia); "—" para `null`; cobertura com destaque quando < 100%; prévia da importação antes de gravar. Docs como seção nova em `cap-grupos.js` (capítulo novo mexeria na trilha de `test/docs.test.js`) — o designer decide.

## ADR
**ADR-006 — Rastreio por código distinto e importação de comissões por CSV.** Contexto: o dono quer ganho por grupo sem trocar link de afiliado e sem depender das APIs das lojas. Decisão: associação explícita loja × grupo/bloco → código (`rastreio_codigos`), um link por código distinto, registro por grupo em `rastreio_envios`, atribuição pela história de envios; comissões e cliques por CSV com parser próprio e lista branca de colunas, dinheiro em centavos, métricas calculadas na consulta. Alternativas rejeitadas: link por grupo sempre (custo e CA9), redirecionador próprio (troca o link da loja e depende do PC), biblioteca CSV/XLSX (dependência sem necessidade na v1). Consequências: cobertura vira métrica de saúde; Shopee pela extensão depende de capturar o formato do Sub_id; ganho de associação por bloco não se divide por grupo.

## Decisões do dono (04/11/2026)
- **Aprovado** o plano e a spec; começar pela Entrega A, só na worktree `~/Documentos/achadinhoturbo-ganhos`, sem subir nada (subida só depois das 22h, com liberação do dono).
- **P1:** sim, a associação do grupo/bloco vence a etiqueta escolhida no Disparo manual e na regra.
- **P2:** o Operador **não vê** a página Ganhos (nem o item do menu); todas as rotas novas são `soDono`, inclusive GET. Isso vale sobre a premissa contrária da spec (designer, pergunta 1).
- **P6:** Sub_id da Shopee **por bloco** apenas. Associação Shopee no nível de grupo é recusada (`validarCodigo`) e a UI não oferece Sub_id no diálogo de exceção do grupo.
- P3, P7, P8, P9: premissas do plano confirmadas por omissão. Cartão "Retorno" (M15) entra.
- **Onde editar associações (UI):** vale a spec do designer — fieldset "Códigos de rastreio" no formulário do Bloco e diálogo de exceção por grupo em Grupos (sem Shopee). A página `#ganhos` traz cobertura do rastreio (M9/M10) e, na Entrega B, Dashboard, Importar e Gastos. Em conflito de números e nomes (métricas, limites), vale o plano; em conflito de layout e textos, vale a spec.
- **Método:** TDD tradicional (teste unitário vermelho antes do código, em cada etapa) e MDD (as métricas M1–M15 deste catálogo são o contrato; cada uma com teste de valores conhecidos).
- Pendências do dono: P4 (capturar `advancedLinkParams` com Sub_id1 no DevTools, sem cookies) e P5 (CSV de exemplo de cada portal).
  - **P4 resolvido em 05/11/2026:** o corpo do pedido com `advancedLinkParams` e Sub_id1 foi capturado e ligado na extensão (versão 1.4.1).
  - **P5 parcial:** Amazon com arquivo real (os dois relatórios); Shopee só pela tela, porque a conta não tinha vendas nem cliques para exportar; Mercado Livre sem botão de exportar. Detalhes e cabeçalhos em `docs/produto/referencias/relatorios-dos-portais.md`.
