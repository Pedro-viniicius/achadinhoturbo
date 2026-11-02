// Tela de login (arquivo próprio para a política de segurança de conteúdo não permitir script inline).
const $ = (s) => document.querySelector(s);
// Já logado? Vai direto para o painel.
fetch('/api/state').then((r) => { if (r.ok) location.replace('/'); }).catch(() => {});
$('#f').onsubmit = async (ev) => {
  ev.preventDefault();
  const b = $('#entrar'); const e = $('#erro'); b.disabled = true; e.hidden = true;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ senha: $('#senha').value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Não foi possível entrar (' + r.status + ')');
    location.replace('/');
  } catch (err) {
    e.textContent = err.message; e.hidden = false; $('#senha').select();
  } finally { b.disabled = false; }
};
