import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertValidSandAgentId } from "../../storage/agent-paths.js";
import { isSafeFolderId } from "../../storage/folder-id.js";
import { memoryRecallRank, parseExtractedMemories, selectRelevantMemories } from "../../runner/sand-memory.js";
import { AgentProjectMembership } from "./project-membership.js";
import { FileMemoryStore, getAgentMemoryDir, getProjectDir, getProjectMemoryShardDir, getUserMemoryShardDir, type MemoryRecord, type SynthesisChange } from "./memory-service.js";

const debounce = { name: "routed-memory", wrap: <T extends (...args: never[]) => unknown>(fn: T) => Object.assign(fn, { dispose() {} }) };
type Row = MemoryRecord & { scope: string; via: string; project?: string };
const record = (value: unknown): Record<string, any> => {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected memory arguments");
  return value as Record<string, any>;
};
function text(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must contain 1–${max} characters`);
  return value.trim();
}
function names(path: string): string[] { try { return readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory() && isSafeFolderId(e.name)).map(e => e.name).sort(); } catch { return []; } }

/** Uses the same host-side files as native memory and Settings → Memories. */
export function createRoutedMemoryService(options: { sandRoot: string; agentsRootDir: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const store = (path: string) => new FileMemoryStore(path, debounce, { isEnabled: () => true, record() {} });
  return (raw: unknown): Record<string, unknown> => {
    const request = record(raw);
    const agentId = text(request.agentId, "agentId", 128);
    assertValidSandAgentId(agentId);
    const agentDir = join(options.agentsRootDir, agentId);
    if (!existsSync(agentDir)) throw new Error("Unknown memory agent");
    const own = store(getAgentMemoryDir(agentDir));
    const membership = new AgentProjectMembership(agentDir);
    const projectSlug = (value: unknown): string => {
      const slug = text(value, "project", 64);
      if (!isSafeFolderId(slug)) throw new Error("Invalid project slug");
      return slug;
    };
    const scopedStore = (args: Record<string, any>) => {
      const scope = args.scope ?? "agent";
      if (scope === "agent") return own;
      if (scope === "user") return store(getUserMemoryShardDir(options.sandRoot, agentId));
      if (scope !== "project") throw new Error("Unknown memory scope");
      const slug = projectSlug(args.project);
      if (!membership.read().has(slug) || !existsSync(getProjectDir(options.sandRoot, slug))) throw new Error("Join the project before accessing its memory");
      return store(getProjectMemoryShardDir(options.sandRoot, slug, agentId));
    };
    const rows = (): Row[] => {
      const from = (s: FileMemoryStore, scope: string, via: string, project?: string): Row[] => s.listMemories(10_000).map(m => ({ ...m, scope, via, ...(project ? { project } : {}) }));
      const result = from(own, "agent", agentId);
      for (const id of names(join(options.sandRoot, "user-memory", "agents"))) result.push(...from(store(getUserMemoryShardDir(options.sandRoot, id)), "user", id));
      for (const slug of [...membership.read()].sort()) for (const id of names(join(getProjectDir(options.sandRoot, slug), "memory", "agents"))) result.push(...from(store(getProjectMemoryShardDir(options.sandRoot, slug, id)), "project", id, slug));
      return result;
    };
    if (request.operation === "context") {
      const all = rows(), query = typeof request.query === "string" ? request.query.slice(0, 8_000) : "";
      const selected: Row[] = [];
      for (const scope of ["agent", "project", "user"]) {
        const candidates = all.filter(m => m.scope === scope);
        const relevant = selectRelevantMemories(query, candidates, 12) as Row[];
        const profiles = candidates.filter(m => m.kind === "profile").slice(0, scope === "agent" ? 50 : 25);
        const recent = candidates.filter(m => m.kind === "log").sort((a, b) => memoryRecallRank(b) - memoryRecallRank(a)).slice(0, 10);
        for (const m of [...relevant, ...profiles, ...recent]) if (!selected.includes(m)) selected.push(m);
      }
      let budget = 16_000;
      const facts = selected.filter(m => { budget -= JSON.stringify(m).length; return budget >= 0; });
      return { available: true, facts, projects: [...membership.read()], omitted: all.length - facts.length };
    }
    if (request.operation === "extraction-context") return { ...own.prepareSynthesis() };
    if (request.operation === "apply-extraction") {
      const current = own.prepareSynthesis();
      if (request.fingerprint !== current.fingerprint) return { outcome: "stale" };
      const extraction = parseExtractedMemories(text(request.text, "extraction", 12_000), current.memories.map(m => m.content));
      const changes: SynthesisChange[] = extraction.removals.flatMap(content => {
        const match = current.memories.find(m => m.content === content && m.origin !== "explicit");
        return match ? [{ action: "remove" as const, id: match.id }] : [];
      });
      changes.push(...extraction.additions.slice(0, 8).map(m => ({ action: "create" as const, content: m.content, kind: m.kind })));
      return { outcome: own.applySynthesis(current, changes, now()) };
    }
    if (request.operation !== "tool") throw new Error("Unknown memory operation");
    const args = record(request.args);
    if (request.name === "memory_search") {
      if (args.scope !== undefined && !["agent", "user", "project"].includes(args.scope)) throw new Error("Unknown memory scope");
      const query = typeof args.query === "string" ? args.query.trim().slice(0, 2000) : "";
      const candidates = rows().filter(m => (!args.scope || m.scope === args.scope) && (!args.project || m.project === args.project));
      const matches = query ? selectRelevantMemories(query, candidates, 50) : candidates.slice(0, 50);
      return { memories: matches, total: candidates.length, projects: [...membership.read()] };
    }
    if (request.name === "memory_write" || request.name === "memory_forget") {
      const target = scopedStore(args), content = text(args.content, "content");
      if (request.name === "memory_forget") return { forgotten: target.removeMemoryByContent(content) };
      const tier = args.tier ?? "profile";
      if (!["profile", "log", "note"].includes(tier)) throw new Error("Unknown memory tier");
      const fact = tier === "note" ? `[note] ${content}` : content;
      if (fact.length > 500) throw new Error("Memory including its note prefix exceeds 500 characters");
      const saved = target.addMemory(fact, now(), tier === "profile" ? "profile" : "log");
      return { saved: true, alreadyRecorded: saved == null, content: saved?.content ?? fact };
    }
    if (request.name === "memory_project") {
      if (args.action === "list") return { joined: [...membership.read()], available: names(join(options.sandRoot, "projects")) };
      const slug = projectSlug(args.project), path = getProjectDir(options.sandRoot, slug);
      if (args.action === "leave") return { left: membership.leave(slug) };
      if (args.action === "create") {
        const name = text(args.name, "name", 100);
        if (!existsSync(path)) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "project.md"), `---\nname: ${JSON.stringify(name)}\ndescription: ""\n---\n`, { mode: 0o600 }); }
      } else if (args.action !== "join") throw new Error("Unknown project action");
      if (!existsSync(path)) throw new Error("Unknown project");
      return { joined: membership.join(slug) };
    }
    throw new Error("Unknown memory tool");
  };
}
