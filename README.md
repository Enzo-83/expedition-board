# Expedition Board

A drop-in scheduling board for the Kresthalis West Marches network, built the West Marches way:
**players propose, GMs schedule.**

- A **player** marks the weekly windows they can play — plus overrides on specific dates —
  keeps a roster of characters, proposes an expedition (title, destination, notes — their
  character goes on it first) and joins other people's proposals or GM-posted expeditions by
  dragging a character onto a seat.
- A **GM** (flagged on the allowlist, never self-declared) marks the windows they can run, posts
  dated expeditions, schedules a proposal into the window where everyone joined is free (the
  dialog is pre-filled with that date, seat count and level band), locks rosters, cancels, and
  can take anyone off a roster.

A shared dispatch feed records every proposal, posting, scheduling, seating and withdrawal. The
overlap grid runs over real dates a week at a time, dims everything no GM can run, and a
**party picker** narrows it to a chosen set of characters — ringed cells are dates where all of
their players are free, with one click to request an expedition there or (for a GM) post one.

## Availability

Availability resolves in three layers, most specific first:

1. **Date overrides** — set by hand on the *Specific dates* tab; always win. Marked with a dot.
2. **Google Calendar busy times** — only if the GM has synced (see below); blocks, never opens.
   Marked with a hatch.
3. **The usual week** — the *Usual week* tab, the baseline.

Clicking a date cell flips that date's answer. If the new answer is what the layers below
already say, the override is dropped rather than stored, so overrides never pile up. Overrides
for past dates are pruned on every write.

### Expeditions in your calendar

**GM.** Tick **Add expeditions I schedule to my calendar** in the Calendar panel. Posting or
scheduling an expedition then creates an event in your primary calendar; **Edit** moves it;
**Cancel** deletes it. The event id is kept on the session document, so the board can find its
own event later. Ticking the box asks for a wider scope (`calendar.events` alongside
`calendar.readonly`) rather than springing a consent popup on you mid-schedule.

The board is the roster of record, so a calendar failure never undoes a scheduling — the
expedition is posted either way and a toast says the calendar write did not land.

**Players** get a **+ Calendar** link on expeditions they are seated on, which opens a
pre-filled Google Calendar event page. No auth, no scopes, no setup — which is the point, since
only the GM is an OAuth test user on the Cloud project.

**The loop this would otherwise create:** the board writes "The Salt Stair, Thursday 18:00–22:00"
into your calendar; the next sync reads it back through `freeBusy` and blocks the Thursday
evening you are running it in. `freeBusy` returns no event ids, so the sync cannot recognise its
own event — but it does not need to. **A window you are running a scheduled expedition in is
never blocked by a sync**, whatever put the busy time there.

### Google Calendar sync (GM)

The *Specific dates* tab shows a **Sync from Google Calendar** button for GM accounts. It reads
the primary calendar's `freeBusy` — busy intervals only, never event titles, which matters
because every allowlisted account can read every player document — and blocks any window the
usual week opens but the calendar shows as taken. Any overlap counts, however short.

It is a button, not background sync: Firebase hands back a short-lived access token and does not
refresh it, so you re-consent roughly once an hour. Results live in `gcalBusy`, separate from
hand-set overrides, so **Sync again** replaces them wholesale and never clobbers a date you set
deliberately; **Clear** drops them all.

One-time setup in the Google Cloud project behind Firebase:

1. **APIs & Services → Library** → enable **Google Calendar API**.
2. **Google Auth Platform → Audience** (this was "APIs & Services → OAuth consent screen" before
   Google reorganised it). Check **Publishing status**: it must say **Testing** — if it says *In
   production*, click **Back to testing**, because an unverified app in production is blocked
   outright when it asks for a sensitive scope instead of showing a warning you can click past.
   Then under **Test users** → **+ ADD USERS**, add the GM's Google account.

Nothing needs adding under *Data Access*; scopes do not have to be registered while the app is
in Testing.

