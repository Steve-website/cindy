// =============================================================================
// å…±äº«å·¥å…·åº“ â€” CI æž„å»º/å‘å¸ƒè„šæœ¬é€šç”¨é€»è¾‘
//
// è¿™é‡Œåªæ”¾çº¯è¾…åŠ©å‡½æ•°ï¼šå“ˆå¸Œã€åŽ‹ç¼©ã€OSSã€CDN manifestã€drizzle æ ¡éªŒã€ç‰ˆæœ¬å·å†™å…¥ç­‰ã€‚
// ä¸»æµç¨‹é€»è¾‘ç”± build-* / publish-* å„è‡ªè´Ÿè´£ã€‚
// =============================================================================

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// createGunzip / pipeline ä¾›ä¸‹æ–¹ immutable-guard ä¸‹è½½å¤æ ¸ç”¨;sha256 / gzipFile / OSS åŽŸè¯­
// å·²æŠ½åˆ° scripts/shared/oss.mjs(ä¸‹æ–¹ re-export),æ•…ä¸å†æœ¬åœ° import crypto / createGzipã€‚
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { resolveReleaseCdnBaseUrl } from '../../../../scripts/shared/release-env.mjs';
// OSS/CDN åŽŸè¯­(sha256 / gzip / ali-oss client / upload)å·²æŠ½åˆ°ä»“åº“æ ¹ scripts/shared/oss.mjs,
// ä¾› desktop ä¸Ž mobile å…±ç”¨;è¿™é‡Œ re-export ä¿æŒæ—¢æœ‰ import é¢(CDN_BASE / createOSSClient ç­‰)ä¸å˜ã€‚
import {
  CDN_BASE,
  OSS_BUCKET,
  OSS_PREFIX,
  OSS_REGION,
  resolveOssConfig,
  resolveOssCredentials,
  resolveReleaseRegion,
  refreshOssConfig,
  sha256,
  gzipFile,
  createOSSClient,
  uploadToOSS,
} from '../../../../scripts/shared/oss.mjs';

export {
  CDN_BASE,
  OSS_BUCKET,
  OSS_PREFIX,
  OSS_REGION,
  resolveOssConfig,
  resolveOssCredentials,
  resolveReleaseRegion,
  refreshOssConfig,
  sha256,
  gzipFile,
  createOSSClient,
  uploadToOSS,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = path.resolve(__dirname, '..');
export const DESKTOP_ROOT = path.resolve(SCRIPTS_DIR, '..');
export const PROJECT_ROOT = path.resolve(DESKTOP_ROOT, '../..');
export const RELEASE_DIR = path.join(DESKTOP_ROOT, 'release');

/**
 * electron-forge æ‰“åŒ…äº§ç‰©åŸºå(2026-07-17 å“ç‰Œç¿»è½¬ xdt-maker â†’ Cindy):
 *   - packaged ç›®å½•  out/<PACKAGED_APP_NAME>-<platform>-<arch>/
 *   - Windows exe    <packaged>/<PACKAGED_APP_NAME>.exe
 *   - macOS .app     <packaged>/<PACKAGED_APP_NAME>.app(Mach-O åŒå)
 *   - Linux äºŒè¿›åˆ¶   <packaged>/<PACKAGED_APP_NAME>
 * âš ï¸ å€¼å¿…é¡»ä¸Ž packages/maker-shared/src/brandIdentity.ts çš„
 * BRAND_IDENTITY.executableName(= apps/desktop/package.json productName)ä¸€è‡´
 * â€”â€”.mjs æ— æ³• import TS å•ç‚¹,åªèƒ½é•œåƒå­—é¢é‡;ä¸€è‡´æ€§ç”±
 * scripts/__tests__/brand-identity-sync.test.mjs æ–­è¨€å…œåº•ã€‚
 * âš ï¸ åªæè¿°ã€Œæœ¬åœ°æž„å»ºäº§ç‰©è·¯å¾„ã€ã€‚OSS/CDN æ¸ é“å‰ç¼€ä¸Žå‘å¸ƒäº§ç‰©æ–‡ä»¶å
 * (xdt-maker-<version>-Setup.exe / .dmg / .zip ç­‰)ä»ç•™åœ¨è€å€¼:æ–°æ¸ é“ bucket
 * æœªå°±ç»ª,å‘å¸ƒç›®æ ‡å¦è®®,ä¸éšæœ¬æ¬¡ç¿»è½¬ã€‚
 */
export const PACKAGED_APP_NAME = 'Echo';

/**
 * æŒ‰åŒºåŸŸå–æ‰“åŒ…äº§ç‰©åŸºå(exe / .app / å®‰è£…ç›®å½• / å¿«æ·æ–¹å¼å…¨éƒ¨è·Ÿéš)ã€‚
 * cn/global åŒå€¼ 'Cindy'(2026-07-26 æ˜¾ç¤ºåç»Ÿä¸€å†³ç­–,æ”¾å¼ƒæ–‡ä»¶å±‚åŒè£…éš”ç¦»),
 * dev ç‹¬ç«‹ã€‚é•œåƒ brandIdentity.ts çš„ executableNameByRegion,ä¸€è‡´æ€§ç”±
 * scripts/__tests__/brand-identity-sync.test.mjs æ–­è¨€å…œåº•ã€‚
 * PACKAGED_APP_NAME ä¿ç•™ä¸ºæ­£å¼ç‰ˆå…±åŒåŸºçº¿å€¼,ä¾›æœªä¼  region çš„ legacy è„šæœ¬ä½¿ç”¨ã€‚
 */
export const PACKAGED_APP_NAME_BY_REGION = Object.freeze({
  cn: 'Echo',
  global: 'Echo',
  dev: 'EchoDev',
});

export function packagedAppName(region = 'global') {
  const name = PACKAGED_APP_NAME_BY_REGION[region];
  if (!name) throw new Error(`unknown region: ${region}`);
  return name;
}

/**
 * å‘å¸ƒäº§ç‰©æ–‡ä»¶ååŸºå(å®‰è£…åŒ… / çƒ­æ›´ zip / OSS key é‡Œçš„æ–‡ä»¶å,ç”¨æˆ·ä¸‹è½½å¯è§)ã€‚
 * è€ 'xdt-maker-*' å‘½ååªå±žäºŽå·²å†»ç»“çš„ /xdt-maker æ¸ é“;æ–°æ¸ é“(2026-07-19 å®žæŸ¥
 * çŽ°ç½‘ manifest å…¨ 404,ä»Žé›¶èµ·æ­¥)ç»Ÿä¸€ç”¨ cindy å‘½å,ä¸Ž package-desktop.mjs çš„
 * æœ¬åœ°äº§ç‰©å‘½åå¯¹é½ã€‚
 */
export const RELEASE_ARTIFACT_BASENAME_BY_REGION = Object.freeze({
  cn: 'echo',
  global: 'echo',
  dev: 'echo-dev',
});

export function releaseArtifactBasename(region = 'global') {
  const name = RELEASE_ARTIFACT_BASENAME_BY_REGION[region];
  if (!name) throw new Error(`unknown region: ${region}`);
  return name;
}

// CDN_BASE / OSS_BUCKET / OSS_PREFIX / OSS_REGION ç”± scripts/shared/oss.mjs æä¾›å¹¶åœ¨é¡¶éƒ¨ re-exportã€‚

/**
 * æ¸ é“å†»ç»“ç¡¬é—¸(2026-07-17 èº«ä»½ç¿»è½¬):è€ /xdt-maker æ¸ é“å·²å†»ç»“,å­˜é‡ 0.0.x
 * ç”¨æˆ·çš„æ›´æ–°å™¨æŒ‰ --exe-name xdt-maker.exe å·¥ä½œâ€”â€”æŠŠ Cindy å¸ƒå±€(Cindy.exe)
 * çš„äº§ç‰©/manifest å‘ä¸Šè€å‰ç¼€,ä¼šè®©æ‰€æœ‰å­˜é‡å®‰è£…çš„è‡ªåŠ¨æ›´æ–°å½“åœºæ–­è£‚ã€‚
 * åœ¨ä»»ä½• desktop å‘å¸ƒ/ä¸Šä¼ åŠ¨ä½œå‰è°ƒç”¨;æ–°æ¸ é“ bucket å°±ç»ªå¹¶æŠŠ OSS å‰ç¼€åˆ‡èµ°
 * ä¹‹å‰,å‘å¸ƒä¸€å¾‹æ‹’ç»ã€‚ç¡®éœ€è¦†ç›–(å¦‚æ¼”ç»ƒ)æ˜¾å¼è®¾ XDT_ALLOW_LEGACY_CHANNEL_RELEASE=1ã€‚
 */
export function assertNotPublishingCindyToLegacyChannel(ossPrefix) {
  if (process.env.XDT_ALLOW_LEGACY_CHANNEL_RELEASE === '1') return;
  if (PACKAGED_APP_NAME === 'Cindy' && ossPrefix === 'xdt-maker') {
    throw new Error(
      '[channel-freeze] æ‹’ç»æŠŠ Cindy èº«ä»½çš„äº§ç‰©å‘å¸ƒåˆ°å·²å†»ç»“çš„ /xdt-maker æ¸ é“:'
      + 'å­˜é‡ç”¨æˆ·æ›´æ–°å™¨ä¼šå›  exe å¸ƒå±€å˜åŒ–(Cindy.exe)å½“åœºæ–­è£‚ã€‚'
      + 'ç­‰æ–°æ¸ é“ OSS å‰ç¼€å°±ç»ªåŽå†å‘å¸ƒ;æ¼”ç»ƒå¯è®¾ XDT_ALLOW_LEGACY_CHANNEL_RELEASE=1 è¦†ç›–ã€‚',
    );
  }
}

// â”€â”€ Apple å…¬è¯/ç­¾åèº«ä»½(macOS release / publish å…±ç”¨;å•ç‚¹å®šä¹‰)â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// å‡ä¸ºå…¬å¼€èº«ä»½ä¿¡æ¯(éžå¯†é’¥;APPLE_APP_PASSWORD æ‰æ˜¯å¯†é’¥,åªä»Ž env è¯»)ã€‚
// 2026-07-20 èµ·**é›¶ä»£ç é»˜è®¤å€¼**:èº«ä»½æ¥è‡ª release-regions.json çš„ <region>.macSigning
// (ç» applyReleaseRegionConfigToEnv / applyMacSigningConfigToEnv æ³¨å…¥ env)æˆ–æ˜¾å¼
// env,ç¼ºå¤±ç›´æŽ¥æŠ›é”™â€”â€”æ­¤å‰é»˜è®¤å›žè½ä¸ªäººè¯ä¹¦,ä¼šåœ¨å¯†ç /è¯ä¹¦æ¢ä¸»ä½“åŽé™é»˜ç­¾é”™èº«ä»½ã€‚
// å¿…é¡»æ˜¯å‡½æ•°è€Œéžæ¨¡å—çº§ const:env åœ¨è°ƒç”¨æ—¶è¯»å–â€”â€”æ¶ˆè´¹è„šæœ¬å…ˆæ³¨å…¥é…ç½®å†è°ƒç”¨ã€‚
export function resolveAppleIdentity() {
  const appleId = process.env.APPLE_ID?.trim();
  const teamId = process.env.APPLE_TEAM_ID?.trim();
  const signIdentity = process.env.APPLE_SIGN_IDENTITY?.trim();
  const missing = [
    !appleId && 'APPLE_ID',
    !teamId && 'APPLE_TEAM_ID',
    !signIdentity && 'APPLE_SIGN_IDENTITY',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `mac ç­¾å/å…¬è¯èº«ä»½ç¼ºå¤±: ${missing.join(' / ')}ã€‚` +
        'é…ç½®é€”å¾„(æŽ¨è): apps/desktop/scripts/release-regions.json çš„ <region>.macSigning' +
        '(appleId / teamId / signIdentity);æˆ–ç›´æŽ¥è®¾ç½®åŒåçŽ¯å¢ƒå˜é‡ã€‚èº«ä»½æ— ä»£ç é»˜è®¤å€¼ã€‚',
    );
  }
  return { appleId, teamId, signIdentity };
}

