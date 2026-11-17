// Workout generation engine. Pure: no DOM, no storage, no Math.random, no clock.
// Everything a workout depends on arrives through `request` and `ctx`, so the
// same request and seed always produce the same workout.
//
//   request = { dur, feel, groups: {id: {on, pct}}, opts: {warm, cooldown, cardio, superset}, seed }
//   ctx     = { last: {exerciseId: {w, reps}}, date: ISO string,
//               hidden?: [exerciseId] never to select, lib?: replacement library (tests) }
//
// Pipeline: budget (sets the time affords) -> sets per muscle group -> movement
// slots per group -> fill each slot in priority order -> sequence -> sets and
// loads -> optional supersets -> lint. A few seeded candidates are built and
// the first one that passes every rule is returned.
import { LIB, EQUIPMENT, WARMUPS, CORRECTIVES, CARDIO, GROUPS } from './exercises.js';
import { MIN_SETS, MAX_SETS, PATTERN_REPEAT_LIMIT, exerciseGroupId, patternFamily, canShareWorkout,
  compatibleCapacity, hingeOk, pressCounts, pressStackOk, fatigueCap, highFatigueCount,
  orderViolations, lintWorkout } from './rules.js';
export { exerciseGroupId };

/* ---------- Time budget ---------- */
// One table for everything that depends on session length.
export const DURATIONS={
  '15':{label:'10–15 min',short:'10–15m',minutes:15,maxGroups:4,supersets:2},
  '30':{label:'30 min',short:'30m',minutes:30,maxGroups:6,supersets:2},
  '45':{label:'45 min',short:'45m',minutes:45,maxGroups:7,supersets:3},
  '60':{label:'1 hour',short:'1h',minutes:60,maxGroups:8,supersets:3},
};
// Average minutes per work set, rest included. The single pace assumption:
// raise it if sessions run long, lower it if they finish early.
export const MINUTES_PER_SET=2.25;
const FEEL_VOLUME={bad:0.75,ok:1,good:1.1};
// Work sets the session can hold. Exercise count follows from this, not the reverse.
export function planBudget(dur,feel){
  return Math.max(MIN_SETS,Math.round(DURATIONS[dur].minutes/MINUTES_PER_SET*(FEEL_VOLUME[feel]||1)));
}

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

