# Plano técnico: não repetir produto igual nem parecido no disparo automático, salvo se ficou mais barato
- Brief: não há; pedido do lead de 10/11/2026 (reclamação do dono sobre o grupo Desejo de Menina, medição do banco real de 04 a 10/11). Revisado no mesmo dia com a decisão do dono.
- Data: 2026-11-10 (revisão 2)
- Interface: **sem tela nova nem campo novo** (D7). Mudam textos: frase nova na mensagem do WhatsApp, linhas novas no Histórico, frase do 409 no "Enviar" do Catálogo, `TIPS`/Docs/README. O `designer` é opcional (revisar a redação da frase e das linhas).

## Decisões tomadas (dono, 10/11/2026; leitura do lead)
Palavras do dono: "Produtos em sequência, apenas se o segundo for mais barato e coloque que na busca interna nossa surgiu essa oportunidade ainda melhor, caso você ainda não aproveitou a primeira. Caso contrário, não deve ocorrer."

| # | Decisão |
|---|---|
| D1 | Parecido = **≥ 75%** das palavras em comum |
| D2 | Parecidos esperam **24 h** entre rodadas |
| D3 | "Enviar" do Catálogo segue a mesma regra: parecida e mais barata sai com a frase; senão, 409 com o porquê |
| D4, D5, D6 | Fora: disparo manual; duas regras no mesmo grupo; limite por categoria |
| D7 | Grau, intervalo e frase em **constantes** de `src/parecido.js` (sem campo nem tela) |
| D8 | Preencher título **e preço** dos envios antigos a partir de `catalogo_itens.oferta` |
| D9 | **Exceção do mais barato** (nova): igual com outra chave ou parecida só sai se o preço for menor que o **menor** preço entre as parecidas enviadas pela regra na janela; a mensagem ganha a frase fixa |

**Efeito medido pelo lead (10/11/2026):** 341 envios com título conhecido, de 04 a 10/11, com as regras 1 a 4 da "Decisão" (palavras significativas, 8 primeiras, mesma regra, chave diferente). Célula = "parecidas encontradas / envios da regra". "Mesma rodada" = até 10 minutos.

| Grau (D1) | Intervalo (D2) | Black_Operação | feminino | Eletronicos | pets |
|---|---|---|---|---|---|
| ≥ 90% | mesma rodada | 0/96 | 1/74 | 0/68 | 2/103 |
| ≥ 90% | 24 h | 0/96 | 4/74 | 1/68 | 10/103 |
| ≥ 90% | janela da regra | 0/96 | 5/74 | 2/68 | 13/103 |
| ≥ 75% | mesma rodada | 1/96 | 2/74 | 2/68 | 3/103 |
| **≥ 75%** | **24 h** | **5/96** | **6/74** | **9/68** | **34/103** |
| ≥ 75% | janela da regra | 7/96 | 12/74 | 13/68 | 46/103 |
| ≥ 60% | mesma rodada | 2/96 | 2/74 | 2/68 | 4/103 |
| ≥ 60% | 24 h | 9/96 | 7/74 | 17/68 | 51/103 |
| ≥ 60% | janela da regra | 16/96 | 21/74 | 27/68 | 62/103 |

- Com a D9, os números acima são **parecidas encontradas**, não todas barradas: entre rodadas, parte delas agora sai (as mais baratas que a anterior). Na mesma rodada, todas continuam barradas. Quantas eram mais baratas não foi medido (etapa 8, opcional).
- Mesmo título com outra chave na janela (CA1): feminino 5/74, Eletronicos 1/68, os outros 0. D5 conferida: cada regra manda a 1 grupo e nenhum grupo recebe de duas.
- O caso da reclamação (shampoo × condicionador Lola From Rio) dá 50% e não é parecido: foi resolvido pela correção do título, já commitada (`fce7371`).

## Objetivo e critérios de aceite
A regra não manda, dentro de uma janela, o mesmo produto com outra chave nem um produto parecido com outro que ela já enviou, **a não ser que esteja mais barato**; nesse caso a mensagem avisa que é uma oportunidade melhor.

