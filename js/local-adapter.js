/* Expedition Board — local adapter.
   Single-player, this browser only: state lives in localStorage and starts from KS.sample().
   Implements the same contract as the Firebase adapter so the UI can't tell them apart:

     start({ onState, onStatus })   begin; onState(state) on every change, onStatus({mode, connected, user, error})
     signIn() / signOut()
     saveProfile({ name, handle, discord, characters })
     setAvailability(slots[])  setExceptions({"YYYY-MM-DD-block": bool})  setWatching(ids[])
     setPrefs(prefs)  markRead()
     postSession(session) -> id                       GM: a dated expedition
     propose({ title, region, notes, character }) -> id   player: a proposal, joined with one character
     schedule(id, fields)                             GM: proposal -> scheduled expedition
     setStatus(id, status)  setLocked(id, bool)       GM (proposer may cancel their own proposal)
     gmUnseat(id, charId, uid)                        GM: remove anyone from a roster
     seat(sessId, character)  unseat(sessId, charId)  move(fromId, toId, charId)   (throw Error(reason) to refuse)
     log(kind, text, meta)      writes one dispatch (the feed is append-only)
     reset()                    local only

   state = { me, players[], gmUids[], sessions[], dispatches[] } — see data.js for the shapes. */
window.KS = window.KS || {};
(function (KS) {
  'use strict';

  class LocalAdapter {
    constructor(opts) {
      this.opts = opts || {};
      this.key = 'kresthalis-expedition-board:v3' + (this.opts.gm ? ':gm' : '');
      this.state = null; this.onState = null;
    }

    start({ onState, onStatus }) {
      this.onState = onState;
      this.state = this._load();
      onStatus({ mode: 'local', connected: true, user: { uid: 'local', name: this.state.me.name } });
      this._emit();
    }
    _load() {
      try {
        const raw = localStorage.getItem(this.key);
        if (raw) { const s = JSON.parse(raw); if (s && s.version === 3) return s; }
      } catch (e) { /* private mode, blocked storage — fall through to sample */ }
      return KS.sample(this.opts);
    }
    _emit() {
      try { localStorage.setItem(this.key, JSON.stringify(this.state)); } catch (e) { /* ignore */ }
      this.onState(this.state);
    }
    _session(id) {
      const s = this.state.sessions.find(x => x.id === id);
      if (!s) throw new Error('That expedition is no longer on the board.');
      return s;
    }
    _entryFor(ch) {
      return { charId: ch.id, uid: this.state.me.uid, name: ch.name, level: ch.level, owner: this.state.me.name };
    }

    async signIn() {}
    async signOut() {}
    async saveProfile(p) { Object.assign(this.state.me, p); this._emit(); }
    async setAvailability(a) { this.state.me.availability = a; this._emit(); }
    async setExceptions(ex) { this.state.me.exceptions = ex; this._emit(); }
    async setCalendarBusy(busy, syncedAt) { this.state.me.gcalBusy = busy || {}; this.state.me.gcalSyncedAt = syncedAt || null; this._emit(); }
    // No getCalendarToken here: the sample board has no Google session to borrow, and the
    // UI keys off its absence to say so rather than failing at the popup.
    async setWatching(w) { this.state.me.watching = w; this._emit(); }
    async setPrefs(prefs) { this.state.me.prefs = prefs; this._emit(); }
    async markRead() { this.state.me.readAt = Date.now(); this._emit(); }

    async postSession(s) {
      const id = 's' + KS.util.uid(), me = this.state.me;
      this.state.sessions.push(Object.assign({}, s, { id, status: 'scheduled', party: [], locked: false, gmUid: me.uid, postedAt: Date.now() }));
      this._emit();
      return id;
    }
    async propose(p) {
      const id = 'p' + KS.util.uid(), me = this.state.me;
      this.state.sessions.push({
        id, status: 'proposed', title: p.title, region: p.region, notes: p.notes || '',
        proposerUid: me.uid, proposer: me.name, party: [this._entryFor(p.character)], locked: false,
        gm: null, gmUid: null, date: null, block: null, seats: null, minLevel: null, maxLevel: null, postedAt: Date.now(),
      });
      this._emit();
      return id;
    }
    async schedule(id, f) {
      const s = this._session(id), me = this.state.me;
      Object.assign(s, f, { status: 'scheduled', gmUid: me.uid, gm: f.gm || me.name, scheduledAt: Date.now() });
      this._emit();
    }
    async setStatus(id, status) { this._session(id).status = status; this._emit(); }
    async setLocked(id, locked) { this._session(id).locked = !!locked; this._emit(); }
    async gmUnseat(id, charId, uid) {
      const s = this._session(id);
      s.party = (s.party || []).filter(e => !(e.charId === charId && e.uid === uid));
      this._emit();
    }

    async seat(sessId, ch) {
      const s = this._session(sessId);
      const v = KS.rules.eligibility(this.state, s, ch);
      if (!v.ok) throw new Error(v.reason);
      s.party.push(this._entryFor(ch));
      this._emit();
    }
    async unseat(sessId, charId) {
      const s = this._session(sessId), me = this.state.me.uid;
      s.party = s.party.filter(e => !(e.charId === charId && e.uid === me));
      this._emit();
    }
    async move(fromId, toId, charId) {
      const from = this._session(fromId), to = this._session(toId), me = this.state.me.uid;
      const entry = from.party.find(e => e.charId === charId && e.uid === me);
      if (!entry) throw new Error('That character is not seated there any more.');
      const ch = this.state.me.characters.find(c => c.id === charId) || { id: entry.charId, name: entry.name, level: entry.level };
      const v = KS.rules.eligibility(this.state, to, ch, { ignoreSessId: fromId });
      if (!v.ok) throw new Error(v.reason);
      from.party = from.party.filter(e => e !== entry);
      to.party.push(this._entryFor(ch));
      this._emit();
    }
    async log(kind, text, meta = {}) {
      this.state.dispatches.unshift(Object.assign({ id: 'd' + KS.util.uid(), ts: Date.now(), kind, text, uid: this.state.me.uid }, meta));
      if (this.state.dispatches.length > 80) this.state.dispatches.length = 80;
      this._emit();
    }
    reset() { this.state = KS.sample(this.opts); this._emit(); }
  }

  KS.LocalAdapter = LocalAdapter;
})(window.KS);
