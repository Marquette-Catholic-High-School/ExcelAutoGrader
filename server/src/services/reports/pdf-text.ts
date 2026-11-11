/**
 * Test helper (not used by the app): reads back the text of a PDF made by pdfmake/pdfkit, page by page, so tests
 * can check what a report says without a PDF library. It understands exactly what pdfkit writes: numbered objects
 * with direct /Length, FlateDecode streams, Type0 fonts with Identity-H glyph ids and a ToUnicode CMap of bfranges.
 */
import zlib from 'node:zlib';

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

function parseObjects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const header = /(\d+) 0 obj\s*/g;
  let pos = 0;
  for (;;) {
    header.lastIndex = pos;
    const match = header.exec(text);
    if (!match) break;
    const start = match.index + match[0].length;
    const streamAt = text.indexOf('stream', start);
    const endAt = text.indexOf('endobj', start);
    if (streamAt !== -1 && streamAt < endAt) {
      const dict = text.slice(start, streamAt);
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
      const dataStart = streamAt + 'stream'.length + (text[streamAt + 6] === '\r' ? 2 : 1);
      let data = pdf.subarray(dataStart, dataStart + length);
      if (dict.includes('/FlateDecode')) data = zlib.inflateSync(data);
      objects.set(Number(match[1]), { dict, stream: data });
      pos = text.indexOf('endobj', dataStart + length) + 'endobj'.length;
    } else {
      objects.set(Number(match[1]), { dict: text.slice(start, endAt), stream: null });
      pos = endAt + 'endobj'.length;
    }
  }
  return objects;
}

/** glyph id → text, from `<start> <end> [<hex> <hex> ...]` bfrange lines. */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const range = /<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*\[([^\]]*)\]/gi;
  for (const [, start, , entries] of cmap.matchAll(range)) {
    let gid = parseInt(start, 16);
    for (const [, hex] of entries.matchAll(/<([0-9a-f\s]*)>/gi)) {
      const units = hex.trim().split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16));
      map.set(gid++, String.fromCharCode(...units));
    }
  }
  return map;
}

const ref = (dict: string, key: string): number | null => {
  const match = new RegExp(`/${key} (\\d+) 0 R`).exec(dict);
  return match ? Number(match[1]) : null;
};

/** Font resource name (F1, F2, ...) → glyph map; pdfkit gives each font one name for the whole document. */
function fontMaps(objects: Map<number, PdfObject>): Map<string, Map<number, string>> {
  const fonts = new Map<string, Map<number, string>>();
  for (const { dict } of objects.values()) {
    const block = /\/Font <<([^>]*)>>/.exec(dict);
    if (!block) continue;
    for (const [, name, id] of block[1].matchAll(/\/(\S+) (\d+) 0 R/g)) {
      if (fonts.has(name)) continue;
      const font = objects.get(Number(id));
      const cmapId = font && ref(font.dict, 'ToUnicode');
      const cmap = cmapId === null || cmapId === undefined ? null : objects.get(cmapId)?.stream;
      fonts.set(name, cmap ? parseToUnicode(cmap.toString('latin1')) : new Map());
    }
  }
  return fonts;
}

interface TextRun {
  text: string;
  x: number;
  y: number;
}

/** Text runs of one content stream: each TJ/Tj becomes one run, at the position of the last Tm. */
function contentRuns(content: string, fonts: Map<string, Map<number, string>>): TextRun[] {
  const runs: TextRun[] = [];
  let glyphs = new Map<number, string>();
  let x = 0;
  let y = 0;
  const ops = /\/(F\d+) [\d.]+ Tf|1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm|\[((?:<[0-9a-f]*>|[^\]])*)\] TJ|<([0-9a-f]*)> Tj/gi;
  for (const [, font, tx, ty, array, single] of content.matchAll(ops)) {
    if (font) {
      glyphs = fonts.get(font) ?? new Map();
      continue;
    }
    if (tx !== undefined) {
      x = Number(tx);
      y = Number(ty);
      continue;
    }
    const hexes = array !== undefined ? [...array.matchAll(/<([0-9a-f]*)>/gi)].map((m) => m[1]) : [single];
    let text = '';
    for (const hex of hexes) {
      for (let i = 0; i + 4 <= hex.length; i += 4) text += glyphs.get(parseInt(hex.slice(i, i + 4), 16)) ?? '\uFFFD';
    }
    runs.push({ text, x, y });
  }
  return runs;
}

/**
 * pdfmake draws every word (with its trailing space) as its own run. Runs on the same baseline are joined (with a
 * space between table cells), and a new baseline starts a new line.
 */
function joinRuns(runs: readonly TextRun[]): string {
  let text = '';
  let prev: TextRun | null = null;
  for (const run of runs) {
    if (prev && Math.abs(run.y - prev.y) >= 1) text += '\n';
    else if (prev && !/[\s\-–—/!]$/.test(prev.text)) text += ' ';
    text += run.text;
    prev = run;
  }
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** The text of each page in order, one line per baseline. */
export function pdfPages(pdf: Buffer): string[] {
  const objects = parseObjects(pdf);
  const fonts = fontMaps(objects);
  const root = [...objects.values()].find((o) => /\/Type \/Pages\b/.test(o.dict) && !/\/Parent /.test(o.dict));
  const kidList = root ? (/\/Kids \[([^\]]*)\]/.exec(root.dict)?.[1] ?? '') : '';
  const kids = [...kidList.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  return kids.map((id) => {
    const page = objects.get(id)!;
    const contentIds = /\/Contents \[([^\]]*)\]/.exec(page.dict)?.[1] ?? String(ref(page.dict, 'Contents') ?? '');
    const streams = [...contentIds.matchAll(/(\d+)(?: 0 R)?/g)].map((m) => objects.get(Number(m[1]))?.stream);
    return joinRuns(streams.flatMap((s) => (s ? contentRuns(s.toString('latin1'), fonts) : [])));
  });
}

/** All text of the PDF on one line (pages, lines and table cells separated by single spaces), for `includes`. */
export function pdfText(pdf: Buffer): string {
  return pdfPages(pdf).join(' ').replace(/\s+/g, ' ');
}

/** Font names the PDF uses (to prove no standard font such as Helvetica sneaks in). */
export function pdfFontNames(pdf: Buffer): string[] {
  const names = new Set<string>();
  for (const { dict } of parseObjects(pdf).values()) {
    if (!/\/Type \/Font\b/.test(dict)) continue;
    const base = /\/BaseFont \/(\S+)/.exec(dict);
    if (base) names.add(base[1].replace(/^[A-Z]{6}\+/, ''));
  }
  return [...names].sort();
}
