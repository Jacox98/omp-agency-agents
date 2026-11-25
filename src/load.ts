import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getCachedCatalog } from "./cache";
import { type Catalog, readCatalog } from "./catalog";
import { singleLine, truncateToWidth } from "./text";
import { mountKeyView } from "./view";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function loadCatalog(
  pi: ExtensionAPI,
  ui: ExtensionContext["ui"],
  cacheDir: string,
  refresh = false,
): Promise<Catalog | undefined> {
  return ui.custom<Catalog | undefined>((_ui, theme, keys, done) => mountKeyView(requestRender => {
    const controller = new AbortController();
    const { signal } = controller;
    const message = refresh ? "Refreshing catalog from GitHub… Press Esc to cancel" : "Opening catalog… Press Esc to cancel";
    let frame = 0;
    const timer = setInterval(() => {
      frame = (frame + 1) % SPINNER.length;
      requestRender();
    }, 80);
    const finish = (value: Catalog | undefined) => {
      clearInterval(timer);
      done(value);
    };
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
    void getCachedCatalog(cacheDir, refresh, signal, download).then(value => finish(signal.aborted ? undefined : value), error => {
      if (!signal.aborted) ui.notify(`Could not ${refresh ? "refresh" : "open"} the catalog — ${singleLine(String(error))}`, "error");
      finish(undefined);
    });
    return {
      render(width: number) {
        return [truncateToWidth(`${theme.fg("accent", SPINNER[frame]!)} ${theme.fg("muted", message)}`, width)];
      },
      handleKey(key) {
        if (!keys.matches(key, "tui.select.cancel")) return;
        controller.abort();
        finish(undefined);
      },
    };
  }));
}
