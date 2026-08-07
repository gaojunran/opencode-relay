import fs from "node:fs";
import path from "node:path";
import type { RelayConfig } from "./config.js";

export interface SessionState {
  project_id: string;
  project_name: string;
  workdir: string;
  worktree_branch: string;
  env: Record<string, string>;
}

/** Strip non-alphanumeric characters from a sessionID */
export function sanitizeSessionID(sessionID: string): string {
  return sessionID.replace(/[^A-Za-z0-9]/g, "");
}

/** Session identifier used for worktree dir and branch naming: the full sanitized sessionID.
 *  Earlier versions truncated to the first 8 chars, which collided because opencode sessionIDs
 *  share a timestamp prefix within a window (e.g. ses_0232c2a85... vs ses_0232c9d87...), letting
 *  two sessions share one worktree/branch. The full id is globally unique. */
export function worktreeSessionID(sessionID: string): string {
  return sanitizeSessionID(sessionID);
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

/** Normalize a parsed state (old states predate the env field) */
export function normalizeState(s: SessionState): SessionState {
  return { ...s, env: typeof s.env === "object" && s.env !== null ? s.env : {} };
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
    return isSessionState(parsed) ? normalizeState(parsed) : null;
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
