import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Caveat, Cormorant_Garamond } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
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

export const metadata: Metadata = {
  metadataBase: new URL("https://matrix-os.com"),
  title: "Matrix OS | AI-Native Operating System That Builds Itself",
  description:
    "Matrix OS is an AI-native operating system that generates software from conversation. Describe what you need and watch it appear on your desktop.",
  openGraph: {
    title: "Matrix OS | AI-Native Operating System",
    description: "The AI-native operating system that builds itself. Describe what you need. It writes it into existence.",
    url: "https://matrix-os.com",
    siteName: "Matrix OS",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Matrix OS | AI-Native Operating System",
    description: "The AI-native operating system that builds itself. Describe what you need. It writes it into existence.",
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <head>
          <link rel="dns-prefetch" href="https://clerk.matrix-os.com" />
          <link rel="dns-prefetch" href="https://eu.i.posthog.com" />
          <link rel="preconnect" href="https://clerk.matrix-os.com" crossOrigin="anonymous" />
          <link rel="preconnect" href="https://eu.i.posthog.com" crossOrigin="anonymous" />
        </head>
        <body className={`${inter.variable} ${jetbrainsMono.variable} ${caveat.variable} ${cormorant.variable}`}>
          {children}
          <Analytics />
        </body>
      </html>
    </ClerkProvider>
  );
}
