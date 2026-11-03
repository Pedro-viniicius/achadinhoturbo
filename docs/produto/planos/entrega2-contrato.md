# Entrega 2 (Equipe): contrato entre servidor e painel

Escrito pelo lead em 02/11/2026 para as etapas 7 e 12 de `docs/produto/planos/disparos-comunicacao-conta.md`, com as decisões do dono já registradas lá ("Respostas do dono") e a spec `docs/produto/specs/disparos-comunicacao-conta.md` (seções "Equipe (F5)", "Tela de aceite", "Entrar", "O que o Operador não vê", "Estados", "Textos da interface"). Dois `dev` trabalham em paralelo: **dev-servidor** (`src/`, `scripts/`, `test/equipe.test.js`, `README.md`) e **dev-painel** (`public/`). Este arquivo é a fonte da verdade quando o plano e a spec divergirem dele.

## Situações do painel

| Situação | Como reconhecer | Comportamento |
|---|---|---|
| **Sem senha** (caso atual do dono: nunca definiu `PANEL_PASSWORD` nem rodou `npm run senha`) | `/api/state` → `auth:false`, `usuario:null` | Tudo passa sem login, como hoje. O painel se comporta como Dono. A tela Equipe mostra só o card **"Proteja o painel"** (nome, e-mail, senha, confirmar) que chama `POST /api/equipe/ativar`. |
| **Legado** (há `panel_password_hash`, o Dono migrado ainda não tem e-mail) | `GET /api/login/modo` → `{ modo:'legado' }`; depois de entrar, `usuario.precisa_completar:true` | Login só com senha (campo e-mail escondido). Ao entrar, o painel abre o diálogo **"Complete seu cadastro"** (nome, e-mail, nova senha opcional) → `PUT /api/me`. Enquanto não completar, o diálogo volta a cada carga da página, mas não bloqueia o resto. |
| **Por e-mail** | `GET /api/login/modo` → `{ modo:'email' }` | Login com e-mail + senha. Equipe completa para o Dono. |

Regras do servidor:
- `auth.enabled()` = existe ao menos uma linha em `users` **ou** existe `panel_password_hash`.
- **Migração** (em `createAuth`, a cada start, idempotente, em transação): se há `panel_password_hash` e `users` está vazia, cria o Dono `{ nome:'Dono', email:NULL, senha_hash:<o hash atual>, papel:'dono' }` e grava `user_id` dele em todas as sessões com `user_id IS NULL`. `panel_password_hash` **fica** no banco (rollback para o código antigo).
- `PANEL_PASSWORD` no ambiente: se não há hash nem usuários, cria o hash como hoje (a migração então cria o Dono em seguida). Continua recusando senha com menos de 8 caracteres.
- `sessionFrom(sid)` faz `JOIN users` e devolve `{ ...sessao, user:{ id, nome, email, papel } }`; sessão cuja pessoa foi removida (ou sem `user_id` depois da migração) é inválida e apagada.
- O middleware de login grava `req.user`. Quando `auth` está desligada, `req.user = null` e `soDono` deixa passar.
- `soDono(auth)`: se `req.user` existe e `papel !== 'dono'` → `403 { erro:'Só o Dono pode fazer isso.' }`. Aplicado em: tudo de `/api/equipe/*` (exceto `ativar`, que exige `auth` desligada), `POST /api/ajustes/token`, `POST /api/wa/logout`, `POST /api/privacidade/limpar`, `PUT /api/conexoes/:id`, `POST /api/conexoes/:id/testar` (os dois últimos já usam `ctx.soDono`; basta trocar o `soDono` do `ctx` em `src/server.js`). `GET /api/conexoes` só inclui `segredos_salvos` para Dono (ou com `auth` desligada).
- `setPassword(db, pw)` (`scripts/senha.js`): garante um Dono (cria `{nome:'Dono', email:NULL}` se `users` vazia), troca a `senha_hash` do Dono mais antigo, atualiza `panel_password_hash` com o mesmo hash e apaga todas as sessões. Mensagem do script: "Senha do Dono trocada…".
- Nunca registrar e-mail nem senha em `log` nem em erro. O `log` de Equipe usa o nome da pessoa.

