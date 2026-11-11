/**
 * Fonts for the PDF reports. Text is set in Roboto (pdfmake's own font files), which covers Latin, Greek, Cyrillic
 * and Vietnamese. Names in other scripts (Chinese, Japanese, Korean, Arabic, Hebrew, Thai, Devanagari, ...) are set
 * in a fallback font found on this computer, run by run; without one, those characters print as "?" rather than
 * as empty boxes, and the server log says which font package to install.
 *
 * Fallbacks: PDF_FALLBACK_FONTS (font files separated by ":" or, on Windows, ";"), then common system fonts, e.g.
 * Ubuntu's fonts-noto-cjk (sudo apt install fonts-noto-cjk). PDF_FALLBACK_FONTS=none uses Roboto only.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';

const require = createRequire(import.meta.url);
const FONT_DIR = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
export const ROBOTO = {
  normal: path.join(FONT_DIR, 'Roboto-Regular.ttf'),
  bold: path.join(FONT_DIR, 'Roboto-Medium.ttf'),
  italics: path.join(FONT_DIR, 'Roboto-Italic.ttf'),
  bolditalics: path.join(FONT_DIR, 'Roboto-MediumItalic.ttf'),
};

interface GlyphFont {
  postscriptName: string;
  hasGlyphForCodePoint(codePoint: number): boolean;
}

interface FontkitModule {
  openSync(file: string): GlyphFont | { fonts: GlyphFont[] };
}

/** fontkit comes with pdfkit (pdfmake's PDF engine); it reads which characters a font file has. */
const fontkit = createRequire(require.resolve('pdfkit'))('fontkit') as FontkitModule;

function systemFallbacks(): string[] {
  const windows = process.env.WINDIR ? path.join(process.env.WINDIR, 'Fonts') : 'C:\\Windows\\Fonts';
  return [
    // Linux (Ubuntu/Debian: fonts-noto-cjk, fonts-noto-core, fonts-dejavu-core; Fedora: google-noto-sans-cjk)
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansHebrew-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    // Windows
    path.join(windows, 'msyh.ttc'),
    path.join(windows, 'YuGothR.ttc'),
    path.join(windows, 'malgun.ttf'),
    path.join(windows, 'Nirmala.ttc'),
    path.join(windows, 'arial.ttf'),
    path.join(windows, 'tahoma.ttf'),
    // macOS
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
  ];
}

interface Fallback {
  family: string;
  font: GlyphFont;
  /** pdfmake font descriptor: the file, plus the face's name inside a collection (.ttc). */
  descriptor: string | [string, string];
}

interface FontSetup {
  roboto: GlyphFont;
  fallbacks: Fallback[];
}

let setup: FontSetup | undefined;

function openFont(file: string): { font: GlyphFont; collection: boolean } | null {
  try {
    const opened = fontkit.openSync(file);
    if ('fonts' in opened) return opened.fonts[0] ? { font: opened.fonts[0], collection: true } : null;
    return { font: opened, collection: false };
  } catch {
    return null;
  }
}

function fontSetup(): FontSetup {
  if (setup) return setup;
  const raw = (process.env.PDF_FALLBACK_FONTS ?? '').trim();
  const configured = raw === 'none' ? [] : raw.split(path.delimiter).map((f) => f.trim()).filter(Boolean);
  const fallbacks: Fallback[] = [];
  const seen = new Set<string>();
  for (const file of raw === 'none' ? [] : [...configured, ...systemFallbacks()]) {
    const resolved = path.resolve(file);
    if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
    seen.add(resolved);
    const opened = openFont(resolved);
    if (!opened) {
      if (configured.includes(file)) console.warn(`PDF_FALLBACK_FONTS: ${file} is not a font file pdfmake can use.`);
      continue;
    }
    const descriptor: Fallback['descriptor'] = opened.collection ? [resolved, opened.font.postscriptName] : resolved;
    fallbacks.push({ family: `Fallback${fallbacks.length + 1}`, font: opened.font, descriptor });
  }
  setup = { roboto: openFont(ROBOTO.normal)!.font, fallbacks };
  return setup;
}

/** Every font file a report may read (for pdfmake's local file access policy). */
export function fontFiles(): Set<string> {
  const files = new Set(Object.values(ROBOTO));
  for (const f of fontSetup().fallbacks) files.add(typeof f.descriptor === 'string' ? f.descriptor : f.descriptor[0]);
  return files;
}

