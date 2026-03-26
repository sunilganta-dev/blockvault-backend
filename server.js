// BlockVault Systems — Backend
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { Blockchain } from "./blockchain.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const HTTP_PORT = 5500;
const WS_PORT = 5501;

const blockchain = new Blockchain();

// -------------------- Face Recognition Queue --------------------
const FACE_SERVICE_URL = "http://localhost:8001";
const faceQueue = [];
const activeAnalyses = new Set();
const FR_CONCURRENCY = 2;

async function callFaceService(imageBase64, cameraId) {
  const resp = await fetch(`${FACE_SERVICE_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64, cameraId }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`FR service HTTP ${resp.status}`);
  return resp.json();
}

function pumpFaceQueue() {
  while (faceQueue.length > 0 && activeAnalyses.size < FR_CONCURRENCY) {
    const job = faceQueue.shift();
    activeAnalyses.add(job.blockIndex);
    runFaceJob(job).finally(() => {
      activeAnalyses.delete(job.blockIndex);
      pumpFaceQueue();
    });
  }
}

async function runFaceJob({ blockIndex, imageBase64, cameraId }) {
  try {
    const result = await callFaceService(imageBase64, cameraId);
    const decision = result.frDecision || (result.ok ? "UNKNOWN" : "ERROR");
    const update = { frDecision: decision, faces: result.faces || [], bestMatch: result.bestMatch || null };
    const block = blockchain.chain[blockIndex];
    if (block) {
      block.data.faceAnalysis = update;
      blockchain.saveChain();
      wss.clients.forEach((c) => {
        if (c.readyState === 1) c.send(JSON.stringify({ _frUpdate: true, blockIndex, faceAnalysis: update }));
      });
    }
  } catch (err) {
    console.error("FR job error:", err.message);
    const block = blockchain.chain[blockIndex];
    if (block) {
      block.data.faceAnalysis = { frDecision: "ERROR", error: err.message };
      blockchain.saveChain();
    }
  }
}

function enqueueFaceAnalysis(blockIndex, imageBase64, cameraId) {
  if (!imageBase64) return;
  faceQueue.push({ blockIndex, imageBase64, cameraId });
  pumpFaceQueue();
}

// ES-module __dirname (needed on Mac/local; Ubuntu hardcoded path works on server)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve frontend dir: works locally (Mac) and on Ubuntu server
const FRONTEND_DIR = fs.existsSync("/home/ubuntu/blockvaultprivate/api-gateway/public")
  ? "/home/ubuntu/blockvaultprivate/api-gateway/public"
  : path.join(__dirname, "../blockvaultprivate/api-gateway/public");

// -------------------- Serve frontend --------------------
app.use(express.static(FRONTEND_DIR));

app.get("/", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// -------------------- Evidence setup --------------------
const EVIDENCE_DIR = path.join(FRONTEND_DIR, "evidence");
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
app.use("/evidence", express.static(EVIDENCE_DIR));

// -------------------- WebSocket --------------------
const wss = new WebSocketServer({ port: WS_PORT });
wss.on("connection", () => {
  // silent
});

// -------------------- Blockchain routes --------------------

// Return all incidents (skip genesis block) — evidenceUri stripped to keep payload small
app.get("/blocks", (_req, res) => {
  const incidents = blockchain.chain.slice(1).map((b) => {
    const { evidenceUri, ...dataWithoutImage } = b.data;
    return {
      ...dataWithoutImage,
      _hasImage: !!evidenceUri,
      _blockIndex: b.index,
      _blockHash: b.hash,
      _prevHash: b.previousHash,
      _blockTs: b.timestamp,
    };
  });
  res.json(incidents);
});

// Serve evidence image for a single block (lazy-loaded by frontend)
app.get("/block/:index/img", (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const block = blockchain.chain[idx];
  if (!block || !block.data.evidenceUri) return res.status(404).send("No image");
  const uri = block.data.evidenceUri;
  const comma = uri.indexOf(",");
  const base64Data = comma >= 0 ? uri.slice(comma + 1) : uri;
  const mimeMatch = uri.match(/^data:([^;]+);/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(Buffer.from(base64Data, "base64"));
});

app.post("/newEvent", (req, res) => {
  const { cameraId, type, severity, meta, imageBase64 } = req.body || {};

  if (!type) return res.status(400).json({ ok: false, error: "type is required" });

  // Hash the image evidence and the metadata for tamper-proof audit trail
  const evidenceHash = imageBase64
    ? crypto.createHash("sha256").update(imageBase64).digest("hex")
    : null;

  const metadataHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(meta || {}))
    .digest("hex");

  const data = {
    ts: new Date().toISOString(),
    cameraId: cameraId || "cam-1",
    type,
    severity: severity ?? 50,
    reasons: meta?.why ? [meta.why] : [],
    signals: {
      tamperSuspected: meta?.tamperSuspected ?? false,
      repositionSuspected: meta?.repositionSuspected ?? false,
    },
    evidenceUri: imageBase64 || null,
    evidenceHash,
    metadataHash,
    meta: meta || {},
    faceAnalysis: imageBase64 ? { frDecision: "PENDING" } : { frDecision: "NO_IMAGE" },
  };

  const newBlock = blockchain.addBlock(data);

  // Kick off async face recognition (non-blocking)
  if (imageBase64) enqueueFaceAnalysis(newBlock.index, imageBase64, cameraId || "cam-1");

  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(JSON.stringify(newBlock));
  });

  res.json({ ok: true, block: { index: newBlock.index, hash: newBlock.hash, previousHash: newBlock.previousHash, timestamp: newBlock.timestamp } });
});

// -------------------- Analyze Frame --------------------
app.post("/analyzeFrame", (req, res) => {
  try {
    const { imageBase64, info = {} } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    const ts = Date.now();
    const rnd = Math.floor(Math.random() * 1e6);
    const fileExt = imageBase64.startsWith("data:image/png") ? "png" : "jpg";
    const filename = `evidence_${ts}_${rnd}.${fileExt}`;
    const filepath = path.join(EVIDENCE_DIR, filename);
    const comma = imageBase64.indexOf(",");
    const base64Data = comma >= 0 ? imageBase64.slice(comma + 1) : imageBase64;
    fs.writeFileSync(filepath, Buffer.from(base64Data, "base64"));

    const detections = Array.isArray(info.detections) ? info.detections : [];
    const classes = detections.map((d) => String(d.class).toLowerCase());
    const motionPercent = typeof info.motionPercent === "number" ? info.motionPercent : 0;

    let suspicious = false;
    let score = 0;
    let labels = [];

    if (motionPercent >= 40 && classes.length === 0) {
      suspicious = true;
      score = Math.min(90, Math.round(motionPercent));
      labels.push("high-motion-no-person");
    } else if (classes.includes("backpack") && motionPercent > 10) {
      suspicious = true;
      score = 85;
      labels.push("backpack-motion");
    }

    fs.writeFileSync(
      filepath + ".json",
      JSON.stringify({ info, analysis: { suspicious, score, labels } }, null, 2)
    );

    res.json({ suspicious, score, labels, evidenceId: filename, previewUrl: `/evidence/${filename}` });
  } catch (err) {
    console.error("analyzeFrame error", err);
    res.status(500).json({ error: "internal error" });
  }
});

// -------------------- Evidence Viewer page --------------------
app.get("/review", (_req, res) => {
  try {
    const files = fs
      .readdirSync(EVIDENCE_DIR)
      .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
      .sort(
        (a, b) =>
          fs.statSync(path.join(EVIDENCE_DIR, b)).mtimeMs -
          fs.statSync(path.join(EVIDENCE_DIR, a)).mtimeMs
      );

    const rows = files
      .map((f) => {
        const metaPath = path.join(EVIDENCE_DIR, f + ".json");
        let meta = {};
        if (fs.existsSync(metaPath)) {
          try {
            meta = JSON.parse(fs.readFileSync(metaPath));
          } catch {}
        }
        const labels =
          meta.analysis && meta.analysis.labels
            ? meta.analysis.labels.join(", ")
            : "";
        const time =
          meta.info && meta.info.motionPercent
            ? `motion ${meta.info.motionPercent.toFixed(1)}%`
            : "";
        return `
          <div class="card">
            <img src="/evidence/${f}" alt="${f}" />
            <div class="meta">
              <b>${f}</b><br/>
              <small>${labels} ${time}</small><br/>
              <a href="/evidence/${f}" target="_blank">open</a>
            </div>
          </div>`;
      })
      .join("\n");

    res.send(`<!doctype html>
      <html>
      <head>
        <title>Evidence Viewer</title>
        <style>
          body{font-family:system-ui;background:#0e0e0e;color:#eee;margin:0;padding:20px;}
          h1{color:#00ffae;margin-bottom:20px;}
          .grid{display:flex;flex-wrap:wrap;gap:12px;}
          .card{background:#1a1a1a;border-radius:10px;overflow:hidden;
                width:220px;box-shadow:0 0 8px #0005;}
          .card img{width:100%;height:150px;object-fit:cover;display:block;}
          .meta{padding:8px;font-size:12px;}
          a{color:#00ffae;text-decoration:none;}
        </style>
      </head>
      <body>
        <h1>Evidence Viewer</h1>
        <div class="grid">${rows || "<p>No evidence saved yet.</p>"}</div>
      </body>
      </html>`);
  } catch (err) {
    res.status(500).send("<pre>Error reading evidence folder.</pre>");
  }
});

// -------------------- Face Enrolment --------------------
const FR_DB_DIR = fs.existsSync("/home/ubuntu/BlockVault-FR/face_service/face_db/authorized")
  ? "/home/ubuntu/BlockVault-FR/face_service/face_db/authorized"
  : null;

app.post("/enrollFace", async (req, res) => {
  try {
    const { name, imageBase64 } = req.body || {};
    if (!name || !imageBase64) return res.status(400).json({ ok: false, error: "Name and image are required." });
    if (!FR_DB_DIR) return res.status(503).json({ ok: false, error: "FR database not available on this server." });

    // Validate name
    const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (!safeName) return res.status(400).json({ ok: false, error: "Invalid name. Use letters, numbers, underscores or hyphens only." });

    // Validate image format
    const allowedFormats = ["data:image/jpeg", "data:image/jpg", "data:image/png"];
    if (!allowedFormats.some((f) => imageBase64.startsWith(f))) {
      return res.status(400).json({ ok: false, error: "Invalid file format. Only JPEG and PNG images are accepted." });
    }

    // Validate image size (max 10MB base64 ≈ 7.5MB file)
    const sizeBytes = Buffer.byteLength(imageBase64, "utf8");
    if (sizeBytes > 10 * 1024 * 1024) {
      return res.status(400).json({ ok: false, error: "Image too large. Maximum allowed size is 10MB." });
    }

    // Check for duplicate
    const personDir = path.join(FR_DB_DIR, safeName);
    if (fs.existsSync(personDir)) {
      return res.status(409).json({ ok: false, error: `Person "${safeName}" already exists in the database. Use a different name or remove the existing entry first.` });
    }

    fs.mkdirSync(personDir, { recursive: true });

    const comma = imageBase64.indexOf(",");
    const base64Data = comma >= 0 ? imageBase64.slice(comma + 1) : imageBase64;
    const fileExt = imageBase64.startsWith("data:image/png") ? "png" : "jpg";
    fs.writeFileSync(path.join(personDir, `${Date.now()}.${fileExt}`), Buffer.from(base64Data, "base64"));

    const reloadResp = await fetch(`${FACE_SERVICE_URL}/reload`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
    });
    const reloadData = await reloadResp.json();

    res.json({ ok: true, name: safeName, db_size: reloadData.db_size, db_embeddings: reloadData.db_embeddings });
  } catch (err) {
    console.error("enrollFace error:", err.message);
    res.status(500).json({ ok: false, error: "Server error during enrollment. Please try again." });
  }
});

// -------------------- Startup logs --------------------
app.listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`Backend running → http://0.0.0.0:${HTTP_PORT}/index.html`);
});
console.log(`WebSocket → ws://localhost:${WS_PORT}`);
