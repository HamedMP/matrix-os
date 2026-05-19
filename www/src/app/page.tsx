import { SignedIn, SignedOut } from "@clerk/nextjs";
import { ArrowRightIcon, GithubIcon, BrainCircuitIcon, GlobeIcon, ShieldCheckIcon } from "lucide-react";

const faqItems = [
  {
    q: "What happens to my data?",
    a: "Everything is a file on your system. Apps, data, settings, your AI's memory. Copy a folder to back up your entire OS. No vendor lock-in. No opaque databases.",
  },
  {
    q: "Do I need to code?",
    a: "No. You describe what you want in plain English. The AI writes the code, saves it as a file, and it appears on your desktop. You never touch a line of code unless you want to.",
  },
  {
    q: "What if something breaks?",
    a: "The OS heals itself. A built-in agent monitors for problems and fixes them automatically. Everything is versioned with git, so nothing is ever truly lost.",
  },
  {
    q: "Is it private?",
    a: "You can self-host it on your own server. Your data never leaves your machine unless you want it to. Open source, MIT licensed, auditable by anyone.",
  },
  {
    q: "How is this different from ChatGPT?",
    a: "ChatGPT is a chat window that forgets you. Matrix OS is an operating system that remembers you, builds software for you, runs on every device, and works while you sleep.",
  },
  {
    q: "What does it cost?",
    a: "Free to start. The platform is open source. You bring your own AI key, or use our hosted instances. No surprise bills, no credit-burning loops.",
  },
];

const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: "Matrix OS",
      url: "https://matrix-os.com",
      logo: "https://matrix-os.com/rabbit.svg",
      sameAs: [
        "https://github.com/HamedMP/matrix-os",
        "https://x.com/joinmatrixos",
        "https://discord.gg/cSBBQWtPwV",
      ],
    },
    {
      "@type": "SoftwareApplication",
      name: "Matrix OS",
      url: "https://matrix-os.com",
      applicationCategory: "OperatingSystem",
      operatingSystem: "Web, Docker",
      description:
        "An AI-native operating system that generates software from conversation. Describe what you need and watch it appear on your desktop.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
    {
      "@type": "FAQPage",
      mainEntity: faqItems.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
  ],
});

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[var(--stone)] text-[var(--ink)]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <Nav />
      <Hero />
      <ProofBar />
      <Screenshot />
      <About />
      <NetworkSection />
      <HowItWorks />
      <WhyDifferent />
      <CTA />
      <Footer />
    </div>
  );
}

/* ─────────────────────────────── Nav ─────────────────────────────── */

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[var(--stone)]/90 backdrop-blur-sm border-b border-[var(--pebble)]/50">
      <div className="mx-auto max-w-[1200px] px-6 h-14 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5">
          <img src="/rabbit.svg" alt="Matrix OS" className="size-5" />
          <span className="tracking-[0.12em] text-[14px] font-semibold text-[var(--ink)] uppercase">
            Matrix OS
          </span>
        </a>

        <div className="hidden md:flex items-center gap-8">
          <a href="#about" className="text-sm text-[var(--ink)]/60 hover:text-[var(--ink)] transition-colors">About</a>
          <a href="#features" className="text-sm text-[var(--ink)]/60 hover:text-[var(--ink)] transition-colors">Features</a>
          <a href="/technical" className="text-sm text-[var(--ink)]/60 hover:text-[var(--ink)] transition-colors">Technical</a>
          <a href="/docs" className="text-sm text-[var(--ink)]/60 hover:text-[var(--ink)] transition-colors">Docs</a>
          <a href="https://github.com/HamedMP/matrix-os" target="_blank" rel="noopener noreferrer"
            className="text-sm text-[var(--ink)]/60 hover:text-[var(--ink)] transition-colors">GitHub</a>
        </div>

        <div className="flex items-center gap-3">
          <SignedOut>
            <a href="https://app.matrix-os.com"
              className="inline-flex items-center gap-1.5 bg-[var(--forest)] text-[var(--stone)] text-sm px-4 py-2 rounded-full hover:bg-[var(--ink)] transition-colors">
              Join the waitlist
              <ArrowRightIcon className="size-3.5" />
            </a>
          </SignedOut>
          <SignedIn>
            <a href="https://app.matrix-os.com" target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 bg-[var(--forest)] text-[var(--stone)] text-sm px-4 py-2 rounded-full hover:bg-[var(--ink)] transition-colors">
              Open Matrix OS
              <ArrowRightIcon className="size-3.5" />
            </a>
          </SignedIn>
        </div>
      </div>
    </nav>
  );
}

