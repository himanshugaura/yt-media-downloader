import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(5000),

  // Media Tool Paths
  YTDLP_PATH: z.string().default("yt-dlp"),
  FFMPEG_PATH: z.string().default("ffmpeg"),

  // In-process Concurrency Limiter
  BULK_CONCURRENCY: z.coerce.number().default(2),
  DOWNLOAD_TIMEOUT_MS: z.coerce.number().default(10 * 60 * 1000), // 10 min

  // Storage scratch path for media downloads
  TEMP_DIR: z.string().optional(),

  // Frontend URL for CORS
  FRONTEND_URL: z.string().default("http://localhost:3000"),

  // Optional YouTube cookies content or file path for cloud/Render bypass
  YOUTUBE_COOKIES: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment variables: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
}

export const env = parsed.data;
