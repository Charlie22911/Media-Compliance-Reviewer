const fs=require('fs');
require('./build-media-preview.cjs');
let html=require('./install-startup-screen.cjs')(fs.readFileSync('Media-Compliance-Reviewer-Standalone.html','utf8'));
html=html.replace(/<script id="testable-core">[\s\S]*?<\/script>/,()=>'<script id="testable-core">\n'+fs.readFileSync('src/media-reviewer-core.js','utf8')+'\n</script>');
const sql=html.indexOf('/* sql.js 1.13.0');
if(sql>=0){const start=html.lastIndexOf('<script>',sql),wasm=html.indexOf('<script id="sqlite-wasm"',sql),end=html.indexOf('</script>',wasm)+9;html=html.slice(0,start)+html.slice(end);}
html=html.replace(/<script id="(?:database-worker-source|database-client)":[^>]*>[\s\S]*?<\/script>/g,'');
html=html.replace(/<script id="database-worker-source"[^>]*>[\s\S]*?<\/script>/g,'').replace(/<script id="database-client"[^>]*>[\s\S]*?<\/script>/g,'');
const last=html.lastIndexOf('<script>'),end=html.lastIndexOf('</script>');
const safe=text=>text.replace(/<\/script/gi,'<\\/script');
html=html.slice(0,last)+'<script id="database-worker-source" type="text/plain">\n'+safe(fs.readFileSync('.build/media-database-worker.bundle.js','utf8'))+'\n</script>\n<script id="database-client">\n'+safe(fs.readFileSync('src/media-database-client.js','utf8'))+'\n</script>\n<script>\n'+fs.readFileSync('src/media-reviewer-app.js','utf8')+'\n'+html.slice(end);
fs.writeFileSync('Media-Compliance-Reviewer-Standalone.html',html);
console.log('Assembled media reviewer:',html.length,'bytes');
