import cors from "cors";
import express, { type Request, type Response } from "express";
import helmet from "helmet";

import { env } from "./core/config/env.js";
import { errorMiddleware } from "./core/middlewares/error.middleware.js";
import { notFoundMiddleware } from "./core/middlewares/notFound.middleware.js";
import { requestLogger } from "./core/middlewares/requestLogger.js";

import apiRoutes from "./routes/index.route.js";

const app = express();

// Trust reverse proxy headers (Render, Cloudflare) for accurate rate limiting and IP logging
app.set("trust proxy", 1);

// ── Security headers ───────────────────────────────────────────────────────
// Disable frameguard and strict CSP since this is a headless API serving media streams
app.use(
  helmet({
    contentSecurityPolicy: false,
    frameguard: false,
  }),
);

// ── CORS ───────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: env.NODE_ENV === "production" ? process.env.FRONTEND_URL ?? "*" : "*",
    methods: ["GET", "POST"],
    exposedHeaders: ["Content-Disposition"],
  }),
);

// ── Body parsing ───────────────────────────────────────────────────────────
// Keep limit small — we only accept JSON with url + format, not file uploads.
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));

// ── Request logging ────────────────────────────────────────────────────────
app.use(requestLogger);

// ── Root health probe ──────────────────────────────────────────────────────
app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({ success: true, message: "yt-media-downloader API", env: env.NODE_ENV });
});

// ── API routes ─────────────────────────────────────────────────────────────
app.use("/api/v1", apiRoutes);

// ── 404 + error handlers ───────────────────────────────────────────────────
app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;
