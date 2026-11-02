# Plano técnico: disparo manual, disparar mensagem, relatórios e avisos, conexões, equipe e nova navegação
- Brief: docs/produto/briefs/disparos-comunicacao-conta.md
- Spec de UI (em paralelo): docs/produto/specs/disparos-comunicacao-conta.md
- Data: 2026-11-02

## Objetivo e critérios de aceite
Seis features num painel que hoje só dispara por regra e tem senha única: F1 disparo manual de oferta, F2 mensagem/enquete agendável e repetível, F3 resumo diário e avisos por WhatsApp, F4 cartões de conexão por loja, F5 usuários com convite e papéis, F6 menu em grupos.
CA1 a CA10: copiados do brief, sem mudança.
CA1 — Disparo manual com link do ML, grupo e template envia imagem + `meli.la` da etiqueta escolhida; a linha aparece no histórico como enviada.
CA2 — Link de loja não conectada é identificado pelo nome e recusado com mensagem clara, sem enviar nada.
CA3 — Disparo manual agendado para hoje fica pendente e sai no horário, mesmo se o serviço reiniciar antes.
CA4 — Mensagem (com e sem imagem) e enquete funcionam agora, agendadas e repetidas. As agendadas e repetidas aparecem na lista e podem ser canceladas. O histórico mostra enviados, na fila e com erro.
CA5 — Um número cadastrado recebe "Enviar resumo agora" com os blocos marcados. O resumo diário sai no horário. A virada do dia e o limite padrão são respeitados no analytics e no rotacionador.
CA6 — Conexões mostra o ML conectado (etiqueta + extensão). Amazon, Shopee, Magalu e Facebook aparecem com "ainda não implementado", campos salváveis e segredo que não volta ao navegador.
CA7 — O dono atual entra com usuário e senha e cria convite com papel. O link abre um cadastro (nome + senha) e a pessoa passa a entrar. O Operador não vê nem alcança Equipe. O Dono remove pessoas e muda papel. O convite vence em 7 dias e pode ser cancelado.
CA8 — Menu em grupos, ajuda (`public/ajuda.js`) e README atualizados, páginas antigas alcançáveis.
CA9 — `npm test` passa e há testes de servidor para F1, F2, F3 e F5.
CA10 — Nenhum dado pessoal novo em log. Números de aviso e e-mails ficam só em `data/`. O `seguranca` revisa F5, F3 e F4.

## Contexto atual
- Esquema: `SCHEMA` + `EXTRA_COLUMNS` (ALTER só se faltar) em `src/db.js:6-61`. `addLog` corta em 5000 linhas (`src/db.js:130-135`).
- Login: senha única. O hash fica em `settings.panel_password_hash` (`src/auth.js:149`) e é semeado por `PANEL_PASSWORD` (`src/auth.js:207-210`). A sessão guarda sha256 do sid, sem usuário (`src/auth.js:213-231`, tabela `sessions` em `src/db.js:31`). O `npm run senha` chama `setPassword` e apaga todas as sessões (`src/auth.js:173-177`, `scripts/senha.js:25`).
- Freios de login em `src/server.js:123-142`: por IP, global com exceção de IP que acertou, teto de 2 scrypt e contagem antes do hash. Cobertos por S12 (`test/seguranca.test.js:216-239`). Todos os testes entram só com `{ senha }` (`test/servidor.test.js:45`, `test/seguranca.test.js:131`, `test/analise.test.js:151`).
- Rotas: todas em `buildApp` (`src/server.js:24-439`). Rotas sem login ficam em `PUBLIC_PATHS` (`:20`). O JSON é limitado a 100 kB, e a extensão tem 5 MB só depois do token (`:28-30`, `:87`). `/api/state` é lido a cada 3 s pelo painel (`:162-177`, `public/app.js:416`). A retenção roda a cada 6 h (`:451-452`) e `verificarLotacao` a cada 60 s (`:467`).
- Agendador: um `setInterval` de 15 s (`src/scheduler.js:154`). O `tick` não reentra e roda as regras em sequência com `await runRule` (`:135-150`). `runRule` envia por grupo, cai para texto se a foto falhar e grava `log` (`:65-124`, envio em `:101-113`). `next_run_at` é persistido (`:121`). O disparo manual de regra é fire-and-forget (`src/server.js:418`).
- WhatsApp: `sendText`/`sendImage` (com URL) em `src/whatsapp.js:305-315`. O modo simulado empurra para `simulated`.
- Baileys rc14: enquete é `{ poll: { name, values, selectableCount } }` (`node_modules/@whiskeysockets/baileys/lib/Types/Message.d.ts:92`). Com `linkPreview` indefinido ele tenta `link-preview-js` (`lib/Utils/messages.js:278-280`), que NÃO está instalado. `sharp@0.35.5` veio como peer e `extractImageThumb` é exportado (`lib/Utils/messages-media.js:97`).
- Ofertas: `resolveOffer` só fala com hosts ML (`src/ml.js:98-136`, `hostPermitido` em `:30-32`, imagem só `mlstatic`). `requestLink` usa a extensão, ou fake/direct (`src/links.js:248-254`). `renderTemplate` está em `src/template.js:339`.
- Análise: `startOfDay`/`periodRange`/`resumo`/`evasaoDoDia` usam meia-noite fixa (`src/analytics.js:10-36`, `:116-136`). O limite de membros tem padrão 1000 no servidor e no painel (`src/server.js:263`, `public/paineis.js:186`). `LIMITE_MAX` = 1024 e `LOTACAO_PCT` = 95 (`src/rotador.js:146`, `:197`).
- Painel: o menu é plano (`public/index.html:19-30`). O roteador por hash é `ROTAS`/`ir()` (`public/app.js:394-400`). `paginaWhatsapp` junta conexão e tabela de grupos (`public/app.js:321-346`, `public/paineis.js:235`). O seletor de grupos reutilizável é `filtroGrupos` (`public/app.js:123`). A CSP é `script-src 'self'; img-src 'self' data:` (`src/server.js:22`): sem `blob:` e sem imagem externa.
- `docs/produto/decisoes.md` não existe. Não há decisão registrada em conflito.

