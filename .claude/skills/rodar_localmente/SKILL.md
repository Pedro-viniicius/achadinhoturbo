---
name: rodar_localmente
description: Liga ou reinicia o Achadinho Turbo no computador do dono (serviço systemd de usuário `achadinhoturbo`, porta 3737), confere que subiu com o código atual e entrega o endereço; também sobe o modo simulação (porta 3799) ou passa o comando para rodar no terminal. Use quando o dono pedir para rodar, ligar, reiniciar, subir ou testar localmente o Achadinho Turbo, ou depois de uma mudança no código que ele vai querer ver funcionando.
argument-hint: "[servico | simular | terminal]  (padrão: servico)"
---

# Rodar o Achadinho Turbo localmente

Projeto: `~/Documentos/achadinhoturbo` (Node 22, `src/server.js`). Responda sempre em português do Brasil.

O app roda como serviço de usuário do systemd `achadinhoturbo` (porta 3737, `node --watch-path=src`, ligado no login). Mudança em `src/` reinicia sozinha; mudança em `public/` só pede recarregar o painel (Ctrl+Shift+R).

Escolha o modo pelo argumento (`$ARGUMENTS`) ou pelo pedido. Sem argumento, use **servico**.

## Modo `servico` (padrão)

1. Reinicie e espere responder:
   ```bash
   systemctl --user restart achadinhoturbo
   curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null -w '%{http_code}\n' http://localhost:3737/login.html
   ```
   Esperado: `200`.
2. Confira que o processo novo está de pé e veja a linha de início (só ela; não despeje o journal inteiro, ele já guardou chaves do WhatsApp no passado):
   ```bash
   systemctl --user is-active achadinhoturbo
   journalctl --user -u achadinhoturbo --since "-2min" --no-pager | grep -E "rodando em|Error|erro" | grep -v privKey | tail -5
   ```
3. Se não deu `200` ou `active`: mostre ao dono só as últimas linhas de erro (filtradas como acima), diga o que falhou e não tente “consertar” mexendo em configuração do systemd sem pedir.
4. Responda curto: está no ar em **http://localhost:3737**, com o código atual; se a mudança foi em `public/`, lembre do Ctrl+Shift+R.

## Modo `simular` (dados de exemplo, sem WhatsApp, sem mexer nos dados reais)

Rode em segundo plano (Bash com `run_in_background: true`), na pasta do projeto:
```bash
cd ~/Documentos/achadinhoturbo && PORT=3799 npm run simular
```
Confira com `curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null -w '%{http_code}\n' http://localhost:3799/login.html` (esperado `200`) e entregue **http://localhost:3799**. Usa a pasta `data-simulacao/` (fora do git) e pode rodar junto com o serviço. Ao fim da sessão, ou quando o dono pedir, pare esse processo pelo PID (nunca `pkill -f` com padrão amplo: já derrubou o shell).

## Modo `terminal` (o dono quer ver a saída no terminal dele)

Não rode isto você mesmo (fica preso em primeiro plano). Passe ao dono:
```bash
systemctl --user stop achadinhoturbo
cd ~/Documentos/achadinhoturbo && npm start
# Ctrl+C para encerrar, depois:
systemctl --user start achadinhoturbo
```
E o atalho opcional, para criar uma vez:
```bash
echo "alias turbo='systemctl --user stop achadinhoturbo; cd ~/Documentos/achadinhoturbo && npm start; systemctl --user start achadinhoturbo'" >> ~/.bashrc && source ~/.bashrc
```

## Regras

- Nunca leia nem imprima `.env*`, `data/wa_auth/*`, tokens, `PANEL_PASSWORD` nem linhas de log com chaves (`privKey`).
- Não pare o serviço do dono para testar código; para isso use o modo `simular` ou `PORT=<livre> DATA_DIR=<pasta temporária> DRY_RUN=1`.
- Comandos com `sudo` não funcionam pelo `!` do Claude Code: peça para o dono rodar num terminal comum.
