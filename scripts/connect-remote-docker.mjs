import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

// The app owns the container lifecycle. This sets its per-profile transport
// and a reconnecting, login-persistent SSH tunnel for the gateway and desktop.
const [sshHost, remoteRoot, profile] = process.argv.slice(2);
if (process.platform !== "darwin" || !sshHost || !remoteRoot || !profile) {
  throw new Error("Usage (macOS): node scripts/connect-remote-docker.mjs user@host /remote/root /profile/sand-data");
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(sshHost) || !/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(remoteRoot)) throw new Error("Invalid SSH host or remote root.");
const run = (command, args) => execFileSync(command, args, { stdio: "pipe" });
run("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", sshHost, "docker info --format '{{.ServerVersion}}'"]);
const label = "com.mengel.remote-computer-tunnel";
const domain = `gui/${process.getuid()}`;
const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
if (existsSync(plist)) run("/bin/launchctl", ["bootout", domain, plist]);
const ports = [1337, 1339, 1340, 6080, 6081, 8790];
for (const port of ports) await new Promise((ok, fail) => {
  const server = createServer();
  server.once("error", () => fail(new Error(`Local port ${port} is in use; stop the previous computer before connecting.`)));
  server.listen(port, "127.0.0.1", () => server.close(ok));
});
const dataRoot = resolve(profile);
mkdirSync(dataRoot, { recursive: true });
const config = join(dataRoot, "remote-docker.json");
if (existsSync(config)) copyFileSync(config, `${config}.backup`);
writeFileSync(config, JSON.stringify({ sshHost, root: remoteRoot }, null, 2) + "\n", { mode: 0o600 });
const settingsPath = join(dataRoot, "settings.json");
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.before-remote-docker`);
settings.boxRuntime = "local-docker";
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
const args = ["/usr/bin/ssh", "-NT", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", ...ports.flatMap(p => ["-L", `127.0.0.1:${p}:127.0.0.1:${p}`]), sshHost];
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardErrorPath</key><string>${xml(join(dataRoot, "remote-docker-tunnel.log"))}</string>
</dict></plist>\n`);
run("/bin/launchctl", ["bootstrap", domain, plist]);
console.log(`Remote Docker configured for ${sshHost}. Restart Mengel to connect. Config: ${config}`);
