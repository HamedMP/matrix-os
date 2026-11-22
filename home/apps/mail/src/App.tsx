import { Mail } from "lucide-react";
import { AppFrame, EmptyState } from "../../_shared/office-ui";

// Placeholder shell; the Mail app replaces this with its real views.
export default function App() {
  return (
    <AppFrame title="Mail" titleIcon={<Mail size={18} />}>
      <EmptyState
        icon={<Mail />}
        headline="Mail is getting ready"
        description="Connect Gmail or Outlook to read, triage and draft mail. Nothing is sent without your click."
      />
    </AppFrame>
  );
}
