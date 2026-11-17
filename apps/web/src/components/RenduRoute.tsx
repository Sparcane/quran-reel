'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { RenderJob } from '@quran/render';
import { RenduPage } from '@/components/ResultPlayer';
import { jobStore } from '@/lib/queue-store';
import { recoverQueue, startRender } from '@/lib/render-runtime';

/**
 * A render id is created on the device, so it cannot be prerendered. The page
 * reads the job from the store, refreshes it while the renderer works, and lets
 * `RenduPage` turn an unknown id into a real 404.
 */
export function RenduRoute() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const [job, setJob] = useState<RenderJob | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await recoverQueue();
      const found = await jobStore.get(id);
      if (alive) setJob(found ?? null);
    })();

    const timer = window.setInterval(() => {
      void jobStore.get(id).then((found) => {
        if (alive) setJob(found ?? null);
      });
    }, 500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id]);

  if (job === undefined) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <p className="text-white/60">…</p>
      </main>
    );
  }

  return (
    <RenduPage
      job={job}
      onRetry={() => {
        if (!job) return;
        void startRender(job.spec).then((created) => router.push(`/rendu/${created.id}/`));
      }}
    />
  );
}
