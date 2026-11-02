import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const PORT = Number(process.env.PORT || 3737);
// Modo simulação: não conecta no WhatsApp de verdade, só registra o que enviaria.
export const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--simular');
// Zera as pausas entre mensagens (usado nos testes).
export const FAST = process.env.FAST === '1';
// Domínio público quando o painel roda atrás de um proxy HTTPS (ex.: disparador.meudominio.com).
// Sem ele, o painel só aceita localhost/127.0.0.1.
export const PUBLIC_HOST = String(process.env.PUBLIC_HOST || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
// Senha do painel: vira hash no banco no primeiro start. Para trocar depois: npm run senha.
export const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
// Fuso horário: o Node lê a variável TZ sozinho (ex.: TZ=America/Sao_Paulo). O agendador usa a hora local.
