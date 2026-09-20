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
 * How much of an artwork still shows when the next one takes over.
 *
 * One fifth. The reading line sits at this share of the distance between two
 * cards, so the artwork above is down to about a fifth of its height and the new
 * one is almost fully on screen when it starts to play.
 */
export const READING_LINE_FRACTION = 0.2;

/**
 * The card that holds the top of the view, and therefore plays live.
 *
 * Cards arrive in display order, newest first. The live card is the lowest one
 * whose top edge is still above the reading line, so scrolling down stops one
 * artwork and starts the next. The first card plays when the view is above all
 * of them, which is the state of a page that has just loaded.
 *
 * @param cards the cards, in display order, with their top edge in pixels
 * @param line the reading line, measured from the top of the scroll area
 */
export function visibleCardId(cards: { id: string; top: number }[], line: number): string | null {
  if (cards.length === 0) return null;
  let chosen = cards[0].id;
  for (const card of cards) {
    if (card.top > line) break;
    chosen = card.id;
  }
  return chosen;
}

/**
 * The card that PLAYS at a given scroll position.
 *
 * The card at the top of the view plays when it can: a card that is still being
 * made has no snapshot, so the newest artwork that can play takes over. That is
 * the state of a page that has just loaded while a run is working — the step in
 * progress shows its pixel field, and the newest finished artwork plays.
 *
 * @param cards the cards, in display order, newest first
 * @param line the reading line, measured from the top of the scroll area
 */
export function autoplayCardId(cards: { id: string; top: number; playable: boolean }[], line: number): string | null {
  if (cards.length === 0) return null;
  const topId = visibleCardId(cards, line);
  const top = cards.find((card) => card.id === topId);
  if (top?.playable) return top.id;

  const playable = cards.filter((card) => card.playable);
  if (playable.length === 0) return null;
  const above = playable.filter((card) => card.top <= line);
  return (above.length > 0 ? above[above.length - 1] : playable[0]).id;
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
