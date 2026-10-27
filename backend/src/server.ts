import { exec } from "child_process";
import app from "./app.js";
import { env } from "./core/config/env.js";
import { logger } from "./core/config/logger.js";
import { getCookiesFilePath } from "./services/ytdlp.service.js";

const startServer = async (): Promise<void> => {
  const server = app.listen(env.PORT, () => {
    logger.info(`Server running on http://localhost:${env.PORT} [${env.NODE_ENV}]`);
    logger.info(`yt-dlp path      : ${env.YTDLP_PATH}`);
    logger.info(`ffmpeg path      : ${env.FFMPEG_PATH}`);
    logger.info(`bulk concurrency : ${env.BULK_CONCURRENCY}`);
    logger.info(`mode             : Direct high-speed processing`);

    // Probe yt-dlp version on startup
    exec(`${env.YTDLP_PATH} --version`, (err, stdout) => {
      if (!err && stdout) {
        logger.info(`yt-dlp version   : ${stdout.trim()}`);
      }
    });

    // Run non-blocking auto-updater check to ensure yt-dlp has the latest YouTube patches
    exec(`${env.YTDLP_PATH} -U`, (err, stdout, stderr) => {
      if (err) {
        logger.debug("yt-dlp auto-update notice", { err: err.message, stderr: stderr?.trim() });
      } else if (stdout) {
        logger.info(`yt-dlp auto-update: ${stdout.trim()}`);
      }
    });

    const cookiePath = getCookiesFilePath();
    if (cookiePath) {
      logger.info(`cookies          : Enabled (${cookiePath})`);
    } else {
      logger.warn(`cookies          : None configured (anonymous requests)`);
    }
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

  process.on("uncaughtException", (error: Error & { code?: string }) => {
    if (error.code === "EPIPE" || error.code === "ECONNRESET") {
      logger.debug(`Ignored client socket disconnect exception: ${error.code}`);
      return;
    }
    logger.error("Uncaught Exception", { error: error.message, stack: error.stack });
  });

  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("Unhandled Rejection", { reason });
  });
};

startServer().catch((error: unknown) => {
  logger.error("Failed to start server", { error });
  process.exit(1);
});
