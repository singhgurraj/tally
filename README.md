# Tally

A minimal counter app. Create named counters, tap +/- to change them, and view each
counter's full tap history. No build step, no backend — everything lives in the
browser's `localStorage`.

## Features

- Create and delete named counters (delete requires a confirmation step)
- Increment/decrement each counter from the home list or its detail view
- Per-counter detail view (`#/counter/<id>`) showing a full timestamped log of
  every tap
- State persists in `localStorage` and survives reloads; malformed or missing
  storage is handled gracefully with an on-screen warning if writes ever fail

## Running it

No build tools required — just serve the folder statically:

```bash
python3 -m http.server 8842
```

Then open `http://localhost:8842`.

## Files

- `index.html` — markup for the home list and the counter detail view
- `style.css` — styling (light/dark aware via `prefers-color-scheme`)
- `app.js` — app state, hash-based routing between views, and all event handling

## Data model

Counters are stored under the `tally.counters` key as a JSON array:

```json
[
  {
    "id": "uuid",
    "name": "Pushups",
    "count": 3,
    "history": [{ "delta": 1, "at": 1699999999999 }]
  }
]
```
