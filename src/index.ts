import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { getProjectAgentDir } from "@oh-my-pi/pi-utils";
import { installAgents } from "./install";
import { loadCatalog } from "./load";
import { createPicker } from "./picker";
import { singleLine } from "./text";
import { pluginUpdateMessage } from "./update";

async function installedIds(dir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) ids.add(entry.name.slice(0, -3));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return ids;
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("agency-agents", {
    description: "Browse and install Agency Agents",
    async handler(_args, ctx) {
      if (!ctx.hasUI) return;
      const project = resolve(join(getProjectAgentDir(ctx.cwd), "agents"));
      const global = resolve(join(getAgentDir(), "agents"));
      const cacheDir = join(getAgentDir(), "cache", "agency-agents");
      const refresh = "Refresh catalog from GitHub";
      const updates = "Check for plugin updates";
      const options = [`Current project — ${singleLine(project)}`, `Global user — ${singleLine(global)}`, refresh, updates];
      let choice: string | undefined;
      do {
        choice = await ctx.ui.select("Agency Agents — choose a destination or an action", options);
        if (!choice) return;
        if (choice === updates) {
          try {
            ctx.ui.notify(await pluginUpdateMessage(), "info");
          } catch (error) {
            ctx.ui.notify(`Could not check for plugin updates — ${singleLine(String(error))}`, "warning");
          }
        }
        if (choice === refresh && await loadCatalog(pi, ctx.ui, cacheDir, true)) {
          ctx.ui.notify("Local catalog updated from GitHub.", "info");
        }
      } while (choice === refresh || choice === updates);
      const destination = choice === options[0] ? "project" : "global";
      const dir = destination === "project" ? project : global;
      const catalog = await loadCatalog(pi, ctx.ui, cacheDir);
      if (!catalog) return;
      if (catalog.skipped.length) {
        ctx.ui.notify(`Skipped ${catalog.skipped.length} files. First skipped path: ${singleLine(catalog.skipped[0])}`, "warning");
      }
      let installed: Set<string>;
      try {
        installed = await installedIds(dir);
      } catch (error) {
        ctx.ui.notify(`Could not read ${singleLine(dir)} — ${singleLine(String(error))}`, "error");
        return;
      }
      const otherDir = destination === "project" ? global : project;
      const otherInstalled = await installedIds(otherDir).catch(error => {
        ctx.ui.notify(`Could not check installations in ${singleLine(otherDir)} — ${singleLine(String(error))}`, "warning");
        return new Set<string>();
      });
      const ids = await ctx.ui.custom<string[] | undefined>(
        (tui, _theme, _keys, done) => createPicker(catalog.agents, dir, () => tui.requestRender(), done,
          () => tui.terminal.rows, installed, { destination, otherInstalled }, catalog.runbooks),
        { overlay: true, overlayOptions: { fullscreen: true, width: "100%", maxHeight: "100%", margin: 0, mouseTracking: false } },
      );
      if (!ids) return;
      const selected = new Set(ids);
      try {
        const result = await installAgents(dir, catalog.agents.filter(agent => selected.has(agent.id)));
        const lines = [
          `Destination — ${singleLine(dir)}`,
          `Installed: ${result.installed.length} · Already installed: ${result.unchanged.length} · Conflicts: ${result.conflicts.length} · Errors: ${result.failed.length}`,
        ];
        if (result.conflicts.length) lines.push(`Existing files preserved: ${result.conflicts.join(", ")}`);
        for (const { id, cause } of result.failed) lines.push(`${id} — ${singleLine(cause)}`);
        if (result.installed.length) lines.push("Open /agents to view installed agents. Restart omp if this session still shows the previous roster.");
        ctx.ui.notify(lines.join("\n"), result.failed.length || result.conflicts.length ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(`Could not create ${singleLine(dir)} — ${singleLine(String(error))}`, "error");
      }
    },
  });
}
