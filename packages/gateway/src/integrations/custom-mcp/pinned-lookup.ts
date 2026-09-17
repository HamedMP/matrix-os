import type { LookupFunction } from "node:net";
import type { ResolvedCustomMcpUrl } from "./security.js";

/** Keep both Node lookup modes pinned to the one SSRF-validated address. */
export function createPinnedCustomMcpLookup(
  target: Pick<ResolvedCustomMcpUrl, "address" | "family">,
): LookupFunction {
  return (_hostname, options, callback) => {
    // Node's automatic address-family selection asks for all addresses.
    if (options.all) {
      callback(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  };
}
