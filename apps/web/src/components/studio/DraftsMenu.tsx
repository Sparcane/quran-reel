'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteDraft, listDrafts, loadDraft, saveDraft, type Draft } from '@/lib/drafts';
import { useLocale, useT } from '@/lib/i18n';
import { useStudioStore } from '@/lib/studio-store';

/**
 * Named projects. The draft the studio auto-saves is "where I was"; a saved
 * draft is "the video I am working on", which must survive switching to
 * another one. Opening a draft replaces both the verses and the look.
 */
export function DraftsMenu() {
  const t = useT();
  const locale = useLocale();
  const selection = useStudioStore((state) => state.selection);
  const settings = useStudioStore((state) => state.settings);
  const setSelection = useStudioStore((state) => state.setSelection);
  const patchSettings = useStudioStore((state) => state.patchSettings);

  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const formatDate = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );

  const refresh = useCallback(async () => {
    try {
      setDrafts(await listDrafts());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const defaultName = () =>
    t('studio.drafts.defaultName', { date: formatDate.format(new Date()) });

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await saveDraft({ name: name.trim() || defaultName(), selection, settings });
      setName('');
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string): Promise<void> {
    const draft = await loadDraft(id);
    if (!draft) {
      // Removed in another tab: refresh instead of opening nothing.
      await refresh();
      return;
    }
    setSelection(draft.selection);
    patchSettings(draft.settings);
  }

  async function remove(id: string): Promise<void> {
    await deleteDraft(id);
    await refresh();
  }

  return (
    <section
      aria-labelledby="studio-drafts-title"
      className="rounded-2xl border border-white/10 bg-white/5 p-5"
    >
      <h2 id="studio-drafts-title" className="text-lg font-semibold text-white">
        {t('studio.drafts.title')}
      </h2>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label
            htmlFor="studio-draft-name"
            className="mb-1 block text-sm font-medium text-white/80"
          >
            {t('studio.drafts.name')}
          </label>
          <input
            id="studio-draft-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('studio.drafts.placeholder')}
            maxLength={80}
            className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-base text-white placeholder:text-white/30 focus-visible:border-sky-400 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-sky-400"
          />
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={selection.length === 0 || busy}
          className="rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          {t('studio.drafts.save')}
        </button>
      </div>

      {drafts.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t('studio.drafts.empty')}</p>
      ) : (
        <ul className="mt-3 divide-y divide-white/10">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{draft.name}</p>
                <p className="text-xs text-muted">
                  {t(
                    draft.selection.length === 1
                      ? 'studio.drafts.verses.one'
                      : 'studio.drafts.verses.other',
                    { count: draft.selection.length },
                  )}
                  {' · '}
                  {t('studio.drafts.updated', { date: formatDate.format(draft.updatedAt) })}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => void open(draft.id)}
                  aria-label={`${t('studio.drafts.open')} ${draft.name}`}
                  className="rounded border border-white/20 px-2.5 py-1 text-xs text-white/80 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                >
                  {t('studio.drafts.open')}
                </button>
                <button
                  type="button"
                  onClick={() => void remove(draft.id)}
                  aria-label={`${t('studio.drafts.delete')} ${draft.name}`}
                  className="rounded border border-white/20 px-2.5 py-1 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                >
                  {t('studio.drafts.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-amber-300">
          {t('studio.drafts.error')}
        </p>
      ) : null}
    </section>
  );
}
