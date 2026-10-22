import { Directory, File, Paths } from "expo-file-system";
import { Platform, Share } from "react-native";

const RECORDS_FILE_NAME = "matrix-account.json";

/**
 * Hands the account records to the user as a file.
 *
 * iOS gets the share sheet (Save to Files, AirDrop, ...), fed from a cache file
 * that is removed again once the sheet closes. Android's share sheet only takes
 * text, which would put the whole export into a single intent, so the user
 * picks a folder and the file is written there instead.
 *
 * Resolves false when the user backed out of the Android folder picker, and
 * rejects when the file could not be written or shared.
 */
export async function saveAccountRecords(json: string): Promise<boolean> {
  if (Platform.OS === "android") return saveToPickedDirectory(json);

  const file = new File(Paths.cache, RECORDS_FILE_NAME);
  try {
    if (file.exists) file.delete();
    file.create();
    file.write(json);
    await Share.share({ url: file.uri });
    return true;
  } finally {
    // The export holds personal data; it must not outlive the share sheet.
    if (file.exists) file.delete();
  }
}

async function saveToPickedDirectory(json: string): Promise<boolean> {
  let directory: Directory;
  try {
    directory = await Directory.pickDirectoryAsync();
  } catch (error: unknown) {
    // Backing out of the picker is a choice, not a failure; anything else is
    // reported to the caller.
    if (isPickerCancellation(error)) return false;
    throw error;
  }
  directory.createFile(RECORDS_FILE_NAME, "application/json").write(json);
  return true;
}

// expo-file-system rejects a dismissed picker with PickerCancelledException,
// which reaches JS as code ERR_PICKER_CANCELLED.
function isPickerCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as { code?: unknown }).code === "ERR_PICKER_CANCELLED"
    || /cancell?ed by the user/i.test(error.message);
}
