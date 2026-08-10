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

// Ucięcie co 250 znaków (zakładka 100) - ultra precyzyjne!
function chunkTextWithOverlap(text, chunkSize = 250, overlap = 100) {
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

async function getAvailableEmbeddingModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (res.ok) {
      const data = await res.json();
      const models = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes("embedContent"))
        .map(m => m.name.replace("models/", ""));
      if (models.length > 0) return models;
    }
  } catch (e) {}
  return ["gemini-embedding-2", "embedding-001"];
}

export async function POST(req) {
  try {
    const supabase = getSupabase();
    const body = await req.json();

    // =======================================================
    // AKCJA 1: PARSOWANIE (Tylko czytanie i cięcie PDF)
    // =======================================================
    if (body.action === 'parse') {
      const { fileUrl, fileName, title, content, fileType } = body;
      const isPdf = fileUrl && (fileType === 'application/pdf' || fileName.endsWith('.pdf'));
      let textChunks = [];

      if (isPdf) {
        const pdfRes = await fetch(fileUrl);
        const arrayBuffer = await pdfRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const pdfData = await pdfParse(buffer);
        const extractedText = pdfData.text || "";

        if (!extractedText.trim()) throw new Error("Plik PDF nie zawiera tekstu.");

        const rawChunks = chunkTextWithOverlap(extractedText, 250, 100);
        const docName = fileName || 'Dokumentacja';
        textChunks = rawChunks.map((chunk, index) => ({
          title: `${docName} - Część ${index + 1}`,
          content: `[DOKUMENT: ${docName}]\n${chunk}`,
          image_url: fileUrl
        }));
      } else {
        const userInput = content || title || '';
        const rawChunks = chunkTextWithOverlap(userInput, 250, 100);
        const docName = title || 'Notatka';
        textChunks = rawChunks.map((chunk, index) => ({
          title: title ? `${title} (Część ${index + 1})` : `Notatka ${index + 1}`,
          content: `[NOTATKA: ${docName}]\n${chunk}`,
          image_url: fileUrl
        }));
      }
      return NextResponse.json({ success: true, chunks: textChunks });
    }

    // =======================================================
    // AKCJA 2: WEKTORYZACJA I ZAPIS (Tylko czysta matematyka)
    // =======================================================
    if (body.action === 'embed') {
      const { chunks } = body;
      if (!chunks || chunks.length === 0) return NextResponse.json({ success: false, error: "Brak chunków." }, { status: 400 });

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("Brak klucza GEMINI_API_KEY!");

      const models = await getAvailableEmbeddingModels(apiKey);
      const model = models[0] || "embedding-001"; // Zawsze bierzemy najlepszy dostępny

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;
      const requests = chunks.map(c => ({
        model: `models/${model}`,
        content: { parts: [{ text: c.content.slice(0, 8000) }] }
      }));

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests })
      });

      if (!response.ok) {
        if (response.status === 429) {
          // NATYCHMIASTOWY ZWROT BŁĘDU LIMITU DO PRZEGLĄDARKI
          return NextResponse.json({ success: false, error: "RATE_LIMIT" }, { status: 429 });
        }
        const errText = await response.text();
        throw new Error(`Google API Error: ${errText}`);
      }

      const data = await response.json();
      
      // KLUCZOWA POPRAWKA: Tniemy wektor (np. z 3072) w locie, by miał równe 768 wymiarów!
      const embeddings = data.embeddings?.map(e => e.values.slice(0, 768)) || [];

      if (embeddings.length !== chunks.length) throw new Error("Wektory nie zgadzają się z ilością tekstu.");

      const records = chunks.map((chunk, i) => ({
        title: chunk.title,
        content: chunk.content,
        embedding: embeddings[i],
        image_url: chunk.image_url
      }));

      // ZAPIS W BAZIE!
      const { error: dbError } = await supabase.from('ai_memory').insert(records);
      if (dbError) throw dbError;

      return NextResponse.json({ success: true, count: records.length });
    }

    return NextResponse.json({ success: false, error: "Nieznana akcja." }, { status: 400 });

  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}