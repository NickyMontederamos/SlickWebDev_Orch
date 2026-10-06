# SlickWebDev_Orch

Two interactive maps of the SlickLab TCC operating model, plus the database schema one of them describes.

Each map is a single HTML file with no build step and no outside requests. They are reference diagrams: nothing on these pages runs an agent, sends a message or changes a system.

| File | What it shows |
|------|---------------|
| `index.html` | Landing page that links to both maps |
| `slicklab_tcc_orchestration_corrected.html` | **SlickLab TCC.** The agency lifecycle in 18 steps, from market selection to the learning loop, with the four human approval gates |
| `TCC_HyperInteractive_Integrated_Infrastructure.html` | **TCC HyperNexus.** The control plane: 11 components, a catalog of 20 connectors with safety defaults, the infrastructure stack and the schema |
| `sql/TCC_Integrated_Nexus_Schema.sql` | PostgreSQL 16 + pgvector schema. The HyperNexus page shows, copies and downloads exactly this file |

## Which map to use

| | SlickLab TCC | TCC HyperNexus |
|---|---|---|
| Question it answers | How does a client move from lead to recurring work, and where must a person approve? | What keeps agents inside approved limits, and where is the evidence kept? |
| Best for | Running or explaining an agentic service agency | Designing the control plane underneath it |
| Data | None. The steps are written into the page | A tested schema: four schemas, ten tables, an append-only audit ledger |
| Controls | Pan, zoom and pinch; filter by type or lifecycle phase; search; step-by-step simulation; command palette (Ctrl/⌘ K); focus mode | Four views (map, catalog, stack, SQL); one search across all of them; dry-run flow; latching Emergency Stop |
| Measure it is built around | MRR ÷ Hours: verified recurring revenue per human hour | External writes disabled unless approved |

Use SlickLab TCC to explain or run the business process. Use HyperNexus when deciding how the system underneath is governed.

## What the schema does and does not do

Checked by `tests/sql/`:

- Applies cleanly, and can be applied again without error.
- `nexus_audit.action_ledger` refuses `UPDATE`, `DELETE` and `TRUNCATE`.
- New connectors start in quarantine with writes off. `aoc.v_connector_risk` reports `BLOCK`, `READ_ONLY` or `APPROVAL_REQUIRED`.
- Status, classification and decision columns accept only their listed values.
- Cosine search over 768-dimension embeddings works and can use the HNSW index.
- A document whose chunk has been cited as retrieval evidence cannot be deleted.

Not included, and needed before real data goes in:

- **No roles, grants or row-level security.** The four schemas separate names, not access. Tenant columns are not enforced.
- The append-only triggers can be disabled by the role that owns the table. Run the application as a different role.
- `evidence_hash` is stored but not chained to the previous row, so the ledger is tamper-resistant, not tamper-evident.
- Primary keys are UUIDs with no default; the caller supplies them.
- `rimcp.revenue_events` allows repeats when `external_ref` is empty.

## Tests

```bash
npm install            # one dev dependency: puppeteer-core
npm test               # static + browser + SQL
```

| Command | Needs | Covers |
|---------|-------|--------|
| `npm run test:static` | Node 20+ | Pages load nothing from other hosts; the SQL in the page matches the file; scripts parse |
| `npm run test:browser` | Google Chrome (`CHROME_PATH` to override) | Every control on all three pages at desktop and phone sizes, including touch drag and pinch; layout at 12 screen sizes from 320 to 1920 pixels wide; the notice shown when JavaScript is off |
| `npm run test:sql` | Docker | Applies the schema twice to a throwaway in-memory database with no network, then runs the checks above. It takes no connection settings, so it cannot touch a real database |

Set `SHOTS_DIR=some/folder` on the browser run to save screenshots.

Checked by hand on 2026-10-06, outside the suite: axe-core 4.14.0 finds no WCAG 2.2 A or AA violations in 14 page states, and Firefox 155 passes the core controls on both maps. Safari has not been tested.

## Deploying

The pages are static. Copy `index.html` and the two map files to any web host; that is the whole site. `sql/`, `tests/`, `package.json` and `node_modules/` are not needed on the server, because the HyperNexus page carries the schema inside it. Many servers refuse to serve `.sql` files, so nothing links to that file.

The HyperNexus page opens on a chosen view with `#map`, `#catalog`, `#stack` or `#sql` at the end of its address.

On GitHub Pages: Settings → Pages → deploy from the `main` branch, root folder.

The pages use inline script and style and nothing else, so they run under a strict policy:

```
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'
```

Serve over HTTPS. The Copy button on the SQL view needs it; without it the page selects the text and asks the reader to press Ctrl+C.

## Editing

- Lifecycle steps: the `data` array in `slicklab_tcc_orchestration_corrected.html`. Each row is name, description, state, authority, responsibilities, type, x, y. Phase boundaries are in `phases` directly below.
- Components, links and catalog: `nodes`, `edges` and `catalog` in `TCC_HyperInteractive_Integrated_Infrastructure.html`.
- Schema: edit `sql/TCC_Integrated_Nexus_Schema.sql`, then paste the same text into the `schema-sql` block of the HyperNexus page. `npm run test:static` fails if the two differ.
