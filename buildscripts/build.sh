#!/usr/bin/env bash
# One-command repository build: install the pnpm workspace, then hand the
# selected scope to `pnpm run build` (`scripts/build.ts`). The package.json
# scripts stay the single source of truth for what each scope emits, so this
# wrapper only sequences install and build and forwards the build selection.
#
# Windows contributors run it through Git Bash.
#
# Usage: buildscripts/build.sh [options]
#   --skip-install        reuse the existing node_modules
#   --frozen              install with --frozen-lockfile (CI)
#   --scope <scope>       artifacts, check, or typecheck (default: complete)
#   --profile <name>      client build profile; not with check or typecheck
#   -h, --help            print this help
#
# Environment: PNPM overrides the pnpm executable.

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
pnpm_cmd="${PNPM:-pnpm}"

fail() {
  printf 'build: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: buildscripts/build.sh [options]
  --skip-install        reuse the existing node_modules
  --frozen              install with --frozen-lockfile (CI)
  --scope <scope>       artifacts, check, or typecheck (default: complete)
  --profile <name>      client build profile; not with check or typecheck
  -h, --help            print this help

Environment: PNPM overrides the pnpm executable.
EOF
}

skip_install=0
frozen=0
scope=''
profile=''

while (( $# > 0 )); do
  case "$1" in
    --skip-install)
      skip_install=1
      shift
      ;;
    --frozen)
      frozen=1
      shift
      ;;
    --scope)
      (( $# >= 2 )) || fail '--scope requires a value: artifacts, check, or typecheck'
      scope="$2"
      shift 2
      ;;
    --profile)
      (( $# >= 2 )) || fail '--profile requires a client build profile name'
      profile="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1 (try --help)"
      ;;
  esac
done

case "$scope" in
  ''|artifacts|check|typecheck) ;;
  *) fail "--scope must be artifacts, check, or typecheck, got '$scope'" ;;
esac

if [ -n "$profile" ] && { [ "$scope" = 'check' ] || [ "$scope" = 'typecheck' ]; }; then
  fail "--profile selects artifact values and does not apply to --scope $scope"
fi

[ -f "$repo_root/scripts/build.ts" ] || fail "scripts/build.ts not found under $repo_root"

command -v node > /dev/null || fail 'node not found; install Node.js >= 24.9'

node_version="$(node -p 'process.versions.node')"
node_major="${node_version%%.*}"
node_minor="${node_version#*.}"
node_minor="${node_minor%%.*}"
if (( node_major < 24 || (node_major == 24 && node_minor < 9) )); then
  fail "Node.js >= 24.9 required by package.json engines, found $node_version"
fi

if ! command -v "$pnpm_cmd" > /dev/null; then
  corepack enable > /dev/null 2>&1 || true
fi
command -v "$pnpm_cmd" > /dev/null || fail "pnpm not found; run 'corepack enable' (package.json pins pnpm)"

cd "$repo_root"
start=$SECONDS

if (( skip_install )); then
  printf '==> install: skipped (--skip-install)\n' >&2
else
  install_args=(install)
  if (( frozen )); then
    install_args+=(--frozen-lockfile)
  fi
  printf '==> install: %s %s\n' "$pnpm_cmd" "${install_args[*]}" >&2
  "$pnpm_cmd" "${install_args[@]}"
fi

# Select the published package.json script per scope instead of passing build
# flags after `--`, which `pnpm run` does not forward unchanged. The client
# profile reaches `scripts/build.ts` through its own selector.
case "$scope" in
  '') build_target='build' ;;
  artifacts) build_target='build:artifacts' ;;
  check) build_target='build:check' ;;
  typecheck) build_target='typecheck' ;;
esac

if [ -n "$profile" ]; then
  DSH_BUILD_CLIENT_PROFILE="$profile"
  export DSH_BUILD_CLIENT_PROFILE
fi

printf '==> build: %s run %s%s\n' "$pnpm_cmd" "$build_target" "${profile:+ (client profile: $profile)}" >&2
"$pnpm_cmd" run "$build_target"

printf '==> done in %ss\n' "$(( SECONDS - start ))" >&2
