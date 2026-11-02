import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const PORT = Number(process.env.PORT || 3737);
// Modo simulação: não conecta no WhatsApp de verdade, só registra o que enviaria.
export const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--simular');
// Zera as pausas entre mensagens (usado nos testes).
export const FAST = process.env.FAST === '1';
