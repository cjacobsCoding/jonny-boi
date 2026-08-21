/**
 * A minimal ZIP writer — STORE, and DEFLATE where it pays.
 *
 * WHY THIS EXISTS INSTEAD OF A DEPENDENCY. The two C++ games write a bug report
 * as a FOLDER of files; a browser cannot, so the web reporter ships the same set
 * of entries as one `.zip`. That is the whole requirement: a container the
 * operating system already opens.
 *
 * IT STORED EVERYTHING UNTIL THE CLIP ARRIVED. That was a reasonable trade while
 * the entries were a PNG and a few kilobytes of markdown — both already final.
 * Then the rolling clip started contributing a rrweb snapshot: 3 MB of JSON for
 * a page of 95 nodes, because a full snapshot carries every inline style and the
 * whole stylesheet. A 15 MB bug report is one a phone will not upload, so the
 * text entries deflate now. The compression itself is the browser's
 * (`CompressionStream`), which is why it is an async step OUTSIDE this function:
 * the writer stays pure and synchronous, and takes bytes somebody else squeezed.
 *
 * PURE, and therefore tested: it takes bytes and returns bytes, touching no
 * browser API. A malformed archive is the kind of defect you only find when you
 * are already trying to read a bug report, which is the worst possible moment.
 */

/** One entry in the archive. */
export interface ZipEntry {
  /** Path inside the archive, e.g. `screenshot.png`. */
  readonly name: string;
  /** The real, uncompressed bytes. The CRC and the stated size are always these. */
  readonly bytes: Uint8Array;
  /**
   * RAW deflate of `bytes`, when the caller compressed it. Absent means STORE.
   * Raw, not zlib-wrapped: ZIP method 8 is a bare deflate stream, and a zlib
   * header in front of it produces an archive that every unzip tool rejects.
   */
  readonly deflated?: Uint8Array;
}

/**
 * Whether an entry is worth deflating. PNG and WebM are already compressed —
 * running them through deflate costs time and can make them BIGGER, which is a
 * genuinely absurd outcome for a compressor.
 */
export function shouldCompress(name: string): boolean {
  return !/\.(png|jpe?g|gif|webp|webm|mp4|zip|woff2?)$/i.test(name);
}

/**
 * Deflate the entries worth deflating, using the browser's own compressor.
 *
 * Never throws and never makes an entry bigger: a browser without
 * `CompressionStream`, a stream that fails, or a payload that grows all fall
 * back to STORE. A bug report that is large is a nuisance; one that will not
 * open is a lost report.
 */
export async function compressEntries(entries: readonly ZipEntry[]): Promise<ZipEntry[]> {
  const CompressionStreamCtor = (globalThis as { CompressionStream?: unknown }).CompressionStream as
    | (new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> })
    | undefined;
  if (CompressionStreamCtor === undefined) return [...entries];

  return Promise.all(
    entries.map(async (entry) => {
      if (!shouldCompress(entry.name) || entry.bytes.length === 0) return entry;
      try {
        const stream = new CompressionStreamCtor('deflate-raw');
        const writer = stream.writable.getWriter();
        void writer.write(entry.bytes);
        void writer.close();
        const deflated = new Uint8Array(await new Response(stream.readable).arrayBuffer());
        return deflated.length < entry.bytes.length ? { ...entry, deflated } : entry;
      } catch {
        return entry;
      }
    }),
  );
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE), the checksum every ZIP entry carries. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed time/date, the only clock format the ZIP header has. */
export interface DosDateTime {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
  readonly second: number; // 0-59
}

// The DOS epoch. A date before it cannot be encoded, so it is the floor rather
// than a wrapped, nonsense year.
const DOS_EPOCH_YEAR = 1980;

function dosTime(t: DosDateTime): number {
  return ((t.hour & 31) << 11) | ((t.minute & 63) << 5) | ((t.second >> 1) & 31);
}

function dosDate(t: DosDateTime): number {
  const year = Math.max(DOS_EPOCH_YEAR, t.year) - DOS_EPOCH_YEAR;
  return ((year & 127) << 9) | ((t.month & 15) << 5) | (t.day & 31);
}

class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  bytes(data: Uint8Array): void {
    this.chunks.push(data);
    this.length += data.length;
  }

  u16(value: number): void {
    const b = new Uint8Array(2);
    b[0] = value & 0xff;
    b[1] = (value >>> 8) & 0xff;
    this.bytes(b);
  }

  u32(value: number): void {
    const b = new Uint8Array(4);
    b[0] = value & 0xff;
    b[1] = (value >>> 8) & 0xff;
    b[2] = (value >>> 16) & 0xff;
    b[3] = (value >>> 24) & 0xff;
    this.bytes(b);
  }

  get offset(): number {
    return this.length;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20; // 2.0 — what STORE with UTF-8 names requires
const FLAG_UTF8_NAMES = 0x0800;

/**
 * Build a ZIP archive from the given entries, in order. An entry carrying
 * `deflated` bytes is written with method 8; everything else is stored.
 */
export function buildZip(entries: readonly ZipEntry[], when: DosDateTime): Uint8Array {
  const encoder = new TextEncoder();
  const time = dosTime(when);
  const date = dosDate(when);
  const w = new ByteWriter();
  const central: Array<{
    name: Uint8Array;
    crc: number;
    method: number;
    compressedSize: number;
    size: number;
    offset: number;
  }> = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    // ALWAYS the CRC and length of the ORIGINAL bytes, whichever method is used
    // — that is what an unzip tool checks what it produced against.
    const crc = crc32(entry.bytes);
    const payload = entry.deflated ?? entry.bytes;
    const method = entry.deflated === undefined ? METHOD_STORE : METHOD_DEFLATE;
    const offset = w.offset;

    w.u32(SIG_LOCAL);
    w.u16(VERSION_NEEDED);
    w.u16(FLAG_UTF8_NAMES);
    w.u16(method);
    w.u16(time);
    w.u16(date);
    w.u32(crc);
    w.u32(payload.length);
    w.u32(entry.bytes.length);
    w.u16(name.length);
    w.u16(0); // no extra field
    w.bytes(name);
    w.bytes(payload);

    central.push({
      name,
      crc,
      method,
      compressedSize: payload.length,
      size: entry.bytes.length,
      offset,
    });
  }

  const centralStart = w.offset;
  for (const e of central) {
    w.u32(SIG_CENTRAL);
    w.u16(VERSION_NEEDED); // version made by
    w.u16(VERSION_NEEDED);
    w.u16(FLAG_UTF8_NAMES);
    w.u16(e.method);
    w.u16(time);
    w.u16(date);
    w.u32(e.crc);
    w.u32(e.compressedSize);
    w.u32(e.size);
    w.u16(e.name.length);
    w.u16(0); // extra
    w.u16(0); // comment
    w.u16(0); // disk number
    w.u16(0); // internal attributes
    w.u32(0); // external attributes
    w.u32(e.offset);
    w.bytes(e.name);
  }
  const centralSize = w.offset - centralStart;

  w.u32(SIG_EOCD);
  w.u16(0); // this disk
  w.u16(0); // disk with the central directory
  w.u16(central.length);
  w.u16(central.length);
  w.u32(centralSize);
  w.u32(centralStart);
  w.u16(0); // no archive comment

  return w.finish();
}
