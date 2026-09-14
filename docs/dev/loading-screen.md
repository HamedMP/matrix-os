# Loading screen ownership

The platform may serve `getVpsBootPage()` before a customer VPS is routable. It is a server-rendered fallback, not a screen served by the VPS or Chat. Both default-runtime and explicit `/vm/:handle` routing preserve HTTP 503, no-store headers, and an eight-second reload while the computer becomes available.

The Figma reference is [Desktop-app, Loading 518:16718](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=518-16718). `@matrix-os/brand` owns the exported rabbit/outlined-wordmark mask, inverse surface, and four-second linear gradient. The asset is embedded from the exact export so loading never depends on a remote Figma URL, a font download, or an available VPS asset route.

`MatrixBootScreen` is the React presentation used by Web Canvas/Web Desktop hydration and Electron Desktop connection loading. The platform HTML fallback consumes the same stylesheet. Do not fork a separate logo, spinner, color palette, or loading wordmark in a surface adapter.

Keep provisioning/recovery explanations accessible without adding visible copy to the approved frame. This is indeterminate readiness, not a percentage or a promise that provisioning succeeded. Reduced-motion users receive the stationary gradient. Billing, failed-state recovery, authentication, readiness decisions, and retry timing remain owned by their existing controllers.

## Validation

- Compare the mark at 1512×982: approximately x=627, y=274, width=258, height=322.
- Check a narrow viewport for clipping, the four-second linear loop, and a static reduced-motion state.
- Run `tests/platform/vps-boot-page.test.ts`, `tests/shell/matrix-loading-screen.test.tsx`, `tests/brand/`, and the platform routing/Electron scaffold suites.
- Publishing a VPS host bundle alone does not update the platform fallback. A reviewed platform deployment is also required; do not deploy production as part of a visual preview.
