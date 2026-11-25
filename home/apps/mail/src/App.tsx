import { ToastProvider } from "../../_shared/office-ui";
import { MailRoot } from "./ui/MailRoot";

export default function App() {
  return (
    <ToastProvider>
      <MailRoot />
    </ToastProvider>
  );
}
