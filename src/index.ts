import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { tryLock, unlock, waitForLock } from 'fs-native-extensions'

export const exitCodes = {
  error: 1,
  rebaseConflict: 10,
  verificationFailed: 11,
  worktreeChanged: 12,
  devChanged: 13,
} as const

type ExitCode = (typeof exitCodes)[keyof typeof exitCodes]

export class AgentMergeError extends Error {
  readonly exitCode: ExitCode

  constructor(message: string, exitCode: ExitCode = exitCodes.error) {
    super(message)
    this.name = 'AgentMergeError'
    this.exitCode = exitCode
  }
}

export interface SubmitOptions {
  cwd?: string
  log?: (message: string) => void
}

interface CommandResult {
  status: number
  stdout: string
  stderr: string
}

interface Repository {
  root: string
  commonDirectory: string
  branch: string
}

export async function submit(options: SubmitOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd()
  const log = options.log ?? console.log
  const repository = await inspectRepository(cwd)

  await assertNoOperation(repository.root)
  await assertClean(repository.root)
  await assertDevIsAvailable(repository.root)

  const initialHead = await gitText(repository.root, ['rev-parse', '--verify', 'HEAD'])
  const lockPath = join(repository.commonDirectory, 'agent-merge.lock')
  const lockFile = await open(lockPath, 'a+')
  let isLocked = false

  try {
    if (!tryLock(lockFile.fd)) {
      log('Waiting for the agent-merge lock…')
      await waitForLock(lockFile.fd)
    }
    isLocked = true

    await assertWorktreeUnchanged(repository, initialHead)
    await assertDevIsAvailable(repository.root)

    const oldDev = await gitText(repository.root, ['rev-parse', '--verify', 'refs/heads/dev'])

    if (!(await isAncestor(repository.root, oldDev, initialHead))) {
      log('Rebasing onto the latest dev…')
      const rebase = await runCommand('git', ['rebase', oldDev], {
        cwd: repository.root,
        inheritOutput: true,
      })

      if (rebase.status !== 0) {
        if (await isRebaseInProgress(repository.root)) {
          throw new AgentMergeError(
            'Rebase conflicts remain in the worktree. Resolve them, continue the rebase, and run `agent-merge submit` again.',
            exitCodes.rebaseConflict,
          )
        }

        throw new AgentMergeError('Git could not rebase the submitted commits.')
      }
    }

    const rebasedHead = await gitText(repository.root, ['rev-parse', '--verify', 'HEAD'])
    await verify(repository.root, oldDev, rebasedHead, log)
    await assertDevIsAvailable(repository.root)

    const update = await runCommand(
      'git',
      ['update-ref', '-m', 'agent-merge submit', 'refs/heads/dev', rebasedHead, oldDev],
      { cwd: repository.root },
    )

    if (update.status !== 0) {
      throw new AgentMergeError(
        'The dev branch changed outside agent-merge. Nothing was overwritten; run `agent-merge submit` again.',
        exitCodes.devChanged,
      )
    }

    log(`Integrated ${repository.branch} into dev at ${rebasedHead.slice(0, 12)}.`)
  } finally {
    try {
      if (isLocked) unlock(lockFile.fd)
    } finally {
      await lockFile.close()
    }
  }
}

async function inspectRepository(cwd: string): Promise<Repository> {
  const rootResult = await runCommand('git', ['rev-parse', '--show-toplevel'], { cwd })
  if (rootResult.status !== 0) {
    throw new AgentMergeError('Run `agent-merge submit` from inside a Git worktree.')
  }

  const root = rootResult.stdout.trim()
  const commonDirectory = await gitText(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  const branchResult = await runCommand('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: root,
  })

  if (branchResult.status !== 0) {
    throw new AgentMergeError('Submit from an agent branch, not a detached HEAD.')
  }

  const branch = branchResult.stdout.trim()
  if (branch === 'dev' || branch === 'main') {
    throw new AgentMergeError(`Submit from an agent branch, not ${branch}.`)
  }

  return { root, commonDirectory, branch }
}

async function assertClean(root: string): Promise<void> {
  const status = await gitText(root, ['status', '--porcelain=v1', '--untracked-files=normal'])
  if (status) {
    throw new AgentMergeError(
      'The worktree has uncommitted changes. Commit or clean them before submitting.',
    )
  }
}

async function assertNoOperation(root: string): Promise<void> {
  if (await isOperationInProgress(root)) {
    throw new AgentMergeError(
      'A Git operation is already in progress. Finish or abort it before submitting.',
    )
  }
}

