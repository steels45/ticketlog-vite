// api/extract.js — Vercel serverless function
// Hybrid extraction: Azure Document Intelligence for trained models, Claude Vision fallback

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: "No image provided" });

  // ── STEP 1: Detect supplier via quick Claude call ─────────────────────
  let supplier = null;
  try {
    supplier = await detectSupplier(image);
  } catch {}

  // ── STEP 2: Route to Azure or Claude based on supplier ────────────────
  const AZURE_MODELS = {
    "amrize": "amrize-v1",
    // Add more as models are trained:
    // "apac": "apac-v1",
    // "scalehouse": "scalehouse-v1",
    // "terral": "terral-v1",
    // "magnolia": "magnolia-v1",
    // "superior": "superior-v1",
    // "gw": "gw-v1",
  };

  const supplierKey = supplier?.toLowerCase().replace(/[^a-z]/g, "") || "";
  const azureModelId = Object.keys(AZURE_MODELS).find(k => supplierKey.includes(k))
    ? AZURE_MODELS[Object.keys(AZURE_MODELS).find(k => supplierKey.includes(k))]
    : null;

  let result;
  if (azureModelId) {
    try {
      result = await extractWithAzure(image, azureModelId);
    } catch (err) {
      console.error("Azure extraction failed, falling back to Claude:", err.message);
      result = await extractWithClaude(image);
    }
  } else {
    result = await extractWithClaude(image);
  }

  return res.status(200).json({ ...result, _extractedBy: azureModelId ? `azure:${azureModelId}` : "claude" });
}

// ── SUPPLIER DETECTION ────────────────────────────────────────────────────
async function detectSupplier(base64Image) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } },
          { type: "text", text: "What company issued this ticket? Reply with ONLY the company name, nothing else. Examples: APAC, Amrize, ScaleHouse, Terral, Magnolia, Superior, G&W" }
        ]
      }]
    })
  });
  const data = await response.json();
  return data.content?.[0]?.text?.trim() || null;
}

// ── AZURE DOCUMENT INTELLIGENCE ───────────────────────────────────────────
async function extractWithAzure(base64Image, modelId) {
  const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;

  // Submit analysis job
  const analyzeUrl = `${endpoint}documentintelligence/documentModels/${modelId}:analyze?api-version=2024-02-29-preview`;
  const submitRes = await fetch(analyzeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": key,
    },
    body: JSON.stringify({
      base64Source: base64Image,
    }),
  });

  if (!submitRes.ok) {
    const err = await submitRes.text();
    throw new Error(`Azure submit failed: ${err}`);
  }

  // Get operation URL from header
  const operationUrl = submitRes.headers.get("Operation-Location");
  if (!operationUrl) throw new Error("No operation URL returned");

  // Poll for result (max 30s)
  let result = null;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(operationUrl, {
      headers: { "Ocp-Apim-Subscription-Key": key },
    });
    const pollData = await pollRes.json();
    if (pollData.status === "succeeded") { result = pollData; break; }
    if (pollData.status === "failed") throw new Error("Azure analysis failed");
  }

  if (!result) throw new Error("Azure analysis timed out");

  // Map Azure fields to standardized field names
  const doc = result.analyzeResult?.documents?.[0];
  if (!doc) throw new Error("No document found in Azure result");

  const fields = doc.fields || {};
  const get = (key) => fields[key]?.content || fields[key]?.valueString || null;
  const getConf = (key) => fields[key]?.confidence || null;
  const getSig = (key) => {
    const f = fields[key];
    if (!f) return false;
    return f.valueSignature === "signed" || f.confidence > 0.5;
  };

  // Convert weight if needed (handle lbs → tons)
  const parseNetTons = () => {
    const raw = get("netTons");
    if (!raw) return null;
    const num = parseFloat(raw.replace(/[^0-9.]/g, ""));
    if (isNaN(num)) return null;
    // If value looks like pounds (> 500), convert
    return num > 500 ? (num / 2000).toFixed(2) : String(num);
  };

  return {
    supplier: get("supplier") || "Amrize",
    ticketNumber: get("ticketNumber"),
    date: get("date"),
    time: get("time"),
    customer: get("customer"),
    orderNumber: get("orderNumber"),
    poNumber: get("poNumber"),
    jobSite: get("jobSite"),
    location: get("location"),
    truckNumber: get("truckNumber"),
    carrierName: get("carrierName"),
    product: get("product"),
    grossTons: get("grossWeight"),
    tareTons: get("tareWeight"),
    netTons: parseNetTons(),
    weighmaster: get("weighmaster"),
    receiverSignature: getSig("receiverSignature"),
    receivedStamp: getSig("receivedStamp"),
    _confidence: {
      netTons: getConf("netTons"),
      ticketNumber: getConf("ticketNumber"),
      customer: getConf("customer"),
      truckNumber: getConf("truckNumber"),
    },
  };
}

// ── CLAUDE VISION FALLBACK ────────────────────────────────────────────────
async function extractWithClaude(base64Image) {
  const PROMPT = `You are an expert at reading trucking and hauling weight tickets from multiple suppliers.

Identify the supplier and extract all fields. Return ONLY valid JSON:
{
  "supplier": "company name on ticket",
  "ticketNumber": "ticket number",
  "date": "date",
  "time": "time",
  "customer": "customer name",
  "orderNumber": "order or job number",
  "poNumber": "PO number",
  "jobSite": "job site or delivery location name",
  "location": "pit or yard location",
  "truckNumber": "truck/vehicle number",
  "carrierName": "hauling company name",
  "product": "material type",
  "grossTons": "gross weight in tons",
  "tareTons": "tare weight in tons",
  "netTons": "net weight in tons as decimal",
  "weighmaster": "weighmaster name",
  "receiverSignature": true or false,
  "receivedStamp": true or false
}

RULES:
- netTons = NET weight only, always in tons (convert lbs/2000 if needed)
- receiverSignature: true only if handwritten signature visible
- receivedStamp: true only if rubber/ink stamp visible
- null for any field not found`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } },
          { type: "text", text: PROMPT }
        ]
      }]
    })
  });

  if (!response.ok) throw new Error("Claude API error");
  const data = await response.json();
  const text = data.content?.map(c => c.text || "").join("") || "{}";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return {};
  }
}
