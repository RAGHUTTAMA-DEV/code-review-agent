
import {Request,Response} from "express"
import {reviewQueue} from "../Queues/Producers/producer"
export const webhoooksController = async (req:Request,res:Response)=>{
    
   try{
  const {repo,prNumber,headSha,action} = req.body;
    
    const queueJob = await reviewQueue.add("reviewJob",{
        repo,prNumber,headSha,action 
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