Calendar is a sensitive scope, so the first sync shows a "Google hasn't verified this app"
screen — click **Advanced → Go to … (unsafe)**. The permissions screen that follows has a
**checkbox** for calendar access that has to be ticked; without it Google returns a token
without the scope and the board says so. Only accounts added as test users can grant it;
players never see any of this, since the button is GM-only.

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

Push to `main` and Pages rebuilds in about a minute (browsers may cache the old files for up to
ten more; Ctrl+Shift+R forces a refresh). `.nojekyll` is included so Pages serves the files as-is.

Add `?demo` to the URL — <https://enzo-83.github.io/expedition-board/?demo> — to open the board
on sample data in the local mode, with no sign-in and nothing shared: handy for showing a new
player the flow without touching real seats. `?demo=gm` does the same from the GM's side.

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
   your own reference). Include yourself, and give every GM's entry a boolean field **`gm: true`**
   — that flag is what unlocks the GM view and the GM-only writes in the rules.
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
| `js/data.js` | Days, windows, shared rules (`KS.rules.freeOn`, `KS.rules.eligibility`), sample data |
| `js/local-adapter.js` | `localStorage` adapter — single player, sample data |
| `js/firebase-adapter.js` | Firestore adapter (ES module, loads the SDK from Google's CDN) — boots the app |
| `js/firebase-config.js` | Your Firebase config, or `null` for the local demo |
| `js/app.js` | Rendering, drag-and-drop, tap-to-place, dialogs, alerts |
| `js/gcal.js` | Google Calendar sync (GM only) |
| `firestore.rules` | Security rules with the e-mail allowlist |

The UI only ever talks to an **adapter** with a small contract (documented at the top of
`local-adapter.js`); both adapters implement it. Seat changes in Firestore run as transactions
so two players racing for the last seat cannot both get it.

### Data model (Firestore)

- `players/{uid}` — `name, handle, discord, role, characters[{id,name,class,level}], availability["mon-eve", …], exceptions{"2026-09-17-eve": false}, gcalBusy["2026-09-17-eve", …], gcalSyncedAt, watching[sessionId], prefs, readAt`
- `sessions/{id}` — `status (proposed|scheduled|cancelled), title, region, notes, party[{charId, uid, name, level, owner}], locked, postedAt`;
  proposals add `proposerUid, proposer`; scheduled ones add `gm, gmUid, date "YYYY-MM-DD", block, seats, minLevel, maxLevel`, and `gcalEventId` once the GM's calendar holds it
- `dispatches/{id}` — `ts, kind (proposal|new|scheduled|cancelled|lock|seat|open|full|avail|request|note), text, uid, sessionId?, date?, block?, party?[uid]`
- `allowlist/{email}` — presence admits the account; `gm: true` makes it a GM
- `config/board` — `gmUids[]`, written by GMs on sign-in so every client can dim the grid outside their windows

### Rules the board enforces

A proposal has no date, seat cap or level band — any player can join it with one character. A
character can be seated on a scheduled expedition only if it is upcoming and unlocked, has an
open seat, takes the character's level, and the *player* is not already committed to another
expedition in the same date and window. One seat per player per expedition. Refusals show the
reason and shake the row. Only GMs can post dated expeditions, schedule, lock, cancel, or remove
someone; a proposer can withdraw their own proposal while it is still waiting.

### Adjusting it

- Windows and their hours: `KS.BLOCKS` in `js/data.js` (the `from`/`to` hours are what Calendar
  sync compares busy intervals against). Week start: `KS.DAYS`. How far ahead the date views
  run: `KS.HORIZON_WEEKS`.
- Board name and the masthead overline: `index.html`.
- Sample content: `KS.sample()` in `js/data.js` (local demo only; never written to Firestore).
- Times are the viewer's local time, with the zone printed in the masthead. If the network
  spans time zones, agree a "board time" and say so in the overline.
