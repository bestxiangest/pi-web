import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseStatusZ, parseLog } = await jiti.import("./git.ts");
const { parseUnifiedDiff } = await jiti.import("./parse-diff.ts");

const FS = "";
const RS = "";

test("parseStatusZ splits staged/unstaged/untracked and renames", () => {
  const raw = [
    "## main...origin/main [ahead 1]",
    "M  src/a.ts",
    " M src/b.ts",
    "A  src/new.ts",
    "?? src/other.ts",
    "R  src/moved.ts",
    "src/orig.ts",
  ].join("\0") + "\0";

  const { branchLine, files } = parseStatusZ(raw);
  assert.equal(branchLine, "main...origin/main [ahead 1]");
  assert.equal(files.length, 5);

  const [a, b, added, untracked, moved] = files;
  assert.equal(a.path, "src/a.ts");
  assert.equal(a.staged, true);
  assert.equal(a.unstaged, false);
  assert.equal(b.code, " M");
  assert.equal(b.staged, false);
  assert.equal(b.unstaged, true);
  assert.equal(added.code, "A ");
  assert.equal(added.staged, true);
  assert.equal(untracked.untracked, true);
  assert.equal(untracked.staged, false);
  assert.equal(moved.oldPath, "src/orig.ts");
  assert.equal(moved.path, "src/moved.ts");
});

test("parseLog splits records and parents, tolerating tformat newlines", () => {
  const raw = "\n" + [
    ["h1", "h1s", "p1 p2", "Alice", "a@x.com", "1700000000", "HEAD -> main, tag: v1", "subject one", "body one"].join(FS),
    ["h2", "h2s", "", "Bob", "b@x.com", "1700000100", "", "root subject", ""].join(FS),
  ].join(RS + "\n") + RS + "\n";

  const commits = parseLog(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[1].hash, "h2");
  assert.deepEqual(commits[0].parentHashes, ["p1", "p2"]);
  assert.deepEqual(commits[0].refs, ["HEAD", "main", "tag: v1"]);
  assert.equal(commits[0].body, "body one");
  assert.deepEqual(commits[1].parentHashes, []);
  assert.equal(commits[1].subject, "root subject");
});

test("parseUnifiedDiff extracts files, hunks, and line numbers", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " context",
    "-old line",
    "+new line",
    "+added",
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 90%",
    "rename from src/old.ts",
    "rename to src/new.ts",
  ].join("\n");

  const blocks = parseUnifiedDiff(patch);
  assert.equal(blocks.length, 2);

  const first = blocks[0];
  assert.equal(first.path, "src/a.ts");
  assert.equal(first.additions, 2);
  assert.equal(first.deletions, 1);
  assert.equal(first.hunks.length, 1);
  assert.deepEqual(
    first.hunks[0].lines.map((line) => line.type),
    ["context", "del", "add", "add"],
  );
  assert.equal(first.hunks[0].lines[1].oldLine, 2);
  assert.equal(first.hunks[0].lines[2].newLine, 2);

  const renamed = blocks[1];
  assert.equal(renamed.oldPath, "src/old.ts");
  assert.equal(renamed.path, "src/new.ts");
  assert.equal(renamed.hunks.length, 0);
});

test("parseUnifiedDiff handles empty and no-newline markers", () => {
  const patch = [
    "diff --git a/f b/f",
    "@@ -1 +1 @@",
    "-a",
    "\\ No newline at end of file",
    "+b",
  ].join("\n");
  const blocks = parseUnifiedDiff(patch);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].hunks[0].lines.length, 3);
  assert.equal(blocks[0].hunks[0].lines[1].type, "context"); // no-newline marker rendered as context
});
