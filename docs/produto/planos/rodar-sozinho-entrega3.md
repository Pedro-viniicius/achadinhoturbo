# Plano técnico: Rodar sozinho · Entrega 3 (Vigia)
- Brief: docs/produto/briefs/rodar-sozinho.md (seção "Entrega 3", "Propostas minhas", "Fracasso", "Restrições")
- Spec: docs/produto/specs/rodar-sozinho-entrega3.md (mensagens, faixa, resumo; alinhamento no fim)
- Base: cópia `achadinho_turbo-wt-e1` (HEAD `def9a19`) **mais a entrega 2** (docs/produto/planos/rodar-sozinho-entrega2.md). Linha de base: `npm test` com 2.937 testes, 2.936 passam, 1 todo. A linha de base real é medida de novo depois que a entrega 2 entrar.
- Data: 2026-11-11

## Objetivo e critérios de aceite
Avisar o dono pelo WhatsApp, uma vez, quando algo para: loja parada, extensão ou Central fora, revisão acumulada, regra vazia. Avisar de novo quando volta. A linha de saúde vai no resumo diário, e a causa em aberto aparece na faixa. CA3.1 a CA3.6 valem como estão no brief. Este plano acrescenta:
- CA3.7 — Nenhuma linha do vigia no Histórico usa o nível `erro`. Nem a falha do próprio vigia: ele não pode disparar o aviso de erro.
- CA3.8 — A hierarquia vale: extensão ou Central fora cala "loja parada" do ML e "regra vazia" das regras só de ML; loja parada cala a regra vazia que só pede aquela loja. A calada vira linha `info` e não sai no WhatsApp.
- CA3.9 — Nada sai no silêncio do `ritmo.js` nem com o WhatsApp fora. No fim de um e de outro sai **uma** mensagem, montada com o que ainda está em aberto naquele momento.
- CA3.10 — Reiniciar o serviço não gera aviso novo nem repete aviso já dado. O estado e as execuções sobrevivem ao reinício.
- CA3.11 — Uma falha do vigia não derruba o tick: os envios, os avisos e as regras seguem. O painel mostra "Vigia sem leitura agora".
- CA3.12 — Uma causa que perde o objeto fecha sem "voltou" e grava uma linha. Exemplos: a regra foi desligada ou apagada; a loja saiu das regras ativas; o modo de link virou direto.

## Contexto atual
- **Avisos:** `createAvisos` cuida do resumo, do erro, do backup e da lotação (`src/avisos.js:511-523`).
  - Cada passo é isolado por `try` (`:519-521`). Falha na entrega vira `aviso`, nunca `erro` (`:226-233`).
  - Destinos do erro: `d.ativo && d.avisos.includes('erro')` (`:380`). O freio do erro guarda o instante em `settings` (`:383-384`).
  - O backup tem carência de 1 h e detecta suspensão (`:429-457`).
  - Nenhum dos avisos consulta o silêncio (`ritmo.silencio`, `src/ritmo.js:192-199`).
- **O WhatsApp dos avisos:** o `wa` passado a `createAvisos` já vem embrulhado pelo ritmo (`src/scheduler.js:185`, `:191`). Toda mensagem conta no teto e respeita a pausa mínima; o privado nunca é segurado (ADR-012).
- **Tick:** a ordem é envios → espelho → remetentes → avisos → rotinas → regras (`:1145-1201`), e cada passo está dentro de `passo()`, que só escreve no console (`:1099-1101`).
- **Contadores da entrega 1:** existem só na memória. `summary.porLoja` (`{saiu, pulada, descartada, revisao, esperou}` para ml, amazon e shopee, `:92-98`, `:703`), `faltas` com os motivos (`:759-766`) e `exec.filtradas` (`:445-448`) **não são gravados**. A entrega 3 precisa gravá-los (decisão 1).
- **Filtradas antes da escolha não aparecem em `porLoja`:** é o caso da Amazon sem conferência (`:575`) e do ML com a leitura pausada (entrega 2, etapa 9). Sem tratar isso, a "Amazon parada" pelo Etiqueta fora nunca seria vista.
- **Entrega 2:**
  - `links.status()` passa a ter `central.estado` e `emEsperaDesde` (etapa 1);
  - `lastPollAt` da extensão continua só na memória (`src/links.js:92`);
  - esperas `ml_espera`/`ml_extensao` e a categoria `mlPausa` (etapas 6 e 9);
  - faixa com duas pílulas e `haQuanto` (etapa 8).
