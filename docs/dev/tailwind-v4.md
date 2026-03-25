# Tailwind CSS v4 Reference

## Key Differences from v3

- **No `tailwind.config.js`** -- all configuration happens in CSS
- **`@import "tailwindcss"`** replaces `@tailwind base/components/utilities`
- **`@plugin`** replaces `require()` in config for loading plugins
- **`@theme`** replaces `theme.extend` in config
- **`@utility`** replaces `@layer utilities` / `@layer components`
- **`@custom-variant`** replaces custom variant plugins

## Plugin Integration

V3 (old):
```js
// tailwind.config.js
module.exports = {
  plugins: [require("@tailwindcss/typography")],
};
```

V4 (current):
```css
/* globals.css */
@import "tailwindcss";
@plugin "@tailwindcss/typography";
```

**Important:** The `@tailwindcss/typography` package is NOT bundled with `tailwindcss`. It must be listed in `package.json` as a dependency so CI can install it. The `@plugin` directive resolves the package at build time via PostCSS.

## Typography Plugin

- Package: `@tailwindcss/typography` (v0.5.16+ supports v4)
- Load via: `@plugin "@tailwindcss/typography"`
- Provides `prose` utility classes for markdown rendering
- Usage: `<div className="prose prose-sm dark:prose-invert">`

## Common Mistakes

1. **Don't use `@import "@tailwindcss/typography"`** -- use `@plugin` for JS plugins
2. **Don't remove the package from package.json** -- `@plugin` still needs the npm package installed
3. **`@import` is for CSS files, `@plugin` is for JS plugins** -- they are different directives

## Other Changes

- `shadow-sm` -> `shadow-xs`, `shadow` -> `shadow-sm`
- `rounded-sm` -> `rounded-xs`, `rounded` -> `rounded-sm`
- `outline-none` -> `outline-hidden`
- `ring` -> `ring-3` (default width changed from 3px to 1px)
- Default border color changed from `gray-200` to `currentColor`
- Variant stacking order: left-to-right (was right-to-left)
- CSS variables: `bg-(--brand-color)` replaces `bg-[--brand-color]`
