let heifModule=null,videoModule=null;
async function videoBitmap(file,limit){
 if(!videoModule){
  const compressed=Uint8Array.from(atob(PREVIEW_VIDEO_WASM),c=>c.charCodeAt(0));
  const wasmBinary=await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  videoModule=await createFFmpegCore({wasmBinary,print:()=>{},printErr:()=>{}});
  videoModule.FS.mkdir('/source');
 }
 const core=videoModule,filename='input.'+ImageReviewerCore.extensionOf(file.name);let mounted=false,messages=[];
 try{
  core.reset();core.setTimeout(12000);core.setLogger(({message})=>{messages.push(message);if(messages.length>4)messages.shift();});
  // WORKERFS seeks directly in the selected File; do not copy a whole video into RAM.
  core.FS.mount(core.FS.filesystems.WORKERFS,{blobs:[{name:filename,data:file}]},'/source');mounted=true;
  const demuxer=['ts','mts','m2ts'].includes(ImageReviewerCore.extensionOf(file.name))?['-f','mpegts']:[];
  const code=core.exec('-hide_banner','-loglevel','error','-threads','1',...demuxer,'-i','/source/'+filename,'-map','0:v:0','-frames:v','1','-an','-vf','scale='+limit+':'+limit+':force_original_aspect_ratio=decrease','-c:v','png','-threads','1','-f','image2','/poster.png');
  if(code!==0)throw Error('Could not decode a video frame: '+messages.join(' ').slice(0,240));
  return await createImageBitmap(new Blob([core.FS.readFile('/poster.png')],{type:'image/png'}));
 }finally{
  if(mounted)core.FS.unmount('/source');try{core.FS.unlink('/poster.png');}catch(_){}
  core.setLogger(()=>{});core.reset();
 }
}
async function rawBitmap(file){
 // Camera RAW formats normally include a camera-rendered JPEG. Find its complete
 // marker stream, skipping APP segments so an EXIF thumbnail does not truncate it.
 const bytes=new Uint8Array(await file.arrayBuffer()),candidates=[];
 for(let start=0;start<bytes.length-3;start++){
  if(bytes[start]!==255||bytes[start+1]!==216||bytes[start+2]!==255)continue;
  let at=start+2,end=0;
  while(at<bytes.length-1&&at-start<=16*1024*1024){
   if(bytes[at++]!==255)continue;while(bytes[at]===255)at++;const marker=bytes[at++];
   if(marker===217){end=at;break;}
   if(marker===0||marker===216||(marker>=208&&marker<=215))continue;
   if(at+1>=bytes.length)break;const size=(bytes[at]<<8)|bytes[at+1];if(size<2||at+size>bytes.length)break;at+=size;
  }
  if(end){candidates.push({start,end});start=end-1;}
 }
 candidates.sort((a,b)=>(b.end-b.start)-(a.end-a.start));
 for(const {start,end} of candidates.slice(0,8))try{return await createImageBitmap(new Blob([bytes.subarray(start,end)],{type:'image/jpeg'}));}catch(_){}
 throw Error('No readable embedded camera preview in this RAW file.');
}
self.onmessage=async e=>{
 const m=e.data;let decoded=null,bitmap=null,images=[];
 try{
  const extension=m.extension,limit=m.purpose==='inspect'?2048:256;
  if(ImageReviewerCore.VIDEO_EXTENSIONS.includes(extension))bitmap=await videoBitmap(m.file,limit);
  else{
   if(m.file.size>128*1024*1024)throw Error('Image preview input exceeds the 128 MiB decode limit.');
   if(ImageReviewerCore.RAW_EXTENSIONS.includes(extension))bitmap=await rawBitmap(m.file);
   else if(['tif','tiff'].includes(extension))decoded=await ImageReviewerCore.decodeTiff(new Uint8Array(await m.file.arrayBuffer()));
   else if(['heic','heif'].includes(extension)){
    try{bitmap=await createImageBitmap(m.file,{imageOrientation:'from-image'});}catch(_){
     heifModule=heifModule||libheif();const decoder=new heifModule.HeifDecoder();images=decoder.decode(new Uint8Array(await m.file.arrayBuffer()));
     if(!images.length)throw Error('No readable primary image in HEIF.');
     const image=images.find(image=>typeof image.is_primary==='function'&&image.is_primary())||images[0],width=image.get_width(),height=image.get_height();
     if(!Number.isSafeInteger(width*height)||width<=0||height<=0||width*height>32000000)throw Error('Image exceeds the 32 megapixel decode limit.');
     const data=new Uint8ClampedArray(width*height*4),result=await new Promise((resolve,reject)=>image.display({data,width,height},result=>result?resolve(result):reject(Error('HEIF codec cannot decode this image.'))));decoded={rgba:result.data,width,height};
    }
   }else bitmap=await createImageBitmap(m.file,{imageOrientation:'from-image'});
  }
  const width=bitmap?.width||decoded.width,height=bitmap?.height||decoded.height;
  if(width*height>32000000)throw Error('Image exceeds the 32 megapixel decode limit.');
  if(decoded)bitmap=await createImageBitmap(new ImageData(decoded.rgba,width,height));
  let blob,canvas;
  for(const max of (m.purpose==='inspect'?[limit]:[256,224,192,160])){
   const ratio=Math.min(1,max/Math.max(width,height));canvas=new OffscreenCanvas(Math.max(1,Math.round(width*ratio)),Math.max(1,Math.round(height*ratio)));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
   blob=await canvas.convertToBlob({type:'image/webp',quality:m.purpose==='inspect'?.85:.5});if(m.purpose==='inspect'||blob.size<=32768)break;canvas.width=canvas.height=1;
  }
  if(m.purpose!=='inspect'&&blob.size>32768)throw Error('Preview exceeds storage size limit.');
  self.postMessage({jobId:m.jobId,generation:m.generation,result:{blob,width:canvas.width,height:canvas.height,sourceWidth:width,sourceHeight:height}});canvas.width=canvas.height=1;
 }catch(error){self.postMessage({jobId:m.jobId,generation:m.generation,error:String(error.message||error)});}
 finally{bitmap?.close();decoded?.rgba.fill(0);for(const image of images)image.free?.();}
};
