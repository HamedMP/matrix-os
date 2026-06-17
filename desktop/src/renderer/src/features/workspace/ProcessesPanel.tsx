import { Activity } from "lucide-react";
import { EmptyState } from "../../design/primitives";

export default function ProcessesPanel() {
  return (
    <EmptyState
      icon={<Activity size={22} />}
      headline="Processes"
      description="Live process listing arrives with gateway support. Use the terminal (`htop`) meanwhile."
    />
  );
}
