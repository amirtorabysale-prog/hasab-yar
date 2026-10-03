/** Stable business-question identities shared by server and UI; old proposals remain readable. */
const normalize = text => String(text).replace(/[يى]/g,'ی').replace(/ك/g,'ک').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function legacyId(text) {
  let hash=2166136261;
  for(const char of normalize(text)) hash=Math.imul(hash ^ char.codePointAt(0),16777619);
  return `question-${(hash>>>0).toString(16)}`;
}
export function reviewQuestions(proposal={}) {
  const result=[];
  const add=(text,id,field)=>{
    if(typeof text!=='string' || !text.trim()) return;
    text=text.trim().slice(0,150);
    id=typeof id==='string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(id)?id:legacyId(text);
    if(!result.some(q=>q.id===id || normalize(q.text)===normalize(text))) result.push({id,text,...(['occurredAt','dueAt','counterpartyName','counterpartyId','accountId'].includes(field)?{field}:{})});
  };
  for(const q of (Array.isArray(proposal.questions)?proposal.questions:[]).slice(0,5)) add(q?.text,q?.id,q?.field);
  for(const text of (Array.isArray(proposal.missingFacts)?proposal.missingFacts:[]).slice(0,5)) add(text);
  return result.slice(0,5);
}
