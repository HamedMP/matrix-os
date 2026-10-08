/**
 * A Kysely plugin that answers the shared cite loader (brain/cite.ts loadBrainCites) with no rows, as if every
 * document was tombstoned between a feature's page read and its cite read. Every other query runs unchanged.
 */
import type {
  KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow,
} from "kysely";

function isCiteQuery(node: RootOperationNode): boolean {
  const raw = node as { kind: string; sqlFragments?: readonly string[] };
  return raw.kind === "RawNode" && (raw.sqlFragments ?? []).join("").includes("AS body_tail");
}

export function dropCites(): KyselyPlugin {
  const cited = new WeakSet<object>();
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      if (isCiteQuery(args.node)) cited.add(args.queryId);
      return args.node;
    },
    transformResult: async (args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> =>
      cited.has(args.queryId) ? { ...args.result, rows: [] } : args.result,
  };
}
