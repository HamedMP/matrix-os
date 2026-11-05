import { RuntimeHandleSchema } from "./protocol.js";

/** Operator configuration only; never accept a caller-supplied unit prefix. */
export function createScopeRuntimeUnitIdentity(namespace?: string) {
  if (namespace !== undefined && (namespace !== namespace.trim()
    || !/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(namespace))) {
    throw new Error("Invalid scope runtime namespace");
  }
  const stem = namespace === undefined ? "matrix-scope-runtime" : `matrix-devstack-${namespace}-scope-runtime`;
  const workerUnitPrefix = `${stem}-`;
  return Object.freeze({
    workerUnitPrefix,
    supervisorUnit: `${stem}.service`,
    discoveryGlob: `${workerUnitPrefix}*.service`,
    workerUnit(runtimeHandle: string): string {
      return `${workerUnitPrefix}${RuntimeHandleSchema.parse(runtimeHandle).slice("runtime_".length)}.service`;
    },
    parseWorkerUnit(name: string): string | undefined {
      if (!name.startsWith(workerUnitPrefix)) return undefined;
      const suffix = name.slice(workerUnitPrefix.length);
      if (suffix.length !== 40 || !/^[a-f0-9]{32}\.service$/.test(suffix)) return undefined;
      return RuntimeHandleSchema.parse(`runtime_${suffix.slice(0, 32)}`);
    },
  });
}