// â”€â”€ .env è¯»å– â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function loadDotenv(
  envFilePath = path.join(DESKTOP_ROOT, '.env'),
  { refreshReleaseConfig = true } = {},
) {
  try {
    const envFile = fs.readFileSync(envFilePath, 'utf8');
    for (const line of envFile.split('\n')) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch { /* no .env file, that's fine */ }
  if (refreshReleaseConfig) refreshOssConfig();
}

// â”€â”€ å‘½ä»¤å°è£… â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// (sha256 / gzipFile å·²ç§»è‡³ scripts/shared/oss.mjs,é¡¶éƒ¨ re-export)

export function exec(cmd, opts = {}) {
  console.log(`    $ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

// â”€â”€ package.json ç‰ˆæœ¬å·å†™å…¥ (é€€å‡ºæ—¶è‡ªåŠ¨æ¢å¤) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// electron-packager ä¼šæŠŠ package.json æ‹·åˆ° asar å†…éƒ¨ï¼Œè¿è¡Œæ—¶ app.getVersion()
// ä¼˜å…ˆè¯»é‚£é‡Œã€‚æºç é‡Œçš„ 0.0.0 æ˜¯ç‰ˆæœ¬æ— å…³æž„å»ºå“¨å…µï¼›æ­£å¼æ‰“åŒ…å¿…é¡»åœ¨ forge
// è¿è¡Œå‰ä¸´æ—¶å†™å…¥çœŸå®žç‰ˆæœ¬ï¼Œå¦åˆ™å‘å¸ƒåŒ…ä¼šè¢« updateService å½“æˆæœ¬åœ°åŒ…è€Œè·³è¿‡æ›´æ–°ã€‚
// ä»»ä½• exit / SIGINT / SIGTERM éƒ½æ¢å¤ï¼Œä¿è¯ git å·¥ä½œåŒºå¹²å‡€ã€‚

const PACKAGE_JSON_PATH = path.join(DESKTOP_ROOT, 'package.json');
let originalPackageJson = null;

export function writePackageVersion(version) {
  if (originalPackageJson === null) {
    originalPackageJson = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
    process.on('exit', restorePackageJson);
    process.on('SIGINT', () => { restorePackageJson(); process.exit(130); });
    process.on('SIGTERM', () => { restorePackageJson(); process.exit(143); });
  }
  const pkg = JSON.parse(originalPackageJson);
  pkg.version = version;
  fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

function restorePackageJson() {
  if (originalPackageJson === null) return;
  try { fs.writeFileSync(PACKAGE_JSON_PATH, originalPackageJson); } catch { /* ignore */ }
}

// â”€â”€ CDN manifest â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// åŸºçº¿ manifest å¿…é¡»å¸¦ ?t= cache-bust:CDN å¯¹è£¸ URL æœ‰è¾¹ç¼˜ç¼“å­˜(æºç«™ Cache-Control:
// no-cache ä¸ä¸€å®šè¢« CDN å°Šé‡),å®¢æˆ·ç«¯ manifestService ä¸Ž promote-canary-* éƒ½å¸¦äº†,
// å”¯ç‹¬å‘å¸ƒè„šæœ¬æ­¤å‰æ¼äº†â€”â€”2026-07-03 äº‹æ•…çš„ç›´æŽ¥è¯±å› å°±æ˜¯å‘ç‰ˆæ—¶è¯»åˆ°é™ˆæ—§åŸºçº¿,è¯¯åˆ¤
// "ç‰ˆæœ¬å˜äº†" è€Œå¯¹å·²å­˜åœ¨çš„ç‰ˆæœ¬åŒ–è·¯å¾„åšäº†å­—èŠ‚ä¸åŒçš„è¦†ç›–ä¸Šä¼ ã€‚
export async function fetchExistingManifestIfAvailable(platformKey, region = 'global') {
  const cdnBase = resolveReleaseCdnBaseUrl(region);
  const canaryUrl = `${cdnBase}/manifest-${platformKey}-canary.json?t=${Date.now()}`;
  const canaryRes = await fetch(canaryUrl);
  if (canaryRes.ok) {
    return await canaryRes.json();
  }
  if (canaryRes.status !== 404) {
    throw new Error(`Failed to fetch canary manifest (${canaryRes.status}): ${canaryUrl}`);
  }
  const stableUrl = `${cdnBase}/manifest-${platformKey}.json?t=${Date.now()}`;
  const stableRes = await fetch(stableUrl);
  if (stableRes.ok) {
    return await stableRes.json();
  }
  if (stableRes.status === 404) {
    return null;
  }
  throw new Error(`Failed to fetch stable manifest (${stableRes.status}): ${stableUrl}`);
}

export async function fetchExistingManifest(platformKey) {
  const manifest = await fetchExistingManifestIfAvailable(platformKey);
  if (manifest) return manifest;
  throw new Error(`No manifest found for ${platformKey}`);
}

export async function fetchReferenceManifest(platformKeys) {
  for (const platformKey of platformKeys) {
    const manifest = await fetchExistingManifestIfAvailable(platformKey);
    if (manifest) {
      return { manifest, platformKey };
    }
  }
  throw new Error(`No reference manifest found for: ${platformKeys.join(', ')}`);
}

export function createInitialManifest(version, options = {}) {
  return {
    app: {
      version,
      ...(options.releaseNotes ? { releaseNotes: options.releaseNotes } : {}),
    },
    claudeCode: {
      version: '0.0.0',
      file: '',
      sha256: '',
      size: 0,
    },
  };
}

/**
 * Linux in-app update downloads `app.installer` (.deb) and applies it with
 * pkexec. Reuse this helper anywhere we mint a Linux manifest so `app.hotfix`
 * and `app.requireRelogin` can never leak back in through copy/paste drift.
 * Callers that have a real .deb must pass `installer`; omitting it keeps the
 * installer-only shape without inventing a fake asset.
 */
export function createLinuxFirstReleaseManifest(version, baseManifest, installer) {
  const releaseNotes = baseManifest?.app?.releaseNotes;
  const manifest = baseManifest
    ? JSON.parse(JSON.stringify(baseManifest))
    : createInitialManifest(version, { releaseNotes });
  manifest.app = {
    ...(manifest.app ?? {}),
    version,
  };
  delete manifest.app.hotfix;
  delete manifest.app.requireRelogin;
  delete manifest.installer;
  if (installer?.file && installer.sha256) {
    manifest.app.installer = {
      file: installer.file,
      sha256: installer.sha256,
      size: typeof installer.size === 'number' ? installer.size : 0,
    };
  } else {
    delete manifest.app.installer;
  }
  // Packaged Linux resolves Claude/Codex from a compatible system install,
  // migrates the legacy local cache, or downloads the pinned official asset.
  // Ripgrep remains bundled in the .deb by forge and needs no manifest entry.
  delete manifest.claudeCode;
  delete manifest.codex;
  delete manifest.ripgrep;
  return manifest;
}

/**
 * å®¿ä¸» Linux çš„ platform keyã€‚linux ä¸åšäº¤å‰æ‰“åŒ…(åŽŸç”Ÿæ¨¡å—ä¸Ž vec0.so éƒ½æ˜¯
 * per-arch é¢„ç¼–è¯‘ä»¶),æ‰€ä»¥ç¼ºçœæ ¡éªŒå¯¹è±¡å°±æ˜¯å®¿ä¸»è‡ªèº«;å†™æ­» linux-x64 ä¼šè®©
 * aarch64 æœºå™¨åŽ»æŸ¥ä¸€ä»½æ ¹æœ¬ä¸è¿›åŒ…çš„èµ„äº§ã€‚ç¼–æŽ’å±‚ä»åº”æ˜¾å¼ä¼ ç›®æ ‡ archã€‚
 */
export function linuxHostPlatformKey() {
  return `linux-${process.arch}`;
}
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
const MIN_LINUX_RUNTIME_ASSET_SIZE_BYTES = 1024;

function readFilePrefix(filePath, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function linuxRuntimeAssetPaths(platformKey = linuxHostPlatformKey()) {
  return [
    path.join(DESKTOP_ROOT, 'native', 'sqlite-vec', platformKey, 'vec0.so'),
  ];
}

export function collectLinuxRuntimeAssetProblems(assetPaths = linuxRuntimeAssetPaths()) {
  const missing = [];
  const invalid = [];
  for (const filePath of assetPaths) {
    if (!fs.existsSync(filePath)) {
      missing.push(filePath);
      continue;
    }
    const stat = fs.statSync(filePath);
    const prefix = readFilePrefix(filePath, LFS_POINTER_PREFIX.length);
    if (stat.size < MIN_LINUX_RUNTIME_ASSET_SIZE_BYTES || prefix === LFS_POINTER_PREFIX) {
      invalid.push(filePath);
    }
  }
  return { missing, invalid };
}

export async function ensureLinuxRuntimeAssets({
  label = 'Linux runtime assets',
  platformKey = linuxHostPlatformKey(),
} = {}) {
  // Claude/Codex ä¸æ‰“è¿› Linux å®‰è£…åŒ…ï¼Œpackaged runtime ä¼šå¤ç”¨ç³»ç»Ÿ CLIã€è¿ç§»
  // æ—§ç¼“å­˜ï¼Œæˆ–ä»Žå®˜æ–¹ä¸Šæ¸¸ä¸‹è½½å¸¦ SHA-256 æ ¡éªŒçš„ pin ç‰ˆæœ¬ã€‚Ripgrep ä»ç”± forge
  // prePackage å•ç‹¬ stage è¿› resources/toolsï¼›è¿™é‡Œä»…æ ¡éªŒ Git LFS çš„ sqlite-vecã€‚
  const sqliteVecPath = path.join(DESKTOP_ROOT, 'native', 'sqlite-vec', platformKey, 'vec0.so');
  const { missing, invalid } = collectLinuxRuntimeAssetProblems([sqliteVecPath]);
  if (missing.length === 0 && invalid.length === 0) return;
  if (missing.length > 0) {
    console.error(`ERROR: ${label} missing:`);
    for (const filePath of missing) {
      console.error(`  - ${filePath}`);
    }
  }
  if (invalid.length > 0) {
    console.error(`ERROR: ${label} invalid or still stored as Git LFS pointers:`);
    for (const filePath of invalid) {
      console.error(`  - ${filePath}`);
    }
  }
  console.error('sqlite-vec is still Git-LFS managed; run `git lfs pull` to materialize it before release.');
  process.exit(1);
}

export function logLinuxPackagingRequirements() {
  console.log('==> Linux first release packaging note:');
  console.log('    - Current packaging target is .deb (MakerDeb), not AppImage.');
  console.log('    - Linux builders need Debian packaging tools: fakeroot, dpkg, desktop-file-utils.');
  console.log('    - Native rebuild still needs the usual Electron toolchain: python3, make, gcc/g++.');
}

export function findInstallerArtifact(makeBaseDir, extension) {
  const stack = [makeBaseDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name.endsWith(`.${extension}`)) return full;
    }
  }
  return null;
}

// â”€â”€ Release manifest (æœ¬æ¬¡æž„å»ºçš„å…ƒæ•°æ®) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function writeReleaseManifest(destPath, ctx) {
  const journalPath = path.join(DESKTOP_ROOT, 'drizzle', 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const schemaVersionMax = entries.reduce(
    (max, e) => (typeof e.idx === 'number' && e.idx > max ? e.idx : max),
    -1,
  );
  const migrationFiles = fs
    .readdirSync(path.join(DESKTOP_ROOT, 'drizzle'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  let commitSha = '';
  try {
    commitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: DESKTOP_ROOT }).trim();
  } catch { /* not in a git work tree */ }

  let electronVersion = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf-8'));
    electronVersion = (pkg.devDependencies && pkg.devDependencies.electron) || '';
  } catch { /* ignore */ }

  const manifest = {
    version: ctx.version,
    commit_sha: commitSha,
    build_time: new Date().toISOString(),
    platform: ctx.platformKey.split('-')[0],
    arch: ctx.arch,
    schema_version_max: schemaVersionMax,
    migration_files: migrationFiles,
    node_version: process.version,
    electron_version: electronVersion,
  };
  fs.writeFileSync(destPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`==> Release manifest written: ${destPath}`);
}

// â”€â”€ Drizzle æ ¡éªŒ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// macOS:   appPath/Contents/Resources/drizzle/
// Windows: packagedDir/resources/drizzle/

export function verifyPackagedDrizzle(drizzleOut) {
  console.log(`==> Verifying packaged drizzle/ at ${drizzleOut} ...`);
  if (!fs.existsSync(drizzleOut)) {
    console.error(`ERROR: packaged drizzle/ missing at ${drizzleOut}`);
    process.exit(1);
  }
  const journalPath = path.join(drizzleOut, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) {
    console.error(`ERROR: packaged meta/_journal.json missing at ${journalPath}`);
    process.exit(1);
  }
  const srcDrizzle = path.join(DESKTOP_ROOT, 'drizzle');
  const expectedSql = fs
    .readdirSync(srcDrizzle)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f));
  if (expectedSql.length === 0) {
    console.error(`ERROR: source drizzle/ has no NNNN_*.sql files`);
    process.exit(1);
  }
  for (const f of expectedSql) {
    const out = path.join(drizzleOut, f);
    if (!fs.existsSync(out)) {
      console.error(`ERROR: packaged drizzle/${f} missing at ${out}`);
      process.exit(1);
    }
  }
  console.log(`    verified ${expectedSql.length} sql file(s) + journal`);
}

// â”€â”€ DB validation pre-flight â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function runDbValidate() {
  console.log('==> Running db:validate pre-flight...');
  const result = spawnSync('pnpm', ['db:validate'], {
    stdio: 'inherit',
    cwd: DESKTOP_ROOT,
    shell: true,
  });
  if (result.status !== 0) {
    console.error('ERROR: db:validate failed; aborting.');
    process.exit(1);
  }
}

// â”€â”€ macOS local signing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
const MAC_BUNDLE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** æ­£å¼ç­¾ååŒ…çš„ WebAuthn Touch ID keychain access groupã€‚ */
export function macWebAuthnKeychainAccessGroup(teamId, bundleId) {
  const normalizedTeamId = String(teamId ?? '').trim();
  const normalizedBundleId = String(bundleId ?? '').trim();
  if (!APPLE_TEAM_ID_PATTERN.test(normalizedTeamId)) {
    throw new Error(`invalid Apple Team ID for WebAuthn: ${normalizedTeamId || '(empty)'}`);
  }
  if (!MAC_BUNDLE_ID_PATTERN.test(normalizedBundleId) || normalizedBundleId.includes('..')) {
    throw new Error(`invalid macOS bundle id for WebAuthn: ${normalizedBundleId || '(empty)'}`);
  }
  return `${normalizedTeamId}.${normalizedBundleId}.webauthn`;
}

function entitlementValueAllows(values, requestedValue) {
  return values.some((value) => {
    if (typeof value !== 'string') return false;
    if (value === requestedValue) return true;
    return value.endsWith('*') && requestedValue.startsWith(value.slice(0, -1));
  });
}

/** Validate the authorization carried by a decoded Developer ID profile. */
export function assertMacWebAuthnProvisioningProfile(
  profile,
  { teamId, bundleId, keychainAccessGroup, now = new Date() },
) {
  const profileTeams = Array.isArray(profile?.TeamIdentifier) ? profile.TeamIdentifier : [];
  if (!profileTeams.includes(teamId)) {
    throw new Error(`WebAuthn provisioning profile does not authorize Apple Team ID ${teamId}`);
  }
  const expiresAt = new Date(profile?.ExpirationDate ?? Number.NaN);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new Error('WebAuthn provisioning profile is expired or has no valid expiration date');
  }
  const entitlements = profile?.Entitlements;
  if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)) {
    throw new Error('WebAuthn provisioning profile has no entitlement allowlist');
  }
  if (entitlements['com.apple.developer.team-identifier'] !== teamId) {
    throw new Error(`WebAuthn provisioning profile entitlement Team ID does not match ${teamId}`);
  }
  const requestedApplicationId = `${teamId}.${bundleId}`;
  const applicationId =
    entitlements['com.apple.application-identifier'] ?? entitlements['application-identifier'];
  if (!entitlementValueAllows([applicationId], requestedApplicationId)) {
    throw new Error(`WebAuthn provisioning profile does not authorize ${requestedApplicationId}`);
  }
  const keychainAccessGroups = entitlements['keychain-access-groups'];
  if (
    !Array.isArray(keychainAccessGroups) ||
    !entitlementValueAllows(keychainAccessGroups, keychainAccessGroup)
  ) {
    throw new Error(
      `WebAuthn provisioning profile does not authorize keychain group ${keychainAccessGroup}`,
    );
  }
}

/** Decode, validate and embed the profile required by keychain-access-groups. */
export function embedMacWebAuthnProvisioningProfile(
  appPath,
  profilePath,
  expected,
  dependencies = {},
) {
  const spawnCommand = dependencies.spawnCommand ?? spawnSync;
  const decodeResult = spawnCommand('/usr/bin/security', ['cms', '-D', '-i', profilePath], {
    encoding: 'utf8',
  });
  if (decodeResult.error || decodeResult.status !== 0) {
    throw new Error(
      `failed to decode WebAuthn provisioning profile: ${decodeResult.error?.message ?? decodeResult.stderr?.trim() ?? `exit ${decodeResult.status}`}`,
    );
  }
  const decodedProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-webauthn-profile-'));
  const decodedProfilePath = path.join(decodedProfileDir, 'decoded.plist');
  try {
    fs.writeFileSync(decodedProfilePath, decodeResult.stdout);

    const extractProfileField = (field, format) => {
      const result = spawnCommand(
        '/usr/bin/plutil',
        ['-extract', field, format, '-o', '-', '--', decodedProfilePath],
        { encoding: 'utf8' },
      );
      if (result.error || result.status !== 0) {
        throw new Error(
          `failed to inspect WebAuthn provisioning profile: ${field} extraction failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
        );
      }
      return result.stdout;
    };

    let profile;
    try {
      profile = {
        TeamIdentifier: JSON.parse(extractProfileField('TeamIdentifier', 'json')),
        ExpirationDate: extractProfileField('ExpirationDate', 'raw').trim(),
        Entitlements: JSON.parse(extractProfileField('Entitlements', 'json')),
      };
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          'failed to inspect WebAuthn provisioning profile: plist field extraction returned invalid JSON',
          { cause: error },
        );
      }
      throw error;
    }
    assertMacWebAuthnProvisioningProfile(profile, expected);
  } finally {
    fs.rmSync(decodedProfileDir, { recursive: true, force: true });
  }
  const embeddedPath = path.join(appPath, 'Contents', 'embedded.provisionprofile');
  fs.copyFileSync(profilePath, embeddedPath);
  return embeddedPath;
}

