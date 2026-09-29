import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  Config,
  DEFAULT_ACP_ARGS,
  DEFAULT_ARGS,
  DEFAULT_COMMAND,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MODEL_DISCOVERY_ARGS,
  DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_SESSION_ID_ARG,
  mergeCatalog,
  plainOptions,
  resolveAdapterOptions,
} from '../src/config.ts'
import { DEFAULT_TRANSPORT } from '../src/adapter.ts'
import type { CodeBuddyEffort } from '../src/adapter.ts'
import type { Options } from '../src/config.ts'

/**
 * Judge one untyped section the way the loader hands it over: a settings write
 * carries raw values, so a value outside the declared set is a runtime question
 * at this boundary rather than a type error.
 */
function parseSection(raw: unknown): ReturnType<typeof Config> {
  return Config(raw as Options)
}

/**
 * Resolve one untyped section the way a programmatic composition hands it over:
 * a section built in code never passes the schema, so the resolver's own bounds
 * are what judge the value.
 * @param raw - the section as the composition would supply it.
 * @returns the executable facts the resolver produced.
 */
function resolveSection(raw: unknown): ReturnType<typeof resolveAdapterOptions> {
  return resolveAdapterOptions(raw as Options, '/f')
}

describe('resolveAdapterOptions defaults', () => {
  it('resolves a bare config to the CodeBuddy invocation and the fallback workspace', () => {
    // The registered route must work from an empty `- id: llm-cli` row: an
    // operator who configures nothing gets the documented CodeBuddy defaults.
    expect(resolveAdapterOptions({}, '/fallback')).toEqual({
      argv: [DEFAULT_COMMAND, ...DEFAULT_ARGS],
      cwd: '/fallback',
      // Nothing pinned a workspace, so a session's own wins per request.
      useSessionCwd: true,
      env: {},
      sessionIdArg: DEFAULT_SESSION_ID_ARG,
      transport: DEFAULT_TRANSPORT,
      permissionMode: DEFAULT_PERMISSION_MODE,
      disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
      acpArgv: [DEFAULT_COMMAND, ...DEFAULT_ACP_ARGS],
      discoveryArgv: [DEFAULT_COMMAND, ...DEFAULT_MODEL_DISCOVERY_ARGS],
      discoveryTimeoutMs: DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
      models: [],
    })
  })

  it('pins the configured workspace and detaches the caller environment', () => {
    const env = { NO_COLOR: '1' }
    const resolved = resolveAdapterOptions({ command: '/opt/codebuddy', args: ['--x'], cwd: '/ws', env }, '/fallback')

    expect(resolved.argv).toEqual(['/opt/codebuddy', '--x'])
    expect(resolved.cwd).toBe('/ws')
    // An explicit cwd is a deployment decision: a session's workspace must not
    // silently override it.
    expect(resolved.useSessionCwd).toBe(false)
    expect(resolved.env).toEqual({ NO_COLOR: '1' })
    expect(resolved.env).not.toBe(env)
    // Discovery follows the same executable but its own argument list.
    expect(resolved.discoveryArgv).toEqual(['/opt/codebuddy', ...DEFAULT_MODEL_DISCOVERY_ARGS])
  })

  it('treats an empty session-id argument as the documented stateless opt-out', () => {
    expect(resolveAdapterOptions({ sessionIdArg: '' }, '/fallback')).not.toHaveProperty('sessionIdArg')
    expect(resolveAdapterOptions({ sessionIdArg: '--resume' }, '/fallback').sessionIdArg).toBe('--resume')
  })

  it('passes the delegated loop bounds through, and leaves them unset when absent', () => {
    // Absent means the CLI's own default stays in charge, so the facts must not
    // carry an empty stand-in that would read as a bound of its own.
    const bare = resolveAdapterOptions({}, '/fallback')
    expect(bare).not.toHaveProperty('tools')
    expect(bare).not.toHaveProperty('maxTurns')
    expect(bare).not.toHaveProperty('effort')

    // An empty tool set is a choice — every built-in tool off — not an absence.
    expect(resolveAdapterOptions({ tools: '', maxTurns: 1, effort: 'low' }, '/fallback'))
      .toMatchObject({ tools: '', maxTurns: 1, effort: 'low' })
  })
})

describe('resolveAdapterOptions rejections', () => {
  it('refuses a blank or whitespace-only command', () => {
    expect(() => resolveAdapterOptions({ command: '   ' }, '/f')).toThrow(/command must be non-empty/)
    expect(() => resolveAdapterOptions({ command: '' }, '/f')).toThrow(/command must be non-empty/)
  })

  it('refuses an argument list entry that would silently shift the prompt', () => {
    // The prompt rides the final positional argument, so one empty entry
    // upstream of it would move the CLI's own reading of the prompt.
    expect(() => resolveAdapterOptions({ args: ['--print', ''] }, '/f')).toThrow(/args must not contain an empty argument/)
    expect(() => resolveAdapterOptions({ modelDiscoveryArgs: [''] }, '/f'))
      .toThrow(/modelDiscoveryArgs must not contain an empty argument/)
  })

  it('refuses a permission mode its own binary would reject', () => {
    // Programmatic composition bypasses the schema, so the bound is re-judged.
    expect(() => resolveSection({ permissionMode: 'accept-everything' })).toThrow(/unsupported permissionMode "accept-everything"/)
  })

  it.each([
    ['disposeGraceMs', 0],
    ['disposeGraceMs', -1],
    ['disposeGraceMs', Number.POSITIVE_INFINITY],
    ['disposeGraceMs', MAX_TIMER_DELAY_MS + 1],
    ['modelDiscoveryTimeoutMs', 0],
    ['modelDiscoveryTimeoutMs', -0.5],
    ['modelDiscoveryTimeoutMs', MAX_TIMER_DELAY_MS + 1],
  ] as const)('refuses %s=%s beyond the timer bound', (field, value) => {
    expect(() => resolveAdapterOptions({ [field]: value }, '/f'))
      .toThrow(new RegExp(`${field} must be a positive finite number no greater than ${String(MAX_TIMER_DELAY_MS)}`))
  })

  it('accepts a bound exactly at the timer ceiling', () => {
    expect(resolveAdapterOptions({ disposeGraceMs: MAX_TIMER_DELAY_MS }, '/f').disposeGraceMs).toBe(MAX_TIMER_DELAY_MS)
  })

  it.each([
    [0],
    [-1],
    [1.5],
  ])('refuses maxTurns=%s, which is not a whole turn count', (value) => {
    expect(() => resolveAdapterOptions({ maxTurns: value }, '/f')).toThrow(/maxTurns must be a positive whole number/)
  })

  it('refuses a reasoning effort its own binary would reject', () => {
    // Programmatic composition bypasses the schema, so the bound is re-judged.
    const bogus = 'turbo' as string as CodeBuddyEffort
    expect(() => resolveAdapterOptions({ effort: bogus }, '/f')).toThrow(/unsupported effort "turbo"/)
  })
})

