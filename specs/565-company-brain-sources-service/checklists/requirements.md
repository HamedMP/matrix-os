# Specification Quality Checklist

Feature: [spec](../spec.md)

- [x] Outcome and bounded scope are explicit; deferred work (schedules, organization scopes, Slack capture reader, option lookups, a calendar handler method) is named, not implied.
- [x] The seven routes match `BRAIN_ROUTES` (methods, query keys, body bounds) and the service matches `BrainSourcesService`.
- [x] Connect order (parse, pin, identify, check, then create and save in one transaction), account pinning and the per-kind cap are specified.
- [x] Security architecture: auth matrix, input validation, error policy with not-found parity, credential handling.
- [x] Integration wiring: startup sequence, cross-package communication (none), config injection.
- [x] Failure modes: timeouts with values, concurrent access, crash recovery, error propagation.
- [x] Resource management: every limit with its value and file, no files written, no third-party data from this folder.
- [x] The five invariants, the test checkpoint (unit, end to end, manual), the review checklist and delivery are recorded.
