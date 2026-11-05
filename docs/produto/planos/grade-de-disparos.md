# Plano técnico: grade de horários no Disparo automático e "Grupo vivo"
- Brief: não há. Fonte: pedido do dono, repassado pelo lead em 2026-11-05 ("…deixar para publicar em determinados horários do dia, quantos vão nesse momento, que tipo de template em cada espaçamento… e também poder disparar mensagens que deem confiança para o membro… Faz isso, mas sem derrubar o atual").
- Spec (designer): `docs/produto/specs/grade-de-disparos.md`, adotada com os ajustes da seção "Alinhamento com a spec".
- Data: 2026-11-05. Linha de base: `TMPDIR=$HOME/.cache/achtmp npm test` → 1130 testes, 1129 passam, 0 falham, 1 todo.
- **Aprovado pelo dono em 2026-11-05**, com as premissas P1–P18 como estão. O teto anti-ban é só aviso acima de 400 mensagens por dia, sem bloquear. As duas entregas (grade e Grupo vivo) seguem juntas.
- **Fora da 1ª versão (decisão do lead na rodada 1):** o aviso "Não dá tempo antes do próximo horário", citado na spec e na tabela de riscos, não foi implementado. Pela regra "sem avisos técnicos", o único sinal é o aviso de horário pulado no Histórico.
- `docs/produto/decisoes.md` não existe. Nenhuma decisão registrada foi reaberta.
- **Corte sugerido:** a Entrega 1 é a grade (etapas 1 a 4 e 7, e a parte da grade na 9). A Entrega 2 é o Grupo vivo (etapas 5, 6, 8 e o resto da 9). Elas não dependem uma da outra. A etapa 1 cria as duas estruturas de banco; a tabela `rotinas` vazia não afeta nada.

## Objetivo e critérios de aceite
Dar ao Disparo automático uma segunda forma de ritmo: horários marcados, cada um com a sua quantidade e o seu template. Criar uma seção "Grupo vivo" com rotinas recorrentes de mensagem e enquete, com textos em rodízio. Tudo sem mudar o comportamento de nada do que já existe.
- CA1 **Sem derrubar o atual.** Regra sem grade, incluindo todas as que já existem, se comporta exatamente como hoje: o mesmo `next_run_at` (intervalo + janela), os mesmos campos e a mesma API. A migração só acrescenta uma coluna nula e uma tabela nova. Todos os testes atuais continuam verdes. "Disparar mensagem" e o "Repetir" continuam como estão.
- CA2 **A grade é opcional por regra.** Regra nova nasce em "A cada X minutos". Trocar para "Em horários marcados" e voltar restaura o ritmo anterior, porque `per_run`, `interval_min` e a janela continuam gravados.
- CA3 **Conteúdo da grade.** Dias da semana (padrão: todos) e de 1 a 48 horários `HH:MM`, cada um com ofertas de 1 a 20 e template opcional (vazio = template da regra). Sem horário repetido e com pelo menos 10 min entre dois horários seguidos. Grade inválida volta 400 com uma frase de tela. Template inexistente é recusado.
- CA4 **Modelos rápidos e gerador** ("a cada X min, de H1 a H2, N ofertas, template T") preenchem as linhas. O servidor só vê a lista final.
- CA5 **Execução.** No horário, sai a quantidade daquele horário com o template daquele horário, para os grupos da regra, no mesmo tick, um envio de cada vez e com as pausas de Ajustes. No modo grade, a janela "Funciona das/até" não vale.
- CA6 **Horário perdido.** Atraso de até 30 min: o horário sai. Atraso maior (programa desligado, WhatsApp fora, fila ocupada): o horário é pulado, com uma linha de aviso no Histórico. Se vários horários venceram, sai só o mais recente: nunca há dois horários atrasados em rajada.
- CA7 **Faltam ofertas.** Sai o que houver, sem acumular para o horário seguinte. Com 0 ofertas, a mensagem é a de hoje. Com menos que o pedido, aparece um aviso "saíram N de M".
- CA8 **Enviar agora e Ver ofertas** numa regra com grade usam a quantidade e o template do próximo horário. "Enviar agora" não mexe no próximo horário.
- CA9 **Cartão.** Chip "Grade", resumo e "Próximo envio … N ofertas com o template X", conforme a spec. O cartão de regra sem grade fica idêntico ao de hoje.
- CA10 **Template em uso.** Template usado em algum horário de grade não pode ser apagado (a mensagem cita a regra e o horário). Se o template sumir na hora do envio, a oferta sai com o template da regra e entra um aviso.
- CA11 **Grupo vivo: rotinas.** Cada rotina tem nome, chave liga/desliga, tipo (mensagem ou enquete), de 1 a 5 conteúdos em rodízio ("um depois do outro" ou "sorteio"), grupos, dias e de 1 a 6 horários. A ocorrência sai pela fila única de envios, com as pausas de Ajustes, e aparece no Histórico como "Grupo vivo: <nome>". Horário perdido segue a regra do CA6. É possível editar, copiar, excluir (o que já saiu fica no Histórico) e "Enviar agora".
- CA12 **Galeria de modelos.** Os modelos da spec preenchem o formulário, e nada é salvo até "Criar rotina".
- CA13 **Anti-ban.** O painel estima as mensagens por dia do número (regras ligadas + rotinas ligadas) e mostra um aviso acima de 400. Não há teto que bloqueie (P5).
- CA14 **Docs.** README, `TIPS`/`LEIA_MAIS`, os capítulos `disparo-automatico` (ritmo) e `mensagens` (Grupo vivo) e, em `FATOS`, os números 48, 10, 30, 5 e 400.