## Rotas públicas (montadas antes do middleware de sessão, em `PUBLIC_PATHS`)

- Arquivos: `/convite.html`, `/convite.js` (além de `/login.html`, `/login.js`, `/style.css`, `/logo.svg`, já públicos).
- `GET /api/login/modo` → `{ modo:'legado'|'email' }`. Com `auth` desligada → `{ modo:'email' }` (o `login.js` nem chega a ser usado).
- `POST /api/login` corpo `{ email?, senha }`:
  - legado: ignora `email`, confere a senha do Dono sem e-mail;
  - e-mail: procura `users.email` (NOCASE); e-mail desconhecido gasta o mesmo scrypt num hash fictício. Resposta de falha única: `401 { erro:'E-mail ou senha incorretos.' }`. Freios atuais (por IP, global, teto de 2 scrypt) sem mudança; S12 e os testes de login atuais continuam passando sem edição. Sucesso: cookie como hoje, `{ ok:true }`, atualiza `last_login_at`.
- `POST /api/convite/info` corpo `{ token }` → `200 { conta_nome, email, papel }` ou `410 { erro:'Este convite não vale mais.' }` (mensagem única para inválido, vencido, usado e cancelado). Passa pelo limiter de convite.
- `POST /api/convite/aceitar` corpo `{ token, nome, senha }` → cria a pessoa, marca `used_at`, abre sessão (cookie igual ao login) e responde `{ ok:true }`. Erros: `400 { erro }` para nome vazio (≤ 80 caracteres) ou senha < 8; `410` como acima; `409 { erro:'Esta pessoa já está na equipe.' }` se o e-mail já existe em `users`. Ordem: calcula o scrypt da senha **antes**; depois, num bloco síncrono sem `await` (transação), confere o convite de novo, insere a pessoa e marca `used_at`.
- Limiter de convite (`info` e `aceitar`): 10 falhas por IP e 100 globais em 15 min; sucesso não conta. `429 { erro:'Muitas tentativas. Tente de novo em N minutos.' }`.
- Token: 32 bytes aleatórios em hex (64 caracteres); no banco só `sha256(token)` em `invites.token_hash`. Vai no fragmento da URL: `<base>/convite.html#<token>`. `base` = `https://<PUBLIC_HOST>` quando definido, senão `http://` + o `Host` da requisição (já validado pelo middleware Host/Origin).

## Rotas com login

- `GET /api/state`: `usuario` = `null` com `auth` desligada; senão `{ id, nome, email, papel, precisa_completar }` (`precisa_completar` = e-mail nulo). `auth:true/false` e `conta_nome` como hoje.
- `PUT /api/me` corpo `{ nome, email, senha? }`: qualquer pessoa logada muda o próprio nome e e-mail (e-mail único, NOCASE, formato básico `algo@algo.algo`, ≤ 120 caracteres; `409 { erro:'Este e-mail já está em uso.' }`); `senha` opcional (≥ 8) troca a própria senha **sem** derrubar a sessão atual (derruba as outras da mesma pessoa). Respostas `{ ok:true }`.
- `POST /api/equipe/ativar` corpo `{ nome, email, senha }`: só com `auth` desligada (senão `409 { erro:'O painel já tem login.' }`). Cria o Dono, grava `panel_password_hash` com o mesmo hash, abre sessão para este navegador (cookie) e responde `{ ok:true }`. Sem `soDono` (não há usuário ainda); passa pelo Host/Origin como as demais.
- `GET /api/equipe` (`soDono`) → 
  ```json
  { "conta_nome": "…",
    "pessoas": [{ "id":1, "nome":"…", "email":"…", "papel":"dono|operador", "created_at":0, "last_login_at":0, "voce":true, "ultimo_dono":true }],
    "convites": [{ "id":1, "email":"…", "papel":"operador", "expires_at":0, "created_at":0, "convidado_por":"<nome>", "vencido":false }] }
  ```
  Nunca traz token nem link. Lista só convites com `used_at IS NULL AND canceled_at IS NULL` (vencidos incluídos, com `vencido:true`). Antes de responder, apaga convites usados/cancelados/vencidos há mais de 30 dias (limpeza preguiçosa).
