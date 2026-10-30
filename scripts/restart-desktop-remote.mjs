#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDesktopDevStartupConfig,
  DESKTOP_DEV_REGIONS,
  desktopUserDataDirNameForRegion,
  resolveDesktopDevRegion,
} from './shared/desktop-dev-region.mjs';
import {
  buildDesktopDevVerdictFromFailure,
  buildDesktopDevVerdictFromWhoami,
  desktopRestartArgvConflictMessage,
  normalizeDesktopRestartArgv,
  UI_MOCK_ARG,
  printDesktopDevVerdict,
  resolveIsolatedArg,
  restartContextFromArgv,
  SHARED_USERDATA_ARG,
} from './desktop-dev-verdict.mjs';
import { PROCESS_TABLE_MAX_BYTES, collectDesktopWhoamiReport } from './desktop-whoami.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const gracefulTimeoutMs = 3000;
const forceTimeoutMs = 5000;
const pollIntervalMs = 150;
const startupReadyTimeoutMs = 120_000;
export const ISOLATED_AUTH_LAUNCH_PROOF_FILE = '.isolated-auth-launch-proof.json';
const isolatedAuthLaunchProofTtlMs = 10 * 60_000;
const forceKillLabel = process.platform === 'win32' ? 'taskkill /F /T' : 'kill -9';
const desktopDevCacheRelativeDirs = Object.freeze([
  path.join('apps', 'desktop', 'node_modules', '.vite'),
  path.join('apps', 'desktop', '.vite'),
]);

/**
 * äº§å“é»˜è®¤ userData ç›®å½•åŸºåã€‚âš ï¸ å€¼å¿…é¡»ä¸Ž
 * packages/maker-shared/src/brandIdentity.ts çš„ BRAND_IDENTITY.userDataDirName
 * ä¸€è‡´â€”â€”.mjs æ— æ³• import TS å•ç‚¹,åªèƒ½é•œåƒå­—é¢é‡;
 * ä¸€è‡´æ€§ç”± scripts/__tests__/brand-identity-sync.test.mjs æ–­è¨€å…œåº•ã€‚
 */
export const BRAND_USER_DATA_DIR_NAME = 'Echo';

// æ¡Œé¢ç«¯ .env é»˜è®¤å€¼ã€‚2026-07 ç«¯ç‚¹æ¸…å•é‡æž„åŽ .env ä¸å†æ‰¿è½½ä»»ä½•ç«¯ç‚¹ URL
// (è¿è¡ŒæœŸç«¯ç‚¹å…¨éƒ¨æ¥è‡ªæ¸…å•:remote restart æŒ‰ region è¯» config/endpoint*.json,
// local æ¨¡å¼è¯»ç”Ÿæˆçš„ config/endpoint.local.json,--endpoints-cdn èµ°çº¿ä¸Š CDN),è¿™é‡Œåª
// ä¿ç•™ region èº«ä»½ã€‚é£žä¹¦ç™»å½•æž„å»ºå˜é‡å·²é€€å½¹,ä¸å†åˆ›å»ºæˆ–è¡¥å†™ã€‚
function desktopEnvSpec() {
  return [{ key: 'VITE_CINDY_AUTH_REGION', value: 'global', force: false }];
}
const closeDarwinTerminalTtyScript = Object.freeze([
  'on closeMatchingTerminalTab(targetTty)',
  'tell application "Terminal"',
  'repeat with terminalWindow in windows',
  'repeat with terminalTab in tabs of terminalWindow',
  'if (tty of terminalTab) is targetTty then',
  'try',
  'if busy of terminalTab is false then do script "exit" in terminalTab',
  'end try',
  'delay 1',
  'try',
  'if not (exists terminalWindow) then return',
  'if not (exists terminalTab) then return',
  'if (count of tabs of terminalWindow) is 1 then',
  'close terminalWindow',
  'else',
  'close terminalTab',
  'end if',
  'end try',
  'return',
  'end if',
  'end repeat',
  'end repeat',
  'end tell',
  'end closeMatchingTerminalTab',
  'on run argv',
  'my closeMatchingTerminalTab(item 1 of argv)',
  'end run',
]);
const launchDarwinTerminalScript = Object.freeze([
  'on run argv',
  'set devCommand to item 1 of argv',
  'tell application "Terminal"',
  'set targetTab to do script devCommand',
  'set targetWindow to front window',
  'activate',
  'end tell',
  'repeat',
  'delay 1',
  'tell application "Terminal"',
  'if not (exists targetWindow) then return',
  'if not (exists targetTab) then return',
  'if busy of targetTab is false then',
  'try',
  'if (count of tabs of targetWindow) is 1 then',
  'close targetWindow',
  'else',
  'close targetTab',
  'end if',
  'end try',
  'return',
  'end if',
  'end tell',
  'end repeat',
  'end run',
]);

function normalize(value) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

export function commandContainsPath(command, candidatePath) {
  const normalizedCommand = normalize(command);
  const normalizedPath = stripTrailingSlashes(normalize(candidatePath));
  if (!normalizedPath) return false;
  let index = normalizedCommand.indexOf(normalizedPath);
  while (index !== -1) {
    const before = normalizedCommand[index - 1];
    const after = normalizedCommand[index + normalizedPath.length];
    const hasStartBoundary = before === undefined || /\s|["'=]/.test(before);
    // å‘½ä»¤è¡Œæ— æ³•å®‰å…¨åŒºåˆ†ã€Œè£¸ root åŽæŽ¥å‚æ•°ã€å’Œã€Œå¸¦ç©ºæ ¼çš„ sibling è·¯å¾„ã€ã€‚
    // ç©ºæ ¼å½“ç»“æŸè¾¹ç•Œä¼šè¯¯ä¼¤ siblingï¼›ä¸å½“ç»“æŸä¼šæ¼è®¤è£¸è·¯å¾„ã€‚desktop-dev å‘½ä»¤è¡Œé‡Œ
    // checkout éƒ½ä»¥ /node_modules æˆ– /apps/desktop å‡ºçŽ°ï¼Œä¿å®ˆåŒ¹é…è¶³å¤Ÿã€‚
    const hasEndBoundary = after === undefined || after === '/' || after === '"' || after === "'";
    if (hasStartBoundary && hasEndBoundary) return true;
    index = normalizedCommand.indexOf(normalizedPath, index + 1);
  }
  return false;
}

/**
 * åˆ¤æ–­è¿›ç¨‹å‘½ä»¤è¡Œæ˜¯å¦å¸¦ `--user-data-dir=<userDataDir>`(Electron helper è¿›ç¨‹æºå¸¦)ã€‚
 * ç»“æŸè¾¹ç•Œå¿…é¡»æ˜¯è¡Œå°¾ / ç©ºç™½ / å¼•å· / æ–œæ  â€”â€” `Cindy-dev` ä¸å¾—å‘½ä¸­
 * `Cindy-dev-pi-latest` è¿™ç±»å‰ç¼€åŒåæ²™ç®±ã€‚è·¯å¾„æœ¬èº«å¯å«ç©ºæ ¼(macOS çš„
 * "Application Support"),æ‰€ä»¥æ•´æ®µ needle ç²¾ç¡®åŒ¹é…ã€åªå¯¹å°¾éƒ¨åšè¾¹ç•Œåˆ¤å®šã€‚
 */
export function commandUsesUserDataDir(command, userDataDir) {
  const normalizedCommand = normalize(command);
  const normalizedDir = stripTrailingSlashes(normalize(userDataDir));
  if (!normalizedDir) return false;
  // å€¼å¯èƒ½å¸¦å¼•å·(Windows å¸¸è§: --user-data-dir="C:\..."), è£¸å€¼ä¸Žå¼•å·åŒ…è£¹
  // ä¸¤ç§å½¢æ€éƒ½è¦å‘½ä¸­, å¦åˆ™å†²çªæ£€æµ‹æ¼åˆ¤ä¼šæ”¾è¡Œè¿›å…±äº« SQLite/ç™»å½•æ€ã€‚
  const needles = [
    `--user-data-dir=${normalizedDir}`,
    `--user-data-dir="${normalizedDir}`,
    `--user-data-dir='${normalizedDir}`,
  ];
  for (const needle of needles) {
    let index = normalizedCommand.indexOf(needle);
    while (index !== -1) {
      const after = normalizedCommand[index + needle.length];
      if (after === undefined || after === '/' || after === '"' || after === "'" || /\s/.test(after)) {
        return true;
      }
      index = normalizedCommand.indexOf(needle, index + 1);
    }
  }
  return false;
}

/**
 * è¿›ç¨‹æ˜¯å¦å±žäºŽ ownRootDir è¿™ä»½ checkoutã€‚Cindy æ‰˜ç®¡çš„ `.cindy-worktrees/<name>`
 * åµŒåœ¨ä¸» checkout ç›®å½•é‡Œï¼Œåªçœ‹è·¯å¾„å‰ç¼€ä¼šæŠŠæ‰˜ç®¡ worktree çš„ dev å½“æˆä¸» checkout
 * è‡ªå·±çš„è¿›ç¨‹ï¼ˆä¸»ä»“ restart è¯¯æ€å¹¶è¡Œå®žä¾‹ã€userData å†²çªé—¨æ¼æ£€ï¼‰ã€‚å½’å±žä»¥å‘½ä¸­çš„
 * æœ€æ·± checkout ä¸ºå‡†ï¼šåŒæ—¶å‘½ä¸­åµŒå¥—åœ¨ ownRootDir ä¸‹çš„å…¶ä»– worktree æ—¶ä¸ç®—è‡ªå·±çš„ã€‚
 */
export function commandBelongsToCheckout(command, ownRootDir, checkoutPaths = []) {
  if (!commandContainsPath(command, ownRootDir)) return false;
  const own = stripTrailingSlashes(normalize(ownRootDir));
  return !checkoutPaths.some((candidate) => {
    const normalized = stripTrailingSlashes(normalize(candidate));
    return normalized.startsWith(`${own}/`) && commandContainsPath(command, candidate);
  });
}

/**
 * é‡å¯çš„ kill ä½œç”¨åŸŸ:åªæ”¶å½“å‰ checkout(ownRootDir)è‡ªå·±çš„ dev è¿›ç¨‹ã€‚å…¶ä»–
 * worktree / å‘½åæ²™ç®±ä¸€å¾‹ä¿ç•™ â€”â€”ã€Œé‡å¯ã€çš„è¯­ä¹‰æ˜¯é‡å¯è¿™ä»½ checkout çš„å®žä¾‹,
 * ä¸æ˜¯æ¸…åœº(2026-07-30 çº¦æŸ:PI æ²™ç®±å¯åŠ¨å™¨æ›¾å…¨ç­æŽ‰å¹¶è¡Œçš„ tgbot-review æ²™ç®±)ã€‚
 */
export function partitionDesktopDevProcesses(processes, ownRootDir, checkoutPaths = []) {
  const targets = [];
  const preserved = [];
  for (const proc of processes) {
    (commandBelongsToCheckout(proc.command, ownRootDir, checkoutPaths) ? targets : preserved).push(proc);
  }
  return { targets, preserved };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

/**
 * `ps -eo â€¦` åœ¨è£…äº†ä¸Šåƒä¸ªè¿›ç¨‹çš„æœºå™¨ä¸Šå·²ç»è¶…è¿‡ spawnSync é»˜è®¤çš„ 1 MiBï¼Œæº¢å‡ºæ—¶
 * status æ˜¯ nullã€stdout åªå‰©åŠæˆªã€‚ä¸Šé™ä¸Ž desktop-whoami å…±ç”¨ä¸€ä¸ªå¸¸é‡ã€‚
 */
function processScanError(code, detail) {
  return new Error(
    `[PROCESS_SCAN_FAILED] Could not read the process table (${code}): ${detail}. ` +
      'Refusing to guess which desktop dev processes belong to this checkout; fix the process listing and re-run.',
  );
}

function ensureDesktopEnv() {
  const envPath = path.join(rootDir, 'apps', 'desktop', '.env');
  const examplePath = path.join(rootDir, 'apps', 'desktop', '.env.example');
  let content = '';
  let created = false;

  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  } else {
    created = true;
    content = fs.existsSync(examplePath)
      ? fs.readFileSync(examplePath, 'utf8')
      : '';
  }

  for (const { key, value, force } of desktopEnvSpec(content)) {
    content = upsertEnvValue(content, key, value, { overwrite: created || force });
  }

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, content.endsWith('\n') ? content : `${content}\n`);

  if (created) {
    console.log(`==> Created desktop env: ${path.relative(rootDir, envPath)}`);
  } else {
    console.log(`==> Checked desktop env: ${path.relative(rootDir, envPath)}`);
  }
}

