/** Deterministic fixture originals, with a complete PDF object table and byte-accurate xref. */
export function invoicePdf(document) {
  const escape = value => value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const lines = ['SYNTHETIC - NOT PAYABLE', `Invoice ${document.documentId}`, 'Supplier: Matrix Synthetic Supplies',
    'Customer: Matrix Browser Test Fixture', 'Issue date: 2026-10-14', 'Description: Synthetic browser workflow validation',
    `Total: ${document.currency} ${document.total}`, 'No real account, purchase, payment or tax document.', 'This is an original synthetic fixture PDF.'];
  const stream = `BT\n/F1 13 Tf\n50 780 Td\n${lines.map((line, index) => `${index ? '0 -26 Td\n' : ''}(${escape(line)}) Tj`).join('\n')}\nET\n`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; const offsets = [0]; let size = chunks[0].length;
  for (const [index, object] of objects.entries()) { offsets.push(size); const bytes = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`); chunks.push(bytes); size += bytes.length; }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
