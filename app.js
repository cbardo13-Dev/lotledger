const DAY=864e5;
const CHANNELS=['TikTok Shop','Live (off-platform)','Other'];
let state, tab='home', period=30, stockFilter='instock', stockQuery='';
let sheetCh=CHANNELS[0], logType='invest', resetArmed=false, costCache=new Map();

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=(n,d=0)=>(n<0?'−':'')+'$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const uid=()=>(crypto.randomUUID?crypto.randomUUID():'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(+c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>+c/4).toString(16)));
const iso=d=>{const x=new Date(d);return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0')};
const today=()=>iso(Date.now());
const daysAgo=n=>iso(Date.now()-n*DAY);
const dt=s=>new Date(s+'T12:00:00').getTime();
const daysSince=s=>Math.max(0,Math.floor((Date.now()-dt(s))/DAY));
const lotNo=n=>'Lot '+String(n).padStart(3,'0');
const shortDate=s=>new Date(s+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

function seed(){
  const rnd=mulberry32(Date.now()%100000);
  const settings=state.settings;
  const defs=[
    {name:'Sneaker cleaning kits',supplier:'CleanStep Wholesale',age:70,cost:300,ship:40,funded:'seller',items:[['Sneaker cleaning kit',50,15,.86]]},
    {name:'Retail returns pallet: small electronics',supplier:'Gulf Coast Liquidators',age:45,cost:950,ship:180,funded:'backer',items:[['Wireless earbuds',30,25,.8],['Ring light with phone clip',20,18,.75],['Bluetooth speaker',12,35,.17],['USB-C cables, 3-pack',40,9,.7]]},
    {name:'Beauty overstock case lot',supplier:'Shelfpull Beauty',age:28,cost:650,ship:60,funded:'backer',items:[['Lip gloss gift set',60,12,.62],['Hot air styling brush',25,28,.6],['Vitamin C serum',40,15,.45]]},
    {name:'Kitchen gadget closeout',supplier:'Gulf Coast Liquidators',age:12,cost:900,ship:120,funded:'backer',items:[['Mini waffle maker',24,22,.38],['Silicone utensil set',36,16,.28],['Handheld milk frother',30,14,.33]]}
  ];
  const lots=[],items=[],sales=[];
  defs.forEach((L,k)=>{
    const lot={id:uid(),no:k+1,name:L.name,supplier:L.supplier,date:daysAgo(L.age),cost:L.cost,shipIn:L.ship,funded:L.funded};
    lots.push(lot);
    L.items.forEach(([name,qty,est,frac])=>{
      const it={id:uid(),lotId:lot.id,name,qty,est,onHand:qty};
      items.push(it);
      const toSell=Math.round(qty*frac); let sold=0;
      while(sold<toSell){
        const q=Math.min(toSell-sold,rnd()<.82?1:2);
        const age=Math.floor(rnd()*Math.max(1,L.age-1));
        const r=rnd(); const channel=r<.68?CHANNELS[0]:r<.94?CHANNELS[1]:CHANNELS[2];
        const price=Math.round(est*(.85+rnd()*.3)*100)/100;
        sales.push({id:uid(),itemId:it.id,date:daysAgo(age),qty:q,price,channel,shipOut:channel===CHANNELS[0]?0:4.5,feePct:settings.fees[channel]});
        sold+=q;
      }
      it.onHand=qty-toSell;
    });
  });
  const capital=[
    {id:uid(),type:'invest',amount:3000,date:daysAgo(50),note:'Initial capital'},
    {id:uid(),type:'invest',amount:1000,date:daysAgo(14),note:'Added for kitchen closeout'},
    {id:uid(),type:'payout',amount:600,date:daysAgo(9),note:'First profit payout'}
  ];
  return {settings,lots,items,sales,capital};
}
/* ---------- Supabase connection ---------- */
const CFG_KEY='lotledger-connection', BIZ_KEY='lotledger-shop';
let migrated=null, sb=null, session=null, biz=null, role='owner', memberships=[], lastLoad=0, gate=null, authMode='signin', online=true;
const lsGet=k=>{try{return localStorage.getItem(k)}catch(e){return null}};
const lsSet=(k,v)=>{try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch(e){}};
function connection(){
  const C=window.LOTLEDGER_CONFIG||{};
  if(C.SUPABASE_URL&&C.SUPABASE_KEY)return {url:C.SUPABASE_URL.trim(),key:C.SUPABASE_KEY.trim(),fromFile:true};
  try{const c=JSON.parse(lsGet(CFG_KEY)||'null');if(c&&c.url&&c.key)return c}catch(e){}
  return null;
}
const canWrite=()=>role==='owner'||role==='staff';
const friendly=e=>{
  const m=String((e&&(e.message||e.error_description||e.msg))||e||'Something went wrong');
  if(/Failed to fetch|NetworkError|Load failed/i.test(m))return "Can't reach the server. Check your connection and try again.";
  if(/Invalid login/i.test(m))return 'That email and password don\'t match. Try again or reset your password.';
  if(/Email not confirmed/i.test(m))return 'Confirm your email first. Check your inbox for the link.';
  if(/JWT|session|expired/i.test(m))return 'Your sign-in expired. Sign in again.';
  return m;
};
async function busy(btn,fn){
  if(btn){if(btn.disabled)return;btn.disabled=true;btn._t=btn.textContent;btn.textContent='Saving…'}
  try{return await fn()}finally{if(btn&&btn.isConnected){btn.disabled=false;btn.textContent=btn._t}}
}

/* row mapping: database (snake_case) <-> app (camelCase) */
const fromLot=r=>({id:r.id,no:r.no,name:r.name,supplier:r.supplier,date:r.date,cost:+r.cost,shipIn:+r.ship_in,funded:r.funded,costMode:r.cost_mode,kind:r.kind||'lot',photos:r.photos||[],closed:!!r.closed,vendorId:r.vendor_id||null});
const fromItem=r=>({id:r.id,lotId:r.lot_id,name:r.name||'',qty:r.qty,est:+r.est,onHand:r.on_hand,unitCost:r.unit_cost==null?undefined:+r.unit_cost,barcode:r.barcode||undefined});
const fromSale=r=>({id:r.id,itemId:r.item_id,date:r.date,qty:r.qty,price:+r.price,channel:r.channel,shipOut:+r.ship_out,feePct:+r.fee_pct});
const fromCap=r=>({id:r.id,type:r.type,amount:+r.amount,date:r.date,note:r.note||''});
const fromBiz=b=>({shopName:b.name,sellerName:b.seller_name,backerName:b.backer_name,split:+b.split,fees:Object.assign({'TikTok Shop':0,'Live (off-platform)':0,'Other':0},b.fees||{})});

async function fetchAll(table){
  const out=[]; const size=1000;
  for(let from=0;;from+=size){
    const {data,error}=await sb.from(table).select('*').eq('business_id',biz.id).order('created_at').order(table==='products'?'barcode':'id').range(from,from+size-1);
    if(error)throw error;
    out.push(...data); if(data.length<size)break;
  }
  return out;
}
async function loadAll(){
  const [lots,items,sales,capital,products,vendors]=await Promise.all(['lots','items','sales','capital','products','vendors'].map(t=>fetchAll(t).catch(e=>{if(t==='vendors')return [];throw e})));
  state={settings:fromBiz(biz),lots:lots.map(fromLot),items:items.map(fromItem),sales:sales.map(fromSale),capital:capital.map(fromCap),products:new Map(products.map(p=>[p.barcode,p])),vendors};
  if(migrated===null){const r=await sb.from('lots').select('kind').limit(1);migrated=!r.error}
  inflight.concat([...pendingQ.values()]).forEach(e=>localApply(e.lotId,e.barcode,e.qty,e.name));
  lastLoad=Date.now();
}
async function loadShop(){
  const {data,error}=await sb.from('business_members').select('role,businesses(*)').eq('user_id',session.user.id);
  if(error)throw error;
  memberships=(data||[]).filter(m=>m.businesses);
  if(!memberships.length)throw new Error('No shop found for this account. Run the setup SQL, then create a new account.');
  const pick=memberships.find(m=>m.businesses.id===lsGet(BIZ_KEY))||memberships.find(m=>m.role==='owner')||memberships[0];
  biz=pick.businesses; role=pick.role; lsSet(BIZ_KEY,biz.id);
  document.body.classList.toggle('ro',!canWrite());
  if(!canWrite()&&tab==='home')tab='backer';
  await loadAll();
}
async function refresh(quiet){
  if(!session||!biz)return;
  try{
    const {data,error}=await sb.from('businesses').select('*').eq('id',biz.id).single();
    if(error)throw error; biz=data; await loadAll(); online=true;
    if($('#scrim').hidden)render();
  }catch(e){online=false;if(!quiet)toast(friendly(e))}
}

/* ---------- gate screens: connect, sign in ---------- */
function showGate(html){gate=true;document.body.classList.add('gated');$('#main').innerHTML=`<div class="gate"><div class="brand"><span class="mark" aria-hidden="true"></span>LotLedger</div>${html}</div>`;const f=$('#main input');f&&f.focus()}
function viewConnect(msg){
  showGate(`<p class="sub">Connect this app to your Supabase project. You only do this once per device.</p>
  <section class="panel">
    <label class="field"><span>Project URL</span><input id="c-url" placeholder="https://abcd1234.supabase.co" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
    <label class="field"><span>Publishable key (or anon key)</span><input id="c-key" placeholder="sb_publishable_…" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
    <p class="note" style="margin:0 0 12px">In Supabase, tap Connect at the top of your project (or Project Settings, then API Keys). Never paste the secret or service_role key here.</p>
    <p class="err" id="c-err">${esc(msg||'')}</p>
    <button class="primary" data-action="connect">Connect</button>
  </section>`);
}
function viewAuth(msg,ok){
  const up=authMode==='signup', reset=authMode==='reset', newpw=authMode==='newpw';
  const title=up?'Create your account':reset?'Reset your password':newpw?'Choose a new password':'Sign in';
  showGate(`<p class="sub">${up?'Your account gets its own private shop. Anyone you invite can see it too.':'Inventory and profit for bulk resellers.'}</p>
  <section class="panel"><h2>${title}</h2>
    ${newpw?'':`<label class="field"><span>Email</span><input id="a-email" type="email" autocomplete="email" autocapitalize="off" inputmode="email"></label>`}
    ${reset?'':`<label class="field"><span>${newpw?'New password':'Password'}</span><input id="a-pw" type="password" autocomplete="${up||newpw?'new-password':'current-password'}" minlength="6"></label>`}
    <p class="okmsg">${ok?esc(ok):''}</p><p class="err" id="a-err">${msg?esc(msg):''}</p>
    <button class="primary" data-action="auth-go">${up?'Create account':reset?'Email me a reset link':newpw?'Save new password':'Sign in'}</button>
    ${newpw?'':up?'<button class="linkbtn" data-action="auth-mode" data-mode="signin">I already have an account</button>'
      :reset?'<button class="linkbtn" data-action="auth-mode" data-mode="signin">Back to sign in</button>'
      :'<button class="linkbtn" data-action="auth-mode" data-mode="signup">Create an account</button><button class="linkbtn" data-action="auth-mode" data-mode="reset" style="margin-top:4px">Forgot password?</button>'}
  </section>
  ${connection()&&!connection().fromFile?'<button class="linkbtn muted" data-action="disconnect">Connect to a different Supabase project</button>':''}`);
}
async function doConnect(btn){
  let url=$('#c-url').value.trim().replace(/\/+$/,''), key=$('#c-key').value.trim(), err=$('#c-err');
  if(/^[a-z0-9]{20}$/.test(url))url=`https://${url}.supabase.co`;
  if(!/^https:\/\/.+/.test(url))return err.textContent='The URL should start with https:// and end in .supabase.co';
  if(!key)return err.textContent='Paste the publishable key.';
  if(/^sb_secret_/.test(key)||/service_role/.test(atobSafe(key)))return err.textContent='That is a secret key. Use the publishable (or anon) key instead.';
  await busy(btn,async()=>{
    try{
      const test=supabase.createClient(url,key,{auth:{persistSession:false}});
      const {error}=await test.from('businesses').select('id').limit(1);
      if(error&&!/permission|policy|JWT/i.test(error.message)){
        if(/relation|does not exist|schema cache/i.test(error.message))throw new Error('Connected, but the tables are missing. Run schema.sql in the Supabase SQL Editor first.');
        throw error;
      }
      lsSet(CFG_KEY,JSON.stringify({url,key})); start();
    }catch(e){err.textContent=friendly(e)}
  });
}
function atobSafe(k){try{return atob(k.split('.')[1]||'')}catch(e){return ''}}
async function doAuth(btn){
  const err=$('#a-err'); err.textContent='';
  const email=($('#a-email')||{}).value?.trim(), pw=($('#a-pw')||{}).value;
  const back=location.origin+location.pathname;
  if(authMode!=='newpw'&&!email)return err.textContent='Enter your email.';
  if(authMode!=='reset'&&(!pw||pw.length<6))return err.textContent='Password needs at least 6 characters.';
  await busy(btn,async()=>{
    try{
      if(authMode==='signin'){const {error}=await sb.auth.signInWithPassword({email,password:pw});if(error)throw error}
      else if(authMode==='signup'){
        const {data,error}=await sb.auth.signUp({email,password:pw,options:{emailRedirectTo:back}});
        if(error)throw error;
        if(!data.session){authMode='signin';viewAuth('',`Almost done. Open the confirmation email sent to ${email}, then sign in here.`)}
      }
      else if(authMode==='reset'){
        const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:back}); if(error)throw error;
        authMode='signin'; viewAuth('','Check your email for a reset link.');
      }
      else if(authMode==='newpw'){
        const {error}=await sb.auth.updateUser({password:pw}); if(error)throw error;
        authMode='signin'; toast('Password updated'); await enterApp();
      }
    }catch(e){if(err.isConnected)err.textContent=friendly(e)}
  });
}
async function enterApp(){
  $('#main').innerHTML='<div class="loading">Loading your shop…</div>';
  try{await sb.rpc('accept_invites').then(()=>{},()=>{});await loadShop();gate=false;document.body.classList.remove('gated');render();restoreQ()}
  catch(e){authMode='signin';viewAuth(friendly(e))}
}
async function start(){
  const c=connection();
  if(!c)return viewConnect();
  if(typeof supabase==='undefined')return viewConnect("The Supabase library didn't load. Check your internet connection and reload.");
  sb=supabase.createClient(c.url,c.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  let entered=false;
  sb.auth.onAuthStateChange((ev,s)=>{
    session=s;
    if(ev==='PASSWORD_RECOVERY'){authMode='newpw';viewAuth();return}
    if(ev==='SIGNED_OUT'){entered=false;biz=null;state=null;authMode='signin';closeSheet();viewAuth();return}
    if(ev==='SIGNED_IN'&&s&&!entered&&authMode!=='newpw'){entered=true;setTimeout(enterApp,0)}
  });
  const {data}=await sb.auth.getSession(); session=data.session;
  if(session&&authMode!=='newpw'){if(!entered){entered=true;enterApp()}}
  else if(authMode!=='newpw')viewAuth();
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!gate&&Date.now()-lastLoad>60000)refresh(true)});

