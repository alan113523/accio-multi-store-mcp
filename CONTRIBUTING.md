# 参与贡献

先阅读 [SECURITY.md](SECURITY.md) 和 [来源说明](THIRD_PARTY_NOTICES.md)。
使用合成数据进行本地开发，不提交真实账号、授权引用、业务结果或客户端安装包。

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
```

Windows 完整测试需要 PowerShell 7.4+；其他系统仅运行与平台无关的测试，
不代表原生凭据和 DPAPI 路径已通过。
提交应说明解决的问题、验证范围和兼容性影响。
新增工具需要单独评审其服务端行为、参数和数据范围，不能通过前缀自动授权。

发布前对源码和 Git 历史运行 [Gitleaks](https://github.com/gitleaks/gitleaks)，
并检查 `git ls-files` 中的配置和示例。自动扫描不能代替人工审查。