/* ---------- Loads and reps ---------- */
const FEEL_LOAD={good:1.04,bad:0.88};   // progress ~4%, deload ~12%
// The smallest load change this exercise's equipment allows.
function loadStep(e){return e.step||(EQUIPMENT[e.equipment]||{}).step||0;}
function suggestWeight(e,feel,last){
  const prior=last[e.id]||{w:e.w||0,reps:e.reps};
  const stored=prior.w||0;
  // A steady day shows the recorded load exactly as recorded. Assistance runs
  // the other way (less is harder), so it is always carried unchanged.
  if(!FEEL_LOAD[feel]||stored<=0||e.loadType==='assistance')return stored;
  // Nudge, then snap to a weight the equipment actually has. A nudge smaller
  // than one step leaves the load where it is; it never moves the wrong way.
  const target=stored*FEEL_LOAD[feel],step=loadStep(e);
  const snapped=step?Math.round(target/step)*step:Math.round(target);
  return feel==='good'?Math.max(snapped,stored):Math.min(snapped,stored);
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

/* ---------- Warm-up, correctives and cardio ---------- */
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

/* ---------- Supersets ---------- */
function pairKey(a,b){return [a,b].sort().join('|');}
function supersetScore(a,b){
  if(!a||!b||a.sets!==b.sets)return -1;
  const am=a.pairMeta||{},bm=b.pairMeta||{};
  if(am.fatigue==='high'||bm.fatigue==='high')return -1;

  const groups=pairKey(a.group,b.group);
  const patterns=pairKey(am.pattern,bm.pattern);
  const families=pairKey(patternFamily(am.pattern),patternFamily(bm.pattern));
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

  if(families==='horizontal_press|horizontal_pull')score+=12;
  if(families==='vertical_press|vertical_pull')score+=10;
  if(families==='curl|triceps')score+=10;
  if(opposedLegs)score+=10;
  if(a.t==='i'&&b.t==='i')score+=8;
  if(am.equipment===bm.equipment){
    score+=am.equipment==='dumbbell'?10:am.equipment==='bodyweight'?7:am.equipment==='machine'?2:5;
  }else if(am.equipment==='bodyweight'||bm.equipment==='bodyweight')score+=4;
  return score;
}


// Pairs compatible neighbours without disturbing the lifting order: a pair is
// only formed if the merged order still passes every order rule.
function arrangeSupersets(entries,limit){
  const candidates=[];
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
    const score=supersetScore(entries[i].item,entries[j].item);
    if(score>0)candidates.push({a:entries[i],b:entries[j],score,i,j});
  }
  candidates.sort((x,y)=>y.score-x.score||x.i-y.i||x.j-y.j);
  let units=entries.map(entry=>[entry]);
  const used=new Set(),scores=new Map();
  for(const c of candidates){
    if(scores.size>=limit)break;
    if(used.has(c.a)||used.has(c.b))continue;
    const merged=[c.a,c.b];
    // Join the pair where its first lift sits, or failing that where its second sits.
    const placements=[[c.a,c.b],[c.b,c.a]].map(([anchor,moved])=>
      units.filter(unit=>unit[0]!==moved).map(unit=>unit[0]===anchor?merged:unit));
    const valid=placements.find(order=>!orderViolations(order.flat().map(entry=>entry.e)).length);
    if(!valid)continue;
    units=valid;used.add(c.a);used.add(c.b);scores.set(merged,c.score);
  }
  const items=[],pairs=[];
  units.forEach(unit=>{
    if(unit.length===1){items.push(unit[0].item);return;}
    const label=String.fromCharCode(65+pairs.length);
    items.push({...unit[0].item,supersetId:label,supersetOrder:1});
    items.push({...unit[1].item,supersetId:label,supersetOrder:2});
    pairs.push({id:label,first:unit[0].item.name,second:unit[1].item.name,score:scores.get(unit)});
  });
  return {items,pairs};
}

/* ---------- Sets per muscle group ---------- */
function groupPool(lib,hidden,id){return lib.filter(e=>exerciseGroupId(e)===id&&!hidden.has(e.id));}
// Splits the set budget across the selected groups by their percentages. Every
// group gets at least MIN_SETS; a group stops at what its exercises can hold.
// The shortfall, if any, is reported instead of being hidden.
function planGroups(on,groups,budget,poolOf,rng){
  const pctTotal=on.reduce((sum,g)=>sum+groups[g.id].pct,0);
  const plan=on.map(g=>{
    const capacity=compatibleCapacity(poolOf(g.id));
    const maxSets=capacity*MAX_SETS;
    return {g,capacity,maxSets,pct:groups[g.id].pct,sets:Math.min(MIN_SETS,maxSets),tie:rng()};
  });
  const floor=plan.reduce((sum,p)=>sum+p.sets,0);
  const target=Math.max(budget,floor);
  plan.forEach(p=>{p.quota=p.pct/pctTotal*target;});
  let used=floor;
  while(used<target){
    const open=plan.filter(p=>p.sets<p.maxSets);
    if(!open.length)break;
    open.sort((a,b)=>(b.quota-b.sets)-(a.quota-a.sets)||a.tie-b.tie);
    open[0].sets++;used++;
  }
  // Up to four sets is one exercise; beyond that, about three and a half sets each.
  plan.forEach(p=>{p.count=p.sets?Math.min(p.capacity,p.sets<=MAX_SETS?1:Math.ceil(p.sets/3.5)):0;});

  const notes=[];
  plan.filter(p=>!p.capacity).forEach(p=>
    notes.push({rule:'served',text:`${p.g.name} was skipped: every ${p.g.name.toLowerCase()} exercise is hidden.`}));
  if(floor>budget+1){
    notes.push({rule:'budget',text:`${on.length} muscle groups need at least ${floor} sets and this session fits ${budget}, so expect it to run long.`});
  }
  if(used<target-1){
    const full=plan.filter(p=>p.capacity&&p.sets>=p.maxSets).map(p=>p.g.name);
    notes.push({rule:'budget',text:`Only ${used} of ${target} sets: ${full.join(' and ')} ${full.length===1?'has':'have'} no more exercises to add. Add a muscle group or pick a shorter session.`});
  }
  return {plan,notes};
}

