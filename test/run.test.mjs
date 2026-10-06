// Tests for the parts of run.mjs that don't need GitHub. Run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matcher, changedFiles, parseCheck, annotation, buildComment, MARKER, includeOf, partsOf, modelsToReport } from "../run.mjs";

test("globs match repo-relative paths", () => {
  const m = matcher("**/*.teml.yaml");
  assert.ok(m("hotel.teml.yaml"));
  assert.ok(m("models/booking/hotel.teml.yaml"));
  assert.ok(!m("hotel.yaml"));
  assert.ok(!m("hotel.teml.yaml.bak"));
  const two = matcher("models/*.yaml\n  docs/**  \n");
  assert.ok(two("models/a.yaml"));
  assert.ok(!two("models/sub/a.yaml"));
  assert.ok(two("docs/a/b/c.md"));
  assert.ok(globToRegExp("a.b?").test("a.bc"));
  assert.ok(!globToRegExp("a.b?").test("axbc"));
});

test("changed files keep their status and only the matching ones", () => {
  const out = "M\tmodels/hotel.teml.yaml\nA\tnew.teml.yaml\nD\told.teml.yaml\nM\tREADME.md\n";
  assert.deepEqual(changedFiles(out, matcher("**/*.teml.yaml")), [
    { status: "M", file: "models/hotel.teml.yaml" }, { status: "A", file: "new.teml.yaml" }, { status: "D", file: "old.teml.yaml" },
  ]);
});

test("teml check output becomes problems and annotations", () => {
  const out = "m.teml.yaml:18: error E3 slices.AddRoom.agg: no aggs entry named Nope\nm.teml.yaml:9: warning W2 aggs.Room: never referenced\nm.teml.yaml (compliant): 1 errors, 1 warnings\n";
  const ps = parseCheck(out);
  assert.deepEqual(ps, [
    { file: "m.teml.yaml", line: 18, level: "error", code: "E3", message: "slices.AddRoom.agg: no aggs entry named Nope" },
    { file: "m.teml.yaml", line: 9, level: "warning", code: "W2", message: "aggs.Room: never referenced" },
  ]);
  assert.equal(annotation(ps[0]), "::error file=m.teml.yaml,line=18,title=TEML E3::slices.AddRoom.agg: no aggs entry named Nope");
  assert.equal(annotation({ ...ps[1], message: "50% done\nnext" }), "::warning file=m.teml.yaml,line=9,title=TEML W2::50%25 done%0Anext");
});

test("the comment starts with the marker and lists diffs and problems", () => {
  const body = buildComment({ diffs: ["### `a.teml.yaml`\n\nNo changes to the model.\n"], problems: parseCheck("a.teml.yaml:3: error E3 x: y\n"), sha: "abcdef1234", version: "teml 66b1ae4" });
  assert.ok(body.startsWith(MARKER + "\n## TEML model changes"));
  assert.match(body, /### `a\.teml\.yaml`/);
  assert.match(body, /\*\*teml check:\*\* 1 error\n/);
  assert.match(body, /a\.teml\.yaml:3: error E3 x: y/);
  assert.match(body, /For abcdef1, by \[teml-action\]/);
  assert.match(buildComment({ diffs: ["x"], problems: [], sha: "a", version: "v" }), /no problems/);
  assert.match(buildComment({ diffs: [], problems: [], sha: "a", version: "v" }), /doesn't change any TEML models/);
});

test("a comment over GitHub's limit is cut with a note", () => {
  const body = buildComment({ diffs: ["x".repeat(70000)], problems: [], sha: "a", version: "v" });
  assert.ok(body.length <= 65000);
  assert.match(body, /cut to fit GitHub's limit/);
});

test("include lists are found in block and flow style", () => {
  assert.deepEqual(includeOf("apiVersion: x\ninclude:\n  - a.teml.yaml   # first\n\n  # comment\n  - \"sub/b.teml.yaml\"\ntypes: []\n"), ["a.teml.yaml", "sub/b.teml.yaml"]);
  assert.deepEqual(includeOf("include:\n- a.yaml\n- b.yaml\n"), ["a.yaml", "b.yaml"]);
  assert.deepEqual(includeOf("include: [a.yaml, 'b.yaml'] # parts\n"), ["a.yaml", "b.yaml"]);
  assert.deepEqual(includeOf("slices: []\n  include:\n    - nested.yaml\n"), []);
  assert.deepEqual(partsOf("models/hotel.teml.yaml", "include:\n  - parts/a.yaml\n"), ["models/parts/a.yaml"]);
  assert.deepEqual(partsOf("hotel.teml.yaml", "include: [a.yaml]"), ["a.yaml"]);
});

test("a changed part is reported under its root, never on its own", () => {
  const m = matcher("**/*.teml.yaml");
  const includes = new Map([["m/hotel.teml.yaml", ["m/booking.teml.yaml", "m/stay.teml.yaml"]]]);
  const report = changes => modelsToReport(changes, includes, m);
  assert.deepEqual(report([{ status: "M", file: "m/booking.teml.yaml" }, { status: "M", file: "m/stay.teml.yaml" }]), [{ file: "m/hotel.teml.yaml", status: "M" }]);
  // The root's own status wins, whichever comes first.
  assert.deepEqual(report([{ status: "A", file: "m/booking.teml.yaml" }, { status: "A", file: "m/hotel.teml.yaml" }]), [{ file: "m/hotel.teml.yaml", status: "A" }]);
  assert.deepEqual(report([{ status: "M", file: "other.teml.yaml" }, { status: "M", file: "README.md" }]), [{ file: "other.teml.yaml", status: "M" }]);
  // A part need not match the glob.
  assert.deepEqual(modelsToReport([{ status: "M", file: "m/x.yaml" }], new Map([["m/r.teml.yaml", ["m/x.yaml"]]]), m), [{ file: "m/r.teml.yaml", status: "M" }]);
});
