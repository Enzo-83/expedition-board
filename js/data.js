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
    { key: 'morn', label: 'Morning',   short: 'Morn', time: '09:00–12:00' },
    { key: 'aft',  label: 'Afternoon', short: 'Aft',  time: '13:00–17:00' },
    { key: 'eve',  label: 'Evening',   short: 'Eve',  time: '18:00–22:00' },
    { key: 'late', label: 'Late',      short: 'Late', time: '22:00–01:00' },
  ];
  KS.DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // Date#getDay order

  const pad = n => String(n).padStart(2, '0');
  const U = KS.util = {
    pad,
    keyOf: d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    parseKey: k => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d); },
    todayKey: () => U.keyOf(new Date()),
    weekdayOf: dateKey => KS.DAY_KEYS[U.parseKey(dateKey).getDay()],
    slotOf: sess => U.weekdayOf(sess.date) + '-' + sess.block,
    blockOf: key => KS.BLOCKS.find(b => b.key === key) || { key, label: key, time: '' },
    dayOf: key => KS.DAYS.find(d => d.key === key) || { key, short: '?', label: key },
    blockIndex: key => KS.BLOCKS.findIndex(b => b.key === key),
    esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    initials: name => String(name || '?').split(/[\s.\-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?',
    uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    sortSessions: list => list.slice().sort((a, b) => a.date === b.date
      ? U.blockIndex(a.block) - U.blockIndex(b.block)
      : (a.date < b.date ? -1 : 1)),
  };

  // Rules shared by the UI and by both adapters (the Firestore adapter re-runs them
  // inside a transaction against the fresh document, so two players can't take one seat).
  const R = KS.rules = {
    openSeats: s => Math.max(0, (s.seats | 0) - (s.party || []).length),
    isPast: s => s.date < U.todayKey(),
    fits: (me, s) => !!me && (me.availability || []).includes(U.slotOf(s)),
    myEntry: (me, s) => (s.party || []).find(e => e.uid === me.uid) || null,
    eligibility(state, sess, ch, opts = {}) {
      const no = reason => ({ ok: false, reason });
      const me = state.me;
      if (!ch) return no('Pick one of your characters first.');
      if (R.isPast(sess)) return no('This expedition has already departed.');
      if (sess.locked) return no('The roster is locked.');
      const already = (sess.party || []).find(e => e.uid === me.uid);
      if (already) return no(already.charId === ch.id ? `${ch.name} is already seated here.` : `You already have ${already.name} on this expedition — one seat per player.`);
      if (R.openSeats(sess) <= 0) return no('No open seats.');
      if (ch.level < sess.minLevel || ch.level > sess.maxLevel) return no(`${ch.name} is level ${ch.level}; this expedition takes levels ${sess.minLevel}–${sess.maxLevel}.`);
      const clash = state.sessions.find(o => o.id !== sess.id && o.id !== opts.ignoreSessId
        && o.date === sess.date && o.block === sess.block && (o.party || []).some(e => e.uid === me.uid));
      if (clash) return no(`You're already committed to “${clash.title}” in that window.`);
      return { ok: true, reason: '' };
    },
  };

  // ---------------------------------------------------------------------------
  // Sample data for the local demo. Dates are generated relative to today so the
  // board never opens onto a stale week. Every name and level here is placeholder.
  KS.sample = function () {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const next = (dow, week = 0) => {           // next occurrence of a weekday, strictly after today
      const d = new Date(today);
      let diff = (dow - d.getDay() + 7) % 7; if (diff === 0) diff = 7;
      d.setDate(d.getDate() + diff + week * 7);
      return U.keyOf(d);
    };
    const H = 3600e3, now = Date.now();

    const P = (uid, name, availability, characters) => ({ uid, name, availability, characters });
    const players = [
      P('p-wen',     'Wen',     ['mon-eve', 'tue-eve', 'wed-eve', 'thu-eve', 'thu-late', 'sat-eve', 'sat-late', 'sun-aft', 'sun-eve'],
        [{ id: 'p-wen-1', name: 'Thordak Runehammer', level: 4 }, { id: 'p-wen-2', name: 'Thalen Whiskerdust', level: 2 }]),
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
        [{ id: 'p-tess-1', name: 'Taerik Altavin', level: 5 }, { id: 'p-tess-2', name: 'Elias Finch', level: 5 }, { id: 'p-tess-3', name: 'Dínen von Spreller', level: 4 }]),
    ];
    const seat = (uid, idx) => {
      const p = players.find(x => x.uid === uid), c = p.characters[idx];
      return { charId: c.id, uid, name: c.name, level: c.level, owner: p.name };
    };

    const me = {
      uid: 'local', name: 'Rowan Ashby', handle: 'rowan', discord: 'rowan_a', role: 'Player',
      characters: [
        { id: 'c1', name: 'Oriel Vance', class: 'Fighter', level: 5 },
        { id: 'c2', name: 'Maud Pellinger', class: 'Cleric', level: 3 },
        { id: 'c3', name: 'Wick', class: 'Rogue', level: 1 },
      ],
      availability: ['mon-eve', 'tue-eve', 'thu-eve', 'thu-late', 'sat-aft', 'sat-eve', 'sat-late', 'sun-aft', 'sun-eve'],
      watching: ['s2'],
      prefs: { alertOnOpenSeat: true, browserAlerts: false },
      readAt: now - 3 * H,
    };
    const mine = idx => { const c = me.characters[idx]; return { charId: c.id, uid: 'local', name: c.name, level: c.level, owner: me.name }; };

    const S = (id, o) => Object.assign({ id, party: [], locked: false, gmUid: 'gm-dahl', postedAt: now - 48 * H }, o);
    const sessions = [
      S('s1', { title: 'The Salt Stair', region: 'Frost-Pelt Trail, north', gm: 'Dahl', date: next(4), block: 'eve', seats: 5, minLevel: 3, maxLevel: 6,
        notes: 'Two days out and back along the trail. Bring cold-weather kit; the roster locks the evening before.',
        party: [seat('p-wen', 0), seat('p-marek', 0), seat('p-priya', 0)] }),
      S('s2', { title: 'Farmbelt Ring — Night Watch', region: 'Farmbelt Ring Road', gm: 'Dahl', date: next(5), block: 'late', seats: 4, minLevel: 1, maxLevel: 3,
        notes: 'A short, local job for newer characters. Something has been taking lambs.',
        party: [seat('p-dunn', 0), seat('p-ola', 0), seat('p-priya', 1), seat('p-halvard', 1)] }),
      S('s3', { title: 'Tupperwine Ford Survey', region: 'The Tupperwine', gm: 'Imre', gmUid: 'gm-imre', date: next(6), block: 'aft', seats: 5, minLevel: 1, maxLevel: 4,
        notes: 'Mapping the crossings after the spring flood. Low danger, high mud.',
        party: [seat('p-wen', 1)] }),
      S('s4', { title: 'Dwarven Trade Road — Toll House', region: 'Dwarven Trade Road', gm: 'Dahl', date: next(6), block: 'eve', seats: 5, minLevel: 2, maxLevel: 5,
        notes: 'The toll house has not answered the last two caravans.',
        party: [seat('p-halvard', 0), seat('p-dunn', 1), seat('p-cass', 0), mine(1)] }),
      S('s5', { title: 'Crag-Leaper Ascent', region: 'Crag-Leaper Trail', gm: 'Imre', gmUid: 'gm-imre', date: next(0), block: 'aft', seats: 4, minLevel: 4, maxLevel: 6,
        notes: 'Experienced characters only. Climbing gear provided by the temple.',
        party: [seat('p-tess', 0), seat('p-marek', 0), seat('p-priya', 0)] }),
      S('s6', { title: 'Kwanqobile — Registry Errand', region: 'Kwanqobile, the city', gm: 'Imre', gmUid: 'gm-imre', date: next(2, 1), block: 'morn', seats: 3, minLevel: 1, maxLevel: 2,
        notes: 'Paperwork, a locked drawer, and a clerk who will not meet your eye.',
        party: [] }),
      S('s7', { title: 'Sun-Stalker Trail — Lost Caravan', region: 'Sun-Stalker Trail', gm: 'Dahl', date: next(4, 1), block: 'eve', seats: 5, minLevel: 3, maxLevel: 5,
        notes: 'A caravan due nine days ago. Tracks lead off the trail.',
        party: [seat('p-wen', 0)] }),
      S('s8', { title: 'Shadow-Prowler (NE) — The Quiet Mile', region: 'Shadow-Prowler Trail, north-east', gm: 'Imre', gmUid: 'gm-imre', date: next(0, 1), block: 'eve', seats: 5, minLevel: 2, maxLevel: 4,
        notes: 'Nobody who walks the Quiet Mile talks about it afterwards. Find out why.',
        party: [], postedAt: now - 2 * H }),
    ];
    const s = id => sessions.find(x => x.id === id);

    const D = (id, hoursAgo, kind, text, meta) => Object.assign({ id, ts: now - hoursAgo * H, kind, text }, meta);
    const dispatches = [
      D('d1', 2,  'new',   'New expedition posted: “Shadow-Prowler (NE) — The Quiet Mile” (GM Imre).', { uid: 'gm-imre', sessionId: 's8', date: s('s8').date, block: 'eve' }),
      D('d2', 5,  'open',  'Gaius (Halvard) withdrew from “The Salt Stair” — 1 seat opened.', { uid: 'p-halvard', sessionId: 's1', date: s('s1').date, block: 'eve' }),
      D('d3', 26, 'full',  '“Farmbelt Ring — Night Watch” is now full.', { uid: 'p-halvard', sessionId: 's2' }),
      D('d4', 31, 'avail', 'Marek updated availability — free in 7 windows a week.', { uid: 'p-marek' }),
      D('d5', 52, 'seat',  'Maud Pellinger (Rowan Ashby) is seated on “Dwarven Trade Road — Toll House”.', { uid: 'local', sessionId: 's4', date: s('s4').date, block: 'eve' }),
      D('d6', 70, 'new',   'New expedition posted: “The Salt Stair” (GM Dahl).', { uid: 'gm-dahl', sessionId: 's1', date: s('s1').date, block: 'eve' }),
    ];

    return { version: 2, me, players, sessions, dispatches };
  };
})(window.KS);
