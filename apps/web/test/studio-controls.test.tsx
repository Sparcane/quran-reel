import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { dimensionsFor } from '@quran/core';
import { AspectRatioPicker } from '../src/components/studio/AspectRatioPicker';
import { ColorControls } from '../src/components/studio/ColorControls';
import { StudioShell } from '../src/components/studio/StudioShell';
import { TypographyControls } from '../src/components/studio/TypographyControls';
import { DEFAULT_STUDIO_SETTINGS } from '../src/lib/studio-settings';
import { useStudioStore } from '../src/lib/studio-store';
import { STUDIO_HANDOFF_KEY } from '../src/lib/verses';

beforeEach(() => {
  useStudioStore.setState({ selection: [], settings: DEFAULT_STUDIO_SETTINGS });
  sessionStorage.clear();
});

describe('dimensionsFor', () => {
  it('gives the pixel size the renderer will use for each format', () => {
    expect(dimensionsFor('16:9')).toEqual({ width: 1920, height: 1080 });
    expect(dimensionsFor('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsFor('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(dimensionsFor('4:5')).toEqual({ width: 1080, height: 1350 });
  });

  it('refuses a format it does not know', () => {
    expect(() => dimensionsFor('21:9' as never)).toThrow(/21:9/);
  });
});

describe('AspectRatioPicker', () => {
  it('switches the whole draft to the chosen format', async () => {
    const user = userEvent.setup();
    useStudioStore.getState().patchSettings({ aspectRatio: '16:9' });
    render(<AspectRatioPicker />);

    await user.click(screen.getByLabelText('Format 9:16'));

    expect(useStudioStore.getState().settings.aspectRatio).toBe('9:16');
    expect(screen.getByLabelText('Format 9:16')).toBeChecked();
    expect(screen.getByLabelText('Format 16:9')).not.toBeChecked();
  });

  it('offers exactly the four formats the renderer can produce', () => {
    render(<AspectRatioPicker />);

    const group = screen.getByRole('group', { name: 'Format de la vidéo' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(4);
  });
});

describe('TypographyControls', () => {
  it('clamps a size the user types to the range the renderer accepts', async () => {
    const user = userEvent.setup();
    render(<TypographyControls />);

    const arabicSize = screen.getByLabelText('Taille du texte arabe');
    await user.clear(arabicSize);
    await user.type(arabicSize, '150');

    expect(useStudioStore.getState().settings.arabicSize).toBe(120);
    expect(arabicSize).toHaveAttribute('min', '24');
    expect(arabicSize).toHaveAttribute('max', '120');
  });

  it('clamps the translation size the same way', async () => {
    const user = userEvent.setup();
    render(<TypographyControls />);

    const translationSize = screen.getByLabelText('Taille de la traduction');
    await user.clear(translationSize);
    await user.type(translationSize, '4');

    expect(useStudioStore.getState().settings.translationSize).toBe(16);
  });

  it('turns the translation off and picks its language', async () => {
    const user = userEvent.setup();
    render(<TypographyControls />);

    await user.click(screen.getByLabelText('Afficher la traduction'));
    await user.selectOptions(screen.getByLabelText('Langue de la traduction'), 'en');

    const { settings } = useStudioStore.getState();
    expect(settings.showTranslation).toBe(false);
    expect(settings.translationLang).toBe('en');
  });

  it('offers word-by-word subtitles, labelled as an estimate', async () => {
    const user = userEvent.setup();
    render(<TypographyControls />);

    await user.click(screen.getByLabelText('Mot par mot (estimation)'));

    expect(useStudioStore.getState().settings.subtitleMode).toBe('word');
  });
});

describe('ColorControls', () => {
  it('stores the picked text colour', () => {
    render(<ColorControls />);

    fireEvent.change(screen.getByLabelText('Couleur du texte'), {
      target: { value: '#ffcc00' },
    });

    expect(useStudioStore.getState().settings.textColor).toBe('#ffcc00');
  });

  it('keeps the veil within 0 to 90 percent', () => {
    render(<ColorControls />);

    const veil = screen.getByLabelText('Assombrissement du fond');
    fireEvent.change(veil, { target: { value: '100' } });
    expect(useStudioStore.getState().settings.overlayOpacity).toBe(90);

    fireEvent.change(veil, { target: { value: '-10' } });
    expect(useStudioStore.getState().settings.overlayOpacity).toBe(0);
  });
});

describe('StudioShell', () => {
  it('shows an empty state with a way back, never a redirect', () => {
    render(<StudioShell />);

    expect(screen.getByRole('heading', { name: 'Aucun verset sélectionné' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Parcourir les sourates' })).toHaveAttribute(
      'href',
      '/bibliotheque/',
    );
    expect(screen.queryByLabelText('Taille du texte arabe')).not.toBeInTheDocument();
  });

  it('shows the count and the exported size of the draft', () => {
    useStudioStore.getState().setSelection([
      { surah: 2, verse: 2 },
      { surah: 2, verse: 3 },
    ]);
    render(<StudioShell />);

    expect(screen.getByText('2 versets dans la vidéo')).toBeInTheDocument();
    expect(screen.getByText('1080 × 1920')).toBeInTheDocument();
  });

  it('takes the verses the reader handed over when it opens', async () => {
    sessionStorage.setItem(STUDIO_HANDOFF_KEY, JSON.stringify([{ surah: 36, verse: 1 }]));
    render(<StudioShell />);

    expect(await screen.findByText('1 verset dans la vidéo')).toBeInTheDocument();
    expect(useStudioStore.getState().selection).toEqual([{ surah: 36, verse: 1 }]);
    expect(await screen.findByLabelText('Format 9:16')).toBeInTheDocument();
  });
});
