# Especificação de UI/UX: Rodar sozinho, entrega 1 (textos e pontos de tela)

Brief: `docs/produto/briefs/rodar-sozinho.md`, seção "Entrega 1" e "Escolhas minhas". Plano técnico em paralelo (`docs/produto/planos/rodar-sozinho-entrega1.md`): esta spec não depende dele. Só texto de interface. Nenhuma tela nova, nenhum componente novo.

## Objetivo e usuário

Pedro (dono), no computador, quer ligar o Turbo e não vigiar o painel. Quando abrir o Histórico, precisa entender em uma leitura: saiu, não saiu agora (e volta sozinha) ou não vai sair (e por quê). Só chama a revisão o que pede decisão dele.

## Vocabulário único (decisão 2)

Quatro palavras, com o mesmo sentido no Histórico, na revisão, nos `TIPS`/`LEIA_MAIS` e nos Docs. "Pulada" já existe no Histórico do produto parecido ("Pulada: …") e a entrega só amplia o uso; "Descartada" e "Separada para revisão" já existem.

| Palavra | Sentido para o dono | O que ele faz | Prefixo da linha |
|---|---|---|---|
| **Enviada** | Saiu para os grupos. | Nada. | (linha normal do envio) |
| **Pulada** | Não saiu **desta vez** e o problema pode passar (a loja não respondeu, o preço visto está velho, o produto parecido saiu há pouco). Sem revisão. O programa tenta de novo sozinho em outro envio e põe outra oferta no lugar. | Nada. | `Pulada: …` |
| **Descartada** | O programa concluiu que a oferta não serve agora (esgotada, mais cara que o limite, indisponível, a página era de outro produto). Fica 6 horas fora da escolha da regra (a pausa que já existe) e depois pode voltar se o catálogo a trouxer de novo. Sem revisão. | Nada; o Disparo manual serve para forçar. | `Descartada: …` |
| **Separada para revisão** | Espera **decisão dele**: Shopee (até a entrega 4), desconto de 100%, preço antigo exagerado, e o link que falhou até a entrega 2. | Revisar em Histórico > Catálogo. | `Separada para revisão: …` |

Regra de redação: "pulada" e "descartada" nunca vão para a revisão; "revisão" só aparece quando há botão para o dono. A palavra "revisão" não deve aparecer em linha de oferta pulada ou descartada. Cuidado de nome: "Horário 10:00 pulado" (grade e silêncio) é outro caso (horário, não oferta) e fica como está, no masculino e com "Horário" na frente.

Os dois "6 h" são coisas diferentes e os Docs devem dizê-lo: **pausa de 6 horas** (oferta descartada fica fora da escolha, `PAUSA_DESCARTADA_H`) e **reserva de 6 horas** (preço visto há até 6 h vale quando a leitura na hora falha, constante nova). Nos Docs, chamar de "pausa do descarte" e "reserva do preço". Os dois entram em `FATOS`.

## Fluxo (o que o dono vê)

1. Verificador ligado, Amazon no catálogo: a oferta sai sozinha, com o preço lido na hora. Nada na revisão.
2. Se a leitura na hora falha, o preço visto há até 6 h vale (a mensagem sai com a hora real em que foi visto). Mais velho: a oferta é pulada e outra ocupa a vaga.
3. Fim de cada execução que saiu com menos que o pedido: uma linha "Saíram X de Y ofertas" com os motivos.
4. Ligar e desligar o verificador em Ajustes deixam, cada um, a sua linha.

## 1. Textos do Histórico (decisão 1)

Todos nível `aviso` (ponto amarelo mais a palavra, como hoje), exceto a contagem da escolha, que é `info`. Formato de hora no Histórico: o de `quandoDe` ("09:40", ou "09:40 de 10/11" se não for hoje). Na mensagem do WhatsApp, `{HORA_PRECO}` segue `14h32`. Valores em reais como em `brl()` existente.

### Enviadas

| Situação | Texto |
|---|---|
| Amazon, preço conferido na hora pelo Etiqueta, igual ou menor | Sem linha nova (como hoje no Mercado Livre). |
| Idem, mudou dentro do limite | Mantém o sufixo que já existe: `· preço atualizado de R$ 89,90 para R$ 91,00`. |
| Enviada pela reserva (leitura falhou, preço visto há até 6 h) | Sufixo na linha do envio: `· preço visto às 09:40, não conferido agora (o Etiqueta não respondeu)` |

