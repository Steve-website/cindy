import os from "node:os";
import path from "node:path";

/** Desktop dev æ”¯æŒçš„åŒºåŸŸèº«ä»½ã€‚ */
export const DESKTOP_DEV_REGIONS = Object.freeze(["cn", "global", "dev"]);

/**
 * ä¸Ž packages/maker-shared/src/brandIdentity.ts çš„ userDataDirNameByRegion é•œåƒã€‚
 * .mjs å¯åŠ¨å™¨ä¸èƒ½ç›´æŽ¥ import TSï¼›åŒæ­¥å…³ç³»ç”± brand-identity-sync.test.mjs é”ä½ã€‚
 */
export const DESKTOP_USER_DATA_DIR_NAME_BY_REGION = Object.freeze({
  cn: "Echo",
  global: "EchoGlobal",
  dev: "EchoDev",
});

/** å…±äº« Desktop profile çš„åŒºåŸŸç›®å½•åï¼›çœç•¥åŒºåŸŸæ—¶éµå¾ªäº§å“è§„åˆ™é»˜è®¤ Globalã€‚ */
export function desktopUserDataDirNameForRegion(region = "global") {
  if (!DESKTOP_DEV_REGIONS.includes(region)) {
    throw new Error(
      `invalid desktop dev region: ${region}; expected cn, global or dev`,
    );
  }
  return DESKTOP_USER_DATA_DIR_NAME_BY_REGION[region];
}

/** è®¡ç®—ä¸Ž Electron app.getPath('userData') å¯¹é½çš„åŒºåŸŸ profile è·¯å¾„ã€‚ */
export function desktopUserDataDirForRegion(
  region = "global",
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
) {
  const dirName = desktopUserDataDirNameForRegion(region);
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  switch (platform) {
    case "darwin":
      return pathImpl.join(homeDir, "Library", "Application Support", dirName);
    case "win32":
      return pathImpl.join(
        env.APPDATA || pathImpl.join(homeDir, "AppData", "Roaming"),
        dirName,
      );
    case "linux":
      return pathImpl.join(
        env.XDG_CONFIG_HOME || pathImpl.join(homeDir, ".config"),
        dirName,
      );
    default:
      throw new Error(`unsupported platform: ${platform}`);
  }
}

/**
 * è§£æž desktop dev åŒºåŸŸã€‚å‘½ä»¤è¡Œæ˜¾å¼å€¼ä¼˜å…ˆï¼Œä¿ç•™ CINDY_AUTH_REGION ä½œä¸º
 * CI / è€è„šæœ¬å…¼å®¹å…¥å£ï¼›æ— é…ç½®æ—¶é»˜è®¤ Globalã€‚
 */
export function resolveDesktopDevRegion(argv, env = process.env) {
  let cliRegion;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    let value;
    if (arg === "--region") {
      value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--region requires a value: cn, global or dev");
      }
      index += 1;
    } else if (arg.startsWith("--region=")) {
      value = arg.slice("--region=".length);
      if (!value)
        throw new Error("--region requires a value: cn, global or dev");
    } else {
      continue;
    }

    if (cliRegion !== undefined) {
      throw new Error("--region may only be specified once");
    }
    cliRegion = value;
  }

  const region = (cliRegion ?? env.CINDY_AUTH_REGION?.trim()) || "global";
  if (!DESKTOP_DEV_REGIONS.includes(region)) {
    throw new Error(
      `invalid desktop dev region: ${region}; expected cn, global or dev`,
    );
  }
  return region;
}

/** ä»Žä¼ ç»™ Electron Forge çš„ argv ä¸­ç§»é™¤å·²ç”± dev wrapper æ¶ˆè´¹çš„åŒºåŸŸå‚æ•°ã€‚ */
export function stripDesktopDevRegionArgs(argv) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--region") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--region=")) continue;
    result.push(arg);
  }
  return result;
}

/**
 * è®¡ç®— desktop dev å¯åŠ¨é…ç½®ã€‚remote dev å§‹ç»ˆè¯»å–åŒåŒºåŸŸä»“å†…æ¸…å•ï¼Œ
 * ä¸æŠŠçˆ¶è¿›ç¨‹ç»§æ‰¿çš„ç«¯ç‚¹æ–‡ä»¶å½“æˆç”¨æˆ·è¦†ç›–ï¼›local æ¨¡å¼ä¿ç•™æœ¬åœ°æœåŠ¡æ–‡ä»¶ã€‚
 * --endpoints-cdn / XDT_ENDPOINTS_CDN=1 æ—¶ä¸æ³¨å…¥é»˜è®¤æ–‡ä»¶ï¼Œè®©ä¸»è¿›ç¨‹èµ°åŒºåŸŸåŒ– CDNã€‚
 */
export function resolveDesktopDevStartupConfig({
  argv,
  env = process.env,
  mode = "remote",
}) {
  const region = resolveDesktopDevRegion(argv, env);
  const endpointsCdn =
    argv.includes("--endpoints-cdn") || env.XDT_ENDPOINTS_CDN === "1";
  const endpointManifestFile =
    mode === "remote"
      ? endpointsCdn
        ? undefined
        : `config/${{ cn: "endpoint.json", global: "endpoint.global.json", dev: "endpoint.dev.json" }[region]}`
      : env.XDT_ENDPOINT_MANIFEST_FILE?.trim() || undefined;
  return { region, endpointsCdn, endpointManifestFile };
}

/** æŠŠçº¯è§£æžç»“æžœå†™å…¥å³å°†å¯åŠ¨ desktop dev çš„çŽ¯å¢ƒã€‚ */
export function applyDesktopDevStartupConfig(options) {
  const config = resolveDesktopDevStartupConfig(options);
  const env = options.env ?? process.env;
  env.CINDY_AUTH_REGION = config.region;
  env.VITE_CINDY_AUTH_REGION = config.region;
  if (config.endpointsCdn) env.XDT_ENDPOINTS_CDN = "1";
  if (config.endpointManifestFile) {
    env.XDT_ENDPOINT_MANIFEST_FILE = config.endpointManifestFile;
  } else if (options.mode !== "local") {
    delete env.XDT_ENDPOINT_MANIFEST_FILE;
  }
  return config;
}