/* ─────────────────────────────── Hero ─────────────────────────────── */

function Hero() {
  return (
    <section className="relative min-h-screen flex items-center px-6 overflow-hidden">
      <div className="mx-auto max-w-[1200px] w-full grid md:grid-cols-2 gap-12 items-center">
        <div className="relative z-10">
          <h1
            className="text-3xl sm:text-4xl md:text-5xl font-light leading-[1.15] tracking-[-0.01em] mb-6"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            Your computer, in the cloud.
          </h1>
          <p className="text-base md:text-lg text-[var(--ink)]/50 leading-relaxed max-w-[480px] mb-10">
            A personal computer that lives in the cloud. Open any browser, sign in, and everything is ready — your apps, your files, your way.
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            <SignedOut>
              <a href="https://app.matrix-os.com"
                className="inline-flex items-center gap-2 bg-[var(--forest)] text-[var(--stone)] text-sm px-6 py-2.5 rounded-full hover:bg-[var(--ink)] transition-colors font-medium">
                Get early access
                <ArrowRightIcon className="size-3.5" />
              </a>
            </SignedOut>
            <SignedIn>
              <a href="https://app.matrix-os.com" target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-2 bg-[var(--forest)] text-[var(--stone)] text-sm px-6 py-2.5 rounded-full hover:bg-[var(--ink)] transition-colors font-medium">
                Open Matrix OS
                <ArrowRightIcon className="size-3.5" />
              </a>
            </SignedIn>
            <a href="https://github.com/HamedMP/matrix-os" target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-[var(--ink)]/50 hover:text-[var(--ink)] transition-colors">
              <GithubIcon className="size-4" />
              Open source
            </a>
          </div>
        </div>

        <div className="flex items-center justify-center pointer-events-none">
          <video autoPlay loop muted playsInline src="/hero-loop.mp4" poster="/images/app-screenshot.jpg"
            className="max-w-none rounded-lg" style={{ height: "min(55vh, 500px)", width: "auto" }} />
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── Proof Bar ───────────────────────────── */

function ProofBar() {
  return (
    <section className="py-8 px-6">
      <div className="mx-auto max-w-[900px]">
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-[var(--ink)]/35 font-mono">
          <span>MIT licensed</span>
          <span className="text-[var(--pebble)]">/</span>
          <span>Claude Opus 4.6</span>
          <span className="text-[var(--pebble)]">/</span>
          <span>2,800+ tests</span>
          <span className="text-[var(--pebble)]">/</span>
          <span>6 channels</span>
          <span className="text-[var(--pebble)]">/</span>
          <span>Free to start</span>
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────── Screenshot ──────────────────────────── */

function Screenshot() {
  return (
    <section id="preview" className="py-24 px-6">
      <div className="mx-auto max-w-[1100px]">
        <div className="rounded-xl overflow-hidden shadow-2xl shadow-[var(--ink)]/10 border border-[var(--pebble)]">
          <picture>
            <source srcSet="/images/screenshot-desktop.webp" type="image/webp" />
            <img src="/images/app-screenshot.jpg" alt="Matrix OS desktop" className="w-full h-auto" loading="lazy" />
          </picture>
        </div>
        <div className="mt-10 max-w-2xl mx-auto text-center">
          <h3
            className="text-xl font-normal mb-3"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            A real desktop, in your browser
          </h3>
          <p className="text-[var(--ink)]/55 leading-relaxed">
            Your Matrix instance isn&apos;t just a dashboard — it&apos;s a full visual operating system. A desktop with windows, a dock, wallpapers, and all your apps arranged exactly how you like. It feels like sitting at your own computer, except it runs in the cloud and follows you everywhere.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── About ──────────────────────────────── */

function About() {
  return (
    <section id="about" className="py-24 px-6">
      <div className="mx-auto max-w-[1100px]">
        <div className="grid md:grid-cols-[1fr_1.2fr] gap-16 md:gap-24">
          <div>
            <p className="text-sm tracking-[0.15em] uppercase text-[var(--moss)] mb-4 font-medium">About</p>
            <h2
              className="text-3xl sm:text-4xl font-light leading-tight tracking-[-0.01em]"
              style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
            >
              Your computer, in the cloud.
            </h2>
          </div>
          <div className="flex flex-col gap-6 md:pt-6">
            <p className="text-[var(--ink)]/55 leading-relaxed">
              Matrix OS gives you a full personal computer that runs in the cloud. Open any browser, sign in, and you have your desktop — your apps, your files, your settings — ready to go. No installs, no setup, nothing to maintain.
            </p>
            <p className="text-[var(--ink)]/55 leading-relaxed">
              Just tell it what you need. An AI assistant builds your apps, organizes your workspace, and keeps everything running. It works on any device, from anywhere, and picks up right where you left off.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ──────────────────── Network Visualization ─────────────────────── */

const devices = [
  { x: 200, y: 52, anim: "device-blink", delay: "0s", label: "Mobile", icon: "smartphone" as const },
  { x: 338, y: 115, anim: "device-steady", delay: "1s", label: "Laptop", icon: "laptop" as const },
  { x: 340, y: 280, anim: "device-blink", delay: "3s", label: "Tablet", icon: "tablet" as const },
  { x: 200, y: 348, anim: "device-steady", delay: "0.5s", label: "Computer", icon: "monitor" as const },
  { x: 60, y: 280, anim: "device-blink", delay: "5s", label: "Friend's PC", icon: "laptop" as const },
  { x: 62, y: 115, anim: "device-steady", delay: "2s", label: "Browser", icon: "globe" as const },
];

function DeviceIcon({ icon, x, y }: { icon: string; x: number; y: number }) {
  const stroke = "var(--forest)";
  switch (icon) {
    case "smartphone":
      return <rect x={x - 5} y={y - 8} width="10" height="16" rx="2" fill="none" stroke={stroke} strokeWidth="1.2" opacity="0.7" />;
    case "laptop":
      return (<>
        <rect x={x - 9} y={y - 6} width="18" height="12" rx="1.5" fill="none" stroke={stroke} strokeWidth="1.2" opacity="0.7" />
        <line x1={x - 11} y1={y + 7} x2={x + 11} y2={y + 7} stroke={stroke} strokeWidth="1.2" opacity="0.7" />
      </>);
    case "tablet":
      return <rect x={x - 7} y={y - 9} width="14" height="18" rx="2" fill="none" stroke={stroke} strokeWidth="1.2" opacity="0.7" />;
    case "monitor":
      return (<>
        <rect x={x - 10} y={y - 8} width="20" height="14" rx="1.5" fill="none" stroke={stroke} strokeWidth="1.2" opacity="0.7" />
        <line x1={x} y1={y + 6} x2={x} y2={y + 9} stroke={stroke} strokeWidth="1.2" opacity="0.7" />
        <line x1={x - 5} y1={y + 9} x2={x + 5} y2={y + 9} stroke={stroke} strokeWidth="1.2" opacity="0.7" />
      </>);
    case "globe":
      return (
        <g opacity="0.7">
          <circle cx={x} cy={y} r="8" fill="none" stroke={stroke} strokeWidth="1.2" />
          <ellipse cx={x} cy={y} rx="4" ry="8" fill="none" stroke={stroke} strokeWidth="0.8" />
          <line x1={x - 8} y1={y} x2={x + 8} y2={y} stroke={stroke} strokeWidth="0.8" />
        </g>
      );
    default:
      return null;
  }
}

function NetworkSection() {
  return (
    <section id="features" className="py-24 px-6">
      <style>{`
        @keyframes net-flow { 0% { stroke-dashoffset: 24; } 100% { stroke-dashoffset: 0; } }
        @keyframes center-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
        @keyframes center-ring { 0% { r: 44; opacity: 0.3; } 100% { r: 80; opacity: 0; } }
        @keyframes glow-breathe { 0%, 100% { opacity: 0.2; } 50% { opacity: 0.45; } }
        @keyframes device-online { 0%, 15% { opacity: 1; } 20%, 100% { opacity: 0.3; } }
        @keyframes device-online-long { 0%, 60% { opacity: 1; } 65%, 100% { opacity: 0.3; } }
        @keyframes line-active { 0%, 15% { stroke-opacity: 0.3; } 20%, 100% { stroke-opacity: 0.06; } }
        @keyframes line-active-long { 0%, 60% { stroke-opacity: 0.3; } 65%, 100% { stroke-opacity: 0.06; } }
        .net-line-flow { stroke-dasharray: 6 6; animation: net-flow 1.8s linear infinite; }
        .center-hub { animation: center-pulse 5s ease-in-out infinite; transform-origin: 200px 200px; }
        .center-ring-ping { animation: center-ring 3s ease-out infinite; }
        .net-glow { animation: glow-breathe 5s ease-in-out infinite; }
        .device-blink { animation: device-online 8s ease-in-out infinite; }
        .device-steady { animation: device-online-long 10s ease-in-out infinite; }
        .line-blink { animation: line-active 8s ease-in-out infinite; }
        .line-steady { animation: line-active-long 10s ease-in-out infinite; }
      `}</style>

      <div className="mx-auto max-w-[1200px]">
        <div className="grid md:grid-cols-2 gap-12 md:gap-20 items-center">
          <div>
            <p className="text-sm tracking-[0.15em] uppercase text-[var(--moss)] mb-4 font-medium">The platform</p>
            <h2
              className="text-3xl sm:text-4xl font-light leading-tight tracking-[-0.01em] mb-8"
              style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
            >
              Built around you.
            </h2>
            <p className="text-[var(--ink)]/55 leading-relaxed mb-5">
              Your Matrix instance runs 24/7 in the cloud — always on, always yours. Connect from your phone on the train, your laptop at home, or a friend&apos;s computer at a cafe. Every device sees the same workspace, instantly.
            </p>
            <p className="text-[var(--ink)]/40 leading-relaxed">
              Devices come and go. Your instance never stops. Close your laptop and pick up on your phone — everything is exactly where you left it. No syncing, no waiting, no setup.
            </p>
          </div>

          <div className="relative" style={{ aspectRatio: "1 / 1", maxWidth: 520, margin: "0 auto" }}>
            <svg viewBox="0 0 400 400" className="w-full h-full" style={{ overflow: "visible" }}>
              <defs>
                <radialGradient id="center-glow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="var(--sage)" stopOpacity="0.25" />
                  <stop offset="70%" stopColor="var(--sage)" stopOpacity="0.05" />
                  <stop offset="100%" stopColor="var(--sage)" stopOpacity="0" />
                </radialGradient>
              </defs>

              <circle cx="200" cy="200" r="110" fill="url(#center-glow)" className="net-glow" />

              <circle cx="200" cy="200" r="44" fill="none" stroke="var(--sage)" strokeWidth="0.8" className="center-ring-ping" />
              <circle cx="200" cy="200" r="44" fill="none" stroke="var(--sage)" strokeWidth="0.5" className="center-ring-ping" style={{ animationDelay: "1s" }} />
              <circle cx="200" cy="200" r="44" fill="none" stroke="var(--sage)" strokeWidth="0.3" className="center-ring-ping" style={{ animationDelay: "2s" }} />

              {devices.map((node, i) => (
                <line key={`line-${i}`} x1="200" y1="200" x2={node.x} y2={node.y}
                  stroke="var(--forest)" strokeWidth="1.5" strokeOpacity="0.15"
                  className={`net-line-flow ${i % 2 === 0 ? "line-blink" : "line-steady"}`}
                  style={{ animationDelay: `${node.delay}, ${node.delay}` }} />
              ))}

              <g className="center-hub">
                <circle cx="200" cy="200" r="44" fill="var(--sage)" fillOpacity="0.12" stroke="var(--sage)" strokeWidth="1.5" />
                <circle cx="200" cy="200" r="28" fill="var(--forest)" opacity="0.85" />
              </g>

              {devices.map((node, i) => (
                <g key={`device-${i}`} className={node.anim} style={{ animationDelay: node.delay }}>
                  <circle cx={node.x} cy={node.y} r="28" fill="var(--forest)" fillOpacity="0.04" stroke="var(--forest)" strokeOpacity="0.15" strokeWidth="1" />
                  <DeviceIcon icon={node.icon} x={node.x} y={node.y} />
                  <text x={node.x} y={node.y + 38} textAnchor="middle" dominantBaseline="central"
                    fill="var(--forest)" fillOpacity="0.5" fontSize="7" letterSpacing="0.1em">
                    {node.label.toUpperCase()}
                  </text>
                </g>
              ))}

              <text x="200" y="196" textAnchor="middle" dominantBaseline="central"
                fill="var(--stone)" fontSize="7" fontWeight="600" letterSpacing="0.12em">
                MATRIX
              </text>
              <text x="200" y="208" textAnchor="middle" dominantBaseline="central"
                fill="var(--stone)" fillOpacity="0.7" fontSize="5.5" letterSpacing="0.15em">
                24/7
              </text>
            </svg>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-20">
          {[
            { Icon: BrainCircuitIcon, title: "Always running", desc: "Your instance never sleeps. Apps, data, and AI — running 24/7 whether you're connected or not." },
            { Icon: ShieldCheckIcon, title: "Private by design", desc: "Your own database, files, and runtime. Fully isolated. Nobody else can see in." },
            { Icon: GlobeIcon, title: "Any screen, anywhere", desc: "Phone, laptop, friend's computer — open a browser and you're home." },
          ].map((item) => (
            <div key={item.title} className="rounded-xl p-6 border border-[var(--pebble)] bg-[var(--stone)]">
              <item.Icon className="size-5 mb-4 text-[var(--moss)]" />
              <h3 className="text-sm font-semibold mb-2">{item.title}</h3>
              <p className="text-sm text-[var(--ink)]/50 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────── How It Works ──────────────────────────── */

function HowItWorks() {
  return (
    <section className="py-24 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[var(--moss)] mb-4 font-medium">How it works</p>
        <h2
          className="text-3xl sm:text-4xl font-light leading-tight tracking-[-0.01em] mb-16"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          Up and running in seconds.
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-[var(--pebble)] border border-[var(--pebble)] rounded-xl overflow-hidden">
          {[
            { num: "01", title: "Create an account", desc: "Sign up in seconds. No credit card, no setup wizard, no downloads." },
            { num: "02", title: "Get your Matrix instance", desc: "Your personal cloud computer spins up instantly — a full desktop with apps, files, and AI built in." },
            { num: "03", title: "Bring your own agent", desc: "Connect your preferred AI — Claude, GPT, Hermes, or any model you trust. Your instance, your agent, your rules." },
          ].map((item) => (
            <div key={item.num} className="bg-[var(--stone)] p-8 md:p-10">
              <span className="text-xs font-mono text-[var(--moss)]/60 mb-3 block">{item.num}</span>
              <h3
                className="text-xl font-normal mb-4 tracking-[-0.01em]"
                style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
              >
                {item.title}
              </h3>
              <p className="text-[var(--ink)]/55 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────── Why Different ──────────────────────────── */

function WhyDifferent() {
  return (
    <section className="py-24 px-6">
      <div className="mx-auto max-w-[1200px]">
        <p className="text-sm tracking-[0.15em] uppercase text-[var(--moss)] mb-4 font-medium">
          Not another AI chatbot
        </p>
        <h2
          className="text-3xl sm:text-4xl font-light leading-tight tracking-[-0.01em] mb-16"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          You own <span className="italic">everything</span>
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-16">
          <div className="space-y-8">
            {faqItems.slice(0, 3).map((item) => (
              <div key={item.q}>
                <h3
                  className="text-lg font-normal mb-2"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                >
                  {item.q}
                </h3>
                <p className="text-[var(--ink)]/55 leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
          <div className="space-y-8">
            {faqItems.slice(3).map((item) => (
              <div key={item.q}>
                <h3
                  className="text-lg font-normal mb-2"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                >
                  {item.q}
                </h3>
                <p className="text-[var(--ink)]/55 leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────── CTA ───────────────────────────── */

function CTA() {
  return (
    <section className="py-24 px-6">
      <div className="mx-auto max-w-[700px] text-center">
        <h2
          className="text-3xl sm:text-4xl md:text-5xl font-light tracking-[-0.01em] mb-6 leading-tight"
          style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
        >
          Ready to begin?
        </h2>
        <p className="text-lg text-[var(--ink)]/50 leading-relaxed max-w-[520px] mx-auto mb-3">
          Your personal cloud computer is waiting. Set up takes less than a minute.
        </p>
        <p className="text-sm text-[var(--ink)]/35 mb-10">
          No credit card. No surprise bills. Cancel anytime.
        </p>

        <div className="flex items-center justify-center gap-4 flex-wrap">
          <SignedOut>
            <a href="https://app.matrix-os.com"
              className="inline-flex items-center gap-2 bg-[var(--forest)] text-[var(--stone)] text-base px-7 py-3 rounded-full hover:bg-[var(--ink)] transition-colors font-medium">
              Get early access
              <ArrowRightIcon className="size-4" />
            </a>
          </SignedOut>
          <SignedIn>
            <a href="https://app.matrix-os.com" target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-[var(--forest)] text-[var(--stone)] text-base px-7 py-3 rounded-full hover:bg-[var(--ink)] transition-colors font-medium">
              Go to Dashboard
              <ArrowRightIcon className="size-4" />
            </a>
          </SignedIn>
          <a href="/whitepaper"
            className="inline-flex items-center gap-2 text-base font-medium text-[var(--ink)]/50 hover:text-[var(--ink)] transition-colors border-b border-[var(--ink)]/15 pb-0.5 hover:border-[var(--ink)]/30">
            Read the whitepaper
            <ArrowRightIcon className="size-4" />
          </a>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────── Footer ──────────────────────────── */

function Footer() {
  return (
    <footer className="py-16 px-6 border-t border-[var(--pebble)]">
      <div className="mx-auto max-w-[1200px]">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          <div className="flex items-center gap-2.5">
            <img src="/rabbit.svg" alt="Matrix OS" className="size-4" />
            <span className="text-sm text-[var(--ink)]/40 font-mono">matrix-os.com</span>
          </div>

          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm text-[var(--ink)]/40">
            <a href="https://discord.gg/cSBBQWtPwV" target="_blank" rel="noopener noreferrer"
              className="hover:text-[var(--ink)] transition-colors">Discord</a>
            <a href="https://x.com/joinmatrixos" target="_blank" rel="noopener noreferrer"
              className="hover:text-[var(--ink)] transition-colors">X / Twitter</a>
            <a href="https://github.com/HamedMP/matrix-os" target="_blank" rel="noopener noreferrer"
              className="hover:text-[var(--ink)] transition-colors">GitHub</a>
            <a href="/docs" className="hover:text-[var(--ink)] transition-colors">Docs</a>
            <a href="/whitepaper" className="hover:text-[var(--ink)] transition-colors">Whitepaper</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
