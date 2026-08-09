import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import pdfParse from 'pdf-parse';

export const maxDuration = 60; // Max dla Vercela (Hobby)

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

  if (availableModelsCache.length === 0) {
    availableModelsCache = ["gemini-embedding-2", "gemini-embedding-1", "embedding-001"];
  }

  console.log("🔫 Załadowano magazynek modeli wektorowych:", availableModelsCache);
  return availableModelsCache;
}

// ZBALANSOWANE WYSYŁANIE ZBIORCZE
async function getBatchEmbeddingsWithRotation(textArray) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Brak klucza GEMINI_API_KEY!");

  const models = await getAvailableEmbeddingModels(apiKey);
  const allEmbeddings = [];
  
  // Złoty środek: 25 fragmentów. Nie przekracza limitu TPM (ilości znaków) ani RPM (ilości zapytań)
  const batchSize = 25; 
  let currentModelIndex = 0;

  for (let i = 0; i < textArray.length; i += batchSize) {
    const chunkBatch = textArray.slice(i, i + batchSize);
    let success = false;
    let attempts = 0;
    const maxAttempts = models.length * 2; 

    while (!success && attempts < maxAttempts) {
      const model = models[currentModelIndex];
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
          console.log(`✅ Przetworzono paczkę ${i+1}-${Math.min(i+batchSize, textArray.length)} (Model: ${model})`);
        } else {
          const errText = await response.text();
          console.warn(`❌ [${model}] Błąd ${response.status}: ${errText}`);
          
          if (response.status === 429) {
            console.warn("⏳ Limit 429 na kluczu API. Chłodzenie (4 sekundy)...");
            await sleep(4000); // 429 dotyczy klucza, a nie modelu, więc musimy po prostu poczekać
          } else {
            // Jeśli to nie 429, przeskakujemy na kolejny model
            currentModelIndex = (currentModelIndex + 1) % models.length; 
          }
          attempts++;
        }
      } catch (err) {
        console.warn(`[${model}] Wyjątek: ${err.message}`);
        currentModelIndex = (currentModelIndex + 1) % models.length;
        attempts++;
      }
    }

    if (!success) {
      throw new Error(`Przerwano! Nie udało się przepalić paczki. Sprawdź logi Vercela pod kątem szczegółów błędu API.`);
    }

    // Bezpieczna pauza między paczkami by nie zadrażnić Google
    if (i + batchSize < textArray.length) {
      await sleep(2000);
    }
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
    
    // Uruchamiamy zbalansowane wyciąganie wektorów
    const embeddings = await getBatchEmbeddingsWithRotation(prepTexts);

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
      message: `Przetworzono pomyślnie! Zapisano ${records.length} fragmentów w czasie dopuszczonym przez Vercel.`
    });

  } catch (error) {
    console.error("Błąd w trakcie nauki:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}