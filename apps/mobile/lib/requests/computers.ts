import {
  MatrixComputerListSchema,
  type MatrixComputer,
  type MatrixComputerList,
} from "@matrix-os/contracts";

import { getSelectedGatewayConnection, HOSTED_GATEWAY_URL } from "@/lib/storage";
import { fetchAuthenticatedJson } from "@/lib/requests/http";

const COMPUTERS_UNAVAILABLE_ERROR = "Computers unavailable. Try again.";

export function fetchComputers(clerkToken: string): Promise<MatrixComputerList> {
  return fetchAuthenticatedJson({
    url: `${HOSTED_GATEWAY_URL}/api/auth/computers`,
    token: clerkToken,
    schema: MatrixComputerListSchema,
    errorMessage: COMPUTERS_UNAVAILABLE_ERROR,
  });
}

export async function fetchActiveComputer(clerkToken: string): Promise<MatrixComputer | null> {
  const [inventory, selectedGateway] = await Promise.all([
    fetchComputers(clerkToken),
    getSelectedGatewayConnection(),
  ]);
  const selectedSlot = inventory.selectedSlot ?? selectedGateway.runtimeSlot;
  if (!selectedSlot) return null;
  return inventory.items.find((computer) => computer.runtimeSlot === selectedSlot) ?? null;
}
