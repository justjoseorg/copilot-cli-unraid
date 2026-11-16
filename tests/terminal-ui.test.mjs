import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createTerminalServer } from '../rootfs/usr/local/bin/terminal-ui.mjs';

const authorization = `Basic ${Buffer.from('test-user:test:password').toString('base64')}`;
const sessionId = 'a'.repeat(32);

async function setup(context) {
  const backend = http.createServer((request, response) => {
    response.end(JSON.stringify({ url: request.url, host: request.headers.host }));
  });
  backend.on('upgrade', (request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', data => socket.write(data));
    socket.on('error', () => socket.destroy());
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const server = createTerminalServer({
    username: 'test-user', password: 'test:password', backendPort: backend.address().port,
    sessions: {
      has: id => id === sessionId,
      attach: () => {},
      list: async () => [{ id: sessionId, name: 'Terminal 1' }],
      create: async () => ({ id: sessionId }),
      activity: () => {},
      rename: () => {},
      close: async () => {},
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => {
    server.destroyConnections();
    server.close();
    backend.closeAllConnections();
    backend.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, server };
}

test('sidebar assets require the same credentials as terminals', async context => {
  const { origin } = await setup(context);
  for (const path of ['/', '/app.js', '/style.css', '/terminal/', '/terminal/token', '/api/terminals']) {
    const denied = await fetch(origin + path);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /^Basic /);
    await denied.text();
    const wrong = await fetch(origin + path, { headers: { authorization: 'Basic d3Jvbmc=' } });
    assert.equal(wrong.status, 401);
    await wrong.text();
  }
  const response = await fetch(origin, { headers: { authorization } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="new-terminal"/);
  assert.match(response.headers.get('content-security-policy'), /frame-src 'self'/);
  const missing = await fetch(origin + '/missing', { headers: { authorization } });
  assert.equal(missing.status, 404);
  await missing.text();
});

test('proxy preserves terminal paths, query strings and the browser host', async context => {
  const { origin } = await setup(context);
  const response = await fetch(origin + '/terminal/token?session=2', {
    headers: { authorization },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    url: '/terminal/token?session=2', host: new URL(origin).host,
  });
});

function upgrade(origin, headers = {}, path = '/terminal/ws') {
  return new Promise((resolve, reject) => {
    const request = http.request(origin + path, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers },
    });
    request.on('upgrade', (response, socket) => resolve({ response, socket }));
    request.on('response', response => { response.resume(); resolve({ response }); });
    request.on('error', reject);
    request.end();
  });
}

test('websocket upgrades require authentication, an allowed route and same origin', async context => {
  const { origin } = await setup(context);
  assert.equal((await upgrade(origin)).response.statusCode, 401);
  assert.equal((await upgrade(origin, { authorization, Origin: 'http://other-host' })).response.statusCode, 403);
  assert.equal((await upgrade(origin, { authorization })).response.statusCode, 403);
  assert.equal((await upgrade(origin, { authorization, Origin: origin }, '/other/ws')).response.statusCode, 403);
  assert.equal((await upgrade(origin, { authorization, Origin: origin })).response.statusCode, 404);
  const { response, socket } = await upgrade(origin, { authorization, Origin: origin }, `/terminal/ws?arg=${sessionId}`);
  assert.equal(response.statusCode, 101);
  try {
    const received = once(socket, 'data');
    socket.write('terminal-payload');
    assert.equal((await received)[0].toString(), 'terminal-payload');
  } finally {
    socket.destroy();
  }
});

test('shared session mutations require the authenticated same-origin browser', async context => {
  const { origin } = await setup(context);
  const denied = await fetch(origin + '/api/terminals', {
    method: 'POST', headers: { authorization, Origin: 'http://other-host' },
  });
  assert.equal(denied.status, 403);
  const created = await fetch(origin + '/api/terminals', {
    method: 'POST', headers: { authorization, Origin: origin },
  });
  assert.deepEqual(await created.json(), { id: sessionId });
  const listed = await fetch(origin + '/api/terminals', { headers: { authorization } });
  assert.equal((await listed.json()).terminals[0].id, sessionId);
  const activity = await fetch(`${origin}/api/terminals/${sessionId}/activity`, {
    method: 'POST', headers: { authorization, Origin: origin },
  });
  assert.equal(activity.status, 200);
  const renamed = await fetch(`${origin}/api/terminals/${sessionId}`, {
    method: 'PATCH', headers: { authorization, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Build' }),
  });
  assert.equal(renamed.status, 200);
});
