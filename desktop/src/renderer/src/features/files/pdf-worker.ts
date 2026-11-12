// Bundle the worker through Vite so packaged builds never fetch a CDN or a
// pnpm virtual-store path. It runs independently of the Electron preload.
import "pdfjs-dist/build/pdf.worker.mjs";