function readEnvValue(content, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*?)\\s*$`, 'm');
  return content.match(pattern)?.[1]?.trim() ?? '';
}

function upsertEnvValue(content, key, value, options = {}) {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let found = false;

  const next = lines.map((line) => {
    if (!pattern.test(line)) return line;
    found = true;
    const current = line.slice(line.indexOf('=') + 1).trim();
    return current && !options.overwrite ? line : `${key}=${value}`;
  });

  if (!found) next.push(`${key}=${value}`);
  return next.join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function desktopDevCacheDirs(root = rootDir) {
  return desktopDevCacheRelativeDirs.map((entry) => path.join(root, entry));
}

function assertDesktopDevCachePath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const allowedTargets = new Set(desktopDevCacheDirs(resolvedRoot).map((entry) => path.resolve(entry)));
  if (!allowedTargets.has(resolvedTarget)) {
    throw new Error(`Refusing to remove unexpected desktop dev cache path: ${resolvedTarget}`);
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove desktop dev cache outside repository: ${resolvedTarget}`);
  }
}

export function clearDesktopDevCaches(root = rootDir, { logger = console } = {}) {
  const removed = [];
  for (const cacheDir of desktopDevCacheDirs(root)) {
    assertDesktopDevCachePath(root, cacheDir);
    if (!fs.existsSync(cacheDir)) continue;
    fs.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    removed.push(cacheDir);
  }

  if (removed.length > 0) {
    logger.log(
      `==> Cleared desktop dev cache: ${removed.map((entry) => path.relative(root, entry)).join(', ')}`,
    );
  } else {
    logger.log('==> Desktop dev cache already clean.');
  }
  return removed;
}

/**
 * è¯»å…¨é‡è¿›ç¨‹è¡¨ã€‚å¤±è´¥æ—¶æŠ›é”™è€Œä¸æ˜¯è¿”å›žç©ºæ•°ç»„ï¼šscan ä¸åˆ°è¿›ç¨‹æ—¶ã€Œæ²¡æ‰¾åˆ°æœ¬ checkout çš„
 * dev è¿›ç¨‹ã€å’Œã€ŒçœŸçš„æœ‰è¿›ç¨‹ã€çœ‹èµ·æ¥ä¸€æ¨¡ä¸€æ ·ï¼Œkill é˜¶æ®µä¼šå› æ­¤é™é»˜åœ°ä¸æ€ä»»ä½•ä¸œè¥¿ï¼Œæ—§å®žä¾‹
 * æ®‹ç•™åŽæ’žå•å®žä¾‹é”ã€‚å‘ä¸ŠæŠ›é”™ + ç‹¬ç«‹çš„ PROCESS_SCAN_FAILED verdict æ‰èƒ½è®©äººçœ‹åˆ°åŽŸå› ã€‚
 */
