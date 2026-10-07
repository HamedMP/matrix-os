import type { EditionMessage, EditionSource, MailBridge } from "./types";
export const demoSources: EditionSource[] = [
  {
    id: "demo-personal",
    connectionId: "fictional-personal",
    email: "alex@example.test",
    label: "Personal reading",
    scope: "personal",
    state: "ready",
  },
  {
    id: "demo-work",
    connectionId: "fictional-work",
    email: "alex@studio.example.test",
    label: "Studio",
    scope: "work",
    state: "ready",
  },
];
const copy = [
  [
    "The art of noticing",
    "The Sunday Edit",
    "A slower kind of attention. A field guide to finding the extraordinary in an ordinary afternoon.",
  ],
  [
    "A city made for wandering",
    "Elsewhere",
    "The streets, small bookshops, and morning rituals that make a place feel like home.",
  ],
  [
    "Good work takes its time",
    "Studio Notes",
    "On making fewer things, more carefully. A letter about craft, patience, and creative momentum.",
  ],
  [
    "The case for a smaller internet",
    "Common Ground",
    "There is a quieter corner of the web. Here is how to find it, and how to make it your own.",
  ],
  [
    "Notes from the garden",
    "Fieldwork",
    "What the seasons teach us about starting again. Five observations from a late summer garden.",
  ],
  [
    "An invitation to slow down",
    "Sunday Letters",
    "A little room for curiosity, long conversations, and the books you meant to finish.",
  ],
];
export const demoMessages: EditionMessage[] = copy.map(
  ([subject, publication, excerpt], i) => ({
    id: "demo-" + i,
    sourceId: i === 2 ? "demo-work" : "demo-personal",
    subject,
    publication,
    sender: publication,
    receivedAt: `2026-10-0${7 - i}T09:00:00Z`,
    excerpt,
    text: `${excerpt}\n\nThere is a moment, just before the day gets busy, when everything feels possible. The light is still soft. The coffee is warm. For a few minutes, the world asks very little of us.\n\nThis week, we have been thinking about the things worth keeping. The ideas that stay with us after the screen is closed. The places we return to. The people who make an ordinary afternoon feel like something more.\n\nStart with one small thing. A walk without a destination. A page in a notebook. An old favorite, read again. Let attention be the beginning, and see where it takes you.\n\nUntil next time,\n${publication}`,
    contentVersion: "fictional-1",
    classification: i === 5 ? "review" : "newsletter",
    saved: i === 3,
    read: i === 2,
    progress: i === 2 ? 1 : 0,
    revision: 1,
    readingRevision: 1,
  }),
);
/** Fictional preview has no access to a connected account or provider mutation. */
export function createDemoBridge(): MailBridge {
  const messages = demoMessages.map((m) => ({ ...m }));
  return async (action, payload = {}) => {
    if (action === "sources")
      return { sources: demoSources, cacheScope: "fictional-preview" };
    if (action === "messages") return { messages };
    if (action === "message") return messages.find((m) => m.id === payload.id);
    if (action === "reading" || action === "correct") {
      const m = messages.find((m) => m.id === payload.id);
      if (!m) throw new Error("Edition unavailable");
      if (action === "reading")
        Object.assign(m, {
          ...(typeof payload.saved === "boolean"
            ? { saved: payload.saved }
            : {}),
          ...(typeof payload.read === "boolean" ? { read: payload.read } : {}),
          ...(typeof payload.progress === "number"
            ? { progress: payload.progress }
            : {}),
        });
      else
        m.classification =
          payload.classification as EditionMessage["classification"];
      if (action === "reading") m.readingRevision++;
      else m.revision++;
      return { ...m };
    }
    if (action === "sync")
      return { state: "complete", savedCount: 6, classifiedCount: 6 };
    throw new Error("Email changes are unavailable in the fictional preview.");
  };
}
