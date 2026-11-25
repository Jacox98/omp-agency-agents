import type { ExtensionTheme } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_TAB_WIDTH, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgencyAgent, Runbook } from "./catalog";
import { singleLine, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./text";
import type { KeyEvent, KeyMatcher, KeyView } from "./view";

interface PickerTheme {
  selectedPrefix(text: string): string;
  selectedText(text: string): string;
  description(text: string): string;
  scrollInfo(text: string): string;
}

function makeTheme(theme?: ExtensionTheme): PickerTheme {
  if (!theme) return { selectedPrefix: s => s, selectedText: s => s, description: s => s, scrollInfo: s => s };
  return {
    selectedPrefix: s => theme.fg("accent", s),
    selectedText: s => theme.fg("accent", s),
    description: s => theme.fg("muted", s),
    scrollInfo: s => theme.fg("dim", s),
  };
}

interface ListItem {
  value: string;
  label: string;
  description?: string;
  searchText?: string;
}

interface ListOptions {
  noMatchText: string;
  emptyText?: string;
  minPrimaryColumnWidth: number;
  maxPrimaryColumnWidth: number;
}

class FilterableList {
  private items: ListItem[];
  private filtered: ListItem[] = [];
  private filter = "";
  private selectedIndex = 0;
  private maxVisible: number;
  onSelect?: (item: ListItem) => void;
  onCancel?: () => void;

  constructor(
    items: ListItem[], maxVisible: number, private theme: PickerTheme, private keys: KeyMatcher, private options: ListOptions,
  ) {
    this.items = items;
    this.maxVisible = maxVisible;
    this.applyFilter(undefined);
  }

  private applyFilter(preserveValue: string | undefined) {
    const query = this.filter.trim().toLowerCase();
    this.filtered = !query ? this.items : this.items.filter(item =>
      `${item.label} ${item.description ?? ""} ${item.searchText ?? ""} ${item.value}`.toLowerCase().includes(query),
    );
    if (preserveValue !== undefined) {
      const idx = this.filtered.findIndex(item => item.value === preserveValue);
      if (idx >= 0) {
        this.selectedIndex = idx;
        return;
      }
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
  }

  setMaxVisible(n: number) { this.maxVisible = Math.max(1, n); }
  getFilter(): string { return this.filter; }
  setFilter(query: string) {
    const prev = this.filtered[this.selectedIndex]?.value;
    this.filter = query;
    this.applyFilter(prev);
  }
  setItems(items: ListItem[]) {
    const prev = this.filtered[this.selectedIndex]?.value;
    this.items = items;
    this.applyFilter(prev);
  }
  setSelectedIndex(index: number) {
    this.selectedIndex = Math.max(0, Math.min(index, Math.max(0, this.filtered.length - 1)));
  }
  setSelectedValue(value: string) {
    const idx = this.filtered.findIndex(item => item.value === value);
    if (idx >= 0) this.selectedIndex = idx;
  }
  pickerView() {
    return { items: this.filtered, selected: this.filtered[this.selectedIndex]?.value };
  }

  /** Append pasted or typed text to the search. */
  type(text: string) {
    if (text) this.setFilter(this.filter + text);
  }

  handleKey(key: KeyEvent) {
    if (this.keys.matches(key, "tui.select.cancel")) {
      this.onCancel?.();
    } else if (this.keys.matches(key, "tui.select.confirm")) {
      const item = this.filtered[this.selectedIndex];
      if (item) this.onSelect?.(item);
    } else if (this.keys.matches(key, "tui.select.up")) {
      if (this.filtered.length) this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
    } else if (this.keys.matches(key, "tui.select.down")) {
      if (this.filtered.length) this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
    } else if (key.id === "home") {
      this.selectedIndex = 0;
    } else if (key.id === "end") {
      this.selectedIndex = Math.max(0, this.filtered.length - 1);
    } else if (this.keys.matches(key, "tui.editor.deleteCharBackward")) {
      this.setFilter([...this.filter].slice(0, -1).join(""));
    } else if (this.keys.matches(key, "tui.editor.deleteToLineStart")) {
      this.setFilter("");
    } else if (key.text && !/[\x00-\x1f\x7f]/.test(key.text)) {
      this.type(key.text);
    }
  }

  render(width: number): string[] {
    if (!this.filtered.length) {
      const empty = this.theme.description(this.filter ? this.options.noMatchText : (this.options.emptyText ?? this.options.noMatchText));
      return this.filter ? [this.theme.scrollInfo(`Search: ${this.filter}`), empty] : [empty];
    }
    const visible = Math.min(this.maxVisible, this.filtered.length);
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visible / 2), this.filtered.length - visible));
    const maxLabel = Math.max(0, ...this.filtered.slice(start, start + visible).map(item => visibleWidth(item.label) + 2));
    const primaryWidth = Math.min(
      this.options.maxPrimaryColumnWidth,
      Math.max(this.options.minPrimaryColumnWidth, maxLabel),
    );
    const showDesc = width >= primaryWidth + 12;
    const lines: string[] = [];
    for (let i = start; i < start + visible; i++) {
      const item = this.filtered[i]!;
      const selected = i === this.selectedIndex;
      const prefix = selected ? this.theme.selectedPrefix("→ ") : "  ";
      const label = selected ? this.theme.selectedText(item.label) : item.label;
      if (item.description && showDesc) {
        const left = truncateToWidth(`${prefix}${label}`, primaryWidth, "…", true);
        const right = truncateToWidth(this.theme.description(item.description), width - primaryWidth - 2);
        lines.push(`${left}  ${right}`);
      } else {
        lines.push(truncateToWidth(`${prefix}${label}`, width));
      }
    }
    const pos = `(${this.selectedIndex + 1}/${this.filtered.length})`;
    lines.push(this.theme.scrollInfo(this.filter ? `Search: ${this.filter} ${pos}` : pos));
    return lines;
  }
}

