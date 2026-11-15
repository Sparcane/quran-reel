import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SurahMeta } from '@quran/core';
import Bibliotheque from '../src/components/Bibliotheque';
import { filterSurahs } from '../src/lib/surahs';
import index from '../public/data/surahs-index.json';

const surahs = index as SurahMeta[];

describe('filterSurahs', () => {
  it('returns every surah for an empty query', () => {
    expect(filterSurahs(surahs, '')).toHaveLength(114);
    expect(filterSurahs(surahs, '   ')).toHaveLength(114);
  });

  it('finds a surah by its french name, whatever the accents or hyphens', () => {
    expect(filterSurahs(surahs, 'yassin').map((surah) => surah.number)).toEqual([36]);
    expect(filterSurahs(surahs, 'yâ-sîn').map((surah) => surah.number)).toEqual([36]);
  });

  it('finds a surah by its number', () => {
    expect(filterSurahs(surahs, '36').map((surah) => surah.number)).toEqual([36]);
    expect(filterSurahs(surahs, '114').map((surah) => surah.number)).toEqual([114]);
  });

  it('finds a surah by its english name', () => {
    expect(filterSurahs(surahs, 'al-baqara').map((surah) => surah.number)).toEqual([2]);
  });

  it('finds a surah by its arabic name, with or without the diacritics', () => {
    expect(filterSurahs(surahs, 'يس').map((surah) => surah.number)).toContain(36);
    expect(filterSurahs(surahs, 'يٰسٓ').length).toBeGreaterThan(0);
  });

  it('never matches everything when nothing matches', () => {
    expect(filterSurahs(surahs, 'zzz')).toEqual([]);
  });
});

describe('Bibliotheque', () => {
  it('lists the 114 surahs as real links', () => {
    render(<Bibliotheque index={surahs} />);

    expect(screen.getAllByRole('link')).toHaveLength(114);
    expect(screen.getByRole('link', { name: /Al-Fâtiha/ })).toHaveAttribute(
      'href',
      '/sourate/1/',
    );
  });

  it('filters as the user types', async () => {
    const user = userEvent.setup();
    render(<Bibliotheque index={surahs} />);
    const input = screen.getByLabelText('Rechercher une sourate');

    await user.type(input, 'yassin');
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));
    expect(screen.getByRole('link', { name: /Yâ-Sîn/ })).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '36');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Yâ-Sîn/ })).toBeInTheDocument(),
    );

    await user.clear(input);
    await user.type(input, 'zzz');
    await waitFor(() => expect(screen.getByText('Aucune sourate trouvée')).toBeInTheDocument());
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('talks about the result count out loud', async () => {
    const user = userEvent.setup();
    render(<Bibliotheque index={surahs} />);

    expect(screen.getByText('114 sourates')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Rechercher une sourate'), 'yassin');
    await waitFor(() => expect(screen.getByText('1 sourate')).toBeInTheDocument());
  });

  it('stays inside the DOM budget', () => {
    const { container } = render(<Bibliotheque index={surahs} />);

    expect(container.querySelectorAll('*').length).toBeLessThan(2000);
  });
});
