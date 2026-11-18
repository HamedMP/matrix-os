import { lstatSync, type Stats } from "node:fs";

const imageRef = "/opt/matrix/bin/matrix-openmausbot.image-ref";
const imageArchive = "/opt/matrix/bin/matrix-openmausbot.image.tar";
type BundleFile = Pick<Stats, "isFile" | "uid" | "mode" | "size">;

// The root-owned host payload opts into the workload. Request authority is
// independent and comes from the authenticated owner of this Computer.
export function admitsOpenMausBotHostBundle(
  readFileStat: (path: string) => BundleFile | undefined = path => lstatSync(path, { throwIfNoEntry: false }),
): boolean {
  try {
    return [imageRef, imageArchive].every(path => {
      const stat = readFileStat(path);
      return stat?.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0 && stat.size > 0;
    });
  } catch (error) {
    console.warn("[hosted-bots] Could not check the installed workload", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}
