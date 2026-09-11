/* Expedition Board — UI.
   Talks to the world only through an adapter (local-adapter.js / firebase-adapter.js).
   State arrives via onState and is treated as read-only here; every change is an adapter call. */
(function () {
  'use strict';
  const U = KS.util, R = KS.rules, DAYS = KS.DAYS, BLOCKS = KS.BLOCKS, esc = U.esc;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  let A = null;                  // adapter
  let S = null;                  // latest state
  let status = { mode: 'local', connected: false, user: null };
  let armed = null;              // character id armed for tap-to-place
  let dragging = null;           // { kind: 'char' | 'chip', charId, sessId }
  let seenDispatches = null;     // ids already seen — new ones may raise a browser alert
  let availTimer = null, toastTimer = null, profileOpenedOnce = false, resetArmedAt = 0;
  const ui = { filter: 'all', party: new Set() };   // party: "uid:charId" keys picked in the overlap panel

  const KIND = { new: 'Posted', seat: 'Seated', open: 'Seat open', full: 'Full', avail: 'Availability', watch: 'Watching', alert: 'Alert', request: 'Request', note: 'Note' };
  const fmtDay  = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  const fmtDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const fmtLong = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const when = s => `${fmtLong.format(U.parseKey(s.date))}, ${U.blockOf(s.block).label}`;
  const byId = id => (S && S.sessions.find(s => s.id === id)) || null;
  const myChar = id => (S && S.me.characters.find(c => c.id === id)) || null;
  const upcoming = () => U.sortSessions(S.sessions.filter(s => !R.isPast(s)));
  const isWatching = id => (S.me.watching || []).includes(id);
  const isMine = e => e.uid === S.me.uid;

  // ------------------------------------------------------------------ boot
  KS.boot = function (adapter) {
    if (KS.booted) return;
    KS.booted = true; A = adapter;
    A.start({
      onState(state) { S = state; render(); alertOnNewDispatches(); },
      onStatus(st) {
        status = st; renderStatus();
        if (st.firstRun && !profileOpenedOnce) { profileOpenedOnce = true; setTimeout(openProfile, 400); }
      },
    });
  };
  // Module scripts can't load from file://, so a double-clicked index.html runs the local demo.
  if (location.protocol === 'file:') KS.boot(new KS.LocalAdapter());
  setTimeout(() => { if (!KS.booted) $('#boot-error').hidden = false; }, 8000);

  // ---------------------------------------------------------------- render
  function render() {
    if (!S) return;
    const a = document.activeElement, d = a && a.dataset;
    const keep = d ? (d.slot ? `[data-slot="${d.slot}"]` : d.filter ? `[data-filter="${d.filter}"]` : d.watch ? `[data-watch="${d.watch}"]` : d.char ? `[data-char="${d.char}"]` : null) : null;
    renderUser(); renderRoster(); renderAvailability(); renderBoard(); renderDispatches(); renderOverlap(); renderMeta(); renderArm();
    if (keep) { const el = $(keep); if (el) el.focus({ preventScroll: true }); }
  }

  function renderStatus() {
    const auth = $('#auth');
    const gated = status.mode === 'firebase' && (!status.user || !!status.error);
    document.body.classList.toggle('is-gated', gated);
    $('#gate').hidden = !gated;
    if (status.mode === 'local') {
      auth.innerHTML = `<span class="conn conn--local" title="Sample data in this browser only. See README to connect Firebase.">Local demo · not synced</span>`;
    } else if (!status.user) {
      auth.innerHTML = `<button type="button" class="btn btn--primary btn--sm" data-action="sign-in">Sign in with Google</button>`;
    } else {
      auth.innerHTML = `<span class="conn ${status.error ? 'conn--err' : 'conn--live'}">${status.error ? 'Not connected' : 'Live'}</span>`
        + `<span class="auth__who">${esc(status.user.name || status.user.email || '')}</span>`
        + `<button type="button" class="btn btn--sm btn--ghost" data-action="sign-out">Sign out</button>`;
    }
    $('#gate-note').textContent = status.error || (status.user ? '' : 'The board is private to the network. Sign in with the Google account the GM has on the list.');
    $('#gate-signin').hidden = !!status.user;
    $('#gate-signout').hidden = !status.user;
    $('#colophon-note').hidden = status.mode !== 'local';
  }

  function renderUser() {
    const me = S.me, n = me.characters.length;
    $('#user-initials').textContent = U.initials(me.name);
    $('#user-name').textContent = me.name || '—';
    $('#user-sub').textContent = [me.handle ? '@' + me.handle : '', me.discord].filter(Boolean).join(' · ');
    $('#user-role').textContent = me.role || 'Player';
    $('#user-chars').textContent = `${n} character${n === 1 ? '' : 's'}`;
  }

  function renderRoster() {
    const list = upcoming();
    const html = S.me.characters.map(c => {
      const commits = list.filter(s => (s.party || []).some(e => e.charId === c.id && isMine(e)));
      const line = commits.length ? 'Committed: ' + commits.map(when).join(' · ') : 'Ready to march';
      const on = armed === c.id;
      return `<li><button type="button" class="char${on ? ' char--armed' : ''}" draggable="true" data-char="${esc(c.id)}" aria-pressed="${on}" title="Drag onto an open seat, or tap and then tap a seat">
        <span class="char__grip" aria-hidden="true">⠿</span>
        <span class="char__main"><span class="char__name">${esc(c.name)}</span><span class="char__sub">${esc(c.class || '')}</span><span class="char__status">${esc(line)}</span></span>
        <span class="char__lvl">Lvl ${esc(c.level)}</span></button></li>`;
    }).join('');
    $('#roster').innerHTML = html || `<li class="roster__empty">No characters yet. <button type="button" class="linklike" data-action="profile-open">Add one to your roster.</button></li>`;
  }

  function renderAvailability() {
    const av = S.me.availability || [];
    let html = `<table class="grid avail"><thead><tr><th scope="col" class="grid__corner"></th>${DAYS.map(d => `<th scope="col" abbr="${d.label}">${d.short}</th>`).join('')}</tr></thead><tbody>`;
    for (const b of BLOCKS) {
      html += `<tr><th scope="row" title="${esc(b.label)}"><span class="grid__block">${esc(b.short || b.label)}</span><span class="grid__time">${esc(b.time)}</span></th>`;
      for (const d of DAYS) {
        const slot = `${d.key}-${b.key}`;
        html += `<td><button type="button" class="avail__cell" data-slot="${slot}" aria-pressed="${av.includes(slot)}" aria-label="${d.label} ${b.label}"></button></td>`;
      }
      html += '</tr>';
    }
    $('#avail').innerHTML = html + '</tbody></table>';
    $('#avail-count').textContent = `${av.length} / ${DAYS.length * BLOCKS.length}`;
  }

  function renderBoard() {
    const list = upcoming();
    const shown = list.filter(s => ui.filter === 'fit' ? R.fits(S.me, s) : ui.filter === 'open' ? R.openSeats(s) > 0 : true);
    $('#stat-upcoming').textContent = list.length;
    $('#stat-open').textContent = list.reduce((n, s) => n + R.openSeats(s), 0);
    $('#stat-fit').textContent = list.filter(s => R.fits(S.me, s)).length;
    $('#stat-mine').textContent = list.filter(s => R.myEntry(S.me, s)).length;
    $$('.filters button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === ui.filter)));
    $('#board-count').textContent = `${shown.length} of ${list.length}`;
    if (!shown.length) { $('#board-list').innerHTML = emptyState(list.length); return; }
    let html = '', lastDate = null;
    for (const s of shown) {
      if (s.date !== lastDate) {
        lastDate = s.date;
        const d = U.parseKey(s.date), n = shown.filter(x => x.date === s.date).length;
        html += `<h3 class="day"><span class="day__name">${esc(fmtDay.format(d))}</span><span class="day__date">${esc(fmtDate.format(d))}</span><span class="day__count">${n} expedition${n === 1 ? '' : 's'}</span></h3>`;
      }
      html += sessionHTML(s);
    }
    $('#board-list').innerHTML = html;
  }

  function sessionHTML(s) {
    const b = U.blockOf(s.block), open = R.openSeats(s), mine = R.myEntry(S.me, s), fit = R.fits(S.me, s);
    const party = s.party || [], seats = [];
    for (let i = 0; i < s.seats; i++) {
      const e = party[i];
      if (!e) seats.push(`<button type="button" class="seat seat--open" data-open="${esc(s.id)}" aria-label="Open seat on ${esc(s.title)} — place a character">+</button>`);
      else if (isMine(e)) seats.push(`<button type="button" class="seat seat--mine" draggable="true" data-chip="${esc(e.charId)}" data-sess="${esc(s.id)}" title="${esc(e.name)} · Lvl ${esc(e.level)} · you — click to withdraw" aria-label="Withdraw ${esc(e.name)} from ${esc(s.title)}">${esc(U.initials(e.name))}</button>`);
      else seats.push(`<span class="seat seat--filled" tabindex="0" title="${esc(e.name)} · Lvl ${esc(e.level)} · ${esc(e.owner || '')}">${esc(U.initials(e.name))}</span>`);
    }
    const names = party.map(e => `<span class="${isMine(e) ? 'party__me' : ''}">${esc(e.name)} <small>${esc(e.level)}</small></span>`).join('<span class="party__sep">·</span>');
    const stamps = [];
    if (mine) stamps.push('<li class="stamp stamp--in">You’re in</li>'); else if (fit) stamps.push('<li class="stamp stamp--fit">Fits you</li>');
    if (open === 0) stamps.push('<li class="stamp stamp--full">Full</li>');
    if (s.locked) stamps.push('<li class="stamp stamp--full">Locked</li>');
    return `<article class="session${mine ? ' session--mine' : ''}${open === 0 ? ' session--full' : ''}" data-id="${esc(s.id)}">
      <div class="session__when"><span class="session__block">${esc(b.label)}</span><span class="session__time">${esc(b.time)}</span></div>
      <div class="session__body">
        <h4 class="session__title">${esc(s.title)}</h4>
        <p class="session__meta">${esc(s.region)}<span class="sep">·</span>GM ${esc(s.gm)}<span class="sep">·</span>${esc(s.seats)} seats</p>
        ${s.notes ? `<p class="session__notes">${esc(s.notes)}</p>` : ''}
        ${names ? `<p class="party">${names}</p>` : ''}
        ${stamps.length ? `<ul class="stamps">${stamps.join('')}</ul>` : ''}
      </div>
      <div class="session__band"><span class="label">Levels</span><strong>${esc(s.minLevel)}–${esc(s.maxLevel)}</strong></div>
      <div class="session__seats">
        <div class="seats" data-drop="${esc(s.id)}" role="group" aria-label="Seats on ${esc(s.title)}">${seats.join('')}</div>
        <p class="seats__count">${party.length} of ${esc(s.seats)} seated${open ? ` · <strong>${open} open</strong>` : ''}</p>
      </div>
      <div class="session__actions">
        <button type="button" class="watch" data-watch="${esc(s.id)}" aria-pressed="${isWatching(s.id)}" title="Get a dispatch when a seat opens here">${isWatching(s.id) ? 'Watching' : 'Watch'}</button>
      </div>
    </article>`;
  }

  function emptyState(total) {
    if (!total) return `<div class="empty"><h4>Nothing on the board</h4><p>No upcoming expeditions. ${status.mode === 'local' ? 'The sample dates may have passed — <button type="button" class="linklike" data-action="reset">reset the sample data</button>, or ' : ''}post one.</p></div>`;
    return `<div class="empty"><h4>Nothing fits those filters</h4><p>Try widening your availability, or show all expeditions.</p></div>`;
  }

  function renderDispatches() {
    const readAt = S.me.readAt || 0, list = S.dispatches.slice(0, 25);
    const unread = S.dispatches.filter(d => d.ts > readAt).length;
    $('#disp-unread').textContent = unread ? `${unread} new` : 'Up to date';
    $('#dispatches').innerHTML = list.map(d => {
      const forMe = d.uid !== S.me.uid && concernsMe(d);
      return `<li class="disp disp--${esc(d.kind)}${d.ts > readAt ? ' disp--unread' : ''}${forMe ? ' disp--forme' : ''}">
        <span class="disp__kind">${forMe ? 'For you · ' : ''}${esc(KIND[d.kind] || d.kind)}</span>
        <span class="disp__text">${esc(d.text)}</span>
        <time class="disp__time" datetime="${new Date(d.ts).toISOString()}">${esc(relTime(d.ts))}</time></li>`;
    }).join('') || '<li class="disp disp--empty">Nothing yet.</li>';
    $('#pref-openseat').checked = !!(S.me.prefs && S.me.prefs.alertOnOpenSeat);
    renderBrowserAlerts();
  }

  function renderBrowserAlerts() {
    const btn = $('#btn-browser-alerts'), note = $('#browser-alerts-note');
    if (!('Notification' in window)) { btn.hidden = true; note.textContent = 'Browser alerts are not available here.'; return; }
    const on = !!(S.me.prefs && S.me.prefs.browserAlerts) && Notification.permission === 'granted';
    btn.textContent = on ? 'Browser alerts on' : 'Enable browser alerts';
    btn.setAttribute('aria-pressed', String(on));
    note.textContent = Notification.permission === 'denied' ? 'Blocked in your browser settings.' : on ? 'While this tab is open.' : '';
  }

  // ---- overlap + party picker ----------------------------------------------
  // With nothing picked the heatmap shows the whole network. Pick characters and it narrows
  // to their players: ringed cells are windows where every one of them is free.
  const partyKey = (uid, charId) => `${uid}:${charId || ''}`;
  function peopleList() {
    return [
      { uid: S.me.uid, name: S.me.name, availability: S.me.availability || [], characters: S.me.characters || [], me: true },
      ...S.players.filter(p => p.uid !== S.me.uid).map(p => ({ uid: p.uid, name: p.name || 'Unnamed', availability: p.availability || [], characters: p.characters || [], me: false })),
    ];
  }
  function partyGroup(people) {
    const owners = new Set([...ui.party].map(k => k.split(':')[0]));
    const group = people.filter(p => owners.has(p.uid));
    const chars = [];
    people.forEach(p => p.characters.forEach(c => { if (ui.party.has(partyKey(p.uid, c.id))) chars.push(Object.assign({}, c, { uid: p.uid, owner: p.name })); }));
    return { group, chars };
  }
  const slotOrder = slot => { const [dk, bk] = slot.split('-'); return DAYS.findIndex(d => d.key === dk) * 10 + U.blockIndex(bk); };
  const slotLabel = slot => { const [dk, bk] = slot.split('-'); return `${U.dayOf(dk).label} ${U.blockOf(bk).label}`; };
  const listNames = arr => arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
  function nextDateFor(dk) {
    const dow = KS.DAY_KEYS.indexOf(dk), d = new Date(); d.setHours(0, 0, 0, 0);
    let diff = (dow - d.getDay() + 7) % 7; if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff); return U.keyOf(d);
  }

  function renderOverlap() {
    const people = peopleList(), { group, chars } = partyGroup(people);
    const active = group.length >= 2, who = active ? group : people;
    const total = who.length, counts = {}, free = {};
    who.forEach(p => p.availability.forEach(slot => { counts[slot] = (counts[slot] || 0) + 1; (free[slot] = free[slot] || []).push(p); }));
    const nameOf = p => p.me ? `${p.name} (you)` : p.name;
    const missingIn = slot => who.filter(p => !(free[slot] || []).includes(p)).map(nameOf);
    const bucket = n => n === 0 ? 0 : n / total <= .25 ? 1 : n / total <= .5 ? 2 : n / total <= .75 ? 3 : 4;
    let html = `<table class="grid heat"><thead><tr><th scope="col" class="grid__corner"></th>${DAYS.map(d => `<th scope="col" abbr="${d.label}">${d.short}</th>`).join('')}</tr></thead><tbody>`;
    for (const b of BLOCKS) {
      html += `<tr><th scope="row" title="${esc(b.label)}"><span class="grid__block">${esc(b.short || b.label)}</span></th>`;
      for (const d of DAYS) {
        const slot = `${d.key}-${b.key}`, n = counts[slot] || 0, me = (S.me.availability || []).includes(slot);
        const all = active && n === total;
        html += `<td class="heat__cell h${bucket(n)}${me ? ' heat__cell--me' : ''}${all ? ' heat__cell--all' : ''}" tabindex="0" data-heat="${slot}" data-names="${esc((free[slot] || []).map(nameOf).join(', '))}" data-missing="${esc(active ? missingIn(slot).join(', ') : '')}" aria-label="${d.label} ${b.label}: ${n} of ${total} free">${n}</td>`;
      }
      html += '</tr>';
    }
    $('#overlap').innerHTML = html + '</tbody></table>';
    $('#overlap-total').textContent = active ? `${total} players picked` : `${total} player${total === 1 ? '' : 's'}`;
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || slotOrder(a[0]) - slotOrder(b[0]));
    if (active) {
      $('#best-label').textContent = 'Windows for this party';
      const top = entries.filter(([, n]) => n >= Math.max(2, total - 1)).slice(0, 6);
      $('#best-windows').innerHTML = top.map(([slot, n]) => {
        const missing = missingIn(slot);
        return `<li class="${n === total ? 'best--all' : ''}"><span class="best__name">${esc(slotLabel(slot))}${missing.length ? `<small>without ${esc(listNames(missing))}</small>` : ''}</span><strong>${n === total ? `All ${total}` : `${n} of ${total}`}</strong>
          <div class="best__act"><button type="button" class="btn btn--sm" data-action="party-request" data-win="${slot}">Request an expedition</button><button type="button" class="btn btn--sm btn--ghost" data-action="party-post" data-win="${slot}">Post here</button></div></li>`;
      }).join('') || '<li><span class="best__name">No window has more than one of them free — someone needs to widen their availability.</span></li>';
    } else {
      $('#best-label').textContent = 'Best windows to post';
      $('#best-windows').innerHTML = entries.slice(0, 3).map(([slot, n]) => `<li><span class="best__name">${esc(slotLabel(slot))}</span><strong>${n} of ${total}</strong></li>`).join('')
        || '<li><span class="best__name">No one has marked availability yet.</span></li>';
    }
    renderPartyChips(people, group);
  }

  function renderPartyChips(people, group) {
    $('#party-chips').innerHTML = people.map(p => {
      const chips = p.characters.length
        ? p.characters.map(c => { const k = partyKey(p.uid, c.id); return `<button type="button" class="chip" aria-pressed="${ui.party.has(k)}" data-pchip="${esc(k)}">${esc(c.name)} <small>${esc(c.level)}</small></button>`; }).join('')
        : (() => { const k = partyKey(p.uid, ''); return `<button type="button" class="chip" aria-pressed="${ui.party.has(k)}" data-pchip="${esc(k)}">${esc(p.name)} <small>no characters yet</small></button>`; })();
      return `<div class="chips__group"><span class="chips__owner">${p.me ? 'You' : esc(p.name)}</span>${chips}</div>`;
    }).join('');
    const n = ui.party.size;
    $('#party-summary').textContent = n ? `${n} picked` : 'Pick a party';
    $('#party-clear').hidden = !n;
    $('#party-hint').textContent = !n ? 'Pick two or more characters to see when their players line up.'
      : group.length < 2 ? 'Add a character from another player.'
      : 'Ringed cells: everyone picked is free. The list below ranks the windows.';
    if (n) $('#party-picker').open = true;
  }

  async function partyRequest(win) {
    const { group, chars } = partyGroup(peopleList());
    if (group.length < 2) return;
    const [dk, bk] = win.split('-'), date = nextDateFor(dk);
    const here = group.filter(p => p.availability.includes(win)), away = group.filter(p => !p.availability.includes(win));
    const levels = chars.map(c => c.level), band = levels.length ? ` (levels ${Math.min(...levels)}–${Math.max(...levels)})` : '';
    const text = `${listNames(here.map(p => p.name))} can make ${slotLabel(win)}${away.length ? ` — ${listNames(away.map(p => p.name))} can't` : ''} — next ${fmtLong.format(U.parseKey(date))}${band} — and would like an expedition.`;
    try { await A.log('request', text, { date, block: bk, party: group.map(p => p.uid) }); toast('Request posted — GMs will see it in Dispatches.', 'ok'); }
    catch (err) { toast(err.message || 'Could not post the request.', 'no'); }
  }
  function partyPrefill(win) {
    const { chars } = partyGroup(peopleList()), [dk, bk] = win.split('-'), levels = chars.map(c => c.level);
    return { date: nextDateFor(dk), block: bk, seats: Math.max(4, chars.length), minLevel: levels.length ? Math.min(...levels) : 1, maxLevel: levels.length ? Math.max(...levels) : 5 };
  }

  function renderMeta() {
    let tz = 'local time';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch (e) { /* ignore */ }
    $('#meta-tz').textContent = tz.replace(/_/g, ' ');
    const list = upcoming();
    $('#meta-range').textContent = list.length
      ? `${fmtDate.format(U.parseKey(list[0].date))} – ${fmtDate.format(U.parseKey(list[list.length - 1].date))}`
      : 'Nothing scheduled';
    $('#meta-open').textContent = String(list.reduce((n, s) => n + R.openSeats(s), 0));
  }

  function renderArm() {
    const c = armed ? myChar(armed) : null;
    if (!c) armed = null;
    $('#arm-banner').hidden = !c;
    if (c) $('#arm-name').textContent = c.name;
    document.body.classList.toggle('is-armed', !!c);
  }
  function arm(id) { armed = id; renderRoster(); renderArm(); }
  function disarm() { if (!armed) return; armed = null; renderRoster(); renderArm(); }

  function relTime(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24); if (d === 1) return 'yesterday'; if (d < 14) return `${d} d ago`;
    return fmtDate.format(new Date(ts));
  }

  // --------------------------------------------------------------- actions
  async function place(sessId, charId) {
    const sess = byId(sessId), ch = myChar(charId);
    if (!sess || !ch) return;
    const v = R.eligibility(S, sess, ch);
    if (!v.ok) return refuse(sessId, v.reason);
    const willFill = R.openSeats(sess) - 1 <= 0;
    try {
      await A.seat(sessId, ch);
      disarm();
      toast(`${ch.name} seated on “${sess.title}”.`, 'ok');
      await A.log('seat', `${ch.name} (${S.me.name}) is seated on “${sess.title}” — ${when(sess)}.`, { sessionId: sessId, date: sess.date, block: sess.block });
      if (willFill) await A.log('full', `“${sess.title}” is now full.`, { sessionId: sessId });
    } catch (err) { refuse(sessId, err.message || 'Could not take that seat.'); }
  }

  async function withdraw(sessId, charId) {
    const sess = byId(sessId); if (!sess) return;
    const e = (sess.party || []).find(x => x.charId === charId && isMine(x)); if (!e) return;
    try {
      await A.unseat(sessId, charId);
      toast(`${e.name} withdrawn from “${sess.title}”.`, 'ok');
      await A.log('open', `${e.name} (${S.me.name}) withdrew from “${sess.title}” — 1 seat opened.`, { sessionId: sessId, date: sess.date, block: sess.block });
    } catch (err) { toast(err.message || 'Could not withdraw.', 'no'); }
  }

  async function move(fromId, toId, charId) {
    const from = byId(fromId), to = byId(toId), ch = myChar(charId);
    if (!from || !to || !ch) return;
    const v = R.eligibility(S, to, ch, { ignoreSessId: fromId });
    if (!v.ok) return refuse(toId, v.reason);
    try {
      await A.move(fromId, toId, charId);
      toast(`${ch.name} moved to “${to.title}”.`, 'ok');
      await A.log('open', `${ch.name} (${S.me.name}) moved from “${from.title}” to “${to.title}” — 1 seat opened on “${from.title}”.`, { sessionId: fromId, date: from.date, block: from.block });
    } catch (err) { refuse(toId, err.message || 'Could not move.'); }
  }

  async function toggleWatch(id) {
    const s = byId(id); if (!s) return;
    const w = (S.me.watching || []).slice(), i = w.indexOf(id), on = i < 0;
    if (on) w.push(id); else w.splice(i, 1);
    await A.setWatching(w);
    toast(on ? `Watching “${s.title}” — you'll be told when a seat opens.` : `No longer watching “${s.title}”.`, 'hint');
  }

  async function toggleAvail(slot) {
    const a = (S.me.availability || []).slice(), i = a.indexOf(slot);
    if (i < 0) a.push(slot); else a.splice(i, 1);
    await A.setAvailability(a); noteAvail();
  }
  async function preset(name) {
    let a = (S.me.availability || []).slice();
    const add = slots => slots.forEach(s => { if (!a.includes(s)) a.push(s); });
    if (name === 'clear') a = [];
    if (name === 'weeknights') add(['mon', 'tue', 'wed', 'thu', 'fri'].map(d => `${d}-eve`));
    if (name === 'weekends') add(['sat', 'sun'].flatMap(d => BLOCKS.map(b => `${d}-${b.key}`)));
    await A.setAvailability(a); noteAvail();
  }
  // One dispatch per editing session, not one per cell: wait for a pause, then refresh my most
  // recent availability line if it is under an hour old instead of adding another.
  function noteAvail() {
    clearTimeout(availTimer);
    availTimer = setTimeout(async () => {
      const n = (S.me.availability || []).length;
      const text = `${S.me.name} updated availability — free in ${n} window${n === 1 ? '' : 's'} a week.`;
      const recent = S.dispatches.find(d => d.kind === 'avail' && d.uid === S.me.uid && Date.now() - d.ts < 3600e3);
      try { if (recent && A.relog) await A.relog(recent.id, text); else await A.log('avail', text); }
      catch (e) { /* the feed line is a courtesy; the availability itself is already saved */ }
    }, 4000);
  }

  // ------------------------------------------------------------- dialogs
  function openPost(prefill) {
    const f = $('#post-form');
    f.reset(); $('#post-error').hidden = true;
    const gm = $('[name=gm]', f); if (!gm.value) gm.value = S.me.name;
    const t = new Date(); t.setDate(t.getDate() + 1);
    const date = $('[name=date]', f); date.value = (prefill && prefill.date) || U.keyOf(t); date.min = U.todayKey();
    const block = (prefill && prefill.block) || 'eve';
    $('#post-block').innerHTML = BLOCKS.map(b => `<option value="${b.key}"${b.key === block ? ' selected' : ''}>${b.label} · ${b.time}</option>`).join('');
    if (prefill) { $('[name=seats]', f).value = prefill.seats; $('[name=minLevel]', f).value = prefill.minLevel; $('[name=maxLevel]', f).value = prefill.maxLevel; }
    $('#post-dialog').showModal();
  }
  async function submitPost(e) {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target).entries()), err = $('#post-error');
    const s = { title: v.title.trim(), region: v.region.trim(), gm: v.gm.trim(), date: v.date, block: v.block,
      seats: +v.seats, minLevel: +v.minLevel, maxLevel: +v.maxLevel, notes: v.notes.trim() };
    const problem = !s.title ? 'Give the expedition a title.' : !s.region ? 'Name the route or region.' : !s.gm ? 'Who is running it?'
      : (!s.date || s.date < U.todayKey()) ? 'Pick a date from today on.' : !(s.seats >= 1) ? 'At least one seat.'
      : s.minLevel > s.maxLevel ? 'Min level is above max level.' : null;
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    try {
      const id = await A.postSession(s);
      $('#post-dialog').close();
      toast(`“${s.title}” is on the board.`, 'ok');
      await A.log('new', `New expedition posted: “${s.title}” — ${when(s)} (GM ${s.gm}).`, { sessionId: id, date: s.date, block: s.block });
    } catch (ex) { err.textContent = ex.message || 'Could not post.'; err.hidden = false; }
  }

  function openProfile() {
    if (!S) return;
    const f = $('#profile-form'); $('#profile-error').hidden = true;
    $('[name=name]', f).value = S.me.name || '';
    $('[name=handle]', f).value = S.me.handle || '';
    $('[name=discord]', f).value = S.me.discord || '';
    $('#char-rows').innerHTML = (S.me.characters.length ? S.me.characters : [{}]).map(charRow).join('');
    $('#profile-dialog').showModal();
  }
  function charRow(c) {
    return `<div class="char-row" data-cid="${esc(c.id || '')}">
      <input name="cname" placeholder="Character name" maxlength="40" value="${esc(c.name || '')}" aria-label="Character name">
      <input name="cclass" placeholder="Class" maxlength="24" value="${esc(c.class || '')}" aria-label="Class">
      <input name="clevel" type="number" min="1" max="20" value="${esc(c.level || 1)}" aria-label="Level">
      <button type="button" class="char-row__x" data-action="char-remove" aria-label="Remove character">×</button></div>`;
  }
  async function submitProfile(e) {
    e.preventDefault();
    const f = e.target, err = $('#profile-error');
    const name = $('[name=name]', f).value.trim();
    if (!name) { err.textContent = 'Your name is needed — it goes on the seat.'; err.hidden = false; return; }
    const characters = $$('.char-row', f).map(r => ({
      id: r.dataset.cid || 'c' + U.uid(),
      name: $('[name=cname]', r).value.trim(),
      class: $('[name=cclass]', r).value.trim(),
      level: Math.min(20, Math.max(1, +$('[name=clevel]', r).value || 1)),
    })).filter(c => c.name);
    const removed = S.me.characters.filter(c => !characters.some(n => n.id === c.id));
    const stuck = removed.find(c => upcoming().some(s => (s.party || []).some(en => en.charId === c.id && isMine(en))));
    if (stuck) { err.textContent = `${stuck.name} is seated on an upcoming expedition — withdraw first.`; err.hidden = false; return; }
    try {
      await A.saveProfile({ name, handle: $('[name=handle]', f).value.trim().replace(/^@/, ''), discord: $('[name=discord]', f).value.trim(), characters });
      $('#profile-dialog').close();
      toast('Profile saved.', 'ok');
    } catch (ex) { err.textContent = ex.message || 'Could not save.'; err.hidden = false; }
  }

  // ------------------------------------------------------------- alerts
  async function toggleBrowserAlerts() {
    if (!('Notification' in window)) return;
    const prefs = Object.assign({}, S.me.prefs || {});
    const on = !!prefs.browserAlerts && Notification.permission === 'granted';
    if (on) { await A.setPrefs(Object.assign(prefs, { browserAlerts: false })); return; }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      await A.setPrefs(Object.assign(prefs, { browserAlerts: true }));
      try { new Notification('Expedition Board', { body: 'Alerts are on while this tab is open.' }); } catch (e) { /* ignore */ }
    } else renderBrowserAlerts();
  }
  function browserNotify(text) {
    try {
      if (S.me.prefs && S.me.prefs.browserAlerts && 'Notification' in window && Notification.permission === 'granted') new Notification('Expedition Board', { body: text });
    } catch (e) { /* ignore */ }
  }
  // Only dispatches that arrive after the first snapshot can alert — history never does.
  function alertOnNewDispatches() {
    if (!S) return;
    if (seenDispatches === null) { seenDispatches = new Set(S.dispatches.map(d => d.id)); return; }
    for (const d of S.dispatches) {
      if (seenDispatches.has(d.id)) continue;
      seenDispatches.add(d.id);
      if (d.uid !== S.me.uid && concernsMe(d)) browserNotify(d.text);
    }
  }
  function concernsMe(d) {
    const sess = d.sessionId ? byId(d.sessionId) : null;
    const fitsMe = d.date && d.block ? (S.me.availability || []).includes(`${U.weekdayOf(d.date)}-${d.block}`) : false;
    if (d.kind === 'open' && sess && isWatching(sess.id)) return 'watching';
    if (d.kind === 'open' && fitsMe && S.me.prefs && S.me.prefs.alertOnOpenSeat && !(sess && R.myEntry(S.me, sess))) return 'fits';
    if (d.kind === 'new' && fitsMe) return 'fits';
    return null;
  }

  // ---------------------------------------------------------------- feedback
  function toast(text, kind = 'ok') {
    const t = $('#toast');
    t.textContent = text; t.className = `toast toast--${kind} is-on`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('is-on'), 3600);
  }
  function refuse(sessId, reason) {
    toast(reason, 'no');
    const el = $(`.session[data-id="${CSS.escape(sessId)}"]`);
    if (el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
  }

  // ----------------------------------------------------------------- events
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-action],[data-char],[data-chip],[data-open],[data-drop],[data-watch],[data-slot],[data-preset],[data-filter],[data-pchip]');
    if (!t) return;
    const d = t.dataset;
    if (d.action) return doAction(d.action, t);
    if (!S) return;
    if (d.pchip !== undefined) {
      if (ui.party.has(d.pchip)) ui.party.delete(d.pchip); else ui.party.add(d.pchip);
      renderOverlap();
      const again = $(`[data-pchip="${CSS.escape(d.pchip)}"]`); if (again) again.focus({ preventScroll: true });
      return;
    }
    if (d.char !== undefined) return armed === d.char ? disarm() : arm(d.char);
    if (d.chip !== undefined) return withdraw(d.sess, d.chip);
    if (d.open !== undefined) return armed ? place(d.open, armed) : toast('Pick a character first — tap one in your roster, or drag it onto the seat.', 'hint');
    if (d.drop !== undefined) { if (armed) place(d.drop, armed); return; }
    if (d.watch !== undefined) return toggleWatch(d.watch);
    if (d.slot !== undefined) return toggleAvail(d.slot);
    if (d.preset !== undefined) return preset(d.preset);
    if (d.filter !== undefined) { ui.filter = d.filter; renderBoard(); }
  });

  function doAction(name, el) {
    switch (name) {
      case 'sign-in': A.signIn().catch(err => toast(err.message || 'Sign-in failed.', 'no')); break;
      case 'sign-out': A.signOut(); break;
      case 'post-open': openPost(); break;
      case 'post-close': $('#post-dialog').close(); break;
      case 'profile-open': openProfile(); break;
      case 'profile-close': $('#profile-dialog').close(); break;
      case 'char-add': $('#char-rows').insertAdjacentHTML('beforeend', charRow({})); $('#char-rows .char-row:last-child input').focus(); break;
      case 'char-remove': el.closest('.char-row').remove(); break;
      case 'arm-cancel': disarm(); break;
      case 'party-clear': ui.party.clear(); renderOverlap(); break;
      case 'party-request': partyRequest(el.dataset.win); break;
      case 'party-post': openPost(partyPrefill(el.dataset.win)); break;
      case 'mark-read': A.markRead(); break;
      case 'browser-alerts': toggleBrowserAlerts(); break;
      case 'reset':
        // Two clicks within a few seconds — no native confirm(), which sandboxed embeds block.
        if (!A.reset) break;
        if (resetArmedAt && Date.now() - resetArmedAt < 6000) { resetArmedAt = 0; seenDispatches = null; A.reset(); toast('Sample data restored.', 'ok'); }
        else { resetArmedAt = Date.now(); toast('This wipes the changes made in this browser — click “Reset sample data” again to confirm.', 'hint'); }
        break;
      case 'boot-local': $('#boot-error').hidden = true; KS.boot(new KS.LocalAdapter()); break;
    }
  }

  $('#post-form').addEventListener('submit', submitPost);
  $('#profile-form').addEventListener('submit', submitProfile);
  $('#pref-openseat').addEventListener('change', e => A.setPrefs(Object.assign({}, S.me.prefs || {}, { alertOnOpenSeat: e.target.checked })));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && armed) disarm(); });
  document.addEventListener('mouseover', e => { const c = e.target.closest('[data-heat]'); if (c) showHeat(c); });
  document.addEventListener('focusin', e => { const c = e.target.closest('[data-heat]'); if (c) showHeat(c); });
  function showHeat(c) {
    const missing = c.dataset.missing;
    $('#overlap-detail').textContent = `${slotLabel(c.dataset.heat)}: ${c.dataset.names || 'nobody yet'}${missing ? ` — not ${missing}` : ''}`;
  }
  setInterval(() => { if (S) renderDispatches(); }, 60000);

  // ------------------------------------------------------------ drag & drop
  // HTML5 DnD for pointers; touch devices use tap-to-arm (see the click handler above).
  document.addEventListener('dragstart', e => {
    const el = e.target.closest ? e.target.closest('[data-char],[data-chip]') : null;
    if (!el || !S) return;
    dragging = el.dataset.char !== undefined
      ? { kind: 'char', charId: el.dataset.char }
      : { kind: 'chip', charId: el.dataset.chip, sessId: el.dataset.sess };
    try { e.dataTransfer.setData('text/plain', `${dragging.kind}:${dragging.charId}`); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* ignore */ }
    el.classList.add('is-dragging');
    document.body.classList.add(`is-dragging-${dragging.kind}`);
    disarm();
  });
  document.addEventListener('dragend', endDrag);
  function clearZone(z) { z.classList.remove('drop-ok', 'drop-no'); z.removeAttribute('data-reason'); }
  function endDrag() {
    dragging = null;
    document.body.classList.remove('is-dragging-char', 'is-dragging-chip');
    $$('.is-dragging').forEach(el => el.classList.remove('is-dragging'));
    $$('.drop-ok,.drop-no').forEach(clearZone);
  }
  document.addEventListener('dragover', e => {
    if (!dragging || !S) return;
    const zone = e.target.closest('[data-drop]'), roster = e.target.closest('#roster-zone');
    $$('.drop-ok,.drop-no').forEach(z => { if (z !== zone && z !== roster) clearZone(z); });
    if (zone) {
      if (dragging.kind === 'chip' && zone.dataset.drop === dragging.sessId) return;
      const sess = byId(zone.dataset.drop), ch = myChar(dragging.charId);
      if (!sess || !ch) return;
      e.preventDefault();
      const v = R.eligibility(S, sess, ch, dragging.kind === 'chip' ? { ignoreSessId: dragging.sessId } : {});
      zone.classList.toggle('drop-ok', v.ok); zone.classList.toggle('drop-no', !v.ok);
      if (v.ok) zone.removeAttribute('data-reason'); else zone.dataset.reason = v.reason;
      e.dataTransfer.dropEffect = v.ok ? 'move' : 'none';
    } else if (roster && dragging.kind === 'chip') {
      e.preventDefault();
      roster.classList.add('drop-ok');
      e.dataTransfer.dropEffect = 'move';
    }
  });
  document.addEventListener('dragleave', e => {
    const zone = e.target.closest('[data-drop]');
    if (zone && !(e.relatedTarget && zone.contains(e.relatedTarget))) clearZone(zone);
    const roster = e.target.closest('#roster-zone');
    if (roster && !(e.relatedTarget && roster.contains(e.relatedTarget))) roster.classList.remove('drop-ok');
  });
  document.addEventListener('drop', e => {
    if (!dragging || !S) return;
    const zone = e.target.closest('[data-drop]'), roster = e.target.closest('#roster-zone'), drag = dragging;
    if (zone) {
      e.preventDefault();
      if (drag.kind === 'char') place(zone.dataset.drop, drag.charId);
      else if (zone.dataset.drop !== drag.sessId) move(drag.sessId, zone.dataset.drop, drag.charId);
    } else if (roster && drag.kind === 'chip') {
      e.preventDefault();
      withdraw(drag.sessId, drag.charId);
    }
    endDrag();
  });
})();