/* ---------- sample data and erase ---------- */
async function loadSample(btn){
  await busy(btn,async()=>{
    try{
      const d=seed(); const B=biz.id;
      const lotMap=new Map(); d.lots.forEach(l=>{const id=uid();lotMap.set(l.id,id);l.newId=id});
      const itemMap=new Map(); d.items.forEach(i=>itemMap.set(i.id,uid()));
      const base=Math.max(0,...state.lots.map(l=>l.no));
      let r=await sb.from('lots').insert(d.lots.map(l=>({id:l.newId,business_id:B,no:base+l.no,name:l.name,supplier:l.supplier,date:l.date,cost:l.cost,ship_in:l.shipIn,funded:l.funded,cost_mode:'value'})));
      if(r.error)throw r.error;
      r=await sb.from('items').insert(d.items.map(i=>({id:itemMap.get(i.id),business_id:B,lot_id:lotMap.get(i.lotId),name:i.name,qty:i.qty,est:i.est,on_hand:i.onHand})));
      if(r.error)throw r.error;
      r=await sb.from('sales').insert(d.sales.map(s=>({business_id:B,item_id:itemMap.get(s.itemId),date:s.date,qty:s.qty,price:s.price,channel:s.channel,ship_out:s.shipOut,fee_pct:s.feePct})));
      if(r.error)throw r.error;
      r=await sb.from('capital').insert(d.capital.map(c=>({business_id:B,type:c.type,amount:c.amount,date:c.date,note:c.note})));
      if(r.error)throw r.error;
      await loadAll(); closeSheet(); tab='home'; render(); toast('Sample data loaded');
    }catch(e){toast(friendly(e))}
  });
}
async function eraseAll(btn){
  await busy(btn,async()=>{
    try{
      for(const t of ['lots','capital','products']){const {error}=await sb.from(t).delete().eq('business_id',biz.id);if(error)throw error}
      pendingQ.clear(); inflight=[]; saveQ();
      await loadAll(); closeSheet(); tab='home'; render(); toast('All data erased');
    }catch(e){toast(friendly(e))}
  });
}

/* ---------- barcode lookup (Edge Function) ---------- */
const lookupCache=new Map();
async function lookupBarcode(code){
  if(lookupCache.has(code))return lookupCache.get(code);
  if(isCard(code)){const r=await cardLookup(code.slice(5));if(r.found)lookupCache.set(code,r);return r}
  if(isBulk(code))return {found:false};
  let res=null;
  try{
    const {data,error}=await sb.functions.invoke('barcode-lookup',{body:{barcode:code}});
    if(error)throw error; res=data;
  }catch(e){res={found:false,error:true}}
  if(res&&!res.error&&!res.limited)lookupCache.set(code,res);
  return res;
}

/* ---------- trading cards: no barcode, so each card gets a stand-in code ----------
   "ptcg:<TCGdex id>" for a specific Pokémon card, "bulk:<kind>" for bulk counted at a set value.
   TCGdex is free, needs no key, and allows browser calls. Prices are TCGplayer market (USD). */
const TCGDEX='https://api.tcgdex.net/v2/en', BULK_KEY='lotledger-bulk-rates';
const BULK=[['common','Common / Uncommon',0.02],['reverse','Reverse holo',0.10],['holo','Holo rare',0.25],['ultra','V / ex / GX',1.00]];
const isCard=c=>/^ptcg:/.test(c||''), isBulk=c=>/^bulk:/.test(c||'');
const codeText=c=>isCard(c)?'Card '+c.slice(5):isBulk(c)?'Bulk card':'Barcode '+c;
const ebaySold=q=>'https://www.ebay.com/sch/i.html?_nkw='+encodeURIComponent(q)+'&LH_Sold=1&LH_Complete=1';
function bulkRates(){let r={};try{r=JSON.parse(lsGet(BULK_KEY)||'{}')||{}}catch(e){}return Object.fromEntries(BULK.map(([k,,d])=>[k,r[k]>=0?+r[k]:d]))}
function marketOf(c){
  const t=c.pricing&&c.pricing.tcgplayer; if(!t)return null;
  for(const k of ['normal','holofoil','reverse-holofoil',...Object.keys(t)]){const v=t[k];if(v&&typeof v==='object'&&v.marketPrice>0)return v.marketPrice}
  return null;
}
function cardRes(c){
  const off=c.set&&c.set.cardCount&&c.set.cardCount.official, num=c.localId+(off&&/^\d+$/.test(c.localId)?'/'+off:''), set=c.set?c.set.name:'';
  return {found:true,source:'tcgdex',title:`${c.name} · ${set} ${num}`.trim(),brand:null,image_url:c.image?c.image+'/low.webp':null,msrp:marketOf(c),ebay:`${c.name} ${num} ${set}`.trim()};
}
async function cardLookup(id){
  try{const r=await fetch(`${TCGDEX}/cards/${encodeURIComponent(id)}`);if(!r.ok)throw 0;return cardRes(await r.json())}
  catch(e){return {found:false,error:true}}
}
/* "Charizard ex 125/197", "Pikachu SWSH039", or just "Charizard". The number filter on TCGdex is a
   contains-match, so exact number (ignoring leading zeros) and the set size are checked here. */
