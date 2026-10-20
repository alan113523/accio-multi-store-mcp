Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$stage = 'helper_import'
try {
    # MIT upstream functions only; see THIRD_PARTY_NOTICES.md. No local state is bundled.
    . (Join-Path $PSScriptRoot 'vendor/accio-credential-reader.ps1')
    $inputText = [Console]::In.ReadToEnd()
    if ($inputText.Length -gt 65536) { throw 'INPUT_TOO_LARGE' }
    $call = $inputText | ConvertFrom-Json -AsHashtable -Depth 30
    if ($call.name -notin @('subaccount_query', 'data_advisor_account_summary', 'query_user_category')) { throw 'READ_ONLY_TOOL_NOT_ALLOWED' }
    if ($call.trace.connectId -notmatch '^alibaba:[A-Za-z0-9_-]+$') { throw 'VALIDATED_STORE_CONTEXT_REQUIRED' }
    $stage = 'credential_read'
    $credential = Read-AccioCredential
    $stage = 'credential_expiry'
    Assert-CredentialUsable $credential
    $rpc = @{ jsonrpc = '2.0'; id = $call.trace.requestId; method = 'tools/call'; params = @{name = $call.name; arguments = $call.arguments} }
    $payload = [ordered]@{accessToken = $credential.accessToken; request = $rpc}
    foreach ($key in @('connectId','conversationId','conversationName','agentId','requestId','messageId','teamId','language','clientType')) {
        if ($call.trace.ContainsKey($key)) { $payload[$key] = $call.trace[$key] }
    }
    $headers = @{Accept = 'application/json, text/event-stream'; 'x-language' = 'zh-CN'; 'x-source' = 'ACCIO_DESKTOP'; connectorId = $call.trace.connectId.Substring(8)}
    if ($call.trace.ContainsKey('teamId')) { $headers['x-team-id'] = $call.trace.teamId }
    $stage = 'upstream_request'
    $response = Invoke-WebRequest -Uri 'https://phoenix-gw.alibaba.com/api/mcp/proxy' -Method Post -ContentType 'application/json' -Headers $headers -Body ($payload | ConvertTo-Json -Compress -Depth 30) -TimeoutSec 60 -MaximumRedirection 0
    $stage = 'response_parse'
    $raw = [string]$response.Content
    $candidates = @()
    foreach ($line in ($raw -split "`r?`n")) {
        if ($line.Trim().StartsWith('data:')) {
            $json = $line.Trim().Substring(5).Trim()
            if ($json -and $json -ne '[DONE]') { $candidates += ,($json | ConvertFrom-Json -Depth 100) }
        }
    }
    if ($candidates.Count) {
        $parsed = $candidates | Where-Object { $null -ne $_.PSObject.Properties['result'] -or $null -ne $_.PSObject.Properties['error'] } | Select-Object -First 1
        if ($null -eq $parsed) { $parsed = $candidates[0] }
    } else { $parsed = $raw | ConvertFrom-Json -Depth 100 }
    if ($null -ne $parsed.PSObject.Properties['error'] -and $null -ne $parsed.error) { throw 'REMOTE_RPC_REJECTED' }
    if ($null -ne $parsed.PSObject.Properties['success'] -and -not $parsed.success) { throw 'REMOTE_ENVELOPE_REJECTED' }
    if ($null -ne $parsed.PSObject.Properties['result']) { $parsed = $parsed.result }
    elseif ($null -ne $parsed.PSObject.Properties['success'] -and $null -ne $parsed.PSObject.Properties['data']) { $parsed = $parsed.data }
    ConvertTo-SafeValue $parsed | ConvertTo-Json -Depth 100 -Compress
} catch {
    # Raw network/parser errors may contain request material; expose a code only.
    $failure = @{error='NATIVE_PROXY_QUERY_FAILED';stage=$stage;type=$_.Exception.GetType().Name}
    if ($_.Exception.PSObject.Properties['Response'] -and $null -ne $_.Exception.Response) { $failure.httpStatus = [int]$_.Exception.Response.StatusCode }
    if ($stage -eq 'credential_expiry' -and $null -ne $credential) { $failure.validitySeconds = [math]::Floor(([Int64]$credential.expiresAt-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())/1000) }
    [Console]::Error.WriteLine(($failure | ConvertTo-Json -Compress))
    exit 1
} finally { $credential = $null; $payload = $null; $raw = $null; $inputText = $null }
