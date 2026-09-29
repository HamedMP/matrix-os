# Public Free Tools for Matrix OS

**Status:** Implementation target
**Date:** 2026-09-29
**Owner:** Matrix OS public website (`FinnaAI/matrix-os-site`)

## Goal

Offer 45 useful tools at `matrix-os.com/tools` without a Matrix account, payment card, or provisioned computer. Each tool must complete its advertised task in the browser, use Matrix's existing brand system, and have a useful, indexable page. The free result must remain usable without signup. A contextual link may explain what a paid Matrix computer adds: persistent files, agents, connected services, and scheduled work.

## Product boundaries

- Public tools are stateless. Input and output remain in the visitor's browser; they are not sent to Matrix, logged, or stored in platform Postgres. Users can copy or download results.
- Tool pages live in the website repository, not behind the app shell's billing or computer gate. No free computer is provisioned.
- Browser work stops when the tab closes. The page must not imply background execution or durable cloud storage.
- The first release requires no server-side URL fetch, third-party AI inference, file upload, or paid API. URL analysis uses pasted HTML. A future URL-fetch route requires a separate security review.
- A Matrix account without a computer is a later product surface; it must not be simulated with a paid shell bypass or owner data stored in a shared platform database.

## Tool inventory

| Category | Tools |
|---|---|
| Developer (17) | JSON formatter, JSON validator, JSON minifier, JSON to CSV, CSV to JSON, Base64 encoder, Base64 decoder, URL encoder, URL decoder, HTML encoder, HTML decoder, hash generator, UUID generator, regex tester, text diff, timestamp converter, color converter |
| Writing and data (13) | Word counter, character counter, readability checker, case converter, slug generator, text cleaner, line sorter, duplicate line remover, find and replace, Markdown preview, HTML to text, lorem ipsum generator, keyword density checker |
| SEO and marketing (11) | Meta tag generator, robots.txt generator, sitemap XML generator, canonical URL generator, hreflang generator, UTM builder, title length checker, meta description checker, social card tag generator, JSON-LD generator, pasted HTML SEO audit |
| Agent development (4) | AGENTS.md structure checker, MCP configuration validator, approximate prompt token estimator, cron expression explainer |

These are 45 distinct tasks with different input contracts and outputs. Shared engines and UI primitives are encouraged; pages must not be empty aliases or route variants that only change keywords.

## Required experience

1. `/tools` has searchable category navigation and clear browser-only/privacy copy. Every tool is reachable from the hub in two clicks or fewer.
2. `/tools/[slug]` has a working form, example input, result, copy/download action where applicable, task-specific instructions, limitations, and related tools. It uses the shared Matrix site header, footer, fonts, colors, and brand primitives.
3. The result is generated without signup. Empty, malformed, oversized, and unsupported inputs produce specific safe feedback. Text inputs are capped; regex evaluation is isolated and time-bounded.
4. Each tool has a unique title, description, canonical URL, H1, and page content. Only implemented, useful pages enter the sitemap. Pages must not promise rankings or imply every SEO warning is a ranking factor.
5. Structured output is escaped before display. Downloads use local Blob URLs and revoke them. No input content enters analytics events.
6. The tool page offers a relevant Matrix continuation only after the tool works, such as running an agent on a repository or keeping a workflow on a computer. The offer must accurately describe paid computer requirements.

## Security and privacy

| Route | Auth | Input boundary | Data flow |
|---|---|---|---|
| `GET /tools` | Public | None | Server-rendered catalog HTML and client assets |
| `GET /tools/[slug]` | Public | Strict slug allowlist | Server-rendered tool HTML and client assets |
| Tool execution | None | Client-side length, file type, and output caps | Browser memory only |

No new mutating endpoint, database table, server fetch, shared file store, or AI inference is in scope. Browser operations must cap memory, terminate costly work, and avoid rendering input as trusted HTML. Security tests must cover XSS-like strings, malformed JSON/CSV, invalid URLs, large input, and regex timeouts. The route wiring test must verify that every catalog slug resolves to a rendered page and sitemap entry.

## SEO and measurement

- Publish the working tool and a short, original explanation together. No location or query-variant doorway pages. Use Google Search Console to check impressions, clicks, indexing, and query fit after launch.
- Record only page view, tool start, tool success/error class, result copy/download, related-tool navigation, and Matrix continuation clicks. Never record user input or output.
- Evaluate on qualified tool completion and continuation, not raw organic sessions alone. Revisit titles/content from Search Console evidence rather than manufacturing additional pages.
- The site repository must include public documentation under `content/docs/` in a separate documentation PR, covering privacy, browser limitations, and the difference between free tools and a hosted Matrix computer.

## Delivery and verification

1. Research and inventory: Reddit demand signals, free-tool libraries, and Ahrefs keyword evidence, with country/date/range and missing-data caveats in `research.md`.
2. Tests first for tool algorithms, input limits, metadata/slug uniqueness, sitemap wiring, and essential tool journeys.
3. Implement the catalog, tool UI, 45 engines, metadata, sitemap, and Matrix-branded hub in the site repository.
4. Run focused tests, typecheck, production site build, and browser checks of representative developer, writing, SEO, and agent tools on desktop and mobile widths.
5. Open separate PRs for this Matrix spec, site implementation, and site documentation. PRs need the standard invariants section and Greptile 5/5 before merge.

## Success criteria

- All 45 listed tools return a meaningful correct result for a representative valid input and a safe error for invalid input.
- All 45 pages are crawlable with unique metadata and appear in the sitemap; no unimplemented page is indexed.
- A new visitor can use a tool on a phone or desktop browser without billing or a computer.
- No user-provided content leaves the browser during tool execution.
- The site retains the Matrix brand and does not imply that free tools include a Matrix computer.
