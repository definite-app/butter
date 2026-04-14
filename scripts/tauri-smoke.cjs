#!/usr/bin/env node
/*
  Smoke test: ensure Tauri dev stack boots (Vite + backend) without compile/runtime errors.
  Exits 0 once both Vite and backend are up, otherwise exits non-zero.
*/

const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tauriDir = path.join(root, "src-tauri");

const TIMEOUT_MS = 60000;
const start = Date.now();

let sawVite = false;
let sawBackend = false;
let sawError = false;

const child = spawn("cargo", ["tauri", "dev"], {
  cwd: tauriDir,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
});

const fail = (msg) => {
  if (sawError) return;
  sawError = true;
  console.error(`[tauri-smoke] ${msg}`);
  try {
    child.kill("SIGTERM");
  } catch {}
  process.exit(1);
};

const succeed = () => {
  console.log("[tauri-smoke] Vite + backend started successfully.");
  try {
    child.kill("SIGTERM");
  } catch {}
  process.exit(0);
};

const onLine = (line) => {
  if (line.includes("Port 5155 is already in use")) {
    fail("Vite dev server port 5155 already in use.");
  }
  if (line.includes("Address already in use") && line.includes("9876")) {
    fail("Agent API server port 9876 already in use.");
  }
  if (line.includes("error TS") || line.includes("Failed to compile") || line.includes("error when starting dev server")) {
    fail("TypeScript/Vite error during dev startup.");
  }
  if (line.includes("VITE") && line.includes("ready")) {
    sawVite = true;
  }
  if (line.includes("Running `target/debug/butter`")) {
    sawBackend = true;
  }
  if (sawVite && sawBackend) {
    succeed();
  }
};

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (data) => {
  data.split(/\r?\n/).forEach((line) => line && onLine(line));
});
child.stderr.on("data", (data) => {
  data.split(/\r?\n/).forEach((line) => line && onLine(line));
});

child.on("error", (err) => fail(err.message));
child.on("exit", (code) => {
  if (sawError) return;
  if (code !== 0) {
    fail(`cargo tauri dev exited with code ${code}`);
  }
});

setTimeout(() => {
  if (!sawVite || !sawBackend) {
    fail("Timed out waiting for Vite and backend to start.");
  }
}, TIMEOUT_MS);

process.on("SIGINT", () => {
  try {
    child.kill("SIGTERM");
  } catch {}
  process.exit(1);
});
