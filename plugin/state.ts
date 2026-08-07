import fs from "node:fs";
import path from "node:path";
import type { RelayConfig } from "./config.js";

export interface SessionState {
  project_id: string;
  project_name: string;
  workdir: string;
  worktree_branch: string;
}

/** 去掉 sessionID 中的非字母数字字符 */
export function sanitizeSessionID(sessionID: string): string {
  return sessionID.replace(/[^A-Za-z0-9]/g, "");
}

/** session 短 id：去掉非字母数字后取前 8 字符，用于 worktree 目录与分支命名 */
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

/** 读取会话状态；文件不存在或格式非法返回 null */
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

/** 写入会话状态，返回状态文件路径 */
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

/** 删除会话状态，返回是否实际删除 */
export function removeSessionState(config: RelayConfig, sessionID: string): boolean {
  const file = stateFilePath(config, sessionID);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
