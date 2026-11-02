# Entrega 1 — achados da rodada 1 (consolidados pelo lead)

Fontes: revisor (R), qa (Q), seguranca (S), designer (D, já corrigidos por ele). Achado repetido vai como um só, com todos os IDs.
Decisões do lead: (1) a foto do produto DEVE aparecer no cartão do Disparo manual; a CSP fica com `img-src 'self' data: https://*.mlstatic.com` (alinha com `IMAGEM_PERMITIDA`) e a tela aceita `https://*.mlstatic.com/`. (2) Pausar é só para envio repetido; agendado único só cancela; textos seguem isso. (3) S14 pela opção B: "agora" grava `next_run_at = now` e chama `scheduler.tick()`; a tela já diz "Enviando… acompanhe no histórico". (4) S15 sem dependência nova: remover segmentos APP1–APP15 do JPEG e chunks eXIf/tEXt/zTXt/iTXt do PNG no upload (se `sharp` estiver carregável, pode usá-lo com fallback).

## Obrigatórios

### Painel (dev A: public/, README, extension, ajuda)
- **R1 / Q1 [CRÍTICO/ALTA]** `public/disparos.js:469-473` e `:745-753`: corpo achatado (`{tipo, group_jids, quando, agendar_data?, agendar_hhmm?, repetir?, url, tag_id, template_id}` ou `...payload`). Servidor NÃO muda. Testes que provam: `test/qa.test.js` "Q1 tela Disparo manual…" e "Q1 tela Disparar mensagem…".
- **R2 / Q2 / Q3 [CRÍTICO/MÉDIA]** `public/disparos.js:233-244`: usar `l.quando`, `l.grupo`, `a.titulo` (API devolve esses). Testes Q2, Q3.
- **R3 / Q4 [ATENÇÃO]** Pausar/Retomar só quando `a.quando === 'repetir'` (`disparos.js:249-251`, `:796`). Textos: `README.md:89`, `public/ajuda.js:71`, `:150` → "repetidas podem ser pausadas; agendadas e repetidas podem ser canceladas". Teste Q4.
- **R4 / Q5 / S21 [ATENÇÃO]** `public/disparos.js:400-401`: mostrar `produto.image` quando casar `^https://[a-z0-9.-]+\.mlstatic\.com/`; corrigir comentários em `:6-7`, `:121`, `:400`. Teste Q5 (ajustar a expectativa do teste ao host se preciso, sem enfraquecer).
- **R5 [ATENÇÃO]** "token em Ajustes" → "Conexões → Mercado Livre": `README.md:121`, `:145`, `extension/popup.html:21`, `extension/background.js:109`.
- **R6 [ATENÇÃO]** `public/ajuda.js:75` e `:156` (limite padrão só preenche link novo; lotação usa o limite de cada link); `README.md:100` (conteúdo real do resumo: grupos, membros, entraram, saíram, saíram no mesmo dia, abriram, cliques); `README.md:116` (menu mostra "Equipe", a página diz "Em construção").
- **R10 (parte)** remover ramos/textos de 501 em `disparos.js:19-20,138,295,498,800`.
- **R11 [SUGESTÃO, fazer]** `public/app.js:357` coluna "Regra" → "Origem".
- **Q8 (texto)** nada no painel; é do servidor.