## Contexto atual
- **O "espaçamento" de hoje é intervalo fixo dentro de uma janela.** Colunas `per_run` (padrão 3), `interval_min` (60), `window_start`/`window_end` (`src/db.js:21-22`). No fim de cada execução: `next = alignToWindow(now + interval_min)` (`src/scheduler.js:303`). Com o WhatsApp fora, tenta de novo em 60 s (`:226-231`, `:303`). A janela pode virar a noite (`:37-51`). Um template e uma quantidade por regra: `per_run` em `:242` e o template em `:234`.
- **Tick** a cada 15 s (`src/scheduler.js:411`), na ordem envios → espelho → remetentes → avisos → regras (`:368-397`). Para cada regra: pula se `next_run_at > now`; fora da janela, realinha (`:381-384`); sem WhatsApp, `continue` (`:385`). `next_run_at` NULL = roda já. `PUT /api/rules/:id` e o liga/desliga zeram `next_run_at` (`src/server.js:529-535`).
- **Pausas anti-ban:** só as de Ajustes, `delay_group_s` ≥ 2 e `delay_offer_s` ≥ 5 (`src/server.js:280-281`, `src/scheduler.js:80-83`). **A janela não fica em Ajustes, fica em cada regra** (`public/app.js:434-435`). Ajustes só tem pausas (`public/app.js:643-646`). Não existe teto diário em lugar nenhum (busquei e não achei).
- **API de regras:** `ruleFromBody` valida `per_run` de 1 a 20 e intervalo ≥ 1 (`src/server.js:469-506`). As colunas estão em `COLS` (`:508`), o `GET` em `:524`, o "Enviar agora" em `:549` e a prévia em `:550`. Apagar um template só confere `rules.template_id` (`:460-466`). `parseRule` lê os JSON da regra (`src/db.js:227-237`). Colunas novas entram por `EXTRA_COLUMNS` (`:132-144`).
- **Disparar mensagem já cobre parte do "grupo vivo":** mensagem e enquete, agora, agendada ou repetida (`dias` 0-6 + de 1 a 6 horários, `MAX_HORARIOS`, `src/envios.js:52`, `:315-328`), com o próximo horário calculado por `proximaOcorrencia` (exportada, `:345-366`), pausar/retomar/cancelar (`:1163-1182`) e "perdeu o horário" (2 h, `:46`, `:1000-1012`). **O que falta:** nome, chave liga/desliga, editar (só existe cancelar, `:1358`), rodízio de textos e galeria de modelos. Cada repetição é um item solto na lista "Agendadas".
- **Templates exigem `{LINK}`** (`src/server.js:448-450`): não servem para mensagem de engajamento.
- **Padrão para gravar na fila:** módulos que decidem e gravam `envios` com `quando='agora'` e depois chamam `acordar` (`src/remetentes.js:440-444`). O prefixo do Histórico vem de `origemDoLog` (`src/envios.js:371`). As fotos de upload são apagadas 7 dias depois de ficarem sem envio ativo (`limparFotos`, `src/envios.js:1093`). Por isso uma rotina com foto perderia a foto.
- **Painel:** `cartaoRegra` (`public/app.js:80-93`), `formRegra` com o "Ritmo de envio" (`:405-436`), `ROTAS` (`:671-682`), menu (`public/index.html:31-34`), scripts (`:74-81`), `DISP_DIAS`/`dispSegHtml` em `public/disparos.js`. O harness vm (`test/equipe-qa.test.js`) roda todos os `<script>`. `test/qa.test.js` exige verbete em `TIPS` para todo `q('…')`.
- **Docs:** seção "Ritmo e horário" (`public/docs/cap-disparos.js:250-263`), "Agora, agendada ou repetida" (`:380-392`), `TIPS` `regras.*` (`public/ajuda.js:39-41`), `FATOS` (`test/docs.test.js:728`, com o número 6 da repetição em `:739`).
- O serviço roda com o fuso do sistema, `America/Sao_Paulo` (`timedatectl`). O unit não define `TZ`.

