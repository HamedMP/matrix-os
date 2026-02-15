import type { Metadata } from "next";
import { WhitepaperContent } from "./content";

export const metadata: Metadata = {
  title: "Whitepaper | Matrix OS",
  description:
    "Matrix OS: a unified AI operating system where software is generated from conversation, persisted as files, and delivered through any channel. This whitepaper describes the architecture, vision, and novel computing paradigms behind Web 4.",
  openGraph: {
    title: "Matrix OS Whitepaper",
    description:
      "The architecture and vision behind the OS that builds itself.",
    url: "https://matrix-os.com/whitepaper",
    siteName: "Matrix OS",
    type: "article",
  },
};

export default function WhitepaperPage() {
  return <WhitepaperContent />;
}
