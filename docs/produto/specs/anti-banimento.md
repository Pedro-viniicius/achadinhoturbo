# Especificação de UI/UX: anti-banimento

Cartão "05 · Anti-banimento". Plano em paralelo: `docs/produto/planos/anti-banimento.md` (arquiteto, pode ainda não existir). Só apresentação. O que depende do plano vem marcado **[ARQ]**. Escolhas minhas que o dono pode trocar vêm como **[PROPOSTA]**. Tokens novos: nenhum.

> **Decisões do dono (2026-11-10) e alinhamento com o plano — valem mais que o restante desta spec:**
> - Padrões: 40 mensagens/hora e silêncio ligado das 23:00 às 07:00. Só o Dono muda a proteção, inclusive as pausas (o Operador vê os valores, campos desabilitados).
> - Contador em janela deslizante: "Na última hora: x de N" e, no teto, "… a partir das {hh:mm}".
> - Linha do Histórico do teto sem a contagem de mensagens adiadas.
> - Envio com hora marcada (grade, agendado, repetido, Grupo vivo) dentro do silêncio é **pulado** com aviso; não "sai quando acabar".
> - "Enviar mesmo assim" só no envio **"agora"** do Disparo manual/Disparar mensagem, e nunca ignora o teto. Agendado ou repetido dentro do silêncio: só um aviso de que será pulado. Não existe "Agendar para 07:00".
> - O campo de teto de ofertas por dia por grupo sai do cartão (fora desta entrega).
> - Contratos: `/state.protecao` e `/groups[].admins`, conforme `docs/produto/planos/anti-banimento.md`.

## Objetivo e usuário

Pedro (dono), no computador, sem jargão. A conexão com o WhatsApp é não oficial; ele quer que o número não seja banido e, se algo apertar, entender o que o programa fez sozinho. Ele não quer decorar regras: quer um padrão seguro já ligado, números fáceis de ler e um aviso claro quando o programa segura envios.

## Vocabulário (decide a duplicação de conceitos)

| Termo | Onde | Significa |
|---|---|---|
| **Funciona das / Até** | por disparo (já existe, `window_start`/`window_end`, em `app.js:449`) | quando **este** disparo automático pode rodar |
| **Horário de silêncio** | Ajustes (novo) | quando **nada** sai pelo número: nem automático, nem agendado, nem remetente |
| **Mensagem** | limite por hora | um envio de uma oferta a **um** grupo. 1 oferta para 5 grupos = 5 mensagens |
| **Pausa** | Ajustes | espera entre mensagens (já existe) |

Regras para não confundir: nunca usar "janela" na tela; a palavra "silêncio" só existe em Ajustes e nos avisos; o campo "Funciona das" ganha uma `<small>` fixa: "Vale só para este disparo. O horário de silêncio de Ajustes vale para todos." (com link para `#ajustes`). Os dois se somam: sai quando os dois permitem.

## Fluxo

1. **Tudo já vem ligado** com padrão seguro. O dono abre **Ajustes** só se quiser mudar.
2. Limite por hora: ao bater o teto, as mensagens restantes **ficam na fila e saem na hora seguinte**, nenhuma é perdida. Um aviso por ciclo (não por mensagem) entra no Histórico.
3. Silêncio: o disparo que cairia no silêncio é adiado para o fim dele. Disparo manual "Agora" e agendamento manual: aviso antes de confirmar, com saída "Enviar mesmo assim" (o dono sabe mais, igual ao verificador). **[ARQ]** confirmar se manual passa pelo limite por hora (**[PROPOSTA]**: sim, o limite vale sempre, sem "mesmo assim", porque é proteção do número).
4. Em **Grupos**, cada grupo com um só administrador mostra o selo "Falta 2º admin"; um aviso no topo diz como resolver. Não bloqueia nada: é lembrete.
5. Em **Números de WhatsApp**, uma dica lembra do chip reserva.

## Layout (mobile e desktop)

### 1. Ajustes: cartão "Proteção do número" (novo, `paginaAjustes`)

Primeiro cartão da página, antes de "Pausas". As pausas entram **dentro** dele (o cartão "Pausas entre mensagens" deixa de existir como cartão separado e vira a 3ª seção), porque os três controles protegem a mesma coisa. Mesmo molde dos vizinhos: `.card` com `display:grid;gap:14px`, campos em `.grade` (2 colunas no desktop, 1 em 375 px), seções separadas por `<fieldset>`/`<legend>` como no formulário de disparo (`app.js:440`).