export function scanRestartProcessTable({ platform = process.platform, runCommand = run } = {}) {
  if (platform === 'win32') {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine } |
  Select-Object ProcessId,ParentProcessId,CommandLine |
  ConvertTo-Json -Compress
`;
    const result = runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      maxBuffer: PROCESS_TABLE_MAX_BYTES,
    });
    if (result.error || result.status !== 0) {
      throw processScanError(
        result.error?.code ?? `powershell.exe exit ${result.status}`,
        result.error?.message ?? 'powershell.exe did not return a process table',
      );
    }
    try {
      const parsed = JSON.parse(result.stdout);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
        pid: Number(item.ProcessId),
        ppid: Number(item.ParentProcessId) || 0,
        command: String(item.CommandLine ?? ''),
      }));
    } catch {
      throw processScanError('PROCESS_LIST_UNPARSABLE', 'powershell.exe output was not valid JSON');
    }
  }

  const result = runCommand('ps', ['-eo', 'pid=,ppid=,tty=,command='], {
    maxBuffer: PROCESS_TABLE_MAX_BYTES,
  });
  if (result.error || result.status !== 0) {
    throw processScanError(
      result.error?.code ?? `ps exit ${result.status}`,
      result.error?.message ?? 'ps did not return a process table',
    );
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]) || 0,
        tty: match[3],
        command: match[4],
      };
    })
    .filter(Boolean);
}

export function parseWorktreePaths(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
}

function repositoryWorktreePaths() {
  const result = run('git', ['worktree', 'list', '--porcelain'], { cwd: rootDir });
  if (result.status !== 0) return [rootDir];
  const worktrees = parseWorktreePaths(result.stdout);
  return worktrees.length > 0 ? worktrees : [rootDir];
}

function hasRepositoryCheckoutPath(command, checkoutPaths = repositoryWorktreePaths()) {
  return checkoutPaths.some((checkoutPath) => commandContainsPath(command, checkoutPath));
}

// æ²¿ ppid é“¾å‘ä¸Šæ‰¾ç¥–å…ˆé‡Œæœ‰æ²¡æœ‰ Cindy desktop dev è¿›ç¨‹ã€‚
// ç”¨é€”ï¼šæ‹¦ä½"agent è·‘åœ¨ã€å½“å‰ checkoutã€‘çš„ desktop dev é‡Œè¿˜è°ƒ restart"è¿™ç§è‡ªæ€åœºæ™¯â€”â€”
// kill ä½œç”¨åŸŸè™½å·²é™æœ¬ checkoutï¼Œä½†ç¥–å…ˆå°±æ˜¯è¿™ä»½ checkout æ—¶ä»ä¼šæŠŠæœ¬è„šæœ¬ä¸€èµ·æ”¶æŽ‰ã€‚
// å®¿ä¸»æ˜¯æ­£å¼ç‰ˆæˆ–å¦ä¸€ä¸ª worktree æ—¶ä¸æ‹¦ï¼šæ€ä¸åˆ°é‚£ä»½ç¥–å…ˆï¼Œéš”ç¦»å¯åŠ¨å¯ä»¥ç»§ç»­ã€‚
function findDevAncestor() {
  const processes = scanRestartProcessTable();
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const checkoutPaths = repositoryWorktreePaths();
  let cursor = byPid.get(process.pid)?.ppid ?? 0;
  for (let i = 0; cursor && i < 64; i += 1) {
    const ancestor = byPid.get(cursor);
    if (!ancestor) break;
    const command = normalize(ancestor.command);
    if (
      !command.includes('apps/claude-code-bin') &&
      !command.includes('apps/codex-bin') &&
      hasRepositoryCheckoutPath(command, checkoutPaths) &&
      hasDesktopDevSignature(command)
    ) {
      return ancestor;
    }
    cursor = ancestor.ppid;
  }
  return null;
}

function hasDesktopDevSignature(command) {
  return (
    command.includes('electron-forge') ||
    command.includes('@electron-forge') ||
    command.includes('dev:desktop') ||
    command.includes('pnpm --filter desktop dev') ||
    command.includes('/node_modules/electron/') ||
    (command.includes('/apps/desktop/') && (
      command.includes('vite.main.config') ||
      command.includes('vite.renderer.config') ||
      command.includes('vite.preload.config') ||
      command.includes('--app-path=')
    ))
  );
}

export function isRepositoryDesktopDevProcess(proc, checkoutPaths, currentPid = process.pid) {
  if (!proc.pid || proc.pid === currentPid) return false;
  const command = normalize(proc.command);
  if (command.includes('apps/claude-code-bin') || command.includes('apps/codex-bin')) return false;
  // Durable PI Subagent runners intentionally outlive the Electron main
  // process. They use the bundled Electron executable with
  // ELECTRON_RUN_AS_NODE=1, so the executable path alone looks like a Desktop
  // dev process. Killing them alongside the app turns a normal dev restart
  // into an unexpected terminal failure instead of letting the next Desktop
  // instance reattach to the still-running durable job.
  if (
    command.includes('/runtime/pi-subagent-runs/')
    && command.includes('/runner.cjs')
  ) return false;

  return hasRepositoryCheckoutPath(command, checkoutPaths) && hasDesktopDevSignature(command);
}

function killProcess(pid) {
  if (process.platform === 'win32') {
    return run('taskkill.exe', ['/F', '/T', '/PID', String(pid)]).status === 0;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  return true;
}

function forceKillProcess(pid) {
  if (process.platform === 'win32') {
    return killProcess(pid);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listDesktopDevProcesses() {
  const processes = scanRestartProcessTable();
  const checkoutPaths = repositoryWorktreePaths();
  return processes.filter((proc) => isRepositoryDesktopDevProcess(proc, checkoutPaths));
}

async function waitForDesktopDevProcessesToExit(timeoutMs, filter = () => true) {
  const deadline = Date.now() + timeoutMs;
  let remaining = listDesktopDevProcesses().filter(filter);

  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(pollIntervalMs);
    remaining = listDesktopDevProcesses().filter(filter);
  }

  return remaining;
}

function hasInteractiveTty() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function psSingleQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function cmdDoubleQuote(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Terminal çš„ `do script` æŠŠå‘½ä»¤å½“é”®ç›˜è¾“å…¥é€è¿›æ–°æ ‡ç­¾é¡µçš„ tty;æ–°çª—å£çš„ shell è¿˜æ²¡æŽ¥ç®¡
// è¾“å…¥æ—¶ tty å¤„äºŽ canonical æ¨¡å¼,å•è¡Œè¶…è¿‡ MAX_CANON(1024 å­—èŠ‚)ä¼šè¢«æˆªæ–­,æ•´æ¡å‘½ä»¤
// é™é»˜ä¸æ‰§è¡Œ(worktree è·¯å¾„é•¿ã€éœ€æ¸…é™¤çš„çŽ¯å¢ƒå˜é‡å¤šæ—¶å®žæµ‹ ~1600 å­—èŠ‚)ã€‚å®Œæ•´å‘½ä»¤å…ˆå†™è¿›
// ä¸´æ—¶è„šæœ¬,Terminal åªæ”¶ä¸€æ¡çŸ­çš„ source å‘½ä»¤;è„šæœ¬ç¬¬ä¸€è¡Œåˆ æŽ‰è‡ªèº«,ä¸ç•™æ®‹ç•™æ–‡ä»¶ã€‚
export function writeDarwinTerminalLaunchScript(command, dir = os.tmpdir()) {
  const scriptPath = path.join(dir, `cindy-desktop-dev-${randomBytes(6).toString('hex')}.sh`);
  fs.writeFileSync(scriptPath, `rm -f -- ${shellSingleQuote(scriptPath)}\n${command}\n`, {
    mode: 0o600,
  });
  return scriptPath;
}

export function darwinTerminalSourceCommand(scriptPath) {
  return `. ${shellSingleQuote(scriptPath)}`;
}

export function prepareDarwinTerminalLaunch(command, dir = os.tmpdir()) {
  const scriptPath = writeDarwinTerminalLaunchScript(command, dir);
  return {
    scriptPath,
    args: osascriptLaunchDarwinTerminalArgs(darwinTerminalSourceCommand(scriptPath)),
  };
}

// è¶³å¤Ÿè¦†ç›–å¯åŠ¨å…¨è¿‡ç¨‹ï¼ˆå®žæµ‹ä¸€æ¬¡å†·å¯åŠ¨çº¦ 0.6MBï¼‰ï¼›main/agent æ—¥å¿—å¦æœ‰æŒ‰å¤©è½®è½¬çš„æ–‡ä»¶ã€‚
export const DEV_TERMINAL_LOG_MAX_BYTES = 8 * 1024 * 1024;

export function desktopDevTerminalLogPath(root = rootDir) {
  return path.join(root, 'apps', 'desktop', 'logs', 'dev-terminal.log');
}

// Agent æ²¡æœ‰ TTY æ—¶ dev è·‘åœ¨æ–°å¼€çš„ Terminal æ ‡ç­¾é¡µé‡Œï¼Œè¿›ç¨‹é€€å‡ºåŽæ ‡ç­¾é¡µéšä¹‹å…³é—­ï¼Œ
// å¤±è´¥åŽŸå› å°±çœ‹ä¸åˆ°äº†ã€‚script(1) ç»§ç»­ç»™å­è¿›ç¨‹ä¸€ä¸ª ptyï¼ˆelectron-forge ä¾èµ– TTYï¼‰ï¼Œ
// è¾“å‡ºç»å‘½åç®¡é“åªæŠŠå‰ maxBytes å†™è¿›æ—¥å¿—ã€å…¶ä½™ä¸¢å¼ƒï¼šdev ä¼šæŠŠ trace çº§æ—¥å¿—é•œåƒåˆ°
// ç»ˆç«¯ï¼Œé•¿æœŸè¿è¡Œçš„å®žä¾‹ä¸èƒ½è®©è¿™ä»½æ–‡ä»¶æ— é™å¢žé•¿ã€‚æ¯æ¬¡å¯åŠ¨è¦†ç›–ï¼Œé€€å‡ºç ä¸Žå­è¿›ç¨‹ä¸€è‡´ã€‚
// è¿”å›žä¸€ä¸ª `{ ...; }` å‘½ä»¤ç»„ï¼Œå¯ä»¥æ•´ä½“æŽ¥åœ¨ `cd â€¦ &&` åŽé¢ï¼›envPrefix åªä½œç”¨äºŽ scriptã€‚
export function darwinTerminalLoggedCommand(
  command,
  logPath,
  { envPrefix = '', maxBytes = DEV_TERMINAL_LOG_MAX_BYTES } = {},
) {
  const log = shellSingleQuote(logPath);
  const fifo = shellSingleQuote(`${logPath}.fifo`);
  return [
    `{ rm -f ${fifo}; mkfifo ${fifo} && { { head -c ${maxBytes} > ${log}; cat > /dev/null; } < ${fifo} & }; `,
    `${envPrefix}/usr/bin/script -q -F ${fifo} ${command}; `,
    `cindyDevExit=$?; rm -f ${fifo}; (exit $cindyDevExit); }`,
  ].join('');
}

export function readDesktopDevLogTail(logPath, maxLines = 40) {
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  const lines = text
    // ANSI è½¬ä¹‰ã€script(1) å†™å…¥çš„ ^Dï¼é€€æ ¼ç­‰æŽ§åˆ¶å­—ç¬¦éƒ½åŽ»æŽ‰ï¼Œåªä¿ç•™å¯è¯»æ–‡æœ¬ã€‚
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .split(/\r?\n/)
    .map((line) => line.split('\r').at(-1).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd())
    .filter((line) => line.trim() !== '');
  return lines.slice(-maxLines);
}

function osascriptCloseDarwinTerminalTtyArgs(ttyPath) {
  return closeDarwinTerminalTtyScript
    .flatMap((line) => ['-e', line])
    .concat(ttyPath);
}

export function osascriptLaunchDarwinTerminalArgs(command) {
  return launchDarwinTerminalScript
    .flatMap((line) => ['-e', line])
    .concat(command);
}

function darwinTtyPath(tty) {
  if (!tty || tty === '??' || tty === '?') return null;
  return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
}

function darwinTerminalTtysForProcesses(processes) {
  if (process.platform !== 'darwin') return [];
  return [...new Set(processes.map((proc) => darwinTtyPath(proc.tty)).filter(Boolean))];
}

function closeDarwinTerminalTtys(ttys) {
  if (process.platform !== 'darwin' || ttys.length === 0) return;

  for (const ttyPath of ttys) {
    const result = run('osascript', osascriptCloseDarwinTerminalTtyArgs(ttyPath));
    if (result.status !== 0 && result.stderr.trim()) {
      console.warn(`==> Failed to close Terminal tab for ${ttyPath}: ${result.stderr.trim()}`);
    }
  }
}

/**
 * --isolated çš„é»˜è®¤ç‹¬ç«‹ userData ç›®å½•:ä¸Žå½“å‰åŒºåŸŸæ­£å¼ç›®å½•å¹³çº§ã€åå­—å¸¦ -dev2 åŽç¼€,
 * ç¨³å®šä¸éš checkout å˜(å¤šä¸ª worktree å…±äº«åŒä¸€ä¸ª dev æ²™ç®±,æƒ³å†ç»†åˆ†ç”¨å‘½åæ²™ç®±
 * `--isolated=<åå­—>` æˆ–è‡ªå·±è®¾ XDT_USER_DATA_DIR è¦†ç›–)ã€‚å‘½åæ²™ç®±ç›®å½•å†è¿½åŠ 
 * `-<åå­—>` åŽç¼€,æ¯ä¸ªåå­—ä¸€æ¡å®Œå…¨ç‹¬ç«‹çš„æ²™ç®±ã€‚åªåœ¨ dev ç”Ÿæ•ˆâ€”â€”ä¸»è¿›ç¨‹å…¥å£åªåœ¨
 * éž packaged æ—¶åº”ç”¨è¯¥è¦†å†™ã€‚
 */
function userDataDirNamed(dirName) {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    return path.join(appData, dirName);
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', dirName);
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  return path.join(xdgConfig, dirName);
}

export function hasIsolationIntent(argv = [], env = process.env) {
  return argv.some((arg) => arg === '--isolated' || arg.startsWith('--isolated='))
    || env.XDT_ISOLATED === '1';
}

export function officialProductionUserDataDirs() {
  return DESKTOP_DEV_REGIONS.map((region) => productionUserDataDir(region));
}

/** ä¸Ž devCliFlags ISOLATION_NAME_RE ä¸€è‡´ï¼šéžæ³•åå­—å›žè½é»˜è®¤æ²™ç®±ï¼Œä¸æŠŠè·¯å¾„æ®µå†™è¿›ç›®å½•ã€‚ */
export const ISOLATION_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function sanitizeIsolationName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  return ISOLATION_NAME_RE.test(name) ? name : '';
}

export function looksLikeCindyManagedUserDataDir(dir) {
  const base = path.basename(path.resolve(dir));
  return /^(Cindy|CindyGlobal|CindyDev)(?:-dev2(?:-[A-Za-z0-9_-]+)?)?$/i.test(base);
}

/** Named `--isolated=<name>` must not inherit another Cindy profile. Custom dirs stay. */
export function inheritedUserDataBlocksNamedIsolation(isolatedArg, envUserDataDir, derivedDir) {
  if (!envUserDataDir || !isolatedArg || !isolatedArg.includes('=')) return false;
  if (!looksLikeCindyManagedUserDataDir(envUserDataDir)) return false;
  return canonicalizeUserDataDir(envUserDataDir) !== canonicalizeUserDataDir(derivedDir);
}

function volumeIsCaseInsensitive(existingDir) {
  let dir = existingDir;
  for (;;) {
    const parent = path.dirname(dir);
    const atRoot = parent === dir;
    if (!atRoot) {
      try {
        if (fs.statSync(parent).dev !== fs.statSync(dir).dev) return false;
      } catch {
        return false;
      }
    }
    const name = path.basename(dir);
    const flipped = name.replace(/[a-zA-Z]/g, (ch) => (
      ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()
    ));
    if (flipped !== name) {
      try {
        return fs.realpathSync.native(path.join(parent, flipped))
          === fs.realpathSync.native(dir);
      } catch {
        return false;
      }
    }
    if (atRoot) return false;
    dir = parent;
  }
}

function foldCaseOption(dir) {
  try {
    fs.statSync(dir);
    return { foldCase: volumeIsCaseInsensitive(dir) };
  } catch {
    return {};
  }
}

export function canonicalizeUserDataDir(dir) {
  const resolved = path.resolve(dir);
  try {
    const real = fs.realpathSync.native(resolved);
    return volumeIsCaseInsensitive(real) ? real.toLowerCase() : real;
  } catch {
    // å¶å­è¿˜ä¸å­˜åœ¨:æ²¿æœ€è¿‘å­˜åœ¨ç¥–å…ˆåš realpath,å†æŒ‰è¯¥å·è¯­ä¹‰æŽ¥å›žå‰©ä½™æ®µã€‚
  }
  let current = resolved;
  const suffix = [];
  for (;;) {
    const parent = path.dirname(current);
    suffix.unshift(path.basename(current));
    if (parent === current) return resolved;
    current = parent;
    try {
      const ancestorReal = fs.realpathSync.native(current);
      const joined = path.join(ancestorReal, ...suffix);
      return volumeIsCaseInsensitive(ancestorReal) ? joined.toLowerCase() : joined;
    } catch {
      // ç»§ç»­ä¸Šæº¯
    }
  }
}

export function isOfficialProductionUserDataDir(dir) {
  const resolved = canonicalizeUserDataDir(dir);
  return officialProductionUserDataDirs().some(
    (official) => canonicalizeUserDataDir(official) === resolved,
  );
}

export function resolveRestartTargetUserDataDir({
  envUserDataDir,
  isolatedArg,
  isolatedEnv,
  isolatedName,
  selectedRegion,
  rootDir: targetRoot = rootDir,
}) {
  const resolvedIsolatedArg = resolveIsolatedArg(isolatedArg, targetRoot, foldCaseOption(targetRoot));
  const isolationName = sanitizeIsolationName(
    resolvedIsolatedArg ? parseIsolationName(resolvedIsolatedArg) : isolatedName,
  );
  const isolated = Boolean(resolvedIsolatedArg) || isolatedEnv === '1';
  return envUserDataDir
    || (isolated
      ? defaultIsolatedUserDataDir(isolationName, selectedRegion)
      : productionUserDataDir(selectedRegion));
}

/**
 * Credential cleanup/write access is more destructive than ordinary isolated
 * startup. Trust only the v2 sandbox selected by this restart invocation; an
 * ambient userData path must not gain that authority by spoofing the epoch.
 */
export function isTrustedIsolatedAuthUserDataDir({
  isolatedArg,
  userDataDir,
  userDataDirEpoch,
  userDataDerivedByRestart,
  selectedRegion,
}) {
  if (
    !isolatedArg
    || !userDataDir
    || userDataDirEpoch !== '1'
    || userDataDerivedByRestart !== true
  ) {
    return false;
  }
  const expectedDir = defaultIsolatedUserDataDir(
    parseIsolationName(isolatedArg),
    selectedRegion,
  );
  if (userDataDirEntryIsAliasOrUnverifiable(userDataDir)) return false;
  return canonicalizeUserDataDir(userDataDir) === canonicalizeUserDataDir(expectedDir);
}

function userDataDirEntryIsAliasOrUnverifiable(dir) {
  try {
    return fs.lstatSync(path.resolve(dir)).isSymbolicLink();
  } catch (error) {
    // A not-yet-created derived sandbox is valid at the early trust gate. Every other lstat
    // failure is ambiguous and must not authorize credential cleanup or OAuth writes.
    return error?.code !== 'ENOENT';
  }
}

/**
 * Mint a single-use proof only after this restart invocation derived and accepted the sandbox.
 * The nonce crosses Terminal/runner/Forge via env; the bound file is the second factor that an
 * inherited ambient env does not carry. Desktop consumes it from its actual app userData path.
 */
export function createIsolatedAuthLaunchProof({
  userDataDir,
  isolationName = '',
  now = Date.now(),
  nonce = randomBytes(32).toString('hex'),
}) {
  // Recheck at the write boundary: process cleanup between authorization and proof minting leaves
  // time for the derived directory to be swapped for a symlink / Windows junction.
  if (userDataDirEntryIsAliasOrUnverifiable(userDataDir)) {
    throw new Error('Refusing isolated-auth launch proof for a symlink or junction userData path');
  }
  const proofPath = path.join(userDataDir, ISOLATED_AUTH_LAUNCH_PROOF_FILE);
  const tempPath = `${proofPath}.${process.pid}.${nonce}.tmp`;
  const proof = {
    version: 1,
    nonce,
    userDataDir: canonicalizeUserDataDir(userDataDir),
    profileKind: 'isolated-sandbox',
    epoch: 1,
    isolationName,
    issuedAtMs: now,
    expiresAtMs: now + isolatedAuthLaunchProofTtlMs,
  };
  fs.rmSync(proofPath, { force: true });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(proof)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tempPath, proofPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return nonce;
}

/**
 * Refuse when restarting would suicide this checkout's host, or when a shared
 * start is hosted by another checkout's desktop-dev (same official profile).
 * Isolated start from another checkout is safe: kill scope is ownRootDir.
 */
export function shouldRefuseHostedRestart(ancestor, {
  preserveRunning,
  ownRootDir,
  isolated = false,
  checkoutPaths = [],
}) {
  if (!ancestor || preserveRunning) return false;
  if (commandBelongsToCheckout(ancestor.command, ownRootDir, checkoutPaths)) return true;
  return isolated !== true;
}

export function hostedRestartRefusal(ancestor, { ownRootDir, checkoutPaths = [] }) {
  return commandBelongsToCheckout(ancestor.command, ownRootDir, checkoutPaths)
    ? {
      code: 'HOSTED_RESTART_REFUSED',
      message: "Refusing to restart from within this checkout's desktop dev process tree.",
    }
    : {
      code: 'HOSTED_SHARED_REFUSED',
      message: 'Cannot share official userData while hosted by another checkout desktop dev.',
    };
}

export function defaultIsolatedUserDataDir(isolationName, region = 'global') {
  // ç›®å½•çºªå…ƒ v2(-dev2),ä¸Ž devCliFlags.ts çš„æ´¾ç”Ÿä¿æŒä¸€å­—ä¸å·®:#871 èµ·éš”ç¦»æ²™ç®±ç”¨
  // CindyDev é’¥åŒ™ä¸²èº«ä»½,æ—§ -dev ç›®å½•ç•™ç»™æ—§ checkout(#912 review)ã€‚
  const baseName = desktopUserDataDirNameForRegion(region);
  return userDataDirNamed(`${baseName}-dev2${isolationName ? `-${isolationName}` : ''}`);
}

/** éžéš”ç¦» dev ä¸Žæ­£å¼ç‰ˆå…±ç”¨çš„ userData ç›®å½•ã€‚ */
export function productionUserDataDir(region = 'global') {
  return userDataDirNamed(desktopUserDataDirNameForRegion(region));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

/**
 * --preserve-running åªæœ‰åœ¨ç›®æ ‡ profile çš„æ‰€æœ‰å­˜æ´»å®žä¾‹éƒ½æ˜Žç¡®å£°æ˜ŽåŒä¸€åŒºåŸŸæ—¶
 * æ‰èƒ½å…±äº«ã€‚æ—§è®°å½•æ²¡æœ‰ regionï¼Œå±žäºŽæ— æ³•è¯æ˜Žå…¼å®¹ï¼Œå¿…é¡» fail closedã€‚
 */
export function inspectSharedUserDataRegion(userDataDir, expectedRegion, processes = []) {
  const recordsDir = path.join(userDataDir, '.dev-instances');
  const liveRecords = [];
  try {
    for (const name of fs.readdirSync(recordsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(recordsDir, name), 'utf8'));
        if (Number.isInteger(record?.pid) && isProcessAlive(record.pid)) liveRecords.push(record);
      } catch {
        // æŸåè®°å½•ä¸èƒ½è¯æ˜Žå…¼å®¹ï¼›è‹¥ç¡®æœ‰ helper å ç”¨ï¼Œä¸‹é¢çš„ process guard ä¼šæ‹’ç»ã€‚
      }
    }
  } catch {
    // æ²¡æœ‰æ³¨å†Œè¡¨æ—¶ç»§ç»­çœ‹è¿›ç¨‹æ‰«æã€‚
  }

  const incompatibleRecords = liveRecords.filter(
    (record) => record.region !== expectedRegion || typeof record.rootDir !== 'string',
  );
  if (incompatibleRecords.length > 0) {
    return {
      compatible: false,
      reason:
        `target userData has live instance record(s) with incompatible or unknown region: ` +
        incompatibleRecords
          .map(
            (record) =>
              `pid=${record.pid},region=${record.region ?? 'unknown'},` +
              `root=${record.rootDir ?? 'unknown'}`,
          )
          .join('; '),
    };
  }

  const scannedUsers = processes.filter((proc) => commandUsesUserDataDir(proc.command, userDataDir));
  const unprovenUsers = scannedUsers.filter(
    (proc) => !liveRecords.some((record) => commandContainsPath(proc.command, record.rootDir)),
  );
  if (unprovenUsers.length > 0) {
    return {
      compatible: false,
      reason:
        `target userData has active process(es) not covered by a live ` +
        `region=${expectedRegion} instance record: ` +
        unprovenUsers.map((proc) => `pid=${proc.pid}`).join(', '),
    };
  }
  return { compatible: true, reason: null };
}

function parseIsolationName(isolatedArg) {
  if (!isolatedArg || !isolatedArg.includes('=')) return '';
  return isolatedArg.slice('--isolated='.length);
}

function devScriptForMode(mode) {
  return mode === 'local' ? 'dev:desktop' : 'dev:desktop:remote';
}

function packageManagerCommand(mode) {
  const runnerPath = path.join(rootDir, 'scripts', 'desktop-dev-runner.mjs');
  if (process.platform === 'win32') {
    return `${cmdDoubleQuote(process.execPath)} ${cmdDoubleQuote(runnerPath)} ${mode}`;
  }
  return `${shellSingleQuote(process.execPath)} ${shellSingleQuote(runnerPath)} ${shellSingleQuote(mode)}`;
}

function darwinEnvPrefix() {
  const corepackShimDir = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'corepack', 'shims');
  const pnpmExecPath = process.env.npm_execpath;
  const preferredPathParts = [
    pnpmExecPath ? path.dirname(pnpmExecPath) : null,
    path.dirname(process.execPath),
  ].filter(Boolean);
  // corepack shims åªèƒ½æ”¾åœ¨ "$PATH" ä¹‹åŽå…œåº•:å®ƒçš„ pnpm ç‰ˆæœ¬ç”± corepack è‡ªå·±å†³å®š,
  // æŽ’åœ¨ç”¨æˆ· PATH å‰é¢ä¼šç›–æŽ‰ç”¨æˆ·è‡ªå·±è£…å¥½çš„ pnpm(proto / homebrew ç­‰),
  // corepack é»˜è®¤ç‰ˆæœ¬æ¼‚åˆ° pnpm 11 åŽå°±ä¼šæ’žæœ¬ä»“ engines ä¸Šé™ç‚¸æŽ‰ dev å¯åŠ¨ã€‚
  const fallbackPathParts = [
    ...(fs.existsSync(corepackShimDir) ? [corepackShimDir] : []),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  return `export PATH=${shellSingleQuote([...new Set(preferredPathParts)].join(path.delimiter))}:"$PATH":${shellSingleQuote([...new Set(fallbackPathParts)].join(path.delimiter))}; `;
}

/**
 * å¯åŠ¨å™¨è½¬å‘ç»™ dev è¿›ç¨‹çš„å…¨éƒ¨çŽ¯å¢ƒå˜é‡(å«æœªè®¾å€¼é¡¹)ã€‚devEnvPrefix åªè½¬å‘æœ‰å€¼çš„é¡¹;
 * macOS èµ°é•¿é©»çš„ Terminal.app æ—¶,æœªè®¾å€¼é¡¹è¿˜å¿…é¡»ç”± darwinStaleDevEnvUnset æ˜¾å¼æ¸…æŽ‰ â€”â€”
 * å¦åˆ™ Terminal è¿›ç¨‹é‡Œæ®‹ç•™çš„æ›´æ—©ä¸€æ¬¡å¯åŠ¨çš„å€¼(XDT_ISOLATED / XDT_USER_DATA_DIR /
 * XDT_USER_DATA_DIR_EPOCH ç­‰)ä¼šè¢« dev è¿›ç¨‹ç»§æ‰¿,`--shared` / `--preserve-running`
 * é¢„è§ˆæ‚„æ‚„è½è¿›åˆ«çš„ worktree çš„æ²™ç®±,ç”šè‡³ç”¨é”™é’¥åŒ™ä¸²èº«ä»½æ‰“å¼€ profileã€‚
 * ä¸å˜é‡:Terminal å‘½ä»¤é‡Œè¿™äº›å˜é‡çš„å–å€¼ == æœ¬æ¬¡å¯åŠ¨å™¨çš„å–å€¼ã€‚
 */
function devEnvEntries(env) {
  return [
    // --region ç» CINDY_AUTH_REGION æ³¨å…¥ dev-remote-env / Forge / Viteï¼ŒåŒä¸€ä¸ªå€¼
    // åŒæ—¶å†³å®šåŒºåŸŸèº«ä»½ä¸Ž --endpoints-cdn çš„è‡ªä¸¾ CDN åŸºå€ã€‚
    ['CINDY_AUTH_REGION', env.CINDY_AUTH_REGION],
    ['XDT_VOICE_INPUT_RECORD', env.XDT_VOICE_INPUT_RECORD],
    // ç™»å½• scenario harness(dev-only çŠ¶æ€éåŽ†,implementation-plan Step 0):
    // XDT_LOGIN_SCENARIO ç”± authManager æ¶ˆè´¹(é™„å½• A å€¼åŸŸ);
    // VITE_SPLASH_PHASE_FIXTURE ç”± renderer useSplash fixture è¯»å–ç‚¹æ¶ˆè´¹
    // (Vite ä¼šæŠŠè¿›ç¨‹çº§ VITE_* æš´éœ²è¿› import.meta.env,dev-only)ã€‚
    ['XDT_LOGIN_SCENARIO', env.XDT_LOGIN_SCENARIO],
    ['VITE_SPLASH_PHASE_FIXTURE', env.VITE_SPLASH_PHASE_FIXTURE],
    ['XDT_USER_DATA_DIR', env.XDT_USER_DATA_DIR],
    ['XDT_USER_DATA_DIR_EPOCH', env.XDT_USER_DATA_DIR_EPOCH],
    ['XDT_DEVICE_ID_OVERRIDE', env.XDT_DEVICE_ID_OVERRIDE],
    ['XDT_SCHEDULER_PASSIVE', env.XDT_SCHEDULER_PASSIVE],
    ['XDT_ISOLATED', env.XDT_ISOLATED],
    ['XDT_ISOLATED_NAME', env.XDT_ISOLATED_NAME],
    // --mock çš„ UI æ¨¡æ‹Ÿæ•°æ®å¼€å…³(main/index.ts åªåœ¨éš”ç¦»æ²™ç®±é‡Œè®¤)ã€‚
    ['XDT_UI_MOCK', env.XDT_UI_MOCK],
    // Cindy Make æµ‹è¯•çª—å£æ ‡è®°å¿…é¡»ç©¿è¿‡ restart â†’ dev-env â†’ Forgeï¼Œ
    // å¦åˆ™æµ‹è¯•è¿›ç¨‹ä¼šé€€åŒ–æˆæ™®é€šå¼€å‘çª—å£ï¼ˆæ•°æ®è™½éš”ç¦»ï¼Œå…³é—­ï¼å‰å°è¡Œä¸ºå´ä¸å†æ˜¯æµ‹è¯•ç‰ˆï¼‰ã€‚
    ['XDT_CINDY_MAKE_TEST', env.XDT_CINDY_MAKE_TEST],
    // æ²™ç®±å‡­è¯éš”ç¦»(--isolated-auth):ä¸ä¸Ž ~/.codex å…±äº« auth ç¡¬é“¾,auth-adapters æ¶ˆè´¹ã€‚
    ['XDT_ISOLATED_AUTH', env.XDT_ISOLATED_AUTH],
    ['XDT_ALLOW_DEV_OAUTH_WRITE', env.XDT_ALLOW_DEV_OAUTH_WRITE],
    ['XDT_ISOLATED_AUTH_PROOF', env.XDT_ISOLATED_AUTH_PROOF],
    // CDP ç«¯å£è¦†å†™(bootstrap-electron æ¶ˆè´¹): å¹¶è¡Œå¤šå¼€æ²™ç®±æ—¶ç»™åŽèµ·å®žä¾‹æ¢ç«¯å£ã€‚
    ['XDT_CDP_PORT', env.XDT_CDP_PORT],
    // A long-lived Terminal can retain a previous smoke run's environment.
    // Override its value even when this invocation did not request the smoke.
    ['CINDY_CUA_SMOKE', ['1', 'cursor-goal'].includes(env.CINDY_CUA_SMOKE) ? env.CINDY_CUA_SMOKE : '0'],
    // ä¸€æ¬¡æ€§ Grok wire å½’å› æŽ¢é’ˆ(dev-only;æ­£å¸¸çŽ¯å¢ƒä¸è®¾ç½®,ä¸äº§ç”Ÿé¢å¤–æ—¥å¿—)ã€‚
    ['XDT_WIRE_DIAGNOSTICS', env.XDT_WIRE_DIAGNOSTICS],
    // ä¸€æ¬¡æ€§ Grok strict tool spike(dev-only;å¿…é¡»ä¸Ž wire probe ä¸€èµ·æ˜¾å¼å¼€å¯)ã€‚
    ['XDT_WIRE_DIAGNOSTICS_STRICT', env.XDT_WIRE_DIAGNOSTICS_STRICT],
    ['CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY', env.CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY],
    ['XDT_TAPDB_DEV', env.XDT_TAPDB_DEV],
    // ç«¯ç‚¹æ¸…å•æ¥æºè¦†å†™:--endpoints-cdn(dev èµ°çº¿ä¸Š CDN)/ local æ¨¡å¼çš„
    // endpoint.local.json æ–‡ä»¶è·¯å¾„,å‡ç”±ä¸»è¿›ç¨‹ clientEndpointsService æ¶ˆè´¹ã€‚
    ['XDT_ENDPOINTS_CDN', env.XDT_ENDPOINTS_CDN],
    ['XDT_ENDPOINT_MANIFEST_FILE', env.XDT_ENDPOINT_MANIFEST_FILE],
    // Partial local relay testing preserves the normal authentication realm discovery.
    ['XDT_DEVICE_LINK_LOCAL_URL', env.XDT_DEVICE_LINK_LOCAL_URL],
    ['XDT_DEVICE_LINK_CN_LOCAL_URL', env.XDT_DEVICE_LINK_CN_LOCAL_URL],
    ['XDT_DEVICE_LINK_GLOBAL_LOCAL_URL', env.XDT_DEVICE_LINK_GLOBAL_LOCAL_URL],
    // æ¨¡åž‹ç›®å½•é—­çŽ¯è°ƒè¯•è¦†å†™ã€‚dev é»˜è®¤ä»ä¸è”ç½‘ï¼›åªæœ‰æ˜¾å¼ç»™ URL æ—¶ï¼Œä¸»è¿›ç¨‹æ‰å…è®¸
    // ä»Žè¯¥åœ°å€æ‹‰å– Catalogã€‚PATH / DISABLE åŒæ­¥é€ä¼ ï¼Œé¿å… runner åžæŽ‰å·²æœ‰å¥‘çº¦ã€‚
    ['XDT_MODELS_URL', env.XDT_MODELS_URL],
    ['XDT_MODELS_PATH', env.XDT_MODELS_PATH],
    ['XDT_DISABLE_MODELS_FETCH', env.XDT_DISABLE_MODELS_FETCH],
    // å¯åŠ¨å³è‡ªåŠ¨æ‰“å¼€ DevTools(main çš„ ready-to-show é‡Œæ¶ˆè´¹;è§ bootstrap-electron)ã€‚
    // ç»™"å¿«æ·é”®/èœå•æ‰“ä¸å¼€ DevTools"çš„çŽ¯å¢ƒå…œåº•,QA æŽ§åˆ¶å°éªŒè¯ä¾èµ–å®ƒã€‚
    ['OPEN_DEVTOOLS', env.OPEN_DEVTOOLS],
    // --wait-ready çš„ä¸€æ¬¡æ€§çŠ¶æ€æ–‡ä»¶ï¼šrunner å†™å¤±è´¥ï¼ŒElectron main ready-to-show å†™æˆåŠŸã€‚
    ['XDT_DESKTOP_DEV_STARTUP_STATUS_FILE', env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE],
    // æ’ä»¶å­˜å‚¨å¯åŠ¨è¾¹ç•Œçš„ dev é»‘ç›’éªŒæ”¶ï¼šä»…æ˜¾å¼ä¸´æ—¶ç»“æžœè·¯å¾„æ—¶å¯ç”¨ã€‚
    ['XDT_PLUGIN_STORAGE_SMOKE_RESULT_FILE', env.XDT_PLUGIN_STORAGE_SMOKE_RESULT_FILE],
  ];
}

/** macOS Terminal å‘½ä»¤å‰ç¼€:æ¸…æŽ‰æœ¬æ¬¡æœªè®¾å€¼ã€ä½†å¯èƒ½æ®‹ç•™åœ¨ Terminal è¿›ç¨‹é‡Œçš„è½¬å‘å˜é‡ã€‚ */
export function darwinStaleDevEnvUnset(env = process.env) {
  const keys = devEnvEntries(env)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  return keys.length > 0 ? `unset ${[...new Set(keys)].join(' ')}; ` : '';
}

export function devEnvPrefix(env = process.env, platform = process.platform) {
  const envEntries = devEnvEntries(env).filter(([, value]) => value);

  if (platform === 'win32') {
    return envEntries
      .map(([key, value]) => `set "${key}=${String(value).replaceAll('"', '')}" && `)
      .join('');
  }

  return envEntries
    .map(([key, value]) => `${key}=${shellSingleQuote(String(value))}`)
    .join(' ') + ' ';
}

