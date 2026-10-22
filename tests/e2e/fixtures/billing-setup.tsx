import React from "react";
import { createRoot } from "react-dom/client";
import { OnboardingGate } from "../../../shell/src/components/OnboardingGate";
import { Settings } from "../../../shell/src/components/Settings";
import { Button } from "../../../shell/src/components/ui/button";

// Only authentication and unrelated Settings destinations are synthetic.
// The billing entrypoint, gate, status hook, plan/tool selectors and checkout
// are production components. All HTTP responses are supplied by Playwright.
const params = new URLSearchParams(window.location.search);
const has = () => false;
const getToken = async () => "fixture-token";
export function useAuth() {
  return { isLoaded: true, isSignedIn: true, userId: "billing-design-fixture", has, getToken };
}
export function useUser() {
  return { user: { publicMetadata: { selectedPlan: `matrix_${params.get("plan") ?? "starter"}` } } };
}
export function usePathname() { return window.location.pathname; }
export function useSearchParams() { return new URLSearchParams(window.location.search); }
export function useRouter() { return { replace: () => undefined }; }
export function Image({ fill, priority: _priority, unoptimized: _unoptimized, ...props }: Record<string, unknown>) {
  return <img {...props} style={fill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : undefined} />;
}
export function Link({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props}>{children}</a>;
}
export function UserButton() {
  return <button className="flex min-h-12 w-full items-center gap-3 rounded-2xl border border-border/60 bg-card px-3 text-sm font-semibold shadow-sm">Account</button>;
}
export function Empty() { return null; }
export function useGettingStartedBlocker() {}
export function capturePostHogEvent() {}
export function capturePostHogLog() {}

const normalSettings = params.has("settings");
createRoot(document.getElementById("root")!).render(
  <>
    {normalSettings
      ? <><img src="/wallpapers/matrix-dusk.webp" alt="" className="fixed inset-0 h-full w-full object-cover" /><Settings open onOpenChange={() => {}} defaultSection="billing" /></>
      : <OnboardingGate platformSessionActive={false}><div /></OnboardingGate>}
    <div id="control-probes" hidden>
      <Button disabled>Disabled action</Button>
      <Button disabled variant="ghost">Disabled ghost</Button>
      <input disabled aria-label="Disabled field" />
    </div>
  </>,
);
