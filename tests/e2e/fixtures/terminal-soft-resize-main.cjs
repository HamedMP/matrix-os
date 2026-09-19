const { app, BrowserWindow } = require("electron");

// Isolated component verification: no preload, credentials, or production IPC.
app.setPath("userData", process.env.MATRIX_TERMINAL_FIXTURE_USER_DATA);
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1800, height: 1300,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  return window.loadURL(process.env.MATRIX_TERMINAL_FIXTURE_URL);
}).catch((error) => {
  console.error("Terminal fixture failed", error);
  app.exit(1);
});
app.on("window-all-closed", () => app.quit());
