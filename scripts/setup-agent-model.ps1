$ErrorActionPreference = "Stop"

$modelUrl = "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf"
$expectedSha256 = "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$modelDirectory = Join-Path $repositoryRoot "services\agent\models"
$modelPath = Join-Path $modelDirectory "Qwen3-4B-Q4_K_M.gguf"

New-Item -ItemType Directory -Path $modelDirectory -Force | Out-Null

if (Test-Path -LiteralPath $modelPath) {
    $actualSha256 = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -eq $expectedSha256) {
        Write-Output "Model already present and verified: $modelPath"
        exit 0
    }
}

Write-Output "Downloading Qwen3-4B Q4_K_M (approximately 2.5 GB)..."
& curl.exe --fail --location --continue-at - --output $modelPath $modelUrl
if ($LASTEXITCODE -ne 0) {
    throw "Model download failed. Re-run this script to resume."
}

$actualSha256 = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
    throw "Model checksum verification failed. Remove the local file and retry."
}

Write-Output "Model downloaded and SHA-256 verified: $modelPath"
