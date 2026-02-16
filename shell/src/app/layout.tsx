import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";

export async function generateMetadata(): Promise<Metadata> {
  let handle = "";
  let displayName = "";
  try {
    const res = await fetch(`${gatewayUrl}/api/identity`, { next: { revalidate: 60 } });
    if (res.ok) {
      const data = await res.json();
      handle = data.handle ?? "";
      displayName = data.displayName ?? "";
    }
  } catch {
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
      statusBarStyle: "default",
      title: "Matrix OS",
    },
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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={`${inter.variable} ${jetbrainsMono.variable}`}>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
