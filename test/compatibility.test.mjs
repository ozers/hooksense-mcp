import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const decode=result=>JSON.parse(result.content[0].text);
test('MCP stdio protocol and current REST contract',async t=>{
  const calls=[];let renameFails=false;
  const endpoint={id:'ep-1',slug:'generated',createdAt:'2026-10-06T00:00:00.000Z'};
  const server=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    calls.push({url:req.url,method:req.method,auth:req.headers.authorization,body:body?JSON.parse(body):null});
    res.setHeader('Content-Type','application/json');
    if(req.method==='PATCH') {
      if(renameFails){res.statusCode=403;res.end('{"error":"Custom URLs require Hook plan or above"}');}
      else res.end(JSON.stringify({...endpoint,slug:JSON.parse(body).slug}));
    } else if(req.url==='/api/endpoints'&&req.method==='POST')res.end(JSON.stringify(endpoint));
    else if(req.url.includes('/wait'))res.end(JSON.stringify({status:'received',request:{id:'req-1',receivedAt:endpoint.createdAt,body:'already arrived'}}));
    else res.end(JSON.stringify({ok:true}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const clients=[];
  const connect=async(token)=>{
    const client=new Client({name:'test',version:'1.0.0'});
    const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{PATH:process.env.PATH,HOOKSENSE_API:base,HOOKSENSE_TOKEN:token},stderr:'pipe'});
    await client.connect(transport);clients.push(client);return client;
  };
  t.after(async()=>{for(const client of clients)await client.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const client=await connect('hsk_test');
  await t.test('lists eight tools without credentials, but rejects calls',async()=>{
    const anonymous=await connect('');assert.equal((await anonymous.listTools()).tools.length,8);
    assert.equal((await anonymous.callTool({name:'list_endpoints',arguments:{}})).isError,true);
  });
  await t.test('custom slug uses PATCH and creation supplies first-wait cursor',async()=>{
    const result=decode(await client.callTool({name:'create_callback_endpoint',arguments:{slug:'my-job'}}));
    assert.equal(result.slug,'my-job');assert.equal(result.after,endpoint.createdAt);
    assert.equal(result.callbackUrl,base+'/w/my-job');
    assert.deepEqual(calls.slice(-2).map(c=>c.method),['POST','PATCH']);
    assert.ok(calls.every(c=>c.auth==='Bearer hsk_test'));
  });
  await t.test('failed rename reports existing endpoint instead of hiding partial creation',async()=>{
    renameFails=true;const result=await client.callTool({name:'create_callback_endpoint',arguments:{slug:'paid-job'}});renameFails=false;
    assert.equal(result.isError,true);assert.match(result.content[0].text,/Endpoint generated was created/);
  });
  await t.test('cursor, timeout, and already-arrived callback survive the tool boundary',async()=>{
    const result=decode(await client.callTool({name:'wait_for_callback',arguments:{slug:'my-job',after:endpoint.createdAt,timeoutMs:1000}}));
    const url=new URL(calls.at(-1).url,base);assert.equal(url.searchParams.get('after'),endpoint.createdAt);assert.equal(url.searchParams.get('timeout'),'1000');assert.equal(result.request.body,'already arrived');
  });
  await t.test('all remaining tools use the documented API routes',async()=>{
    for(const [name,args,path] of [
      ['list_endpoints',{},'/api/endpoints'],
      ['get_endpoint',{slug:'my-job'},'/api/endpoints/my-job'],
      ['list_callbacks',{slug:'my-job',limit:7},'/api/endpoints/my-job/requests?limit=7'],
      ['get_callback_payload',{requestId:'req-1'},'/api/requests/req-1'],
      ['verify_signature',{slug:'my-job',requestId:'req-1'},'/api/endpoints/my-job/verify/req-1'],
      ['replay_callback',{requestId:'req-1',targetUrl:'https://example.com/hook'},'/api/requests/req-1/replay']
    ]){assert.ok(!(await client.callTool({name,arguments:args})).isError);assert.equal(calls.at(-1).url,path);}
  });
  await t.test('bad arguments never reach the API',async()=>{
    const count=calls.length;
    for(const [name,args] of [['get_endpoint',{}],['list_callbacks',{slug:'my-job',limit:1.5}],['wait_for_callback',{slug:'my-job',after:'not-a-date'}],['create_callback_endpoint',{slug:'../bad'}]]){
      assert.equal((await client.callTool({name,arguments:args})).isError,true);
    }
    assert.equal(calls.length,count);
  });
});
