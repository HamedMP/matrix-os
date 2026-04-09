import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Matrix OS — Web 4",
  description:
    "The unified AI operating system. OS + messaging + social + AI + games. Everything is a file. The agent is the kernel.",
  openGraph: {
    title: "Matrix OS — Web 4",
    description: "The unified AI operating system.",
    siteName: "Matrix OS",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
