/* Expedition Board — Firestore adapter (ES module).
   This module is the boot point: with a config in js/firebase-config.js it boots the app on
   Firebase (Google sign-in + Firestore, live for everyone); without one it boots the local demo.
   Same contract as local-adapter.js — the UI cannot tell them apart.

   Collections:  players/{uid}      one doc per signed-in player (profile, roster, availability, watching, prefs, readAt)
                 sessions/{id}      one doc per expedition; party = [{charId, uid, name, level, owner}]
                 dispatches/{id}    network-wide event feed, newest first by ts
                 allowlist/{email}  who may sign in — see firestore.rules */
const KS = window.KS;
const cfg = window.KS_FIREBASE_CONFIG;

if (KS.booted) {
  // app.js already booted the local demo (file:// or the fallback button).
} else if (!cfg || !cfg.apiKey || !cfg.projectId) {
  KS.boot(new KS.LocalAdapter());
} else {
  const V = '12.4.0';
  const [app, auth, fs] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  KS.boot(new FirebaseAdapter(cfg, Object.assign({}, app, auth, fs)));
}

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
    this.user = null;
    this.unsubs = [];
    this._blank();
  }
  _blank() {
    this.state = { me: null, players: [], sessions: [], dispatches: [] };
    this.ready = { players: false, sessions: false, dispatches: false };
  }

  start({ onState, onStatus }) {
    this.onState = onState; this.onStatus = onStatus;
    onStatus({ mode: 'firebase', connected: false, user: null });
    this.F.onAuthStateChanged(this.auth, user => this._onAuth(user),
      err => onStatus({ mode: 'firebase', connected: false, user: null, error: err.message }));
  }

  async _onAuth(user) {
    this._stop(); this._blank(); this.user = user;
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
          characters: [], availability: [], watching: [], prefs: { alertOnOpenSeat: true, browserAlerts: false },
          readAt: Date.now(), createdAt: Date.now(),
        });
      }
    } catch (err) { fail(err); return; }

    this.unsubs.push(F.onSnapshot(F.collection(this.db, 'players'), qs => {
      this.state.players = qs.docs.map(d => Object.assign({ uid: d.id }, d.data()));
      const me = this.state.players.find(p => p.uid === user.uid);
      if (me) this.state.me = me;
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
    this.onStatus({ mode: 'firebase', connected: true, user: who, firstRun });
  }

  // Render only once all three collections have arrived, so the first paint is whole.
  _emit() {
    if (this.state.me && this.ready.players && this.ready.sessions && this.ready.dispatches) this.onState(this.state);
  }
  _stop() { this.unsubs.forEach(u => { try { u(); } catch (e) { /* ignore */ } }); this.unsubs = []; }
  _me() { return this.F.doc(this.db, 'players', this.user.uid); }
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
  async setWatching(w) { await this.F.updateDoc(this._me(), { watching: w }); }
  async setPrefs(prefs) { await this.F.updateDoc(this._me(), { prefs: clean(prefs) }); }
  async markRead() { await this.F.updateDoc(this._me(), { readAt: Date.now() }); }

  async postSession(s) {
    const ref = await this.F.addDoc(this.F.collection(this.db, 'sessions'),
      clean(Object.assign({}, s, { party: [], locked: false, gmUid: this.user.uid, postedAt: Date.now() })));
    return ref.id;
  }

  // Seat changes run as transactions against the fresh document: if two players race for
  // the last seat, the second transaction re-reads, finds no seat, and is refused cleanly.
  async seat(sessId, ch) {
    const F = this.F, ref = F.doc(this.db, 'sessions', sessId), me = this.state.me;
    await F.runTransaction(this.db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('That expedition is no longer on the board.');
      const s = Object.assign({ id: snap.id }, snap.data());
      const v = KS.rules.eligibility(this.state, s, ch);
      if (!v.ok) throw new Error(v.reason);
      tx.update(ref, { party: [...(s.party || []), { charId: ch.id, uid: this.user.uid, name: ch.name, level: ch.level, owner: me.name }] });
    });
  }
  async unseat(sessId, charId) {
    const F = this.F, ref = F.doc(this.db, 'sessions', sessId), uid = this.user.uid;
    await F.runTransaction(this.db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('That expedition is no longer on the board.');
      tx.update(ref, { party: (snap.data().party || []).filter(e => !(e.charId === charId && e.uid === uid)) });
    });
  }
  async move(fromId, toId, charId) {
    const F = this.F, uid = this.user.uid, me = this.state.me;
    const fromRef = F.doc(this.db, 'sessions', fromId), toRef = F.doc(this.db, 'sessions', toId);
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
      tx.update(toRef, { party: [...(to.party || []), { charId: ch.id, uid, name: ch.name, level: ch.level, owner: me.name }] });
    });
  }

  async log(kind, text, meta = {}) {
    await this.F.addDoc(this.F.collection(this.db, 'dispatches'), clean(Object.assign({ ts: Date.now(), kind, text, uid: this.user.uid }, meta)));
  }
}