async function cardSearch(q){
  const m=q.trim().match(/^(.+?)\s+#?([A-Za-z]{0,5}\d+[A-Za-z]?)(?:\s*\/\s*([A-Za-z]{0,5}\d+))?$/);
  const name=(m?m[1]:q).trim(), num=m?m[2].toUpperCase().replace(/^0+(?=\d)/,''):'', total=m&&m[3]?+m[3].replace(/\D/g,''):0;
  if(name.length<2)return [];
  const r=await fetch(`${TCGDEX}/cards?name=like:${encodeURIComponent(name)}${num?'&localId=like:'+encodeURIComponent(num):''}`);
  if(!r.ok)throw new Error('lookup');
  let list=(await r.json()).filter(c=>!/\/tcgp\//.test(c.image||''));
  if(num)list=list.filter(c=>c.localId.toUpperCase().replace(/^0+(?=\d)/,'')===num);
  const lc=name.toLowerCase(); list.sort((a,b)=>(b.name.toLowerCase()===lc)-(a.name.toLowerCase()===lc)||(!!b.image)-(!!a.image));
  const more=list.length>12;
  let full=(await Promise.all(list.slice(0,12).map(c=>fetch(`${TCGDEX}/cards/${encodeURIComponent(c.id)}`).then(x=>x.ok?x.json():null).catch(()=>null)))).filter(Boolean);
  if(total){const exact=full.filter(c=>c.set&&c.set.cardCount&&(c.set.cardCount.official===total||c.set.cardCount.total===total));if(exact.length)full=exact}
  const out=full.map(c=>{const res=cardRes(c),code='ptcg:'+c.id;lookupCache.set(code,res);return {code,res}});
  out.more=more; return out;
}
let cardQ='';
async function runCardSearch(){
  const box=$('#cardbox'), out=$('#cardres'); if(!box||!out)return;
  const q=box.value.trim(); if(!q)return; cardQ=q;
  out.innerHTML='<p class="scan-msg">Searching…</p>';
  let rs;
  try{rs=await cardSearch(q)}catch(e){if(cardQ===q&&out.isConnected)out.innerHTML=`<p class="scan-msg">Couldn't reach the card database. Check your connection and try again.</p>`;return}
  if(cardQ!==q||!out.isConnected)return;
  if(!rs.length){out.innerHTML=`<p class="scan-msg">No match. Check the spelling, or try just the name.</p>`;return}
  out.innerHTML=`<ul class="list cardres">${rs.map(({code,res})=>`<li><button class="rowlink" type="button" data-action="card-pick" data-code="${esc(code)}">${res.image_url?`<img src="${esc(res.image_url)}" alt="" loading="lazy" data-imgfallback>`:'<span class="ph"></span>'}<div style="min-width:0;flex:1"><div class="name">${esc(res.title)}</div></div><div class="right num">${res.msrp?money(res.msrp,2):'<span class="meta">No price</span>'}</div></button></li>`).join('')}</ul>
  ${rs.more||!/\d/.test(q)?`<p class="scan-msg">Add the number from the card's bottom corner, like 125/197, to find the exact one.</p>`:''}`;
  out.querySelectorAll('img[data-imgfallback]').forEach(img=>img.onerror=()=>img.remove());
}
function pickCard(code){const out=$('#cardres');if(out)out.innerHTML='';handleScan(code);const b=$('#cardbox');if(b)b.select()}
function addBulk(k){
  const b=BULK.find(x=>x[0]===k); if(!b)return;
  rememberProduct('bulk:'+k,{name:'Pokémon bulk: '+b[1],est:bulkRates()[k]});
  handleScan('bulk:'+k);
}
function renderBulkRates(){
  const box=$('#bulkrates'); if(!box)return;
  if(box.innerHTML){box.innerHTML='';return}
  const r=bulkRates();
  box.innerHTML=`<div class="grid2" style="margin-top:8px">${BULK.map(([k,t])=>`<label class="field"><span>${esc(t)}, each</span><input data-bulk="${k}" type="number" min="0" step="0.01" inputmode="decimal" value="${r[k]}"></label>`).join('')}</div><p class="scan-msg" style="margin-top:0">Used as the sell price for each bulk card. Saved on this device.</p>`;
  box.querySelectorAll('[data-bulk]').forEach(i=>i.addEventListener('change',()=>{const cur=bulkRates();const v=+i.value;if(i.value!==''&&v>=0)cur[i.dataset.bulk]=v;lsSet(BULK_KEY,JSON.stringify(cur))}));
}

/* cost math. even: lot price + shipping split equally over every unit applied so far.
   item: each unit's own cost plus a share of shipping. value (older lots): split by expected resale value. */
function computeCosts(){
  costCache=new Map();
  state.lots.forEach(l=>{
    const its=state.items.filter(i=>i.lotId===l.id);
    if(l.costMode==='even'){
      const units=its.reduce((a,i)=>a+i.qty,0);
      its.forEach(i=>costCache.set(i.id,units?(l.cost+l.shipIn)/units:0));
      return;
    }
    if(l.costMode==='item'){
      const base=its.reduce((a,i)=>a+(i.unitCost||0)*i.qty,0);
      its.forEach(i=>costCache.set(i.id,(i.unitCost||0)+(base?l.shipIn*(i.unitCost||0)/base:0)));
      return;
    }
    const tot=its.reduce((a,i)=>a+i.est*i.qty,0);
    its.forEach(i=>costCache.set(i.id,tot?(l.cost+l.shipIn)*i.est/tot:0));
  });
}
const uc=i=>costCache.get(i.id)||0;
const item=id=>state.items.find(i=>i.id===id);
const lot=id=>state.lots.find(l=>l.id===id);
const nm=i=>i?(i.name||(i.barcode?`Unnamed (${i.barcode})`:'Unnamed item')):'Deleted item';
const lotLabel=l=>l.kind==='single'?'Buy '+String(l.no).padStart(3,'0'):lotNo(l.no);
function saleCalc(s){
  const it=item(s.itemId); const rev=s.price*s.qty; const fee=rev*(s.feePct||0)/100;
  const cost=(it?uc(it):0)*s.qty; return {rev,fee,cost,net:rev-fee-(s.shipOut||0)-cost};
}
function lotStats(l){
  const its=state.items.filter(i=>i.lotId===l.id);
  const ids=new Set(its.map(i=>i.id));
  const units=its.reduce((a,i)=>a+i.qty,0), left=its.reduce((a,i)=>a+i.onHand,0);
  let rev=0,recovered=0,net=0;
  state.sales.forEach(s=>{if(ids.has(s.itemId)){const c=saleCalc(s);rev+=c.rev;recovered+=c.rev-c.fee-(s.shipOut||0);net+=c.net}});
  const landed=l.cost+l.shipIn;
  return {its,units,left,sold:units-left,landed,rev,recovered,net,profit:recovered-landed,paid:landed?recovered/landed:0,age:daysSince(l.date),estLeft:its.reduce((a,i)=>a+i.onHand*i.est,0)};
}

/* ---------- views ---------- */
function render(){
  if(gate||!state)return;
  computeCosts();
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  const m=$('#main');
  m.innerHTML=({home:viewHome,stock:viewStock,lots:viewLots,backer:viewBacker})[tab]();
  if(tab==='stock'){const s=$('#q');s.addEventListener('input',e=>{stockQuery=e.target.value;$('#stocklist').innerHTML=stockRows()});}
}

function viewHome(){
  const cut=period?Date.now()-period*DAY:0;
  const ss=state.sales.filter(s=>dt(s.date)>=cut);
  let rev=0,net=0,units=0,fees=0; ss.forEach(s=>{const c=saleCalc(s);rev+=c.rev;net+=c.net;fees+=c.fee;units+=s.qty});
  const stockVal=state.items.reduce((a,i)=>a+i.onHand*uc(i),0);
  const margin=rev?net/rev*100:0;
  const label=period?`last ${period} days`:'all time';

  // needs a push
  const push=state.items.filter(i=>{const l=lot(i.lotId);return i.onHand>0&&daysSince(l.date)>=25&&(i.qty-i.onHand)/i.qty<.5})
    .map(i=>({i,tied:i.onHand*uc(i),age:daysSince(lot(i.lotId).date)})).sort((a,b)=>b.tied-a.tied).slice(0,4);
  // top sellers
  const agg=new Map(); ss.forEach(s=>{const c=saleCalc(s);const a=agg.get(s.itemId)||{u:0,n:0,r:0};a.u+=s.qty;a.n+=c.net;a.r+=c.rev;agg.set(s.itemId,a)});
  const top=[...agg.entries()].sort((a,b)=>b[1].u-a[1].u).slice(0,5);

  return `
  <h1>Profit</h1>
  ${!state.lots.length?`<section class="panel"><h3>Welcome to ${esc(state.settings.shopName)}</h3><p class="note" style="margin:0 0 12px">${canWrite()?'Tap Buy to scan in your first items or lot. Or load sample data to try everything out first, then erase it from Settings when you\'re ready for real stock.':'Nothing has been added to this shop yet.'}</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap" data-write><button class="primary" data-action="buy">Buy: add stock</button><button class="ghost" data-action="sample">Load sample data</button></div></section>`:''}
  <section class="panel hero">
    <div class="hero-top">
      <div><div class="muted">Net profit, ${label}</div>
      <div class="big num ${net<0?'loss':''}">${money(net)}</div></div>
      <div class="period" role="group" aria-label="Time period">
        ${[[7,'7d'],[30,'30d'],[90,'90d'],[0,'All']].map(([p,t])=>`<button data-period="${p}" class="${p===period?'on':''}">${t}</button>`).join('')}
      </div>
    </div>
    <div class="stats">
      <div class="stat"><span class="v num">${money(rev)}</span><span class="k">Sales</span></div>
      <div class="stat"><span class="v num">${margin.toFixed(0)}%</span><span class="k">Margin after fees and cost</span></div>
      <div class="stat"><span class="v num">${units}</span><span class="k">Units sold</span></div>
      <div class="stat"><span class="v num">${money(stockVal)}</span><span class="k">Cash sitting in stock</span></div>
    </div>
  </section>
  <section class="panel chart"><h3>Net profit by week</h3>${weekChart()}</section>
  <div class="cols">
    <section class="panel"><h3>Needs a push in your next live</h3>
      ${push.length?`<ul class="list">${push.map(p=>`<li><button class="rowlink" data-action="item" data-item="${p.i.id}"><div><div class="name">${esc(nm(p.i))}</div><div class="meta">${p.i.onHand} left, bought ${p.age} days ago</div></div><div class="right"><div class="num" style="font-size:20px">${money(p.tied)}</div><div class="meta">tied up</div></div></button></li>`).join('')}</ul>`:'<p class="empty">Nothing is sitting too long. Stock is moving.</p>'}
    </section>
    <section class="panel"><h3>Best sellers, ${label}</h3>
      ${top.length?`<ul class="list">${top.map(([id,a])=>{const i=item(id);return `<li><button class="rowlink" data-action="item" data-item="${id}"><div><div class="name">${esc(nm(i))}</div><div class="meta">${a.u} sold, avg ${money(a.r/a.u,2)}</div></div><div class="right num ${a.n<0?'loss':'gain'}" style="font-size:20px">${money(a.n)}</div></button></li>`}).join('')}</ul>`:'<p class="empty">No sales in this period yet. Tap Sell to record one.</p>'}
    </section>
  </div>`;
}

function weekChart(){
  const W=8, now=Date.now(); const b=new Array(W).fill(0);
  state.sales.forEach(s=>{const w=Math.floor((now-dt(s.date))/(7*DAY));if(w>=0&&w<W)b[W-1-w]+=saleCalc(s).net});
  const max=Math.max(1,...b.map(Math.abs)); const w=640,h=200,pad=26,bw=w/W;
  const hasNeg=b.some(v=>v<0); const zero=hasNeg?h/2+8:h-pad;
  const scale=(hasNeg?(h/2-pad):(h-pad*2-4))/max;
  let out=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Weekly net profit for the last 8 weeks">`;
  out+=`<line x1="0" x2="${w}" y1="${zero}" y2="${zero}" stroke="var(--line)"/>`;
  b.forEach((v,k)=>{
    const bh=Math.abs(v)*scale, x=k*bw+bw*.18, bwid=bw*.64, y=v>=0?zero-bh:zero;
    const fill=k===W-1?'var(--tape)':(v<0?'var(--loss)':'var(--ink)');
    out+=`<rect x="${x}" y="${y}" width="${bwid}" height="${Math.max(bh,1)}" rx="3" fill="${fill}"/>`;
    out+=`<text class="val" x="${x+bwid/2}" y="${v>=0?y-6:y+bh+14}" text-anchor="middle">${money(v)}</text>`;
    const lbl=k===W-1?'This week':(W-1-k)+'w ago';
    out+=`<text x="${x+bwid/2}" y="${h-6}" text-anchor="middle">${lbl}</text>`;
  });
  return out+'</svg>';
}

function stockRows(){
  const q=stockQuery.trim().toLowerCase();
  let its=state.items.slice();
  if(stockFilter==='instock')its=its.filter(i=>i.onHand>0);
  if(stockFilter==='soldout')its=its.filter(i=>i.onHand===0);
  if(stockFilter==='unnamed')its=its.filter(i=>!i.name);
  if(q)its=its.filter(i=>i.name.toLowerCase().includes(q)||lot(i.lotId).name.toLowerCase().includes(q)||(i.barcode||'').includes(q));
  its.sort((a,b)=>dt(lot(b.lotId).date)-dt(lot(a.lotId).date));
  if(!its.length)return `<p class="empty">${stockFilter==='unnamed'?'Everything has a name.':'No items match. Try a different search, or tap Buy to add stock.'}</p>`;
  return `<ul class="list">${its.map(i=>{const l=lot(i.lotId);return `<li class="stockrow">
    <button class="rowtext left" data-action="item" data-item="${i.id}"><div class="name">${esc(nm(i))}</div>
    <div class="meta"><span class="pill">${lotLabel(l)}</span>cost ${money(uc(i),2)} each${i.est>0?`, sell for ${money(i.est,2)}`:''}</div></button>
    <div class="right" style="display:flex;align-items:center;gap:12px">
      <div><div class="qty num">${i.onHand}</div><div class="meta">of ${i.qty}</div></div>
      <button class="btn-sm" data-write data-action="sell" data-item="${i.id}" ${i.onHand?'':'disabled'}>Sell</button>
    </div></li>`}).join('')}</ul>`;
}
function viewStock(){
  const units=state.items.reduce((a,i)=>a+i.onHand,0), unnamed=state.items.filter(i=>!i.name).length;
  return `<h1>Stock</h1><p class="sub">${units} units on hand across ${state.items.filter(i=>i.onHand).length} items. Tap an item to see its sales history or give it a name. Cost per unit includes its share of the lot price and inbound shipping.</p>
  <div class="toolbar"><input id="q" class="search" type="search" placeholder="Search items, lots, or barcodes" value="${esc(stockQuery)}" aria-label="Search stock">
  <div class="chips">${[['instock','In stock'],['all','All'],['soldout','Sold out']].concat(unnamed?[['unnamed',`Needs a name (${unnamed})`]]:[]).map(([f,t])=>`<button class="chip ${f===stockFilter?'on':''}" data-filter="${f}">${t}</button>`).join('')}</div></div>
  <section class="panel" id="stocklist">${stockRows()}</section>`;
}

function lotTag(l){
  const s=lotStats(l); const pct=s.units?s.sold/s.units*100:0;
  const fund=l.funded==='backer'?`Funded by ${esc(state.settings.backerName)}`:`Funded by ${esc(state.settings.sellerName)}`;
  const avg=l.costMode==='even'?(s.units?`Avg cost ${money(s.landed/s.units,2)} a unit over ${s.units} units`:'No items applied yet. Tap to start scanning.'):'';
  return `<button class="tag" data-action="lot" data-lot="${l.id}">
    <div class="tag-head"><span class="hole"></span><span class="tag-no">${lotLabel(l)}</span><span class="tag-fund">${l.closed?'Done · ':''}${fund}</span></div>
    <div class="tag-body">
      <div class="tag-name">${esc(l.name)}</div>
      <div class="tag-meta">${esc(l.supplier)}, bought ${shortDate(l.date)} (${s.age} days ago)${l.photos.length?` · ${l.photos.length} photo${l.photos.length>1?'s':''}`:''}</div>
      ${avg?`<div class="tag-meta" style="color:var(--ink);font-weight:600;margin-top:6px">${avg}</div>`:''}
      <div class="bar" aria-label="${pct.toFixed(0)} percent sold"><i style="width:${pct}%"></i></div>
      <div class="bar-cap"><span>Sold ${s.sold} of ${s.units} units</span><span>${pct.toFixed(0)}%</span></div>
      <div class="tag-figs">
        <div><span class="v num">${money(s.landed)}</span><span class="k">${l.kind==='single'?'Total paid':'Landed cost'}</span></div>
        <div><span class="v num">${money(s.recovered)}</span><span class="k">Taken in after fees</span></div>
        <div><span class="v num ${s.profit<0?'loss':'gain'}">${money(s.profit)}</span><span class="k">${s.profit<0?`Paid back ${(s.paid*100).toFixed(0)}%`:'Profit, fully paid off'}</span></div>
      </div>
    </div></button>`;
}
let lotsFilter='all';
function viewLots(){
  let lots=state.lots.slice().sort((a,b)=>dt(b.date)-dt(a.date)||b.no-a.no);
  const hasSingles=lots.some(l=>l.kind==='single');
  if(lotsFilter==='lot')lots=lots.filter(l=>l.kind!=='single');
  if(lotsFilter==='single')lots=lots.filter(l=>l.kind==='single');
  return `<div class="headrow"><div><h1>Lots</h1><p class="sub" style="margin:0">Every pallet and buying trip, tracked until it pays for itself.</p></div>
  <span style="display:flex;gap:8px;flex-wrap:wrap"><button class="primary" data-write data-action="buy-newlot">New lot</button></span></div>
  ${hasSingles?`<div class="chips" style="margin-bottom:12px">${[['all','All'],['lot','Lots and pallets'],['single','Single buys']].map(([f,t])=>`<button class="chip ${f===lotsFilter?'on':''}" data-lotsfilter="${f}">${t}</button>`).join('')}</div>`:''}
  ${lots.length?`<div class="lots">${lots.map(lotTag).join('')}</div>`:'<section class="panel"><p class="empty">Nothing bought yet. Tap Buy to scan in single items or start a lot.</p></section>'}`;
}

function backerNumbers(){
  const inv=state.capital.filter(c=>c.type==='invest').reduce((a,c)=>a+c.amount,0);
  const paid=state.capital.filter(c=>c.type==='payout').reduce((a,c)=>a+c.amount,0);
  const bl=state.lots.filter(l=>l.funded==='backer');
  let realized=0,inStock=0,deployed=0;
  bl.forEach(l=>{const s=lotStats(l);realized+=s.net;deployed+=s.landed;s.its.forEach(i=>inStock+=i.onHand*uc(i))});
  const share=Math.max(0,realized)*state.settings.split/100;
  return {inv,paid,realized,inStock,deployed,share,owed:inv+share-paid,bl};
}
function viewBacker(){
  const b=backerNumbers(); const S=state.settings;
  const ledger=state.capital.slice().sort((a,c)=>dt(c.date)-dt(a.date));
  return `<div class="headrow"><div><h1>${esc(S.backerName)}'s view</h1><p class="sub" style="margin:0">What's been put in, where it is now, and what's owed back.</p></div>
  <button class="primary" data-write data-action="log">Log money in or out</button></div>
  <section class="panel hero">
    <div class="muted">Balance owed to ${esc(S.backerName)}</div>
    <div class="owed"><span class="big num">${money(b.owed)}</span><span class="muted">capital plus ${S.split}% of profit, minus payouts</span></div>
    <div class="stats">
      <div class="stat"><span class="v num">${money(b.inv)}</span><span class="k">Capital put in</span></div>
      <div class="stat"><span class="v num">${money(b.inStock)}</span><span class="k">Still in unsold stock</span></div>
      <div class="stat"><span class="v num gain">${money(b.share)}</span><span class="k">Profit share earned</span></div>
      <div class="stat"><span class="v num">${money(b.paid)}</span><span class="k">Paid out so far</span></div>
    </div>
  </section>
  <section class="panel"><h3>Return on each funded lot</h3>
    <div class="tablewrap"><table class="ledger-table"><thead><tr><th>Lot</th><th class="n">Cost</th><th class="n">Taken in</th><th class="n">Paid back</th><th class="n">Profit on sold units</th></tr></thead><tbody>
    ${b.bl.map(l=>{const s=lotStats(l);return `<tr><td><span class="pill">${lotNo(l.no)}</span>${esc(l.name)}</td><td class="n num">${money(s.landed)}</td><td class="n num">${money(s.recovered)}</td><td class="n num">${(s.paid*100).toFixed(0)}%</td><td class="n num ${s.net<0?'loss':'gain'}">${money(s.net)}</td></tr>`}).join('')}
    </tbody></table></div>
    <p class="note" style="margin-top:12px">Profit share is calculated on units actually sold, so it grows as stock moves. In the full version, ${esc(S.backerName)} gets a separate read-only login to this page.</p>
  </section>
  <section class="panel"><h3>Capital ledger</h3>
    <ul class="list">${ledger.map(c=>`<li><div><div class="name">${c.type==='invest'?'Investment':'Payout to '+esc(S.backerName)}</div><div class="meta">${shortDate(c.date)}${c.note?', '+esc(c.note):''}</div></div><div class="right num ${c.type==='invest'?'':'loss'}" style="font-size:20px">${c.type==='invest'?'+':'−'}${money(c.amount)}</div></li>`).join('')}</ul>
  </section>`;
}

/* ---------- sheets ---------- */
function openSheet(html,noFocus){$('#sheet').innerHTML=html;$('#scrim').hidden=false;$('#sheet').scrollTop=0;if(!noFocus){const f=$('#sheet').querySelector('input,select,button');f&&f.focus()}}
function closeSheet(){
  stopScan(); if(pendingQ.size)flushQ();
  buy=null; $('#scrim').hidden=true; $('#sheet').innerHTML=''; resetArmed=false;
  if(state&&!gate)render();
}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),2600)}