## Abordagens consideradas
| Abordagem | Prós | Contras | Risco |
|---|---|---|---|
| **Agendador:** o `tick` atual roda `envios` e `avisos` antes das regras (escolhida) | Um laço só, reaproveita o freio `ticking` e o ritmo anti-bloqueio | Um agendado espera a regra em andamento terminar (minutos) | Baixo |
| Agendador: segundo `setInterval` só para envios | Horário mais exato | Duas filas mandando ao mesmo tempo dobram a taxa de mensagens | Bloqueio do número |
| **Upload:** `POST /api/uploads` com corpo binário via `express.raw` só nessa rota e depois do login (escolhida) | Sem dependência e sem base64 (+33%). Segue o padrão do `jsonGrande` | Um arquivo por chamada | Baixo |
| Upload: base64 dentro do JSON | Uma chamada só | Corpo de ~7 MB no parser JSON | Médio |
| Upload: multipart com `multer` | Padrão de mercado | Dependência nova sem ganho | Baixo |
| **Convite:** token só como hash; "Copiar link" gera link novo (escolhida) | Igual às sessões: vazamento do banco não dá convite válido | A spec previa copiar o mesmo link depois | Baixo |
| Convite: token em claro (como a referência) | Copia o mesmo link a qualquer hora | Backup vira convite válido por 7 dias | Médio |

## Decisão
1. **Envios numa tabela só** (`envios`), com tipo `oferta`/`mensagem`/`enquete` e quando `agora`/`agendado`/`repetir`. O resultado por grupo fica em `envio_resultados`, e cada envio também grava `log` (origem "Disparo manual", "Mensagem" ou "Enquete"), de modo que o Histórico geral e os avisos de erro enxergam tudo.
2. **Agendador único.** `createScheduler` cria `envios` e `avisos`. O `tick` faz, nesta ordem: `envios.processarPendentes()`, `avisos.tick()`, as regras como hoje e `envios.processarPendentes()` de novo depois de cada `runRule`. `start()` chama `envios.recuperar()` (`enviando` → `pendente`). `next_run_at` persistido garante o CA3.
   - **Sem envio duplicado.** A trava é atômica: `UPDATE … SET status='enviando' WHERE id=? AND status='pendente'`, com `changes === 1`. Na retomada, pula o grupo que já tem `ok` na mesma `ocorrencia` (= `next_run_at` da rodada).
   - **Horário perdido.** O agendado único com mais de 2 h de atraso (WhatsApp fora) vira `erro`. O repetido pula para a próxima ocorrência.
   - **"Agora".** Chama `runEnvio` direto, fire-and-forget, como `/rules/:id/run`. Com o WhatsApp desconectado, recusa sem criar nada. Uma oferta com a extensão offline (modo `extension`) também é recusada.
3. **Ponto único de loja: `src/lojas.js`.**
   - Registro de plataformas (hosts, campos, implementada).
   - `identificar(url)` lê só o hostname, sem rede.
   - `lerProduto`/`linkAfiliado`/`previaDoLink`: só o ML funciona (`resolveOffer`, `requestLink`). As outras lançam `LojaNaoConectada`, com o nome da loja na mensagem (CA2).
   - O F1 renderiza com `renderTemplate(tpl.body, { ...offer, link })`, como `runRule`.