```
Proteção do número  (?)
Limites para o WhatsApp não estranhar o seu número. Os valores já vêm num padrão seguro.

[fieldset] Quantas mensagens por hora  (?)
  [ Máximo por hora ][ 40 ]    Nesta hora: 12 de 40  [=====-----]
  small: Cada oferta enviada a um grupo conta como 1 mensagem. Passou do teto, o resto espera a hora seguinte.
  [ Máximo de ofertas por dia em cada grupo ][      ]  (opcional)
  small: Vazio = sem limite. Conta as ofertas que cada grupo recebeu desde a meia-noite.

[fieldset] Horário de silêncio  (?)
  [chave] Não enviar de madrugada
  [ Das ][23:00]  [ Até ][07:00]
  small: Neste horário nada é enviado; o que estava marcado sai quando o silêncio acabar.

[fieldset] Pausas entre mensagens  (?)
  [ Entre um grupo e outro (segundos) ][ 6 ]   small: Na prática: de 4 a 8 s, escolhido ao acaso a cada vez.
  [ Entre uma oferta e a próxima (segundos) ][ 30 ]  small: Na prática: de 21 a 39 s, escolhido ao acaso a cada vez.
  
[Salvar proteção do número]
```

Decisões:
- **Um botão Salvar** para o cartão inteiro (valida tudo junto, um único retorno). Os cartões atuais salvam por cartão; este também, é um cartão só. O antigo `#sa`/"Salvar pausas" é substituído; **o dev mantém o PUT atual das pausas** dentro do mesmo salvar.
- **Pausas que variam, sem confundir:** os campos continuam sendo o valor **central** (o que o dono já conhece). Abaixo de cada campo, uma `<small>` mostra a faixa real, recalculada ao digitar: "Na prática: de {min} a {max} s, escolhido ao acaso a cada vez." Nada de dois campos mín/máx nem de percentual. A porcentagem de variação é do servidor **[ARQ]**: a spec usa ±30 % só como exemplo (6 s dá 4 a 8, arredondando para inteiro; 30 s dá 21 a 39). **[ARQ]** a conta do painel deve ser a mesma do servidor, de preferência exposta em `/state` para o painel não duplicar a fórmula. Texto do `<small>` vira "Na prática: pelo menos {min} s" se o servidor não expuser a faixa.
- **Uso atual** ("Nesta hora: 12 de 40"): texto com número + `<progress>`/`role="meter"` de apoio (o número é o que vale; a barra é só reforço visual). Contraste da barra 3:1 contra o fundo; ao chegar a 100 %, texto e barra mudam (ver Estados). Atualiza pela rotina de 3 s de `atualizarEstado` **[ARQ]**: `/state` precisa trazer `{ usados, limite, libera_em }`. Sem `aria-live` (atualiza sozinho a cada 3 s e leitor de tela repetiria); só o estado "teto atingido" é anunciado (ver Acessibilidade).
- **Horário de silêncio**: `<input type="time">` (padrão do formulário de disparo). Chave `label.chave` com texto visível ao lado, como no cartão do verificador (`cartaoVerificador`, `app.js:733`). Desligada, os dois horários ficam `disabled` (não escondidos) e a dica diz "Desligado: o programa envia a qualquer hora, dentro dos limites de cada disparo." **[PROPOSTA]** padrão **ligado, 23:00 às 07:00**. Se Das = Até, erro: "Escolha dois horários diferentes."
- **Teto por dia por grupo** é opcional e vem **vazio**. Fica por último na seção para não pesar. É "ofertas", não "mensagens", porque o dono pensa em ofertas por grupo.
- Quem pode mudar: **[ARQ]/pergunta aberta**. **[PROPOSTA]** só o Dono (é proteção do número); o Operador vê tudo com campos `disabled` e `<small class="dica">Só o Dono muda a proteção do número.</small>` no padrão de `SO_DONO_DICA`.
- O texto do cartão antigo de pausas "Pausas curtas demais parecem robô. O programa varia o tempo…" é reaproveitado na ajuda `?`, não no corpo.

### 2. Números de WhatsApp (`paginaNumeros`)

No cartão "Conectado", abaixo da linha "Número: … grupos encontrados", uma linha de uso (só quando `status==='open'`): "Nesta hora: 12 de 40 mensagens. [Mudar em Ajustes](#ajustes)". Quando bate o teto, vira `.aviso-impl` (ver Estados). Abaixo, `<p class="dica">` fixa:

