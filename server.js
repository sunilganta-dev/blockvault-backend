// backend/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import { Blockchain } from "./blockchain.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const HTTP_PORT = 5500;
const WS_PORT = 5501;

const blockchain = new Blockchain();

// -------------------- Serve frontend --------------------
const FRONTEND_DIR = "/home/ubuntu/blockvaultprivate/api-gateway/public";
app.use(express.static(FRONTEND_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// -------------------- Evidence setup --------------------
const EVIDENCE_DIR = path.join(FRONTEND_DIR, "evidence");
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
app.use("/evidence", express.static(EVIDENCE_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// -------------------- WebSocket --------------------
const wss = new WebSocketServer({ port: WS_PORT });
wss.on("connection", () => {
  // silent
});

// -------------------- Blockchain routes --------------------
app.get("/blocks", (req, res) => res.json(blockchain.chain));

app.post("/newEvent", (req, res) => {
  const payload = req.body || {};
  const data = {
    type: payload.type || "Unknown Event",
    confidence: payload.confidence != null ? Number(payload.confidence) : null,
    meta: payload.meta || {},
  };

  const newBlock = blockchain.addBlock(data);

  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(JSON.stringify(newBlock));
  });

  res.json(newBlock);
});

// -------------------- Analyze Frame (demo mode) --------------------
app.post("/analyzeFrame", (req, res) => {
  try {
    const { imageBase64, info = {}, demoMode = false, forceSuspicious = false } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    // Save snapshot into frontend/evidence
    const ts = Date.now();
    const rnd = Math.floor(Math.random() * 1e6);
    const fileExt = imageBase64.startsWith("data:image/png") ? "png" : "jpg";
    const filename = `evidence_${ts}_${rnd}.${fileExt}`;
    const filepath = path.join(EVIDENCE_DIR, filename);
    const comma = imageBase64.indexOf(",");
    const base64Data = comma >= 0 ? imageBase64.slice(comma + 1) : imageBase64;
    fs.writeFileSync(filepath, Buffer.from(base64Data, "base64"));

    // ----- Demo heuristic (safe) -----
    const detections = Array.isArray(info.detections) ? info.detections : [];
    const classes = detections.map((d) => String(d.class).toLowerCase());
    const motionPercent = typeof info.motionPercent === "number" ? info.motionPercent : 0;

    let suspicious = false;
    let score = 0;
    let labels = [];

    if (forceSuspicious) {
      suspicious = true;
      score = 95;
      labels.push("manual-trigger");
    } else if (motionPercent >= 40 && classes.length === 0) {
      suspicious = true;
      score = Math.min(90, Math.round(motionPercent));
      labels.push("high-motion-no-person");
    } else if (classes.includes("backpack") && motionPercent > 10) {
      suspicious = true;
      score = 85;
      labels.push("backpack-motion");
    } else if (demoMode && Math.random() < 0.3) {
      suspicious = true;
      score = 70;
      labels.push("demo-randomized");
    }

    // Save metadata JSON
    fs.writeFileSync(
      filepath + ".json",
      JSON.stringify({ info, analysis: { suspicious, score, labels } }, null, 2)
    );

    res.json({
      suspicious,
      score,
      labels,
      evidenceId: filename,
      previewUrl: `/evidence/${filename}`,
    });
  } catch (err) {
    console.error("analyzeFrame error", err);
    res.status(500).json({ error: "internal error" });
  }
});

// -------------------- Evidence Viewer page --------------------
app.get("/review", (req, res) => {
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
        <h1>📁 Evidence Viewer</h1>
        <div class="grid">${rows || "<p>No evidence saved yet.</p>"}</div>
      </body>
      </html>`);
  } catch (err) {
    res.status(500).send("<pre>Error reading evidence folder.</pre>");
  }
});

// -------------------- Startup logs --------------------
app.listen(HTTP_PORT, () =>
  console.log(`✅ Demo running → http://localhost:${HTTP_PORT}/index.html`)
);
console.log(`🌐 WebSocket → ws://localhost:${WS_PORT}`);
