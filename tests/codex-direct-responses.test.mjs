import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const result = await build({ entryPoints: [path.join(repoRoot, "source/host/extensions/inference/codex-direct-responses.ts")], bundle: true, write: false, format: "esm", platform: "node", target: "es2022" });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

function sse(events, split = 17) {
  const bytes = new TextEncoder().encode(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += split) controller.enqueue(bytes.slice(offset, offset + split));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("direct Codex Responses transport streams text without an SDK reader", async () => {
  const { streamCodexDirectResponses } = await loadModule();
  const requests = [];
  const fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return sse([
      { type: "response.output_text.delta", delta: "DIRECT_" },
      { type: "response.output_text.delta", delta: "OK" },
      { type: "response.completed", response: { id: "resp-1", output: [{ type: "message", role: "assistant", content: [] }], usage: { input_tokens: 11, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } } }
    ], 5);
  };
  const events = [];
  for await (const event of streamCodexDirectResponses({ fetch, endpoint: "https://example.invalid/responses", model: "gpt-test", instructions: "Grok", input: [{ role: "user", content: "hi" }] })) events.push(event);
  assert.deepEqual(events, [
    { type: "text-delta", delta: "DIRECT_" },
    { type: "text-delta", delta: "OK" },
    { type: "done", text: "DIRECT_OK", responseId: "resp-1", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 } }
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].service_tier, "default", "Fast mode is opt-in");
});

test("direct Codex Responses transport executes Grok Bot tools and continues with the exact call id", async () => {
  const { streamCodexDirectResponses } = await loadModule();
  const requests = [];
  let toolExecution = null;
  const fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    if (requests.length === 1) return sse([
      { type: "response.output_item.done", item: { type: "reasoning", id: "reason-1", encrypted_content: "opaque" } },
      { type: "response.output_item.done", item: { type: "function_call", id: "call-item", call_id: "call-123", name: "gmail_search", arguments: "{\"query\":\"newer_than:1d\"}" } },
      { type: "response.completed", response: { id: "resp-tool", output: [], usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } } } }
    ]);
    return sse([
      { type: "response.output_text.delta", delta: "Subject" },
      { type: "response.completed", response: { id: "resp-final", output: [{ type: "message", role: "assistant", content: [] }], usage: { input_tokens: 8, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } } } }
    ]);
  };
  const source = { providerIdentifier: "user-Gmail", toolName: "search_threads" };
  const events = [];
  for await (const event of streamCodexDirectResponses({
    fetch,
    endpoint: "https://example.invalid/responses",
    model: "gpt-test",
    instructions: "Use connected tools",
    input: [{ role: "user", content: "latest email" }],
    tools: [{ name: "gmail_search", description: "Search Gmail", parameters: { type: "object" }, source }],
    executeTool: async (tool, args, toolCallId) => {
      toolExecution = { tool, args, toolCallId };
      return { result: { case: "success", value: { subject: "Subject" } } };
    }
  })) events.push(event);

  assert.equal(requests.length, 2);
  assert.deepEqual(toolExecution, { tool: { name: "gmail_search", description: "Search Gmail", parameters: { type: "object" }, source }, args: { query: "newer_than:1d" }, toolCallId: "call-123" });
  assert.equal(requests[1].input.at(-2).type, "function_call");
  assert.deepEqual(requests[1].input.at(-1), { type: "function_call_output", call_id: "call-123", output: JSON.stringify({ result: { case: "success", value: { subject: "Subject" } } }) });
  assert.deepEqual(events.at(-1), { type: "done", text: "Subject", responseId: "resp-final", usage: { inputTokens: 28, outputTokens: 6, cacheReadTokens: 6, cacheWriteTokens: 0 } });
});

test("direct Codex Responses transport fails closed on a truncated stream", async () => {
  const { streamCodexDirectResponses } = await loadModule();
  await assert.rejects(async () => {
    for await (const _event of streamCodexDirectResponses({
      fetch: async () => new Response("data: {\"type\":\"response.output_text.delta\"", { status: 200 }),
      endpoint: "https://example.invalid/responses",
      model: "gpt-test",
      instructions: "Grok",
      input: [{ role: "user", content: "hi" }]
    })) {}
  }, /incomplete SSE event/);
});

test("Codex completes a twelve-tool-round task and preserves every result beyond round eight", async () => {
  const { streamCodexDirectResponses } = await loadModule();
  let requests = 0;
  const calls = [], events = [];
  for await (const event of streamCodexDirectResponses({
    endpoint: "https://example.invalid/responses", model: "gpt-test", instructions: "Complete the task",
    fastMode: true, reasoningEffort: "high",
    input: [{ role: "user", content: "Inspect twelve items" }],
    tools: [{ name: "inspect", parameters: { type: "object" }, source: {} }],
    executeTool: async (_tool, args, id) => { calls.push(id); return { item: args.item }; },
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      assert.equal(request.service_tier, "priority", "Fast mode applies to every tool continuation");
      assert.equal(request.reasoning.effort, "high", "Fast mode must preserve effort");
      const results = request.input.filter(item => item.type === "function_call_output");
      assert.deepEqual(results.map(item => [item.call_id, JSON.parse(item.output)]),
        calls.map((id, index) => [id, { item: index + 1 }]));
      requests++;
      const output = requests <= 12
        ? [{ type: "function_call", name: "inspect", call_id: `call-${requests}`, arguments: JSON.stringify({ item: requests }) }]
        : [{ type: "message", role: "assistant", content: [] }];
      return sse([
        ...(requests === 13 ? [{ type: "response.output_text.delta", delta: "All twelve inspected." }] : []),
        { type: "response.completed", response: { id: `response-${requests}`, output, usage: { input_tokens: 10, output_tokens: 1 } } },
      ]);
    },
  })) events.push(event);
  assert.equal(requests, 13);
  assert.equal(calls.length, 12);
  assert.equal(events.at(-1).text, "All twelve inspected.");
  assert.equal(events.at(-1).usage.inputTokens, 130);
});

