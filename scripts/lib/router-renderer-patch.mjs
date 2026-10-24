import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_BEFORE = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const REGISTRY_AFTER = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"router",label:"Router",icon:"git-branch"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const GENERAL_BEFORE = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null';
const GENERAL_AFTER = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):x==="router"?a.jsx(RRouterPanel,{}):null';
const USAGE_BEFORE = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null';
const USAGE_AFTER = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(RRouterUsage,{})}):null';
const COMPONENT_ANCHOR = 'function Sa(s){';
const ROUTER_STYLES = readFileSync(new URL("./router-settings.css", import.meta.url), "utf8");
const COMPONENT_SOURCE = String.raw`
const RRouterProviders=[
  {value:"cursor",label:"Cursor",description:"Use your signed-in Cursor account.",kind:"account"},
  {value:"claude-code",label:"Claude Code",description:"Use your existing Claude Code sign-in and Grok Bot's connected plugins.",kind:"local",localKey:"claude-code"},
  {value:"codex",label:"Codex",description:"Use your existing ChatGPT sign-in from Codex with Grok Bot's connected plugins.",kind:"local",localKey:"codex"},
  {value:"openrouter",label:"OpenRouter",description:"Route through your OpenRouter account and selected model.",kind:"key",secret:"OPENROUTER_API_KEY"}
],RRouterOptions=RRouterProviders.map(s=>({value:s.value,label:s.label})),RRouterEmptyUsage={requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,lastUsedAt:null},RRouterInputClass="sand-9f619 sand-h8yej3 sand-5f5z56 sand-u97haq sand-lrnmfh sand-uve7l6 sand-16b7oty sand-1rgtt3y sand-o7x2bt sand-mkeg23 sand-1y0btm7 sand-qz0629 sand-1043rbw sand-13l7odt sand-1wd3ewq sand-jb2p0i sand-4z9k3i sand-frs9s4 sand-tt52l0 sand-1odjw0f sand-1t137rt sand-ltfok3";
function RRouterState(){
  const[s,e]=de.useState({provider:"cursor",models:{},modelOptions:{},modelDefaults:{},efforts:{},effortOptions:{},codexFastMode:false,usage:null,local:null,error:null,pending:false});
  de.useEffect(()=>{let t=!0;const n=r=>{t&&e(r.detail)};window.addEventListener("sand-router-provider-changed",n);window.desktop.agent.getInferenceRouter().then(r=>{t&&e({...r,error:null})}).catch(r=>{t&&e(i=>({...i,error:String(r?.message??r)}))});return()=>{t=!1;window.removeEventListener("sand-router-provider-changed",n)}},[]);
  const t=async(n,m,f,fast)=>{const r=s;e(i=>({...i,provider:n,error:null,pending:true}));try{const i=await window.desktop.agent.setInferenceRouter(n,m,f,fast),o={...i,error:null,pending:false};e(o);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:o}));return true}catch(i){e({...r,pending:false,error:String(i?.message??i)});return false}};
  return[s,t]
}
function RRouterSecrets(){const[s,e]=de.useState([]),[t,n]=de.useState(0);de.useEffect(()=>{let r=!0;window.desktop.secrets.list().then(i=>{r&&e(Array.isArray(i?.keys)?i.keys:[])});return()=>{r=!1}},[t]);return[s,()=>n(r=>r+1)]}
function RRouterNumber(s){return new Intl.NumberFormat().format(s)}
function RRouterCredential({provider:s,state:e,keys:t,onSaved:n}){const[r,i]=de.useState(""),[o,l]=de.useState(!1);if(s.kind==="account")return a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Signed in"});if(s.kind==="local"){const c=e.local?.[s.localKey],d=c?.installed&&c?.authenticated;return a.jsx(se,{as:"span",color:d?"primary":"secondary",size:"sm",children:d?"Ready":c?.installed?"Sign in with "+(s.value==="codex"?"codex login":"claude"):"Not installed"})}const c=t.includes(s.secret),d=async()=>{if(r.trim().length===0)return;l(!0);try{await window.desktop.secrets.upsert({[s.secret]:r.trim()}),i(""),n()}finally{l(!1)}};return a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{width:360},children:[a.jsx("input",{"aria-label":s.secret,className:RRouterInputClass,disabled:o,onChange:u=>i(u.currentTarget.value),placeholder:c?"Replace saved key":"Paste API key",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"password",value:r}),a.jsx(oe,{disabled:o||r.trim().length===0,onClick:d,shape:"rectangular",size:"sm",variant:"secondary",children:o?"Saving…":"Save"})]})}
function RRouterUsageRows({usage:s}){return a.jsxs("div",{children:[a.jsx(ie,{label:"Requests",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.requests)})}),a.jsx(ie,{divided:!0,label:"Input tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.inputTokens)})}),a.jsx(ie,{divided:!0,label:"Output tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.outputTokens)})}),a.jsx(ie,{divided:!0,label:"Cache tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.cacheReadTokens+s.cacheWriteTokens)})}),a.jsx(ie,{divided:!0,label:"Last used",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:s.lastUsedAt?new Date(s.lastUsedAt).toLocaleString():"Not used yet"})})]})}
function RBoxRuntime(){const[s,e]=de.useState({mode:"remote",status:null,error:null,busy:!0});de.useEffect(()=>{let t=!0;window.desktop.agent.getBoxRuntime().then(n=>{t&&e({...n,error:null,busy:!1})}).catch(n=>{t&&e(r=>({...r,error:String(n?.message??n),busy:!1}))});return()=>{t=!1}},[]);const t=s.mode==="local-docker",n=async()=>{const r=t?"remote":"local-docker";e(i=>({...i,mode:r,busy:!0,error:null}));try{const i=await window.desktop.agent.setBoxRuntime(r);e({...i,error:null,busy:!1})}catch(i){e(o=>({...o,mode:t?"local-docker":"remote",error:String(i?.message??i),busy:!1}))}};return a.jsxs("div",{children:[a.jsx(ie,{description:t?(s.status?.detail??"Shell, files and computer use run in a Docker container on this Mac."):"Shell, files and computer use run on Grok Bot's remote computer.",label:"Use local Docker VM",variant:"card",children:a.jsx("button",{"aria-checked":t,"aria-label":"Use local Docker VM",disabled:s.busy,onClick:n,role:"switch",style:{appearance:"none",background:t?"var(--color-accent-primary, #4f8cff)":"rgba(255,255,255,.14)",border:0,borderRadius:999,cursor:s.busy?"wait":"pointer",height:22,opacity:s.busy?0.65:1,padding:2,position:"relative",transition:"background .15s ease",width:38},type:"button",children:a.jsx("span",{style:{background:"white",borderRadius:"50%",boxShadow:"0 1px 3px rgba(0,0,0,.35)",display:"block",height:18,transform:"translateX("+(t?16:0)+"px)",transition:"transform .15s ease",width:18}})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})}
function RRouterChevron(){return a.jsx("svg",{className:"mengel-routing-chevron",viewBox:"0 0 16 16",fill:"none","aria-hidden":true,children:a.jsx("path",{d:"m4 6 4 4 4-4",stroke:"currentColor",strokeWidth:1.3,strokeLinecap:"round",strokeLinejoin:"round"})})}
function RRouterSelectTrigger(props,label){return a.jsxs("button",{...props,type:"button",className:"mengel-routing-select",children:[a.jsx("span",{children:label??props.children}),a.jsx(RRouterChevron,{})]})}
function RRouterModel({state:s,onChange:e}) {
  const [custom,setCustom]=de.useState(false),[draft,setDraft]=de.useState("");
  de.useEffect(()=>{setCustom(false);setDraft("")},[s.provider]);
  if(s.provider==="cursor") return a.jsx("p",{className:"mengel-routing-model-note",children:"Choose the model in this agent's settings."});
  const selected=s.models?.[s.provider]??"",fallback=s.modelDefaults?.[s.provider],available=s.modelOptions?.[s.provider]??[];
  const visible=available.filter(option=>option.group!=="automatic"||option.value===selected||!available.some(other=>other.group==="models"&&other.label===option.label));
  const defaultLabel=available.find(option=>option.value===fallback)?.label??fallback;
  const options=[{value:"__default",label:"Provider default",labelMeta:defaultLabel?a.jsx("span",{className:"mengel-routing-meta",children:defaultLabel}):undefined},...visible.map(option=>({value:option.value,label:option.label,labelMeta:option.group==="automatic"?a.jsx("span",{className:"mengel-routing-meta",children:"Auto"}):undefined,tooltip:option.value})),...(selected&&!visible.some(option=>option.value===selected)?[{value:selected,label:selected}]:[]),{value:"__custom",label:"Custom model…"}];
  const chosen=options.find(option=>option.value===selected),label=selected?(chosen?.label??selected):(defaultLabel??"Provider default");
  const save=()=>{if(draft.trim())void e(s.provider,draft.trim()).then(saved=>{if(saved)setCustom(false)})};
  return a.jsxs("div",{className:"mengel-routing-model",children:[a.jsx(ye,{"aria-label":"Routing model",disabled:s.pending,onValueChange:v=>{if(v===null)return;if(v==="__custom"){setCustom(true);setDraft(selected)}else{setCustom(false);void e(s.provider,v==="__default"?null:v)}},options,contentWidth:280,placement:"bottom-start",size:"md",value:selected||"__default",renderTrigger:props=>RRouterSelectTrigger({...props,title:selected||fallback},label)}),custom?a.jsxs("div",{className:"mengel-routing-custom",children:[a.jsx("input",{"aria-label":"Custom model ID",autoFocus:true,className:RRouterInputClass,disabled:s.pending,maxLength:200,onChange:v=>setDraft(v.currentTarget.value),onKeyDown:v=>{if(v.key==="Enter")save();if(v.key==="Escape"){v.stopPropagation();setCustom(false)}},placeholder:"Exact model ID",value:draft}),a.jsx(oe,{disabled:s.pending||!draft.trim(),onClick:save,shape:"rectangular",size:"sm",variant:"secondary",children:s.pending?"Saving…":"Save"}),a.jsx(oe,{disabled:s.pending,onClick:()=>setCustom(false),shape:"rectangular",size:"sm",variant:"ghost",children:"Cancel"})]}):null]});
}
// Keep drag previews local; one request is sent when the gesture finishes.
function RRouterTuning({state:s,onChange:e}) {
  const labels={none:"None",minimal:"Minimal",low:"Low",medium:"Medium",high:"High",xhigh:"Extra high",max:"Max",ultra:"Ultra"};
  const levels=["__default",...(s.effortOptions?.[s.provider]??[])],selected=s.efforts?.[s.provider]??"__default";
  const savedIndex=Math.max(0,levels.indexOf(selected));
  const [index,setIndex]=de.useState(savedIndex),dragging=de.useRef(false),saving=de.useRef(false),timer=de.useRef(null);
  de.useEffect(()=>{setIndex(savedIndex)},[savedIndex]);
  de.useEffect(()=>()=>clearTimeout(timer.current),[]);
  const commit=async value=>{
    clearTimeout(timer.current);
    if(s.pending||saving.current||value===savedIndex)return;
    saving.current=true;
    try{const saved=await e(s.provider,undefined,value===0?null:levels[value]);if(!saved)setIndex(savedIndex)}finally{saving.current=false}
  };
  const change=event=>{const value=Number(event.currentTarget.value);setIndex(value);clearTimeout(timer.current);if(!dragging.current)timer.current=setTimeout(()=>void commit(value),300)};
  const label=index===0?"Default":labels[levels[index]]??levels[index];
  const reset=()=>{setIndex(0);void commit(0)};
  return a.jsxs("div",{className:"mengel-routing-tuning",children:[
    a.jsxs("div",{className:"mengel-routing-tuning-header",children:[
      s.provider==="codex"?a.jsx("button",{type:"button",className:"mengel-routing-icon","aria-label":"Fast mode","aria-pressed":s.codexFastMode===true,title:s.codexFastMode?"Fast mode on":"Fast mode off",disabled:s.pending,onClick:()=>void e("codex",undefined,undefined,!s.codexFastMode),children:a.jsx("svg",{viewBox:"0 0 24 24",fill:"currentColor","aria-hidden":true,children:a.jsx("path",{d:"M13.4 2.6a.8.8 0 0 0-1.4-.4L3.4 13a.9.9 0 0 0 .7 1.5h6l-.7 6.9a.8.8 0 0 0 1.4.4L20.6 11a.9.9 0 0 0-.7-1.5h-7.2z"})})}):a.jsx("span",{}),
      a.jsx("span",{className:"mengel-routing-effort-value",title:"Reasoning effort",children:label}),
      a.jsx("button",{type:"button",className:"mengel-routing-icon","aria-label":"Reset effort to provider default",title:"Reset effort to provider default",disabled:s.pending||index===0,onClick:reset,children:a.jsx("svg",{viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.6,strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":true,children:a.jsx("path",{d:"M4 9a8 8 0 1 1 0 6M4 4v5h5"})})})
    ]}),
    a.jsx(RRouterModel,{state:s,onChange:e}),
    levels.length>1?a.jsxs("div",{className:"mengel-routing-slider",style:{"--effort-fill":(index/(levels.length-1)*100)+"%"},children:[
      a.jsx("div",{className:"mengel-routing-slider-track","aria-hidden":true}),
      a.jsx("div",{className:"mengel-routing-slider-ticks","aria-hidden":true,children:levels.map((level,i)=>a.jsx("span",{className:i<=index?"is-filled":"",title:labels[level]??"Default"},level))}),
      a.jsx("input",{type:"range",min:0,max:levels.length-1,step:1,value:index,disabled:s.pending,"aria-label":"Reasoning effort","aria-valuetext":label=== "Default"?"Provider default":label,onChange:change,onPointerDown:event=>{clearTimeout(timer.current);dragging.current=true;event.currentTarget.setPointerCapture(event.pointerId)},onPointerUp:event=>{dragging.current=false;void commit(Number(event.currentTarget.value))},onPointerCancel:()=>{dragging.current=false;setIndex(savedIndex)},onKeyUp:event=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"].includes(event.key))void commit(Number(event.currentTarget.value))},onBlur:event=>{if(!dragging.current)void commit(Number(event.currentTarget.value))}})
    ]}):null
  ]});
}
function RRouterPanel(){const[s,e]=RRouterState(),[t,n]=RRouterSecrets(),r=RRouterProviders.find(i=>i.value===s.provider)??RRouterProviders[0],i=s.usage?.providers?.[s.provider]??RRouterEmptyUsage,o=r.value==="codex"?"Uses the private ChatGPT login already stored by Codex on this Mac. Requests are made by Grok Bot directly.":r.kind==="local"?"Uses Claude Code's existing login on this Mac.":r.kind==="key"?"Stored securely with your other Grok Bot secrets.":"Uses the account already connected to Grok Bot.";return a.jsx(Te,{children:a.jsxs("div",{className:k("sand-settings-general","sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x"),children:[a.jsx(re,{title:"Routing",children:a.jsxs("div",{className:"mengel-routing",children:[a.jsx("style",{children:${JSON.stringify(ROUTER_STYLES)}}),a.jsxs("div",{className:"mengel-routing-provider",children:[a.jsx("span",{className:"mengel-routing-label",children:"Provider"}),a.jsx(ye,{"aria-label":"Routing provider",disabled:s.pending,onValueChange:l=>{if(l!==null)void e(l)},options:RRouterOptions,placement:"bottom-end",size:"sm",value:s.provider,renderTrigger:props=>RRouterSelectTrigger(props)})]}),s.provider==="cursor"?a.jsx(RRouterModel,{state:s,onChange:e}):a.jsx(RRouterTuning,{state:s,onChange:e},s.provider+":"+(s.models?.[s.provider]??"")+":"+(s.effortOptions?.[s.provider]??[]).join(","))]})}),a.jsx(re,{title:"Computer",children:a.jsx(RBoxRuntime,{})}),a.jsx(re,{title:r.kind==="key"?"OpenRouter account":"Account",children:a.jsx(ie,{description:o,label:r.kind==="key"?"API key":"Status",variant:"card",children:a.jsx(RRouterCredential,{provider:r,state:s,keys:t,onSaved:n})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null,a.jsx(re,{title:"Usage for "+r.label,children:a.jsx(RRouterUsageRows,{usage:i})})]})})}
function RRouterUsageSummary({provider:s,usage:e,current:t,divided:n}){const r=[RRouterNumber(e.requests)+" requests",RRouterNumber(e.inputTokens)+" input",RRouterNumber(e.outputTokens)+" output",RRouterNumber(e.cacheReadTokens+e.cacheWriteTokens)+" cached"].join(" · "),i=t?"Current route":e.lastUsedAt?new Date(e.lastUsedAt).toLocaleString():"Not used yet";return a.jsx(ie,{divided:n,description:r,label:s.label,variant:"card",children:a.jsx(se,{as:"span",color:t?"primary":"secondary",size:"sm",children:i})})}
function RRouterUsage(){const[s]=RRouterState(),e=RRouterProviders.find(t=>t.value===s.provider)??RRouterProviders[0],t=RRouterProviders.filter(n=>n.value===s.provider||(s.usage?.providers?.[n.value]?.requests??0)>0);return a.jsxs("div",{className:k("sand-usage-section","sand-9f619 sand-78zum5 sand-dt5ytf sand-ou54vl"),children:[a.jsx(re,{title:"Current provider",children:a.jsx(ie,{description:e.description,label:e.label,variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Selected"})})}),a.jsx(re,{title:"Tracked activity",children:a.jsx("div",{children:t.map((n,r)=>a.jsx(RRouterUsageSummary,{provider:n,usage:s.usage?.providers?.[n.value]??RRouterEmptyUsage,current:n.value===s.provider,divided:r>0},n.value))})}),s.provider==="cursor"?a.jsx(Na,{}):null]})}
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + 1) >= 0) throw new Error(`Original renderer ${label} anchor is missing or ambiguous.`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

// Product rebrand: every user-facing "Grok Bot" display string becomes "Mengel"
// across the shipped renderer chunks (wordmark, About box, onboarding, computer
// and access copy). Internal identifiers are unaffected because they use the
// lowercase "grokbot" token or the "sand" prefix, neither of which contains the
// exact "Grok Bot" (capitalized, space-separated) sequence replaced here.
const PRODUCT_NAME_BEFORE = "Grok Bot";
const PRODUCT_NAME_AFTER = "Mengel";

export function rebrandProductName(source) {
  return source.replaceAll(PRODUCT_NAME_BEFORE, PRODUCT_NAME_AFTER);
}

// Reconstructed packages disable the upstream updater, so the floating "update
// available" footer pill (cloud-download icon) is dead UI. `sTn(n)` is the gate
// that decides whether the pill shows; forcing it to return null keeps the pill
// permanently hidden. Applied only to the chunk that defines it.
const UPDATE_PILL_ANCHOR = "function sTn(n){";
export function hideUpdatePill(source) {
  if (!source.includes(UPDATE_PILL_ANCHOR)) return source;
  return source.replace(UPDATE_PILL_ANCHOR, `${UPDATE_PILL_ANCHOR}return null;`);
}

export function patchOriginalSettingsRegistry(source) {
  return replaceExactlyOnce(source, REGISTRY_BEFORE, REGISTRY_AFTER, "settings registry");
}

export function patchOriginalSettingsPanel(source) {
  let patched = replaceExactlyOnce(source, COMPONENT_ANCHOR, `${COMPONENT_SOURCE}${COMPONENT_ANCHOR}`, "component insertion");
  patched = replaceExactlyOnce(patched, GENERAL_BEFORE, GENERAL_AFTER, "Router panel switch");
  patched = replaceExactlyOnce(patched, USAGE_BEFORE, USAGE_AFTER, "Usage panel switch");
  return patched;
}

async function rebrandStagedPackageProductName(stageRoot) {
  // Electron reads `productName` from the app package.json for app.getName(),
  // which drives the macOS application-menu name and the default window title.
  // CFBundleName stays "Grok Bot" (Electron derives the nested helper app names
  // from it), so this is the correct lever for the visible app name.
  const packagePath = path.join(stageRoot, "package.json");
  const parsed = JSON.parse(await readFile(packagePath, "utf8"));
  if (parsed.productName === PRODUCT_NAME_AFTER) return;
  parsed.productName = PRODUCT_NAME_AFTER;
  await writeFile(packagePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

export async function applyOriginalRendererRouterPatch({ stageRoot }) {
  const rendererRoot = path.join(stageRoot, "dist", "renderer");
  const assetsRoot = path.join(rendererRoot, "assets");
  const chunkNames = (await readdir(assetsRoot)).filter(name => name.endsWith(".js")).sort();
  const sources = new Map();
  const registryCandidates = [];
  const panelCandidates = [];
  for (const name of chunkNames) {
    const source = await readFile(path.join(assetsRoot, name), "utf8");
    sources.set(name, source);
    if (source.includes(REGISTRY_BEFORE)) registryCandidates.push(name);
    if (source.includes(COMPONENT_ANCHOR) && source.includes(GENERAL_BEFORE) && source.includes(USAGE_BEFORE)) panelCandidates.push(name);
  }
  if (registryCandidates.length !== 1 || panelCandidates.length !== 1) {
    throw new Error(`Expected one original Settings registry and panel chunk, found ${registryCandidates.length}/${panelCandidates.length}.`);
  }
  const registryChunk = registryCandidates[0];
  const panelChunk = panelCandidates[0];
  // Apply the functional Router patches to their chunks, then rebrand every
  // chunk's product name. A chunk keeps its functional role when it has one;
  // chunks changed only by the rebrand are recorded with the "rebrand" role.
  const changes = [];
  for (const name of chunkNames) {
    const source = sources.get(name);
    let patched = source;
    if (name === registryChunk) patched = patchOriginalSettingsRegistry(patched);
    if (name === panelChunk) patched = patchOriginalSettingsPanel(patched);
    patched = hideUpdatePill(patched);
    patched = rebrandProductName(patched);
    if (patched === source) continue;
    await writeFile(path.join(assetsRoot, name), patched);
    changes.push({
      role: name === registryChunk ? "registry" : name === panelChunk ? "panel" : "rebrand",
      path: `dist/renderer/assets/${name}`,
      original: { bytes: Buffer.byteLength(source), sha256: sha256(source) },
      patched: { bytes: Buffer.byteLength(patched), sha256: sha256(patched) },
    });
  }
  // Rebrand the renderer HTML shell (its <title> drives the window title bar).
  const indexHtmlPath = path.join(rendererRoot, "index.html");
  const indexHtmlSource = await readFile(indexHtmlPath, "utf8");
  const indexHtmlPatched = rebrandProductName(indexHtmlSource);
  if (indexHtmlPatched !== indexHtmlSource) {
    await writeFile(indexHtmlPath, indexHtmlPatched);
    changes.push({
      role: "rebrand",
      path: "dist/renderer/index.html",
      original: { bytes: Buffer.byteLength(indexHtmlSource), sha256: sha256(indexHtmlSource) },
      patched: { bytes: Buffer.byteLength(indexHtmlPatched), sha256: sha256(indexHtmlPatched) },
    });
  }
  await rebrandStagedPackageProductName(stageRoot);
  const record = {
    schemaVersion: 1,
    mode: "original-renderer-settings-extension",
    chunks: changes,
    features: ["settings-router-provider", "settings-router-model", "settings-router-effort", "settings-local-docker-vm", "usage-current-provider", "product-rebrand"],
    transformations: ["settings-registry", "router-panel", "usage-panel", "product-rebrand"],
  };
  const provenancePath = path.join(stageRoot, "dist", "renderer-router-extension.json");
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, provenancePath, provenanceBytes: (await stat(provenancePath)).size };
}