/* ---------- Movement slots ---------- */
// What each muscle group trains first, second, third... A slot lists the
// movement patterns that can fill it. `ordered` slots take the first listed
// pattern the group has not used yet. Tier 0 slots are filled across all groups
// before tier 1, then tier 2, so a session covers its essentials first.
const SLOTS={
  chest:[
    {tier:0,patterns:['horizontal_press','incline_press']},
    {tier:0,patterns:['fly']},
    {tier:1,patterns:['incline_press','horizontal_press'],ordered:true},
    {tier:1,patterns:['dip','fly']},
  ],
  back:[
    {tier:0,patterns:['vertical_pull','horizontal_pull']},
    {tier:0,patterns:['vertical_pull','horizontal_pull'],ordered:true},
    {tier:1,patterns:['horizontal_pull','vertical_pull']},
    {tier:1,patterns:['lat_isolation','spinal_extension','shrug','hinge']},
  ],
  legs:[
    {tier:0,patterns:['squat']},
    {tier:0,patterns:['hinge','knee_flexion']},
    {tier:1,patterns:['knee_flexion','unilateral_legs']},
    {tier:1,patterns:['knee_extension','unilateral_legs','squat']},
    {tier:2,patterns:['hip_thrust','hip_abduction','hip_adduction','knee_extension','knee_flexion']},
  ],
  shoulders:[
    {tier:0,patterns:['vertical_press','lateral_raise']},
    {tier:0,patterns:['lateral_raise','rear_delt'],ordered:true},
    {tier:1,patterns:['rear_delt','lateral_raise','vertical_press'],ordered:true},
    {tier:2,patterns:['upright_pull','front_raise','lateral_raise','rear_delt']},
  ],
  bis:[{tier:0,patterns:['curl']}],
  tris:[
    {tier:0,patterns:['triceps','triceps_overhead']},
    {tier:1,patterns:['triceps','triceps_overhead'],ordered:true},
  ],
  core:[
    {tier:0,patterns:['core_flexion','hanging_core']},
    {tier:1,patterns:['anti_extension','anti_rotation','anti_lateral_flexion']},
    {tier:2,patterns:['rotation','carry','dynamic_core','spinal_extension']},
  ],
  calves:[{tier:0,patterns:['calves']}],
};
// Past the end of a group's list, any pattern may fill the slot.
const ANY_SLOT={tier:2,patterns:null};
// Scores are preferences, not cut-offs: every ten points doubles a candidate's
// chance of being picked. This is where variety comes from.
const SCORE_DOUBLING=10;