CA1 — Mesmo título normalizado de outra oferta enviada pela mesma regra dentro de `dedupe_days` não sai, mesmo com chave diferente, salvo pela CA4. `dedupe_days = 0` desliga esta trava entre rodadas.
CA2 — Parecidos nunca saem na mesma rodada (nem o mais barato, nem com `dedupe_days = 0`). Entre rodadas, a parecida espera 24 h (nunca mais que a janela da regra), salvo pela CA4.
CA3 — Produtos diferentes da mesma marca continuam saindo; a regra tenta a próxima candidata. Título com menos de 3 palavras significativas nunca é comparado.
CA4 — **Exceção do mais barato:** entre rodadas, a oferta barrada pela CA1 ou CA2 sai se o preço dela, em centavos, for **menor** que o menor preço entre as parecidas da janela. Preço igual, maior ou desconhecido (de qualquer lado) barra. A comparação é refeita com o preço que vai na mensagem, depois da conferência de preço na loja (regra e fila do Catálogo).
CA5 — **Frase:** a mensagem que sai pela CA4 começa com `FRASE_MAIS_BARATA`, seguida de uma linha em branco, com qualquer template, com ou sem foto, no "Ver ofertas" e no "Enviar" do Catálogo. Nenhuma outra mensagem leva a frase.
CA6 — **Histórico:** linha `info` para cada pulada (título da pulada e da anterior, preço anterior, hora) e para cada parecida que saiu por ser mais barata (preço novo × anterior, hora); sem dado pessoal. No Catálogo, o 409 do "Enviar" diz o porquê.
CA7 — Vale para o disparo automático (`src/scheduler.js`, inclusive "Enviar agora" e "Ver ofertas") e para o "Enviar" do Catálogo (`src/catalogo-itens.js`). Ficam fora o disparo manual, o espelhamento e o remetente.
CA8 — Sem regressão: a não repetição por chave exata (`wasSent`/`tratada`) continua igual, inclusive com `dedupe_days = 0`; nenhum teste da linha de base (2556, 2555 passam, 1 todo) quebra.
CA9 — Docs que acompanham a mudança (README, `TIPS`, capítulo, `FATOS`, `motivos`).

## Contexto atual
- `wasSent` compara só `(rule_id, offer_key)` dentro de `dedupe_days` (`src/scheduler.js:125-129`); usado em `pickOffers` só fora do catálogo (`:379`).
- `pickOffers` (`src/scheduler.js:357-392`): o catálogo entra direto em `picked` depois de filtro, espera e revisão cheia (`:368-376`); as outras fontes passam por `wasSent`, `pausada`, `tried++` (teto `max(want×8, 10)`), `resolveOffer` e `rejectReason` (`:378-390`).
- Catálogo não passa por `wasSent`: a repetição é `catalogoItens.tratada` (`src/catalogo-itens.js:198-209`). O cursor das Novidades só avança sobre o que é tratado ou está em `exec.recusadas` (`src/scheduler.js:324`). O catálogo lê até `max(quer×4, 20)` utilizáveis (`src/catalogo.js:638`).
- `runRule` (`src/scheduler.js:447`): conferência de preço na loja em `:516` (catálogo) e `:548` (outras fontes), com o preço conferido em `offer` (`c.oferta`); o texto é `renderTemplate` em `textoDe` (`:561-564`); `sent_offers` gravado em `:597-600`. A prévia renderiza em `:738`.
- O verificador pode mudar o preço para cima até o limite (padrão 5%, `src/verificador.js:56`, `:163-172`): uma oferta mais barata na escolha pode deixar de ser depois da conferência.
- "Enviar" do Catálogo (`src/catalogo-itens.js:414-480`): monta o `payload` (`:450-460`) e, em `transacao` (`:177-180`, `BEGIN IMMEDIATE`), muda o item, grava `envios` e a reserva em `sent_offers` (`:476`). O texto só é montado depois, pela fila: `preparar('oferta')` em `src/envios.js:1318`, conferência em `:1347` e `textoDe` em `:1352-1355`. Descarte na fila = `OfertaDescartada(motivo, texto)` (`src/verificador.js:97-106`).
- Preço: `offer.price` em reais (número), o mesmo de `{PRECO_PRODUTO}` (`src/template.js:56`). Não há preço Pix; cupom é só o código (`{CUPOM}`, `:60`), sem valor. `catalogo_itens.oferta` guarda `price` em reais (`src/catalogo-itens.js:121-137`). Centavos inteiros: o padrão é `emCentavos` (`src/catalogo.js:311-314`).
- `sent_offers` = `(id, rule_id, offer_key, sent_at)` (`src/db.js:25-27`). Migração por `EXTRA_COLUMNS` (`src/db.js:189-205`, aplicada em `:236-238`).
- Painel: o 409 do "Enviar" fecha o diálogo e mostra `err.message` em `aviso` (`public/espelhamento.js:513`, `:522`).
- `src/titulo.js` e `test/disparador.test.js` estão limpos (correção do título commitada em `fce7371`). Mesmo assim, nenhuma etapa os edita, e `src/parecido.js` não importa `src/titulo.js`.
- Fixtures usam títulos de 1 ou 2 palavras ("Fone Bom", "Perfume Floral", `P${i}`; `test/catalogo-itens.test.js:41-43`): com o mínimo de 3 palavras, não entram na comparação.

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| A. Título e preço em `sent_offers` + comparação de palavras em JS (`src/parecido.js`) | Duas colunas aditivas na tabela que já é o "não repetir"; reset e apagar regra já limpam | Comparação lexical | Baixo |
| B. Hash de foto | Pega fotos quase iguais | Dependência nova, rede, frascos diferentes | Alto |
| C. Famílias de produto cadastradas | Agrupamento explícito | Manutenção manual | Médio |

