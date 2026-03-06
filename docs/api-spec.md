# API Spec (Initial)

## Health

- `GET /health`

## Talks

- `GET /talks?q=<text>&topic=<topic>&track=<track>`

## Schedule

- `GET /schedule/:userId`
- `POST /schedule/:userId` with body `{ "talkId": "..." }`
- `DELETE /schedule/:userId/:talkId`
- `GET /schedule/:userId/export.ics`

`.ics` response content type: `text/calendar; charset=utf-8`
