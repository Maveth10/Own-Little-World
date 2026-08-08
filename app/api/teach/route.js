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

// Precyzyjne cięcie tekstu z dużą zakładką (idealne dla schematów i tabel)
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

// ZBIORCZE POBIERANIE WEKTORÓW GOOGLE GEMINI (text-embedding-004, 768 WYMIARÓW)
async function getBatchEmbeddingsGemini(textArray) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Brak klucza GEMINI_API_KEY do wygenerowania wektorów!");
  }

  const batchSize = 30; // Bezpieczny rozmiar paczki dla API Google
  const allEmbeddings = [];

  for (let i = 0; i < textArray.length; i += batchSize) {
    const chunkArray = textArray.slice(i, i + batchSize);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${apiKey}`;

    const requests = chunkArray.map(t => ({
      model: "models/text-embedding-004",
      content: { parts: [{ text: t.slice(0, 8000) }] }
    }));

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Błąd Google Gemini Embeddings (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const embeddings = data.embeddings?.map(e => e.values) || [];
    
    if (embeddings.length === 0) {
      throw new Error("Google Gemini odrzuciło generowanie wektorów.");
    }

    allEmbeddings.push(...embeddings);
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

      // Zagęszczony chunking (600 znaków z 200 zakładki)
      const rawChunks = chunkTextWithOverlap(extractedText, 600, 200);
      
      const docName = fileName || 'Dokumentacja';
      textChunks = rawChunks.map((chunk, index) => ({
        title: `${docName} - Część ${index + 1}`,
        // Kluczowe: doklejamy nazwę pliku bezpośrednio do Treści, aby wektor wiedział, jakiego pliku dotyczy każdy akapit!
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

    // Przygotowanie połączonych tekstów do wygenerowania wektorów
    const prepTexts = textChunks.map(c => `${c.title}:\n${c.content}`);
    
    // Generowanie wektorów przez Google Gemini (768 wymiarów)
    const embeddings = await getBatchEmbeddingsGemini(prepTexts);

    // Przygotowanie rekordów do tabeli ai_memory
    const records = textChunks.map((chunk, i) => ({
      title: chunk.title,
      content: chunk.content,
      embedding: embeddings[i],
      image_url: fileUrl
    }));

    // ZAPIS DO TABELI ai_memory
    const { error: dbError } = await supabase.from('ai_memory').insert(records);
    if (dbError) throw dbError;

    return NextResponse.json({
      success: true,
      message: `Przetworzono pomyślnie na silniku Google Gemini! Zapisano ${records.length} precyzyjnych fragmentów w ai_memory.`
    });

  } catch (error) {
    console.error("Błąd w trakcie nauki:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}