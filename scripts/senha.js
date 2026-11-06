// Troca a senha do Dono (o mais antigo da Equipe; sem ninguém cadastrado, cria o Dono, que entra só com a senha
// até completar o cadastro) e encerra todas as sessões. Serve também para recuperar o acesso.
// Uso: npm run senha            (pergunta a senha, sem mostrar na tela)
//      npm run senha -- "nova"  (passa direto; cuidado com o histórico do shell)
import readline from 'node:readline';
import { openDb } from '../src/db.js';
import { DATA_DIR } from '../src/config.js';
import { setPassword } from '../src/auth.js';

/**
 * Pergunta sem ecoar o que é digitado. O readline em modo terminal redesenha a linha a cada tecla (volta ao início,
 * escreve pergunta + resposta e limpa o resto), e esse redesenho passa por `_writeToOutput`: aqui ele só volta a
 * escrever a pergunta, nunca a resposta. Se a entrada acabar sem resposta (sem terminal interativo, Ctrl+D ou
 * Ctrl+C), rejeita em vez de deixar o programa sair com "unsettled top-level await".
 */
function perguntarOculto(msg) {
  return new Promise((ok, falha) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.startsWith(msg)) rl.output.write(msg); };
    let respondeu = false; let cancelado = false;
    rl.question(msg, (a) => { respondeu = true; rl.close(); process.stdout.write('\n'); ok(a); });
    rl.on('SIGINT', () => { cancelado = true; rl.close(); }); // Ctrl+C
    rl.on('close', () => {
      if (respondeu) return;
      process.stdout.write('\n');
      falha(new Error(cancelado ? 'Cancelado.' : 'Nenhuma senha informada. Rode num terminal interativo ou passe a senha: npm run senha -- "nova"'));
    });
  });
}

let senha;
try {
  senha = process.argv[2] ?? await perguntarOculto('Nova senha do Dono (mín. 8 caracteres): ');
  if (process.argv[2] == null) {
    const conf = await perguntarOculto('Repita a senha: ');
    if (conf !== senha) { console.error('As senhas não conferem.'); process.exit(1); }
  }
} catch (e) { console.error(e.message); process.exit(1); }
const db = openDb(DATA_DIR);
try {
  setPassword(db, senha);
  console.log(`Senha do Dono trocada. Todas as sessões foram encerradas. (banco: ${DATA_DIR})`);
} catch (e) { console.error(e.message); process.exit(1); } finally { db.close(); }
