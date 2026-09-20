import type { TreeNode } from '../types';

export interface LiveModalProps {
  version: TreeNode;
  onClose: () => void;
}

/** A large square live view of one version. */
export function LiveModal({ version, onClose }: LiveModalProps) {
  const label = version.step === null || version.step === undefined ? 'Root' : `Step ${version.step}`;

  return (
    <div className="live-overlay" role="dialog" aria-modal="true" aria-label="Live artwork">
      <div className="live-frame">
        <header>
          <span>
            Live artwork — {label} · {version.title}
          </span>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="live-square">
          <iframe src={version.liveUrl} title={`Live artwork ${version.title}`} sandbox="allow-scripts" referrerPolicy="no-referrer" />
        </div>
      </div>
    </div>
  );
}
