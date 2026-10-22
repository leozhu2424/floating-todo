# Generate tray / app icons: a six-colour gradient ball.
# Pure System.Drawing, no external deps. ASCII-only on purpose:
# Windows PowerShell 5.1 mis-decodes BOM-less UTF-8 files.
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$outDir = $PSScriptRoot
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Gradient stops, angle 0..360
$stops = @(
    @{ a = 0;   c = @(66, 133, 244) },
    @{ a = 60;  c = @(155, 114, 203) },
    @{ a = 120; c = @(217, 101, 112) },
    @{ a = 180; c = @(249, 171, 0) },
    @{ a = 240; c = @(52, 168, 83) },
    @{ a = 300; c = @(66, 133, 244) },
    @{ a = 360; c = @(66, 133, 244) }
)

function Get-ColorAtAngle([double]$angle) {
    $a = (($angle % 360) + 360) % 360
    for ($i = 0; $i -lt $stops.Count - 1; $i++) {
        $s0 = $stops[$i]
        $s1 = $stops[$i + 1]
        if ($a -ge $s0.a -and $a -le $s1.a) {
            $span = $s1.a - $s0.a
            $t = if ($span -le 0) { 0 } else { ($a - $s0.a) / $span }
            $r = [int]($s0.c[0] + ($s1.c[0] - $s0.c[0]) * $t)
            $g = [int]($s0.c[1] + ($s1.c[1] - $s0.c[1]) * $t)
            $b = [int]($s0.c[2] + ($s1.c[2] - $s0.c[2]) * $t)
            return [System.Drawing.Color]::FromArgb(255, $r, $g, $b)
        }
    }
    return [System.Drawing.Color]::FromArgb(255, 66, 133, 244)
}

function New-BallPng([int]$size, [string]$file) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $pad = [double]$size * 0.02
    $rect = New-Object System.Drawing.RectangleF($pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))

    $clip = New-Object System.Drawing.Drawing2D.GraphicsPath
    $clip.AddEllipse($rect)
    $g.SetClip($clip)

    # 360 thin pie slices to fake a conic gradient.
    # GDI+ angle 0 = 3 o'clock, positive = clockwise. Start at 12 o'clock (-90)
    # so this matches CSS `conic-gradient(from 0deg, ...)`.
    $steps = 360
    $slice = 360.0 / $steps
    for ($i = 0; $i -lt $steps; $i++) {
        $ang = $i * $slice
        $col = Get-ColorAtAngle $ang
        $brush = New-Object System.Drawing.SolidBrush($col)
        $g.FillPie($brush, $rect.X, $rect.Y, $rect.Width, $rect.Height, [single](-90.0 + $ang), [single]($slice + 1.5))
        $brush.Dispose()
    }

    # Radial highlight, offset to upper-left (soft, not a white wash)
    $hlPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $hlPath.AddEllipse($rect)
    $hl = New-Object System.Drawing.Drawing2D.PathGradientBrush($hlPath)
    $hl.CenterColor = [System.Drawing.Color]::FromArgb(95, 255, 255, 255)
    $hl.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
    $hl.CenterPoint = New-Object System.Drawing.PointF(
        [single]($rect.X + $rect.Width * 0.30),
        [single]($rect.Y + $rect.Height * 0.24))
    $g.FillEllipse($hl, $rect)
    $hl.Dispose()
    $hlPath.Dispose()

    # Radial shade toward lower-right
    $shPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $shPath.AddEllipse($rect)
    $sh = New-Object System.Drawing.Drawing2D.PathGradientBrush($shPath)
    $sh.CenterColor = [System.Drawing.Color]::FromArgb(60, 0, 0, 0)
    $sh.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    $sh.CenterPoint = New-Object System.Drawing.PointF(
        [single]($rect.X + $rect.Width * 0.74),
        [single]($rect.Y + $rect.Height * 0.80))
    $g.FillEllipse($sh, $rect)
    $sh.Dispose()
    $shPath.Dispose()

    $g.ResetClip()

    $penWidth = [single]([Math]::Max(1.0, $size / 96.0))
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(50, 255, 255, 255), $penWidth)
    $g.DrawEllipse($pen, $rect)
    $pen.Dispose()

    $g.Dispose()
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ("wrote {0} ({1}x{1})" -f $file, $size)
}

New-BallPng 16  (Join-Path $outDir 'tray.png')
New-BallPng 32  (Join-Path $outDir 'tray@2x.png')
New-BallPng 256 (Join-Path $outDir 'icon.png')

# Multi-size PNGs for the .ico container (scripts/make-ico.js assembles them)
$icoDir = Join-Path $outDir 'ico-src'
New-Item -ItemType Directory -Force -Path $icoDir | Out-Null
foreach ($s in 16, 24, 32, 48, 64, 128, 256) {
    New-BallPng $s (Join-Path $icoDir ("icon-{0}.png" -f $s))
}
