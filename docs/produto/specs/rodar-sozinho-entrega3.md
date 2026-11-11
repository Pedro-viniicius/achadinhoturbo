# Especificação de UI/UX: Rodar sozinho, entrega 3 (Vigia)

Brief: `docs/produto/briefs/rodar-sozinho.md`, seção "Entrega 3". Apoia-se na spec da entrega 2 (`rodar-sozinho-entrega2.md`, ainda sem aprovação) e no código da cópia `achadinho_turbo-wt-e1` (HEAD `def9a19`: `src/avisos.js`, `src/ritmo.js`, `public/app.js`, `public/relatorios.js`, `public/ajuda.js`, `public/docs/`, `test/docs.test.js`). O plano da entrega 2 não existia ao escrever. Nenhum componente novo: reaproveita a pílula da faixa, o cartão de Relatórios e avisos e o molde de mensagem de `src/avisos.js`.

## Objetivo e usuário

Pedro (dono) usa sozinho, no computador, e quer ligar o Turbo e não vigiar o painel. Quando algo para de verdade, quer uma mensagem no WhatsApp que se entenda na notificação do celular: **o que parou, desde quando, o que fazer**. Quando volta, uma só mensagem. Nunca uma enxurrada. Quando está no painel, vê a causa em aberto na faixa do topo.

Vocabulário (igual às entregas 1 e 2): Enviada, Pulada, Descartada, Separada para revisão, Em espera, Central de Afiliados, Extensão. Palavra nova: **vigia** (o que confere o programa e avisa). Evitar "alarme", "alerta crítico", "incidente", "disjuntor", "healthcheck".

## Fluxo

1. A causa aparece (regra do brief, contada só nos horários de envio): o Histórico ganha uma linha, a faixa mostra a pílula e o WhatsApp recebe **um** aviso.
2. Enquanto a causa dura: nada novo no WhatsApp (ver "Freio"). A faixa continua mostrando a causa.
3. A causa some: uma linha no Histórico, a pílula desaparece e o WhatsApp recebe **um** "voltou ao normal", só se o aviso de problema tiver saído.
4. Fim de dia: o resumo diário traz a linha de saúde.

**Regras de redação das mensagens (valem para as 8 mensagens):**
- Primeira linha curta: emoji, **negrito**, a coisa que parou. Cabe inteira na notificação (até ~60 caracteres).
- Até 4 linhas por causa. Datas no formato do Histórico: `09:10` se for hoje, `09:10 de 10/11` se não for.
- Só texto fixo nosso mais marcadores. **Nunca** o texto livre de erro de terceiros (o "Último erro" do Chrome ou do ML não entra), telefone, e-mail, segredo, link de convite, nome de participante. Nome de regra e de grupo podem entrar, passando por `semNumero()` de `src/avisos.js` e cortados em 40 caracteres, sem `*` (como o resumo já faz).
- Nunca "revisão" para pulada ou descartada. Nunca jargão (token, timeout, ASIN).
- Toda mensagem termina com ação concreta ou "Nada a fazer".

## 1. Mensagens do WhatsApp

Marcadores: `{LOJA}` nome da loja; `{REGRA}` nome da regra; `{DESDE}` hora de início da causa (`09:10`); `{HA}` há quanto tempo (`2 h 10 min`, `35 min`); `{N}` e `{FORA}` contagens; `{MOTIVO}` a causa mais frequente, **da lista fixa** da tabela da seção 1.6; `{ACAO}` a ação da mesma tabela. O texto sai do código (constantes em `src/`, não editadas pelo designer).

### 1.1 Loja parada (3 execuções seguidas)

```
⚠️ *{LOJA} parada desde {DESDE}*
Nas últimas {N} execuções nenhuma oferta da {LOJA} saiu ({FORA} ficaram de fora: {MOTIVO}).
O que fazer: {ACAO}
```
Exemplo: `⚠️ *Amazon parada desde 09:10*` / `Nas últimas 3 execuções nenhuma oferta da Amazon saiu (5 ficaram de fora: a Amazon bloqueou a leitura).` / `O que fazer: nada por agora, o programa tenta de novo no próximo envio. Se continuar, abra a Amazon no Chrome e veja se pede verificação.`

Voltou: `✅ *{LOJA} voltou a enviar*` / `Saiu uma oferta às {HORA} (a loja esteve parada por {HA}). Nada a fazer.`

