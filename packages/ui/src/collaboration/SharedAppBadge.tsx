import { organizationColor, organizationInitial } from "../share/organization-identity";

/**
 * Shared-app marker for every launcher. With the sharing organization known it
 * shows that org's initial on its colour (spec 2693 phase 3); otherwise the
 * generic people icon.
 */
export function SharedAppBadge({ appName, organization }: {
  appName?: string;
  organization?: { organizationId: string; name: string } | null;
} = {}) {
  const label = organization ? `${appName ?? "App"} — shared from ${organization.name}` : "Shared app";
  return <span role="img" aria-label={label} title={label}
    style={{ position: "absolute", top: -5, right: -5, width: 22, height: 22,
      display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%",
      background: organization ? organizationColor(organization.organizationId) : "var(--primary, #434E3F)",
      color: organization ? "#FFFFFF" : "var(--primary-foreground, #FCFCF8)",
      border: "2px solid var(--background, #FCFCF8)", zIndex: 1, fontSize: 10, fontWeight: 700, lineHeight: 1 }}>
    {organization ? <span aria-hidden="true">{organizationInitial(organization.name)}</span>
      : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="9" cy="8" r="3" /><path d="M3 21v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M18 15a6 6 0 0 1 3 5" />
      </svg>}
  </span>;
}
