// api/admin.js — Vercel Serverless Function
// Uses Firebase Admin SDK (service account) — Firestore rules don't apply here.
// Set these env vars in Vercel dashboard:
//   ADMIN_PASSWORD      — your admin password
//   FIREBASE_PROJECT_ID — e.g. fursa-apply
//   FIREBASE_CLIENT_EMAIL — from service account JSON
//   FIREBASE_PRIVATE_KEY  — from service account JSON (include the \n newlines)
//
// ── FIRESTORE SECURITY RULES REQUIRED ────────────────────────────────────────
// Add these rules to your Firestore console to lock down the guests collection.
// Guests write their own data (by guestId stored in localStorage), no one reads it
// client-side — only the Admin SDK (this file) reads it server-side.
//
// rules_version = '2';
// service cloud.firestore {
//   match /databases/{database}/documents {
//     match /users/{uid}/{document=**} {
//       allow read, write: if request.auth != null && request.auth.uid == uid;
//     }
//     match /guests/{gid}/{document=**} {
//       // Guests can write their own doc by matching their localStorage guestId.
//       // No client-side reads — admin reads via SDK which bypasses these rules.
//       allow write: if true;   // guestId is a UUID — unguessable by others
//       allow read:  if false;  // only Admin SDK reads guest data
//     }
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Auth check ────────────────────────────────────────────────
  const pw = req.headers['x-admin-password'];
  if (!pw || pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const action = req.query.action || 'users';

  try {
    const db = getDb();

    // ── GET /api/admin?action=users ───────────────────────────────
    if (action === 'users') {
      const snap  = await db.collection('users').get();
      const users = [];

      await Promise.all(snap.docs.map(async docSnap => {
        const u   = docSnap.data();
        const uid = docSnap.id;
        let profile = {}, data = {};
        try {
          const [ps, ds] = await Promise.all([
            db.doc(`users/${uid}/profile/main`).get(),
            db.doc(`users/${uid}/data/main`).get(),
          ]);
          if (ps.exists) profile = ps.data() || {};
          if (ds.exists) data    = ds.data() || {};
        } catch (_) {}
        users.push({ uid, ...u, _p: profile, _d: data });
      }));

      users.sort((a, b) => {
        const ta = a.lastActiveAt?._seconds || 0;
        const tb = b.lastActiveAt?._seconds || 0;
        return tb - ta;
      });

      return res.status(200).json({ users: users.map(u => serializeUser(u)) });
    }

    // ── GET /api/admin?action=events ──────────────────────────────
    // Events are stored as day docs: users/{uid}/events/{YYYY-MM-DD}
    // Each doc has an events[] array. We unpack them into a flat list.
    if (action === 'events') {
      // No orderBy — sort in JS to avoid requiring a Firestore index.
      const snap = await db.collection('users').limit(50).get();
      const flat = [];

      await Promise.all(snap.docs.map(async docSnap => {
        const uid  = docSnap.id;
        const user = serializeUser({ uid, ...docSnap.data() });
        try {
          // Each doc is one day; get the 7 most recent days
          const evSnap = await db.collection(`users/${uid}/events`).limit(7).get();
          evSnap.forEach(dayDoc => {
            const dayData = serializeDoc(dayDoc.data());
            const evArr   = Array.isArray(dayData.events) ? dayData.events : [];
            evArr.forEach(ev => flat.push({ ...ev, _uid: uid, _user: user }));
          });
        } catch (_) {}
      }));

      flat.sort((a, b) => (b.ts || b.createdAt || 0) - (a.ts || a.createdAt || 0));
      return res.status(200).json({ events: flat.slice(0, 100) });
    }

    // ── GET /api/admin?action=guests ──────────────────────────────
    // Guest data now lives under guests/{gid}/* — same structure as users.
    // Root doc has summary fields; profile/main and data/main have full data.
    if (action === 'guests') {
      // No orderBy here — it requires a Firestore index that may not exist.
      // We sort in JS below instead, same pattern as the users action.
      const snap = await db.collection('guests').limit(200).get();
      const guests = [];

      await Promise.all(snap.docs.map(async docSnap => {
        const gid  = docSnap.id;
        const root = docSnap.data();

        // Skip guests that have already converted to a registered user account.
        // The client stamps convertedToUid on the root doc during migration
        // before deleting subcollections — so even if deletion is mid-flight,
        // converted guests are invisible in the admin panel immediately.
        if (root.convertedToUid) return;

        let profile = {}, data = {}, eventCount = 0, eventTypes = {};

        try {
          const [pSnap, dSnap, evSnap] = await Promise.all([
            db.doc(`guests/${gid}/profile/main`).get(),
            db.doc(`guests/${gid}/data/main`).get(),
            db.collection(`guests/${gid}/events`).limit(7).get(),
          ]);
          if (pSnap.exists) profile = pSnap.data() || {};
          if (dSnap.exists) data    = dSnap.data() || {};
          evSnap.forEach(dayDoc => {
            const evs = Array.isArray(dayDoc.data().events) ? dayDoc.data().events : [];
            eventCount += evs.length;
            evs.forEach(ev => { eventTypes[ev.type] = (eventTypes[ev.type]||0) + 1; });
          });
        } catch(_) {}

        guests.push(serializeUser({
          gid, ...root,
          _p: profile,
          _d: data,
          eventCount,
          eventTypes,
        }));
      }));

      guests.sort((a,b) => (b.lastActiveAt||0) - (a.lastActiveAt||0));
      return res.status(200).json({ guests });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (e) {
    console.error('[admin]', e);
    return res.status(500).json({ error: e.message });
  }
}

// Convert Firestore Timestamps → epoch ms so JSON serializes cleanly
function serializeDoc(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && '_seconds' in v) {
      out[k] = v._seconds * 1000;
    } else if (Array.isArray(v)) {
      out[k] = v.map(serializeDoc);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = serializeDoc(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function serializeUser(u) {
  const s = serializeDoc(u);
  if (s._p) s._p = serializeDoc(s._p);
  if (s._d) s._d = serializeDoc(s._d);
  return s;
}