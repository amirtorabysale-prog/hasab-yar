import { randomUUID } from 'node:crypto';
import { resolveCounterparty, normalizedCounterpartyInput } from './counterparties.js';
import { exactCounterpartyKey } from '../shared/counterpartyIdentity.js';
import { extractContactName } from '../shared/counterpartySpeech.js';
import { recordInventoryMovement } from './inventory.js';

const partyRoles=new Set(['partner-payable','partner-receivable','receivable','payable','cheque-receivable','cheque-payable','customer-advance','deferred-revenue','refundable-deposit','loan-payable']);
const norm=value=>exactCounterpartyKey(value).toLocaleLowerCase('fa');
const fail=message=>Object.assign(new Error(message),{code:'REVIEW_DETAILS_REQUIRED',status:409});
/** No writes in preview. Applied only inside the journal's approval transaction. */
export function prepareReviewResources(database,event,proposal,{evidence='',facts={},messages=[],apply=false}={}) {
  const result={event:{...event},newCounterparty:null,inventoryItems:[],blockers:[]};
  if(proposal.lines.some(l=>partyRoles.has(l.role)) && !event.counterpartyId) {
    const name=String(facts.counterpartyName || event.counterparty || proposal.counterpartyName || extractContactName(evidence) || '').trim().replace(/^(?:بله|بلی|آره)[،,:]\s*/, '');
    const knownText=[evidence,event.counterparty,...messages.filter(m=>m.speaker==='accountant').map(m=>m.body),facts.counterpartyName].filter(Boolean).join(' ');
    if(name.length<2 || name.length>100 || !norm(knownText).includes(norm(name))) result.blockers.push('نام واقعی طرف‌حساب در متن یا پاسخ حسابدار مشخص نیست؛ نام او را بگو.');
    else {
      try {
        const {contact}=resolveCounterparty(database,name);
        if(contact) {result.event.counterpartyId=contact.id;result.event.counterparty=contact.name;}
        else {
          const kind=proposal.lines.some(l=>['receivable','cheque-receivable','customer-advance','deferred-revenue','refundable-deposit','loan-payable'].includes(l.role))?'customer':'vendor';
          result.newCounterparty={name,kind};result.event.counterparty=name;
          if(apply) {
            const id=randomUUID(),clean=normalizedCounterpartyInput(name);
            database.prepare('INSERT INTO contacts(id,name,canonical_name,kind) VALUES(?,?,?,?)').run(id,clean.displayName,clean.canonicalName,kind);
            result.event.counterpartyId=id;
          }
        }
      } catch(error) {if(error.code!=='COUNTERPARTY_SIMILAR') throw error;result.blockers.push(error.message);}
    }
  }
  const inventory=proposal.lines.filter(l=>l.role==='inventory-asset');
  if(!inventory.length) return result;
  const items=proposal.inventoryItems || [];
  if(!items.length) {result.blockers.push('برای ورود انبار، نام کالا، مقدار و واحد را مشخص کن.');return result;}
  const other=proposal.lines.filter(l=>l.role!=='inventory-asset');
  if(other.length!==1 || !['cheque-payable','payable'].includes(other[0].role) || other[0].debit || inventory.some(l=>l.credit || !l.debit)) result.blockers.push('این پیشنهاد انبار فقط خرید تحویل‌شده با چک یا خرید نسیه را پشتیبانی می‌کند.');
  const used=new Set();
  for(const item of items) {
    const name=String(item.name || '').trim(), unit=String(item.unit || '').trim(), quantity=Number(item.quantity), total=Number(item.total);
    if(!name || name.length>120 || !unit || unit.length>30 || !Number.isFinite(quantity) || quantity<=0 || quantity>1e9 || !Number.isSafeInteger(total) || total<=0) {result.blockers.push('نام، مقدار، واحد و بهای خرید هر کالا باید مشخص و معتبر باشد؛ مقدار فرضی نمی‌سازیم.');continue;}
    const matches=database.prepare('SELECT id,name,unit,track_inventory FROM products').all().filter(p=>item.productId ? p.id===item.productId : norm(p.name)===norm(name));
    let product=matches.length===1 ? matches[0] : null;
    if(item.productId && !product || matches.length>1) {result.blockers.push('کالای پیشنهادی پیدا نشد یا چند کالا هم‌نام‌اند؛ هویت کالا نیاز به بازبینی دارد.');continue;}
    if(product && (!product.track_inventory || norm(product.unit)!==norm(unit))) {result.blockers.push(`واحد یا قابلیت رهگیری «${name}» با کالای موجود سازگار نیست؛ واحد واقعی را مشخص کن.`);continue;}
    if(used.has(norm(name))) {result.blockers.push('کالای تکراری در پیشنهاد وجود دارد؛ مقدارها باید در یک ردیف جمع شوند.');continue;}used.add(norm(name));
    const lines=inventory.filter(l=>norm(l.key)===norm(name));
    if(lines.length!==1 || lines[0].debit!==total) {result.blockers.push(`بهای ورود «${name}» با سطر سند برابر نیست.`);continue;}
    if(product) {
      const latest=database.prepare('SELECT occurred_at FROM stock_movements WHERE product_id=? ORDER BY occurred_at DESC LIMIT 1').get(product.id);
      if(latest?.occurred_at?.slice(0,10)>event.occurredAt?.slice(0,10)) {result.blockers.push(`خرید «${name}» قبل از گردش ثبت‌شدهٔ بعدی است؛ ارزش‌گذاری دوره باید ابتدا بررسی شود.`);continue;}
    }
    const newProduct=!product;
    if(apply && newProduct) {
      const id=randomUUID();database.prepare('INSERT INTO products(id,name,unit,stock,inventory_value,average_cost,track_inventory) VALUES(?,?,?,0,0,0,1)').run(id,name,unit);
      product={id,name,unit,track_inventory:1};
    }
    result.inventoryItems.push({...item,name,unit,quantity,total,productId:product?.id || null,newProduct});
  }
  if(result.inventoryItems.length!==inventory.length || items.reduce((n,i)=>n+Number(i.total || 0),0)!==inventory.reduce((n,l)=>n+l.debit,0)) result.blockers.push('گردش کالا و ارزش سند خرید با هم تطبیق ندارند.');
  return result;
}
export function applyReviewInventory(database,eventId,event,items,{actor,timeZone}={}) {
  for(const item of items) recordInventoryMovement(database,item.productId,{quantity:item.quantity,valueDelta:item.total,movementType:'purchase',sourceType:'accountant-review',sourceId:eventId,occurredAt:event.occurredAt,note:`ورود خرید تأییدشده — ${event.counterparty || ''}`},{createdBy:actor,timeZone,journal:false});
}
export function reverseReviewInventory(database,eventId,{actor,timeZone}={}) {
  const rows=database.prepare("SELECT rowid AS sequence,* FROM stock_movements WHERE source_type='accountant-review' AND source_id=? ORDER BY rowid DESC").all(eventId);
  for(const row of rows) {
    const later=database.prepare("SELECT id FROM stock_movements WHERE product_id=? AND rowid>? AND NOT(source_type='review-reversal' AND source_id=?) LIMIT 1").get(row.product_id,row.sequence,eventId);
    if(later) throw fail('بعد از این خرید گردش انبار دیگری ثبت شده؛ ابتدا گردش‌های بعدی را اصلاح کن.');
    recordInventoryMovement(database,row.product_id,{quantity:-row.quantity,valueDelta:-row.value_delta,movementType:'reversal',sourceType:'review-reversal',sourceId:eventId,occurredAt:new Date().toISOString(),note:'برگشت خرید بررسی‌شده'},{createdBy:actor,timeZone,journal:false});
  }
}
