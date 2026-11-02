const $ = (id) => document.getElementById(id);

async function pintar() {
  const { conf = {}, st = {} } = await chrome.storage.local.get(['conf', 'st']);
  if (conf.servidor) $('servidor').value = conf.servidor;
  if (conf.token && !$('token').value) $('token').value = conf.token;
  $('estado').className = 'estado' + (st.ok ? ' ok' : '');
  $('msg').textContent = st.ok ? 'Conectado ao achadinhoturbo' : (st.erro || 'Desconectado');
  $('erro').textContent = st.ultimoErro ? 'Último erro ao gerar link: ' + st.ultimoErro : '';
}

$('salvar').addEventListener('click', async () => {
  await chrome.storage.local.set({ conf: { servidor: $('servidor').value.trim().replace(/\/+$/, ''), token: $('token').value.trim() } });
  $('msg').textContent = 'Conectando…';
  setTimeout(pintar, 1500);
});

chrome.storage.onChanged.addListener(pintar);
pintar();
