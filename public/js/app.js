'use strict';

// ── STATE ──────────────────────────────────────────────────────────
const State = {
  profile: {},
  drafts: [],
  links: [],       // saved posts: { id, url, poster, company, jobTitle, email, savedAt }
  stats: { sent: 0 },

  load() {
    try {
      this.profile = JSON.parse(localStorage.getItem('afm_profile') || '{}');
      this.drafts  = JSON.parse(localStorage.getItem('afm_drafts')  || '[]');
      this.links   = JSON.parse(localStorage.getItem('afm_links')   || '[]');
      this.stats   = JSON.parse(localStorage.getItem('afm_stats')   || '{"sent":0}');
    } catch { this.profile={}; this.drafts=[]; this.links=[]; this.stats={sent:0}; }
  },

  save() {
    localStorage.setItem('afm_profile', JSON.stringify(this.profile));
    localStorage.setItem('afm_drafts',  JSON.stringify(this.drafts));
    localStorage.setItem('afm_links',   JSON.stringify(this.links));
    localStorage.setItem('afm_stats',   JSON.stringify(this.stats));
  },

  addDraft(d)       { this.drafts.unshift(d); this.save(); },
  removeDraft(id)   { this.drafts = this.drafts.filter(d=>d.id!==id); this.save(); },
  updateDraft(id,p) { const i=this.drafts.findIndex(d=>d.id===id); if(i>-1){Object.assign(this.drafts[i],p);this.save();} },

  addLink(l)        { if(!this.links.find(x=>x.url===l.url)) { this.links.unshift(l); this.save(); } },
  removeLink(id)    { this.links = this.links.filter(l=>l.id!==id); this.save(); }
};

// ── UTILS ──────────────────────────────────────────────────────────
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const ini  = n => (n||'??').split(' ').slice(0,2).map(w=>w[0]||'').join('').toUpperCase() || '??';

const LOGO_COLORS = [
  ['#FDE8E2','#C84B2F'],['#E2EFE8','#2D7A4F'],['#FEF3DC','#A0620A'],
  ['#E8E4F5','#5B4FCF'],['#E2EEF8','#2563EB'],['#FDE8F0','#BE185D'],
  ['#E8F4F0','#0F766E'],['#F5EFE2','#92400E'],
];
const logoCols = s => { let h=0; for(const c of(s||''))h=(h*31+c.charCodeAt(0))&0xffffffff; return LOGO_COLORS[Math.abs(h)%LOGO_COLORS.length]; };

let _toastTimer;
function toast(msg, dur=2600) {
  const el = document.getElementById('toast');
  el.textContent=msg; el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(()=>el.classList.remove('show'), dur);
}

// ── TABS ───────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
  document.getElementById('tab-'+name).classList.add('active');
  // Update tab icon strokes
  document.querySelectorAll('.tab svg').forEach(svg=>svg.setAttribute('stroke','#A09890'));
  const icon = document.querySelector('#tab-'+name+' .tab-icon svg');
  if(icon) icon.setAttribute('stroke','#C84B2F');
  if(name==='links') renderLinks();
}

// ── STATS ──────────────────────────────────────────────────────────
function refreshStats() {
  document.getElementById('stat-drafts').textContent    = State.drafts.filter(d=>d.status==='draft').length;
  document.getElementById('stat-sent').textContent      = State.stats.sent;
  document.getElementById('stat-scheduled').textContent = State.drafts.filter(d=>d.status==='scheduled').length;
}

