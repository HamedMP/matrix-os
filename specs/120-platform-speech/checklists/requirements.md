# Specification Quality Checklist: Platform Speech

Created: 2026-09-10  
Feature: [spec.md](../spec.md)

- [x] User-approved priorities and all original stories are retained.
- [x] Record/stop/transcribe is the first release; live dictation and interview phases are distinct.
- [x] User value, edge cases, measurable outcomes and acceptance scenarios are specified.
- [x] Platform-held OpenAI credential and interchangeable provider selection are explicit.
- [x] Source inventory covers chat, kernel transcription, channel notes, legacy services and Gemini Vocal.
- [x] Consolidation includes removal/migration criteria, not another parallel implementation.
- [x] Technical implementation detail is separated into research and plan documents.
- [x] Endpoint authentication, ownership, limits, timeout, retention and metering plans are included.
- [x] Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile scopes are explicit.
- [x] Native Mobile reply-streaming repair remains a separate delivery workstream.
- [x] Public documentation PR is an explicit implementation deliverable.
- [x] No provider credential, private customer identifier or raw customer transcript is included.
- [x] Live-provider feasibility is distinguished from a completed runtime spike.
- [x] No blocking product clarification is outstanding; operator allowance/unknown-usage policy and media/device/model spikes are recorded as explicit implementation gates.

## Review result

Specification is ready for implementation planning. The design is not an implemented consolidation. Prior uncommitted experimental code remains separate and must be revised to the platform boundary before use. Provider feasibility was checked against official documentation; no live audio or paid provider request was made.

## Self-review follow-up

- [x] Runtime-bound auth, operation-specific funding, dispatch claims and cancellation races are specified.
- [x] Client draft generations and source-audio retention have concrete migration semantics.
- [x] Mobile repair and future live providers do not block the batch vertical slice.
- [ ] Bounded media validation and actual account usage contract have passed a spike.
- [ ] Allowance sources, reconciliation policy and deployment-wide resource caps are configured and tested.
- [ ] Packaged capture and Native Mobile transport have device evidence.

The unchecked items are implementation gates, not completed validation or missing product approval. See [implementation.md](../implementation.md).
