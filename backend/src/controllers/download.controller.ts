import fs from "fs";
import path from "path";
import type { NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

import { env } from "../core/config/env.js";
import { logger } from "../core/config/logger.js";
import { streamSingleMp3 } from "../services/download.service.js";
import { getVideoInfo } from "../services/ytdlp.service.js";
import {
  executeBulkDownload,
  streamZipToDestination,
  type BulkProgressState,
} from "../services/bulk.service.js";
import { cleanupTempDirs } from "../shared/utils/tempFiles.js";
import type {
  DownloadBody,
  BulkDownloadBody,
  BatchIdParams,
} from "../validators/download.validator.js";
import ApiError from "../shared/utils/ApiError.js";

// ── In-Memory Sessions for Bulk UI Progress ─────────────────────────────────
interface BulkSession {
  batchId: string;
  batchDir: string;
  abortController: AbortController;
  progress: BulkProgressState;
  zipPath?: string;
  createdAt: number;
  listeners: Set<(data: BulkProgressState) => void>;
}

const activeBulkSessions = new Map<string, BulkSession>();

// Cleanup stale sessions after 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [batchId, session] of activeBulkSessions.entries()) {
    if (now - session.createdAt > 15 * 60 * 1000) {
      session.abortController.abort();
      cleanupTempDirs(session.batchDir).catch(() => undefined);
      activeBulkSessions.delete(batchId);
    }
  }
}, 60 * 1000);

/**
 * GET /api/v1/download or POST /api/v1/download
 * Direct single media download (MP3).
 * Live pipes yt-dlp -> FFmpeg -> HTTP response with fast oEmbed title dispatch (~300ms).
 * Detects client disconnect and aborts child processes immediately.
 */
export async function singleDownloadController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rawUrl = (req.body?.url || req.query?.url) as string;
  const url = rawUrl?.trim();

  if (!url) {
    res.status(400).json({ success: false, message: "URL is required" });
    return;
  }

  const abortController = new AbortController();

  const timeoutTimer = setTimeout(() => {
    logger.warn("Single download timed out, aborting", { url });
    abortController.abort();
  }, env.DOWNLOAD_TIMEOUT_MS);

  // Client disconnect listener: tab closed or connection dropped
  req.on("close", () => {
    if (!res.writableEnded) {
      logger.info("Client disconnected during single download, aborting child processes");
      abortController.abort();
    }
  });

  try {
    await streamSingleMp3({
      url,
      res,
      signal: abortController.signal,
    });
    clearTimeout(timeoutTimer);
  } catch (err: unknown) {
    clearTimeout(timeoutTimer);
    if (abortController.signal.aborted) {
      logger.info("Request cancelled due to abort signal");
      return;
    }
    if (!res.headersSent) {
      next(err);
    } else {
      logger.error("Error occurred during live MP3 stream", { err });
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
}

/**
 * GET /api/v1/info?url=...
 * Returns title, author, thumbnail, duration, and estimated MP3 size.
 */
export async function videoInfoController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rawUrl = (req.query?.url || req.body?.url) as string;
  const url = rawUrl?.trim();

  if (!url) {
    res.status(400).json({ success: false, message: "URL parameter is required" });
    return;
  }

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 10000);

  req.on("close", () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  try {
    const info = await getVideoInfo(url, abortController.signal);
    clearTimeout(timer);
    res.json({
      success: true,
      data: info,
    });
  } catch (err) {
    clearTimeout(timer);
    next(err);
  }
}

/**
 * POST /api/v1/download/bulk
 * Direct bulk MP3 download as a streamed ZIP file.
 * Concurrency limited by BULK_CONCURRENCY.
 * Directly streams the resulting ZIP to the HTTP response.
 */
export async function directBulkDownloadController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { urls } = req.body as BulkDownloadBody;
  const batchId = uuidv4();
  const abortController = new AbortController();
  let batchDirectory: string | null = null;

  const timeoutTimer = setTimeout(() => {
    logger.warn(`Bulk download [batch-${batchId}] timed out, aborting`);
    abortController.abort();
  }, env.DOWNLOAD_TIMEOUT_MS * 3);

  // Client disconnect listener: tab closed or connection dropped
  req.on("close", () => {
    if (!res.writableEnded) {
      logger.info(`Client disconnected during direct bulk download [batch-${batchId}], aborting`);
      abortController.abort();
      if (batchDirectory) {
        cleanupTempDirs(batchDirectory).catch(() => undefined);
      }
    }
  });

  try {
    const { batchDir, files } = await executeBulkDownload(
      batchId,
      urls,
      abortController.signal,
    );
    batchDirectory = batchDir;
    clearTimeout(timeoutTimer);

    if (abortController.signal.aborted || res.writableEnded) {
      await cleanupTempDirs(batchDir);
      return;
    }

    if (files.length === 0) {
      await cleanupTempDirs(batchDir);
      throw new ApiError(422, "No audio files could be processed successfully from the provided URLs.");
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="youtube-audio-bundle.zip"');
    res.setHeader("X-Content-Type-Options", "nosniff");

    res.on("finish", () => {
      cleanupTempDirs(batchDir).catch(() => undefined);
    });

    res.on("close", () => {
      if (!res.writableEnded) {
        cleanupTempDirs(batchDir).catch(() => undefined);
      }
    });

    await streamZipToDestination(files, res, abortController.signal);
  } catch (err: unknown) {
    clearTimeout(timeoutTimer);
    if (batchDirectory) {
      await cleanupTempDirs(batchDirectory);
    }
    if (abortController.signal.aborted) {
      return;
    }
    next(err);
  }
}

