import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const shellNames = new Set(['bash', 'sh', 'ash', 'zsh', 'fish']);

async function hasChildren(pid) {
  try {
    return Boolean((await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim());
  } catch (error) {
    if (error.code !== 'ENOENT') return true;
    try {
      await readFile(`/proc/${pid}/stat`, 'utf8');
      // Some kernels, including Unraid's, omit /proc/PID/task/PID/children.
      const entries = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
      const parents = await Promise.all(entries.map(async entry => {
        try {
          const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
          const [state, parent] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          return state !== 'Z' && parent === String(pid);
        } catch (failure) {
          if (failure.code === 'ENOENT' || failure.code === 'ESRCH') return false;
          throw failure;
        }
      }));
      return parents.some(Boolean);
    } catch {
      return true;
    }
  }
}

export class TerminalSessions {
  constructor({
    socket = '/run/copilot/tmux.sock',
    idleSeconds = 86400,
    unusedSeconds = 60,
    clock = Date.now,
    children = hasChildren,
    run = async args => (await execute('tmux', ['-S', socket, ...args], {
      encoding: 'utf8', timeout: 5000,
    })).stdout,
  } = {}) {
    this.records = new Map();
    this.sequence = 0;
    this.idleSeconds = idleSeconds;
    this.unusedSeconds = unusedSeconds;
    this.clock = clock;
    this.children = children;
    this.run = run;
  }

  has(id) { return this.records.has(id); }

  async create() {
    const id = randomBytes(16).toString('hex');
    const name = `copilot-${id}`;
    await this.run(['new-session', '-d', '-s', name, '-c', '/Storage/repos', 'bash', '--login']);
    try {
      await this.run(['set-option', '-t', name, 'status', 'off']);
      await this.run(['set-window-option', '-t', name, 'window-size', 'latest']);
    } catch (error) {
      await this.run(['kill-session', '-t', name]).catch(() => {});
      throw error;
    }
    const now = this.clock();
    const record = {
      id, name: `Terminal ${++this.sequence}`, createdAt: now, lastActive: now,
      used: false, busy: false, connections: new Set(),
    };
    this.records.set(id, record);
    return this.describe(record);
  }

  describe(record) {
    const { id, name, createdAt, lastActive, used, busy } = record;
    return { id, name, createdAt, lastActive, used, busy, connections: record.connections.size };
  }

  attach(id, socket) {
    const record = this.records.get(id);
    if (!record) return;
    record.connections.add(socket);
    socket.once('close', () => record.connections.delete(socket));
  }

  activity(id) {
    const record = this.records.get(id);
    if (!record) return false;
    record.used = true;
    record.lastActive = this.clock();
    return true;
  }

  rename(id, name) {
    const record = this.records.get(id);
    if (!record) return false;
    record.name = name;
    this.activity(id);
    return true;
  }

  async close(id) {
    if (!this.records.has(id)) return;
    const target = await this.run(['display-message', '-p', '-t', `copilot-${id}`,
      '#{session_name}\t#{session_id}']);
    const [name, sessionId] = target.trim().split('\t');
    if (name === `copilot-${id}`) await this.run(['kill-session', '-t', sessionId]);
    this.records.delete(id);
  }

  async list() {
    const records = [...this.records.values()];
    if (!records.length) return [];
    // On inspection failure, refuse cleanup rather than guess that a job is idle.
    let output;
    try {
      output = await this.run(['list-panes', '-a', '-F',
        '#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}\t#{window_activity}']);
    } catch (error) {
      if (!/no server running|no sessions|(?:error|failed).*connect.*No such file/i.test(error.stderr || '')) throw error;
      for (const record of records) this.records.delete(record.id);
      return [...this.records.values()].map(record => this.describe(record));
    }
    const panes = output.trim().split('\n').filter(Boolean).map(line => {
      const [session, pid, command, dead, activity] = line.split('\t');
      return { session, pid, command, dead: dead === '1', activity: Number(activity) * 1000 };
    });
    for (const record of records) {
      if (this.records.get(record.id) !== record) continue;
      const current = panes.filter(pane => pane.session === `copilot-${record.id}`);
      if (!current.length) {
        this.records.delete(record.id);
        continue;
      }
      let busy = false;
      for (const pane of current) {
        if (!pane.dead && (!shellNames.has(pane.command) || await this.children(pane.pid))) busy = true;
      }
      record.busy = busy;
      const now = this.clock();
      if (busy) {
        record.lastActive = now;
        if (now - record.createdAt >= 2000) record.used = true;
      } else if (record.used) {
        record.lastActive = Math.max(record.lastActive,
          ...current.map(pane => Number.isFinite(pane.activity) ? pane.activity : 0));
      }
    }
    return [...this.records.values()].map(record => this.describe(record));
  }

  async sweep() {
    await this.list();
    for (const record of [...this.records.values()]) {
      const seconds = record.used ? this.idleSeconds : this.unusedSeconds;
      const since = record.used ? record.lastActive : record.createdAt;
      if (!record.busy && seconds > 0 && this.clock() - since >= seconds * 1000) {
        await this.list();
        if (!this.records.has(record.id) || record.busy) continue;
        const latestSeconds = record.used ? this.idleSeconds : this.unusedSeconds;
        const latestActivity = record.used ? record.lastActive : record.createdAt;
        if (latestSeconds > 0 && this.clock() - latestActivity >= latestSeconds * 1000) {
          await this.close(record.id);
        }
      }
    }
  }
}
