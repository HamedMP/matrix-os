/** Catalog freshness is inference authority, not an optional presentation cache.
 * Keep the latest read's qualification and release peer drains outside vault mutations. */
export function createPlanCatalogRefresh() {
    let revision = 0;
    let qualifiedRevision = 0;
    return async function refresh<T>(deps: {
        current(): boolean;
        read(): Promise<T>;
        mutate<R>(operation: () => Promise<R>): Promise<R>;
        apply(value: T): void;
        invalidate(): Promise<void>;
    }): Promise<void> {
        const attempt = ++revision;
        const current = () => attempt === revision && deps.current();
        try {
            const next = await deps.read();
            await deps.mutate(async () => {
                if (current()) { deps.apply(next); qualifiedRevision = attempt; }
            });
        }
        catch (error: unknown) {
            const invalidated = await deps.mutate(async () => {
                // Calling invalidate fences the captured peer synchronously. Wrapping
                // its drain keeps token-refresh mutations free to settle after abort.
                // An unfinished newer read is not fresh authority. Only a newer
                // successfully qualified catalog may protect against an older failure.
                return attempt >= qualifiedRevision && deps.current() ? { drain: deps.invalidate() } : null;
            });
            await invalidated?.drain;
            throw error;
        }
    };
}
