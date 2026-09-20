/** Only controller-owned, exact messages are allowed into user-facing state. */
export function settingsErrorPresentation(error: string | null): { title: string; message: string } {
  switch (error) {
    case "Sign-in started. Use Continue to open it again.":
      return { title: "Finish signing in", message: error };
    case "Provider settings changed. Latest settings were loaded.":
      return { title: "Settings changed", message: error };
    case "Provider settings are unavailable.":
      return { title: "Settings unavailable", message: error };
    default:
      return { title: "Settings could not be updated", message: "Changes were not saved. Refresh and try again." };
  }
}
