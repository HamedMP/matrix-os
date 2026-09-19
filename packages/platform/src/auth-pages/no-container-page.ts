/**
 * No-container (provisioning) page.
 *
 * Extracted from ./auth-pages.ts (Phase 1-A4). Pure move: no logic changes.
 */

export function getNoContainerPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Matrix OS</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 50% 46%, rgba(196, 162, 101, 0.16), transparent 32%),
        linear-gradient(180deg, #fffdf6 0%, #f4efe4 100%);
      color: #2f392c;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 28px;
    }
    main {
      width: min(620px, 100%);
      display: grid;
      justify-items: center;
      gap: 26px;
      text-align: center;
    }
    .mark {
      width: 74px;
      height: 74px;
      border-radius: 24px;
      border: 1px solid rgba(47, 57, 44, 0.18);
      position: relative;
      background: rgba(255, 255, 255, 0.42);
      box-shadow: 0 24px 70px rgba(47, 57, 44, 0.12);
    }
    .mark::before {
      content: "";
      position: absolute;
      inset: 11px;
      border-radius: 18px;
      border: 2px solid rgba(47, 57, 44, 0.16);
      border-top-color: #c4a265;
      animation: spin 1.3s linear infinite;
    }
    .mark::after {
      content: "M";
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      font-size: 30px;
      font-weight: 700;
      color: #2f392c;
    }
    h1 {
      margin: 0;
      font-size: clamp(34px, 8vw, 68px);
      font-weight: 500;
      line-height: 0.96;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    p {
      max-width: 520px;
      color: rgba(47, 57, 44, 0.68);
      font-size: 16px;
      line-height: 1.65;
      margin: 0;
    }
    .status {
      min-height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid rgba(47, 57, 44, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.48);
      padding: 7px 12px;
      color: rgba(47, 57, 44, 0.72);
      font-size: 13px;
      box-shadow: 0 12px 40px rgba(47, 57, 44, 0.08);
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .mark::before { animation-duration: 1ms; animation-iteration-count: 1; }
    }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true"></div>
    <h1>Preparing Matrix OS</h1>
    <p>Your cloud computer is not ready yet. Matrix will bring you here automatically as soon as provisioning finishes.</p>
    <p class="status">Computer status: pending</p>
  </main>
</body>
</html>`;
}
