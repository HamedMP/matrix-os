---
status: completed
---

# Native installed-app launch parity

Expose the existing one-way `MatrixOS.openApp(name, path): void` request in Electron Desktop apps. Resolve only exact installed-app catalog roots or entry points, then use the normal renderer app-tab and authenticated embed launch flow. The request does not acknowledge that an app has finished opening.

## Safety and wiring

| Boundary | Authority | Validation |
| --- | --- | --- |
| App preload to main IPC | Registered app sender, current authentication generation, current gateway origin and app route, main frame | Strict bounded name/path payload; no external URLs, arbitrary files, or built-in destinations |
| Main catalog lookup | Current desktop bearer through `/api/apps` | Fixed origin URL, no redirects, ten-second timeout, bounded catalog response; exact app match |
| Main to renderer event | Current runtime slot and authentication generation | Validated installed-app metadata; signed-in renderer scope check before normal tab opening |

Bound concurrent launch requests and request frequency. Revalidate the sender after asynchronous lookup; reject retired or navigated views and authentication changes. Verify dependencies when registering the capability. Clear registrations on embed shutdown. Preserve existing app sandbox permissions and tokens.

## Delivery

Test-first coverage for preload void behavior, IPC main-frame/auth/route boundaries, unsafe/missing destinations, lookup failures, stale asynchronous results, resource bounds, and renderer scope/cleanup. Add focused main/renderer helpers; avoid unrelated bridge refactoring. Run focused tests and desktop typechecks. Obtain independent review and create a Conventional Commit PR. Public docs update will ship with the coordinated native app parity documentation PR in matrix-os-site. Actual approval gallery launch evidence follows a reviewed local build; no customer deployment or merge is included.

## Validation evidence

144 focused native bridge, preload, IPC contract, embed, and renderer tests pass. Desktop renderer and main TypeScript checks pass. The complete Electron production build passes. Independent source review found no actionable defects. Live approval-gallery behavior remains pending a reviewed local app build; no runtime rollout is authorized by this implementation.