- **Faixa:** reescreve o `innerHTML` a cada 3 s (`public/app.js:111-121`).
- **Âncora da revisão (spec, ponto h):** existe: `#historico?tipo=catalogo&status=revisao` (`public/app.js:332`).

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| A. **Tabela `execucoes`** (uma linha por execução de regra) + estado do vigia em `settings.vigia_estado` | As sequências ("3 execuções seguidas") e a linha de saúde do dia saem de uma consulta; nada se perde no reinício | Tabela nova (criação, sem destruir nada) | Crescer sem limite: retenção de 35 dias |
| B. Só contadores de sequência em `settings` | Sem tabela | A linha de saúde do dia precisaria de outro acumulador; o "motivo mais comum" fica difícil | Estado inconsistente entre dois JSON |
| C. Ler o `log` (texto do Histórico) | Nada novo | Frágil (texto muda), corta em 5.000 linhas, já foi empurrado pelas linhas "Pulada" | Alarme falso |

Vale a **A**.

## Decisão
1. **Registro por execução:** `runRule` grava uma linha em `execucoes` no `finally`, depois de decidir o próximo horário. O registro fica dentro de `try`: falha vai ao console só com o código e nunca derruba a regra.
   - **Conta** (`conta = 1`): a execução passou das checagens (WhatsApp pronto, regra completa) e teve escolhida ou espera.
   - **Não conta:** "sem ofertas novas", "regra incompleta", "WhatsApp desconectado" e a parada pelo silêncio ou pelo teto antes de qualquer saída. Essas não somam nem zeram nenhuma sequência.
   - **Contadores por loja:** `porLoja` mais as filtradas que são falta de loja (Amazon `semConferencia` e ML `mlPausa` entram em `esperou`).
   - **Motivos:** os de cada loja ficam em `motivos` (chave interna → n). A chave é a da `CAUSAS` quando há causa; senão, a de `PULADA_POR`/`DESCARTADA_POR`/`TEXTO_ESPERA`.
2. **Horário de envio, não relógio:** loja parada e regra vazia são avaliadas só sobre as execuções que contam.
   - **Loja parada:** nas 3 últimas execuções com atividade da loja, `saiu = 0` e `pulada + descartada + esperou > 0`. Execução sem atividade da loja é neutra. Revisão é neutra (é decisão do dono, não defeito).
   - **Regra vazia:** as 2 últimas execuções da regra com `saidas = 0` e alguma oferta caída fora.
   - **Extensão ou Central fora:** abre numa execução que conta, quando o ML esperou por `ml_extensao` ou `ml_espera` **e** a falta começou há 30 min ou mais. Se não há execução, não há aviso: sem envio afetado, nada a avisar.
     - O início é `emEsperaDesde` (Central, gravado na entrega 2) ou `max(lastPollAt, início do serviço)` (extensão). Isso já dá a carência depois do reinício sem regra a mais (D5).
   - **Revisão acumulada:** abre numa execução que conta com 10 ou mais pendentes; fecha com 5 ou menos (D4).
   - **Fechamento a cada tick, sem esperar execução:**
     - extensão de volta on-line e Central `respondendo`;
     - revisão com 5 ou menos;
     - loja ou regra fecham na execução que conta e tem `saiu > 0` (loja) ou `saidas > 0` (regra);
     - a causa sem objeto fecha sem "voltou", com linha `info` (CA3.12).
   - Lojas vigiadas: ml e amazon (a Shopee entra na entrega 4, como diz o brief). "Loja pedida" vem das lojas da fonte catálogo; lista vazia ou fonte antiga contam como Amazon e ML.
