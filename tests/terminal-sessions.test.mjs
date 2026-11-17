import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('editable unused minutes apply immediately without changing used-shell retention or job protection', async () => {
  const state = setup();
  const unused = await state.sessions.create();
  const used = await state.sessions.create();
  state.sessions.activity(used.id);
  await state.sessions.updateSettings({ unusedMinutes: 0.5 });
  state.advance(30_001);
  await state.sessions.sweep();
  assert.equal(state.sessions.has(unused.id), false);
  assert.equal(state.sessions.has(used.id), true);
  const protectedTerminal = await state.sessions.create();
  state.background(true);
  state.advance(30_001);
  await state.sessions.sweep();
  assert.equal(state.sessions.has(protectedTerminal.id), true);
  state.background(false);
  await state.sessions.sweep();
  assert.equal(state.sessions.has(protectedTerminal.id), true);
  assert.equal(state.sessions.has(used.id), true);
  const disabled = await state.sessions.create();
  await state.sessions.updateSettings({ unusedMinutes: 0 });
  state.advance(100_000);
  await state.sessions.sweep();
  assert.equal(state.sessions.has(disabled.id), true);
  assert.equal(state.sessions.idleSeconds, 86400);
});

test('cleanup settings persist and override the initial environment default', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-settings-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settingsFile = join(directory, 'terminal-settings.json');
  const sessions = new TerminalSessions({ settingsFile });
  await sessions.loadSettings();
  assert.deepEqual(sessions.settings(), { unusedMinutes: 1 });
  await Promise.all([
    sessions.updateSettings({ unusedMinutes: 5 }),
    sessions.updateSettings({ unusedMinutes: 2.5 }),
  ]);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), { unusedMinutes: 2.5 });
  const restarted = new TerminalSessions({ settingsFile, unusedSeconds: 120 });
  await restarted.loadSettings();
  assert.deepEqual(restarted.settings(), { unusedMinutes: 2.5 });
});

test('invalid or unwritable cleanup settings leave the active timeout unchanged', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-settings-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sessions = new TerminalSessions({ settingsFile: join(directory, 'missing', 'settings.json') });
  for (const unusedMinutes of [-1, null, '5', NaN, Infinity, Number.MAX_VALUE]) {
    await assert.rejects(sessions.updateSettings({ unusedMinutes }), TypeError);
  }
  await assert.rejects(sessions.updateSettings(null), TypeError);
  await assert.rejects(sessions.updateSettings({ unusedMinutes: 5 }), /ENOENT/);
  assert.deepEqual(sessions.settings(), { unusedMinutes: 1 });
  sessions.settingsFile = join(directory, 'settings.json');
  await sessions.updateSettings({ unusedMinutes: 10 });
  assert.deepEqual(sessions.settings(), { unusedMinutes: 10 });
});
