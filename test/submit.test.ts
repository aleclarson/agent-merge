import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentMergeError, exitCodes, submit } from '../src/index.js'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('rebases an agent branch and fast-forwards dev without moving main', async () => {
  const fixture = createFixture()
  commitFile(fixture.root, 'dev.txt', 'from dev\n', 'dev change', 'dev')
  const agent = createAgentWorktree(fixture, 'agent-one')
  commitFile(agent, 'agent.txt', 'from agent\n', 'agent change')

  const originalMain = git(fixture.root, 'rev-parse', 'main')
  const originalDev = git(fixture.root, 'rev-parse', 'dev')
  const originalAgent = git(agent, 'rev-parse', 'HEAD')
  const messages: string[] = []

  await submit({ cwd: agent, log: (message) => messages.push(message) })

  const dev = git(fixture.root, 'rev-parse', 'dev')
  expect(git(fixture.root, 'rev-parse', 'main')).toBe(originalMain)
  expect(git(agent, 'rev-parse', 'HEAD')).not.toBe(originalAgent)
  expect(git(fixture.root, 'merge-base', '--is-ancestor', originalDev, dev)).toBe('')
  expect(readFileSync(join(agent, 'dev.txt'), 'utf8')).toBe('from dev\n')
  expect(messages.at(-1)).toMatch(/^Integrated agent-one into dev at /)
})

test('rejects uncommitted work before acquiring the lock', async () => {
  const fixture = createFixture()
  const agent = createAgentWorktree(fixture, 'dirty-agent')
  writeFileSync(join(agent, 'uncommitted.txt'), 'not committed\n')
  const originalDev = git(fixture.root, 'rev-parse', 'dev')

  await expect(submit({ cwd: agent, log: () => {} })).rejects.toMatchObject({
    exitCode: exitCodes.error,
    message: expect.stringContaining('uncommitted changes'),
  })
  expect(git(fixture.root, 'rev-parse', 'dev')).toBe(originalDev)
})

test('leaves a conflicted rebase for the agent and returns status 10', async () => {
  const fixture = createFixture()
  commitFile(fixture.root, 'shared.txt', 'dev version\n', 'dev conflict', 'dev')
  const agent = createAgentWorktree(fixture, 'conflicted-agent')
  commitFile(agent, 'shared.txt', 'agent version\n', 'agent conflict')
  const originalDev = git(fixture.root, 'rev-parse', 'dev')

  await expect(submit({ cwd: agent, log: () => {} })).rejects.toMatchObject({
    exitCode: exitCodes.rebaseConflict,
  })

  expect(git(fixture.root, 'rev-parse', 'dev')).toBe(originalDev)
  expect(gitPathExists(agent, 'rebase-merge') || gitPathExists(agent, 'rebase-apply')).toBe(true)
})

test('does not advance dev when a configured verification command fails', async () => {
  const fixture = createFixture()
  const agent = createAgentWorktree(fixture, 'failing-agent')
  commitFile(agent, 'agent.txt', 'change\n', 'agent change')
  git(fixture.root, 'config', '--add', 'agent-merge.verify', 'false')
  const originalDev = git(fixture.root, 'rev-parse', 'dev')

  await expect(submit({ cwd: agent, log: () => {} })).rejects.toMatchObject({
    exitCode: exitCodes.verificationFailed,
  })
  expect(git(fixture.root, 'rev-parse', 'dev')).toBe(originalDev)
})

test('rechecks HEAD after waiting for another process to release the lock', async () => {
  const fixture = createFixture()
  const agent = createAgentWorktree(fixture, 'waiting-agent')
  commitFile(agent, 'agent.txt', 'first\n', 'agent change')
  const commonDirectory = git(
    fixture.root,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  )
  const holder = holdLock(join(commonDirectory, 'agent-merge.lock'))
  await holder.ready

  let announceWaiting!: () => void
  const waiting = new Promise<void>((resolve) => {
    announceWaiting = resolve
  })
  const submission = submit({
    cwd: agent,
    log(message) {
      if (message.includes('Waiting')) announceWaiting()
    },
  })

  await waiting
  writeFileSync(join(agent, 'agent.txt'), 'second\n')
  git(agent, 'add', 'agent.txt')
  git(agent, 'commit', '--amend', '--no-edit')

  await expect(submission).rejects.toMatchObject({ exitCode: exitCodes.worktreeChanged })
  await holder.done
})

interface Fixture {
  root: string
  worktrees: string
}

function createFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'agent-merge-test-'))
  fixtures.push(directory)
  const root = join(directory, 'repo')
  const worktrees = join(directory, 'worktrees')

  git(directory, 'init', '--initial-branch=main', root)
  git(root, 'config', 'user.name', 'Agent Merge Tests')
  git(root, 'config', 'user.email', 'agent-merge@example.test')
  writeFileSync(join(root, 'shared.txt'), 'base\n')
  git(root, 'add', 'shared.txt')
  git(root, 'commit', '-m', 'initial')
  git(root, 'branch', 'dev')

  return { root, worktrees }
}

function createAgentWorktree(fixture: Fixture, branch: string): string {
  const path = join(fixture.worktrees, branch)
  git(fixture.root, 'worktree', 'add', '-b', branch, path, 'main')
  return path
}

function commitFile(
  root: string,
  name: string,
  content: string,
  message: string,
  branch?: string,
): void {
  const originalBranch = git(root, 'branch', '--show-current')
  if (branch && branch !== originalBranch) git(root, 'switch', branch)
  writeFileSync(join(root, name), content)
  git(root, 'add', name)
  git(root, 'commit', '-m', message)
  if (branch && branch !== originalBranch) git(root, 'switch', originalBranch)
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitPathExists(root: string, name: string): boolean {
  const path = git(root, 'rev-parse', '--path-format=absolute', '--git-path', name)
  return existsSync(path)
}

function holdLock(lockPath: string): { ready: Promise<void>; done: Promise<void> } {
  const script = `
    const { openSync, closeSync } = require('node:fs')
    const { tryLock, unlock } = require('fs-native-extensions')
    const fd = openSync(process.argv[1], 'a+')
    if (!tryLock(fd)) process.exit(2)
    process.stdout.write('ready\\n')
    setTimeout(() => { unlock(fd); closeSync(fd) }, 500)
  `
  const child = spawn(process.execPath, ['-e', script, lockPath], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  child.stdout.setEncoding('utf8')

  const ready = new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (status) => {
      if (status === 0) resolve()
      else reject(new AgentMergeError(`Lock holder exited with status ${status ?? 1}`))
    })
  })
  return { ready, done }
}
