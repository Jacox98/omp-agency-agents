import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CancellableLoader } from "@oh-my-pi/pi-tui";
import { getCachedCatalog } from "./cache";
import { type Catalog, readCatalog } from "./catalog";
import { singleLine } from "./text";

export function loadCatalog(
  pi: ExtensionAPI,
  ui: ExtensionContext["ui"],
  cacheDir: string,
  refresh = false,
): Promise<Catalog | undefined> {
  return ui.custom<Catalog | undefined>((tui, theme, _keys, done) => {
    const loader = new CancellableLoader(tui, s => theme.fg("accent", s), s => theme.fg("muted", s),
      refresh ? "Refreshing catalog from GitHub… Press Esc to cancel" : "Opening catalog… Press Esc to cancel");
    const { signal } = loader;
    async function download() {
      const tmp = await mkdtemp(join(tmpdir(), "omp-agency-"));
      try {
        signal.throwIfAborted();
        const result = await pi.exec("git", ["clone", "--depth=1", "--single-branch", "--branch", "main", "--quiet",
          "https://github.com/msitarzewski/agency-agents.git", "upstream"], { cwd: tmp, signal });
        signal.throwIfAborted();
        if (result.code !== 0 || result.killed) {
          throw new Error(result.stderr.trim() || `git clone exited with code ${result.code}`);
        }
        return await readCatalog(join(tmp, "upstream"), signal);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    void getCachedCatalog(cacheDir, refresh, signal, download).then(value => done(signal.aborted ? undefined : value), error => {
      if (!signal.aborted) ui.notify(`Could not ${refresh ? "refresh" : "open"} the catalog — ${singleLine(String(error))}`, "error");
      done(undefined);
    });
    return loader;
  });
}
