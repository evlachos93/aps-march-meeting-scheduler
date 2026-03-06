# Architecture (MVP)

- Phone-first PWA frontend for internal users.
- Lightweight API service for talks, user schedules, and calendar export.
- Scraper service to ingest APS meeting data into storage.
- Initial implementation uses in-memory schedule storage and sample talk data to unblock parallel frontend work.

## Runtime components

1. `web` app: browse talks, save schedule, export `.ics`.
2. `api` app: query/filter talks, mutate per-user schedules, produce calendar files.
3. `scraper` app: fetch APS pages and normalize data into canonical talk schema.

## Next milestone

- Replace in-memory schedules with managed Postgres.
- Restrict access to company users.
- Add scheduled scraper job and failure alerting.
