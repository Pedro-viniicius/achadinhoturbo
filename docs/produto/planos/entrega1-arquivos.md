# Entrega 1 — arquivos alterados (para qa, revisor, designer, seguranca)

Linha de base antes da mudança: 49 testes (commit `45ff590`). Agora: 113 testes, 0 falhas. Serviço local ativo.

## Modificados
CLAUDE.md, README.md, public/ajuda.js, public/app.js, public/index.html, public/paineis.js, public/style.css,
src/analytics.js, src/db.js, src/scheduler.js, src/server.js, src/whatsapp.js, test/analise.test.js

## Novos
src/lojas.js, src/envios.js, src/avisos.js, src/conexoes.js, src/equipe.js (stub 501, entrega 2)
public/disparos.js, public/relatorios.js, public/conexoes.js, public/equipe.js (stub "Em construção")
test/base.test.js, test/lojas.test.js, test/whatsapp.test.js, test/envios.test.js, test/conexoes.test.js, test/avisos.test.js
docs/produto/briefs/disparos-comunicacao-conta.md, docs/produto/planos/disparos-comunicacao-conta.md, docs/produto/specs/disparos-comunicacao-conta.md

## Fora desta entrega
Etapas 7 e 12 (Equipe/autenticação por usuário): `src/auth.js`, `public/login.*`, `public/convite.*` não mudaram. `req.user` é null; `soDono` deixa passar.

## Riscos aceitos pelo dono (não voltam como achado)
- `apagarParticipante` por número não alcança registros gravados por LID.
- Em CGNAT, clique deduplicado por IP/hora em `/g/<slug>` pode subcontar.
- Decisões do dono em 02/11/2026: convite como hash; Operador sem Equipe nem ações destrutivas (entrega 2); prévia de link só Mercado Livre; agendado atrasado >2 h vira erro; Equipe na entrega 2.