## Abordagens consideradas
**Grade**
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| **Coluna JSON `rules.grade` (NULL = intervalo)** | mesmo padrão de `sources`/`group_jids`/`envios.repetir`; `ALTER TABLE` não destrutivo; `proximaOcorrencia` reaproveitada | checar template em uso exige ler o JSON das regras (são poucas) | baixo |
| Tabela `regra_horarios` (uma linha por horário) | FK e consulta por template diretas | migração e CRUD a mais, gravação em duas tabelas por regra | médio |
| Gerar regras-filhas por horário | nenhum código no agendador | multiplica regras, `sent_offers` e o "não repetir" por regra viram um por filha | alto |

**Grupo vivo**
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| Estender `envios` repetido (nome, variações, `PUT`) | nada de tabela nova | edição de uma linha que pode estar `enviando`; cancelar = excluir; aparece em "Agendadas" de Disparar mensagem; foto apagada pelo `limparFotos` | médio |
| **Tabela `rotinas` (configuração) que grava uma ocorrência `envios` "agora" no horário** | o padrão do espelho e dos remetentes; editar e ligar/desligar sem tocar na fila; a fila e o Disparar mensagem não mudam | módulo novo (pequeno) | baixo |

## Decisão
- D1 **Grade = `rules.grade TEXT`**, `{ dias:[0..6], horarios:[{ hora:'HH:MM', qtd:1..20, template_id:int|null }] }`. NULL = modo intervalo, com o código de hoje intacto. As colunas `per_run`, `interval_min`, `window_*` e `template_id` continuam gravadas e validadas como hoje. `template_id` é o "Padrão da regra".
- D2 **`src/grade.js`, sem estado:**
  - `validarGrade(g, { templateExiste })` devolve a grade normalizada ou `null`. Ordena, tira espaços, recusa campos a mais e aplica os limites do CA3.
  - `proximoHorario(grade, depoisDe)` = `proximaOcorrencia({ dias, horarios: horas }, depoisDe)`.
  - `horarioDe(grade, ts)` devolve a linha cujo `HH:MM`, no dia de `ts`, é exatamente o de `ts`.
  - `resolverVencido(proximo, visto, now, tolMs)` devolve `{ executar: ts|null, pulados: [ts], proximo: ts }`. Avança enquanto `proximo(h) <= now` (laço limitado a 400 voltas). O último vencido sai se `now - h <= tolMs`. A função serve à grade e às rotinas.
  - Constantes: `MAX_HORARIOS_GRADE = 48`, `INTERVALO_MIN_GRADE = 10`, `TOLERANCIA_MIN = 30`, `MAX_QTD_GRADE = 20`.
- D3 **Tick.** Para regra com grade, antes da checagem de janela (`src/scheduler.js:381`):
  - `next_run_at` NULL: grava `proximoHorario(now)` e não envia.
  - No futuro: pula.
  - Vencido: `resolverVencido`. Se houve pulados ou não há o que executar: uma linha `aviso` ("Horário 09:00 pulado: o programa estava desligado, o WhatsApp desconectado ou outro envio demorou. Próximo: 10:00."), grava o próximo e segue.
  - Sem WhatsApp: `continue` sem mexer, como hoje. O horário vence e é pulado depois de 30 min.
  - Senão: `runRule(id, { horario: ts })`.
  - A janela nunca é aplicada a regra com grade.
