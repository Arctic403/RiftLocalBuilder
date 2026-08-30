const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,v));
const ratio=(a,b,fallback=0)=>b?Number(a||0)/Number(b):fallback;
const boxDims=op=>[
  Number(op?.max?.[0]??0)-Number(op?.min?.[0]??0)+1,
  Number(op?.max?.[1]??0)-Number(op?.min?.[1]??0)+1,
  Number(op?.max?.[2]??0)-Number(op?.min?.[2]??0)+1
];
const fillOps=document=>(document?.ops||[]).filter(op=>String(op?.op||'').toLowerCase()==='fill_box');
const roleOf=op=>String(op?._semanticRole||'').toLowerCase();
const groupOf=op=>String(op?._semanticGroup||'');
const scoreLabel=score=>score>=85?'rich':score>=70?'developed':score>=55?'basic':'shell';
const round=(n,d=1)=>{const p=10**d;return Math.round(Number(n||0)*p)/p};

function roomRect(room){
  const local=room?.local;
  if(local?.min&&local?.max)return {
    width:Number(local.max[0])-Number(local.min[0])+1,
    depth:Number(local.max[2])-Number(local.min[2])+1
  };
  if(room?.min&&room?.max)return {
    width:Number(room.max[0])-Number(room.min[0])+1,
    depth:Number(room.max[1])-Number(room.min[1])+1
  };
  return null;
}
function dominantRatio(values){
  if(!values.length)return 0;
  const counts=new Map();
  for(const value of values)counts.set(value,(counts.get(value)||0)+1);
  return Math.max(...counts.values())/values.length;
}
function floorFootprints(ops){
  const groups=new Map();
  for(const op of ops){
    if(roleOf(op)!=='floor')continue;
    const y=Number(op?.min?.[1]??0);
    const group=groups.get(y)||[];
    group.push(op);groups.set(y,group);
  }
  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).map(([y,rows])=>{
    const minX=Math.min(...rows.map(op=>Number(op.min[0])));
    const maxX=Math.max(...rows.map(op=>Number(op.max[0])));
    const minZ=Math.min(...rows.map(op=>Number(op.min[2])));
    const maxZ=Math.max(...rows.map(op=>Number(op.max[2])));
    return {y,width:maxX-minX+1,depth:maxZ-minZ+1,boundsArea:(maxX-minX+1)*(maxZ-minZ+1),boxes:rows.length};
  });
}
function paletteMaterialCount(document,ops){
  const used=new Set(ops.map(op=>String(op?.state??'')).filter(Boolean));
  let count=0;
  for(const state of used){
    const p=document?.palette?.[state];
    if(!p||Number(p.material_id)!==0)count+=1;
  }
  return count;
}
function addSignal(signals,severity,code,message,evidence={}){
  signals.push({severity,code,message,evidence});
}

