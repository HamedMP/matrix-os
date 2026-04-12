import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveWithinHome } from "./path-security.js";
import { GroupManifestSchema, GROUP_SLUG_REGEX } from "./group-types.js";
import type { GroupManifest } from "./group-types.js";

export interface GroupSyncHandle {
  hydrate(): Promise<void>;
}

interface GroupEntry {
  manifest: GroupManifest;
  sync: GroupSyncHandle | null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function isValidSlug(s: string): boolean {
  return GROUP_SLUG_REGEX.test(s);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, filePath);
}

export class GroupRegistry {
  private readonly homePath: string;
  private groups = new Map<string, GroupEntry>();

  constructor(homePath: string) {
    this.homePath = homePath;
  }

  private get groupsDir(): string {
    return join(this.homePath, "groups");
  }

  async scan(): Promise<void> {
    this.groups.clear();
    let entries: string[];
    try {
      entries = await readdir(this.groupsDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === "_archive") continue;
      const groupDir = join(this.groupsDir, entry);
      const manifestPath = join(groupDir, "manifest.json");
      try {
        const raw = await readFile(manifestPath, "utf-8");
        const parsed = JSON.parse(raw);
        const manifest = GroupManifestSchema.parse(parsed);
        this.groups.set(manifest.slug, { manifest, sync: null });
      } catch (err) {
        const ts = Date.now();
        const quarantinePath = join(groupDir, `manifest.json.corrupt-${ts}`);
        try {
          await rename(manifestPath, quarantinePath);
        } catch {
          // best-effort rename
        }
        console.error(
          JSON.stringify({
            level: "error",
            event: "group_manifest_corrupt",
            group_dir: entry,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  list(): GroupManifest[] {
    return Array.from(this.groups.values()).map((e) => e.manifest);
  }

  get(slug: string): GroupManifest | null {
    return this.groups.get(slug)?.manifest ?? null;
  }

  async create(opts: {
    roomId: string;
    name: string;
    ownerHandle: string;
  }): Promise<GroupManifest> {
    const baseSlug = slugify(opts.name);

    if (!baseSlug || !isValidSlug(baseSlug)) {
      throw new Error(`Cannot derive valid slug from name: "${opts.name}"`);
    }

    let slug = baseSlug;
    let suffix = 1;
    while (this.groups.has(slug)) {
      slug = `${baseSlug}-${suffix++}`;
      if (!isValidSlug(slug)) {
        throw new Error(`Cannot generate unique slug for "${opts.name}"`);
      }
    }

    const groupDir = resolveWithinHome(this.homePath, join("groups", slug));
    if (!groupDir) {
      throw new Error(`Path traversal detected for slug "${slug}"`);
    }

    await mkdir(groupDir, { recursive: true });

    const manifest: GroupManifest = {
      room_id: opts.roomId,
      name: opts.name,
      slug,
      owner_handle: opts.ownerHandle,
      joined_at: Date.now(),
      schema_version: 1,
    };

    // Validate before writing
    GroupManifestSchema.parse(manifest);

    const manifestPath = join(groupDir, "manifest.json");
    await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));

    this.groups.set(slug, { manifest, sync: null });
    return manifest;
  }

  async archive(slug: string): Promise<void> {
    const entry = this.groups.get(slug);
    if (!entry) {
      throw new Error(`Group not found: "${slug}"`);
    }

    const groupDir = resolveWithinHome(this.homePath, join("groups", slug));
    if (!groupDir) {
      throw new Error(`Path traversal detected for slug "${slug}"`);
    }

    const archiveBase = resolveWithinHome(this.homePath, join("groups", "_archive"));
    if (!archiveBase) {
      throw new Error("Path traversal detected for archive directory");
    }

    await mkdir(archiveBase, { recursive: true });
    const archiveDir = join(archiveBase, `${slug}-${Date.now()}`);
    await rename(groupDir, archiveDir);

    this.groups.delete(slug);
  }

  attachSync(slug: string, sync: GroupSyncHandle): void {
    const entry = this.groups.get(slug);
    if (!entry) return;
    entry.sync = sync;
  }

  getSyncHandle(slug: string): GroupSyncHandle | null {
    return this.groups.get(slug)?.sync ?? null;
  }
}
