# Retired artwork cleanup

Tracking: [ENG-321](https://linear.app/matrix-os/issue/ENG-321/remove-retired-matrix-icon-artwork).

Remove the 26 retired system PNGs, their unused Gallery duplicate, and 12 historical clay SVGs (nine Gallery sources and three identical host copies) from shipped sources. The shell continues to use its current `system-app-icons/v2` pack and versioned game artwork. Notes, Whiteboard, Profile and Social manifests select versioned transparent assets; Gallery failure recovery uses the semantic vector fallback before its final glyph.

Owner-selected artwork, owner homes and icon-style configuration stay authoritative. This change removes repository assets; it does not delete or overwrite customer files or rewrite Git history. No permissions, routes, persistence or app actions change.

For existing local development homes, gateway startup adds bundled icon files only when absent. Existing icon files, including symlinks, remain untouched; symlinked icon directories are rejected. A custom SVG also keeps priority over a missing same-name packaged PNG, while an unchanged bundled SVG may gain that PNG. This makes the refreshed launcher and app artwork available after a local restart without replacing owner selections.

Validation: hash inventory prevents old artwork copies returning; every manifest icon resolves to a shipped asset; Gallery image-error recovery retains each app's identity; current icon contracts and template-upgrade ownership tests pass. Review the resulting first-party selections across the supported OS views before shipping a host bundle.

The App Launcher now uses its own four-square asset across Web Canvas, Web Desktop, Electron Desktop and Web Mobile. App Gallery retains the storefront artwork, including explicit owner selections. Launcher navigation no longer inherits the Gallery app icon. Native Mobile has separate native navigation and is unaffected.