Artigo: "da Amazon", "do Mercado Livre", "da Magalu", "da Shopee": o dev usa um mapa de preposição por loja (não montar com regra geral).

### 1.2 Extensão ou Central fora (30 min dentro dos horários de envio)

Uma causa, duas redações, conforme o estado **no momento do aviso** (se a extensão cair depois de a Central já estar avisada, não há novo aviso: a faixa mostra o estado novo).

Extensão desconectada:
```
⚠️ *Extensão do Chrome fora desde {DESDE}*
O Mercado Livre não envia sem ela ({N} ofertas esperando).
O que fazer: abra o Chrome com a extensão instalada e entre na Central de Afiliados com a sua conta.
```
Central sem resposta (o Mercado Livre em espera da entrega 2):
```
⚠️ *Mercado Livre em espera desde {DESDE}*
A Central de Afiliados não está respondendo ({N} ofertas esperando). O programa testa de novo a cada 5 min.
O que fazer: nada, a menos que passe de 1 hora. Aí abra a Central no Chrome e veja se a página carrega e se a sua conta está logada.
```
`{N}` = ofertas do Mercado Livre que esperaram nas execuções da janela; sem esse dado, omitir o parêntese. O "5 min" é o da entrega 2 (não é número novo, mas já está em `FATOS` pela E2).

Voltou (as duas): `✅ *Mercado Livre voltou a enviar*` / `A {Extensão do Chrome|Central de Afiliados} respondeu de novo (esteve fora por {HA}). As ofertas saem sozinhas, nada a fazer.`

### 1.3 Revisão acumulada (10 ofertas)

```
⚠️ *{N} ofertas esperando a sua revisão*
Elas não saem até você decidir. A mais antiga espera há {HA}.
O que fazer: abra Histórico > Catálogo, confira e envie ou descarte.
```
Voltou (quando cai abaixo de 5; ver pergunta 4): `✅ *Revisão em dia*` / `Restam {N} ofertas esperando. Nada a fazer.` Singular: `1 oferta esperando`.

### 1.4 Regra vazia (2 execuções seguidas)

```
⚠️ *A regra “{REGRA}” saiu vazia {N} vezes seguidas*
Às {H1} e às {H2} nenhuma oferta saiu ({FORA} ficaram de fora: {MOTIVO}).
O que fazer: {ACAO}
```
Voltou: `✅ *A regra “{REGRA}” voltou a enviar*` / `Saíram {X} ofertas às {HORA}. Nada a fazer.`

### 1.5 Hierarquia: um problema, um aviso

A causa-raiz cala as derivadas, para o dono não receber três mensagens do mesmo defeito:
- Extensão/Central fora **cala** "loja parada" do Mercado Livre e "regra vazia" de regras que só pedem Mercado Livre.
- Loja parada aberta **cala** "regra vazia" das regras que só pedem aquela loja.
- A causa calada fica registrada no Histórico (`aviso`), mas não vai ao WhatsApp nem à faixa. Se a causa-raiz fecha e a derivada continua, ela abre normalmente na execução seguinte.

### 1.6 Motivo e ação (lista fechada, para `{MOTIVO}` e `{ACAO}`)

O motivo é o mais frequente entre as ofertas que caíram fora na sequência (empate: o primeiro da tabela). Usa as causas que o Histórico já mostra:

| Motivo (`{MOTIVO}`, minúscula, sem ponto) | Ação (`{ACAO}`) |
|---|---|
| a Amazon bloqueou a leitura | Nada por agora: o programa tenta de novo no próximo envio. Se continuar, abra a Amazon no Chrome e veja se pede verificação. |
| o Etiqueta não respondeu | Confira se o Etiqueta está ligado no computador. |
| o preço não pôde ser conferido | Veja o Histórico: ele diz a causa de cada oferta. |
| preço subiu além do limite / esgotada na loja / indisponível | Em geral passa sozinho: são ofertas que mudaram. Se continuar por mais de um dia, confira o catálogo do Etiqueta. |
| fora dos filtros da regra (só regra vazia) | Afrouxe os filtros da regra em Disparo automático ou espere novidades no catálogo. |
| já enviadas ou parecidas (só regra vazia) | O catálogo está repetindo ofertas recentes. Em geral nada a fazer. |
| outro motivo | Veja o Histórico no painel. |

