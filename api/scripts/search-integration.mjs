import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assert.equal(process.versions.node.split('.')[0], '22', `Run this test with Node 22; found ${process.versions.node}`);

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

const state = { calls: [] };
const agent = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  state.calls.push({ method: req.method, authorization: req.headers.authorization, origin: req.headers.origin, settings: req.headers['x-nexo-settings'], body });
  res.setHeader('content-type', 'application/json');
  if (body.includes('upstream-error')) {
    res.statusCode = 422;
    res.end(JSON.stringify({ detail: 'Falha simulada', api_key: 'tvly-secret-response', token: 'private-token' }));
    return;
  }
  res.end(JSON.stringify({ configured: req.method === 'POST', active_provider: 'tavily', verified: true, api_key: 'tvly-secret-response', token: 'private-token' }));
});

const work = await mkdtemp(join(tmpdir(), 'nexo-search-integration-'));
const apiPort = await freePort();
const agentPort = await freePort();
const origin = 'http://127.0.0.1:3000';
let api;
let apiOutput = '';
try {
  await new Promise((resolve, reject) => agent.listen(agentPort, '127.0.0.1', resolve).once('error', reject));
  api = spawn(process.execPath, ['dist/main.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(apiPort), HOST: '127.0.0.1', DATABASE_PATH: join(work, 'test.sqlite'), AGENT_URL: `http://127.0.0.1:${agentPort}`, INTERNAL_API_TOKEN: 'test-only-internal-token', CORS_ORIGINS: origin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout.on('data', chunk => { apiOutput += chunk; });
  api.stderr.on('data', chunk => { apiOutput += chunk; });
  const base = `http://127.0.0.1:${apiPort}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `Nest API should start: ${apiOutput.slice(-1500)}`);

  const get = await fetch(`${base}/integrations/search`);
  assert.equal(get.status, 200);
  const getBody = await get.json();
  assert.equal(getBody.active_provider, 'tavily');
  assert.equal('api_key' in getBody, false);
  assert.equal('token' in getBody, false);
  assert.equal(state.calls[0].authorization, 'Bearer test-only-internal-token');
  assert.equal(state.calls[0].method, 'GET');

  const credential = 'tvly-fake-test-credential-never-real';
  const connected = await fetch(`${base}/integrations/search`, { method: 'POST', headers: { Origin: origin, 'X-Nexo-Settings': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: credential }) });
  assert.equal(connected.status, 200);
  const connectedBody = await connected.json();
  assert.equal(connectedBody.configured, true);
  assert.equal('api_key' in connectedBody, false);
  assert.equal('token' in connectedBody, false);
  const postCall = state.calls[1];
  assert.equal(postCall.origin, origin);
  assert.equal(postCall.settings, '1');
  assert.equal(postCall.authorization, 'Bearer test-only-internal-token');
  assert.deepEqual(JSON.parse(postCall.body), { api_key: credential });

  const count = state.calls.length;
  for (const headers of [{}, { Origin: origin }, { Origin: 'https://attacker.invalid', 'X-Nexo-Settings': '1' }]) {
    const rejected = await fetch(`${base}/integrations/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ api_key: 'tvly-fake' }) });
    assert.equal(rejected.status, 400);
  }
  assert.equal(state.calls.length, count, 'invalid POSTs must be rejected before the Python service');

  const upstreamError = await fetch(`${base}/integrations/search`, { method: 'POST', headers: { Origin: origin, 'X-Nexo-Settings': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: 'upstream-error' }) });
  assert.equal(upstreamError.status, 422);
  const errorBody = await upstreamError.text();
  assert.match(errorBody, /Falha simulada/);
  assert.doesNotMatch(errorBody, /tvly-secret|private-token/);

  const invalid = createServer((req, res) => { res.statusCode = 200; res.end('not-json'); });
  await new Promise((resolve, reject) => invalid.listen(0, '127.0.0.1', resolve).once('error', reject));
  const invalidPort = invalid.address().port;
  const invalidApiPort = await freePort();
  api.kill('SIGTERM');
  await new Promise(resolve => api.once('exit', resolve));
  api = spawn(process.execPath, ['dist/main.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(invalidApiPort), HOST: '127.0.0.1', DATABASE_PATH: join(work, 'invalid.sqlite'), AGENT_URL: `http://127.0.0.1:${invalidPort}`, INTERNAL_API_TOKEN: 'test-only-internal-token', CORS_ORIGINS: origin },
    stdio: 'ignore',
  });
  const invalidBase = `http://127.0.0.1:${invalidApiPort}`;
  let invalidReady = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${invalidBase}/health`)).ok) { invalidReady = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(invalidReady, true, 'second Nest API should start');
  const invalidResponse = await fetch(`${invalidBase}/integrations/search`);
  assert.equal(invalidResponse.status, 502);
  await new Promise(resolve => invalid.close(resolve));
  console.log('PASS search integration HTTP: internal auth, POST origin/settings/payload, rejection guards, upstream status, secret redaction, invalid JSON');
} finally {
  if (api && api.exitCode === null) { api.kill('SIGTERM'); await new Promise(resolve => api.once('exit', resolve)); }
  await new Promise(resolve => agent.close(resolve));
  await rm(work, { recursive: true, force: true });
}
