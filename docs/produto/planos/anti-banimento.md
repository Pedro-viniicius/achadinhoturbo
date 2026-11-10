# Plano técnico: anti-banimento (cartão 05)
- Brief: não há; a fonte é o cartão do Trello "05 · Anti-banimento", repassado pelo lead. Spec: `docs/produto/specs/anti-banimento.md`
- Data: 2026-11-10

## Objetivo e critérios de aceite
Proteger o número conectado (Baileys, conexão não oficial) com teto de mensagens por hora, horário de silêncio e pausas variáveis aplicadas a todas as saídas, e mostrar quais grupos têm um admin só. Volume real (lead, `rastreio_envios`, de 05 a 09/11): 4 grupos, no máximo 16 mensagens/h, 26 a 50 por dia.

- CA1: teto de mensagens por hora do número, em janela deslizante de 60 min. Padrão 40, aceita de 1 a 200, já vem ligado e só o Dono muda.
- CA2: com o teto cheio, nenhuma mensagem a grupo sai. Nada se perde nem duplica: a regra é adiada; o envio da fila volta a `pendente` na mesma ocorrência e retoma só os grupos que faltam. Os atrasos máximos atuais continuam valendo (2 h para a fila, 30 min para a grade).
- CA3: cada vez que o teto enche entra **uma** linha `aviso` no Histórico, com a hora de liberação. Nunca `erro`, porque erro dispara o alerta por WhatsApp.
- CA4: toda mensagem que o número envia conta no teto: regras, Disparo manual, mensagem, enquete, espelho, remetente, catálogo, Grupo vivo, avisos, "Enviar teste" e resposta ao remetente. Teto e silêncio só seguram o que vai a **grupo**; o privado (avisos e resposta ao remetente) nunca fica preso.
- CA5: as pausas variam ±30% em torno do valor de Ajustes (isso já existe), com o aleatório injetável. Passa a haver um intervalo mínimo entre **quaisquer** duas mensagens, de qualquer origem. O `/state` expõe a variação.
- CA6: horário de silêncio global (padrão ligado, de 23:00 às 07:00, só o Dono muda): nada sai para grupo. A regra por intervalo é adiada para o fim do silêncio. O que tem hora marcada (horário da grade, agendado, repetido, Grupo vivo) e vence dentro do silêncio é pulado com `aviso`. O que é "agora" (Disparo manual, espelho, remetente, catálogo) espera, e o tempo de silêncio não conta para as 2 h. O "Funciona das/até" da regra continua valendo: os dois limites se somam.
- CA7: no Disparo manual e no Disparar mensagem, envio **"agora"** que cairia no silêncio mostra um aviso, com a opção "Enviar mesmo assim". Esse envio ignora o silêncio, mas não o teto. Agendado e repetido dentro do silêncio mostram só o aviso de que serão pulados (sem "mesmo assim"), e o servidor recusa `ignorar_silencio` fora de `quando: 'agora'` (400).
- CA8: Grupos mostra o selo "Falta 2º admin" em todo grupo com exatamente 1 admin. A contagem sai da sincronização que já existe, sem chamada nova ao WhatsApp, e guarda só o número de admins, sem identificar ninguém.
- CA9: Ajustes ganha o cartão "Proteção do número" (teto, uso, silêncio e pausas). Números ganha a linha de uso e a dica do chip reserva, como na spec.
- CA10: os docs acompanham: README, `TIPS`/`LEIA_MAIS`, capítulos e `FATOS`.
- CA11: `npm test` sem regressão: linha de base de 2376 testes, 0 falhas e 1 todo, mais os testes novos.

Fica fora do código (ação do dono): pôr um 2º admin em cada grupo, deixar o chip reserva pronto e combinar as ofertas por dia. "Pronto quando" se cumpre com CA1 e com Grupos sem nenhum selo.

