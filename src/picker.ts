import {
  getSelectListTheme, matchesKey, replaceTabs, ScrollView, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgencyAgent, Runbook } from "./catalog";
import { singleLine } from "./text";

function promptBody(markdown: string): string {
  const body = markdown.replace(/^---\r?\n(?:[^\n]*\n)*?---(?:\r?\n|$)/, "");
  return replaceTabs(sanitizeText(body.replace(/\r\n?/g, "\n"))).trim();
}

function renderList(list: SelectList, heading: string, width: number, height: number): string[] {
  if (height === 0) return [];
  // The native list can add a search/status line below its visible items.
  list.setMaxVisible(Math.max(1, height - 2));
  const items = list.render(width);
  const lines = [heading, ...items];
  if (height === 2 && !list.pickerView().items.length) lines[1] = items.at(-1) ?? "";
  return Array.from({ length: height }, (_, row) => truncateToWidth(lines[row] ?? "", width));
}

interface GroupItem {
  value: string;
  label: string;
  description?: string;
  searchText: string;
  members?: ReadonlySet<string>;
}

interface AgentGroup {
  key: string;
  name: string;
  members: Set<string>;
  children: Map<string, AgentGroup>;
}

function groupIn(groups: Map<string, AgentGroup>, key: string, name: string): AgentGroup {
  let group = groups.get(key);
  if (!group) {
    group = { key, name: singleLine(name), members: new Set(), children: new Map() };
    groups.set(key, group);
  }
  return group;
}

function buildGroups(agents: ReadonlyMap<string, AgencyAgent>, runbooks?: readonly Runbook[]) {
  const divisions = new Map<string, AgentGroup>();
  for (const agent of agents.values()) {
    const [root, ...rest] = agent.sourcePath.split(/[\\/]+/);
    const folders = rest.slice(0, -1);
    let group = groupIn(divisions, `division/${root}`, agent.division);
    group.members.add(agent.id);
    if (root === "game-development" && !folders.length) {
      groupIn(group.children, `${group.key}/direct`, "Cross-Engine Agents").members.add(agent.id);
    }
    for (const folder of folders) {
      const name = folder.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      group = groupIn(group.children, `${group.key}/folder/${folder}`, name);
      group.members.add(agent.id);
    }
  }

  const scenarios = new Map<string, AgentGroup>();
  for (const { slug, title, roster } of runbooks ?? []) {
    const scenario = groupIn(scenarios, JSON.stringify([slug]), title);
    for (const { group, agents: ids } of roster) {
      const team = groupIn(scenario.children, JSON.stringify([slug, group]), group);
      for (const id of ids) {
        if (!agents.has(id)) continue;
        team.members.add(id);
        scenario.members.add(id);
      }
    }
  }

  const items = new Map<string, GroupItem>();
  items.set("all", { value: "all", label: `All divisions (${agents.size})`, searchText: "All divisions" });
  function append(groups: Map<string, AgentGroup>, parents: string[]) {
    for (const group of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = [...parents, group.name];
      const breadcrumb = path.join(" › ");
      const prefix = groups === scenarios ? "NEXUS › " : parents.length ? `${"›".repeat(parents.length)} ` : "";
      items.set(group.key, {
        value: group.key, label: `${prefix}${group.name} (${group.members.size})`,
        description: groups === scenarios ? undefined : parents.join(" › "),
        searchText: breadcrumb, members: group.members,
      });
      append(group.children, path);
    }
  }
  append(divisions, []);
  append(scenarios, ["NEXUS"]);
  return items;
}

