'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { deleteFromHistory, listHistory, type HistoryEntry } from '@/lib/history';
import { useT } from '@/lib/i18n';

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} Go`;
  return `${(bytes / 1_000_000).toFixed(1)} Mo`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * The finished videos kept on the device. Retention already trimmed the store
 * to the newest few, so this list is short by construction; each row links to
 * the same `/rendu/{id}` page the render flow uses and can be deleted on its own.
 */
export function HistoryList() {
  const t = useT();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void listHistory().then((found) => {
      if (!alive) return;
      setEntries(found);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function remove(id: string) {
    await deleteFromHistory(id);
    setEntries((current) => current.filter((entry) => entry.id !== id));
  }

  return (
    <section aria-labelledby="history-title" className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <h2 id="history-title" className="text-lg font-semibold text-white">
        {t('history.title')}
      </h2>

      {!loaded ? (
        <p className="mt-3 text-white/60">…</p>
      ) : entries.length === 0 ? (
        <p className="mt-3 text-white/60">{t('history.empty')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-white/10">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="text-sm text-white/80">{formatDate(entry.createdAt)}</p>
                <p className="text-xs tabular-nums text-white/50">
                  {Math.round(entry.video.durationSec)} s · {formatSize(entry.size)} ·{' '}
                  {entry.video.width} × {entry.video.height}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Link
                  href={`/rendu/${entry.id}/`}
                  className="text-sm font-semibold text-sky-400 underline underline-offset-2 hover:text-sky-300"
                >
                  {t('history.view')}
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    void remove(entry.id);
                  }}
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/80 hover:border-rose-400/50 hover:text-rose-200"
                >
                  {t('history.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
