const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('Media-Compliance-Reviewer-Standalone.html','utf8'),shell=fs.readFileSync('Media-Compliance-Reviewer.html','utf8'),match=/const CHILD_HTML_B64 = "([^"]+)"/.exec(shell);
assert(match,'Embedded app');const child=Buffer.from(match[1],'base64').toString('utf8'),marker='<meta charset="utf-8">';
assert.equal(child.slice(child.indexOf(marker)).replace('\n<!-- <script src="testRecorder.js"></script> -->\n',''),source.slice(source.indexOf(marker)),'Packaged app matches standalone source');
for(const [name,html] of [['standalone',source],['wrapper',shell],['embedded app',child]])for(const script of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)){
 const attributes=script[1];if(/id="video-decoder-wasm"/.test(attributes))continue;
 if(!/type=/.test(attributes)||/javascript|module/.test(attributes)||/id="(?:worker-source|preview-worker-source|heif-decoder-source|database-worker-source|video-decoder-source)"/.test(attributes))new vm.Script(script[2],{filename:name});
}
for(const action of ['fs_iterator_open','fs_iterator_next','fs_iterator_close','fs_release_handle','media_database_request'])assert(shell.includes(action),'Wrapper bridge: '+action);
console.log('Embedded scripts parse and the packaged app matches its source.');
require('./test-startup.cjs');
