# win-tracker.ps1 - Enhanced OS Monitor for TIMEROI v2
# Outputs JSON lines every 600ms with foreground window info, idle time, and window rect

$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
}
"@

$lastInputInfo = New-Object Win32+LASTINPUTINFO
$lastInputInfo.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lastInputInfo)

# Cache process names to reduce Get-Process calls
$processCache = @{}
$cacheCleanupCounter = 0

while ($true) {
    try {
        $hWnd = [Win32]::GetForegroundWindow()

        # Get Window Title
        $titleSB = New-Object System.Text.StringBuilder 1024
        $null = [Win32]::GetWindowText($hWnd, $titleSB, 1024)
        $title = $titleSB.ToString()

        # Get Process ID and Name (with caching)
        $processId = 0
        $null = [Win32]::GetWindowThreadProcessId($hWnd, [ref]$processId)

        $processName = ""
        if ($processId -gt 0) {
            if ($processCache.ContainsKey($processId)) {
                $processName = $processCache[$processId]
            } else {
                $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
                if ($process) {
                    $processName = $process.ProcessName
                    $processCache[$processId] = $processName
                }
            }
        }

        # Periodically clean stale cache entries (every ~50 ticks ≈ 30 seconds)
        $cacheCleanupCounter++
        if ($cacheCleanupCounter -ge 50) {
            $cacheCleanupCounter = 0
            $processCache.Clear()
        }

        # Get Idle Time (milliseconds)
        $idleMs = 0
        if ([Win32]::GetLastInputInfo([ref]$lastInputInfo)) {
            $currentTicks = [Environment]::TickCount
            $lastInputTicks = $lastInputInfo.dwTime
            $diff = [uint32]$currentTicks - [uint32]$lastInputTicks
            $idleMs = [int]$diff
        }

        # Get Window position and size
        $rect = New-Object Win32+RECT
        $left = 0; $top = 0; $right = 0; $bottom = 0
        if ([Win32]::GetWindowRect($hWnd, [ref]$rect)) {
            $left = $rect.Left
            $top = $rect.Top
            $right = $rect.Right
            $bottom = $rect.Bottom
        }

        # Check if window is minimized
        $isMinimized = [Win32]::IsIconic($hWnd)

        # Format output as compact JSON
        $result = @{
            title = $title
            process = $processName
            idleMs = $idleMs
            left = $left
            top = $top
            right = $right
            bottom = $bottom
            minimized = [bool]$isMinimized
            pid = $processId
            timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }

        $json = $result | ConvertTo-Json -Compress
        Write-Output $json
    } catch {
        # Catch errors to prevent script crash
    }
    Start-Sleep -Milliseconds 600
}
