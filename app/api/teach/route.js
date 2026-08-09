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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GLOBALNY MAGAZYNEK MODELI WEKTOROWYCH
let availableModelsCache = [];

async function getAvailableEmbeddingModels(apiKey) {
  if (availableModelsCache.length > 0) return availableModelsCache;

  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await fetch(listUrl);
    if (res.ok) {
      const data = await res.json();
      availableModelsCache = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes("embedContent"))
        .map(m => m.name.replace("models/", ""));
    }
  } catch (e) {
    console.warn("Błąd pobierania modeli wektorowych.");
  }

  // W razie awarii autodetekcji ładujemy żelazny zapas
  if (availableModelsCache.length === 0) {
    availableModelsCache = ["text-embedding-004", "embedding-001"];
  }

  console.log("🔫 Załadowano magazynek modeli wektorowych:", availableModelsCache);
  return availableModelsCache;
}

// ROTACYJNE POBIERANIE WEKTORÓW (ROUND-ROBIN)
async function getEmbeddingsWithRotation(textArray) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Brak klucza GEMINI_API_KEY!");

  const models = await getAvailableEmbeddingModels(apiKey);
  const allEmbeddings = [];
  let currentModelIndex = 0; // Wskaźnik rotacji

  for (let i = 0; i < textArray.length; i++) {
    let success = false;
    let attempts = 0;
    const maxAttempts = models.length * 2; // Każdemu modelowi dajemy max 2 szanse na akapit

    while (!success && attempts < maxAttempts) {
      const model = models[currentModelIndex];
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: `models/${model}`,
            content: { parts: [{ text: textArray[i].slice(0, 8000) }] }
          })
        });

        if (response.ok) {
          const data = await response.json();
          allEmbeddings.push(data.embedding.values);
          success = true;
        } else {
          // BŁĄD MODELU (np. 429 lub 404) -> PŁYNNA ZMIANA NA KOLEJNY
          console.warn(`[${model}] zablokowany. Przełączam na kolejny...`);
          currentModelIndex = (currentModelIndex + 1) % models.length; // Karuzela modeli
          attempts++;

          // Jeśli przewinęliśmy całą karuzelę i nadal błąd -> robimy chwilę przerwy (chłodzenie lufy)
          if (attempts % models.length === 0) {
            console.warn("⏳ Wszystkie modele chwilowo zmęczone. Chłodzenie (5 sekund)...");
            await sleep(5000);
          }
        }
      } catch (err) {
        console.warn(`Wyjątek na modelu ${model}: ${err.message}`);
        currentModelIndex = (currentModelIndex + 1) % models.length;
        attempts++;
      }
    }

    if (!success) {
      throw new Error(`Wystrzelano magazynek modeli. Zbyt duże obciążenie Google API.`);
    }

    // Bezpieczny odstęp dla API przed kolejnym akapitem
    await sleep(350);
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
      
      const arrayBuffer = await pdfRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const pdfData = await pdfParse(buffer);
      const extractedText = pdfData.text || "";

      if (!extractedText.trim()) throw new Error("Plik PDF nie zawiera warstwy tekstowej.");

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

    if (textChunks.length === 0) return NextResponse.json({ success: false, error: "Brak treści." }, { status: 400 });

    const prepTexts = textChunks.map(c => `${c.title}:\n${c.content}`);
    // Odpalamy naszą maszynkę z rotacją
    const embeddings = await getEmbeddingsWithRotation(prepTexts);

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
      message: `Przetworzono pomyślnie! Zapisano ${records.length} fragmentów przy użyciu rotacji modeli.`
    });

  } catch (error) {
    console.error("Błąd w trakcie nauki:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}