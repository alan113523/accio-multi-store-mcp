import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const project = path.dirname(fileURLToPath(import.meta.url));
export const stateDir = path.resolve(process.env.ACCIO_CHANNEL_STATE_DIR || path.join(project, '.local'));
const manifestPath = path.join(stateDir, 'bindings.json');
const contextPath = path.join(stateDir, 'contexts.dpapi');
export const catalogPath = path.join(stateDir, 'tool-catalog.json');
let contextSnapshot;
export function validateStores(config) {
  if (!config || config.version !== 1 || !config.stores || typeof config.stores !== 'object' || Array.isArray(config.stores))
    throw Error('STORE_CONFIG_INVALID');
  const entries = Object.entries(config.stores);
  if (!entries.length) throw Error('STORE_CONFIG_EMPTY');
  for (const [key, store] of entries) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key) || !store ||
        ['loginId','name','label','aliId'].some(k => typeof store[k] !== 'string' || !store[k].trim()) ||
        !/^[0-9]+$/.test(store.aliId) || Object.keys(store).some(k => !['loginId','name','label','aliId'].includes(k)))
      throw Error('STORE_CONFIG_ENTRY_INVALID');
  }
  for (const field of ['loginId','name','aliId'])
    if (new Set(entries.map(([,s]) => s[field])).size !== entries.length) throw Error('STORE_CONFIG_TARGETS_NOT_DISTINCT');
  return config.stores;
}
function loadStores() {
  try {
    return validateStores(JSON.parse(fs.readFileSync(process.env.ACCIO_CHANNEL_CONFIG || path.join(stateDir,'stores.json'), 'utf8')));
  } catch (error) {
    if (/^STORE_CONFIG_/.test(error.message)) throw error;
    throw Error('STORE_CONFIG_UNAVAILABLE');
  }
}
export const stores = loadStores();
const exposedTools = new Set(['subaccount_query', 'data_advisor_account_summary', 'query_user_category']);
export const digest = v => createHash('sha256').update(String(v)).digest('hex');
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) =>
    [k, /token|password|secret|cookie|authorization|connectId|sessionKey|pendingAuth|credential/i.test(k) ? '[REDACTED]' : redact(v)]));
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) { try { return redact(JSON.parse(value)); } catch {} }
    return value.replace(/alibaba:[A-Za-z0-9_-]+/g, '[STORE_REFERENCE]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
      .replace(/((?:access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|credential|connectId|sessionKey)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[REDACTED]');
  }
  return value;
}
export function openGateway() {
  const root = path.resolve(process.env.ACCIO_HOME || path.join(os.homedir(), '.accio'));
  const space = JSON.parse(fs.readFileSync(path.join(root, 'state/current-space.json'), 'utf8'));
  const account = String(space.accountId ?? '');
  if (!/^[A-Za-z0-9_-]+$/.test(account)) throw Error('ACTIVE_ACCOUNT_INVALID');
  const runtime = JSON.parse(fs.readFileSync(path.join(root, 'accounts', account, '.accio/runtime/gateway-cli.json'), 'utf8'));
  const origin = new URL(runtime.url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.protocol !== 'http:' || origin.username || origin.password)
    throw Error('LOCAL_GATEWAY_REQUIRED');
  if (runtime.authMode !== 'basic' || !runtime.password || !runtime.username) throw Error('AUTHENTICATED_GATEWAY_REQUIRED');
  const headers = { Authorization: 'Basic ' + Buffer.from(`${runtime.username}:${runtime.password}`).toString('base64') };
  return {
    scopeHash: digest(JSON.stringify([space.accountId, space.kind, space.teamId ?? null])),
    teamId: space.kind === 'team' ? space.teamId : undefined,
    projectionPath: path.join(root, 'accounts', account, 'connected-accounts.json'),
    async request(route, body) {
      const response = await fetch(new URL(route, origin), { headers: { ...headers, 'content-type': 'application/json' },
        method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(90000), redirect: 'error' });
      if (!response.ok) throw Error(`LOCAL_GATEWAY_${route.startsWith('/conversation')?'CONVERSATION':route.startsWith('/connectors')?'CONNECTOR':route.startsWith('/mcp')?'MCP':'HEALTH'}_HTTP_${response.status}`);
      const data = await response.json();
      if (data.success === false || data.ok === false) throw Error('LOCAL_GATEWAY_REJECTED');
      return data.data ?? data;
    },
  };
}
function contextCrypto(action, input) {
  const executable = process.env.ACCIO_PWSH || 'pwsh';
  const result = spawnSync(executable, ['-NoProfile','-NonInteractive','-File',path.join(project,'context-store.ps1'),action],
    {input,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:256*1024});
  if (result.status !== 0) throw Error('ENCRYPTED_CONTEXT_STORE_UNAVAILABLE');
  try { return JSON.parse(result.stdout); } catch { throw Error('ENCRYPTED_CONTEXT_STORE_INVALID'); }
}
export async function captureContexts() {
  if (fs.existsSync(contextPath) || fs.existsSync(catalogPath)) throw Error('CONTEXT_SNAPSHOT_ALREADY_EXISTS');
  const contexts = {};
  for (const key of Object.keys(stores)) {
    const route = await resolveStore(key, {forceLive:true});
    contexts[key] = {stamp:route.stamp,trace:route.trace};
  }
  const live = await openGateway().request('/mcp/proxy/tools');
  const catalog = live.tools.filter(t=>exposedTools.has(t.name)).map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema}));
  if (catalog.length !== exposedTools.size) throw Error('REQUIRED_TOOLS_NOT_IN_LIVE_CATALOG');
  const protectedData = contextCrypto('seal',JSON.stringify({version:1,capturedAt:new Date().toISOString(),contexts}));
  fs.writeFileSync(contextPath,protectedData.ciphertext,{flag:'wx',mode:0o600});
  fs.writeFileSync(catalogPath,JSON.stringify({capturedAt:new Date().toISOString(),tools:catalog},null,2)+'\n',{flag:'wx'});
  return {captured:true,stores:Object.keys(contexts),encrypted:true,containsTokens:false};
}
export async function resolveStore(storeKey, { initialize = false, forceLive = false } = {}) {
  const expected = Object.hasOwn(stores,storeKey) ? stores[storeKey] : undefined;
  if (!expected) throw Error('STORE_NOT_ALLOWED');
  const gateway = openGateway();
  if (!initialize && !forceLive && !fs.existsSync(contextPath)) throw Error('ENCRYPTED_CONTEXT_REQUIRED');
  if (!initialize && !forceLive && fs.existsSync(contextPath)) {
    contextSnapshot ??= contextCrypto('unseal',fs.readFileSync(contextPath,'utf8'));
    const stored = contextSnapshot.contexts?.[storeKey];
    const frozen = JSON.parse(fs.readFileSync(manifestPath,'utf8')).stores[storeKey];
    if (!stored || !frozen || stored.stamp.scopeHash !== gateway.scopeHash) throw Error('SNAPSHOT_ACCOUNT_OR_SPACE_CHANGED');
    for (const field of ['loginId','aliId','conversationName','conversationHash','bindingHash','storedBindingHash','agentHash','scopeHash'])
      if (stored.stamp[field] !== frozen[field]) throw Error('FROZEN_CONTEXT_CHANGED');
    if (digest(stored.trace.connectId)!==frozen.bindingHash || digest(stored.trace.conversationId)!==frozen.conversationHash || digest(stored.trace.agentId)!==frozen.agentHash)
      throw Error('CONTEXT_REFERENCE_HASH_MISMATCH');
    const projection=JSON.parse(fs.readFileSync(gateway.projectionPath,'utf8'));
    if (stored.stamp.loginId !== expected.loginId || stored.stamp.aliId !== expected.aliId || stored.stamp.conversationName !== expected.name)
      throw Error('STORE_CONFIG_CHANGED_SINCE_CAPTURE');
    const matches=projection.alibaba?.accounts?.filter(a=>String(a.metadata?.login_id)===expected.loginId && String(a.metadata?.ali_id)===expected.aliId &&
      `alibaba:${a.metadata?.connector_id}`===stored.trace.connectId)??[];
    if(matches.length!==1)throw Error('CURRENT_AUTHORIZATION_REFERENCE_CHANGED');
    const health=await gateway.request('/health');
    if(!health.healthy||health.bootPhase!=='app_ready')throw Error('LOCAL_ACCIO_NOT_READY');
    return {gateway,stamp:stored.stamp,trace:{...stored.trace}};
  }
  const connector = await gateway.request('/connectors/alibaba');
  const accounts = connector.accounts?.filter(a => a.status === 'connected' &&
    String(a.fields?.login_id ?? a.authResult?.login_id) === expected.loginId &&
    String(a.fields?.ali_id ?? a.authResult?.ali_id) === expected.aliId) ?? [];
  if (accounts.length !== 1) throw Error('STORE_AUTHORIZATION_NOT_UNIQUE_OR_UNAVAILABLE');
  const response = await gateway.request('/conversation?name=' + encodeURIComponent(expected.name) + '&limit=100');
  const sessions = Array.isArray(response) ? response : response.list ?? response.items ?? [];
  const matches = sessions.filter(s => s.name === expected.name && s.metadata?.storeIdentity === expected.loginId);
  if (matches.length !== 1) throw Error('EXISTING_CONVERSATION_NOT_UNIQUE_OR_IDENTITY_MISMATCH');
  const conversation = matches[0], connectId = `alibaba:${accounts[0].accountId}`;
  const storedBinding = conversation.metadata.connectId;
  const previousAccount = connector.accounts.find(a => `alibaba:${a.accountId}` === storedBinding);
  if (!storedBinding?.startsWith('alibaba:') || !conversation.id || !conversation.agentId ||
      (previousAccount && previousAccount.accountId !== accounts[0].accountId))
    throw Error('CONVERSATION_AUTHORIZATION_BINDING_MISMATCH');
  const stamp = { label: expected.label, loginId: expected.loginId, aliId: expected.aliId,
    conversationName: expected.name, conversationHash: digest(conversation.id), bindingHash: digest(connectId),
    storedBindingHash: digest(storedBinding), bindingRecovery: storedBinding === connectId ? 'intact' : 'same_store_identity',
    agentHash: digest(conversation.agentId), scopeHash: gateway.scopeHash };
  if (!initialize) {
    const frozen = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).stores[storeKey];
    for (const field of ['loginId', 'aliId', 'conversationHash', 'bindingHash', 'storedBindingHash', 'agentHash', 'scopeHash'])
      if (!frozen || frozen[field] !== stamp[field]) throw Error(`FROZEN_BINDING_CHANGED_${field}`);
  }
  return { gateway, stamp, trace: { conversationId: conversation.id, conversationName: conversation.name,
    agentId: conversation.agentId, connectId, language: 'zh', clientType: 'desktop',
    ...(gateway.teamId ? {teamId: gateway.teamId} : {}), requestId: randomUUID(), messageId: randomUUID() } };
}
export async function initialize() {
  if (fs.existsSync(manifestPath)) throw Error('BINDINGS_ALREADY_EXIST');
  fs.mkdirSync(stateDir, {recursive:true,mode:0o700});
  const entries = [];
  for (const key of Object.keys(stores)) entries.push([key, (await resolveStore(key, { initialize: true })).stamp]);
  if (new Set(entries.map(([,s]) => s.bindingHash)).size !== entries.length || new Set(entries.map(([,s]) => s.conversationHash)).size !== entries.length)
    throw Error('STORE_CHANNELS_NOT_DISTINCT');
  const manifest = { version: 1, createdAt: new Date().toISOString(), stores: Object.fromEntries(entries) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}
function businessData(result) {
  let body = result.structuredContent ?? (Object.hasOwn(result, 'success') ? result : undefined);
  if (!body && result.content?.length === 1 && result.content[0].type === 'text') {
    body = result.content[0].text;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  }
  if (body?.success === false || body?.isError || (body?.code != null && !['0', '200', 'SUCCESS'].includes(String(body.code))))
    throw Error('BUSINESS_RESPONSE_REJECTED');
  return body;
}
export function verifyIdentity(storeKey, result) {
  const body = businessData(result);
  if (body?.success !== true || !Array.isArray(body.data)) throw Error('LIVE_IDENTITY_RESPONSE_INVALID');
  const admins = body.data.filter(a => a.admin === true);
  if (admins.length !== 1 || String(admins[0].aliId) !== stores[storeKey].aliId) throw Error('LIVE_SELLER_IDENTITY_MISMATCH');
  return { source: 'subaccount_query', checkedAt: new Date().toISOString(),
    adminAliId: String(admins[0].aliId), admin: true, self: admins[0].self === true,
    name: [admins[0].firstName, admins[0].lastName].filter(Boolean).join(' '), expectedAliId: stores[storeKey].aliId, matched: true };
}
function nativeProxy(body) {
  return new Promise((resolve, reject) => {
    const executable = process.env.ACCIO_PWSH || 'pwsh';
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', path.join(project, 'native-proxy.ps1')],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', size = 0, diagnostics = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('NATIVE_PROXY_TIMEOUT')); }, 75000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 10 * 1024 * 1024) child.kill(); else output += chunk; });
    child.stderr.on('data', chunk => { if (diagnostics.length < 4096) diagnostics += chunk; });
    child.on('error', () => { clearTimeout(timer); reject(Error('NATIVE_PROXY_START_FAILED')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || size > 10 * 1024 * 1024) {
        let stage = '';
        try { const d=JSON.parse(diagnostics); if (/^[a-z_]+$/.test(d.stage)) stage='_'+d.stage.toUpperCase(); if(Number.isInteger(d.httpStatus))stage+='_HTTP_'+d.httpStatus; } catch {}
        return reject(Error('NATIVE_PROXY_QUERY_FAILED'+stage));
      }
      try { resolve(JSON.parse(output)); } catch { reject(Error('NATIVE_PROXY_RESPONSE_INVALID')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(body));
  });
}
async function invoke(route, name, args, native, proxy) {
  if (openGateway().scopeHash !== route.stamp.scopeHash) throw Error('ACTIVE_SPACE_CHANGED');
  const trace = { ...route.trace, requestId: randomUUID(), messageId: randomUUID() };
  const body = {name, arguments: args, trace};
  const result = native ? await proxy(body) : await route.gateway.request('/mcp/proxy', body);
  if (result.isError) throw Error('BUSINESS_TOOL_ERROR');
  businessData(result);
  return { result, requestId: trace.requestId };
}
export function validateArguments(toolName, args) {
  if (!exposedTools.has(toolName)) throw Error('READ_ONLY_TOOL_NOT_ALLOWED');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('TOOL_ARGUMENTS_MUST_BE_OBJECT');
  if (toolName === 'subaccount_query') {
    if (Object.keys(args).length) throw Error('IDENTITY_TOOL_ARGUMENTS_MUST_BE_EMPTY');
    return;
  }
  if (toolName === 'query_user_category') {
    if (Object.keys(args).some(k => k !== 'locale') || (args.locale !== undefined && typeof args.locale !== 'string'))
      throw Error('PUBLISHING_CATEGORY_ARGUMENTS_INVALID');
    return;
  }
  const key = 'accountQueryParam';
  const query = args[key];
  if (Object.keys(args).length !== 1 || !query || typeof query !== 'object' || Array.isArray(query) ||
      Object.keys(query).some(k => !['startDate','endDate','statisticsType'].includes(k))) throw Error('QUERY_ARGUMENTS_INVALID');
  for (const field of ['startDate','endDate']) {
    const date = query[field];
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0,10) !== date) throw Error('QUERY_DATE_INVALID');
  }
  if (query.startDate > query.endDate) throw Error('QUERY_DATE_RANGE_INVALID');
  const allowed = ['day','week','month'];
  if (!allowed.includes(query.statisticsType)) throw Error('QUERY_STATISTICS_TYPE_INVALID');
}
export async function callTool(storeKey, toolName, args, {native = true, proxy = nativeProxy} = {}) {
  if (!exposedTools.has(toolName)) throw Error('READ_ONLY_TOOL_NOT_ALLOWED');
  validateArguments(toolName, args);
  const route = await resolveStore(storeKey);
  const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath,'utf8')) : await route.gateway.request('/mcp/proxy/tools');
  const tool = catalog.tools?.find(t => t.name === toolName);
  if (!tool || !catalog.tools.some(t => t.name === 'subaccount_query')) throw Error('TOOL_NOT_IN_LIVE_CATALOG');
  const probe = await invoke(route, 'subaccount_query', {}, native, proxy);
  const identity = verifyIdentity(storeKey, probe.result);
  const call = toolName === 'subaccount_query' ? probe : await invoke(route, toolName, args, native, proxy);
  const postIdentity = toolName === 'subaccount_query' ? identity : verifyIdentity(storeKey, (await invoke(route, 'subaccount_query', {}, native, proxy)).result);
  if (toolName !== 'subaccount_query' && businessData(call.result)?.success !== true) throw Error('BUSINESS_SUCCESS_NOT_CONFIRMED');
  return { at: new Date().toISOString(), store: storeKey, binding: route.stamp,
    requestId: call.requestId, tool: toolName, transport: native ? 'native_proxy_envelope' : 'local_gateway', identity, postIdentity,
    result: toolName === 'subaccount_query' ? identity : redact(call.result) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, store, tool, args = '{}'] = process.argv.slice(2);
    const result = action === 'init' ? await initialize() : action === 'capture' ? await captureContexts() : action === 'status' ? (await resolveStore(store)).stamp :
      ['call','call-native','call-local'].includes(action) ? await callTool(store, tool, JSON.parse(args), {native: action !== 'call-local'}) : (() => { throw Error('USE_init_status_OR_call'); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(JSON.stringify({ error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CHANNEL_OPERATION_FAILED', type: error.name })); process.exitCode = 1; }
}
