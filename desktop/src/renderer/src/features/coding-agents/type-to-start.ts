const TYPE_TO_START_INTERACTIVE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='textbox']",
  "[role='combobox']",
  "[role='listbox']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function isTypeToStartInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TYPE_TO_START_INTERACTIVE_SELECTOR) !== null;
}
