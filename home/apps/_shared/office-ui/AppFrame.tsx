import type { ReactNode } from "react";
import { cx } from "./internal";

export interface AppFrameProps {
  /** App or document title shown in the title bar area. */
  title?: ReactNode;
  /** Replaces the whole default title row, e.g. a <DocumentTitleBar>. */
  titleBar?: ReactNode;
  /** Small leading element in the title bar, such as an app icon. */
  titleIcon?: ReactNode;
  /** Trailing title-bar content: account switcher, share, agent toggle. */
  titleActions?: ReactNode;
  /** Usually a <Toolbar>. */
  toolbar?: ReactNode;
  /** Navigation rail: folders, calendars, outline. */
  leftRail?: ReactNode;
  leftRailLabel?: string;
  /** Contextual side panel such as the AgentPanel or comments. */
  rightPanel?: ReactNode;
  rightPanelLabel?: string;
  /** Status bar content (word count, sync state, selection summary). */
  statusBar?: ReactNode;
  /** Banner between toolbar and content, e.g. a ReviewBar or an error. */
  banner?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Office app shell: title bar, toolbar slot, optional left rail, main content,
 * optional right panel and status bar, laid out with CSS grid.
 */
export function AppFrame({
  title,
  titleBar,
  titleIcon,
  titleActions,
  toolbar,
  leftRail,
  leftRailLabel = "Navigation",
  rightPanel,
  rightPanelLabel = "Side panel",
  statusBar,
  banner,
  children,
  className,
}: AppFrameProps) {
  return (
    <div className={cx("oui-frame", "oui-root", Boolean(leftRail) && "has-left", Boolean(rightPanel) && "has-right", className)}>
      <header className="oui-frame__titlebar">
        {titleBar ?? (
          <>
            {titleIcon && <span className="oui-frame__title-icon" aria-hidden="true">{titleIcon}</span>}
            <h1 className="oui-frame__title">{title}</h1>
            {titleActions && <div className="oui-frame__title-actions">{titleActions}</div>}
          </>
        )}
      </header>
      {toolbar && <div className="oui-frame__toolbar">{toolbar}</div>}
      {banner && <div className="oui-frame__banner">{banner}</div>}
      <div className="oui-frame__body">
        {leftRail && <nav className="oui-frame__rail" aria-label={leftRailLabel}>{leftRail}</nav>}
        <main className="oui-frame__main">{children}</main>
        {rightPanel && <aside className="oui-frame__panel" aria-label={rightPanelLabel}>{rightPanel}</aside>}
      </div>
      {statusBar && <footer className="oui-frame__status">{statusBar}</footer>}
    </div>
  );
}