/* ---------- Sell ---------- */
const inStockItems=()=>state.items.filter(i=>i.onHand>0&&!i.tmp);
function lastPrice(i){
  const ss=state.sales.filter(s=>{const x=item(s.itemId);return x&&(x.id===i.id||(i.barcode&&x.barcode===i.barcode))}).sort((a,b)=>dt(b.date)-dt(a.date));
  return ss.length?ss[0].price:0;
}
const suggestPrice=i=>i.est>0?i.est:lastPrice(i);
function sellOptions(selId){
  return inStockItems().sort((a,b)=>nm(a).localeCompare(nm(b))).map(i=>`<option value="${i.id}" ${i.id===selId?'selected':''}>${esc(nm(i))} (${i.onHand} left)</option>`).join('');
}
function openSell(itemId){
  computeCosts();
  if(!inStockItems().length){toast('Nothing in stock yet. Tap Buy to add items.');return}
  const sel=itemId?item(itemId):null;
  sheetCh=CHANNELS[0];
  openSheet(`<h2>Record a sale</h2>
  ${scanBarHtml()}
  <label class="field"><span>Item</span><select id="s-item"><option value="">Scan an item, or pick one</option>${sellOptions(sel&&sel.id)}</select></label>
  <div class="grid2"><label class="field"><span>Quantity</span><input id="s-qty" type="number" min="1" step="1" value="1" inputmode="numeric"></label>
  <label class="field"><span>Price each</span><input id="s-price" type="number" min="0" step="0.01" value="${sel?(suggestPrice(sel)||''):''}" inputmode="decimal" placeholder="0.00"></label></div>
  <div class="field"><span>Sold through</span><div class="seg" id="s-ch">${CHANNELS.map((c,k)=>`<button type="button" data-ch="${esc(c)}" class="${k?'':'on'}">${esc(c)}</button>`).join('')}</div></div>
  <div class="grid2"><label class="field"><span>Shipping you paid</span><input id="s-ship" type="number" min="0" step="0.01" value="0" inputmode="decimal"></label>
  <label class="field"><span>Date</span><input id="s-date" type="date" value="${today()}"></label></div>
  <div class="preview" id="s-prev"></div><p class="err" id="s-err"></p>
  <div class="actions" style="flex-wrap:wrap"><button class="ghost" data-action="close">Close</button><button class="ghost" data-action="save-sale">Record sale</button><button class="primary" data-action="save-sale-next">Record, scan next</button></div>`,true);
  $('#s-item').addEventListener('change',e=>{const i=item(e.target.value);$('#s-price').value=i?(suggestPrice(i)||''):'';$('#s-qty').value=1;sellPreview()});
  ['#s-qty','#s-price','#s-ship'].forEach(s=>$(s).addEventListener('input',sellPreview));
  sellPreview();
  startScan(onSellScan);
  if(sel&&!$('#s-price').value)$('#s-price').focus();
}
function sellPreview(){
  const box=$('#s-prev'); if(!box)return;
  const i=item($('#s-item').value);
  if(!i){box.innerHTML='<div class="line"><span>Scan or pick an item to see what you keep.</span></div>';return}
  const q=+$('#s-qty').value||0, p=+$('#s-price').value||0, sh=+$('#s-ship').value||0;
  const fp=state.settings.fees[sheetCh]||0; const rev=q*p, fee=rev*fp/100, cost=uc(i)*q, net=rev-fee-sh-cost;
  box.innerHTML=`<div class="line"><span>Sale</span><span class="num">${money(rev,2)}</span></div>
  <div class="line"><span>${esc(sheetCh)} fee (${fp}%)</span><span class="num">−${money(fee,2)}</span></div>
  <div class="line"><span>Item cost (${money(uc(i),2)} each)</span><span class="num">−${money(cost,2)}</span></div>
  <div class="line"><span>Shipping</span><span class="num">−${money(sh,2)}</span></div>
  <div class="line total"><span>You keep</span><span class="num ${net<0?'loss':'gain'}">${money(net,2)}</span></div>`;
}
function onSellScan(code){
  const err=$('#s-err'); if(!err)return;
  const cands=state.items.filter(x=>x.barcode===code&&x.onHand>0&&!x.tmp).sort((a,b)=>dt(lot(a.lotId).date)-dt(lot(b.lotId).date)||lot(a.lotId).no-lot(b.lotId).no);
  if(!cands.length){
    const known=state.items.find(x=>x.barcode===code);
    beep(false); err.textContent=known?`${nm(known)} is sold out.`:`Barcode ${code} isn't in your stock yet. Scan it in with Buy first.`;
    return;
  }
  const i=cands[0], s=$('#s-item');
  if(s.value===i.id){const q=$('#s-qty');q.value=(+q.value||0)+1}
  else{s.value=i.id;$('#s-price').value=suggestPrice(i)||'';$('#s-qty').value=1}
  err.textContent=''; sellPreview(); toast(`${nm(i)}: ${i.onHand} in stock`);
  if(!$('#s-price').value)$('#s-price').focus();
}
function saveSale(btn,next){
  const err=$('#s-err'); const i=item($('#s-item').value);
  if(!i)return err.textContent='Scan or pick the item that sold.';
  const q=+$('#s-qty').value, p=+$('#s-price').value, sh=+$('#s-ship').value||0, d=$('#s-date').value||today();
  if(!Number.isInteger(q)||q<1)return err.textContent='Enter a whole number of 1 or more.';
  if(q>i.onHand)return err.textContent=`Only ${i.onHand} left of this item.`;
  if(!(p>0))return err.textContent='Enter the price each one sold for.';
  return busy(btn,async()=>{
    const {data,error}=await sb.rpc('record_sale',{p_item:i.id,p_qty:q,p_price:p,p_channel:sheetCh,p_ship:sh,p_date:d,p_fee_pct:state.settings.fees[sheetCh]||0});
    if(error){err.textContent=friendly(error);if(/stock/i.test(error.message))refresh(true);return}
    const s=fromSale(data); state.sales.push(s); i.onHand-=q; computeCosts();
    const n=saleCalc(s).net;
    toast(`Sale recorded: ${n>=0?'+':''}${money(n,2)} profit`);
    if(!next){closeSheet();return}
    if(!inStockItems().length){closeSheet();toast('Sale recorded. That was the last item in stock.');return}
    $('#s-item').innerHTML=`<option value="">Scan the next item</option>${sellOptions()}`;
    $('#s-qty').value=1; $('#s-price').value=''; $('#s-ship').value=0; err.textContent='';
    sellPreview(); focusScan(true);
  });
}
async function undoSale(id,btn){
  if(btn.dataset.armed!=='1'){btn.dataset.armed='1';btn.textContent='Tap to confirm';return}
  await busy(btn,async()=>{
    const {error}=await sb.rpc('delete_sale',{p_sale:id});
    if(error)return toast(friendly(error));
    const s=state.sales.find(x=>x.id===id); state.sales=state.sales.filter(x=>x.id!==id);
    const it=s&&item(s.itemId); if(it)it.onHand+=s.qty;
    const itemId=s&&s.itemId; render(); if(itemId)openItem(itemId); toast('Sale removed and stock put back');
  });
}
async function deleteLot(id,btn){
  if(btn.dataset.armed!=='1'){btn.dataset.armed='1';btn.textContent='Tap again to delete it and its sales';return}
  await busy(btn,async()=>{
    const l=lot(id);
    const {error}=await sb.from('lots').delete().eq('id',id);
    if(error)return toast(friendly(error));
    if(l&&l.photos.length)sb.storage.from('lot-photos').remove(l.photos).then(()=>{},()=>{});
    [...pendingQ.keys()].filter(k=>k.startsWith(id+'|')).forEach(k=>pendingQ.delete(k)); saveQ();
    const ids=new Set(state.items.filter(i=>i.lotId===id).map(i=>i.id));
    state.lots=state.lots.filter(l=>l.id!==id); state.items=state.items.filter(i=>!ids.has(i.id)); state.sales=state.sales.filter(s=>!ids.has(s.itemId));
    closeSheet(); toast('Deleted');
  });
}

function openLot(id){
  computeCosts(); const l=lot(id); if(!l)return; const s=lotStats(l), single=l.kind==='single';
  const avg=s.units?s.landed/s.units:0;
  const desc=single?`${esc(l.supplier)}, ${shortDate(l.date)}. ${money(l.cost,2)} for ${s.units} unit${s.units===1?'':'s'}.`
    :`${esc(l.supplier)}, ${shortDate(l.date)}. Paid ${money(l.cost)} plus ${money(l.shipIn)} shipping.${l.costMode==='even'?(s.units?` ${s.units} units applied, so each one costs ${money(avg,2)} on average.`:' No items applied yet.'):''}`;
  const canApply=single||l.costMode==='even';
  openSheet(`<div class="tag-head" style="border-radius:10px;margin-bottom:14px"><span class="hole"></span><span class="tag-no">${lotLabel(l)}</span><span class="tag-fund">${l.closed?'Done · ':''}${s.age} days open</span></div>
  <h2 style="margin-bottom:4px">${esc(l.name)}</h2><p class="sub">${desc}</p>
  <div class="photos" id="lot-photos">${l.photos.map(p=>`<a class="ph" data-photo="${esc(p)}" target="_blank" rel="noopener" aria-label="Lot photo">…</a>`).join('')}${migrated!==false?`<label class="ph addphoto" data-write>+ Photo<input type="file" accept="image/*" multiple id="lot-file" data-lot="${l.id}" aria-label="Add a photo"></label>`:''}</div>
  ${s.its.length?`<div class="tablewrap"><table class="ledger-table"><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Sold</th><th class="n">Left</th><th class="n">Cost each</th></tr></thead><tbody>
  ${s.its.slice().sort((a,b)=>b.qty-a.qty).map(i=>`<tr><td><button class="cellink" data-action="item" data-item="${i.id}">${esc(nm(i))}</button></td><td class="n num">${i.qty}</td><td class="n num">${i.qty-i.onHand}</td><td class="n num">${i.onHand}</td><td class="n num">${money(uc(i),2)}</td></tr>`).join('')}
  </tbody></table></div>`:`<p class="empty">${canApply?`Nothing applied yet. Tap ${single?'Add items':'Apply items'} and start scanning.`:'No items.'}</p>`}
  <div class="preview" style="margin-top:14px">
    <div class="line"><span>Taken in after fees and shipping</span><span class="num">${money(s.recovered,2)}</span></div>
    <div class="line"><span>Profit on units sold</span><span class="num ${s.net<0?'loss':'gain'}">${money(s.net,2)}</span></div>
    ${s.estLeft>0?`<div class="line"><span>Remaining stock at your sell prices</span><span class="num">${money(s.estLeft,2)}</span></div>`:''}
    <div class="line total"><span>${s.profit<0?'Still to earn back':'Profit so far'}</span><span class="num ${s.profit<0?'loss':'gain'}">${money(Math.abs(s.profit))}</span></div>
  </div>
  <div class="actions" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><button class="danger" data-write data-action="del-lot" data-lot="${l.id}">Delete</button>
  <span style="display:flex;gap:8px;flex-wrap:wrap">${!single&&canApply?`<button class="ghost" data-write data-action="lot-toggle" data-lot="${l.id}">${l.closed?'Reopen':'Mark done'}</button>`:''}
  ${canApply?`<button class="primary" data-write data-action="lot-apply" data-lot="${l.id}">${single?'Add items':'Apply items'}</button>`:''}<button class="${canApply?'ghost':'primary'}" data-action="close">Close</button></span></div>`);
  loadPhotoThumbs(l);
}
async function loadPhotoThumbs(l){
  if(!l.photos.length)return;
  const {data,error}=await sb.storage.from('lot-photos').createSignedUrls(l.photos,3600);
  if(error||!data)return;
  data.forEach(d=>{
    if(!d.signedUrl)return;
    const a=document.querySelector(`#lot-photos [data-photo="${CSS.escape(d.path)}"]`); if(!a)return;
    a.href=d.signedUrl; a.innerHTML=`<img src="${esc(d.signedUrl)}" alt="Lot photo">`;
  });
}
async function toggleLot(id,btn){
  const l=lot(id); if(!l)return;
  await busy(btn,async()=>{
    const {error}=await sb.from('lots').update({closed:!l.closed}).eq('id',id);
    if(error)return toast(friendly(error));
    l.closed=!l.closed; openLot(id); render(); toast(l.closed?'Marked done. It no longer shows in the Buy lot list.':'Reopened');
  });
}

function openItem(id){
  computeCosts(); const i=item(id); if(!i)return; const l=lot(i.lotId); const cost=uc(i);
  const ss=state.sales.filter(s=>s.itemId===id).sort((a,b)=>dt(b.date)-dt(a.date));
  const units=ss.reduce((a,s)=>a+s.qty,0);
  let rev=0,net=0; ss.forEach(s=>{const c=saleCalc(s);rev+=c.rev;net+=c.net});
  const avg=units?rev/units:0, perUnit=units?net/units:0;
  const prices=ss.map(s=>s.price); const lo=prices.length?Math.min(...prices):0, hi=prices.length?Math.max(...prices):0;
  const now=Date.now(); const within=(a,b)=>ss.filter(s=>{const d=now-dt(s.date);return d>=a*DAY&&d<b*DAY}).reduce((x,s)=>x+s.qty,0);
  const u14=within(0,14), p14=within(14,28);
  const avgDays=units?ss.reduce((a,s)=>a+Math.max(0,(dt(s.date)-dt(l.date))/DAY)*s.qty,0)/units:0;
  let trend;
  if(!units) trend='No sales yet.';
  else{
    trend=u14>p14?`Picking up: ${u14} sold in the last 2 weeks, up from ${p14} the 2 weeks before.`
      :u14<p14?`Slowing down: ${u14} sold in the last 2 weeks, down from ${p14} the 2 weeks before.`
      :`Steady: ${u14} sold in each of the last two 2-week stretches.`;
    if(i.onHand>0&&u14>0) trend+=` At this pace the remaining ${i.onHand} sell out in about ${Math.max(1,Math.round(i.onHand/(u14/14)))} days.`;
    else if(i.onHand>0) trend+=` Nothing sold in 2 weeks, so the remaining ${i.onHand} may need a lower price or a push in a live.`;
    else trend+=' Sold out.';
  }
  const ch=new Map(); ss.forEach(s=>{const c=saleCalc(s);const a=ch.get(s.channel)||{u:0,r:0,n:0};a.u+=s.qty;a.r+=c.rev;a.n+=c.net;ch.set(s.channel,a)});
  openSheet(`<div class="tag-head" style="border-radius:10px;margin-bottom:14px"><span class="hole"></span><span class="tag-no">${lotLabel(l)}</span><span class="tag-fund">${i.onHand} of ${i.qty} left</span></div>
  <h2 style="margin-bottom:4px">${esc(nm(i))}</h2>
  <p class="sub" style="margin-bottom:8px">From ${esc(l.name)}. Costs ${money(cost,2)} each${l.costMode==='even'?' (lot average)':''}${i.est>0?`, sell for ${money(i.est,2)}`:''}.${i.barcode?` ${esc(codeText(i.barcode))}.`:''} <button class="linkbtn" data-write data-action="item-edit" data-item="${i.id}" style="padding:0">${i.name?'Edit':'Name it'}</button>${i.name&&!isBulk(i.barcode)?` · <a class="linkbtn" href="${esc(ebaySold(i.name))}" target="_blank" rel="noopener noreferrer" style="padding:0">eBay sold prices ↗</a>`:''}</p>
  <p class="trend">${trend}</p>
  <div class="stats" style="margin-top:0">
    <div class="stat"><span class="v num">${units}</span><span class="k">Units sold</span></div>
    <div class="stat"><span class="v num">${money(avg,2)}</span><span class="k">Average sale price</span></div>
    <div class="stat"><span class="v num ${perUnit<0?'loss':'gain'}">${money(perUnit,2)}</span><span class="k">Average profit each</span></div>
    <div class="stat"><span class="v num">${units?Math.round(avgDays):'–'}</span><span class="k">Avg days to sell</span></div>
  </div>
  ${units?`<div class="preview" style="margin-top:12px">
    <div class="line"><span>Price range</span><span class="num">${money(lo,2)} to ${money(hi,2)}</span></div>
    <div class="line"><span>Total sales</span><span class="num">${money(rev,2)}</span></div>
    <div class="line total"><span>Total profit</span><span class="num ${net<0?'loss':'gain'}">${money(net,2)}</span></div>
  </div>
  <h3 style="margin-top:16px">Sale prices over time</h3>
  <div class="ichart">${itemChart(ss,l,cost,i.est,avg)}</div>
  <div class="legend"><span><b></b>A sale</span><span style="color:var(--ink)"><i></i>Average price</span><span style="color:var(--loss)"><i></i>Your cost</span></div>
  <h3>By channel</h3>
  <div class="tablewrap"><table class="ledger-table"><thead><tr><th>Channel</th><th class="n">Sold</th><th class="n">Avg price</th><th class="n">Profit</th></tr></thead><tbody>
  ${[...ch.entries()].sort((a,b)=>b[1].u-a[1].u).map(([c,a])=>`<tr><td>${esc(c)}</td><td class="n num">${a.u}</td><td class="n num">${money(a.r/a.u,2)}</td><td class="n num ${a.n<0?'loss':'gain'}">${money(a.n,2)}</td></tr>`).join('')}
  </tbody></table></div>
  <h3 style="margin-top:16px">Every sale</h3>
  <div class="tablewrap"><table class="ledger-table"><thead><tr><th>Date</th><th class="n">Qty</th><th class="n">Price each</th><th>Channel</th><th class="n">Profit</th><th data-write></th></tr></thead><tbody>
  ${ss.map(s=>{const c=saleCalc(s);return `<tr><td>${shortDate(s.date)}</td><td class="n num">${s.qty}</td><td class="n num">${money(s.price,2)}</td><td>${esc(s.channel)}</td><td class="n num ${c.net<0?'loss':'gain'}">${money(c.net,2)}</td><td data-write><button class="linkbtn" style="padding:0;font-size:13px" data-action="undo-sale" data-sale="${s.id}">Undo</button></td></tr>`}).join('')}
  </tbody></table></div>`:''}
  <div class="actions" style="margin-top:16px"><button class="ghost" data-action="close">Close</button>${i.onHand?`<button class="primary" data-write data-action="sell" data-item="${i.id}">Sell this item</button>`:''}</div>`);
}
function itemChart(ss,l,cost,est,avg){
  const w=520,h=190,pl=44,pr=12,pt=12,pb=26;
  const t0=dt(l.date), t1=Math.max(Date.now(),t0+DAY);
  const ys=ss.map(s=>s.price).concat([cost,est,avg]); const ymax=Math.max(...ys)*1.1, ymin=Math.min(0,Math.min(...ys));
  const X=t=>pl+(t-t0)/(t1-t0)*(w-pl-pr), Y=v=>pt+(1-(v-ymin)/(ymax-ymin))*(h-pt-pb);
  let o=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Sale prices over time compared with cost">`;
  [0,.5,1].forEach(f=>{const v=ymin+(ymax-ymin)*f;o+=`<line x1="${pl}" x2="${w-pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${pl-6}" y="${Y(v)+4}" text-anchor="end">${money(v)}</text>`});
  o+=`<line x1="${pl}" x2="${w-pr}" y1="${Y(cost)}" y2="${Y(cost)}" stroke="var(--loss)" stroke-width="2" stroke-dasharray="5 4"/>`;
  o+=`<line x1="${pl}" x2="${w-pr}" y1="${Y(avg)}" y2="${Y(avg)}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="5 4" opacity=".6"/>`;
  ss.forEach(s=>{o+=`<circle cx="${X(dt(s.date))}" cy="${Y(s.price)}" r="${s.qty>1?6:4.5}" fill="var(--ink)" fill-opacity=".8"/>`});
  o+=`<text x="${pl}" y="${h-6}">Bought ${shortDate(l.date)}</text><text x="${w-pr}" y="${h-6}" text-anchor="end">Today</text>`;
  return o+'</svg>';
}
/* ---------- scanning: a Bluetooth/USB scanner, the camera, or typing ---------- */
const MODE_KEY='lotledger-scan-mode', BUYKIND_KEY='lotledger-buy-kind', FUND_KEY='lotledger-fund', VENDOR_KEY='lotledger-last-vendor';
const MODES=[['scanner','Scanner'],['camera','Camera'],['type','Type it'],['cards','Cards']];
let scanMode=lsGet(MODE_KEY)||'scanner', scanCb=null, scanPaused=false, scanPauseMsg='', cam=null, lastCam={code:'',at:0}, actx=null;

