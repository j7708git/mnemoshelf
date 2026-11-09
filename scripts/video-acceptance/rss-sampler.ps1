$source = @"
using System;
using System.Runtime.InteropServices;
public static class VideoRssSampler {
    [StructLayout(LayoutKind.Sequential)]
    private struct Counters {
        public uint cb, pageFaultCount;
        public UIntPtr peakWorkingSetSize, workingSetSize, quotaPeakPagedPoolUsage, quotaPagedPoolUsage;
        public UIntPtr quotaPeakNonPagedPoolUsage, quotaNonPagedPoolUsage, pagefileUsage, peakPagefileUsage;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { public uint low, high; }
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool K32GetProcessMemoryInfo(IntPtr process, out Counters counters, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    private static ulong ToTicks(FileTime value) { return ((ulong)value.high << 32) | value.low; }
    public static long WorkingSet(int pid) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return -1;
        try {
            uint size = (uint)Marshal.SizeOf(typeof(Counters));
            Counters counters = new Counters();
            counters.cb = size;
            return K32GetProcessMemoryInfo(process, out counters, size) ? (long)counters.workingSetSize.ToUInt64() : -1;
        } finally { CloseHandle(process); }
    }
    public static long CpuMs() {
        FileTime created, exited, kernel, user;
        return GetProcessTimes(GetCurrentProcess(), out created, out exited, out kernel, out user) ? (long)((ToTicks(kernel) + ToTicks(user)) / 10000UL) : -1;
    }
}
"@
Add-Type -TypeDefinition $source -ErrorAction Stop
while ($null -ne ($line = [Console]::In.ReadLine())) {
    try {
        $parts = $line.Split(',')
        $sampleId = [int]$parts[0]
        $items = [System.Collections.Generic.List[string]]::new()
        for ($i = 1; $i -lt $parts.Length; $i++) {
            $targetId = [int]$parts[$i]
            $rss = [VideoRssSampler]::WorkingSet($targetId)
            if ($rss -ge 0) { $items.Add('{"pid":' + $targetId + ',"rss":' + $rss + '}') }
        }
        $cpuMs = [VideoRssSampler]::CpuMs()
        [Console]::Out.WriteLine('{"id":' + $sampleId + ',"cpuMs":' + $cpuMs + ',"items":[' + [string]::Join(',', $items) + ']}')
    } catch {
        $errorType = $_.Exception.GetType().Name
        $errorLine = [int]$_.InvocationInfo.ScriptLineNumber
        [Console]::Out.WriteLine('{"id":-1,"items":[],"error":"sample-failed","errorType":"' + $errorType + '","errorLine":' + $errorLine + '}')
    }
}
