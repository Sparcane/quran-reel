import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GenerateButton } from '@/components/studio/GenerateButton';

describe('GenerateButton', () => {
  it('offers a clearly labelled action that starts the render', async () => {
    const onGenerate = vi.fn();
    render(<GenerateButton onGenerate={onGenerate} busy={false} />);

    const button = screen.getByRole('button', { name: /générer/i });
    await userEvent.click(button);
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it('is disabled while a render is being prepared', async () => {
    const onGenerate = vi.fn();
    render(<GenerateButton onGenerate={onGenerate} busy />);

    const button = screen.getByRole('button', { name: /génération/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('is disabled when there is nothing to render', async () => {
    const onGenerate = vi.fn();
    render(<GenerateButton onGenerate={onGenerate} busy={false} disabled />);

    await userEvent.click(screen.getByRole('button', { name: /générer/i }));
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('announces a failure instead of pretending the render started', () => {
    render(<GenerateButton onGenerate={vi.fn()} busy={false} error="audio indisponible" />);
    expect(screen.getByRole('alert')).toHaveTextContent('audio indisponible');
  });
});
