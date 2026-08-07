#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const request = JSON.parse(readFileSync(0, "utf8"));
const PS_PATH = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
const output = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0 };
const trackedPids = new Set();
let child;
let finished = false;
let timedOut = false;
let outputExceeded = false;
let descendantsRemained = false;
let terminationStarted = false;
let descendantTrackingComplete = process.platform === "win32";
let descendantTrackingFailed = false;
let childClosed = false;
let childResult;
let timeoutTimer;
let forceTimer;
let hardTimer;
let verificationTimer;

function encode(chunks) {
  return Buffer.concat(chunks).toString("base64");
}

function psEnvironment() {
  return { LANG: "C", LC_ALL: "C" };
}

function linuxProcessStart(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 1).trim().split(/\s+/u);
    const startTicks = fields[19];
    return /^\d+$/u.test(startTicks ?? "") ? startTicks : null;
  } catch {
    return null;
  }
}

function processIdentity(pid, portableStart) {
  if (process.platform !== "linux") return portableStart;
  const startTicks = linuxProcessStart(pid);
  return startTicks === null ? null : `linux:${startTicks}`;
}

function parseProcessGroupRow(row) {
  const value = row.trim().replace(/\s+/gu, " ");
  const match = /^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/u.exec(value);
  if (match === null) return null;
  const processGroup = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(processGroup)
    ? { processGroup, portableStart: match[2] }
    : null;
}

