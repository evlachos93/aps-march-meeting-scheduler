# APS Talk Scheduler

Lightweight internal tool for planning APS March Meeting 2026 attendance.

## Apps

- `apps/api`: REST API for talks, schedules, and calendar export (`.ics`)
- `apps/web`: mobile-first web UI (installable PWA foundation)
- `apps/scraper`: APS ingestion pipeline scaffold

## Setup

1. Install dependencies.

```bash
npm install
```

2. Start the API server.

```bash
npm run dev:api
```

To stop the API server (cross-platform, including Linux/macOS/Windows):

```bash
npm run stop:api
```

3. Start the web UI and point it at the API if necessary.

```bash
npm run dev:web
```

By default the API listens on `http://localhost:8787`, and the web client uses that origin, but you can override it when you start the web server:

```bash
VITE_API_BASE=http://localhost:8787 npm run dev:web
```

If API startup fails with `EADDRINUSE` (port already in use), run:

```bash
npm run stop:api
```

Then start it again, or use a different API port:

```bash
PORT=8788 npm run dev:api
```

The API currently serves the mock talk list in `data/talks.sample.json`, so anyone can explore the interface without running the scraper.

## Simple guide

1. With the API and web servers running, open the web UI in your browser (it is mobile-first and installable).
2. Use the search box and topic filter to find talks you care about.
3. Click “Add to My Schedule” to mark talks you want to attend.
4. When you’re ready, hit the “Export .ics” button to download a calendar you can import into any planner.
5. Repeat search/save steps as you refine your plan (no coding needed).

## Scraper

Run the APS scraper and write results to `data/talks.generated.json`:

```bash
npm --workspace @aps/scraper run build
npm --workspace @aps/scraper run start
```

Useful env vars:

- `SCRAPER_MAX_EVENTS`: max number of schedule events to scan.
- `SCRAPER_MEETING_PREFIX`: defaults to `MAR-` to keep March Meeting data.
- `SCHEDULE_TIME_ZONE`: timezone used when formatting generated times (default: `America/Denver`).

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
- `SCHEDULE_TIME_ZONE`: timezone used when formatting session times (default: `America/Denver`).

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
- `SCHEDULE_TIME_ZONE`: timezone used when rendering table time ranges (default: `America/Denver`).

Notes:

- The generator enriches session rows with time/room from APS event metadata when available.
- If event metadata is unavailable, it falls back to `data/talks.generated.json`.
- If time metadata is still missing, weekday is inferred from session-code patterns so Monday-Friday columns remain populated.
- Each exported session row includes a saved time field (`timeRange` and, when known, `startTime`/`endTime` in the JSON companion file).
- Columns are fixed to Monday-Friday and non-Mon-Fri sessions are excluded.
- The generator prints a warning if sessions collapse into a single weekday column (usually indicates incomplete source scrape coverage).
