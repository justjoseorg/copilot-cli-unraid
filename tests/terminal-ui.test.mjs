import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { createTerminalServer } from '../rootfs/usr/local/bin/terminal-ui.mjs';

const authorization = `Basic ${Buffer.from('test-user:test:password').toString('base64')}`;
const sessionId = 'a'.repeat(32);

async function setup(context) {
  let settings = { unusedMinutes: 1 };
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
      settings: () => settings,
      updateSettings: async value => {
        if (typeof value?.unusedMinutes !== 'number' || value.unusedMinutes < 0
          || !Number.isFinite(value.unusedMinutes)) throw new TypeError('Invalid minutes');
        settings = value;
        return settings;
      },
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
  for (const path of ['/', '/app.js', '/style.css', '/terminal/', '/terminal/token', '/api/terminals', '/api/settings']) {
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

test('shared cleanup settings require authentication, same origin and valid minutes', async context => {
  const { origin } = await setup(context);
  const initial = await fetch(origin + '/api/settings', { headers: { authorization } });
  assert.deepEqual(await initial.json(), { unusedMinutes: 1 });
  const update = (value, extra = {}) => fetch(origin + '/api/settings', {
    method: 'PATCH',
    headers: { authorization, Origin: origin, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(value),
  });
  assert.equal((await update({ unusedMinutes: 5 }, { Origin: 'http://other-host' })).status, 403);
  assert.equal((await update({ unusedMinutes: 5 }, { Origin: '' })).status, 403);
  for (const value of [{ unusedMinutes: -1 }, { unusedMinutes: '5' }, {}, null]) {
    assert.equal((await update(value)).status, 400);
  }
  const updated = await update({ unusedMinutes: 2.5 });
  assert.deepEqual(await updated.json(), { unusedMinutes: 2.5 });
  const otherDevice = await fetch(origin + '/api/settings', { headers: { authorization } });
  assert.deepEqual(await otherDevice.json(), { unusedMinutes: 2.5 });
  assert.deepEqual(await (await update({ unusedMinutes: 0 })).json(), { unusedMinutes: 0 });
});

async function browser({ failClose = false } = {}) {
  const elements = new Map();
  const requests = [];
  let poll;
  const document = {
    activeElement: null,
    addEventListener() {},
    createElement: tag => element(tag),
    querySelector: selector => elements.get(selector),
  };
  function element(tag) {
    return {
      tag, hidden: false, disabled: false, children: [], attributes: {}, listeners: {},
      dataset: {}, classList: { toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      append(...items) {
        this.appends = (this.appends || 0) + 1;
        this.children.push(...items);
        for (const item of items) item.parentNode = this;
      },
      remove() {
        this.removed = true;
        if (this.parentNode) {
          this.parentNode.children = this.parentNode.children.filter(item => item !== this);
          this.parentNode = null;
        }
      },
      showModal() { this.open = true; },
      close() { this.open = false; this.listeners.close?.(); },
      focus() { document.activeElement = this; },
      checkValidity() { return this.value !== '' && Number(this.value) >= 0; },
      get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
    };
  }
  for (const id of ['terminal-list', 'terminal-panels', 'active-title', 'rename-terminal',
    'empty-state', 'notice', 'new-terminal', 'terminal-sidebar', 'hide-sidebar',
    'show-sidebar', 'unused-minutes', 'close-dialog', 'close-message', 'close-error',
    'confirm-close', 'cancel-close']) {
    elements.set(`#${id}`, element('div'));
  }
  elements.get('#show-sidebar').hidden = true;
  let settings = { unusedMinutes: 1 };
  let current = [{ id: sessionId, name: 'Terminal 1' }];
  const source = await readFile(new URL('../rootfs/usr/local/share/copilot-terminal/app.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document,
    setInterval: callback => { poll = callback; },
    fetch: async (path, options = {}) => {
      requests.push({ path, ...options });
      let result;
      if (path === '/api/settings') {
        if (options.method === 'PATCH') settings = JSON.parse(options.body);
        result = settings;
      } else {
        if (options.method === 'DELETE') {
          if (failClose) return { ok: false };
          current = [];
          result = { ok: true };
        } else result = options.method === 'POST' ? current[0] : { terminals: current };
      }
      return { ok: true, json: async () => result };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return {
    elements, document, requests, poll,
    setCloseFailure: value => { failClose = value; },
    removeTerminals: () => { current = []; },
  };
}

test('polling keeps terminal buttons attached instead of interrupting clicks', async () => {
  const { elements, poll } = await browser();
  const list = elements.get('#terminal-list');
  const row = list.children[0];
  const appends = list.appends;
  await poll();
  await poll();
  assert.equal(list.appends, appends);
  assert.equal(list.children[0], row);
});

test('terminal close uses an in-page confirmation and cancellation preserves the terminal', async () => {
  const { elements, requests } = await browser();
  const list = elements.get('#terminal-list');
  const close = list.children[0].children[1];
  const dialog = elements.get('#close-dialog');
  close.listeners.click();
  assert.equal(dialog.open, true);
  assert.match(elements.get('#close-message').textContent, /Terminal 1/);
  assert.equal(requests.some(request => request.method === 'DELETE'), false);
  elements.get('#cancel-close').listeners.click();
  assert.equal(dialog.open, false);
  assert.equal(list.children.length, 1);
  close.listeners.click();
  await elements.get('#confirm-close').listeners.click();
  assert.equal(dialog.open, false);
  assert.equal(list.children.length, 0);
  assert.equal(elements.get('#empty-state').hidden, false);
  assert.deepEqual(requests.filter(request => request.method === 'DELETE').map(request => request.path),
    [`/api/terminals/${sessionId}`]);
});

test('close failures remain visible through polling and can be retried', async () => {
  const { elements, poll, setCloseFailure } = await browser({ failClose: true });
  elements.get('#terminal-list').children[0].children[1].listeners.click();
  const confirm = elements.get('#confirm-close');
  await confirm.listeners.click();
  assert.equal(elements.get('#close-dialog').open, true);
  assert.equal(elements.get('#close-error').hidden, false);
  assert.equal(confirm.disabled, false);
  await poll();
  assert.equal(elements.get('#close-error').hidden, false);
  setCloseFailure(false);
  await confirm.listeners.click();
  assert.equal(elements.get('#close-dialog').open, false);
  assert.equal(elements.get('#terminal-list').children.length, 0);
});

test('confirmation closes when the last terminal disappears on another device', async () => {
  const { elements, poll, removeTerminals } = await browser();
  elements.get('#terminal-list').children[0].children[1].listeners.click();
  removeTerminals();
  await poll();
  assert.equal(elements.get('#close-dialog').open, false);
  assert.equal(elements.get('#empty-state').hidden, false);
});

test('hiding the sidebar exposes a circular restore control without reconnecting the terminal', async () => {
  const { elements, document, requests } = await browser();
  const sidebar = elements.get('#terminal-sidebar');
  const hide = elements.get('#hide-sidebar');
  const show = elements.get('#show-sidebar');
  const panels = elements.get('#terminal-panels');
  const frame = panels.children[0];
  const count = requests.length;
  hide.listeners.click();
  assert.equal(sidebar.hidden, true);
  assert.equal(show.hidden, false);
  assert.equal(show.attributes['aria-expanded'], 'false');
  assert.equal(document.activeElement, show);
  show.listeners.click();
  assert.equal(sidebar.hidden, false);
  assert.equal(show.hidden, true);
  assert.equal(hide.attributes['aria-expanded'], 'true');
  assert.equal(document.activeElement, hide);
  assert.equal(panels.children[0], frame);
  assert.equal(frame.removed, undefined);
  assert.equal(requests.length, count);
});

test('editable cleanup minutes save custom and disabled values without overwriting an active edit', async () => {
  const { elements, document, requests, poll } = await browser();
  const input = elements.get('#unused-minutes');
  assert.equal(input.value, '1');
  input.value = '2.5';
  await input.listeners.change();
  assert.deepEqual(JSON.parse(requests.at(-1).body), { unusedMinutes: 2.5 });
  input.focus();
  input.value = '7.25';
  await poll();
  assert.equal(input.value, '7.25');
  document.activeElement = null;
  await poll();
  assert.equal(input.value, '2.5');
  input.value = '0';
  await input.listeners.change();
  assert.deepEqual(JSON.parse(requests.at(-1).body), { unusedMinutes: 0 });
  const count = requests.length;
  for (const value of ['', '-1', 'invalid']) {
    input.value = value;
    await input.listeners.change();
  }
  assert.equal(requests.length, count);
  assert.equal(elements.get('#notice').hidden, false);
  assert.equal(input.disabled, false);
});