export function analyzeDesignQuality(row){
  const document=row?.artifact?.document||null;
  const semantics=row?.artifact?.semantics||{};
  const program=row?.program||{};
  if(!document)return {
    format:'riftcity-design-quality-report',version:1,status:'unavailable',score:0,label:'unavailable',
    generated_at:new Date().toISOString(),signals:[{severity:'high',code:'missing-compiled-document',message:'No compiled document is available for design-quality analysis.',evidence:{}}]
  };

  const ops=fillOps(document);
  const masses=semantics?.masses||program?.building?.masses||[];
  const spaces=semantics?.interior?.spaces||semantics?.rooms||[];
  const anchors=semantics?.anchors||[];
  const entrances=semantics?.entrances||[];
  const assets=semantics?.assetInstances||[];
  const floors=semantics?.floors||[];
  const bounds=document?.bounds||semantics?.localBounds||{min:[0,0,0],max:[0,0,0]};
  const width=Number(bounds?.max?.[0]??0)-Number(bounds?.min?.[0]??0)+1;
  const height=Number(bounds?.max?.[1]??0)-Number(bounds?.min?.[1]??0)+1;
  const depth=Number(bounds?.max?.[2]??0)-Number(bounds?.min?.[2]??0)+1;
  const span=Math.max(1,width,depth);
  const heightSpan=height/span;

  const massAreas=masses.map(m=>Math.max(1,Number(m?.size?.[0]||0)*Number(m?.size?.[1]||0))).filter(Number.isFinite);
  const totalMassArea=massAreas.reduce((a,b)=>a+b,0);
  const dominantMassRatio=ratio(massAreas.length?Math.max(...massAreas):0,totalMassArea,0);
  const massFloorVariants=new Set(masses.map(m=>Number(m?.floors||0)).filter(Boolean)).size;

  const footprints=floorFootprints(ops);
  const footprintAreas=footprints.map(f=>f.boundsArea);
  const footprintVariation=footprintAreas.length>1?ratio(Math.max(...footprintAreas)-Math.min(...footprintAreas),Math.max(...footprintAreas),0):0;

  const facadeOps=ops.filter(op=>roleOf(op)==='wall'&&groupOf(op).endsWith('.facade'));
  const interiorWallOps=ops.filter(op=>roleOf(op)==='interior-wall');
  const windowOps=ops.filter(op=>roleOf(op)==='window');
  const roofOps=ops.filter(op=>roleOf(op)==='roof');
  const siteOps=ops.filter(op=>roleOf(op)==='site');
  const stairOps=ops.filter(op=>roleOf(op)==='stair');

  const windowSignatures=windowOps.map(op=>`${boxDims(op).join('x')}@${String(op?.state??'')}`);
  const dominantWindowRatio=dominantRatio(windowSignatures);
  const windowPatternCount=new Set(windowSignatures).size;
  const facadeMaterials=new Set(facadeOps.map(op=>String(op?.state??''))).size;
  const roofLevels=new Set(roofOps.map(op=>`${Number(op?.min?.[1]??0)}:${Number(op?.max?.[1]??0)}`)).size;

  const floorHeight=Number(program?.building?.floor_height||program?.building?.floorHeight||7)||7;
  const tallFacadeOps=facadeOps.filter(op=>boxDims(op)[1]>=floorHeight*3);
  const tallFacadeRatio=ratio(tallFacadeOps.length,facadeOps.length,0);

  const roomShapes=[],roomAspects=[],roomAreas=[];
  for(const room of spaces){
    const rect=roomRect(room);if(!rect)continue;
    const w=Math.max(1,rect.width),d=Math.max(1,rect.depth);
    roomShapes.push(`${Math.round(w)}x${Math.round(d)}`);
    roomAspects.push(Math.max(w,d)/Math.max(1,Math.min(w,d)));
    roomAreas.push(w*d);
  }
  const dominantRoomRatio=dominantRatio(roomShapes);
  const extremeRoomRatio=ratio(roomAspects.filter(v=>v>2.4).length,roomAspects.length,0);
  const roomShapeCount=new Set(roomShapes).size;

  const usedMaterialCount=paletteMaterialCount(document,ops);
  const anchorDensity=ratio(anchors.length,spaces.length,0);

  let massing=70;
  if(masses.length>=3)massing+=10;
  if(masses.length>=6)massing+=5;
  if(massFloorVariants>=3)massing+=5;
  if(dominantMassRatio>.72)massing-=24;
  else if(dominantMassRatio>.6)massing-=12;
  if(footprints.length>=3&&footprintVariation>.14)massing+=8;
  if(floors.length>=4&&heightSpan>.95)massing-=12;
  massing=clamp(massing);

  let facade=60;
  facade+=Math.min(18,windowOps.length*.55);
  facade+=Math.min(10,facadeMaterials*2.5);
  facade+=Math.min(8,windowPatternCount*1.2);
  if(windowOps.length<4)facade-=18;
  if(dominantWindowRatio>.65)facade-=18;
  else if(dominantWindowRatio>.55)facade-=9;
  if(tallFacadeRatio>.35)facade-=15;
  else if(tallFacadeRatio>.2)facade-=8;
  facade=clamp(facade);

  let roof=50+Math.min(24,roofLevels*4)+Math.min(16,roofOps.length*.8);
  if(!roofOps.length)roof=30;
  else if(roofLevels<=1)roof-=18;
  roof=clamp(roof);

  let interior=68;
  interior+=Math.min(10,roomShapeCount*.6);
  interior-=Math.min(24,extremeRoomRatio*55);
  if(dominantRoomRatio>.6)interior-=18;
  else if(dominantRoomRatio>.45)interior-=8;
  if(spaces.length>=8&&interiorWallOps.length<spaces.length)interior-=8;
  interior=clamp(interior);

  let detail=32;
  detail+=Math.min(28,assets.length*2.5);
  detail+=Math.min(17,anchors.length*1.25);
  detail+=Math.min(13,usedMaterialCount*.9);
  detail+=Math.min(10,stairOps.length?6:0);
  if(spaces.length>=6&&assets.length===0)detail=Math.min(detail,52);
  detail=clamp(detail);

  let site=42+Math.min(38,siteOps.length*2.7)+Math.min(20,entrances.length*4.5);
  if(siteOps.length===0)site=35;
  site=clamp(site);

  const categories={
    massing:round(massing),facade:round(facade),roof:round(roof),
    interior:round(interior),detail:round(detail),site:round(site)
  };
  let overall=massing*.17+facade*.18+roof*.1+interior*.17+detail*.28+site*.1;
  if(spaces.length>=8&&assets.length===0)overall=Math.min(overall,64);
  overall=round(clamp(overall));

  const signals=[];
  if(spaces.length>=8&&assets.length===0)addSignal(signals,'high','no-asset-instances','The compiled building has no asset instances, so visual review is mostly architectural shell geometry rather than a dressed interior/exterior.',{spaces:spaces.length,asset_instances:0});
  if(dominantMassRatio>.6)addSignal(signals,'medium','dominant-primary-mass','One mass carries most of the combined mass footprint and can make the silhouette read as one large block even when wings are present.',{dominant_mass_ratio:round(dominantMassRatio,3),mass_count:masses.length});
  if(tallFacadeRatio>.2)addSignal(signals,'medium','multi-floor-facade-spans','A noticeable share of facade boxes span three or more floor heights, which can create long uninterrupted vertical wall bands.',{tall_facade_ratio:round(tallFacadeRatio,3),tall_facade_boxes:tallFacadeOps.length,facade_boxes:facadeOps.length});
  if(dominantWindowRatio>.55)addSignal(signals,'medium','repetitive-window-modules','Most windows reuse the same module size/material. More facade rhythm variation may improve the exterior read.',{dominant_window_pattern_ratio:round(dominantWindowRatio,3),window_patterns:windowPatternCount,windows:windowOps.length});
  if(dominantRoomRatio>.45)addSignal(signals,'medium','repetitive-room-footprints','Many rooms share the same footprint dimensions, which can make upper floors feel copied rather than authored.',{dominant_room_shape_ratio:round(dominantRoomRatio,3),room_shapes:roomShapeCount,rooms:spaces.length});
  if(extremeRoomRatio>.18)addSignal(signals,'medium','extreme-room-aspect-ratios','Several semantic rooms are unusually long or narrow and deserve visual review.',{extreme_room_ratio:round(extremeRoomRatio,3),rooms:spaces.length});
  if(roofOps.length&&roofLevels<=1&&floors.length>=2)addSignal(signals,'medium','flat-roof-language','The roof uses a single elevation across a multi-floor building, so the roof silhouette may read flat.',{roof_levels:roofLevels,roof_boxes:roofOps.length});
  if(siteOps.length<3)addSignal(signals,'low','thin-site-treatment','The site has very few explicit site-geometry operations.',{site_boxes:siteOps.length,entrances:entrances.length});
  if(facadeMaterials<=1&&facadeOps.length>8)addSignal(signals,'low','single-facade-material','The facade is dominated by one material state.',{facade_materials:facadeMaterials,facade_boxes:facadeOps.length});

  signals.sort((a,b)=>({high:0,medium:1,low:2}[a.severity]??3)-({high:0,medium:1,low:2}[b.severity]??3));
  const priorities=signals.slice(0,5).map(s=>s.code);
  const status=overall>=78&&signals.every(s=>s.severity!=='high')?'design-strong':overall>=62?'review-recommended':'detail-pass-needed';

  return {
    format:'riftcity-design-quality-report',
    version:1,
    analyzer:'geometry-semantic-heuristics-v1',
    status,
    score:overall,
    label:scoreLabel(overall),
    generated_at:new Date().toISOString(),
    candidate_sha256:row?.publicResult?.candidate_sha256||null,
    compiled_document_sha256:row?.publicResult?.compiled_document_sha256||null,
    categories,
    metrics:{
      bounds:{width:round(width),height:round(height),depth:round(depth),height_to_span:round(heightSpan,3)},
      massing:{masses:masses.length,dominant_mass_ratio:round(dominantMassRatio,3),mass_floor_variants:massFloorVariants,floor_footprint_variation:round(footprintVariation,3),floor_footprints:footprints},
      facade:{facade_boxes:facadeOps.length,windows:windowOps.length,window_patterns:windowPatternCount,dominant_window_pattern_ratio:round(dominantWindowRatio,3),facade_materials:facadeMaterials,tall_facade_ratio:round(tallFacadeRatio,3)},
      roof:{roof_boxes:roofOps.length,roof_levels:roofLevels},
      interior:{spaces:spaces.length,room_shapes:roomShapeCount,dominant_room_shape_ratio:round(dominantRoomRatio,3),extreme_room_ratio:round(extremeRoomRatio,3),interior_wall_boxes:interiorWallOps.length},
      detail:{asset_instances:assets.length,anchors:anchors.length,anchor_density:round(anchorDensity,3),used_material_states:usedMaterialCount,stair_boxes:stairOps.length},
      site:{site_boxes:siteOps.length,entrances:entrances.length}
    },
    priorities,
    signals,
    note:'Heuristic design telemetry is not a substitute for image review. It highlights likely shell/detail/repetition issues so the AI handoff can prioritize the right visual checks.'
  };
}
