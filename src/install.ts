import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgencyAgent } from "./catalog";

export interface InstallResult {
  installed: string[];
  unchanged: string[];
  conflicts: string[];
  failed: { id: string; cause: string }[];
}

async function existingStatus(dest: string, content: Buffer): Promise<"unchanged" | "conflicts"> {
  const info = await lstat(dest);
  if (!info.isFile() || info.size !== content.length) return "conflicts";
  // The entry may have changed since lstat. Never follow a replacement symlink or block on a FIFO.
  const file = await open(dest, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) return "conflicts";
    return (await file.readFile()).equals(content) ? "unchanged" : "conflicts";
  } finally {
    await file.close();
  }
}

export async function installAgents(dir: string, agents: readonly AgencyAgent[]): Promise<InstallResult> {
  const result: InstallResult = { installed: [], unchanged: [], conflicts: [], failed: [] };
  await mkdir(dir, { recursive: true });
  for (const { id, markdown } of agents) {
    try {
      if (!/^agency-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid agent ID — ${id}`);
      const dest = join(dir, `${id}.md`);
      const temp = join(dir, `.agency-${randomUUID()}.tmp`);
      const content = Buffer.from(markdown);
      const file = await open(temp, "wx", 0o600);
      try {
        try {
          await file.writeFile(content);
        } finally {
          await file.close();
        }
        try {
          await link(temp, dest);
          result.installed.push(id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          result[await existingStatus(dest, content)].push(id);
        }
      } finally {
        await unlink(temp);
      }
    } catch (error) {
      result.failed.push({ id, cause: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
