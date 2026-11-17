import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { dimensionsFor } from '@quran/core';
import { AspectRatioPicker } from '../src/components/studio/AspectRatioPicker';
import { BackgroundPicker } from '../src/components/studio/BackgroundPicker';
import { ColorControls } from '../src/components/studio/ColorControls';
import { DraftsMenu } from '../src/components/studio/DraftsMenu';
import { PreviewButton } from '../src/components/studio/PreviewButton';
import { StudioShell } from '../src/components/studio/StudioShell';
import { TypographyControls } from '../src/components/studio/TypographyControls';
import { deleteDraft, listDrafts, saveDraft } from '../src/lib/drafts';
import { PreviewPlayer } from '../src/lib/preview-audio';
import { DEFAULT_STUDIO_SETTINGS } from '../src/lib/studio-settings';
import { useStudioStore } from '../src/lib/studio-store';
import { loadBackgroundAsset } from '../src/lib/storage';
import { STUDIO_HANDOFF_KEY } from '../src/lib/verses';
import { fakeAudio, fakeFetch } from './fake-audio';

/** The eight bytes every PNG starts with; enough for the validator. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

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

describe('BackgroundPicker', () => {
  it('offers the gradients that ship with the app', async () => {
    const user = userEvent.setup();
    render(<BackgroundPicker />);

    await user.click(screen.getByLabelText('Crépuscule'));

    const { background } = useStudioStore.getState().settings;
    expect(background.kind).toBe('gradient');
    expect(screen.getByLabelText('Crépuscule')).toBeChecked();
    expect(screen.getByLabelText('Nuit')).not.toBeChecked();
  });

  it('imports a picture and keeps the bytes on the device, not in the draft', async () => {
    const user = userEvent.setup();
    render(<BackgroundPicker />);
    const file = new File([PNG], 'mosquee.png', { type: 'image/png' });

    await user.upload(screen.getByLabelText('Importer un fond'), file);

    await waitFor(() => {
      expect(useStudioStore.getState().settings.background.kind).toBe('image');
    });
    const background = useStudioStore.getState().settings.background;
    if (background.kind !== 'image') throw new Error('expected an imported image');

    expect(background.name).toBe('mosquee.png');
    expect(background).not.toHaveProperty('blob');
    const stored = await loadBackgroundAsset(background.assetId);
    expect(stored?.name).toBe('mosquee.png');
    expect(stored?.blob.size).toBe(file.size);
    expect(await screen.findByText('Fond importé : mosquee.png')).toBeInTheDocument();
  });

  it('explains why a non-H.264 video was refused, and keeps the old background', async () => {
    const user = userEvent.setup();
    render(<BackgroundPicker />);
    const bytes = new Uint8Array(64);
    bytes.set([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypisom')], 0);
    bytes.set(new TextEncoder().encode('hvc1'), 32);
    const hevc = new File([bytes], 'fond.mp4', { type: 'video/mp4' });

    await user.upload(screen.getByLabelText('Importer un fond'), hevc);

    expect(await screen.findByRole('alert')).toHaveTextContent(/H\.264/);
    expect(useStudioStore.getState().settings.background.kind).toBe('gradient');
  });

  it('drops an imported background when the user removes it', async () => {
    const user = userEvent.setup();
    render(<BackgroundPicker />);
    await user.upload(
      screen.getByLabelText('Importer un fond'),
      new File([PNG], 'mosquee.png', { type: 'image/png' }),
    );
    await waitFor(() => {
      expect(useStudioStore.getState().settings.background.kind).toBe('image');
    });
    const background = useStudioStore.getState().settings.background;
    if (background.kind === 'gradient') throw new Error('expected an imported image');

    await user.click(screen.getByRole('button', { name: 'Retirer' }));

    expect(useStudioStore.getState().settings.background.kind).toBe('gradient');
    await waitFor(async () => {
      expect(await loadBackgroundAsset(background.assetId)).toBeNull();
    });
  });
});

describe('DraftsMenu', () => {
  // jsdom has no IndexedDB, so drafts live in the session fallback shared by
  // every test in this file. Each test starts from an empty list.
  beforeEach(async () => {
    for (const draft of await listDrafts()) await deleteDraft(draft.id);
  });

  it('saves the current verses under the name the user typed', async () => {
    const user = userEvent.setup();
    useStudioStore.getState().setSelection([
      { surah: 36, verse: 1 },
      { surah: 36, verse: 2 },
    ]);
    render(<DraftsMenu />);

    await user.type(screen.getByLabelText('Nom du brouillon'), 'Yassin');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByText('Yassin')).toBeInTheDocument();
    expect(screen.getByText(/2 versets/)).toBeInTheDocument();
    const drafts = await listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].selection).toEqual([
      { surah: 36, verse: 1 },
      { surah: 36, verse: 2 },
    ]);
  });

  it('falls back to a dated name when the user leaves it blank', async () => {
    const user = userEvent.setup();
    useStudioStore.getState().setSelection([{ surah: 1, verse: 1 }]);
    render(<DraftsMenu />);

    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByText(/^Brouillon du /)).toBeInTheDocument();
    const [draft] = await listDrafts();
    expect(draft.name).toMatch(/^Brouillon du /);
  });

  it('reopens a saved draft with its verses and its look', async () => {
    const user = userEvent.setup();
    await saveDraft({
      name: 'Kahf',
      selection: [{ surah: 18, verse: 1 }],
      settings: { ...DEFAULT_STUDIO_SETTINGS, arabicSize: 100, aspectRatio: '16:9' },
    });
    render(<DraftsMenu />);

    await user.click(await screen.findByRole('button', { name: 'Ouvrir Kahf' }));

    const { selection, settings } = useStudioStore.getState();
    expect(selection).toEqual([{ surah: 18, verse: 1 }]);
    expect(settings.arabicSize).toBe(100);
    expect(settings.aspectRatio).toBe('16:9');
  });

  it('deletes a draft and says the list is empty again', async () => {
    const user = userEvent.setup();
    await saveDraft({
      name: 'Kahf',
      selection: [{ surah: 18, verse: 1 }],
      settings: DEFAULT_STUDIO_SETTINGS,
    });
    render(<DraftsMenu />);

    await user.click(await screen.findByRole('button', { name: 'Supprimer Kahf' }));

    await waitFor(() => {
      expect(screen.queryByText('Kahf')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Aucun brouillon enregistré.')).toBeInTheDocument();
    expect(await listDrafts()).toHaveLength(0);
  });
});

describe('PreviewButton', () => {
  it('plays the selected verses, then stops on request', async () => {
    const user = userEvent.setup();
    const audio = fakeAudio();
    audio.unblock();
    const player = new PreviewPlayer(fakeFetch(), audio.factory);
    useStudioStore.getState().setSelection([{ surah: 1, verse: 1 }]);
    render(<PreviewButton createPlayer={() => player} />);

    await user.click(screen.getByRole('button', { name: "Écouter l'aperçu" }));

    expect(audio.sources).toHaveLength(1);
    await user.click(await screen.findByRole('button', { name: 'Arrêter' }));

    expect(audio.sources[0].stopped).toBe(true);
    expect(screen.getByRole('button', { name: "Écouter l'aperçu" })).toBeInTheDocument();
  });

  it('asks for the click that unblocks sound instead of staying silent', async () => {
    const user = userEvent.setup();
    const audio = fakeAudio();
    audio.block();
    const player = new PreviewPlayer(fakeFetch(), audio.factory);
    useStudioStore.getState().setSelection([{ surah: 1, verse: 1 }]);
    render(<PreviewButton createPlayer={() => player} />);

    await user.click(screen.getByRole('button', { name: "Écouter l'aperçu" }));

    expect(await screen.findByText('Cliquez pour activer le son')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activer le son' })).toBeInTheDocument();
  });

  it('says the recitation could not be downloaded', async () => {
    const user = userEvent.setup();
    const audio = fakeAudio();
    audio.unblock();
    const player = new PreviewPlayer(fakeFetch('001001.mp3'), audio.factory);
    useStudioStore.getState().setSelection([{ surah: 1, verse: 1 }]);
    render(<PreviewButton createPlayer={() => player} />);

    await user.click(screen.getByRole('button', { name: "Écouter l'aperçu" }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Vérifiez votre connexion/);
    expect(screen.getByRole('button', { name: "Écouter l'aperçu" })).toBeEnabled();
  });

  it('cannot be pressed while no verse is selected', () => {
    render(<PreviewButton />);

    expect(screen.getByRole('button', { name: "Écouter l'aperçu" })).toBeDisabled();
  });
});
