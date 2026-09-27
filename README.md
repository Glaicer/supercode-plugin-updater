# plugin-updater

## V2 worktree (tickets 01–04, not published)

This checkout targets OpenCode 2.0.16. Its compiled `./tui` entrypoint provides `/plugin-updates` with the non-builtin plugins of the connected server and the effective TUI packages: server rows come from the server inventory (host's outdated flag plus public-npm `latest` metadata), TUI rows come from cli.json targets plus the TUI halves the server exposes, with installed versions read from the npm generation cache and availability from the registry comparison. A 24h automatic check runs with one toast when updates appear; `R` refresh ignores the TTL. Outdated rows are selectable (Space / A) — selecting one row of a shared Server+TUI target selects both. `U` confirms: server-only targets go through the connected server (`client.plugin.update`, one target at a time), TUI-only and shared targets go through one exact-target `opencode plugin update <target>` subprocess bound to the connected location, and the screen shows progress, per-runtime results, the version actually installed after the re-read, and — for TUI rows — that the loaded version stays until the TUI restarts.

The screen also shows a read-only **Managed tools** section for the formatters OpenCode installs itself (`prettier`, `oxfmt`, `@biomejs/biome`): installed version from the local V2 generation cache (`npm/<name>@latest/<generation>`), availability from the same registry comparison, never selectable, never updated by any key. The section appears only when the connected server provably runs on this machine — the plugin compares the server's reported tmp root and process id with the local ones, and treats anything unverifiable as remote; a remote server's formatters belong to that machine and are not read from the local cache. Formatter updates count toward the shared toast and the `N updates available` counter, and a broken manifest shows `unknown` instead of a version. The released `0.3.0` package is still V1; do not use the installation instructions below for this worktree.

For a local V2 test, run `node scripts/build.mjs` and add this directory's **absolute path** to the `plugins` array in global `~/.config/opencode/cli.json`, then start OpenCode 2.0.16. The root `tui.js` loads the compiled `dist/update-checker.js` for directory-based discovery; the package's `./tui` export points directly to the same compiled file. Verify with `npm run typecheck`, `npm test`, and the isolated host probe in `../../.scratch/041-update-checker-v2/probe/RESULTS.md`.

The plugin reads five entries from its registration `options` (the `options` object of its cli.json entry): `registryBaseUrl` overrides the registry-metadata base URL (default `https://registry.npmjs.org`; used by the isolated probes to point at a controlled registry), and `tuiPackages` / `runPluginUpdate` / `managedTools` / `serverLocality` replace the TUI-inventory adapter, the CLI runner, the managed-tools cache adapter, and the locality check — injection seams for the entrypoint tests and probes, not meant for production configs (JSON options cannot carry functions anyway). The apply mechanism parses the CLI's human output lines (`Updated/Failed to (update|check) Server|TUI plugin`); a host rewording of those lines would degrade outcomes to "not updated", which the re-read path keeps honest.

## Published V1 release (0.3.0)

<p>
  <img src="public/plugin-updater.gif" alt="plugin-updater demo" width=800 />
</p>
<br />

An OpenCode plugin that tells you when your plugins and built-in tools have updates waiting, and applies them on the next restart.

## The problem

OpenCode installs npm plugins and managed tools (prettier, pyright, bash-language-server, …) into `~/.cache/opencode/packages`, but nothing ever updates them. Whatever version was current when a package was first cached stays there forever. There's no update check, no notification, and no command to update them. The only remedy is manually deleting cache directories.

## What it does

It compares the installed version of every plugin and managed tool against `latest` on the npm registry — once a day on startup (24h between checks), and freshly every time you open `/plugin-updates`:

- If it finds updates, you get a toast: `N OpenCode updates available. Run /plugin-updates to review them.`
- `/plugin-updates` (command palette or slash command) opens a screen with three groups (Plugins, Managed tools, Skipped) showing `installed → latest` per package. Opening the screen always re-checks now (ignoring the 24h timer), so the list is never stale.
- Select what you want (Space / `A`), press `U`, confirm, and OpenCode installs the fresh versions itself on the next restart.

The plugin never installs or deletes anything directly. Confirming marks the stale cache entries for removal; when OpenCode exits, they're cleaned up and the built-in resolver installs fresh versions on the next start. Until you restart, nothing on disk changes.

Failures are contained: one unreachable package shows as `unknown` and doesn't break the cycle; a total registry outage keeps the last result on screen.

## What gets checked

- Floating plugin specs from `opencode.json` and `tui.json` (union, exact duplicates checked once), like `foo` and `foo@latest`. `[spec, options]` tuple entries contribute their spec string.
- Managed tools: the bundled tools OpenCode installs for you (prettier, pyright, …).

Skipped, with the reason shown on screen: pinned specs (`foo@1.2.3`), local paths, `file:`/`git+`/URL specs, and semver ranges. Those change only when you change them, so updating them automatically makes no sense.

## Install

Install with the OpenCode CLI — it detects the TUI target and registers the plugin in `tui.json` for you:

```bash
opencode plugin @glaicer/supercode-plugin-updater
```

- `--global` installs into the global config (`~/.config/opencode`); default is local (`.opencode` in the current project).
- `--force` replaces an already-installed version.
- Restart OpenCode after installing.

Manual install also works: add the package to the `plugin` array in `tui.json` (global `~/.config/opencode/tui.json` or local `<project>/.opencode/tui.json`):

```jsonc
{
  "plugin": ["@glaicer/supercode-plugin-updater"]
}
```

> [!IMPORTANT]
> **The first OpenCode load after installing this plugin may be slow.** That's OpenCode downloading the plugin's packages and managed tools into its cache — it happens once. Every subsequent start is fast.

| Key | Action |
| --- | --- |
| `j` / `k` or arrows | Move the cursor |
| Space | Toggle the package under the cursor |
| `A` | Select every selectable package |
| `U` | Prepare updates for the selection (confirm dialog first) |
| `R` | Re-check again (opening the screen already re-checks; no toast) |
| Esc | Close |

Pinned, unknown, and skipped rows are shown for information but can never be selected. Confirming shows a pending-restart banner: the marked cache entries are removed when OpenCode exits, and the next start installs the new versions.

## Development

```bash
npm run build       # precompile the Solid TUI entrypoint into dist/
npm run typecheck   # tsc --noEmit
npm test            # node --test, network-free: registry and cache are fixtures
```
