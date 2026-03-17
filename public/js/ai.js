/* ai.js — Gemini, direct browser call for Live Server / local testing
   ⚠️  Replace YOUR_KEY_HERE with your key from https://aistudio.google.com/app/apikey */
'use strict';

const AI = (() => {

  const API_KEY  = 'AIzaSyC4R7rH-PDtZe78ANesPCf2w_tFSdx5sPk'; // ← paste your key here
  const MODEL    = 'gemini-3.1-flash-lite-preview';
  const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  // ── CORE CALL (text-only, works with all models) ───────────────────
  async function callGemini(systemInstruction, userText) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || 'Gemini error ' + res.status);
    }

    const data = await res.json();
    const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return safeParseJSON(raw);
  }

  // ── JSON PARSER ────────────────────────────────────────────────────
  function safeParseJSON(raw) {
    let text = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try { return JSON.parse(text); } catch (_) {}
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      const block = text.slice(start, end + 1);
      try { return JSON.parse(block); } catch (_) {}
      const fixed = block
        .replace(/:\s*'([^']*)'/g, ': "$1"')
        .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')
        .replace(/,\s*([}\]])/g, '$1');
      try { return JSON.parse(fixed); } catch (_) {}
    }
    throw new Error('Could not parse Gemini response:\n' + raw.slice(0, 300));
  }

  // ── CV TEXT EXTRACTION (browser-side, no server needed) ────────────
  // For PDFs: uses PDF.js CDN to extract text page by page
  // For DOCX: reads the zip and pulls plain text from word/document.xml
  async function extractCvText(file) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'pdf') {
      return extractPdfText(file);
    } else if (ext === 'docx') {
      return extractDocxText(file);
    } else {
      // Fallback: try reading as plain text
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload  = () => resolve(r.result);
        r.onerror = reject;
        r.readAsText(file);
      });
    }
  }

  async function extractPdfText(file) {
    // Dynamically load PDF.js from CDN
    if (!window.pdfjsLib) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      fullText += pageText + '\n';
    }

    return fullText.trim();
  }

  async function extractDocxText(file) {
    // DOCX is a zip — extract word/document.xml and strip tags
    if (!window.JSZip) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    }
    const arrayBuffer = await file.arrayBuffer();
    const zip  = await window.JSZip.loadAsync(arrayBuffer);
    const xml  = await zip.file('word/document.xml').async('string');
    // Strip XML tags, collapse whitespace
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ── CV PARSING ─────────────────────────────────────────────────────
  async function parseCv(file) {
    const cvText = await extractCvText(file);

    if (!cvText || cvText.length < 50) {
      throw new Error('Could not extract text from CV file');
    }

    const system = `You are a CV/resume parser. Extract the candidate's info from the CV text provided.
Return ONLY a raw JSON object. No markdown, no code fences, no explanation. Double quotes only.
{
  "firstName": "string or null",
  "lastName": "string or null",
  "email": "string or null",
  "phone": "string or null",
  "city": "string or null",
  "country": "string or null",
  "nationality": "string or null",
  "currentTitle": "most recent job title as string or null",
  "yearsExp": "total years of experience as number string e.g. 4 or null",
  "linkedinUrl": "linkedin URL if present or null",
  "skills": "comma-separated key technical skills as one string or null",
  "summary": "2-sentence professional summary based on the CV or null"
}`;

    return callGemini(system, 'Parse this CV:\n\n' + cvText.slice(0, 6000));
  }

  // ── JOB POST PARSING ───────────────────────────────────────────────
  async function parseJobPost(postText) {
    const system = `You are a job post analyzer. Extract structured info from the job description.
Return ONLY a raw JSON object. No markdown, no code fences. Double-quoted keys and values only.
{
  "company": "string",
  "jobTitle": "string",
  "recruiterName": "string or null",
  "recruiterEmail": "IMPORTANT: extract ANY email address mentioned in the post text verbatim — this is the highest priority field",
  "companyEmail": "any other company email found or null",
  "poster": "name of the person who posted this if mentioned, else null",
  "location": "string or null",
  "jobType": "Full-time or Part-time or Contract or Remote or null",
  "skills": ["required skill 1", "required skill 2", "required skill 3"],
  "requirements": "key requirements as a short comma-separated string",
  "summary": "one sentence describing the role"
}
If you see text like send to X@Y.com or email X@Y.com or CV to X@Y.com — that email MUST go in recruiterEmail.`;

    return callGemini(system, 'Extract from this job post:\n\n' + postText);
  }

  // ── EMAIL GENERATION ───────────────────────────────────────────────
  async function generateEmailDraft(jobData, profile) {
    const system = `You are a professional job application email writer.
Write a SHORT, punchy, structured application email. No fluff. No filler sentences.

Format the body EXACTLY like this (use actual newlines in the string):
Line 1: "Dear [recruiter first name or Hiring Team],"
Line 2: blank
Line 3: One sentence — who you are, your title, years of experience, and the role you are applying for.
Line 4: blank
Line 5: "What I bring:"
Lines 6-8: Three bullet points starting with "•". Each bullet = ONE concrete skill or achievement that directly matches a job requirement. Use specific tools, numbers, or outcomes from the candidate profile.
Line 9: blank
Line 10: One sentence CTA asking for an interview or call, mentioning availability.
Line 11: blank
Line 12: "Best regards,"
Line 13: Candidate full name

Rules:
- 120-150 words MAX
- Only use skills and facts from the candidate profile — no invention
- Each bullet must reference something specific from the job requirements
- Tone: direct, confident, professional — not stiff

Return ONLY a raw JSON object. No markdown, no code fences:
{
  "subject": "Ready to be Hired — [exact job title]",
  "toEmail": "use recruiterEmail or companyEmail from jobData, else empty string",
  "body": "full formatted email as a single string"
}`;

    const prompt = `Job details:
Company: ${jobData.company}
Role: ${jobData.jobTitle}
Requirements: ${jobData.requirements || ''}
Required skills: ${(jobData.skills||[]).join(', ')}
Recruiter: ${jobData.recruiterName || 'unknown'}
Email: ${jobData.recruiterEmail || jobData.companyEmail || ''}

Candidate profile:
Name: ${profile.firstName || ''} ${profile.lastName || ''}
Title: ${profile.currentTitle || ''}
Experience: ${profile.yearsExp || '?'} years
Skills: ${profile.skills || ''}
Summary: ${profile.summary || ''}
Location: ${profile.city || ''}, ${profile.country || ''}
LinkedIn: ${profile.linkedinUrl || ''}`;

    return callGemini(system, prompt);
  }

  return { parseCv, parseJobPost, generateEmailDraft };
})();