- D4 **`runRule(id, { manual, horario })`.**
  - Linha do horário: `horarioDe(grade, horario)`. Em "Enviar agora", é a linha do próximo horário.
  - `want = linha?.qtd ?? per_run`. Template: o da linha, senão o da regra. Se o template da linha sumiu: usa o da regra e registra aviso.
  - Se saiu menos que `want`: aviso "Horário 09:00: saíram 2 de 5 ofertas; não havia mais ofertas novas dentro dos filtros."
  - No `finally`, com grade:
    - execução manual: mantém `next_run_at` (ou calcula, se for NULL);
    - `retrySoon`: mantém o horário vencido;
    - fora isso: `proximoHorario(grade, horario)`, mesmo que já tenha passado, e o tick resolve pelo D3.
  - Sem grade: a linha `:303` fica exatamente como está.
  - `previewOffers` usa a linha do próximo horário.
- D5 **API de regras.** `ruleFromBody` aceita `grade` (`null` ou objeto) e devolve a grade validada. `COLS` ganha `grade`, e o `PUT` já zera `next_run_at` (o tick recalcula pelo D3). `GET /api/rules` traz `grade` lida e `proximo_horario: { ts, hora, qtd, template_id } | null`. `/api/state` ganha `grade: { max_horarios, intervalo_min, tolerancia_min, max_qtd, max_conteudos, max_horarios_rotina }`. Apagar template: bloqueia também se alguma `grade` o usa ("A regra X usa este template no horário 10:00.").
- D6 **Rotinas (`src/rotinas.js`, `createRotinas({ db, wa, acordar })` + `montarRotas`).**
  - Tabela `rotinas`, com `repetir` igual ao do Disparar mensagem.
  - `processarPendentes(now)`:
    - rotinas ligadas e vencidas passam por `resolverVencido(proximaOcorrencia…)`, com tolerância de 30 min;
    - pulado: uma linha `aviso` "Grupo vivo: <nome>";
    - para executar, numa transação `BEGIN IMMEDIATE`: trava atômica `UPDATE rotinas SET next_run_at=?, proximo_indice=?, last_run_at=?, ultimo_envio_id=? WHERE id=? AND next_run_at=?` (`changes===1`), depois `INSERT envios` (`tipo` da rotina, `quando='agora'`, `next_run_at=now`, só os grupos que ainda existem);
    - payload: `{texto, imagem:'nenhuma', origem}` ou `{pergunta, opcoes, multipla, origem}`, com `origem={tipo:'rotina', rotina_id, nome}`;
    - em seguida, `acordar()`.
  - Rodízio: `proximo_indice % n`. Sorteio: índice aleatório diferente do último quando há 2 ou mais.
  - Sem grupo existente: aviso, sem envio.
  - "Enviar agora" grava a ocorrência já e avança o rodízio, mas não mexe em `next_run_at`. Exige WhatsApp conectado, com a frase de `criar`.
  - Ligar/salvar: `next_run_at = proximaOcorrencia(repetir, now)`. Desligar: `next_run_at = NULL`.
  - Sem foto na 1ª versão (P9).
- D7 **Ligação.** `envios.js` exporta `validarEnquete` e `validarTextoMensagem` (o trecho de texto de `validarMensagem`, mesmas mensagens), e `origemDoLog` ganha o prefixo `rotina: 'Grupo vivo'`. Em `painel()`, a condição `em` exclui `origem.tipo='rotina'` (`json_extract`), para o Disparar mensagem continuar mostrando só o que é dele. O agendador ganha `passoRotinas` antes das regras e junto do espelho e dos remetentes depois de cada regra. O servidor monta `rotasRotinas`. Operador tem os mesmos direitos de hoje, sem `soDono` (P11).
- D8 **Painel conforme a spec:** `public/grade.js` (editor da grade, gerador, resumo, estimativa anti-ban) e `public/grupovivo.js` (página, cartões, formulário, galeria `MODELOS_GRUPO_VIVO`). Os dois carregam antes de `app.js`, sem usar `esc` no topo e sem nomes globais repetidos. Fica fora a "variação de horário" (P8).