async function assertWorktreeUnchanged(repository: Repository, initialHead: string): Promise<void> {
  const currentHead = await gitText(repository.root, ['rev-parse', '--verify', 'HEAD'])
  const branchResult = await runCommand('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: repository.root,
  })
  const currentBranch = branchResult.status === 0 ? branchResult.stdout.trim() : null
  const status = await gitText(repository.root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
  ])

  if (
    currentHead !== initialHead ||
    currentBranch !== repository.branch ||
    status ||
    (await isOperationInProgress(repository.root))
  ) {
    throw new AgentMergeError(
      'Your worktree changed while waiting for the integration lock. Nothing was rebased or merged. Commit or clean the new changes and submit again.',
      exitCodes.worktreeChanged,
    )
  }
}

async function assertDevIsAvailable(root: string): Promise<void> {
  const dev = await runCommand('git', ['show-ref', '--verify', '--quiet', 'refs/heads/dev'], {
    cwd: root,
  })
  if (dev.status !== 0) {
    throw new AgentMergeError('The repository has no local dev branch.')
  }

  const worktrees = await gitText(root, ['worktree', 'list', '--porcelain'])
  const entries = worktrees.split(/\n\n+/)
  for (const entry of entries) {
    const lines = entry.split('\n')
    if (!lines.includes('branch refs/heads/dev')) continue

    const location = lines.find((line) => line.startsWith('worktree '))?.slice(9)
    throw new AgentMergeError(
      `The dev branch is checked out${location ? ` at ${location}` : ''}. Remove that worktree before submitting so dev can be updated safely.`,
    )
  }
}

async function verify(
  root: string,
  oldDev: string,
  rebasedHead: string,
  log: (message: string) => void,
): Promise<void> {
  log('Verifying the rebased commits…')

  const whitespace = await runCommand('git', ['diff', '--check', `${oldDev}..${rebasedHead}`], {
    cwd: root,
    inheritOutput: true,
  })
  if (whitespace.status !== 0) {
    throw new AgentMergeError(
      'Verification failed: `git diff --check` found errors.',
      exitCodes.verificationFailed,
    )
  }

  const configured = await runCommand('git', ['config', '--get-all', 'agent-merge.verify'], {
    cwd: root,
  })
  if (configured.status !== 0 && configured.status !== 1) {
    throw new AgentMergeError('Could not read agent-merge verification configuration.')
  }

  const commands = configured.stdout.split('\n').filter(Boolean)
  for (const command of commands) {
    log(`Running verification: ${command}`)
    const result = await runCommand(command, [], {
      cwd: root,
      inheritOutput: true,
      shell: true,
    })
    if (result.status !== 0) {
      throw new AgentMergeError(`Verification failed: ${command}`, exitCodes.verificationFailed)
    }
  }

  const currentHead = await gitText(root, ['rev-parse', '--verify', 'HEAD'])
  const status = await gitText(root, ['status', '--porcelain=v1', '--untracked-files=normal'])
  if (currentHead !== rebasedHead || status || (await isOperationInProgress(root))) {
    throw new AgentMergeError(
      'Verification changed the worktree or HEAD. Commit or clean those changes and submit again.',
      exitCodes.verificationFailed,
    )
  }
}

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runCommand('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: root,
  })
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new AgentMergeError('Git could not compare the submitted branch with dev.')
}

async function isOperationInProgress(root: string): Promise<boolean> {
  const paths = await Promise.all(
    ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map(
      async (name) => gitText(root, ['rev-parse', '--path-format=absolute', '--git-path', name]),
    ),
  )
  return paths.some(existsSync)
}

async function isRebaseInProgress(root: string): Promise<boolean> {
  const paths = await Promise.all(
    ['rebase-merge', 'rebase-apply'].map(async (name) =>
      gitText(root, ['rev-parse', '--path-format=absolute', '--git-path', name]),
    ),
  )
  return paths.some(existsSync)
}

async function gitText(root: string, args: string[]): Promise<string> {
  const result = await runCommand('git', args, { cwd: root })
  if (result.status !== 0) {
    const detail = result.stderr.trim()
    throw new AgentMergeError(detail || `Git command failed: git ${args.join(' ')}`)
  }
  return result.stdout.trim()
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; inheritOutput?: boolean; shell?: boolean },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: options.shell ?? false,
      stdio: options.inheritOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (status) => {
      resolve({ status: status ?? exitCodes.error, stdout, stderr })
    })
  })
}
