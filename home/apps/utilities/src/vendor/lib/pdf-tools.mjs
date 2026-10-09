import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 200;
const PDF_HEADER = [37, 80, 68, 70, 45];
const SUPPORTED = new Set(["pdf-workspace", "merge-pdfs", "split-pdf", "rotate-pdf", "watermark-pdf", "add-pdf-page-numbers", "edit-pdf-metadata", "edit-pdf", "sign-pdf", "protect-pdf", "unlock-pdf", "compress-pdf", "verify-pdf", "compare-pdfs", "pdf-to-word", "pdf-to-excel"]);

function checkBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < PDF_HEADER.length || !PDF_HEADER.every((byte, i) => bytes[i] === byte)) throw new Error("Choose a valid PDF file.");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Each PDF must be 50 MB or smaller.");
}

async function load(bytes) {
  checkBytes(bytes);
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
    if (pdf.getPageCount() < 1 || pdf.getPageCount() > MAX_PAGES) throw new Error("PDFs must have 1 to 200 pages.");
    return pdf;
  } catch (error) {
    if (error instanceof Error && /1 to 200/.test(error.message)) throw error;
    throw new Error("Could not open this PDF. It may be damaged or password protected.");
  }
}

function text(value, label, maximum = 1000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Enter ${label}.`);
  if (value.length > maximum) throw new Error(`${label} must be ${maximum.toLocaleString()} characters or fewer.`);
  return value.trim();
}

function pageIndices(source, count) {
  if (typeof source !== "string" || !source.trim()) throw new Error("Enter page numbers, such as 1,3-5.");
  const indices = new Set();
  for (const term of source.split(",")) {
    const match = /^\s*(\d{1,3})(?:-(\d{1,3}))?\s*$/.exec(term);
    if (!match) throw new Error("Enter valid page numbers, such as 1,3-5.");
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (first < 1 || last > count || last < first) throw new Error(`Page range must stay within 1 to ${count}.`);
    for (let page = first; page <= last; page++) indices.add(page - 1);
  }
  return [...indices].sort((a, b) => a - b);
}

async function fontFor(pdf) { return pdf.embedFont(StandardFonts.Helvetica); }

function box(page) { const { width, height } = page.getSize(); return { width, height }; }

/** All processing remains in the calling browser; inputs are bytes from local File objects. */
export async function runPdfTool(slug, files, options = {}) {
  if (!SUPPORTED.has(slug)) throw new Error("Unknown PDF tool.");
  if (!Array.isArray(files) || files.length === 0 || files.length > 10) throw new Error("Choose 1 to 10 PDF files.");
  if (files.length !== 1 && slug !== "merge-pdfs" && slug !== "pdf-workspace" && slug !== "compare-pdfs") throw new Error("Choose one PDF for this task.");
  if (slug === "compare-pdfs" || slug === "pdf-to-word" || slug === "pdf-to-excel") {
    for (const bytes of files) await load(bytes);
    const { extractPdfPages } = await import("./pdf-extract.mjs");
    const first = await extractPdfPages(files[0]);
    if (slug === "compare-pdfs") {
      if (files.length !== 2) throw new Error("Choose two PDFs to compare.");
      const second = await extractPdfPages(files[1]);
      const max = Math.max(first.length, second.length);
      const differences = [];
      for (let i = 0; i < max; i++) {
        const left = (first[i] ?? []).join("\n"), right = (second[i] ?? []).join("\n");
        if (left !== right) differences.push(`Page ${i + 1}:\nFirst: ${left.slice(0, 500)}\nSecond: ${right.slice(0, 500)}`);
        if (differences.join("\n").length > 90_000) throw new Error("Comparison is too large to display.");
      }
      return { output: differences.length ? `Extracted text differs on ${differences.length} page(s). Visual/layout differences are not checked.\n\n${differences.join("\n\n")}` : "Extracted text is the same on corresponding pages. Visual/layout differences are not checked." };
    }
    if (slug === "pdf-to-word") {
      const { Document, Paragraph, Packer } = await import("docx");
      const paragraphs = first.flatMap((lines, i) => [new Paragraph({ text: `Page ${i + 1}`, heading: "Heading2" }), ...lines.map((line) => new Paragraph(line))]);
      const blob = await Packer.toBlob(new Document({ sections: [{ children: paragraphs }] }));
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "extracted-text.docx", notice: "This extracts text into paragraphs; it does not reproduce the PDF layout or images." };
    }
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.default.Workbook();
    const sheet = workbook.addWorksheet("Extracted text");
    sheet.addRow(["Page", "Line", "Text"]);
    first.forEach((lines, i) => lines.forEach((line, j) => sheet.addRow([i + 1, j + 1, line])));
    const buffer = await workbook.xlsx.writeBuffer();
    return { bytes: new Uint8Array(buffer), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "extracted-text.xlsx", notice: "This places extracted text on spreadsheet rows; it does not reconstruct tables or formulas." };
  }
  if (["protect-pdf", "unlock-pdf", "compress-pdf", "verify-pdf"].includes(slug)) {
    checkBytes(files[0]);
    const { createPdfToolkit, PdfPasswordError } = await import("pdfstudio");
    const toolkit = await createPdfToolkit();
    if (slug === "verify-pdf") {
      try {
        const info = await toolkit.getInfo(files[0], options.password ? { password: options.password } : undefined);
        return { output: `Structural PDF inspection succeeded. ${info.pageCount} pages. PDF ${info.pdfVersion}. Encryption: ${info.encrypted ? "yes" : "no"}. This does not verify identity or cryptographic signatures.` };
      } catch { throw new Error("Could not inspect this PDF. It may be damaged or password protected."); }
    }
    if (slug === "protect-pdf") {
      await load(files[0]);
      const password = text(options.password, "Password", 128);
      if (password.length < 12) throw new Error("Use a password of at least 12 characters.");
      const bytes = await toolkit.lock(files[0], { userPassword: password, ownerPassword: password, keyLength: 256 });
      return { bytes: new Uint8Array(bytes), mime: "application/pdf", filename: "protected.pdf" };
    }
    if (slug === "unlock-pdf") {
      const password = text(options.password, "Password", 128);
      try {
        const bytes = await toolkit.unlock(files[0], { password });
        return { bytes: new Uint8Array(bytes), mime: "application/pdf", filename: "unlocked.pdf" };
      } catch (error) {
        if (error instanceof PdfPasswordError) throw new Error("Incorrect PDF password.");
        throw new Error("Could not unlock this PDF. Check that it is encrypted and the password is correct.");
      }
    }
    await load(files[0]);
    try {
      const bytes = await toolkit.compress(files[0]);
      return { bytes: new Uint8Array(bytes), mime: "application/pdf", filename: "compressed.pdf", notice: "Lossless stream compression may not reduce every PDF. Images are not recompressed." };
    } catch { throw new Error("Could not compress this PDF."); }
  }
  if (slug === "pdf-workspace") {
    const sources = [];
    let total = 0;
    for (const bytes of files) {
      const source = await load(bytes);
      total += source.getPageCount();
      if (total > MAX_PAGES) throw new Error("Combined PDF must have 200 pages or fewer.");
      sources.push(source);
    }
    const pagePlan = options.pagePlan ?? sources.flatMap((source, sourceIndex) => source.getPageIndices().map((pageIndex) => ({ sourceIndex, pageIndex, rotation: 0 })));
    if (!Array.isArray(pagePlan) || pagePlan.length !== total) throw new Error("Include every page in the PDF workspace plan.");
    const seen = new Set();
    for (const entry of pagePlan) {
      if (!entry || !Number.isInteger(entry.sourceIndex) || !Number.isInteger(entry.pageIndex) || !sources[entry.sourceIndex] || entry.pageIndex < 0 || entry.pageIndex >= sources[entry.sourceIndex].getPageCount()) throw new Error("Choose a valid source page in the PDF workspace plan.");
      if (![0, 90, 180, 270].includes(entry.rotation)) throw new Error("Choose a page rotation of 0, 90, 180, or 270 degrees.");
      const key = `${entry.sourceIndex}:${entry.pageIndex}`;
      if (seen.has(key)) throw new Error("Include each source page exactly once.");
      seen.add(key);
    }
    const output = await PDFDocument.create();
    const copied = [];
    for (const source of sources) copied.push(await output.copyPages(source, source.getPageIndices()));
    for (const entry of pagePlan) {
      const page = copied[entry.sourceIndex][entry.pageIndex];
      page.setRotation(degrees((page.getRotation().angle + entry.rotation) % 360));
      output.addPage(page);
    }
    return { bytes: new Uint8Array(await output.save()), mime: "application/pdf", filename: "pdf-workspace.pdf" };
  }
  if (slug === "merge-pdfs") {
    if (files.length < 2) throw new Error("Choose at least two PDFs to merge.");
    const output = await PDFDocument.create();
    let total = 0;
    for (const bytes of files) {
      const source = await load(bytes);
      total += source.getPageCount();
      if (total > MAX_PAGES) throw new Error("Combined PDF must have 200 pages or fewer.");
      const pages = await output.copyPages(source, source.getPageIndices());
      for (const page of pages) output.addPage(page);
    }
    return { bytes: new Uint8Array(await output.save()), mime: "application/pdf", filename: "merged.pdf" };
  }
  const pdf = await load(files[0]);
  if (slug === "split-pdf") {
    const output = await PDFDocument.create();
    const copied = await output.copyPages(pdf, pageIndices(options.pages, pdf.getPageCount()));
    for (const page of copied) output.addPage(page);
    return { bytes: new Uint8Array(await output.save()), mime: "application/pdf", filename: "selected-pages.pdf" };
  }
  if (slug === "rotate-pdf") {
    const angle = Number(options.degrees);
    if (![90, 180, 270].includes(angle)) throw new Error("Choose a rotation of 90, 180, or 270 degrees.");
    for (const page of pdf.getPages()) page.setRotation(degrees((page.getRotation().angle + angle) % 360));
  }
  if (slug === "watermark-pdf") {
    const label = text(options.text, "Watermark text");
    const font = await fontFor(pdf);
    for (const page of pdf.getPages()) {
      const { width, height } = box(page);
      page.drawText(label, { x: Math.max(20, width * .1), y: height * .48, size: Math.min(42, width / Math.max(2, label.length * .7)), font, color: rgb(.7, .2, .15), opacity: .35, rotate: degrees(30) });
    }
  }
  if (slug === "add-pdf-page-numbers") {
    const font = await fontFor(pdf);
    pdf.getPages().forEach((page, i) => { const { width } = box(page); page.drawText(`${i + 1} / ${pdf.getPageCount()}`, { x: width / 2 - 12, y: 22, size: 10, font, color: rgb(.2, .2, .2) }); });
  }
  if (slug === "edit-pdf-metadata") {
    if (!options.title && !options.author && !options.subject && !options.keywords) throw new Error("Enter at least one metadata field.");
    for (const key of ["title", "author", "subject", "keywords"]) if (options[key] && String(options[key]).length > 300) throw new Error("Metadata fields must be 300 characters or fewer.");
    if (options.title) pdf.setTitle(String(options.title));
    if (options.author) pdf.setAuthor(String(options.author));
    if (options.subject) pdf.setSubject(String(options.subject));
    if (options.keywords) pdf.setKeywords(String(options.keywords).split(",").map((word) => word.trim()).filter(Boolean));
  }
  if (slug === "edit-pdf" || slug === "sign-pdf") {
    const label = text(options.text, slug === "sign-pdf" ? "Name" : "Text");
    const font = await fontFor(pdf);
    const page = pdf.getPage(0);
    const { width, height } = box(page);
    const x = options.x === undefined || options.x === "" ? 30 : Number(options.x);
    const y = options.y === undefined || options.y === "" ? 50 : Number(options.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width - 20 || y > height - 20) throw new Error("Text position must be within the first page.");
    page.drawText(label, { x, y, size: slug === "sign-pdf" ? 22 : 14, font, color: rgb(.1, .22, .18) });
  }
  return {
    bytes: new Uint8Array(await pdf.save()), mime: "application/pdf", filename: `${slug}.pdf`,
    ...(slug === "sign-pdf" ? { notice: "This is a visual signature, not a cryptographic digital signature." } : {}),
  };
}