## Esquema e contratos
```sql
-- src/db.js, não destrutivo
-- EXTRA_COLUMNS: ['rules', 'grade', 'TEXT']   -- NULL = intervalo (comportamento de hoje)
CREATE TABLE IF NOT EXISTS rotinas (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  tipo TEXT NOT NULL CHECK (tipo IN ('mensagem','enquete')),
  conteudos TEXT NOT NULL DEFAULT '[]',        -- mensagem: ["texto",…]; enquete: [{pergunta,opcoes,multipla}]; 1..5
  ordem TEXT NOT NULL DEFAULT 'rodizio' CHECK (ordem IN ('rodizio','sorteio')), proximo_indice INTEGER NOT NULL DEFAULT 0,
  group_jids TEXT NOT NULL DEFAULT '[]', repetir TEXT NOT NULL,   -- {dias:[0..6], horarios:['HH:MM'] 1..6}
  next_run_at INTEGER, last_run_at INTEGER, ultimo_envio_id INTEGER, created_at INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_rotinas_fila ON rotinas (enabled, next_run_at);
```
- `parseRule` acrescenta `grade`: o objeto, ou `null` se vier vazio ou se o JSON for inválido.
- Rotas, todas depois do login e do Host/Origin:
  - `GET /api/rotinas` devolve `[{ id, nome, enabled, tipo, conteudos, ordem, group_jids, repetir, next_run_at, enviadas_24h, erros_24h, ultimo_erro_grupo }]`, com o nome do grupo e nunca o JID na mensagem.
  - `POST /api/rotinas` e `PUT /api/rotinas/:id` recebem `{ nome (1..60), tipo (só no POST), conteudos, ordem, group_jids, repetir, enabled }`.
  - Também: `POST /api/rotinas/:id/enabled {enabled}`, `POST /api/rotinas/:id/enviar` e `DELETE /api/rotinas/:id`.
- Frases de erro: as da spec ("Dê um nome à rotina.", …). As de enquete e texto vêm dos validadores de `envios.js`.

