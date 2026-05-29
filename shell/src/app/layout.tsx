import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Inter, JetBrains_Mono, Cormorant_Garamond, Orbitron } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { getPostHogVisitorCountry } from "@matrix-os/observability/client";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/500.css";
import "./globals.css";
import { PostHogCookieBanner } from "@/components/PostHogCookieBanner";
import { PwaRegister } from "@/components/pwa/PwaRegister";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";

const inter = Inter({
  variable: "--font-inter",
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

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";

export async function generateMetadata(): Promise<Metadata> {
  let handle = "";
  let displayName = "";
  try {
    const res = await fetch(`${gatewayUrl}/api/identity`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      handle = data.handle ?? "";
      displayName = data.displayName ?? "";
    }
  } catch (err) {
    console.warn("[shell] identity metadata unavailable:", err instanceof Error ? err.message : String(err));
    // Gateway not available (build time or offline)
  }

  const title = handle ? `Matrix OS — @${handle}` : "Matrix OS";
  const description = displayName
    ? `${displayName}'s AI operating system`
    : "Your AI operating system";

  return {
    title,
    description,
    manifest: "/manifest.json",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "Matrix OS",
      // `startupImage` requires per-device {url, media} entries matching real
      // iPhone/iPad pixel dimensions; iOS ignores a single PNG. Omit until
      // proper per-device splash images are generated.
    },
    formatDetection: { telephone: false, email: false, address: false },
    openGraph: {
      title,
      description,
      siteName: "Matrix OS",
      type: "website",
      images: [{ url: "/og.png", width: 1469, height: 1526, alt: "Matrix OS" }],
    },
    twitter: {
      card: "summary",
      title,
      description,
      images: ["/og.png"],
    },
  };
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
    <ClerkProvider>
      <html lang="en" data-posthog-visitor-country={visitorCountry ?? undefined}>
        <body className={`${inter.variable} ${jetbrainsMono.variable} ${cormorant.variable} ${orbitron.variable}`}>
          {children}
          <PostHogCookieBanner visitorCountry={visitorCountry} />
          <PwaRegister />
          <InstallPrompt />
        </body>
      </html>
    </ClerkProvider>
  );
}