3. **Estado** em `settings.vigia_estado` (JSON, no padrão de `avisos_lotacao`/`ml_central`): causas abertas, último aviso por chave e cursor de `execucoes`. Na leitura, o valor fora do formato é descartado e o instante no futuro é cortado para agora. Gravado só quando muda.
4. **Envio:**
   - **Destinos:** os de "Erro de disparo" (D1). Cada passada manda **no máximo uma mensagem de problema e uma de "voltou"**, cada uma juntando as causas devidas (molde da spec, §1.8).
   - **Silêncio e WhatsApp fora:** não manda nada e não marca nada. A causa continua "devida" e sai quando os dois liberarem, reavaliada.
   - **Freio de 3 h:** vale para o aviso de problema, contado do último aviso da mesma chave, de problema ou de volta.
   - **"Voltou":** sai só se o problema foi avisado, e não passa pelo freio. Se a causa reabriu antes de o "voltou" sair, ele não sai (D9).
   - **Texto:** sem texto livre de terceiros. Os nomes passam por `semNumero` e são cortados em 40 caracteres, sem `*`.
5. **Hierarquia:** antes de abrir, a derivada confere a causa-raiz aberta (ou o estado da hora: extensão off-line, ML em espera). Calada não abre: só grava uma linha `info`. Ela é reavaliada na próxima execução que conta.
6. **Onde roda:** `passo('vigia', …)` no tick, logo depois dos avisos, e de novo depois de cada regra (junto do `passoEnvios`). A falha marca `ok = false`, grava **uma** linha `aviso` por sequência de falhas e segue (CA3.11).
7. **Linha de saúde:** `montarResumo` acrescenta o bloco no fim, com a soma de `execucoes` do dia de negócio (todas as regras) e a contagem da revisão. "Falhas" = soma de `erros` das execuções do dia.
8. **`/api/state`** ganha `vigia: { ok, causas: [{ tipo, chave, loja?, rule_id?, regra?, n?, desdeEm, calada: false }], avaliadoEm }` (nomes da spec, mais `chave` e `rule_id`).

## Esquema e contratos
- **Migração (criação, sem destruir nada):**
  ```sql
  CREATE TABLE IF NOT EXISTS execucoes (
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, rule_id INTEGER, conta INTEGER NOT NULL CHECK (conta IN (0,1)),
    want INTEGER NOT NULL DEFAULT 0, saidas INTEGER NOT NULL DEFAULT 0, erros INTEGER NOT NULL DEFAULT 0,
    lojas_pedidas TEXT NOT NULL DEFAULT '[]', por_loja TEXT NOT NULL DEFAULT '{}');
  CREATE INDEX IF NOT EXISTS execucoes_ts ON execucoes(ts);
  CREATE INDEX IF NOT EXISTS execucoes_regra ON execucoes(rule_id, id);
  ```
  - `por_loja` = `{ ml|amazon|shopee: { saiu, pulada, descartada, revisao, esperou, motivos: { chave: n } } }`.
  - Retenção: a cada gravação, `DELETE FROM execucoes WHERE ts < agora − 35 dias`.
  - Sem dado pessoal: só o id da regra e números.
- **`src/vigia.js` (novo):**
  - Constantes: `EXECUCOES_LOJA_PARADA = 3`, `EXECUCOES_REGRA_VAZIA = 2`, `FORA_MIN = 30`, `REVISAO_ABRE = 10`, `REVISAO_FECHA = 5`, `FREIO_VIGIA_H = 3`, `MAX_NOME_VIGIA = 40`.
  - Puras, sem rede nem relógio próprio:
    - `avaliar({ execucoes, estado, revisao: { n, maisAntigaEm }, extensao: { online, desde }, central: { estado, emEsperaDesde }, regrasAtivas, modoLink, agora })` devolve `{ estado, linhas: [{ level: 'aviso'|'info', message }], devidos: { problemas: [causa], voltas: [causa] } }`;
    - `mensagemProblemas(causas, { motivo: 'silencio'|'whatsapp'|null, agora })`, `mensagemVoltas(causas, agora)`, `linhaDeSaude({ execucoes, revisao, abertas, temRegraAtiva })`;
    - `MOTIVO_VIGIA`: mapa da chave interna para o motivo e a ação da spec, §1.6.
  - `createVigia({ db, links, ritmo, wa, entregar, inicio = Date.now(), agora = Date.now })` devolve `{ tick(), estado(), aposExecucao() }`.
  - `entregar(texto, oQue)`, injetado de `createAvisos`, devolve o número de entregas e nunca lança.
