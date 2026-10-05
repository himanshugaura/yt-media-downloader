import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { env } from "../../core/config/env.js";
import { logger } from "../../core/config/logger.js";
import ApiError from "../../shared/utils/ApiError.js";

type ErrorDetail = {
  path?: string;
  message: string;
};

export const errorMiddleware = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const errorMessage = error instanceof Error ? error.message : "Unknown error";
  const stack = error instanceof Error ? error.stack : undefined;
  const isDev = env.NODE_ENV === "development";

  let statusCode = 500;
  let message: string = isDev ? errorMessage : "Internal Server Error";
  let errors: ErrorDetail[] = [];
  let isOperational = false;

  // ── Handled application errors ──────────────────────────────────────────
  if (error instanceof ApiError) {
    statusCode = error.statusCode;
    message = error.message;
    errors = error.errors as ErrorDetail[];
    isOperational = true;
  }

  // ── Zod validation errors ───────────────────────────────────────────────
  else if (error instanceof ZodError) {
    statusCode = 400;
    message = "Validation failed";
    errors = error.issues.map((issue) => ({
      path: issue.path.join(".") || "root",
      message: issue.message,
    }));
    isOperational = true;
  }

  // ── Unknown / unhandled errors ──────────────────────────────────────────
  else {
    statusCode = 500;
    message = isDev ? errorMessage : "Internal Server Error";
    isOperational = false;
  }

  const responseStatusCode = isOperational ? statusCode : 500;
  const responseMessage = !isDev && !isOperational ? "Internal Server Error" : message;

  const logMeta = {
    statusCode: responseStatusCode,
    method: req.method,
    route: req.originalUrl,
    errorName: error instanceof Error ? error.name : "UnknownError",
  };

  if (isOperational) {
    logger.warn(`Operational error: ${message}`, { ...logMeta, errors });
  } else {
    logger.error(`Unhandled error: ${errorMessage}`, { ...logMeta, stack, error });
  }

  res.status(responseStatusCode).json({
    success: false,
    message: responseMessage,
    ...(errors.length > 0 ? { errors } : {}),
  });
};