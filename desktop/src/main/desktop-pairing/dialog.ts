import { BaseWindow, dialog, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";

export async function showDesktopLinkDialog(
  parent: BaseWindow | null,
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  options.signal?.throwIfAborted();
  if (parent && !parent.isDestroyed()) return dialog.showMessageBox(parent, options);

  // Electron cannot cancel a parentless macOS message box. This native
  // window owns the sheet while both Matrix renderer windows are closed.
  const owner = new BaseWindow({
    width: 520, height: 104, title: "Matrix", show: false, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
  });
  try {
    owner.show();
    return await dialog.showMessageBox(owner, options);
  } finally {
    if (!owner.isDestroyed()) owner.destroy();
  }
}
