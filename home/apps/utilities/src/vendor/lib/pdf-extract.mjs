/** Local PDF text extraction. PDF.js sees the document bytes in memory only. */
export async function extractPdfPages(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const doc = await task.promise;
    if (doc.numPages > 200) throw new Error("PDFs must have 200 pages or fewer.");
    const pages = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const content = await (await doc.getPage(number)).getTextContent();
      const rows = new Map();
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        const y = Math.round(item.transform?.[5] ?? 0);
        const row = rows.get(y) ?? [];
        row.push({ x: item.transform?.[4] ?? 0, value: item.str });
        rows.set(y, row);
      }
      pages.push([...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, row]) => row.sort((a, b) => a.x - b.x).map((item) => item.value).join(" ").trim()).filter(Boolean));
    }
    return pages;
  } finally { await task.destroy(); }
}
