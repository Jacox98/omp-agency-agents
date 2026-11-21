import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { agentFrontmatterFields, type Catalog } from "./catalog";

const version = 1;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && /\S/.test(value);

function hasAgentMarkdown(markdown: string, id: string, description: string): boolean {
  const notice = /^---\n(?:# [^\n]*\n)+/.exec(markdown);
  if (!notice) return false;
  const fields = agentFrontmatterFields(id, description);
  return markdown.startsWith(fields, notice[0].length) && /\S/.test(markdown.slice(notice[0].length + fields.length));
}

function isCatalog(value: unknown): value is Catalog {
  if (!record(value) || !Array.isArray(value.agents) || !value.agents.length ||
      !Array.isArray(value.skipped) || !value.skipped.every(text)) return false;
  const ids = new Set<string>();
  for (const agent of value.agents) {
    if (!record(agent) || !text(agent.id) || !/^agency-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent.id) || ids.has(agent.id) ||
        !text(agent.name) || !text(agent.description) || !text(agent.division) || !text(agent.sourcePath) ||
        typeof agent.markdown !== "string" || !hasAgentMarkdown(agent.markdown, agent.id, agent.description)) return false;
    ids.add(agent.id);
  }
  if (value.runbooks === undefined) return true; // Earlier v1 snapshots contain only divisions and paths.
  return Array.isArray(value.runbooks) && value.runbooks.every(book =>
    record(book) && text(book.slug) && text(book.title) && Array.isArray(book.roster) &&
    book.roster.every((team: unknown) => record(team) && text(team.group) && Array.isArray(team.agents) &&
      team.agents.every((id: unknown) => typeof id === "string" && ids.has(id)))
  );
}

async function readCached(path: string, signal: AbortSignal): Promise<Catalog | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (record(parsed) && parsed.version === version && isCatalog(parsed.catalog)) return parsed.catalog;
  return undefined;
}

export async function getCachedCatalog(
  cacheDir: string, refresh: boolean, signal: AbortSignal, download: () => Promise<Catalog>,
): Promise<Catalog> {
  signal.throwIfAborted();
  const path = join(cacheDir, `catalog-v${version}.json`);
  if (!refresh) {
    const cached = await readCached(path, signal);
    signal.throwIfAborted();
    if (cached) return cached;
  }

  const catalog = await download();
  signal.throwIfAborted();
  if (!isCatalog(catalog)) throw new Error("Invalid downloaded catalog");
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const temp = join(cacheDir, `.catalog-${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify({ version, catalog }), { signal });
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    // Publish in the same turn as the final cancellation check.
    renameSync(temp, path);
  } catch (error) {
    await unlink(temp);
    throw error;
  }
  return catalog;
}
