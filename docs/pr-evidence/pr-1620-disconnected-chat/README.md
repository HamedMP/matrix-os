# PR 1620 — disconnected Web Desktop Chat composer

Captured from the production-built Web Desktop application at source commit
`7c62cc8996c2116abdb058ca8b266db032badd2e`. The isolated Playwright fixture
deliberately leaves the gateway unavailable while returning a ready speech
capability. It uses synthetic text and contains no account, credential, or
customer data.

![Disconnected Web Desktop Chat keeps its draft and voice input](./web-desktop.png)

The focused journey proves the state before taking the screenshot:

- Chat reports **Offline** and AI access unavailable.
- The canonical **Message chat** textarea remains editable and retains the
  typed draft shown in the image.
- **Start voice input** remains enabled.
- **Send** remains disabled while no AI harness is connected.

The capture is first generated under ignored `output/playwright/` and copied
here only after review. The local build used deterministic repository-installed
font files so a live font service could not change the capture.

## Reproduction

```bash
E2E_TEST_BYPASS=1 NEXT_PUBLIC_E2E_TEST_BYPASS=1 \
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2ktc2FmZS5leGFtcGxlLmNvbSQ= \
  NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up \
  NEXT_PUBLIC_POSTHOG_KEY=phc_local_evidence \
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_local_evidence \
  NEXT_PUBLIC_POSTHOG_HOST=https://eu.posthog.com NEXT_PUBLIC_POSTHOG_API_HOST=/relay \
  pnpm --filter shell build

PLAYWRIGHT_CHROMIUM_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  pnpm --filter shell exec playwright test e2e/screenshots.spec.ts \
  -g "disconnected Chat keeps its draft editable"
```
