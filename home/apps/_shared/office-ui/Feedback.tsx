import type { CSSProperties, ReactNode } from "react";
import { cx } from "./internal";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  icon?: ReactNode;
  headline: string;
  description?: ReactNode;
  /** Primary call to action: a {label, onClick} pair or any custom node. */
  action?: EmptyStateAction | ReactNode;
  secondaryAction?: EmptyStateAction;
  className?: string;
}

function isAction(value: unknown): value is EmptyStateAction {
  return typeof value === "object" && value !== null && "label" in value && "onClick" in value;
}

/** Icon + headline + description + call to action, used as onboarding. */
export function EmptyState({ icon, headline, description, action, secondaryAction, className }: EmptyStateProps) {
  return (
    <div className={cx("oui-empty", className)}>
      {icon && <div className="oui-empty__icon" aria-hidden="true">{icon}</div>}
      <h2 className="oui-empty__headline">{headline}</h2>
      {description && <p className="oui-empty__description">{description}</p>}
      {(action || secondaryAction) && (
        <div className="oui-empty__actions">
          {isAction(action) ? (
            <button type="button" className="oui-button oui-button--primary" onClick={action.onClick}>{action.label}</button>
          ) : (
            action
          )}
          {secondaryAction && (
            <button type="button" className="oui-button oui-button--ghost" onClick={secondaryAction.onClick}>{secondaryAction.label}</button>
          )}
        </div>
      )}
    </div>
  );
}

export interface SpinnerProps {
  /** Accessible status text (default "Loading"). */
  label?: string;
  size?: number;
  className?: string;
}

export function Spinner({ label = "Loading", size = 18, className }: SpinnerProps) {
  return (
    <span role="status" className={cx("oui-spinner", className)} style={{ width: size, height: size }}>
      <span className="oui-sr-only">{label}</span>
    </span>
  );
}

export interface SkeletonProps {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  /** Render several stacked text lines; the last is shorter. */
  lines?: number;
  radius?: CSSProperties["borderRadius"];
  className?: string;
}

export function Skeleton({ width = "100%", height = 12, lines = 1, radius, className }: SkeletonProps) {
  const count = Math.max(1, Math.min(lines, 50));
  return (
    <span aria-hidden="true" className={cx("oui-skeleton-group", className)}>
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className="oui-skeleton"
          style={{ width: count > 1 && index === count - 1 ? "60%" : width, height, borderRadius: radius }}
        />
      ))}
    </span>
  );
}