## Etapas
| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 1 | `rules.grade` em `EXTRA_COLUMNS`, tabela `rotinas` + índice e `grade` em `parseRule`. Testes: banco antigo com regras e dados abre sem perder nada, com `grade` NULL e `parseRule` igual ao de antes (fora `grade:null`); JSON inválido vira `null` | `src/db.js`, `test/base.test.js` | `node --disable-warning=ExperimentalWarning --test test/base.test.js` | dev | A0 | sim (migração) | CA1, CA2, CA11 |
| 2 | `src/grade.js` (D2). Testes: limites do CA3 (49 horários, 9 min, repetido, qtd 0/21, template inexistente, campos a mais); `proximoHorario` com dias; `horarioDe`; `resolverVencido` com atraso de 29 e 31 min, três vencidos (sai só o último), nenhum dia válido e virada da semana | `src/grade.js`, `test/grade.test.js` | `node --disable-warning=ExperimentalWarning --test test/grade.test.js` | dev | A0 | sim (agendador) | CA3, CA6 |
| 3 | Agendador (D3, D4). Testes com `fast` e WhatsApp simulado: regra sem grade com `next_run_at` idêntico ao de hoje (intervalo e janela, inclusive o retry de 60 s); grade com NULL não envia e grava o próximo; horário vencido sai com a qtd e o template da linha; fora da janela antiga sai mesmo assim; atraso de 31 min pula com aviso; WhatsApp fora mantém o horário; template da linha apagado usa o da regra; "saíram N de M"; manual não mexe no próximo; prévia usa o próximo horário | `src/scheduler.js`, `test/disparador.test.js` | `node --disable-warning=ExperimentalWarning --test test/disparador.test.js test/catalogo-regras.test.js` | dev | B | sim (agendador, concorrência) | CA1, CA5 a CA8, CA10 |
| 4 | API de regras (D5). Testes: `POST`/`PUT` sem `grade` gravam NULL e devolvem o mesmo que hoje; grade válida volta normalizada; inválida volta 400 com frase; `GET` traz `proximo_horario`; `/api/state.grade`; apagar template usado numa grade é bloqueado | `src/server.js`, `test/servidor.test.js` | `node --disable-warning=ExperimentalWarning --test test/servidor.test.js` | dev | B | sim (entrada, banco) | CA1 a CA3, CA9, CA10 |
| 5 | `src/rotinas.js` (D6, cadastro e rotas) + `envios.js` (exports, prefixo "Grupo vivo", `em` sem rotinas). Testes: validações; ocorrência grava `envios` "agora" com a origem; rodízio 0,1,2,0; sorteio sem repetir o último; trava atômica (dois `processarPendentes` juntos gravam um só envio); atraso de 31 min pula; grupo apagado é filtrado; "Enviar agora" sem WhatsApp falha; editar recalcula `next_run_at`; desligar = NULL; `GET` sem JID; painel de Disparar mensagem não conta envio de rotina; `json_extract` disponível no `node:sqlite` | `src/rotinas.js`, `src/envios.js`, `test/rotinas.test.js` | `node --disable-warning=ExperimentalWarning --test test/rotinas.test.js test/envios.test.js` | dev | B | sim (fila, banco, concorrência) | CA11 |
| 6 | Ligação (D7): `createScheduler` cria e expõe `rotinas` e roda `passoRotinas` (antes das regras e depois de cada regra); `server.js` monta `rotasRotinas` (`:602`) e põe `max_conteudos`/`max_horarios_rotina` em `/api/state`. Teste: rotina vencida sai pelo tick com "Grupo vivo: <nome>" no log | `src/scheduler.js`, `src/server.js`, `test/servidor.test.js` | `node --disable-warning=ExperimentalWarning --test test/servidor.test.js test/disparador.test.js` | dev | C | sim (agendador) | CA11 |
| 7 | Painel da grade (spec, "Layout: grade na regra" e "Cartão"): `public/grade.js`; `formRegra`/`cartaoRegra` em `app.js` com `grade` no corpo; `.gh-*` em `style.css`; `<script src="grade.js">` antes de `app.js`; estimativa de mensagens/dia com aviso acima de `AVISO_MENSAGENS_DIA = 400`; conversão "intervalo → grade" só quando cabe em 48 linhas (senão começa vazia). Teste: nomes de template e de regra maliciosos escapados; regra sem grade gera o mesmo HTML de cartão; harness vm carrega | `public/grade.js`, `public/app.js`, `public/style.css`, `public/index.html`, `test/grade-painel.test.js` | `node --disable-warning=ExperimentalWarning --test test/grade-painel.test.js test/equipe-qa.test.js` + painel em `PORT=3799 DATA_DIR=<tmp> DRY_RUN=1` | dev | C | sim (XSS) | CA2 a CA4, CA8, CA9, CA13 |
| 8 | Painel do Grupo vivo (spec, "Layout: Grupo vivo", "Formulário", "Galeria"): `public/grupovivo.js`; rota `grupo-vivo` em `ROTAS`; item de menu e `<script>` em `index.html`; `.sub` de Disparar mensagem com o link (única linha de `disparos.js`). Teste: textos e nomes maliciosos escapados; galeria não salva; harness vm | `public/grupovivo.js`, `public/app.js`, `public/index.html`, `public/disparos.js`, `public/style.css`, `test/grupovivo-painel.test.js` | `node --disable-warning=ExperimentalWarning --test test/grupovivo-painel.test.js test/equipe-qa.test.js` + painel `DRY_RUN=1` | dev | D | sim (XSS) | CA11, CA12, CA13 |
| 9 | Docs: `TIPS` da spec (`regras.modo_grade`, `regras.grade_horarios`, `regras.grade_modelos`, `grupovivo`, `grupovivo.rodizio`) + `LEIA_MAIS`; seção "Horários marcados" em `disparo-automatico` e "Grupo vivo" em `mensagens`; README (linha 7 + seção); `FATOS` para 48 horários, 10 min, 30 min de tolerância, 5 conteúdos e 400 mensagens/dia | `public/ajuda.js`, `public/docs/cap-disparos.js`, `README.md`, `test/docs.test.js` | `node --check public/ajuda.js public/docs/cap-disparos.js && node --disable-warning=ExperimentalWarning --test test/docs.test.js test/qa.test.js test/qa-docs.test.js` | dev | E | não | CA14 |
| 10 | Suite completa e prova real: uma regra com 3 horários próximos (qtd e templates diferentes) e uma rotina "Bom dia" com 2 textos num grupo de teste; conferir Histórico, rodízio e o serviço da porta 3737 com o código novo | — | `TMPDIR=$HOME/.cache/achtmp npm test`; `systemctl --user status achadinhoturbo` | lead + dono | F | não | todos |

