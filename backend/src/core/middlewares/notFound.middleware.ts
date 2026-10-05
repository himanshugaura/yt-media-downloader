import type { Request, Response, NextFunction } from "express";

import ApiError from "../../shared/utils/ApiError.js";

export const notFoundMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};