function launchInSystemTerminal(mode) {
  if (process.platform === 'win32') {
    const command = `cd /d ${cmdDoubleQuote(rootDir)} && ${devEnvPrefix()}${packageManagerCommand(mode)}`;
    const script = [
      "Start-Process -FilePath 'cmd.exe'",
      `-ArgumentList @('/c', ${psSingleQuote(command)})`,
      `-WorkingDirectory ${psSingleQuote(rootDir)}`,
    ].join(' ');
    const result = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: 'inherit',
      windowsHide: false,
    });
    if (result.status !== 0) {
      throw new Error(`Failed to open cmd window (exit ${result.status ?? 1})`);
    }
    console.log(`==> Opened desktop ${mode} dev in a new cmd window.`);
    return;
  }

  if (process.platform === 'darwin') {
    const logPath = desktopDevTerminalLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.rmSync(logPath, { force: true });
    fs.rmSync(`${logPath}.fifo`, { force: true });
    const command = `${darwinEnvPrefix()}${darwinStaleDevEnvUnset()}cd ${shellSingleQuote(rootDir)} && ${darwinTerminalLoggedCommand(packageManagerCommand(mode), logPath, { envPrefix: devEnvPrefix() })}; exitCode=$?; exit $exitCode`;
    const { scriptPath, args } = prepareDarwinTerminalLaunch(command);
    // osascript åœ¨ do script ä¹‹å‰å¤±è´¥ï¼ˆè‡ªåŠ¨åŒ–æƒé™è¢«æ‹’ã€è„šæœ¬é”™è¯¯ï¼‰æ—¶ä¸´æ—¶è„šæœ¬ä¸ä¼šè¢« sourceï¼Œ
    // é¦–è¡Œè‡ªåˆ ä¸ä¼šå‘ç”Ÿï¼›æŒ‰å¤±è´¥é€€å‡ºå°½åŠ›åˆ é™¤ï¼Œé¿å…ç•™ä¸‹å«å¼€å‘çŽ¯å¢ƒå˜é‡çš„æ–‡ä»¶ã€‚
    const removeScript = () => {
      try {
        fs.rmSync(scriptPath, { force: true });
      } catch {
        // å°½åŠ›æ¸…ç†ï¼Œå¤±è´¥ä¸å½±å“å¯åŠ¨ç»“æžœåˆ¤æ–­ã€‚
      }
    };
    const child = spawn('osascript', args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', removeScript);
    child.on('exit', (code) => {
      if (code !== 0) removeScript();
    });
    child.unref();
    if (child.pid === undefined) {
      removeScript();
      throw new Error('Failed to open Terminal.app');
    }
    console.log(`==> Opened desktop ${mode} dev in a new Terminal window.`);
    console.log(`==> Dev terminal output is also written to ${logPath}`);
    return logPath;
  }

  console.warn('==> Non-interactive terminal detected, but no system terminal launcher is configured for this platform.');
  console.warn('==> Falling back to current process; this may fail if electron-forge requires a TTY.');
  return null;
}

