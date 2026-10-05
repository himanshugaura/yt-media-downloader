# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Build TypeScript
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package manifests
COPY package.json pnpm-lock.yaml ./

# Install all dependencies for compilation
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy tsconfig and source code
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript
RUN pnpm build

# Prune devDependencies to keep production image light
RUN pnpm prune --prod

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Production image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS production

# ── System dependencies ───────────────────────────────────────────────────
# FFmpeg for audio/video processing + curl for yt-dlp standalone binary
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       ca-certificates \
       curl \
    && rm -rf /var/lib/apt/lists/*

# ── yt-dlp standalone binary ──────────────────────────────────────────────
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
        -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# Verify tools are functional at build time
RUN yt-dlp --version
RUN ffmpeg -version | head -1

# ── Node Application ───────────────────────────────────────────────────────
WORKDIR /app

# Copy production artifacts
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Create dedicated scratch directory for disk-backed media operations
RUN mkdir -p /app/storage/tmp && chmod 777 /app/storage/tmp

# ── Runtime Environment ───────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PORT=5000
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=ffmpeg
ENV BULK_CONCURRENCY=2
ENV DOWNLOAD_TIMEOUT_MS=600000
ENV TEMP_DIR=/app/storage/tmp

EXPOSE 5000

# Health check probe
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/api/v1/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "dist/server.js"]
