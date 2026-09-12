/* Expedition Board — Google Calendar sync (GM only).

   Reads the signed-in GM's *busy* intervals from their primary Google Calendar and blocks any
   window the usual week opens but the calendar says is taken. It never opens a window the
   pattern closes, and never reads event titles — the freeBusy endpoint returns times only,
   which matters because every allowlisted account can read every player document.

   Results are stored in `gcalBusy` on the player document, separate from hand-set
   `exceptions`, so a re-sync replaces them wholesale and manual choices always win.

   Setup, once, in the Google Cloud project behind Firebase:
     1. APIs & Services → Library → enable "Google Calendar API".
     2. APIs & Services → OAuth consent screen → add your account under Test users.
   Firebase hands back a short-lived access token and never refreshes it, so this is a
   button you press, not background sync. */
(function () {
  'use strict';
  const KS = window.KS, U = KS.util, R = KS.rules, BLOCKS = KS.BLOCKS;
  const $ = s => document.querySelector(s);
  const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
  let busyNow = false;

  const fmtWhen = ts => {
    const d = new Date(ts), today = U.todayKey();
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return U.keyOf(d) === today ? `today at ${time}` : `${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(d)}, ${time}`;
  };

  // Every blocked window, least-busy first — the ones at the top are the windows a short
  // appointment has taken whole, which is what you look at to judge the rule.
  function breakdown(me) {
    const g = me.gcalBusy;
    if (!g || Array.isArray(g)) return null;              // the first sync format carried no minutes
    const rows = Object.keys(g).map(k => {
      const date = k.slice(0, 10), block = k.slice(11), b = U.blockOf(block);
      return { date, block, label: `${new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(U.parseKey(date))} ${b.short}`, mins: g[k] | 0, of: U.blockMins(b) };
    }).filter(r => r.date >= U.todayKey());
    rows.sort((a, b) => (a.mins / a.of) - (b.mins / b.of) || (a.date < b.date ? -1 : 1));
    return rows;
  }

  KS.renderGcal = function () {
    const el = $('#gcal'); if (!el) return;
    const S = KS.state();
    if (!S || !KS.isGM()) { el.innerHTML = ''; return; }
    const me = S.me, g = me.gcalBusy, at = me.gcalSyncedAt;
    const n = !g ? 0 : Array.isArray(g) ? g.length : Object.keys(g).length;
    const local = !KS.adapter().getCalendarToken;
    const rows = breakdown(me);
    const light = rows ? rows.filter(r => r.mins * 2 < r.of).length : 0;
    el.innerHTML = `
      <div class="gcal__head">
        <span class="label">Google Calendar</span>
        <span class="gcal__state${n ? ' gcal__state--on' : ''}">${local ? 'Live board only'
          : at ? `${n} window${n === 1 ? '' : 's'} blocked · synced ${U.esc(fmtWhen(at))}`
          : 'Not synced'}</span>
      </div>
      <div class="row">
        <button type="button" class="btn btn--sm" data-action="gcal-sync"${local || busyNow ? ' disabled' : ''}>${busyNow ? 'Syncing…' : at ? 'Sync again' : 'Sync from Google Calendar'}</button>
        ${n ? '<button type="button" class="btn btn--sm btn--ghost" data-action="gcal-clear">Clear</button>' : ''}
      </div>
      ${n && !rows ? '<p class="hint hint--inline">Synced before minutes were recorded — sync again to see how much of each window is actually busy.</p>' : ''}
      ${rows && rows.length ? `<details class="gcal__break">
        <summary>How busy each blocked window is${light ? ` · ${light} under half` : ''}</summary>
        <ul>${rows.map(r => `<li class="${r.mins * 2 < r.of ? 'is-light' : ''}"><span>${U.esc(r.label)}</span><strong>${r.mins} <small>/ ${r.of} min</small></strong></li>`).join('')}</ul>
        <p class="hint hint--inline">Any overlap blocks the whole window. Rows near the top are barely busy — tell Claude if you want a threshold instead.</p>
      </details>` : ''}
      <p class="hint hint--inline">${local
        ? 'Calendar sync runs on the live board, not this sample.'
        : 'Blocks windows your calendar shows as busy. Reads times only, never event titles, and never opens a window your usual week closes.'}</p>`;
  };

  function merge(ivs) {
    const sorted = ivs.slice().sort((a, b) => a[0] - b[0]), out = [];
    for (const iv of sorted) {
      const last = out[out.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else out.push([iv[0], iv[1]]);
    }
    return out;
  }

  // Busy intervals overlapping a window block it — any overlap, however short.
  function blockBounds(dateKey, b) {
    const s = U.parseKey(dateKey); s.setHours(b.from, 0, 0, 0);
    const e = U.parseKey(dateKey); e.setHours(b.to, 0, 0, 0);   // `to` may be 25 — rolls to the next day
    return [s.getTime(), e.getTime()];
  }

  KS.gcalSync = async function () {
    const A = KS.adapter(), S = KS.state();
    if (busyNow || !S || !KS.isGM()) return;
    if (!A.getCalendarToken) { KS.toast('Calendar sync runs on the live board, not the sample.', 'hint'); return; }
    busyNow = true; KS.renderGcal();
    try {
      const token = await A.getCalendarToken(SCOPE);
      const dates = U.horizon();
      const timeMin = U.parseKey(dates[0]); timeMin.setHours(0, 0, 0, 0);
      const timeMax = U.parseKey(dates[dates.length - 1]); timeMax.setHours(0, 0, 0, 0); timeMax.setDate(timeMax.getDate() + 2);

      const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: 'primary' }] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(explain(res.status, json));
      const cal = (json.calendars && json.calendars.primary) || {};
      if (cal.errors && cal.errors.length) throw new Error(`Google could not read that calendar (${cal.errors[0].reason}).`);

      // Merge before measuring: two overlapping busy events must not count their minutes twice.
      const busy = merge((cal.busy || []).map(iv => [Date.parse(iv.start), Date.parse(iv.end)]).filter(iv => iv[0] && iv[1]));
      const me = S.me, blocked = {};
      let count = 0;
      for (const date of dates) {
        for (const b of BLOCKS) {
          if (!R.inPattern(me, date, b.key)) continue;        // only ever blocks what the pattern opens
          const [s, e] = blockBounds(date, b);
          let mins = 0;
          for (const iv of busy) {
            const lo = Math.max(iv[0], s), hi = Math.min(iv[1], e);
            if (hi > lo) mins += (hi - lo) / 60000;
          }
          if (mins > 0) { blocked[R.exKey(date, b.key)] = Math.round(mins); count++; }
        }
      }
      await A.setCalendarBusy(blocked, Date.now());
      KS.toast(count
        ? `Calendar synced — ${count} window${count === 1 ? '' : 's'} blocked over the next ${KS.HORIZON_WEEKS} weeks.`
        : 'Calendar synced — nothing in it clashes with the windows you can run.', 'ok');
      if (KS.refreshAvail) KS.refreshAvail();
    } catch (err) {
      KS.toast(err.message || 'Calendar sync failed.', 'no');
    } finally {
      busyNow = false; KS.renderGcal();
    }
  };

  KS.gcalClear = async function () {
    const A = KS.adapter();
    try {
      await A.setCalendarBusy({}, null);
      KS.toast('Calendar blocks cleared — your usual week and any date overrides still apply.', 'ok');
      if (KS.refreshAvail) KS.refreshAvail();
    } catch (err) { KS.toast(err.message || 'Could not clear.', 'no'); }
  };

  // app.js may have rendered once already (the file:// demo boots before this script loads).
  if (KS.state && KS.state()) KS.renderGcal();

  function explain(code, json) {
    const msg = (json && json.error && json.error.message) || '';
    if (code === 403 && /has not been used|is disabled|not enabled/i.test(msg)) {
      return 'The Google Calendar API is not enabled for this project yet — turn it on in the Cloud console (APIs & Services → Library → Google Calendar API), wait a minute, then sync again.';
    }
    if (code === 403) return `Google refused the request: ${msg || 'access denied'}.`;
    if (code === 401) return 'Google would not accept that token. Sign out of the board, sign back in, and sync again.';
    return msg ? `Google Calendar: ${msg}` : `Google Calendar returned ${code}.`;
  }
})();
