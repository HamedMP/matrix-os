import { BillingGate } from "@/components/BillingGate";
import { ShellHome } from "@/components/ShellHome";

export default function Home() {
  return (
    <BillingGate>
      <ShellHome />
    </BillingGate>
  );
}
