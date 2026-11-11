import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Modo simulação (`npm run simular`, `--simular` ou `DRY_RUN=1`): não conecta no WhatsApp de verdade, só registra o que enviaria. */
export function modoSimulacao({ env = process.env, argv = process.argv } = {}) {
  return env.DRY_RUN === '1' || argv.includes('--simular');
}
/**
 * Pasta dos dados. `DATA_DIR` explícito vale sempre. Sem ele, o serviço normal usa `data/` e a simulação usa
 * `data-simulacao/`, separada: o agendador roda de verdade na simulação (encerra agendados vencidos, marca o resumo
 * do dia e as ofertas como enviadas com links falsos) e não pode mexer no banco nem na sessão do WhatsApp do dono.
 */
export function pastaDeDados({ env = process.env, argv = process.argv, raiz = ROOT } = {}) {
  if (env.DATA_DIR) return env.DATA_DIR;
  return path.join(raiz, modoSimulacao({ env, argv }) ? 'data-simulacao' : 'data');
}
export const DRY_RUN = modoSimulacao();
export const DATA_DIR = pastaDeDados();
export const PORT = Number(process.env.PORT || 3737);
// Zera as pausas entre mensagens (usado nos testes).
export const FAST = process.env.FAST === '1';
// Domínio público quando o painel roda atrás de um proxy HTTPS (ex.: disparador.meudominio.com).
// Sem ele, o painel só aceita localhost/127.0.0.1.
export const PUBLIC_HOST = String(process.env.PUBLIC_HOST || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
// Senha do painel: vira hash no banco no primeiro start. Para trocar depois: npm run senha.
export const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
// LOGIN_SEM_LIMITE=1 desliga o bloqueio por tentativas erradas de login. Só vale sem PUBLIC_HOST (painel só local).
export const LOGIN_SEM_LIMITE = process.env.LOGIN_SEM_LIMITE === '1';
// Fuso horário: o Node lê a variável TZ sozinho (ex.: TZ=America/Sao_Paulo). O agendador usa a hora local.