function startDesktopDev(mode) {
  console.log(`==> Starting desktop ${mode} dev...`);

  if (!hasInteractiveTty() && (process.platform === 'win32' || process.platform === 'darwin')) {
    return launchInSystemTerminal(mode) ?? null;
  }

  const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'desktop-dev-runner.mjs'), mode], {
    cwd: rootDir,
    stdio: 'inherit',
    windowsHide: false,
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    // --wait-ready owns the process exit so it can print DESKTOP_DEV_VERDICT.
    if (process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE) return;
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
  return null;
}

function createStartupStatusPath() {
  return path.join(
    os.tmpdir(),
    `cindy-desktop-startup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

export function readDesktopStartupStatus(statusPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function formatDesktopStartupFailure(status) {
  const code = typeof status?.code === 'string' ? status.code : 'DEV_PROCESS_EXITED';
  const message = typeof status?.message === 'string'
    ? status.message
    : 'Desktop dev exited before window/auth/database startup completed.';
  const detail = status?.detail && typeof status.detail === 'object'
    ? Object.entries(status.detail)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ')
    : '';
  const processExit = status?.exitCode !== undefined || status?.signal
    ? ` exit=${status.exitCode ?? 'unknown'}${status.signal ? ` signal=${status.signal}` : ''}`
    : '';
  return `[${code}] ${message}${detail ? ` (${detail})` : ''}${processExit}`;
}

function writeDesktopStartupStatus(statusPath, status) {
  const tempPath = `${statusPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, statusPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw new Error(`Failed to write desktop startup status: ${error.message}`);
  }
}

function attachStartupFailure(error, status) {
  error.startupStatus = status ?? null;
  return error;
}

export async function waitForDesktopStartup(statusPath, timeoutMs = startupReadyTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readDesktopStartupStatus(statusPath);
    if (status?.state === 'ready') {
      console.log(`==> Desktop dev is ready (window + auth/local database, pid ${status.pid ?? 'unknown'}).`);
      fs.rmSync(statusPath, { force: true });
      return status;
    }
    if (status?.state === 'failed') {
      fs.rmSync(statusPath, { force: true });
      throw attachStartupFailure(
        new Error(
          `${formatDesktopStartupFailure(status)} Check the dev terminal, run \`pnpm desktop:whoami\`, and inspect apps/desktop/logs/.`,
        ),
        status,
      );
    }
    await sleep(pollIntervalMs);
  }
  // Keep a tombstone so a late Electron startup signal cannot recreate a stale
  // status file after this waiter has already reported timeout to its caller.
  writeDesktopStartupStatus(statusPath, { state: 'abandoned', at: Date.now() });
  throw attachStartupFailure(
    new Error(
      `Desktop dev did not finish window/auth/database startup within ${Math.round(timeoutMs / 1000)}s. Check the dev terminal and apps/desktop/logs/.`,
    ),
    {
      state: 'failed',
      code: 'STARTUP_TIMEOUT',
      message: `Desktop dev did not finish window/auth/database startup within ${Math.round(timeoutMs / 1000)}s.`,
    },
  );
}

