// Equipe (plano disparos-comunicacao-conta, F5): pessoas, papéis (dono|operador) e convites.
// O centro (usuários, sessões, convites, soDono) fica em src/auth.js. E-mails são dado pessoal: nunca em log.
//
// Etapa 5: só as rotas com login, respondendo 501. A etapa 7 preenche /api/me; a etapa 12, /api/equipe/*.

const naoImplementado = (req, res) => res.status(501).json({ erro: 'ainda não implementado' });

/**
 * Rotas de F5 que exigem login, montadas por buildApp depois do middleware de sessão e da checagem Host/Origin.
 * ctx = { db, wa, links, scheduler, auth, wrap, soDono, dataDir, ml, enderecoPublico }.
 * As públicas (GET /api/login/modo, POST /api/convite/info, POST /api/convite/aceitar) não cabem aqui, porque
 * isto roda depois do login: a etapa 7 as monta antes do middleware de sessão (ou em PUBLIC_PATHS), com limiter próprio.
 */
export function montarRotas(app, ctx) {
  const { soDono } = ctx;
  app.put('/api/me', naoImplementado);                                 // etapa 7: completar cadastro (nome + e-mail)
  // etapa 12 preenche; soDono em tudo de /api/equipe
  app.get('/api/equipe', soDono, naoImplementado);
  app.put('/api/equipe/conta', soDono, naoImplementado);               // nome da conta (setting conta_nome)
  app.post('/api/equipe/convites', soDono, naoImplementado);           // → { link } (o único momento em que o link aparece)
  app.post('/api/equipe/convites/:id/link', soDono, naoImplementado);  // gira o token: o link antigo morre
  app.delete('/api/equipe/convites/:id', soDono, naoImplementado);
  app.put('/api/equipe/pessoas/:id', soDono, naoImplementado);         // papel
  app.delete('/api/equipe/pessoas/:id', soDono, naoImplementado);      // apaga as sessões da pessoa
}
