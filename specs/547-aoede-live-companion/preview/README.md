# Aoede interaction preview

Simulated Vite + React UI; no audio capture, provider calls, real commands or user-data writes. Text requests select one of three demonstration scenarios. Switching the provider selector changes its label only.

From this directory, install with `pnpm install --ignore-workspace --frozen-lockfile`, then `bun run dev`, `bun run test`, or `bun run build`. Brand tokens import directly from `packages/brand`; the wallpaper is the existing Matrix dusk asset. The dependencies are isolated from the root workspace. Keep this preview outside the production feature path.

Click **Build an app** to follow a simulated Chat builder task (11 seconds), **Open app** to use the generated tracker, **Find an earlier chat** to inspect the source, or **Use Terminal** to approve/reject a simulated command. Ending voice leaves the demo build running. Reset cancels the demonstration and restores the starting view.

Verified on 2026-10-05: production preview build; four lifecycle/approval tests; browser checks for build continuing after End voice, opening Leaf, rejecting/approving the terminal demo, and 1280px/390px layouts. These checks validate the interaction study only. Real provider latency, voice quality, transcription accuracy, costs, permissions, and kernel wiring still require the spec's funded integration spike.
