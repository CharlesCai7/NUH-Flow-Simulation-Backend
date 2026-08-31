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

  /* ---------- state ---------- */
  var state = {
    map:null,                 // {name, dataUrl, width, height, isTemplate}
    mapOpacity:1,
    scale:null,               // {ax,ay,bx,by,meters}
    zones:[], nodes:[], routes:[],
    roles: ROLE_DEFS.map(function(r){ return Object.assign({}, r); }),
    layers:{ zones:true, nodes:true, routes:true, grid:false },
    view:{ k:1, x:0, y:0 },
    mode:"zones",             // zones | routes | roles
    listTab:"zones",          // zones | nodes
    selectedId:null,
    hoverId:null,
    selectedRole:"doctor",
    stepsDone:{ zone:false, node:false, route:false, roles:false },
    coachStep:0               // 0 = not running, 1..4
  };

  var img = null;             // HTMLImageElement of the floorplan
  var tool = "select";        // select | pan
  var draft = null;           // in-progress drawing

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

  function stopPoint(s){
    if(s.targetType === "node"){ var n = nodeById(s.targetId); if(n) return {x:n.x, y:n.y}; }
    else { var z = zoneById(s.targetId); if(z) return polyCentroid(z.pts); }
    return { x:s.x||0, y:s.y||0 };
  }
  function stopLabel(s){
    if(s.targetType === "node"){ var n = nodeById(s.targetId); return n ? n.name : "(deleted node)"; }
    var z = zoneById(s.targetId); return z ? z.name : "(deleted zone)";
  }
  function routeTotalMin(r){
    return r.stops.reduce(function(sum,s,i){ return i===0 ? 0 : sum + (Number(s.waitMin)||0); }, 0);
  }
  function routePixels(r){
    var d = 0;
    for(var i=1;i<r.stops.length;i++){
      var a = stopPoint(r.stops[i-1]), b = stopPoint(r.stops[i]);
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
    state.view.k = Math.max(0.2, Math.min(4, state.view.k*factor));
    var after = toWorld(sx,sy);
    state.view.x += (after.x-before.x)*state.view.k;
    state.view.y += (after.y-before.y)*state.view.k;
    syncZoomSlider();
    requestRender();
  }
  function setZoom(pct, anchorX, anchorY){
    var ax = anchorX == null ? cssW/2 : anchorX, ay = anchorY == null ? cssH/2 : anchorY;
    var before = toWorld(ax,ay);
    state.view.k = Math.max(0.2, Math.min(4, pct/100));
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
    if(r.stops.length < 2) return;
    var sel = state.selectedId === r.id, hov = state.hoverId === r.id, v = state.view;
    var col = roleById(r.roleId).color;
    ctx.beginPath();
    r.stops.forEach(function(s,i){
      var p = stopPoint(s);
      i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y);
    });
    ctx.lineWidth = (sel ? 5 : hov ? 4.4 : 3)/v.k;
    ctx.strokeStyle = col;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.globalAlpha = (sel || hov) ? 1 : 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;

    r.stops.forEach(function(s){
      var p = stopPoint(s);
      ctx.beginPath();
      ctx.arc(p.x, p.y, (sel ? 5.5 : hov ? 5.2 : 4.5)/v.k, 0, Math.PI*2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 1.6/v.k;
      ctx.strokeStyle = css("--command-bg");
      ctx.stroke();
    });

    // direction arrows at each leg midpoint
    for(var i=1;i<r.stops.length;i++){
      var a = stopPoint(r.stops[i-1]), b = stopPoint(r.stops[i]);
      arrow((a.x+b.x)/2, (a.y+b.y)/2, Math.atan2(b.y-a.y, b.x-a.x), (sel?8:hov?7:6)/v.k, col);
    }
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
      if(draft.stops.length){
        ctx.beginPath();
        draft.stops.forEach(function(s,i){
          var p = stopPoint(s);
          i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y);
        });
        if(draft.hover){
          var last = stopPoint(draft.stops[draft.stops.length-1]);
          ctx.moveTo(last.x,last.y); ctx.lineTo(draft.hover.x, draft.hover.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        draft.stops.forEach(function(s){
          var p = stopPoint(s);
          ctx.beginPath();
          ctx.arc(p.x,p.y, 5/v.k, 0, Math.PI*2);
          ctx.fillStyle = draft.color || css("--nuhs-cyan"); ctx.fill();
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
        for(var s=1;s<rt.stops.length;s++){
          if(dist2seg(w, stopPoint(rt.stops[s-1]), stopPoint(rt.stops[s])) <= tol) return rt;
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
  /* Routes chain nodes only — a zone is an area, a node is the touchpoint
     inside it that a person actually walks to. */
  function hitTarget(w){
    var tol = Math.max(18/state.view.k, 10);   // ~18 screen px, comfortable at any zoom
    var best = null, bestD = Infinity;
    state.nodes.forEach(function(n){
      var d = Math.hypot(n.x-w.x, n.y-w.y);
      if(d <= tol && d < bestD){ bestD = d; best = n; }
    });
    return best ? { targetType:"node", targetId:best.id } : null;
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

  canvas.addEventListener("pointerdown", function(e){
    if(!state.map) return;
    canvas.setPointerCapture(e.pointerId);
    var sp = evPos(e), w = toWorld(sp.x, sp.y);

    if(tool === "pan" || spaceDown || e.button === 1){
      panning = { sx:sp.x, sy:sp.y, vx:state.view.x, vy:state.view.y };
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
        var t = hitTarget(w);
        if(!t){ NUHS.toast("Click on a node", true); return; }
        // clicking the node just placed is a no-op; double-clicking it finishes
        var last = draft.stops[draft.stops.length-1];
        if(last && last.targetId === t.targetId) return;
        addRouteStop(t);
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
    if(draft){
      if(draft.kind === "zone-rect" && draft.dragging) draft.b = w;
      else draft.hover = w;
      if(draft.kind === "route"){
        // zones are inert while chaining a route; only nodes can be snapped to
        var t = hitTarget(w);
        var id = t ? t.targetId : null;
        if(id !== draft.snapId){ draft.snapId = id; setHover(null); }
        canvas.style.cursor = id ? "pointer" : "crosshair";
      }
      requestRender();
    } else if(tool !== "pan" && !spaceDown){
      var hit = hitTest(w);
      setHover(hit ? hit.id : null);
      canvas.style.cursor = hit ? "pointer" : "default";
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
      // a duration prompt opened by the first click of this double-click is
      // still on screen; let it confirm, then finish
      if(pendingSection){ pendingSection.finishAfter = true; return; }
      var sp = evPos(e), t = hitTarget(toWorld(sp.x, sp.y));
      var last = draft.stops[draft.stops.length-1];
      if(draft.stops.length >= 2 && (!t || !last || t.targetId === last.targetId)) finishRoute();
      else if(draft.stops.length < 2) NUHS.toast("A route needs at least two nodes", true);
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
    draft = { kind:"route", stops:[], color:roleById(state.roles[0].id).color };
    pendingSection = null;
    showDrawbar("route");
    setCursor();
    requestRender();
  }

  function addRouteStop(t){
    if(draft.stops.length === 0){
      // the first click only establishes where the route starts
      draft.stops.push({ targetType:t.targetType, targetId:t.targetId, waitMin:0 });
      updateDrawbar();
      requestRender();
      return;
    }
    var pop = popover(
      '<h3>Section duration</h3>' +
      '<label class="field" style="margin-bottom:0"><span>Wait duration (minutes)</span>' +
        '<input type="number" id="sd-min" class="num" min="0" step="1" value="5"></label>' +
      '<div class="row">' +
        '<button class="btn" id="sd-back" type="button">Back</button>' +
        '<button class="btn primary" id="sd-ok" type="button">Confirm</button>' +
      '</div>',
      function(p){
        var f = p.querySelector("#sd-min");
        f.focus(); f.select();
        function ok(){
          var m = Math.max(0, Number(f.value) || 0);
          draft.stops.push({ targetType:t.targetType, targetId:t.targetId, waitMin:m });
          var finishNow = pendingSection && pendingSection.finishAfter;
          pendingSection = null;
          p.remove(); updateDrawbar(); requestRender();
          if(finishNow && draft.stops.length >= 2) finishRoute();
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
    if(!draft || draft.stops.length < 2) return;
    var stops = draft.stops.slice();
    draft = null; pendingSection = null; hideDrawbar(); setCursor();

    var pop = popover(
      '<h3>Name new route</h3>' +
      '<label class="field"><span>Label</span><input type="text" id="rt-label"></label>' +
      '<label class="field" style="margin-bottom:0"><span>Role</span>' +
        '<select id="rt-role"></select></label>' +
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
          var r = { id:uid("r_"),
                    label: NUHS.uniqueName(lab.value.trim() || "New Route",
                                           state.routes.map(function(x){ return x.label; })),
                    roleId: sel.value, shift:"Day", stops:stops };
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
          draft = { kind:"route", stops:stops, color:css("--nuhs-cyan") };
          showDrawbar("route"); updateDrawbar(); requestRender();
        });
        lab.focus(); lab.select();
      }
    );
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
  function showDrawbar(kind, shape){
    var bar = $("#drawbar"), a = $("#draw-a"), b = $("#draw-b"),
        fin = $("#draw-fin"), steps = $("#draw-steps"), foot = $("#draw-foot");
    bar.hidden = false;
    bar.classList.remove("stack");
    steps.hidden = true;
    foot.hidden = true;
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
        '1. Click on node to start<br>' +
        '2. Click to add next destination<br>' +
        '3. Double click or click button to finish';
      // on a route the button reads as the last step, so it sits under the
      // instructions rather than inline with the title
      foot.hidden = false;
      foot.appendChild(fin);
      fin.hidden = false;
      fin.onclick = function(){
        if(draft && draft.stops.length >= 2) finishRoute();
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
    var ready = draft.kind === "route"     ? draft.stops.length >= 2
              : draft.kind === "zone-poly" ? draft.pts.length >= 3
              : false;
    fin.disabled = !ready;
    fin.classList.toggle("active", ready);
  }

  function hideDrawbar(){ $("#drawbar").hidden = true; }
  function cancelDraft(){
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
    state.mode = m;
    cancelDraft();
    state.selectedId = null;
    document.querySelectorAll(".tool").forEach(function(b){
      b.classList.toggle("active", b.dataset.mode === m);
    });
    var roles = $("#rolesgrid"), stage = $("#stagepanel");
    if(m === "roles"){ roles.hidden = false; stage.style.display = "none"; }
    else { roles.hidden = true; stage.style.display = ""; }
    $("#railr").classList.toggle("solo", m === "roles");
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
    renderRoles();
  }

  function renderTabs(){
    var tabs = $("#rrtabs");
    tabs.innerHTML = "";
    if(state.mode === "roles") return;
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
    if(state.mode === "roles") return;

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

    if(state.mode === "roles"){
      title.textContent = "Role properties";
      renderRoleProps(box);
      return;
    }

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

    var roleSel = document.createElement("select");
    state.roles.forEach(function(role){
      var o = document.createElement("option");
      o.value = role.id; o.textContent = role.label;
      if(role.id === r.roleId) o.selected = true;
      roleSel.appendChild(o);
    });
    roleSel.addEventListener("change", function(){
      r.roleId = roleSel.value; persist(); renderList(); requestRender();
    });
    var rf = field("Role", roleSel);
    rf.style.marginTop = "14px";
    box.appendChild(rf);

    var shiftSel = document.createElement("select");
    ["Day","Evening","Night"].forEach(function(s){
      var o = document.createElement("option");
      o.value = s; o.textContent = s;
      if(s === r.shift) o.selected = true;
      shiftSel.appendChild(o);
    });
    shiftSel.addEventListener("change", function(){ r.shift = shiftSel.value; persist(); });
    box.appendChild(field("Shift", shiftSel));

    var h = document.createElement("div");
    h.className = "panel-h";
    h.style.cssText = "padding:6px 0 4px";
    h.textContent = "Sections";
    box.appendChild(h);

    var list = document.createElement("div");
    list.className = "sections";
    for(var i=1;i<r.stops.length;i++){
      (function(i){
        var row = document.createElement("div");
        row.className = "secrow";
        var lbl = document.createElement("span");
        lbl.className = "lbl";
        lbl.textContent = stopLabel(r.stops[i-1]) + " → " + stopLabel(r.stops[i]);
        var inp = document.createElement("input");
        inp.type = "number"; inp.min = "0"; inp.value = r.stops[i].waitMin;
        inp.addEventListener("change", function(){
          r.stops[i].waitMin = Math.max(0, Number(inp.value)||0);
          persist(); renderProps();
        });
        row.appendChild(lbl); row.appendChild(inp);
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
    p.innerHTML = r.stops.length + " stops · <b>" +
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
    state.zones  = state.zones.filter(function(o){ return o.id !== id; });
    state.nodes  = state.nodes.filter(function(o){ return o.id !== id; });
    state.routes = state.routes.filter(function(o){ return o.id !== id; });
    state.routes.forEach(function(r){
      r.stops = r.stops.filter(function(s){ return s.targetId !== id; });
    });
    state.routes = state.routes.filter(function(r){ return r.stops.length >= 2; });
    state.selectedId = null;
    persist(); refreshRail(); requestRender();
  }

  /* ---------- roles ---------- */
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

  /* ---------- step coach ---------- */
  var COACH = [
    { key:"zone",  title:"Add a zone",  body:"Outline an operational area on the map. Rectangle for a room, polygon for an irregular space.", cta:"Add zone" },
    { key:"node",  title:"Add a node",  body:"Place a touchpoint inside a zone — a desk, a bay, a station a route can stop at.", cta:"Add node" },
    { key:"route", title:"Add a route", body:"Chain zones and nodes into a path, giving each section the time it takes.", cta:"Add route" },
    { key:"roles", title:"Edit roles",  body:"Set staffing and colour for each role. Route colour follows the role that walks it.", cta:"Edit roles" }
  ];
  function showCoach(step){
    state.coachStep = step;
    var c = $("#coach");
    if(step < 1 || step > COACH.length){ c.hidden = true; return; }
    var d = COACH[step-1];
    c.hidden = false;
    $("#coach-eyebrow").textContent = step === 1 ? "Step 1 of 4" : "Step " + (step-1) + " complete";
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
    else if(step === 4){ setMode("roles"); }
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
  $("#fileInput").addEventListener("change", function(e){
    var f = e.target.files[0];
    if(!f) return;
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
  function serialize(withImage){
    var mpp = metersPerPixel();
    var s = NUHS.loadSettings();
    return {
      kind:"ed-flow-plan", version:3,
      exportedAt:new Date().toISOString(),
      settings:s,
      map: state.map ? {
        name: state.map.name,
        width: state.map.width, height: state.map.height,
        isTemplate: !!state.map.isTemplate,
        embedded: !!(withImage && !state.map.isTemplate),
        dataUrl: (withImage && !state.map.isTemplate) ? state.map.dataUrl : null
      } : null,
      mapOpacity: state.mapOpacity,
      layers: Object.assign({}, state.layers),
      scale: state.scale ? Object.assign({ metersPerPixel:mpp }, state.scale) : null,
      roles: state.roles.map(function(r){
        return { id:r.id, label:r.label, color:r.color, staffing:r.staffing, unit:r.unit, icon:r.icon };
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
        return {
          id:r.id, label:r.label, roleId:r.roleId, roleLabel:roleById(r.roleId).label,
          shift:r.shift,
          totalMinutes: routeTotalMin(r),
          distancePixels: round2(routePixels(r)),
          distanceMeters: m == null ? null : round2(m),
          stops: r.stops.map(function(s,i){
            return { index:i, targetType:s.targetType, targetId:s.targetId,
                     name: stopLabel(s), waitMin: i === 0 ? 0 : (Number(s.waitMin)||0) };
          }),
          sections: r.stops.slice(1).map(function(s,i){
            var a = stopPoint(r.stops[i]), b = stopPoint(s);
            var d = Math.hypot(b.x-a.x, b.y-a.y);
            return { from: stopLabel(r.stops[i]), to: stopLabel(s),
                     minutes: Number(s.waitMin)||0,
                     distanceMeters: mpp == null ? null : round2(d*mpp) };
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
      if(explicit) NUHS.toast("Saved to this browser");
    }catch(err){
      try{
        localStorage.setItem(LS_KEY, JSON.stringify(serialize(false)));
        if(explicit) NUHS.toast("Saved — the floorplan image was too large to store, re-upload it on reload", true);
      }catch(e2){
        if(explicit) NUHS.toast("Couldn't save locally — use Export", true);
      }
    }
  }

  function deserialize(d){
    if(d.kind === "ed-flow-annotation") return deserializeV2(d);

    state.mapOpacity = d.mapOpacity == null ? 1 : d.mapOpacity;
    state.layers = Object.assign({ zones:true,nodes:true,routes:true,grid:false }, d.layers||{});
    state.scale = d.scale ? { ax:d.scale.ax, ay:d.scale.ay, bx:d.scale.bx, by:d.scale.by,
                              meters:d.scale.meters } : null;
    if(d.roles && d.roles.length){
      state.roles = ROLE_DEFS.map(function(def){
        var found = d.roles.find(function(r){ return r.id === def.id; });
        var role = found ? Object.assign({}, def, found) : Object.assign({}, def);
        role.icon = def.icon;   // asset path comes from code, not from the file
        return role;
      });
    }
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
      return { id:r.id||uid("r_"), label:r.label||"Route", roleId:r.roleId||"other",
               shift:r.shift||"Day",
               stops:(r.stops||[]).map(function(s,i){
                 return { targetType:s.targetType||"zone", targetId:s.targetId,
                          waitMin: i === 0 ? 0 : (Number(s.waitMin)||0) };
               }) };
    }).filter(function(r){ return r.stops.length >= 2; });
    state.selectedId = null;
    if(d.view) state.view = Object.assign({}, d.view);

    if(d.map){
      state.map = { name:d.map.name||"floorplan", width:d.map.width||0, height:d.map.height||0,
                    isTemplate:!!d.map.isTemplate,
                    dataUrl: d.map.isTemplate ? TEMPLATE_MAP : (d.map.dataUrl||null) };
      if(state.map.dataUrl){
        loadImage(state.map.dataUrl, onMapReady);
      } else {
        img = null;
        onMapReady();
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
      return { id:r.id||uid("r_"), label:r.label || "Route",
               roleId: ACTOR_TO_ROLE[r.actor] || "other",
               shift: r.shift || "Day", stops:stops };
    }).filter(function(r){ return r.stops.length >= 2; });

    if(d.floorplan){
      state.map = { name:d.floorplan.name||"floorplan", width:d.floorplan.width||0,
                    height:d.floorplan.height||0, isTemplate:false,
                    dataUrl:d.floorplan.dataUrl||null };
      if(state.map.dataUrl) loadImage(state.map.dataUrl, onMapReady);
      else { img = null; onMapReady();
             NUHS.toast("Imported — re-attach " + state.map.name + " with Replace", true); }
    }
    NUHS.toast("Imported and upgraded from the previous format");
  }

  /* ---------- PNG export ---------- */
  function exportPng(){
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
      if(r.stops.length < 2) return;
      var col = roleById(r.roleId).color;
      g.beginPath();
      r.stops.forEach(function(s,i){
        var p = stopPoint(s); i ? g.lineTo(p.x,p.y) : g.moveTo(p.x,p.y);
      });
      g.lineWidth = 3.4*S; g.strokeStyle = col; g.globalAlpha = 0.9; g.stroke(); g.globalAlpha = 1;
      r.stops.forEach(function(s){
        var p = stopPoint(s);
        g.beginPath(); g.arc(p.x,p.y,5*S,0,Math.PI*2);
        g.fillStyle = col; g.fill();
      });
      var p0 = stopPoint(r.stops[0]);
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

    var s = NUHS.loadSettings();
    c.toBlob(function(blob){
      NUHS.downloadBlob(blob, NUHS.slug(s.department, "ed-flow") + "-plan.png");
      NUHS.toast("PNG exported");
    });
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
    onImport:function(){ $("#importInput").click(); },
    onExport:function(){
      var s = NUHS.loadSettings();
      var blob = new Blob([JSON.stringify(serialize(true),null,2)], { type:"application/json" });
      NUHS.downloadBlob(blob, NUHS.slug(s.department, "ed-flow") + "-plan.json");
      NUHS.toast("Plan exported");
    },
    onPng:exportPng,
    onSave:function(){ save(true); }
  });

  $("#importInput").addEventListener("change", function(e){
    var f = e.target.files[0];
    if(!f) return;
    var reader = new FileReader();
    reader.onload = function(){
      try{
        var d = JSON.parse(reader.result);
        if(d.kind && d.kind !== "ed-flow-plan" && d.kind !== "ed-flow-annotation")
          throw new Error("not a plan file");
        deserialize(d);
        $("#coach").hidden = true;
        persist(); refreshRail(); syncScaleReadout(); syncLayerBoxes(); requestRender();
        if(d.kind !== "ed-flow-annotation") NUHS.toast("Plan imported");
      }catch(err){
        NUHS.toast("Import failed: " + err.message, true);
      }
    };
    reader.readAsText(f);
    e.target.value = "";
  });

  /* ---------- boot ---------- */
  function boot(){
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
