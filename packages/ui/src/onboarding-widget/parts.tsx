import { rabbitMarkSvg } from "@matrix-os/brand/marks";
import type { OnboardingWorkStep } from "@matrix-os/contracts";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  File01Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";

const RABBIT_SVG = rabbitMarkSvg("mxo-rabbit__mark");

export function Icon({ icon, size = 16, className }: { icon: IconSvgElement; size?: number; className?: string }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.6} className={className} aria-hidden />;
}

export function RabbitAvatar({ size = 30 }: { size?: number }) {
  return (
    <span
      className="mxo-rabbit"
      style={{ width: size, height: size }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: RABBIT_SVG }}
    />
  );
}

export function AppLogo({ src, name, size = 28 }: { src?: string; name: string; size?: number }) {
  return (
    <span className="mxo-logo" style={{ width: size, height: size }} aria-hidden>
      {src ? <img src={src} alt="" width={size - 8} height={size - 8} /> : <span>{name.slice(0, 1)}</span>}
    </span>
  );
}

export function UserEcho({ text }: { text: string }) {
  return <p className="mxo-echo">{text}</p>;
}

export function DoneLine({ text }: { text: string }) {
  return (
    <p className="mxo-done-line">
      <Icon icon={CheckmarkCircle02Icon} size={14} className="mxo-ok" />
      {text}
    </p>
  );
}

export function Chips({ chips, onPick, disabled }: { chips: readonly string[]; onPick(chip: string): void; disabled?: boolean }) {
  return (
    <div className="mxo-chips">
      {chips.map((chip) => (
        <button key={chip} type="button" className="mxo-chip" disabled={disabled} onClick={() => onPick(chip)}>
          {chip}
        </button>
      ))}
    </div>
  );
}

export function WorkLog({ steps }: { steps: readonly OnboardingWorkStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="mxo-log" aria-label="Work log">
      {steps.map((step) => (
        <li key={step.id} className={`mxo-log__step mxo-log__step--${step.state}`}>
          <Icon
            icon={step.state === "done" ? CheckmarkCircle02Icon : step.state === "failed" ? Alert02Icon : Loading03Icon}
            size={14}
            className={step.state === "running" ? "mxo-spin" : undefined}
          />
          <span>{step.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function ResultCard({ title, subtitle, onOpen }: { title: string; subtitle?: string; onOpen(): void }) {
  return (
    <div className="mxo-card mxo-result">
      <span className="mxo-tile mxo-tile--neutral"><Icon icon={File01Icon} size={16} /></span>
      <span className="mxo-result__text">
        <span className="mxo-result__title">{title}</span>
        {subtitle ? <span className="mxo-muted">{subtitle}</span> : null}
      </span>
      <button type="button" className="mxo-btn mxo-btn--outline" onClick={onOpen}>Open</button>
    </div>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <div className="mxo-btn-row">{children}</div>;
}

export function StatusDot({ tone }: { tone: "working" | "attention" | "failed" }) {
  return <span className={`mxo-dot mxo-dot--${tone}`} aria-hidden />;
}
