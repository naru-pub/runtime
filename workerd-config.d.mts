// Types for workerd-config.mjs, for the TypeScript that imports it
// (src/functions.test.ts).
export const runtime: string;
export function bundleWorker(config: string, outdir: string, cwd?: string): void;
export function modulesOf(dir: string, entry: string, prefix: string): Promise<string[]>;
export function fromEnvironment(name: string, variable?: string): string;
export function siteDataConfig(options: {
  header: string;
  modules: string[];
  bindings: string[];
  sdkFiles: string | null;
  siteObjects: string | null;
  uniqueKey: string;
  allow?: string[];
  passthrough?: string | null;
}): string;