4. **Mídia e enquete no Baileys** (`src/whatsapp.js`).
   - `sendImage` aceita Buffer além de URL.
   - `sendPoll` monta `{ poll }`: 2 a 12 opções, `selectableCount` 1 ou 0 (múltipla).
   - `sendText(…, { previa })` passa `linkPreview`.
   - `resolverNumero` usa `sock.onWhatsApp` para achar o JID canônico (o 9º dígito no Brasil).
   - Upload: só JPG e PNG, conferidos pelos bytes iniciais, até 5 MB. Vai para `data/uploads/<32hex>.<ext>` (nome aleatório, validado por regex). Fica fora da retenção normal: é apagado 7 dias depois de não ter mais envio ativo que o use.
   - "Prévia do link" só para link do ML nesta entrega: `previaDoLink` usa `resolveOffer` + miniatura `mlstatic` via `extractImageThumb`, sem `link-preview-js` (ver perguntas).
5. **Avisos** (`src/avisos.js`), no mesmo `tick`.
   - **Resumo diário:** sai uma vez por "dia de negócio" (setting `resumo_ultimo_dia`). Se o serviço estava parado no horário, sai atrasado, desde que dentro do mesmo dia de negócio.
   - **Erro de disparo:** um cursor em `log` (`avisos_log_cursor`) lê os `level='erro'` novos e manda um resumo agregado, no máximo 1 a cada 30 min. Só manda com o WhatsApp de pé, então a queda do WhatsApp chega como "N disparos falharam enquanto o WhatsApp estava desconectado" quando ele volta. Não há tipo separado.
   - **Grupo lotando:** usa grupos de links ativos ≥ `LOTACAO_PCT` do limite. Avisa uma vez por grupo até ele cair (setting `avisos_lotacao`) e cita a proposta de `verificarLotacao` se houver.
   - Falha ao entregar aviso vai para o `log` como `aviso`, nunca `erro`, para não criar laço. O log usa o nome do destinatário, nunca o número.
   - Virada do dia: novo parâmetro `viradaMin` (padrão 0, hoje igual) em `startOfDay`/`dayOf`/`periodRange`/`overview`/`evasaoDoDia`. O servidor lê `virada_dia` e repassa.
   - Limite padrão: `limite_padrao` substitui o 1000 fixo em `linkFromBody` e no `formLink`.
6. **Equipe** (centro em `src/auth.js`).
   - Tabelas `users` e `invites`. `sessions.user_id` entra por `EXTRA_COLUMNS`.
   - **Migração no `createAuth`.** Roda só se não há usuário e existe `panel_password_hash`: cria o Dono (`nome 'Dono'`, `email NULL`, mesmo hash) e liga as sessões abertas a ele numa transação. A chave antiga fica intacta para rollback e é apagada quando o Dono troca a senha.
   - **Login.** `POST /api/login { email, senha }`. Sem e-mail, entra só a conta com `email NULL` (o Dono migrado), então os testes e o dono atual seguem entrando como hoje. `GET /api/login/modo` (público) → `{ legado }` diz ao `login.js` se mostra o campo e-mail.
   - **Primeiro acesso.** `/api/state.usuario.precisa_completar` abre "Complete seu cadastro" (nome + e-mail, `PUT /api/me`). Com o e-mail gravado, o modo sem e-mail morre.
   - **E-mail desconhecido.** Calcula scrypt sobre um hash fictício (tempo igual) e devolve "E-mail ou senha incorretos.". Os freios e a ordem de `server.js:123-142` ficam como estão (S12 intocado).
   - **Convite.**
     - Token `randomBytes(32)`, guardado como sha256, 7 dias, uso único. O link é `/convite.html#<token>`: o fragmento não vai em requisição, log de proxy nem Referer.
     - A aceitação é pública (`/api/convite/info` e `/api/convite/aceitar`) e passa pelo limiter próprio. O scrypt roda antes, e a conferência + gravação ficam num bloco síncrono único (sem uso duplo).
   - **Autorização.** `soDono` em todo `/api/equipe/*`. O último Dono não sai nem perde o papel. Remover pessoa apaga as sessões dela. `sessionFrom` relê o papel a cada requisição.
   - **Painel sem senha (local).** Equipe responde "defina uma senha primeiro (npm run senha)".
7. **Navegação** (segue a spec).
   - Hashes `#disparo-manual`, `#disparo-automatico`, `#disparar-mensagem`, `#relatorios`, `#conexoes`, `#numeros`, `#grupos`, `#equipe`.
   - Os aliases `#regras`, `#whatsapp` e `#etiquetas` continuam valendo (CA8).
   - Histórico, Ajustes e Ajuda vão para o rodapé do menu.
   - Etiquetas e o bloco "Conectar a extensão" vão para Conexões → Mercado Livre. "WhatsApp e grupos" se divide em Grupos (tabela/convites) e Números de WhatsApp (QR/desconectar).
