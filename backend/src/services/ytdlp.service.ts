import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { env } from "../core/config/env.js";
import { logger } from "../core/config/logger.js";
import { findFirstFile } from "../shared/utils/tempFiles.js";

let cachedCookiePath: string | null = null;

/**
 * Returns the path to a cookies file if YOUTUBE_COOKIES is configured.
 * If YOUTUBE_COOKIES points to a valid file, that path is returned.
 * If YOUTUBE_COOKIES contains raw cookie text (e.g. pasted into Render env),
 * it writes the content to a temporary file once and reuses it.
 */
export function getCookiesFilePath(): string | null {
  const rawCookies = (process.env.YOUTUBE_COOKIES || env.YOUTUBE_COOKIES)?.trim();
  if (!rawCookies) return null;

  if (cachedCookiePath && fs.existsSync(cachedCookiePath)) {
    return cachedCookiePath;
  }

  try {
    let cookieContent = rawCookies;

    // If pointing to a file on disk (like Render Secret File /etc/secrets/cookies.txt)
    // ALWAYS read and copy to a writable location (/tmp) because yt-dlp attempts to save cookies on exit!
    if (fs.existsSync(rawCookies)) {
      cookieContent = fs.readFileSync(rawCookies, "utf-8");
    }

    // Check if base64 encoded (useful for multi-line env var pasting in Render)
    if (cookieContent.startsWith("base64:")) {
      cookieContent = Buffer.from(cookieContent.slice(7), "base64").toString("utf-8");
    } else if (!cookieContent.includes("\t") && !cookieContent.includes(" ") && cookieContent.length > 50) {
      try {
        const decoded = Buffer.from(cookieContent, "base64").toString("utf-8");
        if (decoded.includes("# Netscape") || decoded.includes("youtube.com")) {
          cookieContent = decoded;
        }
      } catch {
        // Not base64
      }
    }

    // Convert literal \n or \r\n (from single-line env vars) to real newlines
    if (cookieContent.includes("\\n") && !cookieContent.includes("\n")) {
      cookieContent = cookieContent.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
    }

    // Write to writable /tmp directory so yt-dlp's save_cookies on exit never encounters Errno 30 Read-only file system
    const tmpCookiePath = path.join(os.tmpdir(), "youtube_cookies.txt");
    fs.writeFileSync(tmpCookiePath, cookieContent, { encoding: "utf-8", mode: 0o600 });
    cachedCookiePath = tmpCookiePath;
    logger.info("Successfully loaded and prepared writable YouTube cookies", { path: tmpCookiePath });
    return tmpCookiePath;
  } catch (err) {
    logger.error("Failed to prepare YouTube cookies file", { err });
    return null;
  }
}

/**
 * Common base arguments for yt-dlp across all operations (streaming, downloading, metadata).
 * Optimized for datacenter / cloud environments (Render, AWS, DigitalOcean) to prevent bot detection:
 * - Uses mweb & web player clients
 * - Evaluates JS challenge tokens using Node.js
 * - Forces IPv4 to bypass broken cloud IPv6 routes to Google Video CDNs
 * - Injects cookies if configured
 * - Injects PO token if configured
 */
export function getYtDlpBaseArgs(): string[] {
  const cookieFile = getCookiesFilePath();

  const args: string[] = [
    "--no-playlist",
    "--no-warnings",
    "--force-ipv4",
  ];

  if (cookieFile) {
    // When authenticated with cookies, use standard direct extraction (~2-3s) without slow mweb JS challenge sleeps
    args.push("--cookies", cookieFile);
  } else {
    // Fallback for unauthenticated datacenter IPs
    args.push(
      "--js-runtimes", "node",
      "--extractor-args", "youtube:player_client=mweb,web,android",
    );
  }

  if (env.YOUTUBE_PO_TOKEN?.trim()) {
    args.push("--extractor-args", `youtube:po_token=${env.YOUTUBE_PO_TOKEN.trim()}`);
  }

  return args;
}

export interface YtDlpMetadata {
  id?: string;
  title?: string;
  duration?: number;
}