- `PUT /api/equipe/conta` corpo `{ conta_nome }` (≤ 60 caracteres) → `{ ok:true }`.
- `POST /api/equipe/convites` corpo `{ email, papel }` → `201 { id, link }`. É o **único** momento em que o link aparece, junto com o giro. `409 { erro:'Esta pessoa já está na equipe.' }` se o e-mail está em `users`; `409 { erro:'Já existe um convite para este e-mail. Cancele-o para criar outro.' }` se há convite pendente não vencido. `papel` ∈ `dono|operador`. Vence em 7 dias.
- `POST /api/equipe/convites/:id/link` → `{ link }`: gera token novo, grava o hash novo (o link antigo morre), renova `expires_at` para +7 dias. `404` se o convite não está pendente.
- `DELETE /api/equipe/convites/:id` → `{ ok:true }` (grava `canceled_at`).
- `PUT /api/equipe/pessoas/:id` corpo `{ papel }` → `{ ok:true }`; efeito imediato (a sessão lê `users` a cada requisição). `409 { erro:'Você não pode mudar o próprio papel.' }` e `409 { erro:'A equipe precisa de ao menos um Dono.' }`.
- `DELETE /api/equipe/pessoas/:id` → `{ ok:true }`; apaga as sessões da pessoa. `409 { erro:'Você não pode remover a si mesmo.' }` e `409` do último Dono como acima. Convites criados por ela ficam (`created_by` vira referência a id inexistente; `convidado_por` então sai como `''`).
- Qualquer rota `soDono` para Operador → `403 { erro:'Só o Dono pode fazer isso.' }`. O painel mostra `aviso('Só o Dono pode fazer isso.', true)`.

## O que o Operador não vê no painel (dev-painel)

Helper já existente: `podeEquipe()` em `public/app.js:410` (`!usuario || papel === 'dono'`). Usar o mesmo critério para: item e rota Equipe (já feito), botão "Gerar novo token" (`public/conexoes.js:40`), botão "Desconectar" de Números de WhatsApp (`public/app.js:321`), botão "Apagar agora" dos Ajustes (`#limpar-agora`, `public/app.js:385`), campos de segredo das Conexões (já tratados por `segredos_salvos` ausente). No lugar do botão escondido, uma `.dica` curta: "Só o Dono pode fazer isso."

## Telas (dev-painel)

