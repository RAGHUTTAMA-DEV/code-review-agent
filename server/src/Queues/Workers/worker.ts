import { Worker } from "bullmq";
import { Octokit } from "octokit";
import { processPRDiff } from "../../services/github/processPR";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const reviewWorker = new Worker("reviewQueue",async (job)=>{
    const { repo, prNumber, headSha, action } = job.data;
    console.log(`Processing PR #${prNumber} for ${repo}`);
    
    let diffChunks: any[] = [];
    try {
        const [owner, repoName] = repo.split("/");
        diffChunks = await processPRDiff(octokit, owner, repoName, prNumber, headSha);
        console.log(`Extracted ${diffChunks.length} function chunks from the PR diff`);
    } catch (e) {
        console.error("Error processing PR diff:", e);
    }

    return {
      success: true,
      prNumber: job.data.prNumber,
      chunksProcessed: diffChunks.length
    };
},{
    connection : {
       host: process.env.REDIS_HOST || 'localhost',
       port: parseInt(process.env.REDIS_PORT || '6379') ,
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 1000 }, 
})
reviewWorker.on("error",(error)=>{
    console.log("Job Failed: ",error);
}) 
reviewWorker.on("completed",(job, result)=>{
    console.log(`Job ${job.id} Completed with result:`, result);
})      
