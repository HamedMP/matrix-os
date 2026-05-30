import { initializeWwwPostHog } from "./src/lib/posthog-client";

initializeWwwPostHog(document.documentElement.dataset.posthogVisitorCountry);
