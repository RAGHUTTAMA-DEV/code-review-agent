

import express from "express";
import { webhoooksController } from "../controllers/webhooks";
const router = express.Router();


router.post("/",webhoooksController);

router.post("/test",(req:any , res:any )=>{
    console.log("Webhook receied");
    res.status(200).json({message:"success"})
      


})

export default router
