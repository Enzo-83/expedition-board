/* Expedition Board — Google Calendar (GM only).

   Two directions, both driven by the short-lived OAuth token Firebase hands back from a consent
   popup. There is no refresh token, so everything here happens at the moment of a click.

   READ — "Sync from Google Calendar" pulls the GM's *busy* intervals from their primary calendar
   and blocks any window the usual week opens but the calendar has taken. Times only, never event
   titles: `freeBusy` returns no summaries, which matters because every allowlisted account can
   read every player document. Results go to `gcalBusy` on the player document, separate from
   hand-set `exceptions`, so a re-sync replaces them wholesale and manual choices always win.

   WRITE — with "Add expeditions I schedule" on, scheduling or posting an expedition creates an
   event in the GM's calendar, editing it moves the event, and cancelling deletes it. The event id
   lives on the session document. Writing is opt-in because it needs a wider scope than reading.

   A window the GM is running an expedition in is never blocked by a sync. `freeBusy` gives no
   event ids, so the sync cannot recognise the event it just wrote; it does not have to, because
   the board already knows which windows it scheduled.

   Setup, once, in the Google Cloud project behind Firebase:
     1. APIs & Services → Library → enable "Google Calendar API".
     2. Google Auth Platform → Audience → Publishing status "Testing", GM added under Test users. */
