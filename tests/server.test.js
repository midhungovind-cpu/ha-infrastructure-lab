import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticHandler } from '../scripts/serve.js';

test('static server serves GET/HEAD and blocks dotfiles, outside symlinks, invalid paths and writes',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'ha-server-test-')),root=join(temp,'public');
  try{
    await mkdir(root);await writeFile(join(root,'index.html'),'<h1>Lab</h1>');
    await writeFile(join(root,'.env'),'test-only');await writeFile(join(temp,'outside.txt'),'private fixture');
    await symlink(join(temp,'outside.txt'),join(root,'outside-link.txt'));
    const handler=createStaticHandler(root);
    const request=async(url,method='GET')=>{const result={};await handler({url,method},{writeHead(status,headers){Object.assign(result,{status,headers});},end(body){result.body=body?.toString();}});return result;};
    assert.equal((await request('/')).body,'<h1>Lab</h1>');assert.equal((await request('/','HEAD')).body,undefined);
    assert.equal((await request('/.env')).status,403);assert.equal((await request('/outside-link.txt')).status,403);
    assert.equal((await request('/missing')).status,404);assert.equal((await request('/%ZZ')).status,400);
    assert.equal((await request('/','POST')).status,405);
  }finally{await rm(temp,{recursive:true,force:true});}
});
