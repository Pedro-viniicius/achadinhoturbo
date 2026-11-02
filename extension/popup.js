const $ = (id) => document.getElementById(id);

async function pintar() {
  const { conf = {}, st = {} } = await chrome.storage.local.get(['conf', 'st']);
  if (conf.servidor) $('servidor').value = conf.servidor;
  if (conf.token && !$('token').value) $('token').value = conf.token;
  $('estado').className = 'estado' + (st.ok ? ' ok' : '');
  $('msg').textContent = st.ok ? 'Conectado ao achadinhoturbo' : (st.erro || 'Desconectado');
  $('erro').textContent = st.ultimoErro ? 'Último erro ao gerar link: ' + st.ultimoErro : '';
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
$('salvar').addEventListener('click', async () => {
  const servidor = $('servidor').value.trim().replace(/\/+$/, '');
  let u; try { u = new URL(servidor); } catch { $('msg').textContent = 'Endereço inválido. Use http://127.0.0.1:3737 ou https://seu-dominio.'; return; }
  if (!/^https?:$/.test(u.protocol) || (u.protocol === 'http:' && !LOOPBACK.test(u.hostname))) { $('msg').textContent = 'Fora do seu computador o endereço precisa ser https://, senão o token viaja em claro.'; return; }
  const { conf: antes = {} } = await chrome.storage.local.get('conf');
  if (antes.servidor && antes.servidor !== servidor && !confirm(`Trocar o painel de ${antes.servidor} para ${servidor}? A extensão vai usar a sua sessão do Mercado Livre a pedido desse endereço.`)) return;
  await chrome.storage.local.set({ conf: { servidor, token: $('token').value.trim() } });
  $('msg').textContent = 'Conectando…';
  setTimeout(pintar, 1500);
});

chrome.storage.onChanged.addListener(pintar);
pintar();
