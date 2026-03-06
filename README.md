# APS Talk Scheduler

Lightweight internal tool for planning APS March Meeting 2026 attendance.

## Apps

- `apps/api`: REST API for talks, schedules, and calendar export (`.ics`)
- `apps/web`: mobile-first web UI (installable PWA foundation)
- `apps/scraper`: APS ingestion pipeline scaffold

## Quick start

```bash
npm install
npm run dev:api
npm run dev:web
```

API defaults to `http://localhost:8787`.

## Scraper

Run the APS scraper and write results to `data/talks.generated.json`:

```bash
npm --workspace @aps/scraper run build
npm --workspace @aps/scraper run start
```

Useful env vars:

- `SCRAPER_MAX_EVENTS`: max number of schedule events to scan.
- `SCRAPER_MEETING_PREFIX`: defaults to `MAR-` to keep March Meeting data.

## Weekly schedule generation

Describe topic preferences in natural language in `data/session-preferences.txt`, then generate a schedule from `data/talks.generated.json`:

```bash
npm run generate:schedule
```

Output is written to `data/schedule.generated.json`.

Generate the full list of interesting sessions (no per-day cap and no conflict pruning):

```bash
npm run generate:sessions
```

Equivalent workspace commands:

```bash
npm --workspace @aps/scraper run build
npm --workspace @aps/scraper run sessions
```

Note: `@aps/scraper:sessions` is not a valid workspace name. Use `@aps/scraper` as the workspace, then run the `sessions` script.

This command queries `https://summit.aps.org/schedule/` using your preferred-topic phrases.
Output is written to `data/sessions.generated.json`.

Useful env vars for session generation:

- `SESSIONS_EVENT_TYPES`: comma-separated session types to include first (default: `INVITED,FOCUS,ORAL`).
- `SESSIONS_MAX_EVENTS`: max events to scan in APS metadata fallback mode.
- `SESSIONS_SKIP_EVENT_INDEX=1`: skip APS event-index and remote event metadata fallback, and rely only on `data/talks.generated.json`.

Example (invited + focus only):

```bash
SESSIONS_EVENT_TYPES=INVITED,FOCUS npm run generate:sessions
```

## Confluence week table generation

Build a Monday-Friday table from `data/sessions.generated.json` and write outputs under `data/`:

```bash
npm run generate:sessions-table
```

Outputs:

- `data/sessions.week-table.generated.html` (Confluence-friendly HTML table)
- `data/sessions.week-table.generated.json` (debug/summary companion data)

Optional format selection via env var:

- `SESSIONS_TABLE_FORMAT=html` (default)
- `SESSIONS_TABLE_FORMAT=confluence` -> writes `data/sessions.week-table.generated.confluence.txt`
- `SESSIONS_TABLE_FORMAT=both` -> writes both HTML and Confluence markup files

Notes:

- The generator enriches session rows with time/room from APS event metadata when available.
- If event metadata is unavailable, it falls back to `data/talks.generated.json`.
- If time metadata is still missing, weekday is inferred from session-code patterns so Monday-Friday columns remain populated.
- Each exported session row includes a saved time field (`timeRange` and, when known, `startTime`/`endTime` in the JSON companion file).
- Columns are fixed to Monday-Friday and non-Mon-Fri sessions are excluded.
- The generator prints a warning if sessions collapse into a single weekday column (usually indicates incomplete source scrape coverage).
