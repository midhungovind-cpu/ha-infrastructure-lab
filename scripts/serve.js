import { createServer } from "node:http";
import { readFile, stat, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

export function createStaticHandler(directory){
 const root=resolve(directory);
 return async(request,response)=>{
  try{
    if(!["GET","HEAD"].includes(request.method)){response.writeHead(405,{Allow:"GET, HEAD"});response.end("Method not allowed");return;}
    const pathname=decodeURIComponent(new URL(request.url||"/","http://127.0.0.1").pathname);
    const relative=pathname.replace(/^\/+/,"")||"index.html";
    if(relative.split("/").some(part=>part.startsWith("."))){response.writeHead(403);response.end("Forbidden");return;}
    let file=resolve(root,relative);
    if(file!==root&&!file.startsWith(`${root}${sep}`)){response.writeHead(403);response.end("Forbidden");return;}
    if((await stat(file)).isDirectory())file=join(file,"index.html");
    const actual=await realpath(file),actualRoot=await realpath(root);
    if(!actual.startsWith(`${actualRoot}${sep}`)){response.writeHead(403);response.end("Forbidden");return;}
    const body=await readFile(file);
    response.writeHead(200,{"Content-Type":contentTypes[extname(file).toLowerCase()]||"application/octet-stream","Cache-Control":"no-store"});
    if(request.method==="HEAD")response.end();else response.end(body);
  }catch(error){
    const status=error?.code==="ENOENT"?404:400;response.writeHead(status,{"Content-Type":"text/plain; charset=utf-8"});response.end(status===404?"Not found":"Bad request");
  }
 };
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const server=createServer(createStaticHandler(root));
 server.listen(requestedPort,"127.0.0.1",()=>console.log(`HA Infrastructure Lab available at http://127.0.0.1:${requestedPort}`));
}
