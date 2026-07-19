// Per-project shell view state (FR: project-centric shell). Persisted under
// the `projectViews` local-state key so each project reopens on the view the
// operator last used. Only bounded, recreatable UI refs live here — never
// transcripts, summaries, or credentials.
import { ThreadIdSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";

export const ProjectViewSchema = z.enum(["board", "chats"]);
export type ProjectView = z.infer<typeof ProjectViewSchema>;

export const ProjectViewEntrySchema = z
  .object({
    view: ProjectViewSchema,
    selectedThreadId: ThreadIdSchema.nullable(),
    touchedAt: z.number().int().nonnegative(),
  })
  .strict();

export type ProjectViewEntry = z.infer<typeof ProjectViewEntrySchema>;

export const ProjectViewsStateSchema = z
  .object({
    runtimeScope: z.string().min(1).max(512).optional(),
    views: z.record(z.string().min(1).max(256), ProjectViewEntrySchema),
  })
  .strict();

export type ProjectViewsState = z.infer<typeof ProjectViewsStateSchema>;
