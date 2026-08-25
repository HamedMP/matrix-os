import type { HTMLAttributes, ReactNode } from "react";

export function SharedChatSurface({
  ariaLabel,
  project,
  className = "",
  children,
  ...sectionProps
}: Omit<HTMLAttributes<HTMLElement>, "aria-label"> & {
  ariaLabel: string;
  project?: { projectId: string; label: string };
  children: ReactNode;
}) {
  return (
    <section
      {...sectionProps}
      role="region"
      aria-label={ariaLabel}
      data-slot="shared-chat-surface"
      data-chat-context={project ? "project" : "global"}
      data-project-id={project?.projectId}
      className={className}
    >
      {children}
    </section>
  );
}