8. **Rotas por módulo para paralelizar.** Cada módulo novo exporta `montarRotas(app, ctx)`, montado em `buildApp` depois do middleware de sessão. `ctx = { db, wa, links, scheduler, auth, wrap, soDono, dataDir, ml, enderecoPublico }`. As páginas também vão para arquivos próprios em `public/`: `disparos.js`, `relatorios.js`, `conexoes.js` e `equipe.js`, no lugar de `conta.js`, para dois `dev` não editarem o mesmo arquivo.

## Esquema e contratos
```sql
CREATE TABLE IF NOT EXISTS envios (id INTEGER PRIMARY KEY, tipo TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  group_jids TEXT NOT NULL DEFAULT '[]', quando TEXT NOT NULL DEFAULT 'agora', repetir TEXT,
  status TEXT NOT NULL DEFAULT 'pendente',  -- pendente|enviando|concluido|erro|pausado|cancelado
  next_run_at INTEGER, last_run_at INTEGER, resultado TEXT, user_id INTEGER, created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_envios_fila ON envios (status, next_run_at);
CREATE TABLE IF NOT EXISTS envio_resultados (id INTEGER PRIMARY KEY, envio_id INTEGER NOT NULL, ocorrencia INTEGER NOT NULL,
  ts INTEGER, jid TEXT, group_name TEXT, ok INTEGER NOT NULL, erro TEXT);
CREATE INDEX IF NOT EXISTS idx_envio_res ON envio_resultados (envio_id, ocorrencia);
CREATE TABLE IF NOT EXISTS aviso_destinos (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, jid TEXT NOT NULL UNIQUE, -- telefone: dado pessoal
  resumo_blocos TEXT, avisos TEXT NOT NULL DEFAULT '[]', ativo INTEGER NOT NULL DEFAULT 1, created_at INTEGER);
  -- resumo_blocos: NULL = não recebe resumo; '[]' = todos os grupos; '[ids]' = esses blocos. avisos: ['lotacao','erro']
CREATE TABLE IF NOT EXISTS conexoes (plataforma TEXT PRIMARY KEY, config TEXT NOT NULL DEFAULT '{}',
  segredos TEXT NOT NULL DEFAULT '{}', updated_at INTEGER);  -- segredos nunca saem em SELECT de listagem
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, email TEXT COLLATE NOCASE UNIQUE,
  senha_hash TEXT NOT NULL, papel TEXT NOT NULL CHECK (papel IN ('dono','operador')), created_at INTEGER, last_login_at INTEGER);
CREATE TABLE IF NOT EXISTS invites (id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL COLLATE NOCASE,
  papel TEXT NOT NULL CHECK (papel IN ('dono','operador')), expires_at INTEGER NOT NULL, created_by INTEGER,
  created_at INTEGER, used_at INTEGER, canceled_at INTEGER);
-- EXTRA_COLUMNS: ['sessions', 'user_id', 'INTEGER']
-- settings novas: resumo_horario '21:00', virada_dia '00:00', limite_padrao 1000, resumo_ultimo_dia, avisos_log_cursor, avisos_lotacao, conta_nome
```

**`payload` por tipo:**
- `oferta`: `{ url, loja, tag_id, template_id, offer:{ key,title,price,oldPrice,image,sold,freeShipping,coupon,discountPct } }`. O produto é resolvido no servidor ao criar; o que o navegador manda não é confiável.
- `mensagem`: `{ texto (≤4096), imagem:'nenhuma'|'upload'|'previa', upload?, previa_url? }`
- `enquete`: `{ pergunta (≤255), opcoes[2..12] (≤100 cada, sem repetir), multipla }`
- `repetir`: `{ dias:[0..6], horarios:['HH:MM'] (1..6) }`
- A hora sempre vai como `agendar_data` + `agendar_hhmm` e o servidor converte no fuso dele (TZ). A oferta só aceita `agora` ou `agendado` hoje.

