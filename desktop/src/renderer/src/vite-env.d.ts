/// <reference types="vite/client" />

declare module "posthog-js/dist/conversations";

declare module "*?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

interface Window {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
}
