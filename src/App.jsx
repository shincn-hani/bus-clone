import { useState } from "react";

const PROCESS_URL = "https://YOUR_LAMBDA1_URL.lambda-url.ap-northeast-1.on.aws/";
const READ_URL = "https://YOUR_LAMBDA2_URL.lambda-url.ap-northeast-1.on.aws/";

function formatStatus(lateSeconds) {
  if (lateSeconds === 0) return "Đúng giờ";
  if (lateSeconds > 0) return `Trễ ${Math.round(lateSeconds / 60)} phút`;
  return `Sớm ${Math.round(Math.abs(lateSeconds) / 60)} phút`;
}

export default function App() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const rtfToPlainText = (rtf) => {
    let s = rtf;
    // Normalize newlines commonly used in RTF
    s = s.replace(/\\par[d]?/gi, "\n").replace(/\\line/gi, "\n").replace(/\\tab/gi, "\t");

    // Decode hex escapes: \'hh
    s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });

    // Decode unicode escapes: \uN?
    s = s.replace(/\\u(-?\d+)\??/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });

    // Replace escaped literals
    s = s.replace(/\\([{}\\])/g, "$1");

    // Remove RTF control words and group braces
    s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, "");

    return s;
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError("");
    setLoading(true);

    try {
      const text = await file.text();
      // RTF contains formatting control words; strip them before JSON.parse.
      const looksLikeRtf = /^\s*\{\\rtf/i.test(text) || text.includes("\\rtf");
      const jsonCandidate = looksLikeRtf ? rtfToPlainText(text) : text;

      // Some tools may write a UTF-8 BOM or leading/trailing whitespace.
      // Normalize so JSON.parse doesn't fail on invisible characters.
      const normalizedText = jsonCandidate.replace(/^\uFEFF/, "").trim();

      const safeJsonParse = (input) => {
        // Common case: user selected a .txt/.rtf that contains JSON wrapped in code fences.
        const noCodeFences = input
          .replace(/^\s*```(?:json)?\s*/i, "")
          .replace(/\s*```\s*$/i, "");

        try {
          return JSON.parse(noCodeFences);
        } catch (e1) {
          // Heuristic: extract JSON around known keys if the file has extra RTF text.
          const s = noCodeFences;
          const anchorKeys = ['"bus_id"', '"route_id"', '"time"'];
          const anchorIdx = anchorKeys
            .map((k) => s.indexOf(k))
            .filter((i) => i !== -1)
            .sort((a, b) => a - b)[0];

          const tryParse = (chunk) => {
            try {
              return JSON.parse(chunk);
            } catch {
              return null;
            }
          };

          // First attempt: scan for a plausible JSON start before the anchor, then try ends forward.
          if (typeof anchorIdx === "number" && anchorIdx !== -1) {
            const leftBound = Math.max(0, anchorIdx - 2000);
            const rightBound = Math.min(s.length, anchorIdx + 20000);
            const startCandidates = [];
            for (let i = anchorIdx; i >= leftBound; i--) {
              const ch = s[i];
              if (ch === "{" || ch === "[") startCandidates.push(i);
              if (startCandidates.length >= 10) break; // keep it bounded
            }

            const endCandidates = [];
            for (let i = anchorIdx; i <= rightBound; i++) {
              const ch = s[i];
              if (ch === "}" || ch === "]") endCandidates.push(i);
              if (endCandidates.length >= 30) break; // keep it bounded
            }

            for (const startIdx of startCandidates) {
              for (const endIdx of endCandidates) {
                if (endIdx <= startIdx) continue;
                const extracted = s.slice(startIdx, endIdx + 1);
                const parsed = tryParse(extracted);
                if (parsed !== null) return parsed;
              }
            }
          }

          // Fallback: extract first {...} / [...] block if any.
          const startArray = s.indexOf("[");
          const startObj = s.indexOf("{");
          const startIdx =
            startArray === -1 ? startObj : startObj === -1 ? startArray : Math.min(startArray, startObj);

          const endArray = s.lastIndexOf("]");
          const endObj = s.lastIndexOf("}");
          const endIdx =
            endArray === -1 ? endObj : endObj === -1 ? endArray : Math.max(endArray, endObj);

          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            const extracted = s.slice(startIdx, endIdx + 1);
            const parsed = tryParse(extracted);
            if (parsed !== null) return parsed;
          }

          // Re-throw original parse error if we can't extract a likely JSON block.
          throw e1;
        }
      };

      const parsed = safeJsonParse(normalizedText);
      const records = Array.isArray(parsed) ? parsed : [parsed];

      const processRes = await fetch(PROCESS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records }),
      });

      const processJson = await processRes.json();
      if (!processRes.ok) throw new Error(processJson.error || "Process failed");

      const s3Key = processJson.s3_key;

      const readRes = await fetch(`${READ_URL}?s3_key=${encodeURIComponent(s3Key)}`);
      const readJson = await readRes.json();
      if (!readRes.ok) throw new Error(readJson.error || "Read failed");

      setRows(readJson);
    } catch (err) {
      const msg = err?.message || "Unexpected error";
      const start = normalizedText.slice(0, 120);
      const startCodes = [...normalizedText.slice(0, 20)]
        .map((ch) => ch.charCodeAt(0).toString(16))
        .join(" ");
      const preview = JSON.stringify(start);
      setError(`JSON.parse failed: ${msg}. Start preview: ${preview}. Start codes(hex): ${startCodes}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 800, margin: "40px auto", fontFamily: "Arial" }}>
      <h1>Bus Status Viewer</h1>

      <input type="file" accept=".rtf,.txt,application/json" onChange={handleFile} />

      {loading && <p>Đang xử lý...</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      <div style={{ marginTop: 24 }}>
        {rows.map((item, idx) => (
          <div
            key={idx}
            style={{
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 16,
              marginBottom: 12,
            }}
          >
            <div><strong>Xe:</strong> {item.bus_id}</div>
            <div><strong>Chuyến:</strong> {item.route_id}</div>
            <div><strong>Status:</strong> {formatStatus(item.late_time)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}