# Plano técnico: variedade nas ofertas seguidas (trava da "mesma linha")
- Brief: não há; pedido do lead com a decisão do dono (12/11). Base: `docs/produto/planos/nao-repetir-produto-parecido.md` (ADR-013).
- Data: 2026-11-12 (revisado no mesmo dia: o dono aprovou com a guarda "não zera o envio" e respondeu P1–P4)

## Objetivo e critérios de aceite
No Disparo automático, duas ofertas da mesma linha não saem uma atrás da outra (no mesmo envio nem no envio anterior). Em vez da segunda, a regra pega a próxima candidata da lista. A trava de 24 h que existe hoje não muda.

CA1 — Mesmo envio: se uma oferta da mesma linha de outra escolhida já saiu nesta execução, ela não sai, e a vaga vai para a próxima candidata. Os 4 pares do caso de 12/11 (regra "Black_Operação") são barrados. A guarda do CA11 nunca abre exceção a isto.
CA2 — Envio anterior: a oferta da mesma linha de uma que a regra enviou nos últimos `MINUTOS_SEGUIDAS` (45) minutos não é escolhida. Isso inclui o que saiu pelo "Enviar" do Catálogo da mesma regra, porque fica gravado em `sent_offers`. A única exceção é a do CA11.
CA3 — "Mesma linha" (`mesmaLinha(a, b)` em `src/parecido.js`) é qualquer um destes dois casos:
- **mesmo tipo**: a 1ª palavra significativa do título é igual. Para achá-la, o código pula números e as cabeças genéricas (`kit`, `jogo`, `conjunto`, `combo`, `par`, `pack`).
- **mesma marca e linha**: pelo menos `COMUNS_MESMA_LINHA` (2) palavras distintivas em comum entre as `PALAVRAS_PARECIDO` (8) primeiras de cada título. Antes de contar, saem os números e as palavras de `GENERICAS_LINHA` (público, cor, tamanho e recursos genéricos, por exemplo `caes`, `masculino`, `feminino`, `preto`, `grande`, `bluetooth`, `gamer`).

Título com menos de 3 palavras não entra na comparação, igual à trava atual. Os exemplos da tabela "Prova do critério" valem como teste.
CA4 — Se, depois de alguma oferta sair, só sobram candidatas da mesma linha, a execução manda menos ofertas do que o pedido (pula, não força). Não sai linha "Pulada" para cada oferta barrada. A linha "Antes da escolha…" ganha o pedaço `N da mesma linha de uma oferta recente`.
CA5 — No Catálogo em ordem Novidades, a oferta barrada pela trava de seguidas não conta como tratada: o cursor não passa por ela, e ela volta a ser avaliada na próxima execução, como a `rodada` de hoje.
CA6 — Se a escolhida cai fora (pulada, descartada ou separada para revisão), ela deixa de barrar a mesma linha nesta execução (`retirar`, como a trava da rodada).
CA7 — A trava vale com qualquer "dias sem repetir", inclusive 0. A mesma chave não é comparada consigo mesma: com 0, a mesma oferta repetida segue a regra de hoje.
CA8 — Nada muda na trava de 24 h, no limiar 0,75, na exceção dos 5%, no `{PRECO_ULTIMO_ENVIO}`, no "Enviar" do Catálogo, no Disparo manual, no espelhamento, no remetente nem no Grupo vivo. A suíte atual passa sem editar nenhum teste.
CA9 — "Enviar agora" e a prévia "Ver ofertas" usam a mesma escolha, com a guarda, então a prévia já mostra a variedade.
CA10 — Docs: `README.md`, `public/ajuda.js` (`regras.dedupe`), `public/docs/cap-disparos.js`, `public/docs/cap-referencia.js` (linha "Antes da escolha"). `FATOS` de `test/docs.test.js` ganha os 45 min e as 2 palavras. A guarda do CA11 entra nos Docs, com o exemplo da regra de perfumes.
CA11 — Guarda "não zera o envio". Ela só age quando, depois da trava, nenhuma oferta sairia no envio: a lista acabou e nenhuma escolhida chegou a um grupo. Nesse caso, a primeira candidata barrada **só** pelo envio anterior (janela de 45 min) é escolhida. Se ela cair fora, vem a próxima dessas, até uma sair ou a reserva acabar. Uma vez que uma oferta sai, a guarda para: nunca saem duas da mesma linha no mesmo envio, mesmo com a guarda. A candidata barrada por parecida, por repetida ou pela mesma linha de uma escolhida neste envio nunca entra na guarda. Exemplo esperado: a regra "feminino", só de perfumes, com 2 por envio, manda 1 perfume a cada envio, em vez de 1, 0, 1, 0.

