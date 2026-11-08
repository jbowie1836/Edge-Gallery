import { useCallback, useEffect, useState } from 'react';
import type { AtlasData, CountyFeatureCollection } from '../../types';
import { normalizeAtlasData, normalizeGeometry } from './atlasModel';

export const INCOME_URL = '/data/income.json';
export const GEOMETRY_URL = '/data/texas-counties.geojson';
const TIMEOUT_MS = 30_000;

export type AtlasState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: AtlasData; geometry: CountyFeatureCollection };

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json, application/geo+json' } });
  if (!response.ok) throw new Error(`${url} could not be loaded (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${url} is missing or is not valid JSON.`);
  }
}

/** Loads income records and boundaries together; retry re-runs both requests. */
export function useAtlasData(): { state: AtlasState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AtlasState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);

    Promise.all([fetchJson(INCOME_URL, controller.signal), fetchJson(GEOMETRY_URL, controller.signal)])
      .then(([income, geometry]) => {
        if (!active) return;
        setState({ status: 'ready', data: normalizeAtlasData(income), geometry: normalizeGeometry(geometry) });
      })
      .catch((error: unknown) => {
        if (!active) return;
        controller.abort();
        const message = timedOut
          ? 'The data took too long to arrive.'
          : error instanceof Error ? error.message : 'An unknown error occurred.';
        setState({ status: 'error', message });
      })
      .finally(() => window.clearTimeout(timer));

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  return { state, retry };
}
