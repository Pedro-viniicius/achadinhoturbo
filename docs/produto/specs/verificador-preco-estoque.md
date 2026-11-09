# Especificação de UI/UX: verificador de preço e estoque

Card "07 · Verificador: preço e estoque conferidos logo antes do envio". Plano em paralelo: `docs/produto/planos/verificador-preco-estoque.md` (arquiteto). Só apresentação: nomes de campo, rotas e regra ficam com o arquiteto; o que depende dele vem marcado **[ARQ]**. Decisões já tomadas (o dono disse "a equipe faz sozinha") estão marcadas **[DECIDIDO]**. Tokens novos: nenhum.

## Objetivo e usuário

Pedro (dono), no computador, com pressa, sem jargão. Quer que o grupo nunca receba oferta esgotada ou com preço mais caro do que o anunciado, sem precisar conferir à mão. Quer ver, no Histórico, por que uma oferta não saiu.

## Fluxo

1. Dono liga o verificador em **Ajustes** (já vem ligado) e, se quiser, muda o limite de alta e o que fazer quando a loja não responde.
2. Na hora de enviar cada oferta (disparo automático, remetente, espelhamento, catálogo, agendado, repetição, Disparo manual), o programa relê preço e estoque na loja.
3. Resultado, por oferta:
   - **Tudo certo** (em estoque; preço igual, menor, ou maior até o limite): envia **com o preço recém-lido**. Se o template tiver `{HORA_PRECO}`, a mensagem diz a hora da leitura.
   - **Esgotado**: não envia; registra no Histórico.
   - **Preço subiu além do limite**: não envia; registra com os dois preços.
   - **Loja não respondeu**: faz o que o dono escolheu em Ajustes (padrão: envia mesmo assim, registrando "preço não conferido").
4. Um descarte nunca para os outros: a próxima oferta do ciclo segue normalmente. **[ARQ]** confirmar.

## Decisões [DECIDIDO]

| # | Decisão | Por quê |
|---|---|---|
| 1 | Verificador **ligado por padrão**. | É a proteção que o dono pediu; desligar é a exceção. |
| 2 | Limite de alta padrão **5%**, inteiro de 0 a 100. 0 = qualquer alta descarta. | Preço de loja oscila pouco; mais que 5% já surpreende o grupo. |
| 3 | Preço que **caiu** ou ficou igual: envia com o preço novo, sem descartar. | Não prejudica o grupo; o preço certo é o da loja. |
| 4 | Loja sem resposta: duas opções, **padrão "Enviar mesmo assim"**. | A lentidão da loja não pode parar o disparo inteiro; o Histórico mostra que não foi conferido. |
| 5 | `{HORA_PRECO}` entrega só a hora (`14h32`). A frase fica no template, de preferência entre `[ ]`. | Segue os outros campos (valor puro, texto fixo no template) e a frase some sozinha quando não há hora. |
| 6 | Os templates existentes **não** são alterados. O dono acrescenta a linha se quiser. | Não mexer na mensagem que ele já aprovou. |
| 7 | Motivos novos usam o mesmo padrão de frase `Descartada: <motivo>` já usado em Espelhamento e Remetente; nível **aviso** (ponto amarelo + palavra), nunca só cor. | Consistência; o filtro "Só avisos" já existe. |
| 8 | No Disparo manual, a barrada tem saída: "Enviar mesmo assim" (o dono sabe mais que a leitura da loja). No automático não há. | Manual é decisão consciente; automático é sem supervisão. |

## Layout (mobile e desktop)

Sem página nova. Quatro pontos de contato, todos no padrão existente (`.card` em grade de 1 coluna, `.grade` só para campos curtos, `.linha` com `flex-wrap`).

### 1. Ajustes: novo cartão (`paginaAjustes`, `public/app.js`)

Entre "Título do produto na mensagem" e "Como gerar o link de afiliado". Mesma estrutura dos cartões vizinhos: `<div class="card" style="display:grid;gap:14px">`.

```
Conferir preço e estoque antes de enviar  (?)
[ chave ] Conferir antes de cada envio                 <- label.chave + texto, aria-label próprio
Logo antes de enviar, o programa lê o preço e o estoque na loja. Esgotado ou preço mais caro que o limite: não envia e avisa no Histórico.

[Aceitar alta de preço até (%)  ][ 5 ]   (?)     [Se a loja não responder  v]   (?)
 0 = qualquer alta descarta a oferta.             Enviar mesmo assim / Não enviar
[Salvar]  <small status "Salvo.">
```

