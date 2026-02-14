import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Caveat } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
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

export const metadata: Metadata = {
  metadataBase: new URL("https://matrix-os.com"),
  title: "Matrix OS | The OS That Builds Itself",
  description:
    "An AI-native operating system where software is generated in real time from conversation. Your OS, your messaging, your social network, your AI assistant, unified under one identity.",
  openGraph: {
    title: "Matrix OS",
    description: "The OS that builds itself. Describe what you need. It writes it into existence.",
    url: "https://matrix-os.com",
    siteName: "Matrix OS",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Matrix OS",
    description: "The OS that builds itself. Describe what you need. It writes it into existence.",
    creator: "@HamedMP",
  },
  keywords: [
    "AI operating system",
    "Claude Agent SDK",
    "AI-native OS",
    "self-building software",
    "Matrix OS",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={`${inter.variable} ${jetbrainsMono.variable} ${caveat.variable}`}>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
