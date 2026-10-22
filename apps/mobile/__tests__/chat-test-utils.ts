import type { ReactTestInstance } from "react-test-renderer";

/**
 * The test IDs of the views drawn inside `node`, in the order they are drawn.
 * Read from the rendered views only: a serialised tree also carries props such
 * as a list's `data`, whose text is not in drawing order.
 */
export function drawnTestIds(node: ReactTestInstance): string[] {
  const ids: string[] = [];
  const visit = (instance: ReactTestInstance) => {
    for (const child of instance.children) {
      if (typeof child === "string") continue;
      if (typeof child.type === "string" && typeof child.props.testID === "string") ids.push(child.props.testID);
      visit(child);
    }
  };
  visit(node);
  return ids;
}
