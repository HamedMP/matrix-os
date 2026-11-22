import { CalendarDays } from "lucide-react";
import { AppFrame, EmptyState } from "../../_shared/office-ui";

// Placeholder shell; the Calendar app replaces this with its real views.
export default function App() {
  return (
    <AppFrame title="Calendar" titleIcon={<CalendarDays size={18} />}>
      <EmptyState
        icon={<CalendarDays />}
        headline="Calendar is getting ready"
        description="Connect Google or Outlook to see your schedule. Invites go out only after you confirm."
      />
    </AppFrame>
  );
}