function scanBarHtml(){
  return `<div class="modebar"><span class="muted" style="font-size:13px">Scan with</span><div class="seg" role="group" aria-label="Scan with">${MODES.map(([m,t])=>`<button type="button" data-mode="${m}" class="${m===scanMode?'on':''}">${t}</button>`).join('')}</div></div><div class="scanzone live" id="scanzone"></div>`;
}
const readyLabel=()=>scanMode==='camera'?'Point the camera at a barcode':scanMode==='type'?'Type the barcode number, then Add':scanMode==='cards'?'Find a card, or tap a bulk button':'Ready. Scan an item';
function renderScanZone(){
  const z=$('#scanzone'); if(!z)return;
  const head=`<div class="ready"><span class="dot"></span><span id="scanlabel">${esc(scanPaused?scanPauseMsg:readyLabel())}</span></div>`;
  if(scanMode==='scanner')z.innerHTML=head+`<input id="scanbox" class="scaninput" inputmode="none" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Scans land here" aria-label="Barcode scanner input"><p class="scan-msg">For a Bluetooth or USB scanner. The camera stays off.</p>`;
  else if(scanMode==='type')z.innerHTML=head+`<div class="with-btn" style="margin-top:10px"><input id="typebox" class="scaninput" style="margin-top:0" inputmode="numeric" autocomplete="off" placeholder="Number under the barcode" aria-label="Barcode number"><button class="primary" type="button" data-action="type-go">Add</button></div>`;
  else if(scanMode==='cards'){
    z.innerHTML=head+`<div class="with-btn" style="margin-top:10px"><input id="cardbox" class="scaninput" style="margin-top:0;letter-spacing:0" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="Name and number, e.g. Charizard 4/102" aria-label="Card name and number" value="${esc(cardQ)}"><button class="primary" type="button" data-action="card-go">Find</button></div>
    <div id="cardres"></div>
    <div class="bulkbar">${BULK.map(([k,t])=>`<button type="button" class="btn-sm" data-action="bulk-add" data-b="${k}">+1 ${esc(t)}</button>`).join('')}</div>
    <p class="scan-msg">Pokémon cards. Bulk buttons count one card at your set value. <button type="button" class="linkbtn" data-action="bulk-rates" style="padding:0;font-size:13px">Set bulk values</button></p><div id="bulkrates"></div>`;
    $('#cardbox').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();runCardSearch()}});
  }
  else z.innerHTML=head+`<div id="camview" class="camview"></div><p class="scan-msg" id="cammsg">Starting the camera…</p>`;
  z.classList.toggle('paused',scanPaused); z.classList.toggle('live',!scanPaused);
}
function startScan(cb){
  scanCb=cb; scanPaused=false; renderScanZone();
  if(scanMode==='camera')startCam(); else focusScan(false);
}
function stopScan(){scanCb=null;stopCam()}
function setScanMode(m){
  if(!MODES.some(x=>x[0]===m))return;
  scanMode=m; lsSet(MODE_KEY,m);
  document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('on',b.dataset.mode===m));
  stopCam(); renderScanZone();
  if(m==='camera')startCam(); else focusScan(true);
}
function setPaused(on,msg){
  scanPaused=on; scanPauseMsg=msg||'';
  const z=$('#scanzone'); if(z){z.classList.toggle('paused',on);z.classList.toggle('live',!on)}
  const lb=$('#scanlabel'); if(lb)lb.textContent=on?scanPauseMsg:readyLabel();
  if(cam){try{on?cam.pause(true):cam.resume()}catch(e){}}
}
function focusScan(force){
  if(scanMode==='camera')return;
  const b=$('#scanbox')||$('#typebox')||$('#cardbox'); if(!b)return;
  const a=document.activeElement;
  if(!force&&a&&a!==b&&$('#sheet').contains(a)&&/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName))return;
  try{b.focus({preventScroll:true})}catch(e){}
}
async function startCam(){
  const v=$('#camview'), msg=$('#cammsg'); if(!v)return;
  const fail=t=>{if(msg)msg.textContent=t;v.style.display='none'};
  if(typeof Html5Qrcode==='undefined'||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)
    return fail("The camera isn't available here. Switch to Scanner or Type it.");
  await stopCam();
  try{
    const F=Html5QrcodeSupportedFormats;
    const c=new Html5Qrcode('camview',{verbose:false,formatsToSupport:[F.UPC_A,F.UPC_E,F.EAN_13,F.EAN_8,F.CODE_128,F.CODE_39,F.QR_CODE],experimentalFeatures:{useBarCodeDetectorIfSupported:true}});
    cam=c;
    await c.start({facingMode:'environment'},{fps:12,qrbox:(w,h)=>({width:Math.max(60,Math.min(320,Math.floor(w*.9))),height:Math.max(60,Math.min(130,Math.floor(h*.55)))})},
      code=>{const now=Date.now();if(code===lastCam.code&&now-lastCam.at<2000)return;lastCam={code,at:now};handleScan(code)},()=>{});
    if(cam!==c){try{await c.stop()}catch(e){}return}
    if(msg)msg.textContent='Hold steady. It scans on its own. The same barcode counts again after 2 seconds.';
    if(scanPaused){try{c.pause(true)}catch(e){}}
  }catch(e){cam=null;fail("Couldn't open the camera. Allow camera access for this site, or switch to Scanner or Type it.")}
}
async function stopCam(){if(cam){const c=cam;cam=null;try{await c.stop()}catch(e){}try{c.clear()}catch(e){}}}
function beep(ok){
  try{navigator.vibrate&&navigator.vibrate(ok?35:[80,60,80])}catch(e){}
  try{
    actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    if(actx.state==='suspended')actx.resume();
    const o=actx.createOscillator(),g=actx.createGain();
    o.type=ok?'sine':'square'; o.frequency.value=ok?1760:220; g.gain.value=.05;
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime+(ok?.07:.22));
  }catch(e){}
}
function handleScan(raw){
  const code=String(raw||'').trim().replace(/\s+/g,'');
  if(!code||!scanCb)return;
  if(code.length<4){beep(false);toast("That doesn't look like a barcode.");return}
  beep(true); scanCb(code);
}
/* A keyboard-style scanner "types" the barcode very fast and presses Enter. Catch that
   burst wherever the focus is, so a scan never ends up inside the cost or price box. */
let kb={buf:'',start:0,last:0,el:null,val:''};
document.addEventListener('keydown',e=>{
  if(!scanCb||$('#scrim').hidden)return;
  const now=performance.now(), t=e.target, isBox=t&&(t.id==='scanbox'||t.id==='typebox');
  if(e.key==='Enter'||e.key==='Tab'){
    const fast=kb.buf.length>=6&&now-kb.last<150&&(kb.last-kb.start)/Math.max(1,kb.buf.length-1)<45;
    if(isBox&&e.key==='Enter'){e.preventDefault();e.stopPropagation();const v=t.value;t.value='';kb.buf='';handleScan(v);return}
    if(fast){
      e.preventDefault(); e.stopPropagation();
      if(kb.el&&kb.el!==t)kb.el=t;
      if(!isBox&&kb.el&&'value' in kb.el){try{kb.el.value=kb.val;kb.el.dispatchEvent(new Event('input',{bubbles:true}))}catch(_){}}
      if(isBox)t.value='';
      const code=kb.buf; kb.buf=''; handleScan(code); return;
    }
    kb.buf=''; return;
  }
  if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
    if(now-kb.last>80){kb.buf='';kb.start=now;kb.el=t;kb.val=(t&&'value' in t)?t.value:''}
    kb.buf+=e.key; kb.last=now;
  }
},true);

/* ---------- product names: your own catalog first, then the barcode lookup ---------- */
function knownProduct(code){
  const p=state.products.get(code);
  if(p&&p.name)return {name:p.name,est:+p.est||0,brand:p.brand||null,image_url:p.image_url||null};
  const i=state.items.slice().reverse().find(x=>x.barcode===code&&x.name);
  return i?{name:i.name,est:i.est,brand:null,image_url:p&&p.image_url||null}:null;
}
function rememberProduct(code,o){
  const p=Object.assign({barcode:code},state.products.get(code)||{});
  Object.keys(o).forEach(k=>{if(o[k]!=null&&o[k]!=='')p[k]=o[k]});
  state.products.set(code,p);
}
const titleOf=r=>[r.brand&&!(r.title||'').toLowerCase().includes(r.brand.toLowerCase())?r.brand:'',r.title].filter(Boolean).join(' ').slice(0,120);
function priorCost(code){
  const its=state.items.filter(i=>i.barcode===code&&i.unitCost!=null&&!i.tmp);
  if(!its.length)return null;
  const units=its.reduce((a,i)=>a+i.qty,0);
  const last=its.slice().sort((a,b)=>dt(lot(b.lotId).date)-dt(lot(a.lotId).date))[0].unitCost;
  return {avg:units?its.reduce((a,i)=>a+i.unitCost*i.qty,0)/units:0,last};
}
const nameFix=new Map();
async function applyName(lotId,code,info,force){
  const name=(info.name||'').trim(); if(!name)return;
  const e=pendingQ.get(lotId+'|'+code);
  if(e&&(force||!e.name)){e.name=name;e.brand=e.brand||info.brand||null;e.image_url=e.image_url||info.image_url||null;saveQ()}
  state.items.filter(i=>i.lotId===lotId&&i.barcode===code&&(force||!i.name)).forEach(i=>i.name=name);
  rememberProduct(code,{name,brand:info.brand,image_url:info.image_url});
  let q=sb.from('items').update({name}).eq('lot_id',lotId).eq('barcode',code);
  if(!force)q=q.eq('name','');
  const r=await q;
  const prod={business_id:biz.id,barcode:code,name}; if(info.brand)prod.brand=info.brand; if(info.image_url)prod.image_url=info.image_url;
  await sb.from('products').upsert(prod,{onConflict:'business_id,barcode'});
  if(r.error)toast(friendly(r.error));
}

