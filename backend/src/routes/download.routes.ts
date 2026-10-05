import { Router } from "express";
import rateLimit from "express-rate-limit";

import {
  singleDownloadController,
  videoInfoController,
  directBulkDownloadController,
  startBulkSessionController,
  bulkEventsController,
  bulkDownloadFileController,
  healthController,
} from "../controllers/download.controller.js";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../core/middlewares/validateRequest.middleware.js";
import {
  downloadBodySchema,
  bulkDownloadSchema,
  batchIdParamsSchema,
} from "../validators/download.validator.js";
import CatchAsync from "../shared/utils/CatchAsync.js";

const router = Router();

// In-process rate limiter: 30 requests per 5 minutes per IP
const downloadRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Rate limit reached. Please wait a few moments before requesting more downloads.",
  },
});

/**
 * GET /api/v1/health
 * Simple health probe.
 */
router.get("/health", CatchAsync(healthController));

/**
 * GET /api/v1/info?url=...
 * Fetch video metadata (title, duration, approx MP3 size, thumbnail).
 */
router.get("/info", CatchAsync(videoInfoController));

/**
 * POST /api/v1/download
 * Single media download (MP3). Directly streams file to browser.
 */
router.post(
  "/download",
  downloadRateLimiter,
  validateBody(downloadBodySchema),
  CatchAsync(singleDownloadController),
);

/**
 * GET /api/v1/download?url=...
 * Direct browser link download endpoint without client-side blob memory buffering.
 */
router.get(
  "/download",
  downloadRateLimiter,
  validateQuery(downloadBodySchema),
  CatchAsync(singleDownloadController),
);

/**
 * POST /api/v1/download/bulk
 * Direct bulk MP3 download. Directly streams ZIP to browser.
 */
router.post(
  "/download/bulk",
  downloadRateLimiter,
  validateBody(bulkDownloadSchema),
  CatchAsync(directBulkDownloadController),
);

/**
 * POST /api/v1/download/bulk/start
 * Initializes a bulk download session with live progress tracking.
 */
router.post(
  "/download/bulk/start",
  downloadRateLimiter,
  validateBody(bulkDownloadSchema),
  CatchAsync(startBulkSessionController),
);

/**
 * GET /api/v1/download/bulk/:batchId/events
 * SSE stream providing real-time progress for a bulk session.
 */
router.get(
  "/download/bulk/:batchId/events",
  validateParams(batchIdParamsSchema),
  CatchAsync(bulkEventsController),
);

/**
 * GET /api/v1/download/bulk/:batchId/file
 * Downloads the generated ZIP file for a bulk session and cleans up disk.
 */
router.get(
  "/download/bulk/:batchId/file",
  validateParams(batchIdParamsSchema),
  CatchAsync(bulkDownloadFileController),
);

export default router;
