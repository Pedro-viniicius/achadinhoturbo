// Tela de login (arquivo próprio para a política de segurança de conteúdo não permitir script inline).
// Dois modos (GET /api/login/modo): "email" (e-mail + senha) e "legado" (há o Dono migrado ainda sem e-mail: o e-mail
// fica opcional; em branco, ele entra só com a senha da instalação e depois o painel pede "Complete seu cadastro";
// preenchido, entra quem já tem conta com e-mail, como quem chegou por convite).
const TEXTOS_LOGIN = {
  subEmail: 'Seus achadinhos chegam primeiro.',
  subLegado: 'Use a senha definida na instalação.',
  rotuloEmail: 'E-mail', rotuloEmailLegado: 'E-mail (opcional)',
  dicaEmailLegado: 'Quem entrou por convite usa o próprio e-mail. Deixe em branco se você usa a senha da instalação.',
  faltaEmail: 'Digite o seu e-mail.',
  faltaSenha: 'Digite a senha.',
  entrar: 'Entrar', entrando: 'Entrando…',
  semConexao: 'Não consegui falar com o painel. Confira se o programa está aberto e tente de novo.',
  falhou: (status) => `Não foi possível entrar (${status}).`,
};
const $ = (s) => document.querySelector(s);
let legado = false;

// Já logado? Vai direto para o painel.
fetch('/api/state').then((r) => { if (r.ok) location.replace('/'); }).catch(() => {});

/** Legado: o e-mail fica opcional (com a dica do porquê) e o foco vai para a senha. */
function aplicarModo(modo) {
  legado = modo === 'legado';
  const email = $('#email'); const dica = $('#dica-email');
  email.required = !legado;
  $('#rotulo-email').textContent = legado ? TEXTOS_LOGIN.rotuloEmailLegado : TEXTOS_LOGIN.rotuloEmail;
  dica.textContent = legado ? TEXTOS_LOGIN.dicaEmailLegado : ''; dica.hidden = !legado;
  email.setAttribute('aria-describedby', legado ? 'dica-email erro' : 'erro');
  $('#sub').textContent = legado ? TEXTOS_LOGIN.subLegado : TEXTOS_LOGIN.subEmail;
  if (legado && (document.activeElement === $('#email') || document.activeElement === document.body)) $('#senha').focus();
}
// Sem resposta do servidor (versão antiga, sem a rota), fica o legado: a versão antiga entra só com a senha e ignora o e-mail.
fetch('/api/login/modo')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then((j) => aplicarModo(j?.modo === 'legado' ? 'legado' : 'email'))
  .catch(() => aplicarModo('legado'));

/** Erro único sob os campos (role="alert"). `campo` só quando o problema é deste lado (campo vazio). */
function mostrarErro(msg, campo) {
  const e = $('#erro'); e.textContent = msg; e.hidden = false;
  if (campo) { campo.setAttribute('aria-invalid', 'true'); campo.focus(); }
}
function limparErro() {
  $('#erro').hidden = true; $('#erro').textContent = '';
  for (const c of [$('#email'), $('#senha')]) c.removeAttribute('aria-invalid');
}

$('#f').onsubmit = async (ev) => {
  ev.preventDefault();
  limparErro();
  const email = $('#email').value.trim(); const senha = $('#senha').value;
  if (!legado && !email) return mostrarErro(TEXTOS_LOGIN.faltaEmail, $('#email'));
  if (!senha) return mostrarErro(TEXTOS_LOGIN.faltaSenha, $('#senha'));
  const b = $('#entrar'); b.disabled = true; b.textContent = TEXTOS_LOGIN.entrando;
  try {
    let r;
    try {
      r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(legado && !email ? { senha } : { email, senha }) });
    } catch { throw new Error(TEXTOS_LOGIN.semConexao); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || TEXTOS_LOGIN.falhou(r.status)); // a mensagem do servidor é única e vai como vem
    location.replace('/');
  } catch (err) {
    mostrarErro(err.message); $('#senha').select();
  } finally { b.disabled = false; b.textContent = TEXTOS_LOGIN.entrar; }
};
// Corrigiu o campo: some o destaque de erro.
for (const c of ['#email', '#senha']) $(c).oninput = () => $(c).removeAttribute('aria-invalid');
