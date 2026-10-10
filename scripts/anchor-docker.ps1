# Anchor 0.31.1 toolchain in Docker for programs/quantum-hooks (no host Rust/Solana needed).
#   scripts\anchor-docker.ps1 build        release build + IDL (-> shared\idl\quantum_hooks.json)
#   scripts\anchor-docker.ps1 build-test   test build with the `short-expiry` feature (target\deploy-test)
#   scripts\anchor-docker.ps1 unit         Rust unit tests
#   scripts\anchor-docker.ps1 keys         check the program keypair and print the program id
#   scripts\anchor-docker.ps1 validator <program id> <authority pubkey>   test validator on :8899
#   scripts\anchor-docker.ps1 shell | <any command>
# `build` and `keys` need the backed-up target\deploy\quantum_hooks-keypair.json matching
# declare_id!; they stop instead of generating one. $env:QUANTPAD_NEW_PROGRAM_ID = '1' (passed
# through) opts in to generating a new program id.
# Cargo's target dir, registry and git cache live in named volumes (fast on Windows, survive
# retries); target\deploy, target\deploy-test, target\idl and target\types are bind-mounted back.
$ErrorActionPreference = 'Stop'
$Image = if ($env:ANCHOR_IMAGE) { $env:ANCHOR_IMAGE } else { 'solanafoundation/anchor:v0.31.1' }
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Ws = Join-Path $Repo 'programs\quantum-hooks'
foreach ($d in 'deploy', 'deploy-test', 'idl', 'types') {
  New-Item -ItemType Directory -Force (Join-Path $Ws "target\$d") | Out-Null
}
$Cmd = if ($args.Count -gt 0) { [string]$args[0] } else { 'build' }
$Rest = if ($args.Count -gt 1) { @($args[1..($args.Count - 1)] | ForEach-Object { [string]$_ }) } else { @() }

$T = '/work/programs/quantum-hooks/target'
$DockerArgs = @('run', '--rm')
if ($Cmd -eq 'shell' -and [Environment]::UserInteractive) { $DockerArgs += '-it' }
if ($Cmd -eq 'validator') { $DockerArgs += @('-p', '127.0.0.1:8899:8899', '-p', '127.0.0.1:8900:8900') }
$DockerArgs += @(
  '-e', 'CARGO_NET_RETRY=10', '-e', 'CARGO_HTTP_TIMEOUT=120', '-e', 'QUANTPAD_NEW_PROGRAM_ID',
  '--mount', "type=bind,source=$Repo,target=/work",
  '--mount', "type=volume,source=quantum-hooks-target,target=$T",
  '--mount', "type=bind,source=$(Join-Path $Ws 'target\deploy'),target=$T/deploy",
  '--mount', "type=bind,source=$(Join-Path $Ws 'target\deploy-test'),target=$T/deploy-test",
  '--mount', "type=bind,source=$(Join-Path $Ws 'target\idl'),target=$T/idl",
  '--mount', "type=bind,source=$(Join-Path $Ws 'target\types'),target=$T/types",
  '--mount', 'type=volume,source=quantum-hooks-cargo-registry,target=/root/.cargo/registry',
  '--mount', 'type=volume,source=quantum-hooks-cargo-git,target=/root/.cargo/git',
  '--mount', 'type=volume,source=quantum-hooks-solana-cache,target=/root/.cache/solana',
  '-w', '/work/programs/quantum-hooks',
  # No double quotes in this argument: Windows PowerShell 5.1 mangles them for native commands.
  $Image, 'bash', '-c', 'tr -d ''\015'' < scripts/in-container.sh > /tmp/ic.sh && exec bash /tmp/ic.sh $@', '_', $Cmd
) + $Rest

& docker @DockerArgs
exit $LASTEXITCODE
