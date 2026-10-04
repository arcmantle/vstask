$cliArguments = @($args)
$candidates = if ($env:VSTASK_RUNTIME) { @($env:VSTASK_RUNTIME) } else {
    @('node', 'bun', 'deno') | ForEach-Object {
        $command = Get-Command $_ -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { $command.Source }
    }
}

function Quote-NativeArgument([string] $value) {
    '"' + (($value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

foreach ($candidate in $candidates) {
    try {
        $version = @(& $candidate --version 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0) { continue }
        if ($version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 16) {
            $prefix = @()
        } elseif ($version -match '^[1-9]\d*\.\d+\.\d+') {
            $prefix = @()
        } elseif ($version -match '^deno ([2-9]|\d{2,})\.') {
            $prefix = @('run', '--allow-all', '--no-prompt', '--quiet')
        } else { continue }
    } catch { continue }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $candidate
    $start.UseShellExecute = $false
    $start.Arguments = (@($prefix + @((Join-Path $PSScriptRoot 'launch.cjs')) + $cliArguments) | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    try {
        $child = [System.Diagnostics.Process]::Start($start)
        $child.WaitForExit()
        exit $child.ExitCode
    } catch {
        [Console]::Error.WriteLine('The runtime could not start. No other runtime was started.')
        exit 1
    }
}
[Console]::Error.WriteLine('No usable runtime was found, or the explicit runtime is missing or unsupported. Install Node.js 22.16+ or 24 LTS, Bun 1.2+, or Deno 2.4+ (stable releases). See https://nodejs.org/, https://bun.sh/, or https://deno.com/.')
exit 1