import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowExpand01Icon, ArrowUpIcon, MinusIcon, MicIcon, SearchIcon, PlusSignIcon, MoreHorizontalIcon, Bug, Hammer, CircleCheck } from "@hugeicons/core-free-icons";
const icons = { expand: ArrowExpand01Icon, send: ArrowUpIcon, minimize: MinusIcon, microphone: MicIcon,
  search: SearchIcon, add: PlusSignIcon, more: MoreHorizontalIcon, bug: Bug, hammer: Hammer, check: CircleCheck };
/** The same Hugeicons geometry on both desktop clients and the corner widget. */
export function ChatIcon({ name, size = 16 }: { name: keyof typeof icons; size?: number }) {
  return <HugeiconsIcon icon={icons[name]} size={size} strokeWidth={1.5} aria-hidden="true" />;
}
