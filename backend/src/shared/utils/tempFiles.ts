import fs from "fs/promises";
import path from "path";
import os from "os";

import { logger } from "../../core/config/logger.js";
import { env } from "../../core/config/env.js";

const BASE_TMP_DIR = env.TEMP_DIR || path.join(os.tmpdir(), "media-downloader");

/**
 * Represents the directory layout for a single request's temp workspace.
 */
export interface RequestTempDirs {
  requestId: string;
  root: string;    // <BASE_TMP_DIR>/<requestId>
  input: string;   // <BASE_TMP_DIR>/<requestId>/input
  output: string;  // <BASE_TMP_DIR>/<requestId>/output
}

/**
 * Create isolated temp directories for a given request ID.
 */
export async function createTempDirs(requestId: string): Promise<RequestTempDirs> {
  const root = path.join(BASE_TMP_DIR, requestId);
  const input = path.join(root, "input");
  const output = path.join(root, "output");

  await fs.mkdir(input, { recursive: true });
  await fs.mkdir(output, { recursive: true });

  return { requestId, root, input, output };
}

/**
 * Recursively delete a request's temp directory tree.
 * Idempotent: safe to call multiple times, swallows not-found errors.
 */
export async function cleanupTempDirs(target: RequestTempDirs | string): Promise<void> {
  const dirPath = typeof target === "string" ? target : target.root;
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    logger.debug(`Cleaned up temp dir: ${dirPath}`);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== "ENOENT") {
      logger.warn(`Failed to clean up temp dir ${dirPath}`, { err: error.message });
    }
  }
}

/**
 * Find the first file inside a directory (non-recursive).
 */
export async function findFirstFile(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) return fullPath;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Sanitize a string into a safe file name across all operating systems
 * and safe for HTTP Content-Disposition headers.
 */
export function sanitizeFileName(name: string, fallback = "media"): string {
  if (!name || typeof name !== "string") return fallback;

  // Replace invalid filesystem and header characters: / \ ? * : | " < > and non-printables
  const sanitized = name
    .replace(/[/\\?%*:|"<>]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();

  // If entirely stripped or only dots, fallback
  if (!sanitized || /^[\.\s]+$/.test(sanitized)) {
    return fallback;
  }

  // Truncate length to safe limit (120 chars)
  return sanitized.slice(0, 120).trim();
}
