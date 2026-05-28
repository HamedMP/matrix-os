import { SignedIn, SignedOut } from "@clerk/nextjs";
import { ScrollScreenshot, BodyOverflow } from "@/components/landing/ScrollScreenshot";
import {
  ArrowRightIcon,
  BrainCircuitIcon,
  GlobeIcon,
  ShieldCheckIcon,
} from "lucide-react";

const faqItems = [
  { q: "What happens to my data?", a: "Everything is a file on your system. Apps, data, settings, your AI's memory. Copy a folder to back up your entire OS. No vendor lock-in. No opaque databases." },
  { q: "Do I need to code?", a: "No. You describe what you want in plain English. The AI writes the code, saves it as a file, and it appears on your desktop. You never touch a line of code unless you want to." },
  { q: "What if something breaks?", a: "The OS heals itself. A built-in agent monitors for problems and fixes them automatically. Everything is versioned with git, so nothing is ever truly lost." },
  { q: "Is it private?", a: "You can self-host it on your own server. Your data never leaves your machine unless you want it to. Open source under AGPL-3.0-or-later, auditable by anyone." },
  { q: "How is this different from ChatGPT?", a: "ChatGPT is a chat window that forgets you. Matrix OS is an operating system that remembers you, builds software for you, runs on every device, and works while you sleep." },
  { q: "What does it cost?", a: "Free to start. The platform is open source. You bring your own AI key, or use our hosted instances. No surprise bills, no credit-burning loops." },
];

const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", name: "Matrix OS", url: "https://matrix-os.com", logo: "https://matrix-os.com/rabbit.svg",
      sameAs: ["https://github.com/HamedMP/matrix-os", "https://x.com/joinmatrixos", "https://discord.gg/cSBBQWtPwV"] },
    { "@type": "SoftwareApplication", name: "Matrix OS", url: "https://matrix-os.com", applicationCategory: "OperatingSystem",
      operatingSystem: "Web, Docker", description: "An AI-native operating system that generates software from conversation.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } },
    { "@type": "FAQPage", mainEntity: faqItems.map((item) => ({
        "@type": "Question", name: item.q, acceptedAnswer: { "@type": "Answer", text: item.a } })) },
  ],
});

const c = {
  forest: "#434E3F",
  deep: "#32352E",
  cream: "#E0E1CA",
  ember: "#D06F25",
  pageBg: "#E2E2CF",
  border: "#D6D3C8",
  mutedFg: "#5C5A4F",
  subtle: "#7A7768",
} as const;

const navLinks = [
  { label: "about", href: "#about" },
  { label: "features", href: "#features" },
  { label: "developers", href: "#developers" },
  { label: "releases", href: "/releases" },
  { label: "agents", href: "/skills.md" },
] as const;

const communityLinks = [
  { label: "Docs", href: "/docs" },
  { label: "Releases", href: "/releases" },
  { label: "Agent Skill", href: "/skills.md" },
  { label: "Whitepaper", href: "/whitepaper" },
  { label: "Join Discord", href: "https://discord.gg/cSBBQWtPwV" },
  { label: "LinkedIn", href: "https://www.linkedin.com/company/matrix-os" },
  { label: "X", href: "https://x.com/joinmatrixos" },
  { label: "GitHub", href: "https://github.com/HamedMP/matrix-os" },
] as const;

const legalLinks = [
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
] as const;

