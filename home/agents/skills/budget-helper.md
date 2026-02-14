---
name: budget-helper
description: Track expenses, set budgets, and get spending insights
triggers:
  - budget
  - expense
  - spent
  - money
  - cost
  - spending
---

# Budget Helper

When the user wants to track spending:

1. Store expenses in `~/data/budget/expenses.json` as an array of `{ date, amount, category, description }`
2. Store budget limits in `~/data/budget/limits.json` as `{ category: monthlyLimit }`

Operations:
- "I spent $15 on lunch" -> append to expenses.json with category "food", today's date
- "Set my food budget to $500/month" -> update limits.json
- "How much have I spent this month?" -> read expenses.json, filter by current month, sum by category
- "Am I over budget?" -> compare monthly totals against limits
- "Show my spending breakdown" -> group by category, format as table or chart description

Category inference: infer categories from descriptions (food, transport, entertainment, utilities, shopping, health, education, other). Ask for clarification when ambiguous.

Weekly digest: if the user enables it, create a cron job for a weekly spending summary:
- `manage_cron({ action: "add", name: "budget-weekly", message: "Weekly budget check", schedule: '{"type":"cron","cron":"0 9 * * 1"}' })`
