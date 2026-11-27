import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./internal";

export interface TabItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  closable?: boolean;
  /** Accessible close label; defaults to "Close tab". */
  closeLabel?: string;
  disabled?: boolean;
}

export interface TabsProps {
  label: string;
  tabs: readonly TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  onClose?: (id: string) => void;
  /** Renders the active panel inside role="tabpanel"; omit to render panels yourself. */
  renderPanel?: (id: string) => ReactNode;
  /** "top" tabs above content (default) or "bottom" for sheet tabs. */
  placement?: "top" | "bottom";
  /** Trailing content in the tab strip, such as an add button. */
  trailing?: ReactNode;
  className?: string;
}

/** Tab strip with automatic activation on arrow keys and optional closable tabs. */
export function Tabs({ label, tabs, activeId, onChange, onClose, renderPanel, placement = "top", trailing, className }: TabsProps) {
  const base = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const enabled = tabs.filter((tab) => !tab.disabled);
  const tabId = (id: string) => `${base}-tab-${id}`;
  const panelId = (id: string) => `${base}-panel-${id}`;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = enabled.findIndex((tab) => tab.id === id);
    let target: TabItem | undefined;
    if (event.key === "ArrowRight") target = enabled[(index + 1) % enabled.length];
    else if (event.key === "ArrowLeft") target = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") target = enabled[0];
    else if (event.key === "End") target = enabled[enabled.length - 1];
    else if ((event.key === "Delete" || event.key === "Backspace") && onClose && tabs.find((tab) => tab.id === id)?.closable) {
      event.preventDefault();
      onClose(id);
      return;
    } else return;
    event.preventDefault();
    if (!target) return;
    onChange(target.id);
    refs.current.get(target.id)?.focus();
  };

  const strip = (
    <div className="oui-tabs__strip">
      <div role="tablist" aria-label={label} className="oui-tabs__list">
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <div key={tab.id} className={cx("oui-tabs__tab-wrap", selected && "is-selected")}>
              <button
                ref={(el) => {
                  if (el) refs.current.set(tab.id, el);
                  else refs.current.delete(tab.id);
                }}
                id={tabId(tab.id)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={renderPanel ? panelId(tab.id) : undefined}
                tabIndex={selected ? 0 : -1}
                disabled={tab.disabled}
                className="oui-tabs__tab"
                onClick={() => onChange(tab.id)}
                onKeyDown={(event) => onKeyDown(event, tab.id)}
              >
                {tab.icon && <span className="oui-tabs__icon" aria-hidden="true">{tab.icon}</span>}
                <span className="oui-tabs__label">{tab.label}</span>
                {tab.badge !== undefined && <span className="oui-tabs__badge">{tab.badge}</span>}
              </button>
              {tab.closable && onClose && (
                <button type="button" tabIndex={-1} className="oui-tabs__close" aria-label={tab.closeLabel ?? "Close tab"} onClick={() => onClose(tab.id)}>
                  <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4 4l8 8m0-8l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
      {trailing && <div className="oui-tabs__trailing">{trailing}</div>}
    </div>
  );

  const panel = renderPanel ? (
    <div role="tabpanel" id={panelId(activeId)} aria-labelledby={tabId(activeId)} tabIndex={0} className="oui-tabs__panel">
      {renderPanel(activeId)}
    </div>
  ) : null;

  return (
    <div className={cx("oui-tabs", `oui-tabs--${placement}`, className)}>
      {placement === "bottom" ? panel : strip}
      {placement === "bottom" ? strip : panel}
    </div>
  );
}
