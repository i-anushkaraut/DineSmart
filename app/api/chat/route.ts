// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST; // e.g. "dine-smart-xxx.svc.aped-4627-b74a.pinecone.io"
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || "dine-smart";

if (!OPENAI_KEY || !PINECONE_API_KEY || !PINECONE_INDEX_HOST) {
  console.warn("Missing OPENAI_KEY or PINECONE_* env vars.");
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// Use global fetch (Next.js provides this in server runtime)
async function pineconeQuery(vector: number[], topK = 5) {
  const url = `https://${PINECONE_INDEX_HOST}/query`;
  const body = { vector, topK, includeValues: false, includeMetadata: true };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": PINECONE_API_KEY
    },
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
    const meta = m.metadata || {};
    const text = meta.text || meta.chunk_text || "";
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

    // 1) embed query
    const embResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: [userQuery],
    });
    const qVec = embResp.data[0].embedding as number[];

    // 2) query Pinecone
    const matches = await pineconeQuery(qVec, 6);

    // 3) construct context strictly from Pinecone metadata.text
    const context = buildContextFromMatches(matches);
    if (!context) {
      return NextResponse.json({
        answer: "I don't know — I couldn't find matching information in the menu.",
        sources: [],
      });
    }

    // 4) system prompt — force usage of context only
    const systemPrompt = `
You are DineSmart — a precise restaurant menu assistant.
Use ONLY the provided context below to answer user questions about dishes, ingredients, dietary info, prices, pairings, allergens and prep times.
If the answer is not present in the context, explicitly respond: "I don't know — the menu does not say."
Always cite the source id(s) you used from the context in the answer.
Keep the answer concise and helpful.
`.trim();

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "system", content: "Context:\n\n" + context },
      { role: "user", content: userQuery },
    ];

    // 5) call OpenAI Chat
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