### 1.7 Freio

- **Um aviso por causa a cada 3 horas**, contados do último aviso daquela causa (de problema ou de volta). Serve para o abre-e-fecha: causa que fecha e reabre dentro de 3 h **não** gera aviso novo; o aviso espera as 3 h se a causa ainda estiver aberta.
- **Não há lembrete** enquanto a causa está aberta (ver pergunta 3). O painel mostra o que está aberto.
- O "voltou ao normal" **só sai se o aviso de problema saiu**. Causa que abriu e fechou sem aviso (freio, silêncio, WhatsApp fora) não gera "voltou".
- Um "voltou" por causa, mesmo que a causa tenha mudado de redação no meio (extensão para Central).

### 1.8 Horário de silêncio, WhatsApp fora e avisos acumulados

Nada sai dentro do silêncio do `ritmo.js` (`silencio()` de `src/ritmo.js`, o mesmo de Ajustes) nem com o WhatsApp desconectado. No instante em que as duas condições deixam de valer, **uma mensagem só**, reavaliada na hora: entra o que **ainda** está aberto. Causa que abriu e fechou no meio do tempo não vira mensagem: só linha no Histórico. Sem silêncio ligado, nada segura (só o WhatsApp fora).

- **1 causa**: sai a mensagem normal da seção 1, sem cabeçalho extra, com o `{DESDE}` original.
- **2 ou 3 causas**: cabeçalho e uma linha para cada, com o "o que fazer" de cada uma:
```
⚠️ *2 problemas: Amazon parada, revisão acumulada*
O programa estava em silêncio e agora vai avisando.

1. *Amazon parada desde 22:40.* Nenhuma oferta saiu nas últimas 3 execuções. Fazer: {ACAO}
2. *12 ofertas esperando a sua revisão.* Fazer: abra Histórico > Catálogo.
```
- **4 causas**: mesmo molde. O título lista até 3 nomes e "e mais 1": `⚠️ *4 problemas: Amazon parada, extensão fora, revisão acumulada e mais 1*`. Cada item perde a linha de detalhe e fica com o que parou e o que fazer. Fecha com `Detalhes no painel, no Histórico.`
- Frase sob o título quando o motivo foi o WhatsApp fora: `O WhatsApp ficou desconectado e agora voltou.` (sem silêncio: `O programa estava sem WhatsApp e agora voltou.`)
- "Voltou ao normal" não se acumula: se a causa fechou, nada vai (regra da seção 1.7).
- O resumo diário (21:00) e o aviso de erro **seguem como são hoje**, e o silêncio não os muda; o vigia obedece ao silêncio por ser aviso de mais um tipo que o dono controla (ver pergunta 2).

### 1.9 Quem recebe

Os destinos ativos que marcaram **Erro de disparo** (como diz o brief). Sem controle novo; só muda o texto de ajuda da caixa (seção 4). Mensagem passa por `entregar()` de `src/avisos.js` e pelo porteiro do `ritmo.js` (CA3.5); a linha do Histórico leva o nome do destino, nunca o número.

## 2. Linha de saúde no resumo diário

Uma vez, no **fim** do resumo (depois das seções por bloco), com os envios de **todas as regras** do dia de negócio, não filtrados por bloco (um rótulo diz isso). O resumo de hoje não traz essas informações; o bloco é todo novo.

```
🩺 *Saúde dos envios* (todas as regras)
Amazon: 14 enviadas · Mercado Livre: 9 enviadas
Puladas: 6 · Descartadas: 2 · Falhas: 1
Esperando revisão: 7
Em aberto agora: Amazon parada desde 09:10.
```

