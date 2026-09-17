// A version thumbnail that never leaves a broken image behind.
//
// A capture file can disappear after a cleanup, so an image that fails to load
// is marked here. A persistent failure becomes a labelled placeholder, and the
// interface keeps working.
import { useEffect, useState } from 'react';

export function VersionThumb({
  url,
  alt,
  className = '',
  missingLabel = 'no frame',
}: {
  url: string | null;
  alt: string;
  className?: string;
  missingLabel?: string;
}) {
  const [failed, setFailed] = useState(false);
  // A new URL deserves a new attempt.
  useEffect(() => setFailed(false), [url]);

  if (!url || failed) {
    return (
      <div className={`thumb-missing ${className}`} role="img" aria-label={`${alt}: ${missingLabel}`} title={`${alt}: ${missingLabel}`}>
        <span aria-hidden="true">{missingLabel}</span>
      </div>
    );
  }
  return <img src={url} alt={alt} className={className} loading="lazy" onError={() => setFailed(true)} />;
}
