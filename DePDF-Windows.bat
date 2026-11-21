@echo off
title DePDF - Fixed Launcher
set "DEPDF_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:DEPDF_SELF); Invoke-Expression $s.Substring($s.IndexOf('#'+'PSBEGIN',[StringComparison]::Ordinal)+8)"
echo.
echo DePDF has stopped. You can close this window.
pause >nul
exit /b
#PSBEGIN
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Small web server used when Python 3 is installed (multi-threaded, same idea as "python -m http.server").
$pySrc = @'
import functools, http.server, sys

www, port = sys.argv[1], int(sys.argv[2])

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".whl": "application/octet-stream",
        ".py": "text/plain",
    }
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=www))
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
'@

function Find-Python {
    foreach ($c in @(@('py', '-3'), @('python'), @('python3'))) {
        $cmd = Get-Command $c[0] -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        $extra = @()
        if ($c.Count -gt 1) { $extra = @($c[1..($c.Count - 1)]) }
        try {
            $out = & $cmd.Source @extra -c 'import sys; print(int(sys.version_info >= (3, 7)))' 2>$null
            if ($LASTEXITCODE -eq 0 -and ("$out".Trim() -eq '1')) {
                return , (@($cmd.Source) + $extra)
            }
        } catch { }
    }
    return $null
}

# No Python on this computer: fetch the official small "embeddable" Python from python.org (one time, about 10 MB).
function Get-PrivatePython([string]$root) {
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
        'AMD64' { $name = 'amd64' }
        'ARM64' { $name = 'arm64' }
        default { $name = 'win32' }
    }
    $dir = Join-Path $root ('python-' + $name)
    $exe = Join-Path $dir 'python.exe'
    if (-not (Test-Path -LiteralPath $exe)) {
        Write-Host ''
        Write-Host 'Python was not found on this computer. Fetching a small private copy from python.org (about 10 MB, one time)...' -ForegroundColor Cyan
        $zip = Join-Path ([IO.Path]::GetTempPath()) ('depdf-py-' + [Guid]::NewGuid().ToString('N') + '.zip')
        try {
            Invoke-WebRequest -Uri ('https://www.python.org/ftp/python/3.12.10/python-3.12.10-embeddable-' + $name + '.zip') -OutFile $zip -UseBasicParsing
            if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
            Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
            # Only trust it if Windows confirms python.exe is validly signed by the Python Software Foundation.
            $sig = Get-AuthenticodeSignature -LiteralPath $exe
            $signer = ''
            if ($sig.SignerCertificate) { $signer = $sig.SignerCertificate.Subject }
            if ($sig.Status -ne 'Valid' -or $signer -notmatch 'Python Software Foundation') {
                Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
                throw ('The downloaded Python is not validly signed by the Python Software Foundation (signature: ' + $sig.Status + '), so it was not used.')
            }
        } finally {
            Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        }
    }
    $out = & $exe -c 'import http.server; print(1)' 2>$null
    if ($LASTEXITCODE -ne 0 -or ("$out".Trim() -ne '1')) { throw 'The downloaded Python did not start.' }
    return , @($exe)
}

function Test-PortFree([int]$p) {
    $t = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    try { $t.Start(); $t.Stop(); return $true } catch { return $false }
}

# Open as an app window (no tabs or address bar) using Edge or Chrome if installed.
function Open-App([string]$url) {
    $appExe = $null
    foreach ($rel in @('Microsoft\Edge\Application\msedge.exe', 'Google\Chrome\Application\chrome.exe')) {
        foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
            if ($base) {
                $c = Join-Path $base $rel
                if (Test-Path -LiteralPath $c) { $appExe = $c; break }
            }
        }
        if ($appExe) { break }
    }
    if ($appExe) { Start-Process -FilePath $appExe -ArgumentList "--app=$url" } else { Start-Process $url }
}

