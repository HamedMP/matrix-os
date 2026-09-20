# Data model

ProjectConfig / ProjectRecord: add optional `pinned: boolean` (absent means false). Allow mutations of name (trimmed 1–128), description (trimmed 0–1000) and pinned only. Preserve id, slug, localPath, addedAt, ownership and all related Chat references. Patch writes updatedAt under the project lock. Active-only mutations; archived/deleting projects return not found.

Renderer derives stable pin-first order from canonical projects. Pending/error state is transient, bounded to one mutation per mounted action controller; runtime changes invalidate pending results. Edit draft survives errors.
