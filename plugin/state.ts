import fs from "node:fs";
import path from "node:path";
import type { RelayConfig } from "./config.js";

export interface SessionState {
  project_id: string;
  project_name: string;
  workdir: string;
  worktree_branch: string;
}

/** Strip non-alphanumeric characters from a sessionID */
export function sanitizeSessionID(sessionID: string): string {
  return sessionID.replace(/[^A-Za-z0-9]/g, "");
}

/** Session short id: first 8 chars after stripping non-alphanumerics, used for worktree dir and branch naming */
export function shortSessionID(sessionID: string): string {
  return sanitizeSessionID(sessionID).slice(0, 8);
}

function stateFilePath(config: RelayConfig, sessionID: string): string {
  const safe = sanitizeSessionID(sessionID);
  return path.join(config.paths.state_dir, `${safe || "unknown"}.json`);
}

function isSessionState(v: unknown): v is SessionState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.project_id === "string" &&
    typeof s.project_name === "string" &&
    typeof s.workdir === "string" &&
    typeof s.worktree_branch === "string"
  );
}

/** Read session state; returns null when the file is missing or malformed */
export function readSessionState(config: RelayConfig, sessionID: string): SessionState | null {
  const file = stateFilePath(config, sessionID);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isSessionState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Write session state, returns the state file path */
export function writeSessionState(
  config: RelayConfig,
  sessionID: string,
  state: SessionState,
): string {
  const file = stateFilePath(config, sessionID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return file;
}

/** Delete session state, returns whether the file was actually removed */
export function removeSessionState(config: RelayConfig, sessionID: string): boolean {
  const file = stateFilePath(config, sessionID);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
