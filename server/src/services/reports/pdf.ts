/**
 * pdfmake setup and the building blocks every report shares: the page frame (a header band with the report
 * title and "Podner's Excel", a footer with "Page X of Y"), styles, stat cards and zebra-striped tables.
 *
 * Text is set in Roboto, embedded from pdfmake's own font files, so accented and Vietnamese names (José, Zoë,
 * Nguyễn Thị Hương, Łukasz) render correctly; the 14 standard PDF fonts only cover Latin-1. Other scripts use a
 * fallback font from this computer (fonts.ts).
 */
import path from 'node:path';
import pdfmake from 'pdfmake';
import type {
  Column,
  Content,
  ContentTable,
  CustomTableLayout,
  DynamicContent,
  Size,
  StyleDictionary,
  TableCell,
  TDocumentDefinitions,
} from 'pdfmake/interfaces.js';
import { applyFallbackFonts, fontFamilies, fontFiles } from './fonts.js';

const BRAND = "Podner's Excel";

// pdfmake's Node build is one shared instance. Reports never load images or URLs, so only the fonts may be read.
let fontsReady = false;
function setUpFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  const files = fontFiles();
  pdfmake.setFonts(fontFamilies() as Parameters<typeof pdfmake.setFonts>[0]);
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((file) => files.has(path.resolve(file)));
}

export const COLORS = {
  brand: '#1D6B41',
  brandDark: '#14502F',
  brandTint: '#EAF3ED',
  bandText: '#FFFFFF',
  bandMuted: '#CFE6D7',
  text: '#1F2933',
  muted: '#5F6B7A',
  faint: '#9AA3AE',
  line: '#D5DBE1',
  zebra: '#F5F7F9',
  headerFill: '#E4EEE7',
  late: '#C62828',
  missing: '#8A9099',
  warn: '#A15C00',
} as const;

const STYLES: StyleDictionary = {
  h1: { fontSize: 19, bold: true, color: COLORS.text, margin: [0, 0, 0, 4] },
  h2: { fontSize: 12, bold: true, color: COLORS.brandDark, margin: [0, 16, 0, 6] },
  meta: { fontSize: 9, color: COLORS.muted, lineHeight: 1.3 },
  note: { fontSize: 8, color: COLORS.muted, italics: true },
  th: { fontSize: 8, bold: true, color: COLORS.text },
  small: { fontSize: 7.5, color: COLORS.muted },
  late: { bold: true, color: COLORS.late },
  missing: { italics: true, color: COLORS.missing },
  warn: { color: COLORS.warn },
  footer: { fontSize: 7.5, color: COLORS.muted },
};

/** Everything in a report that isn't specific to one student or assignment. */
export interface ReportContext {
  className: string;
  teacherName: string;
  generatedAt: Date;
}

export interface PageSetup {
  landscape?: boolean;
}

const MARGIN_X = 40;
const PAGE_MARGINS: [number, number, number, number] = [MARGIN_X, 74, MARGIN_X, 48];

const HAIRLINE = { lineWidth: 0.5, lineColor: COLORS.line };

const BAND_LAYOUT: CustomTableLayout = {
  fillColor: () => COLORS.brand,
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: () => MARGIN_X,
  paddingRight: () => MARGIN_X,
  paddingTop: () => 14,
  paddingBottom: () => 12,
};

/** Full-width colored band at the top of every page (one cell, so the fill has no seams). */
export function bandHeader(title: string): DynamicContent {
  return () => ({
    table: {
      widths: ['*'],
      body: [
        [
          {
            columns: [
              { text: title, fontSize: 12.5, bold: true, color: COLORS.bandText },
              {
                text: BRAND,
                fontSize: 10,
                bold: true,
                color: COLORS.bandMuted,
                alignment: 'right',
                width: 'auto',
                margin: [0, 2, 0, 0],
              },
            ],
          },
        ],
      ],
    },
    layout: BAND_LAYOUT,
  });
}

/** Thin rule, then `note` on the left and "Page X of Y" on the right. */
export function pageFooter(note: string): DynamicContent {
  return (page, pageCount, pageSize) => ({
    margin: [MARGIN_X, 12, MARGIN_X, 0],
    stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: pageSize.width - 2 * MARGIN_X, y2: 0, ...HAIRLINE }] },
      {
        margin: [0, 5, 0, 0],
        columns: [
          { text: note, style: 'footer' },
          { text: `Page ${page} of ${pageCount}`, style: 'footer', alignment: 'right', width: 'auto' },
        ],
      },
    ],
  });
}

export interface DocumentOptions extends PageSetup {
  /** PDF metadata title (shown in the viewer's title bar). */
  title: string;
  /** Text of the header band (the sections of the all-students report set their own). */
  bandTitle: string;
  footerNote: string;
  content: Content;
  ctx: ReportContext;
}