## Contexto atual
- Só existe um número por vez: `createWhatsApp` mantém um único `sock` (`src/whatsapp.js:230-233`), e Números mostra um único "Conectado" (`public/app.js:632-647`). "Por número" equivale, portanto, ao número conectado.
- Há quatro caminhos que mandam mensagem:
  - regras: `wa.sendImage`/`sendText` em `src/scheduler.js:535-537`;
  - a fila de envios (`runEnvio`, `src/envios.js:1378-1453`), por onde passam o manual, a mensagem, a enquete, o espelho, o remetente, o catálogo e o Grupo vivo (`origemDoLog`, `src/envios.js:445`);
  - os avisos: `src/avisos.js:229`;
  - a resposta ao remetente: `src/remetentes.js:667`.
- Todos recebem o mesmo `wa` de `createScheduler` (`src/scheduler.js:102-114`), que nasce em `criarServicos` (`src/server.js:66-90`).
- As pausas já variam: `jitter` dá ±30% com `Math.random` (`src/util.js:7`, teste em `test/base.test.js:215`). As regras esperam `jitter(group)` e `jitter(offer)` (`src/scheduler.js:548,554`); a fila espera entre grupos (`src/envios.js:1442`) e entre um envio e outro conta só a partir da **última mensagem dela mesma** (`ultimaMensagem`, `src/envios.js:470,1481`). Ou seja, a última mensagem de uma regra e a primeira da fila podem sair coladas.
- O horário de funcionamento é por regra e só vale no modo intervalo: `inWindow`/`alignToWindow` (`src/scheduler.js:67-81`, aplicados em `:718` e `:574`). A grade ignora esse horário (`:598`). A fila, os avisos, o espelho e os remetentes não têm horário nenhum. Nada no código cobre um silêncio global.
- Limites de atraso: `ATRASO_MAX` de 2 h na fila (`src/envios.js:70,1479`). Passado esse prazo, o envio único vira linha `erro` (`:1465-1467`) e o repetido vira `aviso` (`:1462`). A grade tolera 30 min e o que passa disso vira aviso de "pulado" (`src/scheduler.js:600-623`); o texto `MOTIVO_PULADO` está fixado em `test/disparador.test.js:735,742,779` e em `test/docs.test.js:1264`.
- A retomada já existe: `okNaOcorrencia` pula os grupos que já receberam naquela ocorrência (`src/envios.js:1390-1393`), e a trava é `pendente → enviando` (`:1384`).
- Admins: `syncGroups` lê `groupFetchAllParticipating` a cada 10 min e no botão, mas grava só o `is_admin` do nosso número (`src/whatsapp.js:255-272`). Conferi no Baileys que os `participants` chegam com `admin` (`node_modules/@whiskeysockets/baileys/lib/Socket/groups.js:333-340`). A rota `/api/groups` devolve `g.*` (`src/server.js:367`), então uma coluna nova aparece sozinha.
- Ajustes: `PUT /api/ajustes` não exige o Dono e prende as pausas a mínimos de 2 s e 5 s com `Math.max` (`src/server.js:316-348`). Os mesmos números estão fixados em `FATOS` (`test/docs.test.js:749-752`, que leem `server.js`, `scheduler.js` e `envios.js`).
- Testes: muitos rodam no relógio real ou fixam o `Date` em horários de madrugada (`t.mock.timers` com `apis: ['Date']`, por exemplo `test/qa-grade-e2e.test.js:32`). Se o silêncio viesse ligado sem configuração, esses testes quebrariam ou ficariam instáveis conforme a hora em que `npm test` roda.

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| A. Porteiro `src/ritmo.js`: conta toda mensagem num embrulho do `wa` montado no agendador; teto e silêncio checados nos dois laços que mandam a grupos (regra e fila) | um só ponto de contagem; `whatsapp.js`, `avisos.js` e `remetentes.js` ficam intocados; o que excede fica na fila que já existe | o porteiro decide em dois laços | baixo |
| B. Contar e barrar dentro de `whatsapp.js` (`sendText` lança ou espera) | um ponto só | lançar vira "Falha no envio" (`erro` e alerta); esperar trava o tick por até 1 h e segura os avisos | alto |
| C. Contar pelas tabelas que já existem (`log` com `ok`, `rastreio_envios`) | sem tabela nova | o `log` não tem jid e inclui `ok` que não é mensagem (`src/server.js:527`); `rastreio_envios` ignora mensagens, enquetes e a Magalu | médio |