**Funções novas:**
- `src/lojas.js`: `PLATAFORMAS` (com `campos`), `identificar(url)`, `class LojaNaoConectada`, `lerProduto(id,url,{ml})`, `linkAfiliado(id,{url,tag},{links})`, `previaDoLink(url,{ml})`.
- `src/whatsapp.js`: `sendText(jid,text,{previa})`, `sendImage(jid, urlOuBuffer, caption, {mimetype})`, `sendPoll(jid,{pergunta,opcoes,multipla})`, `resolverNumero(digitos)`.
- `src/scheduler.js`: `createScheduler({ …, dir })` → `{ …hoje, envios, avisos }`. Exporta `sleep` e `jitter`.
- `src/envios.js`: `createEnvios({db,wa,links,ml,fast,dir})` → `{ criar, processarPendentes, runEnvio, recuperar, cancelar, pausar, retomar, painel(tipo), limpar(dias) }`, mais `proximaOcorrencia(repetir, depoisDe)` (pura) e `montarRotas`.
- `src/avisos.js`: `createAvisos({db,wa})` → `{ tick, montarResumo(blocos, now), enviarResumo({destinoId}) }` e `montarRotas`.
- `src/auth.js`:
  - `createAuth` → `{ enabled, legado, login(email,senha,ip), logout, sessionFrom → {…, user}, setPassword, criarConvite, novoLinkConvite, infoConvite, aceitarConvite }`
  - `soDono(auth)`
  - `setPassword(db,pw)` passa a mudar o Dono mais antigo; sem usuários, cria o Dono.

**Rotas** (todas com Host/Origin; públicas marcadas).
- F1/F2:
  - `POST /api/disparo/identificar {url, template_id}` → `{loja, produto, texto}`
  - `POST /api/envios`
  - `GET /api/envios?tipo=oferta|mensagem` → `{ agendadas, contadores:{enviados,na_fila,com_erro} (30 dias), linhas (20) }`
  - `POST /api/envios/:id/{cancelar|pausar|retomar}`
  - `POST /api/uploads` (corpo `image/jpeg|png`, 5 MB) → `{id}`
  - `GET /api/uploads/:id`
- F3:
  - `GET /api/avisos` (número mascarado na lista)
  - `GET|POST|PUT|DELETE /api/avisos/destinos[/:id]`
  - `PUT /api/avisos/config`
  - `GET /api/avisos/previa?destino=`
  - `POST /api/avisos/resumo-agora`
- F4:
  - `GET /api/conexoes`: campos sem segredo + `segredos_salvos:[nomes]`
  - `PUT /api/conexoes/:id`: segredo vazio mantém o salvo; campos fora do registro são descartados
  - `POST /api/conexoes/:id/testar`
- F5:
  - Públicas: `GET /api/login/modo`, `POST /api/convite/info`, `POST /api/convite/aceitar`
  - `PUT /api/me`
  - Com `soDono`: `GET /api/equipe`, `PUT /api/equipe/conta`, `POST /api/equipe/convites` → `{link}` (só aqui), `POST /api/equipe/convites/:id/link`, `DELETE /api/equipe/convites/:id`, `PUT|DELETE /api/equipe/pessoas/:id`

**Resumo diário (texto):**
- `📊 *Resumo de 02/11* (até 21:00)`
- Para cada bloco: `*<bloco>* · N grupos · M membros` / `➕ Entraram: X · ➖ Saíram: Y` / `🏃 Saíram no mesmo dia: Z%` / `👀 Abriram: A` / `🔗 Cliques: C`
- Fonte: `resumo` + `evasaoDoDia` + soma de `groups.size`, no dia de negócio até agora.
- Horário-alvo do dia: `inicioDoDia + ((resumo - virada + 1440) % 1440) min`.

## Etapas
Verificação de cada etapa: o teste do arquivo com `node --disable-warning=ExperimentalWarning --test test/<arquivo>.test.js` e depois `npm test` (linha de base: 49 passando). Para `public/*.js`, `node --check <arquivo>` mais a conferência no `npm run simular`.

