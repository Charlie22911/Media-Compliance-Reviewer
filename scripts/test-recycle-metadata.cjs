const assert=require('assert/strict'),{createContext}=require('./test-database.cjs');
const {C}=createContext();
function metadata(version){
 const path='C:\\Users\\brad.thomas\\Pictures\\photo.png\0',bytes=new Uint8Array(version===1?544:28+path.length*2),view=new DataView(bytes.buffer);
 view.setBigUint64(0,BigInt(version),true);view.setBigUint64(8,123456n,true);view.setBigUint64(16,133000000000000000n,true);
 const start=version===1?24:28;if(version===2)view.setUint32(24,path.length,true);
 for(let at=0;at<path.length;at++)view.setUint16(start+at*2,path.charCodeAt(at),true);
 return bytes;
}
(async()=>{
 for(const version of [1,2]){
  const file=new Blob([metadata(version)]),path='brad.thomas/My Documents/$RECYCLE.BIN/$IABC123.PNG';
  assert.equal(await C.isRecycleBinMetadata(file,path),true);
  assert.equal(await C.isRecycleBinMetadata(file,path.replace('$IABC123','$RABC123')),false,'Actual recycled content must still be scanned');
  assert.equal(await C.isRecycleBinMetadata(file,'Pictures/$IABC123.PNG'),false,'A similar filename outside the recycle bin is not excluded');
 }
 const png=new Uint8Array(544),view=new DataView(png.buffer);png.set([137,80,78,71,13,10,26,10]);view.setUint32(16,12);view.setUint32(20,20);
 assert.equal(await C.isRecycleBinMetadata(new Blob([png]),'$Recycle.Bin/$IABC123.PNG'),false,'Real media with the same filename must not be excluded');
 assert.equal((await C.checkPreviewInput(new Blob([png]),'png')).height,20);
 const damaged=metadata(2);new DataView(damaged.buffer).setUint32(24,0,true);
 assert.equal(await C.isRecycleBinMetadata(new Blob([damaged]),'$RECYCLE.BIN/$IABC123.PNG'),false,'Unrecognized data must not be silently skipped');
 console.log('Recycle-bin metadata versions 1 and 2 are identified without excluding actual media or similarly named files.');
})().catch(error=>{console.error(error);process.exitCode=1;});
