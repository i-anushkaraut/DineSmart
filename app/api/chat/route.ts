// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

// env vars
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST;
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME;

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// Use global `fetch` (do NOT import node-fetch)
async function pineconeQuery(vector: number[], topK = 5) {
  const url = `https://${PINECONE_INDEX_HOST}/query`;
  const body = { vector, topK, includeValues: false, includeMetadata: true };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": PINECONE_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Pinecone query failed: ${res.status} - ${txt}`);
  }
  const j = await res.json();
  return j.matches || [];
}

function buildContextFromMatches(matches: any[], maxChars = 3000) {
  let out = "";
  for (const m of matches) {
    const text = (m.metadata && (m.metadata.text || m.metadata.chunk_text)) || "";
    if (!text) continue;
    const entry = `Source ${m.id} (score=${Number(m.score).toFixed(4)}):\n${text}\n---\n`;
    if (out.length + entry.length > maxChars) break;
    out += entry;
  }
  return out.trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userQuery = (body?.query || "").toString().trim();
    if (!userQuery) return NextResponse.json({ error: "Missing query" }, { status: 400 });

    const embResp = await openai.embeddings.create({ model: "text-embedding-3-small", input: [userQuery] });
    const qVec = embResp.data[0].embedding as number[];

    const matches = await pineconeQuery(qVec, 6);
    const context = buildContextFromMatches(matches);
    if (!context) {
      return NextResponse.json({ answer: "I don't know — I couldn't find matching information in the menu.", sources: [] });
    }

    const systemPrompt = `
You are DineSmart — a precise restaurant menu assistant.
Use ONLY the provided context below to answer user questions.
If the answer is not present in the context, respond: "I don't know — the menu does not say."
Always cite the source id(s) you used.
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
      max_tokens: 400,
    });

    const answer = chat.choices?.[0]?.message?.content?.trim() ?? "I don't know.";
    const sourceIds = (matches || []).map((m) => m.id);
    return NextResponse.json({ answer, sources: sourceIds });
  } catch (err: any) {
    console.error("chat error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
