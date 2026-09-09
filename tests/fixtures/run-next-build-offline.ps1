[CmdletBinding()]
param(
  [switch]$VerifyEnvironmentIsolation
)

$variableName = "NEXT_FONT_GOOGLE_MOCKED_RESPONSES"
$fixturePath = (Resolve-Path (
  Join-Path $PSScriptRoot "next-font-google-responses.cjs"
)).Path
$hadPreviousValue = Test-Path -LiteralPath "Env:\$variableName"
$previousValue = [Environment]::GetEnvironmentVariable(
  $variableName,
  [EnvironmentVariableTarget]::Process
)
$buildExitCode = 0

try {
  [Environment]::SetEnvironmentVariable(
    $variableName,
    $fixturePath,
    [EnvironmentVariableTarget]::Process
  )
  if ($VerifyEnvironmentIsolation) {
    $activeValue = [Environment]::GetEnvironmentVariable(
      $variableName,
      [EnvironmentVariableTarget]::Process
    )
    if ($activeValue -ne $fixturePath) {
      throw "offline font fixture was not scoped to the build process"
    }
  }
  else {
    & npm.cmd run build
    $buildExitCode = $LASTEXITCODE
  }
}
finally {
  if ($hadPreviousValue) {
    [Environment]::SetEnvironmentVariable(
      $variableName,
      $previousValue,
      [EnvironmentVariableTarget]::Process
    )
  }
  else {
    [Environment]::SetEnvironmentVariable(
      $variableName,
      $null,
      [EnvironmentVariableTarget]::Process
    )
  }
}

$restoredValue = [Environment]::GetEnvironmentVariable(
  $variableName,
  [EnvironmentVariableTarget]::Process
)
if ($VerifyEnvironmentIsolation) {
  if ($hadPreviousValue -and $restoredValue -ne $previousValue) {
    throw "offline font fixture did not restore the caller value"
  }
  if (-not $hadPreviousValue -and $null -ne $restoredValue) {
    throw "offline font fixture persisted in an initially clean environment"
  }
  if ($hadPreviousValue) {
    Write-Output "restored:$restoredValue"
  }
  else {
    Write-Output "restored:<absent>"
  }
}

if ($buildExitCode -ne 0) {
  exit $buildExitCode
}