> Tenha um segundo chip de reserva, já com WhatsApp Business instalado. Se este número for restringido, você troca por ele sem perder os grupos.

O subtítulo atual da página ("…use as pausas em Ajustes e prefira um número que você não precise muito") passa a: "Este número envia as ofertas. Para protegê-lo, use os limites e as pausas de Ajustes e prefira um número de que você não dependa." Link "limites e pausas" para `#ajustes`.

### 3. Grupos (`tabelaGrupos`, `public/paineis.js:253`)

- **Selo** na célula do nome, ao lado do `badge-adm` existente: `<span class="estado-pill pendente">Falta 2º admin</span>` (amarelo com **texto**, nunca só cor). Aparece quando o grupo tem exatamente 1 administrador **[ARQ]**: a sincronização hoje só grava `is_admin` do nosso número (`whatsapp.js:265`); precisa também contar admins nos `participants` e devolver `admins` (número) em `/groups`. Desconhecido (`null`) = sem selo (não alarmar sem saber). 0 admins não ocorre.
- **Aviso no topo da tabela**, só se houver ao menos 1 grupo com o selo, `.aviso-impl` com `id="aviso-admin"`:

  > **{n} {grupo|grupos} com só 1 administrador.** Se esse administrador sair ou for banido, ninguém mais gerencia o grupo e ele pode ficar sem dono. Como resolver: abra o grupo no WhatsApp, toque em Dados do grupo, escolha um membro de confiança e toque em “Tornar admin”. Depois use “Atualizar lista de grupos” aqui.

- Cada selo tem `aria-describedby="aviso-admin"` (a explicação fica num lugar só, sem repetir a frase em 30 linhas). Em 375 px a célula do nome já quebra linha (`tab-grupos`); o selo vai abaixo do nome com `margin-top`, sem rolagem horizontal.
- Sem botão "resolver": o programa não promove ninguém (seria ação no WhatsApp do dono, fora do pedido). O botão "Atualizar lista de grupos" que já existe é a saída.
- Dono não precisa marcar nada: o selo some sozinho na próxima atualização da lista.

### 4. Histórico

Sem coluna nova. Avisos usam `nivel-aviso` (ponto amarelo + palavra, já existe) e entram em "Só avisos". Frases na seção Textos.

### 5. Ajuda e documentação (obrigatório pelo CLAUDE.md)

Detalhado em "O que o dev precisa implementar".

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| Cartão de Ajustes `.card` grid, `.grade`, `fieldset` | Existente | `public/app.js`, `paginaAjustes` |
| Chave `label.chave` + texto visível | Existente | `public/style.css`, modelo em `cartaoVerificador` |
| `input type=time` | Existente | `app.js:449` |
| `.estado-pill.pendente` (selo) | Existente | `public/style.css:298` |
| `.aviso-impl` (avisos de teto e de admin) | Existente | `public/style.css:273` |
| Barra de uso (`<progress>`) | Novo, pequeno | `public/style.css`, ~6 linhas: altura 8px, `accent-color: var(--primary)`; a 100 % usa `var(--warn)`. Usa só tokens |
| Função `cartaoProtecao(a)` + `ligarCartaoProtecao()` | Novo | `public/app.js` (modelo: `cartaoVerificador`/`ligarCartaoVerificador`) |
| Linha de uso em Números | Novo (HTML) | `public/app.js`, `paginaNumeros` |
| Selo + aviso de admin | Novo (HTML) | `public/paineis.js`, `tabelaGrupos` |

## Estados

**Cartão Proteção do número**
- Padrão: valores do servidor; uso "Nesta hora: 12 de 40".
- Foco: anel padrão do projeto em todos os campos e na chave.
- Chave de silêncio desligada: horários `disabled` + dica.
- Salvando: botão `disabled` e texto "Salvando…"; ao terminar, volta o texto e o foco ao botão (padrão do verificador). Toast "Proteção do número salva".
- Erro de campo: `<small class="nivel-erro" role="alert">` ligada por `aria-describedby`, `aria-invalid="true"`, foco no primeiro campo com erro. Validações (cliente espelha o servidor **[ARQ]**: faixas finais):
  - Máximo por hora: inteiro, [PROPOSTA] de 1 a 200; padrão 40.
  - Ofertas por dia por grupo: vazio ou inteiro de 1 a 200.
  - Pausas: mínimos atuais (2 s e 5 s), inteiros.
