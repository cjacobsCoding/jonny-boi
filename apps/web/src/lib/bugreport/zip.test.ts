/**
 * The ZIP writer's tests. A bug-report bundle that will not open is a bug report
 * that does not exist, and the moment you discover it is the moment you are
 * already trying to read someone's report — so the structure is pinned here
 * rather than trusted.
 */
import { describe, expect, it } from 'vitest';
import { buildZip, crc32, type DosDateTime } from './zip.js';

const WHEN: DosDateTime = { year: 2026, month: 8, day: 15, hour: 14, minute: 25, second: 30 };

function u32At(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0)
  );
}

function u16At(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('crc32', () => {
  it('matches the published IEEE check values', () => {
    expect(crc32(text(''))).toBe(0);
    // The canonical CRC-32 check value for "123456789".
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(text('a'))).toBe(0xe8b7be43);
  });

  it('is unsigned — a high bit must not come back negative', () => {
    expect(crc32(text('123456789'))).toBeGreaterThan(0);
  });
});

describe('buildZip', () => {
  it('writes a local header per entry, then a central directory, then the EOCD', () => {
    const zip = buildZip(
      [
        { name: 'report.md', bytes: text('# hello') },
        { name: 'state_dump.txt', bytes: text('entities 1') },
      ],
      WHEN,
    );

    expect(u32At(zip, 0)).toBe(0x04034b50); // first local file header
    // The EOCD is the last 22 bytes when there is no archive comment.
    const eocd = zip.length - 22;
    expect(u32At(zip, eocd)).toBe(0x06054b50);
    expect(u16At(zip, eocd + 8)).toBe(2); // entries on this disk
    expect(u16At(zip, eocd + 10)).toBe(2); // entries total

    const centralStart = u32At(zip, eocd + 16);
    expect(u32At(zip, centralStart)).toBe(0x02014b50);
    // The central directory's declared size must actually reach the EOCD.
    expect(centralStart + u32At(zip, eocd + 12)).toBe(eocd);
  });

  it('stores the bytes verbatim, with a matching CRC and both sizes equal', () => {
    const payload = text('the swap verdict says improved');
    const zip = buildZip([{ name: 'report.md', bytes: payload }], WHEN);

    expect(u32At(zip, 14)).toBe(crc32(payload)); // crc field
    expect(u32At(zip, 18)).toBe(payload.length); // compressed size
    expect(u32At(zip, 22)).toBe(payload.length); // uncompressed size
    expect(u16At(zip, 8)).toBe(0); // method 0 = STORE

    // The payload follows the header + the name, byte for byte.
    const nameLen = u16At(zip, 26);
    const at = 30 + nameLen;
    expect(Array.from(zip.slice(at, at + payload.length))).toEqual(Array.from(payload));
  });

  it('points every central entry at its real local header', () => {
    const zip = buildZip(
      [
        { name: 'a.txt', bytes: text('aaaa') },
        { name: 'b.txt', bytes: text('bbbbbbbb') },
      ],
      WHEN,
    );
    const eocd = zip.length - 22;
    let at = u32At(zip, eocd + 16);
    for (let i = 0; i < 2; i += 1) {
      const localOffset = u32At(zip, at + 42);
      expect(u32At(zip, localOffset)).toBe(0x04034b50);
      at += 46 + u16At(zip, at + 28);
    }
  });

  it('marks names as UTF-8 so a non-ASCII name is not mojibake on extract', () => {
    const zip = buildZip([{ name: 'notes-café.txt', bytes: text('x') }], WHEN);
    expect(u16At(zip, 6) & 0x0800).toBe(0x0800);
  });

  it('handles an empty archive and an empty file without producing garbage', () => {
    const empty = buildZip([], WHEN);
    expect(empty.length).toBe(22);
    expect(u32At(empty, 0)).toBe(0x06054b50);

    const withEmptyFile = buildZip([{ name: 'nothing.txt', bytes: new Uint8Array(0) }], WHEN);
    expect(u32At(withEmptyFile, 14)).toBe(0); // crc of nothing
    expect(u32At(withEmptyFile, 18)).toBe(0);
  });

  it('floors a pre-1980 clock instead of wrapping the DOS year field', () => {
    // A machine with a broken clock must still produce an archive that opens.
    const zip = buildZip([{ name: 'x', bytes: text('x') }], { ...WHEN, year: 1601 });
    const date = u16At(zip, 12);
    expect(date >>> 9).toBe(0); // year 1980, not a wrapped negative
  });
});
