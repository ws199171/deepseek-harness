/**
 * Pure host-side CLI probe routines: where() looks up an executable on PATH
 * (and the per-platform common install directories), version() captures a
 * vendor-specific version line, and probe() runs a minimal stream-json
 * invocation to verify the harness's protocol contract.
 *
 * Everything in this module is library-level: no Cordis, no settings, no
 * RPC — only `execFile`-equivalent helpers and the subprocess seam (so the
 * service side gets process-tree termination and environment scrubbing
 * for free when it calls runProbe()).
 *
 * @module @deepseek-ai/dsh-llm-cli/discovery
 */

import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'
import { existsSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { Readable } from 'node:stream'
import type { CliCandidate, CliDiscovered, CliHealth, CliModel } from './spec.ts'

/** The minimal probe-side shape the discovery layer needs from a SubprocessHandle. */
type ProbeHandle = Pick<SubprocessHandle, 'stdout' | 'done'>

/** Per-platform well- known install directories, walked after PATH. */
const FALLBACK_DIRS: readonly string[] = (() => {
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    return [join(programFiles, 'nodejs'), 'C:\\Program Files\\nodejs', join(programFilesX86, 'nodejs')]
  }
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']
  }
  return ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/homebrew/bin']
})()

/** The CLI programs whose stream-json protocol this adapter supports. */
export const CLI_CANDIDATES: readonly CliCandidate[] = Object.freeze([
  {
    id: 'codebuddy',
    displayName: 'CodeBuddy CLI',
    commands: ['codebuddy'],
    versionArgs: ['--version'],
    modelDiscoveryArgs: ['--help'],
    probeArgs: ['--print', '--output-format', 'stream-json'],
    probeTimeoutMs: 30_000,
  },
])

/** Whether a candidate file is executable on this platform. */
function isExecutable(candidate: string): boolean {
  if (!existsSync(candidate)) return false
  if (process.platform === 'win32') return true
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Locate the first candidate name that resolves to an executable.
 * @param command - executable basename to resolve.
 * @returns the executable path, or undefined when no PATH or fallback entry resolves it.
 */
export function where(command: string): string | undefined {
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(entry => entry !== '')
  for (const entry of pathEntries) {
    const candidate = join(entry, command)
    if (isExecutable(candidate)) return candidate
  }
  for (const dir of FALLBACK_DIRS) {
    const candidate = join(dir, command)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/** Run `args` with a hard timeout and return stdout when the child succeeds. */
function captureOutput(command: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined)
          return
        }
        resolve(stdout)
      },
    )
  })
}

/** Run `args` with a hard timeout and return the trimmed first line of stdout. */
async function captureFirstLine(command: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
  const output = await captureOutput(command, args, timeoutMs)
  return output?.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)
}

/**
 * Parse CodeBuddy's documented `--model` help listing into selector entries.
 * @param help - full stdout from `codebuddy --help`.
 * @returns the unique model ids listed by the CLI, in its reported order.
 */
export function parseCodeBuddyModels(help: string): CliModel[] {
  const listing = /--model <model>[\s\S]*?Currently supported:\s*\(([^)]*)\)/.exec(help)?.[1]
  if (listing === undefined) return []
  const ids = new Set<string>()
  for (const value of listing.split(',')) {
    const id = value.trim()
    if (id.length > 0) ids.add(id)
  }
  return [...ids].map(id => ({ id }))
}

/**
 * Probe a single candidate and return its discovery record.
 * @param candidate - supported CLI program to look up.
 * @returns the installed-path, version, and unknown-health record for the candidate.
 */
export async function probe(candidate: CliCandidate): Promise<CliDiscovered> {
  let resolved: string | undefined
  for (const command of candidate.commands) {
    const hit = where(command)
    if (hit !== undefined) {
      resolved = hit
      break
    }
  }
  if (resolved === undefined) {
    return {
      id: candidate.id,
      displayName: candidate.displayName,
      presence: 'absent',
      commands: [...candidate.commands],
      models: [],
      health: 'unknown',
      detail: `no candidate executable on PATH (looked for: ${candidate.commands.join(', ')})`,
    }
  }
  const [version, modelHelp] = await Promise.all([
    candidate.versionArgs.length > 0 ? captureFirstLine(resolved, candidate.versionArgs, 5_000) : undefined,
    candidate.modelDiscoveryArgs.length > 0 ? captureOutput(resolved, candidate.modelDiscoveryArgs, 5_000) : undefined,
  ])
  const models = candidate.id === 'codebuddy' && modelHelp !== undefined ? parseCodeBuddyModels(modelHelp) : []
  return {
    id: candidate.id,
    displayName: candidate.displayName,
    presence: 'present',
    commands: [...candidate.commands],
    path: resolved,
    ...(version === undefined ? {} : { version }),
    models,
    ...(models.length > 0 ? {} : { modelDetail: `${candidate.displayName} did not report any supported models` }),
    health: 'unknown',
  }
}

