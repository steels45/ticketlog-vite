import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ── UTILS ─────────────────────────────────────────────────────────────────
function ordinal(n) {
  const s = ["th","st","nd","rd"], v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}
function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function formatDate(iso) {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
function formatDateShort(iso) {
  return new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

// Pay period: Friday → Thursday
function getPayPeriod(offset = 0) {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 5=Fri
  const diffToFriday = (day >= 5) ? day - 5 : day + 2;
  const friday = new Date(now);
  friday.setDate(now.getDate() - diffToFriday + offset * 7);
  friday.setHours(0, 0, 0, 0);
  const thursday = new Date(friday);
  thursday.setDate(friday.getDate() + 6);
  thursday.setHours(23, 59, 59, 999);
  return { start: friday, end: thursday };
}
function inPeriod(timestamp, period) {
  const d = new Date(timestamp);
  return d >= period.start && d <= period.end;
}
function periodLabel(period) {
  return `${period.start.toLocaleDateString([],{month:"short",day:"numeric"})} – ${period.end.toLocaleDateString([],{month:"short",day:"numeric",year:"numeric"})}`;
}

// ── SCANNER CONSTANTS ─────────────────────────────────────────────────────
const MAX_LONG_EDGE = 2000;
const JPEG_QUALITY = 0.85;
const STABILITY_MS = 600; // reduced from 800ms

// ── LIVE DOCUMENT SCANNER (powered by Scanic) ─────────────────────────────
function LiveDocumentScanner({ onCapture, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const scannerRef = useRef(null); // persistent Scanic Scanner instance
  const stableRef = useRef({ corners: null, since: null });
  const smoothRef = useRef([]);
  const lockedRef = useRef(null);
  const SMOOTH_FRAMES = 3; // reduced from 4
  const CONFIRM_FRAMES = 2; // reduced from 3 — show outline faster
  const LOCK_DRIFT = 30;

  const [status, setStatus] = useState("Initializing camera…");
  const [detected, setDetected] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [scanicReady, setScanicReady] = useState(false);
  const [stabilityProgress, setStabilityProgress] = useState(0); // 0-1
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState(null);

  // Load Scanic Scanner instance
  useEffect(() => {
    let cancelled = false;
    async function loadScanic() {
      try {
        const { Scanner } = await import("scanic");
        const scanner = new Scanner();
        await scanner.initialize();
        if (!cancelled) {
          scannerRef.current = scanner;
          setScanicReady(true);
        }
      } catch (err) {
        // Scanic failed to load silently
      }
    }
    loadScanic();
    return () => { cancelled = true; };
  }, []);

  // Start camera
  useEffect(() => {
    let cancelled = false;
    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setStatus("Loading scanner…");
        }
      } catch {
        if (!cancelled) setError("Camera access denied. Use the manual option below.");
      }
    }
    startCamera();
    return () => {
      cancelled = true;
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update status when ready
  useEffect(() => {
    if (scanicReady) setStatus("Point camera at ticket");
  }, [scanicReady]);

  // Detection loop using persistent Scanner instance
  useEffect(() => {
    if (!scanicReady || !scannerRef.current) return;
    const INTERVAL = 1000 / 12; // 12fps — faster tracking
    let lastRun = 0;

    async function detect(now) {
      rafRef.current = requestAnimationFrame(detect);
      if (now - lastRun < INTERVAL) return;
      lastRun = now;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2 || capturing) return;


      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;

      // Draw current frame to canvas
      canvas.width = vw; canvas.height = vh;
      canvas.getContext("2d").drawImage(video, 0, 0, vw, vh);

      let rawCorners = null;
      try {
        const result = await scannerRef.current.scan(canvas, {
          mode: "detect",
          detector: "ml",
          maxProcessingDimension: 640,
          ml: {
            assetBaseUrl: "/",
          },
        });
        if (result.success && result.corners && (result.score === undefined || result.score > 0.5)) {
          const c = result.corners;
          const raw = [
            { x: c.topLeft.x, y: c.topLeft.y },
            { x: c.topRight.x, y: c.topRight.y },
            { x: c.bottomRight.x, y: c.bottomRight.y },
            { x: c.bottomLeft.x, y: c.bottomLeft.y },
          ];
          // Expand corners outward from center by ~12px to compensate for
          // DocCornerNet's conservative boundary detection on light backgrounds
          const EXPAND = 12;
          const cx = raw.reduce((s, p) => s + p.x, 0) / 4;
          const cy = raw.reduce((s, p) => s + p.y, 0) / 4;
          rawCorners = raw.map(p => ({
            x: p.x + (p.x >= cx ? EXPAND : -EXPAND),
            y: p.y + (p.y >= cy ? EXPAND : -EXPAND),
          }));
        }
      } catch {}

      // ── Temporal smoothing ────────────────────────────────────────────────
      const smooth = smoothRef.current;
      if (rawCorners) {
        smooth.push(rawCorners);
        if (smooth.length > SMOOTH_FRAMES) smooth.shift();
      } else {
        if (smooth.length > 0) smooth.shift();
      }

      let smoothedCorners = null;
      if (smooth.length >= CONFIRM_FRAMES) {
        smoothedCorners = smooth[0].map((_, ci) => ({
          x: smooth.reduce((s, f) => s + f[ci].x, 0) / smooth.length,
          y: smooth.reduce((s, f) => s + f[ci].y, 0) / smooth.length,
        }));
      }

      // ── Hysteresis ────────────────────────────────────────────────────────
      let displayCorners = null;
      if (smoothedCorners) {
        const locked = lockedRef.current;
        if (locked) {
          const drift = smoothedCorners.reduce((max, c, i) =>
            Math.max(max, Math.abs(c.x - locked[i].x), Math.abs(c.y - locked[i].y)), 0);
          lockedRef.current = drift < LOCK_DRIFT
            ? locked.map((lc, i) => ({ x: lc.x * 0.4 + smoothedCorners[i].x * 0.6, y: lc.y * 0.4 + smoothedCorners[i].y * 0.6 }))
            : smoothedCorners;
        } else {
          lockedRef.current = smoothedCorners;
        }
        displayCorners = lockedRef.current;
      } else {
        lockedRef.current = null;
      }

      updateOverlay(displayCorners, vw, vh);

      // ── Stability → auto capture ──────────────────────────────────────────
      if (displayCorners) {
        const s = stableRef.current;
        const same = s.corners && displayCorners.every((c, i) =>
          Math.abs(c.x - s.corners[i].x) < 8 && Math.abs(c.y - s.corners[i].y) < 8
        );
        if (same) {
          const elapsed = Date.now() - s.since;
          const progress = Math.min(elapsed / STABILITY_MS, 1);
          setStabilityProgress(progress);
          if (elapsed >= STABILITY_MS) {
            stableRef.current = { corners: null, since: null };
            setStabilityProgress(0);
            setFlash(true);
            setTimeout(() => setFlash(false), 150);
            doCapture(displayCorners, canvas, vw, vh);
          }
        } else {
          stableRef.current = { corners: displayCorners, since: Date.now() };
          setStabilityProgress(0);
        }
        setDetected(true);
        setStatus("Hold still…");
      } else {
        stableRef.current = { corners: null, since: null };
        setStabilityProgress(0);
        setDetected(false);
        setStatus("Point camera at ticket");
      }
    }

    rafRef.current = requestAnimationFrame(detect);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanicReady, capturing]);

  function updateOverlay(corners, vw, vh) {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (!corners) { overlay.innerHTML = ""; return; }
    const rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Set explicit viewBox to match video dimensions
    overlay.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
    overlay.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const pts = corners.map(c => `${c.x},${c.y}`).join(" ");
    overlay.innerHTML = `
      <polygon points="${pts}" fill="rgba(30,58,95,0.15)" stroke="#1e3a5f" stroke-width="8" stroke-dasharray="20,10"/>
      ${corners.map(c => `<circle cx="${c.x}" cy="${c.y}" r="20" fill="#1e3a5f"/>`).join("")}
    `;
  }

  async function doCapture(corners, srcCanvas, vw, vh) {
    if (capturing) return;
    setCapturing(true);
    setStatus("Capturing…");
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    try {
      // Use Scanic to extract with perspective correction
      const scCorners = {
        topLeft: corners[0],
        topRight: corners[1],
        bottomRight: corners[2],
        bottomLeft: corners[3],
      };

      const { extractDocument } = await import("scanic");
      const result = await extractDocument(srcCanvas, scCorners, {
        output: "dataurl",
        maxOutputDimension: MAX_LONG_EDGE,
      });

      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());

      if (result && result.output) {
        onCapture(result.output);
      } else {
        // Fallback: full frame
        onCapture(srcCanvas.toDataURL("image/jpeg", JPEG_QUALITY));
      }
    } catch {
      // Fallback: full frame
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      onCapture(srcCanvas.toDataURL("image/jpeg", JPEG_QUALITY));
    }
  }

  function manualCapture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const vw = video.videoWidth, vh = video.videoHeight;
    canvas.width = vw; canvas.height = vh;
    canvas.getContext("2d").drawImage(video, 0, 0, vw, vh);

    const corners = lockedRef.current || stableRef.current.corners;
    if (corners) {
      doCapture(corners, canvas, vw, vh);
    } else {
      setCapturing(true);
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      onCapture(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    }
  }

  return (
    <div style={SS.scannerWrap}>
      <video ref={videoRef} style={SS.video} playsInline muted autoPlay />
      <svg ref={overlayRef} style={SS.overlay} />

      {/* White flash on capture */}
      {flash && <div style={SS.flashOverlay}/>}

      {/* Guide corners when no detection */}
      {!detected && !capturing && (
        <div style={SS.guideFrame}>
          <div style={{...SS.guideCorner,...SS.guideCornerTL}}/>
          <div style={{...SS.guideCorner,...SS.guideCornerTR}}/>
          <div style={{...SS.guideCorner,...SS.guideCornerBL}}/>
          <div style={{...SS.guideCorner,...SS.guideCornerBR}}/>
        </div>
      )}

      {/* Status bar */}
      <div style={SS.statusBar}>
        <div style={{...SS.statusDot,...(detected ? SS.statusDotGreen : {})}}/>
        <span style={SS.statusText}>{error || status}</span>
        {!scanicReady && !error && (
          <span style={SS.loadingBadge}>Loading…</span>
        )}
      </div>

      {/* Circular progress ring — shown during stability check */}
      {detected && !capturing && stabilityProgress > 0 && (
        <div style={SS.ringWrap}>
          <svg width="80" height="80" viewBox="0 0 80 80">
            {/* Track */}
            <circle cx="40" cy="40" r="34" fill="none"
              stroke="rgba(255,255,255,0.2)" strokeWidth="6"/>
            {/* Progress arc */}
            <circle cx="40" cy="40" r="34" fill="none"
              stroke="#1e3a5f" strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 34}`}
              strokeDashoffset={`${2 * Math.PI * 34 * (1 - stabilityProgress)}`}
              transform="rotate(-90 40 40)"
              style={{transition:"stroke-dashoffset 0.05s linear"}}
            />
            {/* Center dot */}
            <circle cx="40" cy="40" r="8" fill="#22c55e"/>
          </svg>
          <div style={SS.ringLabel}>Hold still…</div>
        </div>
      )}

      {/* Controls */}
      <div style={SS.controls}>
        <button style={SS.closeBtn} onClick={onClose}>✕ Cancel</button>
        <button style={{...SS.captureBtn,...(capturing ? SS.captureBtnCapturing : {})}}
          onClick={manualCapture} disabled={capturing}>
          <div style={SS.captureRing}><div style={SS.captureInner}/></div>
        </button>
        <div style={{width:80}}/>
      </div>
      <canvas ref={canvasRef} style={{display:"none"}}/>
    </div>
  );
}

const SS = {
  scannerWrap: { position:"fixed", inset:0, background:"#000", zIndex:200, display:"flex", flexDirection:"column" },
  video: { position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"cover" },
  overlay: { position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none", objectFit:"cover" },
  guideFrame: { position:"absolute", inset:"15%", border:"2px solid rgba(255,255,255,0.3)", borderRadius:8, pointerEvents:"none" },
  guideCorner: { position:"absolute", width:24, height:24, borderColor:"#fff", borderStyle:"solid" },
  guideCornerTL: { top:-2, left:-2, borderWidth:"3px 0 0 3px", borderRadius:"4px 0 0 0" },
  guideCornerTR: { top:-2, right:-2, borderWidth:"3px 3px 0 0", borderRadius:"0 4px 0 0" },
  guideCornerBL: { bottom:-2, left:-2, borderWidth:"0 0 3px 3px", borderRadius:"0 0 0 4px" },
  guideCornerBR: { bottom:-2, right:-2, borderWidth:"0 3px 3px 0", borderRadius:"0 0 4px 0" },
  statusBar: { position:"absolute", top:0, left:0, right:0, padding:"52px 20px 12px", background:"linear-gradient(to bottom, rgba(0,0,0,0.7), transparent)", display:"flex", alignItems:"center", gap:8 },
  statusDot: { width:8, height:8, borderRadius:"50%", background:"#94a3b8", flexShrink:0 },
  statusDotGreen: { background:"#22c55e", boxShadow:"0 0 6px #22c55e" },
  statusText: { color:"#fff", fontSize:14, fontWeight:600 },
  loadingBadge: { marginLeft:"auto", fontSize:11, color:"rgba(255,255,255,.6)", background:"rgba(255,255,255,.1)", padding:"3px 10px", borderRadius:20 },
  stabilityWrap: { display:"none" }, // replaced by ring
  stabilityBar: { display:"none" }, // replaced by ring
  flashOverlay: { position:"absolute", inset:0, background:"#fff", zIndex:10, opacity:0.85, pointerEvents:"none" },
  ringWrap: { position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)", display:"flex", flexDirection:"column", alignItems:"center", gap:10, pointerEvents:"none" },
  ringLabel: { color:"#fff", fontSize:15, fontWeight:700, textShadow:"0 1px 4px rgba(0,0,0,0.5)", letterSpacing:"0.02em" },
  controls: { position:"absolute", bottom:0, left:0, right:0, padding:"20px 20px 40px", display:"flex", alignItems:"center", justifyContent:"space-between", background:"linear-gradient(to top, rgba(0,0,0,0.7), transparent)" },
  closeBtn: { background:"rgba(255,255,255,.15)", border:"none", color:"#fff", fontWeight:600, fontSize:14, padding:"10px 16px", borderRadius:20, cursor:"pointer" },
  captureBtn: { width:72, height:72, borderRadius:"50%", background:"transparent", border:"none", cursor:"pointer", padding:0 },
  captureBtnCapturing: { opacity:.5 },
  captureRing: { width:72, height:72, borderRadius:"50%", border:"3px solid #fff", display:"flex", alignItems:"center", justifyContent:"center" },
  captureInner: { width:56, height:56, borderRadius:"50%", background:"#fff" },
};


const BROKER_COLORS = ["#1e3a5f","#16a34a","#7c3aed","#ea580c","#0891b2","#be185d","#854d0e","#065f46"];
function brokerColor(brokers, name) {
  const idx = brokers.findIndex(b=>b.name===name);
  return BROKER_COLORS[idx % BROKER_COLORS.length] || "#64748b";
}

// ── BACKGROUND TRIM ───────────────────────────────────────────────────────

// ── BLUR DETECTION ────────────────────────────────────────────────────────
function measureBlur(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale=Math.min(1,400/Math.max(img.width,img.height));
      const w=Math.round(img.width*scale), h=Math.round(img.height*scale);
      const canvas=document.createElement("canvas"); canvas.width=w; canvas.height=h;
      const ctx=canvas.getContext("2d"); ctx.drawImage(img,0,0,w,h);
      const {data}=ctx.getImageData(0,0,w,h);
      let sum=0,sumSq=0,n=0;
      for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
        const idx=(y*w+x)*4;
        const gray=0.299*data[idx]+0.587*data[idx+1]+0.114*data[idx+2];
        const top=0.299*data[((y-1)*w+x)*4]+0.587*data[((y-1)*w+x)*4+1]+0.114*data[((y-1)*w+x)*4+2];
        const bot=0.299*data[((y+1)*w+x)*4]+0.587*data[((y+1)*w+x)*4+1]+0.114*data[((y+1)*w+x)*4+2];
        const lft=0.299*data[(y*w+x-1)*4]+0.587*data[(y*w+x-1)*4+1]+0.114*data[(y*w+x-1)*4+2];
        const rgt=0.299*data[(y*w+x+1)*4]+0.587*data[(y*w+x+1)*4+1]+0.114*data[(y*w+x+1)*4+2];
        const lap=Math.abs(-top-bot-lft-rgt+4*gray);
        sum+=lap; sumSq+=lap*lap; n++;
      }
      const mean=sum/n; resolve(sumSq/n-mean*mean);
    };
    img.src=dataUrl;
  });
}

// ── GPS ───────────────────────────────────────────────────────────────────
async function getGPSLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const {latitude,longitude,accuracy}=pos.coords;
        let address=null;
        try {
          const r=await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
          const d=await r.json(); address=d.display_name||null;
        } catch {}
        resolve({latitude,longitude,accuracy:Math.round(accuracy),address});
      },
      ()=>resolve(null),
      {enableHighAccuracy:true,timeout:8000,maximumAge:0}
    );
  });
}

// ── EXTRACTION ────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
const EXTRACTION_PROMPT = `You are an expert at reading trucking and hauling weight tickets from multiple suppliers.

You will see a ticket image. First identify which supplier issued it by looking for logos, company names, or distinctive layouts. Then extract the data using that supplier's field names.

KNOWN TICKET TYPES AND THEIR FIELD NAMES:
1. APAC (A CRH Company) - Fields: "Location", "Customer", "Order", "Product", "Vehicle", "Ticket No.", net weight shown as "XX.XX Ton"
2. ScaleHouse (Rigid Constructors) - Fields: "Truck", "Product", net weight under "Net" in tons, "Ticket #", "Cust ID" for customer
3. Amrize - Fields: "TRUCK", "PRODUCT", "CUSTOMER", "LOCATION", "Ticket No", net weight under "NET TON"
4. Terral Dray Receipt - Fields: "HAULER/TRUCK", "TONS" column for net, "JOB#", material listed in body text (e.g. "Sand")
5. Magnolia Sand & Gravel - Handwritten fields: "NAME" for customer, "ADDRESS" for job#, material handwritten in body, "Tare#" is truck ID, weights in LBS (convert Net LBS to tons by dividing by 2000)
6. Superior Sand And Gravel - Fields: "Truck", "Bill to" for customer, "Job #", "Material", net shown as "X LBS = XX.XX Tons"
7. G&W Sand & Gravel - Fields: "Truck", "Job", "Location", "Material", "Net Tons"

RULES:
- Always extract NET tonnage (not gross, not tare)
- If weight is only in LBS, convert: tons = lbs / 2000, round to 2 decimals
- Ticket number is the unique identifier printed on the ticket
- Supplier = the company whose name/logo is on the ticket (the pit or quarry)
- Customer = who ordered/purchased the material
- For truck number: look for Vehicle#, Truck, Unit#, Hauler/Truck, Tare# (Magnolia)
- If a field is not visible or blank, return null

SIGNATURE & STAMP DETECTION:
- signaturePresent: true if ANY handwritten signature is visible anywhere on the ticket
- stampPresent: true if ANY rubber stamp or ink stamp is visible (e.g. "RECEIVED", "APPROVED")
- A printed name is NOT a signature. Look for actual ink marks.

Return ONLY valid JSON, no markdown, no explanation:
{
  "supplier": "company name on the ticket",
  "ticketNumber": "ticket/receipt number",
  "date": "date from ticket",
  "time": "time from ticket",
  "customer": "customer or bill-to name",
  "jobNumber": "job#, order#, or PO number",
  "location": "job site, delivery location, or pit address",
  "truckNumber": "truck, vehicle, or unit number",
  "material": "material type",
  "grossWeight": "gross weight with unit",
  "tareWeight": "tare weight with unit",
  "netTons": "net weight in tons as decimal number only",
  "weighmaster": "weighmaster name if present",
  "signaturePresent": true or false,
  "stampPresent": true or false,
  "notes": "any other relevant info"
}`;

async function extractTicketData(base64Image) {
  const response = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64Image }),
  });
  if (!response.ok) throw new Error("API error");
  return response.json();
}

// ── FLAGS ─────────────────────────────────────────────────────────────────
function buildFlags(ticket, allTickets) {
  const flags = [];
  if (ticket.blurScore !== null && ticket.blurScore < 80)
    flags.push({ id:"blur", label:"Blurry image", icon:"📷", color:"#d97706" });
  if (ticket.data?.signaturePresent===false && ticket.data?.stampPresent===false)
    flags.push({ id:"nosig", label:"No signature or stamp", icon:"✍️", color:"#dc2626" });
  if (ticket.data?.ticketNumber) {
    const dup = allTickets.find(t=>t.id!==ticket.id&&t.data?.ticketNumber===ticket.data.ticketNumber&&t.data?.supplier===ticket.data.supplier);
    if (dup) flags.push({ id:"dup", label:`Duplicate ticket # (${dup.driverName})`, icon:"⚠️", color:"#dc2626" });
  }
  if (ticket.data?.date && ticket.timestamp) {
    try {
      const captureDate = new Date(ticket.timestamp);
      const ticketDateRaw = ticket.data.date.replace(/(\d+)\/(\d+)\/(\d{2})$/,"$1/$2/20$3");
      const ticketDate = new Date(ticketDateRaw);
      if (!isNaN(ticketDate.getTime()) && ticketDate.toDateString()!==captureDate.toDateString()) {
        const diffDays = Math.round((captureDate-ticketDate)/(1000*60*60*24));
        flags.push({ id:"dateshift", label: diffDays===1?"Ticket dated yesterday":`Ticket dated ${diffDays} days ago (${ticket.data.date})`, icon:"📅", color:"#d97706" });
      }
    } catch {}
  }
  return flags;
}

// ── EXPORTS ───────────────────────────────────────────────────────────────
function exportCSV(tickets) {
  const headers = ["Load #","Driver","Captured Date","Captured Time","Supplier","Ticket #","Ticket Date","Customer","Job/PO #","Location","Truck #","Material","Gross Weight","Tare Weight","Net Tons","Weighmaster","GPS Lat","GPS Lng","Signature","Stamp","Flags","Notes"];
  const rows = tickets.map(t=>[
    t.loadNumber, t.driverName, formatDate(t.timestamp), formatTime(t.timestamp),
    t.data?.supplier||"", t.data?.ticketNumber||"", t.data?.date||"", t.data?.customer||"",
    t.data?.jobNumber||"", t.data?.location||"", t.data?.truckNumber||"", t.data?.material||"",
    t.data?.grossWeight||"", t.data?.tareWeight||"", t.data?.netTons||"", t.data?.weighmaster||"",
    t.gps?.latitude||"", t.gps?.longitude||"",
    t.data?.signaturePresent?"Yes":"No", t.data?.stampPresent?"Yes":"No",
    (t.flags||[]).map(f=>f.label).join("; "), t.data?.notes||""
  ]);
  const csv=[headers,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob=new Blob([csv],{type:"text/csv"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url;
  a.download=`tickets-${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

function exportImagePDF(tickets, label, broker=null) {
  const sorted=[...tickets].sort((a,b)=>{
    if(a.driverName!==b.driverName) return a.driverName.localeCompare(b.driverName);
    if(a.timestamp!==b.timestamp) return new Date(a.timestamp)-new Date(b.timestamp);
    return a.loadNumber-b.loadNumber;
  });
  const pages=sorted.map(t=>{
    const img=t.image;
    return `<div class="page">
      <div class="ph">
        <span class="driver">${t.driverName}</span>
        <span class="load">${ordinal(t.loadNumber)} Load</span>
        <span class="sup">${t.data?.supplier||""} ${t.data?.ticketNumber?"· #"+t.data.ticketNumber:""}</span>
        <span class="ts">${formatDateShort(t.timestamp)} ${formatTime(t.timestamp)}</span>
      </div>
      <div class="iw"><img src="${img}" /></div>
      <div class="pf">Net Tons: <strong>${t.data?.netTons||"—"}</strong> · Truck: <strong>${t.data?.truckNumber||"—"}</strong> · Material: <strong>${t.data?.material||"—"}</strong>${(t.flags||[]).length>0?` · <span style="color:#d97706">⚠️ ${t.flags.map(f=>f.label).join(", ")}</span>`:""}</div>
    </div>`;
  }).join("");
  const totalTons=sorted.reduce((s,t)=>s+(parseFloat(t.data?.netTons)||0),0);
  const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ticket Images — ${label}</title>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,Arial,sans-serif}
  .cover{background:#1e3a5f;color:#fff;padding:40px 48px}.cover-title{font-size:26px;font-weight:800;color:#f0a500}
  .cover-sub{font-size:13px;color:#94a3b8;margin-top:4px}.broker-block{margin-top:20px;padding:16px;background:rgba(255,255,255,0.08);border-radius:8px;border-left:3px solid #f0a500}.broker-to{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}.broker-name{font-size:18px;font-weight:800;color:#fff}.broker-addr,.broker-email{font-size:13px;color:#94a3b8;margin-top:2px}.stats{display:flex;gap:40px;margin-top:20px}
  .sn{font-size:32px;font-weight:800;color:#f0a500;font-family:monospace}.sl{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.08em}
  .page{padding:20px 32px;border-bottom:2px solid #e2e8f0;page-break-inside:avoid}
  .ph{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
  .driver{font-size:15px;font-weight:800;color:#1e3a5f}.load{font-size:11px;font-weight:700;color:#f0a500;background:#fff8ed;padding:2px 10px;border-radius:20px;border:1px solid #f0a50040}
  .sup{font-size:12px;color:#64748b}.ts{font-size:12px;color:#94a3b8;margin-left:auto}
  .iw{position:relative;text-align:center;background:#f8fafc;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0}
  .iw img{max-width:100%;max-height:560px;object-fit:contain;display:block;margin:0 auto}
  .tb{position:absolute;top:8px;right:8px;background:rgba(34,197,94,.9);color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px}
  .pf{margin-top:10px;font-size:12px;color:#64748b}.pf strong{color:#1e3a5f}
  @media print{.page{border:none}}</style></head><body>
  <div class="cover"><div class="cover-title">TicketLog — Ticket Images</div>
  <div class="cover-sub">${label} · Generated ${formatDate(new Date().toISOString())} ${formatTime(new Date().toISOString())}</div>
  ${broker?`<div class="broker-block"><div class="broker-to">Bill To:</div><div class="broker-name">${broker.name}</div>${broker.address?`<div class="broker-addr">${broker.address}</div>`:""} ${broker.email?`<div class="broker-email">${broker.email}</div>`:""}</div>`:""}
  <div class="stats">
    <div><div class="sn">${sorted.length}</div><div class="sl">Tickets</div></div>
    <div><div class="sn">${totalTons.toFixed(1)}</div><div class="sl">Net Tons</div></div>
    <div><div class="sn">${[...new Set(sorted.map(t=>t.driverName))].length}</div><div class="sl">Drivers</div></div>
  </div></div>${pages}</body></html>`;
  const blob=new Blob([html],{type:"text/html"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url;
  a.download=`ticket-images-${label.replace(/\s/g,"-")}.html`;
  a.click(); URL.revokeObjectURL(url);
}

// ── DEFAULT DATA ──────────────────────────────────────────────────────────
const DEFAULT_DRIVERS = [
  { name:"Sam", pin:"11111" },
  { name:"Mike", pin:"22222" },
  { name:"Jake", pin:"33333" },
];
const DEFAULT_ADMIN_PIN = "99999";

// ── FIELD LABELS ──────────────────────────────────────────────────────────
const FIELD_LABELS = {
  supplier:"Supplier / Pit", ticketNumber:"Ticket #", date:"Date", time:"Time",
  customer:"Customer", jobNumber:"Job / PO #", location:"Location / Site",
  truckNumber:"Truck #", material:"Material", grossWeight:"Gross Weight",
  tareWeight:"Tare Weight", netTons:"Net Tons", weighmaster:"Weighmaster", notes:"Notes",
};

// ── APP ───────────────────────────────────────────────────────────────────
export default function App() {
  // Auth
  const [authState, setAuthState] = useState("splash");
  const [driverName, setDriverName] = useState("");
  const [roster, setRoster] = useState(DEFAULT_DRIVERS);
  const [loginName, setLoginName] = useState("");
  const [loginPin, setLoginPin] = useState("");
  const [adminPin, setAdminPin] = useState(DEFAULT_ADMIN_PIN);
  const [loginError, setLoginError] = useState("");
  // Driver tabs
  const [driverTab, setDriverTab] = useState("capture"); // capture | period
  const [periodOffset, setPeriodOffset] = useState(0);
  // Admin
  const [adminTab, setAdminTab] = useState("tickets"); // tickets | export | roster
  const [adminPeriodOffset, setAdminPeriodOffset] = useState(0);
  const [brokerFilter, setBrokerFilter] = useState("all"); // all | unassigned | broker name
  // Brokers
  const [brokers, setBrokers] = useState([]);
  const [newBrokerName, setNewBrokerName] = useState("");
  const [newBrokerEmail, setNewBrokerEmail] = useState("");
  const [newBrokerAddress, setNewBrokerAddress] = useState("");
  const [brokerMsg, setBrokerMsg] = useState("");
  // Roster mgmt
  const [newDriverName, setNewDriverName] = useState("");
  const [newDriverPin, setNewDriverPin] = useState("");
  const [rosterMsg, setRosterMsg] = useState("");
  // Tickets
  const [tickets, setTickets] = useState([]);
  const [selectedTicket, setSelectedTicket] = useState(null);
  // Capture flow
  const [captureStep, setCaptureStep] = useState("idle"); // idle | preview | review
  const [previewImg, setPreviewImg] = useState(null);
  const [rawImg, setRawImg] = useState(null);
  const [enhancedImg, setEnhancedImg] = useState(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [blurScore, setBlurScore] = useState(null);
  const [blurWarning, setBlurWarning] = useState(false);
  const [gpsData, setGpsData] = useState(null);
  const [gpsStatus, setGpsStatus] = useState("idle");
  const [editData, setEditData] = useState({});
  const [duplicateWarning, setDuplicateWarning] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [exporting, setExporting] = useState(null);
  const fileRef = useRef();
  const nativeScanRef = useRef();
  const today = new Date().toDateString();

  // Inject scanner animation CSS
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = `@keyframes stabilityFill { from { width: 0% } to { width: 100% } }`;
    document.head.appendChild(el);
    return () => { try { document.head.removeChild(el); } catch {} };
  }, []);

  // ── INIT ────────────────────────────────────────────────────────────────
  useEffect(() => {
    async function init() {
      try {
        const { data: drivers } = await supabase.from("drivers").select("*").order("name");
        if (drivers?.length) setRoster(drivers.map(d=>({name:d.name,pin:d.pin})));
        const { data: brokerData } = await supabase.from("brokers").select("*").order("name");
        if (brokerData?.length) setBrokers(brokerData);
        const ap = localStorage.getItem("adminPin");
        if (ap) setAdminPin(ap);
        const sess = localStorage.getItem("session");
        if (sess) {
          const { name, role } = JSON.parse(sess);
          if (role==="driver") { setDriverName(name); setAuthState("driver"); loadTickets(); }
          else if (role==="admin") { setAuthState("admin"); loadTickets(); }
          else setAuthState("driver-login");
        } else setAuthState("driver-login");
      } catch { setAuthState("driver-login"); }
    }
    init();
  }, []);

  async function loadTickets() {
    try {
      const { data } = await supabase.from("tickets").select("*").order("timestamp",{ascending:false});
      if (data) setTickets(data.map(t=>({
        ...t, driverName:t.driver_name, loadNumber:t.load_number,
        blurScore:t.blur_score,
        imageRaw:t.image_raw,
        imageEnhanced:t.image_enhanced,
        enhancementApplied:t.enhancement_applied,
        // display image: prefer enhanced, fall back to main image
        image:t.image_enhanced||t.image,
      })));
    } catch {}
  }

  // ── AUTH ─────────────────────────────────────────────────────────────────
  async function handleDriverLogin() {
    setLoginError("");
    const driver = roster.find(d=>d.name.toLowerCase()===loginName.trim().toLowerCase()&&d.pin===loginPin.trim());
    if (!driver) { setLoginError("Name or PIN is incorrect."); setLoginPin(""); return; }
    setDriverName(driver.name);
    setAuthState("driver");
    try { localStorage.setItem("session",JSON.stringify({name:driver.name,role:"driver"})); } catch {}
    loadTickets();
  }

  async function handleAdminLogin() {
    setLoginError("");
    if (loginPin.trim()!==adminPin) { setLoginError("Incorrect admin PIN."); setLoginPin(""); return; }
    setAuthState("admin");
    try { localStorage.setItem("session",JSON.stringify({name:"admin",role:"admin"})); } catch {}
    loadTickets();
  }

  async function handleLogout() {
    try { localStorage.removeItem("session"); } catch {}
    setDriverName(""); setLoginName(""); setLoginPin(""); setLoginError("");
    setAuthState("driver-login"); resetCapture();
  }

  async function saveRoster(newRoster) {
    setRoster(newRoster);
    try {
      await supabase.from("drivers").delete().neq("name","");
      if (newRoster.length>0) await supabase.from("drivers").insert(newRoster.map(d=>({name:d.name,pin:d.pin})));
    } catch {}
  }

  async function handleAddDriver() {
    setRosterMsg("");
    if (!newDriverName.trim()) { setRosterMsg("Enter a name."); return; }
    if (newDriverPin.length!==5||!/^\d+$/.test(newDriverPin)) { setRosterMsg("PIN must be 5 digits."); return; }
    if (roster.find(d=>d.name.toLowerCase()===newDriverName.trim().toLowerCase())) { setRosterMsg("Driver already exists."); return; }
    const updated=[...roster,{name:newDriverName.trim(),pin:newDriverPin}];
    await saveRoster(updated);
    setNewDriverName(""); setNewDriverPin(""); setRosterMsg(`✓ ${newDriverName.trim()} added.`);
  }

  async function handleRemoveDriver(name) {
    await saveRoster(roster.filter(d=>d.name!==name));
    setRosterMsg(`✓ ${name} removed.`);
  }

  async function handleResetPin(name, newPin) {
    if (newPin.length!==5||!/^\d+$/.test(newPin)) return;
    await saveRoster(roster.map(d=>d.name===name?{...d,pin:newPin}:d));
    setRosterMsg(`✓ PIN updated for ${name}.`);
  }

  async function handleAddBroker() {
    setBrokerMsg("");
    if (!newBrokerName.trim()) { setBrokerMsg("Enter a company name."); return; }
    if (brokers.find(b=>b.name.toLowerCase()===newBrokerName.trim().toLowerCase())) { setBrokerMsg("Broker already exists."); return; }
    const broker = { name:newBrokerName.trim(), email:newBrokerEmail.trim(), address:newBrokerAddress.trim() };
    try {
      const { data } = await supabase.from("brokers").insert(broker).select().single();
      if (data) setBrokers(prev=>[...prev, data]);
      setNewBrokerName(""); setNewBrokerEmail(""); setNewBrokerAddress("");
      setBrokerMsg(`✓ ${broker.name} added.`);
    } catch { setBrokerMsg("Failed to add broker."); }
  }

  async function handleRemoveBroker(id) {
    try {
      await supabase.from("brokers").delete().eq("id", id);
      setBrokers(prev=>prev.filter(b=>b.id!==id));
    } catch {}
  }

  async function assignBroker(ticketId, brokerName) {
    try {
      await supabase.from("tickets").update({ broker: brokerName }).eq("id", ticketId);
      setTickets(prev=>prev.map(t=>t.id===ticketId?{...t,broker:brokerName}:t));
      if (selectedTicket?.id===ticketId) setSelectedTicket(prev=>({...prev,broker:brokerName}));
    } catch {}
  }

  // ── CAPTURE ───────────────────────────────────────────────────────────────
  function resetCapture() {
    setCaptureStep("idle");
    setPreviewImg(null);
    setRawImg(null);
    setEnhancedImg(null);
    setScannerOpen(false);
    setBlurScore(null); setBlurWarning(false);
    setGpsData(null); setGpsStatus("idle");
    setEditData({}); setDuplicateWarning(null); setLoadError(null);
  }

  // Image processing — returns { raw, enhanced, enhancementApplied }
  async function processImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const w = img.width, h = img.height;
        const raw = dataUrl; // always keep original

        // ── Step 1: Border cleanup ──────────────────────────────────────────
        // Trim 5px inward from each edge
        const TRIM = 5;
        const trimCanvas = document.createElement("canvas");
        trimCanvas.width = w - TRIM * 2;
        trimCanvas.height = h - TRIM * 2;
        const trimCtx = trimCanvas.getContext("2d");
        trimCtx.drawImage(img, TRIM, TRIM, w - TRIM*2, h - TRIM*2, 0, 0, w - TRIM*2, h - TRIM*2);

        // Sample 10px border strip — if not white/near-white, replace with white
        const borderSample = trimCtx.getImageData(0, 0, trimCanvas.width, 10);
        const avgR = borderSample.data.reduce((s,v,i)=>i%4===0?s+v:s,0) / (borderSample.data.length/4);
        const avgG = borderSample.data.reduce((s,v,i)=>i%4===1?s+v:s,0) / (borderSample.data.length/4);
        const avgB = borderSample.data.reduce((s,v,i)=>i%4===2?s+v:s,0) / (borderSample.data.length/4);
        const isWhiteBorder = avgR > 215 && avgG > 215 && avgB > 215;

        if (!isWhiteBorder) {
          // Fill border strip with white
          trimCtx.fillStyle = "#ffffff";
          trimCtx.fillRect(0, 0, trimCanvas.width, 8); // top
          trimCtx.fillRect(0, trimCanvas.height - 8, trimCanvas.width, 8); // bottom
          trimCtx.fillRect(0, 0, 8, trimCanvas.height); // left
          trimCtx.fillRect(trimCanvas.width - 8, 0, 8, trimCanvas.height); // right
        }

        // ── Step 2: Auto enhancement ────────────────────────────────────────
        const enhCanvas = document.createElement("canvas");
        enhCanvas.width = trimCanvas.width;
        enhCanvas.height = trimCanvas.height;
        const enhCtx = enhCanvas.getContext("2d");
        enhCtx.drawImage(trimCanvas, 0, 0);

        const imageData = enhCtx.getImageData(0, 0, enhCanvas.width, enhCanvas.height);
        const d = imageData.data;

        // Find min/max luminance for contrast stretch
        let minL = 255, maxL = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
          if (l < minL) minL = l;
          if (l > maxL) maxL = l;
        }
        const range = maxL - minL || 1;

        for (let i = 0; i < d.length; i += 4) {
          for (let c = 0; c < 3; c++) {
            // Stretch contrast
            let v = (d[i+c] - minL) / range * 255;
            // Mild S-curve — push whites whiter, darks darker
            v = v < 128 ? v * 0.88 : 128 + (v - 128) * 1.12;
            d[i+c] = Math.min(255, Math.max(0, Math.round(v)));
          }
        }
        enhCtx.putImageData(imageData, 0, 0);

        const enhanced = enhCanvas.toDataURL("image/jpeg", 0.92);
        resolve({ raw, enhanced, enhancementApplied: "auto" });
      };
      img.onerror = () => resolve({ raw: dataUrl, enhanced: dataUrl, enhancementApplied: "none" });
      img.src = dataUrl;
    });
  }

  async function handleScannerCapture(dataUrl) {
    setScannerOpen(false);
    setGpsStatus("fetching");
    setBlurScore(null);
    const gpsPromise = getGPSLocation();
    // Process image immediately — border cleanup + enhancement
    const { raw, enhanced, enhancementApplied } = await processImage(dataUrl);
    setRawImg(raw);
    setEnhancedImg(enhanced);
    setPreviewImg(enhanced); // show enhanced by default
    setCaptureStep("preview");
    const [coords, blur] = await Promise.all([gpsPromise, measureBlur(enhanced)]);
    setBlurScore(blur); setBlurWarning(blur < 80);
    if (coords) { setGpsData(coords); setGpsStatus("ok"); } else setGpsStatus("failed");
  }

  async function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    const gpsPromise = getGPSLocation();
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target.result;
      const { raw, enhanced } = await processImage(dataUrl);
      setRawImg(raw);
      setEnhancedImg(enhanced);
      setPreviewImg(enhanced);
      setCaptureStep("preview");
      const [coords, blur] = await Promise.all([gpsPromise, measureBlur(enhanced)]);
      setBlurScore(blur); setBlurWarning(blur<80);
      if (coords) { setGpsData(coords); setGpsStatus("ok"); } else setGpsStatus("failed");
    };
    reader.readAsDataURL(file);
  }

  async function handleAnalyze() {
    setLoading(true); setLoadError(null); setDuplicateWarning(null);
    try {
      const imgToUse = previewImg;
      const base64 = imgToUse.split(",")[1];
      const data = await extractTicketData(base64);
      setEditData(data);
      if (data.ticketNumber && data.supplier) {
        const dup = tickets.find(t=>t.data?.ticketNumber===data.ticketNumber&&t.data?.supplier===data.supplier);
        if (dup) setDuplicateWarning({ticketNumber:data.ticketNumber,supplier:data.supplier,submittedBy:dup.driverName,submittedAt:dup.timestamp});
      }
      setCaptureStep("review");
    } catch { setLoadError("Failed to analyze. Check connection and try again."); }
    setLoading(false);
  }

  async function handleSave(forceDuplicate=false) {
    if (duplicateWarning&&!forceDuplicate) return;
    setSaving(true);
    const myLoads = tickets.filter(t=>t.driverName===driverName&&new Date(t.timestamp).toDateString()===today);
    const tempTicket={id:"temp",data:editData,blurScore};
    const flags=buildFlags(tempTicket,tickets);
    const ticket={
      id:`ticket:${driverName}-${Date.now()}`,
      driverName, loadNumber:myLoads.length+1,
      timestamp:new Date().toISOString(),
      image:enhancedImg||previewImg, // display image = enhanced
      imageRaw:rawImg||previewImg,
      imageEnhanced:enhancedImg||previewImg,
      data:editData, gps:gpsData||null,
      blurScore, flags, flagged:flags.length>0,
    };
    try {
      const {error}=await supabase.from("tickets").insert({
        id:ticket.id, driver_name:ticket.driverName, load_number:ticket.loadNumber,
        timestamp:ticket.timestamp,
        image:ticket.image,
        image_raw:ticket.imageRaw,
        image_enhanced:ticket.imageEnhanced,
        enhancement_applied:"auto",
        data:ticket.data, gps:ticket.gps, blur_score:ticket.blurScore,
        flags:ticket.flags, flagged:ticket.flagged,
      });
      if (error) throw error;
      setTickets(prev=>[ticket,...prev]);
      resetCapture();
    } catch { setLoadError("Failed to save. Try again."); }
    setSaving(false);
  }

  // ── COMPUTED ──────────────────────────────────────────────────────────────
  const currentPeriod = getPayPeriod(periodOffset);
  const adminPeriod = getPayPeriod(adminPeriodOffset);
  const myPeriodTickets = tickets.filter(t=>t.driverName===driverName&&inPeriod(t.timestamp,currentPeriod));
  const myTodayTickets = tickets.filter(t=>t.driverName===driverName&&new Date(t.timestamp).toDateString()===today);
  const adminPeriodTickets = tickets.filter(t=>inPeriod(t.timestamp,adminPeriod));
  const totalTonnage = adminPeriodTickets.reduce((s,t)=>s+(parseFloat(t.data?.netTons)||0),0);
  const flagged = adminPeriodTickets.filter(t=>t.flagged);

  // ── SPLASH ────────────────────────────────────────────────────────────────
  if (authState==="splash") return (
    <div style={S.loginWrap}>
      <div style={S.loginCard}>
        <TruckIcon />
        <h1 style={S.loginTitle}>TicketLog</h1>
        <p style={S.loginSub}>Loading…</p>
      </div>
    </div>
  );

  // ── DRIVER LOGIN ──────────────────────────────────────────────────────────
  if (authState==="driver-login") return (
    <div style={S.loginWrap}>
      <div style={S.loginCard}>
        <TruckIcon />
        <h1 style={S.loginTitle}>TicketLog</h1>
        <p style={S.loginSub}>Enter your name and PIN to continue.</p>
        <div style={S.loginInputWrap}>
          <PersonIcon />
          <input style={S.loginInputInner} placeholder="Name" value={loginName}
            onChange={e=>{setLoginName(e.target.value);setLoginError("");}} />
        </div>
        <div style={S.loginInputWrap}>
          <LockIcon />
          <input style={S.loginInputInner} placeholder="PIN" type="password"
            inputMode="numeric" maxLength={5} value={loginPin}
            onChange={e=>{setLoginPin(e.target.value.replace(/\D/g,""));setLoginError("");}}
            onKeyDown={e=>e.key==="Enter"&&handleDriverLogin()} />
          <div style={S.pinDots}>
            {[0,1,2,3,4].map(i=><span key={i} style={{...S.pinDot,...(i<loginPin.length?S.pinDotFilled:{})}} />)}
          </div>
        </div>
        {loginError&&<div style={S.loginError}>{loginError}</div>}
        <button style={S.loginBtn} onClick={handleDriverLogin}>Continue</button>
        <div style={S.loginDivider}><span style={S.loginDividerText}>or</span></div>
        <button style={S.loginAdminLink} onClick={()=>{setLoginName("");setLoginPin("");setLoginError("");setAuthState("admin-login");}}>
          Admin Sign In
        </button>
        <div style={S.loginVersion}>v1.0.0</div>
      </div>
    </div>
  );

  // ── ADMIN LOGIN ───────────────────────────────────────────────────────────
  if (authState==="admin-login") return (
    <div style={S.loginWrap}>
      <div style={S.loginCard}>
        <div style={S.adminLockIcon}><LockIcon size={40} /></div>
        <h1 style={S.loginTitle}>Admin</h1>
        <p style={S.loginSub}>Authorized access only.</p>
        <div style={S.loginInputWrap}>
          <LockIcon />
          <input style={S.loginInputInner} placeholder="Admin PIN" type="password"
            inputMode="numeric" maxLength={5} value={loginPin}
            onChange={e=>{setLoginPin(e.target.value.replace(/\D/g,""));setLoginError("");}}
            onKeyDown={e=>e.key==="Enter"&&handleAdminLogin()} />
        </div>
        {loginError&&<div style={S.loginError}>{loginError}</div>}
        <button style={S.loginBtn} onClick={handleAdminLogin}>Continue</button>
        <div style={S.loginDivider}><span style={S.loginDividerText}>or</span></div>
        <button style={S.loginAdminLink} onClick={()=>{setLoginPin("");setLoginError("");setAuthState("driver-login");}}>
          Driver Sign In
        </button>
      </div>
    </div>
  );

  // ── DRIVER APP ────────────────────────────────────────────────────────────
  if (authState==="driver") {
    const displayImg = previewImg;
    const driverUnit = roster.find(d=>d.name===driverName)?.unit||null;
    return (
      <div style={S.app}>
        {/* Camera capture — opens rear camera directly */}
        <input ref={fileRef} type="file" accept="image/*" capture="environment"
          style={{display:"none"}} onChange={handleFileSelect} />
        {/* Native document scan — on iOS Safari triggers Apple's document scanner */}
        <input ref={nativeScanRef} type="file" accept="image/*"
          style={{display:"none"}} onChange={handleFileSelect} />

        {/* Header */}
        <div style={S.driverHeader}>
          <div>
            <div style={S.driverName}>Good {getGreeting()}, {driverName.split(" ")[0]}</div>
            <div style={S.driverDate}>
              {driverUnit&&<span>Unit {driverUnit} · </span>}
              {new Date().toLocaleDateString([],{weekday:"long",month:"long",day:"numeric"})}
            </div>
          </div>
          <button style={S.signOutBtn} onClick={handleLogout}>Sign Out</button>
        </div>

        {/* Live document scanner overlay */}
        {scannerOpen && (
          <LiveDocumentScanner
            onCapture={handleScannerCapture}
            onClose={()=>setScannerOpen(false)}
          />
        )}

        {/* Content area */}
        <div style={S.driverContent}>

        {/* ── CAPTURE TAB ── */}
        {driverTab==="capture" && (
          <div style={S.captureWrap}>
            {captureStep==="idle" && (
              <div style={S.captureIdleWrap}>
                <div style={S.captureIdleCard}>
                  <div style={S.captureIconCircle}><CameraIcon size={36} /></div>
                  <div style={S.captureIdleTitle}>Capture Ticket</div>
                  <div style={S.captureIdleSub}>Next load: <strong>#{myTodayTickets.length+1}</strong></div>
                  <button style={S.captureBigBtn} onClick={()=>setScannerOpen(true)}>
                    <CameraIcon size={20} color="#fff" />
                    <span>Scan Ticket</span>
                  </button>
                  <button style={{...S.outlineBtn,width:"100%",marginTop:8,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}
                    onClick={()=>nativeScanRef.current.click()}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                    Use Native Scanner
                  </button>
                  <button style={{...S.ghostLink,marginTop:4,fontSize:12,color:C.muted}} onClick={()=>fileRef.current.click()}>
                    Use photo library
                  </button>
                  <div style={S.captureHint}>
                    <InfoIcon />
                    <span>Make sure the ticket is flat, well-lit, and all details are visible.</span>
                  </div>
                </div>
                {myTodayTickets.length>0&&(
                  <div style={S.todaySummary}>
                    <span style={S.todaySummaryLabel}>Today</span>
                    <span style={S.todaySummaryVal}>{myTodayTickets.length} loads · {myTodayTickets.reduce((s,t)=>s+(parseFloat(t.data?.netTons)||0),0).toFixed(1)} tons</span>
                  </div>
                )}
              </div>
            )}

            {captureStep==="preview" && (
              <div style={S.captureStepWrap}>
                {/* Image preview */}
                <div style={S.imgPreviewWrap}>
                  <img src={displayImg||previewImg} alt="ticket" style={S.imgPreview} />
</div>

                {/* Status cards */}
                <div style={S.statusStack}>
                  {/* Blur */}
                  {blurScore!==null&&(
                    <div style={{...S.statusChip,borderColor:blurWarning?"#fca5a5":"#86efac",background:blurWarning?"#fef2f2":"#f0fdf4"}}>
                      <span>{blurWarning?"⚠️":"✅"}</span>
                      <span style={{fontSize:13,color:blurWarning?"#dc2626":"#16a34a",fontWeight:600}}>
                        {blurWarning?"Blurry — consider retaking":"Image looks sharp"}
                      </span>
                    </div>
                  )}

                  {/* GPS */}
                  <div style={{...S.statusChip,borderColor:gpsStatus==="ok"?"#86efac":gpsStatus==="failed"?"#fca5a5":"#e2e8f0",background:gpsStatus==="ok"?"#f0fdf4":"#f8fafc"}}>
                    <span style={{fontSize:10,color:gpsStatus==="ok"?"#16a34a":gpsStatus==="failed"?"#dc2626":"#94a3b8"}}>●</span>
                    <span style={{fontSize:13,color:gpsStatus==="ok"?"#16a34a":gpsStatus==="failed"?"#dc2626":"#64748b"}}>
                      {gpsStatus==="fetching"?"Acquiring GPS…":gpsStatus==="ok"?`GPS locked · ±${gpsData?.accuracy}m`:"GPS unavailable"}
                    </span>
                  </div>
                </div>

                {loadError&&<div style={S.errorBox}>{loadError}</div>}

                <div style={S.actionRow}>
                  {blurWarning?(
                    <>
                      <button style={S.solidBtn} onClick={()=>{resetCapture();setScannerOpen(true);}}>Retake</button>
                      <button style={{...S.outlineBtn}} onClick={handleAnalyze} disabled={loading}>{loading?"Analyzing…":"Use Anyway"}</button>
                    </>
                  ):(
                    <button style={{...S.solidBtn,width:"100%"}} onClick={handleAnalyze} disabled={loading}>
                      {loading?"Analyzing ticket…":"✦ Extract Ticket Data"}
                    </button>
                  )}
                </div>
                <button style={S.ghostLink} onClick={resetCapture}>Cancel</button>
              </div>
            )}

            {captureStep==="review" && (
              <div style={S.captureStepWrap}>
                <div style={S.reviewHeader}>
                  <img src={previewImg} alt="" style={S.reviewThumb} />
                  <div style={S.reviewHeaderInfo}>
                    {editData.supplier&&<div style={S.reviewSupplier}>{editData.supplier}</div>}
                    {editData.ticketNumber&&<div style={S.reviewTicketNum}>#{editData.ticketNumber}</div>}
                    {editData.netTons&&(
                      <div style={S.netTonsBadge}>
                        <span style={S.netTonsNum}>{editData.netTons}</span>
                        <span style={S.netTonsLabel}>NET TONS</span>
                      </div>
                    )}
                  </div>
                </div>
                {duplicateWarning&&(
                  <div style={S.dupWarning}>
                    <div style={S.dupWarningTitle}>⚠️ Duplicate Ticket #{duplicateWarning.ticketNumber}</div>
                    <div style={S.dupWarningText}>Already submitted by <strong>{duplicateWarning.submittedBy}</strong> at {formatTime(duplicateWarning.submittedAt)}. Verify before saving.</div>
                  </div>
                )}
                {editData.signaturePresent===false&&editData.stampPresent===false&&(
                  <div style={{...S.warnChip,borderColor:"#fca5a5",background:"#fef2f2"}}>
                    <span>✍️</span>
                    <span style={{fontSize:13,color:"#dc2626",fontWeight:600}}>No signature or stamp detected — ticket will be flagged</span>
                  </div>
                )}
                <div style={S.fieldsGrid}>
                  {Object.entries(FIELD_LABELS).filter(([k])=>k!=="signaturePresent"&&k!=="stampPresent").map(([key,label])=>(
                    <div key={key} style={key==="notes"||key==="location"||key==="customer"?{...S.fieldWrap,gridColumn:"span 2"}:S.fieldWrap}>
                      <label style={S.fieldLabel}>{label}</label>
                      <input style={S.fieldInput} value={editData[key]||""}
                        onChange={e=>setEditData(p=>({...p,[key]:e.target.value}))} placeholder="—" />
                    </div>
                  ))}
                </div>
                {loadError&&<div style={S.errorBox}>{loadError}</div>}
                {duplicateWarning?(
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    <button style={{...S.solidBtn,width:"100%",background:"#dc2626"}} onClick={()=>handleSave(true)} disabled={saving}>
                      {saving?"Saving…":"Save Anyway (Override Duplicate)"}
                    </button>
                    <button style={{...S.outlineBtn,width:"100%"}} onClick={resetCapture}>Discard</button>
                  </div>
                ):(
                  <>
                    <button style={{...S.solidBtn,width:"100%"}} onClick={()=>handleSave(false)} disabled={saving}>
                      {saving?"Saving…":"✓ Save Ticket"}
                    </button>
                    <button style={S.ghostLink} onClick={resetCapture}>Discard</button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── MY LOADS TAB ── */}
        {driverTab==="period" && (
          <div style={S.periodWrap}>
            <div style={S.periodNav}>
              <button style={S.periodNavBtn} onClick={()=>setPeriodOffset(p=>p-1)}>‹</button>
              <div style={S.periodNavCenter}>
                <div style={S.periodNavLabel}>{periodOffset===0?"This Week":periodOffset===-1?"Last Week":`${Math.abs(periodOffset)} weeks ago`}</div>
                <div style={S.periodNavDates}>{periodLabel(currentPeriod)}</div>
              </div>
              <button style={{...S.periodNavBtn,...(periodOffset===0?{opacity:.3,pointerEvents:"none"}:{})}} onClick={()=>setPeriodOffset(p=>p+1)}>›</button>
            </div>

            {/* Period summary */}
            <div style={S.periodSummary}>
              <div style={S.periodSummaryItem}>
                <div style={S.periodSummaryNum}>{myPeriodTickets.length}</div>
                <div style={S.periodSummaryLabel}>Loads</div>
              </div>
              <div style={S.periodSummaryDivider}/>
              <div style={S.periodSummaryItem}>
                <div style={S.periodSummaryNum}>{myPeriodTickets.reduce((s,t)=>s+(parseFloat(t.data?.netTons)||0),0).toFixed(1)}</div>
                <div style={S.periodSummaryLabel}>Net Tons</div>
              </div>
              <div style={S.periodSummaryDivider}/>
              <div style={S.periodSummaryItem}>
                <div style={S.periodSummaryNum}>{[...new Set(myPeriodTickets.map(t=>new Date(t.timestamp).toDateString()))].length}</div>
                <div style={S.periodSummaryLabel}>Days</div>
              </div>
            </div>

            {/* Ticket list */}
            {myPeriodTickets.length===0?(
              <div style={S.emptyState}>
                <div style={S.emptyIcon}>📋</div>
                <div style={S.emptyText}>No loads this period</div>
              </div>
            ):(
              <div style={S.ticketList}>
                {[...myPeriodTickets].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).map(t=>(
                  <DriverTicketCard key={t.id} ticket={t} onClick={()=>setSelectedTicket(t)} />
                ))}
              </div>
            )}
          </div>
        )}

        {selectedTicket&&<TicketModal ticket={selectedTicket} onClose={()=>setSelectedTicket(null)} />}
        </div>

        {/* Bottom tab bar */}
        <div style={S.bottomTabBar}>
          <button style={{...S.bottomTab,...(driverTab==="capture"?S.bottomTabActive:{})}} onClick={()=>{setDriverTab("capture");resetCapture();}}>
            <CameraIcon size={22} color={driverTab==="capture"?C.navy:"#94a3b8"} />
            <span style={{...S.bottomTabLabel,...(driverTab==="capture"?{color:C.navy,fontWeight:700}:{})}}>Capture</span>
          </button>
          <button style={{...S.bottomTab,...(driverTab==="period"?S.bottomTabActive:{})}} onClick={()=>setDriverTab("period")}>
            <ListIcon size={22} color={driverTab==="period"?C.navy:"#94a3b8"} />
            <span style={{...S.bottomTabLabel,...(driverTab==="period"?{color:C.navy,fontWeight:700}:{})}}>My Loads</span>
          </button>
        </div>
      </div>
    );
  }

  // ── ADMIN APP ─────────────────────────────────────────────────────────────
  if (authState==="admin") {
    const dupCount=flagged.filter(t=>t.flags?.some(f=>f.id==="dup")).length;
    const noSigCount=flagged.filter(t=>t.flags?.some(f=>f.id==="nosig")).length;
    const blurCount=flagged.filter(t=>t.flags?.some(f=>f.id==="blur")).length;
    const dateCount=flagged.filter(t=>t.flags?.some(f=>f.id==="dateshift")).length;

    return (
      <div style={S.adminApp}>
        {/* Admin header */}
        <div style={S.adminHeader}>
          <div style={S.adminHeaderLeft}>
            <div style={S.adminTitle}>TicketLog Admin</div>
            <div style={S.adminSub}>
              {periodLabel(adminPeriod)}
              <button style={S.periodSmallBtn} onClick={()=>setAdminPeriodOffset(p=>p-1)}>‹</button>
              {adminPeriodOffset<0&&<button style={S.periodSmallBtn} onClick={()=>setAdminPeriodOffset(p=>p+1)}>›</button>}
            </div>
          </div>
          <button style={S.signOutBtn} onClick={handleLogout}>Sign Out</button>
        </div>

        {/* Summary row */}
        <div style={S.adminSummaryRow}>
          <SummaryCard label="Tickets" value={adminPeriodTickets.length} />
          <SummaryCard label="Net Tons" value={totalTonnage.toFixed(1)} highlight />
          <SummaryCard label="Drivers" value={[...new Set(adminPeriodTickets.map(t=>t.driverName))].length} />
          <SummaryCard label="Flagged" value={flagged.length} alert={flagged.length>0} />
        </div>

        {/* Flag summary */}
        {flagged.length>0&&(
          <div style={S.flagSummary}>
            <span style={S.flagSummaryTitle}>⚠️ Needs Review:</span>
            {dupCount>0&&<FlagChip color="#dc2626">⚠️ {dupCount} duplicate{dupCount>1?"s":""}</FlagChip>}
            {noSigCount>0&&<FlagChip color="#dc2626">✍️ {noSigCount} no sig/stamp</FlagChip>}
            {dateCount>0&&<FlagChip color="#d97706">📅 {dateCount} date mismatch{dateCount>1?"es":""}</FlagChip>}
            {blurCount>0&&<FlagChip color="#d97706">📷 {blurCount} blurry</FlagChip>}
          </div>
        )}

        {/* Admin tabs */}
        <div style={S.adminTabBar}>
          <button style={{...S.adminTab,...(adminTab==="tickets"?S.adminTabActive:{})}} onClick={()=>setAdminTab("tickets")}>Tickets</button>
          <button style={{...S.adminTab,...(adminTab==="export"?S.adminTabActive:{})}} onClick={()=>setAdminTab("export")}>Export</button>
          <button style={{...S.adminTab,...(adminTab==="roster"?S.adminTabActive:{})}} onClick={()=>setAdminTab("roster")}>Roster</button>
        </div>

        <div style={S.adminBody}>
          {/* TICKETS TAB */}
          {adminTab==="tickets"&&(
            <div>
              {/* Broker filter bar */}
              <div style={S.brokerFilterBar}>
                <button style={{...S.brokerFilterBtn,...(brokerFilter==="all"?S.brokerFilterActive:{})}} onClick={()=>setBrokerFilter("all")}>All</button>
                <button style={{...S.brokerFilterBtn,...(brokerFilter==="unassigned"?{...S.brokerFilterActive,borderColor:"#f59e0b",color:"#d97706",background:"#fef3c7"}:{})}} onClick={()=>setBrokerFilter("unassigned")}>Unassigned</button>
                {brokers.map(b=>(
                  <button key={b.id} style={{...S.brokerFilterBtn,...(brokerFilter===b.name?{background:brokerColor(brokers,b.name),color:"#fff",borderColor:brokerColor(brokers,b.name)}:{})}} onClick={()=>setBrokerFilter(b.name)}>
                    {b.name}
                  </button>
                ))}
              </div>
              <div style={S.ticketList}>
                {adminPeriodTickets
                  .filter(t=>brokerFilter==="all"?true:brokerFilter==="unassigned"?!t.broker:t.broker===brokerFilter)
                  .sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp))
                  .map(t=>(
                    <AdminTicketCard key={t.id} ticket={t} brokers={brokers} onClick={()=>setSelectedTicket(t)} />
                  ))
                }
                {adminPeriodTickets.filter(t=>brokerFilter==="all"?true:brokerFilter==="unassigned"?!t.broker:t.broker===brokerFilter).length===0&&(
                  <div style={S.emptyState}><div style={S.emptyIcon}><ListIcon size={32} color="#94a3b8" /></div><div style={S.emptyText}>No tickets {brokerFilter==="unassigned"?"unassigned":"for this period"}</div></div>
                )}
              </div>
            </div>
          )}

          {/* EXPORT TAB */}

          {adminTab==="export"&&(
            <div style={S.exportStack}>
              <ExportCard icon={null} title="Auto-Split by Broker" desc="Generates one PDF per broker for the selected period — ready to send to each.">
                <div style={{marginTop:10,display:"flex",flexDirection:"column",gap:8}}>
                  {brokers.length===0&&<div style={{fontSize:13,color:C.muted,textAlign:"center",padding:"8px 0"}}>No brokers added yet — add brokers in the Roster tab.</div>}
                  {brokers.map(b=>{
                    const bTickets=adminPeriodTickets.filter(t=>t.broker===b.name);
                    const bc=brokerColor(brokers,b.name);
                    return (
                      <button key={b.id} style={{...S.solidBtn,width:"100%",background:bc,display:"flex",justifyContent:"space-between",alignItems:"center",opacity:bTickets.length===0?.5:1}}
                        disabled={bTickets.length===0}
                        onClick={()=>exportImagePDF(bTickets,`${b.name} · ${periodLabel(adminPeriod)}`,b)}>
                        <span>{b.name}</span>
                        <span style={{fontSize:13,opacity:.85}}>{bTickets.length} tickets</span>
                      </button>
                    );
                  })}
                  {adminPeriodTickets.filter(t=>!t.broker).length>0&&(
                    <div style={{fontSize:12,color:"#d97706",background:"#fef3c7",border:"1px solid #fde68a",borderRadius:8,padding:"8px 12px"}}>
                      {adminPeriodTickets.filter(t=>!t.broker).length} tickets unassigned — assign brokers before exporting
                    </div>
                  )}
                </div>
              </ExportCard>
              <ExportCard icon={null} title="Manual Export" desc="Pick a specific broker and date range.">
                <ManualExport brokers={brokers} tickets={tickets} brokerColorFn={(n)=>brokerColor(brokers,n)} />
              </ExportCard>
              <ExportCard icon={null} title="CSV Export" desc="All ticket data for invoicing — opens in Excel.">
                <button style={{...S.solidBtn,width:"100%",background:"#16a34a",marginTop:10}}
                  disabled={exporting==="csv"||adminPeriodTickets.length===0}
                  onClick={()=>{setExporting("csv");exportCSV(adminPeriodTickets);setTimeout(()=>setExporting(null),800);}}>
                  {exporting==="csv"?"Exporting…":`Export CSV (${adminPeriodTickets.length} tickets)`}
                </button>
              </ExportCard>
            </div>
          )}

          {/* ROSTER TAB */}
          {adminTab==="roster"&&(
            <div style={S.exportStack}>
              <div style={S.card}>
                <div style={S.cardTitle}>Add Driver</div>
                <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:10}}>
                  <input style={S.fieldInput} placeholder="Driver name" value={newDriverName}
                    onChange={e=>{setNewDriverName(e.target.value);setRosterMsg("");}} />
                  <input style={S.fieldInput} placeholder="5-digit PIN" type="password"
                    inputMode="numeric" maxLength={5} value={newDriverPin}
                    onChange={e=>{setNewDriverPin(e.target.value.replace(/\D/g,""));setRosterMsg("");}} />
                  <button style={{...S.solidBtn,width:"100%"}} onClick={handleAddDriver}>Add Driver</button>
                  {rosterMsg&&<div style={{fontSize:13,color:rosterMsg.startsWith("✓")?"#16a34a":"#dc2626",textAlign:"center"}}>{rosterMsg}</div>}
                </div>
              </div>
              <div style={S.card}>
                <div style={S.cardTitle}>Drivers ({roster.length})</div>
                <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:10}}>
                  {roster.map(d=><RosterRow key={d.name} driver={d} onRemove={handleRemoveDriver} onResetPin={handleResetPin} />)}
                </div>
              </div>

              {/* Brokers */}
              <div style={S.card}>
                <div style={S.cardTitle}>Add Broker</div>
                <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:10}}>
                  <input style={S.fieldInput} placeholder="Company name" value={newBrokerName}
                    onChange={e=>{setNewBrokerName(e.target.value);setBrokerMsg("");}} />
                  <input style={S.fieldInput} placeholder="Email address" type="email" value={newBrokerEmail}
                    onChange={e=>{setNewBrokerEmail(e.target.value);setBrokerMsg("");}} />
                  <input style={S.fieldInput} placeholder="Billing address" value={newBrokerAddress}
                    onChange={e=>{setNewBrokerAddress(e.target.value);setBrokerMsg("");}} />
                  <button style={{...S.solidBtn,width:"100%"}} onClick={handleAddBroker}>Add Broker</button>
                  {brokerMsg&&<div style={{fontSize:13,color:brokerMsg.startsWith("✓")?"#16a34a":"#dc2626",textAlign:"center"}}>{brokerMsg}</div>}
                </div>
              </div>
              <div style={S.card}>
                <div style={S.cardTitle}>Brokers ({brokers.length})</div>
                <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:10}}>
                  {brokers.length===0&&<div style={{fontSize:13,color:C.muted,textAlign:"center",padding:"8px 0"}}>No brokers added yet.</div>}
                  {brokers.map((b,i)=>(
                    <div key={b.id} style={{...S.rosterRow,borderLeft:`3px solid ${BROKER_COLORS[i%BROKER_COLORS.length]}`}}>
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <div style={{flex:1}}>
                          <div style={{fontSize:14,fontWeight:700,color:C.navy}}>{b.name}</div>
                          {b.email&&<div style={{fontSize:12,color:C.muted}}>{b.email}</div>}
                          {b.address&&<div style={{fontSize:12,color:C.muted}}>{b.address}</div>}
                        </div>
                        <button style={{...S.rosterAction,color:"#dc2626"}} onClick={()=>handleRemoveBroker(b.id)}>Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={S.card}>
                <AdminPinChanger currentPin={adminPin} onSave={async(p)=>{
                  setAdminPin(p);
                  try{localStorage.setItem("adminPin",p);}catch{}
                  setRosterMsg("✓ Admin PIN updated.");
                }} />
              </div>
            </div>
          )}
        </div>
        {selectedTicket&&<TicketModal ticket={selectedTicket} onClose={()=>setSelectedTicket(null)} brokers={brokers} onAssignBroker={assignBroker} brokerColorFn={(n)=>brokerColor(brokers,n)} />}
      </div>
    );
  }

  return null;
}