export interface YtDlpDownloadOptions {
  url: string;
  outputDir: string;
  audioOnly: boolean;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

export interface YtDlpDownloadResult {
  downloadedFile: string;
  title: string;
}

export interface VideoInfo {
  title: string;
  author?: string;
  durationSeconds?: number;
  formattedDuration?: string;
  approxSizeBytes?: number;
  formattedSize?: string;
  thumbnailUrl?: string;
}

/**
 * Resolves video metadata (title, author, thumbnail, duration, estimated MP3 size)
 * using lightweight parallel network requests.
 */
export async function getVideoInfo(url: string, signal?: AbortSignal): Promise<VideoInfo> {
  let title = "YouTube Audio";
  let author: string | undefined;
  let thumbnailUrl: string | undefined;
  let durationSeconds: number | undefined;

  // 1. oEmbed for title, author, thumbnail
  const oembedPromise = (async () => {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const res = await fetch(oembedUrl, { signal });
      if (res.ok) {
        const data = (await res.json()) as {
          title?: string;
          author_name?: string;
          thumbnail_url?: string;
        };
        if (data.title) title = data.title;
        if (data.author_name) author = data.author_name;
        if (data.thumbnail_url) thumbnailUrl = data.thumbnail_url;
      }
    } catch {
      // ignore
    }
  })();

  // 2. Direct page fetch for duration
  const durationPromise = (async () => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal,
      });
      if (res.ok) {
        const html = await res.text();
        const match =
          html.match(/"approxDurationMs":"(\d+)"/) ||
          html.match(/"lengthSeconds":"(\d+)"/);
        if (match && match[1]) {
          const val = parseInt(match[1], 10);
          durationSeconds = match[0].includes("approxDurationMs")
            ? Math.round(val / 1000)
            : val;
        }
      }
    } catch {
      // ignore
    }
  })();

  await Promise.allSettled([oembedPromise, durationPromise]);

  let formattedDuration: string | undefined;
  let approxSizeBytes: number | undefined;
  let formattedSize: string | undefined;

  if (durationSeconds && durationSeconds > 0) {
    const mins = Math.floor(durationSeconds / 60);
    const secs = durationSeconds % 60;
    formattedDuration = `${mins}:${secs.toString().padStart(2, "0")}`;

    // 192 kbps = 24 KB/s
    approxSizeBytes = Math.round(durationSeconds * 24000);
    const mb = approxSizeBytes / (1024 * 1024);
    formattedSize = `~${mb.toFixed(1)} MB`;
  }

  return {
    title,
    author,
    durationSeconds,
    formattedDuration,
    approxSizeBytes,
    formattedSize,
    thumbnailUrl,
  };
}

/**
 * Fast video title retrieval using YouTube's public oEmbed API (~250-350ms).
 * Falls back to videoId from URL if oEmbed request fails or times out.
 */
export async function fetchFastTitle(url: string, signal?: AbortSignal): Promise<string> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);

    const onParentAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onParentAbort, { once: true });
    }

    try {
      const res = await fetch(oembedUrl, { signal: controller.signal });
      if (res.ok) {
        const data = (await res.json()) as { title?: string };
        if (data.title && typeof data.title === "string" && data.title.trim()) {
          return data.title.trim();
        }
      }
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onParentAbort);
      }
    }
  } catch (err) {
    logger.debug("Fast oEmbed title lookup failed, using fallback", { err });
  }

  // Fallback: extract video ID from URL
  const match = url.match(/(?:v=|\/shorts\/|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) {
    return `youtube-${match[1]}`;
  }

  return "youtube-audio";
}

/**
 * Spawns yt-dlp to stream raw audio bytes directly to stdout (-o -).
 * Pure stream with zero temporary files on disk.
 */