| # | Etapa | Arquivos | Verificação | Responsável | Grupo | Sensível | CAs |
|---|---|---|---|---|---|---|---|
| 1 | Esquema novo (6 tabelas, índices, `sessions.user_id`), aditivo e idempotente. Teste: `openDb` duas vezes no mesmo diretório, tabelas e colunas presentes, banco antigo com dados intacto | src/db.js, test/base.test.js | test/base.test.js | dev | A | sim (migração) | CA3, CA7, CA9 |
| 2 | `src/lojas.js`: registro (ML, Amazon, Shopee, Magalu, Facebook com `campos` e flag de segredo), `identificar` só por hostname (incluindo short links e host falso tipo `mercadolivre.com.br.evil.com`), `LojaNaoConectada` com o nome, ML via `resolveOffer`/`requestLink` injetados, `previaDoLink` só ML e só `mlstatic`. Testes com stubs, sem rede | src/lojas.js, test/lojas.test.js | test/lojas.test.js | dev | A | não | CA1, CA2, CA6 |
| 3 | WhatsApp: `sendImage` com Buffer + mimetype, `sendPoll`, `sendText` com `previa`, `resolverNumero` (`onWhatsApp`). Tudo registrado em `simulated` no modo simulado | src/whatsapp.js, test/whatsapp.test.js | test/whatsapp.test.js | dev | A | não | CA4, CA5 |
| 4 | CSS da spec: `.nav-grupo`, gaveta ≤ 900 px, `.duas-col`, `main.larga`, `.card-prod`, `.aviso-impl`, `.conexao`, `.estado-pill`, opções de enquete, botões de dia | public/style.css | revisão visual em 375/1280 px | designer | A | não | CA8 |
| 5 | Agendador único e ganchos do servidor. `tick` = envios → avisos → regras (envios de novo após cada regra), `start` → `recuperar`, `sleep`/`jitter` exportados. `buildApp` ganha `dataDir`/`ml`, monta `montarRotas` dos 4 módulos e chama `envios.limpar` na retenção. `/api/state` ganha `usuario` (null por enquanto) e `conta_nome`. Stubs com as interfaces finais. Teste: ordem do tick com espiões; regras seguem iguais | src/scheduler.js, src/server.js, src/envios.js, src/avisos.js, src/conexoes.js, src/equipe.js, test/base.test.js | test/base.test.js, test/disparador.test.js | dev | B | não | CA3, CA9 |
| 6 | Navegação F6 conforme a spec. Menu em grupos + rodapé + botão Menu. `ROTAS` com hashes novos e aliases. `ir()` com `aria-current`, `main.larga` e Equipe fora do DOM para Operador. Grupos separado de Números. Seletor de grupos extraído de `filtroGrupos`. Regras renomeadas para "Disparo automático". `paginaEtiquetas` e o cartão da extensão movidos para `public/conexoes.js`. Stubs `paginaDisparoManual`, `paginaDispararMensagem`, `paginaRelatorios`, `paginaEquipe`, `completarCadastro`. Hashes antigos em `paineis.js` (`#whatsapp`) atualizados | public/index.html, public/app.js, public/paineis.js, public/disparos.js, public/relatorios.js, public/conexoes.js, public/equipe.js | `node --check` em cada + simulação: todas as rotas e aliases abrem | dev | B | não | CA8 |
| 7 | Autenticação por usuário: migração do hash para o Dono (ligando as sessões), login por e-mail + modo legado, `/api/login/modo`, `sessionFrom` com usuário, `req.user`, `soDono`, convites (criar/girar/info/aceitar com limiter próprio e bloco síncrono), `PUT /api/me`, `setPassword` do Dono, telas `login`/`convite`. Testes: migração com sessão aberta, legado, `/api/me` mata o legado, e-mail desconhecido = 401 genérico, convite vencido/usado/cancelado = mensagem única, PANEL_PASSWORD curta, S12 e todos os testes atuais sem edição | src/auth.js, src/server.js, src/equipe.js, scripts/senha.js, public/login.html, public/login.js, public/convite.html, public/convite.js, test/equipe.test.js | test/equipe.test.js, test/seguranca.test.js, test/servidor.test.js | dev (opus) | C | **sim** | CA7, CA9, CA10 |
| 8 | Envios (backend F1/F2): `criar` com validação por tipo, `processarPendentes`, `runEnvio` (trava atômica, retomada por ocorrência, grava `log`), `proximaOcorrencia`, cancelar/pausar/retomar, `painel`, upload raw (bytes iniciais, 5 MB, nome aleatório) e `limpar`. Testes de servidor: CA1 (imagem + `meli.la/fake-<etiqueta>` + linha "enviado"), CA2 (Amazon recusada, `simulated` vazio, sem linha), CA3 (agendado sobrevive a um scheduler novo no mesmo banco, `enviando` retomado sem duplicar), CA4 (texto, upload, enquete, agendado, repetido, cancelar, contadores, upload inválido 415/413) | src/envios.js, test/envios.test.js | test/envios.test.js | dev (opus) | C | sim (entrada de arquivo, concorrência) | CA1–CA4, CA9 |
| 9 | Telas F1 e F2 conforme a spec. Identificar, prévia, etiqueta, agendar hoje / data / repetir, upload por `fetch` com corpo `File` e miniatura via `FileReader` (`data:`), histórico com atualização de 6 s | public/disparos.js | `node --check` + simulação | dev | C | não | CA1–CA4 |
| 10 | Conexões: guarda `config` e `segredos` separados, campos só do registro com tamanho e padrão, `testar` (ML: etiqueta + extensão/modo; demais: "ainda não implementado"). Tela com o cartão do ML (etiquetas + extensão já movidas) e os cartões das outras lojas. Teste: o segredo nunca aparece no texto cru de nenhuma resposta, vazio mantém o salvo, campo estranho é descartado | src/conexoes.js, public/conexoes.js, test/conexoes.test.js | test/conexoes.test.js | dev (opus) | C | **sim** (segredo) | CA6, CA10 |
| 11 | Avisos e configurações. Destinos com número canônico e listagem mascarada, prévia e resumo agora, resumo diário 1× por dia de negócio, aviso de erro agregado com limite de frequência, lotação com dedupe. `viradaMin` em analytics e repasse em `/api/overview`, `/api/blocks`, `linkView`. `limite_padrao` em `linkFromBody`, `formLink` e na série por hora a partir da virada. Tela Relatórios. Testes: resumo agora chega ao JID do destino; no horário sai 1×; virada 02:00 joga entrada da 01:30 para ontem; limite padrão em link novo; nenhum número no `log` | src/avisos.js, src/analytics.js, src/server.js, public/paineis.js, public/relatorios.js, test/avisos.test.js | test/avisos.test.js, test/analise.test.js | dev (opus) | D | **sim** (dado pessoal) | CA5, CA9, CA10 |
| 12 | Equipe para o Dono: `GET /api/equipe`, nome da conta, convidar (link mostrado uma vez), "Copiar link" gira o token, cancelar, papel, remover (apaga sessões), proteção do último Dono e de si mesmo, limpeza preguiçosa de convites com mais de 30 dias. Tela Equipe + "Complete seu cadastro". Testes: Operador recebe 403 em tudo de `/api/equipe`; o link antigo morre ao girar; papel muda na hora | src/equipe.js, public/equipe.js, test/equipe.test.js | test/equipe.test.js | dev (opus) | D | **sim** | CA7, CA9, CA10 |
| 13 | Ajuda: `TIPS`/`AJUDA` novos e renomeados (Disparo automático, Números, Conexões, Equipe, Relatórios) | public/ajuda.js | `node --check` + página Ajuda | designer | E | não | CA8 |
| 14 | README: menu novo, disparo manual/mensagem, avisos, conexões, equipe/convite, `npm run senha` agora para o Dono, migração no 1º start | README.md | leitura | dev | E | não | CA8 |

