# Tasks: Demo Polish + Recording

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T057-T064 (from original plan)

## Implementation

- [ ] T057 [P] Pre-seed 2-3 demo apps in `home/apps/` -- expense tracker, notes, dashboard. Pre-built for fast demo (avoids 30-90s generation wait).

- [ ] T058 [P] Implement `CodeEditor.tsx` in `shell/components/` -- Monaco editor for viewing/editing any file (stretch)

- [ ] T059 [P] Implement `FileBrowser.tsx` in `shell/components/` -- tree view of the file system (stretch)

- [ ] T060 [US6] (STRETCH) Voice gateway -- Web Speech API for input, text-to-speech for output

- [ ] T061 Validate dynamic agent creation -- test that kernel can write a new `~/agents/custom/*.md` file and spawn it within the same session

- [ ] T062 Write demo script matching the 7-act narrative (see plan.md). Test cross-module data flow (expense-cli -> expense-web).

- [ ] T063 Create `git tag demo-safe` before recording

- [ ] T064 Record 3-minute demo video

## Checkpoint

Full demo runs smoothly. All 7 acts work end-to-end. Pre-seeded apps load instantly. Telegram channel responds. Heartbeat fires. Self-healing works on camera.
