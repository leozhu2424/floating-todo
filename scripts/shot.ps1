# Screen capture helper.
# 1) Layered/transparent windows only show up with CAPTUREBLT, so plain
#    CopyFromScreen is not enough here.
# 2) PowerShell 5.1 is DPI-unaware by default: Screen.Bounds reports DIP while
#    BitBlt works in device pixels. We call SetProcessDPIAware() so both agree,
#    and pass DIP rects scaled by -DpiScale.
# ASCII-only on purpose.
param(
    [int]$X = 0,
    [int]$Y = 0,
    [int]$W = 0,
    [int]$H = 0,
    [double]$DpiScale = 1.0,
    [int]$Scale = 1,
    [string]$Out = 'shot.png'
)

Add-Type -AssemblyName System.Drawing

if (-not ('ScreenCap' -as [type])) {
    $sig = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class ScreenCap {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);
    public static Bitmap Grab(int x, int y, int w, int h) {
        IntPtr src = GetDC(IntPtr.Zero);
        Bitmap bmp = new Bitmap(w, h);
        using (Graphics g = Graphics.FromImage(bmp)) {
            IntPtr dst = g.GetHdc();
            BitBlt(dst, 0, 0, w, h, src, x, y, 0x00CC0020 | 0x40000000);
            g.ReleaseHdc(dst);
        }
        ReleaseDC(IntPtr.Zero, src);
        return bmp;
    }
}
'@
    Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing
}

[void][ScreenCap]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

# full screen: no DIP scaling, use the physical bounds directly
if ($W -le 0) { $W = $screen.Width; $H = $screen.Height; $X = 0; $Y = 0; $DpiScale = 1.0 }

$px = [int][Math]::Round($X * $DpiScale)
$py = [int][Math]::Round($Y * $DpiScale)
$pw = [int][Math]::Round($W * $DpiScale)
$ph = [int][Math]::Round($H * $DpiScale)

# clamp inside the physical screen
if ($px -lt 0) { $px = 0 }
if ($py -lt 0) { $py = 0 }
if ($px + $pw -gt $screen.Width) { $pw = $screen.Width - $px }
if ($py + $ph -gt $screen.Height) { $ph = $screen.Height - $py }
if ($pw -le 0 -or $ph -le 0) { throw "invalid capture rect" }

$raw = [ScreenCap]::Grab($px, $py, $pw, $ph)

if ($Scale -gt 1) {
    $big = New-Object System.Drawing.Bitmap(($pw * $Scale), ($ph * $Scale))
    $g = [System.Drawing.Graphics]::FromImage($big)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.DrawImage($raw, 0, 0, $big.Width, $big.Height)
    $g.Dispose()
    $raw.Dispose()
    $raw = $big
}

$full = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Out))
$raw.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
$raw.Dispose()
Write-Output ("saved {0}  physical rect=({1},{2}) {3}x{4}  screen={5}x{6}" -f $full, $px, $py, $pw, $ph, $screen.Width, $screen.Height)
