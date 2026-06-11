export function isPreVpsBillingSetupRoute(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("billing") === "setup";
}
