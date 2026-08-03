import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const root=resolve(process.cwd());
const requestedPort=Number(process.env.PORT||process.argv[2]||4173);
if(!Number.isInteger(requestedPort)||requestedPort<1||requestedPort>65535)throw new Error("PORT must be an integer between 1 and 65535");

const contentTypes={
  ".css":"text/css; charset=utf-8",
  ".gif":"image/gif",
  ".html":"text/html; charset=utf-8",
  ".ico":"image/x-icon",
  ".js":"text/javascript; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".md":"text/markdown; charset=utf-8",
  ".png":"image/png",
  ".svg":"image/svg+xml; charset=utf-8",
  ".webp":"image/webp"
};

const server=createServer(async(request,response)=>{
  try{
    const pathname=decodeURIComponent(new URL(request.url||"/","http://127.0.0.1").pathname);
    const relative=pathname.replace(/^\/+/,"")||"index.html";
    let file=resolve(root,relative);
    if(file!==root&&!file.startsWith(`${root}${sep}`)){response.writeHead(403);response.end("Forbidden");return;}
    if((await stat(file)).isDirectory())file=join(file,"index.html");
    const body=await readFile(file);
    response.writeHead(200,{"Content-Type":contentTypes[extname(file).toLowerCase()]||"application/octet-stream","Cache-Control":"no-store"});
    if(request.method==="HEAD")response.end();else response.end(body);
  }catch(error){
    const status=error?.code==="ENOENT"?404:400;response.writeHead(status,{"Content-Type":"text/plain; charset=utf-8"});response.end(status===404?"Not found":"Bad request");
  }
});

server.listen(requestedPort,"127.0.0.1",()=>console.log(`HA Infrastructure Lab available at http://127.0.0.1:${requestedPort}`));
