// Coaching rules. The generator uses them to build a workout and the linter
// uses the same functions to check one, so the two cannot drift apart.
import { LIB, PATTERNS, GROUPS } from './exercises.js';

export const MIN_SETS=2;
export const MAX_SETS=4;

export function exerciseGroupId(e){return e&&e.sub?e.sub:e&&e.group;}
export function patternFamily(pattern){return PATTERNS[pattern]?PATTERNS[pattern].family:pattern;}

/* ---------- Selection rules ---------- */
// Exercises sharing an `exclusive` key are near-duplicates and never share a workout.
export function canShareWorkout(exercise,chosen){
  return !exercise.exclusive||!chosen.some(other=>other.exclusive===exercise.exclusive);
}
// How many exercises a pool can contribute once exclusive keys are respected.
export function compatibleCapacity(pool){
  const exclusive=new Set();let capacity=0;
  pool.forEach(e=>{
    if(!e.exclusive){capacity++;return;}
    if(!exclusive.has(e.exclusive)){exclusive.add(e.exclusive);capacity++;}
  });
  return capacity;
}
// One loaded hinge (deadlift or a Romanian deadlift) per session.
export function hingeOk(exercises){
  return exercises.filter(e=>e.pattern==='hinge').length<=1;
}
// Overhead pressing is limited once the session already presses horizontally:
// two vertical presses at most, one when there are two or more chest-type presses.
export function pressCounts(exercises){
  let horizontal=0,vertical=0;
  exercises.forEach(e=>{
    const family=patternFamily(e.pattern);
    if(family==='horizontal_press')horizontal++;
    else if(family==='vertical_press')vertical++;
  });
  return {horizontal,vertical};
}
export function pressStackOk(exercises){
  const {horizontal,vertical}=pressCounts(exercises);
  return vertical<=(horizontal>=2?1:2);
}
// High-fatigue lifts allowed in a session of `count` exercises.
export function fatigueCap(count,feel){
  return feel==='bad'?1:count<=4?2:3;
}
export function highFatigueCount(exercises){
  return exercises.filter(e=>e.fatigue==='high').length;
}
// A pattern may appear twice in a muscle group before others must catch up.
export const PATTERN_REPEAT_LIMIT=2;

// Once a group has `min` exercises it must include one from each pattern set.
export const COVERAGE={
  chest:{min:2,need:[['horizontal_press','incline_press','dip'],['fly']],text:'a press and a fly'},
  back:{min:2,need:[['vertical_pull'],['horizontal_pull']],text:'a vertical and a horizontal pull'},
  legs:{min:2,need:[['squat','unilateral_legs'],['hinge','hip_thrust','knee_flexion']],text:'a squat-type lift and a hip or hamstring lift'},
  shoulders:{min:2,need:[['lateral_raise']],text:'a lateral raise'},
  tris:{min:2,need:[['triceps'],['triceps_overhead']],text:'a pushdown-type and an overhead extension'},
};

/* ---------- Order rules ---------- */
const AXIAL=new Set(['squat','hinge','unilateral_legs','vertical_press']);
// Returns one message per pair that is out of order. Only chains that matter
// are checked: an isolation must not pre-fatigue a compound that depends on it.
export function orderViolations(exercises){
  const out=[];
  for(let j=1;j<exercises.length;j++){
    const later=exercises[j];
    if(later.t!=='c')continue;
    const laterGroup=exerciseGroupId(later),laterFamily=patternFamily(later.pattern);
    for(let i=0;i<j;i++){
      const earlier=exercises[i],earlierGroup=exerciseGroupId(earlier);
      let why=null;
      if(earlier.t==='i'&&earlierGroup===laterGroup)why='isolation before a compound for the same muscle group';
      else if(earlierGroup==='tris'&&(laterFamily==='horizontal_press'||laterFamily==='vertical_press'))why='triceps work before a press';
      else if((earlierGroup==='bis'||earlier.pattern==='hanging_core')&&laterGroup==='back')why='biceps or grip work before a pull';
      else if(earlierGroup==='core'&&AXIAL.has(later.pattern))why='core work before a loaded lower-body or overhead lift';
      if(why)out.push(`${earlier.name} comes before ${later.name}: ${why}`);
    }
  }
  return out;
}

