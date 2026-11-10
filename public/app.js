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
  if (switched && document.activeElement?.closest('.nav')) main.focus({ preventScroll: true });
}

async function refreshCount() {
  const el = document.getElementById('runs-count');
  try {
    const s = await api('/api/stats');
    el.textContent = s?.total ? String(s.total) : '';
  } catch { el.textContent = ''; }
}

document.getElementById('reset').addEventListener('click', async (e) => {
  if (!confirm('Reset the demo?\n\nThis clears every run and the ledger. Cached extractions are kept, so re-runs stay fast.')) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await api('/api/reset', { method: 'POST' });
    active?.unmount?.();
    active = null;
    if (location.hash === '#/' || !location.hash) route(); else location.hash = '#/';
    refreshCount();
  } catch (err) {
    alert(err.status === 429 ? err.message : `Reset failed: ${err.message}`);
  } finally { btn.disabled = false; }
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
  showTheme();
});
showTheme();

// Delegated copy buttons (see copyButton in util.js).
document.addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) handleCopy(b); });

// A file dropped outside the drop zone must not navigate away from the app.
['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => { if (!e.target.closest?.('.drop')) e.preventDefault(); }));

window.addEventListener('hashchange', route);
window.addEventListener('runs-changed', refreshCount);
route();
refreshCount();
