import type { TreeNode } from '../types';

/**
 * The gate strip on one card: the verdict, and whether a park was enforced.
 * In warn mode a park verdict is shown but the step was kept.
 */
export function JudgmentStrip({ node }: { node: TreeNode }) {
  if (!node.verdict) return null;
  const label =
    node.verdict === 'kept'
      ? node.repaired
        ? 'repaired'
        : 'kept'
      : node.verdict === 'parked'
        ? node.verdictEnforced
          ? 'parked'
          : 'would park'
        : 'not judged';
  return (
    <div className={`judgment-strip verdict-${node.verdict}${node.verdictEnforced ? ' is-enforced' : ''}`}>
      <span className="judgment-chip">{label}</span>
      {node.verdict === 'parked' && !node.verdictEnforced ? <span className="judgment-note">warn only</span> : null}
      {node.verdict === 'pending' ? <span className="judgment-note">no frame measured</span> : null}
    </div>
  );
}
