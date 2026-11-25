// "Let a Computer Use This Device…" from the app menu (spec 2716), for desktops
// with no Terminal window to hold the switch (Windows). Native dialogs only:
// pick one of the person's computers, read what it allows, confirm. Nothing
// is linked without that confirmation.

export interface NativeDialog {
  showMessageBox(options: {
    type: "question" | "warning" | "info";
    title: string;
    message: string;
    detail?: string;
    buttons: string[];
    defaultId?: number;
    cancelId?: number;
    noLink?: boolean;
  }): Promise<{ response: number }>;
}

export interface NativeEnableOptions {
  dialog: NativeDialog;
  /** The person's computers, as the app's computer list reports them. */
  listComputers(): Promise<Array<{ runtimeSlot: string; label: string }>>;
  enable(slot: string, computerName: string): Promise<void>;
  /** Slots already linked, so the list says which are on. */
  linkedSlots(): string[];
}

const MAX_CHOICES = 6;

export const NATIVE_ENABLE_FAILED = "Couldn't let that computer use this device. Check that you are signed in, then try again.";

/** Runs the whole choice; resolves to the slot that was switched on, or null when the person stopped. */
export async function letComputerUseThisDevice(options: NativeEnableOptions): Promise<string | null> {
  const computers = (await options.listComputers()).slice(0, MAX_CHOICES);
  if (computers.length === 0) {
    await options.dialog.showMessageBox({
      type: "info", title: "Matrix OS", message: "No Matrix computer to link yet.",
      detail: "Sign in and set up a Matrix computer first.", buttons: ["OK"],
    });
    return null;
  }
  const linked = new Set(options.linkedSlots());
  const buttons = [...computers.map((computer) => (linked.has(computer.runtimeSlot) ? `${computer.label} (on)` : computer.label)), "Cancel"];
  const choice = await options.dialog.showMessageBox({
    type: "question", title: "Matrix OS", message: "Which computer may use this device?",
    detail: "It will be able to open terminals and run agents here, as you.",
    buttons, cancelId: buttons.length - 1, defaultId: buttons.length - 1, noLink: true,
  });
  const computer = computers[choice.response];
  if (!computer) return null;
  const confirmed = await options.dialog.showMessageBox({
    type: "warning", title: "Matrix OS", message: `Let ${computer.label} use this device?`,
    detail: `${computer.label} will be able to open terminals and run agents on this device as you. That is full shell access: anything you can do in a terminal, it can do. Only you, signed in to ${computer.label}, can use it. Nothing on this device listens for connections; this app connects out. Turn it off at any time with Stop Computers Using This Device in the app menu.`,
    buttons: [`Let ${computer.label} use this device`, "Cancel"], cancelId: 1, defaultId: 1, noLink: true,
  });
  if (confirmed.response !== 0) return null;
  try {
    await options.enable(computer.runtimeSlot, computer.label);
    return computer.runtimeSlot;
  } catch (error: unknown) {
    console.warn("[desktop-link] enable failed:", error instanceof Error ? error.name : "UnknownError");
    await options.dialog.showMessageBox({ type: "warning", title: "Matrix OS", message: NATIVE_ENABLE_FAILED, buttons: ["OK"] });
    return null;
  }
}