/**
 * POST /api/v1/download/bulk/start
 * Starts an in-memory bulk download session and returns batchId.
 * Allows frontend to track live progress and download the ZIP when done.
 */
export async function startBulkSessionController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { urls } = req.body as BulkDownloadBody;
    const batchId = uuidv4();
    const abortController = new AbortController();

    const session: BulkSession = {
      batchId,
      batchDir: "",
      abortController,
      progress: {
        batchId,
        total: urls.length,
        completed: 0,
        failed: 0,
        processing: 0,
        waiting: urls.length,
        status: "RUNNING",
        items: urls.map((u) => ({ url: u, status: "waiting" })),
      },
      createdAt: Date.now(),
      listeners: new Set(),
    };

    activeBulkSessions.set(batchId, session);

    // Run async in background (tied to in-process memory)
    (async () => {
      try {
        const { batchDir, files } = await executeBulkDownload(
          batchId,
          urls,
          abortController.signal,
          (progressUpdate) => {
            session.progress = progressUpdate;
            for (const listener of session.listeners) {
              listener(progressUpdate);
            }
          },
        );

        session.batchDir = batchDir;

        if (abortController.signal.aborted) {
          await cleanupTempDirs(batchDir);
          activeBulkSessions.delete(batchId);
          return;
        }

        if (files.length > 0) {
          // Pre-create the ZIP file on disk for instantaneous download
          const zipPath = path.join(batchDir, "bundle.zip");
          const zipStream = fs.createWriteStream(zipPath);
          await streamZipToDestination(files, zipStream, abortController.signal);
          session.zipPath = zipPath;
        }

        session.progress.status = files.length > 0 ? "COMPLETED" : "FAILED";
        for (const listener of session.listeners) {
          listener(session.progress);
        }
      } catch (err: unknown) {
        session.progress.status = "FAILED";
        for (const listener of session.listeners) {
          listener(session.progress);
        }
        if (session.batchDir) {
          await cleanupTempDirs(session.batchDir);
        }
      }
    })();

    res.status(202).json({
      success: true,
      message: "Bulk download session initialized",
      data: {
        batchId,
        total: urls.length,
        eventsUrl: `/api/v1/download/bulk/${batchId}/events`,
        downloadUrl: `/api/v1/download/bulk/${batchId}/file`,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/download/bulk/:batchId/events
 * Server-Sent Events (SSE) endpoint providing live progress updates.
 * If user closes tab / disconnects, aborts child processes and cleans up.
 */
export async function bulkEventsController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { batchId } = req.params as BatchIdParams;
    const session = activeBulkSessions.get(batchId);

    if (!session) {
      throw new ApiError(404, "Bulk session not found or already expired");
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendUpdate = (state: BulkProgressState) => {
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    };

    // Send immediate current state
    sendUpdate(session.progress);

    session.listeners.add(sendUpdate);

    // On client disconnect (e.g. browser tab closed)
    req.on("close", () => {
      session.listeners.delete(sendUpdate);

      // If no more clients listening and job is still running, abort!
      if (session.listeners.size === 0 && session.progress.status === "RUNNING") {
        logger.info(`All clients disconnected from batch ${batchId}, aborting bulk execution`);
        session.abortController.abort();
        if (session.batchDir) {
          cleanupTempDirs(session.batchDir).catch(() => undefined);
        }
        activeBulkSessions.delete(batchId);
      }
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/download/bulk/:batchId/file
 * Downloads the completed ZIP file generated by the session and cleans up.
 */
export async function bulkDownloadFileController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { batchId } = req.params as BatchIdParams;
    const session = activeBulkSessions.get(batchId);

    if (!session || !session.zipPath || !fs.existsSync(session.zipPath)) {
      throw new ApiError(404, "ZIP archive not ready or session expired");
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="youtube-audio-bundle.zip"');
    res.setHeader("X-Content-Type-Options", "nosniff");

    const readStream = fs.createReadStream(session.zipPath);

    res.on("finish", () => {
      // Immediately clean up batch directory and session after file has downloaded
      cleanupTempDirs(session.batchDir).catch(() => undefined);
      activeBulkSessions.delete(batchId);
    });

    res.on("close", () => {
      if (!res.writableEnded) {
        readStream.destroy();
        cleanupTempDirs(session.batchDir).catch(() => undefined);
        activeBulkSessions.delete(batchId);
      }
    });

    readStream.pipe(res);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/health
 * Lightweight liveness probe.
 */
export async function healthController(_req: Request, res: Response): Promise<void> {
  res.status(200).json({
    status: "ok",
    version: "3.0.0",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
