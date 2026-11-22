import { Table } from "lucide-react";
import { AppFrame, EmptyState } from "../../_shared/office-ui";

// Placeholder shell; the Sheets app replaces this with its real views.
export default function App() {
  return (
    <AppFrame title="Sheets" titleIcon={<Table size={18} />}>
      <EmptyState
        icon={<Table />}
        headline="Sheets is getting ready"
        description="Open a .xlsx or .csv file from Files to edit it. Agent cell changes show old and new values for review."
      />
    </AppFrame>
  );
}