A causa entre parênteses vem de `CAUSAS`, ver adiante. O sufixo da reserva substitui "preço não conferido (causa)" para a Amazon: o dono vê a hora e entende a idade do dado.

### Puladas (sem revisão, podem voltar)

| Situação | Texto |
|---|---|
| Leitura falhou e `preco_em` com mais de 6 h | `Pulada: o preço visto às 02:10 de 10/11 tem mais de 6 h e não deu para conferir agora (a Amazon bloqueou a leitura). Tenta de novo no próximo envio.` |
| Leitura falhou e sem `preco_em` ou com data inválida | `Pulada: não deu para conferir o preço agora (o Etiqueta não respondeu) e a oferta não diz quando o preço foi visto. Tenta de novo no próximo envio.` |
| Mercado Livre: conferência falhou por causa passageira | `Pulada: não deu para conferir o preço (a extensão do Chrome não está conectada). O Mercado Livre não sai sem conferir; tenta de novo no próximo envio.` |
| Preço impossível de conhecer (`sem_preco`, `varias_versoes`) | `Pulada: não dá para saber o preço (a página não trouxe o preço). Fica 6 h fora da escolha desta regra.` (a causa troca por "o produto tem várias versões e o link não diz qual") |

O trecho final "Tenta de novo no próximo envio" só vale onde a oferta pode mesmo voltar; se o plano mantiver pausa em algum caso, trocar por "Fica 6 h fora da escolha desta regra" (mesma frase da última linha).

### Descartadas (sem revisão, 6 h fora)

Mantêm o padrão `Descartada: …` de `MOTIVOS_VERIFICADOR` e já presentes:

- `Descartada: esgotado na loja`
- `Descartada: preço subiu de R$ 89,90 para R$ 99,90 (+11%, o limite é 5%)`

Novos (o do "outro produto" e o "indisponível" são os dois resultados novos do Etiqueta):

- `Descartada: indisponível na loja (a página não mostra preço nem estoque)`
- `Descartada: a página da loja abriu outro produto (o código não confere com a oferta)`

Evitar "ASIN" e "bloqueio" na frase: o dono não lê isso. "Indisponível" não é "esgotado" (a Amazon não diz qual dos dois); manter as duas frases.

### Regra saiu com menos que o pedido (CA1.8)

Generaliza a linha que hoje só existe nos horários marcados ("Saíram 2 de 3 ofertas; …"). Mesmo molde, para todas as regras:

`Saíram 2 de 3 ofertas; 1 pulada (preço sem conferência), 1 descartada (esgotada na loja).`

Pedaços, na ordem fixa pulada, descartada, separada para revisão, só os que tiverem número:
- `N pulada(s) (motivo)`; `N descartada(s) (motivo)`; `N separada(s) para revisão`.
- Dois motivos diferentes do mesmo tipo viram `2 descartadas (1 esgotada na loja, 1 preço subiu)`.
- Faltou candidata depois de repor: acrescentar `; não havia mais ofertas novas dentro dos filtros` (já existe).
- Parada por silêncio ou teto: continua a frase atual (`…; começou o horário de silêncio.`), sem duplicar.
- Singular e plural corretos ("1 oferta" não aplica aqui porque a frase usa "de Y ofertas"; manter "Saíram 1 de 3 ofertas").

Tipo: `aviso`. Aviso de produto parecido (`Pulada: …` por conflito) continua com a linha própria; na contagem entra como "pulada (produto parecido)".

### Candidatas filtradas antes da escolha (uma linha por execução)

`info`. Só aparece quando houve filtradas; sem filtradas, sem linha. Modelo:

`Antes da escolha, 14 ofertas ficaram de fora: 6 fora dos filtros da regra, 5 já enviadas ou parecidas, 3 em pausa por descarte.`

Categorias em palavras (o plano nomeia): fora dos filtros da regra, já enviadas ou parecidas com outra, em pausa por descarte recente. Só entram as com número maior que zero, separadas por vírgula. Esta linha não substitui "Sem ofertas novas dentro dos filtros desta vez." (execução sem nenhuma candidata): quando as duas valem, sai só uma, a da contagem, terminando com `Nenhuma sobrou.`

### Verificador ligado e desligado (CA1.9)

- Desligar, mantém: `Verificador desligado em Ajustes (por Ana)`.
- Ligar, novo: `Verificador ligado em Ajustes (por Ana)`. Mesmo nível `aviso` e mesma regra do "(por …)" só com login ligado. Nota de nível: ligar não é alerta, mas um nível só evita criar filtro novo no Histórico.

