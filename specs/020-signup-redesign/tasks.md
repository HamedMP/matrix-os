# Tasks: Signup Redesign (Split-Screen with Features)

**Task range**: T700-T709
**Parallel**: YES -- fully independent. www/ only. No kernel/gateway/shell changes.
**Deps**: None. Uses existing Clerk auth.

## User Story

- **US-SU1**: "When judges/users land on signup, they immediately understand the value before creating an account"

## Architecture

Replace centered Clerk form with split-screen layout:
- **Left side** (60%): Feature showcase with animated sliders/cards showing what Matrix OS can do
- **Right side** (40%): Clerk SignUp/SignIn form, themed to match
- **Mobile**: Stacked -- feature highlights on top (condensed), form below

Key files:
- `www/src/app/signup/[[...signup]]/page.tsx` (redesign)
- `www/src/app/login/[[...login]]/page.tsx` (matching treatment)
- `www/src/components/auth/` (new -- shared auth layout components)

## Tests

No unit tests (UI component, tested manually + visual). But ensure:
- Clerk auth still works after redesign (login, signup, redirect to dashboard)
- Mobile responsive (test at 375px, 768px, 1440px widths)

## Implementation

- [ ] T700 [US-SU1] Create `www/src/components/auth/AuthLayout.tsx`:
  - Split-screen wrapper: `grid grid-cols-1 md:grid-cols-5` (3 cols features, 2 cols form)
  - Left: gradient background matching design guide (warm tones), feature content slot
  - Right: clean card background, centered Clerk form slot
  - Mobile: single column, features condensed above form
  - Full viewport height (`min-h-screen`)

- [ ] T701 [US-SU1] Create `www/src/components/auth/FeatureShowcase.tsx`:
  - Animated feature cards/slider showing 4-5 key capabilities:
    1. "Describe it, it builds it" -- app generation demo screenshot
    2. "Everything is a file" -- file tree visual
    3. "Self-healing OS" -- healer agent visual
    4. "Multi-channel" -- Telegram + Web + desktop icons
    5. "Your AI, your identity" -- @handle:matrix-os.com
  - Auto-rotating (5s per slide) with manual dots/arrows
  - Subtle animations (fade, slide)
  - Matrix OS logo + tagline at top

- [ ] T702 [US-SU1] Redesign `www/src/app/signup/[[...signup]]/page.tsx`:
  - Use `AuthLayout` wrapper
  - Left: `FeatureShowcase`
  - Right: `SignUp` Clerk component with themed appearance
  - Redirect: `afterSignUpUrl="/dashboard"`

- [ ] T703 [US-SU1] Redesign `www/src/app/login/[[...login]]/page.tsx`:
  - Same `AuthLayout` wrapper
  - Left: `FeatureShowcase` (same component, different heading: "Welcome back")
  - Right: `SignIn` Clerk component
  - Redirect: `afterSignInUrl="/dashboard"`

- [ ] T704 [US-SU1] Mobile responsive:
  - `< md`: Single column. Features: horizontal scroll of 3 highlight badges above form. No slider.
  - `>= md`: Full split-screen with slider
  - Touch-friendly: swipe on feature slides
  - Clerk form: full-width on mobile

- [ ] T705 [US-SU1] Polish:
  - Smooth page transition from LP "Get Started" button to signup
  - Loading state while Clerk initializes
  - Error states (Clerk unavailable, network error)
  - Dark mode support (inherit from design guide)

## Implications

- Clerk appearance customization is limited. Use `appearance.elements` for class overrides but can't fully restructure Clerk's DOM. Theme colors should match via CSS variables.
- Feature showcase content should align with LP messaging -- not contradict or introduce new claims.
- Split-screen is a common pattern (Linear, Vercel, etc.) -- proven to increase conversion.
- Future: A/B test feature order, add social proof (user count, testimonials), add demo video.

## Checkpoint

- [ ] Signup page shows features on left, Clerk form on right.
- [ ] Can complete signup flow and reach dashboard.
- [ ] Mobile: stacked layout, features condensed.
- [ ] Login page has matching treatment.