Regras de composição:
- **Linha das lojas:** só lojas que enviaram ou foram pedidas por alguma regra ativa no dia, até 6, em ordem de envios (maior antes). Loja pedida que saiu 0 mostra `Magalu: 0 enviadas`.
- **Linha de contagens:** os três números sempre aparecem (inclusive `0`), para o dono ver que foram contados. `Puladas` e `Descartadas` somam as execuções do dia (as da entrega 1); `Falhas` = disparos que viraram `erro` no dia.
- **Revisão:** `Esperando revisão: 7`; com 0: `Esperando revisão: nenhuma`. Singular nas lojas e nas contagens (`1 enviada`); `Puladas: 1`.
- **Em aberto agora:** linha só aparece com causa em aberto. Várias: `Em aberto agora: Amazon parada desde 09:10; extensão fora desde 14:20.`
- **Dia sem nada a relatar** (nenhuma pulada, descartada nem falha, nada em revisão): em vez das duas últimas linhas, `Nenhuma pulada, descartada nem falha. Nada esperando revisão.`
- **Dia sem execução** (nenhuma regra rodou: todas pausadas ou fora de dia): `🩺 *Saúde dos envios*` / `Nenhuma regra rodou hoje: não havia regra ativa com horário no dia.`
- **Dia com tudo zero apesar de regras ativas:** mostra os zeros e, se houver, a linha de "Em aberto". Não dizer "tudo bem": o número fala.
- Sem dado pessoal; nome de loja é o do programa. Quando o resumo é testado em "Enviar resumo agora" ou na prévia de Relatórios e avisos, o bloco aparece igual (a prévia chama `montarResumo`).

## 3. Faixa do topo (`#faixa`, `public/app.js` `faixa()`)

Hoje a faixa tem a pílula do WhatsApp, a da extensão e, por E2, a da Central. O vigia **não duplica** o que já está nelas.

| Causa | Onde aparece | Acrescenta |
|---|---|---|
| Extensão fora, Central em espera | Pílulas da E2 | O tempo (`desde 09:10, há 40 min`) quando a causa está aberta, no degrau de 5 min da E2. |
| Loja parada, regra vazia, revisão acumulada | **Pílula nova**, do mesmo molde da de "propostas" (`<a class="pilula espera">`, ponto âmbar mais texto) | O resto desta seção. |

**Textos da pílula** (o tempo em degraus de 5 min até 1 h, depois de hora em hora, com a mesma `haQuanto(ts)` da E2; fora disso, `desde 09:10`):
- Loja: `Amazon parada desde 09:10 (há 2 h)`; link `#historico`.
- Regra: `Regra “Black_Operação” saiu vazia desde 09:00`; link `#disparo-automatico`.
- Revisão: `12 ofertas esperando revisão desde 08:30`; link `#historico` (aba Catálogo; se a aba tiver âncora, usá-la: do dev).
- Sem causas: nenhuma pílula (não escrever "tudo certo": ruído).

**Prioridade** (na ordem em que aparecem): loja parada, regra vazia, revisão. Máximo de **duas** pílulas do vigia: a causa mais prioritária e a segunda; com 3 ou mais, a segunda vira `+2 problemas em aberto` (link `#historico`, filtro "Só avisos"). Empate: a mais antiga primeiro. As causas de Extensão/Central ficam nas pílulas da E2 e **contam** no "+N" quando há mais de uma.

**Sem ser relido a cada atualização:** a faixa é `aria-live="polite"` e atualiza a cada 3 s. Duas regras (a segunda é a da E2, aqui repetida porque sem ela o item 4 falha):
1. `faixa()` só repinta se o HTML novo for diferente do anterior.
2. O tempo muda em degrau de 5 min na 1ª hora e de hora em hora depois (no máximo 12 leituras por hora, só enquanto há problema). A hora de início (`desde 09:10`) nunca muda e é o dado principal; o `(há 2 h)` é complemento.

**Mobile (375 px):** `flex-wrap` já existe. A pílula do vigia permite duas linhas (`white-space:normal`, `border-radius:14px` quando quebra, ponto alinhado ao topo). Alvo de toque de 44 px (`padding:11px 14px` em `@media (max-width:600px)`, como a E2). Texto mais longo possível: `Regra “{nome com 40 caracteres}” saiu vazia desde 09:00`, quebra sem rolagem horizontal (`overflow-wrap:anywhere`). Com as pílulas da E2 e as duas do vigia, a faixa pode ter 5 linhas em 375 px; é o pior caso e é aceito porque só acontece com problema.

**Se a resposta à pergunta 7 da E2 for "pílula única de espera":** nada muda na parte do vigia, apenas o "há quanto tempo" do Mercado Livre fica no texto dessa pílula (`Mercado Livre em espera desde 09:10`).

