/**
 * tools — the known set of Managed Tools as data. OpenCode installs these npm
 * packages on demand via `Npm.which("…")` (LSP servers behind the
 * `disableLspDownload` gate, formatters behind their `enabled()` probes); a
 * package from this table with an existing cache dir is an installed tool.
 *
 * The checkable universe is `MANAGED_TOOLS ∩ existing cache dirs` — never a
 * cache scan, so foreign cache content (e.g. a `name@git+https:` dependency)
 * is neither contacted nor listed.
 *
 * Verified against: opencode 1.18.25 (2026-08-30) — every name below is a
 * literal `.which("…")` call site in the host binary. Re-derive the table
 * when the host version changes: the gate and the call sites move between
 * releases. The set is deliberately table-only data: no per-name logic lives
 * anywhere in the pipeline.
 */
export const MANAGED_TOOLS: readonly string[] = [
  // LSP servers installed on demand by the host.
  "@astrojs/language-server",
  "@vue/language-server",
  "bash-language-server",
  "biome",
  "dockerfile-language-server-nodejs",
  "intelephense",
  "pyright",
  "svelte-language-server",
  "typescript-language-server",
  "yaml-language-server",
  // Formatters.
  "@biomejs/biome",
  "oxfmt",
  "prettier",
];
