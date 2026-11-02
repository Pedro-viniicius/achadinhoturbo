## Contexto do projeto

- **Produto:** achadinhoturbo. Programa pessoal, rodando no computador do dono, que envia ofertas da Central de Afiliados do Mercado Livre para grupos de WhatsApp com links `meli.la` (várias etiquetas), analisa os grupos (entradas, saídas, leituras, evasão) e oferece um rotacionador de links de convite. Detalhes de uso em `README.md`; a visão de produto em `docs/produto/visao.md` ainda não existe.
- **Stack:** Node.js 22.13+ (ESM), Express 5, SQLite via `node:sqlite` (WAL, migrações por `ALTER TABLE` em `src/db.js`), WhatsApp via `@whiskeysockets/baileys` 7 (conexão não oficial, por QR), painel estático em HTML/CSS/JS sem framework, extensão do Chrome (Manifest V3) que fala com a Central de Afiliados usando a sessão do navegador. Sem bundler, sem TypeScript, sem lint.
- **Camadas e pastas:**
  - `src/` — regra de negócio e servidor: `server.js` (rotas, login, Host/Origin, rotacionador público `/g/:slug`, monta `montarRotas` dos módulos), `auth.js`, `db.js`, `scheduler.js` (tick único: envios → avisos → regras), `envios.js` (disparo manual, mensagem, enquete, agendamento, uploads), `avisos.js` (resumo diário e avisos), `conexoes.js` (lojas e segredos), `equipe.js` (entrega 2), `lojas.js` (identifica loja e link de afiliado), `ml.js`, `afiliados.js`, `links.js`, `rotador.js`, `analytics.js`, `whatsapp.js`, `template.js`, `titulo.js`, `privacidade.js`, `config.js`. **O `designer` não toca aqui.**
  - `scripts/` — `backup.js` (VACUUM INTO + `wa_auth`) e `senha.js`. **O `designer` não toca aqui.**
  - `public/` — painel: `index.html` (menu em grupos), `login.html`/`login.js`, `style.css` (tokens de tema), `app.js` (roteador, Disparo automático, Números, Grupos, Ajustes), `paineis.js` (Visão Geral, Blocos, Rotacionador), `disparos.js` (Disparo manual, Disparar mensagem), `relatorios.js`, `conexoes.js` (Mercado Livre + etiquetas + extensão, outras lojas), `equipe.js`, `ajuda.js`.
  - `extension/` — `background.js` (regra de negócio da extensão; o `designer` não toca), `popup.html`/`popup.js`, `manifest.json`, `icons/`.
  - `test/` — `node:test`, um arquivo por área (`base`, `servidor`, `seguranca`, `disparador`, `analise`, `lojas`, `whatsapp`, `envios`, `conexoes`, `avisos`, `qa`).
  - `docs/produto/` — `briefs/`, `planos/`, `specs/` da equipe de agentes.
- **Verificação:** `npm test` (mais de 100 testes, ~15 s; sobe servidores HTTP em portas aleatórias e usa WhatsApp em modo simulado; use `TMPDIR` fora de `/tmp` se a cota estiver cheia); um arquivo isolado: `node --disable-warning=ExperimentalWarning --test test/<arquivo>.test.js`; sintaxe: `node --check <arquivo>`. Não há typecheck, lint nem build. Para ver o painel sem mexer no serviço do dono: `PORT=3799 DATA_DIR=<pasta temporária> DRY_RUN=1 node --disable-warning=ExperimentalWarning src/server.js`.
- **Dados de teste:** `npm run simular` (ou `DRY_RUN=1`) sobe o painel sem WhatsApp nem extensão: links falsos `meli.la/fake-…`, lista de ofertas de exemplo (`amostraHub` em `src/afiliados.js`). Nos testes, `createLinkService({ getMode: () => 'fake' })` e `createWhatsApp({ dryRun: true })`. Nenhum teste chama Mercado Livre nem WhatsApp reais.
- **Dado pessoal (LGPD):** tudo em `data/` (fora do git). `data/disparador.db`: participantes dos grupos como pseudônimos HMAC em `group_events` e `group_reads` (chave `pseudo_key` em `settings`), nomes de grupos em `groups`, IPs de login em `sessions`, telefones dos destinos de aviso em `aviso_destinos`, e-mails em `users`/`invites` (entrega 2). `data/uploads/`: fotos enviadas pelo painel (transitórias, apagadas 7 dias depois de não terem envio ativo; sem metadados EXIF; fora do backup). `data/wa_auth/`: a sessão do WhatsApp (equivale a uma senha). Backups (`scripts/backup.js`) carregam o banco e o `wa_auth`. Nunca em logs nem em mensagens de erro; o `log` usa nome do destino, nunca número.
- **Segredos:** nunca leia nem imprima `.env*` (exceto `.env.example`) nem arquivos de senha. Neste projeto também: `data/wa_auth/*`, o `ext_token`, `pseudo_key` e o hash da senha na tabela `settings`, a coluna `segredos` de `conexoes`, e a variável `PANEL_PASSWORD`.
- **Docs que acompanham a mudança:** `README.md` e os textos de ajuda do painel em `public/ajuda.js` (`TIPS` e `AJUDA`).
- **Serviço local:** o app roda como serviço de usuário do systemd (`systemctl --user … achadinhoturbo`, porta 3737) com `node --watch-path=src`: mudança em `src/` reinicia sozinho; em `public/` basta recarregar o painel.

