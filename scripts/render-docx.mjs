// render-docx.mjs — render the tailored CV draft as an ATS-friendly Word (.docx) file.
// Same draft as the PDF, just a different format.

import { writeFile } from 'node:fs/promises';
import {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  HeadingLevel, LevelFormat, BorderStyle, ExternalHyperlink,
  TabStopType, TabStopPosition,
} from 'docx';

const ACCENT = '1F4E79';

function periodEndYear(period) {
  if (!period) return 0;
  if (/Present|Current|Now|Ongoing/i.test(period)) return 9999;
  const years = String(period).match(/\d{4}/g);
  return years ? parseInt(years[years.length - 1], 10) : 0;
}

const P = (text, opts = {}) =>
  new Paragraph({
    spacing: { after: 60, ...(opts.spacing || {}) },
    children: [new TextRun({ text: String(text || ''), size: 21, font: 'Arial', ...(opts.run || {}) })],
  });

const heading = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 240, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 2 } },
    children: [new TextRun({ text: String(text || '').toUpperCase(), bold: true, size: 24, color: ACCENT, font: 'Arial' })],
  });

const sub = (text) =>
  new Paragraph({
    spacing: { before: 80, after: 20 },
    children: [new TextRun({ text: String(text || ''), bold: true, size: 22, font: 'Arial' })],
  });

const bullet = (text) =>
  new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    spacing: { after: 40 },
    children: [new TextRun({ text: String(text || ''), size: 21, font: 'Arial' })],
  });

const roleLine = (left, right) =>
  new Paragraph({
    spacing: { before: 120, after: 20 },
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    children: [
      new TextRun({ text: String(left || ''), bold: true, size: 22, font: 'Arial', color: ACCENT }),
      new TextRun({ text: `\t${right || ''}`, size: 20, font: 'Arial', color: '555555' }),
    ],
  });

export async function renderDocxFromDraft(draft, outPath) {
  const children = [];

  // ---- Header ----
  children.push(
    new Paragraph({
      spacing: { after: 20 },
      children: [new TextRun({ text: String(draft.name || ''), bold: true, size: 36, font: 'Arial', color: '1A1A2E' })],
    }),
    new Paragraph({
      spacing: { after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: ACCENT, space: 4 } },
      children: [new TextRun({ text: String(draft.title_line || ''), bold: true, size: 22, font: 'Arial', color: ACCENT })],
    }),
    new Paragraph({
      spacing: { after: 20 },
      children: [
        new TextRun({ text: `${draft.location || ''}  |  `, size: 20, font: 'Arial', color: '555555' }),
        new TextRun({ text: `${draft.phone || ''}  |  `, size: 20, font: 'Arial', color: '555555' }),
        new TextRun({ text: `${draft.email || ''}  |  `, size: 20, font: 'Arial', color: '555555' }),
        new ExternalHyperlink({
          link: draft.linkedin_url || ('https://' + (draft.linkedin_display || '')),
          children: [new TextRun({ text: draft.linkedin_display || '', size: 20, font: 'Arial', color: '0563C1', underline: {} })],
        }),
      ],
    }),
  );

  // ---- Executive Summary ----
  if (draft.executive_summary) {
    children.push(heading('Executive Summary'));
    children.push(P(draft.executive_summary));
  }

  // ---- Career Highlights ----
  if ((draft.career_highlights || []).length) {
    children.push(heading('Career Highlights'));
    draft.career_highlights.forEach((h) => children.push(bullet(h)));
  }

  // ---- Core Capabilities ----
  if ((draft.core_capabilities || []).length) {
    children.push(heading('Core Capabilities'));
    children.push(P((draft.core_capabilities || []).join(' · ')));
  }

  // ---- Professional Experience ----
  if ((draft.experience || []).length) {
    children.push(heading('Professional Experience'));
    for (const job of draft.experience) {
      const leftLine = `${job.company || ''} - ${job.role || ''}`;
      children.push(roleLine(leftLine, job.period || ''));
      if (job.scope) children.push(P(job.scope, { run: { italics: true } }));
      if ((job.achievements || []).length) {
        children.push(sub('Key Achievements:'));
        for (const a of job.achievements) children.push(bullet(a));
      }
    }
  }

  // ---- Key Projects ----
  if ((draft.key_projects || []).length) {
    children.push(heading('Key Projects'));
    const sorted = [...draft.key_projects].sort((a, b) => periodEndYear(b.period) - periodEndYear(a.period));
    for (const p of sorted) {
      children.push(new Paragraph({
        spacing: { before: 100, after: 20 },
        children: [new TextRun({ text: String(p.name || ''), bold: true, size: 22, font: 'Arial', color: ACCENT })],
      }));
      const meta = [p.role, p.budget, p.team, p.domain, p.period].filter(Boolean).join('  |  ');
      children.push(P(meta, { run: { italics: true, color: '666666', size: 20 } }));
      if (p.summary) children.push(P(p.summary));
    }
  }

  // ---- Education ----
  if ((draft.education || []).length) {
    children.push(heading('Education'));
    for (const e of draft.education) {
      children.push(roleLine(`${e.degree || ''} - ${e.institution || ''}`, e.year || ''));
    }
  }

  // ---- Tools & Systems ----
  if ((draft.tools_systems || []).length) {
    children.push(heading('Tools & Systems'));
    children.push(P((draft.tools_systems || []).join(' · ')));
  }

  const doc = new Document({
    creator: draft.name || 'Resume Tailor',
    title: `${draft.name || 'Resume'} - CV`,
    styles: {
      default: { document: { run: { font: 'Arial', size: 22 } } },
      paragraphStyles: [{
        id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 24, bold: true, font: 'Arial', color: ACCENT },
        paragraph: { spacing: { before: 240, after: 80 }, outlineLevel: 0 },
      }],
    },
    numbering: {
      config: [{
        reference: 'bullets',
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: '•',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 360, hanging: 200 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
        },
      },
      children,
    }],
  });

  const buf = await Packer.toBuffer(doc);
  await writeFile(outPath, buf);
}