- **Paralelismo:** as etapas 1 e 2 (A0) não compartilham arquivo. Na B, 3, 4 e 5 usam `scheduler.js`, `server.js` e `rotinas.js`+`envios.js`, com testes distintos. Na C, a 6 fica em `src/` e a 7 em `public/`. A 8 fica em D porque divide `app.js`, `index.html` e `style.css` com a 7.
- **`test/qa.test.js` cai entre as etapas 7/8 e a 9**, porque os `q()` novos ainda não têm verbete. Por isso as verificações da 7 e da 8 não o rodam, e a 9 fecha. A 9 depende do texto final das telas.
- **Dependem da spec:** 7 e 8 (layout, textos `TEXTOS_GRADE`/`TEXTOS_GRUPO_VIVO`, modelos). Do plano para a spec vão os nomes de campo e os limites (contratos acima).

## Pontos para o seguranca
- Etapa 1: `ALTER` e `CREATE` só aditivos. Rollback de código deixa a coluna e a tabela sem uso. Conferir que `parseRule` nunca lança por causa de `grade` (uma regra quebrada não pode travar o tick).
- Etapa 2/4: tamanho e forma da grade (48 linhas, sem campos extras, inteiros conferidos). `template_id` precisa existir. O laço de `resolverVencido` é limitado.
- Etapa 3/6: o `running` continua impedindo execução dupla (tick + "Enviar agora"). Regra com grade nunca passa pelo `alignToWindow`. Falha de rotina vai por `passo` e não para o tick (console só com o código).
- Etapa 5: trava atômica e transação na ocorrência (sem envio duplicado com dois ticks). Grupos só da tabela `groups`. A API não devolve JID. Conteúdo validado com os mesmos limites de Disparar mensagem (4096; enquete 255/100, de 2 a 12 opções).
- Etapa 7/8: todo texto do dono (nome de rotina, textos, template, grupo) passa por `esc`.
- Anti-ban: há os limites duros do CA3 e 6 horários por rotina, mas o painel só avisa (400/dia). Não há teto no servidor (P5).

## Riscos e como reverter
| Risco | Mitigação | Reverter |
|---|---|---|
| Regressão no ritmo das regras atuais | caminho com grade separado, linha `:303` intocada, teste de equivalência na etapa 3 | `git revert` das etapas 3/4; regras sem grade não têm dado novo |
| Regra com grade depois de um rollback | `per_run`/`interval_min`/janela continuam gravados (D1) | com o código antigo, ela roda no intervalo anterior; `UPDATE rules SET grade = NULL` limpa |
| Rajada após o programa ficar desligado | `resolverVencido`: só o mais recente, até 30 min | ajustar `TOLERANCIA_MIN` |
| Fila longa atrasa um horário além de 30 min (20 ofertas × muitos grupos) | aviso no Histórico; o painel mostra "não dá tempo antes do próximo horário" | reduzir qtd ou grupos; subir a tolerância (P2) |
| `json_extract` indisponível | teste da etapa 5 | filtrar em JS a lista do `painel()` |
| Rotina gerando volume demais | 6 horários por rotina, chave desliga, aviso de 400/dia | desligar a rotina; `DELETE FROM rotinas` não toca no Histórico |

