// api/admin.js — Vercel Serverless Function
// Uses Firebase Admin SDK (service account) — Firestore rules don't apply here.
// Set these env vars in Vercel dashboard:
//   ADMIN_PASSWORD      — your admin password
//   FIREBASE_PROJECT_ID — e.g. fursa-apply
//   FIREBASE_CLIENT_EMAIL — from service account JSON
//   FIREBASE_PRIVATE_KEY  — from service account JSON (include the \n newlines)

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
            db.doc(`users/${uid}/profile/profile`).get(),
            db.doc(`users/${uid}/data/data`).get(),
          ]);
          // profile and data are stored as single docs — try both path styles
          if (ps.exists) profile = ps.data() || {};
          if (ds.exists) data    = ds.data() || {};
        } catch (_) {}
        users.push({ uid, ...u, _p: profile, _d: data });
      }));

      // Sort by lastActiveAt desc
      users.sort((a, b) => {
        const ta = a.lastActiveAt?._seconds || 0;
        const tb = b.lastActiveAt?._seconds || 0;
        return tb - ta;
      });

      // Serialize Firestore Timestamps to ms
      return res.status(200).json({ users: users.map(u => serializeUser(u)) });
    }

    // ── GET /api/admin?action=events ──────────────────────────────
    if (action === 'events') {
      // Fetch recent users first (max 30) then pull their events
      const snap  = await db.collection('users').orderBy('lastActiveAt', 'desc').limit(30).get();
      const events = [];

      await Promise.all(snap.docs.map(async docSnap => {
        const uid  = docSnap.id;
        const user = serializeUser({ uid, ...docSnap.data() });
        try {
          const evSnap = await db.collection(`users/${uid}/events`)
            .orderBy('createdAt', 'desc').limit(5).get();
          evSnap.forEach(d => events.push({ ...serializeDoc(d.data()), _uid: uid, _user: user }));
        } catch (_) {}
      }));

      events.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return res.status(200).json({ events: events.slice(0, 50) });
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