// ── DRAFT CARDS ────────────────────────────────────────────────────
function renderCards() {
  const wrap  = document.getElementById('cards-wrap');
  const empty = document.getElementById('empty-state');
  if(!State.drafts.length){ wrap.innerHTML=''; empty.classList.add('show'); refreshStats(); return; }
  empty.classList.remove('show');

  const existing = new Set([...wrap.querySelectorAll('.dcard')].map(e=>e.dataset.id));
  const current  = new Set(State.drafts.map(d=>d.id));
  existing.forEach(id=>{ if(!current.has(id)) wrap.querySelector(`.dcard[data-id="${id}"]`)?.remove(); });

  State.drafts.forEach((d,i)=>{
    let el = wrap.querySelector(`.dcard[data-id="${d.id}"]`);
    if(!el){
      el = buildCard(d);
      const prev = i>0 ? wrap.querySelector(`.dcard[data-id="${State.drafts[i-1].id}"]`) : null;
      if(i===0) wrap.prepend(el); else if(prev) prev.after(el); else wrap.append(el);
    } else {
      const badge = el.querySelector('.badge');
      if(badge){ badge.className='badge '+badgeCls(d.status); badge.textContent=badgeLbl(d); }
    }
  });
  refreshStats();
}

function badgeCls(s){ return {draft:'badge-new',scheduled:'badge-sch',sent:'badge-sent'}[s]||'badge-new'; }
function badgeLbl(d){ if(d.status==='scheduled'&&d.schedLabel) return d.schedLabel; return {draft:'New',scheduled:'Sched',sent:'Sent'}[d.status]||'Draft'; }

function buildCard(d) {
  const [bg,fg] = logoCols(d.company);
  const el = document.createElement('div');
  el.className='dcard'; el.dataset.id=d.id;
  // Source row only if we have a URL
  const srcRow = d.sourceUrl ? `
    <div class="src-row">
      <span class="src-label">Source</span>
      <a class="src-link" href="${esc(d.sourceUrl)}" target="_blank" onclick="event.stopPropagation()">${esc(d.sourceUrl.length>45?d.sourceUrl.slice(0,45)+'…':d.sourceUrl)}</a>
      ${d.poster?`<span class="src-poster">· ${esc(d.poster)}</span>`:''}
    </div>` : '';

  el.innerHTML = `
<div class="dcard-top">
  <div class="dcard-co">
    <div class="co-logo" style="background:${bg};color:${fg}">${esc(ini(d.company))}</div>
    <div>
      <div class="co-name">${esc(d.company)}</div>
      <div class="co-role">${esc(d.jobTitle)}</div>
    </div>
  </div>
  <span class="badge ${badgeCls(d.status)}">${badgeLbl(d)}</span>
</div>
<div class="dcard-div"></div>
<div class="dcard-meta">
  <div class="meta-row"><span class="meta-k">To</span><span class="meta-v em">${esc(d.toEmail||'—')}</span></div>
  ${d.recruiterName?`<div class="meta-row"><span class="meta-k">Recruiter</span><span class="meta-v">${esc(d.recruiterName)}</span></div>`:''}
  <div class="meta-row"><span class="meta-k">Subject</span><span class="meta-v">${esc(d.subject)}</span></div>
</div>
<div class="body-prev" onclick="this.classList.toggle('exp')">${esc(d.body)}</div>
${srcRow}
<div class="dcard-acts">
  <button class="act regen" onclick="regenDraft('${d.id}')">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
    Regen
  </button>
  <button class="act copy" onclick="copyDraft('${d.id}')">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    Copy
  </button>
  <button class="act send" onclick="openSched('${d.id}')">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    Send
  </button>
  <button class="act del" onclick="deleteDraft('${d.id}')">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
  </button>
</div>`;
  return el;
}

// ── SAVED LINKS ────────────────────────────────────────────────────
function renderLinks() {
  const list  = document.getElementById('links-list');
  const empty = document.getElementById('empty-links');
  if(!State.links.length){ list.innerHTML=''; empty.classList.add('show'); return; }
  empty.classList.remove('show');
  list.innerHTML = State.links.map(l => `
<div class="link-card" id="lc-${l.id}">
  <div class="lc-top">
    <div class="lc-company">${esc(l.company||'Unknown')}</div>
    <div class="lc-role">${esc(l.jobTitle||'')}</div>
    <div class="lc-meta">
      ${l.email?`<span class="lc-tag">${esc(l.email)}</span>`:''}
      ${l.savedAt?`<span class="lc-tag">${new Date(l.savedAt).toLocaleDateString()}</span>`:''}
    </div>
  </div>
  <div class="lc-div"></div>
  <div class="lc-bottom">
    <a class="lc-url" href="${esc(l.url)}" target="_blank">${esc(l.url.length>50?l.url.slice(0,50)+'…':l.url)}</a>
    ${l.poster?`<span class="lc-poster">${esc(l.poster)}</span>`:''}
    <span class="lc-del" onclick="deleteLink('${l.id}')">×</span>
  </div>
</div>`).join('');
}

