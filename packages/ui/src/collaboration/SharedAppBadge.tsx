/** A visible, accessible marker shared by every app launcher. */
export function SharedAppBadge() {
  return <span role="img" aria-label="Shared app" title="Shared app"
    style={{ position: "absolute", top: -4, right: -4, width: 22, height: 22,
      display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%",
      background: "var(--primary, #434E3F)", color: "var(--primary-foreground, #FCFCF8)",
      border: "2px solid var(--background, #FCFCF8)", zIndex: 1 }}>
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3" /><path d="M3 21v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M18 15a6 6 0 0 1 3 5" />
    </svg>
  </span>;
}