- **`src/avisos.js`:**
  - `createAvisos` ganha `entregarAosDeErro(texto, oQue)`, com o mesmo filtro de `:380`, `entregar` por destino e a linha do Histórico só com o nome.
  - `montarResumo(blocos, now)` acrescenta `linhaDeSaude(...)`, uma vez no fim.
  - Recebe `abertas: () => causas` por opção (sem importar o vigia; nada de dependência circular).
- **`src/scheduler.js`:** grava em `execucoes` no `finally` de `runRule`; cria `createVigia`; acrescenta `passo('vigia')`; devolve `vigia`.
- **`src/server.js`:** `/api/state` ganha `vigia: scheduler.vigia?.estado() ?? null`.
- **Divergências da spec:**
  - (a) o "voltou" não passa pelo freio e fica devido durante o silêncio (D9);
  - (b) a carência não é regra separada, porque o início da falta nunca vem antes do início do serviço (D5);
  - (c) "loja parada" não conta a revisão como queda;
  - (d) "Falhas" na saúde = `erros` das execuções de regra; a fila de envios fica fora, coerente com o rótulo "(todas as regras)".

## Etapas
Ordem TDD. Todas dependem da entrega 2 já mergeada na mesma worktree. A coluna "Dep. E2" diz de quais etapas dela.

| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs | Dep. E2 |
|---|---|---|---|---|---|---|---|---|
| 1 | Tabela `execucoes` com índices (criação, idempotente) | `src/db.js`, `test/base.test.js` | `node --disable-warning=ExperimentalWarning --test test/base.test.js` | dev | 1 | sim (migração) | 3.10 | 5 (mesmo `db.js`: entrar depois) |
| 2 | `src/vigia.js` puro: `avaliar` (4 causas, hierarquia, fechamento, objeto perdido, freio, devidos), mensagens e saúde, sempre com dados simulados | `src/vigia.js`, `test/vigia.test.js` (novo) | idem com `test/vigia.test.js` | dev | 1 | sim (texto que sai para fora) | 3.1, 3.2, 3.5, 3.7, 3.8, 3.12 | 1 (formato de `central`) |
| 3 | `createVigia`: estado em `settings`, silêncio e WhatsApp fora, uma mensagem por passada, linhas do Histórico, `ok=false` sem `erro`, `estado()` | `src/vigia.js`, `test/vigia-servico.test.js` (novo) | idem com os dois arquivos de teste do vigia | dev | 2 | sim (WhatsApp, ritmo, laço de avisos) | 3.2, 3.5, 3.7, 3.9–3.11 | 1 |
| 4 | `entregarAosDeErro` e linha de saúde no `montarResumo` | `src/avisos.js`, `test/avisos.test.js` | idem com `test/avisos.test.js` | dev | 2 | sim (envio ao WhatsApp) | 3.3, 3.5 | — |
| 5 | Agendador: grava `execucoes` (`conta`, `por_loja` com as filtradas, motivos), cria o vigia, `passo('vigia')` no tick e depois de cada regra; `/api/state` | `src/scheduler.js`, `src/server.js`, `test/vigia-agendador.test.js` (novo) | `npm test` | dev | 3 | sim (agendador, tick) | 3.1, 3.10, 3.11, 3.4 | 6 e 9 (`porLoja`, `ml_espera`, `mlPausa`) |
| 6 | Faixa: pílulas do vigia (no máximo 2, "+N", prioridade, "Vigia sem leitura agora"), só repinta com HTML novo; Relatórios e avisos: textos e linha informativa | `public/app.js`, `public/relatorios.js`, `public/style.css` | `npm test` e conferência a 375 e 1280 px com `PORT=3799 DATA_DIR=<tmp> DRY_RUN=1` e `vigia_estado` semeado na pasta temporária | designer | 3 | não | 3.4 | 8 (faixa de duas pílulas, `haQuanto`) |
| 7 | Docs, `TIPS`/`LEIA_MAIS`, README conforme a spec, §7 | `public/ajuda.js`, `public/docs/cap-grupos.js`, `cap-referencia.js`, `cap-comecar.js`, `cap-disparos.js`, `cap-amazon-revisao.js`, `README.md` | `npm test` | designer | 4 | não | 3.6 | 10 |
| 8 | `FATOS`: 3 execuções, 2 execuções, 30 min, 10 e 5, 3 h, com regex específica (spec, ponto i); teste de `relatorios.avisos` (linha ~1280) | `test/docs.test.js` | idem com `test/docs.test.js` e depois `npm test` | dev | 4 | não | 3.6 | 11 |

