import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { loadCatalog } from "../src/load";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test.each([
	["Escape", { id: "escape", raw: "\x1b" }, {}],
	["a remapped cancel key", { id: "ctrl+g", raw: "\x07" }, { "tui.select.cancel": "ctrl+g" }],
] as const)("%s cancels the download and keeps the cache untouched", async (_name, key, bindings) => {
	const root = await mkdtemp(join(tmpdir(), "omp-agency-load-"));
	roots.push(root);
	const cacheDir = join(root, "cache");
	const cloneStarted = Promise.withResolvers<AbortSignal>();
	const pi = {
		exec(_cmd: string, _args: string[], options: { signal: AbortSignal }) {
			const { promise, resolve } = Promise.withResolvers();
			options.signal.addEventListener("abort", () => resolve({ code: 1, killed: true, stdout: "", stderr: "" }));
			cloneStarted.resolve(options.signal);
			return promise;
		},
	} as unknown as ExtensionAPI;
	const notices: string[] = [];
	let node: UiNode | undefined;
	const ui = {
		notify: (message: string) => notices.push(message),
		custom(factory: Function) {
			const { promise, resolve } = Promise.withResolvers();
			const theme = { fg: (_color: string, text: string) => text };
			node = factory({ requestRender() {}, size: () => ({ columns: 80, rows: 24 }) }, theme, KeybindingsManager.inMemory(bindings), resolve);
			return promise;
		},
	} as unknown as ExtensionContext["ui"];

	const result = loadCatalog(pi, ui, cacheDir, true);
	const cloneSignal = await cloneStarted.promise;
	expect(node!.handlers.onKey!({ id: "x", kind: "press", raw: "x", text: "x" })).toBe(true);
	expect(cloneSignal.aborted).toBe(false);
	expect(node!.handlers.onKey!({ ...key, kind: "press" })).toBe(true);
	expect(await result).toBeUndefined();
	expect(cloneSignal.aborted).toBe(true);
	expect(notices).toEqual([]);
	expect(existsSync(cacheDir)).toBe(false);
});