**Ordem:**
1. A em paralelo (1, 2, 3, 4).
2. B (5 e 6 em paralelo).
3. C (7, 8, 9, 10 em paralelo). A etapa 9 segue o contrato da 8 e pode ser feita pelo mesmo `dev` depois dela.
4. D (11 e 12 em paralelo).
5. E (13 e 14).

Dois arquivos aparecem em mais de uma etapa, sempre em grupos diferentes: `src/server.js` (5 → 7 → 11) e `src/equipe.js` (5 → 7 → 12).

**Corte sugerido:** a Equipe (7 e 12) muda o login do serviço que está rodando.
- Entrega 1: etapas 1–6, 8–11, 13 e 14.
- Entrega 2: etapas 7 e 12.

As outras etapas não dependem da Equipe: sem ela, `req.user` fica null e o login segue como hoje.

## Pontos para o seguranca
- **Login (7):**
  - E-mail desconhecido gasta o mesmo scrypt (hash fictício). A mensagem é única.
  - O modo legado só existe enquanto houver Dono com `email NULL`. `/api/login/modo` revela só isso.
  - A ordem dos freios não muda: contagem antes do scrypt e teto de 2 (S12). O limiter continua por IP + global, não por e-mail, para que ninguém tranque o Dono chutando o e-mail dele.
- **Migração (7):** só roda sem usuários, em transação, e é idempotente a cada start. As sessões abertas passam ao Dono. `sessionFrom` exige JOIN com `users`: usuário removido derruba a sessão.
- **Convite (7, 12):**
  - Token de 256 bits, guardado como sha256, uso único, vence em 7 dias, giro invalida o anterior. Vai no fragmento da URL.
  - O e-mail e o papel vêm do convite, nunca do corpo.
  - A aceitação passa por limiter e faz a checagem + gravação num bloco síncrono, sem `await` no meio (corrida de uso duplo).
  - `soDono` vale em todas as rotas de Equipe, o último Dono é protegido e a troca de papel tem efeito na hora.
- **Segredos (10):**
  - `segredos` nunca entra em SELECT de leitura para o painel, nunca vai para `log` nem mensagem de erro, e vazio não apaga.
  - Fica em claro no banco, como `ext_token`/`pseudo_key`: cifrar com chave no mesmo banco não protege.
  - O `ext_token` continua indo para o navegador em `/api/state` (como hoje), agora também para Operadores.
- **Upload (8):**
  - O parser roda só na rota e depois do login.
  - Tipos por bytes iniciais (sem SVG/GIF), 5 MB, nome aleatório validado por `^[a-f0-9]{32}\.(jpg|png)$` (sem path traversal).
  - Servido com `Content-Type` fixo + `nosniff` e apagado por idade.
