import type { CanonicalChatRecord } from "@matrix-os/contracts";

import type { ProjectSummary } from "@/lib/requests/projects";

// Sample content of frames P1 to P4. The frames' times ("Updated today", "2h",
// "Mon") are relative, so they are counted back from one fixed moment: midday
// on Thursday 8 October 2026. The frames' chat counts are left out: the server
// has none to give.
export const SAMPLE_NOW = new Date(2026, 9, 8, 12, 0, 0);

function at(month: number, day: number, hour: number): string {
  return new Date(2026, month - 1, day, hour, 0, 0).toISOString();
}

function sampleProject(slug: string, name: string, updatedAt: string): ProjectSummary {
  return { id: `sample-project-${slug}`, slug, name, kind: "scratch", updatedAt };
}

export const SAMPLE_PROJECTS: ProjectSummary[] = [
  sampleProject("portfolio", "Portfolio", at(10, 8, 9)),
  sampleProject("matrix", "Matrix", at(10, 7, 16)),
  sampleProject("admin", "Admin", at(9, 30, 11)),
];

/** The project frames P2 to P4 show. */
export const SAMPLE_PROJECT = SAMPLE_PROJECTS[0];

function sampleChat(id: string, title: string, lastMessagePreview: string, activityAt: string): CanonicalChatRecord {
  return {
    chat: {
      id: `sample-chat-${id}`,
      ownerScope: { type: "personal", ownerId: "sample-owner" },
      title,
      lifecycle: "active",
      attention: "none",
      revision: 1,
      messageCount: 2,
      lastMessagePreview,
      createdAt: activityAt,
      updatedAt: activityAt,
    },
    projectId: SAMPLE_PROJECT.id,
  };
}

export const SAMPLE_PROJECT_CHATS: CanonicalChatRecord[] = [
  sampleChat("case-study", "Case study", "Draft ready to review", at(10, 8, 10)),
  sampleChat("landing-page-copy", "Landing page copy", "Three headline options", at(10, 7, 9)),
  sampleChat("pricing-page", "Pricing page", "Compared 4 competitors", at(10, 5, 12)),
  sampleChat("portfolio-site-build", "Portfolio site build", "Preview is live", at(9, 28, 12)),
];

export const SAMPLE_MODEL = { provider: "matrix", label: "Matrix AI · Sonnet 5" } as const;

/** The number on the Agents tab in the frames. */
export const SAMPLE_WAITING_COUNT = 2;
