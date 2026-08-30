import { MessageCircle } from "../../lib/hugeicons";
import {
  openDesktopSupport,
} from "./DesktopSupportWidget";

export default function DesktopSupportButton() {
  return (
    <button
      type="button"
      aria-label="Support"
      title="Support"
      className="flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
      style={{ color: "var(--text-secondary)" }}
      onClick={() => {
        void openDesktopSupport();
      }}
    >
      <MessageCircle aria-hidden="true" size={16} />
    </button>
  );
}
