import type { Judgment } from '../types';

function num(value: unknown, digits = 3): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * The reason panel: everything the gate measured and judged for one version.
 * A missing number is shown as a dash, never as a zero.
 */
export function JudgmentPanel({ judgment, label }: { judgment: Judgment; label: string }) {
  const novelty = judgment.novelty ?? {};
  const judge = judgment.judge ?? null;
  const weaknesses = judge?.weaknesses ?? [];
  const skipped = judgment.tests.filter((test) => test.available === false);

  return (
    <section className="judgment-panel" aria-label={`Judgment of ${label}`}>
      <header className="judgment-head">
        <strong>{label}</strong>
        <span className={`judgment-chip verdict-${judgment.status}`}>{judgment.status}</span>
        {judgment.repaired ? <span className="judgment-chip verdict-repaired">repaired</span> : null}
        {judgment.enforced ? null : <span className="judgment-note">not enforced</span>}
        {judgment.branch ? <span className="judgment-note">branch {judgment.branch}</span> : null}
        <span className="judgment-note">judge {judgment.judgeCostUsd.toFixed(4)} USD</span>
      </header>

      <p className="judgment-reason">{judgment.reason ?? 'no reason recorded'}</p>

      <dl className="judgment-numbers">
        <div>
          <dt>coherence</dt>
          <dd>{num(novelty.coherence)}</dd>
        </div>
        <div>
          <dt>novelty</dt>
          <dd>{num(novelty.novelty)}</dd>
        </div>
        <div>
          <dt>nearest</dt>
          <dd>{novelty.nearest ? `${novelty.nearest.id.slice(0, 8)} ${num(novelty.nearest.distance)}` : '—'}</dd>
        </div>
        <div>
          <dt>judge mean</dt>
          <dd>{num(novelty.quality)}</dd>
        </div>
        <div>
          <dt>parent quality</dt>
          <dd>{num(novelty.parentQuality)}</dd>
        </div>
      </dl>

      {judgment.frames.length > 0 ? (
        <div className="judgment-frames">
          {judgment.frames.map((frame) =>
            frame.url ? (
              <figure key={frame.url}>
                <img src={frame.url} alt={`${frame.stage} frame at step ${frame.step}`} loading="lazy" decoding="async" />
                <figcaption>
                  {frame.stage} @ {frame.step}
                </figcaption>
              </figure>
            ) : null,
          )}
        </div>
      ) : null}

      <div className="judgment-lists">
        <section>
          <h4>hard tests</h4>
          <ul className="judgment-tests">
            {judgment.tests.map((test) => (
              <li key={test.name} className={test.tripped ? 'trip' : test.available === false ? 'skip' : 'pass'}>
                <span className="test-name">{test.name}</span>
                <span className="test-value">{test.tripped ? 'tripped' : test.available === false ? 'skipped' : 'pass'}</span>
              </li>
            ))}
          </ul>
          {judgment.tests.length === 0 ? <p className="muted">no hard test ran</p> : null}
          {skipped.length > 0 ? <p className="muted">a skipped test is not a pass and not a zero.</p> : null}
        </section>

        <section>
          <h4>criterion scores</h4>
          {judgment.scores.length > 0 ? (
            <ul className="judgment-scores">
              {judgment.scores.map((score) => (
                <li key={score.criterion}>
                  <span>{score.criterion}</span>
                  <span>{num(score.score)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{judge?.error ? `the judge failed: ${judge.error.message}` : 'the judge did not run'}</p>
          )}
        </section>
      </div>

      {weaknesses.length > 0 ? (
        <section>
          <h4>weaknesses the judge named</h4>
          <ul>
            {weaknesses.map((weakness, index) => (
              <li key={index}>{weakness}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {judgment.direction ? (
        <section>
          <h4>the direction</h4>
          <p>{judgment.direction}</p>
        </section>
      ) : null}
    </section>
  );
}
