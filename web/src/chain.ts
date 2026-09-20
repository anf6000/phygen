// The chain order and the single playing version. Pure helpers, so the rule is
// tested without a browser.

import type { TreeNode } from './types';

/** The order of one version in the chain: generation, then creation time. */
function rank(node: TreeNode): [number, string] {
  return [node.generation, node.createdAt];
}

function newerThan(a: TreeNode, b: TreeNode): boolean {
  const [aGen, aAt] = rank(a);
  const [bGen, bAt] = rank(b);
  if (aGen !== bGen) return aGen > bGen;
  return aAt > bAt;
}

/** The chain, newest first. The timeline renders this order. */
export function chainOrder(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => (newerThan(a, b) ? -1 : newerThan(b, a) ? 1 : 0));
}

/**
 * The one version that plays live: the newest version with status `promoted`.
 * Every other version shows a still frame.
 */
export function playingVersionId(nodes: TreeNode[]): string | null {
  const promoted = nodes.filter((node) => node.status === 'promoted');
  if (promoted.length === 0) return null;
  return promoted.reduce((newest, node) => (newerThan(node, newest) ? node : newest)).id;
}

/**
 * The label of every card: `Root`, or `Step N` at that position in the chain.
 *
 * Two attempts can share one generation, because a failed step starts again
 * from the same parent. A second attempt gets a letter, so two cards never
 * carry the same name.
 */
export function stepLabels(nodes: TreeNode[]): Record<string, string> {
  const byGeneration = new Map<number, TreeNode[]>();
  for (const node of nodes) {
    const list = byGeneration.get(node.generation);
    if (list) list.push(node);
    else byGeneration.set(node.generation, [node]);
  }

  const labels: Record<string, string> = {};
  for (const [generation, list] of byGeneration) {
    const ordered = [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    ordered.forEach((node, index) => {
      if (generation === 0) {
        labels[node.id] = 'Root';
        return;
      }
      labels[node.id] = ordered.length > 1 ? `Step ${generation}${String.fromCharCode(97 + index)}` : `Step ${generation}`;
    });
  }
  return labels;
}
