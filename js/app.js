/* Expedition Board — UI.
   Talks to the world only through an adapter (local-adapter.js / firebase-adapter.js).
   State arrives via onState and is treated as read-only here; every change is an adapter call.

   Roles: a player has a roster, proposes expeditions and joins them; a GM (flagged on the
   allowlist) has no roster, posts dated expeditions, schedules proposals, locks and cancels.

   Availability: a weekly pattern is the baseline; per-date exceptions override it for one
   date and block. Everything that asks "is X free then" goes through KS.rules.freeOn. */
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
  let toastTimer = null, profileOpenedOnce = false, resetArmedAt = 0;
  let announceIdx = 0, announceTimer = null, announcePaused = false, announceStepped = false;
  let pendingConfirm = null;     // { key, at } — two-click confirmation for destructive actions
  const ui = { filter: 'all', party: new Set(), availTab: 'pattern', availWeek: null, overlapWeek: null, dispShowAll: false };

  const KIND = { new: 'Posted', proposal: 'Proposed', scheduled: 'Scheduled', edited: 'Changed', cancelled: 'Cancelled', lock: 'Roster', seat: 'Seated', open: 'Seat open', full: 'Full', avail: 'Availability', watch: 'Watching', alert: 'Alert', request: 'Request', note: 'Note' };
  const fmtDay  = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  const fmtDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const fmtLong = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const when = s => `${fmtLong.format(U.parseKey(s.date))}, ${U.blockOf(s.block).label}`;
  const dateLabel = k => fmtLong.format(U.parseKey(k));
  const stampLabel = (k, b) => `${fmtLong.format(U.parseKey(k))} ${U.blockOf(b).label}`;
  const byId = id => (S && S.sessions.find(s => s.id === id)) || null;
  const myChar = id => (S && S.me.characters.find(c => c.id === id)) || null;
  const isGM = () => !!(S && S.me && S.me.gm);
  const gmUids = () => (S && S.gmUids) || [];
  const live = () => S.sessions.filter(R.isLive);
  const upcoming = () => U.sortSessions(live().filter(s => !R.isProposal(s) && !R.isPast(s)));
  const proposals = () => live().filter(R.isProposal).sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));
  const isWatching = id => (S.me.watching || []).includes(id);
  const isMine = e => e.uid === S.me.uid;
  const firstWeek = () => U.thisMonday();
  const lastWeek = () => U.addDays(U.thisMonday(), (KS.HORIZON_WEEKS - 1) * 7);

  // ------------------------------------------------------------------ boot
  KS.boot = function (adapter) {
    if (KS.booted) return;
    KS.booted = true; A = adapter;
    ui.availWeek = ui.overlapWeek = U.thisMonday();
    A.start({
      onState(state) { S = state; render(); alertOnNewDispatches(); },
      onStatus(st) {
        status = st; renderStatus();
        if (st.firstRun && !profileOpenedOnce) { profileOpenedOnce = true; setTimeout(openProfile, 400); }
      },
    });
  };
  // Module scripts can't load from file://, so a double-clicked index.html runs the local demo.
  if (location.protocol === 'file:') KS.boot(new KS.LocalAdapter({}));
  setTimeout(() => { if (!KS.booted) $('#boot-error').hidden = false; }, 8000);

  // ---------------------------------------------------------------- render
  function render() {
    if (!S) return;
    document.body.classList.toggle('is-gm', isGM());
    const a = document.activeElement, d = a && a.dataset;
    const keep = d ? (d.slot ? `[data-slot="${d.slot}"]` : d.ex ? `[data-ex="${d.ex}"]` : d.filter ? `[data-filter="${d.filter}"]` : d.watch ? `[data-watch="${d.watch}"]` : d.char ? `[data-char="${d.char}"]` : null) : null;
    renderUser(); renderRoster(); renderAvailability(); renderBoard(); renderAnnounce(); renderDispatches(); renderOverlap(); renderMeta(); renderArm();
    if (KS.renderGcal) KS.renderGcal();
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
    const me = S.me, n = me.characters.length, gm = isGM();
    $('#user-h').textContent = gm ? 'Running the table' : 'Signed in';
    $('#user-role').textContent = gm ? 'GM' : 'Player';
    $('#user-initials').textContent = U.initials(me.name);
    $('#user-name').textContent = me.name || '—';
    $('#user-sub').textContent = [me.handle ? '@' + me.handle : '', me.discord].filter(Boolean).join(' · ');
    $('#user-chars').textContent = `${n} character${n === 1 ? '' : 's'}`;
    $('#gm-proposals').textContent = proposals().length;
    $('#avail-h').textContent = gm ? 'When I can run' : 'My availability';
    $('#avail-hint').textContent = ui.availTab === 'dates'
      ? (gm ? 'Dates override your usual week. Block one you can’t run, open one you normally couldn’t.'
            : 'Dates override your usual week. Block one you’re away for, open one you normally couldn’t make.')
      : (gm ? 'The windows you can usually run. The overlap grid dims everything else, and proposals are scheduled against these.'
            : 'The windows you can usually play. Expeditions landing in one are stamped “Fits you”, and everyone’s windows feed the overlap grid.');
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

  // ---- availability: usual week + specific dates ---------------------------
  function renderAvailability() {
    const av = S.me.availability || [], ex = S.me.exceptions || {};
    const nEx = Object.keys(ex).length;
    $('#avail-count').textContent = ui.availTab === 'dates'
      ? (nEx ? `${nEx} override${nEx === 1 ? '' : 's'}` : 'No overrides')
      : `${av.length} / ${DAYS.length * BLOCKS.length}`;
    $$('[data-avtab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.avtab === ui.availTab)));
    $('#avail-pattern').hidden = ui.availTab !== 'pattern';
    $('#avail-dates').hidden = ui.availTab !== 'dates';

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

    renderAvailDates();
  }

  function renderAvailDates() {
    const me = S.me, week = ui.availWeek, dates = U.weekOf(week), today = U.todayKey(), ex = me.exceptions || {};
    $('#avail-week-label').textContent = weekLabel(week);
    $$('[data-week^="avail:"]').forEach(b => {
      const dir = +b.dataset.week.split(':')[1];
      b.disabled = dir < 0 ? week <= firstWeek() : week >= lastWeek();
    });
    let html = `<table class="grid avail"><thead><tr><th scope="col" class="grid__corner"></th>${dates.map((k, i) => {
      const past = k < today;
      return `<th scope="col" class="${past ? 'is-past' : ''}${k === today ? ' is-today' : ''}"><span class="grid__dow">${DAYS[i].short}</span><span class="grid__dom">${U.parseKey(k).getDate()}</span></th>`;
    }).join('')}</tr></thead><tbody>`;
    for (const b of BLOCKS) {
      html += `<tr><th scope="row" title="${esc(b.label)}"><span class="grid__block">${esc(b.short || b.label)}</span></th>`;
      for (const k of dates) {
        const past = k < today, free = R.freeOn(me, k, b.key), over = R.overridden(me, k, b.key);
        const cal = !over && R.calendarBusy(me, k, b.key);
        const mins = cal ? R.calendarBusyMins(me, k, b.key) : 0;
        const why = over ? ` — set by hand (usually ${R.inPattern(me, k, b.key) ? 'free' : 'not free'})`
          : cal ? ` — Google Calendar busy${mins ? ` ${mins} of ${U.blockMins(b)} min` : ''}; click to override` : '';
        html += `<td>${past
          ? '<span class="avail__cell avail__cell--past" aria-hidden="true"></span>'
          : `<button type="button" class="avail__cell${over ? ' avail__cell--over' : ''}${cal ? ' avail__cell--cal' : ''}" data-ex="${k}-${b.key}" aria-pressed="${free}" aria-label="${dateLabel(k)} ${b.label}${over ? ', set by hand' : cal ? ', busy in Google Calendar' : ''}" title="${dateLabel(k)} ${b.label}${why}"></button>`}</td>`;
      }
      html += '</tr>';
    }
    $('#avail-date-grid').innerHTML = html + '</tbody></table>';
    // Name the overridden dates rather than counting them — a bare count is confusing when
    // none of them fall in the week on screen.
    const keys = Object.keys(ex).sort();
    $('#avail-ex-count').textContent = keys.length
      ? 'Overriding ' + keys.slice(0, 3).map(k => `${fmtDate.format(U.parseKey(k.slice(0, 10)))} ${U.blockOf(k.slice(11)).short}${ex[k] ? '' : ' ✕'}`).join(', ')
        + (keys.length > 3 ? ` +${keys.length - 3} more` : '')
      : 'No overrides — your usual week applies.';
    $('#avail-ex-clear').hidden = !keys.length;
  }

  function weekLabel(mondayKey) {
    const a = U.parseKey(mondayKey), b = U.parseKey(U.addDays(mondayKey, 6));
    const sameMonth = a.getMonth() === b.getMonth();
    return sameMonth ? `${fmtDate.format(a)} – ${b.getDate()}` : `${fmtDate.format(a)} – ${fmtDate.format(b)}`;
  }

  function renderBoard() {
    const list = upcoming(), props = proposals(), gm = isGM();
    const shown = list.filter(s => ui.filter === 'fit' ? R.fits(S.me, s) : ui.filter === 'open' ? R.openSeats(s) > 0 : true);
    $('#stat-upcoming').textContent = list.length;
    $('#stat-open').textContent = list.reduce((n, s) => n + R.openSeats(s), 0);
    $('#stat-fit').textContent = list.filter(s => R.fits(S.me, s)).length;
    $('#stat-mine').textContent = gm ? list.filter(s => s.gmUid === S.me.uid).length : list.filter(s => R.myEntry(S.me, s)).length;
    $('#stat-mine-label').textContent = gm ? 'You’re running' : 'Your commitments';
    $$('.filters button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === ui.filter)));
    $('#board-count').textContent = `${shown.length} of ${list.length}`;
    let html = '';
    if (props.length) {
      html += `<h3 class="day day--proposals"><span class="day__name">Proposed</span><span class="day__date">${gm ? 'waiting for you' : 'waiting for a GM'}</span><span class="day__count">${props.length} proposal${props.length === 1 ? '' : 's'}</span></h3>`
        + props.map(sessionHTML).join('');
    }
    if (!shown.length) html += emptyState(list.length, props.length);
    else {
      let lastDate = null;
      for (const s of shown) {
        if (s.date !== lastDate) {
          lastDate = s.date;
          const d = U.parseKey(s.date), n = shown.filter(x => x.date === s.date).length;
          html += `<h3 class="day"><span class="day__name">${esc(fmtDay.format(d))}</span><span class="day__date">${esc(fmtDate.format(d))}</span><span class="day__count">${n} expedition${n === 1 ? '' : 's'}</span></h3>`;
        }
        html += sessionHTML(s);
      }
    }
    $('#board-list').innerHTML = html;
  }

  function sessionHTML(s) {
    const prop = R.isProposal(s), gm = isGM(), party = s.party || [];
    const b = prop ? null : U.blockOf(s.block), open = R.openSeats(s), mine = R.myEntry(S.me, s), fit = R.fits(S.me, s);
    const isProposer = prop && s.proposerUid === S.me.uid;
    const seatOf = e => isMine(e)
      ? `<button type="button" class="seat seat--mine" draggable="true" data-chip="${esc(e.charId)}" data-sess="${esc(s.id)}" title="${esc(e.name)} · Lvl ${esc(e.level)} · you — click to withdraw" aria-label="Withdraw ${esc(e.name)} from ${esc(s.title)}">${esc(U.initials(e.name))}</button>`
      : gm
        ? `<button type="button" class="seat seat--filled seat--other" data-gmremove="${esc(e.charId)}" data-gmuid="${esc(e.uid)}" data-sess="${esc(s.id)}" title="${esc(e.name)} · Lvl ${esc(e.level)} · ${esc(e.owner || '')} — click to take off the roster" aria-label="Remove ${esc(e.name)} from ${esc(s.title)}">${esc(U.initials(e.name))}</button>`
        : `<span class="seat seat--filled" tabindex="0" title="${esc(e.name)} · Lvl ${esc(e.level)} · ${esc(e.owner || '')}">${esc(U.initials(e.name))}</span>`;
    const openSeat = `<button type="button" class="seat seat--open" data-open="${esc(s.id)}" aria-label="Open seat on ${esc(s.title)} — place a character">+</button>`;
    const seats = party.map(seatOf);
    if (prop) { if (!gm && !mine) seats.push(openSeat); }
    else for (let i = party.length; i < s.seats; i++) seats.push(openSeat);

    const names = party.map(e => `<span class="${isMine(e) ? 'party__me' : ''}">${esc(e.name)} <small>${esc(e.level)}</small></span>`).join('<span class="party__sep">·</span>');
    const stamps = [];
    if (prop) {
      stamps.push(isProposer ? '<li class="stamp stamp--in">Your proposal</li>' : '<li class="stamp stamp--gm">Needs a GM</li>');
      if (mine && !isProposer) stamps.push('<li class="stamp stamp--in">You’re in</li>');
    } else {
      if (mine) stamps.push('<li class="stamp stamp--in">You’re in</li>'); else if (fit) stamps.push('<li class="stamp stamp--fit">Fits you</li>');
      if (open === 0) stamps.push('<li class="stamp stamp--full">Full</li>');
      if (s.locked) stamps.push('<li class="stamp stamp--full">Locked</li>');
      if (gm && s.gmUid === S.me.uid) stamps.push('<li class="stamp stamp--gm">You run this</li>');
    }
    let prefer = '';
    if (prop) {
      const hits = bestDates(party.map(e => e.uid), 2);
      prefer = `<p class="session__prefer">${hits.length
        ? `Everyone joined can make <strong>${hits.map(h => esc(stampLabel(h.date, h.block))).join('</strong> or <strong>')}</strong>`
        : 'No date in the next few weeks suits everyone joined'}.</p>`;
    }
    const whenCol = prop
      ? `<span class="session__block">Proposed</span><span class="session__time">${esc(relTime(s.postedAt || 0))}</span>`
      : `<span class="session__block">${esc(b.label)}</span><span class="session__time">${esc(b.time)}</span>`;
    const meta = prop
      ? `${esc(s.region)}<span class="sep">·</span>proposed by ${esc(s.proposer || '')}`
      : `${esc(s.region)}<span class="sep">·</span>GM ${esc(s.gm)}<span class="sep">·</span>${esc(s.seats)} seats`;
    const band = prop
      ? `<span class="label">Levels</span><strong title="Set when a GM schedules it">—</strong>`
      : `<span class="label">Levels</span><strong>${esc(s.minLevel)}–${esc(s.maxLevel)}</strong>`;
    const count = prop ? `${party.length} joined` : `${party.length} of ${esc(s.seats)} seated${open ? ` · <strong>${open} open</strong>` : ''}`;
    const acts = [`<button type="button" class="watch" data-watch="${esc(s.id)}" aria-pressed="${isWatching(s.id)}" title="${prop ? 'Get a dispatch when this is scheduled' : 'Get a dispatch when a seat opens here'}">${isWatching(s.id) ? 'Watching' : 'Watch'}</button>`];
    // Players get a no-auth "add to my calendar" link on expeditions they are seated on.
    if (!prop && mine && !gm && KS.gcalTemplateUrl) {
      acts.push(`<a class="session__cal" href="${esc(KS.gcalTemplateUrl(s))}" target="_blank" rel="noopener" title="Opens a pre-filled event in Google Calendar">+ Calendar</a>`);
    }
    if (gm) acts.push(prop
      ? `<div class="session__gm"><button type="button" class="btn btn--sm btn--primary" data-action="schedule-open" data-sess="${esc(s.id)}">Schedule</button><button type="button" class="btn btn--sm btn--ghost" data-action="decline" data-sess="${esc(s.id)}">Decline</button></div>`
      : `<div class="session__gm"><button type="button" class="btn btn--sm" data-action="edit-open" data-sess="${esc(s.id)}">Edit</button><button type="button" class="btn btn--sm" data-action="toggle-lock" data-sess="${esc(s.id)}">${s.locked ? 'Unlock' : 'Lock roster'}</button><button type="button" class="btn btn--sm btn--ghost" data-action="cancel" data-sess="${esc(s.id)}">Cancel</button></div>`);
    else if (isProposer) acts.push(`<div class="session__gm"><button type="button" class="btn btn--sm btn--ghost" data-action="withdraw-proposal" data-sess="${esc(s.id)}">Withdraw</button></div>`);

    return `<article class="session${prop ? ' session--proposal' : ''}${mine ? ' session--mine' : ''}${open === 0 ? ' session--full' : ''}" data-id="${esc(s.id)}">
      <div class="session__when">${whenCol}</div>
      <div class="session__body">
        <h4 class="session__title">${esc(s.title)}</h4>
        <p class="session__meta">${meta}</p>
        ${s.notes ? `<p class="session__notes">${esc(s.notes)}</p>` : ''}
        ${names ? `<p class="party">${names}</p>` : ''}
        ${prefer}
        ${stamps.length ? `<ul class="stamps">${stamps.join('')}</ul>` : ''}
      </div>
      <div class="session__band">${band}</div>
      <div class="session__seats">
        <div class="seats" data-drop="${esc(s.id)}" role="group" aria-label="Seats on ${esc(s.title)}">${seats.join('')}</div>
        <p class="seats__count">${count}</p>
      </div>
      <div class="session__actions">${acts.join('')}</div>
    </article>`;
  }

  function emptyState(total, propsN) {
    if (!total) {
      const lead = isGM()
        ? (propsN ? 'Schedule a proposal above, or post an expedition of your own.' : 'Post an expedition, or wait for a proposal to come in.')
        : (propsN ? 'No dated expeditions yet — join a proposal above, or propose your own.' : 'No expeditions yet. Propose one and the GM will schedule it.');
      return `<div class="empty"><h4>${propsN ? 'Nothing scheduled yet' : 'Nothing on the board'}</h4><p>${lead}${status.mode === 'local' ? ' The sample dates may have passed — <button type="button" class="linklike" data-action="reset">reset the sample data</button>.' : ''}</p></div>`;
    }
    return `<div class="empty"><h4>Nothing fits those filters</h4><p>Try widening your availability, or show all expeditions.</p></div>`;
  }

  // ---- GM announcements ---------------------------------------------------
  // One line under the masthead. With several it steps between them; with reduced motion it
  // lists them instead of moving. Hover pauses. Gone entirely when there is nothing to show.
  const liveAnnouncements = () => {
    const today = U.todayKey();
    return (S.announcements || []).filter(a => a && a.text && (!a.until || a.until >= today));
  };
  const reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  function renderAnnounce() {
    const el = $('#announce'), list = liveAnnouncements();
    if (!list.length) { el.hidden = true; el.innerHTML = ''; stopAnnounce(); return; }
    el.hidden = false;
    if (announceIdx >= list.length) announceIdx = 0;
    const gmEdit = isGM() ? '<button type="button" class="announce__edit" data-action="announce-open">Manage</button>' : '';
    if (reduceMotion()) {
      el.innerHTML = `<span class="announce__label">${list.length > 1 ? `${list.length} notices` : 'Notice'}</span>`
        + `<div class="announce__all">${list.map(a => `<p>${esc(a.text)} <span class="announce__who">— ${esc(a.author || 'GM')}</span></p>`).join('')}</div>${gmEdit}`;
      stopAnnounce();
      return;
    }
    const a = list[announceIdx];
    const dots = list.length > 1
      ? `<span class="announce__dots">${list.map((_, i) => `<button type="button" data-announce-go="${i}" aria-current="${i === announceIdx}" aria-label="Notice ${i + 1} of ${list.length}"></button>`).join('')}</span>`
      : '';
    el.innerHTML = `<span class="announce__label">Notice</span>`
      + `<p class="announce__text${announceStepped ? ' is-stepping' : ''}">${esc(a.text)} <span class="announce__who">— ${esc(a.author || 'GM')}</span></p>`
      + dots + gmEdit;
    announceStepped = false;
    if (list.length > 1) startAnnounce(); else stopAnnounce();
  }
  function startAnnounce() {
    stopAnnounce();
    announceTimer = setInterval(() => {
      if (announcePaused) return;
      const list = liveAnnouncements();
      if (list.length < 2) return stopAnnounce();
      announceIdx = (announceIdx + 1) % list.length;
      announceStepped = true;
      renderAnnounce();
    }, 6000);
  }
  function stopAnnounce() { if (announceTimer) { clearInterval(announceTimer); announceTimer = null; } }

  function openAnnounce() {
    const f = $('#announce-form');
    f.reset(); $('#announce-error').hidden = true;
    $('[name=until]', f).min = U.todayKey();
    renderAnnounceList();
    $('#announce-dialog').showModal();
  }
  function renderAnnounceList() {
    const today = U.todayKey();
    $('#announce-list').innerHTML = (S.announcements || []).map(a => {
      const gone = a.until && a.until < today;
      return `<li><span>${esc(a.text)}<small>${esc(a.author || 'GM')} · ${gone ? 'expired' : a.until ? `until ${fmtDate.format(U.parseKey(a.until))}` : 'no end date'}</small></span>
        <button type="button" class="char-row__x" data-action="announce-remove" data-ann="${esc(a.id)}" aria-label="Take this announcement down">×</button></li>`;
    }).join('') || '<li class="empty-line">Nothing posted.</li>';
  }
  async function submitAnnounce(e) {
    e.preventDefault();
    const f = e.target, err = $('#announce-error');
    const text = $('[name=text]', f).value.trim();
    let until = $('[name=until]', f).value;
    if (!text) { err.textContent = 'Write the announcement first.'; err.hidden = false; return; }
    if (until && until < U.todayKey()) { err.textContent = 'That date has already passed.'; err.hidden = false; return; }
    if (!until) until = U.addDays(U.todayKey(), 14);        // two weeks unless told otherwise
    try {
      await A.postAnnouncement({ text, until });
      f.reset(); err.hidden = true;
      announceIdx = 0;
      toast('Posted to the top of the board.', 'ok');
      renderAnnounceList();
    } catch (ex) { err.textContent = ex.message || 'Could not post it.'; err.hidden = false; }
  }
  function removeAnnounce(id) {
    confirmTwice('ann:' + id, 'Take that announcement down?', async () => {
      try { await A.removeAnnouncement(id); toast('Taken down.', 'ok'); renderAnnounceList(); }
      catch (err) { toast(err.message || 'Could not remove it.', 'no'); }
    });
  }

  function renderDispatches() {
    const readAt = S.me.readAt || 0;
    const unread = S.dispatches.filter(d => d.ts > readAt);
    const list = (ui.dispShowAll ? S.dispatches : unread).slice(0, 40);
    $('#disp-unread').textContent = unread.length ? `${unread.length} new` : 'Up to date';
    $('#disp-toggle').textContent = ui.dispShowAll ? 'Unread only' : 'Show all';
    $('#disp-toggle').hidden = !ui.dispShowAll && !S.dispatches.length;
    $('#dispatches').innerHTML = list.map(d => {
      const forMe = d.uid !== S.me.uid && concernsMe(d);
      return `<li class="disp disp--${esc(d.kind)}${d.ts > readAt ? ' disp--unread' : ''}${forMe ? ' disp--forme' : ''}">
        <span class="disp__meta"><span class="disp__kind">${forMe ? 'For you · ' : ''}${esc(KIND[d.kind] || d.kind)}</span><time class="disp__time" datetime="${new Date(d.ts).toISOString()}">${esc(relTime(d.ts))}</time></span>
        <span class="disp__text">${esc(d.text)}</span></li>`;
    }).join('') || (ui.dispShowAll
      ? '<li class="disp disp--empty">Nothing yet.</li>'
      : `<li class="disp disp--empty">Nothing new.${S.dispatches.length ? ' <button type="button" class="linklike" data-action="disp-toggle">Show all</button>' : ''}</li>`);
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
  // The heatmap runs over real dates, a week at a time. With nothing picked it shows every
  // player; pick characters and it narrows to their players — ringed cells are dates where
  // all of them are free. Cells no GM can run are dimmed.
  const partyKey = (uid, charId) => `${uid}:${charId || ''}`;
  function peopleList() {
    return [
      Object.assign({}, S.me, { me: true, name: S.me.name, characters: S.me.characters || [] }),
      ...S.players.filter(p => p.uid !== S.me.uid).map(p => Object.assign({}, p, { me: false, name: p.name || 'Unnamed', characters: p.characters || [] })),
    ];
  }
  const isGMuid = p => p.gm || gmUids().includes(p.uid);
  const playersOnly = () => peopleList().filter(p => !isGMuid(p));
  const gmList = () => peopleList().filter(isGMuid);
  function gmFreeOn(dateKey, block) {
    const gms = gmList();
    if (!gms.length) return true;                       // no GM windows known yet — dim nothing
    return gms.some(g => R.freeOn(g, dateKey, block));
  }
  const anyGMWindows = () => gmList().some(g => (g.availability || []).length || Object.keys(g.exceptions || {}).length);

  // Every date+block in the horizon where all of `uids` are free and a GM could run it.
  function bestDates(uids, limit = 3) {
    const people = peopleList().filter(p => uids.includes(p.uid));
    if (!people.length) return [];
    const out = [];
    for (const date of U.horizon()) {
      for (const b of BLOCKS) {
        if (!people.every(p => R.freeOn(p, date, b.key))) continue;
        if (!gmFreeOn(date, b.key)) continue;
        out.push({ date, block: b.key });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
  function partyGroup(people) {
    const owners = new Set([...ui.party].map(k => k.split(':')[0]));
    const group = people.filter(p => owners.has(p.uid));
    const chars = [];
    people.forEach(p => (p.characters || []).forEach(c => { if (ui.party.has(partyKey(p.uid, c.id))) chars.push(Object.assign({}, c, { uid: p.uid, owner: p.name })); }));
    return { group, chars };
  }
  const listNames = arr => arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;

  function renderOverlap() {
    const people = playersOnly(), { group } = partyGroup(people);
    const active = group.length >= 2, who = active ? group : people;
    const week = ui.overlapWeek, dates = U.weekOf(week), today = U.todayKey();
    const dim = anyGMWindows(), gm = isGM(), total = who.length;
    $('#overlap-week-label').textContent = weekLabel(week);
    $$('[data-week^="overlap:"]').forEach(b => {
      const dir = +b.dataset.week.split(':')[1];
      b.disabled = dir < 0 ? week <= firstWeek() : week >= lastWeek();
    });
    const nameOf = p => p.me ? `${p.name} (you)` : p.name;
    const bucket = n => n === 0 || !total ? 0 : n / total <= .25 ? 1 : n / total <= .5 ? 2 : n / total <= .75 ? 3 : 4;

    let html = `<table class="grid heat"><thead><tr><th scope="col" class="grid__corner"></th>${dates.map((k, i) => {
      const past = k < today;
      return `<th scope="col" class="${past ? 'is-past' : ''}${k === today ? ' is-today' : ''}"><span class="grid__dow">${DAYS[i].short}</span><span class="grid__dom">${U.parseKey(k).getDate()}</span></th>`;
    }).join('')}</tr></thead><tbody>`;
    for (const b of BLOCKS) {
      html += `<tr><th scope="row" title="${esc(b.label)}"><span class="grid__block">${esc(b.short || b.label)}</span></th>`;
      for (const k of dates) {
        const past = k < today;
        const free = who.filter(p => R.freeOn(p, k, b.key));
        const n = free.length, me = R.freeOn(S.me, k, b.key);
        const all = active && n === total && total > 0, out = dim && !gmFreeOn(k, b.key);
        const missing = active ? who.filter(p => !free.includes(p)).map(nameOf) : [];
        html += `<td class="heat__cell h${bucket(n)}${me ? ' heat__cell--me' : ''}${all ? ' heat__cell--all' : ''}${out ? ' heat__cell--out' : ''}${past ? ' heat__cell--past' : ''}" tabindex="0" data-date="${k}" data-block="${b.key}" data-names="${esc(free.map(nameOf).join(', '))}" data-missing="${esc(missing.join(', '))}" data-out="${out ? '1' : ''}" aria-label="${dateLabel(k)} ${b.label}: ${n} of ${total} free${out ? ', no GM available' : ''}">${past ? '' : n}</td>`;
      }
      html += '</tr>';
    }
    $('#overlap').innerHTML = html + '</tbody></table>';
    $('#overlap-total').textContent = active ? `${total} players picked` : `${total} player${total === 1 ? '' : 's'}`;
    $('#overlap-note').textContent = dim
      ? (gm ? 'Dimmed cells are outside the windows you can run — set those under “When I can run”.' : 'Dimmed cells are ones no GM can run.')
      : (gm ? 'Mark when you can run and the grid will dim everything else.' : 'No GM has marked windows yet, so nothing is dimmed.');

    // Ranked dates across the whole horizon, not just the visible week.
    const ranked = [];
    for (const date of U.horizon()) {
      for (const b of BLOCKS) {
        if (dim && !gmFreeOn(date, b.key)) continue;
        const n = who.filter(p => R.freeOn(p, date, b.key)).length;
        if (n >= (active ? Math.max(2, total - 1) : 1)) ranked.push({ date, block: b.key, n });
      }
    }
    ranked.sort((a, x) => x.n - a.n || (a.date < x.date ? -1 : a.date > x.date ? 1 : U.blockIndex(a.block) - U.blockIndex(x.block)));
    if (active) {
      $('#best-label').textContent = 'Dates for this party';
      $('#best-windows').innerHTML = ranked.slice(0, 6).map(r => {
        const missing = who.filter(p => !R.freeOn(p, r.date, r.block)).map(nameOf);
        return `<li class="${r.n === total ? 'best--all' : ''}"><span class="best__name">${esc(stampLabel(r.date, r.block))}${missing.length ? `<small>without ${esc(listNames(missing))}</small>` : ''}</span><strong>${r.n === total ? `All ${total}` : `${r.n} of ${total}`}</strong>
          <div class="best__act"><button type="button" class="btn btn--sm player-only" data-action="party-request" data-date="${r.date}" data-block="${r.block}">Request an expedition</button><button type="button" class="btn btn--sm gm-only" data-action="party-post" data-date="${r.date}" data-block="${r.block}">Post here</button></div></li>`;
      }).join('') || '<li><span class="best__name">No date in the next few weeks suits this party — someone needs to open a date, or widen their usual week.</span></li>';
    } else {
      $('#best-label').textContent = 'Best dates to post';
      $('#best-windows').innerHTML = ranked.slice(0, 3).map(r => `<li><span class="best__name">${esc(stampLabel(r.date, r.block))}</span><strong>${r.n} of ${total}</strong></li>`).join('')
        || '<li><span class="best__name">No one has marked availability yet.</span></li>';
    }
    renderPartyChips(people, group);
  }

  function renderPartyChips(people, group) {
    $('#party-chips').innerHTML = people.map(p => {
      const chars = p.characters || [];
      const chips = chars.length
        ? chars.map(c => { const k = partyKey(p.uid, c.id); return `<button type="button" class="chip" aria-pressed="${ui.party.has(k)}" data-pchip="${esc(k)}">${esc(c.name)} <small>${esc(c.level)}</small></button>`; }).join('')
        : (() => { const k = partyKey(p.uid, ''); return `<button type="button" class="chip" aria-pressed="${ui.party.has(k)}" data-pchip="${esc(k)}">${esc(p.name)} <small>no characters yet</small></button>`; })();
      return `<div class="chips__group"><span class="chips__owner">${p.me ? 'You' : esc(p.name)}</span>${chips}</div>`;
    }).join('') || '<p class="hint hint--inline">No players have signed in yet.</p>';
    const n = ui.party.size;
    $('#party-summary').textContent = n ? `${n} picked` : 'Pick a party';
    $('#party-clear').hidden = !n;
    $('#party-hint').textContent = !n ? 'Pick two or more characters to see when their players line up.'
      : group.length < 2 ? 'Add a character from another player.'
      : 'Ringed cells: everyone picked is free. The list below ranks dates across the next few weeks.';
    if (n) $('#party-picker').open = true;
  }

  async function partyRequest(date, block) {
    const { group, chars } = partyGroup(playersOnly());
    if (group.length < 2) return;
    const here = group.filter(p => R.freeOn(p, date, block)), away = group.filter(p => !R.freeOn(p, date, block));
    const levels = chars.map(c => c.level), band = levels.length ? ` (levels ${Math.min(...levels)}–${Math.max(...levels)})` : '';
    const text = `${listNames(here.map(p => p.name))} can make ${stampLabel(date, block)}${away.length ? ` — ${listNames(away.map(p => p.name))} can't` : ''}${band} — and would like an expedition.`;
    try { await A.log('request', text, { date, block, party: group.map(p => p.uid) }); toast('Request posted — the GM will see it in Dispatches.', 'ok'); }
    catch (err) { toast(err.message || 'Could not post the request.', 'no'); }
  }
  function prefillFor(date, block, levels, count) {
    return { date, block, seats: Math.max(4, count), minLevel: levels.length ? Math.min(...levels) : 1, maxLevel: levels.length ? Math.max(...levels) : 5 };
  }
  function partyPrefill(date, block) {
    const { chars } = partyGroup(playersOnly());
    return prefillFor(date, block, chars.map(c => c.level), chars.length);
  }
  function schedulePrefill(s) {
    const party = s.party || [], levels = party.map(e => e.level), hits = bestDates(party.map(e => e.uid), 1);
    const base = hits.length ? prefillFor(hits[0].date, hits[0].block, levels, party.length)
      : { date: null, block: 'eve', seats: Math.max(4, party.length), minLevel: levels.length ? Math.min(...levels) : 1, maxLevel: levels.length ? Math.max(...levels) : 5 };
    return Object.assign(base, { sessionId: s.id, title: s.title, region: s.region, notes: s.notes || '', joined: party.length, hasWindow: hits.length > 0 });
  }
  // Reopen a scheduled expedition in the same dialog to move or correct it.
  function editPrefill(s) {
    return { mode: 'edit', sessionId: s.id, title: s.title, region: s.region, notes: s.notes || '',
      date: s.date, block: s.block, seats: s.seats, minLevel: s.minLevel, maxLevel: s.maxLevel };
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

  // --------------------------------------------------------------- seating
  async function place(sessId, charId) {
    const sess = byId(sessId), ch = myChar(charId);
    if (!sess || !ch) return;
    const v = R.eligibility(S, sess, ch);
    if (!v.ok) return refuse(sessId, v.reason);
    const prop = R.isProposal(sess), willFill = !prop && R.openSeats(sess) - 1 <= 0;
    try {
      await A.seat(sessId, ch);
      disarm();
      if (prop) toast(`${ch.name} joined “${sess.title}”.`, 'ok');
      else toast(`${ch.name} seated on “${sess.title}”.${R.fits(S.me, sess) ? '' : ' Note: you are not marked free then.'}`, 'ok');
      if (prop) await A.log('note', `${ch.name} (${S.me.name}) joined the proposal “${sess.title}”.`, { sessionId: sessId });
      else await A.log('seat', `${ch.name} (${S.me.name}) is seated on “${sess.title}” — ${when(sess)}.`, { sessionId: sessId, date: sess.date, block: sess.block });
      if (willFill) await A.log('full', `“${sess.title}” is now full.`, { sessionId: sessId });
    } catch (err) { refuse(sessId, err.message || 'Could not take that seat.'); }
  }

  async function withdraw(sessId, charId) {
    const sess = byId(sessId); if (!sess) return;
    const e = (sess.party || []).find(x => x.charId === charId && isMine(x)); if (!e) return;
    const prop = R.isProposal(sess);
    try {
      await A.unseat(sessId, charId);
      toast(`${e.name} withdrawn from “${sess.title}”.`, 'ok');
      if (prop) await A.log('note', `${e.name} (${S.me.name}) left the proposal “${sess.title}”.`, { sessionId: sessId });
      else await A.log('open', `${e.name} (${S.me.name}) withdrew from “${sess.title}” — 1 seat opened.`, { sessionId: sessId, date: sess.date, block: sess.block });
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
      const opened = R.isProposal(from) ? '' : ` — 1 seat opened on “${from.title}”`;
      await A.log(R.isProposal(from) ? 'note' : 'open', `${ch.name} (${S.me.name}) moved from “${from.title}” to “${to.title}”${opened}.`, { sessionId: fromId, date: from.date || undefined, block: from.block || undefined });
    } catch (err) { refuse(toId, err.message || 'Could not move.'); }
  }

  async function toggleWatch(id) {
    const s = byId(id); if (!s) return;
    const w = (S.me.watching || []).slice(), i = w.indexOf(id), on = i < 0;
    if (on) w.push(id); else w.splice(i, 1);
    await A.setWatching(w);
    toast(on ? `Watching “${s.title}” — you'll be told when ${R.isProposal(s) ? 'it is scheduled' : 'a seat opens'}.` : `No longer watching “${s.title}”.`, 'hint');
  }

  // ---- availability edits --------------------------------------------------
  async function toggleAvail(slot) {
    const a = (S.me.availability || []).slice(), i = a.indexOf(slot);
    if (i < 0) a.push(slot); else a.splice(i, 1);
    await A.setAvailability(a);
  }
  async function preset(name) {
    let a = (S.me.availability || []).slice();
    const add = slots => slots.forEach(s => { if (!a.includes(s)) a.push(s); });
    if (name === 'clear') a = [];
    if (name === 'weeknights') add(['mon', 'tue', 'wed', 'thu', 'fri'].map(d => `${d}-eve`));
    if (name === 'weekends') add(['sat', 'sun'].flatMap(d => BLOCKS.map(b => `${d}-${b.key}`)));
    await A.setAvailability(a);
  }
  // Clicking a date cell flips that date's answer. If the new answer is what the layers below
  // already say, the override is dropped rather than stored, so exceptions never accumulate —
  // but it must compare against that resolved baseline, not the weekly pattern alone, or a
  // date the calendar sync has blocked could never be opened again by hand.
  async function toggleException(key) {
    const dateKey = key.slice(0, 10), block = key.slice(11);
    const me = S.me, want = !R.freeOn(me, dateKey, block);
    const ex = Object.assign({}, me.exceptions || {});
    if (want === R.baseline(me, dateKey, block)) delete ex[key]; else ex[key] = want;
    await A.setExceptions(R.pruneExceptions(ex));
  }
  function clearExceptions() {
    const n = Object.keys(S.me.exceptions || {}).length;
    if (!n) return;
    confirmTwice('clear-ex', `Drop all ${n} date override${n === 1 ? '' : 's'}?`, async () => {
      await A.setExceptions({}); toast('Date overrides cleared — your usual week applies.', 'ok');
    });
  }
  // Availability changes deliberately write no dispatch. They were the noisiest thing in the
  // feed and told nobody anything the overlap grid does not already show live.

  // ------------------------------------------------------------- GM actions
  // Destructive actions take two clicks within a few seconds — no native confirm(), which
  // sandboxed embeds block.
  function confirmTwice(key, message, fn) {
    if (pendingConfirm && pendingConfirm.key === key && Date.now() - pendingConfirm.at < 6000) { pendingConfirm = null; fn(); }
    else { pendingConfirm = { key, at: Date.now() }; toast(`${message} — click again to confirm.`, 'hint'); }
  }
  function decline(id) {
    const s = byId(id); if (!s) return;
    confirmTwice('decline:' + id, `Decline “${s.title}”? It comes off the board`, async () => {
      try { await A.setStatus(id, 'cancelled'); toast('Declined.', 'ok'); await A.log('cancelled', `“${s.title}” was declined by GM ${S.me.name}.`, { sessionId: id }); }
      catch (err) { toast(err.message || 'Could not decline.', 'no'); }
    });
  }
  function cancelExpedition(id) {
    const s = byId(id); if (!s) return;
    confirmTwice('cancel:' + id, `Cancel “${s.title}” (${when(s)})? Everyone seated is released`, async () => {
      try {
        await A.setStatus(id, 'cancelled'); toast('Cancelled.', 'ok');
        await A.log('cancelled', `“${s.title}” — ${when(s)} — was cancelled by GM ${S.me.name}.`, { sessionId: id, date: s.date, block: s.block });
        if (KS.gcalDropEvent) KS.gcalDropEvent(s);
      } catch (err) { toast(err.message || 'Could not cancel.', 'no'); }
    });
  }
  function withdrawProposal(id) {
    const s = byId(id); if (!s) return;
    confirmTwice('withdraw:' + id, `Withdraw your proposal “${s.title}”?`, async () => {
      try { await A.setStatus(id, 'cancelled'); toast('Proposal withdrawn.', 'ok'); await A.log('cancelled', `${S.me.name} withdrew the proposal “${s.title}”.`, { sessionId: id }); }
      catch (err) { toast(err.message || 'Could not withdraw.', 'no'); }
    });
  }
  async function toggleLock(id) {
    const s = byId(id); if (!s) return;
    const locked = !s.locked;
    try { await A.setLocked(id, locked); toast(locked ? 'Roster locked.' : 'Roster unlocked.', 'ok'); await A.log('lock', `Roster ${locked ? 'locked' : 'unlocked'} for “${s.title}” — ${when(s)}.`, { sessionId: id, date: s.date, block: s.block }); }
    catch (err) { toast(err.message || 'Could not change the lock.', 'no'); }
  }
  async function gmRemove(id, charId, uid) {
    const s = byId(id); if (!s) return;
    const e = (s.party || []).find(x => x.charId === charId && x.uid === uid); if (!e) return;
    const prop = R.isProposal(s);
    try {
      await A.gmUnseat(id, charId, uid);
      toast(`${e.name} taken off “${s.title}”.`, 'ok');
      await A.log(prop ? 'note' : 'open', `${e.name} (${e.owner || ''}) was taken off “${s.title}” by the GM${prop ? '' : ' — 1 seat opened'}.`, { sessionId: id, date: s.date || undefined, block: s.block || undefined });
    } catch (err) { toast(err.message || 'Could not remove them.', 'no'); }
  }

  // ------------------------------------------------------------- dialogs
  function openPost(prefill) {
    const f = $('#post-form'), p = prefill || {};
    f.reset(); $('#post-error').hidden = true;
    $('[name=sessionId]', f).value = p.sessionId || '';
    $('[name=title]', f).value = p.title || '';
    $('[name=region]', f).value = p.region || '';
    $('[name=notes]', f).value = p.notes || '';
    $('[name=gm]', f).value = S.me.name;
    const t = new Date(); t.setDate(t.getDate() + 1);
    const date = $('[name=date]', f); date.value = p.date || U.keyOf(t); date.min = U.todayKey();
    const block = p.block || 'eve';
    $('#post-block').innerHTML = BLOCKS.map(b => `<option value="${b.key}"${b.key === block ? ' selected' : ''}>${b.label} · ${b.time}</option>`).join('');
    if (p.seats) { $('[name=seats]', f).value = p.seats; $('[name=minLevel]', f).value = p.minLevel; $('[name=maxLevel]', f).value = p.maxLevel; }
    const edit = p.mode === 'edit';
    f.dataset.mode = edit ? 'edit' : '';
    $('#post-h').textContent = edit ? 'Edit the expedition' : p.sessionId ? 'Schedule the proposal' : 'Post an expedition';
    $('#post-submit').textContent = edit ? 'Save changes' : p.sessionId ? 'Schedule it' : 'Post to the board';
    const note = $('#post-note'); note.hidden = !p.sessionId || edit;
    if (p.sessionId && !edit) note.innerHTML = `Scheduling <strong>${esc(p.title)}</strong> — ${p.joined} joined. ${p.hasWindow ? 'The date below is the soonest one where they are all free and you can run' : 'No date in the next few weeks suits everyone joined, so pick one'}; seats and levels are set from the party.`;
    $('#post-dialog').showModal();
  }
  async function submitPost(e) {
    e.preventDefault();
    const f = e.target, v = Object.fromEntries(new FormData(f).entries()), err = $('#post-error');
    v.mode = f.dataset.mode || '';
    const sessionId = v.sessionId || '', target = sessionId ? byId(sessionId) : null, party = target ? (target.party || []) : [];
    const s = { title: v.title.trim(), region: v.region.trim(), gm: v.gm.trim(), date: v.date, block: v.block,
      seats: +v.seats, minLevel: +v.minLevel, maxLevel: +v.maxLevel, notes: v.notes.trim() };
    const lv = party.map(x => x.level);
    const problem = !s.title ? 'Give the expedition a title.' : !s.region ? 'Name the route or region.' : !s.gm ? 'Who is running it?'
      : (!s.date || s.date < U.todayKey()) ? 'Pick a date from today on.' : !(s.seats >= 1) ? 'At least one seat.'
      : s.minLevel > s.maxLevel ? 'Min level is above max level.'
      : (sessionId && !target) ? 'That proposal is no longer on the board.'
      : s.seats < party.length ? `${party.length} have joined — at least that many seats.`
      : (lv.length && (s.minLevel > Math.min(...lv) || s.maxLevel < Math.max(...lv))) ? `The joined characters are levels ${Math.min(...lv)}–${Math.max(...lv)}; widen the band or take them off first.`
      : null;
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const edit = v.mode === 'edit', moved = edit && target && (target.date !== s.date || target.block !== s.block);
    try {
      let id = sessionId;
      if (sessionId) {
        await A.schedule(sessionId, s);
        $('#post-dialog').close();
        toast(edit ? `“${s.title}” updated.` : `“${s.title}” is scheduled.`, 'ok');
        if (edit) await A.log('edited', `“${s.title}” was changed by GM ${s.gm}${moved ? ` — now ${when(s)}` : ''}.`, { sessionId, date: s.date, block: s.block });
        else await A.log('scheduled', `“${s.title}” is scheduled — ${when(s)} (GM ${s.gm}). ${party.length} seated, ${Math.max(0, s.seats - party.length)} open.`, { sessionId, date: s.date, block: s.block });
      } else {
        id = await A.postSession(s);
        $('#post-dialog').close();
        toast(`“${s.title}” is on the board.`, 'ok');
        await A.log('new', `New expedition posted: “${s.title}” — ${when(s)} (GM ${s.gm}).`, { sessionId: id, date: s.date, block: s.block });
      }
      // The board has committed; the calendar write is a follow-on that never blocks it.
      if (KS.gcalPushEvent) KS.gcalPushEvent(Object.assign({}, target || {}, s, { id, gmUid: S.me.uid }));
    } catch (ex) { err.textContent = ex.message || 'Could not post.'; err.hidden = false; }
  }

  function openPropose() {
    if (!S.me.characters.length) { toast('Add a character to your roster first — a proposal needs someone to go.', 'hint'); openProfile(); return; }
    const f = $('#propose-form'); f.reset(); $('#propose-error').hidden = true;
    $('#propose-char').innerHTML = S.me.characters.map(c => `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.class || '')} · Lvl ${esc(c.level)}</option>`).join('');
    $('#propose-dialog').showModal();
  }
  async function submitPropose(e) {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target).entries()), err = $('#propose-error');
    const ch = myChar(v.charId);
    const p = { title: v.title.trim(), region: v.region.trim(), notes: v.notes.trim(), character: ch };
    const problem = !p.title ? 'Give it a title.' : !p.region ? 'Say where, or what for.' : !ch ? 'Pick the character you would bring.' : null;
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    try {
      const id = await A.propose(p);
      $('#propose-dialog').close();
      toast(`“${p.title}” is proposed — the GM will see it.`, 'ok');
      await A.log('proposal', `${S.me.name} proposed “${p.title}” — ${p.region}. Join it from the board.`, { sessionId: id });
    } catch (ex) { err.textContent = ex.message || 'Could not propose.'; err.hidden = false; }
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
    const stuck = removed.find(c => live().some(s => !R.isPast(s) && (s.party || []).some(en => en.charId === c.id && isMine(en))));
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
    const fitsMe = d.date && d.block ? R.freeOn(S.me, d.date, d.block) : false;
    const involved = sess && (isWatching(sess.id) || R.myEntry(S.me, sess));
    if (d.kind === 'open' && sess && isWatching(sess.id)) return 'watching';
    if (d.kind === 'open' && fitsMe && S.me.prefs && S.me.prefs.alertOnOpenSeat && !(sess && R.myEntry(S.me, sess))) return 'fits';
    if (d.kind === 'new' && fitsMe) return 'fits';
    if ((d.kind === 'scheduled' || d.kind === 'cancelled' || d.kind === 'lock') && involved) return 'yours';
    if ((d.kind === 'proposal' || d.kind === 'request') && isGM()) return 'gm';
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
  KS.toast = toast;                       // the calendar-sync module reports through this
  KS.state = () => S;
  KS.adapter = () => A;
  KS.isGM = isGM;
  KS.refreshAvail = () => { if (S) { renderAvailability(); renderOverlap(); } };

  // ----------------------------------------------------------------- events
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-action],[data-gmremove],[data-char],[data-chip],[data-open],[data-drop],[data-watch],[data-slot],[data-ex],[data-preset],[data-filter],[data-pchip],[data-avtab],[data-week],[data-announce-go]');
    if (!t) return;
    const d = t.dataset;
    if (d.action) return doAction(d.action, t);
    if (!S) return;
    if (d.announceGo !== undefined) { announceIdx = +d.announceGo; announceStepped = true; renderAnnounce(); startAnnounce(); return; }
    if (d.avtab !== undefined) { ui.availTab = d.avtab; renderAvailability(); renderUser(); return; }
    if (d.week !== undefined) {
      const [which, dir] = d.week.split(':');
      const key = which === 'avail' ? 'availWeek' : 'overlapWeek';
      const next = U.addDays(ui[key], +dir * 7);
      if (next >= firstWeek() && next <= lastWeek()) { ui[key] = next; which === 'avail' ? renderAvailability() : renderOverlap(); }
      return;
    }
    if (d.gmremove !== undefined) return gmRemove(d.sess, d.gmremove, d.gmuid);
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
    if (d.ex !== undefined) return toggleException(d.ex);
    if (d.preset !== undefined) return preset(d.preset);
    if (d.filter !== undefined) { ui.filter = d.filter; renderBoard(); }
  });

  function doAction(name, el) {
    const sess = el.dataset.sess;
    switch (name) {
      case 'sign-in': A.signIn().catch(err => toast(err.message || 'Sign-in failed.', 'no')); break;
      case 'sign-out': A.signOut(); break;
      case 'post-open': openPost(); break;
      case 'post-close': $('#post-dialog').close(); break;
      case 'propose-open': openPropose(); break;
      case 'propose-close': $('#propose-dialog').close(); break;
      case 'schedule-open': { const s = byId(sess); if (s) openPost(schedulePrefill(s)); break; }
      case 'edit-open': { const s = byId(sess); if (s) openPost(editPrefill(s)); break; }
      case 'decline': decline(sess); break;
      case 'cancel': cancelExpedition(sess); break;
      case 'withdraw-proposal': withdrawProposal(sess); break;
      case 'toggle-lock': toggleLock(sess); break;
      case 'profile-open': openProfile(); break;
      case 'profile-close': $('#profile-dialog').close(); break;
      case 'char-add': $('#char-rows').insertAdjacentHTML('beforeend', charRow({})); $('#char-rows .char-row:last-child input').focus(); break;
      case 'char-remove': el.closest('.char-row').remove(); break;
      case 'arm-cancel': disarm(); break;
      case 'announce-open': openAnnounce(); break;
      case 'announce-close': $('#announce-dialog').close(); break;
      case 'announce-remove': removeAnnounce(el.dataset.ann); break;
      case 'clear-exceptions': clearExceptions(); break;
      case 'party-clear': ui.party.clear(); renderOverlap(); break;
      case 'party-request': partyRequest(el.dataset.date, el.dataset.block); break;
      case 'party-post': openPost(partyPrefill(el.dataset.date, el.dataset.block)); break;
      case 'mark-read': A.markRead(); break;
      case 'disp-toggle': ui.dispShowAll = !ui.dispShowAll; renderDispatches(); break;
      case 'browser-alerts': toggleBrowserAlerts(); break;
      case 'gcal-sync': if (KS.gcalSync) KS.gcalSync(); break;
      case 'gcal-clear': if (KS.gcalClear) KS.gcalClear(); break;
      case 'reset':
        // Two clicks within a few seconds — no native confirm(), which sandboxed embeds block.
        if (!A.reset) break;
        if (resetArmedAt && Date.now() - resetArmedAt < 6000) { resetArmedAt = 0; seenDispatches = null; A.reset(); toast('Sample data restored.', 'ok'); }
        else { resetArmedAt = Date.now(); toast('This wipes the changes made in this browser — click “Reset sample data” again to confirm.', 'hint'); }
        break;
      case 'boot-local': $('#boot-error').hidden = true; KS.boot(new KS.LocalAdapter({})); break;
    }
  }

  // The banner element persists across renders, so these bind once.
  $('#announce').addEventListener('mouseenter', () => { announcePaused = true; });
  $('#announce').addEventListener('mouseleave', () => { announcePaused = false; });
  $('#announce').addEventListener('focusin', () => { announcePaused = true; });
  $('#announce').addEventListener('focusout', () => { announcePaused = false; });
  $('#announce-form').addEventListener('submit', submitAnnounce);
  $('#post-form').addEventListener('submit', submitPost);
  $('#propose-form').addEventListener('submit', submitPropose);
  $('#profile-form').addEventListener('submit', submitProfile);
  $('#pref-openseat').addEventListener('change', e => A.setPrefs(Object.assign({}, S.me.prefs || {}, { alertOnOpenSeat: e.target.checked })));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && armed) disarm(); });
  document.addEventListener('mouseover', e => { const c = e.target.closest('[data-date][data-block]'); if (c) showHeat(c); });
  document.addEventListener('focusin', e => { const c = e.target.closest('[data-date][data-block]'); if (c) showHeat(c); });
  function showHeat(c) {
    const missing = c.dataset.missing, out = c.dataset.out;
    $('#overlap-detail').textContent = `${stampLabel(c.dataset.date, c.dataset.block)}: ${c.dataset.names || 'nobody yet'}${missing ? ` — not ${missing}` : ''}${out ? ' · no GM available' : ''}`;
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
