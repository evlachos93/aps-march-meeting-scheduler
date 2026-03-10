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
