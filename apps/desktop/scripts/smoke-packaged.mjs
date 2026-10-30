#!/usr/bin/env node

/**
 * smoke-packaged.mjs â€” æ‰“åŒ…äº§ç‰©çš„ç«¯åˆ°ç«¯ smoke æµ‹è¯•ï¼ˆrelease åŽç½®éªŒæ”¶ï¼‰ã€‚
 *
 * å¯åŠ¨ packaged Electron exeï¼ŒåŠ ä¸Š `--smoke-test` flagï¼šmain è¿›ç¨‹åœ¨ `app.on('ready')`
 * é‡Œèµ° short-circuit åˆ†æ”¯ï¼Œè·‘ `ensureReady(fakeUserId)`ã€æŸ¥ `schema_version` + ä¸‰å¼ æ ¸å¿ƒè¡¨
 * çš„è¡Œæ•°ï¼ŒæŠŠç»“æžœ JSON è¾“å‡ºåˆ° stdout åŽ `app.quit()`ã€‚
 *
 * ç”¨æ³•ï¼š
 *   node scripts/smoke-packaged.mjs --platform=win32 --arch=x64
 *   node scripts/smoke-packaged.mjs --platform=darwin --arch=arm64
 *   node scripts/smoke-packaged.mjs --platform=darwin --arch=x64 --out-dir=custom/path
 *
 * éªŒæ”¶æ ‡å‡†ï¼š
 *   - å­è¿›ç¨‹ 60s å†…æ­£å¸¸é€€å‡ºï¼ˆexit code = 0ï¼‰
 *   - stdout çš„ JSON èƒ½è§£æžä¸” `ok: true`
 *   - `schema_version >= 0`
 *   - `tables.sessions / tables.messages / tables.migration_meta` ä¸‰ä¸ª count éƒ½ â‰¥ 0
 *
 * ä»»ä¸€å¤±è´¥ â†’ æ‰“å°è¯Šæ–­å¹¶ exit(1)ï¼›æˆåŠŸ â†’ æ‰“å° `âœ… smoke test passed`ã€‚
 *
 * é€€å‡ºå‰æ¸…ç†ä¸´æ—¶ userData ç›®å½•ï¼ˆä¸ç•™åžƒåœ¾ï¼‰ã€‚
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DESKTOP_ROOT = path.resolve(__dirname, '..');

/**
 * electron-forge æ‰“åŒ…äº§ç‰©åŸºåé»˜è®¤å€¼(out ç›®å½• / exe / .app / linux äºŒè¿›åˆ¶åŒå)ã€‚
 * âš ï¸ å€¼å¿…é¡»ä¸Ž packages/maker-shared/src/brandIdentity.ts çš„
 * BRAND_IDENTITY.executableName åŠ ci/lib.mjs çš„ PACKAGED_APP_NAME ä¸€è‡´
 * (æœ¬è„šæœ¬åˆ»æ„é›¶å¤–éƒ¨ä¾èµ–,ä¸ import lib.mjs;ä¸€è‡´æ€§ç”±
 * scripts/__tests__/brand-identity-sync.test.mjs æ–­è¨€å…œåº•)ã€‚
 * åŒºåŸŸåŒ–:äº§ç‰©åŸºåæŒ‰åŒºåŸŸæ´¾ç”Ÿ(cn/global 'Cindy' / dev 'CindyDev'),ç”±è°ƒç”¨æ–¹
 * (ci/lib.mjs runSmokeTest)ç» --app-name= ä¼ å…¥è¦†ç›–,æœ¬é»˜è®¤å€¼æœåŠ¡ global / æ‰‹è·‘ã€‚
 */
const PACKAGED_APP_NAME = 'Echo';

// â”€â”€ Arg parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseArgs() {
  const args = process.argv.slice(2);
  /** @type {Record<string, string>} */
  const out = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  const platform = out.platform || process.platform;
  const arch = out.arch || process.arch;
  const outDir = out['out-dir'] || null;
  const appName = out['app-name'] || PACKAGED_APP_NAME;
  const pluginStorage = args.includes('--plugin-storage');
  return { platform, arch, outDir, appName, pluginStorage };
}

const { platform, arch, outDir, appName, pluginStorage } = parseArgs();

if (!['win32', 'darwin', 'linux'].includes(platform)) {
  console.error(`[smoke] ERROR: unsupported --platform=${platform}`);
  process.exit(1);
}
if (!['x64', 'arm64'].includes(arch)) {
  console.error(`[smoke] ERROR: unsupported --arch=${arch}`);
  process.exit(1);
}

console.log(`[smoke] platform=${platform} arch=${arch}`);