Para a frase: prefixar o texto renderizado (em `scheduler.js` e `envios.js`) é mais simples e seguro que uma variável nova de modelo, que exigiria editar os templates do dono e deixaria a frase sumir de quem não editar.

## Decisão
**A.** `src/parecido.js` puro decide; o agendador e o "Enviar" do Catálogo aplicam; a fila de envios só confere de novo o preço e põe a frase quando o payload pede. Chave exata intocada (CA8).

Regras exatas:
1. **Palavras significativas:** minúsculas, sem acento (NFD), tudo que não é `[a-z0-9]` vira espaço; saem as de 1 caractere e as de `VAZIAS` (de, da, do, das, dos, e, com, para, em, ou, sem, por, no, na, original, oferta, promocao, novo, nova, frete, gratis, envio, imediato, premium, top, lancamento).
2. **Mesmo título:** sequência completa de significativas igual, com 3 ou mais.
3. **Parecido:** conjuntos das 8 primeiras significativas, os dois com 3 ou mais; `|A∩B| / min(|A|,|B|) ≥ 0,75`. Mesmo título também é parecido.
4. **Janela por regra** (só com `dedupe_days > 0`): mesmo título dentro de `dedupe_days` dias; parecido dentro de `min(24 h, dedupe_days)`. Mesma rodada (contra o que já está escolhido nesta execução): sempre, em qualquer `dedupe_days`. Linhas com a mesma `offer_key` da candidata nunca entram (CA8 e reenvio do Catálogo).
5. **Preço (CA4):** `centavos(v)` = `Math.round(Number(v)*100)` para número finito > 0, senão `null`. Conflitos = linhas da janela que batem pela regra 4. Se algum conflito ou a candidata tem preço `null` → barra. Senão, `mínimo` = menor `price_cents` dos conflitos; candidata `< mínimo` → **libera** (anterior citada = a do mínimo; empate = a mais recente); senão barra. Qualquer centavo a menos conta (sem piso, premissa P1).
6. **Mesma rodada nunca libera** (premissa P2): a exceção vale só entre rodadas.
7. **Ordem em `pickOffers`:** catálogo depois de `rejectReason` e da espera da loja, antes de `motivosDeRevisao`/revisão cheia; outras fontes depois do `rejectReason` do `resolveOffer` (preço resolvido; a parecida gasta uma tentativa). Barrada → `exec.puladas` (do catálogo também `exec.recusadas`, para o cursor das Novidades não travar). Liberada → entra com `maisBarata: { title, preco, sent_at }`. Toda escolhida chama `acrescentar`.
8. **Depois da conferência na loja (`runRule`):** se `picked[i].maisBarata` (ler de `picked[i]`, não de `offer`, que vem do verificador) e `!(centavos(offer.price) < maisBarata.preco)` → pulada com a frase "conferência" (catálogo: `exec.recusadas.add`), sem link nem envio. A oferta do catálogo que vai à revisão não leva a marca: o "Enviar" decide de novo.
9. **Frase:** `comFraseMaisBarata(texto)` = `` `${FRASE_MAIS_BARATA}\n\n${texto}` `` aplicada ao texto já renderizado, por link, na regra (`textoDe`), na prévia e na fila (só com `payload.mais_barata` e `origem.tipo === 'catalogo'`). Legenda de foto e texto usam o mesmo `textoDe`. Limite da legenda no WhatsApp: não verificado; a frase soma cerca de 100 caracteres.

