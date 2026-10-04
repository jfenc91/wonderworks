// Integration fixtures now reach the accepted set through the real review
// boundary. Legacy direct-edit provenance remains covered by domain fixtures.
export async function acceptRequirements(doc,requirements,request){
  const mutate=async(action,data)=>doc=await request({project:doc.id,version:doc.version,action,...data});
  await mutate('proposal',{proposal:{title:'Accept integration fixture'}});
  const id=doc.proposals[0].id;
  await mutate('requirements',{proposal_id:id,requirements:requirements.map(({status,...r})=>r.kind==='information'?{...r,status}:r)});
  await mutate('proposal_submit',{id});
  await mutate('proposal_review',{id,review:{decision:'apply',note:'Reviewed integration fixture'}});
  return doc;
}
