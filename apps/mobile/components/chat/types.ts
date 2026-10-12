/** An app on the computer that a reply refers to, as its result card shows it. */
export interface ChatResultApp {
  /** Names the app to the app preview route. */
  slug: string;
  /** Which installed copy the preview opens, as the Apps screen names it. */
  runtimeSlug: string;
  name: string;
  /** The card's second line. */
  detail: string;
}
