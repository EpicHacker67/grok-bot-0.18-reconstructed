import { spawn } from "node:child_process";
import { LOCAL_DOCKER_BOX_CONTAINER } from "../../shared/box-runtime.js";
import { resolveDockerBinary } from "../../shared/node/remote-docker.js";

// Credentials never cross into a renderer or appear in command arguments.
const REQUEST = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>input+=b);process.stdin.on('end',async()=>{try{const {path,method,body}=JSON.parse(input);const response=await fetch('http://127.0.0.1:8840'+path,{method,headers:{authorization:'Bearer '+process.env.SAND_GATEWAY_TOKEN,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('Media service returned '+response.status);process.stdout.write(response.status===204?'{}':await response.text())}catch(e){console.error(e.message);process.exitCode=1}});`;
function request(path: string, method: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveDockerBinary(), ["exec", "-i", LOCAL_DOCKER_BOX_CONTAINER, "/exec-daemon/node", "-e", REQUEST], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Video connection timed out")); }, 15000);
    child.stdout.on("data", b => { output += b; if (output.length > 128000) child.kill(); });
    child.stderr.on("data", b => { error = (error + b).slice(-500); });
    child.once("error", e => { clearTimeout(timer); reject(e); });
    child.once("close", code => { clearTimeout(timer); if (code !== 0) { reject(new Error(error || "Video unavailable")); return; } try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid video response")); } });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ path, method, body }));
  });
}
export function createRemoteVideoSession() {
  let owner: number | null = null, generation = 0, id: string | null = null;
  const stop = (sender?: number) => {
    if (sender !== undefined && sender !== owner) return;
    generation++; owner = null;
    const previous = id; id = null;
    if (previous) void request(`/session/${previous}`, "DELETE").catch(() => {});
  };
  return {
    stop,
    async start(sender: number, offer: { type?: unknown; sdp?: unknown }) {
      if (!process.env.SAND_DOCKER_GPU_IMAGE) return { supported: false };
      if (offer?.type !== "offer" || typeof offer.sdp !== "string" || offer.sdp.length > 60000) throw new Error("Invalid video offer");
      stop(); owner = sender; const current = generation;
      const answer = await request("/offer", "POST", offer);
      if (typeof answer.id !== "string" || !/^[a-f0-9]{32}$/.test(answer.id) || answer.type !== "answer" || typeof answer.sdp !== "string") throw new Error("Invalid video answer");
      if (generation !== current || owner !== sender) { void request(`/session/${answer.id}`, "DELETE").catch(() => {}); return { supported: false }; }
      id = answer.id;
      return { supported: true, type: "answer" as const, sdp: answer.sdp };
    },
  };
}
