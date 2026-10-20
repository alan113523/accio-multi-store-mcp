# 来源、引用与许可证

## 直接复用：Accio Alibaba Data Advisor

- 原项目：[MeGustas-5427/accio-alibaba-data-advisor](https://github.com/MeGustas-5427/accio-alibaba-data-advisor)
- 参考修订：[aa1d71af42a30bb7b6600c0aa5b9f68a996dcc6c](https://github.com/MeGustas-5427/accio-alibaba-data-advisor/tree/aa1d71af42a30bb7b6600c0aa5b9f68a996dcc6c)
- 原文件：[`scripts/accio_data_advisor.ps1`](https://github.com/MeGustas-5427/accio-alibaba-data-advisor/blob/aa1d71af42a30bb7b6600c0aa5b9f68a996dcc6c/scripts/accio_data_advisor.ps1)
- 版权：Copyright (c) 2026 MeGustas-5427；MIT。
- 本项目包含的原始许可：[vendor/LICENSE.accio-data-advisor](vendor/LICENSE.accio-data-advisor)。

`vendor/accio-credential-reader.ps1` 保留以下函数的原始实现：

`Read-AccioCredential`、`Assert-CredentialShape`、`Assert-CredentialUsable`、
`Convert-ExpiresAt`、`ConvertTo-SafeValue`、`Test-SensitiveKey`、`Redact-Text`。

除来源说明和 `Add-Type -AssemblyName System.Security` 外，该文件仅含上述函数。
本项目新增固定会话绑定、多店配置、上下文快照、身份核对、受限 MCP 服务与测试。
没有复制原项目的运行状态、账号配置或服务端工具目录。

## 运行依赖：MCP TypeScript SDK

- 项目：[modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- 包：`@modelcontextprotocol/sdk`，固定版本见 `package.json` 和 `pnpm-lock.yaml`。
- 许可证：MIT；通过包管理器安装，许可随依赖分发。

## README 结构参考

- [othneildrew/Best-README-Template](https://github.com/othneildrew/Best-README-Template)：首屏说明、快速导航、安装、使用和贡献入口。
- [apify/mcpc](https://github.com/apify/mcpc)：能力表、配置示例和故障排查的组织方式。

仅参考信息组织方式；本项目文案和图表独立编写，没有复制上述项目的标识或页面资产。

## Accio Work 与 Alibaba.com

本项目是独立、非官方的适配器。Accio Work 是用户自行安装的客户端，
其本地状态和会话请求格式属于适配目标，不作为本项目开源代码分发。
没有包含其安装包、解包源码、工具目录转储、真实账号或研究原始记录。
运行时取得的工具说明和业务结果不因本仓库 MIT 许可证而获得再授权。
相关名称、商标和服务权利归各自权利人所有。