// ── HELPERS ───────────────────────────────────────────────────────────────
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

// ── SVG ICONS ─────────────────────────────────────────────────────────────
function TruckIcon() {
  return (
    <svg width="80" height="56" viewBox="0 0 80 56" fill="none" xmlns="http://www.w3.org/2000/svg" style={{marginBottom:8}}>
      <rect x="4" y="16" width="48" height="28" rx="4" fill="#1e3a5f"/>
      <path d="M52 24h12l8 10v10H52V24z" fill="#1e3a5f"/>
      <circle cx="16" cy="46" r="6" fill="#fff" stroke="#1e3a5f" strokeWidth="2"/>
      <circle cx="40" cy="46" r="6" fill="#fff" stroke="#1e3a5f" strokeWidth="2"/>
      <circle cx="64" cy="46" r="6" fill="#fff" stroke="#1e3a5f" strokeWidth="2"/>
      <path d="M8 20 Q12 8 24 8 Q36 8 40 20" stroke="#1e3a5f" strokeWidth="2" fill="none" strokeLinecap="round"/>
    </svg>
  );
}

function CameraIcon({size=24, color=C?.navy||"#1e3a5f"}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
  );
}

function ListIcon({size=24, color="#94a3b8"}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
      <rect x="9" y="3" width="6" height="4" rx="1"/>
      <line x1="9" y1="12" x2="15" y2="12"/>
      <line x1="9" y1="16" x2="13" y2="16"/>
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  );
}