## Decisão
A abordagem A.
- **Janela deslizante de 60 min**, não hora cheia. A hora cheia deixaria sair 2×N mensagens em 2 minutos em volta da virada.
- Contagem numa tabela `wa_saidas (ts)`, sem jid nem número, que sobrevive ao reinício do `--watch`.
- **Padrões gravados só no início do serviço real**: `semearProtecao(db)` no bloco principal de `server.js`, com `INSERT OR IGNORE`. Sem a configuração, teto e silêncio ficam desligados. Assim os testes não dependem da hora em que rodam, e o dono recebe o padrão já ligado. Desligar o silêncio grava `'0'`, então o padrão não volta sozinho.
- **Teto de 40 por hora**: dá 2,5 vezes o pico real (16/h) e segura laço, rajada de espelho ou manual grande.
- **Silêncio**: tem hora marcada e cai no silêncio, é pulado; é "agora", espera. Uma mensagem de "boa noite" sair às 7h é pior do que não sair. Diverge da spec, ver o Alinhamento.
- **Intervalo mínimo entre mensagens**: o embrulho garante `jitter(delay_group_s)` entre quaisquer duas mensagens, medido com relógio monotônico (`performance.now`, injetável). Isso fecha a brecha entre regra e fila. A pausa entre ofertas das regras não muda.
- **Cortado nesta entrega (evito excesso)**:
  - o teto de ofertas por dia por grupo (opcional no cartão; precisaria saber o tipo de cada saída, ver P3);
  - pausas longas aleatórias;
  - a pausa "entre ofertas" entre envios da fila;
  - acompanhar admin ao vivo por promote/demote: o sync de 10 min basta.

## Esquema e contratos
- `src/db.js` (no `SCHEMA`, não destrutivo):
  - `CREATE TABLE IF NOT EXISTS wa_saidas (ts INTEGER NOT NULL)` e `CREATE INDEX IF NOT EXISTS idx_wa_saidas_ts ON wa_saidas (ts)`;
  - em `EXTRA_COLUMNS`, `['groups','admins','INTEGER']` (NULL = desconhecido).
- Settings: `wa_limite_hora` (1 a 200), `wa_silencio_ativo` ('1'/'0'), `wa_silencio_de` e `wa_silencio_ate` ('HH:MM', diferentes entre si). A semente grava 40, '1', '23:00' e '07:00'. As chaves `delay_*` ficam como estão.
- `src/util.js`:
  - `jitter(s, aleatorio = Math.random)`, que exporta `VARIACAO_PAUSA = 0.3`;
  - `inWindow` e `alignToWindow` mudam-se para cá (com `toMin`), e `scheduler.js` os reexporta, no padrão R14 (`test/base.test.js:214`).
- `src/ritmo.js` (novo), `createRitmo({ db, fast = false, agora = Date.now, monotonico = () => performance.now(), aleatorio = Math.random, dormir = sleep })`:
  - `registrar()`: faz o INSERT com `ts` e apaga o que tiver mais de 2 h;
  - `uso(now)` → `{ limite, usados, libera_em }`, com `limite` null quando desligado;
  - `liberado(now, { precisa = 1, ignorarSilencio = false })` → `{ ok: true }` ou `{ ok: false, motivo: 'limite'|'silencio', ate }`;
  - `silencio(now)` → `{ ativo, de, ate, agora, ate_ts }`;
  - `atrasoAgora(nextRunAt, now)`: o atraso menos a sobreposição com o último período de silêncio;
  - `embrulhar(wa)`: `Object.create(wa)` com `sendText`/`sendImage`/`sendPoll` que esperam o intervalo mínimo, chamam `wa.<fn>` **no momento do envio** (os testes trocam `s.wa.sendText`, ver `test/qa-grade-e2e.test.js:293`) e só registram se der certo;
  - `avisarLimite(log, uso)`: uma linha por vez que o teto enche, com o estado em memória zerado quando volta a haver vaga.
  - Exportados à parte: `semearProtecao(db)`, `validarProtecao(corpo)` (lança com a frase da spec), `LIMITE_HORA_PADRAO = 40`, `LIMITE_HORA_MAX = 200`, `SILENCIO_PADRAO`, `PAUSA_MIN_GRUPO_S = 2`, `PAUSA_MIN_OFERTA_S = 5`.
