/**
 * Verified against OpenCode 1.18.25 (2026-08-30): every entry is a literal
 * `Npm.which()` call site in the host. Re-derive this table when that host
 * version changes.
 */
export const MANAGED_TOOLS: readonly string[] = [
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
  "@biomejs/biome",
  "oxfmt",
  "prettier",
];