function LockIcon({size=18}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  );
}

// ── COMPONENTS ─────────────────────────────────────────────────────────────

function SummaryCard({label,value,highlight,alert}) {
  const cardStyle = {...S.summaryCard, ...(highlight?{borderColor:C.navy,background:"#eff6ff"}:{}), ...(alert?{borderColor:"#fca5a5",background:"#fef2f2"}:{})};
  const numStyle = {...S.summaryNum, ...(highlight?{color:C.navy}:{}), ...(alert?{color:"#dc2626"}:{})};
  return (
    <div style={cardStyle}>
      <div style={numStyle}>{value}</div>
      <div style={S.summaryLabel}>{label}</div>
    </div>
  );
}

function FlagChip({color,children}) {
  return <span style={{fontSize:11,fontWeight:700,color,background:color+"18",border:`1px solid ${color}40`,borderRadius:20,padding:"3px 10px"}}>{children}</span>;
}

function ExportCard({icon,title,desc,children,faded}) {
  return (
    <div style={{...S.card,...(faded?{opacity:.65,border:`1px dashed ${C.border}`}:{})}}>
      <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
        {icon&&<span style={{fontSize:26,flexShrink:0}}>{icon}</span>}
        <div>
          <div style={S.cardTitle}>{title}</div>
          <div style={{fontSize:13,color:"#64748b",marginTop:3,lineHeight:1.5}}>{desc}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function DriverTicketCard({ticket,onClick}) {
  return (
    <div style={S.driverTicketCard} onClick={onClick}>
      <img src={ticket.image} alt="" style={S.driverTicketThumb} />
      <div style={S.driverTicketInfo}>
        <div style={S.driverTicketTop}>
          <span style={S.loadPill}>{ordinal(ticket.loadNumber)}</span>
          {ticket.data?.supplier&&<span style={S.supplierText}>{ticket.data.supplier}</span>}
          {ticket.flagged&&<span style={{fontSize:14}}>⚠️</span>}
        </div>
        {ticket.data?.netTons&&<div style={S.driverTicketTons}>{ticket.data.netTons} <span style={{fontSize:12,fontWeight:500,color:"#64748b"}}>tons</span></div>}
        <div style={S.driverTicketMeta}>
          {ticket.data?.truckNumber&&<span>🚛 {ticket.data.truckNumber}</span>}
          {ticket.data?.material&&<span>📦 {ticket.data.material}</span>}
        </div>
        <div style={S.driverTicketTime}>{formatDateShort(ticket.timestamp)} · {formatTime(ticket.timestamp)}</div>
      </div>
    </div>
  );
}

function AdminTicketCard({ticket,brokers,onClick}) {
  const hasDup = ticket.flags?.some(f=>f.id==="dup");
  const hasNoSig = ticket.flags?.some(f=>f.id==="nosig");
  const bc = ticket.broker ? brokerColor(brokers,ticket.broker) : null;
  return (
    <div style={{...S.adminTicketCard,borderLeft:bc?`4px solid ${bc}`:ticket.flagged?`3px solid ${hasDup||hasNoSig?"#dc2626":"#d97706"}`:`3px solid transparent`}} onClick={onClick}>
      <img src={ticket.image} alt="" style={S.adminTicketThumb} />
      <div style={S.adminTicketInfo}>
        <div style={S.adminTicketTop}>
          <span style={S.adminDriverName}>{ticket.driverName}</span>
          <span style={S.loadPill}>{ordinal(ticket.loadNumber)}</span>
          <span style={{marginLeft:"auto",fontSize:12,color:"#94a3b8"}}>{formatTime(ticket.timestamp)}</span>
        </div>
        <div style={S.adminTicketMiddle}>
          <span style={{fontSize:13,color:"#1e293b",fontWeight:500}}>{ticket.data?.supplier||"Unknown"}</span>
          {ticket.data?.ticketNumber&&<span style={{fontSize:12,color:"#64748b"}}>#{ticket.data.ticketNumber}</span>}
        </div>
        <div style={S.adminTicketBottom}>
          {ticket.data?.netTons&&<span style={{fontWeight:700,color:C.navy}}>{ticket.data.netTons}t</span>}
          {ticket.data?.truckNumber&&<span>{ticket.data.truckNumber}</span>}
          {ticket.data?.material&&<span>{ticket.data.material}</span>}
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:4,alignItems:"center"}}>
          {ticket.broker?(
            <span style={{fontSize:11,fontWeight:700,color:bc,background:bc+"18",border:`1px solid ${bc}40`,borderRadius:20,padding:"2px 8px"}}>{ticket.broker}</span>
          ):(
            <span style={{fontSize:11,fontWeight:700,color:"#d97706",background:"#fef3c7",border:"1px solid #fde68a",borderRadius:20,padding:"2px 8px"}}>Unassigned</span>
          )}
          {ticket.flags?.map(f=>(
            <span key={f.id} style={{fontSize:10,color:f.color,background:f.color+"15",padding:"1px 7px",borderRadius:20,fontWeight:600}}>{f.label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function TicketModal({ticket,onClose,brokers,onAssignBroker,brokerColorFn}) {
  const gps=ticket.gps;
  const mapsUrl=gps?`https://maps.google.com/?q=${gps.latitude},${gps.longitude}`:null;
  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={S.modal} onClick={e=>e.stopPropagation()}>
        <div style={S.modalHeader}>
          <div>
            <div style={S.modalTitle}>{ordinal(ticket.loadNumber)} Load — {ticket.driverName}</div>
            <div style={S.modalSub}>{formatDate(ticket.timestamp)} · {formatTime(ticket.timestamp)}</div>
          </div>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Broker assignment */}
        {brokers&&onAssignBroker&&(
          <div style={{padding:"0 16px 12px"}}>
            <label style={S.fieldLabel}>Broker</label>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:6}}>
              {brokers.map(b=>{
                const selected=ticket.broker===b.name;
                const color=brokerColorFn(b.name);
                return (
                  <button key={b.id}
                    style={{fontSize:12,fontWeight:700,padding:"5px 14px",borderRadius:20,border:`1.5px solid ${color}`,background:selected?color:"transparent",color:selected?"#fff":color,cursor:"pointer"}}
                    onClick={()=>onAssignBroker(ticket.id,b.name)}>
                    {b.name}
                  </button>
                );
              })}
              {ticket.broker&&(
                <button style={{fontSize:12,fontWeight:600,padding:"5px 14px",borderRadius:20,border:"1.5px solid #e2e8f0",background:"transparent",color:"#94a3b8",cursor:"pointer"}}
                  onClick={()=>onAssignBroker(ticket.id,null)}>
                  Clear
                </button>
              )}
            </div>
            {!ticket.broker&&<div style={{fontSize:12,color:"#d97706",marginTop:6}}>No broker assigned</div>}
          </div>
        )}

        {ticket.flags?.length>0&&(
          <div style={{padding:"0 16px 8px",display:"flex",flexDirection:"column",gap:4}}>
            {ticket.flags.map(f=>(
              <div key={f.id} style={{fontSize:13,fontWeight:600,color:f.color,background:f.color+"12",border:`1px solid ${f.color}40`,borderRadius:8,padding:"6px 12px"}}>
                {f.icon} {f.label}
              </div>
            ))}
          </div>
        )}

        <img src={ticket.image} alt="ticket" style={S.modalImg} />

        {ticket.data?.netTons&&(
          <div style={S.modalTons}>
            <span style={S.modalTonsNum}>{ticket.data.netTons}</span>
            <span style={S.modalTonsLabel}>NET TONS</span>
          </div>
        )}

        <div style={{padding:"0 16px 8px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <div style={S.dateCompareBox}>
            <div style={S.dateCompareLabel}>Ticket Date</div>
            <div style={S.dateCompareVal}>{ticket.data?.date||"—"}</div>
          </div>
          <div style={{...S.dateCompareBox,...(ticket.flags?.some(f=>f.id==="dateshift")?{borderColor:"#fca5a5",background:"#fef2f2"}:{})}}>
            <div style={S.dateCompareLabel}>Captured On</div>
            <div style={{...S.dateCompareVal,...(ticket.flags?.some(f=>f.id==="dateshift")?{color:"#dc2626"}:{})}}>{formatDate(ticket.timestamp)}</div>
          </div>
        </div>

        {gps&&(
          <div style={S.modalGps}>
            <div style={{fontSize:12,fontWeight:700,color:"#16a34a",marginBottom:4}}>📍 GPS · ±{gps.accuracy}m</div>
            {gps.address&&<div style={{fontSize:13,color:"#1e293b"}}>{gps.address.split(",").slice(0,3).join(", ")}</div>}
            <div style={{fontSize:11,color:"#64748b",fontFamily:"monospace",marginTop:2}}>{gps.latitude.toFixed(6)}, {gps.longitude.toFixed(6)}</div>
            <a href={mapsUrl} target="_blank" rel="noreferrer" style={{fontSize:12,color:C.navy,textDecoration:"none",fontWeight:600,marginTop:4,display:"block"}}>Open in Maps ↗</a>
          </div>
        )}

        <div style={S.modalFields}>
          {Object.entries(FIELD_LABELS).map(([key,label])=>
            ticket.data?.[key]?(
              <div key={key} style={S.modalField}>
                <span style={S.modalFieldLabel}>{label}</span>
                <span style={S.modalFieldVal}>{ticket.data[key]}</span>
              </div>
            ):null
          )}
        </div>
      </div>
    </div>
  );
}

function RosterRow({driver,onRemove,onResetPin}) {
  const [editing,setEditing]=useState(false);
  const [newPin,setNewPin]=useState("");
  return (
    <div style={S.rosterRow}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:18}}>👤</span>
        <span style={{flex:1,fontSize:14,fontWeight:600,color:"#1e293b"}}>{driver.name}</span>
        <button style={S.rosterAction} onClick={()=>setEditing(!editing)}>{editing?"Cancel":"Reset PIN"}</button>
        <button style={{...S.rosterAction,color:"#dc2626"}} onClick={()=>onRemove(driver.name)}>Remove</button>
      </div>
      {editing&&(
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <input style={{...S.fieldInput,flex:1}} placeholder="New 5-digit PIN" type="password"
            inputMode="numeric" maxLength={5} value={newPin}
            onChange={e=>setNewPin(e.target.value.replace(/\D/g,""))} />
          <button style={{...S.solidBtn,padding:"9px 16px",fontSize:13}}
            onClick={()=>{onResetPin(driver.name,newPin);setEditing(false);setNewPin("");}}>Save</button>
        </div>
      )}
    </div>
  );
}

function ManualExport({brokers, tickets, brokerColorFn}) {
  const [broker, setBroker] = useState("");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0,10));
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0,10));
  const filtered = tickets.filter(t=>{
    if (broker && t.broker!==broker) return false;
    const d=new Date(t.timestamp);
    return d>=new Date(startDate)&&d<=new Date(endDate+"T23:59:59");
  });
  const bc = broker ? brokerColorFn(broker) : C.navy;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:10}}>
      <select style={{...S.fieldInput,appearance:"none"}} value={broker} onChange={e=>setBroker(e.target.value)}>
        <option value="">All brokers</option>
        {brokers.map(b=><option key={b.id} value={b.name}>{b.name}</option>)}
      </select>
      <div style={{display:"flex",gap:8}}>
        <div style={{flex:1}}>
          <label style={S.fieldLabel}>From</label>
          <input type="date" style={S.fieldInput} value={startDate} onChange={e=>setStartDate(e.target.value)} />
        </div>
        <div style={{flex:1}}>
          <label style={S.fieldLabel}>To</label>
          <input type="date" style={S.fieldInput} value={endDate} onChange={e=>setEndDate(e.target.value)} />
        </div>
      </div>
      <button style={{...S.solidBtn,width:"100%",background:bc}}
        disabled={filtered.length===0}
        onClick={()=>{
          const brokerObj=brokers.find(b=>b.name===broker)||null;
          exportImagePDF(filtered,`${broker||"All Brokers"} · ${startDate} to ${endDate}`,brokerObj);
        }}>
        Export {filtered.length} Ticket{filtered.length!==1?"s":""}
      </button>
    </div>
  );
}

