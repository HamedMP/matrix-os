# Specification Quality Checklist

Feature: [spec](../spec.md)

- [x] Outcome and bounded scope are explicit; deferred work (claims route slugs for MCP, MCP run-capability access,
      write tools, impact comment posting, stale and entity tools) is named, not implied.
- [x] Every tool lists its inputs and bounds, its limits, its gateway call and its HTTP route.
- [x] The answer format, length caps, left-out rule and untrusted-content handling are stated and match `brain_why`.
- [x] Status mapping from service errors and HTTP codes to fixed texts is complete; logs carry names only.
- [x] Security architecture, integration wiring, failure modes, resource limits, the five invariants, the integration
      test checkpoint, the review checklist and delivery are recorded; OS-view matrix N/A with a rationale.
