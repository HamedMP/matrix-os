// Custom entry point: `expo-router/entry` enumerates every file under `app/`
// (including nested `_layout.tsx` files) via `require.context` as soon as it
// loads. That enumeration can reach shared components (e.g. `components/ui`)
// through a nested layout before `app/_layout.tsx`'s own top-of-file
// `import "@/lib/unistyles"` has run, so any module-scope
// `StyleSheet.create((theme) => ...)` call it triggers along the way throws
// "no theme has been selected yet". Configuring Unistyles here, before the
// router entry is required at all, guarantees `StyleSheet.configure` always
// runs first regardless of route require order.
import "@/lib/unistyles";
import "expo-router/entry";
