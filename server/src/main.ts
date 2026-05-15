import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { verifyHash } from "./verifyHash";
import webhooks from "./routes/webhooks"
const app = express();
app.use(express.json());

app.use(
    express.json({
        verify: (req: any, res: any, buf: Buffer) => {
            const sig = req.headers['x-hub-signature-256'] as string;
            const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
            if (!verifyHash(buf, sig, secret)) {
                throw new Error('Invalid webhook signature');
            }
        }
    })
)


app.get("/", (req, res) => {
    res.send("Server is running dude ")
})
app.use("/webhooks", webhooks)

export default app; 