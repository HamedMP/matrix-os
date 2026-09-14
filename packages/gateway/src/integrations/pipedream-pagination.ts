/** A bounded inventory read: never return partial data as a complete listing. */
interface SdkPage<T> {
  data: T[];
  hasNextPage(): boolean;
  getNextPage(): Promise<SdkPage<T>>;
}

export async function collectPipedreamPages<T>(initial: SdkPage<T>): Promise<T[]> {
  const items: T[] = [];
  let page = initial;
  for (let count = 0; count < 20; count++) {
    if (!Array.isArray(page.data)) throw new Error("Invalid integration inventory page");
    if (items.length + page.data.length > 2000) throw new Error("Integration pagination limit exceeded");
    items.push(...page.data);
    if (!page.hasNextPage()) return items;
    if (count === 19) break;
    // Page.getNextPage mutates the SDK Page in place. Consume data before advancing.
    page = await page.getNextPage();
  }
  throw new Error("Integration pagination limit exceeded");
}