- `createScheduler({ …, ritmo })`: sem `ritmo`, cria um; o `wa` passado aos módulos internos é `ritmo.embrulhar(wa)`. `createEnvios({ …, ritmo = null })`: com null, o comportamento é o de hoje (os testes atuais criam a fila direto).
- `POST /api/envios`: aceita `ignorar_silencio: true` **só com `quando: 'agora'`** (outro `quando` → 400) e grava `payload.ignorar_silencio = true`. Só chega pelo `criar`: espelho, remetente, catálogo e rotina nunca gravam esse campo.
- `GET /api/state`: novo `protecao: { limite_hora, usados, libera_em, variacao_pausa, silencio: { ativo, de, ate, agora, ate_ts } }`. As pausas continuam em `ajustes`.
- `PUT /api/protecao`, com `exigeDono`, recebe `{ limite_hora, silencio_ativo, silencio_de, silencio_ate, delay_group_s, delay_offer_s }`. Valida tudo antes de gravar, e cada mudança vira uma linha `aviso` com "(por <nome>)", como em `src/server.js:322-332`. `PUT /api/ajustes` deixa de aceitar `delay_*` e responde 400 com "As pausas ficam em Proteção do número.".
- `GET /api/groups`: ganha `admins` (inteiro ou null), sem mudar a rota.
- Histórico (todas as linhas `aviso`):
  - teto: "Limite de {N} mensagens por hora atingido: o que falta sai a partir das {hh:mm}." (`rule_name` "Proteção do número");
  - silêncio numa regra por intervalo: "Horário de silêncio ({de} às {até}): disparo adiado para as {hh:mm}.";
  - silêncio na fila, uma vez por período: "Horário de silêncio ({de} às {até}): a fila espera até as {hh:mm}.";
  - envio marcado que caiu no silêncio: "Horário de {hh:mm} pulado: horário de silêncio." (o único fica com status `erro`, mas a linha do log é `aviso`);
  - horário da grade que caiu no silêncio: "Horário {hh:mm} pulado: horário de silêncio.";
  - "Enviar agora" da regra durante o silêncio: "Enviar agora não saiu: horário de silêncio até {hh:mm}.".

