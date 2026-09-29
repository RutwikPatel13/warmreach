import type { Difficulty, PrepQuestion, PrepSet, Window } from "./prep";
import { SQL50_SET, sqlSeedIntegrity } from "./prepSeedSql";

// ── Seed question sets ──────────────────────────────────────────────────────
// A set the page can show before any sync has run. LinkedIn's is transcribed
// from the Premium company page itself, so it's exactly what LeetCode had.
//
// It cross-checks against LeetCode's own progress card — Easy 2/4, Med 13/26,
// Hard 0/7, 15 of 37 solved — which is the reason to trust the transcription.
// prepSeedIntegrity() below re-asserts that on every load; if a later edit
// breaks the arithmetic, the mismatch surfaces instead of quietly shipping.
//
// Order is LeetCode's own, which for a company list is the frequency ranking,
// so array position IS rank. Note the four recent questions land at #8, #19,
// #35 and #36: currently asked, historically uncommon.

const HOT: Window[] = ["thirty-days", "three-months", "six-months"];
const SIX: Window[] = ["six-months"];

/** [id, slug, title, difficulty, acceptance, solvedOnLeetCode, hot, statement, tags] */
type Row = [number, string, string, Difficulty, number, 0 | 1, 0 | 1, string, string[]];

const LINKEDIN: Row[] = [
  [272,"closest-binary-search-tree-value-ii","Closest Binary Search Tree Value II","Hard",61.3,0,0,"Given a BST and a target, return the k values closest to it.",["Two Pointers","Stack","Tree","Binary Search Tree"]],
  [17,"letter-combinations-of-a-phone-number","Letter Combinations of a Phone Number","Medium",66.6,1,0,"Given digits 2–9, return every letter combination the number could spell.",["Hash Table","String","Backtracking"]],
  [20,"valid-parentheses","Valid Parentheses","Easy",44.7,1,0,"Decide whether a string of brackets is validly opened and closed.",["String","Stack"]],
  [277,"find-the-celebrity","Find the Celebrity","Medium",49.1,0,0,"Among n people find the one everyone knows and who knows no one, using knows(a,b).",["Two Pointers","Graph","Interactive"]],
  [53,"maximum-subarray","Maximum Subarray","Medium",53.7,1,0,"Find the contiguous subarray with the largest sum.",["Array","Divide and Conquer","Dynamic Programming"]],
  [339,"nested-list-weight-sum","Nested List Weight Sum","Medium",86.0,0,0,"Sum every integer in a nested list, each multiplied by its depth.",["Stack","Depth-First Search","Breadth-First Search"]],
  [605,"can-place-flowers","Can Place Flowers","Easy",29.3,0,0,"Given a flowerbed and n, decide whether n flowers fit without touching.",["Array","Greedy"]],
  [364,"nested-list-weight-sum-ii","Nested List Weight Sum II","Medium",67.0,0,1,"Like Nested List Weight Sum, but inverted — the deepest level carries weight 1.",["Stack","Depth-First Search","Breadth-First Search"]],
  [366,"find-leaves-of-binary-tree","Find Leaves of Binary Tree","Medium",81.4,0,0,"Repeatedly collect and remove the leaves, returning each layer in turn.",["Tree","Depth-First Search","Binary Tree"]],
  [380,"insert-delete-getrandom-o1","Insert Delete GetRandom O(1)","Medium",55.5,0,0,"Design a set with insert, remove and getRandom all in O(1).",["Array","Hash Table","Math","Design"]],
  [127,"word-ladder","Word Ladder","Hard",46.3,0,0,"Shortest transformation length from beginWord to endWord through the word list.",["Hash Table","String","Breadth-First Search"]],
  [152,"maximum-product-subarray","Maximum Product Subarray","Medium",36.9,1,0,"Find the contiguous subarray with the largest product.",["Array","Dynamic Programming"]],
  [200,"number-of-islands","Number of Islands","Medium",64.9,1,0,"Count the connected groups of '1' in a 2-D grid.",["Array","Depth-First Search","Breadth-First Search","Union Find"]],
  [716,"max-stack","Max Stack","Hard",46.0,0,0,"Design a stack that also supports peekMax and popMax.",["Linked List","Stack","Design","Ordered Set"]],
  [244,"shortest-word-distance-ii","Shortest Word Distance II","Medium",63.0,0,0,"Design a structure answering repeated shortest-distance queries between two words.",["Array","Hash Table","Two Pointers","Design"]],
  [698,"partition-to-k-equal-sum-subsets","Partition to K Equal Sum Subsets","Medium",38.8,0,0,"Decide whether the array splits into k subsets of equal sum.",["Array","Dynamic Programming","Backtracking","Bitmask"]],
  [1004,"max-consecutive-ones-iii","Max Consecutive Ones III","Medium",68.2,0,0,"Longest run of 1s once you may flip at most k zeros.",["Array","Binary Search","Sliding Window","Prefix Sum"]],
  [360,"sort-transformed-array","Sort Transformed Array","Medium",58.3,0,0,"Apply ax²+bx+c across a sorted array and return the result sorted.",["Array","Math","Two Pointers","Sorting"]],
  [319,"bulb-switcher","Bulb Switcher","Medium",56.3,0,1,"After n rounds of toggling, count how many bulbs are left on.",["Math","Brainteaser"]],
  [744,"find-smallest-letter-greater-than-target","Find Smallest Letter Greater Than Target","Easy",59.5,0,0,"Binary-search the next letter greater than target, wrapping around.",["Array","Binary Search"]],
  [104,"maximum-depth-of-binary-tree","Maximum Depth of Binary Tree","Easy",78.5,1,0,"Return the depth of the deepest leaf.",["Tree","Depth-First Search","Breadth-First Search","Binary Tree"]],
  [381,"insert-delete-getrandom-o1-duplicates-allowed","Insert Delete GetRandom O(1) - Duplicates allowed","Hard",36.9,0,0,"As Insert Delete GetRandom, but the collection may hold duplicates.",["Array","Hash Table","Math","Design"]],
  [528,"random-pick-with-weight","Random Pick with Weight","Medium",49.2,0,0,"Pick an index with probability proportional to its weight.",["Math","Binary Search","Prefix Sum","Randomized"]],
  [886,"possible-bipartition","Possible Bipartition","Medium",52.9,1,0,"Split n people into two groups that respect every mutual dislike.",["Depth-First Search","Breadth-First Search","Union Find","Graph"]],
  [827,"making-a-large-island","Making A Large Island","Hard",57.1,0,0,"Flip at most one 0 to 1 and return the largest island you can make.",["Array","Depth-First Search","Breadth-First Search","Union Find"]],
  [146,"lru-cache","LRU Cache","Medium",47.8,1,0,"Design a fixed-capacity cache that evicts the least recently used key.",["Hash Table","Linked List","Design","Doubly-Linked List"]],
  [215,"kth-largest-element-in-an-array","Kth Largest Element in an Array","Medium",69.2,1,0,"Return the kth largest element without fully sorting.",["Array","Divide and Conquer","Sorting","Heap","Quickselect"]],
  [33,"search-in-rotated-sorted-array","Search in Rotated Sorted Array","Medium",45.4,1,0,"Binary-search a sorted array that has been rotated.",["Array","Binary Search"]],
  [65,"valid-number","Valid Number","Hard",23.4,0,0,"Decide whether a string is a valid number under the stated grammar.",["String"]],
  [3,"longest-substring-without-repeating-characters","Longest Substring Without Repeating Characters","Medium",39.7,1,0,"Length of the longest substring whose characters are all distinct.",["Hash Table","String","Sliding Window"]],
  [752,"open-the-lock","Open the Lock","Medium",61.5,0,0,"Fewest moves to reach a target on a 4-wheel lock, avoiding the deadends.",["Array","Hash Table","String","Breadth-First Search"]],
  [994,"rotting-oranges","Rotting Oranges","Medium",59.3,1,0,"Minutes until every fresh orange has rotted, or -1 if one never does.",["Array","Breadth-First Search","Matrix"]],
  [863,"all-nodes-distance-k-in-binary-tree","All Nodes Distance K in Binary Tree","Medium",68.0,1,0,"Every node value exactly k edges away from a target node.",["Hash Table","Tree","Depth-First Search","Breadth-First Search"]],
  [46,"permutations","Permutations","Medium",82.2,1,0,"Return all permutations of a list of distinct integers.",["Array","Backtracking"]],
  [1297,"maximum-number-of-occurrences-of-a-substring","Maximum Number of Occurrences of a Substring","Medium",54.8,0,1,"Max occurrences of any substring that meets the size and unique-letter limits.",["Hash Table","String","Sliding Window"]],
  [3367,"maximize-sum-of-weights-after-edge-removals","Maximize Sum of Weights after Edge Removals","Hard",32.6,0,1,"Remove edges so every node keeps at most k of them, maximising retained weight.",["Tree","Depth-First Search","Greedy","Dynamic Programming"]],
  [56,"merge-intervals","Merge Intervals","Medium",52.5,1,0,"Merge every set of overlapping intervals.",["Array","Sorting"]],
];

