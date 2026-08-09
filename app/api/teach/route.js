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

// Precyzyjne cięcie tekstu
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

// Narzędzie do pauzowania
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// POTĘŻNE WYSYŁANIE ZBIORCZE (Paczki po 50 elementów = kosztuje tylko 1 zapytanie API)
async function getBatchEmbeddingsGemini(textArray) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Brak klucza GEMINI_API_KEY w pliku .env!");

  const modelName = "text-embedding-004"; // Sztywno najlepszy model!
  const batchSize = 50; 
  const allEmbeddings = [];

  for (let i = 0; i < textArray.length; i += batchSize) {
    const chunkBatch = textArray.slice(i, i + batchSize);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:batchEmbedContents?key=${apiKey}`;

    const requests = chunkBatch.map(text => ({
      model: `models/${modelName}`,
      content: { parts: [{ text: text.slice(0, 8000) }] }
    }));

    let retries = 3;
    let success = false;

    while (retries > 0 && !success) {
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
          const errText = await response.text();
          
          // Jeśli to błąd limitu (429), zatrzymujemy skrypt na 10 sekund i próbujemy ponownie!
          if (response.status === 429) {
            console.warn(`⏳ Limit 429 od Google. Pauzuję na 10 sekund... (Pozostało prób: ${retries - 1})`);
            await sleep(10000); 
            retries--;
          } else {
            throw new Error(`Google API Error (${response.status}): ${errText}`);
          }
        }
      } catch (err) {
        if (!err.message.includes("429")) throw err; // Wyrzucamy błędy inne niż limit
      }
    }
    
    if (!success) {
      throw new Error(`Nie udało się pobrać wektorów po 3 próbach. Prawdopodobnie wyczerpano stały limit Google API.`);
    }

    // Standardowa krótka przerwa między paczkami dla bezpieczeństwa
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

    if (embeddings.length !== textChunks.length) {
      throw new Error(`Błąd: Liczba wygenerowanych wektorów (${embeddings.length}) nie zgadza się z liczbą fragmentów (${textChunks.length}).`);
    }

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
      message: `Przetworzono pomyślnie! Zapisano ${records.length} fragmentów do bazy.`
    });

  } catch (error) {
    console.error("Błąd w trakcie nauki:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}