## Etapas
| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 1 | Esquema (`wa_saidas`, `groups.admins`); `inWindow`/`alignToWindow` mudam para util com reexport; `jitter(s, aleatorio)` e `VARIACAO_PAUSA`; teste de colunas, reexport e jitter determinístico | src/db.js, src/util.js, src/scheduler.js (só a mudança e o reexport), test/base.test.js | `node --disable-warning=ExperimentalWarning --test test/base.test.js` | dev | A | sim (migração) | CA1, CA5 |
| 2 | `src/ritmo.js` completo, com relógio, monotônico e aleatório injetados. Testes: janela deslizante e `libera_em` (inclusive com limite reduzido abaixo do uso), silêncio virando a noite, `de == ate` rejeitado, `atrasoAgora` (criado às 23:30 → 5 min às 07:05; criado há 2 dias → mais de 2 h), intervalo mínimo entre duas origens, registro só quando o envio dá certo, troca de `wa.sendText` depois de embrulhado, semente sem sobrescrever o '0' do dono, `validarProtecao` | src/ritmo.js, test/ritmo.test.js | `node --disable-warning=ExperimentalWarning --test test/ritmo.test.js` | dev | B | sim (concorrência) | CA1, CA3, CA4, CA5, CA6 |
| 3 | `syncGroups` conta `admin`/`superadmin`/`isAdmin`/`isSuperAdmin` em `participants` e grava `groups.admins`; nenhum jid gravado nem impresso. Teste com socket falso via `_usarSocket` | src/whatsapp.js, test/whatsapp.test.js | `node --disable-warning=ExperimentalWarning --test test/whatsapp.test.js` | dev | B | sim (dado pessoal) | CA8 |
| 4 | Agendador: embrulha o `wa` e passa o `ritmo` a `createEnvios`. No tick, regra por intervalo em silêncio → `next_run_at` = fim do silêncio, alinhado ao horário da regra, com aviso. Regra por intervalo sem vagas `min(grupos, limite)` → não roda, `next_run_at` intocado, aviso uma vez. Grade em silêncio → pula o horário com aviso e grava `proximoHorario`. Grade sem vagas → não roda e a tolerância de 30 min continua valendo, com `MOTIVO_PULADO` intocado. No `runRule`, antes de cada oferta, `liberado({ precisa: min(grupos, limite) })`: se faltar vaga, para; a regra por intervalo fica com `next_run_at = libera_em`, e na grade o horário se encerra como no CA7 da grade. O "Enviar agora" respeita os dois | src/scheduler.js, test/ritmo-agendador.test.js | `node --disable-warning=ExperimentalWarning --test test/ritmo-agendador.test.js test/disparador.test.js test/qa-grade-e2e.test.js` | dev | C | sim (concorrência) | CA2, CA3, CA4, CA6 |
| 5 | Fila: `processarPendentes`, com `ritmo`. Em silêncio, sem `ignorar_silencio`: marcado (agendado, repetido ou origem `rotina`) → pula com aviso (o repetido segue para a próxima ocorrência); "agora" → espera e o atraso vem de `atrasoAgora`. Sem vaga → `break`. A espera própria entre envios (`ultimaMensagem`) sai, porque o embrulho cuida dela. `runEnvio`: checa `liberado` antes de cada grupo; se não houver vaga, `adiado` e `finalizar` devolve `pendente` na mesma ocorrência (`AND status='enviando' AND next_run_at=?`), sem gravar `resultado`. `criar` aceita `ignorar_silencio` | src/envios.js, test/ritmo-envios.test.js | `node --disable-warning=ExperimentalWarning --test test/ritmo-envios.test.js test/envios.test.js` | dev | C | sim (concorrência) | CA2, CA3, CA4, CA6, CA7 |
| 6 | Servidor: `protecao` no `/state`; `PUT /api/protecao` com `exigeDono` (403 para o Operador), validação e aviso com "(por …)"; `delay_*` sai de `PUT /api/ajustes`; `semearProtecao(db)` no bloco principal, depois do `openDb` | src/server.js, test/ritmo-servidor.test.js | `node --disable-warning=ExperimentalWarning --test test/ritmo-servidor.test.js test/servidor.test.js test/seguranca.test.js` | dev | C | sim (autorização) | CA1, CA5, CA6 |
| 7 | Painel, como na spec: cartão "Proteção do número" (substitui o de pausas; faixa "Na prática" por `variacao_pausa`; uso e teto), linha de uso e dica do chip em Números, `<small>` em "Funciona das", selo e `#aviso-admin` em `tabelaGrupos` (só com o WhatsApp aberto e `admins === 1`), barra `progress`, `TIPS` novos (`ajustes.protecao`, `ajustes.limite_hora`, `ajustes.silencio`, `grupos.admin`, `ajustes.pausas` atualizado) | public/app.js, public/paineis.js, public/style.css, public/ajuda.js, test/protecao-painel.test.js | `node --disable-warning=ExperimentalWarning --test test/protecao-painel.test.js test/qa.test.js test/equipe-qa.test.js` | dev (com o designer revisando) | D | não | CA8, CA9 |
| 8 | Disparo manual e Disparar mensagem: com `S.st.protecao.silencio`, o "agora" dentro do silêncio mostra o aviso, com "Enviar mesmo assim" (manda `ignorar_silencio: true`) e "Cancelar"; a hora agendada ou repetida dentro do silêncio mostra só o aviso de que será pulada, sem "mesmo assim". Sem botão "mesmo assim" para o teto | public/disparos.js, test/protecao-disparos.test.js | `node --disable-warning=ExperimentalWarning --test test/protecao-disparos.test.js` | dev | D | não | CA7 |
| 9 | Docs:<br>- seção nova `manutencao/protecao-do-numero` em cap-conta.js, e a seção `ajustes` atualizada;<br>- cap-disparos.js: `pausas`, "Funciona das" e Grupo vivo no silêncio;<br>- cap-grupos.js: selo e como resolver;<br>- cap-referencia.js: limites padrão;<br>- cap-comecar.js:72: chip reserva;<br>- README: anti-banimento, padrões e "o que é pulado";<br>- `LEIA_MAIS` das chaves novas;<br>- `FATOS`: 40/h, faixa de 1 a 200, 23:00 e 07:00, ±30%, e as linhas 749-752 passam a ler também ou só `src/ritmo.js`.<br>Procure "Salvar pausas" e "Ajustes → Pausas entre mensagens" em `public/docs/` | public/docs/cap-conta.js, public/docs/cap-disparos.js, public/docs/cap-grupos.js, public/docs/cap-referencia.js, public/docs/cap-comecar.js, public/ajuda.js, README.md, test/docs.test.js | `node --disable-warning=ExperimentalWarning --test test/docs.test.js test/qa.test.js test/docs-motor.test.js` e, no fim, `npm test` | dev | E | não | CA10, CA11 |

