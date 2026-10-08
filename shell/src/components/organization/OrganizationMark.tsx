import { organizationInitials } from "./organization-mark";

export function OrganizationMark({ name, className = "size-7" }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-[7px] border border-primary/15 bg-primary/10 text-[10px] font-semibold tracking-[-0.02em] text-primary ${className}`}
    >
      {organizationInitials(name)}
    </span>
  );
}
