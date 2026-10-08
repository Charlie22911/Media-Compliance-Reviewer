// Check the real packaged markup against the application's required startup bindings.
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.join(__dirname,'..'),app=fs.readFileSync(path.join(root,'src/media-reviewer-app.js'),'utf8');
const source=fs.readFileSync(path.join(root,'Media-Compliance-Reviewer-Standalone.html'),'utf8');
const shell=fs.readFileSync(path.join(root,'Media-Compliance-Reviewer.html'),'utf8');
const child=Buffer.from(/const CHILD_HTML_B64 = "([^"]+)"/.exec(shell)[1],'base64').toString('utf8');
const selectors=[...app.matchAll(/\$\(['"]#([\w-]+)['"]\)\.addEventListener\(/g)].map(match=>match[1]);
assert(selectors.length>50,'The check must cover startup event bindings');
for(const [edition,html]of [['standalone',source],['Forge child',child]]){
 const markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
 const ids=new Set([...markup.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(match=>match[1]));
 const missing=[...new Set(selectors.filter(id=>!ids.has(id)))];
 assert.deepEqual(missing,[],edition+': required startup controls are missing');
 const maintenance=/<dialog id="maintenance-dialog"[^>]*>([\s\S]*?)<\/dialog>/.exec(markup)?.[1];
 assert(maintenance,edition+': Maintenance dialog exists');
 const limit=/<select id="evidence-database-limit"[^>]*>([\s\S]*?)<\/select>/.exec(maintenance)?.[1];
 assert(limit,edition+': Evidence size limit remains available in Maintenance');
 assert(/value="2\.5"/.test(limit)&&/value="5"/.test(limit),edition+': both Evidence size limits are offered');
 assert(!/minimum automatic-save interval of 1, 5, or 15 minutes/i.test(markup),edition+': Help must describe the current save behavior');
 const clientIndex=html.indexOf('<script id="database-client">'),appIndex=html.indexOf('const MEDIA_DATABASE_SCHEMA =');
 assert(clientIndex>=0&&clientIndex<appIndex,edition+': database client loads before application startup');
}
console.log('Required startup controls, Evidence size options, Help and database-client order passed in both editions.');
