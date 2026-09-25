# Rebuild the Windows icon from the same crown-and-score motif as src/icon.svg.
Add-Type -AssemblyName System.Drawing

$size = 256
$bitmap = [System.Drawing.Bitmap]::new($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$tile = [System.Drawing.Drawing2D.GraphicsPath]::new()
$tile.AddArc(8, 8, 72, 72, 180, 90)
$tile.AddArc(176, 8, 72, 72, 270, 90)
$tile.AddArc(176, 176, 72, 72, 0, 90)
$tile.AddArc(8, 176, 72, 72, 90, 90)
$tile.CloseFigure()
$gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Point]::new(0, 0), [System.Drawing.Point]::new(256, 256),
  [System.Drawing.Color]::FromArgb(255, 255, 55, 95),
  [System.Drawing.Color]::FromArgb(255, 184, 33, 120)
)
$graphics.FillPath($gradient, $tile)

$crown = [System.Drawing.Drawing2D.GraphicsPath]::new()
$points = [System.Drawing.Point[]]@(
  [System.Drawing.Point]::new(60, 172), [System.Drawing.Point]::new(60, 122),
  [System.Drawing.Point]::new(96, 146), [System.Drawing.Point]::new(128, 78),
  [System.Drawing.Point]::new(160, 146), [System.Drawing.Point]::new(196, 122),
  [System.Drawing.Point]::new(196, 172)
)
$crown.AddPolygon($points)
$dark = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 12, 16, 23))
$white = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 8)
$cyan = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 37, 244, 238), 14)
$cyan.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$cyan.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.FillPath($dark, $crown)
$graphics.DrawPath($white, $crown)
$graphics.DrawLine($cyan, 80, 195, 176, 195)
$graphics.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 37, 244, 238)), 119, 68, 18, 18)

$png = [System.IO.MemoryStream]::new()
$bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $png.ToArray()
$iconPath = Join-Path $PSScriptRoot '..\assets\icon.ico'
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($iconPath))) | Out-Null
$file = [System.IO.File]::Create($iconPath)
try {
  $writer = [System.IO.BinaryWriter]::new($file)
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]1)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$pngBytes.Length)
  $writer.Write([UInt32]22)
  $writer.Write($pngBytes)
  $writer.Flush()
} finally {
  $file.Dispose()
  $png.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
  $tile.Dispose()
  $gradient.Dispose()
  $crown.Dispose()
  $dark.Dispose()
  $white.Dispose()
  $cyan.Dispose()
}
