import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgencyAgent } from "../src/catalog";
import { installAgents } from "../src/install";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; dir: string }> {
	const root = await mkdtemp(join(tmpdir(), "omp-agency-install-"));
	roots.push(root);
	return { root, dir: join(root, "agents") };
}

function agent(id: string, markdown = `---\nname: ${JSON.stringify(id)}\n---\n# Prompt\n`): AgencyAgent {
	return {
		id,
		name: id.replace(/^agency-/, "").replace(/-/g, " "),
		description: `Descrizione per ${id}`,
		division: "Engineering",
		sourcePath: join("engineering", `${id.replace(/^agency-/, "")}.md`),
		markdown,
	};
}

const content = (dir: string, id: string) => readFile(join(dir, `${id}.md`), "utf8");
const list = (dir: string) => readdir(dir);

describe("installAgents", () => {
	test("installa solo gli ID scelti e omette il terzo", async () => {
		const { dir } = await workspace();
		const chosen = [agent("agency-alpha"), agent("agency-beta", "---\nname: \"agency-beta\"\n---\n# Beta\r\n")];
		const omitted = agent("agency-gamma");

		const result = await installAgents(dir, chosen);

		expect(result.installed.sort()).toEqual(["agency-alpha", "agency-beta"]);
		expect(result.unchanged).toEqual([]);
		expect(result.conflicts).toEqual([]);
		expect(result.failed).toEqual([]);
		expect((await list(dir)).sort()).toEqual(["agency-alpha.md", "agency-beta.md"]);
		expect(await content(dir, "agency-alpha")).toBe(chosen[0].markdown);
		expect(await content(dir, "agency-beta")).toBe(chosen[1].markdown);
		await expect(readFile(join(dir, `${omitted.id}.md`))).rejects.toThrow();
	});

	test("la seconda esecuzione non riscrive e riporta unchanged", async () => {
		const { dir } = await workspace();
		const agents = [agent("agency-alpha"), agent("agency-beta")];

		const first = await installAgents(dir, agents);
		const second = await installAgents(dir, agents);

		expect(first.installed.sort()).toEqual(["agency-alpha", "agency-beta"]);
		expect(second.installed).toEqual([]);
		expect(second.unchanged.sort()).toEqual(["agency-alpha", "agency-beta"]);
		expect(second.conflicts).toEqual([]);
		expect(second.failed).toEqual([]);
		expect((await list(dir)).sort()).toEqual(["agency-alpha.md", "agency-beta.md"]);
	});

	test("un file modificato è un conflitto e conserva i byte locali", async () => {
		const { dir } = await workspace();
		const agents = [agent("agency-alpha"), agent("agency-beta")];
		await installAgents(dir, agents);
		const local = "---\nname: \"agency-alpha\"\n---\n# Modificato a mano\n";
		await writeFile(join(dir, "agency-alpha.md"), local);

		const result = await installAgents(dir, agents);

		expect(result.installed).toEqual([]);
		expect(result.unchanged).toEqual(["agency-beta"]);
		expect(result.conflicts).toEqual(["agency-alpha"]);
		expect(result.failed).toEqual([]);
		expect(await content(dir, "agency-alpha")).toBe(local);
		expect(await content(dir, "agency-beta")).toBe(agents[1].markdown);
		expect((await list(dir)).sort()).toEqual(["agency-alpha.md", "agency-beta.md"]);
	});

	test("directory o symlink sulla destinazione sono conflitti conservati", async () => {
		const { dir } = await workspace();
		const target = join(dir, "..", "target.md");
		const directoryId = "agency-directory";
		const symlinkId = "agency-symlink";
		await mkdir(dir, { recursive: true });
		await mkdir(join(dir, `${directoryId}.md`));
		await writeFile(target, "contenuto esterno\n");
		await symlink(target, join(dir, `${symlinkId}.md`));

		const result = await installAgents(dir, [agent(directoryId), agent(symlinkId)]);

		expect(result.installed).toEqual([]);
		expect(result.unchanged).toEqual([]);
		expect(result.conflicts.sort()).toEqual([directoryId, symlinkId]);
		expect(result.failed).toEqual([]);
		expect((await readdir(join(dir, `${directoryId}.md`))).length).toBe(0);
		expect(await content(dir, symlinkId)).toBe("contenuto esterno\n");
		expect((await list(dir)).sort()).toEqual(["agency-directory.md", "agency-symlink.md"]);
	});

	test("installazioni concorrenti dello stesso ID producono una sola creazione", async () => {
		const { dir } = await workspace();
		const only = agent("agency-race", "---\nname: \"agency-race\"\n---\n# Race\n");

		const [first, second] = await Promise.all([installAgents(dir, [only]), installAgents(dir, [only])]);

		const installed = [...first.installed, ...second.installed];
		const unchanged = [...first.unchanged, ...second.unchanged];
		expect(installed).toEqual(["agency-race"]);
		expect(unchanged).toEqual(["agency-race"]);
		expect(first.conflicts).toEqual([]);
		expect(second.conflicts).toEqual([]);
		expect(await content(dir, "agency-race")).toBe(only.markdown);
		expect(await list(dir)).toEqual(["agency-race.md"]);
	});

	test("un errore per ID non interrompe gli altri agenti", async () => {
		const { dir } = await workspace();
		const tooLong = `agency-${"a".repeat(300)}`;
		const bad = agent(tooLong);
		const good = agent("agency-good");

		const result = await installAgents(dir, [bad, good]);

		expect(result.installed).toEqual(["agency-good"]);
		expect(result.unchanged).toEqual([]);
		expect(result.conflicts).toEqual([]);
		expect(result.failed.map(entry => entry.id)).toEqual([tooLong]);
		expect(typeof result.failed[0].cause).toBe("string");
		expect(result.failed[0].cause.length).toBeGreaterThan(0);
		expect(await content(dir, "agency-good")).toBe(good.markdown);
		expect(await list(dir)).toEqual(["agency-good.md"]);
		await expect(readFile(join(dir, `${tooLong}.md`))).rejects.toThrow();
	});

	test("una directory di destinazione non creabile fa fallire l'intera installazione", async () => {
		const { root, dir } = await workspace();
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "blocked"), "non una directory\n");

		await expect(installAgents(join(root, "blocked", "agents"), [agent("agency-alpha")])).rejects.toThrow();
		expect(await readFile(join(root, "blocked"), "utf8")).toBe("non una directory\n");
		expect(await readdir(root)).toEqual(["blocked"]);
		expect(await readdir(dir).catch(() => [])).toEqual([]);
	});
});
