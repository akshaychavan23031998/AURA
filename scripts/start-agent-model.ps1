$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$modelPath = Join-Path $repositoryRoot "services\agent\models\Qwen3-4B-Q4_K_M.gguf"
if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) {
    throw "Model missing. Run: pnpm.cmd agent:model:setup"
}

$llamaServer = Get-Command llama-server.exe -ErrorAction SilentlyContinue
$llamaServerPath = if ($null -ne $llamaServer) { $llamaServer.Source } else { $null }
if ($null -eq $llamaServerPath) {
    $packageRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    $llamaServerPath = Get-ChildItem $packageRoot -Directory -Filter "ggml.llamacpp*" `
        -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Filter "llama-server.exe" -Recurse } |
        Select-Object -First 1 -ExpandProperty FullName
}
if ($null -eq $llamaServerPath) {
    throw "llama.cpp is missing. Install it with: winget install --exact --id ggml.llamacpp"
}

& $llamaServerPath `
    --model $modelPath `
    --host 127.0.0.1 `
    --port 8080 `
    --ctx-size 4096 `
    --parallel 1 `
    --threads 4 `
    --no-webui
