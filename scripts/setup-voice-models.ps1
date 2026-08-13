param(
  [string]$SttRepository = "Systran/faster-whisper-tiny",
  [string]$PiperVoice = "en_US-lessac-medium"
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
& $python -m piper.download_voices --download-dir $modelRoot $PiperVoice
if ($LASTEXITCODE -ne 0) { throw "Piper voice download failed." }
Write-Host "Voice models are ready under models/voice (ignored by Git)."
