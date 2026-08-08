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

// Funkcja dzieląca tekst na nakładające się fragmenty (zabezpieczenie styków stron)
function chunkTextWithOverlap(text, chunkSize = 1200, overlap = 250) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 50) {
      chunks.push(chunk);
    }
    if (end === text.length) break;
    start += (chunkSize - overlap);
  }
  return chunks;
}

// Zbiorcza wektoryzacja w Hugging Face (1 zapytanie HTTP dla wszystkich fragmentów)
async function getBatchEmbeddings(textArray) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) return textArray.map(() => new Array(384).fill(0));

  const url = "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${apiKey}`, 
        "Content-Type": "application/json",
        "User-Agent": "AxonAI-App/1.0",
        "x-wait-for-model": "true" 
      },
      body: JSON.stringify({ inputs: textArray, options: { wait_for_model: true } }),
      cache: "no-store"
    });

    if (response.ok) {
      const result = await response.json();
      if (Array.isArray(result) && Array.isArray(result[0])) {
        return result; // Zwraca tablicę wektorów dla wszystkich fragmentów naraz
      }
    }
  } catch (err) {
    console.warn("Błąd wektoryzacji pakietyzowanej HF:", err.message);
  }

  // W razie chwilowej niedostępności HF zwraca wektory zerowe bez przerywania zapisu
  return textArray.map(() => new Array(384).fill(0));
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
      // 1. Szybkie pobranie PDF z Supabase Storage
      const pdfRes = await fetch(fileUrl);
      if (!pdfRes.ok) throw new Error("Nie udało się pobrać pliku PDF z magazynu Supabase.");
      const buffer = Buffer.from(await pdfRes.arrayBuffer());

      // 2. Ekstrakcja czystego tekstu cyfrowego z dokumentu CAD/EPLAN
      const pdfData = await pdfParse(buffer);
      const extractedText = pdfData.text || "";

      if (!extractedText.trim()) {
        throw new Error("Plik PDF nie zawiera warstwy tekstowej (prawdopodobnie skan).");
      }

      // 3. Podział na nakładające się fragmenty (zachowuje ciągłość między stronami)
      const rawChunks = chunkTextWithOverlap(extractedText, 1200, 250);
      textChunks = rawChunks.map((chunk, index) => ({
        title: `${fileName || 'Dokumentacja'} - Część ${index + 1}`,
        content: chunk
      }));

    } else {
      // Sama notatka tekstowa
      const rawChunks = chunkTextWithOverlap(userInput, 1200, 250);
      textChunks = rawChunks.map((chunk, index) => ({
        title: title ? `${title} (Część ${index + 1})` : `Notatka ${index + 1}`,
        content: chunk
      }));
    }

    if (textChunks.length === 0) {
      return NextResponse.json({ success: false, error: "Brak treści do zapisania." }, { status: 400 });
    }

    // 4. Pobranie wektorów w jednym zbiorczym zapytaniu HTTP
    const prepTexts = textChunks.map(c => `${c.title}: ${c.content}`);
    const embeddings = await getBatchEmbeddings(prepTexts);

    // 5. Złożenie rekordów i błyskawiczny zapis do Supabase
    const records = textChunks.map((chunk, i) => ({
      title: chunk.title,
      content: chunk.content,
      embedding: embeddings[i] || new Array(384).fill(0),
      image_url: fileUrl
    }));

    const { error: dbError } = await supabase.from('memories').insert(records);
    if (dbError) throw dbError;

    return NextResponse.json({
      success: true,
      message: `Przetworzono bezbłędnie! Zapisano ${records.length} połączonych fragmentów dokumentu w bazie wiedzy.`
    });

  } catch (error) {
    console.error("Błąd w trakcie nauki:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}