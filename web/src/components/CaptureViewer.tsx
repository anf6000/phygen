import { useEffect, useState } from 'react';

import { RequestError, api } from '../api';
import type { VersionDetail } from '../types';

/** The large viewer: ordered frames, fullscreen, and the failure diagnostics. */
export function CaptureViewer({ version, onClose }: { version: string; onClose: () => void }) {
  const [detail, setDetail] = useState<VersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .version(version)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof RequestError ? `${cause.code}: ${cause.message}` : String(cause));
      });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
    };
  }, [version, onClose]);

  return (
    <div className={`viewer ${full ? 'is-full' : ''}`} role="dialog" aria-modal="true" aria-label="Captured frames">
      <header>
        <span>{detail?.version.title ?? 'Loading…'}</span>
        <span className="row">
          <button type="button" onClick={() => setFull((value) => !value)}>
            {full ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </span>
      </header>

      {error ? <p className="alert">{error}</p> : null}

      {detail ? (
        detail.captures.length === 0 ? (
          <div className="alert" role="alert">
            <strong>{detail.error?.code ?? 'no_capture'}</strong> {detail.error?.message ?? 'This version has no captured frame, so it cannot be shown.'}
          </div>
        ) : (
          <>
            <ul className="frames">
              {detail.captures.map((capture) => (
                <li key={capture.id}>
                  <img src={capture.url} alt={`${detail.version.title}, ${capture.stage} frame at step ${capture.step}, seed ${capture.seed}`} />
                  <span className="muted">
                    {capture.stage} · step {capture.step} · seed {capture.seed} · {capture.width}×{capture.height}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted">
              Ordered frames show development. They do not prove smooth motion. Renderer {detail.captures[0].rendererBackend ?? 'unknown'}.
            </p>
          </>
        )
      ) : (
        <p className="muted">Loading the frames…</p>
      )}
    </div>
  );
}
