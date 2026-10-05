import app from "./app.js";
import { env } from "./core/config/env.js";
import { logger } from "./core/config/logger.js";

const startServer = async (): Promise<void> => {
  const server = app.listen(env.PORT, () => {
    logger.info(`Server running on http://localhost:${env.PORT} [${env.NODE_ENV}]`);
    logger.info(`yt-dlp path      : ${env.YTDLP_PATH}`);
    logger.info(`ffmpeg path      : ${env.FFMPEG_PATH}`);
    logger.info(`bulk concurrency : ${env.BULK_CONCURRENCY}`);
    logger.info(`mode             : Direct high-speed processing`);
  });

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down HTTP server...`);
    server.close(() => {
      logger.info("HTTP server closed.");
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

startServer().catch((error: unknown) => {
  logger.error("Failed to start server", { error });
  process.exit(1);
});