Ordem dos grupos:
- **Grupo 1:** etapas 1 e 2, sem arquivo em comum.
- **Grupo 2:** etapas 3 e 4. A 3 vem depois da 2 (mesmo arquivo do vigia) e a 4 roda junto com ela.
- **Grupo 3:** etapas 5 e 6. A 5 depende de 1 a 4. A 6, do designer, depende só do contrato de `/api/state` acima.
- **Grupo 4:** etapas 7 e 8, que rodam juntas.

Nunca o `designer` e o `dev` ao mesmo tempo em `public/app.js` ou em `test/docs.test.js`.

**Testes por CA** (nome → arquivo):
- **CA3.1:** cada causa com execuções simuladas → `vigia`.
  - 'loja parada: 3 execuções com queda e sem saída abrem; execução sem atividade não conta; revisão não conta';
  - 'Amazon só filtrada (sem conferência) conta como parada';
  - 'regra vazia: 2 seguidas'; 'extensão e Central: só com execução e falta ≥ 30 min'; 'revisão: abre com 10';
  - 'sem execução (fora do horário) nada abre, mesmo com a extensão off-line há horas'.
- **CA3.2:** 'freio de 3 h segura o reabrir'; 'voltou sai uma vez, só se o problema foi avisado'; 'revisão fecha com 5, não com 9' → `vigia`.
- **CA3.3:** 'resumo traz a saúde com os números do dia; dia sem execução; dia sem nada a relatar' → `avisos`.
- **CA3.4:** 'state traz vigia.causas com desdeEm' → `vigia-agendador`; a faixa → etapa 6 (prova visual).
- **CA3.5:**
  - 'nenhuma mensagem do vigia tem @s.whatsapp.net, sequência de 8 ou mais dígitos, e-mail nem o texto do último erro' → `vigia`;
  - 'mensagem passa pelo wa embrulhado e conta em wa_saidas' → `vigia-servico`;
  - 'a linha do Histórico tem o nome do destino, nunca o número' → `avisos`.
- **CA3.7:** 'nenhuma linha do vigia é erro, nem a falha do próprio vigia' → `vigia-servico`.
- **CA3.8:** 'Central em espera cala loja ML e regra só-ML; loja parada cala a regra vazia só dela; a raiz fecha e a derivada abre na execução seguinte' → `vigia`.
- **CA3.9:**
  - 'causas abertas no silêncio saem numa só mensagem ao fim dele, só as que seguem abertas';
  - 'WhatsApp fora segura e manda ao voltar';
  - 'sem silêncio ligado, nada segura' → `vigia-servico`.
