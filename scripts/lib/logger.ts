/**
 * Logger Utility
 *
 * Provides consistent colored console output across all scripts.
 * Matches the visual style of the original shell scripts.
 *
 * Includes file-logging support: call `startFileLogging()` to tee all
 * console output into a timestamped log file for post-mortem analysis.
 */

import { mkdirSync, createWriteStream } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { WriteStream } from 'fs'

/** Active file log stream, if logging is enabled */
let logStream: WriteStream | undefined

/** Strip ANSI escape codes so the log file is human-readable */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * Start tee-ing all `console.log` and `console.error` output to a
 * timestamped log file under `scripts/local/diagnostics/.troubleshoot-logs/`.
 *
 * @param scriptName - Short name used in the filename (e.g. 'sns-orphans')
 * @returns The absolute path of the created log file
 */
export function startFileLogging(scriptName: string): string {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const logsDir = join(__dirname, '..', 'local', 'diagnostics', '.troubleshoot-logs')
  mkdirSync(logsDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logFile = join(logsDir, `${scriptName}-${timestamp}.log`)

  logStream = createWriteStream(logFile, { flags: 'a' })
  logStream.write(`=== ${scriptName} — ${new Date().toISOString()} ===\n\n`)

  // Monkey-patch console.log and console.error
  const originalLog = console.log.bind(console)
  const originalError = console.error.bind(console)

  console.log = (...args: unknown[]) => {
    originalLog(...args)
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    logStream?.write(stripAnsi(line) + '\n')
  }

  console.error = (...args: unknown[]) => {
    originalError(...args)
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    logStream?.write('[ERROR] ' + stripAnsi(line) + '\n')
  }

  return logFile
}

/**
 * Flush and close the log file stream.
 * Call this at the end of the script to ensure all output is written.
 */
export function stopFileLogging(): void {
  if (logStream) {
    logStream.end()
    logStream = undefined
  }
}

// ANSI color codes
const colors = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[1;33m',
  cyan: '\x1b[0;36m',
  blue: '\x1b[0;34m',
  reset: '\x1b[0m',
} as const

export function red(text: string): string {
  return `${colors.red}${text}${colors.reset}`
}
export function green(text: string): string {
  return `${colors.green}${text}${colors.reset}`
}
export function yellow(text: string): string {
  return `${colors.yellow}${text}${colors.reset}`
}
export function cyan(text: string): string {
  return `${colors.cyan}${text}${colors.reset}`
}
export function blue(text: string): string {
  return `${colors.blue}${text}${colors.reset}`
}

/** Print a horizontal divider line */
export function divider(): void {
  console.log(green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
}

/** Print a script header with title */
export function header(title: string): void {
  divider()
  console.log(green(title))
  divider()
}

/** Print a step progress indicator: [1/5] Doing something... */
export function step(current: number, total: number, message: string): void {
  console.log(yellow(`[${current}/${total}] ${message}`))
}

/** Print a success message: ✓ Something worked */
export function success(message: string): void {
  console.log(green(`✓ ${message}`))
}

/** Print a failure message: ✗ Something failed */
export function fail(message: string): void {
  console.log(red(`✗ ${message}`))
}

/** Print a warning message: ⚠️ Something is off */
export function warn(message: string): void {
  console.log(yellow(`⚠️ ${message}`))
}

/** Print an info message */
export function info(message: string): void {
  console.log(cyan(message))
}

/** Print a configuration block */
export function config(label: string, entries: Record<string, string>): void {
  console.log(yellow(`📋 ${label}:`))
  for (const [key, value] of Object.entries(entries)) {
    console.log(`   ${key}: ${value}`)
  }
  console.log('')
}

/** Print a summary block */
export function summary(title: string, entries: Record<string, string>): void {
  console.log('')
  divider()
  console.log(green(`✅ ${title}`))
  divider()
  console.log('')
  console.log(cyan('Summary:'))
  for (const [key, value] of Object.entries(entries)) {
    console.log(`  ${key}: ${value}`)
  }
  console.log('')
}

/** Print next steps */
export function nextSteps(steps: string[]): void {
  console.log(yellow('Next steps:'))
  steps.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s}`)
  })
  console.log('')
}

/** Fatal error — print message and exit */
export function fatal(message: string): never {
  console.error(red(`❌ ${message}`))
  process.exit(1)
}
