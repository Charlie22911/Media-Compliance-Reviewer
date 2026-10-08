// Verify legacy identity migration keeps authoritative SQL audit references intact.
const assert=require('assert/strict'),{createContext,createDatabase}=require('./test-database.cjs');
(async()=>{
 const context=createContext(),db=await createDatabase(context),C=context.C,M=context.MediaDatabase;
 try{
  const digest='a'.repeat(64),oldHash='q1:'+digest+':2097152',hash=C.quickHashIdentity(digest),oldKey='root|'+oldHash,key='root|'+hash;
  const oldId='root|user.name/photo.jpg|'+oldHash,id='root|user.name/photo.jpg|'+hash;
  const workspace=C.newWorkspace();workspace.catalogNormalized=true;workspace.events=[];workspace.roots.root={id:'root',label:'HomeShare'};
  await db.run('UPDATE app_meta SET value=? WHERE key=?',[JSON.stringify(C.serializeWorkspace(workspace)),'workspace_json']);
  for(const [kind,recordId,row]of [
   ['contents',oldHash,{hash:oldHash,size:2097152,hashMethod:'sampled-sha256-v1',sampleDigest:digest}],
   ['occurrences',oldId,{id:oldId,rootId:'root',hash:oldHash,path:'user.name/photo.jpg',name:'photo.jpg',extension:'jpg'}],
   ['decisions',oldKey,{key:oldKey,rootId:'root',hash:oldHash,status:'COMPLIANT',notes:'Keep the review history'}]
  ]){const store=await M.recordStore(db,kind);await M.put(store,recordId,row);}
  await db.run('INSERT INTO review_events VALUES (?,?,?,?,?,?,?,?)',['event',oldKey,'TO_REVIEW','COMPLIANT','2026-10-01T00:00:00Z','Reviewer','Keep the review history','batch']);
  await db.run('INSERT INTO scan_jobs(scan_id,seq,root_id,path,kind,state,occurrence_id) VALUES (?,?,?,?,?,?,?)',['scan',1,'root','user.name/photo.jpg','file','complete',oldId]);
  await db.run('INSERT INTO scan_checkpoints VALUES (?,?,?,?)',['scan','user.name/photo.jpg',oldId,JSON.stringify({occurrenceId:oldId,state:'complete'})]);
  await C.upgradeDatabase(db);
  assert.equal((await db.exec('SELECT decision_key FROM review_events WHERE id=?',['event']))[0].values[0][0],key,'SQL audit history must follow the migrated decision');
  assert.equal((await db.exec('SELECT occurrence_id FROM scan_jobs'))[0].values[0][0],id);
  assert.equal((await db.exec('SELECT occurrence_id FROM scan_checkpoints'))[0].values[0][0],id);
  assert.equal((await db.exec('SELECT reviewer,notes FROM review_events'))[0].values[0][0],'Reviewer');
  assert.equal((await db.exec('SELECT reviewer,notes FROM review_events'))[0].values[0][1],'Keep the review history');
  // Previously migrated databases may already have a dangling SQL audit link.
  await db.run('UPDATE review_events SET decision_key=? WHERE id=?',[oldKey,'event']);
  const repaired=await C.upgradeDatabase(db);assert.equal(repaired.auditRepaired,1);assert.equal(repaired.upgraded,true,'Repairs must request saving the updated copy');
  assert.equal((await db.exec('SELECT decision_key FROM review_events WHERE id=?',['event']))[0].values[0][0],key);
  // Evidence identities remain protected when an old decision still exists.
  const protectedHash='q1:'+'b'.repeat(64)+':2097152',protectedKey='root|'+protectedHash,targetHash=C.quickHashIdentity('b'.repeat(64));
  const decisions=await M.recordStore(db,'decisions');
  await M.put(decisions,protectedKey,{key:protectedKey,rootId:'root',hash:protectedHash,status:'EVIDENCE'});
  await M.put(decisions,'root|'+targetHash,{key:'root|'+targetHash,rootId:'root',hash:targetHash,status:'TO_REVIEW'});
  await db.run('INSERT INTO review_events VALUES (?,?,?,?,?,?,?,?)',['protected',protectedKey,'TO_REVIEW','EVIDENCE','2026-10-01T00:00:00Z','Reviewer','','batch']);
  await C.upgradeDatabase(db);assert.equal((await db.exec('SELECT decision_key FROM review_events WHERE id=?',['protected']))[0].values[0][0],protectedKey,'Protected Evidence history must retain its original identity');
  assert.equal((await db.exec('PRAGMA integrity_check'))[0].values[0][0],'ok');
  console.log('Legacy fingerprint migration preserves review history and scan/checkpoint references.');
 }finally{db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
