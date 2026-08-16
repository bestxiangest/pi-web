import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { assignLanes } = await jiti.import("./graph-lanes.ts");

function commit(hash, parents, subject = hash) {
  return {
    hash, shortHash: hash.slice(0, 7), parentHashes: parents,
    authorName: "A", authorEmail: "a@x.com", timestamp: 1,
    refs: [], subject, body: "",
  };
}

test("linear history connects: every non-tip node has an incoming stem", () => {
  const { rows, laneCount } = assignLanes([commit("M", ["B"]), commit("B", ["C"]), commit("C", [])]);
  assert.equal(laneCount, 1);
  assert.equal(rows[0].hasIncoming, false); // branch tip
  assert.equal(rows[1].hasIncoming, true);  // stem from row above reaches the node
  assert.equal(rows[1].nodeLane, 0);
  assert.deepEqual(rows[0].edges, [0]);     // tip's edge lands on the next row's top
});

test("merge fans out to two lanes and converges back with a curve", () => {
  // M merges A and B; both A and B have parent C.
  const { rows, laneCount } = assignLanes([
    commit("M", ["A", "B"]),
    commit("A", ["C"]),
    commit("B", ["C"]),
    commit("C", []),
  ]);
  assert.equal(laneCount, 2);

  const [m, a, b, c] = rows;
  // M: node on lane 0, fans out to lanes 0 and 1
  assert.equal(m.nodeLane, 0);
  assert.deepEqual(m.edges, [0, 1]);
  assert.equal(m.hasIncoming, false);

  // A: stays on lane 0; B's lane passes straight through
  assert.equal(a.nodeLane, 0);
  assert.deepEqual(a.passThrough, [1]);
  assert.equal(a.hasIncoming, true);

  // B: on lane 1; C's lane passes through
  assert.equal(b.nodeLane, 1);
  assert.deepEqual(b.passThrough, [0]);
  assert.equal(b.hasIncoming, true);

  // C: node takes lane 0; lane 1 converges into it with a curve (no dangling)
  assert.equal(c.nodeLane, 0);
  assert.deepEqual(c.convergeLanes, [1]);
  assert.deepEqual(c.passThrough, []);
  assert.equal(c.hasIncoming, true);
  assert.deepEqual(c.edges, []);
});

test("a parent already displayed on another lane converges into the lowest lane", () => {
  // Diamond: M's parents A and B both point at C, and C also reachable
  // through an earlier fan-out (occupied twice).
  const { rows } = assignLanes([
    commit("M", ["A", "B"]),
    commit("A", ["C"]),
    commit("B", ["C"]),
    commit("C", ["D"]),
    commit("D", []),
  ]);
  const c = rows[3];
  assert.equal(c.nodeLane, 0);
  assert.deepEqual(c.convergeLanes, [1]);
});

test("fresh branch tip without incoming opens a new lane without a stem", () => {
  const { rows } = assignLanes([commit("X", ["Y"]), commit("Y", [])]);
  assert.equal(rows[0].hasIncoming, false);
  assert.equal(rows[0].nodeLane, 0);
  assert.equal(rows[1].hasIncoming, true);
});
