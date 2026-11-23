// Wrangler bundles `.sh` files as text (see `rules` in wrangler.toml).
declare module "*.sh" {
  const text: string;
  export default text;
}