function currentProcessGroupIdentity(pid) {
  const snapshot = spawnSync(
    PS_PATH,
    ["-p", String(pid), "-o", "pgid=,lstart="],
    {
      detached: true,
      encoding: "utf8",
      env: psEnvironment(),
      timeout: Math.min(1_000, Math.max(500, request.terminationGrace)),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  if (snapshot.status === 1 && !snapshot.error) return { absent: true };
  if (snapshot.error || snapshot.status !== 0 || typeof snapshot.stdout !== "string") {
    return null;
  }
  const parsed = parseProcessGroupRow(snapshot.stdout);
  if (parsed === null) return snapshot.stdout.trim().length === 0 ? { absent: true } : null;
  const identity = processIdentity(pid, parsed.portableStart);
  return identity === null
    ? null
    : { absent: false, identity, processGroup: parsed.processGroup };
}

function ownedProcessGroupMembers() {
  if (process.platform === "win32") return new Map();
  const snapshot = spawnSync(PS_PATH, ["-axo", "pid=,pgid=,lstart="], {
    detached: true,
    encoding: "utf8",
    env: psEnvironment(),
    timeout: Math.min(1_000, Math.max(500, request.terminationGrace)),
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (snapshot.error || snapshot.status !== 0 || typeof snapshot.stdout !== "string") {
    descendantTrackingFailed = true;
    descendantTrackingComplete = false;
    return null;
  }
  const members = new Map();
  let rowCount = 0;
  for (const line of snapshot.stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    rowCount += 1;
    if (rowCount > 131_072) {
      descendantTrackingFailed = true;
      descendantTrackingComplete = false;
      return null;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/u.exec(line);
    if (match === null) {
      descendantTrackingFailed = true;
      descendantTrackingComplete = false;
      return null;
    }
    const pid = Number.parseInt(match[1], 10);
    const processGroup = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(processGroup)) {
      descendantTrackingFailed = true;
      descendantTrackingComplete = false;
      return null;
    }
    if (processGroup === process.pid && pid !== process.pid) {
      const identity = processIdentity(pid, match[3].replace(/\s+/gu, " "));
      if (identity === null) {
        descendantTrackingFailed = true;
        descendantTrackingComplete = false;
        return null;
      }
      members.set(pid, identity);
    }
  }
  return members;
}

function report(result) {
  if (finished) return;
  const currentMembers = ownedProcessGroupMembers();
  const trackedSurvivorCount = currentMembers === null ? -1 : currentMembers.size;
  finished = true;
  clearTimeout(timeoutTimer);
  clearTimeout(forceTimer);
  clearTimeout(hardTimer);
  clearTimeout(verificationTimer);
  process.stdout.write(JSON.stringify({
    ...result,
    timedOut,
    outputExceeded,
    descendantsRemained,
    descendantTrackingComplete,
    trackedPidCount: trackedPids.size,
    trackedSurvivorCount,
    stdout: encode(output.stdout),
    stderr: encode(output.stderr),
  }));
}

function snapshotPosixDescendants() {
  if (process.platform === "win32" || !child?.pid || childResult !== undefined) return;
  const snapshot = spawnSync(PS_PATH, ["-axo", "pid=,ppid="], {
    detached: true,
    encoding: "utf8",
    env: psEnvironment(),
    timeout: Math.min(1_000, Math.max(500, request.terminationGrace)),
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (snapshot.error || snapshot.status !== 0 || typeof snapshot.stdout !== "string") {
    descendantTrackingFailed = true;
    descendantTrackingComplete = false;
    return;
  }
  const childrenByParent = new Map();
  let rowCount = 0;
  for (const line of snapshot.stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    rowCount += 1;
    if (rowCount > 131_072) {
      descendantTrackingFailed = true;
      descendantTrackingComplete = false;
      return;
    }
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (match === null) {
      descendantTrackingFailed = true;
      descendantTrackingComplete = false;
      return;
    }
    const pid = Number.parseInt(match[1], 10);
    const parentPid = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) {
      descendantTrackingFailed = true;
      descendantTrackingComplete = false;
      return;
    }
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  const pending = [child.pid];
  const visited = new Set();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (visited.has(pid) || pid <= 1 || pid === process.pid) continue;
    visited.add(pid);
    trackedPids.add(pid);
    for (const descendant of childrenByParent.get(pid) ?? []) {
      pending.push(descendant);
    }
    if (visited.size > 131_072) {
      descendantTrackingFailed = true;
      descendantTrackingComplete = false;
      return;
    }
  }
  descendantTrackingComplete = !descendantTrackingFailed;
}

function snapshotOwnedProcessGroupMembers() {
  const members = ownedProcessGroupMembers();
  if (members === null) return;
  for (const pid of members.keys()) trackedPids.add(pid);
  descendantTrackingComplete = !descendantTrackingFailed;
}

function signalOwnedProcessGroupMembers(signal) {
  const members = ownedProcessGroupMembers();
  if (members === null) return;
  for (const [pid, identity] of [...members.entries()].reverse()) {
    if (pid <= 1 || pid === process.pid) continue;
    trackedPids.add(pid);
    const current = currentProcessGroupIdentity(pid);
    if (current?.absent === true) continue;
    if (
      current === null ||
      current.identity !== identity ||
      current.processGroup !== process.pid
    ) {
      if (current === null) {
        descendantTrackingFailed = true;
        descendantTrackingComplete = false;
      }
      continue;
    }
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        descendantTrackingFailed = true;
        descendantTrackingComplete = false;
      }
    }
  }
}

function processGroupHasDescendants() {
  if (process.platform === "win32" || !child?.pid) return false;
  const members = ownedProcessGroupMembers();
  if (members === null) return true;
  return [...members.keys()].some((pid) => pid !== child.pid);
}

function terminateTree(signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const terminated = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (terminated.error || terminated.status !== 0) descendantTrackingComplete = false;
    return;
  }
  snapshotPosixDescendants();
  snapshotOwnedProcessGroupMembers();
  if (!childClosed) {
    try { child.kill(signal); } catch {}
  }
  signalOwnedProcessGroupMembers(signal);
}

function reportCompletedTermination() {
  if (!terminationStarted || !childClosed || processGroupHasDescendants()) return;
  report(childResult ?? {
    code: null,
    signal: "TRACKED_DESCENDANT_TERMINATION_ATTEMPTED",
    spawnError: null,
  });
}

function beginTermination(reason) {
  if (reason === "timeout") timedOut = true;
  if (reason === "output") outputExceeded = true;
  if (terminationStarted) return;
  terminationStarted = true;
  terminateTree("SIGTERM");
  forceTimer = setTimeout(() => {
    terminateTree("SIGKILL");
    verificationTimer = setTimeout(reportCompletedTermination, 50);
  }, request.terminationGrace);
  hardTimer = setTimeout(() => {
    terminateTree("SIGKILL");
    report({ code: null, signal: "SUPERVISOR_HARD_FALLBACK", spawnError: null });
    process.exit(0);
  }, request.terminationGrace + request.hardFallback);
}

function retain(streamName, chunk) {
  const bytes = Buffer.from(chunk);
  const byteName = streamName + "Bytes";
  output[byteName] += bytes.length;
  if (output.stdoutBytes + output.stderrBytes > request.maxBuffer) {
    beginTermination("output");
    return;
  }
  output[streamName].push(bytes);
}

try {
  child = spawn(request.command, request.arguments, {
    cwd: request.cwd,
    detached: false,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
} catch (error) {
  report({ spawnError: error?.message ?? String(error), code: null, signal: null });
  process.exit(0);
}

child.stdin.on("error", () => {});
child.stdin.end(Buffer.from(request.stdin, "base64"));
child.stdout.on("data", (chunk) => retain("stdout", chunk));
child.stderr.on("data", (chunk) => retain("stderr", chunk));
child.on("error", (error) => {
  report({ spawnError: error?.message ?? String(error), code: null, signal: null });
});
child.on("exit", (code, signal) => {
  childResult = { code, signal, spawnError: null };
});
child.on("close", (code, signal) => {
  childClosed = true;
  childResult ??= { code, signal, spawnError: null };
  if (terminationStarted) {
    reportCompletedTermination();
  } else if (process.platform !== "win32" && processGroupHasDescendants()) {
    descendantsRemained = true;
    beginTermination("descendants");
  } else {
    report(childResult);
  }
});

timeoutTimer = setTimeout(() => {
  beginTermination("timeout");
}, request.timeout);