## Contexto atual
- Trava atual: `criarTrava` (`src/parecido.js:136-206`). A mesma rodada fica em `escolhidas` (`:147`, `:154-159`, tipo `rodada`) e o histórico na janela `dedupe_days` (`:143-146`). `comparar` usa o limiar 0,75 nas 8 primeiras palavras (`:41-55`). `palavras()` normaliza o título (`:34-39`). `retirar` desfaz uma escolhida (`:196-204`).
- Escolha da regra: `criarEscolha` (`src/scheduler.js:733-820`). A trava nasce em `ler()` (`:755-758`) só com os enviados da janela de dedupe. Com `dedupe_days` 0, a lista fica vazia (`:756`). `barrada` manda tudo o que for barrado para `exec.puladas` e soma `filtradas.parecidas` (`:761-766`). No catálogo, toda barrada que não é `rodada` vira tratada (`exec.recusadas`, `:791-792`), e a ida à revisão é decidida depois da trava (`:793-796`). `devolver` chama `trava.retirar` (`:814-817`). A prévia é `pickOffers` (`:823-829`).
- `runRule`: o laço de vagas (`:1047-1063`) termina com `if (!o) { acabou = true; break; }` (`:1063`). `saidas` conta as ofertas que chegaram a um grupo (`:1255-1257`).
- Linha "Antes da escolha": `fraseFiltradas` (`:140-153`). O contador começa em `novaExecucao` (`:606-610`). As "Pulada" de cada oferta passam por `logarPuladaUmaVez` (`:365-372`).
- "Enviar" do Catálogo: cria a trava sem seguidas (`src/catalogo-itens.js:546`, `:562-565`) e grava a reserva em `sent_offers` (`:585`). `reservadaDurante` da regra só usa `comparar` (`src/scheduler.js:947-957`).
- `sent_offers` já tem `title` e índice `(rule_id, sent_at)` (`src/db.js:25-29`, `:219`). **Não precisa de migração.**
- Precedente de opção ligada só no serviço: `criarServicos({ verificar })` (`src/server.js:68`, `:88-89`), com `verificar: true` só no `main` (`:875`). `createScheduler` está em `src/scheduler.js:265`.
- Os testes usam muitos títulos do mesmo tipo na mesma regra ("Fone …", "Mouse …", "Roteador …", contados com `rg` em `test/`). Uma trava de tipo ligada por padrão quebraria dezenas de testes de outras áreas. Por isso a trava fica **desligada por padrão** em `createScheduler` e o servidor a liga, como faz com o verificador.
- Regras do dono (etapa 4, lida pelo lead só para leitura, 12/11), todas a cada 30 min:

| Regra | Fontes | Por envio |
|---|---|---|
| Black_Operação | catálogo multicategoria | 2 |
| feminino | perfumes + Beleza | 2 |
| Eletronicos | não detalhado no relato | 3 |
| pets | não detalhado no relato | 2 |

  A regra "feminino" confirma o risco de regra de um tipo só: sem a guarda, mandaria 1, 0, 1, 0.

## Prova do critério
Saída de `palavras()` do código atual, simulada no scratchpad. A coluna "hoje" é o resultado de `comparar`.

| Par | hoje | mesmaLinha | Esperado |
|---|---|---|---|
| Monitor Gamer Curvo AOC AGON QUAD 34" … × Monitor Gamer AOC AGON QUAD 27" … | null (5/8) | tipo `monitor` | barra |
| Jbl Partybox 520 Power and Party… × Caixa de Som Portátil - PartyBox Stage 320 - JBL… | null | comuns `jbl`+`partybox` | barra |
| Caixa De Som Jbl Partybox 330 280w Rms × Alto-falante Bluetooth Jbl Partybox 130 | null | comuns `jbl`+`partybox` | barra |
| Monitor Samsung Odyssey G40 25" … × Monitor Gamer 27 Curvo 240hz … | null | tipo `monitor` | barra |
| Colete Tático Para Cães Grandes × Peitoral Tático Militar Para Cães K9 | null | null (só `tatico`; `caes` e `grandes` são genéricas) | não barra |
| Tênis Nike Revolution 7 Masculino × Camiseta Nike Dri-FIT Masculina Preta | null | null (só `nike`) | não barra |
| Air Fryer Mondial 4L Preta × Liquidificador Mondial Turbo Preto 1200W | null | null | não barra |
| Smart TV Samsung 55" Crystal × Monitor Samsung Odyssey G40 | null | null | não barra |
| Kit 10 Cuecas Boxer × Kit Ferramentas 129 Peças | null | null (tipo `cuecas` × `ferramentas`) | não barra |
| Fone Bluetooth JBL Tune 520BT × Caixa de Som Bluetooth JBL Go 3 | null | null (só `jbl`) | não barra |
| Teclado Gamer Redragon × Mouse Gamer Redragon | null | null (só `redragon`) | não barra |
| Fone de Ouvido JBL Tune × Fone de Ouvido Sony WH-CH520 | null | tipo `fone` | barra (o mesmo tipo basta, decisão do dono) |
| Caixa de Som JBL Flip 6 × Caixa Organizadora 20 Litros | null | tipo `caixa` | barra (falso positivo aceito) |