- Erro do servidor: toast de erro com a mensagem (padrão do app).
- Carregando (estado ainda sem `/state`): campos não são desenhados; a página já só abre com estado carregado.
- Sem permissão (Operador): campos `disabled`, dica de "Só o Dono…", sem botão Salvar.
- Uso desconhecido (servidor não devolveu): linha "Nesta hora: sem leitura ainda." sem barra.

**Uso por hora**
- Normal (< 80 %): texto neutro, barra primária.
- Perto (≥ 80 %): texto "Nesta hora: 34 de 40. Perto do limite." (palavra, não só cor), barra `--warn`.
- **Teto atingido**: o cartão mostra `.aviso-impl`: "**Limite desta hora atingido (40 de 40).** As próximas mensagens ficam na fila e saem às {hh:mm}. Nada se perde." Em Números aparece o mesmo aviso curto. `{hh:mm}` é a hora em que a janela de 60 min libera vaga **[ARQ]** (janela deslizante ou hora cheia: o texto "nesta hora" vale para as duas, mas "saem às" depende do modelo; se for deslizante diga "a partir das {hh:mm}").
- Limite alterado para valor menor que o uso atual: salva; a barra passa a cheia e o aviso de teto aparece.

**Silêncio**
- Fora do silêncio: nada extra.
- Dentro do silêncio (informativo, em Números e no topo do cartão): `<small class="dica">Horário de silêncio agora: nada é enviado até as 07:00.</small>`.
- Disparo manual "Agora" dentro do silêncio: `.aviso-impl` acima do botão Disparar (lugar de `dispErros`): "**Horário de silêncio até 07:00.** Se você enviar agora, as mensagens saem fora do horário que você protegeu." Botão secundário "Enviar mesmo assim" e o principal passa a "Agendar para 07:00" **[ARQ]** se a agenda manual suportar; senão só o "mesmo assim". Já o teto por hora **não** tem "mesmo assim" **[PROPOSTA]**: mensagem "Limite desta hora atingido; a oferta entra na fila e sai às {hh:mm}."

**Teto de ofertas por dia por grupo**
- Grupo que já recebeu o teto: o disparo pula **esse** grupo e segue com os demais; Histórico (aviso): ver Textos. Sem vazio especial: se todos os grupos bateram o teto, a frase do Histórico diz "todos os grupos".

**Selo de admin**
- Admins = 1: selo + aviso do topo.
- Admins > 1 ou desconhecido: nada.
- WhatsApp desconectado: a tabela já aparece sem estado ao vivo; **sem** selo (dado pode estar velho; o aviso do topo some junto). **[PROPOSTA]**
- Conteúdo longo: nome do grupo quebra linha; selo permanece inteiro (`white-space:nowrap` do `.estado-pill`) abaixo do nome.
- Lista com 30+ grupos: o aviso do topo é um só; o selo por linha identifica.

## Textos da interface

Ajustes (cartão novo; título e `?` com `q('ajustes.protecao')`):
- Título: "Proteção do número"
- Subtítulo: "Limites para o WhatsApp não estranhar o seu número. Os valores já vêm num padrão seguro."
- Legend 1: "Quantas mensagens por hora"
- Campo: "Máximo de mensagens por hora"; dica: "Cada oferta enviada a um grupo conta como 1 mensagem. Passou do teto, o resto espera a vaga seguinte."
- Uso: "Nesta hora: {x} de {N}" / "Nesta hora: {x} de {N}. Perto do limite." / "Nesta hora: sem leitura ainda."
- Campo: "Máximo de ofertas por dia em cada grupo (opcional)"; placeholder "Sem limite"; dica: "Conta as ofertas que cada grupo recebeu desde a meia-noite. Vazio = sem limite."
- Legend 2: "Horário de silêncio"; chave: "Não enviar de madrugada"; campos "Das" e "Até"; dica: "Neste horário nada é enviado. O que estava marcado sai quando o silêncio acabar."; desligado: "Desligado: o programa envia a qualquer hora, dentro do horário de cada disparo."; erro: "Escolha dois horários diferentes."
- Legend 3: "Pausas entre mensagens"; campos "Entre um grupo e outro (segundos)" e "Entre uma oferta e a próxima (segundos)"; dica: "Na prática: de {min} a {max} segundos, escolhido ao acaso a cada vez."; erros: "Use um número inteiro a partir de {2|5}." (mínimos atuais).
- Erros dos outros campos: "Use um número inteiro de 1 a 200." / "Deixe vazio para não limitar, ou use um número de 1 a 200."
- Botão: "Salvar proteção do número" / "Salvando…"; toast "Proteção do número salva"
- Sem permissão: "Só o Dono muda a proteção do número."

