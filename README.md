# APS Talk Scheduler

Lightweight tool for planning APS March Meeting 2026 attendance.

## Apps

- `apps/scraper`: generates talk/session data files from APS sources
- `apps/api`: serves talks, schedules, and calendar export (`.ics`)
- `apps/web`: mobile-first web UI for searching and building your schedule

## Quick start

1. Install dependencies:

```bash
npm install
```

1. (Optional) Generate your own talk/session data with the scraper.

Talk list:

```bash
npm --workspace @aps/scraper run build
npm --workspace @aps/scraper run start
```

Sessions list based on `data/session-preferences.txt`:

```bash
npm run generate:sessions
```

Generated files are written to:

- `data/talks.json`
- `data/sessions.json`

1. Start the API server:

```bash
npm run dev:api
```

1. Start the web app:

```bash
npm run dev:web
```

1. Open the web app URL shown by Vite (usually `http://localhost:5173`).

The web app reads data from the API, and the API serves local data files from `data/`.
If your generated file names are the defaults above, they are ready to use with no extra step.

## How data flows into the web app

1. `apps/scraper` fetches APS content and writes JSON files under `data/`.
2. `apps/api` loads `data/sessions.json` and `data/talks.json` and exposes endpoints for the UI.
3. `apps/web` calls the API and lets you search, filter, and add talks to your schedule.

In short: run scraper -> start API -> open web app.

## Using the web app

1. Use search and filters to find talks/sessions.
2. Click `Add to My Schedule` on talks you want.
3. Export `.ics` to import into your calendar.

## Common commands

Stop the API server (Linux/macOS/Windows):

```bash
npm run stop:api
```

If API startup fails with `EADDRINUSE`:

```bash
npm run stop:api
```

Use a different API port:

```bash
PORT=8788 npm run dev:api
```

Point web to a non-default API:

```bash
VITE_API_BASE=http://localhost:8787 npm run dev:web
```

## Scraper options

Talk scraping:

- `SCRAPER_MAX_EVENTS`: max number of schedule events to scan.
- `SCRAPER_EVENT_TYPES`: comma-separated event types (`INVITED,FOCUS`), labels (`Invited Session,Focus Session`), or `ALL`.
- `SCRAPER_MEETING_PREFIX`: optional prefix filter for event codes.
- `SCRAPER_OUTPUT_FILE`: output path (default: `data/talks.generated.json`).
- `SCHEDULE_TIME_ZONE`: timezone for formatted times (default: `America/Denver`).

Session generation:

- `SCRAPER_EVENT_TYPES`: session types to include (codes, labels, or `ALL`).
- `SCRAPER_MAX_EVENTS`: max events for APS metadata fallback mode.
- `SESSIONS_SKIP_EVENT_INDEX=1`: skip APS event-index fallback and use local talks data only.
- `SCRAPER_OUTPUT_FILE`: output path (default: `data/sessions.json`).
- `SCRAPER_CONCURRENCY`: concurrent APS HTTP requests for scraper/enrichment (default: `10`).
- `SCHEDULE_TIME_ZONE`: timezone for formatted times (default: `America/Denver`).

Example:

```bash
SCRAPER_EVENT_TYPES=INVITED,FOCUS SCRAPER_MAX_EVENTS=500 npm run generate:sessions
```

`data/session-preferences.txt` can use natural language and explicit tags:

```txt
I want to focus on quantum hardware and trapped ions.
tags: qec, superconducting qubits, quantum control
preferredphrases: fault tolerance, logical qubit
architectures: trapped ions, superconducting qubits, neutral atoms
```

## Session filtering stages

`npm run generate:sessions` applies filtering in ordered stages:

1. Candidate discovery

- Primary source: APS event index + event metadata.
- Fallback source: local `data/talks.json` if event-index discovery fails.

1. Session scoring

- Scores each candidate session using `data/session-preferences.txt` preferred/avoid phrases.
- This stage ranks candidates; hard pruning happens later.

1. Enrichment + hard QC filtering

- Fetches presentation titles for each surviving session.
- Drops sessions whose session title matches avoid phrases.
- Drops sessions with no talk titles.
- Drops sessions where no talk title matches preferred phrases.

1. Optional final-pass LLM relevance filter

- Runs after enrichment as the last filtering stage.
- Runs only when `SESSIONS_LLM_FILTER=1`.
- Runs only when both `SESSIONS_LLM_API_URL` and `SESSIONS_LLM_API_KEY` are set.
- If URL/key are missing, the generator logs: `LLM filter skipped: API key/url not set; skipping llm filtering`.

1. Output

- Writes final sessions to `data/sessions.json`.

## LLM filtering configuration

There are two practical ways to use an LLM pass:

### A) Automated API mode (fully scripted)

Set these env vars in `.env`:

- `SESSIONS_LLM_FILTER=1`
- `SESSIONS_LLM_API_URL=<openai-compatible-chat-completions-endpoint>`
- `SESSIONS_LLM_API_KEY=<api-key-for-that-endpoint>`
- `SESSIONS_LLM_MODEL=gpt-4o-mini` (optional override)
- `SESSIONS_LLM_BATCH_SIZE=20` (optional override)

Important:

- No default LLM endpoint/key is assumed.
- Standard GitHub PATs from Developer Settings are not accepted by the Copilot chat-completions endpoint.

### B) Copilot Chat mode (recommended for Copilot Business users)

If automated API credentials are unavailable or rate-limited:

1. Run `npm run generate:sessions` with LLM filter disabled or skipped.
2. Open `data/sessions.json` in VS Code.
3. Ask Copilot Chat to filter sessions in-chat by relevance to your quantum interests.
4. Save the filtered output (for example by replacing `data/sessions.json` with the kept set).

This is often the most convenient path for teams already using Copilot Business inside VS Code.

## Extra generators

Generate a weekly schedule JSON from preferences:

```bash
npm run generate:schedule
```

Output: `data/schedule.generated.json`.

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
