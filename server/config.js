// Settings come from environment variables (or a .env file next to package.json).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = process.env;
const port = +env.PORT || 3000;
const appUrl = (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, "");
const isProd = env.NODE_ENV === "production";

export const config = {
  port,
  appUrl,
  isProd,
  dbFile: env.DB_FILE || fileURLToPath(new URL("../data/hub.db", import.meta.url)),
  secretKey: env.SECRET_KEY || "",
  secureCookies: appUrl.startsWith("https://"),
  ai: {
    key: env.ANTHROPIC_API_KEY || "",
    model: env.AI_MODEL || "claude-haiku-4-5-20251001",
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID || "",
    clientSecret: env.GOOGLE_CLIENT_SECRET || "",
  },
  inbound: {
    secret: env.INBOUND_SECRET || "",
    domain: (env.INBOUND_DOMAIN || "").toLowerCase(),
  },
  defaultTz: env.DEFAULT_TZ || "Europe/Istanbul",
  limits: { signupsPerHour: 8, loginsPer15Min: 10, aiPerHour: 60, inboundPerDay: 300 },
};

export function checkConfig() {
  const problems = [];
  if (!config.secretKey) {
    if (isProd) problems.push("SECRET_KEY is required in production (any long random string).");
    else config.secretKey = "dev-only-insecure-key-change-me";
  } else if (config.secretKey.length < 24) problems.push("SECRET_KEY should be at least 24 characters.");
  if (isProd && !config.secureCookies) problems.push("APP_URL must start with https:// in production.");
  if (config.inbound.domain && !config.inbound.secret) problems.push("INBOUND_SECRET is required when INBOUND_DOMAIN is set.");
  return problems;
}

export const features = () => ({
  ai: !!config.ai.key,
  google: !!(config.google.clientId && config.google.clientSecret),
  forwarding: !!(config.inbound.domain && config.inbound.secret),
});
