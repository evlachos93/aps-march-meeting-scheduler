# API Spec (Initial)

## Health

- `GET /health`

## Talks

- `GET /talks?q=<text>&topic=<topic>&track=<track>&sortBy=<time|title|track>`

## Sessions

- `GET /sessions?q=<text>&sessionType=<type>&sortBy=<time|title|code|talk-count>`

## Topics

- `GET /topics` — returns the list of filterable topics configured in `data/ui-topics.json`

Response shape:
```json
{
  "topics": [
    { "label": "Error correction", "value": "error correction" }
  ]
}
```

## Schedule

- `GET /schedule/:userId`
- `POST /schedule/:userId` with body `{ "talkId": "..." }`
- `DELETE /schedule/:userId/:talkId`
- `GET /schedule/:userId/export.ics`

`.ics` response content type: `text/calendar; charset=utf-8`
