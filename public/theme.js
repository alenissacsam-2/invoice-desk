// Applies a stored light/dark choice before first paint (a classic script, so it blocks); app.js runs the toggle.
try { const t = localStorage.getItem('invoice-desk:theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch { /* storage blocked */ }
// theme-color metas follow the chosen theme; "system" restores the per-scheme defaults. app.js calls this on toggle.
window.applyThemeColor = (t) => {
  const c = { light: '#D4DCE6', dark: '#131922' };
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.content = c[t] || (/dark/.test(m.media) ? c.dark : c.light);
  });
};
window.applyThemeColor(document.documentElement.dataset.theme);
