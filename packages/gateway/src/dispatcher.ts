import {
  spawnKernel,
  createDB,
  ensureHome,
  type KernelConfig,
  type KernelEvent,
  type MatrixDB,
} from "@matrix-os/kernel";

export interface DispatchOptions {
  homePath: string;
  model?: string;
  maxTurns?: number;
}

export interface Dispatcher {
  dispatch(
    message: string,
    sessionId: string | undefined,
    onEvent: (event: KernelEvent) => void,
  ): Promise<void>;
  db: MatrixDB;
  homePath: string;
}

export function createDispatcher(opts: DispatchOptions): Dispatcher {
  const { homePath } = opts;

  ensureHome(homePath);
  const db = createDB(`${homePath}/system/matrix.db`);

  return {
    db,
    homePath,

    async dispatch(message, sessionId, onEvent) {
      const config: KernelConfig = {
        db,
        homePath,
        sessionId,
        model: opts.model,
        maxTurns: opts.maxTurns,
      };

      for await (const event of spawnKernel(message, config)) {
        onEvent(event);
      }
    },
  };
}