## Esquema e contratos
- **Migração aditiva** (`src/db.js`): em `EXTRA_COLUMNS`, `['sent_offers', 'title', 'TEXT']` e `['sent_offers', 'price_cents', 'INTEGER']`; no `SCHEMA`, `CREATE INDEX IF NOT EXISTS idx_sent_quando ON sent_offers (rule_id, sent_at)`. Antes do laço, anotar se `price_cents` falta; só nesse caso, depois do laço, em `try/catch` (console só `e.code`):
  ```sql
  UPDATE sent_offers SET
    title = COALESCE(title, (SELECT CASE WHEN json_valid(c.oferta) THEN json_extract(c.oferta, '$.title') END
      FROM catalogo_itens c WHERE c.rule_id = sent_offers.rule_id AND c.chave = sent_offers.offer_key)),
    price_cents = COALESCE(price_cents, (SELECT CASE WHEN json_valid(c.oferta) AND json_type(c.oferta, '$.price') IN ('integer','real')
      AND json_extract(c.oferta, '$.price') > 0 THEN CAST(ROUND(json_extract(c.oferta, '$.price') * 100) AS INTEGER) END
      FROM catalogo_itens c WHERE c.rule_id = sent_offers.rule_id AND c.chave = sent_offers.offer_key AND c.status = 'enviado'))
  WHERE title IS NULL OR price_cents IS NULL
  ```
  Envios do ML (fontes antigas) ficam `NULL` e não são comparados. Nada destrutivo.
- **`src/parecido.js`** (novo; importa só `brl` de `src/template.js`):
  - `LIMIAR_PARECIDO = 0.75`, `HORAS_ENTRE_PARECIDOS = 24`, `PALAVRAS_PARECIDO = 8`, `MIN_PALAVRAS = 3`
  - `FRASE_MAIS_BARATA = '🔎 Nossa busca achou esta oportunidade ainda melhor, caso você ainda não tenha aproveitado a primeira.'`
  - `palavras(t) → string[]`; `comparar(a, b, { limiar }) → 'mesmo' | 'parecido' | null`; `centavos(v) → int | null`; `tituloParaGuardar(t) → string | null` (espaços colapsados, até 200)
  - `lerEnviados(db, ruleId, desde) → [{ offer_key, title, price_cents, sent_at }]` (`rule_id = ? AND sent_at > ? AND title IS NOT NULL`)
  - `criarTrava({ enviados, agora, dedupeDias, limiar?, horas? }) → { avaliar({ key, title, price }), acrescentar({ key, title }) }`; `avaliar` → `null` | `{ acao: 'barrar', tipo: 'mesmo'|'parecido'|'rodada', anterior: { title, preco, sent_at } }` | `{ acao: 'liberar', anterior }`
  - `comFraseMaisBarata(texto) → string`
  - `textoConflito(r, agora, { prefixo = 'Pulada' })`, `textoPassou(anterior, precoNovo, agora)`, `textoConferencia(anterior, precoConferido, agora)`, `textoNaoMaisBarata(precoConferido, precoAnterior)`. Título anterior cortado em 60; hora como `quandoDe` de `src/scheduler.js:49` (`HH:MM` ou `HH:MM de DD/MM`, cópia local).
- **Frases fixas** (`R$` por `brl`; `<anterior>` = título):
  - mesmo: `Pulada: o mesmo produto saiu por este disparo às 09:02 de 08/11 por R$ 49,90, com outro código ("<anterior>"). Só sai de novo se estiver mais barato.`
  - parecido: `Pulada: parecida com "<anterior>", que saiu por este disparo às 09:02 por R$ 49,90. Ofertas parecidas esperam 24 h, salvo se estiverem mais baratas.`
  - sem preço (no lugar de `por R$ …`): `sem preço guardado para comparar`
  - rodada: `Pulada: parecida com "<anterior>", que sai neste mesmo envio.`
  - Catálogo (409): as mesmas com `Não enviada:` no lugar de `Pulada:`.
  - passou: `Saiu como oportunidade melhor: parecida com "<anterior>", que saiu às 09:02 por R$ 59,90; agora por R$ 49,90.`
  - conferência (regra): `Pulada: na conferência o preço ficou em R$ 52,00, que não é menor que o de "<anterior>" (R$ 49,90, às 09:02).`
  - fila do Catálogo: `OfertaDescartada('preco_subiu', 'Descartada: preço subiu para R$ 52,00 e não é mais menor que o da oferta parecida enviada antes (R$ 49,90)')`