**Estados da faixa:** carregando (`S.st` ainda sem `vigia`): nenhuma pílula do vigia; sem causas: nada; **vigia sem leitura** (`vigia.ok === false`, falha ao avaliar): `<span class="pilula">Vigia sem leitura agora</span>` neutra, sem ponto colorido, e linha `aviso` no Histórico `O vigia não conseguiu verificar agora. Tentando de novo no próximo ciclo.` (nunca `erro`: `erro` gera o aviso de erro do WhatsApp e criaria um laço).

## 4. Onde o dono liga, desliga e ajusta

**Recomendação: nenhum controle novo.** Tudo fixo no código (limites da tabela da seção 6). Motivo: cada controle é mais uma decisão para quem quer "ligar e deixar rodar"; os limites vêm do ritmo real das regras.

- **Liga/desliga:** a caixa **Erro de disparo** em Relatórios e avisos (já existe, por número). O painel (faixa e Histórico) sempre mostra as causas, mesmo sem número que receba.
- **Relatórios e avisos** (`public/relatorios.js`, `TEXTOS`):
  - `dicaAviso.erro`: de `Uma mensagem não saiu. No máximo um aviso a cada 30 minutos, com todos os erros juntos.` para `Uma mensagem não saiu, o backup está atrasado ou algo parou (loja, extensão ou Central, revisão acumulada, regra vazia). Erros: no máximo um aviso a cada 30 minutos, todos juntos. O resto: no máximo um por causa a cada 3 horas.`
  - `testeRecebe`: `Ele recebe os avisos de erro, de backup atrasado e do vigia.`
  - Rótulo `Erro de disparo` **não muda** (testes e Docs dependem dele; ver pergunta 1).
  - Linha informativa no cartão "Configurações gerais", abaixo dos campos, `<p class="dica">` sem controle: `Vigia: o programa avisa pelo WhatsApp quando uma loja, a extensão, a Central, a revisão ou uma regra pára. {ESTADO}` com `{ESTADO}` = `Nenhum problema em aberto.` / `Em aberto agora: …` / `Ninguém recebe esses avisos: marque “Erro de disparo” em um número.` (sem destino ativo). O estado fica em `<span>` fora de `aria-live` (o painel já carrega a página inteira ao entrar).
  - Ícone `?` (`ajuda.js`): `TIPS['relatorios.vigia']` (novo; ver seção 7).

## Componentes

| Componente | Existente ou novo | Onde fica |
|---|---|---|
| Pílula da faixa (`pilula espera`, link) | Existente, uma a mais (até duas) | `public/app.js` `faixa()` |
| `haQuanto(ts)` | Da E2; sem E2, aqui | `public/app.js` |
| Texto de ajuda e linha informativa | Existentes; textos novos | `public/relatorios.js` `TEXTOS` |
| Mensagens do WhatsApp e linha de saúde | Texto nas constantes de `src/` | `src/avisos.js` (dev) |
| Linhas do Histórico (abre, fecha, vigia sem leitura) | Existentes; textos novos | `src/` (dev) |

### Linhas do Histórico (um por mudança, nunca por execução)
Abre (`aviso`): `Vigia: Amazon parada (3 execuções sem envio; motivo mais comum: a Amazon bloqueou a leitura).` Fecha (`info`): `Vigia: Amazon voltou a enviar (esteve parada por 2 h 10 min).` Calada pela causa-raiz (`info`): `Vigia: a regra “X” saiu vazia, mas o Mercado Livre está em espera: sem aviso separado.` Avisos enviados: `Aviso do vigia enviado a “Pedro”.` (nome do destino, nunca o número). Aviso segurado: `Aviso do vigia segurado (silêncio).`; `… (WhatsApp fora)`; `… (freio de 3 h)`. Nenhuma é `erro`.

## Estados
- **Vazio:** sem causas, sem pílula, "Nenhum problema em aberto" em Relatórios e avisos; resumo com a linha "Nenhuma pulada, descartada nem falha."
- **Erro:** vigia sem leitura (seção 3); WhatsApp fora: o aviso espera e sai ao voltar (seção 1.8), a faixa mostra o resto.
- **Carregando:** nada até `S.st.vigia` chegar; sem estado de "carregando" visível.
- **Conteúdo longo:** nome de regra cortado em 40; mensagem acumulada com 4 causas ~650 caracteres, dentro do que o WhatsApp mostra inteiro.
- **Hora:** causa de dia anterior `desde 09:10 de 10/11`; passou de 24 h na faixa, `desde 10/11`.
- Conferir em 375 e 1280 px: 0, 1, 2 e 4 causas; nome longo; Extensão fora com tempo; vigia sem leitura; modo direto (links sem etiqueta, onde não há pílulas da extensão e a causa Extensão/Central não se aplica).

