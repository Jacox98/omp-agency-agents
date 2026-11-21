import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCachedCatalog } from "../src/cache";
import type { AgencyAgent, Catalog } from "../src/catalog";

function agent(stem: string, prompt: string): AgencyAgent {
	const id = `agency-${stem}`;
	const description = `Descrizione di ${stem}`;
	return {
		id,
		name: stem,
		description,
		division: "Engineering",
		sourcePath: `engineering/${stem}.md`,
		markdown: `---\n# MIT License\nname: "${id}"\ndescription: "${description}"\n---\n${prompt}\n`,
	};
}

const original: Catalog = {
	agents: [agent("alpha", "Primo prompt"), agent("beta", "Secondo prompt")],
	skipped: ["engineering/incomplete.md"],
};
const updated: Catalog = { agents: [agent("alpha", "Prompt aggiornato")], skipped: [] };
const signal = new AbortController().signal;

let root: string;
let cacheDir: string;
let snapshot: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-agency-cache-"));
	cacheDir = join(root, "cache");
	snapshot = join(cacheDir, "catalog-v1.json");
});

afterEach(() => rm(root, { recursive: true, force: true }));

async function expectOfflineCatalog(expected: Catalog) {
	const offline = mock(async () => { throw new Error("Git non disponibile"); });
	expect(await getCachedCatalog(cacheDir, false, signal, offline)).toEqual(expected);
	expect(offline).toHaveBeenCalledTimes(0);
}

describe("getCachedCatalog", () => {
	test("scarica al primo avvio e riusa il catalogo su disco senza Git", async () => {
		const download = mock(async () => original);
		expect(await getCachedCatalog(cacheDir, false, signal, download)).toEqual(original);
		expect(download).toHaveBeenCalledTimes(1);
		expect((await readFile(snapshot)).length).toBeGreaterThan(0);
		await expectOfflineCatalog(original);
	});

	test("il refresh sostituisce il prompt e rimuove gli agenti ritirati", async () => {
		await getCachedCatalog(cacheDir, false, signal, async () => original);
		const download = mock(async () => updated);
		expect(await getCachedCatalog(cacheDir, true, signal, download)).toEqual(updated);
		expect(download).toHaveBeenCalledTimes(1);
		await expectOfflineCatalog(updated);
	});

	test("un errore di download lascia disponibile il catalogo precedente", async () => {
		await getCachedCatalog(cacheDir, false, signal, async () => original);
		await expect(getCachedCatalog(cacheDir, true, signal, async () => {
			throw new Error("Download interrotto");
		})).rejects.toThrow();
		await expectOfflineCatalog(original);
	});

	test("annullare il refresh scarta anche un download che restituisce dati", async () => {
		await getCachedCatalog(cacheDir, false, signal, async () => original);
		const controller = new AbortController();
		await expect(getCachedCatalog(cacheDir, true, controller.signal, async () => {
			controller.abort();
			return updated;
		})).rejects.toThrow();
		await expectOfflineCatalog(original);
	});

	test("recovers a valid JSON snapshot when the prompt belongs to a different agent", async () => {
		await getCachedCatalog(cacheDir, false, signal, async () => original);
		const mismatched = { ...original.agents[0], markdown: original.agents[1].markdown };
		await writeFile(snapshot, JSON.stringify({ version: 1, catalog: { agents: [mismatched], skipped: [] } }));

		const download = mock(async () => updated);
		expect(await getCachedCatalog(cacheDir, false, signal, download)).toEqual(updated);
		expect(download).toHaveBeenCalledTimes(1);
		await expectOfflineCatalog(updated);
	});

	test.each(["JSON troncato", "agente non valido"])("ripristina la cache con %s", async problema => {
		await getCachedCatalog(cacheDir, false, signal, async () => original);
		const saved = await readFile(snapshot, "utf8");
		const corrupt = problema === "JSON troncato" ? "{" : JSON.stringify(JSON.parse(saved), (key, value) =>
			key === "id" ? null : value);
		await writeFile(snapshot, corrupt);

		const download = mock(async () => updated);
		expect(await getCachedCatalog(cacheDir, false, signal, download)).toEqual(updated);
		expect(download).toHaveBeenCalledTimes(1);
		await expectOfflineCatalog(updated);
	});
});