- **Payload do "Enviar"** (só quando liberada): `mais_barata: { preco_anterior: <centavos> }`. Na fila: presente e não inteiro > 0 → `OfertaDescartada('nao_conferido')` (falha fechada).
- **Gravação:** os dois `INSERT INTO sent_offers` passam a `(rule_id, offer_key, sent_at, title, price_cents)`: na regra, título e preço do `offer` conferido; no "Enviar", os da oferta ajustada.

## Etapas
| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 1 | Migração do esquema acima. Testes: banco velho reabre com dados intactos e ganha as 2 colunas e o índice; título e preço preenchidos para chave do catálogo `enviado`, preço `NULL` para item `descartado`, ambos `NULL` para ML; `price` texto, zero ou JSON inválido não derrubam o `openDb`; 2ª abertura não refaz o preenchimento | `src/db.js`, `test/base.test.js` | `node --disable-warning=ExperimentalWarning --test test/base.test.js` | dev | A | sim | CA1, CA4, CA8 |
| 2 | `src/parecido.js` conforme o contrato. Testes puros: shampoo × condicionador = null (50%); areia fina × mista, kit × unidade, Cicaplast de dois ASIN = parecido/mesmo; marcas diferentes e mesma marca com produtos diferentes = null (CA3); 2 palavras nunca compara; acento, caixa e pontuação; janelas (`dedupeDias` 0, 3, 7; 23 h × 25 h); mesma chave ignorada; preço: menor libera, igual barra, maior barra, `null` de cada lado barra, 1 centavo a menos libera, mínimo entre 3 conflitos (R$ 59,90, 49,90, 54,90 → só abaixo de 49,90), empate cita a mais recente; rodada barra mesmo mais barata e com `dedupeDias` 0; `centavos(0.1+0.2)`; frases com hora de hoje e de outro dia (relógio fixo) e título cortado em 60 | `src/parecido.js`, `test/parecido.test.js` | `node --disable-warning=ExperimentalWarning --test test/parecido.test.js` | dev | A | não | CA1–CA6 |
| 3 | Agendador: `novaExecucao` ganha `puladas: []`; `pickOffers` monta a trava (`lerEnviados` desde `agora − dedupe_days` dias, só com `dedupe_days > 0`) e aplica as regras 7 e 8; `runRule` loga as puladas (`info`, `offer_title` = a pulada), aplica a frase em `textoDe`, grava título e preço no `INSERT` (`:598`) e loga `textoPassou` depois do `INSERT`; `previewOffers` põe a frase. Testes ponta a ponta (fonte lista com títulos completos e catálogo falso, arranjo de `test/catalogo-regras.test.js`): CA1 duas chaves com o mesmo título; CA2 parecido na mesma rodada (barra mesmo mais barato) e em 3 h; volta em 25 h; CA4 mais barata em 3 h sai com a frase (texto começa com `FRASE_MAIS_BARATA` e linha em branco, com e sem foto) e a linha `info`; igual e mais cara barram; anterior sem preço barra; verificador falso sobe o preço acima do mínimo → pulada sem envio e sem link; CA3 a regra completa `per_run` com a próxima; `dedupe_days = 0` repete por chave como hoje (CA8); Novidades não prende o cursor; "Ver ofertas" mostra a frase e não loga; nenhuma linha traz número/JID | `src/scheduler.js`, `test/parecido-regras.test.js` | `node --disable-warning=ExperimentalWarning --test test/parecido-regras.test.js test/catalogo-regras.test.js test/qa-catalogo.test.js test/verificador-regras.test.js test/ritmo-agendador.test.js` | dev | B | não | CA1–CA8 |
| 4 | Fila de envios: em `preparar('oferta')`, depois de `conferirOferta` (`src/envios.js:1347`), com `origem.tipo === 'catalogo'` e `p.mais_barata`: valida `preco_anterior`; preço conferido não menor → `OfertaDescartada('preco_subiu', textoNaoMaisBarata(...))`; senão `textoDe` aplica `comFraseMaisBarata`. Testes (envio gravado direto no banco, arranjo de `test/verificador-envios.test.js`): com a marca sai com a frase (texto e foto); sem a marca, igual a hoje; verificador falso sobe o preço → descartada, nenhum grupo recebe, Histórico com a frase; `preco_anterior` inválido → descartada; origem `manual` com a marca é ignorada | `src/envios.js`, `test/parecido-envios.test.js` | `node --disable-warning=ExperimentalWarning --test test/parecido-envios.test.js test/envios.test.js test/verificador-envios.test.js` | dev | B | não | CA4, CA5 |
| 5 | "Enviar" do Catálogo: dentro do `transacao`, antes do `UPDATE`, com `dedupe_days > 0`: `criarTrava` + `avaliar({ key: item.chave, title: oferta.title, price: oferta.price })` (oferta ajustada); barrar → `ErroCatalogoItem(409, textoConflito(r, now, { prefixo: 'Não enviada' }))`; liberar → `payload.mais_barata` antes do `INSERT INTO envios`; `INSERT INTO sent_offers` (`:476`) com título e preço; depois do commit, linha `info` `textoPassou`. Testes: parecida há 3 h com preço igual ou maior → 409 com a frase, item e envios intactos; mais barata → 200, payload com a marca, e a fila (WhatsApp simulado) manda o texto com a frase; anterior sem preço → 409; 25 h depois e `dedupe_days = 0` → sai sem frase; reenvio do item que falhou não se barra na própria reserva; parecida de outra regra não barra; preço ajustado no "Revisar oferta" é o comparado | `src/catalogo-itens.js`, `test/catalogo-itens.test.js` | `node --disable-warning=ExperimentalWarning --test test/catalogo-itens.test.js test/qa-catalogo.test.js` | dev | C | sim | CA4–CA8 |
| 6 | Docs: `TIPS['regras.dedupe']` (`public/ajuda.js:45`): vale também para o mesmo produto com outro código, parecidos esperam 24 h, e os dois só saem antes se estiverem mais baratos, com um aviso na mensagem; `cap-disparos.js:266` (linha da tabela) + parágrafo curto na seção `ritmo` com a frase e as linhas do Histórico; `cap-referencia.js` (`motivos`): "Pulada: …", "Não enviada: …", "Saiu como oportunidade melhor: …" e a variante de "Descartada: preço subiu para …", com o que fazer; README: seção "Ofertas repetidas e parecidas" depois de "Conferência de preço e estoque antes do envio" (`README.md:296`) e uma frase em "Como a regra usa a fonte" (`:574`). `FATOS` para 24 h, 75% e 8 palavras lidos de `src/parecido.js`, mais um teste de que README e `cap-disparos.js` trazem `FRASE_MAIS_BARATA` idêntica | `README.md`, `public/ajuda.js`, `public/docs/cap-disparos.js`, `public/docs/cap-referencia.js`, `test/docs.test.js` | `node --disable-warning=ExperimentalWarning --test test/docs.test.js test/qa.test.js test/qa-docs.test.js` | dev | B | não | CA9 |
| 7 | Linha de base completa | — | `npm test` (esperado: 2556 + novos, 0 falhas, 1 todo) | lead | D | não | CA8 |
| 8 | Opcional, não bloqueia: medir quantas das parecidas de 04 a 10/11 eram mais baratas (banco real `mode=ro`, só títulos e preços de produto e contagens; nunca `group_name`, participante, `settings`, `conexoes`) | nenhum (comando do lead fora do projeto) | tabela para o dono | lead | D | não | CA4 |

