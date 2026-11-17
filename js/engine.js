// Workout generation engine. Pure: no DOM, no storage, no Math.random, no clock.
// Everything a workout depends on arrives through `request` and `ctx`, so the
// same request and seed always produce the same workout.
//
//   request = { dur, feel, groups: {id: {on, pct}}, opts: {warm, cooldown, cardio, superset}, seed }
//   ctx     = { last: {exerciseId: {w, reps}}, date: ISO string }
import { LIB, PAIR_META, WARMUPS, CORRECTIVES, CARDIO, GROUPS } from './exercises.js';

/* ---------- Seeded RNG ---------- */
export function mulberry32(seed){
  let a=seed>>>0;
  return function(){
    a=(a+0x6D2B79F5)|0;
    let t=Math.imul(a^(a>>>15),1|a);
    t=(t+Math.imul(t^(t>>>7),61|t))^t;
    return ((t^(t>>>14))>>>0)/4294967296;
  };
}

/* ---------- Loads, reps and sets ---------- */
function roundInc(w,unit){ if(unit==='ea'){return Math.max(0,Math.round(w/2.5)*2.5);} return Math.max(0,Math.round(w/5)*5); }
function suggestWeight(e,feel,last){
  const prior=last[e.id]||{w:e.w||0,reps:e.reps};
  let w=prior.w||0;
  if(w>0){
    if(feel==='good') w=w*1.04;      // progress ~4%
    else if(feel==='bad') w=w*0.88;  // deload ~12%
  }
  return roundInc(w,e.unit);
}
function suggestReps(e,last){
  const prior=last[e.id];
  return prior&&prior.reps?prior.reps:e.reps;
}
export function loadStyleFor(item){
  if(item&&item.loadStyle)return item.loadStyle;
  const exercise=item&&LIB.find(e=>e.id===item.id);
  return exercise&&exercise.loadStyle?exercise.loadStyle:(item&&item.unit==='ea'?'perSide':'total');
}
function notesLoadSuffix(item){
  const style=loadStyleFor(item);
  if(style==='pair')return '\u2019s';
  if(style==='perSide')return ' ea';
  return item.unit&&item.unit!=='lb'?' '+item.unit:'';
}
function schemeFor(e,dur,feel){
  // sets by duration & feeling; compounds get more
  let base = dur==='15'?2 : dur==='30'?3 : 4;
  if(e.t==='i') base = Math.max(2, base-1);
  if(feel==='good' && e.t==='c') base+=1;
  if(feel==='bad') base=Math.max(1, base-1);
  return base;
}

/* ---------- Selection ---------- */
function pickWithRng(arr,n,rng){
  const pool=[...arr],out=[];
  while(out.length<n&&pool.length)out.push(pool.splice(Math.floor(rng()*pool.length),1)[0]);
  return out;
}
function relevantWarmups(groupIds,n,rng){
  const relevant=WARMUPS.filter(item=>item.groups.some(group=>groupIds.includes(group)));
  return pickWithRng(relevant.length>=n?relevant:WARMUPS,n,rng);
}
function selectCorrectives(phase,count,groupIds,mainItems,excludeIds,rng){
  if(count<=0)return [];
  const excluded=new Set(excludeIds),chosen=[];
  if(phase==='warmup'&&mainItems.some(item=>item.id==='deadbug')){
    const primer=CORRECTIVES.find(item=>item.primerFor==='deadbug'&&!excluded.has(item.id));
    if(primer){chosen.push(primer);excluded.add(primer.id);}
  }
  let candidates=CORRECTIVES.filter(item=>item.phases.includes(phase)&&!excluded.has(item.id)&&item.groups.some(group=>groupIds.includes(group)));
  if(candidates.length<count-chosen.length){
    candidates=CORRECTIVES.filter(item=>item.phases.includes(phase)&&!excluded.has(item.id));
  }
  chosen.push(...pickWithRng(candidates,count-chosen.length,rng));
  return chosen.slice(0,count).map(item=>({id:item.id,name:item.name,reps:item.reps,warm:true,corrective:true}));
}
function canShareWorkout(exercise,chosen){
  return !exercise.exclusive||!chosen.some(other=>other.exclusive===exercise.exclusive);
}
function pickCompatible(arr,n,chosen,rng){
  const pool=[...arr],out=[];
  while(out.length<n&&pool.length){
    const candidate=pool.splice(Math.floor(rng()*pool.length),1)[0];
    if(canShareWorkout(candidate,[...chosen,...out]))out.push(candidate);
  }
  return out;
}
export function exerciseGroupId(e){return e&&e.sub?e.sub:e&&e.group;}
function groupPool(id){return LIB.filter(e=>exerciseGroupId(e)===id);}
function compatibleCapacity(pool){
  const exclusive=new Set();let capacity=0;
  pool.forEach(e=>{
    if(!e.exclusive){capacity++;return;}
    if(!exclusive.has(e.exclusive)){exclusive.add(e.exclusive);capacity++;}
  });
  return capacity;
}

