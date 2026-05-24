# Resume Tailor — GitHub Pages + Actions

A self-serve page where you paste a job description (and optionally upload a resume) and get back an ATS-friendly tailored PDF. Hosted entirely on GitHub.

```
┌──────────────────────┐    repository_dispatch    ┌────────────────────────┐
│  docs/index.html     │ ─────────────────────────▶│  GitHub Action         │
│  (GitHub Pages)      │      event_type:          │  .github/workflows/    │
│                      │      tailor_resume        │  tailor-resume.yml     │
└──────────┬───────────┘                           └──────────┬─────────────┘
           │                                                  │
           │  polls status-{id}.json                          │  scripts/tailor-cv.mjs
           │  ◀─────────────────────────────────────────────── │  → generate-pdf.mjs
           │                                                  │  → commits to tailored/
           ▼                                                  ▼
   download tailored PDF                            tailored/cv-{slug}-{date}.pdf
```

## One-time setup

1. **Add the Anthropic API key as a repo secret.**
   `Settings → Secrets and variables → Actions → New repository secret`
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** key from https://console.anthropic.com/settings/keys

   Optional: under the **Variables** tab, add `ANTHROPIC_MODEL` if you want to override the default (`claude-sonnet-4-6`).

2. **Enable GitHub Pages.**
   `Settings → Pages → Source: Deploy from a branch`. Pick your default branch (usually `main`) and folder `/docs`. Save. ~60s later the page is live at `https://sagargaba05-hub.github.io/Resume_Tailor/`.

3. **Create a Personal Access Token.**
   The page uses your PAT (stored in your browser only) to trigger the workflow.
   - Fine-grained (recommended): https://github.com/settings/personal-access-tokens/new
     - Repository access: only `Resume_Tailor`
     - Repository permissions: **Actions = Read and write**, **Contents = Read-only**
   - Or classic: https://github.com/settings/tokens/new?scopes=repo&description=resume-tailor

   Paste the token into the page's "GitHub credentials" section once — it stays in `localStorage`.

4. **Replace `cv.md` with your real resume.**
   The page can run with no upload — it falls back to `cv.md` at the repo root. The committed placeholder needs to be replaced before the fallback is useful.

## Usage

Open the Pages URL. Paste the JD, optionally upload a `.md` resume, hit **Tailor my resume**. The page:

1. POSTs to `https://api.github.com/repos/sagargaba05-hub/Resume_Tailor/dispatches`
2. Polls `tailored/status-{id}.json` every 8s
3. When `status: done`, shows a direct download link to the PDF

End-to-end runtime is ~90–120s (most of it is `playwright install`).

## What gets committed

```
tailored/
  cv-{candidate-slug}-{company-or-role-slug}-{YYYY-MM-DD}.html
  cv-{candidate-slug}-{company-or-role-slug}-{YYYY-MM-DD}.pdf
  status-{request-id}.json
```

`status-{id}.json`:

```json
{
  "id": "abc123",
  "status": "done",
  "pdf_path": "tailored/cv-sagar-gaba-acme-2026-05-13.pdf",
  "keywords_covered": 84,
  "page_format": "a4",
  "timestamp": "2026-05-13T10:24:33.000Z"
}
```

## Manual trigger

The workflow also accepts `workflow_dispatch`, so you can fire it from `Actions → Tailor Resume → Run workflow` without going through the page. Useful for testing.

## Files

```
docs/index.html                    # the page
scripts/tailor-cv.mjs              # Anthropic → tailored fields → HTML
generate-pdf.mjs                   # HTML → PDF via Playwright
templates/cv-template.html         # base CV template
fonts/                             # Space Grotesk + DM Sans (woff2)
cv.md                              # fallback resume (replace with yours)
.github/workflows/tailor-resume.yml
tailored/                          # outputs (created on first run)
```

## Cost

Per run: one Anthropic call (~3–6k input tokens, ~1.5k output tokens) and a couple of GitHub Action minutes. ~$0.02–$0.04 per tailored CV. Free Actions minutes cover personal use easily.