**Grupos:** A = 1 ∥ 2. B = 3 ∥ 4 ∥ 6, depois de A (3 e 4 só importam `src/parecido.js`). C = 5, depois de 4 (os testes da 5 passam pela fila com a frase). D = 7 e 8 no fim. Nenhum par do mesmo grupo divide arquivo, teste ou configuração.
Se um teste da linha de base quebrar por fixture com títulos parecidos de 3+ palavras, o `dev` **para e relata** ao lead (não muda fixture).

**Ordem de gravação em `src/` (o serviço reinicia a cada gravação):**
1. `src/parecido.js` (etapa 2): ninguém importa; inerte.
2. `src/db.js` (etapa 1): no reinício o banco real ganha as colunas e o preenchimento; o código antigo ignora. Antes, o lead confere que o backup das 03:00 de hoje existe.
3. `src/envios.js` (etapa 4): inerte até alguém gravar `mais_barata`.
4. `src/scheduler.js` (etapa 3): liga a trava nas regras; precisa de 1 e 2.
5. `src/catalogo-itens.js` (etapa 5): liga no "Enviar"; precisa de 1, 2 e 4.

Cada arquivo de `src/` vai num salvamento só, já com `node --check` limpo (um erro de sintaxe derruba o serviço até o próximo salvamento). `public/`, `README.md` e `test/` não reiniciam nada.

