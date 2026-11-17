'use client';

import { useState } from 'react';

interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}

/**
 * A numeric setting that never fights the user. While the field has focus it
 * shows exactly what was typed; the store clamps every keystroke, and on blur
 * the field shows the value that will actually be rendered. Without the local
 * draft, typing "150" would rewrite the input to "120" after the first "1".
 */
export function NumberField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-white/80">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={draft ?? String(value)}
          onChange={(event) => {
            const raw = event.target.value;
            setDraft(raw);
            if (raw.trim() === '') return;
            const parsed = Number(raw);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
          onBlur={() => setDraft(null)}
          className="w-24 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-base tabular-nums text-white focus-visible:border-sky-400 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-sky-400"
        />
        {suffix ? <span className="text-sm text-muted">{suffix}</span> : null}
      </div>
    </div>
  );
}
