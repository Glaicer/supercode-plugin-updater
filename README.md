# plugin-updater

An OpenCode plugin that shows plugin and managed-tool updates in one `/plugin-updates` screen, and applies the updates you confirm through OpenCode's own update machinery.

## Requirements

- OpenCode **2.0.16** — the release this plugin version is verified against. Newer OpenCode releases must be re-verified before this package can claim them; older OpenCode 2 releases are not claimed. For OpenCode 1.x, use the published `0.3.0` release (documented at the bottom) — it is a different API and a different lifecycle.

## Install

```bash
opencode plugin add @glaicer/supercode-plugin-updater
```

The plugin is TUI-only, so the command installs it into the CLI config (`cli.json` in the global config directory) and registers it for the terminal. Restart OpenCode after installing.

Manual install does the same: add the package to the `plugins` array in `cli.json` (global `~/.config/opencode/cli.json`):

```jsonc
{
  "plugins": ["@glaicer/supercode-plugin-updater"]
}
```

Plugin options use the object form:

```jsonc
{
  "plugins": [
    {
      "package": "@glaicer/supercode-plugin-updater",
      "options": { "registryBaseUrl": "https://registry.npmjs.org" }
    }
  ]
}
```

`registryBaseUrl` overrides the registry the plugin queries for `latest` metadata (default: public npm).

## What it does

Once per 24 hours for the same inventory and environment, and again freshly every time you open `/plugin-updates`:

- If the automatic check finds updates, you get one toast: `N OpenCode updates available. Run /plugin-updates to review them.` Without updates it stays silent, and opening the screen never repeats the toast.
- `/plugin-updates` (command palette or slash command) opens a screen with two sections:

  - **Plugins** — one line per plugin, with the installed and available version. A plugin that is up to date reads as its installed version alone. A package loaded by both the server and the TUI is listed once and updates both halves; local-path plugins are development fixtures and are never listed. After you confirm, a server half applies **live**: the running server picks up the new plugin behavior without a restart. A TUI half installs a new package generation; the running TUI keeps the loaded version **until it restarts**, and the row says so explicitly (`restart TUI to activate`).
  - **Managed tools** — the formatters OpenCode installs itself (`prettier`, `oxfmt`, `@biomejs/biome`). OpenCode installs them **on demand** (the first time a format runs) and does not update them on its own. A tool with a confirmed update is selectable; pressing `X` reinstalls the selection and restarts the server (see below). A tool that is up to date or unverified stays informational. The section appears only when the connected server provably runs on this machine — for a remote (or unverifiable) connection the formatters belong to that other machine and the section reports itself unavailable instead of reading the local cache.

- Select what you want (`Space` / `A`), then confirm the action for that kind: `U` updates plugins, `X` reinstalls managed tools. The plugin confirmation lists every selected plugin once and warns what each half does: server updates change the live server, TUI updates take effect on the next restart, and a plugin shared by both runtimes is sent to the standard CLI **once** — it re-checks and may update either or both runtimes. The managed-tool confirmation warns that reinstalling restarts the shared server.

### Reinstalling managed tools

Managed tools are not updated in place like plugins. Confirming `X` **invalidates the installed cache of exactly the selected tools** and restarts the server, so OpenCode installs fresh versions itself — but only **on next use**, not when the server starts. Because the restart touches everything attached to the shared server, the confirmation spells out that it disconnects connected windows, interrupts agents' current work, and stops server terminals.

After the restart the tools show **`awaiting reinstallation`** — not "updated" — until OpenCode actually installs them again on next use; the installed version is only confirmed from the cache that really appears. The action stops the specific managed background server the TUI is provably connected to (verified against the service registration, not merely localhost) and is unavailable for a remote, standalone, or unconfirmed server. The stop → invalidate → start sequence runs in a detached supervisor, so the server is brought back even if this window's connection drops mid-operation.

| Key | Action |
| --- | --- |
| `j` / `k` or arrows | Move the cursor |
| Space | Toggle the row under the cursor (a plugin shared by the server and the TUI selects both halves) |
| `A` | Select every selectable package and updatable tool |
| `U` | Update the selected plugins (confirmation dialog first) |
| `X` | Reinstall the selected managed tools and restart the server (confirmation dialog first) |
| `R` | Re-check now, ignoring the 24h timer |
| Esc | Close |

