/* ==========================================================================
   Emergency Department Simulator — PLAN
   Floorplan annotation: zones, nodes, routes, roles, scale.
   Geometry is stored in floorplan-image pixels; metres are derived through the
   scale when one is set, so a plan stays valid whether or not it is measured.
   ========================================================================== */
(function(){
  "use strict";

  var $ = function(s){ return document.querySelector(s); };
  var uid = function(p){ return p + Math.random().toString(36).slice(2,8) + (Date.now()%1000); };

  /* ---------- presets ---------- */
  var ASSETS = "assets/";                   // bundled art lives here
  var TEMPLATE_MAP = ASSETS + "template_map.png";
  var PALETTE = NUHS.PALETTE;               // red, orange, green, cyan, silver
  var C = { red:"#E4002B", orange:"#F7941D", green:"#2FBF71", cyan:"#00A9E0", silver:"#7D8CB3" };

  var ROLE_DEFS = [
    { id:"doctor",     label:"Doctor",     color:"#1A83D4", staffing:25,  unit:"staff", icon:ASSETS + "icons/icon-doctor.png" },
    { id:"nurse",      label:"Nurse",      color:"#00A9E0", staffing:8,   unit:"staff", icon:ASSETS + "icons/icon-nurse.png" },
    { id:"consultant", label:"Consultant", color:"#F7941D", staffing:6,   unit:"staff", icon:ASSETS + "icons/icon-ops.png" },
    { id:"patient",    label:"Patient",    color:"#2FBF71", staffing:312, unit:"/ day", icon:ASSETS + "icons/icon-patient.png" },
    { id:"porter",     label:"Porter",     color:"#7D8CB3", staffing:5,   unit:"staff", icon:ASSETS + "icons/icon-porter.png" },
    { id:"other",      label:"Other",      color:"#A8BAD0", staffing:4,   unit:"staff", icon:ASSETS + "icons/icon-other.png" }
  ];

  /* Rooms drawn on the bundled template map (1200x760), so Skip lands on a working plan. */
  var TEMPLATE_ZONES = [
    { name:"Waiting Room",    x:60,  y:60,  w:240, h:200, color:C.silver, capacity:40 },
    { name:"Triage",          x:320, y:60,  w:180, h:120, color:C.cyan,   capacity:4 },
    { name:"P1 Resus",        x:520, y:60,  w:260, h:200, color:C.red,    capacity:4 },
    { name:"P2 Majors",       x:800, y:60,  w:340, h:200, color:C.orange, capacity:30 },
    { name:"Registration",    x:60,  y:300, w:300, h:180, color:C.silver, capacity:4 },
    { name:"P3 Ambulatory",   x:380, y:300, w:400, h:180, color:C.green,  capacity:40 },
    { name:"EDTU",            x:800, y:300, w:340, h:180, color:C.cyan,   capacity:12 },
    { name:"Imaging / X-Ray", x:60,  y:520, w:300, h:180, color:C.silver, capacity:2 },
    { name:"Store",           x:380, y:520, w:240, h:180, color:C.silver, capacity:1 },
    { name:"Meds",            x:640, y:520, w:220, h:180, color:C.silver, capacity:1 },
    { name:"Ward Lift",       x:880, y:520, w:260, h:180, color:C.silver, capacity:8 }
  ];

  var FINISH_LABEL =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 7"/></svg> Finish';

  var LS_KEY = "nuhs-ed-plan-v1";
  var FILE_REF_KEY = "nuhs-ed-plan-file-ref-v1";
  var FIRESTORE_COLLECTION = "planFiles";
  var FIREBASE_SDK_VERSION = "8.10.1";

  /* ---------- state ---------- */
  var state = {
    map:null,                 // {name, dataUrl, width, height, isTemplate}
    mapOpacity:1,
    scale:null,               // {ax,ay,bx,by,meters}
    zones:[], nodes:[], routes:[],
    roles: ROLE_DEFS.map(function(r){ return Object.assign({}, r); }),
    layers:{ zones:true, nodes:true, routes:true, grid:false },
    view:{ k:1, x:0, y:0 },
    mode:"zones",             // zones | routes
    listTab:"zones",          // zones | nodes
    selectedId:null,
    hoverId:null,
    selectedRole:"doctor",
    stepsDone:{ zone:false, node:false, route:false /*, roles:false */ },
    coachStep:0               // 0 = not running, 1..3
  };

  var img = null;             // HTMLImageElement of the floorplan
  var tool = "select";        // select | pan
  var draft = null;           // in-progress drawing
  var roleIconImages = {};
  var routeAgents = [];
  var simLastTs = null;
  var activeImportModal = null;
  var currentFileRef = { id:null, filename:null };
  var firestorePromise = null;

  /* ---------- geometry helpers ---------- */
  function metersPerPixel(){
    if(!state.scale) return null;
    var dx = state.scale.bx - state.scale.ax, dy = state.scale.by - state.scale.ay;
    var px = Math.hypot(dx, dy);
    return px > 0 ? state.scale.meters / px : null;
  }
  function rectPts(x0,y0,x1,y1){
    return [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
  }
  function polyCentroid(pts){
    var x=0, y=0;
    pts.forEach(function(p){ x+=p.x; y+=p.y; });
    return { x:x/pts.length, y:y/pts.length };
  }
  function polyBounds(pts){
    var xs = pts.map(function(p){return p.x;}), ys = pts.map(function(p){return p.y;});
    return { x0:Math.min.apply(null,xs), y0:Math.min.apply(null,ys),
             x1:Math.max.apply(null,xs), y1:Math.max.apply(null,ys) };
  }
  function pointInPoly(p, pts){
    var inside = false;
    for(var i=0, j=pts.length-1; i<pts.length; j=i++){
      var xi=pts[i].x, yi=pts[i].y, xj=pts[j].x, yj=pts[j].y;
      if(((yi>p.y)!==(yj>p.y)) && (p.x < (xj-xi)*(p.y-yi)/(yj-yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function dist2seg(p,a,b){
    var vx=b.x-a.x, vy=b.y-a.y, wx=p.x-a.x, wy=p.y-a.y;
    var L=vx*vx+vy*vy;
    var t = L ? Math.max(0, Math.min(1,(wx*vx+wy*vy)/L)) : 0;
    return Math.hypot(p.x-(a.x+t*vx), p.y-(a.y+t*vy));
  }
  function zoneById(id){ return state.zones.find(function(z){ return z.id===id; }) || null; }
  function nodeById(id){ return state.nodes.find(function(n){ return n.id===id; }) || null; }
  function routeById(id){ return state.routes.find(function(r){ return r.id===id; }) || null; }
  function roleById(id){ return state.roles.find(function(r){ return r.id===id; }) || state.roles[0]; }

  function destinationLabel(destination){
    if(!destination) return "End";
    if(destination.targetType === "node"){
      var n = nodeById(destination.targetId);
      return n ? n.name : "(deleted node)";
    }
    var z = zoneById(destination.targetId);
    return z ? z.name : "(deleted zone)";
  }
  function routeSections(r){ return r.sections || legacyStopsToSections(r.stops || []); }
  function sectionAcceptsDwell(section){ return !!section.destination; }
  function routeAllPoints(r){
    return routeSections(r).reduce(function(points, section){
      return points.concat((section.waypoints || []).map(function(p){
        return { x:Number(p.x)||0, y:Number(p.y)||0 };
      }));
    }, []);
  }
  function routeTotalMin(r){
    return routeSections(r).reduce(function(sum, section){
      return sum + (sectionAcceptsDwell(section) ? (Number(section.dwellMin)||0) : 0);
    }, 0);
  }
  function routePixels(r){
    var pts = routeAllPoints(r), d = 0;
    for(var i=1;i<pts.length;i++) d += Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
    if(r.isLoop && pts.length > 2){
      var a = pts[pts.length-1], b = pts[0];
      d += Math.hypot(b.x-a.x, b.y-a.y);
    }
    return d;
  }
  function routeMeters(r){
    var mpp = metersPerPixel();
    return mpp == null ? null : routePixels(r) * mpp;
  }
  function nearestNodeId(x,y){
    var best = null, bestD = Infinity;
    state.nodes.forEach(function(n){
      var d = Math.hypot(n.x-x, n.y-y);
      if(d < bestD){ bestD = d; best = n; }
    });
    return best ? best.id : null;
  }
  function nearestZoneFor(x,y){
    var hit = null;
    state.zones.forEach(function(z){ if(pointInPoly({x:x,y:y}, z.pts)) hit = z; });
    if(hit) return hit.id;
    var best = null, bestD = Infinity;
    state.zones.forEach(function(z){
      var c = polyCentroid(z.pts), d = Math.hypot(c.x-x, c.y-y);
      if(d < bestD){ bestD = d; best = z; }
    });
    return best ? best.id : null;
  }
  function targetPoint(destination){
    if(!destination) return null;
    if(destination.targetType === "node"){
      var n = nodeById(destination.targetId);
      return n ? { x:n.x, y:n.y } : null;
    }
    var z = zoneById(destination.targetId);
    return z ? polyCentroid(z.pts) : null;
  }
  function legacyStopsToSections(stops){
    var sections = [];
    if(!stops || stops.length < 2) return sections;
    for(var i=1;i<stops.length;i++){
      var a = targetPoint(stops[i-1]) || { x:stops[i-1].x||0, y:stops[i-1].y||0 };
      var b = targetPoint(stops[i]) || { x:stops[i].x||0, y:stops[i].y||0 };
      sections.push({
        id: uid("sec_"),
        waypoints: i === 1 ? [a, b] : [b],
        destination: { targetType:stops[i].targetType || "node", targetId:stops[i].targetId },
        dwellMin: Number(stops[i].waitMin)||0
      });
    }
    return sections;
  }
  function sectionLabel(sections, index){
    var from = index === 0 ? "Start" : destinationLabel(sections[index-1].destination);
    return from + " to " + destinationLabel(sections[index].destination);
  }
  function sectionPixels(sections, index){
    var pts = (sections[index].waypoints || []).slice(), d = 0;
    if(index > 0){
      var prev = sections[index-1].waypoints || [];
      if(prev.length) pts.unshift(prev[prev.length-1]);
    }
    for(var i=1;i<pts.length;i++) d += Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
    return d;
  }
  function routePolyline(r){
    var pts = routeAllPoints(r);
    if(r.isLoop && pts.length > 2) pts = pts.concat([{ x:pts[0].x, y:pts[0].y }]);
    if(pts.length < 2) return null;
    var cumulative = [0], total = 0;
    for(var i=1;i<pts.length;i++){
      total += Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
      cumulative.push(total);
    }
    if(total <= 0) return null;
    var stops = [], waypointIndex = 0, sections = routeSections(r);
    sections.forEach(function(section){
      waypointIndex += (section.waypoints || []).length;
      var pointIndex = waypointIndex - 1;
      if(sectionAcceptsDwell(section) && Number(section.dwellMin) > 0 && cumulative[pointIndex] != null){
        stops.push({ distance:cumulative[pointIndex], seconds:Number(section.dwellMin) });
      }
    });
    return { points:pts, cumulative:cumulative, total:total, stops:stops };
  }
  function pointAtDistance(poly, distance){
    var d = Math.max(0, Math.min(poly.total, distance));
    for(var i=1;i<poly.cumulative.length;i++){
      if(poly.cumulative[i] >= d){
        var span = poly.cumulative[i] - poly.cumulative[i-1];
        var t = span ? (d - poly.cumulative[i-1]) / span : 0;
        var a = poly.points[i-1], b = poly.points[i];
        return { x:a.x + (b.x-a.x)*t, y:a.y + (b.y-a.y)*t };
      }
    }
    return poly.points[poly.points.length-1];
  }

  /* ---------- canvas ---------- */
  var canvas = $("#canvas"), ctx = canvas.getContext("2d");
  var cssW = 0, cssH = 0, renderQueued = false;

  function resize(){
    var r = canvas.getBoundingClientRect();
    cssW = r.width; cssH = r.height;
    var dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.max(1, Math.round(cssW*dpr));
    canvas.height = Math.max(1, Math.round(cssH*dpr));
    ctx.setTransform(dpr,0,0,dpr,0,0);
    requestRender();
  }
  new ResizeObserver(resize).observe(canvas);

  function toWorld(sx,sy){ return { x:(sx-state.view.x)/state.view.k, y:(sy-state.view.y)/state.view.k }; }
  function toScreen(wx,wy){ return { x:wx*state.view.k+state.view.x, y:wy*state.view.k+state.view.y }; }
  function evPos(e){ var r = canvas.getBoundingClientRect(); return { x:e.clientX-r.left, y:e.clientY-r.top }; }

  function fitView(){
    if(!state.map || !cssW || !cssH) return;
    var pad = 40;
    var k = Math.min((cssW-pad*2)/state.map.width, (cssH-pad*2)/state.map.height);
    state.view.k = k;
    state.view.x = (cssW - state.map.width*k)/2;
    state.view.y = (cssH - state.map.height*k)/2;
    syncZoomSlider();
    requestRender();
  }
  function zoomAt(sx, sy, factor){
    var before = toWorld(sx,sy);
    state.view.k = Math.max(0.15, Math.min(2, state.view.k*factor));
    var after = toWorld(sx,sy);
    state.view.x += (after.x-before.x)*state.view.k;
    state.view.y += (after.y-before.y)*state.view.k;
    syncZoomSlider();
    requestRender();
  }
  function setZoom(pct, anchorX, anchorY){
    var ax = anchorX == null ? cssW/2 : anchorX, ay = anchorY == null ? cssH/2 : anchorY;
    var before = toWorld(ax,ay);
    state.view.k = Math.max(0.15, Math.min(2, pct/100));
    var after = toWorld(ax,ay);
    state.view.x += (after.x-before.x)*state.view.k;
    state.view.y += (after.y-before.y)*state.view.k;
    requestRender();
  }
  function syncZoomSlider(){
    var z = $("#v-zoom");
    if(z) z.value = Math.round(state.view.k*100);
    var hz = $("#hud-zoom");
    if(hz) hz.textContent = Math.round(state.view.k*100) + "%";
  }

  function requestRender(){
    if(renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function(){ renderQueued = false; render(); });
  }

  var cssCache = {};
  function css(v){
    if(!cssCache[v]) cssCache[v] = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    return cssCache[v];
  }
  function hexA(hex, a){
    var h = String(hex).replace("#","");
    if(h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var n = parseInt(h,16);
    return "rgba(" + ((n>>16)&255) + "," + ((n>>8)&255) + "," + (n&255) + "," + a + ")";
  }

  function render(){
    if(!cssW || !cssH) return;
    ctx.clearRect(0,0,cssW,cssH);
    if(!state.map) return;

    var v = state.view;
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.k, v.k);

    // floorplan
    if(img){
      ctx.globalAlpha = state.mapOpacity;
      ctx.drawImage(img, 0, 0, state.map.width, state.map.height);
      ctx.globalAlpha = 1;
    }
    // page edge
    ctx.lineWidth = 1/v.k;
    ctx.strokeStyle = css("--border");
    ctx.strokeRect(0, 0, state.map.width, state.map.height);

    if(state.layers.grid) drawGrid();
    if(state.layers.zones) state.zones.forEach(drawZone);
    if(state.layers.routes) state.routes.forEach(drawRoute);
    if(state.layers.nodes) state.nodes.forEach(drawNode);
    if(draft) drawDraft();
    if(state.layers.routes) drawRouteAgents();

    ctx.restore();
    drawScaleBar();
  }

  function drawGrid(){
    var step = 40, v = state.view;
    ctx.save();
    ctx.strokeStyle = "rgba(168,186,208,0.10)";
    ctx.lineWidth = 1/v.k;
    ctx.beginPath();
    for(var x=0; x<=state.map.width; x+=step){ ctx.moveTo(x,0); ctx.lineTo(x,state.map.height); }
    for(var y=0; y<=state.map.height; y+=step){ ctx.moveTo(0,y); ctx.lineTo(state.map.width,y); }
    ctx.stroke();
    ctx.restore();
  }

  function drawZone(z){
    var sel = state.selectedId === z.id, hov = state.hoverId === z.id, v = state.view;
    ctx.beginPath();
    z.pts.forEach(function(p,i){ i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y); });
    ctx.closePath();
    ctx.fillStyle = hexA(z.color, sel ? 0.26 : hov ? 0.21 : 0.13);
    ctx.fill();
    ctx.lineWidth = (sel ? 3 : hov ? 2.8 : 1.8)/v.k;
    ctx.strokeStyle = z.color;
    ctx.stroke();

    var b = polyBounds(z.pts);
    ctx.save();
    ctx.scale(1/v.k, 1/v.k);
    // Chips, not bare text: an uploaded floorplan usually has its own room
    // names printed underneath, and bare labels collide with them.
    chip(b.x0*v.k + 7, b.y0*v.k + 6, z.name.toUpperCase(), z.color,
         hov ? '800 12px "Open Sans", sans-serif' : '700 11px "Open Sans", sans-serif', "left");
    chip(b.x1*v.k - 7, b.y0*v.k + 6, String(z.capacity), z.color,
         '600 10px "IBM Plex Mono", monospace', "right", true);
    ctx.restore();
  }

  /* label chip drawn in screen space; x is the left or right edge per align.
     withPerson prefixes a small figure glyph — capacity reads as people, not a word. */
  function chip(x, y, text, color, font, align, withPerson){
    ctx.font = font;
    var glyphW = withPerson ? 11 : 0;
    var w = ctx.measureText(text).width + glyphW, h = 15, padX = 5;
    var bx = align === "right" ? x - w - padX*2 : x;
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = css("--command-bg");
    var r = 3;
    ctx.beginPath();
    ctx.moveTo(bx+r, y);
    ctx.lineTo(bx+w+padX*2-r, y);       ctx.arcTo(bx+w+padX*2, y, bx+w+padX*2, y+r, r);
    ctx.lineTo(bx+w+padX*2, y+h-r);     ctx.arcTo(bx+w+padX*2, y+h, bx+w+padX*2-r, y+h, r);
    ctx.lineTo(bx+r, y+h);              ctx.arcTo(bx, y+h, bx, y+h-r, r);
    ctx.lineTo(bx, y+r);                ctx.arcTo(bx, y, bx+r, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    if(withPerson) personGlyph(bx + padX + 1, y + h/2, color);
    ctx.fillText(text, bx + padX + glyphW, y + h/2 + 0.5);
  }

  /* a tiny head-and-shoulders, drawn rather than masked so it scales with the chip */
  function personGlyph(x, cy, color){
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 3.4, cy - 2.6, 2.1, 0, Math.PI*2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 0.4, cy + 4.2);
    ctx.quadraticCurveTo(x + 0.4, cy + 0.1, x + 3.4, cy + 0.1);
    ctx.quadraticCurveTo(x + 6.4, cy + 0.1, x + 6.4, cy + 4.2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawNode(n){
    var sel = state.selectedId === n.id, hov = state.hoverId === n.id, v = state.view;
    var snap = draft && draft.kind === "route" && draft.snapId === n.id;
    var r = (sel ? 8 : (hov || snap) ? 7.5 : 6)/v.k;

    // snap ring: confirms the click will land on this node before committing
    if(snap){
      ctx.beginPath();
      ctx.arc(n.x, n.y, 13/v.k, 0, Math.PI*2);
      ctx.lineWidth = 2/v.k;
      ctx.strokeStyle = n.color;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI*2);
    ctx.fillStyle = n.color;
    ctx.fill();
    ctx.lineWidth = 2/v.k;
    ctx.strokeStyle = (sel || snap) ? "#FFFFFF" : css("--command-bg");
    ctx.stroke();

    ctx.save();
    ctx.scale(1/v.k, 1/v.k);
    chip(n.x*v.k + 10, n.y*v.k - 7.5, n.name, css("--text"),
         (hov || snap) ? '700 11.5px "Open Sans", sans-serif'
                       : '600 10.5px "Open Sans", sans-serif', "left");
    ctx.restore();
  }

  function drawRoute(r){
    var pts = routeAllPoints(r);
    if(pts.length < 2) return;
    var sel = state.selectedId === r.id, hov = state.hoverId === r.id, v = state.view;
    var col = roleById(r.roleId).color;
    ctx.beginPath();
    pts.forEach(function(p,i){ i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y); });
    if(r.isLoop && pts.length > 2) ctx.closePath();
    ctx.lineWidth = (sel ? 5 : hov ? 4.4 : 3)/v.k;
    ctx.strokeStyle = col;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.globalAlpha = (sel || hov) ? 1 : 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;

    var sections = routeSections(r);
    sections.forEach(function(section){
      var p = section.waypoints && section.waypoints.length ? section.waypoints[section.waypoints.length-1] : null;
      if(!p) return;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (sel ? 5.5 : hov ? 5.2 : 4.5)/v.k, 0, Math.PI*2);
      ctx.fillStyle = sectionAcceptsDwell(section) ? "#FFFFFF" : col;
      ctx.fill();
      ctx.lineWidth = 1.6/v.k;
      ctx.strokeStyle = sectionAcceptsDwell(section) ? col : css("--command-bg");
      ctx.stroke();
    });

    // direction arrows at each leg midpoint
    for(var i=1;i<pts.length;i++){
      var a = pts[i-1], b = pts[i];
      arrow((a.x+b.x)/2, (a.y+b.y)/2, Math.atan2(b.y-a.y, b.x-a.x), (sel?8:hov?7:6)/v.k, col);
    }
    if(r.isLoop && pts.length > 2){
      var la = pts[pts.length-1], lb = pts[0];
      arrow((la.x+lb.x)/2, (la.y+lb.y)/2, Math.atan2(lb.y-la.y, lb.x-la.x), (sel?8:hov?7:6)/v.k, col);
    }
    if(sel) drawRouteHandles(r, col);
  }
  function arrow(x,y,ang,size,col){
    ctx.save();
    ctx.translate(x,y); ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(size,0); ctx.lineTo(-size*0.7, size*0.6); ctx.lineTo(-size*0.7, -size*0.6);
    ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
    ctx.restore();
  }
  function drawRouteHandles(r, col){
    var v = state.view, sections = routeSections(r);
    sections.forEach(function(section){
      (section.waypoints || []).forEach(function(p, i){
        var bound = sectionAcceptsDwell(section) && i === section.waypoints.length - 1;
        var dragging = draggingWaypoint && draggingWaypoint.routeId === r.id &&
                       draggingWaypoint.sectionId === section.id && draggingWaypoint.index === i;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (dragging ? 9 : bound ? 7 : 6)/v.k, 0, Math.PI*2);
        ctx.fillStyle = bound ? "#FFFFFF" : col;
        ctx.fill();
        ctx.lineWidth = (dragging ? 2.6 : 2.1)/v.k;
        ctx.strokeStyle = bound ? col : "#FFFFFF";
        ctx.stroke();
      });
    });
  }
  function drawRouteAgents(){
    if(!routeAgents.length) return;
    routeAgents.forEach(function(agent){
      var r = routeById(agent.routeId);
      var role = r && roleById(r.roleId);
      var poly = r && routePolyline(r);
      if(!r || !role || !poly) return;
      drawRoleAvatar(pointAtDistance(poly, agent.distance), role);
    });
  }
  function drawRoleAvatar(p, role){
    var screen = toScreen(p.x, p.y), circle = 20, icon = 14;
    ctx.save();
    ctx.setTransform(window.devicePixelRatio||1, 0, 0, window.devicePixelRatio||1, 0, 0);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, circle/2, 0, Math.PI*2);
    ctx.fillStyle = role.color;
    ctx.shadowColor = "rgba(0,0,0,.35)";
    ctx.shadowBlur = 4;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "#FFFFFF";
    ctx.stroke();
    var im = roleIconImages[role.id];
    if(im && im.complete && im.naturalWidth){
      ctx.drawImage(im, screen.x - icon/2, screen.y - icon/2, icon, icon);
    } else {
      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.arc(screen.x, screen.y - 3, 2.4, 0, Math.PI*2);
      ctx.fill();
      ctx.fillRect(screen.x - 3.2, screen.y, 6.4, 5);
    }
    ctx.restore();
  }

  /* Pick a round distance whose bar lands near targetPx wide. */
  function niceScaleSpan(mpp, pxPerWorld, targetPx){
    var steps = [0.5,1,2,5,10,20,25,50,100,200,250,500,1000];
    var chosen = steps[0];
    for(var i=0;i<steps.length;i++){
      if((steps[i]/mpp)*pxPerWorld <= targetPx) chosen = steps[i];
      else break;
    }
    return chosen;
  }

  /* A map-style scale bar in the stage's bottom-right, drawn in screen space so
     it stays a constant size as you zoom. Replaces the calibration line, which
     was only ever a gesture, not information. */
  function drawScaleBar(){
    var mpp = metersPerPixel();
    if(mpp == null) return;
    var meters = niceScaleSpan(mpp, state.view.k, 150);
    var w = (meters/mpp) * state.view.k;
    if(!isFinite(w) || w < 12) return;

    var x1 = cssW - 22, x0 = x1 - w, y = cssH - 26;
    ctx.save();
    ctx.setTransform(window.devicePixelRatio||1, 0, 0, window.devicePixelRatio||1, 0, 0);

    ctx.font = '600 10.5px "IBM Plex Mono", monospace';
    var label = meters >= 1 ? meters + " m" : (meters*100) + " cm";
    var tw = ctx.measureText(label).width;

    ctx.globalAlpha = 0.82;
    ctx.fillStyle = css("--command-bg");
    ctx.fillRect(x0 - 10, y - 20, w + 20, 32);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = css("--text-dim");
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x0, y - 5); ctx.lineTo(x0, y + 3);
    ctx.moveTo(x0, y);     ctx.lineTo(x1, y);
    ctx.moveTo(x1, y - 5); ctx.lineTo(x1, y + 3);
    ctx.stroke();

    ctx.fillStyle = css("--text");
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(label, (x0 + x1)/2, y - 6);
    ctx.restore();
  }

  function drawDraft(){
    var v = state.view;
    ctx.save();
    ctx.lineWidth = 2/v.k;
    ctx.setLineDash([7/v.k, 5/v.k]);

    if(draft.kind === "zone-rect" && draft.a && draft.b){
      var x0 = Math.min(draft.a.x, draft.b.x), y0 = Math.min(draft.a.y, draft.b.y);
      var w = Math.abs(draft.b.x-draft.a.x), h = Math.abs(draft.b.y-draft.a.y);
      ctx.strokeStyle = draft.color || css("--nuhs-cyan");
      ctx.fillStyle = hexA(draft.color || "#00A9E0", 0.14);
      ctx.fillRect(x0,y0,w,h);
      ctx.strokeRect(x0,y0,w,h);
    }
    else if(draft.kind === "zone-poly" && draft.pts.length){
      ctx.strokeStyle = draft.color || css("--nuhs-cyan");
      ctx.beginPath();
      draft.pts.forEach(function(p,i){ i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y); });
      if(draft.hover) ctx.lineTo(draft.hover.x, draft.hover.y);
      ctx.stroke();
      ctx.setLineDash([]);
      draft.pts.forEach(function(p){
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5/v.k, 0, Math.PI*2);
        ctx.fillStyle = "#fff"; ctx.fill();
        ctx.lineWidth = 2/v.k; ctx.strokeStyle = draft.color || css("--nuhs-cyan"); ctx.stroke();
      });
    }
    else if(draft.kind === "route"){
      ctx.strokeStyle = draft.color || css("--nuhs-cyan");
      if(draft.points.length){
        ctx.beginPath();
        draft.points.forEach(function(p,i){ i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y); });
        if(draft.hover){
          var last = draft.points[draft.points.length-1];
          ctx.moveTo(last.x,last.y); ctx.lineTo(draft.hover.x, draft.hover.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        draft.points.forEach(function(p){
          ctx.beginPath();
          ctx.arc(p.x,p.y, 5/v.k, 0, Math.PI*2);
          ctx.fillStyle = p.destination ? "#FFFFFF" : (draft.color || css("--nuhs-cyan")); ctx.fill();
          ctx.lineWidth = 1.8/v.k;
          ctx.strokeStyle = draft.color || css("--nuhs-cyan"); ctx.stroke();
        });
      }
    }
    else if(draft.kind === "scale" && draft.a){
      ctx.strokeStyle = css("--nuhs-cyan");
      ctx.beginPath();
      ctx.moveTo(draft.a.x, draft.a.y);
      var e = draft.b || draft.hover;
      if(e){ ctx.lineTo(e.x, e.y); ctx.stroke(); }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  /* ---------- hit testing ---------- */
  function hitTest(w){
    var tol = 8/state.view.k;
    for(var i=state.nodes.length-1;i>=0;i--){
      var n = state.nodes[i];
      if(state.layers.nodes && Math.hypot(n.x-w.x, n.y-w.y) <= Math.max(8/state.view.k, 7)) return n;
    }
    if(state.layers.routes){
      for(var r=state.routes.length-1;r>=0;r--){
        var rt = state.routes[r];
        var pts = routeAllPoints(rt);
        for(var s=1;s<pts.length;s++){
          if(dist2seg(w, pts[s-1], pts[s]) <= tol) return rt;
        }
        if(rt.isLoop && pts.length > 2 && dist2seg(w, pts[pts.length-1], pts[0]) <= tol){
          return rt;
        }
      }
    }
    if(state.layers.zones){
      for(var z=state.zones.length-1;z>=0;z--){
        if(pointInPoly(w, state.zones[z].pts)) return state.zones[z];
      }
    }
    return null;
  }
  function hitTarget(w){
    var tol = Math.max(18/state.view.k, 10);   // ~18 screen px, comfortable at any zoom
    var best = null, bestD = Infinity;
    state.nodes.forEach(function(n){
      var d = Math.hypot(n.x-w.x, n.y-w.y);
      if(d <= tol && d < bestD){ bestD = d; best = n; }
    });
    if(best) return { targetType:"node", targetId:best.id };
    for(var z=state.zones.length-1;z>=0;z--){
      if(pointInPoly(w, state.zones[z].pts)) return { targetType:"zone", targetId:state.zones[z].id };
    }
    return null;
  }
  function waypointHit(w){
    if(!state.selectedId) return null;
    var r = routeById(state.selectedId);
    if(!r) return null;
    var tol = Math.max(16/state.view.k, 8), sections = routeSections(r);
    for(var si=sections.length-1;si>=0;si--){
      var pts = sections[si].waypoints || [];
      for(var pi=pts.length-1;pi>=0;pi--){
        if(Math.hypot(pts[pi].x-w.x, pts[pi].y-w.y) <= tol){
          return { routeId:r.id, sectionId:sections[si].id, sectionIndex:si, index:pi };
        }
      }
    }
    return null;
  }
  function kindOf(o){
    if(!o) return null;
    if(state.zones.indexOf(o) !== -1) return "zone";
    if(state.nodes.indexOf(o) !== -1) return "node";
    if(state.routes.indexOf(o) !== -1) return "route";
    return null;
  }

  /* ---------- pointer interaction ---------- */
  var panning = null, spaceDown = false;
  var draggingWaypoint = null;

  canvas.addEventListener("pointerdown", function(e){
    if(!state.map) return;
    canvas.setPointerCapture(e.pointerId);
    var sp = evPos(e), w = toWorld(sp.x, sp.y);

    if(tool === "pan" || spaceDown || e.button === 1){
      panning = { sx:sp.x, sy:sp.y, vx:state.view.x, vy:state.view.y };
      return;
    }
    var handle = !draft ? waypointHit(w) : null;
    if(handle){
      draggingWaypoint = handle;
      return;
    }
    if(draft){
      if(draft.kind === "zone-rect"){ draft.a = w; draft.b = w; draft.dragging = true; }
      else if(draft.kind === "zone-poly"){ draft.pts.push(w); updateDrawbar(); }
      else if(draft.kind === "node"){ finishNode(w); }
      else if(draft.kind === "scale"){
        if(!draft.a) draft.a = w;
        else { draft.b = w; promptScale(); }
      }
      else if(draft.kind === "route"){
        if(e.detail > 1 || pendingSection) return;
        var t = hitTarget(w);
        addRoutePoint(w, t);
      }
      requestRender();
      return;
    }
    // select
    var hit = hitTest(w);
    state.selectedId = hit ? hit.id : null;
    if(hit){
      var k = kindOf(hit);
      if(k === "route" && state.mode !== "routes") setMode("routes");
      else if((k === "zone" || k === "node") && state.mode !== "zones") setMode("zones");
      if(k === "node") state.listTab = "nodes";
      if(k === "zone") state.listTab = "zones";
    }
    refreshRail();
    requestRender();
  });

  canvas.addEventListener("pointermove", function(e){
    if(!state.map) return;
    var sp = evPos(e), w = toWorld(sp.x, sp.y);
    if(panning){
      state.view.x = panning.vx + (sp.x - panning.sx);
      state.view.y = panning.vy + (sp.y - panning.sy);
      requestRender();
      return;
    }
    if(draggingWaypoint){
      moveRouteWaypoint(draggingWaypoint, w);
      requestRender();
      return;
    }
    if(draft){
      if(draft.kind === "zone-rect" && draft.dragging) draft.b = w;
      else draft.hover = w;
      if(draft.kind === "route"){
        var t = hitTarget(w);
        var id = t ? t.targetType + ":" + t.targetId : null;
        if(id !== draft.snapId){ draft.snapId = id; setHover(null); }
        canvas.style.cursor = id ? "pointer" : "crosshair";
      }
      requestRender();
    } else if(tool !== "pan" && !spaceDown){
      var wh = waypointHit(w), hit = hitTest(w);
      setHover(hit ? hit.id : null);
      canvas.style.cursor = wh ? "grab" : hit ? "pointer" : "default";
    }
    var hx = $("#hud-extra");
    if(hx) hx.textContent = Math.round(w.x) + ", " + Math.round(w.y);
  });

  canvas.addEventListener("pointerleave", function(){ setHover(null); });

  /* one hover id drives both the canvas and the list, in either direction */
  function setHover(id){
    if(state.hoverId === id) return;
    state.hoverId = id;
    syncListHover();
    requestRender();
  }
  function syncListHover(){
    var wrap = $("#listwrap");
    if(!wrap) return;
    wrap.querySelectorAll(".item").forEach(function(el){
      el.classList.toggle("hov", !!state.hoverId && el.dataset.id === state.hoverId);
    });
  }

  canvas.addEventListener("pointerup", function(e){
    if(panning){ panning = null; return; }
    if(draggingWaypoint){
      var sp = evPos(e), w = toWorld(sp.x, sp.y);
      settleRouteWaypoint(draggingWaypoint, w);
      draggingWaypoint = null;
      canvas.style.cursor = "default";
      persist(); refreshRail(); requestRender();
      return;
    }
    if(draft && draft.kind === "zone-rect" && draft.dragging){
      draft.dragging = false;
      var a = draft.a, b = draft.b;
      if(Math.abs(a.x-b.x) > 6 && Math.abs(a.y-b.y) > 6){
        finishZone(rectPts(Math.min(a.x,b.x), Math.min(a.y,b.y), Math.max(a.x,b.x), Math.max(a.y,b.y)), "rect");
      } else {
        draft.a = draft.b = null;
      }
      requestRender();
    }
  });

  canvas.addEventListener("dblclick", function(e){
    if(draft && draft.kind === "zone-poly"){
      if(draft.pts.length >= 3) finishZone(draft.pts.slice(), "poly");
      else NUHS.toast("A zone needs at least 3 points", true);
      return;
    }
    if(draft && draft.kind === "route"){
      if(pendingSection){ pendingSection.finishAfter = true; return; }
      if(draft.points.length >= 2) finishRoute();
      else NUHS.toast("A route needs at least two points", true);
    }
  });

  canvas.addEventListener("wheel", function(e){
    if(!state.map) return;
    e.preventDefault();
    var sp = evPos(e);
    zoomAt(sp.x, sp.y, e.deltaY < 0 ? 1.1 : 1/1.1);
  }, { passive:false });

  window.addEventListener("keydown", function(e){
    var t = e.target.tagName;
    if(t === "INPUT" || t === "TEXTAREA" || t === "SELECT"){
      if(e.key === "Escape") e.target.blur();
      return;
    }
    if(e.code === "Space"){ spaceDown = true; canvas.style.cursor = "grab"; e.preventDefault(); }
    if(e.key === "Escape"){ cancelDraft(); state.selectedId = null; refreshRail(); requestRender(); }
    if(e.key === "Enter" && draft && draft.kind === "zone-poly" && draft.pts.length >= 3){
      finishZone(draft.pts.slice(), "poly");
    }
    if(e.key === "f" || e.key === "F") fitView();
    if((e.key === "Backspace" || e.key === "Delete") && state.selectedId){
      e.preventDefault(); deleteSelected();
    }
  });
  window.addEventListener("keyup", function(e){
    if(e.code === "Space"){ spaceDown = false; setCursor(); }
  });

  function setCursor(){
    if(draft && draft.kind === "route") canvas.style.cursor = "pointer";
    else if(draft) canvas.style.cursor = "crosshair";
    else canvas.style.cursor = (tool === "pan" || spaceDown) ? "grab" : "default";
  }

  /* ---------- popover prompts ---------- */
  function popover(html, onMount){
    var pop = document.createElement("div");
    pop.className = "pop";
    pop.innerHTML = html;
    var panel = $("#stagepanel");
    panel.appendChild(pop);
    // centre it over the stage
    pop.style.left = Math.max(12, (panel.clientWidth - pop.offsetWidth)/2) + "px";
    pop.style.top  = Math.max(64, (panel.clientHeight - pop.offsetHeight)/2 - 40) + "px";
    if(onMount) onMount(pop);
    return pop;
  }

  function namePrompt(opts){
    // opts: {title, defaultName, existingNames, defaultColor, onConfirm(name,color), onBack}
    var chosen = opts.defaultColor || PALETTE[0];
    var pop = popover(
      '<h3>' + opts.title + '</h3>' +
      '<label class="field"><span>Name</span><input type="text" id="np-name"></label>' +
      '<div class="field" style="margin-bottom:0"><span>Colour</span>' +
        '<div class="swatches" id="np-sw"></div></div>' +
      '<div class="row">' +
        '<button class="btn" id="np-back" type="button">Back</button>' +
        '<button class="btn primary" id="np-ok" type="button">Confirm</button>' +
      '</div>',
      function(p){
        var nameEl = p.querySelector("#np-name");
        nameEl.value = NUHS.uniqueName(opts.defaultName, opts.existingNames);
        var sw = p.querySelector("#np-sw");
        var swatches = PALETTE.slice();
        if(swatches.indexOf(chosen) === -1) swatches.unshift(chosen);
        swatches.forEach(function(c){
          var b = document.createElement("button");
          b.type = "button";
          b.className = "swatch" + (c === chosen ? " sel" : "");
          b.style.background = c;
          b.setAttribute("aria-label", "Colour " + c);
          b.addEventListener("click", function(){
            chosen = c;
            sw.querySelectorAll(".swatch").forEach(function(x){ x.classList.remove("sel"); });
            b.classList.add("sel");
          });
          sw.appendChild(b);
        });
        p.querySelector("#np-ok").addEventListener("click", function(){
          var nm = nameEl.value.trim() || opts.defaultName;
          nm = NUHS.uniqueName(nm, opts.existingNames.filter(function(x){ return x !== nm; }).concat(
               opts.existingNames.indexOf(nm) !== -1 ? [nm] : []));
          p.remove();
          opts.onConfirm(nm, chosen);
        });
        p.querySelector("#np-back").addEventListener("click", function(){
          p.remove();
          if(opts.onBack) opts.onBack();
        });
        nameEl.focus(); nameEl.select();
        nameEl.addEventListener("keydown", function(e){
          if(e.key === "Enter"){ e.preventDefault(); p.querySelector("#np-ok").click(); }
        });
      }
    );
    return pop;
  }

  /* ---------- zone creation ---------- */
  function startZone(shape){
    draft = { kind: shape === "rect" ? "zone-rect" : "zone-poly", pts:[], color:PALETTE[0] };
    showDrawbar("zone", shape);
    setCursor();
    requestRender();
  }
  function finishZone(pts, shape){
    var pending = { pts:pts, shape:shape };
    draft = null;
    hideDrawbar();
    setCursor();
    namePrompt({
      title:"Name new zone",
      defaultName:"New Zone",
      existingNames: state.zones.map(function(z){ return z.name; }),
      onConfirm: function(name, color){
        var z = { id:uid("z_"), name:name, color:color, capacity:20,
                  shape:pending.shape, pts:pending.pts };
        state.zones.push(z);
        state.selectedId = z.id;
        state.listTab = "zones";
        state.stepsDone.zone = true;
        persist(); refreshRail(); requestRender();
        advanceCoach(1);
      },
      onBack: function(){ startZone(pending.shape); }
    });
  }

  /* ---------- node creation ---------- */
  function startNode(){
    draft = { kind:"node" };
    showDrawbar("node");
    setCursor();
  }
  function finishNode(w){
    draft = null; hideDrawbar(); setCursor();
    var host = zoneById(nearestZoneFor(w.x, w.y));
    namePrompt({
      title:"Name new node",
      defaultName:"New Node",
      defaultColor: host ? host.color : null,
      existingNames: state.nodes.map(function(n){ return n.name; }),
      onConfirm: function(name, color){
        var n = { id:uid("n_"), name:name, color:color, x:w.x, y:w.y,
                  zoneId: nearestZoneFor(w.x, w.y) };
        state.nodes.push(n);
        state.selectedId = n.id;
        state.listTab = "nodes";
        state.stepsDone.node = true;
        persist(); refreshRail(); requestRender();
        advanceCoach(2);
      },
      onBack: startNode
    });
  }

  /* ---------- route creation ---------- */
  var pendingSection = null;   // duration prompt currently open

  function startRoute(){
    draft = { kind:"route", points:[], color:roleById(state.roles[0].id).color };
    pendingSection = null;
    showDrawbar("route");
    setCursor();
    requestRender();
  }

  function addRoutePoint(w, t){
    if(!t){
      draft.points.push({ x:w.x, y:w.y, destination:null, dwellMin:0 });
      updateDrawbar();
      requestRender();
      return;
    }
    var name = destinationLabel(t);
    var pop = popover(
      '<h3>Arrive at ' + escapeHtml(name) + '</h3>' +
      '<label class="field" style="margin-bottom:0"><span>Dwell time (minutes)</span>' +
        '<input type="number" id="sd-min" class="num" min="0" step="1" value="0"></label>' +
      '<div class="row">' +
        '<button class="btn" id="sd-back" type="button">Back</button>' +
        '<button class="btn primary" id="sd-ok" type="button">Confirm</button>' +
      '</div>',
      function(p){
        var f = p.querySelector("#sd-min");
        f.focus(); f.select();
        function ok(){
          var m = Math.max(0, Number(f.value) || 0);
          draft.points.push({ x:w.x, y:w.y, destination:{ targetType:t.targetType, targetId:t.targetId }, dwellMin:m });
          var finishNow = pendingSection && pendingSection.finishAfter;
          pendingSection = null;
          p.remove(); updateDrawbar(); requestRender();
          if(finishNow && draft.points.length >= 2) finishRoute();
        }
        p.querySelector("#sd-ok").addEventListener("click", ok);
        p.querySelector("#sd-back").addEventListener("click", function(){
          pendingSection = null; p.remove();
        });
        f.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); ok(); } });
      }
    );
    pendingSection = { pop:pop, finishAfter:false };
  }
  function finishRoute(){
    if(!draft || draft.points.length < 2) return;
    var points = draft.points.slice();
    draft = null; pendingSection = null; hideDrawbar(); setCursor();

    var pop = popover(
      '<h3>Finish route</h3>' +
      '<label class="field"><span>Label</span><input type="text" id="rt-label"></label>' +
      '<label class="field"><span>Role</span><select id="rt-role"></select></label>' +
      '<label class="field" style="margin-bottom:0"><span>Number of agents</span>' +
        '<input type="number" id="rt-agents" class="num" min="1" max="20" step="1" value="3"></label>' +
      '<div class="row">' +
        '<button class="btn" id="rt-back" type="button">Back</button>' +
        '<button class="btn primary" id="rt-ok" type="button">Confirm</button>' +
      '</div>',
      function(p){
        var lab = p.querySelector("#rt-label");
        lab.value = NUHS.uniqueName("New Route", state.routes.map(function(r){ return r.label; }));
        var sel = p.querySelector("#rt-role");
        state.roles.forEach(function(r){
          var o = document.createElement("option");
          o.value = r.id; o.textContent = r.label;
          sel.appendChild(o);
        });
        function ok(){
          var sections = draftPointsToSections(points);
          if(!sections.length){ p.remove(); return; }
          var count = clampAgentCount(p.querySelector("#rt-agents").value);
          var r = { id:uid("r_"),
                    label: NUHS.uniqueName(lab.value.trim() || "New Route",
                                           state.routes.map(function(x){ return x.label; })),
                    roleId: sel.value, shift:"Day", isLoop:false, agentCount:count,
                    simulateRoute:false, sections:sections };
          state.routes.push(r);
          state.selectedId = r.id;
          state.stepsDone.route = true;
          p.remove();
          persist(); refreshRail(); requestRender();
          advanceCoach(3);
        }
        p.querySelector("#rt-ok").addEventListener("click", ok);
        p.querySelector("#rt-back").addEventListener("click", function(){
          p.remove();
          draft = { kind:"route", points:points, color:css("--nuhs-cyan") };
          showDrawbar("route"); updateDrawbar(); requestRender();
        });
        lab.focus(); lab.select();
      }
    );
  }
  function draftPointsToSections(points){
    var sections = [], pending = [];
    points.forEach(function(p){
      pending.push({ x:p.x, y:p.y });
      if(p.destination){
        sections.push({ id:uid("sec_"), waypoints:pending,
                        destination:{ targetType:p.destination.targetType, targetId:p.destination.targetId },
                        dwellMin:Number(p.dwellMin)||0 });
        pending = [];
      }
    });
    if(pending.length){
      sections.push({ id:uid("sec_"), waypoints:pending, destination:null, dwellMin:0 });
    }
    return sections;
  }
  function routeSectionByAddress(address){
    var r = routeById(address.routeId);
    if(!r) return null;
    var sections = routeSections(r);
    var section = sections.find(function(s){ return s.id === address.sectionId; });
    return section ? { route:r, sections:sections, section:section } : null;
  }
  function moveRouteWaypoint(address, w){
    var found = routeSectionByAddress(address);
    if(!found || !found.section.waypoints[address.index]) return;
    found.section.waypoints[address.index] = { x:w.x, y:w.y };
  }
  function settleRouteWaypoint(address, w){
    var found = routeSectionByAddress(address);
    if(!found || !found.section.waypoints[address.index]) return;
    var target = hitTarget(w);
    var isEnd = address.index === found.section.waypoints.length - 1;
    if(target){
      var snapped = target.targetType === "node" ? targetPoint(target)
                  : target.targetType === "zone" ? targetPoint(target)
                  : null;
      if(snapped) found.section.waypoints[address.index] = snapped;
      if(isEnd) found.section.destination = { targetType:target.targetType, targetId:target.targetId };
    } else if(isEnd && found.section.destination){
      found.section.destination = null;
      found.section.dwellMin = 0;
    }
    rebuildRouteAgents(found.route.id);
  }
  function clampAgentCount(v){
    var n = Math.round(Number(v)||1);
    return Math.max(1, Math.min(20, n));
  }

  /* ---------- route simulation ---------- */
  function rebuildRouteAgents(routeId){
    routeAgents = routeAgents.filter(function(a){ return a.routeId !== routeId; });
    var r = routeById(routeId), poly = r && routePolyline(r);
    if(!r || !r.simulateRoute || !poly) return;
    var count = clampAgentCount(r.agentCount || 3);
    for(var i=0;i<count;i++){
      routeAgents.push({
        id:r.id + ":" + i, routeId:r.id,
        distance: poly.total * i / count,
        forward:true, waiting:0, lastStop:null
      });
    }
  }
  function rebuildAllRouteAgents(){
    routeAgents = [];
    state.routes.forEach(function(r){ rebuildRouteAgents(r.id); });
    ensureSimLoop();
  }
  function anySimulatingRoute(){
    return state.routes.some(function(r){ return !!r.simulateRoute; });
  }
  function routeSpeedPxPerSec(){
    var mpp = metersPerPixel();
    return mpp ? (1.35 / mpp) * 20 : 80;
  }
  function ensureSimLoop(){
    if(anySimulatingRoute() && simLastTs == null) requestAnimationFrame(simLoop);
  }
  function simLoop(ts){
    if(!anySimulatingRoute()){
      simLastTs = null;
      return;
    }
    if(simLastTs == null) simLastTs = ts;
    var dt = Math.min(0.25, Math.max(0, (ts - simLastTs)/1000));
    simLastTs = ts;
    advanceRouteAgents(dt);
    requestRender();
    requestAnimationFrame(simLoop);
  }
  function advanceRouteAgents(dt){
    var speed = routeSpeedPxPerSec();
    routeAgents.forEach(function(agent){
      var r = routeById(agent.routeId), poly = r && routePolyline(r);
      if(!r || !poly) return;
      if(agent.waiting > 0){
        agent.waiting = Math.max(0, agent.waiting - dt);
        return;
      }
      var previous = agent.distance;
      agent.distance += agent.forward ? speed * dt : -speed * dt;
      var low = Math.min(previous, agent.distance), high = Math.max(previous, agent.distance);
      var stop = poly.stops.find(function(s){
        return s.distance >= low && s.distance <= high && s.distance !== agent.lastStop;
      });
      if(stop){
        agent.distance = stop.distance;
        agent.waiting = stop.seconds;
        agent.lastStop = stop.distance;
        return;
      }
      if(agent.distance >= poly.total){
        if(r.isLoop){
          agent.distance -= poly.total;
          agent.lastStop = null;
        } else {
          agent.distance = poly.total;
          agent.forward = false;
          agent.lastStop = null;
        }
      } else if(agent.distance <= 0){
        agent.distance = 0;
        agent.forward = true;
        agent.lastStop = null;
      }
    });
  }

  /* ---------- scale ---------- */
  function startScale(){
    draft = { kind:"scale", a:null, b:null };
    showDrawbar("scale");
    setCursor();
    NUHS.toast("Click two points a known distance apart");
  }
  function promptScale(){
    popover(
      '<h3>Set scale</h3>' +
      '<label class="field" style="margin-bottom:0"><span>Real distance (metres)</span>' +
        '<input type="number" id="sc-m" class="num" min="0.1" step="0.1" value="10"></label>' +
      '<div class="row">' +
        '<button class="btn" id="sc-back" type="button">Back</button>' +
        '<button class="btn primary" id="sc-ok" type="button">Confirm</button>' +
      '</div>',
      function(p){
        var f = p.querySelector("#sc-m");
        f.focus(); f.select();
        function ok(){
          var m = Number(f.value);
          if(!(m > 0)){ NUHS.toast("Enter a distance greater than zero", true); return; }
          state.scale = { ax:draft.a.x, ay:draft.a.y, bx:draft.b.x, by:draft.b.y, meters:m };
          draft = null; hideDrawbar(); setCursor();
          p.remove();
          persist(); refreshRail(); syncScaleReadout(); requestRender();
          NUHS.toast("Scale set");
        }
        p.querySelector("#sc-ok").addEventListener("click", ok);
        p.querySelector("#sc-back").addEventListener("click", function(){
          p.remove(); draft.b = null; requestRender();
        });
        f.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); ok(); } });
      }
    );
  }
  function syncScaleReadout(){
    var mpp = metersPerPixel();
    var el = $("#scale-readout");
    if(!el) return;
    el.textContent = mpp == null
      ? "Scale not set — distances shown in pixels."
      : "1 m ≈ " + (1/mpp).toFixed(1) + " px";
  }

  /* ---------- drawbar ---------- */
  function setRouteDrawbarCollapsed(collapsed){
    var bar = $("#drawbar"), btn = $("#draw-collapse"), steps = $("#draw-steps");
    bar.classList.toggle("collapsed", collapsed);
    steps.hidden = collapsed;
    btn.title = collapsed ? "Expand instructions" : "Collapse instructions";
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = collapsed
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';
  }
  function showDrawbar(kind, shape){
    var bar = $("#drawbar"), a = $("#draw-a"), b = $("#draw-b"),
        fin = $("#draw-fin"), steps = $("#draw-steps"), foot = $("#draw-foot"),
        collapse = $("#draw-collapse");
    bar.hidden = false;
    bar.classList.remove("stack");
    bar.classList.remove("collapsed");
    steps.hidden = true;
    foot.hidden = true;
    collapse.hidden = true;
    fin.hidden = true;
    fin.innerHTML = FINISH_LABEL;
    // default home is the head row, inline with the other options
    if(fin.parentNode !== bar.querySelector(".head")){
      bar.querySelector(".head").insertBefore(fin, $("#draw-x"));
    }
    if(kind === "zone"){
      $("#draw-title").textContent = "Add Zone";
      a.hidden = false; b.hidden = false;
      a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                    '<rect x="4" y="6" width="16" height="12" rx="1"/></svg> Rectangle';
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
                    'stroke-linejoin="round"><path d="M12 3l8 6-3 10H7L4 9z"/></svg> Polygon';
      a.disabled = false; b.disabled = false;
      a.classList.toggle("active", shape === "rect");
      b.classList.toggle("active", shape === "poly");
      a.onclick = function(){ startZone("rect"); };
      b.onclick = function(){ startZone("poly"); };
      // a rectangle finishes on mouse-up, so Finish only applies to polygons
      if(shape === "poly"){
        fin.hidden = false;
        fin.onclick = function(){
          if(draft && draft.pts.length >= 3) finishZone(draft.pts.slice(), "poly");
        };
      }
      updateDrawbar();
    }
    else if(kind === "node"){
      $("#draw-title").textContent = "Add Node";
      a.hidden = true; b.hidden = true;
    }
    else if(kind === "route"){
      $("#draw-title").textContent = "Add Route";
      a.hidden = true; b.hidden = true;
      bar.classList.add("stack");
      steps.hidden = false;
      steps.innerHTML =
        '1. Click to add a waypoint<br>' +
        '2. Click a node/zone to add a section destination<br>' +
        '3. Double click or click Finish to finish';
      collapse.hidden = false;
      setRouteDrawbarCollapsed(false);
      collapse.onclick = function(){
        setRouteDrawbarCollapsed(!steps.hidden);
      };
      // on a route the button reads as the last step, so it sits under the
      // instructions rather than inline with the title
      foot.hidden = false;
      foot.appendChild(fin);
      fin.hidden = false;
      fin.onclick = function(){
        if(draft && draft.points.length >= 2) finishRoute();
      };
      updateDrawbar();
    }
    else if(kind === "scale"){
      $("#draw-title").textContent = "Set Scale";
      a.hidden = true; b.hidden = true;
    }
  }

  /* Finish enables once the shape is completable: 2 nodes for a route,
     3 points for a polygon. Double-click stays available at the same threshold. */
  function updateDrawbar(){
    var fin = $("#draw-fin");
    if(!draft || fin.hidden) return;
    var ready = draft.kind === "route"     ? draft.points.length >= 2
              : draft.kind === "zone-poly" ? draft.pts.length >= 3
              : false;
    fin.disabled = !ready;
    fin.classList.toggle("active", ready);
  }

  function hideDrawbar(){ $("#drawbar").hidden = true; }
  function cancelDraft(){
    if(pendingSection && pendingSection.pop) pendingSection.pop.remove();
    draft = null; pendingSection = null;
    state.hoverId = null;
    hideDrawbar(); setCursor(); requestRender();
  }
  $("#draw-x").addEventListener("click", cancelDraft);

  /* ---------- colour editor ---------- */
  function hexToRgb(hex){
    var h = String(hex).replace("#","");
    if(h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var n = parseInt(h,16);
    return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
  }
  function rgbToHex(r,g,b){
    function p(v){ return Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,"0"); }
    return ("#" + p(r) + p(g) + p(b)).toUpperCase();
  }
  function rgbToHsv(r,g,b){
    r/=255; g/=255; b/=255;
    var max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min, h=0;
    if(d){
      if(max===r) h=((g-b)/d)%6;
      else if(max===g) h=(b-r)/d+2;
      else h=(r-g)/d+4;
      h*=60; if(h<0) h+=360;
    }
    return { h:h, s:max?d/max:0, v:max };
  }
  function hsvToRgb(h,s,v){
    var c=v*s, x=c*(1-Math.abs(((h/60)%2)-1)), m=v-c, r=0,g=0,b=0;
    if(h<60){r=c;g=x;} else if(h<120){r=x;g=c;} else if(h<180){g=c;b=x;}
    else if(h<240){g=x;b=c;} else if(h<300){r=x;b=c;} else {r=c;b=x;}
    return { r:(r+m)*255, g:(g+m)*255, b:(b+m)*255 };
  }

  /* Vertical stack: square picker, then R/G/B/Hex, then the five defaults. */
  function colorControl(current, onChange){
    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<button class="colorbtn" type="button" aria-expanded="false"></button>' +
      '<div class="colorbox" hidden>' +
        '<canvas class="sat" width="240" height="74"></canvas>' +
        '<div class="rgbgrid">' +
          '<label>Red</label><input type="number" data-c="r" min="0" max="255">' +
          '<label>Green</label><input type="number" data-c="g" min="0" max="255">' +
          '<label>Blue</label><input type="number" data-c="b" min="0" max="255">' +
          '<label>Hex</label><input type="text" data-c="hex" maxlength="7">' +
        '</div>' +
        '<div class="swatches"></div>' +
      '</div>';

    var btn = wrap.querySelector(".colorbtn");
    var box = wrap.querySelector(".colorbox");
    var sat = wrap.querySelector(".sat");
    var sctx = sat.getContext("2d");
    var sw = wrap.querySelector(".swatches");
    var val = current;

    btn.addEventListener("click", function(){
      box.hidden = !box.hidden;
      btn.setAttribute("aria-expanded", String(!box.hidden));
      if(!box.hidden) paintSat();
    });

    function paintSat(){
      var hsv = rgbToHsv(hexToRgb(val).r, hexToRgb(val).g, hexToRgb(val).b);
      var w = sat.width, h = sat.height;
      var im = sctx.createImageData(w,h), d = im.data;
      for(var y=0;y<h;y++){
        for(var x=0;x<w;x++){
          var c = hsvToRgb(hsv.h, x/(w-1), 1-(y/(h-1)));
          var i = (y*w+x)*4;
          d[i]=c.r; d[i+1]=c.g; d[i+2]=c.b; d[i+3]=255;
        }
      }
      sctx.putImageData(im,0,0);
    }
    sat.addEventListener("pointerdown", function(e){
      var r = sat.getBoundingClientRect();
      var x = Math.max(0, Math.min(1, (e.clientX-r.left)/r.width));
      var y = Math.max(0, Math.min(1, (e.clientY-r.top)/r.height));
      var cur = hexToRgb(val), hsv = rgbToHsv(cur.r,cur.g,cur.b);
      var c = hsvToRgb(hsv.h, x, 1-y);
      set(rgbToHex(c.r,c.g,c.b), false);
    });

    wrap.querySelectorAll(".rgbgrid input").forEach(function(inp){
      inp.addEventListener("change", function(){
        if(inp.dataset.c === "hex"){
          var v = inp.value.trim();
          if(!/^#?[0-9a-f]{6}$/i.test(v)){ sync(); return; }
          set(v[0]==="#" ? v.toUpperCase() : "#"+v.toUpperCase(), true);
        } else {
          var c = hexToRgb(val);
          c[inp.dataset.c] = Number(inp.value)||0;
          set(rgbToHex(c.r,c.g,c.b), true);
        }
      });
    });

    PALETTE.forEach(function(c){
      var b = document.createElement("button");
      b.type = "button"; b.className = "swatch"; b.style.background = c;
      b.setAttribute("aria-label","Colour "+c);
      b.addEventListener("click", function(){ set(c, true); });
      sw.appendChild(b);
    });

    function sync(){
      btn.style.background = val;
      var c = hexToRgb(val);
      wrap.querySelector('[data-c="r"]').value = c.r;
      wrap.querySelector('[data-c="g"]').value = c.g;
      wrap.querySelector('[data-c="b"]').value = c.b;
      wrap.querySelector('[data-c="hex"]').value = val;
      sw.querySelectorAll(".swatch").forEach(function(s,i){
        s.classList.toggle("sel", PALETTE[i].toUpperCase() === val.toUpperCase());
      });
    }
    function set(v, repaint){
      val = v.toUpperCase();
      sync();
      if(repaint && !box.hidden) paintSat();
      onChange(val);
    }
    sync();
    return wrap;
  }

  /* ---------- right rail ---------- */
  function setMode(m){
    if(m === "roles") m = "zones";
    if(!$("#filemanager").hidden) showPlanWorkspace();
    state.mode = m;
    cancelDraft();
    state.selectedId = null;
    document.querySelectorAll(".tool").forEach(function(b){
      b.classList.toggle("active", b.dataset.mode === m);
    });
    var stage = $("#stagepanel");
    stage.style.display = "";
    $("#railr").classList.remove("solo");
    if(m === "routes") state.listTab = "routes";
    else if(state.listTab === "routes") state.listTab = "zones";
    refreshRail();
    requestRender();
  }

  document.querySelectorAll(".tool").forEach(function(b){
    b.addEventListener("click", function(){
      if(b.dataset.mode === "scale"){ setMode("zones"); startScale(); return; }
      setMode(b.dataset.mode);
    });
  });

  function refreshRail(){
    renderTabs();
    renderList();
    renderProps();
    // Roles mode UI is disabled; fixed role definitions still drive route colors/icons.
    // renderRoles();
  }

  function renderTabs(){
    var tabs = $("#rrtabs");
    tabs.innerHTML = "";
    // if(state.mode === "roles") return;
    var defs = state.mode === "routes" ? [["routes","Routes"]]
             : [["zones","Zones"],["nodes","Nodes"]];
    defs.forEach(function(d){
      var b = document.createElement("button");
      b.type = "button";
      b.className = "tab2" + (state.listTab === d[0] ? " active" : "");
      b.textContent = d[1];
      b.addEventListener("click", function(){
        state.listTab = d[0]; state.selectedId = null; refreshRail(); requestRender();
      });
      tabs.appendChild(b);
    });
    if(defs.length === 1) tabs.firstChild.classList.add("active");
  }

  function renderList(){
    var wrap = $("#listwrap");
    wrap.innerHTML = "";
    // if(state.mode === "roles") return;

    var addBtn = document.createElement("button");
    addBtn.className = "btn wide additem";
    addBtn.type = "button";

    if(state.mode === "routes" || state.listTab === "routes"){
      addBtn.textContent = "+ Add a route";
      addBtn.addEventListener("click", startRoute);
      wrap.appendChild(addBtn);
      if(!state.routes.length){
        wrap.insertAdjacentHTML("beforeend", '<p class="emptylist">No routes yet.</p>');
      }
      state.routes.forEach(function(r){
        var role = roleById(r.roleId);
        wrap.appendChild(listItem({
          id:r.id, name:r.label, sub:role.label, color:role.color, icon:role.icon,
          onRename:function(){ renameThing(r, "label", state.routes.map(function(x){return x.label;})); }
        }));
      });
      return;
    }

    if(state.listTab === "zones"){
      addBtn.textContent = "+ Add a zone";
      addBtn.addEventListener("click", function(){ startZone("rect"); });
      wrap.appendChild(addBtn);
      if(!state.zones.length) wrap.insertAdjacentHTML("beforeend", '<p class="emptylist">No zones yet.</p>');
      state.zones.forEach(function(z){
        wrap.appendChild(listItem({
          id:z.id, name:z.name, sub:"capacity " + z.capacity, color:z.color,
          onRename:function(){ renameThing(z, "name", state.zones.map(function(x){return x.name;})); }
        }));
      });
    } else {
      addBtn.textContent = "+ Add a node";
      addBtn.addEventListener("click", startNode);
      wrap.appendChild(addBtn);
      if(!state.nodes.length) wrap.insertAdjacentHTML("beforeend", '<p class="emptylist">No nodes yet.</p>');
      state.nodes.forEach(function(n){
        var z = zoneById(n.zoneId);
        wrap.appendChild(listItem({
          id:n.id, name:n.name, sub: z ? z.name : "unassigned", color:n.color,
          onRename:function(){ renameThing(n, "name", state.nodes.map(function(x){return x.name;})); }
        }));
      });
    }
  }

  function listItem(o){
    var d = document.createElement("div");
    d.className = "item" + (state.selectedId === o.id ? " sel" : "") +
                  (state.hoverId === o.id ? " hov" : "");
    d.dataset.id = o.id;
    d.tabIndex = 0;
    d.addEventListener("mouseenter", function(){ setHover(o.id); });
    d.addEventListener("mouseleave", function(){ setHover(null); });
    var glyph = o.icon
      ? '<span class="roleico glyph" style="-webkit-mask-image:url(' + o.icon +
        ');mask-image:url(' + o.icon + ');color:' + o.color + '"></span>'
      : '<span class="sw" style="background:' + o.color + '"></span>';
    d.innerHTML = glyph +
      '<span class="nm">' + escapeHtml(o.name) +
      (o.sub ? '<span class="sub">' + escapeHtml(o.sub) + '</span>' : '') + '</span>' +
      '<button class="rn" type="button">Rename</button>';
    d.addEventListener("click", function(e){
      if(e.target.classList.contains("rn")) return;
      state.selectedId = o.id; refreshRail(); requestRender();
    });
    d.addEventListener("keydown", function(e){
      if(e.key === "Enter" || e.key === " "){ e.preventDefault(); d.click(); }
    });
    d.querySelector(".rn").addEventListener("click", function(e){
      e.stopPropagation(); o.onRename();
    });
    return d;
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"]/g, function(c){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c];
    });
  }

  function renameThing(obj, key, allNames){
    popover(
      '<h3>Rename</h3>' +
      '<label class="field" style="margin-bottom:0"><span>Name</span>' +
        '<input type="text" id="rnm"></label>' +
      '<div class="row">' +
        '<button class="btn" id="rnm-back" type="button">Back</button>' +
        '<button class="btn primary" id="rnm-ok" type="button">Confirm</button>' +
      '</div>',
      function(p){
        var f = p.querySelector("#rnm");
        f.value = obj[key];
        f.focus(); f.select();
        function ok(){
          var v = f.value.trim();
          if(v){
            var others = allNames.filter(function(n){ return n !== obj[key]; });
            obj[key] = NUHS.uniqueName(v, others);
          }
          p.remove(); persist(); refreshRail(); requestRender();
        }
        p.querySelector("#rnm-ok").addEventListener("click", ok);
        p.querySelector("#rnm-back").addEventListener("click", function(){ p.remove(); });
        f.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); ok(); } });
      }
    );
  }

  function selected(){
    var id = state.selectedId;
    if(!id) return null;
    return zoneById(id) || nodeById(id) || routeById(id);
  }

  function field(labelText, node){
    var l = document.createElement("label");
    l.className = "field";
    var s = document.createElement("span");
    s.textContent = labelText;
    l.appendChild(s); l.appendChild(node);
    return l;
  }

  function renderProps(){
    var box = $("#props"), title = $("#props-title");
    box.innerHTML = "";

    /*
    if(state.mode === "roles"){
      title.textContent = "Role properties";
      renderRoleProps(box);
      return;
    }
    */

    var sel = selected();
    if(!sel){
      title.textContent = "Properties";
      box.innerHTML = '<p class="emptylist">Nothing selected.</p>';
      return;
    }
    var kind = kindOf(sel);
    if(kind === "zone") renderZoneProps(box, sel, title);
    else if(kind === "node") renderNodeProps(box, sel, title);
    else if(kind === "route") renderRouteProps(box, sel, title);
  }

  function renderZoneProps(box, z, title){
    title.textContent = "Zone properties";

    var redraw = document.createElement("button");
    redraw.className = "btn wide"; redraw.type = "button"; redraw.textContent = "Redraw Zone";
    redraw.addEventListener("click", function(){
      NUHS.confirm({ title:"Redraw this zone?", body:"The current outline for " + z.name + " will be replaced.",
                     confirmLabel:"Redraw", cancelLabel:"Keep" })
        .then(function(yes){
          if(!yes) return;
          state.zones = state.zones.filter(function(x){ return x.id !== z.id; });
          state.selectedId = null;
          persist(); refreshRail(); requestRender();
          startZone(z.shape === "poly" ? "poly" : "rect");
        });
    });
    box.appendChild(redraw);

    var cw = document.createElement("div");
    cw.style.marginTop = "14px";
    cw.appendChild(field("Colour", colorControl(z.color, function(v){
      z.color = v; persist(); renderList(); requestRender();
    })));
    box.appendChild(cw);

    var capWrap = document.createElement("div");
    var capRow = document.createElement("div");
    capRow.style.cssText = "display:flex;gap:10px;align-items:center";
    var rng = document.createElement("input");
    rng.type = "range"; rng.min = "1"; rng.max = "80"; rng.value = z.capacity;
    var num = document.createElement("input");
    num.type = "number"; num.className = "num"; num.min = "1"; num.value = z.capacity;
    num.style.cssText = "width:72px;flex:none";
    function setCap(v){
      var n = Math.max(1, Math.round(Number(v)||1));
      z.capacity = n; rng.value = Math.min(80,n); num.value = n;
      persist(); renderList(); requestRender();
    }
    rng.addEventListener("input", function(){ setCap(rng.value); });
    num.addEventListener("change", function(){ setCap(num.value); });
    capRow.appendChild(rng); capRow.appendChild(num);
    capWrap.appendChild(field("Capacity", capRow));
    box.appendChild(capWrap);

    var mpp = metersPerPixel();
    if(mpp != null){
      var b = polyBounds(z.pts);
      var area = Math.abs(shoelace(z.pts)) * mpp * mpp;
      var p = document.createElement("p");
      p.className = "stat";
      p.innerHTML = "Area <b>" + area.toFixed(0) + " m²</b>";
      box.appendChild(p);
    }

    var del = document.createElement("button");
    del.className = "btn wide danger"; del.type = "button"; del.textContent = "Delete zone";
    del.style.marginTop = "14px";
    del.addEventListener("click", deleteSelected);
    box.appendChild(del);
  }
  function shoelace(pts){
    var a = 0;
    for(var i=0, j=pts.length-1; i<pts.length; j=i++){
      a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    }
    return a/2;
  }

  function renderNodeProps(box, n, title){
    title.textContent = "Node properties";

    var reset = document.createElement("button");
    reset.className = "btn wide"; reset.type = "button"; reset.textContent = "Reset Node";
    reset.addEventListener("click", function(){
      NUHS.confirm({ title:"Reset this node?", body:"The position of " + n.name + " will be replaced.",
                     confirmLabel:"Reset", cancelLabel:"Keep" })
        .then(function(yes){
          if(!yes) return;
          state.nodes = state.nodes.filter(function(x){ return x.id !== n.id; });
          state.selectedId = null;
          persist(); refreshRail(); requestRender();
          startNode();
        });
    });
    box.appendChild(reset);

    var cw = document.createElement("div");
    cw.style.marginTop = "14px";
    cw.appendChild(field("Colour", colorControl(n.color, function(v){
      n.color = v; persist(); renderList(); requestRender();
    })));
    box.appendChild(cw);

    var sel = document.createElement("select");
    var none = document.createElement("option");
    none.value = ""; none.textContent = "— unassigned —";
    sel.appendChild(none);
    state.zones.forEach(function(z){
      var o = document.createElement("option");
      o.value = z.id; o.textContent = z.name;
      if(z.id === n.zoneId) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function(){
      n.zoneId = sel.value || null; persist(); renderList();
    });
    box.appendChild(field("Zone", sel));

    var del = document.createElement("button");
    del.className = "btn wide danger"; del.type = "button"; del.textContent = "Delete node";
    del.addEventListener("click", deleteSelected);
    box.appendChild(del);
  }

  function renderRouteProps(box, r, title){
    title.textContent = "Route properties";

    var redraw = document.createElement("button");
    redraw.className = "btn wide"; redraw.type = "button"; redraw.textContent = "Redraw";
    redraw.addEventListener("click", function(){
      NUHS.confirm({ title:"Redraw this route?", body:"The current path for " + r.label + " will be replaced.",
                     confirmLabel:"Redraw", cancelLabel:"Keep" })
        .then(function(yes){
          if(!yes) return;
          state.routes = state.routes.filter(function(x){ return x.id !== r.id; });
          state.selectedId = null;
          persist(); refreshRail(); requestRender();
          startRoute();
        });
    });
    box.appendChild(redraw);

    var simLabel = document.createElement("label");
    simLabel.className = "chk simtoggle";
    var simToggle = document.createElement("input");
    simToggle.type = "checkbox";
    simToggle.checked = !!r.simulateRoute;
    simToggle.addEventListener("change", function(){
      r.simulateRoute = simToggle.checked;
      if(r.simulateRoute) rebuildRouteAgents(r.id);
      else routeAgents = routeAgents.filter(function(a){ return a.routeId !== r.id; });
      persist(); requestRender(); ensureSimLoop();
    });
    simLabel.appendChild(simToggle);
    var simText = document.createElement("span");
    simText.className = "simtext";
    simText.textContent = "Simulate Route";
    var simSwitch = document.createElement("span");
    simSwitch.className = "switch";
    simSwitch.setAttribute("aria-hidden", "true");
    simLabel.appendChild(simText);
    simLabel.appendChild(simSwitch);
    box.appendChild(simLabel);

    var countRow = document.createElement("div");
    countRow.className = "stepper";
    var minus = document.createElement("button");
    minus.type = "button"; minus.className = "btn iconbtn"; minus.textContent = "−";
    var count = document.createElement("input");
    count.type = "number"; count.className = "num"; count.min = "1"; count.max = "20";
    count.value = clampAgentCount(r.agentCount || 3);
    var plus = document.createElement("button");
    plus.type = "button"; plus.className = "btn iconbtn"; plus.textContent = "+";
    function setCount(v){
      r.agentCount = clampAgentCount(v);
      count.value = r.agentCount;
      rebuildRouteAgents(r.id);
      persist(); requestRender();
    }
    minus.addEventListener("click", function(){ setCount((Number(count.value)||1) - 1); });
    plus.addEventListener("click", function(){ setCount((Number(count.value)||1) + 1); });
    count.addEventListener("change", function(){ setCount(count.value); });
    countRow.appendChild(minus); countRow.appendChild(count); countRow.appendChild(plus);
    box.appendChild(field("Number of agents", countRow));

    var roleSel = document.createElement("select");
    state.roles.forEach(function(role){
      var o = document.createElement("option");
      o.value = role.id; o.textContent = role.label;
      if(role.id === r.roleId) o.selected = true;
      roleSel.appendChild(o);
    });
    roleSel.addEventListener("change", function(){
      r.roleId = roleSel.value; rebuildRouteAgents(r.id); persist(); renderList(); requestRender();
    });
    box.appendChild(field("Role", roleSel));

    var shiftSel = document.createElement("select");
    ["Day","Evening","Night"].forEach(function(s){
      var o = document.createElement("option");
      o.value = s; o.textContent = s;
      if(s === r.shift) o.selected = true;
      shiftSel.appendChild(o);
    });
    shiftSel.addEventListener("change", function(){ r.shift = shiftSel.value; persist(); });
    box.appendChild(field("Shift", shiftSel));

    var typeWrap = document.createElement("div");
    typeWrap.className = "seg";
    [["Ping Pong",false],["Loop",true]].forEach(function(d){
      var b = document.createElement("button");
      b.type = "button"; b.textContent = d[0];
      b.className = r.isLoop === d[1] ? "active" : "";
      b.addEventListener("click", function(){
        r.isLoop = d[1];
        rebuildRouteAgents(r.id);
        persist(); renderProps(); requestRender();
      });
      typeWrap.appendChild(b);
    });
    box.appendChild(field("Type", typeWrap));

    var h = document.createElement("div");
    h.className = "panel-h";
    h.style.cssText = "padding:6px 0 4px";
    h.textContent = "Sections";
    box.appendChild(h);

    var list = document.createElement("div");
    list.className = "sections";
    var sections = routeSections(r);
    for(var i=0;i<sections.length;i++){
      (function(i){
        var section = sections[i];
        var row = document.createElement("div");
        row.className = "secrow";
        var lbl = document.createElement("span");
        lbl.className = "lbl";
        lbl.textContent = sectionLabel(sections, i);
        row.appendChild(lbl);
        if(sectionAcceptsDwell(section)){
          var inp = document.createElement("input");
          inp.type = "number"; inp.min = "0"; inp.value = section.dwellMin;
          inp.addEventListener("change", function(){
            section.dwellMin = Math.max(0, Number(inp.value)||0);
            rebuildRouteAgents(r.id);
            persist(); renderProps();
          });
          row.appendChild(inp);
        } else {
          var dash = document.createElement("span");
          dash.className = "dash";
          dash.textContent = "—";
          row.appendChild(dash);
        }
        list.appendChild(row);
      })(i);
    }
    var total = document.createElement("div");
    total.className = "secrow total";
    var tl = document.createElement("span");
    tl.className = "lbl"; tl.textContent = "Total";
    var tv = document.createElement("span");
    tv.textContent = routeTotalMin(r) + " min";
    total.appendChild(tl); total.appendChild(tv);
    list.appendChild(total);
    box.appendChild(list);

    var m = routeMeters(r);
    var p = document.createElement("p");
    p.className = "stat";
    p.innerHTML = routeAllPoints(r).length + " waypoints · <b>" +
      (m != null ? m.toFixed(1) + " m" : Math.round(routePixels(r)) + " px") + "</b>";
    box.appendChild(p);

    var del = document.createElement("button");
    del.className = "btn wide danger"; del.type = "button"; del.textContent = "Delete route";
    del.style.marginTop = "14px";
    del.addEventListener("click", deleteSelected);
    box.appendChild(del);
  }

  function deleteSelected(){
    var id = state.selectedId;
    if(!id) return;
    var routeDeleted = !!routeById(id);
    state.zones  = state.zones.filter(function(o){ return o.id !== id; });
    state.nodes  = state.nodes.filter(function(o){ return o.id !== id; });
    state.routes = state.routes.filter(function(o){ return o.id !== id; });
    state.routes.forEach(function(r){
      routeSections(r).forEach(function(section){
        if(section.destination && section.destination.targetId === id){
          section.destination = null;
          section.dwellMin = 0;
        }
      });
      if(r.stops) r.stops = r.stops.filter(function(s){ return s.targetId !== id; });
    });
    if(routeDeleted) routeAgents = routeAgents.filter(function(a){ return a.routeId !== id; });
    state.routes = state.routes.filter(function(r){ return routeAllPoints(r).length >= 2; });
    state.selectedId = null;
    persist(); refreshRail(); requestRender();
  }

  /* ---------- roles editor (disabled) ----------
  function renderRoles(){
    var grid = $("#rolesgrid");
    if(state.mode !== "roles"){ return; }
    grid.innerHTML = "";
    state.roles.forEach(function(role){
      var card = document.createElement("div");
      card.className = "rolecard" + (state.selectedRole === role.id ? " sel" : "");
      card.tabIndex = 0;
      card.innerHTML =
        '<span class="glyph" style="-webkit-mask-image:url(' + role.icon + ');mask-image:url(' +
          role.icon + ');color:' + role.color + '"></span>' +
        '<span class="nm">' + escapeHtml(role.label) + '</span>' +
        '<span class="ct">' + role.staffing + ' ' + role.unit + '</span>';
      card.addEventListener("click", function(){
        state.selectedRole = role.id; renderRoles(); renderProps();
      });
      card.addEventListener("keydown", function(e){
        if(e.key === "Enter" || e.key === " "){ e.preventDefault(); card.click(); }
      });
      grid.appendChild(card);
    });
  }

  function renderRoleProps(box){
    var role = roleById(state.selectedRole);

    var nameInp = document.createElement("input");
    nameInp.type = "text"; nameInp.value = role.label;
    nameInp.addEventListener("change", function(){
      var v = nameInp.value.trim();
      if(v){
        role.label = NUHS.uniqueName(v, state.roles.filter(function(r){ return r.id !== role.id; })
                                          .map(function(r){ return r.label; }));
        nameInp.value = role.label;
        persist(); renderRoles(); renderList();
      } else nameInp.value = role.label;
    });
    box.appendChild(field("Name", nameInp));

    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;align-items:center";
    var rng = document.createElement("input");
    rng.type = "range"; rng.min = "0";
    rng.max = role.unit === "/ day" ? "800" : "60";
    rng.value = Math.min(Number(rng.max), role.staffing);
    var num = document.createElement("input");
    num.type = "number"; num.className = "num"; num.min = "0"; num.value = role.staffing;
    num.style.cssText = "width:78px;flex:none";
    function setStaff(v){
      var n = Math.max(0, Math.round(Number(v)||0));
      role.staffing = n;
      rng.value = Math.min(Number(rng.max), n);
      num.value = n;
      persist(); renderRoles();
    }
    rng.addEventListener("input", function(){ setStaff(rng.value); });
    num.addEventListener("change", function(){ setStaff(num.value); });
    row.appendChild(rng); row.appendChild(num);
    box.appendChild(field(role.unit === "/ day" ? "Arrivals per day" : "Staffing", row));

    box.appendChild(field("Colour", colorControl(role.color, function(v){
      role.color = v; persist(); renderRoles(); renderList(); requestRender();
    })));
  }
  ---------- end disabled roles editor ---------- */

  /* ---------- step coach ---------- */
  var COACH = [
    { key:"zone",  title:"Add a zone",  body:"Outline an operational area on the map. Rectangle for a room, polygon for an irregular space.", cta:"Add zone" },
    { key:"node",  title:"Add a node",  body:"Place a touchpoint inside a zone — a desk, a bay, a station a route can stop at.", cta:"Add node" },
    { key:"route", title:"Add a route", body:"Place waypoints on the plan. Tapping a zone or node creates a section destination with dwell time.", cta:"Add route" }
    /*
    { key:"roles", title:"Edit roles",  body:"Set staffing and colour for each role. Route colour follows the role that walks it.", cta:"Edit roles" }
    */
  ];
  function showCoach(step){
    state.coachStep = step;
    var c = $("#coach");
    if(step < 1 || step > COACH.length){ c.hidden = true; return; }
    var d = COACH[step-1];
    c.hidden = false;
    $("#coach-eyebrow").textContent = step === 1 ? "Step 1 of 3" : "Step " + (step-1) + " complete";
    $("#coach-title").textContent = "Step " + step + ": " + d.title;
    $("#coach-body").textContent = d.body;
    $("#coach-go").textContent = d.cta;
  }
  function advanceCoach(justFinished){
    if(!state.coachStep) return;
    if(state.coachStep === justFinished) showCoach(state.coachStep + 1);
  }
  $("#coach-skip").addEventListener("click", function(){ showCoach(state.coachStep + 1); });
  $("#coach-go").addEventListener("click", function(){
    var step = state.coachStep;
    $("#coach").hidden = true;
    if(step === 1){ setMode("zones"); state.listTab = "zones"; refreshRail(); startZone("rect"); }
    else if(step === 2){ setMode("zones"); state.listTab = "nodes"; refreshRail(); startNode(); }
    else if(step === 3){ setMode("routes"); startRoute(); }
    // else if(step === 4){ setMode("roles"); }
    state.coachStep = step;   // setMode cancels the draft, so restore after
    if(step === 1) startZone("rect");
    if(step === 2) startNode();
    if(step === 3) startRoute();
  });

  /* ---------- view controls ---------- */
  $("#v-select").addEventListener("click", function(){
    tool = "select"; this.classList.add("active"); $("#v-pan").classList.remove("active");
    $("#hud-mode").textContent = "select"; setCursor();
  });
  $("#v-pan").addEventListener("click", function(){
    tool = "pan"; this.classList.add("active"); $("#v-select").classList.remove("active");
    $("#hud-mode").textContent = "pan"; setCursor();
  });
  $("#v-zoom").addEventListener("input", function(){ setZoom(Number(this.value)); syncZoomSlider(); });
  $("#v-zoomout").addEventListener("click", function(){ zoomAt(cssW/2, cssH/2, 1/1.2); });
  $("#v-zoomin").addEventListener("click", function(){ zoomAt(cssW/2, cssH/2, 1.2); });

  var eyeBtn = $("#v-eye"), eyeMenu = $("#eyemenu");
  eyeBtn.addEventListener("click", function(e){
    e.stopPropagation();
    eyeMenu.hidden = !eyeMenu.hidden;
    eyeBtn.setAttribute("aria-expanded", String(!eyeMenu.hidden));
  });
  document.addEventListener("click", function(e){
    if(!eyeMenu.hidden && !eyeMenu.contains(e.target) && e.target !== eyeBtn){
      eyeMenu.hidden = true; eyeBtn.setAttribute("aria-expanded","false");
    }
  });
  [["lay-zones","zones"],["lay-nodes","nodes"],["lay-routes","routes"],["lay-grid","grid"]]
  .forEach(function(d){
    $("#"+d[0]).addEventListener("change", function(){
      state.layers[d[1]] = this.checked;
      syncShowAll(); persist(); requestRender();
    });
  });
  $("#lay-all").addEventListener("change", function(){
    var on = this.checked;
    ["zones","nodes","routes","grid"].forEach(function(k){ state.layers[k] = on; });
    syncLayerBoxes(); persist(); requestRender();
  });
  function syncLayerBoxes(){
    $("#lay-zones").checked  = state.layers.zones;
    $("#lay-nodes").checked  = state.layers.nodes;
    $("#lay-routes").checked = state.layers.routes;
    $("#lay-grid").checked   = state.layers.grid;
    syncShowAll();
  }
  function syncShowAll(){
    $("#lay-all").checked = state.layers.zones && state.layers.nodes &&
                            state.layers.routes && state.layers.grid;
  }

  $("#map-opacity").addEventListener("input", function(){
    state.mapOpacity = Number(this.value)/100;
    $("#op-val").textContent = this.value + "%";
    persist(); requestRender();
  });

  /* ---------- rail splitters ---------- */
  (function(){
    var railr = $("#railr"), rrtop = $("#rrtop");
    var vs = $("#vsplit"), hs = $("#hsplit");
    var topH = 300;
    function applyTop(){ rrtop.style.flex = "none"; rrtop.style.height = topH + "px"; }
    applyTop();

    vs.addEventListener("pointerdown", function(e){
      e.preventDefault(); vs.setPointerCapture(e.pointerId);
      var startY = e.clientY, startH = rrtop.getBoundingClientRect().height;
      function move(ev){
        topH = Math.max(120, Math.min(railr.clientHeight - 140, startH + (ev.clientY - startY)));
        applyTop();
      }
      function up(){ vs.releasePointerCapture(e.pointerId);
        vs.removeEventListener("pointermove", move); vs.removeEventListener("pointerup", up);
        persistUi();
      }
      vs.addEventListener("pointermove", move);
      vs.addEventListener("pointerup", up);
    });

    hs.addEventListener("pointerdown", function(e){
      e.preventDefault(); hs.setPointerCapture(e.pointerId);
      var startX = e.clientX, startW = railr.getBoundingClientRect().width;
      function move(ev){
        var w = Math.max(260, Math.min(620, startW - (ev.clientX - startX)));
        railr.style.width = w + "px";
        resize();
      }
      function up(){ hs.releasePointerCapture(e.pointerId);
        hs.removeEventListener("pointermove", move); hs.removeEventListener("pointerup", up);
        persistUi();
      }
      hs.addEventListener("pointermove", move);
      hs.addEventListener("pointerup", up);
    });

    function persistUi(){
      try{
        localStorage.setItem("nuhs-ed-plan-ui", JSON.stringify({
          topH: topH, railW: railr.getBoundingClientRect().width
        }));
      }catch(err){}
    }
    try{
      var ui = JSON.parse(localStorage.getItem("nuhs-ed-plan-ui") || "null");
      if(ui){
        if(ui.topH){ topH = ui.topH; applyTop(); }
        if(ui.railW) railr.style.width = ui.railW + "px";
      }
    }catch(err){}
  })();

  /* ---------- map loading ---------- */
  function loadImage(dataUrl, then){
    var im = new Image();
    im.onload = function(){
      img = im;
      if(state.map){ state.map.width = im.naturalWidth; state.map.height = im.naturalHeight; }
      if(then) then();
      fitView();
      requestRender();
    };
    im.onerror = function(){ NUHS.toast("Couldn't read that image", true); };
    im.src = dataUrl;
  }

  function onMapReady(){
    $("#empty").hidden = true;
    $("#viewbar").hidden = false;
    $("#hud").hidden = false;
    $("#mapblock").style.display = "";
    $("#map-name").textContent = state.map.name;
    document.querySelectorAll(".tool").forEach(function(b){ b.disabled = false; });
    syncScaleReadout();
    syncLayerBoxes();
    refreshRail();
  }

  $("#btn-upload").addEventListener("click", function(){ $("#fileInput").click(); });
  $("#btn-replace").addEventListener("click", function(){ $("#fileInput").click(); });
  $("#btn-file-manager").addEventListener("click", showFileManager);
  $("#fileInput").addEventListener("change", function(e){
    var f = e.target.files[0];
    if(!f) return;
    clearCurrentFileRef();
    var reader = new FileReader();
    reader.onload = function(){
      state.map = { name:f.name, dataUrl:reader.result, width:0, height:0, isTemplate:false };
      loadImage(reader.result, function(){
        onMapReady(); persist();
        if(!state.zones.length) showCoach(1);
      });
    };
    reader.readAsDataURL(f);
    e.target.value = "";
  });

  $("#btn-skip").addEventListener("click", function(){
    useTemplate();
  });
  function useTemplate(){
    state.map = { name:"template_map.png", dataUrl:TEMPLATE_MAP,
                  width:1200, height:760, isTemplate:true };
    if(!state.zones.length){
      TEMPLATE_ZONES.forEach(function(t){
        var z = {
          id:uid("z_"), name:t.name, color:t.color, capacity:t.capacity, shape:"rect",
          pts: rectPts(t.x, t.y, t.x+t.w, t.y+t.h)
        };
        state.zones.push(z);
        // routes chain nodes, so every template zone gets one to start from
        state.nodes.push({
          id:uid("n_"), name:t.name, color:t.color,
          x:t.x + t.w/2, y:t.y + t.h/2, zoneId:z.id
        });
      });
      state.stepsDone.zone = true;
      state.stepsDone.node = true;
    }
    loadImage(TEMPLATE_MAP, function(){
      onMapReady(); persist();
      showCoach(2);
    });
  }

  /* ---------- persistence ---------- */
  var saveTimer = null;
  function persist(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function(){ save(false); }, 500);
  }
  function serializeMap(withImage){
    if(!state.map) return null;
    var map = {
      name: state.map.name,
      width: state.map.width, height: state.map.height,
      isTemplate: !!state.map.isTemplate,
      embedded: !!(withImage && !state.map.isTemplate && state.map.dataUrl)
    };
    if(withImage && !state.map.isTemplate && state.map.dataUrl) map.dataUrl = state.map.dataUrl;
    return map;
  }
  function serialize(withImage){
    var mpp = metersPerPixel();
    var s = NUHS.loadSettings();
    return {
      kind:"ed-flow-plan", version:4,
      exportedAt:new Date().toISOString(),
      settings:s,
      map: serializeMap(withImage),
      mapOpacity: state.mapOpacity,
      layers: Object.assign({}, state.layers),
      scale: state.scale ? Object.assign({ metersPerPixel:mpp }, state.scale) : null,
      roles: state.roles.map(function(r){
        return {
          id:r.id, label:r.label, color:r.color, icon:r.icon
          // staffing:r.staffing, unit:r.unit
        };
      }),
      zones: state.zones.map(function(z){
        return { id:z.id, name:z.name, color:z.color, capacity:z.capacity, shape:z.shape,
                 polygon:z.pts.map(function(p){ return { x:round2(p.x), y:round2(p.y) }; }),
                 areaMeters2: mpp == null ? null : round2(Math.abs(shoelace(z.pts))*mpp*mpp) };
      }),
      nodes: state.nodes.map(function(n){
        return { id:n.id, name:n.name, color:n.color, x:round2(n.x), y:round2(n.y),
                 zoneId:n.zoneId,
                 xMeters: mpp == null ? null : round2(n.x*mpp),
                 yMeters: mpp == null ? null : round2(n.y*mpp) };
      }),
      routes: state.routes.map(function(r){
        var m = routeMeters(r);
        var sections = routeSections(r);
        return {
          id:r.id, label:r.label, roleId:r.roleId, roleLabel:roleById(r.roleId).label,
          shift:r.shift, isLoop:!!r.isLoop, type:r.isLoop ? "loop" : "pingpong",
          simulateRoute:!!r.simulateRoute, agentCount:clampAgentCount(r.agentCount || 3),
          totalMinutes: routeTotalMin(r),
          distancePixels: round2(routePixels(r)),
          distanceMeters: m == null ? null : round2(m),
          waypoints: routeAllPoints(r).map(function(p,i){
            return { index:i, x:round2(p.x), y:round2(p.y),
                     xMeters: mpp == null ? null : round2(p.x*mpp),
                     yMeters: mpp == null ? null : round2(p.y*mpp) };
          }),
          sections: sections.map(function(section,i){
            var d = sectionPixels(sections, i);
            return {
              id:section.id, label:sectionLabel(sections, i),
              destination:section.destination ? {
                targetType:section.destination.targetType,
                targetId:section.destination.targetId,
                name:destinationLabel(section.destination)
              } : null,
              acceptsDwell:sectionAcceptsDwell(section),
              dwellMin:sectionAcceptsDwell(section) ? (Number(section.dwellMin)||0) : 0,
              waypoints:(section.waypoints || []).map(function(p){ return { x:round2(p.x), y:round2(p.y) }; }),
              distanceMeters: mpp == null ? null : round2(d*mpp)
            };
          })
        };
      }),
      view: Object.assign({}, state.view)
    };
  }
  function round2(v){ return Math.round(v*100)/100; }

  function save(explicit){
    var payload = serialize(true);
    try{
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    }catch(err){
      try{
        localStorage.setItem(LS_KEY, JSON.stringify(serialize(false)));
        if(explicit) NUHS.toast("Saved locally without image — floorplan was too large for browser storage", true);
      }catch(e2){
        if(explicit) NUHS.toast("Couldn't save locally — use Export", true);
      }
    }
    if(explicit) savePlanToFirestore(payload);
  }

  function normalizeRoute(r){
    var sections = [];
    if(r.sections && r.sections.length){
      sections = r.sections.map(function(section){
        var dest = section.destination || null;
        if(dest && dest.targetType == null && dest.type){
          dest = { targetType:dest.type, targetId:dest.id };
        }
        return {
          id:section.id || uid("sec_"),
          waypoints:(section.waypoints || []).map(function(p){
            return { x:Number(p.x)||0, y:Number(p.y)||0 };
          }),
          destination: dest ? { targetType:dest.targetType || "zone", targetId:dest.targetId } : null,
          dwellMin:Number(section.dwellMin ?? section.minutes ?? section.waitMin) || 0
        };
      }).filter(function(section){ return section.waypoints.length; });
    } else if(r.stops && r.stops.length){
      sections = legacyStopsToSections(r.stops.map(function(s){
        return { targetType:s.targetType || "node", targetId:s.targetId, waitMin:s.waitMin };
      }));
    } else if(r.waypoints && r.waypoints.length >= 2){
      sections = [{ id:uid("sec_"),
                    waypoints:r.waypoints.map(function(p){ return { x:Number(p.x)||0, y:Number(p.y)||0 }; }),
                    destination:null, dwellMin:0 }];
    }
    return {
      id:r.id||uid("r_"),
      label:r.label||"Route",
      roleId:r.roleId||"other",
      shift:r.shift||"Day",
      isLoop: r.isLoop != null ? !!r.isLoop : r.type === "loop",
      simulateRoute:!!r.simulateRoute,
      agentCount:clampAgentCount(r.agentCount || r.agents || 3),
      sections:sections
    };
  }

  function deserialize(d){
    if(d.kind === "ed-flow-annotation") return deserializeV2(d);

    state.mapOpacity = d.mapOpacity == null ? 1 : d.mapOpacity;
    state.layers = Object.assign({ zones:true,nodes:true,routes:true,grid:false }, d.layers||{});
    state.scale = d.scale ? { ax:d.scale.ax, ay:d.scale.ay, bx:d.scale.bx, by:d.scale.by,
                              meters:d.scale.meters } : null;
    state.roles = ROLE_DEFS.map(function(def){ return Object.assign({}, def); });
    /*
    if(d.roles && d.roles.length){
      state.roles = ROLE_DEFS.map(function(def){
        var found = d.roles.find(function(r){ return r.id === def.id; });
        var role = found ? Object.assign({}, def, found) : Object.assign({}, def);
        role.icon = def.icon;   // asset path comes from code, not from the file
        return role;
      });
    }
    */
    state.zones = (d.zones||[]).map(function(z){
      return { id:z.id||uid("z_"), name:z.name||"Zone", color:z.color||PALETTE[0],
               capacity: z.capacity == null ? 20 : z.capacity, shape:z.shape||"poly",
               pts:(z.polygon||z.pts||[]).map(function(p){ return { x:Number(p.x), y:Number(p.y) }; }) };
    });
    state.nodes = (d.nodes||[]).map(function(n){
      return { id:n.id||uid("n_"), name:n.name||"Node", color:n.color||PALETTE[3],
               x:Number(n.x), y:Number(n.y), zoneId:n.zoneId||null };
    });
    state.routes = (d.routes||[]).map(function(r){
      return normalizeRoute(r);
    }).filter(function(r){ return routeAllPoints(r).length >= 2; });
    state.selectedId = null;
    if(d.view) state.view = Object.assign({}, d.view);

    if(d.map){
      state.map = { name:d.map.name||"floorplan", width:d.map.width||0, height:d.map.height||0,
                    isTemplate:!!d.map.isTemplate,
                    dataUrl: d.map.isTemplate ? TEMPLATE_MAP : (d.map.dataUrl||null) };
      if(state.map.dataUrl){
        loadImage(state.map.dataUrl, function(){ onMapReady(); rebuildAllRouteAgents(); });
      } else {
        img = null;
        onMapReady();
        rebuildAllRouteAgents();
        NUHS.toast("This plan has no image embedded — use Replace to re-attach " + state.map.name, true);
      }
    }
  }

  /* Upgrade a file written by the previous annotator. Its per-waypoint dwell
     becomes the section duration arriving at that stop, and its actor becomes
     the closest matching role. */
  function deserializeV2(d){
    var ACTOR_TO_ROLE = { doctor:"doctor", physician:"consultant", nurse:"nurse",
                          hca:"porter", patient:"patient", other:"other" };
    state.scale = d.scale ? { ax:d.scale.ax, ay:d.scale.ay, bx:d.scale.bx, by:d.scale.by,
                              meters:d.scale.meters } : null;
    state.zones = (d.zones||[]).map(function(z){
      var pts = (z.polygon||z.pts||[]).map(function(p){ return { x:Number(p.x), y:Number(p.y) }; });
      return { id:z.id||uid("z_"), name:z.name || z.typeLabel || z.type || "Zone",
               color:PALETTE[0], capacity:20, shape:"poly", pts:pts };
    });
    state.nodes = (d.nodes||[]).map(function(n){
      return { id:n.id||uid("n_"), name:n.name || n.type || "Node", color:PALETTE[3],
               x:Number(n.x), y:Number(n.y), zoneId:null };
    });
    state.nodes.forEach(function(n){ n.zoneId = nearestZoneFor(n.x, n.y); });

    state.routes = (d.routes||[]).map(function(r){
      var wpts = r.waypoints || r.pts || [];
      var stops = wpts.map(function(p,i){
        var id = p.nodeId && nodeById(p.nodeId) ? p.nodeId
               : nearestNodeId(Number(p.x), Number(p.y));
        return { targetType:"node", targetId:id,
                 waitMin: i === 0 ? 0 : Math.round(Number(p.dwellMin ?? p.dwell) || 0) };
      }).filter(function(s){ return s.targetId; });
      return normalizeRoute({ id:r.id||uid("r_"), label:r.label || "Route",
                              roleId: ACTOR_TO_ROLE[r.actor] || "other",
                              shift: r.shift || "Day", stops:stops });
    }).filter(function(r){ return routeAllPoints(r).length >= 2; });

    if(d.floorplan){
      state.map = { name:d.floorplan.name||"floorplan", width:d.floorplan.width||0,
                    height:d.floorplan.height||0, isTemplate:false,
                    dataUrl:d.floorplan.dataUrl||null };
      if(state.map.dataUrl) loadImage(state.map.dataUrl, function(){ onMapReady(); rebuildAllRouteAgents(); });
      else { img = null; onMapReady(); rebuildAllRouteAgents();
             NUHS.toast("Imported — re-attach " + state.map.name + " with Replace", true); }
    }
    NUHS.toast("Imported and upgraded from the previous format");
  }

  /* ---------- annotated plan rendering ---------- */
  function renderAnnotatedCanvas(){
    if(!state.map){ NUHS.toast("Load a floorplan first", true); return; }
    var W = state.map.width, H = state.map.height;
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var g = c.getContext("2d");
    g.fillStyle = "#FFFFFF"; g.fillRect(0,0,W,H);
    if(img){ g.globalAlpha = state.mapOpacity; g.drawImage(img,0,0,W,H); g.globalAlpha = 1; }

    var S = Math.max(1, W/1400);
    g.lineJoin = "round"; g.lineCap = "round";

    state.zones.forEach(function(z){
      g.beginPath();
      z.pts.forEach(function(p,i){ i ? g.lineTo(p.x,p.y) : g.moveTo(p.x,p.y); });
      g.closePath();
      g.fillStyle = hexA(z.color, 0.16); g.fill();
      g.lineWidth = 2*S; g.strokeStyle = z.color; g.stroke();
      var b = polyBounds(z.pts);
      g.font = "700 " + (13*S) + 'px "Open Sans", sans-serif';
      g.fillStyle = z.color; g.textAlign = "left"; g.textBaseline = "top";
      g.fillText(z.name.toUpperCase(), b.x0 + 8*S, b.y0 + 7*S);
      g.textAlign = "right";
      g.font = "600 " + (11*S) + 'px "IBM Plex Mono", monospace';
      g.fillText("cap " + z.capacity, b.x1 - 8*S, b.y0 + 7*S);
    });

    state.routes.forEach(function(r){
      var pts = routeAllPoints(r);
      if(pts.length < 2) return;
      var col = roleById(r.roleId).color;
      g.beginPath();
      pts.forEach(function(p,i){ i ? g.lineTo(p.x,p.y) : g.moveTo(p.x,p.y); });
      if(r.isLoop && pts.length > 2) g.closePath();
      g.lineWidth = 3.4*S; g.strokeStyle = col; g.globalAlpha = 0.9; g.stroke(); g.globalAlpha = 1;
      routeSections(r).forEach(function(section){
        var p = section.waypoints && section.waypoints.length ? section.waypoints[section.waypoints.length-1] : null;
        if(!p) return;
        g.beginPath(); g.arc(p.x,p.y,5*S,0,Math.PI*2);
        g.fillStyle = sectionAcceptsDwell(section) ? "#FFFFFF" : col; g.fill();
        g.lineWidth = 1.7*S; g.strokeStyle = col; g.stroke();
      });
      var p0 = pts[0];
      g.font = "700 " + (12*S) + 'px "Open Sans", sans-serif';
      g.fillStyle = col; g.textAlign = "left"; g.textBaseline = "alphabetic";
      g.fillText(r.label + "  ·  " + routeTotalMin(r) + " min", p0.x + 9*S, p0.y - 10*S);
    });

    state.nodes.forEach(function(n){
      g.beginPath(); g.arc(n.x,n.y,6*S,0,Math.PI*2);
      g.fillStyle = n.color; g.fill();
      g.lineWidth = 2*S; g.strokeStyle = "#FFFFFF"; g.stroke();
      g.font = "600 " + (11*S) + 'px "Open Sans", sans-serif';
      g.fillStyle = "#2B3B4A"; g.textAlign = "left"; g.textBaseline = "middle";
      g.fillText(n.name, n.x + 10*S, n.y);
    });

    var mppExp = metersPerPixel();
    if(mppExp != null){
      var meters = niceScaleSpan(mppExp, 1, W/7);
      var bw = meters/mppExp;
      if(isFinite(bw) && bw > 10){
        var bx1 = W - 26*S, bx0 = bx1 - bw, by = H - 30*S;
        g.strokeStyle = "#2B3B4A"; g.lineWidth = 2*S;
        g.beginPath();
        g.moveTo(bx0, by - 7*S); g.lineTo(bx0, by + 4*S);
        g.moveTo(bx0, by);       g.lineTo(bx1, by);
        g.moveTo(bx1, by - 7*S); g.lineTo(bx1, by + 4*S);
        g.stroke();
        g.font = "600 " + (12*S) + 'px "IBM Plex Mono", monospace';
        g.fillStyle = "#2B3B4A"; g.textAlign = "center"; g.textBaseline = "bottom";
        g.fillText(meters >= 1 ? meters + " m" : (meters*100) + " cm", (bx0+bx1)/2, by - 9*S);
      }
    }

    return c;
  }

  function stripKnownExtension(name){
    return String(name || "").replace(/\.(json|zip|png|jpe?g|webp)$/i, "");
  }
  function cleanFilename(name, fallback){
    var base = stripKnownExtension(name || fallback || "ed-flow-plan")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/^\.+|\.+$/g, "")
      .trim();
    return base || fallback || "ed-flow-plan";
  }
  function settingsFilename(settings){
    settings = settings || NUHS.loadSettings();
    return cleanFilename(settings.filename || NUHS.slug(settings.department, "ed-flow") + "-plan", "ed-flow-plan");
  }
  function persistCurrentFileRef(){
    try{ localStorage.setItem(FILE_REF_KEY, JSON.stringify(currentFileRef)); }catch(err){}
  }
  function restoreCurrentFileRef(){
    try{
      var ref = JSON.parse(localStorage.getItem(FILE_REF_KEY) || "null");
      if(ref && ref.id) currentFileRef = { id:ref.id, filename:ref.filename || null };
    }catch(err){}
  }
  function clearCurrentFileRef(){
    currentFileRef = { id:null, filename:null };
    try{ localStorage.removeItem(FILE_REF_KEY); }catch(err){}
  }
  function applyPlanSettings(plan, fallbackFilename){
    var current = NUHS.loadSettings();
    var next = Object.assign({}, current, plan && plan.settings ? plan.settings : {});
    if(fallbackFilename) next.filename = fallbackFilename;
    next.filename = settingsFilename(next);
    if(NUHS.saveSettings(next)){
      NUHS.settings = NUHS.loadSettings();
      document.dispatchEvent(new CustomEvent("nuhs:settings", { detail:NUHS.settings }));
    }
  }
  function webpNameFromImageName(name){
    var base = cleanFilename(stripKnownExtension(name || "floorplan"), "floorplan");
    return base + ".webp";
  }
  function canvasToBlob(canvas, type, quality){
    return new Promise(function(resolve, reject){
      canvas.toBlob(function(blob){
        if(blob) resolve(blob);
        else reject(new Error("Couldn't create image export"));
      }, type, quality);
    });
  }
  function floorplanWebpBlob(){
    if(!state.map || !img) return Promise.reject(new Error("No floorplan image is loaded"));
    var c = document.createElement("canvas");
    c.width = state.map.width; c.height = state.map.height;
    var g = c.getContext("2d");
    g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return canvasToBlob(c, "image/webp", 0.92);
  }
  function annotatedPlanWebpBlob(){
    var c = renderAnnotatedCanvas();
    if(!c) return Promise.reject(new Error("No annotated plan is available"));
    return canvasToBlob(c, "image/webp", 0.92);
  }
  function textBlob(text, type){
    return new Blob([text], { type:type || "text/plain" });
  }

  var CRC_TABLE = null;
  function crcTable(){
    if(CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = [];
    for(var n=0;n<256;n++){
      var c = n;
      for(var k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
    return CRC_TABLE;
  }
  function crc32(bytes){
    var table = crcTable(), c = 0xFFFFFFFF;
    for(var i=0;i<bytes.length;i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function dosDateTime(date){
    var y = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds()/2),
      date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }
  function headerBytes(size){
    var bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    return {
      bytes: bytes,
      u16: function(offset, value){ view.setUint16(offset, value, true); },
      u32: function(offset, value){ view.setUint32(offset, value >>> 0, true); }
    };
  }
  async function createZip(files){
    var enc = new TextEncoder(), chunks = [], central = [], offset = 0;
    var stamp = dosDateTime(new Date());
    for(var i=0;i<files.length;i++){
      var nameBytes = enc.encode(files[i].name);
      var data = new Uint8Array(await files[i].blob.arrayBuffer());
      var crc = crc32(data);
      var local = headerBytes(30);
      local.u32(0, 0x04034b50);
      local.u16(4, 20);
      local.u16(6, 0x0800);
      local.u16(8, 0);
      local.u16(10, stamp.time);
      local.u16(12, stamp.date);
      local.u32(14, crc);
      local.u32(18, data.length);
      local.u32(22, data.length);
      local.u16(26, nameBytes.length);
      local.u16(28, 0);
      chunks.push(local.bytes, nameBytes, data);

      var dir = headerBytes(46);
      dir.u32(0, 0x02014b50);
      dir.u16(4, 20);
      dir.u16(6, 20);
      dir.u16(8, 0x0800);
      dir.u16(10, 0);
      dir.u16(12, stamp.time);
      dir.u16(14, stamp.date);
      dir.u32(16, crc);
      dir.u32(20, data.length);
      dir.u32(24, data.length);
      dir.u16(28, nameBytes.length);
      dir.u16(30, 0);
      dir.u16(32, 0);
      dir.u16(34, 0);
      dir.u16(36, 0);
      dir.u32(38, 0);
      dir.u32(42, offset);
      central.push(dir.bytes, nameBytes);
      offset += local.bytes.length + nameBytes.length + data.length;
    }
    var centralSize = central.reduce(function(sum, chunk){ return sum + chunk.length; }, 0);
    var end = headerBytes(22);
    end.u32(0, 0x06054b50);
    end.u16(8, files.length);
    end.u16(10, files.length);
    end.u32(12, centralSize);
    end.u32(16, offset);
    end.u16(20, 0);
    return new Blob(chunks.concat(central, [end.bytes]), { type:"application/zip" });
  }
  function decodeZipName(bytes, utf8){
    if(utf8 && window.TextDecoder) return new TextDecoder("utf-8").decode(bytes);
    var s = "";
    for(var i=0;i<bytes.length;i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  async function inflateZipData(bytes){
    if(!window.DecompressionStream) throw new Error("This browser cannot read compressed ZIP entries");
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function readZipEntries(file){
    var bytes = new Uint8Array(await file.arrayBuffer());
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    for(var p=bytes.length-22; p>=Math.max(0, bytes.length-65557); p--){
      if(view.getUint32(p, true) === 0x06054b50){ eocd = p; break; }
    }
    if(eocd < 0) throw new Error("ZIP file is missing its directory");
    var total = view.getUint16(eocd + 10, true);
    var pos = view.getUint32(eocd + 16, true);
    var entries = [];
    for(var i=0;i<total;i++){
      if(view.getUint32(pos, true) !== 0x02014b50) throw new Error("ZIP directory is invalid");
      var flags = view.getUint16(pos + 8, true);
      var method = view.getUint16(pos + 10, true);
      var compressedSize = view.getUint32(pos + 20, true);
      var nameLen = view.getUint16(pos + 28, true);
      var extraLen = view.getUint16(pos + 30, true);
      var commentLen = view.getUint16(pos + 32, true);
      var localOffset = view.getUint32(pos + 42, true);
      var name = decodeZipName(bytes.slice(pos + 46, pos + 46 + nameLen), !!(flags & 0x0800));
      if(name && name[name.length-1] !== "/"){
        entries.push({ name:name, method:method, compressedSize:compressedSize, localOffset:localOffset });
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries.map(function(entry){
      return {
        name: entry.name,
        blob: async function(){
          var local = entry.localOffset;
          if(view.getUint32(local, true) !== 0x04034b50) throw new Error("ZIP entry is invalid");
          var nlen = view.getUint16(local + 26, true);
          var xlen = view.getUint16(local + 28, true);
          var start = local + 30 + nlen + xlen;
          var compressed = bytes.slice(start, start + entry.compressedSize);
          var data = entry.method === 0 ? compressed
                   : entry.method === 8 ? await inflateZipData(compressed)
                   : null;
          if(!data) throw new Error("ZIP entry uses an unsupported compression method");
          return new Blob([data]);
        }
      };
    });
  }

  function readFileAsText(file){
    return new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onload = function(){ resolve(reader.result); };
      reader.onerror = function(){ reject(new Error("Couldn't read " + file.name)); };
      reader.readAsText(file);
    });
  }
  function blobToDataUrl(blob){
    return new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onload = function(){ resolve(reader.result); };
      reader.onerror = function(){ reject(new Error("Couldn't read the floorplan image")); };
      reader.readAsDataURL(blob);
    });
  }
  function isZipFile(file){
    return /\.zip$/i.test(file.name) || /zip/i.test(file.type || "");
  }
  function isImageEntry(name){
    return /\.(png|jpe?g|webp)$/i.test(name);
  }
  function isAnnotatedPlanName(name){
    return /annotated[\s_-]*plan\.webp$/i.test(name);
  }
  function chooseFloorplanEntry(entries, plan){
    var images = entries.filter(function(entry){
      return isImageEntry(entry.name) && !isAnnotatedPlanName(entry.name);
    });
    if(!images.length) return null;
    var mapName = plan && plan.map && plan.map.name ? stripKnownExtension(plan.map.name).toLowerCase() : "";
    if(mapName){
      var matched = images.find(function(entry){
        var leaf = entry.name.split("/").pop();
        return stripKnownExtension(leaf).toLowerCase() === mapName;
      });
      if(matched) return matched;
    }
    return images[0];
  }
  async function importZipFile(file){
    var entries = await readZipEntries(file);
    var jsonEntry = entries.find(function(entry){ return /\.json$/i.test(entry.name); });
    if(!jsonEntry) throw new Error("ZIP file does not contain a JSON plan");
    var jsonText = await (await jsonEntry.blob()).text();
    var plan = JSON.parse(jsonText);
    if(plan.kind && plan.kind !== "ed-flow-plan" && plan.kind !== "ed-flow-annotation"){
      throw new Error("not a plan file");
    }
    var floorplan = chooseFloorplanEntry(entries, plan);
    if(floorplan){
      var floorBlob = await floorplan.blob();
      plan.map = plan.map || {};
      plan.map.name = floorplan.name.split("/").pop();
      plan.map.isTemplate = false;
      plan.map.embedded = true;
      plan.map.dataUrl = await blobToDataUrl(floorBlob);
    }
    return plan;
  }
  async function importPlanFile(file){
    if(isZipFile(file)) return importZipFile(file);
    var text = await readFileAsText(file);
    var plan = JSON.parse(text);
    if(plan.kind && plan.kind !== "ed-flow-plan" && plan.kind !== "ed-flow-annotation"){
      throw new Error("not a plan file");
    }
    return plan;
  }
  function closeModal(m){
    if(m) m.remove();
  }
  function openImportDialog(){
    var m = document.createElement("div");
    m.className = "modal";
    m.innerHTML =
      '<div class="box" role="dialog" aria-modal="true" aria-label="Import plan">' +
        '<h2>Import</h2>' +
        '<p>Import either (a) JSON file or (b) Zip file with JSON file and floorplan</p>' +
        '<div class="row">' +
          '<button class="btn" id="imp-cancel" type="button">Cancel</button>' +
          '<button class="btn primary" id="imp-choose" type="button">Choose file</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    m.querySelector("#imp-cancel").addEventListener("click", function(){ closeModal(m); });
    m.querySelector("#imp-choose").addEventListener("click", function(){
      activeImportModal = m;
      $("#importInput").click();
    });
    m.addEventListener("click", function(e){ if(e.target === m) closeModal(m); });
    m.querySelector("#imp-choose").focus();
  }
  async function openExportDialog(){
    var settings = NUHS.loadSettings();
    var defaultName = settingsFilename(settings);
    var m = document.createElement("div");
    m.className = "modal";
    m.innerHTML =
      '<div class="box" role="dialog" aria-modal="true" aria-label="Export plan">' +
        '<h2>Export</h2>' +
        '<label class="field"><span>Filename</span><input type="text" id="exp-name"></label>' +
        '<label class="chk"><input type="checkbox" id="exp-floorplan"> Include floorplan</label>' +
        '<div class="row">' +
          '<button class="btn" id="exp-cancel" type="button">Cancel</button>' +
          '<button class="btn primary" id="exp-ok" type="button">Export</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    var nameInput = m.querySelector("#exp-name");
    var include = m.querySelector("#exp-floorplan");
    var ok = m.querySelector("#exp-ok");
    nameInput.value = defaultName;
    nameInput.focus(); nameInput.select();
    m.querySelector("#exp-cancel").addEventListener("click", function(){ closeModal(m); });
    m.addEventListener("click", function(e){ if(e.target === m) closeModal(m); });
    async function doExport(){
      var base = cleanFilename(nameInput.value, defaultName);
      ok.disabled = true;
      try{
        var jsonBlob = textBlob(JSON.stringify(serialize(false), null, 2), "application/json");
        if(!include.checked){
          NUHS.downloadBlob(jsonBlob, base + ".json");
          NUHS.toast("Plan exported");
          closeModal(m);
          return;
        }
        if(!state.map || !img) throw new Error("Load a floorplan first");
        var floorName = webpNameFromImageName(state.map.name);
        if(floorName.toLowerCase() === "annotated plan.webp") floorName = "floorplan.webp";
        var zipBlob = await createZip([
          { name:base + ".json", blob:jsonBlob },
          { name:floorName, blob:await floorplanWebpBlob() },
          { name:"annotated plan.webp", blob:await annotatedPlanWebpBlob() }
        ]);
        NUHS.downloadBlob(zipBlob, base + ".zip");
        NUHS.toast("Plan ZIP exported");
        closeModal(m);
      }catch(err){
        ok.disabled = false;
        NUHS.toast("Export failed: " + err.message, true);
      }
    }
    ok.addEventListener("click", doExport);
    nameInput.addEventListener("keydown", function(e){
      if(e.key === "Enter"){ e.preventDefault(); doExport(); }
    });
  }

  function loadScript(src){
    return new Promise(function(resolve, reject){
      var timer = setTimeout(function(){
        reject(new Error("Timed out loading Firebase SDK"));
      }, 8000);
      var existing = document.querySelector('script[src="' + src + '"]');
      if(existing){
        if(existing.dataset.failed === "1"){ existing.remove(); }
        else {
          existing.addEventListener("load", function(){ clearTimeout(timer); resolve(); }, { once:true });
          existing.addEventListener("error", function(){ clearTimeout(timer); reject(new Error("Couldn't load Firebase SDK")); }, { once:true });
          if(existing.dataset.loaded === "1"){ clearTimeout(timer); resolve(); }
          return;
        }
      }
      var script = document.createElement("script");
      script.src = src;
      script.onload = function(){ clearTimeout(timer); script.dataset.loaded = "1"; resolve(); };
      script.onerror = function(){
        clearTimeout(timer);
        script.dataset.failed = "1";
        script.remove();
        reject(new Error("Firestore is only available after Firebase is configured"));
      };
      document.head.appendChild(script);
    });
  }
  async function getFirestore(){
    if(window.firebase && firebase.apps && firebase.apps.length && firebase.firestore) return firebase.firestore();
    if(!firestorePromise){
      firestorePromise = (async function(){
        await loadScript("/__/firebase/" + FIREBASE_SDK_VERSION + "/firebase-app.js");
        await loadScript("/__/firebase/" + FIREBASE_SDK_VERSION + "/firebase-firestore.js");
        await loadScript("/__/firebase/init.js");
        if(!window.firebase || !firebase.apps || !firebase.apps.length || !firebase.firestore){
          throw new Error("Firebase Hosting config was not found");
        }
        return firebase.firestore();
      })().catch(function(err){
        firestorePromise = null;
        throw err;
      });
    }
    return firestorePromise;
  }
  function withTimeout(promise, ms, message){
    return new Promise(function(resolve, reject){
      var done = false;
      var timer = setTimeout(function(){
        if(done) return;
        done = true;
        reject(new Error(message));
      }, ms);
      promise.then(function(value){
        if(done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      }).catch(function(err){
        if(done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }
  function firestoreMessage(err){
    var code = err && err.code ? String(err.code) : "";
    var msg = err && err.message ? err.message : String(err || "Unknown error");
    if(code === "permission-denied") return "Firestore permission denied. Enable Firestore and update security rules for planFiles.";
    if(code === "unavailable") return "Firestore is unavailable. Check network access and Firebase project status.";
    return msg;
  }
  function fileModifiedLabel(value){
    if(!value) return "";
    if(value.toDate) value = value.toDate();
    var d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? "" : d.toLocaleString();
  }
  function showNotesModal(filename, notes){
    var m = document.createElement("div");
    m.className = "modal notes-modal";
    m.innerHTML =
      '<div class="box" role="dialog" aria-modal="true" aria-label="File notes">' +
        '<button class="btn close" type="button" aria-label="Close">&times;</button>' +
        '<h2></h2>' +
        '<p class="notebody"></p>' +
      '</div>';
    m.querySelector("h2").textContent = filename || "Notes";
    m.querySelector(".notebody").textContent = String(notes || "").trim() || "No notes";
    function close(){ m.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if(e.key === "Escape") close(); }
    m.querySelector(".close").addEventListener("click", close);
    m.addEventListener("click", function(e){ if(e.target === m) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(m);
    m.querySelector(".close").focus();
  }
  function renderFileRows(rows, message){
    var body = $("#filemanager-rows");
    body.innerHTML = "";
    if(message){
      body.innerHTML = '<tr><td class="emptycell" colspan="6">' + escapeHtml(message) + '</td></tr>';
      return;
    }
    if(!rows.length){
      body.innerHTML = '<tr><td class="emptycell" colspan="6">No authored floor plans saved yet.</td></tr>';
      return;
    }
    rows.forEach(function(row){
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td><b>' + escapeHtml(row.filename || "Untitled") + '</b></td>' +
        '<td>' + escapeHtml(row.department || "") + '</td>' +
        '<td>' + escapeHtml(row.observedBy || "") + '</td>' +
        '<td class="mono">' + escapeHtml(row.date || "") + '</td>' +
        '<td class="mono">' + escapeHtml(fileModifiedLabel(row.lastModified)) + '</td>' +
        '<td class="actions">' +
          '<button class="btn iconbtn" data-info type="button" title="Notes" aria-label="Notes">i</button>' +
          '<button class="btn" data-load type="button">Load</button>' +
          '<button class="btn danger" data-delete type="button">Delete</button>' +
        '</td>';
      tr.querySelector("[data-info]").addEventListener("click", function(){ showNotesModal(row.filename, row.notes); });
      tr.querySelector("[data-load]").addEventListener("click", function(){ loadFirestorePlan(row.id); });
      tr.querySelector("[data-delete]").addEventListener("click", function(){ deleteFirestorePlan(row.id, row.filename); });
      body.appendChild(tr);
    });
  }
  async function refreshFileManager(){
    renderFileRows([], "Loading files...");
    try{
      var db = await withTimeout(getFirestore(), 10000, "Timed out connecting to Firestore");
      var snap = await withTimeout(db.collection(FIRESTORE_COLLECTION).get(), 10000, "Timed out loading files from Firestore");
      var rows = [];
      snap.forEach(function(doc){
        var d = doc.data() || {};
        rows.push({
          id:doc.id,
          filename:d.filename,
          department:d.department,
          observedBy:d.observedBy,
          date:d.date,
          lastModified:d.lastModified,
          notes:d.notes
        });
      });
      rows.sort(function(a,b){
        return String(b.lastModified || "").localeCompare(String(a.lastModified || ""));
      });
      renderFileRows(rows);
    }catch(err){
      renderFileRows([], "File Manager unavailable: " + firestoreMessage(err));
    }
  }
  async function findPlanFileByFilename(db, filename){
    var snap = await withTimeout(
      db.collection(FIRESTORE_COLLECTION).where("filename", "==", filename).get(),
      10000,
      "Timed out checking existing file in Firestore"
    );
    var best = null;
    snap.forEach(function(doc){
      var data = doc.data() || {};
      var modified = String(data.lastModified || "");
      if(!best || modified > best.lastModified){
        best = { id:doc.id, lastModified:modified };
      }
    });
    return best;
  }
  function showPlanWorkspace(){
    $("#filemanager").hidden = true;
    $("#stagepanel").hidden = false;
    resize();
    requestRender();
  }
  function showFileManager(){
    cancelDraft();
    hideDrawbar();
    $("#stagepanel").hidden = true;
    $("#filemanager").hidden = false;
    refreshFileManager();
  }
  async function savePlanToFirestore(payload){
    try{
      var db = await withTimeout(getFirestore(), 10000, "Timed out connecting to Firestore");
      var settings = payload.settings || NUHS.loadSettings();
      var filename = settingsFilename(settings);
      settings.filename = filename;
      payload.settings = settings;
      var record = {
        filename:filename,
        department:settings.department || "",
        observedBy:settings.observedBy || "",
        date:settings.date || "",
        notes:settings.notes || "",
        lastModified:new Date().toISOString(),
        plan:payload
      };
      var targetId = null;
      if(currentFileRef.id && currentFileRef.filename === filename){
        targetId = currentFileRef.id;
      } else {
        var existing = await findPlanFileByFilename(db, filename);
        if(existing) targetId = existing.id;
      }
      if(targetId){
        await withTimeout(db.collection(FIRESTORE_COLLECTION).doc(targetId).set(record, { merge:true }), 10000, "Timed out saving to Firestore");
        currentFileRef = { id:targetId, filename:filename };
        persistCurrentFileRef();
      } else {
        var doc = await withTimeout(db.collection(FIRESTORE_COLLECTION).add(record), 10000, "Timed out saving to Firestore");
        currentFileRef = { id:doc.id, filename:filename };
        persistCurrentFileRef();
      }
      NUHS.toast("Saved to File Manager");
      if(!$("#filemanager").hidden) refreshFileManager();
    }catch(err){
      NUHS.toast("Firestore save failed: " + firestoreMessage(err), true);
    }
  }
  async function loadFirestorePlan(id){
    try{
      var db = await withTimeout(getFirestore(), 10000, "Timed out connecting to Firestore");
      var doc = await withTimeout(db.collection(FIRESTORE_COLLECTION).doc(id).get(), 10000, "Timed out loading from Firestore");
      if(!doc.exists) throw new Error("File not found");
      var data = doc.data() || {};
      if(!data.plan) throw new Error("Saved file has no plan data");
      applyPlanSettings(data.plan, data.filename);
      deserialize(data.plan);
      currentFileRef = { id:id, filename:settingsFilename(NUHS.loadSettings()) };
      persistCurrentFileRef();
      showPlanWorkspace();
      $("#coach").hidden = true;
      persist(); refreshRail(); syncScaleReadout(); syncLayerBoxes(); requestRender();
      NUHS.toast("Loaded " + currentFileRef.filename);
    }catch(err){
      NUHS.toast("Load failed: " + firestoreMessage(err), true);
    }
  }
  async function deleteFirestorePlan(id, filename){
    var ok = await NUHS.confirm({
      title:"Delete file?",
      body:"Delete " + (filename || "this floor plan") + " from File Manager.",
      confirmLabel:"Delete",
      cancelLabel:"Keep",
      danger:true
    });
    if(!ok) return;
    try{
      var db = await withTimeout(getFirestore(), 10000, "Timed out connecting to Firestore");
      await withTimeout(db.collection(FIRESTORE_COLLECTION).doc(id).delete(), 10000, "Timed out deleting from Firestore");
      if(currentFileRef.id === id) clearCurrentFileRef();
      NUHS.toast("File deleted");
      refreshFileManager();
    }catch(err){
      NUHS.toast("Delete failed: " + firestoreMessage(err), true);
    }
  }

  /* ---------- top bar wiring ---------- */
  NUHS.mountTopBar({
    active:"plan",
    onHelp:function(){
      NUHS.confirm({
        title:"Plan",
        body:"Pick a tool on the left, then use + Add in the right rail. Space or the hand tool pans, " +
             "scroll zooms, F fits the map, Esc cancels a drawing, Delete removes the selection.",
        confirmLabel:"Got it", cancelLabel:"Close"
      });
    },
    onImport:openImportDialog,
    onExport:openExportDialog,
    showPng:false,
    onSave:function(){ save(true); }
  });

  $("#importInput").addEventListener("change", async function(e){
    var f = e.target.files[0];
    if(!f) return;
    try{
      var d = await importPlanFile(f);
      applyPlanSettings(d);
      deserialize(d);
      clearCurrentFileRef();
      $("#coach").hidden = true;
      persist(); refreshRail(); syncScaleReadout(); syncLayerBoxes(); requestRender();
      if(d.kind !== "ed-flow-annotation") NUHS.toast("Plan imported");
      closeModal(activeImportModal);
      activeImportModal = null;
    }catch(err){
      NUHS.toast("Import failed: " + err.message, true);
    }finally{
      e.target.value = "";
    }
  });

  /* ---------- boot ---------- */
  function preloadRoleIcons(){
    state.roles.forEach(function(role){
      var im = new Image();
      im.onload = requestRender;
      im.src = role.icon;
      roleIconImages[role.id] = im;
    });
  }
  function boot(){
    preloadRoleIcons();
    restoreCurrentFileRef();
    setMode("zones");
    resize();
    var restored = false;
    try{
      var raw = localStorage.getItem(LS_KEY);
      if(raw){ deserialize(JSON.parse(raw)); restored = true; }
    }catch(err){}
    if(!restored || !state.map){
      $("#empty").hidden = false;
    }
    syncLayerBoxes();
    refreshRail();
    requestRender();
  }
  boot();
})();
