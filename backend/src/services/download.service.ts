import type { Response } from "express";
import { v4 as uuidv4 } from "uuid";

import { logger } from "../core/config/logger.js";
import { spawnMp3Encoder } from "./ffmpeg.service.js";
import { fetchFastTitle, spawnYtDlpAudioStream } from "./ytdlp.service.js";
import { sanitizeFileName } from "../shared/utils/tempFiles.js";
import ApiError from "../shared/utils/ApiError.js";

export interface StreamSingleMp3Options {
  url: string;
  res: Response;
  signal?: AbortSignal;
}

/**
 * P0 In-Memory Streaming Pipeline for MP3:
 * 1. Resolves video title via fast YouTube oEmbed (~250-350ms).
 * 2. Spawns yt-dlp -> FFmpeg pipe in-memory with zero temporary disk files.
 * 3. Awaits the first audio chunk from FFmpeg BEFORE emitting HTTP headers,
 *    guaranteeing that failed extractions on datacenter/cloud IPs (e.g. Render)
 *    never produce an empty 0-byte download in the browser.
 * 4. Streams live MP3 audio directly to Express response.
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

  const safeAsciiFilename = finalFileName.replace(/[^\x20-\x7E]/g, "_");
  const encodedUtf8Filename = encodeURIComponent(finalFileName);

  // Step 2: Spawn streaming child processes
  const ytProc = spawnYtDlpAudioStream(url, signal);
  const ffmpegProc = spawnMp3Encoder(signal, 0);

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let headersSent = false;
    const ytErrors: string[] = [];
    const ffmpegErrors: string[] = [];

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
      fail(new ApiError(500, "Failed to initialize process streams"));
      return;
    }

    const ytStdout = ytProc.stdout;
    const ffmpegStdin = ffmpegProc.stdin;
    const ffmpegStdout = ffmpegProc.stdout;

    // Capture stderr to diagnose failures accurately
    if (ytProc.stderr) {
      ytProc.stderr.on("data", (data: Buffer) => {
        const msg = data.toString();
        ytErrors.push(msg.trim());
        if (msg.includes("ERROR:") || msg.includes("Sign in")) {
          logger.warn(`[${requestId}] yt-dlp stderr: ${msg.trim()}`);
        }
      });
    }

    if (ffmpegProc.stderr) {
      ffmpegProc.stderr.on("data", (data: Buffer) => {
        ffmpegErrors.push(data.toString().trim());
      });
    }

    // Pipe audio stream: yt-dlp stdout -> FFmpeg stdin
    ytStdout.pipe(ffmpegStdin);

    // CRITICAL: Await first encoded MP3 chunk BEFORE committing HTTP 200 attachment headers.
    // This completely eliminates the 0-byte download bug if yt-dlp or cloud extraction fails.
    ffmpegStdout.once("data", (firstChunk: Buffer) => {
      if (finished || signal?.aborted) return;

      headersSent = true;
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeAsciiFilename}"; filename*=UTF-8''${encodedUtf8Filename}`,
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.flushHeaders();

      logger.info(`[${requestId}] First audio chunk received (${firstChunk.length} B), dispatched headers (title: "${safeTitle}")`);

      ffmpegStdout.pause();
      res.write(firstChunk);
      ffmpegStdout.pipe(res);
      ffmpegStdout.resume();
    });

    ytProc.on("error", (err) => {
      logger.error(`[${requestId}] yt-dlp process error`, { error: err.message });
      fail(new ApiError(500, `Failed to execute yt-dlp: ${err.message}`));
    });

    ffmpegProc.on("error", (err) => {
      logger.error(`[${requestId}] FFmpeg process error`, { error: err.message });
      fail(new ApiError(500, `Failed to execute FFmpeg: ${err.message}`));
    });

    // Detect premature yt-dlp exit (e.g. YouTube bot detection or 403) before headers are sent
    ytProc.on("close", (code) => {
      if (code !== 0 && !headersSent) {
        const errorDetail = ytErrors.filter(Boolean).slice(-3).join(" ") || `Process exited with code ${code}`;
        logger.error(`[${requestId}] yt-dlp exited with error before stream started: ${errorDetail}`);

        let clientMessage = `YouTube audio extraction failed: ${errorDetail}`;
        if (errorDetail.includes("Sign in to confirm you’re not a bot") || errorDetail.includes("Sign in to confirm you're not a bot")) {
          clientMessage = "YouTube Bot Detection: Cloud server IP challenged by YouTube. Provide YOUTUBE_COOKIES in Render environment variables to bypass.";
        }
        fail(new ApiError(502, clientMessage));
      }
    });

    // Detect premature FFmpeg exit before headers are sent
    ffmpegProc.on("close", (code) => {
      if (code !== 0 && !headersSent) {
        const errorDetail = ffmpegErrors.filter(Boolean).slice(-3).join(" ") || `Process exited with code ${code}`;
        logger.error(`[${requestId}] FFmpeg exited with error before stream started: ${errorDetail}`);
        fail(new ApiError(502, `Audio encoding failed: ${errorDetail}`));
      }
    });

    // Detect stream EOF if no data was ever produced
    ffmpegStdout.on("end", () => {
      if (!headersSent) {
        const errorDetail = ytErrors.filter(Boolean).slice(-3).join(" ") || "No audio stream data produced";
        logger.error(`[${requestId}] Audio stream ended with 0 bytes: ${errorDetail}`);
        fail(new ApiError(502, `Media extraction produced empty audio: ${errorDetail}`));
      }
    });

    // Prevent unhandled stream errors on pipe breakdown or client disconnection
    ffmpegStdin.on("error", (err: unknown) => {
      const code = (err as { code?: string })?.code;
      if (code !== "EPIPE") {
        logger.debug(`[${requestId}] FFmpeg stdin stream error`, { err });
      }
    });

    ytStdout.on("error", (err: unknown) => {
      const code = (err as { code?: string })?.code;
      if (code !== "EPIPE") {
        logger.debug(`[${requestId}] yt-dlp stdout stream error`, { err });
      }
    });

    ffmpegStdout.on("error", (err: unknown) => {
      const code = (err as { code?: string })?.code;
      if (code !== "EPIPE") {
        logger.debug(`[${requestId}] FFmpeg stdout stream error`, { err });
      }
    });

    res.on("error", (err: unknown) => {
      const code = (err as { code?: string })?.code;
      if (code === "EPIPE" || code === "ECONNRESET") {
        logger.info(`[${requestId}] Client terminated connection during MP3 stream (${code})`);
      } else {
        logger.warn(`[${requestId}] Response stream error`, { err });
      }
      done();
    });

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
