import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
].map(([path, [file, type]]) => [
  path, { type, body: readFileSync(new URL(`../share/copilot-terminal/${file}`, import.meta.url)) },
]));
const hash = value => createHash('sha256').update(value).digest();

export function createTerminalServer({ username, password, backendPort = 7682 }) {
  const expected = hash(`${username}:${password}`);
  const sockets = new Set();
  const authenticated = request => {
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(request.headers.authorization || '');
    return Boolean(match && timingSafeEqual(hash(Buffer.from(match[1], 'base64')), expected));
  };
  const unauthorized = {
    'WWW-Authenticate': 'Basic realm="Copilot terminal", charset="UTF-8"',
    'Cache-Control': 'no-store',
  };
  const backend = request => ({
    hostname: '127.0.0.1',
    port: backendPort,
    method: request.method,
    path: request.url,
    headers: request.headers,
  });
  const terminalPath = path => path.startsWith('/terminal/');

  const server = http.createServer((request, response) => {
    if (!authenticated(request)) {
      response.writeHead(401, unauthorized).end('Authentication required');
      return;
    }
    let path;
    try {
      path = new URL(request.url, 'http://localhost').pathname;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (terminalPath(path)) {
      const upstream = http.request(backend(request), reply => {
        response.writeHead(reply.statusCode, {
          ...reply.headers,
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'SAMEORIGIN',
        });
        reply.pipe(response);
        reply.on('error', () => response.destroy());
      });
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end('Terminal is unavailable');
      });
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
      return;
    }
    const asset = assets.get(path);
    if (!asset || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': asset.type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    });
    response.end(request.method === 'HEAD' ? undefined : asset.body);
  });

  server.on('upgrade', (request, socket, head) => {
    if (!authenticated(request)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Copilot terminal"\r\nConnection: close\r\n\r\n');
      return;
    }
    let allowed = false;
    try {
      allowed = new URL(request.url, 'http://localhost').pathname === '/terminal/ws'
        && new URL(request.headers.origin).host === request.headers.host;
    } catch {
      // Missing or malformed origins must not open a terminal.
    }
    if (!allowed) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = http.request(backend(request));
    upstream.on('upgrade', (reply, remote, remoteHead) => {
      let headers = `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n`;
      for (let index = 0; index < reply.rawHeaders.length; index += 2) {
        headers += `${reply.rawHeaders[index]}: ${reply.rawHeaders[index + 1]}\r\n`;
      }
      socket.write(`${headers}\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
      remote.on('error', () => socket.destroy());
      socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy());
      remote.on('close', () => socket.destroy());
    });
    upstream.on('response', reply => {
      reply.resume();
      socket.end(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\nConnection: close\r\n\r\n`);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  server.destroyConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  return server;
}

async function main() {
  const username = process.env.WEB_TERMINAL_USER;
  const password = process.env.WEB_TERMINAL_PASSWORD;
  const server = createTerminalServer({ username, password });
  let stopping = false;
  const terminal = spawn('ttyd', [
    '--interface', '127.0.0.1', '--port', '7682', '--base-path', '/terminal',
    '--writable', '--check-origin', '--max-clients', '0',
    '--cwd', '/Storage/repos', '--credential', `${username}:${password}`, 'sh', '-l',
  ], { stdio: 'inherit' });
  const stop = () => {
    stopping = true;
    server.close();
    server.destroyConnections();
    terminal.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  terminal.on('error', error => {
    console.error(`Cannot start terminal backend: ${error.message}`);
    process.exit(1);
  });
  terminal.on('exit', code => {
    server.close();
    server.destroyConnections();
    process.exit(stopping ? 0 : (code || 1));
  });
  server.on('error', error => {
    console.error(`Cannot start terminal UI: ${error.message}`);
    terminal.kill('SIGTERM');
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await new Promise(resolve => {
      const connection = createConnection({ host: '127.0.0.1', port: 7682 });
      connection.once('connect', () => { connection.destroy(); resolve(true); });
      connection.once('error', () => resolve(false));
    });
    if (stopping) return;
    if (ready) {
      server.listen(7681, '0.0.0.0');
      return;
    }
    await delay(100);
  }
  console.error('Terminal backend did not become ready.');
  terminal.kill('SIGTERM');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