/* ---------- Linter ---------- */
// Checks a finished workout against every rule and returns [{rule, text}].
// An empty list means the workout passes. `lib` and `hidden` tell the linter
// what else could have been chosen, so it does not demand the impossible.
export function lintWorkout(workout,{lib=LIB,hidden=[]}={}){
  const out=[];
  const add=(rule,text)=>out.push({rule,text});
  const byId=new Map(lib.map(e=>[e.id,e]));
  const hiddenIds=new Set(hidden);
  const main=workout.sections.find(section=>section.title==='Main work');
  const items=main?main.items:[];
  const exercises=items.map(item=>byId.get(item.id));
  if(exercises.some(e=>!e)){add('unknown','An exercise is not in the library.');return out;}
  const groupName=id=>(GROUPS.find(g=>g.id===id)||{name:id}).name;
  const pool=id=>lib.filter(e=>exerciseGroupId(e)===id&&!hiddenIds.has(e.id));
  const inGroup=id=>exercises.filter(e=>exerciseGroupId(e)===id);
  const setsIn=id=>items.filter((item,index)=>exerciseGroupId(exercises[index])===id).reduce((sum,item)=>sum+item.sets,0);

  // 1. Nothing hidden, duplicated or clashing.
  exercises.filter(e=>hiddenIds.has(e.id)).forEach(e=>add('hidden',`${e.name} is hidden.`));
  if(new Set(exercises.map(e=>e.id)).size!==exercises.length)add('duplicate','An exercise appears twice.');
  exercises.forEach((e,index)=>{
    if(e.exclusive&&exercises.findIndex(other=>other.exclusive===e.exclusive)!==index)
      add('exclusive',`${e.name} duplicates another lift in this workout.`);
  });

  // 2. Every selected group is served, and a larger share never gets fewer sets.
  const selected=(workout.split||[]).filter(part=>part.pct>0);
  selected.forEach(part=>{
    if(!inGroup(part.id).length)add('served',`${part.name} has no exercise.`);
  });
  const maxedOut=id=>{
    const mine=items.filter((item,index)=>exerciseGroupId(exercises[index])===id);
    return mine.length>=compatibleCapacity(pool(id))&&mine.every(item=>item.sets>=MAX_SETS);
  };
  selected.forEach(a=>selected.forEach(b=>{
    if(a.pct>b.pct&&setsIn(a.id)<setsIn(b.id)&&!maxedOut(a.id))
      add('shares',`${a.name} was asked for more than ${b.name} but got fewer sets.`);
  }));

  // 7. Set counts.
  const total=items.reduce((sum,item)=>sum+item.sets,0);
  if(Math.abs(total-workout.budget)>1)add('budget',`${total} sets against a budget of ${workout.budget}.`);
  items.forEach(item=>{
    if(!Number.isInteger(item.sets)||item.sets<MIN_SETS||item.sets>MAX_SETS)add('sets',`${item.name} has ${item.sets} sets.`);
  });

  // 3 and 4. Coverage and pattern balance inside each muscle group.
  for(const part of selected){
    const mine=inGroup(part.id),available=pool(part.id);
    const count=pattern=>mine.filter(e=>e.pattern===pattern).length;
    const rule=COVERAGE[part.id];
    if(rule&&mine.length>=rule.min){
      const missing=rule.need.some(patterns=>
        !mine.some(e=>patterns.includes(e.pattern))&&available.some(e=>patterns.includes(e.pattern)));
      if(missing)add('coverage',`${part.name} should include ${rule.text}.`);
    }
    for(const pattern of new Set(mine.map(e=>e.pattern))){
      if(count(pattern)<=PATTERN_REPEAT_LIMIT)continue;
      // Excused when no other pattern could have taken the place of the extra one.
      const extra=[...mine].reverse().find(e=>e.pattern===pattern);
      const rest=exercises.filter(e=>e!==extra);
      const alternative=available.some(e=>!exercises.includes(e)&&count(e.pattern)<PATTERN_REPEAT_LIMIT&&
        canShareWorkout(e,rest)&&hingeOk([...rest,e])&&pressStackOk([...rest,e])&&
        highFatigueCount([...rest,e])<=Math.max(fatigueCap(exercises.length,workout.feel),highFatigueCount(exercises)));
      if(alternative)add('pattern-cap',`${part.name} repeats one movement pattern ${count(pattern)} times.`);
    }
  }

  // 5. Session caps across groups.
  if(!hingeOk(exercises))add('hinge','More than one deadlift-type lift.');
  if(!pressStackOk(exercises))add('press-stack','Too much overhead pressing on top of the chest presses.');
  const cap=fatigueCap(exercises.length,workout.feel);
  if(highFatigueCount(exercises)>cap)add('fatigue',`${highFatigueCount(exercises)} high-fatigue lifts; this session should have at most ${cap}.`);

  // 6. Order within muscle chains.
  orderViolations(exercises).forEach(text=>add('order',text));
  return out;
}
