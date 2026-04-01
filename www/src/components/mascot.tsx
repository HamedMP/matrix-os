"use client";

import { useEffect, useRef, useState } from "react";

const HERO_SIZE = 140;
const SECTION_SIZE = 56;
const ARC_HEIGHT = 100;
const JUMP_MS = 500;

const SECTIONS = [
  "hero",
  "featured",
  "about",
  "architecture",
  "agents",
  "capabilities",
  "vision",
];

export function MascotGuide() {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({
    active: "hero",
    jumping: false,
  });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (window.innerWidth < 768) return;

    const el = containerRef.current;
    if (!el) return;

    let scrollRaf = 0;
    let jumpRaf = 0;

    // Track intersection ratios for stable section detection
    const ratios = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          ratios.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        }
      },
      { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );

    for (const id of SECTIONS) {
      const sec = document.getElementById(id);
      if (sec) observer.observe(sec);
    }

    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    // Get position to place mascot: right-aligned to end of heading text
    const getTarget = (id: string) => {
      const section = document.getElementById(id);
      if (!section) return null;
      const heading = section.querySelector("h1, h2") as HTMLElement | null;
      if (!heading) return null;
      const r = heading.getBoundingClientRect();

      if (id === "hero") {
        const s = HERO_SIZE;
        return {
          x: r.left + r.width / 2 - s / 2,
          y: Math.max(60, 56 + (r.top - 56) / 2 - s / 2),
          w: s,
          h: s,
        };
      }

      const s = SECTION_SIZE;
      // Place right after the heading text, vertically centered
      let x = r.right + 10;
      if (x + s > window.innerWidth - 12) {
        x = r.left - s - 10;
      }
      return {
        x,
        y: r.top + r.height / 2 - s / 2,
        w: s,
        h: s,
      };
    };

    const applyPos = (x: number, y: number, w: number, h: number) => {
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    };

    /* ── jump arc ── */
    const jump = (
      from: { x: number; y: number; w: number; h: number },
      to: { x: number; y: number; w: number; h: number },
    ) => {
      const s = stateRef.current;
      s.jumping = true;
      const t0 = performance.now();

      const tick = (now: number) => {
        const raw = Math.min((now - t0) / JUMP_MS, 1);
        const t = easeOutCubic(raw);

        const x = from.x + (to.x - from.x) * t;
        const w = from.w + (to.w - from.w) * t;
        const h = from.h + (to.h - from.h) * t;
        const yLinear = from.y + (to.y - from.y) * t;
        const y = yLinear - ARC_HEIGHT * 4 * raw * (1 - raw);

        applyPos(x, y, w, h);

        if (raw < 1) {
          jumpRaf = requestAnimationFrame(tick);
        } else {
          s.jumping = false;
        }
      };

      cancelAnimationFrame(jumpRaf);
      jumpRaf = requestAnimationFrame(tick);
    };

    /* ── scroll: follow heading + detect section changes ── */
    const onScroll = () => {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        const s = stateRef.current;
        if (s.jumping) return;

        // Pick the section with highest intersection ratio
        let best = "";
        let bestRatio = -1;
        for (const [id, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            best = id;
          }
        }

        if (best && best !== s.active) {
          // Section changed: compute positions at this instant and jump
          const from = getTarget(s.active);
          s.active = best;
          const to = getTarget(best);
          if (from && to) {
            jump(from, to);
            return;
          }
        }

        // Follow the active section's heading smoothly
        const p = getTarget(s.active);
        if (p) applyPos(p.x, p.y, p.w, p.h);
      });
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    // Initial position
    requestAnimationFrame(() => {
      const init = getTarget("hero");
      if (init) {
        applyPos(init.x, init.y, init.w, init.h);
        setVisible(true);
      }
    });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(scrollRaf);
      cancelAnimationFrame(jumpRaf);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="fixed top-0 left-0 pointer-events-none"
      style={{
        zIndex: 9999,
        opacity: visible ? 1 : 0,
        transition: "opacity 0.5s ease",
        willChange: "transform",
      }}
    >
      <div className="mascot-bob">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/neo-circle-400.png"
          alt="Neo"
          width="100%"
          height="100%"
          draggable={false}
          style={{ borderRadius: "50%", objectFit: "cover" }}
        />
      </div>
    </div>
  );
}

export function MascotAvatar({ size = 40 }: { size?: number }) {
  return (
    <div style={{ width: size, height: size }}>
      <TrinitySvg />
    </div>
  );
}

/* ── Trinity — stylized avatar, bold graphic shapes, playful ── */

