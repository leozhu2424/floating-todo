# Mouse automation for UI verification (physical pixels, DPI-aware).
# ASCII-only on purpose.
param(
    [Parameter(Mandatory = $true)][string]$Action,
    [int]$X = 0,
    [int]$Y = 0,
    [int]$ToX = 0,
    [int]$ToY = 0,
    [int]$MoveDelay = 400,
    [int]$WheelDelta = -3
)

Add-Type -AssemblyName System.Windows.Forms

if (-not ('MouseSim' -as [type])) {
    $sig = @'
using System;
using System.Runtime.InteropServices;
public class MouseSim {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

    public const uint DOWN = 0x0002;
    public const uint UP   = 0x0004;
    public const uint WHEEL = 0x0800;

    public static POINT Pos() {
        POINT p; GetCursorPos(out p); return p;
    }
    public static void MoveTo(int x, int y) { SetCursorPos(x, y); }
    public static void LeftDown() { mouse_event(DOWN, 0, 0, 0, UIntPtr.Zero); }
    public static void LeftUp() { mouse_event(UP, 0, 0, 0, UIntPtr.Zero); }
    public static void Spin(int notches) {
        // one wheel notch = 120 units; negative scrolls down
        mouse_event(WHEEL, 0, 0, (uint)(notches * 120), UIntPtr.Zero);
    }
}
'@
    Add-Type -TypeDefinition $sig
}

[void][MouseSim]::SetProcessDPIAware()

function Smooth-Move([int]$fx, [int]$fy, [int]$tx, [int]$ty, [int]$steps = 18, [int]$stepDelay = 12) {
    for ($i = 1; $i -le $steps; $i++) {
        $t = $i / [double]$steps
        $ease = $t * $t * (3 - 2 * $t)
        $px = [int]($fx + ($tx - $fx) * $ease)
        $py = [int]($fy + ($ty - $fy) * $ease)
        [void][MouseSim]::MoveTo($px, $py)
        Start-Sleep -Milliseconds $stepDelay
    }
}

$orig = [MouseSim]::Pos()

switch ($Action) {
    'click' {
        Smooth-Move $orig.X $orig.Y $X $Y
        Start-Sleep -Milliseconds $MoveDelay
        [MouseSim]::LeftDown()
        Start-Sleep -Milliseconds 60
        [MouseSim]::LeftUp()
        Write-Output "clicked $X,$Y"
    }
    'move' {
        Smooth-Move $orig.X $orig.Y $X $Y
        Write-Output "moved to $X,$Y"
    }
    'wheel' {
        Smooth-Move $orig.X $orig.Y $X $Y
        Start-Sleep -Milliseconds $MoveDelay
        [MouseSim]::Spin($WheelDelta)
        Write-Output ("wheel {0} notches at {1},{2}" -f $WheelDelta, $X, $Y)
    }
    'drag' {
        Smooth-Move $orig.X $orig.Y $X $Y
        Start-Sleep -Milliseconds $MoveDelay
        [MouseSim]::LeftDown()
        Start-Sleep -Milliseconds 80
        # small jitter first so the 4px drag threshold trips
        Smooth-Move $X $Y ($X + 6) ($Y + 2) 4 15
        Smooth-Move ($X + 6) ($Y + 2) $ToX $ToY 22 14
        Start-Sleep -Milliseconds 120
        [MouseSim]::LeftUp()
        Write-Output "dragged $X,$Y -> $ToX,$ToY"
    }
    'restore' {
        [void][MouseSim]::MoveTo($orig.X, $orig.Y)
        Write-Output "restored"
    }
    default { throw "unknown action: $Action" }
}