function toSet(company: string, label: string, rows: Row[], captured: string): PrepSet {
  const questions: PrepQuestion[] = rows.map((r, i) => ({
    id: r[0],
    slug: r[1],
    title: r[2],
    difficulty: r[3],
    acceptance: r[4],
    rank: i + 1,
    windows: r[6] ? HOT : SIX,
    lcSolved: !!r[5],
    tags: r[8],
    statement: r[7],
  }));
  return {
    company,
    label,
    kind: "company",
    syncedAt: captured,
    sources: [{ repo: "leetcode.com company page (transcribed)", snapshot: captured, windows: HOT }],
    questions,
  };
}

export const SEEDS: Record<string, PrepSet> = {
  linkedin: toSet("linkedin", "LinkedIn", LINKEDIN, "2026-08-11"),
  "top-sql-50": SQL50_SET,
};

/**
 * What LeetCode's own progress card reported for this set. Checked at load so a
 * later hand-edit can't silently drift from the source it was transcribed from.
 */
const EXPECTED = {
  linkedin: { total: 37, solved: 15, Easy: [2, 4], Medium: [13, 26], Hard: [0, 7], hot: 4 },
} as const;

export function prepSeedIntegrity(): string[] {
  const problems: string[] = [...sqlSeedIntegrity()];
  for (const [slug, want] of Object.entries(EXPECTED)) {
    const qs = SEEDS[slug]?.questions ?? [];
    const check = (label: string, got: number, exp: number) => {
      if (got !== exp) problems.push(`${slug}: ${label} is ${got}, expected ${exp}`);
    };
    check("total", qs.length, want.total);
    check("solved", qs.filter((q) => q.lcSolved).length, want.solved);
    check("recent", qs.filter((q) => q.windows.includes("thirty-days")).length, want.hot);
    for (const d of ["Easy", "Medium", "Hard"] as const) {
      const set = qs.filter((q) => q.difficulty === d);
      check(`${d} total`, set.length, want[d][1]);
      check(`${d} solved`, set.filter((q) => q.lcSolved).length, want[d][0]);
    }
  }
  return problems;
}