/* ---------- Supersets ---------- */
function pairKey(a,b){return [a,b].sort().join('|');}
function supersetLimit(dur){return dur==='15'?2:dur==='30'?2:3;}
function supersetScore(a,b){
  if(!a||!b||a.sets!==b.sets)return -1;
  const am=a.pairMeta||{},bm=b.pairMeta||{};
  if(am.fatigue==='high'||bm.fatigue==='high')return -1;

  const groups=pairKey(a.group,b.group);
  const patterns=pairKey(am.pattern,bm.pattern);
  const opposedLegs=patterns==='knee_extension|knee_flexion';
  if(a.group===b.group&&!opposedLegs)return -1;

  // Protect bracing and avoid pairing movements whose prime movers overlap.
  const coreItem=a.group==='core'?a:b.group==='core'?b:null;
  const corePartner=coreItem===a?b:coreItem===b?a:null;
  const coreMeta=coreItem===a?am:coreItem===b?bm:null;
  if(corePartner&&(corePartner.group==='legs'||corePartner.group==='shoulders'||corePartner.t==='c'))return -1;
  if(corePartner&&corePartner.group==='back'&&['hanging_core','spinal_extension'].includes(coreMeta.pattern))return -1;
  if((am.pattern==='upright_pull'&&b.group==='bis')||(bm.pattern==='upright_pull'&&a.group==='bis'))return -1;
  if(['chest|tris','back|bis','shoulders|tris','chest|shoulders'].includes(groups))return -1;

  let score=0;
  if(groups==='back|chest')score=60;
  else if(groups==='bis|tris')score=65;
  else if(['bis|chest','back|tris','bis|shoulders'].includes(groups))score=38;
  else if(opposedLegs)score=52;
  else if((a.group==='calves'||b.group==='calves')&&a.group!=='legs'&&b.group!=='legs')score=30;
  else if(corePartner&&['chest','back'].includes(corePartner.group)&&corePartner.t==='i')score=24;
  else if(['bis|legs','legs|tris'].includes(groups)&&a.t==='i'&&b.t==='i'&&am.fatigue==='low'&&bm.fatigue==='low')score=22;
  if(!score)return -1;

  if(patterns==='horizontal_press|horizontal_pull')score+=12;
  if(patterns==='vertical_press|vertical_pull')score+=10;
  if(patterns==='curl|triceps')score+=10;
  if(opposedLegs)score+=10;
  if(a.t==='i'&&b.t==='i')score+=8;
  if(am.equipment===bm.equipment){
    score+=am.equipment==='dumbbell'?10:am.equipment==='bodyweight'?7:am.equipment==='machine'?2:5;
  }else if(am.equipment==='bodyweight'||bm.equipment==='bodyweight')score+=4;
  return score;
}
function chooseSupersetPairs(items,limit){
  const candidates=[];
  for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
    const score=supersetScore(items[i],items[j]);
    if(score>0)candidates.push({a:i,b:j,score});
  }
  candidates.sort((x,y)=>y.score-x.score||x.a-y.a||x.b-y.b);
  const used=new Set(),pairs=[];
  for(const pair of candidates){
    if(pairs.length>=limit)break;
    if(used.has(pair.a)||used.has(pair.b))continue;
    used.add(pair.a);used.add(pair.b);pairs.push(pair);
  }
  return pairs;
}
function organizeSupersets(items,dur){
  const pairs=chooseSupersetPairs(items,supersetLimit(dur));
  if(!pairs.length)return {items,pairs:[]};
  const paired=new Set(pairs.flatMap(pair=>[pair.a,pair.b]));
  const units=pairs.map(pair=>({kind:'pair',first:Math.min(pair.a,pair.b),pair}));
  items.forEach((item,index)=>{if(!paired.has(index))units.push({kind:'solo',first:index,index,item});});
  units.sort((a,b)=>{
    const ap=a.kind==='solo'&&a.item.t==='c'?0:a.kind==='pair'?1:2;
    const bp=b.kind==='solo'&&b.item.t==='c'?0:b.kind==='pair'?1:2;
    return ap-bp||a.first-b.first;
  });
  const arranged=[],summary=[];
  units.forEach(unit=>{
    if(unit.kind==='solo'){arranged.push(unit.item);return;}
    const label=String.fromCharCode(65+summary.length);
    const first=items[unit.pair.a],second=items[unit.pair.b];
    arranged.push({...first,supersetId:label,supersetOrder:1});
    arranged.push({...second,supersetId:label,supersetOrder:2});
    summary.push({id:label,first:first.name,second:second.name,score:unit.pair.score});
  });
  return {items:arranged,pairs:summary};
}

