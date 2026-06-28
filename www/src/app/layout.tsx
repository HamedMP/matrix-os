import type { Metadata } from "next";
import { headers } from "next/headers";
import { ClerkProvider } from "@clerk/nextjs";
import {
  Inter,
  Instrument_Sans,
  Instrument_Serif,
  JetBrains_Mono,
  Caveat,
  Cormorant_Garamond,
  Orbitron,
} from "next/font/google";
import { getPostHogVisitorCountry } from "@matrix-os/observability/client";
import { PostHogCookieBanner } from "@/components/PostHogCookieBanner";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const instrumentSans = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-serif-display",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

const caveat = Caveat({
  variable: "--font-caveat",
  subsets: ["latin"],
});

const cormorant = Cormorant_Garamond({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  style: ["normal", "italic"],
});

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const socialTitle = "Matrix OS | Your Cloud Computer and AI Workspace, Anywhere";
const socialDescription =
  "Open any browser to reach your cloud computer, files, apps, and AI workspace instantly wherever you work on every device.";

export const metadata: Metadata = {
  metadataBase: new URL("https://matrix-os.com"),
  title: "Matrix OS | AI-Native Operating System That Builds Itself",
  description:
    "Matrix OS is an AI-native operating system that generates software from conversation. Describe what you need and watch it appear on your desktop.",
  openGraph: {
    title: socialTitle,
    description: socialDescription,
    url: "https://matrix-os.com",
    siteName: "Matrix OS",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: socialTitle,
    description: socialDescription,
    creator: "@HamedMP",
  },
  keywords: [
    "AI-native operating system",
    "AI operating system",
    "Claude Agent SDK",
    "self-building software",
    "Matrix OS",
    "generative OS",
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const visitorCountry = getPostHogVisitorCountry(await headers());

  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-posthog-visitor-country={visitorCountry ?? undefined}
      data-posthog-disable-replay={process.env.POSTHOG_DISABLE_REPLAY ? "1" : undefined}
    >
      <head>
        <link rel="dns-prefetch" href="https://eu.i.posthog.com" />
        <link rel="preconnect" href="https://eu.i.posthog.com" crossOrigin="anonymous" />
      </head>
      <body className={`${inter.variable} ${instrumentSans.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable} ${caveat.variable} ${cormorant.variable} ${orbitron.variable}`}>
        <ClerkProvider>
          {children}
          <PostHogCookieBanner visitorCountry={visitorCountry} />
        </ClerkProvider>
      </body>
    </html>
  );
}
