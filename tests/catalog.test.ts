import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { readCatalog } from "../src/catalog";

const LICENSE = [
	"MIT License",
	"",
	"Copyright (c) 2025 AgentLand Contributors",
	"",
	"Permission is hereby granted, free of charge, to any person obtaining a copy",
	'of this software and associated documentation files (the "Software"), to deal',
	"in the Software without restriction.",
].join("\n");

function notice(): string {
	return LICENSE.split("\n").map(line => `# ${line}`).join("\n");
}

function agentSource(name: string, description: string, body = "# Prompt\n\nFollow the instructions.\n"): string {
	return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\ncolor: cyan\nemoji: "🧭"\nvibe: focused\n---\n${body}`;
}

interface FixtureOptions {
	/** Raw JSON text, JSON-serializable value, or null to omit divisions.json. */
	manifest?: unknown;
	/** License text, or null to omit LICENSE. */
	license?: string | null;
	files?: Record<string, string>;
	links?: Record<string, string>;
}

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function put(root: string, path: string, content: string): Promise<void> {
	const file = join(root, path);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, content);
}

async function makeRoot(options: FixtureOptions = {}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "omp-agency-catalog-"));
	roots.push(root);
	const manifest = options.manifest === undefined
		? { divisions: { alpha: { label: "Alpha" } } }
		: options.manifest;
	const license = options.license === undefined ? LICENSE : options.license;
	if (manifest !== null) {
		await put(root, "divisions.json", typeof manifest === "string" ? manifest : JSON.stringify(manifest));
	}
	if (license !== null) await put(root, "LICENSE", license);
	for (const [path, content] of Object.entries(options.files ?? {})) await put(root, path, content);
	for (const [path, target] of Object.entries(options.links ?? {})) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await symlink(target, join(root, path));
	}
	return root;
}

describe("readCatalog", () => {
	test("reads divisions recursively and filters and sorts agents", async () => {
		const root = await makeRoot({
			manifest: {
				divisions: {
					alpha: { label: "Alpha" },
					beta: { label: "Beta" },
					linked: { label: "Linked" },
				},
			},
			files: {
				"alpha/zebra.md": agentSource("Zebra Agent", "Zebra description"),
				"beta/aardvark.md": agentSource("Aardvark Agent", "Aardvark description"),
				"alpha/godot/godot-gameplay-scripter.md": agentSource(
					"Godot Gameplay Scripter",
					"Writes gameplay scripts in Godot",
				),
				"notes/outside.md": agentSource("Outside Division", "Excluded from the catalog"),
				"alpha/no-header.md": "# Plain text\n",
				"alpha/UPPER.MD": agentSource("Uppercase", "Invalid extension"),
				"alpha/Bad_Stem.md": agentSource("Invalid stem", "Underscore"),
				"alpha/bad-yaml.md": '---\nname: [unterminated\ndescription: "D"\n---\nBody\n',
				"alpha/empty-body.md": '---\nname: "Empty"\ndescription: "Empty body"\n---\n',
				"alpha/non-string.md": '---\nname: "Number"\ndescription: 42\n---\nBody\n',
				"target-div/hidden.md": agentSource("Hidden", "Undeclared division"),
			},
			links: {
				"alpha/alias.md": "zebra.md",
				linked: "target-div",
			},
		});

		const { agents, skipped } = await readCatalog(root);
		expect(agents.map(agent => agent.id)).toEqual([
			"agency-godot-gameplay-scripter",
			"agency-zebra",
			"agency-aardvark",
		]);
		const nested = agents[0];
		expect(nested.name).toBe("Godot Gameplay Scripter");
		expect(nested.division).toBe("Alpha");
		expect(nested.sourcePath).toBe(join("alpha", "godot", "godot-gameplay-scripter.md"));
		expect(agents[1]).toMatchObject({ name: "Zebra Agent", division: "Alpha" });
		expect(agents[2]).toMatchObject({ name: "Aardvark Agent", division: "Beta" });
		for (const agent of agents) {
			expect(agent.markdown).toContain("# Copyright (c) 2025 AgentLand Contributors");
			expect(agent.markdown).toContain("# Prompt\n\nFollow the instructions.\n");
		}
		expect(skipped).toEqual([
			join("alpha", "Bad_Stem.md"),
			join("alpha", "bad-yaml.md"),
			join("alpha", "empty-body.md"),
			join("alpha", "non-string.md"),
		]);
	});

	test("converts the header and preserves the CRLF body and HTML comment", async () => {
		const id = "agency-crlf";
		const description = 'Handles "quotes" and a ratio: 1:1';
		const body = "# Prompt\r\n\r\n<!-- preserve this HTML comment -->\r\nLast line\r\n";
		const source = `---\r\nname: "CRLF Agent"\r\ndescription: ${JSON.stringify(description)}\r\ncolor: red\r\n---\r\n${body}`;
		const root = await makeRoot({ files: { "alpha/crlf.md": source } });

		const { agents, skipped } = await readCatalog(root);
		expect(skipped).toEqual([]);
		expect(agents).toHaveLength(1);
		const [agent] = agents;
		expect(agent).toMatchObject({ id, name: "CRLF Agent", description, division: "Alpha" });
		expect(agent.sourcePath).toBe(join("alpha", "crlf.md"));

		const expectedHeader = `---\n${notice()}\nname: ${JSON.stringify(id)}\ndescription: ${JSON.stringify(description)}\n---\n`;
		expect(agent.markdown).toBe(expectedHeader + body);
		expect(agent.markdown.endsWith(body)).toBe(true);

		const header = agent.markdown.slice(0, agent.markdown.length - body.length);
		expect(header).not.toContain("\r");
		expect(header).toContain("# Copyright (c) 2025 AgentLand Contributors");
		expect(body).toContain("<!-- preserve this HTML comment -->");
		const parsed = parseFrontmatter(header);
		expect(parsed.frontmatter.name).toBe(id);
		expect(parsed.frontmatter.description).toBe(description);
	});

	test("reports both paths for duplicate IDs", async () => {
		const root = await makeRoot({
			manifest: { divisions: { alpha: { label: "Alpha" } } },
			files: {
				"alpha/dup.md": agentSource("Duplicate One", "First"),
				"alpha/nested/dup.md": agentSource("Duplicate Two", "Second"),
			},
		});

		const error = await readCatalog(root).then(
			() => undefined,
			caught => caught as Error,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("agency-dup");
		expect(error?.message).toContain(join("alpha", "dup.md"));
		expect(error?.message).toContain(join("alpha", "nested", "dup.md"));
	});

	test("reports the skipped count and first path when no agents are valid", async () => {
		const root = await makeRoot({
			manifest: { divisions: { alpha: { label: "Alpha" } } },
			files: {
				"alpha/a-bad-stem_.md": agentSource("Stem", "Invalid"),
				"alpha/bad-yaml.md": "---\nname: [unterminated\n---\nBody\n",
			},
		});

		const error = await readCatalog(root).then(
			() => undefined,
			caught => caught as Error,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("No valid agents found");
		expect(error?.message).toContain("skipped 2");
		expect(error?.message).toContain(join("alpha", "a-bad-stem_.md"));
	});

	test("honors an already aborted signal", async () => {
		const root = await makeRoot();
		await expect(readCatalog(root, AbortSignal.abort())).rejects.toThrow();
	});
});

describe("required files and manifest", () => {
	test("requires divisions.json", async () => {
		const root = await makeRoot({ manifest: null });
		await expect(readCatalog(root)).rejects.toThrow(/ENOENT/);
	});

	test("requires LICENSE", async () => {
		const root = await makeRoot({ license: null });
		await expect(readCatalog(root)).rejects.toThrow(/ENOENT/);
	});

	test("rejects an empty LICENSE", async () => {
		const root = await makeRoot({ license: "" });
		await expect(readCatalog(root)).rejects.toThrow(/LICENSE is empty/);
	});

	test("rejects malformed JSON in divisions.json", async () => {
		const root = await makeRoot({ manifest: "{not-json" });
		await expect(readCatalog(root)).rejects.toThrow(/Invalid divisions\.json/);
	});

	test("rejects a manifest without divisions", async () => {
		const root = await makeRoot({ manifest: { foo: 1 } });
		await expect(readCatalog(root)).rejects.toThrow(/must contain a divisions object/);
	});

	test("requires divisions.json and LICENSE to be regular files", async () => {
		const directoryRoot = await makeRoot({ manifest: null });
		await mkdir(join(directoryRoot, "divisions.json"));
		await expect(readCatalog(directoryRoot)).rejects.toThrow(/divisions\.json must be a regular file/);

		const symlinkRoot = await makeRoot({ license: null, files: { "real-license": LICENSE } });
		await symlink("real-license", join(symlinkRoot, "LICENSE"));
		await expect(readCatalog(symlinkRoot)).rejects.toThrow(/LICENSE must be a regular file/);
	});

	test("rejects invalid division keys and empty labels", async () => {
		const badKey = await makeRoot({ manifest: { divisions: { "Bad Key": { label: "X" } } } });
		await expect(readCatalog(badKey)).rejects.toThrow(/Invalid division/);

		const emptyLabel = await makeRoot({ manifest: { divisions: { alpha: { label: "" } } } });
		await expect(readCatalog(emptyLabel)).rejects.toThrow(/Invalid division/);
	});

	test("rejects a missing division directory", async () => {
		const root = await makeRoot({
			manifest: { divisions: { gamma: { label: "Gamma" } } },
			files: { "alpha/zebra.md": agentSource("Zebra Agent", "Zebra description") },
		});
		await expect(readCatalog(root)).rejects.toThrow(/ENOENT/);
	});
});

describe("strategy/runbooks.json", () => {
	const agentFiles = { "alpha/nested/lead.md": agentSource("Display Name", "Leads the team") };
	const scenario = { slug: "launch", title: "Launch", roster: [{ group: "Core Team", agents: ["lead"] }] };

	test("resolves only catalog stems, retaining ordered memberships in each named team", async () => {
		const root = await makeRoot({ files: {
			...agentFiles,
			"alpha/designer.md": agentSource("Artist", "Designs"),
			"strategy/runbooks/outsider.md": agentSource("Outsider", "Not a division agent"),
			"strategy/runbooks.json": JSON.stringify({ runbooks: [
				{ ...scenario, doc: "strategy/runbooks/outsider.md", roster: [
					{ group: "Core Team", agents: ["lead", "missing", "lead"] },
					{ group: "Design", agents: ["designer", "lead"] },
					{ group: "Core Team", agents: ["designer"] },
					{ group: "Unavailable", agents: ["outsider"] },
				] },
				{ ...scenario, slug: "unavailable", roster: [{ group: "Absent", agents: ["outsider"] }] },
			] }),
		} });
		const { agents, runbooks } = await readCatalog(root);
		expect(agents.map(agent => agent.id)).toEqual(["agency-designer", "agency-lead"]);
		expect(runbooks).toEqual([{ slug: "launch", title: "Launch", roster: [
			{ group: "Core Team", agents: ["agency-lead", "agency-designer"] },
			{ group: "Design", agents: ["agency-designer", "agency-lead"] },
		] }]);
	});

	test("permits a missing strategy directory or manifest", async () => {
		const root = await makeRoot({ files: agentFiles });
		expect((await readCatalog(root)).runbooks).toEqual([]);
		await mkdir(join(root, "strategy"));
		expect((await readCatalog(root)).runbooks).toEqual([]);
	});

	test("ignores links to both the strategy directory and the manifest", async () => {
		const files = { ...agentFiles, "elsewhere/runbooks.json": JSON.stringify({ runbooks: [scenario] }) };
		const linkedDir = await makeRoot({ files, links: { strategy: "elsewhere" } });
		const linkedFile = await makeRoot({ files, links: { "strategy/runbooks.json": "../elsewhere/runbooks.json" } });
		expect((await readCatalog(linkedDir)).runbooks).toEqual([]);
		expect((await readCatalog(linkedFile)).runbooks).toEqual([]);
	});

	test("identifies malformed JSON, scenario fields and team fields in the manifest", async () => {
		const root = await makeRoot({ files: agentFiles });
		const cases: [string, RegExp][] = [
			["{", /Invalid strategy\/runbooks\.json/],
			["{}", /runbooks\.json must contain a runbooks array/],
			[JSON.stringify({ runbooks: [null] }), /runbooks\[0\].*slug/],
			[JSON.stringify({ runbooks: [{ ...scenario, title: " " }] }), /runbooks\[0\].*title/],
			[JSON.stringify({ runbooks: [{ ...scenario, roster: {} }] }), /runbooks\[0\].*roster array/],
			[JSON.stringify({ runbooks: [{ ...scenario, roster: [{}] }] }), /roster\[0\].*group name/],
			[JSON.stringify({ runbooks: [{ ...scenario, roster: [{ group: "Core" }] }] }), /roster\[0\].*agents array/],
			[JSON.stringify({ runbooks: [{ ...scenario, roster: [{ group: "Core", agents: [1] }] }] }), /roster\[0\].agents.*stems/],
			[JSON.stringify({ runbooks: [scenario, scenario] }), /runbooks\[1\].*slug launch/],
		];
		for (const [json, message] of cases) {
			await put(root, "strategy/runbooks.json", json);
			await expect(readCatalog(root)).rejects.toThrow(message);
		}
	});
});
