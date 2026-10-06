const fs=require('fs'),zlib=require('zlib');
// Cap the embedded decoder's WASM memory at 256 MiB. Keep upstream bytes on disk.
function capMemory(input,pages){
 let at=8;const output=[input.subarray(0,8)];
 const read=()=>{let value=0,shift=0,byte;do{byte=input[at++];value+=(byte&127)*2**shift;shift+=7;}while(byte&128);return value;};
 const encode=value=>{const bytes=[];do{const rest=value%128;value=Math.floor(value/128);bytes.push(rest|(value?128:0));}while(value);return Buffer.from(bytes);};
 while(at<input.length){const id=input[at++],length=read(),start=at,end=at+length;if(id!==5){output.push(Buffer.from([id]),encode(length),input.subarray(start,end));at=end;continue;}
  const count=read(),parts=[encode(count)];for(let i=0;i<count;i++){const flags=read(),minimum=read(),maximum=flags&1?read():pages;if(minimum>pages)throw Error('Decoder initial memory exceeds cap');parts.push(encode(flags|1),encode(minimum),encode(Math.min(maximum,pages)));}const data=Buffer.concat(parts);output.push(Buffer.from([id]),encode(data.length),data);at=end;
 }return Buffer.concat(output);
}
let html=fs.readFileSync('Media-Compliance-Reviewer-Standalone.html','utf8');
const safe=text=>text.replace(/<\/script/gi,'<\\/script');
const wasm=capMemory(fs.readFileSync('vendor/ffmpeg-core/dist/umd/ffmpeg-core.wasm'),4096);
new WebAssembly.Module(wasm);
const blocks=[['video-decoder-source',fs.readFileSync('vendor/ffmpeg-core/dist/umd/ffmpeg-core.js','utf8')],['video-decoder-wasm',zlib.gzipSync(wasm,{level:9}).toString('base64')],['preview-worker-source',fs.readFileSync('src/media-preview-worker.js','utf8')]];
for(const [id,content] of blocks){const block='<script id="'+id+'" type="text/plain">\n'+safe(content)+'\n</script>';const pattern=new RegExp('<script id="'+id+'"[^>]*>[\\s\\S]*?<\\/script>');html=pattern.test(html)?html.replace(pattern,()=>block):html.replace('<script id="preview-worker-source"',()=>block+'\n<script id="preview-worker-source"');}
const license=fs.readFileSync('vendor/ffmpeg-core/COPYING','utf8').replace(/&/g,'&amp;').replace(/</g,'&lt;');
html=html.replace(/(<pre id="video-decoder-license"[^>]*>)[\s\S]*?<\/pre>/,(_,start)=>start+license+'</pre>');
fs.writeFileSync('Media-Compliance-Reviewer-Standalone.html',html);console.log('Embedded offline video poster decoder:',blocks[1][1].length,'compressed base64 bytes; WASM memory cap 256 MiB.');
