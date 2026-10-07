/* Demo-only wording adaptation; no owner/network capability is supplied. */
(() => {
  'use strict';
  const root = document.getElementById('root');
  if (!root) return;
  const obsolete = 'Open this app in Web Desktop, Web Canvas or Electron Desktop to use connected imports.';
  const explanation = 'Example data. Changes reset on reload. Install to import from your tools.';
  let remaining = 2000;
  const adapt = () => {
    // Exact source markup and exact import-only copy. Genuine errors stay unchanged.
    const notices = root.querySelectorAll('.main-column > main > p.notice[role="status"]');
    for (let index = 0; index < Math.min(notices.length, 8); index++) {
      if (notices[index].textContent.trim() === obsolete) notices[index].textContent = explanation;
    }
  };
  const observer = new MutationObserver(() => {
    if (--remaining <= 0) { stop(); return; }
    adapt();
  });
  let expiry;
  const stop = () => { observer.disconnect(); clearTimeout(expiry); };
  // Child-list observation catches React mounting and replacement, without watching timer ticks.
  observer.observe(root, { childList: true, subtree: true });
  expiry = setTimeout(stop, 30 * 60 * 1000);
  window.addEventListener('pagehide', stop, { once: true });
  adapt();
})();