- **`public/login.html` / `public/login.js`:** campos E-mail (`type=email`, `autocomplete=username`, autofocus) e Senha; ao carregar, `GET /api/login/modo`: em `legado` esconde o campo de e-mail e troca o `.sub` para "Use a senha definida na instalação."; em `email`, `.sub` = "Seus achadinhos chegam primeiro." Erro único do servidor exibido como vem. Envia `{ email, senha }` (sem e-mail no legado).
- **`public/convite.html` / `public/convite.js`** (novos; `convite.js` carregado por `<script src>`, sem script inline por causa da CSP): mesmo layout de `login.html`. Lê o token de `location.hash.slice(1)` (64 hex; senão trata como inválido), chama `POST /api/convite/info`, mostra "Você foi convidado", "<conta_nome ou 'achadinhoturbo'> convidou você como <Dono|Operador>.", e-mail `readonly`, Nome, Senha (mín. 8, mostrar/ocultar com `aria-pressed`), Confirmar senha, botão "Criar minha conta" → `POST /api/convite/aceitar` → `location.replace('/')`. Inválido/vencido/usado/cancelado (410) ou token mal formado: card "Este convite não vale mais" + "Peça um novo link a quem convidou você.", sem formulário. Erros inline sob o campo (`.login-erro`, `role="alert"`).
- **`public/equipe.js`:** `paginaEquipe()` com três estados: (1) `auth:false` → só o card "Proteja o painel" (nome, e-mail, senha, confirmar; dica "Depois disso o painel pede login. Você continua conectado neste navegador."; botão "Ativar login") → `POST /api/equipe/ativar` → `atualizarEstado(true)` + toast "Login ativado" e a tela recarrega já como Dono; (2) Dono → spec F5: cards "Nome da conta" e "Convidar pessoa", tabela "Pessoas (N)" e "Convites pendentes (N)". **Desvio da spec** (decisão do dono: hash e link novo a cada cópia): a tabela de convites **não** tem input com o link; tem o botão "Copiar link" (`aria-label="Copiar link do convite de <email>"`) que chama `POST /api/equipe/convites/:id/link`, copia o link devolvido (`navigator.clipboard`, com fallback mostrando o link num input `readonly` selecionado) e avisa "Link do convite copiado. O link anterior deixou de funcionar."; e ao criar o convite o bloco de sucesso mostra o link em `.copia` + "Copiar link" com o texto "Mande este link para a pessoa. Ele só aparece completo agora; depois, 'Copiar link' na lista gera um link novo." (3) Operador nunca chega aqui (`rotaAtual` já desvia). `completarCadastro()`: diálogo real com Nome, E-mail e "Nova senha (opcional)" → `PUT /api/me` → `atualizarEstado()`; botão "Depois" fecha sem salvar.
- Textos novos em constantes no topo do arquivo (padrão `TEXTOS_EQUIPE`). Confirmações com `confirm()` nos textos da spec. Toasts da spec: "Convite cancelado", "Pessoa removida", "Papel alterado", "Nome da conta salvo", "Cadastro completo".
- **`public/ajuda.js`:** tirar "Esta tela vem na próxima entrega" / "Vem na próxima entrega" dos verbetes `equipe` e do cartão `equipe` (passos reais: criar convite, copiar link, mandar pelo WhatsApp, a pessoa cria a senha); verbete novo `equipe.ativar`: "Enquanto o painel não tem login, qualquer pessoa no seu computador abre tudo. Ative o login para criar a sua conta de Dono e convidar a equipe."
- **`public/style.css`:** só o necessário para as telas acima, reaproveitando `.login-caixa`, `.card`, `.tabela`, `.copia`, `.estado-pill`.

## Testes

- **dev-servidor:** `test/equipe.test.js` (novo) com servidor em porta aleatória como nos outros testes: migração com sessão aberta continua valendo e vira do Dono; modo legado → `PUT /api/me` → modo e-mail; e-mail desconhecido = 401 com a mesma mensagem e tempo comparável; `ativar` só com `auth` desligada e abre sessão; convite: criar → `info` → `aceitar` abre sessão com o papel do convite → segundo `aceitar` do mesmo token = 410; girar mata o link antigo; cancelar; vencido = 410; Operador recebe 403 em `/api/equipe`, `/api/ajustes/token`, `/api/wa/logout`, `/api/privacidade/limpar`, `PUT /api/conexoes/mercadolivre`; `GET /api/conexoes` sem `segredos_salvos` para Operador; último Dono e si mesmo protegidos; remover apaga sessões; nenhum e-mail no `log`. `test/seguranca.test.js` e `test/servidor.test.js` **não** podem ser editados e têm de continuar passando.
- **dev-painel:** `node --check` em cada arquivo, e conferência no painel de simulação depois que o dev-servidor terminar (o lead avisa) ou com o servidor atual (as rotas respondem 501 até lá: a tela precisa mostrar o erro do servidor sem quebrar).
