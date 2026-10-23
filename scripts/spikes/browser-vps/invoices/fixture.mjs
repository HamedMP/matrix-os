import { createHash } from 'node:crypto';
import { invoicePdf } from './original-pdf.mjs';
const documents = [
  { documentId: 'SYN_INV_001', currency: 'EUR', total: '144.00', sourcePath: '/invoices/documents/SYN_INV_001.pdf' },
  { documentId: 'SYN_INV_002', currency: 'EUR', total: '90.00', sourcePath: '/invoices/documents/SYN_INV_002.pdf' },
].map(value => ({ ...value, bytes: invoicePdf(value) })); // Fixed two-buffer catalog; no user content or file access.
export const INVOICE_FIXTURE_EXPECTED = Object.freeze({ synthetic: true, pageCount: 2, rowCount: 4, uniqueDocumentCount: 2,
  documents: documents.map(({ bytes, ...value }) => Object.freeze({ ...value, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })),
  conflicts: [{ documentId: 'SYN_INV_002', displayedCurrency: 'USD', displayedTotal: '95.00', originalCurrency: 'EUR', originalTotal: '90.00' }],
  coveragePaths: ['/invoices', '/invoices/page-2'],
});
const css = `*{box-sizing:border-box}body{margin:0;background:#f6f7fa;color:#20232a;font:16px system-ui,-apple-system,sans-serif}main{max-width:1120px;margin:0 auto;padding:40px 32px}.tag{display:inline-block;padding:8px 12px;background:#fff0cf;color:#795000;border-radius:8px;font-size:12px;font-weight:700;letter-spacing:.08em}h1{font-size:32px;margin:24px 0 10px}.muted{color:#606978}header{display:flex;align-items:center;justify-content:space-between;gap:20px}.card{margin-top:28px;background:white;border:1px solid #e0e4eb;border-radius:14px;overflow:hidden}.card h2{padding:22px 24px;margin:0;font-size:18px}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:18px 24px;border-top:1px solid #e9ecf1}th{font-size:12px;color:#66707e;text-transform:uppercase;letter-spacing:.08em}a{color:#324fc4;text-decoration:none;font-weight:600}a:hover{text-decoration:underline}nav{display:flex;justify-content:space-between;align-items:center;padding:22px 24px;border-top:1px solid #e9ecf1}.note{padding:20px 24px;background:#fafbfe;color:#66707e;font-size:13px;line-height:1.7}button{background:#3453cb;color:white;border:0;border-radius:8px;font:600 16px system-ui;padding:12px 18px;cursor:pointer}.login{padding:26px 24px;line-height:1.7}.total{font-variant-numeric:tabular-nums;font-weight:600}.period{border:1px solid #e0e4eb;background:white;padding:10px 14px;border-radius:9px}@media(max-width:700px){main{padding:24px 12px}th,td{padding:14px 10px}header{align-items:flex-start;flex-direction:column}}`;
function shell(content) { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Matrix synthetic invoices</title><style>${css}</style></head><body><main><span class="tag">SYNTHETIC · NOT PAYABLE</span>${content}<p class="muted">Matrix Browser workflow fixture. No real services, accounts, credentials or payments.</p></main></body></html>`; }
function page(number) {
  const rows = documents.map((doc, index) => `<tr><td><strong>${doc.documentId}</strong><br><small class="muted">Matrix Synthetic Supplies</small></td><td>2026-10-14</td><td class="total">${number === 2 && index === 1 ? 'USD 95.00' : `${doc.currency} ${doc.total}`}</td><td>${number === 1 ? 'Current record' : 'Archive import'}</td><td><a href="${doc.sourcePath}" download="${doc.documentId}.pdf" aria-label="Download original PDF for ${doc.documentId}">Download original PDF</a></td></tr>`).join('');
  return shell(`<header><div><h1>Invoices</h1><p class="muted">Collect original documents for your review packet.</p></div><span class="period">October 2026 · Synthetic</span></header><section class="card"><h2>${number === 1 ? 'Current invoices' : 'Imported archive records'}</h2><table><thead><tr><th>Invoice</th><th>Issued</th><th>Displayed amount</th><th>Source record</th><th>Original</th></tr></thead><tbody>${rows}</tbody></table><nav>${number === 2 ? '<a href="/invoices">Previous page</a>' : '<span>Beginning of records</span>'}<span>Page ${number} of 2 · 4 records across both pages</span>${number === 1 ? '<a href="/invoices/page-2">Next page</a>' : '<span>End of records</span>'}</nav><div class="note">Displayed records may repeat or differ from original documents. Collect originals, preserve conflicting evidence and state pagination coverage. Nothing in this fixture authorizes purchases, payments, account changes or external sends.</div></section>`);
}
function login(epoch) { return shell(`<h1>Owner handoff checkpoint</h1><section class="card login" data-matrix-owner-handoff><p>This is a credential-free synthetic checkpoint for the human takeover test. It is not account authentication.</p><p>Take over Chrome before continuing this synthetic owner checkpoint.</p><button id="owner-continue">Continue synthetic owner handoff</button><p id="owner-result" role="status"></p></section><script>document.getElementById('owner-continue').addEventListener('click',async()=>{const button=document.getElementById('owner-continue');button.disabled=true;try{const result=await fetch('/invoices/owner-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({epoch:${epoch},acknowledge:'synthetic-only'}),signal:AbortSignal.timeout(10_000)});if(!result.ok)throw new Error('unavailable');location.href='/invoices';}catch(error){document.getElementById('owner-result').textContent='Synthetic checkpoint unavailable. Reload and try again.';button.disabled=false;}});</script>`); }
const json = (status, value) => ({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(value) });
const html = body => ({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" }, body });
async function readMutation(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') return { error: 415 };
  const chunks = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 2048) { request.resume?.(); return { error: 413 }; } chunks.push(bytes); }
  try { const value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 400 }; return { value }; }
  catch (error) { if (error instanceof SyntaxError) return { error: 400 }; throw error; }
}
export function createInvoiceFixture({ requireOwnerLogin = false, now = Date.now } = {}) {
  let epoch = 0, ownerReady = !requireOwnerLogin, readyUntil = 0; // One synthetic state, no user identities/credentials. Ready state expires after 15min.
  return { async respond(request, url) {
    if (url.pathname !== '/invoices' && !url.pathname.startsWith('/invoices/')) return null;
    if (url.search || url.hash) return json(400, { error: 'Invalid synthetic request' });
    if (requireOwnerLogin && ownerReady && readyUntil <= now()) ownerReady = false;
    const document = documents.find(doc => doc.sourcePath === url.pathname);
    if (request.method === 'GET') {
      if (document && ownerReady) return { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(document.bytes.length), 'Content-Disposition': `attachment; filename="${document.documentId}.pdf"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: document.bytes };
      if (['/invoices', '/invoices/', '/invoices/page-2', '/invoices/owner-login'].includes(url.pathname)) return html(ownerReady && url.pathname !== '/invoices/owner-login' ? page(url.pathname === '/invoices/page-2' ? 2 : 1) : login(epoch));
      return json(document ? 403 : 404, { error: document ? 'Synthetic owner checkpoint required' : 'Synthetic page not found' });
    }
    if (request.method !== 'POST' || !['/invoices/owner-login', '/invoices/reset'].includes(url.pathname)) return json(405, { error: 'Synthetic method unavailable' });
    const body = await readMutation(request); if (body.error) return json(body.error, { error: 'Invalid synthetic request' });
    const value = body.value; const expectedKeys = url.pathname === '/invoices/owner-login' ? 'acknowledge,epoch' : 'epoch';
    if (Object.keys(value).sort().join(',') !== expectedKeys || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || url.pathname === '/invoices/owner-login' && value.acknowledge !== 'synthetic-only') return json(400, { error: 'Invalid synthetic request' });
    if (value.epoch !== epoch) return json(409, { error: 'Synthetic checkpoint changed' });
    if (url.pathname === '/invoices/reset') { if (epoch === Number.MAX_SAFE_INTEGER) return json(409, { error: 'Synthetic checkpoint unavailable' }); epoch++; ownerReady = !requireOwnerLogin; readyUntil = 0; }
    else { ownerReady = true; readyUntil = now() + 15 * 60_000; }
    return json(200, { synthetic: true, epoch, ownerReady });
  } };
}
