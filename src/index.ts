import cluster from 'cluster'
import {spawn} from 'child_process'
import {config} from 'dotenv'
import {readFileSync} from 'fs'
import {random} from 'lodash-es'
import ms from 'ms'
import {join} from 'path'
import {fileURLToPath} from 'url'
import {bootstrap} from './bootstrap.js'
import {logger} from './logger.js'

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  version: string
}

config()
if (process.argv[2] === 'rsync') {
  runRsyncSync()
    .then(() => {
      // eslint-disable-next-line n/no-process-exit
      process.exit(0)
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err)
      // eslint-disable-next-line n/no-process-exit
      process.exit(1)
    })
} else {
if (process.env.NO_DAEMON || !cluster.isPrimary) {
  bootstrap(packageJson.version).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err)
    // eslint-disable-next-line n/no-process-exit
    process.exit(1)
  })
}

if (!process.env.NO_DAEMON && cluster.isPrimary) {
  forkWorker()
}
}

const BACKOFF_FACTOR = 2
let backoff = 1
const randomize = 0.2

function parseEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (!raw) return defaultValue
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) return defaultValue
  return value
}

function splitRoundRobin<T>(items: T[], groups: number): T[][] {
  const buckets: T[][] = Array.from({length: groups}, () => [])
  for (let i = 0; i < items.length; i++) {
    buckets[i % groups].push(items[i])
  }
  return buckets.filter((e) => e.length > 0)
}

function execRsync(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('rsync', args, {cwd, stdio: 'inherit'})
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`rsync exited with code ${code ?? 'null'}`))
    })
  })
}

async function runRsyncSync(): Promise<void> {
  const source = process.argv[3]
  if (!source) {
    throw new Error('缺少 rsync 源地址参数，例如：node dist/index.js rsync openbmclapi@home.933.moe::openbmclapi')
  }

  const maxMbps = parseEnvInt('RSYNC_MAX_BANDWIDTH_MBPS', 200)
  const maxThreads = parseEnvInt('RSYNC_MAX_THREADS', 8)

  const threads = Math.max(1, Math.min(maxThreads, 64))
  const perThreadKbps = Math.max(1, Math.floor((maxMbps * 128) / threads))

  const prefixes = Array.from({length: 256}, (_, i) => i.toString(16).padStart(2, '0'))
  const groups = splitRoundRobin(prefixes, threads)

  const cacheDir = join(process.cwd(), 'cache')
  const tasks = groups.map(async (group) => {
    const sources = group.map((p) => `${source}/${p}`)
    const args = ['-aP', '--delete', `--bwlimit=${perThreadKbps}`, ...sources, cacheDir]
    await execRsync(args, process.cwd())
  })

  await Promise.all(tasks)
}

function forkWorker(): void {
  const worker = cluster.fork()
  worker.on('exit', (code, signal) => {
    backoff = Math.round(Math.min(backoff * BACKOFF_FACTOR, 60) * random(1 - randomize, 1 + randomize, true))
    logger.warn(`工作进程 ${worker.id} 异常退出，code: ${code}, signal: ${signal}，${backoff}秒后重启`)
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers
    setTimeout(() => forkWorker(), backoff * 1000)
  })
  worker.on('message', (msg: unknown) => {
    if (msg === 'ready') {
      backoff = 1
    }
  })

  function onStop(signal: string): void {
    worker.removeAllListeners('exit')
    worker.kill(signal)
    worker.on('exit', () => {
      // eslint-disable-next-line n/no-process-exit
      process.exit(0)
    })
    const ref = setTimeout(() => {
      // eslint-disable-next-line n/no-process-exit
      process.exit(0)
    }, ms('30s'))
    ref.unref()
  }

  process.on('SIGINT', onStop)
  process.on('SIGTERM', onStop)
}
