param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Info {
    param([string]$Message)
    Write-Host "➜ $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-Error {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
    exit 1
}

try {
    $ExtensionDir = Join-Path $PSScriptRoot "pro-viewer-extension"

    Write-Info "Building CoDeSys V2.3 Text Editor extension..."
    Write-Info "Working directory: $ExtensionDir"

    if ($DryRun) {
        Write-Host "`n[DRY RUN] Would execute:" -ForegroundColor Yellow
        Write-Host "  cd '$ExtensionDir'"
        Write-Host "  npx vsce package"
        $VsixPath = Join-Path $ExtensionDir "codesys-v2-text-editor-0.0.1.vsix"
        Write-Host "  code --install-extension '$VsixPath'"
        Write-Host ""
        exit 0
    }

    Push-Location $ExtensionDir

    Write-Info "Packaging VSIX..."
    npx vsce package

    $VsixPath = Join-Path $ExtensionDir "codesys-v2-text-editor-0.0.1.vsix"

    if (-not (Test-Path $VsixPath)) {
        Write-Error "VSIX file not found: $VsixPath"
    }

    Write-Info "Installing extension into VS Code..."
    code --install-extension $VsixPath

    Write-Success "Extension installed successfully!"

    Pop-Location
}
catch {
    Write-Error $_.Exception.Message
}
