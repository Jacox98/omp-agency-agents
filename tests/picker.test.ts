import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgencyAgent, Runbook } from "../src/catalog";
import { createPicker } from "../src/picker";

const ENTER = "\r";
const TAB = "\t";
const ESCAPE = "\x1b";
const CTRL_A = "\x01";
const BACKSPACE = "\x7f";
const F2 = "\x1bOQ";
const F3 = "\x1bOR";
const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";

const FRONTEND = "agency-engineering-frontend-developer";
const GODOT = "agency-godot-gameplay-scripter";
const CURATOR = "agency-whimsy-curator";

const AGENTS: readonly AgencyAgent[] = [
	{
		id: FRONTEND,
		name: "Frontend Developer",
		description: "Builds the web interface",
		division: "Engineering",
		sourcePath: "engineering/engineering-frontend-developer.md",
		markdown: [
			"---", "# internal-license-marker", `name: ${FRONTEND}`, "---", "\x1b[2JPrompt\x00 opening",
			...Array.from({ length: 80 }, (_, i) => `Prompt line ${i + 1}`), "Prompt ending",
		].join("\r\n"),
	},
	{
		id: GODOT,
		name: "Godot Gameplay Scripter",
		description: "Scripts Godot gameplay",
		division: "Game Development",
		sourcePath: "game-development/godot/godot-gameplay-scripter.md",
		markdown: "",
	},
	{
		id: CURATOR,
		name: "Whimsy Curator",
		description: "Curates playful visuals",
		division: "Design",
		sourcePath: "design/whimsy-curator.md",
		markdown: "",
	},
];

const GAME_DESIGNER = "agency-game-designer";
const UNITY = "agency-unity-architect";
const GAME_AGENTS: readonly AgencyAgent[] = [
	...AGENTS,
	{ id: GAME_DESIGNER, name: "Game Designer", description: "Designs games", division: "Game Development", sourcePath: "game-development/game-designer.md", markdown: "" },
	{ id: UNITY, name: "Unity Architect", description: "Builds Unity games", division: "Game Development", sourcePath: "game-development/unity/unity-architect.md", markdown: "" },
];

const RUNBOOKS: Runbook[] = [{
	slug: "launch", title: "Product Launch",
	roster: [
		{ group: "Launch Team", agents: [FRONTEND, GODOT] },
		{ group: "Design Team", agents: [CURATOR, FRONTEND] },
	],
}];

test("installed agents stay visible and previewable while bulk selection skips them", () => {
	let submitted: string[] | undefined;
	const picker = createPicker(AGENTS, "/project", () => {}, ids => { submitted = ids; }, () => 24, new Set([FRONTEND]));
	const screen = picker.render(120).join("\n");
	expect(screen).toContain("[Installed] Frontend Developer");
	expect(screen).toContain("Prompt line 1");
	picker.handleInput(TAB);
	expect(picker.render(120).join("\n")).toContain("Selected: 0");
	picker.handleInput(CTRL_A);
	picker.handleInput(ENTER);
	expect(submitted).toEqual([GODOT, CURATOR]);
});

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** A destination that does not exist yet, inside a temporary directory removed after the test. */
async function makeTarget(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "omp-agency-picker-"));
	roots.push(root);
	return join(root, "agents");
}

function setup(
	dir: string, agents: readonly AgencyAgent[] = AGENTS, getRows?: () => number,
	installed?: ReadonlySet<string>, scope?: Parameters<typeof createPicker>[6],
	runbooks?: readonly Runbook[],
) {
	let calls = 0;
	let ids: string[] | undefined;
	let renders = 0;
	const picker = createPicker(agents, dir, () => { renders++; }, value => {
		calls++;
		ids = value;
	}, getRows, installed, scope, runbooks);
	const done = () => ({ calls, ids });
	const type = (text: string) => {
		for (const char of text) picker.handleInput(char);
	};
	const chooseGroup = (label: string) => {
		picker.handleInput(F2);
		type(label);
		picker.handleInput(ENTER);
	};
	const erase = (length: number) => {
		for (let index = 0; index < length; index++) picker.handleInput(BACKSPACE);
	};
	const screen = (width = 120) => Bun.stripANSI(picker.render(width).join("\n"));
	const checkedCount = () => {
		const match = /Selected: (\d+)/.exec(screen());
		return match ? Number(match[1]) : Number.NaN;
	};
	const markedIds = () => {
		const view = screen();
		return agents.filter(agent => view.includes(`[x] ${agent.name}`)).map(agent => agent.id);
	};
	return { picker, type, erase, chooseGroup, screen, checkedCount, markedIds, done, renders: () => renders };
}

