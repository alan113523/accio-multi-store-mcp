# Selected unmodified functions from MeGustas-5427/accio-alibaba-data-advisor.

# Revision aa1d71af42a30bb7b6600c0aa5b9f68a996dcc6c; MIT License.

# Copyright (c) 2026 MeGustas-5427. See LICENSE.accio-data-advisor.

Add-Type -AssemblyName System.Security

function Read-AccioCredential {
    $base = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Accio'
    $credentialPath = Join-Path $base 'credentials.enc'
    $localStatePath = Join-Path $base 'Local State'

    if (-not (Test-Path -LiteralPath $credentialPath)) { throw "Accio credential file not found: $credentialPath" }
    if (-not (Test-Path -LiteralPath $localStatePath)) { throw "Accio Local State not found: $localStatePath" }

    $masterKey = $null
    $plain = $null
    $aes = $null
    try {
        $localState = Get-Content -Raw -LiteralPath $localStatePath | ConvertFrom-Json
        $wrappedKey = [Convert]::FromBase64String([string]$localState.os_crypt.encrypted_key)
        if ($wrappedKey.Length -le 5 -or [Text.Encoding]::ASCII.GetString($wrappedKey, 0, 5) -ne 'DPAPI') {
            throw 'Unexpected Accio Local State key format.'
        }

        $protectedKey = New-Object byte[] ($wrappedKey.Length - 5)
        [Array]::Copy($wrappedKey, 5, $protectedKey, 0, $protectedKey.Length)
        $masterKey = [Security.Cryptography.ProtectedData]::Unprotect(
            $protectedKey,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )

        $encrypted = [IO.File]::ReadAllBytes($credentialPath)
        if ($encrypted.Length -le 31 -or [Text.Encoding]::ASCII.GetString($encrypted, 0, 3) -ne 'v10') {
            throw 'Unexpected Accio credentials format.'
        }

        $nonce = New-Object byte[] 12
        [Array]::Copy($encrypted, 3, $nonce, 0, 12)
        $cipherLength = $encrypted.Length - 31
        $cipher = New-Object byte[] $cipherLength
        [Array]::Copy($encrypted, 15, $cipher, 0, $cipherLength)
        $tag = New-Object byte[] 16
        [Array]::Copy($encrypted, 15 + $cipherLength, $tag, 0, 16)
        $plain = New-Object byte[] $cipherLength

        $aes = [Security.Cryptography.AesGcm]::new($masterKey, 16)
        $aes.Decrypt($nonce, $cipher, $tag, $plain, $null)
        $credential = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
        Assert-CredentialShape $credential
        return $credential
    }
    finally {
        if ($aes) { $aes.Dispose() }
        if ($masterKey) { [Array]::Clear($masterKey, 0, $masterKey.Length) }
        if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
        $masterKey = $null
        $plain = $null
        $aes = $null
    }
}

function Assert-CredentialShape {
    param([Parameter(Mandatory = $true)]$Credential)
    if ([string]::IsNullOrWhiteSpace([string]$Credential.accessToken)) { throw 'Credential has no access token.' }
    if ([string]::IsNullOrWhiteSpace([string]$Credential.refreshToken)) { throw 'Credential has no refresh token.' }
    if ($null -eq $Credential.expiresAt -or [Int64]$Credential.expiresAt -le 0) { throw 'Credential has no valid expiry.' }
}

function Assert-CredentialUsable {
    param([Parameter(Mandatory = $true)]$Credential)
    Assert-CredentialShape $Credential
    $expiry = Convert-ExpiresAt ([Int64]$Credential.expiresAt)
    if ($expiry -le [DateTimeOffset]::UtcNow.AddMinutes(5)) {
        throw "Stored token is expired or expires within 5 minutes. Open Accio and run update-token."
    }
}

function Convert-ExpiresAt {
    param([Parameter(Mandatory = $true)][Int64]$Milliseconds)
    return [DateTimeOffset]::FromUnixTimeMilliseconds($Milliseconds)
}

function ConvertTo-SafeValue {
    param([AllowNull()]$Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) { return (Redact-Text $Value) }
    if ($Value -is [ValueType] -or $Value -is [DateTime] -or $Value -is [DateTimeOffset]) { return $Value }

    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $name = [string]$key
            $copy[$name] = if (Test-SensitiveKey $name) { '[REDACTED]' } else { ConvertTo-SafeValue $Value[$key] }
        }
        return $copy
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        $items = foreach ($item in $Value) { ConvertTo-SafeValue $item }
        return ,@($items)
    }

    $properties = @($Value.PSObject.Properties | Where-Object { $_.MemberType -in @('NoteProperty', 'Property') })
    if ($properties.Count -gt 0) {
        $copy = [ordered]@{}
        foreach ($property in $properties) {
            $copy[$property.Name] = if (Test-SensitiveKey $property.Name) { '[REDACTED]' } else { ConvertTo-SafeValue $property.Value }
        }
        return [pscustomobject]$copy
    }

    return $Value
}

function Test-SensitiveKey {
    param([string]$Name)
    return $Name -match '(?i)^(authorization|cookie|set-cookie|password|secret|credential|access[_-]?token|refresh[_-]?token|token|api[_-]?key|connectId|sessionKey)$'
}

function Redact-Text {
    param([AllowNull()][string]$Text)
    if ($null -eq $Text) { return $null }
    $safe = $Text
    $safe = $safe -replace '(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]+', '$1[REDACTED]'
    $safe = $safe -replace '(?i)((?:access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|credential|connectId|sessionKey)\s*[:=]\s*)("[^"]*"|''[^'']*''|[^\s,;&]+)', '$1[REDACTED]'
    return $safe
}
