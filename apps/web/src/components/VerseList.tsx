'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  defaultRangeExtractor,
  observeElementRect,
  useVirtualizer,
} from '@tanstack/react-virtual';
import type { SurahData, VerseRef } from '@quran/core';
import { VerseRow } from '@/components/VerseRow';
import { useT } from '@/lib/i18n';
import {
  handoffSelection,
  MAX_MOUNTED_ROWS,
  OVERSCAN,
  ROW_HEIGHT,
  toSelection,
} from '@/lib/verses';

/**
 * The virtualizer reads the height of its scroll container as soon as it
 * mounts. A container that is not laid out yet (hidden panel, first paint, a
 * DOM without a layout engine) reports 0×0 and would unmount every row; an
 * empty reading is therefore ignored and the deterministic window is kept.
 */
const observeLaidOutRect: typeof observeElementRect = (instance, callback) =>
  observeElementRect(instance, (rect) => {
    if (rect.height === 0 && rect.width === 0) return;
    callback(rect);
  });

interface VerseListProps {
  surah: SurahData;
  /**
   * Called with the checked verses when the reader asks for the studio. The
   * page leaves it out in production: the reader then hands the selection over
   * in session storage and opens the studio itself.
   */
  onStudio?: (selection: VerseRef[]) => void;
}

export function VerseList({ surah, onStudio }: VerseListProps) {
  const t = useT();
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Rows are measured where the browser has a layout engine. Without one (the
  // test DOM, a very old WebView) the fixed estimate is used instead, so the
  // reader still renders a sane window rather than collapsing to zero heights.
  const canMeasure = typeof ResizeObserver !== 'undefined';

  const virtualizer = useVirtualizer({
    count: surah.verses.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    // Deterministic first paint: the reader mounts the window a tall screen
    // would show, and the boundary is never crossed by the cap below.
    initialRect: { width: 0, height: MAX_MOUNTED_ROWS * ROW_HEIGHT },
    observeElementRect: observeLaidOutRect,
    rangeExtractor: (range) => defaultRangeExtractor(range).slice(0, MAX_MOUNTED_ROWS),
  });

  const selection = useMemo(() => toSelection([...checked].map(toRef)), [checked]);

  const toggle = useCallback((ref: VerseRef) => {
    const key = `${ref.surah}:${ref.verse}`;
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const allSelected = selection.length === surah.verses.length;

  const toggleAll = useCallback(() => {
    setChecked(
      allSelected
        ? new Set()
        : new Set(surah.verses.map((verse) => `${surah.number}:${verse.number}`)),
    );
  }, [allSelected, surah]);

  const openStudio = () => {
    if (selection.length === 0) return;
    if (onStudio) {
      onStudio(selection);
      return;
    }
    handoffSelection(selection);
    window.location.assign('/studio/');
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-6">
        <p className="text-sm text-white/55">
          {t('surah.label', { number: surah.number })} ·{' '}
          {t(surah.revelation === 'meccan' ? 'surah.meccan' : 'surah.medinan')} ·{' '}
          {t(surah.verseCount === 1 ? 'surah.verses.one' : 'surah.verses.other', {
            count: surah.verseCount,
          })}
        </p>
        <div className="mt-1 flex items-baseline justify-between gap-4">
          <h1 className="text-3xl font-semibold tracking-tight text-white">{surah.nameFr}</h1>
          <p lang="ar" dir="rtl" className="text-2xl text-white/85">
            {surah.nameAr}
          </p>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={toggleAll}
          className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          {allSelected ? t('reader.unselectAll') : t('reader.selectAll')}
        </button>
        <p aria-live="polite" className="text-sm text-white/60">
          {selection.length === 0
            ? t('reader.none')
            : t(selection.length === 1 ? 'reader.selected.one' : 'reader.selected.other', {
                count: selection.length,
              })}
        </p>
      </div>

      <div
        ref={scrollRef}
        className="h-[70vh] overflow-y-auto rounded-xl border border-white/10 p-2"
      >
        <ul
          className="relative m-0 list-none p-0"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => (
            <li
              key={item.key}
              data-index={item.index}
              ref={canMeasure ? virtualizer.measureElement : undefined}
              className="absolute left-0 top-0 w-full pb-2"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <VerseRow
                surah={surah.number}
                verse={surah.verses[item.index]}
                selected={checked.has(`${surah.number}:${surah.verses[item.index].number}`)}
                onToggle={toggle}
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={openStudio}
          disabled={selection.length === 0}
          className="rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          {t('reader.openStudio')}
        </button>
      </div>
    </main>
  );
}

function toRef(key: string): VerseRef {
  const [surah, verse] = key.split(':').map(Number);
  return { surah, verse };
}
