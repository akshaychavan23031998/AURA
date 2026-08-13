param(
  [string]$SttRepository = "Systran/faster-whisper-tiny",
  [string[]]$PiperVoices = @(
    "en_US-lessac-medium",
    "hi_IN-pratham-medium",
    "te_IN-padmavathi-medium"
  )
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $repositoryRoot "services/voice/.venv/Scripts/python.exe"
$modelRoot = Join-Path $repositoryRoot "models/voice"
$sttTarget = Join-Path $modelRoot "faster-whisper-tiny"

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  throw "Voice venv is missing. Create services/voice/.venv and install the speech extras first."
}
New-Item -ItemType Directory -Force -Path $modelRoot | Out-Null
& $python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='$SttRepository', local_dir=r'$sttTarget')"
if ($LASTEXITCODE -ne 0) { throw "STT model download failed." }
& $python -m piper.download_voices --download-dir $modelRoot $PiperVoices
if ($LASTEXITCODE -ne 0) { throw "Piper voice download failed." }
$expectedMd5 = @{
  "hi_IN-pratham-medium.onnx" = "f1e5a629a9e533a7155910530109eb86"
  "hi_IN-pratham-medium.onnx.json" = "ab655cdad90f1939f00d1b3aaf440e99"
  "te_IN-padmavathi-medium.onnx" = "d38cc2093220163c6d680381ca10bf10"
  "te_IN-padmavathi-medium.onnx.json" = "3f07441340aecc2a8b89987361e8078e"
}
foreach ($entry in $expectedMd5.GetEnumerator()) {
  $path = Join-Path $modelRoot $entry.Key
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Required voice asset is missing: $($entry.Key)"
  }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm MD5).Hash.ToLowerInvariant()
  if ($actual -ne $entry.Value) {
    throw "Voice asset checksum failed: $($entry.Key)"
  }
}
Write-Host "Voice models are ready under models/voice (ignored by Git)."
