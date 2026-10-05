import type { Response } from "express";
import { v4 as uuidv4 } from "uuid";

import { logger } from "../core/config/logger.js";
import { spawnMp3Encoder } from "./ffmpeg.service.js";
import { fetchFastTitle, spawnYtDlpAudioStream } from "./ytdlp.service.js";
import { sanitizeFileName } from "../shared/utils/tempFiles.js";

export interface StreamSingleMp3Options {
  url: string;
  res: Response;
  signal?: AbortSignal;
}

/**
 * P0 In-Memory Streaming Pipeline for MP3:
 * 1. Resolves video title via fast YouTube oEmbed (~250-350ms).
 * 2. Emits HTTP 200 headers with Content-Disposition immediately across the wire.
 *    (Triggers the browser "Save As" / download manager in ~0.3s).
 * 3. Pipes yt-dlp audio stdout directly into FFmpeg stdin.
 * 4. Pipes FFmpeg MP3 stdout directly into Express res.
 * 5. Zero temporary files created on disk.
 */
export async function streamSingleMp3(options: StreamSingleMp3Options): Promise<void> {
  const { url, res, signal } = options;
  const requestId = uuidv4();

  logger.info(`[${requestId}] Starting direct MP3 live stream`, { url: maskUrl(url) });

  // Step 1: Fast title lookup via oEmbed
  const rawTitle = await fetchFastTitle(url, signal);
  const safeTitle = sanitizeFileName(rawTitle, "audio");
  const finalFileName = `${safeTitle}.mp3`;

  if (signal?.aborted || res.writableEnded) {
    return;
  }

  // Step 2: Immediate header dispatch
  const safeAsciiFilename = finalFileName.replace(/[^\x20-\x7E]/g, "_");
  const encodedUtf8Filename = encodeURIComponent(finalFileName);

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeAsciiFilename}"; filename*=UTF-8''${encodedUtf8Filename}`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.flushHeaders();

  logger.info(`[${requestId}] Dispatched headers to browser (title: "${safeTitle}")`);

  // Step 3: Spawn streaming child processes
  const ytProc = spawnYtDlpAudioStream(url, signal);
  const ffmpegProc = spawnMp3Encoder(signal, 0);

  return new Promise<void>((resolve, reject) => {
    let finished = false;

    const cleanup = () => {
      if (!ytProc.killed) {
        try {
          ytProc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      if (!ffmpegProc.killed) {
        try {
          ffmpegProc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    };

    const done = () => {
      if (!finished) {
        finished = true;
        cleanup();
        resolve();
      }
    };

    const fail = (err: Error) => {
      if (!finished) {
        finished = true;
        cleanup();
        reject(err);
      }
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        return resolve();
      }
      signal.addEventListener(
        "abort",
        () => {
          cleanup();
          done();
        },
        { once: true },
      );
    }

    if (!ytProc.stdout || !ffmpegProc.stdin || !ffmpegProc.stdout) {
      fail(new Error("Failed to initialize process streams"));
      return;
    }

    // Pipe audio stream: yt-dlp -> ffmpeg -> res
    ytProc.stdout.pipe(ffmpegProc.stdin);
    ffmpegProc.stdout.pipe(res);

    ytProc.on("error", (err) => {
      logger.error(`[${requestId}] yt-dlp process error`, { error: err.message });
      fail(err);
    });

    ffmpegProc.on("error", (err) => {
      logger.error(`[${requestId}] FFmpeg process error`, { error: err.message });
      fail(err);
    });

    if (ytProc.stderr) {
      ytProc.stderr.on("data", (data) => {
        const msg = data.toString();
        if (msg.includes("ERROR:")) {
          logger.warn(`[${requestId}] yt-dlp stderr: ${msg.trim()}`);
        }
      });
    }

    res.on("finish", () => {
      logger.info(`[${requestId}] Direct MP3 stream completed successfully`);
      done();
    });

    res.on("close", () => {
      if (!res.writableEnded) {
        logger.info(`[${requestId}] Client disconnected during MP3 stream, child processes aborted`);
      }
      done();
    });
  });
}

/** Redact query params from a URL for safe logging. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}
