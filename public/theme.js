// Applies a stored light/dark choice before first paint (a classic script, so it blocks); app.js runs the toggle.
try { const t = localStorage.getItem('invoice-desk:theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch { /* storage blocked */ }