/* ---------- lot scans: saved in small batches so scanning never waits on the network ---------- */
let pendingQ=new Map(), inflight=[], qBusy=false, qTimer=null, qErr='';
const qKey=()=>'lotledger-queue-'+(biz&&biz.id);
function saveQ(){if(biz)lsSet(qKey(),(pendingQ.size||inflight.length)?JSON.stringify(inflight.concat([...pendingQ.values()])):null)}
function localApply(lotId,code,n,name){
  let it=state.items.find(i=>i.lotId===lotId&&i.barcode===code&&i.unitCost==null);
  if(!it){if(n<=0)return;it={id:'tmp-'+lotId+'-'+code,lotId,name:name||'',qty:0,est:0,onHand:0,barcode:code,tmp:true};state.items.push(it)}
  it.qty+=n; it.onHand+=n; if(name&&!it.name)it.name=name;
  if(it.tmp&&it.qty<=0)state.items.splice(state.items.indexOf(it),1);
}
function enqueue(lotId,code,n,meta){
  const key=lotId+'|'+code;
  const e=pendingQ.get(key)||{lotId,barcode:code,qty:0,name:'',brand:null,image_url:null};
  e.qty+=n; if(meta&&meta.name&&!e.name)e.name=meta.name;
  if(meta){e.brand=e.brand||meta.brand||null;e.image_url=e.image_url||meta.image_url||null}
  if(e.qty<=0)pendingQ.delete(key); else pendingQ.set(key,e);
  localApply(lotId,code,n,e.name);
  saveQ(); scheduleFlush(700); renderQ();
}
function scheduleFlush(ms){clearTimeout(qTimer);qTimer=setTimeout(flushQ,ms)}
async function flushQ(){
  if(qBusy||!pendingQ.size||!sb||!biz)return;
  qBusy=true; clearTimeout(qTimer);
  inflight=[...pendingQ.values()]; pendingQ.clear(); saveQ(); renderQ();
  const failed=[];
  for(const lotId of [...new Set(inflight.map(b=>b.lotId))]){
    const part=inflight.filter(b=>b.lotId===lotId);
    let res;
    try{res=await sb.rpc('apply_to_lot',{p_lot:lotId,p_items:part.map(b=>({barcode:b.barcode,qty:b.qty,name:b.name||'',brand:b.brand,image_url:b.image_url}))})}
    catch(e){res={error:e}}
    if(res.error){
      if(/Lot not found/i.test(res.error.message||'')){part.forEach(b=>localApply(b.lotId,b.barcode,-b.qty,''));qErr='That lot was deleted, so those scans were dropped.';continue}
      failed.push(...part); qErr=friendly(res.error); continue;
    }
    (res.data||[]).forEach(r=>{
      const fresh=fromItem(r), key=lotId+'|'+fresh.barcode, extra=(pendingQ.get(key)||{qty:0}).qty;
      const ti=state.items.findIndex(i=>i.id==='tmp-'+lotId+'-'+fresh.barcode); if(ti>=0)state.items.splice(ti,1);
      fresh.qty+=extra; fresh.onHand+=extra;
      const ex=state.items.find(i=>i.id===fresh.id); if(ex)Object.assign(ex,fresh); else state.items.push(fresh);
      if(!fresh.name&&nameFix.has(fresh.barcode))applyName(lotId,fresh.barcode,nameFix.get(fresh.barcode));
    });
  }
  failed.forEach(f=>{const key=f.lotId+'|'+f.barcode,e=pendingQ.get(key);if(e){e.qty+=f.qty;e.name=e.name||f.name}else pendingQ.set(key,f)});
  if(!failed.length)qErr='';
  inflight=[]; saveQ(); qBusy=false;
  if(buy&&buy.kind==='lot'&&buy.lotId)renderApply(); else renderQ();
  if(pendingQ.size)scheduleFlush(failed.length?5000:250);
}
function restoreQ(){
  let saved=[]; try{saved=JSON.parse(lsGet(qKey())||'[]')}catch(e){}
  saved.forEach(e=>{if(!lot(e.lotId)||!(e.qty>0))return;const key=e.lotId+'|'+e.barcode,x=pendingQ.get(key);if(x)x.qty+=e.qty;else pendingQ.set(key,e);localApply(e.lotId,e.barcode,e.qty,e.name)});
  saveQ(); if(pendingQ.size){toast(`Saving ${[...pendingQ.values()].reduce((a,e)=>a+e.qty,0)} scans from last time…`);scheduleFlush(300)}
}
function renderQ(){
  const el=$('#b-q'); if(!el)return;
  const n=[...pendingQ.values()].reduce((a,e)=>a+e.qty,0)+inflight.reduce((a,e)=>a+e.qty,0);
  el.className=qErr&&n?'unsaved':'meta';
  el.textContent=n?(qErr?`${n} scan${n>1?'s':''} not saved yet. Retrying. (${qErr})`:`Saving ${n} scan${n>1?'s':''}…`):'All scans saved';
}
window.addEventListener('beforeunload',e=>{if(pendingQ.size||inflight.length){flushQ();e.preventDefault();e.returnValue=''}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flushQ()});

/* ---------- Buy: single items (each with its own cost) or a lot (one price, averaged) ---------- */
let buy=null;
const showFund=()=>!biz||biz.show_backer!==false;
const openLots=()=>state.lots.filter(l=>l.kind!=='single'&&l.costMode==='even'&&!l.closed).sort((a,b)=>dt(b.date)-dt(a.date)||b.no-a.no);
const vendorList=()=>`<datalist id="vendor-list">${(state.vendors||[]).map(v=>`<option value="${esc(v.name)}">`).join('')}</datalist>`;
function fundSeg(id){
  const f=lsGet(FUND_KEY)||'backer';
  return `<div class="seg" id="${id}"><button type="button" data-fund="backer" class="${f==='backer'?'on':''}">${esc(state.settings.backerName)}</button><button type="button" data-fund="seller" class="${f==='seller'?'on':''}">${esc(state.settings.sellerName)}</button></div>`;
}
function readFund(id){
  if(!showFund())return 'seller';
  const el=document.querySelector(`#${id} .on`); const v=el?el.dataset.fund:'backer'; lsSet(FUND_KEY,v); return v;
}
async function ensureVendor(name){
  name=(name||'').trim(); if(!name)return null;
  lsSet(VENDOR_KEY,name);
  const v=(state.vendors||[]).find(x=>x.name.toLowerCase()===name.toLowerCase()); if(v)return v;
  const {data,error}=await sb.from('vendors').insert({business_id:biz.id,name}).select().single();
  if(error)return {id:null,name};
  (state.vendors=state.vendors||[]).push(data); return data;
}
function upsertItem(x){const ex=state.items.find(i=>i.id===x.id);if(ex)Object.assign(ex,x);else state.items.push(x)}

function openBuy(opts={}){
  if(!state)return;
  const kind=opts.kind||lsGet(BUYKIND_KEY)||'single';
  buy={kind,lotId:opts.lotId||null,tripId:opts.tripId||null,newLot:!!opts.newLot,pend:null,last:null,manual:false,renaming:false,photos:[]};
  if(kind==='lot'&&!buy.lotId&&!buy.newLot){const o=openLots();if(o.length)buy.lotId=o[0].id;else buy.newLot=true}
  renderBuy();
}
function buyHead(){
  const warn=migrated===false?`<p class="err" style="margin-bottom:12px">One database update (migration 004) still needs to run in Supabase before Buy can save. See the setup notes.</p>`:'';
  return `<h2>Buy</h2>${warn}<div class="seg big" role="group" aria-label="What are you buying?"><button type="button" data-kind="single" class="${buy.kind==='single'?'on':''}">Single items</button><button type="button" data-kind="lot" class="${buy.kind==='lot'?'on':''}">Lot or pallet</button></div>`;
}
function renderBuy(){
  stopScan(); setPaused(false);
  if(buy.kind==='single'){
    openSheet(buyHead()+singleHtml(),true);
    startScan(onSingleScan); renderPend(); renderTrip();
  }else if(buy.newLot||!buy.lotId){
    openSheet(buyHead()+newLotHtml(),true);
    const c=$('#n-cost'); c&&c.focus();
  }else{
    openSheet(buyHead()+applyHtml(),true);
    startScan(onLotScan); renderApply();
  }
}
function switchBuyKind(k){
  if(!buy||buy.kind===k)return;
  if(buy.pend){keepPend();if(buy.pend.cost!==''){toast('Save or skip the item you scanned first.');return}}
  lsSet(BUYKIND_KEY,k);
  openBuy({kind:k});
}

