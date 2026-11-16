import { defineConfig } from "vite";
// Preserve bridge expressions and function names for Matrix's conservative verifier.
export default defineConfig({ base: "./", build: { target: "es2022", sourcemap: false, minify: false } });