function openSlots(plan){
  const slots=[];
  plan.forEach((p,order)=>{
    for(let k=0;k<p.count;k++){
      const slot=(SLOTS[p.g.id]||[])[k]||ANY_SLOT;
      slots.push({p,k,order,tier:slot.tier,patterns:slot.patterns,ordered:!!slot.ordered});
    }
  });
  return slots.sort((a,b)=>a.tier-b.tier||b.p.sets-a.p.sets||a.order-b.order||a.k-b.k);
}
// Fills every slot in priority order. Hard rules narrow the candidates first,
// then the slot's patterns, then a weighted draw chooses among what is left. A rule is
// only relaxed when keeping it would leave the slot empty.
function fillSlots(plan,poolOf,feel,rng){
  const slots=openSlots(plan);
  const cap=fatigueCap(slots.length,feel);
  const picks=[];
  for(const slot of slots){
    const all=picks.map(pick=>pick.e);
    const mine=picks.filter(pick=>pick.p===slot.p).map(pick=>pick.e);
    const used=pattern=>mine.filter(e=>e.pattern===pattern).length;
    let candidates=poolOf(slot.p.g.id).filter(e=>!all.includes(e)&&canShareWorkout(e,all));
    if(!candidates.length)continue;
    const keep=test=>{const next=candidates.filter(test);if(next.length)candidates=next;};
    keep(e=>hingeOk([...all,e]));
    keep(e=>pressStackOk([...all,e]));
    keep(e=>e.fatigue!=='high'||highFatigueCount(all)<cap);
    keep(e=>used(e.pattern)<PATTERN_REPEAT_LIMIT);
    if(slot.patterns){
      keep(e=>slot.patterns.includes(e.pattern));
      if(slot.ordered){
        const first=slot.patterns.find(pattern=>!used(pattern)&&candidates.some(e=>e.pattern===pattern));
        if(first)keep(e=>e.pattern===first);
      }
    }
    const {horizontal,vertical}=pressCounts(all);
    const equipment=new Set(mine.map(e=>e.equipment));
    const scored=candidates.map(e=>({e,score:
      (used(e.pattern)?0:20)                                   // a movement the group has not done yet
      +(slot.tier===0&&e.t==='c'?15:0)                         // essentials lead with a compound
      +(equipment.has(e.equipment)?0:8)                        // vary the tool within a muscle group
      -(patternFamily(e.pattern)==='vertical_press'?10*(horizontal+vertical):0)  // ease off overhead work on press-heavy days
      -(feel==='bad'&&e.fatigue==='high'?30:0)}));             // deload days avoid the most taxing lifts
    const weights=scored.map(s=>Math.pow(2,s.score/SCORE_DOUBLING));
    let roll=rng()*weights.reduce((sum,weight)=>sum+weight,0),index=0;
    while(index<weights.length-1&&(roll-=weights[index])>=0)index++;
    picks.push({e:scored[index].e,p:slot.p,k:slot.k});
  }
  return picks;
}
// Shares a group's sets among its exercises; compounds and earlier slots get the extra set.
function assignSets(plan,picks){
  plan.forEach(p=>{
    const mine=picks.filter(pick=>pick.p===p).sort((a,b)=>(a.e.t==='c'?0:1)-(b.e.t==='c'?0:1)||a.k-b.k);
    if(!mine.length)return;
    const sets=Math.min(p.sets,mine.length*MAX_SETS);
    const base=Math.floor(sets/mine.length),extra=sets-base*mine.length;
    mine.forEach((pick,index)=>{pick.sets=base+(index<extra?1:0);});
  });
}

/* ---------- Sequencing ---------- */
const PRIMARY=new Set(['chest','back','legs','shoulders']);
const EQUIPMENT_ORDER=['barbell','smith','bodyweight','dumbbell','cable','machine'];
// Order of work. Each muscle group's lead lift comes first, most-emphasized
// group first. Then the remaining compounds, most taxing first. Then isolations
// for the big muscle groups, then arms, calves, and core last.
function sequence(plan,picks){
  const share=[...plan].sort((a,b)=>b.sets-a.sets);
  const heavy=pick=>pick.e.pattern==='squat'?0:pick.e.pattern==='hinge'?1:2;   // squat, then hinge, then the rest
  // A group's lead lift is its first compound, or its squat or hinge if it has one.
  const leads=new Set();
  plan.forEach(p=>{
    const compounds=picks.filter(pick=>pick.p===p&&pick.e.t==='c').sort((a,b)=>heavy(a)-heavy(b)||a.k-b.k);
    if(compounds.length)leads.add(compounds[0]);
  });
  const key=pick=>{
    const group=pick.p.g.id,rank=share.indexOf(pick.p);
    if(leads.has(pick))return [0,rank,0,0,0];
    if(pick.e.t==='c')return [1,pick.e.fatigue==='high'?0:1,heavy(pick),rank,EQUIPMENT_ORDER.indexOf(pick.e.equipment)*10+pick.k];
    return [PRIMARY.has(group)?2:group==='calves'?4:group==='core'?5:3,rank,pick.k,0,0];
  };
  return picks.map(pick=>({pick,key:key(pick)}))
    .sort((a,b)=>{for(let i=0;i<a.key.length;i++){if(a.key[i]!==b.key[i])return a.key[i]-b.key[i];}return 0;})
    .map(x=>x.pick);
}