- A chave usa `label.chave` com `<input type="checkbox">` e o texto "Conferir antes de cada envio" **ao lado, visível** (o `title` sozinho não basta). `aria-label` não é necessário se o texto for um `<label>`; se a chave ficar dentro do `h2` como nos cartões de lista, usar `aria-label="Conferir preço e estoque antes de enviar"`.
- Chave **desligada**: os dois campos ficam `disabled` (não escondidos), com `<small class="dica">` "Desligado: as ofertas saem sem conferir preço nem estoque." Salvar continua habilitado.
- Campos em `.grade` (2 colunas em desktop, 1 em 375 px). O select e o número são `label.campo` com `<small>` ligada por `aria-describedby`.
- Só quem tem permissão para os outros Ajustes muda. **[ARQ]** definir: se a rota `PUT /ajustes` deste grupo for só do Dono, seguir o padrão de `SO_DONO_DICA`: campos `disabled` e `<small class="dica">Só o Dono muda a conferência de preço.</small>`.

### 2. Histórico (todas as visões)

Sem coluna nova. O motivo entra na frase do Resultado, como já acontece.

- **Histórico geral** (`paginaHistorico`, `<span class="nivel-aviso">` com a mensagem do log).
- **Espelhamento e Remetente** (`espResultado`, `remResultado` em `public/espelhamento.js` e `public/remetentes.js`): o `case 'descartado'` já imprime `Descartada: ${motivo}`. O servidor grava o motivo; o painel não muda a lógica. **[ARQ]** gravar o motivo como status `descartado` com texto abaixo (não `erro`).
- **Catálogo**: oferta barrada pelo verificador **não** vai para a fila de revisão (revisão é para o que exige decisão do dono; aqui a loja já disse que não vale). Aparece como `Descartada: <motivo>`.
- **Disparo manual** (`dispPill` em `public/disparos.js`): novo status `descartado` → `<span class="estado-pill pausado">Descartado</span>` seguido do motivo em `<span class="dica-celula trunca" title="<motivo>">`, igual ao padrão do selo "Erro".

### 3. Templates (`public/app.js`, `paginaTemplates`)

O chip `{HORA_PRECO}` aparece sozinho na fila de chips (vem de `S.st.placeholders`). Acrescentar, logo abaixo da linha de chips e antes da dica do WhatsApp, uma `<small class="dica">` (texto visível, não só tooltip):

> {HORA_PRECO}: a hora em que o preço foi conferido na loja, como 14h32. Use dentro de [ ] para a frase sumir quando não houver hora. Ex.: [🕒 Preço visto às {HORA_PRECO}]

**Prévia:** a amostra de `/templates/preview` ganha `HORA_PRECO` = `14h32`, para a linha aparecer no balão. **[ARQ]** (amostra no servidor).

### 4. Disparo manual (`public/disparos.js`)

Veja "Estados". O aviso entra dentro do cartão da oferta, **acima do botão Disparar** e abaixo do erro de formulário (mesmo lugar de `dispErros`), como `.aviso-impl` (ponto de exclamação textual, borda e texto, não só cor).

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| Cartão de Ajustes | Existente (padrão `.card` grid) | `public/app.js`, `paginaAjustes` |
| Chave liga/desliga `label.chave` | Existente | `public/style.css:80` |
| `label.campo` com `input number` e `select` | Existente | `public/style.css` |
| `.aviso-impl` (aviso da barrada) | Existente | `public/style.css:272` |
| `.estado-pill.pausado` + `.dica-celula` | Existente | `public/style.css:300`, `public/disparos.js` |
| Chip de placeholder `{HORA_PRECO}` | Existente (automático) | `public/app.js` |
| Textos do verificador | Novo objeto `TEXTOS_VERIFICADOR` | `public/app.js` junto de `SO_DONO_DICA` (Ajustes e Templates) e `public/disparos.js` (manual) |

Nada de CSS novo. O botão "Enviar mesmo assim" usa `button.leve`.

## Estados

**Cartão de Ajustes**

