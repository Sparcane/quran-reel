// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTanzil, writeSurahs } from '../build-data';

const fixture = readFileSync(
  fileURLToPath(new URL('../fixtures/tanzil-sample.txt', import.meta.url)),
  'utf8',
);

function withoutLine(source: string, prefix: string): string {
  return source
    .split('\n')
    .filter((line) => !line.startsWith(prefix))
    .join('\n');
}

describe('parseTanzil', () => {
  it('reads the 114 surahs with their verse counts and revelation places', () => {
    const { index } = parseTanzil(fixture);

    expect(index).toHaveLength(114);
    expect(index[0]).toMatchObject({
      number: 1,
      nameAr: 'الفاتحة',
      verseCount: 7,
      revelation: 'meccan',
    });
    expect(index[1]).toMatchObject({ number: 2, verseCount: 286, revelation: 'medinan' });
    expect(index.reduce((total, surah) => total + surah.verseCount, 0)).toBe(6236);
  });

  it('keeps every Uthmani verse verbatim', () => {
    const { surahs } = parseTanzil(fixture);
    // Same line-ending contract as the parser: a Windows checkout (autocrlf)
    // gives the fixture CRLF, and a bare '\n' split would keep a stray '\r'.
    const raw = fixture.split(/\r?\n/).find((line) => line.startsWith('1|1|'))!;
    const rawText = raw.split('|').slice(2).join('|');

    expect(surahs[0].verses[0].arabic).toBe(rawText);
    expect(surahs[0].verses[0].arabic.length).toBeGreaterThan(20);
    expect(surahs[113].verses).toHaveLength(6);
  });

  it('numbers the verses of each surah from one without a gap', () => {
    const { surahs } = parseTanzil(fixture);

    for (const surah of surahs) {
      expect(surah.verses.map((verse) => verse.number)).toEqual(
        surah.verses.map((_, i) => i + 1),
      );
    }
  });

  it('ignores the copyright header lines', () => {
    const { index } = parseTanzil(`# a comment\n#another\n${fixture}`);
    expect(index).toHaveLength(114);
  });

  it('refuses a missing verse and names it', () => {
    expect(() => parseTanzil(withoutLine(fixture, '2|5|'))).toThrow(/2:5/);
  });

  it('refuses an empty verse and names it', () => {
    const broken = fixture.replace(/^2\|5\|.*$/m, '2|5|   ');
    expect(() => parseTanzil(broken)).toThrow(/2:5/);
  });

  it('refuses a surah number that does not exist', () => {
    expect(() => parseTanzil('115|1|text')).toThrow(/115/);
  });

  it('refuses a verse number gap', () => {
    expect(() => parseTanzil('1|1|a\n1|3|c')).toThrow(/1:2/);
  });

  it('refuses a malformed line', () => {
    expect(() => parseTanzil('1|1|a\nnot a verse')).toThrow(/not a verse/);
  });
});

describe('writeSurahs', () => {
  it('writes the index and one file per surah', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quran-surahs-'));

    try {
      await writeSurahs(parseTanzil(fixture), dir);

      const index = JSON.parse(await readFile(join(dir, 'surahs-index.json'), 'utf8'));
      expect(index).toHaveLength(114);
      expect(index[1]).toMatchObject({ number: 2, verseCount: 286 });
      expect(await readdir(join(dir, 'surahs'))).toHaveLength(114);
      expect(existsSync(join(dir, 'surahs', '001.json'))).toBe(true);

      const first = JSON.parse(await readFile(join(dir, 'surahs', '001.json'), 'utf8'));
      expect(first).toMatchObject({ number: 1, nameAr: 'الفاتحة', verseCount: 7 });
      expect(first.verses).toHaveLength(7);
      expect(first.verses[0]).toMatchObject({ number: 1, translations: { fr: '', en: '' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
