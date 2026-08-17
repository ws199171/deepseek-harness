/**
 * The CLI discovery Remote service exposed by the `llm-cli` plugin: enumerates
 * supported CLI programs installed on this host, and runs a minimal stream-json
 * probe against one on demand. The renderer
 * calls these through the `api.llm.cliDiscover` / `api.llm.cliTest` surfaces
 * Typert generates from the spec.
 *
 * Discovery runs in parallel and never invokes the candidate itself — only the
 * spawn seam + PATH lookup, so a hostile `codebuddy` binary cannot influence
 * the discovery outcome. Probe runs through the subprocess seam (process-tree
 * termination, environment scrubbing) with a hard timeout.
 *
 * @module @deepseek-ai/dsh-llm-cli/service
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  candidateOf,
  discoverAll,
  runProbe,
  where as resolveCommand,
} from './discovery.ts'
import type {
  CliDiscoverResultView,
  CliTestRequest,
  CliTestResult,
} from './spec.ts'

/** The discovery Remote: discovery + probe for the renderer to consume. */
export class CliDiscoveryService extends TypertRemoteService {
  static inject = ['subprocess'] as const

  constructor(ctx: Context) {
    super(ctx, 'llm-cli-discovery')
  }

  /**
   * Enumerate supported installed CLI programs. Probe health stays `unknown` here;
   * a probe is only run on demand via {@link test} so a discovery round never
   * launches a half agentic child.
   * @returns the full discovery snapshot.
   */
  @Remote('discover')
  async discover(): Promise<CliDiscoverResultView> {
    const entries = await discoverAll()
    return { entries }
  }

  /**
   * Run a minimal stream-json probe against one installed candidate. Verifies
   * the CLI emits both `assistant` and `result` events within the probe grace
   * window — the minimal harness contract.
   * @param request - candidate id, optional override path, optional extra args.
   * @returns the probe verdict, or a failure message when the candidate is absent.
   */
  @Remote('test')
  async test(request: CliTestRequest): Promise<CliTestResult> {
    const candidate = candidateOf(request.id)
    if (candidate === undefined) {
      return { ok: false, message: `unknown CLI id "${request.id}"` }
    }
    const explicit = request.command !== undefined
      ? (resolveCommand(request.command) ?? request.command)
      : undefined
    const resolved = explicit ?? candidate.commands
      .map(name => resolveCommand(name))
      .find(path => path !== undefined)
      ?? candidate.commands[0]
    if (resolved === undefined || resolved.length === 0) {
      return { ok: false, message: `no executable resolved for "${candidate.id}"` }
    }
    const verdict = await runProbe(
      candidate,
      resolved,
      spec => this.spawn(spec),
      request.extraArgs,
      candidate.probeTimeoutMs,
    )
    if (verdict.health === 'healthy') {
      return {
        ok: true,
        message: `${candidate.displayName} answered the stream-json probe in under ${String(candidate.probeTimeoutMs)}ms`,
        ...(verdict.preview !== undefined ? { preview: verdict.preview } : {}),
      }
    }
    return {
      ok: false,
      message: verdict.detail ?? `${candidate.displayName} did not emit a complete stream-json response`,
      ...(verdict.preview !== undefined ? { preview: verdict.preview } : {}),
    }
  }

  /** Spawn through the seam and return only the fields the probe reads. */
  private spawn(spec: SubprocessSpawnSpec): Pick<SubprocessHandle, 'stdout' | 'done'> {
    const handle = this.ctx.subprocess.spawn(spec)
    return {
      stdout: handle.stdout,
      done: handle.done,
    }
  }
}

export default CliDiscoveryService