/**
 * The kill-only phase controls existing processes but does not launch Desktop.
 * Skipping startup initialization keeps that phase from printing default
 * region/endpoint values that can contradict the following real startup.
 */
export function applyDesktopStartupConfigForPhase(options) {
  if (options.argv.includes('--kill-only')) return null;
  return applyDesktopDevStartupConfig(options);
}

export function clearInheritedIsolatedAuthAuthorization(env = process.env) {
  delete env.XDT_ISOLATED_AUTH;
  delete env.XDT_ALLOW_DEV_OAUTH_WRITE;
  delete env.XDT_ISOLATED_AUTH_PROOF;
}

async function main() {
  // These capabilities are granted below only for this invocation's accepted --isolated-auth.
  clearInheritedIsolatedAuthAuthorization();
  let argv = normalizeDesktopRestartArgv(process.argv.slice(2), process.env);
  const sharedArgvConflict = desktopRestartArgvConflictMessage(argv, process.env);
  if (sharedArgvConflict) throw new Error(sharedArgvConflict);
  // --mock: dev main seeds the shared UI mock tasks into this isolated sandbox
  // (docs/dev-rules/ui-mock-data.md). Only the flag turns it on, never a stale shell env.
  if (argv.includes(UI_MOCK_ARG)) process.env.XDT_UI_MOCK = '1';
  else delete process.env.XDT_UI_MOCK;
  const rawIsolatedArg = argv.find((arg) => arg === '--isolated' || arg.startsWith('--isolated='));
  const isolatedArg = resolveIsolatedArg(rawIsolatedArg, rootDir, foldCaseOption(rootDir));
  if (rawIsolatedArg && isolatedArg && isolatedArg !== rawIsolatedArg) {
    argv = argv.map((arg) => (arg === rawIsolatedArg ? isolatedArg : arg));
    console.log(`==> Isolated sandbox from worktree: ${parseIsolationName(isolatedArg)}`);
  }
  const killOnly = argv.includes('--kill-only');
  const waitReady = argv.includes('--wait-ready');
  const preserveRunning = argv.includes('--preserve-running');
  const replaceRunningArg = argv.find((arg) => arg.startsWith('--replace-running-root='));
  const replaceRunningRoot = replaceRunningArg
    ? path.resolve(replaceRunningArg.slice('--replace-running-root='.length))
    : null;
  // --local åˆ‡æ¢åˆ°æœ¬åœ°æ¨¡å¼(è¿ž localhost:3333);ç¼ºçœèµ° remote(è¿ž xdt-api)ã€‚
  const mode = argv.includes('--local') ? 'local' : 'remote';
  const startupConfig = applyDesktopStartupConfigForPhase({ argv, mode });
  const selectedRegion = startupConfig?.region ?? resolveDesktopDevRegion(argv, process.env);
  let userDataDerivedByRestart = false;
  let isolatedAuthAuthorizedByRestart = false;
  if (isolatedArg && isolatedArg.includes('=')) {
    const derivedDir = defaultIsolatedUserDataDir(parseIsolationName(isolatedArg), selectedRegion);
    if (inheritedUserDataBlocksNamedIsolation(isolatedArg, process.env.XDT_USER_DATA_DIR, derivedDir)) {
      delete process.env.XDT_USER_DATA_DIR;
      delete process.env.XDT_USER_DATA_DIR_EPOCH;
      delete process.env.XDT_DEVICE_ID_OVERRIDE;
      delete process.env.XDT_ISOLATED_NAME;
      console.log(`==> Ignoring inherited Cindy profile so --isolated=${parseIsolationName(isolatedArg)} can use its own sandbox.`);
    }
  }
  const isolationName = isolatedArg ? parseIsolationName(isolatedArg) : '';
  const verdictContext = {
    rootDir,
    isolated: Boolean(isolatedArg) || process.env.XDT_ISOLATED === '1',
    sandbox: isolationName || undefined,
    local: mode === 'local',
    region: selectedRegion,
  };
  const exitWithFailure = (code, message, details = []) => {
    for (const line of details) console.error(line);
    printDesktopDevVerdict(buildDesktopDevVerdictFromFailure(new Error(message), {
      ...verdictContext,
      code,
    }));
    process.exit(1);
  };
  if (preserveRunning && killOnly) {
    throw new Error('--preserve-running cannot be combined with the internal --kill-only stage');
  }
  if (replaceRunningRoot && !preserveRunning) {
    throw new Error('--replace-running-root requires --preserve-running');
  }
  if (replaceRunningArg && !replaceRunningArg.slice('--replace-running-root='.length)) {
    throw new Error('--replace-running-root requires an absolute registered worktree path');
  }
  if (replaceRunningRoot) {
    const registeredRoots = repositoryWorktreePaths().map((entry) => path.resolve(entry));
    if (!registeredRoots.includes(replaceRunningRoot)) {
      throw new Error(`--replace-running-root is not a registered repository worktree: ${replaceRunningRoot}`);
    }
    if (replaceRunningRoot === rootDir) {
      throw new Error('--replace-running-root cannot target the worktree that is starting the replacement');
    }
  }
  if (preserveRunning && mode === 'local') {
    throw new Error(
      '--preserve-running only supports remote mode: sharing remote login storage with a local auth server could invalidate the persisted credential',
    );
  }
  if (preserveRunning && hasIsolationIntent(argv, process.env)) {
    throw new Error(
      '--preserve-running reuses the current Cindy login via shared userData and cannot be combined with --isolated or XDT_ISOLATED=1',
    );
  }
  if (startupConfig && argv.includes(SHARED_USERDATA_ARG)) {
    console.log('==> Shared userData mode: dev keeps the legacy shared profile behavior instead of an isolated sandbox.');
  }
  if (startupConfig) {
    console.log(`==> Desktop region: ${startupConfig.region}`);
  }
  // --passive: å®šæ—¶ä»»åŠ¡è¢«åŠ¨æ¨¡å¼ â€”â€” æœ¬å®žä¾‹ä¸å‚ä¸Žè‡ªåŠ¨è§¦å‘(äº¤ç»™åŒæœº primary,
  // å…¸åž‹åœºæ™¯å¤šä¸ª dev preview ä¸Ž release/primary å…±äº«æ•°æ®æ—¶ preview è®©ä½)ã€‚
  // å®žçŽ°æ–¹å¼æ˜¯ç½® XDT_SCHEDULER_PASSIVE=1,ç» devEnvPrefix ç™½åå•é€ä¼ è¿›æ–°å¼€çš„
  // ç³»ç»Ÿç»ˆç«¯ / ç›´æŽ¥ spawn çš„ dev è¿›ç¨‹ã€‚
  if (startupConfig && (argv.includes('--passive') || preserveRunning)) {
    process.env.XDT_SCHEDULER_PASSIVE = '1';
    console.log(
      preserveRunning
        ? '==> Preserve-running preview: existing Cindy processes stay alive; this instance shares login/data and will not auto-fire schedules.'
        : '==> Scheduler passive mode: this instance will not auto-fire schedules.',
    );
  }
  // --endpoints-cdn: dev ä¸è¯»ä»“å†… config/endpoint.json,æ”¹èµ°ä¸Ž packaged ç›¸åŒçš„
  // çº¿ä¸Š CDN ç«¯ç‚¹æ¸…å•æ‹‰å–é“¾è·¯(æµ‹çº¿ä¸Šæ¸…å•)ã€‚å®žçŽ°æ–¹å¼æ˜¯ç½® XDT_ENDPOINTS_CDN=1,
  // ç» devEnvPrefix ç™½åå•é€ä¼ ,ä¸»è¿›ç¨‹ devCliFlags/clientEndpointsService æ¶ˆè´¹ã€‚
  // æ³¨æ„ local æ¨¡å¼çš„ endpoint.local.json ç”Ÿæˆä¸åœ¨æœ¬è„šæœ¬â€”â€”dev(local)è„šæœ¬é“¾é‡Œçš„
  // apps/desktop/scripts/dev-local-env.mjs ç»Ÿä¸€è´Ÿè´£(human ç›´è·‘ä¸Ž restart åŒè·¯å¾„)ã€‚
  if (startupConfig?.endpointsCdn) {
    console.log(`==> Endpoints via CDN: dev will fetch the ${startupConfig.region} online endpoint manifest.`);
  } else if (startupConfig && mode === 'remote' && startupConfig.endpointManifestFile) {
    console.log(`==> Endpoint manifest: ${startupConfig.endpointManifestFile}`);
  }
  // --isolated[=<åå­—>]: dev ä½¿ç”¨ç‹¬ç«‹çš„ userData ç›®å½•(æ•°æ®åº“/ç™»å½•æ€/ä¼šè¯å…¨éƒ¨ä¸Ž
  // æ­£å¼ç‰ˆéš”ç¦»,é¦–æ¬¡è¦é‡æ–°ç™»å½• Cindy è´¦å·)ã€‚ä¸å¸¦åå­— = å½“å‰åŒºåŸŸé»˜è®¤æ²™ç®±;
  // å¸¦åå­— = åœ¨åŒºåŸŸæ²™ç®±ååŽè¿½åŠ  `-<åå­—>`,æ¯ä¸ªåå­—ä¸€æ¡,å¯åŒæ—¶å¤šå¼€ã€‚
  // å®žçŽ°:ç½® XDT_USER_DATA_DIR(ä¸»è¿›ç¨‹å…¥å£åªåœ¨éž packaged æ—¶åº”ç”¨,è§
  // apps/desktop/src/main/index.ts),ç» devEnvPrefix ç™½åå•é€ä¼ ç»™ dev è¿›ç¨‹ã€‚
  // å·²æ‰‹åŠ¨è®¾äº† XDT_USER_DATA_DIR æ—¶å°Šé‡ç”¨æˆ·çš„å€¼,ä¸è¦†ç›–ã€‚
  // åŒæ—¶ç½® XDT_ISOLATED=1(å¼€å…³)+ XDT_ISOLATED_NAME(åå­—,å¯é€‰)æŠŠéš”ç¦»æ„å›¾å¸¦è¿›
  // ä¸»è¿›ç¨‹â€”â€”å¼€å…³ä¸Žåå­—åˆ†ç¦»,åå« "1" çš„æ²™ç®±ä¸ä¼šæ’žå¼€å…³æ ‡è®°å€¼(codex review P2)ã€‚
  // ä¸»è¿›ç¨‹æ®æ­¤æ´¾ç”Ÿç‹¬ç«‹ deviceId(dev-[<åå­—>-]<æœºå™¨æŒ‡çº¹>,æœºå™¨æŒ‡çº¹åªæœ‰ä¸»è¿›ç¨‹èƒ½å–)
  // â€”â€”æœåŠ¡ç«¯ç™»å½•å‡­è¯æŒ‰ (user, device) ä¸€å¯¹ä¸€å­˜,ä¸æ´¾ç”Ÿçš„è¯æ²™ç®±ç™»å½•ä¼šè¦†ç›–æ­£å¼ç‰ˆ
  // çš„ç»­æœŸå‡­è¯,åŒæœºäº’è¸¢ã€‚
  if (startupConfig && isolatedArg) {
    if (isolationName && !/^[A-Za-z0-9_-]{1,32}$/.test(isolationName)) {
      exitWithFailure(
        'INVALID_ISOLATED_NAME',
        `Invalid --isolated name: "${isolationName}"`,
        [
          `==> Invalid --isolated name: "${isolationName}"`,
          '    Allowed: letters / digits / _ / -, max 32 chars. e.g. --isolated=feature-a',
        ],
      );
    }
    process.env.XDT_ISOLATED = '1';
    if (isolationName) process.env.XDT_ISOLATED_NAME = isolationName;
    if (!process.env.XDT_USER_DATA_DIR) {
      process.env.XDT_USER_DATA_DIR = defaultIsolatedUserDataDir(isolationName, selectedRegion);
      // å¯ä¿¡çºªå…ƒä¿¡å·:ä»…å½“ç›®å½•ç”±æœ¬è„šæœ¬æŒ‰ -dev2 çºªå…ƒæ´¾ç”Ÿæ—¶æºå¸¦,ä¸»è¿›ç¨‹æ®æ­¤å…è®¸
      // æ˜¾å¼ env è¦†å†™å‘½ä¸­çºªå…ƒåˆ¤å®šã€‚ç”¨æˆ·æ‰‹åŠ¨è®¾ XDT_USER_DATA_DIR(ä¸Šé¢çš„åˆ†æ”¯ä¸
      // è¿›å…¥)æˆ–æ—§ checkout å¯åŠ¨éƒ½ä¸å¸¦è¯¥ä¿¡å· â†’ è§‚å¯Ÿæ¨¡å¼,é˜²æ—§ä»£ç å¯¹åŒä¸€æ˜¾å¼
      // è·¯å¾„ä»¥é»˜è®¤èº«ä»½æ‰“å¼€é€ æˆåŒèº«ä»½äº’å†™(#912 review P1)ã€‚
      process.env.XDT_USER_DATA_DIR_EPOCH = '1';
      userDataDerivedByRestart = true;
    }
  }
  // --isolated-auth: æ²™ç®±å‡­è¯éš”ç¦» â€”â€” å¯åŠ¨æ—¶æ¸…æŽ‰æœ¬æ²™ç®±æ—§ auth(å…±äº«ç¡¬é“¾ä¸Žç‹¬ç«‹å­¤å²›
  // éƒ½å¤„ç†),å†æ˜¾å¼å…è®¸æ²™ç®±è‡ªå·±çš„ OAuth å†™å…¥ï¼›æ­£å¼å®žä¾‹ä¸Žæœ¬æœº CLI å‡­è¯ä¸å—å½±å“ã€‚
  // éš”ç¦»æ²™ç®±é‡Œæµ‹ç™»å½•æµç¨‹æ—¶å¿…ç”¨:å…±äº«ç¡¬é“¾ä¸‹æ²™ç®±ç™»å½•ä¼šæ”¹å†™å…±ç”¨å‡­è¯æ–‡ä»¶,æŠŠæ­£å¼ç‰ˆ
  // ä¸€èµ·é€€ç™»(2026-08-13 å®žæµ‹)ã€‚å®žçŽ°:ç½® XDT_ISOLATED_AUTH=1,ç» devEnvPrefix
  // ç™½åå•é€ä¼ ,maker-host auth-adapters æ¶ˆè´¹(ä»…éž packaged ç”Ÿæ•ˆ)ã€‚
  if (startupConfig && argv.includes('--isolated-auth')) {
    if (!isolatedArg) {
      exitWithFailure(
        'INVALID_ISOLATED_NAME',
        '--isolated-auth requires --isolated: shared userData must not isolate credentials alone',
        ['==> --isolated-auth requires --isolated: å…±äº« userData çš„å®žä¾‹ä¸è¯¥å•ç‹¬éš”ç¦»å‡­è¯'],
      );
    }
    if (!isTrustedIsolatedAuthUserDataDir({
      isolatedArg,
      userDataDir: process.env.XDT_USER_DATA_DIR,
      userDataDirEpoch: process.env.XDT_USER_DATA_DIR_EPOCH,
      userDataDerivedByRestart,
      selectedRegion,
    })) {
      exitWithFailure(
        'STARTUP_FAILED',
        '--isolated-auth requires a userData sandbox derived by this restart invocation',
        [
          '==> Refusing --isolated-auth for an inherited or explicit XDT_USER_DATA_DIR.',
          '    Unset XDT_USER_DATA_DIR and retry with --isolated-auth --isolated[=<name>].',
        ],
      );
    }
    process.env.XDT_ISOLATED_AUTH = '1';
    process.env.XDT_ALLOW_DEV_OAUTH_WRITE = '1';
    isolatedAuthAuthorizedByRestart = true;
    console.log('==> Isolated auth: this sandbox will NOT share codex OAuth credentials with ~/.codex.');
  }
  if (startupConfig) ensureDesktopEnv();

  const checkoutPaths = repositoryWorktreePaths();
  const belongsToThisCheckout = (proc) => commandBelongsToCheckout(proc.command, rootDir, checkoutPaths);
  const devAncestor = findDevAncestor();
  if (shouldRefuseHostedRestart(devAncestor, {
    preserveRunning,
    ownRootDir: rootDir,
    isolated: hasIsolationIntent(argv, process.env),
    checkoutPaths,
  })) {
    const refusal = hostedRestartRefusal(devAncestor, { ownRootDir: rootDir, checkoutPaths });
    exitWithFailure(
      refusal.code,
      refusal.message,
      [
        `==> ${refusal.message}`,
        `    ancestor pid ${devAncestor.pid}: ${devAncestor.command.slice(0, 180)}`,
        refusal.code === 'HOSTED_RESTART_REFUSED'
          ? '==> Ask the user to restart from the official Cindy app, another worktree, or an external terminal.'
          : '==> Use --isolated=@worktree, or --preserve-running if you explicitly want shared login.',
      ],
    );
  }
  if (devAncestor && !preserveRunning && isolatedArg) {
    console.log(
      `==> Hosted by another checkout's desktop dev pid ${devAncestor.pid}; this isolated restart will not stop that host.`,
    );
  }
  if (devAncestor && preserveRunning) {
    if (replaceRunningRoot && commandContainsPath(devAncestor.command, replaceRunningRoot)) {
      throw new Error(
        `Refusing to replace ${replaceRunningRoot}: the current command is hosted by that dev process tree`,
      );
    }
    console.log(
      `==> Current session is hosted by Cindy desktop dev pid ${devAncestor.pid}; preserving that process tree.`,
    );
  }

  // userData å†²çªé—¨:ç›®æ ‡ userData å·²è¢«å…¶ä»– checkout çš„ dev å®žä¾‹å ç”¨æ—¶ä¸­æ­¢ã€‚
  // æ€æŽ‰åˆ«äºº(æ—§å…¨ç­è¡Œä¸º)ä¼šé¡¶æŽ‰ç”¨æˆ·å¹¶è¡Œè°ƒè¯•ä¸­çš„æ²™ç®±;å…±ç”¨åŒä¸€ä»½ userData å¹¶è¡Œ
  // åˆä¼šæ’ž SQLite / ç™»å½•æ€ã€‚ä¸¤éš¾ä¹‹ä¸‹å”¯ä¸€å®‰å…¨è§£æ˜¯åœä¸‹æ¥è®©ç”¨æˆ·å†³å®š:æ¢ä¸€ä¸ª
  // --isolated åå­—,æˆ–ç”¨æˆ·è‡ªå·±åœæŽ‰é‚£ä¸ªå®žä¾‹ã€‚preserve-running ä¸è¿›æ­¤é—¨ â€”â€”
  // å®ƒçš„è¯­ä¹‰å°±æ˜¯å…±äº« userData çš„è¢«åŠ¨é¢„è§ˆã€‚æ£€æµ‹æ˜¯å°½åŠ›è€Œä¸º:é  helper è¿›ç¨‹å‘½ä»¤è¡Œ
  // ä¸Šçš„ --user-data-dir,å¯¹æ–¹å®žä¾‹åˆšå¯åŠ¨è¿˜æ²¡èµ· helper æ—¶å¯èƒ½æ¼æ£€ã€‚
  const targetUserDataDir = resolveRestartTargetUserDataDir({
    envUserDataDir: process.env.XDT_USER_DATA_DIR,
    isolatedArg,
    isolatedEnv: process.env.XDT_ISOLATED,
    isolatedName: process.env.XDT_ISOLATED_NAME,
    selectedRegion,
  });
  if (
    hasIsolationIntent(argv, process.env)
    && isOfficialProductionUserDataDir(targetUserDataDir)
  ) {
    throw new Error(
      `--isolated cannot use the official Cindy profile (${targetUserDataDir}). ` +
        'Omit XDT_USER_DATA_DIR, or point it at a sandbox directory.',
    );
  }
  if (startupConfig && hasIsolationIntent(argv, process.env)) {
    if (!process.env.XDT_USER_DATA_DIR) {
      process.env.XDT_USER_DATA_DIR = targetUserDataDir;
      process.env.XDT_USER_DATA_DIR_EPOCH = '1';
    }
    fs.mkdirSync(process.env.XDT_USER_DATA_DIR, { recursive: true });
    const isolationName = isolatedArg
      ? parseIsolationName(isolatedArg)
      : (process.env.XDT_ISOLATED_NAME || '');
    console.log(`==> Isolated dev user data${isolationName ? ` (sandbox "${isolationName}")` : ''}: ${process.env.XDT_USER_DATA_DIR}`);
  }
  if (!preserveRunning) {
    const conflicts = listDesktopDevProcesses().filter(
      (proc) => !belongsToThisCheckout(proc)
        && commandUsesUserDataDir(proc.command, targetUserDataDir),
    );
    if (conflicts.length > 0) {
      exitWithFailure(
        'USERDATA_IN_USE',
        `Target userData is already in use by another checkout's dev instance: ${targetUserDataDir}`,
        [
          `==> Target userData is already in use by another checkout's dev instance: ${targetUserDataDir}`,
          ...conflicts.map((proc) => `    pid ${proc.pid}: ${proc.command.slice(0, 180)}`),
          '==> Refusing to stop processes outside this checkout. Pick a different sandbox',
          '    name (--isolated=<name>), or stop that instance yourself and re-run.',
        ],
      );
    }
  } else {
    const compatibility = inspectSharedUserDataRegion(
      targetUserDataDir,
      selectedRegion,
      listDesktopDevProcesses(),
    );
    if (!compatibility.compatible) {
      throw new Error(
        `--preserve-running cannot safely share ${targetUserDataDir}: ${compatibility.reason}. ` +
          'Restart the existing instance with the same region, or use an isolated sandbox.',
      );
    }
  }

  const allTargets = listDesktopDevProcesses();
  // kill ä½œç”¨åŸŸ = å½“å‰ checkoutã€‚å…¶ä»– worktree / å‘½åæ²™ç®±çš„å®žä¾‹ä¸€å¾‹ä¿ç•™ã€‚
  const ownScope = partitionDesktopDevProcesses(allTargets, rootDir, checkoutPaths);
  const targets = replaceRunningRoot
    ? allTargets.filter((proc) => commandContainsPath(proc.command, replaceRunningRoot))
    : ownScope.targets;
  const darwinTerminalTtys = darwinTerminalTtysForProcesses(targets);

  if (!preserveRunning && !replaceRunningRoot && ownScope.preserved.length > 0) {
    console.log(
      `==> Preserving ${ownScope.preserved.length} Cindy desktop dev process(es) from other checkouts; this restart only touches ${rootDir}.`,
    );
  }

  if (preserveRunning && !replaceRunningRoot) {
    console.log(
      `==> Preserving ${allTargets.length} existing Cindy desktop dev process(es); the preview will start alongside them in passive mode.`,
    );
  } else if (replaceRunningRoot) {
    console.log(
      `==> Preserving ${allTargets.length - targets.length} other Cindy desktop dev process(es); replacing only ${replaceRunningRoot}.`,
    );
    if (targets.length === 0) {
      console.log('==> No running desktop dev processes were found for the requested replacement root.');
    } else {
      console.log(`==> Stopping ${targets.length} desktop dev process(es) from the requested replacement root...`);
      for (const target of targets) {
        console.log(`    kill ${target.pid}: ${target.command.slice(0, 180)}`);
        killProcess(target.pid);
      }

      const matchesReplacementRoot = (proc) => commandContainsPath(proc.command, replaceRunningRoot);
      const remainingForRoot = await waitForDesktopDevProcessesToExit(
        gracefulTimeoutMs,
        matchesReplacementRoot,
      );
      if (remainingForRoot.length > 0) {
        console.log(`==> Force stopping ${remainingForRoot.length} stubborn process(es) from the replacement root...`);
        for (const target of remainingForRoot) {
          console.log(`    ${forceKillLabel} ${target.pid}: ${target.command.slice(0, 180)}`);
          forceKillProcess(target.pid);
        }
      }

      const remainingAfterForce = await waitForDesktopDevProcessesToExit(
        forceTimeoutMs,
        matchesReplacementRoot,
      );
      if (remainingAfterForce.length > 0) {
        exitWithFailure(
          'STARTUP_FAILED',
          `Failed to stop ${remainingAfterForce.length} process(es) from ${replaceRunningRoot}; aborting restart.`,
          [
            `==> Failed to stop ${remainingAfterForce.length} process(es) from ${replaceRunningRoot}; aborting restart.`,
            ...remainingAfterForce.map((target) => `    still running ${target.pid}: ${target.command.slice(0, 180)}`),
          ],
        );
      }

      closeDarwinTerminalTtys(darwinTerminalTtys);
    }
  } else if (targets.length === 0) {
    console.log('==> No existing Cindy desktop dev processes found for this checkout.');
  } else {
    console.log(`==> Stopping ${targets.length} existing Cindy desktop dev process(es) from this checkout...`);
    for (const target of targets) {
      console.log(`    kill ${target.pid}: ${target.command.slice(0, 180)}`);
      killProcess(target.pid);
    }

    // ç­‰å¾…/å¼ºæ€åŒæ ·é™å®šåœ¨æœ¬ checkout â€”â€” ä¸å¸¦è¿‡æ»¤å™¨ä¼šæŠŠå…¶ä»– checkout ä»åœ¨è·‘çš„
    // å®žä¾‹å½“æˆ"é¡½å›ºè¿›ç¨‹"é€ä¸ª SIGKILL æŽ‰ã€‚
    const matchesOwnRoot = belongsToThisCheckout;
    const remainingAfterTerm = await waitForDesktopDevProcessesToExit(gracefulTimeoutMs, matchesOwnRoot);
    if (remainingAfterTerm.length > 0) {
      console.log(`==> Force stopping ${remainingAfterTerm.length} stubborn Cindy desktop dev process(es)...`);
      for (const target of remainingAfterTerm) {
        console.log(`    ${forceKillLabel} ${target.pid}: ${target.command.slice(0, 180)}`);
        forceKillProcess(target.pid);
      }
    }

    const remainingAfterForce = await waitForDesktopDevProcessesToExit(forceTimeoutMs, matchesOwnRoot);
    if (remainingAfterForce.length > 0) {
      exitWithFailure(
        'STARTUP_FAILED',
        `Failed to stop ${remainingAfterForce.length} Cindy desktop dev process(es); aborting restart.`,
        [
          `==> Failed to stop ${remainingAfterForce.length} Cindy desktop dev process(es); aborting restart.`,
          ...remainingAfterForce.map((target) => `    still running ${target.pid}: ${target.command.slice(0, 180)}`),
        ],
      );
    }

    closeDarwinTerminalTtys(darwinTerminalTtys);
  }

  if (killOnly) return;

  if (!preserveRunning) clearDesktopDevCaches(rootDir);

  let startupStatusPath = null;
  if (waitReady) {
    startupStatusPath = createStartupStatusPath();
    writeDesktopStartupStatus(startupStatusPath, { state: 'pending', at: Date.now() });
    process.env.XDT_DESKTOP_DEV_STARTUP_STATUS_FILE = startupStatusPath;
  }
  if (isolatedAuthAuthorizedByRestart) {
    process.env.XDT_ISOLATED_AUTH_PROOF = createIsolatedAuthLaunchProof({
      userDataDir: process.env.XDT_USER_DATA_DIR,
      isolationName: process.env.XDT_ISOLATED_NAME || '',
    });
  }
  const terminalLogPath = startDesktopDev(mode);
  // æ‰€æœ‰éž ready çš„ç»“è®ºï¼ˆå¯åŠ¨å¤±è´¥ã€è¶…æ—¶ã€ready åŽè¿›ç¨‹é€€å‡ºå¯¼è‡´çš„ WHOAMI_MISMATCHï¼‰
  // éƒ½å…ˆæ‰“å°ç»ˆç«¯æ—¥å¿—æœ«å°¾ï¼Œå¹¶åœ¨ verdict é‡Œå¸¦ä¸Š log=ã€‚
  const printFailedVerdict = (verdict) => {
    const logTail = terminalLogPath ? readDesktopDevLogTail(terminalLogPath) : [];
    if (logTail.length > 0) {
      console.error(`==> Last ${logTail.length} lines of ${terminalLogPath}:`);
      for (const line of logTail) console.error(`    ${line}`);
    }
    printDesktopDevVerdict(terminalLogPath ? { ...verdict, log: terminalLogPath } : verdict);
  };
  if (startupStatusPath) {
    try {
      await waitForDesktopStartup(startupStatusPath);
      const report = collectDesktopWhoamiReport({
        rootDir,
        userDataDir: process.env.XDT_USER_DATA_DIR,
      });
      const verdict = buildDesktopDevVerdictFromWhoami(report, verdictContext);
      if (verdict.state !== 'ready') {
        printFailedVerdict(verdict);
        process.exit(1);
      }
      printDesktopDevVerdict(verdict);
    } catch (error) {
      printFailedVerdict(buildDesktopDevVerdictFromFailure(error, verdictContext));
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    printDesktopDevVerdict(buildDesktopDevVerdictFromFailure(error, {
      rootDir,
      ...restartContextFromArgv(process.argv.slice(2)),
    }));
    console.error(error);
    process.exit(1);
  });
}

