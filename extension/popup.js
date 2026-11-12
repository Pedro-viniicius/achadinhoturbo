const $ = (id) => document.getElementById(id);
// só troca o texto que mudou (achado D9): as linhas ficam em role="status" e o leitor de tela as releria a cada mudança
// do storage, mesmo com o mesmo texto
const texto = (el, t) => { if (el.textContent !== t) el.textContent = t; };

async function pintar() {
  const { conf = {}, st = {} } = await chrome.storage.local.get(['conf', 'st']);
  if (conf.servidor) $('servidor').value = conf.servidor;
  if (conf.token && !$('token').value) $('token').value = conf.token;
  $('linhaExtensao').className = 'linha' + (st.ok ? ' ok' : '');
  texto($('msg'), st.ok ? 'Conectado ao achadinhoturbo' : (st.erro || 'Desconectado'));
  // Central de Afiliados: o resultado do último pedido que passou por ela (o background.js grava st.central), só com
  // a extensão conectada ao painel; antes do primeiro pedido, a linha não aparece
  const central = st.ok && (st.central === 'respondendo' || st.central === 'sem_resposta') ? st.central : null;
  $('linhaCentral').hidden = !central;
  $('linhaCentral').className = 'linha' + (central === 'respondendo' ? ' ok' : '');
  texto($('msgCentral'), central ? `Central de Afiliados: ${central === 'respondendo' ? 'respondendo' : 'sem resposta'}` : '');
  texto($('erro'), st.ultimoErro ? 'Último erro ao gerar link: ' + st.ultimoErro : '');
}

try { $('versao').textContent = `Versão ${chrome.runtime.getManifest().version}`; } catch { /* sem manifest: sem rodapé */ }

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
$('salvar').addEventListener('click', async () => {
  const servidor = $('servidor').value.trim().replace(/\/+$/, '');
  let u; try { u = new URL(servidor); } catch { $('msg').textContent = 'Endereço inválido. Use http://127.0.0.1:3737 ou https://seu-dominio.'; return; }
  if (!/^https?:$/.test(u.protocol) || (u.protocol === 'http:' && !LOOPBACK.test(u.hostname))) { $('msg').textContent = 'Fora do seu computador o endereço precisa ser https://, senão o token viaja em claro.'; return; }
  if (!LOOPBACK.test(u.hostname)) {
    // pede acesso só ao domínio do seu painel, na hora, em vez de a toda a internet
    const ok = await chrome.permissions.request({ origins: [`${u.origin}/*`] }).catch(() => false);
    if (!ok) { $('msg').textContent = 'Sem permissão para esse endereço. Autorize quando o Chrome perguntar.'; return; }
  }
  const { conf: antes = {} } = await chrome.storage.local.get('conf');
  if (antes.servidor && antes.servidor !== servidor && !confirm(`Trocar o painel de ${antes.servidor} para ${servidor}? A extensão vai usar a sua sessão do Mercado Livre a pedido desse endereço.`)) return;
  await chrome.storage.local.set({ conf: { servidor, token: $('token').value.trim() } });
  $('msg').textContent = 'Conectando…';
  setTimeout(pintar, 1500);
});

chrome.storage.onChanged.addListener(pintar);
pintar();
