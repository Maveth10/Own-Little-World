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
    if (chunk.length > 30) {
      chunks.push(chunk);
    }
    if (end === text.length) break;
    start += (chunkSize - overlap);
  }
  return chunks;
}

// Pojedyncze pobieranie wektora z obsługą modeli zapasowych (odporne na 404)
async function getEmbeddingSingle(text, apiKey) {
  const embeddingModels = ["text-embedding-004", "embedding-001"];
  let lastError = "";

  for (const model of embeddingModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: [{ text: text.slice(0, 8000) }] }
        })
      });

      if (response.ok) {
        const data = await response.json();
        if (data.embedding?.values) {
          return data.embedding.values;
        }
      } else {
        lastError = await response.text();
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  throw new Error(`Google Embeddings Error: ${lastError}`);
}

// Równoległe pobieranie wektorów w małych paczkach
async function getBatchEmbeddingsGemini(textArray) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Brak klucza GEMINI_API_KEY w pliku .env!");
  }

  const batchSize = 10; // Przetwarzamy po 10 fragmentów równolegle
  const allEmbeddings = [];

  for (let i = 0; i < textArray.length; i += batchSize) {
    const chunkBatch = textArray.slice(i, i + batchSize);
    const promises = chunkBatch.map(text => getEmbeddingSingle(text, apiKey));
    const batchResults = await Promise.all(promises);
    allEmbeddings.push(...batchResults);
  }

  return allEmbeddings;
}

export async function POST(req) {
  try {
    const supabase = getSupabase();

    const body = await req.json();
    const { title = '', content = '', fileUrl = null, fileName = '', fileType = '' } = body;
    const userInput = content || title || '';

    if (!userInput && !fileUrl) {
      return NextResponse.json({ success: false, error: "Brak materiału do analizy." }, { status: 400 });
    }

    let textChunks = [];
    const isPdf = fileUrl && (fileType === 'application/pdf' || fileName.endsWith('.pdf'));

    if (isPdf) {
      const pdfRes = await fetch(fileUrl);
      if (!pdfRes.ok) throw new Error("Nie udało się pobrać pliku PDF z magazynu Supabase.");
      const buffer = Buffer.from(await pdfRes.arrayBuffer());

      const pdfData = await pdfParse(buffer);
      const extractedText = pdfData.text || "";

      if (!extractedText.trim()) {
        throw new Error("Plik PDF nie zawiera warstwy tekstowej.");
      }

      const rawChunks = chunkTextWithOverlap(extractedText, 600, 200);
      const docName = fileName || 'Dokumentacja';
      textChunks = rawChunks.map((chunk, index) => ({
        title: `${docName} - Część ${index + 1}`,
        content: `[DOKUMENT: ${docName}]\n${chunk}`
      }));

    } else {
      const rawChunks = chunkTextWithOverlap(userInput, 600, 200);
      const docName = title || 'Notatka';
      textChunks = rawChunks.map((chunk, index) => ({
        title: title ? `${title} (Część ${index + 1})` : `Notatka ${index + 1}`,
        content: `[NOTATKA: ${docName}]\n${chunk}`
      }));
    }

    if (textChunks.length === 0) {
      return NextResponse.json({ success: false, error: "Brak treści do zapisania." }, { status: 400 });
    }

    const prepTexts = textChunks.map(c => `${c.title}:\n${c.content}`);
    const embeddings = await getBatchEmbeddingsGemini(prepTexts);

    const records = textChunks.map((chunk, i) => ({
      title: chunk.title,
      content: chunk.content,
      embedding: embeddings[i],
      image_url: fileUrl
    }));

    const { error: dbError } = await supabase.from('ai_memory').insert(records);
    if (dbError) throw dbError;

    return NextResponse.json({
      success: true,
      message: `Przetworzono pomyślnie! Zapisano ${records.length} fragmentów w tabeli ai_memory.`
    });

  } catch (error) {
    console.error("Błąd w trakcie nauki:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}