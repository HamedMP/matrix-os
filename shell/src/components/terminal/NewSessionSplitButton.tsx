import { useRef, type ComponentProps, type KeyboardEvent } from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { NewSessionMenu } from "./NewSessionMenu";

type NewSessionMenuProps = ComponentProps<typeof NewSessionMenu>;

export function NewSessionSplitButton({
  creatingShell,
  menuOpen,
  onCreateShell,
  onToggleMenu,
  onCloseMenu,
  onCreateAgent,
  agentStatuses,
  agentStatusesChecking,
  agentStatusesUnavailable,
}: {
  creatingShell: boolean;
  menuOpen: boolean;
  onCreateShell: () => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onCreateAgent: NewSessionMenuProps["onCreateAgent"];
  agentStatuses: NewSessionMenuProps["agentStatuses"];
  agentStatusesChecking: boolean;
  agentStatusesUnavailable: boolean;
}) {
  const disclosureRef = useRef<HTMLDivElement>(null);

  const openMenuFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" || menuOpen) return;
    event.preventDefault();
    onToggleMenu();
  };

  return (
    <div ref={disclosureRef} className="relative h-10 shrink-0">
      <ButtonGroup
        aria-label="New session actions"
        data-testid="terminal-new-session-split-button"
        className="terminal-drawer-primary-control terminal-new-session-split-button"
      >
        <Button
          type="button"
          variant={null}
          size="icon-lg"
          aria-label="New shell session"
          onClick={onCreateShell}
          onKeyDown={openMenuFromKeyboard}
          disabled={creatingShell}
          className="terminal-new-session-primary-action flex items-center justify-center"
        >
          <PlusIcon aria-hidden="true" size={18} strokeWidth={2.5} />
        </Button>
        <Button
          type="button"
          variant={null}
          size="icon-lg"
          aria-label="Choose session type"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-state={menuOpen ? "open" : "closed"}
          onClick={onToggleMenu}
          onKeyDown={openMenuFromKeyboard}
          disabled={creatingShell}
          className="terminal-new-session-dropdown-trigger flex items-center justify-center"
        >
          <ChevronDownIcon
            aria-hidden="true"
            className="terminal-new-session-dropdown-chevron"
            data-testid="terminal-new-session-dropdown-chevron"
            size={13}
            strokeWidth={2.3}
          />
        </Button>
      </ButtonGroup>
      {menuOpen ? (
        <NewSessionMenu
          align="right"
          onClose={onCloseMenu}
          onCreateShell={onCreateShell}
          onCreateAgent={onCreateAgent}
          agentStatuses={agentStatuses}
          agentStatusesChecking={agentStatusesChecking}
          agentStatusesUnavailable={agentStatusesUnavailable}
          ignoreLightDismissRef={disclosureRef}
        />
      ) : null}
    </div>
  );
}
