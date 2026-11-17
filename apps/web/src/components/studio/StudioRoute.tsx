'use client';

import { StudioShell } from './StudioShell';

/**
 * The result page is a dynamic route the static export prerenders only once as
 * /rendu/_. Next's client router cannot match a real id against that segment,
 * so it answers 404. Open the result with a full load instead; the queued job
 * survives in IndexedDB and the result page resumes the render there.
 */
export function StudioRoute() {
  return <StudioShell navigate={(url) => window.location.assign(url)} />;
}
