# Regenerates apple-touch-icon.png, pwa-192.png, pwa-512.png from public/branding/app-icon-source.png
# (Run after replacing app-icon-source.png with a new master icon.)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $PSScriptRoot
$public = Join-Path $dir 'public'
$src = Join-Path (Join-Path $public 'branding') 'app-icon-source.png'

if (-not (Test-Path -LiteralPath $src)) {
  Write-Error "Missing source image: $src"
}

$img = [System.Drawing.Image]::FromFile($src)

function Export-IconSize {
  param([int]$Size, [string]$OutPath)
  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($img, 0, 0, $Size, $Size)
  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Host "Wrote $OutPath"
}

Export-IconSize -Size 180 -OutPath (Join-Path $public 'apple-touch-icon.png')
Export-IconSize -Size 192 -OutPath (Join-Path $public 'pwa-192.png')
Export-IconSize -Size 512 -OutPath (Join-Path $public 'pwa-512.png')

$img.Dispose()
