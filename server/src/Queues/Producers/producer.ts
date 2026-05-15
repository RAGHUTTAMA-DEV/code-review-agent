import {Queue} from "bullmq"

export const reviewQueue = new Queue("reviewQueue",{
    connection : {
       host: process.env.REDIS_HOST,
       port: Number(process.env.REDIS_PORT),
    }
});