| Estado | Comportamento |
|---|---|
| Padrão | Chave ligada, limite 5, "Enviar mesmo assim". |
| Desligado | Campos `disabled` + dica de que as ofertas saem sem conferir. |
| Salvando | Botão com `disabled` e texto "Salvando…". |
| Sucesso | `aviso('Conferência salva')` (toast existente), foco no botão. |
| Erro de campo | Limite vazio, negativo, maior que 100 ou decimal: mensagem sob o campo (`aria-describedby`, `nivel-erro`): "Informe um número inteiro de 0 a 100." Foco no campo. O servidor também valida. |
| Erro do servidor | Toast de erro padrão (`tentar`). |
| Somente leitura | Campos `disabled` e dica (se **[ARQ]** disser que é só do Dono). |

**Resultado no Histórico** (texto exato da coluna Resultado; "motivo" é o trecho depois de "Descartada:")

| Caso | Texto | Nível |
|---|---|---|
| Esgotado | `Descartada: esgotado na loja` | aviso |
| Preço subiu além do limite | `Descartada: preço subiu de R$ 89,90 para R$ 99,90 (+11%, o limite é 5%)` | aviso |
| Não deu para conferir e a regra é "Não enviar" | `Descartada: não deu para conferir o preço (a loja não respondeu)` | aviso |
| Não deu para conferir e a regra é "Enviar mesmo assim" | Oferta fica como enviada; o detalhe da linha ganha ` · preço não conferido (a loja não respondeu)` | ok, com detalhe |
| Conferida e enviada com preço novo | Sem texto extra no Histórico geral; **[ARQ]** opcional: detalhe ` · preço atualizado de R$ 89,90 para R$ 91,00` quando mudou | ok |

Preços formatados em reais com vírgula (`brl`). Percentual arredondado para inteiro, nunca "+0%" (se arredondar para 0, mostrar uma casa: "+0,4%"). Título longo da oferta segue o `trunca` existente.

**Disparo manual: oferta barrada na hora**

Aviso `.aviso-impl` `role="alert"` (anunciado ao aparecer), foco no primeiro botão do aviso. O botão Disparar volta ao estado normal para o dono tentar de novo.

| Caso | Texto do aviso | Botões |
|---|---|---|
| Esgotado | "Não enviei: este produto está esgotado na loja. Confira o produto antes de tentar de novo." | `Enviar mesmo assim` (leve) |
| Preço subiu | "Não enviei: o preço na loja subiu de R$ 89,90 para R$ 99,90 (+11%, o limite é 5%)." | `Usar R$ 99,90` (preenche o campo Preço e o dono clica em Disparar), `Enviar mesmo assim` (leve) |
| Loja não respondeu (só se a regra for "Não enviar") | "Não deu para conferir o preço agora: a loja não respondeu." | `Tentar de novo`, `Enviar mesmo assim` (leve) |

- "Enviar mesmo assim" pede confirmação **não modal** em uma linha, sem diálogo extra: o botão vira "Confirmar envio sem conferir" por 5 s, depois volta (padrão de dois cliques; texto do botão muda, então vale para leitor de tela).
- O disparo barrado entra no Histórico do Disparo manual com selo `Descartado` e o motivo (acima).
- Agendar (Disparo manual): sob o campo de horário, `<small class="dica">O preço e o estoque são conferidos na hora do envio, não agora.</small>` (só se o verificador estiver ligado). Se a conferência barrar no horário, vira linha de Histórico com o selo `Descartado`; não há aviso na tela.
- Verificador desligado em Ajustes: nenhum aviso, nenhum texto novo no manual.

**Template**: `{HORA_PRECO}` vazio (verificador desligado, loja sem resposta enviada mesmo assim) → a linha ou o trecho entre `[ ]` some, pelo mecanismo existente. Sem o `[ ]`, a linha inteira some só se o único campo dela for `{HORA_PRECO}`; do contrário sobra o texto fixo ("Preço visto às "). Por isso a dica e os Docs recomendam sempre o colchete.

## Textos da interface

Ajustes (`TEXTOS_VERIFICADOR`):

