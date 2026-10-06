// teml-action: on a pull request, finds the TEML models it changes, describes the changes with
// `teml diff`, checks them with `teml check`, and posts one comment that it updates on each push.
// Problems also become annotations on the changed lines. Runs on the Node that GitHub's runners
// have; the teml command is downloaded from tools.teml.org.
import fs from "fs";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { pathToFileURL } from "url";

export const MARKER = "<!-- teml-action -->";
const LIMIT = 65000; // GitHub's comment limit is 65,536 characters.

// "**/*.teml.yaml" -> a RegExp for repo-relative paths. ** matches any folders (or none),
// * and ? stay within one folder.
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const matcher = globs => {
  const res = globs.split("\n").map(g => g.trim()).filter(Boolean).map(globToRegExp);
  return file => res.some(r => r.test(file));
};

// `git diff --name-status --no-renames` output -> [{ file, status }] for the files that match.
export const changedFiles = (nameStatus, matches) => nameStatus.split("\n").filter(Boolean)
  .map(l => { const [status, file] = l.split("\t"); return { status: status[0], file }; })
  .filter(f => matches(f.file));

// `teml check` lines "file:12: error E3 where: message" -> problems.
export const parseCheck = out => [...out.matchAll(/^(.+?):(\d+): (error|warning) (\S+) (.*)$/gm)]
  .map(([, file, line, level, code, message]) => ({ file, line: Number(line), level, code, message }));

const esc = s => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
export const annotation = p =>
  `::${p.level} file=${esc(p.file)},line=${p.line},title=${esc(`TEML ${p.code}`)}::${esc(p.message)}`;

export function buildComment({ diffs, problems, sha, version }) {
  const errors = problems.filter(p => p.level === "error").length, warnings = problems.length - errors;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const out = [MARKER, "## TEML model changes", ""];
  if (!diffs.length) out.push("This pull request doesn't change any TEML models.", "");
  for (const d of diffs) out.push(d.trim(), "");
  if (diffs.length) {
    if (!problems.length) out.push("**teml check:** no problems.", "");
    else {
      out.push(`**teml check:** ${[errors && plural(errors, "error"), warnings && plural(warnings, "warning")].filter(Boolean).join(", ")}`, "");
      out.push("```", ...problems.map(p => `${p.file}:${p.line}: ${p.level} ${p.code} ${p.message}`), "```", "");
    }
  }
  out.push(`<sub>For ${sha.slice(0, 7)}, by [teml-action](https://github.com/TEML-Org/teml-action) with ${version}.</sub>`);
  let body = out.join("\n");
  if (body.length > LIMIT) {
    const note = "\n\n_This comment was cut to fit GitHub's limit. The job summary has all of it._";
    body = body.slice(0, LIMIT - note.length) + note;
  }
  return body;
}

// ---- running in a workflow ----

const env = (k, d = "") => process.env[k] ?? d;
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });

async function api(method, url, body) {
  const res = await fetch(`${env("GITHUB_API_URL", "https://api.github.com")}${url}`, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${env("GITHUB_TOKEN")}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) throw Object.assign(new Error(`${method} ${url}: ${res.status} ${await res.text()}`), { status: res.status });
  return res.json();
}

// This action's earlier comment on the PR, if any.
async function findComment(repo, number) {
  for (let page = 1; ; page++) {
    const list = await api("GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    const c = list.find(c => c.user?.type === "Bot" && c.body?.startsWith(MARKER));
    if (c || list.length < 100) return c ?? null;
  }
}

async function main() {
  const event = JSON.parse(fs.readFileSync(env("GITHUB_EVENT_PATH"), "utf8"));
  const pr = event.pull_request;
  if (!pr) { console.log("::warning::teml-action runs on pull_request events; nothing to do."); return; }
  const tmp = env("RUNNER_TEMP", "/tmp"), teml = path.join(tmp, "teml.mjs");

  const res = await fetch(env("TEML_URL"));
  if (!res.ok) throw new Error(`downloading ${env("TEML_URL")}: ${res.status}`);
  fs.writeFileSync(teml, Buffer.from(await res.arrayBuffer()));
  const run = (...args) => spawnSync(process.execPath, [teml, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  const version = run("version").stdout.trim().replace(/, for .*/, "");

  // The checkout is the merge of the PR into its base; compare it with the base commit.
  const base = pr.base.sha;
  git("fetch", "--no-tags", "--quiet", "--depth=1", "origin", base);
  const files = changedFiles(git("diff", "--name-status", "--no-renames", base, "HEAD"), matcher(env("TEML_FILES")));
  console.log(files.length ? `TEML models changed: ${files.map(f => f.file).join(", ")}` : "No TEML models changed.");

  const diffs = [], problems = [];
  for (const { file, status } of files) {
    const before = path.join(tmp, `before-${diffs.length}.teml.yaml`);
    if (status === "A") fs.writeFileSync(before, "");
    else fs.writeFileSync(before, git("show", `${base}:${file}`));
    const after = status === "D" ? "/dev/null" : file;
    diffs.push(run("diff", before, after, "--title", `\`${file}\``).stdout);
    if (status !== "D") problems.push(...parseCheck(run("check", file).stdout));
  }
  for (const p of problems) console.log(annotation(p));

  const body = buildComment({ diffs, problems, sha: pr.head.sha, version });
  if (env("GITHUB_STEP_SUMMARY")) fs.appendFileSync(env("GITHUB_STEP_SUMMARY"), body.replace(MARKER, "") + "\n");
  if (env("TEML_COMMENT") === "true") {
    try {
      const repo = env("GITHUB_REPOSITORY"), existing = await findComment(repo, pr.number);
      if (existing) {
        await api("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
        console.log("Comment updated.");
      } else if (files.length) {
        // A PR that never touched a model gets no comment at all.
        await api("POST", `/repos/${repo}/issues/${pr.number}/comments`, { body });
        console.log("Comment posted.");
      }
    } catch (e) {
      if (e.status === 403 || e.status === 404) console.log("::warning::Could not comment on the pull request (the token can't write to it, as on a PR from a fork). The job summary has the changes.");
      else throw e;
    }
  }
  if (env("TEML_FAIL_ON_ERROR") === "true" && problems.some(p => p.level === "error")) {
    console.log("::error::teml check found errors in the changed models.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e => { console.log(`::error::teml-action: ${e.message}`); process.exitCode = 1; });
