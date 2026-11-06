import { logPlanFailure } from './diagnostics';

const VALIDITY_MS = 5 * 60000;
/** One local lease, advanced only by a successful catalog. No wire authority. */
export function createPlanCatalogValidity(expire: () => Promise<void>) {
    let qualified: { at: number; authority: string } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function clear() {
        if (timer) clearTimeout(timer);
        timer = undefined;
        qualified = null;
    }
    function fresh() {
        const age = qualified ? Date.now() - qualified.at : -1;
        return age >= 0 && age < VALIDITY_MS;
    }
    function qualify(authority: string) {
        clear();
        const value = { at: Date.now(), authority };
        qualified = value;
        const onDeadline = () => {
            if (qualified !== value) return;
            const remaining = value.at + VALIDITY_MS - Date.now();
            if (Date.now() >= value.at && remaining > 0) {
                timer = setTimeout(onDeadline, remaining); timer.unref();
                return;
            }
            clear();
            // expire fences/aborts synchronously; only its peer drain is async.
            void expire().catch((error: unknown) => logPlanFailure('catalog_expiry', error));
        };
        timer = setTimeout(onDeadline, VALIDITY_MS); timer.unref();
    }
    return { clear, fresh, qualify, matches: (authority: string) => fresh() && qualified?.authority === authority,
        at: () => qualified?.at ?? 0 };
}
