/** Helpers for the grader's node:test suites (temp files, raw xlsx edits). Not used by the app. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as XLSX from 'xlsx';
import { DEFAULT_GRADING_CONFIG } from '../../../shared/types.js';
import type { GradingConfig } from '../../../shared/types.js';

let dir: string | null = null;
let counter = 0;

function tempDir(): string {
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-grader-test-'));
    const created = dir;
    process.on('exit', () => fs.rmSync(created, { recursive: true, force: true }));
  }
  return dir;
}

/** Writes `data` to a unique temp file whose name ends with `name` (keep the extension meaningful). */
export function writeTemp(name: string, data: Buffer | string): string {
  counter += 1;
  const file = path.join(tempDir(), `${counter}-${name}`);
  fs.writeFileSync(file, data);
  return file;
}

export function config(overrides: Partial<GradingConfig> = {}): GradingConfig {
  return { ...DEFAULT_GRADING_CONFIG, ranges: [], ...overrides };
}

/** Rewrites one XML part (e.g. "xl/worksheets/sheet1.xml") of an .xlsx file. */
export function rewriteXlsxPart(xlsx: Buffer, part: string, transform: (xml: string) => string): Buffer {
  const zip = XLSX.CFB.read(xlsx, { type: 'buffer' });
  const index = (zip.FullPaths as string[]).findIndex((p) => p.endsWith(`/${part}`));
  if (index < 0) throw new Error(`No part ${part} in workbook`);
  const entry = zip.FileIndex[index];
  entry.content = Buffer.from(transform(Buffer.from(entry.content).toString('utf8')), 'utf8');
  entry.size = entry.content.length;
  return XLSX.CFB.write(zip, { fileType: 'zip', type: 'buffer' }) as Buffer;
}

export interface HandBuiltZipOptions {
  /** Uncompressed size written to the headers (default: the real one). */
  declaredSize?: number;
  /** Write the sizes in a trailing data descriptor and leave them 0 in the local header (Java/Go zip writers). */
  streamed?: boolean;
}

/** A minimal one-entry .zip with deflated `data`, for testing size checks on what headers declare. */
export function handBuiltZip(name: string, data: Buffer, options: HandBuiltZipOptions = {}): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const compressed = zlib.deflateRawSync(data);
  const size = options.declaredSize ?? data.length;
  const flags = options.streamed ? 0x08 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(options.streamed ? 0 : compressed.length, 18);
  local.writeUInt32LE(options.streamed ? 0 : size, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const descriptor = Buffer.alloc(options.streamed ? 16 : 0);
  if (options.streamed) {
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(size, 12);
  }

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const directoryOffset = local.length + nameBytes.length + compressed.length + descriptor.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, nameBytes, compressed, descriptor, central, nameBytes, end]);
}
