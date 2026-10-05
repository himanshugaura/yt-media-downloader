import { Router } from "express";
import downloadRoutes from "./download.routes.js";

const router = Router();

router.use("/", downloadRoutes);

export default router;