/* ---------- Allocation ---------- */
function allocateGroupCounts(on,total,pctTotal,groups,rng){
  const alloc=on.map(g=>({
    g,n:1,capacity:compatibleCapacity(groupPool(g.id)),
    quota:groups[g.id].pct/pctTotal*total,
    tie:rng()
  }));
  let used=alloc.reduce((sum,a)=>sum+a.n,0);
  while(used<total){
    const candidates=alloc.filter(a=>a.n<a.capacity);
    if(!candidates.length)break;
    candidates.sort((a,b)=>(b.quota-b.n)-(a.quota-a.n)||a.tie-b.tie);
    candidates[0].n++;used++;
  }
  return alloc;
}
function buildItem(e,dur,feel,last){
  const sets=schemeFor(e,dur,feel);
  const w=e.bw?null:suggestWeight(e,feel,last);
  return {id:e.id,name:e.name,reps:suggestReps(e,last),unit:e.unit||'lb',loadStyle:e.loadStyle||null,bw:!!e.bw,sets,w,note:e.note||null,t:e.t,
    group:exerciseGroupId(e),pairMeta:PAIR_META[e.id]||{equipment:'other',pattern:'other',fatigue:e.t==='c'?'moderate':'low'}};
}

/* ---------- Generate ---------- */
export function generateWorkout(request,ctx){
  const {dur,feel,groups,opts}=request;
  const {last}=ctx;
  const rng=mulberry32(request.seed);
  const on=GROUPS.filter(g=>groups[g.id].on && groups[g.id].pct>0);
  const pctTotal=on.reduce((a,g)=>a+groups[g.id].pct,0);
  const totalMap={'15':4,'30':6,'60':9};
  let total=totalMap[dur];
  if(feel==='bad') total=Math.max(2,total-1);
  // Every selection receives one exercise. Remaining slots follow the requested
  // percentages and respect each group's distinct exercise-library capacity.
  const mainTotal=Math.max(on.length,total);
  const alloc=allocateGroupCounts(on,mainTotal,pctTotal,groups,rng);

  const mainItems=[];
  alloc.forEach(a=>{
    const gid=a.g.id;
    const pool=groupPool(gid);
    const poolC=pool.filter(e=>e.t==='c');
    const poolI=pool.filter(e=>e.t==='i');
    const chosen=[];
    // prioritise compounds
    chosen.push(...pickCompatible(poolC,Math.min(poolC.length,Math.ceil(a.n*0.6)),chosen,rng));
    chosen.push(...pickCompatible(poolI,Math.max(0,a.n-chosen.length),chosen,rng));
    while(chosen.length<a.n){
      const extra=pickCompatible([...poolC,...poolI].filter(e=>!chosen.includes(e)),1,chosen,rng);
      if(!extra.length)break;
      chosen.push(extra[0]);
    }
    chosen.slice(0,a.n).forEach(e=>mainItems.push(buildItem(e,dur,feel,last)));
  });
  const wantsSupersets=opts.superset&&feel!=='bad';
  const organized=wantsSupersets?organizeSupersets(mainItems,dur):{items:mainItems,pairs:[]};
  const activeGroupIds=on.map(group=>group.id);
  const sections=[],usedCorrectives=[];
  if(opts.warm){
    const corrective=selectCorrectives('warmup',1,activeGroupIds,organized.items,usedCorrectives,rng);
    usedCorrectives.push(...corrective.map(item=>item.id));
    const baseWarmups=relevantWarmups(activeGroupIds,3-corrective.length,rng).map(item=>({name:item.name,reps:item.reps,warm:true}));
    sections.push({title:'Warm-up',icon:'\u26A1',items:[...baseWarmups,...corrective]});
  }
  sections.push({title:'Main work',icon:'\uD83C\uDFCB\uFE0F',items:organized.items});
  if(opts.cardio){
    const c=pickWithRng(CARDIO,1,rng)[0];
    sections.push({title:'Cardio',icon:'\uD83C\uDFC3',items:[{name:c.name,reps:c.reps,warm:true}]});
  }
  if(opts.cooldown){
    const corrective=selectCorrectives('cooldown',2-usedCorrectives.length,activeGroupIds,organized.items,usedCorrectives,rng);
    if(corrective.length)sections.push({title:'Cooldown',icon:'\uD83E\uDDD8',items:corrective});
  }
  // form note: pick one from main items that has a note
  const noteItem=organized.items.filter(it=>it.note);
  const formNote=noteItem.length?pickWithRng(noteItem,1,rng)[0]:null;
  return {date:ctx.date,seed:request.seed,dur,feel,sections,
    split:alloc.map(a=>({id:a.g.id,name:a.g.name,pct:groups[a.g.id].pct,count:a.n})),
    formNote:formNote?{name:formNote.name,text:formNote.note}:null,
    supersets:organized.pairs};
}

