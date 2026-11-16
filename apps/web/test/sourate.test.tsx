import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SurahData } from '@quran/core';
import { generateStaticParams } from '../app/sourate/[id]/page';
import { VerseList } from '../src/components/VerseList';
import { MAX_MOUNTED_ROWS, toSelection } from '../src/lib/verses';
import { readSurah } from '../src/lib/surah-data';
import surah2Json from '../public/data/surahs/002.json';

const surah2 = surah2Json as SurahData;

describe('toSelection', () => {
  it('sorts by surah then verse, so the studio reads a run in order', () => {
    expect(
      toSelection([
        { surah: 2, verse: 3 },
        { surah: 1, verse: 7 },
        { surah: 2, verse: 1 },
      ]),
    ).toEqual([
      { surah: 1, verse: 7 },
      { surah: 2, verse: 1 },
      { surah: 2, verse: 3 },
    ]);
  });

  it('drops a verse selected twice', () => {
    expect(
      toSelection([
        { surah: 2, verse: 2 },
        { surah: 2, verse: 2 },
        { surah: 2, verse: 3 },
      ]),
    ).toEqual([
      { surah: 2, verse: 2 },
      { surah: 2, verse: 3 },
    ]);
  });

  it('never invents a verse the user did not pick', () => {
    expect(toSelection([{ surah: 2, verse: 1 }, { surah: 2, verse: 3 }])).toHaveLength(2);
  });

  it('refuses an impossible reference instead of shipping it to the renderer', () => {
    expect(() => toSelection([{ surah: 115, verse: 1 }])).toThrow(/surah/);
    expect(() => toSelection([{ surah: 1, verse: 0 }])).toThrow(/verse/);
  });
});

describe('VerseList', () => {
  it('mounts a bounded window of a 286-verse surah', () => {
    render(<VerseList surah={surah2} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_MOUNTED_ROWS);
    expect(MAX_MOUNTED_ROWS).toBeLessThan(surah2.verses.length);
  });

  it('shows the Arabic verse and its French translation', () => {
    render(<VerseList surah={surah2} />);

    const arabic = screen.getByText(surah2.verses[1].arabic);
    expect(arabic).toHaveAttribute('lang', 'ar');
    expect(arabic).toHaveAttribute('dir', 'rtl');
    expect(screen.getByText(/^C.est le Livre au sujet duquel/)).toHaveAttribute('lang', 'fr');
  });

  it('hands the checked verses to the studio, in reading order', async () => {
    const user = userEvent.setup();
    const onStudio = vi.fn();
    render(<VerseList surah={surah2} onStudio={onStudio} />);

    await user.click(screen.getByLabelText('Sélectionner le verset 3'));
    await user.click(screen.getByLabelText('Sélectionner le verset 2'));
    await user.click(screen.getByRole('button', { name: /Studio/ }));

    expect(onStudio).toHaveBeenCalledWith([
      { surah: 2, verse: 2 },
      { surah: 2, verse: 3 },
    ]);
  });

  it('keeps the studio button out of reach until a verse is checked', async () => {
    const user = userEvent.setup();
    const onStudio = vi.fn();
    render(<VerseList surah={surah2} onStudio={onStudio} />);

    expect(screen.getByRole('button', { name: /Studio/ })).toBeDisabled();

    await user.click(screen.getByLabelText('Sélectionner le verset 1'));
    expect(screen.getByRole('button', { name: /Studio/ })).toBeEnabled();
  });

  it('selects the whole surah, not just the rendered window', async () => {
    const user = userEvent.setup();
    const onStudio = vi.fn();
    render(<VerseList surah={surah2} onStudio={onStudio} />);

    await user.click(screen.getByRole('button', { name: 'Tout sélectionner' }));
    expect(screen.getByText('286 versets sélectionnés')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Studio/ }));
    const selection = onStudio.mock.calls[0][0] as { surah: number; verse: number }[];
    expect(selection).toHaveLength(286);
    expect(selection[0]).toEqual({ surah: 2, verse: 1 });
    expect(selection[285]).toEqual({ surah: 2, verse: 286 });
  });

  it('unchecks everything again', async () => {
    const user = userEvent.setup();
    render(<VerseList surah={surah2} />);

    await user.click(screen.getByRole('button', { name: 'Tout sélectionner' }));
    await user.click(screen.getByRole('button', { name: 'Tout désélectionner' }));

    expect(screen.queryByText(/versets sélectionnés/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Studio/ })).toBeDisabled();
  });

  it('stays inside the DOM budget on the longest surah', () => {
    const { container } = render(<VerseList surah={surah2} />);

    expect(container.querySelectorAll('*').length).toBeLessThan(2000);
  });
});

describe('sourate page', () => {
  it('prerenders all 114 surahs as static pages', () => {
    const params = generateStaticParams();

    expect(params).toHaveLength(114);
    expect(params[0]).toEqual({ id: '1' });
    expect(params[35]).toEqual({ id: '36' });
    expect(params[113]).toEqual({ id: '114' });
  });

  it('reads a surah from the shipped data', () => {
    const surah = readSurah(2);

    expect(surah.nameFr).toBe('Al-Baqara');
    expect(surah.verses).toHaveLength(286);
  });

  it('refuses a surah that does not exist', () => {
    expect(() => readSurah(0)).toThrow(/0/);
    expect(() => readSurah(115)).toThrow(/115/);
  });
});
