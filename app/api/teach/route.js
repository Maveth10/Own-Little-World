import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import pdfParse from 'pdf-parse';

export const maxDuration = 60; 

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Brak kluczy Supabase w pliku .env");
  return createClient(url, key);
}

function chunkTextWithOverlap(text, chunkSize = 600, overlap = 200) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 30) chunks.push(chunk);
    if (end === text.length) break;
    start += (chunkSize - overlap);
  }
  return chunks;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let availableModelsCache = [];

async function getAvailableEmbeddingModels(apiKey) {
  if (availableModelsCache.length > 0) return availableModelsCache;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (res.ok) {
      const data = await res.json();
      availableModelsCache = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes("embedContent"))
        .map(m => m.name.replace("models/", ""));
    }
  } catch (e) {}
  if (availableModelsCache.length === 0) availableModelsCache = ["gemini-embedding-2", "embedding-001"];
  return availableModelsCache;
}

async function getBatchEmbeddingsWithRotation(textArray) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Brak klucza GEMINI_API_KEY!");

  const models = await getAvailableEmbeddingModels(apiKey);
  const allEmbeddings = [];
  const batchSize = 100; // PAKUJEMY MAX. ILOŚĆ, żeby oszczędzać zapytania (RPM)

  for (let i = 0; i < textArray.length; i += batchSize) {
    const chunkBatch = textArray.slice(i, i + batchSize);
    let success = false;
    let attempts = 0;
    
    while (!success && attempts < models.length) {
      const model = models[attempts % models.length];
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;

      const requests = chunkBatch.map(text => ({
        model: `models/${model}`,
        content: { parts: [{ text: text.slice(0, 8000) }] }
      }));

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requests })
        });

        if (response.ok) {
          const data = await response.json();
          const embeddings = data.embeddings?.map(e => e.values) || [];
          allEmbeddings.push(...embeddings);
          success = true;
        } else {
          if (response.status === 429) {
            // Natychmiastowe przerwanie i poinformowanie frontendu, żeby poczekał!
            throw new Error("RATE_LIMIT_429");
          }
          attempts++;
        }
      } catch (err) {
        if (err.message === "RATE_LIMIT_429") throw err; // Przekazujemy wyżej
        attempts++;
      }
    }
    if (!success) throw new Error("Błąd API Google.");
    if (i + batchSize < textArray.length) await sleep(1000);
  }
  return allEmbeddings;
}

export async function POST(req) {
  try {
    const supabase = getSupabase();
    const body = await req.json();
    const { title = '', content = '', fileUrl = null, fileName = '', fileType = '' } = body;
    const userInput = content || title || '';

    if (!userInput && !fileUrl) return NextResponse.json({ success: false, error: "Brak materiału." }, { status: 400 });

    let textChunks = [];
    if (fileUrl && (fileType === 'application/pdf' || fileName.endsWith('.pdf'))) {
      const pdfRes = await fetch(fileUrl);
      const buffer = Buffer.from(await pdfRes.arrayBuffer());
      const pdfData = await pdfParse(buffer);
      const extractedText = pdfData.text || "";
      if (!extractedText.trim()) throw new Error("Plik PDF bez tekstu.");

      const rawChunks = chunkTextWithOverlap(extractedText, 600, 200);
      textChunks = rawChunks.map((chunk, index) => ({
        title: `${fileName || 'Dokumentacja'} - Część ${index + 1}`,
        content: `[DOKUMENT: ${fileName}]\n${chunk}`
      }));
    } else {
      const rawChunks = chunkTextWithOverlap(userInput, 600, 200);
      textChunks = rawChunks.map((chunk, index) => ({
        title: title ? `${title} (Część ${index + 1})` : `Notatka ${index + 1}`,
        content: `[NOTATKA: ${title}]\n${chunk}`
      }));
    }

    const prepTexts = textChunks.map(c => `${c.title}:\n${c.content}`);
    const embeddings = await getBatchEmbeddingsWithRotation(prepTexts);

    const records = textChunks.map((chunk, i) => ({
      title: chunk.title,
      content: chunk.content,
      embedding: embeddings[i],
      image_url: fileUrl
    }));

    const { error: dbError } = await supabase.from('ai_memory').insert(records);
    if (dbError) throw dbError;

    return NextResponse.json({ success: true, message: `Zapisano ${records.length} fragmentów.` });

  } catch (error) {
    // Specjalny komunikat o limicie
    if (error.message === "RATE_LIMIT_429") {
      return NextResponse.json({ success: false, error: "RATE_LIMIT" }, { status: 429 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}