#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_PATH = join(TOOL_DIRECTORY, "bounded_command_supervisor.mjs");
const PS_PATH = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";

const envelope = JSON.parse(readFileSync(0, "utf8"));
const request = envelope.request;
const tokenAssignment = envelope.tokenEnvironmentName + "=" + envelope.token;
const output = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0 };
const trackedPids = new Set();
let supervisor;
let supervisorClosed = false;
let supervisorResult;
let finished = false;
let monitorTimedOut = false;
let outputExceeded = false;
let monitorTimer;
let forceTimer;
let verificationTimer;

function psEnvironment() {
  return { LANG: "C", LC_ALL: "C" };
}

function processSnapshot(arguments_) {
  return spawnSync(PS_PATH, arguments_, {
    detached: process.platform !== "win32",
    encoding: "utf8",
    env: psEnvironment(),
    timeout: Math.min(1_000, Math.max(500, request.terminationGrace)),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function markedProcesses() {
  if (process.platform === "win32") return new Map();
  if (process.platform === "linux") return linuxMarkedProcesses();
  const arguments_ = process.platform === "darwin"
    ? ["-E", "-ww", "-axo", "pid=,lstart=,command="]
    : ["eww", "-eo", "pid=,lstart=,args="];
  const snapshot = processSnapshot(arguments_);
  if (snapshot.error || snapshot.status !== 0 || typeof snapshot.stdout !== "string") {
    return null;
  }
  const matches = new Map();
  let rowCount = 0;
  for (const line of snapshot.stdout.split(/\r?\n/u)) {
    if (!line.includes(tokenAssignment)) continue;
    rowCount += 1;
    if (rowCount > 131_072) return null;
    const match = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+.*$/u.exec(line);
    if (match === null) return null;
    const pid = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return null;
    const identity = processIdentity(pid, match[2].replace(/\s+/gu, " "));
    if (identity === null) return null;
    matches.set(pid, identity);
  }
  return matches;
}

function linuxMarkedProcesses() {
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.length > 131_072) return null;
  const matches = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number.parseInt(entry.name, 10);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
    const startBefore = linuxProcessStart(pid);
    if (startBefore === null) continue;
    let environment;
    try {
      environment = readFileSync(`/proc/${pid}/environ`);
    } catch {
      continue;
    }
    const startAfter = linuxProcessStart(pid);
    if (startAfter === null || startAfter !== startBefore) continue;
    const assignments = environment.toString("utf8").split("\0");
    if (!assignments.includes(tokenAssignment)) continue;
    matches.set(pid, `linux:${startBefore}`);
  }
  return matches;
}

function currentProcessStart(pid) {
  if (process.platform === "win32") return null;
  const snapshot = processSnapshot(["-p", String(pid), "-o", "lstart="]);
  if (snapshot.error || snapshot.status !== 0 || typeof snapshot.stdout !== "string") {
    return null;
  }
  const value = snapshot.stdout.trim().replace(/\s+/gu, " ");
  return value.length === 0 ? null : value;
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

function currentProcessIdentity(pid) {
  if (process.platform === "linux") {
    const startTicks = linuxProcessStart(pid);
    return startTicks === null ? null : `linux:${startTicks}`;
  }
  return currentProcessStart(pid);
}

function signalMarkedProcesses(signal) {
  const processes = markedProcesses();
  if (processes === null) return false;
  for (const [pid, startedAt] of [...processes.entries()].reverse()) {
    trackedPids.add(pid);
    if (currentProcessIdentity(pid) !== startedAt) continue;
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") return false;
    }
  }
  return true;
}

function terminateSupervisor(signal) {
  if (!supervisor?.pid || supervisorClosed) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(supervisor.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-supervisor.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try { supervisor.kill(signal); } catch {}
    }
  }
}

function emit(result) {
  if (finished) return;
  finished = true;
  clearTimeout(monitorTimer);
  clearTimeout(forceTimer);
  clearTimeout(verificationTimer);
  process.stdout.write(JSON.stringify(result));
}

function failureResult(message) {
  return {
    code: null,
    signal: null,
    spawnError: message,
    timedOut: monitorTimedOut,
    outputExceeded,
    descendantsRemained: false,
    descendantTrackingComplete: false,
    trackedPidCount: trackedPids.size,
    trackedSurvivorCount: 0,
    stdout: "",
    stderr: "",
  };
}