function deleteLink(id) {
  const el = document.getElementById('lc-'+id);
  if(el){ el.style.cssText='transition:opacity .2s;opacity:0'; setTimeout(()=>{ State.removeLink(id); renderLinks(); },210); }
}

// ── FETCH + GENERATE ───────────────────────────────────────────────
async function fetchPost() {
  const input = document.getElementById('url-input');
  const val   = input.value.trim();
  if(!val){ toast('Paste a LinkedIn URL or job description first'); return; }

  const btn  = document.getElementById('fetch-btn');
  const ind  = document.getElementById('fetch-ind');
  const step = document.getElementById('fetch-step');
  btn.disabled=true; ind.classList.add('show');

  try {
    step.textContent = 'Extracting job details…';
    const jobData = await AI.parseJobPost(val);

    if(!jobData||jobData.company==='Unknown'){
      toast('Couldn\'t parse — try pasting the full job description text'); return;
    }

    step.textContent = 'Writing your email…';
    const email = await AI.generateEmailDraft(jobData, State.profile);
    if(!email){ toast('Email generation failed — try again'); return; }

    // Determine the best email from the post data (not from AI guess)
    const bestEmail = jobData.recruiterEmail || jobData.companyEmail || email.toEmail || '';

    const draft = {
      id:            uid(),
      status:        'draft',
      company:       jobData.company       || 'Unknown',
      jobTitle:      jobData.jobTitle      || 'Position',
      recruiterName: jobData.recruiterName || null,
      toEmail:       bestEmail,
      subject:       email.subject,
      body:          email.body,
      skills:        jobData.skills        || [],
      requirements:  jobData.requirements  || '',
      sourceUrl:     val.startsWith('http') ? val : null,
      poster:        jobData.poster        || null,
      createdAt:     new Date().toISOString()
    };

    // Save to links automatically
    State.addLink({
      id:       uid(),
      url:      val.startsWith('http') ? val : '',
      poster:   jobData.poster || null,
      company:  jobData.company,
      jobTitle: jobData.jobTitle,
      email:    bestEmail,
      savedAt:  new Date().toISOString()
    });

    State.addDraft(draft); renderCards(); input.value='';
    toast(`Draft ready — ${draft.company}`);

  } catch(err) {
    console.error(err);
    toast('Error: '+(err.message||'Something went wrong'));
  } finally {
    btn.disabled=false; ind.classList.remove('show');
  }
}

async function regenDraft(id) {
  const d = State.drafts.find(x=>x.id===id); if(!d) return;
  toast('Regenerating…');
  try {
    const email = await AI.generateEmailDraft(
      { company:d.company, jobTitle:d.jobTitle, recruiterName:d.recruiterName, skills:d.skills, requirements:d.requirements },
      State.profile
    );
    if(email){
      State.updateDraft(id, { subject:email.subject, body:email.body });
      renderCards(); toast('Email regenerated!');
    }
  } catch { toast('Regen failed — try again'); }
}

function copyDraft(id) {
  const d = State.drafts.find(x=>x.id===id); if(!d) return;
  const text = `To: ${d.toEmail}\nSubject: ${d.subject}\n\n${d.body}`;
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(text).then(()=>toast('Copied to clipboard!'));
  } else {
    const ta=document.createElement('textarea'); ta.value=text; ta.style.cssText='position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    toast('Copied to clipboard!');
  }
}

function deleteDraft(id) {
  const el = document.querySelector(`.dcard[data-id="${id}"]`);
  if(el){ el.style.cssText='transition:opacity .2s,transform .2s;opacity:0;transform:translateX(18px)'; setTimeout(()=>{ State.removeDraft(id); renderCards(); },210); }
}