## Acessibilidade (WCAG 2.2 AA)
- **Cor nunca sozinha:** cada pílula tem texto com o nome da causa e o ponto é complemento. O vigia sem leitura é neutro (sem ponto colorido), com texto.
- **Leitor de tela:** faixa só repinta com HTML novo; o relógio muda em degraus; a hora de início é estática. Em Relatórios e avisos o estado do vigia é texto comum, sem região viva.
- **Teclado e foco:** as pílulas-link usam o `:focus-visible` global; ordem: WhatsApp, extensão, Central, causas do vigia por prioridade, depois o conteúdo.
- **Alvo de toque:** ≥24 px no computador; 44 px no celular, como a E2.
- **Contraste:** mesmo par texto/fundo da pílula `espera` existente (já passa em 4,5:1); nenhum token novo. Conferir a pílula com duas linhas.
- **Movimento:** nada animado.
- **Linguagem:** sem jargão; as mensagens do WhatsApp são em português simples, com emoji só como reforço (o texto diz a mesma coisa: "parada", "voltou").

## O que o dev precisa implementar
1. Avaliador do vigia no tick de `src/scheduler.js` (depois dos envios), com estado persistido (causas abertas, `desdeEm`, último aviso por causa, `avaliadoEm`) e contagem **por horário de envio**, não por relógio (decisão do arquiteto: onde guardar; brief, "O que fica com o construtor").
2. Mensagens das seções 1.1 a 1.4 e 1.8, o freio (1.7), a hierarquia (1.5) e a linha de saúde (seção 2) em `src/avisos.js`, passando por `entregar()` e `ritmo.silencio()`. `semNumero()` nos nomes; teste que prova que nenhum texto leva `@s.whatsapp.net`, dígitos de telefone, e-mail ou segredo.
3. `GET /api/state` com `vigia: { ok, causas: [{ tipo, loja?, regra?, n?, desdeEm }], avaliadoEm }`; `faixa()` e `relatorios.js` consomem (se o arquiteto escolher outra rota, o designer ajusta).
4. Linhas do Histórico (seção "Linhas do Histórico"), nunca no nível `erro`.
5. Docs, `TIPS`, `FATOS` (seção 7).

## 7. Docs, `TIPS`, README (CA3.6)

Números que aparecem no código e nos Docs, para `FATOS` (`test/docs.test.js`): **3** execuções seguidas (loja parada), **2** execuções (regra vazia), **30 min** de extensão ou Central fora, **10** ofertas na revisão (e **5** para o "voltou", se a pergunta 4 for aceita), **3 h** de freio. Atenção: `30 min` já existe em outros fatos ("atrasou até 30 min", "avisos de erro a cada 30 minutos"): o texto da regex do `FATOS` precisa ser específico (`extensão ou Central fora por 30 min`), e o teste "o texto montado do valor não casa com outro valor" precisa passar com os dois. O `3` também colide com a redação da E2 ("3 falhas seguidas"); usar `3 execuções seguidas sem envio`.