/* ---------- Apple Notes text ---------- */
function pushNotesLift(lines,it,code='',formText=''){
  const unit=notesLoadSuffix(it);
  lines.push(`${code?code+' ':''}${it.name} | ${it.sets} x ${it.reps}`);
  for(let s=0;s<it.sets;s++){
    if(it.bw)lines.push('Bodyweight x ');
    else lines.push(`${it.w}${unit} x `);
  }
  if(formText)lines.push(`Form: ${formText}`);
}
export function notesText(w){
  const d=new Date(w.date);
  const lines=[`${d.getMonth()+1}/${d.getDate()}`];
  w.sections.forEach((sec,sectionIndex)=>{
    if(sectionIndex>0&&lines[lines.length-1]!=='')lines.push('');
    lines.push(sec.title.toUpperCase());
    for(let index=0;index<sec.items.length;index++){
      const it=sec.items[index];
      if(it.warm){ lines.push(`- ${it.name} ${it.reps}`); }
      else if(it.supersetOrder===1&&sec.items[index+1]&&sec.items[index+1].supersetId===it.supersetId){
        const mate=sec.items[index+1];
        lines.push(`SUPERSET ${it.supersetId} \u2014 ${it.sets} rounds`);
        pushNotesLift(lines,it,it.supersetId+'1',w.formNote&&w.formNote.name===it.name?w.formNote.text:'');
        pushNotesLift(lines,mate,it.supersetId+'2',w.formNote&&w.formNote.name===mate.name?w.formNote.text:'');
        lines.push(`Rest 60\u201390 sec after ${it.supersetId}2`,'');
        index++;
      }
      else{
        pushNotesLift(lines,it,'',w.formNote&&w.formNote.name===it.name?w.formNote.text:'');
        lines.push('');
      }
    }
  });
  while(lines[lines.length-1]==='')lines.pop();
  return lines.join('\n');
}