export function spawnYtDlpAudioStream(url: string, signal?: AbortSignal): ChildProcess {
  const ytDlpPath = env.YTDLP_PATH;
  const args = [
    ...getYtDlpBaseArgs(),
    "-f", "ba/b/18/best",
    "-o", "-",
    "--no-part",
    url,
  ];

  logger.debug(`Spawning yt-dlp audio stream: ${ytDlpPath} ${args.map((a) => (a === url ? "<url>" : a)).join(" ")}`);

  const child = spawn(ytDlpPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
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
 * Extracts metadata (title, duration, ID) using yt-dlp --dump-single-json.
 * Kept for fallback/utility use only; NOT called on the critical download path.
 */
export async function getYtMetadata(url: string, signal?: AbortSignal): Promise<YtDlpMetadata> {
  const ytDlpPath = env.YTDLP_PATH;
  const args = [
    ...getYtDlpBaseArgs(),
    "--dump-single-json",
    url,
  ];

  if (signal?.aborted) {
    return {};
  }

  return new Promise((resolve) => {
    let proc: ChildProcess | null = null;

    try {
      proc = spawn(ytDlpPath, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Failed to spawn yt-dlp for metadata", { message });
      return resolve({});
    }

    let stdout = "";

    const onAbort = () => {
      if (proc && !proc.killed) {
        proc.kill("SIGTERM");
      }
      resolve({});
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on("error", (err) => {
      logger.warn("Failed to fetch yt-dlp metadata (non-fatal)", { err: err.message });
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({});
    });

    proc.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (code === 0 && stdout) {
        try {
          const parsed = JSON.parse(stdout);
          resolve({
            id: parsed.id,
            title: parsed.title,
            duration: parsed.duration,
          });
          return;
        } catch {
          // ignore json parse error
        }
      }
      resolve({});
    });
  });
}

/**
 * Invoke yt-dlp as a single child process to download media AND capture title in ONE pass.
 * Uses positional arguments with shell: false (prevents command injection).
 * Handles client disconnect abort signal cleanly.
 */
export async function ytDlpDownload(options: YtDlpDownloadOptions): Promise<YtDlpDownloadResult> {
  const { url, outputDir, audioOnly, signal, onProgress } = options;
  const ytDlpPath = env.YTDLP_PATH;

  if (signal?.aborted) {
    throw new Error("Download aborted prior to execution");
  }

  const outputTemplate = path.join(outputDir, "%(title).100B.%(ext)s");
  const args: string[] = [
    ...getYtDlpBaseArgs(),
    "--print", "after_move:title", // Print title upon completion to eliminate separate metadata probe
    "--format", "ba/b/18/best",
    "--newline",
    "--output", outputTemplate,
    url,
  ];

  logger.debug(`Spawning yt-dlp: ${ytDlpPath} ${args.map((a) => (a === url ? "<url>" : a)).join(" ")}`);

  return new Promise((resolve, reject) => {
    let proc: ChildProcess;

    try {
      proc = spawn(ytDlpPath, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reject(new Error(`Failed to start yt-dlp: ${message}`));
    }

    const stderr: string[] = [];
    const progressRegex = /\[download\]\s+(\d+(?:\.\d+)?)%/;
    let extractedTitle = "";
    let killTimer: NodeJS.Timeout | null = null;

    const cleanupListeners = () => {
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", handleAbort);
    };

    const handleAbort = () => {
      logger.info("Abort signal received, terminating yt-dlp child process");
      if (!proc.killed) {
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 1500);
      }
      reject(new Error("Download aborted by client"));
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      logger.debug(`[yt-dlp stdout] ${text.trim()}`);

      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const match = trimmed.match(progressRegex);
        if (match && match[1]) {
          if (onProgress) {
            onProgress(parseFloat(match[1]));
          }
        } else if (!trimmed.startsWith("[") && !trimmed.startsWith("WARNING:")) {
          // Output from --print after_move:title
          extractedTitle = trimmed;
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      logger.debug(`[yt-dlp stderr] ${text}`);
      stderr.push(text);
    });

    proc.on("error", (err) => {
      cleanupListeners();
      logger.error("yt-dlp process error", { err: err.message });
      reject(new Error(`Failed to execute yt-dlp: ${err.message}`));
    });

    proc.on("close", async (code) => {
      cleanupListeners();
      if (signal?.aborted) {
        reject(new Error("Download aborted by client"));
        return;
      }
      if (code === 0) {
        try {
          const downloadedFile = await findFirstFile(outputDir);
          if (!downloadedFile) {
            return reject(new Error("yt-dlp completed but produced no output file."));
          }
          const fallbackTitle = path.parse(downloadedFile).name;
          const finalTitle = extractedTitle || fallbackTitle;
          resolve({
            downloadedFile,
            title: finalTitle,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          reject(new Error(`Failed to locate downloaded file: ${message}`));
        }
      } else {
        const detail = stderr.slice(-5).join(" | ");
        reject(new Error(`yt-dlp exited with code ${code}. Detail: ${detail}`));
      }
    });
  });
}
