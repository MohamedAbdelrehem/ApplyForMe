/* ai.js — all Gemini calls go through /api/gemini proxy (key is server-side only) */
'use strict';

const AI = (() => {

  const MODEL    = 'gemini-3.1-flash-lite-preview';

  // ── CORE CALL ─────────────────────────────────────────────────────
  async function callGemini(systemInstruction, userText) {
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        systemInstruction: systemInstruction,
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error || 'API error ' + res.status);
    }

    const data = await res.json();
    return safeParseJSON(data.text || '');
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
  "languages": [{"language":"Arabic","level":"Native"},{"language":"English","level":"Fluent"}],
  "currentTitle": "most recent job title or null",
  "currentCompany": "most recent employer name or null",
  "yearsExp": "total years of professional experience as a number e.g. 4 or null",
  "seniorityLevel": "one of: Junior, Mid, Senior, Lead, Manager, Executive — inferred from experience and titles or null",
  "industryBackground": "comma-separated industries e.g. Telecom, Fintech or null",
  "noticePeriod": "notice period if stated e.g. Immediately, 1 month, 3 months or null",
  "technicalSkills": "comma-separated key technical skills or null",
  "softSkills": "comma-separated soft skills if inferable or null",
  "education": "highest degree, field, institution e.g. BSc Computer Science, Cairo University or null",
  "certifications": "comma-separated certifications e.g. ISTQB Foundation, AWS SAA or null",
  "linkedinUrl": "LinkedIn URL if present or null",
  "githubUrl": "GitHub URL if present or null",
  "portfolioUrl": "portfolio or personal website URL if present or null",
  "summary": "2-sentence professional summary based on the CV or null",
  "confidenceScore": "how complete and readable the CV was as a decimal 0.0 to 1.0 or null",
  "salaryExpectations": [{"amount":5000,"currency":"USD","label":"Remote roles"}],
  "notes_on_languages": "For languages: use level values exactly: Native, Fluent, Intermediate, Basic. Only include if clearly stated or strongly implied. If uncertain, omit rather than guess.",
  "notes_on_salary": "For salary: only extract if explicitly stated in the CV (e.g. 'expected salary', 'salary expectation'). Do NOT infer or guess. Return null array [] if nothing found."
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
    const system = `You are an expert job application email writer. Your job is to write a concise, human, and compelling application email that gets responses.

STRICT RULES:
- Use ONLY facts from the candidate profile provided — never invent skills, titles, companies, or achievements
- If the profile is sparse, write around what IS there — do not fill gaps with generic claims
- Match 2-3 specific job requirements to specific things from the candidate's background
- Tone: confident and direct, like a real person wrote it — not corporate, not a cover letter template
- Length: 100-140 words in the body. Not a word more.
- Subject line: specific and attention-grabbing — mention the role and one concrete value prop from the profile. NEVER use "Ready to be Hired" or similar generic phrases.

BODY FORMAT (use real newlines):
"Dear [recruiter first name, or Hiring Team if unknown],"
[blank line]
[1 sentence: current title + years of exp + applying for this role at this company]
[blank line]
"What I bring:"
• [bullet: specific skill/achievement from profile that matches a job requirement]
• [bullet: specific skill/achievement from profile that matches a job requirement]
• [bullet: specific skill/achievement from profile that matches a job requirement]
[blank line]
[1 sentence CTA: request a call or interview, optionally mention availability or location]
[blank line]
"Best regards,"
[Full name]

Return ONLY a raw JSON object, no markdown, no code fences:
{
  "subject": "string — specific subject line",
  "toEmail": "recruiterEmail or companyEmail from jobData, else empty string",
  "body": "full email body as single string with real newlines"
}`;

    const hasProfile = profile.firstName || profile.currentTitle || profile.technicalSkills || profile.skills;
    const profileBlock = hasProfile ? `
Candidate profile:
Name: ${[profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'Not provided'}
Current title: ${profile.currentTitle || 'Not provided'}
Current company: ${profile.currentCompany || 'Not provided'}
Years of experience: ${profile.yearsExp || 'Not specified'}
Seniority: ${profile.seniorityLevel || 'Not specified'}
Technical skills: ${profile.technicalSkills || profile.skills || 'Not provided'}
Soft skills: ${profile.softSkills || ''}
Education: ${profile.education || 'Not provided'}
Certifications: ${profile.certifications || ''}
Industry background: ${profile.industryBackground || ''}
Languages: ${Array.isArray(profile.languages) ? profile.languages.map(l => `${l.language} (${l.level})`).join(', ') : (profile.languages || '')}
Salary expectations: ${Array.isArray(profile.salaryExpectations) && profile.salaryExpectations.length ? profile.salaryExpectations.map(s => `${s.amount} ${s.currency}${s.label ? ' ('+s.label+')' : ''}`).join(', ') : 'Not specified'}
Notice period: ${profile.noticePeriod || 'Not specified'}
Location: ${[profile.city, profile.country].filter(Boolean).join(', ') || 'Not provided'}
Nationality: ${profile.nationality || ''}
LinkedIn: ${profile.linkedinUrl || ''}
GitHub: ${profile.githubUrl || ''}
Portfolio: ${profile.portfolioUrl || ''}
Professional summary: ${profile.summary || 'Not provided'}
${profile.coverTemplate ? `Tone/style notes from candidate: ${profile.coverTemplate}` : ''}` : `
Candidate profile: Not filled in yet. Write a placeholder email using only the job details, and add a [YOUR NAME] placeholder.`;

    const prompt = `Job details:
Company: ${jobData.company}
Role: ${jobData.jobTitle}
Location: ${jobData.location || 'Not specified'}
Job type: ${jobData.jobType || 'Not specified'}
Recruiter name: ${jobData.recruiterName || 'Unknown'}
Contact email: ${jobData.recruiterEmail || jobData.companyEmail || 'Not found'}
Required skills: ${(jobData.skills||[]).join(', ') || 'Not specified'}
Requirements summary: ${jobData.requirements || 'Not specified'}
Role summary: ${jobData.summary || ''}
${profileBlock}`;

    return callGemini(system, prompt);
  }

  return { parseCv, parseJobPost, generateEmailDraft };
})();