import { execFileSync } from "node:child_process";

function sh(args) {
  return execFileSync(args[0], args.slice(1), { encoding: "utf8" }).trim();
}

function hasGit() {
  try {
    sh(["git", "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

if (!hasGit()) process.exit(0);

let repoRoot = "";
try {
  repoRoot = sh(["git", "rev-parse", "--show-toplevel"]);
} catch {
  process.exit(0);
}

let changedFiles = "";
try {
  changedFiles = sh(["git", "-C", repoRoot, "diff", "--name-only", "HEAD"]);
} catch {
  // No HEAD yet (fresh repo) or diff failure; don't block.
  process.exit(0);
}

if (!changedFiles) process.exit(0);

let packageJsonDiff = "";
try {
  packageJsonDiff = sh([
    "git",
    "-C",
    repoRoot,
    "diff",
    "HEAD",
    "--",
    "src/package.json",
  ]);
} catch {
  packageJsonDiff = "";
}

const versionBumped = /"version"\s*:\s*"/.test(packageJsonDiff);

if (!versionBumped) {
  console.error(
    [
      "ERROR: Version not bumped.",
      "Rule: any shipped change => bump `src/package.json` version.",
      "Fix: edit `src/package.json` then rerun `npm run release`.",
    ].join("\n"),
  );
  process.exit(1);
}