function escapeXmlText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function writeMacEntitlements(destPath, { appleEvents = false, keychainAccessGroup } = {}) {
  const appleEventsEntitlement = appleEvents
    ? `    <key>com.apple.security.automation.apple-events</key>
    <true/>
`
    : '';
  const keychainAccessGroupEntitlement = keychainAccessGroup
    ? `    <key>keychain-access-groups</key>
    <array>
        <string>${escapeXmlText(keychainAccessGroup)}</string>
    </array>
`
    : '';
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
${appleEventsEntitlement}${keychainAccessGroupEntitlement}</dict>
</plist>`;
  fs.writeFileSync(destPath, content);
}

function readCodesignEntitlements(bundlePath) {
  const result = spawnSync(
    '/usr/bin/codesign',
    ['-d', '--entitlements', '-', '--xml', bundlePath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`codesign entitlement inspection failed for ${bundlePath}: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

export function parseCodesignTeamIdentifier(output) {
  return (
    String(output ?? '')
      .match(/^TeamIdentifier=(.+)$/m)?.[1]
      ?.trim() ?? ''
  );
}

function readCodesignTeamIdentifier(bundlePath) {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', bundlePath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `codesign identity inspection failed for ${bundlePath}: ${result.stderr || result.stdout}`,
    );
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return parseCodesignTeamIdentifier(output);
}

