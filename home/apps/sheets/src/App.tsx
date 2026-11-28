import { Table } from "lucide-react";
import { AppFrame, EmptyState, ToastProvider } from "../../_shared/office-ui";
import { getBridge } from "./ui/bridge";
import { SheetsApp } from "./ui/SheetsApp";

const bridge = getBridge();

export default function App() {
  if (bridge === null) {
    return (
      <AppFrame className="sheets-app" title="Sheets" titleIcon={<Table size={18} />}>
        <EmptyState
          icon={<Table />}
          headline="Files are not available in this window"
          description="Sheets reads and saves workbooks in your home. Open Sheets from the Matrix OS desktop to use it."
        />
      </AppFrame>
    );
  }
  return (
    <ToastProvider>
      <SheetsApp bridge={bridge} />
    </ToastProvider>
  );
}
