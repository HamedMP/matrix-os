export type SignupBillingHandoffLoadingSurface = "default" | "signup-handoff";

export function isSignupBillingHandoffValues(
  pathname: string,
  billingValues: readonly string[],
  handoffValues: readonly string[],
): boolean {
  return (
    pathname === "/" &&
    billingValues.length === 1 &&
    billingValues[0] === "setup" &&
    handoffValues.length === 1 &&
    handoffValues[0] === "signup"
  );
}

export function isSignupBillingHandoffSearch(
  pathname: string,
  searchParams: Pick<URLSearchParams, "getAll">,
): boolean {
  const billingValues = searchParams.getAll("billing");
  const handoffValues = searchParams.getAll("handoff");
  return isSignupBillingHandoffValues(pathname, billingValues, handoffValues);
}