# Ask GitHub for the exact current commit on main.
# The BAT launcher updates the Windows web app from main, not from the latest APK release tag.
# Cache-control headers prevent an intermediary from returning an old commits-list response.
function Get-LatestVersion([string]$apiUrl) {
    try {
        $r = Invoke-RestMethod -Uri $apiUrl -Method Get -TimeoutSec 20 -ErrorAction Stop -Headers @{
            'Accept' = 'application/vnd.github+json'
            'User-Agent' = 'DePDF-Launcher'
            'X-GitHub-Api-Version' = '2022-11-28'
            'Cache-Control' = 'no-cache, no-store'
            'Pragma' = 'no-cache'
        }

        $v = ([string]$r.sha).Trim().ToLowerInvariant()
        if ($v -match '^[0-9a-f]{40}$') { return $v }
    } catch { }
    return ''
}

# Download and validate the app before replacing the current copy.
# The previous www folder is kept as a rollback copy until the new folder is in place.
function Install-App([string]$zipUrl, [string]$root, [string]$www) {
    $id = [Guid]::NewGuid().ToString('N')
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('depdf-' + $id)
    $stageWww = Join-Path $root ('.depdf-www-stage-' + $id)
    $backupWww = Join-Path $root ('.depdf-www-backup-' + $id)
    $backupMade = $false

    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    New-Item -ItemType Directory -Path $root -Force | Out-Null

    try {
        $zip = Join-Path $tmp 'depdf.zip'
        $extractRoot = Join-Path $tmp 'x'

        Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 120
        Write-Host 'Unpacking...' -ForegroundColor Cyan
        Expand-Archive -LiteralPath $zip -DestinationPath $extractRoot -Force

        $src = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
        if (-not $src) { throw 'The downloaded archive is empty or has an unexpected structure.' }

        $newWww = Join-Path $src.FullName 'www'
        if (-not (Test-Path -LiteralPath (Join-Path $newWww 'index.html') -PathType Leaf)) {
            throw 'The download did not contain the app (www\index.html is missing).'
        }

        # Stage the new app on the same drive as the installation so the final rename is quick.
        if (Test-Path -LiteralPath $stageWww) {
            Remove-Item -LiteralPath $stageWww -Recurse -Force
        }
        New-Item -ItemType Directory -Path $stageWww -Force | Out-Null
        foreach ($item in (Get-ChildItem -LiteralPath $newWww -Force)) {
            Copy-Item -LiteralPath $item.FullName -Destination $stageWww -Recurse -Force
        }
        if (-not (Test-Path -LiteralPath (Join-Path $stageWww 'index.html') -PathType Leaf)) {
            throw 'The staged download is incomplete (www\index.html is missing).'
        }

        # Move the existing installation out of the way; do not delete it before the new copy is ready.
        if (Test-Path -LiteralPath $www) {
            Move-Item -LiteralPath $www -Destination $backupWww -ErrorAction Stop
            $backupMade = $true
        }

        try {
            Move-Item -LiteralPath $stageWww -Destination $www -ErrorAction Stop
            if (-not (Test-Path -LiteralPath (Join-Path $www 'index.html') -PathType Leaf)) {
                throw 'The new installation could not be verified after replacement.'
            }
        } catch {
            # Remove an incomplete new folder, then restore the previous working installation.
            if (Test-Path -LiteralPath $www) {
                Remove-Item -LiteralPath $www -Recurse -Force -ErrorAction SilentlyContinue
            }
            if ($backupMade -and (Test-Path -LiteralPath $backupWww)) {
                Move-Item -LiteralPath $backupWww -Destination $www -ErrorAction Stop
                $backupMade = $false
            }
            throw
        }

        # The update is now verified. Backup cleanup is deliberately non-fatal.
        if ($backupMade -and (Test-Path -LiteralPath $backupWww)) {
            Remove-Item -LiteralPath $backupWww -Recurse -Force -ErrorAction SilentlyContinue
            $backupMade = $false
        }
    } finally {
        if (Test-Path -LiteralPath $stageWww) {
            Remove-Item -LiteralPath $stageWww -Recurse -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Remember which folder DePDF lives in. This small pointer file stays in a fixed place so the folder itself can be anywhere.
$cfgDir  = Join-Path $env:APPDATA 'DePDF'
$cfgFile = Join-Path $cfgDir 'location.txt'

function Save-InstallRoot([string]$path) {
    New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null
    [IO.File]::WriteAllText($cfgFile, $path)
}

# Make sure the folder exists (creates it, and any missing parent folders, when needed).
function Initialize-Folder([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

# First run: let the user choose the folder. Later runs: reuse the saved choice.
# If location.txt is deleted, always show the folder prompt, even when a legacy installation exists.
function Get-InstallRoot {
    $legacy = Join-Path $env:LOCALAPPDATA 'DePDF'
    $saved = ''

    if (Test-Path -LiteralPath $cfgFile -PathType Leaf) {
        try { $saved = ([IO.File]::ReadAllText($cfgFile)).Trim() } catch { $saved = '' }
    }

    if ($saved) {
        try {
            if ($saved -notmatch '^([A-Za-z]:[\\/]|\\\\)') {
                throw 'The saved location is not a full Windows path.'
            }
            $savedFull = [IO.Path]::GetFullPath($saved)
            Initialize-Folder $savedFull
            return $savedFull
        } catch {
            Write-Host ('The saved folder "' + $saved + '" is not available (' + $_.Exception.Message + '). Please choose a folder again.') -ForegroundColor Yellow
        }
    }

    $legacyExists = Test-Path -LiteralPath (Join-Path $legacy 'www\index.html') -PathType Leaf

    Write-Host ''
    if ($legacyExists) {
        Write-Host 'An existing DePDF installation was found.' -ForegroundColor Yellow
        Write-Host ('  Existing folder: ' + $legacy)
        Write-Host '  Press Enter to keep this folder, or type a different full path.'
    } else {
        Write-Host 'First-time setup' -ForegroundColor Cyan
        Write-Host 'Choose the folder where DePDF will be stored.'
        Write-Host '  Example: D:\DePDF'
        Write-Host '  If the folder does not exist yet, it will be created for you.'
        Write-Host ('  Press Enter to use the default: ' + $legacy)
    }

    while ($true) {
        $in = Read-Host 'Folder'
        $in = "$in".Trim().Trim('"').Trim()
        if (-not $in) { $in = $legacy }
        try {
            if ($in -notmatch '^([A-Za-z]:[\\/]|\\\\)') {
                throw 'Please type a full path that starts with a drive letter, for example D:\DePDF'
            }
            $full = [IO.Path]::GetFullPath($in)
            if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
            Initialize-Folder $full
            Save-InstallRoot $full
            Write-Host ('Folder ready: ' + $full) -ForegroundColor Green
            return $full
        } catch {
            Write-Host ('Could not use that folder: ' + $_.Exception.Message) -ForegroundColor Red
            Write-Host 'Please try again.'
        }
    }
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $repo   = 'lupin-hash/depdf'
    $apiUrl = 'https://api.github.com/repos/' + $repo + '/commits/main'
    $root   = Get-InstallRoot
    $www    = Join-Path $root 'www'
    $verFile = Join-Path $root 'version.txt'

    # Always show where DePDF is stored.
    Write-Host ''
    Write-Host ('DePDF is stored in: ' + $root) -ForegroundColor Green
    Write-Host ('(To choose a different folder, delete ' + $cfgFile + ' and start DePDF again.)') -ForegroundColor DarkGray

    # ---- Every launch: compare installed source commit with the live main branch. ----
    # This desktop launcher follows main directly; it must not wait for an APK release.
    $have = Test-Path -LiteralPath (Join-Path $www 'index.html') -PathType Leaf
    $localVer = ''
    if (Test-Path -LiteralPath $verFile -PathType Leaf) {
        $localVer = ([IO.File]::ReadAllText($verFile)).Trim().ToLowerInvariant()
    }
    $remoteVer = Get-LatestVersion $apiUrl

    if (-not $remoteVer) {
        Write-Host ''
        Write-Host 'Could not verify the latest main-branch commit from GitHub.' -ForegroundColor Yellow
        if ($have) {
            Write-Host 'Your existing DePDF installation will be used. Update checking will retry next time.' -ForegroundColor DarkGray
        }
    }

    # Old release-tag values (v1.0.21) are intentionally treated as stale: this launcher
    # tracks main commits, so upgrading from the earlier release-based script happens once.
    $needDownload = (-not $have) -or ($remoteVer -ne '' -and $remoteVer -ne $localVer)

    if ($needDownload) {
        Write-Host ''
        if ($have) {
            Write-Host 'A newer DePDF source build is available on main. Updating...' -ForegroundColor Cyan
        } else {
            Write-Host 'DePDF is not installed in the selected folder. Downloading the latest main build...' -ForegroundColor Cyan
        }

        if ($remoteVer -ne '') {
            $zipUrl = 'https://github.com/' + $repo + '/archive/' + $remoteVer + '.zip'
        } else {
            # First installation can still proceed when the GitHub API is unavailable.
            $zipUrl = 'https://github.com/' + $repo + '/archive/HEAD.zip'
        }

        try {
            Install-App $zipUrl $root $www
            if ($remoteVer -ne '') {
                [IO.File]::WriteAllText($verFile, $remoteVer)
            } elseif (Test-Path -LiteralPath $verFile) {
                Remove-Item -LiteralPath $verFile -Force -ErrorAction SilentlyContinue
            }

            if ($have) {
                Write-Host 'DePDF updated successfully to the latest main build.' -ForegroundColor Green
            } else {
                Write-Host 'DePDF downloaded and installed successfully.' -ForegroundColor Green
            }
        } catch {
            if ($have) {
                Write-Host ('Could not update DePDF (' + $_.Exception.Message + '). Your previous installation was preserved.') -ForegroundColor Yellow
            } else {
                throw
            }
        }
    }

    # ---- Show the installed source revision and current main revision. ----
    $installedVer = ''
    if (Test-Path -LiteralPath $verFile -PathType Leaf) {
        $installedVer = ([IO.File]::ReadAllText($verFile)).Trim().ToLowerInvariant()
    }

    $installedLabel = 'Unknown (version could not be recorded)'
    if ($installedVer -match '^[0-9a-f]{40}$') {
        $installedLabel = $installedVer.Substring(0, 12)
    } elseif ($installedVer -match '^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
        $installedLabel = 'Legacy release ' + $installedVer + ' (will update from main)'
    } elseif ($installedVer) {
        $installedLabel = $installedVer
    } elseif (-not (Test-Path -LiteralPath (Join-Path $www 'index.html') -PathType Leaf)) {
        $installedLabel = 'Not installed'
    }

    Write-Host ''
    Write-Host ('Installed main commit: ' + $installedLabel) -ForegroundColor Green

    if ($remoteVer -match '^[0-9a-f]{40}$') {
        $latestLabel = $remoteVer.Substring(0, 12)
        Write-Host ('Latest main commit: ' + $latestLabel) -ForegroundColor Cyan

        if ($installedVer -eq $remoteVer) {
            Write-Host 'Status: DePDF is up to date with main.' -ForegroundColor Green
        } elseif (Test-Path -LiteralPath (Join-Path $www 'index.html') -PathType Leaf) {
            Write-Host 'Status: An update is available or the previous update could not be installed.' -ForegroundColor Yellow
        }
    } else {
        Write-Host 'Latest main commit: Unavailable' -ForegroundColor Yellow
        Write-Host 'Status: The installed build will be used; update status could not be verified.' -ForegroundColor DarkGray
    }

    $served = $false

    # ---- Preferred: Python 3 web server (127.0.0.1 only, nothing leaves this computer) ----
    $port = 0
    foreach ($p in 48711..48720) { if (Test-PortFree $p) { $port = $p; break } }
    if ($port -eq 0) { throw 'Could not find a free port to run DePDF on.' }

    $py = $null
    if (-not $env:DEPDF_PRIVATE_PYTHON) { $py = Find-Python }
    if (-not $py) {
        try { $py = Get-PrivatePython $root }
        catch { Write-Host ('Could not set up Python: ' + $_.Exception.Message) -ForegroundColor Yellow; $py = $null }
    }
    if ($py) {
        $serve = Join-Path $root 'serve.py'
        [IO.File]::WriteAllText($serve, $pySrc, (New-Object System.Text.UTF8Encoding($false)))
        $pyArgs = @()
        if ($py.Count -gt 1) { $pyArgs = @($py[1..($py.Count - 1)]) }
        $pyArgs += ('"' + $serve + '"'), ('"' + $www + '"'), "$port"
        $proc = Start-Process -FilePath $py[0] -ArgumentList $pyArgs -NoNewWindow -PassThru

        $ready = $false
        for ($i = 0; $i -lt 80; $i++) {
            if ($proc.HasExited) { break }
            $tc = New-Object System.Net.Sockets.TcpClient
            try { $tc.Connect('127.0.0.1', $port); $ready = $true } catch { Start-Sleep -Milliseconds 250 } finally { $tc.Close() }
            if ($ready) { break }
        }
        if ($ready) {
            $url = "http://127.0.0.1:$port/"
            Write-Host ''
            Write-Host "DePDF is running at $url (Python server)" -ForegroundColor Green
            Write-Host ('Stored in: ' + $root)
            Write-Host 'DePDF should open in its own window now. Keep this black window open while you use it.'
            Write-Host 'Close this black window to stop DePDF. Your PDFs never leave this computer.'
            Open-App $url
            $proc.WaitForExit()
            $served = $true
        } else {
            try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
            Write-Host 'The Python server did not start, using the built-in server instead.' -ForegroundColor Yellow
        }
    }

    # ---- Fallback: built-in PowerShell server (used when Python 3 is not installed) ----
    if (-not $served) {
        $mime = @{
            '.html' = 'text/html; charset=utf-8';  '.js'  = 'text/javascript; charset=utf-8'
            '.css'  = 'text/css; charset=utf-8';   '.json' = 'application/json'
            '.wasm' = 'application/wasm';          '.webmanifest' = 'application/manifest+json'
            '.png'  = 'image/png';                 '.svg' = 'image/svg+xml'
            '.zip'  = 'application/zip';           '.whl' = 'application/octet-stream'
            '.py'   = 'text/plain; charset=utf-8'
        }
        $wwwFull = [IO.Path]::GetFullPath($www).TrimEnd('\') + '\'

        $listener = $null
        foreach ($p in 48711..48720) {
            $l = New-Object System.Net.HttpListener
            $l.Prefixes.Add("http://127.0.0.1:$p/")
            try { $l.Start(); $listener = $l; $port = $p; break } catch { $l.Close() }
        }
        if (-not $listener) { throw 'Could not find a free port to run DePDF on.' }

        $url = "http://127.0.0.1:$port/"
        Write-Host ''
        Write-Host "DePDF is running at $url (built-in server)" -ForegroundColor Green
        Write-Host ('Stored in: ' + $root)
        Write-Host 'DePDF should open in its own window now. Keep this black window open while you use it.'
        Write-Host 'Close this black window to stop DePDF. Your PDFs never leave this computer.'
        Write-Host 'Files served (if loading ever gets stuck, the last line below shows which file):' -ForegroundColor DarkGray
        Open-App $url

        while ($listener.IsListening) {
            $ctx = $listener.GetContext()
            $rel = ''
            try {
                $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
                if ($rel -eq '') { $rel = 'index.html' }
                Write-Host ("  " + $rel) -NoNewline -ForegroundColor DarkGray
                $full = [IO.Path]::GetFullPath((Join-Path $www ($rel -replace '/', '\')))
                if (-not $full.StartsWith($wwwFull, [StringComparison]::OrdinalIgnoreCase) -or
                    -not (Test-Path -LiteralPath $full -PathType Leaf)) {
                    $ctx.Response.StatusCode = 404
                    Write-Host '  404' -ForegroundColor DarkGray
                } else {
                    $type = $mime[[IO.Path]::GetExtension($full).ToLowerInvariant()]
                    if (-not $type) { $type = 'application/octet-stream' }
                    $bytes = [IO.File]::ReadAllBytes($full)
                    $ctx.Response.ContentType = $type
                    $ctx.Response.ContentLength64 = $bytes.Length
                    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                    Write-Host ('  ok ' + $bytes.Length + ' bytes') -ForegroundColor DarkGray
                }
            } catch {
                Write-Host '  failed' -ForegroundColor DarkGray
                try { $ctx.Response.StatusCode = 500 } catch { }
            } finally {
                try { $ctx.Response.Close() } catch { }
            }
        }
    }
} catch {
    Write-Host ''
    Write-Host ('Something went wrong: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Check your internet connection (needed on the first run only) and try again.'
}
