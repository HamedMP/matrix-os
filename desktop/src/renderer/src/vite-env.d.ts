/// <reference types="vite/client" />

declare module "*?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

interface Window {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
}
