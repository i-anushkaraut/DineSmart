// app/api/chat/route.ts  — Use only the menu_dataset.txt in repo (no web, no Pinecone)
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) console.warn("Missing OPENAI_API_KEY");

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// Naive chunker (keeps sentences)
function simpleChunk(text: string, maxChars = 900) {
  const parts = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + " " + p).length <= maxChars) cur = (cur + " " + p).trim();
    else {
      if (cur) chunks.push(cur);
      cur = p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userQuery = (body?.query || "").toString().trim();
    if (!userQuery) return NextResponse.json({ error: "Missing query" }, { status: 400 });

    // 1) Read the menu file from the deployed repo
    const filePath = path.join(process.cwd(), "menu_dataset.txt"); // or "data/menu_dataset.txt"
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "menu_dataset.txt not found on server." }, { status: 500 });
    }
    const raw = fs.readFileSync(filePath, "utf8");

    // 2) parse JSON (if JSON) or treat as plain text
    let menuJson;
    try { menuJson = JSON.parse(raw); } catch (e) { menuJson = { menu: [{ doc_text: raw }] }; }

    // 3) build doc_texts and chunk them
    const docs = menuJson.menu.map((r: any) => r.doc_text || Object.values(r).join(" "));
    const chunks = docs.flatMap((d: string, idx: number) => simpleChunk(d).map((c, i) => ({ id: `${idx}-${i}`, text: c })));

    // 4) embed query and chunks (embedding chunks on-the-fly — ok for small dataset)
    const embedResp = await openai.embeddings.create({ model: "text-embedding-3-small", input: [userQuery] });
    const qv = embedResp.data[0].embedding;

    // embed chunks in batches
    const chunkTexts = chunks.map(c => c.text);
    const chunkEmbResp = await openai.embeddings.create({ model: "text-embedding-3-small", input: chunkTexts });
    const chunkEmbs = chunkEmbResp.data.map((d: any) => d.embedding);

    // 5) cosine similarities
    function cos(a: number[], b: number[]) {
      let na = 0, nb = 0, dot = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
      return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-12);
    }
    const sims = chunkEmbs.map((ce: number[], i: number) => ({ i, score: cos(qv, ce) }));
    sims.sort((a,b) => b.score - a.score);
    const top = sims.slice(0, 6).map(s => chunks[s.i]);

    // 6) build strict context and call chat completion
    const context = top.map(t => `Source ${t.id}:\n${t.text}`).join("\n\n---\n\n");
    if (!context) return NextResponse.json({ answer: "I don't know — menu not found.", sources: [] });

    const systemPrompt = `
You are DineSmart. Use ONLY the provided context (menu) to answer. If not present, say "I don't know — the menu does not say."
Always cite the source id(s) used.
`.trim();

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "system", content: "Context:\n\n" + context },
      { role: "user", content: userQuery },
    ];

    const chat = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages,
      temperature: 0.0,
      max_tokens: 400
    });

    const answer = chat.choices?.[0]?.message?.content?.trim() ?? "I don't know.";
    return NextResponse.json({ answer, sources: top.map(t => t.id) });

  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
