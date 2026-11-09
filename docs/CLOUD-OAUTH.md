# 独立 OAuth 直连 Accio 云端：只读验证记录

本机实验确认：在已有有效的独立 Accio OAuth 和商家授权时，**完全退出 Accio 桌面端，也能直接向 Accio 云端核对平台主账号并读取 Data Advisor 经营汇总**。查询前后均确认没有 Accio 桌面进程，也没有使用浏览器读取经营数据。

本仓库发布的 MCP 代码仍走 **桌面网关 → 固定店铺会话**，继续按 README 要求保持 Accio 桌面端登录运行。下文记录的是单独验证的云端路径，尚未合并为本仓库的 MCP 运行模式。

## 云端调用方式

1. **独立登录并核对空间。** 使用本人获授权的 Accio 账号完成 OAuth 授权码 + PKCE 登录，在本机保存授权。现有独立登录实现可参考 [Accio Local API](https://github.com/alan113523/accio-local-api)。本次复用已有的独立授权及正确的个人或团队空间；验证的是查询时无需桌面进程常驻。
2. **读取现有商家授权。** 对 Accio 云端的 `POST https://phoenix-gw.alibaba.com/api/channel/authorization/status` 发起只读查询，在 JSON 请求中提供本机 OAuth 的 `accessToken`、实际的 `packageRegion` 和 `provider: "alibaba"`。用预先核实的 `login_id` 和主账号 `ali_id` 同时匹配，只有唯一匹配才采用返回的 `connector_id`。不按列表顺序选店，也不在此步骤新增或修改绑定。
3. **调用云端 MCP。** 对 `POST https://phoenix-gw.alibaba.com/api/mcp/proxy` 发送 JSON-RPC `tools/call`。外层 JSON 使用 `accessToken`、`request`（JSON-RPC 对象）和 `connectId`；按已验证的商家授权设置 `connectId: "alibaba:<connector_id>"` 与 `connectorId` 请求头。团队空间携带实际的 `teamId`。已验证的两个只读工具不需要桌面会话或 Agent 引用。响应可能是 JSON 或 SSE，只有协议和业务都成功才接受结果。
4. **校验身份、查询、再校验身份。** 先调用 `subaccount_query`，确认平台返回唯一主账号且 AliId 与预期一致；再调用 `data_advisor_shop_summary`；返回数据前再核对一次主账号。任一步授权、身份、日期或响应结构不匹配就停止，不换店、不把失败写成零数据。

下例只展示经营汇总的 JSON-RPC 请求体。OAuth 凭据和商家连接引用由本机适配器在请求时提供，不放入命令行参数、示例或 Agent 输出。

```json
{
  "jsonrpc": "2.0",
  "id": "example-read-only-query",
  "method": "tools/call",
  "params": {
    "name": "data_advisor_shop_summary",
    "arguments": {
      "advisorQueryParam": {
        "startDate": "2026-01-01",
        "endDate": "2026-01-01",
        "statisticsType": "day"
      }
    }
  }
}
```

Codex 或其他 Agent 可以调用这样的本机只读命令或 MCP 封装，输入固定店铺别名和日期，接收校验后的 JSON。认证、店铺授权选择和身份保护由适配器完成。对已有 `workctl` 工作流，也可用本机适配层提供 `remote-registry` 兼容入口；底层仍使用同一独立 OAuth 及 Accio 云端查询。实测的公开 `workctl 0.1.65` 不能仅凭选择 `remote-registry` 复用网页登录态。

## 目录和统计口径

2026-11-09，在同一轮分别查询了桌面端当前登录和独立 OAuth 的云端目录，按工具原名比较：

| 入口 | 返回的工具名 | 对照结果 |
| --- | ---: | --- |
| 桌面端当前登录 → 云端 `tools/list` | 2,297 | 与独立 OAuth 的名称集合完全一致 |
| 独立 OAuth → 云端 `tools/list` | 2,297 | 两份云端目录各自独有的名称均为 0 |
| 桌面网关 → `/mcp/proxy/tools` | 929 | 均在当时的云端目录中 |

此前的 2,060 项来自历史缓存，不能与实时目录相减后归因于认证方式。桌面网关列表描述的是当前运行环境实际列出的路由；云端目录存在某个名称，只能用于发现工具。还需要分别验证商家权限、必填上下文、实际执行与业务口径。

经营汇总的已验范围：

- 完全退出桌面端后，获授权的样本均通过主账号核验并返回了指定日期的 `day` 单日记录。
- 在同一历史周期，对照原桌面通道留存结果：访客、TM 咨询人数、询盘人数的 `day` 逐日累计与 `7d` 区间汇总分别一致。`day` 累计和 `7d` 汇总仍是两种不同口径，不互相替换。
- 未把 `30d`、其他工具或写入类功能列为等效验收。授权续期、首次从零配置和长期无人值守也应另外验证。

这些是授权环境中的观测记录。接口没有面向第三方的稳定性承诺；请遵循 [安全与隐私](../SECURITY.md)，不要公开凭据、连接引用、商家身份、业务响应或本机状态。