function hasAppleEventsEntitlement(entitlements) {
  return /<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\s*\/>/.test(
    entitlements,
  );
}

function hasKeychainAccessGroup(entitlements, keychainAccessGroup) {
  const escaped = keychainAccessGroup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `<key>keychain-access-groups<\\/key>\\s*<array>[\\s\\S]*?<string>${escaped}<\\/string>[\\s\\S]*?<\\/array>`,
  ).test(entitlements);
}

function readPlistString(infoPlistPath, key) {
  const result = spawnSync(
    '/usr/libexec/PlistBuddy',
    ['-c', `Print :${key}`, infoPlistPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`packaged Info.plist is missing ${key}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function readMacBundleIdentifier(appPath) {
  return readPlistString(path.join(appPath, 'Contents', 'Info.plist'), 'CFBundleIdentifier');
}

/** Verify the packaged Contacts/JXA privacy contract after signing. */
export function verifyMacContactsPermissions(appPath, { keychainAccessGroup, signingTeamId } = {}) {
  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  const appleEventsUsage = readPlistString(infoPlistPath, 'NSAppleEventsUsageDescription');
  const contactsUsage = readPlistString(infoPlistPath, 'NSContactsUsageDescription');
  for (const [key, value] of [
    ['NSAppleEventsUsageDescription', appleEventsUsage],
    ['NSContactsUsageDescription', contactsUsage],
  ]) {
    if (!/import/i.test(value) || !/(add|update|export)/i.test(value)) {
      throw new Error(`${key} must accurately describe Contacts import and explicit export/update`);
    }
  }

  const mainEntitlements = readCodesignEntitlements(appPath);
  if (!hasAppleEventsEntitlement(mainEntitlements)) {
    throw new Error('main app is missing com.apple.security.automation.apple-events=true');
  }
  if (keychainAccessGroup && !hasKeychainAccessGroup(mainEntitlements, keychainAccessGroup)) {
    throw new Error(`main app is missing WebAuthn keychain access group ${keychainAccessGroup}`);
  }
  if (signingTeamId) {
    const actualTeamId = readCodesignTeamIdentifier(appPath);
    if (actualTeamId !== signingTeamId) {
      throw new Error(
        `macOS signature TeamIdentifier mismatch: expected ${signingTeamId}, got ${actualTeamId || '(empty)'}`,
      );
    }
  }
  if (
    keychainAccessGroup &&
    !fs.existsSync(path.join(appPath, 'Contents', 'embedded.provisionprofile'))
  ) {
    throw new Error('main app is missing the WebAuthn provisioning profile');
  }

  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  const helperApps = fs.readdirSync(frameworksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(frameworksDir, entry.name));
  for (const helperApp of helperApps) {
    if (hasAppleEventsEntitlement(readCodesignEntitlements(helperApp))) {
      throw new Error(`helper app must not receive Apple Events entitlement: ${helperApp}`);
    }
    if (
      keychainAccessGroup &&
      hasKeychainAccessGroup(readCodesignEntitlements(helperApp), keychainAccessGroup)
    ) {
      throw new Error(`helper app must not receive WebAuthn keychain access group: ${helperApp}`);
    }
  }
  console.log(
    `==> Verified macOS Contacts usage descriptions and main-only Apple Events${keychainAccessGroup ? ' / WebAuthn' : ''} entitlements`,
  );
}

export function adhocSignMacApp(appPath, helperEntitlementsPath, mainEntitlementsPath, arch) {
  console.log('==> Ad-hoc signing macOS app for local packaged testing...');
  const signBase = '/usr/bin/codesign --force --options runtime --sign -';
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

  const asarUnpackedDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
  if (fs.existsSync(asarUnpackedDir)) {
    exec(`find "${asarUnpackedDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  }

  const resourceToolsDir = path.join(appPath, 'Contents', 'Resources', 'tools');
  if (fs.existsSync(resourceToolsDir)) {
    exec(`find "${resourceToolsDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
    exec(`find "${resourceToolsDir}" -depth -type d -name "*.app" -exec ${signBase} "{}" \\;`);
  }

  exec(`find "${frameworksDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  exec(`find "${frameworksDir}" -name "*.app" -exec ${signBase} --entitlements "${helperEntitlementsPath}" "{}" \\;`);
  exec(`find "${frameworksDir}" -maxdepth 1 -name "*.framework" -exec ${signBase} "{}" \\;`);
  exec(`${signBase} --entitlements "${mainEntitlementsPath}" "${appPath}"`);
  exec(`/usr/bin/codesign --verify --deep --strict "${appPath}"`);
  verifyMacContactsPermissions(appPath);
}

// â”€â”€ macOS æ­£å¼ç­¾å / å…¬è¯ / DMG(å•ç‚¹å®žçŽ°;publish-macos ä¸Ž package-desktop å…±ç”¨)â”€â”€
// åŽŸå®žçŽ°åœ¨ ci/publish-macos.mjs ä¸Ž release-macos.mjs å„æœ‰ä¸€ä»½;æ­¤å¤„ä¸ºå‚æ•°åŒ–ç‰ˆæœ¬,
// Apple èº«ä»½ç”±è°ƒç”¨æ–¹ä¼ å…¥(resolveAppleIdentity() + env APPLE_APP_PASSWORD)ã€‚

/**
 * Developer ID ç”±å†…å‘å¤–é€å±‚ç­¾å(Electron app ä¸èƒ½ä¾èµ– --deep)ã€‚
 * @param {{ signIdentity: string, teamId: string }} identity
 */
export function signMacAppWithIdentity(
  appPath,
  helperEntitlementsPath,
  mainEntitlementsPath,
  identity,
  { keychainAccessGroup, arch } = {},
) {
  console.log('    Removing provenance attributes...');
  exec(`/usr/bin/xattr -dr com.apple.provenance "${appPath}" 2>/dev/null || true`);

  const signBase = `/usr/bin/codesign --force --timestamp --options runtime --sign "${identity.signIdentity}"`;
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

  // 0. app.asar.unpacked/ é‡Œçš„åŽŸç”Ÿæ¨¡å—(better_sqlite3.node ç­‰)æ˜¯ç‹¬ç«‹æ–‡ä»¶,
  //    ä¸å•ç­¾çš„è¯ Gatekeeper æ‹’ç»åŠ è½½,app ç›´æŽ¥æ‰“ä¸å¼€ã€‚
  const asarUnpackedDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked');
  if (fs.existsSync(asarUnpackedDir)) {
    console.log('    Signing native modules in app.asar.unpacked/...');
    exec(`find "${asarUnpackedDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
  }

  // 0b. Contents/Resources/tools/ ä¸‹çš„ CLI å·¥å…·(extraResource æ‹·å…¥,å…¬è¯è¦æ±‚æ˜¾å¼ç­¾)ã€‚
  const resourceToolsDir = path.join(appPath, 'Contents', 'Resources', 'tools');
  if (fs.existsSync(resourceToolsDir)) {
    console.log('    Signing bundled CLI tools in Contents/Resources/tools/...');
    exec(`find "${resourceToolsDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);
    console.log('    Signing bundled resource app bundles...');
    exec(`find "${resourceToolsDir}" -depth -type d -name "*.app" -exec ${signBase} "{}" \\;`);
  }

  // 1. å…¨éƒ¨ Mach-O(åº“ã€chrome_crashpad_handlerã€ShipIt ç­‰)
  console.log('    Signing all Mach-O binaries...');
  exec(`find "${frameworksDir}" -type f | while IFS= read -r f; do if file "$f" | grep -qE "Mach-O"; then ${signBase} "$f"; fi; done`);

  // 2. Helper apps(V8 JIT entitlements)
  console.log('    Signing helper apps...');
  exec(`find "${frameworksDir}" -name "*.app" -exec ${signBase} --entitlements "${helperEntitlementsPath}" "{}" \\;`);

  // 3. Framework bundles
  console.log('    Signing frameworks...');
  exec(`find "${frameworksDir}" -maxdepth 1 -name "*.framework" -exec ${signBase} "{}" \\;`);

  // 5. ä¸» app bundle
  console.log('    Signing main app...');
  exec(`${signBase} --entitlements "${mainEntitlementsPath}" "${appPath}"`);

  console.log('    Verifying signature...');
  exec(`/usr/bin/codesign --verify --deep --strict "${appPath}"`);
  verifyMacContactsPermissions(appPath, {
    keychainAccessGroup,
    signingTeamId: identity.teamId,
  });
}

const NOTARYTOOL_TIMEOUT_MS = 1800000;

function spawnOutputText(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return value == null ? '' : String(value);
}

function redactApplePassword(value, applePassword) {
  const text = spawnOutputText(value);
  return applePassword ? text.split(applePassword).join('****') : text;
}

function logCapturedNotarytoolOutput(result, operation, identity, logger) {
  const output = [result.stdout, result.stderr]
    .map((value) => redactApplePassword(value, identity.applePassword).trim())
    .filter(Boolean)
    .join('\n');
  if (output) {
    logger.error(`    notarytool ${operation} output:`);
    logger.error(output);
  }
}

/**
 * æŠŠ notarytool çš„åŽŸå§‹è¾“å‡ºæŒ‚åˆ° error ä¸Šã€‚notarytool å¯¹ Invalid æäº¤çš„ exit code éš
 * Xcode ç‰ˆæœ¬å˜åŒ–(æœ‰çš„ 0ã€æœ‰çš„éž 0);éž 0 é‚£æ¡è·¯å¾„ä¹Ÿå¿…é¡»èƒ½ä»Ž stdout é‡Œæ•‘å›ž
 * submission id,å¦åˆ™æ‹¿ä¸åˆ° Apple çš„è¯¦ç»†å¤±è´¥åŽŸå› ã€‚
 */
function attachNotarytoolOutput(error, result) {
  error.notarytoolStdout = spawnOutputText(result?.stdout);
  error.notarytoolStderr = spawnOutputText(result?.stderr);
  return error;
}

function runNotarytool(operation, args, identity, { spawnCommand, logger }) {
  let result;
  try {
    result = spawnCommand('/usr/bin/xcrun', args, {
      encoding: 'utf8',
      timeout: NOTARYTOOL_TIMEOUT_MS,
    });
  } catch (error) {
    const message = redactApplePassword(error?.message ?? error, identity.applePassword);
    throw new Error(`notarytool ${operation} æ— æ³•æ‰§è¡Œ:${message}`);
  }

  if (result.error || result.signal || result.status !== 0) {
    logCapturedNotarytoolOutput(result, operation, identity, logger);
  }
  if (result.error) {
    const message = redactApplePassword(result.error.message, identity.applePassword);
    throw new Error(`notarytool ${operation} æ— æ³•æ‰§è¡Œ:${message}`);
  }
  if (result.signal) {
    throw attachNotarytoolOutput(
      new Error(
        `notarytool ${operation} è¢«ä¿¡å· ${result.signal} ç»ˆæ­¢(å¯èƒ½å…¬è¯è¶…æ—¶);å…¬è¯æœªé€šè¿‡ã€‚`,
      ),
      result,
    );
  }
  if (result.status !== 0) {
    throw attachNotarytoolOutput(
      new Error(`notarytool ${operation} å¤±è´¥(exit ${result.status});å…¬è¯æœªé€šè¿‡ã€‚`),
      result,
    );
  }
  return {
    stdout: spawnOutputText(result.stdout),
    stderr: spawnOutputText(result.stderr),
  };
}

function parseNotarytoolSubmitResponse(stdout) {
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new Error('notarytool submit æœªè¿”å›žæœ‰æ•ˆ JSON;å…¬è¯ç»“æžœæ— æ³•ç¡®è®¤ã€‚');
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('notarytool submit JSON ç»“æž„æ— æ•ˆ;å…¬è¯ç»“æžœæ— æ³•ç¡®è®¤ã€‚');
  }
  const status = typeof response.status === 'string' ? response.status.trim() : '';
  const id = typeof response.id === 'string' ? response.id.trim() : '';
  if (!status) {
    throw new Error('notarytool submit JSON ç¼ºå°‘ status;å…¬è¯ç»“æžœæ— æ³•ç¡®è®¤ã€‚');
  }
  return { id, status };
}

/** è§£æžå¤±è´¥æ—¶è¿”å›ž null(æ•‘æ´è·¯å¾„ç”¨):æ­¤æ—¶ exit code å·²ç»è¯´æ˜Žå…¬è¯æ²¡è¿‡ã€‚ */
function tryParseNotarytoolSubmitResponse(stdout) {
  try {
    return parseNotarytoolSubmitResponse(stdout);
  } catch {
    return null;
  }
}

function printNotarizationFailureLog(submissionId, status, identity, dependencies) {
  const { logger } = dependencies;
  if (!submissionId) {
    logger.error(
      `    Apple å…¬è¯è¿”å›ž ${status}ï¼Œä½†å“åº”ç¼ºå°‘ submission idï¼Œæ— æ³•æ‹‰å–è¯¦ç»†æ—¥å¿—ã€‚`,
    );
    return;
  }

  const logArgs = [
    'notarytool',
    'log',
    submissionId,
    '--apple-id',
    identity.appleId,
    '--password',
    identity.applePassword,
    '--team-id',
    identity.teamId,
  ];
  logger.log(
    `    $ /usr/bin/xcrun notarytool log ${JSON.stringify(submissionId)} ` +
      `--apple-id ${JSON.stringify(identity.appleId)} --password "****" ` +
      `--team-id ${JSON.stringify(identity.teamId)}`,
  );
  try {
    const result = runNotarytool('log', logArgs, identity, dependencies);
    const output = [result.stdout, result.stderr]
      .map((value) => redactApplePassword(value, identity.applePassword).trim())
      .filter(Boolean)
      .join('\n');
    logger.error('    Apple notarization log:');
    logger.error(output || '(empty log)');
  } catch (error) {
    const message = redactApplePassword(error?.message ?? error, identity.applePassword);
    logger.error(`    WARN: æ— æ³•èŽ·å– Apple notarization log: ${message}`);
  }
}

/**
 * Apple notarytool å…¬è¯ + stapleã€‚
 * @param {{ appleId: string, teamId: string, applePassword: string }} identity
 * @param {{
 *   execCommand?: typeof exec,
 *   spawnCommand?: typeof spawnSync,
 *   unlinkFile?: typeof fs.unlinkSync,
 *   logger?: Console,
 * }} dependencies
 */
export function notarizeMacApp(appPath, identity, {
  execCommand = exec,
  spawnCommand = spawnSync,
  unlinkFile = fs.unlinkSync,
  logger = console,
} = {}) {
  const zipPath = appPath + '.zip';
  const dependencies = { spawnCommand, logger };

  logger.log('    Compressing for notarization...');
  execCommand(`/usr/bin/ditto -c -k --keepParent "${appPath}" "${zipPath}"`);

  logger.log('    Submitting to Apple notarization service (this may take a few minutes)...');
  // å¯†ç ä½œä¸º --password å€¼ç›´æŽ¥ä¼ ç»™ notarytoolâ€”â€”ä¸å†ç”¨ --password @env:VAR é—´æŽ¥:
  // æ—§ç‰ˆ notarytool ä¸è®¤ @env: å‰ç¼€,ä¼šæŠŠå­—é¢é‡ "@env:..." å½“å¯†ç æœ¬èº«å‘å‡ºåŽ»è€Œ 401ã€‚
  // èµ° spawnSync å‚æ•°æ•°ç»„:é¿å… shell å‚ä¸Ž(æ— æ’å€¼/æ— æ³¨å…¥é¢),ä¸”æ—¥å¿—å›žæ˜¾æ—¶å¯¹å¯†ç 
  // æ‰“ç (credentials è§„åˆ™:è¾“å‡ºä¸å¾—å«å‡­è¯æ˜Žæ–‡)ã€‚
  // æ³¨æ„æš´éœ²é¢:å¯†ç ä»ä½œä¸º xcrun çš„æ˜Žæ–‡ argv ä¼ å…¥,--wait æœŸé—´(æœ€é•¿ 30min)åŒæœºåŒ
  // ç”¨æˆ·è¿›ç¨‹ç» ps/proc ä»å¯è¯»åˆ°â€”â€”æž„å»ºæœºä¸ºå—æŽ§å•ç§Ÿæˆ·çŽ¯å¢ƒ,å–æ­¤æƒè¡¡;è‹¥éœ€å½»åº•æ¶ˆé™¤
  // argv æš´éœ²,åŽç»­å¯æ”¹ç”¨ notarytool çš„ --keychain-profile(@keychain: å‡­æ®)ã€‚
  const submitArgs = [
    'notarytool',
    'submit',
    zipPath,
    '--apple-id',
    identity.appleId,
    '--password',
    identity.applePassword,
    '--team-id',
    identity.teamId,
    '--wait',
    '--output-format',
    'json',
  ];
  logger.log(
    `    $ /usr/bin/xcrun notarytool submit ${JSON.stringify(zipPath)} ` +
      `--apple-id ${JSON.stringify(identity.appleId)} --password "****" ` +
      `--team-id ${JSON.stringify(identity.teamId)} --wait --output-format json`,
  );
  let submitResult;
  try {
    submitResult = runNotarytool('submit', submitArgs, identity, dependencies);
  } catch (error) {
    // notarytool è‡ªå·±ä»¥éž 0 é€€å‡º:åŽŸå§‹è¾“å‡ºå·²ç”± runNotarytool æ‰“è¿‡ä¸€é,è¿™é‡Œå†å°½åŠ›ä»Ž
    // stdout é‡Œæ•‘å‡º submission id åŽ»æ‹‰ Apple çš„è¯¦ç»†å¤±è´¥åŽŸå› ã€‚zip ä¿ç•™ä¸åˆ ã€‚
    const salvaged = tryParseNotarytoolSubmitResponse(error?.notarytoolStdout ?? '');
    if (salvaged && salvaged.status !== 'Accepted') {
      printNotarizationFailureLog(salvaged.id, salvaged.status, identity, dependencies);
    }
    throw error;
  }
  let submission;
  try {
    submission = parseNotarytoolSubmitResponse(submitResult.stdout);
  } catch (error) {
    logCapturedNotarytoolOutput(submitResult, 'submit', identity, logger);
    throw error;
  }
  logger.log(
    `    Apple notarization status: ${submission.status}` +
      (submission.id ? ` (${submission.id})` : ''),
  );

  if (submission.status !== 'Accepted') {
    printNotarizationFailureLog(submission.id, submission.status, identity, dependencies);
    throw new Error(
      `Apple å…¬è¯æœªé€šè¿‡: status=${submission.status}` +
        (submission.id ? `, submission=${submission.id}` : '') +
        'ã€‚',
    );
  }

  unlinkFile(zipPath);

  logger.log('    Stapling notarization ticket...');
  execCommand(`/usr/bin/xcrun stapler staple "${appPath}"`);
}

// â”€â”€ DMG å®‰è£…ç•Œé¢(dmgbuild)â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// DMG ç”¨ dmgbuild(pip,çº¯ Python æ— åŽŸç”Ÿä¾èµ–)ç”Ÿæˆ:Splash å“ç‰ŒèƒŒæ™¯ + å›¾æ ‡å®šä½çš„
// å®‰è£…çª—å£,æ›¿ä»£è£¸ hdiutil çš„æ— å¸ƒå±€çª—å£ã€‚èƒŒæ™¯ä¸º **PDF çŸ¢é‡**â€”â€”macOS 26 Finder
// å¯¹ä½å›¾èƒŒæ™¯åªæŒ‰ 1x ç»˜åˆ¶(Retina å¿…ç³Š),ä½†ä¼šæŒ‰ backing scale å…‰æ …åŒ– PDF,
// è¿™æ˜¯å”¯ä¸€çš„é«˜æ¸…é€šé“;å®Œæ•´å®žæµ‹ç»“è®ºä¸Žè§†è§‰çº¦æŸè§
// resources/dmg/render-background.swift å¤´æ³¨é‡Šã€‚

/**
 * dmgbuild pin ç‰ˆæœ¬;bump å‰å…ˆåœ¨æœ¬æœºéªŒè¯èƒŒæ™¯ä»èƒ½æ¸²æŸ“(macOS 26 Finder å¾ˆæŒ‘å‰”)ã€‚
 * âš ï¸ ä¸å¾—ä½ŽäºŽ 1.6.6:æ—§ç‰ˆç»™èƒŒæ™¯å†™ bookmark è®°å½•,macOS 26 Finder ä¸æ¸²æŸ“
 * (electron-builder#9072 åŒæºé—®é¢˜),1.6.6+ æ‰æ˜¯ alias-only å®žçŽ°ã€‚
 */
const DMGBUILD_VERSION = '1.6.7';

/** dmgbuild 1.6.6+ è¦æ±‚ python >= 3.10;ç³»ç»Ÿ /usr/bin/python3(CLT 3.9)ä¸å¤Ÿ */
const PYTHON_MIN_MINOR = 10;

/** ä»Žå€™é€‰é‡Œæ‰¾ >= 3.10 çš„ python3(PATH ä¼˜å…ˆ,å…¼å®¹ homebrew / CLT æ–°ç‰ˆ) */
function findPython3() {
  const candidates = ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
  for (const cand of candidates) {
    const r = spawnSync(cand, ['--version'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const m = `${r.stdout}${r.stderr}`.match(/Python 3\.(\d+)/);
    if (m && Number(m[1]) >= PYTHON_MIN_MINOR) return cand;
  }
  throw new Error(
    `No python3 >= 3.${PYTHON_MIN_MINOR} found (required by dmgbuild ${DMGBUILD_VERSION}); ` +
      'install one via https://python.org or homebrew',
  );
}

/**
 * ç¡®ä¿ dmgbuild å¯ç”¨,è¿”å›žå…¶å¯æ‰§è¡Œæ–‡ä»¶è·¯å¾„ã€‚
 * venv å»ºåœ¨å½“å‰ç”¨æˆ· ~/.cache ä¸‹å¹¶æŒ‰ç‰ˆæœ¬å·éš”ç¦»(å¹‚ç­‰å¤ç”¨);ä¸ç”¨ /tmpâ€”â€”å…±äº«
 * æž„å»ºæœºä¸Šå…¶ä»–æœ¬åœ°ç”¨æˆ·å¯é¢„å å¯é¢„æµ‹çš„ /tmp è·¯å¾„å¡žå…¥æ¶æ„ dmgbuild,è€Œç­¾åæ‰“åŒ…
 * è¿›ç¨‹ env é‡Œå¸¦ç€ APPLE_* å‡­è¯ã€‚~/.cache ä»…æœ¬ç”¨æˆ·å¯å†™,æ¶ˆé™¤é¢„å é¢ã€‚
 * å‡­è¯ä¸å…¥ä»“ã€ç”Ÿæˆç‰©ä¸è¿›å·¥ä½œåŒº;é¦–æ¬¡åˆ›å»ºéœ€è¦ç½‘ç»œ(pip);å¤±è´¥ç›´æŽ¥æŠ›é”™é˜»æ–­
 * æž„å»º,ä¸é™é»˜å›žé€€æˆæ— èƒŒæ™¯ DMGã€‚
 */
function ensureDmgbuild() {
  const venvDir = path.join(os.homedir(), '.cache', `cindy-dmgbuild-venv-${DMGBUILD_VERSION}`);
  const bin = path.join(venvDir, 'bin', 'dmgbuild');
  if (fs.existsSync(bin)) return bin;
  console.log(`    Installing dmgbuild ${DMGBUILD_VERSION} (one-time venv)...`);
  exec(`"${findPython3()}" -m venv "${venvDir}"`);
  exec(`"${path.join(venvDir, 'bin', 'pip')}" install --quiet dmgbuild==${DMGBUILD_VERSION}`);
  return bin;
}

/**
 * ç”Ÿæˆå¸¦å“ç‰Œå®‰è£…ç•Œé¢çš„ UDZO DMG å¹¶ç­¾å:Splash é£Žæµ…è‰²èƒŒæ™¯(é«˜æ¸…ç«‹ç»˜ + CINDY
 * å­—æ ‡ + æ‰‹å†™ä½“ + æ‹–æ‹½ç®­å¤´,PDF çŸ¢é‡é«˜æ¸…)ã€app å±…å·¦ / Applications è½¯é“¾å±…å³ã€
 * 660Ã—460 å›ºå®šçª—å£ã€‚
 * å¸ƒå±€åæ ‡ä¸Ž resources/dmg/render-background.swift å†…çš„å“ç‰Œå—/ç®­å¤´ä½ç½®è”åŠ¨,æ”¹åŠ¨éœ€ä¸¤è¾¹åŒæ­¥ã€‚
 * @param {{ signIdentity: string }} identity
 */
export function createMacDMG(appPath, dmgPath, volumeName, identity) {
  const dmgbuildBin = ensureDmgbuild();
  const backgroundPath = path.join(DESKTOP_ROOT, 'resources', 'dmg', 'background.pdf');
  if (!fs.existsSync(backgroundPath)) {
    throw new Error(`DMG background missing: ${backgroundPath}`);
  }

  const appName = path.basename(appPath); // Cindy.app(cn/global)/ CindyDev.app(dev çº¿)
  // JSON.stringify äº§å‡ºåˆæ³• Python å­—ç¬¦ä¸²å­—é¢é‡(è½¬ä¹‰å¼•å·/åæ–œæ è¯­ä¹‰ä¸€è‡´)
  const py = (s) => JSON.stringify(s);
  const settings = [
    `files = [${py(appPath)}]`,
    `symlinks = {'Applications': '/Applications'}`,
    `background = ${py(backgroundPath)}`,
    // ä¸Žæ—§ hdiutil äº§ç‰©æ ¼å¼ä¿æŒä¸€è‡´(dmgbuild é»˜è®¤ UDBZ)
    `format = 'UDZO'`,
    `window_rect = ((200, 140), (660, 460))`,
    `icon_size = 110`,
    `text_size = 13`,
    `icon_locations = {`,
    `    ${py(appName)}: (175, 335),`,
    `    'Applications': (485, 335),`,
    // èƒŒæ™¯æ–‡ä»¶æœ¬ä½“å¯¹é»˜è®¤è®¾ç½®çš„ç”¨æˆ·ä¸å¯è§;æŠŠåæ ‡æŒªåˆ°è¿œè¶…å¯æ‹‰ä¼¸èŒƒå›´ä¹‹å¤–,
    // ç…§é¡¾å¼€äº†"æ˜¾ç¤ºéšè—æ–‡ä»¶"çš„ç”¨æˆ·(èƒŒæ™¯ç”»å¸ƒ 900Ã—610,çª—å£å¯è¢«æ‹‰å¾—æ¯”è¿™æ›´å¤§)
    `    '.background.pdf': (1600, 1200),`,
    `}`,
  ].join('\n');
  const settingsPath = path.join(os.tmpdir(), `cindy-dmg-settings-${process.pid}.py`);
  fs.writeFileSync(settingsPath, settings);

  if (fs.existsSync(dmgPath)) fs.unlinkSync(dmgPath);
  console.log('    Creating DMG (dmgbuild)...');
  try {
    exec(`"${dmgbuildBin}" -s "${settingsPath}" "${volumeName}" "${dmgPath}"`);
  } finally {
    fs.rmSync(settingsPath, { force: true });
  }

  console.log('    Signing DMG...');
  exec(`/usr/bin/codesign --force --timestamp --sign "${identity.signIdentity}" "${dmgPath}"`);
}

// â”€â”€ Smoke test (å¯åŠ¨ packaged app) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function runSmokeTest(platform, arch, region = 'global') {
  console.log('==> Running packaged smoke test...');
  const result = spawnSync(
    'node',
    [
      'scripts/smoke-packaged.mjs',
      `--platform=${platform}`,
      `--arch=${arch}`,
      // äº§ç‰©åŸºåæŒ‰åŒºåŸŸæ´¾ç”Ÿ(cn/global 'Cindy' / dev 'CindyDev')ã€‚
      `--app-name=${packagedAppName(region)}`,
    ],
    { stdio: 'inherit', cwd: DESKTOP_ROOT, shell: false },
  );
  if (result.status !== 0) {
    console.error('ERROR: packaged smoke test failed; aborting.');
    process.exit(1);
  }
}

// â”€â”€ Claude Code äºŒè¿›åˆ¶ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function getLocalClaudeCodeVersion(platformKey, binaryName = 'claude') {
  const binPath = path.join(PROJECT_ROOT, 'apps', 'claude-code-bin', platformKey, binaryName);
  if (!fs.existsSync(binPath)) return null;
  try { fs.chmodSync(binPath, 0o755); } catch {}
  try {
    const output = execSync(`"${binPath}" -v`, { encoding: 'utf8', timeout: 10000 });
    const match = output.match(/^([\d.]+)/);
    return match ? match[1] : null;
  } catch (err) {
    console.warn(`    WARN: failed to exec ${binPath} --version: ${err.message}`);
    return null;
  }
}

/**
 * æ¯”è¾ƒæœ¬åœ° Claude Code äºŒè¿›åˆ¶ä¸Ž CDN ä¸Šçš„ç‰ˆæœ¬å’Œå“ˆå¸Œï¼Œå†³å®šæ˜¯å¦éœ€è¦ä¸Šä¼ ã€‚
 * è¿”å›ž { uploadClaudeCode, gzPath, ccHash, ccSize, localBinHash } æˆ– nullã€‚
 */
export async function maybeBuildClaudeCodeGz({ platformKey, manifest, binaryName }) {
  const localCCVersion = getLocalClaudeCodeVersion(platformKey, binaryName);
  const cdnCCVersion = manifest.claudeCode?.version || '0.0.0';
  const cdnCCBinaryHash = manifest.claudeCode?.binarySha256 || '';

  console.log(`\n==> Claude Code compare (${platformKey})`);
  if (!localCCVersion) {
    console.log(`    SKIP: local bin missing or --version failed`);
    return null;
  }

  const binPath = path.join(PROJECT_ROOT, 'apps', 'claude-code-bin', platformKey, binaryName);
  const binSize = fs.statSync(binPath).size;
  const localBinHash = sha256(binPath);

  console.log(`    bin path:         ${binPath}`);
  console.log(`    bin size:         ${(binSize / 1024 / 1024).toFixed(1)} MB (${binSize} bytes)`);
  console.log(`    local  version:   ${localCCVersion}`);
  console.log(`    local  sha256:    ${localBinHash}`);
  console.log(`    CDN    version:   ${cdnCCVersion}`);
  console.log(`    CDN    sha256:    ${cdnCCBinaryHash || '(none)'}`);

  const versionDiffers = localCCVersion !== cdnCCVersion;
  const hashDiffers = cdnCCBinaryHash ? localBinHash !== cdnCCBinaryHash : false;

  if (!versionDiffers && !hashDiffers) {
    console.log(`    â†’ verdict: SKIP (version and binary hash match CDN)`);
    return null;
  }

  const reasons = [];
  if (versionDiffers) reasons.push(`version ${cdnCCVersion} â†’ ${localCCVersion}`);
  if (hashDiffers) reasons.push('binary content changed');
  console.log(`    â†’ verdict: UPLOAD (${reasons.join(', ')})`);

  const gzName = binaryName === 'claude.exe' ? 'claude.exe.gz' : `claude-${platformKey.split('-')[1]}.gz`;
  const gzPath = path.join(RELEASE_DIR, gzName);
  console.log(`    Compressing â†’ ${gzName} ...`);
  await gzipFile(binPath, gzPath);
  const ccHash = sha256(gzPath);
  const ccSize = fs.statSync(gzPath).size;
  console.log(`    gz size:          ${(ccSize / 1024 / 1024).toFixed(1)} MB (${ccSize} bytes)`);
  console.log(`    gz sha256:        ${ccHash}`);

  return {
    localCCVersion,
    localBinHash,
    gzPath,
    gzName: binaryName === 'claude.exe' ? 'claude.exe.gz' : 'claude.gz',
    ccHash,
    ccSize,
  };
}

function getLocalCodexVersion(platformKey, binaryName = 'codex') {
  const binPath = path.join(PROJECT_ROOT, 'apps', 'codex-bin', platformKey, binaryName);
  if (!fs.existsSync(binPath)) return null;
  try { fs.chmodSync(binPath, 0o755); } catch {}
  try {
    const output = execSync(`"${binPath}" --version`, { encoding: 'utf8', timeout: 10000 });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch (err) {
    console.warn(`    WARN: failed to exec ${binPath} --version: ${err.message}`);
    return null;
  }
}

export async function maybeBuildCodexGz({ platformKey, manifest, binaryName }) {
  const localCodexVersion = getLocalCodexVersion(platformKey, binaryName);
  const cdnCodexVersion = manifest.codex?.version || '0.0.0';
  const cdnCodexBinaryHash = manifest.codex?.binarySha256 || '';

  console.log(`\n==> Codex compare (${platformKey})`);
  if (!localCodexVersion) {
    console.log('    SKIP: local bin missing or --version failed');
    return null;
  }

  const binPath = path.join(PROJECT_ROOT, 'apps', 'codex-bin', platformKey, binaryName);
  const binSize = fs.statSync(binPath).size;
  const localBinHash = sha256(binPath);

  console.log(`    bin path:         ${binPath}`);
  console.log(`    bin size:         ${(binSize / 1024 / 1024).toFixed(1)} MB (${binSize} bytes)`);
  console.log(`    local  version:   ${localCodexVersion}`);
  console.log(`    local  sha256:    ${localBinHash}`);
  console.log(`    CDN    version:   ${cdnCodexVersion}`);
  console.log(`    CDN    sha256:    ${cdnCodexBinaryHash || '(none)'}`);

  const versionDiffers = localCodexVersion !== cdnCodexVersion;
  const hashDiffers = cdnCodexBinaryHash ? localBinHash !== cdnCodexBinaryHash : false;

  if (!versionDiffers && !hashDiffers) {
    console.log('    -> verdict: SKIP (version and binary hash match CDN)');
    return null;
  }

  const reasons = [];
  if (versionDiffers) reasons.push(`version ${cdnCodexVersion} -> ${localCodexVersion}`);
  if (hashDiffers) reasons.push('binary content changed');
  console.log(`    -> verdict: UPLOAD (${reasons.join(', ')})`);

  // Keep the local temp artifact platform-qualified so parallel/staged release
  // runs do not clobber each other, but publish the canonical CDN object name
  // (`codex.gz`) to match the existing Claude manifest convention.
  const gzPath = path.join(RELEASE_DIR, binaryName === 'codex.exe' ? 'codex.exe.gz' : `codex-${platformKey.split('-')[1]}.gz`);
  console.log(`    Compressing -> ${path.basename(gzPath)} ...`);
  await gzipFile(binPath, gzPath);
  const codexHash = sha256(gzPath);
  const codexSize = fs.statSync(gzPath).size;
  console.log(`    gz size:          ${(codexSize / 1024 / 1024).toFixed(1)} MB (${codexSize} bytes)`);
  console.log(`    gz sha256:        ${codexHash}`);

  return {
    localCodexVersion,
    localBinHash,
    gzPath,
    gzName: binaryName === 'codex.exe' ? 'codex.exe.gz' : 'codex.gz',
    codexHash,
    codexSize,
  };
}

// â”€â”€ é˜¿é‡Œäº‘ OSS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// createOSSClient / uploadToOSS / getAKSK å·²ç§»è‡³ scripts/shared/oss.mjs(é¡¶éƒ¨ re-export);
// ä¸‹æ–¹ immutable å®ˆå«é€šè¿‡ re-export çš„ uploadToOSS / sha256 å¤ç”¨å®ƒä»¬ã€‚

// â”€â”€ ç‰ˆæœ¬åŒ–äºŒè¿›åˆ¶å¯¹è±¡ immutable å®ˆå« â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// äº‹æ•…èƒŒæ™¯ (2026-07-03): claude-code/2.1.198/win32-x64/claude.exe.gz åœ¨å‰åŽä¸¤æ¬¡å‘ç‰ˆ
// ä¸­è¢«é‡å¤ gzip + è¦†ç›–ä¸Šä¼ åˆ°åŒä¸€ OSS è·¯å¾„ã€‚gzip è¾“å‡ºä¸å¯å¤çŽ°(åŒä¸€ exe ä¸¤æ¬¡åŽ‹ç¼©å­—èŠ‚
// ä¸åŒ),manifest æŒ‡å‘ç¬¬äºŒæ¬¡çš„ sha256,è€Œå†…ç½‘ CDN è¾¹ç¼˜èŠ‚ç‚¹ä»ç¼“å­˜ç¬¬ä¸€æ¬¡çš„å­—èŠ‚ â†’
// å®¢æˆ·ç«¯ä¸‹è½½åŽ sha256 æ ¡éªŒå¿…å¤±è´¥,å†…ç½‘ Windows ç”¨æˆ·å…¨éƒ¨ã€ŒçŽ¯å¢ƒåˆå§‹åŒ–å¤±è´¥ã€ã€‚
//
// åŽŸåˆ™:å¸¦ç‰ˆæœ¬å·çš„ OSS è·¯å¾„(claude-code/<ver>/... codex/<ver>/... ripgrep/<ver>/...)
// ä¸€ç»ä¸Šä¼ å³è§†ä¸º immutable,å‘å¸ƒäºŒè¿›åˆ¶ä¸€å¾‹èµ°æœ¬å®ˆå«,ä¸è¦ç›´æŽ¥ uploadToOSS:
//   - è¿œç«¯ä¸å­˜åœ¨           â†’ æ­£å¸¸ä¸Šä¼ ,å¹¶å†™ x-oss-meta-{gz,binary}-sha256,åŽç»­å¤æ ¸å…ä¸‹è½½
//   - è¿œç«¯å­˜åœ¨ä¸”äºŒè¿›åˆ¶åŒæº â†’ ä¸ä¸Šä¼ ,å¤ç”¨è¿œç«¯å¯¹è±¡çš„ sha256/size å†™ manifestã€‚ç”¨æˆ·å®žé™…
//                           ä¸‹è½½çš„æ˜¯è¿œç«¯å­—èŠ‚,manifest å¿…é¡»æè¿°è¿œç«¯å¯¹è±¡,è€Œä¸æ˜¯æœ¬åœ°é‡åŽ‹
//                           çš„"ç­‰ä»·"æ–‡ä»¶;åŒæºä¸Žå¦ä»¥è§£åŽ‹åŽäºŒè¿›åˆ¶ sha256 ä¸ºå‡†(gz å­—èŠ‚
//                           å›  gzip ä¸å¯å¤çŽ°æ²¡æœ‰æ¯”è¾ƒæ„ä¹‰)
//   - è¿œç«¯å­˜åœ¨ä¸”äºŒè¿›åˆ¶ä¸åŒ â†’ å†²çª(åŒä¸€ç‰ˆæœ¬å·å‡ºçŽ°ä¸¤ç§å†…å®¹,ä¾‹å¦‚ä¸Šæ¸¸é‡æ‰“äº† binary æ²¡
//                           bump ç‰ˆæœ¬)ã€‚é»˜è®¤æŠ›é”™æ‹’ç»;ä»… force=true æ—¶è¦†ç›–,ä¸”è¦†ç›–åŽ
//                           å¿…é¡»äººå·¥åˆ·æ–°å†…å¤–ç½‘ CDN ç¼“å­˜(å‘Šè­¦ä¼šæ‰“å°å…·ä½“ URL)ã€‚
//                           æ³¨æ„:åŒæºåœºæ™¯å³ä½¿ force ä¹Ÿèµ°å¤ç”¨â€”â€”è¦†ç›–ç­‰ä»·å­—èŠ‚æ²¡æœ‰ä»»ä½•
//                           æ”¶ç›Š,åªä¼šé‡æ–°åˆ¶é€  manifest ä¸Ž CDN è¾¹ç¼˜ç¼“å­˜çš„å­—èŠ‚åˆ†è£‚ã€‚
//
// 2026-07 ä¹‹å‰ä¸Šä¼ çš„è¿œç«¯è€å¯¹è±¡æ²¡æœ‰ sha meta,æ­¤æ—¶æŠŠ gz ä¸‹è½½å›žæ¥è§£åŽ‹è®¡ç®—â€”â€”åªå‘ç”Ÿ
// åœ¨åŒç‰ˆæœ¬å¤å‘å¸ƒçš„ä½Žé¢‘è·¯å¾„,ç”¨ä¸€æ¬¡ä¸‹è½½æ¢ç¡®å®šæ€§æ˜¯å€¼å¾—çš„ã€‚

async function headVersionedGz(client, ossKey) {
  try {
    const res = await client.head(ossKey);
    const headers = res?.res?.headers ?? {};
    const meta = res?.meta ?? {};
    return {
      gzSha256: meta['gz-sha256'] ?? headers['x-oss-meta-gz-sha256'] ?? null,
      binarySha256: meta['binary-sha256'] ?? headers['x-oss-meta-binary-sha256'] ?? null,
      gzSize: Number(headers['content-length']) || 0,
    };
  } catch (err) {
    const status = err?.status ?? err?.res?.status;
    if (status === 404 || err?.code === 'NoSuchKey') return null;
    throw err;
  }
}

async function computeRemoteGzInfo(client, ossKey) {
  const tmpGz = path.join(os.tmpdir(), `xdt-immutable-check-${process.pid}-${Date.now()}.gz`);
  const tmpBin = `${tmpGz}.bin`;
  try {
    await client.get(ossKey, tmpGz);
    const gzSha256 = sha256(tmpGz);
    const gzSize = fs.statSync(tmpGz).size;
    await pipeline(fs.createReadStream(tmpGz), createGunzip(), fs.createWriteStream(tmpBin));
    const binarySha256 = sha256(tmpBin);
    return { gzSha256, gzSize, binarySha256 };
  } finally {
    try { fs.unlinkSync(tmpGz); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpBin); } catch { /* ignore */ }
  }
}

/**
 * ä¸Šä¼ ç‰ˆæœ¬åŒ– .gz åˆ° OSS,éµå®ˆ immutable å®ˆå«(è§ä¸Šæ–¹å¤§æ³¨é‡Š)ã€‚
 *
 * @returns {{ uploaded: boolean, gzSha256: string, gzSize: number, binarySha256: string }}
 *   å†™å…¥ manifest æ—¶å¿…é¡»ä½¿ç”¨è¿”å›žå€¼é‡Œçš„ gzSha256/gzSize/binarySha256(reuse åœºæ™¯ä¸‹æ˜¯
 *   è¿œç«¯å¯¹è±¡çš„å€¼,ä¸Žæœ¬åœ°æ–°åŽ‹çš„ gz ä¸åŒ),ä¸è¦ç»§ç»­ç”¨æœ¬åœ°è®¡ç®—çš„å€¼ã€‚
 * @throws è¿œç«¯å­˜åœ¨ä¸åŒå†…å®¹ä¸”æœª force æ—¶æŠ›é”™(è°ƒç”¨æ–¹æŒ‰å„è‡ªæµç¨‹ä¸­æ­¢/æ ‡è®°å¤±è´¥)ã€‚
 */
export async function uploadVersionedGzImmutable({
  client,
  ossKey,
  gzPath,
  gzSha256,
  gzSize,
  binarySha256,
  force = false,
}) {
  let remote = await headVersionedGz(client, ossKey);

  // meta ç¼ºå¤±/ä¸å®Œæ•´(2026-07 ä¹‹å‰çš„è€å¯¹è±¡)æˆ– HEAD æœªè¿”å›ž content-length(gzSize=0)
  // â†’ ä¸‹è½½å¤æ ¸,ä¿è¯ reuse æ—¶å†™è¿› manifest çš„ä¸€å®šæ˜¯è¿œç«¯å¯¹è±¡çš„çœŸå®žå“ˆå¸Œä¸Žä½“ç§¯,ç»ä¸å›žé€€
  // ç”¨æœ¬åœ°å€¼å‡‘æ•°ã€ä¹Ÿç»ä¸è®© size:0 è¿› manifest(å®¢æˆ·ç«¯ downloader æŒ‰ size å¼ºæ ¡éªŒ,
  // size é”™ = è¯¥èµ„äº§å¯¹å…¨ä½“ç”¨æˆ·ä¸‹è½½å¿…å¤±è´¥,ä¸Žæœ¬æ¬¡äº‹æ•…åŒçº§)ã€‚
  if (remote && (!remote.binarySha256 || !remote.gzSha256 || !remote.gzSize)) {
    console.log(`    immutable guard: remote object missing sha meta or size â€” downloading to verify: ${ossKey}`);
    remote = await computeRemoteGzInfo(client, ossKey);
  }

  if (remote && remote.binarySha256 === binarySha256) {
    console.log(`    immutable guard: ${ossKey} already holds the same binary â€” reusing remote sha256/size, no upload`);
    return { uploaded: false, gzSha256: remote.gzSha256, gzSize: remote.gzSize, binarySha256: remote.binarySha256 };
  }

  if (remote) {
    const rel = ossKey.startsWith(`${OSS_PREFIX}/`) ? ossKey.slice(OSS_PREFIX.length + 1) : ossKey;
    if (!force) {
      throw new Error(
        `immutable guard: ${ossKey} already exists with DIFFERENT binary content ` +
        `(remote binary sha256 ${remote.binarySha256} != local ${binarySha256}). ` +
        `ç‰ˆæœ¬åŒ–è·¯å¾„ä¸å…è®¸è¦†ç›–ä¸Šä¼ â€”â€”è¦†ç›–ä¼šä¸Ž CDN è¾¹ç¼˜ç¼“å­˜äº§ç”Ÿå­—èŠ‚åˆ†è£‚,å¯¼è‡´å®¢æˆ·ç«¯ sha256 æ ¡éªŒå¤±è´¥ ` +
        `(2026-07-03 äº‹æ•…)ã€‚ç¡®è®¤è¿œç«¯å†…å®¹ç¡®å®žè¿‡æœŸæ—¶,ç”¨å¯¹åº” release-*.mjs åŠ  --force è¦†ç›–,` +
        `è¦†ç›–åŽå¿…é¡»åˆ·æ–°å†…å¤–ç½‘ CDN è¯¥ URL çš„ç¼“å­˜ã€‚`,
      );
    }
    console.warn(`    !! FORCE overwrite of existing versioned object: ${ossKey}`);
    console.warn('    !! ä¸Šä¼ å®ŒæˆåŽå¿…é¡»æ‰‹åŠ¨åˆ·æ–°å†…å¤–ç½‘ CDN ç¼“å­˜,å¦åˆ™è¾¹ç¼˜èŠ‚ç‚¹ä¼šç»§ç»­ä¸‹å‘æ—§å­—èŠ‚:');
    console.warn(`       - ${CDN_BASE}/${rel}`);
    console.warn('       - ä»¥åŠå‘å¸ƒæ–¹å†…ç½‘ CDN åŸŸåä¸‹çš„åŒè·¯å¾„(å¦‚æœ‰)');
  }

  await uploadToOSS(client, ossKey, gzPath, {
    meta: { 'gz-sha256': gzSha256, 'binary-sha256': binarySha256 },
  });
  return { uploaded: true, gzSha256, gzSize, binarySha256 };
}