export function reportDocument(opts: DocumentOptions): TDocumentDefinitions {
  return {
    pageSize: 'LETTER',
    pageOrientation: opts.landscape ? 'landscape' : 'portrait',
    pageMargins: PAGE_MARGINS,
    header: bandHeader(opts.bandTitle),
    footer: pageFooter(opts.footerNote),
    content: opts.content,
    styles: STYLES,
    defaultStyle: { font: 'Roboto', fontSize: 9, color: COLORS.text, lineHeight: 1.15 },
    info: {
      title: opts.title,
      author: opts.ctx.teacherName,
      subject: opts.ctx.className,
      creator: BRAND,
      producer: BRAND,
      creationDate: opts.ctx.generatedAt,
    },
  };
}

/** Lays out and renders the document (CPU-bound: seconds for a very large class, so render.ts runs it in a worker). */
export function renderPdf(doc: TDocumentDefinitions): Promise<Buffer> {
  setUpFonts();
  return pdfmake.createPdf(applyFallbackFonts(doc)).getBuffer();
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                    */
/* ------------------------------------------------------------------ */

/** Big title with a few lines of details under it. */
export function titleBlock(title: string, lines: (string | Content)[], badge?: string): Content {
  return {
    stack: [
      badge
        ? { text: [title, { text: `   ${badge}`, fontSize: 9, bold: true, color: COLORS.warn }], style: 'h1' }
        : { text: title, style: 'h1' },
      ...lines.map((line): Content => (typeof line === 'string' ? { text: line, style: 'meta' } : line)),
    ],
    margin: [0, 0, 0, 4],
  };
}

function heading(text: string, note?: string): Content {
  if (!note) return { text, style: 'h2' };
  return { stack: [{ text, style: 'h2', margin: [0, 16, 0, 1] }, { text: note, style: 'note', margin: [0, 0, 0, 6] }] };
}

/** A heading kept on the same page as the (short) content under it. */
export function block(title: string, content: Content, note?: string): Content {
  return { unbreakable: true, stack: [heading(title, note), content] };
}

export function emptyNote(text: string): Content {
  return { text, style: 'note', margin: [0, 2, 0, 0] };
}

export interface StatCard {
  label: string;
  value: string;
  detail?: string;
  color?: string;
}

/** A card for a count that is drawn in `color` only when it isn't zero. */
export function countCard(label: string, count: number, color?: string, detail?: string): StatCard {
  return { label, value: String(count), color: count ? color : undefined, detail };
}

const CARD_GAP = 8;

/** Odd columns are the gaps between cards. */
const CARD_LAYOUT: CustomTableLayout = {
  fillColor: (_row, _node, column) => (column % 2 === 0 ? COLORS.brandTint : null),
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: (column) => (column % 2 === 0 ? 9 : 0),
  paddingRight: (column) => (column % 2 === 0 ? 9 : 0),
  paddingTop: () => 7,
  paddingBottom: () => 7,
};

function cardCell(card: StatCard): TableCell {
  return {
    stack: [
      { text: card.label.toUpperCase(), fontSize: 6.5, bold: true, color: COLORS.muted, characterSpacing: 0.4 },
      { text: card.value, fontSize: 15, bold: true, color: card.color ?? COLORS.text, margin: [0, 2, 0, 0] },
      ...(card.detail ? [{ text: card.detail, fontSize: 7, color: COLORS.muted }] : []),
    ],
  };
}

/** A row of equal boxes with a label, a big number and a detail line (one table, so the boxes share a height). */
export function statCards(cards: readonly StatCard[]): Content {
  const cells = cards.flatMap((card, i): TableCell[] => (i === 0 ? [cardCell(card)] : [{ text: '' }, cardCell(card)]));
  const widths = cards.flatMap((_, i): Size[] => (i === 0 ? ['*'] : [CARD_GAP, '*']));
  return { table: { widths, body: [cells] }, layout: CARD_LAYOUT, margin: [0, 0, 0, 8] };
}

/** Header fill, zebra body rows, hairlines only above/below the header and at the bottom. */
function zebraLayout(headerRows: number, footerRows = 0, titleRows = 0): CustomTableLayout {
  return {
    fillColor: (row, node) => {
      if (row < titleRows) return null;
      if (row < headerRows) return COLORS.headerFill;
      if (row >= node.table.body.length - footerRows) return COLORS.brandTint;
      return (row - headerRows) % 2 === 1 ? COLORS.zebra : null;
    },
    hLineWidth: (i, node) => {
      const rows = node.table.body.length;
      if (i === headerRows || (footerRows && i === rows - footerRows)) return 0.8;
      return i === titleRows || i === rows ? 0.5 : 0;
    },
    hLineColor: (i) => (i === headerRows ? COLORS.brand : COLORS.line),
    vLineWidth: () => 0,
    paddingLeft: () => 5,
    paddingRight: () => 5,
    paddingTop: () => 3.5,
    paddingBottom: () => 3.5,
  };
}

export interface DataTableOptions {
  widths: Size[];
  /**
   * Section heading drawn as the table's first row: it repeats on every page with the column headers and can never
   * be left alone at the bottom of a page.
   */
  title?: string;
  /** Small italic line under the title. */
  note?: string;
  /** Rows after the body (totals), filled with the tint color. */
  footer?: TableCell[][];
}

/** A table row with one cell spanning all `columns` columns. */
function spanRow(cell: TableCell, columns: number): TableCell[] {
  // Fresh placeholder objects: pdfmake writes layout state into every cell it lays out.
  const placeholders = Array.from({ length: columns - 1 }, (): TableCell => ({}));
  return [{ ...(cell as Record<string, unknown>), colSpan: columns } as TableCell, ...placeholders];
}

/** Title row content, shifted left by the cell's left `padding` so it lines up with the other headings. */
export function titleCell(title: string, note?: string, padding = 5): TableCell {
  const margin: [number, number, number, number] = [-padding, 9, 0, note ? 0 : 3];
  if (!note) return { text: title, style: 'h2', margin };
  return {
    stack: [
      { text: title, style: 'h2', margin: 0 },
      { text: note, style: 'note', margin: [0, 1, 0, 3] },
    ],
    margin,
  };
}

/**
 * A zebra-striped table whose header rows repeat on every page. Rows are never split across pages (keep rows
 * shorter than a page), and the headers always come with at least one row.
 */
export function dataTable(header: TableCell[], body: TableCell[][], opts: DataTableOptions): ContentTable {
  const top = opts.title ? [spanRow(titleCell(opts.title, opts.note), header.length), header] : [header];
  const footer = opts.footer ?? [];
  return {
    table: {
      headerRows: top.length,
      keepWithHeaderRows: body.length ? 1 : 0,
      dontBreakRows: true,
      widths: opts.widths,
      body: [...top, ...body, ...footer],
    },
    layout: zebraLayout(top.length, footer.length, opts.title ? 1 : 0),
  };
}

export function th(text: string, alignment: 'left' | 'right' | 'center' = 'left'): TableCell {
  return { text, style: 'th', alignment };
}

/** A faint "—" for "no score". (Cells are built fresh every time: pdfmake writes layout state into them.) */
export function dash(alignment: 'left' | 'right' | 'center' = 'right'): TableCell {
  return { text: '—', color: COLORS.faint, alignment };
}

/** The name, with "Invited · hasn't signed up yet" under it for students added by email who haven't signed up. */
export function studentNameCell(name: string, pending: boolean): TableCell {
  if (!pending) return { text: name };
  return { stack: [{ text: name }, { text: "Invited · hasn't signed up yet", style: 'small', italics: true }] };
}

/** "LATE" in red, optionally followed by how late in small text. */
export function lateMark(detail?: string): Content {
  if (!detail) return { text: 'LATE', style: 'late' };
  return { text: [{ text: 'LATE', style: 'late' }, { text: `  ${detail}`, style: 'small' }] };
}

/** A vertical bar per 10% band with the count above it, and the band labels underneath. */
export function distributionChart(bands: readonly number[], width: number, barColor: string = COLORS.brand): Content {
  const chartHeight = 80;
  const max = Math.max(1, ...bands);
  const colWidth = width / bands.length;
  const barWidth = Math.round(colWidth * 0.68);
  const bars = bands.map((count): Column => {
    const height = count ? Math.max(2, (count / max) * chartHeight) : 0;
    return {
      width: colWidth,
      stack: [
        {
          text: String(count),
          alignment: 'center',
          fontSize: 8,
          bold: count > 0,
          color: count ? COLORS.text : COLORS.faint,
          margin: [0, chartHeight - height, 0, 2],
        },
        {
          canvas: height
            ? [{ type: 'rect', x: (colWidth - barWidth) / 2, y: 0, w: barWidth, h: height, color: barColor }]
            : [],
        },
      ],
    };
  });
  const step = 100 / bands.length;
  const labels = bands.map(
    (_, i): Column => ({
      width: colWidth,
      text: i === bands.length - 1 ? `${i * step}–100%` : `${i * step}–${(i + 1) * step - 1}%`,
      alignment: 'center',
      fontSize: 7,
      color: COLORS.muted,
    }),
  );
  return {
    unbreakable: true,
    stack: [
      { columns: bars, columnGap: 0 },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.8, lineColor: COLORS.faint }] },
      { columns: labels, columnGap: 0, margin: [0, 3, 0, 0] },
    ],
  };
}

/** Content width of a page with the standard margins. */
export function contentWidth(setup: PageSetup = {}): number {
  const LETTER = { width: 612, height: 792 };
  return (setup.landscape ? LETTER.height : LETTER.width) - PAGE_MARGINS[0] - PAGE_MARGINS[2];
}