// ── SCHEDULE ──────────────────────────────────────────────────────
function openSched(id){ State.activeCard=id; document.getElementById('overlay').classList.add('open'); }
function closeSched() { document.getElementById('overlay').classList.remove('open'); }

function selectOpt(el,val){
  document.querySelectorAll('.sopt').forEach(o=>o.classList.remove('sel'));
  el.classList.add('sel'); State.schedOpt=val;
  document.getElementById('custom-row').classList.toggle('show',val==='custom');
}

function confirmSched() {
  const id=State.activeCard, opt=State.schedOpt;
  const d=State.drafts.find(x=>x.id===id); if(!d){closeSched();return;}

  if(opt==='now'){
    // Build mailto — CV attach note in body since browsers can't attach files
    const cvNote = State.profile.cvName ? `\n\n[Please note: attach ${State.profile.cvName} before sending]` : '';
    const mailto = `mailto:${encodeURIComponent(d.toEmail)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body+cvNote)}`;
    window.open(mailto,'_blank');
    State.updateDraft(id,{status:'sent'}); State.stats.sent++; State.save();
    renderCards();
    toast(State.profile.cvName ? `Mail opened — attach ${State.profile.cvName}!` : 'Mail app opened!');
  } else {
    const labels = { morning:'Tomorrow 9am', afternoon:'Tomorrow 2pm', custom:'' };
    const lbl = opt==='custom'
      ? (()=>{ const date=document.getElementById('custom-date').value, time=document.getElementById('custom-time').value; return(date&&time)?`${time} · ${date}`:'Custom time'; })()
      : labels[opt];
    State.updateDraft(id,{status:'scheduled',schedLabel:lbl});
    renderCards(); toast(`Scheduled: ${lbl}`);
  }
  closeSched();
}

// ── PROFILE ───────────────────────────────────────────────────────
const FIELDS = ['firstName','lastName','email','phone','dob','city','country','nationality','currentTitle','yearsExp','linkedinUrl','skills','coverTemplate','summary'];

function loadProfileForm() {
  FIELDS.forEach(f=>{ const el=document.getElementById('pf-'+f); if(el&&State.profile[f]) el.value=State.profile[f]; });
  if(State.profile.cvName) showCvDone(State.profile.cvName, State.profile.cvSize||'');
}

function saveProfile() {
  FIELDS.forEach(f=>{ const el=document.getElementById('pf-'+f); if(el) State.profile[f]=el.value.trim(); });
  State.save();
  const name=State.profile.firstName;
  if(name) document.getElementById('greeting-name').textContent=name;
  toast('Profile saved!');
}

function showCvDone(name, size, parsing=false) {
  document.getElementById('cv-upload-box').style.display='none';
  const done=document.getElementById('cv-done');
  done.classList.add('show'); done.classList.toggle('parsing',parsing);
  document.getElementById('cv-fn').textContent=name;
  document.getElementById('cv-sz').textContent=size||'Uploading…';
}
function changeCv() {
  document.getElementById('cv-done').classList.remove('show');
  document.getElementById('cv-upload-box').style.display='';
}

let _lastCvFile = null;

async function handleCv(file) {
  if(!file) return;
  _lastCvFile=file;
  const sz = file.size<1024*1024 ? Math.round(file.size/1024)+' KB' : (file.size/(1024*1024)).toFixed(1)+' MB';
  State.profile.cvName=file.name; State.profile.cvSize=sz; State.save();
  showCvDone(file.name,'Extracting text…',true);
  toast('Reading your CV…');
  try {
    const parsed = await AI.parseCv(file);
    const map = {
      firstName:parsed.firstName, lastName:parsed.lastName,
      email:parsed.email, phone:parsed.phone,
      city:parsed.city, country:parsed.country,
      nationality:parsed.nationality, currentTitle:parsed.currentTitle,
      yearsExp:parsed.yearsExp, linkedinUrl:parsed.linkedinUrl,
      skills:parsed.skills, summary:parsed.summary
    };
    let filled=0;
    Object.entries(map).forEach(([key,val])=>{
      if(!val) return;
      State.profile[key]=val;
      const el=document.getElementById('pf-'+key);
      if(el){ el.value=val; filled++; }
    });
    if(parsed.summary) State.profile.summary=parsed.summary;
    State.save();
    document.getElementById('cv-done').classList.remove('parsing');
    document.getElementById('cv-sz').textContent=sz+' · '+filled+' fields filled';
    toast('CV parsed — '+filled+' fields auto-filled!');
  } catch(err) {
    console.error('CV parse error:',err);
    document.getElementById('cv-done').classList.remove('parsing');
    document.getElementById('cv-sz').textContent=sz+' · Tap Autofill to retry';
    toast('Could not auto-fill — tap "Autofill CV" to retry');
  }
}

