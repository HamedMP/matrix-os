// Files: create a folder and a file from the Create menu, then prove both exist
// in the list view and on disk in the run's scratch MATRIX_HOME.
// Run: .agents/skills/verify-matrix/scripts/matrix-verify drive .agents/skills/verify-matrix/features/journeys/files-create.mjs
export default async function filesCreate({ page, step, shot, aria, home, check, exists }) {
  const stamp = Date.now().toString(36);
  const folder = `verify-folder-${stamp}`;
  const file = `verify-note-${stamp}.md`;
  const desktopApps = page.getByRole("navigation", { name: "Desktop apps" });
  const browser = page.getByRole("group", { name: "File browser" });
  const list = browser.getByRole("grid", { name: "File list" });

  await step("open Files from the Desktop icon", async () => {
    await desktopApps.getByRole("button", { name: "Files", exact: true }).dblclick();
    await list.waitFor({ timeout: 60_000 });
    await list.getByRole("gridcell", { name: "system" }).waitFor();
  });
  await shot("files-open");

  await step(`Create > New Folder "${folder}"`, async () => {
    await browser.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("menuitem", { name: "New Folder" }).click();
    const dialog = page.getByRole("dialog", { name: "New folder" });
    await dialog.getByRole("textbox", { name: "Folder name" }).fill(folder);
    await shot("new-folder-dialog");
    await dialog.getByRole("button", { name: "Create folder" }).click();
    await dialog.waitFor({ state: "hidden" });
    await list.getByRole("gridcell", { name: folder }).waitFor({ timeout: 15_000 });
  });
  await shot("folder-in-list");
  await check("folder exists on disk in scratch home", await exists(home(folder)), home(folder));

  await step(`Create > New File "${file}"`, async () => {
    await browser.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("menuitem", { name: "New File" }).click();
    const dialog = page.getByRole("dialog", { name: "New file" });
    await dialog.getByRole("textbox", { name: "File name" }).fill(file);
    await dialog.getByRole("button", { name: "Create file" }).click();
    await dialog.waitFor({ state: "hidden" });
  });
  // Creating a file opens it in an editor window; the file's own presence on disk is the side effect.
  await page.waitForTimeout(1_500);
  await shot("file-created");
  await check("file exists on disk in scratch home", await exists(home(file)), home(file));

  await step("second view: reload the Desktop and reopen Files", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await desktopApps.waitFor({ timeout: 120_000 });
    if (!(await list.isVisible())) {
      await desktopApps.getByRole("button", { name: "Files", exact: true }).dblclick();
    }
    await list.getByRole("gridcell", { name: folder }).waitFor({ timeout: 60_000 });
    await list.getByRole("gridcell", { name: file }).waitFor({ timeout: 15_000 });
  });
  await shot("after-reload");
  await aria("file-list", list);
  await check("folder and file listed after reload", true, `${folder}, ${file}`);
}
