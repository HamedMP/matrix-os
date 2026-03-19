export type BridgeMessage =
  | { type: "os:generate"; app: string; payload: { context: string } }
  | { type: "os:navigate"; app: string; payload: { route: string; context?: string } }
  | { type: "os:read-data"; app: string; payload: { key: string } }
  | { type: "os:write-data"; app: string; payload: { key: string; value: string } }
  | { type: "os:open-app"; app: string; payload: { name: string; path: string } };

export interface BridgeHandler {
  sendToKernel: (text: string) => void;
  fetchData: (
    action: "read" | "write",
    app: string,
    key: string,
    value: string | undefined,
  ) => void;
  openApp?: (name: string, path: string) => void;
}

export const THEME_VAR_MAP: Record<string, string> = {
  "--background": "--matrix-bg",
  "--foreground": "--matrix-fg",
  "--primary": "--matrix-accent",
  "--border": "--matrix-border",
  "--card": "--matrix-card-bg",
  "--card-foreground": "--matrix-card-fg",
  "--input": "--matrix-input-bg",
  "--font-sans": "--matrix-font-sans",
  "--font-mono": "--matrix-font-mono",
  "--radius": "--matrix-radius",
};

export type ThemeVars = Record<string, string>;

export function getThemeVariables(style: CSSStyleDeclaration): ThemeVars {
  const vars: ThemeVars = {};
  for (const [shellVar, matrixVar] of Object.entries(THEME_VAR_MAP)) {
    vars[matrixVar] = style.getPropertyValue(shellVar).trim();
  }
  return vars;
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

    case "os:open-app":
      if (handler.openApp && msg.payload.name && msg.payload.path) {
        handler.openApp(msg.payload.name, msg.payload.path);
      }
      break;
  }
}

function buildThemeStyleBlock(themeVars: ThemeVars): string {
  const entries = Object.entries(themeVars)
    .filter(([, v]) => v)
    .map(([k, v]) => `    ${k}: ${v};`)
    .join("\n");
  if (!entries) return "";
  return `:root {\n${entries}\n  }`;
}

export function buildBridgeScript(appName: string, themeVars?: ThemeVars): string {
  const themeJson = JSON.stringify(themeVars ?? {});
  const initialCss = themeVars ? buildThemeStyleBlock(themeVars) : "";

  return `
(function() {
  var app = ${JSON.stringify(appName)};
  var currentTheme = ${themeJson};

  function post(type, payload) {
    window.parent.postMessage({ type: type, app: app, payload: payload }, "*");
  }

  // Inject theme style tag
  var themeStyle = document.createElement("style");
  themeStyle.id = "matrix-os-theme";
  themeStyle.textContent = ${JSON.stringify(initialCss)};
  document.head.appendChild(themeStyle);

  var dataChangeCallbacks = [];

  // Listen for dynamic theme updates and data change notifications
  window.addEventListener("message", function(e) {
    if (!e.data || !e.data.type) return;

    if (e.data.type === "os:theme-update" && e.data.payload) {
      currentTheme = e.data.payload;
      var css = ":root {\\n";
      for (var k in currentTheme) {
        if (currentTheme[k]) css += "    " + k + ": " + currentTheme[k] + ";\\n";
      }
      css += "  }";
      themeStyle.textContent = css;
      if (window.MatrixOS) window.MatrixOS.theme = currentTheme;
    }

    if (e.data.type === "os:data-change" && e.data.payload) {
      var changeKey = e.data.payload.key;
      for (var i = 0; i < dataChangeCallbacks.length; i++) {
        try { dataChangeCallbacks[i](changeKey, e.data.payload.app); } catch(err) {}
      }
    }
  });

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

    openApp: function(name, path) {
      post("os:open-app", { name: name, path: path });
    },

    onDataChange: function(callback) {
      dataChangeCallbacks.push(callback);
      return function() {
        var idx = dataChangeCallbacks.indexOf(callback);
        if (idx >= 0) dataChangeCallbacks.splice(idx, 1);
      };
    },

    theme: currentTheme,

    app: { name: app },

    db: {
      find: function(table, opts) {
        var body = { app: app, action: "find", table: table };
        if (opts) {
          if (opts.where) body.filter = opts.where;
          if (opts.orderBy) body.orderBy = opts.orderBy;
          if (opts.limit) body.limit = opts.limit;
          if (opts.offset) body.offset = opts.offset;
        }
        return fetch("/api/bridge/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }).then(function(r) { return r.json(); });
      },

      findOne: function(table, id) {
        return fetch("/api/bridge/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app: app, action: "findOne", table: table, id: id })
        }).then(function(r) { return r.json(); });
      },

      insert: function(table, data) {
        return fetch("/api/bridge/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app: app, action: "insert", table: table, data: data })
        }).then(function(r) { return r.json(); });
      },

      update: function(table, id, data) {
        return fetch("/api/bridge/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app: app, action: "update", table: table, id: id, data: data })
        }).then(function(r) { return r.json(); });
      },

      delete: function(table, id) {
        return fetch("/api/bridge/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app: app, action: "delete", table: table, id: id })
        }).then(function(r) { return r.json(); });
      },

      count: function(table, filter) {
        return fetch("/api/bridge/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app: app, action: "count", table: table, filter: filter })
        }).then(function(r) { return r.json(); }).then(function(d) { return d.count; });
      },

      onChange: function(table, callback) {
        var wrappedCb = function(key, changedApp) {
          if (key === table && changedApp === app) callback({ table: table });
        };
        dataChangeCallbacks.push(wrappedCb);
        return function() {
          var idx = dataChangeCallbacks.indexOf(wrappedCb);
          if (idx >= 0) dataChangeCallbacks.splice(idx, 1);
        };
      }
    }
  };
})();
`;
}
