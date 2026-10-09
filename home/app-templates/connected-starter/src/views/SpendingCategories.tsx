import { financeSummary, formatMoney } from "../model";
import type { OwnerRecord } from "../types";
export default function SpendingCategories({ records, currency }: { records: OwnerRecord[]; currency: string | undefined }) {
  const totals: Record<string, number> = Object.create(null);
  if (currency) for (const record of records) {
    // Use the same settlement/currency rules as the primary spending chart.
    const amount = financeSummary([record]).totals[currency];
    if (amount === undefined) continue;
    const category = String(record.fields.category || "Uncategorized");
    totals[category] = (Object.hasOwn(totals, category) ? totals[category] : 0) + amount;
  }
  const categories = Object.entries(totals).sort(([, a], [, b]) => b - a);
  const sum = categories.reduce((total, [, amount]) => total + amount, 0);
  return <section className="spending-categories" aria-label="Settled spending categories">
    <div className="section-heading"><h3>Where it goes</h3><span>{currency ? `${currency} · settled records` : "Add a paid receipt to see categories"}</span></div>
    <div className="category-breakdown">{categories.slice(0, 6).map(([category, amount]) => <div key={category} className="spending-category"><div><span>{category}</span><strong>{formatMoney(amount, currency!)}</strong></div><div className="category-track" aria-hidden="true"><i style={{ width: `${sum ? amount / sum * 100 : 0}%` }} /></div></div>)}</div>
    {categories.length > 6 && <p className="fine-print">Showing the six largest categories. All records remain in the ledger.</p>}
  </section>;
}