function AdminPinChanger({onSave}) {
  const [editing,setEditing]=useState(false);
  const [pin,setPin]=useState("");
  const [msg,setMsg]=useState("");
  return (
    <div>
      <div style={S.cardTitle}>🔐 Change Admin PIN</div>
      {!editing?(
        <button style={{...S.outlineBtn,width:"100%",marginTop:10}} onClick={()=>setEditing(true)}>Change Admin PIN</button>
      ):(
        <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:10}}>
          <input style={S.fieldInput} placeholder="New 5-digit PIN" type="password"
            inputMode="numeric" maxLength={5} value={pin}
            onChange={e=>setPin(e.target.value.replace(/\D/g,""))} />
          <button style={{...S.solidBtn,width:"100%"}} onClick={()=>{
            if(pin.length!==5){setMsg("Must be 5 digits.");return;}
            onSave(pin);setEditing(false);setPin("");setMsg("✓ Updated.");
          }}>Save</button>
          <button style={{...S.outlineBtn,width:"100%"}} onClick={()=>{setEditing(false);setPin("");}}>Cancel</button>
          {msg&&<div style={{fontSize:13,color:"#16a34a",textAlign:"center"}}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

// ── COLORS & STYLES ────────────────────────────────────────────────────────
const C = {
  navy: "#1e3a5f",
  gold: "#f0a500",
  bg: "#f8fafc",
  surface: "#ffffff",
  border: "#e2e8f0",
  text: "#1e293b",
  muted: "#64748b",
  dim: "#94a3b8",
};

const S = {
  // Login
  loginWrap: { minHeight:"100vh", background:"#f1f5f9", display:"flex", alignItems:"center", justifyContent:"center", padding:24 },
  loginCard: { background:C.surface, borderRadius:24, padding:"48px 32px 36px", width:"100%", maxWidth:380, textAlign:"center", boxShadow:"0 4px 32px rgba(0,0,0,0.08)" },
  logoMark: { fontSize:48, marginBottom:12 },
  adminLockIcon: { display:"flex", justifyContent:"center", marginBottom:12 },
  loginTitle: { fontSize:32, fontWeight:800, color:C.navy, margin:"0 0 6px", letterSpacing:"-0.5px" },
  loginSub: { color:C.muted, fontSize:14, marginBottom:28, lineHeight:1.5 },
  loginInputWrap: { display:"flex", alignItems:"center", gap:10, background:"#f8fafc", border:`1.5px solid ${C.border}`, borderRadius:14, padding:"13px 16px", marginBottom:12 },
  loginInputInner: { flex:1, border:"none", background:"transparent", color:C.text, fontSize:16, outline:"none" },
  pinDots: { display:"flex", gap:5, alignItems:"center" },
  pinDot: { width:8, height:8, borderRadius:"50%", background:C.border },
  pinDotFilled: { background:C.navy },
  loginError: { color:"#dc2626", fontSize:13, textAlign:"center", marginBottom:8 },
  loginBtn: { width:"100%", padding:"15px", borderRadius:14, border:"none", background:C.navy, color:"#fff", fontWeight:700, fontSize:16, cursor:"pointer", marginBottom:16, marginTop:4 },
  loginGhost: { width:"100%", padding:"12px", borderRadius:12, border:`1.5px solid ${C.border}`, background:"transparent", color:C.muted, fontWeight:600, fontSize:14, cursor:"pointer" },
  loginDivider: { display:"flex", alignItems:"center", gap:12, margin:"4px 0 12px" },
  loginDividerText: { color:C.dim, fontSize:13 },
  loginAdminLink: { background:"none", border:"none", color:C.navy, fontWeight:600, fontSize:15, cursor:"pointer", padding:"4px 0" },
  loginVersion: { fontSize:12, color:C.dim, marginTop:20 },
  // App shell
  app: { height:"100vh", background:C.bg, fontFamily:"-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", display:"flex", flexDirection:"column", overflow:"hidden" },  adminApp: { minHeight:"100vh", background:C.bg, fontFamily:"-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", paddingBottom:40 },
  // Driver header
  driverHeader: { background:C.surface, borderBottom:`1px solid ${C.border}`, padding:"14px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 },
  driverName: { fontSize:18, fontWeight:700, color:C.navy },
  driverDate: { fontSize:12, color:C.muted, marginTop:2 },
  signOutBtn: { fontSize:12, fontWeight:500, color:C.muted, background:"none", border:"none", cursor:"pointer", padding:"4px 0" },
  // Content area
  driverContent: { flex:1, overflowY:"auto", paddingBottom:0 },
  // Bottom tab bar
  bottomTabBar: { display:"flex", background:C.surface, borderTop:`1px solid ${C.border}`, flexShrink:0, paddingBottom:"env(safe-area-inset-bottom,0px)" },
  bottomTab: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"10px 0 8px", background:"none", border:"none", cursor:"pointer", gap:4 },
  bottomTabActive: {},
  bottomTabLabel: { fontSize:11, color:"#94a3b8", fontWeight:500 },
  // Capture
  captureWrap: { padding:20 },
  captureIdleWrap: { display:"flex", flexDirection:"column", gap:12 },
  captureIdleCard: { background:C.surface, borderRadius:20, padding:"36px 24px 28px", textAlign:"center" },
  captureIconCircle: { width:80, height:80, borderRadius:"50%", background:"#f1f5f9", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 20px" },
  captureIdleIcon: { fontSize:48, marginBottom:12 },
  captureIdleTitle: { fontSize:24, fontWeight:800, color:C.navy, marginBottom:6 },
  captureIdleSub: { fontSize:14, color:C.muted, marginBottom:24 },
  captureBigBtn: { width:"100%", padding:"16px", borderRadius:14, border:"none", background:C.navy, color:"#fff", fontWeight:700, fontSize:17, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:10 },
  captureHint: { display:"flex", alignItems:"center", gap:8, background:"#f8fafc", border:`1px solid ${C.border}`, borderRadius:10, padding:"10px 14px", marginTop:16, textAlign:"left" },
  todaySummary: { background:C.surface, borderRadius:12, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", border:`1px solid ${C.border}` },
  todaySummaryLabel: { fontSize:13, fontWeight:600, color:C.muted },
  todaySummaryVal: { fontSize:13, fontWeight:700, color:C.navy },
  captureStepWrap: { display:"flex", flexDirection:"column", gap:12 },
  imgPreviewWrap: { position:"relative", background:"#000", borderRadius:14, overflow:"hidden" },
  imgPreview: { width:"100%", maxHeight:320, objectFit:"contain", display:"block" },
  statusStack: { display:"flex", flexDirection:"column", gap:8 },
  statusChip: { display:"flex", alignItems:"center", gap:8, padding:"10px 14px", borderRadius:10, border:"1px solid", background:C.bg },
  warnChip: { display:"flex", alignItems:"center", gap:8, padding:"10px 14px", borderRadius:10, border:"1px solid" },
  actionRow: { display:"flex", gap:8 },
  solidBtn: { padding:"13px 20px", borderRadius:10, border:"none", background:C.navy, color:"#fff", fontWeight:700, fontSize:15, cursor:"pointer" },
  outlineBtn: { padding:"13px 20px", borderRadius:10, border:`1.5px solid ${C.border}`, background:"transparent", color:C.muted, fontWeight:600, fontSize:14, cursor:"pointer" },
  ghostLink: { textAlign:"center", color:C.muted, fontSize:13, background:"none", border:"none", cursor:"pointer", padding:"4px 0" },
  errorBox: { background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:10, padding:"10px 14px", color:"#dc2626", fontSize:13 },
  // Review
  reviewHeader: { background:C.surface, borderRadius:14, padding:14, display:"flex", gap:14, border:`1px solid ${C.border}` },
  reviewThumb: { width:90, height:90, borderRadius:10, objectFit:"cover", background:"#f1f5f9", flexShrink:0 },
  reviewHeaderInfo: { flex:1, display:"flex", flexDirection:"column", gap:6 },
  reviewSupplier: { fontSize:12, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:"0.05em" },
  reviewTicketNum: { fontSize:20, fontWeight:800, color:C.navy, fontFamily:"monospace" },
  netTonsBadge: { display:"inline-flex", alignItems:"baseline", gap:6, background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:8, padding:"6px 12px" },
  netTonsNum: { fontSize:24, fontWeight:800, color:C.navy, fontFamily:"monospace" },
  netTonsLabel: { fontSize:10, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:"0.08em" },
  dupWarning: { background:"#fef2f2", border:"1.5px solid #fca5a5", borderRadius:12, padding:"12px 14px" },
  dupWarningTitle: { fontSize:14, fontWeight:800, color:"#dc2626", marginBottom:4 },
  dupWarningText: { fontSize:13, color:"#64748b", lineHeight:1.5 },
  // Fields
  fieldsGrid: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 },
  fieldWrap: { display:"flex", flexDirection:"column", gap:4 },
  fieldLabel: { fontSize:10, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:"0.06em" },
  fieldInput: { background:C.bg, border:`1.5px solid ${C.border}`, borderRadius:8, padding:"9px 12px", color:C.text, fontSize:14, outline:"none", width:"100%", boxSizing:"border-box" },
  // Period
  periodWrap: { padding:20, display:"flex", flexDirection:"column", gap:12 },
  periodNav: { display:"flex", alignItems:"center", gap:8, background:C.surface, borderRadius:12, padding:"12px 16px", border:`1px solid ${C.border}` },
  periodNavBtn: { background:"none", border:"none", fontSize:20, color:C.navy, cursor:"pointer", padding:"0 4px", fontWeight:700 },
  periodNavCenter: { flex:1, textAlign:"center" },
  periodNavLabel: { fontSize:14, fontWeight:700, color:C.navy },
  periodNavDates: { fontSize:12, color:C.muted, marginTop:2 },
  periodSummary: { background:C.surface, borderRadius:12, padding:"16px", display:"flex", alignItems:"center", border:`1px solid ${C.border}` },
  periodSummaryItem: { flex:1, textAlign:"center" },
  periodSummaryNum: { fontSize:28, fontWeight:800, color:C.navy, fontFamily:"monospace" },
  periodSummaryLabel: { fontSize:11, color:C.muted, textTransform:"uppercase", letterSpacing:"0.06em", marginTop:2 },
  periodSummaryDivider: { width:1, height:40, background:C.border },
  // Ticket cards
  ticketList: { display:"flex", flexDirection:"column", gap:8 },
  driverTicketCard: { background:C.surface, borderRadius:12, padding:14, display:"flex", gap:12, border:`1px solid ${C.border}`, cursor:"pointer", boxShadow:"0 1px 4px rgba(0,0,0,0.04)" },
  driverTicketThumb: { width:64, height:64, borderRadius:8, objectFit:"cover", background:"#f1f5f9", flexShrink:0 },
  driverTicketInfo: { flex:1, minWidth:0 },
  driverTicketTop: { display:"flex", alignItems:"center", gap:6, marginBottom:4 },
  driverTicketTons: { fontSize:20, fontWeight:800, color:C.navy, fontFamily:"monospace", marginBottom:4 },
  driverTicketMeta: { display:"flex", gap:8, fontSize:12, color:C.muted, flexWrap:"wrap" },
  driverTicketTime: { fontSize:11, color:C.dim, marginTop:4 },
  loadPill: { fontSize:11, fontWeight:700, color:C.navy, background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:20, padding:"2px 8px" },
  supplierText: { fontSize:12, color:C.muted, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  // Admin
  adminHeader: { background:C.navy, color:"#fff", padding:"16px 20px", display:"flex", alignItems:"center", justifyContent:"space-between" },
  adminHeaderLeft: { display:"flex", flexDirection:"column", gap:4 },
  adminTitle: { fontSize:18, fontWeight:800, color:"#fff" },
  adminSub: { fontSize:12, color:"rgba(255,255,255,.6)", display:"flex", alignItems:"center", gap:4 },
  periodSmallBtn: { background:"rgba(255,255,255,.15)", border:"none", color:"#fff", fontSize:14, borderRadius:6, padding:"0 6px", cursor:"pointer", fontWeight:700 },
  adminSummaryRow: { display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, padding:"12px 16px", background:C.surface, borderBottom:`1px solid ${C.border}` },
  summaryCard: { background:C.bg, border:`1px solid ${C.border}`, borderRadius:10, padding:"10px 8px", textAlign:"center" },
  summaryNum: { fontSize:22, fontWeight:800, color:C.text, fontFamily:"monospace" },
  summaryLabel: { fontSize:10, color:C.muted, textTransform:"uppercase", letterSpacing:"0.06em", marginTop:2 },
  flagSummary: { padding:"10px 16px", display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", background:"#fef2f2", borderBottom:`1px solid #fca5a5` },
  flagSummaryTitle: { fontSize:12, fontWeight:700, color:"#dc2626" },
  adminTabBar: { display:"flex", background:C.surface, borderBottom:`1px solid ${C.border}` },
  adminTab: { flex:1, padding:"12px 0", fontSize:14, fontWeight:600, color:C.muted, background:"none", border:"none", borderBottom:"2px solid transparent", cursor:"pointer" },
  adminTabActive: { color:C.navy, borderBottomColor:C.navy },
  adminBody: { padding:16 },
  adminTicketCard: { background:C.surface, borderRadius:12, padding:12, display:"flex", gap:12, border:`1px solid ${C.border}`, cursor:"pointer", marginBottom:1, boxShadow:"0 1px 3px rgba(0,0,0,0.04)" },
  adminTicketThumb: { width:56, height:56, borderRadius:8, objectFit:"cover", background:"#f1f5f9", flexShrink:0 },
  adminTicketInfo: { flex:1, minWidth:0 },
  adminTicketTop: { display:"flex", alignItems:"center", gap:6, marginBottom:3 },
  adminDriverName: { fontSize:14, fontWeight:700, color:C.navy },
  adminTicketMiddle: { display:"flex", gap:8, alignItems:"baseline", marginBottom:3 },
  adminTicketBottom: { display:"flex", gap:8, fontSize:12, color:C.muted, flexWrap:"wrap" },
  // Export / Roster
  brokerFilterBar: { display:"flex", gap:6, flexWrap:"wrap", padding:"12px 0 4px", overflowX:"auto" },
  brokerFilterBtn: { fontSize:12, fontWeight:600, padding:"5px 14px", borderRadius:20, border:`1.5px solid ${C.border}`, background:"transparent", color:C.muted, cursor:"pointer", whiteSpace:"nowrap" },
  brokerFilterActive: { background:C.navy, color:"#fff", borderColor:C.navy },
  exportStack: { display:"flex", flexDirection:"column", gap:12 },
  card: { background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:16, boxShadow:"0 1px 4px rgba(0,0,0,0.04)" },
  cardTitle: { fontSize:15, fontWeight:700, color:C.navy },
  stubRow: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:`1px solid ${C.border}`, fontSize:13, color:C.muted },
  rosterRow: { background:C.bg, borderRadius:8, padding:"10px 12px" },
  rosterAction: { fontSize:12, fontWeight:600, color:C.navy, background:"none", border:"none", cursor:"pointer" },
  // Modal
  modalOverlay: { position:"fixed", inset:0, background:"rgba(15,23,42,0.6)", zIndex:100, display:"flex", alignItems:"flex-end", justifyContent:"center", padding:16 },
  modal: { background:C.surface, borderRadius:20, width:"100%", maxWidth:520, maxHeight:"88vh", overflowY:"auto", boxShadow:"0 20px 60px rgba(0,0,0,0.2)" },
  modalHeader: { display:"flex", alignItems:"flex-start", justifyContent:"space-between", padding:"20px 20px 12px" },
  modalTitle: { fontSize:18, fontWeight:800, color:C.navy },
  modalSub: { fontSize:12, color:C.muted, marginTop:2 },
  closeBtn: { background:"none", border:"none", color:C.dim, fontSize:20, cursor:"pointer", padding:4 },
  modalImg: { width:"100%", maxHeight:240, objectFit:"contain", background:"#f8fafc" },
  modalTons: { margin:"12px 16px", background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:10, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" },
  modalTonsNum: { fontSize:32, fontWeight:800, color:C.navy, fontFamily:"monospace" },
  modalTonsLabel: { fontSize:12, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:"0.08em" },
  dateCompareBox: { background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 12px" },
  dateCompareLabel: { fontSize:10, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:3 },
  dateCompareVal: { fontSize:14, fontWeight:600, color:C.text },
  modalGps: { margin:"8px 16px", background:"#f0fdf4", border:"1px solid #86efac", borderRadius:10, padding:"12px" },
  modalFields: { padding:"8px 16px 20px", display:"flex", flexDirection:"column" },
  modalField: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 0", borderBottom:`1px solid ${C.border}` },
  modalFieldLabel: { fontSize:11, color:C.muted, textTransform:"uppercase", letterSpacing:"0.06em" },
  modalFieldVal: { fontSize:13, fontWeight:600, color:C.text, textAlign:"right", maxWidth:"65%" },
  // Empty
  emptyState: { textAlign:"center", padding:"48px 0" },
  emptyIcon: { fontSize:36, marginBottom:8 },
  emptyText: { fontSize:14, color:C.muted },
};
