param([ValidateSet('seal','unseal')][string]$Action)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
$bytes = $null; $plain = $null
try {
    $inputText = [Console]::In.ReadToEnd()
    if ($inputText.Length -gt 131072) { throw 'CONTEXT_TOO_LARGE' }
    $entropy = [Text.Encoding]::UTF8.GetBytes('accio-store-channels:context:v1')
    if ($Action -eq 'seal') {
        $plain = [Text.Encoding]::UTF8.GetBytes($inputText)
        $bytes = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        @{ciphertext = [Convert]::ToBase64String($bytes)} | ConvertTo-Json -Compress
    } else {
        $bytes = [Convert]::FromBase64String($inputText)
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [Console]::Write([Text.Encoding]::UTF8.GetString($plain))
    }
} catch { [Console]::Error.WriteLine('CONTEXT_STORE_FAILED'); exit 1 }
finally {
    if ($plain) { [Array]::Clear($plain,0,$plain.Length) }
    if ($bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
}
