// A stand-in for the delegated CLI, used by the plugin tests. It answers with
// its own working directory, so the workspace a run actually landed in is
// observable, and prints a CodeBuddy-shaped `--help` listing when asked for one.
//
// It is deliberately a file rather than an inline `-e` script: Node keeps
// parsing its own options after `-e <code>`, so a delegated CLI's own flags
// (`--permission-mode`, `--model`) would be rejected before they reached the
// child. A script path ends option parsing, which is how a real CLI is invoked.
const frame = value => process.stdout.write(`${JSON.stringify(value)}\n`)

if (process.argv.includes('--help')) {
  process.stdout.write('  --model <model>   Model to use. Currently supported: (gpt-5.6-sol, local:house)\n')
} else {
  frame({ type: 'assistant', message: { content: [{ type: 'text', text: process.cwd() }] } })
  frame({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 2 } })
}
