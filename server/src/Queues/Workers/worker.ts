import { Worker } from "bullmq";

const reviewWorker = new Worker("reviewQueue",async (job)=>{

    console.log("Job Data: ",job.data);

    return job;
},{
    connection : {
       host: process.env.REDIS_HOST || 'localhost',
       port: parseInt(process.env.REDIS_PORT || '6379') ,
    }
})
reviewWorker.on("error",(error)=>{
    console.log("Job Failed: ",error);
}) 
reviewWorker.on("completed",(job)=>{
    console.log("Job Completed: ",job);
})      
