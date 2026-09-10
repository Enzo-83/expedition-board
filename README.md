# Expedition Board

A drop-in scheduling board for the Kresthalis West Marches network. Players mark the weekly
windows they can play, GMs post expeditions, and anyone drags one of their characters onto an
open seat. A shared dispatch feed records every posting, seating and withdrawal; an overlap grid
shows the GM which windows the most players are free for.

Plain HTML, CSS and JavaScript — no build step. Hosted on GitHub Pages; live data via Firebase
(Spark / free tier). Until Firebase is configured the page runs as a local demo on sample data.

## Run it locally

Open `index.html` directly — it runs the local demo. To exercise the Firebase path you need a
real origin; any static server works:

```bash
npx --yes serve kresthalis-scheduler
```

## Where it lives

- Repository: <https://github.com/Enzo-83/expedition-board>
- Site: <https://enzo-83.github.io/expedition-board/> — served from the `main` branch root
  (Settings → Pages → Deploy from a branch → `main` / `/ (root)`).

Push to `main` and Pages rebuilds in about a minute. `.nojekyll` is included so Pages serves the
files as-is.

## Going live with Firebase

Everything below stays inside the free Spark plan. Its quotas (50k document reads, 20k writes a
day) are per Firebase project and unrelated to your Google One / Drive storage; a network of a
couple of dozen players will not get near them.

1. **Create a project** at <https://console.firebase.google.com> (Analytics can be off).
2. **Add a web app** (Project settings → General → Your apps → `</>`). Copy the `firebaseConfig`
   object it shows into `js/firebase-config.js`, replacing the `null`. These values are not
   secrets; the rules are what protect the data.
3. **Authentication** → Get started → Sign-in method → enable **Google**.
   Then Authentication → Settings → **Authorized domains** → add `<you>.github.io`.
4. **Firestore Database** → Create database → *production mode* → pick a region near your players.
5. Firestore → **Rules** → replace the contents with `firestore.rules` from this folder → Publish.
6. Firestore → **Data** → Start collection `allowlist`. For each player, add a document whose
   **Document ID is their Google e-mail address** (the fields can be empty, or `{ name: "…" }` for
   your own reference). Include yourself.
7. Push `js/firebase-config.js` and reload the site. The masthead shows **Live** once you are
   signed in; a first sign-in opens the profile dialog to name yourself and add characters.

A player who signs in without being on the allowlist sees a clear message naming the account,
so you know exactly which e-mail to add.

### What the free tier does not give you

Cloud Functions need the Blaze (pay-as-you-go) plan, so there is no server-side code here. That
rules out push notifications to a closed tab and Discord webhooks fired from the board itself.
What you do get:

- **Dispatches** — the shared feed on the page, with unread counts per player.
- **"For you" flags** — a dispatch is highlighted when it concerns you: a seat opening on an
  expedition you *Watch*, or a seat/expedition appearing in a window you are free for.
- **Browser alerts** — opt in per browser; fires a system notification for the same events
  while the tab is open (Firestore pushes changes live, no polling).

If you later want Discord pings, the cheapest route is a tiny relay that watches the
`dispatches` collection — a Blaze project with a $0 budget alert, or the GM-side relay you
already run for Foundry — posting each new dispatch to a webhook.

## How it is put together

| File | Role |
|---|---|
| `index.html` | Layout, dialogs, script order |
| `css/styles.css` | Editorial theme: parchment / charcoal / crimson, serif headings, system sans for data |
| `js/data.js` | Days, windows, shared rules (`KS.rules.eligibility`), sample data |
| `js/local-adapter.js` | `localStorage` adapter — single player, sample data |
| `js/firebase-adapter.js` | Firestore adapter (ES module, loads the SDK from Google's CDN) — boots the app |
| `js/firebase-config.js` | Your Firebase config, or `null` for the local demo |
| `js/app.js` | Rendering, drag-and-drop, tap-to-place, dialogs, alerts |
| `firestore.rules` | Security rules with the e-mail allowlist |

The UI only ever talks to an **adapter** with a small contract (documented at the top of
`local-adapter.js`); both adapters implement it. Seat changes in Firestore run as transactions
so two players racing for the last seat cannot both get it.

### Data model (Firestore)

- `players/{uid}` — `name, handle, discord, role, characters[{id,name,class,level}], availability["mon-eve", …], watching[sessionId], prefs, readAt`
- `sessions/{id}` — `title, region, gm, gmUid, date "YYYY-MM-DD", block, seats, minLevel, maxLevel, notes, party[{charId, uid, name, level, owner}], locked, postedAt`
- `dispatches/{id}` — `ts, kind (new|seat|open|full|avail), text, uid, sessionId?, date?, block?`
- `allowlist/{email}` — presence is what matters

### Rules the board enforces

A character can be seated only if the expedition is upcoming and unlocked, has an open seat,
takes the character's level, and the *player* is not already committed to another expedition in
the same date and window. Refusals show the reason and shake the row.

### Adjusting it

- Windows and their hours: `KS.BLOCKS` in `js/data.js`. Week start: `KS.DAYS`.
- Board name and the masthead overline: `index.html`.
- Sample content: `KS.sample()` in `js/data.js` (local demo only; never written to Firestore).
- Times are the viewer's local time, with the zone printed in the masthead. If the network
  spans time zones, agree a "board time" and say so in the overline.
