

import express from "express";
import { webhoooksController } from "../controllers/webhooks";
const router = express.Router();


router.post("/webhook",webhoooksController);

router.post("/test",(req:any , res:any )=>{
          


})

export default router
