import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import type { DesktopTabProps } from "./DesktopTab";

export default function DesktopTabGroup({ children }: { children: ReactNode }) {
  const tabs = Children.toArray(children).filter(isValidElement) as ReactElement<DesktopTabProps>[];

  return (
    <div
      role="tablist"
      aria-label="Workspace tabs"
      className="titlebar-drag flex h-full min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ height: "var(--titlebar-height)" }}
    >
      {tabs.map((tab, index) => cloneElement(tab, { isLast: index === tabs.length - 1 }))}
    </div>
  );
}