Ordem: A → B (2 e 3 em paralelo) → C (4, 5 e 6 em paralelo) → D (7 e 8 em paralelo) → E. Não há arquivo comum dentro de um mesmo grupo; `ajuda.js` aparece em 7 e 9, que estão em grupos diferentes. `test/qa.test.js` exige verbete em `TIPS` para todo `q()` novo (`test/qa.test.js:1109-1116` cobre o `LEIA_MAIS`), por isso os `TIPS` vão na etapa 7, junto com os `q()`.

## Pontos para o seguranca
- `PUT /api/protecao`: `exigeDono` mais Host/Origin; inteiros e `HH:MM` estritos; tudo validado antes de gravar qualquer campo; `porQuem` cortado em 60 caracteres.
- `ignorar_silencio`: só pelo `criar` (Operador também pode, como já pode disparar). Conferir que `gravarEnvio` (espelho, remetente, rotinas, catálogo) não repassa o campo vindo de texto recebido.
- `wa_saidas` guarda só `ts`. A contagem de admins não grava, não registra no log e não manda ao console nenhum participante (`whatsapp.js` é a fronteira do dado pessoal).
- Concorrência: o caminho `adiado` usa a mesma trava `status='enviando' AND next_run_at=ocorrencia`; não pode haver duplo envio na retomada nem envio preso em `enviando`.
- Os avisos ao dono nunca são segurados: um alerta de erro não pode sumir por causa do teto. Nenhuma linha nova é `erro`.
- O embrulho não muda o que vai ao Baileys e não registra o jid.

## Riscos e como reverter
- **Migração**: só tabela e coluna novas, sem perda de dados. Para reverter, basta voltar o código: a tabela e a coluna ficam sem uso. Não é preciso migração destrutiva.
- **Desligar sem deploy**: o dono põe o teto em 200 e desliga o silêncio em Ajustes.
- **Fila de manhã**: o que espelhou durante a madrugada sai às 07:00, limitado pelo teto e pelas pausas. O verificador descarta oferta velha (frescor de 30 min, `src/verificador.js:58`) e esse descarte é `aviso`.
- **Testes com `fast:false`** podem ficar mais lentos por causa do intervalo mínimo novo (por exemplo, regra seguida de aviso). O dev roda `npm test` inteiro no fim da etapa 5.
- **"Enviar teste"** pode demorar até cerca de 8 s se acabou de sair uma mensagem: ele também respeita o intervalo mínimo.
- **Disputa** entre o "Enviar teste" (pela requisição HTTP) e o tick pode deixar duas mensagens a menos que o intervalo mínimo uma da outra. Aceito: é raro e não justifica uma trava global, que travaria tudo se o Baileys travasse.
- **Trocar para o chip reserva** herda a contagem da última hora. Isso é conservador e aceito.