Sem `GENERICAS_LINHA`, o par pet barraria (`tatico`+`caes`).

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| A. Baixar o limiar só para seguidas (ex.: 0,5 nas 8 primeiras) | Uma linha de código | Pega só o par AGON (5/8). JBL dá 2/8 e o par Samsung, 1/8 | Não resolve |
| B. Mesmo tipo OU 2 palavras distintivas em comum | Barra os 4 pares e deixa passar os exemplos de outra linha | Duas listas de palavras para manter; falso positivo em tipos ambíguos ("caixa") | Baixo: a barrada só espera 45 min |
| C. Só marca + tipo (as duas condições juntas) | É o texto do dono | Não pega o par Samsung × outro monitor (marcas diferentes) | Não cumpre o pedido |

Decisão: **B**.

## Decisão
- `mesmaLinha` e as constantes ficam em `src/parecido.js`, sem campo na tela (D7). A janela é fixa: **45 min** desde o envio (`MINUTOS_SEGUIDAS`). Ela cobre a rodada anterior das regras a cada 30 min, que são as quatro do dono.
- A trava de seguidas fica dentro de `criarTrava`, com a opção `seguidas: { recentes }`. Sem a opção, nada muda: o Catálogo continua chamando como hoje.
- Ordem dentro de `avaliar`:
  1. A lógica atual. Se ela barra, vale o que ela disse.
  2. A mesma linha de uma escolhida deste envio → `{ acao: 'barrar', tipo: 'seguida', anterior: { title, preco: null, sent_at: null } }`.
  3. A mesma linha de um dos `recentes` → o mesmo resultado, com `sent_at` preenchido.

  Até o `liberar` da exceção dos 5% passa pelos passos 2 e 3. Só a seguida com `sent_at` (passo 3) entra na guarda.
- No agendador, a seguida conta em `exec.filtradas.seguidas`. Ela não entra em `exec.puladas` (não gera linha "Pulada") nem em `exec.recusadas` (o cursor não passa por ela).
- **Guarda "não zera o envio"** (decisão do dono):
  - Reserva: `criarEscolha` guarda numa lista `reserva`, em ordem, as candidatas barradas só pelo envio anterior (passo 3). Antes de entrar, cada uma passa pelas mesmas etapas de quem seguiria: catálogo sem motivo de revisão; fonte antiga já resolvida, dentro dos filtros, com a `marca`.
  - Liberação: `escolha.daReserva()` tira a próxima da reserva, avalia de novo com a trava sem os `recentes` (`avaliar(o, { semRecentes: true })`, para o mesmo envio continuar valendo) e a escolhe por `escolher`, que a põe na trava do envio.
  - Contagem: `filtradas.seguidas` desconta 1 por oferta liberada.
  - Chamada no `runRule`: `if (!o && saidas === 0) o = escolha.daReserva();`, logo antes de `:1063`.
  - Chamada na prévia (`pickOffers`): o mesmo, com `picked.length === 0`.
  - Sem linha nova no Histórico: os Docs explicam.
  - Limites: o teto de escolhidas e o orçamento de falhas continuam valendo.
- Fora, todos aprovados pelo dono: o "Enviar" do Catálogo, mas o envio dele já entra nos `recentes` da regra (P4); cruzar regras diferentes que mandam ao mesmo grupo (P2); `reservadaDurante`; Disparo manual, espelho, remetente e Grupo vivo. O mesmo tipo basta para barrar (P3).

