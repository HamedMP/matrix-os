import { useQuery } from "@tanstack/react-query";

import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { fetchMatrixCreditBalance, formatMicrousd, mobileQueryKeys } from "@/lib/requests";

/**
 * The Matrix AI credit the account can spend in Chat on the active computer.
 * Read-only. The balance is null while loading and when the server reports
 * none; there is no timer, so a screen reads it again with `refetch` on focus.
 */
export function useMatrixCreditBalance() {
  const gateway = useActiveGateway();
  const balance = useQuery({
    queryKey: mobileQueryKeys.matrixCredit(gateway.userId, gateway.computerKey),
    enabled: gateway.ready,
    queryFn: async () => {
      const session = await gateway.session();
      if (!session) throw new Error("Credit balance unavailable.");
      return fetchMatrixCreditBalance(session.token, session.gatewayUrl);
    },
  });
  const balanceMicrousd = balance.data ?? null;

  return {
    balanceMicrousd,
    /** The balance in dollars ("$18.40"), or null when there is none to show. */
    label: balanceMicrousd === null ? null : formatMicrousd(balanceMicrousd),
    isPending: gateway.authEnabled && (gateway.isComputerPending || (gateway.ready && balance.isPending)),
    isError: gateway.isComputerError || balance.isError,
    refetch: () => balance.refetch(),
  };
}
