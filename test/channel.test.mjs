import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { test, after } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Entirely synthetic. Never read the developer's Accio home or credentials.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'accio-mcp-test-'));
const state = path.join(temporary, 'state');
const home = path.join(temporary, 'accio');
fs.mkdirSync(state);
const config = {version:1, stores:{
  shop_alpha:{loginId:'fixture_alpha',name:'示例权限 Alpha',label:'Shop Alpha',aliId:'100001'},
  shop_beta:{loginId:'fixture_beta',name:'示例权限 Beta',label:'Shop Beta',aliId:'100002'},
}};
fs.writeFileSync(path.join(state,'stores.json'), JSON.stringify(config));
process.env.ACCIO_CHANNEL_STATE_DIR = state;
process.env.ACCIO_HOME = home;
const channel = await import('../channel.mjs');

test('configuration supports a variable number of distinct stores', () => {
  for (const count of [1,2,4]) {
    const stores = Object.fromEntries(Array.from({length:count}, (_,i) => [`shop_${i}`,
      {loginId:`fixture_${i}`,name:`Fixture ${i}`,label:`Shop ${i}`,aliId:String(100010+i)}]));
    assert.equal(Object.keys(channel.validateStores({version:1,stores})).length,count);
  }
  const duplicate = structuredClone(config);
  duplicate.stores.shop_beta.aliId = duplicate.stores.shop_alpha.aliId;
  assert.throws(() => channel.validateStores(duplicate), /TARGETS_NOT_DISTINCT/);
  assert.throws(() => channel.validateStores({version:1,stores:{}}), /EMPTY/);
});

const query = {accountQueryParam:{startDate:'2026-01-01',endDate:'2026-01-02',statisticsType:'day'}};
test('allowlist and argument validation reject writes and target overrides', () => {
  channel.validateArguments('subaccount_query',{});
  channel.validateArguments('query_user_category',{locale:'en_US'});
  channel.validateArguments('data_advisor_account_summary',query);
  for (const [tool,args] of [
    ['publish_product',{}], ['subaccount_query',{store:'shop_beta'}],
    ['query_user_category',{connectId:'alibaba:fixture_other'}],
    ['query_user_category',{locale:42}],
    ['data_advisor_account_summary',{...query,store:'shop_beta'}],
    ['data_advisor_account_summary',{accountQueryParam:{...query.accountQueryParam,startDate:'2026-02-30'}}],
    ['data_advisor_account_summary',{accountQueryParam:{...query.accountQueryParam,endDate:'2025-12-31'}}],
    ['data_advisor_account_summary',{accountQueryParam:{...query.accountQueryParam,statisticsType:'all'}}],
  ]) assert.throws(() => channel.validateArguments(tool,args));
});

const identity = aliId => ({structuredContent:{success:true,data:[{admin:true,self:true,aliId}]}});
test('seller identity requires exactly one matching admin', () => {
  assert.equal(channel.verifyIdentity('shop_alpha',identity('100001')).matched,true);
  assert.throws(() => channel.verifyIdentity('shop_alpha',identity('100002')), /IDENTITY_MISMATCH/);
  assert.throws(() => channel.verifyIdentity('shop_alpha',{structuredContent:{success:true,data:[]}}), /IDENTITY_MISMATCH/);
  assert.throws(() => channel.verifyIdentity('shop_alpha',{structuredContent:{success:true,data:[
    {admin:true,aliId:'100001'},{admin:true,aliId:'100001'}]}}), /IDENTITY_MISMATCH/);
  assert.throws(() => channel.verifyIdentity('shop_alpha',{structuredContent:{success:false}}));
});

test('redaction removes nested credentials and textual bearer values', () => {
  const result = channel.redact({token:'fixture-secret',nested:{password:'fixture-password'},
    reference:'alibaba:fixture_reference',text:'Bearer fixture.bearer.value',
    content:[{type:'text',text:JSON.stringify({refreshToken:'fixture-secret',safe:7})}]});
  const serialized = JSON.stringify(result);
  for (const value of ['fixture-secret','fixture-password','fixture_reference','fixture.bearer.value'])
    assert.equal(serialized.includes(value),false);
  assert.equal(result.content[0].text.safe,7);
});