/* ---------- Generate ---------- */
function buildItem(e,sets,feel,last){
  const w=e.bw?null:suggestWeight(e,feel,last);
  return {id:e.id,name:e.name,reps:suggestReps(e,last),unit:e.unit||'lb',loadStyle:e.loadStyle||null,bw:!!e.bw,sets,w,note:e.note||null,t:e.t,
    group:exerciseGroupId(e),pairMeta:{equipment:e.equipment,pattern:e.pattern,fatigue:e.fatigue},
    ...(e.loadType?{loadType:e.loadType}:{})};
}
function buildCandidate(request,ctx,lib,hidden,rng){
  const {dur,feel,groups,opts}=request;
  const {last}=ctx;
  const poolOf=id=>groupPool(lib,hidden,id);
  const on=GROUPS.filter(g=>groups[g.id].on && groups[g.id].pct>0);
  const budget=planBudget(dur,feel);
  const {plan,notes}=planGroups(on,groups,budget,poolOf,rng);
  const picks=fillSlots(plan,poolOf,feel,rng);
  assignSets(plan,picks);
  const entries=sequence(plan,picks).map(pick=>({e:pick.e,item:buildItem(pick.e,pick.sets,feel,last)}));
  const wantsSupersets=opts.superset&&feel!=='bad';
  const organized=wantsSupersets?arrangeSupersets(entries,DURATIONS[dur].supersets):{items:entries.map(entry=>entry.item),pairs:[]};
  const activeGroupIds=on.map(group=>group.id);
  const sections=[],usedCorrectives=[];
  if(opts.warm){
    const corrective=selectCorrectives('warmup',1,activeGroupIds,organized.items,usedCorrectives,rng);
    usedCorrectives.push(...corrective.map(item=>item.id));
    const baseWarmups=relevantWarmups(activeGroupIds,3-corrective.length,rng).map(item=>({name:item.name,reps:item.reps,warm:true}));
    sections.push({title:'Warm-up',icon:'⚡',items:[...baseWarmups,...corrective]});
  }
  sections.push({title:'Main work',icon:'🏋️',items:organized.items});
  if(opts.cardio){
    const c=pickWithRng(CARDIO,1,rng)[0];
    sections.push({title:'Cardio',icon:'🏃',items:[{name:c.name,reps:c.reps,warm:true}]});
  }
  if(opts.cooldown){
    const corrective=selectCorrectives('cooldown',2-usedCorrectives.length,activeGroupIds,organized.items,usedCorrectives,rng);
    if(corrective.length)sections.push({title:'Cooldown',icon:'🧘',items:corrective});
  }
  // form note: pick one from main items that has a note
  const noteItem=organized.items.filter(it=>it.note);
  const formNote=noteItem.length?pickWithRng(noteItem,1,rng)[0]:null;
  const sets=picks.reduce((sum,pick)=>sum+pick.sets,0);
  return {date:ctx.date,seed:request.seed,dur,feel,sections,
    split:plan.map(p=>{
      const mine=picks.filter(pick=>pick.p===p);
      return {id:p.g.id,name:p.g.name,pct:p.pct,count:mine.length,sets:mine.reduce((sum,pick)=>sum+pick.sets,0)};
    }),
    formNote:formNote?{name:formNote.name,text:formNote.note}:null,
    supersets:organized.pairs,
    budget,sets,minutes:Math.round(sets*MINUTES_PER_SET),notes};
}
// How many seeded candidates to try before settling for the best imperfect one.
const ATTEMPTS=6;
// Builds candidates until one passes the linter. `notes` on the result states
// anything the request made impossible; a rule already explained by a note is
// not reported twice.
export function generateWorkout(request,ctx){
  const lib=ctx.lib||LIB;
  const hidden=new Set(ctx.hidden||[]);
  let best=null;
  for(let attempt=0;attempt<ATTEMPTS;attempt++){
    const workout=buildCandidate(request,ctx,lib,hidden,mulberry32((request.seed+attempt*0x9E3779B9)>>>0));
    const problems=lintWorkout(workout,{lib,hidden:[...hidden]})
      .filter(problem=>!workout.notes.some(note=>note.rule===problem.rule));
    if(!best||problems.length<best.problems.length)best={workout,problems};
    if(!problems.length)break;
  }
  best.workout.notes=[...best.workout.notes,...best.problems];
  return best.workout;
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
