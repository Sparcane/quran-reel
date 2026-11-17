'use client';

import { useT } from '@/lib/i18n';

export interface GenerateButtonProps {
  onGenerate(): void;
  busy: boolean;
  error?: string | null;
  disabled?: boolean;
}

/**
 * The one action that starts a render. It stays dumb on purpose: the studio owns
 * the async work, so this button can be tested without a codec or a router.
 */
export function GenerateButton({ onGenerate, busy, error, disabled }: GenerateButtonProps) {
  const t = useT();

  return (
    <div>
      <button
        type="button"
        onClick={onGenerate}
        disabled={busy || disabled}
        className="inline-flex w-full items-center justify-center rounded-lg bg-sky-500 px-4 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      >
        {busy ? t('studio.generating') : t('studio.generate')}
      </button>
      {error ? <p role="alert" className="mt-2 text-sm text-rose-200">{error}</p> : null}
    </div>
  );
}
