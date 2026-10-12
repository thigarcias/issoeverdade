// Serverless Vercel: POST /api/verify (mesma lógica do dev local).
// Env vars na Vercel: OPENCODE_API (obrigatória), OPENCODE_MODEL (opcional).
import { DEFAULT_MODEL, runVerify } from "../server/verify.js";

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const input = req.body ?? {};
  const text = String(input?.text ?? "");
  const fileName = input?.fileName ? String(input.fileName) : null;
  if (!text && !fileName) {
    return res.status(400).json({ error: "empty_input" });
  }
  try {
    const out = await runVerify(
      { kind: input.kind, text, fileName },
      {
        apiKey: process.env.OPENCODE_API || "",
        model: process.env.OPENCODE_MODEL || DEFAULT_MODEL,
      },
    );
    return res.status(200).json(out);
  } catch (err) {
    return res.status(err.status ?? 502).json(err.payload ?? { error: "upstream_error" });
  }
}