test("Codex still enforces an explicit round ceiling", async () => {
  const { streamCodexDirectResponses } = await loadModule();
  let requests = 0, executions = 0;
  await assert.rejects(async () => {
    for await (const _event of streamCodexDirectResponses({
      endpoint: "https://example.invalid/responses", model: "gpt-test", instructions: "Test limit", input: [], maxSteps: 2,
      tools: [{ name: "inspect", parameters: { type: "object" }, source: {} }],
      executeTool: async () => { executions++; return {}; },
      fetch: async () => sse([{ type: "response.completed", response: { id: `r-${++requests}`, output: [
        { type: "function_call", name: "inspect", call_id: `c-${requests}`, arguments: "{}" },
      ] } }]),
    })) {}
  }, /Mengel's 2-round limit/);
  assert.equal(requests, 2);
  assert.equal(executions, 2);
});

test('computer screenshots are image content, never base64 inside model text', async () => {
  const { codexToolOutput } = await loadModule();
  const data='iVBOR'.repeat(100_000);
  for(const value of [
    {isError:false,content:[{type:'text',text:'Screen captured'},{type:'image',mimeType:'image/png',data}]},
    {result:{case:'success',value:{isError:false,content:[{content:{case:'image',value:{mimeType:'image/png',data}}}]}}},
  ]) {
    const output=codexToolOutput(value);
    assert.ok(Array.isArray(output));
    assert.equal(output[1].type,'input_image');
    assert.equal(output[1].image_url,'data:image/png;base64,'+data);
    assert.ok(output[0].text.length<500);
    assert.doesNotMatch(output[0].text,/iVBOR/);
    assert.match(output[0].text,/isError/);
  }
  const plain={content:[{type:'text',text:'hello'}]};
  assert.equal(codexToolOutput(plain),JSON.stringify(plain));
});

test('image tool results keep their call id and reach the next model round as images', async () => {
  const { streamCodexDirectResponses } = await loadModule();
  let requests=0;
  for await(const event of streamCodexDirectResponses({
    endpoint:'https://example.invalid',model:'test',instructions:'test',input:[],
    tools:[{name:'computer_screenshot',parameters:{type:'object'},source:{}}],
    executeTool:async()=>({content:[{type:'image',mimeType:'image/png',data:'image-bytes'}]}),
    fetch:async(_url,init)=>{
      if(++requests===1)return sse([{type:'response.completed',response:{id:'first',output:[{type:'function_call',name:'computer_screenshot',call_id:'screen-1',arguments:'{}'}]}}]);
      const result=JSON.parse(init.body).input.at(-1);
      assert.equal(result.call_id,'screen-1');
      assert.equal(result.output[1].type,'input_image');
      assert.doesNotMatch(result.output[0].text,/image-bytes/);
      return sse([{type:'response.completed',response:{id:'last',output:[]}}]);
    },
  })) {}
  assert.equal(requests,2);
});

test('cancellation stops remaining tool calls and prevents another provider request', async () => {
  const { streamCodexDirectResponses } = await loadModule();
  const controller = new AbortController();
  let calls = 0, requests = 0;
  const tool = { name: 'action', parameters: { type: 'object', properties: {} }, source: {} };
  await assert.rejects(async () => {
    for await (const _ of streamCodexDirectResponses({
      signal: controller.signal, endpoint: 'https://example.invalid', model: 'test', instructions: 'test', input: [], tools: [tool],
      fetch: async (_url, init) => {
        requests++; assert.equal(init.signal, controller.signal);
        return sse([{ type: 'response.completed', response: { id: 'r', output: [1, 2].map(i => ({ type: 'function_call', name: 'action', call_id: `c${i}`, arguments: '{}' })) } }]);
      },
      executeTool: async () => { calls++; controller.abort(); throw controller.signal.reason; },
    })) {}
  }, /abort/i);
  assert.equal(calls, 1);
  assert.equal(requests, 1);
});

test('reasoning and tool argument streaming count as progress without visible answer text', async () => {
  const { streamCodexDirectResponses } = await loadModule();
  let progress = 0;
  for await (const _ of streamCodexDirectResponses({
    endpoint: 'https://example.invalid', model: 'test', instructions: 'test', input: [], onProgress: () => progress++,
    fetch: async () => sse([
      { type: 'heartbeat' },
      { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
      { type: 'response.function_call_arguments.delta', delta: '{}' },
      { type: 'response.completed', response: { id: 'r', output: [] } },
    ]),
  })) {}
  assert.equal(progress, 3, 'transport heartbeats must not keep a stalled turn alive');
});
