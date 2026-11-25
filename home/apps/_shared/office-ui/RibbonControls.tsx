import { forwardRef, useEffect, useId, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { FloatingMenu, useMenuTrigger } from "./FloatingMenu";
import { cx } from "./internal";
import { Chevron, tooltipFor } from "./ribbon-parts";
import { RibbonColorControl, RibbonGalleryControl } from "./RibbonPickers";
import type {
  RibbonItem,
  RibbonMenuButtonItem,
  RibbonSelectItem,
  RibbonSplitItem,
} from "./ribbon-types";

interface RibbonButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: string;
  icon?: ReactNode;
  size?: "large" | "small";
  showLabel?: boolean;
  shortcut?: string;
  pressed?: boolean;
  /** Extra visible content after the label, such as a chevron. */
  after?: ReactNode;
  /** Accessible name when it differs from the visible label. */
  name?: string;
}

/** Base ribbon button: large (icon above label) or small (inline, optionally icon only). */
export const RibbonButton = forwardRef<HTMLButtonElement, RibbonButtonProps>(function RibbonButton(
  { label, icon, size = "small", showLabel = true, shortcut, pressed, after, name, className, ...rest },
  ref,
) {
  const labelVisible = size === "large" || showLabel || !icon;
  const accessibleName = name ?? (labelVisible ? undefined : label);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={accessibleName}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      title={tooltipFor(name ?? label, shortcut)}
      className={cx("oui-ribbon__button", `oui-ribbon__button--${size}`, !labelVisible && "is-icon-only", pressed && "is-pressed", className)}
      {...rest}
    >
      {icon && <span className="oui-ribbon__icon" aria-hidden="true">{icon}</span>}
      {labelVisible && <span className="oui-ribbon__label">{label}</span>}
      {after}
    </button>
  );
});

function SplitControl({ item }: { item: RibbonSplitItem }) {
  const menu = useMenuTrigger();
  const menuLabel = item.menuLabel ?? `${item.label} options`;
  const size = item.size ?? "small";
  return (
    <span className={cx("oui-ribbon__split", `oui-ribbon__split--${size}`)}>
      {size === "large" ? (
        <RibbonButton
          label={item.label}
          name={item.label}
          icon={item.icon}
          size="small"
          showLabel={false}
          shortcut={item.shortcut}
          disabled={item.disabled}
          className="oui-ribbon__split-main"
          onClick={item.onClick}
        />
      ) : (
        <RibbonButton
          label={item.label}
          icon={item.icon}
          showLabel={item.showLabel}
          shortcut={item.shortcut}
          disabled={item.disabled}
          className="oui-ribbon__split-main"
          onClick={item.onClick}
        />
      )}
      <button
        type="button"
        {...menu.triggerProps}
        aria-label={menuLabel}
        title={menuLabel}
        disabled={item.disabled}
        className="oui-ribbon__button oui-ribbon__split-arrow"
      >
        {size === "large" && <span className="oui-ribbon__label">{item.label}</span>}
        <Chevron />
      </button>
      {menu.open && (
        <FloatingMenu
          id={menu.menuId}
          anchorRef={menu.triggerRef}
          label={menuLabel}
          items={item.menu}
          onSelect={item.onMenuSelect}
          onClose={menu.close}
          initialFocus={menu.initialFocus}
        />
      )}
    </span>
  );
}

function MenuControl({ item }: { item: RibbonMenuButtonItem }) {
  const menu = useMenuTrigger();
  return (
    <>
      <RibbonButton
        {...menu.triggerProps}
        label={item.label}
        icon={item.icon}
        size={item.size}
        showLabel={item.showLabel}
        shortcut={item.shortcut}
        disabled={item.disabled}
        after={<Chevron />}
      />
      {menu.open && (
        <FloatingMenu
          id={menu.menuId}
          anchorRef={menu.triggerRef}
          label={item.label}
          items={item.menu}
          onSelect={item.onMenuSelect}
          onClose={menu.close}
          initialFocus={menu.initialFocus}
        />
      )}
    </>
  );
}

function SelectControl({ item }: { item: RibbonSelectItem }) {
  const listId = useId();
  const [draft, setDraft] = useState(item.value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(item.value);
  }, [item.value, focused]);
  const style = { width: item.width ?? 120 };
  const title = tooltipFor(item.label, item.shortcut);

  if (item.editable) {
    const commit = () => {
      const next = draft.trim();
      if (next && next !== item.value) item.onChange(next);
      else setDraft(item.value);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape" && draft !== item.value) {
        event.preventDefault();
        event.stopPropagation();
        setDraft(item.value);
      }
    };
    return (
      <>
        <input
          className="oui-ribbon__select oui-ribbon__combo"
          style={style}
          list={listId}
          aria-label={item.label}
          aria-keyshortcuts={item.shortcut}
          title={title}
          placeholder={item.placeholder}
          value={draft}
          disabled={item.disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
        />
        <datalist id={listId}>
          {item.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </datalist>
      </>
    );
  }

  const known = item.options.some((option) => option.value === item.value);
  return (
    <select
      className="oui-ribbon__select"
      style={style}
      aria-label={item.label}
      aria-keyshortcuts={item.shortcut}
      title={title}
      value={item.value}
      disabled={item.disabled}
      onChange={(event) => item.onChange(event.target.value)}
    >
      {!known && <option value={item.value}>{item.value || item.placeholder || ""}</option>}
      {item.options.map((option) => (
        <option key={option.value} value={option.value} style={option.style}>{option.label}</option>
      ))}
    </select>
  );
}

/** Render one ribbon item. */
export function RibbonItemView({ item }: { item: RibbonItem }) {
  switch (item.kind) {
    case "button":
      return (
        <RibbonButton
          label={item.label}
          icon={item.icon}
          size={item.size}
          showLabel={item.showLabel}
          shortcut={item.shortcut}
          disabled={item.disabled}
          onClick={item.onClick}
        />
      );
    case "toggle":
      return (
        <RibbonButton
          label={item.label}
          icon={item.icon}
          size={item.size}
          showLabel={item.showLabel}
          shortcut={item.shortcut}
          disabled={item.disabled}
          pressed={item.pressed}
          onClick={() => item.onToggle(!item.pressed)}
        />
      );
    case "split":
      return <SplitControl item={item} />;
    case "menu":
      return <MenuControl item={item} />;
    case "select":
      return <SelectControl item={item} />;
    case "color":
      return <RibbonColorControl item={item} />;
    case "gallery":
      return <RibbonGalleryControl item={item} />;
    case "separator":
      return <span role="separator" aria-orientation="vertical" className="oui-ribbon__separator" />;
    case "stack":
      return (
        <div className="oui-ribbon__stack">
          {item.rows.map((row) => (
            <div key={row.map((child) => child.id).join(" ")} className="oui-ribbon__stack-row">
              {row.map((child) => <RibbonItemView key={child.id} item={child} />)}
            </div>
          ))}
        </div>
      );
    default:
      return null;
  }
}
