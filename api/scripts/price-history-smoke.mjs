// Isolated SQLite and agent stub: no real requests, calls or messages are sent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const Database = createRequire(import.meta.url)('better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'nexo-price-history-'));
const dbPath = join(dir, 'test.sqlite');
let db, child, captured, unavailable = false, logs = '';
const agent = createServer(async (req, res) => {
  assert.equal(req.url, '/price-timing/analyze');
  assert.equal(req.headers.authorization, 'Bearer internal-test');
  let raw = ''; for await (const chunk of req) raw += chunk;
  captured = JSON.parse(raw);
  res.setHeader('content-type','application/json');
  res.writeHead(unavailable ? 503 : 200).end(JSON.stringify(unavailable ? {} : { history: captured.history, analysis: {verdict: 'MONITOR'}, selected_price: captured.selected_price }));
});
await new Promise(resolve => agent.listen(0, '127.0.0.1', resolve));
const reserve = createServer(); await new Promise(resolve => reserve.listen(0,'127.0.0.1',resolve));
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
try {
  child = spawn(process.execPath, ['dist/main.js'], {stdio:['ignore','pipe','pipe'],env:{...process.env,
    PORT:String(port), DATABASE_PATH:dbPath, AGENT_URL:`http://127.0.0.1:${agent.address().port}`, INTERNAL_API_TOKEN:'internal-test',
    TELEGRAM_BOT_TOKEN:'',WHATSAPP_TEST_SUPPLIER_NUMBER:'',WHATSAPP_API_KEY:'',VAPI_API_KEY:''}});
  child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
  let ready = false;
  for (let i=0;i<100;i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try {if ((await fetch(`${base}/health`)).ok) {ready=true;break;}} catch {}
    await new Promise(resolve => setTimeout(resolve,50));
  }
  assert.ok(ready,'API startup');
  db = new Database(dbPath);
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT INTO requests(id,product,specs,qty,destination,status,created_at) VALUES(?,?,?,?,?,'concluida',?)");
  for (const [id,product,specs,qty] of [['current','Mouse','{}',1],['prior','Mouse','{}',1],['other','Keyboard','{}',1],['variant','Mouse','{"color":"red"}',1],['bulk','Mouse','{}',100]]) insert.run(id,product,specs,qty,'01001000',now);
  const quote = db.prepare('INSERT INTO quotes(id,request_id,event_id,supplier,unit_cents,created_at) VALUES(?,?,?,?,?,?)');
  for (const [id,request,price,day] of [['selected','current',9000,now],['latest','current',11000,now],['past','prior',10000,now],['excluded','other',1,now],['color','variant',2,now],['volume','bulk',3,now],['old','prior',4,'2020-01-01T00:00:00Z'],['future','prior',5,'2099-01-01T00:00:00Z']]) quote.run(id,request,id,'Loja',price,day);
  db.prepare("UPDATE requests SET decision='selected' WHERE id='current'").run();
  let r = await fetch(`${base}/procurement/current/price-history?days=30`);
  assert.equal(r.status,200); assert.equal((await r.json()).selected_price,'90.00');
  assert.equal(captured.price_source,'selected'); assert.equal(captured.days,30);
  assert.equal(captured.history.length,3);
  assert.deepEqual(captured.history.map(p=>p.price).sort(),['100.00','110.00','90.00']);
  db.prepare("UPDATE requests SET preferred_market_quote_id='latest' WHERE id='current'").run();
  await fetch(`${base}/procurement/current/price-history`);
  assert.equal(captured.selected_price,'110.00'); assert.equal(captured.days,60);
  assert.equal((await fetch(`${base}/procurement/missing/price-history`)).status,404);
  assert.equal((await fetch(`${base}/procurement/current/price-history?days=7`)).status,400);
  unavailable=true;
  assert.equal((await fetch(`${base}/procurement/current/price-history`)).status,503);
  console.log('Price history API: selection precedence, exact-item filtering, date windows, auth, 400/404/503 passed.');
} finally {
  db?.close();
  if (child && child.exitCode === null) {const stopped = new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}
  await new Promise(resolve=>agent.close(resolve)); rmSync(dir,{recursive:true,force:true});
}