## Perguntas em aberto e premissas adotadas
**Decididas pelo dono em 2026-11-10:**
- **P1**: 40/h e silêncio ligado das 23:00 às 07:00.
- **P2**: só o Dono muda a proteção, **inclusive as pausas** (o Operador vê, não muda).
- **P3**: o teto de ofertas por dia por grupo fica fora desta entrega.
- **P4**: no silêncio, o que tem hora marcada é **pulado** com aviso.
- **P5**: "Enviar mesmo assim" vale **só para o envio "agora"**. Agendado e repetido seguem o silêncio sempre.
- **Premissa**: hora local do computador, a mesma do "Funciona das" (spec, pergunta 7).

## Alinhamento com a spec ([ARQ])
1. **Modelo do contador**: janela deslizante. Usar "Na última hora: x de N" e "a partir das {hh:mm}".
2. **Disparo manual e "Enviar teste"**: o teto vale para tudo que vai a grupo, inclusive o Disparo manual, sem "mesmo assim". O "Enviar teste" e os avisos são privados: contam no teto, mas nunca ficam presos.
3. **Campos**: `/state.protecao` e `/groups[].admins` como descritos acima. A contagem de admins é feita no sync (etapa 3).
4. **Variação das pausas**: ±30%, em `protecao.variacao_pausa`. O painel calcula `round(s*0,7)` a `round(s*1,3)`.
5. **Padrões**: 40/h e silêncio ligado. O teto por dia sai do cartão nesta entrega (P3).
6. **Quem pode mudar**: só o Dono, pela rota própria `PUT /api/protecao`.
7. **Histórico**:
   - a frase do teto fica sem "{k} adiadas", porque a contagem em várias filas é cara e imprecisa;
   - no silêncio, a regra é "adiada", mas o horário da grade, o agendado e o Grupo vivo são "pulados" (P4), diferente do "sai quando acabar" da spec;
   - "Agendar para 07:00" não entra: a oferta manual é só "hoje", e o frescor do verificador impediria o envio de qualquer forma.

## ADR
**ADR-012: um porteiro único para as saídas do WhatsApp.** Contexto: a conexão não é oficial e há quatro caminhos de envio. Decisão:
- toda mensagem passa por um embrulho do `wa` montado no agendador, que conta (em `wa_saidas`) e impõe o intervalo mínimo;
- teto (janela deslizante) e silêncio são checados só nos laços que mandam a grupos;
- o excedente fica na fila existente (regra adiada, envio de volta a `pendente` na mesma ocorrência);
- os padrões são gravados no início do serviço real, e sem configuração tudo fica desligado.

Consequências: um ponto só para mudar o ritmo; `whatsapp.js`, `avisos.js` e `remetentes.js` não mudam; quem cria `createEnvios` sem `ritmo` mantém o comportamento antigo. Rejeitados: barrar em `whatsapp.js` (erro e alerta, ou tick travado) e contar pelo `log` (sem jid, com `ok` que não é mensagem).

## Decisões da rodada 1 de revisão (lead, 2026-11-10)
- **R1 = S4**: envio "agora" segurado pelo teto por mais de 2 h é descartado com linha `aviso` e o motivo do teto ("o limite de N mensagens por hora ficou cheio por mais de 2 h"), nunca `erro`. "Nada se perde" passa a valer para até 2 h de espera.
- **R2**: o "Enviar agora" de rotina do Grupo vivo dentro do silêncio é recusado na hora (400, sem gravar envio nem avançar o rodízio), em vez de ser pulado.
- **S1 = Q2 / Q1**: o teto reserva vagas de forma síncrona (`vaga().pedir/usar/soltar` em `src/ritmo.js`), por grupo; uma oferta para mais grupos do que o teto deixa vai só aos que couberam.
- **R4**: `POST /api/rules/:id/run` barrado por silêncio ou teto responde 409 com a frase.
- **S2**: pausas gravadas fora da faixa valem como o mínimo ou o máximo também na leitura.