## Esquema e contratos
Sem migração. Em `src/parecido.js`:
```
export const MINUTOS_SEGUIDAS = 45;
export const COMUNS_MESMA_LINHA = 2;
export const CABECAS_GENERICAS = new Set([...]);   // kit, jogo, conjunto, combo, par, pack
export const GENERICAS_LINHA = new Set([...]);     // a lista da simulação: público, cor, tamanho, recursos
export function mesmaLinha(a, b) → 'tipo' | 'linha' | null           // títulos (texto)
criarTrava({ ..., seguidas = null })   // seguidas = { recentes: linhas de lerEnviados } ou null (desligada)
  avaliar(oferta, { semRecentes = false } = {})
    → também { acao:'barrar', tipo:'seguida', anterior:{ title, preco:null, sent_at|null } }
```
- `createScheduler({ ..., variedade = false })`. `criarServicos({ ..., variedade = false })` repassa a opção, e só o `main` de `src/server.js` passa `variedade: true`.
- Em `ler()`, com `variedade` ligada: `recentes = lerEnviados(db, rule.id, agora − MINUTOS_SEGUIDAS·60000)`, sempre, sem depender de `dedupe_days`.
- `criarEscolha` devolve `{ proxima, devolver, variasFontes, daReserva }`. `daReserva()` devolve uma oferta escolhida ou null.
- O pedaço novo da `fraseFiltradas` é `${n} da mesma linha de uma oferta recente`. Ele vem depois de "já enviadas ou parecidas" e entra no `total`.

## Etapas
| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 1 | `mesmaLinha` e as constantes. `criarTrava` ganha `seguidas` (mesmo envio pelas `escolhidas`, envio anterior pelos `recentes` nos 45 min, a mesma chave ignorada, `retirar` também desfaz) e `avaliar(…, { semRecentes })`. Testes: a tabela "Prova do critério" inteira; trava sem `seguidas` idêntica à de hoje; seguida ganha de `liberar`; 44 min barra e 46 min não; `semRecentes` ainda barra a mesma linha do mesmo envio; título com 2 palavras não compara | `src/parecido.js`, `test/parecido.test.js` | `node --disable-warning=ExperimentalWarning --test test/parecido.test.js` | dev | A | não | CA1, CA2, CA3, CA6, CA7, CA11 |
| 2 | Agendador: opção `variedade` em `createScheduler`; `ler()` passa `seguidas: { recentes }` quando ela está ligada; `barrada` manda o tipo `seguida` para `filtradas.seguidas` (sem `puladas`); no catálogo, `seguida` não vira `recusadas`; pedaço novo na `fraseFiltradas`. Guarda: `reserva` e `daReserva()` em `criarEscolha`, a chamada no `runRule` (`saidas === 0`) e em `pickOffers` (`picked.length === 0`). `criarServicos` repassa `variedade`, e o `main` passa `true`. Gravar `src/parecido.js` antes (`--watch-path=src`) | `src/scheduler.js`, `src/server.js`, `test/variedade-seguidas.test.js` (novo, `createScheduler({ ..., variedade: true })`) | `node --disable-warning=ExperimentalWarning --test test/variedade-seguidas.test.js` e depois `npm test` (a suíte inteira, sem editar teste: CA8) | dev | B | não | CA1, CA2, CA4, CA5, CA6, CA7, CA8, CA9, CA11 |
| 3 | Docs. README, seção "Ofertas repetidas e parecidas": item "Em seguida". Exemplos: os 4 pares barram, o pet e a Nike não. Contar os 45 min, que o mesmo tipo basta, "pula, não força" quando já saiu uma, a guarda (perfumes: 1 por envio) e que não vale no Catálogo nem no manual. `regras.dedupe` ganha uma frase. `cap-disparos.js` ganha um parágrafo depois de "Produto repetido ou parecido". `cap-referencia.js` põe o pedaço novo na linha "Antes da escolha". `FATOS` ganha 45 (`MINUTOS_SEGUIDAS`) e 2 (`COMUNS_MESMA_LINHA`), e o teste de pedaços (`test/docs.test.js:1812`) ganha "da mesma linha de uma oferta recente" | `README.md`, `public/ajuda.js`, `public/docs/cap-disparos.js`, `public/docs/cap-referencia.js`, `test/docs.test.js` | `node --disable-warning=ExperimentalWarning --test test/docs.test.js` (depois da etapa 2) | dev | B | não | CA10, CA11 |
| 4 | **Feita (lead, 12/11, só leitura).** Regras e fontes do dono; confirmou a regra "feminino", de um tipo só | nenhum | relato do lead | lead | — | não | CA11 |

