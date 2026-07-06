# Queue — personal TV episode tracker (PWA)

A TVTime-style tracker: search shows, mark episodes as you watch, and see what's up next. Vanilla HTML/JS, no build step, deploys to GitHub Pages exactly like the Aces site.

## Get running (about 10 minutes)

**1. Get a TMDB API key (free)**
- Create an account at https://www.themoviedb.org
- Go to Settings → API → request a key ("Developer" / personal use)
- Either the short **API Key (v3)** or the long **API Read Access Token** works — the app detects which one you pasted

**2. Deploy to GitHub Pages**
- New repo (e.g. `queue`), push these files to the root
- Repo Settings → Pages → deploy from `main` branch, root folder
- Your app is at `https://<username>.github.io/queue/`

**3. Install on your iPhone**
- Open the URL in **Safari** (must be Safari for install)
- Share button → **Add to Home Screen**
- Open from the home screen icon — it runs full-screen like a native app

**4. First run**
- Settings tab → paste your TMDB key → **Test** → **Save key**
- Search tab → add a show → it appears in Up Next

## How it works

| Piece | What it does |
|---|---|
| `index.html` | App shell — top bar, view container, bottom tab bar |
| `app.js` | Everything: storage layer, TMDB client, router, four views |
| `styles.css` | Design system (dark slate / marquee amber / Barlow Condensed) |
| `manifest.json` + `sw.js` | PWA install + offline app shell |

**Data model** (localStorage, key `queue.v1`):
```json
{
  "settings": { "tmdbKey": "..." },
  "shows": {
    "1396": {
      "id": 1396, "name": "Breaking Bad", "poster": "/...",
      "status": "watching",
      "watched": { "s1e1": 1720000000000, "s1e2": 1720000001000 },
      "cache": { "fetchedAt": 1720000000000, "episodes": [ ... ] }
    }
  }
}
```

Watched episodes are stored as `sXeY` keys with a timestamp (so watch-date stats are possible later). Episode lists are cached per show for 24 hours; the refresh button in the top bar force-refreshes everything (that's how new episodes of airing shows appear).

**Features in this starter:**
- Up Next feed sorted by most-behind, split into *Ready to watch* / *Coming up*
- One-tap "Watched ✓" on the next episode
- Poster grid with unwatched-count badges, filters (Watching / Plan / Finished)
- Show detail: per-episode checkboxes, mark/clear season, "I'm caught up" (marks all aired), future episodes shown dimmed with air dates
- Auto-status: a show flips to Finished when every aired episode is watched and the series has ended
- Export/import JSON backup in Settings

## Moving to Firebase later

Everything reads/writes through the `Store` object at the top of `app.js` (`load`, `save`, `exportJSON`, `importJSON`). To sync across devices or support multiple users:

1. Add Firebase Auth (same pattern as the Aces site)
2. Reimplement `Store.load`/`Store.save` against a Firestore doc like `users/{uid}/data`
3. The JSON export in Settings is your migration path — export from localStorage, write it to Firestore once

One caution for the localStorage phase: iOS can evict Safari website data if the site goes unused for weeks, though installed PWAs are much more protected. Export a backup occasionally until Firebase sync exists.

## Notes

- TMDB is free for personal, non-commercial use. If this ever becomes a public app, TMDB requires attribution ("This product uses the TMDB API but is not endorsed or certified by TMDB") and a commercial license conversation.
- Specials (Season 0) are intentionally excluded.
- The service worker caches poster images as you browse, so the app stays snappy offline; episode *data* always requires a connection.
- To ship an update, bump `VERSION` in `sw.js` so installed clients pick up new files.