Avisos de teto/silêncio:
- Teto por hora (cartão e Números): "Limite desta hora atingido ({N} de {N}). As próximas mensagens ficam na fila e saem às {hh:mm}. Nada se perde."
- Silêncio agora: "Horário de silêncio: nada é enviado até as {hh:mm}."
- Manual no silêncio: "Horário de silêncio até {hh:mm}. Se você enviar agora, as mensagens saem fora do horário que você protegeu." Botões "Enviar mesmo assim" e "Cancelar".

Histórico (nível aviso, uma linha por ciclo, sem número de telefone):
- "Limite de {N} mensagens por hora atingido: {k} {mensagem adiada|mensagens adiadas} para as {hh:mm}."
- "Horário de silêncio ({de} às {até}): {nome do disparo} adiado para as {hh:mm}."
- "Limite de {N} ofertas por dia atingido em {nome do grupo}: grupo pulado hoje." (vários grupos: "em {k} grupos")

Números: subtítulo e dica do chip reserva (acima); linha "Nesta hora: {x} de {N} mensagens. [Mudar em Ajustes]".

Grupos: selo "Falta 2º admin"; aviso (acima); singular/plural "1 grupo com só 1 administrador" / "{n} grupos com só 1 administrador". Dica em `Funciona das`: "Vale só para este disparo. O horário de silêncio de Ajustes vale para todos."

Ajuda `?` (em `TIPS`, `public/ajuda.js`; chaves novas, mesma forma das existentes):
- `ajustes.protecao`: "O WhatsApp pode restringir números que mandam muito, rápido ou de madrugada, porque a conexão deste programa é não oficial. Estes limites seguram o programa antes disso. O padrão já é seguro; só mude se souber o que quer."
- `ajustes.limite_hora`: "Máximo de mensagens que o número envia por hora. Uma oferta para 5 grupos são 5 mensagens. Passou do teto, o resto espera e sai na hora seguinte."
- `ajustes.limite_dia`: "Opcional. Máximo de ofertas que cada grupo recebe por dia, para ninguém sair do grupo por excesso de mensagens."
- `ajustes.silencio`: "Hora em que nada é enviado. É diferente do “Funciona das” de cada disparo, que vale só para ele. Se os dois existirem, só sai o que os dois permitem."
- `ajustes.pausas` (atualizar): "Espera entre mensagens. O programa varia o tempo ao acaso, para mais ou para menos, para parecer humano. O número que você escreve é o valor do meio. Mais curto = mais risco de bloqueio."
- `grupos.admin`: "Grupo com um só administrador corre o risco de ficar sem dono se ele sair ou for banido. Adicione um segundo admin pelo WhatsApp."

`LEIA_MAIS`: `ajustes.protecao` e os 4 acima apontam para a seção nova (`manutencao/protecao-do-numero`), `grupos.admin` para `grupos/...` **[ARQ]** (capítulo e id definidos pelo dev ao escrever o capítulo; ver `cap-conta.js`, `cap-grupos.js`).

## Acessibilidade

- Cada campo tem `<label>` visível; as dicas e erros ligados por `aria-describedby`; erro com `role="alert"`, `aria-invalid` e foco no primeiro inválido.
- Chave do silêncio: `<input type=checkbox>` real dentro de `label.chave` + `<label for>` com texto (não depende de `title`).
- Barra de uso: `<progress value max>` nativo com `aria-label="Mensagens enviadas nesta hora"`; o texto ao lado dá o valor, a barra é redundante. Nenhuma informação só por cor: estados "perto" e "atingido" têm palavra.
- Anúncio: só o aviso de teto atingido usa `role="status"` (educado), inserido quando muda de "abaixo" para "no teto" e **não** repintado a cada 3 s (o dev só atualiza o `textContent` quando o texto muda, para não reler). A barra e o contador não têm `aria-live`.
- `.aviso-impl` já tem ícone textual "!" e borda: não depende de cor. Contraste: `--warn` #B7791F sobre branco dá ~3,7:1; **o texto fica em `--text`**, só borda/ícone usam `--warn` (como já está em `.aviso-impl`). `.estado-pill.pendente` usa texto `--text` sobre fundo claro (≥ 4,5:1).
- Selo "Falta 2º admin" é texto real (não ícone); `aria-describedby` aponta para o aviso do topo.
- Alvos: botão "Salvar" e chave ≥ 44×44 em 375 px; `input time` já usa altura dos outros campos.
- Teclado: ordem de tab segue a ordem visual (limite, dia, chave, horários, pausas, Salvar). Enter dentro de um campo não salva sozinho (não há `<form>`; igual ao verificador). **[PROPOSTA]** dev pode envolver em `<form>` para Enter salvar, se não conflitar com `tentar()`.
- `prefers-reduced-motion`: a barra não anima transição (sem `transition` de largura).
- Rolagem horizontal: nenhuma até 320 px; `.grade` vira 1 coluna; selos quebram abaixo do nome.