| Arquivo | Entrada | Mudança |
|---|---|---|
| `README.md` ~740-751 | "Relatórios e avisos" | Novo item **Vigia** com as quatro causas, os limites, o freio, o "voltou ao normal", o silêncio e a linha de saúde. Atualizar o item de *Erro de disparo* (quem recebe o quê). |
| `public/ajuda.js` `TIPS['relatorios.avisos']` (l.132) | "Erro de disparo" | Citar o vigia e o freio de 3 h. |
| idem `TIPS` | `relatorios.vigia` (novo) | `O vigia avisa uma vez quando uma loja fica 3 execuções sem enviar, uma regra sai vazia 2 vezes, a extensão ou a Central ficam fora por 30 min ou passam de 10 as ofertas esperando revisão. Quando volta, avisa uma vez. No máximo um aviso por causa a cada 3 horas e nada no horário de silêncio.` |
| idem `LEIA_MAIS` (l.214) | `relatorios` | Apontar para o capítulo `resultados/avisos` (já aponta); incluir a âncora nova. |
| `public/docs/cap-grupos.js` ~311-340 (id `avisos`) | Tabela de avisos | Linhas novas: `Loja parada`, `Extensão ou Central fora`, `Revisão acumulada`, `Regra vazia`, `Voltou ao normal`, `Linha de saúde do resumo`; o que o dono faz em cada; o silêncio e os avisos acumulados; que "Erro de disparo" também recebe o vigia. A nota da l.337 (quem pode o quê) ganha "e os avisos do vigia". |
| `public/docs/cap-referencia.js` ~280 | Tabela de limites | Linha `Vigia` com os 5 números e `Fixo` na coluna "Onde mudar". |
| idem glossário ~91 | `Destino de aviso` | Acrescentar `e os avisos do vigia`; verbete novo `Vigia`. |
| `public/docs/cap-comecar.js` ~32 | Relatórios e avisos | Uma frase: o programa avisa se algo parar. |
| `public/docs/cap-conta.js` ~234 | Backup atrasado | Nenhuma mudança, só conferir que a frase "nunca na primeira hora" não vira regra do vigia (o vigia **não** tem essa carência: ver pergunta 5). |
| `public/docs/cap-disparos.js` ~252 e `cap-amazon-revisao.js` ~140-154 | Revisão | Frase: passou de 10 ofertas esperando, o vigia avisa. |
| `test/docs.test.js` `FATOS` | 5 fatos | Constantes do código lidas por regex (nomes do dev). O dev também ajusta o teste da linha 1280 (`relatorios.avisos`) para a redação nova. |

Procurar grafia antiga: `grep -rn "Erro de disparo\|no máximo um aviso a cada 30" public/docs public/ajuda.js public/relatorios.js README.md`.

## Arquivos de apresentação afetados
`public/app.js` (`faixa()`), `public/style.css` (pílula do vigia em duas linhas no celular, alvo de toque), `public/relatorios.js` (`TEXTOS`, linha informativa), `public/ajuda.js`, `public/docs/cap-grupos.js`, `cap-referencia.js`, `cap-comecar.js`, `cap-disparos.js`, `cap-amazon-revisao.js`, `README.md`. As mensagens do WhatsApp e as linhas do Histórico moram em `src/` (dev).

## Perguntas em aberto (para o dono, cada uma com sugestão)

1. **Reaproveitar a caixa "Erro de disparo" para receber o vigia ou criar uma caixa "Vigia"?** Sugestão: reaproveitar, mudando só a ajuda; quem recebe erro quer receber isso. Se criar: a caixa nasce marcada nos números que já têm "Erro de disparo".
2. **O vigia deve respeitar o horário de silêncio, sendo que o aviso de erro e o resumo não respeitam hoje?** O brief pede que respeite; recomendo manter. O dono pode querer ser acordado por uma parada longa de madrugada, mas as regras não enviam no silêncio e o aviso espera até de manhã.
3. **Lembrete se a causa dura muito?** Sugestão: sem lembrete no WhatsApp; a faixa mostra. Alternativa: um lembrete único depois de 12 h aberta.
4. **Revisão acumulada: fechar o aviso com menos de 10 ou menos de 5?** Sugestão: abre com 10 ou mais e "volta ao normal" com 5 ou menos, para 9-10-11 não ficar abrindo e fechando. Muda o número que entra em `FATOS` (5).
5. **O vigia tem carência de 1 hora depois de o programa ligar (como o backup atrasado)?** Sugestão: sim para extensão e Central (a extensão leva um tempo para conectar depois de reiniciar o serviço); não para as outras. Sem a carência, cada reinício do serviço pode gerar um aviso falso.
6. **A revisão acumulada conta a Shopee?** Hoje todo item da Shopee espera aprovação (até a entrega 4), então a contagem sobe sempre. Sugestão: contar tudo (é o que o dono precisa decidir) e aceitar que, até a entrega 4, o aviso pode vir por Shopee.
7. **Linha de saúde filtrada por bloco ou geral?** Sugestão: geral, rotulada "(todas as regras)", para não prometer o que as regras (que não sabem de bloco no resumo) não conseguem dar.
8. **Faixa com duas pílulas da E2 ou uma?** (Pergunta 7 da E2.) A spec do vigia funciona nas duas; só muda onde fica o tempo da Extensão/Central.