## Pontos para o seguranca
- Etapa 1: o `UPDATE` lê JSON nosso, mas `json_valid`/`json_type` + `try/catch` têm de garantir que o `openDb` nunca falha por ele; nenhum `e.message` do banco no console.
- Etapa 5: a trava fica **dentro** do `BEGIN IMMEDIATE` (dois "Enviar", ou "Enviar" × regra, não passam juntos com parecidas). O preço comparado é o ajustado pelo Dono no "Revisar oferta": ele pode baixar o preço e liberar a frase. Aceito, porque só o Dono envia (`soDono`) e o preço digitado é o que vai na mensagem; registrar no relatório.
- Etapas 3, 4 e 5: a frase só pode aparecer com o preço final menor que o anterior. A fila confere de novo depois do verificador; marca inválida falha fechada; a marca só vale com `origem.tipo === 'catalogo'` e o payload só é gravado pelo servidor.
- Os textos do 409 e do Histórico levam título de oferta (texto de terceiro vindo do Etiqueta): conferir que `aviso` (`public/espelhamento.js:513`) e o Histórico escapam o texto. Escape não verificado por mim.
- Títulos não são dado pessoal: `tituloParaGuardar` corta em 200 e as frases em 60; nada de número, JID ou nome de grupo nas linhas novas.
- Custo: `lerEnviados` uma vez por execução e uma por "Enviar" (índice novo); comparação em memória.

## Riscos e como reverter
- **Regra sem alternativa (pets, 1/3 de parecidas):** a rodada pode sair menor. Agora parte delas sai, se ficou mais barata. Reverter: `HORAS_ENTRE_PARECIDOS`/`LIMIAR_PARECIDO`.
- **Frase repetida por centavos:** a mesma linha de produto pode sair várias vezes com a frase, cada vez alguns centavos mais barata. Comparar com o mínimo impede o vai e volta. Se incomodar, um piso é uma constante nova em `src/parecido.js`.
- **Preço da reserva do Catálogo:** a linha em `sent_offers` guarda o preço aprovado. Se a fila baixar o preço na conferência, a próxima comparação usa o aprovado, um pouco mais alto. Aceito.
- **Fontes de lista:** a parecida gasta uma tentativa do `maxTries` (ainda 8× o pedido). Aceito.
- **Rodada com revisão:** a oferta do catálogo que vai à revisão conta na mesma rodada. Aceito.
- **Falso positivo (CA3):** mínimo de 3 palavras, 8 primeiras, testes de marca; o Histórico mostra o par. Reverter: subir o limiar.
- **Migração:** só colunas e índice novos. Rollback = reverter o commit; as colunas ficam sem uso (nenhuma migração destrutiva). O backup diário das 03:00 cobre o banco.
- **Reinício no meio de uma execução** por gravação em `src/`: o risco já existe em toda mudança. Se der, gravar fora dos horários marcados das regras.
- **Log:** só linhas `info` (nunca `aviso`/`erro`, que vão aos avisos do WhatsApp).