- **SSRF (2, 8):** `identificar` não acessa a rede. Só o ML lê página (`hostPermitido`), a miniatura só vem de `mlstatic` e `link-preview-js` não é instalado. A prévia de outros sites é recusada.
- **Dado pessoal (11, 12):**
  - Os números dos destinos (`aviso_destinos.jid`) e os e-mails (`users`, `invites`) ficam só em `data/`.
  - A listagem mascara o número. O `log` usa nome, não número nem e-mail.
  - Convites usados/cancelados/vencidos somem depois de 30 dias. Os backups passam a carregar e-mails: atualizar a nota de LGPD no README.
- **Concorrência (8):** a trava `UPDATE … WHERE status='pendente'` entre o "agora" e o `tick`, e a retomada que pula os `ok` da ocorrência.

## Riscos e como reverter
- **Migração de auth.** Só cria tabelas e coluna. `panel_password_hash` fica, então voltar o código antigo volta a senha única com as mesmas sessões, que ignoram `user_id`. Se o Dono trocou a senha depois, rodar `npm run senha` no código antigo.
- **Tabelas novas.** São aditivas (`IF NOT EXISTS`) e o código antigo as ignora. Não há migração destrutiva.
- **Envio duplicado após queda no meio.** Mitigado pela retomada por ocorrência. O teste do CA3 cobre a ordem: enviando → reinício → retoma.
- **Atraso do agendado.** Pode atrasar enquanto uma regra envia (até minutos). Por isso o `tick` processa envios entre regras. Fica documentado na ajuda.
- **Risco ao número.** Repetidas e enquetes aumentam o volume. Mitigações: até 6 horários por repetição e as mesmas pausas com variação de `delay_group_s`.
- **Não verificado no aparelho:** enquete em grupo só de admins (`toAnnouncementGroup`), `selectableCount: 0` como múltipla escolha e a miniatura via `sharp` (peer do Baileys, não é dependência nossa). Se faltar, a prévia sai sem imagem.
- **Spam de aviso.** Erro agregado no máximo a cada 30 min. Lotação 1× por grupo até esvaziar.

## Perguntas em aberto e premissas adotadas
**Perguntas para o dono:**
1. Convite guardado como hash, com "Copiar link" gerando link novo (recomendado), ou token em claro para copiar sempre o mesmo, como na referência?
2. Operador pode tudo menos Equipe (como diz o brief), ou também perde "Gerar novo token", "Desconectar WhatsApp", "Apagar dados" e os segredos de Conexões (pergunta 4 da spec)?
3. "Prévia do link" só para links do ML agora (sem dependência), ou instalar `link-preview-js` para qualquer site (o servidor passa a buscar páginas de terceiros)?
4. Agendado que perdeu o horário (WhatsApp fora) é descartado depois de 2 h (proposto) ou sai quando reconectar?
5. Separar a Equipe (etapas 7 e 12) numa segunda entrega?

**Respostas do dono (02/11/2026):** 1) hash, link novo a cada cópia; 2) Operador NÃO vê Equipe nem: gerar novo token da extensão, desconectar WhatsApp, apagar dados antigos, ver/trocar segredos de Conexões; 3) prévia só Mercado Livre; 4) descartado como erro depois de 2 h; 5) sim, Equipe (7 e 12) na entrega 2. Plano e spec aprovados.

**Premissas adotadas:**
- Um só número de WhatsApp: não há seletor "Número que dispara".
- Fotos JPG/PNG até 5 MB (WEBP fica fora até confirmar o mimetype).
- Virada padrão 00:00, como hoje.
- Contadores do histórico de F1/F2 nos últimos 30 dias.
- F1 sempre com foto.
- O aviso "WhatsApp caiu" sai como parte do aviso de erro, quando a conexão volta.
- URL do convite `/convite.html#<token>` (a spec dizia `/convite/<token>`).
- Arquivos `relatorios.js`/`conexoes.js`/`equipe.js` no lugar de `conta.js`.

## ADR
**ADR-001: envios unificados e usuários individuais.**
- **Contexto.** O painel só disparava por regra e tinha senha única.
- **Decisão:**
  - Uma tabela `envios` com tipo/quando/status e resultado por grupo, processada pelo mesmo `tick` das regras.
  - `users`/`invites` com sessões ligadas a `user_id` e migração não destrutiva do hash atual para um Dono.
  - Rotas novas por módulo (`montarRotas`) para paralelizar sem conflito.
- **Consequências.** Um laço só de envio, ritmo anti-bloqueio compartilhado e rollback sem perda. O agendado pode atrasar enquanto uma regra envia. O Operador alcança tudo menos Equipe até o dono decidir o contrário.