## 2. Causas novas entre parênteses (`CAUSAS`)

Frase fixa, minúscula, sem ponto, no padrão de `CAUSAS`. Não usar "bloqueio", "captcha", "rede":

| Situação | Causa |
|---|---|
| Etiqueta fora do ar ou sem resposta | `o Etiqueta não respondeu` |
| Amazon barrou a leitura (bloqueio ou captcha) | `a Amazon bloqueou a leitura` |
| Falha de rede na leitura | `a loja não respondeu` (já existe) |
| Leitura demorou além do prazo | `a loja demorou demais` (já existe) |

A causa `amazon_sem_api` ("a API da Amazon não está ligada") deixa de aparecer na Amazon do catálogo: sai de `CAUSAS` se nenhum outro caminho a usa (Disparo manual e agendado ainda podem; ver Perguntas).

## 3. Revisão do catálogo (decisão 2 e 5)

- `nao_conferido` sai do que o dono vê na revisão: a linha "Não deu para conferir o preço: confira na loja" (`public/espelhamento.js:571`, `TEXTOS_REVISAO_CATALOGO`) vira inalcançável depois da migração. Manter o texto no código enquanto o motivo existir em `MOTIVOS` (item antigo ou rollback); remover só se o plano apagar o motivo.
- A linha do Histórico `Separada para revisão: não deu para conferir o preço (…)` (`TEXTO_MOTIVO.nao_conferido`) deixa de ser gerada. Não deve restar texto de "não deu para conferir" com prefixo "Separada para revisão" em lugar nenhum.
- Sem mudança além de texto em nenhuma tela. O chip `n para revisar` (`public/app.js:203`, cartão da regra), o contador "Histórico (n)" do menu e a lista da revisão só mostram números menores depois da migração; a estrutura serve. Nenhum componente novo, nenhum estado novo.
- Estado vazio da revisão (quando todos os itens eram `nao_conferido` e saíram): conferir que o texto de vazio existente já cobre ("Nada esperando revisão" ou equivalente); sem texto novo se cobrir.

## 4. Ajuda do verificador em Ajustes (decisão 3)

Onde: `TEXTOS_VERIFICADOR.sub` em `public/app.js:18`, e `TIPS['ajustes.verificador']` em `public/ajuda.js:106`. Hoje ambos dizem "se a loja não responder, a oferta só sai se os dados forem de até 30 min", o que fica errado para a Amazon.

`TEXTOS_VERIFICADOR.sub` (sob o título, curto):

> Logo antes de enviar, o programa lê o preço e o estoque na loja. Esgotado ou mais caro que o limite: a oferta não sai e o Histórico diz o motivo. Na Amazon, o Etiqueta relê a página do produto na hora. Se essa leitura falhar, vale o último preço visto, desde que tenha até 6 horas; mais velho, a oferta é pulada e outra ocupa a vaga.

`TIPS['ajustes.verificador']` (balão `?`, um pouco mais completo):

> Antes de cada envio o programa confere o preço e o estoque. Esgotada, indisponível ou com o preço acima do limite: a oferta é descartada e o Histórico diz o motivo. Preço menor: sai com o preço novo. Amazon: o Etiqueta relê a página só do produto escolhido, na hora. Se a leitura falhar, vale o preço visto há até 6 horas; passou disso, a oferta é pulada (volta depois, sem revisão). Mercado Livre: conferido pela extensão do Chrome e nunca sai sem conferência. Outras lojas: se a loja não responder, só sai se os dados forem de até 30 min.

`TEXTOS_VERIFICADOR.desligado` (`public/app.js:19`) fica. `TEXTOS_VERIFICADOR.horaPreco` e o `TIPS` de `{HORA_PRECO}` mudam (CA1.6):

> `{HORA_PRECO}`: a hora em que o preço foi visto na loja, como 14h32 (na hora do envio ou, se a leitura falhou, a do último preço visto). Use dentro de [ ] para a frase sumir quando não houver hora, e não na linha do {LINK}. Ex.: [🕒 Preço visto às {HORA_PRECO}]

Obs.: "foi conferido" vira "foi visto", porque pode ser a reserva. `public/docs/cap-disparos.js:34,69-71` e o README têm a mesma frase.

## 5. Docs, `TIPS`, README (decisão 4)

