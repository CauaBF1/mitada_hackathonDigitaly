import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the installed receive dispatcher, without a socket, credentials or real messages.
const source = readFileSync('./node_modules/baileys/lib/Socket/messages-recv.js', 'utf8');
const start = source.indexOf('    const processNode = ');
const end = source.indexOf('\n    // recv a message', start);
assert.ok(start >= 0 && end > start, 'Baileys receive dispatcher must be recognizable');
const routed = [];
const processNode = Function('offlineNodeProcessor', 'processNodeWithBuffer', 'shouldIgnoreJid',
  'sendMessageAck', 'S_WHATSAPP_NET', 'NACK_REASONS', `${source.slice(start, end)}; return processNode;`)(
  { enqueue: () => routed.push('queued') }, async () => routed.push('live'),
  jid => jid.endsWith('@g.us'), async () => routed.push('ignored'), 's.whatsapp.net', { UnhandledError: 500 });
for (const [offline, expected] of [['0', 'live'], ['1', 'queued'], [undefined, 'live']]) {
  await processNode('message', { attrs: { offline, from: 'test@s.whatsapp.net' } }, 'test', () => {});
  assert.equal(routed.at(-1), expected);
}
await processNode('message', { attrs: { offline: '0', from: 'test@g.us' } }, 'test', () => {});
assert.equal(routed.at(-1), 'ignored', 'Ignore rules must run before routing');
const modeExpression = source.match(/await upsertMessage\(msg, ([^;]+)\);/);
assert.ok(modeExpression, 'Message upsert mode must be recognizable');
const mode = Function('node', `return ${modeExpression[1]};`);
assert.equal(mode({ attrs: { offline: '0' } }), 'notify');
assert.equal(mode({ attrs: { offline: '1' } }), 'append');
assert.equal(mode({ attrs: {} }), 'notify');
console.log('PASS receiving compatibility: offline=0 and live messages notify, offline=1 queued, ignored JIDs preserved');
