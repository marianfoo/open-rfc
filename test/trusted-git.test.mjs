import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveTrustedGitPath,
  runTrustedGit,
} from "../tools/trusted_git.mjs";

test("trusted Git ignores PATH, repository redirection, and local executable hooks", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "open-rfc-trusted-git-"));
  try {
    const git = resolveTrustedGitPath();
    writeFileSync(join(root, "tracked.txt"), "fixture\n");
    execFileSync(git, ["init", "-q"], { cwd: root });
    execFileSync(git, ["config", "user.email", "fixture@example.invalid"], { cwd: root });
    execFileSync(git, ["config", "user.name", "Fixture"], { cwd: root });
    execFileSync(git, ["add", "tracked.txt"], { cwd: root });
    execFileSync(git, ["commit", "-q", "-m", "fixture"], { cwd: root });

    const marker = join(root, "fsmonitor-ran");
    const monitor = join(root, "fsmonitor.sh");
    writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\nprintf '{}\\n'\n`);
    chmodSync(monitor, 0o700);
    execFileSync(git, ["config", "core.fsmonitor", monitor], { cwd: root });

    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin);
    const fakeGit = join(fakeBin, "git");
    writeFileSync(fakeGit, "#!/bin/sh\ntouch fake-git-ran\nexit 99\n");
    chmodSync(fakeGit, 0o700);

    const originalCoverageDirectory = process.env.NODE_V8_COVERAGE;
    process.env.NODE_V8_COVERAGE = join(root, "coverage-output");
    let status;
    try {
      status = runTrustedGit(
        root,
        ["status", "--porcelain=v1", "--untracked-files=no"],
        {
          environment: {
            ...process.env,
            PATH: fakeBin,
            GIT_DIR: join(root, "redirected.git"),
            GIT_WORK_TREE: join(root, "redirected-worktree"),
          },
        },
      );
    } finally {
      if (originalCoverageDirectory === undefined) {
        delete process.env.NODE_V8_COVERAGE;
      } else {
        process.env.NODE_V8_COVERAGE = originalCoverageDirectory;
      }
    }
    assert.equal(status, "");
    assert.equal(existsSync(join(root, "fake-git-ran")), false);
    assert.equal(existsSync(marker), false);

    const committedBlob = execFileSync(
      git,
      ["-C", root, "rev-parse", "HEAD:tracked.txt"],
      { encoding: "utf8" },
    ).trim();
    const replacementBlob = execFileSync(
      git,
      ["-C", root, "hash-object", "-w", "--stdin"],
      { encoding: "utf8", input: "replacement fixture\n" },
    ).trim();
    execFileSync(git, ["-C", root, "replace", committedBlob, replacementBlob]);
    assert.equal(
      runTrustedGit(root, ["cat-file", "blob", committedBlob]),
      "fixture\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