Rows without a confirmed update — pinned, skipped, or unknown — are shown for information but can never be selected. When the host itself confirms an update, the row stays selectable even if the extra registry metadata is unavailable; the version pair then reads `installed → unknown`.

After applying, the screen re-reads the inventory and shows the result per row: `updated · now 1.2.3` is the version actually installed — not the version that was advertised before you confirmed. A target that failed to activate is shown as an activation error, and if the inventory cannot be re-read the row says `inventory unavailable` instead of claiming success. One failed target never blocks the others.

The version shown as `latest` is registry metadata at check time. Applying an update goes through OpenCode's own resolver, which may install a newer release than the one displayed; the screen always reports what actually happened.

Outside the managed-tool `X` action, the plugin never deletes anything. That action removes the cache generations of exactly the selected managed tools (and nothing else — never a plugin cache, another tool, or a config) as part of the verified stop → invalidate → start sequence. It never writes other plugins' configuration, and never acts on state left by the 0.3.0 (OpenCode 1.x) release — opening the screen, closing it, restarting, or exiting changes nothing on disk beyond what OpenCode's own install machinery does. Closing the TUI does not stop the V2 server and runs no cleanup.

## The 0.3.0 release (OpenCode 1.x)

The published `0.3.0` package is the last release for OpenCode 1.x. It works differently — it marks stale cache entries and OpenCode applies them on the next restart — and its documentation below stays as it shipped:

<p>
  <img src="public/plugin-updater.gif" alt="plugin-updater demo" width=800 />
</p>
<br />

An OpenCode plugin that tells you when your plugins and built-in tools have updates waiting, and applies them on the next restart.

### The problem

OpenCode installs npm plugins and managed tools (prettier, pyright, bash-language-server, …) into `~/.cache/opencode/packages`, but nothing ever updates them. Whatever version was current when a package was first cached stays there forever. There's no update check, no notification, and no command to update them. The only remedy is manually deleting cache directories.

### What it does

It compares the installed version of every plugin and managed tool against `latest` on the npm registry — once a day on startup (24h between checks), and freshly every time you open `/plugin-updates`:

- If it finds updates, you get a toast: `N OpenCode updates available. Run /plugin-updates to review them.`
- `/plugin-updates` (command palette or slash command) opens a screen with three groups (Plugins, Managed tools, Skipped) showing `installed → latest` per package. Opening the screen always re-checks now (ignoring the 24h timer), so the list is never stale.
- Select what you want (Space / `A`), press `U`, confirm, and OpenCode installs the fresh versions itself on the next restart.

The plugin never installs or deletes anything directly. Confirming marks the stale cache entries for removal; when OpenCode exits, they're cleaned up and the built-in resolver installs fresh versions on the next start. Until you restart, nothing on disk changes.

Failures are contained: one unreachable package shows as `unknown` and doesn't break the cycle; a total registry outage keeps the last result on screen.

| Key | Action |
| --- | --- |
| `j` / `k` or arrows | Move the cursor |
| Space | Toggle the package under the cursor |
| `A` | Select every selectable package |
| `U` | Prepare updates for the selection (confirm dialog first) |
| `R` | Re-check again (opening the screen already re-checks; no toast) |
| Esc | Close |

Pinned, unknown, and skipped rows are shown for information but can never be selected. Confirming shows a pending-restart banner: the marked cache entries are removed when OpenCode exits, and the next start installs the new versions.

### What gets checked

- Floating plugin specs from `opencode.json` and `tui.json` (union, exact duplicates checked once), like `foo` and `foo@latest`. `[spec, options]` tuple entries contribute their spec string.
- Managed tools: the bundled tools OpenCode installs for you (prettier, pyright, …).

Skipped, with the reason shown on screen: pinned specs (`foo@1.2.3`), local paths, `file:`/`git+`/URL specs, and semver ranges. Those change only when you change them, so updating them automatically makes no sense.

### Install

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

## Development

```bash
npm run build       # precompile the Solid TUI entrypoint into dist/
npm run typecheck   # tsc --noEmit
npm test            # node --test, network-free: registry and cache are fixtures
```

The compiled `./tui` export (`dist/update-checker.js`) is precompiled Solid output; the host never transpiles TSX. Isolated live probes on the pinned host — including the packed-artifact install check — live in the supercode development repository under `.scratch/041-update-checker-v2/probe/`.
