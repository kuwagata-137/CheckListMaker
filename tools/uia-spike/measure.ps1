# =============================================================================
# 2-R0 UIA検証スパイク 計測ツール（PowerShell 版・予備）
#
# measure.js（koffi 版）が動かない環境向けの予備。Node.js のインストール不要で、
# Windows 標準の PowerShell 5.1 だけで動く。出力形式は measure.js と同じ JSONL。
#
# 実行:  powershell -ExecutionPolicy Bypass -File measure.ps1
# 停止:  このコンソールで q キー → 集計を表示・保存して終了
#
# 注意: こちらは .NET の旧 UIA クライアント（System.Windows.Automation）を使う。
#       本番実装（koffi + UIA COM）よりわずかに取得率が低く出る可能性がある。
# =============================================================================
$ErrorActionPreference = 'Continue'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# Win32: マウス押下検出（ポーリング）・カーソル座標・ウィンドウ情報・DPI 対応
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Spike {
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [StructLayout(LayoutKind.Sequential)] public struct PT { public int x; public int y; }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

# 物理座標で扱えるよう DPI 対応を宣言（古い OS では旧 API へフォールバック）
try {
  if (-not [Spike]::SetProcessDpiAwarenessContext([IntPtr]-4)) { [void][Spike]::SetProcessDPIAware() }
} catch { try { [void][Spike]::SetProcessDPIAware() } catch {} }

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$outFile = Join-Path $PSScriptRoot "results-$stamp.jsonl"
$summaryFile = Join-Path $PSScriptRoot "summary-$stamp.json"
$records = New-Object System.Collections.ArrayList

$ctNames = @{}
[System.Windows.Automation.ControlType].GetFields() | ForEach-Object {
  $v = $_.GetValue($null)
  if ($v -is [System.Windows.Automation.ControlType]) { $ctNames[$v.Id] = $_.Name }
}

function Resolve-Click([int]$x, [int]$y, [int]$button) {
  $t0 = Get-Date
  $rec = [ordered]@{
    ts = (Get-Date).ToString('o'); x = $x; y = $y; button = $button
    ok = $false; name = ''; controlType = 0; controlTypeName = ''
    localizedType = ''; className = ''; frameworkId = ''
    rect = $null; windowTitle = ''; appName = ''; pid = 0
    elapsedMs = 0; error = ''
  }
  # ウィンドウタイトル・アプリ名（UIA が失敗しても取れる系統）
  try {
    $pt = New-Object Spike+PT; $pt.x = $x; $pt.y = $y
    $hwnd = [Spike]::WindowFromPoint($pt)
    if ($hwnd -ne [IntPtr]::Zero) {
      $root = [Spike]::GetAncestor($hwnd, 2); if ($root -eq [IntPtr]::Zero) { $root = $hwnd }
      $sb = New-Object System.Text.StringBuilder 512
      [void][Spike]::GetWindowText($root, $sb, 512)
      $rec.windowTitle = $sb.ToString()
      $procId = [uint32]0
      [void][Spike]::GetWindowThreadProcessId($root, [ref]$procId)
      $rec.pid = [int]$procId
      if ($procId) {
        try { $rec.appName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName + '.exe' } catch {}
      }
    }
  } catch {}
  # UIA 解決
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromPoint(
      (New-Object System.Windows.Point($x, $y)))
    if ($el) {
      $rec.ok = $true
      $c = $el.Current
      $rec.name = [string]$c.Name
      $rec.controlType = $c.ControlType.Id
      $rec.controlTypeName = if ($ctNames.ContainsKey($c.ControlType.Id)) { $ctNames[$c.ControlType.Id] } else { [string]$c.ControlType.Id }
      $rec.localizedType = [string]$c.LocalizedControlType
      $rec.className = [string]$c.ClassName
      $rec.frameworkId = [string]$c.FrameworkId
      $r = $c.BoundingRectangle
      if (-not $r.IsEmpty) { $rec.rect = @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height) }
    }
  } catch { $rec.error = $_.Exception.Message }
  $rec.elapsedMs = [int]((Get-Date) - $t0).TotalMilliseconds
  return $rec
}

Write-Host '計測を開始しました。ふだんの操作どおり対象アプリをクリックしてください。'
Write-Host "  記録先: $outFile"
Write-Host '  終了: このコンソールで q キー'
Write-Host '  ※ このコンソール自体はクリックしないでください' -ForegroundColor Yellow
Write-Host ''

$prevL = $false; $prevR = $false
while ($true) {
  if ([Console]::KeyAvailable) {
    $k = [Console]::ReadKey($true)
    if ($k.KeyChar -eq 'q') { break }
  }
  $l = ([Spike]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0
  $r = ([Spike]::GetAsyncKeyState(0x02) -band 0x8000) -ne 0
  $button = 0
  if ($l -and -not $prevL) { $button = 1 }
  elseif ($r -and -not $prevR) { $button = 2 }
  $prevL = $l; $prevR = $r
  if ($button -ne 0) {
    $pt = New-Object Spike+PT
    [void][Spike]::GetCursorPos([ref]$pt)
    $rec = Resolve-Click $pt.x $pt.y $button
    [void]$records.Add($rec)
    ($rec | ConvertTo-Json -Compress -Depth 4) | Add-Content -Encoding UTF8 $outFile
    $label = if ($rec.name) { '「' + $rec.name.Substring(0, [Math]::Min(30, $rec.name.Length)) + '」' } else { '(名前なし)' }
    Write-Host ("[{0,3}] {1} | {2} | {3} | {4}ms" -f $records.Count, $rec.appName, $rec.controlTypeName, $label, $rec.elapsedMs)
  }
  Start-Sleep -Milliseconds 15
}

# ── 集計 ─────────────────────────────────────────────────────
if ($records.Count -eq 0) { Write-Host '記録は0件でした。'; exit 0 }
$groups = $records | Group-Object { if ($_.appName) { $_.appName.ToLower() } else { '(不明)' } }
$rows = foreach ($g in ($groups | Sort-Object Count -Descending)) {
  $namedCount = @($g.Group | Where-Object { $_.ok -and $_.name -and $_.name.Trim() }).Count
  $ms = @($g.Group | ForEach-Object { $_.elapsedMs }) | Sort-Object
  [ordered]@{
    app = $g.Group[0].appName
    total = $g.Count
    resolved = @($g.Group | Where-Object { $_.ok }).Count
    named = $namedCount
    namedRate = [int][Math]::Round(100.0 * $namedCount / $g.Count)
    medianMs = if ($ms.Count) { $ms[[int][Math]::Floor($ms.Count / 2)] } else { 0 }
  }
}
$totalNamed = @($records | Where-Object { $_.ok -and $_.name -and $_.name.Trim() }).Count
$summary = [ordered]@{
  total = $records.Count
  named = $totalNamed
  namedRate = [int][Math]::Round(100.0 * $totalNamed / $records.Count)
  byApp = @($rows)
}
Write-Host ''
Write-Host '──── 集計（要素名の取得率） ────'
Write-Host ("全体: {0}/{1} = {2}%" -f $summary.named, $summary.total, $summary.namedRate)
foreach ($r in $rows) {
  Write-Host ("{0,-28} | {1,6} | 名前あり {2,4} | {3,4}% | {4}ms" -f $r.app, $r.total, $r.named, $r.namedRate, $r.medianMs)
}
($summary | ConvertTo-Json -Depth 4) | Set-Content -Encoding UTF8 $summaryFile
Write-Host ''
Write-Host "結果ファイル:`n  $outFile`n  $summaryFile"
Write-Host '→ この2ファイルを開発セッションへ共有してください（README の注意も参照）。'
