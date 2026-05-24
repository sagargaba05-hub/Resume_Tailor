#!/usr/bin/env node
/**
 * tailor-cv.mjs — 3-call banking/FS resume pipeline.
 *
 * Call A: ANALYSE   — read JD + match against CV in one prompt
 * Call B: DRAFT     — write the tailored resume content
 * Call C: REVIEW    — critique + format decision in one prompt (revision triggers Call B2)
 *
 * Anthropic prompt caching: CV + profile.yml are sent as a cached system block,
 * so every subsequent call only pays for new tokens (~80% cost cut on repeated context).
 *
 * Inputs:
 *   --payload <path>   JSON { id, jd, company, role, resume_text }
 *   --out-dir <path>   defaults to "tailored"
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { renderDocxFromDraft } from './render-docx.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------- helpers ----------------------
const slugify = (s) => (s || 'role').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'role';
const today = () => new Date().toISOString().slice(0, 10);
const htmlEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--payload') out.payload = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
  }
  return out;
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function extractYamlFields(yamlText) {
  const out = {};
  const grab = (key) => {
    const re = new RegExp('^[\\s-]*' + key + '\\s*:\\s*"?([^"\\n#]+?)"?\\s*$', 'm');
    const m = yamlText.match(re);
    return m ? m[1].trim() : '';
  };
  out.full_name = grab('full_name');
  out.title_line = grab('title_line');
  out.email = grab('email');
  out.phone = grab('phone');
  out.location = grab('location');
  out.linkedin = grab('linkedin');
  out.linkedin_display = grab('linkedin_display');
  out.github = grab('github');
  const toolsBlock = yamlText.match(/^tools_systems:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (toolsBlock) {
    out.tools_systems = toolsBlock[1].split('\n')
      .map(l => l.match(/^\s+-\s+"?([^"#\n]+?)"?\s*$/))
      .filter(Boolean).map(m => m[1].trim());
  } else out.tools_systems = [];
  return out;
}

// Parse "Feb 2017 - Nov 2019" / "2020 - 2022" / "Dec 2019 - Present" → end year (Present = 9999)
function periodEndYear(period) {
  if (!period) return 0;
  if (/Present|Current|Now|Ongoing/i.test(period)) return 9999;
  const years = period.match(/\d{4}/g);
  return years ? parseInt(years[years.length - 1], 10) : 0;
}

// ---------------------- setup ----------------------
const args = parseArgs(process.argv.slice(2));
if (!args.payload) { console.error('Usage: --payload <path> [--out-dir tailored]'); process.exit(2); }
const outDir = resolve(REPO_ROOT, args.outDir || 'tailored');
await mkdir(outDir, { recursive: true });

let payload, id = 'unknown';
try { payload = JSON.parse(await readFile(resolve(args.payload), 'utf-8')); id = payload.id || id; }
catch (e) { console.error('Failed to read payload:', e.message); process.exit(2); }

const stageLog = {};
async function writeStatus(id, body) {
  await writeFile(join(outDir, `status-${id}.json`), JSON.stringify(body, null, 2));
}
async function fail(msg, where) {
  console.error('ERROR:', msg);
  await writeFile(join(outDir, `stages-${id}.json`), JSON.stringify({ id, failed_at: where, stages: stageLog, error: msg }, null, 2));
  await writeStatus(id, { id, status: 'error', message: msg, stage: where, timestamp: new Date().toISOString() });
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) await fail('ANTHROPIC_API_KEY not set.', 'init');

const jd = (payload.jd || '').trim();
const company = (payload.company || '').trim();
const role = (payload.role || '').trim();
let resumeText = (payload.resume_text || '').trim();

if (!jd) await fail('Missing job description.', 'init');
if (!resumeText) {
  const fallback = resolve(REPO_ROOT, 'cv.md');
  if (!existsSync(fallback)) await fail('No resume and cv.md missing.', 'init');
  resumeText = await readFile(fallback, 'utf-8');
  console.log('Using cv.md as resume source.');
}

let profileText = '';
let profileFields = {};
const profilePath = resolve(REPO_ROOT, 'config', 'profile.yml');
if (existsSync(profilePath)) {
  profileText = await readFile(profilePath, 'utf-8');
  profileFields = extractYamlFields(profileText);
  console.log('Loaded profile.yml. name=%s location=%s', profileFields.full_name, profileFields.location);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// ============================================================
// Cached system block: CV + profile shared across all calls.
// Anthropic charges 10% for cached reads after the initial write.
// ============================================================
const STATIC_CONTEXT = `CANDIDATE CV (markdown source of truth — NEVER invent beyond this):
"""
${resumeText}
"""

CANDIDATE PROFILE (positioning, archetypes, narrative, proof points):
"""
${profileText || '(no profile.yml)'}
"""`;

async function callClaudeJSON({ stage, systemSpecific, user, max_tokens = 4096 }) {
  console.log(`\n=== ${stage} (model=${MODEL}, max_tokens=${max_tokens}) ===`);
  const hardened = user + `\n\nFINAL: Respond with a single JSON object and nothing else. Must start with "{" and end with "}". No prose, no fences.`;
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens,
    system: [
      { type: 'text', text: STATIC_CONTEXT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: systemSpecific },
    ],
    messages: [{ role: 'user', content: hardened }],
  });
  if (resp.usage) {
    const u = resp.usage;
    console.log(`  usage: input=${u.input_tokens} output=${u.output_tokens} cached_read=${u.cache_read_input_tokens ?? 0} cached_write=${u.cache_creation_input_tokens ?? 0}`);
  }
  let text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const extracted = extractFirstJsonObject(text);
    if (extracted) { try { parsed = JSON.parse(extracted); } catch {} }
    if (!parsed) {
      await writeFile(join(outDir, `raw-${id}-${stage}.txt`), text, 'utf-8');
      throw new Error(`${stage}: JSON parse failed (stop=${resp.stop_reason}, len=${text.length}). raw saved.`);
    }
  }
  stageLog[stage] = parsed;
  return parsed;
}

// ============================================================
// CALL A — combined JD analysis + CV/JD match strategy
// ============================================================
async function callA_analyzeAndMatch() {
  const systemSpecific = `You are a senior recruiter AND resume strategist for banking & financial services delivery / program-management roles in the Australian market. In ONE pass: (1) extract structured signals from the JD; (2) match the candidate's CV + profile against it.

KEYWORD EXTRACTION RULES (CRITICAL — Australian banking PMs are screened on these):
- Extract role_title EXACTLY as written in the JD (e.g. "Senior Program Manager - Operational Resilience", "Technology Service Owner"). Do NOT paraphrase. Downstream stages inject this verbatim into the resume title line for ATS matching.
- In keywords_ats include BOTH spelled-out and acronym forms when both appear or can reasonably be inferred (e.g. "Know Your Customer (KYC)", "Anti-Money Laundering (AML)", "Counter-Terrorism Financing (CTF)").
- Always SCAN for regulatory program references and include them in keywords_ats if present: APRA CPS 230, CPS 234, CPS 231, AUSTRAC, AML/CTF, KYC, KYB, Privacy Act, Consumer Data Right (CDR), Open Banking, Scams Prevention Framework, BCBS 239, operational resilience, third-party risk, critical operations.
- Always scan for delivery-framework keywords: PMP, PRINCE2, SAFe, Agile, Scrum, Waterfall, Hybrid, MSP, Lean, Six Sigma, ITIL.
- Always scan for tooling: Jira, Confluence, Clarity, ServiceNow, Workday, MS Project, Power BI, SharePoint, Tableau.

Return STRICT JSON only. Shape:
{
  "jd": {
    "role_title": string,                            // verbatim from JD
    "company": string,
    "company_country": string,
    "industry": string,
    "seniority": "junior"|"mid"|"senior"|"lead"|"executive",
    "must_have_skills": string[],
    "nice_to_have_skills": string[],
    "domain_knowledge": string[],
    "regulatory_keywords": string[],                 // e.g. CPS 230, KYC, AML/CTF, AUSTRAC
    "delivery_methodologies": string[],
    "certifications_preferred": string[],
    "value_drivers": string[],
    "keywords_ats": string[],                        // include acronym + spelled-out form when relevant
    "tone": string
  },
  "match": {
    "overall_fit": "strong"|"moderate"|"weak",
    "narrative_angle": string,
    "summary_focus": string,
    "competencies_to_surface": string[],          // 8-10 phrases
    "experience_emphasis": [{"company_and_role": string, "priority": "primary"|"secondary"|"minimal"}],
    "projects_to_highlight": string[],            // names from CV
    "keyword_injection_plan": [{"jd_keyword": string, "truthful_phrasing": string}],
    "gaps_truthful_mitigation": string[]
  }
}`;
  const user = `JOB DESCRIPTION:\n"""\n${jd}\n"""\n\nTarget company: ${company || '(not provided)'}\nTarget role: ${role || '(not provided)'}\n\nReturn the combined analysis JSON.`;
  return callClaudeJSON({ stage: 'call_a_analyze_and_match', systemSpecific, user, max_tokens: 6000 });
}

// ============================================================
// CALL B — write the tailored resume content
// ============================================================
async function callB_draft(analyzeMatch, reviewerFeedback = null) {
  const systemSpecific = `You are an expert ATS resume writer for Banking & Financial Services delivery / program-management roles in the Australian market. Produce content using ONLY facts from the CV + profile above. Reformulate, reorder, inject keywords truthfully — never invent.

TITLE-LINE RULE (CRITICAL for ATS matching):
- The title_line MUST start with the JD's exact role_title (verbatim from the analysis above), followed by a "|" separator, then the candidate's specialism stack.
- Example: if JD role_title is "Senior Program Manager - Operational Resilience", title_line is "Senior Program Manager - Operational Resilience | Banking & Regulatory Change | Digital Identity, KYC/KYB, CPS 230".
- This is what Workday/Greenhouse string-match against. Do NOT paraphrase.

REGULATORY-KEYWORD RULE:
- If the analysis surfaces any regulatory_keywords (CPS 230, CPS 234, AML/CTF, KYC, KYB, AUSTRAC, Privacy Act, CDR, BCBS 239, operational resilience, third-party risk, etc.), they MUST appear at least once in the Executive Summary and at least once in the relevant Experience bullets — truthfully (the candidate has done KYC/KYB at Westpac).
- Always include acronym + spelled-out form when first introduced (e.g., "Know Your Customer (KYC)").

EXPERIENCE-BLOCK RULE (CRITICAL — fixes the "vendor consultant" perception):
- DO NOT list each Infosys job title as a separate company entry. Group by CLIENT.
- Entries should look like: company = "Westpac (engaged via Infosys)" OR "PwC (engaged via Infosys)" — name the bank/client FIRST, then the vendor in parentheses.
- Combine adjacent Infosys roles at the SAME client into ONE entry that shows progression in the scope/bullets ("Career ladder: Systems Engineer -> Technical Analyst -> Senior Technical Analyst -> Delivery Lead").
- For the current Westpac block: company = "Westpac (engaged via Infosys Ltd.)", role = the JD's exact role_title OR the closest match from the candidate's title progression (Senior Program Manager / Service Delivery Manager).

ATS rules:
- ASCII only ("-" not em-dash; plain quotes)
- Strong verbs to open each bullet
- Include real metrics where the source CV has them
- Two pages is fine at this seniority; do not over-compress

ANTI-REPETITION (CRITICAL):
- A specific metric (e.g. "~100 FTEs", "$10M annual revenue", "20% velocity uplift", "80% risk reduction", "90% retention", "$5M") must appear AT MOST TWICE across the ENTIRE resume.
- Don't reuse the same phrasing across summary + highlights + scope + bullet. Vary the angle each time.
- The Executive Summary should NOT recite every metric — pick 1-2 that frame the headline, leave the rest for Highlights + Experience bullets.
- Career Highlights bullets should be 5 DIFFERENT outcomes, not restatements of the summary.

Output STRICT JSON, this exact shape:
{
  "name": string,
  "title_line": string,
  "location": string,
  "phone": string,
  "email": string,
  "linkedin_display": string,
  "executive_summary": string,                      // 4-5 lines, no metric repetition, weaves JD keywords
  "career_highlights": string[],                    // exactly 5 DIFFERENT-outcome bullets with metrics
  "core_capabilities": string[],                    // 8-10 phrases
  "experience": [                                   // in chronological reverse (newest first)
    {
      "company": string,
      "role": string,
      "period": string,
      "scope": string,                              // 1-2 sentences; can mention scale BUT vary phrasing from summary
      "achievements": string[]                      // 4-7 bullets, JD-relevant first
    }
  ],
  "key_projects": [                                 // in REVERSE-CHRONOLOGICAL order (newest first)
    {
      "name": string,
      "role": string,
      "budget": string,
      "team": string,
      "domain": string,
      "period": string,                              // copy exactly from CV "Period" line
      "summary": string                              // 2-3 lines on delivery outcome + business value
    }
  ],
  "education": [{"degree": string, "institution": string, "year": string}],
  "tools_systems": string[]
}`;

  const feedbackBlock = reviewerFeedback
    ? `\n\nREVIEWER FEEDBACK (address each):\n${JSON.stringify(reviewerFeedback.issues || [], null, 2)}\nMissing keywords to weave in truthfully: ${(reviewerFeedback.missing_keywords || []).join(', ')}`
    : '';

  const user = `ANALYSIS + MATCH STRATEGY:\n${JSON.stringify(analyzeMatch, null, 2)}${feedbackBlock}\n\nWrite the tailored resume JSON.`;
  return callClaudeJSON({ stage: reviewerFeedback ? 'call_b_revise' : 'call_b_draft', systemSpecific, user, max_tokens: 8000 });
}

// ============================================================
// CALL C — senior PM review (no separate format call needed)
// ============================================================
async function callC_review(draft, analyzeMatch) {
  const systemSpecific = `You are a senior Australian-banking hiring manager / agency recruiter reviewing the draft for ATS fit, keyword coverage, narrative strength, metric repetition, regulatory-keyword surfacing, title-line verbatim match, and Infosys-vendor framing risk.

EXPLICIT CHECKS:
- title_line_verbatim_ok: true ONLY if draft.title_line begins with the JD's role_title verbatim (no paraphrasing).
- regulatory_keywords_covered: list which of the JD's regulatory_keywords actually appear in summary + experience.
- experience_grouped_by_client: true if Westpac/PwC blocks are grouped per client (not split into 5 separate Infosys job entries).
- vendor_framing_risk: "low" if client is named first ("Westpac (engaged via Infosys)"), "high" if employer is listed first.

Return STRICT JSON only. Shape:
{
  "ats_score": number,
  "keyword_coverage_pct": number,
  "covered_keywords": string[],
  "missing_keywords": string[],
  "regulatory_keywords_covered": string[],
  "regulatory_keywords_missing": string[],
  "title_line_verbatim_ok": boolean,
  "experience_grouped_by_client": boolean,
  "vendor_framing_risk": "low"|"medium"|"high",
  "narrative_strength": "weak"|"ok"|"strong",
  "metric_repetition_ok": boolean,
  "issues": [{"area": string, "problem": string, "fix": string}],
  "needs_revision": boolean,                        // true if ats_score<80 OR title_line_verbatim_ok=false OR vendor_framing_risk="high" OR 2+ medium-severity issues OR metric_repetition_ok=false
  "overall_assessment": string
}`;
  const user = `JD/MATCH ANALYSIS:\n${JSON.stringify(analyzeMatch, null, 2)}\n\nDRAFT RESUME:\n${JSON.stringify(draft, null, 2)}\n\nReturn review JSON.`;
  return callClaudeJSON({ stage: 'call_c_review', systemSpecific, user, max_tokens: 3500 });
}

// ============================================================
// Render helpers
// ============================================================
function renderHighlightsHtml(items) {
  return (items || []).map((h) => `<li>${htmlEscape(h)}</li>`).join('');
}
function renderCompetencyChips(items) {
  return (items || []).slice(0, 10).map((k) => `<span class="competency-tag">${htmlEscape(k)}</span>`).join(' ');
}
function renderToolChips(items) {
  return (items || []).map((k) => `<span class="competency-tag">${htmlEscape(k)}</span>`).join(' ');
}
// Plain-text inline list for the Workday-friendly template (no chips)
function renderInlinePlain(items) {
  return (items || []).map((k) => htmlEscape(k)).join(' &middot; ');
}
function renderExperienceHtml(experience) {
  return (experience || []).map((job) => {
    const bullets = (job.achievements || []).map((b) => `<li>${htmlEscape(b)}</li>`).join('');
    return `
      <div class="job">
        <div class="job-header">
          <div><span class="job-company">${htmlEscape(job.company)}</span> &mdash; <span class="job-role">${htmlEscape(job.role)}</span></div>
          <div class="job-period">${htmlEscape(job.period)}</div>
        </div>
        <div class="job-scope"><strong>Scope:</strong> ${htmlEscape(job.scope || '')}</div>
        <div class="job-achievements-label" style="font-size:10px;font-weight:600;color:#555;margin-top:4px;">Key Achievements:</div>
        <ul>${bullets}</ul>
      </div>`;
  }).join('\n');
}
function renderProjectsHtml(projects) {
  const sorted = [...(projects || [])].sort((a, b) => periodEndYear(b.period) - periodEndYear(a.period));
  return sorted.map((p) => {
    const meta = [p.role, p.budget, p.team, p.domain, p.period].filter(Boolean).map(htmlEscape).join('<span class="sep">|</span>');
    return `
      <div class="project">
        <div class="project-title">${htmlEscape(p.name)}</div>
        <div class="project-meta">${meta}</div>
        <div class="project-desc">${htmlEscape(p.summary || '')}</div>
      </div>`;
  }).join('\n');
}
function renderEducationHtml(education) {
  return (education || []).map((e) => `
    <div class="edu-item">
      <div class="edu-header">
        <div><span class="edu-title">${htmlEscape(e.degree)}</span> &mdash; <span class="edu-org">${htmlEscape(e.institution)}</span></div>
        <div class="edu-year">${htmlEscape(e.year)}</div>
      </div>
    </div>`).join('\n');
}
function normalizeDraft(draft) {
  if (!draft) draft = {};
  draft.name             = profileFields.full_name        || draft.name || '';
  draft.title_line       = profileFields.title_line       || draft.title_line || 'Senior Project / Program Manager - Banking & Financial Services';
  draft.location         = profileFields.location         || draft.location || '';
  draft.phone            = profileFields.phone            || draft.phone || '';
  draft.email            = profileFields.email            || draft.email || '';
  draft.linkedin_display = profileFields.linkedin_display || draft.linkedin_display || '';
  draft.linkedin_url     = profileFields.linkedin         || draft.linkedin_url || '';
  if (!draft.tools_systems || draft.tools_systems.length === 0) {
    draft.tools_systems = profileFields.tools_systems || [];
  }
  // Ensure experience reverse-chronological (newest first)
  if (Array.isArray(draft.experience)) {
    draft.experience.sort((a, b) => periodEndYear(b.period) - periodEndYear(a.period));
  }
  for (const job of (draft.experience || [])) {
    if (!job.scope || !String(job.scope).trim()) {
      job.scope = `Delivery leadership at ${job.company || 'the client'} (${job.role || 'this role'}).`;
    }
  }
  // Accept either key_projects or selected_projects
  const projects = draft.key_projects || draft.selected_projects || [];
  for (const p of projects) {
    p.role   = p.role   || 'Delivery Lead';
    p.budget = p.budget || 'Not disclosed';
    p.team   = p.team   || 'Cross-functional';
    p.domain = p.domain || 'Banking / Financial Services';
    p.period = p.period || '';
  }
  draft.key_projects = projects;
  return draft;
}

async function renderAndPdf(draft) {
  // Template selection: env override RESUME_TEMPLATE=workday|polished (default polished)
  const variant = (process.env.RESUME_TEMPLATE || '').toLowerCase() === 'workday' ? 'workday' : 'polished';
  const templateFile = variant === 'workday' ? 'cv-template-workday.html' : 'cv-template.html';
  const templatePath = resolve(REPO_ROOT, 'templates', templateFile);
  if (!existsSync(templatePath)) throw new Error(`Template missing: ${templatePath}`);
  console.log(`Using template: ${templateFile} (variant=${variant})`);
  let html = await readFile(templatePath, 'utf-8');

  // Deterministic format decision — no LLM call needed.
  // Use letter if the JD analysis says the company is US/Canada; default A4.
  const country = (stageLog.call_a_analyze_and_match?.jd?.company_country || '').toLowerCase();
  const pageFormat = /(united states|usa|^us$|canada)/.test(country) ? 'letter' : 'a4';
  const pageWidth = pageFormat === 'letter' ? '8.5in' : '210mm';

  const phoneHtml = draft.phone ? `<span>${htmlEscape(draft.phone)}</span><span class="separator">|</span>` : '';

  const subs = {
    '{{LANG}}': 'en',
    '{{PAGE_WIDTH}}': pageWidth,
    '{{NAME}}': htmlEscape(draft.name || ''),
    '{{TITLE_LINE}}': htmlEscape(draft.title_line || ''),
    '{{PHONE}}': phoneHtml,
    '{{EMAIL}}': htmlEscape(draft.email || ''),
    '{{LINKEDIN_URL}}': htmlEscape(draft.linkedin_url || draft.linkedin_display || ''),
    '{{LINKEDIN_DISPLAY}}': htmlEscape(draft.linkedin_display || draft.linkedin_url || ''),
    '{{LOCATION}}': htmlEscape(draft.location || ''),
    '{{SECTION_SUMMARY}}': 'Executive Summary',
    '{{SUMMARY_TEXT}}': htmlEscape(draft.executive_summary || ''),
    '{{SECTION_HIGHLIGHTS}}': 'Career Highlights',
    '{{HIGHLIGHTS}}': renderHighlightsHtml(draft.career_highlights),
    '{{SECTION_COMPETENCIES}}': variant === 'workday' ? 'Core Skills' : 'Core Capabilities',
    '{{COMPETENCIES}}': variant === 'workday' ? renderInlinePlain(draft.core_capabilities) : renderCompetencyChips(draft.core_capabilities),
    '{{SECTION_EXPERIENCE}}': variant === 'workday' ? 'Professional Experience' : 'Professional Experience',
    '{{EXPERIENCE}}': renderExperienceHtml(draft.experience),
    '{{SECTION_PROJECTS}}': variant === 'workday' ? 'Key Projects' : 'Key Projects',
    '{{PROJECTS}}': renderProjectsHtml(draft.key_projects),
    '{{SECTION_EDUCATION}}': 'Education',
    '{{EDUCATION}}': renderEducationHtml(draft.education),
    '{{SECTION_TOOLS}}': variant === 'workday' ? 'Skills' : 'Tools & Systems',
    '{{TOOLS}}': variant === 'workday' ? renderInlinePlain(draft.tools_systems) : renderToolChips(draft.tools_systems),
  };
  for (const [k, v] of Object.entries(subs)) html = html.split(k).join(v ?? '');

  // Filename: cv-<name>-<company>-<role>-<date>.pdf  (always include both)
  // Fall back to values extracted from the JD analysis if the form fields were empty.
  const jdAnalysis = stageLog.call_a_analyze_and_match?.jd || {};
  const namePart    = slugify(draft.name || 'candidate');
  const companyPart = slugify(company || jdAnalysis.company || 'company');
  const rolePart    = slugify(role || jdAnalysis.role_title || 'role');
  const slug        = `${namePart}-${companyPart}-${rolePart}`;
  console.log(`Filename slug: ${slug} (company=${company || jdAnalysis.company || '(empty)'}, role=${role || jdAnalysis.role_title || '(empty)'})`);
  const date = today();
  const suffix = variant === 'workday' ? '-workday' : '';
  const htmlPath = join(outDir, `cv-${slug}-${date}${suffix}.html`);
  const pdfPath  = join(outDir, `cv-${slug}-${date}${suffix}.pdf`);
  await writeFile(htmlPath, html, 'utf-8');
  console.log('Wrote HTML ->', htmlPath);

  const pdfScript = resolve(REPO_ROOT, 'generate-pdf.mjs');
  const docxPath = join(outDir, `cv-${slug}-${date}${suffix}.docx`);

  // Render PDF + DOCX in parallel — they consume the same draft and don't depend on each other.
  const tRender0 = Date.now();
  await Promise.all([
    new Promise((resP, rejP) => {
      const child = spawn(process.execPath, [pdfScript, htmlPath, pdfPath, `--format=${pageFormat}`], { stdio: 'inherit', cwd: REPO_ROOT });
      child.on('exit', (code) => code === 0 ? resP() : rejP(new Error(`generate-pdf exited ${code}`)));
      child.on('error', rejP);
    }),
    renderDocxFromDraft(draft, docxPath).then(() => console.log('Wrote DOCX ->', docxPath)),
  ]);
  console.log(`Rendered PDF + DOCX in ${Math.round((Date.now() - tRender0) / 1000)}s.`);
  return { pdfPath, docxPath, pageFormat };
}

// ============================================================
// Orchestrator
// ============================================================
try {
  const t0 = Date.now();
  console.log(`Tailoring id=${id} model=${MODEL}`);

  const analyzeMatch = await callA_analyzeAndMatch();
  let draft = normalizeDraft(await callB_draft(analyzeMatch));
  const review = await callC_review(draft, analyzeMatch);

  if (review.needs_revision) {
    console.log(`Review flagged revisions; re-running draft once.`);
    draft = normalizeDraft(await callB_draft(analyzeMatch, review));
  }

  const { pdfPath, docxPath, pageFormat } = await renderAndPdf(draft);

  await writeFile(join(outDir, `stages-${id}.json`), JSON.stringify({
    id, model: MODEL, jd_chars: jd.length, resume_chars: resumeText.length,
    revised: !!review.needs_revision, stages: stageLog, final_draft: draft, page_format: pageFormat,
  }, null, 2));

  const pdfRel  = pdfPath.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
  const docxRel = docxPath.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
  await writeStatus(id, {
    id, status: 'done',
    message: review.needs_revision ? 'Tailored PDF + DOCX generated (1 revision pass applied).' : 'Tailored PDF + DOCX generated.',
    pdf_path: pdfRel,
    docx_path: docxRel,
    ats_score: review.ats_score ?? null,
    keywords_covered: review.keyword_coverage_pct ?? null,
    overall_fit: stageLog.call_a_analyze_and_match?.match?.overall_fit || null,
    page_format: pageFormat,
    elapsed_seconds: Math.round((Date.now() - t0) / 1000),
    timestamp: new Date().toISOString(),
  });
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s. PDF: ${pdfPath}  DOCX: ${docxPath}`);
} catch (e) {
  await fail(e.message || String(e), 'orchestration');
}
