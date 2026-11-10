// Shell: hash router, nav state, runs count, reset, global handlers.
import { api, handleCopy } from './js/util.js';
import { mountProcess, unmountProcess } from './js/process.js';
import { mountRuns, unmountRuns } from './js/runs.js';
import { mountData, unmountData } from './js/data.js';

const VIEWS = {
  process: { mount: mountProcess, unmount: unmountProcess, nav: 'process', title: 'Process' },
  runs: { mount: mountRuns, unmount: unmountRuns, nav: 'runs', title: 'Runs' },
  data: { mount: mountData, unmount: unmountData, nav: 'data', title: 'Procurement data' },
};

const main = document.getElementById('main');
let active = null;

function parse(hash) {
  const m = /^#\/run\/([^/?#]+)/.exec(hash);
  if (m) return ['process', decodeURIComponent(m[1])];
  if (/^#\/runs\b/.test(hash)) return ['runs'];
  if (/^#\/data\b/.test(hash)) return ['data'];
  return ['process', null];
}

function route() {
  const [name, arg] = parse(location.hash);
  const view = VIEWS[name];
  const switched = active !== view;
  if (switched) {
    active?.unmount?.();
    main.innerHTML = '';
    active = view;
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.dataset.nav === view.nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = `${arg ? `Run ${arg}` : view.title} · Invoice Desk`;
  view.mount(main, arg);
  refreshCount(); // the badge must match whatever page is now showing
  if (switched && document.activeElement?.closest('.nav')) main.focus({ preventScroll: true });
}

function setCount(n) {
  const el = document.getElementById('runs-count');
  el.textContent = n ? String(n) : '';
  if (n) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', `${n} ${n === 1 ? 'run' : 'runs'}`); }
  else { el.removeAttribute('role'); el.removeAttribute('aria-label'); }
}

async function refreshCount() {
  try { setCount((await api('/api/stats'))?.total); } catch { setCount(0); }
}

// Right-edge fade on the nav only while it overflows and isn't scrolled to the end.
const nav = document.querySelector('.nav');
const fade = () => nav.classList.toggle('more', nav.scrollWidth - nav.clientWidth - nav.scrollLeft > 2);
nav.addEventListener('scroll', fade, { passive: true });
window.addEventListener('resize', fade);

// Reset demo: a styled <dialog>; Esc and Cancel close it, errors show inside it.
const dlg = document.getElementById('reset-dlg');
const dlgErr = document.getElementById('reset-err');
const dlgGo = document.getElementById('reset-go');
document.getElementById('reset').addEventListener('click', () => {
  dlgErr.hidden = true;
  dlg.showModal();
});
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop click
dlgGo.addEventListener('click', async () => {
  dlgGo.disabled = true;
  dlgErr.hidden = true;
  try {
    await api('/api/reset', { method: 'POST' });
    dlg.close();
    active?.unmount?.();
    active = null;
    if (location.hash === '#/' || !location.hash) route(); else location.hash = '#/';
    refreshCount();
  } catch (err) {
    dlgErr.textContent = err.status === 429 ? err.message : `Reset failed: ${err.message}`;
    dlgErr.hidden = false;
  } finally { dlgGo.disabled = false; }
});

document.getElementById('skip').addEventListener('click', () => main.focus());

// Theme: system (no attribute) or a stored light/dark choice. theme.js applies the stored one before first paint.
const THEME_KEY = 'invoice-desk:theme';
function showTheme() {
  const t = document.documentElement.dataset.theme || 'system';
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)));
}
document.querySelector('.theme').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-set]');
  if (!b) return;
  const t = b.dataset.themeSet;
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { if (t === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
  window.applyThemeColor?.(t === 'system' ? undefined : t);
  showTheme();
});
showTheme();

// Delegated copy buttons (see copyButton in util.js).
document.addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) handleCopy(b); });

// A file dropped outside the drop zone must not navigate away from the app.
['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => { if (!e.target.closest?.('.drop')) e.preventDefault(); }));

fade();
window.addEventListener('hashchange', route);
window.addEventListener('runs-changed', refreshCount);
route();
