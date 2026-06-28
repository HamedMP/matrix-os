import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Inter, Instrument_Sans, JetBrains_Mono, Cormorant_Garamond, Orbitron } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { getPostHogVisitorCountry } from "@matrix-os/observability/client";
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

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// Default shell sans — matches the landing site's --font-sans (Instrument Sans).
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

const cormorant = Cormorant_Garamond({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["300", "400", "500"],
});

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export async function generateMetadata(): Promise<Metadata> {
  return buildShellMetadata(process.env.GATEWAY_URL);
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4ede0" },
    { media: "(prefers-color-scheme: dark)", color: "#3f4a3a" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const visitorCountry = getPostHogVisitorCountry(await headers());

  return (
    // ClerkProvider reads NEXT_PUBLIC_CLERK_SIGN_IN_URL / _SIGN_UP_URL to keep
    // sign-in/up cross-links on the in-app routes. Those vars are baked at
    // build time (default /sign-in and /sign-up); without them Clerk falls
    // back to the hosted Account Portal (accounts.matrix-os.com).
    <ClerkProvider>
      <html
        lang="en"
        data-posthog-visitor-country={visitorCountry ?? undefined}
        // Runtime replay kill switch: read on the server per request, so
        // setting POSTHOG_DISABLE_REPLAY and restarting matrix-shell stops
        // replay without rebuilding the bundle.
        data-posthog-disable-replay={process.env.POSTHOG_DISABLE_REPLAY ? "1" : undefined}
      >
        <body className={`${inter.variable} ${instrumentSans.variable} ${jetbrainsMono.variable} ${cormorant.variable} ${orbitron.variable}`}>
          {children}
          <PostHogIdentify />
          <PwaRegister />
          <InstallPrompt />
        </body>
      </html>
    </ClerkProvider>
  );
}
