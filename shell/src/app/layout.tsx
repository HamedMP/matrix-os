import type { Metadata, Viewport } from "next";
import {
  Bricolage_Grotesque,
  Cormorant_Garamond,
  Geist,
  Geist_Mono,
  Instrument_Sans,
  Instrument_Serif,
  Inter,
  JetBrains_Mono,
  Orbitron,
} from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { platformShellAssetPath } from "@/lib/platform-shell-assets";
import { buildShellMetadata } from "@/lib/shell-metadata";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/500.css";
import "./globals.css";
import { PwaRegister } from "@/components/pwa/PwaRegister";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";
import { PostHogIdentify } from "@/components/PostHogIdentify";
import { Toaster } from "@/components/ui/sonner";
import { AppProviders } from "./providers";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  preload: false,
});

// Default shell sans — matches the landing site's --font-sans (Instrument Sans).
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
  preload: false,
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-serif-display",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  preload: false,
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  preload: false,
});

const cormorant = Cormorant_Garamond({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  preload: false,
});

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  preload: false,
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  preload: false,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
});

// Landing/brand display face. `block` prevents the Matrix loading wordmark from
// visibly swapping between a fallback face and Bricolage during hydration.
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  display: "block",
  preload: false,
});

export async function generateMetadata(): Promise<Metadata> {
  const metadata = await buildShellMetadata(process.env.GATEWAY_URL);
  return {
    ...metadata,
    // apple-touch-icon for iOS home-screen install. Next emits this from
    // icons.apple; reuse the existing app icon (iOS scales 192px down to its
    // expected 180px target).
    icons: {
      icon: [
        { url: platformShellAssetPath("/icon-192.png"), sizes: "192x192", type: "image/png" },
        { url: platformShellAssetPath("/icon-512.png"), sizes: "512x512", type: "image/png" },
      ],
      apple: [{
        url: platformShellAssetPath("/icon-192.png"),
        sizes: "192x192",
        type: "image/png",
      }],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Cover the notch/safe-area; let the layout opt into safe-area insets.
  viewportFit: "cover",
  // On-screen keyboard resizes the layout viewport instead of overlaying it,
  // so keyboard-aware UI (terminal key bar, toasts) tracks the real height.
  interactiveWidget: "resizes-content",
  // Brand-aligned status-bar tint: cream surface in light, forest in dark.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#E0E1CA" },
    { media: "(prefers-color-scheme: dark)", color: "#434E3F" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1";
  const renderDocument = (includePostHogIdentify: boolean) => (
    <html
      lang="en"
      data-matrix-self-hosted={selfHostedMode ? "1" : undefined}
      // Runtime replay kill switch: read on the server per request, so
      // setting POSTHOG_DISABLE_REPLAY and restarting matrix-shell stops
      // replay without rebuilding the bundle.
      data-posthog-disable-replay={process.env.POSTHOG_DISABLE_REPLAY ? "1" : undefined}
    >
      <body className={`${inter.variable} ${instrumentSans.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable} ${cormorant.variable} ${orbitron.variable} ${geistSans.variable} ${geistMono.variable} ${bricolage.variable}`}>
        <AppProviders>{children}</AppProviders>
        {includePostHogIdentify ? <PostHogIdentify /> : null}
        <PwaRegister />
        <InstallPrompt />
        <Toaster />
      </body>
    </html>
  );

  if (selfHostedMode) {
    return renderDocument(false);
  }

  return (
    // ClerkProvider reads NEXT_PUBLIC_CLERK_SIGN_IN_URL / _SIGN_UP_URL to keep
    // sign-in/up cross-links on the in-app routes. Those vars are baked at
    // build time (default /sign-in and /sign-up); without them Clerk falls
    // back to the hosted Account Portal (accounts.matrix-os.com).
    <ClerkProvider>
      {/* react-doctor-disable-next-line react-doctor/no-render-in-render -- pre-existing document helper selects whether PostHog identity is included while preserving one shared html/body definition; it returns only this request's static document tree and owns no component state. */}
      {renderDocument(true)}
    </ClerkProvider>
  );
}