describe('resolveAdapterOptions catalog', () => {
  it('keeps names where declared and reports id-only entries otherwise', () => {
    expect(resolveAdapterOptions({ models: [{ id: 'a', name: 'A' }, { id: 'b' }] }, '/f').models)
      .toEqual([{ id: 'a', name: 'A' }, { id: 'b' }])
  })

  it('refuses a catalog that names nothing', () => {
    expect(() => resolveAdapterOptions({ models: [{ id: '' }] }, '/f')).toThrow(/catalog model ids must be non-empty/)
  })

  it('refuses an empty declared name, which reads as a missing one', () => {
    expect(() => resolveAdapterOptions({ models: [{ id: 'a', name: '' }] }, '/f'))
      .toThrow(/catalog model "a" has an empty name/)
  })

  it('refuses a duplicate id, which would collide in the picker', () => {
    expect(() => resolveAdapterOptions({ models: [{ id: 'a' }, { id: 'a', name: 'A' }] }, '/f'))
      .toThrow(/duplicate catalog model "a"/)
  })

  it('detaches each accepted entry from the caller object', () => {
    const model = { id: 'a', name: 'A' }
    const [resolved] = resolveAdapterOptions({ models: [model] }, '/f').models
    expect(resolved).toEqual(model)
    expect(resolved).not.toBe(model)
  })
})

describe('mergeCatalog', () => {
  it('leads with the ids the CLI advertised, keeping a declared label for one of them', () => {
    expect(mergeCatalog(
      [{ id: 'house', name: 'House' }, { id: 'named', name: 'Named' }],
      [{ id: 'house' }, { id: 'gpt-5.6-sol' }],
    )).toEqual([{ id: 'house', name: 'House' }, { id: 'gpt-5.6-sol' }, { id: 'named', name: 'Named' }])
  })

  it('reports every id once, even when both sources name it', () => {
    const merged = mergeCatalog([{ id: 'a' }], [{ id: 'a' }, { id: 'a' }])

    expect(merged).toEqual([{ id: 'a' }])
  })
})

describe('Config schema', () => {
  it('materializes every volatile default from an empty section', () => {
    // A `- id: llm-cli` row with no config still registers a serving route.
    expect(plainOptions(Config({}))).toEqual({
      command: DEFAULT_COMMAND,
      args: [...DEFAULT_ARGS],
      acpArgs: [...DEFAULT_ACP_ARGS],
      modelDiscoveryArgs: [...DEFAULT_MODEL_DISCOVERY_ARGS],
      modelDiscoveryTimeoutMs: DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
      models: [],
      cwd: undefined,
      env: {},
      sessionIdArg: DEFAULT_SESSION_ID_ARG,
      transport: DEFAULT_TRANSPORT,
      permissionMode: DEFAULT_PERMISSION_MODE,
      tools: undefined,
      maxTurns: undefined,
      effort: undefined,
      disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    })
  })

  it('reads each reference separately, so one section cannot leak into another', () => {
    // The Models page rewrites the section and the loader hands the resolver a
    // fresh Config; two sections must therefore stay independent.
    expect(plainOptions(Config({ command: 'first' })).command).toBe('first')
    expect(plainOptions(Config({ command: 'second' })).command).toBe('second')
    expect(plainOptions(Config({ args: ['--print'] })).args).toEqual(['--print'])
  })

  it('refuses a permission mode the shipped set does not offer', () => {
    expect(() => parseSection({ permissionMode: 'accept-everything' })).toThrow()
  })

  it('accepts a duplicate id at the schema boundary, where only the resolver refuses it', () => {
    // Schemastery judges shape; the id-level rules live in the one resolve
    // step, which both this schema's output and a settings snapshot pass
    // through — so the refusal cannot be bypassed by writing a raw section.
    expect(plainOptions(Config({ models: [{ id: 'a' }, { id: 'a' }] })).models).toEqual([{ id: 'a' }, { id: 'a' }])
    expect(() => resolveAdapterOptions({ models: [{ id: 'a' }, { id: 'a' }] }, '/f'))
      .toThrow(/duplicate catalog model "a"/)
  })

  it('refuses a catalog entry with no id', () => {
    expect(() => parseSection({ models: [{ name: 'A' }] })).toThrow()
  })
})
