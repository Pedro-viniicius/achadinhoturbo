// Troca a senha do painel e encerra todas as sessões.
// Uso: npm run senha            (pergunta a senha, sem mostrar na tela)
//      npm run senha -- "nova"  (passa direto; cuidado com o histórico do shell)
import readline from 'node:readline';
import { openDb } from '../src/db.js';
import { DATA_DIR } from '../src/config.js';
import { setPassword } from '../src/auth.js';

function perguntarOculto(msg) {
  return new Promise((ok) => {
    process.stdout.write(msg);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {}; // não ecoa o que é digitado
    rl.question('', (a) => { rl.close(); process.stdout.write('\n'); ok(a); });
  });
}

const senha = process.argv[2] ?? await perguntarOculto('Nova senha do painel (mín. 8 caracteres): ');
if (process.argv[2] == null) {
  const conf = await perguntarOculto('Repita a senha: ');
  if (conf !== senha) { console.error('As senhas não conferem.'); process.exit(1); }
}
const db = openDb(DATA_DIR);
try {
  setPassword(db, senha);
  console.log(`Senha trocada. Todas as sessões foram encerradas. (banco: ${DATA_DIR})`);
} catch (e) { console.error(e.message); process.exit(1); } finally { db.close(); }
