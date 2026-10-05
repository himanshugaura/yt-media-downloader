import { spawn, type ChildProcess } from "child_process";
import path from "path";

import { env } from "../core/config/env.js";
import { logger } from "../core/config/logger.js";

/**
 * Convert an audio file to MP3 using FFmpeg.
 * Args are built programmatically – no user input ever enters the argument list.
 * @param threads Number of CPU threads (0 = auto-detect all available cores).
 */
export async function convertToMp3(
  inputFile: string,
  outputDir: string,
  signal?: AbortSignal,
  outputFileName = "output.mp3",
  threads = 0,
): Promise<string> {
  const outputFile = path.join(outputDir, outputFileName);
  const ffmpegPath = env.FFMPEG_PATH;
  const threadArg = threads > 0 ? threads.toString() : "0";

  const args: string[] = [
    "-y",                    // overwrite output if it exists
    "-i", inputFile,         // input file
    "-vn",                   // drop video stream
    "-threads", threadArg,   // CPU allocation (0 = auto all cores for single downloads)
    "-ar", "44100",          // sample rate
    "-ac", "2",              // stereo
    "-b:a", "192k",          // audio bitrate
    outputFile,
  ];

  logger.debug(`Spawning FFmpeg for MP3 (threads: ${threadArg})`);

  await runFfmpeg(ffmpegPath, args, signal);
  return outputFile;
}

/**
 * Spawns an FFmpeg process that takes an audio stream from stdin and encodes it to 192k MP3 on stdout.
 * Args are built programmatically with zero shell interpolation.
 * @param signal AbortSignal to kill the process if aborted.
 * @param threads Number of CPU threads (0 = auto-detect all available cores).
 */
export function spawnMp3Encoder(signal?: AbortSignal, threads = 0): ChildProcess {
  const ffmpegPath = env.FFMPEG_PATH;
  const threadArg = threads > 0 ? threads.toString() : "0";

  const args: string[] = [
    "-i", "pipe:0",           // read from stdin
    "-vn",                    // drop video
    "-threads", threadArg,    // CPU allocation
    "-ar", "44100",           // sample rate
    "-ac", "2",               // stereo
    "-c:a", "libmp3lame",     // MP3 audio encoder
    "-b:a", "192k",           // audio bitrate
    "-f", "mp3",              // force MP3 container format
    "pipe:1",                 // write to stdout
  ];

  logger.debug(`Spawning FFmpeg live MP3 stream encoder (threads: ${threadArg})`);

  const child = spawn(ffmpegPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (signal) {
    if (signal.aborted) {
      child.kill("SIGKILL");
    } else {
      signal.addEventListener(
        "abort",
        () => {
          child.kill("SIGKILL");
        },
        { once: true },
      );
    }
  }

  return child;
}

/**
 * Internal helper – spawns FFmpeg and waits for it to exit.
 * Safely kills process if abort signal triggers.
 */
async function runFfmpeg(ffmpegPath: string, args: string[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new Error("FFmpeg aborted prior to execution");
  }

  return new Promise((resolve, reject) => {
    let proc: ChildProcess;

    try {
      proc = spawn(ffmpegPath, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reject(new Error(`Failed to start FFmpeg: ${message}`));
    }

    const stderr: string[] = [];
    let killTimer: NodeJS.Timeout | null = null;

    const cleanupListeners = () => {
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", handleAbort);
    };

    const handleAbort = () => {
      logger.info("Abort signal received, terminating FFmpeg child process");
      if (!proc.killed) {
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 1500);
      }
      reject(new Error("FFmpeg processing aborted by client"));
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      logger.debug(`[ffmpeg stdout] ${chunk.toString().trim()}`);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      logger.debug(`[ffmpeg stderr] ${text}`);
      stderr.push(text);
    });

    proc.on("error", (err) => {
      cleanupListeners();
      logger.error("FFmpeg process error", { err: err.message });
      reject(new Error(`Failed to execute ffmpeg: ${err.message}`));
    });

    proc.on("close", (code) => {
      cleanupListeners();
      if (signal?.aborted) {
        reject(new Error("FFmpeg processing aborted by client"));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.slice(-5).join(" | ");
        reject(new Error(`ffmpeg exited with code ${code}. Detail: ${detail}`));
      }
    });
  });
}