Procure a grafia antiga com `grep -rn "não deu para conferir\|API da Amazon não está ligada\|Separada para revisão\|na revisão" public/docs public/ajuda.js README.md`.

| Arquivo | Entrada | Mudança |
|---|---|---|
| `public/ajuda.js:31` `fonte.catalogo` | tira "e as que não deu para conferir o preço na loja" da lista da revisão; acrescenta: "O preço da Amazon é lido na hora; se a leitura falhar e o preço visto tiver mais de 6 h, a oferta é pulada, sem revisão." |
| `public/ajuda.js:35` `fonte.catalogo.revisao` | tira "se não deu para conferir o preço na loja (confira na loja antes de enviar)". Acrescenta uma frase: "Oferta pulada ou descartada na conferência não vem para cá." |
| `public/ajuda.js:106-107` | texto da seção 4. Atualizar também `'ajustes.verificador'` do mapa de `LEIA_MAIS` se o título do capítulo mudar. |
| `public/docs/cap-conta.js:~383-420` (capítulo "Conferir preço e estoque antes de enviar", id `verificador`) | tabela de casos (linhas 399-406): trocar as duas últimas linhas por quatro: "A loja não respondeu, dados de até 30 min (outras lojas)" mantém; "A loja não respondeu, dados mais velhos (outras lojas)": "Não envia. No Catálogo, a oferta é pulada, sem revisão." Acrescentar linha "Amazon: o Etiqueta relê o preço na hora" (preço lido: regra de sempre), "Amazon: leitura falhou, preço visto há até 6 h" (envia com a hora do preço), "Amazon: leitura falhou, preço mais velho ou sem hora" (pulada). Parágrafo 408: tirar "a do Catálogo vai para a revisão"; Catálogo ganha idade (`preco_em`). Nova nota explicando reserva e pausa (dois "6 h" distintos). Parágrafo 420 (pausa) fica, citando o Catálogo. Parágrafo do desligar/ligar: dizer que ligar também deixa linha. Passos 415-416 ok. |
| `public/docs/cap-referencia.js:165-181` `motivos` | remover a linha "Não deu para conferir o preço: confira na loja" (a do `nao_conferido`) e acrescentar parágrafo "Pulada, descartada e separada para revisão" com a tabela de vocabulário acima. |
| `public/docs/cap-referencia.js:196-203` | tabela "Resultados da conferência": a linha "Descartada: não deu para conferir o preço" fica só para as outras lojas e Disparo manual; acrescentar linhas "Pulada: o preço visto às … tem mais de 6 h…", "Descartada: indisponível na loja…", "Descartada: a página da loja abriu outro produto…", "Saíram X de Y ofertas…" e a linha do envio pela reserva. |
| `public/docs/cap-referencia.js:59` glossário "Verificador" | acrescenta "Na Amazon, relê o preço na hora; se falhar, vale o preço de até 6 h." Acrescentar verbetes "Pulada" e "Descartada" no glossário. |
| `public/docs/cap-amazon-revisao.js:~140-154` | tabela de motivos: remover a linha do `nao_conferido`; parágrafo 154: trocar o exemplo "Separada para revisão: não deu para conferir o preço (a loja não respondeu)" por "Pulada: o preço visto às 02:10 de 10/11 tem mais de 6 h e não deu para conferir agora (a Amazon bloqueou a leitura)", e dizer que pulada e descartada não vêm para a revisão. |
| `public/docs/cap-disparos.js:34,69-71` | `{HORA_PRECO}`: "hora em que o preço foi visto", fica vazio só se não houve hora. |
| `public/docs/cap-disparos.js:252` | tira "ou cujo preço não deu para conferir na loja" da lista do que espera revisão; acrescenta frase sobre pulada. |
| `public/docs/cap-disparos.js` (capítulo do Histórico/regra) | uma frase nova "Saíram X de Y" e outra para a linha da contagem das candidatas, com exemplos. Se não houver capítulo do Histórico de regra, pôr em `cap-disparos.js` perto do parágrafo 252. |
| `README.md:~314-320` | mesmo conteúdo do capítulo `verificador`: Amazon na hora, reserva de 6 h, ligar também deixa linha, `{HORA_PRECO}`. |
| `test/docs.test.js` | `FATOS`: acrescentar `reserva do preço` (6, texto `/reserva de 6 h(?:oras)?/` ou como o plano redigir, constante nova em `src/`) e `pausa do descarte` (6, `PAUSA_DESCARTADA_H` em `src/verificador.js`). Os testes das linhas 1633-1636 (`TEXTO_MOTIVO.nao_conferido` e a frase "Separada para revisão: não deu para conferir o preço") precisam acompanhar a remoção (é o `dev` quem troca). |

