
import {Request,Response} from "express"
import {reviewQueue} from "../Queues/Producers/producer"
export const webhoooksController = async (req:Request,res:Response)=>{
     
   try{
  const event = req.headers["x-github-event"] as string | undefined;

  // Only process pull_request events; acknowledge everything else (push, ping, etc.)
  if (event && event !== "pull_request") {
    console.log(`Ignoring GitHub event: ${event}`);
    res.status(200).json({ message: `Event '${event}' ignored` });
    return;
  }

  const payload = req.body;
  const action = payload.action;
  // Support both GitHub's nested payload and flat test payloads
  const repo = payload.repository?.full_name ?? payload.repo;
  const prNumber = payload.number ?? payload.pull_request?.number ?? payload.prNumber;
  const headSha = payload.pull_request?.head?.sha ?? payload.headSha;

  if (!repo || !prNumber || !headSha) {
    res.status(400).json({ message: "Missing required fdsields", repo, prNumber, headSha });
    return;
  }

    const queueJob = await reviewQueue.add("reviewJob",{
        repo, prNumber, headSha, action 
    })

    res.status(202).json({message:"Job Added",jobId:queueJob.id,repo,prNumber})   
   }catch(error){
     if (error instanceof Error){
       res.status(500).json({message:error.message})
     }else{
       res.status(500).json({message:"Something went wrong"})
     }
   }
}