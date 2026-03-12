# API Spec (Initial)

## Health

- `GET /health` → `{ ok: true, service: "aps-api" }`

## Talks

- `GET /talks?q=<text>&topic=<topic>&track=<track>&sortBy=<time|title|track|weekday>`
  - `weekday`: orders talks by the day of the week (Sunday=0) and then by start time
  - `q`: full-text search across title, abstract, and speakers
  - `topic`: exact match against a `Talk.topics` entry (lowercase)
  - `track`: exact match against `Talk.track` (e.g. `INVITED`, `FOCUS`, `ORAL`, `POSTER`)
  - `sortBy`: `time` (default), `title`, `track`, or `weekday`
  - `day`: optional filter; accepts `sunday`-`saturday` or the first three letters (case insensitive)
  - → `{ talks: Talk[] }`

## Sessions

- `GET /sessions?q=<text>&sessionType=<type>&sortBy=<time|title|code|talk-count|weekday>`
  - `weekday`: orders sessions by their weekday (UTC) and then by start time (falls back to session code alphabetical)
  - `q`: full-text search across session code, title, type, room, and talk titles
  - `sessionType`: exact match against `Session.sessionType`
  - `sortBy`: `time` (default), `title`, `code`, `talk-count`, or `weekday`
  - `day`: optional filter; matches the session weekday inferred from `startTime` or `weekday` metadata
  - → `{ sessions: Session[] }`

## Topics

- `GET /topics` — returns the list of filterable topics configured in `data/ui-topics.json`
  - → `{ topics: { label: string; value: string }[] }`

## Schedule

- `GET /schedule/:userId` → `{ talks: Talk[] }`
- `POST /schedule/:userId` with body `{ "talkId": "..." }` → `{ talkId, addedAt }`
- `DELETE /schedule/:userId/:talkId` → `204 No Content`
- `GET /schedule/:userId/export.ics` → `text/calendar; charset=utf-8`
