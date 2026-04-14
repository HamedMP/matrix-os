import type { NextConfig } from "next";

const config: NextConfig = {
  basePath: `/apps/${process.env.MATRIX_APP_SLUG ?? "my-next-app"}`,
  output: "standalone",
};

export default config;
