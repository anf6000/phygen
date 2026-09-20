// Thin API client and the event stream hook.
import { useEffect, useRef, useState } from 'react';

import type { AgentRow, ApiError, Health, ModelList, ProgressEvent, Run, RunDetail, Tree } from './types';

export class RequestError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'RequestError';
    this.code = error.code;
    this.detail = error.detail ?? {};
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    throw new RequestError({ code: 'network_error', message: `The controller did not answer: ${(cause as Error).message}` });
  }
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok) {
    if (body && typeof body === 'object' && 'error' in body && body.error) {
      throw new RequestError(body.error as ApiError);
    }
    throw new RequestError({ code: 'request_failed', message: `The controller answered ${response.status}` });
  }
  return body as T;
}

export const api = {
  health: () => request<Health>('/api/health'),
  artworks: () =>
    request<{ artworks: { id: string; title: string; packageId: string; rootVersionId: string | null; versionCount: number }[] }>('/api/artworks'),
  importArtwork: (packagePath: string) =>
    request<{ artwork: { id: string } }>('/api/artworks/import', { method: 'POST', body: JSON.stringify({ packagePath }) }),
  tree: (artworkId: string) => request<Tree>(`/api/artworks/${artworkId}/tree`),
  agentFeed: (versionId: string) => request<{ rows: AgentRow[] }>(`/api/versions/${versionId}/agent`),
  models: () => request<ModelList>('/api/models'),
  startRun: (body: Record<string, unknown>) => request<{ run: Run }>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  run: (runId: string) => request<RunDetail>(`/api/runs/${runId}`),
  runSummary: (runId: string) => request<{ run: Run; active: boolean }>(`/api/runs/${runId}/summary`),
  runs: () => request<{ runs: Run[] }>('/api/runs?limit=20'),
};

export interface StreamState {
  events: ProgressEvent[];
  lastSeq: number;
  connected: boolean;
}

/**
 * Subscribe to one run. The stream resumes from the last sequence number it
 * saw, so a reconnect never loses or repeats a row.
 */
export function useRunEvents(runId: string | null): StreamState {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef(0);

  useEffect(() => {
    setEvents([]);
    lastSeq.current = 0;
    if (!runId) return undefined;

    let source: EventSource | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const url = `/api/runs/${runId}/events`;
      source = new EventSource(url, { withCredentials: false });
      source.onopen = () => setConnected(true);
      source.onerror = () => setConnected(false);
      source.onmessage = (message) => {
        const parsed = JSON.parse(message.data) as ProgressEvent;
        if (typeof parsed.seq !== 'number' || parsed.seq <= lastSeq.current) return;
        lastSeq.current = parsed.seq;
        setEvents((current) => [...current, parsed].slice(-600));
      };
    };
    connect();

    return () => {
      closed = true;
      setConnected(false);
      source?.close();
    };
  }, [runId]);

  return { events, lastSeq: lastSeq.current, connected };
}
