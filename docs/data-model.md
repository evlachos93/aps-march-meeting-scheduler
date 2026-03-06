# Data Model (MVP)

## Talk

- `id`: string (stable source ID)
- `title`: string
- `abstract`: string
- `speakers`: string[]
- `track`: string
- `topics`: string[]
- `room`: string
- `startTime`: ISO-8601 with timezone offset
- `endTime`: ISO-8601 with timezone offset

## User schedule entry

- `userId`: string
- `talkId`: string
- `addedAt`: ISO timestamp

## Calendar integration

- Baseline: export per-user schedule as `.ics`.
- Future: provider adapters for direct event creation.