function Logo({ className = "", style = {} }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 503 660" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} style={style}>
      <path d="M39.9179 591.802C29.3403 590.887 23.3359 592.01 14.0826 597.644C2.72489 608.912 -3.85738 620.084 2.44994 636.408C9.36892 654.062 24.7108 661.39 43.1277 658.04C59.5357 652.03 65.338 643.551 68.4749 626.885C68.0652 622.508 68.0147 621.066 66.9934 616.667C61.9599 602.391 54.1655 596.37 39.9179 591.802Z" fill="currentColor"/>
      <path d="M106.712 536.724C102.313 536.057 94.5858 536.629 90.5175 538.172C58.5993 550.259 66.7247 588.642 99.2489 591.335C117.98 592.89 128.44 581.858 145.243 576.981C152.576 574.855 163.907 575.124 171.258 577.812C188.786 585.69 204.575 594.983 224.404 587.8C232.551 584.843 243.077 579.22 247.129 570.786C254.584 570.999 261.069 570.517 268.502 569.956C272.435 575.657 275.268 579.069 280.825 583.064C291.598 590.449 302.935 589.175 312.742 580.343C328.374 566.763 313.981 545.029 296.163 545.203C283.893 545.321 275.61 552.667 267.703 560.848C261.138 560.635 254.382 560.714 247.798 560.708C227.717 539.85 207.878 533.739 181.846 547.919C147.981 566.37 136.59 541.365 106.712 536.724Z" fill="currentColor"/>
      <path d="M222.386 608.075C205.92 606.616 194.655 615.319 182.336 624.27C177.991 627.379 174.149 628.063 169.209 628.591C159.219 629.735 152.834 625.319 144.782 618.686C127.409 604.377 101.629 604.579 94.5758 629.214C91.1865 641.054 103.992 655.801 116.646 657.097C133.097 658.792 143.965 650.223 156.446 640.582C169.616 638.433 179.775 639.32 190.122 648.371C201.033 657.916 212.525 659.561 226.434 659.387C239.334 658.27 262.815 653.955 274.964 649.022C278.759 647.485 286.662 641.491 290.491 638.882C297.118 638.663 302.683 638.602 309.304 638.798C312.821 643.405 317.019 649.443 321.854 652.434C332.246 658.865 349.08 656.239 355.762 645.571C362.123 635.414 357.349 623.927 347.844 618.198C341.777 614.607 334.536 613.557 327.702 615.286C319.274 617.429 314.713 622.755 310.495 629.943C287.234 632.053 292.75 629.354 275.411 620.791C264.677 615.488 234.325 608.754 222.386 608.075Z" fill="currentColor"/>
      <path d="M411.14 613.081C382.855 611.313 378.257 653.798 409.297 655.605C415.61 655.667 420.987 655.397 426.194 651.402C430.498 648.08 433.26 643.142 433.845 637.732C435.37 623.704 424.288 614.405 411.14 613.081Z" fill="currentColor"/>
      <path d="M176.267 480.183C169.773 482.22 163.797 483.937 156.858 483.371C132.52 481.379 122.603 457.395 95.8251 465.767C88.1317 468.135 81.729 473.534 78.0872 480.711C71.1121 494.369 79.4564 512.522 92.6041 518.549C117.115 529.733 136.894 506.625 159.908 504.621C165.853 504.105 179.062 508.196 184.152 511.4C202.243 522.78 239.139 526.164 247.743 500.267C254.344 502.152 260.15 503.6 266.52 500.099C267.405 499.61 268.282 499.105 269.151 498.583C275.523 511.608 284.893 518.673 299.534 515.154C300.444 514.318 303.177 512.702 304.483 511.653C308.918 508.078 311.116 505.171 314.376 500.637C318.701 500.042 320.724 499.964 325.1 500.02C328.333 502.674 332.038 507.186 335.729 510.227C348.281 520.586 361.729 517.864 375.735 512.545C378.083 511.905 386.902 507.814 389.109 508.347C401.334 511.31 410.598 517.096 423.963 517.062C434.695 517.034 442.883 516.54 451.273 508.864C454.33 506.069 456.372 502.321 456.319 498.011C454.152 475.038 426.337 473.96 408.99 478.416C404.633 479.532 396.917 481.042 393.148 480.385C381.651 478.382 371.253 470.919 359.297 470.835C343.831 471.379 335.322 479.785 327.117 491.507C324.686 494.981 319.817 494.633 315.717 494.56C299.699 475.313 287.006 470.038 269.614 491.277C261.863 490.441 255.344 490.419 247.555 490.379C237.419 467.58 216.299 464.37 194.238 472.793C188.592 474.948 181.931 478.702 176.267 480.183Z" fill="currentColor"/>
      <path d="M306.053 423.81C270.803 387.458 252.724 420.46 215.553 415.241C188.698 411.476 173.549 381.213 141.729 404.371C135.902 411.419 132.656 417.188 133.502 426.767C134.279 434.819 138.28 442.215 144.595 447.271C153.017 454.145 161.396 454.998 171.788 453.859C172.471 453.466 179.557 451.856 182.692 450.391C190.011 446.963 199.658 440.711 207.198 438.916C236.923 431.845 250.849 461.149 283.354 450.778C294.502 447.221 298.553 444.774 304.723 433.888C313.374 434.039 315.808 434.23 322.803 429.679C322.542 429.651 349.665 475.896 370.099 431.784C371.019 431.649 371.942 431.531 372.867 431.43C380.975 430.555 383.127 433.271 389.074 438.456C400.654 447.636 422.636 445.459 436.546 444.842C452.572 444.129 463.505 426.503 448.131 415.179C445.969 413.591 443.495 412.48 440.873 411.919C438.754 411.447 433.431 410.97 431.317 410.993C417.544 411.015 397.737 404.439 387.494 416.436C372.865 433.562 371.528 424.27 360.137 414.085C348.602 403.777 330.505 413.541 324.477 425.6C323.262 428.029 320.296 424.612 318.576 424.393C314.601 423.692 310.155 423.86 306.053 423.81Z" fill="currentColor"/>
      <path d="M425.179 582.946C427.893 580.881 432.928 578.906 434.946 576.055C454.451 548.537 406.034 538.335 387.905 539.839C374.674 540.939 370.487 544.468 363.199 552.93C361.445 556.303 359.788 558.71 359.616 562.627C359.175 572.672 365.778 581.42 374.405 585.954C388.95 593.603 410.331 587.963 425.179 582.946Z" fill="currentColor"/>
      <path d="M149.456 93.4188C149.069 93.389 148.681 93.3683 148.293 93.3565C143.895 93.2106 139.631 94.8766 136.495 97.9641C127.546 106.685 132.783 119.077 142.929 123.605C147.704 125.735 151.501 125.365 156.562 125.382C168.48 132.804 167.314 137.057 169.421 149.541C172.957 168.796 193.761 185.126 213.44 180.316C226.756 177.062 228.194 174.813 239.242 183.969C238.781 197.412 243.185 210.213 254.037 218.694C264.108 226.569 277.011 229.881 289.63 227.83C304.078 225.398 309.325 221.103 322.592 231.567C325.272 243.216 328.152 251.104 340.99 254.264C354.422 254.898 362.525 245.034 358.227 232.251C355.24 223.369 344.861 216.239 335.506 218.52C333.556 218.996 330.783 220.593 328.923 221.61C321.865 218.175 316.778 212.814 312.609 206.298C312.567 188.524 295.541 170.159 279.561 164.22C276.542 163.099 267.745 161.711 265.885 160.377C265.885 160.231 265.988 157.048 266.084 157.312C263.387 149.93 259.102 140.873 253.693 135.241C248.243 129.567 239.896 132.341 233.161 130.285C222.883 125.809 216.157 118.204 204.457 116.867C195.141 115.803 189.514 118.745 180.693 119.733C175.908 120.269 169.167 116.175 165.79 112.817C162.861 102.637 160.417 96.0618 149.456 93.4188Z" fill="currentColor"/>
      <path d="M433.844 235.989C419.579 234 405.993 241.467 395.86 250.793C374.218 270.711 371.172 303.286 392.583 324.621C408.517 340.496 425.011 342.302 446.177 342.448C449.971 342.465 453.765 342.403 457.556 342.263C471.085 341.668 485.653 339.867 495.216 329.132C505.287 317.825 505.933 300.979 495.019 290.003C491.009 285.969 486.452 283.253 482.183 279.549C481.099 254.265 456.876 238.927 433.844 235.989Z" fill="currentColor"/>
      <path d="M247.328 0.115503C243.584 -0.0618204 241.077 -0.312085 237.666 1.72994C229.505 6.61755 227.481 16.2772 232.432 24.3218C237.69 32.8659 244.001 31.4681 252.457 33.5006C252.931 33.9035 253.394 34.3193 253.844 34.7474C268.701 48.9277 258.819 57.1839 264.064 73.9746C269.215 90.4629 281.579 103.351 298.282 108.342C305.034 110.36 312.463 109.429 319.393 109.219C326.275 112.543 329.159 116.806 331.922 123.591C329.607 133.602 328.334 141.492 334.05 150.859C340.384 161.239 350.666 164.92 361.939 166.866C368.536 168.004 373.704 173.555 376.805 179.185C379.172 183.008 374.92 186.532 374.262 190.098C371.831 203.27 380.628 211.623 392.185 214.732C392.573 214.736 392.961 214.741 393.349 214.745C398.564 214.689 403.527 212.495 407.078 208.676C410.278 205.266 411.945 200.696 411.693 196.026C411.228 187.558 405.162 179.609 397.482 176.417C393.309 174.682 390.91 174.997 386.519 175.234C382.917 169.317 379.971 164.745 377.807 158.075C382.807 143.089 384.96 130.724 372.583 118.149C363.649 109.074 353.811 110.056 342.038 110.156C329.776 89.5998 337.179 94.7147 336.685 74.9162C336.51 67.8772 333.288 60.6742 329.547 54.831C309.81 23.9958 282.862 38.9617 264.332 21.1794L263.797 20.6609C263.513 9.54225 257.962 2.86065 247.328 0.115503Z" fill="currentColor"/>
      <path d="M280.209 344.139C278.436 343.959 276.653 343.909 274.872 343.976C259.082 344.565 240.594 361.792 248.552 377.448C251.128 382.516 253.112 385.428 257.666 388.924C282.845 408.261 313.206 372.83 337.831 381.87C361.857 390.686 381.824 401.539 400.517 375.653C404.954 375.613 409.391 375.681 413.824 375.86C419.537 379.828 421.36 385.103 429.185 386.242C432.649 386.848 436.455 386.376 439.312 384.059C446.208 378.464 446.887 369.671 441.307 363.033C438.903 360.126 435.406 358.341 431.642 358.1C423.966 357.561 418.275 363.263 412.819 367.892C408.288 368.386 405.25 368.622 400.647 368.723C381.246 341.692 368.701 344.722 341.495 357.769C331.904 362.37 320.962 360.636 311.651 356.203C301.243 351.243 291.65 346.866 280.209 344.139Z" fill="currentColor"/>
    </svg>
  );
}

