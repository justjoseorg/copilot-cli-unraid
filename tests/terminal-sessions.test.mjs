import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalSessions } from '../rootfs/usr/local/lib/terminal-sessions.mjs';

function setup({ idleSeconds = 86400, unusedSeconds = 60 } = {}) {
  let now = 1_000_000;
  let children = false;
  let command = 'bash';
  let failInspection = false;
  const live = new Set();
  const sessions = new TerminalSessions({
    idleSeconds, unusedSeconds, clock: () => now,
    children: async () => typeof children === 'function' ? children() : children,
    run: async args => {
      if (args[0] === 'new-session') live.add(args[args.indexOf('-s') + 1]);
      if (args[0] === 'kill-session') live.delete(args[2]);
      if (args[0] === 'display-message') return `${args[3]}\t${args[3]}`;
      if (args[0] === 'list-panes') {
        if (failInspection) throw new Error('Unable to inspect tmux');
        return [...live].map(name => `${name}\t123\t${command}\t0\t0`).join('\n');
      }
      return '';
    },
  });
  return {
    sessions, advance: ms => { now += ms; },
    background: value => { children = value; },
    foreground: value => { command = value; },
    fail: () => { failInspection = true; },
  };
}

test('untouched shells expire quickly, but interaction grants 24 hours', async () => {
  const { sessions, advance } = setup();
  const empty = await sessions.create();
  const used = await sessions.create();
  sessions.activity(used.id);
  advance(60_001);
  await sessions.sweep();
  assert.equal(sessions.has(empty.id), false);
  assert.equal(sessions.has(used.id), true);
  advance(86400 * 1000 - 60_002);
  await sessions.sweep();
  assert.equal(sessions.has(used.id), true);
  advance(2);
  await sessions.sweep();
  assert.equal(sessions.has(used.id), false);
});

test('foreground and background jobs prevent expiry and restart the grace period', async () => {
  for (const kind of ['background', 'foreground']) {
    const state = setup({ idleSeconds: 10, unusedSeconds: 1 });
    const terminal = await state.sessions.create();
    if (kind === 'background') state.background(true);
    else state.foreground('python');
    state.advance(20_000);
    await state.sessions.sweep();
    assert.equal(state.sessions.has(terminal.id), true);
    assert.equal((await state.sessions.list())[0].used, true);
    state.background(false);
    state.foreground('bash');
    state.advance(9999);
    await state.sessions.sweep();
    assert.equal(state.sessions.has(terminal.id), true);
    state.advance(2);
    await state.sessions.sweep();
    assert.equal(state.sessions.has(terminal.id), false);
  }
});

test('failed inspection cannot delete shells and disabled expiry retains idle shells', async () => {
  const state = setup({ idleSeconds: 0, unusedSeconds: 0 });
  const terminal = await state.sessions.create();
  state.advance(10 ** 9);
  await state.sessions.sweep();
  assert.equal(state.sessions.has(terminal.id), true);
  state.fail();
  await assert.rejects(state.sessions.sweep());
  assert.equal(state.sessions.has(terminal.id), true);
});

test('a job starting during cleanup is detected by the final inspection', async () => {
  const state = setup();
  const terminal = await state.sessions.create();
  let inspections = 0;
  state.background(() => ++inspections >= 2);
  state.advance(61_000);
  await state.sessions.sweep();
  assert.equal(state.sessions.has(terminal.id), true);
  assert.equal(inspections, 2);
});