function parseSupervisorResult() {
  if (supervisorResult?.error !== undefined) {
    return failureResult(supervisorResult.error);
  }
  try {
    return JSON.parse(Buffer.concat(output.stdout).toString("utf8"));
  } catch {
    return failureResult("command supervisor returned invalid output");
  }
}

function finishAfterCleanup(result) {
  const lingering = markedProcesses();
  if (lingering === null) {
    emit({
      ...result,
      spawnError: result.spawnError ?? "command descendant attribution failed",
      descendantTrackingComplete: false,
    });
    return;
  }
  if (lingering.size === 0) {
    emit({
      ...result,
      timedOut: result.timedOut === true || monitorTimedOut,
      outputExceeded: result.outputExceeded === true || outputExceeded,
      trackedPidCount: Math.max(result.trackedPidCount ?? 0, trackedPids.size),
      trackedSurvivorCount: 0,
    });
    return;
  }
  for (const pid of lingering.keys()) trackedPids.add(pid);
  const updated = {
    ...result,
    timedOut: result.timedOut === true || monitorTimedOut,
    outputExceeded: result.outputExceeded === true || outputExceeded,
    descendantsRemained: true,
    trackedPidCount: Math.max(result.trackedPidCount ?? 0, trackedPids.size),
  };
  if (!signalMarkedProcesses("SIGTERM")) {
    updated.descendantTrackingComplete = false;
  }
  forceTimer = setTimeout(() => {
    if (!signalMarkedProcesses("SIGKILL")) {
      updated.descendantTrackingComplete = false;
    }
    verificationTimer = setTimeout(() => {
      const survivors = markedProcesses();
      if (survivors === null) {
        emit({
          ...updated,
          spawnError: updated.spawnError ?? "command descendant verification failed",
          descendantTrackingComplete: false,
          trackedSurvivorCount: -1,
        });
        return;
      }
      emit({
        ...updated,
        descendantTrackingComplete:
          updated.descendantTrackingComplete === true && survivors.size === 0,
        trackedPidCount: Math.max(updated.trackedPidCount, trackedPids.size),
        trackedSurvivorCount: survivors.size,
      });
    }, 50);
  }, request.terminationGrace);
}

function settleAndFinish(result, supervisorFailed) {
  const initial = markedProcesses();
  if (initial === null || initial.size === 0) {
    finishAfterCleanup(result);
    return;
  }
  const settleDelay = supervisorFailed
    ? 0
    : Math.min(request.terminationGrace, 250);
  setTimeout(() => finishAfterCleanup(result), settleDelay);
}

function retain(streamName, chunk) {
  const bytes = Buffer.from(chunk);
  const byteName = streamName + "Bytes";
  output[byteName] += bytes.length;
  if (output.stdoutBytes + output.stderrBytes > Math.max(1024 * 1024, request.maxBuffer * 2)) {
    outputExceeded = true;
    terminateSupervisor("SIGTERM");
    signalMarkedProcesses("SIGTERM");
    return;
  }
  output[streamName].push(bytes);
}

try {
  supervisor = spawn(
    process.execPath,
    [SUPERVISOR_PATH],
    {
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
} catch (error) {
  emit(failureResult(error?.message ?? String(error)));
  process.exit(0);
}

supervisor.stdin.on("error", () => {});
supervisor.stdin.end(Buffer.from(JSON.stringify(request)));
supervisor.stdout.on("data", (chunk) => retain("stdout", chunk));
supervisor.stderr.on("data", (chunk) => retain("stderr", chunk));
supervisor.on("error", (error) => {
  supervisorResult = { error: error?.message ?? String(error) };
});
supervisor.on("close", (code, signal) => {
  supervisorClosed = true;
  supervisorResult ??= code === 0 && signal === null
    ? { code, signal }
    : { error: "command supervisor terminated before cleanup completed" };
  settleAndFinish(parseSupervisorResult(), supervisorResult.error !== undefined);
});

monitorTimer = setTimeout(() => {
  monitorTimedOut = true;
  terminateSupervisor("SIGTERM");
  signalMarkedProcesses("SIGTERM");
  forceTimer = setTimeout(() => {
    terminateSupervisor("SIGKILL");
    signalMarkedProcesses("SIGKILL");
  }, request.terminationGrace);
}, request.timeout + request.terminationGrace + request.hardFallback + 500);
