import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

export interface AgencyAgent {
  id: string;
  name: string;
  description: string;
  division: string;
  sourcePath: string;
  markdown: string;
}

export interface Runbook {
  slug: string;
  title: string;
  roster: { group: string; agents: string[] }[];
}

export interface Catalog {
  agents: AgencyAgent[];
  skipped: string[];
  runbooks?: Runbook[];
}

const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function agentFrontmatterFields(id: string, description: string): string {
  return `name: ${JSON.stringify(id)}\ndescription: ${JSON.stringify(description)}\n---\n`;
}

async function requiredFile(root: string, name: string, signal?: AbortSignal) {
  const path = join(root, name);
  if (!(await lstat(path)).isFile()) throw new Error(`${name} must be a regular file`);
  return readFile(path, { encoding: "utf8", signal });
}

function parseJson(source: string, name: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid ${name} — ${error}`);
  }
}

async function readRunbooks(root: string, byId: ReadonlyMap<string, AgencyAgent>, signal?: AbortSignal): Promise<Runbook[]> {
  const name = "strategy/runbooks.json";
  let source: string;
  try {
    const strategy = await lstat(join(root, "strategy"));
    if (strategy.isSymbolicLink()) return [];
    if (!strategy.isDirectory()) throw new Error("strategy must be a directory");
    const path = join(root, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return [];
    if (!stat.isFile()) throw new Error(`${name} must be a regular file`);
    source = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const manifest = parseJson(source, name);
  if (!record(manifest) || !Array.isArray(manifest.runbooks)) throw new Error(`${name} must contain a runbooks array`);
  const runbooks: Runbook[] = [];
  const slugs = new Set<string>();
  for (const [index, book] of manifest.runbooks.entries()) {
    const location = `${name} runbooks[${index}]`;
    if (!record(book) || !text(book.slug) || !kebab.test(book.slug)) throw new Error(`${location} requires a kebab-case slug`);
    if (slugs.has(book.slug)) throw new Error(`${location} repeats slug ${book.slug}`);
    slugs.add(book.slug);
    if (!text(book.title)) throw new Error(`${location} requires a title`);
    if (!Array.isArray(book.roster)) throw new Error(`${location} requires a roster array`);
    const teams = new Map<string, Set<string>>();
    for (const [teamIndex, team] of book.roster.entries()) {
      const teamLocation = `${location}.roster[${teamIndex}]`;
      if (!record(team) || !text(team.group)) throw new Error(`${teamLocation} requires a group name`);
      if (!Array.isArray(team.agents)) throw new Error(`${teamLocation} requires an agents array`);
      const group = team.group.trim();
      const ids = teams.get(group) ?? new Set<string>();
      teams.set(group, ids);
      for (const stem of team.agents) {
        if (!text(stem) || !kebab.test(stem)) throw new Error(`${teamLocation}.agents requires kebab-case agent stems`);
        const id = `agency-${stem}`;
        if (byId.has(id)) ids.add(id);
      }
    }
    const roster: Runbook["roster"] = [];
    for (const [group, ids] of teams) {
      if (ids.size) roster.push({ group, agents: [...ids] });
    }
    if (roster.length) runbooks.push({ slug: book.slug, title: book.title.trim(), roster });
  }
  return runbooks;
}

export async function readCatalog(root: string, signal?: AbortSignal): Promise<Catalog> {
  signal?.throwIfAborted();
  const manifest = parseJson(await requiredFile(root, "divisions.json", signal), "divisions.json");
  if (!record(manifest) || !record(manifest.divisions)) throw new Error("divisions.json must contain a divisions object");
  const license = await requiredFile(root, "LICENSE", signal);
  if (!text(license)) throw new Error("LICENSE is empty");
  const notice = license.split(/\r\n|\n|\r/).map(line => `# ${line}`).join("\n");
  const byId = new Map<string, AgencyAgent>();
  const skipped: string[] = [];

  async function visit(directory: string, division: string) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      signal?.throwIfAborted();
      const sourcePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(sourcePath, division);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const source = await readFile(join(root, sourcePath), { encoding: "utf8", signal });
      if (!/^---(?:\r?\n|$)/.test(source)) continue;
      const header = /^---\r?\n(?:[^\n]*\n)*?---(?:\r?\n|$)/.exec(source)?.[0];
      const stem = basename(entry.name, ".md");
      if (!header || !kebab.test(stem)) {
        skipped.push(sourcePath);
        continue;
      }
      let fields: Record<string, unknown>;
      try {
        fields = parseFrontmatter(header, { level: "fatal", location: sourcePath }).frontmatter;
      } catch {
        skipped.push(sourcePath);
        continue;
      }
      const body = source.slice(header.length);
      const { name, description } = fields;
      if (!text(name) || !text(description) || !text(body)) {
        skipped.push(sourcePath);
        continue;
      }
      const id = `agency-${stem}`;
      const previous = byId.get(id);
      if (previous) throw new Error(`Duplicate agent ID ${id} — ${previous.sourcePath} and ${sourcePath}`);
      const markdown = `---\n${notice}\n${agentFrontmatterFields(id, description)}${body}`;
      byId.set(id, { id, name, description, division, sourcePath, markdown });
    }
  }

  for (const [directory, metadata] of Object.entries(manifest.divisions)) {
    signal?.throwIfAborted();
    if (!kebab.test(directory) || !record(metadata) || !text(metadata.label)) {
      throw new Error(`Invalid division in divisions.json — ${directory}`);
    }
    const stat = await lstat(join(root, directory));
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) throw new Error(`Invalid division directory — ${directory}`);
    await visit(directory, metadata.label);
  }
  signal?.throwIfAborted();
  skipped.sort();
  if (!byId.size) throw new Error(`No valid agents found${skipped.length ? ` — skipped ${skipped.length}, first: ${skipped[0]}` : ""}`);
  const agents = [...byId.values()].sort((a, b) => a.division.localeCompare(b.division) ||
    a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath));
  const runbooks = await readRunbooks(root, byId, signal);
  signal?.throwIfAborted();
  return { agents, skipped, runbooks };
}