// â”€â”€ Locate packaged executable â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * electron-forge æŠŠ packaged åº”ç”¨æ”¾åœ¨ `out/<PACKAGED_APP_NAME>-<platform>-<arch>/`ã€‚
 * å…¥å£ exe ä½ç½®ï¼š
 *   - Windows: <packaged>/<PACKAGED_APP_NAME>.exe
 *   - macOS:   <packaged>/<PACKAGED_APP_NAME>.app/Contents/MacOS/<PACKAGED_APP_NAME>
 *   - Linux:   <packaged>/<PACKAGED_APP_NAME>
 */
function resolveExePath() {
  const baseDir = outDir
    ? path.resolve(outDir)
    : path.join(DESKTOP_ROOT, 'out', `${appName}-${platform}-${arch}`);
  if (!fs.existsSync(baseDir)) {
    console.error(`[smoke] ERROR: packaged dir not found: ${baseDir}`);
    console.error(`[smoke]        run 'pnpm --filter ./apps/desktop package' first, or pass --out-dir=<path>`);
    process.exit(1);
  }
  if (platform === 'win32') {
    const exe = path.join(baseDir, `${appName}.exe`);
    if (!fs.existsSync(exe)) {
      console.error(`[smoke] ERROR: ${appName}.exe not found under ${baseDir}`);
      process.exit(1);
    }
    return exe;
  }
  if (platform === 'darwin') {
    const exe = path.join(baseDir, `${appName}.app`, 'Contents', 'MacOS', appName);
    if (!fs.existsSync(exe)) {
      console.error(`[smoke] ERROR: ${appName} binary not found at ${exe}`);
      process.exit(1);
    }
    return exe;
  }
  // linux
  const exe = path.join(baseDir, appName);
  if (!fs.existsSync(exe)) {
    console.error(`[smoke] ERROR: ${appName} binary not found at ${exe}`);
    process.exit(1);
  }
  return exe;
}

const exePath = resolveExePath();
console.log(`[smoke] exe: ${exePath}`);

// ARM64 macOS host ä¸Šæ— æ³•é€šè¿‡ Rosetta å¯é è¿è¡Œ x64 Electronï¼ˆChromium 131+ SIGILLï¼‰ã€‚
// è·³è¿‡å‰éªŒè¯ï¼šäº§ç‰©å­˜åœ¨ï¼ˆresolveExePathï¼‰+ å¯æ‰§è¡Œ + ç¡®å®žæ˜¯ x86_64 Mach-Oã€‚
// ç”¨ sysctl hw.optional.arm64 æ£€æµ‹ç‰©ç† CPUï¼ˆå³ä½¿å½“å‰è¿›ç¨‹è·‘åœ¨ Rosetta ä¸‹ä¹Ÿè¿”å›ž 1ï¼‰ã€‚
if (platform === 'darwin' && arch === 'x64') {
  let isPhysicalArm64 = false;
  try {
    isPhysicalArm64 = execSync('sysctl -in hw.optional.arm64', { encoding: 'utf-8' }).trim() === '1';
  } catch { /* sysctl å¤±è´¥ï¼ˆå¦‚ Intel Mac unknown oidï¼‰â†’ ä¸æ˜¯ ARM64ï¼Œç»§ç»­æ­£å¸¸ smoke */ }

  if (isPhysicalArm64) {
    try {
      fs.accessSync(exePath, fs.constants.X_OK);
      const archInfo = execFileSync('lipo', ['-archs', exePath], { encoding: 'utf-8' }).trim();
      if (!archInfo.includes('x86_64')) {
        console.error(`[smoke] FAIL: expected x86_64 binary but got: ${archInfo}`);
        process.exit(1);
      }
      console.log(`[smoke] SKIP: x64 Electron launch on arm64 host (binary verified: ${archInfo})`);
      console.log('âœ… smoke test skipped (packaged x86_64 binary verified)');
      process.exit(0);
    } catch (err) {
      console.error(`[smoke] FAIL: binary verification failed: ${err.message}`);
      process.exit(1);
    }
  }
}

// â”€â”€ Temp userData dir â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-smoke-'));
console.log(`[smoke] userData: ${tmpUserData}`);

