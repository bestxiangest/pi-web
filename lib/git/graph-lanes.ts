/**
 * Pure lane assignment for the commit graph (no React — unit-testable).
 *
 * `occupied` maps lane → the hash that lane expects next. A commit claims the
 * lowest lane expecting it; extra expecting lanes converge into the node. The
 * first parent continues on the node's lane; extra parents fan out to free
 * lanes. `hasIncoming` tells the renderer to draw a stem from the row's top
 * down to the node — without it every node floats below its incoming line.
 */
import type { GitCommit } from "./types";

export type GraphRow = {
  commit: GitCommit;
  nodeLane: number;
  /** True when a lane above expects this commit — the node needs a stem from y=0. */
  hasIncoming: boolean;
  /** Lanes above converging into this node (second+ parents already reached). */
  convergeLanes: number[];
  /** Straight lanes crossing this row without touching the node. */
  passThrough: number[];
  /** Outgoing edges from the node down to the next row's lanes. */
  edges: number[];
};

export function assignLanes(commits: GitCommit[]): { rows: GraphRow[]; laneCount: number } {
  const occupied = new Map<number, string>();
  const rows: GraphRow[] = [];

  const freeLane = (): number => {
    let lane = 0;
    while (occupied.has(lane)) lane += 1;
    return lane;
  };

  for (const commit of commits) {
    const incoming = [...occupied.entries()]
      .filter(([, hash]) => hash === commit.hash)
      .map(([lane]) => lane)
      .sort((a, b) => a - b);
    const nodeLane = incoming.length > 0 ? incoming[0] : freeLane();
    const convergeLanes = incoming.filter((lane) => lane !== nodeLane);
    const passThrough = [...occupied.keys()].filter(
      (lane) => occupied.get(lane) !== commit.hash && lane !== nodeLane,
    );

    for (const lane of incoming) occupied.delete(lane);

    const edges: number[] = [];
    const parents = commit.parentHashes;
    if (parents.length > 0) {
      occupied.set(nodeLane, parents[0]);
      edges.push(nodeLane);
      for (const parent of parents.slice(1)) {
        const lane = freeLane();
        occupied.set(lane, parent);
        edges.push(lane);
      }
    }

    rows.push({ commit, nodeLane, hasIncoming: incoming.length > 0, convergeLanes, passThrough, edges });
  }

  let laneCount = 0;
  for (const row of rows) {
    laneCount = Math.max(laneCount, row.nodeLane, ...row.passThrough, ...row.convergeLanes, ...row.edges);
  }
  return { rows, laneCount: Math.min(laneCount + 1, 8) };
}
