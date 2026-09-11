/* Expedition Board — Firestore adapter (ES module).
   This module is the boot point: with a config in js/firebase-config.js it boots the app on
   Firebase (Google sign-in + Firestore, live for everyone); without one — or with ?demo in the
   URL — it boots the local sample adapter. Same contract as local-adapter.js.

   Collections:  players/{uid}      one doc per signed-in player (profile, roster, availability, watching, prefs, readAt)
                 sessions/{id}      proposals and expeditions; status proposed | scheduled | cancelled;
                                    party = [{charId, uid, name, level, owner}]
                 dispatches/{id}    network-wide event feed, newest first by ts
                 allowlist/{email}  who may sign in; gm: true marks a GM — see firestore.rules
                 config/board       gmUids[] and gmNames{} — written by GMs on sign-in so every client knows who runs */
const KS = window.KS;

// Firestore rejects undefined field values; strip them before writing.
function clean(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

class FirebaseAdapter {
  constructor(cfg, F) {
    this.F = F;
    this.app = F.initializeApp(cfg);
    this.auth = F.getAuth(this.app);
    this.db = F.getFirestore(this.app);
    this.user = null; this.gm = false;
    this.unsubs = [];
    this._blank();
  }
  _blank() {
    this.state = { me: null, players: [], gmUids: [], sessions: [], dispatches: [] };
    this.ready = { players: false, sessions: false, dispatches: false, config: false };
  }

  start({ onState, onStatus }) {
    this.onState = onState; this.onStatus = onStatus;
    onStatus({ mode: 'firebase', connected: false, user: null });
    this.F.onAuthStateChanged(this.auth, user => this._onAuth(user),
      err => onStatus({ mode: 'firebase', connected: false, user: null, error: err.message }));
  }

  async _onAuth(user) {
    this._stop(); this._blank(); this.user = user; this.gm = false;
    if (!user) { this.onStatus({ mode: 'firebase', connected: true, user: null }); return; }
    const who = { uid: user.uid, name: user.displayName || '', email: user.email || '' };
    const fail = err => this.onStatus({ mode: 'firebase', connected: false, user: who, error: this._explain(err, who) });
    const F = this.F;
    let firstRun = false;
    try {
      const ref = F.doc(this.db, 'players', user.uid);
      const snap = await F.getDoc(ref);
      if (!snap.exists()) {
        firstRun = true;
        await F.setDoc(ref, {
          name: user.displayName || 'New player', handle: (user.email || '').split('@')[0], discord: '', role: 'Player',
          characters: [], availability: [], exceptions: {}, watching: [], prefs: { alertOnOpenSeat: true, browserAlerts: false },
          readAt: Date.now(), createdAt: Date.now(),
        });
      }
      // GM status lives on the allowlist entry (set by the project owner), never on the profile.
      const al = await F.getDoc(F.doc(this.db, 'allowlist', user.email || '-'));
      this.gm = !!(al.exists() && al.data().gm === true);
      if (this.gm) {
        await F.setDoc(F.doc(this.db, 'config', 'board'),
          { gmUids: F.arrayUnion(user.uid), gmNames: { [user.uid]: user.displayName || 'GM' } }, { merge: true });
      }
    } catch (err) { fail(err); return; }

    this.unsubs.push(F.onSnapshot(F.collection(this.db, 'players'), qs => {
      this.state.players = qs.docs.map(d => Object.assign({ uid: d.id }, d.data()));
      const me = this.state.players.find(p => p.uid === user.uid);
      if (me) this.state.me = Object.assign({}, me, { gm: this.gm });
      this.ready.players = true; this._emit();
    }, fail));
    this.unsubs.push(F.onSnapshot(F.collection(this.db, 'sessions'), qs => {
      this.state.sessions = qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
      this.ready.sessions = true; this._emit();
    }, fail));
    this.unsubs.push(F.onSnapshot(F.query(F.collection(this.db, 'dispatches'), F.orderBy('ts', 'desc'), F.limit(60)), qs => {
      this.state.dispatches = qs.docs.map(d => Object.assign({ id: d.id }, d.data()));
      this.ready.dispatches = true; this._emit();
    }, fail));
    this.unsubs.push(F.onSnapshot(F.doc(this.db, 'config', 'board'), d => {
      this.state.gmUids = (d.exists() && d.data().gmUids) || [];
      this.ready.config = true; this._emit();
    }, fail));
    this.onStatus({ mode: 'firebase', connected: true, user: who, firstRun });
  }

  // Render only once every subscription has arrived, so the first paint is whole.
  _emit() {
    const r = this.ready;
    if (this.state.me && r.players && r.sessions && r.dispatches && r.config) this.onState(this.state);
  }
  _stop() { this.unsubs.forEach(u => { try { u(); } catch (e) { /* ignore */ } }); this.unsubs = []; }
  _me() { return this.F.doc(this.db, 'players', this.user.uid); }
  _sess(id) { return this.F.doc(this.db, 'sessions', id); }
  _entryFor(ch) { return { charId: ch.id, uid: this.user.uid, name: ch.name, level: ch.level, owner: this.state.me.name }; }
  _explain(err, who) {
    const code = (err && err.code) || '';
    if (code.includes('permission-denied')) return `Signed in as ${who.email || who.name}, but that account isn't on the network's list yet. Ask the GM to add it, then reload.`;
    if (code.includes('unavailable')) return 'Firestore is unreachable right now — check your connection.';
    return (err && err.message) || String(err);
  }

  async signIn() {
    const p = new this.F.GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    await this.F.signInWithPopup(this.auth, p);
  }
  async signOut() { await this.F.signOut(this.auth); }

  async saveProfile(p) { await this.F.updateDoc(this._me(), clean({ name: p.name, handle: p.handle, discord: p.discord, characters: p.characters, updatedAt: Date.now() })); }
  async setAvailability(a) { await this.F.updateDoc(this._me(), { availability: a }); }
  // Exceptions are replaced wholesale (they are pruned of past dates first), so a stale
  // client can never resurrect an override the player already dropped.
  async setExceptions(ex) { await this.F.updateDoc(this._me(), { exceptions: ex || {} }); }
  async setWatching(w) { await this.F.updateDoc(this._me(), { watching: w }); }
  async setPrefs(prefs) { await this.F.updateDoc(this._me(), { prefs: clean(prefs) }); }
  async markRead() { await this.F.updateDoc(this._me(), { readAt: Date.now() }); }

  async postSession(s) {
    const ref = await this.F.addDoc(this.F.collection(this.db, 'sessions'),
      clean(Object.assign({}, s, { status: 'scheduled', party: [], locked: false, gmUid: this.user.uid, postedAt: Date.now() })));
    return ref.id;
  }
  async propose(p) {
    const me = this.state.me;
    const ref = await this.F.addDoc(this.F.collection(this.db, 'sessions'), clean({
      status: 'proposed', title: p.title, region: p.region, notes: p.notes || '',
      proposerUid: this.user.uid, proposer: me.name, party: [this._entryFor(p.character)], locked: false,
      gm: null, gmUid: null, date: null, block: null, seats: null, minLevel: null, maxLevel: null, postedAt: Date.now(),
    }));
    return ref.id;
  }
  async schedule(id, f) {
    await this.F.updateDoc(this._sess(id), clean(Object.assign({}, f, { status: 'scheduled', gmUid: this.user.uid, gm: f.gm || this.state.me.name, scheduledAt: Date.now() })));
  }
  async setStatus(id, status) { await this.F.updateDoc(this._sess(id), { status }); }
  async setLocked(id, locked) { await this.F.updateDoc(this._sess(id), { locked: !!locked }); }
  async gmUnseat(id, charId, uid) {
    const F = this.F, ref = this._sess(id);
    await F.runTransaction(this.db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('That expedition is no longer on the board.');
      tx.update(ref, { party: (snap.data().party || []).filter(e => !(e.charId === charId && e.uid === uid)) });
    });
  }

  // Seat changes run as transactions against the fresh document: if two players race for
  // the last seat, the second transaction re-reads, finds no seat, and is refused cleanly.
  async seat(sessId, ch) {
    const F = this.F, ref = this._sess(sessId);
    await F.runTransaction(this.db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('That expedition is no longer on the board.');
      const s = Object.assign({ id: snap.id }, snap.data());
      const v = KS.rules.eligibility(this.state, s, ch);
      if (!v.ok) throw new Error(v.reason);
      tx.update(ref, { party: [...(s.party || []), this._entryFor(ch)] });
    });
  }
  async unseat(sessId, charId) {
    const F = this.F, ref = this._sess(sessId), uid = this.user.uid;
    await F.runTransaction(this.db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('That expedition is no longer on the board.');
      tx.update(ref, { party: (snap.data().party || []).filter(e => !(e.charId === charId && e.uid === uid)) });
    });
  }
  async move(fromId, toId, charId) {
    const F = this.F, uid = this.user.uid, me = this.state.me;
    const fromRef = this._sess(fromId), toRef = this._sess(toId);
    await F.runTransaction(this.db, async tx => {
      const [a, b] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
      if (!a.exists() || !b.exists()) throw new Error('One of those expeditions is no longer on the board.');
      const from = Object.assign({ id: a.id }, a.data()), to = Object.assign({ id: b.id }, b.data());
      const entry = (from.party || []).find(e => e.charId === charId && e.uid === uid);
      if (!entry) throw new Error('That character is not seated there any more.');
      const ch = (me.characters || []).find(c => c.id === charId) || { id: entry.charId, name: entry.name, level: entry.level };
      const v = KS.rules.eligibility(this.state, to, ch, { ignoreSessId: fromId });
      if (!v.ok) throw new Error(v.reason);
      tx.update(fromRef, { party: from.party.filter(e => e !== entry) });
      tx.update(toRef, { party: [...(to.party || []), this._entryFor(ch)] });
    });
  }

  async log(kind, text, meta = {}) {
    await this.F.addDoc(this.F.collection(this.db, 'dispatches'), clean(Object.assign({ ts: Date.now(), kind, text, uid: this.user.uid }, meta)));
  }
  // Refresh one of my own dispatches in place (rules allow an author to update their own).
  async relog(id, text) {
    await this.F.updateDoc(this.F.doc(this.db, 'dispatches', id), { text, ts: Date.now() });
  }
}

// ---- boot (kept after the class: a class is not usable before its declaration runs) ----
const cfg = window.KS_FIREBASE_CONFIG;
const params = new URLSearchParams(location.search);
const demo = params.has('demo');                       // ?demo — sample data, nothing shared; ?demo=gm — as the GM
if (KS.booted) {
  // app.js already booted the local demo (file:// or the fallback button).
} else if (demo || !cfg || !cfg.apiKey || !cfg.projectId) {
  KS.boot(new KS.LocalAdapter({ gm: params.get('demo') === 'gm' }));
} else {
  const V = '12.4.0';
  const [app, auth, fs] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  KS.boot(new FirebaseAdapter(cfg, Object.assign({}, app, auth, fs)));
}
