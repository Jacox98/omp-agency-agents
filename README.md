# Agency Agents for omp

`omp-agency-agents` adds `/agency-agents` to the omp terminal UI. Use it to preview prompts and install individual agents or a whole team from the [Agency Agents catalog](https://github.com/msitarzewski/agency-agents).

## Install the plugin

Install the published package from npm through omp.

```sh
omp plugin install omp-agency-agents
```

To use a local checkout, run these commands from the plugin directory. omp links to that directory, so keep the checkout in place.

```sh
bun install
omp plugin install "$PWD"
```

## Install and verify an agent

1. Start `omp` in your project and enter `/agency-agents`.
2. Choose **Current project** for agents in this project or **Global user** to make them available across projects in the same omp profile. The menu shows both absolute paths.
3. Type a search term and use **↑ / ↓** to highlight an agent. Read its prompt in the preview pane, then press **Tab** to check it and **Enter** to install. The summary shows the destination and any conflicts or errors. Existing files are preserved.
4. Open `/agents` and look for the installed ID, which starts with `agency-`. If the session still shows the previous list, restart omp. You can also check for `<agent-id>.md` in the displayed destination.

## Browsing agents

The picker previews the highlighted prompt beside the list on wide terminals and below it on narrow terminals. Use **PgUp / PgDn** to scroll the prompt.

Press **F3** to switch between the full catalog and installed agents. `[Project]`, `[Global]`, and `[Project + Global]` show where each agent is installed. A checkbox marks an agent you can install in the chosen destination.

To install a team, press **F2**, search for a NEXUS runbook such as **Startup MVP Build**, highlight its **Core Team**, and press **Enter** to apply the filter. You can also choose a whole division, a subgroup, or a runbook. With the agent search empty, press **Ctrl+A** to check all available group members, then **Enter** to install them.

**Ctrl+A** toggles only the current matches. Checked agents stay selected when you change the search, group, or installed view. **Enter** installs all checked agents. **Esc** goes back from the group menu or exits the picker without installing.

## Offline use and catalog updates

The first catalog download requires `git` on your `PATH` and network access to GitHub. The plugin makes a temporary shallow clone of the upstream `main` branch and saves the catalog under `cache/agency-agents/catalog-v1.json` in the omp agent directory. Projects sharing that directory can browse, preview, and install agents offline from the saved copy.

Choose **Refresh catalog from GitHub** in the destination menu to fetch the latest prompts and team rosters. A failed or canceled download preserves the previous snapshot. Refreshing updates the catalog only. Installed Markdown files keep their original prompt body, the upstream license in frontmatter comments, and any local edits.

## Development

Run `bun install --frozen-lockfile`, `bun run typecheck` and `bun test` from the checkout. The tests cover catalog parsing, caching, picker controls and installation.

The plugin code is distributed under the [MIT License](LICENSE). The upstream license notice is embedded in each installed agent file.

## Credits

- [Agency Agents](https://github.com/msitarzewski/agency-agents), maintained by msitarzewski and its contributors, provides the agent prompts, divisions, and NEXUS team rosters. The prompts carry the upstream MIT notice, © 2025 AgentLand Contributors.
- [Oh My Pi (omp)](https://github.com/can1357/oh-my-pi) provides the extension API, terminal UI components, and agent runtime used by this plugin.
