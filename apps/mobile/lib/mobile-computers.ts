import {
  MatrixComputerListSchema,
  type MatrixComputer,
} from "@matrix-os/contracts";
import { createTimeoutSignal } from "@/lib/gateway-client";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

const COMPUTER_LIST_TIMEOUT_MS = 10_000;
const COMPUTER_LIST_ERROR = "Computers unavailable. Try again.";

export type MatrixComputerListResult =
  | { ok: true; computers: MatrixComputer[]; selectedSlot: string | null }
  | { ok: false; error: typeof COMPUTER_LIST_ERROR };

export async function fetchMatrixComputers(clerkToken: string): Promise<MatrixComputerListResult> {
  if (!clerkToken.trim()) return { ok: false, error: COMPUTER_LIST_ERROR };
  try {
    const response = await fetch(`${HOSTED_GATEWAY_URL}/api/auth/computers`, {
      headers: { Authorization: `Bearer ${clerkToken}` },
      signal: createTimeoutSignal(COMPUTER_LIST_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, error: COMPUTER_LIST_ERROR };
    const parsed = MatrixComputerListSchema.safeParse(await response.json());
    if (!parsed.success) return { ok: false, error: COMPUTER_LIST_ERROR };
    return {
      ok: true,
      computers: parsed.data.items,
      selectedSlot: parsed.data.selectedSlot,
    };
  } catch {
    return { ok: false, error: COMPUTER_LIST_ERROR };
  }
}
