/**
 * Runtime picker page.
 *
 * Extracted from ./auth-pages.ts (Phase 1-A4). Pure move: no logic changes.
 */

import type { UserMachineRecord } from '../db.js';
import { escapeHtml } from './shared.js';

export { getVpsBootPage } from '../vps-boot-page.js';

export type RuntimePickerMachine = UserMachineRecord & {
  displayVersion: string;
};

export function getRuntimePickerPage(input: {
  machines: RuntimePickerMachine[];
  selectedHandle: string | null;
}): string {
  const rows = input.machines.map((machine) => {
    const isSelected = machine.handle === input.selectedHandle;
    const version = machine.displayVersion;
    const title = machine.runtimeSlot === 'primary' ? 'Main Computer' : `${machine.runtimeSlot} Computer`;
    const started = new Date(machine.provisionedAt).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const statusClass = machine.status === 'running' ? 'good' : machine.status === 'failed' ? 'bad' : 'wait';
    return `<a class="machine ${isSelected ? 'selected' : ''}" href="/vm/${encodeURIComponent(machine.handle)}">
      <div class="topline">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(machine.handle)}</span>
        </div>
        <em class="${statusClass}">${escapeHtml(machine.status)}</em>
      </div>
      <div class="details">
        <span>${escapeHtml(version)}</span>
        <span>Created ${escapeHtml(started)}</span>
      </div>
    </a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Select Matrix OS Machine</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #2f392c;
      background:
        radial-gradient(circle at 50% 42%, rgba(196, 162, 101, 0.12), transparent 31%),
        linear-gradient(180deg, #fffdf6 0%, #f5efe2 100%);
      display: grid;
      place-items: center;
      padding: 28px;
    }
    main { width: min(940px, 100%); }
    header { margin-bottom: 22px; }
    .eyebrow { color: rgba(47, 57, 44, 0.62); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.22em; margin-bottom: 10px; }
    h1 {
      margin: 0;
      font-size: clamp(32px, 6vw, 64px);
      font-weight: 500;
      line-height: 0.98;
      text-transform: uppercase;
      background: linear-gradient(90deg, #2f392c 0%, #2f392c 24%, #c4a265 50%, #2f392c 76%, #2f392c 100%);
      background-size: 300% 100%;
      background-clip: text;
      -webkit-background-clip: text;
      color: transparent;
      animation: shimmer 8s ease-in-out infinite, glow 8s ease-in-out infinite;
    }
    p { color: rgba(47, 57, 44, 0.68); font-size: 16px; line-height: 1.6; max-width: 620px; margin: 14px 0 0; }
    .list { display: grid; gap: 12px; margin-top: 24px; }
    .machine {
      display: block;
      color: inherit;
      text-decoration: none;
      background: rgba(255, 255, 255, 0.64);
      border: 1px solid rgba(47, 57, 44, 0.12);
      border-radius: 8px;
      padding: 18px;
      box-shadow: 0 18px 60px rgba(47, 57, 44, 0.10);
      backdrop-filter: blur(16px);
      transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
    }
    .machine:hover { transform: translateY(-1px); border-color: rgba(196, 162, 101, 0.55); background: rgba(255, 255, 255, 0.82); }
    .machine.selected { border-color: rgba(196, 162, 101, 0.82); }
    .topline { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
    strong { display: block; font-size: 20px; text-transform: capitalize; }
    .topline span { display: block; color: rgba(47, 57, 44, 0.62); font-size: 14px; margin-top: 4px; }
    em {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      font-style: normal;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    em.good { color: #075f3b; background: rgba(223, 246, 232, 0.9); }
    em.wait { color: #74520a; background: rgba(255, 240, 199, 0.92); }
    em.bad { color: #8a1f2b; background: rgba(255, 225, 229, 0.92); }
    .details {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .details span {
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      background: rgba(47, 57, 44, 0.06);
      color: rgba(47, 57, 44, 0.78);
      padding: 6px 10px;
      font-size: 13px;
      white-space: nowrap;
    }
    @media (max-width: 560px) {
      body { padding: 18px; place-items: start center; }
      .topline { align-items: flex-start; }
      .details span { width: 100%; justify-content: space-between; }
    }
    @keyframes shimmer {
      0%, 100% { background-position: 200% 0; }
      50% { background-position: -100% 0; }
    }
    @keyframes glow {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(1.12); }
    }
    @media (prefers-reduced-motion: reduce) {
      h1 { animation-duration: 1ms; animation-iteration-count: 1; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Switch Computer</div>
      <h1>Choose your Matrix OS computer</h1>
      <p>Use your main computer for daily work, or jump into a named test VM when validating a risky feature.</p>
    </header>
    <section class="list" aria-label="Available Matrix OS machines">
      ${rows}
    </section>
  </main>
</body>
</html>`;
}