/** Font families for pdfmake: Roboto, and each fallback in every style (fallbacks have one weight). */
export function fontFamilies(): Record<string, Record<'normal' | 'bold' | 'italics' | 'bolditalics', unknown>> {
  const families: Record<string, Record<'normal' | 'bold' | 'italics' | 'bolditalics', unknown>> = { Roboto: ROBOTO };
  for (const { family, descriptor } of fontSetup().fallbacks) {
    families[family] = { normal: descriptor, bold: descriptor, italics: descriptor, bolditalics: descriptor };
  }
  return families;
}

/* ------------------------------------------------------------------ */
/* Text runs                                                          */
/* ------------------------------------------------------------------ */

/** Latin, Latin-1, Latin Extended and common punctuation: always in Roboto, so most text skips the check. */
const COMMON = /^[\u0000-\u024f\u2013\u2014\u2018-\u201d\u2022\u2026\u20ac\u2122]*$/;
const NEUTRAL = /\s/u;

export interface TextRun {
  text: string;
  font?: string;
}

const warnedMissing = new Set<string>();

function warnMissing(char: string): void {
  if (warnedMissing.size > 20 || warnedMissing.has(char)) return;
  warnedMissing.add(char);
  console.warn(
    `PDF reports: no font on this computer has "${char}" (U+${char.codePointAt(0)!.toString(16).toUpperCase()}), ` +
      'so it prints as "?". On Ubuntu: sudo apt install fonts-noto-cjk fonts-noto-core, then restart the app ' +
      '(or set PDF_FALLBACK_FONTS in config.env to a font file that has it).',
  );
}

/** `text` split into runs by the font that has each character; null when Roboto has them all. */
export function textRuns(text: string): TextRun[] | null {
  if (COMMON.test(text)) return null;
  const { roboto, fallbacks } = fontSetup();
  const runs: TextRun[] = [];
  let changed = false;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    let font: string | undefined;
    let out = char;
    if (!NEUTRAL.test(char) && !roboto.hasGlyphForCodePoint(cp)) {
      const fallback = fallbacks.find((f) => f.font.hasGlyphForCodePoint(cp));
      if (fallback) font = fallback.family;
      else {
        warnMissing(char);
        out = '?';
      }
      changed = true;
    }
    const last = runs.at(-1);
    // Spaces stay in the run they are in, so a name in one script is one run.
    if (last && (last.font === font || NEUTRAL.test(char))) last.text += out;
    else runs.push(font ? { text: out, font } : { text: out });
  }
  return changed ? runs : null;
}

/* ------------------------------------------------------------------ */
/* Applying the runs to a document                                    */
/* ------------------------------------------------------------------ */

type Node = Record<string, unknown>;
const CONTAINERS = ['stack', 'columns', 'ul', 'ol'] as const;

function fixInline(text: unknown): unknown {
  if (typeof text === 'string') return textRuns(text) ?? text;
  if (!Array.isArray(text)) return text;
  return text.flatMap((part: unknown) => (typeof part === 'string' ? (textRuns(part) ?? [part]) : [fixContent(part)]));
}

function fixDynamic(value: unknown): unknown {
  if (typeof value !== 'function') return fixContent(value);
  const make = value as (...args: unknown[]) => unknown;
  return (...args: unknown[]) => fixContent(make(...args));
}

/** Replaces, in place, every text with characters Roboto lacks by runs in the fallback fonts. */
export function fixContent(node: unknown): unknown {
  if (typeof node === 'string') {
    const runs = textRuns(node);
    return runs ? { text: runs } : node;
  }
  if (Array.isArray(node)) return node.map(fixContent);
  if (!node || typeof node !== 'object') return node;
  const obj = node as Node;
  if ('text' in obj) obj.text = fixInline(obj.text);
  for (const key of CONTAINERS) if (Array.isArray(obj[key])) obj[key] = (obj[key] as unknown[]).map(fixContent);
  const table = obj.table as { body?: unknown[][] } | undefined;
  if (table && Array.isArray(table.body)) table.body = table.body.map((row) => row.map(fixContent));
  if ('section' in obj) {
    obj.section = fixContent(obj.section);
    if (obj.header) obj.header = fixDynamic(obj.header);
    if (obj.footer) obj.footer = fixDynamic(obj.footer);
  }
  return obj;
}

export function applyFallbackFonts(doc: TDocumentDefinitions): TDocumentDefinitions {
  const d = doc as unknown as Node;
  d.content = fixContent(d.content);
  if (d.header) d.header = fixDynamic(d.header);
  if (d.footer) d.footer = fixDynamic(d.footer);
  return doc;
}