## Perguntas em aberto e premissas adotadas (decisões do dono)
| # | Decisão | Premissa adotada |
|---|---|---|
| P1 | Fuso | Hora do computador (`America/Sao_Paulo`), como o Repetir e a janela de hoje. |
| P2 | Horário perdido (programa desligado, WhatsApp fora, fila ocupada) | Sai se atrasar até 30 min. Passou disso, pula com aviso no Histórico. Se vários venceram, sai só o mais recente. Vale para a grade e para o Grupo vivo. |
| P3 | Catálogo com menos ofertas que a quantidade do horário | Sai o que houver, sem acumular para o próximo, com um aviso "saíram N de M". |
| P4 | Janela "Funciona das/até" no modo grade | Não vale: os horários dizem tudo. Fica guardada para quem voltar ao intervalo. |
| P5 | Teto anti-ban (hoje não há nenhum) | O painel avisa acima de 400 mensagens por dia no número (regras + rotinas ligadas), sem bloquear. O WhatsApp não publica limite: o número é uma estimativa conservadora (não verificado), e o dono pode trocar. Os limites duros são os da grade (48 horários, 10 min entre eles, 20 por horário) e os da rotina (6 horários). |
| P6 | Limite de horários da grade | 48 por dia, com pelo menos 10 min entre eles. O "Repetir" segue com 6 (`MAX_HORARIOS`), e o Grupo vivo usa os mesmos 6 por rotina. |
| P7 | Grade diferente por dia da semana | Não. Uma grade, com os dias marcados. Grade por dia, se fizer falta, fica para a entrega 2. |
| P8 | "Variação do horário" (sair alguns minutos antes ou depois) | Fora da 1ª versão. As pausas de Ajustes já variam. O campo some da spec. |
| P9 | Foto nas rotinas do Grupo vivo | Fora da 1ª versão: o upload é apagado 7 dias depois de ficar sem envio ativo. |
| P10 | Recorrência do Grupo vivo | Semanal por dia da semana, de 1 a 6 horários (a do Repetir). Mensal ou "a cada N dias" fica fora. |
| P11 | Enquete recorrente | Sim (já existe no Repetir). No Grupo vivo, com rodízio de até 5 enquetes. |
| P12 | Rodízio dos textos | Até 5 por rotina, "um depois do outro" (padrão) ou "sorteio" sem repetir o último. |
| P13 | Onde fica o Grupo vivo | Seção própria no menu Disparos, depois de "Disparar mensagem" (recomendação da spec). Disparar mensagem fica igual, fora o `.sub` com o link. |
| P14 | "Enviar agora" numa regra com grade | Manda a quantidade e o template do próximo horário e não pula esse horário. |
| P15 | Operador | Mesmos direitos de hoje no Disparo automático: edita a grade e as rotinas. |
| P16 | Prova social com número real ({MEMBROS}, "ofertas de ontem") | Fora. Os modelos convidam a participar, sem números. |
| P17 | Template apagado que está em uso numa grade | Bloqueia (como já acontece com o template da regra), e a mensagem cita a regra e o horário. |
| P18 | Rotinas no Histórico | Prefixo "Grupo vivo: <nome>" e aparecem em "Tudo". Sem filtro novo de tipo. |

## Alinhamento com a spec
- Decisão 1 (grade dentro da regra) e Decisão 2 (seção "Grupo vivo"): adotadas (D1, D6, P13).
- Janela no modo grade: não vale (P4). Os campos ficam escondidos, mas são enviados.
- Dias: entram (D1). A mesma grade vale para todos os dias marcados (P7).
- Máximo de horários: 48 (P6). O contador lê `S.st.grade.max_horarios`.
- Variação do horário: fora (P8). O select some, na grade e no Grupo vivo.
- "Enviar agora": não consome o horário (P14, D4).
- Teto anti-ban: um nível só, o aviso de 400/dia (P5). O "acima do máximo" que bloqueia não entra.
- Total do número: calculado no painel com `/api/rules` + `/api/rotinas`, que já trazem o necessário. Fórmula: ofertas/dia × grupos por regra ligada (intervalo: `per_run × ⌊janela/intervalo⌋`) + horários/dia × grupos por rotina ligada.
- "Horário que se encontra com outra regra" e "Programação de hoje": fora da 1ª versão. Não há rota nova para isso.
- Primeira vez em "horários marcados": converte o intervalo só se couber em 48 linhas com pelo menos 10 min. Se não couber, começa vazia com os modelos.
- Template excluído em uso: bloqueia (P17). O `confirm` proposto vira a mensagem de erro do servidor.
- Rodízio de até 5: entra (P12). Foto no Grupo vivo: fora (P9). Horários por rotina: 6 (P6).
- Histórico com o nome da rotina: entra (P18). Cartão: `enviadas_24h`, `erros_24h` e `ultimo_erro_grupo` vêm de `GET /api/rotinas`.
- Operador: mesmos direitos (P15).
- `public/disparos.js`: só a linha do `.sub`, na etapa 8.

## ADR-007: ritmo por horários marcados e rotinas de engajamento
- **Contexto:** o ritmo das regras era só intervalo + janela, e o engajamento recorrente vivia como linha solta da fila `envios`.
- **Decisão:**
  - grade em coluna JSON `rules.grade`, opcional (NULL = comportamento antigo), com o próximo horário calculado por `proximaOcorrencia`;
  - rotinas numa tabela de configuração `rotinas`, que no horário grava uma ocorrência "agora" em `envios`, no mesmo padrão do espelho e dos remetentes;
  - uma só regra de horário perdido (30 min, só o mais recente) para as duas.
- **Consequências:** a fila, o Disparar mensagem e as regras atuais não mudam. A janela não se aplica a regras com grade. Não há teto anti-ban no servidor, só os limites de forma e o aviso do painel.
- **Alternativas rejeitadas:** tabela de horários, regras-filhas, e estender `envios` repetido (ver "Abordagens consideradas").
