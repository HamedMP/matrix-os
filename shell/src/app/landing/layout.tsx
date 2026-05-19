import { Orbitron, Instrument_Serif } from "next/font/google";

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-display",
  subsets: ["latin"],
  weight: "400",
});

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${orbitron.variable} ${instrumentSerif.variable}`} style={{ overflow: "visible" }}>{children}</div>;
}
