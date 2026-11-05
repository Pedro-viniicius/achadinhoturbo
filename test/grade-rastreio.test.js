import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const { openDb } = await import('../src/db.js');
const { createScheduler } = await import('../src/scheduler.js');
const { createLinkService } = await import('../src/links.js');
const { createWhatsApp } = await import('../src/whatsapp.js');
const { salvar } = await import('../src/rastreio.js');
const dia = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
// Junção grade de disparos + rastreio por grupo (revisor, R1 da revisão do merge): os dois lados no mesmo runRule
test('grade + rastreio por grupo: o horário usa a qtd e o template da linha e cada grupo recebe o link do seu código', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-')); const db = openDb(dir); t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const wa = createWhatsApp({ db, dir, dryRun: true }); wa.connect();
  const links = createLinkService({ getMode: () => 'fake' });
  const scheduler = createScheduler({ db, wa, links, fast: true });
  const now = Date.now();
  for (const [jid, nome] of [['111@g.us', 'A'], ['222@g.us', 'B'], ['333@g.us', 'C']]) db.prepare('INSERT INTO groups (jid, name, size, updated_at) VALUES (?,?,?,?)').run(jid, nome, 10, now);
  for (const n of ['etiquetaA', 'etiquetaB', 'etiquetaC']) db.prepare('INSERT INTO tags (name, created_at) VALUES (?,?)').run(n, now);
  const tpl2 = Number(db.prepare('INSERT INTO templates (name, body, created_at) VALUES (?,?,?)').run('T2', 'LINHA {TITULO_PRODUTO}\n{LINK}', now).lastInsertRowid);
  salvar(db, { loja: 'mercadolivre', alvo_tipo: 'grupo', alvo: '222@g.us', codigo: 'etiquetaB' });
  const bid = Number(db.prepare('INSERT INTO blocks (name, created_at) VALUES (?,?)').run('Bl', now).lastInsertRowid); db.prepare('INSERT INTO block_groups (block_id, jid) VALUES (?,?)').run(bid, '333@g.us');
  salvar(db, { loja: 'mercadolivre', alvo_tipo: 'bloco', alvo: String(bid), codigo: 'etiquetaC' });
  const items = ['https://produto.mercadolivre.com.br/MLB-1000001-a | Fone A | 50 | 100', 'https://produto.mercadolivre.com.br/MLB-1000002-b | Mouse B | 30 | 40', 'https://produto.mercadolivre.com.br/MLB-1000003-c | Teclado C | 200 | 400'].join('\n');
  const id = Number(db.prepare(`INSERT INTO rules (name, enabled, tag_id, template_id, group_jids, source_type, source_config, per_run, interval_min, window_start, window_end, dedupe_days, send_image, created_at)
    VALUES ('G', 1, 1, 1, ?, 'list', ?, 3, 60, '08:00', '22:00', 7, 1, ?)`).run(JSON.stringify(['111@g.us', '222@g.us', '333@g.us']), JSON.stringify({ items }), now).lastInsertRowid);
  const grade = { dias: [0,1,2,3,4,5,6], horarios: [{ hora: '10:00', qtd: 2, template_id: tpl2 }, { hora: '23:00', qtd: 1, template_id: null }] };
  db.prepare('UPDATE rules SET grade = ?, next_run_at = ? WHERE id = ?').run(JSON.stringify(grade), dia(2, 10, 0), id);
  t.mock.timers.enable({ apis: ['Date'], now: dia(2, 10, 5) });
  await scheduler.tick();
  const rows = db.prepare('SELECT jid, codigo, nivel, bloco_id, esperado, origem, rule_id FROM rastreio_envios ORDER BY id').all().map((r) => ({ ...r }));
  assert.equal(wa.simulated.length, 6, 'qtd da linha (2) x 3 grupos');
  assert.ok(wa.simulated.every((m) => m.text.startsWith('LINHA ')), 'template da linha');
  assert.deepEqual(rows.map((r) => [r.jid, r.codigo, r.nivel, r.esperado, r.origem]), [
    ['111@g.us', 'etiquetaA', 'padrao', 0, 'regra'], ['222@g.us', 'etiquetaB', 'grupo', 1, 'regra'], ['333@g.us', 'etiquetaC', 'bloco', 1, 'regra'],
    ['111@g.us', 'etiquetaA', 'padrao', 0, 'regra'], ['222@g.us', 'etiquetaB', 'grupo', 1, 'regra'], ['333@g.us', 'etiquetaC', 'bloco', 1, 'regra'],
  ]);
  assert.equal(db.prepare('SELECT next_run_at FROM rules WHERE id = ?').get(id).next_run_at, dia(2, 23, 0));
  // Enviar agora: usa a linha do próximo (23:00, qtd 1, template da regra), grava rastreio e não mexe em next_run_at
  const antes = wa.simulated.length;
  await scheduler.runRule(id, { manual: true });
  assert.equal(wa.simulated.length - antes, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rastreio_envios').get().n, 9);
  assert.equal(db.prepare('SELECT next_run_at FROM rules WHERE id = ?').get(id).next_run_at, dia(2, 23, 0));
});
