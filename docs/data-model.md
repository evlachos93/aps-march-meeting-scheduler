# Data Model (MVP)

## Talk

- `id`: string (stable source ID)
- `title`: string
- `abstract`: string
- `speakers`: string[]
- `track`: string (`INVITED`, `FOCUS`, `ORAL`, `POSTER`)
- `topics`: string[] (lowercase topic tags, e.g. `"error correction"`)
- `room`: string
- `startTime`: ISO-8601 with timezone offset
- `endTime`: ISO-8601 with timezone offset
- `sourceUrl?`: string (link to the APS talk page)

## Session

- `sessionCode`: string (e.g. `MAR-B07`)
- `title`: string
- `url`: string (link to the APS session page)
- `sessionType`: string (`INVITED`, `FOCUS`, `ORAL`, `POSTER`)
- `talkTitles`: string[]
- `date?`: string (YYYY-MM-DD)
- `weekday?`: string
- `startTime?`: ISO-8601 with timezone offset
- `endTime?`: ISO-8601 with timezone offset
- `timeRange`: string (human-readable, e.g. `12:00 PM-2:36 PM`)
- `room?`: string
- `timingSource`: `"talks"` | `"none"`

## User schedule entry

- `talkId`: string
- `addedAt`: ISO timestamp

## UI topics config (`data/ui-topics.json`)

Array of objects that controls which topics appear in the web app's **Filter by topic** dropdown.
Edit this file to add, remove, or rename entries — no code change required.

Each entry:
- `label`: string — display name shown in the dropdown
- `value`: string — must exactly match a topic string from `Talk.topics` (lowercase, as it appears in `data/talks.json`)

Example:
```json
[
  { "label": "Error correction", "value": "error correction" },
  { "label": "Quantum computing", "value": "quantum computing" }
]
```

## Calendar integration

- Baseline: export per-user schedule as `.ics`.
- Future: provider adapters for direct event creation.
