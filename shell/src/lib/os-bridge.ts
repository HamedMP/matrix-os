export type BridgeMessage =
  | { type: "os:generate"; app: string; payload: { context: string } }
  | { type: "os:navigate"; app: string; payload: { route: string; context?: string } }
  | { type: "os:read-data"; app: string; payload: { key: string } }
  | { type: "os:write-data"; app: string; payload: { key: string; value: string } };

export interface BridgeHandler {
  sendToKernel: (text: string) => void;
  fetchData: (
    action: "read" | "write",
    app: string,
    key: string,
    value: string | undefined,
  ) => void;
}

export function handleBridgeMessage(
  event: MessageEvent,
  handler: BridgeHandler,
) {
  const data = event.data;
  if (!data || typeof data !== "object" || typeof data.type !== "string") return;
  if (!data.type.startsWith("os:")) return;

  const msg = data as BridgeMessage;

  switch (msg.type) {
    case "os:generate":
      handler.sendToKernel(`[App: ${msg.app}] ${msg.payload.context}`);
      break;

    case "os:navigate": {
      const ctx = msg.payload.context
        ? `: ${msg.payload.context}`
        : "";
      handler.sendToKernel(
        `[App: ${msg.app}] Navigate to ${msg.payload.route}${ctx}`,
      );
      break;
    }

    case "os:read-data":
      handler.fetchData("read", msg.app, msg.payload.key, undefined);
      break;

    case "os:write-data":
      handler.fetchData("write", msg.app, msg.payload.key, msg.payload.value);
      break;
  }
}

export function buildBridgeScript(appName: string): string {
  return `
(function() {
  var app = ${JSON.stringify(appName)};

  function post(type, payload) {
    window.parent.postMessage({ type: type, app: app, payload: payload }, "*");
  }

  window.MatrixOS = {
    generate: function(context) {
      post("os:generate", { context: context });
    },

    navigate: function(route, context) {
      var payload = { route: route };
      if (context) payload.context = context;
      post("os:navigate", payload);
    },

    readData: function(key) {
      return new Promise(function(resolve) {
        var channel = new MessageChannel();
        channel.port1.onmessage = function(e) { resolve(e.data); };
        window.parent.postMessage(
          { type: "os:read-data", app: app, payload: { key: key } },
          "*",
          [channel.port2]
        );
      });
    },

    writeData: function(key, value) {
      return new Promise(function(resolve) {
        var channel = new MessageChannel();
        channel.port1.onmessage = function() { resolve(); };
        window.parent.postMessage(
          { type: "os:write-data", app: app, payload: { key: key, value: value } },
          "*",
          [channel.port2]
        );
      });
    },

    app: { name: app }
  };
})();
`;
}