test("can select a runbook team containing an unpaired Unicode surrogate", () => {
	const runbooks = [{ slug: "launch", title: "Product Launch", roster: [{ group: "Remote\uD800 Team", agents: [GODOT] }] }];
	const ui = setup("/agents", AGENTS, undefined, undefined, undefined, runbooks);
	ui.chooseGroup("Remote Team");
	ui.picker.handleInput(CTRL_A);
	ui.picker.handleInput(ENTER);
	expect(ui.done().ids).toEqual([GODOT]);
});

test.each(["project", "global"] as const)("shows both scopes and selects only agents missing from %s", destination => {
	const current = destination === "project" ? "Project" : "Global";
	const other = destination === "project" ? "Global" : "Project";
	const newAgent = { ...AGENTS[0], id: "agency-api-developer", name: "API Developer", sourcePath: "engineering/api-developer.md" };
	const ui = setup("/agents", [...AGENTS, newAgent], undefined, new Set([FRONTEND, CURATOR]), {
		destination, otherInstalled: new Set([GODOT, CURATOR, "agency-outside-catalog"]),
	});
	const screen = ui.screen(180);
	expect(screen).toContain(`Destination  ${current}`);
	expect(screen).toContain("/agents");
	expect(screen).toContain("Installed: 3");
	expect(screen).toContain(`[${current}] Frontend Developer`);
	expect(screen).toContain(`[ ] [${other}] Godot Gameplay Scripter`);
	expect(screen).toContain("[Project + Global] Whimsy Curator");
	expect(screen).toContain("[ ] API Developer");

	for (const [query, name] of [["whimsy", "Whimsy Curator"], ["frontend", "Frontend Developer"]]) {
		ui.type(query);
		expect(ui.screen()).toContain(name);
		ui.picker.handleInput(TAB);
		expect(ui.checkedCount()).toBe(0);
		ui.erase(query.length);
	}
	ui.type("godot");
	ui.picker.handleInput(TAB);
	expect(ui.screen(180)).toContain(`[x] [${other}] Godot Gameplay Scripter`);
	ui.picker.handleInput(TAB);
	expect(ui.checkedCount()).toBe(0);
	ui.erase("godot".length);
	ui.picker.handleInput(CTRL_A);
	expect(ui.checkedCount()).toBe(2);
	ui.picker.handleInput(CTRL_A);
	expect(ui.checkedCount()).toBe(0);
	ui.picker.handleInput(CTRL_A);
	ui.picker.handleInput(ENTER);
	expect(ui.done().ids?.sort()).toEqual([GODOT, newAgent.id].sort());
});

test("F3 finds installations across scopes and preserves the search and selections", () => {
	const ui = setup("/agents", AGENTS, undefined, new Set([FRONTEND]), {
		destination: "project", otherInstalled: new Set([GODOT]),
	});
	ui.type("whimsy");
	ui.picker.handleInput(TAB);
	ui.picker.handleInput(F3);
	expect(ui.screen()).toContain("Installed agents");
	expect(ui.screen()).toContain("No matching agents");
	ui.erase("whimsy".length);
	const installed = ui.screen(180);
	expect(installed).toContain("Frontend Developer");
	expect(installed).toContain("Godot Gameplay Scripter");
	expect(installed).not.toContain("Whimsy Curator");
	ui.picker.handleInput(CTRL_A);
	ui.picker.handleInput(F3);
	expect(ui.screen()).toContain("[x] Whimsy Curator");
	ui.picker.handleInput(ENTER);
	expect(ui.done().ids?.sort()).toEqual([GODOT, CURATOR].sort());
});

