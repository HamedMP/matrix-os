# Matrix OS design system

The approved Figma brand file is the upstream visual source. [`DESIGN.md`](../DESIGN.md)
is the canonical repository contract that translates it into implementation
rules. The documents in this directory expand individual foundations and
components without redefining them.

## Authority

1. [Approved Figma frame](https://www.figma.com/design/xPG2FeYRtC9owCKSVXCqWA/brand?node-id=1-846)
2. [`DESIGN.md`](../DESIGN.md)
3. Foundation and component guidance in this directory
4. Shared implementation tokens in `@matrix-os/brand`
5. Platform-local styling

When two levels disagree, fix the lower level; do not create another token set.
Changes to the visual source must be reconciled into `DESIGN.md` through a
focused brand PR before product code adopts them.

## Structure

```text
DESIGN.md                    canonical contract and compact token reference
design/
├── README.md                authority and contribution workflow
├── foundations/
│   ├── colors.md            palette, semantics, accessibility
│   ├── typography.md        family roles and type scale
│   ├── spacing.md           spacing and responsive layout
│   └── elevation.md         depth, overlays, and layering
└── components/
    ├── button.md
    ├── card.md
    ├── input.md
    ├── badge.md
    ├── dialog.md
    ├── navigation.md
    └── app-chrome.md
```

## Implementation

- New landing-adjacent, auth, onboarding, billing, and provisioning UI consumes
  `@matrix-os/brand` rather than platform-local hex values.
- Web, Electron, native desktop, and mobile may use native primitives, but must
  preserve the same token roles, content hierarchy, states, and outcomes.
- Cross-platform migration and parity testing are intentionally tracked outside
  the brand-contract PR.
- The public reference at `shell/public/brand-guidelines.html` is a rendered
  summary. It must agree with `DESIGN.md`, never become a separate authority.

## Principles

1. Expressive, not ornamental.
2. Calm, not empty.
3. Organic, not rustic.
4. Technical, not intimidating.
5. Bright, not childish.