(function () {
  'use strict';
  const KS = window.KS, U = KS.util, R = KS.rules, BLOCKS = KS.BLOCKS;
  const $ = s => document.querySelector(s);
  const READ = ['https://www.googleapis.com/auth/calendar.readonly'];
  const WRITE = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];
  const API = 'https://www.googleapis.com/calendar/v3';
  let busyNow = false;

  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } };
  const pad = n => String(n).padStart(2, '0');
  const localISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  const compact = d => localISO(d).replace(/[-:]/g, '');
  const boardUrl = () => location.origin + location.pathname;
  const canWrite = () => { const S = KS.state(); return !!(S && S.me.prefs && S.me.prefs.gcalWrite); };

  const fmtWhen = ts => {
    const d = new Date(ts), today = U.todayKey();
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return U.keyOf(d) === today ? `today at ${time}` : `${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(d)}, ${time}`;
  };

  // The clock span a window occupies on a given date. `to` may be 25 — setHours rolls it over.
  function bounds(dateKey, b) {
    const s = U.parseKey(dateKey); s.setHours(b.from, 0, 0, 0);
    const e = U.parseKey(dateKey); e.setHours(b.to, 0, 0, 0);
    return [s, e];
  }

  // ---------------------------------------------------------------- panel
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
        <button type="button" class="btn btn--sm" data-action="gcal-sync"${local || busyNow ? ' disabled' : ''}>${busyNow ? 'Working…' : at ? 'Sync again' : 'Sync from Google Calendar'}</button>
        ${n ? '<button type="button" class="btn btn--sm btn--ghost" data-action="gcal-clear">Clear</button>' : ''}
      </div>
      ${n && !rows ? '<p class="hint hint--inline">Synced before minutes were recorded — sync again to see how much of each window is actually busy.</p>' : ''}
      ${rows && rows.length ? `<details class="gcal__break">
        <summary>How busy each blocked window is${light ? ` · ${light} under half` : ''}</summary>
        <ul>${rows.map(r => `<li class="${r.mins * 2 < r.of ? 'is-light' : ''}"><span>${U.esc(r.label)}</span><strong>${r.mins} <small>/ ${r.of} min</small></strong></li>`).join('')}</ul>
        <p class="hint hint--inline">Any overlap blocks the whole window. Rows near the top are barely busy — tell Claude if you want a threshold instead.</p>
      </details>` : ''}
      ${local ? '' : `<label class="gcal__write"><input type="checkbox" id="gcal-write"${canWrite() ? ' checked' : ''}> <span>Add expeditions I schedule to my calendar</span></label>`}
      <p class="hint hint--inline">${local
        ? 'Calendar sync runs on the live board, not this sample.'
        : 'Reads busy times only, never event titles. A window you are running an expedition in is never blocked.'}</p>`;
    const w = $('#gcal-write');
    if (w) w.addEventListener('change', onWriteToggle);
  };

  async function onWriteToggle(e) {
    const A = KS.adapter(), S = KS.state(), on = e.target.checked;
    const prefs = Object.assign({}, S.me.prefs || {}, { gcalWrite: on });
    try {
      // Ask for the wider scope up front rather than surprising them mid-schedule.
      if (on) await A.getCalendarToken(WRITE);
      await A.setPrefs(prefs);
      KS.toast(on ? 'Expeditions you schedule will be added to your calendar.' : 'The board will stop writing to your calendar. Events already there stay.', 'ok');
    } catch (err) {
      e.target.checked = false;
      KS.toast(err.message || 'Could not get permission to write to your calendar.', 'no');
    }
  }

  // ----------------------------------------------------------------- read
  function merge(ivs) {
    const sorted = ivs.slice().sort((a, b) => a[0] - b[0]), out = [];
    for (const iv of sorted) {
      const last = out[out.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else out.push([iv[0], iv[1]]);
    }
    return out;
  }

  KS.gcalSync = async function () {
    const A = KS.adapter(), S = KS.state();
    if (busyNow || !S || !KS.isGM()) return;
    if (!A.getCalendarToken) { KS.toast('Calendar sync runs on the live board, not the sample.', 'hint'); return; }
    busyNow = true; KS.renderGcal();
    try {
      const token = await A.getCalendarToken(canWrite() ? WRITE : READ);
      const dates = U.horizon();
      const timeMin = U.parseKey(dates[0]); timeMin.setHours(0, 0, 0, 0);
      const timeMax = U.parseKey(dates[dates.length - 1]); timeMax.setHours(0, 0, 0, 0); timeMax.setDate(timeMax.getDate() + 2);

      const res = await fetch(API + '/freeBusy', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: 'primary' }] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(explain(res.status, json));
      const cal = (json.calendars && json.calendars.primary) || {};
      if (cal.errors && cal.errors.length) throw new Error(`Google could not read that calendar (${cal.errors[0].reason}).`);

      const busy = merge((cal.busy || []).map(iv => [Date.parse(iv.start), Date.parse(iv.end)]).filter(iv => iv[0] && iv[1]));
      const me = S.me;
      // Windows this GM is already running in: the event the board wrote must not block them.
      const running = new Set(S.sessions
        .filter(x => R.isLive(x) && !R.isProposal(x) && x.gmUid === me.uid && x.date)
        .map(x => R.exKey(x.date, x.block)));
      const blocked = {};
      let count = 0, kept = 0;
      for (const date of dates) {
        for (const b of BLOCKS) {
          if (!R.inPattern(me, date, b.key)) continue;        // only ever blocks what the pattern opens
          const key = R.exKey(date, b.key);
          const [s, e] = bounds(date, b), lo = s.getTime(), hi = e.getTime();
          let mins = 0;
          for (const iv of busy) {
            const a = Math.max(iv[0], lo), z = Math.min(iv[1], hi);
            if (z > a) mins += (z - a) / 60000;
          }
          if (mins <= 0) continue;
          if (running.has(key)) { kept++; continue; }
          blocked[key] = Math.round(mins); count++;
        }
      }
      await A.setCalendarBusy(blocked, Date.now());
      KS.toast((count
        ? `Calendar synced — ${count} window${count === 1 ? '' : 's'} blocked over the next ${KS.HORIZON_WEEKS} weeks.`
        : 'Calendar synced — nothing in it clashes with the windows you can run.')
        + (kept ? ` ${kept} left open because you are running an expedition then.` : ''), 'ok');
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

  // ---------------------------------------------------------------- write
  function eventBody(sess) {
    const b = U.blockOf(sess.block), [s, e] = bounds(sess.date, b), zone = tz();
    const party = (sess.party || []).map(p => `${p.name} (${p.level})`).join(', ');
    const lines = [
      `GM ${sess.gm} · levels ${sess.minLevel}–${sess.maxLevel} · ${sess.seats} seats`,
      party ? `Party: ${party}` : 'No one seated yet.',
      sess.notes || '',
      '',
      `Roster and changes: ${boardUrl()}`,
    ].filter(l => l !== null);
    return {
      summary: sess.title,
      location: sess.region || '',
      description: lines.join('\n'),
      start: Object.assign({ dateTime: localISO(s) }, zone ? { timeZone: zone } : {}),
      end: Object.assign({ dateTime: localISO(e) }, zone ? { timeZone: zone } : {}),
      source: { title: 'Expedition Board', url: boardUrl() },
    };
  }

  async function call(method, path, token, body) {
    const res = await fetch(API + path, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return {};
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(explain(res.status, json));
    return json;
  }

  // Create or move the calendar event for one expedition. Never throws into the caller's flow:
  // the board is the roster of record and a calendar hiccup must not undo a scheduling.
  KS.gcalPushEvent = async function (sess) {
    const A = KS.adapter(), S = KS.state();
    if (!S || !KS.isGM() || !canWrite() || !A.getCalendarToken) return;
    if (!sess || !sess.date || sess.gmUid !== S.me.uid) return;
    try {
      const token = await A.getCalendarToken(WRITE);
      const body = eventBody(sess);
      let ev;
      if (sess.gcalEventId) {
        try { ev = await call('PATCH', `/calendars/primary/events/${encodeURIComponent(sess.gcalEventId)}`, token, body); }
        catch (err) { ev = null; }                          // deleted in Calendar — fall through and make a new one
      }
      if (!ev) ev = await call('POST', '/calendars/primary/events', token, body);
      if (ev && ev.id && ev.id !== sess.gcalEventId) await A.setCalendarEvent(sess.id, ev.id);
      KS.toast(`“${sess.title}” is in your Google Calendar.`, 'ok');
    } catch (err) {
      KS.toast(`On the board, but not in your calendar: ${err.message || 'the write failed'}.`, 'no');
    }
  };

  KS.gcalDropEvent = async function (sess) {
    const A = KS.adapter(), S = KS.state();
    if (!S || !KS.isGM() || !A.getCalendarToken) return;
    if (!sess || !sess.gcalEventId || sess.gmUid !== S.me.uid) return;
    try {
      const token = await A.getCalendarToken(WRITE);
      await call('DELETE', `/calendars/primary/events/${encodeURIComponent(sess.gcalEventId)}`, token);
      await A.setCalendarEvent(sess.id, null);
      KS.toast('Removed from your Google Calendar too.', 'ok');
    } catch (err) {
      KS.toast(`Cancelled on the board. Remove it from your calendar by hand — ${err.message || 'the delete failed'}.`, 'no');
    }
  };

  // A pre-filled Google Calendar "new event" page. No auth, no scopes, any account — this is
  // what players get, since only the GM is an OAuth test user on the Cloud project.
  KS.gcalTemplateUrl = function (sess) {
    const b = U.blockOf(sess.block), [s, e] = bounds(sess.date, b), zone = tz();
    const party = (sess.party || []).map(p => p.name).join(', ');
    const details = [`GM ${sess.gm} · levels ${sess.minLevel}–${sess.maxLevel}`, party ? `Party: ${party}` : '', sess.notes || '', '', boardUrl()].filter(Boolean).join('\n');
    const q = new URLSearchParams({ action: 'TEMPLATE', text: sess.title, dates: `${compact(s)}/${compact(e)}`, details, location: sess.region || '' });
    if (zone) q.set('ctz', zone);
    return 'https://calendar.google.com/calendar/render?' + q.toString();
  };

  // app.js may have rendered once already (the file:// demo boots before this script loads).
  if (KS.state && KS.state()) KS.renderGcal();

  function explain(code, json) {
    const msg = (json && json.error && json.error.message) || '';
    if (code === 403 && /has not been used|is disabled|not enabled/i.test(msg)) {
      return 'The Google Calendar API is not enabled for this project yet — turn it on in the Cloud console (APIs & Services → Library → Google Calendar API), wait a minute, then try again.';
    }
    if (code === 403 && /insufficient|scope/i.test(msg)) return 'That token cannot write to your calendar — tick the calendar permission on the consent screen.';
    if (code === 403) return `Google refused the request: ${msg || 'access denied'}.`;
    if (code === 401) return 'Google would not accept that token. Sign out of the board, sign back in, and try again.';
    if (code === 404 || code === 410) return 'That event is no longer in your calendar.';
    return msg ? `Google Calendar: ${msg}` : `Google Calendar returned ${code}.`;
  }
})();
