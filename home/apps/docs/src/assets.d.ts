/** An image imported with `?inline`: Vite bundles it as a `data:` URL string. */
declare module "*.png?inline" {
  const dataUrl: string;
  export default dataUrl;
}
