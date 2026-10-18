/**
 * Size checks around parsing (docs/API.md, "Size limits"). SheetJS inflates every part of a zip and parses the
 * whole file synchronously, so a crafted or oversized upload (a zip bomb, a sheet with millions of cells) must be
 * rejected before it can exhaust the server's memory. All checks throw WorkbookReadError(MESSAGES.tooLarge).
 */
import zlib from 'node:zlib';
import type * as XLSX from 'xlsx';
import { MESSAGES, WorkbookReadError } from './errors.js';

/** Most filled cells a workbook may have. */
export const MAX_WORKBOOK_CELLS = 2_000_000;
/** Most bytes of uncompressed worksheet and shared-string XML in a zip workbook (.xlsx, .xlsm, .ods). */
export const MAX_SHEET_XML_BYTES = 100 * 1024 * 1024;
/** Most bytes of all parts of a zip workbook together, uncompressed (images, styles, ... are inflated too). */
export const MAX_ZIP_BYTES = 250 * 1024 * 1024;

const EOCD_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];
const ZIP64_SIZE = 0xffffffff;
const DEFLATE = 8;
/** Parts SheetJS parses as cell data: worksheets, shared strings, and the content of an OpenDocument file. */
const SHEET_PART = /^(?:xl\/(?:worksheets|macrosheets|dialogsheets)\/[^/]+\.(?:xml|bin)|xl\/sharedStrings\.(?:xml|bin)|content\.xml)$/i;

interface ZipEntry {
  name: string;
  /** Largest uncompressed size the entry declares (Infinity if unknown), or null for deflated data without one. */
  size: number | null;
  /** Offset of the compressed data. */
  dataStart: number;
}

/**
 * Reads the zip's central directory and local headers the way SheetJS does, without inflating anything, and rejects
 * archives that declare too much data. Entries written with a trailing data descriptor (no size in the local header,
 * as Java and Go zip writers do) are inflated with a cap instead, because SheetJS would inflate them unbounded.
 * Archives whose directory cannot be read are left to SheetJS, which reports them as unreadable.
 */
export function assertZipWithinLimits(buf: Buffer): void {
  const entries = readZipDirectory(buf);
  if (!entries) return;
  let sheetBytes = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const isSheet = SHEET_PART.test(entry.name);
    const allowed = Math.min(MAX_ZIP_BYTES - totalBytes, isSheet ? MAX_SHEET_XML_BYTES - sheetBytes : Infinity);
    const size = entry.size ?? inflatedSize(buf, entry.dataStart, allowed);
    if (size > allowed) throw new WorkbookReadError(MESSAGES.tooLarge);
    totalBytes += size;
    if (isSheet) sheetBytes += size;
  }
}

/** Text files: every field separator (, ; tab) or line break can start a cell. */
export function assertTextWithinLimits(buf: Buffer): void {
  let fields = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    if (byte === 0x2c || byte === 0x3b || byte === 0x09 || byte === 0x0a) fields += 1;
  }
  if (fields > MAX_WORKBOOK_CELLS) throw new WorkbookReadError(MESSAGES.tooLarge);
}

/** Parsed workbooks: real cells (not "!" metadata keys) over all sheets. */
export function assertCellCount(wb: XLSX.WorkBook): void {
  let cells = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    for (const key in ws) {
      if (key.charCodeAt(0) !== 33) cells += 1;
    }
    if (cells > MAX_WORKBOOK_CELLS) throw new WorkbookReadError(MESSAGES.tooLarge);
  }
}

/**
 * The entries of a zip as SheetJS's own zip reader sees them, or null when there is no end-of-central-directory
 * record. Entries after one that runs past the end of the file are dropped (SheetJS fails there too).
 */
function readZipDirectory(buf: Buffer): ZipEntry[] | null {
  // SheetJS uses the last end-of-central-directory signature in the file, wherever it is.
  let eocd = buf.length - 4;
  while (eocd >= 0 && !EOCD_SIGNATURE.every((byte, i) => buf[eocd + i] === byte)) eocd -= 1;
  if (eocd < 0 || eocd + 20 > buf.length) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const centralSize = buf.readUInt32LE(pos + 24);
      const nameLength = buf.readUInt16LE(pos + 28);
      const extraLength = buf.readUInt16LE(pos + 30);
      const commentLength = buf.readUInt16LE(pos + 32);
      const localOffset = buf.readUInt32LE(pos + 42);
      const name = buf.toString('utf8', pos + 46, pos + 46 + nameLength);
      const centralZip64 = zip64Size(buf, pos + 46 + nameLength, extraLength);
      pos += 46 + nameLength + extraLength + commentLength;

      // Local file header. SheetJS sizes its output buffer from a ZIP64 record (central, then local) or else from the
      // local header, and compares that with the central directory only after inflating.
      const method = buf.readUInt16LE(localOffset + 8);
      const localSize = buf.readUInt32LE(localOffset + 22);
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const zip64 = centralZip64 || zip64Size(buf, localOffset + 30 + localNameLength, localExtraLength);
      // 0xFFFFFFFF stands for a size kept in a ZIP64 record; without one the size is unknown.
      const headerSize = (n: number) => (n !== ZIP64_SIZE ? n : zip64 ? 0 : Infinity);
      const declared = Math.max(zip64, headerSize(localSize), headerSize(centralSize));
      // Deflated with no output size at all: SheetJS grows its buffer until the stream ends.
      const size = method === DEFLATE && (zip64 || localSize) === 0 ? null : declared;
      entries.push({ name, size, dataStart });
    }
  } catch {
    // A field lies outside the file; check what was read before it.
  }
  return entries;
}

/** The uncompressed size in the ZIP64 record (header id 0x0001) of the extra-field block at `start`, or 0. */
function zip64Size(buf: Buffer, start: number, length: number): number {
  const end = Math.min(start + length, buf.length);
  for (let at = start; at + 4 <= end; at += 4 + buf.readUInt16LE(at + 2)) {
    if (buf.readUInt16LE(at) === 0x0001 && at + 12 <= end) {
      return buf.readUInt32LE(at + 8) * 2 ** 32 + buf.readUInt32LE(at + 4);
    }
  }
  return 0;
}

/** Inflated size of the deflate stream at `start`, stopping once it exceeds `limit`; 0 when the data is corrupt. */
function inflatedSize(buf: Buffer, start: number, limit: number): number {
  if (limit < 0) return Infinity;
  try {
    return zlib.inflateRawSync(buf.subarray(start), { maxOutputLength: Math.min(limit + 1, 2 ** 31 - 1) }).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') return Infinity;
    return 0;
  }
}
