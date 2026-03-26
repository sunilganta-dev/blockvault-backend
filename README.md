# BlockVault Backend

Express API server and private blockchain engine for BlockVault Systems. Handles security event ingestion, on-chain storage, face recognition queuing, and real-time WebSocket broadcasting.

---

## Architecture

```
POST /newEvent
      │
      ├── Hash evidence (SHA-256)
      ├── Hash metadata (SHA-256)
      ├── Append block to chain
      ├── Broadcast to WebSocket clients
      └── Enqueue face recognition job
                │
                ▼
         BlockVault-FR :8001
         /verify → ALLOW / UNKNOWN / NO_FACE / ERROR
                │
                ▼
         Mutate block.data.faceAnalysis
         Save chain
         Broadcast FR result via WebSocket
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/blocks` | All incidents — metadata only, no image payloads |
| `POST` | `/newEvent` | Log a security event and add it to the chain |
| `GET` | `/block/:index/img` | Serve evidence image for a specific block |
| `POST` | `/analyzeFrame` | Save a camera frame and run motion heuristics |
| `POST` | `/enrollFace` | Enroll a new face into the FR database |
| `GET` | `/review` | Evidence viewer |

---

## Block Structure

```json
{
  "index": 42,
  "timestamp": "2026-03-26T10:00:00.000Z",
  "previousHash": "a3f1...",
  "hash": "9c2d...",
  "data": {
    "ts": "2026-03-26T10:00:00.000Z",
    "cameraId": "axis-camera",
    "type": "TAMPER",
    "severity": 90,
    "reasons": ["LENS_COVER_OR_OBSTRUCTION"],
    "signals": {
      "tamperSuspected": true,
      "repositionSuspected": false
    },
    "evidenceHash": "sha256...",
    "metadataHash": "sha256...",
    "faceAnalysis": {
      "frDecision": "UNKNOWN",
      "faces": [],
      "bestMatch": null
    }
  }
}
```

---

## Setup

```bash
npm install
node server.js
```

Runs on port `5500` (HTTP API) and `5501` (WebSocket).

Requires `BlockVault-FR` face recognition service running on `http://localhost:8001`.

---

## Face Enrollment

Photos are stored at:
```
BlockVault-FR/face_service/face_db/authorized/<person_name>/
```

Use the `POST /enrollFace` endpoint (or the Settings panel in the UI) to add a new person. Embeddings are reloaded automatically after each enrollment.

---

## Dependencies

| Package | Purpose |
|---|---|
| `express` | HTTP server and routing |
| `ws` | WebSocket server |
| `cors` | Cross-origin request handling |