/* single items */
function singleHtml(){
  const t=buy.tripId&&lot(buy.tripId);
  const vend=t?(t.supplier==='Unknown supplier'?'':t.supplier):(lsGet(VENDOR_KEY)||'');
  return `<div class="grid2"><label class="field"><span>Where from</span><input id="b-vendor" list="vendor-list" value="${esc(vend)}" placeholder="Store or vendor" autocomplete="off" ${t?'disabled':''}></label>
  <label class="field"><span>Date</span><input id="b-date" type="date" value="${t?t.date:today()}" ${t?'disabled':''}></label></div>${vendorList()}
  ${showFund()&&!t?`<div class="field"><span>Paid for by</span>${fundSeg('b-fund')}</div>`:''}
  ${t?`<p class="note" style="margin:-4px 0 12px">Adding to ${lotLabel(t)}. <button class="linkbtn" data-action="buy-newtrip" style="padding:0">Start a new trip</button></p>`:''}
  ${scanBarHtml()}
  <div id="b-pend"></div>
  <button class="linkbtn" data-action="buy-nobarcode">Add an item with no barcode</button>
  <div id="b-trip"></div>
  <div class="actions" style="margin-top:10px"><button class="primary" data-action="buy-done">Done</button></div>`;
}
function keepPend(){
  const p=buy&&buy.pend; if(!p||!$('#p-cost'))return;
  p.name=$('#p-name').value; p.cost=$('#p-cost').value; p.qty=$('#p-qty').value; p.est=$('#p-est').value;
}
function renderPend(){
  const box=$('#b-pend'); if(!box)return; const p=buy.pend;
  if(!p){box.innerHTML='';setPaused(false);return}
  const L=p.look&&typeof p.look==='object'?p.look:null, img=p.image||(L&&L.image_url), retail=L&&L.found&&L.msrp;
  const ebayQ=isBulk(p.code)?'':(L&&L.ebay)||(p.name||'').trim(), market=L&&L.source==='tcgdex';
  const prior=p.code?priorCost(p.code):null, active=document.activeElement&&document.activeElement.id;
  box.innerHTML=`<div class="costcard">
    <div style="display:flex;gap:12px;align-items:flex-start;margin-bottom:6px">${img?`<img src="${esc(img)}" alt="" referrerpolicy="no-referrer" data-imgfallback style="width:56px;height:56px;object-fit:contain;border-radius:6px;background:#fff;flex:none">`:''}
    <label class="field" style="flex:1;min-width:0;margin-bottom:4px"><span>Item</span><input id="p-name" value="${esc(p.name)}" placeholder="${p.look==='loading'?'Looking up the name…':'Name (or add it later)'}" autocomplete="off"></label></div>
    <div class="meta" style="margin-bottom:10px">${p.code?esc(codeText(p.code)):'No barcode'}${prior?` · you've paid ${money(prior.avg,2)} on average, last ${money(prior.last,2)}`:''}</div>
    <div class="grid2"><label class="field"><span>Cost each</span><input id="p-cost" class="costinput" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(p.cost)}" placeholder="${prior?prior.last.toFixed(2):'0.00'}"></label>
    <label class="field"><span>Quantity</span><input id="p-qty" type="number" min="1" step="1" inputmode="numeric" value="${esc(p.qty)}" style="font-size:22px;min-height:56px"></label></div>
    <label class="field"><span>Sell for (optional)</span><input id="p-est" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(p.est)}" placeholder="Set it now or later"></label>
    ${retail||ebayQ?`<p style="margin:-4px 0 12px;display:flex;gap:8px;flex-wrap:wrap">${retail?`<button type="button" class="hintbtn" data-action="use-retail" data-v="${retail}">${market?'Market (TCGplayer)':'Retail'} about ${money(retail,2)}. Use as sell price</button>`:''}${ebayQ?`<a class="hintbtn" href="${esc(ebaySold(ebayQ))}" target="_blank" rel="noopener noreferrer">eBay sold prices ↗</a>`:''}</p>`:''}
    <p class="err" id="p-err"></p>
    <div class="actions"><button class="ghost" data-action="pend-skip">Skip</button><button class="primary" data-action="pend-save">Save, scan next</button></div></div>`;
  box.querySelectorAll('img[data-imgfallback]').forEach(img=>img.onerror=()=>img.remove());
  setPaused(true,'Enter the cost, then save');
  const f=(active&&$('#'+active)&&$('#b-pend').contains($('#'+active)))?$('#'+active):(p.code?$('#p-cost'):$('#p-name'));
  try{f&&f.focus({preventScroll:false})}catch(e){}
}
function beginPend(code){
  const k=code?knownProduct(code):null;
  const want=code&&(!(k&&k.name)||isCard(code));
  buy.pend={code,name:k?k.name:'',qty:1,cost:'',est:k&&k.est>0?k.est:'',image:k&&k.image_url||null,brand:k&&k.brand||null,look:want?'loading':null};
  renderPend();
  if(want)lookupBarcode(code).then(res=>{
    const p=buy&&buy.pend; if(!p||p.code!==code)return;
    keepPend(); p.look=res||'none';
    if(res&&res.found){if(!p.name)p.name=titleOf(res);p.image=p.image||res.image_url||null;p.brand=p.brand||res.brand||null}
    renderPend();
  });
}
function onSingleScan(code){
  const p=buy&&buy.pend;
  if(!p)return beginPend(code);
  keepPend();
  if(p.code===code){p.qty=(+p.qty||1)+1;renderPend();toast(`Quantity ${p.qty}`);return}
  if(p.cost===''){beep(false);const e=$('#p-err');if(e)e.textContent='Enter the cost for this item first, or tap Skip.';return}
  savePend().then(ok=>{if(ok)beginPend(code)});
}
async function savePend(btn){
  const p=buy&&buy.pend; if(!p)return false; keepPend();
  const err=$('#p-err'), cost=p.cost===''?NaN:+p.cost, qty=+p.qty, est=p.est===''?null:+p.est;
  if(!(cost>=0)){err.textContent='Enter what you paid for each one.';$('#p-cost').focus();return false}
  if(!Number.isInteger(qty)||qty<1){err.textContent='Quantity must be a whole number of 1 or more.';return false}
  if(est!=null&&!(est>=0)){err.textContent='Sell price must be 0 or more, or blank.';return false}
  const it={barcode:p.code||null,name:p.name.trim(),qty,unit_cost:cost,est,brand:p.brand||null,image_url:p.image||null};
  if(!it.barcode&&!it.name){err.textContent='Give an item without a barcode a name.';$('#p-name').focus();return false}
  const ok=await busy(btn,async()=>{
    try{
      if(!buy.tripId){
        const v=await ensureVendor($('#b-vendor').value), date=$('#b-date').value||today();
        const {data,error}=await sb.rpc('create_lot',{p_business:biz.id,p_name:`${v?v.name:'Single buys'}, ${shortDate(date)}`,p_supplier:v?v.name:'',p_date:date,
          p_cost:cost*qty,p_ship:0,p_funded:readFund('b-fund'),p_cost_mode:'item',p_items:[it],p_vendor:v&&v.id||null,p_location:null,p_kind:'single'});
        if(error)throw error;
        const l=fromLot(data); state.lots.push(l); buy.tripId=l.id;
        const r=await sb.from('items').select('*').eq('lot_id',l.id); if(r.error)throw r.error;
        r.data.forEach(x=>upsertItem(fromItem(x)));
        ['#b-vendor','#b-date'].forEach(s=>{const e=$(s);if(e)e.disabled=true});
        const f=$('#b-fund'); if(f)f.closest('.field').remove();
      }else{
        const {data,error}=await sb.rpc('apply_to_lot',{p_lot:buy.tripId,p_items:[it]}); if(error)throw error;
        (data||[]).forEach(x=>upsertItem(fromItem(x)));
        const l=lot(buy.tripId); if(l)l.cost=state.items.filter(i=>i.lotId===l.id).reduce((a,i)=>a+(i.unitCost||0)*i.qty,0);
      }
      if(it.barcode)rememberProduct(it.barcode,{name:it.name||undefined,est:it.est,unit_cost:cost,brand:it.brand,image_url:it.image_url});
      toast(`Saved ${it.name||'item'} × ${qty} at ${money(cost,2)}`);
      buy.pend=null; renderPend(); renderTrip(); focusScan(true);
      return true;
    }catch(e){err.textContent=friendly(e);return false}
  });
  return !!ok;
}
function renderTrip(){
  const box=$('#b-trip'); if(!box)return; const t=buy.tripId&&lot(buy.tripId);
  if(!t){box.innerHTML='';return}
  const its=state.items.filter(i=>i.lotId===t.id).slice().reverse();
  const units=its.reduce((a,i)=>a+i.qty,0), total=its.reduce((a,i)=>a+(i.unitCost||0)*i.qty,0);
  box.innerHTML=`<h3 style="margin-top:12px">This trip: ${units} unit${units===1?'':'s'}, ${money(total,2)}</h3><ul class="list">${its.map(i=>`<li><div style="min-width:0"><div class="name">${esc(nm(i))}</div><div class="meta">${i.qty} × ${money(i.unitCost||0,2)}</div></div><div class="right num" style="font-size:18px">${money((i.unitCost||0)*i.qty,2)}</div></li>`).join('')}</ul>`;
}

/* a lot or pallet */
function newLotHtml(){
  const o=openLots();
  return `${o.length?`<p class="note" style="margin:0 0 12px">Adding more to a lot you already started? <button class="linkbtn" data-action="buy-pick" style="padding:0">Pick an open lot</button> (${o.length}).</p>`:''}
  <p class="sub" style="margin-bottom:12px">Enter what you paid for the whole lot. Then scan every item in it. Each unit's cost is the lot price divided by the number of units you apply.</p>
  <label class="field"><span>Price paid for the whole lot</span><input id="n-cost" class="costinput" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></label>
  <div class="grid2"><label class="field"><span>Where from</span><input id="n-vendor" list="vendor-list" placeholder="Vendor" autocomplete="off" value="${esc(lsGet(VENDOR_KEY)||'')}"></label>
  <label class="field"><span>Date bought</span><input id="n-date" type="date" value="${today()}"></label></div>${vendorList()}
  <div class="grid2"><label class="field"><span>Shipping to you</span><input id="n-ship" type="number" min="0" step="0.01" value="0" inputmode="decimal"></label>
  <label class="field"><span>Name (optional)</span><input id="n-name" placeholder="e.g. Target returns pallet"></label></div>
  ${showFund()?`<div class="field"><span>Paid for by</span>${fundSeg('n-fund')}</div>`:''}
  <div class="field"><span>Photos (optional)</span><p class="note" style="margin:0 0 6px">The pallet, the manifest, the receipt. Only people in your shop can see them.</p>
  <div class="photos" id="n-photos">${buy.photos.map(p=>`<span class="ph"><img src="${p.url}" alt="Photo to upload"></span>`).join('')}<label class="ph addphoto">+ Photo<input type="file" accept="image/*" multiple id="n-file" aria-label="Add a photo"></label></div></div>
  <p class="err" id="n-err"></p>
  <div class="actions"><button class="ghost" data-action="close">Cancel</button><button class="primary" data-action="lot-create">Create lot, start scanning</button></div>`;
}
async function shrinkPhoto(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=url});
    const k=Math.min(1,1600/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement('canvas'); c.width=Math.round(img.naturalWidth*k); c.height=Math.round(img.naturalHeight*k);
    c.getContext('2d').drawImage(img,0,0,c.width,c.height);
    return await new Promise(r=>c.toBlob(r,'image/jpeg',.82));
  }finally{URL.revokeObjectURL(url)}
}
async function readPhotos(files){
  const out=[];
  for(const f of files){try{const b=await shrinkPhoto(f);if(b)out.push(b)}catch(e){toast("One photo couldn't be read. Try a JPEG or PNG.")}}
  return out;
}
async function uploadPhotos(l,blobs){
  const paths=[];
  for(const b of blobs){
    const path=`${biz.id}/${l.id}/${uid()}.jpg`;
    const {error}=await sb.storage.from('lot-photos').upload(path,b,{contentType:'image/jpeg',upsert:false});
    if(!error)paths.push(path);
  }
  if(!paths.length)return false;
  const all=l.photos.concat(paths);
  const {error}=await sb.from('lots').update({photos:all}).eq('id',l.id);
  if(error)return false;
  l.photos=all; return paths.length===blobs.length;
}
async function createNewLot(btn){
  const err=$('#n-err'), raw=$('#n-cost').value, cost=raw===''?NaN:+raw, ship=+$('#n-ship').value||0;
  if(!(cost>=0)){err.textContent='Enter what you paid for the whole lot.';$('#n-cost').focus();return}
  if(!(ship>=0)){err.textContent='Shipping must be 0 or more.';return}
  await busy(btn,async()=>{
    try{
      const v=await ensureVendor($('#n-vendor').value), date=$('#n-date').value||today();
      const name=$('#n-name').value.trim()||`${v?v.name:'Lot'}, ${shortDate(date)}`;
      const {data,error}=await sb.rpc('create_lot',{p_business:biz.id,p_name:name,p_supplier:v?v.name:'',p_date:date,p_cost:cost,p_ship:ship,
        p_funded:readFund('n-fund'),p_cost_mode:'even',p_items:[],p_vendor:v&&v.id||null,p_location:null,p_kind:'lot'});
      if(error)throw error;
      const l=fromLot(data); state.lots.push(l);
      if(buy.photos.length){
        btn.textContent='Uploading photos…';
        const ok=await uploadPhotos(l,buy.photos.map(p=>p.blob));
        if(!ok)toast("Lot saved, but a photo didn't upload. Add it from the lot page.");
        buy.photos.forEach(p=>URL.revokeObjectURL(p.url));
      }
      buy.photos=[]; buy.newLot=false; buy.lotId=l.id; buy.last=null;
      renderBuy(); toast(`${lotNo(l.no)} created. Scan the first item.`);
    }catch(e){if(err.isConnected)err.textContent=friendly(e)}
  });
}
function applyHtml(){
  return `<div id="b-lotpick"></div>
  ${scanBarHtml()}
  <div id="b-last"></div>
  <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px"><button class="linkbtn" data-action="buy-nobarcode">Add an item with no barcode</button><span id="b-q" class="meta"></span></div>
  <div id="b-lotitems"></div>
  <div class="actions" style="margin-top:12px;flex-wrap:wrap"><button class="ghost" data-action="lot-done">Mark lot done</button><button class="primary" data-action="buy-done">Done for now</button></div>`;
}
function renderApply(){
  const l=buy&&lot(buy.lotId); if(!l||!$('#b-lotpick'))return;
  const its=state.items.filter(i=>i.lotId===l.id), units=its.reduce((a,i)=>a+i.qty,0), landed=l.cost+l.shipIn;
  $('#b-lotpick').innerHTML=`<div class="lotpick"><div style="min-width:0"><div class="k">Applying scans to</div><div style="font-weight:700">${lotNo(l.no)} · ${esc(l.name)}</div>
    <div class="k">${money(landed,2)} paid · ${units} unit${units===1?'':'s'} applied</div><button class="linkbtn" data-action="buy-pick" style="padding:2px 0 0;font-size:13px">Switch lot</button></div>
    <div class="right"><div class="avgbig num">${units?money(landed/units,2):'–'}</div><div class="k">avg cost a unit</div></div></div>`;
  renderLast(); renderLotItems(); renderQ();
}
function lastItem(){const L=buy&&buy.last;return L?state.items.find(i=>i.lotId===L.lotId&&i.barcode===L.code&&i.unitCost==null):null}
function renderLast(){
  const box=$('#b-last'); if(!box)return;
  if((buy.renaming&&$('#r-name'))||(buy.manual&&$('#m-name')))return;
  if(buy.manual){
    box.innerHTML=`<div class="costcard"><div class="grid2"><label class="field"><span>Item name</span><input id="m-name" placeholder="What is it?" autocomplete="off"></label>
    <label class="field"><span>How many</span><input id="m-qty" type="number" min="1" step="1" value="1" inputmode="numeric"></label></div><p class="err" id="m-err"></p>
    <div class="actions"><button class="ghost" data-action="manual-cancel">Cancel</button><button class="primary" data-action="manual-add">Add to lot</button></div></div>`;
    setPaused(true,'Finish adding the item'); $('#m-name').focus(); return;
  }
  setPaused(false);
  const L=buy.last;
  if(!L){box.innerHTML=`<p class="note" style="margin:0 0 12px">Each scan adds 1 to this lot. Scans save in the background, so keep going. New barcodes get named automatically when the lookup finds them. Anything it can't name shows under "Needs a name" in Stock.</p>`;return}
  const it=lastItem(), p=state.products.get(L.code), img=p&&p.image_url;
  box.innerHTML=`<div class="lastscan">${img?`<img src="${esc(img)}" alt="" referrerpolicy="no-referrer" data-imgfallback>`:''}
    <div style="min-width:0;flex:1"><div class="meta">Last scan · ${esc(isCard(L.code)||isBulk(L.code)?codeText(L.code):L.code)}</div>
    ${buy.renaming?`<div class="with-btn" style="margin-top:4px"><input id="r-name" value="${esc(it?it.name:'')}" placeholder="What is it?" autocomplete="off" style="border:1px solid var(--line);background:var(--field);border-radius:8px;padding:8px 10px;min-height:42px"><button class="primary" data-action="last-name-save" style="padding:8px 14px">Save</button></div>`
      :`<div style="font-weight:700">${esc(it?nm(it):'Removed')}</div>${it&&!it.name?`<div class="meta">${L.looking?'Looking up the name…':'No name found. Name it now or later.'}</div>`:''}`}</div>
    <div class="right"><div class="big num">×${it?it.qty:0}</div><div class="meta">in this lot</div></div></div>
  ${buy.renaming?'':`<div style="display:flex;gap:8px;margin:-4px 0 12px;flex-wrap:wrap"><button class="btn-sm" data-action="last-minus" aria-label="Remove one">−1</button><button class="btn-sm" data-action="last-plus" aria-label="Add one more">+1</button><button class="btn-sm" data-action="last-name">${it&&it.name?'Rename':'Name it'}</button></div>`}`;
  box.querySelectorAll('img[data-imgfallback]').forEach(img=>img.onerror=()=>img.remove());
  if(buy.renaming){const r=$('#r-name');r.focus();r.select()}
}
function renderLotItems(){
  const box=$('#b-lotitems'); if(!box)return; const l=lot(buy.lotId);
  const its=state.items.filter(i=>i.lotId===l.id).slice().reverse();
  if(!its.length){box.innerHTML='';return}
  const shown=its.slice(0,40);
  box.innerHTML=`<h3 style="margin-top:6px">In this lot: ${its.length} kind${its.length===1?'':'s'} of item</h3><ul class="list">${shown.map(i=>`<li>${i.barcode?`<button class="rowlink" data-action="last-set" data-code="${esc(i.barcode)}">`:'<div class="rowlink" style="cursor:default">'}<div style="min-width:0"><div class="name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(nm(i))}</div><div class="meta">${i.barcode?esc(isCard(i.barcode)||isBulk(i.barcode)?codeText(i.barcode):i.barcode):'No barcode'}${i.tmp?' · saving':''}</div></div><div class="right num" style="font-size:20px">×${i.qty}</div>${i.barcode?'</button>':'</div>'}</li>`).join('')}</ul>${its.length>40?`<p class="note">Plus ${its.length-40} more. Open the lot from the Lots tab to see everything.</p>`:''}`;
}
function onLotScan(code){
  if(!buy||!buy.lotId)return;
  if(buy.manual||buy.renaming){buy.manual=false;buy.renaming=false}
  const lotId=buy.lotId, k=knownProduct(code);
  enqueue(lotId,code,1,{name:k&&k.name||'',brand:k&&k.brand||null,image_url:k&&k.image_url||null});
  buy.last={code,lotId,looking:!(k&&k.name)};
  renderApply();
  if(!(k&&k.name)){
    lookupBarcode(code).then(res=>{
      if(res&&res.found){
        const info={name:titleOf(res),brand:res.brand||null,image_url:res.image_url||null};
        nameFix.set(code,info); applyName(lotId,code,info);
      }
      if(buy&&buy.last&&buy.last.code===code){buy.last.looking=false;if(buy.kind==='lot')renderApply()}
    });
  }
}
async function lastMinus(btn){
  const L=buy.last, it=lastItem(); if(!L||!it)return;
  const e=pendingQ.get(L.lotId+'|'+L.code);
  if(e&&e.qty>0){enqueue(L.lotId,L.code,-1);renderApply();return}
  if(it.tmp)return toast('Still saving. Try again in a second.');
  const sold=it.qty-it.onHand;
  if(it.qty-1<sold||it.onHand<1)return toast('Those units are already sold, so the count can\'t go lower.');
  await busy(btn,async()=>{
    const r=it.qty===1?await sb.from('items').delete().eq('id',it.id):await sb.from('items').update({qty:it.qty-1,on_hand:it.onHand-1}).eq('id',it.id);
    if(r.error)return toast(friendly(r.error));
    if(it.qty===1)state.items.splice(state.items.indexOf(it),1); else{it.qty--;it.onHand--}
    renderApply();
  });
}
async function addManual(btn){
  const name=$('#m-name').value.trim(), qty=+$('#m-qty').value, err=$('#m-err');
  if(!name)return err.textContent='Give it a name.';
  if(!Number.isInteger(qty)||qty<1)return err.textContent='How many? A whole number of 1 or more.';
  await busy(btn,async()=>{
    const {data,error}=await sb.rpc('apply_to_lot',{p_lot:buy.lotId,p_items:[{name,qty,barcode:null}]});
    if(error)return err.textContent=friendly(error);
    (data||[]).forEach(x=>upsertItem(fromItem(x)));
    buy.manual=false; renderApply(); focusScan(true); toast(`Added ${name} × ${qty}`);
  });
}
function renderPick(){
  stopScan(); setPaused(false);
  const o=openLots();
  openSheet(`<h2>Pick a lot</h2><p class="sub">Scans go into the lot you pick, and its price is averaged over every unit applied.</p>
  ${o.length?`<ul class="list">${o.map(l=>{const units=state.items.filter(i=>i.lotId===l.id).reduce((a,i)=>a+i.qty,0);return `<li><button class="rowlink" data-action="buy-use" data-lot="${l.id}"><div style="min-width:0"><div class="name">${lotNo(l.no)} · ${esc(l.name)}</div><div class="meta">${esc(l.supplier)}, ${shortDate(l.date)} · ${units} units applied</div></div><div class="right num" style="font-size:20px">${money(l.cost+l.shipIn)}</div></button></li>`}).join('')}</ul>`:'<p class="empty">No open lots. Lots marked done can be reopened from the Lots tab.</p>'}
  <div class="actions" style="margin-top:12px"><button class="ghost" data-action="close">Cancel</button><button class="primary" data-action="buy-newlot">New lot</button></div>`);
}
async function markLotDone(btn){
  const l=buy&&lot(buy.lotId); if(!l)return;
  await flushQ();
  await busy(btn,async()=>{
    const {error}=await sb.from('lots').update({closed:true}).eq('id',l.id);
    if(error)return toast(friendly(error));
    l.closed=true; closeSheet(); toast(`${lotNo(l.no)} marked done. You can reopen it from the Lots tab.`);
  });
}
function buyDone(){
  if(buy&&buy.pend){keepPend();if(buy.pend.cost!==''){savePend().then(ok=>{if(ok)closeSheet()});return}}
  closeSheet();
}

