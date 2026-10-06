// Applies the stored/OS theme before first paint. Loaded synchronously in <head>.
(function () {
  var theme = null;
  try {
    var stored = localStorage.getItem('viber-image-theme');
    if (stored === 'light' || stored === 'dark') theme = stored;
  } catch (e) {}
  if (!theme) {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
