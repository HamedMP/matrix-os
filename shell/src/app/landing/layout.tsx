import { Orbitron } from "next/font/google";

const orbitron = Orbitron({
  variable: "--font-orbitron",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return <div className={orbitron.variable} style={{ overflow: "visible" }}>{children}</div>;
}