async function autofillFromCv() {
  if(!_lastCvFile){ document.getElementById('cv-file').click(); toast('Pick your CV to autofill'); return; }
  const btn=document.getElementById('autofill-btn');
  btn.classList.add('running'); toast('Re-parsing CV…');
  try {
    const parsed=await AI.parseCv(_lastCvFile);
    let filled=0;
    const map={firstName:parsed.firstName,lastName:parsed.lastName,email:parsed.email,phone:parsed.phone,city:parsed.city,country:parsed.country,nationality:parsed.nationality,currentTitle:parsed.currentTitle,yearsExp:parsed.yearsExp,linkedinUrl:parsed.linkedinUrl,skills:parsed.skills,summary:parsed.summary};
    Object.entries(map).forEach(([key,val])=>{
      if(!val) return;
      State.profile[key]=val;
      const el=document.getElementById('pf-'+key);
      if(el){ el.value=val; filled++; }
    });
    if(parsed.summary) State.profile.summary=parsed.summary;
    State.save(); toast(filled+' fields filled from CV!');
  } catch(err){ console.error(err); toast('Could not parse CV: '+err.message); }
  finally { btn.classList.remove('running'); }
}

// ── INSTALL ───────────────────────────────────────────────────────
let deferredInstall=null;
const isIos=()=>/iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone=()=>window.navigator.standalone===true||window.matchMedia('(display-mode:standalone)').matches;

window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); deferredInstall=e; document.getElementById('install-banner').classList.add('show'); });
function installApp(){ if(!deferredInstall) return; deferredInstall.prompt(); deferredInstall.userChoice.then(r=>{ if(r.outcome==='accepted') toast('Installed!'); deferredInstall=null; document.getElementById('install-banner').classList.remove('show'); }); }
function dismissInstall(){ document.getElementById('install-banner').classList.remove('show'); }
function showIosBanner(){ document.getElementById('ios-banner').classList.add('show'); }
function dismissIos(){ document.getElementById('ios-banner').classList.remove('show'); localStorage.setItem('afm_ios_dismissed','1'); }

// ── INIT ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  State.load();
  const name=State.profile.firstName;
  if(name) document.getElementById('greeting-name').textContent=name;
  renderCards(); loadProfileForm(); refreshStats();

  if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
  if(isIos()&&!isStandalone()&&!localStorage.getItem('afm_ios_dismissed')) setTimeout(()=>showIosBanner(),1200);

  document.getElementById('url-input').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();fetchPost();} });
  document.getElementById('overlay').addEventListener('click',e=>{ if(e.target===document.getElementById('overlay')) closeSched(); });
  document.getElementById('cv-file').addEventListener('change',e=>handleCv(e.target.files[0]));
  document.getElementById('cv-upload-box').addEventListener('click',()=>document.getElementById('cv-file').click());
  const cvBox=document.getElementById('cv-upload-box');
  cvBox.addEventListener('dragover',e=>{e.preventDefault();cvBox.style.opacity='0.7';});
  cvBox.addEventListener('dragleave',()=>{cvBox.style.opacity='1';});
  cvBox.addEventListener('drop',e=>{e.preventDefault();cvBox.style.opacity='1';handleCv(e.dataTransfer.files[0]);});
});
