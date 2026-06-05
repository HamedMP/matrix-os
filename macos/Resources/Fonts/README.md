# Bundled fonts — IBM Plex Sans + IBM Plex Mono

The OPERATOR design system (see `specs/086-macos-native-shell/design.md` §3) uses
two licensable families:

- **IBM Plex Sans** — display / chrome / titles (weights 400/500/600)
- **IBM Plex Mono** — terminal / data / badges (weights 400/600)

Both are open-source under the **SIL Open Font License 1.1**, so they can be
redistributed inside the app bundle.

## What to drop in

Place the `.otf` (or `.ttf`) files in this directory. Recommended minimal set:

```
macos/Resources/Fonts/
├── IBMPlexSans-Regular.otf
├── IBMPlexSans-Medium.otf
├── IBMPlexSans-SemiBold.otf
├── IBMPlexMono-Regular.otf
└── IBMPlexMono-SemiBold.otf
```

Download from:
- https://github.com/IBM/plex/releases (official IBM Plex release tarballs)
- or https://www.fontsquirrel.com/fonts/ibm-plex-sans

## Wiring into the app bundle

This is a SwiftPM executable today (`swift build`). Font registration depends on
how the app is finally packaged:

### A) When packaged as an `.app` with an `Info.plist`

Add the fonts to `Resources/Fonts/` in the bundle and declare the directory in
`Info.plist`:

```xml
<key>ATSApplicationFontsPath</key>
<string>Fonts</string>
```

`ATSApplicationFontsPath` is relative to the bundle's `Resources/` directory, so
a value of `Fonts` registers everything under `Contents/Resources/Fonts/`
automatically at launch — no manual `CTFontManagerRegister...` call needed.

### B) When loaded from a SwiftPM resource bundle (no Info.plist control)

If the executable is run outside a full `.app` (e.g. during `swift run` / tests),
register the fonts at startup with Core Text:

```swift
import CoreText

func registerBundledFonts() {
    for url in Bundle.module.urls(forResourcesWithExtension: "otf", subdirectory: "Fonts") ?? [] {
        var error: Unmanaged<CFError>?
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
    }
}
```

To make `Bundle.module` see these files, add a `.copy("../Resources/Fonts")`
(or `.process`) resource entry to the relevant target in `Package.swift`.

## Current fallback (no binaries shipped yet)

`Font.plexSans(_:weight:)` / `Font.plexMono(_:weight:)` in
`Sources/DesignSystem/DesignTokens.swift` check whether the family
(`IBMPlexSans` / `IBMPlexMono`) is registered. Until the binaries above are
dropped in and wired up, they **fall back to the system sans / monospaced font**
so the build never blocks on missing font files.

After adding the fonts, no code change is required — the helpers pick up the real
family automatically once it is registered. Verify the PostScript family name
matches `IBMPlexSans` / `IBMPlexMono`; if IBM ships them under a different
internal name, update `Font.PlexFamily` in `DesignTokens.swift`.