### Servidor (dev B, opus: src/, test/)
- **S13 [MÉDIA]** cortar antes do regex: `limparErro` (`src/envios.js:52-54`) e `semNumero` (`src/avisos.js:27-28`) → `String(m).slice(0,500)` antes do `replace`; `links.submit` (`src/links.js:76,85`) limita `error` a 300; `addLog` (`src/db.js:158-160`) corta `message` a 1000. Testes: `limparErro('a'.repeat(1e6))` < 50 ms; `submit` com erro de 1 MB grava ≤ 300.
- **S14 [MÉDIA]** `src/envios.js:286`: "agora" não chama `runEnvio` direto; grava `status='pendente', next_run_at=now` e chama `scheduler.tick()` (precisa de acesso ao tick: `createEnvios` recebe `tick` via setter do scheduler ou o `ctx.scheduler.tick` na rota). Manter recusa com WhatsApp fora. Teste: três "agora" seguidos com `delay_group_s` 0,5 s saem com ≥ 0,35 s entre mensagens (ou prova equivalente de serialização).
- **S15 [MÉDIA]** `src/envios.js:649`: remover metadados no upload (JPEG APP1–APP15; PNG eXIf/tEXt/zTXt/iTXt), antes de gravar. Teste: JPEG com bloco `Exif\0\0` gravado sem ele; PNG com `tEXt` sem ele.
- **R7 [ATENÇÃO]** leitura contada por dia de negócio: `createWhatsApp({ diaDe })`, servidor passa `(ts) => dayOf(ts, viradaMin(db))` (`src/whatsapp.js:21,160`, `src/server.js`). Teste: virada 02:00, leituras 01:00 e 03:00 do mesmo dia → 2 leituras.
- **Q6 [BAIXA, fazer]** `src/envios.js:294-296`: usar o NOME guardado no payload (etiqueta e template) quando o id atual tiver nome diferente ou não existir; ou impedir apagar etiqueta/template com envio pendente (`src/server.js:339-368`). Teste Q6.
- **Q7 / S18 [BAIXA, fazer]** `src/envios.js:367,392,345-355,559-569`: trava e `finalizar` conferem `next_run_at = ocorrencia`; o laço para quando `next_run_at !== ocorrencia`. Teste Q7.
- **Q8 [BAIXA, fazer]** `src/envios.js:276`: erro da prévia com mensagem própria ("Não consegui ler a prévia deste link…"), sem o texto da lista das regras. Teste Q8.
- **CSP** `src/server.js:27`: `img-src 'self' data: https://*.mlstatic.com`.
- **S16 [BAIXA, fazer]** limiter antes do `onWhatsApp` em `src/avisos.js:100-108` (10 por 10 min por sessão/IP).
- **S17 [BAIXA, fazer]** `src/avisos.js:126-128`: recusar 6+ dígitos no nome do destino.
- **S20 [INFO, fazer]** `src/whatsapp.js:69-82`: `IMAGEM_PERMITIDA` dentro de `baixarImagem`.
- **S22 [INFO, fazer]** `src/whatsapp.js:233-236`: mascarar JIDs `@s.whatsapp.net` no registro simulado (manter os `@g.us`).
- **R8 [SUGESTÃO, fazer o mínimo]** `links.modo()` exposto em `src/links.js` e usado por `envios.js:195` e `src/conexoes.js:73`; `/api/state.ajustes.link_mode` já existe para a tela.
- **R9 [SUGESTÃO, fazer]** rotas de upload usam a pasta da instância (`createEnvios({dir})`), não `ctx.dataDir` separado.
- **R14 / R15 [SUGESTÃO, fazer]** `sleep`/`jitter` em `src/util.js` (fim do ciclo scheduler↔envios); limpeza de pastas já feita pelo qa.
- **Teste de fuso** `test/analise.test.js` "períodos: hoje, ontem…" falha em TZ=America/New_York (dia de 25 h): esperar `new Date(2026,10,1).getTime()`.
- **Regressão** teste: corpo > 5 MB em `/api/uploads` sem sessão → 401.

## Opcionais deixados de fora (registrar)
- S19 cota total de uploads (exige login; baixo). R10 `PLATAFORMAS.mercadolivre.campos` (código morto; decidir na entrega 2). R12 resumo no horário da virada (documentar na ajuda: dev A pode acrescentar uma frase). R13 coberto por S20. D12–D14 visuais menores. "Grupo removido da tabela ainda recebe envio agendado": manter (decisão: evita erro falso após reconectar).

## Verificação
`TMPDIR=/home/ufla/.cache/achadinhoturbo-tmp/<dev> npm test` → hoje 137 testes, 128 passam, 9 falham (Q1–Q8 em `test/qa.test.js`). Meta: 0 falhas sem enfraquecer os testes do qa.
