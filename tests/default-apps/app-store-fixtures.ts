export const id = "11111111-1111-4111-8111-111111111111";
export const secondId = "22222222-2222-4222-8222-222222222222";
export const capabilities = { integrations: { required: [{ service: "gmail", actions: ["list_messages"] }], optional: [] }, permissions: [], tables: [{ name: "notes", columns: ["title"] }] };
export const listing = {
  id, slug: "sample-notes", name: "Sample Notes", tagline: "A shared starting point", category: "productivity", status: "live",
  publisher: { handle: "creator" }, version: "1.0.0", hasIcon: false, integrations: [{ service: "gmail", optional: false }], updatedAt: "2026-10-18T10:00:00Z",
  installCount: 8, activeInstallCount: 6, ratingAverage: 4, ratingCount: 2,
  local: { installed: false, updateAvailable: false }, description: "Organize your notes.",
  currentVersion: { id: secondId, version: "1.0.0", changelog: "Initial version", license: "MIT", publishedAt: "2026-10-18T10:00:00Z" },
  capabilities, capabilitiesDigest: "a".repeat(64), myRating: null, myInstall: null, isPublisher: false,
};
export const summary = () => { const { description, currentVersion, capabilities, capabilitiesDigest, myRating, myInstall, isPublisher, ...rest } = listing; return rest; };
export const draft = {
  id, sourceSlug: "my-notes", sourceName: "My notes", status: "ready", stage: "verify", ai: "completed", blockingFindings: 0,
  createdAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T10:00:00Z", expiresAt: "2026-10-25T10:00:00Z",
  findingsBefore: null, findingsAfter: { findings: [], blocking: false, truncated: false }, report: { ai: "completed", changes: [{ category: "personal", file: "src/App.tsx", summary: "Removed owner email" }] },
  listing: { slug: "sample-notes", name: "Sample Notes", tagline: "A shared starting point", description: "Organize notes", category: "productivity", version: "1.0.0", changelog: "Initial" },
  capabilities, changedFiles: [{ path: "src/App.tsx", change: "modified" }],
};
export const reviewItem = { versionId: secondId, listingId: id, listingSlug: "sample-notes", name: "Sample Notes", version: "1.0.0", status: "in_review", publisherHandle: "creator", isUpdate: false, submittedAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T10:00:00Z", scan: { blocking: false, high: 0, medium: 1, low: 0 }, integrationCount: 1 };
export const reviewDetail = { item: reviewItem, listing: { id, slug: "sample-notes", status: "pending", currentVersion: null }, proposed: { name: "Sample Notes", tagline: "A shared starting point", description: "Organize notes", category: "productivity", changelog: "Initial", license: "MIT" }, capabilities, previousCapabilities: null, scanReport: null, generalizationReport: draft.report, files: [{ path: "src/App.tsx", size: 40, sha256: "b".repeat(64), change: "added" }], removedFiles: [], events: [] };

export const draftSummary = () => { const { findingsBefore, findingsAfter, report, listing, capabilities, changedFiles, ...rest } = draft; return rest; };
