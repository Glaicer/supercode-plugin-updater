import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Installs a host-shaped generation into a V2 cache
 * (`npm/<name>@latest/<generation>/node_modules/<name>`); `null` writes a
 * broken manifest. Returns the manifest path.
 */
export function installGeneration(cacheDir: string, name: string, generation: string, version: string | null): string {
  const directory = join(cacheDir, "npm", `${name}@latest`, generation, "node_modules", ...name.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), version === null ? "{" : JSON.stringify({ name, version }));
  return join(directory, "package.json");
}