- Título do cartão: `Conferir preço e estoque antes de enviar`
- Chave: `Conferir antes de cada envio`
- Sub: `Logo antes de enviar, o programa lê o preço e o estoque na loja. Esgotado ou preço mais caro que o limite: a oferta não sai e o motivo aparece no Histórico.`
- Desligado: `Desligado: as ofertas saem sem conferir preço nem estoque.`
- Campo limite: `Aceitar alta de preço até (%)`; dica: `0 = qualquer alta descarta a oferta. Preço que caiu sempre pode sair.`
- Campo falha: `Se a loja não responder`; opções: `Enviar mesmo assim` e `Não enviar`; dica: `Enviar mesmo assim: sai sem a hora do preço e o Histórico avisa “preço não conferido”. Não enviar: a oferta é descartada.`
- Botão: `Salvar conferência`
- Sucesso: `Conferência salva`
- Erro do limite: `Informe um número inteiro de 0 a 100.`
- Só Dono (se aplicar): `Só o Dono muda a conferência de preço.`

Disparo manual: os textos da tabela acima mais `Tentar de novo`, `Usar R$ {preço}`, `Enviar mesmo assim`, `Confirmar envio sem conferir`, e a dica de agendamento.

Templates: a dica do `{HORA_PRECO}` (acima).

Ajuda `?` (`TIPS` em `public/ajuda.js`, alinhadas ao bloco "ajustes."):

- `'ajustes.verificador'`: `Antes de cada envio o programa lê o preço e o estoque na loja. Se estiver esgotado ou o preço subiu mais que o limite, a oferta não sai e o Histórico diz o motivo. Se o preço caiu, sai com o preço novo.`
- `'ajustes.verificador.limite'`: `Quanto o preço pode ter subido, em %, desde a oferta que você viu. Padrão 5. Acima disso a oferta é descartada. 0 = qualquer alta descarta.`
- `'ajustes.verificador.falha'`: `O que fazer quando a loja não responde a tempo. “Enviar mesmo assim” (padrão) não trava o disparo, mas a oferta sai sem conferir. “Não enviar” descarta a oferta.`
- `'templates.hora_preco'` (opcional, no `?` do título "Templates" não; fica só a dica visível): não criar.
- Acrescentar ao final de `'regras.template'` nenhuma mudança (texto já geral).

`LEIA_MAIS` (`public/ajuda.js`, destino `capitulo/secao`, só minúsculas e hífen):

- `'ajustes.verificador': 'manutencao/verificador'`
- `'ajustes.verificador.limite': 'manutencao/verificador'`
- `'ajustes.verificador.falha': 'manutencao/verificador'`

## Acessibilidade

- Chave com texto visível e foco visível (a regra `.chave input:focus-visible` existente deve cobrir; conferir). Alvo 44×44 px no celular (a chave é 42×24 com área do `label` maior; manter o texto dentro do label para clicar nele).
- Campos desabilitados mantêm contraste legível (≥ 3:1 para o rótulo, que continua visível) e a dica explica **por que** estão desabilitados, sem depender de cor.
- Número com `inputmode="numeric"`, `min=0 max=100 step=1`, rótulo `label` real, erro ligado por `aria-describedby` e `aria-invalid`.
- Selo `Descartado` e `nivel-aviso`: palavra + ponto; contraste já coberto pelos tokens.
- Aviso do manual: `role="alert"`, texto antes do botão na ordem do DOM, foco no primeiro botão; "Esc" não é necessário (não é diálogo).
- Confirmação do "Enviar mesmo assim" por troca de texto do botão (anunciada ao receber foco de novo); sem limite de tempo que impeça o uso: se o texto voltar, basta clicar de novo.
- Sem animação nova (nada a respeitar em `prefers-reduced-motion`).
- Linhas de texto ≤ 75 caracteres (`.sub` já limita).

## O que o dev precisa implementar

1. `public/app.js`: cartão em `paginaAjustes` (HTML, validação do campo, estados, salvar via `PUT /ajustes` com os campos que o **[ARQ]** definir, `aviso`); dica visível do `{HORA_PRECO}` em `paginaTemplates`; `TEXTOS_VERIFICADOR`.
2. `public/disparos.js`: aviso da barrada com os três casos e os botões, dica no agendar, status `descartado` em `dispPill`, reenvio "mesmo assim" (**[ARQ]**: flag no corpo do envio e código de resposta que diferencie esgotado, preço e sem resposta, com os dois preços).
3. `public/espelhamento.js` e `public/remetentes.js`: **sem mudança esperada** (já imprimem `Descartada: <motivo>`); conferir que o status `descartado` com os motivos novos cai nesse `case` e não em "Não espelhada"/"Não saiu".
4. `public/ajuda.js`: três `TIPS` e três `LEIA_MAIS`.
5. Servidor (**[ARQ]**, não é do designer): textos dos motivos exatamente como na tabela de Resultado; `HORA_PRECO` em `PLACEHOLDERS` e na amostra da prévia; formato `HHhMM` no fuso do servidor.
6. Docs e README (abaixo) e, em `test/docs.test.js`, entrada em `FATOS` para o limite padrão (5%) se o número aparecer nos dois lugares (README e capítulo).

