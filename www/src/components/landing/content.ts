export const faqItems = [
  { q: "Is Matrix another AI editor?", a: "No. Matrix is the always-on cloud computer where coding agents get repos, terminals, previews, files, auth, and review loops that keep running after your laptop closes." },
  { q: "What does task-first cloud coding mean?", a: "A task owns the cloud worktree, terminal sessions, previews, logs, diffs, agent runs, and handoff state needed to finish it. You can leave, reconnect, or share the task without rebuilding context." },
  { q: "Which agents can I use?", a: "Bring Claude Code, Codex, Cursor, OpenCode, Pi, Gemini CLI, and terminal agents. Matrix also hosts Matrix-native agents like Hermes and OpenClaw-style assistants for workflows and connected tools." },
  { q: "What is Symphony?", a: "Symphony is the Matrix orchestration layer for cloud coding: task workspaces, parallel terminal sessions, agent runs, previews, PR review, and handoff between agents and humans." },
  { q: "What is Hermes?", a: "Hermes is the Matrix-native agent for background company workflows. It can work across connected tools, schedules, approvals, logs, and Matrix apps with your permission." },
  { q: "What happens to my data?", a: "Your files live in your Matrix home and workspace data lives in your Matrix database. Matrix is built around owner-controlled data, exportability, and isolated hosted computers." },
  { q: "What does it cost?", a: "Signup is free, and you can explore your account before committing. Provisioning a hosted Matrix computer requires active billing through Stripe because the private VPS has real runtime cost; there are no hosted runtime trials. Teams, enterprises, and universities can contact us for guided pilots." },
] as const;

export const COPYABLE_AGENT_SETUP_PROMPT = `Help me set up Matrix OS, my own cloud dev computer.

Steps:
1. Install the CLI: npm install -g @finnaai/matrix or brew install finnaai/tap/matrix.
2. Run matrix login --profile cloud. It opens a browser/device login that I will approve.
3. If no Matrix instance exists, tell me to sign up at https://app.matrix-os.com, then re-run login.
4. Verify with matrix doctor and matrix whoami.
5. Start my preferred coding agent inside Matrix with matrix run -it --session setup -- claude or matrix run -it --session setup -- codex. I will complete that tool's own login inside the remote terminal.

Do not scan my local machine for credentials or upload secret files. Everything authenticates through its own browser/device flow.`;