export function createPicker(
  agents: readonly AgencyAgent[], dir: string, requestRender: () => void,
  done: (ids: string[] | undefined) => void, getRows: () => number = () => 24,
  installed: ReadonlySet<string> = new Set(),
  scope?: { destination: "project" | "global"; otherInstalled: ReadonlySet<string> },
  runbooks?: readonly Runbook[],
) {
  const theme = getSelectListTheme();
  const checked = new Set<string>();
  const byId = new Map(agents.map(agent => [agent.id, agent] as const));
  const destinationScope = scope?.destination === "project" ? "Project" : "Global";
  const otherScope = destinationScope === "Project" ? "Global" : "Project";
  const choices = agents.map(agent => {
    const here = installed.has(agent.id);
    const elsewhere = scope?.otherInstalled.has(agent.id);
    let status = "";
    if (here && elsewhere) status = "Project + Global";
    else if (here) status = scope ? destinationScope : "Installed";
    else if (elsewhere) status = otherScope;
    return {
      value: agent.id,
      label: singleLine(agent.name),
      description: singleLine(`${agent.division} — ${agent.description}`),
      searchText: singleLine(`${agent.id} ${agent.sourcePath}`),
      status,
    };
  });
  const installedCount = choices.filter(item => item.status).length;
  let installedOnly = false;
  const groups = buildGroups(byId, runbooks);
  let activeGroup = groups.get("all")!;
  function markedItems() {
    return choices.filter(item => (!activeGroup.members || activeGroup.members.has(item.value)) && (!installedOnly || item.status)).map(item => {
      const checkbox = installed.has(item.value) ? "" : checked.has(item.value) ? "[x] " : "[ ] ";
      const status = item.status ? `[${item.status}] ` : "";
      return { ...item, label: `${checkbox}${status}${item.label}` };
    });
  }
  const list = new SelectList(markedItems(), 10, theme, {
    search: "always", noMatchText: "No matching agents", emptyText: "No matching agents",
    minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 40,
  });
  const groupList = new SelectList([...groups.values()], 10, theme, {
    search: "always", noMatchText: "No matching groups", minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 52,
  });
  let choosingGroup = false;
  groupList.onSelect = item => {
    activeGroup = groups.get(item.value)!;
    list.setItems(markedItems());
    choosingGroup = false;
  };
  groupList.onCancel = () => { choosingGroup = false; };

  const preview = new ScrollView([], {
    height: 0, theme: { track: theme.description, thumb: theme.selectedPrefix },
  });
  let previewAgent: AgencyAgent | undefined;
  let previewWidth = 0;
  function renderPreview(width: number, height: number): string[] {
    if (height === 0) return [];
    const agent = byId.get(list.pickerView().selected ?? "");
    preview.setHeight(height - 1);
    if (agent !== previewAgent || width !== previewWidth) {
      const body = agent ? promptBody(agent.markdown) : "";
      // Reserve one cell for the native scrollbar so wrapped lines never lose their last character.
      preview.setLines(body ? wrapTextWithAnsi(body, Math.max(1, width - 1)) : []);
      if (agent !== previewAgent) preview.scrollToTop();
      previewAgent = agent;
      previewWidth = width;
    }
    const heading = agent ? `Prompt preview · ${singleLine(agent.name)}` : "Prompt preview";
    return [truncateToWidth(theme.selectedText(heading), width), ...preview.render(width)];
  }

  const destination = theme.description(`Destination  ${scope ? `${destinationScope} · ` : ""}${singleLine(dir)}`);
  const gutter = theme.description(" │ ");
  return {
    render(width: number) {
      const rows = Math.max(0, Math.trunc(getRows()));
      if (rows === 0 || width < 1) return Array<string>(rows).fill("");
      const selectedCount = `Selected: ${checked.size}`;
      const totals = `Installed: ${installedCount} · ${selectedCount}`;
      const count = visibleWidth(totals) <= width ? totals : selectedCount;
      const title = truncateToWidth(theme.selectedText("Agency Agents"), Math.max(0, width - visibleWidth(count) - 1), "", true);
      const header = [truncateToWidth(`${title}${title ? " " : ""}${theme.selectedPrefix(count)}`, width)];
      if (rows >= 5) header.push(truncateToWidth(destination, width));
      const wide = width >= 90;
      const help = choosingGroup ? "Type to search · ↑/↓ navigate · Enter apply · Esc back"
        : `Type to search · ↑/↓ navigate · F2 groups · F3 ${installedOnly ? "all agents" : "installed"} · Tab toggle · Ctrl+A toggle matches · PgUp/PgDn preview · Enter install · Esc cancel`;
      const footer = wrapTextWithAnsi(help, width).slice(0, Math.max(0, rows - header.length - (wide || choosingGroup ? 3 : 6)));
      const refreshHint = "For NEXUS teams, choose Refresh catalog from GitHub.";
      if (choosingGroup && runbooks === undefined && rows - header.length - footer.length >= 6 && width >= visibleWidth(refreshHint)) {
        footer.push(refreshHint);
      }
      const height = rows - header.length - footer.length;
      let content: string[];
      if (choosingGroup) {
        content = renderList(groupList, theme.selectedText("Choose a division, subgroup, runbook or team"), width, height);
      } else {
        const listWidth = wide ? Math.floor((width - 3) * 0.46) : width;
        const listHeight = wide ? height : Math.ceil(height / 2);
        const heading = theme.selectedText(`${installedOnly ? "Installed agents" : "Agents"} · ${activeGroup.searchText}`);
        const items = renderList(list, heading, listWidth, listHeight);
        const prompt = renderPreview(wide ? width - listWidth - 3 : width, wide ? height : height - listHeight);
        content = wide ? items.map((line, row) => truncateToWidth(line, listWidth, "", true) + gutter + prompt[row])
          : [...items, ...prompt];
      }
      return [...header, ...content, ...footer.map(line => theme.scrollInfo(truncateToWidth(line, width)))];
    },
    invalidate() {
      list.invalidate();
      groupList.invalidate();
      preview.invalidate();
      previewWidth = 0;
    },
    handleInput(key: string) {
      if (choosingGroup) {
        const query = groupList.getFilter();
        groupList.handleInput(key);
        if (query !== groupList.getFilter()) groupList.setSelectedIndex(0);
      } else if (matchesKey(key, "f2")) {
        groupList.setFilter("");
        groupList.setSelectedValue(activeGroup.value);
        choosingGroup = true;
      } else if (matchesKey(key, "f3")) {
        installedOnly = !installedOnly;
        list.setItems(markedItems());
      } else if (matchesKey(key, "escape")) {
        return done(undefined);
      } else if (matchesKey(key, "enter")) {
        if (checked.size) done([...checked]);
        return;
      } else if (matchesKey(key, "pageUp") || matchesKey(key, "pageDown")) {
        preview.page(matchesKey(key, "pageUp") ? -1 : 1);
      } else if (matchesKey(key, "tab")) {
        const { selected } = list.pickerView();
        if (!selected || installed.has(selected)) return;
        if (checked.has(selected)) checked.delete(selected);
        else checked.add(selected);
        list.setItems(markedItems());
      } else if (matchesKey(key, "ctrl+a")) {
        const items = list.pickerView().items.filter(item => !installed.has(item.value));
        const remove = items.every(item => checked.has(item.value));
        for (const { value } of items) {
          if (remove) checked.delete(value);
          else checked.add(value);
        }
        list.setItems(markedItems());
      } else {
        list.handleInput(key);
      }
      requestRender();
    },
  };
}
