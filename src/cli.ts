#!/usr/bin/env node

import { binary, command, run, subcommands } from '@alloc/cmd-ts'
import { readFileSync } from 'node:fs'
import { AgentMergeError, submit } from './index.js'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

export const submitCommand = command({
  name: 'submit',
  description: 'Rebase the current agent branch onto dev and advance dev safely',
  args: {},
  examples: [{ description: 'Submit committed agent work', command: 'agent-merge submit' }],
  handler: submit,
})

export const cli = subcommands({
  name: 'agent-merge',
  version: packageJson.version,
  description: 'Serialize Git worktree submissions onto a shared local dev branch',
  cmds: { submit: submitCommand },
})

export async function main(): Promise<void> {
  try {
    await run(binary(cli), process.argv)
  } catch (error) {
    if (error instanceof AgentMergeError) {
      console.error(`agent-merge: ${error.message}`)
      process.exitCode = error.exitCode
      return
    }

    throw error
  }
}

await main()