test.each([
	{ group: "Godot", ids: [GODOT] },
	{ group: "Cross-Engine Agents", ids: [GAME_DESIGNER] },
	{ group: "Game Development", ids: [GAME_DESIGNER, GODOT, UNITY] },
])("F2 then Ctrl+A selects the agents in $group", ({ group, ids }) => {
	const ui = setup("/agents", GAME_AGENTS);
	ui.chooseGroup(group);
	ui.picker.handleInput(CTRL_A);
	ui.picker.handleInput(ENTER);
	expect(ui.done().ids?.sort()).toEqual(ids.toSorted());
});

test.each([
	{ group: "Product Launch", ids: [FRONTEND, GODOT, CURATOR] },
	{ group: "Launch Team", ids: [FRONTEND, GODOT] },
])("Ctrl+A in the NEXUS $group scope retains a selection outside the roster", ({ group, ids }) => {
	const ui = setup("/agents", GAME_AGENTS, undefined, undefined, undefined, RUNBOOKS);
	ui.type("game designer");
	ui.picker.handleInput(TAB);
	ui.erase("game designer".length);
	ui.chooseGroup(group);
	ui.picker.handleInput(CTRL_A);
	ui.picker.handleInput(CTRL_A);
	expect(ui.checkedCount()).toBe(1);
	ui.picker.handleInput(CTRL_A);
	ui.picker.handleInput(ENTER);
	expect(ui.done().ids?.sort()).toEqual([GAME_DESIGNER, ...ids].sort());
});

test("F3 intersects a runbook with installations in both scopes", () => {
	const ui = setup("/agents", GAME_AGENTS, undefined, new Set([FRONTEND]), {
		destination: "project", otherInstalled: new Set([GODOT, UNITY]),
	}, RUNBOOKS);
	ui.picker.handleInput(F3);
	ui.chooseGroup("Product Launch");
	const installed = ui.screen(180);
	expect(installed).toContain("[Project] Frontend Developer");
	expect(installed).toContain("[ ] [Global] Godot Gameplay Scripter");
	expect(installed).not.toContain("Whimsy Curator");
	expect(installed).not.toContain("Unity Architect");
	ui.picker.handleInput(CTRL_A);
	ui.picker.handleInput(F3);
	expect(ui.screen(180)).toContain("[ ] Whimsy Curator");
	expect(ui.screen(180)).not.toContain("Unity Architect");
	ui.picker.handleInput(ENTER);
	expect(ui.done().ids).toEqual([GODOT]);
});

