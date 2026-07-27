import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const ignored=new Set(['node_modules','.git','.vercel']);
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
  if(ignored.has(e.name)) return [];
  const p=path.join(dir,e.name);
  return e.isDirectory()?walk(p):[p];
});
const files=walk(root);
const rel=p=>path.relative(root,p).replaceAll('\\','/');
const existing=new Set(files.map(rel));
const html=files.filter(f=>f.endsWith('.html')&&path.dirname(f)===root);
const js=files.filter(f=>(f.endsWith('.js')||f.endsWith('.mjs'))&&!rel(f).startsWith('node_modules/'));
const failures=[];
const warnings=[];

function localTarget(raw,from){
  const value=String(raw||'').trim();
  if(!value||value.startsWith('#')||value.includes('${')||/^(https?:|mailto:|tel:|data:|blob:|javascript:)/i.test(value)) return null;
  const clean=value.split(/[?#]/)[0];
  if(clean===''||clean==='/') return 'index.html';
  return clean.startsWith('/')
    ? path.posix.normalize(clean.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(from),clean));
}

for(const file of html){
  const name=rel(file),text=fs.readFileSync(file,'utf8');
  // Inline JavaScript often contains HTML template strings. They are not part
  // of the initial DOM, so inspect only the actual document markup here.
  const dom=text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  if(!/<html[\s>]/i.test(text)||!/<body[\s>]/i.test(text)) failures.push(`${name}: missing html/body shell`);
  if(!/<meta[^>]+name=["']viewport["']/i.test(text)) warnings.push(`${name}: missing viewport meta`);
  const ids=[...dom.matchAll(/\sid=["']([^"']+)["']/gi)].map(m=>m[1]);
  const duplicates=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))];
  if(duplicates.length) failures.push(`${name}: duplicate ids ${duplicates.join(', ')}`);
  for(const m of dom.matchAll(/(?:href|src)=["']([^"']+)["']/gi)){
    const target=localTarget(m[1],name);if(!target)continue;
    const candidates=[target,target.endsWith('/')?target+'index.html':'',!path.posix.extname(target)?target+'.html':''].filter(Boolean);
    if(!candidates.some(c=>existing.has(c))) failures.push(`${name}: missing local asset ${m[1]}`);
  }
}

for(const file of js){
  const name=rel(file);if(name==='scripts/app-audit.mjs')continue;
  const text=fs.readFileSync(file,'utf8');
  const markers=['<'+'<<<<<<','='+'======','>'+'>>>>>>'];
  if(markers.some(marker=>text.includes(marker))) failures.push(`${name}: unresolved merge markers`);
}

const vercelPath=path.join(root,'vercel.json');
if(fs.existsSync(vercelPath)){
  const config=JSON.parse(fs.readFileSync(vercelPath,'utf8'));
  for(const rule of config.rewrites||[]){
    const target=String(rule.destination||'').replace(/^\//,'');
    if(target&&!existing.has(target)) failures.push(`vercel.json: rewrite ${rule.source} points to missing ${rule.destination}`);
  }
}

console.log(`Audited ${html.length} deployable HTML pages and ${js.length} JavaScript modules.`);
for(const w of warnings) console.warn('WARN',w);
for(const f of failures) console.error('FAIL',f);
if(failures.length){console.error(`Audit failed with ${failures.length} blocking issue(s).`);process.exit(1)}
console.log(`PASS: all local page assets and Vercel rewrites resolve. ${warnings.length} warning(s).`);
