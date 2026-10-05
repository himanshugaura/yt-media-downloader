"use client";

import { useEffect, useState, useRef } from "react";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api/v1";

interface BulkItemProgress {
  url: string;
  title?: string;
  status: "waiting" | "processing" | "completed" | "failed";
  error?: string;
}

interface BulkProgressState {
  batchId: string;
  total: number;
  completed: number;
  failed: number;
  processing: number;
  waiting: number;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "ABORTED";
  items: BulkItemProgress[];
}

interface VideoInfo {
  title: string;
  author?: string;
  durationSeconds?: number;
  formattedDuration?: string;
  approxSizeBytes?: number;
  formattedSize?: string;
  thumbnailUrl?: string;
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<"single" | "bulk">("single");

  // Single download state
  const [url, setUrl] = useState("");
  const [singleError, setSingleError] = useState<string | null>(null);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [isLoadingInfo, setIsLoadingInfo] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  // Bulk download state
  const [bulkUrlsText, setBulkUrlsText] = useState("");
  const [bulkProgress, setBulkProgress] = useState<BulkProgressState | null>(null);
  const [isStartingBulk, setIsStartingBulk] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch video preview & estimated file size on URL input
  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed || (!trimmed.includes("youtube.com") && !trimmed.includes("youtu.be"))) {
      return;
    }

    let active = true;

    const timer = setTimeout(async () => {
      try {
        if (active) setIsLoadingInfo(true);
        const res = await fetch(`${API_BASE_URL}/info?url=${encodeURIComponent(trimmed)}`);
        if (res.ok) {
          const data = await res.json();
          if (active && data.success && data.data) {
            setVideoInfo(data.data);
          }
        }
      } catch {
        // ignore
      } finally {
        if (active) {
          setIsLoadingInfo(false);
        }
      }
    }, 400);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [url]);

  // ── Handle Single Download ──────────────────────────────────────────────
  const handleSingleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUrl = url.trim();
    if (!cleanUrl) return;

    if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
      setSingleError("URL must begin with http:// or https://");
      return;
    }

    setSingleError(null);
    setIsDownloading(true);

    try {
      const downloadUrl = `${API_BASE_URL}/download?url=${encodeURIComponent(cleanUrl)}`;
      const res = await fetch(downloadUrl);

      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        const msg = errorData?.message || `Download failed with HTTP ${res.status}`;
        throw new Error(msg);
      }

      // Read filename from Content-Disposition header if available
      let filename = videoInfo?.title ? `${videoInfo.title}.mp3` : "audio.mp3";
      const disposition = res.headers.get("Content-Disposition");
      if (disposition) {
        const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        const asciiMatch = disposition.match(/filename="([^"]+)"/i);
        if (utf8Match && utf8Match[1]) {
          filename = decodeURIComponent(utf8Match[1]);
        } else if (asciiMatch && asciiMatch[1]) {
          filename = asciiMatch[1];
        }
      }

      if (!filename.toLowerCase().endsWith(".mp3")) {
        filename += ".mp3";
      }

      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(blobUrl);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to download audio.";
      setSingleError(message);
    } finally {
      setIsDownloading(false);
    }
  };

  // ── Handle Bulk Download ────────────────────────────────────────────────
  const parsedBulkUrls = bulkUrlsText
    .split("\n")
    .map((u) => u.trim())
    .filter((u) => u.length > 0 && (u.startsWith("http://") || u.startsWith("https://")));

  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (parsedBulkUrls.length === 0) return;

    setBulkError(null);
    setIsStartingBulk(true);
    setBulkProgress(null);

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    try {
      const res = await fetch(`${API_BASE_URL}/download/bulk/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: parsedBulkUrls }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        const msg =
          data?.errors?.[0]?.message ||
          data?.message ||
          "Failed to start bulk download session.";
        throw new Error(msg);
      }

      const { batchId } = data.data;

      // Connect to SSE stream
      const sse = new EventSource(`${API_BASE_URL}/download/bulk/${batchId}/events`);
      eventSourceRef.current = sse;

      sse.onmessage = (event) => {
        try {
          const update: BulkProgressState = JSON.parse(event.data);
          setBulkProgress(update);

          if (update.status === "COMPLETED") {
            sse.close();
            // Automatically trigger ZIP download
            const directZipUrl = `${API_BASE_URL}/download/bulk/${batchId}/file`;
            const a = document.createElement("a");
            a.href = directZipUrl;
            a.download = "youtube-audio-bundle.zip";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          } else if (update.status === "FAILED" || update.status === "ABORTED") {
            sse.close();
          }
        } catch (err) {
          console.error("SSE parse error", err);
        }
      };

      sse.onerror = () => {
        sse.close();
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setBulkError(message);
    } finally {
      setIsStartingBulk(false);
    }
  };

  const cancelBulkDownload = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setBulkProgress(null);
  };

  return (
    <main className="flex flex-col min-h-screen items-center justify-between p-4 sm:p-8">
      {/* Top Header */}
      <header className="w-full max-w-2xl flex items-center py-4 border-b border-zinc-800/80">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-rose-600 flex items-center justify-center text-white shadow-md shadow-rose-600/30">
            <svg
              className="w-4 h-4 fill-current"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z" />
            </svg>
          </div>
          <span className="font-semibold text-lg tracking-tight text-zinc-100">
            YouTube MP3 Downloader
          </span>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="w-full max-w-xl my-auto py-10 flex flex-col gap-6">
        {/* Title */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight bg-gradient-to-br from-zinc-100 via-zinc-200 to-zinc-400 bg-clip-text text-transparent">
            YouTube to MP3
          </h1>
          <p className="text-sm text-zinc-400 max-w-md mx-auto">
            Convert and download YouTube videos to high-quality audio.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex bg-zinc-900/80 p-1 rounded-xl border border-zinc-800/80">
          <button
            type="button"
            onClick={() => setActiveTab("single")}
            className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all ${
              activeTab === "single"
                ? "bg-zinc-800 text-zinc-100 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Single Video
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("bulk")}
            className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all ${
              activeTab === "bulk"
                ? "bg-zinc-800 text-zinc-100 shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Bulk Download
          </button>
        </div>

        {/* Tab 1: Single Download Card */}
        {activeTab === "single" && (
          <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-5 sm:p-6 shadow-xl backdrop-blur-sm">
            <form onSubmit={handleSingleSubmit} className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <label htmlFor="yt-url" className="text-xs font-medium text-zinc-400">
                  YouTube Video URL
                </label>
                <div className="relative flex items-center">
                  <input
                    id="yt-url"
                    type="text"
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      if (!e.target.value.trim()) {
                        setVideoInfo(null);
                      }
                    }}
                    className="w-full bg-zinc-950/80 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-rose-500/80 focus:ring-1 focus:ring-rose-500/50 transition-all font-mono"
                    required
                  />
                  {url && (
                    <button
                      type="button"
                      onClick={() => {
                        setUrl("");
                        setVideoInfo(null);
                      }}
                      className="absolute right-3 text-zinc-500 hover:text-zinc-300 text-xs"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Video Info Preview & Estimated Size Card */}
              {isLoadingInfo && !videoInfo && (
                <div className="flex items-center gap-2.5 p-3 bg-zinc-950/50 border border-zinc-800/60 rounded-xl text-xs text-zinc-400 font-mono animate-pulse">
                  <div className="w-3.5 h-3.5 border-2 border-rose-500/30 border-t-rose-500 rounded-full animate-spin" />
                  <span>Loading video details & size...</span>
                </div>
              )}

              {videoInfo && (
                <div className="flex items-center gap-3 p-3 bg-zinc-950/70 border border-zinc-800/80 rounded-xl animate-in fade-in duration-200">
                  {videoInfo.thumbnailUrl && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={videoInfo.thumbnailUrl}
                      alt="Thumbnail"
                      className="w-16 h-10 object-cover rounded-md border border-zinc-800 shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-zinc-200 truncate">
                      {videoInfo.title}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-400 font-mono">
                      {videoInfo.formattedDuration && (
                        <span>{videoInfo.formattedDuration}</span>
                      )}
                      {videoInfo.formattedDuration && videoInfo.formattedSize && (
                        <span>•</span>
                      )}
                      {videoInfo.formattedSize && (
                        <span className="text-rose-400 font-semibold">
                          {videoInfo.formattedSize}
                        </span>
                      )}
                      <span>•</span>
                      <span className="text-zinc-500">192 kbps MP3</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Action Button with Stateful Loading */}
              <button
                type="submit"
                disabled={!url.trim() || isDownloading}
                className="mt-2 w-full py-3 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white font-medium text-sm flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-rose-600/25"
              >
                {isDownloading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Downloading MP3...</span>
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z" />
                    </svg>
                    <span>Download MP3 Directly</span>
                  </>
                )}
              </button>
            </form>

            {singleError && (
              <div className="mt-4 p-3.5 bg-rose-950/40 border border-rose-800/60 rounded-xl text-rose-300 text-xs flex items-start gap-2.5">
                <svg className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
                </svg>
                <div className="flex-1">
                  <span className="font-semibold block mb-0.5">Download Failed</span>
                  <span className="text-rose-300/90">{singleError}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Bulk MP3 Download Card */}
        {activeTab === "bulk" && (
          <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-5 sm:p-6 shadow-xl backdrop-blur-sm flex flex-col gap-4">
            <form onSubmit={handleBulkSubmit} className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="bulk-urls" className="text-xs font-medium text-zinc-400">
                    YouTube URLs (one per line)
                  </label>
                  <span className="text-[11px] font-mono text-zinc-500">
                    {parsedBulkUrls.length} valid URL{parsedBulkUrls.length === 1 ? "" : "s"}
                  </span>
                </div>
                <textarea
                  id="bulk-urls"
                  rows={5}
                  placeholder={`https://www.youtube.com/watch?v=...\nhttps://www.youtube.com/watch?v=...\nhttps://youtu.be/...`}
                  value={bulkUrlsText}
                  onChange={(e) => setBulkUrlsText(e.target.value)}
                  disabled={bulkProgress !== null && bulkProgress.status === "RUNNING"}
                  className="w-full bg-zinc-950/80 border border-zinc-800 rounded-xl px-4 py-3 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-rose-500/80 focus:ring-1 focus:ring-rose-500/50 transition-all font-mono leading-relaxed resize-none"
                  required
                />
              </div>

              {/* Action Buttons */}
              {bulkProgress && bulkProgress.status === "RUNNING" ? (
                <button
                  type="button"
                  onClick={cancelBulkDownload}
                  className="w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-rose-950/60 hover:text-rose-300 text-zinc-300 font-medium text-xs transition-all border border-zinc-700/60"
                >
                  Cancel Bulk Download
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={isStartingBulk || parsedBulkUrls.length === 0}
                  className="w-full py-3 px-4 rounded-xl bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white font-medium text-sm flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-rose-600/25"
                >
                  {isStartingBulk ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Preparing downloads...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z" />
                      </svg>
                      <span>
                        Download All as ZIP ({parsedBulkUrls.length} Audio Files)
                      </span>
                    </>
                  )}
                </button>
              )}
            </form>

            {bulkError && (
              <div className="p-3.5 bg-rose-950/40 border border-rose-800/60 rounded-xl text-rose-300 text-xs">
                {bulkError}
              </div>
            )}

            {/* Live Bulk Progress Card */}
            {bulkProgress && (
              <div className="mt-2 space-y-4 pt-3 border-t border-zinc-800/80 animate-in fade-in duration-200">
                {/* Stats row */}
                <div className="grid grid-cols-4 gap-2 text-center text-xs font-mono">
                  <div className="bg-zinc-950/60 p-2 rounded-lg border border-zinc-800/60">
                    <div className="text-zinc-500 text-[10px]">TOTAL</div>
                    <div className="font-semibold text-zinc-200">{bulkProgress.total}</div>
                  </div>
                  <div className="bg-emerald-950/30 p-2 rounded-lg border border-emerald-900/40">
                    <div className="text-emerald-500 text-[10px]">DONE</div>
                    <div className="font-semibold text-emerald-300">{bulkProgress.completed}</div>
                  </div>
                  <div className="bg-amber-950/30 p-2 rounded-lg border border-amber-900/40">
                    <div className="text-amber-500 text-[10px]">ACTIVE</div>
                    <div className="font-semibold text-amber-300">{bulkProgress.processing}</div>
                  </div>
                  <div className="bg-zinc-950/60 p-2 rounded-lg border border-zinc-800/60">
                    <div className="text-zinc-500 text-[10px]">WAITING</div>
                    <div className="font-semibold text-zinc-400">{bulkProgress.waiting}</div>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="space-y-1">
                  <div className="w-full bg-zinc-950 h-2 rounded-full overflow-hidden border border-zinc-800/80">
                    <div
                      className="bg-gradient-to-r from-rose-600 to-emerald-500 h-full rounded-full transition-all duration-300 ease-out"
                      style={{
                        width: `${Math.round(
                          ((bulkProgress.completed + bulkProgress.failed) / bulkProgress.total) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-[11px] font-mono text-zinc-500">
                    <span>
                      {bulkProgress.status === "COMPLETED"
                        ? "All finished! Generated ZIP downloaded."
                        : `Processing ${bulkProgress.processing} tracks...`}
                    </span>
                    <span>
                      {Math.round(
                        ((bulkProgress.completed + bulkProgress.failed) / bulkProgress.total) * 100,
                      )}
                      %
                    </span>
                  </div>
                </div>

                {/* Individual item status list */}
                <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 divide-y divide-zinc-800/40">
                  {bulkProgress.items.map((item, idx) => (
                    <div
                      key={idx}
                      className="pt-1.5 flex items-center justify-between text-xs font-mono"
                    >
                      <div className="truncate mr-2 text-zinc-300">
                        {item.title || item.url}
                      </div>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded uppercase font-semibold shrink-0 ${
                          item.status === "completed"
                            ? "bg-emerald-950/60 text-emerald-400 border border-emerald-800/50"
                            : item.status === "processing"
                            ? "bg-amber-950/60 text-amber-300 border border-amber-800/50 animate-pulse"
                            : item.status === "failed"
                            ? "bg-rose-950/60 text-rose-400 border border-rose-800/50"
                            : "bg-zinc-800 text-zinc-500"
                        }`}
                      >
                        {item.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="w-full max-w-2xl py-4 border-t border-zinc-900 text-center text-xs text-zinc-600">
        YouTube MP3 Downloader • High Quality Audio
      </footer>
    </main>
  );
}
