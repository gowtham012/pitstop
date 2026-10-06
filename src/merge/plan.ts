export type MergeStrategy = 'commit' | 'apply' | 'defer' | 'pr' | 'nothing';

export interface MergeFacts {
  mode: 'local' | 'pr';
  /** Fork has commits beyond its snapshot. */
  forkHasChanges: boolean;
  /** The fork's commits rebased cleanly onto the parent's current HEAD. */
  rebaseOk: boolean;
  /** The parent's working tree has no uncommitted changes. */
  parentClean: boolean;
  /** Files the parent has uncommitted changes in that the fork also changed. */
  overlap: string[];
  /** The fork's patch applies cleanly to the parent's working tree. */
  applyCheckOk: boolean;
}

export interface MergePlan {
  strategy: MergeStrategy;
  reason: string;
}

/**
 * Pick how to bring a fork back without disturbing a parent that may still
 * be editing. Pure, so every branch of the table is unit-tested.
 */
export function planMerge(f: MergeFacts): MergePlan {
  if (!f.forkHasChanges) return { strategy: 'nothing', reason: 'the fork made no commits' };
  if (f.mode === 'pr') return { strategy: 'pr', reason: 'merge.mode is "pr"' };
  if (!f.rebaseOk) {
    return {
      strategy: 'defer',
      reason: "the fork's commits conflict with the parent's latest commits",
    };
  }
  if (f.parentClean) return { strategy: 'commit', reason: "the parent's working tree is clean" };
  if (f.overlap.length) {
    return {
      strategy: 'defer',
      reason: `the parent has uncommitted changes in ${f.overlap.join(', ')}, which the fork also changed`,
    };
  }
  if (f.applyCheckOk) {
    return {
      strategy: 'apply',
      reason: "the parent is mid-edit, but in different files; the fork's changes apply cleanly",
    };
  }
  return {
    strategy: 'defer',
    reason: "the fork's patch doesn't apply cleanly to the parent's working tree",
  };
}
