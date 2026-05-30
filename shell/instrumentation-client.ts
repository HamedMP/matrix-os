import { initializeShellPostHog } from "./src/lib/posthog-client";

initializeShellPostHog(document.documentElement.dataset.posthogVisitorCountry);
