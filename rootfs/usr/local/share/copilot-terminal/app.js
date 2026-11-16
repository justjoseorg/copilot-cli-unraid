const list = document.querySelector('#terminal-list');
const panels = document.querySelector('#terminal-panels');
const title = document.querySelector('#active-title');
const rename = document.querySelector('#rename-terminal');
const empty = document.querySelector('#empty-state');
const terminals = [];
let selected = null;
let sequence = 0;

function focusTerminal(terminal) {
  if (selected !== terminal) return;
  terminal.frame.contentWindow.focus();
  terminal.frame.contentWindow.dispatchEvent(new Event('resize'));
}

function selectTerminal(terminal) {
  selected = terminal;
  for (const item of terminals) {
    const active = item === terminal;
    item.frame.hidden = !active;
    item.row.classList.toggle('active', active);
    if (active) item.tab.setAttribute('aria-current', 'true');
    else item.tab.removeAttribute('aria-current');
  }
  title.textContent = terminal ? terminal.name : 'Terminals';
  rename.disabled = !terminal;
  empty.hidden = terminals.length > 0;
  if (terminal) requestAnimationFrame(() => focusTerminal(terminal));
}

function labelTerminal(terminal) {
  terminal.tab.textContent = terminal.name;
  terminal.tab.setAttribute('aria-label', terminal.name);
  terminal.tab.title = terminal.name;
  terminal.frame.title = terminal.name;
  terminal.close.setAttribute('aria-label', `Close ${terminal.name}`);
}

function closeTerminal(terminal) {
  if (!confirm(`Close "${terminal.name}"? Programs in this terminal may stop.`)) return;
  const index = terminals.indexOf(terminal);
  terminals.splice(index, 1);
  terminal.frame.remove();
  terminal.row.remove();
  selectTerminal(selected === terminal
    ? (terminals[index] || terminals[index - 1] || null)
    : selected);
}

function newTerminal() {
  const id = ++sequence;
  const terminal = {
    name: `Terminal ${id}`,
    frame: document.createElement('iframe'),
    row: document.createElement('div'),
    tab: document.createElement('button'),
    close: document.createElement('button'),
  };
  terminal.frame.className = 'terminal-frame';
  terminal.frame.src = `/terminal/?session=${id}`;
  terminal.frame.allow = 'clipboard-read; clipboard-write';
  terminal.frame.addEventListener('load', () => focusTerminal(terminal));
  terminal.row.className = 'terminal-row';
  terminal.tab.type = 'button';
  terminal.tab.className = 'terminal-tab';
  terminal.tab.addEventListener('click', () => selectTerminal(terminal));
  terminal.close.type = 'button';
  terminal.close.className = 'close-terminal';
  terminal.close.textContent = 'x';
  terminal.close.addEventListener('click', () => closeTerminal(terminal));
  labelTerminal(terminal);
  terminal.row.append(terminal.tab, terminal.close);
  list.append(terminal.row);
  panels.append(terminal.frame);
  terminals.push(terminal);
  selectTerminal(terminal);
}

document.querySelector('#new-terminal').addEventListener('click', newTerminal);
rename.addEventListener('click', () => {
  if (!selected) return;
  const name = prompt('Terminal name', selected.name);
  if (!name?.trim()) return;
  selected.name = name.trim();
  labelTerminal(selected);
  title.textContent = selected.name;
});
window.addEventListener('beforeunload', event => {
  if (terminals.length) {
    event.preventDefault();
    event.returnValue = '';
  }
});
newTerminal();
