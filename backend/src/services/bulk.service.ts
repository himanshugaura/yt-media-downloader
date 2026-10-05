import fs from "fs";
import path from "path";
import os from "os";
import archiver from "archiver";

import { env } from "../core/config/env.js";
import { logger } from "../core/config/logger.js";
import { convertToMp3 } from "./ffmpeg.service.js";
import { ytDlpDownload } from "./ytdlp.service.js";
import {
  cleanupTempDirs,
  sanitizeFileName,
} from "../shared/utils/tempFiles.js";
import { maskUrl } from "./download.service.js";

const BASE_TMP_DIR = env.TEMP_DIR || path.join(os.tmpdir(), "media-downloader");

export interface BulkItemStatus {
  url: string;
  title?: string;
  status: "waiting" | "processing" | "completed" | "failed";
  error?: string;
}

export interface BulkProgressState {
  batchId: string;
  total: number;
  completed: number;
  failed: number;
  processing: number;
  waiting: number;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "ABORTED";
  items: BulkItemStatus[];
}

export interface SuccessfulBulkFile {
  filePath: string;
  zipName: string;
  title: string;
}

/**
 * Concurrency limiter function that runs up to `limit` promises concurrently,
 * honoring AbortSignal to cancel remaining work.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      if (signal?.aborted) {
        break;
      }

      const currentIndex = nextIndex++;
      const item = items[currentIndex];

      try {
        results[currentIndex] = await worker(item, currentIndex);
      } catch {
        results[currentIndex] = null;
      }
    }
  };

  const poolSize = Math.max(1, Math.min(limit, items.length));
  const pool = Array.from({ length: poolSize }, () => runWorker());

  await Promise.all(pool);
  return results;
}

/**
 * Orchestrates a bulk download run with P0 single-pass optimizations:
 * - Creates batch root temp directory
 * - Processes URLs bounded by BULK_CONCURRENCY
 * - Captures title and audio in a SINGLE yt-dlp pass (zero separate probe)
 * - Tracks progress and collects successful MP3 files
 */
export async function executeBulkDownload(
  batchId: string,
  urls: string[],
  signal?: AbortSignal,
  onProgress?: (state: BulkProgressState) => void,
): Promise<{ batchDir: string; files: SuccessfulBulkFile[] }> {
  const batchDir = path.join(BASE_TMP_DIR, `batch-${batchId}`);
  await fs.promises.mkdir(batchDir, { recursive: true });

  const itemsState: BulkItemStatus[] = urls.map((url) => ({
    url,
    status: "waiting",
  }));

  const state: BulkProgressState = {
    batchId,
    total: urls.length,
    completed: 0,
    failed: 0,
    processing: 0,
    waiting: urls.length,
    status: "RUNNING",
    items: itemsState,
  };

  const notifyProgress = () => {
    state.completed = itemsState.filter((i) => i.status === "completed").length;
    state.failed = itemsState.filter((i) => i.status === "failed").length;
    state.processing = itemsState.filter((i) => i.status === "processing").length;
    state.waiting = itemsState.filter((i) => i.status === "waiting").length;
    if (onProgress) {
      onProgress({ ...state, items: [...itemsState] });
    }
  };

  notifyProgress();

  const usedZipNames = new Set<string>();
  const successfulFiles: SuccessfulBulkFile[] = [];

  try {
    const concurrency = env.BULK_CONCURRENCY || 2;
    logger.info(`[batch-${batchId}] Starting bulk processing of ${urls.length} URLs with concurrency ${concurrency}`);

    await runWithConcurrency(
      urls,
      concurrency,
      async (url, index) => {
        if (signal?.aborted) {
          itemsState[index].status = "failed";
          itemsState[index].error = "Operation aborted";
          notifyProgress();
          return null;
        }

        itemsState[index].status = "processing";
        notifyProgress();

        const itemDir = path.join(batchDir, `item-${index}`);
        const inputDir = path.join(itemDir, "input");
        const outputDir = path.join(itemDir, "output");

        await fs.promises.mkdir(inputDir, { recursive: true });
        await fs.promises.mkdir(outputDir, { recursive: true });

        try {
          // P0 OPTIMIZATION: Single-pass yt-dlp download & title capture (no separate getYtMetadata probe)
          const { downloadedFile, title } = await ytDlpDownload({
            url,
            outputDir: inputDir,
            audioOnly: true,
            signal,
          });

          const safeTitle = sanitizeFileName(title, `audio_${index + 1}`);
          itemsState[index].title = title || `Audio ${index + 1}`;

          // Convert to MP3 with controlled threads (threads = 2 per worker to avoid CPU thrashing)
          const mp3Path = await convertToMp3(downloadedFile, outputDir, signal, `${safeTitle}.mp3`, 2);

          // Ensure unique name in ZIP
          let zipName = `${safeTitle}.mp3`;
          let counter = 1;
          while (usedZipNames.has(zipName.toLowerCase())) {
            zipName = `${safeTitle} (${counter}).mp3`;
            counter++;
          }
          usedZipNames.add(zipName.toLowerCase());

          successfulFiles.push({
            filePath: mp3Path,
            zipName,
            title: title || safeTitle,
          });

          itemsState[index].status = "completed";
          logger.info(`[batch-${batchId}] URL ${index + 1}/${urls.length} completed: ${zipName}`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          itemsState[index].status = "failed";
          itemsState[index].error = message;
          logger.warn(`[batch-${batchId}] URL ${index + 1}/${urls.length} failed: ${maskUrl(url)}`, { error: message });
          // Clean up individual item directory on failure to save disk space
          await cleanupTempDirs(itemDir);
        } finally {
          notifyProgress();
        }

        return null;
      },
      signal,
    );

    if (signal?.aborted) {
      state.status = "ABORTED";
      notifyProgress();
    }

    return { batchDir, files: successfulFiles };
  } catch (err) {
    state.status = "FAILED";
    notifyProgress();
    await cleanupTempDirs(batchDir);
    throw err;
  }
}

/**
 * Streams files into a ZIP archive written directly to a writable stream (e.g. Express Response).
 * Low memory footprint – streams files from disk directly into archive pipe.
 */
export async function streamZipToDestination(
  files: SuccessfulBulkFile[],
  destinationStream: NodeJS.WritableStream,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Stream aborted"));
    }

    const archive = archiver("zip", {
      zlib: { level: 5 }, // Balanced compression speed vs CPU
    });

    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", handleAbort);
    };

    const handleAbort = () => {
      cleanup();
      archive.abort();
      reject(new Error("ZIP streaming aborted by client"));
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    archive.on("error", (err) => {
      cleanup();
      logger.error("ZIP archiver error", { err: err.message });
      reject(err);
    });

    const onFinish = () => {
      cleanup();
      resolve();
    };

    if ("on" in destinationStream && typeof destinationStream.on === "function") {
      destinationStream.once("finish", onFinish);
      destinationStream.once("close", onFinish);
    } else {
      archive.once("end", onFinish);
    }

    archive.pipe(destinationStream);

    for (const file of files) {
      if (fs.existsSync(file.filePath)) {
        archive.file(file.filePath, { name: file.zipName });
      }
    }

    archive.finalize();
  });
}
