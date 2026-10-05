import { MemoryIcon } from "./MemoryIcon.js";
import { headingStyle } from "./styles.js";
export function MemoryEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: import("react").ReactNode;
}) {
  return (
    <div className="mw-empty">
      <div className="mw-empty-inner">
        <div className="mw-empty-icon">
          <MemoryIcon name="library" size={28} />
        </div>
        <h2 style={headingStyle}>{title}</h2>
        <p>{description}</p>
        {action}
      </div>
    </div>
  );
}
