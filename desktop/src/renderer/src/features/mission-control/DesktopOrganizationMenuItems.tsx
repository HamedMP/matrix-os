import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CheckIcon, UsersIcon } from "@renderer/lib/hugeicons";
import { useDesktopOrganizations } from "../collaboration/useDesktopOrganizations";
import { useConnection } from "../../stores/connection";

/**
 * Electron Desktop counterpart of the shell's OrganizationMenuItems.
 *
 * Every share control on Electron Desktop reads `organizationId` from the connection
 * store. The member's oldest organization is active by default (DesktopDefaultOrganization);
 * this switches between the ones they belong to, and the store remembers the choice per user.
 *
 * Mounted inside the open menu: each open re-reads membership, so an organization the
 * member has left is replaced here too, and the API is released on close rather than
 * left in the shared live-API set. The platform caps the listing at 100, so one request
 * returns every membership and there is no next page to fetch.
 */
export function DesktopOrganizationMenuItems({ itemClass }: { itemClass: string }) {
  const organizationId = useConnection((state) => state.organizationId);
  const selectOrganization = useConnection((state) => state.selectOrganization);
  const listing = useDesktopOrganizations();

  if (listing.state === "loading") return null;
  if (listing.state === "loaded" && listing.organizations.length === 0) return null;

  return (
    <>
      <DropdownMenu.Label className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: "var(--text-tertiary)" }}>
        Organization
      </DropdownMenu.Label>
      {listing.state === "loaded" ? (
        // menuitemradio + aria-checked, so the active organization is announced, not only drawn.
        <DropdownMenu.RadioGroup value={organizationId ?? ""}>
          {listing.organizations.map((organization) => (
            <DropdownMenu.RadioItem
              key={organization.organizationId}
              value={organization.organizationId}
              className={itemClass}
              style={{ color: "var(--text-primary)" }}
              onSelect={(event) => {
                // Keep the menu open so the moved checkmark is visible where the choice was made.
                event.preventDefault();
                selectOrganization(organization.organizationId);
              }}
            >
              <span aria-hidden="true" style={{ color: "var(--text-tertiary)" }}><UsersIcon size={14} /></span>
              <span className="min-w-0 flex-1 truncate">{organization.name}</span>
              <DropdownMenu.ItemIndicator>
                <CheckIcon aria-hidden="true" size={14} style={{ color: "var(--text-tertiary)" }} />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
      ) : (
        <p role="alert" className="px-2 py-1.5 text-[12px]" style={{ color: "var(--danger)" }}>
          Couldn&apos;t load your organizations.
        </p>
      )}
      <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} />
    </>
  );
}
