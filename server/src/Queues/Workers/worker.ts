import { Worker } from "bullmq";

const reviewWorker = new Worker("reviewQueue",async (job)=>{

    console.log("Job Data: ",job.data);

    return job;
})
reviewWorker.on("error",(error)=>{
    console.log("Job Failed: ",error);
}) 
reviewWorker.on("completed",(job)=>{
    console.log("Job Completed: ",job);
})      
reviewWorker.run();
