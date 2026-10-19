import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

test('Router models persist per provider and are used by provider requests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mengel-models-'));
  const names = ['SAND_DATA_ROOT', 'CODEX_HOME', 'CLAUDE_CODE_PATH', 'SAND_CODEX_MODEL', 'SAND_CLAUDE_MODEL', 'SAND_OPENROUTER_MODEL'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, {SAND_DATA_ROOT: root, CODEX_HOME: root, CLAUDE_CODE_PATH: process.execPath, SAND_CODEX_MODEL: 'default-codex', SAND_CLAUDE_MODEL: 'default-claude', SAND_OPENROUTER_MODEL: 'vendor/default'});
  try {
    const output = path.join(root, 'module.mjs');
    await build({ stdin: { contents: `export { SandSettingsStore } from './source/shared/node/settings/sand-settings-store.ts'; export { configuredInferenceModel, configuredInferenceEffort, runRoutedProviderText } from './source/host/extensions/inference/provider-session.ts'; export { inferenceModelCatalog } from './source/shared/node/inference-router-models.ts';`, resolveDir: process.cwd() },
      outfile: output, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'provider-fixtures', setup(builder) {
        builder.onResolve({filter: /^@anthropic-ai\/claude-agent-sdk$/}, () => ({path: 'claude', namespace: 'fixture'}));
        builder.onResolve({filter: /codex-direct-responses\.js$/}, () => ({path: 'codex', namespace: 'fixture'}));
        builder.onLoad({filter: /.*/, namespace: 'fixture'}, ({path: provider}) => ({contents: provider === 'claude' ? `
          export async function* query({options}) { yield {type: 'result', subtype: 'success', result: options.model + ":" + options.extraArgs?.effort, usage: {input_tokens: 1, output_tokens: 1}, session_id: 'test', total_cost_usd: 0}; }
        ` : `export async function* streamCodexDirectResponses(options) { if (options.tools?.length && options.maxSteps < 13) throw new Error('Router prevented a twelve-tool-round task from finishing'); yield {type: 'text-delta', delta: options.model + ":" + options.reasoningEffort + (options.fastMode ? ":fast" : "")}; yield {type:'done', usage: {inputTokens:1, outputTokens:1}, responseId:'test'}; }` }));
      } }] });
    const {SandSettingsStore, configuredInferenceModel, configuredInferenceEffort, runRoutedProviderText, inferenceModelCatalog} = await import(pathToFileURL(output));
    await writeFile(path.join(root,'auth.json'), JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture',refresh_token:'fixture',id_token:'fixture',account_id:'fixture'}}), {mode:0o600});
    const settings = new SandSettingsStore(path.join(root, 'settings.json'));
    assert.equal(settings.getCodexFastMode(), false);
    assert.throws(()=>settings.setCodexFastMode('true'), /on or off/);
    for (const [provider, selected] of [['codex','chosen-codex'],['claude-code','chosen-claude'],['openrouter','vendor/chosen']]) settings.setInferenceModel(provider, selected);
    settings.setInferenceProvider('claude-code');
    settings.setInferenceEffort('codex','high');
    settings.setInferenceEffort('claude-code','max');
    settings.setInferenceEffort('openrouter','low');
    const reloaded = new SandSettingsStore(path.join(root,'settings.json'));
    assert.deepEqual(reloaded.getInferenceModels(), {codex:'chosen-codex','claude-code':'chosen-claude',openrouter:'vendor/chosen'});
    assert.equal(await runRoutedProviderText('codex',[{role:'user',content:'hi'}]), 'chosen-codex:high');
    assert.equal(await runRoutedProviderText('codex',[{role:'user',content:'Inspect twelve items'}], {tools:[{name:'inspect',inputSchema:{type:'object'}}],executeTool:async()=>({})}), 'chosen-codex:high');
    settings.setCodexFastMode(true);
    assert.equal(new SandSettingsStore(path.join(root,'settings.json')).getCodexFastMode(),true);
    assert.equal(await runRoutedProviderText('codex',[{role:'user',content:'hi'}]),'chosen-codex:high:fast');
    assert.equal(settings.getInferenceEffort('codex'),'high');
    settings.setInferenceProvider('openrouter');
    assert.equal(settings.getCodexFastMode(),true,'switching providers preserves the Codex preference');
    settings.setCodexFastMode(false);
    assert.equal(await runRoutedProviderText('codex',[{role:'user',content:'hi'}]),'chosen-codex:high');
    assert.equal(await runRoutedProviderText('claude-code',[{role:'user',content:'hi'}]), 'chosen-claude:max');
    assert.equal(configuredInferenceModel('openrouter'), 'vendor/chosen');
    assert.equal(configuredInferenceEffort('openrouter'), 'low');
    assert.deepEqual(reloaded.getInferenceEfforts(),{codex:'high','claude-code':'max',openrouter:'low'});
    reloaded.setInferenceEffort('claude-code',null);
    assert.equal(configuredInferenceEffort('claude-code'),undefined);
    assert.throws(()=>reloaded.setInferenceEffort('codex','invalid'), /valid effort/);
    reloaded.setInferenceModel('codex', null);
    assert.equal(configuredInferenceModel('codex'), 'default-codex');
    assert.equal(configuredInferenceModel('claude-code'), 'chosen-claude');
    assert.throws(() => reloaded.setInferenceModel('codex','bad model\n'), /valid model/);
    assert.throws(() => reloaded.setInferenceModel('cursor','unsupported'), /valid model/);
    await writeFile(path.join(root,'models_cache.json'),JSON.stringify({models:[{slug:'visible-model',display_name:'Visible',visibility:'list'},{slug:'hidden-model',visibility:'hide'},{slug:'bad model',visibility:'list'}]}));
    const catalog = inferenceModelCatalog(reloaded.getInferenceModels());
    assert.ok(catalog.modelOptions.codex.some(option => option.value === 'visible-model'));
    assert.ok(!catalog.modelOptions.codex.some(option => option.value === 'hidden-model' || option.value === 'bad model'));
    assert.ok(catalog.modelOptions.openrouter.some(option => option.value === 'vendor/chosen'));
    assert.equal(catalog.modelDefaults.codex,'default-codex');
    const claudeCatalog = inferenceModelCatalog({'claude-code':'opus'}, [
      {value:'default',resolvedModel:'claude-opus-5[1m]',displayName:'Default',description:'Opus 5 with 1M context · General tasks'},
      {value:'opus[1m]',resolvedModel:'claude-opus-5[1m]',displayName:'Opus',description:'Most capable for ambitious work'},
      {value:'haiku',resolvedModel:'claude-haiku-4-5-20251001',displayName:'Haiku',description:'Haiku 4.5 · Quick tasks'},
    ]);
    assert.equal(claudeCatalog.modelOptions['claude-code'].find(option=>option.value==='opus').label,'Opus 5');
    assert.deepEqual(claudeCatalog.modelOptions['claude-code'].filter(option=>option.value==='claude-opus-5[1m]'),[{value:'claude-opus-5[1m]',label:'Opus 5',detail:'1M context',group:'models'}]);
    assert.equal(claudeCatalog.modelOptions['claude-code'].find(option=>option.value==='claude-haiku-4-5-20251001').label,'Haiku 4.5');
    const latest=claudeCatalog.modelOptions['claude-code'].find(option=>option.value==='claude-opus-5-5');
    assert.equal(latest.label,'Opus 5.5');
    assert.equal(latest.detail,'1M context');
    reloaded.setInferenceModel('claude-code',latest.value);
    reloaded.setInferenceEffort('claude-code','high');
    assert.equal(await runRoutedProviderText('claude-code',[{role:'user',content:'hi'}]),'claude-opus-5-5:high');
    reloaded.setInferenceModel('claude-code','claude-opus-5[1m]');
    assert.equal(configuredInferenceModel('claude-code'),'claude-opus-5[1m]');
    assert.equal(inferenceModelCatalog().modelOptions['claude-code'].find(option=>option.value==='opus').badge,'Auto');

  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    await rm(root, {recursive:true,force:true});
  }
});
