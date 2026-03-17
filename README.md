# ApplyForMe — PWA + Gemini 2.5 Flash

Paste a LinkedIn job post → Gemini extracts details + writes your email → Send or schedule.

---

## Tech stack

| Layer       | Tech                             | Notes                                      |
|-------------|----------------------------------|--------------------------------------------|
| Frontend    | Vanilla HTML + CSS + JS          | Zero build step, no framework              |
| Fonts       | Bricolage Grotesque + DM Sans    | Google Fonts CDN                           |
| AI          | Gemini 2.5 Flash                 | Free tier: 10 RPM / 250 RPD                |
| API proxy   | Vercel Edge Function (`api/`)    | Keeps your API key server-side             |
| Storage     | `localStorage`                   | All data on-device, no database            |
| PWA         | manifest.json + Service Worker   | Installable on iOS & Android               |
| Hosting     | Vercel (free)                    | HTTPS, auto-deploys from GitHub            |

---

## Project structure

```
applyforme-pwa/
├── vercel.json              ← Routes /api → functions, / → public/
├── api/
│   └── gemini.js            ← Serverless proxy for Gemini API
└── public/
    ├── index.html           ← Full app (Home + Profile screens)
    ├── manifest.json        ← PWA manifest
    ├── sw.js                ← Service worker (offline support)
    ├── css/style.css        ← All styles
    ├── js/
    │   ├── ai.js            ← Calls /api/gemini → Gemini 2.5 Flash
    │   └── app.js           ← State, rendering, interactions
    └── icons/
        ├── icon-192.png
        └── icon-512.png
```

---

## 1. Get your Gemini API key (free)

1. Go to https://aistudio.google.com/app/apikey
2. Click "Create API Key"
3. Copy the key — it looks like `AIzaSy...`

---

## 2. Deploy to Vercel (free, ~3 minutes)

### Option A — GitHub (recommended, gets auto-deploys)

```bash
# Push to GitHub first
git init && git add . && git commit -m "init"
gh repo create applyforme --public --push
# or push manually to github.com
```

Then:
1. Go to https://vercel.com → "Add New Project"
2. Import your GitHub repo
3. In **Environment Variables**, add:
   - Key: `GEMINI_API_KEY`
   - Value: `AIzaSy...` (your key from step 1)
4. Click Deploy → done!

### Option B — Vercel CLI

```bash
npm i -g vercel
cd applyforme-pwa
vercel
# Follow prompts, then add env var in Vercel dashboard:
# Settings → Environment Variables → GEMINI_API_KEY = your_key
vercel --prod
```

---

## 3. Install on your phone

### iOS (Safari)
1. Open your Vercel URL in Safari
2. Tap **Share** → **Add to Home Screen**
3. Tap **Add** → ApplyForMe icon appears

### Android (Chrome)
1. Open your Vercel URL in Chrome
2. Tap **⋮** → **Add to Home Screen**
3. Or tap the **Install** banner inside the app

---

## Free tier limits (Gemini 2.5 Flash)

| Limit | Value |
|-------|-------|
| Requests per minute | 10 RPM |
| Requests per day | 250 RPD |
| Tokens per minute | 250,000 TPM |
| Cost | Free |

Each job post fetch = 2 API calls (parse + generate email). So free tier handles ~125 job applications per day — more than enough for personal use.

---

## Usage

1. **Profile tab** — Fill in your name, title, skills, cover letter template. Optionally upload your CV (stored locally by filename).
2. **Home tab** — Paste a LinkedIn job URL or paste raw job description text → tap **Fetch →**
3. Gemini extracts: company, job title, recruiter name, email address, required skills
4. Gemini writes a personalised email with subject line "Ready to be Hired — [Job Title]"
5. Tap **Regen** to try again, **Copy** to copy the full email, **Send** to open your mail app or schedule it
6. "Right now" opens your default mail app with To/Subject/Body pre-filled — just attach your CV and send

---

## Notes

- The API key is **never** sent to the browser — it lives in the Vercel serverless function only
- All profile data and drafts are stored in `localStorage` on your device
- The service worker caches the app shell so it loads instantly offline (AI features need internet)
