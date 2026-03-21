/* ═══════════════════════════════════════════════════════════════════
   auth.js — Fursa Firebase Auth + Cloud Sync + Event Tracking
   Strategy: soft login — guest can use freely, nudged after 1st draft,
   stronger modal after 2nd+ draft.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

// ── FIREBASE CONFIG ───────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDRSVpRy0g4hLFkDTcs2WXq1hp3VgXuZLM",
  authDomain:        "fursa-apply.firebaseapp.com",
  projectId:         "fursa-apply",
  storageBucket:     "fursa-apply.firebasestorage.app",
  messagingSenderId: "157251926590",
  appId:             "1:157251926590:web:9f31f1d1eeae90e32f2f6f",
  measurementId:     "G-D50C3JNNYP"
};

// ── LAZY FIREBASE LOADER ──────────────────────────────────────────
const FB_VER = '10.12.2';
const FB_CDN = `https://www.gstatic.com/firebasejs/${FB_VER}`;
let _fbReady = null;
async function ensureFirebase() {
  if (_fbReady) return _fbReady;
  _fbReady = (async () => {
    const [appMod, authMod, dbMod] = await Promise.all([
      import(`${FB_CDN}/firebase-app.js`),
      import(`${FB_CDN}/firebase-auth.js`),
      import(`${FB_CDN}/firebase-firestore.js`),
    ]);
    const app  = appMod.initializeApp(FIREBASE_CONFIG);
    const auth = authMod.getAuth(app);
    const db   = dbMod.getFirestore(app);
    window._fb = { auth, db, authMod, dbMod };
    return { auth, db, authMod, dbMod };
  })();
  return _fbReady;
}

// ── GUEST ID ──────────────────────────────────────────────────────
// One persistent anonymous ID per device, generated once and never
// rotated. Used as the Firestore path for guest analytics.
// When a guest logs in, we include guestId in the first sync so the
// server can link the pre-login session to the new account if needed.
function getGuestId() {
  let gid = localStorage.getItem('fursa_gid');
  if (!gid) {
    gid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
    localStorage.setItem('fursa_gid', gid);
  }
  return gid;
}

// ── AUTH MODULE ───────────────────────────────────────────────────
const Auth = (() => {
  let _user          = null;
  let _syncDebounce  = null;
  let _dirty         = false;  // true only when data has changed since last cloud push
  let _userDocExists = false;  // true once _pullFromCloud confirms createdAt exists in Firestore

  // In-memory event buffer — events accumulate here and are flushed
  // once per session (on visibilitychange/pagehide) as a single write.
  // Cost: 1 Firestore write per session regardless of event count.
  const _eventBuffer = [];

  function currentUser() { return _user; }
  function uid()         { return _user?.uid || null; }
  function isLoggedIn()  { return !!_user; }

  // ── INIT ─────────────────────────────────────────────────────────
  async function init() {
    // Ensure guest ID is created on every page load (even before login)
    getGuestId();

    // If the guest already has data in localStorage (returning visitor),
    // mark dirty immediately so the session-end flush will push it.
    // This covers the race where State.save() was called before Auth.init()
    // ran (e.g. during State.load()), meaning markDirty() was a no-op.
    const hasExistingData = State.drafts.length > 0 ||
                            !!(State.profile.firstName) ||
                            !!(State.profile.email);
    if (hasExistingData) _dirty = true;

    const { authMod, auth } = await ensureFirebase();
    authMod.onAuthStateChanged(auth, user => {
      _user = user;
      if (user) _onSignedIn(user);
      else       _onSignedOut();
    });

    // ── SESSION-END FLUSH ──────────────────────────────────────────
    // Flush both events and data on session end — not on every save.
    // Logged-in users push to users/{uid}/*, guests push to guests/{gid}/*.
    // localStorage stays as the live source of truth during the session.
    const _sessionEnd = () => {
      _flushEvents();
      if (uid()) _pushToCloud();
      else       _pushGuestToCloud();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') _sessionEnd();
    });
    window.addEventListener('pagehide', _sessionEnd);
  }

  // ── LOGIN ─────────────────────────────────────────────────────────
  async function loginWithGoogle() {
    try {
      _setLoading(true);
      const { authMod, auth } = await ensureFirebase();
      await authMod.signInWithPopup(auth, new authMod.GoogleAuthProvider());
    } catch(e) {
      _setLoading(false);
      if (e.code !== 'auth/popup-closed-by-user') _showAuthError('Google sign-in failed — please try again.');
    }
  }

  async function loginWithApple() {
    try {
      _setLoading(true);
      const { authMod, auth } = await ensureFirebase();
      const p = new authMod.OAuthProvider('apple.com');
      p.addScope('email'); p.addScope('name');
      await authMod.signInWithPopup(auth, p);
    } catch(e) {
      _setLoading(false);
      if (e.code !== 'auth/popup-closed-by-user') _showAuthError('Apple sign-in failed — please try again.');
    }
  }

  async function logout() {
    // Flush both events and data before signing out so nothing is lost
    _dirty = true;  // force push even if debounce hasn't fired yet
    await _flushEvents();
    await _pushToCloud();
    const { authMod, auth } = await ensureFirebase();
    await authMod.signOut(auth);
    // Rotate guestId after sign-out so the next guest session is fresh
    // and doesn't accidentally merge with a previous guest session.
    // Must happen after signOut so onAuthStateChanged (_onSignedOut) runs first.
    localStorage.removeItem('fursa_gid');
    toast('Signed out — your local data is still here.');
  }

  // ── STATE HANDLERS ────────────────────────────────────────────────
  async function _onSignedIn(user) {
    if (user.displayName && !State.profile.firstName) {
      const parts = user.displayName.split(' ');
      State.profile.firstName = parts[0]                || '';
      State.profile.lastName  = parts.slice(1).join(' ') || '';
    }
    if (user.email && !State.profile.email) State.profile.email = user.email;
    State.profile.photoUrl  = user.photoURL || State.profile.photoUrl || '';
    State.profile.authUid   = user.uid;
    State.profile.authEmail = user.email;

    _closeLoginModal();
    _removeNudgeBanner();

    // Migrate any guest data saved before sign-in, then pull from cloud.
    // Order matters: migrate first so guest drafts aren't lost if cloud
    // already has data (pull merges by id, so no duplicates).
    await _migrateGuestToUser(user.uid);
    await _pullFromCloud();

    _updateProfileAuthZone();
    const greet = document.getElementById('greeting-name');
    if (greet && State.profile.firstName) greet.textContent = State.profile.firstName;
    if (typeof renderCards     === 'function') renderCards();
    if (typeof loadProfileForm === 'function') loadProfileForm();
    if (typeof refreshStats    === 'function') refreshStats();

    toast(`Welcome${State.profile.firstName ? ', ' + State.profile.firstName : ''}! Synced. ✓`);

    // Push once immediately on sign-in so the cloud is up to date with
    // any local drafts/profile created while the user was a guest.
    // Subsequent pushes happen via syncNow debounce or session end.
    _dirty = true;
    _pushToCloud();
    _trackEvent('sign_in', { method: user.providerData[0]?.providerId || 'unknown' });
  }

  function _onSignedOut() {
    _user = null;
    _updateProfileAuthZone();
  }

  // ── CLOUD SYNC ────────────────────────────────────────────────────
  async function _pushToCloud() {
    if (!uid()) return;
    if (!_dirty) return;  // nothing changed since last push — skip the write
    try {
      const { db, dbMod } = await ensureFirebase();
      const { doc, setDoc, serverTimestamp } = dbMod;
      const ts = serverTimestamp();

      // Only include createdAt when the Firestore root doc doesn't have one yet.
      // _userDocExists is set by _pullFromCloud (which always runs before
      // _pushToCloud on sign-in) by reading the actual root doc from Firestore.
      // This is cross-device safe — no localStorage dependency.
      const rootPayload = {
        email:        State.profile.authEmail || '',
        displayName:  [State.profile.firstName, State.profile.lastName].filter(Boolean).join(' '),
        photoUrl:     State.profile.photoUrl  || '',
        draftCount:   State.drafts.filter(d => d.status !== 'sent').length,
        sentCount:    State.stats.sent || 0,
        lastActiveAt: ts,
      };
      if (!_userDocExists) {
        rootPayload.createdAt = ts;
        _userDocExists = true; // prevent repeat writes within the same session
      }

      await Promise.all([
        setDoc(doc(db, `users/${uid()}/profile/main`), { ...State.profile, updatedAt: ts }, { merge: true }),
        setDoc(doc(db, `users/${uid()}/data/main`), {
          drafts: State.drafts.slice(0, 200),
          links:  State.links.slice(0, 500),
          stats:  State.stats, updatedAt: ts
        }, { merge: true }),
        setDoc(doc(db, `users/${uid()}`), rootPayload, { merge: true }),
      ]);
      _dirty = false;  // reset after successful push
    } catch(e) { console.warn('[Fursa] cloud push failed:', e.message); }
  }

  async function _pullFromCloud() {
    if (!uid()) return;
    try {
      const { db, dbMod } = await ensureFirebase();
      const { doc, getDoc } = dbMod;
      const [rootSnap, pSnap, dSnap] = await Promise.all([
        getDoc(doc(db, `users/${uid()}`)),           // root doc — check createdAt
        getDoc(doc(db, `users/${uid()}/profile/main`)),
        getDoc(doc(db, `users/${uid()}/data/main`)),
      ]);

      // Cache whether this user already has a createdAt in Firestore.
      // _pushToCloud reads this flag to decide whether to write it.
      // This is the only reliable cross-device way — localStorage breaks
      // when the user logs in on a second device for the first time.
      _userDocExists = rootSnap.exists() && !!rootSnap.data()?.createdAt;

      if (pSnap.exists()) {
        // Cloud wins for all profile fields — except auth fields which are
        // always set from the live Firebase Auth object in _onSignedIn().
        const cloudProfile = pSnap.data();
        const AUTH_FIELDS = new Set(['authUid', 'authEmail', 'photoUrl']);
        Object.entries(cloudProfile).forEach(([k, v]) => {
          if (AUTH_FIELDS.has(k)) return; // already set correctly by _onSignedIn
          if (v !== undefined && v !== null && v !== '') State.profile[k] = v;
        });
      }
      if (dSnap.exists()) {
        const c = dSnap.data();
        if (Array.isArray(c.drafts)) {
          const ids = new Set(State.drafts.map(d => d.id));
          c.drafts.forEach(d => { if (!ids.has(d.id)) State.drafts.push(d); });
        }
        if (Array.isArray(c.links)) {
          const ids = new Set(State.links.map(l => l.id));
          c.links.forEach(l => { if (!ids.has(l.id)) State.links.push(l); });
        }
        if ((c.stats?.sent || 0) > (State.stats.sent || 0)) State.stats.sent = c.stats.sent;
      }
      State.save();
    } catch(e) { console.warn('[Fursa] cloud pull failed:', e.message); }
  }

  // ── GUEST CLOUD SYNC ──────────────────────────────────────────────
  // Saves guest profile + data to guests/{gid}/* so their work is
  // preserved across sessions and visible in the admin panel.
  // Only writes if something actually changed (_dirty flag).
  async function _pushGuestToCloud() {
    if (uid()) return;   // should not be called for logged-in users
    if (!_dirty) return;

    // Don't waste a write on a pure lurker who opened the app and left
    // without doing anything. Only persist if they have at least one draft
    // OR filled in their name/email in the profile gate.
    const hasData = State.drafts.length > 0 ||
                    !!(State.profile.firstName) ||
                    !!(State.profile.email);
    if (!hasData) { _dirty = false; return; }

    const gid = getGuestId();
    try {
      const { db, dbMod } = await ensureFirebase();
      const { doc, setDoc, serverTimestamp } = dbMod;
      const ts  = serverTimestamp();
      const now = Date.now();
      const platform = /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'ios'
                     : /android/i.test(navigator.userAgent)          ? 'android' : 'desktop';
      await Promise.all([
        // Root doc — lightweight summary for admin list view
        setDoc(doc(db, `guests/${gid}`), {
          platform,
          standalone:   window.navigator.standalone === true ||
                        window.matchMedia('(display-mode:standalone)').matches,
          draftCount:   State.drafts.filter(d => d.status !== 'sent').length,
          sentCount:    State.stats.sent || 0,
          hasCV:        !!(State.profile.cvName),
          hasName:      !!(State.profile.firstName),
          lastActiveAt: ts,
          createdAt:    ts,  // merge:true won't overwrite on subsequent pushes
        }, { merge: true }),
        // Profile — name, email, CV fields from profile gate / CV upload
        setDoc(doc(db, `guests/${gid}/profile/main`), {
          ...State.profile,
          updatedAt: ts,
        }, { merge: true }),
        // Data — drafts, links, stats
        setDoc(doc(db, `guests/${gid}/data/main`), {
          drafts:    State.drafts.slice(0, 200),
          links:     State.links.slice(0, 500),
          stats:     State.stats,
          updatedAt: ts,
        }, { merge: true }),
      ]);
      _dirty = false;
    } catch(e) { console.warn('[Fursa] guest push failed:', e.message); }
  }

  // ── GUEST → USER MIGRATION ────────────────────────────────────────
  // Called once when a guest signs in. Reads their guest Firestore docs,
  // merges the data into State (local), then deletes the guest docs.
  // The subsequent _pushToCloud() writes everything to users/{uid}/*.
  async function _migrateGuestToUser(newUid) {
    // Cancel any pending guest sync debounce so _pushGuestToCloud cannot
    // fire after migration and re-create the guest doc we're about to delete.
    clearTimeout(_syncDebounce);
    _syncDebounce = null;

    const gid = getGuestId();
    try {
      const { db, dbMod } = await ensureFirebase();
      const { doc, getDoc, deleteDoc, setDoc } = dbMod;

      // Mark the guest doc as converted immediately — before reading subcollections.
      // This means even if the deletion below fails or the admin panel refreshes
      // mid-delete, the doc is stamped with convertedToUid and can be filtered out.
      // setDoc on a non-existent doc is a no-op with merge:true if doc doesn't exist.
      try {
        await setDoc(doc(db, `guests/${gid}`), {
          convertedToUid: newUid,
          convertedAt:    Date.now(),
        }, { merge: true });
      } catch(_) {}

      const [pSnap, dSnap] = await Promise.all([
        getDoc(doc(db, `guests/${gid}/profile/main`)),
        getDoc(doc(db, `guests/${gid}/data/main`)),
      ]);

      let migrated = false;

      // Merge guest profile into State — local data wins for auth fields,
      // guest cloud data fills any gaps (e.g. CV fields from a previous session)
      if (pSnap.exists()) {
        const guestProfile = pSnap.data();
        const SKIP = new Set(['authUid','authEmail','photoUrl','updatedAt']);
        Object.entries(guestProfile).forEach(([k, v]) => {
          if (SKIP.has(k)) return;
          if (v !== undefined && v !== null && v !== '' && !State.profile[k]) {
            State.profile[k] = v;
          }
        });
        migrated = true;
      }

      // Merge guest drafts and links — dedup by id
      if (dSnap.exists()) {
        const gd = dSnap.data();
        if (Array.isArray(gd.drafts) && gd.drafts.length) {
          const ids = new Set(State.drafts.map(d => d.id));
          gd.drafts.forEach(d => { if (!ids.has(d.id)) State.drafts.push(d); });
          migrated = true;
        }
        if (Array.isArray(gd.links) && gd.links.length) {
          const ids = new Set(State.links.map(l => l.id));
          gd.links.forEach(l => { if (!ids.has(l.id)) State.links.push(l); });
          migrated = true;
        }
        if ((gd.stats?.sent || 0) > (State.stats.sent || 0)) {
          State.stats.sent = gd.stats.sent;
          migrated = true;
        }
      }

      if (migrated) {
        State.save();
        console.info('[Fursa] guest data migrated to user account');
      }

      // Always clean up guest docs — regardless of whether there was data
      // to migrate. If the guest never flushed to Firestore (common — flush
      // only happens on session end), migrated stays false but the root
      // guests/{gid} doc may still exist from a previous session and would
      // otherwise linger in the admin Guests tab forever.
      try {
        const { collection, getDocs } = dbMod;
        const delTargets = [];
        if (pSnap.exists()) delTargets.push(deleteDoc(doc(db, `guests/${gid}/profile/main`)));
        if (dSnap.exists()) delTargets.push(deleteDoc(doc(db, `guests/${gid}/data/main`)));
        const evSnap = await getDocs(collection(db, `guests/${gid}/events`));
        evSnap.forEach(d => delTargets.push(deleteDoc(d.ref)));
        // Always attempt root doc delete — deleteDoc on a non-existent doc is a no-op
        delTargets.push(deleteDoc(doc(db, `guests/${gid}`)));
        await Promise.allSettled(delTargets);
      } catch(_) {}
    } catch(e) { console.warn('[Fursa] guest migration failed:', e.message); }
  }

  // syncNow marks data as dirty and schedules a debounced push after 10s.
  // Works for both logged-in users and guests.
  // Uses a shorter delay for guests (5s) because iOS pagehide is unreliable —
  // we can't count on the session-end flush firing when the app is killed.
  function syncNow() {
    _dirty = true;
    clearTimeout(_syncDebounce);
    _syncDebounce = setTimeout(() => uid() ? _pushToCloud() : _pushGuestToCloud(), uid() ? 10_000 : 5_000);
  }

  // markDirty is called by State.save() so the session-end handler knows
  // whether a push is needed — without scheduling a debounce itself.
  function markDirty() { _dirty = true; }

  // ── EVENT TRACKING ────────────────────────────────────────────────
  // Events are buffered in memory — zero Firestore writes during the
  // session. _flushEvents() writes the entire buffer as ONE document
  // when the user leaves. This works for both guests and logged-in users.

  function _trackEvent(type, meta = {}) {
    // Always track — guests use guestId, logged-in use uid
    _eventBuffer.push({
      type,
      ...meta,
      ts: Date.now(),  // client timestamp — serverTimestamp not available at flush time
    });
  }

  async function _flushEvents() {
    if (_eventBuffer.length === 0) return;

    // Drain the buffer immediately so a double-fire (visibilitychange
    // then pagehide) doesn't write the same events twice.
    const events = _eventBuffer.splice(0);

    const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

    try {
      const { db, dbMod } = await ensureFirebase();
      const { doc, setDoc, arrayUnion } = dbMod;

      if (uid()) {
        // Logged-in: ONE session doc per day under users/{uid}/events/{date}.
        // arrayUnion handles multiple flushes on the same day safely (e.g.
        // user backgrounds and re-opens the app twice in one day).
        // Cost: 1 Firestore write per session — not 1 per event.
        await setDoc(
          doc(db, `users/${uid()}/events/${today}`),
          {
            events:    arrayUnion(...events),
            createdAt: events[0].ts,  // admin sorts by createdAt
            uid:       uid(),
            updatedAt: Date.now(),
          },
          { merge: true }
        );
      } else {
        // Guest: one session doc per day under guests/{gid}/events/{date}.
        // Skip if the only event is app_open — not worth a write for a pure lurker
        // who opened and immediately closed without interacting.
        const meaningful = events.filter(e => e.type !== 'app_open');
        const toWrite    = meaningful.length ? events : [];
        if (!toWrite.length) return;

        const gid      = getGuestId();
        const platform = /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'ios'
                       : /android/i.test(navigator.userAgent)          ? 'android' : 'desktop';

        // Always upsert the root guest doc so admin queries (which ORDER BY
        // lastActiveAt on the guests collection) can find this guest even if
        // _pushGuestToCloud hasn't run yet (e.g. guest interacted but never
        // created a draft, so the hasData check in _pushGuestToCloud bailed).
        await setDoc(
          doc(db, `guests/${gid}`),
          {
            platform,
            standalone:   window.navigator.standalone === true ||
                          window.matchMedia('(display-mode:standalone)').matches,
            draftCount:   State.drafts.filter(d => d.status !== 'sent').length,
            sentCount:    State.stats.sent || 0,
            hasCV:        !!(State.profile.cvName),
            hasName:      !!(State.profile.firstName),
            lastActiveAt: toWrite[toWrite.length - 1].ts,
            createdAt:    toWrite[0].ts,
          },
          { merge: true }
        );

        await setDoc(
          doc(db, `guests/${gid}/events/${today}`),
          {
            events:    arrayUnion(...toWrite),
            createdAt: toWrite[0].ts,
            guestId:   gid,
            updatedAt: Date.now(),
          },
          { merge: true }
        );
      }

    } catch(e) {
      // Restore events to buffer so they're not silently lost
      // (they'll be retried on the next flush attempt)
      _eventBuffer.unshift(...events);
      console.warn('[Fursa] analytics flush failed:', e.message);
    }
  }

  // Public alias used in app.js
  function track(type, meta) { _trackEvent(type, meta); }

  // ── SOFT LOGIN NUDGE FLOW ─────────────────────────────────────────
  function onDraftGenerated(draft) {
    const count = State.drafts.length;
    _trackEvent('draft_generated', { company: draft.company, jobTitle: draft.jobTitle });

    if (!State.profile.cvName && count === 1) {
      setTimeout(() => {
        _showNudgeBanner(
          '📄 No CV attached — your email is using defaults. Upload your CV to make it personal.',
          'Upload CV →',
          () => { switchTab('settings'); }
        );
      }, 1200);
      // still sync even if showing CV nudge — draft was created
      syncNow();
      return;
    }

    // Sync for both guests and logged-in users
    syncNow();

    if (!isLoggedIn()) {
      if (count === 1) {
        _showNudgeBanner('✓ Draft ready - sign in free to save it across all your devices', 'Save free →', () => showLoginModal('first_draft'));
      } else {
        _showNudgeModal(count);
      }
    }
  }

  function onEmailSent(draft) {
    _trackEvent('email_sent', { company: draft?.company, toEmail: draft?.toEmail });
    // Push immediately — most critical action. User may close app right after.
    _dirty = true;
    if (uid()) _pushToCloud(); else _pushGuestToCloud();
  }

  function onJobSaved() {
    _trackEvent('job_saved', {});
    syncNow();  // works for both guests and logged-in
  }

  function onCvUploaded(name) {
    _trackEvent('cv_uploaded', { fileName: name });
    syncNow();  // works for both guests and logged-in
  }

  function onShareReceived() {
    _trackEvent('share_received', {});
  }

  // ── NUDGE BANNER ──────────────────────────────────────────────────
  function _showNudgeBanner(text, cta, action) {
    _removeNudgeBanner();
    const el = document.createElement('div');
    el.id = 'auth-nudge-banner';
    el.innerHTML = `<div class="anb-text">${text}</div><button class="anb-cta">${cta}</button><button class="anb-x">×</button>`;
    const hero = document.querySelector('.stats-row') || document.querySelector('.app-hdr');
    hero?.after(el);
    el.querySelector('.anb-cta').onclick = () => { _removeNudgeBanner(); action(); };
    el.querySelector('.anb-x').onclick   = () => _removeNudgeBanner();
    requestAnimationFrame(() => el.classList.add('visible'));
  }

  function _removeNudgeBanner() {
    document.getElementById('auth-nudge-banner')?.remove();
  }

  // ── NUDGE MODAL (2nd draft+) ──────────────────────────────────────
  function _showNudgeModal(count) {
    document.getElementById('nudge-modal')?.remove();
    const el = document.createElement('div');
    el.id = 'nudge-modal';
    el.innerHTML = `
      <div class="nudge-sheet">
        <div class="nudge-handle"></div>
        <div class="nudge-emoji">📬</div>
        <div class="nudge-title">Don't lose your ${count} draft${count > 1 ? 's' : ''}</div>
        <div class="nudge-sub">Sign in free to save your applications across all devices — and track every email you send.</div>
        <div class="nudge-perks">
          <div class="nudge-perk"><span class="np-icon">☁️</span><span>Sync across iPhone, iPad, Android &amp; desktop</span></div>
          <div class="nudge-perk"><span class="np-icon">📊</span><span>Track sent vs pending applications</span></div>
          <div class="nudge-perk"><span class="np-icon">🔒</span><span>Your data — private, never shared</span></div>
        </div>
        ${_googleBtn('Continue with Google — it\'s free')}
        ${_appleBtn('Continue with Apple')}
        <button class="nudge-skip" onclick="document.getElementById('nudge-modal').remove()">Not now — keep drafts locally</button>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('open'));
  }

  // ── LOGIN MODAL (profile tab or explicit) ─────────────────────────
  function showLoginModal() {
    document.getElementById('login-modal')?.remove();
    const el = document.createElement('div');
    el.id = 'login-modal';
    el.innerHTML = `
      <div class="login-sheet">
        <div class="login-handle"></div>
        <img src="icons/icon-192.png" class="login-logo" alt="Fursa"/>
        <div class="login-title">Fursa <span class="login-ar">فرصة</span></div>
        <div class="login-sub">Sign in free to save your work across all your devices.</div>
        <div id="lm-loading" style="display:none;padding:12px;text-align:center"><div class="auth-spinner"></div></div>
        <div id="lm-error"   style="display:none;color:var(--acc);font-size:13px;text-align:center;margin-bottom:8px"></div>
        ${_googleBtn('Continue with Google')}
        ${_appleBtn('Continue with Apple')}
        <div class="login-note">Your data is private and never shared.</div>
        <button class="nudge-skip" onclick="Auth._closeLoginModal()">Not now</button>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('open'));
  }

  function _closeLoginModal() {
    const el = document.getElementById('login-modal');
    if (!el) return;
    el.classList.remove('open');
    setTimeout(() => el.remove(), 350);
    _setLoading(false);
  }

  // ── PROFILE AUTH ZONE ─────────────────────────────────────────────
  function _updateProfileAuthZone() {
    const zone = document.getElementById('profile-auth-zone');
    if (!zone) return;
    if (_user) {
      const name  = State.profile.firstName || _user.displayName?.split(' ')[0] || '';
      const email = State.profile.authEmail || _user.email || '';
      const photo = State.profile.photoUrl  || _user.photoURL || '';
      zone.innerHTML = `
        <div class="paz-user">
          ${photo ? `<img src="${photo}" class="paz-avatar-img" alt=""/>` : `<div class="paz-avatar-ini">${(name[0]||'?').toUpperCase()}</div>`}
          <div><div class="paz-name">${_esc(name)}</div><div class="paz-email">${_esc(email)}</div></div>
          <div class="paz-badge">✓ Synced</div>
        </div>
        <button class="profile-logout-btn" onclick="Auth.logout()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Sign out
        </button>`;
    } else {
      zone.innerHTML = `
        <div class="paz-guest">
          <div class="paz-guest-icon">👋</div>
          <div class="paz-guest-title">Sign in to save everything</div>
          <div class="paz-guest-sub">Your drafts only live on this device right now. Sign in free to sync across all devices.</div>
          ${_googleBtn('Continue with Google — free')}
          ${_appleBtn('Continue with Apple')}
        </div>`;
    }
  }

  // ── HELPERS ───────────────────────────────────────────────────────
  function _googleBtn(label) {
    return `<button class="auth-btn auth-google" onclick="Auth.loginWithGoogle()">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
      ${label}</button>`;
  }
  function _appleBtn(label) {
    return `<button class="auth-btn auth-apple" onclick="Auth.loginWithApple()">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
      ${label}</button>`;
  }
  function _setLoading(on) {
    const ld = document.getElementById('lm-loading');
    if (ld) ld.style.display = on ? 'block' : 'none';
    document.querySelectorAll('#login-modal .auth-btn').forEach(b => { b.disabled = on; b.style.opacity = on ? '0.5' : ''; });
  }
  function _showAuthError(msg) {
    const el = document.getElementById('lm-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }
  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return {
    init, loginWithGoogle, loginWithApple, logout,
    currentUser, uid, isLoggedIn, syncNow, markDirty, track,
    onDraftGenerated, onEmailSent, onJobSaved, onCvUploaded, onShareReceived,
    showLoginModal, _closeLoginModal,
  };
})();

// ── INJECT ALL STYLES ─────────────────────────────────────────────
(function() {
  const s = document.createElement('style');
  s.textContent = `
.auth-btn {
  display:flex;align-items:center;justify-content:center;gap:10px;
  width:100%;padding:14px 20px;border-radius:12px;border:none;
  font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px;
  transition:opacity 0.15s,transform 0.12s;font-family:inherit;
}
.auth-btn:active{transform:scale(0.98);opacity:0.85;}
.auth-btn:disabled{opacity:0.5;cursor:not-allowed;}
.auth-google{background:#fff;color:#1A1612;box-shadow:0 0 0 1.5px rgba(60,50,30,0.14);}
.auth-apple{background:#1A1612;color:#fff;}
.auth-spinner{width:22px;height:22px;border-radius:50%;border:2.5px solid var(--s2,#E4E0D6);border-top-color:var(--acc,#C84B2F);animation:auth-spin .7s linear infinite;display:inline-block;}
@keyframes auth-spin{to{transform:rotate(360deg);}}

#auth-nudge-banner{
  display:flex;align-items:center;gap:10px;margin:0 16px 8px;
  padding:11px 14px;background:var(--acc-bg,rgba(200,75,47,.08));
  border:1px solid var(--acc-bd,rgba(200,75,47,.22));border-radius:10px;
  opacity:0;transform:translateY(-6px);transition:opacity .3s,transform .3s;
}
#auth-nudge-banner.visible{opacity:1;transform:none;}
.anb-text{font-size:13px;color:var(--t1,#1A1612);flex:1;line-height:1.4;}
.anb-cta{padding:6px 12px;background:var(--acc,#C84B2F);color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit;}
.anb-x{background:none;border:none;color:var(--t3,#A09890);font-size:18px;cursor:pointer;padding:0 2px;line-height:1;font-family:inherit;}

#nudge-modal,#login-modal{
  position:fixed;inset:0;z-index:9000;
  background:rgba(26,22,18,.48);
  display:flex;align-items:flex-end;
  opacity:0;pointer-events:none;
  transition:opacity .28s ease;
}
#nudge-modal.open,#login-modal.open{opacity:1;pointer-events:all;}
#login-modal{z-index:9100;}
.nudge-sheet,.login-sheet{
  background:var(--bg,#F5F2EC);border-radius:20px 20px 0 0;
  padding:12px 24px calc(env(safe-area-inset-bottom,16px) + 20px);
  width:100%;max-width:480px;margin:0 auto;
  transform:translateY(40px);transition:transform .32s cubic-bezier(.22,1,.36,1);
}
#nudge-modal.open .nudge-sheet,#login-modal.open .login-sheet{transform:none;}
.login-sheet{display:flex;flex-direction:column;align-items:center;}
.nudge-handle,.login-handle{width:36px;height:4px;background:var(--s3,#D8D4C8);border-radius:99px;margin:0 auto 20px;}
.nudge-emoji{font-size:36px;text-align:center;margin-bottom:10px;}
.nudge-title{font-size:20px;font-weight:700;text-align:center;margin-bottom:8px;color:var(--t1);}
.nudge-sub{font-size:14px;color:var(--t2,#6B6358);text-align:center;line-height:1.55;margin-bottom:18px;}
.nudge-perks{margin-bottom:18px;display:flex;flex-direction:column;gap:10px;}
.nudge-perk{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--t1);}
.np-icon{font-size:18px;width:24px;text-align:center;flex-shrink:0;}
.nudge-skip{width:100%;background:none;border:none;color:var(--t3,#A09890);font-size:13px;text-align:center;padding:10px;cursor:pointer;font-family:inherit;}
.login-logo{width:60px;height:60px;border-radius:16px;margin-bottom:14px;}
.login-title{font-size:22px;font-weight:700;margin-bottom:6px;color:var(--t1);}
.login-ar{color:var(--acc,#C84B2F);}
.login-sub{font-size:14px;color:var(--t2);text-align:center;line-height:1.5;margin-bottom:24px;}
.login-note{font-size:12px;color:var(--t3);text-align:center;margin-top:2px;}
.login-sheet .auth-btn{max-width:320px;}
.login-sheet .nudge-skip{margin-top:4px;}

#profile-auth-zone{margin:0 16px 16px;}
.paz-user{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--grn-bg,rgba(45,122,79,.08));border:1px solid var(--grn-bd,rgba(45,122,79,.22));border-radius:12px;margin-bottom:10px;}
.paz-avatar-img{width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;}
.paz-avatar-ini{width:40px;height:40px;border-radius:50%;flex-shrink:0;background:var(--acc-bg,rgba(200,75,47,.10));color:var(--acc,#C84B2F);font-size:16px;font-weight:700;display:flex;align-items:center;justify-content:center;}
.paz-name{font-size:14px;font-weight:600;color:var(--t1);}
.paz-email{font-size:12px;color:var(--t3);margin-top:1px;}
.paz-badge{margin-left:auto;font-size:11px;color:var(--grn,#2D7A4F);font-weight:600;white-space:nowrap;}
.paz-guest{text-align:center;padding:20px 8px;}
.paz-guest-icon{font-size:32px;margin-bottom:10px;}
.paz-guest-title{font-size:16px;font-weight:700;color:var(--t1);margin-bottom:6px;}
.paz-guest-sub{font-size:13px;color:var(--t2);line-height:1.5;margin-bottom:0;}
.paz-guest .auth-btn{max-width:100%;margin-top:10px;}
.profile-logout-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:11px 16px;background:var(--red-bg,rgba(192,57,43,.06));border:1px solid var(--red-bd,rgba(192,57,43,.20));border-radius:10px;color:var(--red,#C0392B);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;}
  `;
  document.head.appendChild(s);
})();