export default function LandingPage() {
  return (
    <div style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: "var(--font-inter), Inter, system-ui, sans-serif", position: "relative" }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <BodyOverflow />
      <svg style={{ position: "fixed", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 50, opacity: 0.12 }}>
        <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
      <style>{`
        .nav-link { position: relative; }
        .nav-link::after { content: ''; position: absolute; bottom: -2px; left: 0; width: 100%; height: 1px; background: currentColor; transform: scaleX(0); transform-origin: right; transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1); }
        .nav-link:hover::after { transform: scaleX(1); transform-origin: left; }

        html { scroll-behavior: smooth; }

        .screenshot-wrapper {
          border-radius: 16px;
          overflow: hidden;
          transform: translateY(var(--ss-y, 0px)) scale(var(--ss-s, 1));
          box-shadow: 0 50px 100px -20px rgba(50,53,46,0.25), 0 30px 60px -30px rgba(50,53,46,0.3), 0 0 0 1px rgba(50,53,46,0.05);
          transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.6s ease;
        }
        .screenshot-wrapper:hover {
          transform: translateY(calc(var(--ss-y, 0px) - 8px)) scale(1.005);
          box-shadow: 0 60px 120px -20px rgba(50,53,46,0.3), 0 40px 80px -30px rgba(50,53,46,0.35), 0 0 0 1px rgba(50,53,46,0.08);
        }

        .nav-island {
          position: fixed;
          top: 20px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 100;
        }
        .nav-island-inner {
          display: flex;
          align-items: center;
          gap: 2rem;
          padding: 10px 12px 10px 16px;
          border-radius: 9999px;
          background: rgba(250, 250, 245, 0.82);
          backdrop-filter: blur(16px) saturate(1.8);
          -webkit-backdrop-filter: blur(16px) saturate(1.8);
          border: 1px solid ${c.border};
          box-shadow: 0 4px 24px rgba(50, 53, 46, 0.08), 0 1px 4px rgba(50, 53, 46, 0.04);
        }
      `}</style>

      <div className="nav-island">
        <div className="nav-island-inner">
          <a href="/" className="flex items-center gap-2 shrink-0" style={{ fontFamily: "var(--font-orbitron), Orbitron, sans-serif" }}>
            <Logo className="h-[1.35rem] w-auto" style={{ color: c.forest }} />
            <span className="text-[13px] font-bold tracking-tight" style={{ color: c.forest }}>matrix os</span>
          </a>
          <nav className="hidden md:flex items-center gap-5">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target={link.href.startsWith("http") ? "_blank" : undefined}
                rel={link.href.startsWith("http") ? "noopener noreferrer" : undefined}
                className="nav-link text-[10px] tracking-[0.18em] uppercase"
                style={{ color: c.forest }}
              >
                {link.label}
              </a>
            ))}
          </nav>
          <SignedOut>
            <a href="https://app.matrix-os.com" className="text-[10px] tracking-[0.12em] uppercase font-medium px-4 py-1.5 rounded-full transition-colors duration-200 shrink-0"
              style={{ backgroundColor: c.forest, color: c.pageBg }}>
              get started
            </a>
          </SignedOut>
          <SignedIn>
            <a href="https://app.matrix-os.com" target="_blank" rel="noopener noreferrer" className="text-[10px] tracking-[0.12em] uppercase font-medium px-4 py-1.5 rounded-full transition-colors duration-200 shrink-0"
              style={{ backgroundColor: c.forest, color: c.pageBg }}>
              open matrix os
            </a>
          </SignedIn>
        </div>
      </div>

      <section className="relative min-h-[92svh] overflow-hidden pt-32 pb-20 md:pt-24 md:pb-24" style={{ backgroundColor: c.pageBg }}>
        <div className="relative min-h-[calc(92svh-13rem)] mx-auto max-w-[1200px] px-6 md:px-8 grid items-center gap-10 md:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)] md:gap-14">
          <div className="relative z-10 max-w-md">
            <h1 className="text-[2.65rem] md:text-[3.25rem] leading-[1.1] mb-6" style={{ color: c.forest }}>
              Your computer, in the cloud.
            </h1>
            <p className="text-[16px] leading-[1.8] mb-8" style={{ color: c.mutedFg }}>
              A personal computer that lives in the cloud. Open any browser, sign in, and everything is ready — your apps, your files, your way.
            </p>
            <SignedOut>
              <a href="https://app.matrix-os.com" className="inline-flex items-center gap-2 rounded-full px-8 py-3 text-[13px] tracking-[0.12em] uppercase font-medium transition-opacity duration-300 hover:opacity-80"
                style={{ backgroundColor: c.forest, color: c.pageBg }}>
                Get Started <ArrowRightIcon className="size-3.5" />
              </a>
            </SignedOut>
            <SignedIn>
              <a href="https://app.matrix-os.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full px-8 py-3 text-[13px] tracking-[0.12em] uppercase font-medium transition-opacity duration-300 hover:opacity-80"
                style={{ backgroundColor: c.forest, color: c.pageBg }}>
                Open Matrix OS <ArrowRightIcon className="size-3.5" />
              </a>
            </SignedIn>
            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
              <a
                href="https://discord.gg/cSBBQWtPwV"
                target="_blank"
                rel="noopener noreferrer"
                className="nav-link text-[11px] tracking-[0.16em] uppercase"
                style={{ color: c.subtle }}
              >
                Join Discord
              </a>
              <a
                href="/skills.md"
                className="nav-link text-[11px] tracking-[0.16em] uppercase"
                style={{ color: c.subtle }}
              >
                Agent setup
              </a>
            </div>
          </div>
          <div className="relative z-0 w-full overflow-hidden" style={{ backgroundColor: c.pageBg }}>
            <video
              autoPlay
              loop
              muted
              playsInline
              aria-hidden="true"
              preload="metadata"
              controls={false}
              src="/hero-loop.mp4"
              className="block w-full aspect-[16/11] md:aspect-[16/10] object-contain object-center"
              style={{ backgroundColor: c.pageBg }}
            />
          </div>
        </div>
      </section>

      <section id="preview" className="relative py-24 md:py-36 overflow-hidden" style={{ backgroundColor: c.pageBg }}>
        <div className="mx-auto max-w-[1100px] px-8">
          <ScrollScreenshot />
          <div className="mt-10 max-w-2xl mx-auto text-center">
            <h3 className="text-[1.1rem] font-semibold mb-3" style={{ color: c.forest }}>A real desktop, in your browser</h3>
            <p className="text-[15px] leading-[1.9]" style={{ color: c.mutedFg }}>
              Your Matrix instance isn&apos;t just a dashboard — it&apos;s a full visual operating system. A desktop with windows, a dock, wallpapers, and all your apps arranged exactly how you like. It feels like sitting at your own computer, except it runs in the cloud and follows you everywhere.
            </p>
          </div>
        </div>
      </section>

      <section id="about" className="py-32 md:py-44" style={{ backgroundColor: c.pageBg }}>
        <div className="mx-auto max-w-[1100px] px-8">
          <div className="grid md:grid-cols-[1fr_1.2fr] gap-16 md:gap-24">
            <div>
              <p className="text-[11px] tracking-[0.3em] uppercase mb-6" style={{ color: c.subtle }}>About</p>
              <h2 className="text-[clamp(1.75rem,4vw,3rem)] font-semibold leading-[1.2]" style={{ color: c.forest }}>
                Your computer, in the cloud.
              </h2>
            </div>
            <div className="flex flex-col gap-6 md:pt-10">
              <p className="text-[15px] leading-[1.9]" style={{ color: c.mutedFg }}>
                Matrix OS gives you a full personal computer that runs in the cloud. Open any browser, sign in, and you have your desktop — your apps, your files, your settings — ready to go. No installs, no setup, nothing to maintain.
              </p>
              <p className="text-[15px] leading-[1.9]" style={{ color: c.mutedFg }}>
                Just tell it what you need. An AI assistant builds your apps, organizes your workspace, and keeps everything running. It works on any device, from anywhere, and picks up right where you left off.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-[1100px] px-8">
        <div style={{ height: 1, backgroundColor: c.border }} />
      </div>

      <section id="features" className="relative py-32 md:py-44 overflow-hidden" style={{ backgroundColor: c.pageBg }}>
        <style>{`
          @keyframes net-flow { 0% { stroke-dashoffset: 24; } 100% { stroke-dashoffset: 0; } }
          @keyframes center-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
          @keyframes center-ring { 0% { r: 44; opacity: 0.3; } 100% { r: 80; opacity: 0; } }
          @keyframes glow-breathe { 0%, 100% { opacity: 0.2; } 50% { opacity: 0.45; } }
          @keyframes device-online { 0%, 15% { opacity: 1; } 20%, 100% { opacity: 0.3; } }
          @keyframes device-online-long { 0%, 60% { opacity: 1; } 65%, 100% { opacity: 0.3; } }
          @keyframes line-active { 0%, 15% { stroke-opacity: 0.3; } 20%, 100% { stroke-opacity: 0.06; } }
          @keyframes line-active-long { 0%, 60% { stroke-opacity: 0.3; } 65%, 100% { stroke-opacity: 0.06; } }
          .net-line-flow {
            stroke-dasharray: 6 6;
            animation: net-flow 1.8s linear infinite, var(--line-state-animation);
          }
          .center-hub {
            animation: center-pulse 5s ease-in-out infinite;
            transform-box: fill-box;
            transform-origin: center;
          }
          .center-ring-ping { animation: center-ring 3s ease-out infinite; }
          .net-glow { animation: glow-breathe 5s ease-in-out infinite; }
          .device-blink { animation: device-online 8s ease-in-out infinite; }
          .device-steady { animation: device-online-long 10s ease-in-out infinite; }
          .line-blink { --line-state-animation: line-active 8s ease-in-out infinite; }
          .line-steady { --line-state-animation: line-active-long 10s ease-in-out infinite; }
          .feature-pill { backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); transition: transform 0.3s ease, box-shadow 0.3s ease; }
          .feature-pill:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.15); }
        `}</style>

        <div className="mx-auto max-w-[1200px] px-8">
          <div className="grid md:grid-cols-2 gap-12 md:gap-20 items-center mb-20 md:mb-32">
            <div>
              <p className="text-[11px] tracking-[0.3em] uppercase mb-6" style={{ color: c.subtle }}>The platform</p>
              <h2 className="text-[clamp(1.75rem,4vw,3rem)] font-semibold leading-[1.15] mb-8" style={{ color: c.forest }}>
                Built around you.
              </h2>
              <p className="text-[15px] leading-[1.9] mb-5" style={{ color: c.mutedFg }}>
                Your Matrix instance runs 24/7 in the cloud — always on, always yours. Connect from your phone on the train, your laptop at home, or a friend&apos;s computer at a cafe. Every device sees the same workspace, instantly.
              </p>
              <p className="text-[15px] leading-[1.9]" style={{ color: c.subtle }}>
                Devices come and go. Your instance never stops. Close your laptop and pick up on your phone — everything is exactly where you left it. No syncing, no waiting, no setup.
              </p>
            </div>

            <div className="relative" style={{ aspectRatio: "1 / 1", maxWidth: 520, margin: "0 auto" }}>
              <svg viewBox="0 0 400 400" className="w-full h-full" style={{ overflow: "visible" }}>
                <defs>
                  <radialGradient id="center-glow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor={c.ember} stopOpacity="0.25" />
                    <stop offset="70%" stopColor={c.ember} stopOpacity="0.05" />
                    <stop offset="100%" stopColor={c.ember} stopOpacity="0" />
                  </radialGradient>
                </defs>

                <circle cx="200" cy="200" r="110" fill="url(#center-glow)" className="net-glow" />

                <circle cx="200" cy="200" r="44" fill="none" stroke={c.ember} strokeWidth="0.8" className="center-ring-ping" />
                <circle cx="200" cy="200" r="44" fill="none" stroke={c.ember} strokeWidth="0.5" className="center-ring-ping" style={{ animationDelay: "1s" }} />
                <circle cx="200" cy="200" r="44" fill="none" stroke={c.ember} strokeWidth="0.3" className="center-ring-ping" style={{ animationDelay: "2s" }} />

                {[
                  { x: 200, y: 52, anim: "line-blink", delay: "0s" },
                  { x: 338, y: 115, anim: "line-steady", delay: "1s" },
                  { x: 340, y: 280, anim: "line-blink", delay: "3s" },
                  { x: 200, y: 348, anim: "line-steady", delay: "0.5s" },
                  { x: 60, y: 280, anim: "line-blink", delay: "5s" },
                  { x: 62, y: 115, anim: "line-steady", delay: "2s" },
                ].map((node, i) => (
                  <line key={`line-${i}`} x1="200" y1="200" x2={node.x} y2={node.y}
                    stroke="rgba(67,78,63,0.25)" strokeWidth="1.5"
                    className={`net-line-flow ${node.anim}`}
                    style={{ animationDelay: `${node.delay}, ${node.delay}` }} />
                ))}

                <g className="center-hub">
                  <circle cx="200" cy="200" r="44" fill="rgba(208,111,37,0.12)" stroke={c.ember} strokeWidth="1.5" />
                  <circle cx="200" cy="200" r="28" fill={c.ember} opacity="0.85" />
                </g>

                {[
                  { x: 200, y: 52, anim: "device-blink", delay: "0s", label: "Mobile", icon: "smartphone" as const },
                  { x: 338, y: 115, anim: "device-steady", delay: "1s", label: "Laptop", icon: "laptop" as const },
                  { x: 340, y: 280, anim: "device-blink", delay: "3s", label: "Tablet", icon: "tablet" as const },
                  { x: 200, y: 348, anim: "device-steady", delay: "0.5s", label: "Computer", icon: "monitor" as const },
                  { x: 60, y: 280, anim: "device-blink", delay: "5s", label: "Friend's PC", icon: "laptop" as const },
                  { x: 62, y: 115, anim: "device-steady", delay: "2s", label: "Browser", icon: "globe" as const },
                ].map((node, i) => (
                  <g key={`device-${i}`} className={node.anim} style={{ animationDelay: node.delay }}>
                    <circle cx={node.x} cy={node.y} r="28" fill="rgba(67,78,63,0.06)" stroke="rgba(67,78,63,0.2)" strokeWidth="1" />
                    {node.icon === "smartphone" && (
                      <rect x={node.x - 5} y={node.y - 8} width="10" height="16" rx="2" fill="none" stroke={c.forest} strokeWidth="1.2" opacity="0.7" />
                    )}
                    {node.icon === "laptop" && (<>
                      <rect x={node.x - 9} y={node.y - 6} width="18" height="12" rx="1.5" fill="none" stroke={c.forest} strokeWidth="1.2" opacity="0.7" />
                      <line x1={node.x - 11} y1={node.y + 7} x2={node.x + 11} y2={node.y + 7} stroke={c.forest} strokeWidth="1.2" opacity="0.7" />
                    </>)}
                    {node.icon === "tablet" && (
                      <rect x={node.x - 7} y={node.y - 9} width="14" height="18" rx="2" fill="none" stroke={c.forest} strokeWidth="1.2" opacity="0.7" />
                    )}
                    {node.icon === "monitor" && (<>
                      <rect x={node.x - 10} y={node.y - 8} width="20" height="14" rx="1.5" fill="none" stroke={c.forest} strokeWidth="1.2" opacity="0.7" />
                      <line x1={node.x} y1={node.y + 6} x2={node.x} y2={node.y + 9} stroke={c.forest} strokeWidth="1.2" opacity="0.7" />
                      <line x1={node.x - 5} y1={node.y + 9} x2={node.x + 5} y2={node.y + 9} stroke={c.forest} strokeWidth="1.2" opacity="0.7" />
                    </>)}
                    {node.icon === "globe" && (
                      <g opacity="0.7">
                        <circle cx={node.x} cy={node.y} r="8" fill="none" stroke={c.forest} strokeWidth="1.2" />
                        <ellipse cx={node.x} cy={node.y} rx="4" ry="8" fill="none" stroke={c.forest} strokeWidth="0.8" />
                        <line x1={node.x - 8} y1={node.y} x2={node.x + 8} y2={node.y} stroke={c.forest} strokeWidth="0.8" />
                      </g>
                    )}
                    <text x={node.x} y={node.y + 38} textAnchor="middle" dominantBaseline="central"
                      fill="rgba(67,78,63,0.7)" fontSize="7" letterSpacing="0.1em"
                      fontFamily="var(--font-inter), Inter, sans-serif">
                      {node.label.toUpperCase()}
                    </text>
                  </g>
                ))}

                <text x="200" y="196" textAnchor="middle" dominantBaseline="central"
                  fill="#FAFAF5" fontSize="7" fontWeight="600" letterSpacing="0.12em"
                  fontFamily="var(--font-orbitron), Orbitron, sans-serif">
                  MATRIX
                </text>
                <text x="200" y="208" textAnchor="middle" dominantBaseline="central"
                  fill="rgba(250,250,245,0.7)" fontSize="5.5" letterSpacing="0.15em"
                  fontFamily="var(--font-inter), Inter, sans-serif">
                  24/7
                </text>
              </svg>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { Icon: BrainCircuitIcon, title: "Always running", desc: "Your instance never sleeps. Apps, data, and AI — running 24/7 whether you're connected or not." },
              { Icon: ShieldCheckIcon, title: "Private by design", desc: "Your own database, files, and runtime. Fully isolated. Nobody else can see in." },
              { Icon: GlobeIcon, title: "Any screen, anywhere", desc: "Phone, laptop, friend's computer — open a browser and you're home." },
            ].map((item) => (
              <div key={item.title} className="feature-pill rounded-[16px] p-6 h-full"
                style={{ backgroundColor: "rgba(67,78,63,0.06)", border: `1px solid ${c.border}` }}>
                <item.Icon className="size-5 mb-4" style={{ color: c.ember }} />
                <h3 className="text-[14px] font-semibold mb-2" style={{ color: c.forest }}>{item.title}</h3>
                <p className="text-[13px] leading-[1.7]" style={{ color: c.mutedFg }}>{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-32 md:py-44" style={{ backgroundColor: c.pageBg }}>
        <div className="mx-auto max-w-[1100px] px-8">
          <p className="text-[11px] tracking-[0.3em] uppercase mb-6" style={{ color: c.subtle }}>How It Works</p>
          <h2 className="text-[clamp(1.75rem,4vw,3rem)] font-semibold leading-[1.2] mb-16 md:mb-24" style={{ color: c.forest }}>
            Up and running in seconds.
          </h2>

          <div className="grid md:grid-cols-3 gap-12 md:gap-16">
            {[
              { step: "01", title: "Create an account", desc: "Sign up in seconds. No credit card, no setup wizard, no downloads." },
              { step: "02", title: "Get your Matrix instance", desc: "Your personal cloud computer spins up instantly — a full desktop with apps, files, and AI built in." },
              { step: "03", title: "Bring your own agent", desc: "Connect your preferred AI — Claude, GPT, Hermes, or any model you trust. Your instance, your agent, your rules." },
            ].map((item) => (
              <div key={item.step}>
                <span className="block text-[clamp(2.5rem,5vw,4rem)] font-bold leading-none mb-5" style={{ color: c.border }}>
                  {item.step}
                </span>
                <h3 className="text-[16px] font-semibold mb-3" style={{ color: c.forest }}>{item.title}</h3>
                <p className="text-[14px] leading-[1.8]" style={{ color: c.mutedFg }}>{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="developers" className="py-28 md:py-36" style={{ backgroundColor: c.pageBg }}>
        <div className="mx-auto max-w-[1100px] px-8">
          <div className="grid gap-10 md:grid-cols-[0.9fr_1.1fr] md:items-center">
            <div>
              <p className="text-[11px] tracking-[0.3em] uppercase mb-6" style={{ color: c.subtle }}>For coding agents</p>
              <h2 className="text-[clamp(1.75rem,4vw,3rem)] font-semibold leading-[1.15] mb-6" style={{ color: c.forest }}>
                Give your agent the setup file.
              </h2>
              <p className="text-[15px] leading-[1.9]" style={{ color: c.mutedFg }}>
                Matrix publishes an agent-readable skill at <code>matrix-os.com/skills.md</code>. Claude, Codex, Cursor, Cline, or another coding agent can read it, install the CLI, help you sign up with <code>matrix login</code>, and start working on your cloud computer with <code>matrix run</code>.
              </p>
            </div>
            <div className="rounded-[16px] p-6 md:p-8" style={{ backgroundColor: "rgba(67,78,63,0.06)", border: `1px solid ${c.border}` }}>
              <pre className="overflow-x-auto text-left text-[12px] leading-[1.8]" style={{ color: c.forest }}>
                <code>{`Read https://matrix-os.com/skills.md

npx skills add HamedMP/matrix-os --skill matrix-os
matrix login
matrix run -it -- claude`}</code>
              </pre>
              <div className="mt-6 flex flex-wrap gap-3">
                <a href="/skills.md" className="inline-flex items-center gap-2 rounded-full px-6 py-3 text-[12px] tracking-[0.12em] uppercase font-medium transition-opacity duration-300 hover:opacity-80"
                  style={{ backgroundColor: c.forest, color: c.pageBg }}>
                  Open skills.md <ArrowRightIcon className="size-3.5" />
                </a>
                <a href="/docs/guide/developer-workflow" className="inline-flex items-center gap-2 rounded-full px-6 py-3 text-[12px] tracking-[0.12em] uppercase font-medium transition-opacity duration-300 hover:opacity-80"
                  style={{ border: `1px solid ${c.border}`, color: c.forest }}>
                  Developer workflow
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-32 md:py-44" style={{ backgroundColor: c.pageBg }}>
        <div className="mx-auto max-w-[900px] px-8">
          <p className="text-[11px] tracking-[0.3em] uppercase mb-6 text-center" style={{ color: c.subtle }}>FAQ</p>
          <div className="grid gap-4 md:grid-cols-2">
            {faqItems.map((item) => (
              <div key={item.q} className="rounded-[16px] p-6" style={{ backgroundColor: "rgba(67,78,63,0.05)", border: `1px solid ${c.border}` }}>
                <h3 className="text-[14px] font-semibold mb-3" style={{ color: c.forest }}>{item.q}</h3>
                <p className="text-[13px] leading-[1.7]" style={{ color: c.mutedFg }}>{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-32 md:py-44" style={{ backgroundColor: c.pageBg }}>
        <div className="mx-auto max-w-[1100px] px-8 text-center">
          <h2 className="text-[clamp(2rem,6vw,4.5rem)] font-bold leading-[1.1] mb-6" style={{ color: c.forest }}>
            Ready to begin?
          </h2>
          <p className="text-[15px] mb-10 max-w-md mx-auto" style={{ color: c.mutedFg }}>
            Your personal cloud computer is waiting. Set up takes less than a minute.
          </p>
          <SignedOut>
            <a href="https://app.matrix-os.com" className="inline-flex items-center gap-2 rounded-full px-10 py-4 text-[13px] tracking-[0.15em] uppercase font-medium transition-opacity duration-300 hover:opacity-80"
              style={{ backgroundColor: c.forest, color: c.pageBg }}>
              Get Started Free <ArrowRightIcon className="size-4" />
            </a>
          </SignedOut>
          <SignedIn>
            <a href="https://app.matrix-os.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full px-10 py-4 text-[13px] tracking-[0.15em] uppercase font-medium transition-opacity duration-300 hover:opacity-80"
              style={{ backgroundColor: c.forest, color: c.pageBg }}>
              Go to Dashboard <ArrowRightIcon className="size-4" />
            </a>
          </SignedIn>
          <p className="mt-5 text-[12px] leading-6" style={{ color: c.subtle }}>
            By using Matrix OS, you agree to the{" "}
            <a href="/terms" className="underline decoration-current/40 underline-offset-4 transition-opacity hover:opacity-70">
              Terms
            </a>{" "}
            and acknowledge the{" "}
            <a href="/privacy" className="underline decoration-current/40 underline-offset-4 transition-opacity hover:opacity-70">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </section>

      <footer className="py-16" style={{ backgroundColor: c.pageBg }}>
        <div className="mx-auto max-w-[1100px] px-8">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
            <div className="flex items-center gap-3">
              <Logo className="h-5 w-auto" style={{ color: c.subtle }} />
              <span className="text-[11px] font-semibold tracking-[0.25em] uppercase"
                style={{ color: c.subtle, fontFamily: "var(--font-orbitron), Orbitron, sans-serif" }}>matrix os</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-7 gap-y-4">
              {[...communityLinks, ...legalLinks].map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target={link.href.startsWith("http") ? "_blank" : undefined}
                  rel={link.href.startsWith("http") ? "noopener noreferrer" : undefined}
                  className="text-[11px] tracking-[0.15em] uppercase transition-opacity hover:opacity-70"
                  style={{ color: c.mutedFg }}
                >
                  {link.label}
                </a>
              ))}
              <SignedOut>
                <a href="https://app.matrix-os.com" className="text-[11px] tracking-[0.15em] uppercase transition-opacity hover:opacity-70" style={{ color: c.mutedFg }}>Sign In</a>
              </SignedOut>
              <SignedIn>
                <a href="https://app.matrix-os.com" target="_blank" rel="noopener noreferrer" className="text-[11px] tracking-[0.15em] uppercase transition-opacity hover:opacity-70" style={{ color: c.mutedFg }}>Open App</a>
              </SignedIn>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