const liveTest = process.platform === 'win32' ? test : test.skip;
liveTest('synthetic gateway + real DPAPI + MCP stdio: pin targets and fail closed', async t => {
  const space = {accountId:'fixture_account',kind:'personal'};
  const runtimeDirectory = path.join(home,'accounts',space.accountId,'.accio/runtime');
  fs.mkdirSync(runtimeDirectory,{recursive:true});
  fs.mkdirSync(path.join(home,'state'),{recursive:true});
  const spacePath = path.join(home,'state/current-space.json');
  const saveSpace = value => fs.writeFileSync(spacePath, JSON.stringify(value));
  saveSpace(space);
  const pairs = Object.entries(config.stores);
  const projection = {alibaba:{accounts:pairs.map(([key,s]) => ({metadata:{
    login_id:s.loginId,ali_id:s.aliId,connector_id:`fixture_${key}`}}))}};
  const projectionPath = path.join(home,'accounts',space.accountId,'connected-accounts.json');
  fs.writeFileSync(projectionPath,JSON.stringify(projection));
  const tools = ['subaccount_query','data_advisor_account_summary','query_user_category'].map(name =>
    ({name,description:`Synthetic ${name}`,inputSchema:{type:'object',properties:{}}}));
  const gateway = http.createServer((req,res) => {
    if (!req.headers.authorization?.startsWith('Basic ')) { res.writeHead(401).end(); return; }
    const url = new URL(req.url,'http://localhost');
    let result;
    if (url.pathname === '/health') result = {healthy:true,bootPhase:'app_ready'};
    else if (url.pathname === '/connectors/alibaba') result = {accounts:pairs.map(([key,s]) => ({
      status:'connected',accountId:`fixture_${key}`,fields:{login_id:s.loginId,ali_id:s.aliId}}))};
    else if (url.pathname === '/conversation') result = pairs.filter(([,s]) => s.name === url.searchParams.get('name'))
      .map(([key,s]) => ({name:s.name,id:`conversation_${key}`,agentId:`agent_${key}`,
        metadata:{storeIdentity:s.loginId,connectId:`alibaba:fixture_${key}`}}));
    else if (url.pathname === '/mcp/proxy/tools') result = {tools};
    else { res.writeHead(404).end(); return; }
    res.setHeader('content-type','application/json'); res.end(JSON.stringify(result));
  });
  gateway.listen(0,'127.0.0.1'); await once(gateway,'listening');
  t.after(() => new Promise(resolve => {gateway.close(resolve);gateway.closeAllConnections();}));
  const runtimePath = path.join(runtimeDirectory,'gateway-cli.json');
  fs.writeFileSync(runtimePath,JSON.stringify({url:`http://127.0.0.1:${gateway.address().port}`,
    authMode:'basic',username:'fixture',password:'fixture-password'}));

  await t.test('initialize and capture distinct UTF-8 conversation contexts', async () => {
    const manifest = await channel.initialize();
    assert.equal(Object.keys(manifest.stores).length, pairs.length);
    assert.equal((await channel.captureContexts()).encrypted,true);
    assert.equal((await channel.resolveStore('shop_alpha')).trace.conversationName,config.stores.shop_alpha.name);
    assert.equal(fs.readFileSync(path.join(state,'contexts.dpapi'),'utf8').includes('fixture_alpha'),false);
    await assert.rejects(channel.initialize(), /ALREADY_EXIST/);
    await assert.rejects(channel.captureContexts(), /ALREADY_EXISTS/);
  });

  const calls = [];
  const proxy = async request => {
    const key = pairs.find(([k]) => request.trace.connectId === `alibaba:fixture_${k}`)?.[0];
    assert.ok(key);
    calls.push([key,request.name]);
    return request.name === 'subaccount_query' ? identity(config.stores[key].aliId)
      : {structuredContent:{success:true,data:{fixture:true,shop:key}}};
  };
  await t.test('interleaved channels retain identities and check before/after business calls', async () => {
    const sequence = [...pairs.map(([key]) => key),pairs[0][0]];
    for (const key of sequence) {
      const value = await channel.callTool(key,'data_advisor_account_summary',query,{proxy});
      assert.equal(value.identity.adminAliId,config.stores[key].aliId);
      assert.equal(value.postIdentity.matched,true);
      assert.equal(value.result.structuredContent.data.shop,key);
    }
    assert.equal(calls.length,sequence.length * 3);
    for (let i=0;i<calls.length;i+=3)
      assert.deepEqual(calls.slice(i,i+3).map(x=>x[1]),['subaccount_query','data_advisor_account_summary','subaccount_query']);
    for (const [key] of pairs) assert.equal((await channel.callTool(key,'query_user_category',{}, {proxy})).postIdentity.matched,true);
  });

  await t.test('mismatched pre/post identities and failed business payloads withhold results', async () => {
    let requests = 0;
    await assert.rejects(channel.callTool('shop_alpha','data_advisor_account_summary',query,{proxy:async () => {
      requests++; return identity('100002');
    }}), /IDENTITY_MISMATCH/);
    assert.equal(requests,1);
    let identities = 0;
    await assert.rejects(channel.callTool('shop_alpha','data_advisor_account_summary',query,{proxy:async request =>
      request.name === 'subaccount_query' ? identity(++identities === 1 ? '100001' : '100002')
        : {structuredContent:{success:true,data:{fixture:true}}}}), /IDENTITY_MISMATCH/);
    await assert.rejects(channel.callTool('shop_alpha','data_advisor_account_summary',query,{proxy:async request =>
      request.name === 'subaccount_query' ? identity('100001') : {structuredContent:{success:false}}}), /REJECTED/);
    await assert.rejects(channel.callTool('shop_alpha','data_advisor_account_summary',query,{proxy:async request =>
      request.name === 'subaccount_query' ? identity('100001') : {content:[]}}), /SUCCESS_NOT_CONFIRMED/);
  });

  await t.test('authorization, space and manifest changes are blocked', async () => {
    const changed = structuredClone(projection); changed.alibaba.accounts[0].metadata.connector_id = 'fixture_changed';
    fs.writeFileSync(projectionPath,JSON.stringify(changed));
    await assert.rejects(channel.resolveStore('shop_alpha'), /AUTHORIZATION_REFERENCE_CHANGED/);
    fs.writeFileSync(projectionPath,JSON.stringify(projection));
    saveSpace({...space,kind:'team',teamId:'fixture_team'});
    await assert.rejects(channel.resolveStore('shop_alpha'), /ACCOUNT_OR_SPACE_CHANGED/);
    saveSpace(space);
    const manifestPath = path.join(state,'bindings.json'), original = fs.readFileSync(manifestPath,'utf8');
    const manifest = JSON.parse(original); manifest.stores.shop_alpha.bindingHash = 'fixture_changed';
    fs.writeFileSync(manifestPath,JSON.stringify(manifest));
    await assert.rejects(channel.resolveStore('shop_alpha'), /FROZEN_CONTEXT_CHANGED/);
    fs.writeFileSync(manifestPath,original);
    await assert.rejects(channel.callTool('shop_alpha','data_advisor_account_summary',query,{proxy:async request => {
      saveSpace({...space,kind:'team',teamId:'fixture_team'});
      return identity('100001');
    }}), /ACTIVE_SPACE_CHANGED/);
    saveSpace(space);
  });

  await t.test('official SDK stdio exposes readonly tools and rejects writes/store overrides', async () => {
    for (const [key] of pairs) {
      const transport = new StdioClientTransport({command:process.execPath,
        args:[path.resolve('server.mjs'),key],env:{...process.env},stderr:'pipe'});
      const client = new Client({name:'synthetic-test',version:'0.0.0'});
      try {
        await client.connect(transport);
        const listing = await client.listTools();
        assert.deepEqual(listing.tools.map(x=>x.name),['identity','account_summary','publishing_categories']);
        assert.ok(listing.tools.every(x=>x.annotations.readOnlyHint && x.annotations.destructiveHint === false));
        await assert.rejects(client.callTool({name:'publish_product',arguments:{}}), /READ_ONLY_TOOL_NOT_EXPOSED/);
        const rejection = await client.callTool({name:'identity',arguments:{store:'shop_beta'}});
        assert.equal(rejection.isError,true);
      } finally { await client.close(); }
    }
  });
});

after(() => fs.rmSync(temporary,{recursive:true,force:true}));
