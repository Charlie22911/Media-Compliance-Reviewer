const fs=require('fs'),path=require('path'),esbuild=require('esbuild');
fs.mkdirSync('.build',{recursive:true});
const root='vendor/wa-sqlite';
(async()=>{
 const result=await esbuild.build({entryPoints:[path.resolve('src/media-database-worker.js')],plugins:[{name:'workspace-source',setup(build){build.onResolve({filter:/.*/},args=>({path:path.resolve(args.resolveDir||process.cwd(),args.path),namespace:'workspace-source'}));build.onLoad({filter:/.*/,namespace:'workspace-source'},args=>({contents:fs.readFileSync(args.path,'utf8'),loader:'js',resolveDir:path.dirname(args.path)}));}}],define:{'import.meta.url':JSON.stringify('file:///embedded-wa-sqlite.mjs')},bundle:true,write:false,format:'iife',target:'es2022',minify:true,logLevel:'warning'});
 const wasm=fs.readFileSync(root+'/dist/wa-sqlite-async.wasm').toString('base64');
 const core=fs.readFileSync('src/media-reviewer-core.js','utf8');
 const source='globalThis.MEDIA_SQLITE_WASM='+JSON.stringify(wasm)+';\n'+fs.readFileSync('src/media-database-client.js','utf8')+'\n'+core+'\n'+result.outputFiles[0].text;
 fs.writeFileSync('.build/media-database-worker.bundle.js',source);
 console.log('Embedded disk worker:',source.length,'bytes');
})().catch(e=>{console.error(e);process.exitCode=1;});


