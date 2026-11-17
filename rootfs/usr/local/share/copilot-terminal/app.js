const list = document.querySelector('#terminal-list');
const panels = document.querySelector('#terminal-panels');
const title = document.querySelector('#active-title');
const rename = document.querySelector('#rename-terminal');
const empty = document.querySelector('#empty-state');
const notice = document.querySelector('#notice');
const newButton = document.querySelector('#new-terminal');
const sidebar = document.querySelector('#terminal-sidebar');
const hideSidebar = document.querySelector('#hide-sidebar');
const showSidebar = document.querySelector('#show-sidebar');
const unusedMinutes = document.querySelector('#unused-minutes');
const closeDialog = document.querySelector('#close-dialog');
const closeMessage = document.querySelector('#close-message');
const closeError = document.querySelector('#close-error');
const confirmClose = document.querySelector('#confirm-close');
const cancelClose = document.querySelector('#cancel-close');
const terminals = new Map();
let selected = null;
let frame = null;
let savingSettings = false;
let closingTerminal = null;

function setSidebarHidden(hidden) {
  sidebar.hidden = hidden;
  showSidebar.hidden = !hidden;
  hideSidebar.setAttribute('aria-expanded', String(!hidden));
  showSidebar.setAttribute('aria-expanded', String(!hidden));
  (hidden ? showSidebar : hideSidebar).focus();
}

hideSidebar.addEventListener('click', () => setSidebarHidden(true));
showSidebar.addEventListener('click', () => setSidebarHidden(false));

async function cleanupSettings(method = 'GET', body) {
  const response = await fetch('/api/settings', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Unable to update cleanup settings. Check the connection and try again.');
  const settings = await response.json();
  if (method === 'GET' && savingSettings) return;
  if (method !== 'GET' || document.activeElement !== unusedMinutes) {
    unusedMinutes.value = String(settings.unusedMinutes);
  }
  unusedMinutes.disabled = false;
}

unusedMinutes.addEventListener('change', async () => {
  if (savingSettings) return;
  const minutes = unusedMinutes.valueAsNumber;
  if (!unusedMinutes.checkValidity() || !Number.isFinite(minutes)) {
    showError(new Error('Enter a nonnegative number of minutes (0 disables cleanup).'));
    return;
  }
  savingSettings = true;
  unusedMinutes.disabled = true;
  try {
    await cleanupSettings('PATCH', { unusedMinutes: minutes });
    notice.hidden = true;
  } catch (error) { showError(error); }
  finally {
    savingSettings = false;
    unusedMinutes.disabled = false;
  }
});

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

cancelClose.addEventListener('click', () => closeDialog.close());
closeDialog.addEventListener('close', () => { closingTerminal = null; });
closeDialog.addEventListener('cancel', event => {
  if (confirmClose.disabled) event.preventDefault();
});
confirmClose.addEventListener('click', async () => {
  if (!closingTerminal || confirmClose.disabled) return;
  const terminal = closingTerminal;
  confirmClose.disabled = true;
  cancelClose.disabled = true;
  confirmClose.textContent = 'Closing...';
  closeError.hidden = true;
  try {
    await api(`/${terminal.id}`, 'DELETE');
    closeDialog.close();
    await refresh();
    newButton.focus();
  } catch (error) {
    if (closeDialog.open) {
      closeError.textContent = 'Unable to close this terminal. Check the connection and try again.';
      closeError.hidden = false;
    } else showError(error);
  } finally {
    confirmClose.disabled = false;
    cancelClose.disabled = false;
    confirmClose.textContent = 'Close terminal';
  }
});

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
  terminal.close.addEventListener('click', () => {
    closingTerminal = terminal;
    closeMessage.textContent = `Close "${terminal.name}" on all devices? Running programs will stop.`;
    closeError.hidden = true;
    closeDialog.showModal();
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
    if (terminal.row.parentNode !== list) list.append(terminal.row);
    if (selected === terminal) {
      title.textContent = data.name;
      if (frame) frame.title = data.name;
    }
  }
  if (closingTerminal && !terminals.has(closingTerminal.id)) closeDialog.close();
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
  try {
    await refresh();
    if (!savingSettings) await cleanupSettings();
  }
  catch (error) { showError(error); }
  finally { polling = false; }
}
setInterval(poll, 2000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});
newTerminal();
cleanupSettings().catch(showError);