## Perguntas em aberto e premissas adotadas
Nenhuma pergunta bloqueia. Premissas (o lead confirma com o dono no resumo final):
- P1 — Qualquer centavo a menos conta (sem piso).
- P2 — Mesma rodada nunca libera, nem a mais barata.
- P3 — Preço comparado = `price` (o `{PRECO_PRODUTO}` da mensagem), depois da conferência na loja; cupom não entra (é só o código, sem valor); não há preço Pix no programa.
- P4 — "Menor que" = menor que o **mínimo** das parecidas da janela; a anterior citada é a do mínimo.
- P5 — A frase vai na primeira linha, seguida de linha em branco, em qualquer template; sem variável de modelo.
- P6 — Na fila do Catálogo, mais cara depois da conferência = "Descartada: preço subiu…", e o item fica com "Enviar de novo" (o caminho que já existe).
- P7 — "Rodada" = uma execução de `runRule`. Em Novidades, a pulada é tratada e não volta; nas outras ordens, volta depois da janela.
- Fora, a oferecer ao dono: a exceção do mais barato para a **mesma chave** (`wasSent`/`tratada` intocados); cruzar regras ou grupos (D5); limite por categoria (D6); grau e intervalo editáveis por regra.

## ADR
**ADR-013 — Repetição por título e semelhança, com exceção do mais barato.** Contexto: o mesmo produto aparece com chaves diferentes e linhas de produto saem em sequência; o dono aceita a sequência só quando a segunda oferta é mais barata, e com aviso. Decisão: guardar título e preço (centavos) em `sent_offers`; comparar por palavras significativas (`src/parecido.js`: sobreposição nas 8 primeiras, 3+ palavras, ≥ 75%), por regra, 24 h para parecidos e `dedupe_days` para o mesmo título; entre rodadas, a parecida sai se estiver abaixo do menor preço das parecidas da janela, e a mensagem ganha uma frase fixa. Chave exata segue como estava. Rejeitado: hash de foto (dependência e rede), famílias cadastradas (manutenção), variável de modelo para a frase (exigiria editar os templates). Consequência: semelhança lexical ajustável por constantes; a frase depende do preço final, por isso há conferência dupla (regra e fila); não cruza regras nem grupos.

## Adendo de 10/11/2026, 17h20: decisões do dono depois da medição (valem sobre o texto acima)
Respostas do dono ao lead (AskUserQuestion), depois de ver a medição de 04 a 10/11 com a regra pronta:

| # | Decisão | Efeito |
|---|---|---|
| D10 | A frase vale **só para o mesmo produto** (mesmo título normalizado, outra chave) | A exceção do mais barato (CA4) e a frase (CA5) passam a valer só para o conflito do tipo `mesmo`. Conflito só `parecido` (outro tamanho, cor, versão da mesma linha) **não tem exceção**: espera as 24 h (nunca mais que a janela da regra) e depois sai sem a frase. Substitui a D9 e a P1 nesse ponto |
| D11 | O segundo precisa estar **pelo menos 5% mais barato** | Libera só se `preço × 100 ≤ menor preço anterior × 95`, em centavos (R$ 100,00 → R$ 95,00 ou menos; R$ 95,01 barra). Constante `DESCONTO_MINIMO_MAIS_BARATA = 5` em `src/parecido.js`. Vale também na conferência depois do verificador (regra e fila do Catálogo). Substitui a P1 ("qualquer centavo") |
| D12 | Dois parecidos **nunca** no mesmo horário, nem com o segundo mais barato | Confirma a P2, sem mudança |
| D13 | Commit autorizado quando tudo estiver conferido (sem push) | — |

CAs ajustados:
- CA2 — Parecidos nunca saem na mesma rodada. Entre rodadas, a parecida (título não igual) espera 24 h (nunca mais que a janela da regra), **sem exceção de preço**.
- CA4 — Exceção do mais barato: entre rodadas, a oferta barrada pela CA1 (**mesmo título**, outra chave) sai se o preço dela for **pelo menos 5% menor** que o menor preço entre os envios de mesmo título na janela, e se não houver na janela de 24 h nenhum conflito só `parecido`. Preço menos de 5% abaixo, igual, maior ou desconhecido (de qualquer lado) barra. A comparação (com os 5%) é refeita com o preço que vai na mensagem, depois da conferência na loja (regra e fila do Catálogo).
- CA5 e CA6 — sem mudança de forma; as frases fixas passam a dizer "pelo menos 5% mais barato" onde diziam "mais barato", e a frase da parecida perde o "salvo se estiverem mais baratas".

Medição do lead com a regra de antes do adendo (04 a 10/11, banco real só leitura): Black_Operação 99 envios, 3 trocados, 2 com a frase; feminino 76, 4 e 3; Eletronicos 70, 10 e 0; pets 105, 21 e 13. Com o adendo, menos envios levam a frase e mais são trocados.
