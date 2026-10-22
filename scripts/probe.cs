using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Probe {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);

    public static List<IntPtr> All() {
        var l = new List<IntPtr>();
        EnumWindows((h, p) => { l.Add(h); return true; }, IntPtr.Zero);
        return l;
    }

    public static string[] Describe(uint[] pids) {
        var outList = new List<string>();
        foreach (var h in All()) {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            bool owned = false;
            foreach (var p in pids) if (p == pid) owned = true;
            if (!owned) continue;
            if (!IsWindowVisible(h)) continue;
            var sb = new StringBuilder(256);
            GetWindowTextW(h, sb, 256);
            var title = sb.ToString();
            if (title.Length == 0) continue;
            RECT r;
            GetWindowRect(h, out r);
            int ex = GetWindowLong(h, -20);
            bool transparent = (ex & 0x20) != 0;
            outList.Add(title + "|" + r.L + "," + r.T + "," + r.R + "," + r.B + "|" + (transparent ? "1" : "0") + "|" + h.ToInt64());
        }
        return outList.ToArray();
    }

    public static string TopAt(int x, int y) {
        POINT p; p.X = x; p.Y = y;
        IntPtr h = WindowFromPoint(p);
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        var sb = new StringBuilder(256);
        GetWindowTextW(h, sb, 256);
        return "hwnd=" + h.ToInt64() + " pid=" + pid + " title=" + sb.ToString();
    }

    public static void Click() {
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }
}
