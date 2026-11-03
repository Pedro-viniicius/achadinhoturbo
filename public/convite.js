// Aceite de convite (/convite.html#<token>, pública). Arquivo próprio: a CSP não permite script inline.
// O token (64 hex) vem no fragmento da URL, que o navegador nunca manda ao servidor nem em Referer; aqui ele só vai
// no corpo de POST /api/convite/info e /api/convite/aceitar. Convite inválido, vencido, usado ou cancelado tem uma
// mensagem só (410), sem dizer qual. Spec: docs/produto/specs/disparos-comunicacao-conta.md ("Tela de aceite").
const TEXTOS_CONVITE = {
  quem: (conta, papel) => `${conta || 'achadinhoturbo'} convidou você como ${papel === 'dono' ? 'Dono' : 'Operador'}.`,
  faltaNome: 'Escreva o seu nome.',
  senhaCurta: 'A senha precisa de ao menos 8 caracteres.',
  senhasDiferentes: 'As senhas não são iguais.',
  criar: 'Criar minha conta', criando: 'Criando…',
  semConexao: 'Não consegui falar com o painel. Confira se o endereço está certo e tente de novo.',
  falhou: (status) => `O painel respondeu com erro (${status}).`,
};
const SENHA_MIN = 8;
const $ = (s) => document.querySelector(s);
const token = location.hash.slice(1);
const tokenValido = /^[0-9a-f]{64}$/i.test(token);

/** Mostra só um dos blocos: carregando, f (formulário), invalido ou falha. */
function mostrar(id) {
  for (const b of ['carregando', 'f', 'invalido', 'falha']) $('#' + b).hidden = b !== id;
}
function falha(msg) {
  mostrar('falha'); $('#falha-msg').textContent = msg; $('#de-novo').focus();
}

/** POST com corpo JSON → { status, j }. Erro de rede vira Error com texto em português. */
async function postar(caminho, corpo) {
  let r;
  try { r = await fetch(caminho, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) }); } catch { throw new Error(TEXTOS_CONVITE.semConexao); }
  return { status: r.status, ok: r.ok, j: await r.json().catch(() => ({})) };
}

async function conferir() {
  if (!tokenValido) { mostrar('invalido'); return; }
  mostrar('carregando');
  let res;
  try { res = await postar('/api/convite/info', { token }); } catch (e) { falha(e.message); return; }
  if (res.status === 410) { mostrar('invalido'); return; }
  if (!res.ok) { falha(res.j.erro || TEXTOS_CONVITE.falhou(res.status)); return; }
  $('#quem').textContent = TEXTOS_CONVITE.quem(res.j.conta_nome, res.j.papel);
  $('#email').value = res.j.email || '';
  mostrar('f'); $('#nome').focus();
}

// ---------- erros inline sob cada campo ----------
const ERROS = { nome: '#erro-nome', senha: '#erro-senha', confirma: '#erro-confirma', geral: '#erro' };
function limparErros() {
  for (const sel of Object.values(ERROS)) { $(sel).hidden = true; $(sel).textContent = ''; }
  for (const c of ['#nome', '#senha', '#confirma']) $(c).removeAttribute('aria-invalid');
}
function erroNoCampo(campo, msg) {
  const p = $(ERROS[campo]); p.textContent = msg; p.hidden = false;
  if (campo !== 'geral') $('#' + campo).setAttribute('aria-invalid', 'true');
}

// Mostrar/ocultar vale para os dois campos de senha; o rótulo fica e o estado vai em aria-pressed.
$('#ver-senha').onclick = () => {
  const b = $('#ver-senha'); const ver = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(ver)); b.classList.toggle('on', ver);
  for (const c of ['#senha', '#confirma']) $(c).type = ver ? 'text' : 'password';
};
for (const c of ['nome', 'senha', 'confirma']) $('#' + c).oninput = () => { $('#' + c).removeAttribute('aria-invalid'); $(ERROS[c]).hidden = true; };

$('#f').onsubmit = async (ev) => {
  ev.preventDefault();
  limparErros();
  const nome = $('#nome').value.trim(); const senha = $('#senha').value; const confirma = $('#confirma').value;
  const erros = [];
  if (!nome) erros.push(['nome', TEXTOS_CONVITE.faltaNome]);
  if (senha.length < SENHA_MIN) erros.push(['senha', TEXTOS_CONVITE.senhaCurta]);
  else if (senha !== confirma) erros.push(['confirma', TEXTOS_CONVITE.senhasDiferentes]);
  if (erros.length) { erros.forEach(([c, m]) => erroNoCampo(c, m)); $('#' + erros[0][0]).focus(); return; }

  const b = $('#criar'); b.disabled = true; b.textContent = TEXTOS_CONVITE.criando; $('#f').setAttribute('aria-busy', 'true');
  try {
    const res = await postar('/api/convite/aceitar', { token, nome, senha });
    if (res.status === 410) { mostrar('invalido'); return; }
    if (!res.ok) { erroNoCampo('geral', res.j.erro || TEXTOS_CONVITE.falhou(res.status)); return; }
    location.replace('/'); // a sessão já veio no cookie da resposta
  } catch (e) {
    erroNoCampo('geral', e.message);
  } finally { b.disabled = false; b.textContent = TEXTOS_CONVITE.criar; $('#f').removeAttribute('aria-busy'); }
};
$('#de-novo').onclick = conferir;
// Outro link colado na mesma aba: o token mudou, então confere de novo.
addEventListener('hashchange', () => location.reload());
conferir();
