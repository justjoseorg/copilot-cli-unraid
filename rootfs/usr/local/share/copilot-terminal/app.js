const list = document.querySelector('#terminal-list');
const panels = document.querySelector('#terminal-panels');
const title = document.querySelector('#active-title');
const rename = document.querySelector('#rename-terminal');
const empty = document.querySelector('#empty-state');
const notice = document.querySelector('#notice');
const newButton = document.querySelector('#new-terminal');
const terminals = new Map();
let selected = null;
let frame = null;

async function api(path = '', method = 'GET', body) {
  const response = await fetch(`/api/terminals${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Unable to update terminals. Check the connection and try again.');
  return response.json();
}

function showError(error) {
  notice.textContent = error.message;
  notice.hidden = false;
}

function selectTerminal(terminal, reconnect = false) {
  if (selected === terminal && frame && !reconnect) return;
  selected = terminal;
  if (frame) frame.remove();
  frame = null;
  for (const item of terminals.values()) {
    item.row.classList.toggle('active', item === selected);
    if (item === selected) item.tab.setAttribute('aria-current', 'true');
    else item.tab.removeAttribute('aria-current');
  }
  title.textContent = terminal?.name || 'Terminals';
  rename.disabled = !terminal;
  empty.hidden = Boolean(terminal);
  if (!terminal) return;
  const attached = document.createElement('iframe');
  frame = attached;
  attached.className = 'terminal-frame';
  attached.title = terminal.name;
  attached.src = `/terminal/?arg=${terminal.id}`;
  attached.allow = 'clipboard-read; clipboard-write';
  attached.addEventListener('load', () => {
    let lastSent = 0;
    const activity = () => {
      if (Date.now() - lastSent < 10000) return;
      lastSent = Date.now();
      api(`/${terminal.id}/activity`, 'POST').catch(() => {});
    };
    for (const event of ['keydown', 'input', 'paste']) {
      attached.contentDocument.addEventListener(event, activity, true);
    }
    if (frame === attached) attached.contentWindow.focus();
  });
  panels.append(attached);
}

function makeTerminal(data) {
  const terminal = { ...data, row: document.createElement('div'), tab: document.createElement('button'),
    close: document.createElement('button') };
  terminal.row.className = 'terminal-row';
  terminal.tab.type = 'button';
  terminal.tab.className = 'terminal-tab';
  terminal.tab.addEventListener('click', () => selectTerminal(terminal, true));
  terminal.close.type = 'button';
  terminal.close.className = 'close-terminal';
  terminal.close.textContent = 'x';
  terminal.close.addEventListener('click', async () => {
    if (!confirm(`Close "${terminal.name}" on all devices? Running programs will stop.`)) return;
    try { await api(`/${terminal.id}`, 'DELETE'); await refresh(); }
    catch (error) { showError(error); }
  });
  terminal.row.append(terminal.tab, terminal.close);
  return terminal;
}

async function refresh(preferredId) {
  const { terminals: current } = await api();
  const ids = new Set(current.map(terminal => terminal.id));
  for (const [id, terminal] of terminals) {
    if (ids.has(id)) continue;
    terminal.row.remove();
    terminals.delete(id);
    if (selected === terminal) { selected = null; frame?.remove(); frame = null; }
  }
  for (const data of current) {
    const terminal = terminals.get(data.id) || makeTerminal(data);
    Object.assign(terminal, data);
    terminal.tab.textContent = data.name;
    terminal.tab.setAttribute('aria-label', data.name);
    terminal.tab.title = data.busy ? `${data.name} - running jobs` : data.name;
    terminal.close.setAttribute('aria-label', `Close ${data.name}`);
    terminal.row.dataset.busy = String(data.busy);
    terminals.set(data.id, terminal);
    list.append(terminal.row);
    if (selected === terminal) {
      title.textContent = data.name;
      if (frame) frame.title = data.name;
    }
  }
  const preferred = terminals.get(preferredId);
  if (preferred) selectTerminal(preferred);
  else if (!selected) {
    const candidates = [...terminals.values()].sort((a, b) => Number(b.used) - Number(a.used)
      || b.lastActive - a.lastActive);
    selectTerminal(candidates[0] || null);
  }
  notice.hidden = true;
}

async function newTerminal() {
  newButton.disabled = true;
  try {
    const terminal = await api('', 'POST');
    await refresh(terminal.id);
  } catch (error) { showError(error); }
  finally { newButton.disabled = false; }
}

newButton.addEventListener('click', newTerminal);
rename.addEventListener('click', async () => {
  if (!selected) return;
  const terminal = selected;
  const name = prompt('Terminal name', terminal.name);
  if (!name?.trim()) return;
  try { await api(`/${terminal.id}`, 'PATCH', { name: name.trim() }); await refresh(); }
  catch (error) { showError(error); }
});
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try { await refresh(); }
  catch (error) { showError(error); }
  finally { polling = false; }
}
setInterval(poll, 2000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});
newTerminal();
