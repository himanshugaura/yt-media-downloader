import cors from "cors";
import express, { type Request, type Response } from "express";
import helmet from "helmet";

import { env } from "./core/config/env.js";
import { errorMiddleware } from "./core/middlewares/error.middleware.js";
import { notFoundMiddleware } from "./core/middlewares/notFound.middleware.js";
import { requestLogger } from "./core/middlewares/requestLogger.js";

import apiRoutes from "./routes/index.route.js";

const app = express();

// ── Security headers ───────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ───────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: env.NODE_ENV === "production" ? process.env.FRONTEND_URL ?? "*" : "*",
    methods: ["GET", "POST"],
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
