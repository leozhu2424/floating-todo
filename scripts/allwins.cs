using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class AllWins {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);

    public static string[] List(uint[] pids) {
        var res = new List<string>();
        EnumWindows((h, p) => {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            bool owned = false;
            foreach (var q in pids) if (q == pid) owned = true;
            if (!owned) return true;

            var cls = new StringBuilder(256);
            GetClassNameW(h, cls, 256);
            var title = new StringBuilder(256);
            GetWindowTextW(h, title, 256);

            RECT r;
            GetWindowRect(h, out r);
            int ex = GetWindowLong(h, -20);
            bool transparent = (ex & 0x20) != 0;
            bool topmost = (ex & 0x8) != 0;

            res.Add(string.Format(
                "hwnd={0} pid={1} vis={2} {3}x{4} at {5},{6} 穿透={7} 置顶={8} class={9} title='{10}'",
                h.ToInt64(), pid, IsWindowVisible(h) ? 1 : 0,
                r.R - r.L, r.B - r.T, r.L, r.T,
                transparent ? 1 : 0, topmost ? 1 : 0, cls.ToString(), title.ToString()));
            return true;
        }, IntPtr.Zero);
        return res.ToArray();
    }
}