/* ---------- edit an item (name it, set a sell price) ---------- */
function openEditItem(id){
  const i=item(id); if(!i)return;
  openSheet(`<h2>${i.name?'Edit item':'Name this item'}</h2>
  <label class="field"><span>Name</span><input id="i-name" value="${esc(i.name)}" placeholder="What is it?" autocomplete="off"></label>
  <label class="field"><span>Sell for (optional)</span><input id="i-est" type="number" min="0" step="0.01" inputmode="decimal" value="${i.est>0?i.est:''}" placeholder="0.00"></label>
  ${i.barcode?`<p class="note">${esc(codeText(i.barcode))}. The name is saved with this ${isCard(i.barcode)||isBulk(i.barcode)?'card':'barcode'}, so future scans fill it in.</p>`:''}
  <p class="err" id="i-err"></p><div class="actions"><button class="ghost" data-action="item" data-item="${i.id}">Back</button><button class="primary" data-action="save-item" data-item="${i.id}">Save</button></div>`);
}
async function saveItem(btn,id){
  const i=item(id); if(!i)return;
  const name=$('#i-name').value.trim(), raw=$('#i-est').value, est=raw===''?0:+raw;
  if(!(est>=0))return $('#i-err').textContent='Enter a price of 0 or more.';
  await busy(btn,async()=>{
    const {error}=await sb.from('items').update({name,est}).eq('id',id);
    if(error)return $('#i-err').textContent=friendly(error);
    i.name=name; i.est=est;
    if(i.barcode&&name){
      const prod={business_id:biz.id,barcode:i.barcode,name}; if(est>0)prod.est=est;
      await sb.from('products').upsert(prod,{onConflict:'business_id,barcode'});
      rememberProduct(i.barcode,{name,est:est>0?est:undefined});
    }
    openItem(id); render(); toast('Saved');
  });
}

function openLog(){
  logType='invest';
  openSheet(`<h2>Log money in or out</h2>
  <div class="field"><span>Type</span><div class="seg" id="g-type"><button type="button" data-type="invest" class="on">Investment from ${esc(state.settings.backerName)}</button><button type="button" data-type="payout">Payout to ${esc(state.settings.backerName)}</button></div></div>
  <div class="grid2"><label class="field"><span>Amount</span><input id="g-amt" type="number" min="0" step="0.01" inputmode="decimal"></label>
  <label class="field"><span>Date</span><input id="g-date" type="date" value="${today()}"></label></div>
  <label class="field"><span>Note (optional)</span><input id="g-note" placeholder="e.g. Funding for next pallet"></label>
  <p class="err" id="g-err"></p>
  <div class="actions"><button class="ghost" data-action="close">Cancel</button><button class="primary" data-action="save-log">Save entry</button></div>`);
}
function saveLog(btn){
  const a=+$('#g-amt').value; if(!(a>0))return $('#g-err').textContent='Enter an amount greater than zero.';
  return busy(btn,async()=>{
    const {data,error}=await sb.from('capital').insert({business_id:biz.id,type:logType,amount:a,date:$('#g-date').value||today(),note:$('#g-note').value.trim()}).select().single();
    if(error)return $('#g-err').textContent=friendly(error);
    state.capital.push(fromCap(data)); closeSheet(); tab='backer'; render(); toast(logType==='invest'?'Investment saved':'Payout saved');
  });
}

function openSettings(){
  const S=state.settings, owner=role==='owner', empty=!state.lots.length&&!state.capital.length;
  const roleName={owner:'Owner',staff:'Staff',backer:'Backer (view only)'}[role];
  openSheet(`<h2>Settings</h2>
  <div class="userline"><span><span class="syncdot ${online?'':'off'}"></span>${esc(session.user.email)} · ${roleName}</span><button class="ghost" data-action="signout" style="padding:8px 14px">Sign out</button></div>
  ${memberships.length>1?`<label class="field"><span>Shop</span><select id="t-shop">${memberships.map(m=>`<option value="${m.businesses.id}" ${m.businesses.id===biz.id?'selected':''}>${esc(m.businesses.name)} (${esc(m.role)})</option>`).join('')}</select></label>`:''}
  ${owner?`<label class="field"><span>Shop name</span><input id="t-shopname" value="${esc(S.shopName)}"></label>
  <div class="grid2"><label class="field"><span>Seller name</span><input id="t-seller" value="${esc(S.sellerName)}"></label>
  <label class="field"><span>Backer name</span><input id="t-backer" value="${esc(S.backerName)}"></label></div>
  <label class="field"><span>Backer's share of profit (%)</span><input id="t-split" type="number" min="0" max="100" step="1" value="${S.split}"></label>
  <div class="field"><span>Fees taken per sale (%)</span><p class="note" style="margin:0 0 8px">Set these to your actual rates. Changes apply to new sales only.</p>
  ${CHANNELS.map((c,k)=>`<label class="field" style="margin-bottom:8px"><span style="font-weight:500">${esc(c)}</span><input id="t-fee${k}" type="number" min="0" max="100" step="0.1" value="${S.fees[c]}"></label>`).join('')}</div>
  <div class="actions" style="margin-bottom:6px"><button class="primary" data-action="save-settings">Save settings</button></div>
  <div class="phase"><h3 style="margin-bottom:4px">Invite someone</h3><p class="note" style="margin:0 0 10px">They create an account with this email and land in this shop. A backer can see everything but can't change anything. Staff can add lots and record sales.</p>
    <label class="field"><span>Their email</span><input id="t-invite" type="email" autocapitalize="off" inputmode="email"></label>
    <div class="seg" id="t-role" style="margin-bottom:10px"><button type="button" data-fund="backer" class="on">Backer</button><button type="button" data-fund="staff">Staff</button></div>
    <p class="err" id="t-inv-err"></p><button class="ghost" data-action="invite">Send invite</button></div>`:''}
  <div class="phase"><h3 style="margin-bottom:4px">Connect TikTok Shop</h3><p class="note" style="margin:0 0 10px">Planned for phase 2: pull orders and sync stock counts automatically, so sales made through Shop checkout never need typing in.</p><button class="ghost" disabled style="opacity:.5">Available in phase 2</button></div>
  ${canWrite()?`<div class="phase"><h3 style="margin-bottom:4px">Testing tools</h3><p class="note" style="margin:0 0 10px">${empty?'Load a few sample lots and sales to try the app before entering real stock.':'Sample data is only offered while the shop is empty.'}</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${empty?'<button class="ghost" data-action="sample">Load sample data</button>':''}${owner&&!empty?'<button class="danger" data-action="erase">Erase all data in this shop</button>':''}</div></div>`:''}
  <div class="actions"><button class="ghost" data-action="close">Close</button></div>`);
}
function saveSettings(btn){
  const fees={}; CHANNELS.forEach((c,k)=>fees[c]=Math.min(100,Math.max(0,+$('#t-fee'+k).value||0)));
  const row={name:$('#t-shopname').value.trim()||'My shop',seller_name:$('#t-seller').value.trim()||'Seller',backer_name:$('#t-backer').value.trim()||'Backer',
    split:Math.min(100,Math.max(0,+$('#t-split').value||0)),fees};
  return busy(btn,async()=>{
    const {data,error}=await sb.from('businesses').update(row).eq('id',biz.id).select().single();
    if(error)return toast(friendly(error));
    biz=data; state.settings=fromBiz(biz); closeSheet(); render(); toast('Settings saved');
  });
}
async function sendInvite(btn){
  const email=$('#t-invite').value.trim().toLowerCase(), r=document.querySelector('#t-role .on').dataset.fund, err=$('#t-inv-err');
  if(!/^\S+@\S+\.\S+$/.test(email))return err.textContent='Enter a valid email.';
  await busy(btn,async()=>{
    const {error}=await sb.from('business_invites').upsert({business_id:biz.id,email,role:r},{onConflict:'business_id,email'});
    if(error)return err.textContent=friendly(error);
    err.textContent=''; $('#t-invite').value='';
    toast(`Invite saved. Send ${email} the app link and have them create an account.`);
  });
}

/* ---------- events ---------- */
function sheetBusy(){
  if(buy&&buy.pend){keepPend();if(buy.pend.cost!==''){toast('Save or skip the item you scanned first.');return true}}
  return false;
}
document.addEventListener('click',e=>{
  const t=e.target;
  if(t.id==='scrim'){if(!sheetBusy())closeSheet();return}
  if(t.closest&&t.closest('#scanzone')&&!t.closest('button,input,label,a')){focusScan(true);return}
  const el=t.closest('[data-tab],[data-period],[data-filter],[data-lotsfilter],[data-ch],[data-fund],[data-type],[data-mode],[data-kind],[data-action]'); if(!el)return;
  if(el.dataset.tab){tab=el.dataset.tab;render();window.scrollTo(0,0);return}
  if(el.dataset.period!==undefined){period=+el.dataset.period;render();return}
  if(el.dataset.filter){stockFilter=el.dataset.filter;render();return}
  if(el.dataset.lotsfilter){lotsFilter=el.dataset.lotsfilter;render();return}
  if(el.dataset.mode&&!el.dataset.action){setScanMode(el.dataset.mode);return}
  if(el.dataset.kind){switchBuyKind(el.dataset.kind);return}
  if(el.dataset.ch){sheetCh=el.dataset.ch;el.parentNode.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b===el));const d=$('#s-ship');if(d)sellPreview();return}
  if(el.dataset.fund||el.dataset.type){if(el.dataset.type)logType=el.dataset.type;el.parentNode.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b===el));return}
  switch(el.dataset.action){
    case 'sell':openSell(el.dataset.item);break;
    case 'buy':openBuy();break;
    case 'buy-newlot':if(buy){buy.kind='lot';buy.newLot=true;lsSet(BUYKIND_KEY,'lot');renderBuy()}else openBuy({kind:'lot',newLot:true});break;
    case 'buy-pick':renderPick();break;
    case 'buy-use':if(!buy)openBuy({kind:'lot',lotId:el.dataset.lot});else{buy.kind='lot';buy.lotId=el.dataset.lot;buy.newLot=false;buy.last=null;renderBuy()}break;
    case 'buy-newtrip':buy.tripId=null;buy.pend=null;renderBuy();break;
    case 'buy-nobarcode':
      if(buy.kind==='single'){if(buy.pend){keepPend();if(buy.pend.cost!==''){toast('Save or skip the item you scanned first.');break}}beginPend('')}
      else{buy.manual=true;buy.renaming=false;renderLast()}
      break;
    case 'buy-done':buyDone();break;
    case 'pend-save':savePend(el);break;
    case 'pend-skip':buy.pend=null;renderPend();focusScan(true);break;
    case 'use-retail':{const f=$('#p-est');if(f){f.value=el.dataset.v;keepPend()}break}
    case 'lot-create':createNewLot(el);break;
    case 'lot-done':markLotDone(el);break;
    case 'lot-toggle':toggleLot(el.dataset.lot,el);break;
    case 'lot-apply':{const l=lot(el.dataset.lot);if(l)openBuy(l.kind==='single'?{kind:'single',tripId:l.id}:{kind:'lot',lotId:l.id});break}
    case 'last-plus':if(buy.last){enqueue(buy.last.lotId,buy.last.code,1,null);renderApply()}break;
    case 'last-minus':lastMinus(el);break;
    case 'last-name':buy.renaming=true;renderLast();break;
    case 'last-name-save':{const v=$('#r-name').value.trim();if(v){applyName(buy.last.lotId,buy.last.code,{name:v},true)}buy.renaming=false;renderApply();focusScan(true);break}
    case 'last-set':buy.last={code:el.dataset.code,lotId:buy.lotId,looking:false};buy.renaming=false;renderLast();window.scrollTo(0,0);$('#sheet').scrollTop=0;break;
    case 'manual-add':addManual(el);break;
    case 'manual-cancel':buy.manual=false;renderLast();focusScan(true);break;
    case 'card-go':runCardSearch();break;
    case 'card-pick':pickCard(el.dataset.code);break;
    case 'bulk-add':addBulk(el.dataset.b);break;
    case 'bulk-rates':renderBulkRates();break;
    case 'type-go':{const b=$('#typebox');if(b){const v=b.value;b.value='';handleScan(v);b.focus()}break}
    case 'item':openItem(el.dataset.item);break;
    case 'item-edit':openEditItem(el.dataset.item);break;
    case 'save-item':saveItem(el,el.dataset.item);break;
    case 'close':if(!sheetBusy())closeSheet();break;
    case 'save-sale':saveSale(el,false);break;
    case 'save-sale-next':saveSale(el,true);break;
    case 'lot':openLot(el.dataset.lot);break;
    case 'log':openLog();break;
    case 'save-log':saveLog(el);break;
    case 'settings':openSettings();break;
    case 'save-settings':saveSettings(el);break;
    case 'invite':sendInvite(el);break;
    case 'signout':flushQ();sb.auth.signOut();break;
    case 'sample':loadSample(el);break;
    case 'erase':
      if(!resetArmed){resetArmed=true;el.textContent='Tap again to erase everything';return}
      eraseAll(el);break;
    case 'connect':doConnect(el);break;
    case 'disconnect':lsSet(CFG_KEY,null);location.reload();break;
    case 'auth-go':doAuth(el);break;
    case 'auth-mode':authMode=el.dataset.mode;viewAuth();break;
    case 'undo-sale':undoSale(el.dataset.sale,el);break;
    case 'del-lot':deleteLot(el.dataset.lot,el);break;
  }
});
document.addEventListener('keydown',e=>{
  const id=e.target&&e.target.id;
  if(e.key==='Escape'){if(!$('#scrim').hidden&&!sheetBusy())closeSheet();return}
  if(e.key!=='Enter')return;
  if(['p-cost','p-qty','p-est','p-name'].includes(id)){e.preventDefault();savePend($('[data-action=pend-save]'));return}
  if(['s-price','s-qty','s-ship'].includes(id)){e.preventDefault();saveSale($('[data-action=save-sale-next]'),true);return}
  if(id==='r-name'){e.preventDefault();$('[data-action=last-name-save]').click();return}
  if(id==='m-name'||id==='m-qty'){e.preventDefault();addManual($('[data-action=manual-add]'));return}
  if(id==='n-cost'||id==='n-ship'||id==='n-name'){e.preventDefault();createNewLot($('[data-action=lot-create]'));return}
  if(id==='i-name'||id==='i-est'){e.preventDefault();$('[data-action=save-item]').click();return}
  if(gate&&e.target.tagName==='INPUT'){e.preventDefault();const b=$('#main [data-action=auth-go],#main [data-action=connect]');b&&b.click()}
});
document.addEventListener('change',async e=>{
  const t=e.target;
  if(t.id==='t-shop'){lsSet(BIZ_KEY,t.value);closeSheet();enterApp();return}
  if(t.id==='n-file'&&buy){
    const blobs=await readPhotos([...t.files]); t.value='';
    blobs.forEach(b=>buy.photos.push({blob:b,url:URL.createObjectURL(b)}));
    const box=$('#n-photos'); if(box)box.insertAdjacentHTML('afterbegin',blobs.map(b=>`<span class="ph"><img src="${buy.photos.find(p=>p.blob===b).url}" alt="Photo to upload"></span>`).join(''));
    return;
  }
  if(t.id==='lot-file'){
    const l=lot(t.dataset.lot); if(!l)return;
    const files=[...t.files]; t.value=''; if(!files.length)return;
    toast('Uploading…');
    const ok=await uploadPhotos(l,await readPhotos(files));
    toast(ok?'Photo added':"Couldn't upload that photo. Check your connection and try again.");
    if(!$('#scrim').hidden&&$('#lot-photos'))openLot(l.id);
    render();
  }
});
start();
if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('sw.js').catch(()=>{});