/**
 * Probe every supported CLI program in parallel.
 * @returns one discovery record per supported CLI program.
 */
export async function discoverAll(): Promise<CliDiscovered[]> {
  return Promise.all(CLI_CANDIDATES.map(probe))
}

/**
 * Look up a supported CLI program by id.
 * @param id - stable candidate identifier.
 * @returns the candidate, or undefined when the id is unsupported.
 */
export function candidateOf(id: string): CliCandidate | undefined {
  return CLI_CANDIDATES.find(candidate => candidate.id === id)
}

/**
 * Compose a minimal stream-json probe request.
 * @param candidate - supported CLI program to probe.
 * @param resolvedPath - resolved executable path.
 * @param extraArgs - caller-supplied arguments appended before the prompt.
 * @param prompt - short positional prompt for the CLI child.
 * @param timeoutMs - process-tree termination grace period.
 * @returns subprocess spawn facts for the probe child.
 */
export function probeSpec(
  candidate: CliCandidate,
  resolvedPath: string,
  extraArgs: readonly string[],
  prompt: string,
  timeoutMs: number,
): SubprocessSpawnSpec {
  return {
    argv: [resolvedPath, ...candidate.probeArgs, ...extraArgs, prompt],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
    graceMs: timeoutMs,
    env: {},
  }
}

/**
 * Run a probe against one supported CLI program and return its health verdict.
 * @param candidate - supported CLI program to probe.
 * @param resolvedPath - resolved executable path.
 * @param spawn - subprocess operation used to run the probe.
 * @param extraArgs - caller-supplied arguments appended before the prompt.
 * @param timeoutMs - maximum probe duration and termination grace period.
 * @returns the protocol health verdict, failure detail, and final output preview.
 */
export async function runProbe(
  candidate: CliCandidate,
  resolvedPath: string,
  spawn: (spec: SubprocessSpawnSpec) => ProbeHandle,
  extraArgs: readonly string[],
  timeoutMs: number,
): Promise<{ health: CliHealth; detail?: string; preview?: string }> {
  const prompt = 'reply with the word "ok" and nothing else'
  const spec = probeSpec(candidate, resolvedPath, extraArgs, prompt, timeoutMs)
  const handle = spawn(spec)
  const stdout: Readable | undefined = handle.stdout
  if (stdout === undefined) {
    return { health: 'broken', detail: 'the CLI child has no stdout pipe' }
  }
  const chunks: Buffer[] = []
  const onChunk = (chunk: Buffer): void => { chunks.push(chunk) }
  stdout.on('data', onChunk)
  const timer = setTimeout(() => { stdout.destroy() }, timeoutMs)
  timer.unref()
  let exit: Awaited<typeof handle.done>
  try {
    exit = await handle.done
  } catch (error) {
    clearTimeout(timer)
    stdout.off('data', onChunk)
    return { health: 'broken', detail: error instanceof Error ? error.message : String(error) }
  }
  clearTimeout(timer)
  stdout.off('data', onChunk)
  const output = Buffer.concat(chunks).toString('utf8').trim()
  // The verdict reads the full output; the preview only shows a snippet. A
  // single system init frame can span the first few lines, so truncating
  // before judging would miss the assistant/result frames entirely.
  const sawResultEvent = output.includes('"type":"result"') || output.includes('"type": "result"')
  const sawAssistantEvent = output.includes('"type":"assistant"') || output.includes('"type": "assistant"')
  const preview = output.split(/\r?\n/).slice(-4).join('\n')
  if (exit.exitCode === 0 && sawAssistantEvent && sawResultEvent) {
    return { health: 'healthy', ...(preview.length > 0 ? { preview } : {}) }
  }
  if (exit.exitCode === 0 && sawResultEvent) {
    return { health: 'broken', detail: 'the CLI exited successfully without an assistant event', ...(preview.length > 0 ? { preview } : {}) }
  }
  return { health: 'broken', detail: `the CLI exited with code ${String(exit.exitCode)} within ${String(timeoutMs)}ms`, ...(preview.length > 0 ? { preview } : {}) }
}
