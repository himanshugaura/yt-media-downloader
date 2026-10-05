import { z } from "zod";

const singleUrlSchema = z
  .string()
  .max(2048, "url is too long")
  .url("url must be a valid URL")
  .refine(
    (val) => val.startsWith("http://") || val.startsWith("https://"),
    "url must use http or https",
  );

/**
 * Schema for POST /api/v1/download (single media - MP3 only)
 */
export const downloadBodySchema = z.object({
  url: singleUrlSchema,
  format: z.literal("mp3").optional().default("mp3"),
});

export type DownloadBody = z.infer<typeof downloadBodySchema>;

/**
 * Schema for POST /api/v1/download/bulk and /api/v1/download/bulk/start
 */
export const bulkDownloadSchema = z.object({
  urls: z
    .array(singleUrlSchema)
    .min(1, "At least one URL must be provided")
    .max(50, "Maximum of 50 URLs permitted per bulk request"),
});

export type BulkDownloadBody = z.infer<typeof bulkDownloadSchema>;

/**
 * Schema for route params with batchId
 */
export const batchIdParamsSchema = z.object({
  batchId: z.string().min(1, "batchId is required"),
});

export type BatchIdParams = z.infer<typeof batchIdParamsSchema>;
