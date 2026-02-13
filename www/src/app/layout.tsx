import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Caveat } from "next/font/google";
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
  title: "Matrix OS -- The Operating System That Builds Itself",
  description:
    "An AI-native operating system where software is generated in real time from conversation. Your OS, your messaging, your social network, your AI assistant -- unified under one identity.",
  openGraph: {
    title: "Matrix OS",
    description: "The Operating System That Builds Itself",
    url: "https://matrix-os.com",
    siteName: "Matrix OS",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Matrix OS",
    description: "The Operating System That Builds Itself",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${jetbrainsMono.variable} ${caveat.variable}`}>
        {children}
      </body>
    </html>
  );
}
