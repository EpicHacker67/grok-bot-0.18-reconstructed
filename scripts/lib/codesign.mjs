import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { capture, run } from "./process.mjs";

export const AD_HOC_CODESIGN_IDENTITY = "-";
export const NONINTERACTIVE_CODESIGN_STDIO = Object.freeze([
  "ignore",
  "inherit",
  "inherit",
]);

// A stable, self-signed code-signing identity kept in a dedicated keychain.
//
// Ad-hoc signatures ("--sign -") are keyed to the code's content hash, which
// changes on every build, so macOS treats each rebuild as a different app and
// locks it out of the Keychain item that holds the encrypted Cursor session —
// which is why every rebuild used to drop the user back to the sign-in screen.
// Signing with a fixed self-signed certificate makes the app's designated
// requirement stable (`identifier <id> and certificate leaf = H"<cert>"`), so
// keychain trust — and the login session — survive rebuilds.
//
// The certificate lives in its own keychain with a known password so the whole
// flow (create, import, set-key-partition-list) runs non-interactively without
// ever touching the user's login keychain or their login password. The cert is
// self-signed and untrusted by Gatekeeper, which is irrelevant: the app is
// ad-hoc-equivalent for launch (quarantine is stripped at packaging) and this
// only exists to give the keychain a stable identity to trust.
const SIGNING_KEYCHAIN = join(homedir(), "Library", "Keychains", "mengel-codesign.keychain-db");
const SIGNING_KEYCHAIN_PASSWORD = "mengel-local-signing";
const SIGNING_IDENTITY = "Mengel Local Code Signing";
const OPENSSL = "/usr/bin/openssl";
const SECURITY = "/usr/bin/security";

async function fileExists(path) {
  return access(path).then(() => true).catch(() => false);
}

async function keychainInSearchList() {
  const out = await capture(SECURITY, ["list-keychains", "-d", "user"]).catch(() => "");
  return out.includes("mengel-codesign.keychain");
}

async function addKeychainToSearchList() {
  const listed = await capture(SECURITY, ["list-keychains", "-d", "user"]).catch(() => "");
  const current = listed.split("\n").map((line) => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
  await run(SECURITY, ["list-keychains", "-d", "user", "-s", ...current, SIGNING_KEYCHAIN]);
}

async function identityPresent() {
  // Without -v: -v filters to trusted identities and a self-signed cert is not
  // trusted, yet codesign can still sign with it.
  const out = await capture(SECURITY, ["find-identity", "-p", "codesigning", SIGNING_KEYCHAIN]).catch(() => "");
  return out.includes(SIGNING_IDENTITY);
}

async function createSigningCertificate() {
  const dir = await mkdtemp(join(tmpdir(), "mengel-codesign-"));
  try {
    const config = join(dir, "cert.cnf");
    await writeFile(config, [
      "[req]", "distinguished_name=dn", "x509_extensions=v3", "prompt=no",
      "[dn]", `CN=${SIGNING_IDENTITY}`,
      "[v3]", "basicConstraints=critical,CA:false", "keyUsage=critical,digitalSignature", "extendedKeyUsage=critical,codeSigning", "",
    ].join("\n"));
    const key = join(dir, "key.pem"), cert = join(dir, "cert.pem"), bundle = join(dir, "identity.p12");
    await run(OPENSSL, ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "3650", "-nodes", "-config", config]);
    // LibreSSL (the system openssl) writes a macOS-importable PKCS#12 by default.
    await run(OPENSSL, ["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", bundle, "-passout", "pass:mengel", "-name", SIGNING_IDENTITY]);
    await run(SECURITY, ["import", bundle, "-k", SIGNING_KEYCHAIN, "-P", "mengel", "-A", "-T", "/usr/bin/codesign"]);
    await run(SECURITY, ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", SIGNING_KEYCHAIN_PASSWORD, SIGNING_KEYCHAIN]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Ensure the stable signing identity exists and is usable, then return its name.
export async function ensureLocalSigningIdentity() {
  if (!(await fileExists(SIGNING_KEYCHAIN))) {
    await run(SECURITY, ["create-keychain", "-p", SIGNING_KEYCHAIN_PASSWORD, SIGNING_KEYCHAIN]);
    await run(SECURITY, ["set-keychain-settings", SIGNING_KEYCHAIN]); // no auto-lock timeout
  }
  await run(SECURITY, ["unlock-keychain", "-p", SIGNING_KEYCHAIN_PASSWORD, SIGNING_KEYCHAIN]);
  if (!(await keychainInSearchList())) await addKeychainToSearchList();
  if (!(await identityPresent())) await createSigningCertificate();
  return SIGNING_IDENTITY;
}

export function adHocCodesignArguments(target) {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("An explicit application bundle path is required for ad-hoc signing.");
  }
  return [
    "--force",
    "--deep",
    "--timestamp=none",
    "--sign",
    AD_HOC_CODESIGN_IDENTITY,
    target,
  ];
}

export async function signAppBundleAdHoc(target, runCommand = run) {
  await runCommand("/usr/bin/codesign", adHocCodesignArguments(target), {
    stdio: NONINTERACTIVE_CODESIGN_STDIO,
  });
}

// Sign with the stable self-signed identity so keychain trust survives rebuilds.
export async function signAppBundleStable(target, runCommand = run) {
  if (typeof target !== "string" || target.length === 0) {
    throw new TypeError("An explicit application bundle path is required for signing.");
  }
  const identity = await ensureLocalSigningIdentity();
  await runCommand("/usr/bin/codesign", ["--force", "--deep", "--timestamp=none", "--sign", identity, target], {
    stdio: NONINTERACTIVE_CODESIGN_STDIO,
  });
}
