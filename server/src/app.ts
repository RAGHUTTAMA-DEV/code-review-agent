
import app from "./main";


async function start(){
    app.listen(process.env.PORT,()=>{
        console.log(`Server is running on port ${process.env.PORT}`)
    })
}
start(); 