function cleanupUserData() {
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[smoke] WARN: cleanup ${tmpUserData} failed: ${err instanceof Error ? err.message : err}`);
  }
}

// â”€â”€ Spawn & capture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SMOKE_USER = '__smoke_test__';
const TIMEOUT_MS = 60_000;

const child = spawn(
  exePath,
  [
    '--smoke-test',
    `--smoke-user=${SMOKE_USER}`,
    ...(pluginStorage ? ['--smoke-plugin-storage'] : []),
    `--user-data-dir=${tmpUserData}`,
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // ç¦ç”¨è‡ªåŠ¨æ›´æ–° / Windows Squirrel startup é’©å­ï¼ˆsmoke è·‘çš„æ˜¯å·²å®‰è£…çš„ exeï¼Œ
      // ä½†ä¸ºäº†ç¨³å¦¥è¿™é‡Œä¹Ÿæ˜¾å¼æ¸…æŽ‰ä¼šå½±å“å¯åŠ¨çš„çŽ¯å¢ƒå˜é‡ï¼‰
      ELECTRON_DISABLE_SANDBOX: '1',
    },
  },
);

let stdoutBuf = '';
let stderrBuf = '';

child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString();
});

const timeoutHandle = setTimeout(() => {
  console.error(`[smoke] ERROR: timeout after ${TIMEOUT_MS}ms, killing process`);
  try { child.kill('SIGKILL'); } catch { /* noop */ }
}, TIMEOUT_MS);

child.on('exit', (code, signal) => {
  clearTimeout(timeoutHandle);
  const exitLabel = signal ? `signal=${signal}` : `code=${code}`;
  console.log(`[smoke] child exited: ${exitLabel}`);

  if (stderrBuf.trim()) {
    console.log('[smoke] --- stderr ---');
    console.log(stderrBuf.trim());
    console.log('[smoke] ---');
  }
  if (stdoutBuf.trim()) {
    console.log('[smoke] --- stdout ---');
    console.log(stdoutBuf.trim());
    console.log('[smoke] ---');
  }

  // è§£æžæœ€åŽä¸€è¡Œ JSONï¼ˆstdout å¯èƒ½å¤¹æ‚ Electron / Chromium çš„é¢„çƒ­æ—¥å¿—ï¼‰
  const jsonLine = extractJsonLine(stdoutBuf) || extractJsonLine(stderrBuf);
  if (!jsonLine) {
    console.error('[smoke] FAIL: no JSON result line found in stdout/stderr');
    cleanupUserData();
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonLine);
  } catch (err) {
    console.error(`[smoke] FAIL: JSON parse error: ${err instanceof Error ? err.message : err}`);
    console.error(`[smoke]       line: ${jsonLine}`);
    cleanupUserData();
    process.exit(1);
  }

  // éªŒæ”¶
  if (parsed.ok !== true) {
    console.error(`[smoke] FAIL: main reported ok=false, error=${parsed.error || '(none)'}`);
    cleanupUserData();
    process.exit(1);
  }
  if (typeof parsed.schema_version !== 'number' || parsed.schema_version < 0) {
    console.error(`[smoke] FAIL: schema_version invalid: ${parsed.schema_version}`);
    cleanupUserData();
    process.exit(1);
  }
  const t = parsed.tables || {};
  for (const key of ['sessions', 'messages', 'migration_meta']) {
    const v = t[key];
    if (typeof v !== 'number' || v < 0) {
      console.error(`[smoke] FAIL: tables.${key} invalid: ${v}`);
      cleanupUserData();
      process.exit(1);
    }
  }
  if (pluginStorage) {
    const storage = parsed.plugin_storage || {};
    if (storage.ownerGhostFound !== true) {
      console.error('[smoke] FAIL: owner Plugin was not found after signed-out startup recovery');
      cleanupUserData();
      process.exit(1);
    }
    if (storage.ledgerInstalledAfterEmptySnapshot !== true) {
      console.error('[smoke] FAIL: passive empty snapshot changed installed ledger state');
      cleanupUserData();
      process.exit(1);
    }
    if (storage.optOutAfterEmptySnapshot !== false) {
      console.error('[smoke] FAIL: passive empty snapshot wrote a default-install opt-out');
      cleanupUserData();
      process.exit(1);
    }
  }
  if (code !== 0) {
    console.error(`[smoke] FAIL: child exit code ${code} (expected 0)`);
    cleanupUserData();
    process.exit(1);
  }

  console.log(
    `âœ… smoke test passed: schema_version=${parsed.schema_version}, ` +
      `sessions=${t.sessions}, messages=${t.messages}, migration_meta=${t.migration_meta}` +
      (pluginStorage ? ', plugin_storage=passed' : ''),
  );
  cleanupUserData();
  process.exit(0);
});

child.on('error', (err) => {
  clearTimeout(timeoutHandle);
  console.error(`[smoke] FAIL: spawn error: ${err.message}`);
  cleanupUserData();
  process.exit(1);
});

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * ä»Žæ··åˆè¾“å‡ºä¸­æŒ‘å‡ºæœ€åŽä¸€è¡Œä»¥ `{` å¼€å¤´ `}` ç»“å°¾çš„ JSON è¡Œã€‚
 * @param {string} buf
 * @returns {string | null}
 */
function extractJsonLine(buf) {
  const lines = buf.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith('{') && line.endsWith('}')) {
      return line;
    }
  }
  return null;
}

