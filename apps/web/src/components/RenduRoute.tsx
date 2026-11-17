'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { RenderJob } from '@quran/render';
import { RenduPage } from '@/components/ResultPlayer';
import { jobStore } from '@/lib/queue-store';
import { recoverQueue, resumeRender, startRender } from '@/lib/render-runtime';

/**
 * The static export prerenders /rendu/[id] once as /rendu/_ and a host rewrite
 * serves that page for every real id (see apps/web/vercel.json). The router's
 * params therefore carry the placeholder "_" while the address bar holds the
 * job's real id. The address bar is the source of truth; the router value is
 * only a server-side fallback (there is no window while prerendering).
 */
function currentId(fallback: string | undefined): string {
  if (typeof window !== 'undefined') {
    const fromUrl = decodeURIComponent(
      window.location.pathname.split('/').filter(Boolean).pop() ?? '',
    );
    if (fromUrl) return fromUrl;
  }
  return fallback ?? '';
}

/**
 * A render id is created on the device, so it cannot be prerendered. The page
 * reads the job from the store, refreshes it while the renderer works, and lets
 * `RenduPage` turn an unknown id into a real 404.
 */
export function RenduRoute() {
  const params = useParams<{ id: string }>();
  const routeId = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = currentId(routeId);
  const [job, setJob] = useState<RenderJob | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await recoverQueue();
      const found = await jobStore.get(id);
      if (!alive) return;
      setJob(found ?? null);
      // A full page load created a fresh queue on this page. A job queued by
      // the studio is still waiting; pump it here so its worker lives in this
      // document and survives until the video is finished.
      if (found?.status === 'queued') void resumeRender(found);
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
        void startRender(job.spec).then((created) => window.location.assign(`/rendu/${created.id}/`));
      }}
    />
  );
}