## Docs: onde cada coisa entra

- **`public/docs/cap-conta.js`, capítulo `manutencao`**: nova seção `{ id: 'verificador', titulo: 'Conferir preço e estoque antes de enviar', onde: '[[Ajustes → Conferir preço e estoque antes de enviar]]' }` (o `LEIA_MAIS` aponta para `manutencao/verificador`). Conteúdo: o que confere, tabela dos 3 resultados (envia com preço novo / esgotado / subiu / loja não respondeu) e o passo a passo dos campos. Citar o padrão 5% e a decisão "loja sem resposta".
  Na seção `ajustes` ("Ajustes: pausas e limites"): atualizar a frase "Os cartões são: …" para incluir "conferência de preço e estoque", e acrescentar à tabela as duas linhas do novo cartão (limite 5; falha "Enviar mesmo assim").
- **`public/docs/cap-disparos.js`**:
  - seção `templates/campos`: nova linha na tabela `` `{HORA_PRECO}` | A hora em que o preço foi conferido na loja, como 14h32. Fica vazio se a conferência estiver desligada ou a loja não responder. `` e, em `templates/opcional`, um exemplo `[🕒 Preço visto às {HORA_PRECO}]`;
  - seção `disparo-manual`: nova subseção (ou bloco ao fim de `mercado-livre`/`agendar`) "Oferta barrada na hora" com a tabela de 3 casos e os botões; em `agendar`, uma frase "a conferência acontece na hora do envio".
- **`public/docs/cap-referencia.js`, seção `motivos`**: nova tabela "Resultados da conferência de preço e estoque" com as linhas da tabela de Resultado (colunas "Resultado / Quando acontece / O que fazer"): esgotado ("Confira o produto; se voltou a ter estoque, use o Disparo manual"), preço subiu ("Se o novo preço ainda vale, suba o limite em Ajustes ou use Disparo manual"), não conferido ("Nada; se acontece sempre, confira a conexão com a loja em Conexões"). Ajustar o `onde` da seção para incluir `[[Histórico]]`. Na seção `limites`: linha "Alta de preço aceita" com `padrão 5%, de 0 a 100` e coluna "Onde muda" `[[Ajustes → Conferir preço e estoque antes de enviar]]`. Glossário: termo "Verificador" (`Conferência de preço e estoque feita logo antes do envio`) em "Disparos".
- **`README.md`**: parágrafo do verificador (o que confere, o limite padrão, o que acontece quando a loja não responde, o campo `{HORA_PRECO}`).
- Selo novo em `public/conexoes.js`: **nenhum**. `MOTIVOS` de `src/catalogo-itens.js`: **sem mudança** (o verificador não usa a fila de revisão); a conferência de teste que casa motivos de `cap-referencia.js` não deve exigir nada novo. Rótulos renomeados: nenhum.

## Arquivos de apresentação afetados

`public/app.js`, `public/disparos.js`, `public/ajuda.js`, `public/docs/cap-conta.js`, `public/docs/cap-disparos.js`, `public/docs/cap-referencia.js`, `README.md`, `test/docs.test.js` (FATOS). Possivelmente conferir (sem mudar): `public/espelhamento.js`, `public/remetentes.js`, `public/style.css`.

Compartilhados: `paginaAjustes` e `paginaTemplates` são usadas só pelas próprias rotas; `dispPill` é usada em todo o Histórico do Disparo manual e de Disparar mensagem (o novo status só aparece com `descartado`; nada muda para os existentes).

## Perguntas em aberto

Nenhuma para o dono. Dependências do arquiteto (marcadas **[ARQ]**): quem pode salvar o cartão; códigos de resposta e flag de "enviar mesmo assim" no manual; se o Histórico geral grava "preço atualizado"; amostra da prévia com `HORA_PRECO`.