## O que o dev precisa implementar

Apresentação, depois que o plano do arquiteto definir os campos:
1. `public/app.js`: `cartaoProtecao(a)` e `ligarCartaoProtecao()` (modelo: verificador); remover o cartão avulso de pausas e levar o PUT delas para o salvar novo; faixa "Na prática" recalculada ao digitar; validação no cliente; linha de uso e aviso de teto em `paginaNumeros`; subtítulo novo de Números e dica do chip reserva; `<small>` em "Funciona das" no formulário de disparo.
2. `public/paineis.js`: selo "Falta 2º admin" e aviso `#aviso-admin` em `tabelaGrupos`.
3. `public/disparos.js`: aviso do silêncio e "Enviar mesmo assim" no Disparo manual (e o que couber no agendamento); mensagem de teto por hora. **[ARQ]** dependem de a rota informar `silencio`/`limite`.
4. `public/style.css`: regra `progress` do uso (tokens).
5. `public/ajuda.js`: `TIPS` e `LEIA_MAIS` (acima); atualizar `ajustes.pausas`.
6. Docs: `public/docs/cap-conta.js` (seção "Ajustes: pausas e limites", linhas ~310 a 325: cartão novo, o padrão, o teto, o silêncio e a diferença para "Funciona das"); `cap-disparos.js` (seção `pausas`, ~328, e a de "Funciona das" se existir); `cap-grupos.js` (selo de admin e como resolver); `cap-referencia.js` (tabela de limites padrão, linha ~218; linha nova para cada número: limite por hora, silêncio padrão, teto por dia); `cap-comecar.js:72` (aviso do número). Números novos que aparecem nos dois (ajuda e capítulo) entram na tabela `FATOS` de `test/docs.test.js`. Selo/motivo novo em `public/conexoes.js`/`MOTIVOS`, se houver, entra em `cap-referencia.js`. Procurar a grafia antiga "Salvar pausas" em `public/docs/`.
7. `README.md`: parágrafo do anti-banimento.

## Arquivos de apresentação afetados

`public/app.js`, `public/paineis.js`, `public/disparos.js`, `public/style.css`, `public/ajuda.js`, `public/docs/cap-conta.js`, `cap-disparos.js`, `cap-grupos.js`, `cap-referencia.js`, `cap-comecar.js`, `README.md`, `test/docs.test.js` (só a tabela `FATOS`, por quem o plano indicar). Mudança em `cartaoVerificador`/tokens globais: nenhuma. O cartão "Pausas" é removido como cartão e sua ajuda `ajustes.pausas` é reaproveitada (usada em `app.js` e `docs`).

## Perguntas em aberto

1. **[ARQ]** Modelo do contador por hora: hora cheia ou janela deslizante de 60 min? Muda o "saem às".
2. **[ARQ]** O limite vale para o Disparo manual e o Enviar teste? (proposta: vale para tudo que usa o número; só o silêncio tem "mesmo assim")
3. **[ARQ]** `/state` e `/groups` precisam devolver: `{ usados, limite, libera_em }`, `silencio {ativo,de,ate,agora}`, faixa efetiva das pausas e `admins` por grupo (contagem a partir dos `participants` na sincronização).
4. **[ARQ]** Faixa de variação das pausas (exemplo ±30 %). O painel deve exibir a que o servidor realmente usa.
5. **[PROPOSTA]** Padrões: 40 mensagens/hora, silêncio ligado 23:00–07:00, teto por dia vazio. O dono valida? O padrão de 40 é sugestão, o arquiteto deve ajustá-lo com base no volume real (ex.: 5 grupos × 8 ofertas).
6. **[PROPOSTA]** Só o Dono muda a proteção. Confirmar com o dono.
7. O silêncio deve respeitar fuso do computador (o mesmo do "Funciona das")? Presumo que sim.
8. Mostrar o uso por hora também na Visão Geral? Fora do pedido; deixei de fora.
