// What wrangler bundles a .wasm import as.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