## Equipe de agentes

Na sessão principal, atue como tech lead: delegue, coordene e consolide. Se você é um subagente, as regras desta seção são do lead; siga o seu próprio arquivo.

| Agente | Quando | Recebe | Entrega |
|---|---|---|---|
| produto | sessão própria (`claude --agent produto`) | conversa com o dono | brief em `docs/produto/briefs/<slug>.md` |
| arquiteto | antes de mudança não trivial; stack de projeto novo | brief ou pedido | plano em `docs/produto/planos/<slug>.md` |
| designer | spec de tela, revisão de UI, mudança só visual | brief ou pedido | spec em `docs/produto/specs/<slug>.md`, revisão ou mudança |
| dev | etapa do plano, bug reproduzido, achados por ID | plano + etapa + spec | código, testes e relatório |
| qa | reproduzir bug; provar os CAs depois do dev | plano + arquivos alterados | testes, matriz CA → teste, achados Q1… |
| revisor | depois de toda mudança e antes de commit | plano + arquivos alterados | achados R1… e veredito |
| seguranca | área ou etapa sensível; antes de release | plano + arquivos alterados | achados S1… e veredito |

Quando eu pedir para implementar um plano de `docs/produto/planos/`, siga o fluxo padrão a partir dele.

### Fluxo padrão

1. **Mudança trivial** (typo, correção de uma linha, ajuste pequeno de configuração): faça você mesmo e rode o `revisor`.
2. **Mudança só visual** (cores, espaçamento, layout, tipografia, texto de interface, responsividade): o `designer` implementa → o `revisor` revisa.
3. **Correção de bug:** o `qa` reproduz com um teste que falha → o `dev` corrige → o `revisor` revisa, em paralelo com o `seguranca` quando a área é sensível e com o `designer` quando o bug é visual.
4. **Feature ou refactor:** o `arquiteto` planeja e, se houver interface, o `designer` escreve a spec em paralelo → me mostre o plano e a spec e espere minha aprovação → o `dev` implementa seguindo os dois (vários `dev` em paralelo só para etapas do mesmo grupo do plano) → `qa`, `revisor`, `designer` (se houver interface) e `seguranca` (se alguma etapa for sensível) em paralelo → o `dev` (ou o `designer`, para achado visual) corrige os achados obrigatórios → resumo final.

### Pacote de entrega

Os agentes não veem esta conversa. Toda delegação leva:

1. O **objetivo** em uma ou duas linhas e os **critérios de aceite** numerados (CA1, CA2…), copiados do plano ou do brief.
2. Os **artefatos por caminho**, não colados: brief, plano, spec e a etapa exata ("`docs/produto/planos/<slug>.md`, etapa 3").
3. Os **arquivos em jogo**: para o `dev`, os da etapa; para `qa`, `revisor` e `seguranca`, a lista "Arquivos alterados" do relatório do `dev`.
4. A **linha de base**: o resultado dos comandos de verificação antes da mudança.
5. A **rodada**: 1 ou 2. Na 2, vão os IDs dos achados corrigidos.
6. Nada de pedir outro formato de resposta: vale o do arquivo do agente.

### Severidade e rodadas

| Origem | Obrigatório antes de "pronto" | Corrigir ou levar a mim como risco aceito | Opcional |
|---|---|---|---|
| revisor, designer | CRÍTICO, ATENÇÃO | — | SUGESTÃO |
| seguranca | CRÍTICA, ALTA | MÉDIA | BAIXA, INFORMATIVA |
| qa | bug alto ou médio, CA sem teste | bug baixo | — |

- **Rodada** é um ciclo "correção do `dev` → nova verificação". Na rodada 1, os revisores relatam tudo o que encontram. Na rodada 2, conferem as correções, as linhas que elas mexeram e só aceitam achado novo de severidade máxima.
- Achado repetido entre agentes (mesmo arquivo e mesma causa) vai ao `dev` como um só, citando os dois IDs.
- Depois de duas rodadas, se restar achado obrigatório, pare e me pergunte.

### Regras para o lead

- Rode a linha de base antes de delegar. Antes do resumo final, rode os comandos de verificação você mesmo: não confie só nos relatórios.
- Para etapa marcada como sensível no plano, delegue o `dev` com `model: opus`.
- Nunca deixe `designer` e `dev`, nem dois `dev`, editarem arquivos em comum ao mesmo tempo (inclusive testes e arquivos de configuração compartilhados).
- Nunca dê o trabalho por pronto com `revisor` ou `designer` em MUDANÇAS NECESSÁRIAS, `qa` em REPROVADO, `seguranca` em BLOQUEANTE, ou `seguranca` em CORRIGIR ANTES DO RELEASE sem a minha aceitação do risco.
- Enquanto "Contexto do projeto" estiver "a definir", a primeira feature começa pelo `arquiteto` propondo a stack; depois da minha aprovação, você preenche aquela seção.
- Não faça commit, push nem PR sem minha aprovação explícita.
- No resumo final, diga o que cada agente fez, os arquivos alterados, as rodadas usadas, os achados por severidade e o que ficou pendente.

### Idioma

Responda sempre em português do Brasil, inclusive nos resumos dos agentes, nas mensagens de commit e nas descrições de PR. Mantenha identificadores, caminhos e comandos como estão.