describe("createPicker", () => {
	test("spunta attraverso filtri diversi e restituisce gli ID scelti", async () => {
		const dir = await makeTarget();
		const ui = setup(dir);

		ui.type("frontend");
		expect(ui.screen()).toContain("Frontend Developer");
		expect(ui.screen()).not.toContain("Godot Gameplay Scripter");
		expect(ui.checkedCount()).toBe(0);

		ui.picker.handleInput(TAB);
		expect(ui.checkedCount()).toBe(1);
		expect(ui.renders()).toBeGreaterThan(0);

		ui.erase("frontend".length);
		expect(ui.checkedCount()).toBe(1);
		expect(ui.markedIds()).toEqual([FRONTEND]);

		ui.type("godot");
		expect(ui.screen()).not.toContain("Frontend Developer");
		ui.picker.handleInput(TAB);
		expect(ui.checkedCount()).toBe(2);

		ui.erase("godot".length);
		expect(ui.markedIds().sort()).toEqual([FRONTEND, GODOT].sort());

		ui.picker.handleInput(ENTER);
		expect(ui.done().calls).toBe(1);
		expect(ui.done().ids?.sort()).toEqual([FRONTEND, GODOT].sort());
		expect(existsSync(dir)).toBe(false);
	});

	test("Tab spunta e despunta solo il risultato evidenziato", async () => {
		const dir = await makeTarget();
		const ui = setup(dir);

		ui.type("godot");
		ui.picker.handleInput(TAB);
		expect(ui.checkedCount()).toBe(1);
		ui.picker.handleInput(TAB);
		expect(ui.checkedCount()).toBe(0);
		expect(ui.markedIds()).toEqual([]);

		ui.picker.handleInput(ENTER);
		expect(ui.done().calls).toBe(0);

		ui.erase("godot".length);
		ui.picker.handleInput("\x1b[A");
		ui.picker.handleInput(TAB);
		expect(ui.done().calls).toBe(0);
		ui.picker.handleInput(ENTER);
		expect(ui.done().calls).toBe(1);
		expect(ui.done().ids).toEqual([FRONTEND]);
	});

	test("Ctrl+A agisce solo sui risultati filtrati e conserva le spunte fuori filtro", async () => {
		const dir = await makeTarget();
		const ui = setup(dir);

		ui.type("engineering");
		ui.picker.handleInput(CTRL_A);
		expect(ui.checkedCount()).toBe(1);

		ui.erase("engineering".length);
		ui.type("game");
		ui.picker.handleInput(CTRL_A);
		expect(ui.checkedCount()).toBe(2);

		ui.erase("game".length);
		expect(ui.markedIds().sort()).toEqual([FRONTEND, GODOT].sort());

		ui.picker.handleInput(ENTER);
		expect(ui.done().ids?.sort()).toEqual([FRONTEND, GODOT].sort());
		expect(ui.done().ids).not.toContain(CURATOR);
	});

	test("Ctrl+A deseleziona i risultati filtrati già tutti spuntati", async () => {
		const dir = await makeTarget();
		const ui = setup(dir);

		ui.type("game");
		ui.picker.handleInput(CTRL_A);
		expect(ui.checkedCount()).toBe(1);
		ui.picker.handleInput(CTRL_A);
		expect(ui.checkedCount()).toBe(0);

		ui.erase("game".length);
		ui.picker.handleInput(CTRL_A);
		expect(ui.checkedCount()).toBe(AGENTS.length);
		ui.picker.handleInput(CTRL_A);
		expect(ui.checkedCount()).toBe(0);

		ui.picker.handleInput(ENTER);
		expect(ui.done().calls).toBe(0);
	});

	test("Invio installa le spunte anche quando il filtro non ha risultati", async () => {
		const dir = await makeTarget();
		const ui = setup(dir);

		ui.type("frontend");
		ui.picker.handleInput(TAB);
		expect(ui.checkedCount()).toBe(1);

		ui.erase("frontend".length);
		ui.type("zzzz");
		expect(ui.screen()).toContain("No matching agents");
		expect(ui.checkedCount()).toBe(1);

		ui.picker.handleInput(ENTER);
		expect(ui.done().calls).toBe(1);
		expect(ui.done().ids).toEqual([FRONTEND]);
		expect(existsSync(dir)).toBe(false);
	});

	test("Invio senza spunte resta nel picker e non crea la destinazione", async () => {
		const dir = await makeTarget();
		const ui = setup(dir);

		ui.type("zzzz");
		expect(ui.screen()).toContain("No matching agents");
		ui.picker.handleInput(ENTER);
		expect(ui.done().calls).toBe(0);
		expect(existsSync(dir)).toBe(false);
	});

	test("Esc dopo una spunta annulla senza installare e senza creare la directory", async () => {
		const dir = await makeTarget();
		const ui = setup(dir);

		ui.type("whimsy");
		ui.picker.handleInput(TAB);
		expect(ui.checkedCount()).toBe(1);
		expect(ui.markedIds()).toEqual([CURATOR]);

		ui.picker.handleInput(ESCAPE);
		expect(ui.done().calls).toBe(1);
		expect(ui.done().ids).toBeUndefined();
		expect(existsSync(dir)).toBe(false);
	});

	test("F2 opens the division chooser and Escape restores the active search", async () => {
		const ui = setup(await makeTarget());
		ui.type("godot");
		ui.picker.handleInput(F2);
		for (const label of ["All divisions", "Engineering", "Game Development", "Design"]) {
			expect(ui.screen()).toContain(label);
		}
		ui.type("design");
		ui.picker.handleInput(ESCAPE);
		expect(ui.done().calls).toBe(0);
		expect(ui.screen()).toContain("Godot Gameplay Scripter");
		expect(ui.screen()).not.toContain("Whimsy Curator");
		ui.picker.handleInput(TAB);
		ui.picker.handleInput(ENTER);
		expect(ui.done().ids).toEqual([GODOT]);
	});

	test("Enter applies the highlighted division and Ctrl+A only toggles matches inside it", async () => {
		const engineer = { ...AGENTS[0], id: "agency-api-developer", name: "API Developer", sourcePath: "engineering/api-developer.md" };
		const ui = setup(await makeTarget(), [...AGENTS, engineer]);
		ui.type("godot");
		ui.picker.handleInput(TAB);
		ui.erase("godot".length);

		ui.picker.handleInput(F2);
		ui.type("Engineering");
		ui.picker.handleInput(ENTER);
		expect(ui.done().calls).toBe(0);
		expect(ui.screen()).toContain("API Developer");
		expect(ui.screen()).not.toContain("Godot Gameplay Scripter");
		expect(ui.screen()).not.toContain("Whimsy Curator");
		ui.picker.handleInput(CTRL_A);
		expect(ui.checkedCount()).toBe(3);
		ui.type("frontend");
		ui.picker.handleInput(CTRL_A);
		expect(ui.checkedCount()).toBe(2);
		ui.erase("frontend".length);

		ui.picker.handleInput(F2);
		ui.type("All divisions");
		ui.picker.handleInput(ENTER);
		expect(ui.screen()).toContain("Whimsy Curator");
		expect(ui.markedIds().sort()).toEqual([engineer.id, GODOT].sort());
		ui.picker.handleInput(ENTER);
		expect(ui.done().calls).toBe(1);
		expect(ui.done().ids?.sort()).toEqual([engineer.id, GODOT].sort());
	});

	test("resizing moves the preview beside or below the list and fits the terminal", async () => {
		let rows = 24;
		const ui = setup(await makeTarget(), AGENTS, () => rows);
		const wide = ui.screen(120).split("\n");
		const agentRow = wide.find(line => line.includes("[ ] Frontend Developer"));
		const previewRow = wide.find(line => line.includes("Prompt opening"));
		expect(agentRow).toBeDefined();
		expect(previewRow).toBeDefined();
		expect(previewRow!.indexOf("Prompt opening")).toBeGreaterThan(agentRow!.indexOf("Frontend Developer") + "Frontend Developer".length);

		const narrow = ui.screen(60).split("\n");
		const lastAgent = narrow.findIndex(line => line.includes("[ ] Whimsy Curator"));
		expect(lastAgent).toBeGreaterThanOrEqual(0);
		expect(narrow.findIndex(line => line.includes("Prompt opening"))).toBeGreaterThan(lastAgent);
		for (const [width, lines] of [[120, wide], [60, narrow]] as const) {
			expect(lines).toHaveLength(rows);
			expect(lines.every(line => Bun.stringWidth(line) <= width)).toBe(true);
		}

		rows = 12;
		expect(ui.picker.render(60)).toHaveLength(rows);
	});

	test("PgDown and PgUp scroll the sanitized body of the highlighted agent", async () => {
		const ui = setup(await makeTarget());
		const raw = ui.picker.render(120).join("\n");
		expect(raw).not.toContain("\x1b[2J");
		expect(raw).not.toContain("\x00");
		expect(raw).not.toContain("internal-license-marker");
		expect(ui.screen()).toContain("Prompt opening");
		expect(ui.screen()).not.toContain("Prompt ending");
		ui.picker.handleInput(PAGE_DOWN);
		expect(ui.screen()).not.toContain("Prompt opening");
		expect(ui.screen()).toContain("Prompt line");
		ui.picker.handleInput(PAGE_UP);
		expect(ui.screen()).toContain("Prompt opening");
		for (let i = 0; i < 80; i++) ui.picker.handleInput(PAGE_DOWN);
		expect(ui.screen()).toContain("Prompt ending");
		ui.picker.handleInput(DOWN);
		expect(ui.screen()).not.toContain("Prompt ending");
		ui.picker.handleInput(TAB);
		ui.picker.handleInput(ENTER);
		expect(ui.done().ids).toEqual([GODOT]);
	});
});