Número novo: "3 vezes o número de vagas" de tentativas de reposição **não** vai ao dono: é detalhe. Se um Doc o citar, entra em `FATOS`.

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| Linha do Histórico (nível `aviso`/`info`) | Existente | `public/app.js` (Histórico) |
| Chip "n para revisar", menu "Histórico (n)" | Existente, sem mudança | `public/app.js:203,332,1022` |
| Cartão do verificador | Existente, só texto | `public/app.js:15-25,773+` |
| Tabelas e notas dos Docs | Existentes | `public/docs/cap-*.js` |

## Estados

Sem estado visual novo: nenhum selo, cor ou ícone. A diferença entre pulada, descartada e revisão se faz por **palavra** no começo da linha (a cor nunca é o único sinal: o ponto amarelo já vem com texto). Estados de conteúdo a conferir: linha longa (título longo mais causa mais motivo: quebrar, sem rolagem horizontal), 0 motivos (some o parêntese), vários motivos iguais agrupados na contagem.

## Acessibilidade

- Texto de ajuda do `?` em `TIPS` segue o padrão existente (balão aberto por teclado, `aria-describedby`); sem mudança de marcação.
- Frases de Histórico entendíveis sem o ponto de cor: começam pela palavra de estado (`Pulada:`, `Descartada:`, `Saíram`).
- Sem jargão: "Etiqueta", "ASIN", "captcha", "preco_em" e "reserva" não aparecem em linha de Histórico (só na ajuda, e "reserva" só entre aspas nos Docs).

## O que o dev precisa implementar

1. Frases das seções 1 e 2 (constantes em `src/scheduler.js` e `src/verificador.js`; o `designer` não edita aqui). Ajustar `TEXTO_PERMITIDO` em `test/verificador.test.js:39` (a regex que limita o que o verificador pode escrever) para as frases novas.
2. Linha "Saíram X de Y" para todas as regras, e a linha de contagem das candidatas.
3. Linha ao ligar o verificador (`src/server.js:365-369`), simétrica à de desligar (`AVISO_VERIFICADOR_DESLIGADO`).
4. Textos de `public/app.js` (`TEXTOS_VERIFICADOR`), `public/ajuda.js` e dos Docs listados na seção 5, mais `FATOS`.
5. Remover `nao_conferido` da revisão do Catálogo (comportamento, no plano); manter o texto de `TEXTOS_REVISAO_CATALOGO` se o motivo continuar em `MOTIVOS`.

O `designer` pode escrever os textos nos arquivos `public/` e `docs/` e o `dev` os de `src/` e `test/`: **nunca ao mesmo tempo no mesmo arquivo** (`test/docs.test.js` é compartilhado).

## Arquivos de apresentação afetados

`public/app.js` (`TEXTOS_VERIFICADOR`), `public/ajuda.js`, `public/espelhamento.js` (só se o motivo sair), `public/docs/cap-conta.js`, `public/docs/cap-referencia.js`, `public/docs/cap-amazon-revisao.js`, `public/docs/cap-disparos.js`, `README.md`.

## Perguntas em aberto

1. **Disparo manual e envio agendado da Amazon**: CA1.11 diz que nada muda no manual. Eles continuam com "Descartada: não deu para conferir o preço (a API da Amazon não está ligada)" (`public/disparos.js:72`, selo "Descartado")? Fica incoerente com o Catálogo, que passa a reler na hora. Sugestão: dizer isso no Doc e abrir tarefa à parte; não resolver aqui.
2. **Linha de contagem das candidatas**: a cada 5 min ou 15 min por regra enche o Histórico. Sugestão: nível `info` e sem linha quando o resultado for igual ao da execução anterior; o plano decide.
3. **Pulada com "tenta de novo no próximo envio"**: só é verdade se a oferta não ficar em pausa. Se o plano pausar a oferta (6 h) também no caso de leitura falha, usar a frase de pausa em todas.
4. **Nome "Etiqueta" na frase "o Etiqueta não respondeu"**: o dono usa o nome; manter. Artigo masculino como no brief.
5. Texto exato do sufixo da reserva ("preço visto às 09:40, não conferido agora") pode ficar longo na linha do envio por grupo; se estourar a largura no celular, quebrar a linha (não cortar).
