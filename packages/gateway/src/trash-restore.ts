import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const DESTINATION_OCCUPIED = 17;

// Node rename cannot set the native no-replace flag. Use the host's isolated
// Python stdlib to call libc with pinned directory descriptors on both sides.
const RESTORE_WITHOUT_REPLACING = String.raw`
import ctypes
import errno
import os
import sys

root, trash_name, original = sys.argv[1:]
parts = original.split("/")
if any(part in ("", ".", "..") for part in parts):
    sys.exit(1)

libc = ctypes.CDLL(None, use_errno=True)
if sys.platform.startswith("linux"):
    rename = libc.renameat2
    flag = 1  # RENAME_NOREPLACE
elif sys.platform == "darwin":
    rename = libc.renameatx_np
    flag = 4  # RENAME_EXCL
else:
    sys.exit(1)
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int

flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
destination = os.open(root, flags)
source = os.open(".trash", flags, dir_fd=destination)
for name in parts[:-1]:
    try:
        child = os.open(name, flags, dir_fd=destination)
    except FileNotFoundError:
        try:
            os.mkdir(name, dir_fd=destination)
        except FileExistsError:
            pass
        child = os.open(name, flags, dir_fd=destination)
    os.close(destination)
    destination = child

if rename(source, os.fsencode(trash_name), destination, os.fsencode(parts[-1]), flag) != 0:
    sys.exit(17 if ctypes.get_errno() in (errno.EEXIST, errno.ENOTEMPTY) else 1)
`;

export async function restoreWithoutReplacing(homePath: string, trashName: string, originalPath: string): Promise<boolean> {
  try {
    await run("/usr/bin/python3", ["-I", "-c", RESTORE_WITHOUT_REPLACING, homePath, trashName, originalPath], {
      env: {}, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024,
    });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === DESTINATION_OCCUPIED) return false;
    throw error;
  }
}