- **CA3.10:** 'reinício: novo createVigia com o mesmo db não repete aviso nem abre causa'; 'extensão off-line logo depois do reinício não abre (desde ≥ início)' → `vigia-servico`.
- **CA3.11:** 'vigia que lança: o tick roda as regras e os envios; ok=false; uma linha aviso por sequência de falhas' → `vigia-agendador`.
- **CA3.12:** 'regra apagada ou desligada fecha a regra vazia sem voltou; modo direto fecha extensão/Central' → `vigia`.
- **CA3.6:** `FATOS` → `docs.test.js`.

**Ordem de entrada no serviço:** depois da entrega 2 (que exige recarregar a extensão), fora dos horários das regras, com o ok do dono:
1. `npm test` verde;
2. `npm run backup` (a tabela é nova, mas o backup antes de mexer em `db.js` é a regra);
3. merge de `src/`;
4. no primeiro dia, conferir as linhas "Vigia:" no Histórico e a linha de saúde do resumo.

Não há passo da extensão.

## Pontos para o seguranca
- **Saída para fora:**
  - só destinos de "Erro de disparo";
  - texto só de frases fixas, números e nomes passados por `semNumero` e cortados;
  - o "Último erro" da entrega 2 (texto livre) **nunca** entra na mensagem;
  - teste com o padrão de telefone e e-mail.
- **Laço:** o vigia nunca grava `erro`, e o `avisoDeErro` não lê linhas do vigia. Falha de entrega vira `aviso` (`entregar` de hoje).
- **Ritmo:** mensagem pelo `wa` embrulhado: conta no teto e respeita a pausa. O silêncio é checado pelo vigia, não pelo porteiro, porque o privado não é segurado (ADR-012).
- **Estado em `settings`:** só chaves de causa, instantes e ids de regra. Nada de número nem de nome de destino.
- **Migração:** só `CREATE … IF NOT EXISTS`; a retenção apaga só linhas da tabela nova.

## Foco de revisão (casos de encaixe)
1. **Alarme falso depois do reinício:** a extensão começa off-line (`lastPollAt = 0`). O início da falta é `max(lastPollAt, início)` e só abre em execução. O estado e o cursor estão em `settings` e não reavaliam o passado. Testes do CA3.10.
2. **Aviso em laço:** o vigia não gera `erro`; a mensagem do vigia que falha vira `aviso` e não dispara outra; cada passada manda no máximo 2 mensagens. Teste 'falha de entrega não gera erro nem nova tentativa na mesma passada'.
3. **Aviso que nunca fecha:**
   - a extensão nunca volta (fecha quando o modo vira direto ou nenhuma regra ativa pede ML);
   - a regra foi apagada;
   - a revisão parada em 7 (abre com 10, fecha com 5): fica aberta de propósito e o freio impede lembrete.
   
   Teste 'causa sem objeto fecha'.
4. **Aviso no silêncio:** o vigia confere o silêncio antes de cada envio. A regra não roda no silêncio, então quase nada abre ali. Teste 'abre às 22:59 e silêncio às 23:00: sai às 07:00, reavaliado'.
5. **Vigia quebrado:** `passo()` engole e escreve no console; `estado()` nunca lança (devolve `{ ok:false, causas:[] }`). O registro em `execucoes` fica em `try` próprio dentro do `finally` do `runRule`. Testes do CA3.11.
6. **Execução lenta ou repetida no mesmo horário:** o "Enviar agora" conta como execução. Duas seguidas sem saída podem abrir "regra vazia". É aceitável (são duas tentativas reais), mas está em D10.

## Riscos e como reverter
- **Avisos demais:** subir os limites nas constantes de `src/vigia.js` (uma linha cada) ou desmarcar "Erro de disparo" no número. Reverter: `git revert` das etapas 3 a 5. A tabela fica sem uso; não precisa apagar.
- **Tabela cresce:** retenção de 35 dias; cerca de 50 linhas por dia.
- **Resumo muda de tamanho:** o bloco tem no máximo 5 linhas.
- **Leitor externo** (`relatorio-achadinhos`): não lê `execucoes` nem `settings` do vigia (não verificado: conferir se ele lista as tabelas).