function TrinitySvg() {
  return (
    <svg viewBox="0 0 200 200" width="100%" height="100%" aria-label="Trinity">
      <defs>
        <clipPath id="portrait"><circle cx="100" cy="100" r="92" /></clipPath>
        <radialGradient id="bg" cx="40%" cy="38%" r="60%">
          <stop offset="0%" stopColor="#2c3020" />
          <stop offset="100%" stopColor="#0c0e08" />
        </radialGradient>
        <radialGradient id="skin" cx="40%" cy="38%" r="50%">
          <stop offset="0%" stopColor="#e8cca8" />
          <stop offset="60%" stopColor="#d4b08c" />
          <stop offset="100%" stopColor="#b8926c" />
        </radialGradient>
        <linearGradient id="hair" x1="0.3" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor="#1c1a14" />
          <stop offset="100%" stopColor="#080604" />
        </linearGradient>
      </defs>

      {/* Frame ring */}
      <circle cx="100" cy="100" r="96" fill="none" stroke="#c8a850" strokeWidth="1.5" opacity="0.3" />

      <g clipPath="url(#portrait)">
        <circle cx="100" cy="100" r="92" fill="url(#bg)" />

        {/* Shoulders / outfit */}
        <path d="M20 175 Q50 155,78 152 L100 165 L122 152 Q150 155,180 175 V200 H20 Z" fill="#0a0a08" />
        {/* High collar */}
        <path d="M78 152 L84 142 L100 155 L116 142 L122 152 L122 165 Q110 158,100 165 Q90 158,78 165 Z" fill="#0e0e0c" />
        <path d="M85 143 L100 153 L115 143" fill="none" stroke="#1c1c18" strokeWidth="0.8" />

        {/* Neck */}
        <rect x="88" y="138" width="24" height="18" rx="8" fill="url(#skin)" />

        {/* Face */}
        <ellipse cx="100" cy="95" rx="38" ry="48" fill="url(#skin)" />
        {/* Soft shadow right */}
        <ellipse cx="100" cy="95" rx="38" ry="48" fill="url(#bg)" opacity="0.15" />
        {/* Cheek blush left */}
        <circle cx="78" cy="105" r="10" fill="#d09878" opacity="0.15" />
        {/* Forehead glow */}
        <ellipse cx="92" cy="68" rx="18" ry="12" fill="#f0d8bc" opacity="0.15" />

        {/* Hair — short, slicked back */}
        <path d="M60 95 Q58 48,100 38 Q142 48,140 95 L138 78 Q135 52,100 44 Q65 52,62 78 Z" fill="url(#hair)" />
        {/* Top hair volume */}
        <path d="M68 60 Q74 40,100 34 Q126 40,132 60 L130 55 Q124 42,100 38 Q76 42,70 55 Z" fill="#100e08" />
        {/* Shine */}
        <path d="M84 38 Q94 34,108 36" fill="none" stroke="#2a2418" strokeWidth="1.5" opacity="0.3" />
        {/* Short sides */}
        <path d="M60 90 Q58 75,64 60" fill="none" stroke="#141008" strokeWidth="5" opacity="0.6" strokeLinecap="round" />
        <path d="M140 90 Q142 75,136 60" fill="none" stroke="#0a0806" strokeWidth="5" opacity="0.5" strokeLinecap="round" />

        {/* Eyebrows */}
        <path d="M74 78 Q82 73,92 76" fill="none" stroke="#2a2018" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
        <path d="M108 76 Q118 73,126 78" fill="none" stroke="#2a2018" strokeWidth="2" strokeLinecap="round" opacity="0.4" />

        {/* Sunglasses — small oval */}
        <ellipse cx="84" cy="88" rx="13" ry="8" fill="#0c0c0a" stroke="#1a1814" strokeWidth="1.2" />
        <ellipse cx="116" cy="88" rx="13" ry="8" fill="#0c0c0a" stroke="#1a1814" strokeWidth="1.2" />
        <path d="M97 87 Q100 84,103 87" fill="none" stroke="#1a1814" strokeWidth="1.5" />
        <path d="M71 86 L60 84" stroke="#1a1814" strokeWidth="1" strokeLinecap="round" />
        <path d="M129 86 L140 84" stroke="#1a1814" strokeWidth="1" strokeLinecap="round" />
        {/* Green tint */}
        <ellipse cx="84" cy="88" rx="13" ry="8" fill="#22c55e" opacity="0.07" />
        <ellipse cx="116" cy="88" rx="13" ry="8" fill="#22c55e" opacity="0.05" />
        {/* Glare */}
        <ellipse cx="80" cy="85" rx="5" ry="2.5" fill="white" opacity="0.08" transform="rotate(-10,80,85)" />
        <ellipse cx="112" cy="85" rx="4" ry="2" fill="white" opacity="0.05" transform="rotate(-10,112,85)" />

        {/* Nose */}
        <path d="M98 96 L97 112 Q95 116,93 118" fill="none" stroke="#b89870" strokeWidth="1" opacity="0.2" />
        <line x1="99" y1="97" x2="99" y2="110" stroke="#dcc4a4" strokeWidth="1.5" opacity="0.2" strokeLinecap="round" />

        {/* Lips — slight confident smile */}
        <path d="M88 126 Q94 123,100 124 Q106 123,112 126" fill="#b07868" opacity="0.35" />
        <path d="M90 127 Q100 132,110 127" fill="#b88070" opacity="0.2" />
        <path d="M88 126 Q95 128,100 127 Q105 128,112 126" fill="none" stroke="#7a5040" strokeWidth="0.7" opacity="0.4" />

        {/* Ear left */}
        <path d="M62 82 Q56 85,55 94 Q54 102,58 104 Q59 98,58 92 Q58 86,62 82 Z" fill="#d4b08c" opacity="0.3" />
      </g>
    </svg>
  );
}
