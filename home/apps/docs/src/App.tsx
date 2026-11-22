import { FileText } from "lucide-react";
import { AppFrame, EmptyState } from "../../_shared/office-ui";

// Placeholder shell; the Docs app replaces this with its real views.
export default function App() {
  return (
    <AppFrame title="Docs" titleIcon={<FileText size={18} />}>
      <EmptyState
        icon={<FileText />}
        headline="Docs is getting ready"
        description="Open a .docx file from Files to edit it. Agent edits arrive as tracked changes you review."
      />
    </AppFrame>
  );
}