class TextViewport {
  private lines: string[] = [];
  private height = 0;
  private offset = 0;

  constructor(private theme: { track(s: string): string; thumb(s: string): string }) {}

  setHeight(height: number) {
    this.height = Math.max(0, height);
    this.clamp();
  }
  setLines(lines: string[]) {
    this.lines = lines;
    this.clamp();
  }
  scrollToTop() { this.offset = 0; }
  page(delta: -1 | 1) {
    this.offset += delta * Math.max(1, this.height - 1);
    this.clamp();
  }

  private clamp() {
    const max = Math.max(0, this.lines.length - this.height);
    this.offset = Math.max(0, Math.min(this.offset, max));
  }

  render(width: number): string[] {
    if (this.height === 0) return [];
    const scrollable = this.lines.length > this.height && width > 1;
    const contentWidth = scrollable ? width - 1 : width;
    const maxOffset = Math.max(1, this.lines.length - this.height);
    const thumbSize = scrollable ? Math.max(1, Math.round((this.height / this.lines.length) * this.height)) : 0;
    const thumbStart = scrollable ? Math.round((this.offset / maxOffset) * (this.height - thumbSize)) : 0;
    return Array.from({ length: this.height }, (_, row) => {
      const text = truncateToWidth(this.lines[this.offset + row] ?? "", contentWidth, "…", scrollable);
      if (!scrollable) return text;
      const inThumb = row >= thumbStart && row < thumbStart + thumbSize;
      return text + (inThumb ? this.theme.thumb("┃") : this.theme.track("│"));
    });
  }
}

function promptBody(markdown: string): string {
  const body = markdown.replace(/^---\r?\n(?:[^\n]*\n)*?---(?:\r?\n|$)/, "");
  return sanitizeText(body.replace(/\r\n?/g, "\n")).replace(/\t/g, " ".repeat(DEFAULT_TAB_WIDTH)).trim();
}

function renderList(list: FilterableList, heading: string, width: number, height: number): string[] {
  if (height === 0) return [];
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

export interface PickerOptions {
  agents: readonly AgencyAgent[];
  dir: string;
  done: (ids: string[] | undefined) => void;
  keys: KeyMatcher;
  getRows?: () => number;
  installed?: ReadonlySet<string>;
  scope?: { destination: "project" | "global"; otherInstalled: ReadonlySet<string> };
  runbooks?: readonly Runbook[];
  theme?: ExtensionTheme;
}

export function createPicker({
  agents, dir, done, keys, getRows = () => 24, installed = new Set(), scope, runbooks, theme: extTheme,
}: PickerOptions): KeyView {
  const theme = makeTheme(extTheme);
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
  const list = new FilterableList(markedItems(), 10, theme, keys, {
    noMatchText: "No matching agents", emptyText: "No matching agents",
    minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 40,
  });
  const groupList = new FilterableList([...groups.values()], 10, theme, keys, {
    noMatchText: "No matching groups", minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 52,
  });
  let choosingGroup = false;
  groupList.onSelect = item => {
    activeGroup = groups.get(item.value)!;
    list.setItems(markedItems());
    choosingGroup = false;
  };
  groupList.onCancel = () => { choosingGroup = false; };

  const preview = new TextViewport({ track: theme.description, thumb: theme.selectedPrefix });
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
    handlePaste(text: string) {
      const target = choosingGroup ? groupList : list;
      target.type(singleLine(text));
      if (choosingGroup) groupList.setSelectedIndex(0);
    },
    handleKey(key: KeyEvent) {
      if (choosingGroup) {
        const query = groupList.getFilter();
        groupList.handleKey(key);
        if (query !== groupList.getFilter()) groupList.setSelectedIndex(0);
      } else if (key.id === "f2") {
        groupList.setFilter("");
        groupList.setSelectedValue(activeGroup.value);
        choosingGroup = true;
      } else if (key.id === "f3") {
        installedOnly = !installedOnly;
        list.setItems(markedItems());
      } else if (keys.matches(key, "tui.select.cancel")) {
        done(undefined);
      } else if (keys.matches(key, "tui.select.confirm")) {
        if (checked.size) done([...checked]);
      } else if (keys.matches(key, "tui.select.pageUp") || keys.matches(key, "tui.select.pageDown")) {
        preview.page(keys.matches(key, "tui.select.pageUp") ? -1 : 1);
      } else if (key.id === "tab") {
        const { selected } = list.pickerView();
        if (!selected || installed.has(selected)) return;
        if (checked.has(selected)) checked.delete(selected);
        else checked.add(selected);
        list.setItems(markedItems());
      } else if (key.id === "ctrl+a") {
        const items = list.pickerView().items.filter(item => !installed.has(item.value));
        const remove = items.every(item => checked.has(item.value));
        for (const { value } of items) {
          if (remove) checked.delete(value);
          else checked.add(value);
        }
        list.setItems(markedItems());
      } else {
        list.handleKey(key);
      }
    },
  };
}