## Decisões do dono
**Aprovado pelo dono em 11/11/2026: todas as recomendações abaixo valem** (D1 reaproveitar "Erro de disparo"; D2 respeita o silêncio; D3 sem lembrete; D4 fecha com 5; D5 sem carência separada; D6 conta a Shopee; D7 linha geral; D8 duas pílulas; D9 o "voltou" sai ao fim do silêncio; D10 "Enviar agora" conta; D11 só revisão não conta).

As 8 perguntas da spec, mais as minhas (D9 a D11):
- **D1, "Erro de disparo" recebe o vigia ou caixa nova "Vigia"?** Recomendo reaproveitar. Caixa nova: coluna em `aviso_destinos` (migração), a rota e o painel de Relatórios; mais 1 etapa sensível.
- **D2, o vigia respeita o silêncio?** Recomendo sim (brief, CA3.9). Não: some a checagem e o CA3.9 sai.
- **D3, lembrete enquanto a causa dura?** Recomendo não. Lembrete de 12 h: uma regra no `avaliar` e um número a mais em `FATOS`.
- **D4, revisão fecha com 5 ou menos?** Recomendo 5 (histerese). Com menos de 10, sai `REVISAO_FECHA` e o abre e fecha fica por conta do freio.
- **D5, carência de 1 h depois de ligar?** Recomendo não ter uma regra separada: medir a falta a partir do início do serviço já evita o alarme falso. Com a carência: um `if` a mais e o número 1 h nos Docs.
- **D6, a revisão conta a Shopee?** Recomendo contar tudo. Sem a Shopee: um filtro `loja != 'shopee'` na contagem até a entrega 4.
- **D7, linha de saúde geral ou por bloco?** Recomendo geral, com o rótulo "(todas as regras)". Por bloco exigiria gravar os grupos em `execucoes`.
- **D8, faixa com duas pílulas ou uma (pergunta 7 da entrega 2)?** Não muda o vigia, só onde fica o tempo da extensão e da Central (etapa 6).
- **D9 (minha), o "voltou" que fica devido no silêncio sai ao fim dele?** Recomendo sim, se a causa continua fechada (a spec, §1.8, diz que não acumula). Não: a causa fechada no silêncio perde o "voltou" e o dono fica com o problema avisado e sem desfecho.
- **D10 (minha), o "Enviar agora" conta como execução para a regra vazia?** Recomendo sim. Não: `conta = 0` no manual.
- **D11 (minha), loja parada só com revisão: conta?** Recomendo não (revisão é decisão do dono, e a revisão acumulada já avisa).

**Decisões da entrega 2 que mudam esta:**
- **D7 da E2 (pílula única):** muda a etapa 6.
- **D6 da E2 (recusa não mapeada):** muda só o motivo mapeado ("outro").
- **D8 da E2 (orçamento):** acrescenta o motivo `orcamento` ao `MOTIVO_VIGIA` ("outro motivo").
- **D2 da E2:** não muda nada aqui.

Se a etapa 9 da E2 (`mlPausa`) for cortada, a "loja parada" do ML pela leitura pausada só aparece por `esperou` da espera, e o ML com a leitura em pausa não abre causa.

## Alinhamento com a spec
- (a) Confirmado: nenhuma linha `erro` (CA3.7).
- (b) Confirmado: só o vigia obedece ao silêncio; o erro e o resumo seguem como hoje.
- (c) Confirmado: `/api/state.vigia`, com `chave` e `rule_id` a mais.
- (d) Confirmado (CA3.8).
- (e) Confirmado: uma mensagem de problemas por passada, reavaliada. O "voltou" vai em mensagem separada (D9).
- (f) Substituída pela medida desde o início do serviço (D5).
- (g) Confirmado: 10 e 5 (D4).
- (h) A âncora existe: `#historico?tipo=catalogo&status=revisao`.
- (i) Confirmado na etapa 8.
- A frase "Vigia sem leitura agora" sai uma vez por sequência de falhas, não a cada tick.
- O texto do resumo para o dia sem execução usa `temRegraAtiva` (há regra ativa e nenhuma rodou: mostra os zeros).
