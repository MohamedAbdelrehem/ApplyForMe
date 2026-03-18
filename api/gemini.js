// api/gemini.js — Vercel Edge Function
// Proxies requests to Gemini API, keeping your key server-side.
// Deploy on Vercel, set GEMINI_API_KEY in environment variables.

export default async function handler(req, res) {
  // CORS — allow your deployed domain (or * for dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { model = 'gemini-3.1-flash-lite-preview', contents, systemInstruction, generationConfig } = req.body;

  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        // systemInstruction arrives as a plain string from ai.js
        ...(systemInstruction && {
          systemInstruction: {
            parts: [{ text: typeof systemInstruction === 'string' ? systemInstruction : systemInstruction?.parts?.[0]?.text || '' }]
          }
        }),
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 8192,
          ...generationConfig
        }
      })
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({ error: data?.error?.message || 'Gemini API error' });
    }

    // Extract text from Gemini response
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.status(200).json({ text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}