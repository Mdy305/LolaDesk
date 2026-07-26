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
const html=files.filter(f=>f.endsWith('.html'));
const js=files.filter(f=>f.endsWith('.js')||f.endsWith('.mjs'));
const failures=[];
const warnings=[];

function localTarget(raw,from){
  const value=String(raw||'').trim();
  if(!value||value.startsWith('#')||/^(https?:|mailto:|tel:|data:|blob:|javascript:)/i.test(value)) return null;
  const clean=value.split(/[?#]/)[0].replace(/^\//,'');
  if(!clean) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(from),clean));
}

for(const file of html){
  const name=rel(file),text=fs.readFileSync(file,'utf8');
  if(!/<html[\s>]/i.test(text)||!/<body[\s>]/i.test(text)) failures.push(`${name}: missing html/body shell`);
  if(!/<meta[^>]+name=["']viewport["']/i.test(text)) warnings.push(`${name}: missing viewport meta`);
  const ids=[...text.matchAll(/\sid=["']([^"']+)["']/gi)].map(m=>m[1]);
  const duplicates=[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))];
  if(duplicates.length) failures.push(`${name}: duplicate ids ${duplicates.join(', ')}`);
  for(const m of text.matchAll(/(?:href|src)=["']([^"']+)["']/gi)){
    const target=localTarget(m[1],name);if(!target)continue;
    const candidates=[target,target.endsWith('/')?target+'index.html':'',!path.posix.extname(target)?target+'.html':''].filter(Boolean);
    if(!candidates.some(c=>existing.has(c))) failures.push(`${name}: missing local asset ${m[1]}`);
  }
}

for(const file of js){
  const name=rel(file),text=fs.readFileSync(file,'utf8');
  if(/<<<<<<<|=======|>>>>>>>/.test(text)) failures.push(`${name}: unresolved merge markers`);
}

const vercelPath=path.join(root,'vercel.json');
if(fs.existsSync(vercelPath)){
  const config=JSON.parse(fs.readFileSync(vercelPath,'utf8'));
  for(const rule of config.rewrites||[]){
    const target=String(rule.destination||'').replace(/^\//,'');
    if(target&&!existing.has(target)) failures.push(`vercel.json: rewrite ${rule.source} points to missing ${rule.destination}`);
  }
}

console.log(`Audited ${html.length} HTML pages and ${js.length} JavaScript modules.`);
for(const w of warnings) console.warn('WARN',w);
for(const f of failures) console.error('FAIL',f);
if(failures.length){console.error(`Audit failed with ${failures.length} blocking issue(s).`);process.exit(1)}
console.log(`PASS: all local page assets and Vercel rewrites resolve. ${warnings.length} warning(s).`);
