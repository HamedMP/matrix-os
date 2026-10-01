# Research: generated app craft

Reviewed official public product documentation on 2026-10-01. These sources explain observable workflows; they do not disclose private system prompts or prove which internal technique causes a model's design quality.

## Transferable practices

- [Lovable design guidance](https://docs.lovable.dev/features/design-guidance) compares rendered design directions and refines individual components while keeping a chosen direction. Matrix should preserve approved references, use a short app-specific brief, and make alternatives optional when the user's direction is already clear.
- [Lovable design systems](https://docs.lovable.dev/features/design-systems) combines components, tokens, guidelines, installation, and verification. Matrix's theme contract and reusable components should govern app chrome; an app's own direction governs task-specific layout and content.
- [Lovable browser testing](https://docs.lovable.dev/features/browser-testing) exercises rendered flows, viewports, screenshots, and browser errors. A successful build alone cannot establish app quality or persistence. Matrix evidence must come from its actual iframe/bridge environment.
- [Replit Design Canvas](https://docs.replit.com/design/canvas) supports design frames, annotations, live artifacts, and selected visual context for an agent. Matrix can use existing screenshots and direct visual feedback without adding a new editor to this change.
- [Replit DESIGN.md](https://docs.replit.com/design/design-md) keeps readable design guidance alongside token/component context. Matrix apps should keep a concise DESIGN.md recording their job, direction, tokens, interaction states, data model, and motion decisions.

These are implementation inferences from the documented products, not a claim that Matrix duplicates their internal prompts. Matrix keeps its own architecture: Vite/React/TypeScript, inherited theme tokens, manifest-declared storage, sandbox-safe MatrixOS.db, owner-controlled Postgres, and scoped capabilities.

## Validation approach

Instruction selection and installation are tested independently of aesthetic judgment. Design quality requires rendered review: task hierarchy, responsive windows, typography/spacing, authentic content, complete states, keyboard/touch behavior, reduced motion, and save-and-reopen persistence. Compare the same brief across distinct available Claude and Codex models; record the actual model, loaded skill snapshot, app paths, runtime, screenshots, and tests. Keep demos isolated from existing apps and avoid real financial or customer data.

Owner requested all three comparison themes: a calm project planner, personal finance, and a creative studio. Each model builds an app and a matching landing page. These live comparison builds extend the original implementation plan; they do not authorize a customer release or replacement of existing apps.
