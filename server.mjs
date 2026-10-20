import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { stores, stateDir, callTool, resolveStore, catalogPath } from './channel.mjs';

const store = process.argv[2];
if (!Object.hasOwn(stores, store)) throw Error('FIXED_STORE_ARGUMENT_REQUIRED');
const toolMap = { identity: 'subaccount_query', account_summary: 'data_advisor_account_summary', publishing_categories: 'query_user_category' };
const server = new Server({ name: `accio-${store}`, version: '0.1.0' }, {
  capabilities: { tools: {} },
  instructions: `此通道固定为${stores[store].label}（${store}）。仅提供只读查询，每次查询前后核对平台主账号 AliId；不接受改店参数。依赖本地 Accio 保持登录运行，可退出浏览器。`,
});
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await resolveStore(store);
  const catalog = JSON.parse(fs.readFileSync(catalogPath,'utf8'));
  return { tools: Object.entries(toolMap).map(([name, upstream]) => {
    const entry = catalog.tools?.find(t => t.name === upstream);
    if (!entry) throw Error('REQUIRED_READ_ONLY_TOOL_UNAVAILABLE');
    return { name, description: `【固定${stores[store].label} ${store}】${name === 'identity' ? '从平台实时查询并验证当前主账号身份。' : entry.description + ' 查询前后均验证主账号身份。'}`,
      inputSchema: { ...entry.inputSchema, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } };
  }) };
});
server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name, upstream = Object.hasOwn(toolMap,name) ? toolMap[name] : undefined;
  if (!upstream) throw new McpError(ErrorCode.InvalidParams, 'READ_ONLY_TOOL_NOT_EXPOSED');
  const record = { at: new Date().toISOString(), store, tool: name };
  fs.appendFileSync(path.join(stateDir, 'audit.jsonl'), JSON.stringify({ ...record, stage: 'start' }) + '\n');
  try {
    const value = await callTool(store, upstream, request.params.arguments ?? {});
    fs.appendFileSync(path.join(stateDir, 'audit.jsonl'), JSON.stringify({ ...record, stage: 'complete',
      matched: value.identity.matched && value.postIdentity.matched }) + '\n');
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
  } catch (error) {
    const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'CHANNEL_QUERY_FAILED';
    fs.appendFileSync(path.join(stateDir, 'audit.jsonl'), JSON.stringify({ ...record, stage: 'failed', code }) + '\n');
    return { content: [{ type: 'text', text: JSON.stringify({ store, error: code }) }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
