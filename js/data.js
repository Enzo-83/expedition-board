/* Expedition Board — constants, shared rules, sample data.
   Loaded first; everything hangs off window.KS. Nothing here touches the DOM or storage. */
window.KS = window.KS || {};
(function (KS) {
  'use strict';

  // Week starts Monday. Windows are the blocks a player can mark themselves free for.
  KS.DAYS = [
    { key: 'mon', short: 'M', label: 'Monday' },
    { key: 'tue', short: 'T', label: 'Tuesday' },
    { key: 'wed', short: 'W', label: 'Wednesday' },
    { key: 'thu', short: 'T', label: 'Thursday' },
    { key: 'fri', short: 'F', label: 'Friday' },
    { key: 'sat', short: 'S', label: 'Saturday' },
    { key: 'sun', short: 'S', label: 'Sunday' },
  ];
  KS.BLOCKS = [
    { key: 'morn', label: 'Morning',   short: 'Morn', time: '09:00–12:00', from: 9,  to: 12 },
    { key: 'aft',  label: 'Afternoon', short: 'Aft',  time: '13:00–17:00', from: 13, to: 17 },
    { key: 'eve',  label: 'Evening',   short: 'Eve',  time: '18:00–22:00', from: 18, to: 22 },
    { key: 'late', label: 'Late',      short: 'Late', time: '22:00–01:00', from: 22, to: 25 },
  ];
  KS.DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // Date#getDay order
  KS.HORIZON_WEEKS = 8;   // how far ahead the date views go

  const pad = n => String(n).padStart(2, '0');
  const U = KS.util = {
    pad,
    keyOf: d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    parseKey: k => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d); },
    todayKey: () => U.keyOf(new Date()),
    weekdayOf: dateKey => KS.DAY_KEYS[U.parseKey(dateKey).getDay()],
    slotOf: sess => U.weekdayOf(sess.date) + '-' + sess.block,
    blockOf: key => KS.BLOCKS.find(b => b.key === key) || { key, label: key, short: key, time: '' },
    dayOf: key => KS.DAYS.find(d => d.key === key) || { key, short: '?', label: key },
    blockIndex: key => KS.BLOCKS.findIndex(b => b.key === key),
    blockMins: b => ((typeof b === 'string' ? U.blockOf(b) : b).to - (typeof b === 'string' ? U.blockOf(b) : b).from) * 60,
    esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    initials: name => String(name || '?').split(/[\s.\-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?',
    uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    sortSessions: list => list.slice().sort((a, b) => a.date === b.date
      ? U.blockIndex(a.block) - U.blockIndex(b.block)
      : (a.date < b.date ? -1 : 1)),
    // --- dates -------------------------------------------------------------
    addDays: (key, n) => { const d = U.parseKey(key); d.setDate(d.getDate() + n); return U.keyOf(d); },
    mondayKeyOf: d => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return U.keyOf(x); },
    thisMonday: () => U.mondayKeyOf(new Date()),
    weekOf: mondayKey => KS.DAYS.map((_, i) => U.addDays(mondayKey, i)),
    // Every date from today to the end of the horizon, in order.
    horizon: () => {
      const out = [], today = U.todayKey(), end = U.addDays(U.thisMonday(), KS.HORIZON_WEEKS * 7 - 1);
      for (let k = today; k <= end; k = U.addDays(k, 1)) out.push(k);
      return out;
    },
  };

  // Rules shared by the UI and by both adapters (the Firestore adapter re-runs them
  // inside a transaction against the fresh document, so two players can't take one seat).
  //
  // Availability resolves in three layers, most specific first:
  //   1. `exceptions`  { "2026-09-17-eve": false } — set by hand, always wins
  //   2. `gcalBusy`    ["2026-09-17-eve", …]      — written by a Google Calendar sync, blocks only
  //   3. `availability` ["mon-eve", …]            — the usual week, the baseline
  // Keeping the sync results in their own field means a re-sync can replace them wholesale
  // without touching a date the player set deliberately.
  //
  // A session is either a *proposal* (player-made: no date, no seat cap, no level band —
  // it waits for a GM) or *scheduled* (GM-made or GM-scheduled from a proposal), or
  // *cancelled*. Documents written before statuses existed count as scheduled.
  const R = KS.rules = {
    exKey: (dateKey, block) => `${dateKey}-${block}`,
    inPattern: (p, dateKey, block) => (p.availability || []).includes(U.weekdayOf(dateKey) + '-' + block),
    overridden: (p, dateKey, block) => !!(p.exceptions && Object.prototype.hasOwnProperty.call(p.exceptions, R.exKey(dateKey, block))),
    // Minutes of the window the calendar shows as busy: null when it is not blocked at all,
    // otherwise the count. `gcalBusy` is a {key: minutes} map; the first version of the sync
    // wrote a plain array of keys, and those resolve to 0 — blocked, duration unrecorded.
    calendarBusyMins(p, dateKey, block) {
      const g = p && p.gcalBusy, k = R.exKey(dateKey, block);
      if (!g) return null;
      if (Array.isArray(g)) return g.indexOf(k) >= 0 ? 0 : null;
      return Object.prototype.hasOwnProperty.call(g, k) ? (g[k] | 0) : null;
    },
    calendarBusy: (p, dateKey, block) => R.calendarBusyMins(p, dateKey, block) !== null,
    // What the answer would be with no hand-set override — the layers under `exceptions`.
    baseline: (p, dateKey, block) => R.calendarBusy(p, dateKey, block) ? false : R.inPattern(p, dateKey, block),
    freeOn(p, dateKey, block) {
      if (!p || !dateKey) return false;
      if (R.overridden(p, dateKey, block)) return !!p.exceptions[R.exKey(dateKey, block)];
      return R.baseline(p, dateKey, block);
    },
    // Exceptions for dates already past are dead weight; drop them whenever we write.
    pruneExceptions(ex) {
      const today = U.todayKey(), out = {};
      for (const k of Object.keys(ex || {})) if (k.slice(0, 10) >= today) out[k] = ex[k];
      return out;
    },

    statusOf: s => s.status || (s.date ? 'scheduled' : 'proposed'),
    isProposal: s => R.statusOf(s) === 'proposed',
    isLive: s => R.statusOf(s) !== 'cancelled',
    openSeats: s => R.isProposal(s) ? Infinity : Math.max(0, (s.seats | 0) - (s.party || []).length),
    isPast: s => !R.isProposal(s) && s.date < U.todayKey(),
    fits: (me, s) => !!me && !R.isProposal(s) && R.freeOn(me, s.date, s.block),
    myEntry: (me, s) => (s.party || []).find(e => e.uid === me.uid) || null,
    eligibility(state, sess, ch, opts = {}) {
      const no = reason => ({ ok: false, reason });
      const me = state.me;
      if (!ch) return no('Pick one of your characters first.');
      if (!R.isLive(sess)) return no('This expedition was cancelled.');
      const already = (sess.party || []).find(e => e.uid === me.uid);
      if (already) return no(already.charId === ch.id ? `${ch.name} is already seated here.` : `You already have ${already.name} on this expedition — one seat per player.`);
      if (R.isProposal(sess)) return { ok: true, reason: '' };   // nothing else to check until a GM schedules it
      if (R.isPast(sess)) return no('This expedition has already departed.');
      if (sess.locked) return no('The roster is locked.');
      if (R.openSeats(sess) <= 0) return no('No open seats.');
      if (ch.level < sess.minLevel || ch.level > sess.maxLevel) return no(`${ch.name} is level ${ch.level}; this expedition takes levels ${sess.minLevel}–${sess.maxLevel}.`);
      const clash = state.sessions.find(o => o.id !== sess.id && o.id !== opts.ignoreSessId && R.isLive(o) && !R.isProposal(o)
        && o.date === sess.date && o.block === sess.block && (o.party || []).some(e => e.uid === me.uid));
      if (clash) return no(`You're already committed to “${clash.title}” in that window.`);
      return { ok: true, reason: '' };
    },
  };

  // ---------------------------------------------------------------------------
  // Sample data for the local demo. Dates are generated relative to today so the
  // board never opens onto a stale week. Every name and level here is placeholder.
  // opts.gm = true signs the demo user in as the GM instead of a player.
  KS.sample = function (opts) {
    const asGM = !!(opts && opts.gm);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const next = (dow, week = 0) => {           // next occurrence of a weekday, strictly after today
      const d = new Date(today);
      let diff = (dow - d.getDay() + 7) % 7; if (diff === 0) diff = 7;
      d.setDate(d.getDate() + diff + week * 7);
      return U.keyOf(d);
    };
    const H = 3600e3, now = Date.now();

    const P = (uid, name, availability, characters, exceptions) => ({ uid, name, availability, characters, exceptions: exceptions || {} });
    const players = [
      P('p-wen',     'Wen',     ['mon-eve', 'tue-eve', 'wed-eve', 'thu-eve', 'thu-late', 'sat-eve', 'sat-late', 'sun-aft', 'sun-eve'],
        [{ id: 'p-wen-1', name: 'Thordak Runehammer', level: 4 }, { id: 'p-wen-2', name: 'Thalen Whiskerdust', level: 2 }],
        { [`${next(3, 1)}-aft`]: true }),                       // took a Wednesday afternoon off work
      P('p-marek',   'Marek',   ['thu-eve', 'fri-eve', 'fri-late', 'sat-aft', 'sat-eve', 'sat-late', 'sun-aft'],
        [{ id: 'p-marek-1', name: 'Elethil Lief Shadren', level: 4 }]),
      P('p-priya',   'Priya',   ['mon-eve', 'thu-eve', 'sat-morn', 'sat-aft', 'sat-eve', 'sun-morn', 'sun-aft', 'sun-eve'],
        [{ id: 'p-priya-1', name: 'Ithris', level: 4 }, { id: 'p-priya-2', name: 'Eber Talbot', level: 1 }]),
      P('p-dunn',    'Dunn',    ['tue-eve', 'wed-eve', 'fri-eve', 'fri-late', 'sat-eve', 'sat-late', 'sun-eve'],
        [{ id: 'p-dunn-1', name: 'Squint', level: 2 }, { id: 'p-dunn-2', name: 'Sunder', level: 3 }]),
      P('p-ola',     'Ola',     ['mon-aft', 'wed-aft', 'fri-aft', 'fri-eve', 'fri-late', 'sat-aft', 'sat-eve', 'sun-aft'],
        [{ id: 'p-ola-1', name: 'Peder Bystrom', level: 2 }]),
      P('p-halvard', 'Halvard', ['tue-morn', 'thu-morn', 'thu-eve', 'sat-eve', 'sun-aft', 'sun-eve'],
        [{ id: 'p-halvard-1', name: 'Gaius', level: 3 }, { id: 'p-halvard-2', name: 'John', level: 1 }]),
      P('p-cass',    'Cass',    ['mon-eve', 'tue-eve', 'wed-eve', 'thu-eve', 'sat-aft', 'sat-eve', 'sun-eve'],
        [{ id: 'p-cass-1', name: 'M.A.K.E.R.', level: 3 }]),
      P('p-tess',    'Tess',    ['thu-eve', 'fri-eve', 'sat-morn', 'sat-aft', 'sat-eve', 'sun-aft'],
        [{ id: 'p-tess-1', name: 'Taerik Altavin', level: 5 }, { id: 'p-tess-2', name: 'Elias Finch', level: 5 }, { id: 'p-tess-3', name: 'Dínen von Spreller', level: 4 }],
        { [`${next(6, 1)}-eve`]: false, [`${next(6, 1)}-aft`]: false }),   // away that Saturday
      // GMs are players too, with windows but no characters; the board dims everything outside their windows.
      Object.assign(P('gm-imre', 'Imre', ['tue-eve', 'sat-morn', 'sat-aft', 'sun-morn', 'sun-aft'], []), { gm: true }),
    ];
    if (!asGM) players.push(Object.assign(P('gm-dahl', 'Dahl', ['thu-eve', 'thu-late', 'fri-eve', 'sat-eve', 'sat-late', 'sun-aft', 'sun-eve'], []), { gm: true }));
    const seat = (uid, idx) => {
      const p = players.find(x => x.uid === uid), c = p.characters[idx];
      return { charId: c.id, uid, name: c.name, level: c.level, owner: p.name };
    };

    const me = asGM
      ? { uid: 'local', name: 'Rowan Ashby', handle: 'rowan', discord: 'rowan_a', role: 'GM', gm: true, characters: [],
          availability: ['thu-eve', 'thu-late', 'fri-eve', 'sat-eve', 'sat-late', 'sun-aft', 'sun-eve'],
          exceptions: { [`${next(4)}-eve`]: false },            // one Thursday you can't run
          watching: [], prefs: { alertOnOpenSeat: false, browserAlerts: false }, readAt: now - 3 * H }
      : { uid: 'local', name: 'Rowan Ashby', handle: 'rowan', discord: 'rowan_a', role: 'Player', gm: false,
          characters: [
            { id: 'c1', name: 'Oriel Vance', class: 'Fighter', level: 5 },
            { id: 'c2', name: 'Maud Pellinger', class: 'Cleric', level: 3 },
            { id: 'c3', name: 'Wick', class: 'Rogue', level: 1 },
          ],
          availability: ['mon-eve', 'tue-eve', 'thu-eve', 'thu-late', 'sat-aft', 'sat-eve', 'sat-late', 'sun-aft', 'sun-eve'],
          exceptions: { [`${next(6)}-eve`]: false },            // away this coming Saturday evening
          watching: ['s2'], prefs: { alertOnOpenSeat: true, browserAlerts: false }, readAt: now - 3 * H };
    const mine = idx => { const c = me.characters[idx]; return { charId: c.id, uid: 'local', name: c.name, level: c.level, owner: me.name }; };
    const gmUids = players.filter(p => p.gm).map(p => p.uid).concat(asGM ? ['local'] : []);
    const dahl = asGM ? { gm: 'Rowan Ashby', gmUid: 'local' } : { gm: 'Dahl', gmUid: 'gm-dahl' };
    const imre = { gm: 'Imre', gmUid: 'gm-imre' };

    const S = (id, o) => Object.assign({ id, party: [], locked: false, status: 'scheduled', postedAt: now - 48 * H }, dahl, o);
    const sessions = [
      S('s1', { title: 'The Salt Stair', region: 'Frost-Pelt Trail, north', date: next(4), block: 'eve', seats: 5, minLevel: 3, maxLevel: 6,
        notes: 'Two days out and back along the trail. Bring cold-weather kit; the roster locks the evening before.',
        party: [seat('p-wen', 0), seat('p-marek', 0), seat('p-priya', 0)] }),
      S('s2', { title: 'Farmbelt Ring — Night Watch', region: 'Farmbelt Ring Road', date: next(5), block: 'late', seats: 4, minLevel: 1, maxLevel: 3,
        notes: 'A short, local job for newer characters. Something has been taking lambs.',
        party: [seat('p-dunn', 0), seat('p-ola', 0), seat('p-priya', 1), seat('p-halvard', 1)] }),
      S('s3', Object.assign({ title: 'Tupperwine Ford Survey', region: 'The Tupperwine', date: next(6), block: 'aft', seats: 5, minLevel: 1, maxLevel: 4,
        notes: 'Mapping the crossings after the spring flood. Low danger, high mud.',
        party: [seat('p-wen', 1)] }, imre)),
      S('s4', { title: 'Dwarven Trade Road — Toll House', region: 'Dwarven Trade Road', date: next(6), block: 'eve', seats: 5, minLevel: 2, maxLevel: 5,
        notes: 'The toll house has not answered the last two caravans.',
        party: asGM ? [seat('p-halvard', 0), seat('p-dunn', 1), seat('p-cass', 0)] : [seat('p-halvard', 0), seat('p-dunn', 1), seat('p-cass', 0), mine(1)] }),
      S('s5', Object.assign({ title: 'Crag-Leaper Ascent', region: 'Crag-Leaper Trail', date: next(0), block: 'aft', seats: 4, minLevel: 4, maxLevel: 6,
        notes: 'Experienced characters only. Climbing gear provided by the temple.',
        party: [seat('p-tess', 0), seat('p-marek', 0), seat('p-priya', 0)] }, imre)),
      S('s6', Object.assign({ title: 'Kwanqobile — Registry Errand', region: 'Kwanqobile, the city', date: next(2, 1), block: 'morn', seats: 3, minLevel: 1, maxLevel: 2,
        notes: 'Paperwork, a locked drawer, and a clerk who will not meet your eye.',
        party: [] }, imre)),
      S('s7', { title: 'Sun-Stalker Trail — Lost Caravan', region: 'Sun-Stalker Trail', date: next(4, 1), block: 'eve', seats: 5, minLevel: 3, maxLevel: 5,
        notes: 'A caravan due nine days ago. Tracks lead off the trail.',
        party: [seat('p-wen', 0)] }),
      S('s8', Object.assign({ title: 'Shadow-Prowler (NE) — The Quiet Mile', region: 'Shadow-Prowler Trail, north-east', date: next(0, 1), block: 'eve', seats: 5, minLevel: 2, maxLevel: 4,
        notes: 'Nobody who walks the Quiet Mile talks about it afterwards. Find out why.',
        party: [], postedAt: now - 2 * H }, imre)),
      // Proposals: player-made, waiting for a GM to schedule them.
      S('p1', { status: 'proposed', title: 'The Mill on the Tupperwine', region: 'The Tupperwine, upstream of the ford',
        proposerUid: 'p-marek', proposer: 'Marek', gm: null, gmUid: null, date: null, block: null, seats: null, minLevel: null, maxLevel: null,
        notes: 'The miller stopped sending flour three weeks ago. Nobody has gone to look.',
        party: [seat('p-marek', 0), seat('p-priya', 0), seat('p-cass', 0)], postedAt: now - 20 * H }),
      S('p2', { status: 'proposed', title: 'Farmbelt Spoke (W) — the empty waystation', region: 'Farmbelt Spoke (W)',
        proposerUid: 'p-ola', proposer: 'Ola', gm: null, gmUid: null, date: null, block: null, seats: null, minLevel: null, maxLevel: null,
        notes: 'Low-level. A first walk for Peder; happy to have anyone along who is starting out.',
        party: [seat('p-ola', 0), seat('p-halvard', 1)], postedAt: now - 6 * H }),
    ];
    const s = id => sessions.find(x => x.id === id);

    const D = (id, hoursAgo, kind, text, meta) => Object.assign({ id, ts: now - hoursAgo * H, kind, text }, meta);
    const dispatches = [
      D('d1', 2,  'new',      'New expedition posted: “Shadow-Prowler (NE) — The Quiet Mile” (GM Imre).', { uid: 'gm-imre', sessionId: 's8', date: s('s8').date, block: 'eve' }),
      D('d2', 5,  'open',     'Gaius (Halvard) withdrew from “The Salt Stair” — 1 seat opened.', { uid: 'p-halvard', sessionId: 's1', date: s('s1').date, block: 'eve' }),
      D('d0', 6,  'proposal', 'Ola proposed “Farmbelt Spoke (W) — the empty waystation” — Farmbelt Spoke (W). Join it from the board.', { uid: 'p-ola', sessionId: 'p2' }),
      D('d7', 20, 'proposal', 'Marek proposed “The Mill on the Tupperwine” — The Tupperwine, upstream of the ford. Join it from the board.', { uid: 'p-marek', sessionId: 'p1' }),
      D('d3', 26, 'full',     '“Farmbelt Ring — Night Watch” is now full.', { uid: 'p-halvard', sessionId: 's2' }),
      D('d5', 52, 'seat',     'Maud Pellinger (Rowan Ashby) is seated on “Dwarven Trade Road — Toll House”.', { uid: 'local', sessionId: 's4', date: s('s4').date, block: 'eve' }),
      D('d6', 70, 'new',      'New expedition posted: “The Salt Stair” (GM Dahl).', { uid: dahl.gmUid, sessionId: 's1', date: s('s1').date, block: 'eve' }),
    ].filter(d => asGM ? d.id !== 'd5' : true);

    const day = n => U.keyOf(new Date(today.getTime() + n * 864e5));
    const announcements = [
      { id: 'an1', text: 'No game the week of the 28th — I am away. Back the week after.', until: day(16), ts: now - 4 * H, uid: gmUids[0] || 'gm-dahl', author: asGM ? me.name : 'Dahl' },
      { id: 'an2', text: 'New players: read the primer before your first expedition, and bring a level 1 character.', until: day(30), ts: now - 30 * H, uid: 'gm-imre', author: 'Imre' },
    ];
    return { version: 5, me, players, gmUids, sessions, dispatches, announcements };
  };
})(window.KS);