Testes da etapa 2. Usar o padrão de `test/parecido-regras.test.js`: helpers `montar`, `regraLista`, `semear`, `logs` e `enviadas` (`:53-107`). Os casos:
- (a) Lista com o par AGON e um terceiro item de outro tipo, `per=2`: saem o 1º e o 3º. A linha "Antes da escolha" diz `1 da mesma linha de uma oferta recente`, e não há linha "Pulada".
- (b) `semear` de um JBL Partybox 30 min atrás: o Partybox novo não sai, outro tipo sai. Com 50 min, o JBL sai.
- (c) `per=2`, lista só de "Perfume …", sem envio anterior: sai 1 de 2. A guarda não age, porque já saiu uma.
- (d) **Guarda.**
  - Mesma lista de (c), com `semear` de um "Perfume …" 30 min atrás: sai exatamente 1 perfume (o 1º da lista), e não 0 nem 2.
  - Execuções seguidas a cada 30 min (relógio fixado, como no padrão de `dia()`) mandam 1 por envio.
  - Se a 1ª da reserva for descartada pelo verificador falso, sai a 2ª.
  - Uma candidata barrada por parecida (24 h) com o envio anterior nunca sai pela guarda.
  - A prévia (`pickOffers`) mostra a mesma oferta.
- (e) `dedupe=0`: a trava continua valendo.
- (f) A 1ª escolhida é descartada pelo verificador falso: a da mesma linha volta a valer na mesma execução.
- (g) Catálogo em ordem Novidades: a seguida não avança o cursor (`fonteCatalogo.avancar` recebe a chave como não tratada).
- (h) Sem `variedade`: o par AGON sai junto, como hoje.

## Pontos para o seguranca
Nenhuma etapa é sensível: não há dado pessoal, autenticação, entrada pública, migração nem concorrência nova. Se o `seguranca` for chamado mesmo assim, que confira:
- A linha "Antes da escolha" só leva a contagem, nunca o título.
- `mesmaLinha` roda sobre títulos já normalizados por `palavras()`, sem regex nova sobre texto de terceiro.
- O custo fica em O(candidatas × recentes) com as listas de hoje (centenas × poucas). A `reserva` vive só na execução.

## Riscos e como reverter
- **A regra "feminino" passa de 2 para 1 oferta por envio** (todas do tipo "perfume"). É o comportamento aceito pelo dono. Sem a guarda, seriam 1, 0, 1, 0. Reverter a trava inteira: `variedade: false` no `main` (`src/server.js:875`), uma linha, e o serviço reinicia sozinho.
- **Falso positivo de tipo** ("caixa de som" × "caixa organizadora"; a mesma marca no começo do título, "Apple iPhone" × "Apple Watch"). O custo é a oferta esperar 45 min. O ajuste é nas listas de `src/parecido.js`.
- **A guarda tira a variedade só quando a lista não tem outra opção.** Na Black_Operação, multicategoria, ela quase nunca age.
- **Linha "Saíram X de Y" termina com "não havia mais ofertas novas"** quando o resto foi barrado pela linha. A linha "Antes da escolha", logo antes, explica. Aceito.
- **Sem migração:** reverter é só código. Não existe estado novo no banco.

## Perguntas em aberto e premissas adotadas
Nenhuma pergunta em aberto. Respostas do dono (12/11):
- P1: a guarda "não zera o envio" entra (CA11).
- P2: cruzar regras fica fora.
- P3: o mesmo tipo basta.
- P4: o "Enviar" do Catálogo fica fora.

Premissas que seguem valendo:
- 45 min fixos, e não "o último envio da regra". A janela do último envio, numa regra de um tipo só, travaria para sempre, porque o envio vazio não renova a referência.
- A guarda não escreve linha nova no Histórico. Para o dono, os Docs explicam por que a regra de perfumes manda 1 por envio.

## ADR-019 — Trava da "mesma linha" para ofertas seguidas
**Contexto:** a trava de 24 h (`comparar` com limiar 0,75) não pega produtos da mesma linha com títulos diferentes, e baixar o limiar global barraria ofertas de outros dias.

**Decisão:**
- Uma segunda trava, só para o mesmo envio e os 45 min seguintes, com o critério "mesmo tipo OU 2 palavras distintivas em comum".
- Ela mora em `criarTrava` como opção e conta só na linha "Antes da escolha".
- Guarda "não zera o envio": quando nada sairia, a 1ª barrada só pelo envio anterior sai. Nunca saem duas da mesma linha no mesmo envio.
- Desligada por padrão em `createScheduler` e ligada no `main`, como o verificador.

**Consequências:**
- Sem campo de tela e sem migração, e a suíte atual passa intacta.
- O custo são duas listas de palavras para manter e as regras de um tipo só limitadas a 1 oferta por envio.
